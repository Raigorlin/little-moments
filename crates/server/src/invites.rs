//! 邀請連結（任務 16.1，需求 30；design 3.1 的表與 A8）：建立、列出、撤銷、預覽與加入，以及附邀請的註冊
//! （`auth`）使用的 `check_usable()` 與 `join_in_tx()`。
//!
//! | 端點 | 身分 | 成功時 |
//! | --- | --- | --- |
//! | `GET /api/trips/{id}/invites` | `AuthUser` | 200 `InviteListItem[]` |
//! | `POST /api/trips/{id}/invites` | `AuthUser` | 200 `InviteCreated` |
//! | `POST /api/trips/{id}/invites/{invite_id}/revoke` | `AuthUser` | 200 `{}` |
//! | `GET /api/invites/{token}` | Public_Endpoint（`Option<AuthUser>`） | 200 `InvitePreview` |
//! | `POST /api/invites/{token}/join` | `AuthUser` | 200 `JoinResponse` |
//!
//! # Active_Invite 與 token
//!
//! Active_Invite 是 `used_at`、`revoked_at` 都是 NULL，而且 `expires_at` 晚於 Database 當下時間
//! （`clock_timestamp()`，不是交易開始的 `now()`，所以等待鎖之後也以當下時間判斷）的 `app.invites` 列（需求 30.1）。
//! token 是 32 個隨機位元組的十六進位（64 個字元），只在建立的回應中回傳；Database 只保存它的 SHA-256 十六進位
//! （`token_hash`），任何回應都不含雜湊值（需求 30.2）。預覽與加入以送來的 token 計算雜湊值查詢，token 寫在路徑中，
//! 所以記錄一律不含路徑與 token（`main` 也不加 `TraceLayer`）。
//!
//! # 旅行的端點（需求 6.2、6.3、6.5、30.3–30.8）
//!
//! 先以 `repo::lock_trip()`（建立、撤銷）或 `repo::read_head()`（列出）確認旅行存在而且沒有被刪除，再以當下 Database
//! 的 `person_of()` 與 LM_Core 的 `capabilities()` 判斷：不能邀請（不是 Trip_Member 也不是 Admin）時 404「找不到這趟
//! 旅行。」，與旅行不存在相同。之後：
//!
//! - 建立：旅行列的鎖讓同一趟旅行的建立依序執行，所以同時送達的請求也不會超過上限。這趟旅行已有 20 個 Active_Invite
//!   時 409 `trip_invite_limit`；Collaborator（不是 Trip_Manager）自己已有 5 個時 409 `member_invite_limit`。到期時間
//!   是建立時間加 7 天。不改變 Trip_State，不產生 Change_Set（需求 10.1）。
//! - 列出：Trip_Manager 列出全部、Collaborator 只列出自己建立的 Active_Invite，依建立時間由新到舊，附建立者目前的
//!   Display_Name。
//! - 撤銷：`invite_id` 不是這趟旅行的 Active_Invite（包括不是 UUID、屬於其他旅行、已使用、已撤銷或已過期）時 404
//!   `invite_invalid`；Collaborator 撤銷別人建立的連結時 403 `deny_invite_revoke`，連結不變。
//!
//! # 預覽與加入（需求 30.9–30.16）
//!
//! 預覽不加鎖：連結必須沒有撤銷、沒有到期，而且旅行沒有被刪除；已使用的連結只對已登入的 Trip_Member 預覽。回應只有
//! 旅行名稱、目的地、起訖日期與建立者的 Display_Name，有 Valid_Access_Token 時另有 `already_member`，沒有時是
//! `null`（需求 5.8、30.16）。
//!
//! 加入（`join_in_tx()`，以連結註冊也使用）在一個交易中：
//!
//! 1. 以雜湊值找到連結所屬的旅行，`repo::lock_trip()` 鎖住旅行列；旅行已被刪除（包括在等待鎖期間提交的刪除）時無效。
//! 2. 鎖住之後再讀一次連結（`FOR UPDATE`）：READ COMMITTED 的每個語句都取新的快照，所以同時進行、先提交的加入或撤銷
//!    都看得到。已撤銷或已過期時無效。
//! 3. 使用者已是 Trip_Member 時直接回傳旅行 id，不檢查名字與角色、不新增旅伴、不標記已使用（需求 30.11）。
//! 4. 已使用時無效（需求 30.14）。
//! 5. `repo::load_trip()` 讀出整趟旅行，以 LM_Core 的 `join_trip()` 檢查名字與角色（需求 30.15）並新增綁定的旅伴
//!    （顏色依需求 19.8，刪除所有出發確認）。Seq、Row_Version 與 Ordinal 以 `commands::versioned_changes()` 指定，
//!    與 `execute()` 相同。新的旅伴以 `repo::insert_bound_person()` 帶 `user_id` 寫入，其他變化以
//!    `repo::write_changes()` 寫入；連結標記為已使用；`repo::finish()` 寫入 Change_Log（trigger 推送，需求 10.1）。
//!
//! 呼叫端負責提交；任何一步失敗時交易被丟棄、回滾，連結仍未使用。
//!
//! | 情況 | 狀態 | `code` | 訊息 |
//! | --- | --- | --- | --- |
//! | 連結不存在、已撤銷、已過期、旅行已被刪除，或已使用而使用者不是 Trip_Member（需求 30.13、6.16） | 404 | `invite_invalid` | 邀請連結無效或已過期。 |
//! | 旅伴名字或角色不符合需求 19.1–19.7 | 400 或 409 | 見 lm-core 的 `Rejection` | 見 lm-core |
use std::collections::HashMap;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use lm_core::api::{InviteCreated, InviteListItem, InvitePreview, JoinRequest, JoinResponse};
use lm_core::apply::join_trip;
use lm_core::ids::{CommandId, PersonId, TripId, UserId};
use lm_core::limits::{COLLABORATOR_ACTIVE_INVITES_MAX, INVITE_TTL_DAYS, TRIP_ACTIVE_INVITES_MAX};
use lm_core::model::{Date, Row, Seq};
use lm_core::rules::{capabilities, Capabilities};
use lm_core::sync::{Change, ChangeSet};
use sha2::{Digest, Sha256};
use sqlx::types::{JsonValue, Uuid};
use sqlx::PgPool;
use time::{OffsetDateTime, UtcOffset};

