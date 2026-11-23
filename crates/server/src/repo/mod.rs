//! 儲存層（design 3.2）：lm-server 對 Database 的查詢。只使用執行期檢查的 `sqlx::query` 與 `query_as`，不使用需要
//! 編譯期連線的 macros（需求 1.7）。
//!
//! 目前只有註冊使用的 `app.profiles`（任務 14.1，`profiles`）；旅行、Change_Log 與 Snapshot 的查詢由任務 15.1 加入。

mod profiles;

pub use profiles::{insert_profile, is_username_taken, lock_first_admin, profile_count};

/// 一個資料庫交易（`PgPool::begin()` 的結果）；以 `&mut **tx` 執行查詢。
pub type PgTx = sqlx::Transaction<'static, sqlx::Postgres>;
