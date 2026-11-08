// Security hardening: authentication, password storage, session cookies, login and registration
// limits, and admin-only routes (Requirements 1–5 and 19.6). Requests go straight to
// accounts.handle with the request context that server/http.js would pass, so no dist is needed.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fc from 'fast-check';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAccountService, HttpError, RateLimiter, hashPassword, validatePassword, verifyPassword } from '../server/accounts.js';
import { parseDeploymentConfig } from '../server/deploy-config.js';
import { runCreateAdmin } from '../scripts/create-admin.mjs';

const DAY = 86400000;
const PUBLIC = 'https://www.our-littlemoments.com';
const PROXIED_BASE = 'http://www.our-littlemoments.com';
const LOCAL_BASE = 'http://127.0.0.1:5173';
const PASS = 'correct horse battery';
const WRONG = 'wrong horse battery';
const PUBLISHED = parseDeploymentConfig({ CAMPING_PUBLISHED: '1', CAMPING_PUBLIC_ORIGIN: PUBLIC });
const LOGIN_FAILED = { error: '帳號或密碼不正確。' };
const SESSION_MAX_AGE = 604800;
// Copied from LIMITS in server/accounts.js (not exported).
const LIMITS = {
  loginUser: { max: 5, window: 15 * 60000 },
  loginClient: { max: 30, window: 15 * 60000 },
  register: { max: 20, window: 60 * 60000 },
  invitePreview: { max: 60, window: 15 * 60000 }
};
const sha256 = value => createHash('sha256').update(value).digest('hex');

// Route inventory (Req 1.7, 5.9, 19.6). Every Route_Table entry appears exactly once, with its class.
// `json` marks a JSON_Route; `localOnly` marks entries absent from the Published_Mode Route_Table.
const INVENTORY = [
  { method: 'GET', path: '/api/session', cls: 'public' },
  { method: 'POST', path: '/api/setup', cls: 'public', json: true, localOnly: true },
  { method: 'POST', path: '/api/login', cls: 'public', json: true },
  { method: 'POST', path: '/api/register', cls: 'public', json: true },
  { method: 'POST', path: '/api/logout', cls: 'public' },
  { method: 'GET', path: '/api/invites/{token}/preview', cls: 'public' },
  { method: 'POST', path: '/api/invites/{token}/register', cls: 'public', json: true },
  { method: 'GET', path: '/api/trips', cls: 'protected' },
  { method: 'POST', path: '/api/trips', cls: 'protected', json: true },
  { method: 'GET', path: '/api/trips/{tripId}', cls: 'protected' },
  { method: 'PUT', path: '/api/trips/{tripId}', cls: 'protected', json: true },
  { method: 'PATCH', path: '/api/trips/{tripId}', cls: 'protected', json: true },
  { method: 'POST', path: '/api/trips/{tripId}/check', cls: 'protected', json: true },
  { method: 'GET', path: '/api/trips/{tripId}/ledger', cls: 'protected' },
  { method: 'PUT', path: '/api/trips/{tripId}/ledger', cls: 'protected', json: true },
  { method: 'GET', path: '/api/trips/{tripId}/receipt-ai', cls: 'protected' },
  { method: 'POST', path: '/api/trips/{tripId}/receipt-ai', cls: 'protected' },
  { method: 'GET', path: '/api/trips/{tripId}/invites', cls: 'protected' },
  { method: 'POST', path: '/api/trips/{tripId}/invites', cls: 'protected', json: true },
  { method: 'POST', path: '/api/trips/{tripId}/invites/{inviteId}/revoke', cls: 'protected', json: true },
  { method: 'POST', path: '/api/trips/{tripId}/delete', cls: 'protected', json: true },
  { method: 'GET', path: '/api/invites/{token}', cls: 'protected' },
  { method: 'POST', path: '/api/invites/{token}/join', cls: 'protected', json: true },
  { method: 'GET', path: '/api/admin/users', cls: 'admin' },
  { method: 'PATCH', path: '/api/admin/users/{userId}', cls: 'admin', json: true },
  { method: 'POST', path: '/api/admin/users/{userId}/delete', cls: 'admin', json: true },
  { method: 'POST', path: '/api/admin/trips/{tripId}/delete', cls: 'admin', json: true },
  { method: 'GET', path: '/api/admin/audit', cls: 'admin' },
  { method: 'GET', path: '/api/admin/settings', cls: 'admin' },
  { method: 'PATCH', path: '/api/admin/settings', cls: 'admin', json: true },
  { method: 'GET', path: '/api/admin/receipt-ai-usage', cls: 'admin' },
  { method: 'GET', path: '/api/admin/security', cls: 'admin' },
  { method: 'POST', path: '/api/admin/security/alerts/{alertId}/acknowledge', cls: 'admin', json: true }
];
const inMode = mode => INVENTORY.filter(r => mode === 'local' || !r.localOnly);
const PROTECTED = INVENTORY.filter(r => r.cls !== 'public'); // Admin_API is a subset of Protected_API
const ADMIN = INVENTORY.filter(r => r.cls === 'admin');
const shape = path => path.replace(/\{[^}]+\}/g, '{}');