use crate::commands::versioned_changes;
use crate::error::ApiError;
use crate::extract::{ApiJson, ApiPath, AuthUser, TripPath};
use crate::repo::{self, PgTx};
use crate::state::{AppState, Clock};
use crate::trips::random_uuid;

/// 需求 30.13 的訊息。
const INVITE_INVALID: &str = "邀請連結無效或已過期。";

/// 需求 30.3。
const TRIP_INVITE_LIMIT: &str = "每趟旅行最多 20 個有效邀請連結。";

/// 需求 30.4。
const MEMBER_INVITE_LIMIT: &str = "每位旅伴在每趟旅行最多 5 個有效邀請連結。";

/// 需求 30.8。
const DENY_INVITE_REVOKE: &str = "只有建立連結的人、主辦人或管理員可以撤銷邀請。";

/// Active_Invite 的條件（見模組說明），`i` 是 `app.invites`。
const ACTIVE: &str =
    "i.used_at is null and i.revoked_at is null and i.expires_at > clock_timestamp()";

/// 撤銷路徑中的邀請連結 id 參數名稱。
const INVITE_ID_PARAM: &str = "invite_id";

// ── 旅行的端點 ──

/// `POST /api/trips/{id}/invites`：建立邀請連結（見模組說明）。
pub async fn create(
    State(st): State<AppState>,
    user: AuthUser,
    TripPath(trip): TripPath,
) -> Result<Json<InviteCreated>, ApiError> {
    let mut tx = st.db.begin().await?;
    // 旅行列的鎖讓同一趟旅行的建立依序執行，計數不會被同時送達的請求超過
    let head = repo::lock_trip(&mut tx, trip)
        .await?
        .ok_or_else(ApiError::trip_not_found)?;
    let me = repo::person_of(&mut *tx, trip, user.id).await?;
    let caps = inviter(head.owner, &user, me)?;

    let (trip_active, mine_active) = sqlx::query_as::<_, (i64, i64)>(&format!(
        "select count(*), count(*) filter (where i.created_by = $2) \
         from app.invites i where i.trip_id = $1 and {ACTIVE}"
    ))
    .bind(trip.0)
    .bind(user.id.0)
    .fetch_one(&mut *tx)
    .await?;
    if at_limit(trip_active, TRIP_ACTIVE_INVITES_MAX) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "trip_invite_limit",
            TRIP_INVITE_LIMIT,
        ));
    }
    if !caps.can_manage && at_limit(mine_active, COLLABORATOR_ACTIVE_INVITES_MAX) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "member_invite_limit",
            MEMBER_INVITE_LIMIT,
        ));
    }

    let id = random_uuid();
    let token = hex::encode(rand::random::<[u8; 32]>());
    let expires_at = sqlx::query_scalar::<_, OffsetDateTime>(
        "insert into app.invites (id, trip_id, token_hash, created_by, created_at, expires_at) \
         values ($1, $2, $3, $4, now(), now() + make_interval(days => $5)) \
         returning expires_at",
    )
    .bind(id)
    .bind(trip.0)
    .bind(token_hash(&token))
    .bind(user.id.0)
    .bind(i32::try_from(INVITE_TTL_DAYS).map_err(ApiError::internal)?)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    tracing::info!(%trip, user = %user.id, invite = %id, "invite created");

    Ok(Json(InviteCreated {
        id,
        url_path: format!("/invite/{token}"),
        token,
        expires_at: timestamp(expires_at),
    }))
}

