// Invite_List examples: listing scope, no secrets in the response, exclusion of closed links,
// newest-first order, and the Invite_ID migration (Req 19.1–19.7, 19.9, 13.20).
// Accounts are created once in a seed database; each test opens its own copy so scrypt runs only a few times.
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import fc from 'fast-check';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { createAccountService } from '../server/accounts.js';

const BASE = 'http://127.0.0.1:5181';
const PASS = 'correct horse battery';
const T0 = Date.parse('2026-11-04T00:00:00Z');
const NO_TRIP = '找不到這趟旅行。';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENTRY_KEYS = ['createdAt', 'creatorName', 'expiresAt', 'id'];
const sha256 = value => createHash('sha256').update(value).digest('hex');

let root, seedPath;
const accounts = {}; // username -> { cookie, user }
let svc, clockMs, dbPath, testDir;
const extra = [];

async function rawCall(service, method, path, { body, cookie, origin = BASE } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await service.handle(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const call = (method, path, opts) => rawCall(svc, method, path, opts);
const ok = (res, status = 200) => { if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`); return res.body; };
const failed = (res, status, message) => {
  expect(res.status).toBe(status);
  expect(res.body).toEqual({ error: message });
};
const as = name => accounts[name].cookie;

const card = (extra = {}) => ({ title: '週末露營', destination: '湖邊營地', startDate: '2026-11-20', endDate: '2026-11-22', description: '一起出發', note: '帶外套', coverKind: 'lake', status: 'planning', ...extra });
const createTrip = async (cookie, extra) => ok(await call('POST', '/api/trips', { cookie, body: card(extra) }), 201).trip;
const invite = async (cookie, tripId) => ok(await call('POST', `/api/trips/${tripId}/invites`, { cookie, body: {} }), 201);
const join = (cookie, token, name) => call('POST', `/api/invites/${token}/join`, { cookie, body: { name } });
const revoke = (cookie, tripId, inviteId) => call('POST', `/api/trips/${tripId}/invites/${inviteId}/revoke`, { cookie, body: {} });
// No Origin header: the list is a GET and needs none.
const list = (cookie, tripId) => call('GET', `/api/trips/${tripId}/invites`, { cookie, origin: null });
const listed = async (cookie, tripId) => ok(await list(cookie, tripId)).invites;
const ids = entries => entries.map(e => e.id);

function query(sql, ...params) {
  const db = new Database(dbPath);
  try { return db.query(sql).all(...params); } finally { db.close(); }
}

function openService() {
  const service = createAccountService({ dbPath, now: () => clockMs });
  extra.push(service);
  return service;
}

/** Owner trip with member-one and member-two joined through owner links (those links are used). */
async function tripWithMembers() {
  const trip = await createTrip(as('owner-one'));
  for (const [name, display] of [['member-one', '旅伴一'], ['member-two', '旅伴二']]) {
    ok(await join(as(name), (await invite(as('owner-one'), trip.id)).token, display));
  }
  return trip;
}

beforeAll(async () => {
  root = mkdtempSync(joinPath(tmpdir(), 'camping-invite-list-'));
  seedPath = joinPath(root, 'seed.sqlite');
  clockMs = T0;
  const seed = createAccountService({ dbPath: seedPath, now: () => clockMs });
  try {
    const setup = await rawCall(seed, 'POST', '/api/setup', { body: { username: 'admin-one', displayName: '管理員', password: PASS } });
    accounts['admin-one'] = { cookie: setup.cookie, user: ok(setup).user };
    for (const [username, displayName] of [['admin-two', '副管理員'], ['owner-one', '主辦人'], ['member-one', '旅伴一'], ['member-two', '旅伴二'], ['outsider-one', '路人']]) {
      const res = await rawCall(seed, 'POST', '/api/register', { body: { username, displayName, password: PASS } });
      accounts[username] = { cookie: res.cookie, user: ok(res).user };
    }
    ok(await rawCall(seed, 'PATCH', `/api/admin/users/${accounts['admin-two'].user.id}`, { cookie: accounts['admin-one'].cookie, body: { role: 'admin' } }));
  } finally {
    seed.close();
  }
});

// Every test starts from a copy of the seed database, one second after the seed sessions began.
function fresh() {
  testDir = mkdtempSync(joinPath(root, 'case-'));
  dbPath = joinPath(testDir, 'accounts.sqlite');
  copyFileSync(seedPath, dbPath);
  for (const suffix of ['-wal', '-shm']) if (existsSync(seedPath + suffix)) copyFileSync(seedPath + suffix, dbPath + suffix);
  clockMs = T0 + 1000;
  svc = openService();
}

afterEach(() => {
  while (extra.length) extra.pop().close();
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = null;
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('invite list scope', () => {
  test('owner and admin outside the trip see every Active_Invite; a Trip_Member sees only their own', async () => {
    fresh();
    const trip = await tripWithMembers();
    clockMs += 1000;
    const ownerLink = await invite(as('owner-one'), trip.id);
    clockMs += 1000;
    const m1At = clockMs;
    const m1 = await invite(as('member-one'), trip.id);
    clockMs += 1000;
    const m2 = await invite(as('member-two'), trip.id);
    clockMs += 1000;
    const adminLink = await invite(as('admin-two'), trip.id);
    const all = [adminLink.id, m2.id, m1.id, ownerLink.id];

    expect(ids(await listed(as('owner-one'), trip.id))).toEqual(all);
    expect(ids(await listed(as('admin-two'), trip.id))).toEqual(all);
    expect(ids(await listed(as('member-one'), trip.id))).toEqual([m1.id]);
    expect(ids(await listed(as('member-two'), trip.id))).toEqual([m2.id]);

    const ownerView = await listed(as('owner-one'), trip.id);
    expect(ownerView.find(e => e.id === m1.id)).toEqual({
      id: m1.id, creatorName: '旅伴一', createdAt: new Date(m1At).toISOString(), expiresAt: m1.expiresAt
    });
    expect(ownerView.map(e => e.creatorName)).toEqual(['副管理員', '旅伴二', '旅伴一', '主辦人']);
  });

  test('outsider gets 404, no session gets 401, and an empty list is 200', async () => {
    fresh();
    const trip = await createTrip(as('owner-one'));
    expect(await listed(as('owner-one'), trip.id)).toEqual([]);
    await invite(as('owner-one'), trip.id);
    failed(await list(as('outsider-one'), trip.id), 404, NO_TRIP);
    failed(await list(as('outsider-one'), '00000000-0000-4000-8000-000000000000'), 404, NO_TRIP);
    failed(await list(undefined, trip.id), 401, '請先登入。');
    const withOrigin = await call('GET', `/api/trips/${trip.id}/invites`, { cookie: as('owner-one') });
    expect(withOrigin.status).toBe(200);
    expect(withOrigin.body.invites).toHaveLength(1);
  });
});

describe('invite list exposes no secrets', () => {
  test('the body has no token, token hash, account id or username, and entries have exactly four keys', async () => {
    fresh();
    const trip = await tripWithMembers();
    const links = [await invite(as('owner-one'), trip.id), await invite(as('member-one'), trip.id), await invite(as('admin-two'), trip.id)];
    for (const viewer of ['owner-one', 'admin-two', 'member-one']) {
      const res = await list(as(viewer), trip.id);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).toEqual(['invites']);
      for (const entry of res.body.invites) expect(Object.keys(entry).sort()).toEqual(ENTRY_KEYS);
      for (const link of links) {
        expect(res.text).not.toContain(link.token);
        expect(res.text).not.toContain(sha256(link.token));
      }
      for (const [username, { user }] of Object.entries(accounts)) {
        expect(res.text).not.toContain(user.id);
        expect(res.text).not.toContain(username);
      }
    }
  });
});

describe('invite list contents', () => {
  test('used, expired and revoked invites are left out; the rest is newest first', async () => {
    fresh();
    const trip = await createTrip(as('owner-one'));
    const used = await invite(as('owner-one'), trip.id);
    clockMs += 1000;
    const expired = await invite(as('owner-one'), trip.id);
    clockMs += 1000;
    const revoked = await invite(as('owner-one'), trip.id);
    clockMs += 1000;
    const older = await invite(as('owner-one'), trip.id);
    clockMs += 1000;
    const newer = await invite(as('owner-one'), trip.id);
    expect(ids(await listed(as('owner-one'), trip.id))).toEqual([newer.id, older.id, revoked.id, expired.id, used.id]);

    ok(await join(as('member-one'), used.token, '旅伴一'));
    ok(await revoke(as('owner-one'), trip.id, revoked.id));
    // Expired at exactly the current time counts as expired.
    query('UPDATE invites SET expires_at = ? WHERE id = ?', clockMs, expired.id);
    expect(ids(await listed(as('owner-one'), trip.id))).toEqual([newer.id, older.id]);
    expect(ids(await listed(as('admin-two'), trip.id))).toEqual([newer.id, older.id]);
    // The member who joined created none of the open links.
    expect(await listed(as('member-one'), trip.id)).toEqual([]);
  });
});

describe('Invite_ID migration', () => {
  test('a pre-feature invites table gets distinct UUID ids that persist, and the old links list and revoke by id', async () => {
    fresh();
    const trip = await createTrip(as('owner-one'));
    const tokens = [];
    for (let i = 0; i < 3; i++) { clockMs += 1000; tokens.push((await invite(as('owner-one'), trip.id)).token); }
    svc.close(); extra.length = 0;

    // Rewrite the table to the schema from before this feature: no used_at, used_by or id.
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE invites_old (
        token_hash TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id), created_by TEXT NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
      );
      INSERT INTO invites_old SELECT token_hash, trip_id, created_by, created_at, expires_at, revoked_at FROM invites;
      DROP TABLE invites;
      ALTER TABLE invites_old RENAME TO invites;
      CREATE INDEX invites_trip ON invites(trip_id);`);
    const before = db.query('SELECT token_hash, trip_id, created_by, created_at, expires_at, revoked_at FROM invites ORDER BY token_hash').all();
    db.close();
    expect(before).toHaveLength(3);
    expect(query('PRAGMA table_info(invites)').map(c => c.name)).not.toContain('id');

    svc = openService();
    const after = query('SELECT token_hash, trip_id, created_by, created_at, expires_at, revoked_at, id FROM invites ORDER BY token_hash');
    expect(after.map(({ id: inviteId, ...rest }) => rest)).toEqual(before);
    expect(after.every(r => typeof r.id === 'string' && UUID.test(r.id))).toBe(true);
    expect(new Set(after.map(r => r.id)).size).toBe(3);
    expect(query('PRAGMA index_list(invites)').find(i => i.name === 'invites_id')?.unique).toBe(1);

    // The unique index rejects a second row with an existing id.
    const raw = new Database(dbPath);
    try {
      expect(() => raw.query('INSERT INTO invites (token_hash, trip_id, created_by, created_at, expires_at, id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(sha256('duplicate'), trip.id, accounts['owner-one'].user.id, clockMs, clockMs + 1000, after[0].id)).toThrow();
    } finally { raw.close(); }

    // Reopening keeps the same ids.
    svc.close(); extra.length = 0;
    svc = openService();
    expect(query('SELECT token_hash, id FROM invites ORDER BY token_hash')).toEqual(after.map(r => ({ token_hash: r.token_hash, id: r.id })));

    // The old links appear in the list, newest first, and revoke by their new id.
    const idOf = token => after.find(r => r.token_hash === sha256(token)).id;
    const expected = [...tokens].reverse().map(idOf);
    expect(ids(await listed(as('owner-one'), trip.id))).toEqual(expected);
    ok(await revoke(as('owner-one'), trip.id, expected[1]));
    expect(ids(await listed(as('owner-one'), trip.id))).toEqual([expected[0], expected[2]]);
  });
});

