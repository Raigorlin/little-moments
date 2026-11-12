// 任務 5.12 的端對端冒煙測試：createAccountService 以 Bun.SQL 連到 Ephemeral_Database 的隔離 schema，
// 走過 setup → login → 建立行程 → 更新行程 → 帳本更新 → 登出（Requirement 11.1、11.2、11.3、11.7）。
// 需要 CAMPING_TEST_DATABASE_*（見 tests/support/pg.js）；完整的既有測試移植由任務 5.13 負責。
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { useTestDatabase } from './support/pg.js';
import { createAccountService } from '../server/accounts.js';
import { pingSql } from '../server/db/connect.js';
import { EXPENSE_CATEGORIES } from '../src/expense-categories.js';

const BASE = 'http://127.0.0.1:5181';
const PASS = 'correct horse battery';
const db = useTestDatabase();
let svc, clockMs = Date.parse('2026-11-04T00:00:00Z');

beforeAll(async () => {
  // 測試以 schema 隔離的連線池包裝成 createDatabase 的形狀；連線池由 useTestDatabase 關閉。
  svc = await createAccountService({ db: { sql: db.sql, ping: ms => pingSql(db.sql, ms), close: async () => {} }, now: () => clockMs });
});
afterAll(() => svc?.close());

async function call(method, path, { body, cookie } = {}) {
  const headers = { origin: BASE };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await svc.handle(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), { ip: '127.0.0.1', tcpIp: '127.0.0.1' });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const expectStatus = (res, status) => { if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`); return res; };
const auditCount = async () => Number((await db.sql`SELECT COUNT(*) AS n FROM audit`)[0].n);

test('service needs a Bun.SQL pool', async () => {
  await expect(createAccountService({})).rejects.toThrow(TypeError);
  expect(await svc.ping()).toBe(true);
});

test('setup → login → trip → ledger → logout end-to-end on PostgreSQL', async () => {
  expect(expectStatus(await call('GET', '/api/session'), 200).body).toEqual({ user: null, needsSetup: true, setupTokenRequired: false, webSetup: true, registrationOpen: true, inviteRegistration: false });

  // 首次設定（交易內重新檢查使用者數）
  const setup = expectStatus(await call('POST', '/api/setup', { body: { username: 'admin-one', displayName: '管理員', password: PASS } }), 200);
  const admin = setup.body.user;
  expect(admin).toMatchObject({ username: 'admin-one', displayName: '管理員', role: 'admin' });
  expectStatus(await call('POST', '/api/setup', { body: { username: 'admin-two', displayName: 'X', password: PASS } }), 409);

  // 登入：錯誤密碼 401，正確密碼取得新 Session
  expectStatus(await call('POST', '/api/login', { body: { username: 'admin-one', password: 'wrong password!!' } }), 401);
  const cookie = expectStatus(await call('POST', '/api/login', { body: { username: 'admin-one', password: PASS } }), 200).cookie;
  expect(cookie).toMatch(/^ggc_session=[a-f0-9]{64}$/);
  expect(expectStatus(await call('GET', '/api/session', { cookie }), 200).body.user.id).toBe(admin.id);

  // 建立行程：含 SQL 特殊字元的文字原樣往返（參數化查詢，Req 11.2）
  const title = "O'Brien; DROP TABLE trips; -- 露營 🏕️";
  const created = expectStatus(await call('POST', '/api/trips', { cookie, body: { title, destination: "a'b\\c", startDate: '2026-11-20', endDate: '2026-11-22', description: '', note: '--', coverKind: 'lake', status: 'planning', expectedUserId: admin.id } }), 201).body.trip;
  expect(created).toMatchObject({ title, destination: "a'b\\c", note: '--', revision: 1, memberCount: 1, isMember: true, canManage: true });
  const list = expectStatus(await call('GET', '/api/trips', { cookie }), 200).body.trips;
  expect(list.map(t => t.id)).toEqual([created.id]);

  // 更新行程（PATCH 設定與 PUT 手冊內容），revision 以樂觀鎖遞增
  const patched = expectStatus(await call('PATCH', `/api/trips/${created.id}`, { cookie, body: { revision: 1, note: '帶外套', expectedUserId: admin.id } }), 200).body;
  expect(patched.trip).toMatchObject({ revision: 2, note: '帶外套' });
  const env = expectStatus(await call('GET', `/api/trips/${created.id}`, { cookie }), 200).body;
  const state = structuredClone(env.state);
  state.trip.description = '一起出發';
  const put = expectStatus(await call('PUT', `/api/trips/${created.id}`, { cookie, body: { revision: env.trip.revision, state, expectedUserId: admin.id } }), 200).body;
  expect(put.trip).toMatchObject({ revision: 3, description: '一起出發' });
  expect(put.state.events[0].text).toBe('更新了旅行手冊');

  // 過期 revision → 409，且交易回復（沒有新增稽核列，Req 11.3）
  const before = await auditCount();
  expectStatus(await call('PATCH', `/api/trips/${created.id}`, { cookie, body: { revision: 1, note: 'stale', expectedUserId: admin.id } }), 409);
  expect(await auditCount()).toBe(before);
  expect(expectStatus(await call('GET', `/api/trips/${created.id}`, { cookie }), 200).body.trip.note).toBe('帶外套');

  // 帳本：首次寫入 → revision 1；同一 requestId 重送為冪等；過期 revision → 409
  const me = env.permissions.personId;
  const expense = { id: 'e1', date: '2026-11-20', title: "晚餐 'BBQ'", amountCents: 12000, payerId: me, participantIds: [me], category: EXPENSE_CATEGORIES[0], note: '', shoppingId: '', source: 'manual', receiptId: '', receiptLine: '' };
  const ledgerBody = { expectedUserId: admin.id, revision: 0, requestId: 'req-1', expenses: [expense], settlements: [] };
  const ledger = expectStatus(await call('PUT', `/api/trips/${created.id}/ledger`, { cookie, body: ledgerBody }), 200).body.ledger;
  expect(ledger).toMatchObject({ schema: 1, revision: 1 });
  expect(ledger.expenses).toEqual([expense]);
  expect(expectStatus(await call('PUT', `/api/trips/${created.id}/ledger`, { cookie, body: ledgerBody }), 200).body.ledger.revision).toBe(1);
  expectStatus(await call('PUT', `/api/trips/${created.id}/ledger`, { cookie, body: { ...ledgerBody, requestId: 'req-2', expenses: [] } }), 409);
  const second = expectStatus(await call('PUT', `/api/trips/${created.id}/ledger`, { cookie, body: { ...ledgerBody, revision: 1, requestId: 'req-3', expenses: [{ ...expense, amountCents: 15000 }] } }), 200).body.ledger;
  expect(second.revision).toBe(2);
  expect(expectStatus(await call('GET', `/api/trips/${created.id}/ledger`, { cookie }), 200).body.ledger.expenses[0].amountCents).toBe(15000);

  // 邀請與加入（member 帳號）、管理員清單的 COUNT(*) 轉為 number
  const token = expectStatus(await call('POST', `/api/trips/${created.id}/invites`, { cookie, body: {} }), 201).body.token;
  const member = expectStatus(await call('POST', '/api/register', { body: { username: 'member-one', displayName: '旅伴', password: PASS } }), 200);
  expect(expectStatus(await call('POST', `/api/invites/${token}/join`, { cookie: member.cookie, body: { name: '小明' } }), 200).body.tripId).toBe(created.id);
  const users = expectStatus(await call('GET', '/api/admin/users', { cookie }), 200).body.users;
  expect(users.map(u => [u.username, u.tripCount, u.deleted])).toEqual([['admin-one', 1, false], ['member-one', 1, false]]);

  // 稽核：BIGINT 時間戳記轉回 ISO 字串，依 id 遞減
  const events = expectStatus(await call('GET', '/api/admin/audit', { cookie }), 200).body.events;
  expect(events[0]).toMatchObject({ action: 'invite.join', actor: 'member-one', at: new Date(clockMs).toISOString() });
  expect(events.at(-1).action).toBe('setup');

  // 登出：Cookie 失效，之後視為未登入
  const out = expectStatus(await call('POST', '/api/logout', { cookie }), 200);
  expect(out.cookie).toBe('ggc_session=');
  expect(expectStatus(await call('GET', '/api/session', { cookie }), 200).body.user).toBeNull();
  expectStatus(await call('GET', '/api/trips', { cookie }), 401);
});

test('closed service fails closed and does not close the injected pool', async () => {
  svc.close();
  svc.close();
  expect((await call('GET', '/api/session')).status).toBe(503);
  expect(await svc.ping()).toBe(false);
  expect(Number((await db.sql`SELECT 1 AS ok`)[0].ok)).toBe(1);
});
