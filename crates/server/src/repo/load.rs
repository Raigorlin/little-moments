//! `load_trip()`：讀出一趟旅行的完整 Trip_State（需求 8.1、8.2）。
//!
//! 每張旅行內容表一個 SELECT（Trip_Card 讀 `app.trips`），共 13 個；子表（車輛乘客、停靠點、活動的指定旅伴與指定車輛、
//! 採買品項的料理連結、打包勾選、支出的分攤旅伴）以 `array_agg` 併進父列，所以子表的內容與父列在同一個查詢中讀出。
//! 停靠點依 `position` 排列；其他子表是集合，順序不重要（`BTreeSet`）。
//!
//! `Person.bound` 由 `app.people.user_id` 是否為 NULL 推得；帳號 id 不讀進 Trip_State，所以不會出現在 Snapshot 與
//! Change_Set 中。
//!
//! 欄位值由 Database 的 CHECK 保證屬於 Enum_Table 與 Limits_Table；讀到不符的值（代表 Database 被繞過 lm-server
//! 修改）時回傳 `sqlx::Error::ColumnDecode`，呼叫端回應 500。
use std::collections::{BTreeMap, BTreeSet};

use lm_core::ids::{
    ActivityId, ExpenseId, GearId, MealId, PersonId, PlaceId, RouteId, SettlementId, ShoppingId,
    StopId, TripId, VehicleId,
};
use lm_core::model::{
    Activity, ActivityKind, Category, Color, CoverKind, Date, DaySetting, Departure, DishKind,
    Expense, ExpenseCategory, GearItem, GearScope, ItemSource, Meal, MealSlot, Participation,
    Person, Place, PlaceRef, PlaceTemplate, Route, RoutePosition, Settlement, ShoppingItem, Stop,
    StopKind, StopTask, TripCard, TripState, TripStatus, Vehicle,
};
use lm_core::time::Hm;
use sqlx::postgres::PgRow;
use sqlx::types::{Json, Uuid};
use sqlx::{Decode, Postgres, Row as _, Type};

use super::{to_u64, PgTx};

