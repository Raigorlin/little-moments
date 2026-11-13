// Registration policy, origin check, rate-limit isolation, invite registration and receipt AI policy examples,
// sent through createHttpHandler as Direct_Local_Requests.
//
// This file came from security-harden's publish-behind-nginx tests. Published_Mode (CAMPING_PUBLISHED,
// CAMPING_PUBLIC_ORIGIN) was dropped in the merge (task 18.3), so its cases were removed: proxied login with the
// Public_Origin, the removed web setup, the deployment meta tag and `const PUBLISHED=true;` in sw.js, and the
// proxied X-Forwarded-For buckets. Requests behind Trusted_Proxies are covered by tests/http-origin.test.js and
// tests/proxy-resolve.test.js. The seeds below come from parseConfig (CAMPING_REGISTRATION,
// CAMPING_RECEIPT_AI_POLICY) and reach createAccountService as registrationPolicySeed and receiptAiPolicySeed;
// values an admin stores through PATCH /api/admin/settings take precedence (jenkins-cicd-deploy Requirement 26).
//
// Runs against a PostgreSQL Ephemeral_Database (CAMPING_TEST_DATABASE_*, tests/support/pg.js). Each describe
// seeds the shared test schema in its own beforeAll; the describes run in order.
import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import fc from 'fast-check';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createAccountService, RateLimiter } from '../server/accounts.js';
import { createHttpHandler } from '../server/http.js';
import { AI_IMAGE_LIMIT } from '../server/receipt-ai.js';
import { useTestDatabase, createTestDatabase, resetTables, serviceDb, testQuery } from './support/pg.js';

const DIST = resolve(import.meta.dir, '..', process.env.CAMPING_DIST || 'dist');
const LOCAL_BASE = 'http://127.0.0.1:5173';
const LOCAL_HOST = '127.0.0.1:5173';
const PASS = 'correct horse battery';
const CLOSED = { registrationPolicySeed: 'closed' };
const peerAt = address => ({ requestIP: () => ({ address }) });
const loopbackPeer = peerAt('127.0.0.1');

const db = useTestDatabase();
const query = (text, ...params) => testQuery(db.sql, text, ...params);
const opened = [];
const extraDbs = [];

/** A service and handler on the shared test schema, or on a new empty schema when `empty`. */
async function open({ empty = false, ...options } = {}) {
  let sql = db.sql;
  if (empty) { const t = await createTestDatabase(); extraDbs.push(t); sql = t.sql; }
  const accounts = await createAccountService({ db: serviceDb(sql), ...options });
  opened.push(accounts);
  return createHttpHandler({ root: DIST, accounts });
}

