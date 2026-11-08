// CSRF gate and OPTIONS handling (security-hardening Requirements 10 and 12).
// Requests go through createHttpHandler exactly as the browser or nginx sends them:
// Local_Mode as Direct_Local_Requests, Published_Mode as Proxied_Requests with the Public_Origin.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fc from 'fast-check';
import { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAccountService } from '../server/accounts.js';
import { createHttpHandler } from '../server/http.js';
import { LOCAL_DEFAULTS, parseDeploymentConfig } from '../server/deploy-config.js';

const DIST = resolve(import.meta.dir, '..', process.env.CAMPING_DIST || 'dist');
const PUBLIC = 'https://www.our-littlemoments.com';
const PROXIED_BASE = 'http://www.our-littlemoments.com';
const LOCAL_BASE = 'http://127.0.0.1:5173';
const PASS = 'correct horse battery';
const PUBLISHED = parseDeploymentConfig({ CAMPING_PUBLISHED: '1', CAMPING_PUBLIC_ORIGIN: PUBLIC });
const nginxPeer = { requestIP: () => ({ address: '127.0.0.1' }) };

const ORIGIN_MSG = '請求來源不被允許。';
const CROSS_MSG = '不接受跨站請求。';
const JSON_MSG = '請以 JSON 格式送出資料。';
const CLOSED_MSG = '目前不開放公開註冊，請使用旅行邀請連結建立帳號。';
const SETUP_LOOPBACK_MSG = '首次管理員設定只能在本機進行。';

const MODES = {
  local: {
    config: LOCAL_DEFAULTS, base: LOCAL_BASE, expected: LOCAL_BASE,
    foreign: { scheme: 'https://127.0.0.1:5173', host: 'http://localhost:5173', port: 'http://127.0.0.1:5174' }
  },
  published: {
    config: PUBLISHED, base: PROXIED_BASE, expected: PUBLIC,
    foreign: { scheme: 'http://www.our-littlemoments.com', host: 'https://evil.our-littlemoments.com', port: 'https://www.our-littlemoments.com:8443' }
  }
};

// Nonexistent IDs keep requests that pass the gate from changing real rows.
const TRIP = 'nope-trip', USER = 'nope-user', INVITE_ID = 'nope-invite', TOKEN = '0'.repeat(64);
// Every mutating route in the Route_Table; `json` marks JSON_Routes; `localOnly` marks routes absent in Published_Mode.
const MUTATING = [
  { method: 'POST', path: '/api/setup', json: true, localOnly: true },
  { method: 'POST', path: '/api/login', json: true },
  { method: 'POST', path: '/api/register', json: true },
  { method: 'POST', path: '/api/logout', json: false },
  { method: 'POST', path: '/api/trips', json: true },
  { method: 'PUT', path: `/api/trips/${TRIP}`, json: true },
  { method: 'PATCH', path: `/api/trips/${TRIP}`, json: true },
  { method: 'POST', path: `/api/trips/${TRIP}/check`, json: true },
  { method: 'PUT', path: `/api/trips/${TRIP}/ledger`, json: true },
  { method: 'POST', path: `/api/trips/${TRIP}/receipt-ai`, json: false },
  { method: 'POST', path: `/api/trips/${TRIP}/invites`, json: true },
  { method: 'POST', path: `/api/trips/${TRIP}/invites/${INVITE_ID}/revoke`, json: true },
  { method: 'POST', path: `/api/trips/${TRIP}/delete`, json: true },
  { method: 'POST', path: `/api/invites/${TOKEN}/join`, json: true },
  { method: 'POST', path: `/api/invites/${TOKEN}/register`, json: true },
  { method: 'PATCH', path: `/api/admin/users/${USER}`, json: true },
  { method: 'POST', path: `/api/admin/users/${USER}/delete`, json: true },
  { method: 'POST', path: `/api/admin/trips/${TRIP}/delete`, json: true },
  { method: 'PATCH', path: '/api/admin/settings', json: true },
  { method: 'POST', path: '/api/admin/security/alerts/nope-alert/acknowledge', json: true }
];
const routesFor = mode => MUTATING.filter(r => mode === 'local' || !r.localOnly);
const GET_PATHS = ['/api/session', '/api/trips', `/api/trips/${TRIP}`, `/api/trips/${TRIP}/ledger`, `/api/trips/${TRIP}/receipt-ai`,
  `/api/trips/${TRIP}/invites`, `/api/invites/${TOKEN}`, `/api/invites/${TOKEN}/preview`, '/api/admin/users', '/api/admin/audit', '/api/admin/settings',
  '/api/admin/receipt-ai-usage', '/api/admin/security'];

