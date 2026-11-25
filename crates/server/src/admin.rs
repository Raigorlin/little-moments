//! Admin_Endpoint（任務 30，需求 34 至 41，design 5.3 與 5.4）：帳號的查詢、修改、重設密碼、停用與啟用，公開註冊的
//! 設定，以及操作紀錄。請求與回應的型別、搜尋以外的限制規則都在 lm-core 的 `admin`。
//!
//! | 端點 | 身分 | 成功時 |
//! | --- | --- | --- |
//! | `GET /api/admin/users` | `AdminUser` | 200 `AdminUsersResponse`，依帳號名稱遞增 |
//! | `PATCH /api/admin/users/{id}` | `AdminUser` | 200 `AdminUserDto` |
//! | `POST /api/admin/users/{id}/password` | `AdminUser` | 200 `{}` |
//! | `POST /api/admin/users/{id}/disable` | `AdminUser` | 200 `AdminUserDto` |
//! | `POST /api/admin/users/{id}/enable` | `AdminUser` | 200 `AdminUserDto` |
//! | `GET /api/admin/settings` | `AdminUser` | 200 `AdminSettingsResponse` |
//! | `PATCH /api/admin/settings` | `AdminUser` | 200 `AdminSettingsResponse` |
//! | `GET /api/admin/audit?page=N` | `AdminUser` | 200 `AuditPage` |
//!
//! 每個處理函式的第一個擷取器是 `AdminUser`，`ApiPath`、`ApiQuery` 與 `ApiJson` 在它之後，所以判斷順序是 404／405
//! → 401 → 403 `admin_required` → 400（需求 34.2）。角色在每個請求從 `app.profiles` 讀取，不看 token（需求 34.1）。
//! 管理後台不寫 Trip_State、不寫 Change_Log、不推送。
//!
//! # 帳號的寫入（design 5.4）
//!
//! - 修改、停用：一個交易中依序取得 `app.first_admin` advisory lock（與註冊第一個帳號相同）、以 `FOR UPDATE` 鎖住
//!   目標的 `app.profiles` 列、計算有效的 Admin 數，再以 lm-core 的 `check_role_change()`／`check_disable()` 判斷，
//!   使兩位 Admin 同時互相降級或停用時，後執行的那一個得到 409（需求 39.3、40.3）。
//! - 修改：只改 `app.profiles` 的 Display_Name 與角色，不改旅伴名字（需求 39.4）；Admin 被改為 member 時撤銷他
//!   建立的、所屬旅行中他不是 Trip_Member 的 Active_Invite（需求 39.5）。沒有任何變化時不寫入 Audit_Log。
//! - 重設密碼：以 Auth_Service 的 admin API 設定密碼，再刪除這個帳號在 `auth.sessions` 的每一列，兩步都成功之後才
//!   寫入 Audit_Log（需求 36.3–36.6）。
//! - 停用：`disabled_at` 為空值時設為 `now()` 並寫入 Audit_Log，已停用時不變；提交之後刪除這個帳號在
//!   `auth.sessions` 的每一列（再送一次時再刪一次，需求 40.3、40.5）。啟用只把 `disabled_at` 設為空值，已啟用時不變
//!   （需求 40.6）。
//!
//! # 錯誤（design 5.4、5.7）
//!
//! | 情況 | 狀態 | `code` | `field` | 訊息 |
//! | --- | --- | --- | --- | --- |
//! | `{id}` 不是 UUID 或沒有這個帳號 | 404 | `user_not_found` | `null` | 找不到這個帳號。 |
//! | 修改：兩個欄位都沒有，或請求內容格式不正確（需求 5.9） | 400 | `invalid_request` | `null` | 資料格式不正確。 |
//! | 修改：顯示名稱不符合需求 3.4 | 400 | 見 lm-core 的 `account` | `display_name` | 見 lm-core 的 `account` |
//! | 修改：變更自己的角色 | 403 | `self_role_change` | `null` | 不能變更自己的角色。 |
//! | 停用：自己 | 403 | `self_disable` | `null` | 不能停用自己的帳號。 |
//! | 修改、停用：最後一位有效的 Admin | 409 | `last_admin` | `null` | 至少需要保留一位管理員。 |
//! | 重設密碼：新密碼不符合需求 3.5 | 400 | `invalid_password` | `password` | 見 lm-core 的 `account` |
//! | 重設密碼：Auth_Service 拒絕、無法連線或逾時 | 500 | `password_reset_unavailable` | `null` | 暫時無法重設密碼，請稍後再試。 |
//! | 重設密碼：刪除登入工作階段失敗 | 500 | `password_reset_signout_failed` | `null` | 新密碼已設定，但其他裝置可能仍維持登入，請再按一次『設定新密碼』。 |
//! | 停用：提交後刪除登入工作階段失敗 | 500 | `account_disable_signout_failed` | `null` | 帳號已停用，但其他裝置可能仍維持登入，請再按一次『停用帳號』。 |
//! | 設定：不是 `{"public_signup": "open"}` 或 `{"public_signup": "closed"}` | 400 | `invalid_setting` | `public_signup` | 公開註冊只能設為開放或關閉。 |
//! | 操作紀錄：`page` 不是 1 至 10 的整數，或大於總頁數 | 400 | `invalid_page` | `page` | 沒有這一頁的操作紀錄。 |
//! | Database 錯誤（包括 Audit_Log 寫入失敗，整個交易回滾） | 500 | `internal_error` | `null` | 伺服器暫時無法處理，請稍後再試。 |
//!
//! # 記錄（需求 34.10、36.7）
//!
//! 每個成功的寫入以 info 層級記下操作名稱、執行的 Admin 的 Account id 與目標（Account id 或設定名稱）。密碼只傳給
//! Auth_Service，不寫進記錄、錯誤回應或 Audit_Log；`ResetPasswordRequest` 的 `Debug` 不印出密碼，lm-supabase 的
//! `AuthError` 也不含密碼。

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use lm_core::account;
use lm_core::admin::{
    check_disable, check_role_change, AdminRejection, AdminSettingsResponse, AdminUserDto,
    AdminUsersResponse, AuditPage, Policy, ResetPasswordRequest, UpdateUserRequest,
    AUDIT_MAX_PAGES,
};
use lm_core::ids::UserId;
use lm_core::model::Role;
use serde::Deserialize;
use sqlx::types::{JsonValue, Uuid};

