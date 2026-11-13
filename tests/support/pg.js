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
//
// Session 逾時與清除（design.md Components §24.3）：
//   測試連線另以同樣的 startup 參數設定 application_name（`lm-test-<schema 的 hex>`）、lock_timeout、
//   statement_timeout 與 idle_in_transaction_session_timeout（testSessionParams）。等鎖的敘述以 55P03 失敗，
//   不會無限期等待；被放棄的交易在閒置 60 秒後由伺服器結束。close() 先關閉連線池，再以管理連線終止
//   同一 application_name 的 backend，最後 DROP SCHEMA，整體以 TEARDOWN_LIMIT_MS 為上限。
//   App_Server 與 Migration_Runner 的連線（server/db/*.js）不設定這些參數。
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

/**
 * 測試連線的 session 逾時（design.md Components §24.3）。statement_timeout 大於 lock_timeout，
 * 等鎖時先得到明確的 55P03（lock_not_available）。不設定 idle_session_timeout：它會結束連線池中閒置的正常連線。
 */
export const TEST_SESSION_TIMEOUTS = Object.freeze({
  lock_timeout: '30s',
  statement_timeout: '60s',
  idle_in_transaction_session_timeout: '60s',
});

/** 測試連線的 application_name：只含 [a-z0-9_-]，不超過 63 位元組（PostgreSQL NAMEDATALEN - 1）。 */
export const TEST_APPLICATION_NAME_PATTERN = /^lm-test-[a-z0-9_-]{1,55}$/;
/** 管理連線（建立／刪除 schema 與 DATABASE、終止測試 backend）的 application_name；不以 `lm-test-` 開頭。 */
export const ADMIN_APPLICATION_NAME = 'lm-admin';

/**
 * close() 的整體上限：不依賴 bun 的 hook 逾時。Bun 1.3.14 時發現：Windows 上 hook 逾時後不一定繼續。
 * Bun 1.4.4 上（任務 28.3，Linux 與 Windows）永不 resolve 的 afterAll 在逾時後即判定失敗並繼續；上限保留以防回歸。
 */
export const TEARDOWN_LIMIT_MS = 20_000;
/** pg_terminate_backend 之後等待 backend 消失的上限與檢查間隔。 */
export const TERMINATE_WAIT_MS = 5_000;
const TERMINATE_POLL_MS = 100;

/**
 * 測試連線池的 startup 參數：search_path、application_name 與 TEST_SESSION_TIMEOUTS。
 * @param {string} schema 符合 TEST_SCHEMA_PATTERN 的 schema 名稱
 * @returns {{search_path:string, application_name:string, lock_timeout:string, statement_timeout:string, idle_in_transaction_session_timeout:string}}
 */
export function testSessionParams(schema) {
  quoteSchemaIdentifier(schema); // 格式檢查；不符即 throw
  return {
    search_path: schema,
    application_name: `lm-test-${schema.slice(2, 2 + 55)}`,
    ...TEST_SESSION_TIMEOUTS,
  };
}

/** 管理連線的 startup 參數：逾時與 ADMIN_APPLICATION_NAME，不設 search_path。 */
export function adminSessionParams() {
  return { application_name: ADMIN_APPLICATION_NAME, ...TEST_SESSION_TIMEOUTS };
}

const DURATION_UNITS_MS = { ms: 1, s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000 };
/** PostgreSQL 時間設定值（`30s`、`1min`、`0`）轉毫秒；無法解析時回傳 NaN。 */
export function durationMs(value) {
  if (value === '0') return 0;
  const m = /^(\d+)(ms|s|min|h|d)$/.exec(String(value));
  return m ? Number(m[1]) * DURATION_UNITS_MS[m[2]] : NaN;
}

/**
 * 以 current_setting（與 SHOW 相同）確認連線實際套用了 startup 參數；不符即 throw。
 * 時間值比較毫秒數（PostgreSQL 會把 `60s` 顯示為 `1min`）。
 */
export async function verifySessionParams(sql, params) {
  const [row] = await sql`SELECT current_setting('application_name') AS application_name,
    current_setting('lock_timeout') AS lock_timeout,
    current_setting('statement_timeout') AS statement_timeout,
    current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout`;
  const mismatched = [];
  if (row.application_name !== params.application_name) mismatched.push('application_name');
  for (const key of Object.keys(TEST_SESSION_TIMEOUTS)) {
    if (durationMs(row[key]) !== durationMs(params[key])) mismatched.push(key);
  }
  if (mismatched.length) throw new Error(`測試連線的 session 參數未套用：${mismatched.join(', ')}`);
}

