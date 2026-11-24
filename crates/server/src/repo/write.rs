//! `write_changes()`：把一次提交的變化寫回各資料表（需求 8.1–8.4、8.10）。
//!
//! 每一種列一批：同一種列的刪除、子表的清除、父列的 upsert 與子表的新增各是一個語句（以 `unnest` 一次寫入多列），
//! 所以語句數不隨變化的列數增加。依下列順序執行：
//!
//! 1. 刪除：依 Slot 刪除父列；Database 以 `on delete cascade` 一併刪除它自己的子表列與停靠點（需求 8.2）。
//! 2. 清除要寫入的父列原本的子表列與停靠點。
//! 3. 父列以 `ON CONFLICT (trip_id, id) DO UPDATE` 寫入（每日設定的鍵是日期、出發確認是旅伴 id）；Trip_Card 以
//!    UPDATE 寫回 `app.trips` 的欄位與 `version`。
//! 4. 新增子表列與停靠點：子表整組替換成列中的集合。
//!
//! 先清除、再新增，所以一個停靠點在同一次提交中從一條路線移到另一條時，不會與它原本的列衝突。外鍵與四個唯一鍵都是
//! `DEFERRABLE INITIALLY DEFERRED`，在 COMMIT 時檢查（需求 8.5），所以列之間的引用不受寫入順序影響；檢查失敗時
//! COMMIT 回傳錯誤、整個交易回滾。
//!
//! 只寫入 Change_Set 中的列，其他列的內容與 Row_Version 不變（需求 8.10）。旅伴的 `user_id` 只在新增時寫入：
//! `write_changes()` 新增的旅伴一律沒有綁定帳號，更新既有旅伴時不改變 `user_id`；綁定帳號的旅伴（建立旅行的建立者、
//! 以邀請連結加入的帳號）先以 `insert_bound_person()` 帶 `user_id` 新增。
//!
//! SQL 中的資料表與欄位名稱都是這個檔案中的常數；使用者的資料一律以參數傳入。
use std::collections::BTreeMap;

use lm_core::ids::{TripId, UserId};
use lm_core::model::{
    Activity, DaySetting, Departure, Entity, Expense, GearItem, Meal, Participation, Person, Place,
    PlaceRef, Route, Row, RowKey, Settlement, ShoppingItem, TripCard, Vehicle,
};
use lm_core::sync::Change;
use lm_core::text::{participant_key, place_key};
use lm_core::time::Hm;
use sqlx::types::{Json, Uuid};

use super::{to_i64, PgTx};

/// 一次提交的變化寫進目前的交易（見模組說明）。每筆 `Change` 的 `row` 必須屬於它的 Slot；Trip_Card 不能刪除。
pub async fn write_changes(tx: &mut PgTx, trip: TripId, changes: &[Change]) -> sqlx::Result<()> {
    let mut batch = Batch::default();
    for change in changes {
        match &change.row {
            None => batch.delete(change.entity, change.key)?,
            Some(row) => {
                if row.slot() != change.slot() {
                    return Err(invalid(format!(
                        "row {:?} does not belong to slot {:?}",
                        row.slot(),
                        change.slot()
                    )));
                }
                batch.upsert(row);
            }
        }
    }
    batch.write(tx, trip).await
}

/// 新增綁定 `user` 的旅伴（建立旅行與以邀請連結加入，需求 17.3、30.10）。之後以 `write_changes()` 更新這位旅伴時，
/// `user_id` 不變。
pub async fn insert_bound_person(
    tx: &mut PgTx,
    trip: TripId,
    person: &Person,
    user: UserId,
) -> sqlx::Result<()> {
    upsert_people(tx, trip, &[person], Some(user)).await
}

fn invalid(message: String) -> sqlx::Error {
    sqlx::Error::Encode(message.into())
}

// ── 依種類分組 ──

#[derive(Default)]
struct Batch<'a> {
    /// 要刪除的列，依種類分組。
    deletes: BTreeMap<Entity, Vec<RowKey>>,
    card: Option<&'a TripCard>,
    people: Vec<&'a Person>,
    vehicles: Vec<&'a Vehicle>,
    places: Vec<&'a Place>,
    routes: Vec<&'a Route>,
    day_settings: Vec<&'a DaySetting>,
    activities: Vec<&'a Activity>,
    meals: Vec<&'a Meal>,
    shopping: Vec<&'a ShoppingItem>,
    gear: Vec<&'a GearItem>,
    departures: Vec<&'a Departure>,
    expenses: Vec<&'a Expense>,
    settlements: Vec<&'a Settlement>,
}

