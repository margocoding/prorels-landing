// Runs entirely on loopback with a private SMTP sink. Never sends external mail.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { getPublishedArticles } from '../src/content/articles.ts';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

const messages = [];
let rejectMail = false;
const smtpPort = await freePort();
const smtp = new SMTPServer({
  disabledCommands: ['AUTH', 'STARTTLS'],
  onRcptTo(address, session, done) {
    if (rejectMail) { const error = new Error('Test rejection'); error.responseCode = 550; done(error); }
    else done();
  },
  onData(stream, session, done) {
    simpleParser(stream).then(mail => { messages.push({ mail, envelope: session.envelope }); done(); }, done);
  },
});
await new Promise(resolve => smtp.listen(smtpPort, '127.0.0.1', resolve));
let server;
let log = '';
async function start(extra = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], {
    cwd: resolve('.next/standalone'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOSTNAME: '127.0.0.1', SITE_URL: '', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_FROM: 'local-test@example.org', SMTP_USER: '', SMTP_PASS: '', SMTP_LOCAL_TEST: 'true', CONTACT_TRUST_PROXY: 'false', ...extra },
  });
  server.stdout.on('data', chunk => { log += chunk; });
  server.stderr.on('data', chunk => { log += chunk; });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${log}`);
    try { if ((await fetch(`${base}/api/contact`)).status === 405) return base; } catch {}
    await pause(250);
  }
  throw new Error('Contact test server did not start');
}
async function stop() {
  if (server && server.exitCode === null) { const exited = once(server, 'close'); server.kill(); await exited; }
}
try {
  const base = await start();
  const good = { email: 'buyer@example.org', phone: '+7 (900) 000-00-00', comment: 'Нужны Р65. <img src=x onerror=alert(1)> & крепёж', consent: true, website: '', sourcePath: '/', utm: { utm_source: 'local-qa' } };
  const post = (data, headers = {}) => fetch(`${base}/api/contact`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  let result = await post(good);
  assert.equal(result.status, 200);
  assert.match((await result.json()).id, /^[A-F0-9]{8}$/);
  assert.equal(messages.length, 1);
  const { mail, envelope } = messages[0];
  assert.deepEqual(envelope.rcptTo.map(item => item.address), ['zakaz@prorelsa.ru']);
  assert.equal(mail.replyTo.value[0].address, good.email);
  assert.equal(mail.from.value[0].address, 'local-test@example.org');
  assert.ok(mail.text.includes(`${base}/`) && mail.text.includes('Главная') && mail.text.includes('local-qa'));
  assert.ok(mail.html.includes('&lt;img') && !mail.html.includes('<img'));
  assert.equal(mail.headers.get('x-prorels-source'), 'landing');
  const article = getPublishedArticles()[0];
  assert.equal((await post({ ...good, sourcePath: `/blog/${article.slug}` })).status, 200);
  assert.ok(messages[1].mail.text.includes(article.title) && messages[1].mail.text.includes(`/blog/${article.slug}`));
  assert.equal((await post({ ...good, email: 'bad' })).status, 400);
  assert.equal((await post({ ...good, consent: false })).status, 400);
  assert.equal((await post({ ...good, website: 'bot.example' })).status, 400);
  assert.equal((await post({ ...good, sourcePath: '//evil.example/path' })).status, 400);
  assert.equal((await post({ ...good, sourcePath: '/blog/not-published' })).status, 400);
  assert.equal((await post(good, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(good, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post({ ...good, comment: 'a'.repeat(25000) })).status, 413);
  const invalid = await fetch(`${base}/api/contact`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalid.status, 400);
  assert.equal(messages.length, 2, 'invalid input must never send mail');
  rejectMail = true;
  assert.equal((await post(good)).status, 503, 'SMTP rejection is not reported as success');
  rejectMail = false;
  for (let i = 0; i < 2; i++) assert.equal((await post(good)).status, 200);
  result = await post(good);
  assert.equal(result.status, 429);
  assert.ok(Number(result.headers.get('retry-after')) > 0);
  assert.equal(messages.length, 4);
  await stop();
  const unconfigured = await start({ SMTP_HOST: '', SMTP_FROM: '' });
  const unavailable = await fetch(`${unconfigured}/api/contact`, { method: 'POST', headers: { Origin: unconfigured, 'Content-Type': 'application/json' }, body: JSON.stringify(good) });
  assert.equal(unavailable.status, 503);
  assert.ok((await unavailable.json()).message.includes('zakaz@prorelsa.ru'));
  assert.equal(messages.length, 4);
  assert.ok(!log.includes(good.email) && !log.includes(good.comment), 'no personal data in application logs');
  await stop();
  const proxied = await start({ SITE_URL: 'https://prorels.com' });
  const publicPost = (origin, extra = {}) => fetch(`${proxied}/api/contact`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...extra },
    body: JSON.stringify(good),
  });
  for (const origin of ['https://prorels.com', 'https://www.prorels.com']) {
    assert.equal((await publicPost(origin)).status, 200, `form must work behind a proxy on ${origin}`);
    assert.ok(messages.at(-1).mail.text.includes(`Адрес: ${origin}/`), 'email must identify the actual source URL');
  }
  const delivered = messages.length;
  assert.equal((await publicPost('https://evil.example')).status, 403);
  assert.equal((await publicPost('https://prorels.com', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(messages.length, delivered, 'rejected origins must not send mail');
  console.log('Contact verified: local SMTP delivery, fixed recipient, Reply-To, HTML/text, source/UTM, validation, main/www domains behind a proxy, limits, SMTP rejection and missing configuration. No external email sent.');
} finally {
  await stop();
  await new Promise(resolve => smtp.close(resolve));
}