/** Route_Table entries read from the source, so a new entry cannot hide from the inventory. */
function parseRouteTable() {
  const src = readFileSync(resolve(import.meta.dir, '..', 'server', 'accounts.js'), 'utf8');
  const start = src.indexOf('const table = [');
  const end = src.indexOf('\n  ];', start);
  if (start < 0 || end < 0) throw new Error('Route_Table not found in server/accounts.js');
  const entries = [];
  for (const line of src.slice(start, end).split('\n')) {
    const m = line.match(/\[\/\^(.+?)\$\/,\s*\{([^}]*)\}/);
    if (!m) continue;
    const path = m[1].replace(/\(\[\^\/\]\+\)/g, '{}').replace(/\\\//g, '/');
    const localOnly = /published\s*\?\s*\[\]/.test(line);
    for (const [, method] of m[2].matchAll(/([A-Z]+):\s*routes\.\w+/g)) entries.push({ method, path, localOnly });
  }
  return entries;
}

let nowMs = Date.parse('2031-03-01T00:00:00.000Z');
const clock = () => nowMs;
let dir, dbPath, raw;
const services = {};
const ids = {};
const tokens = {};
let clientSeq = 0;
const freshClient = prefix => `${prefix}-${++clientSeq}`;

/** A request to the account service with the context server/http.js passes in each mode. */
function call(mode, method, path, { cookie, body, rawBody, type, origin, headers = {}, client = 'auth-default', service } = {}) {
  const pub = mode === 'published';
  const h = { ...headers };
  if (method !== 'GET' && method !== 'HEAD' && origin !== null) h.origin = origin ?? (pub ? PUBLIC : LOCAL_BASE);
  if (cookie !== undefined) h.cookie = cookie;
  const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  if (type !== undefined) { if (type) h['content-type'] = type; } else if (payload !== undefined) h['content-type'] = 'application/json';
  const ctx = pub
    ? { expectedOrigin: PUBLIC, secureCookie: true, clientAddress: client, ip: '127.0.0.1' }
    : { clientAddress: client, ip: '127.0.0.1' };
  const request = new Request((pub ? PROXIED_BASE : LOCAL_BASE) + path, { method, headers: h, body: payload });
  return (service ?? services[mode]).handle(request, ctx);
}
const login = (username, password = PASS, opts = {}) => call(opts.mode ?? 'local', 'POST', '/api/login', { ...opts, body: { username, password } });
const tokenOf = res => (res.headers.get('set-cookie') || '').match(/^ggc_session=([^;]*)/)?.[1] ?? null;
const attrsOf = res => (res.headers.get('set-cookie') || '').split(';').map(p => p.trim());
const sessionRow = token => raw.query('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));

function snapshot(db = raw) {
  const out = {};
  for (const { name } of db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    out[name] = db.query(`SELECT * FROM "${name}"`).all().map(row => JSON.stringify(row)).sort();
  }
  return out;
}
function fill(path) {
  return path.replace('{tripId}', ids.trip).replace('{token}', 'ab'.repeat(32)).replace('{inviteId}', 'missing-invite').replace('{userId}', ids.member).replace('{alertId}', 'missing-alert');
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function timed(fn) { const t = performance.now(); const res = await fn(); return { res, ms: performance.now() - t }; }

async function register(username, client = 'seed') {
  const res = await call('local', 'POST', '/api/register', { body: { username, displayName: username, password: PASS }, client });
  if (res.status !== 200) throw new Error(`register ${username}: ${res.status} ${await res.text()}`);
  return tokenOf(res);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'camping-sec-auth-'));
  dbPath = join(dir, 'accounts.sqlite');
  services.local = createAccountService({ dbPath, now: clock });
  services.published = createAccountService({ dbPath, now: clock, deployment: PUBLISHED });
  raw = new Database(dbPath);
  raw.exec('PRAGMA busy_timeout = 5000;');
  const setup = await call('local', 'POST', '/api/setup', { body: { username: 'admin-one', displayName: '管理員', password: PASS }, client: 'seed' });
  if (setup.status !== 200) throw new Error(`setup: ${setup.status} ${await setup.text()}`);
  tokens.admin = tokenOf(setup);
  for (const name of ['member-one', 'member-two', 'ghost-user', 'locked-user', 'login-user', 'corrupt-user', 'timing-user']) tokens[name] = await register(name);
  tokens.member = tokens['member-one'];
  const users = await (await call('local', 'GET', '/api/admin/users', { cookie: `ggc_session=${tokens.admin}` })).json();
  for (const u of users.users) ids[u.username] = u.id;
  ids.admin = ids['admin-one'];
  ids.member = ids['member-one'];
  const trip = await call('local', 'POST', '/api/trips', {
    cookie: `ggc_session=${tokens.member}`,
    body: { title: '山中露營', startDate: '2031-04-01', endDate: '2031-04-02', expectedUserId: ids.member }
  });
  if (trip.status !== 201) throw new Error(`trip: ${trip.status} ${await trip.text()}`);
  ids.trip = (await trip.json()).trip.id;
  // Soft-delete ghost-user directly so its Session row survives (the admin route would delete it).
  raw.query('UPDATE users SET deleted_at = ? WHERE username = ?').run(nowMs, 'ghost-user');
});