impl<'a> Batch<'a> {
    fn delete(&mut self, entity: Entity, key: RowKey) -> sqlx::Result<()> {
        if entity == Entity::Card {
            return Err(invalid("the trip card cannot be deleted".to_owned()));
        }
        self.deletes.entry(entity).or_default().push(key);
        Ok(())
    }

    fn upsert(&mut self, row: &'a Row) {
        match row {
            Row::Card(row) => self.card = Some(row),
            Row::Person(row) => self.people.push(row),
            Row::Vehicle(row) => self.vehicles.push(row),
            Row::Place(row) => self.places.push(row),
            Row::Route(row) => self.routes.push(row),
            Row::DaySetting(row) => self.day_settings.push(row),
            Row::Activity(row) => self.activities.push(row),
            Row::Meal(row) => self.meals.push(row),
            Row::Shopping(row) => self.shopping.push(row),
            Row::Gear(row) => self.gear.push(row),
            Row::Departure(row) => self.departures.push(row),
            Row::Expense(row) => self.expenses.push(row),
            Row::Settlement(row) => self.settlements.push(row),
        }
    }

    async fn write(self, tx: &mut PgTx, trip: TripId) -> sqlx::Result<()> {
        // 1. 刪除
        for (entity, keys) in &self.deletes {
            delete_rows(tx, trip, *entity, keys).await?;
        }

        // 2. 清除要寫入的父列的子表列
        let vehicle_ids = ids(&self.vehicles, |row| row.id.0);
        let route_ids = ids(&self.routes, |row| row.id.0);
        let activity_ids = ids(&self.activities, |row| row.id.0);
        let shopping_ids = ids(&self.shopping, |row| row.id.0);
        let gear_ids = ids(&self.gear, |row| row.id.0);
        let expense_ids = ids(&self.expenses, |row| row.id.0);
        for (child, parents) in [
            (VEHICLE_PASSENGERS, &vehicle_ids),
            (STOPS, &route_ids),
            (ACTIVITY_PEOPLE, &activity_ids),
            (ACTIVITY_VEHICLES, &activity_ids),
            (SHOPPING_ITEM_MEALS, &shopping_ids),
            (GEAR_PACKED, &gear_ids),
            (EXPENSE_PARTICIPANTS, &expense_ids),
        ] {
            clear_children(tx, trip, child, parents).await?;
        }

        // 3. 父列
        if let Some(card) = self.card {
            update_card(tx, trip, card).await?;
        }
        upsert_people(tx, trip, &self.people, None).await?;
        upsert_vehicles(tx, trip, &self.vehicles).await?;
        upsert_places(tx, trip, &self.places).await?;
        upsert_routes(tx, trip, &self.routes).await?;
        upsert_day_settings(tx, trip, &self.day_settings).await?;
        upsert_activities(tx, trip, &self.activities).await?;
        upsert_meals(tx, trip, &self.meals).await?;
        upsert_shopping(tx, trip, &self.shopping).await?;
        upsert_gear(tx, trip, &self.gear).await?;
        upsert_departures(tx, trip, &self.departures).await?;
        upsert_expenses(tx, trip, &self.expenses).await?;
        upsert_settlements(tx, trip, &self.settlements).await?;

        // 4. 子表列與停靠點
        insert_pairs(tx, trip, VEHICLE_PASSENGERS, &self.vehicles, |row| {
            row.passengers.iter().map(|id| id.0).collect()
        })
        .await?;
        insert_stops(tx, trip, &self.routes).await?;
        insert_pairs(
            tx,
            trip,
            ACTIVITY_PEOPLE,
            &self.activities,
            |row| match &row.who {
                Participation::People(people) => people.iter().map(|id| id.0).collect(),
                _ => Vec::new(),
            },
        )
        .await?;
        insert_pairs(
            tx,
            trip,
            ACTIVITY_VEHICLES,
            &self.activities,
            |row| match &row.who {
                Participation::Vehicles(vehicles) => vehicles.iter().map(|id| id.0).collect(),
                _ => Vec::new(),
            },
        )
        .await?;
        insert_pairs(tx, trip, SHOPPING_ITEM_MEALS, &self.shopping, |row| {
            row.meal_ids.iter().map(|id| id.0).collect()
        })
        .await?;
        insert_pairs(tx, trip, GEAR_PACKED, &self.gear, |row| {
            row.packed_by.iter().map(|id| id.0).collect()
        })
        .await?;
        insert_pairs(tx, trip, EXPENSE_PARTICIPANTS, &self.expenses, |row| {
            row.participants.iter().map(|id| id.0).collect()
        })
        .await?;
        Ok(())
    }
}

