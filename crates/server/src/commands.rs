//! Command_Executor（design A1，任務 15.3）：`POST /api/trips/{id}/commands`。
//!
//! | 端點 | 身分 | 成功時 |
//! | --- | --- | --- |
//! | `POST /api/trips/{id}/commands` | `AuthUser` | 200 `CommandResponse` |
//!
//! `execute()` 在一個交易中依序：
//!
//! 1. `repo::lock_trip()` 鎖住旅行列（持有到交易結束），同一趟旅行的命令、刪除與加入依序執行（需求 7.17）；旅行不存在
//!    或已刪除時 404「找不到這趟旅行。」（需求 6.3）。
//! 2. 以當下 Database 的資料判斷身分（需求 6.1）：`repo::person_of()` 與 LM_Core 的 `capabilities()`。不是
//!    Trip_Member 也不是 Admin 時 404，而且在查重之前判斷，所以非成員以這趟旅行已提交的 Command_Id 重送也只得到 404
//!    （需求 6.2）。
//! 3. 冪等：Command_Id 已在這趟旅行的 Change_Log 時，不論這次的內容，回傳第一次的 Change_Set、`replayed` 為真，不再
//!    執行、寫入或推送（需求 7.14）。
//! 4. `repo::load_trip()` 讀出整趟旅行，以 LM_Core 的 `apply(Mode::Commit)` 計算；權限細節、驗證、主要效果與採買同步
//!    （需求 25.1、25.2）都在 lm-core，採買同步新增的 Meal_Item 的 id 由 `UuidV4Ids` 產生。`Rejection` 以
//!    `From<Rejection> for ApiError` 轉成 400、403、404、409（需求 7.15）。
//! 5. 沒有變化時提交（只釋放鎖）並回傳目前的 Head 與 `null` 的 Change_Set，不寫入、不推送、不記錄 Command_Id
//!    （需求 7.12）。
//! 6. 有變化時 Seq 為 Head 加 1，每一列的 Row_Version 都是這個 Seq；新列的 Ordinal 依 `Outcome::created` 的順序從
//!    `next_ordinal` 起（需求 7.19），既有的列 Ordinal 不變。`repo::write_changes()` 寫入、`repo::finish()` 更新 Head
//!    並在 Change_Log 保存完整的 Change_Set（trigger 在同一個交易中推送，需求 10.1），再提交。外鍵、唯一鍵或 CHECK
//!    在 COMMIT 時失敗時整個交易回滾、不推送，以 `From<sqlx::Error>` 記錄並回應 500（需求 7.16）。
//!
//! 檢視者是 Unbound_Admin（Admin 但沒有 Bound_Person）時，回應中的 Change_Set（包括重送）不含 Ledger_Rows（需求
//! 6.12）；Change_Log 與推送仍是完整的 Change_Set。命令不讀取 Presence（需求 15.11），也不要求用戶端提供版本號：
//! 版本由這裡依 Head 指定。提早回傳時交易物件被丟棄，自動回滾。
use std::collections::HashMap;

use axum::extract::State;
use axum::Json;
use lm_core::api::{CommandRequest, CommandResponse};
use lm_core::apply::{apply, Ctx, Effect, IdSource, Mode};
use lm_core::ids::{ShoppingId, TripId};
use lm_core::model::Slot;
use lm_core::rules::capabilities;
use lm_core::sync::{changes, Change, ChangeSet};

use crate::error::ApiError;
use crate::extract::{ApiJson, AuthUser, TripPath};
use crate::repo::{self, TripHead};
use crate::state::AppState;
use crate::trips::random_uuid;

/// 採買同步新增的 Meal_Item 的 id：隨機的 UUID（版本 4）。
#[derive(Clone, Copy, Debug, Default)]
pub struct UuidV4Ids;

impl IdSource for UuidV4Ids {
    fn shopping_id(&mut self) -> ShoppingId {
        ShoppingId(random_uuid())
    }
}

/// `POST /api/trips/{id}/commands`（見模組說明）。
pub async fn post_command(
    State(st): State<AppState>,
    user: AuthUser,
    TripPath(trip): TripPath,
    ApiJson(request): ApiJson<CommandRequest>,
) -> Result<Json<CommandResponse>, ApiError> {
    execute(&st, &user, trip, request).await.map(Json)
}

