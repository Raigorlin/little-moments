//! `app.profiles`：註冊時建立帳號的資料（需求 3.1、3.6、3.8、3.9）。讀取帳號資料的 `load_profile()` 在 `extract`。

use lm_core::ids::UserId;
use lm_core::model::Role;

use super::PgTx;

/// `app.profiles.username` 的唯一約束（`username text not null unique` 的預設名稱）。
const USERNAME_UNIQUE: &str = "profiles_username_key";

/// 決定第一個帳號的交易層級 advisory lock：持有到交易結束，所以同時進行的註冊依序讀取 `profile_count()`，只有一個
/// 讀到 0（需求 3.9）。READ COMMITTED 的每個語句各取一次快照，取得鎖之後的 `profile_count()` 看得到前一個持有者已
/// 提交的帳號。
pub async fn lock_first_admin(tx: &mut PgTx) -> sqlx::Result<()> {
    sqlx::query("select pg_advisory_xact_lock(hashtext('app.first_admin'))")
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// `app.profiles` 的列數；是 0 時建立的帳號是 admin（需求 3.8）。在 `lock_first_admin()` 之後呼叫。
pub async fn profile_count(tx: &mut PgTx) -> sqlx::Result<i64> {
    sqlx::query_scalar("select count(*) from app.profiles")
        .fetch_one(&mut **tx)
        .await
}

/// 新增帳號的資料。`username` 已有其他帳號使用時，錯誤是 `is_username_taken()` 的唯一約束違反（需求 3.6）。
pub async fn insert_profile(
    tx: &mut PgTx,
    user: UserId,
    username: &str,
    display_name: &str,
    role: Role,
) -> sqlx::Result<()> {
    sqlx::query(
        "insert into app.profiles (user_id, username, display_name, role) values ($1, $2, $3, $4)",
    )
    .bind(user.0)
    .bind(username)
    .bind(display_name)
    .bind(role.as_str())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// `insert_profile()` 因為 `app.profiles` 已有相同的帳號名稱而失敗。Auth_Service 的 email 不會重複，所以這只發生在
/// 既有帳號的 email 不是 `<帳號名稱>@<目前的 LM_AUTH_EMAIL_DOMAIN>` 時，例如它在 `LM_AUTH_EMAIL_DOMAIN` 改變之前建立。
pub fn is_username_taken(error: &sqlx::Error) -> bool {
    error.as_database_error().is_some_and(|database| {
        database.is_unique_violation() && database.constraint() == Some(USERNAME_UNIQUE)
    })
}