fn ids<T>(rows: &[&T], id: fn(&T) -> Uuid) -> Vec<Uuid> {
    rows.iter().map(|row| id(row)).collect()
}

fn ordinals_versions<T>(
    rows: &[&T],
    ordinal: fn(&T) -> u64,
    version: fn(&T) -> u64,
) -> sqlx::Result<(Vec<i64>, Vec<i64>)> {
    let ordinals = rows
        .iter()
        .map(|row| to_i64(ordinal(row), "ordinal"))
        .collect::<sqlx::Result<_>>()?;
    let versions = rows
        .iter()
        .map(|row| to_i64(version(row), "version"))
        .collect::<sqlx::Result<_>>()?;
    Ok((ordinals, versions))
}

fn place_id(place: PlaceRef) -> Option<Uuid> {
    match place {
        PlaceRef::Destination => None,
        PlaceRef::Place(id) => Some(id.0),
    }
}

fn hm_text(time: Option<Hm>) -> Option<String> {
    time.map(|time| time.to_string())
}

// ── 刪除 ──

/// 依 Slot 刪除一種列（Trip_Card 已在 `Batch::delete()` 排除）。
async fn delete_rows(
    tx: &mut PgTx,
    trip: TripId,
    entity: Entity,
    keys: &[RowKey],
) -> sqlx::Result<()> {
    let (table, column) = match entity {
        Entity::Card => return Err(invalid("the trip card cannot be deleted".to_owned())),
        Entity::Person => ("app.people", "id"),
        Entity::Vehicle => ("app.vehicles", "id"),
        Entity::Place => ("app.places", "id"),
        Entity::Route => ("app.routes", "id"),
        Entity::DaySetting => ("app.day_settings", "day"),
        Entity::Activity => ("app.activities", "id"),
        Entity::Meal => ("app.meals", "id"),
        Entity::Shopping => ("app.shopping_items", "id"),
        Entity::Gear => ("app.gear_items", "id"),
        Entity::Departure => ("app.departures", "person_id"),
        Entity::Expense => ("app.expenses", "id"),
        Entity::Settlement => ("app.settlements", "id"),
    };
    let sql = format!("delete from {table} where trip_id = $1 and {column} = any($2)");
    let query = sqlx::query(&sql).bind(trip.0);
    let query = if entity == Entity::DaySetting {
        let days = keys
            .iter()
            .map(|key| match key {
                RowKey::Day(day) => Ok(*day),
                RowKey::Id(id) => Err(invalid(format!("day setting key is not a date: {id}"))),
            })
            .collect::<sqlx::Result<Vec<_>>>()?;
        query.bind(days)
    } else {
        let ids = keys
            .iter()
            .map(|key| match key {
                RowKey::Id(id) => Ok(*id),
                RowKey::Day(day) => Err(invalid(format!("{entity:?} key is not an id: {day}"))),
            })
            .collect::<sqlx::Result<Vec<_>>>()?;
        query.bind(ids)
    };
    query.execute(&mut **tx).await?;
    Ok(())
}

// ── 子表 ──

/// 一張「父列 id 加一個被引用的 id」的子表。
#[derive(Clone, Copy)]
struct ChildTable {
    table: &'static str,
    parent: &'static str,
    member: &'static str,
}

const VEHICLE_PASSENGERS: ChildTable = ChildTable {
    table: "app.vehicle_passengers",
    parent: "vehicle_id",
    member: "person_id",
};
const ACTIVITY_PEOPLE: ChildTable = ChildTable {
    table: "app.activity_people",
    parent: "activity_id",
    member: "person_id",
};
const ACTIVITY_VEHICLES: ChildTable = ChildTable {
    table: "app.activity_vehicles",
    parent: "activity_id",
    member: "vehicle_id",
};
const SHOPPING_ITEM_MEALS: ChildTable = ChildTable {
    table: "app.shopping_item_meals",
    parent: "item_id",
    member: "meal_id",
};
const GEAR_PACKED: ChildTable = ChildTable {
    table: "app.gear_packed",
    parent: "gear_id",
    member: "person_id",
};
const EXPENSE_PARTICIPANTS: ChildTable = ChildTable {
    table: "app.expense_participants",
    parent: "expense_id",
    member: "person_id",
};
/// 停靠點也以所屬路線整組替換（只用於清除；新增由 `insert_stops()` 寫入每個欄位）。
const STOPS: ChildTable = ChildTable {
    table: "app.stops",
    parent: "route_id",
    member: "id",
};

