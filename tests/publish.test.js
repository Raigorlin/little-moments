// Published_Mode examples: requests arrive the way nginx forwards them (peer 127.0.0.1,
// Host www.our-littlemoments.com, X-Forwarded-For set) and go through createHttpHandler.
import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import fc from 'fast-check';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAccountService, RateLimiter } from '../server/accounts.js';
import { createHttpHandler } from '../server/http.js';
import { LOCAL_DEFAULTS, parseDeploymentConfig } from '../server/deploy-config.js';
import { AI_IMAGE_LIMIT } from '../server/receipt-ai.js';

const DIST = resolve(import.meta.dir, '..', process.env.CAMPING_DIST || 'dist');
const PUBLIC = 'https://www.our-littlemoments.com';
const PROXIED_BASE = 'http://www.our-littlemoments.com';
const LOCAL_BASE = 'http://127.0.0.1:5173';
const PASS = 'correct horse battery';
const PUBLISHED = parseDeploymentConfig({ CAMPING_PUBLISHED: '1', CAMPING_PUBLIC_ORIGIN: PUBLIC });
const CLOSED_LOCAL = parseDeploymentConfig({ CAMPING_REGISTRATION: 'closed' });
const META = '<meta name="camping-deployment" content="published">';
// The nginx process on the same host: every TCP peer is loopback.
const nginxPeer = { requestIP: () => ({ address: '127.0.0.1' }) };

let dir, dbPath;
const opened = [];

function open(config, path = dbPath) {
  const accounts = createAccountService({ dbPath: path, deployment: config });
  opened.push(accounts);
  return createHttpHandler({ root: DIST, accounts, config });
}

/** A request as nginx forwards it: plain http to 127.0.0.1, public Host, X-Forwarded-For set. */
function proxied(handler, method, path, { xff = '203.0.113.7', origin = PUBLIC, body, raw, cookie } = {}) {
  const headers = { 'x-forwarded-for': xff, 'x-forwarded-proto': 'https' };
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return handler(new Request(PROXIED_BASE + path, { method, headers, body: payload }), nginxPeer);
}

/** A Direct_Local_Request: loopback peer, loopback Host, no forwarding headers. */
function direct(handler, method, path, { origin = LOCAL_BASE, body, cookie } = {}) {
  const headers = {};
  if (method !== 'GET' && method !== 'HEAD' && origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return handler(new Request(LOCAL_BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), nginxPeer);
}

const login = (handler, username, opts = {}) => proxied(handler, 'POST', '/api/login', { ...opts, body: { username, password: opts.password ?? PASS } });

beforeAll(async () => {
  if (!(await Bun.file(join(DIST, 'index.html')).exists())) throw new Error('dist is missing; run `bun run build` first.');
  // Published_Mode has no web setup, so seed the file database through a Local_Mode service first.
  dir = mkdtempSync(join(tmpdir(), 'camping-publish-'));
  dbPath = join(dir, 'accounts.sqlite');
  const seedAccounts = createAccountService({ dbPath, deployment: LOCAL_DEFAULTS });
  const seedHandler = createHttpHandler({ root: DIST, accounts: seedAccounts });
  try {
    const admin = await direct(seedHandler, 'POST', '/api/setup', { body: { username: 'admin-one', displayName: '管理員', password: PASS } });
    if (admin.status !== 200) throw new Error(`seed setup failed: ${admin.status} ${await admin.text()}`);
    const member = await direct(seedHandler, 'POST', '/api/register', { body: { username: 'member-one', displayName: '旅伴', password: PASS } });
    if (member.status !== 200) throw new Error(`seed register failed: ${member.status} ${await member.text()}`);
  } finally {
    seedAccounts.close();
  }
});

afterEach(() => { while (opened.length) opened.pop().close(); });
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('proxied login in Published_Mode', () => {
  test('Origin equal to the Public_Origin logs in and gets a Secure session cookie', async () => {
    const handler = open(PUBLISHED);
    const res = await login(handler, 'admin-one');
    expect(res.status).toBe(200);
    expect((await res.json()).user.username).toBe('admin-one');
    const cookie = res.headers.get('set-cookie') || '';
    const attrs = cookie.split(';').map(part => part.trim());
    expect(attrs[0]).toMatch(/^ggc_session=[^;]+$/);
    expect(attrs).toContain('Secure');
    expect(attrs).toContain('HttpOnly');
    expect(attrs).toContain('SameSite=Strict');
    expect(attrs).toContain('Path=/');
    expect(attrs.some(a => /^Max-Age=\d+$/.test(a) && Number(a.slice(8)) > 0)).toBe(true);
    const session = await proxied(handler, 'GET', '/api/session', { cookie: attrs[0] });
    expect((await session.json()).user.username).toBe('admin-one');
  });

  test('a forwarded request carrying the request URL origin instead of the Public_Origin is refused', async () => {
    const handler = open(PUBLISHED);
    for (const origin of [PROXIED_BASE, 'https://attacker.example', null]) {
      const res = await login(handler, 'admin-one', { origin });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('請求來源不被允許。');
    }
  });

  test('Local_Mode login over plain http keeps the cookie without Secure', async () => {
    const handler = open(LOCAL_DEFAULTS);
    const res = await direct(handler, 'POST', '/api/login', { body: { username: 'admin-one', password: PASS } });
    expect(res.status).toBe(200);
    const attrs = (res.headers.get('set-cookie') || '').split(';').map(part => part.trim());
    expect(attrs).not.toContain('Secure');
    expect(attrs).toContain('HttpOnly');
    expect(attrs).toContain('SameSite=Strict');
    expect(attrs).toContain('Path=/');
  });
});

describe('web first-admin setup is gone in Published_Mode', () => {
  const body = { username: 'intruder', displayName: '入侵者', password: PASS };

  test('/setup and /setup/ return 404 for proxied and direct-local requests', async () => {
    // An empty database is where web setup would otherwise be allowed.
    const handler = open(PUBLISHED, ':memory:');
    for (const path of ['/setup', '/setup/']) {
      for (const res of [await proxied(handler, 'GET', path), await direct(handler, 'GET', path)]) {
        expect(res.status).toBe(404);
        expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
        expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      }
    }
  });

  test('POST /api/setup returns the API 404 for proxied, direct-local, and bad-Origin requests', async () => {
    const handler = open(PUBLISHED, ':memory:');
    const attempts = [
      await proxied(handler, 'POST', '/api/setup', { body }),
      await proxied(handler, 'POST', '/api/setup', { body, origin: 'https://attacker.example' }),
      await direct(handler, 'POST', '/api/setup', { body }),
      await direct(handler, 'POST', '/api/setup', { body, origin: 'https://attacker.example' })
    ];
    for (const res of attempts) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: '找不到這個 API。' });
    }
    const session = await direct(handler, 'GET', '/api/session');
    expect((await session.json()).needsSetup).toBe(true);
  });

  test('Local_Mode still serves /setup and accepts POST /api/setup from loopback', async () => {
    const handler = open(LOCAL_DEFAULTS, ':memory:');
    const page = await direct(handler, 'GET', '/setup');
    expect(page.status).toBe(200);
    expect((await direct(handler, 'POST', '/api/setup', { body })).status).toBe(200);
  });
});

