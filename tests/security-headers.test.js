// Security headers on every response kind, in Local_Mode and Published_Mode over the same dist/.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fc from 'fast-check';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAccountService } from '../server/accounts.js';
import { createHttpHandler, SECURITY_HEADERS } from '../server/http.js';
import { LOCAL_DEFAULTS, parseDeploymentConfig } from '../server/deploy-config.js';

const DIST = resolve(import.meta.dir, '..', process.env.CAMPING_DIST || 'dist');
const PUBLIC = 'https://www.our-littlemoments.com';
const PROXIED_BASE = 'http://www.our-littlemoments.com';
const LOCAL_BASE = 'http://127.0.0.1:5173';
const PASS = 'correct horse battery';
const PUBLISHED = parseDeploymentConfig({ CAMPING_PUBLISHED: '1', CAMPING_PUBLIC_ORIGIN: PUBLIC });
const TOKEN = 'ab'.repeat(32);
const LIMITED_XFF = '198.51.100.99';
const LIMITED_PEER = '127.0.0.9';

const EXPECTED = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin'
};

let dir, failDir;
const services = [];
const h = {};
const cookies = {};
const peer = address => ({ requestIP: () => ({ address }) });
const nginxPeer = peer('127.0.0.1');

/** A request as nginx forwards it in Published_Mode. */
function proxied(handler, method, path, { xff = '203.0.113.7', origin = PUBLIC, cookie, body, type, host } = {}) {
  const headers = { 'x-forwarded-for': xff, 'x-forwarded-proto': 'https' };
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  if (type) headers['content-type'] = type;
  else if (body !== undefined) headers['content-type'] = 'application/json';
  const base = host ? `http://${host}` : PROXIED_BASE;
  return handler(new Request(base + path, { method, headers, body: typeof body === 'string' || body === undefined ? body : JSON.stringify(body) }), nginxPeer);
}
/** A Local_Mode request from a loopback peer. */
function local(handler, method, path, { origin = LOCAL_BASE, cookie, body, type, host, from = nginxPeer, headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (method !== 'GET' && method !== 'HEAD' && origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  if (type) headers['content-type'] = type;
  else if (body !== undefined) headers['content-type'] = 'application/json';
  const base = host ? `http://${host}` : LOCAL_BASE;
  return handler(new Request(base + path, { method, headers, body: typeof body === 'string' || body === undefined ? body : JSON.stringify(body) }), from);
}
const sessionCookie = res => (res.headers.get('set-cookie') || '').split(';')[0];

function parseCsp(value) {
  const out = new Map();
  for (const part of value.split(';').map(p => p.trim()).filter(Boolean)) {
    const [name, ...sources] = part.split(/\s+/);
    expect(out.has(name)).toBe(false);
    out.set(name, sources);
  }
  return out;
}

/** Asserts each Security_Header once with its value and no Access-Control-* header. */
function checkHeaders(res, label) {
  for (const [name, value] of Object.entries(EXPECTED)) {
    // Headers.get joins duplicates with ", ", so equality also proves the header appears once.
    expect({ label, name, value: res.headers.get(name) }).toEqual({ label, name, value });
  }
  const acao = [...res.headers.keys()].filter(k => k.toLowerCase().startsWith('access-control-'));
  expect({ label, acao }).toEqual({ label, acao: [] });
}

// Response kinds of Requirement 11.1, keyed by name; each returns { res, cache } where cache is the expected Cache-Control.
const KINDS = {
  staticAsset: (m, method) => ({ req: () => send(m, method, '/styles.css'), cache: 'no-cache' }),
  chunkAsset: (m, method) => ({ req: () => send(m, method, '/entry.js'), cache: 'no-cache' }),
  shellRoot: (m, method) => ({ req: () => send(m, method, '/'), cache: 'no-store' }),
  shellLogin: (m, method) => ({ req: () => send(m, method, '/login'), cache: 'no-store' }),
  indexHtml: (m, method) => ({ req: () => send(m, method, '/index.html'), cache: 'no-store' }),
  invitePage: (m, method) => ({ req: () => send(m, method, `/invite/${TOKEN}`), cache: 'no-store' }),
  homePage: (m, method) => ({ req: () => send(m, method, '/admin-one/home'), cache: 'no-store' }),
  serviceWorker: (m, method) => ({ req: () => send(m, method, '/sw.js'), cache: 'no-cache' }),
  unknownStatic: (m, method) => ({ req: () => send(m, method, '/package.json'), cache: 'no-store' }),
  badPath: (m, method) => ({ req: () => send(m, method, '/chunks/%E0%A4%A.js'), cache: 'no-store' }),
  demo: (m, method) => ({ req: () => send(m, method, '/demo'), cache: 'no-store' }),
  setupPage: (m, method) => ({ req: () => send(m, method, '/setup'), cache: 'no-store' }),
  staticPost: m => ({ req: () => send(m, 'POST', '/login', { body: {} }), cache: 'no-store' }),
  apiSession: (m, method) => ({ req: () => send(m, method, '/api/session'), cache: 'no-store' }),
  apiSessionSignedIn: (m, method) => ({ req: () => send(m, method, '/api/session', { cookie: cookies[m] }), cache: 'no-store' }),
  apiProtected401: m => ({ req: () => send(m, 'GET', '/api/trips'), cache: 'no-store' }),
  apiProtected200: m => ({ req: () => send(m, 'GET', '/api/trips', { cookie: cookies[m] }), cache: 'no-store' }),
  apiAdmin: m => ({ req: () => send(m, 'GET', '/api/admin/users', { cookie: cookies[m] }), cache: 'no-store' }),
  apiAdminSettings: m => ({ req: () => send(m, 'GET', '/api/admin/settings', { cookie: cookies[m] }), cache: 'no-store' }),
  invitePreview404: m => ({ req: () => send(m, 'GET', `/api/invites/${TOKEN}/preview`), cache: 'no-store' }),
  invitePreview429: m => ({ req: () => send(m, 'GET', `/api/invites/${TOKEN}/preview`, { limited: true }), cache: 'no-store' }),
  apiUnknown: (m, method) => ({ req: () => send(m, method, '/api/no-such-route'), cache: 'no-store' }),
  apiSetup: m => ({ req: () => send(m, 'POST', '/api/setup', { body: {} }), cache: 'no-store' }),
  api405: m => ({ req: () => send(m, 'DELETE', '/api/session'), cache: 'no-store' }),
  apiHead: m => ({ req: () => send(m, 'HEAD', '/api/session'), cache: 'no-store' }),
  apiOptions: m => ({ req: () => send(m, 'OPTIONS', '/api/trips', { headers: { 'access-control-request-method': 'POST' } }), cache: 'no-store' }),
  api400: m => ({ req: () => send(m, 'POST', '/api/login', { body: '{not json' }), cache: 'no-store' }),
  api403Origin: m => ({ req: () => send(m, 'POST', '/api/login', { body: {}, origin: 'https://attacker.example' }), cache: 'no-store' }),
  api403CrossSite: m => ({ req: () => send(m, 'POST', '/api/login', { body: {}, headers: { 'sec-fetch-site': 'cross-site' } }), cache: 'no-store' }),
  api413: m => ({ req: () => send(m, 'POST', '/api/login', { body: JSON.stringify({ username: 'x'.repeat(1_048_577) }) }), cache: 'no-store' }),
  api415: m => ({ req: () => send(m, 'POST', '/api/trips', { body: 'x', type: 'text/plain' }), cache: 'no-store' }),
  api500Handler: m => ({ req: () => send(m, 'GET', '/api/trips', { cookie: cookies[`${m}-broken`], handler: `${m}-broken` }), cache: 'no-store', status: 500 }),
  http500: (m, method) => ({ req: () => send(m, method, '/api/session', { handler: `${m}-throwing` }), cache: 'no-store', status: 500 }),
  forbiddenHost: (m, method) => ({ req: () => send(m, method, '/', { host: 'evil.example' }), cache: 'no-store', status: 403 }),
  badForwarding: (m, method) => ({ req: () => send(m, method, '/', { xff: 'not-an-ip' }), cache: 'no-store', status: m === 'published' ? 400 : undefined })
};

async function send(mode, method, path, opts = {}) {
  const handler = h[opts.handler ?? mode];
  const extra = { ...(opts.headers || {}) };
  if (mode === 'published') {
    if (opts.headers) {
      // proxied() has no free-form headers; build the request here.
      const headers = { 'x-forwarded-for': opts.limited ? LIMITED_XFF : '203.0.113.7', 'x-forwarded-proto': 'https', ...extra };
      if (method !== 'GET' && method !== 'HEAD') headers.origin = opts.origin ?? PUBLIC;
      if (opts.body !== undefined) headers['content-type'] = opts.type || 'application/json';
      return handler(new Request(PROXIED_BASE + path, { method, headers, body: typeof opts.body === 'string' || opts.body === undefined ? opts.body : JSON.stringify(opts.body) }), nginxPeer);
    }
    return proxied(handler, method, path, { ...opts, xff: opts.xff ?? (opts.limited ? LIMITED_XFF : undefined), origin: method === 'GET' || method === 'HEAD' ? undefined : opts.origin ?? PUBLIC });
  }
  if (opts.xff) extra['x-forwarded-for'] = opts.xff;
  return local(handler, method, path, { ...opts, headers: extra, from: opts.limited ? peer(LIMITED_PEER) : nginxPeer });
}

const METHODS = ['GET', 'HEAD'];
const MODES = ['local', 'published'];
const KIND_NAMES = Object.keys(KINDS);

const quiet = async fn => {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
};

beforeAll(async () => {
  if (!(await Bun.file(join(DIST, 'index.html')).exists())) throw new Error('dist is missing; run `bun run build` first.');
  dir = mkdtempSync(join(tmpdir(), 'camping-headers-'));
  failDir = mkdtempSync(join(tmpdir(), 'camping-headers-fail-'));
  const dbPath = join(dir, 'accounts.sqlite');

  const localAccounts = createAccountService({ dbPath, deployment: LOCAL_DEFAULTS });
  services.push(localAccounts);
  h.local = createHttpHandler({ root: DIST, accounts: localAccounts, config: LOCAL_DEFAULTS });
  const setup = await local(h.local, 'POST', '/api/setup', { body: { username: 'admin-one', displayName: '管理員', password: PASS } });
  if (setup.status !== 200) throw new Error(`setup failed: ${setup.status}`);
  cookies.local = sessionCookie(setup);

  const pubAccounts = createAccountService({ dbPath, deployment: PUBLISHED });
  services.push(pubAccounts);
  h.published = createHttpHandler({ root: DIST, accounts: pubAccounts, config: PUBLISHED });
  const login = await proxied(h.published, 'POST', '/api/login', { body: { username: 'admin-one', password: PASS } });
  if (login.status !== 200) throw new Error(`published login failed: ${login.status}`);
  cookies.published = sessionCookie(login);

  // A service whose trips table is gone, so a signed-in GET /api/trips throws inside accounts.handle.
  for (const [mode, config] of [['local', LOCAL_DEFAULTS], ['published', PUBLISHED]]) {
    const path = join(failDir, `${mode}.sqlite`);
    const seed = createAccountService({ dbPath: path, deployment: LOCAL_DEFAULTS });
    const seedHandler = createHttpHandler({ root: DIST, accounts: seed });
    const res = await local(seedHandler, 'POST', '/api/setup', { body: { username: 'admin-one', displayName: '管理員', password: PASS } });
    if (res.status !== 200) throw new Error(`broken seed failed: ${res.status}`);
    seed.close();
    const accounts = createAccountService({ dbPath: path, deployment: config });
    services.push(accounts);
    h[`${mode}-broken`] = createHttpHandler({ root: DIST, accounts, config });
    const signIn = mode === 'published'
      ? await proxied(h[`${mode}-broken`], 'POST', '/api/login', { body: { username: 'admin-one', password: PASS } })
      : await local(h[`${mode}-broken`], 'POST', '/api/login', { body: { username: 'admin-one', password: PASS } });
    cookies[`${mode}-broken`] = sessionCookie(signIn);
    const raw = new Database(path);
    raw.exec('PRAGMA foreign_keys = OFF; DROP TABLE IF EXISTS trip_members; DROP TABLE IF EXISTS trips;');
    raw.close();
  }

  // A handler whose account service throws, so server/http.js answers 500 itself.
  const throwing = { handle: async () => { throw new Error('boom /etc/secret SELECT * FROM users'); } };
  h['local-throwing'] = createHttpHandler({ root: DIST, accounts: throwing, config: LOCAL_DEFAULTS });
  h['published-throwing'] = createHttpHandler({ root: DIST, accounts: throwing, config: PUBLISHED });

  // Saturate the invitePreview limit (60 per 15 minutes) for one client in each mode.
  for (let i = 0; i < 60; i++) {
    await local(h.local, 'GET', `/api/invites/${TOKEN}/preview`, { from: peer(LIMITED_PEER) });
    await proxied(h.published, 'GET', `/api/invites/${TOKEN}/preview`, { xff: LIMITED_XFF, origin: null });
  }
});

afterAll(() => {
  while (services.length) services.pop().close();
  for (const d of [dir, failDir]) if (d) rmSync(d, { recursive: true, force: true });
});

describe('Content-Security-Policy', () => {
  test('SECURITY_HEADERS holds exactly the expected values', () => {
    const actual = Object.fromEntries(Object.entries(SECURITY_HEADERS).map(([k, v]) => [k.toLowerCase(), v]));
    for (const [name, value] of Object.entries(EXPECTED)) expect(actual[name]).toBe(value);
    expect(actual['cache-control']).toBe('no-store');
  });

  test('directives match Requirements 9.10, 9.11, 11.2, 11.3, and 13.8', async () => {
    for (const mode of MODES) {
      for (const path of ['/', '/login', `/invite/${TOKEN}`, '/admin']) {
        const res = await send(mode, 'GET', path);
        expect(res.status).toBe(200);
        const csp = parseCsp(res.headers.get('content-security-policy'));
        for (const name of ['default-src', 'base-uri', 'form-action', 'connect-src']) expect(csp.get(name)).toEqual(["'self'"]);
        expect(csp.get('object-src')).toEqual(["'none'"]);
        expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
        expect(csp.get('script-src')).toEqual(["'self'"]);
        for (const [name, sources] of csp) {
          for (const source of sources) {
            expect({ name, source, bad: /^'(?:unsafe-eval|wasm-unsafe-eval)'$|^\*$|^https?:$/i.test(source) || /openai/i.test(source) })
              .toEqual({ name, source, bad: false });
          }
        }
        // 'unsafe-inline' appears only in style-src (listed in the Security_Report, Req 11.7).
        for (const [name, sources] of csp) if (name !== 'style-src') expect(sources).not.toContain("'unsafe-inline'");
      }
    }
  });

  test('the Published_Mode shell carries only the deployment meta tag and no inline script', async () => {
    const res = await send('published', 'GET', '/');
    const html = await res.text();
    expect(html).toContain('<meta name="camping-deployment" content="published">');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
  });
});

describe('Permissions-Policy', () => {
  test('denies camera, microphone, and geolocation to all origins', async () => {
    const res = await send('local', 'GET', '/');
    const entries = Object.fromEntries(res.headers.get('permissions-policy').split(',').map(p => p.trim().split('=')));
    for (const feature of ['camera', 'microphone', 'geolocation']) expect(entries[feature]).toBe('()');
  });
});

describe('every response kind of Requirement 11.1', () => {
  for (const mode of MODES) {
    for (const name of KIND_NAMES) {
      test(`${mode} ${name}`, async () => {
        const kind = KINDS[name](mode, 'GET');
        const res = await quiet(kind.req);
        if (kind.status) expect(res.status).toBe(kind.status);
        checkHeaders(res, `${mode} ${name} ${res.status}`);
        expect(res.headers.get('cache-control')).toBe(kind.cache);
      });
    }
  }

  test('status codes cover 400, 403, 404, 405, 413, 415, 429, and 500 in both modes', async () => {
    for (const mode of MODES) {
      const seen = new Set();
      for (const name of KIND_NAMES) seen.add((await quiet(KINDS[name](mode, 'GET').req)).status);
      for (const status of [200, 400, 401, 403, 404, 405, 413, 415, 429, 500]) expect({ mode, status, seen: seen.has(status) }).toEqual({ mode, status, seen: true });
    }
  });

  test('Published_Mode sw.js is rewritten and keeps no-cache', async () => {
    const res = await send('published', 'GET', '/sw.js');
    expect((await res.text()).startsWith('const PUBLISHED=true;')).toBe(true);
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  test('Published_Mode /demo, /setup, and POST /api/setup are 404 with the headers', async () => {
    for (const [method, path] of [['GET', '/demo'], ['GET', '/setup'], ['POST', '/api/setup']]) {
      const res = await send('published', method, path, method === 'POST' ? { body: {} } : {});
      expect(res.status).toBe(404);
      checkHeaders(res, `published ${method} ${path}`);
    }
  });

  test('429 from invitePreview carries Retry-After and the headers', async () => {
    for (const mode of MODES) {
      const res = await send(mode, 'GET', `/api/invites/${TOKEN}/preview`, { limited: true });
      expect(res.status).toBe(429);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      checkHeaders(res, `${mode} 429`);
    }
  });

  test('a 500 body reveals nothing from the thrown error', async () => {
    const res = await quiet(() => send('local', 'GET', '/api/session', { handler: 'local-throwing' }));
    const text = await res.text();
    expect(text).not.toMatch(/boom|etc|SELECT/);
  });
});

describe('no Access-Control-* header (Requirements 12.2, 12.7)', () => {
  const cases = [
    ['Public_API session', 'GET', '/api/session'],
    ['Public_API invite preview', 'GET', `/api/invites/${TOKEN}/preview`],
    ['Public_API login', 'POST', '/api/login'],
    ['Protected_API trips', 'GET', '/api/trips'],
    ['Protected_API trip create', 'POST', '/api/trips'],
    ['Admin_API users', 'GET', '/api/admin/users'],
    ['Admin_API settings', 'PATCH', '/api/admin/settings'],
    ['Static_Allowlist', 'GET', '/styles.css'],
    ['404 path', 'GET', '/nope.txt'],
    ['OPTIONS preflight', 'OPTIONS', '/api/trips']
  ];
  for (const mode of MODES) {
    const expected = mode === 'published' ? PUBLIC : LOCAL_BASE;
    for (const origin of ['https://attacker.example', expected, null]) {
      for (const [label, method, path] of cases) {
        test(`${mode} ${label} with Origin ${origin ?? '(none)'}`, async () => {
          const headers = origin ? { origin } : {};
          if (method === 'OPTIONS') headers['access-control-request-method'] = 'POST';
          for (const signedIn of [false, true]) {
            const opts = { headers, cookie: signedIn ? cookies[mode] : undefined, body: method === 'GET' || method === 'OPTIONS' ? undefined : {} };
            const res = mode === 'published'
              ? await h.published(new Request(PROXIED_BASE + path, { method, headers: { 'x-forwarded-for': '203.0.113.8', 'x-forwarded-proto': 'https', ...headers, ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.body ? { 'content-type': 'application/json' } : {}) }, body: opts.body ? '{}' : undefined }), nginxPeer)
              : await h.local(new Request(LOCAL_BASE + path, { method, headers: { ...headers, ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.body ? { 'content-type': 'application/json' } : {}) }, body: opts.body ? '{}' : undefined }), nginxPeer);
            checkHeaders(res, `${mode} ${label} ${origin} signedIn=${signedIn} ${res.status}`);
            if (method === 'OPTIONS') { expect(res.status).toBe(405); expect(res.headers.get('set-cookie')).toBeNull(); }
          }
        });
      }
    }
  }
});

describe('property', () => {
  // Feature: security-hardening, Property 17: Every response carries the security headers exactly once
  test('Property 17: every response carries the security headers exactly once', async () => {
    const segment = fc.stringMatching(/^[a-zA-Z0-9._%-]{0,12}$/);
    const randomPath = fc.array(segment, { minLength: 1, maxLength: 4 }).map(parts => '/' + parts.join('/'));
    const randomApiPath = fc.array(segment, { minLength: 1, maxLength: 3 }).map(parts => '/api/' + parts.join('/'));
    const method = fc.constantFrom('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS');
    const request = fc.oneof(
      fc.record({ kind: fc.constantFrom(...KIND_NAMES), method: fc.constantFrom(...METHODS) }),
      fc.record({ path: randomPath, method }),
      fc.record({ path: randomApiPath, method, signedIn: fc.boolean() })
    );
    await quiet(() => fc.assert(fc.asyncProperty(fc.constantFrom(...MODES), request, async (mode, r) => {
      let res, cache;
      if (r.kind) {
        const kind = KINDS[r.kind](mode, r.method);
        res = await kind.req();
        cache = kind.cache;
      } else {
        const opts = { cookie: r.signedIn ? cookies[mode] : undefined, body: ['GET', 'HEAD', 'OPTIONS'].includes(r.method) ? undefined : {} };
        res = await send(mode, r.method, r.path, opts);
        if (r.path.startsWith('/api/') || r.path === '/api') cache = 'no-store';
      }
      checkHeaders(res, `${mode} ${JSON.stringify(r)} ${res.status}`);
      if (cache) expect(res.headers.get('cache-control')).toBe(cache);
      if (res.status >= 400 || r.path?.startsWith('/api/')) {
        // Every API and error response is no-store, except none: errors never fall back to no-cache.
        if (!r.kind || KINDS[r.kind](mode, r.method).cache === 'no-store') expect(res.headers.get('cache-control')).toBe('no-store');
      }
    }), { numRuns: 150 }));
  });
});
