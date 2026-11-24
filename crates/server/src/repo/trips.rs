//! `app.trips` 的旅行列：命令執行前的鎖（`lock_trip()`）、不加鎖的 Head（`read_head()`），以及帳號在這趟旅行綁定的
//! 旅伴（`person_of()`）。已刪除的旅行（`deleted_at` 不是 NULL）一律視同不存在（需求 6.3、8.11）。
use lm_core::ids::{PersonId, TripId, UserId};
use lm_core::model::Seq;
use sqlx::types::Uuid;
use sqlx::PgExecutor;

use super::{to_u64, PgTx};

/// 一趟未刪除旅行的擁有者、Head（最後一次提交的 Seq，還沒有提交時是 0）與下一個新列的 Ordinal。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TripHead {
    pub owner: UserId,
    pub seq: Seq,
    pub next_ordinal: u64,
}

const HEAD_COLUMNS: &str = "select owner_id, seq, next_ordinal from app.trips \
                            where id = $1 and deleted_at is null";

/// 鎖住旅行列（`FOR UPDATE`，持有到交易結束），讓同一趟旅行的命令、刪除與加入依序執行（需求 7.17）；旅行不存在或
/// 已刪除時是 `None`。兩個刪除同時送達時，後取得鎖的那一個重新讀到 `deleted_at` 已設定的列，得到 `None`。
pub async fn lock_trip(tx: &mut PgTx, trip: TripId) -> sqlx::Result<Option<TripHead>> {
    let row = sqlx::query_as::<_, (Uuid, i64, i64)>(&format!("{HEAD_COLUMNS} for update"))
        .bind(trip.0)
        .fetch_optional(&mut **tx)
        .await?;
    row.map(head).transpose()
}

/// 不加鎖讀取 Head 與擁有者（`GET /api/trips/{id}/head` 與讀取權限的判斷，需求 12.9）；旅行不存在或已刪除時是
/// `None`。`conn` 可以是連線池（`&PgPool`）或交易中的連線（`&mut **tx`）。
pub async fn read_head<'e>(
    conn: impl PgExecutor<'e>,
    trip: TripId,
) -> sqlx::Result<Option<TripHead>> {
    let row = sqlx::query_as::<_, (Uuid, i64, i64)>(HEAD_COLUMNS)
        .bind(trip.0)
        .fetch_optional(conn)
        .await?;
    row.map(head).transpose()
}

fn head((owner, seq, next_ordinal): (Uuid, i64, i64)) -> sqlx::Result<TripHead> {
    Ok(TripHead {
        owner: UserId(owner),
        seq: to_u64(seq, "app.trips.seq")?,
        next_ordinal: to_u64(next_ordinal, "app.trips.next_ordinal")?,
    })
}

/// `user` 在這趟旅行綁定的旅伴（Bound_Person）；沒有時是 `None`。`unique (trip_id, user_id)` 保證最多一位。
/// 成員資格一律以呼叫當下 Database 的資料判斷，不快取。
pub async fn person_of<'e>(
    conn: impl PgExecutor<'e>,
    trip: TripId,
    user: UserId,
) -> sqlx::Result<Option<PersonId>> {
    let id = sqlx::query_scalar::<_, Uuid>(
        "select id from app.people where trip_id = $1 and user_id = $2",
    )
    .bind(trip.0)
    .bind(user.0)
    .fetch_optional(conn)
    .await?;
    Ok(id.map(PersonId))
}
