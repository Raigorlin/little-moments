// 測試用：產生符合舊版 SQLite Schema 的合成資料集（fast-check arbitrary），供 SQLite_Importer 屬性測試共用。
//
// 產生的資料集滿足：
//   * 外鍵一致（sessions/trips/... 只參照已產生的 users／trips）；
//   * 主鍵與 UNIQUE 限制（users.username、trip_members (trip_id,user_id) 與 (trip_id,person_id)、audit.id）；
//   * CHECK 限制（role、cover_kind、status、trip_ledgers.revision >= 1）；
//   * NULL 只出現在可為 NULL 的欄位（users.deleted_at、invites.revoked_at）；
//   * 文字含非 ASCII UTF-8、SQL 特殊字元，但不含 NUL（PostgreSQL TEXT 不接受）；
//   * BIGINT 欄位含 64 位元整數（大於 2^53 者以 bigint 表示）、INTEGER 欄位在 int4 範圍內。
//
// 回傳的物件可直接交給 buildSqliteFixture(path, data)。
import fc from 'fast-check';
import { columnNames, TABLE_COLUMNS } from '../../server/db/import-plan.js';

export const INT4_MIN = -(2 ** 31);
export const INT4_MAX = 2 ** 31 - 1;
export const INT8_MIN = -(2n ** 63n);
export const INT8_MAX = 2n ** 63n - 1n;
export const LOGIN_USERNAME = 'roundtrip-login';
// audit.id 上限保留 2^20 個空間：id 達 int8 最大值時，SQLite AUTOINCREMENT 與 PostgreSQL identity
// 都無法再新增稽核事件（App_Server 登入等操作會失敗），這不是可正常運作的來源資料庫。
export const AUDIT_ID_MAX = INT8_MAX - 2n ** 20n;

const SPECIAL_UNITS = ['露', '營', '拾', '光', '✨', '🏕️', '👨‍👩‍👧', 'é', 'ß', "'", '"', ';', '-', '\\', '%', '_', '\n', '\t', ' '];

/** 不含 NUL 的 Unicode 文字（含非 ASCII、emoji 與 SQL 特殊字元）。 */
export const textArb = (maxLength = 24) =>
  fc.string({
    unit: fc.oneof(
      fc.constantFrom(...SPECIAL_UNITS),
      fc.string({ unit: 'grapheme', minLength: 1, maxLength: 1 }),
      fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 1 }),
    ),
    maxLength,
  })
    .map(s => s.replaceAll('\u0000', ''));

/** 64 位元整數：安全整數為 number，超過 2^53 的值為 bigint；含邊界值。 */
export const int8Arb = fc.oneof(
  fc.integer({ min: 0, max: 4_102_444_800_000 }), // 一般毫秒時間戳
  fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
  fc.bigInt({ min: 2n ** 53n, max: INT8_MAX }),
  fc.bigInt({ min: INT8_MIN, max: INT8_MAX }),
  fc.constantFrom(0, Number.MAX_SAFE_INTEGER, 2n ** 53n, 2n ** 53n + 1n, INT8_MAX, INT8_MIN),
);

export const int4Arb = fc.oneof(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: INT4_MIN, max: INT4_MAX }), fc.constantFrom(INT4_MIN, INT4_MAX));

const EMPTY = Object.freeze({ users: [], sessions: [], trips: [], trip_members: [], invites: [], trip_deletions: [], audit: [], trip_ledgers: [] });

/**
 * @param {{maxRows?:number, textMax?:number, loginHash?:string|null, size?:string}} [options]
 *   maxRows：每表最多列數；size：fast-check 陣列 size（例如 'max' 讓列數均勻分布至 maxRows，
 *   預設的 size 會使長度偏向 10 以下）；loginHash：提供時可能（fc.boolean）在 users 第一列加入
 *   username 為 LOGIN_USERNAME、password_hash 為 loginHash、未刪除的使用者，回傳值的 `withLogin` 標示是否加入。
 * @returns {fc.Arbitrary<{data:Record<string, object[]>, withLogin:boolean}>}
 */
