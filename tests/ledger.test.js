import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAccountService } from '../server/accounts.js';
import { summarizeLedger } from '../src/expense-model.js';

const BASE = 'http://127.0.0.1:5181';
const PASS = 'correct horse battery';
const FP = 'a'.repeat(64);
let svc, clockMs;

beforeEach(() => {
  clockMs = Date.parse('2026-11-04T00:00:00Z');
  svc = createAccountService({ dbPath: ':memory:', now: () => clockMs });
});
afterEach(() => svc.close());

function request(method, path, { body, cookie, origin = BASE, stream } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  if (body !== undefined || stream) headers['content-type'] = 'application/json';
  return new Request(BASE + path, { method, headers, body: stream ?? (body === undefined ? undefined : JSON.stringify(body)), ...(stream ? { duplex: 'half' } : {}) });
}
async function send(req, service = svc) {
  const res = await service.handle(req);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const call = (method, path, opts) => send(request(method, path, opts));
const ok = res => { if (res.status !== 200 && res.status !== 201) throw new Error(`expected 2xx, got ${res.status}: ${JSON.stringify(res.body)}`); return res.body; };
const failed = (res, status, pattern) => {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  expect(Object.keys(res.body)).toEqual(['error']);
  expect(res.body.error).toMatch(/[\u4e00-\u9fff]/);
  if (pattern) expect(res.body.error).toMatch(pattern);
  return res;
};

async function account(path, username, displayName) {
  const res = await svc.handle(request('POST', path, { body: { username, displayName, password: PASS } }));
  expect(res.status).toBe(200);
  return { cookie: res.headers.get('set-cookie').split(';')[0], user: (await res.json()).user };
}
const card = { title: '週末露營', destination: '湖邊營地', startDate: '2026-11-20', endDate: '2026-11-22', description: '', note: '', coverKind: 'lake', status: 'planning' };
const getTrip = (who, id) => call('GET', `/api/trips/${id}`, { cookie: who.cookie }).then(ok);
async function putState(who, id, mutate, extra = {}) {
  const env = await getTrip(who, id);
  const state = structuredClone(env.state);
  mutate(state);
  return call('PUT', `/api/trips/${id}`, { cookie: who.cookie, body: { revision: env.trip.revision, state, ...extra } });
}

async function world() {
  const admin = await account('/api/setup', 'admin-one', '管理員');
  const owner = await account('/api/register', 'owner-a', '小安');
  const member = await account('/api/register', 'member-b', '阿哲');
  const outsider = await account('/api/register', 'outsider-c', '路人');
  const trip = ok(await call('POST', '/api/trips', { cookie: owner.cookie, body: card })).trip;
  const { token } = ok(await call('POST', `/api/trips/${trip.id}/invites`, { cookie: owner.cookie, body: {} }));
  ok(await call('POST', `/api/invites/${token}/join`, { cookie: member.cookie, body: { name: '阿哲' } }));
  const env = await getTrip(owner, trip.id);
  owner.personId = env.permissions.personId;
  member.personId = env.state.people.find(p => p.name === '阿哲').id;
  return { admin, owner, member, outsider, trip, path: `/api/trips/${trip.id}/ledger` };
}

const expense = (id, extra = {}) => ({ id, date: '2026-11-20', title: '超市採買', amountCents: 90000, payerId: '', participantIds: [], category: '食材', note: '', shoppingId: '', source: 'manual', receiptId: '', receiptLine: '', ...extra });
const settlement = (id, extra = {}) => ({ id, date: '2026-11-22', fromId: '', toId: '', amountCents: 45000, note: '', ...extra });
let seq = 0;
const getLedger = (w, who) => call('GET', w.path, { cookie: who.cookie });
async function putLedger(w, who, { expenses, settlements = [], revision, requestId = `req-${++seq}`, expectedUserId = who.user.id, extra = {} }) {
  if (revision === undefined) revision = ok(await getLedger(w, who)).ledger.revision;
  return call('PUT', w.path, { cookie: who.cookie, body: { expectedUserId, revision, requestId, expenses, settlements, ...extra } });
}
const firstLedger = w => ({ expenses: [expense('e1', { payerId: w.owner.personId, participantIds: [w.owner.personId, w.member.personId] })] });

describe('ledger read', () => {
  test('GET returns an empty schema-1 ledger with trip people and permissions, without writing', async () => {
    const w = await world();
    const env = ok(await getLedger(w, w.owner));
    const res = await getLedger(w, w.owner);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(env).toEqual({ ledger: { schema: 1, revision: 0, people: [{ id: w.owner.personId, name: '小安' }, { id: w.member.personId, name: '阿哲' }], expenses: [], settlements: [] }, permissions: { canEdit: true, canDelete: true } });
    expect(ok(await getLedger(w, w.member)).permissions).toEqual({ canEdit: true, canDelete: false });
    expect(ok(await getLedger(w, w.owner)).ledger.revision).toBe(0);
    const audit = ok(await call('GET', '/api/admin/audit', { cookie: w.admin.cookie })).events;
    expect(audit.some(e => e.action === 'trip.ledger')).toBe(false);
  });
  test('unauthenticated, outsiders and non-member admins cannot see the ledger', async () => {
    const w = await world();
    failed(await call('GET', w.path), 401);
    failed(await getLedger(w, w.outsider), 404);
    failed(await getLedger(w, w.admin), 404);
    failed(await call('GET', '/api/trips/no-such-trip/ledger', { cookie: w.owner.cookie }), 404);
    failed(await call('GET', '/api/trips/bad%20id/ledger', { cookie: w.owner.cookie }), 404);
    failed(await putLedger(w, w.outsider, { ...firstLedger(w), revision: 0 }), 404);
    failed(await putLedger(w, w.admin, { ...firstLedger(w), revision: 0 }), 404);
    expect(ok(await getLedger(w, w.owner)).ledger.revision).toBe(0);
  });
  test('mutations require the same origin and JSON', async () => {
    const w = await world();
    failed(await call('PUT', w.path, { cookie: w.owner.cookie, origin: 'http://evil.example', body: { expectedUserId: w.owner.user.id, revision: 0, requestId: 'x1', ...firstLedger(w), settlements: [] } }), 403);
    const res = await svc.handle(new Request(BASE + w.path, { method: 'PUT', headers: { cookie: w.owner.cookie, origin: BASE, 'content-type': 'text/plain' }, body: '{}' }));
    expect(res.status).toBe(415);
    const del = await call('DELETE', w.path, { cookie: w.owner.cookie });
    expect(del.status).toBe(405);
  });
});

describe('ledger write', () => {
  test('PUT stores money rows separately; trip state and revision are untouched', async () => {
    const w = await world();
    const before = await getTrip(w.owner, w.trip.id);
    const body = { ...firstLedger(w), settlements: [settlement('s1', { fromId: w.member.personId, toId: w.owner.personId })] };
    const env = ok(await putLedger(w, w.owner, body));
    expect(env.ledger.revision).toBe(1);
    expect(env.ledger.expenses).toEqual(body.expenses);
    expect(env.ledger.settlements).toEqual(body.settlements);
    expect(env.ledger.people.map(p => p.name)).toEqual(['小安', '阿哲']);
    const after = await getTrip(w.owner, w.trip.id);
    expect(after.trip.revision).toBe(before.trip.revision);
    expect(after.state).toEqual(before.state);
    expect(ok(await getLedger(w, w.member)).ledger).toEqual(env.ledger);
    const s = summarizeLedger(env.ledger);
    expect(s.balances.map(b => b.netCents)).toEqual([0, 0]);
    expect(s.totalCents).toBe(90000);
  });
  test('text is trimmed and the response is the normalized server copy', async () => {
    const w = await world();
    const env = ok(await putLedger(w, w.owner, { expenses: [expense('e1', { title: '  晚餐  ', note: '第一行\n第二行 ', payerId: w.owner.personId, participantIds: [w.owner.personId] })] }));
    expect(env.ledger.expenses[0].title).toBe('晚餐');
    expect(env.ledger.expenses[0].note).toBe('第一行\n第二行');
  });
  test('stale revision and stale or missing identity are rejected without writing', async () => {
    const w = await world();
    ok(await putLedger(w, w.owner, firstLedger(w)));
    failed(await putLedger(w, w.owner, { ...firstLedger(w), revision: 0 }), 409, /重新載入/);
    failed(await putLedger(w, w.owner, { ...firstLedger(w), expectedUserId: w.member.user.id }), 409, /其他分頁/);
    const missing = await call('PUT', w.path, { cookie: w.owner.cookie, body: { revision: 1, requestId: 'r-missing', ...firstLedger(w), settlements: [] } });
    failed(missing, 400, /expectedUserId/);
    failed(await putLedger(w, w.owner, { ...firstLedger(w), expectedUserId: 42 }), 400);
    expect(ok(await getLedger(w, w.owner)).ledger.revision).toBe(1);
  });
  test('identical retry with the same requestId is idempotent; reuse with a different body fails', async () => {
    const w = await world();
    const body = { expectedUserId: w.owner.user.id, revision: 0, requestId: 'req-retry-1', ...firstLedger(w), settlements: [] };
    const firstRes = await call('PUT', w.path, { cookie: w.owner.cookie, body });
    expect(firstRes.headers.get('cache-control')).toBe('no-store');
    const first = ok(firstRes);
    const reordered = { settlements: [], expenses: body.expenses.map(e => Object.fromEntries(Object.entries(e).reverse())), requestId: body.requestId, revision: 0, expectedUserId: body.expectedUserId };
    const retry = ok(await call('PUT', w.path, { cookie: w.owner.cookie, body: reordered }));
    expect(retry).toEqual(first);
    expect(retry.ledger.revision).toBe(1);
    const changed = structuredClone(body);
    changed.expenses[0].amountCents = 1;
    failed(await call('PUT', w.path, { cookie: w.owner.cookie, body: changed }), 409, /請求編號/);
    failed(await call('PUT', w.path, { cookie: w.owner.cookie, body: { ...changed, revision: 1 } }), 409, /請求編號/);
    failed(await call('PUT', w.path, { cookie: w.member.cookie, body: { ...body, expectedUserId: w.member.user.id } }), 409, /請求編號/);
    failed(await call('PUT', w.path, { cookie: w.member.cookie, body }), 409, /其他分頁/);
    failed(await call('PUT', w.path, { cookie: w.outsider.cookie, body: { ...body, expectedUserId: w.outsider.user.id } }), 404);
    failed(await call('PUT', w.path, { cookie: w.admin.cookie, body: { ...body, expectedUserId: w.admin.user.id } }), 404);
    const now = ok(await getLedger(w, w.owner)).ledger;
    expect(now.revision).toBe(1);
    expect(now.expenses[0].amountCents).toBe(90000);
    const next = ok(await putLedger(w, w.owner, { expenses: [], requestId: 'req-retry-2' }));
    expect(next.ledger.revision).toBe(2);
    const late = ok(await call('PUT', w.path, { cookie: w.owner.cookie, body }));
    expect(late.ledger.revision).toBe(2);
    expect(late.ledger.expenses).toEqual([]);
  });
  test('members add and edit any row but cannot remove rows; owners can', async () => {
    const w = await world();
    const { owner, member } = w;
    const e1 = expense('e1', { payerId: owner.personId, participantIds: [owner.personId, member.personId] });
    const s1 = settlement('s1', { fromId: member.personId, toId: owner.personId });
    ok(await putLedger(w, owner, { expenses: [e1], settlements: [s1] }));
    const e2 = expense('e2', { title: '油錢', category: '交通', amountCents: 120000, payerId: member.personId, participantIds: [owner.personId, member.personId] });
    const edited = ok(await putLedger(w, member, { expenses: [{ ...e1, amountCents: 80000 }, e2], settlements: [{ ...s1, amountCents: 40000 }] }));
    expect(edited.ledger.expenses.map(e => e.amountCents)).toEqual([80000, 120000]);
    failed(await putLedger(w, member, { expenses: [e2], settlements: [{ ...s1, amountCents: 40000 }] }), 403, /不能刪除/);
    failed(await putLedger(w, member, { expenses: [{ ...e1, amountCents: 80000 }, e2], settlements: [] }), 403, /不能刪除/);
    const s1Edited = { ...s1, amountCents: 40000 }, e1Edited = { ...e1, amountCents: 80000 };
    failed(await putLedger(w, member, { expenses: [e2], settlements: [s1Edited, settlement('e1', { fromId: member.personId, toId: owner.personId })] }), 403, /不能刪除/);
    failed(await putLedger(w, member, { expenses: [e1Edited, e2, expense('s1', { payerId: member.personId, participantIds: [member.personId] })], settlements: [] }), 403, /不能刪除/);
    expect(ok(await getLedger(w, member)).ledger.revision).toBe(edited.ledger.revision);
    const removed = ok(await putLedger(w, owner, { expenses: [e2], settlements: [] }));
    expect(removed.ledger.expenses.map(e => e.id)).toEqual(['e2']);
    expect(removed.ledger.settlements).toEqual([]);
  });
  test('backend rejects bad rows with Chinese messages and stores nothing', async () => {
    const w = await world();
    const p1 = w.owner.personId, p2 = w.member.personId;
    const good = expense('e1', { payerId: p1, participantIds: [p1, p2] });
    const goodS = settlement('s1', { fromId: p2, toId: p1 });
    const badExpenses = [
      { amountCents: 0 }, { amountCents: -100 }, { amountCents: 1.5 }, { amountCents: '100' }, { amountCents: 100000001 }, { amountCents: Number.MAX_SAFE_INTEGER + 1 },
      { date: '2026-02-30' }, { date: '2026-1-01' }, { date: '2026-11-20T00:00:00Z' }, { date: '' }, { date: 20261120 },
      { id: '' }, { id: 'x'.repeat(65) }, { id: 'bad id' }, { id: 'é' }, { id: 7 },
      { title: '' }, { title: '   ' }, { title: 'x'.repeat(101) }, { title: 'a\u202Eb' }, { title: null }, { note: 'x'.repeat(501) }, { note: 'a\u0000b' },
      { payerId: 'nobody' }, { payerId: '' }, { participantIds: [] }, { participantIds: [p1, p1] }, { participantIds: ['nobody'] }, { participantIds: p1 },
      { participantIds: Array.from({ length: 101 }, (_, i) => `x${i}`) },
      { category: '娛樂' }, { category: '' }, { source: 'ocr' }, { source: 'manual', receiptId: FP, receiptLine: '1' }, { receiptLine: '1' },
      { source: 'receipt', receiptId: '', receiptLine: '1' }, { source: 'receipt', receiptId: FP.toUpperCase(), receiptLine: '1' }, { source: 'receipt', receiptId: 'ab', receiptLine: '1' },
      { source: 'receipt', receiptId: FP, receiptLine: '' }, { source: 'receipt', receiptId: FP, receiptLine: 'line 1' }, { source: 'receipt', receiptId: FP, receiptLine: 3 },
      { shoppingId: 'missing-item' }, { shoppingId: 'bad id' }, { shoppingId: null }
    ];
    for (const patch of badExpenses) failed(await putLedger(w, w.owner, { expenses: [{ ...good, ...patch }], revision: 0 }), 400, /第 1 筆支出/);
    const { title, ...noTitle } = good;
    failed(await putLedger(w, w.owner, { expenses: [noTitle], revision: 0 }), 400, /欄位/);
    failed(await putLedger(w, w.owner, { expenses: [{ ...good, payerName: '小安' }], revision: 0 }), 400, /欄位/);
    failed(await putLedger(w, w.owner, { expenses: ['e1'], revision: 0 }), 400);
    failed(await putLedger(w, w.owner, { expenses: [good, { ...good }], revision: 0 }), 400, /重複/);
    for (const patch of [{ fromId: p1, toId: p1 }, { toId: 'nobody' }, { amountCents: 0 }, { date: '2026-13-01' }, { note: 'x'.repeat(501) }, { id: 'a_b' }])
      failed(await putLedger(w, w.owner, { expenses: [], settlements: [{ ...goodS, ...patch }], revision: 0 }), 400, /第 1 筆還款/);
    failed(await putLedger(w, w.owner, { expenses: [], settlements: [{ ...goodS, extra: 1 }], revision: 0 }), 400, /欄位/);
    failed(await putLedger(w, w.owner, { expenses: [], settlements: [goodS, goodS], revision: 0 }), 400, /重複/);
    failed(await putLedger(w, w.owner, { expenses: [good], revision: 0, extra: { people: [{ id: p1, name: '偽造' }] } }), 400, /不支援/);
    failed(await putLedger(w, w.owner, { expenses: [good], revision: 0, extra: { schema: 1 } }), 400, /不支援/);
    failed(await putLedger(w, w.owner, { expenses: [good], revision: 0, requestId: 'bad id' }), 400, /requestId/);
    failed(await putLedger(w, w.owner, { expenses: [good], revision: -1 }), 400, /revision/);
    failed(await putLedger(w, w.owner, { expenses: { 0: good }, revision: 0 }), 400);
    expect(ok(await getLedger(w, w.owner)).ledger.revision).toBe(0);
  });
  test('hostile nesting is rejected as 400 before hashing, never a stack overflow', async () => {
    const w = await world();
    const deep = n => '['.repeat(n) + ']'.repeat(n);
    const raw = (expenses, settlements = '[]') => `{"expectedUserId":${JSON.stringify(w.owner.user.id)},"revision":0,"requestId":"deep-1","expenses":${expenses},"settlements":${settlements}}`;
    const put = body => send(new Request(BASE + w.path, { method: 'PUT', headers: { cookie: w.owner.cookie, origin: BASE, 'content-type': 'application/json' }, body }));
    failed(await put(raw(`[${deep(200000)}]`)), 400, /第 1 筆支出/);
    failed(await put(raw('[]', `[${deep(200000)}]`)), 400, /第 1 筆還款/);
    const good = expense('e1', { payerId: w.owner.personId, participantIds: [w.owner.personId] });
    failed(await put(raw(JSON.stringify([{ ...good, title: { x: deep(1000) } }]))), 400, /第 1 筆支出/);
    failed(await put(raw(`[${JSON.stringify({ ...good, participantIds: 'X' }).replace('"X"', `[${deep(200000)}]`)}]`)), 400, /第 1 筆支出/);
    failed(await put(raw(JSON.stringify([good]), `[{"id":"s1","note":${deep(50000)}}]`)), 400, /第 1 筆還款/);
    failed(await put(raw(JSON.stringify([{ ...good, note: [] }]))), 400, /第 1 筆支出/);
    expect(ok(await getLedger(w, w.owner)).ledger.revision).toBe(0);
    ok(await putLedger(w, w.owner, { expenses: [good], revision: 0 }));
  });
  test('boundary values are accepted: max amount, 1 cent, early purchase dates, 100 participants', async () => {
    const w = await world();
    const p1 = w.owner.personId;
    ok(await putState(w.owner, w.trip.id, s => { for (let i = 0; i < 98; i++) s.people.push({ id: `guest-${i}`, name: `旅伴${i}`, color: 'green', role: '' }); }));
    const everyone = (await getTrip(w.owner, w.trip.id)).state.people.map(p => p.id);
    expect(everyone).toHaveLength(100);
    const env = ok(await putLedger(w, w.owner, { expenses: [
      expense('e0', { payerId: p1, participantIds: everyone, amountCents: 100001 }),
      expense('e1', { amountCents: 100000000, payerId: p1, participantIds: [p1], date: '2026-10-01', title: 'x'.repeat(100), note: 'y'.repeat(500) }),
      expense('e2', { amountCents: 1, payerId: p1, participantIds: [p1, w.member.personId], date: '2024-02-29', category: '住宿' })
    ] }));
    expect(env.ledger.expenses).toHaveLength(3);
    expect(summarizeLedger(env.ledger).balances.reduce((n, b) => n + b.shareCents, 0)).toBe(100001 + 100000000 + 1);
  });
  test('receipt rows need a fingerprint and unique line per file', async () => {
    const w = await world();
    const p1 = w.owner.personId;
    const r = (id, line, fp = FP) => expense(id, { payerId: p1, participantIds: [p1], source: 'receipt', receiptId: fp, receiptLine: line });
    const env = ok(await putLedger(w, w.owner, { expenses: [r('e1', '1'), r('e2', '2'), r('e3', '1', 'b'.repeat(64))] }));
    expect(env.ledger.expenses.map(e => [e.receiptId.slice(0, 1), e.receiptLine])).toEqual([['a', '1'], ['a', '2'], ['b', '1']]);
    failed(await putLedger(w, w.owner, { expenses: [...env.ledger.expenses, r('e4', '2')] }), 409, /重複/);
    expect(ok(await getLedger(w, w.owner)).ledger.expenses).toHaveLength(3);
  });
  test('row limits are 1000 expenses and 1000 settlements', async () => {
    const w = await world();
    const p1 = w.owner.personId, p2 = w.member.personId;
    const many = n => Array.from({ length: n }, (_, i) => expense(`e${i}`, { payerId: p1, participantIds: [p1], amountCents: 100 }));
    const manyS = n => Array.from({ length: n }, (_, i) => settlement(`s${i}`, { fromId: p2, toId: p1, amountCents: 100 }));
    failed(await putLedger(w, w.owner, { expenses: many(1001), revision: 0 }), 400, /1000/);
    failed(await putLedger(w, w.owner, { expenses: [], settlements: manyS(1001), revision: 0 }), 400, /1000/);
    const env = ok(await putLedger(w, w.owner, { expenses: many(1000), settlements: manyS(1000), revision: 0 }));
    expect([env.ledger.expenses.length, env.ledger.settlements.length]).toEqual([1000, 1000]);
  });
  test('shopping links validate only when new or changed and never mark items bought', async () => {
    const w = await world();
    const p1 = w.owner.personId;
    ok(await putState(w.owner, w.trip.id, s => { s.shopping.push({ id: 'shop-1', name: '木炭', quantity: '1 包', category: '其他', assignee: '', done: false, source: 'manual' }); }));
    const linked = expense('e1', { payerId: p1, participantIds: [p1], shoppingId: 'shop-1' });
    ok(await putLedger(w, w.owner, { expenses: [linked] }));
    expect((await getTrip(w.owner, w.trip.id)).state.shopping.find(s => s.id === 'shop-1').done).toBe(false);
    ok(await putState(w.owner, w.trip.id, s => { s.shopping = s.shopping.filter(x => x.id !== 'shop-1'); }));
    const kept = ok(await putLedger(w, w.member, { expenses: [{ ...linked, title: '木炭與火種' }] }));
    expect(kept.ledger.expenses[0].shoppingId).toBe('shop-1');
    failed(await putLedger(w, w.owner, { expenses: [kept.ledger.expenses[0], expense('e2', { payerId: p1, participantIds: [p1], shoppingId: 'shop-1' })] }), 400, /第 2 筆支出.*採買/);
    ok(await putLedger(w, w.owner, { expenses: [{ ...linked, shoppingId: '' }] }));
  });
});

describe('ledger isolation and lifecycle', () => {
  test('old whole-state PUT with stray money fields cannot change the ledger', async () => {
    const w = await world();
    const saved = ok(await putLedger(w, w.owner, firstLedger(w))).ledger;
    const hostile = { expenses: [], settlements: [], ledger: { revision: 9, expenses: [] } };
    ok(await putState(w.owner, w.trip.id, s => { Object.assign(s, hostile); s.trip.note = '舊版用戶端存檔'; }, hostile));
    ok(await putState(w.member, w.trip.id, s => { s.trip.description = '另一個舊分頁'; }));
    const trip = await getTrip(w.owner, w.trip.id);
    expect(trip.state.trip.note).toBe('舊版用戶端存檔');
    expect(trip.state.expenses).toBeUndefined();
    expect(trip.state.ledger).toBeUndefined();
    expect(ok(await getLedger(w, w.owner)).ledger).toEqual(saved);
  });
  test('deleting the trip hides the ledger for everyone', async () => {
    const w = await world();
    ok(await putLedger(w, w.owner, firstLedger(w)));
    const trip = await getTrip(w.owner, w.trip.id);
    ok(await call('POST', `/api/trips/${w.trip.id}/delete`, { cookie: w.owner.cookie, body: { expectedUserId: w.owner.user.id, confirmTitle: card.title, revision: trip.trip.revision } }));
    for (const who of [w.owner, w.member, w.admin]) {
      failed(await getLedger(w, who), 404);
      failed(await putLedger(w, who, { expenses: [], revision: 1 }), 404);
    }
  });
  test('deleting a member account keeps their debt and name snapshot, never reassigning it', async () => {
    const w = await world();
    const { owner, member } = w;
    const e1 = expense('e1', { payerId: owner.personId, participantIds: [owner.personId, member.personId] });
    const e2 = expense('e2', { amountCents: 30000, payerId: member.personId, participantIds: [member.personId, owner.personId] });
    const before = ok(await putLedger(w, owner, { expenses: [e1, e2] })).ledger;
    const summaryBefore = summarizeLedger(before);
    ok(await call('POST', `/api/admin/users/${member.user.id}/delete`, { cookie: w.admin.cookie, body: { confirmUsername: 'member-b' } }));
    const trip = await getTrip(owner, w.trip.id);
    expect(trip.state.people.some(p => p.id === member.personId)).toBe(false);
    const after = ok(await getLedger(w, owner)).ledger;
    expect(after.revision).toBe(before.revision);
    expect(after.expenses).toEqual(before.expenses);
    expect(after.people).toContainEqual({ id: member.personId, name: '阿哲' });
    expect(summarizeLedger(after).balances.find(b => b.personId === member.personId)).toEqual(summaryBefore.balances.find(b => b.personId === member.personId));
    const edited = ok(await putLedger(w, owner, { expenses: [{ ...e1, title: '修改標題' }, e2] }));
    expect(edited.ledger.people).toContainEqual({ id: member.personId, name: '阿哲' });
    failed(await putLedger(w, owner, { expenses: [e1, e2, expense('e3', { payerId: member.personId, participantIds: [owner.personId] })] }), 400, /第 3 筆支出.*目前的旅伴/);
    failed(await putLedger(w, owner, { expenses: [{ ...e1, payerId: member.personId }, e2] }), 400, /第 1 筆支出.*付款人.*目前的旅伴/);
    failed(await putLedger(w, owner, { expenses: [e1, e2], settlements: [settlement('s1', { fromId: 'never-here', toId: owner.personId })] }), 400, /第 1 筆還款.*目前的旅伴/);
    const repay = settlement('s1', { fromId: member.personId, toId: owner.personId, amountCents: 30000 });
    const settled = ok(await putLedger(w, owner, { expenses: [e1, e2], settlements: [repay] })).ledger;
    expect(summarizeLedger(settled).balances.find(b => b.personId === member.personId).netCents).toBe(0);
    expect(ok(await putLedger(w, owner, { expenses: [e1, e2], settlements: [{ ...repay, note: '現金' }] })).ledger.settlements[0].note).toBe('現金');
    const reassigned = ok(await putLedger(w, owner, { expenses: [e1, { ...e2, payerId: owner.personId }], settlements: [repay] })).ledger;
    expect(reassigned.people).toContainEqual({ id: member.personId, name: '阿哲' });
    const cleared = ok(await putLedger(w, owner, { expenses: [], settlements: [] })).ledger;
    expect(cleared.people.map(p => p.id)).toEqual([owner.personId]);
    failed(await putLedger(w, owner, { expenses: [], settlements: [repay] }), 400, /第 1 筆還款.*目前的旅伴/);
  });
  test('removing an unbound participant in the trip keeps the name they had in the ledger', async () => {
    const w = await world();
    const { owner } = w;
    ok(await putState(owner, w.trip.id, s => { s.people.push({ id: 'guest-1', name: '朋友小美', color: 'green', role: '' }); }));
    const before = ok(await putLedger(w, owner, { expenses: [expense('e1', { payerId: owner.personId, participantIds: [owner.personId, 'guest-1'] })] })).ledger;
    ok(await putState(owner, w.trip.id, s => { s.people.find(p => p.id === 'guest-1').name = '小美'; }));
    expect(ok(await getLedger(w, owner)).ledger.people).toContainEqual({ id: 'guest-1', name: '小美' });
    ok(await putState(owner, w.trip.id, s => { s.people = s.people.filter(p => p.id !== 'guest-1'); }));
    const after = ok(await getLedger(w, owner)).ledger;
    expect(after.revision).toBe(before.revision);
    expect(after.expenses).toEqual(before.expenses);
    expect(after.people.at(-1)).toEqual({ id: 'guest-1', name: '小美' });
  });
});

describe('re-authentication after slow bodies', () => {
  function slowBody(json) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const bytes = new TextEncoder().encode(json);
    const stream = new ReadableStream({
      async pull(controller) { await gate; controller.enqueue(bytes); controller.close(); }
    });
    return { stream, release };
  }
  const bodyFor = (w, who, revision = 0) => JSON.stringify({ expectedUserId: who.user.id, revision, requestId: `slow-${++seq}`, ...firstLedger(w), settlements: [] });

  test('logout while the body is still uploading rejects the write', async () => {
    const w = await world();
    const { stream, release } = slowBody(bodyFor(w, w.owner));
    const pending = send(request('PUT', w.path, { cookie: w.owner.cookie, stream }));
    ok(await call('POST', '/api/logout', { cookie: w.owner.cookie }));
    release();
    failed(await pending, 401);
    const fresh = await svc.handle(request('POST', '/api/login', { body: { username: 'owner-a', password: PASS } }));
    expect(ok(await getLedger(w, { cookie: fresh.headers.get('set-cookie').split(';')[0] })).ledger.revision).toBe(0);
  });
  test('account deletion during upload rejects the write and ledger stays unchanged', async () => {
    const w = await world();
    const { stream, release } = slowBody(bodyFor(w, w.member));
    const pending = send(request('PUT', w.path, { cookie: w.member.cookie, stream }));
    ok(await call('POST', `/api/admin/users/${w.member.user.id}/delete`, { cookie: w.admin.cookie, body: { confirmUsername: 'member-b' } }));
    release();
    failed(await pending, 401);
    expect(ok(await getLedger(w, w.owner)).ledger.revision).toBe(0);
  });
  test('a concurrent ledger save during upload makes the slow write stale', async () => {
    const w = await world();
    const { stream, release } = slowBody(bodyFor(w, w.member));
    const pending = send(request('PUT', w.path, { cookie: w.member.cookie, stream }));
    ok(await putLedger(w, w.owner, { expenses: [], revision: 0 }));
    release();
    failed(await pending, 409, /重新載入/);
  });
  test('trip deletion during upload rejects the write', async () => {
    const w = await world();
    const { stream, release } = slowBody(bodyFor(w, w.owner));
    const pending = send(request('PUT', w.path, { cookie: w.owner.cookie, stream }));
    const trip = await getTrip(w.owner, w.trip.id);
    ok(await call('POST', `/api/trips/${w.trip.id}/delete`, { cookie: w.owner.cookie, body: { expectedUserId: w.owner.user.id, confirmTitle: card.title, revision: trip.trip.revision } }));
    release();
    failed(await pending, 404);
  });
});

