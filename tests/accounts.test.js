import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createAccountService } from '../server/accounts.js';
import { seed, isValidState } from '../src/model.js';
import { useTestDatabase, resetTables, serviceDb } from './support/pg.js';

const BASE = 'http://127.0.0.1:5181';
const PASS = 'correct horse battery';
let svc, clockMs, seen;
const db = useTestDatabase();

beforeEach(async () => {
  clockMs = Date.parse('2026-11-04T00:00:00Z');
  seen = [];
  await resetTables(db.sql);
  svc = await createAccountService({ db: serviceDb(db.sql), now: () => clockMs });
});
afterEach(() => svc.close());

async function call(method, path, { body, cookie, origin = BASE, type = 'application/json', raw, base = BASE, info } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  if (body !== undefined || raw !== undefined) headers['content-type'] = type;
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  const res = await svc.handle(new Request(base + path, { method, headers, body: payload }), info);
  if (res === null) return null;
  const text = await res.text();
  seen.push(text);
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers, setCookie: res.headers.get('set-cookie') || '', cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const ok = (res, status = 200) => { expect(res.body).toBeTruthy(); if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`); return res; };
const failed = (res, status) => { expect(res.status).toBe(status); expect(typeof res.body.error).toBe('string'); expect(Object.keys(res.body)).toEqual(['error']); return res; };

async function setupAdmin(username = 'admin-one', displayName = '管理員') {
  const res = ok(await call('POST', '/api/setup', { body: { username, displayName, password: PASS } }));
  return { cookie: res.cookie, user: res.body.user };
}
async function register(username, displayName = username) {
  const res = ok(await call('POST', '/api/register', { body: { username, displayName, password: PASS } }));
  return { cookie: res.cookie, user: res.body.user };
}
const card = (extra = {}) => ({ title: '週末露營', destination: '湖邊營地', startDate: '2026-11-20', endDate: '2026-11-22', description: '一起出發', note: '帶外套', coverKind: 'lake', status: 'planning', ...extra });
async function createTrip(cookie, extra) { return ok(await call('POST', '/api/trips', { cookie, body: card(extra) }), 201).body.trip; }
async function getTrip(cookie, id) { return ok(await call('GET', `/api/trips/${id}`, { cookie })).body; }
async function putState(cookie, id, mutate) {
  const env = await getTrip(cookie, id);
  const state = structuredClone(env.state);
  mutate(state);
  return call('PUT', `/api/trips/${id}`, { cookie, body: { revision: env.trip.revision, state } });
}
async function login(username) { return ok(await call('POST', '/api/login', { body: { username, password: PASS } })).cookie; }
async function invite(cookie, tripId) { return ok(await call('POST', `/api/trips/${tripId}/invites`, { cookie, body: {} }), 201).body; }
async function join(cookie, token, name, role) { return call('POST', `/api/invites/${token}/join`, { cookie, body: role === undefined ? { name } : { name, role } }); }

describe('routing and transport', () => {
  test('non-api paths are left to the static server', async () => {
    expect(await call('GET', '/')).toBeNull();
    expect(await call('GET', '/apix/session')).toBeNull();
    expect(await call('GET', '/invite/abc')).toBeNull();
  });
  test('unknown api routes and hard delete are rejected as JSON errors', async () => {
    failed(await call('GET', '/api/nothing'), 404);
    const { cookie } = await setupAdmin();
    const trip = await createTrip(cookie);
    const res = failed(await call('DELETE', `/api/trips/${trip.id}`, { cookie }), 405);
    expect(res.headers.get('allow')).toBe('GET, PUT, PATCH');
    failed(await call('DELETE', '/api/admin/users/x', { cookie }), 405);
  });
  test('responses are JSON and never cached', async () => {
    const res = ok(await call('GET', '/api/session'));
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toEqual({ user: null, needsSetup: true, setupTokenRequired: false, webSetup: true, registrationOpen: true, inviteRegistration: false });
  });
  test('mutations need the exact request origin (CSRF)', async () => {
    const body = { username: 'admin-one', displayName: '管理員', password: PASS };
    failed(await call('POST', '/api/setup', { body, origin: null }), 403);
    failed(await call('POST', '/api/setup', { body, origin: 'http://evil.example' }), 403);
    failed(await call('POST', '/api/setup', { body, origin: 'http://127.0.0.1:5182' }), 403);
    failed(await call('POST', '/api/setup', { body, origin: 'null' }), 403);
    expect(ok(await call('GET', '/api/session')).body.needsSetup).toBe(true);
    const { cookie } = await setupAdmin();
    failed(await call('POST', '/api/logout', { cookie, origin: null }), 403);
    failed(await call('POST', '/api/trips', { cookie, body: card(), origin: 'https://127.0.0.1:5181' }), 403);
    expect(ok(await call('GET', '/api/session', { cookie, origin: null })).body.user.username).toBe('admin-one');
  });
  test('JSON content type, object bodies and the 1 MB limit are enforced', async () => {
    const { cookie } = await setupAdmin();
    failed(await call('POST', '/api/trips', { cookie, raw: JSON.stringify(card()), type: 'text/plain' }), 415);
    failed(await call('POST', '/api/trips', { cookie, raw: JSON.stringify(card()), type: 'application/x-www-form-urlencoded' }), 415);
    failed(await call('POST', '/api/trips', { cookie, raw: '{broken' }), 400);
    failed(await call('POST', '/api/trips', { cookie, raw: '[1,2]' }), 400);
    failed(await call('POST', '/api/trips', { cookie, raw: 'null' }), 400);
    failed(await call('POST', '/api/trips', { cookie, raw: JSON.stringify({ ...card(), pad: 'x'.repeat(1024 * 1024) }) }), 413);
    ok(await call('POST', '/api/trips', { cookie, raw: JSON.stringify(card()), type: 'application/json; charset=utf-8' }), 201);
  });
});

describe('first-admin setup', () => {
  test('setup is loopback-only', async () => {
    const body = { username: 'admin-one', displayName: '管理員', password: PASS };
    failed(await call('POST', '/api/setup', { body, base: 'http://camp.example.com', origin: 'http://camp.example.com' }), 403);
    failed(await call('POST', '/api/setup', { body, info: { ip: '192.168.1.20' } }), 403);
    ok(await call('POST', '/api/setup', { body, info: { ip: '::ffff:127.0.0.1' } }));
  });
  test('creates an admin, sets a hardened cookie and runs only once', async () => {
    const res = ok(await call('POST', '/api/setup', { body: { username: 'admin-one', displayName: ' 管理員  小安 ', password: PASS } }));
    expect(res.body).toEqual({ user: { id: expect.any(String), username: 'admin-one', displayName: '管理員 小安', role: 'admin' }, needsSetup: false });
    expect(res.setCookie).toMatch(/^ggc_session=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800$/);
    expect(ok(await call('GET', '/api/session', { cookie: res.cookie })).body).toEqual({ user: res.body.user, needsSetup: false, setupTokenRequired: false, webSetup: true, registrationOpen: true, inviteRegistration: true });
    failed(await call('POST', '/api/setup', { body: { username: 'admin-two', displayName: 'x', password: PASS } }), 409);
  });
  test('setup via a trusted proxy is never treated as loopback', async () => {
    const body = { username: 'admin-one', displayName: '管理員', password: PASS };
    failed(await call('POST', '/api/setup', { body, info: { ip: '127.0.0.1', tcpIp: '127.0.0.1', viaProxy: true } }), 403);
    expect(ok(await call('GET', '/api/session')).body.needsSetup).toBe(true);
  });
  test('effective URL from the HTTP layer drives Origin and Secure', async () => {
    const body = { username: 'admin-one', displayName: '管理員', password: PASS };
    const info = { ip: '127.0.0.1', tcpIp: '127.0.0.1', viaProxy: false, url: new URL(`https://localhost:5181/api/setup`) };
    failed(await call('POST', '/api/setup', { body, base: 'http://localhost:5181', origin: 'http://localhost:5181', info }), 403);
    const res = ok(await call('POST', '/api/setup', { body, base: 'http://localhost:5181', origin: 'https://localhost:5181', info }));
    expect(res.setCookie).toContain('; Secure');
  });
  test('cookie is Secure on https', async () => {
    const res = ok(await call('POST', '/api/setup', { base: 'https://localhost:5181', origin: 'https://localhost:5181', body: { username: 'admin-one', displayName: '管理員', password: PASS } }));
    expect(res.setCookie).toContain('; Secure');
  });
  test('concurrent setup requests create exactly one admin', async () => {
    const attempt = name => call('POST', '/api/setup', { body: { username: name, displayName: name, password: PASS } });
    const results = await Promise.all([attempt('admin-a'), attempt('admin-b'), attempt('admin-c')]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409, 409]);
    const winner = results.find(r => r.status === 200);
    const users = ok(await call('GET', '/api/admin/users', { cookie: winner.cookie })).body.users;
    expect(users).toHaveLength(1);
  });
  test('validates username, display name and password with no defaults', async () => {
    const attempt = body => call('POST', '/api/setup', { body: { username: 'admin-one', displayName: '管理員', password: PASS, ...body } });
    for (const username of ['Admin', '1abc', 'ab', 'a'.repeat(33), 'admin', 'api', 'setup', 'login', 'register', 'logout', 'demo', 'assets', 'ab_c', 'abc ', undefined]) failed(await attempt({ username }), 400);
    for (const displayName of ['   ', 'a\u202Eb', 'x'.repeat(31), undefined, 42]) failed(await attempt({ displayName }), 400);
    for (const password of [undefined, '', 'short', 'x'.repeat(11), 'x'.repeat(129)]) failed(await attempt({ password }), 400);
    expect(ok(await call('GET', '/api/session')).body.needsSetup).toBe(true);
    ok(await attempt({ password: 'x'.repeat(128) }));
  });
});

