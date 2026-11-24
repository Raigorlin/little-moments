//! Change_Log（`app.trip_changes`）與讀取：`finish()`、`changeset_by_command()`、`snapshot()` 與 `changes_after()`。
//!
//! 每次有變化的提交在 Change_Log 寫入一列，保存完整的 Change_Set（包括 Ledger_Rows 與 `trip_deleted`，需求 8.7）；
//! `app.trip_changes` 的 AFTER INSERT trigger（`app.publish_trip_change()`）在同一個交易中把它推送到 Trip_Channel，
//! 交易回滾時推送一起回滾。Unbound_Admin 看不到 Ledger_Rows，所以讀取時才以 `Viewer` 省略（需求 6.12）。
use lm_core::api::ChangesResponse;
use lm_core::ids::{CommandId, TripId};
use lm_core::model::{Row, Seq};
use lm_core::sync::{ChangeSet, Snapshot, Viewer};
use sqlx::types::Json;
use sqlx::PgPool;

use super::{load_trip, read_head, to_i64, PgTx};

/// `changes_after()` 一次最多回傳的 Change_Set 數：Head 減 `after` 大於這個數時改讀 Snapshot（需求 12.5）。
pub const MAX_CHANGES_BEHIND: Seq = 500;

/// 提交前的最後一步：`app.trips` 的 Head 設為 `seq`、下一個 Ordinal 設為 `next_ordinal`、`updated_at` 設為現在，並在
/// Change_Log 寫入完整的 `cs`（trigger 負責推送）。`seq` 必須是 Head 加 1（呼叫端已以 `lock_trip()` 鎖住旅行列）。
pub async fn finish(
    tx: &mut PgTx,
    trip: TripId,
    seq: Seq,
    next_ordinal: u64,
    cs: &ChangeSet,
) -> sqlx::Result<()> {
    if cs.trip != trip || cs.seq != seq {
        return Err(sqlx::Error::Encode(
            format!(
                "change set {}#{} does not match trip {trip} seq {seq}",
                cs.trip, cs.seq
            )
            .into(),
        ));
    }
    let seq = to_i64(seq, "seq")?;
    let result = sqlx::query(
        "update app.trips set seq = $2, next_ordinal = $3, updated_at = now() where id = $1",
    )
    .bind(trip.0)
    .bind(seq)
    .bind(to_i64(next_ordinal, "next_ordinal")?)
    .execute(&mut **tx)
    .await?;
    if result.rows_affected() != 1 {
        return Err(sqlx::Error::RowNotFound);
    }
    sqlx::query(
        "insert into app.trip_changes (trip_id, seq, command_id, actor_id, payload, committed_at) \
         values ($1, $2, $3, $4, $5, to_timestamp($6::double precision / 1000))",
    )
    .bind(trip.0)
    .bind(seq)
    .bind(cs.command_id.0)
    .bind(cs.actor.0)
    .bind(Json(cs))
    .bind(cs.committed_at_ms as f64)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// 這趟旅行的 Change_Log 中 Command_Id 為 `id` 的完整 Change_Set（重送的命令，需求 7.14）；只比對同一趟旅行，所以
/// 其他旅行用過的 Command_Id 不算。呼叫前已確認請求者是 Trip_Member 或 Admin（需求 6.2）。
pub async fn changeset_by_command(
    tx: &mut PgTx,
    trip: TripId,
    id: CommandId,
) -> sqlx::Result<Option<ChangeSet>> {
    let payload = sqlx::query_scalar::<_, Json<ChangeSet>>(
        "select payload from app.trip_changes where trip_id = $1 and command_id = $2",
    )
    .bind(trip.0)
    .bind(id.0)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(payload.map(|Json(cs)| cs))
}

/// 開始一個 REPEATABLE READ 的唯讀交易：其中的每個查詢都讀同一個時間點的資料。
async fn read_only(pool: &PgPool) -> sqlx::Result<PgTx> {
    let mut tx = pool.begin().await?;
    sqlx::query("set transaction isolation level repeatable read, read only")
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}

/// 這趟旅行在當下 Head 的完整 Trip_State（需求 12.8）：Head 與每一列在同一個 REPEATABLE READ 唯讀交易中讀出，
/// 所以 Snapshot 的 Seq 與內容一致。檢視者是 Unbound_Admin（`viewer.hides_ledger()`）時不含 Ledger_Rows
/// （需求 6.12）。旅行不存在或已刪除時是 `None`。呼叫前已確認 `viewer` 是 Trip_Member 或 Admin。
pub async fn snapshot(
    pool: &PgPool,
    trip: TripId,
    viewer: &Viewer,
) -> sqlx::Result<Option<Snapshot>> {
    let mut tx = read_only(pool).await?;
    let Some(head) = read_head(&mut *tx, trip).await? else {
        return Ok(None);
    };
    let state = load_trip(&mut tx, trip).await?;
    tx.commit().await?;
    let hide_ledger = viewer.hides_ledger();
    let rows = state
        .rows()
        .into_iter()
        .filter(|row| !(hide_ledger && matches!(row, Row::Expense(_) | Row::Settlement(_))))
        .collect();
    Ok(Some(Snapshot {
        trip,
        seq: head.seq,
        viewer: viewer.clone(),
        rows,
    }))
}

/// `after` 之後的 Change_Set（需求 12.5、12.15）：Head 減 `after` 大於 `MAX_CHANGES_BEHIND` 時是
/// `SnapshotRequired`；否則是 Head 與 Seq 在 `(after, Head]` 的每一個 Change_Set，依 Seq 遞增、每個 Seq 恰好一個，
/// `after` 不小於 Head 時清單是空的。Unbound_Admin 的每個 Change_Set 以 `without_ledger()` 回應，省略 Ledger_Rows
/// 之後沒有變化的仍以它的 Seq 留在清單中。旅行不存在或已刪除時是 `None`。
pub async fn changes_after(
    pool: &PgPool,
    trip: TripId,
    after: Seq,
    viewer: &Viewer,
) -> sqlx::Result<Option<ChangesResponse>> {
    let mut tx = read_only(pool).await?;
    let Some(head) = read_head(&mut *tx, trip).await? else {
        return Ok(None);
    };
    let head = head.seq;
    if head.saturating_sub(after) > MAX_CHANGES_BEHIND {
        return Ok(Some(ChangesResponse::SnapshotRequired { head }));
    }
    if after >= head {
        return Ok(Some(ChangesResponse::Changes {
            head,
            changesets: Vec::new(),
        }));
    }
    let payloads = sqlx::query_scalar::<_, Json<ChangeSet>>(
        "select payload from app.trip_changes where trip_id = $1 and seq > $2 and seq <= $3 order by seq",
    )
    .bind(trip.0)
    .bind(to_i64(after, "after")?)
    .bind(to_i64(head, "head")?)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;

    // Change_Log 恰好有 Seq 1 到 Head 各一列（需求 8.7）；不符時是 Database 被繞過 lm-server 修改，回應 500 而不是
    // 讓 LM_Web 以為缺號
    let hide_ledger = viewer.hides_ledger();
    let count = payloads.len();
    let mut changesets = Vec::with_capacity(count);
    for (expected, Json(cs)) in (after + 1..=head).zip(payloads) {
        if cs.seq != expected || cs.trip != trip {
            return Err(sqlx::Error::Decode(
                format!(
                    "change log of trip {trip} has {}#{} where seq {expected} was expected",
                    cs.trip, cs.seq
                )
                .into(),
            ));
        }
        changesets.push(cs.for_viewer(hide_ledger));
    }
    let expected = head - after;
    if changesets.len() as u64 != expected {
        return Err(sqlx::Error::Decode(
            format!(
                "change log of trip {trip} has {count} of the {expected} change sets after seq {after}"
            )
            .into(),
        ));
    }
    Ok(Some(ChangesResponse::Changes { head, changesets }))
}
