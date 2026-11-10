// 測試用 Ephemeral_Database 輔助模組（Requirement 4.1、4.2、4.3、4.8；design.md Components §7）。
//
// 連線設定只來自 CAMPING_TEST_DATABASE_*（Req 4.1、4.3）：測試不讀取 CAMPING_DATABASE_*，
// 因此不會意外連到 Staging／Production 的 Database。
//
//   CAMPING_TEST_DATABASE_HOST      必填
//   CAMPING_TEST_DATABASE_PORT      選填，預設 5432
//   CAMPING_TEST_DATABASE_NAME      必填
//   CAMPING_TEST_DATABASE_USER      必填
//   CAMPING_TEST_DATABASE_PASSWORD  必填
//   CAMPING_TEST_DATABASE_SSLMODE   選填，disable | require | verify-full，預設 disable
//
// 未設定時明確失敗並列出變數名（不靜默略過），錯誤訊息絕不包含密碼。
//
// 隔離方式：每個測試檔建立自己的 `t_<random>` schema，執行全部遷移，結束時 DROP SCHEMA … CASCADE。
// 同一 Ephemeral_Database 內以 schema 隔離測試檔；不同建置使用不同的資料庫容器（Req 4.8）。
//
// search_path 的設定方式（設計決策）：
//   以 Bun.SQL 的 `connection: { search_path }` 啟動參數設定。PostgreSQL 的 startup packet
//   接受任意執行期參數，因此連線池中「每一條」連線（含 runMigrations 的 reserve() 連線與
//   sql.begin 交易連線）開啟時都會套用同一個 search_path。不採用 `max: 1`，因為 reserve()
//   或交易占用唯一連線時，其他查詢會互相等待而死結，也無法測試並行行為（Property 20）。
//   為避免 Bun 版本日後忽略此參數而讓測試靜默寫入 public schema，建立後立即以
//   `SELECT current_schema()` 驗證，不符即失敗。
import { afterAll, beforeAll } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SQL } from 'bun';
import { DATABASE_SSLMODES, DEFAULT_DATABASE_PORT, DEFAULT_DATABASE_SSLMODE } from '../../server/config.js';
import { loadMigrations, runMigrations } from '../../server/db/migrations.js';
import { readMigrationFiles } from '../../scripts/migrate.mjs';
import { pingSql } from '../../server/db/connect.js';

export const TEST_DATABASE_ENV_PREFIX = 'CAMPING_TEST_DATABASE_';
export const REQUIRED_TEST_DATABASE_VARS = Object.freeze([
  'CAMPING_TEST_DATABASE_HOST',
  'CAMPING_TEST_DATABASE_NAME',
  'CAMPING_TEST_DATABASE_USER',
  'CAMPING_TEST_DATABASE_PASSWORD',
]);
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** 測試 schema 名稱的唯一允許格式；identifier 插值前必須通過此檢查。 */
export const TEST_SCHEMA_PATTERN = /^t_[a-z0-9_]{1,60}$/;

const TLS_BY_SSLMODE = { disable: false, require: { rejectUnauthorized: false }, 'verify-full': true };

export class TestDatabaseConfigError extends Error {
  constructor(message, names) {
    super(message);
    this.name = 'TestDatabaseConfigError';
    this.variables = names;
  }
}

const isUnset = value => value === undefined || value === null || value === '';

/**
 * 讀取並驗證 CAMPING_TEST_DATABASE_*。
 * @returns {{host:string, port:number, name:string, user:string, password:string, sslmode:string}}
 *   與 server/config.js 的 `config.database` 相同形狀。
 * @throws {TestDatabaseConfigError} 訊息只含變數名與原因，不含任何值。
 */