let dir, dbPath, raw, adminCookie, adminId;
const sha256 = value => createHash('sha256').update(value).digest('hex');

function open(mode, path = dbPath) {
  const accounts = createAccountService({ dbPath: path, deployment: MODES[mode].config });
  return { accounts, handler: createHttpHandler({ root: DIST, accounts, config: MODES[mode].config }) };
}

async function withService(mode, fn, path) {
  const service = open(mode, path);
  try { return await fn(service.handler, service.accounts); } finally { service.accounts.close(); }
}

/**
 * Sends one request. `origin` null omits the header; `contentType` null omits Content-Type and sends no body.
 * Bodies are bytes so Bun does not add a text/plain Content-Type of its own.
 */
function send(handler, mode, method, path, { origin = MODES[mode].expected, secFetchSite = null, contentType = 'application/json', body = '{}', cookie, extra = {} } = {}) {
  const headers = { ...extra };
  if (mode === 'published') { headers['x-forwarded-for'] = `203.0.113.${1 + Math.floor(Math.random() * 250)}`; headers['x-forwarded-proto'] = 'https'; }
  if (origin !== null) headers.origin = origin;
  if (secFetchSite !== null) headers['sec-fetch-site'] = secFetchSite;
  if (cookie) headers.cookie = cookie;
  if (contentType !== null) headers['content-type'] = contentType;
  const payload = contentType === null || body === undefined || method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? undefined : new TextEncoder().encode(body);
  return handler(new Request(MODES[mode].base + path, { method, headers, body: payload }), nginxPeer);
}

/** Every table's rows, sorted, as one string. */
// A 415 on POST /api/login reaches the login handler, which records one invalid_input Failed_Login_Event
// (Req 23.1). `withoutSecurityEvents` leaves out the Security_Event_Store so the rest can be compared.
const SECURITY_TABLES = new Set(['security_events', 'security_alerts']);
function snapshot({ withoutSecurityEvents = false } = {}) {
  const tables = raw.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(r => r.name)
    .filter(name => !(withoutSecurityEvents && SECURITY_TABLES.has(name)));
  return JSON.stringify(tables.map(name => [name, raw.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
    .filter(row => !(withoutSecurityEvents && name === 'sqlite_sequence' && SECURITY_TABLES.has(row.name)))
    .map(row => JSON.stringify(row)).sort()]));
}
const eventCount = () => raw.query("SELECT COUNT(*) AS n FROM security_events WHERE reason = 'invalid_input'").get().n;

