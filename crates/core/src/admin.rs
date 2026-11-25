//! 管理後台（需求 34 至 41，design 5.3）：Admin_Endpoint 的請求與回應型別，以及不做 IO 的規則：帳號的搜尋比對
//! （需求 35.4）、統計列（需求 35.6）、公開註冊的來源（需求 37.2、37.3）、修改角色與停用的限制（需求 39.3、
//! 40.3）、操作紀錄的中文名稱與頁數（需求 41.2 至 41.5），以及台灣時間的顯示（需求 37.6、41.5）。
//!
//! 時間欄位是 RFC 3339 的 UTC 字串（含毫秒），與 `api::InviteListItem` 相同：lm-core 不啟用 `time` 的 serde
//! feature，所以不使用 `OffsetDateTime` 欄位；畫面以 `taipei_minute()` 轉成台灣時間。
use std::fmt;

use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::macros::offset;
use time::OffsetDateTime;
use unicode_normalization::UnicodeNormalization;

use crate::ids::UserId;
use crate::model::Role;
use crate::text::trim_white;

/// 操作紀錄每頁的筆數（需求 41.3）。
pub const AUDIT_PAGE_SIZE: u32 = 20;
/// 操作紀錄最多的頁數：只回傳最新的 200 筆（需求 41.3）。
pub const AUDIT_MAX_PAGES: u32 = 10;

/// `GET /api/admin/users` 中的一個帳號，也是修改、停用與啟用的回應（需求 35.1）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdminUserDto {
    pub id: UserId,
    pub username: String,
    pub display_name: String,
    pub role: Role,
    /// 建立時間（RFC 3339 UTC）。
    pub created_at: String,
    /// 停用時間（RFC 3339 UTC）；不是 Disabled_Account 時是 `None`（需求 40.1）。
    pub disabled_at: Option<String>,
    /// 他是 Trip_Member 的、沒有被刪除的旅行數量。
    pub trip_count: u32,
}

impl AdminUserDto {
    /// 是 Disabled_Account（需求 40.1）。
    pub fn is_disabled(&self) -> bool {
        self.disabled_at.is_some()
    }

    /// 是有效的 Admin：角色為 admin 而且不是 Disabled_Account（design 5.1）。
    pub fn is_active_admin(&self) -> bool {
        self.role == Role::Admin && !self.is_disabled()
    }
}

/// `GET /api/admin/users` 的回應：依帳號名稱遞增，另附沒有被刪除的旅行總數（需求 35.1）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdminUsersResponse {
    pub users: Vec<AdminUserDto>,
    pub trip_total: u32,
}

/// `PATCH /api/admin/users/{id}` 的請求：至少要有一個欄位（需求 39.3）；LM_Web 只送出有變更的欄位（需求 39.2）。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateUserRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<Role>,
}

/// `POST /api/admin/users/{id}/password` 的請求（需求 36.3）。`Debug` 不印出密碼（需求 36.7）。
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResetPasswordRequest {
    pub password: String,
}

impl fmt::Debug for ResetPasswordRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ResetPasswordRequest")
            .field("password", &format_args!("<redacted>"))
            .finish()
    }
}

/// Registration_Policy：公開註冊開放或關閉（需求 37.1）。線上格式與 `app.settings.value` 都是 `open`／`closed`。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Policy {
    Open,
    Closed,
}

impl Policy {
    /// 線上格式與資料庫中的字串。
    pub const fn as_str(&self) -> &'static str {
        match self {
            Policy::Open => "open",
            Policy::Closed => "closed",
        }
    }

    /// `as_str()` 的反向；大小寫不同或其他字串是 `None`（需求 37.5）。
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "open" => Some(Policy::Open),
            "closed" => Some(Policy::Closed),
            _ => None,
        }
    }
}

/// 公開註冊目前的值從哪裡來（需求 37.3）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SettingSource {
    /// Admin 儲存過（`app.settings` 有 `public_signup` 這一列）。
    Stored,
    /// 有設定 `LM_PUBLIC_SIGNUP`（Registration_Seed）。
    Seed,
    /// 沒有設定 `LM_PUBLIC_SIGNUP`：開放。
    Default,
}

