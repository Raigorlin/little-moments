//! 旅行的端點（design 3.1 的表）：列表、建立與刪除（任務 15.2，需求 17），以及 Snapshot、增量與 Head 的讀取（任務
//! 15.4，需求 12）。
//!
//! | 端點 | 身分 | 成功時 |
//! | --- | --- | --- |
//! | `GET /api/trips` | `AuthUser` | 200 `TripSummary[]` |
//! | `POST /api/trips` | `AuthUser` | 200 `TripSummary` |
//! | `DELETE /api/trips/{id}` | `AuthUser` | 200 `{}` |
//! | `GET /api/trips/{id}/snapshot` | `AuthUser` | 200 `Snapshot` |
//! | `GET /api/trips/{id}/changes?after=N` | `AuthUser` | 200 `ChangesResponse` |
//! | `GET /api/trips/{id}/head` | `AuthUser` | 200 `HeadResponse`（`{ seq }`） |
//!
//! # 列表（`GET /api/trips`，需求 17.8、6.3、8.11）
//!
//! 只列出請求者有 Bound_Person（Trip_Member）而且沒有被刪除的旅行；Admin 也只看到自己是 Trip_Member 的旅行。
//! `member_count` 是這趟旅行全部的旅伴（包括沒有綁定帳號的），`can_manage` 是 LM_Core 的 `capabilities()`
//! （Trip_Owner 或 Admin）。依建立時間由新到舊回傳（建立時間相同時依旅行 id），LM_Web 以穩定排序依開始日期分區排列
//! 時，開始日期相同的旅行就是建立時間較晚的在前（需求 17.1）。
//!
//! # 建立（`POST /api/trips`，需求 17.3、17.4、17.5、8.4）
//!
//! 1. LM_Core 的 `new_trip_card()` 檢查旅行資料（文字經 Trim_White，狀態為規劃中，Row_Version 0），再以
//!    `creator_name()` 檢查建立者的名字（Display_Name 經 Participant_Name）；不通過時 400，不寫入。
//! 2. 一個交易：以 `INSERT … ON CONFLICT (id) DO NOTHING` 新增旅行（Seq 0、`next_ordinal` 1、Trip_Card 的
//!    Row_Version 0），再以 `repo::insert_bound_person()` 帶 `user_id` 新增建立者的旅伴（角色「這趟的召集人」、
//!    顏色 coral、Ordinal 0、Row_Version 0），寫入 `trip.create` 的 Audit_Log（需求 41.2），提交。建立旅行不產生
//!    Change_Set（Head 是 0）。
//! 3. 旅行 id 已被使用時 INSERT 不新增任何列：同一個 id 的另一個建立請求還沒提交時，INSERT 等它的交易結束，提交了
//!    就不新增、回滾了就照常新增，所以同時送達的兩個請求也只建立一趟。不新增時放棄這個交易，再讀那趟旅行：請求者是
//!    Trip_Owner 而且旅行沒有被刪除時，以目前 Database 的內容回傳既有的旅行（不依這次的請求修改）；否則 409
//!    `trip_id_taken`「無法建立這趟旅行，請關閉表單後重新建立。」，不回傳那趟旅行的任何內容。
//!
//! # 刪除（`DELETE /api/trips/{id}`，需求 17.6、17.7、8.8、8.11、10.8、6.2、6.3）
//!
//! 一個交易：`repo::lock_trip()` 鎖住旅行列；旅行不存在或已刪除時 404。以當下 Database 的資料判斷權限（需求 6.1）：
//! 不是 Trip_Member 也不是 Admin 時 404；Collaborator（成員但不是 Trip_Manager）時 403 `deny_trip_delete`。通過時
//! 設定 `deleted_at`，再以 `repo::finish()` 寫入 Seq 為 Head 加 1、`trip_deleted` 為真、沒有列變化的 Change_Set
//! （trigger 在同一個交易中推送）與 `trip.delete` 的 Audit_Log（需求 41.2），提交後回應 200 `{}`。Trip_State 的列、Row_Version、Change_Log 既有的列與
//! Invite_Link 都不變（需求 8.8）。這個 Change_Set 不是任何 Command 的結果，Command_Id 是 lm-server 產生的隨機
//! UUID。兩個刪除同時送達時，後取得鎖的那一個讀到已設定 `deleted_at` 的列，`lock_trip()` 回傳 `None`，得到 404。
//!
//! # Snapshot、增量與 Head（需求 12.5、12.8、12.9、12.15、6.1–6.3、6.12、5.9）
//!
//! 三個端點都不加鎖、不寫入。`reader()` 每次請求都以當下 Database 的資料判斷（需求 6.1）：`repo::read_head()` 讀
//! 不到（旅行不存在或已刪除）時 404；`repo::person_of()` 與 LM_Core 的 `capabilities()` 判斷不是 Trip_Member 也
//! 不是 Admin 時同樣 404（需求 6.2、6.3），通過時組成 `Viewer`（帳號資料取自 `AuthUser`，也就是這個請求當下的
//! `app.profiles`）。
//!
//! - Snapshot：`repo::snapshot()` 在一個 REPEATABLE READ 唯讀交易中讀出 Head 與每一列（需求 12.8），Unbound_Admin
//!   不含 Ledger_Rows（需求 6.12）。
//! - 增量：`after` 以 `ApiQuery<ChangesQuery>` 解析成 `u64`，缺少、負數或不是整數時 400 `invalid_request`（需求
//!   5.9，在登入與旅行 id 之後判斷）。`repo::changes_after()` 在一個 REPEATABLE READ 唯讀交易中讀出 Head 與
//!   `(after, Head]` 的 Change_Set；Head 減 `after` 大於 500 時 `snapshot_required`（需求 12.5、12.15）。
//! - Head：權限判斷時讀到的 Head，還沒有提交時是 0（需求 12.9）。
//!
//! 權限判斷與 Snapshot、增量的唯讀交易是分開的查詢：旅行在兩者之間被刪除時，唯讀交易讀不到旅行，同樣回應 404。
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use lm_core::api::{ChangesResponse, CreateTripRequest, HeadResponse, TripSummary};
use lm_core::apply::{creator_name, new_trip_card};
use lm_core::ids::{CommandId, PersonId, TripId, UserId};
use lm_core::model::{Color, CoverKind, Person, Seq, TripCard, TripStatus};
use lm_core::rules::capabilities;
use lm_core::sync::{ChangeSet, Snapshot, Viewer};
use serde::Deserialize;
use sqlx::postgres::PgRow;
use sqlx::types::{JsonValue, Uuid};
use sqlx::{PgPool, Row as _};

