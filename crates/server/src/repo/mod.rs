//! 儲存層（design 3.2）：lm-server 對 Database 的查詢。只使用執行期檢查的 `sqlx::query` 與 `query_as`，不使用需要
//! 編譯期連線的 macros（需求 1.7）。
//!
//! | 模組 | 內容 |
//! | --- | --- |
//! | `profiles` | 註冊使用的 `app.profiles`（任務 14.1） |
//! | `trips` | 旅行列的鎖與 Head：`lock_trip()`、`read_head()`、`person_of()` |
//! | `load` | `load_trip()`：每張表一個 SELECT 讀出整趟旅行的 Trip_State |
//! | `write` | `write_changes()`：把一個 Change_Set 的變化寫回各資料表；`insert_bound_person()` |
//! | `changes` | Change_Log：`finish()`、`changeset_by_command()`、`changes_after()`，以及 `snapshot()` |
//!
//! lm-server 是 Database 唯一的寫入者，而且每個寫入旅行內容的交易都先以 `lock_trip()` 鎖住旅行列，所以同一趟旅行的
//! 提交依序進行，Seq 連續、不跳號；旅行資料、Change_Log 與 Head 都只存在 Database，不在記憶體保存（需求 1.11）。
mod changes;
mod load;
mod profiles;
mod trips;
mod write;

pub use changes::{changes_after, changeset_by_command, finish, snapshot};
pub use load::load_trip;
pub use profiles::{insert_profile, is_username_taken, lock_first_admin, profile_count};
pub use trips::{lock_trip, person_of, read_head, TripHead};
pub use write::{insert_bound_person, write_changes};

/// 一個資料庫交易（`PgPool::begin()` 的結果）；以 `&mut **tx` 執行查詢。
pub type PgTx = sqlx::Transaction<'static, sqlx::Postgres>;

/// Seq、Ordinal 與 Row_Version 在 Database 中是 `bigint`。
pub(crate) fn to_i64(value: u64, what: &str) -> sqlx::Result<i64> {
    i64::try_from(value)
        .map_err(|_| sqlx::Error::Encode(format!("{what} {value} does not fit in bigint").into()))
}

/// `bigint` 的 Seq、Ordinal 與 Row_Version；不會是負數。
fn to_u64(value: i64, what: &str) -> sqlx::Result<u64> {
    u64::try_from(value)
        .map_err(|_| sqlx::Error::Decode(format!("{what} is negative: {value}").into()))
}
