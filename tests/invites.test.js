// Invitation examples: signed-out preview, member Inviters, single-use links, the usage-column
// migration and per-link revoke by Invite_ID (Req 15–18, 13.14–13.17).
// Accounts are created once in a seed database; each test opens its own copy so scrypt runs only a few times.
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import fc from 'fast-check';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join as joinPath, resolve } from 'node:path';
import { createAccountService } from '../server/accounts.js';
import { createHttpHandler } from '../server/http.js';
import { LOCAL_DEFAULTS, parseDeploymentConfig } from '../server/deploy-config.js';
import { normalizeParticipantName } from '../src/model.js';

const BASE = 'http://127.0.0.1:5181';
const PASS = 'correct horse battery';
const T0 = Date.parse('2026-11-04T00:00:00Z');
const DAY = 86400000;
const DIST = resolve(import.meta.dir, '..', process.env.CAMPING_DIST || 'dist');
const PUBLIC = 'https://www.our-littlemoments.com';
const PUBLISHED = parseDeploymentConfig({ CAMPING_PUBLISHED: '1', CAMPING_PUBLIC_ORIGIN: PUBLIC });
const INVALID = '邀請連結無效或已過期。';
const NO_TRIP = '找不到這趟旅行。';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const loopbackPeer = { requestIP: () => ({ address: '127.0.0.1' }) };

let root, seedPath;
const accounts = {}; // username -> { cookie, user }
let svc, clockMs, dbPath, testDir;
const extra = [];

