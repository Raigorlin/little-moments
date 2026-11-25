//! Audit_Log（`app.audit`，需求 41，design 5.5）：寫入一筆操作紀錄，以及 `GET /api/admin/audit` 的分頁讀取。
//!
//! # 寫入（需求 41.2）
//!
//! 每一筆都在操作本身的交易中以 `write()` 寫入，所以操作失敗或回滾時紀錄也不存在；寫入失敗時整個交易回滾。只有重設
//! 密碼的主要效果在 Auth_Service，不在交易中，所以在刪除登入工作階段成功之後以 `write_one()` 寫入。操作代碼以這裡的
//! `&'static str` 常數傳入，與遷移檔 `20260301000000_admin.sql` 中 `app.audit.action` 的 check 清單相同。
//!
//! | 操作代碼 | 寫入的位置 |
//! | --- | --- |
//! | `account.register` | `auth` 的註冊交易（新增 `app.profiles` 之後） |
//! | `invite.join` | `invites::join_in_tx()`（已是成員而直接回傳時不寫） |
//! | `trip.create`、`trip.delete` | `trips` 的建立（實際建立時）與刪除交易 |
//! | `invite.create`、`invite.revoke` | `invites` 的建立與撤銷交易 |
//! | `admin.user.*` | `admin` 的修改、重設密碼、停用與啟用 |
//! | `admin.settings.public_signup` | `settings::set_public_signup()` |
//!
//! 目標與補充說明以寫入當下的文字保存（例如「@帳號名稱」、旅行名稱），以 Char_Count 截到 120 與 200 字（與 check
//! 約束相同）；不含密碼、token 或 Invite_Link 的 token。Command、登入、換發與登出不寫入。
//!
//! # 讀取（需求 41.3、41.4）
//!
//! `page()` 只讀最新的 200 筆：依時間由新到舊、時間相同時 id 較大的在前，每頁 20 筆；以 `left join app.profiles`
//! 取得執行者的名字，執行者已不存在時是 `None`。更早的紀錄保留在 Database 中，但不回傳。

use lm_core::admin::{
    audit_page_count, ActorDto, AuditEntryDto, AuditPage, AUDIT_MAX_PAGES, AUDIT_PAGE_SIZE,
};
use lm_core::ids::UserId;
use lm_core::text::char_count;
use sqlx::PgPool;
use time::OffsetDateTime;

use crate::invites::timestamp;
use crate::repo::PgTx;

/// 註冊帳號。
pub const ACCOUNT_REGISTER: &str = "account.register";
/// 修改帳號。
pub const ADMIN_USER_UPDATE: &str = "admin.user.update";
/// 重設密碼。
pub const ADMIN_USER_PASSWORD_RESET: &str = "admin.user.password_reset";
/// 停用帳號。
pub const ADMIN_USER_DISABLE: &str = "admin.user.disable";
/// 啟用帳號。
pub const ADMIN_USER_ENABLE: &str = "admin.user.enable";
/// 變更公開註冊。
pub const ADMIN_SETTINGS_PUBLIC_SIGNUP: &str = "admin.settings.public_signup";
/// 建立旅行。
pub const TRIP_CREATE: &str = "trip.create";
/// 刪除旅行。
pub const TRIP_DELETE: &str = "trip.delete";
/// 建立邀請連結。
pub const INVITE_CREATE: &str = "invite.create";
/// 撤銷邀請連結。
pub const INVITE_REVOKE: &str = "invite.revoke";
/// 以邀請連結加入旅行。
pub const INVITE_JOIN: &str = "invite.join";

/// `app.audit.target` 的上限（Char_Count）。
const TARGET_MAX_CHARS: usize = 120;
/// `app.audit.detail` 的上限（Char_Count）。
const DETAIL_MAX_CHARS: usize = 200;

/// 在呼叫端的交易 `tx` 中寫入一筆（需求 41.2）；`actor` 是執行的 Account。
pub async fn write(
    tx: &mut PgTx,
    actor: Option<UserId>,
    action: &'static str,
    target: &str,
    detail: &str,
) -> sqlx::Result<()> {
    insert(&mut **tx, actor, action, target, detail).await
}

/// 不在交易中寫入一筆：只用於重設密碼（主要效果在 Auth_Service，見模組說明）。
pub async fn write_one(
    db: &PgPool,
    actor: UserId,
    action: &'static str,
    target: &str,
    detail: &str,
) -> sqlx::Result<()> {
    insert(db, Some(actor), action, target, detail).await
}

async fn insert<'e>(
    conn: impl sqlx::PgExecutor<'e>,
    actor: Option<UserId>,
    action: &'static str,
    target: &str,
    detail: &str,
) -> sqlx::Result<()> {
    sqlx::query("insert into app.audit (actor_id, action, target, detail) values ($1, $2, $3, $4)")
        .bind(actor.map(|actor| actor.0))
        .bind(action)
        .bind(truncate(target, TARGET_MAX_CHARS))
        .bind(truncate(detail, DETAIL_MAX_CHARS))
        .execute(conn)
        .await?;
    Ok(())
}

/// 以 Char_Count 截到 `max` 字。
fn truncate(text: &str, max: usize) -> String {
    if char_count(text) <= max {
        text.to_owned()
    } else {
        text.chars().take(max).collect()
    }
}

/// 最新 200 筆中的第 `page` 頁（從 1 起，見模組說明）；`page` 大於總頁數時是 `None`（需求 41.4）。
pub async fn page(db: &PgPool, page: u32) -> sqlx::Result<Option<AuditPage>> {
    let total = sqlx::query_scalar::<_, i64>("select count(*) from app.audit")
        .fetch_one(db)
        .await?;
    let page_count = audit_page_count(u64::try_from(total).unwrap_or(0));
    if page == 0 || page > page_count {
        return Ok(None);
    }
    type EntryRow = (
        OffsetDateTime,
        Option<String>,
        Option<String>,
        String,
        String,
        String,
    );
    let rows = sqlx::query_as::<_, EntryRow>(
        "select a.at, p.username, p.display_name, a.action, a.target, a.detail \
         from (select * from app.audit order by at desc, id desc limit $1) a \
           left join app.profiles p on p.user_id = a.actor_id \
         order by a.at desc, a.id desc \
         offset $2 limit $3",
    )
    .bind(i64::from(AUDIT_PAGE_SIZE * AUDIT_MAX_PAGES))
    .bind(i64::from((page - 1) * AUDIT_PAGE_SIZE))
    .bind(i64::from(AUDIT_PAGE_SIZE))
    .fetch_all(db)
    .await?;
    let entries = rows
        .into_iter()
        .map(
            |(at, username, display_name, action, target, detail)| AuditEntryDto {
                at: timestamp(at),
                actor: username
                    .zip(display_name)
                    .map(|(username, display_name)| ActorDto {
                        username,
                        display_name,
                    }),
                action,
                target,
                detail,
            },
        )
        .collect();
    Ok(Some(AuditPage {
        entries,
        page,
        page_count,
    }))
}