/** A Direct_Local_Request: loopback Host, the given TCP peer, no forwarding headers. */
function direct(handler, method, path, { origin = LOCAL_BASE, body, raw, cookie, peer = loopbackPeer } = {}) {
  // The Request constructor sets no Host header; Bun.serve builds req.url from it, so send it explicitly.
  const headers = { host: LOCAL_HOST };
  if (method !== 'GET' && method !== 'HEAD' && origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return handler(new Request(LOCAL_BASE + path, { method, headers, body: payload }), peer);
}
const cookieOf = res => (res.headers.get('set-cookie') || '').split(';')[0];

/** Empty tables, then the first admin (admin-one) and a member (member-one). Returns their sessions. */
async function seedAccounts() {
  await resetTables(db.sql);
  const seedAccounts = await createAccountService({ db: serviceDb(db.sql) });
  const seed = createHttpHandler({ root: DIST, accounts: seedAccounts });
  try {
    const setup = await direct(seed, 'POST', '/api/setup', { body: { username: 'admin-one', displayName: '管理員', password: PASS } });
    if (setup.status !== 200) throw new Error(`seed setup failed: ${setup.status} ${await setup.text()}`);
    const reg = await direct(seed, 'POST', '/api/register', { body: { username: 'member-one', displayName: '旅伴', password: PASS } });
    if (reg.status !== 200) throw new Error(`seed register failed: ${reg.status} ${await reg.text()}`);
    return {
      admin: { cookie: cookieOf(setup), id: (await setup.json()).user.id },
      member: { cookie: cookieOf(reg), id: (await reg.json()).user.id }
    };
  } finally {
    seedAccounts.close();
  }
}

beforeAll(async () => {
  if (!(await Bun.file(join(DIST, 'index.html')).exists())) throw new Error('dist is missing; run `bun run build` first.');
});
afterEach(async () => {
  while (opened.length) opened.pop().close();
  while (extraDbs.length) await extraDbs.pop().close();
});

describe('registration policy', () => {
  const body = { username: 'new-person', displayName: '新朋友', password: PASS };
  const CLOSED_MESSAGE = '目前不開放公開註冊，請使用旅行邀請連結建立帳號。';
  const REG_OPTIONS = ['open', 'closed'];
  let admin, member, seq = 0;
  beforeAll(async () => { ({ admin, member } = await seedAccounts()); }, 60_000);
  // Each test starts with nothing in the Settings_Store and no settings audit rows; afterEach has already closed the services.
  beforeEach(async () => {
    await db.sql`DELETE FROM settings`;
    await db.sql`DELETE FROM audit WHERE action LIKE 'settings.%'`;
  });

  // A distinct client address per attempt keeps the register limit out of the way where a test does not test it.
  const nextPeer = () => { const k = ++seq; return peerAt(`10.200.${(k >> 8) & 255}.${k & 255}`); };
  const newBody = () => ({ username: `policy-user-${++seq}`, displayName: '政策旅伴', password: PASS });
  const serviceOf = () => opened.at(-1);
  const patch = (handler, who, payload) => direct(handler, 'PATCH', '/api/admin/settings', { cookie: who.cookie, body: payload });
  const adminSettings = async handler => {
    const res = await direct(handler, 'GET', '/api/admin/settings', { cookie: admin.cookie });
    expect(res.status).toBe(200);
    return res.json();
  };
  const sessionOpen = async handler => (await (await direct(handler, 'GET', '/api/session')).json()).registrationOpen;
  const settingRows = () => query('SELECT key, value, updated_at, updated_by FROM settings ORDER BY key');
  const settingsAudits = () => query("SELECT actor, action, target FROM audit WHERE action LIKE 'settings.%' ORDER BY id");

  test('open registration creates an account', async () => {
    const handler = await open({ empty: true });
    expect((await direct(handler, 'POST', '/api/setup', { body: { username: 'admin-one', displayName: '管理員', password: PASS } })).status).toBe(200);
    const res = await direct(handler, 'POST', '/api/register', { body });
    expect(res.status).toBe(200);
    expect((await res.json()).user.username).toBe('new-person');
  }, 60_000); // open({ empty: true }) migrates a new test schema

  test('CAMPING_REGISTRATION=closed refuses valid, malformed, and empty bodies without spending the register bucket', async () => {
    const handler = await open(CLOSED);
    const keys = [];
    const { hit, blocked } = RateLimiter.prototype;
    RateLimiter.prototype.hit = function (key, limit) { keys.push(key); return hit.call(this, key, limit); };
    RateLimiter.prototype.blocked = function (key, limit) { keys.push(key); return blocked.call(this, key, limit); };
    try {
      // 25 attempts exceed the register limit of 20; each must still be the closed 403, never 429.
      for (let i = 0; i < 25; i++) {
        const kind = i % 3;
        const res = kind === 0 ? await direct(handler, 'POST', '/api/register', { body })
          : kind === 1 ? await direct(handler, 'POST', '/api/register', { raw: '{"username":' })
          : await direct(handler, 'POST', '/api/register');
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: CLOSED_MESSAGE });
      }
    } finally {
      RateLimiter.prototype.hit = hit;
      RateLimiter.prototype.blocked = blocked;
    }
    expect(keys.filter(key => key.startsWith('register:'))).toEqual([]);
    expect((await direct(handler, 'POST', '/api/login', { body: { username: 'new-person', password: PASS } })).status).toBe(401);
  });

  test('GET /api/session reports the flags for each policy', async () => {
    const flags = async res => { const b = await res.json(); return { needsSetup: b.needsSetup, webSetup: b.webSetup, registrationOpen: b.registrationOpen, inviteRegistration: b.inviteRegistration }; };
    expect(await flags(await direct(await open({ empty: true }), 'GET', '/api/session'))).toEqual({ needsSetup: true, webSetup: true, registrationOpen: true, inviteRegistration: false });
    expect(await flags(await direct(await open(), 'GET', '/api/session'))).toEqual({ needsSetup: false, webSetup: true, registrationOpen: true, inviteRegistration: true });
    expect(await flags(await direct(await open(CLOSED), 'GET', '/api/session'))).toEqual({ needsSetup: false, webSetup: true, registrationOpen: false, inviteRegistration: true });
    expect(await flags(await direct(await open({ ...CLOSED, empty: true }), 'GET', '/api/session'))).toEqual({ needsSetup: true, webSetup: true, registrationOpen: false, inviteRegistration: false });
  }, 60_000); // two new test schemas

  // jenkins-cicd-deploy Requirement 26: the Settings_Store value set by an admin, read on every request.
  test('an admin closes then reopens registration on one running service; the next register and session follow each save', async () => {
    const handler = await open();
    const service = serviceOf();
    for (const [policy, status, isOpen] of [['closed', 403, false], ['open', 200, true]]) {
      const res = await patch(handler, admin, { registrationPolicy: policy });
      expect(res.status).toBe(200);
      const saved = await res.json();
      expect(saved.registrationPolicy).toMatchObject({ value: policy, source: 'stored', updatedBy: 'admin-one', options: REG_OPTIONS });
      // Only registrationPolicy was sent, so receipt AI stays on its default with no row (Req 26.8).
      expect(saved.receiptAiPolicy).toMatchObject({ value: 'all', source: 'default', updatedAt: null, updatedBy: null });

      const attempt = newBody();
      const reg = await direct(handler, 'POST', '/api/register', { body: attempt, peer: nextPeer() });
      expect(reg.status).toBe(status);
      if (isOpen) expect((await reg.json()).user.username).toBe(attempt.username);
      else expect(await reg.json()).toEqual({ error: CLOSED_MESSAGE });
      expect(await sessionOpen(handler)).toBe(isOpen);
      expect(await service.registrationPolicy()).toMatchObject({ value: policy, source: 'stored', updatedBy: 'admin-one' });

      const rows = await settingRows();
      expect(rows.map(r => [r.key, r.value, r.updated_by])).toEqual([['registrationPolicy', policy, 'admin-one']]);
      expect((await settingsAudits()).at(-1)).toEqual({ actor: 'admin-one', action: 'settings.registration', target: `registrationPolicy:${policy}` });
    }
    expect((await settingsAudits()).map(a => a.target)).toEqual(['registrationPolicy:closed', 'registrationPolicy:open']);
  });

  test('the seed applies only while nothing is stored, and the default is open', async () => {
    const unseeded = await open();
    expect((await adminSettings(unseeded)).registrationPolicy).toEqual({ value: 'open', source: 'default', updatedAt: null, updatedBy: null, options: REG_OPTIONS });

    const handler = await open(CLOSED);
    expect((await adminSettings(handler)).registrationPolicy).toEqual({ value: 'closed', source: 'seed', updatedAt: null, updatedBy: null, options: REG_OPTIONS });
    expect((await direct(handler, 'POST', '/api/register', { body: newBody(), peer: nextPeer() })).status).toBe(403);
    expect(await sessionOpen(handler)).toBe(false);

    const before = Date.now();
    expect((await patch(handler, admin, { registrationPolicy: 'open' })).status).toBe(200);
    const stored = (await adminSettings(handler)).registrationPolicy;
    expect(stored).toMatchObject({ value: 'open', source: 'stored', updatedBy: 'admin-one', options: REG_OPTIONS });
    expect(new Date(stored.updatedAt).toISOString()).toBe(stored.updatedAt);
    expect(Date.parse(stored.updatedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect((await direct(handler, 'POST', '/api/register', { body: newBody(), peer: nextPeer() })).status).toBe(200);
    expect(await sessionOpen(handler)).toBe(true);
  });

  test('a stored value outside open/closed fails closed with source stored and is left as it is', async () => {
    const handler = await open();
    expect((await patch(handler, admin, { registrationPolicy: 'open' })).status).toBe(200);
    await query("UPDATE settings SET value = 'Open' WHERE key = 'registrationPolicy'");
    expect((await adminSettings(handler)).registrationPolicy).toMatchObject({ value: 'closed', source: 'stored', updatedBy: 'admin-one' });
    const res = await direct(handler, 'POST', '/api/register', { body: newBody(), peer: nextPeer() });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: CLOSED_MESSAGE });
    expect(await sessionOpen(handler)).toBe(false);
    expect((await settingRows()).map(r => [r.key, r.value])).toEqual([['registrationPolicy', 'Open']]);
  });

  test('a member gets 403, and invalid or empty bodies get 400, leaving both setting rows and the audit unchanged', async () => {
    const handler = await open();
    // Both keys in one request: both are stored, each with its own audit entry (Req 26.8).
    const both = await patch(handler, admin, { receiptAiPolicy: 'admins', registrationPolicy: 'closed' });
    expect(both.status).toBe(200);
    expect((await settingsAudits()).map(a => a.action).sort()).toEqual(['settings.receipt-ai', 'settings.registration']);
    const rowsBefore = await settingRows();
    const auditsBefore = await settingsAudits();
    expect(rowsBefore.map(r => [r.key, r.value])).toEqual([['receiptAiPolicy', 'admins'], ['registrationPolicy', 'closed']]);

    expect((await direct(handler, 'GET', '/api/admin/settings', { cookie: member.cookie })).status).toBe(403);
    for (const payload of [{ registrationPolicy: 'open' }, { receiptAiPolicy: 'all', registrationPolicy: 'open' }]) {
      expect((await patch(handler, member, payload)).status).toBe(403);
    }
    const cases = [
      [{}, '請至少提供一項設定。'],
      [{ registrationPolicy: 'Open' }, '公開註冊政策必須是 open 或 closed。'],
      [{ registrationPolicy: ' closed' }, '公開註冊政策必須是 open 或 closed。'],
      [{ registrationPolicy: null }, '公開註冊政策必須是 open 或 closed。'],
      [{ registrationPolicy: ['open'] }, '公開註冊政策必須是 open 或 closed。'],
      [{ receiptAiPolicy: 'all', registrationPolicy: 'maybe' }, '公開註冊政策必須是 open 或 closed。'],
      [{ receiptAiPolicy: 'everyone', registrationPolicy: 'open' }, '收據 AI 政策必須是 all、admins 或 off。'],
      [null, null], [1, null], [['open'], null]
    ];
    for (const [payload, message] of cases) {
      const res = await patch(handler, admin, payload);
      expect(res.status).toBe(400);
      if (message) expect(await res.json()).toEqual({ error: message });
    }
    expect(await settingRows()).toEqual(rowsBefore);
    expect(await settingsAudits()).toEqual(auditsBefore);
    expect(await sessionOpen(handler)).toBe(false);
  });

  test('a PATCH with one key stores only that key, leaving the other setting (including no row) unchanged', async () => {
    let now = Date.now();
    const handler = await open({ now: () => now });
    expect((await patch(handler, admin, { receiptAiPolicy: 'off' })).status).toBe(200);
    expect((await settingRows()).map(r => r.key)).toEqual(['receiptAiPolicy']);
    expect((await adminSettings(handler)).registrationPolicy).toMatchObject({ value: 'open', source: 'default' });
    const receiptRow = (await settingRows())[0];

    now += 60_000;
    expect((await patch(handler, admin, { registrationPolicy: 'closed' })).status).toBe(200);
    const afterRegistration = await settingRows();
    expect(afterRegistration[0]).toEqual(receiptRow);
    expect(afterRegistration.map(r => [r.key, r.value])).toEqual([['receiptAiPolicy', 'off'], ['registrationPolicy', 'closed']]);
    const registrationRow = afterRegistration[1];

    now += 60_000;
    expect((await patch(handler, admin, { receiptAiPolicy: 'admins' })).status).toBe(200);
    const afterReceipt = await settingRows();
    expect(afterReceipt[1]).toEqual(registrationRow);
    expect(afterReceipt[0].value).toBe('admins');

    now += 60_000;
    expect((await patch(handler, admin, { receiptAiPolicy: 'all', registrationPolicy: 'open' })).status).toBe(200);
    const afterBoth = await settingRows();
    expect(afterBoth.map(r => [r.key, r.value, Number(r.updated_at)])).toEqual([['receiptAiPolicy', 'all', now], ['registrationPolicy', 'open', now]]);
    expect((await settingsAudits()).map(a => a.target)).toEqual([
      'receiptAiPolicy:off', 'registrationPolicy:closed', 'receiptAiPolicy:admins', 'receiptAiPolicy:all', 'registrationPolicy:open'
    ]);
  });

  test('invite registration succeeds under a stored closed and a stored open policy', async () => {
    const handler = await open();
    for (const policy of ['closed', 'open']) {
      expect((await patch(handler, admin, { registrationPolicy: policy })).status).toBe(200);
      expect(await sessionOpen(handler)).toBe(policy === 'open');
      const trip = await direct(handler, 'POST', '/api/trips', { cookie: admin.cookie, body: { title: `邀請 ${policy}`, startDate: '2025-07-01', endDate: '2025-07-02', expectedUserId: admin.id } });
      expect(trip.status).toBe(201);
      const tripId = (await trip.json()).trip.id;
      const invite = await direct(handler, 'POST', `/api/trips/${tripId}/invites`, { cookie: admin.cookie, body: { expectedUserId: admin.id } });
      expect(invite.status).toBe(201);
      const { token } = await invite.json();
      const attempt = { ...newBody(), name: `受邀 ${policy}` };
      const res = await direct(handler, 'POST', `/api/invites/${token}/register`, { body: attempt, peer: nextPeer() });
      expect(res.status).toBe(200);
      const result = await res.json();
      expect(result.tripId).toBe(tripId);
      expect(result.user).toMatchObject({ username: attempt.username, role: 'member' });
      expect((await query('SELECT COUNT(*) AS n FROM trip_members WHERE trip_id = ?', tripId))[0].n).toBe(2);
    }
  });

  test('closed by a stored value, refused /api/register attempts do not spend the register bucket', async () => {
    const handler = await open();
    expect((await patch(handler, admin, { registrationPolicy: 'closed' })).status).toBe(200);
    const peer = nextPeer();
    const keys = [];
    const { hit, blocked } = RateLimiter.prototype;
    RateLimiter.prototype.hit = function (key, limit) { keys.push(key); return hit.call(this, key, limit); };
    RateLimiter.prototype.blocked = function (key, limit) { keys.push(key); return blocked.call(this, key, limit); };
    try {
      // 25 attempts exceed the register limit of 20; each must still be the closed 403, never 429.
      for (let i = 0; i < 25; i++) {
        const res = await direct(handler, 'POST', '/api/register', { body: newBody(), peer });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: CLOSED_MESSAGE });
      }
    } finally {
      RateLimiter.prototype.hit = hit;
      RateLimiter.prototype.blocked = blocked;
    }
    expect(keys.filter(key => key.startsWith('register:'))).toEqual([]);
    // Reopened, the same client still has its whole bucket.
    expect((await patch(handler, admin, { registrationPolicy: 'open' })).status).toBe(200);
    expect((await direct(handler, 'POST', '/api/register', { body: newBody(), peer })).status).toBe(200);
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
    const local = await open({ empty: true });
    await fc.assert(fc.asyncProperty(originFor(LOCAL_BASE), async origin => {
      const res = await direct(local, 'POST', '/api/logout', { origin });
      if (origin === LOCAL_BASE) {
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      } else {
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: '請求來源不被允許。' });
      }
    }), { numRuns: 150 });
  }, 60_000); // a new test schema plus 150 runs
});