/** A throwaway Valid_Session inserted directly, so logout cases never consume the shared admin session. */
function throwawayCookie() {
  const token = randomBytes(32).toString('hex');
  raw.query('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), adminId, Date.now(), Date.now() + 86400000);
  return `ggc_session=${token}`;
}

const isJsonType = type => type !== null && type.split(';')[0].trim().toLowerCase() === 'application/json';
const accessControlHeaders = res => [...res.headers.keys()].filter(name => name.toLowerCase().startsWith('access-control-'));

/** The decision table of Property 15 (Req 10.1–10.5): returns the refusal, or null when the request proceeds. */
function gateModel(route, mode, origin, secFetchSite, contentType) {
  if (origin !== MODES[mode].expected) return { status: 403, error: ORIGIN_MSG };
  if (secFetchSite === 'cross-site') return { status: 403, error: CROSS_MSG };
  // PBN pre-check that answers before the content type: closed registration (PBN 10.2). The register limiter and
  // the setup loopback check cannot fire here (fresh limiter per case; requests come from loopback).
  if (route.path === '/api/register' && mode === 'published') return { status: 403, error: CLOSED_MSG };
  if (route.json && !isJsonType(contentType)) return { status: 415, error: JSON_MSG };
  return null;
}

beforeAll(async () => {
  if (!(await Bun.file(join(DIST, 'index.html')).exists())) throw new Error('dist is missing; run `bun run build` first.');
  dir = mkdtempSync(join(tmpdir(), 'camping-csrf-'));
  dbPath = join(dir, 'accounts.sqlite');
  await withService('local', async handler => {
    const setup = await send(handler, 'local', 'POST', '/api/setup', { body: JSON.stringify({ username: 'admin-one', displayName: '管理員', password: PASS }) });
    if (setup.status !== 200) throw new Error(`seed setup failed: ${setup.status} ${await setup.text()}`);
    const member = await send(handler, 'local', 'POST', '/api/register', { body: JSON.stringify({ username: 'member-one', displayName: '旅伴', password: PASS }) });
    if (member.status !== 200) throw new Error(`seed register failed: ${member.status} ${await member.text()}`);
    adminCookie = (setup.headers.get('set-cookie') || '').split(';')[0];
  });
  raw = new Database(dbPath);
  adminId = raw.query("SELECT id FROM users WHERE username = 'admin-one'").get().id;
});

afterAll(() => {
  raw?.close();
  try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may still hold the WAL briefly */ }
});

// Origin variants that Requirement 10.7 names, per mode.
const originCases = mode => [
  ['missing', null], ['null', 'null'],
  ['scheme', MODES[mode].foreign.scheme], ['host', MODES[mode].foreign.host], ['port', MODES[mode].foreign.port]
];
const BAD_TYPES = [['text/plain', 'text/plain'], ['form', 'application/x-www-form-urlencoded'], ['multipart', 'multipart/form-data; boundary=x'], ['none', null]];

describe('per-route CSRF matrix (Req 10.7)', () => {
  for (const mode of ['local', 'published']) {
    for (const route of routesFor(mode)) {
      test(`${mode} ${route.method} ${route.path}`, async () => {
        await withService(mode, async handler => {
          for (const signedIn of [false, true]) {
            const cookie = () => (signedIn ? (route.path === '/api/logout' ? throwawayCookie() : adminCookie) : undefined);
            const cases = [
              ...originCases(mode).map(([name, origin]) => ({ name: `origin ${name}`, origin, contentType: 'application/json', want: { status: 403, error: ORIGIN_MSG } })),
              { name: 'cross-site', origin: MODES[mode].expected, secFetchSite: 'cross-site', contentType: 'application/json', want: { status: 403, error: CROSS_MSG } },
              ...(route.json ? BAD_TYPES.map(([name, contentType]) => ({ name: `type ${name}`, origin: MODES[mode].expected, contentType, want: gateModel(route, mode, MODES[mode].expected, null, contentType) })) : [])
            ];
            for (const c of cases) {
              const requestCookie = cookie();
              // Only a login request that passes the Origin and Sec-Fetch-Site checks reaches the handler.
              const loginEvent = route.path === '/api/login' && c.want.status === 415;
              const before = snapshot({ withoutSecurityEvents: loginEvent });
              const eventsBefore = eventCount();
              const res = await send(handler, mode, route.method, route.path, { origin: c.origin, secFetchSite: c.secFetchSite ?? null, contentType: c.contentType, cookie: requestCookie });
              const label = `${c.name} signedIn=${signedIn}`;
              expect({ label, status: res.status }).toEqual({ label, status: c.want.status });
              expect({ label, body: await res.json() }).toEqual({ label, body: { error: c.want.error } });
              expect(res.headers.get('set-cookie')).toBeNull();
              expect(accessControlHeaders(res)).toEqual([]);
              expect(snapshot({ withoutSecurityEvents: loginEvent })).toBe(before);
              expect({ label, events: eventCount() - eventsBefore }).toEqual({ label, events: loginEvent ? 1 : 0 });
            }
          }
        });
      });
    }
  }
});

