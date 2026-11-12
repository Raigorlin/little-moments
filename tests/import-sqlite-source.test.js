// Feature: jenkins-cicd-deploy, Property 34: 匯入不改變來源
//
// *For any* 合成來源 SQLite 檔（含或不含 WAL 檔），執行 SQLite_Importer 後來源檔與其 `-wal` 的 SHA-256 不變，
// 且來源目錄的檔案清單不變。
//
// 本測試另外涵蓋：`-shm`（若存在）位元組不變、來源目錄每個檔案的大小與 mtime 不變（不產生 journal／-shm 等新檔），
// 無效來源（亂數位元組、錯誤標頭、缺少資料表）與匯入失敗（目標非空、資料列無法轉換）時同樣成立，
// 且匯入器的暫存複本目錄在結束後被刪除（每次執行使用專屬的 tmpRoot，結束後必須為空）。
//
// **Validates: Requirements 13.2**
import { describe, test, expect, beforeEach } from 'bun:test';
import fc from 'fast-check';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { importSqlite, EXIT_OK, EXIT_SOURCE_INVALID, EXIT_TARGET_NOT_EMPTY, EXIT_IMPORT_FAILED } from '../scripts/import-sqlite.mjs';
import { tableOrder, isOptionalTable } from '../server/db/import-plan.js';
import { useTestDatabase, resetTables } from './support/pg.js';
import { buildSqliteFixture } from './support/sqlite-fixture.js';

const db = useTestDatabase();
beforeEach(async () => { await resetTables(db.sql); });

const SIDE = ['', '-wal', '-shm'];
const T0 = 1_762_000_000_000;

/** 來源目錄快照：每個檔案的名稱、大小、mtime 與 SHA-256（含 -wal、-shm）。 */
async function snapshotDir(dir) {
  const out = {};
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const info = await stat(path);
    out[name] = {
      size: info.size,
      mtimeMs: info.mtimeMs,
      sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
    };
  }
  return out;
}

// ---- 產生器 ---------------------------------------------------------------

const text = fc.string({ unit: 'grapheme', maxLength: 12 });
const ts = fc.oneof(fc.integer({ min: 0, max: 2 ** 41 }), fc.constant(9_007_199_254_740_993n));

/** 滿足外鍵的小型資料集；badRow 時 trips.revision 超出 int4，使匯入在寫入階段失敗並回復。 */
const datasetArb = fc.record({
  users: fc.array(fc.record({ display_name: text, role: fc.constantFrom('admin', 'member'), password_hash: text, created_at: ts, deleted: fc.boolean() }), { maxLength: 3 }),
  trips: fc.array(fc.record({ title: text, note: text, revision: fc.integer({ min: 0, max: 1000 }), state_json: text }), { maxLength: 2 }),
  audit: fc.uniqueArray(fc.integer({ min: 1, max: 1_000_000 }), { maxLength: 3 }),
  sessions: fc.nat({ max: 2 }),
  badRow: fc.boolean(),
}).map(spec => {
  const users = spec.users.map((u, i) => ({
    id: `u${i}`, username: `user${i}`, display_name: u.display_name, role: u.role, password_hash: u.password_hash,
    created_at: u.created_at, deleted_at: u.deleted ? T0 : null,
  }));
  const trips = users.length === 0 ? [] : spec.trips.map((t, i) => ({
    id: `tr${i}`, owner_id: 'u0', title: t.title, destination: 'd', start_date: '2026-11-20', end_date: '2026-11-22',
    description: '', note: t.note, cover_kind: 'camp', status: 'planning', revision: t.revision, people_count: 1,
    state_json: t.state_json, created_at: T0, updated_at: T0,
  }));
  const badRow = spec.badRow && trips.length > 0;
  if (badRow) trips[0].revision = 2 ** 31;
  return {
    badRow,
    data: {
      users,
      sessions: users.length === 0 ? [] : Array.from({ length: spec.sessions }, (_, i) => ({ token_hash: `s${i}`.padEnd(64, '0'), user_id: 'u0', created_at: T0, expires_at: T0 + 1 })),
      trips,
      trip_members: trips.map(t => ({ trip_id: t.id, user_id: 'u0', person_id: `p-${t.id}`, joined_at: T0 })),
      invites: [],
      trip_deletions: [],
      audit: spec.audit.map(id => ({ id, at: T0, actor: 'u0', action: 'a', target: 't' })),
      trip_ledgers: trips.map(t => ({ trip_id: t.id, revision: 1, ledger_json: '{}', requests_json: '[]', updated_by: 'u0', updated_at: T0 })),
    },
  };
});