/// 執行一個命令（design A1；步驟見模組說明）。
pub async fn execute(
    st: &AppState,
    user: &AuthUser,
    trip: TripId,
    req: CommandRequest,
) -> Result<CommandResponse, ApiError> {
    let mut tx = st.db.begin().await?;

    // 1. 串行化；旅行不存在或已刪除時 404
    let head = repo::lock_trip(&mut tx, trip)
        .await?
        .ok_or_else(ApiError::trip_not_found)?;

    // 2. 身分與權限，在查重之前
    let me = repo::person_of(&mut *tx, trip, user.id).await?;
    let caps = capabilities(head.owner, user.id, user.role, me);
    if !caps.can_edit {
        return Err(ApiError::trip_not_found());
    }
    let hide_ledger = caps.me.is_none();

    // 3. 冪等：重送的命令回傳第一次的 Change_Set
    if let Some(cs) = repo::changeset_by_command(&mut tx, trip, req.command_id).await? {
        tx.commit().await?;
        tracing::debug!(%trip, command = %req.command_id, seq = cs.seq, "command replayed");
        return Ok(CommandResponse {
            seq: cs.seq,
            changeset: Some(cs.for_viewer(hide_ledger)),
            replayed: true,
        });
    }

    // 4. 讀取整趟旅行並套用
    let state = repo::load_trip(&mut tx, trip).await?;
    let ctx = Ctx {
        actor: user.id,
        caps,
    };
    let outcome = apply(&state, &ctx, Mode::Commit, &mut UuidV4Ids, &req.command)?;
    if outcome.is_noop() {
        // 想要的狀態已經成立：不寫入、不推送、不記錄 Command_Id
        tx.commit().await?;
        return Ok(CommandResponse {
            seq: head.seq,
            changeset: None,
            replayed: false,
        });
    }

    // 5. 指定 Seq、Row_Version 與新列的 Ordinal
    let seq = head.seq + 1;
    let (changes, next_ordinal) = versioned_changes(outcome.effects(), &outcome.created, head);

    // 6. 寫入、記錄（trigger 推送）、提交；COMMIT 時的約束失敗回滾整個交易
    repo::write_changes(&mut tx, trip, &changes).await?;
    let cs = ChangeSet {
        trip,
        seq,
        command_id: req.command_id,
        actor: user.id,
        committed_at_ms: st.clock.now_ms(),
        changes,
        trip_deleted: false,
    };
    repo::finish(&mut tx, trip, seq, next_ordinal, &cs).await?;
    if let Err(error) = tx.commit().await {
        tracing::error!(%trip, command = %req.command_id, seq, "command commit failed; rolled back");
        return Err(error.into());
    }
    tracing::info!(%trip, user = %user.id, command = %req.command_id, seq, "command committed");

    Ok(CommandResponse {
        seq,
        changeset: Some(cs.for_viewer(hide_ledger)),
        replayed: false,
    })
}

/// 一次提交的變化（需求 7.17、7.19、8.4）：Seq 為 `head.seq + 1`，每一列的 Row_Version 都是這個 Seq；`created` 中的
/// 新列依它的順序從 `head.next_ordinal` 起取得 Ordinal（取代 `apply()` 指定的暫時 Ordinal），其他列的 Ordinal 不變。
/// 一併回傳提交後的下一個 Ordinal。
pub(crate) fn versioned_changes(
    effects: Vec<Effect>,
    created: &[Slot],
    head: TripHead,
) -> (Vec<Change>, u64) {
    let seq = head.seq + 1;
    let ordinals: HashMap<Slot, u64> = created
        .iter()
        .zip(head.next_ordinal..)
        .map(|(slot, ordinal)| (*slot, ordinal))
        .collect();
    let next_ordinal = head.next_ordinal + created.len() as u64;
    let effects: Vec<Effect> = effects
        .into_iter()
        .map(|effect| match effect {
            Effect::Upsert(row) => match ordinals.get(&row.slot()) {
                Some(&ordinal) => Effect::Upsert(row.with_ordinal(ordinal)),
                None => Effect::Upsert(row),
            },
            delete @ Effect::Delete(_) => delete,
        })
        .collect();
    (changes(&effects, seq), next_ordinal)
}
