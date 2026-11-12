// 測試用：以 SQLite Schema 建立來源檔，供 SQLite_Importer 測試（tasks 7.2–7.6、18.4）。
// OLD_SQLITE_SCHEMA 取自遷移前的 server/accounts.js（SCHEMA）與 server/ledger.js（LEDGER_SCHEMA）。
// HARDEN_SQLITE_SCHEMA 取自 security-harden（09e2e05）的 server/accounts.js（SCHEMA，含 invites 新欄位、
// settings、receipt_ai_usage 與擴充後的 cover_kind）、server/ledger.js 與 server/security-events.js
// （SECURITY_EVENTS_SCHEMA）。
// 測試輔助檔，非 App_Server 執行期程式碼，因此可匯入 bun:sqlite。
import { Database } from 'bun:sqlite';
import { tableOrder, columnNames } from '../../server/db/import-plan.js';

export const OLD_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','member')), password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, destination TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  description TEXT NOT NULL, note TEXT NOT NULL,
  cover_kind TEXT NOT NULL CHECK (cover_kind IN ('camp','mountain','lake','night')),
  status TEXT NOT NULL CHECK (status IN ('planning','completed')),
  revision INTEGER NOT NULL, people_count INTEGER NOT NULL, state_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trip_members (
  trip_id TEXT NOT NULL REFERENCES trips(id), user_id TEXT NOT NULL REFERENCES users(id),
  person_id TEXT NOT NULL, joined_at INTEGER NOT NULL,
  PRIMARY KEY (trip_id, user_id), UNIQUE (trip_id, person_id)
);
CREATE INDEX IF NOT EXISTS trip_members_user ON trip_members(user_id);
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id), created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS invites_trip ON invites(trip_id);
CREATE TABLE IF NOT EXISTS trip_deletions (
  trip_id TEXT PRIMARY KEY REFERENCES trips(id), deleted_by TEXT NOT NULL REFERENCES users(id), deleted_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trip_ledgers (
  trip_id TEXT PRIMARY KEY REFERENCES trips(id), revision INTEGER NOT NULL CHECK (revision >= 1),
  ledger_json TEXT NOT NULL, requests_json TEXT NOT NULL, updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at INTEGER NOT NULL
);`;

export const HARDEN_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','member')), password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, destination TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  description TEXT NOT NULL, note TEXT NOT NULL,
  cover_kind TEXT NOT NULL CHECK (cover_kind IN ('camp','mountain','lake','night','forest','beach','sunrise')),
  status TEXT NOT NULL CHECK (status IN ('planning','completed')),
  revision INTEGER NOT NULL, people_count INTEGER NOT NULL, state_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trip_members (
  trip_id TEXT NOT NULL REFERENCES trips(id), user_id TEXT NOT NULL REFERENCES users(id),
  person_id TEXT NOT NULL, joined_at INTEGER NOT NULL,
  PRIMARY KEY (trip_id, user_id), UNIQUE (trip_id, person_id)
);
CREATE INDEX IF NOT EXISTS trip_members_user ON trip_members(user_id);
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id), created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER,
  used_at INTEGER, used_by TEXT REFERENCES users(id),
  id TEXT
);
CREATE INDEX IF NOT EXISTS invites_trip ON invites(trip_id);
CREATE UNIQUE INDEX IF NOT EXISTS invites_id ON invites(id);
CREATE TABLE IF NOT EXISTS trip_deletions (
  trip_id TEXT PRIMARY KEY REFERENCES trips(id), deleted_by TEXT NOT NULL REFERENCES users(id), deleted_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS receipt_ai_usage (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), trip_id TEXT NOT NULL,
  model_id TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL CHECK (outcome IN ('pending','success','error','timeout'))
);
CREATE INDEX IF NOT EXISTS receipt_ai_usage_at ON receipt_ai_usage(at);
CREATE INDEX IF NOT EXISTS receipt_ai_usage_user_at ON receipt_ai_usage(user_id, at);
CREATE TABLE IF NOT EXISTS trip_ledgers (
  trip_id TEXT PRIMARY KEY REFERENCES trips(id), revision INTEGER NOT NULL CHECK (revision >= 1),
  ledger_json TEXT NOT NULL, requests_json TEXT NOT NULL, updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, client TEXT NOT NULL, username TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('invalid_input','rate_limited','deleted_account','bad_credentials'))
);
CREATE INDEX IF NOT EXISTS security_events_at ON security_events(at);
CREATE INDEX IF NOT EXISTS security_events_user_at ON security_events(username, at);
CREATE TABLE IF NOT EXISTS security_alerts (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('username','global')),
  username TEXT NOT NULL, client TEXT NOT NULL, count INTEGER NOT NULL,
  window_start INTEGER NOT NULL, window_end INTEGER NOT NULL, acknowledged_at INTEGER, acknowledged_by TEXT
);
CREATE INDEX IF NOT EXISTS security_alerts_open ON security_alerts(acknowledged_at, at);`;

export const SQLITE_SCHEMAS = Object.freeze({ old: OLD_SQLITE_SCHEMA, harden: HARDEN_SQLITE_SCHEMA });

/**
 * 建立 SQLite 來源檔並寫入資料。只寫入該 Schema 實際存在的資料表與欄位：舊版 Schema 沒有的
 * 0002 資料表與 invites 新欄位會被略過（data 中的對應值不寫入）。
 * @param {string} path 檔案路徑（應位於測試暫存目錄）
 * @param {Record<string, object[]>} [data] 每表的資料列（以欄位名為鍵；整數可為 number 或 bigint）
 * @param {{wal?:boolean, keepOpen?:boolean, schema?:'old'|'harden'}} [options]
 *   wal：使用 WAL journal；keepOpen：回傳仍開啟的 Database（WAL 內容尚未 checkpoint，用來產生含 -wal 的來源）；
 *   schema：'old'（預設，security-harden 之前）或 'harden'（security-harden 版）。
 * @returns {Database|null}
 */
export function buildSqliteFixture(path, data = {}, { wal = false, keepOpen = false, schema = 'old' } = {}) {
  const ddl = SQLITE_SCHEMAS[schema];
  if (!ddl) throw new Error(`未知的 SQLite fixture schema：${schema}`);
  const db = new Database(path, { create: true, safeIntegers: true });
  db.exec('PRAGMA foreign_keys = ON;');
  if (wal) db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  db.exec(ddl);
  const tables = new Set(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
  db.transaction(() => {
    for (const table of tableOrder()) {
      if (!tables.has(table)) continue;
      const actual = new Set(db.query(`PRAGMA table_info("${table}")`).all().map(r => r.name));
      const cols = columnNames(table).filter(c => actual.has(c));
      const insert = db.query(`INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      for (const row of data[table] ?? []) insert.run(...cols.map(c => row[c] ?? null));
    }
  })();
  if (keepOpen) return db;
  db.close();
  return null;
}