afterAll(() => {
  for (const s of Object.values(services)) s.close();
  raw?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('route inventory (Req 1.7, 5.9, 19.6)', () => {
  test('the inventory lists exactly the Route_Table entries, and no entry is diagnostic', () => {
    const table = parseRouteTable();
    expect(table.length).toBeGreaterThanOrEqual(25);
    const key = r => `${r.method} ${shape(r.path)}${r.localOnly ? ' (local only)' : ''}`;
    expect(table.map(key).sort()).toEqual(INVENTORY.map(key).sort());
    // Every /api/admin/ entry is an Admin_API row, and only those are (Req 5.9).
    for (const r of INVENTORY) expect(r.cls === 'admin').toBe(r.path.startsWith('/api/admin/'));
    for (const r of table) {
      for (const segment of r.path.split('/').filter(Boolean)) {
        expect(segment).not.toMatch(/^(?:test|debug|diag|dev|reset|seed|dump)$/i);
        expect(segment).not.toContain('__');
      }
    }
  });

  for (const mode of ['local', 'published']) {
    test(`${mode}: each path answers 405 with an Allow list equal to the inventory methods`, async () => {
      const byPath = new Map();
      for (const r of inMode(mode)) byPath.set(r.path, [...(byPath.get(r.path) || []), r.method]);
      for (const [path, methods] of byPath) {
        const res = await call(mode, 'DELETE', fill(path));
        expect(res.status).toBe(405);
        expect(res.headers.get('allow').split(', ').sort()).toEqual([...methods].sort());
      }
      if (mode === 'published') expect((await call(mode, 'POST', '/api/setup', { body: {} })).status).toBe(404);
    });

    test(`${mode}: public routes never ask for a session; JSON_Routes refuse text/plain without one`, async () => {
      for (const r of inMode(mode).filter(x => x.cls === 'public')) {
        const opts = { client: freshClient('inv'), ...(r.method === 'GET' ? {} : { body: {} }) };
        const res = await call(mode, r.method, fill(r.path), opts);
        expect(res.status).not.toBe(401);
      }
      for (const r of inMode(mode).filter(x => x.json)) {
        const res = await call(mode, r.method, fill(r.path), { rawBody: '{}', type: 'text/plain', client: freshClient('json') });
        // Closed registration answers 403 first in Published_Mode (PBN 10.2); every other JSON_Route says 415.
        const expected = mode === 'published' && r.path === '/api/register' ? 403 : 415;
        expect([r.method, r.path, res.status]).toEqual([r.method, r.path, expected]);
      }
    });
  }
});

describe('properties', () => {
  // Feature: security-hardening, Property 1: Every unusable session is rejected on every protected route
  test('Property 1: every unusable session is rejected on every protected route', async () => {
    const hex = [...'0123456789abcdef'];
    const hexStr = (minLength, maxLength) => fc.string({ unit: fc.constantFrom(...hex), minLength, maxLength });
    const memberExpiry = sessionRow(tokens.member).expires_at;
    const cookieArb = fc.oneof(
      fc.constant({ kind: 'none' }),
      fc.constant({ kind: 'empty', value: '' }),
      hexStr(0, 100).filter(s => s.length !== 64).map(value => ({ kind: 'length', value })),
      fc.tuple(hexStr(63, 63), fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZghijklmnopqrstuvwxyz-_'), fc.nat(63))
        .map(([s, c, i]) => ({ kind: 'nonhex', value: s.slice(0, i) + c + s.slice(i) })),
      hexStr(64, 64).map(value => ({ kind: 'unknown', value })),
      fc.nat(30 * DAY).map(offset => ({ kind: 'expired', offset })),
      fc.constant({ kind: 'deleted' })
    );
    await fc.assert(fc.asyncProperty(fc.constantFrom('local', 'published'), fc.constantFrom(...PROTECTED), cookieArb, async (mode, route, c) => {
      let cookie;
      if (c.kind === 'expired') cookie = `ggc_session=${tokens.member}`;
      else if (c.kind === 'deleted') cookie = `ggc_session=${tokens['ghost-user']}`;
      else if (c.kind !== 'none') cookie = `ggc_session=${c.value}`;
      const saved = nowMs;
      if (c.kind === 'expired') nowMs = memberExpiry + c.offset; // expires_at equal to now counts as expired (Req 1.3)
      try {
        const before = snapshot();
        const res = await call(mode, route.method, fill(route.path), { cookie, ...(route.method === 'GET' ? {} : { body: {} }), client: 'p1' });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: '請先登入。' });
        expect(res.headers.get('set-cookie')).toBeNull();
        expect(snapshot()).toEqual(before);
      } finally { nowMs = saved; }
    }), { numRuns: 150 });
  }, 60000);

  // Feature: security-hardening, Property 3: Password length rule is exact
  test('Property 3: password length rule is exact', () => {
    const arb = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 140 }),
      fc.string({ unit: fc.constantFrom('a', 'é', '中', '😀', '𝒜', ' '), minLength: 9, maxLength: 131 }),
      fc.anything().filter(v => typeof v !== 'string')
    );
    fc.assert(fc.property(arb, value => {
      const ok = typeof value === 'string' && [...value].length >= 12 && [...value].length <= 128;
      let error = null;
      try { expect(validatePassword(value)).toBe(value); } catch (e) { error = e; }
      if (ok) { expect(error).toBeNull(); return; }
      expect(error).toBeInstanceOf(HttpError);
      expect(error.status).toBe(400);
      expect(error.message).toBe(typeof value === 'string' ? '密碼需為 12–128 個字元。' : '請輸入密碼。');
    }), { numRuns: 1000 });
  });

  // Feature: security-hardening, Property 4: Password hashing round trip with unique salts
  test('Property 4: password hashing round trip with unique salts', async () => {
    const pw = fc.string({ unit: 'binary', minLength: 12, maxLength: 64 });
    await fc.assert(fc.asyncProperty(pw, pw, fc.boolean(), async (p, other, same) => {
      const q = same ? p : other;
      const [h1, h2] = await Promise.all([hashPassword(p), hashPassword(p)]);
      for (const h of [h1, h2]) {
        const m = h.match(/^scrypt\$(\d+)\$8\$1\$([A-Za-z0-9+/]+=*)\$([A-Za-z0-9+/]+=*)$/);
        expect(m).not.toBeNull();
        const N = Number(m[1]);
        expect(N).toBeGreaterThanOrEqual(16384);
        expect(N & (N - 1)).toBe(0);
        expect(Buffer.from(m[2], 'base64').length).toBe(16);
        expect(Buffer.from(m[3], 'base64').length).toBe(64);
      }
      expect(h1.split('$')[4]).not.toBe(h2.split('$')[4]);
      const [okSame, okOther] = await Promise.all([verifyPassword(p, h1), verifyPassword(q, h1)]);
      expect(okSame).toBe(true);
      expect(okOther).toBe(p === q);
    }), { numRuns: 100 });
  }, 120000);

  // Feature: security-hardening, Property 5: Malformed stored hashes fail closed
  test('Property 5: malformed stored hashes fail closed', async () => {
    const b64 = n => fc.uint8Array({ minLength: n, maxLength: n }).map(b => Buffer.from(b).toString('base64'));
    const part = fc.string({ unit: fc.constantFrom('a', '1', '=', '+', '/', 'Z'), maxLength: 12 });
    const arb = fc.oneof(
      fc.array(part, { maxLength: 10 }).filter(a => a.length !== 6).map(a => a.join('$')),
      fc.tuple(fc.string({ maxLength: 10 }).filter(s => s !== 'scrypt' && !s.includes('$')), b64(16), b64(64)).map(([p, s, h]) => `${p}$16384$8$1$${s}$${h}`),
      fc.tuple(fc.nat(2), fc.constantFrom('1.5', 'abc', '1e400', 'NaN', 'Infinity', '-', '16384x', '9007199254740993'), b64(16), b64(64))
        .map(([i, bad, s, h]) => { const params = ['16384', '8', '1']; params[i] = bad; return `scrypt$${params.join('$')}$${s}$${h}`; }),
      fc.tuple(fc.constantFrom('0', '-1', '1', '3', '1000', '16383', String(2 ** 40)), b64(16), b64(64)).map(([N, s, h]) => `scrypt$${N}$8$1$${s}$${h}`),
      fc.tuple(fc.constantFrom(['0', '1'], ['8', '0'], [String(2 ** 31), '1'], ['8', '-1']), b64(16), b64(64)).map(([[r, p], s, h]) => `scrypt$16384$${r}$${p}$${s}$${h}`),
      b64(16).map(s => `scrypt$16384$8$1$${s}$`)
    );
    await fc.assert(fc.asyncProperty(arb, fc.string({ minLength: 12, maxLength: 40 }), async (stored, password) => {
      expect(await verifyPassword(password, stored)).toBe(false);
    }), { numRuns: 300 });
  }, 60000);

  // Feature: security-hardening, Property 6: Retry-After matches the remaining window
  test('Property 6: Retry-After matches the remaining window', () => {
    const keys = ['a', 'b', 'c'];
    const op = fc.oneof(
      fc.record({ kind: fc.constant('hit'), key: fc.constantFrom(...keys), times: fc.integer({ min: 1, max: 70 }) }),
      fc.record({ kind: fc.constant('advance'), ms: fc.oneof(fc.nat(5000), fc.nat(2 * 3600000)) })
    );
    fc.assert(fc.property(fc.constantFrom(...Object.values(LIMITS)), fc.array(op, { maxLength: 40 }), (limit, ops) => {
      let now = 1_000_000;
      const limiter = new RateLimiter(() => now);
      const model = new Map();
      for (const o of ops) {
        if (o.kind === 'advance') now += o.ms;
        else for (let i = 0; i < o.times; i++) {
          limiter.hit(o.key, limit);
          let e = model.get(o.key);
          if (!e || e.reset <= now) { e = { count: 0, reset: now + limit.window }; model.set(o.key, e); }
          e.count++;
        }
        for (const key of keys) {
          const e = model.get(key);
          const blocked = !!e && e.reset > now && e.count >= limit.max;
          expect(limiter.blocked(key, limit)).toBe(blocked);
          if (!blocked) continue;
          const seconds = limiter.retryAfter(key);
          expect(seconds).toBe(Math.max(1, Math.ceil((e.reset - now) / 1000)));
          const saved = now;
          now += seconds * 1000;
          expect(limiter.blocked(key, limit)).toBe(false);
          now = saved;
        }
      }
    }), { numRuns: 300 });
  });

  // Feature: security-hardening, Property 7: Admin routes refuse Members and signed-out callers without side effects
  test('Property 7: admin routes refuse Members and signed-out callers without side effects', async () => {
    const param = fc.constantFrom(ids.member, ids.admin, ids.trip, 'unknown-id', 'a'.repeat(80), "'%20OR%201%3D1%20--", '%25', 'x%2Fy');
    const bodyArb = fc.oneof(
      fc.constant({ kind: 'none' }),
      fc.constantFrom({ receiptAiPolicy: 'off' }, { role: 'admin' }, { displayName: '新名字' }, { confirmUsername: 'member-one' },
        { expectedUserId: ids.member, confirmTitle: '山中露營', revision: 1 }, { role: 7 }, { receiptAiPolicy: 'everyone', extra: true })
        .map(value => ({ kind: 'json', value })),
      fc.object({ maxDepth: 2 }).map(value => ({ kind: 'json', value })),
      fc.constantFrom('{', 'not json', '[1,2]', '"text"', '{"role":').map(text => ({ kind: 'raw', text }))
    );
    await fc.assert(fc.asyncProperty(fc.constantFrom('local', 'published'), fc.constantFrom(...ADMIN), param, bodyArb, fc.boolean(),
      async (mode, route, p, b, asMember) => {
        const path = route.path.replace(/\{[^}]+\}/, p);
        const opts = { cookie: asMember ? `ggc_session=${tokens.member}` : undefined, client: 'p7' };
        if (route.method !== 'GET') {
          if (b.kind === 'json') opts.body = b.value;
          else if (b.kind === 'raw') opts.rawBody = b.text;
          else opts.type = 'application/json';
        }
        const before = snapshot();
        const res = await call(mode, route.method, path, opts);
        expect(res.status).toBe(asMember ? 403 : 401);
        expect(await res.json()).toEqual({ error: asMember ? '需要管理員權限。' : '請先登入。' });
        expect(res.headers.get('set-cookie')).toBeNull();
        expect(snapshot()).toEqual(before);
      }), { numRuns: 200 });
  }, 60000);
});

