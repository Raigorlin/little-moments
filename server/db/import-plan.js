// SQLite_Importer 的匯入規劃純函式（Requirement 13；design.md Components §6）。
//
// 本模組不連線資料庫、不讀寫檔案，只負責：
//   * tableOrder()：依外鍵相依順序列出 App_Server 定義的資料表（父表在前）。
//   * convertRow(table, row)：把 SQLite 讀出的一列轉為 PostgreSQL 參數陣列（依 TABLE_COLUMNS 欄位順序）。
//   * compareCounts(source, target)：比對每個資料表的來源與目標筆數。
//
// 欄位清單與型別取自 migrations/0001_initial.sql。錯誤訊息只包含資料表名稱、欄位名稱與原因類別，
// 絕不包含資料列內容（避免在維運輸出中洩漏使用者資料或密碼雜湊）。

const INT4_MIN = -(2 ** 31);
const INT4_MAX = 2 ** 31 - 1;
const INT8_MIN = -(2n ** 63n);
const INT8_MAX = 2n ** 63n - 1n;

/** 欄位定義輔助：type ∈ TEXT | INTEGER（int4）| BIGINT（int8）。 */
const col = (name, type, nullable = false) => Object.freeze({ name, type, nullable });

/**
 * 每個資料表的欄位（順序與 0001_initial.sql 相同）與目標型別。
 * 物件鍵的插入順序即外鍵相依順序，tableOrder() 直接沿用。
 */
export const TABLE_COLUMNS = Object.freeze({
  users: Object.freeze([
    col('id', 'TEXT'),
    col('username', 'TEXT'),
    col('display_name', 'TEXT'),
    col('role', 'TEXT'),
    col('password_hash', 'TEXT'),
    col('created_at', 'BIGINT'),
    col('deleted_at', 'BIGINT', true),
  ]),
  sessions: Object.freeze([ // user_id → users
    col('token_hash', 'TEXT'),
    col('user_id', 'TEXT'),
    col('created_at', 'BIGINT'),
    col('expires_at', 'BIGINT'),
  ]),
  trips: Object.freeze([ // owner_id → users
    col('id', 'TEXT'),
    col('owner_id', 'TEXT'),
    col('title', 'TEXT'),
    col('destination', 'TEXT'),
    col('start_date', 'TEXT'),
    col('end_date', 'TEXT'),
    col('description', 'TEXT'),
    col('note', 'TEXT'),
    col('cover_kind', 'TEXT'),
    col('status', 'TEXT'),
    col('revision', 'INTEGER'),
    col('people_count', 'INTEGER'),
    col('state_json', 'TEXT'),
    col('created_at', 'BIGINT'),
    col('updated_at', 'BIGINT'),
  ]),
  trip_members: Object.freeze([ // trip_id → trips, user_id → users
    col('trip_id', 'TEXT'),
    col('user_id', 'TEXT'),
    col('person_id', 'TEXT'),
    col('joined_at', 'BIGINT'),
  ]),
  invites: Object.freeze([ // trip_id → trips, created_by → users
    col('token_hash', 'TEXT'),
    col('trip_id', 'TEXT'),
    col('created_by', 'TEXT'),
    col('created_at', 'BIGINT'),
    col('expires_at', 'BIGINT'),
    col('revoked_at', 'BIGINT', true),
  ]),
  trip_deletions: Object.freeze([ // trip_id → trips, deleted_by → users
    col('trip_id', 'TEXT'),
    col('deleted_by', 'TEXT'),
    col('deleted_at', 'BIGINT'),
  ]),
  audit: Object.freeze([ // 無外鍵；id 為 IDENTITY，匯入原值後由匯入器 setval（Req 13.10）
    col('id', 'BIGINT'),
    col('at', 'BIGINT'),
    col('actor', 'TEXT'),
    col('action', 'TEXT'),
    col('target', 'TEXT'),
  ]),
  trip_ledgers: Object.freeze([ // trip_id → trips, updated_by → users
    col('trip_id', 'TEXT'),
    col('revision', 'INTEGER'),
    col('ledger_json', 'TEXT'),
    col('requests_json', 'TEXT'),
    col('updated_by', 'TEXT'),
    col('updated_at', 'BIGINT'),
  ]),
});

