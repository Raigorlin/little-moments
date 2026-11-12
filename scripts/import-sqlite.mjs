// SQLite_Importer（Requirement 10.9、13.1–13.10；design.md Components §6）。
//
//   bun scripts/import-sqlite.mjs --source /path/accounts.sqlite
//   目標 Database 由 CAMPING_DATABASE_* 提供；遷移目錄為 CAMPING_MIGRATIONS_DIR，
//   未設定時為本檔上一層的 migrations/（repo：scripts/../migrations；映像：/app/tools/../migrations）。
//
// 這是一次性的離線維運工具，也是整個專案中唯一允許匯入 `bun:sqlite` 的位置；
// App_Server 執行期（scripts/serve.mjs、server/）不載入 `bun:sqlite`（Req 11.1）。
//
// 流程：
//   1. 計算來源檔與 `-wal` 的 SHA-256，並記錄來源目錄的檔案清單。
//   2. 將來源檔（含 `-wal`、`-shm`）複製到 os.tmpdir() 下新建的暫存目錄（chmod 0700，檔案 0600；
//      Windows 不套用 POSIX 權限位元，暫存目錄的保護改由使用者設定檔目錄的 ACL 提供）。
//      只開啟複本：`PRAGMA wal_checkpoint(TRUNCATE)` 合併 WAL、改為 DELETE journal 後以唯讀重新開啟。
//      原始檔案從不被 SQLite 開啟，來源目錄不會產生任何檔案（Req 13.2）。
//   3. 驗證 SQLite 標頭與所有必要資料表及欄位；不符即在連線目標前結束（Req 13.9）。
//      來源可以是舊版或 security-harden 版：0002 新增的資料表（settings、receipt_ai_usage、
//      security_events、security_alerts）不存在時筆數為 0，0002 新增的 invites 欄位
//      （used_at、used_by、id）不存在時以 NULL 匯入。
//   4. 連線目標 → runMigrations 確保 Schema。
//   5. 單一寫入交易（withWriteTx，與 App_Server 寫入者互斥）：任一資料表非空即中止（Req 13.3）；
//      依外鍵順序每批 500 列以 Bun.SQL 參數化批次 INSERT 寫入，password_hash 原字串（Req 10.9、13.8）；
//      提交前比對每表筆數（Req 13.6）、再次確認來源雜湊未變、setval audit 序列（Req 13.10）。
//      任何失敗 → 整筆交易回復，目標維持匯入前狀態（Req 13.4）。
//   6. 提交後輸出 `table source target`（Req 13.5），刪除暫存目錄並再次比對來源雜湊與目錄清單。
//
// 錯誤輸出只含資料表名稱、欄位名稱與原因類別（含 SQLSTATE），絕不含資料列內容、密碼雜湊或 DB 密碼。
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdtemp, open, readdir, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../server/config.js';
import { createDatabase } from '../server/db/connect.js';
import { loadMigrations, runMigrations, MigrationValidationError } from '../server/db/migrations.js';
import { withWriteTx } from '../server/db/tx.js';
import { tableOrder, columnNames, requiredColumnNames, requiredTables, convertRow, compareCounts, IDENTITY_COLUMNS, ImportPlanError } from '../server/db/import-plan.js';
import { readMigrationFiles } from './migrate.mjs';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;           // 連線、遷移或其他執行錯誤
export const EXIT_USAGE = 2;           // 參數或設定錯誤
export const EXIT_SOURCE_INVALID = 3;  // 來源不存在、不是 SQLite、缺少資料表或欄位（Req 13.9）
export const EXIT_TARGET_NOT_EMPTY = 4;// 目標任一資料表非空（Req 13.3）
export const EXIT_IMPORT_FAILED = 5;   // 讀取或寫入失敗，已回復（Req 13.4）
export const EXIT_COUNT_MISMATCH = 6;  // 提交前筆數不符，已回復（Req 13.6）
export const EXIT_SOURCE_CHANGED = 7;  // 匯入期間來源檔或來源目錄被改變（Req 13.2）

export const BATCH_SIZE = 500;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const SIDE_SUFFIXES = ['-wal', '-shm'];
const HASHED_SUFFIXES = ['', '-wal'];