describe('registration, login and sessions', () => {
  test('registration requires setup and creates members', async () => {
    failed(await call('POST', '/api/register', { body: { username: 'member-a', displayName: 'A', password: PASS } }), 409);
    await setupAdmin();
    const a = await register('member-a', '阿哲');
    expect(a.user).toMatchObject({ username: 'member-a', displayName: '阿哲', role: 'member' });
    failed(await call('POST', '/api/register', { body: { username: 'member-a', displayName: 'B', password: PASS } }), 409);
  });
  test('registration cannot self-grant admin', async () => {
    await setupAdmin();
    const res = ok(await call('POST', '/api/register', { body: { username: 'member-b', displayName: 'B', password: PASS, role: 'admin' } }));
    expect(res.body.user.role).toBe('member');
    failed(await call('GET', '/api/admin/users', { cookie: res.cookie }), 403);
  });
  test('registration attempts are rate limited', async () => {
    await setupAdmin();
    for (let i = 0; i < 20; i++) failed(await call('POST', '/api/register', { body: { username: 'X' } }), 400);
    failed(await call('POST', '/api/register', { body: { username: 'member-z', displayName: 'Z', password: PASS } }), 429);
    clockMs += 61 * 60000;
    ok(await call('POST', '/api/register', { body: { username: 'member-z', displayName: 'Z', password: PASS } }));
  });
  test('login is generic on failure and bounded per username', async () => {
    await setupAdmin();
    await register('member-a');
    const login = (username, password) => call('POST', '/api/login', { body: { username, password } });
    const wrong = failed(await login('member-a', 'wrong password!!'), 401);
    const unknown = failed(await login('nobody-here', PASS), 401);
    expect(wrong.body.error).toBe(unknown.body.error);
    for (let i = 0; i < 4; i++) failed(await login('member-a', 'wrong password!!'), 401);
    failed(await login('member-a', PASS), 429);
    clockMs += 16 * 60000;
    const res = ok(await login('MEMBER-A ', PASS));
    expect(res.body.user.username).toBe('member-a');
    failed(await call('POST', '/api/login', { body: { username: 'member-a' } }), 400);
  });
  test('sessions expire after 7 days and logout revokes them', async () => {
    const { cookie } = await setupAdmin();
    clockMs += 7 * 86400000 - 1000;
    expect(ok(await call('GET', '/api/session', { cookie })).body.user).not.toBeNull();
    clockMs += 2000;
    expect(ok(await call('GET', '/api/session', { cookie })).body.user).toBeNull();
    failed(await call('GET', '/api/trips', { cookie }), 401);
    const fresh = ok(await call('POST', '/api/login', { body: { username: 'admin-one', password: PASS } })).cookie;
    const out = ok(await call('POST', '/api/logout', { cookie: fresh }));
    expect(out.setCookie).toContain('Max-Age=0');
    failed(await call('GET', '/api/trips', { cookie: fresh }), 401);
  });
  test('login rotates the presented session', async () => {
    const { cookie } = await setupAdmin();
    const next = ok(await call('POST', '/api/login', { cookie, body: { username: 'admin-one', password: PASS } })).cookie;
    expect(next).not.toBe(cookie);
    failed(await call('GET', '/api/trips', { cookie }), 401);
    ok(await call('GET', '/api/trips', { cookie: next }));
  });
  test('forged or malformed cookies are rejected', async () => {
    await setupAdmin();
    for (const cookie of ['ggc_session=' + 'a'.repeat(64), 'ggc_session=' + 'A'.repeat(64), 'ggc_session=../../etc', 'ggc_session=', 'other=1']) failed(await call('GET', '/api/trips', { cookie }), 401);
  });
  test('passwords and hashes never appear in responses', async () => {
    const { cookie } = await setupAdmin();
    await register('member-a');
    await call('POST', '/api/login', { body: { username: 'member-a', password: PASS } });
    await call('GET', '/api/admin/users', { cookie });
    await call('GET', '/api/admin/audit', { cookie });
    const all = seen.join('\n');
    expect(all).not.toContain(PASS);
    expect(all).not.toContain('scrypt');
    expect(all).not.toContain('password');
  });
});

describe('trips and isolation', () => {
  test('creates a valid empty trip owned by a new owner participant', async () => {
    await setupAdmin();
    const a = await register('member-a', '阿哲');
    const trip = await createTrip(a.cookie);
    expect(trip).toEqual({ id: expect.any(String), ownerId: a.user.id, ownerName: '阿哲', ownerUsername: 'member-a', title: '週末露營', destination: '湖邊營地', startDate: '2026-11-20', endDate: '2026-11-22', description: '一起出發', note: '帶外套', coverKind: 'lake', status: 'planning', revision: 1, canEdit: true, canDelete: true, canInvite: true, canManage: true, memberCount: 1, isMember: true });
    const env = await getTrip(a.cookie, trip.id);
    expect(isValidState(env.state)).toBe(true);
    expect(env.state.people).toHaveLength(1);
    expect(env.state.people[0].name).toBe('阿哲');
    expect(env.state.currentUser).toBe(env.permissions.personId);
    expect(env.permissions).toEqual({ canEdit: true, canDelete: true, canInvite: true, canManage: true, personId: env.state.people[0].id });
    expect(env.state.revision).toBe(1);
    expect([env.state.activities, env.state.meals, env.state.shopping, env.state.gear, env.state.vehicles]).toEqual([[], [], [], [], []]);
  });
  test('accepts and persists every cover illustration option', async () => {
    const { cookie } = await setupAdmin();
    for (const coverKind of ['camp', 'mountain', 'lake', 'night', 'forest', 'beach', 'sunrise']) {
      expect((await createTrip(cookie, { coverKind })).coverKind).toBe(coverKind);
    }
  });
  test('validates card fields', async () => {
    const { cookie } = await setupAdmin();
    const bad = async extra => failed(await call('POST', '/api/trips', { cookie, body: card(extra) }), 400);
    await bad({ coverKind: 'ocean' });
    await bad({ status: 'archived' });
    await bad({ title: '   ' });
    await bad({ title: 42 });
    await bad({ title: 'x'.repeat(101) });
    await bad({ startDate: '2026-11-22', endDate: '2026-11-20' });
    await bad({ startDate: '2026-02-30', endDate: '2026-03-02' });
    await bad({ startDate: '2026-11-01', endDate: '2026-12-15' });
    failed(await call('POST', '/api/trips', { cookie, body: { title: 'only title' } }), 400);
    failed(await call('POST', '/api/trips', { body: card() }), 401);
  });
  test('accounts only see their own or joined trips; admin sees all', async () => {
    const admin = await setupAdmin();
    const a = await register('member-a', 'A'), b = await register('member-b', 'B');
    const ta = await createTrip(a.cookie, { title: 'A trip' });
    const tb = await createTrip(b.cookie, { title: 'B trip' });
    expect(ok(await call('GET', '/api/trips', { cookie: a.cookie })).body.trips.map(t => t.id)).toEqual([ta.id]);
    expect(ok(await call('GET', '/api/trips', { cookie: b.cookie })).body.trips.map(t => t.id)).toEqual([tb.id]);
    failed(await call('GET', `/api/trips/${ta.id}`, { cookie: b.cookie }), 404);
    failed(await call('PUT', `/api/trips/${ta.id}`, { cookie: b.cookie, body: { revision: 1, state: seed() } }), 404);
    failed(await call('PATCH', `/api/trips/${ta.id}`, { cookie: b.cookie, body: { revision: 1, title: 'x' } }), 404);
    failed(await call('POST', `/api/trips/${ta.id}/invites`, { cookie: b.cookie, body: {} }), 404);
    failed(await call('POST', `/api/trips/${ta.id}/check`, { cookie: b.cookie, body: { revision: 1, kind: 'depart', id: '', checked: true } }), 404);
    failed(await call('GET', '/api/trips/does-not-exist', { cookie: a.cookie }), 404);
    failed(await call('GET', '/api/trips/%27%20OR%201%3D1', { cookie: a.cookie }), 404);
    const all = ok(await call('GET', '/api/trips', { cookie: admin.cookie })).body.trips;
    expect(all.map(t => t.id).sort()).toEqual([ta.id, tb.id].sort());
    expect(all.every(t => t.canEdit && !t.isMember)).toBe(true);
  });
  test('legacy import copies data, adds a fresh owner and syncs ingredients', async () => {
    await setupAdmin();
    const a = await register('member-a', '小安');
    const legacy = seed();
    legacy.people[0].isAdmin = true;
    legacy.hacked = 'yes';
    const trip = ok(await call('POST', '/api/trips', { cookie: a.cookie, body: { legacyState: legacy, coverKind: 'mountain' } }), 201).body.trip;
    expect(trip).toMatchObject({ title: '雲海裡，住一晚', startDate: '2026-11-20', coverKind: 'mountain', memberCount: 7 });
    const env = await getTrip(a.cookie, trip.id);
    expect(env.permissions.personId).not.toBe('p1');
    const me = env.state.people.find(p => p.id === env.permissions.personId);
    expect(me.name).toBe('小安 2');
    expect(env.state.people.find(p => p.id === 'p1').name).toBe('小安');
    expect(env.state.meals).toHaveLength(4);
    expect(env.state.shopping.some(s => s.source === 'meal' && s.name === '壽喜燒醬')).toBe(true);
    expect(env.state.hacked).toBeUndefined();
    expect(env.state.people[0].isAdmin).toBeUndefined();
    expect(isValidState(env.state)).toBe(true);
    const broken = seed(); broken.currentUser = 'ghost'; broken.people = [];
    failed(await call('POST', '/api/trips', { cookie: a.cookie, body: { legacyState: broken } }), 400);
    failed(await call('POST', '/api/trips', { cookie: a.cookie, body: { legacyState: 'not-a-state' } }), 400);
  });
  test('legacy import with new dates shifts the schedule', async () => {
    await setupAdmin();
    const a = await register('member-a', 'A');
    const trip = ok(await call('POST', '/api/trips', { cookie: a.cookie, body: { legacyState: seed(), startDate: '2026-12-01', endDate: '2026-12-03' } }), 201).body.trip;
    const { state } = await getTrip(a.cookie, trip.id);
    expect(state.activities[0].date).toBe('2026-12-01');
    expect(state.meals.find(m => m.id === 'm4').date).toBe('2026-12-03');
    failed(await call('POST', '/api/trips', { cookie: a.cookie, body: { legacyState: seed(), endDate: '2026-11-21' } }), 400);
  });
  test('SQL-like and HTML text is stored as plain text', async () => {
    const { cookie } = await setupAdmin();
    const title = "'); DROP TABLE trips;-- <script>";
    const trip = await createTrip(cookie, { title, note: "x' OR '1'='1" });
    expect(trip.title).toBe(title);
    expect(ok(await call('GET', '/api/trips', { cookie })).body.trips[0]).toMatchObject({ title, note: "x' OR '1'='1" });
    failed(await call('POST', '/api/login', { body: { username: "admin-one' --", password: PASS } }), 401);
    failed(await call('POST', '/api/login', { body: { username: "x' OR '1'='1", password: "' OR '1'='1" } }), 401);
    ok(await call('GET', `/api/trips/${trip.id}`, { cookie }));
  });
});