/// `GET /api/trips/{id}/invites`：Trip_Manager 看全部、Collaborator 看自己建立的 Active_Invite（見模組說明）。
pub async fn list(
    State(st): State<AppState>,
    user: AuthUser,
    TripPath(trip): TripPath,
) -> Result<Json<Vec<InviteListItem>>, ApiError> {
    let head = repo::read_head(&st.db, trip)
        .await?
        .ok_or_else(ApiError::trip_not_found)?;
    let me = repo::person_of(&st.db, trip, user.id).await?;
    let caps = inviter(head.owner, &user, me)?;
    let creator = (!caps.can_manage).then_some(user.id.0);

    let rows = sqlx::query_as::<_, (Uuid, String, OffsetDateTime, OffsetDateTime)>(&format!(
        "select i.id, p.display_name, i.created_at, i.expires_at \
         from app.invites i join app.profiles p on p.user_id = i.created_by \
         where i.trip_id = $1 and ($2::uuid is null or i.created_by = $2) and {ACTIVE} \
         order by i.created_at desc, i.id"
    ))
    .bind(trip.0)
    .bind(creator)
    .fetch_all(&st.db)
    .await?;
    let items = rows
        .into_iter()
        .map(
            |(id, creator_name, created_at, expires_at)| InviteListItem {
                id,
                creator_name,
                created_at: timestamp(created_at),
                expires_at: timestamp(expires_at),
            },
        )
        .collect();
    Ok(Json(items))
}

/// `POST /api/trips/{id}/invites/{invite_id}/revoke`：撤銷這趟旅行的一個 Active_Invite（見模組說明）。
pub async fn revoke(
    State(st): State<AppState>,
    user: AuthUser,
    TripPath(trip): TripPath,
    ApiPath(params): ApiPath<HashMap<String, String>>,
) -> Result<Json<JsonValue>, ApiError> {
    let mut tx = st.db.begin().await?;
    let head = repo::lock_trip(&mut tx, trip)
        .await?
        .ok_or_else(ApiError::trip_not_found)?;
    let me = repo::person_of(&mut *tx, trip, user.id).await?;
    let caps = inviter(head.owner, &user, me)?;

    let Some(invite) = params
        .get(INVITE_ID_PARAM)
        .and_then(|value| value.parse::<Uuid>().ok())
    else {
        return Err(invite_invalid());
    };
    let creator = sqlx::query_scalar::<_, Uuid>(&format!(
        "select i.created_by from app.invites i \
         where i.id = $1 and i.trip_id = $2 and {ACTIVE} for update"
    ))
    .bind(invite)
    .bind(trip.0)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(invite_invalid)?;
    if !caps.can_manage && creator != user.id.0 {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "deny_invite_revoke",
            DENY_INVITE_REVOKE,
        ));
    }
    sqlx::query("update app.invites set revoked_at = now() where id = $1")
        .bind(invite)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    tracing::info!(%trip, user = %user.id, %invite, "invite revoked");

    Ok(Json(JsonValue::Object(Default::default())))
}

/// 能建立、列出與撤銷邀請連結的身分（需求 6.2、6.5）：不能邀請時 404「找不到這趟旅行。」。
fn inviter(owner: UserId, user: &AuthUser, me: Option<PersonId>) -> Result<Capabilities, ApiError> {
    let caps = capabilities(owner, user.id, user.role, me);
    if caps.can_invite {
        Ok(caps)
    } else {
        Err(ApiError::trip_not_found())
    }
}

/// 已有 `count` 個 Active_Invite 時，再建立一個會超過 `max`。
fn at_limit(count: i64, max: usize) -> bool {
    usize::try_from(count).map_or(true, |count| count >= max)
}

// ── 預覽與加入 ──