export function sqliteDatasetArb({ maxRows = 20, textMax = 24, loginHash = null, size = undefined } = {}) {
  const text = textArb(textMax);
  const hashLike = fc.oneof(text, fc.stringMatching(/^scrypt\$[0-9a-f]{8,32}\$[0-9a-f]{8,64}$/));
  const userRow = fc.record({
    idTag: text, display_name: text, role: fc.constantFrom('admin', 'member'),
    password_hash: hashLike, created_at: int8Arb, deleted_at: fc.option(int8Arb, { nil: null }),
  });

  return fc.record({
    users: fc.array(userRow, { maxLength: maxRows, size }),
    withLogin: loginHash ? fc.boolean() : fc.constant(false),
    auditRows: fc.uniqueArray(
      fc.record({ id: fc.oneof(fc.integer({ min: 1, max: 1_000_000 }), fc.bigInt({ min: 1n, max: AUDIT_ID_MAX })), at: int8Arb, actor: text, action: text, target: text }),
      { selector: r => BigInt(r.id), maxLength: maxRows, size },
    ),
  }).chain(({ users: rawUsers, withLogin, auditRows }) => {
    const users = rawUsers.map(({ idTag, ...u }, i) => ({ id: `${i}:${idTag}`, username: `user-${i}`, ...u }));
    if (withLogin) {
      users.unshift({ id: 'login', username: LOGIN_USERNAME, display_name: '登入測試 ✨', role: 'member', password_hash: loginHash, created_at: 1_762_000_000_000, deleted_at: null });
    }
    const audit = auditRows;
    if (!users.length) return fc.constant({ data: { ...EMPTY, audit }, withLogin });

    const uRef = fc.nat({ max: users.length - 1 });
    const tripRow = fc.record({
      idTag: text, owner: uRef, title: text, destination: text, start_date: text, end_date: text,
      description: text, note: text, cover_kind: fc.constantFrom('camp', 'mountain', 'lake', 'night'),
      status: fc.constantFrom('planning', 'completed'), revision: int4Arb, people_count: int4Arb,
      state_json: text, created_at: int8Arb, updated_at: int8Arb,
    });
    return fc.record({
      tripsRaw: fc.array(tripRow, { maxLength: maxRows, size }),
      sessionsRaw: fc.array(fc.record({ tag: text, user: uRef, created_at: int8Arb, expires_at: int8Arb }), { maxLength: maxRows, size }),
    }).chain(({ tripsRaw, sessionsRaw }) => {
      const trips = tripsRaw.map(({ idTag, owner, ...t }, i) => ({ id: `${i}:${idTag}`, owner_id: users[owner].id, ...t }));
      const sessions = sessionsRaw.map(({ tag, user, ...s }, i) => ({ token_hash: `${i}:${tag}`, user_id: users[user].id, ...s }));
      if (!trips.length) return fc.constant({ data: { ...EMPTY, users, sessions, audit }, withLogin });

      const tRef = fc.nat({ max: trips.length - 1 });
      return fc.record({
        members: fc.uniqueArray(fc.record({ trip: tRef, user: uRef, tag: text, joined_at: int8Arb }), { selector: r => `${r.trip}/${r.user}`, maxLength: maxRows, size }),
        invites: fc.array(fc.record({ tag: text, trip: tRef, user: uRef, created_at: int8Arb, expires_at: int8Arb, revoked_at: fc.option(int8Arb, { nil: null }) }), { maxLength: maxRows, size }),
        deletions: fc.uniqueArray(fc.record({ trip: tRef, user: uRef, deleted_at: int8Arb }), { selector: r => r.trip, maxLength: maxRows, size }),
        ledgers: fc.uniqueArray(fc.record({
          trip: tRef, revision: fc.integer({ min: 1, max: INT4_MAX }), ledger_json: text, requests_json: text, user: uRef, updated_at: int8Arb,
        }), { selector: r => r.trip, maxLength: maxRows, size }),
      }).map(({ members, invites, deletions, ledgers }) => ({
        withLogin,
        data: {
          users, sessions, trips, audit,
          trip_members: members.map(({ trip, user, tag, joined_at }, i) => ({ trip_id: trips[trip].id, user_id: users[user].id, person_id: `p${i}:${tag}`, joined_at })),
          invites: invites.map(({ tag, trip, user, ...r }, i) => ({ token_hash: `${i}:${tag}`, trip_id: trips[trip].id, created_by: users[user].id, ...r })),
          trip_deletions: deletions.map(({ trip, user, deleted_at }) => ({ trip_id: trips[trip].id, deleted_by: users[user].id, deleted_at })),
          trip_ledgers: ledgers.map(({ trip, user, ...r }) => ({ trip_id: trips[trip].id, updated_by: users[user].id, ...r })),
        },
      }));
    });
  });
}

/**
 * 將資料列正規化為可比較的形式：整數欄位（INTEGER／BIGINT）轉為十進位字串（避免精度損失），
 * TEXT 原樣、NULL 保留。number、bigint 與 PostgreSQL 回傳的字串皆可。
 */
export function canonicalRow(table, row) {
  return TABLE_COLUMNS[table].map(({ name, type }) => {
    const v = row[name];
    if (v === null || v === undefined) return null;
    return type === 'TEXT' ? v : BigInt(v).toString();
  });
}

/** 正規化並排序整個資料表（資料列集合比較用）。 */
export function canonicalTable(table, rows) {
  return rows.map(r => canonicalRow(table, r)).map(r => JSON.stringify(r)).sort();
}

export { columnNames };