describe('CSRF gate examples', () => {
  test('a matching Origin with same-origin, none, or no Sec-Fetch-Site passes the gate (Req 10.5)', async () => {
    await withService('local', async handler => {
      for (const secFetchSite of [null, 'same-origin', 'none', 'same-site']) {
        const res = await send(handler, 'local', 'PATCH', '/api/admin/settings', { secFetchSite, cookie: adminCookie });
        expect(res.status).toBe(400);
        expect((await res.json()).error).not.toBe(CROSS_MSG);
      }
    });
  });

  test('a JSON_Route without a session and with text/plain gets 415, not 401 (Req 10.3, 10.4)', async () => {
    await withService('local', async handler => {
      const wrong = await send(handler, 'local', 'POST', '/api/trips', { contentType: 'text/plain' });
      expect(wrong.status).toBe(415);
      const right = await send(handler, 'local', 'POST', '/api/trips');
      expect(right.status).toBe(401);
    });
  });
});

describe('PBN orderings kept (Req 10.4)', () => {
  test('Published_Mode body-less POST /api/register gets the closed-registration 403', async () => {
    await withService('published', async handler => {
      const before = snapshot();
      const res = await send(handler, 'published', 'POST', '/api/register', { contentType: null });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(CLOSED_MSG);
      expect(snapshot()).toBe(before);
    });
  });

  test('415 registration attempts count toward the register limit', async () => {
    await withService('local', async handler => {
      for (let i = 0; i < 10; i++) expect((await send(handler, 'local', 'POST', '/api/register', { contentType: 'text/plain' })).status).toBe(415);
      for (let i = 0; i < 10; i++) expect((await send(handler, 'local', 'POST', `/api/invites/${TOKEN}/register`, { contentType: null })).status).toBe(415);
      const blocked = await send(handler, 'local', 'POST', '/api/register', { body: JSON.stringify({ username: 'late-user', displayName: '晚到', password: PASS }) });
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(raw.query("SELECT COUNT(*) AS n FROM users WHERE username = 'late-user'").get().n).toBe(0);
    });
  });

  test('before the first admin exists, a body-less POST /api/register gets 409, not 415', async () => {
    await withService('local', async handler => {
      const res = await send(handler, 'local', 'POST', '/api/register', { contentType: null });
      expect(res.status).toBe(409);
    }, ':memory:');
  });

  test('the setup loopback 403 answers before the 415', async () => {
    await withService('local', async (handler, accounts) => {
      const request = new Request(`${LOCAL_BASE}/api/setup`, { method: 'POST', headers: { origin: LOCAL_BASE, 'content-type': 'text/plain' }, body: new TextEncoder().encode('{}') });
      const res = await accounts.handle(request, { ip: '203.0.113.9', expectedOrigin: LOCAL_BASE, secureCookie: false });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(SETUP_LOOPBACK_MSG);
      const local = await send(handler, 'local', 'POST', '/api/setup', { contentType: 'text/plain' });
      expect(local.status).toBe(415);
    }, ':memory:');
  });
});

describe('OPTIONS preflight (Req 12.3, 12.4, 12.8)', () => {
  test('OPTIONS with a foreign Origin and Access-Control-Request-Method: POST gets 405 and nothing else', async () => {
    for (const mode of ['local', 'published']) {
      await withService(mode, async handler => {
        for (const path of ['/api/trips', `/api/trips/${TRIP}/ledger`, '/api/admin/settings', '/api/not-a-route']) {
          const before = snapshot();
          const res = await send(handler, mode, 'OPTIONS', path, {
            origin: 'https://attacker.example', contentType: null, cookie: adminCookie,
            extra: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }
          });
          expect(res.status).toBe(405);
          expect(accessControlHeaders(res)).toEqual([]);
          expect(res.headers.get('set-cookie')).toBeNull();
          expect(snapshot()).toBe(before);
        }
      });
    }
  });
});