async function rawCall(service, method, path, { body, cookie, origin = BASE, info } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await service.handle(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), info);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const call = (method, path, opts) => rawCall(svc, method, path, opts);
const ok = (res, status = 200) => { if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`); return res.body; };
const failed = (res, status, message) => {
  expect(res.status).toBe(status);
  expect(res.body).toEqual(message === undefined ? { error: expect.any(String) } : { error: message });
};
const as = name => accounts[name].cookie;
const id = name => accounts[name].user.id;

const card = (extra = {}) => ({ title: '週末露營', destination: '湖邊營地', startDate: '2026-11-20', endDate: '2026-11-22', description: '一起出發', note: '帶外套', coverKind: 'lake', status: 'planning', ...extra });
const createTrip = async (cookie, extra) => ok(await call('POST', '/api/trips', { cookie, body: card(extra) }), 201).trip;
const getTrip = async (cookie, tripId) => ok(await call('GET', `/api/trips/${tripId}`, { cookie }));
const createInvite = (cookie, tripId) => call('POST', `/api/trips/${tripId}/invites`, { cookie, body: {} });
const invite = async (cookie, tripId) => ok(await createInvite(cookie, tripId), 201);
const join = (cookie, token, name) => call('POST', `/api/invites/${token}/join`, { cookie, body: { name } });
const preview = (token, info) => call('GET', `/api/invites/${token}/preview`, { origin: null, info });
const revoke = (cookie, tripId, inviteId, opts = {}) => call('POST', `/api/trips/${tripId}/invites/${inviteId}/revoke`, { cookie, body: {}, ...opts });
const auditEvents = async () => ok(await call('GET', '/api/admin/audit', { cookie: as('admin-one') })).events;

function query(sql, ...params) {
  const db = new Database(dbPath);
  try { return db.query(sql).all(...params); } finally { db.close(); }
}
const inviteRow = inviteId => query('SELECT used_at, used_by, revoked_at FROM invites WHERE id = ?', inviteId)[0];
const memberCount = tripId => query('SELECT COUNT(*) AS n FROM trip_members WHERE trip_id = ?', tripId)[0].n;

/** Owner trip with member-one (and optionally member-two) joined through owner links. */
async function tripWithMembers(members = ['member-one']) {
  const trip = await createTrip(as('owner-one'));
  for (const name of members) ok(await join(as(name), (await invite(as('owner-one'), trip.id)).token, name));
  return trip;
}

function openService(config) {
  const service = createAccountService({ dbPath, now: () => clockMs, ...(config ? { deployment: config } : {}) });
  extra.push(service);
  return service;
}

beforeAll(async () => {
  root = mkdtempSync(joinPath(tmpdir(), 'camping-invites-'));
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

describe('invitation preview', () => {
  test('a Valid_Invite previews with exactly the public fields, with or without a session', async () => {
    fresh();
    const trip = await createTrip(as('owner-one'));
    const { token } = await invite(as('owner-one'), trip.id);
    const expected = { title: '週末露營', destination: '湖邊營地', startDate: '2026-11-20', endDate: '2026-11-22', inviterName: '主辦人' };
    const signedOut = await preview(token);
    expect(signedOut.status).toBe(200);
    expect(signedOut.body).toEqual(expected);
    expect(Object.keys(signedOut.body).sort()).toEqual(Object.keys(expected).sort());
    const signedIn = await call('GET', `/api/invites/${token}/preview`, { cookie: as('outsider-one'), origin: null });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body).toEqual(expected);
  });

  test('preview and invite page responses carry no-store and no-referrer through createHttpHandler', async () => {
    fresh();
    const trip = await createTrip(as('owner-one'));
    const { token } = await invite(as('owner-one'), trip.id);
    const handler = createHttpHandler({ root: DIST, accounts: svc, config: LOCAL_DEFAULTS });
    const get = path => handler(new Request(BASE + path), loopbackPeer);
    const responses = [
      [await get(`/api/invites/${token}/preview`), 200],
      [await get(`/api/invites/${'0'.repeat(64)}/preview`), 404],
      [await get('/api/invites/not-a-token/preview'), 404]
    ];
    const hasShell = await Bun.file(joinPath(DIST, 'index.html')).exists();
    responses.push([await get(`/invite/${token}`), hasShell ? 200 : 404]);
    for (const [res, status] of responses) {
      expect(res.status).toBe(status);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });

  test('the 61st preview from one Client_Address gets 429 while another address still gets 200', async () => {
    fresh();
    const trip = await createTrip(as('owner-one'));
    const { token } = await invite(as('owner-one'), trip.id);
    const a = { clientAddress: '198.51.100.10' }, b = { clientAddress: '198.51.100.11' };
    for (let i = 0; i < 60; i++) expect((await preview(token, a)).status).toBe(200);
    failed(await preview(token, a), 429, '查看邀請的次數太多，請稍後再試。');
    // Limited before the lookup: an unknown token from the same address is still 429, not 404.
    failed(await preview('0'.repeat(64), a), 429, '查看邀請的次數太多，請稍後再試。');
    expect((await preview(token, b)).status).toBe(200);
    clockMs += 15 * 60000;
    expect((await preview(token, a)).status).toBe(200);
  });

  test('preview leaves the link unused and the trip unchanged', async () => {
    fresh();
    const trip = await createTrip(as('owner-one'));
    const created = await invite(as('owner-one'), trip.id);
    const before = query('SELECT revision, state_json FROM trips WHERE id = ?', trip.id)[0];
    for (let i = 0; i < 3; i++) expect((await preview(created.token)).status).toBe(200);
    expect(inviteRow(created.id)).toEqual({ used_at: null, used_by: null, revoked_at: null });
    expect(query('SELECT revision, state_json FROM trips WHERE id = ?', trip.id)[0]).toEqual(before);
    expect(memberCount(trip.id)).toBe(1);
    ok(await join(as('member-one'), created.token, '旅伴一'));
  });

  test('GET /api/invites/<token> still needs a session', async () => {
    fresh();
    const trip = await createTrip(as('owner-one'));
    const { token } = await invite(as('owner-one'), trip.id);
    failed(await call('GET', `/api/invites/${token}`, { origin: null }), 401, '請先登入。');
    failed(await call('GET', `/api/invites/${'0'.repeat(64)}`, { origin: null }), 401, '請先登入。');
  });
});

describe('trip members can invite', () => {
  test('canInvite capability for owner, Trip_Member, admin outside the trip and outsider', async () => {
    fresh();
    const trip = await tripWithMembers();
    for (const [name, expected] of [['owner-one', true], ['member-one', true], ['admin-two', true]]) {
      const env = await getTrip(as(name), trip.id);
      expect(env.permissions.canInvite).toBe(expected);
      expect(env.trip.canInvite).toBe(expected);
      const listed = ok(await call('GET', '/api/trips', { cookie: as(name) })).trips.find(t => t.id === trip.id);
      expect(listed.canInvite).toBe(expected);
    }
    expect((await getTrip(as('member-one'), trip.id)).permissions.canManage).toBe(false);
    expect((await getTrip(as('admin-two'), trip.id)).permissions.canManage).toBe(true);
    failed(await call('GET', `/api/trips/${trip.id}`, { cookie: as('outsider-one') }), 404, NO_TRIP);
    expect(ok(await call('GET', '/api/trips', { cookie: as('outsider-one') })).trips.some(t => t.id === trip.id)).toBe(false);
    failed(await createInvite(as('outsider-one'), trip.id), 404, NO_TRIP);
  });

  test('a Trip_Member creates a link with the invite.create audit entry', async () => {
    fresh();
    const trip = await tripWithMembers();
    const res = await invite(as('member-one'), trip.id);
    expect(Object.keys(res).sort()).toEqual(['expiresAt', 'id', 'token', 'urlPath']);
    expect(res.urlPath).toBe(`/invite/${res.token}`);
    expect(res.expiresAt).toBe(new Date(clockMs + 7 * DAY).toISOString());
    expect((await preview(res.token)).body.inviterName).toBe('旅伴一');
    expect(await auditEvents()).toContainEqual({ at: expect.any(String), actor: 'member-one', action: 'invite.create', target: `trip:${trip.id}` });
  });

  test('the 6th member link is 409 while the owner can still create links', async () => {
    fresh();
    const trip = await tripWithMembers();
    const links = [];
    for (let i = 0; i < 5; i++) links.push(await invite(as('member-one'), trip.id));
    const sixth = await createInvite(as('member-one'), trip.id);
    failed(sixth, 409);
    expect(sixth.body.error).toContain('5');
    await invite(as('owner-one'), trip.id);
    // Only Active_Invites count: revoking one frees a slot.
    ok(await revoke(as('member-one'), trip.id, links[0].id));
    await invite(as('member-one'), trip.id);
  });

  test('deleting an account revokes its links', async () => {
    fresh();
    const trip = await tripWithMembers();
    const memberLink = await invite(as('member-one'), trip.id);
    const ownerLink = await invite(as('owner-one'), trip.id);
    ok(await call('POST', `/api/admin/users/${id('member-one')}/delete`, { cookie: as('admin-one'), body: { confirmUsername: 'member-one' } }));
    expect(inviteRow(memberLink.id).revoked_at).toBe(clockMs);
    failed(await preview(memberLink.token), 404, INVALID);
    expect((await preview(ownerLink.token)).status).toBe(200);
  });

  test('demoting an admin revokes links for trips where the account is neither owner nor member', async () => {
    fresh();
    const trip = await tripWithMembers();
    const outsideLink = await invite(as('admin-two'), trip.id);
    const own = await createTrip(as('admin-two'), { title: '副管理員的旅行' });
    const ownLink = await invite(as('admin-two'), own.id);
    const joined = await createTrip(as('owner-one'), { title: '一起去的旅行' });
    ok(await join(as('admin-two'), (await invite(as('owner-one'), joined.id)).token, '副管理員'));
    const joinedLink = await invite(as('admin-two'), joined.id);
    expect((await preview(outsideLink.token)).status).toBe(200);
    ok(await call('PATCH', `/api/admin/users/${id('admin-two')}`, { cookie: as('admin-one'), body: { role: 'member' } }));
    expect(inviteRow(outsideLink.id).revoked_at).toBe(clockMs);
    failed(await preview(outsideLink.token), 404, INVALID);
    expect(inviteRow(ownLink.id).revoked_at).toBeNull();
    expect(inviteRow(joinedLink.id).revoked_at).toBeNull();
    expect((await preview(ownLink.token)).status).toBe(200);
    expect((await preview(joinedLink.token)).status).toBe(200);
  });

  test("a demoted admin's old link previews as 404 even without the revocation", async () => {
    fresh();
    const trip = await tripWithMembers();
    const link = await invite(as('admin-two'), trip.id);
    // Demote directly in the database so only the creator-rights check stands between the link and a join.
    query("UPDATE users SET role = 'member' WHERE id = ?", id('admin-two'));
    expect(inviteRow(link.id).revoked_at).toBeNull();
    failed(await preview(link.token), 404, INVALID);
    failed(await join(as('member-two'), link.token, '旅伴二'), 404, INVALID);
  });
});

describe('single-use links', () => {
  test('after an Invite_Join a second account gets 404; the joined account and the owner see alreadyMember', async () => {
    fresh();
    const trip = await createTrip(as('owner-one'));
    const link = await invite(as('owner-one'), trip.id);
    expect(ok(await join(as('member-one'), link.token, '旅伴一'))).toEqual({ tripId: trip.id });
    expect(inviteRow(link.id)).toEqual({ used_at: clockMs, used_by: id('member-one'), revoked_at: null });
    failed(await join(as('member-two'), link.token, '旅伴二'), 404, INVALID);
    failed(await call('GET', `/api/invites/${link.token}`, { cookie: as('member-two') }), 404, INVALID);
    failed(await preview(link.token), 404, INVALID);
    const revision = (await getTrip(as('owner-one'), trip.id)).trip.revision;
    expect(ok(await call('GET', `/api/invites/${link.token}`, { cookie: as('member-one') })).alreadyMember).toBe(true);
    expect(ok(await call('GET', `/api/invites/${link.token}`, { cookie: as('owner-one') }))).toEqual({
      title: '週末露營', destination: '湖邊營地', startDate: '2026-11-20', endDate: '2026-11-22', alreadyMember: true
    });
    expect(ok(await join(as('member-one'), link.token, '旅伴一'))).toEqual({ tripId: trip.id });
    expect(ok(await join(as('owner-one'), link.token, '主辦人'))).toEqual({ tripId: trip.id });
    expect((await getTrip(as('owner-one'), trip.id)).trip.revision).toBe(revision);
    expect(memberCount(trip.id)).toBe(2);
    expect(inviteRow(link.id).used_by).toBe(id('member-one'));
  });

  test('after an Invite_Registration a second account gets 404', async () => {
    fresh();
    const trip = await createTrip(as('owner-one'));
    const link = await invite(as('owner-one'), trip.id);
    const reg = await call('POST', `/api/invites/${link.token}/register`, { body: { username: 'new-guest', displayName: '新朋友', password: PASS } });
    expect(ok(reg).tripId).toBe(trip.id);
    const guestId = ok(reg).user.id;
    expect(inviteRow(link.id).used_by).toBe(guestId);
    failed(await join(as('member-two'), link.token, '旅伴二'), 404, INVALID);
    failed(await call('POST', `/api/invites/${link.token}/register`, { body: { username: 'late-guest', displayName: '晚到', password: PASS } }), 404, INVALID);
    expect(query("SELECT 1 FROM users WHERE username = 'late-guest'")).toEqual([]);
    expect(ok(await call('GET', `/api/invites/${link.token}`, { cookie: reg.cookie })).alreadyMember).toBe(true);
    expect(ok(await call('GET', `/api/invites/${link.token}`, { cookie: as('owner-one') })).alreadyMember).toBe(true);
    expect(memberCount(trip.id)).toBe(2);
  });

  test('a failed join leaves used_at NULL and the link still works', async () => {
    fresh();
    const trip = await createTrip(as('owner-one'));
    const link = await invite(as('owner-one'), trip.id);
    failed(await join(as('member-one'), link.token, '主辦人'), 409);
    expect(inviteRow(link.id)).toEqual({ used_at: null, used_by: null, revoked_at: null });
    expect(memberCount(trip.id)).toBe(1);
    ok(await join(as('member-one'), link.token, '旅伴一'));
    expect(inviteRow(link.id).used_by).toBe(id('member-one'));
  });

  test('two concurrent joins through one link add one member', async () => {
    fresh();
    const trip = await createTrip(as('owner-one'));
    const link = await invite(as('owner-one'), trip.id);
    const results = await Promise.all([join(as('member-one'), link.token, '旅伴一'), join(as('member-two'), link.token, '旅伴二')]);
    expect(results.map(r => r.status).sort()).toEqual([200, 404]);
    expect(memberCount(trip.id)).toBe(2);
    expect((await getTrip(as('owner-one'), trip.id)).state.people).toHaveLength(2);
  });

  test('the same single-use rules apply in Published_Mode', async () => {
    fresh();
    svc.close(); extra.length = 0;
    const published = openService(PUBLISHED);
    const handler = createHttpHandler({ root: DIST, accounts: published, config: PUBLISHED });
    const proxied = async (method, path, { cookie, body, xff = '203.0.113.7' } = {}) => {
      const headers = { 'x-forwarded-for': xff, 'x-forwarded-proto': 'https', origin: PUBLIC };
      if (cookie) headers.cookie = cookie;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await handler(new Request('http://www.our-littlemoments.com' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), loopbackPeer);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const trip = ok(await proxied('POST', '/api/trips', { cookie: as('owner-one'), body: card() }), 201).trip;
    const joinLink = ok(await proxied('POST', `/api/trips/${trip.id}/invites`, { cookie: as('owner-one'), body: {} }), 201);
    ok(await proxied('POST', `/api/invites/${joinLink.token}/join`, { cookie: as('member-one'), body: { name: '旅伴一' } }));
    failed(await proxied('POST', `/api/invites/${joinLink.token}/join`, { cookie: as('member-two'), body: { name: '旅伴二' } }), 404, INVALID);
    failed(await proxied('GET', `/api/invites/${joinLink.token}/preview`), 404, INVALID);
    expect(ok(await proxied('GET', `/api/invites/${joinLink.token}`, { cookie: as('owner-one') })).alreadyMember).toBe(true);

    const regLink = ok(await proxied('POST', `/api/trips/${trip.id}/invites`, { cookie: as('owner-one'), body: {} }), 201);
    ok(await proxied('POST', `/api/invites/${regLink.token}/register`, { body: { username: 'pub-guest', displayName: '新朋友', password: PASS } }));
    failed(await proxied('POST', `/api/invites/${regLink.token}/join`, { cookie: as('member-two'), body: { name: '旅伴二' } }), 404, INVALID);
    expect(memberCount(trip.id)).toBe(3);
  });
});

describe('invites usage-column migration', () => {
  test('an old invites table upgrades in place with rows kept and the old link usable once', async () => {
    fresh();
    const trip = await createTrip(as('owner-one'));
    const live = await invite(as('owner-one'), trip.id);
    const revoked = await invite(as('owner-one'), trip.id);
    ok(await revoke(as('owner-one'), trip.id, revoked.id));
    svc.close(); extra.length = 0;

    // Rewrite the table to the schema from before single-use invites: no used_at, used_by or id.
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
    expect(before).toHaveLength(2);

    svc = openService();
    const columns = query('PRAGMA table_info(invites)').map(c => c.name);
    expect(columns).toEqual(expect.arrayContaining(['used_at', 'used_by', 'id']));
    const after = query('SELECT token_hash, trip_id, created_by, created_at, expires_at, revoked_at, used_at, used_by, id FROM invites ORDER BY token_hash');
    expect(after.map(({ used_at, used_by, id: inviteId, ...rest }) => rest)).toEqual(before);
    expect(after.every(r => r.used_at === null && r.used_by === null && UUID.test(r.id))).toBe(true);
    expect(new Set(after.map(r => r.id)).size).toBe(2);
    expect(query('PRAGMA foreign_key_check')).toEqual([]);

    expect((await preview(live.token)).status).toBe(200);
    failed(await preview(revoked.token), 404, INVALID);
    ok(await join(as('member-one'), live.token, '旅伴一'));
    failed(await join(as('member-two'), live.token, '旅伴二'), 404, INVALID);
    expect(query('SELECT used_by FROM invites WHERE token_hash = ?', sha256(live.token))[0].used_by).toBe(id('member-one'));
  });
});

describe('per-link revoke by Invite_ID', () => {
  test('the create response has a UUID id that is neither the token nor its hash', async () => {
    fresh();
    const trip = await createTrip(as('owner-one'));
    const res = await invite(as('owner-one'), trip.id);
    expect(res.id).toMatch(UUID);
    expect(res.token).toMatch(/^[a-f0-9]{64}$/);
    expect(res.id).not.toBe(res.token);
    expect(res.id).not.toBe(sha256(res.token));
    expect(query('SELECT token_hash FROM invites WHERE id = ?', res.id)).toEqual([{ token_hash: sha256(res.token) }]);
  });

  test('creator, owner and admin outside the trip revoke with 200 and invite.revoke; the link then previews 404', async () => {
    fresh();
    const trip = await tripWithMembers();
    const links = [await invite(as('member-one'), trip.id), await invite(as('member-one'), trip.id), await invite(as('member-one'), trip.id)];
    const actors = ['member-one', 'owner-one', 'admin-two'];
    for (const [i, actor] of actors.entries()) {
      const res = await revoke(as(actor), trip.id, links[i].id);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ revoked: true });
      expect(inviteRow(links[i].id).revoked_at).toBe(clockMs);
      failed(await preview(links[i].token), 404, INVALID);
    }
    const events = (await auditEvents()).filter(e => e.action === 'invite.revoke');
    expect(events.map(e => e.actor).sort()).toEqual([...actors].sort());
    expect(events.every(e => e.target === `trip:${trip.id}`)).toBe(true);
  });

  test("another Trip_Member gets 403 and the link stays active", async () => {
    fresh();
    const trip = await tripWithMembers(['member-one', 'member-two']);
    const link = await invite(as('member-one'), trip.id);
    failed(await revoke(as('member-two'), trip.id, link.id), 403, '只有建立連結的人、主辦人或管理員可以撤銷邀請。');
    expect(inviteRow(link.id).revoked_at).toBeNull();
    expect((await preview(link.token)).status).toBe(200);
  });

  test('malformed, unknown, other-trip, used, revoked and expired ids are 404 and change nothing', async () => {
    fresh();
    const trip = await tripWithMembers();
    const other = await createTrip(as('owner-one'), { title: '另一趟' });
    const otherLink = await invite(as('owner-one'), other.id);
    const used = await invite(as('owner-one'), trip.id);
    ok(await join(as('member-two'), used.token, '旅伴二'));
    const revoked = await invite(as('owner-one'), trip.id);
    ok(await revoke(as('owner-one'), trip.id, revoked.id));
    const live = await invite(as('owner-one'), trip.id);
    const snapshot = () => query('SELECT id, used_at, used_by, revoked_at FROM invites ORDER BY id');
    const before = snapshot();
    for (const inviteId of ['bad%20id', 'x'.repeat(65), '00000000-0000-4000-8000-000000000000', otherLink.id, used.id, revoked.id]) {
      failed(await revoke(as('owner-one'), trip.id, inviteId), 404, INVALID);
    }
    expect(snapshot()).toEqual(before);
    expect((await preview(otherLink.token)).status).toBe(200);
    expect((await preview(live.token)).status).toBe(200);

    clockMs = T0 + 7 * DAY + 2000; // past the link expiry; seed sessions have expired too
    const relogin = await call('POST', '/api/login', { body: { username: 'owner-one', password: PASS } });
    ok(relogin);
    const ownerCookie = relogin.cookie;
    failed(await revoke(ownerCookie, trip.id, live.id), 404, INVALID);
    expect(snapshot()).toEqual(before);
  });

  test('outsider 404, no session 401, foreign Origin 403, and no token-based revoke route', async () => {
    fresh();
    const trip = await tripWithMembers();
    const link = await invite(as('member-one'), trip.id);
    failed(await revoke(as('outsider-one'), trip.id, link.id), 404, NO_TRIP);
    failed(await revoke(as('outsider-one'), '00000000-0000-4000-8000-000000000000', link.id), 404, NO_TRIP);
    failed(await revoke(undefined, trip.id, link.id), 401, '請先登入。');
    failed(await revoke(as('member-one'), trip.id, link.id, { origin: 'http://evil.example' }), 403, '請求來源不被允許。');
    failed(await revoke(as('member-one'), trip.id, link.id, { origin: null }), 403, '請求來源不被允許。');
    failed(await call('POST', `/api/invites/${link.token}/revoke`, { cookie: as('member-one'), body: {} }), 404, '找不到這個 API。');
    // The token is not accepted as an Invite_ID either.
    failed(await revoke(as('member-one'), trip.id, link.token), 404, INVALID);
    expect(inviteRow(link.id).revoked_at).toBeNull();
    expect((await preview(link.token)).status).toBe(200);
  });
});

describe('invitation preview properties', () => {
  // Single code points that are stable under NFKC, mixing ASCII, CJK, accented letters, emoji and HTML syntax.
  const PIECES = ['a', 'Z', '9', ' ', '露', '營', '湖', 'é', 'ß', '😀', '🏕', '<', '>', '&', '"', "'", '/', '=', '\\', '`'];
  const textOf = (min, max) => fc.array(fc.constantFrom(...PIECES), { minLength: min, maxLength: max }).map(a => a.join(''));
  const htmlish = fc.constantFrom('<script>alert(1)</script>', '<b>粗體</b>', '&lt;&amp;', '"><img src=x onerror=1>');
  const hex = n => fc.string({ unit: fc.constantFrom(...'0123456789abcdef'), minLength: n, maxLength: n });
  const isoDay = offset => new Date(Date.parse('2025-06-01T00:00:00Z') + offset * DAY).toISOString().slice(0, 10);
  let address = 0;
  const nextClient = () => { address++; return { clientAddress: `10.${(address >> 16) & 255}.${(address >> 8) & 255}.${address & 255}` }; };
  const headerNames = res => [...res.headers.keys()].sort();

  test('Property 12: the invitation preview returns exactly the public fields', async () => {
    // Feature: publish-behind-nginx, Property 12: The invitation preview returns exactly the public fields
    fresh();
    const scenario = fc.record({
      title: fc.oneof(textOf(1, 100), textOf(100, 100), htmlish).filter(s => s.trim() !== ''),
      destination: fc.oneof(textOf(0, 100), textOf(100, 100), htmlish),
      start: fc.integer({ min: 0, max: 1500 }),
      span: fc.integer({ min: 0, max: 30 }),
      inviterName: fc.oneof(textOf(1, 30), textOf(30, 30), htmlish).filter(s => normalizeParticipantName(s) !== ''),
      repeats: fc.integer({ min: 1, max: 3 })
    });
    await fc.assert(fc.asyncProperty(scenario, async ({ title, destination, start, span, inviterName, repeats }) => {
      ok(await call('PATCH', `/api/admin/users/${id('owner-one')}`, { cookie: as('admin-one'), body: { displayName: inviterName } }));
      const startDate = isoDay(start), endDate = isoDay(start + span);
      const trip = await createTrip(as('owner-one'), { title, destination, startDate, endDate });
      const link = await invite(as('owner-one'), trip.id);
      const before = query('SELECT * FROM invites WHERE id = ?', link.id);
      const stored = query('SELECT title, destination, start_date, end_date FROM trips WHERE id = ?', trip.id)[0];
      const expected = { title: title.trim(), destination: destination.trim(), startDate, endDate, inviterName: normalizeParticipantName(inviterName) };
      expect({ title: stored.title, destination: stored.destination, startDate: stored.start_date, endDate: stored.end_date }).toEqual({ ...expected, inviterName: undefined });
      const client = nextClient();
      for (let i = 0; i < repeats; i++) {
        const res = await preview(link.token, client);
        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(['destination', 'endDate', 'inviterName', 'startDate', 'title']);
        expect(res.body).toEqual(expected);
      }
      expect(query('SELECT * FROM invites WHERE id = ?', link.id)).toEqual(before);
    }), { numRuns: 100 });
  }, 60000);

  test('Property 13: unusable invitation links are indistinguishable', async () => {
    // Feature: publish-behind-nginx, Property 13: Unusable invitation links are indistinguishable
    fresh();
    // Token states are prepared once; the property then probes random picks in random orders.
    const trip = await tripWithMembers(['member-one']);
    const live = await invite(as('owner-one'), trip.id);
    const expired = await invite(as('owner-one'), trip.id);
    query('UPDATE invites SET expires_at = ? WHERE id = ?', clockMs, expired.id); // expires_at = now is already expired
    const revoked = await invite(as('owner-one'), trip.id);
    ok(await revoke(as('owner-one'), trip.id, revoked.id));
    const used = await invite(as('owner-one'), trip.id);
    ok(await join(as('member-two'), used.token, '旅伴二'));
    // Creator deleted / demoted directly in the database so only the creator check rejects the link.
    const creatorDeleted = await invite(as('member-one'), trip.id);
    query('UPDATE users SET deleted_at = ? WHERE id = ?', clockMs, id('member-one'));
    const creatorWithoutRights = await invite(as('admin-two'), trip.id);
    query("UPDATE users SET role = 'member' WHERE id = ?", id('admin-two'));
    const gone = await createTrip(as('owner-one'), { title: '要刪除的旅行' });
    const tripDeleted = await invite(as('owner-one'), gone.id);
    ok(await call('POST', `/api/trips/${gone.id}/delete`, { cookie: as('owner-one'), body: { expectedUserId: id('owner-one'), confirmTitle: gone.title, revision: gone.revision } }));
    const prepared = { expired, revoked, used, creatorDeleted, creatorWithoutRights, tripDeleted };
    expect((await preview(live.token, nextClient())).status).toBe(200);

    const malformed = fc.oneof(
      fc.integer({ min: 1, max: 63 }).chain(hex),
      fc.integer({ min: 65, max: 96 }).chain(hex),
      fc.tuple(hex(63), fc.constantFrom('G', 'z', 'A', 'F', '-', '_', '~', 'é')).map(([h, c]) => encodeURIComponent(h + c)),
      fc.constantFrom('not-a-token', 'null', 'undefined', encodeURIComponent('<script>'))
    );
    const pick = fc.oneof(
      fc.constantFrom(...Object.keys(prepared)).map(kind => ({ kind, token: prepared[kind].token })),
      hex(64).map(token => ({ kind: 'unknown', token })),
      malformed.map(token => ({ kind: 'malformed', token }))
    );
    const probe = async token => ({
      preview: await preview(token, nextClient()),
      get: await call('GET', `/api/invites/${token}`, { cookie: as('outsider-one'), origin: null }),
      join: await join(as('outsider-one'), token, '路人')
    });
    await fc.assert(fc.asyncProperty(hex(64), fc.array(pick, { minLength: 1, maxLength: 8 }), async (reference, picks) => {
      const expected = await probe(reference);
      for (const res of Object.values(expected)) failed(res, 404, INVALID);
      for (const { token } of picks) {
        const actual = await probe(token);
        for (const route of ['preview', 'get', 'join']) {
          expect(actual[route].status).toBe(404);
          expect(actual[route].body).toEqual({ error: INVALID });
          expect(headerNames(actual[route])).toEqual(headerNames(expected[route]));
        }
      }
    }), { numRuns: 100 });

    expect(memberCount(trip.id)).toBe(3); // owner, member-one, member-two: no probe added anyone
    expect((await preview(live.token, nextClient())).status).toBe(200);
  }, 60000);
});