/** 匯入失敗；`code` 為結束碼，`table`／`column` 選填，`reason` 為不含資料值的原因類別。 */
export class ImportError extends Error {
  constructor(code, reason, { table = null, column = null } = {}) {
    const where = table ? `資料表 ${table}${column ? ` 欄位 ${column}` : ''}: ` : '';
    super(`${where}${reason}`);
    this.name = 'ImportError';
    this.code = code;
    this.table = table;
    this.column = column;
    this.reason = reason;
  }
}

const exists = async path => { try { await stat(path); return true; } catch { return false; } };

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('end', resolvePromise).on('error', reject);
  });
  return hash.digest('hex');
}

/** 來源指紋：來源檔與 `-wal` 的 SHA-256（不存在記為 null）以及來源目錄的檔案清單。 */
export async function sourceFingerprint(sourcePath) {
  const hashes = {};
  for (const suffix of HASHED_SUFFIXES) {
    const path = sourcePath + suffix;
    hashes[suffix || 'main'] = (await exists(path)) ? await sha256File(path) : null;
  }
  const listing = (await readdir(dirname(sourcePath))).sort();
  return { hashes, listing };
}

const sameFingerprint = (a, b) =>
  JSON.stringify(a.hashes) === JSON.stringify(b.hashes) && JSON.stringify(a.listing) === JSON.stringify(b.listing);

async function readHeader(path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(SQLITE_MAGIC.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead === buffer.length ? buffer : null;
  } finally {
    await handle.close();
  }
}

/** 將來源（含 -wal、-shm）複製到 0700 暫存目錄；回傳暫存目錄與複本路徑。 */
async function copySource(sourcePath, tmpRoot) {
  const dir = await mkdtemp(join(tmpRoot, 'lm-import-'));
  await chmod(dir, 0o700); // Windows 忽略 POSIX 權限位元
  const copy = join(dir, 'source.sqlite');
  for (const suffix of ['', ...SIDE_SUFFIXES]) {
    if (suffix && !(await exists(sourcePath + suffix))) continue;
    await copyFile(sourcePath + suffix, copy + suffix);
    await chmod(copy + suffix, 0o600);
  }
  return { dir, copy };
}

/** 在複本上合併 WAL 並改為 DELETE journal，之後以唯讀、safeIntegers 開啟。 */
function openCopy(copy) {
  let rw;
  try {
    rw = new Database(copy, { readwrite: true, create: false });
    rw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    rw.exec('PRAGMA journal_mode = DELETE');
  } catch {
    throw new ImportError(EXIT_SOURCE_INVALID, '不是有效的 SQLite 檔案或檔案已損壞');
  } finally {
    try { rw?.close(); } catch { /* ignore */ }
  }
  try {
    return new Database(copy, { readonly: true, safeIntegers: true });
  } catch {
    throw new ImportError(EXIT_SOURCE_INVALID, '無法以唯讀方式開啟 SQLite 複本');
  }
}

/**
 * 驗證必要資料表與欄位（Req 13.9）；回傳每表來源筆數與實際存在的欄位。
 * 來源可以是舊版（security-harden 之前）或 security-harden 版的 accounts.sqlite：
 * 0002 新增的資料表不存在時筆數為 0；0002 新增的欄位不存在時以 NULL 匯入。
 * @returns {{counts: Record<string, number>, present: Record<string, string[]|null>}}
 *   present[table]：要從來源讀取的欄位（依 columnNames 順序）；資料表不存在時為 null。
 */