describe('one dist serves both modes', () => {
  const appChunk = () => {
    const sw = readFileSync(join(DIST, 'sw.js'), 'utf8');
    const chunk = /"(\/chunks\/app-[a-zA-Z0-9_.-]+\.js)"/.exec(sw)?.[1];
    if (!chunk) throw new Error('sw.js lists no /chunks/app-*.js asset');
    return chunk;
  };

  test('/demo and /demo/ return 404 in Published_Mode and 200 in Local_Mode', async () => {
    const published = open(PUBLISHED);
    const local = open(LOCAL_DEFAULTS);
    for (const path of ['/demo', '/demo/']) {
      const res = await proxied(published, 'GET', path);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect((await direct(published, 'GET', path)).status).toBe(404);
    }
    const res = await direct(local, 'GET', '/demo/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="app"');
  });

  test('the shared app chunk and entry script stay available in Published_Mode', async () => {
    // The build emits the planner code as /chunks/app-<hash>.js; there is no top-level /app.js in dist.
    const handler = open(PUBLISHED);
    for (const path of ['/entry.js', appChunk()]) {
      const res = await proxied(handler, 'GET', path);
      expect(res.status).toBe(200);
      expect((await res.text()).length).toBeGreaterThan(0);
    }
  });

  test('the deployment meta tag is injected only in Published_Mode', async () => {
    const published = open(PUBLISHED);
    const local = open(LOCAL_DEFAULTS);
    for (const path of ['/', '/login', '/index.html']) {
      const res = await proxied(published, 'GET', path);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      const html = await res.text();
      expect(html.split(META).length - 1).toBe(1);
      expect(html.indexOf(META)).toBeLessThan(html.indexOf('</head>'));
      const plain = await (await direct(local, 'GET', path)).text();
      expect(plain).not.toContain('camping-deployment');
    }
  });

  test('sw.js gets const PUBLISHED=true; only in Published_Mode', async () => {
    const localSw = await (await direct(open(LOCAL_DEFAULTS), 'GET', '/sw.js')).text();
    const res = await proxied(open(PUBLISHED), 'GET', '/sw.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    const publishedSw = await res.text();
    if (localSw.includes('const PUBLISHED=false;')) {
      expect(publishedSw).toContain('const PUBLISHED=true;');
      expect(publishedSw).not.toContain('const PUBLISHED=false;');
      expect(localSw).not.toContain('const PUBLISHED=true;');
    } else {
      // TODO(publish-behind-nginx 10.1/10.2): the build does not emit the flag yet; task 10.2 asserts the rewrite.
      expect(publishedSw).toBe(localSw);
    }
  });
});

describe('registration policy', () => {
  const body = { username: 'new-person', displayName: '新朋友', password: PASS };
  const CLOSED_MESSAGE = '目前不開放公開註冊，請使用旅行邀請連結建立帳號。';

  test('Local_Mode open registration creates an account', async () => {
    const handler = open(LOCAL_DEFAULTS, ':memory:');
    expect((await direct(handler, 'POST', '/api/setup', { body: { username: 'admin-one', displayName: '管理員', password: PASS } })).status).toBe(200);
    const res = await direct(handler, 'POST', '/api/register', { body });
    expect(res.status).toBe(200);
    expect((await res.json()).user.username).toBe('new-person');
  });

  test('Local_Mode with CAMPING_REGISTRATION=closed refuses registration', async () => {
    const handler = open(CLOSED_LOCAL);
    const res = await direct(handler, 'POST', '/api/register', { body });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: CLOSED_MESSAGE });
    expect((await direct(handler, 'POST', '/api/login', { body: { username: 'new-person', password: PASS } })).status).toBe(401);
  });

  test('Published_Mode refuses valid, malformed, and empty bodies without spending the register bucket', async () => {
    const handler = open(PUBLISHED);
    const keys = [];
    const { hit, blocked } = RateLimiter.prototype;
    RateLimiter.prototype.hit = function (key, limit) { keys.push(key); return hit.call(this, key, limit); };
    RateLimiter.prototype.blocked = function (key, limit) { keys.push(key); return blocked.call(this, key, limit); };
    try {
      // 25 attempts exceed the register limit of 20; each must still be the closed 403, never 429.
      for (let i = 0; i < 25; i++) {
        const kind = i % 3;
        const res = kind === 0 ? await proxied(handler, 'POST', '/api/register', { body })
          : kind === 1 ? await proxied(handler, 'POST', '/api/register', { raw: '{"username":' })
          : await proxied(handler, 'POST', '/api/register');
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: CLOSED_MESSAGE });
      }
    } finally {
      RateLimiter.prototype.hit = hit;
      RateLimiter.prototype.blocked = blocked;
    }
    expect(keys.filter(key => key.startsWith('register:'))).toEqual([]);
    expect((await login(handler, 'new-person')).status).toBe(401);
  });

  test('GET /api/session reports the flags for each mode', async () => {
    const flags = async res => { const b = await res.json(); return { needsSetup: b.needsSetup, webSetup: b.webSetup, registrationOpen: b.registrationOpen, inviteRegistration: b.inviteRegistration }; };
    const local = open(LOCAL_DEFAULTS, ':memory:');
    expect(await flags(await direct(local, 'GET', '/api/session'))).toEqual({ needsSetup: true, webSetup: true, registrationOpen: true, inviteRegistration: false });
    expect(await flags(await direct(open(LOCAL_DEFAULTS), 'GET', '/api/session'))).toEqual({ needsSetup: false, webSetup: true, registrationOpen: true, inviteRegistration: true });
    expect(await flags(await direct(open(CLOSED_LOCAL), 'GET', '/api/session'))).toEqual({ needsSetup: false, webSetup: true, registrationOpen: false, inviteRegistration: true });
    expect(await flags(await proxied(open(PUBLISHED), 'GET', '/api/session'))).toEqual({ needsSetup: false, webSetup: false, registrationOpen: false, inviteRegistration: true });
    expect(await flags(await proxied(open(PUBLISHED, ':memory:'), 'GET', '/api/session'))).toEqual({ needsSetup: true, webSetup: false, registrationOpen: false, inviteRegistration: false });
  });
});