describe('single-use link property', () => {
  const NAMES = { 'owner-one': '主辦人', 'member-one': '旅伴一', 'member-two': '旅伴二', 'outsider-one': '路人', 'admin-two': '副管理員' };
  const OUTSIDE = ['member-one', 'member-two', 'outsider-one', 'admin-two'];
  const CONFLICT = '主辦人'; // the owner's participant name, so any outsider using it gets 409
  let registerClient = 0;

  test('Property 14: an invitation link adds at most one account', async () => {
    // Feature: publish-behind-nginx, Property 14: An invitation link adds at most one account
    fresh();
    let run = 0;
    // Accounts per run: the owner plus at most three others (seeded outsiders and new usernames), so at most
    // two invite-registrations can reach the password hash in one run.
    const scenario = fc.record({
      seeded: fc.subarray(OUTSIDE, { maxLength: 3 }),
      newcomers: fc.integer({ min: 0, max: 2 }),
      preMember: fc.boolean(),
      requests: fc.array(fc.record({
        actor: fc.nat(),
        kind: fc.constantFrom('valid', 'valid', 'conflict', 'blank', 'badType'),
        together: fc.boolean() // same concurrent batch as the previous request
      }), { minLength: 2, maxLength: 6 })
    }).filter(s => s.seeded.length + s.newcomers >= 1 && s.seeded.length + s.newcomers <= 3);

    await fc.assert(fc.asyncProperty(scenario, async ({ seeded, newcomers, preMember, requests }) => {
      run++;
      const trip = await createTrip(as('owner-one'));
      const initial = new Set([id('owner-one')]);
      if (preMember && seeded.length) {
        ok(await join(as(seeded[0]), (await invite(as('owner-one'), trip.id)).token, NAMES[seeded[0]]));
        initial.add(id(seeded[0]));
      }
      const link = await invite(as('owner-one'), trip.id);
      const actors = [
        ...['owner-one', ...seeded].map(name => ({ type: 'account', name, userId: id(name) })),
        ...Array.from({ length: newcomers }, (_, i) => ({ type: 'new', username: `p14-${run}-${i}`, displayName: `新朋友${i}` }))
      ];
      const plan = requests.map(r => {
        const actor = actors[r.actor % actors.length];
        let kind = r.kind;
        if (actor.type === 'new' && kind !== 'conflict') kind = 'valid'; // registrations: own name or a conflicting one
        if (actor.type === 'account' && initial.has(actor.userId) && kind === 'badType') kind = 'valid'; // members re-join with real bodies
        return { actor, kind, together: r.together };
      });
      const batches = [];
      for (const step of plan) {
        if (step.together && batches.length) batches[batches.length - 1].push(step); else batches.push([step]);
      }
      const send = ({ actor, kind }) => {
        if (actor.type === 'new') {
          return call('POST', `/api/invites/${link.token}/register`, {
            info: { clientAddress: `192.0.2.${++registerClient % 250}` },
            body: { username: actor.username, displayName: actor.displayName, password: PASS, ...(kind === 'conflict' ? { name: CONFLICT } : {}) }
          });
        }
        const body = { valid: { name: NAMES[actor.name] }, conflict: { name: CONFLICT }, blank: { name: '   ' }, badType: { name: 42 } }[kind];
        return call('POST', `/api/invites/${link.token}/join`, { cookie: as(actor.name), body });
      };

      const results = [];
      const batchClock = [];
      for (const [b, batch] of batches.entries()) {
        clockMs += 1000; // each batch at its own time, so used_at shows which batch consumed the link
        batchClock.push(clockMs);
        const responses = await Promise.all(batch.map(send));
        batch.forEach((step, i) => results.push({ ...step, batch: b, res: responses[i] }));
      }

      // At most one account outside the trip succeeded, and it is the one recorded in used_by.
      const winners = results.filter(r => r.res.status === 200 && !(r.actor.type === 'account' && initial.has(r.actor.userId)));
      const winnerIds = new Set(winners.map(r => (r.actor.type === 'new' ? r.res.body.user.id : r.actor.userId)));
      expect(winnerIds.size).toBeLessThanOrEqual(1);
      expect(winners.filter(r => r.actor.type === 'new').length).toBeLessThanOrEqual(1);
      const winnerId = winnerIds.size ? [...winnerIds][0] : null;
      const winBatch = winners.length ? Math.min(...winners.map(r => r.batch)) : Infinity;
      const isWinner = r => winnerId !== null && r.actor.type === 'account' && r.actor.userId === winnerId;

      for (const r of results) {
        const { status, body } = r.res;
        if (r.kind === 'badType') {
          expect(status).toBe(400); // rejected while reading the body, before the token is looked up
        } else if (r.actor.type === 'account' && (initial.has(r.actor.userId) || (isWinner(r) && r.batch > winBatch))) {
          // Already in the trip: the trip ID, whatever the name.
          expect(status).toBe(200);
          expect(body).toEqual({ tripId: trip.id });
        } else if (r.batch > winBatch) {
          expect(status).toBe(404);
          expect(body).toEqual({ error: INVALID });
        } else if (status === 200) {
          expect(r.batch).toBe(winBatch);
          // Only a valid name can add an account; a winner's other request in the same batch may land after it joined.
          if (!isWinner(r)) expect(r.kind).toBe('valid');
        } else {
          // Not the winner, at or before the consuming batch.
          const own = { valid: [], conflict: [409], blank: [400] }[r.kind];
          const raced = r.batch === winBatch ? [404, 409] : []; // lost to the winner in the same concurrent batch
          expect([...own, ...raced]).toContain(status);
          if (status === 404) expect(body).toEqual({ error: INVALID });
        }
      }

      // Trip, link and user table agree with the single winner.
      const expectedMembers = new Set(initial);
      if (winnerId) expectedMembers.add(winnerId);
      const members = query('SELECT user_id FROM trip_members WHERE trip_id = ?', trip.id).map(m => m.user_id);
      expect(new Set(members)).toEqual(expectedMembers); // trip_members includes the owner's row
      expect(members).toHaveLength(expectedMembers.size);
      expect((await getTrip(as('owner-one'), trip.id)).state.people).toHaveLength(expectedMembers.size);
      expect(inviteRow(link.id)).toEqual(winnerId
        ? { used_at: batchClock[winBatch], used_by: winnerId, revoked_at: null }
        : { used_at: null, used_by: null, revoked_at: null });
      const created = actors.filter(a => a.type === 'new').map(a => a.username);
      const createdIds = created.length ? query(`SELECT id FROM users WHERE username IN (${created.map(() => '?').join(',')})`, ...created).map(u => u.id) : [];
      expect(createdIds).toEqual(winners.some(r => r.actor.type === 'new') ? [winnerId] : []);
    }), { numRuns: 100 });
  }, 120000);
});