function validateSource(db) {
  let tables;
  try {
    tables = new Set(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
  } catch {
    throw new ImportError(EXIT_SOURCE_INVALID, '不是有效的 SQLite 檔案或檔案已損壞');
  }
  const missing = requiredTables().filter(t => !tables.has(t));
  if (missing.length) throw new ImportError(EXIT_SOURCE_INVALID, `來源缺少資料表：${missing.join(', ')}`);
  const counts = {};
  const present = {};
  for (const table of tableOrder()) {
    if (!tables.has(table)) {
      // 只有 optional 資料表會走到這裡（必要資料表已在上方檢查）。
      counts[table] = 0;
      present[table] = null;
      continue;
    }
    // 資料表名稱來自固定清單（import-plan.js），不含外部輸入。
    const actual = new Set(db.query(`PRAGMA table_info("${table}")`).all().map(r => r.name));
    const expected = columnNames(table);
    const lacking = requiredColumnNames(table).filter(c => !actual.has(c));
    if (lacking.length) throw new ImportError(EXIT_SOURCE_INVALID, `來源缺少欄位：${lacking.join(', ')}`, { table });
    const extra = [...actual].filter(c => !expected.includes(c));
    if (extra.length) throw new ImportError(EXIT_SOURCE_INVALID, `來源含未定義的欄位：${extra.join(', ')}`, { table });
    present[table] = expected.filter(c => actual.has(c));
    counts[table] = Number(db.query(`SELECT count(*) AS n FROM "${table}"`).get().n);
  }
  return { counts, present };
}

/** PostgreSQL 錯誤只保留 SQLSTATE／錯誤代碼，不帶訊息（訊息細節可能含資料值）。 */
const pgReason = err => {
  const state = typeof err?.errno === 'string' && /^[0-9A-Z]{5}$/.test(err.errno) ? err.errno : null;
  const code = typeof err?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(err.code) ? err.code : (err?.name || 'Error');
  return state ? `寫入失敗（SQLSTATE ${state}）` : `寫入失敗（${code}）`;
};

const toCount = value => {
  const n = typeof value === 'bigint' ? value : BigInt(value);
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : -1;
};

/**
 * 在單一寫入交易內完成匯入；任何 throw 都會使整筆交易回復。
 * @returns {Promise<Record<string, number>>} 目標筆數
 */
async function importInto(sql, source, { counts: sourceCounts, present }, { checkSource }) {
  return withWriteTx(sql, async t => {
    // Req 13.3：寫入任何資料前確認所有資料表為空。
    const nonEmpty = [];
    for (const table of tableOrder()) {
      const [row] = await t`SELECT EXISTS (SELECT 1 FROM ${t(table)}) AS has`;
      if (row.has) nonEmpty.push(table);
    }
    if (nonEmpty.length) throw new ImportError(EXIT_TARGET_NOT_EMPTY, `目標 Database 非空：${nonEmpty.join(', ')}`);

    for (const table of tableOrder()) {
      const columns = columnNames(table);
      const sourceColumns = present[table];
      // 舊版來源沒有的 0002 資料表：沒有資料列可讀，筆數比對以 0 為準。
      if (!sourceColumns) continue;
      let iterator;
      try {
        // 依 rowid 讀取；資料表名稱與欄位清單皆為固定常數（只讀來源實際存在的欄位，其餘由 convertRow 補 NULL）。
        iterator = source.query(`SELECT ${sourceColumns.map(c => `"${c}"`).join(', ')} FROM "${table}" ORDER BY rowid`).iterate();
      } catch {
        throw new ImportError(EXIT_IMPORT_FAILED, '讀取來源失敗', { table });
      }
      let batch = [];
      const flush = async () => {
        if (!batch.length) return;
        try {
          await t`INSERT INTO ${t(table)} ${t(batch, ...columns)}`;
        } catch (err) {
          throw new ImportError(EXIT_IMPORT_FAILED, pgReason(err), { table });
        }
        batch = [];
      };
      try {
        for (const raw of iterator) {
          let values;
          try {
            values = convertRow(table, { ...raw });
          } catch (err) {
            if (err instanceof ImportPlanError) throw new ImportError(EXIT_IMPORT_FAILED, err.reason, { table, column: err.column });
            throw err;
          }
          batch.push(Object.fromEntries(columns.map((c, i) => [c, values[i]])));
          if (batch.length >= BATCH_SIZE) await flush();
        }
      } catch (err) {
        if (err instanceof ImportError) throw err;
        throw new ImportError(EXIT_IMPORT_FAILED, '讀取來源失敗', { table });
      }
      await flush();
    }

    // Req 13.6：提交前比對筆數。
    const targetCounts = {};
    for (const table of tableOrder()) {
      const [row] = await t`SELECT count(*) AS n FROM ${t(table)}`;
      targetCounts[table] = toCount(row.n);
    }
    const mismatches = compareCounts(sourceCounts, targetCounts);
    if (mismatches.length) {
      const detail = mismatches.map(m => `${m.table}（來源 ${m.source}，目標 ${m.target}）`).join(', ');
      const error = new ImportError(EXIT_COUNT_MISMATCH, `來源與目標筆數不符：${detail}`);
      error.mismatches = mismatches;
      throw error;
    }

    // Req 13.2：提交前再次確認來源未被改變。
    await checkSource();

    // Req 13.10：identity 從已匯入最大值之後開始；空表時下一個 id 為 1（audit、security_events）。
    // 資料表與欄位名稱來自固定清單（IDENTITY_COLUMNS），以 identifier 參數傳入。
    for (const { table, column } of IDENTITY_COLUMNS) {
      await t`SELECT setval(pg_get_serial_sequence(${table}, ${column}), GREATEST(COALESCE(max(${t(column)}), 0), 1), max(${t(column)}) IS NOT NULL) FROM ${t(table)}`;
    }
    return targetCounts;
  });
}

/**
 * 執行匯入。永不呼叫 process.exit。
 * @param {{sourcePath:string, sql?:object, connect?:()=>Promise<{sql:object, close:()=>Promise<void>}>|{sql:object, close:Function},
 *   migrationsDir?:string, log?:(line:string)=>void, err?:(line:string)=>void, tmpRoot?:string}} options
 *   提供 `sql` 時直接使用（呼叫端負責關閉）；否則在來源驗證通過後才呼叫 `connect()`（Req 13.9）。
 * @returns {Promise<{exitCode:number, counts:{table:string, source:number, target:number}[], error:string|null}>}
 */
export async function importSqlite({
  sourcePath,
  sql = null,
  connect = null,
  migrationsDir = process.env.CAMPING_MIGRATIONS_DIR || fileURLToPath(new URL('../migrations/', import.meta.url)),
  log = () => {},
  err = () => {},
  tmpRoot = tmpdir(),
} = {}) {
  const result = { exitCode: EXIT_OK, counts: [], error: null };
  const fail = (code, message) => {
    result.exitCode = code;
    result.error = message;
    err(message);
    return result;
  };
  if (typeof sourcePath !== 'string' || !sourcePath) return fail(EXIT_USAGE, '缺少來源 SQLite 檔案路徑');
  const source = resolve(sourcePath);

  let tmp = null;
  let sourceDb = null;
  let ownDb = null;
  let before;
  try {
    // 1. 來源存在且為一般檔案、標頭正確。
    let info;
    try { info = await stat(source); } catch { return fail(EXIT_SOURCE_INVALID, `來源檔案不存在：${basename(source)}`); }
    if (!info.isFile()) return fail(EXIT_SOURCE_INVALID, `來源不是一般檔案：${basename(source)}`);
    before = await sourceFingerprint(source);
    const header = await readHeader(source);
    if (!header || !header.equals(SQLITE_MAGIC)) return fail(EXIT_SOURCE_INVALID, '來源不是有效的 SQLite 檔案（標頭不符）');

    // 2. 複製到暫存目錄並只開啟複本。
    tmp = await copySource(source, tmpRoot);
    sourceDb = openCopy(tmp.copy);

    // 3. 必要資料表與欄位（連線目標前）。
    const sourcePlan = validateSource(sourceDb);
    const sourceCounts = sourcePlan.counts;

    // 4. 連線目標並套用遷移。
    let target = sql;
    if (!target) {
      if (typeof connect !== 'function') return fail(EXIT_USAGE, '缺少目標 Database 連線');
      ownDb = await connect();
      target = ownDb.sql;
    }
    const repo = loadMigrations(await readMigrationFiles(migrationsDir));
    const migrated = await runMigrations(target, repo, { log: line => (/失敗|錯誤|不一致/.test(line) ? err : log)(line) });
    if (migrated.exitCode !== 0) {
      result.exitCode = EXIT_ERROR;
      result.error = `目標 Database 連線或遷移失敗（結束碼 ${migrated.exitCode}）`;
      err(result.error);
      return result;
    }

    // 5. 單一交易匯入。
    const checkSource = async () => {
      const now = await sourceFingerprint(source);
      if (!sameFingerprint(before, now)) throw new ImportError(EXIT_SOURCE_CHANGED, '匯入期間來源檔案或來源目錄已被改變');
    };
    const targetCounts = await importInto(target, sourceDb, sourcePlan, { checkSource });

    // 6. 輸出每表筆數。
    log('table source target');
    for (const table of tableOrder()) {
      result.counts.push({ table, source: sourceCounts[table], target: targetCounts[table] });
      log(`${table} ${sourceCounts[table]} ${targetCounts[table]}`);
    }
    return result;
  } catch (e) {
    if (e instanceof ImportError) {
      if (e.mismatches) result.counts = e.mismatches;
      return fail(e.code, e.message);
    }
    if (e instanceof MigrationValidationError) return fail(EXIT_ERROR, e.message);
    const code = typeof e?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(e.code) ? e.code : (e?.name || 'Error');
    return fail(EXIT_ERROR, `匯入執行錯誤（${code}）`);
  } finally {
    try { sourceDb?.close(); } catch { /* ignore */ }
    if (tmp) {
      try { await rm(tmp.dir, { recursive: true, force: true }); } catch { err('無法刪除暫存目錄'); }
    }
    if (ownDb) await ownDb.close?.();
    // 結束時再次比對來源（Req 13.2）；已提交的匯入仍保留，但以非零結束碼提醒維運者。
    if (before) {
      try {
        const after = await sourceFingerprint(source);
        if (!sameFingerprint(before, after) && result.exitCode === EXIT_OK) {
          result.exitCode = EXIT_SOURCE_CHANGED;
          result.error = '匯入結束時來源檔案或來源目錄與匯入前不同';
          err(result.error);
        }
      } catch {
        if (result.exitCode === EXIT_OK) {
          result.exitCode = EXIT_SOURCE_CHANGED;
          result.error = '匯入結束時無法再次讀取來源檔案';
          err(result.error);
        }
      }
    }
  }
}

/** 解析 `--source <path>` 或 `--source=<path>`。 */
export function parseArgs(argv) {
  let source = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--source') {
      if (i + 1 >= argv.length) return { ok: false, error: '--source 需要檔案路徑' };
      source = argv[++i];
    } else if (arg.startsWith('--source=')) {
      source = arg.slice('--source='.length);
    } else if (arg === '--help' || arg === '-h') {
      return { ok: false, help: true };
    } else {
      return { ok: false, error: `未知的參數：${arg}` };
    }
  }
  if (!source) return { ok: false, error: '缺少 --source <path>' };
  return { ok: true, source };
}