/// 刪除 `parents` 中每個父列的子表列。
async fn clear_children(
    tx: &mut PgTx,
    trip: TripId,
    child: ChildTable,
    parents: &[Uuid],
) -> sqlx::Result<()> {
    if parents.is_empty() {
        return Ok(());
    }
    sqlx::query(&format!(
        "delete from {table} where trip_id = $1 and {parent} = any($2)",
        table = child.table,
        parent = child.parent,
    ))
    .bind(trip.0)
    .bind(parents)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// 新增每個父列的子表列：`members(父列)` 中的每個 id 一列。
async fn insert_pairs<T: HasId>(
    tx: &mut PgTx,
    trip: TripId,
    child: ChildTable,
    rows: &[&T],
    members: impl Fn(&T) -> Vec<Uuid>,
) -> sqlx::Result<()> {
    let mut parents = Vec::new();
    let mut ids = Vec::new();
    for row in rows {
        for member in members(row) {
            parents.push(row.uuid());
            ids.push(member);
        }
    }
    if parents.is_empty() {
        return Ok(());
    }
    sqlx::query(&format!(
        "insert into {table} (trip_id, {parent}, {member}) \
         select $1, u.parent, u.member from unnest($2::uuid[], $3::uuid[]) as u(parent, member)",
        table = child.table,
        parent = child.parent,
        member = child.member,
    ))
    .bind(trip.0)
    .bind(parents)
    .bind(ids)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

trait HasId {
    fn uuid(&self) -> Uuid;
}

impl HasId for Vehicle {
    fn uuid(&self) -> Uuid {
        self.id.0
    }
}
impl HasId for Activity {
    fn uuid(&self) -> Uuid {
        self.id.0
    }
}
impl HasId for ShoppingItem {
    fn uuid(&self) -> Uuid {
        self.id.0
    }
}
impl HasId for GearItem {
    fn uuid(&self) -> Uuid {
        self.id.0
    }
}
impl HasId for Expense {
    fn uuid(&self) -> Uuid {
        self.id.0
    }
}

/// 每條路線的停靠點，`position` 是在路線中的順序（0–5）。
async fn insert_stops(tx: &mut PgTx, trip: TripId, routes: &[&Route]) -> sqlx::Result<()> {
    let mut ids = Vec::new();
    let mut route_ids = Vec::new();
    let mut positions = Vec::new();
    let mut places = Vec::new();
    let mut kinds = Vec::new();
    let mut tasks = Vec::new();
    let mut notes = Vec::new();
    let mut times = Vec::new();
    let mut items = Vec::new();
    for route in routes {
        for (position, stop) in route.stops.iter().enumerate() {
            ids.push(stop.id.0);
            route_ids.push(route.id.0);
            positions.push(
                i16::try_from(position)
                    .map_err(|_| invalid(format!("stop position {position} out of range")))?,
            );
            places.push(place_id(stop.place));
            kinds.push(stop.kind.as_str());
            tasks.push(stop.task.map(|task| task.as_str()));
            notes.push(stop.note.as_str());
            times.push(hm_text(stop.time));
            items.push(Json(&stop.items));
        }
    }
    if ids.is_empty() {
        return Ok(());
    }
    // 每個停靠點的清單長度不同，不能以多維的 text[] 傳入；每個停靠點傳一個 jsonb 陣列，再轉成 text[]
    sqlx::query(
        "insert into app.stops (trip_id, id, route_id, position, place_id, kind, task_kind, note, stop_time, \
                                items) \
         select $1, u.id, u.route_id, u.position, u.place_id, u.kind, u.task_kind, u.note, u.stop_time, \
                array(select jsonb_array_elements_text(u.items)) \
         from unnest($2::uuid[], $3::uuid[], $4::smallint[], $5::uuid[], $6::text[], $7::text[], $8::text[], \
                     $9::text[], $10::jsonb[]) \
              as u(id, route_id, position, place_id, kind, task_kind, note, stop_time, items)",
    )
    .bind(trip.0)
    .bind(ids)
    .bind(route_ids)
    .bind(positions)
    .bind(places)
    .bind(kinds)
    .bind(tasks)
    .bind(notes)
    .bind(times)
    .bind(items)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

// ── 父列 ──

/// Trip_Card 寫回 `app.trips` 中這趟旅行的那一列（需求 8.1）；`seq`、`next_ordinal` 由 `finish()` 更新。
async fn update_card(tx: &mut PgTx, trip: TripId, card: &TripCard) -> sqlx::Result<()> {
    if card.id != trip {
        return Err(invalid(format!("trip card {} is not trip {trip}", card.id)));
    }
    let result = sqlx::query(
        "update app.trips set title = $2, destination = $3, start_date = $4, end_date = $5, \
                description = $6, note = $7, cover_kind = $8, status = $9, version = $10, \
                headline = $11, caption = $12 \
         where id = $1",
    )
    .bind(trip.0)
    .bind(&card.title)
    .bind(&card.destination)
    .bind(card.start)
    .bind(card.end)
    .bind(&card.description)
    .bind(&card.note)
    .bind(card.cover.as_str())
    .bind(card.status.as_str())
    .bind(to_i64(card.version, "version")?)
    .bind(&card.headline)
    .bind(&card.caption)
    .execute(&mut **tx)
    .await?;
    if result.rows_affected() != 1 {
        return Err(sqlx::Error::RowNotFound);
    }
    Ok(())
}

/// 旅伴的 upsert。新增的列以 `user` 作為 `user_id`（`write_changes()` 傳 `None`）；更新既有的列時不改變
/// `user_id`。`name_key` 是 Participant_Key（`unique (trip_id, name_key)` 在 COMMIT 時檢查）。
async fn upsert_people(
    tx: &mut PgTx,
    trip: TripId,
    rows: &[&Person],
    user: Option<UserId>,
) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let (ordinals, versions) = ordinals_versions(rows, |row| row.ordinal, |row| row.version)?;
    sqlx::query(
        "insert into app.people (trip_id, id, user_id, name, name_key, role, color, ordinal, version) \
         select $1, u.id, $2, u.name, u.name_key, u.role, u.color, u.ordinal, u.version \
         from unnest($3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::bigint[], $9::bigint[]) \
              as u(id, name, name_key, role, color, ordinal, version) \
         on conflict (trip_id, id) do update set \
           name = excluded.name, name_key = excluded.name_key, role = excluded.role, \
           color = excluded.color, ordinal = excluded.ordinal, version = excluded.version",
    )
    .bind(trip.0)
    .bind(user.map(|user| user.0))
    .bind(ids(rows, |row| row.id.0))
    .bind(rows.iter().map(|row| row.name.as_str()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| participant_key(&row.name)).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.role.as_str()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.color.as_str()).collect::<Vec<_>>())
    .bind(ordinals)
    .bind(versions)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn upsert_vehicles(tx: &mut PgTx, trip: TripId, rows: &[&Vehicle]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let (ordinals, versions) = ordinals_versions(rows, |row| row.ordinal, |row| row.version)?;
    sqlx::query(
        "insert into app.vehicles (trip_id, id, name, driver_id, seats, color, ordinal, version) \
         select $1, u.id, u.name, u.driver_id, u.seats, u.color, u.ordinal, u.version \
         from unnest($2::uuid[], $3::text[], $4::uuid[], $5::smallint[], $6::text[], $7::bigint[], $8::bigint[]) \
              as u(id, name, driver_id, seats, color, ordinal, version) \
         on conflict (trip_id, id) do update set \
           name = excluded.name, driver_id = excluded.driver_id, seats = excluded.seats, \
           color = excluded.color, ordinal = excluded.ordinal, version = excluded.version",
    )
    .bind(trip.0)
    .bind(ids(rows, |row| row.id.0))
    .bind(rows.iter().map(|row| row.name.as_str()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.driver.map(|id| id.0)).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| i16::from(row.seats)).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.color.as_deref()).collect::<Vec<_>>())
    .bind(ordinals)
    .bind(versions)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// 地點的 `name_key` 是 Place_Key（`unique (trip_id, name_key)` 在 COMMIT 時檢查）。
async fn upsert_places(tx: &mut PgTx, trip: TripId, rows: &[&Place]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let (ordinals, versions) = ordinals_versions(rows, |row| row.ordinal, |row| row.version)?;
    sqlx::query(
        "insert into app.places (trip_id, id, name, name_key, template, ordinal, version) \
         select $1, u.id, u.name, u.name_key, u.template, u.ordinal, u.version \
         from unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::bigint[]) \
              as u(id, name, name_key, template, ordinal, version) \
         on conflict (trip_id, id) do update set \
           name = excluded.name, name_key = excluded.name_key, template = excluded.template, \
           ordinal = excluded.ordinal, version = excluded.version",
    )
    .bind(trip.0)
    .bind(ids(rows, |row| row.id.0))
    .bind(rows.iter().map(|row| row.name.as_str()).collect::<Vec<_>>())
    .bind(
        rows.iter()
            .map(|row| place_key(&row.name))
            .collect::<Vec<_>>(),
    )
    .bind(
        rows.iter()
            .map(|row| row.template.map(|template| template.as_str()))
            .collect::<Vec<_>>(),
    )
    .bind(ordinals)
    .bind(versions)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn upsert_routes(tx: &mut PgTx, trip: TripId, rows: &[&Route]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let (ordinals, versions) = ordinals_versions(rows, |row| row.ordinal, |row| row.version)?;
    sqlx::query(
        "insert into app.routes (trip_id, id, day, vehicle_id, from_place_id, to_place_id, depart_time, \
                                 ordinal, version) \
         select $1, u.id, u.day, u.vehicle_id, u.from_place_id, u.to_place_id, u.depart_time, u.ordinal, \
                u.version \
         from unnest($2::uuid[], $3::date[], $4::uuid[], $5::uuid[], $6::uuid[], $7::text[], $8::bigint[], \
                     $9::bigint[]) \
              as u(id, day, vehicle_id, from_place_id, to_place_id, depart_time, ordinal, version) \
         on conflict (trip_id, id) do update set \
           day = excluded.day, vehicle_id = excluded.vehicle_id, from_place_id = excluded.from_place_id, \
           to_place_id = excluded.to_place_id, depart_time = excluded.depart_time, \
           ordinal = excluded.ordinal, version = excluded.version",
    )
    .bind(trip.0)
    .bind(ids(rows, |row| row.id.0))
    .bind(rows.iter().map(|row| row.day).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.vehicle.0).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| place_id(row.from)).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| place_id(row.to)).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| hm_text(row.depart)).collect::<Vec<_>>())
    .bind(ordinals)
    .bind(versions)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn upsert_day_settings(
    tx: &mut PgTx,
    trip: TripId,
    rows: &[&DaySetting],
) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let versions = rows
        .iter()
        .map(|row| to_i64(row.version, "version"))
        .collect::<sqlx::Result<Vec<_>>>()?;
    sqlx::query(
        "insert into app.day_settings (trip_id, day, title, place_id, arrival, arrival_label, route_position, \
                                       version) \
         select $1, u.day, u.title, u.place_id, u.arrival, u.arrival_label, u.route_position, u.version \
         from unnest($2::date[], $3::text[], $4::uuid[], $5::text[], $6::text[], $7::text[], $8::bigint[]) \
              as u(day, title, place_id, arrival, arrival_label, route_position, version) \
         on conflict (trip_id, day) do update set \
           title = excluded.title, place_id = excluded.place_id, arrival = excluded.arrival, \
           arrival_label = excluded.arrival_label, route_position = excluded.route_position, \
           version = excluded.version",
    )
    .bind(trip.0)
    .bind(rows.iter().map(|row| row.day).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.title.as_deref()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.place.map(|id| id.0)).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| hm_text(row.arrival)).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.arrival_label.as_deref()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.route_position.as_str()).collect::<Vec<_>>())
    .bind(versions)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// 活動的參加者寫在 `activity_people` 或 `activity_vehicles`（`insert_pairs()`），全體旅伴時兩張都沒有列。