/**
 * 終止同一資料庫中帶有 applicationName 的 backend（呼叫端自己的 backend 除外）。名稱以參數傳入。
 * @param {Function} admin Bun.SQL 相容的 tagged template（管理連線）
 */
export async function terminateTestSessions(admin, applicationName) {
  if (typeof applicationName !== 'string' || !TEST_APPLICATION_NAME_PATTERN.test(applicationName)) {
    throw new Error('測試連線的 application_name 格式無效');
  }
  return admin`SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
    WHERE application_name = ${applicationName} AND datname = current_database() AND pid <> pg_backend_pid()`;
}

/** 每 TERMINATE_POLL_MS 檢查一次，直到沒有帶 applicationName 的 backend；超過 limitMs 即 throw。 */
async function waitSessionsGone(admin, applicationName, limitMs = TERMINATE_WAIT_MS) {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const [{ n }] = await admin`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE application_name = ${applicationName} AND datname = current_database() AND pid <> pg_backend_pid()`;
    if (n === 0) return;
    if (Date.now() >= deadline) throw new Error(`測試連線未在 ${limitMs} ms 內結束（剩 ${n} 條）`);
    await Bun.sleep(TERMINATE_POLL_MS);
  }
}

/** promise 在 ms 內未完成即以 label 的錯誤 reject（不取消原本的工作）。 */
export async function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超過 ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 等待 promise（例如 Bun.SQL 查詢或會查詢 Database 的服務呼叫）結束，回傳它丟出的錯誤；成功時回傳 null。
 * 用法：`expect(await rejectionOf(sql`…`)).toMatchObject({ errno: '23514' })`。
 *
 * 不要對需要 Database I/O 的 promise 使用 `expect(…).rejects`／`.resolves`。Bun 1.3.14 時發現：在 promise
 * 尚未完成時於 expect 內同步等待，Bun.SQL 的查詢可能一直不被送出，測試逾時後整個程序停止輸出
 * （建置 #8 的 Unit Tests；design.md Components §24、任務 26.1 的調查）。Bun 1.4.4 上（任務 28.3）
 * 以連線池、測試 Database、交易與 reserve() 的查詢直接傳給 expect(…).rejects／.resolves 都會送出並完成；
 * rejectionOf() 與 tests/test-db-session.test.js 的靜態檢查保留以防回歸。
 */