describe('rate-limit isolation properties', () => {
  // Mirrors LIMITS in server/accounts.js (not exported).
  const LIMIT_TABLE = {
    loginClient: { max: 30, window: 15 * 60000 },
    register: { max: 20, window: 60 * 60000 },
    invitePreview: { max: 60, window: 15 * 60000 }
  };

  // Feature: publish-behind-nginx, Property 9: Rate-limit buckets are isolated per client address
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
  test('register bucket per client address matches a per-address model', async () => {
    const peers = ['127.0.0.1', '192.168.1.20', '10.0.0.7'];
    // An empty database: the register limiter counts before the needs-setup 409, so no scrypt runs.
    const empty = await createTestDatabase();
    try {
      const scenario = fc.integer({ min: 1, max: peers.length }).chain(n =>
        fc.array(fc.nat({ max: n - 1 }), { minLength: 21, maxLength: 60 }));
      await fc.assert(fc.asyncProperty(scenario, async sequence => {
        // A fresh service per run: fresh rate limiter.
        const accounts = await createAccountService({ db: serviceDb(empty.sql) });
        const handler = createHttpHandler({ root: DIST, accounts });
        try {
          const counts = peers.map(() => 0);
          for (const i of sequence) {
            const res = await direct(handler, 'POST', '/api/register', { peer: peerAt(peers[i]) });
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
    } finally {
      await empty.close();
    }
  }, 120000);
});

describe('invite registration', () => {
  const INVALID = '邀請連結無效或已過期。';
  const TAKEN = '這個帳號名稱已被使用。';
  const LIMITED = '註冊嘗試太多次，請稍後再試。';
  const NAME_TAKEN = '這個名字已在小隊中。請加上姓氏或使用不同暱稱，不會直接切換成同名旅伴。';
  const INVITE_TTL_MS = 7 * 86400000;
  const sha = value => createHash('sha256').update(value).digest('hex');
  let seq = 0;
  const unique = () => ++seq;
  // A distinct client address per attempt keeps the register limit out of the way where a test does not test it.
  const nextPeer = () => { const k = unique(); return peerAt(`10.${(k >> 16) & 255}.${(k >> 8) & 255}.${k & 255}`); };

  beforeAll(seedAccounts, 60_000);

  const via = handler => (method, path, opts) => direct(handler, method, path, opts);

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
  const registerVia = (send, token, body, opts = {}) => send('POST', `/api/invites/${token}/register`, { peer: nextPeer(), ...opts, body });

  const inviteRow = async token => (await query('SELECT used_at, used_by FROM invites WHERE token_hash = ?', sha(token)))[0] ?? null;
  const userRow = async username => (await query('SELECT id, role FROM users WHERE username = ?', username))[0] ?? null;
  const userCount = async () => (await query('SELECT COUNT(*) AS n FROM users'))[0].n;
  const memberCount = async tripId => (await query('SELECT COUNT(*) AS n FROM trip_members WHERE trip_id = ?', tripId))[0].n;
  const UNUSED = { used_at: null, used_by: null };

  test('creates a member in the trip, consumes the link, sets the session cookie, and writes audits', async () => {
    const send = via(await open());
    const { cookie: ownerCookie, tripId, token } = await ownerInvite(send);
    const body = regBody(unique(), { role: '攝影師' });
    const res = await registerVia(send, token, body);
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.tripId).toBe(tripId);
    expect(result.user).toMatchObject({ username: body.username, displayName: body.displayName, role: 'member' });
    const attrs = (res.headers.get('set-cookie') || '').split(';').map(part => part.trim());
    expect(attrs[0]).toMatch(/^ggc_session=[a-f0-9]{64}$/);
    for (const attr of ['HttpOnly', 'SameSite=Strict', 'Path=/']) expect(attrs).toContain(attr);
    expect(attrs).not.toContain('Secure'); // plain http request URL

    const session = await send('GET', '/api/session', { cookie: attrs[0] });
    expect((await session.json()).user.username).toBe(body.username);
    const trip = await send('GET', `/api/trips/${tripId}`, { cookie: attrs[0] });
    expect(trip.status).toBe(200);
    const envelope = await trip.json();
    expect(envelope.trip.isMember).toBe(true);
    expect(envelope.state.people.find(p => p.id === envelope.permissions.personId)).toMatchObject({ name: body.name, role: '攝影師' });
    expect(await memberCount(tripId)).toBe(2);
    expect((await inviteRow(token)).used_by).toBe(result.user.id);
    expect((await inviteRow(token)).used_at).not.toBeNull();

    const audit = await (await send('GET', '/api/admin/audit', { cookie: ownerCookie })).json();
    expect(audit.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor: body.username, action: 'register.invite', target: `user:${body.username}` }),
      expect.objectContaining({ actor: body.username, action: 'invite.join', target: `trip:${tripId}` })
    ]));
  });

  test('works under both registration policies, including closed', async () => {
    for (const options of [{}, CLOSED]) {
      const send = via(await open(options));
      const { tripId, token } = await ownerInvite(send);
      const body = regBody(unique());
      const res = await registerVia(send, token, body);
      expect(res.status).toBe(200);
      expect((await res.json()).tripId).toBe(tripId);
      expect(res.headers.get('set-cookie')).not.toContain('Secure');
      expect((await userRow(body.username)).role).toBe('member');
    }
  });

  test('invalid, used, and expired tokens return 404 and create nothing', async () => {
    let now = Date.now();
    const send = via(await open({ now: () => now }));
    const { tripId, token: used, ...session } = await ownerInvite(send);
    const expiring = await createInvite(send, session, tripId);
    expect((await registerVia(send, used, regBody(unique()))).status).toBe(200);
    const before = await userCount();
    const attempt = async token => {
      const body = regBody(unique());
      const res = await registerVia(send, token, body);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: INVALID });
      expect(await userRow(body.username)).toBeNull();
    };
    for (const token of ['not-a-token', 'a'.repeat(64), 'A'.repeat(64), used]) await attempt(token);
    now += INVITE_TTL_MS + 1;
    await attempt(expiring);
    expect(await userCount()).toBe(before);
    expect(await memberCount(tripId)).toBe(2);
    expect(await inviteRow(expiring)).toEqual(UNUSED);
  });

  test('a taken username returns 409 and leaves the link unused', async () => {
    const send = via(await open());
    const { tripId, token } = await ownerInvite(send);
    const before = await userCount();
    for (const username of ['member-one', 'admin-one']) {
      const res = await registerVia(send, token, regBody(unique(), { username }));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: TAKEN });
    }
    expect(await userCount()).toBe(before);
    expect(await memberCount(tripId)).toBe(1);
    expect(await inviteRow(token)).toEqual(UNUSED);
  });

  test('a trip name conflict returns 409 with no new user and the link still usable', async () => {
    const send = via(await open());
    const { tripId, token } = await ownerInvite(send);
    const before = await userCount();
    // The owner's participant is 管理員: once as the explicit trip name, once through the display-name default.
    const explicit = regBody(unique(), { name: '管理員' });
    const defaulted = { ...regBody(unique(), { displayName: '管理員' }), name: undefined };
    for (const body of [explicit, defaulted]) {
      const res = await registerVia(send, token, body);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: NAME_TAKEN });
      expect(await userRow(body.username)).toBeNull();
    }
    expect(await userCount()).toBe(before);
    expect(await memberCount(tripId)).toBe(1);
    expect(await inviteRow(token)).toEqual(UNUSED);
    const ok = await registerVia(send, token, regBody(unique()));
    expect(ok.status).toBe(200);
  });

  test('invite registration and POST /api/register share one register bucket per Client_Address', async () => {
    const handler = await open();
    // Unknown tokens fail after the limiter and validation but before hashing, so 20 attempts stay cheap.
    const unknown = 'b'.repeat(64);
    const a = peerAt('192.168.1.20'), b = peerAt('10.0.0.7');
    for (let i = 0; i < 10; i++) {
      expect((await direct(handler, 'POST', '/api/register', { peer: a, raw: undefined })).status).toBe(415);
      expect((await direct(handler, 'POST', `/api/invites/${unknown}/register`, { peer: a, body: regBody(unique()) })).status).toBe(404);
    }
    for (const path of ['/api/register', `/api/invites/${unknown}/register`]) {
      const res = await direct(handler, 'POST', path, { peer: a, body: regBody(unique()) });
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: LIMITED });
    }
    expect((await direct(handler, 'POST', `/api/invites/${unknown}/register`, { peer: b, body: regBody(unique()) })).status).toBe(404);
    expect((await direct(handler, 'POST', '/api/register', { peer: b })).status).toBe(415);
  });

  test('a bad Origin returns 403 and leaves the link unused', async () => {
    const send = via(await open());
    const { tripId, token } = await ownerInvite(send);
    for (const origin of ['https://attacker.example', 'http://localhost:5173', null]) {
      const body = regBody(unique());
      const res = await registerVia(send, token, body, { origin });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: '請求來源不被允許。' });
      expect(await userRow(body.username)).toBeNull();
    }
    expect(await memberCount(tripId)).toBe(1);
    expect(await inviteRow(token)).toEqual(UNUSED);
  });

  test('with no users in the database, invite registration returns 409', async () => {
    const send = via(await open({ empty: true }));
    const res = await registerVia(send, 'd'.repeat(64), regBody(unique()));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: '請先完成管理員設定。' });
  }, 60_000); // open({ empty: true }) migrates a new test schema

  // Feature: publish-behind-nginx, Property 11: Invite registration is atomic
  // numRuns stays at 100: only valid, conflict, and lateInvalid attempts reach scrypt (weight 5 of 13), and at
  // most one attempt per run can succeed, so a run averages well under one hash.
  test('Property 11: new users equal 200 responses, each joins the trip, failures leave nothing, used_by marks the winner', async () => {
    let now = Date.now();
    const send = via(await open({ now: () => now }));
    // One link that stays expired for every run.
    const expired = (await ownerInvite(send)).token;
    now += INVITE_TTL_MS + 1;
    const session = await ownerLogin(send);

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
      const usersBefore = await userCount();
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
        const res = await registerVia(send, target, body);
        expect(res.status).toBe(expected);
        const result = await res.json();
        if (expected === 200) {
          expect(result.tripId).toBe(tripId);
          expect(result.user.username).toBe(body.username);
          winner = result.user;
        }
      }

      expect(await userCount()).toBe(usersBefore + (winner ? 1 : 0));
      for (const username of tried) {
        const row = await userRow(username);
        expect(row?.id ?? null).toBe(username === winner?.username ? winner.id : null);
      }
      const members = (await query('SELECT user_id FROM trip_members WHERE trip_id = ?', tripId)).map(r => r.user_id);
      expect(members.length).toBe(winner ? 2 : 1);
      if (winner) expect(members).toContain(winner.id);
      expect((await query('SELECT people_count FROM trips WHERE id = ?', tripId))[0].people_count).toBe(members.length);
      const row = await inviteRow(token);
      expect(row.used_by).toBe(winner ? winner.id : null);
      expect(row.used_at === null).toBe(!winner);
      expect((await inviteRow(expired)).used_by).toBeNull();
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
  const withSeed = seed => ({ receiptAiPolicySeed: seed });
  let tripId, admin, member, calls = 0;

  // A fake configured provider; `calls` counts how often recognition reached it.
  const fakeAi = () => ({
    status: { enabled: true, provider: 'OpenAI', modelId: 'gpt-6-luna', maxImageBytes: AI_IMAGE_LIMIT },
    recognize: async () => { calls++; return { store: '', date: '', totalCents: 0, items: [], warnings: [] }; }
  });

  // The admin owns one trip and the member joined it through an invite, so both can edit.
  beforeAll(async () => {
    ({ admin, member } = await seedAccounts());
    const seedAccountsService = await createAccountService({ db: serviceDb(db.sql) });
    const send = createHttpHandler({ root: DIST, accounts: seedAccountsService });
    try {
      const trip = await direct(send, 'POST', '/api/trips', { cookie: admin.cookie, body: { title: '收據測試', startDate: '2025-07-01', endDate: '2025-07-02', expectedUserId: admin.id } });
      if (trip.status !== 201) throw new Error(`seed trip failed: ${trip.status} ${await trip.text()}`);
      tripId = (await trip.json()).trip.id;
      const invite = await direct(send, 'POST', `/api/trips/${tripId}/invites`, { cookie: admin.cookie, body: { expectedUserId: admin.id } });
      const { token } = await invite.json();
      const joined = await direct(send, 'POST', `/api/invites/${token}/join`, { cookie: member.cookie, body: { name: '收據旅伴', role: '採買', expectedUserId: member.id } });
      if (joined.status !== 200) throw new Error(`seed join failed: ${joined.status} ${await joined.text()}`);
    } finally {
      seedAccountsService.close();
    }
  }, 60_000);
  // Every test starts with nothing in the Settings_Store; afterEach has already closed the services.
  beforeEach(async () => {
    await db.sql`DELETE FROM settings`;
    calls = 0;
  });

  const openAi = (options = {}, { receiptAi = fakeAi() } = {}) => open({ ...options, receiptAi });
  const status = async (handler, who) => {
    const res = await direct(handler, 'GET', `/api/trips/${tripId}/receipt-ai`, { cookie: who.cookie });
    expect(res.status).toBe(200);
    return res.json();
  };
  const recognize = (handler, who) => handler(new Request(`${LOCAL_BASE}/api/trips/${tripId}/receipt-ai`, {
    method: 'POST',
    headers: {
      host: LOCAL_HOST, origin: LOCAL_BASE, cookie: who.cookie,
      'content-type': 'image/png', 'x-camping-user-id': who.id, 'x-receipt-consent': 'openai-v1'
    },
    body: png
  }), loopbackPeer);
  const setPolicy = (handler, who, receiptAiPolicy) => direct(handler, 'PATCH', '/api/admin/settings', { cookie: who.cookie, body: { receiptAiPolicy } });
  const settings = async handler => {
    const res = await direct(handler, 'GET', '/api/admin/settings', { cookie: admin.cookie });
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
    const handler = await openAi();
    let expectedCalls = 0;
    // `off` first, then back to `all`, so every transition happens on one running service.
    for (const policy of ['off', 'admins', 'all', 'off', 'all']) {
      const res = await setPolicy(handler, admin, policy);
      expect(res.status).toBe(200);
      expect((await res.json()).receiptAiPolicy).toMatchObject({ value: policy, source: 'stored', updatedBy: 'admin-one' });
      const audit = await (await direct(handler, 'GET', '/api/admin/audit', { cookie: admin.cookie })).json();
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
    const handler = await openAi({}, { receiptAi: null });
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

  test('with nothing stored the seed applies, and without a seed the default is all', async () => {
    for (const seed of OPTIONS) {
      const handler = await openAi(withSeed(seed));
      expect(await settings(handler)).toEqual({ value: seed, source: 'seed', updatedAt: null, updatedBy: null, options: OPTIONS });
      const want = MATRIX[seed][1];
      expect((await status(handler, member)).enabled).toBe(want.enabled);
      await expectOutcome(await recognize(handler, member), want.post);
    }
    const unseeded = await openAi();
    expect(await settings(unseeded)).toEqual({ value: 'all', source: 'default', updatedAt: null, updatedBy: null, options: OPTIONS });
    await expectOutcome(await recognize(unseeded, member), 200);
  });

  test('GET /api/admin/settings reports the stored value, time, and admin', async () => {
    const handler = await openAi(withSeed('off'));
    const before = Date.now();
    expect((await setPolicy(handler, admin, 'admins')).status).toBe(200);
    const body = await settings(handler);
    expect(Object.keys(body).sort()).toEqual(['options', 'source', 'updatedAt', 'updatedBy', 'value']);
    expect(body).toMatchObject({ value: 'admins', source: 'stored', updatedBy: 'admin-one', options: OPTIONS });
    expect(new Date(body.updatedAt).toISOString()).toBe(body.updatedAt);
    expect(Date.parse(body.updatedAt)).toBeGreaterThanOrEqual(before - 1000);
  });

  test('a member gets 403 for GET and PATCH, and invalid values get 400, leaving the stored value unchanged', async () => {
    const handler = await openAi();
    expect((await setPolicy(handler, admin, 'admins')).status).toBe(200);
    const stored = await settings(handler);
    const policyAudits = async () => (await (await direct(handler, 'GET', '/api/admin/audit', { cookie: admin.cookie })).json())
      .events.filter(e => e.action === 'settings.receipt-ai');
    const auditsBefore = await policyAudits();
    expect(auditsBefore[0].target).toBe('receiptAiPolicy:admins');
    expect((await direct(handler, 'GET', '/api/admin/settings', { cookie: member.cookie })).status).toBe(403);
    for (const value of ['all', 'off']) expect((await setPolicy(handler, member, value)).status).toBe(403);
    for (const value of ['ALL', 'none', '', ' all', null, 7, true, ['all'], undefined]) {
      const res = await setPolicy(handler, admin, value);
      expect(res.status).toBe(400);
      // undefined drops the key, so the body is {} and neither setting is present (Req 26.7).
      expect(await res.json()).toEqual({ error: value === undefined ? '請至少提供一項設定。' : INVALID_POLICY });
    }
    expect(await settings(handler)).toEqual(stored);
    await expectOutcome(await recognize(handler, member), { status: 403, error: ADMINS_ONLY });
    // Rejected changes write no audit entry.
    expect(await policyAudits()).toEqual(auditsBefore);
  });

  test('the Database keeps the stored value across service instances, and it beats the seed', async () => {
    const first = await openAi(withSeed('all'));
    expect((await setPolicy(first, admin, 'off')).status).toBe(200);
    while (opened.length) opened.pop().close();

    const second = await openAi(withSeed('all'));
    expect(await settings(second)).toMatchObject({ value: 'off', source: 'stored', updatedBy: 'admin-one' });
    await expectOutcome(await recognize(second, admin), { status: 503, error: TURNED_OFF });
    expect((await setPolicy(second, admin, 'admins')).status).toBe(200);
    while (opened.length) opened.pop().close();

    const third = await openAi();
    expect(await settings(third)).toMatchObject({ value: 'admins', source: 'stored' });
    await expectOutcome(await recognize(third, member), { status: 403, error: ADMINS_ONLY });
    await expectOutcome(await recognize(third, admin), 200);
  });
});
