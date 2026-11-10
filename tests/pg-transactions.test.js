// Feature: jenkins-cicd-deploy, Property 25: 寫入交易原子性
//
// *For any* 會在交易內第 k 步（k 為隨機）注入例外的寫入操作，交易結束後 Database 所有資料表內容
// 與操作前相同，並回應錯誤。
// **Validates: Requirements 11.3**
//
// 兩層驗證（皆需 CAMPING_TEST_DATABASE_*，見 tests/support/pg.js）：
//   1. withWriteTx(sql, fn) 直接測試：fn 內隨機寫入序列，於第 k 步注入 JS 例外或 PostgreSQL 限制違反
//      （重複主鍵、外鍵、CHECK、NOT NULL）。失敗時所有資料表完整內容等於快照、錯誤原樣傳出；
//      無失敗時所有寫入皆已提交。另驗證 advisory lock 序列化並行的「讀取→寫入」交易（無遺失更新）。
//   2. 透過 createAccountService：選擇 accounts.js 中會在 tx 內執行多個寫入的操作（加入邀請、刪除行程、
//      刪除使用者、帳本、建立行程、修改行程設定），以「測試 schema 內的 row-level trigger」在指定資料表與
//      操作（INSERT／UPDATE／DELETE）上丟出指定 SQLSTATE 的例外，模擬中途失敗。
//      這是直接以 SQL 設定的故障注入，不修改、不 monkeypatch 任何 server/ 內部函式；trigger 與控制表
//      只存在於本測試檔的 `t_<random>` schema，afterAll 隨 schema 一併刪除。
import { test, expect, beforeAll } from 'bun:test';
import fc from 'fast-check';
import { useTestDatabase, resetTables, serviceDb } from './support/pg.js';
import { withWriteTx } from '../server/db/tx.js';
import { createAccountService } from '../server/accounts.js';

const db = useTestDatabase();
const BASE = 'http://127.0.0.1:5181';
const PASS = 'correct horse battery';
const LONG = 120_000;

/** 每個應用程式資料表的完整內容（每列轉為 jsonb 文字並排序）；固定語句、無插值。 */
async function snapshot(sql) {
  const col = async rows => (await rows).map(r => r.r);
  return {
    users: await col(sql`SELECT to_jsonb(x)::text AS r FROM users x ORDER BY 1`),
    sessions: await col(sql`SELECT to_jsonb(x)::text AS r FROM sessions x ORDER BY 1`),
    trips: await col(sql`SELECT to_jsonb(x)::text AS r FROM trips x ORDER BY 1`),
    trip_members: await col(sql`SELECT to_jsonb(x)::text AS r FROM trip_members x ORDER BY 1`),
    invites: await col(sql`SELECT to_jsonb(x)::text AS r FROM invites x ORDER BY 1`),
    trip_deletions: await col(sql`SELECT to_jsonb(x)::text AS r FROM trip_deletions x ORDER BY 1`),
    audit: await col(sql`SELECT to_jsonb(x)::text AS r FROM audit x ORDER BY 1`),
    trip_ledgers: await col(sql`SELECT to_jsonb(x)::text AS r FROM trip_ledgers x ORDER BY 1`),
  };
}
const count = async (sql, rows) => Number((await rows)[0].n);
const sqlState = err => String(err?.errno ?? '');

// ---------------------------------------------------------------------------
// Layer 1：withWriteTx 直接測試
// ---------------------------------------------------------------------------

async function seedBase(sql) {
  await resetTables(sql);
  await sql`INSERT INTO users (id, username, display_name, role, password_hash, created_at) VALUES
    ('u0', 'owner', 'Owner', 'admin', 'x', 1), ('u1', 'guest', 'Guest', 'member', 'x', 1)`;
  await sql`INSERT INTO trips (id, owner_id, title, destination, start_date, end_date, description, note, cover_kind, status, revision, people_count, state_json, created_at, updated_at)
    VALUES ('tr0', 'u0', 'base', '', '2026-01-01', '2026-01-02', '', '', 'camp', 'planning', 1, 1, '{}', 1, 1)`;
  await sql`INSERT INTO trip_members (trip_id, user_id, person_id, joined_at) VALUES ('tr0', 'u0', 'p0', 1)`;
}