use crate::audit;
use crate::error::ApiError;
use crate::extract::{AdminUser, ApiJson, ApiPath, ApiQuery};
use crate::repo;
use crate::settings;
use crate::state::AppState;

/// `PATCH /api/admin/settings` 唯一的欄位（需求 37.4）。
const PUBLIC_SIGNUP_FIELD: &str = "public_signup";

/// `GET /api/admin/users`：每一個帳號與沒有被刪除的旅行總數（需求 35.1）。
pub async fn list_users(
    State(st): State<AppState>,
    _admin: AdminUser,
) -> Result<Json<AdminUsersResponse>, ApiError> {
    let users = repo::list_admin_users(&st.db).await?;
    let trip_total = repo::trip_total(&st.db).await?;
    Ok(Json(AdminUsersResponse { users, trip_total }))
}

/// `PATCH /api/admin/users/{id}`：修改 Display_Name 與角色（需求 39.3–39.5，見模組說明）。
pub async fn update_user(
    State(st): State<AppState>,
    AdminUser(admin): AdminUser,
    ApiPath(id): ApiPath<String>,
    ApiJson(request): ApiJson<UpdateUserRequest>,
) -> Result<Json<AdminUserDto>, ApiError> {
    let id = parse_user_id(&id).ok_or_else(user_not_found)?;
    let mut tx = st.db.begin().await?;
    repo::lock_first_admin(&mut tx).await?;
    if !repo::lock_profile(&mut tx, id).await? {
        return Err(user_not_found());
    }
    let UpdateUserRequest { display_name, role } = request;
    if display_name.is_none() && role.is_none() {
        return Err(ApiError::invalid_request());
    }
    // 需求 3.4：回傳經 Participant_Name 的名稱
    let display_name = display_name
        .as_deref()
        .map(account::check_display_name)
        .transpose()?;
    let target = repo::admin_user(&mut *tx, id)
        .await?
        .ok_or_else(user_not_found)?;
    let new_role = role.unwrap_or(target.role);
    let active_admins = repo::active_admin_count(&mut tx).await?;
    check_role_change(admin.id, &target, new_role, active_admins).map_err(rejected)?;

    let new_name = display_name.filter(|name| *name != target.display_name);
    let role_changed = new_role != target.role;
    if new_name.is_none() && !role_changed {
        // 沒有任何變化：不寫入，也不寫 Audit_Log（需求 41.2）
        tx.commit().await?;
        return Ok(Json(target));
    }
    sqlx::query("update app.profiles set display_name = $2, role = $3 where user_id = $1")
        .bind(id.0)
        .bind(new_name.as_deref().unwrap_or(&target.display_name))
        .bind(new_role.as_str())
        .execute(&mut *tx)
        .await?;
    let revoked = if target.role == Role::Admin && new_role == Role::Member {
        revoke_unjoined_invites(&mut tx, id).await?
    } else {
        0
    };
    let detail = update_detail(new_name.as_deref(), target.role, new_role, revoked);
    audit::write(
        &mut tx,
        Some(admin.id),
        audit::ADMIN_USER_UPDATE,
        &format!("@{}", target.username),
        &detail,
    )
    .await?;
    let updated = repo::admin_user(&mut *tx, id)
        .await?
        .ok_or_else(user_not_found)?;
    tx.commit().await?;
    tracing::info!(actor = %admin.id, target = %id, revoked, "admin.user.update");
    Ok(Json(updated))
}