async fn upsert_activities(tx: &mut PgTx, trip: TripId, rows: &[&Activity]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let (ordinals, versions) = ordinals_versions(rows, |row| row.ordinal, |row| row.version)?;
    sqlx::query(
        "insert into app.activities (trip_id, id, day, start_time, title, kind, location, note, done, \
                                     ordinal, version) \
         select $1, u.id, u.day, u.start_time, u.title, u.kind, u.location, u.note, u.done, u.ordinal, \
                u.version \
         from unnest($2::uuid[], $3::date[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], \
                     $9::boolean[], $10::bigint[], $11::bigint[]) \
              as u(id, day, start_time, title, kind, location, note, done, ordinal, version) \
         on conflict (trip_id, id) do update set \
           day = excluded.day, start_time = excluded.start_time, title = excluded.title, \
           kind = excluded.kind, location = excluded.location, note = excluded.note, \
           done = excluded.done, ordinal = excluded.ordinal, version = excluded.version",
    )
    .bind(trip.0)
    .bind(ids(rows, |row| row.id.0))
    .bind(rows.iter().map(|row| row.day).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.time.to_string()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.title.as_str()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.kind.as_str()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.location.as_str()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.note.as_str()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.done).collect::<Vec<_>>())
    .bind(ordinals)
    .bind(versions)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn upsert_meals(tx: &mut PgTx, trip: TripId, rows: &[&Meal]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let (ordinals, versions) = ordinals_versions(rows, |row| row.ordinal, |row| row.version)?;
    sqlx::query(
        "insert into app.meals (trip_id, id, day, slot, meal_time, title, cook_id, servings, ingredients, \
                                notes, dish_kind, ordinal, version) \
         select $1, u.id, u.day, u.slot, u.meal_time, u.title, u.cook_id, u.servings, u.ingredients, \
                u.notes, u.dish_kind, u.ordinal, u.version \
         from unnest($2::uuid[], $3::date[], $4::text[], $5::text[], $6::text[], $7::uuid[], $8::smallint[], \
                     $9::text[], $10::text[], $11::text[], $12::bigint[], $13::bigint[]) \
              as u(id, day, slot, meal_time, title, cook_id, servings, ingredients, notes, dish_kind, \
                   ordinal, version) \
         on conflict (trip_id, id) do update set \
           day = excluded.day, slot = excluded.slot, meal_time = excluded.meal_time, \
           title = excluded.title, cook_id = excluded.cook_id, servings = excluded.servings, \
           ingredients = excluded.ingredients, notes = excluded.notes, dish_kind = excluded.dish_kind, \
           ordinal = excluded.ordinal, version = excluded.version",
    )
    .bind(trip.0)
    .bind(ids(rows, |row| row.id.0))
    .bind(rows.iter().map(|row| row.day).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.slot.as_str()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| hm_text(row.time)).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.title.as_str()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.cook.map(|id| id.0)).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| i16::from(row.servings)).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.ingredients.as_str()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.notes.as_str()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.dish.map(|dish| dish.as_str())).collect::<Vec<_>>())
    .bind(ordinals)
    .bind(versions)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn upsert_shopping(tx: &mut PgTx, trip: TripId, rows: &[&ShoppingItem]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let (ordinals, versions) = ordinals_versions(rows, |row| row.ordinal, |row| row.version)?;
    sqlx::query(
        "insert into app.shopping_items (trip_id, id, name, quantity, category, assignee_id, purchased, \
                                         source, recipe_removed, ordinal, version) \
         select $1, u.id, u.name, u.quantity, u.category, u.assignee_id, u.purchased, u.source, \
                u.recipe_removed, u.ordinal, u.version \
         from unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::uuid[], $7::boolean[], $8::text[], \
                     $9::boolean[], $10::bigint[], $11::bigint[]) \
              as u(id, name, quantity, category, assignee_id, purchased, source, recipe_removed, ordinal, \
                   version) \
         on conflict (trip_id, id) do update set \
           name = excluded.name, quantity = excluded.quantity, category = excluded.category, \
           assignee_id = excluded.assignee_id, purchased = excluded.purchased, source = excluded.source, \
           recipe_removed = excluded.recipe_removed, ordinal = excluded.ordinal, version = excluded.version",
    )
    .bind(trip.0)
    .bind(ids(rows, |row| row.id.0))
    .bind(rows.iter().map(|row| row.name.as_str()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.quantity.as_str()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.category.as_str()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.assignee.map(|id| id.0)).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.purchased).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.source.as_str()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.recipe_removed).collect::<Vec<_>>())
    .bind(ordinals)
    .bind(versions)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn upsert_gear(tx: &mut PgTx, trip: TripId, rows: &[&GearItem]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let (ordinals, versions) = ordinals_versions(rows, |row| row.ordinal, |row| row.version)?;
    sqlx::query(
        "insert into app.gear_items (trip_id, id, name, quantity, scope, assignee_id, ordinal, version) \
         select $1, u.id, u.name, u.quantity, u.scope, u.assignee_id, u.ordinal, u.version \
         from unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::uuid[], $7::bigint[], $8::bigint[]) \
              as u(id, name, quantity, scope, assignee_id, ordinal, version) \
         on conflict (trip_id, id) do update set \
           name = excluded.name, quantity = excluded.quantity, scope = excluded.scope, \
           assignee_id = excluded.assignee_id, ordinal = excluded.ordinal, version = excluded.version",
    )
    .bind(trip.0)
    .bind(ids(rows, |row| row.id.0))
    .bind(rows.iter().map(|row| row.name.as_str()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.quantity.as_str()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.scope.as_str()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.assignee.map(|id| id.0)).collect::<Vec<_>>())
    .bind(ordinals)
    .bind(versions)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// 出發確認：既有的列只更新 `version`，`departed_at` 保留第一次確認的時間。
async fn upsert_departures(tx: &mut PgTx, trip: TripId, rows: &[&Departure]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let versions = rows
        .iter()
        .map(|row| to_i64(row.version, "version"))
        .collect::<sqlx::Result<Vec<_>>>()?;
    sqlx::query(
        "insert into app.departures (trip_id, person_id, version) \
         select $1, u.person_id, u.version from unnest($2::uuid[], $3::bigint[]) as u(person_id, version) \
         on conflict (trip_id, person_id) do update set version = excluded.version",
    )
    .bind(trip.0)
    .bind(rows.iter().map(|row| row.person.0).collect::<Vec<_>>())
    .bind(versions)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn upsert_expenses(tx: &mut PgTx, trip: TripId, rows: &[&Expense]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let (ordinals, versions) = ordinals_versions(rows, |row| row.ordinal, |row| row.version)?;
    sqlx::query(
        "insert into app.expenses (trip_id, id, spent_on, title, amount_cents, payer_id, category, note, \
                                   shopping_item_id, ordinal, version) \
         select $1, u.id, u.spent_on, u.title, u.amount_cents, u.payer_id, u.category, u.note, \
                u.shopping_item_id, u.ordinal, u.version \
         from unnest($2::uuid[], $3::date[], $4::text[], $5::bigint[], $6::uuid[], $7::text[], $8::text[], \
                     $9::uuid[], $10::bigint[], $11::bigint[]) \
              as u(id, spent_on, title, amount_cents, payer_id, category, note, shopping_item_id, ordinal, \
                   version) \
         on conflict (trip_id, id) do update set \
           spent_on = excluded.spent_on, title = excluded.title, amount_cents = excluded.amount_cents, \
           payer_id = excluded.payer_id, category = excluded.category, note = excluded.note, \
           shopping_item_id = excluded.shopping_item_id, ordinal = excluded.ordinal, \
           version = excluded.version",
    )
    .bind(trip.0)
    .bind(ids(rows, |row| row.id.0))
    .bind(rows.iter().map(|row| row.day).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.title.as_str()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.amount_cents).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.payer.0).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.category.as_str()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.note.as_str()).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.shopping_item.map(|id| id.0)).collect::<Vec<_>>())
    .bind(ordinals)
    .bind(versions)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn upsert_settlements(tx: &mut PgTx, trip: TripId, rows: &[&Settlement]) -> sqlx::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let (ordinals, versions) = ordinals_versions(rows, |row| row.ordinal, |row| row.version)?;
    sqlx::query(
        "insert into app.settlements (trip_id, id, paid_on, from_id, to_id, amount_cents, note, ordinal, \
                                      version) \
         select $1, u.id, u.paid_on, u.from_id, u.to_id, u.amount_cents, u.note, u.ordinal, u.version \
         from unnest($2::uuid[], $3::date[], $4::uuid[], $5::uuid[], $6::bigint[], $7::text[], $8::bigint[], \
                     $9::bigint[]) \
              as u(id, paid_on, from_id, to_id, amount_cents, note, ordinal, version) \
         on conflict (trip_id, id) do update set \
           paid_on = excluded.paid_on, from_id = excluded.from_id, to_id = excluded.to_id, \
           amount_cents = excluded.amount_cents, note = excluded.note, ordinal = excluded.ordinal, \
           version = excluded.version",
    )
    .bind(trip.0)
    .bind(ids(rows, |row| row.id.0))
    .bind(rows.iter().map(|row| row.day).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.from.0).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.to.0).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.amount_cents).collect::<Vec<_>>())
    .bind(rows.iter().map(|row| row.note.as_str()).collect::<Vec<_>>())
    .bind(ordinals)
    .bind(versions)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