use crate::audit;
use crate::error::ApiError;
use crate::extract::{ApiJson, ApiQuery, AuthUser, TripPath};
use crate::repo;
use crate::state::AppState;

/// 建立者的旅伴的角色（需求 17.3）。
const CREATOR_ROLE: &str = "這趟的召集人";

/// 旅行 id 已被使用，而且請求者不能取得那趟旅行（需求 17.4）。
const TRIP_ID_TAKEN: &str = "無法建立這趟旅行，請關閉表單後重新建立。";

/// Collaborator 刪除旅行（需求 17.7）。
const DENY_TRIP_DELETE: &str = "受邀旅伴可以編輯旅行，但只有主辦人或管理員可以刪除。";

/// `GET /api/trips`：請求者是 Trip_Member 而且沒有被刪除的旅行，依建立時間由新到舊（見模組說明）。
pub async fn list_trips(
    State(st): State<AppState>,
    user: AuthUser,
) -> Result<Json<Vec<TripSummary>>, ApiError> {
    let rows = sqlx::query(&format!(
        "{SUMMARY_SELECT} \
         where t.deleted_at is null \
           and exists (select 1 from app.people m where m.trip_id = t.id and m.user_id = $1) \
         order by t.created_at desc, t.id"
    ))
    .bind(user.id.0)
    .fetch_all(&st.db)
    .await?;
    let trips = rows
        .iter()
        .map(|row| summary_row(row, &user))
        .collect::<sqlx::Result<Vec<_>>>()?;
    Ok(Json(trips))
}

/// `POST /api/trips`：建立旅行與建立者的旅伴；旅行 id 已被使用時依需求 17.4 處理（見模組說明）。
pub async fn create_trip(
    State(st): State<AppState>,
    user: AuthUser,
    ApiJson(request): ApiJson<CreateTripRequest>,
) -> Result<Json<TripSummary>, ApiError> {
    let card = new_trip_card(request.id, &request.draft())?;
    let name = creator_name(&user.display_name)?;
    let trip = card.id;

    let mut tx = st.db.begin().await?;
    if !insert_trip(&mut tx, &card, user.id).await? {
        // 已有這個 id 的旅行（可能剛由同時送達的另一個請求提交）：這個交易沒有寫入任何列
        tx.rollback().await?;
        return existing_trip(&st.db, trip, &user).await.map(Json);
    }
    let creator = Person {
        id: PersonId(random_uuid()),
        name,
        role: CREATOR_ROLE.to_owned(),
        color: Color::Coral,
        bound: true,
        ordinal: 0,
        version: 0,
    };
    repo::insert_bound_person(&mut tx, trip, &creator, user.id).await?;
    // 需求 41.2：只在實際建立時寫入（回傳既有旅行時不寫）
    audit::write(&mut tx, Some(user.id), audit::TRIP_CREATE, &card.title, "").await?;
    tx.commit().await?;
    tracing::info!(%trip, user = %user.id, "trip created");

    Ok(Json(TripSummary {
        id: trip,
        title: card.title,
        destination: card.destination,
        start: card.start,
        end: card.end,
        cover: card.cover,
        status: card.status,
        member_count: 1,
        can_manage: true,
    }))
}