describe('editing, revisions and tampering', () => {
  async function tripWithMember() {
    const admin = await setupAdmin();
    const owner = await register('owner-a', '主辦人');
    const member = await register('member-b', '阿哲');
    const trip = ok(await call('POST', '/api/trips', { cookie: owner.cookie, body: { legacyState: seed() } }), 201).body.trip;
    const inv = await invite(owner.cookie, trip.id);
    ok(await join(member.cookie, inv.token, '阿哲哲', '咖啡'));
    const ownerEnv = await getTrip(owner.cookie, trip.id), memberEnv = await getTrip(member.cookie, trip.id);
    return { admin, owner, member, trip, ownerPid: ownerEnv.permissions.personId, memberPid: memberEnv.permissions.personId };
  }
  test('owner PUT saves server-authoritative state and increments revision', async () => {
    const { owner, trip } = await tripWithMember();
    const before = await getTrip(owner.cookie, trip.id);
    const res = ok(await putState(owner.cookie, trip.id, s => { s.trip.title = '  新的標題  '; s.revision = 999; s.currentUser = 'p2'; s.joined = false; s.role = 'admin'; }));
    expect(res.body.trip.revision).toBe(before.trip.revision + 1);
    expect(res.body.trip.title).toBe('新的標題');
    expect(res.body.state.revision).toBe(res.body.trip.revision);
    expect(res.body.state.currentUser).toBe(before.permissions.personId);
    expect(res.body.state.joined).toBe(true);
    expect(res.body.state.role).toBeUndefined();
    expect(Object.keys(res.body)).toEqual(['trip', 'state', 'permissions']);
  });
  test('stale revisions conflict', async () => {
    const { owner, trip } = await tripWithMember();
    const env = await getTrip(owner.cookie, trip.id);
    ok(await call('PUT', `/api/trips/${trip.id}`, { cookie: owner.cookie, body: { revision: env.trip.revision, state: env.state } }));
    failed(await call('PUT', `/api/trips/${trip.id}`, { cookie: owner.cookie, body: { revision: env.trip.revision, state: env.state } }), 409);
    failed(await call('PATCH', `/api/trips/${trip.id}`, { cookie: owner.cookie, body: { revision: env.trip.revision, title: 'x' } }), 409);
    failed(await call('PUT', `/api/trips/${trip.id}`, { cookie: owner.cookie, body: { state: env.state } }), 400);
  });
  test('account-bound edits cannot be replayed under an admin or another editor session', async () => {
    const admin = await setupAdmin();
    const owner = await register('owner-draft', '原主辦人');
    const trip = await createTrip(owner.cookie);
    const env = await getTrip(owner.cookie, trip.id);
    env.state.trip.title = '不能由另一個帳號儲存';
    failed(await call('PUT', `/api/trips/${trip.id}`, { cookie: admin.cookie, body: { expectedUserId: owner.user.id, revision: env.trip.revision, state: env.state } }), 409);
    failed(await call('PATCH', `/api/trips/${trip.id}`, { cookie: admin.cookie, body: { expectedUserId: owner.user.id, revision: env.trip.revision, title: '不能儲存' } }), 409);
    failed(await call('POST', `/api/trips/${trip.id}/check`, { cookie: admin.cookie, body: { expectedUserId: owner.user.id, revision: env.trip.revision, kind: 'shopping', id: 'bad', checked: true } }), 409);
    expect((await getTrip(owner.cookie, trip.id)).trip.title).toBe('週末露營');
    failed(await call('POST', '/api/trips', { cookie: admin.cookie, body: { ...card(), expectedUserId: owner.user.id } }), 409);
    failed(await call('POST', `/api/trips/${trip.id}/invites`, { cookie: admin.cookie, body: { expectedUserId: owner.user.id } }), 409);
    ok(await call('PUT', `/api/trips/${trip.id}`, { cookie: owner.cookie, body: { expectedUserId: owner.user.id, revision: env.trip.revision, state: env.state } }));
    expect((await getTrip(owner.cookie, trip.id)).trip.title).toBe('不能由另一個帳號儲存');
  });
  test('members can edit, patch and invite', async () => {
    const { member, trip } = await tripWithMember();
    const env = await getTrip(member.cookie, trip.id);
    expect(env.permissions).toEqual({ canEdit: true, canDelete: false, canInvite: true, canManage: false, personId: env.permissions.personId });
    expect(env.trip).toMatchObject({ canEdit: true, canDelete: false, canInvite: true, canManage: false, isMember: true });
    const put = ok(await call('PUT', `/api/trips/${trip.id}`, { cookie: member.cookie, body: { revision: env.trip.revision, state: env.state } }));
    ok(await call('PATCH', `/api/trips/${trip.id}`, { cookie: member.cookie, body: { revision: put.body.trip.revision, title: 'mine' } }));
    ok(await call('POST', `/api/trips/${trip.id}/invites`, { cookie: member.cookie, body: {} }), 201);
  });
  test('bound participants cannot be removed or swapped, but can be renamed', async () => {
    const { owner, trip, memberPid, ownerPid } = await tripWithMember();
    failed(await putState(owner.cookie, trip.id, s => { s.people = s.people.filter(p => p.id !== memberPid); }), 409);
    failed(await putState(owner.cookie, trip.id, s => { s.people.find(p => p.id === memberPid).id = 'p-new'; }), 409);
    failed(await putState(owner.cookie, trip.id, s => { s.people = s.people.filter(p => p.id !== ownerPid); s.vehicles = []; }), 409);
    failed(await putState(owner.cookie, trip.id, s => { s.people.find(p => p.id === 'p2').name = '阿哲哲'; }), 409);
    failed(await putState(owner.cookie, trip.id, s => { s.people.find(p => p.id === memberPid).name = 'a\u202Eb'; }), 400);
    const res = ok(await putState(owner.cookie, trip.id, s => { const p = s.people.find(p => p.id === memberPid); p.name = '咖啡阿哲'; p.role = '咖啡大師'; }));
    expect(res.body.state.people.find(p => p.id === memberPid)).toMatchObject({ name: '咖啡阿哲', role: '咖啡大師' });
    const ok2 = ok(await putState(owner.cookie, trip.id, s => { s.people = s.people.filter(p => p.id !== 'p6'); s.vehicles = s.vehicles.filter(v => v.driver !== 'p6'); for (const x of s.shopping) if (x.assignee === 'p6') x.assignee = ''; for (const g of s.gear) if (g.assignee === 'p6') { g.assignee = ''; g.ready = []; } s.activities.forEach(a => a.people = a.people.filter(id => id !== 'p6')); }));
    expect(ok2.body.state.people.some(p => p.id === 'p6')).toBe(false);
  });
  test('invalid or tampered state is rejected without saving', async () => {
    const { owner, trip } = await tripWithMember();
    const env = await getTrip(owner.cookie, trip.id);
    failed(await putState(owner.cookie, trip.id, s => { s.gear[0].ready = 'everyone'; }), 400);
    failed(await putState(owner.cookie, trip.id, s => { s.activities[0].date = '2031-01-01'; }), 400);
    failed(await putState(owner.cookie, trip.id, s => { s.trip.endDate = '2027-01-30'; }), 400);
    failed(await putState(owner.cookie, trip.id, s => { s.trip.title = 'x'.repeat(101); }), 400);
    failed(await call('PUT', `/api/trips/${trip.id}`, { cookie: owner.cookie, body: { revision: env.trip.revision, state: null } }), 400);
    expect((await getTrip(owner.cookie, trip.id)).trip.revision).toBe(env.trip.revision);
  });
  test('client audit events cannot spoof actor, time or history', async () => {
    const { owner, trip } = await tripWithMember();
    const env = await getTrip(owner.cookie, trip.id);
    const oldEvents = env.state.events;
    const res = ok(await putState(owner.cookie, trip.id, s => {
      s.events = [{ id: 'fake', text: '新增了活動', actor: '管理員', at: '1999-01-01T00:00:00.000Z' }];
    }));
    const events = res.body.state.events;
    expect(events[0]).toMatchObject({ text: '新增了活動', actor: '主辦人', at: new Date(clockMs).toISOString() });
    expect(events[0].id).not.toBe('fake');
    expect(events.slice(1)).toEqual(oldEvents);
  });
  test('an unbound admin edits as admin while seeing the owner perspective', async () => {
    const { admin, trip, ownerPid } = await tripWithMember();
    const env = await getTrip(admin.cookie, trip.id);
    expect(env.permissions).toEqual({ canEdit: true, canDelete: true, canInvite: true, canManage: true, personId: null });
    expect(env.state.currentUser).toBe(ownerPid);
    const res = ok(await putState(admin.cookie, trip.id, s => { s.trip.note = 'admin note'; }));
    expect(res.body.state.events[0].actor).toBe('管理員（管理員）');
    expect(res.body.state.currentUser).toBe(ownerPid);
    const audit = ok(await call('GET', '/api/admin/audit', { cookie: admin.cookie })).body.events;
    expect(audit[0]).toEqual({ at: expect.any(String), actor: 'admin-one', action: 'trip.update', target: `trip:${trip.id}` });
  });
  test('PATCH edits card metadata and shifts schedule dates', async () => {
    const { owner, trip } = await tripWithMember();
    const env = await getTrip(owner.cookie, trip.id);
    const res = ok(await call('PATCH', `/api/trips/${trip.id}`, { cookie: owner.cookie, body: { revision: env.trip.revision, startDate: '2026-12-05', endDate: '2026-12-08', coverKind: 'night', status: 'completed', title: '改期' } }));
    expect(res.body.trip).toMatchObject({ startDate: '2026-12-05', endDate: '2026-12-08', coverKind: 'night', status: 'completed', title: '改期', revision: env.trip.revision + 1 });
    expect(res.body.state.trip).toMatchObject({ startDate: '2026-12-05', endDate: '2026-12-08', title: '改期' });
    expect(res.body.state.activities.find(a => a.id === 'a10').date).toBe('2026-12-07');
    expect(res.body.state.meals.find(m => m.id === 'm1').date).toBe('2026-12-05');
    expect(res.body.state.shopping).toEqual(env.state.shopping);
    expect(res.body.state.people).toEqual(env.state.people);
    const rev = res.body.trip.revision;
    failed(await call('PATCH', `/api/trips/${trip.id}`, { cookie: owner.cookie, body: { revision: rev, endDate: '2026-12-06' } }), 400);
    failed(await call('PATCH', `/api/trips/${trip.id}`, { cookie: owner.cookie, body: { revision: rev, endDate: '2027-01-20' } }), 400);
    failed(await call('PATCH', `/api/trips/${trip.id}`, { cookie: owner.cookie, body: { revision: rev, status: 'deleted' } }), 400);
    failed(await call('PATCH', `/api/trips/${trip.id}`, { cookie: owner.cookie, body: { revision: rev, coverKind: 'sea' } }), 400);
    expect((await getTrip(owner.cookie, trip.id)).trip.revision).toBe(rev);
  });
});

