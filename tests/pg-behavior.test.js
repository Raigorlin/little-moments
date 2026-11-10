// Property 24（Requirement 11.2）：使用者可控制的文字含 SQL 語法字元時，經 API 寫入 PostgreSQL 後原文往返，
// 且查詢語意不受影響（沒有多出或消失的資料列、其他使用者的資料不變）。
// 透過真實的 createAccountService 與 tests/support/pg.js 的隔離 schema 執行；需要 CAMPING_TEST_DATABASE_*。
import { test, expect, beforeAll, afterAll } from 'bun:test';
import fc from 'fast-check';
import { useTestDatabase, serviceDb } from './support/pg.js';
import { createAccountService } from '../server/accounts.js';
import { addParticipant } from '../src/model.js';
import { EXPENSE_CATEGORIES } from '../src/expense-categories.js';

const BASE = 'http://127.0.0.1:5182';
const PASS = 'correct horse battery';
const db = useTestDatabase();
let svc, admin, adminCookie, member, memberCookie, sentinel;
let clockMs = Date.parse('2026-11-04T00:00:00Z');

async function call(method, path, { body, cookie } = {}) {
  const headers = { origin: BASE };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await svc.handle(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), { ip: '127.0.0.1', tcpIp: '127.0.0.1' });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const ok = (res, status) => { if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`); return res.body; };
const count = async table => Number((await db.sql`SELECT COUNT(*) AS n FROM ${db.sql(table)}`)[0].n);

// 使用者只建立一次（scrypt 成本），所有 fast-check 執行共用 Session。
beforeAll(async () => {
  svc = await createAccountService({ db: serviceDb(db.sql), now: () => clockMs });
  admin = ok(await call('POST', '/api/setup', { body: { username: 'admin-one', displayName: '管理員', password: PASS } }), 200).user;
  adminCookie = (await call('POST', '/api/login', { body: { username: 'admin-one', password: PASS } })).cookie;
  const reg = await call('POST', '/api/register', { body: { username: 'member-one', displayName: '旅伴', password: PASS } });
  member = ok(reg, 200).user;
  memberCookie = reg.cookie;
  // 另一位使用者的行程：每次執行後都必須完全不變。
  const created = ok(await call('POST', '/api/trips', { cookie: memberCookie, body: { title: '旅伴的行程', destination: '山上', startDate: '2026-12-01', endDate: '2026-12-02', description: 'd', note: 'n', coverKind: 'camp', status: 'planning', expectedUserId: member.id } }), 201).trip;
  sentinel = ok(await call('GET', `/api/trips/${created.id}`, { cookie: memberCookie }), 200);
}, 60_000);
afterAll(() => svc?.close());

// SQL 語法片段、非 ASCII 與 emoji；全部為 NFC/NFKC 穩定且不含控制字元。
const SQL_FRAGMENTS = ["'", "''", '"', ';', '--', '/*', '*/', '\\', '\\\\', '$1', '$$', '%', '_', '?', ':name', "' OR '1'='1", "'); DROP TABLE trips; --", 'E\'\\x00\'', 'NULL', '露營', '日子拾光', 'café', '🏕️', '🔥', 'a', 'Z', '0', ' '];
const fragment = fc.oneof({ weight: 4, arbitrary: fc.constantFrom(...SQL_FRAGMENTS) }, { weight: 1, arbitrary: fc.string({ unit: 'grapheme', maxLength: 3 }) });
const clip = (s, max) => [...s].slice(0, max).join('');
const textOf = (max, maxParts) => fc.array(fragment, { maxLength: maxParts }).map(parts => clip(parts.join(''), max));

// 行程欄位：伺服器只做 trim 與長度檢查（CARD_LIMITS），因此產生已 trim、不含 NUL 的字串（PostgreSQL TEXT 不接受 NUL）。
const tripText = (max, maxParts, required = false) => textOf(max, maxParts).filter(s => s === s.trim() && !s.includes('\u0000') && (!required || s.length > 0));
// 帳本文字：伺服器做 NFC + trim，並拒絕 Cc/Cf（備註可含換行與 tab）。
const ledgerText = (max, maxParts, { required = false, multiline = false } = {}) => textOf(max, maxParts).filter(s => {
  if (s !== s.normalize('NFC').trim() || (required && !s)) return false;
  return !/[\p{Cc}\p{Cf}]/u.test(multiline ? s.replace(/\r?\n|\t/g, '') : s);
});
// 顯示名稱：伺服器做 NFKC、trim、合併空白並拒絕控制字元（最多 30 字）；只取正規化後不變的輸入。
const displayName = textOf(30, 12).filter(s => {
  try { return addParticipant({ people: [] }, s).person.name === s; } catch { return false; }
});

const inputArb = fc.record({
  title: tripText(100, 40, true),
  destination: tripText(100, 40),
  description: tripText(1000, 400),
  note: tripText(1000, 400),
  expenseTitle: ledgerText(100, 40, { required: true }),
  expenseNote: ledgerText(500, 200, { multiline: true }),
  displayName,
});

const pickCard = t => ({ title: t.title, destination: t.destination, description: t.description, note: t.note });

// Feature: jenkins-cicd-deploy, Property 24: SQL 特殊字元原文往返
test('Property 24: text with SQL syntax round-trips verbatim and does not change query semantics', async () => {
  let created = 0;
  await fc.assert(fc.asyncProperty(inputArb, async input => {
    clockMs += 1000;
    const card = pickCard(input);
    const trip = ok(await call('POST', '/api/trips', { cookie: adminCookie, body: { ...card, startDate: '2026-11-20', endDate: '2026-11-22', coverKind: 'lake', status: 'planning', expectedUserId: admin.id } }), 201).trip;
    created++;
    expect(pickCard(trip)).toEqual(card);

    // API 讀回、手冊內容與資料列皆與原文逐字相同。
    const env = ok(await call('GET', `/api/trips/${trip.id}`, { cookie: adminCookie }), 200);
    expect(pickCard(env.trip)).toEqual(card);
    expect(pickCard(env.state.trip)).toEqual(card);
    const [row] = await db.sql`SELECT title, destination, description, note FROM trips WHERE id = ${trip.id}`;
    expect({ ...row }).toEqual(card);

    // 帳本支出標題與備註。
    const me = env.permissions.personId;
    const expense = { id: 'e1', date: '2026-11-20', title: input.expenseTitle, amountCents: 1234, payerId: me, participantIds: [me], category: EXPENSE_CATEGORIES[0], note: input.expenseNote, shoppingId: '', source: 'manual', receiptId: '', receiptLine: '' };
    ok(await call('PUT', `/api/trips/${trip.id}/ledger`, { cookie: adminCookie, body: { expectedUserId: admin.id, revision: 0, requestId: `req-${created}`, expenses: [expense], settlements: [] } }), 200);
    const ledger = ok(await call('GET', `/api/trips/${trip.id}/ledger`, { cookie: adminCookie }), 200).ledger;
    expect(ledger.expenses).toEqual([expense]);

    // 顯示名稱（管理員修改另一位使用者）。
    const patched = ok(await call('PATCH', `/api/admin/users/${member.id}`, { cookie: adminCookie, body: { displayName: input.displayName } }), 200).user;
    expect(patched.displayName).toBe(input.displayName);
    const [userRow] = await db.sql`SELECT display_name FROM users WHERE id = ${member.id}`;
    expect(userRow.display_name).toBe(input.displayName);

    // 查詢語意不受影響：資料列數恰如預期，清單只含各自的行程，其他使用者的行程不變。
    expect(await count('users')).toBe(2);
    expect(await count('trips')).toBe(created + 1);
    expect(await count('trip_ledgers')).toBe(created);
    const users = ok(await call('GET', '/api/admin/users', { cookie: adminCookie }), 200).users;
    expect(users.map(u => [u.username, u.displayName, u.tripCount])).toEqual([['admin-one', '管理員', created], ['member-one', input.displayName, 1]]);
    const adminTrips = ok(await call('GET', '/api/trips', { cookie: adminCookie }), 200).trips;
    expect(adminTrips.filter(t => t.isMember).length).toBe(created);
    expect(adminTrips.find(t => t.id === trip.id).title).toBe(input.title);
    const memberTrips = ok(await call('GET', '/api/trips', { cookie: memberCookie }), 200).trips;
    expect(memberTrips.filter(t => t.isMember).map(t => t.id)).toEqual([sentinel.trip.id]);
    const other = ok(await call('GET', `/api/trips/${sentinel.trip.id}`, { cookie: memberCookie }), 200);
    // ownerName 由 JOIN users 取得，應反映剛修改的顯示名稱；其餘欄位不變。
    expect(other.trip).toEqual({ ...sentinel.trip, ownerName: input.displayName });
    expect(other.state).toEqual(sentinel.state);
  }), { numRuns: 100 });
}, 600_000);

// NUL 不在 Property 24 的範圍內（PostgreSQL TEXT 無法儲存）；確認被拒絕且不留下任何資料列。
test('NUL in trip text is rejected without writing rows', async () => {
  const before = await count('trips');
  const res = await call('POST', '/api/trips', { cookie: adminCookie, body: { title: 'a\u0000b', startDate: '2026-11-20', endDate: '2026-11-22', expectedUserId: admin.id } });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(await count('trips')).toBe(before);
});
