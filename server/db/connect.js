// Database 連線模組（Requirement 11.1、11.5、11.6、11.9）。
// 以 Bun 內建 Bun.SQL 建立 PostgreSQL 連線池。連線設定只來自 server/config.js 的 `database`
// 物件（由 CAMPING_DATABASE_* 環境變數解析）。所有錯誤與日誌訊息只含主機與連接埠，
// 絕不包含密碼或連線字串。
//
// 重連行為（Req 11.9）依 Bun 官方文件（https://bun.com/docs/runtime/sql，Connection Pooling 一節）：
// - 連線池在「沒有可用連線」時才開啟連線，所有連線關閉後下一個查詢會重新建立連線池；
//   部分連線遺失時，等待中的查詢會觸發補開新連線（失敗後退避，最長 1 秒）。
// - 因此 DB 重啟造成連線關閉後，不需重建 SQL 物件即可在下一次查詢時恢復。
// - idleTimeout／maxLifetime 預設關閉；此處開啟以定期汰換可能已失效的閒置連線。
// - connectionTimeout 預設 30 秒；此處縮短為 5 秒，使 DB 無法連線時查詢較快失敗。
// 以上為文件記載的行為，尚未在本 repo 以實際 PostgreSQL 驗證（task 5.17 的整合測試負責驗證）。
import { SQL } from 'bun';

/** CAMPING_DATABASE_SSLMODE → Bun.SQL `tls` 選項。 */
export const TLS_BY_SSLMODE = Object.freeze({
  disable: false,
  require: Object.freeze({ rejectUnauthorized: false }), // 加密但不驗證憑證（同 libpq sslmode=require）
  'verify-full': true,                                    // 驗證憑證鏈與主機名稱
});

export const DEFAULT_POOL_OPTIONS = Object.freeze({
  max: 10,
  idleTimeout: 30,          // 秒：閒置連線 30 秒後關閉
  maxLifetime: 30 * 60,     // 秒：每條連線最長使用 30 分鐘後汰換
  connectionTimeout: 5,     // 秒：建立新連線的等待上限
});

export const RETRY_MIN_MS = 1000;
export const RETRY_MAX_MS = 5000;
export const RETRY_TOTAL_MS = 30000;

/** 只含主機與連接埠的位置描述，用於錯誤與日誌。 */
export const describeTarget = database => `${database?.host}:${database?.port}`;

/** 錯誤代碼只保留形如 `ECONNREFUSED`、`ERR_POSTGRES_…` 的識別字，避免夾帶任意訊息內容。 */
const safeCode = error => {
  const code = error?.code ?? error?.errno;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : (error?.name === 'TimeoutError' ? 'TIMEOUT' : 'ERROR');
};

/**
 * 建立連線池。Bun.SQL 為 lazy：此函式不會立即連線，第一個查詢才會開啟連線。
 * @param {{host:string, port:number, name:string, user:string, password:string, sslmode?:string}} database
 * @param {{max?:number, idleTimeout?:number, maxLifetime?:number, connectionTimeout?:number, connection?:Record<string,string>}} [options]
 *   例如 Migration_Runner 以 `{ max: 1 }` 使 advisory lock 與遷移在同一 session。
 * @returns {{sql: SQL, ping:(ms?:number)=>Promise<boolean>, close:()=>Promise<void>, target:string}}
 */
export function createDatabase(database, options = {}) {
  if (!database || typeof database !== 'object') throw new TypeError('database 設定缺少');
  const sslmode = database.sslmode ?? 'disable';
  if (!Object.hasOwn(TLS_BY_SSLMODE, sslmode)) throw new TypeError(`不支援的 sslmode（${describeTarget(database)}）`);
  const pool = { ...DEFAULT_POOL_OPTIONS, ...options };
  const sql = new SQL({
    adapter: 'postgres',
    hostname: database.host,
    port: database.port,
    database: database.name,
    username: database.user,
    password: database.password,
    tls: TLS_BY_SSLMODE[sslmode],
    max: pool.max,
    idleTimeout: pool.idleTimeout,
    maxLifetime: pool.maxLifetime,
    connectionTimeout: pool.connectionTimeout,
    // 選填的 PostgreSQL startup 參數（例如測試以 `{ search_path }` 指向隔離 schema）；正式啟動不傳入。
    ...(pool.connection ? { connection: { ...pool.connection } } : {}),
  });
  const target = describeTarget(database);
  return {
    sql,
    target,
    ping: (ms = 2000) => pingSql(sql, ms),
    close: async () => { try { await sql.close({ timeout: 5 }); } catch { /* 關閉時的錯誤不影響結束流程 */ } },
  };
}