// 文字值不得含 NUL（PostgreSQL text 不接受）。
const textArb = fc.string({ maxLength: 40 }).map(s => s.replaceAll('\u0000', ''));
const opArb = fc.oneof(
  fc.record({ kind: fc.constant('user'), name: textArb }),
  fc.record({ kind: fc.constant('audit'), actor: textArb }),
  fc.record({ kind: fc.constant('title'), title: textArb }),
  fc.record({ kind: fc.constant('session') }),
  fc.record({ kind: fc.constant('invite') }),
);
async function applyOp(t, op, i) {
  switch (op.kind) {
    case 'user': await t`INSERT INTO users (id, username, display_name, role, password_hash, created_at) VALUES (${`nu_${i}`}, ${`nu_${i}`}, ${op.name}, 'member', 'x', ${i})`; break;
    case 'audit': await t`INSERT INTO audit (at, actor, action, target) VALUES (${i}, ${op.actor}, 'test', 'x')`; break;
    case 'title': await t`UPDATE trips SET title = ${op.title}, revision = revision + 1 WHERE id = 'tr0'`; break;
    case 'session': await t`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (${`s_${i}`}, 'u1', ${i}, ${i + 1000})`; break;
    case 'invite': await t`INSERT INTO invites (token_hash, trip_id, created_by, created_at, expires_at) VALUES (${`i_${i}`}, 'tr0', 'u0', ${i}, ${i + 1000})`; break;
  }
}
class InjectedError extends Error {}
// 每種失敗：注入動作與預期的 SQLSTATE（JS 例外為 null）。
const FAILURES = {
  throw: { run: async () => { throw new InjectedError('injected'); }, state: null },
  dupPk: { run: t => t`INSERT INTO users (id, username, display_name, role, password_hash, created_at) VALUES ('u0', 'dup', 'd', 'member', 'x', 1)`, state: '23505' },
  fk: { run: t => t`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('fk', 'no-such-user', 1, 2)`, state: '23503' },
  check: { run: t => t`INSERT INTO users (id, username, display_name, role, password_hash, created_at) VALUES ('chk', 'chk', 'c', 'root', 'x', 1)`, state: '23514' },
  notNull: { run: t => t`INSERT INTO audit (at, actor, action, target) VALUES (1, ${null}, 'a', 't')`, state: '23502' },
};

test('Property 25 (withWriteTx): 第 k 步注入失敗時完整回復，無失敗時全部提交', async () => {
  const sql = db.sql;
  await fc.assert(fc.asyncProperty(
    fc.array(opArb, { minLength: 1, maxLength: 8 }),
    fc.nat(),
    fc.constantFrom('none', ...Object.keys(FAILURES)),
    async (ops, kRaw, failure) => {
      await seedBase(sql);
      const before = await snapshot(sql);
      const k = kRaw % (ops.length + 1); // 0..ops.length：失敗發生在第 k 個寫入之前
      let executed = 0;
      const run = withWriteTx(sql, async t => {
        for (let i = 0; i < ops.length; i++) {
          if (failure !== 'none' && i === k) await FAILURES[failure].run(t);
          await applyOp(t, ops[i], i);
          executed++;
        }
        if (failure !== 'none' && k === ops.length) await FAILURES[failure].run(t);
        return 'done';
      });

      if (failure === 'none') {
        expect(await run).toBe('done');
        const counts = kind => ops.filter(o => o.kind === kind).length;
        expect(await count(sql, sql`SELECT COUNT(*) AS n FROM users`)).toBe(2 + counts('user'));
        expect(await count(sql, sql`SELECT COUNT(*) AS n FROM audit`)).toBe(counts('audit'));
        expect(await count(sql, sql`SELECT COUNT(*) AS n FROM sessions`)).toBe(counts('session'));
        expect(await count(sql, sql`SELECT COUNT(*) AS n FROM invites`)).toBe(counts('invite'));
        const titles = ops.filter(o => o.kind === 'title');
        const [trip] = await sql`SELECT title, revision FROM trips WHERE id = 'tr0'`;
        expect(trip.title).toBe(titles.length ? titles.at(-1).title : 'base');
        expect(trip.revision).toBe(1 + titles.length);
        return;
      }

      let error = null;
      try { await run; } catch (err) { error = err; }
      expect(error).not.toBeNull();
      const expected = FAILURES[failure].state;
      if (expected === null) expect(error).toBeInstanceOf(InjectedError);
      else expect(sqlState(error)).toBe(expected);
      expect(executed).toBe(k);
      expect(await snapshot(sql)).toEqual(before);
    },
  ), { numRuns: 100 });
}, LONG);