/// 操作紀錄的執行者與公開註冊的最後修改者。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActorDto {
    pub username: String,
    pub display_name: String,
}

/// 公開註冊的設定（需求 37.3）：來源為 `stored` 時才有修改時間（RFC 3339 UTC）與修改者；修改者的帳號已刪除時
/// `updated_by` 是 `None`。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicSignupSetting {
    pub value: Policy,
    pub source: SettingSource,
    pub updated_at: Option<String>,
    pub updated_by: Option<ActorDto>,
}

/// `GET`／`PATCH /api/admin/settings` 的回應（需求 37.3、37.4）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdminSettingsResponse {
    pub public_signup: PublicSignupSetting,
}

/// 操作紀錄的一筆（需求 41.3）：執行者已不存在時 `actor` 是 `None`。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEntryDto {
    /// 時間（RFC 3339 UTC）。
    pub at: String,
    pub actor: Option<ActorDto>,
    /// 操作代碼（需求 41.2），例如 `admin.user.password_reset`。
    pub action: String,
    pub target: String,
    pub detail: String,
}

/// `GET /api/admin/audit?page=N` 的回應（需求 41.3）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditPage {
    pub entries: Vec<AuditEntryDto>,
    pub page: u32,
    pub page_count: u32,
}

/// 統計列（需求 35.6）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AdminStats {
    /// 帳號總數。
    pub accounts: u32,
    /// 使用中：不是 Disabled_Account 的帳號數。
    pub active: u32,
    /// 已停用。
    pub disabled: u32,
    /// 管理員：有效的 Admin 數。
    pub admins: u32,
    /// 沒有被刪除的旅行總數。
    pub trips: u32,
}

/// 修改角色與停用被拒絕的原因（需求 39.3、40.3，design 5.7）。LM_Server 把 `SelfRoleChange` 與 `SelfDisable`
/// 回應為 403，`LastAdmin` 為 409。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AdminRejection {
    /// 目標是自己而且角色改變。
    SelfRoleChange,
    /// 目標是自己。
    SelfDisable,
    /// 會使網站沒有有效的 Admin。
    LastAdmin,
}

impl AdminRejection {
    /// 錯誤回應的 `code`。
    pub const fn code(&self) -> &'static str {
        match self {
            AdminRejection::SelfRoleChange => "self_role_change",
            AdminRejection::SelfDisable => "self_disable",
            AdminRejection::LastAdmin => "last_admin",
        }
    }

    /// 錯誤回應的 `message`。
    pub const fn message(&self) -> &'static str {
        match self {
            AdminRejection::SelfRoleChange => "不能變更自己的角色。",
            AdminRejection::SelfDisable => "不能停用自己的帳號。",
            AdminRejection::LastAdmin => "至少需要保留一位管理員。",
        }
    }
}

/// 需求 37.2、37.3：`app.settings` 的值優先，其次是 Registration_Seed（`LM_PUBLIC_SIGNUP` 的 true／false），
/// 都沒有時是開放（`default`）。
pub fn resolve_public_signup(
    stored: Option<Policy>,
    seed: Option<bool>,
) -> (Policy, SettingSource) {
    match (stored, seed) {
        (Some(policy), _) => (policy, SettingSource::Stored),
        (None, Some(true)) => (Policy::Open, SettingSource::Seed),
        (None, Some(false)) => (Policy::Closed, SettingSource::Seed),
        (None, None) => (Policy::Open, SettingSource::Default),
    }
}

/// 需求 35.4：搜尋文字與 Display_Name 經 Trim_White、NFKC 與小寫，帳號名稱原樣；帳號名稱或 Display_Name 包含
/// 搜尋文字時符合。搜尋文字經 Trim_White 後是空字串時一律符合（需求 35.3）。
pub fn account_matches(query: &str, username: &str, display_name: &str) -> bool {
    let query = fold(query);
    query.is_empty() || username.contains(&query) || fold(display_name).contains(&query)
}