describe('session cookies (Req 3)', () => {
  test('login sets HttpOnly, SameSite=Strict, Path=/, Max-Age 604800, no Domain, and a matching expiry', async () => {
    for (const mode of ['local', 'published']) {
      const res = await login('login-user', PASS, { mode, client: freshClient('cookie') });
      expect(res.status).toBe(200);
      const attrs = attrsOf(res);
      const token = tokenOf(res);
      expect(token).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes as hex (Req 3.10)
      expect(attrs).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${SESSION_MAX_AGE}`]));
      expect(attrs.some(a => /^domain=/i.test(a))).toBe(false);
      expect(attrs.includes('Secure')).toBe(mode === 'published');
      const row = sessionRow(token);
      expect(Math.abs(row.created_at - nowMs)).toBeLessThanOrEqual(5000);
      expect(Math.abs(row.expires_at - (row.created_at + SESSION_MAX_AGE * 1000))).toBeLessThanOrEqual(5000);
    }
  });

  test('the raw session token is stored only as its SHA-256 hash and never in the audit log or body', async () => {
    const res = await login('login-user', PASS, { client: freshClient('raw') });
    const token = tokenOf(res);
    expect(await res.text()).not.toContain(token);
    expect(sessionRow(token)).toBeTruthy();
    expect(JSON.stringify(raw.query('SELECT * FROM audit').all())).not.toContain(token);
    const files = [dbPath, `${dbPath}-wal`].filter(existsSync).map(f => readFileSync(f).toString('latin1')).join('');
    expect(files).toContain(sha256(token));
    expect(files).not.toContain(token);
  });

  test('logout with a session deletes it and sends a cleared cookie with the same attributes', async () => {
    for (const mode of ['local', 'published']) {
      const token = tokenOf(await login('login-user', PASS, { mode, client: freshClient('out') }));
      const res = await call(mode, 'POST', '/api/logout', { cookie: `ggc_session=${token}` });
      expect(res.status).toBe(200);
      const expected = ['ggc_session=', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0', ...(mode === 'published' ? ['Secure'] : [])];
      expect(attrsOf(res)).toEqual(expected);
      expect(sessionRow(token)).toBeNull();
      expect((await call(mode, 'GET', '/api/trips', { cookie: `ggc_session=${token}` })).status).toBe(401);
    }
  });

  test('logout without a Valid_Session succeeds, clears the cookie, and deletes no other Session', async () => {
    for (const cookie of [undefined, `ggc_session=${'cd'.repeat(32)}`, 'ggc_session=garbage', `ggc_session=${tokens['ghost-user']}`]) {
      const before = snapshot().sessions.filter(s => !s.includes(sha256(tokens['ghost-user'])));
      const res = await call('local', 'POST', '/api/logout', { cookie });
      expect(res.status).toBe(200);
      expect(attrsOf(res)).toEqual(['ggc_session=', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0']);
      expect(snapshot().sessions.filter(s => !s.includes(sha256(tokens['ghost-user'])))).toEqual(before);
    }
  });
});

describe('session replacement (Req 3.8, 3.9)', () => {
  const fresh = async () => tokenOf(await login('login-user', PASS, { client: freshClient('repl') }));
  async function expectReplaced(res, incoming) {
    expect(res.status).toBe(200);
    const next = tokenOf(res);
    expect(next).toMatch(/^[0-9a-f]{64}$/);
    expect(next).not.toBe(incoming);
    expect(sessionRow(incoming)).toBeNull();
    expect(sessionRow(next)).toBeTruthy();
  }
  async function expectKept(res, incoming, status) {
    expect(res.status).toBe(status);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(sessionRow(incoming)).toBeTruthy();
  }

  test('login', async () => {
    const a = await fresh();
    await expectKept(await login('login-user', WRONG, { cookie: `ggc_session=${a}`, client: freshClient('repl') }), a, 401);
    await expectReplaced(await login('login-user', PASS, { cookie: `ggc_session=${a}`, client: freshClient('repl') }), a);
  });

  test('registration', async () => {
    const a = await fresh();
    const body = { username: 'repl-reg', displayName: '換票', password: PASS };
    await expectReplaced(await call('local', 'POST', '/api/register', { cookie: `ggc_session=${a}`, body, client: freshClient('repl') }), a);
    const b = await fresh();
    await expectKept(await call('local', 'POST', '/api/register', { cookie: `ggc_session=${b}`, body, client: freshClient('repl') }), b, 409);
  });

  test('invite registration', async () => {
    const created = await call('local', 'POST', `/api/trips/${ids.trip}/invites`, { cookie: `ggc_session=${tokens.member}`, body: { expectedUserId: ids.member } });
    expect(created.status).toBe(201);
    const { token: invite } = await created.json();
    const a = await fresh();
    const body = { username: 'repl-inv', displayName: '受邀者', password: PASS };
    await expectReplaced(await call('local', 'POST', `/api/invites/${invite}/register`, { cookie: `ggc_session=${a}`, body, client: freshClient('repl') }), a);
    const b = await fresh();
    // The invite is single-use, so a second registration through it fails.
    await expectKept(await call('local', 'POST', `/api/invites/${invite}/register`, { cookie: `ggc_session=${b}`, body: { ...body, username: 'repl-inv-two' }, client: freshClient('repl') }), b, 404);
  });

  test('setup', async () => {
    const path = join(dir, 'setup-replace.sqlite');
    const service = createAccountService({ dbPath: path, now: clock });
    try {
      const incoming = 'ef'.repeat(32);
      const bad = await call('local', 'POST', '/api/setup', { service, cookie: `ggc_session=${incoming}`, body: { username: 'first-admin', displayName: '站長', password: 'short' } });
      expect(bad.status).toBe(400);
      expect(bad.headers.get('set-cookie')).toBeNull();
      const ok = await call('local', 'POST', '/api/setup', { service, cookie: `ggc_session=${incoming}`, body: { username: 'first-admin', displayName: '站長', password: PASS } });
      expect(ok.status).toBe(200);
      expect(tokenOf(ok)).toMatch(/^[0-9a-f]{64}$/);
      expect(tokenOf(ok)).not.toBe(incoming);
    } finally { service.close(); }
  });
});

describe('password storage (Req 2)', () => {
  const FORMAT = /^scrypt\$(\d+)\$8\$1\$([A-Za-z0-9+/]+=*)\$([A-Za-z0-9+/]+=*)$/;
  function expectScrypt(hash) {
    const m = hash.match(FORMAT);
    expect(m).not.toBeNull();
    const N = Number(m[1]);
    expect(N).toBeGreaterThanOrEqual(16384);
    expect(N & (N - 1)).toBe(0);
    expect(Buffer.from(m[2], 'base64').length).toBe(16);
    expect(Buffer.from(m[3], 'base64').length).toBe(64);
  }
  const hashOf = (db, username) => db.query('SELECT password_hash FROM users WHERE username = ?').get(username).password_hash;

  test('every user creation path stores scrypt$N$8$1$salt$hash, including the Create_Admin_CLI', async () => {
    expectScrypt(hashOf(raw, 'admin-one')); // POST /api/setup
    expectScrypt(hashOf(raw, 'member-one')); // POST /api/register
    const created = await call('local', 'POST', `/api/trips/${ids.trip}/invites`, { cookie: `ggc_session=${tokens.member}`, body: { expectedUserId: ids.member } });
    const { token: invite } = await created.json();
    const reg = await call('local', 'POST', `/api/invites/${invite}/register`, { body: { username: 'fmt-invite', displayName: '格式', password: PASS }, client: freshClient('fmt') });
    expect(reg.status).toBe(200);
    expectScrypt(hashOf(raw, 'fmt-invite')); // POST /api/invites/{token}/register

    const cliDb = join(dir, 'cli.sqlite');
    const queue = answers => async () => { if (!answers.length) throw new Error('no more input'); return answers.shift(); };
    const out = [], err = [];
    const code = await runCreateAdmin({
      argv: [], env: { CAMPING_DB: cliDb }, projectRoot: dir, isTTY: true,
      prompt: queue(['cli-admin', 'CLI 管理員']), promptHidden: queue([PASS, PASS]),
      out: (...a) => out.push(a.join(' ')), err: (...a) => err.push(a.join(' '))
    });
    expect([code, err]).toEqual([0, []]);
    expect([...out, ...err].join('\n')).not.toContain(PASS);
    const cli = new Database(cliDb, { readonly: true });
    try { expectScrypt(hashOf(cli, 'cli-admin')); } finally { cli.close(); }
  });

  test('a corrupt stored hash gives the wrong-password response and later requests still work', async () => {
    for (const stored of ['', 'plain-text-password', 'scrypt$16384$8$1$c2FsdA==', 'bcrypt$16384$8$1$c2FsdA==$aGFzaA==', 'scrypt$abc$8$1$c2FsdA==$aGFzaA==', 'scrypt$3$8$1$c2FsdA==$aGFzaA==', 'scrypt$16384$8$1$c2FsdA==$']) {
      raw.query('UPDATE users SET password_hash = ? WHERE username = ?').run(stored, 'corrupt-user');
      const res = await login('corrupt-user', PASS, { client: freshClient('corrupt') });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(LOGIN_FAILED);
      nowMs += LIMITS.loginUser.window; // keep the username limit out of the way
    }
    expect((await call('local', 'GET', '/api/session')).status).toBe(200);
  });

  test('a Canary_Secret password never appears in the database, WAL, audit, logs, or responses', async () => {
    const canary = `CANARY-pw-${crypto.randomUUID()}`;
    const wrongCanary = `CANARY-wrong-${crypto.randomUUID()}`;
    const forms = s => [s, Buffer.from(s).toString('base64'), Buffer.from(s).toString('hex'), Buffer.from(s).toString('hex').toUpperCase()];
    const logs = [];
    const saved = {};
    for (const name of ['log', 'error', 'warn', 'info', 'debug']) { saved[name] = console[name]; console[name] = (...a) => logs.push(a.map(String).join(' ')); }
    const seen = [];
    const keep = async res => { seen.push(res.status, JSON.stringify([...res.headers]), await res.text()); return res; };
    try {
      await keep(await call('local', 'POST', '/api/register', { body: { username: 'canary-user', displayName: '金絲雀', password: canary }, client: freshClient('canary') }));
      await keep(await login('canary-user', canary, { client: freshClient('canary') }));
      await keep(await login('canary-user', wrongCanary, { client: freshClient('canary') }));
      await keep(await login('nobody-canary', canary, { client: freshClient('canary') }));
    } finally { Object.assign(console, saved); }
    expect(seen.filter(x => typeof x === 'number')).toEqual([200, 200, 401, 401]);
    const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(existsSync).map(f => readFileSync(f).toString('latin1')).join('');
    const audit = JSON.stringify(raw.query('SELECT * FROM audit').all());
    for (const secret of [canary, wrongCanary]) {
      for (const form of forms(secret)) {
        expect(files.includes(form)).toBe(false);
        expect(audit.includes(form)).toBe(false);
        expect(logs.join('\n').includes(form)).toBe(false);
        expect(seen.join('\n').includes(form)).toBe(false);
      }
    }
  });
});

describe('login and registration limits (Req 4)', () => {
  test('loginUser: 5 counted failures lock the username for any client and any password, with Retry-After', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await login('locked-user', i % 2 ? '' : WRONG, { client: freshClient('lu') }); // empty passwords count too (Req 4.10)
      expect(res.status).toBe(401);
    }
    const start = nowMs;
    const blocked = await login('  LOCKED-user ', PASS, { client: freshClient('lu') }); // trimmed and lowercased
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe(String(LIMITS.loginUser.window / 1000));
    expect(blocked.headers.get('set-cookie')).toBeNull();
    nowMs = start + 100500;
    expect((await login('locked-user', PASS, { client: freshClient('lu') })).headers.get('retry-after')).toBe('800');
    nowMs = start + LIMITS.loginUser.window;
    expect((await login('locked-user', PASS, { client: freshClient('lu') })).status).toBe(200);
  }, 20000);

  test('loginClient: 30 counted failures lock the Client_Address for every username, with Retry-After', async () => {
    const client = freshClient('lc');
    for (let i = 0; i < 30; i++) expect((await login(`nobody-lc-${i}`, WRONG, { client })).status).toBe(401);
    const blocked = await login('login-user', PASS, { client });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe(String(LIMITS.loginClient.window / 1000));
    expect((await login('login-user', PASS, { client: freshClient('lc') })).status).toBe(200);
  }, 30000);

  test('register: 20 attempts per Client_Address across both registration routes, with Retry-After', async () => {
    const client = freshClient('reg');
    // text/plain attempts are rejected with 415 but still count toward the bucket (Req 4.3, 10.3).
    for (let i = 0; i < 20; i++) expect((await call('local', 'POST', '/api/register', { rawBody: '{}', type: 'text/plain', client })).status).toBe(415);
    for (const path of ['/api/register', `/api/invites/${'ab'.repeat(32)}/register`]) {
      const res = await call('local', 'POST', path, { body: { username: 'too-many', displayName: 'x', password: PASS }, client });
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe(String(LIMITS.register.window / 1000));
    }
    nowMs += 1;
    expect((await call('local', 'POST', '/api/register', { body: {}, client })).headers.get('retry-after')).toBe('3600');
  });

  test('invitePreview: 60 lookups per Client_Address, with Retry-After', async () => {
    const client = freshClient('prev');
    for (let i = 0; i < 60; i++) expect((await call('local', 'GET', `/api/invites/${'ab'.repeat(32)}/preview`, { client })).status).toBe(404);
    const res = await call('local', 'GET', `/api/invites/${'ab'.repeat(32)}/preview`, { client });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe(String(LIMITS.invitePreview.window / 1000));
  });

  test('a successful login resets the username count and leaves the client count (Req 4.9)', async () => {
    const client = freshClient('reset');
    for (let i = 0; i < 4; i++) expect((await login('login-user', WRONG, { client })).status).toBe(401);
    expect((await login('login-user', PASS, { client })).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login('login-user', WRONG, { client })).status).toBe(401);
    // 8 username failures without the reset would block here; the client has 8 of 30.
    expect((await login('login-user', PASS, { client })).status).toBe(200);
  }, 20000);

  test('unknown and deleted users run one dummy scrypt; blocked logins run none and count nothing', async () => {
    await login('nobody-warm', WRONG, { client: freshClient('t') }); // creates the dummy hash
    const known = [], unknown = [], deleted = [], blocked = [];
    for (let i = 0; i < 3; i++) {
      const k = await timed(() => login('timing-user', WRONG, { client: freshClient('t') }));
      const u = await timed(() => login(`nobody-timing-${i}`, WRONG, { client: freshClient('t') }));
      const d = await timed(() => login('ghost-user', PASS, { client: freshClient('t') }));
      for (const r of [k, u, d]) { expect(r.res.status).toBe(401); expect(await r.res.json()).toEqual(LOGIN_FAILED); }
      known.push(k.ms); unknown.push(u.ms); deleted.push(d.ms);
    }
    expect((await login('timing-user', PASS, { client: freshClient('t') })).status).toBe(200);
    const client = freshClient('blk');
    for (let i = 0; i < 5; i++) expect((await login('blocked-name', WRONG, { client })).status).toBe(401);
    for (let i = 0; i < 30; i++) {
      const b = await timed(() => login('blocked-name', PASS, { client }));
      expect(b.res.status).toBe(429);
      expect(b.res.headers.get('set-cookie')).toBeNull();
      blocked.push(b.ms);
    }
    // 30 blocked attempts did not add to the client count (5 of 30), so this login from the same client works.
    expect((await login('login-user', PASS, { client })).status).toBe(200);
    expect(median(unknown)).toBeGreaterThanOrEqual(median(known) * 0.5);
    expect(median(deleted)).toBeGreaterThanOrEqual(median(known) * 0.5);
    expect(median(blocked)).toBeLessThan(median(known) * 0.25);
  }, 30000);
});

describe('admin routes (Req 5)', () => {
  const adminBody = { 'PATCH /api/admin/users/{userId}': {}, 'POST /api/admin/users/{userId}/delete': {}, 'POST /api/admin/trips/{tripId}/delete': null, 'PATCH /api/admin/settings': { receiptAiPolicy: 'all' } };

  test('matrix: Admin gets through, Member gets 403, no session gets 401, and refusals change nothing', async () => {
    for (const mode of ['local', 'published']) {
      for (const route of ADMIN) {
        // Unknown target IDs keep the Admin calls from changing accounts or trips.
        const path = route.path.replace(/\{[^}]+\}/, 'unknown-id');
        const key = `${route.method} ${route.path}`;
        const body = route.method === 'GET' ? undefined : (adminBody[key] ?? { expectedUserId: ids.admin });
        for (const [who, cookie, status] of [['member', tokens.member, 403], ['none', undefined, 401]]) {
          const before = snapshot();
          const res = await call(mode, route.method, path, { cookie: cookie && `ggc_session=${cookie}`, body });
          expect([who, key, res.status]).toEqual([who, key, status]);
          expect(snapshot()).toEqual(before);
        }
        const res = await call(mode, route.method, path, { cookie: `ggc_session=${tokens.admin}`, body });
        expect([key, [401, 403].includes(res.status)]).toEqual([key, false]);
      }
    }
  });

  test('a demotion applies to the next admin request of the demoted account', async () => {
    const two = `ggc_session=${tokens['member-two']}`;
    const admin = `ggc_session=${tokens.admin}`;
    const patch = role => call('local', 'PATCH', `/api/admin/users/${ids['member-two']}`, { cookie: admin, body: { role } });
    expect((await call('local', 'GET', '/api/admin/users', { cookie: two })).status).toBe(403);
    expect((await patch('admin')).status).toBe(200);
    expect((await call('local', 'GET', '/api/admin/users', { cookie: two })).status).toBe(200);
    expect((await patch('member')).status).toBe(200);
    for (const [method, path, body] of [['GET', '/api/admin/users'], ['GET', '/api/admin/settings'], ['PATCH', '/api/admin/settings', { receiptAiPolicy: 'off' }]]) {
      expect((await call('local', method, path, { cookie: two, body })).status).toBe(403);
    }
  });
});
