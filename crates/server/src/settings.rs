//! 公開註冊的設定（需求 37，design 5.5）：Registration_Policy 存在 `app.settings` 的 `public_signup` 這一列，
//! `LM_PUBLIC_SIGNUP` 只是沒有這一列時的初始值（Registration_Seed）。
//!
//! 決定的順序是 lm-core 的 `admin::resolve_public_signup()`：`app.settings` 的值（`stored`），其次是
//! `LM_PUBLIC_SIGNUP` 的 `true`／`false`（`seed`），都沒有時是開放（`default`）。每次呼叫都讀 Database、不快取，
//! 所以 Admin 變更之後的下一個註冊請求就依新的值處理，Blue/Green 兩個 lm-server 程序之間也不必處理失效（需求 37.2）。

use lm_core::admin::{resolve_public_signup, ActorDto, Policy, PublicSignupSetting};
use lm_core::ids::UserId;
use sqlx::PgPool;
use time::OffsetDateTime;

use crate::audit;
use crate::config::Config;
use crate::invites::timestamp;
use crate::repo::PgTx;

/// `app.settings.key`。
const PUBLIC_SIGNUP_KEY: &str = "public_signup";

/// `app.settings` 中 `public_signup` 這一列：值、修改時間，以及修改者的帳號名稱與 Display_Name（修改者已刪除時是
/// `None`）。
type StoredRow = (String, OffsetDateTime, Option<String>, Option<String>);

/// 目前的 Registration_Policy（需求 37.2）：每次呼叫都讀 Database；沒有 `public_signup` 這一列時用
/// Registration_Seed。不附邀請的註冊在呼叫 Auth_Service 之前呼叫它。
pub async fn public_signup(db: &PgPool, cfg: &Config) -> sqlx::Result<Policy> {
    let stored = read(db).await?.map(|row| policy(&row.0)).transpose()?;
    Ok(resolve_public_signup(stored, cfg.public_signup).0)
}

/// `GET /api/admin/settings` 的 `public_signup`（需求 37.3）：來源為 `stored` 時附修改時間與修改者。
pub async fn public_signup_setting(db: &PgPool, cfg: &Config) -> sqlx::Result<PublicSignupSetting> {
    let Some((value, updated_at, username, display_name)) = read(db).await? else {
        let (value, source) = resolve_public_signup(None, cfg.public_signup);
        return Ok(PublicSignupSetting {
            value,
            source,
            updated_at: None,
            updated_by: None,
        });
    };
    let (value, source) = resolve_public_signup(Some(policy(&value)?), cfg.public_signup);
    Ok(PublicSignupSetting {
        value,
        source,
        updated_at: Some(timestamp(updated_at)),
        updated_by: username
            .zip(display_name)
            .map(|(username, display_name)| ActorDto {
                username,
                display_name,
            }),
    })
}

/// 在 `tx` 中新增或取代 `public_signup`，記錄修改時間與 `actor`，並寫入 `admin.settings.public_signup` 的 Audit_Log
/// （需求 37.4、41.2）。值與目前相同時也寫入（來源因此改為 `stored`）。
pub async fn set_public_signup(tx: &mut PgTx, actor: UserId, value: Policy) -> sqlx::Result<()> {
    sqlx::query(
        "insert into app.settings (key, value, updated_at, updated_by) values ($1, $2, now(), $3) \
         on conflict (key) do update \
           set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by",
    )
    .bind(PUBLIC_SIGNUP_KEY)
    .bind(value.as_str())
    .bind(actor.0)
    .execute(&mut **tx)
    .await?;
    let detail = match value {
        Policy::Open => "開放",
        Policy::Closed => "關閉",
    };
    audit::write(
        tx,
        Some(actor),
        audit::ADMIN_SETTINGS_PUBLIC_SIGNUP,
        "公開註冊",
        detail,
    )
    .await
}

async fn read(db: &PgPool) -> sqlx::Result<Option<StoredRow>> {
    sqlx::query_as::<_, StoredRow>(
        "select s.value, s.updated_at, p.username, p.display_name \
         from app.settings s left join app.profiles p on p.user_id = s.updated_by \
         where s.key = $1",
    )
    .bind(PUBLIC_SIGNUP_KEY)
    .fetch_optional(db)
    .await
}

/// `app.settings.value`；遷移檔的 check 只允許 `open` 與 `closed`。
fn policy(value: &str) -> sqlx::Result<Policy> {
    Policy::parse(value).ok_or_else(|| {
        sqlx::Error::Decode(
            format!("app.settings.public_signup is neither open nor closed: {value:?}").into(),
        )
    })
}
