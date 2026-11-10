// Feature: jenkins-cicd-deploy, Property 35: 匯入失敗時目標不變
//
// *For any* 目標狀態與失敗情境（目標任一表非空、任一表寫入時注入錯誤、提交前筆數不符），
// SQLite_Importer 以非零結束碼結束，且目標每個資料表的筆數等於執行前的值；
// compareCounts(source, target) 回報的不符表集合恰為筆數不同的表。
//
// **Validates: Requirements 13.3, 13.4, 13.6**
//
// 每次執行：
//   1. resetTables 後依情境準備目標（nonEmpty 情境預先寫入一筆資料列鏈），並取得完整快照：
//      每個 App 資料表的全部資料列、schema_migrations、audit identity 序列的 last_value／is_called。
//   2. 在暫存目錄建立來源 SQLite（每個文字欄位與主鍵都帶本次執行的 sentinel 字串）。
//      資料錯誤情境使用「放寬」的 Schema 副本（移除 NOT NULL、CHECK、UNIQUE，且不啟用外鍵），
//      讓 SQLite 接受 PostgreSQL 會拒絕的資料列；壞資料列放在已有多筆有效資料列的資料表中。
//   3. 筆數不符情境：在測試 schema 的隨機葉資料表上建立 BEFORE INSERT … RETURN NULL 觸發器，
//      讓 INSERT 靜默丟棄資料列；執行後一律刪除觸發器。
//   4. 斷言：特定非零結束碼、錯誤輸出含資料表名稱與原因類別、所有輸出都不含 sentinel，
//      且目標快照與執行前完全相同。
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fc from 'fast-check';
import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  importSqlite, EXIT_TARGET_NOT_EMPTY, EXIT_IMPORT_FAILED, EXIT_COUNT_MISMATCH,
} from '../scripts/import-sqlite.mjs';
import { tableOrder, columnNames, compareCounts } from '../server/db/import-plan.js';
import { useTestDatabase, resetTables, APP_TABLES } from './support/pg.js';
import { buildSqliteFixture, OLD_SQLITE_SCHEMA } from './support/sqlite-fixture.js';

const db = useTestDatabase();

// ---------------------------------------------------------------------------
// 放寬的 SQLite Schema（只用於測試來源檔）：移除 CHECK、NOT NULL 與 UNIQUE，主鍵保留。
const RELAXED_SQLITE_SCHEMA = OLD_SQLITE_SCHEMA
  .replace(/\s+CHECK \((?:[^()]|\([^()]*\))*\)/g, '')
  .replace(/ NOT NULL/g, '')
  .replace(/ UNIQUE,/g, ',')
  .replace(/,\s*UNIQUE \(trip_id, person_id\)/g, '');