/// 新增旅行列：Trip_Owner 是 `owner`，Seq 0，下一個 Ordinal 是 1（建立者的旅伴使用 0），Trip_Card 的 Row_Version 是
/// `card.version`（0）。旅行 id 已被使用時不新增，回傳 `false`。
async fn insert_trip(tx: &mut repo::PgTx, card: &TripCard, owner: UserId) -> sqlx::Result<bool> {
    let result = sqlx::query(
        "insert into app.trips (id, owner_id, title, destination, start_date, end_date, description, note, \
                                cover_kind, status, seq, next_ordinal, version) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, 1, $11) \
         on conflict (id) do nothing",
    )
    .bind(card.id.0)
    .bind(owner.0)
    .bind(&card.title)
    .bind(&card.destination)
    .bind(card.start)
    .bind(card.end)
    .bind(&card.description)
    .bind(&card.note)
    .bind(card.cover.as_str())
    .bind(card.status.as_str())
    .bind(repo::to_i64(card.version, "version")?)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// 建立請求的旅行 id 已被使用（需求 17.4）：請求者是 Trip_Owner 而且旅行沒有被刪除時是既有的旅行，否則 409。
async fn existing_trip(
    db: &PgPool,
    trip: TripId,
    user: &AuthUser,
) -> Result<TripSummary, ApiError> {
    let row = sqlx::query(&format!(
        "{SUMMARY_SELECT} where t.owner_id = $1 and t.id = $2 and t.deleted_at is null"
    ))
    .bind(user.id.0)
    .bind(trip.0)
    .fetch_optional(db)
    .await?;
    match row {
        Some(row) => Ok(summary_row(&row, user)?),
        None => Err(ApiError::new(
            StatusCode::CONFLICT,
            "trip_id_taken",
            TRIP_ID_TAKEN,
        )),
    }
}

/// `DELETE /api/trips/{id}`：Trip_Manager 刪除旅行，寫入並推送 `trip_deleted` 的 Change_Set（見模組說明）。
pub async fn delete_trip(
    State(st): State<AppState>,
    user: AuthUser,
    TripPath(trip): TripPath,
) -> Result<Json<JsonValue>, ApiError> {
    let mut tx = st.db.begin().await?;
    let Some(head) = repo::lock_trip(&mut tx, trip).await? else {
        return Err(ApiError::trip_not_found());
    };
    let me = repo::person_of(&mut *tx, trip, user.id).await?;
    let caps = capabilities(head.owner, user.id, user.role, me);
    if !caps.can_edit {
        return Err(ApiError::trip_not_found());
    }
    if !caps.can_manage {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "deny_trip_delete",
            DENY_TRIP_DELETE,
        ));
    }

    sqlx::query("update app.trips set deleted_at = now() where id = $1")
        .bind(trip.0)
        .execute(&mut *tx)
        .await?;
    let seq = head.seq + 1;
    let cs = ChangeSet {
        trip,
        seq,
        command_id: CommandId(random_uuid()),
        actor: user.id,
        committed_at_ms: st.clock.now_ms(),
        changes: Vec::new(),
        trip_deleted: true,
    };
    repo::finish(&mut tx, trip, seq, head.next_ordinal, &cs).await?;
    // 需求 41.2：與刪除在同一個交易
    let title = repo::trip_title(&mut tx, trip).await?;
    audit::write(&mut tx, Some(user.id), audit::TRIP_DELETE, &title, "").await?;
    tx.commit().await?;
    tracing::info!(%trip, user = %user.id, seq, "trip deleted");

    Ok(Json(JsonValue::Object(Default::default())))
}

// ── Snapshot、增量與 Head ──

/// `GET /api/trips/{id}/changes` 的查詢參數：`after` 必須是非負整數，缺少或無法解析時 `ApiQuery` 回應 400
/// `invalid_request`（需求 5.9）。
#[derive(Debug, Deserialize)]
pub struct ChangesQuery {
    pub after: Seq,
}

/// `GET /api/trips/{id}/snapshot`：檢視者是 Trip_Member 或 Admin 時，當下 Head 的完整 Trip_State 與 `Viewer`
/// （見模組說明）。
pub async fn snapshot(
    State(st): State<AppState>,
    user: AuthUser,
    TripPath(trip): TripPath,
) -> Result<Json<Snapshot>, ApiError> {
    let (_, viewer) = reader(&st.db, trip, &user).await?;
    repo::snapshot(&st.db, trip, &viewer)
        .await?
        .map(Json)
        .ok_or_else(ApiError::trip_not_found)
}