/// 一趟旅行的完整 Trip_State，包括已刪除的旅行（呼叫端先以 `lock_trip()` 或 `read_head()` 確認旅行未刪除）。
/// 旅行不存在時是 `sqlx::Error::RowNotFound`。
pub async fn load_trip(tx: &mut PgTx, trip: TripId) -> sqlx::Result<TripState> {
    let card = sqlx::query(
        "select id, title, destination, start_date, end_date, description, note, headline, caption, \
                cover_kind, status, version \
         from app.trips where id = $1",
    )
    .bind(trip.0)
    .fetch_one(&mut **tx)
    .await?;
    let mut state = TripState::new(card_row(&card)?);

    state.people = rows(
        tx,
        trip,
        "select id, name, role, color, user_id is not null as bound, ordinal, version \
         from app.people where trip_id = $1",
        person_row,
    )
    .await?;
    state.vehicles = rows(
        tx,
        trip,
        "select v.id, v.name, v.driver_id, v.seats, v.color, v.ordinal, v.version, \
                coalesce((select array_agg(p.person_id) from app.vehicle_passengers p \
                          where p.trip_id = v.trip_id and p.vehicle_id = v.id), '{}') as passengers \
         from app.vehicles v where v.trip_id = $1",
        vehicle_row,
    )
    .await?;
    state.places = rows(
        tx,
        trip,
        "select id, name, template, ordinal, version from app.places where trip_id = $1",
        place_row,
    )
    .await?;
    state.routes = rows(
        tx,
        trip,
        "select r.id, r.day, r.vehicle_id, r.from_place_id, r.to_place_id, r.depart_time, r.ordinal, r.version, \
                coalesce(s.ids, '{}') as stop_ids, coalesce(s.places, '{}') as stop_places, \
                coalesce(s.kinds, '{}') as stop_kinds, coalesce(s.tasks, '{}') as stop_tasks, \
                coalesce(s.notes, '{}') as stop_notes, coalesce(s.times, '{}') as stop_times, \
                coalesce(s.items, '[]'::jsonb) as stop_items \
         from app.routes r \
         left join lateral ( \
           select array_agg(s.id order by s.position) as ids, \
                  array_agg(s.place_id order by s.position) as places, \
                  array_agg(s.kind order by s.position) as kinds, \
                  array_agg(s.task_kind order by s.position) as tasks, \
                  array_agg(s.note order by s.position) as notes, \
                  array_agg(s.stop_time order by s.position) as times, \
                  jsonb_agg(to_jsonb(s.items) order by s.position) as items \
           from app.stops s where s.trip_id = r.trip_id and s.route_id = r.id \
         ) s on true \
         where r.trip_id = $1",
        route_row,
    )
    .await?;
    state.day_settings = rows(
        tx,
        trip,
        "select day, title, place_id, arrival, arrival_label, route_position, version \
         from app.day_settings where trip_id = $1",
        day_setting_row,
    )
    .await?;
    state.activities = rows(
        tx,
        trip,
        "select a.id, a.day, a.start_time, a.title, a.kind, a.location, a.note, a.done, a.ordinal, a.version, \
                coalesce((select array_agg(p.person_id) from app.activity_people p \
                          where p.trip_id = a.trip_id and p.activity_id = a.id), '{}') as people, \
                coalesce((select array_agg(v.vehicle_id) from app.activity_vehicles v \
                          where v.trip_id = a.trip_id and v.activity_id = a.id), '{}') as vehicles \
         from app.activities a where a.trip_id = $1",
        activity_row,
    )
    .await?;
    state.meals = rows(
        tx,
        trip,
        "select id, day, slot, meal_time, title, cook_id, servings, ingredients, notes, dish_kind, ordinal, version \
         from app.meals where trip_id = $1",
        meal_row,
    )
    .await?;
    state.shopping = rows(
        tx,
        trip,
        "select i.id, i.name, i.quantity, i.category, i.assignee_id, i.purchased, i.source, i.recipe_removed, \
                i.ordinal, i.version, \
                coalesce((select array_agg(m.meal_id) from app.shopping_item_meals m \
                          where m.trip_id = i.trip_id and m.item_id = i.id), '{}') as meal_ids \
         from app.shopping_items i where i.trip_id = $1",
        shopping_row,
    )
    .await?;
    state.gear = rows(
        tx,
        trip,
        "select g.id, g.name, g.quantity, g.scope, g.assignee_id, g.ordinal, g.version, \
                coalesce((select array_agg(p.person_id) from app.gear_packed p \
                          where p.trip_id = g.trip_id and p.gear_id = g.id), '{}') as packed_by \
         from app.gear_items g where g.trip_id = $1",
        gear_row,
    )
    .await?;
    state.departures = rows(
        tx,
        trip,
        "select person_id, version from app.departures where trip_id = $1",
        departure_row,
    )
    .await?;
    state.expenses = rows(
        tx,
        trip,
        "select e.id, e.spent_on, e.title, e.amount_cents, e.payer_id, e.category, e.note, e.shopping_item_id, \
                e.ordinal, e.version, \
                coalesce((select array_agg(p.person_id) from app.expense_participants p \
                          where p.trip_id = e.trip_id and p.expense_id = e.id), '{}') as participants \
         from app.expenses e where e.trip_id = $1",
        expense_row,
    )
    .await?;
    state.settlements = rows(
        tx,
        trip,
        "select id, paid_on, from_id, to_id, amount_cents, note, ordinal, version \
         from app.settlements where trip_id = $1",
        settlement_row,
    )
    .await?;
    Ok(state)
}

/// 執行一個以 `$1` 為旅行 id 的 SELECT，把每一列以 `decode` 轉成 `(鍵, 列)`。
async fn rows<K: Ord, V>(
    tx: &mut PgTx,
    trip: TripId,
    sql: &'static str,
    decode: fn(&PgRow) -> sqlx::Result<(K, V)>,
) -> sqlx::Result<BTreeMap<K, V>> {
    sqlx::query(sql)
        .bind(trip.0)
        .fetch_all(&mut **tx)
        .await?
        .iter()
        .map(decode)
        .collect()
}

// ── 欄位 ──

fn get<'r, T>(row: &'r PgRow, column: &str) -> sqlx::Result<T>
where
    T: Decode<'r, Postgres> + Type<Postgres>,
{
    row.try_get(column)
}