describe('member check-offs', () => {
  async function scenario() {
    const admin = await setupAdmin();
    const owner = await register('owner-a', '主辦人');
    const member = await register('member-b', '阿哲');
    const trip = await createTrip(owner.cookie);
    const inv = await invite(owner.cookie, trip.id);
    ok(await join(member.cookie, inv.token, '阿哲'));
    const pid = (await getTrip(member.cookie, trip.id)).permissions.personId;
    const ownerPid = (await getTrip(owner.cookie, trip.id)).permissions.personId;
    ok(await putState(owner.cookie, trip.id, s => {
      s.shopping = [
        { id: 'mine', name: '雞蛋', quantity: '1 盒', category: '蛋奶', assignee: pid, done: false },
        { id: 'theirs', name: '牛肉片', quantity: '1 盒', category: '肉類', assignee: ownerPid, done: false },
        { id: 'nobody', name: '冰塊', quantity: '1 袋', category: '其他', assignee: '', done: false }
      ];
      s.gear = [
        { id: 'bag', name: '睡袋', quantity: '1', scope: 'personal', assignee: '', ready: [] },
        { id: 'stove', name: '爐子', quantity: '1', scope: 'shared', assignee: pid, ready: [] },
        { id: 'tent', name: '帳篷', quantity: '1', scope: 'shared', assignee: ownerPid, ready: [] }
      ];
    }));
    return { admin, owner, member, trip, pid, ownerPid };
  }
  const check = async (cookie, tripId, kind, id, checked) => {
    const rev = (await getTrip(cookie, tripId)).trip.revision;
    return call('POST', `/api/trips/${tripId}/check`, { cookie, body: { revision: rev, kind, id, checked } });
  };
  test('members tick any shared shopping item but only their own packing', async () => {
    const { member, trip, pid } = await scenario();
    const res = ok(await check(member.cookie, trip.id, 'shopping', 'mine', true));
    expect(Object.keys(res.body)).toEqual(['trip', 'state', 'permissions']);
    expect(res.body.state.shopping.find(s => s.id === 'mine').done).toBe(true);
    expect(res.body.state.currentUser).toBe(pid);
    ok(await check(member.cookie, trip.id, 'shopping', 'theirs', true));
    ok(await check(member.cookie, trip.id, 'shopping', 'nobody', true));
    failed(await check(member.cookie, trip.id, 'gear', 'tent', true), 403);
    failed(await check(member.cookie, trip.id, 'shopping', 'missing', true), 404);
    failed(await check(member.cookie, trip.id, 'vehicle', 'v1', true), 400);
    failed(await check(member.cookie, trip.id, 'shopping', 'mine', 'yes'), 400);
    const geared = ok(await check(member.cookie, trip.id, 'gear', 'bag', true)).body.state;
    expect(geared.gear.find(g => g.id === 'bag').ready).toEqual([pid]);
    expect(geared.events[0].actor).toBe('阿哲');
  });
  test('departure requires own packing complete', async () => {
    const { member, trip, pid } = await scenario();
    failed(await check(member.cookie, trip.id, 'depart', '', true), 400);
    ok(await check(member.cookie, trip.id, 'gear', 'bag', true));
    ok(await check(member.cookie, trip.id, 'gear', 'stove', true));
    const res = ok(await check(member.cookie, trip.id, 'depart', '', true));
    expect(res.body.state.departed).toEqual([pid]);
    const undone = ok(await check(member.cookie, trip.id, 'gear', 'bag', false));
    expect(undone.body.state.departed).toEqual([]);
  });
  test('hosts may tick any shopping item; unbound admins cannot pack for others', async () => {
    const { admin, owner, trip } = await scenario();
    ok(await check(owner.cookie, trip.id, 'shopping', 'nobody', true));
    ok(await check(admin.cookie, trip.id, 'shopping', 'mine', true));
    failed(await check(admin.cookie, trip.id, 'gear', 'bag', true), 403);
    failed(await check(admin.cookie, trip.id, 'depart', '', true), 403);
  });
  test('check-offs honour revisions', async () => {
    const { member, trip } = await scenario();
    const rev = (await getTrip(member.cookie, trip.id)).trip.revision;
    ok(await call('POST', `/api/trips/${trip.id}/check`, { cookie: member.cookie, body: { revision: rev, kind: 'shopping', id: 'mine', checked: true } }));
    failed(await call('POST', `/api/trips/${trip.id}/check`, { cookie: member.cookie, body: { revision: rev, kind: 'shopping', id: 'mine', checked: false } }), 409);
  });
});

describe('invites', () => {
  test('owner creates hashed, expiring invite links', async () => {
    await setupAdmin();
    const owner = await register('owner-a', '主辦人');
    const trip = await createTrip(owner.cookie);
    const inv = await invite(owner.cookie, trip.id);
    expect(inv.token).toMatch(/^[a-f0-9]{64}$/);
    expect(inv.urlPath).toBe(`/invite/${inv.token}`);
    expect(Date.parse(inv.expiresAt) - clockMs).toBe(7 * 86400000);
    failed(await call('POST', `/api/trips/${trip.id}/invites`, { cookie: owner.cookie, raw: '' }), 400);
  });
  test('preview requires login and reports membership', async () => {
    await setupAdmin();
    const owner = await register('owner-a', '主辦人');
    const guest = await register('guest-b', '客人');
    const trip = await createTrip(owner.cookie);
    const { token } = await invite(owner.cookie, trip.id);
    failed(await call('GET', `/api/invites/${token}`), 401);
    expect(ok(await call('GET', `/api/invites/${token}`, { cookie: guest.cookie })).body).toEqual({ title: '週末露營', destination: '湖邊營地', startDate: '2026-11-20', endDate: '2026-11-22', alreadyMember: false });
    expect(ok(await call('GET', `/api/invites/${token}`, { cookie: owner.cookie })).body.alreadyMember).toBe(true);
    failed(await call('GET', `/api/invites/${'0'.repeat(64)}`, { cookie: guest.cookie }), 404);
    failed(await call('GET', '/api/invites/not-a-token', { cookie: guest.cookie }), 404);
  });
  test('joining adds a new bound participant, is idempotent and blocks impersonation', async () => {
    await setupAdmin();
    const owner = await register('owner-a', '小安');
    const guest = await register('guest-b', '客人'), other = await register('guest-c', '其他');
    const trip = ok(await call('POST', '/api/trips', { cookie: owner.cookie, body: { legacyState: seed() } }), 201).body.trip;
    const { token } = await invite(owner.cookie, trip.id);
    failed(await join(undefined, token, '新朋友'), 401);
    failed(await join(guest.cookie, token, '阿哲'), 409);
    failed(await join(guest.cookie, token, ' 小安 2 '), 409);
    failed(await join(guest.cookie, token, '   '), 400);
    failed(await join(guest.cookie, token, 'x'.repeat(31)), 400);
    failed(await call('POST', `/api/invites/${token}/join`, { cookie: guest.cookie, body: { name: 1 } }), 400);
    expect(ok(await join(guest.cookie, token, '新朋友', '攝影')).body).toEqual({ tripId: trip.id });
    const env = await getTrip(guest.cookie, trip.id);
    expect(env.state.people.find(p => p.id === env.permissions.personId)).toMatchObject({ name: '新朋友', role: '攝影' });
    expect(env.state.people.filter(p => p.id.startsWith('p'))).toHaveLength(6);
    expect(ok(await join(guest.cookie, token, '另一個名字')).body).toEqual({ tripId: trip.id });
    expect((await getTrip(guest.cookie, trip.id)).state.people).toHaveLength(env.state.people.length);
    expect(ok(await call('GET', `/api/invites/${token}`, { cookie: guest.cookie })).body.alreadyMember).toBe(true);
    expect(ok(await call('GET', '/api/trips', { cookie: guest.cookie })).body.trips.map(t => t.id)).toEqual([trip.id]);
    expect(ok(await call('GET', '/api/trips', { cookie: other.cookie })).body.trips).toEqual([]);
  });
  test('invites expire after 7 days and capacity is bounded', async () => {
    await setupAdmin();
    const owner = await register('owner-a', '主辦人'), guest = await register('guest-b', '客人');
    const trip = await createTrip(owner.cookie);
    const first = await invite(owner.cookie, trip.id);
    for (let i = 1; i < 20; i++) await invite(owner.cookie, trip.id);
    failed(await call('POST', `/api/trips/${trip.id}/invites`, { cookie: owner.cookie, body: {} }), 409);
    clockMs += 7 * 86400000 + 1;
    const guestCookie = await login('guest-b'), ownerCookie = await login('owner-a');
    failed(await join(guestCookie, first.token, '客人'), 404);
    await invite(ownerCookie, trip.id);
  });
});