/// 需求 39.5：撤銷 `id` 建立的、所屬旅行中他不是 Trip_Member 的每個 Active_Invite；回傳撤銷的數量。
async fn revoke_unjoined_invites(tx: &mut repo::PgTx, id: UserId) -> sqlx::Result<u64> {
    let result = sqlx::query(
        "update app.invites i set revoked_at = now() \
         where i.created_by = $1 and i.revoked_at is null and i.used_at is null \
           and i.expires_at > now() \
           and not exists (select 1 from app.people p where p.trip_id = i.trip_id and p.user_id = $1)",
    )
    .bind(id.0)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected())
}

/// `admin.user.update` 的補充說明（需求 41.2）：顯示名稱與角色的變化以「；」連接，撤銷邀請時另加撤銷的數量。
fn update_detail(new_name: Option<&str>, old_role: Role, new_role: Role, revoked: u64) -> String {
    let mut parts = Vec::new();
    if let Some(name) = new_name {
        parts.push(format!("顯示名稱改為「{name}」"));
    }
    if old_role != new_role {
        parts.push(format!(
            "角色：{} → {}",
            role_label(old_role),
            role_label(new_role)
        ));
    }
    if revoked > 0 {
        parts.push(format!("撤銷 {revoked} 個邀請連結"));
    }
    parts.join("；")
}

/// 角色的中文名稱（需求 41.2）。
fn role_label(role: Role) -> &'static str {
    match role {
        Role::Admin => "管理員",
        Role::Member => "成員",
    }
}

/// `POST /api/admin/users/{id}/password`：設定新密碼並登出每個裝置（需求 36.3–36.6，見模組說明）。
pub async fn reset_password(
    State(st): State<AppState>,
    AdminUser(admin): AdminUser,
    ApiPath(id): ApiPath<String>,
    ApiJson(request): ApiJson<ResetPasswordRequest>,
) -> Result<Json<JsonValue>, ApiError> {
    let id = parse_user_id(&id).ok_or_else(user_not_found)?;
    let target = repo::admin_user(&st.db, id)
        .await?
        .ok_or_else(user_not_found)?;
    // 需求 3.5：原樣檢查；不通過時 400，field 是 password
    account::check_password(&request.password)?;
    st.auth
        .update_user_password(target.id, &request.password)
        .await
        .map_err(|error| {
            // AuthError 不含密碼
            tracing::error!(%error, target = %target.id, "admin password reset: auth update failed");
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "password_reset_unavailable",
                "暫時無法重設密碼，請稍後再試。",
            )
        })?;
    repo::delete_auth_sessions(&st.db, target.id)
        .await
        .map_err(|error| {
            tracing::error!(%error, target = %target.id, "admin password reset: sign-out failed");
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "password_reset_signout_failed",
                "新密碼已設定，但其他裝置可能仍維持登入，請再按一次『設定新密碼』。",
            )
        })?;
    audit::write_one(
        &st.db,
        admin.id,
        audit::ADMIN_USER_PASSWORD_RESET,
        &format!("@{}", target.username),
        "",
    )
    .await?;
    tracing::info!(actor = %admin.id, target = %target.id, "admin.user.password_reset");
    Ok(Json(JsonValue::Object(Default::default())))
}

