// Migration_Runner 核心（Requirement 12.1、12.2、12.3、12.4、12.7；design.md Components §5）。
//
// loadMigrations / planMigrations 為純函式（不讀檔、不連網），供 property-based test 使用。
// runMigrations 只依賴傳入的 Bun.SQL 相容 executor，回傳結果物件（含 exitCode），不呼叫 process.exit。
//
// 安全說明（Semgrep `sql.unsafe` 規則的唯一例外）：
//   本檔是整個專案唯一允許呼叫 `.unsafe()` 的位置。`.unsafe()` 只用來執行 repository
//   `migrations/` 目錄內、受版本控制且經 code review 的遷移檔原文，內容不含任何使用者輸入；
//   寫入 schema_migrations 等其餘查詢一律使用 tagged template 參數化。
//   Semgrep 自訂規則應以路徑排除 `server/db/migrations.js`，其他檔案仍禁止 `sql.unsafe`。
import { createHash } from 'node:crypto';

/** Session 級 advisory lock key：避免 blue/green 或兩次部署同時遷移。 */
export const MIGRATION_LOCK_KEY = 726362;
export const MIGRATION_FILE_PATTERN = /^(\d{4,})_[a-z0-9_]+\.sql$/;
export const DESTRUCTIVE_MARKER = '-- lm:destructive';
/** schema_migrations.version 為 PostgreSQL INTEGER。 */
export const MAX_MIGRATION_VERSION = 2147483647;

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_INVALID = 3;   // 遷移集合無效或 checksum 不符（Req 12.7），未修改 Database
export const EXIT_FAILED = 4;    // 某個遷移執行失敗（Req 12.4）

export const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY CHECK (version > 0),
  name        TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  destructive BOOLEAN NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

