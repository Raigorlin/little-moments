// Feature: jenkins-cicd-deploy, Property 29: 遷移失敗隔離
//
// **Validates: Requirements 12.4**
//
// For any 遷移序列與其中隨機一個會失敗的遷移 m，執行後 m 之前的遷移與紀錄皆存在，
// m 及之後的遷移的 Schema 變更與紀錄皆不存在，結束碼非零且輸出 m 的版本號。
//
// 每次迭代使用全新的隔離 schema（tests/support/pg.js 的 createTestDatabase，搭配空的
// migrationsDir，使 schema 內不含 repository 遷移），結束時 DROP SCHEMA。
// 需要 CAMPING_TEST_DATABASE_*；未設定時 createTestDatabase 會明確失敗。
import { afterAll, beforeAll, expect, test } from 'bun:test';
import fc from 'fast-check';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT_FAILED, loadMigrations, runMigrations } from '../server/db/migrations.js';
import { createTestDatabase, readTestDatabaseConfig } from './support/pg.js';

// 載入時即驗證設定，未設定 CAMPING_TEST_DATABASE_* 時明確失敗（不靜默略過）。
readTestDatabaseConfig();

let emptyDir;
beforeAll(async () => { emptyDir = await mkdtemp(join(tmpdir(), 'lm-mig-empty-')); });
afterAll(async () => { if (emptyDir) await rm(emptyDir, { recursive: true, force: true }); });

const FAILURE_MODES = ['syntax', 'constraint', 'division', 'missing_table'];

/** 遷移 v：建立 m_<v> 並插入 rows 筆資料；fail 時於最後執行會失敗的語句。 */
function migrationSql(version, rows, failMode) {
  const table = `m_${version}`;
  const lines = [`-- generated migration ${version}`, `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, v TEXT NOT NULL);`];
  for (let i = 1; i <= rows; i++) lines.push(`INSERT INTO ${table} (id, v) VALUES (${i}, 'row ${i}');`);
  switch (failMode) {
    case 'syntax': lines.push('CREAT TABLE broken (id INTEGER);'); break;
    case 'constraint': lines.push(`INSERT INTO ${table} (id, v) VALUES (500, 'dup'), (500, 'dup');`); break;
    case 'division': lines.push(`INSERT INTO ${table} (id, v) VALUES (1000, (1 / 0)::text);`); break;
    case 'missing_table': lines.push('INSERT INTO table_that_does_not_exist (id) VALUES (1);'); break;
    default: break;
  }
  return lines.join('\n') + '\n';
}

const scenarioArb = fc
  .uniqueArray(fc.integer({ min: 1, max: 99999 }), { minLength: 1, maxLength: 5 })
  .chain(versions => {
    const sorted = [...versions].sort((a, b) => a - b);
    return fc.record({
      versions: fc.constant(sorted),
      rows: fc.array(fc.integer({ min: 0, max: 3 }), { minLength: sorted.length, maxLength: sorted.length }),
      failIndex: fc.integer({ min: 0, max: sorted.length - 1 }),
      failMode: fc.constantFrom(...FAILURE_MODES),
      // 以打亂順序提供檔案，確認依版本遞增執行與檔案順序無關
      shuffleSeed: fc.integer(),
    });
  });

function shuffled(list, seed) {
  const out = [...list];
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

test('Property 29: 遷移失敗隔離', async () => {
  await fc.assert(
    fc.asyncProperty(scenarioArb, async ({ versions, rows, failIndex, failMode, shuffleSeed }) => {
      const failVersion = versions[failIndex];
      const files = versions.map((v, i) => ({
        name: `${String(v).padStart(5, '0')}_gen_${v}.sql`,
        content: migrationSql(v, rows[i], i === failIndex ? failMode : null),
      }));
      const repo = loadMigrations(shuffled(files, shuffleSeed));

      const db = await createTestDatabase({ migrationsDir: emptyDir });
      try {
        const { sql, schema } = db;
        const logs = [];
        const result = await runMigrations(sql, repo, { log: line => logs.push(line) });

        // 結束碼非零（EXIT_FAILED）且回報失敗版本
        expect(result.exitCode).toBe(EXIT_FAILED);
        expect(result.failedVersion).toBe(failVersion);
        expect(result.applied).toEqual(versions.slice(0, failIndex));
        expect(result.count).toBe(failIndex);
        expect(logs.some(line => line.includes(String(failVersion)))).toBe(true);
        expect(result.error).toContain(String(failVersion));

        // 版本紀錄：恰為 m 之前的版本
        const recorded = await sql`SELECT version FROM schema_migrations ORDER BY version`;
        expect(recorded.map(r => Number(r.version))).toEqual(versions.slice(0, failIndex));

        // Schema：m 之前的資料表與資料存在；m 及之後的資料表不存在
        const tables = await sql`SELECT table_name FROM information_schema.tables
                                 WHERE table_schema = ${schema} AND table_name LIKE 'm\\_%'`;
        const tableNames = new Set(tables.map(t => t.table_name));
        const expectedTables = versions.slice(0, failIndex).map(v => `m_${v}`);
        expect([...tableNames].sort()).toEqual([...expectedTables].sort());

        for (let i = 0; i < failIndex; i++) {
          const v = versions[i];
          const [{ n }] = await sql`SELECT count(*)::int AS n FROM ${sql(`m_${v}`)}`;
          expect(n).toBe(rows[i]);
        }
      } finally {
        await db.close();
      }
    }),
    { numRuns: 100 },
  );
}, 600_000);