/// `POST /api/admin/users/{id}/disable`：停用帳號並登出每個裝置（需求 40.3、40.5，見模組說明）。不讀請求內容。
pub async fn disable_user(
    State(st): State<AppState>,
    AdminUser(admin): AdminUser,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<AdminUserDto>, ApiError> {
    let id = parse_user_id(&id).ok_or_else(user_not_found)?;
    let mut tx = st.db.begin().await?;
    repo::lock_first_admin(&mut tx).await?;
    if !repo::lock_profile(&mut tx, id).await? {
        return Err(user_not_found());
    }
    let target = repo::admin_user(&mut *tx, id)
        .await?
        .ok_or_else(user_not_found)?;
    let active_admins = repo::active_admin_count(&mut tx).await?;
    check_disable(admin.id, &target, active_admins).map_err(rejected)?;
    let user = if target.is_disabled() {
        // 已停用：不改變 disabled_at、不寫 Audit_Log
        target
    } else {
        sqlx::query("update app.profiles set disabled_at = now() where user_id = $1")
            .bind(id.0)
            .execute(&mut *tx)
            .await?;
        audit::write(
            &mut tx,
            Some(admin.id),
            audit::ADMIN_USER_DISABLE,
            &format!("@{}", target.username),
            "",
        )
        .await?;
        repo::admin_user(&mut *tx, id)
            .await?
            .ok_or_else(user_not_found)?
    };
    tx.commit().await?;
    // 提交之後 AuthUser、登入與換發就拒絕這個帳號；再刪除它的登入工作階段（需求 40.4、40.5）
    repo::delete_auth_sessions(&st.db, id)
        .await
        .map_err(|error| {
            tracing::error!(%error, target = %id, "admin disable: sign-out failed");
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "account_disable_signout_failed",
                "帳號已停用，但其他裝置可能仍維持登入，請再按一次『停用帳號』。",
            )
        })?;
    tracing::info!(actor = %admin.id, target = %id, "admin.user.disable");
    Ok(Json(user))
}

/// `POST /api/admin/users/{id}/enable`：啟用帳號（需求 40.6）。不讀請求內容，也不需要最後一位 Admin 的檢查。
pub async fn enable_user(
    State(st): State<AppState>,
    AdminUser(admin): AdminUser,
    ApiPath(id): ApiPath<String>,
) -> Result<Json<AdminUserDto>, ApiError> {
    let id = parse_user_id(&id).ok_or_else(user_not_found)?;
    let mut tx = st.db.begin().await?;
    if !repo::lock_profile(&mut tx, id).await? {
        return Err(user_not_found());
    }
    let target = repo::admin_user(&mut *tx, id)
        .await?
        .ok_or_else(user_not_found)?;
    let user = if target.is_disabled() {
        sqlx::query("update app.profiles set disabled_at = null where user_id = $1")
            .bind(id.0)
            .execute(&mut *tx)
            .await?;
        audit::write(
            &mut tx,
            Some(admin.id),
            audit::ADMIN_USER_ENABLE,
            &format!("@{}", target.username),
            "",
        )
        .await?;
        repo::admin_user(&mut *tx, id)
            .await?
            .ok_or_else(user_not_found)?
    } else {
        // 已啟用：不改變、不寫 Audit_Log
        target
    };
    tx.commit().await?;
    tracing::info!(actor = %admin.id, target = %id, "admin.user.enable");
    Ok(Json(user))
}

/// `GET /api/admin/settings`：公開註冊目前的值與來源（需求 37.3）。
pub async fn get_settings(
    State(st): State<AppState>,
    _admin: AdminUser,
) -> Result<Json<AdminSettingsResponse>, ApiError> {
    let public_signup = settings::public_signup_setting(&st.db, &st.config).await?;
    Ok(Json(AdminSettingsResponse { public_signup }))
}

/// `PATCH /api/admin/settings`：儲存公開註冊（需求 37.4、37.5）。內容以 JSON 值接收再由 `parse_public_signup()`
/// 解析，使 `"OPEN"`、`true`、缺少欄位與多出欄位都得到 `invalid_setting`；JSON 語法錯誤仍是 `invalid_request`。
pub async fn patch_settings(
    State(st): State<AppState>,
    AdminUser(admin): AdminUser,
    ApiJson(body): ApiJson<JsonValue>,
) -> Result<Json<AdminSettingsResponse>, ApiError> {
    let value = parse_public_signup(&body).ok_or_else(invalid_setting)?;
    let mut tx = st.db.begin().await?;
    settings::set_public_signup(&mut tx, admin.id, value).await?;
    tx.commit().await?;
    tracing::info!(
        actor = %admin.id,
        target = PUBLIC_SIGNUP_FIELD,
        value = value.as_str(),
        "admin.settings.public_signup"
    );
    let public_signup = settings::public_signup_setting(&st.db, &st.config).await?;
    Ok(Json(AdminSettingsResponse { public_signup }))
}

/// `GET /api/admin/audit` 的查詢參數：`page` 以字串接收再由 `parse_page()` 解析，使 `0`、`11`、`abc` 都得到
/// `invalid_page`。
#[derive(Debug, Deserialize)]
pub struct AuditQuery {
    page: Option<String>,
}

