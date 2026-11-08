// Security hardening: data isolation, parameterized SQL, server validation, and read-only GETs.
// Covers Properties 8, 9, 10, 11, 12, and 16 of the security-hardening design, plus the examples of task 4.8.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { createAccountService } from '../server/accounts.js';
import { seed } from '../src/model.js';

const BASE = 'http://127.0.0.1:5191';
const PASS = 'correct horse battery';
const CLOCK = Date.parse('2026-11-04T00:00:00Z');
const DAY = 86400000;
const SQL_PAYLOADS = ["' OR 1=1 --", "'; DROP TABLE users; --", '" OR ""="', '1; DELETE FROM sessions', "') UNION SELECT * FROM users --", 'a\u0000b'];
const CARD = { title: '週末露營', destination: '湖邊營地', startDate: '2026-11-20', endDate: '2026-11-22', description: '', note: '', coverKind: 'lake', status: 'planning' };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const cps = s => [...s].length;

// One file-backed account service per world, plus a second connection that only reads (and mints sessions).
async function makeWorld(label) {
  const dir = mkdtempSync(join(tmpdir(), `camping-sec-access-${label}-`));
  const path = join(dir, 'accounts.sqlite');
  const svc = createAccountService({ dbPath: path, now: () => CLOCK });
  const side = new Database(path);
  side.exec('PRAGMA busy_timeout = 5000;');
  let client = 0;
  // Every call gets its own Client_Address so the per-client login, register, and preview limits never interfere.
  const nextClient = () => { client++; return `10.${(client >> 16) & 255}.${(client >> 8) & 255}.${client & 255}`; };

  async function call(method, path, { body, raw, cookie, origin = BASE, type, headers: extra = {}, info } = {}) {
    const headers = { ...extra };
    if (cookie) headers.cookie = cookie;
    if (origin && method !== 'GET' && method !== 'HEAD') headers.origin = origin;
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    if (payload !== undefined && !headers['content-type']) headers['content-type'] = type ?? 'application/json';
    const res = await svc.handle(new Request(BASE + path, { method, headers, body: payload }), info ?? { clientAddress: nextClient() });
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed, text, headerNames: [...res.headers.keys()].sort(), setCookie: res.headers.get('set-cookie') || '' };
  }
  const expectStatus = (res, status) => { if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${res.text}`); return res; };

  async function account(route, username, displayName = username) {
    const res = expectStatus(await call('POST', route, { body: { username, displayName, password: PASS } }), 200);
    return { cookie: res.setCookie.split(';')[0], user: res.body.user, id: res.body.user.id, username };
  }
  const tables = () => side.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(r => r.name);
  const dump = () => Object.fromEntries(tables().map(name => [name, side.query(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  const mintSession = userId => {
    const token = randomBytes(32).toString('hex');
    side.query('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, CLOCK, CLOCK + 7 * DAY);
    return `ggc_session=${token}`;
  };
  const createTrip = async (who, body = CARD) => expectStatus(await call('POST', '/api/trips', { cookie: who.cookie, body }), 201).body.trip;
  const getTrip = async (who, id) => expectStatus(await call('GET', `/api/trips/${id}`, { cookie: who.cookie }), 200).body;
  const createInvite = async (who, tripId) => expectStatus(await call('POST', `/api/trips/${tripId}/invites`, { cookie: who.cookie, body: {} }), 201).body;
  let names = 0;
  async function addMember(owner, tripId, member) {
    const { token } = await createInvite(owner, tripId);
    expectStatus(await call('POST', `/api/invites/${token}/join`, { cookie: member.cookie, body: { name: `旅伴${++names}` } }), 200);
  }
  function close() { side.close(); svc.close(); rmSync(dir, { recursive: true, force: true }); }
  return { svc, side, call, expectStatus, account, dump, mintSession, createTrip, getTrip, createInvite, addMember, close };
}

const expense = (id, personId, extra = {}) => ({ id, date: '2026-11-20', title: '超市採買', amountCents: 90000, payerId: personId, participantIds: [personId], category: '食材', note: '', shoppingId: '', source: 'manual', receiptId: '', receiptLine: '', ...extra });
const errorOnly = res => { expect(res.body).toBeTruthy(); expect(Object.keys(res.body)).toEqual(['error']); };
// A rejected POST /api/login records one Failed_Login_Event (Req 23.1), so for that route the
// Security_Event_Store (and its AUTOINCREMENT counter) is left out of the "unchanged" comparison.
const SECURITY_TABLES = ['security_events', 'security_alerts'];
const comparable = (dump, path) => path !== '/api/login' ? dump : Object.fromEntries(Object.entries(dump)
  .filter(([name]) => !SECURITY_TABLES.includes(name))
  .map(([name, rows]) => [name, name === 'sqlite_sequence' ? rows.filter(r => !SECURITY_TABLES.includes(r.name)) : rows]));

// Requests to every Trip_Scoped_Route and method, as sent by `who`. `inviteId` names an invite of the real trip.
function scopedRequests(who, inviteId, title) {
  return [
    ['GET trip', id => ['GET', `/api/trips/${id}`, {}]],
    ['PUT trip', id => ['PUT', `/api/trips/${id}`, { body: { expectedUserId: who.id, revision: 1, state: seed() } }]],
    ['PATCH trip', id => ['PATCH', `/api/trips/${id}`, { body: { expectedUserId: who.id, revision: 1, title: '改名' } }]],
    ['POST check', id => ['POST', `/api/trips/${id}/check`, { body: { expectedUserId: who.id, revision: 1, kind: 'shopping', id: 's1', checked: true } }]],
    ['GET ledger', id => ['GET', `/api/trips/${id}/ledger`, {}]],
    ['PUT ledger', id => ['PUT', `/api/trips/${id}/ledger`, { body: { expectedUserId: who.id, revision: 0, requestId: 'outsider-1', expenses: [], settlements: [] } }]],
    ['GET receipt-ai', id => ['GET', `/api/trips/${id}/receipt-ai`, {}]],
    ['POST receipt-ai', id => ['POST', `/api/trips/${id}/receipt-ai`, { raw: PNG, headers: { 'content-type': 'image/png', 'x-camping-user-id': who.id, 'x-receipt-consent': 'openai-v1' } }]],
    ['GET invites', id => ['GET', `/api/trips/${id}/invites`, {}]],
    ['POST invites', id => ['POST', `/api/trips/${id}/invites`, { body: { expectedUserId: who.id } }]],
    ['POST revoke', id => ['POST', `/api/trips/${id}/invites/${inviteId}/revoke`, { body: { expectedUserId: who.id } }]],
    ['POST delete', id => ['POST', `/api/trips/${id}/delete`, { body: { expectedUserId: who.id, confirmTitle: title, revision: 1 } }]]
  ];
}

describe('Property 8: outsiders cannot tell a trip exists', () => {
  let w, pool;
  beforeAll(async () => {
    w = await makeWorld('p8');
    await w.account('/api/setup', 'admin-one', '管理員');
    pool = [];
    for (let i = 0; i < 4; i++) pool.push(await w.account('/api/register', `member-${i}`, `成員${i}`));
  });
  afterAll(() => w?.close());

  // Feature: security-hardening, Property 8: Members outside a trip cannot tell the trip exists
  test('every Trip_Scoped_Route answers an outsider exactly like a nonexistent trip', async () => {
    const routeCount = scopedRequests(pool[0], 'x', 'x').length;
    await fc.assert(fc.asyncProperty(
      fc.shuffledSubarray([0, 1, 2, 3], { minLength: 3, maxLength: 3 }),
      fc.integer({ min: 0, max: routeCount - 1 }),
      fc.boolean(),
      async ([ownerIdx, partIdx, outIdx], routeIdx, withLedger) => {
        const owner = pool[ownerIdx], participant = pool[partIdx], outsider = pool[outIdx];
        const trip = await w.createTrip(owner);
        await w.addMember(owner, trip.id, participant);
        const { id: inviteId } = await w.createInvite(owner, trip.id);
        if (withLedger) {
          const personId = (await w.getTrip(owner, trip.id)).permissions.personId;
          w.expectStatus(await w.call('PUT', `/api/trips/${trip.id}/ledger`, { cookie: owner.cookie, body: { expectedUserId: owner.id, revision: 0, requestId: randomUUID(), expenses: [expense('e1', personId)], settlements: [] } }), 200);
        }
        const [name, build] = scopedRequests(outsider, inviteId, trip.title)[routeIdx];
        const send = id => { const [method, path, opts] = build(id); return w.call(method, path, { cookie: outsider.cookie, ...opts }); };
        const before = w.dump();
        const real = await send(trip.id);
        const fake = await send(randomUUID());
        expect(w.dump()).toEqual(before);
        if (real.status !== 404) throw new Error(`${name}: outsider got ${real.status} ${real.text}`);
        expect(fake.status).toBe(404);
        errorOnly(real);
        expect(real.body).toEqual(fake.body);
        expect(real.headerNames).toEqual(fake.headerNames);
      }
    ), { numRuns: 100 });
  }, 120000);
});

describe('Property 9: trip lists match membership', () => {
  let w, admin, pool;
  const model = new Map(); // tripId -> { participants: Set<userId>, live }
  beforeAll(async () => {
    w = await makeWorld('p9');
    admin = await w.account('/api/setup', 'admin-one', '管理員');
    pool = [];
    for (let i = 0; i < 4; i++) pool.push(await w.account('/api/register', `member-${i}`, `成員${i}`));
  });
  afterAll(() => w?.close());

  // Feature: security-hardening, Property 9: Trip lists match membership
  test('GET /api/trips returns exactly the live trips a Member takes part in, and every live trip for an Admin', async () => {
    const tripSpec = fc.record({ owner: fc.integer({ min: 0, max: 3 }), members: fc.subarray([0, 1, 2, 3]), deleted: fc.boolean() });
    await fc.assert(fc.asyncProperty(fc.array(tripSpec, { minLength: 1, maxLength: 3 }), async specs => {
      for (const spec of specs) {
        const owner = pool[spec.owner];
        const trip = await w.createTrip(owner);
        const participants = new Set([owner.id]);
        for (const m of spec.members) {
          if (m === spec.owner) continue;
          await w.addMember(owner, trip.id, pool[m]);
          participants.add(pool[m].id);
        }
        let live = true;
        if (spec.deleted) {
          const env = await w.getTrip(owner, trip.id);
          w.expectStatus(await w.call('POST', `/api/trips/${trip.id}/delete`, { cookie: owner.cookie, body: { expectedUserId: owner.id, confirmTitle: trip.title, revision: env.trip.revision } }), 200);
          live = false;
        }
        model.set(trip.id, { participants, live });
      }
      const listed = async who => new Set(w.expectStatus(await w.call('GET', '/api/trips', { cookie: who.cookie }), 200).body.trips.map(t => t.id));
      for (const member of pool) {
        const expected = new Set([...model].filter(([, t]) => t.live && t.participants.has(member.id)).map(([id]) => id));
        expect(await listed(member)).toEqual(expected);
      }
      expect(await listed(admin)).toEqual(new Set([...model].filter(([, t]) => t.live).map(([id]) => id)));
    }), { numRuns: 100 });
  }, 120000);
});

describe('Property 10: user text round trip', () => {
  let w, owner, trip, personId;
  beforeAll(async () => {
    w = await makeWorld('p10');
    await w.account('/api/setup', 'admin-one', '管理員');
    owner = await w.account('/api/register', 'owner-a', '小安');
    trip = await w.createTrip(owner);
    personId = (await w.getTrip(owner, trip.id)).permissions.personId;
  });
  afterAll(() => w?.close());

  // Trip card text: the server trims, so accepted values are already trimmed (title must be non-empty).
  const tripText = (max, required = false) => fc.oneof(
    { weight: 2, arbitrary: fc.constantFrom(...SQL_PAYLOADS) },
    { weight: 6, arbitrary: fc.string({ unit: 'binary', maxLength: max }) },
    { weight: 1, arbitrary: fc.constantFrom('x'.repeat(max), '界'.repeat(max), '😀'.repeat(max)) }
  ).map(s => s.trim()).filter(s => cps(s) <= max && (!required || s.length > 0));
  // Ledger text: the server NFC-normalizes, trims, and rejects hidden control characters (newlines and tabs allowed in notes).
  const hidden = (s, multiline) => /[\p{Cc}\p{Cf}]/u.test(multiline ? s.replace(/\r?\n|\t/g, '') : s);
  const ledgerText = (max, multiline, required) => fc.oneof(
    { weight: 2, arbitrary: fc.constantFrom(...SQL_PAYLOADS) },
    { weight: 6, arbitrary: fc.string({ unit: 'binary', maxLength: max }) },
    { weight: 1, arbitrary: fc.constantFrom('x'.repeat(max), '界'.repeat(max), '😀'.repeat(max)) }
  ).map(s => s.normalize('NFC').trim())
    .filter(s => s === s.normalize('NFC').trim() && cps(s) <= max && !hidden(s, multiline) && (!required || s.length > 0));

  const auditAppendedOnce = (before, after) => {
    expect(after.audit.length).toBe(before.audit.length + 1);
    expect(after.audit.slice(0, before.audit.length)).toEqual(before.audit);
  };
  // sqlite_sequence holds the audit AUTOINCREMENT counter, which moves with the one appended audit row.
  const without = (d, ...names) => Object.fromEntries(Object.entries(d).filter(([k]) => !names.includes(k) && k !== 'sqlite_sequence'));

  // Feature: security-hardening, Property 10: User text is stored and returned unchanged
  test('trip text and ledger text come back byte-identical and no other row changes', async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({ title: tripText(100, true), destination: tripText(100), description: tripText(1000), note: tripText(1000) }),
      fc.record({ title: ledgerText(100, false, true), note: ledgerText(500, true, false) }),
      async (text, ledgerTextIn) => {
        const env = await w.getTrip(owner, trip.id);
        let before = w.dump();
        const patched = w.expectStatus(await w.call('PATCH', `/api/trips/${trip.id}`, { cookie: owner.cookie, body: { expectedUserId: owner.id, revision: env.trip.revision, ...text } }), 200).body;
        let after = w.dump();
        expect(without(after, 'trips', 'audit')).toEqual(without(before, 'trips', 'audit'));
        auditAppendedOnce(before, after);
        const reread = await w.getTrip(owner, trip.id);
        const row = w.side.query('SELECT title, destination, description, note FROM trips WHERE id = ?').get(trip.id);
        for (const key of Object.keys(text)) {
          expect(patched.trip[key]).toBe(text[key]);
          expect(reread.trip[key]).toBe(text[key]);
          expect(reread.state.trip[key]).toBe(text[key]);
          expect(Buffer.from(row[key], 'utf8').equals(Buffer.from(text[key], 'utf8'))).toBe(true);
        }

        const current = w.expectStatus(await w.call('GET', `/api/trips/${trip.id}/ledger`, { cookie: owner.cookie }), 200).body.ledger;
        before = w.dump();
        w.expectStatus(await w.call('PUT', `/api/trips/${trip.id}/ledger`, { cookie: owner.cookie, body: {
          expectedUserId: owner.id, revision: current.revision, requestId: randomUUID(),
          expenses: [expense('e1', personId, { title: ledgerTextIn.title, note: ledgerTextIn.note })], settlements: []
        } }), 200);
        after = w.dump();
        expect(without(after, 'trip_ledgers', 'audit')).toEqual(without(before, 'trip_ledgers', 'audit'));
        auditAppendedOnce(before, after);
        const stored = w.expectStatus(await w.call('GET', `/api/trips/${trip.id}/ledger`, { cookie: owner.cookie }), 200).body.ledger.expenses[0];
        expect(stored.title).toBe(ledgerTextIn.title);
        expect(stored.note).toBe(ledgerTextIn.note);
      }
    ), { numRuns: 100 });
  }, 120000);
});

describe('Property 11: mutating routes never fail with 5xx and reject atomically', () => {
  let w, admin, owner, member, outsider, victim, trip, joinToken, registerToken, inviteId;
  beforeAll(async () => {
    w = await makeWorld('p11');
    admin = await w.account('/api/setup', 'admin-one', '管理員');
    owner = await w.account('/api/register', 'owner-a', '小安');
    member = await w.account('/api/register', 'member-b', '阿哲');
    outsider = await w.account('/api/register', 'outsider-c', '路人');
    victim = await w.account('/api/register', 'victim-d', '小白');
    trip = await w.createTrip(owner);
    await w.addMember(owner, trip.id, member);
    joinToken = (await w.createInvite(owner, trip.id)).token;
    registerToken = (await w.createInvite(owner, trip.id)).token;
    inviteId = (await w.createInvite(owner, trip.id)).id;
  });
  afterAll(() => w?.close());

  const KEYS = ['username', 'password', 'displayName', 'title', 'destination', 'startDate', 'endDate', 'description', 'note', 'coverKind', 'status',
    'legacyState', 'state', 'revision', 'expectedUserId', 'kind', 'id', 'checked', 'name', 'role', 'requestId', 'expenses', 'settlements',
    'confirmTitle', 'confirmUsername', 'receiptAiPolicy'];
  const OVERSIZE = JSON.stringify({ pad: 'x'.repeat(1024 * 1024) });
  const bodyArb = () => {
    const value = fc.oneof(
      { weight: 3, arbitrary: fc.jsonValue({ maxDepth: 3 }) },
      { weight: 2, arbitrary: fc.constantFrom(owner.id, member.id, 0, 1, 2, -1, true, false, '', 'planning', 'lake', 'shopping', 'gear', 'depart', 'admin', 'member', 'all', 'off', '2026-11-20', [], {}) }
    );
    return fc.oneof(
      { weight: 4, arbitrary: fc.dictionary(fc.constantFrom(...KEYS), value, { maxKeys: 8 }).map(o => JSON.stringify(o)) },
      { weight: 2, arbitrary: fc.object({ maxDepth: 3 }).map(o => JSON.stringify(o)) },
      { weight: 2, arbitrary: fc.jsonValue({ maxDepth: 4 }).map(v => JSON.stringify(v)) },
      { weight: 1, arbitrary: fc.integer({ min: 1, max: 3000 }).map(n => `{"state":${'['.repeat(n)}${']'.repeat(n)}}`) },
      { weight: 1, arbitrary: fc.string({ maxLength: 30 }) },
      { weight: 1, arbitrary: fc.constant(OVERSIZE) }
    );
  };
  // [label, method, path, options]. `cookie: 'fresh'` mints a new session for the owner, so logout cannot end the shared one.
  const routes = () => [
    ['setup', 'POST', '/api/setup', {}],
    ['login', 'POST', '/api/login', {}],
    ['register', 'POST', '/api/register', {}],
    ['logout', 'POST', '/api/logout', { cookie: 'fresh' }],
    ['create trip', 'POST', '/api/trips', { cookie: owner.cookie }],
    ['put trip', 'PUT', `/api/trips/${trip.id}`, { cookie: owner.cookie }],
    ['patch trip', 'PATCH', `/api/trips/${trip.id}`, { cookie: owner.cookie }],
    ['check trip', 'POST', `/api/trips/${trip.id}/check`, { cookie: member.cookie }],
    ['put ledger', 'PUT', `/api/trips/${trip.id}/ledger`, { cookie: owner.cookie }],
    ['receipt ai', 'POST', `/api/trips/${trip.id}/receipt-ai`, { cookie: owner.cookie, headers: { 'x-camping-user-id': owner.id } }],
    ['create invite', 'POST', `/api/trips/${trip.id}/invites`, { cookie: member.cookie }],
    ['revoke invite', 'POST', `/api/trips/${trip.id}/invites/${inviteId}/revoke`, { cookie: owner.cookie }],
    ['delete trip', 'POST', `/api/trips/${trip.id}/delete`, { cookie: owner.cookie }],
    ['join invite', 'POST', `/api/invites/${joinToken}/join`, { cookie: outsider.cookie }],
    ['invite register', 'POST', `/api/invites/${registerToken}/register`, {}],
    ['admin patch user', 'PATCH', `/api/admin/users/${victim.id}`, { cookie: admin.cookie }],
    ['admin delete user', 'POST', `/api/admin/users/${victim.id}/delete`, { cookie: admin.cookie }],
    ['admin delete trip', 'POST', `/api/admin/trips/${trip.id}/delete`, { cookie: admin.cookie }],
    ['admin settings', 'PATCH', '/api/admin/settings', { cookie: admin.cookie }]
  ];

  // Feature: security-hardening, Property 11: Mutating routes never fail with 5xx and reject atomically
  test('random JSON bodies give a status below 500 and leave every table unchanged on 4xx', async () => {
    for (const [label, method, path, opts] of routes()) {
      await fc.assert(fc.asyncProperty(bodyArb(), async raw => {
        const cookie = opts.cookie === 'fresh' ? w.mintSession(owner.id) : opts.cookie;
        const before = w.dump();
        const res = await w.call(method, path, { ...opts, cookie, raw, type: 'application/json' });
        if (res.status >= 500) throw new Error(`${label}: ${res.status} ${res.text} for body ${raw.slice(0, 200)}`);
        // The minted logout session is written before `before`, so it is setup, not part of the request.
        if (res.status >= 400) expect(comparable(w.dump(), path)).toEqual(comparable(before, path));
      }), { numRuns: 100 });
    }
  }, 300000);
});

describe('Property 12: stored trip state keeps only schema fields', () => {
  let w, owner, trip;
  const LIST_KEYS = {
    people: ['id', 'name', 'color', 'role'],
    activities: ['id', 'date', 'time', 'title', 'type', 'location', 'note', 'people', 'done', 'vehicleIds'],
    meals: ['id', 'date', 'slot', 'title', 'cookId', 'servings', 'ingredients', 'notes', 'imageKind'],
    shopping: ['id', 'name', 'quantity', 'category', 'assignee', 'done', 'source', 'mealIds', 'recipeRemoved'],
    gear: ['id', 'name', 'quantity', 'scope', 'assignee', 'ready'],
    vehicles: ['id', 'name', 'driver', 'seats', 'passengers', 'meeting'],
    events: ['id', 'text', 'at', 'actor']
  };
  const TOP_KEYS = ['schema', 'revision', 'currentUser', 'joined', 'trip', 'people', 'activities', 'meals', 'shopping', 'gear', 'vehicles', 'events', 'departed'];
  const TRIP_KEYS = ['title', 'destination', 'startDate', 'endDate', 'description', 'note'];
  const ALL_KEYS = new Set([...TOP_KEYS, ...TRIP_KEYS, ...Object.values(LIST_KEYS).flat()]);
  const COMPARED = ['trip', 'people', 'activities', 'meals', 'gear', 'vehicles'];

  beforeAll(async () => {
    w = await makeWorld('p12');
    await w.account('/api/setup', 'admin-one', '管理員');
    owner = await w.account('/api/register', 'owner-a', '主辦測試');
    trip = await w.createTrip(owner, { legacyState: seed() });
  });
  afterAll(() => w?.close());

  const storedState = () => JSON.parse(w.side.query('SELECT state_json FROM trips WHERE id = ?').get(trip.id).state_json);
  function onlySchemaKeys(state) {
    for (const key of Object.keys(state)) expect(TOP_KEYS).toContain(key);
    for (const key of Object.keys(state.trip)) expect(TRIP_KEYS).toContain(key);
    for (const [list, keys] of Object.entries(LIST_KEYS)) for (const item of state[list]) for (const key of Object.keys(item)) expect(keys).toContain(key);
  }
  const extraArb = fc.record({
    level: fc.constantFrom('top', 'trip', ...Object.keys(LIST_KEYS)),
    index: fc.nat(),
    key: fc.string({ minLength: 1, maxLength: 12 }).filter(k => !ALL_KEYS.has(k) && k !== '__proto__'),
    value: fc.jsonValue({ maxDepth: 2 })
  });

  // Feature: security-hardening, Property 12: Stored trip state keeps only schema fields
  test('PUT /api/trips/{id} drops unknown fields at every level and keeps schema fields unchanged', async () => {
    await fc.assert(fc.asyncProperty(fc.array(extraArb, { minLength: 1, maxLength: 6 }), async extras => {
      const env = await w.getTrip(owner, trip.id);
      const clean = env.state;
      const sent = structuredClone(clean);
      for (const { level, index, key, value } of extras) {
        if (level === 'top') sent[key] = value;
        else if (level === 'trip') sent.trip[key] = value;
        else if (sent[level].length) sent[level][index % sent[level].length][key] = value;
      }
      w.expectStatus(await w.call('PUT', `/api/trips/${trip.id}`, { cookie: owner.cookie, body: { expectedUserId: owner.id, revision: env.trip.revision, state: sent } }), 200);
      const stored = storedState();
      onlySchemaKeys(stored);
      for (const key of COMPARED) expect(stored[key]).toEqual(clean[key]);
      // Applying the cleanup again (saving what was stored) keeps the same schema fields.
      const again = await w.getTrip(owner, trip.id);
      w.expectStatus(await w.call('PUT', `/api/trips/${trip.id}`, { cookie: owner.cookie, body: { expectedUserId: owner.id, revision: again.trip.revision, state: again.state } }), 200);
      const second = storedState();
      onlySchemaKeys(second);
      for (const key of COMPARED) expect(second[key]).toEqual(stored[key]);
    }), { numRuns: 100 });
  }, 120000);
});

describe('Property 16: GET and HEAD never change the database', () => {
  let w, admin, owner, outsider, trip, token;
  beforeAll(async () => {
    w = await makeWorld('p16');
    admin = await w.account('/api/setup', 'admin-one', '管理員');
    owner = await w.account('/api/register', 'owner-a', '小安');
    outsider = await w.account('/api/register', 'outsider-c', '路人');
    trip = await w.createTrip(owner);
    const personId = (await w.getTrip(owner, trip.id)).permissions.personId;
    w.expectStatus(await w.call('PUT', `/api/trips/${trip.id}/ledger`, { cookie: owner.cookie, body: { expectedUserId: owner.id, revision: 0, requestId: 'seed-1', expenses: [expense('e1', personId)], settlements: [] } }), 200);
    token = (await w.createInvite(owner, trip.id)).token;
  });
  afterAll(() => w?.close());

  const GET_ROUTES = [
    () => '/api/session', () => '/api/trips', p => `/api/trips/${p}`, p => `/api/trips/${p}/ledger`, p => `/api/trips/${p}/receipt-ai`,
    p => `/api/trips/${p}/invites`, p => `/api/invites/${p}`, p => `/api/invites/${p}/preview`,
    () => '/api/admin/users', () => '/api/admin/audit', () => '/api/admin/settings', () => '/api/admin/receipt-ai-usage'
  ];

  // Feature: security-hardening, Property 16: GET and HEAD never change the database
  test('GET and HEAD on every GET route leave every table identical', async () => {
    const param = fc.oneof(
      fc.constant(trip.id), fc.constant(token), fc.uuid(),
      fc.string({ minLength: 1, maxLength: 70 }).map(encodeURIComponent),
      fc.constantFrom('%zz', '..%2F..', '%00', ...SQL_PAYLOADS.map(encodeURIComponent))
    );
    const query = fc.option(fc.tuple(fc.string({ maxLength: 10 }), fc.string({ maxLength: 20 })).map(([k, v]) => `?${encodeURIComponent(k)}=${encodeURIComponent(v)}`), { nil: '' });
    const cookie = fc.constantFrom('none', 'admin', 'owner', 'outsider', 'expired', 'garbage');
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: GET_ROUTES.length - 1 }), param, query, fc.constantFrom('GET', 'HEAD'), cookie,
      async (routeIdx, p, q, method, who) => {
        const cookies = { none: undefined, admin: admin.cookie, owner: owner.cookie, outsider: outsider.cookie, garbage: 'ggc_session=zz', expired: `ggc_session=${'0'.repeat(64)}` };
        const before = w.dump();
        const res = await w.call(method, GET_ROUTES[routeIdx](p) + q, { cookie: cookies[who] });
        expect(res.status).toBeLessThan(500);
        if (method === 'HEAD') expect(res.status).toBe(405);
        expect(w.dump()).toEqual(before);
      }), { numRuns: 200 });
  }, 120000);
});

describe('examples: SQL payloads, admin access, outsider ledger, boundary cases', () => {
  let w, admin, owner, other, outsider, trip, ownerPerson, inviteToken, inviteId;
  beforeAll(async () => {
    w = await makeWorld('examples');
    admin = await w.account('/api/setup', 'admin-one', '管理員');
    owner = await w.account('/api/register', 'owner-a', '小安');
    other = await w.account('/api/register', 'other-b', '阿哲');
    outsider = await w.account('/api/register', 'outsider-c', '路人');
    trip = await w.createTrip(owner);
    await w.addMember(owner, trip.id, other);
    ownerPerson = (await w.getTrip(owner, trip.id)).permissions.personId;
    w.expectStatus(await w.call('PUT', `/api/trips/${trip.id}/ledger`, { cookie: owner.cookie, body: { expectedUserId: owner.id, revision: 0, requestId: 'seed-1', expenses: [expense('e1', ownerPerson)], settlements: [] } }), 200);
    ({ token: inviteToken, id: inviteId } = await w.createInvite(owner, trip.id));
  });
  afterAll(() => w?.close());

  test('SQL payloads in login are wrong credentials and start no Session', async () => {
    const reference = await w.call('POST', '/api/login', { body: { username: 'owner-a', password: 'wrong password 123' } });
    expect(reference.status).toBe(401);
    const sessionsBefore = w.dump().sessions;
    const attempts = [
      ...SQL_PAYLOADS.map(p => ({ username: p, password: PASS })),
      // At most four failures per real username, so the loginUser limit (5) is never reached.
      ...SQL_PAYLOADS.map((p, i) => ({ username: i % 2 ? 'other-b' : 'outsider-c', password: p }))
    ];
    for (const body of attempts) {
      const res = await w.call('POST', '/api/login', { body });
      expect(res.status).toBe(401);
      expect(res.body).toEqual(reference.body);
      expect(res.setCookie).toBe('');
    }
    expect(w.dump().sessions).toEqual(sessionsBefore);
  }, 30000);

  test('SQL payloads as invite tokens and trip IDs match no row', async () => {
    const before = w.dump();
    const missingTrip = await w.call('GET', `/api/trips/${randomUUID()}`, { cookie: owner.cookie });
    const missingInvite = await w.call('GET', `/api/invites/${'f'.repeat(64)}`, { cookie: outsider.cookie });
    const missingPreview = await w.call('GET', `/api/invites/${'f'.repeat(64)}/preview`);
    for (const payload of SQL_PAYLOADS) {
      const p = encodeURIComponent(payload);
      const t = await w.call('GET', `/api/trips/${p}`, { cookie: owner.cookie });
      expect(t.status).toBe(404); expect(t.body).toEqual(missingTrip.body);
      const ledger = await w.call('GET', `/api/trips/${p}/ledger`, { cookie: owner.cookie });
      expect(ledger.status).toBe(404); expect(ledger.body).toEqual(missingTrip.body);
      const inv = await w.call('GET', `/api/invites/${p}`, { cookie: outsider.cookie });
      expect(inv.status).toBe(404); expect(inv.body).toEqual(missingInvite.body);
      const preview = await w.call('GET', `/api/invites/${p}/preview`);
      expect(preview.status).toBe(404); expect(preview.body).toEqual(missingPreview.body);
      const join = await w.call('POST', `/api/invites/${p}/join`, { cookie: outsider.cookie, body: { name: '路人' } });
      expect(join.status).toBe(404); expect(join.body).toEqual(missingInvite.body);
    }
    expect(w.dump()).toEqual(before);
  });

  test('SQL payloads in a display name are stored as data', async () => {
    for (const [i, payload] of ["' OR 1=1 --", "'; DROP TABLE users; --"].entries()) {
      const before = w.dump();
      const res = w.expectStatus(await w.call('POST', '/api/register', { body: { username: `sql-name-${i}`, displayName: payload, password: PASS } }), 200);
      expect(res.body.user.displayName).toBe(payload);
      const after = w.dump();
      expect(after.users.slice(0, before.users.length)).toEqual(before.users);
      expect(after.users).toHaveLength(before.users.length + 1);
      for (const table of ['trips', 'trip_members', 'invites', 'trip_ledgers', 'trip_deletions', 'settings']) expect(after[table]).toEqual(before[table]);
      expect(after.sessions.slice(0, before.sessions.length)).toEqual(before.sessions);
    }
  }, 30000);

  test('an Admin outside the trip manages it but gets 404 on Participant_Only_Routes', async () => {
    w.expectStatus(await w.call('GET', `/api/trips/${trip.id}`, { cookie: admin.cookie }), 200);
    w.expectStatus(await w.call('GET', `/api/trips/${trip.id}/invites`, { cookie: admin.cookie }), 200);
    const env = await w.getTrip(admin, trip.id);
    expect(env.permissions.canManage).toBe(true);
    w.expectStatus(await w.call('PATCH', `/api/trips/${trip.id}`, { cookie: admin.cookie, body: { expectedUserId: admin.id, revision: env.trip.revision, note: '管理員備註' } }), 200);

    const ledgerBefore = w.dump().trip_ledgers;
    const missing = await w.call('GET', `/api/trips/${randomUUID()}/ledger`, { cookie: admin.cookie });
    const cases = [
      ['GET', `/api/trips/${trip.id}/ledger`, {}],
      ['PUT', `/api/trips/${trip.id}/ledger`, { body: { expectedUserId: admin.id, revision: 1, requestId: 'admin-1', expenses: [], settlements: [] } }],
      ['GET', `/api/trips/${trip.id}/receipt-ai`, {}],
      ['POST', `/api/trips/${trip.id}/receipt-ai`, { raw: PNG, headers: { 'content-type': 'image/png', 'x-camping-user-id': admin.id, 'x-receipt-consent': 'openai-v1' } }]
    ];
    for (const [method, path, opts] of cases) {
      const res = await w.call(method, path, { cookie: admin.cookie, ...opts });
      expect(res.status).toBe(404);
      expect(res.body).toEqual(missing.body);
    }
    expect(w.dump().trip_ledgers).toEqual(ledgerBefore);
  });

  test('an outsider can neither read nor overwrite a real ledger', async () => {
    const before = w.dump().trip_ledgers;
    expect(before).toHaveLength(1);
    const read = await w.call('GET', `/api/trips/${trip.id}/ledger`, { cookie: outsider.cookie });
    expect(read.status).toBe(404); errorOnly(read);
    const write = await w.call('PUT', `/api/trips/${trip.id}/ledger`, { cookie: outsider.cookie, body: { expectedUserId: outsider.id, revision: 1, requestId: 'evil-1', expenses: [], settlements: [] } });
    expect(write.status).toBe(404); errorOnly(write);
    expect(w.dump().trip_ledgers).toEqual(before);
  });

  test('boundary cases on every mutating JSON route are rejected with 400–422 and change nothing', async () => {
    const long = n => 'x'.repeat(n);
    // 1 MiB + 1 byte of valid JSON.
    const oversize = (() => { const shell = '{"p":""}'; return `{"p":"${'x'.repeat(1024 * 1024 + 1 - shell.length)}"}`; })();
    expect(Buffer.byteLength(oversize)).toBe(1024 * 1024 + 1);
    const env = await w.getTrip(owner, trip.id);
    const rev = env.trip.revision;
    const put = state => ({ expectedUserId: owner.id, revision: rev, state });
    const ledger = extra => ({ expectedUserId: owner.id, revision: 1, requestId: 'edge-1', expenses: [expense('e1', ownerPerson, extra)], settlements: [] });
    const routes = [
      ['POST', '/api/setup', null, [{ username: 'x' }]],
      ['POST', '/api/login', null, [{ username: 5, password: PASS }, { username: 'owner-a' }]],
      ['POST', '/api/register', null, [{ displayName: 'a', password: PASS }, { username: 'AB', displayName: 'a', password: PASS }, { username: 'edge-user', displayName: 'a', password: long(11) }, { username: 'edge-user', displayName: 'a', password: long(129) }, { username: 'edge-user', displayName: 5, password: PASS }]],
      ['POST', `/api/invites/${inviteToken}/register`, null, [{ displayName: 'a', password: PASS }, { username: 'edge-user', displayName: 'a', password: long(11) }, { username: 'edge-user', displayName: 'a', password: PASS, role: 5 }]],
      ['POST', '/api/trips', owner, [{ ...CARD, title: undefined }, { ...CARD, title: 5 }, { ...CARD, title: long(101) }, { ...CARD, coverKind: 'volcano' }, { ...CARD, description: long(1001) }]],
      ['PATCH', `/api/trips/${trip.id}`, owner, [{ revision: rev, title: long(101) }, { revision: rev, title: 5 }, { revision: rev, status: 'archived' }, { title: '新名字' }, { revision: rev, coverKind: 'volcano' }]],
      ['PUT', `/api/trips/${trip.id}`, owner, [{ revision: rev }, put('state'), put({ ...env.state, trip: { ...env.state.trip, title: long(101) } }), { state: env.state }]],
      ['POST', `/api/trips/${trip.id}/check`, owner, [{ revision: rev, kind: 'other', id: 's1', checked: true }, { revision: rev, kind: 'shopping', id: 's1', checked: 'yes' }, { revision: rev, checked: true }]],
      ['PUT', `/api/trips/${trip.id}/ledger`, owner, [{ expectedUserId: owner.id, revision: 1, requestId: 'edge-1', settlements: [] }, ledger({ title: long(101) }), ledger({ amountCents: '900' }), ledger({ category: '不存在' }), ledger({ note: long(501) })]],
      ['POST', `/api/trips/${trip.id}/invites`, owner, [{ expectedUserId: 5 }]],
      ['POST', `/api/trips/${trip.id}/invites/${inviteId}/revoke`, owner, [{ expectedUserId: 5 }]],
      ['POST', `/api/trips/${trip.id}/delete`, owner, [{ confirmTitle: trip.title, revision: rev }, { expectedUserId: owner.id, confirmTitle: '別的名字', revision: rev }, { expectedUserId: owner.id, confirmTitle: trip.title }]],
      ['POST', `/api/invites/${inviteToken}/join`, outsider, [{}, { name: 5 }, { name: '新旅伴', role: 5 }]],
      ['PATCH', `/api/admin/users/${other.id}`, admin, [{ role: 'owner' }, { displayName: 5 }]],
      ['POST', `/api/admin/users/${other.id}/delete`, admin, [{}, { confirmUsername: 'someone-else' }]],
      ['POST', `/api/admin/trips/${trip.id}/delete`, admin, [{ confirmTitle: trip.title, revision: rev }, { expectedUserId: admin.id, confirmTitle: '別的名字', revision: rev }]],
      ['PATCH', '/api/admin/settings', admin, [{}, { receiptAiPolicy: 'maybe' }, { receiptAiPolicy: 5 }]]
    ];
    for (const [method, path, who, cases] of routes) {
      const raws = [...cases.map(c => JSON.stringify(c)), '{broken', '[1,2]', oversize];
      for (const raw of raws) {
        const before = w.dump();
        const res = await w.call(method, path, { cookie: who?.cookie, raw, type: 'application/json' });
        const label = `${method} ${path} ${raw.slice(0, 80)}`;
        if (res.status < 400 || res.status > 422) throw new Error(`${label}: got ${res.status} ${res.text}`);
        // Setup answers 409 (already set up) before reading any body, per the design's handler order.
        if (raw === oversize) expect(res.status).toBe(path === '/api/setup' ? 409 : 413);
        errorOnly(res);
        expect(comparable(w.dump(), path)).toEqual(comparable(before, path));
      }
    }
  }, 60000);
});