describe('invite limit property', () => {
  const TRIP_LIMIT = 20, MEMBER_LIMIT = 5;
  const TRIP_FULL = `每趟旅行最多 ${TRIP_LIMIT} 個有效邀請連結。`;
  const MEMBER_FULL = `每位旅伴在每趟旅行最多 ${MEMBER_LIMIT} 個有效邀請連結。`;
  const MANAGERS = new Set(['owner-one', 'admin-two']); // the trip owner and an admin outside the trip
  const CREATORS = ['owner-one', 'admin-two', 'member-one', 'member-two'];
  // Pre-registered accounts that consume links through Invite_Joins; registered once, so scrypt runs four times.
  const POOL = [['limit-joiner-one', '加入者一'], ['limit-joiner-two', '加入者二'], ['limit-joiner-three', '加入者三'], ['limit-joiner-four', '加入者四']];
  const RUN_START = T0 + 10000;
  let seedCopy, tripId;

  // A second seed: the pool accounts and a trip with member-one and member-two. Sessions are stretched
  // past any clock advance, because they last 7 days and are not renewed.
  async function limitSeed() {
    if (seedCopy) return;
    fresh();
    for (const [username, displayName] of POOL) {
      const res = await call('POST', '/api/register', { body: { username, displayName, password: PASS } });
      accounts[username] = { cookie: res.cookie, user: ok(res).user };
    }
    tripId = (await tripWithMembers(['member-one', 'member-two'])).id;
    query('UPDATE sessions SET expires_at = ?', T0 + 3650 * DAY);
    svc.close(); extra.length = 0;
    seedCopy = joinPath(root, 'limit-seed.sqlite');
    copyFileSync(dbPath, seedCopy);
    for (const suffix of ['-wal', '-shm']) if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, seedCopy + suffix);
    rmSync(testDir, { recursive: true, force: true });
    testDir = null;
  }

  function runCopy() {
    while (extra.length) extra.pop().close();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
    testDir = mkdtempSync(joinPath(root, 'limit-run-'));
    dbPath = joinPath(testDir, 'accounts.sqlite');
    copyFileSync(seedCopy, dbPath);
    for (const suffix of ['-wal', '-shm']) if (existsSync(seedCopy + suffix)) copyFileSync(seedCopy + suffix, dbPath + suffix);
    clockMs = RUN_START;
    svc = openService();
  }

  test('Property 15: invite creation follows the active-invite limits', async () => {
    // Feature: publish-behind-nginx, Property 15: Invite creation follows the active-invite limits
    await limitSeed();
    const op = fc.oneof(
      { weight: 8, arbitrary: fc.record({ kind: fc.constant('create'), creator: fc.constantFrom(...CREATORS) }) },
      { weight: 1, arbitrary: fc.record({ kind: fc.constant('consume'), pick: fc.nat() }) },
      { weight: 2, arbitrary: fc.record({ kind: fc.constant('revoke'), pick: fc.nat() }) },
      { weight: 1, arbitrary: fc.record({ kind: fc.constant('advance'), ms: fc.constantFrom(1000, 3600000, DAY, 3 * DAY, 7 * DAY) }) },
      // Jump to exactly one link's expiry: expires_at = now already counts as expired.
      { weight: 1, arbitrary: fc.record({ kind: fc.constant('toExpiry'), pick: fc.nat() }) }
    );

    await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 45 }), async ops => {
      runCopy();
      const model = []; // { id, token, creator, expiresAt, used, revoked }
      const activeOf = () => model.filter(m => !m.used && !m.revoked && m.expiresAt > clockMs);
      const rowCount = () => query('SELECT COUNT(*) AS n FROM invites WHERE trip_id = ?', tripId)[0].n;
      let joiners = 0;

      for (const step of ops) {
        clockMs += 1;
        const active = activeOf();
        if (step.kind === 'create') {
          const tripCount = active.length;
          const own = active.filter(m => m.creator === step.creator).length;
          const expected = tripCount >= TRIP_LIMIT ? TRIP_FULL
            : !MANAGERS.has(step.creator) && own >= MEMBER_LIMIT ? MEMBER_FULL : null;
          const before = rowCount();
          const res = await createInvite(as(step.creator), tripId);
          if (expected) {
            failed(res, 409, expected);
            expect(rowCount()).toBe(before);
          } else {
            const body = ok(res, 201);
            expect(body.expiresAt).toBe(new Date(clockMs + 7 * DAY).toISOString());
            model.push({ id: body.id, token: body.token, creator: step.creator, expiresAt: clockMs + 7 * DAY, used: false, revoked: false });
            expect(rowCount()).toBe(before + 1);
          }
        } else if (step.kind === 'consume') {
          if (!active.length || joiners >= POOL.length) continue;
          const target = active[step.pick % active.length];
          const [username, displayName] = POOL[joiners++];
          expect(ok(await join(as(username), target.token, displayName))).toEqual({ tripId });
          target.used = true;
        } else if (step.kind === 'revoke') {
          if (!active.length) continue;
          const target = active[step.pick % active.length];
          expect(ok(await revoke(as('owner-one'), tripId, target.id))).toEqual({ revoked: true });
          target.revoked = true;
        } else if (step.kind === 'advance') {
          clockMs += step.ms;
        } else {
          if (!active.length) continue;
          clockMs = active[step.pick % active.length].expiresAt;
        }
      }

      // The database's Active_Invites agree with the model, per trip and per creator.
      const at = clockMs;
      expect(query('SELECT COUNT(*) AS n FROM invites WHERE trip_id = ? AND revoked_at IS NULL AND used_at IS NULL AND expires_at > ?', tripId, at)[0].n)
        .toBe(activeOf().length);
      for (const creator of CREATORS) {
        expect(query('SELECT COUNT(*) AS n FROM invites WHERE trip_id = ? AND created_by = ? AND revoked_at IS NULL AND used_at IS NULL AND expires_at > ?', tripId, id(creator), at)[0].n)
          .toBe(activeOf().filter(m => m.creator === creator).length);
      }
    }), { numRuns: 100 });
  }, 120000);
});
