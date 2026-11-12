// semgrep --test 範例：js-security-vendored.yaml 的所有規則（不是可執行程式碼，僅供規則測試）。
// 範例中的字串皆為低熵佔位符（重複字元），不是真實憑證，也避免觸發 Gitleaks。
import { createHash, timingSafeEqual } from 'node:crypto';
import * as crypto from 'node:crypto';

// ---------------------------------------------------------------- lm-js-tls-verify-disabled

function tlsBad(host) {
  // ruleid: lm-js-tls-verify-disabled
  const opts = { host, rejectUnauthorized: false };
  // ruleid: lm-js-tls-verify-disabled
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  return opts;
}

function tlsGood(host, ca) {
  // ok: lm-js-tls-verify-disabled
  const opts = { host, ca, rejectUnauthorized: true };
  return opts;
}

// ---------------------------------------------------------------- lm-js-string-timer

function timerBad(name) {
  // ruleid: lm-js-string-timer
  setTimeout('refresh()', 100);
  // ruleid: lm-js-string-timer
  window.setInterval(`poll('${name}')`, 1000);
}

function timerGood(refresh) {
  // ok: lm-js-string-timer
  setTimeout(refresh, 100);
  // ok: lm-js-string-timer
  setInterval(() => refresh(), 1000);
}

// ---------------------------------------------------------------- lm-js-insecure-random-secret

function randomBad(user) {
  // ruleid: lm-js-insecure-random-secret
  const sessionToken = Math.random().toString(36).slice(2);
  // ruleid: lm-js-insecure-random-secret
  user.resetSecret = String(Math.floor(Math.random() * 1e9));
  return sessionToken;
}

function randomGood(items) {
  // ok: lm-js-insecure-random-secret
  const index = Math.floor(Math.random() * items.length);
  // ok: lm-js-insecure-random-secret
  const sessionToken = crypto.randomBytes(32).toString('base64url');
  return [index, sessionToken];
}

// ---------------------------------------------------------------- lm-js-timing-unsafe-compare

function compareBad(candidate, expectedToken, req, stored) {
  // ruleid: lm-js-timing-unsafe-compare
  if (candidate === expectedToken) return true;
  // ruleid: lm-js-timing-unsafe-compare
  if (req.body.setupToken !== stored.setupToken) return false;
  // ruleid: lm-js-timing-unsafe-compare
  return stored.signature == candidate;
}

function compareGood(token, a, b, setupToken) {
  // ok: lm-js-timing-unsafe-compare
  if (typeof token !== 'string') return false;
  // ok: lm-js-timing-unsafe-compare
  if (token.length === 0) return false;
  // ok: lm-js-timing-unsafe-compare
  if (setupToken === null) return false;
  // ok: lm-js-timing-unsafe-compare
  if (setupToken === undefined) return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  // ok: lm-js-timing-unsafe-compare
  return timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------- lm-js-hardcoded-secret

function secretBad(config) {
  // ruleid: lm-js-hardcoded-secret
  const apiKey = 'xxxxxxxxxxxxxxxxxxxx';
  // ruleid: lm-js-hardcoded-secret
  config.dbPassword = "aaaaaaaaaaaaaaaa";
  return apiKey;
}

function secretGood(env) {
  // ok: lm-js-hardcoded-secret
  const apiKey = env.CAMPING_OPENAI_API_KEY;
  // ok: lm-js-hardcoded-secret
  let setupTokenMode = 'generated';
  // ok: lm-js-hardcoded-secret
  const password = '';
  return [apiKey, setupTokenMode, password];
}

// ---------------------------------------------------------------- lm-js-weak-hash

function hashBad(data) {
  // ruleid: lm-js-weak-hash
  const a = createHash('md5').update(data).digest('hex');
  // ruleid: lm-js-weak-hash
  const b = crypto.createHash('sha1').update(data).digest('hex');
  return [a, b];
}

function hashGood(data) {
  // ok: lm-js-weak-hash
  return createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------- lm-js-document-write

function writeBad(html) {
  // ruleid: lm-js-document-write
  document.write(html);
}

function writeGood(el, text) {
  // ok: lm-js-document-write
  el.textContent = text;
}

// ---------------------------------------------------------------- lm-js-dom-html-sink

function sinkBad(app, title, e) {
  // ruleid: lm-js-dom-html-sink
  app.innerHTML = `<h1>${e(title)}</h1>`;
  // ruleid: lm-js-dom-html-sink
  app.insertAdjacentHTML('beforeend', title);
}

function sinkGood(app, dialog, title) {
  // ok: lm-js-dom-html-sink
  dialog.innerHTML = '';
  // ok: lm-js-dom-html-sink
  app.innerHTML = '<p class="acct-loading" role="status">載入中…</p>';
  // ok: lm-js-dom-html-sink
  app.textContent = title;
}

export {
  tlsBad, tlsGood, timerBad, timerGood, randomBad, randomGood, compareBad, compareGood,
  secretBad, secretGood, hashBad, hashGood, writeBad, writeGood, sinkBad, sinkGood,
};
