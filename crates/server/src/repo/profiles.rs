//! `app.profiles`：註冊時建立帳號的資料（需求 3.1、3.6、3.8、3.9），以及管理後台的帳號查詢與鎖（需求 35.1、
//! 36.3、39.3、40.3，design 5.3、5.4）。讀取 Session 帳號資料的 `load_profile()` 在 `extract`。

use lm_core::admin::AdminUserDto;
use lm_core::ids::UserId;
use lm_core::model::Role;
use sqlx::postgres::PgRow;
use sqlx::types::Uuid;
use sqlx::{PgExecutor, PgPool, Row as _};
use time::OffsetDateTime;

use super::PgTx;
use crate::invites::timestamp;

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

/// `AdminUserDto` 需要的欄位（design 5.3）；`trip_count` 只算沒有被刪除的旅行（需求 35.1）。一個 Account 在一趟旅行
/// 最多綁定一位旅伴，所以 `count(t.id)` 就是旅行數。之後接 `where …` 與 `group by p.user_id`。
const ADMIN_USER_SELECT: &str =
    "select p.user_id, p.username, p.display_name, p.role, p.created_at, p.disabled_at, \
            count(t.id)::int as trip_count \
     from app.profiles p \
       left join app.people pe on pe.user_id = p.user_id \
       left join app.trips t on t.id = pe.trip_id and t.deleted_at is null";

/// 一個帳號的 `AdminUserDto`（需求 35.1 的單一帳號格式）；沒有這個帳號時是 `None`。Disabled_Account 也讀得到。
pub async fn admin_user<'e>(
    conn: impl PgExecutor<'e>,
    id: UserId,
) -> sqlx::Result<Option<AdminUserDto>> {
    let row = sqlx::query(&format!(
        "{ADMIN_USER_SELECT} where p.user_id = $1 group by p.user_id"
    ))
    .bind(id.0)
    .fetch_optional(conn)
    .await?;
    row.as_ref().map(admin_user_row).transpose()
}

/// `GET /api/admin/users` 的每一個帳號，依帳號名稱遞增（需求 35.1）。
pub async fn list_admin_users(db: &PgPool) -> sqlx::Result<Vec<AdminUserDto>> {
    let rows = sqlx::query(&format!(
        "{ADMIN_USER_SELECT} group by p.user_id order by p.username"
    ))
    .fetch_all(db)
    .await?;
    rows.iter().map(admin_user_row).collect()
}

/// 沒有被刪除的旅行總數（需求 35.1）。
pub async fn trip_total(db: &PgPool) -> sqlx::Result<u32> {
    let total =
        sqlx::query_scalar::<_, i64>("select count(*) from app.trips where deleted_at is null")
            .fetch_one(db)
            .await?;
    u32::try_from(total)
        .map_err(|_| sqlx::Error::Decode(format!("trip total out of range: {total}").into()))
}

/// 在 `tx` 中鎖住 `id` 的 `app.profiles` 列（`FOR UPDATE`，持有到交易結束），使修改、停用與啟用依序執行（需求
/// 39.3、40.3）；沒有這個帳號時是 `false`。
pub async fn lock_profile(tx: &mut PgTx, id: UserId) -> sqlx::Result<bool> {
    let found =
        sqlx::query_scalar::<_, i32>("select 1 from app.profiles where user_id = $1 for update")
            .bind(id.0)
            .fetch_optional(&mut **tx)
            .await?;
    Ok(found.is_some())
}

/// 有效的 Admin 數：角色為 admin 而且不是 Disabled_Account（design 5.1）。在 `lock_first_admin()` 之後呼叫，使兩位
/// Admin 同時互相降級或停用時，後執行的那一個讀到正確的數量。
pub async fn active_admin_count(tx: &mut PgTx) -> sqlx::Result<u32> {
    let count = sqlx::query_scalar::<_, i64>(
        "select count(*) from app.profiles where role = 'admin' and disabled_at is null",
    )
    .fetch_one(&mut **tx)
    .await?;
    u32::try_from(count)
        .map_err(|_| sqlx::Error::Decode(format!("admin count out of range: {count}").into()))
}

/// 刪除 `id` 在 Auth_Service 的每一個登入工作階段（需求 36.3、40.3，design 5.1）：`auth.refresh_tokens` 以
/// `on delete cascade` 參照 `auth.sessions`，所以之前取得的每個 refresh token 都無法再換發。回傳刪除的列數。
pub async fn delete_auth_sessions(db: &PgPool, id: UserId) -> sqlx::Result<u64> {
    let result = sqlx::query("delete from auth.sessions where user_id = $1")
        .bind(id.0)
        .execute(db)
        .await?;
    Ok(result.rows_affected())
}

/// `ADMIN_USER_SELECT` 的一列；app.profiles 的 CHECK 只允許 admin 與 member。
fn admin_user_row(row: &PgRow) -> sqlx::Result<AdminUserDto> {
    let role = row.try_get::<String, _>("role")?;
    let trip_count = row.try_get::<i32, _>("trip_count")?;
    Ok(AdminUserDto {
        id: UserId(row.try_get::<Uuid, _>("user_id")?),
        username: row.try_get("username")?,
        display_name: row.try_get("display_name")?,
        role: Role::parse(&role).ok_or_else(|| {
            sqlx::Error::Decode(
                format!("app.profiles.role is neither admin nor member: {role:?}").into(),
            )
        })?,
        created_at: timestamp(row.try_get::<OffsetDateTime, _>("created_at")?),
        disabled_at: row
            .try_get::<Option<OffsetDateTime>, _>("disabled_at")?
            .map(timestamp),
        trip_count: u32::try_from(trip_count).map_err(|_| {
            sqlx::Error::Decode(format!("trip count out of range: {trip_count}").into())
        })?,
    })
}

/// `insert_profile()` 因為 `app.profiles` 已有相同的帳號名稱而失敗。Auth_Service 的 email 不會重複，所以這只發生在
/// 既有帳號的 email 不是 `<帳號名稱>@<目前的 LM_AUTH_EMAIL_DOMAIN>` 時，例如它在 `LM_AUTH_EMAIL_DOMAIN` 改變之前建立。
pub fn is_username_taken(error: &sqlx::Error) -> bool {
    error.as_database_error().is_some_and(|database| {
        database.is_unique_violation() && database.constraint() == Some(USERNAME_UNIQUE)
    })
}