/** 匯入資料列轉換失敗。只帶資料表、欄位與原因類別，不帶值。 */
export class ImportPlanError extends Error {
  constructor(table, column, reason) {
    super(column ? `資料表 ${table} 欄位 ${column}: ${reason}` : `資料表 ${table}: ${reason}`);
    this.name = 'ImportPlanError';
    this.table = table;
    this.column = column ?? null;
    this.reason = reason;
  }
}

const TABLE_ORDER = Object.freeze(Object.keys(TABLE_COLUMNS));

/** 依外鍵順序（父表在前）回傳資料表名稱的新陣列。 */
export function tableOrder() {
  return [...TABLE_ORDER];
}

/** 回傳資料表的欄位名稱（依 INSERT 參數順序）；未知資料表 throw。 */
export function columnNames(table) {
  return columnsOf(table).map(c => c.name);
}

function columnsOf(table) {
  if (typeof table !== 'string' || !Object.hasOwn(TABLE_COLUMNS, table)) {
    throw new ImportPlanError(String(table), null, '不是 App_Server 定義的資料表');
  }
  return TABLE_COLUMNS[table];
}

function convertValue(table, column, value) {
  if (value === null || value === undefined) {
    if (column.nullable) return null;
    throw new ImportPlanError(table, column.name, '不可為 NULL');
  }
  switch (column.type) {
    case 'TEXT':
      if (typeof value !== 'string') throw new ImportPlanError(table, column.name, '必須是文字');
      return value; // UTF-8 原樣，password_hash 也不做任何轉換（Req 10.9、13.8）
    case 'INTEGER': {
      let n;
      if (typeof value === 'bigint') n = value;
      else if (typeof value === 'number' && Number.isInteger(value)) n = BigInt(value);
      else throw new ImportPlanError(table, column.name, '必須是整數');
      if (n < BigInt(INT4_MIN) || n > BigInt(INT4_MAX)) {
        throw new ImportPlanError(table, column.name, '超出 INTEGER（int4）範圍');
      }
      return Number(n);
    }
    case 'BIGINT':
      if (typeof value === 'number') {
        if (!Number.isSafeInteger(value)) throw new ImportPlanError(table, column.name, '必須是安全整數');
        return value;
      }
      if (typeof value === 'bigint') {
        if (value < INT8_MIN || value > INT8_MAX) throw new ImportPlanError(table, column.name, '超出 BIGINT（int8）範圍');
        return value;
      }
      throw new ImportPlanError(table, column.name, '必須是整數');
    default:
      throw new ImportPlanError(table, column.name, '未知的欄位型別');
  }
}

/**
 * 將 SQLite 資料列（以欄位名為鍵的物件）轉為依 columnNames(table) 順序排列的 PostgreSQL 參數陣列。
 * NULL 保留；TEXT 原樣；INTEGER 須在 int4 範圍並以 number 輸出；BIGINT 保留 number（安全整數）或 bigint（int8 範圍）。
 * 缺少或多出的欄位、型別不符皆 throw ImportPlanError（訊息不含值）。
 */
export function convertRow(table, row) {
  const columns = columnsOf(table);
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new ImportPlanError(table, null, '資料列必須是物件');
  }
  const known = new Set(columns.map(c => c.name));
  for (const key of Object.keys(row)) {
    if (!known.has(key)) throw new ImportPlanError(table, key, '不是已定義的欄位');
  }
  return columns.map(column => {
    if (!Object.hasOwn(row, column.name)) throw new ImportPlanError(table, column.name, '缺少欄位');
    return convertValue(table, column, row[column.name]);
  });
}

function countOf(counts, table) {
  if (!counts || typeof counts !== 'object') return null;
  const value = counts instanceof Map ? counts.get(table) : Object.hasOwn(counts, table) ? counts[table] : undefined;
  if (typeof value === 'bigint') return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * 依 tableOrder() 比對來源與目標筆數（物件或 Map，值為非負整數）。
 * 回傳不相符的 {table, source, target} 清單；缺少或無效的筆數以 null 表示並視為不相符。
 */
export function compareCounts(source, target) {
  const mismatches = [];
  for (const table of TABLE_ORDER) {
    const s = countOf(source, table);
    const t = countOf(target, table);
    if (s === null || t === null || s !== t) mismatches.push({ table, source: s, target: t });
  }
  return mismatches;
}