describe('database upgrade', () => {
  const tables = ['users', 'trips', 'trip_members', 'sessions', 'invites', 'trip_deletions', 'audit'];
  const readAll = db => Object.fromEntries(tables.map(t => [t, db.query(`SELECT * FROM ${t}`).all()]));
  test('an existing database gains an empty trip_ledgers table without rewriting rows; GET writes nothing; corrupt rows are never overwritten', async () => {
    const root = join(homedir(), '.aki', 'tmp'); mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, 'camping-ledger-upgrade-')), path = join(dir, 'fixture.sqlite');
    let service, db;
    try {
      service = createAccountService({ dbPath: path, now: () => clockMs });
      const post = (url, body, cookie) => service.handle(request('POST', url, { body, cookie }));
      const setup = await post('/api/setup', { username: 'upgrade-admin', displayName: 'Upgrade', password: PASS });
      const cookie = setup.headers.get('set-cookie').split(';')[0];
      const trip = (await (await post('/api/trips', card, cookie)).json()).trip;
      service.close(); service = null;
      db = new Database(path); db.exec('DROP TABLE trip_ledgers'); const before = readAll(db); db.close(); db = null;

      service = createAccountService({ dbPath: path, now: () => clockMs });
      const got = await send(request('GET', `/api/trips/${trip.id}/ledger`, { cookie }), service);
      expect(got.status).toBe(200);
      expect(got.body.ledger.revision).toBe(0);
      service.close(); service = null;

      db = new Database(path, { readonly: true });
      expect(db.query("SELECT sql FROM sqlite_master WHERE name = 'trip_ledgers'").get().sql).toContain('trip_id TEXT PRIMARY KEY');
      expect(db.query('SELECT COUNT(*) AS n FROM trip_ledgers').get().n).toBe(0);
      expect(readAll(db)).toEqual(before);
      expect(db.query('PRAGMA integrity_check').get().integrity_check).toBe('ok');
      db.close(); db = null;

      db = new Database(path);
      db.query('INSERT INTO trip_ledgers (trip_id, revision, ledger_json, requests_json, updated_by, updated_at) VALUES (?, 3, ?, ?, ?, 0)').run(trip.id, '{broken', '[]', trip.ownerId);
      db.close(); db = null;
      service = createAccountService({ dbPath: path, now: () => clockMs });
      failed(await send(request('GET', `/api/trips/${trip.id}/ledger`, { cookie }), service), 500, /無法讀取/);
      const put = await send(request('PUT', `/api/trips/${trip.id}/ledger`, { cookie, body: { expectedUserId: trip.ownerId, revision: 3, requestId: 'corrupt-1', expenses: [], settlements: [] } }), service);
      failed(put, 500, /無法讀取/);
      service.close(); service = null;
      db = new Database(path, { readonly: true });
      expect(db.query('SELECT ledger_json FROM trip_ledgers').get().ledger_json).toBe('{broken');
      db.close(); db = null;

      const valid = { people: [{ id: 'p-a', name: 'A' }, { id: 'p-b', name: 'B' }], expenses: [expense('e1', { payerId: 'p-a', participantIds: ['p-a', 'p-b'] })], settlements: [settlement('s1', { fromId: 'p-b', toId: 'p-a' })] };
      const damaged = [
        d => { d.expenses[0].amountCents = -5; }, d => { d.expenses[0].amountCents = 1.5; }, d => { d.expenses[0].amountCents = '900'; },
        d => { d.expenses[0].participantIds = []; }, d => { d.expenses[0].participantIds = ['p-a', 'p-a']; }, d => { d.expenses[0].participantIds = 'p-a'; },
        d => { delete d.expenses[0].payerId; }, d => { d.expenses[0].date = '2026-02-30'; }, d => { d.expenses[0].source = 'receipt'; },
        d => { d.expenses.push({ ...d.expenses[0] }); }, d => { d.settlements[0].amountCents = 0; }, d => { d.settlements[0].toId = 'p-b'; },
        d => { d.people[0] = { id: 'p-a' }; }, d => { d.extra = 1; }
      ];
      for (const mutate of damaged) {
        const data = structuredClone(valid); mutate(data);
        const raw = JSON.stringify(data);
        db = new Database(path); db.query('UPDATE trip_ledgers SET ledger_json = ?').run(raw); db.close(); db = null;
        service = createAccountService({ dbPath: path, now: () => clockMs });
        failed(await send(request('GET', `/api/trips/${trip.id}/ledger`, { cookie }), service), 500, /無法讀取/);
        failed(await send(request('PUT', `/api/trips/${trip.id}/ledger`, { cookie, body: { expectedUserId: trip.ownerId, revision: 3, requestId: `corrupt-${++seq}`, expenses: [], settlements: [] } }), service), 500, /無法讀取/);
        service.close(); service = null;
        db = new Database(path, { readonly: true });
        expect(db.query('SELECT revision, ledger_json FROM trip_ledgers').get()).toEqual({ revision: 3, ledger_json: raw });
        db.close(); db = null;
      }
      db = new Database(path); db.query('UPDATE trip_ledgers SET ledger_json = ?').run(JSON.stringify(valid)); db.close(); db = null;
      const goodRequest = { id: 'r-1', userId: trip.ownerId, hash: 'c'.repeat(64) };
      for (const requests of ['{broken', 'null', '{}', '[null]', '[1]', JSON.stringify([{ id: 'r-1' }]), JSON.stringify([{ ...goodRequest, hash: 'x' }]), JSON.stringify([{ ...goodRequest, id: [] }]), JSON.stringify([{ ...goodRequest, extra: 1 }]), JSON.stringify(Array.from({ length: 201 }, (_, i) => ({ ...goodRequest, id: `r-${i}` })))]) {
        db = new Database(path); db.query('UPDATE trip_ledgers SET requests_json = ?').run(requests); db.close(); db = null;
        service = createAccountService({ dbPath: path, now: () => clockMs });
        failed(await send(request('GET', `/api/trips/${trip.id}/ledger`, { cookie }), service), 500, /無法讀取/);
        failed(await send(request('PUT', `/api/trips/${trip.id}/ledger`, { cookie, body: { expectedUserId: trip.ownerId, revision: 3, requestId: 'r-1', expenses: [], settlements: [] } }), service), 500, /無法讀取/);
        service.close(); service = null;
        db = new Database(path, { readonly: true });
        expect(db.query('SELECT revision, ledger_json, requests_json FROM trip_ledgers').get()).toEqual({ revision: 3, ledger_json: JSON.stringify(valid), requests_json: requests });
        db.close(); db = null;
      }
      db = new Database(path); db.query('UPDATE trip_ledgers SET requests_json = ?').run(JSON.stringify([goodRequest])); db.close(); db = null;
      service = createAccountService({ dbPath: path, now: () => clockMs });
      expect(ok(await send(request('GET', `/api/trips/${trip.id}/ledger`, { cookie }), service)).ledger.expenses).toHaveLength(1);
      service.close(); service = null;
    } finally {
      service?.close(); db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(existsSync(dir)).toBe(false);
  }, 20000);
});