fn bad_value(column: &str, message: String) -> sqlx::Error {
    sqlx::Error::ColumnDecode {
        index: column.to_owned(),
        source: message.into(),
    }
}

/// `bigint` 的 Ordinal 與 Row_Version。
fn unsigned(row: &PgRow, column: &str) -> sqlx::Result<u64> {
    to_u64(get(row, column)?, column)
}

/// `smallint` 的座位數與份數。
fn small(row: &PgRow, column: &str) -> sqlx::Result<u8> {
    let value: i16 = get(row, column)?;
    u8::try_from(value).map_err(|_| bad_value(column, format!("out of range: {value}")))
}

/// 以字串存的列舉。
fn parsed<T>(row: &PgRow, column: &str, parse: fn(&str) -> Option<T>) -> sqlx::Result<T> {
    let text: String = get(row, column)?;
    parse_text(column, &text, parse)
}

fn parse_text<T>(column: &str, text: &str, parse: fn(&str) -> Option<T>) -> sqlx::Result<T> {
    parse(text).ok_or_else(|| bad_value(column, format!("unexpected value: {text:?}")))
}

/// 可以是 NULL 的列舉。
fn parsed_opt<T>(
    row: &PgRow,
    column: &str,
    parse: fn(&str) -> Option<T>,
) -> sqlx::Result<Option<T>> {
    let text: Option<String> = get(row, column)?;
    text.map(|text| parse_text(column, &text, parse))
        .transpose()
}

/// `HH:MM` 的時刻（CHECK 只允許 00:00–23:59）。
fn hm_text(column: &str, text: &str) -> sqlx::Result<Hm> {
    match Hm::parse(text) {
        Ok(Some(hm)) => Ok(hm),
        _ => Err(bad_value(column, format!("not a HH:MM time: {text:?}"))),
    }
}

fn hm(row: &PgRow, column: &str) -> sqlx::Result<Hm> {
    let text: String = get(row, column)?;
    hm_text(column, &text)
}

fn hm_opt(row: &PgRow, column: &str) -> sqlx::Result<Option<Hm>> {
    let text: Option<String> = get(row, column)?;
    text.map(|text| hm_text(column, &text)).transpose()
}

fn id<T: From<Uuid>>(row: &PgRow, column: &str) -> sqlx::Result<T> {
    Ok(T::from(get::<Uuid>(row, column)?))
}

fn id_opt<T: From<Uuid>>(row: &PgRow, column: &str) -> sqlx::Result<Option<T>> {
    Ok(get::<Option<Uuid>>(row, column)?.map(T::from))
}

/// `array_agg` 併入的 id 集合。
fn id_set<T: From<Uuid> + Ord>(row: &PgRow, column: &str) -> sqlx::Result<BTreeSet<T>> {
    Ok(get::<Vec<Uuid>>(row, column)?
        .into_iter()
        .map(T::from)
        .collect())
}

/// 路線端點與停靠點：NULL 是旅行目的地。
fn place_ref(id: Option<Uuid>) -> PlaceRef {
    id.map_or(PlaceRef::Destination, |id| PlaceRef::Place(PlaceId(id)))
}

// ── 每一種列 ──

fn card_row(row: &PgRow) -> sqlx::Result<TripCard> {
    Ok(TripCard {
        id: id(row, "id")?,
        title: get(row, "title")?,
        destination: get(row, "destination")?,
        start: get(row, "start_date")?,
        end: get(row, "end_date")?,
        description: get(row, "description")?,
        note: get(row, "note")?,
        headline: get(row, "headline")?,
        caption: get(row, "caption")?,
        cover: parsed(row, "cover_kind", CoverKind::parse)?,
        status: parsed(row, "status", TripStatus::parse)?,
        version: unsigned(row, "version")?,
    })
}

fn person_row(row: &PgRow) -> sqlx::Result<(PersonId, Person)> {
    let person = Person {
        id: id(row, "id")?,
        name: get(row, "name")?,
        role: get(row, "role")?,
        color: parsed(row, "color", Color::parse)?,
        bound: get(row, "bound")?,
        ordinal: unsigned(row, "ordinal")?,
        version: unsigned(row, "version")?,
    };
    Ok((person.id, person))
}

