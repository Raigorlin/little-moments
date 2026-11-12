// Feature: jenkins-cicd-deploy, Property 33: SQLite 匯入往返
//
// For any 合成的有效 SQLite 資料集（舊版或 security-harden 版 Schema；每表 0..1,000 列，含 NULL、非 ASCII UTF-8 文字、64 位元整數時間戳記，
// 並滿足外鍵），匯入 PostgreSQL 後再匯出，得到的資料列集合與來源相同：每列主鍵與每個欄位值
// （含 NULL、password_hash 原字串）皆相等。另檢查以原密碼可登入、錯誤密碼不可登入。
//
// **Validates: Requirements 13.1, 13.7, 13.8, 10.9**
import { describe, test, expect, beforeAll } from 'bun:test';
import fc from 'fast-check';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountService, hashPassword } from '../server/accounts.js';
import { importSqlite, EXIT_OK } from '../scripts/import-sqlite.mjs';
import { tableOrder } from '../server/db/import-plan.js';
import { useTestDatabase, resetTables, serviceDb } from './support/pg.js';
import { buildSqliteFixture } from './support/sqlite-fixture.js';
import { sqliteDatasetArb, canonicalTable, LOGIN_USERNAME } from './support/sqlite-data-arb.js';

const BASE = 'http://127.0.0.1:5181';
const PASSWORD = 'roundtrip password ✨ 1';
const db = useTestDatabase();
let loginHash;

beforeAll(async () => { loginHash = await hashPassword(PASSWORD); }); // scrypt 較慢，每檔只算一次

async function exportTable(sql, table) {
  // 資料表名稱來自固定清單（tableOrder），以 identifier 參數傳入。
  return sql`SELECT * FROM ${sql(table)}`;
}

async function login(sql, password) {
  const svc = await createAccountService({ db: serviceDb(sql) });
  try {
    const res = await svc.handle(new Request(`${BASE}/api/login`, {
      method: 'POST',
      headers: { origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ username: LOGIN_USERNAME, password }),
    }));
    return res.status;
  } finally {
    svc.close();
  }
}

async function roundTrip({ data, withLogin }, schema = 'old') {
  await resetTables(db.sql);
  const dir = await mkdtemp(join(tmpdir(), 'lm-roundtrip-'));
  try {
    const source = join(dir, 'accounts.sqlite');
    buildSqliteFixture(source, data, { schema });
    const errors = [];
    const result = await importSqlite({ sourcePath: source, sql: db.sql, err: l => errors.push(l) });
    expect(errors).toEqual([]);
    expect(result.exitCode).toBe(EXIT_OK);

    for (const table of tableOrder()) {
      const exported = await exportTable(db.sql, table);
      expect(canonicalTable(table, exported)).toEqual(canonicalTable(table, data[table]));
      expect(result.counts.find(c => c.table === table)).toEqual({ table, source: data[table].length, target: data[table].length });
    }

    // Req 10.9、13.8：password_hash 原樣保留，原密碼可登入（在資料比對之後執行，登入會新增 session）。
    if (withLogin) {
      expect(await login(db.sql, PASSWORD)).toBe(200);
      expect(await login(db.sql, 'wrong password 1')).toBe(401);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('Property 33: SQLite 匯入往返', () => {
  test('small datasets (≤ 20 rows per table) round-trip exactly', async () => {
    await fc.assert(fc.asyncProperty(sqliteDatasetArb({ maxRows: 20, loginHash, size: 'max' }), roundTrip), { numRuns: 100 });
  }, 600_000);

  test('large datasets (≤ 1,000 rows per table) round-trip exactly', async () => {
    await fc.assert(fc.asyncProperty(sqliteDatasetArb({ maxRows: 1000, textMax: 12, loginHash, size: 'max' }), roundTrip), { numRuns: 20 });
  }, 1_200_000);

  // security-harden 版來源：0002 的資料表（settings、receipt_ai_usage、security_events、security_alerts）
  // 與 invites 的 used_at／used_by／id 也逐欄相等；舊版來源（上方兩個測試）的 0002 欄位匯入為 NULL、資料表為 0 筆。
  test('security-harden datasets (≤ 20 rows per table) round-trip exactly', async () => {
    await fc.assert(fc.asyncProperty(sqliteDatasetArb({ maxRows: 20, loginHash, size: 'max', schema: 'harden' }), d => roundTrip(d, 'harden')), { numRuns: 50 });
  }, 600_000);
});