const scenarioArb = fc.record({
  kind: fc.constantFrom('valid', 'valid-wal-open', 'garbage', 'wrong-header', 'missing-table'),
  dataset: datasetArb,
  garbage: fc.uint8Array({ minLength: 0, maxLength: 2048 }),
  dropTable: fc.constantFrom(...tableOrder()),
  targetNonEmpty: fc.boolean(),
  // 來源版本：security-harden 之前（old）或 security-harden 版（harden，含 0002 的資料表與欄位）。
  schema: fc.constantFrom('old', 'harden'),
});

/** 依情境建立來源；回傳來源路徑與需要在結束時關閉的連線（WAL 未 checkpoint）。 */
async function buildSource(dir, s) {
  const source = join(dir, 'accounts.sqlite');
  switch (s.kind) {
    case 'valid':
      buildSqliteFixture(source, s.dataset.data, { schema: s.schema });
      return { source, live: null };
    case 'valid-wal-open':
      return { source, live: buildSqliteFixture(source, s.dataset.data, { wal: true, keepOpen: true, schema: s.schema }) };
    case 'garbage':
      await writeFile(source, s.garbage);
      return { source, live: null };
    case 'wrong-header': {
      buildSqliteFixture(source, s.dataset.data, { schema: s.schema });
      const bytes = await readFile(source);
      bytes.write('SQLite format 4', 0, 'latin1');
      await writeFile(source, bytes);
      return { source, live: null };
    }
    case 'missing-table': {
      buildSqliteFixture(source, s.dataset.data, { schema: s.schema });
      const d = new Database(source); // foreign_keys 預設關閉，DROP 父表不會連帶刪除
      d.exec(`DROP TABLE IF EXISTS "${s.dropTable}"`); // 名稱來自固定清單；舊版來源沒有 0002 的資料表
      d.close();
      return { source, live: null };
    }
    default:
      throw new Error(`unknown kind ${s.kind}`);
  }
}

function expectedExit(s) {
  if (s.kind === 'garbage' || s.kind === 'wrong-header') return EXIT_SOURCE_INVALID;
  // 0002 新增的資料表可以不存在（舊版來源），只有缺少必要資料表才拒絕（Req 13.9）。
  if (s.kind === 'missing-table' && !isOptionalTable(s.dropTable)) return EXIT_SOURCE_INVALID;
  if (s.targetNonEmpty) return EXIT_TARGET_NOT_EMPTY;
  if (s.dataset.badRow) return EXIT_IMPORT_FAILED;
  return EXIT_OK;
}

describe('Property 34: 匯入不改變來源', () => {
  test('source file, -wal, -shm and source directory are unchanged and the tmp copy is removed', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async s => {
        const work = await mkdtemp(join(tmpdir(), 'lm-p34-'));
        const srcDir = join(work, 'src');
        const tmpRoot = join(work, 'tmp');
        await Promise.all([mkdir(srcDir), mkdir(tmpRoot)]);
        let live = null;
        try {
          await resetTables(db.sql);
          if (s.targetNonEmpty) {
            await db.sql`INSERT INTO users (id, username, display_name, role, password_hash, created_at) VALUES ('pre', 'pre', 'pre', 'member', 'h', 1)`;
          }
          const built = await buildSource(srcDir, s);
          live = built.live;
          if (s.kind === 'valid-wal-open') {
            // 前置條件：來源確實含未 checkpoint 的 -wal 與 -shm。
            expect((await stat(built.source + '-wal')).size).toBeGreaterThan(0);
            expect((await readdir(srcDir)).sort()).toEqual(SIDE.map(x => 'accounts.sqlite' + x).sort());
          }

          const before = await snapshotDir(srcDir);
          const result = await importSqlite({ sourcePath: built.source, sql: db.sql, tmpRoot });
          const after = await snapshotDir(srcDir);

          expect(after).toEqual(before);           // 名稱、大小、mtime、SHA-256（含 -wal、-shm）
          expect(await readdir(tmpRoot)).toEqual([]); // 暫存複本目錄已刪除
          expect(result.exitCode).toBe(expectedExit(s));
        } finally {
          try { live?.close(); } catch { /* ignore */ }
          await rm(work, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  }, 600_000);
});