function redactor(secrets) {
  const values = secrets.filter(s => typeof s === 'string' && s.length > 0).sort((a, b) => b.length - a.length);
  return text => values.reduce((out, s) => out.split(s).join('********'), String(text));
}

const USAGE = '用法：bun scripts/import-sqlite.mjs --source <accounts.sqlite>（目標由 CAMPING_DATABASE_* 提供）';

export async function main(argv = process.argv.slice(2), env = process.env, { out = console.log, err = console.error } = {}) {
  const args = parseArgs(argv);
  if (!args.ok) {
    (args.help ? out : err)(args.error ? `${args.error}\n${USAGE}` : USAGE);
    return args.help ? EXIT_OK : EXIT_USAGE;
  }
  const parsed = parseConfig(env);
  if (!parsed.ok) {
    for (const e of parsed.errors) err(`設定錯誤 ${e.name}: ${e.reason}`);
    return EXIT_USAGE;
  }
  const { database } = parsed.config;
  const redact = redactor([database.password, encodeURIComponent(database.password)]);
  const result = await importSqlite({
    sourcePath: args.source,
    // 單一連線：runMigrations 的 advisory lock 與匯入交易依序使用同一連線。
    connect: async () => createDatabase(database, { max: 1, connectionTimeout: 10 }),
    migrationsDir: env.CAMPING_MIGRATIONS_DIR || undefined,
    log: line => out(redact(line)),
    err: line => err(redact(line)),
  });
  return result.exitCode;
}

if (import.meta.main) process.exit(await main());