fn vehicle_row(row: &PgRow) -> sqlx::Result<(VehicleId, Vehicle)> {
    let vehicle = Vehicle {
        id: id(row, "id")?,
        name: get(row, "name")?,
        driver: id_opt(row, "driver_id")?,
        seats: small(row, "seats")?,
        color: get(row, "color")?,
        passengers: id_set(row, "passengers")?,
        ordinal: unsigned(row, "ordinal")?,
        version: unsigned(row, "version")?,
    };
    Ok((vehicle.id, vehicle))
}

fn place_row(row: &PgRow) -> sqlx::Result<(PlaceId, Place)> {
    let place = Place {
        id: id(row, "id")?,
        name: get(row, "name")?,
        template: parsed_opt(row, "template", PlaceTemplate::parse)?,
        ordinal: unsigned(row, "ordinal")?,
        version: unsigned(row, "version")?,
    };
    Ok((place.id, place))
}

fn route_row(row: &PgRow) -> sqlx::Result<(RouteId, Route)> {
    let ids: Vec<Uuid> = get(row, "stop_ids")?;
    let places: Vec<Option<Uuid>> = get(row, "stop_places")?;
    let kinds: Vec<String> = get(row, "stop_kinds")?;
    let tasks: Vec<Option<String>> = get(row, "stop_tasks")?;
    let notes: Vec<String> = get(row, "stop_notes")?;
    let times: Vec<Option<String>> = get(row, "stop_times")?;
    // 每個停靠點的清單長度不同，`array_agg` 不能併成多維陣列，所以以 jsonb 的陣列的陣列讀出
    let Json(items): Json<Vec<Vec<String>>> = get(row, "stop_items")?;
    let count = ids.len();
    if [
        places.len(),
        kinds.len(),
        tasks.len(),
        notes.len(),
        times.len(),
        items.len(),
    ]
    .iter()
    .any(|&len| len != count)
    {
        return Err(bad_value(
            "stop_ids",
            "stop columns differ in length".to_owned(),
        ));
    }
    let stops = ids
        .into_iter()
        .zip(places)
        .zip(kinds)
        .zip(tasks)
        .zip(notes)
        .zip(times)
        .zip(items)
        .map(|((((((id, place), kind), task), note), time), items)| {
            Ok(Stop {
                id: StopId(id),
                place: place_ref(place),
                kind: parse_text("stop_kinds", &kind, StopKind::parse)?,
                task: task
                    .map(|task| parse_text("stop_tasks", &task, StopTask::parse))
                    .transpose()?,
                note,
                time: time.map(|time| hm_text("stop_times", &time)).transpose()?,
                items,
            })
        })
        .collect::<sqlx::Result<Vec<Stop>>>()?;
    let route = Route {
        id: id(row, "id")?,
        day: get(row, "day")?,
        vehicle: id(row, "vehicle_id")?,
        from: place_ref(get(row, "from_place_id")?),
        to: place_ref(get(row, "to_place_id")?),
        depart: hm_opt(row, "depart_time")?,
        stops,
        ordinal: unsigned(row, "ordinal")?,
        version: unsigned(row, "version")?,
    };
    Ok((route.id, route))
}

fn day_setting_row(row: &PgRow) -> sqlx::Result<(Date, DaySetting)> {
    let setting = DaySetting {
        day: get(row, "day")?,
        title: get(row, "title")?,
        place: id_opt(row, "place_id")?,
        arrival: hm_opt(row, "arrival")?,
        arrival_label: get(row, "arrival_label")?,
        route_position: parsed(row, "route_position", RoutePosition::parse)?,
        version: unsigned(row, "version")?,
    };
    Ok((setting.day, setting))
}