describe('per-client rate limiting behind nginx', () => {
  test('two proxied clients with different X-Forwarded-For use separate loginClient buckets', async () => {
    const handler = open(PUBLISHED);
    const a = '203.0.113.10', b = '198.51.100.20';
    // loginClient allows 30 failures per client; distinct usernames keep the per-username limit out of the way.
    for (let i = 0; i < 30; i++) expect((await login(handler, `nobody-${i}`, { xff: a, password: 'wrong password!' })).status).toBe(401);
    const blockedA = await login(handler, 'admin-one', { xff: a });
    expect(blockedA.status).toBe(429);
    // Same nginx peer, different visitor: still below its own limit.
    expect((await login(handler, 'nobody-x', { xff: b, password: 'wrong password!' })).status).toBe(401);
    expect((await login(handler, 'admin-one', { xff: b })).status).toBe(200);
    // A spoofed entry prepended by visitor A does not move it into another bucket.
    expect((await login(handler, 'admin-one', { xff: `${b}, ${a}` })).status).toBe(429);
  });
});

describe('origin check properties', () => {
  // Header values are trimmed by Headers, so arbitrary text has no edge whitespace or control characters.
  const text = fc.string({ unit: fc.integer({ min: 0x20, max: 0x7e }).map(c => String.fromCharCode(c)), minLength: 1, maxLength: 40 })
    .filter(s => s === s.trim());
  const originFor = expected => {
    const u = new URL(expected);
    const otherScheme = u.protocol === 'https:' ? 'http:' : 'https:';
    return fc.oneof(
      fc.constant(expected),
      fc.constant(null),
      fc.constant(expected.toUpperCase()),
      fc.constant(`${expected}/`),
      fc.constant(`${otherScheme}//${u.host}`),
      fc.integer({ min: 1, max: 65535 }).map(port => `${u.protocol}//${u.hostname}:${port}`),
      text
    );
  };

  // Feature: publish-behind-nginx, Property 6: Mutating requests pass the origin check exactly when Origin equals the expected origin
  test('POST /api/logout returns 200 iff Origin equals the expected origin, else 403 請求來源不被允許。', async () => {
    const published = open(PUBLISHED);
    const local = open(LOCAL_DEFAULTS);
    const modes = [
      { name: 'published proxied', expected: PUBLIC, send: origin => proxied(published, 'POST', '/api/logout', { origin }) },
      { name: 'published direct-local', expected: LOCAL_BASE, send: origin => direct(published, 'POST', '/api/logout', { origin }) },
      { name: 'local', expected: LOCAL_BASE, send: origin => direct(local, 'POST', '/api/logout', { origin }) }
    ];
    for (const mode of modes) {
      await fc.assert(fc.asyncProperty(originFor(mode.expected), async origin => {
        const res = await mode.send(origin);
        if (origin === mode.expected) {
          expect(res.status).toBe(200);
          expect(await res.json()).toEqual({ ok: true });
        } else {
          expect(res.status).toBe(403);
          expect(await res.json()).toEqual({ error: '請求來源不被允許。' });
        }
      }), { numRuns: 150 });
    }
  });
});

