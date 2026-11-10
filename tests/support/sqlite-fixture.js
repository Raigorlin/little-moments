// 測試用：以舊版（PostgreSQL 遷移前）SQLite Schema 建立來源檔，供 SQLite_Importer 測試（tasks 7.2–7.6）。
// OLD_SQLITE_SCHEMA 取自遷移前的 server/accounts.js（SCHEMA）與 server/ledger.js（LEDGER_SCHEMA）。
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

/**
 * 建立舊版 Schema 的 SQLite 檔並寫入資料。
 * @param {string} path 檔案路徑（應位於測試暫存目錄）
 * @param {Record<string, object[]>} [data] 每表的資料列（以欄位名為鍵；整數可為 number 或 bigint）
 * @param {{wal?:boolean, keepOpen?:boolean}} [options]
 *   wal：使用 WAL journal；keepOpen：回傳仍開啟的 Database（WAL 內容尚未 checkpoint，用來產生含 -wal 的來源）。
 * @returns {Database|null}
 */
export function buildSqliteFixture(path, data = {}, { wal = false, keepOpen = false } = {}) {
  const db = new Database(path, { create: true, safeIntegers: true });
  db.exec('PRAGMA foreign_keys = ON;');
  if (wal) db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  db.exec(OLD_SQLITE_SCHEMA);
  db.transaction(() => {
    for (const table of tableOrder()) {
      const cols = columnNames(table);
      const insert = db.query(`INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      for (const row of data[table] ?? []) insert.run(...cols.map(c => row[c] ?? null));
    }
  })();
  if (keepOpen) return db;
  db.close();
  return null;
}