function buildRelaxedFixture(path, data) {
  const sqlite = new Database(path, { create: true, safeIntegers: true });
  try {
    sqlite.exec('PRAGMA foreign_keys = OFF;');
    sqlite.exec(RELAXED_SQLITE_SCHEMA);
    sqlite.transaction(() => {
      for (const table of tableOrder()) {
        const cols = columnNames(table);
        const insert = sqlite.query(`INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
        for (const row of data[table] ?? []) insert.run(...cols.map(c => (row[c] === undefined ? null : row[c])));
      }
    })();
  } finally {
    sqlite.close();
  }
}

// ---------------------------------------------------------------------------
// 有效資料集產生器：每個資料表至少 1 列；audit 偶爾超過一個批次（> 500 列）。
const textArb = fc.string({ unit: 'grapheme', maxLength: 8 }).map(s => s.replace(/\u0000/g, ''));
const timeArb = fc.oneof(
  fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
  fc.bigInt({ min: 2n ** 53n, max: 2n ** 63n - 1n }),
);
const smallIntArb = fc.integer({ min: 1, max: 100_000 });
const refArb = fc.nat({ max: 1000 });

const seedArb = fc.record({
  users: fc.array(fc.record({ text: textArb, admin: fc.boolean(), created: timeArb, deleted: fc.option(timeArb, { nil: null }) }), { minLength: 2, maxLength: 5 }),
  trips: fc.array(fc.record({
    owner: refArb, text: textArb,
    cover: fc.constantFrom('camp', 'mountain', 'lake', 'night'), status: fc.constantFrom('planning', 'completed'),
    revision: smallIntArb, people: smallIntArb, created: timeArb,
  }), { minLength: 1, maxLength: 4 }),
  sessions: fc.array(fc.record({ user: refArb, created: timeArb }), { minLength: 1, maxLength: 4 }),
  members: fc.array(fc.record({ trip: refArb, user: refArb, joined: timeArb }), { minLength: 1, maxLength: 6 }),
  invites: fc.array(fc.record({ trip: refArb, user: refArb, created: timeArb, revoked: fc.option(timeArb, { nil: null }) }), { minLength: 1, maxLength: 4 }),
  deletions: fc.array(fc.record({ trip: refArb, user: refArb, at: timeArb }), { minLength: 1, maxLength: 3 }),
  ledgers: fc.array(fc.record({ trip: refArb, user: refArb, revision: smallIntArb, text: textArb, at: timeArb }), { minLength: 1, maxLength: 3 }),
  auditCount: fc.oneof({ weight: 5, arbitrary: fc.integer({ min: 1, max: 12 }) }, { weight: 1, arbitrary: fc.integer({ min: 501, max: 620 }) }),
  auditText: textArb,
});

const uniqueBy = (rows, key) => {
  const seen = new Set();
  return rows.filter(r => { const k = key(r); if (seen.has(k)) return false; seen.add(k); return true; });
};

/** 將種子轉為滿足所有 PostgreSQL 約束的資料列；每個文字欄位與主鍵都帶 marker。 */
function materialize(seed, marker) {
  const m = s => `${marker}:${s}`;
  const users = seed.users.map((u, i) => ({
    id: m(`u${i}`), username: m(`user${i}`), display_name: m(u.text), role: u.admin ? 'admin' : 'member',
    password_hash: `scrypt$16384$8$1$${marker}salt$${marker}hash${i}`, created_at: u.created, deleted_at: u.deleted,
  }));
  const user = ref => users[ref % users.length].id;
  const trips = seed.trips.map((t, i) => ({
    id: m(`t${i}`), owner_id: user(t.owner), title: m(t.text), destination: m('dest'), start_date: '2026-11-20', end_date: '2026-11-22',
    description: m('desc'), note: m(t.text), cover_kind: t.cover, status: t.status, revision: t.revision, people_count: t.people,
    state_json: JSON.stringify({ marker, text: t.text }), created_at: t.created, updated_at: t.created,
  }));
  const trip = ref => trips[ref % trips.length].id;
  return {
    users,
    sessions: seed.sessions.map((s, i) => ({ token_hash: m(`s${i}`), user_id: user(s.user), created_at: s.created, expires_at: s.created })),
    trips,
    trip_members: uniqueBy(seed.members.map((x, i) => ({ trip_id: trip(x.trip), user_id: user(x.user), person_id: m(`p${i}`), joined_at: x.joined })), r => `${r.trip_id}|${r.user_id}`),
    invites: seed.invites.map((x, i) => ({ token_hash: m(`i${i}`), trip_id: trip(x.trip), created_by: user(x.user), created_at: x.created, expires_at: x.created, revoked_at: x.revoked })),
    trip_deletions: uniqueBy(seed.deletions.map(x => ({ trip_id: trip(x.trip), deleted_by: user(x.user), deleted_at: x.at })), r => r.trip_id),
    audit: Array.from({ length: seed.auditCount }, (_, i) => ({ id: i * 3 + 1, at: i, actor: m(`a${i}`), action: m('act'), target: m(seed.auditText) })),
    trip_ledgers: uniqueBy(seed.ledgers.map(x => ({
      trip_id: trip(x.trip), revision: x.revision, ledger_json: JSON.stringify({ marker, t: x.text }), requests_json: m('[]'), updated_by: user(x.user), updated_at: x.at,
    })), r => r.trip_id),
  };
}

// ---------------------------------------------------------------------------
// 失敗情境。
const NOT_NULL_TARGETS = [
  ['users', 'password_hash'], ['trips', 'title'], ['trips', 'state_json'], ['trip_members', 'person_id'],
  ['invites', 'created_by'], ['trip_deletions', 'deleted_by'], ['audit', 'actor'], ['trip_ledgers', 'ledger_json'],
];
const INT4_TARGETS = [['trips', 'revision'], ['trips', 'people_count'], ['trip_ledgers', 'revision']];
const CONSTRAINT_TARGETS = [
  { table: 'users', column: 'username', kind: 'duplicate', code: '23505' },
  { table: 'users', column: 'role', kind: 'text', value: 'root', code: '23514' },
  { table: 'trips', column: 'cover_kind', kind: 'text', value: 'beach', code: '23514' },
  { table: 'trips', column: 'status', kind: 'text', value: 'archived', code: '23514' },
  { table: 'trip_ledgers', column: 'revision', kind: 'int', value: 0, code: '23514' },
  { table: 'sessions', column: 'user_id', kind: 'text', value: 'ghost', code: '23503' },
  { table: 'invites', column: 'trip_id', kind: 'text', value: 'ghost', code: '23503' },
  { table: 'trip_ledgers', column: 'updated_by', kind: 'text', value: 'ghost', code: '23503' },
];
const LEAF_TABLES = ['sessions', 'trip_members', 'invites', 'trip_deletions', 'audit', 'trip_ledgers'];

const scenarioArb = fc.oneof(
  fc.record({ kind: fc.constant('nonEmpty'), table: fc.constantFrom(...APP_TABLES) }),
  fc.record({ kind: fc.constant('nullValue'), target: fc.constantFrom(...NOT_NULL_TARGETS), pos: fc.nat() }),
  fc.record({
    kind: fc.constant('int4Overflow'), target: fc.constantFrom(...INT4_TARGETS), pos: fc.nat(),
    value: fc.oneof(fc.bigInt({ min: 2n ** 31n, max: 2n ** 62n }), fc.bigInt({ min: -(2n ** 62n), max: -(2n ** 31n) - 1n })),
  }),
  fc.record({ kind: fc.constant('constraint'), target: fc.constantFrom(...CONSTRAINT_TARGETS), pos: fc.nat() }),
  fc.record({ kind: fc.constant('countMismatch'), table: fc.constantFrom(...LEAF_TABLES) }),
);

/** 選擇被破壞的資料列：偏向表尾，讓前面的資料列（與前面的資料表）先被寫入。 */
const pickIndex = (rows, pos) => rows.length - 1 - (pos % rows.length);

/** 依外鍵鏈在目標寫入一筆資料列（以及必要的父資料列）。 */
async function preInsert(sql, table, marker) {
  const u = `${marker}:pre-u`, t = `${marker}:pre-t`;
  const needsUser = table !== 'audit';
  const needsTrip = !['users', 'sessions', 'audit'].includes(table);
  if (needsUser) await sql`INSERT INTO users (id, username, display_name, role, password_hash, created_at) VALUES (${u}, ${u}, ${u}, 'member', ${u}, 1)`;
  if (needsTrip) {
    await sql`INSERT INTO trips (id, owner_id, title, destination, start_date, end_date, description, note, cover_kind, status, revision, people_count, state_json, created_at, updated_at)
      VALUES (${t}, ${u}, ${t}, ${t}, '2026-01-01', '2026-01-02', '', '', 'camp', 'planning', 1, 1, '{}', 1, 1)`;
  }
  switch (table) {
    case 'sessions': await sql`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (${`${marker}:pre-s`}, ${u}, 1, 2)`; break;
    case 'trip_members': await sql`INSERT INTO trip_members (trip_id, user_id, person_id, joined_at) VALUES (${t}, ${u}, 'p', 1)`; break;
    case 'invites': await sql`INSERT INTO invites (token_hash, trip_id, created_by, created_at, expires_at) VALUES (${`${marker}:pre-i`}, ${t}, ${u}, 1, 2)`; break;
    case 'trip_deletions': await sql`INSERT INTO trip_deletions (trip_id, deleted_by, deleted_at) VALUES (${t}, ${u}, 1)`; break;
    case 'audit': await sql`INSERT INTO audit (at, actor, action, target) VALUES (1, ${marker}, 'pre', ${marker})`; break;
    case 'trip_ledgers': await sql`INSERT INTO trip_ledgers (trip_id, revision, ledger_json, requests_json, updated_by, updated_at) VALUES (${t}, 1, '{}', '[]', ${u}, 1)`; break;
    default: break; // users、trips 已寫入
  }
}

/** 目標完整快照：每個 App 資料表與 schema_migrations 的資料列、audit identity 序列狀態。 */
async function snapshot(sql) {
  const out = {};
  for (const table of [...APP_TABLES, 'schema_migrations']) {
    const rows = await sql`SELECT to_jsonb(x)::text AS j FROM ${sql(table)} x`;
    out[table] = rows.map(r => r.j).sort();
  }
  const [seq] = await sql`SELECT last_value::text AS last_value, is_called FROM audit_id_seq`;
  out.auditSequence = { last_value: seq.last_value, is_called: seq.is_called };
  return out;
}

async function countsOf(sql) {
  const counts = {};
  for (const table of APP_TABLES) {
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM ${sql(table)}`;
    counts[table] = n;
  }
  return counts;
}

describe('Property 35: 匯入失敗時目標不變', () => {
  beforeAll(async () => {
    // 觸發器函式建立在測試 schema（search_path）內，隨 DROP SCHEMA … CASCADE 一併移除。
    await db.sql`CREATE OR REPLACE FUNCTION lm_p35_drop_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`;
  });
  afterAll(async () => {
    await db.sql`DROP FUNCTION IF EXISTS lm_p35_drop_row() CASCADE`;
  });

  test('relaxed fixture schema keeps every column but drops the constraints', () => {
    expect(RELAXED_SQLITE_SCHEMA).not.toMatch(/CHECK|NOT NULL|UNIQUE/);
    for (const table of tableOrder()) {
      for (const column of columnNames(table)) expect(RELAXED_SQLITE_SCHEMA).toContain(column);
    }
  });

  test('every failure scenario exits non-zero, reports table and reason without row contents, and leaves the target unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, scenarioArb, async (seed, scenario) => {
        const marker = `LMSENTINEL${randomBytes(6).toString('hex')}`;
        const data = materialize(seed, marker);
        const dir = await mkdtemp(join(tmpdir(), 'lm-p35-'));
        const source = join(dir, 'accounts.sqlite');
        const errors = [];
        const lines = [];
        let triggerTable = null;
        try {
          await resetTables(db.sql);

          let expectedCode;
          let expectedTable;
          let expectedReason;
          let relaxed = false;
          let badValue = null;

          switch (scenario.kind) {
            case 'nonEmpty':
              await preInsert(db.sql, scenario.table, marker);
              expectedCode = EXIT_TARGET_NOT_EMPTY;
              expectedTable = scenario.table;
              expectedReason = '目標 Database 非空';
              break;
            case 'nullValue': {
              const [table, column] = scenario.target;
              data[table][pickIndex(data[table], scenario.pos)][column] = null;
              relaxed = true;
              expectedCode = EXIT_IMPORT_FAILED;
              expectedTable = table;
              expectedReason = `欄位 ${column}`;
              break;
            }
            case 'int4Overflow': {
              const [table, column] = scenario.target;
              data[table][pickIndex(data[table], scenario.pos)][column] = scenario.value;
              badValue = String(scenario.value);
              relaxed = true;
              expectedCode = EXIT_IMPORT_FAILED;
              expectedTable = table;
              expectedReason = `欄位 ${column}`;
              break;
            }
            case 'constraint': {
              const { table, column, kind, value, code } = scenario.target;
              const rows = data[table];
              let idx = pickIndex(rows, scenario.pos);
              if (kind === 'duplicate') {
                if (idx === 0) idx = rows.length - 1;
                rows[idx][column] = rows[0][column];
              } else {
                rows[idx][column] = kind === 'text' ? `${value}_${marker}` : value;
              }
              relaxed = true;
              expectedCode = EXIT_IMPORT_FAILED;
              expectedTable = table;
              expectedReason = `SQLSTATE ${code}`;
              break;
            }
            case 'countMismatch':
              triggerTable = scenario.table;
              await db.sql`CREATE TRIGGER lm_p35_drop_rows BEFORE INSERT ON ${db.sql(triggerTable)} FOR EACH ROW EXECUTE FUNCTION lm_p35_drop_row()`;
              expectedCode = EXIT_COUNT_MISMATCH;
              expectedTable = scenario.table;
              expectedReason = '筆數不符';
              break;
            default:
              throw new Error('未知情境');
          }

          if (relaxed) buildRelaxedFixture(source, data);
          else buildSqliteFixture(source, data);

          const before = await snapshot(db.sql);
          const countsBefore = await countsOf(db.sql);

          const result = await importSqlite({ sourcePath: source, sql: db.sql, log: l => lines.push(l), err: l => errors.push(l) });

          // 特定的非零結束碼。
          expect(result.exitCode).toBe(expectedCode);

          // 錯誤輸出：資料表名稱與原因類別。
          const errText = errors.join('\n');
          expect(errors.length).toBeGreaterThan(0);
          expect(result.error).toBeString();
          expect(errText).toContain(expectedTable);
          expect(errText).toContain(expectedReason);
          if (scenario.kind !== 'nonEmpty' && scenario.kind !== 'countMismatch') expect(errText).toContain(`資料表 ${expectedTable}`);

          // 所有輸出都不含資料列內容。
          const allOutput = [errText, result.error, ...lines].join('\n');
          expect(allOutput).not.toContain(marker);
          if (badValue) expect(allOutput).not.toContain(badValue);

          // 筆數不符：回報的不符表集合恰為筆數不同的表（Req 13.6）。
          if (scenario.kind === 'countMismatch') {
            const sourceCounts = Object.fromEntries(tableOrder().map(t => [t, data[t].length]));
            const dropped = { ...sourceCounts, [triggerTable]: 0 };
            const expected = compareCounts(sourceCounts, dropped);
            expect(expected.map(x => x.table)).toEqual([triggerTable]);
            expect(result.counts).toEqual(expected);
            expect(errText).toContain(`來源 ${sourceCounts[triggerTable]}，目標 0`);
          }

          // 目標完全不變（所有資料表、遷移紀錄、audit 序列）。
          expect(await countsOf(db.sql)).toEqual(countsBefore);
          expect(await snapshot(db.sql)).toEqual(before);
        } finally {
          if (triggerTable) await db.sql`DROP TRIGGER IF EXISTS lm_p35_drop_rows ON ${db.sql(triggerTable)}`;
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  }, 900_000);
});