/** 遷移集合驗證錯誤；`versions` 為有問題的版本號，`files` 為無法解析版本的檔名。 */
export class MigrationValidationError extends Error {
  constructor(message, { versions = [], files = [] } = {}) {
    super(message);
    this.name = 'MigrationValidationError';
    this.versions = versions;
    this.files = files;
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function toBytes(content) {
  if (typeof content === 'string') return new TextEncoder().encode(content);
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  throw new TypeError('遷移檔內容必須是字串或位元組');
}

/** 檔頭（檔案開頭連續的空白行與 `--` 註解行）中出現 `-- lm:destructive` 即為破壞性遷移。 */
export function hasDestructiveMarker(sqlText) {
  for (const raw of sqlText.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (!line.startsWith('--')) return false;
    if (line === DESTRUCTIVE_MARKER) return true;
  }
  return false;
}

/** 依檔名解析版本號；不符合命名規則回傳 null。版本可能為 0 或超出範圍，由呼叫端判斷。 */
export function parseMigrationFileName(name) {
  const match = typeof name === 'string' ? MIGRATION_FILE_PATTERN.exec(name) : null;
  return match ? Number(match[1]) : null;
}

/**
 * 將遷移檔（[{name, content}]）轉為依版本遞增排序的遷移清單。
 * - 副檔名不是 `.sql` 的檔案略過（例如 README）。
 * - `.sql` 但不符命名規則、版本非正整數或超出 INTEGER、版本重複、內容不是有效 UTF-8 → throw。
 * - checksum 為檔案位元組的 SHA-256 hex。
 * @returns {{version:number, name:string, sql:string, checksum:string, destructive:boolean}[]}
 */
export function loadMigrations(files) {
  if (!Array.isArray(files)) throw new TypeError('files 必須是陣列');
  const badFiles = [];
  const badVersions = new Set();
  const byVersion = new Map();
  const migrations = [];

  for (const file of files) {
    const name = file?.name;
    if (typeof name !== 'string' || !name.endsWith('.sql')) continue;
    const version = parseMigrationFileName(name);
    if (version === null) { badFiles.push(name); continue; }
    if (!Number.isSafeInteger(version) || version < 1 || version > MAX_MIGRATION_VERSION) { badVersions.add(version); badFiles.push(name); continue; }
    if (byVersion.has(version)) { badVersions.add(version); continue; }
    const bytes = toBytes(file.content);
    let sqlText;
    try { sqlText = utf8.decode(bytes); } catch { badVersions.add(version); continue; }
    const migration = {
      version,
      name,
      sql: sqlText,
      checksum: createHash('sha256').update(bytes).digest('hex'),
      destructive: hasDestructiveMarker(sqlText),
    };
    byVersion.set(version, migration);
    migrations.push(migration);
  }

  if (badFiles.length || badVersions.size) {
    const versions = [...badVersions].sort((a, b) => a - b);
    const parts = [];
    if (versions.length) parts.push(`版本號重複、非正整數或內容無效：${versions.join(', ')}`);
    const unnamed = badFiles.filter(n => parseMigrationFileName(n) === null);
    if (unnamed.length) parts.push(`檔名不符合 NNNN_name.sql 規則：${unnamed.join(', ')}`);
    throw new MigrationValidationError(`遷移集合無效（${parts.join('；')}）`, { versions, files: badFiles });
  }
  return migrations.sort((a, b) => a.version - b.version);
}

/**
 * 比對 repository 遷移與 Database 已套用紀錄。
 * @param {{version:number, checksum:string}[]} repo
 * @param {{version:number|string, checksum:string}[]} applied
 * @returns {{toApply:object[], unknownApplied:number[], checksumMismatch:number[]}}
 *   toApply：repo 中未套用者（版本遞增）；unknownApplied：紀錄中存在但 repo 沒有的版本（回滾情境，保留不動）；
 *   checksumMismatch：已套用但內容摘要與 repo 不同的版本。
 */
export function planMigrations(repo, applied) {
  const appliedMap = new Map();
  for (const row of applied || []) appliedMap.set(Number(row.version), row.checksum);
  const repoVersions = new Set();
  const toApply = [];
  const checksumMismatch = [];
  for (const m of repo || []) {
    repoVersions.add(m.version);
    if (!appliedMap.has(m.version)) toApply.push(m);
    else if (appliedMap.get(m.version) !== m.checksum) checksumMismatch.push(m.version);
  }
  const unknownApplied = [...appliedMap.keys()].filter(v => !repoVersions.has(v));
  const asc = (a, b) => a - b;
  return {
    toApply: toApply.sort((a, b) => a.version - b.version),
    unknownApplied: unknownApplied.sort(asc),
    checksumMismatch: checksumMismatch.sort(asc),
  };
}

const errorText = err => (err && typeof err.message === 'string' && err.message) || String(err);

/**
 * 依序套用待執行遷移。`sql` 為 Bun.SQL 相容 executor（tagged template、`begin`、`unsafe`）；
 * 若提供 `reserve()`，會保留單一連線，確保 session 級 advisory lock 與解鎖在同一連線上。
 * @param {object} sql
 * @param {object[]} repo loadMigrations 的結果
 * @param {{log?:(line:string)=>void}} [options]
 * @returns {Promise<{exitCode:number, applied:number[], count:number, unknownApplied:number[],
 *   checksumMismatch:number[], failedVersion:number|null, error:string|null}>}
 */
export async function runMigrations(sql, repo, { log = () => {} } = {}) {
  const result = { exitCode: EXIT_OK, applied: [], count: 0, unknownApplied: [], checksumMismatch: [], failedVersion: null, error: null };
  const reserved = typeof sql.reserve === 'function' ? await sql.reserve() : null;
  const db = reserved || sql;
  let locked = false;
  try {
    await db`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    locked = true;
    // 固定 DDL 字串，不含任何外部輸入。
    await db.unsafe(SCHEMA_MIGRATIONS_DDL);
    const rows = await db`SELECT version, checksum FROM schema_migrations ORDER BY version`;
    const plan = planMigrations(repo, rows);
    result.unknownApplied = plan.unknownApplied;
    result.checksumMismatch = plan.checksumMismatch;

    if (plan.checksumMismatch.length) {
      result.exitCode = EXIT_INVALID;
      result.error = `已套用遷移的內容摘要與 repository 不一致：${plan.checksumMismatch.join(', ')}`;
      log(result.error);
      return result;
    }
    if (plan.unknownApplied.length) log(`保留 repository 中不存在的已套用版本：${plan.unknownApplied.join(', ')}`);

    for (const m of plan.toApply) {
      try {
        await db.begin(async tx => {
          // 唯一允許的 unsafe：執行 repository 內遷移檔原文（見檔頭說明）。
          await tx.unsafe(m.sql);
          await tx`INSERT INTO schema_migrations (version, name, checksum, destructive)
                   VALUES (${m.version}, ${m.name}, ${m.checksum}, ${m.destructive})`;
        });
      } catch (err) {
        result.exitCode = EXIT_FAILED;
        result.failedVersion = m.version;
        result.error = `遷移 ${m.version}（${m.name}）失敗：${errorText(err)}`;
        log(result.error);
        break;
      }
      result.applied.push(m.version);
    }
    result.count = result.applied.length;
    log(`applied: [${result.applied.join(', ')}] count: ${result.count}`);
    return result;
  } catch (err) {
    result.exitCode = EXIT_ERROR;
    result.error = `Migration_Runner 執行錯誤：${errorText(err)}`;
    result.count = result.applied.length;
    log(result.error);
    return result;
  } finally {
    if (locked) {
      try { await db`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`; } catch { /* 連線中斷時 session 結束即釋放 */ }
    }
    if (reserved) {
      try { reserved.release(); } catch { /* ignore */ }
    }
  }
}