test('Property 25 (withWriteTx): advisory lock 序列化並行的讀取→寫入交易，失敗者不留下變更', async () => {
  const sql = db.sql;
  await fc.assert(fc.asyncProperty(
    fc.array(fc.record({ delay: fc.integer({ min: 0, max: 3 }), fail: fc.boolean() }), { minLength: 2, maxLength: 8 }),
    async workers => {
      await seedBase(sql);
      const results = await Promise.allSettled(workers.map(w => withWriteTx(sql, async t => {
        const [{ display_name: v }] = await t`SELECT display_name FROM users WHERE id = 'u1'`;
        const current = v === 'Guest' ? 0 : Number(v);
        await Bun.sleep(w.delay); // 擴大「讀取→寫入」之間的競態窗口
        await t`UPDATE users SET display_name = ${String(current + 1)} WHERE id = 'u1'`;
        if (w.fail) throw new InjectedError('after write');
        return current + 1;
      })));
      const ok = workers.filter(w => !w.fail).length;
      results.forEach((r, i) => expect(r.status).toBe(workers[i].fail ? 'rejected' : 'fulfilled'));
      const [{ display_name: final }] = await sql`SELECT display_name FROM users WHERE id = 'u1'`;
      expect(ok === 0 ? final : Number(final)).toBe(ok === 0 ? 'Guest' : ok);
      // 序列化 ⇒ 成功者看到的值恰為 1..ok 各一次
      expect(results.filter(r => r.status === 'fulfilled').map(r => r.value).sort((a, b) => a - b))
        .toEqual(Array.from({ length: ok }, (_, i) => i + 1));
    },
  ), { numRuns: 100 });
}, LONG);

// ---------------------------------------------------------------------------
// Layer 2：createAccountService 的多步寫入操作
// ---------------------------------------------------------------------------

const APP_TABLES_FOR_FAULTS = ['users', 'sessions', 'trips', 'trip_members', 'invites', 'trip_deletions', 'audit', 'trip_ledgers'];

beforeAll(async () => {
  const sql = db.sql;
  // 故障注入：控制表 + 通用 trigger 函式。命中 (資料表, 操作) 時以指定 SQLSTATE 丟出例外。
  await sql`CREATE TABLE fault_injection (tbl TEXT NOT NULL, op TEXT NOT NULL, errcode TEXT NOT NULL)`;
  await sql`CREATE FUNCTION fault_inject() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE code TEXT;
    BEGIN
      SELECT errcode INTO code FROM fault_injection WHERE tbl = TG_TABLE_NAME AND op = TG_OP LIMIT 1;
      IF code IS NOT NULL THEN
        RAISE EXCEPTION 'injected fault on %.%', TG_TABLE_NAME, TG_OP USING ERRCODE = code;
      END IF;
      RETURN COALESCE(NEW, OLD);
    END $$`;
  // 資料表名稱為固定常數；DO 區塊內以 format(%I) 產生 identifier，透過 search_path 解析到測試 schema。
  await sql`DO $$ DECLARE t TEXT; BEGIN
    FOREACH t IN ARRAY ARRAY['users','sessions','trips','trip_members','invites','trip_deletions','audit','trip_ledgers'] LOOP
      EXECUTE format('CREATE TRIGGER fault_inject BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fault_inject()', t);
    END LOOP; END $$`;
  const [{ n }] = await sql`SELECT COUNT(*) AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace s ON s.oid = c.relnamespace
    WHERE t.tgname = 'fault_inject' AND s.nspname = current_schema()`;
  expect(Number(n)).toBe(APP_TABLES_FOR_FAULTS.length);
}, 60_000);