/// Trim_White、NFKC 與小寫（需求 35.4）。
fn fold(text: &str) -> String {
    trim_white(text).nfkc().collect::<String>().to_lowercase()
}

/// 需求 35.6：以 `GET /api/admin/users` 的結果計算統計列。
pub fn admin_stats(resp: &AdminUsersResponse) -> AdminStats {
    let count = |keep: fn(&AdminUserDto) -> bool| {
        u32::try_from(resp.users.iter().filter(|user| keep(user)).count()).unwrap_or(u32::MAX)
    };
    AdminStats {
        accounts: count(|_| true),
        active: count(|user| !user.is_disabled()),
        disabled: count(AdminUserDto::is_disabled),
        admins: count(AdminUserDto::is_active_admin),
        trips: resp.trip_total,
    }
}

/// 需求 39.3：目標是自己而且角色改變時是 `SelfRoleChange`；把有效的 Admin 改為 member、而 `active_admins`
/// （有效的 Admin 數，包括目標）不超過 1 時是 `LastAdmin`。
pub fn check_role_change(
    actor: UserId,
    target: &AdminUserDto,
    new_role: Role,
    active_admins: u32,
) -> Result<(), AdminRejection> {
    if new_role == target.role {
        return Ok(());
    }
    if target.id == actor {
        return Err(AdminRejection::SelfRoleChange);
    }
    if target.is_active_admin() && new_role == Role::Member && active_admins <= 1 {
        return Err(AdminRejection::LastAdmin);
    }
    Ok(())
}

/// 需求 40.3：目標是自己時是 `SelfDisable`；目標是有效的 Admin、而 `active_admins` 不超過 1 時是 `LastAdmin`。
/// 已停用的帳號通過（LM_Server 不改變它，也不寫入紀錄）。
pub fn check_disable(
    actor: UserId,
    target: &AdminUserDto,
    active_admins: u32,
) -> Result<(), AdminRejection> {
    if target.id == actor {
        return Err(AdminRejection::SelfDisable);
    }
    if target.is_active_admin() && active_admins <= 1 {
        return Err(AdminRejection::LastAdmin);
    }
    Ok(())
}

/// 需求 41.2、41.5：操作代碼的中文名稱；不認得的代碼是 `None`，畫面原樣顯示代碼。
pub fn audit_action_label(action: &str) -> Option<&'static str> {
    Some(match action {
        "account.register" => "註冊帳號",
        "admin.user.update" => "修改帳號",
        "admin.user.password_reset" => "重設密碼",
        "admin.user.disable" => "停用帳號",
        "admin.user.enable" => "啟用帳號",
        "admin.settings.public_signup" => "變更公開註冊",
        "trip.create" => "建立旅行",
        "trip.delete" => "刪除旅行",
        "invite.create" => "建立邀請連結",
        "invite.revoke" => "撤銷邀請連結",
        "invite.join" => "以邀請連結加入旅行",
        _ => return None,
    })
}

/// 需求 41.3：最新 200 筆以內的筆數除以 20 後無條件進位，最少 1 頁。
pub fn audit_page_count(total: u64) -> u32 {
    let max = u64::from(AUDIT_PAGE_SIZE * AUDIT_MAX_PAGES);
    let pages = total.min(max).div_ceil(u64::from(AUDIT_PAGE_SIZE));
    // pages 不超過 AUDIT_MAX_PAGES
    u32::try_from(pages).unwrap_or(AUDIT_MAX_PAGES).max(1)
}

/// 需求 37.6、41.5：RFC 3339 的時間以台灣時間（UTC+8）顯示成「YYYY/MM/DD HH:MM」，不依瀏覽器的時區；
/// 無法解析時是 `None`（畫面原樣顯示）。
pub fn taipei_minute(rfc3339: &str) -> Option<String> {
    let at = OffsetDateTime::parse(rfc3339, &Rfc3339)
        .ok()?
        .to_offset(offset!(+8));
    Some(format!(
        "{:04}/{:02}/{:02} {:02}:{:02}",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute()
    ))
}