export function readTestDatabaseConfig(env = process.env) {
  const problems = [];
  const missing = REQUIRED_TEST_DATABASE_VARS.filter(name => isUnset(env[name]));
  if (missing.length) problems.push({ names: missing, text: `未設定：${missing.join(', ')}` });

  let port = DEFAULT_DATABASE_PORT;
  const portRaw = env.CAMPING_TEST_DATABASE_PORT;
  if (!isUnset(portRaw)) {
    const n = /^\d+$/.test(portRaw) ? Number(portRaw) : NaN;
    if (!(n >= 1 && n <= 65535)) problems.push({ names: ['CAMPING_TEST_DATABASE_PORT'], text: 'CAMPING_TEST_DATABASE_PORT 必須是 1 至 65535 的整數' });
    else port = n;
  }

  let sslmode = DEFAULT_DATABASE_SSLMODE;
  const sslRaw = env.CAMPING_TEST_DATABASE_SSLMODE;
  if (!isUnset(sslRaw)) {
    if (!DATABASE_SSLMODES.includes(sslRaw)) problems.push({ names: ['CAMPING_TEST_DATABASE_SSLMODE'], text: `CAMPING_TEST_DATABASE_SSLMODE 必須是 ${DATABASE_SSLMODES.join('、')} 其中之一` });
    else sslmode = sslRaw;
  }

  if (problems.length) {
    const names = problems.flatMap(p => p.names);
    throw new TestDatabaseConfigError(
      `需要 PostgreSQL Ephemeral_Database 的測試無法執行（${problems.map(p => p.text).join('；')}）。請參考 README 建立 Ephemeral_Database 並設定 CAMPING_TEST_DATABASE_*。`,
      names,
    );
  }
  return {
    host: env.CAMPING_TEST_DATABASE_HOST,
    port,
    name: env.CAMPING_TEST_DATABASE_NAME,
    user: env.CAMPING_TEST_DATABASE_USER,
    password: env.CAMPING_TEST_DATABASE_PASSWORD,
    sslmode,
  };
}

/** 產生 `t_<32 hex>` schema 名稱（只含 [a-z0-9_]）。 */
export function randomSchemaName(bytes = randomBytes) {
  return `t_${bytes(16).toString('hex')}`;
}

/**
 * 將測試 schema 名稱轉為帶引號的 SQL identifier。
 * 這是測試輔助中唯一需要 identifier 插值的地方（DDL 的 schema 名稱無法以參數傳遞）：
 * 名稱必須完全符合 TEST_SCHEMA_PATTERN（僅小寫英數與底線、`t_` 開頭），否則 throw，
 * 通過後才以雙引號包裹並交給 `unsafe()`。名稱不含任何外部輸入。
 */
export function quoteSchemaIdentifier(schema) {
  if (typeof schema !== 'string' || !TEST_SCHEMA_PATTERN.test(schema)) {
    throw new Error('測試 schema 名稱格式無效');
  }
  return `"${schema}"`;
}

/** 將錯誤訊息中可能出現的密碼遮罩。 */
function redact(text, password) {
  const out = String(text);
  if (!password) return out;
  return [password, encodeURIComponent(password)].reduce((acc, s) => acc.split(s).join('********'), out);
}

/**
 * 建立一個隔離的測試 schema 並套用所有遷移。
 * @returns {Promise<{sql:object, schema:string, config:object, close:()=>Promise<void>}>}
 *   config：`{host, port, name, user, password, sslmode, schema}`，可傳給 createAccountService（task 5.12/5.13）。
 */