describe('properties', () => {
  // Feature: security-hardening, Property 15: The CSRF gate follows its decision table
  test('Property 15: the CSRF gate follows its decision table', async () => {
    const arbCase = fc.constantFrom('local', 'published').chain(mode => fc.record({
      mode: fc.constant(mode),
      route: fc.constantFrom(...routesFor(mode)),
      signedIn: fc.boolean(),
      origin: fc.constantFrom(null, 'null', MODES[mode].expected, MODES[mode].foreign.scheme, MODES[mode].foreign.host, MODES[mode].foreign.port,
        MODES[mode].expected.toUpperCase(), `${MODES[mode].expected}/`, MODES[mode === 'local' ? 'published' : 'local'].expected),
      secFetchSite: fc.constantFrom(null, 'same-origin', 'same-site', 'none', 'cross-site'),
      contentType: fc.oneof(
        fc.constantFrom(null, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp', 'text/json'),
        fc.tuple(fc.constantFrom('application/json', 'Application/JSON', 'APPLICATION/json'), fc.constantFrom('', '; charset=utf-8', ';charset=UTF-8', ' ; foo=bar'))
          .map(([type, params]) => type + params)
      )
    }));
    await fc.assert(fc.asyncProperty(arbCase, async ({ mode, route, signedIn, origin, secFetchSite, contentType }) => {
      await withService(mode, async handler => {
        const cookie = signedIn ? (route.path === '/api/logout' ? throwawayCookie() : adminCookie) : undefined;
        const want = gateModel(route, mode, origin, secFetchSite, contentType);
        // A login 415 is answered inside the handler, which records one invalid_input event (Req 23.1).
        const loginEvent = route.path === '/api/login' && want?.status === 415;
        const before = snapshot({ withoutSecurityEvents: loginEvent });
        const eventsBefore = eventCount();
        const res = await send(handler, mode, route.method, route.path, { origin, secFetchSite, contentType, cookie });
        const body = await res.json().catch(() => ({}));
        expect(accessControlHeaders(res)).toEqual([]);
        if (want) {
          expect({ status: res.status, error: body.error }).toEqual(want);
          expect(res.headers.get('set-cookie')).toBeNull();
          expect(snapshot({ withoutSecurityEvents: loginEvent })).toBe(before);
          expect(eventCount() - eventsBefore).toBe(loginEvent ? 1 : 0);
        } else {
          // The request reached its handler: no gate answer.
          expect([ORIGIN_MSG, CROSS_MSG, JSON_MSG]).not.toContain(body.error);
          expect(res.status).not.toBe(415);
          expect(res.status).toBeLessThan(500);
        }
      });
    }), { numRuns: 150 });
  }, 120000);

  // Feature: security-hardening, Property 18: OPTIONS on the API is always 405 and inert
  test('Property 18: OPTIONS on the API is always 405 and inert', async () => {
    const segment = fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/);
    const arbPath = fc.oneof(
      fc.constantFrom(...MUTATING.map(r => r.path), ...GET_PATHS),
      fc.array(segment, { minLength: 0, maxLength: 4 }).map(parts => ['/api', ...parts].join('/'))
    );
    const arbCase = fc.record({
      mode: fc.constantFrom('local', 'published'),
      path: arbPath,
      origin: fc.constantFrom(null, 'null', 'https://attacker.example', LOCAL_BASE, PUBLIC),
      requestMethod: fc.constantFrom(null, 'POST', 'PUT', 'DELETE', 'PATCH'),
      withCookie: fc.boolean()
    });
    await fc.assert(fc.asyncProperty(arbCase, async ({ mode, path, origin, requestMethod, withCookie }) => {
      await withService(mode, async handler => {
        const before = snapshot();
        const extra = requestMethod ? { 'access-control-request-method': requestMethod, 'access-control-request-headers': 'content-type' } : {};
        const res = await send(handler, mode, 'OPTIONS', path, { origin, contentType: null, cookie: withCookie ? adminCookie : undefined, extra });
        expect(res.status).toBe(405);
        expect(accessControlHeaders(res)).toEqual([]);
        expect(res.headers.get('set-cookie')).toBeNull();
        expect(snapshot()).toBe(before);
      });
    }), { numRuns: 120 });
  }, 120000);
});