describe('admin user management', () => {
  test('admin endpoints are admin-only', async () => {
    const admin = await setupAdmin();
    const a = await register('member-a', 'A');
    for (const [method, path, body] of [['GET', '/api/admin/users'], ['GET', '/api/admin/audit'], ['PATCH', `/api/admin/users/${admin.user.id}`, { role: 'member' }], ['POST', `/api/admin/users/${admin.user.id}/delete`, { confirmUsername: 'admin-one' }]]) {
      failed(await call(method, path, { cookie: a.cookie, body }), 403);
      failed(await call(method, path, { body }), 401);
    }
    const users = ok(await call('GET', '/api/admin/users', { cookie: admin.cookie })).body.users;
    expect(users).toEqual([
      { id: admin.user.id, username: 'admin-one', displayName: '管理員', role: 'admin', deleted: false, tripCount: 0 },
      { id: a.user.id, username: 'member-a', displayName: 'A', role: 'member', deleted: false, tripCount: 0 }
    ]);
  });
  test('roles change per request, with self and last-admin protection', async () => {
    const admin = await setupAdmin();
    const a = await register('member-a', 'A');
    failed(await call('PATCH', `/api/admin/users/${admin.user.id}`, { cookie: admin.cookie, body: { role: 'member' } }), 403);
    failed(await call('PATCH', `/api/admin/users/${a.user.id}`, { cookie: admin.cookie, body: { role: 'owner' } }), 400);
    failed(await call('PATCH', `/api/admin/users/${a.user.id}`, { cookie: admin.cookie, body: { displayName: '  ' } }), 400);
    failed(await call('PATCH', '/api/admin/users/missing', { cookie: admin.cookie, body: { role: 'member' } }), 404);
    const promoted = ok(await call('PATCH', `/api/admin/users/${a.user.id}`, { cookie: admin.cookie, body: { role: 'admin', displayName: '阿 A' } })).body.user;
    expect(promoted).toMatchObject({ role: 'admin', displayName: '阿 A', username: 'member-a' });
    ok(await call('GET', '/api/admin/users', { cookie: a.cookie }));
    ok(await call('PATCH', `/api/admin/users/${admin.user.id}`, { cookie: a.cookie, body: { role: 'member' } }));
    failed(await call('GET', '/api/admin/users', { cookie: admin.cookie }), 403);
    failed(await call('PATCH', `/api/admin/users/${a.user.id}`, { cookie: a.cookie, body: { role: 'member' } }), 403);
    expect(ok(await call('PATCH', `/api/admin/users/${a.user.id}`, { cookie: a.cookie, body: { username: 'renamed' } })).body.user.username).toBe('member-a');
  });
  test('cannot delete self, the last admin or without confirmation', async () => {
    const admin = await setupAdmin();
    const a = await register('member-a', 'A');
    failed(await call('POST', `/api/admin/users/${admin.user.id}/delete`, { cookie: admin.cookie, body: { confirmUsername: 'admin-one' } }), 403);
    failed(await call('POST', `/api/admin/users/${a.user.id}/delete`, { cookie: admin.cookie, body: { confirmUsername: 'member-b' } }), 400);
    failed(await call('POST', `/api/admin/users/${a.user.id}/delete`, { cookie: admin.cookie, body: {} }), 400);
    ok(await call('PATCH', `/api/admin/users/${a.user.id}`, { cookie: admin.cookie, body: { role: 'admin' } }));
    ok(await call('POST', `/api/admin/users/${admin.user.id}/delete`, { cookie: a.cookie, body: { confirmUsername: 'admin-one' } }));
    failed(await call('GET', '/api/admin/users', { cookie: admin.cookie }), 401);
    failed(await call('POST', `/api/admin/users/${admin.user.id}/delete`, { cookie: a.cookie, body: { confirmUsername: 'admin-one' } }), 409);
  });
  test('soft delete revokes access, reassigns trips and detaches participant references', async () => {
    const admin = await setupAdmin();
    const owner = await register('owner-a', '主辦人');
    const helper = await register('member-c', '小幫手');
    const trip = ok(await call('POST', '/api/trips', { cookie: owner.cookie, body: { legacyState: seed() } }), 201).body.trip;
    const { token } = await invite(owner.cookie, trip.id);
    ok(await join(helper.cookie, token, '小幫手'));
    const ownerPid = (await getTrip(owner.cookie, trip.id)).permissions.personId;
    const helperPid = (await getTrip(helper.cookie, trip.id)).permissions.personId;
    ok(await putState(owner.cookie, trip.id, s => {
      s.meals[0].cookId = ownerPid;
      s.shopping[0].assignee = ownerPid;
      s.gear.find(g => g.id === 'g5').assignee = ownerPid;
      s.gear.find(g => g.id === 'g5').ready = [ownerPid];
      s.gear[0].ready = [ownerPid, helperPid];
      s.activities[0].people.push(ownerPid);
      s.vehicles[0] = { ...s.vehicles[0], driver: ownerPid, passengers: ['p1', helperPid], seats: 4 };
      s.departed = [ownerPid];
    }));
    const pending = await invite(owner.cookie, trip.id);
    const before = await getTrip(owner.cookie, trip.id);

    ok(await call('POST', `/api/admin/users/${owner.user.id}/delete`, { cookie: admin.cookie, body: { confirmUsername: 'owner-a' } }));

    failed(await call('GET', '/api/trips', { cookie: owner.cookie }), 401);
    failed(await call('POST', '/api/login', { body: { username: 'owner-a', password: PASS } }), 401);
    failed(await call('POST', '/api/register', { body: { username: 'owner-a', displayName: '冒名', password: PASS } }), 409);
    failed(await call('GET', `/api/invites/${pending.token}`, { cookie: helper.cookie }), 404);

    const env = await getTrip(admin.cookie, trip.id);
    const s = env.state;
    expect(isValidState(s)).toBe(true);
    expect(env.trip).toMatchObject({ ownerId: admin.user.id, ownerUsername: 'admin-one', isMember: true, canEdit: true });
    expect(env.permissions.personId).toBeTruthy();
    expect(s.people.some(p => p.id === ownerPid)).toBe(false);
    expect(s.people.find(p => p.id === env.permissions.personId).name).toBe('管理員');
    expect(s.meals[0].cookId).toBe('');
    expect(s.shopping[0].assignee).toBe('');
    expect(s.gear.find(g => g.id === 'g5')).toMatchObject({ assignee: '', ready: [] });
    expect(s.gear[0].ready).toEqual([helperPid]);
    expect(s.activities[0].people).not.toContain(ownerPid);
    expect(s.vehicles[0]).toMatchObject({ id: before.state.vehicles[0].id, name: '山線小巴', meeting: before.state.vehicles[0].meeting, seats: 4, driver: '', passengers: ['p1', helperPid] });
    expect(s.vehicles).toHaveLength(before.state.vehicles.length);
    expect(s.departed).toEqual([]);
    for (const key of ['meals', 'shopping', 'gear', 'activities', 'vehicles']) expect(s[key].length).toBe(before.state[key].length);
    expect(s.events.slice(1)).toEqual(before.state.events);
    expect(s.trip).toEqual(before.state.trip);

    const helperView = await getTrip(helper.cookie, trip.id);
    expect(helperView.permissions.personId).toBe(helperPid);
    const users = ok(await call('GET', '/api/admin/users', { cookie: admin.cookie })).body.users;
    expect(users.find(u => u.username === 'owner-a')).toMatchObject({ deleted: true, tripCount: 0 });
    expect(users.find(u => u.username === 'admin-one').tripCount).toBe(1);
    failed(await call('PATCH', `/api/admin/users/${owner.user.id}`, { cookie: admin.cookie, body: { displayName: 'x' } }), 409);
    const audit = ok(await call('GET', '/api/admin/audit', { cookie: admin.cookie })).body.events;
    expect(audit[0]).toMatchObject({ actor: 'admin-one', action: 'user.delete', target: 'user:owner-a' });
  });
  test('deleting a member of a full 100-person trip keeps the trip valid', async () => {
    const admin = await setupAdmin();
    const owner = await register('owner-a', '主辦人');
    const trip = await createTrip(owner.cookie);
    ok(await putState(owner.cookie, trip.id, s => { for (let i = s.people.length; i < 99; i++) s.people.push({ id: `x${i}`, name: `旅伴${i}`, color: 'blue', role: '' }); }));
    const { token } = await invite(owner.cookie, trip.id);
    const last = await register('member-z', 'Z');
    ok(await join(last.cookie, token, '第一百位'));
    expect((await getTrip(owner.cookie, trip.id)).state.people).toHaveLength(100);
    const late = await register('member-y', 'Y');
    const fresh = await invite(owner.cookie, trip.id);
    failed(await join(late.cookie, fresh.token, '一百零一'), 409);
    ok(await call('POST', `/api/admin/users/${owner.user.id}/delete`, { cookie: admin.cookie, body: { confirmUsername: 'owner-a' } }));
    const env = await getTrip(admin.cookie, trip.id);
    expect(env.state.people).toHaveLength(100);
    expect(env.trip.ownerId).toBe(admin.user.id);
    expect(isValidState(env.state)).toBe(true);
  });
  test('an admin cannot be locked out by stale client role flags', async () => {
    const admin = await setupAdmin();
    const a = await register('member-a', 'A');
    const trip = await createTrip(a.cookie);
    ok(await call('PATCH', `/api/admin/users/${a.user.id}`, { cookie: admin.cookie, body: { role: 'admin' } }));
    ok(await call('GET', '/api/admin/users', { cookie: a.cookie }));
    ok(await call('PATCH', `/api/admin/users/${a.user.id}`, { cookie: admin.cookie, body: { role: 'member' } }));
    failed(await call('GET', '/api/admin/users', { cookie: a.cookie }), 403);
    const other = await register('member-b', 'B');
    failed(await call('GET', `/api/trips/${trip.id}`, { cookie: other.cookie }), 404);
  });
});

// 「拒絕公開資料庫路徑」改由 tests/config.test.js 驗證（設定不會產生任何 SQLite 檔案路徑）。
test('service requires a Database pool, never a file path, and closes cleanly', async () => {
  await expect(createAccountService({ dbPath: 'dist/accounts.sqlite' })).rejects.toThrow(TypeError);
  await expect(createAccountService({})).rejects.toThrow(TypeError);
  const extra = await createAccountService({ db: serviceDb(db.sql) });
  extra.close();
  extra.close();
  // service.close() 不關閉注入的連線池
  expect(Number((await db.sql`SELECT 1 AS ok`)[0].ok)).toBe(1);
});

describe('service options and local CLI hooks (security-harden, task 18.4)', () => {
  test('invalid registrationPolicy or receiptAiPolicySeed is refused at construction', async () => {
    await expect(createAccountService({ db: serviceDb(db.sql), registrationPolicy: 'invite-only' })).rejects.toThrow(TypeError);
    await expect(createAccountService({ db: serviceDb(db.sql), receiptAiPolicySeed: 'everyone' })).rejects.toThrow(TypeError);
  });

  test('receiptAiPolicy() reports default, seed and stored sources; the seed is never written', async () => {
    expect(await svc.receiptAiPolicy()).toEqual({ value: 'all', source: 'default', updatedAt: null, updatedBy: null });
    const seeded = await createAccountService({ db: serviceDb(db.sql), receiptAiPolicySeed: 'admins', now: () => clockMs });
    try {
      expect(await seeded.receiptAiPolicy()).toMatchObject({ value: 'admins', source: 'seed' });
      expect(Number((await db.sql`SELECT COUNT(*) AS n FROM settings`)[0].n)).toBe(0);
      const { cookie } = await setupAdmin();
      ok(await call('PATCH', '/api/admin/settings', { cookie, body: { receiptAiPolicy: 'off' } }));
      expect(await seeded.receiptAiPolicy()).toEqual({ value: 'off', source: 'stored', updatedAt: new Date(clockMs).toISOString(), updatedBy: 'admin-one' });
    } finally { seeded.close(); }
  });

  test('createFirstAdmin creates one admin with the given audit action and then answers 409', async () => {
    const user = await svc.createFirstAdmin({ username: 'cli-admin', displayName: 'CLI 管理員', password: PASS }, { auditAction: 'setup.cli' });
    expect(user).toMatchObject({ username: 'cli-admin', role: 'admin' });
    expect(await svc.needsSetup()).toBe(false);
    await expect(svc.createFirstAdmin({ username: 'cli-two', displayName: 'x', password: PASS })).rejects.toMatchObject({ status: 409 });
    await expect(svc.createFirstAdmin({ username: 'Bad Name', displayName: 'x', password: PASS })).rejects.toMatchObject({ status: 400 });
    const audit = await db.sql`SELECT actor, action, target FROM audit ORDER BY id`;
    expect(audit.map(r => ({ ...r }))).toEqual([{ actor: 'cli-admin', action: 'setup.cli', target: 'user:cli-admin' }]);
    expect(JSON.stringify(audit)).not.toContain(PASS);
  });

  test('resetPassword replaces the hash, ends every session of the account, and audits without the password', async () => {
    const NEW = 'replacement test password';
    await setupAdmin();
    const member = await register('member-a');
    await login('member-a');
    expect(Number((await db.sql`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ${member.user.id}`)[0].n)).toBe(2);
    expect(await svc.resetPassword('member-a', NEW)).toBe('member-a');
    expect(Number((await db.sql`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ${member.user.id}`)[0].n)).toBe(0);
    expect(ok(await call('GET', '/api/session', { cookie: member.cookie })).body.user).toBeNull();
    failed(await call('POST', '/api/login', { body: { username: 'member-a', password: PASS } }), 401);
    ok(await call('POST', '/api/login', { body: { username: 'member-a', password: NEW } }));
    const audit = await db.sql`SELECT actor, action, target FROM audit WHERE action = 'password.reset.cli'`;
    expect(audit.map(r => ({ ...r }))).toEqual([{ actor: 'local-cli', action: 'password.reset.cli', target: 'user:member-a' }]);
    expect(JSON.stringify(await db.sql`SELECT * FROM audit`)).not.toContain(NEW);
    await expect(svc.resetPassword('nobody-here', NEW)).rejects.toMatchObject({ status: 404 });
    await expect(svc.resetPassword('member-a', 'short')).rejects.toMatchObject({ status: 400 });
    const admin = await login('admin-one');
    ok(await call('POST', `/api/admin/users/${member.user.id}/delete`, { cookie: admin, body: { confirmUsername: 'member-a' } }));
    await expect(svc.resetPassword('member-a', NEW)).rejects.toMatchObject({ status: 404 });
  });

  test('OPTIONS is 405 and a cross-site Sec-Fetch-Site mutation is 403 even with the right Origin', async () => {
    const res = await svc.handle(new Request(`${BASE}/api/trips`, { method: 'OPTIONS', headers: { origin: BASE } }));
    expect(res.status).toBe(405);
    expect(res.headers.get('set-cookie')).toBeNull();
    const cross = await svc.handle(new Request(`${BASE}/api/logout`, { method: 'POST', headers: { origin: BASE, 'sec-fetch-site': 'cross-site' } }));
    expect(cross.status).toBe(403);
    expect(await cross.json()).toEqual({ error: '不接受跨站請求。' });
  });
});