describe('invite list and revoke-by-id properties', () => {
  const DAY = 86400000;
  const INVALID = '邀請連結無效或已過期。';
  const NOT_ALLOWED = '只有建立連結的人、主辦人或管理員可以撤銷邀請。';
  const MANAGERS = new Set(['owner-one', 'admin-two']); // trip owner and an admin outside the trip
  const CREATORS = ['owner-one', 'member-one', 'member-two'];
  const DISPLAY = { 'owner-one': '主辦人', 'member-one': '旅伴一', 'member-two': '旅伴二' };
  const POOL = [['joiner-one', '加入者一'], ['joiner-two', '加入者二'], ['joiner-three', '加入者三']];
  const RUN_START = T0 + 10000;
  let propSeedPath, propTrip, otherTrip;

  // A second seed, built once: the pool accounts (the only scrypt cost), a trip with member-one and
  // member-two, and another trip by the same owner. Sessions are stretched so clock advances keep them valid.
  async function propertySeed() {
    if (propSeedPath) return;
    fresh();
    for (const [username, displayName] of POOL) {
      const res = await call('POST', '/api/register', { body: { username, displayName, password: PASS } });
      accounts[username] = { cookie: res.cookie, user: ok(res).user };
    }
    propTrip = (await tripWithMembers()).id;
    otherTrip = (await createTrip(as('owner-one'), { title: '另一趟旅行' })).id;
    query('UPDATE sessions SET expires_at = ?', T0 + 365 * DAY);
    svc.close(); extra.length = 0;
    propSeedPath = joinPath(root, 'prop-seed.sqlite');
    copyFileSync(dbPath, propSeedPath);
    for (const suffix of ['-wal', '-shm']) if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, propSeedPath + suffix);
    rmSync(testDir, { recursive: true, force: true });
    testDir = null;
  }

  // Each run gets its own copy of the property seed.
  function runCopy() {
    while (extra.length) extra.pop().close();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
    testDir = mkdtempSync(joinPath(root, 'run-'));
    dbPath = joinPath(testDir, 'accounts.sqlite');
    copyFileSync(propSeedPath, dbPath);
    for (const suffix of ['-wal', '-shm']) if (existsSync(propSeedPath + suffix)) copyFileSync(propSeedPath + suffix, dbPath + suffix);
    clockMs = RUN_START;
    svc = openService();
  }

  const isActive = (m, now) => !m.used && !m.revoked && m.expiresAt > now;
  const snapshot = () => query('SELECT * FROM invites ORDER BY token_hash');
  const revokeAudits = () => query("SELECT actor, action, target FROM audit WHERE action = 'invite.revoke' ORDER BY id");

  // Feature: publish-behind-nginx, Property 16: The invite list shows exactly the revocable Active_Invites and never exposes tokens
  test('Property 16: the invite list shows exactly the revocable Active_Invites and never exposes tokens', async () => {
    await propertySeed();
    const op = fc.oneof(
      { weight: 4, arbitrary: fc.record({ kind: fc.constant('create'), creator: fc.constantFrom(...CREATORS) }) },
      { weight: 2, arbitrary: fc.record({ kind: fc.constant('consume'), pick: fc.nat() }) },
      { weight: 2, arbitrary: fc.record({ kind: fc.constant('revoke'), pick: fc.nat() }) },
      { weight: 1, arbitrary: fc.record({ kind: fc.constant('advance'), ms: fc.constantFrom(1000, DAY, 3 * DAY, 7 * DAY) }) }
    );
    await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 14 }), async ops => {
      runCopy();
      const model = [];
      let joined = 0;
      const checkViews = async () => {
        for (const viewer of ['owner-one', 'admin-two', 'member-one', 'member-two']) {
          const expected = model
            .filter(m => isActive(m, clockMs) && (MANAGERS.has(viewer) || m.creator === viewer))
            .sort((a, b) => b.createdAt - a.createdAt);
          const res = await list(as(viewer), propTrip);
          expect(res.status).toBe(200);
          expect(Object.keys(res.body)).toEqual(['invites']);
          expect(ids(res.body.invites)).toEqual(expected.map(m => m.id));
          res.body.invites.forEach((entry, i) => {
            expect(Object.keys(entry).sort()).toEqual(ENTRY_KEYS);
            expect(entry).toEqual({
              id: expected[i].id, creatorName: DISPLAY[expected[i].creator],
              createdAt: new Date(expected[i].createdAt).toISOString(), expiresAt: new Date(expected[i].expiresAt).toISOString()
            });
          });
          for (const m of model) {
            expect(res.text).not.toContain(m.token);
            expect(res.text).not.toContain(sha256(m.token));
          }
          for (const [username, { user }] of Object.entries(accounts)) {
            expect(res.text).not.toContain(user.id);
            expect(res.text).not.toContain(username);
          }
        }
      };
      for (const step of ops) {
        if (step.kind === 'create') {
          clockMs += 1; // strictly newer than every earlier link
          const active = model.filter(m => isActive(m, clockMs));
          const expectedStatus = active.length >= 20 ? 409
            : !MANAGERS.has(step.creator) && active.filter(m => m.creator === step.creator).length >= 5 ? 409 : 201;
          const res = await call('POST', `/api/trips/${propTrip}/invites`, { cookie: as(step.creator), body: {} });
          expect(res.status).toBe(expectedStatus);
          if (res.status === 201) model.push({ id: res.body.id, token: res.body.token, creator: step.creator, createdAt: clockMs, expiresAt: clockMs + 7 * DAY, used: false, revoked: false });
        } else if (step.kind === 'consume') {
          if (!model.length || joined >= POOL.length) continue;
          const target = model[step.pick % model.length];
          const [username, name] = POOL[joined];
          const res = await join(as(username), target.token, name);
          const live = isActive(target, clockMs);
          expect(res.status).toBe(live ? 200 : 404);
          if (live) { target.used = true; joined++; }
        } else if (step.kind === 'revoke') {
          if (!model.length) continue;
          const target = model[step.pick % model.length];
          const res = await revoke(as('owner-one'), propTrip, target.id);
          const live = isActive(target, clockMs);
          expect(res.status).toBe(live ? 200 : 404);
          if (live) target.revoked = true;
        } else {
          clockMs += step.ms;
        }
        await checkViews();
      }
    }), { numRuns: 100 });
  }, 120000);

  // Feature: publish-behind-nginx, Property 17: Revoke by id follows the creator-or-manager rule
  test('Property 17: revoke by id follows the creator-or-manager rule', async () => {
    await propertySeed();
    // Strings that are not the id of any invite: bad characters, too long, or well-formed but unknown.
    const malformed = fc.oneof(
      fc.constantFrom('not-an-id!', 'null', '<script>', '%', ' ', 'é', 'x'.repeat(65)),
      fc.string({ unit: fc.constantFrom('a', 'Z', '9', '-', '_', '~', '!', 'é', '露', ' ', '%', '.'), minLength: 1, maxLength: 70 })
    ).filter(s => !/^\.+$/.test(s)).map(encodeURIComponent);
    const idKind = fc.oneof(
      fc.constant({ kind: 'own' }),
      fc.constant({ kind: 'own-upper' }),
      fc.constant({ kind: 'other-trip' }),
      fc.uuid().map(value => ({ kind: 'unknown', value })),
      malformed.map(value => ({ kind: 'malformed', value }))
    );
    const scenario = fc.record({
      creator: fc.constantFrom(...CREATORS),
      actor: fc.constantFrom('owner-one', 'admin-two', 'member-one', 'member-two', 'outsider-one', 'none'),
      state: fc.constantFrom('active', 'used', 'expired', 'revoked'),
      target: idKind
    });
    await fc.assert(fc.asyncProperty(scenario, async ({ creator, actor, state, target }) => {
      runCopy();
      const link = await invite(as(creator), propTrip);
      const otherLink = await invite(as('owner-one'), otherTrip);
      if (state === 'used') ok(await join(as(POOL[0][0]), link.token, POOL[0][1]));
      if (state === 'revoked') ok(await revoke(as('owner-one'), propTrip, link.id));
      if (state === 'expired') clockMs += 7 * DAY; // expires_at == now is already expired
      clockMs += 1000;
      const inviteId = target.kind === 'own' ? link.id
        : target.kind === 'own-upper' ? link.id.toUpperCase()
        : target.kind === 'other-trip' ? otherLink.id : target.value;
      const before = snapshot(), auditsBefore = revokeAudits();

      const res = await revoke(actor === 'none' ? undefined : as(actor), propTrip, inviteId);

      const names = target.kind === 'own' && state === 'active';
      const expected = actor === 'none' ? [401, { error: '請先登入。' }]
        : actor === 'outsider-one' ? [404, { error: NO_TRIP }]
        : !names ? [404, { error: INVALID }]
        : actor !== creator && !MANAGERS.has(actor) ? [403, { error: NOT_ALLOWED }]
        : [200, { revoked: true }];
      expect([res.status, res.body]).toEqual(expected);

      const after = snapshot(), auditsAfter = revokeAudits();
      if (res.status === 200) {
        expect(after).toEqual(before.map(row => (row.id === link.id ? { ...row, revoked_at: clockMs } : row)));
        expect(auditsAfter).toEqual([...auditsBefore, { actor, action: 'invite.revoke', target: `trip:${propTrip}` }]);
      } else {
        expect(after).toEqual(before);
        expect(auditsAfter).toEqual(auditsBefore);
      }
    }), { numRuns: 200 });
  }, 120000);
});