const setFault = async (sql, fault) => {
  await sql`DELETE FROM fault_injection`;
  if (fault) await sql`INSERT INTO fault_injection (tbl, op, errcode) VALUES (${fault.tbl}, ${fault.op}, ${fault.errcode})`;
};

function caller(svc) {
  return async (method, path, { body, cookie } = {}) => {
    const headers = { origin: BASE };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await svc.handle(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), { ip: '127.0.0.1', tcpIp: '127.0.0.1' });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
}
const must = (res, status) => { if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`); return res; };

/**
 * 建立一個讓每個被測操作都會走過所有列出寫入步驟的世界：
 *   admin（擁有行程 A，A 有一個給 m2 的有效邀請）、m1（A 的旅伴、擁有行程 B 並建立過 B 的邀請）、m2（尚未加入）。
 */
async function buildWorld(sql) {
  await setFault(sql, null);
  await resetTables(sql);
  let clockMs = Date.parse('2026-11-04T00:00:00Z');
  const svc = await createAccountService({ db: serviceDb(sql), now: () => clockMs });
  const call = caller(svc);
  const admin = must(await call('POST', '/api/setup', { body: { username: 'admin-one', displayName: '管理員', password: PASS } }), 200);
  const m1 = must(await call('POST', '/api/register', { body: { username: 'member-one', displayName: '旅伴一', password: PASS } }), 200);
  const m2 = must(await call('POST', '/api/register', { body: { username: 'member-two', displayName: '旅伴二', password: PASS } }), 200);
  const ids = { admin: admin.body.user.id, m1: m1.body.user.id, m2: m2.body.user.id };
  const tripBody = (title, expectedUserId) => ({ title, startDate: '2026-11-20', endDate: '2026-11-22', expectedUserId });
  const tripA = must(await call('POST', '/api/trips', { cookie: admin.cookie, body: tripBody('行程A', ids.admin) }), 201).body.trip;
  const tripB = must(await call('POST', '/api/trips', { cookie: m1.cookie, body: tripBody('行程B', ids.m1) }), 201).body.trip;
  must(await call('POST', `/api/trips/${tripB.id}/invites`, { cookie: m1.cookie, body: {} }), 201);
  const forM1 = must(await call('POST', `/api/trips/${tripA.id}/invites`, { cookie: admin.cookie, body: {} }), 201).body.token;
  must(await call('POST', `/api/invites/${forM1}/join`, { cookie: m1.cookie, body: { name: '小明' } }), 200);
  const forM2 = must(await call('POST', `/api/trips/${tripA.id}/invites`, { cookie: admin.cookie, body: {} }), 201).body.token;
  const envA = must(await call('GET', `/api/trips/${tripA.id}`, { cookie: admin.cookie }), 200).body;
  clockMs += 60_000;
  return { svc, call, cookies: { admin: admin.cookie, m1: m1.cookie, m2: m2.cookie }, ids, tripA: envA.trip, tripB, inviteForM2: forM2 };
}

/** 被測操作：請求內容與「此操作在 tx 內必定會執行」的寫入步驟（故障注入點）。 */
const OPERATIONS = {
  joinInvite: {
    request: w => ['POST', `/api/invites/${w.inviteForM2}/join`, { cookie: w.cookies.m2, body: { name: '小華' } }],
    ok: 200,
    steps: [['trip_members', 'INSERT'], ['trips', 'UPDATE'], ['audit', 'INSERT']],
  },
  deleteTrip: {
    request: w => ['POST', `/api/trips/${w.tripA.id}/delete`, { cookie: w.cookies.admin, body: { expectedUserId: w.ids.admin, confirmTitle: w.tripA.title, revision: w.tripA.revision } }],
    ok: 200,
    steps: [['trip_deletions', 'INSERT'], ['invites', 'UPDATE'], ['audit', 'INSERT']],
  },
  adminDeleteUser: {
    request: w => ['POST', `/api/admin/users/${w.ids.m1}/delete`, { cookie: w.cookies.admin, body: { confirmUsername: 'member-one' } }],
    ok: 200,
    steps: [['users', 'UPDATE'], ['sessions', 'DELETE'], ['invites', 'UPDATE'], ['trip_members', 'DELETE'], ['trip_members', 'INSERT'], ['trips', 'UPDATE'], ['audit', 'INSERT']],
  },
  putLedger: {
    request: w => ['PUT', `/api/trips/${w.tripA.id}/ledger`, { cookie: w.cookies.admin, body: { expectedUserId: w.ids.admin, revision: 0, requestId: 'req-atomic', expenses: [], settlements: [] } }],
    ok: 200,
    steps: [['trip_ledgers', 'INSERT'], ['audit', 'INSERT']],
  },
  createTrip: {
    request: w => ['POST', '/api/trips', { cookie: w.cookies.m2, body: { title: '新行程', startDate: '2026-12-01', endDate: '2026-12-02', expectedUserId: w.ids.m2 } }],
    ok: 201,
    steps: [['trips', 'INSERT'], ['trip_members', 'INSERT'], ['audit', 'INSERT']],
  },
  patchTrip: {
    request: w => ['PATCH', `/api/trips/${w.tripA.id}`, { cookie: w.cookies.admin, body: { revision: w.tripA.revision, note: '帶外套', expectedUserId: w.ids.admin } }],
    ok: 200,
    steps: [['trips', 'UPDATE'], ['audit', 'INSERT']],
  },
};
// raise_exception、unique、FK、CHECK、NOT NULL、serialization_failure
const ERRCODES = ['P0001', '23505', '23503', '23514', '23502', '40001'];

test('對照組：未注入故障時每個操作都成功並寫入資料（確認注入點確實位於成功路徑上）', async () => {
  const sql = db.sql;
  for (const [name, op] of Object.entries(OPERATIONS)) {
    const world = await buildWorld(sql);
    const before = await snapshot(sql);
    const res = await world.call(...op.request(world));
    expect({ name, status: res.status }).toEqual({ name, status: op.ok });
    const after = await snapshot(sql);
    // 每個列出的步驟所屬資料表內容都已改變
    for (const [tbl] of op.steps) expect({ name, tbl, changed: JSON.stringify(after[tbl]) !== JSON.stringify(before[tbl]) }).toEqual({ name, tbl, changed: true });
    world.svc.close();
  }
}, LONG);

test('Property 25 (accounts): 多步寫入在任一步失敗時回應 500 且所有資料表不變', async () => {
  const sql = db.sql;
  const world = await buildWorld(sql);
  const before = await snapshot(sql);
  const cases = Object.entries(OPERATIONS).flatMap(([name, op]) => op.steps.map((step, k) => ({ name, k, step })));
  try {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...cases),
      fc.constantFrom(...ERRCODES),
      async ({ name, step: [tbl, operation] }, errcode) => {
        await setFault(sql, { tbl, op: operation, errcode });
        const res = await world.call(...OPERATIONS[name].request(world));
        await setFault(sql, null);
        expect({ name, tbl, operation, status: res.status }).toEqual({ name, tbl, operation, status: 500 });
        expect(res.body).toEqual({ error: '伺服器暫時無法處理，請稍後再試。' });
        expect(res.cookie).toBe('');
        // 失敗交易回復後，世界與操作前完全相同（因此下一次執行仍從同一狀態開始）
        expect(await snapshot(sql)).toEqual(before);
      },
    ), { numRuns: 120 });
  } finally {
    await setFault(sql, null);
    world.svc.close();
  }
}, LONG);
