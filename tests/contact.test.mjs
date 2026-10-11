import assert from 'node:assert/strict';
import test from 'node:test';
import { validateLead } from '../src/lib/lead-contract.ts';
import { renderLeadEmail } from '../src/lib/lead-email.ts';
import { smtpSettings } from '../src/lib/lead-mailer.ts';
import { takeLeadSlot, rateLimitKey } from '../src/lib/lead-rate-limit.ts';
import { contactOrigin } from '../src/lib/lead-origin.ts';

const input = { email: 'buyer@example.org', phone: '+7 (900) 000-00-00', comment: 'Нужны рельсы Р65 с доставкой.', consent: true, sourcePath: '/', website: '' };

test('origin validation handles Next loopback normalization and rejects cross-origin submissions', () => {
  const req = origin => new Request('http://localhost:4193/api/contact', { headers: { host: '127.0.0.1:4193', origin } });
  assert.equal(contactOrigin(req('http://127.0.0.1:4193')), 'http://127.0.0.1:4193');
  for (const value of ['https://evil.example', 'null', 'http://127.0.0.1:4193/path', 'http://user@127.0.0.1:4193', 'https://127.0.0.1:4193']) assert.equal(contactOrigin(req(value)), null);
  assert.equal(contactOrigin(req('https://landing.example.org'), 'https://landing.example.org/'), 'https://landing.example.org');
  assert.equal(contactOrigin(req('http://127.0.0.1:4193'), 'https://landing.example.org'), null);
});

test('public origin accepts the configured domain and www behind a reverse proxy only', () => {
  const req = (origin, site = 'same-origin') => new Request('http://127.0.0.1:5000/api/contact', {
    headers: { host: 'www.prorels.com', origin, 'sec-fetch-site': site },
  });
  for (const configured of ['https://prorels.com', 'https://www.prorels.com/']) {
    for (const origin of ['https://prorels.com', 'https://www.prorels.com']) {
      assert.equal(contactOrigin(req(origin), configured), origin);
    }
    for (const origin of ['https://evil.example', 'https://prorels.com.evil.example', 'https://shop.prorels.com', 'https://www.www.prorels.com', 'http://prorels.com', 'https://prorels.com:8443', 'https://prorels.com/path', 'null']) {
      assert.equal(contactOrigin(req(origin), configured), null);
    }
    assert.equal(contactOrigin(req('https://prorels.com', 'cross-site'), configured), null);
  }
  assert.equal(contactOrigin(req('https://prorels.com'), 'invalid-url'), null);
  assert.equal(contactOrigin(new Request('https://prorels.com/api/contact'), 'https://prorels.com'), null);
});

test('contact validation rejects header injection, missing consent and invalid contacts', () => {
  assert.equal(validateLead(input).data.email, input.email);
  for (const email of ['buyer@example.org\r\nBcc: victim@example.org', 'bad@email', ['buyer@example.org'], 'a'.repeat(255) + '@example.org']) assert.ok(validateLead({ ...input, email }).errors.email);
  for (const phone of ['abc', '123', '+7\n9000000000', '1'.repeat(16)]) assert.ok(validateLead({ ...input, phone }).errors.phone);
  for (const comment of ['', 'a'.repeat(4001), 'Hello\u0000world']) assert.ok(validateLead({ ...input, comment }).errors.comment);
  assert.ok(validateLead({ ...input, consent: false }).errors.consent);
  assert.ok(validateLead({ ...input, consent: 'true' }).errors.consent);
  assert.equal(validateLead({ ...input, website: 'spam.example' }).spam, true);
  const lead = validateLead({ ...input, utm: { utm_source: 'A\nB', utm_campaign: 'x'.repeat(500), injected: 'ignore' } }).data;
  assert.deepEqual(Object.keys(lead.utm), ['utm_source', 'utm_campaign']);
  assert.equal(lead.utm.utm_source, 'AB');
  assert.equal(lead.utm.utm_campaign.length, 160);
});

test('email escapes customer content and contains source, text fallback and reply link', () => {
  const lead = validateLead({ ...input, comment: '<img src=x onerror=alert(1)>\nР65 & крепёж', utm: { utm_source: '<script>' } }).data;
  const mail = renderLeadEmail(lead, { title: 'Р65 <новые>', url: 'https://landing.example.org/blog/r65', path: '/blog/r65' }, 'TEST1234', new Date('2026-10-10T12:00:00Z'));
  assert.ok(!mail.html.includes('<img') && !mail.html.includes('<script>'));
  assert.ok(mail.html.includes('&lt;img') && mail.html.includes('Р65 &amp; крепёж'));
  assert.ok(mail.text.includes('https://landing.example.org/blog/r65') && mail.text.includes('<img'));
  assert.ok(mail.html.includes('mailto:buyer@example.org'));
  assert.ok(mail.text.includes('15:00') && mail.text.includes('МСК'));
  assert.match(mail.subject, /Блог/);
});

test('SMTP fails closed and never disables production TLS', () => {
  assert.throws(() => smtpSettings({}));
  const env = { SMTP_HOST: 'smtp.example.org', SMTP_FROM: 'sender@example.org', SMTP_USER: 'sender', SMTP_PASS: 'test' };
  assert.equal(smtpSettings(env).transport.secure, true);
  assert.equal(smtpSettings({ ...env, SMTP_PORT: '587' }).transport.requireTLS, true);
  assert.throws(() => smtpSettings({ ...env, SMTP_FROM: 'a@example.org\r\nBcc:b@example.org' }));
  assert.throws(() => smtpSettings({ ...env, SMTP_LOCAL_TEST: 'true' }));
  assert.throws(() => smtpSettings({ ...env, SMTP_PORT: 'not-a-port' }));
  assert.equal(smtpSettings({ SMTP_LOCAL_TEST: 'true', SMTP_HOST: '127.0.0.1', SMTP_FROM: 'test@example.org', SMTP_PORT: '2525' }).transport.ignoreTLS, true);
});

test('rate limit does not trust client IP headers by default and expires', () => {
  const headers = new Headers({ 'x-real-ip': '203.0.113.12' });
  assert.equal(rateLimitKey(headers, 'Buyer@example.org', false), rateLimitKey(new Headers(), 'buyer@example.org', false));
  assert.notEqual(rateLimitKey(headers, 'buyer@example.org', true), rateLimitKey(new Headers(), 'buyer@example.org', false));
  for (let i = 0; i < 5; i++) assert.equal(takeLeadSlot('limit-test', 1000), 0);
  assert.equal(takeLeadSlot('limit-test', 1000), 900);
  assert.equal(takeLeadSlot('limit-test', 901001), 0);
});