export async function rejectionOf(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

/** 將錯誤訊息中可能出現的密碼遮罩。 */
function redact(text, password) {
  const out = String(text);
  if (!password) return out;
  return [password, encodeURIComponent(password)].reduce((acc, s) => acc.split(s).join('********'), out);
}

/**
 * 以測試設定開啟 Bun.SQL 連線池；`connection` 為 startup 參數（例如 testSessionParams 的結果）。
 * @param {{host:string, port:number, name:string, user:string, password:string, sslmode:string}} database
 */
export function openTestPool(database, connection, { max = 4 } = {}) {
  return new SQL({
    hostname: database.host,
    port: database.port,
    database: database.name,
    username: database.user,
    password: database.password,
    tls: TLS_BY_SSLMODE[database.sslmode] ?? false,
    max,
    connectionTimeout: 10,
    connection: { ...connection },
  });
}

/**
 * 建立一個隔離的測試 schema 並套用所有遷移。
 * @returns {Promise<{sql:object, schema:string, config:object, sessionParams:object, close:()=>Promise<void>}>}
 *   config：`{host, port, name, user, password, sslmode, schema}`，可傳給 createAccountService（task 5.12/5.13）。
 *   sessionParams：testSessionParams(schema)；測試自行建立的連線池（例如經 TCP proxy 的 App 連線池）傳入它，
 *   close() 就會一併終止這些連線。
 */
export async function createTestDatabase({ env = process.env, migrationsDir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const database = readTestDatabaseConfig(env);
  const schema = randomSchemaName();
  const ident = quoteSchemaIdentifier(schema);
  const sessionParams = Object.freeze(testSessionParams(schema));

  // 每條連線的 startup 參數（見檔頭說明）。
  const sql = openTestPool(database, sessionParams);

  let created = false;
  // 關閉連線池 → 終止同名 backend → 等它們消失 → DROP SCHEMA → 關閉管理連線（design.md Components §24.3）。
  const teardown = async () => {
    const errors = [];
    try { await sql.close({ timeout: 5 }); } catch (e) { errors.push(e); }
    const admin = adminSql(database);
    try {
      await terminateTestSessions(admin, sessionParams.application_name);
      await waitSessionsGone(admin, sessionParams.application_name);
      // 唯一允許的 unsafe：通過 TEST_SCHEMA_PATTERN 檢查的 schema identifier。
      if (created) await admin.unsafe(`DROP SCHEMA IF EXISTS ${ident} CASCADE`);
    } catch (e) {
      errors.push(e);
    } finally {
      try { await admin.close({ timeout: 5 }); } catch (e) { errors.push(e); }
    }
    if (errors.length) throw new Error(`測試 Database 清除失敗：${redact(errors[0]?.message ?? errors[0], database.password)}`);
  };
  const boundedTeardown = () => withDeadline(teardown(), TEARDOWN_LIMIT_MS, '測試 Database 清除');

  try {
    // 唯一允許的 unsafe：通過 TEST_SCHEMA_PATTERN 檢查的 schema identifier。
    await sql.unsafe(`CREATE SCHEMA ${ident}`);
    created = true;

    const [{ current }] = await sql`SELECT current_schema() AS current`;
    if (current !== schema) throw new Error('search_path 未套用至測試連線（current_schema 與測試 schema 不同）');
    await verifySessionParams(sql, sessionParams);

    const repo = loadMigrations(await readMigrationFiles(migrationsDir));
    const result = await runMigrations(sql, repo, { log });
    if (result.exitCode !== 0) throw new Error(`測試 schema 遷移失敗（結束碼 ${result.exitCode}）：${result.error ?? ''}`);
  } catch (err) {
    const message = redact(err?.message ?? err, database.password);
    try { await boundedTeardown(); } catch { /* 保留原始錯誤 */ }
    throw new Error(`無法建立測試 Database ${database.host}:${database.port}：${message}`);
  }

  let closing = null;
  return {
    sql,
    schema,
    config: { ...database, schema },
    sessionParams,
    close() {
      closing ??= boundedTeardown();
      return closing;
    },
  };
}

/**
 * 以管理連線列出帶有 applicationName 的 backend 與資料庫中所有 advisory lock（測試的 teardown 斷言用）。
 * @returns {Promise<{pids:number[], advisoryLocks:{pid:number, objid:number, granted:boolean}[]}>}
 */
export async function inspectTestSessions(applicationName, { env = process.env } = {}) {
  const admin = adminSql(readTestDatabaseConfig(env));
  try {
    const backends = await admin`SELECT pid FROM pg_stat_activity
      WHERE application_name = ${applicationName} AND datname = current_database() AND pid <> pg_backend_pid()`;
    const locks = await admin`SELECT pid, objid::int AS objid, granted FROM pg_locks
      WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
    return { pids: backends.map(r => r.pid), advisoryLocks: [...locks].map(r => ({ ...r })) };
  } finally {
    await admin.close({ timeout: 5 });
  }
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
    // 逾時參數與 ADMIN_APPLICATION_NAME；不設 search_path（design.md Components §24.3）。
    connection: adminSessionParams(),
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
export const APP_TABLES = Object.freeze([
  'users', 'sessions', 'trips', 'trip_members', 'invites', 'trip_deletions', 'audit', 'trip_ledgers',
  // migrations/0002_security_harden.sql
  'settings', 'receipt_ai_usage', 'security_events', 'security_alerts',
]);

/**
 * 清空測試 schema 中的所有應用程式資料表並重設 identity（audit、security_events、security_alerts.seq；
 * 保留 Schema 與遷移紀錄）。
 * 供每個測試或每次 fast-check 執行之間快速取得「全新、無資料列」的 Database（Req 4.2）。
 * 固定語句、無插值；資料表依 search_path 解析到該測試檔自己的 `t_<random>` schema。
 */
export async function resetTables(sql) {
  await sql`TRUNCATE users, sessions, trips, trip_members, invites, trip_deletions, audit, trip_ledgers,
    settings, receipt_ai_usage, security_events, security_alerts RESTART IDENTITY CASCADE`;
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
 * @returns {{readonly sql:object, readonly schema:string, readonly config:object, readonly sessionParams:object}} 於 beforeAll 之後可用。
 */
export function useTestDatabase(options = {}) {
  readTestDatabaseConfig(options.env ?? process.env);
  let db = null;
  beforeAll(async () => { db = await createTestDatabase(options); }, 60_000);
  // close() 自己以 TEARDOWN_LIMIT_MS 為上限，早於 hook 的 30 秒逾時失敗。
  afterAll(async () => { if (db) await db.close(); }, 30_000);
  const get = key => {
    if (!db) throw new Error('測試 Database 尚未建立（只能在 beforeAll 之後使用）');
    return db[key];
  };
  return {
    get sql() { return get('sql'); },
    get schema() { return get('schema'); },
    get config() { return get('config'); },
    get sessionParams() { return get('sessionParams'); },
  };
}

// ---------------------------------------------------------------------------
// security-harden 測試移植用輔助（task 18.4）。
//
// 原本的 SQLite 測試以「複製種子資料庫檔」讓每個測試從相同資料開始，並以 bun:sqlite 的
// `db.query(sql).all(...params)` 直接讀寫資料列。以下函式在測試 schema 內提供相同的能力。

/** Bun.SQL 以字串回傳 BIGINT 與 COUNT(*)；這些欄位名稱的值轉成 number（測試只用安全整數）。 */
const TEST_INT_COLUMNS = new Set([
  'n', 'at', 'created_at', 'deleted_at', 'expires_at', 'joined_at', 'revoked_at', 'updated_at', 'used_at',
  'revision', 'people_count', 'trip_count', 'prompt_tokens', 'completion_tokens', 'count', 'window_start', 'window_end', 'acknowledged_at',
]);
const numericRow = row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, TEST_INT_COLUMNS.has(k) && v !== null && v !== undefined ? Number(v) : v]));

/**
 * 以 `?` 佔位符執行測試查詢（SQLite 測試語法），值一律以參數綁定；回傳資料列陣列（整數欄位轉 number）。
 * 只供測試使用：查詢文字是測試程式中的固定字串，不含外部輸入；值不會被插入 SQL 文字。
 */
export async function testQuery(sql, text, ...params) {
  if (typeof text !== 'string') throw new TypeError('testQuery 需要 SQL 文字');
  let index = 0;
  const converted = text.replace(/\?/g, () => `$${++index}`);
  if (index !== params.length) throw new Error(`testQuery 參數數量不符（佔位符 ${index}、參數 ${params.length}）`);
  // 唯一允許的 unsafe（測試）：固定的查詢文字，值以 $n 參數綁定。
  const rows = await sql.unsafe(converted, params);
  return Array.from(rows, numericRow);
}

/** 快照名稱的唯一允許格式；identifier 由此組成。 */
const SNAPSHOT_TAG = /^[a-z][a-z0-9_]{0,15}$/;

/** 將目前所有應用程式資料表複製到 `snap_<tag>_<table>`（同一測試 schema 內）。 */
export async function saveSnapshot(sql, tag) {
  if (!SNAPSHOT_TAG.test(tag)) throw new Error('快照名稱格式無效');
  for (const table of APP_TABLES) {
    const copy = `snap_${tag}_${table}`;
    await sql`DROP TABLE IF EXISTS ${sql(copy)}`;
    await sql`CREATE TABLE ${sql(copy)} AS SELECT * FROM ${sql(table)}`;
  }
}

/**
 * 清空應用程式資料表後還原 saveSnapshot 的內容（含原 id），並把 identity 設在最大值之後，
 * 等同原測試「複製種子資料庫檔」。
 */
export async function restoreSnapshot(sql, tag) {
  if (!SNAPSHOT_TAG.test(tag)) throw new Error('快照名稱格式無效');
  await resetTables(sql);
  for (const table of APP_TABLES) {
    await sql`INSERT INTO ${sql(table)} OVERRIDING SYSTEM VALUE SELECT * FROM ${sql(`snap_${tag}_${table}`)}`;
  }
  for (const [table, column] of [['audit', 'id'], ['security_events', 'id'], ['security_alerts', 'seq']]) {
    await sql`SELECT setval(pg_get_serial_sequence(${table}, ${column}), GREATEST(COALESCE(max(${sql(column)}), 0), 1), max(${sql(column)}) IS NOT NULL) FROM ${sql(table)}`;
  }
}