test('requests after close fail closed', async () => {
  const extra = await createAccountService({ db: serviceDb(db.sql) });
  extra.close();
  const res = await extra.handle(new Request(`${BASE}/api/session`));
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: expect.any(String) });
});

test('a session revoked while the body is still uploading cannot commit', async () => {
  const { cookie } = await setupAdmin();
  const trip = await createTrip(cookie);
  let push;
  const body = new ReadableStream({ start(controller) { push = controller; } });
  const pending = svc.handle(new Request(`${BASE}/api/trips/${trip.id}`, { method: 'PATCH', headers: { cookie, origin: BASE, 'content-type': 'application/json' }, body, duplex: 'half' }));
  await new Promise(resolve => setTimeout(resolve, 5));
  ok(await call('POST', '/api/logout', { cookie }));
  push.enqueue(new TextEncoder().encode(JSON.stringify({ revision: 1, title: 'too late' })));
  push.close();
  const res = await pending;
  expect(res.status).toBe(401);
  const fresh = await login('admin-one');
  expect((await getTrip(fresh, trip.id)).trip.title).toBe('週末露營');
});

describe('admin trip soft deletion', () => {
  const del = (cookie, tripId, body) => call('POST', `/api/admin/trips/${tripId}/delete`, { cookie, body });
  const confirm = (admin, trip, extra = {}) => ({ expectedUserId: admin.user.id, confirmTitle: trip.title, revision: trip.revision, ...extra });
  const auditActions = async cookie => ok(await call('GET', '/api/admin/audit', { cookie })).body.events.filter(e => e.action === 'trip.delete');
  const listIds = async cookie => ok(await call('GET', '/api/trips', { cookie })).body.trips.map(t => t.id);

  async function world() {
    const admin = await setupAdmin();
    const owner = await register('owner-a', '主辦人'), member = await register('member-b', '旅伴');
    const trip = await createTrip(owner.cookie, { title: '要刪的露營' });
    const keep = await createTrip(owner.cookie, { title: '保留的露營' });
    const { token } = await invite(owner.cookie, trip.id);
    ok(await join(member.cookie, token, '旅伴'));
    ok(await join(member.cookie, (await invite(owner.cookie, keep.id)).token, '旅伴'));
    const fresh = (await getTrip(owner.cookie, trip.id)).trip;
    return { admin, owner, member, trip: fresh, keep, token };
  }

  test('owner, member and anonymous callers are denied without changes', async () => {
    const { admin, owner, member, trip } = await world();
    failed(await del(undefined, trip.id, confirm(owner, trip)), 401);
    failed(await del(owner.cookie, trip.id, confirm(owner, trip)), 403);
    failed(await del(member.cookie, trip.id, confirm(member, trip)), 403);
    expect((await getTrip(owner.cookie, trip.id)).trip.revision).toBe(trip.revision);
    expect(await listIds(member.cookie)).toContain(trip.id);
    expect(await auditActions(admin.cookie)).toEqual([]);
  });

  test('exact confirmation title, current revision and expected identity are all required', async () => {
    const { admin, owner, member, trip, token } = await world();
    const bad = [
      [{ expectedUserId: undefined }, 400], [{ expectedUserId: 42 }, 400], [{ expectedUserId: owner.user.id }, 409],
      [{ confirmTitle: undefined }, 400], [{ confirmTitle: ' 要刪的露營' }, 400], [{ confirmTitle: '要刪的露營 ' }, 400], [{ confirmTitle: '要刪的' }, 400],
      [{ revision: undefined }, 400], [{ revision: '2' }, 400], [{ revision: trip.revision - 1 }, 409], [{ revision: trip.revision + 1 }, 409]
    ];
    for (const [extra, status] of bad) {
      const body = confirm(admin, trip, extra);
      for (const key of Object.keys(extra)) if (extra[key] === undefined) delete body[key];
      failed(await del(admin.cookie, trip.id, body), status);
    }
    failed(await del(admin.cookie, 'missing-trip', confirm(admin, trip)), 404);
    failed(await del(admin.cookie, '..%2Fx', confirm(admin, trip)), 404);
    expect((await getTrip(owner.cookie, trip.id)).trip.revision).toBe(trip.revision);
    expect(ok(await call('GET', `/api/invites/${token}`, { cookie: member.cookie })).body.alreadyMember).toBe(true);
    expect(await auditActions(admin.cookie)).toEqual([]);
    failed(await call('DELETE', `/api/admin/trips/${trip.id}/delete`, { cookie: admin.cookie }), 405);
    failed(await call('POST', `/api/admin/trips/${trip.id}/delete`, { cookie: admin.cookie, body: confirm(admin, trip), origin: 'http://evil.example' }), 403);
  });

  test('admin deletes another user\'s trip; it is hidden and unreachable everywhere', async () => {
    const { admin, owner, member, trip, keep, token } = await world();
    const stranger = await register('guest-c', '路人');
    const pending = await invite(owner.cookie, trip.id);
    const keepBefore = await getTrip(owner.cookie, keep.id);
    const usersBefore = ok(await call('GET', '/api/admin/users', { cookie: admin.cookie })).body.users;
    expect(usersBefore.find(u => u.username === 'member-b').tripCount).toBe(2);

    expect(ok(await del(admin.cookie, trip.id, confirm(admin, trip))).body).toEqual({ ok: true });

    for (const who of [admin, owner, member]) expect(await listIds(who.cookie)).toEqual([keep.id]);
    for (const who of [admin, owner, member]) {
      failed(await call('GET', `/api/trips/${trip.id}`, { cookie: who.cookie }), 404);
      failed(await call('PATCH', `/api/trips/${trip.id}`, { cookie: who.cookie, body: { revision: trip.revision, title: '復活' } }), 404);
      failed(await call('PUT', `/api/trips/${trip.id}`, { cookie: who.cookie, body: { revision: trip.revision, state: keepBefore.state } }), 404);
      failed(await call('POST', `/api/trips/${trip.id}/check`, { cookie: who.cookie, body: { revision: trip.revision, kind: 'depart', checked: false } }), 404);
      failed(await call('POST', `/api/trips/${trip.id}/invites`, { cookie: who.cookie, body: {} }), 404);
    }
    for (const t of [token, pending.token]) {
      failed(await call('GET', `/api/invites/${t}`, { cookie: stranger.cookie }), 404);
      failed(await join(stranger.cookie, t, '路人'), 404);
      failed(await join(member.cookie, t, '旅伴'), 404);
    }
    expect(await listIds(stranger.cookie)).toEqual([]);

    failed(await del(admin.cookie, trip.id, confirm(admin, trip)), 409);
    failed(await del(admin.cookie, trip.id, confirm(admin, trip, { revision: trip.revision + 1 })), 409);

    const keepAfter = await getTrip(owner.cookie, keep.id);
    expect(keepAfter).toEqual(keepBefore);
    expect((await getTrip(member.cookie, keep.id)).trip.isMember).toBe(true);
    ok(await call('PATCH', `/api/trips/${keep.id}`, { cookie: owner.cookie, body: { revision: keepAfter.trip.revision, title: '仍可編輯' } }));
    await invite(owner.cookie, keep.id);

    const users = ok(await call('GET', '/api/admin/users', { cookie: admin.cookie })).body.users;
    expect(Object.fromEntries(users.map(u => [u.username, [u.deleted, u.tripCount]]))).toEqual({ 'admin-one': [false, 0], 'owner-a': [false, 1], 'member-b': [false, 1], 'guest-c': [false, 0] });
    const audits = await auditActions(admin.cookie);
    expect(audits).toEqual([{ at: expect.any(String), actor: 'admin-one', action: 'trip.delete', target: `trip:${trip.id}` }]);
  });

  test('admin can delete their own trip and account deletion still transfers remaining trips', async () => {
    const admin = await setupAdmin();
    const owner = await register('owner-a', '主辦人');
    const mine = await createTrip(admin.cookie, { title: '管理員的露營' });
    const gone = await createTrip(owner.cookie, { title: '已刪除' });
    const live = await createTrip(owner.cookie, { title: '仍存在' });
    ok(await del(admin.cookie, mine.id, confirm(admin, mine)));
    ok(await del(admin.cookie, gone.id, confirm(admin, gone)));
    expect(await listIds(admin.cookie)).toEqual([live.id]);
    ok(await call('POST', `/api/admin/users/${owner.user.id}/delete`, { cookie: admin.cookie, body: { confirmUsername: 'owner-a' } }));
    const env = await getTrip(admin.cookie, live.id);
    expect(env.trip).toMatchObject({ ownerId: admin.user.id, isMember: true });
    expect(isValidState(env.state)).toBe(true);
    failed(await call('GET', `/api/trips/${gone.id}`, { cookie: admin.cookie }), 404);
    expect(await listIds(admin.cookie)).toEqual([live.id]);
    const users = ok(await call('GET', '/api/admin/users', { cookie: admin.cookie })).body.users;
    expect(users.find(u => u.username === 'admin-one').tripCount).toBe(1);
    expect((await auditActions(admin.cookie)).map(e => e.target)).toEqual([`trip:${gone.id}`, `trip:${mine.id}`]);
  });

  async function slowDelete(cookie, tripId, body, interrupt) {
    let push;
    const stream = new ReadableStream({ start(controller) { push = controller; } });
    const pending = svc.handle(new Request(`${BASE}/api/admin/trips/${tripId}/delete`, { method: 'POST', headers: { cookie, origin: BASE, 'content-type': 'application/json' }, body: stream, duplex: 'half' }));
    await new Promise(resolve => setTimeout(resolve, 5));
    await interrupt();
    push.enqueue(new TextEncoder().encode(JSON.stringify(body)));
    push.close();
    return pending;
  }

  test('role demoted or session revoked during a slow body cannot commit', async () => {
    const { admin, owner, trip } = await world();
    const second = await register('admin-two', '副管理員');
    ok(await call('PATCH', `/api/admin/users/${second.user.id}`, { cookie: admin.cookie, body: { role: 'admin' } }));
    const demoted = await slowDelete(second.cookie, trip.id, confirm(second, trip), async () => {
      ok(await call('PATCH', `/api/admin/users/${second.user.id}`, { cookie: admin.cookie, body: { role: 'member' } }));
    });
    expect(demoted.status).toBe(403);
    const loggedOut = await slowDelete(admin.cookie, trip.id, confirm(admin, trip), async () => {
      ok(await call('POST', '/api/logout', { cookie: admin.cookie }));
    });
    expect(loggedOut.status).toBe(401);
    const fresh = await login('admin-one');
    const swapped = await slowDelete(fresh, trip.id, confirm(admin, trip, { expectedUserId: second.user.id }), async () => {});
    expect(swapped.status).toBe(409);
    expect((await getTrip(owner.cookie, trip.id)).trip.revision).toBe(trip.revision);
    expect(await auditActions(fresh)).toEqual([]);
    ok(await del(fresh, trip.id, confirm(admin, trip)));
  });
});