/**
 * 以 `SELECT 1` 檢查連線；在 ms 毫秒內未成功即回傳 false。絕不拋出例外（Req 11.6）。
 * 逾時後嘗試取消查詢，避免 DB 暫停時累積掛起的查詢。
 */
export async function pingSql(sql, ms = 2000) {
  let timer, query;
  try {
    query = sql`SELECT 1 AS ok`;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, ms)); });
    const run = Promise.resolve(query).then(rows => Number(rows?.[0]?.ok) === 1, () => false);
    const ok = await Promise.race([run, timeout]);
    if (!ok) { try { query?.cancel?.(); } catch { /* ignore */ } }
    return ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 啟動重連排程（純函式，Property 26）：回傳每次重試前的等待毫秒數。
 * 每個間隔介於 minMs..maxMs，累計不超過 totalMs；`random` 可注入以產生抖動或測試。
 * @returns {number[]}
 */
export function retrySchedule({ random = Math.random, minMs = RETRY_MIN_MS, maxMs = RETRY_MAX_MS, totalMs = RETRY_TOTAL_MS } = {}) {
  const delays = [];
  let sum = 0;
  while (totalMs - sum >= minMs) {
    let r = Number(random());
    if (!Number.isFinite(r) || r < 0) r = 0;
    if (r >= 1) r = 0.999999;
    const delay = Math.min(minMs + Math.floor(r * (maxMs - minMs + 1)), maxMs, totalMs - sum);
    delays.push(delay);
    sum += delay;
  }
  return delays;
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 單次連線嘗試：成功 resolve，失敗或逾時 reject（附安全的錯誤代碼）。 */
async function attempt(sql, ms) {
  let timer;
  const query = sql`SELECT 1`;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { query?.cancel?.(); } catch { /* ignore */ }
        reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }));
      }, Math.max(0, ms));
    });
    await Promise.race([Promise.resolve(query), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 建立連線池並確認可連線（Req 11.5）：第一次嘗試失敗後依 `schedule` 等待重試；
 * 每次嘗試以 attemptTimeoutMs 為上限，整體（等待＋嘗試）以 totalMs 為上限。
 * 全部失敗時關閉連線池並拋出 `DatabaseConnectError`，訊息只含主機與連接埠。
 * @param {object} database server/config.js 的 database 物件
 * @param {{schedule?:number[], sleep?:(ms:number)=>Promise<void>, create?:Function, log?:Function,
 *   now?:()=>number, attemptTimeoutMs?:number, totalMs?:number, poolOptions?:object}} [deps]
 */
export async function connectWithRetry(database, {
  schedule = retrySchedule(),
  sleep = defaultSleep,
  create = createDatabase,
  log = () => {},
  now = Date.now,
  attemptTimeoutMs = 5000,
  totalMs = RETRY_TOTAL_MS,
  poolOptions,
} = {}) {
  const target = describeTarget(database);
  const deadline = now() + totalMs;
  let db;
  try {
    db = create(database, poolOptions);
  } catch (e) {
    throw new DatabaseConnectError(target, safeCode(e));
  }
  let lastCode = 'ERROR';
  for (let i = 0; ; i++) {
    const remaining = deadline - now();
    try {
      await attempt(db.sql, Math.max(0, Math.min(attemptTimeoutMs, remaining)));
      if (i > 0) log(`Database ${target} 已連線（第 ${i + 1} 次嘗試）`);
      return db;
    } catch (e) {
      lastCode = safeCode(e);
    }
    const delay = schedule[i];
    if (delay === undefined || now() + delay >= deadline) break;
    log(`Database ${target} 連線失敗（${lastCode}），${delay} ms 後重試`);
    await sleep(delay);
  }
  await db.close?.();
  throw new DatabaseConnectError(target, lastCode);
}

/** 啟動時無法連線 Database；message 只含主機與連接埠，`code` 為最後一次失敗的錯誤代碼。 */
export class DatabaseConnectError extends Error {
  constructor(target, code = 'ERROR') {
    super(`無法連線至 Database ${target}`);
    this.name = 'DatabaseConnectError';
    this.code = code;
  }
}