/// `GET /api/invites/{token}`：邀請預覽（見模組說明）。
pub async fn preview(
    State(st): State<AppState>,
    user: Option<AuthUser>,
    ApiPath(token): ApiPath<String>,
) -> Result<Json<InvitePreview>, ApiError> {
    type PreviewRow = (Uuid, bool, String, String, Date, Date, String);
    let row = sqlx::query_as::<_, PreviewRow>(
        "select t.id, i.used_at is not null, t.title, t.destination, t.start_date, t.end_date, \
                p.display_name \
         from app.invites i \
           join app.trips t on t.id = i.trip_id \
           join app.profiles p on p.user_id = i.created_by \
         where i.token_hash = $1 and t.deleted_at is null \
           and i.revoked_at is null and i.expires_at > clock_timestamp()",
    )
    .bind(token_hash(&token))
    .fetch_optional(&st.db)
    .await?;
    let Some((trip, used, title, destination, start, end, inviter_name)) = row else {
        return Err(invite_invalid());
    };
    let member = match &user {
        Some(user) => repo::person_of(&st.db, TripId(trip), user.id)
            .await?
            .is_some(),
        None => false,
    };
    if used && !member {
        return Err(invite_invalid());
    }
    Ok(Json(InvitePreview {
        title,
        destination,
        start,
        end,
        inviter_name,
        already_member: user.map(|_| member),
    }))
}

/// `POST /api/invites/{token}/join`：以目前的 Account 加入（見模組說明）。
pub async fn join(
    State(st): State<AppState>,
    user: AuthUser,
    ApiPath(token): ApiPath<String>,
    ApiJson(request): ApiJson<JoinRequest>,
) -> Result<Json<JoinResponse>, ApiError> {
    let mut tx = st.db.begin().await?;
    let joined = join_in_tx(
        &mut tx,
        st.clock.as_ref(),
        user.id,
        &token,
        &request.name,
        &request.role,
    )
    .await
    .map_err(JoinError::into_api_error)?;
    tx.commit().await?;
    match joined {
        Joined::Added { trip, seq } => {
            tracing::info!(%trip, user = %user.id, seq, "joined a trip with an invite");
            Ok(Json(JoinResponse { trip_id: trip }))
        }
        Joined::AlreadyMember(trip) => Ok(Json(JoinResponse { trip_id: trip })),
    }
}

/// `join_in_tx()` 的結果。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Joined {
    /// 新增了綁定的旅伴，提交的 Seq 是 `seq`。
    Added { trip: TripId, seq: Seq },
    /// 使用者已是 Trip_Member，沒有寫入（需求 30.11）。
    AlreadyMember(TripId),
}

impl Joined {
    pub(crate) fn trip(self) -> TripId {
        match self {
            Joined::Added { trip, .. } | Joined::AlreadyMember(trip) => trip,
        }
    }
}

/// 加入失敗：要回應的錯誤，或 Database 的錯誤（加入的端點回應 500 `internal_error`，註冊依需求 3.10 回應「註冊暫時
/// 無法使用，請聯絡管理員。」）。
#[derive(Debug)]
pub(crate) enum JoinError {
    Rejected(ApiError),
    Database(sqlx::Error),
}

impl JoinError {
    fn into_api_error(self) -> ApiError {
        match self {
            JoinError::Rejected(error) => error,
            JoinError::Database(error) => error.into(),
        }
    }
}

impl From<sqlx::Error> for JoinError {
    fn from(error: sqlx::Error) -> Self {
        JoinError::Database(error)
    }
}

impl From<ApiError> for JoinError {
    fn from(error: ApiError) -> Self {
        JoinError::Rejected(error)
    }
}

/// 附邀請的註冊在建立 Auth_Service 使用者之前的檢查（需求 3.1、30.13）：連結是 Active_Invite 而且旅行沒有被刪除。
/// 新的帳號不會是 Trip_Member，所以已使用的連結也無效。交易中的 `join_in_tx()` 會再驗證一次。
pub(crate) async fn check_usable(db: &PgPool, token: &str) -> Result<(), JoinError> {
    let usable = sqlx::query_scalar::<_, bool>(&format!(
        "select exists (select 1 from app.invites i join app.trips t on t.id = i.trip_id \
                        where i.token_hash = $1 and t.deleted_at is null and {ACTIVE})"
    ))
    .bind(token_hash(token))
    .fetch_one(db)
    .await?;
    if usable {
        Ok(())
    } else {
        Err(invite_invalid().into())
    }
}