fn activity_row(row: &PgRow) -> sqlx::Result<(ActivityId, Activity)> {
    let people: BTreeSet<PersonId> = id_set(row, "people")?;
    let vehicles: BTreeSet<VehicleId> = id_set(row, "vehicles")?;
    // 兩張子表最多一張有列（需求 8.2、9.12）
    let who = match (people.is_empty(), vehicles.is_empty()) {
        (true, true) => Participation::Everyone,
        (false, true) => Participation::People(people),
        (true, false) => Participation::Vehicles(vehicles),
        (false, false) => {
            return Err(bad_value(
                "people",
                "activity has both people and vehicles".to_owned(),
            ))
        }
    };
    let activity = Activity {
        id: id(row, "id")?,
        day: get(row, "day")?,
        time: hm(row, "start_time")?,
        title: get(row, "title")?,
        kind: parsed(row, "kind", ActivityKind::parse)?,
        location: get(row, "location")?,
        note: get(row, "note")?,
        done: get(row, "done")?,
        who,
        ordinal: unsigned(row, "ordinal")?,
        version: unsigned(row, "version")?,
    };
    Ok((activity.id, activity))
}

fn meal_row(row: &PgRow) -> sqlx::Result<(MealId, Meal)> {
    let meal = Meal {
        id: id(row, "id")?,
        day: get(row, "day")?,
        slot: parsed(row, "slot", MealSlot::parse)?,
        time: hm_opt(row, "meal_time")?,
        title: get(row, "title")?,
        cook: id_opt(row, "cook_id")?,
        servings: small(row, "servings")?,
        ingredients: get(row, "ingredients")?,
        notes: get(row, "notes")?,
        dish: parsed_opt(row, "dish_kind", DishKind::parse)?,
        ordinal: unsigned(row, "ordinal")?,
        version: unsigned(row, "version")?,
    };
    Ok((meal.id, meal))
}

fn shopping_row(row: &PgRow) -> sqlx::Result<(ShoppingId, ShoppingItem)> {
    let item = ShoppingItem {
        id: id(row, "id")?,
        name: get(row, "name")?,
        quantity: get(row, "quantity")?,
        category: parsed(row, "category", Category::parse)?,
        assignee: id_opt(row, "assignee_id")?,
        purchased: get(row, "purchased")?,
        source: parsed(row, "source", ItemSource::parse)?,
        meal_ids: id_set(row, "meal_ids")?,
        recipe_removed: get(row, "recipe_removed")?,
        ordinal: unsigned(row, "ordinal")?,
        version: unsigned(row, "version")?,
    };
    Ok((item.id, item))
}

fn gear_row(row: &PgRow) -> sqlx::Result<(GearId, GearItem)> {
    let gear = GearItem {
        id: id(row, "id")?,
        name: get(row, "name")?,
        quantity: get(row, "quantity")?,
        scope: parsed(row, "scope", GearScope::parse)?,
        assignee: id_opt(row, "assignee_id")?,
        packed_by: id_set(row, "packed_by")?,
        ordinal: unsigned(row, "ordinal")?,
        version: unsigned(row, "version")?,
    };
    Ok((gear.id, gear))
}

fn departure_row(row: &PgRow) -> sqlx::Result<(PersonId, Departure)> {
    let departure = Departure {
        person: id(row, "person_id")?,
        version: unsigned(row, "version")?,
    };
    Ok((departure.person, departure))
}

fn expense_row(row: &PgRow) -> sqlx::Result<(ExpenseId, Expense)> {
    let expense = Expense {
        id: id(row, "id")?,
        day: get(row, "spent_on")?,
        title: get(row, "title")?,
        amount_cents: get(row, "amount_cents")?,
        payer: id(row, "payer_id")?,
        participants: id_set(row, "participants")?,
        category: parsed(row, "category", ExpenseCategory::parse)?,
        note: get(row, "note")?,
        shopping_item: id_opt(row, "shopping_item_id")?,
        ordinal: unsigned(row, "ordinal")?,
        version: unsigned(row, "version")?,
    };
    Ok((expense.id, expense))
}

fn settlement_row(row: &PgRow) -> sqlx::Result<(SettlementId, Settlement)> {
    let settlement = Settlement {
        id: id(row, "id")?,
        day: get(row, "paid_on")?,
        from: id(row, "from_id")?,
        to: id(row, "to_id")?,
        amount_cents: get(row, "amount_cents")?,
        note: get(row, "note")?,
        ordinal: unsigned(row, "ordinal")?,
        version: unsigned(row, "version")?,
    };
    Ok((settlement.id, settlement))
}
