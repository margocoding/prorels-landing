import { randomUUID } from "node:crypto";
import { getArticle } from "@/content/articles";
import { leadLimits, validateLead } from "@/lib/lead-contract";
import {
  MailConfigurationError,
  sendLead,
  smtpSettings,
} from "@/lib/lead-mailer";
import { rateLimitKey, takeLeadSlot } from "@/lib/lead-rate-limit";
import { contactOrigin } from "@/lib/lead-origin";

export const runtime = "nodejs";

const json = (body: object, status: number, headers?: Record<string, string>) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });

async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Empty body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > leadLimits.body) {
        await reader.cancel();
        throw new RangeError("Body too large");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    reader.releaseLock();
  }
}

export async function POST(request: Request) {
  const sourceOrigin = contactOrigin(request, process.env.SITE_URL);
  if (!sourceOrigin)
    return json(
      { message: "Обновите страницу и отправьте форму ещё раз." },
      403,
    );
  if (
    request.headers.get("content-type")?.split(";")[0].trim() !==
    "application/json"
  )
    return json({ message: "Неверный формат запроса." }, 415);
  if (Number(request.headers.get("content-length")) > leadLimits.body)
    return json({ message: "Заявка слишком большая." }, 413);
  let raw: unknown;
  try {
    raw = await readBody(request);
  } catch (error) {
    return json(
      {
        message:
          error instanceof RangeError
            ? "Заявка слишком большая."
            : "Проверьте данные формы.",
      },
      error instanceof RangeError ? 413 : 400,
    );
  }
  const { data, errors, spam } = validateLead(raw);
  if (spam)
    return json(
      { message: "Не удалось отправить форму. Напишите нам на почту." },
      400,
    );
  if (!data)
    return json({ message: "Проверьте отмеченные поля.", errors }, 400);
  const article = data.sourcePath.startsWith("/blog/")
    ? getArticle(data.sourcePath.slice(6))
    : undefined;
  if (data.sourcePath !== "/" && !article)
    return json({ message: "Откройте форму со страницы сайта." }, 400);
  try {
    smtpSettings(process.env);
  } catch {
    return json(
      {
        message:
          "Отправка через форму пока недоступна. Напишите на zakaz@prorelsa.ru или позвоните нам.",
      },
      503,
    );
  }
  const retryAfter = takeLeadSlot(
    rateLimitKey(
      request.headers,
      data.email,
      process.env.CONTACT_TRUST_PROXY === "true",
    ),
  );
  if (retryAfter)
    return json(
      {
        message:
          "Слишком много заявок. Попробуйте позже или свяжитесь с нами по телефону.",
      },
      429,
      { "Retry-After": String(retryAfter) },
    );
  const id = randomUUID().slice(0, 8).toUpperCase();
  try {
    await sendLead(
      data,
      {
        title: article?.title ?? "Главная — поставка материалов ВСП",
        path: data.sourcePath,
        url: new URL(data.sourcePath, sourceOrigin).href,
      },
      id,
    );
    return json(
      { message: "Заявка отправлена. Свяжемся с вами в рабочее время.", id },
      200,
    );
  } catch (error) {
    // Log neither contacts nor message bodies nor SMTP credentials.
    console.error("Contact delivery failed", {
      id,
      reason:
        error instanceof MailConfigurationError ? "configuration" : "smtp",
    });
    return json(
      {
        message:
          "Не удалось отправить заявку. Данные сохранены в форме — попробуйте ещё раз или напишите на zakaz@prorelsa.ru.",
      },
      503,
    );
  }
}