describe('rate-limit isolation properties', () => {
  // Mirrors LIMITS in server/accounts.js (not exported); invitePreview is the design value for task 4.4.
  const LIMIT_TABLE = {
    loginClient: { max: 30, window: 15 * 60000 },
    register: { max: 20, window: 60 * 60000 },
    invitePreview: { max: 60, window: 15 * 60000 }
  };

  // Feature: publish-behind-nginx, Property 9: Rate-limit buckets are isolated per client address
  // invitePreview has no route yet (task 4.4); the route-level 61st-preview check belongs to tasks 4.7/4.11.
  test('RateLimiter: blocked(key) equals replaying only that key\'s hits on a fresh limiter', () => {
    const scenario = fc.constantFrom(...Object.keys(LIMIT_TABLE)).chain(name => {
      const limit = LIMIT_TABLE[name];
      return fc.uniqueArray(fc.string({ maxLength: 24 }), { minLength: 1, maxLength: 4 }).chain(keys => fc.record({
        limit: fc.constant(limit),
        keys: fc.constant(keys),
        ops: fc.array(fc.oneof(
          { weight: 30, arbitrary: fc.nat({ max: keys.length - 1 }).map(k => ({ hit: k })) },
          { weight: 1, arbitrary: fc.integer({ min: 1, max: limit.window }).map(ms => ({ advance: ms })) }
        ), { maxLength: 250 })
      }));
    });
    fc.assert(fc.property(scenario, ({ limit, keys, ops }) => {
      let now = 1_000_000;
      const shared = new RateLimiter(() => now);
      const hitsByKey = keys.map(() => []);
      for (const op of ops) {
        if (op.advance) { now += op.advance; continue; }
        const key = keys[op.hit];
        // Same order the routes use: check, then count.
        if (!shared.blocked(key, limit)) { shared.hit(key, limit); hitsByKey[op.hit].push(now); }
      }
      keys.forEach((key, i) => {
        let t = 0;
        const fresh = new RateLimiter(() => t);
        for (const at of hitsByKey[i]) { t = at; fresh.hit(key, limit); }
        t = now;
        expect(shared.blocked(key, limit)).toBe(fresh.blocked(key, limit));
      });
    }), { numRuns: 300 });
  });

  // Feature: publish-behind-nginx, Property 9: Rate-limit buckets are isolated per client address
  test('register bucket per Local_Mode client address matches a per-address model', async () => {
    const peers = ['127.0.0.1', '192.168.1.20', '10.0.0.7'];
    const from = peer => ({ requestIP: () => ({ address: peer }) });
    const scenario = fc.integer({ min: 1, max: peers.length }).chain(n =>
      fc.array(fc.nat({ max: n - 1 }), { minLength: 21, maxLength: 60 }));
    await fc.assert(fc.asyncProperty(scenario, async sequence => {
      // An empty database: the register limiter counts before the needs-setup 409, so no scrypt runs.
      const accounts = createAccountService({ dbPath: ':memory:', deployment: LOCAL_DEFAULTS });
      const handler = createHttpHandler({ root: DIST, accounts, config: LOCAL_DEFAULTS });
      try {
        const counts = peers.map(() => 0);
        for (const i of sequence) {
          const res = await handler(new Request(LOCAL_BASE + '/api/register', { method: 'POST', headers: { origin: LOCAL_BASE } }), from(peers[i]));
          if (counts[i] >= LIMIT_TABLE.register.max) {
            expect(res.status).toBe(429);
          } else {
            expect(res.status).toBe(409);
            counts[i]++;
          }
        }
      } finally {
        accounts.close();
      }
    }), { numRuns: 100 });
  });

  // Feature: publish-behind-nginx, Property 9: Rate-limit buckets are isolated per client address
  test('a proxied client at the loginClient limit never blocks other X-Forwarded-For addresses', async () => {
    const handler = open(PUBLISHED);
    const blockedClient = '203.0.113.99';
    let n = 0;
    // Every failed login runs one scrypt verify, so exhaust one bucket once and spend one verify per run.
    for (let i = 0; i < LIMIT_TABLE.loginClient.max; i++) {
      expect((await login(handler, `pbt-nobody-${n++}`, { xff: blockedClient, password: 'wrong password!' })).status).toBe(401);
    }
    const counts = new Map();
    await fc.assert(fc.asyncProperty(fc.ipV4().filter(ip => ip !== blockedClient && !ip.startsWith('127.')), async other => {
      expect((await login(handler, `pbt-nobody-${n++}`, { xff: blockedClient, password: 'wrong password!' })).status).toBe(429);
      const before = counts.get(other) ?? 0;
      const res = await login(handler, `pbt-nobody-${n++}`, { xff: other, password: 'wrong password!' });
      expect(res.status).toBe(before >= LIMIT_TABLE.loginClient.max ? 429 : 401);
      if (before < LIMIT_TABLE.loginClient.max) counts.set(other, before + 1);
    }), { numRuns: 100 });
  }, 120000);
});