export async function createTestDatabase({ env = process.env, migrationsDir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const database = readTestDatabaseConfig(env);
  const schema = randomSchemaName();
  const ident = quoteSchemaIdentifier(schema);

  const sql = new SQL({
    hostname: database.host,
    port: database.port,
    database: database.name,
    username: database.user,
    password: database.password,
    tls: TLS_BY_SSLMODE[database.sslmode] ?? false,
    max: 4,
    connectionTimeout: 10,
    // 每條連線的 startup 參數（見檔頭說明）。
    connection: { search_path: schema },
  });

  let created = false;
  const dropAndClose = async () => {
    try {
      // 唯一允許的 unsafe：通過 TEST_SCHEMA_PATTERN 檢查的 schema identifier。
      if (created) await sql.unsafe(`DROP SCHEMA IF EXISTS ${ident} CASCADE`);
    } finally {
      await sql.close({ timeout: 5 });
    }
  };

  try {
    // 唯一允許的 unsafe：通過 TEST_SCHEMA_PATTERN 檢查的 schema identifier。
    await sql.unsafe(`CREATE SCHEMA ${ident}`);
    created = true;

    const [{ current }] = await sql`SELECT current_schema() AS current`;
    if (current !== schema) throw new Error('search_path 未套用至測試連線（current_schema 與測試 schema 不同）');

    const repo = loadMigrations(await readMigrationFiles(migrationsDir));
    const result = await runMigrations(sql, repo, { log });
    if (result.exitCode !== 0) throw new Error(`測試 schema 遷移失敗（結束碼 ${result.exitCode}）：${result.error ?? ''}`);
  } catch (err) {
    const message = redact(err?.message ?? err, database.password);
    try { await dropAndClose(); } catch { /* 保留原始錯誤 */ }
    throw new Error(`無法建立測試 Database ${database.host}:${database.port}：${message}`);
  }

  let closed = false;
  return {
    sql,
    schema,
    config: { ...database, schema },
    async close() {
      if (closed) return;
      closed = true;
      await dropAndClose();
    },
  };
}

/**
 * 瀏覽器測試用拋棄式 DATABASE（scripts/check-accounts.mjs 經 tests/support/e2e-db.mjs 使用）。
 * App_Server 沒有設定 search_path 的環境變數，因此 E2E 改用獨立 DATABASE 隔離，
 * serve.mjs／migrate.mjs 只需既有的 CAMPING_DATABASE_*。管理連線帳號需要 CREATEDB 權限。
 */
export const E2E_DATABASE_PATTERN = /^lm_e2e_[0-9a-f]{16}$/;

export function randomE2eDatabaseName(bytes = randomBytes) {
  return `lm_e2e_${bytes(8).toString('hex')}`;
}

/** 與 quoteSchemaIdentifier 相同的規則：名稱必須完全符合 E2E_DATABASE_PATTERN 才能插值。 */
export function quoteE2eDatabaseIdentifier(name) {
  if (typeof name !== 'string' || !E2E_DATABASE_PATTERN.test(name)) {
    throw new Error('E2E 資料庫名稱格式無效');
  }
  return `"${name}"`;
}

function adminSql(database) {
  return new SQL({
    hostname: database.host,
    port: database.port,
    database: database.name,
    username: database.user,
    password: database.password,
    tls: TLS_BY_SSLMODE[database.sslmode] ?? false,
    max: 1,
    connectionTimeout: 10,
  });
}

/** 建立空的 E2E DATABASE（不套用遷移；由呼叫端以 scripts/migrate.mjs 套用）。回傳名稱。 */
export async function createE2eDatabase({ env = process.env } = {}) {
  const database = readTestDatabaseConfig(env);
  const name = randomE2eDatabaseName();
  const sql = adminSql(database);
  try {
    // 唯一允許的 unsafe：通過 E2E_DATABASE_PATTERN 檢查的 identifier（DDL 無法以參數傳遞名稱）。
    await sql.unsafe(`CREATE DATABASE ${quoteE2eDatabaseIdentifier(name)}`);
    return name;
  } finally {
    await sql.close({ timeout: 5 });
  }
}

/** 刪除 E2E DATABASE（含仍連線中的 session；PostgreSQL 13+ 的 WITH (FORCE)）。不存在時視為成功。 */
export async function dropE2eDatabase(name, { env = process.env } = {}) {
  const ident = quoteE2eDatabaseIdentifier(name);
  const database = readTestDatabaseConfig(env);
  const sql = adminSql(database);
  try {
    // 唯一允許的 unsafe：通過 E2E_DATABASE_PATTERN 檢查的 identifier。
    await sql.unsafe(`DROP DATABASE IF EXISTS ${ident} WITH (FORCE)`);
  } finally {
    await sql.close({ timeout: 5 });
  }
}

/** App_Server 定義的所有資料表（不含 schema_migrations）；resetTables 清空這些表。 */
export const APP_TABLES = Object.freeze(['users', 'sessions', 'trips', 'trip_members', 'invites', 'trip_deletions', 'audit', 'trip_ledgers']);

/**
 * 清空測試 schema 中的所有應用程式資料表並重設 audit identity（保留 Schema 與遷移紀錄）。
 * 供每個測試或每次 fast-check 執行之間快速取得「全新、無資料列」的 Database（Req 4.2）。
 * 固定語句、無插值；資料表依 search_path 解析到該測試檔自己的 `t_<random>` schema。
 */
export async function resetTables(sql) {
  await sql`TRUNCATE users, sessions, trips, trip_members, invites, trip_deletions, audit, trip_ledgers RESTART IDENTITY CASCADE`;
}

/**
 * 將測試連線池包裝成 createAccountService 需要的 `db` 形狀。
 * close 為 no-op：連線池由 useTestDatabase 的 afterAll 關閉。
 */
export function serviceDb(sql) {
  return { sql, ping: ms => pingSql(sql, ms), close: async () => {} };
}

/**
 * 為目前的 bun:test 檔案註冊 beforeAll／afterAll。
 * 設定在註冊時同步驗證：未設定 CAMPING_TEST_DATABASE_* 時，測試檔載入即失敗並列出變數名。
 * @returns {{readonly sql:object, readonly schema:string, readonly config:object}} 於 beforeAll 之後可用。
 */
export function useTestDatabase(options = {}) {
  readTestDatabaseConfig(options.env ?? process.env);
  let db = null;
  beforeAll(async () => { db = await createTestDatabase(options); }, 60_000);
  afterAll(async () => { if (db) await db.close(); }, 30_000);
  const get = key => {
    if (!db) throw new Error('測試 Database 尚未建立（只能在 beforeAll 之後使用）');
    return db[key];
  };
  return {
    get sql() { return get('sql'); },
    get schema() { return get('schema'); },
    get config() { return get('config'); },
  };
}