/// `GET /api/trips/{id}/changes?after=N`：`N` 之後的每一個 Change_Set，或 Head 減 `N` 大於 500 時
/// `snapshot_required`（見模組說明）。
pub async fn changes(
    State(st): State<AppState>,
    user: AuthUser,
    TripPath(trip): TripPath,
    ApiQuery(query): ApiQuery<ChangesQuery>,
) -> Result<Json<ChangesResponse>, ApiError> {
    let (_, viewer) = reader(&st.db, trip, &user).await?;
    repo::changes_after(&st.db, trip, query.after, &viewer)
        .await?
        .map(Json)
        .ok_or_else(ApiError::trip_not_found)
}

/// `GET /api/trips/{id}/head`：這趟旅行目前的 Head（見模組說明）。
pub async fn head(
    State(st): State<AppState>,
    user: AuthUser,
    TripPath(trip): TripPath,
) -> Result<Json<HeadResponse>, ApiError> {
    let (head, _) = reader(&st.db, trip, &user).await?;
    Ok(Json(HeadResponse { seq: head.seq }))
}

/// 讀取端點的權限（需求 6.1–6.3）：以當下 Database 的資料判斷，旅行不存在或已刪除，或 `user` 不是 Trip_Member 也
/// 不是 Admin 時 404；通過時回傳不加鎖讀到的 Head 與檢視者。
async fn reader(
    db: &PgPool,
    trip: TripId,
    user: &AuthUser,
) -> Result<(repo::TripHead, Viewer), ApiError> {
    let head = repo::read_head(db, trip)
        .await?
        .ok_or_else(ApiError::trip_not_found)?;
    let me = repo::person_of(db, trip, user.id).await?;
    let caps = capabilities(head.owner, user.id, user.role, me);
    if !caps.can_edit {
        return Err(ApiError::trip_not_found());
    }
    let viewer = Viewer {
        user: user.id,
        username: user.username.clone(),
        display_name: user.display_name.clone(),
        role: user.role,
        caps,
    };
    Ok((head, viewer))
}

// ── TripSummary ──

/// `TripSummary` 需要的欄位；`summary_row()` 讀取。`$1` 是請求者的帳號 id，其他參數從 `$2` 起。
const SUMMARY_SELECT: &str = "select t.id, t.owner_id, t.title, t.destination, t.start_date, t.end_date, \
                                     t.cover_kind, t.status, \
                                     (select count(*) from app.people p where p.trip_id = t.id) as member_count, \
                                     (select m.id from app.people m where m.trip_id = t.id and m.user_id = $1) \
                                       as me \
                              from app.trips t";

/// `SUMMARY_SELECT` 的一列；`can_manage` 以 LM_Core 的 `capabilities()` 判斷（Trip_Owner 或 Admin）。
fn summary_row(row: &PgRow, user: &AuthUser) -> sqlx::Result<TripSummary> {
    let owner = UserId(row.try_get::<Uuid, _>("owner_id")?);
    let me = row.try_get::<Option<Uuid>, _>("me")?.map(PersonId);
    let member_count = row.try_get::<i64, _>("member_count")?;
    Ok(TripSummary {
        id: TripId(row.try_get("id")?),
        title: row.try_get("title")?,
        destination: row.try_get("destination")?,
        start: row.try_get("start_date")?,
        end: row.try_get("end_date")?,
        cover: parsed(row, "cover_kind", CoverKind::parse)?,
        status: parsed(row, "status", TripStatus::parse)?,
        member_count: u32::try_from(member_count).map_err(|_| {
            sqlx::Error::Decode(format!("member count out of range: {member_count}").into())
        })?,
        can_manage: capabilities(owner, user.id, user.role, me).can_manage,
    })
}

/// 列舉欄位；app schema 的 CHECK 只允許列舉值。
fn parsed<T>(row: &PgRow, column: &str, parse: fn(&str) -> Option<T>) -> sqlx::Result<T> {
    let text = row.try_get::<String, _>(column)?;
    parse(&text).ok_or_else(|| {
        sqlx::Error::Decode(format!("app.trips.{column} has an unknown value: {text:?}").into())
    })
}

/// 隨機的 UUID（版本 4）：建立者的旅伴 id、刪除旅行的 Command_Id，以及採買同步新增的 Meal_Item 的 id
/// （`commands::UuidV4Ids`）。
pub(crate) fn random_uuid() -> Uuid {
    sqlx::types::uuid::Builder::from_random_bytes(rand::random()).into_uuid()
}