describe('collaborator edit and owner-only delete rights', () => {
  const del = (cookie, tripId, body) => call('POST', `/api/trips/${tripId}/delete`, { cookie, body });
  const confirm = (who, trip, extra = {}) => ({ expectedUserId: who.user.id, confirmTitle: trip.title, revision: trip.revision, ...extra });
  const listTrips = async cookie => ok(await call('GET', '/api/trips', { cookie })).body.trips;
  const caps = t => ({ canEdit: t.canEdit, canDelete: t.canDelete, canInvite: t.canInvite, canManage: t.canManage });
  const MEMBER = { canEdit: true, canDelete: false, canInvite: true, canManage: false };
  const HOST = { canEdit: true, canDelete: true, canInvite: true, canManage: true };

  async function world() {
    const admin = await setupAdmin();
    const owner = await register('owner-a', '主辦人'), member = await register('member-b', '旅伴'), outsider = await register('guest-c', '路人');
    const trip = await createTrip(owner.cookie, { title: '共編露營' });
    const { token } = await invite(owner.cookie, trip.id);
    ok(await join(member.cookie, token, '旅伴'));
    const ownerPid = (await getTrip(owner.cookie, trip.id)).permissions.personId;
    const pid = (await getTrip(member.cookie, trip.id)).permissions.personId;
    const seeded = ok(await putState(owner.cookie, trip.id, s => {
      s.people.push({ id: 'extra', name: '小熊', color: s.people[0].color, role: '' });
      s.activities = [{ id: 'act1', date: '2026-11-20', time: '09:00', title: '集合', type: 'meet', location: '車站', note: '', people: [], done: false }];
      s.meals = [{ id: 'meal1', date: '2026-11-20', slot: '晚餐', title: '咖哩', cookId: '', servings: 4, ingredients: '洋蔥、紅蘿蔔', notes: '' }];
      s.shopping = [
        { id: 'manual1', name: '冰塊', quantity: '1 袋', category: '其他', assignee: '', done: false, source: 'manual' },
        { id: 'bought1', name: '木炭', quantity: '1 箱', category: '其他', assignee: '', done: true }
      ];
      s.gear = [
        { id: 'bag', name: '睡袋', quantity: '1', scope: 'personal', assignee: '', ready: [] },
        { id: 'stove', name: '爐子', quantity: '1', scope: 'shared', assignee: pid, ready: [] },
        { id: 'tent', name: '帳篷', quantity: '1', scope: 'shared', assignee: ownerPid, ready: [] }
      ];
      s.vehicles = [{ id: 'car1', name: '小白', driver: ownerPid, seats: 5, passengers: [], meeting: '車站' }];
    })).body;
    const generated = name => seeded.state.shopping.find(s => s.name === name && s.source === 'meal').id;
    return { admin, owner, member, outsider, trip: seeded.trip, token, ownerPid, pid, onion: generated('洋蔥'), carrot: generated('紅蘿蔔') };
  }

  test('list and envelope expose capabilities; forged permission fields are ignored', async () => {
    const { admin, owner, member, outsider, trip } = await world();
    expect(caps((await listTrips(owner.cookie))[0])).toEqual(HOST);
    expect(caps((await listTrips(member.cookie))[0])).toEqual(MEMBER);
    expect(caps((await listTrips(admin.cookie))[0])).toEqual(HOST);
    expect(await listTrips(outsider.cookie)).toEqual([]);
    const env = await getTrip(member.cookie, trip.id);
    expect(caps(env.trip)).toEqual(MEMBER);
    expect(env.permissions).toEqual({ ...MEMBER, personId: expect.any(String) });
    expect((await getTrip(owner.cookie, trip.id)).permissions).toMatchObject(HOST);
    const forged = ok(await call('PUT', `/api/trips/${trip.id}`, { cookie: member.cookie, body: { revision: trip.revision, canDelete: true, permissions: HOST, role: 'admin', state: { ...env.state, permissions: HOST } } }));
    expect(forged.body.permissions).toEqual({ ...MEMBER, personId: env.permissions.personId });
    expect(forged.body.trip.ownerId).toBe(owner.user.id);
    failed(await del(member.cookie, trip.id, confirm(member, forged.body.trip, { canDelete: true, role: 'admin', permissions: HOST })), 403);
    ok(await call('POST', `/api/trips/${trip.id}/invites`, { cookie: member.cookie, body: { canInvite: true, canDelete: true, permissions: HOST } }), 201);
    expect((await getTrip(member.cookie, trip.id)).permissions).toEqual({ ...MEMBER, personId: env.permissions.personId });
    failed(await call('GET', '/api/admin/users', { cookie: member.cookie }), 403);
  });

  test('invited members edit titles, cards, items and assignments', async () => {
    const { admin, owner, member, trip, pid, ownerPid } = await world();
    const res = ok(await putState(member.cookie, trip.id, s => {
      s.trip.title = '旅伴改的標題';
      s.activities[0].title = '早點集合';
      s.activities[0].people = [pid];
      s.activities.push({ id: 'act2', date: '2026-11-21', time: '18:00', title: '營火', type: 'night', location: '營地', note: '', people: [], done: false });
      s.shopping.find(x => x.id === 'manual1').assignee = ownerPid;
      s.shopping.find(x => x.id === 'manual1').done = true;
      s.shopping.push({ id: 'manual2', name: '棉花糖', quantity: '2 包', category: '零食', assignee: pid, done: false, source: 'manual' });
      Object.assign(s.gear.find(g => g.id === 'tent'), { assignee: pid, ready: [] });
      s.gear.push({ id: 'lamp', name: '營燈', quantity: '1', scope: 'shared', assignee: pid, ready: [pid] });
      s.vehicles[0].passengers = [pid];
      s.people.push({ id: 'new-friend', name: '新朋友', color: s.people[0].color, role: '' });
      s.people.find(p => p.id === 'extra').role = '攝影';
    }));
    const s = res.body.state;
    expect(res.body.trip.title).toBe('旅伴改的標題');
    expect(s.activities.map(a => a.id)).toEqual(['act1', 'act2']);
    expect(s.shopping.find(x => x.id === 'manual1')).toMatchObject({ assignee: ownerPid, done: true });
    expect(s.gear.find(g => g.id === 'tent').assignee).toBe(pid);
    expect(s.events[0].actor).toBe('旅伴');
    const patched = ok(await call('PATCH', `/api/trips/${trip.id}`, { cookie: member.cookie, body: { revision: res.body.trip.revision, title: '卡片也能改', coverKind: 'night', startDate: '2026-11-21', endDate: '2026-11-23' } }));
    expect(patched.body.trip).toMatchObject({ title: '卡片也能改', coverKind: 'night', ownerId: owner.user.id });
    expect(patched.body.state.activities.find(a => a.id === 'act1').date).toBe('2026-11-21');
    const audit = ok(await call('GET', '/api/admin/audit', { cookie: admin.cookie })).body.events;
    expect(audit.slice(0, 2).map(e => [e.actor, e.action])).toEqual([['member-b', 'trip.meta'], ['member-b', 'trip.update']]);
  });

  test('members cannot remove existing items through whole-state PUT; owners can', async () => {
    const { owner, member, trip, onion } = await world();
    const removals = [
      s => { s.activities = []; },
      s => { s.meals = []; s.shopping = s.shopping.filter(x => x.source !== 'meal'); },
      s => { s.gear = s.gear.filter(g => g.id !== 'bag'); },
      s => { s.vehicles = []; },
      s => { s.people = s.people.filter(p => p.id !== 'extra'); },
      s => { s.shopping = s.shopping.filter(x => x.id !== 'manual1'); },
      s => { s.shopping = s.shopping.filter(x => x.id !== 'bought1'); },
      s => { s.shopping = s.shopping.filter(x => x.id !== onion); },
      s => { Object.assign(s.shopping.find(x => x.id === 'manual1'), { source: 'meal', done: false }); },
      s => { Object.assign(s.shopping.find(x => x.id === 'bought1'), { source: 'meal', done: false }); },
      s => { s.shopping.find(x => x.id === onion).done = true; s.shopping = s.shopping.filter(x => x.id !== onion); }
    ];
    for (const mutate of removals) failed(await putState(member.cookie, trip.id, mutate), 403);
    const after = await getTrip(owner.cookie, trip.id);
    expect(after.trip.revision).toBe(trip.revision);
    expect(after.state.shopping.map(x => x.id).sort()).toEqual(['bought1', 'manual1', onion, after.state.shopping.find(x => x.name === '紅蘿蔔').id].sort());
    const res = ok(await putState(owner.cookie, trip.id, s => {
      s.activities = []; s.vehicles = []; s.gear = s.gear.filter(g => g.id !== 'bag');
      s.people = s.people.filter(p => p.id !== 'extra');
      s.shopping = s.shopping.filter(x => x.id !== 'manual1' && x.id !== 'bought1');
    }));
    expect(res.body.state).toMatchObject({ activities: [], vehicles: [] });
    expect(res.body.state.people.some(p => p.id === 'extra')).toBe(false);
    expect(res.body.state.shopping.some(x => x.id === 'manual1')).toBe(false);
  });

  test('recipe edits by members may auto-prune untouched generated rows only', async () => {
    const { member, trip, onion, carrot } = await world();
    const dropped = ok(await putState(member.cookie, trip.id, s => {
      s.meals[0].ingredients = '洋蔥';
      s.shopping = s.shopping.filter(x => x.id !== carrot);
    }));
    expect(dropped.body.state.shopping.map(x => x.id).sort()).toEqual(['bought1', 'manual1', onion].sort());
    const kept = ok(await putState(member.cookie, trip.id, s => { s.meals[0].ingredients = '馬鈴薯'; }));
    const names = kept.body.state.shopping.map(x => x.name);
    expect(names).toContain('馬鈴薯');
    expect(names).not.toContain('洋蔥');
    expect(kept.body.state.shopping.filter(x => ['manual1', 'bought1'].includes(x.id))).toHaveLength(2);
    failed(await putState(member.cookie, trip.id, s => { s.meals[0].ingredients = '冰塊'; s.shopping = s.shopping.filter(x => x.id !== 'manual1'); }), 403);
  });

  test('members cannot relabel manual rows as generated to prune them later', async () => {
    const { owner, member, trip } = await world();
    for (const id of ['manual1', 'bought1']) {
      failed(await putState(member.cookie, trip.id, s => {
        s.meals[0].ingredients = `洋蔥、紅蘿蔔、${s.shopping.find(x => x.id === id).name}`;
        Object.assign(s.shopping.find(x => x.id === id), { source: 'meal', done: false });
      }), 403);
    }
    expect((await getTrip(owner.cookie, trip.id)).trip.revision).toBe(trip.revision);
  });

  test('bought generated rows unticked by members are retained when the recipe changes', async () => {
    const { owner, member, trip, onion, carrot } = await world();
    const tick = async (who, id, checked) => ok(await call('POST', `/api/trips/${trip.id}/check`, { cookie: who.cookie, body: { revision: (await getTrip(who.cookie, trip.id)).trip.revision, kind: 'shopping', id, checked } })).body.state;
    await tick(owner, onion, true);
    expect((await tick(owner, carrot, true)).shopping.find(x => x.id === carrot).source).toBe('meal');
    const unticked = await tick(member, onion, false);
    expect(unticked.shopping.find(x => x.id === onion)).toMatchObject({ done: false, source: 'manual', mealIds: ['meal1'] });
    const viaPut = ok(await putState(member.cookie, trip.id, s => {
      s.meals[0].ingredients = '馬鈴薯';
      Object.assign(s.shopping.find(x => x.id === carrot), { done: false, source: 'meal' });
    })).body.state;
    expect(viaPut.shopping.find(x => x.id === onion)).toMatchObject({ source: 'manual', mealIds: [], recipeRemoved: true });
    expect(viaPut.shopping.find(x => x.id === carrot)).toMatchObject({ done: false, source: 'manual', mealIds: [] });
    expect(viaPut.shopping.map(x => x.name)).toContain('馬鈴薯');
    expect((await tick(member, onion, true)).shopping.find(x => x.id === onion).done).toBe(true);
  });

  test('members cannot rewrite other accounts or pack for others; own packing still works', async () => {
    const { owner, member, trip, ownerPid, pid } = await world();
    for (const key of ['name', 'role']) failed(await putState(member.cookie, trip.id, s => { s.people.find(p => p.id === ownerPid)[key] = '被改了'; }), 403);
    failed(await putState(member.cookie, trip.id, s => { s.gear.find(g => g.id === 'bag').ready = [ownerPid]; }), 403);
    failed(await putState(member.cookie, trip.id, s => { s.gear.find(g => g.id === 'tent').ready = [ownerPid]; }), 403);
    failed(await putState(member.cookie, trip.id, s => { s.departed = [ownerPid]; }), 403);
    failed(await putState(member.cookie, trip.id, s => { s.departed = [pid]; }), 400);
    const rev = (await getTrip(owner.cookie, trip.id)).trip.revision;
    ok(await call('POST', `/api/trips/${trip.id}/check`, { cookie: owner.cookie, body: { revision: rev, kind: 'gear', id: 'bag', checked: true } }));
    failed(await putState(member.cookie, trip.id, s => { s.gear.find(g => g.id === 'bag').ready = []; }), 403);
    const mine = ok(await putState(member.cookie, trip.id, s => {
      s.people.find(p => p.id === pid).name = '旅伴改名';
      s.people.find(p => p.id === 'extra').name = '小熊熊';
      s.gear.find(g => g.id === 'bag').ready.push(pid);
      s.gear.find(g => g.id === 'stove').ready = [pid];
    })).body.state;
    expect(mine.gear.find(g => g.id === 'bag').ready.sort()).toEqual([ownerPid, pid].sort());
    expect(mine.people.find(p => p.id === pid).name).toBe('旅伴改名');
    expect(ok(await putState(member.cookie, trip.id, s => { s.departed = [pid]; })).body.state.departed).toEqual([pid]);
    const reassigned = ok(await putState(member.cookie, trip.id, s => { Object.assign(s.gear.find(g => g.id === 'tent'), { assignee: pid, ready: [] }); s.departed = []; })).body.state;
    expect(reassigned.gear.find(g => g.id === 'tent').assignee).toBe(pid);
  });

  test('delete matrix: outsiders 404, guests 403, owners only their own, admins any', async () => {
    const { admin, owner, member, outsider, trip, token } = await world();
    const other = await register('owner-d', '別人');
    const theirs = await createTrip(other.cookie, { title: '別人的露營' });
    const { token: otherToken } = await invite(other.cookie, theirs.id);
    ok(await join(owner.cookie, otherToken, '主辦人'));
    const theirsNow = (await getTrip(other.cookie, theirs.id)).trip;
    failed(await del(undefined, trip.id, confirm(owner, trip)), 401);
    failed(await del(outsider.cookie, trip.id, confirm(outsider, trip)), 404);
    failed(await del(member.cookie, trip.id, confirm(member, trip)), 403);
    failed(await del(owner.cookie, theirs.id, confirm(owner, theirsNow)), 403);
    failed(await del(outsider.cookie, theirs.id, confirm(outsider, theirsNow)), 404);
    failed(await call('POST', `/api/admin/trips/${trip.id}/delete`, { cookie: owner.cookie, body: confirm(owner, trip) }), 403);
    for (const [extra, status] of [[{ expectedUserId: undefined }, 400], [{ expectedUserId: member.user.id }, 409], [{ confirmTitle: '共編' }, 400], [{ confirmTitle: undefined }, 400], [{ revision: undefined }, 400], [{ revision: trip.revision - 1 }, 409]]) {
      const body = confirm(owner, trip, extra);
      for (const key of Object.keys(extra)) if (extra[key] === undefined) delete body[key];
      failed(await del(owner.cookie, trip.id, body), status);
    }
    failed(await del(owner.cookie, 'missing-trip', confirm(owner, trip)), 404);
    failed(await call('DELETE', `/api/trips/${trip.id}/delete`, { cookie: owner.cookie }), 405);
    failed(await call('POST', `/api/trips/${trip.id}/delete`, { cookie: owner.cookie, body: confirm(owner, trip), origin: 'http://evil.example' }), 403);
    expect((await getTrip(member.cookie, trip.id)).trip.revision).toBe(trip.revision);

    expect(ok(await del(owner.cookie, trip.id, confirm(owner, trip))).body).toEqual({ ok: true });
    for (const who of [owner, member]) failed(await call('GET', `/api/trips/${trip.id}`, { cookie: who.cookie }), 404);
    failed(await call('GET', `/api/invites/${token}`, { cookie: outsider.cookie }), 404);
    failed(await del(owner.cookie, trip.id, confirm(owner, trip)), 409);
    failed(await del(member.cookie, trip.id, confirm(member, trip)), 404);
    failed(await call('POST', `/api/admin/trips/${trip.id}/delete`, { cookie: admin.cookie, body: confirm(admin, trip) }), 409);
    expect((await listTrips(owner.cookie)).map(t => t.id)).toEqual([theirs.id]);

    ok(await del(admin.cookie, theirs.id, confirm(admin, theirsNow)));
    const audits = ok(await call('GET', '/api/admin/audit', { cookie: admin.cookie })).body.events.filter(e => e.action === 'trip.delete');
    expect(audits.map(e => [e.actor, e.target])).toEqual([['admin-one', `trip:${theirs.id}`], ['owner-a', `trip:${trip.id}`]]);
  });

  async function slowDelete(cookie, tripId, body, interrupt) {
    let push;
    const stream = new ReadableStream({ start(controller) { push = controller; } });
    const pending = svc.handle(new Request(`${BASE}/api/trips/${tripId}/delete`, { method: 'POST', headers: { cookie, origin: BASE, 'content-type': 'application/json' }, body: stream, duplex: 'half' }));
    await new Promise(resolve => setTimeout(resolve, 5));
    await interrupt();
    push.enqueue(new TextEncoder().encode(JSON.stringify(body)));
    push.close();
    return pending;
  }

  test('identity, revision and ownership are rechecked after a slow body', async () => {
    const { admin, owner, member, trip } = await world();
    const edited = await slowDelete(owner.cookie, trip.id, confirm(owner, trip), async () => {
      ok(await putState(member.cookie, trip.id, s => { s.trip.note = '同時編輯'; }));
    });
    expect(edited.status).toBe(409);
    const current = (await getTrip(owner.cookie, trip.id)).trip;
    const loggedOut = await slowDelete(owner.cookie, trip.id, confirm(owner, current), async () => {
      ok(await call('POST', '/api/logout', { cookie: owner.cookie }));
    });
    expect(loggedOut.status).toBe(401);
    const ownerCookie = await login('owner-a');
    const swapped = await slowDelete(ownerCookie, trip.id, confirm(member, current), async () => {});
    expect(swapped.status).toBe(409);
    const second = await register('admin-two', '副管理員');
    ok(await call('PATCH', `/api/admin/users/${second.user.id}`, { cookie: admin.cookie, body: { role: 'admin' } }));
    const demoted = await slowDelete(second.cookie, trip.id, confirm(second, current), async () => {
      ok(await call('PATCH', `/api/admin/users/${second.user.id}`, { cookie: admin.cookie, body: { role: 'member' } }));
    });
    expect(demoted.status).toBe(404);
    const removedOwner = await slowDelete(ownerCookie, trip.id, confirm(owner, current), async () => {
      ok(await call('POST', `/api/admin/users/${owner.user.id}/delete`, { cookie: admin.cookie, body: { confirmUsername: 'owner-a' } }));
    });
    expect(removedOwner.status).toBe(401);
    const env = await getTrip(admin.cookie, trip.id);
    expect(env.trip.ownerId).toBe(admin.user.id);
    expect(ok(await call('GET', '/api/admin/audit', { cookie: admin.cookie })).body.events.filter(e => e.action === 'trip.delete')).toEqual([]);
    expect((await getTrip(member.cookie, trip.id)).permissions).toMatchObject(MEMBER);
    failed(await del(member.cookie, trip.id, confirm(member, env.trip)), 403);
  });
});