/// `GET /api/admin/audit?page=N`：最新 200 筆中的第 N 頁（需求 41.3、41.4）。
pub async fn list_audit(
    State(st): State<AppState>,
    _admin: AdminUser,
    ApiQuery(query): ApiQuery<AuditQuery>,
) -> Result<Json<AuditPage>, ApiError> {
    let page = parse_page(query.page.as_deref()).ok_or_else(invalid_page)?;
    audit::page(&st.db, page)
        .await?
        .map(Json)
        .ok_or_else(invalid_page)
}

/// `PATCH /api/admin/settings` 的內容（需求 37.4、37.5）：只有 `public_signup` 一個欄位，值是字串 `open` 或
/// `closed`；其他都是 `None`。
pub fn parse_public_signup(body: &JsonValue) -> Option<Policy> {
    let fields = body.as_object()?;
    if fields.len() != 1 {
        return None;
    }
    Policy::parse(fields.get(PUBLIC_SIGNUP_FIELD)?.as_str()?)
}

/// `page` 查詢參數（需求 41.3、41.4）：沒有時是 1；必須是 1 至 10 的十進位整數（只有數字），其他都是 `None`。是否
/// 大於總頁數由 `audit::page()` 判斷。
pub fn parse_page(page: Option<&str>) -> Option<u32> {
    let Some(text) = page else {
        return Some(1);
    };
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse::<u32>()
        .ok()
        .filter(|page| (1..=AUDIT_MAX_PAGES).contains(page))
}

/// 路徑參數 `{id}` 的帳號 id；不是 UUID 時是 `None`（404 `user_not_found`）。
fn parse_user_id(text: &str) -> Option<UserId> {
    text.parse::<Uuid>().ok().map(UserId)
}

/// 404：`{id}` 不是 UUID 或沒有這個帳號（design 5.7）。
fn user_not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "user_not_found", "找不到這個帳號。")
}

/// 400：公開註冊的設定不正確（需求 37.5）。
fn invalid_setting() -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "invalid_setting",
        "公開註冊只能設為開放或關閉。",
    )
    .with_field(PUBLIC_SIGNUP_FIELD)
}

/// 400：沒有這一頁的操作紀錄（需求 41.4）。
fn invalid_page() -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "invalid_page",
        "沒有這一頁的操作紀錄。",
    )
    .with_field("page")
}

/// lm-core 的 `AdminRejection`（design 5.3）：`LastAdmin` 是 409，其他是 403。
fn rejected(rejection: AdminRejection) -> ApiError {
    let status = match rejection {
        AdminRejection::LastAdmin => StatusCode::CONFLICT,
        AdminRejection::SelfRoleChange | AdminRejection::SelfDisable => StatusCode::FORBIDDEN,
    };
    ApiError::new(status, rejection.code(), rejection.message())
}

#[cfg(test)]
mod tests {
    use lm_core::admin::Policy;
    use sqlx::types::JsonValue;

    use super::{parse_page, parse_public_signup};

    fn json(text: &str) -> JsonValue {
        text.parse().expect("test JSON")
    }

    #[test]
    fn public_signup_accepts_exactly_open_or_closed() {
        assert_eq!(
            parse_public_signup(&json(r#"{"public_signup":"open"}"#)),
            Some(Policy::Open)
        );
        assert_eq!(
            parse_public_signup(&json(r#"{"public_signup":"closed"}"#)),
            Some(Policy::Closed)
        );
    }

    #[test]
    fn public_signup_rejects_other_bodies() {
        for body in [
            r#"{"public_signup":"OPEN"}"#,
            r#"{"public_signup":true}"#,
            r#"{"public_signup":null}"#,
            r#"{}"#,
            r#"{"public_signup":"open","extra":1}"#,
            r#"{"other":"open"}"#,
            r#""open""#,
            r#"["open"]"#,
            "null",
        ] {
            assert_eq!(parse_public_signup(&json(body)), None, "{body}");
        }
    }

    #[test]
    fn page_defaults_to_one_and_accepts_one_to_ten() {
        assert_eq!(parse_page(None), Some(1));
        assert_eq!(parse_page(Some("1")), Some(1));
        assert_eq!(parse_page(Some("10")), Some(10));
    }

    #[test]
    fn page_rejects_other_values() {
        for page in ["0", "11", "abc", "1.5", "", "-1", "+1", " 1", "99999999999"] {
            assert_eq!(parse_page(Some(page)), None, "{page:?}");
        }
    }
}