describe('invite registration', () => {
  const INVALID = '邀請連結無效或已過期。';
  const TAKEN = '這個帳號名稱已被使用。';
  const LIMITED = '註冊嘗試太多次，請稍後再試。';
  const NAME_TAKEN = '這個名字已在小隊中。請加上姓氏或使用不同暱稱，不會直接切換成同名旅伴。';
  const INVITE_TTL_MS = 7 * 86400000;
  const sha = value => createHash('sha256').update(value).digest('hex');
  let inviteDir, invitePath, seq = 0;
  const unique = () => ++seq;

  // A separate seeded file database so these tests can read invites/users rows and move the clock freely.
  beforeAll(async () => {
    inviteDir = mkdtempSync(join(tmpdir(), 'camping-invite-register-'));
    invitePath = join(inviteDir, 'accounts.sqlite');
    const seed = createAccountService({ dbPath: invitePath, deployment: LOCAL_DEFAULTS });
    const seedHandler = createHttpHandler({ root: DIST, accounts: seed });
    try {
      for (const [path, body] of [
        ['/api/setup', { username: 'admin-one', displayName: '管理員', password: PASS }],
        ['/api/register', { username: 'member-one', displayName: '旅伴', password: PASS }]
      ]) {
        const res = await direct(seedHandler, 'POST', path, { body });
        if (res.status !== 200) throw new Error(`seed ${path} failed: ${res.status} ${await res.text()}`);
      }
    } finally {
      seed.close();
    }
  });
  afterAll(() => { if (inviteDir) rmSync(inviteDir, { recursive: true, force: true }); });

  function openAt(config, { path = invitePath, now } = {}) {
    const accounts = createAccountService({ dbPath: path, deployment: config, now });
    opened.push(accounts);
    return createHttpHandler({ root: DIST, accounts, config });
  }
  const viaProxy = handler => (method, path, opts) => proxied(handler, method, path, opts);
  const viaLocal = handler => (method, path, opts) => direct(handler, method, path, opts);
  const cookieOf = res => (res.headers.get('set-cookie') || '').split(';')[0];

  async function ownerLogin(send) {
    const res = await send('POST', '/api/login', { body: { username: 'admin-one', password: PASS } });
    expect(res.status).toBe(200);
    return { cookie: cookieOf(res), owner: (await res.json()).user };
  }
  async function newTrip(send, { cookie, owner }) {
    const res = await send('POST', '/api/trips', { cookie, body: { title: '邀請測試', startDate: '2025-07-01', endDate: '2025-07-02', expectedUserId: owner.id } });
    expect(res.status).toBe(201);
    return (await res.json()).trip.id;
  }
  async function createInvite(send, { cookie, owner }, tripId) {
    const res = await send('POST', `/api/trips/${tripId}/invites`, { cookie, body: { expectedUserId: owner.id } });
    expect(res.status).toBe(201);
    return (await res.json()).token;
  }
  async function ownerInvite(send) {
    const session = await ownerLogin(send);
    const tripId = await newTrip(send, session);
    return { ...session, tripId, token: await createInvite(send, session, tripId) };
  }

  const regBody = (n, extra = {}) => ({ username: `invitee-${n}`, displayName: `受邀者${n}`, password: PASS, name: `受邀者${n}`, ...extra });
  const registerVia = (send, token, body, opts = {}) => send('POST', `/api/invites/${token}/register`, { ...opts, body });

  function peek(fn) {
    const db = new Database(invitePath);
    try { return fn(db); } finally { db.close(); }
  }
  const inviteRow = token => peek(db => db.query('SELECT used_at, used_by FROM invites WHERE token_hash = ?').get(sha(token)));
  const userRow = username => peek(db => db.query('SELECT id, role FROM users WHERE username = ?').get(username));
  const userCount = () => peek(db => db.query('SELECT COUNT(*) AS n FROM users').get().n);
  const memberCount = tripId => peek(db => db.query('SELECT COUNT(*) AS n FROM trip_members WHERE trip_id = ?').get(tripId).n);
  const UNUSED = { used_at: null, used_by: null };

  test('Published proxied: creates a member in the trip, consumes the link, sets a Secure cookie, and writes audits', async () => {
    const send = viaProxy(openAt(PUBLISHED));
    const { cookie: ownerCookie, tripId, token } = await ownerInvite(send);
    const body = regBody(unique(), { role: '攝影師' });
    const res = await registerVia(send, token, body);
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.tripId).toBe(tripId);
    expect(result.user).toMatchObject({ username: body.username, displayName: body.displayName, role: 'member' });
    const attrs = (res.headers.get('set-cookie') || '').split(';').map(part => part.trim());
    expect(attrs[0]).toMatch(/^ggc_session=[a-f0-9]{64}$/);
    for (const attr of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) expect(attrs).toContain(attr);

    const session = await send('GET', '/api/session', { cookie: attrs[0] });
    expect((await session.json()).user.username).toBe(body.username);
    const trip = await send('GET', `/api/trips/${tripId}`, { cookie: attrs[0] });
    expect(trip.status).toBe(200);
    const envelope = await trip.json();
    expect(envelope.trip.isMember).toBe(true);
    expect(envelope.state.people.find(p => p.id === envelope.permissions.personId)).toMatchObject({ name: body.name, role: '攝影師' });
    expect(memberCount(tripId)).toBe(2);
    expect(inviteRow(token).used_by).toBe(result.user.id);
    expect(inviteRow(token).used_at).not.toBeNull();

    const audit = await (await send('GET', '/api/admin/audit', { cookie: ownerCookie })).json();
    expect(audit.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor: body.username, action: 'register.invite', target: `user:${body.username}` }),
      expect.objectContaining({ actor: body.username, action: 'invite.join', target: `trip:${tripId}` })
    ]));
  });

  test('works under both registration policies in Local_Mode, including closed', async () => {
    for (const config of [LOCAL_DEFAULTS, CLOSED_LOCAL]) {
      const send = viaLocal(openAt(config));
      const { tripId, token } = await ownerInvite(send);
      const body = regBody(unique());
      const res = await registerVia(send, token, body);
      expect(res.status).toBe(200);
      expect((await res.json()).tripId).toBe(tripId);
      expect(res.headers.get('set-cookie')).not.toContain('Secure');
      expect(userRow(body.username).role).toBe('member');
    }
  });

  test('invalid, used, and expired tokens return 404 and create nothing', async () => {
    let now = Date.now();
    const send = viaProxy(openAt(PUBLISHED, { now: () => now }));
    const { tripId, token: used, ...session } = await ownerInvite(send);
    const expiring = await createInvite(send, session, tripId);
    expect((await registerVia(send, used, regBody(unique()))).status).toBe(200);
    const before = userCount();
    const attempt = async token => {
      const body = regBody(unique());
      const res = await registerVia(send, token, body);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: INVALID });
      expect(userRow(body.username)).toBeNull();
    };
    for (const token of ['not-a-token', 'a'.repeat(64), 'A'.repeat(64), used]) await attempt(token);
    now += INVITE_TTL_MS + 1;
    await attempt(expiring);
    expect(userCount()).toBe(before);
    expect(memberCount(tripId)).toBe(2);
    expect(inviteRow(expiring)).toEqual(UNUSED);
  });

  test('a taken username returns 409 and leaves the link unused', async () => {
    const send = viaProxy(openAt(PUBLISHED));
    const { tripId, token } = await ownerInvite(send);
    const before = userCount();
    for (const username of ['member-one', 'admin-one']) {
      const res = await registerVia(send, token, regBody(unique(), { username }));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: TAKEN });
    }
    expect(userCount()).toBe(before);
    expect(memberCount(tripId)).toBe(1);
    expect(inviteRow(token)).toEqual(UNUSED);
  });

  test('a trip name conflict returns 409 with no new user and the link still usable', async () => {
    const send = viaProxy(openAt(PUBLISHED));
    const { tripId, token } = await ownerInvite(send);
    const before = userCount();
    // The owner's participant is 管理員: once as the explicit trip name, once through the display-name default.
    const explicit = regBody(unique(), { name: '管理員' });
    const defaulted = { ...regBody(unique(), { displayName: '管理員' }), name: undefined };
    for (const body of [explicit, defaulted]) {
      const res = await registerVia(send, token, body);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: NAME_TAKEN });
      expect(userRow(body.username)).toBeNull();
    }
    expect(userCount()).toBe(before);
    expect(memberCount(tripId)).toBe(1);
    expect(inviteRow(token)).toEqual(UNUSED);
    const ok = await registerVia(send, token, regBody(unique()));
    expect(ok.status).toBe(200);
  });

  test('Local_Mode: invite registration and POST /api/register share one register bucket per Client_Address', async () => {
    const handler = openAt(LOCAL_DEFAULTS);
    const post = (path, peer, body) => handler(new Request(LOCAL_BASE + path, {
      method: 'POST',
      headers: { origin: LOCAL_BASE, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    }), { requestIP: () => ({ address: peer }) });
    // Unknown tokens fail after the limiter and validation but before hashing, so 20 attempts stay cheap.
    const unknown = 'b'.repeat(64);
    const a = '192.168.1.20', b = '10.0.0.7';
    for (let i = 0; i < 10; i++) {
      expect((await post('/api/register', a)).status).toBe(415);
      expect((await post(`/api/invites/${unknown}/register`, a, regBody(unique()))).status).toBe(404);
    }
    for (const path of ['/api/register', `/api/invites/${unknown}/register`]) {
      const res = await post(path, a, regBody(unique()));
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: LIMITED });
    }
    expect((await post(`/api/invites/${unknown}/register`, b, regBody(unique()))).status).toBe(404);
    expect((await post('/api/register', b)).status).toBe(415);
  });

  test('Published_Mode: POST /api/register does not spend the bucket; invite registration is limited per X-Forwarded-For', async () => {
    const send = viaProxy(openAt(PUBLISHED));
    const unknown = 'c'.repeat(64);
    const a = '203.0.113.40', b = '198.51.100.40';
    for (let i = 0; i < 25; i++) expect((await send('POST', '/api/register', { xff: a, body: regBody(unique()) })).status).toBe(403);
    for (let i = 0; i < 20; i++) expect((await registerVia(send, unknown, regBody(unique()), { xff: a })).status).toBe(404);
    const blocked = await registerVia(send, unknown, regBody(unique()), { xff: a });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: LIMITED });
    expect((await registerVia(send, unknown, regBody(unique()), { xff: b })).status).toBe(404);
  });

  test('a bad Origin returns 403 and leaves the link unused', async () => {
    const send = viaProxy(openAt(PUBLISHED));
    const { tripId, token } = await ownerInvite(send);
    for (const origin of ['https://attacker.example', PROXIED_BASE, null]) {
      const body = regBody(unique());
      const res = await registerVia(send, token, body, { origin });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: '請求來源不被允許。' });
      expect(userRow(body.username)).toBeNull();
    }
    const local = viaLocal(openAt(LOCAL_DEFAULTS));
    const res = await registerVia(local, token, regBody(unique()), { origin: 'https://attacker.example' });
    expect(res.status).toBe(403);
    expect(memberCount(tripId)).toBe(1);
    expect(inviteRow(token)).toEqual(UNUSED);
  });

  test('with no users in the database, invite registration returns 409', async () => {
    for (const [config, via] of [[PUBLISHED, viaProxy], [LOCAL_DEFAULTS, viaLocal]]) {
      const send = via(openAt(config, { path: ':memory:' }));
      const res = await registerVia(send, 'd'.repeat(64), regBody(unique()));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: '請先完成管理員設定。' });
    }
  });

  // Feature: publish-behind-nginx, Property 11: Invite registration is atomic
  // numRuns stays at 100: only valid, conflict, and lateInvalid attempts reach scrypt (weight 5 of 13), and at
  // most one attempt per run can succeed, so a run averages well under one hash.
  test('Property 11: new users equal 200 responses, each joins the trip, failures leave nothing, used_by marks the winner', async () => {
    let now = Date.now();
    const send = viaProxy(openAt(PUBLISHED, { now: () => now }));
    // One link that stays expired for every run.
    const expired = (await ownerInvite(send)).token;
    now += INVITE_TTL_MS + 1;
    const session = await ownerLogin(send);
    // A distinct X-Forwarded-For per attempt keeps the register limit out of the property.
    const nextIp = () => { const k = unique(); return `10.${(k >> 16) & 255}.${(k >> 8) & 255}.${k & 255}`; };

    const attempt = fc.oneof(
      { weight: 3, arbitrary: fc.constant({ kind: 'valid' }) },
      { weight: 2, arbitrary: fc.constantFrom('admin-one', 'member-one').map(username => ({ kind: 'taken', username })) },
      { weight: 1, arbitrary: fc.constant({ kind: 'conflict' }) },
      // Passes the checks before hashing, then fails in addParticipant after the user insert.
      { weight: 1, arbitrary: fc.constant({ kind: 'lateInvalid' }) },
      { weight: 3, arbitrary: fc.constantFrom({ username: 'X' }, { username: 'api' }, { password: 'short' }, { displayName: '' }, { name: 7 }, { role: false })
        .map(patch => ({ kind: 'malformed', patch })) },
      { weight: 3, arbitrary: fc.constantFrom('unknown', 'expired', 'garbage').map(which => ({ kind: 'badToken', which })) }
    );

    await fc.assert(fc.asyncProperty(fc.array(attempt, { minLength: 1, maxLength: 3 }), async attempts => {
      const tripId = await newTrip(send, session);
      const token = await createInvite(send, session, tripId);
      const usersBefore = userCount();
      const tried = [];
      let winner = null;
      for (const a of attempts) {
        const n = unique();
        const body = regBody(n);
        let target = token;
        if (a.kind === 'taken') body.username = a.username;
        if (a.kind === 'conflict') body.name = '管理員';
        if (a.kind === 'lateInvalid') body.name = 'x'.repeat(31);
        if (a.kind === 'malformed') Object.assign(body, a.patch);
        if (a.kind === 'badToken') target = a.which === 'expired' ? expired : a.which === 'unknown' ? sha(`unknown-${n}`) : 'not-a-token';
        if (a.kind !== 'taken') tried.push(body.username);

        const used = winner !== null;
        const expected = a.kind === 'malformed' ? 400 : a.kind === 'badToken' || used ? 404
          : { valid: 200, taken: 409, conflict: 409, lateInvalid: 400 }[a.kind];
        const res = await registerVia(send, target, body, { xff: nextIp() });
        expect(res.status).toBe(expected);
        const result = await res.json();
        if (expected === 200) {
          expect(result.tripId).toBe(tripId);
          expect(result.user.username).toBe(body.username);
          winner = result.user;
        }
      }

      peek(db => {
        expect(db.query('SELECT COUNT(*) AS n FROM users').get().n).toBe(usersBefore + (winner ? 1 : 0));
        for (const username of tried) {
          const row = db.query('SELECT id FROM users WHERE username = ?').get(username);
          expect(row?.id ?? null).toBe(username === winner?.username ? winner.id : null);
        }
        const members = db.query('SELECT user_id FROM trip_members WHERE trip_id = ?').all(tripId).map(r => r.user_id);
        expect(members.length).toBe(winner ? 2 : 1);
        if (winner) expect(members).toContain(winner.id);
        expect(db.query('SELECT people_count FROM trips WHERE id = ?').get(tripId).people_count).toBe(members.length);
        const row = db.query('SELECT used_at, used_by FROM invites WHERE token_hash = ?').get(sha(token));
        expect(row.used_by).toBe(winner ? winner.id : null);
        expect(row.used_at === null).toBe(!winner);
        expect(db.query('SELECT used_by FROM invites WHERE token_hash = ?').get(sha(expired)).used_by).toBeNull();
      });
    }), { numRuns: 100 });
  }, 120000);
});