/// 在 `tx` 中以 `token` 的連結讓 `user` 加入旅行（模組說明「預覽與加入」的步驟 1 至 5）；呼叫端負責提交。
pub(crate) async fn join_in_tx(
    tx: &mut PgTx,
    clock: &dyn Clock,
    user: UserId,
    token: &str,
    name: &str,
    role: &str,
) -> Result<Joined, JoinError> {
    let hash = token_hash(token);
    // 1. 連結所屬的旅行，鎖住旅行列；已刪除的旅行是 None
    let trip =
        sqlx::query_scalar::<_, Uuid>("select trip_id from app.invites where token_hash = $1")
            .bind(&hash)
            .fetch_optional(&mut **tx)
            .await?
            .map(TripId)
            .ok_or_else(invite_invalid)?;
    let head = repo::lock_trip(tx, trip)
        .await?
        .ok_or_else(invite_invalid)?;
    // 2. 鎖住之後再驗證連結
    let (invite, used, live) = sqlx::query_as::<_, (Uuid, bool, bool)>(
        "select id, used_at is not null, revoked_at is null and expires_at > clock_timestamp() \
         from app.invites where token_hash = $1 and trip_id = $2 for update",
    )
    .bind(&hash)
    .bind(trip.0)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(invite_invalid)?;
    if !live {
        return Err(invite_invalid().into());
    }
    // 3. 已是成員（需求 30.11）
    if repo::person_of(&mut **tx, trip, user).await?.is_some() {
        return Ok(Joined::AlreadyMember(trip));
    }
    // 4. 已使用（需求 30.13、30.14）
    if used {
        return Err(invite_invalid().into());
    }
    // 5. 新增綁定的旅伴（需求 30.10、30.15）
    let state = repo::load_trip(tx, trip).await?;
    let person = PersonId(random_uuid());
    let outcome = join_trip(&state, person, name, role).map_err(ApiError::from)?;
    let seq = head.seq + 1;
    let (changes, next_ordinal) = versioned_changes(outcome.effects(), &outcome.created, head);
    let is_new_person =
        |change: &Change| matches!(&change.row, Some(Row::Person(p)) if p.id == person);
    let Some(Some(Row::Person(bound))) = changes
        .iter()
        .find(|change| is_new_person(change))
        .map(|change| &change.row)
    else {
        return Err(ApiError::internal("join_trip() did not add the bound person").into());
    };
    repo::insert_bound_person(tx, trip, bound, user).await?;
    let rest: Vec<Change> = changes
        .iter()
        .filter(|change| !is_new_person(change))
        .cloned()
        .collect();
    repo::write_changes(tx, trip, &rest).await?;
    sqlx::query("update app.invites set used_at = now(), used_by = $2 where id = $1")
        .bind(invite)
        .bind(user.0)
        .execute(&mut **tx)
        .await?;
    let cs = ChangeSet {
        trip,
        seq,
        command_id: CommandId(random_uuid()),
        actor: user,
        committed_at_ms: clock.now_ms(),
        changes,
        trip_deleted: false,
    };
    repo::finish(tx, trip, seq, next_ordinal, &cs).await?;
    Ok(Joined::Added { trip, seq })
}

/// 404：需求 30.13 的每一種情況。
fn invite_invalid() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "invite_invalid", INVITE_INVALID)
}

/// `app.invites.token_hash`：token 的 SHA-256 十六進位（需求 30.2）。
fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// 回應中的時間：RFC 3339、UTC、毫秒（例如 `2026-01-08T03:04:05.678Z`）。
/// 小數只取到毫秒（捨去微秒），與改用 time 之前的 chrono `to_rfc3339_opts(SecondsFormat::Millis, true)` 相同。
fn timestamp(time: OffsetDateTime) -> String {
    let utc = time.to_offset(UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        utc.year(),
        u8::from(utc.month()),
        utc.day(),
        utc.hour(),
        utc.minute(),
        utc.second(),
        utc.millisecond()
    )
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::timestamp;

    #[test]
    fn timestamps_are_rfc3339_utc_with_milliseconds() {
        assert_eq!(
            timestamp(datetime!(2026-01-08 03:04:05.678_901 UTC)),
            "2026-01-08T03:04:05.678Z"
        );
        assert_eq!(
            timestamp(datetime!(2026-11-25 00:00:00 UTC)),
            "2026-11-25T00:00:00.000Z"
        );
        // Database 回傳的時間不一定是 UTC：一律換成 UTC 再寫出
        assert_eq!(
            timestamp(datetime!(2026-12-02 07:30:00.999_999 +08:00)),
            "2026-12-01T23:30:00.999Z"
        );
    }
}