describe('receipt AI policy', () => {
  const ADMINS_ONLY = '目前只有管理員可以使用 AI 辨識。';
  const TURNED_OFF = 'AI 辨識已由管理員關閉。';
  const UNCONFIGURED = 'AI 辨識尚未設定，請聯絡管理員。';
  const INVALID_POLICY = '收據 AI 政策必須是 all、admins 或 off。';
  const OPTIONS = ['all', 'admins', 'off'];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/pkAAAAASUVORK5CYII=', 'base64');
  const withSeed = seed => parseDeploymentConfig({ CAMPING_PUBLISHED: '1', CAMPING_PUBLIC_ORIGIN: PUBLIC, CAMPING_RECEIPT_AI_POLICY: seed });
  const cookieOf = res => (res.headers.get('set-cookie') || '').split(';')[0];
  let aiDir, aiPath, tripId, admin, member, calls = 0;

  // A fake configured provider; `calls` counts how often recognition reached it.
  const fakeAi = () => ({
    status: { enabled: true, provider: 'OpenAI', modelId: 'gpt-6-luna', maxImageBytes: AI_IMAGE_LIMIT },
    recognize: async () => { calls++; return { store: '', date: '', totalCents: 0, items: [], warnings: [] }; }
  });

  // Own file database: the admin owns one trip and the member joined it through an invite, so both can edit.
  beforeAll(async () => {
    aiDir = mkdtempSync(join(tmpdir(), 'camping-receipt-ai-'));
    aiPath = join(aiDir, 'accounts.sqlite');
    const seed = createAccountService({ dbPath: aiPath, deployment: LOCAL_DEFAULTS });
    const send = createHttpHandler({ root: DIST, accounts: seed });
    try {
      const setup = await direct(send, 'POST', '/api/setup', { body: { username: 'admin-one', displayName: '管理員', password: PASS } });
      if (setup.status !== 200) throw new Error(`seed setup failed: ${setup.status} ${await setup.text()}`);
      admin = { cookie: cookieOf(setup), id: (await setup.json()).user.id };
      const reg = await direct(send, 'POST', '/api/register', { body: { username: 'member-one', displayName: '旅伴', password: PASS } });
      if (reg.status !== 200) throw new Error(`seed register failed: ${reg.status} ${await reg.text()}`);
      member = { cookie: cookieOf(reg), id: (await reg.json()).user.id };
      const trip = await direct(send, 'POST', '/api/trips', { cookie: admin.cookie, body: { title: '收據測試', startDate: '2025-07-01', endDate: '2025-07-02', expectedUserId: admin.id } });
      if (trip.status !== 201) throw new Error(`seed trip failed: ${trip.status} ${await trip.text()}`);
      tripId = (await trip.json()).trip.id;
      const invite = await direct(send, 'POST', `/api/trips/${tripId}/invites`, { cookie: admin.cookie, body: { expectedUserId: admin.id } });
      const { token } = await invite.json();
      const joined = await direct(send, 'POST', `/api/invites/${token}/join`, { cookie: member.cookie, body: { name: '收據旅伴', role: '採買', expectedUserId: member.id } });
      if (joined.status !== 200) throw new Error(`seed join failed: ${joined.status} ${await joined.text()}`);
    } finally {
      seed.close();
    }
  });
  afterAll(() => { if (aiDir) rmSync(aiDir, { recursive: true, force: true }); });
  // Every test starts with nothing in the Settings_Store; afterEach has already closed the services.
  beforeEach(() => {
    const db = new Database(aiPath);
    try { db.run('DELETE FROM settings'); } finally { db.close(); }
    calls = 0;
  });

  function openAi(config, { receiptAi = fakeAi() } = {}) {
    const accounts = createAccountService({ dbPath: aiPath, deployment: config, receiptAi });
    opened.push(accounts);
    return createHttpHandler({ root: DIST, accounts, config });
  }
  const status = async (handler, who) => {
    const res = await proxied(handler, 'GET', `/api/trips/${tripId}/receipt-ai`, { cookie: who.cookie });
    expect(res.status).toBe(200);
    return res.json();
  };
  const recognize = (handler, who) => handler(new Request(`${PROXIED_BASE}/api/trips/${tripId}/receipt-ai`, {
    method: 'POST',
    headers: {
      'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https', origin: PUBLIC, cookie: who.cookie,
      'content-type': 'image/png', 'x-camping-user-id': who.id, 'x-receipt-consent': 'openai-v1'
    },
    body: png
  }), nginxPeer);
  const setPolicy = (handler, who, receiptAiPolicy) => proxied(handler, 'PATCH', '/api/admin/settings', { cookie: who.cookie, body: { receiptAiPolicy } });
  const settings = async handler => {
    const res = await proxied(handler, 'GET', '/api/admin/settings', { cookie: admin.cookie });
    expect(res.status).toBe(200);
    return (await res.json()).receiptAiPolicy;
  };
  const expectOutcome = async (res, expected) => {
    if (expected === 200) {
      expect(res.status).toBe(200);
      expect((await res.json()).items).toEqual([]);
      return;
    }
    expect(res.status).toBe(expected.status);
    expect(await res.json()).toEqual({ error: expected.error });
  };

  // Expected status report and recognition outcome per policy, for [admin, member].
  const MATRIX = {
    all: [{ enabled: true, post: 200 }, { enabled: true, post: 200 }],
    admins: [{ enabled: true, post: 200 }, { enabled: false, reason: 'policy', post: { status: 403, error: ADMINS_ONLY } }],
    off: [{ enabled: false, reason: 'policy', post: { status: 503, error: TURNED_OFF } }, { enabled: false, reason: 'policy', post: { status: 503, error: TURNED_OFF } }]
  };

  test('each policy set by an admin applies to the next status and recognition request, with an audit entry', async () => {
    const handler = openAi(PUBLISHED);
    let expectedCalls = 0;
    // `off` first, then back to `all`, so every transition happens on one running service.
    for (const policy of ['off', 'admins', 'all', 'off', 'all']) {
      const res = await setPolicy(handler, admin, policy);
      expect(res.status).toBe(200);
      expect((await res.json()).receiptAiPolicy).toMatchObject({ value: policy, source: 'stored', updatedBy: 'admin-one' });
      const audit = await (await proxied(handler, 'GET', '/api/admin/audit', { cookie: admin.cookie })).json();
      expect(audit.events[0]).toMatchObject({ actor: 'admin-one', action: 'settings.receipt-ai', target: `receiptAiPolicy:${policy}` });
      for (const [i, who] of [admin, member].entries()) {
        const want = MATRIX[policy][i];
        const body = await status(handler, who);
        expect(body.enabled).toBe(want.enabled);
        if (want.enabled) expect(body.disabledReason).toBeUndefined();
        else expect(body.disabledReason).toBe(want.reason);
        await expectOutcome(await recognize(handler, who), want.post);
        if (want.post === 200) expectedCalls++;
        expect(calls).toBe(expectedCalls);
      }
    }
  });

  test('without a configured key, status reports unconfigured where the policy permits and policy where it excludes', async () => {
    const handler = openAi(PUBLISHED, { receiptAi: null });
    const reasons = { all: ['unconfigured', 'unconfigured'], admins: ['unconfigured', 'policy'], off: ['policy', 'policy'] };
    for (const policy of OPTIONS) {
      expect((await setPolicy(handler, admin, policy)).status).toBe(200);
      for (const [i, who] of [admin, member].entries()) {
        const body = await status(handler, who);
        expect(body.enabled).toBe(false);
        expect(body.disabledReason).toBe(reasons[policy][i]);
      }
    }
    expect((await setPolicy(handler, admin, 'all')).status).toBe(200);
    await expectOutcome(await recognize(handler, member), { status: 503, error: UNCONFIGURED });
  });

  test('with nothing stored the seed applies, and without a seed the default is all in both modes', async () => {
    for (const seed of OPTIONS) {
      const handler = openAi(withSeed(seed));
      expect(await settings(handler)).toEqual({ value: seed, source: 'seed', updatedAt: null, updatedBy: null, options: OPTIONS });
      const want = MATRIX[seed][1];
      expect((await status(handler, member)).enabled).toBe(want.enabled);
      await expectOutcome(await recognize(handler, member), want.post);
    }
    const published = openAi(PUBLISHED);
    expect(await settings(published)).toEqual({ value: 'all', source: 'default', updatedAt: null, updatedBy: null, options: OPTIONS });
    await expectOutcome(await recognize(published, member), 200);
    const local = openAi(LOCAL_DEFAULTS);
    const res = await direct(local, 'GET', '/api/admin/settings', { cookie: admin.cookie });
    expect((await res.json()).receiptAiPolicy).toMatchObject({ value: 'all', source: 'default' });
  });

  test('GET /api/admin/settings reports the stored value, time, and admin', async () => {
    const handler = openAi(withSeed('off'));
    const before = Date.now();
    expect((await setPolicy(handler, admin, 'admins')).status).toBe(200);
    const body = await settings(handler);
    expect(Object.keys(body).sort()).toEqual(['options', 'source', 'updatedAt', 'updatedBy', 'value']);
    expect(body).toMatchObject({ value: 'admins', source: 'stored', updatedBy: 'admin-one', options: OPTIONS });
    expect(new Date(body.updatedAt).toISOString()).toBe(body.updatedAt);
    expect(Date.parse(body.updatedAt)).toBeGreaterThanOrEqual(before - 1000);
  });

  test('a member gets 403 for GET and PATCH, and invalid values get 400, leaving the stored value unchanged', async () => {
    const handler = openAi(PUBLISHED);
    expect((await setPolicy(handler, admin, 'admins')).status).toBe(200);
    const stored = await settings(handler);
    const policyAudits = async () => (await (await proxied(handler, 'GET', '/api/admin/audit', { cookie: admin.cookie })).json())
      .events.filter(e => e.action === 'settings.receipt-ai');
    const auditsBefore = await policyAudits();
    expect(auditsBefore[0].target).toBe('receiptAiPolicy:admins');
    expect((await proxied(handler, 'GET', '/api/admin/settings', { cookie: member.cookie })).status).toBe(403);
    for (const value of ['all', 'off']) expect((await setPolicy(handler, member, value)).status).toBe(403);
    for (const value of ['ALL', 'none', '', ' all', null, 7, true, ['all'], undefined]) {
      const res = await setPolicy(handler, admin, value);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: INVALID_POLICY });
    }
    expect(await settings(handler)).toEqual(stored);
    await expectOutcome(await recognize(handler, member), { status: 403, error: ADMINS_ONLY });
    // Rejected changes write no audit entry.
    expect(await policyAudits()).toEqual(auditsBefore);
  });

  test('a file-backed database keeps the stored value across service instances, and it beats the seed', async () => {
    const first = openAi(withSeed('all'));
    expect((await setPolicy(first, admin, 'off')).status).toBe(200);
    while (opened.length) opened.pop().close();

    const second = openAi(withSeed('all'));
    expect(await settings(second)).toMatchObject({ value: 'off', source: 'stored', updatedBy: 'admin-one' });
    await expectOutcome(await recognize(second, admin), { status: 503, error: TURNED_OFF });
    expect((await setPolicy(second, admin, 'admins')).status).toBe(200);
    while (opened.length) opened.pop().close();

    const third = openAi(PUBLISHED);
    expect(await settings(third)).toMatchObject({ value: 'admins', source: 'stored' });
    await expectOutcome(await recognize(third, member), { status: 403, error: ADMINS_ONLY });
    await expectOutcome(await recognize(third, admin), 200);
  });
});
