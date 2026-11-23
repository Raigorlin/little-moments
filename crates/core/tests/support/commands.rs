//! 命令與身分的產生器（design「Correctness Properties」的 `arb_command(state)` 與 `arb_caps(state)`，任務 8.3）。
//!
//! - [`arb_caps()`]：擁有者、管理員、綁定旅伴的受邀成員（Collaborator）、沒有綁定旅伴的管理員（Unbound_Admin）與
//!   非成員，各自依 `capabilities()` 算出 `Capabilities`；綁定的旅伴從狀態中綁定帳號的旅伴任選一位。
//! - [`arb_command()`]：每一種 `Command`。多數引用狀態中既有的列，也產生不存在的 id、已被使用的新 id、超過上限的
//!   文字、只有空白或含有 U+0000 與隱藏控制字元的文字、無法解析的輸入（`Input::Bad`）、範圍外的日期、別人的旅伴與
//!   邊界值，使命令有成功也有各種拒絕。
//!
//! 新列的 id 是 `id(Tag::…, 1000 + k)`；`arb_state()` 的 id 從 1 起、數量遠少於 1000，所以這些 id 不在狀態中。

use std::collections::BTreeSet;
use std::fmt::Debug;

use chrono::Days;
use lm_core::apply::Ctx;
use lm_core::command::{
    ActivityDraft, ActivityPatch, Command, DateSpan, DaySettingPatch, ExpenseDraft, ExpensePatch,
    GearDraft, GearPatch, Input, MealDraft, MealPatch, PersonPatch, RouteDraft, SettlementDraft,
    SettlementPatch, ShoppingDraft, ShoppingPatch, StopDraft, TripPatch, VehicleDraft,
    VehiclePatch,
};
use lm_core::ids::{IdSource, PersonId, ShoppingId, UserId, VehicleId};
use lm_core::ingredients::sync_meal_ingredients;
use lm_core::model::{
    ActivityKind, Category, Color, CoverKind, Date, DishKind, ExpenseCategory, GearScope, MealSlot,
    Participation, PlaceRef, Role, RoutePosition, StopKind, StopTask, TripState, TripStatus,
};
use lm_core::rules::{capabilities, Capabilities};
use lm_core::time::Hm;
use proptest::collection::vec;
use proptest::option;
use proptest::prelude::*;
use proptest::sample::{select, subsequence, Index};
use proptest::strategy::Union;
use serde_json::json;
use uuid::Uuid;

use super::ids::{id, SeqIds, Tag};
use super::state::{arb_amount_cents, arb_hm, arb_state};
use super::vocab::{
    arb_ingredients, arb_item_name, ACTIVITY_LOCATIONS, ACTIVITY_NOTES, ACTIVITY_TITLES,
    DAY_TITLES, DESTINATIONS, EXPENSE_TITLES, GEAR_NAMES, GEAR_QUANTITIES, LEDGER_NOTES,
    MEAL_NOTES, MEAL_TITLES, PERSON_NAMES, PERSON_ROLES, PLACE_NAMES, SHOPPING_QUANTITIES,
    STOP_NOTES, TRIP_DESCRIPTIONS, TRIP_NOTES, TRIP_TITLES, VEHICLE_COLORS, VEHICLE_NAMES,
};

// ── 狀態 ──

/// `state` 套用一次採買同步，使它也滿足 I9；新增的 Meal_Item 依 `SyncPlan::created` 的順序取得 Ordinal，與
/// LM_Server 提交時相同。
pub fn synced(mut state: TripState) -> TripState {
    let plan = sync_meal_ingredients(&state, &mut SeqIds::new())
        .expect("arb_state() 的採買品項遠少於 1000 項");
    let base = state.max_ordinal() + 1;
    plan.apply_to(&mut state);
    for (id, ordinal) in plan.created.iter().zip(base..) {
        if let Some(item) = state.shopping.get_mut(id) {
            item.ordinal = ordinal;
        }
    }
    state
}

/// 滿足 I1–I12 的 Trip_State：`arb_state()` 套用一次採買同步（`synced()`）。屬性 7、9、10 與 12 的輸入。
pub fn arb_valid_state() -> impl Strategy<Value = TripState> {
    arb_state().prop_map(synced)
}

/// `apply(Mode::Commit)` 用的 `IdSource`：第 k 次回傳 `id(Tag::NewShopping, 100_000 + k)`，不與 `synced()` 以
/// `SeqIds` 新增的品項重複。
#[derive(Clone, Debug, Default)]
pub struct CommitIds {
    taken: u64,
}

impl IdSource for CommitIds {
    fn shopping_id(&mut self) -> ShoppingId {
        self.taken += 1;
        id(Tag::NewShopping, 100_000 + self.taken)
    }
}

// ── 身分 ──

/// 一位 Account 與這趟旅行的關係（design：`arb_caps(state)`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Identity {
    /// Trip_Owner，綁定一位旅伴。
    Owner,
    /// 綁定一位旅伴的 Admin。
    Admin,
    /// 綁定一位旅伴、不是 Trip_Manager 的成員。
    Collaborator,
    /// 沒有 Bound_Person 的 Admin。
    UnboundAdmin,
    /// 不是成員也不是 Admin。
    Outsider,
}

/// 這趟旅行的 Trip_Owner。
pub fn owner() -> UserId {
    UserId(Uuid::from_u128(1))
}

/// 送出命令的 Account（擁有者以外的身分）。
pub fn actor() -> UserId {
    UserId(Uuid::from_u128(2))
}

/// `identity` 的 `Capabilities`：綁定的旅伴是狀態中綁定帳號的旅伴之一（依 Ordinal，以 `me` 選）；沒有綁定帳號的旅伴
/// 時沒有 Bound_Person，所以 Collaborator 等於非成員，擁有者與 Admin 等於 Unbound_Admin。
pub fn caps_of(state: &TripState, identity: Identity, me: Index) -> Capabilities {
    let bound: Vec<PersonId> = state
        .people_by_ordinal()
        .filter(|person| person.bound)
        .map(|person| person.id)
        .collect();
    let me = (!bound.is_empty()).then(|| *me.get(&bound));
    match identity {
        Identity::Owner => capabilities(owner(), owner(), Role::Member, me),
        Identity::Admin => capabilities(owner(), actor(), Role::Admin, me),
        Identity::Collaborator => capabilities(owner(), actor(), Role::Member, me),
        Identity::UnboundAdmin => capabilities(owner(), actor(), Role::Admin, None),
        Identity::Outsider => capabilities(owner(), actor(), Role::Member, None),
    }
}

/// 五種身分之一與它的 `Capabilities`。
pub fn arb_caps(state: &TripState) -> BoxedStrategy<(Identity, Capabilities)> {
    let state = state.clone();
    let identity = select(vec![
        Identity::Owner,
        Identity::Admin,
        Identity::Collaborator,
        Identity::UnboundAdmin,
        Identity::Outsider,
    ]);
    (identity, any::<Index>())
        .prop_map(move |(identity, me)| (identity, caps_of(&state, identity, me)))
        .boxed()
}

/// 以 `caps` 執行命令的 `Ctx`。
pub fn ctx_of(caps: Capabilities) -> Ctx {
    Ctx {
        actor: if caps.can_manage && caps.me.is_some() {
            owner()
        } else {
            actor()
        },
        caps,
    }
}

// ── 引用 ──

/// 從既有的值中選（權重 4），或改用 `other`（權重 1）；沒有既有的值時只用 `other`。
fn existing_or<T: Clone + Debug + 'static>(
    existing: Vec<T>,
    other: BoxedStrategy<T>,
) -> BoxedStrategy<T> {
    if existing.is_empty() {
        other
    } else {
        prop_oneof![4 => select(existing), 1 => other].boxed()
    }
}

/// 不在狀態中的 id：`id(tag, 1000..=1002)`。
fn fresh<T: From<Uuid> + Clone + Debug + 'static>(tag: Tag) -> BoxedStrategy<T> {
    (1000_u64..=1002).prop_map(move |n| id(tag, n)).boxed()
}

/// 要修改、勾選或刪除的列：多數是既有的列，也有不存在的 id。
fn target<T: From<Uuid> + Clone + Debug + 'static>(existing: Vec<T>, tag: Tag) -> BoxedStrategy<T> {
    existing_or(existing, fresh(tag))
}

/// 新列的 id：多數是新的 id，也有已被同一種列使用的 id（409 `duplicate_id`）。
fn new_id<T: From<Uuid> + Clone + Debug + 'static>(existing: Vec<T>, tag: Tag) -> BoxedStrategy<T> {
    if existing.is_empty() {
        fresh(tag)
    } else {
        prop_oneof![5 => fresh(tag), 1 => select(existing)].boxed()
    }
}

/// 選填的旅伴：既有的旅伴、沒有選擇或不存在的旅伴。
fn optional_person(people: &[PersonId]) -> BoxedStrategy<Option<PersonId>> {
    let other = prop_oneof![
        2 => Just(None),
        1 => fresh(Tag::Person).prop_map(Some),
    ]
    .boxed();
    existing_or(people.iter().copied().map(Some).collect(), other)
}

/// 一組旅伴：既有旅伴的子集合，偶爾加入一位不存在的旅伴。
fn people_set(people: &[PersonId]) -> BoxedStrategy<BTreeSet<PersonId>> {
    let people = people.to_vec();
    let len = people.len();
    (
        subsequence(people, 0..=len),
        option::weighted(0.1, fresh::<PersonId>(Tag::Person)),
    )
        .prop_map(|(chosen, extra)| chosen.into_iter().chain(extra).collect())
        .boxed()
}

/// 一組車輛：既有車輛的子集合，偶爾加入一台不存在的車。
fn vehicle_set(vehicles: &[VehicleId]) -> BoxedStrategy<BTreeSet<VehicleId>> {
    let vehicles = vehicles.to_vec();
    let len = vehicles.len();
    (
        subsequence(vehicles, 0..=len),
        option::weighted(0.1, fresh::<VehicleId>(Tag::Vehicle)),
    )
        .prop_map(|(chosen, extra)| chosen.into_iter().chain(extra).collect())
        .boxed()
}

/// 每一種列既有的 id。
struct Pools {
    people: Vec<PersonId>,
    vehicles: Vec<VehicleId>,
    places: Vec<lm_core::ids::PlaceId>,
    routes: Vec<lm_core::ids::RouteId>,
    stops: Vec<lm_core::ids::StopId>,
    activities: Vec<lm_core::ids::ActivityId>,
    meals: Vec<lm_core::ids::MealId>,
    shopping: Vec<lm_core::ids::ShoppingId>,
    item_names: Vec<String>,
    person_names: Vec<String>,
    gear: Vec<lm_core::ids::GearId>,
    expenses: Vec<lm_core::ids::ExpenseId>,
    settlements: Vec<lm_core::ids::SettlementId>,
    /// 旅行範圍內的日子。
    days: Vec<Date>,
    /// 旅行範圍外的日子：開始日的前一天與結束日的後一天。
    outside: Vec<Date>,
}

impl Pools {
    fn of(s: &TripState) -> Pools {
        Pools {
            people: s.people.keys().copied().collect(),
            vehicles: s.vehicles.keys().copied().collect(),
            places: s.places.keys().copied().collect(),
            routes: s.routes.keys().copied().collect(),
            stops: s
                .routes
                .values()
                .flat_map(|r| r.stops.iter().map(|stop| stop.id))
                .collect(),
            activities: s.activities.keys().copied().collect(),
            meals: s.meals.keys().copied().collect(),
            shopping: s.shopping.keys().copied().collect(),
            item_names: s.shopping.values().map(|item| item.name.clone()).collect(),
            person_names: s
                .people
                .values()
                .map(|person| person.name.clone())
                .collect(),
            gear: s.gear.keys().copied().collect(),
            expenses: s.expenses.keys().copied().collect(),
            settlements: s.settlements.keys().copied().collect(),
            days: lm_core::time::date_range(s.card.start, s.card.end),
            outside: vec![s.card.start - Days::new(1), s.card.end + Days::new(1)],
        }
    }

    /// 命令指定的日子：多數在旅行範圍內。
    fn day(&self) -> BoxedStrategy<Date> {
        prop_oneof![
            8 => select(self.days.clone()),
            1 => select(self.outside.clone()),
        ]
        .boxed()
    }

    /// 地點清單中的地點、旅行目的地、不存在的地點或沒有選擇。
    fn place_ref(&self) -> BoxedStrategy<Option<PlaceRef>> {
        let other = prop_oneof![
            2 => Just(Some(PlaceRef::Destination)),
            1 => fresh(Tag::Place).prop_map(|id| Some(PlaceRef::Place(id))),
            1 => Just(None),
        ]
        .boxed();
        existing_or(
            self.places
                .iter()
                .map(|&id| Some(PlaceRef::Place(id)))
                .collect(),
            other,
        )
    }
}

// ── 值 ──

/// 文字欄位：多數取自詞彙，也有空字串、只有空白、恰好 `max` 字與 `max + 1` 字、含有 U+0000，以及前後有空白、
/// 中間有 U+200B 的文字。
fn text(words: &'static [&'static str], max: usize) -> BoxedStrategy<String> {
    prop_oneof![
        8 => select(words).prop_map(str::to_owned),
        1 => Just(String::new()),
        1 => Just(" \u{3000} ".to_owned()),
        1 => Just("字".repeat(max)),
        1 => Just("字".repeat(max + 1)),
        1 => select(words).prop_map(|word| format!("{word}\u{0}")),
        1 => select(words).prop_map(|word| format!("  {word}\u{200b}好 ")),
    ]
    .boxed()
}

/// 時刻欄位的輸入：多數是 Time_Value，也有留空與不是 Time_Value 的文字。
fn time_input() -> BoxedStrategy<Option<Input<Hm>>> {
    prop_oneof![
        6 => arb_hm().prop_map(|hm| Some(Input::Ok(hm))),
        1 => Just(None),
        1 => Just(Some(Input::Bad(json!("")))),
        1 => Just(Some(Input::Bad(json!("8:30")))),
        1 => Just(Some(Input::Bad(json!("24:00")))),
    ]
    .boxed()
}

/// 列舉值的輸入：多數是有效的值，也有無法解析的文字。
fn choice<T: Clone + Debug + 'static>(values: &'static [T]) -> BoxedStrategy<Input<T>> {
    prop_oneof![
        8 => select(values).prop_map(Input::Ok),
        1 => Just(Input::Bad(json!("not-a-choice"))),
    ]
    .boxed()
}

/// 數值的輸入：`range` 內的值、範圍外的整數、小數與文字。
fn number(range: std::ops::RangeInclusive<u8>, outside: Vec<u8>) -> BoxedStrategy<Input<u8>> {
    prop_oneof![
        6 => range.prop_map(Input::Ok),
        2 => select(outside).prop_map(Input::Ok),
        1 => Just(Input::Bad(json!(2.5))),
        1 => Just(Input::Bad(json!(300))),
    ]
    .boxed()
}

/// 金額（分）：多數在 1–100,000,000 分之內，也有 0、負數與超過上限的值。
fn amount() -> BoxedStrategy<i64> {
    prop_oneof![
        8 => arb_amount_cents(),
        1 => Just(0_i64),
        1 => Just(-100_i64),
        1 => Just(100_000_001_i64),
    ]
    .boxed()
}

/// 可以清空的欄位：不改、清空或設定為 `value`。
fn patch_of<T: Clone + Debug + 'static>(
    value: BoxedStrategy<T>,
) -> BoxedStrategy<Option<Option<T>>> {
    prop_oneof![
        3 => Just(None),
        1 => Just(Some(None)),
        2 => value.prop_map(|v| Some(Some(v))),
    ]
    .boxed()
}

/// 不能清空的欄位：不改或設定為 `value`。
fn maybe<T: Clone + Debug + 'static>(value: BoxedStrategy<T>) -> BoxedStrategy<Option<T>> {
    prop_oneof![1 => Just(None), 1 => value.prop_map(Some)].boxed()
}

/// 旅伴名字：詞彙、其他旅伴的名字（全形大寫、前後空白，同名）、只有空白、31 字、含有隱藏控制字元或 U+0000。
fn person_name(p: &Pools) -> BoxedStrategy<String> {
    let base = text(PERSON_NAMES, 30);
    if p.person_names.is_empty() {
        return base;
    }
    prop_oneof![
        3 => base,
        1 => select(p.person_names.clone()).prop_map(|name| format!(" {} ", name.to_uppercase())),
        1 => select(p.person_names.clone()),
    ]
    .boxed()
}

/// 參加者：全體、指定旅伴或指定車輛（可能是空集合，或含有不存在的旅伴與車輛）。
fn participation(p: &Pools) -> BoxedStrategy<Participation> {
    prop_oneof![
        2 => Just(Participation::Everyone),
        2 => people_set(&p.people).prop_map(Participation::People),
        1 => vehicle_set(&p.vehicles).prop_map(Participation::Vehicles),
    ]
    .boxed()
}

// ── 命令 ──

/// 每一種 `Command`（design：`arb_command(state)`），引用多數是 `state` 中既有的列。
pub fn arb_command(state: &TripState) -> BoxedStrategy<Command> {
    let p = Pools::of(state);
    let mut arms: Vec<BoxedStrategy<Command>> = Vec::new();
    trip_commands(state, &p, &mut arms);
    people_commands(&p, &mut arms);
    vehicle_and_place_commands(&p, &mut arms);
    schedule_commands(state, &p, &mut arms);
    meal_and_shopping_commands(&p, &mut arms);
    gear_and_ledger_commands(&p, &mut arms);
    Union::new(arms).boxed()
}

fn trip_commands(state: &TripState, p: &Pools, arms: &mut Vec<BoxedStrategy<Command>>) {
    let start = state.card.start;
    let len = p.days.len() as u64;
    // 改日期：平移 -2..=2 天、1–6 天（可能縮短），也有結束日早於開始日與超過 31 天
    let dates = prop_oneof![
        6 => (0_u64..=4, 1_u64..=6, any::<bool>()).prop_map(move |(shift, days, earlier)| {
            let start = if earlier { start - Days::new(shift.min(2)) } else { start + Days::new(shift.min(2)) };
            DateSpan { start, end: start + Days::new(days - 1) }
        }),
        1 => Just(DateSpan { start, end: start - Days::new(1) }),
        1 => Just(DateSpan { start, end: start + Days::new(31) }),
        1 => Just(DateSpan { start, end: start + Days::new(len.saturating_sub(1)) }),
    ]
    .boxed();
    let mut destinations: Vec<String> = DESTINATIONS.iter().map(|d| (*d).to_owned()).collect();
    destinations.extend(state.places.values().map(|place| place.name.clone()));
    let patch = (
        maybe(text(TRIP_TITLES, 100)),
        maybe(prop_oneof![4 => select(destinations), 1 => text(DESTINATIONS, 100)].boxed()),
        maybe(dates),
        maybe(text(TRIP_DESCRIPTIONS, 1000)),
        maybe(text(TRIP_NOTES, 1000)),
        maybe(choice(CoverKind::ALL)),
        maybe(choice(TripStatus::ALL)),
    )
        .prop_map(
            |(title, destination, dates, description, note, cover, status)| TripPatch {
                title,
                destination,
                dates,
                description,
                note,
                cover,
                status,
            },
        );
    arms.push(
        patch
            .prop_map(|patch| Command::UpdateTrip { patch })
            .boxed(),
    );
}

fn people_commands(p: &Pools, arms: &mut Vec<BoxedStrategy<Command>>) {
    let roles = || text(PERSON_ROLES, 60);
    let color = || option::of(select(Color::ALL));
    arms.push(
        (
            new_id(p.people.clone(), Tag::Person),
            person_name(p),
            roles(),
            color(),
        )
            .prop_map(|(id, name, role, color)| Command::AddPerson {
                id,
                name,
                role,
                color,
            })
            .boxed(),
    );
    let patch = (maybe(person_name(p)), maybe(roles()), color())
        .prop_map(|(name, role, color)| PersonPatch { name, role, color });
    arms.push(
        (target(p.people.clone(), Tag::Person), patch)
            .prop_map(|(id, patch)| Command::UpdatePerson { id, patch })
            .boxed(),
    );
    arms.push(
        target(p.people.clone(), Tag::Person)
            .prop_map(|id| Command::RemovePerson { id })
            .boxed(),
    );
}

fn vehicle_and_place_commands(p: &Pools, arms: &mut Vec<BoxedStrategy<Command>>) {
    let seats = || number(1..=9, vec![0, 10]);
    let colors = || {
        prop_oneof![
            4 => select(VEHICLE_COLORS).prop_map(str::to_owned),
            1 => Just("#ABCDEF".to_owned()),
            1 => Just("red".to_owned()),
        ]
        .boxed()
    };
    let draft = (
        text(VEHICLE_NAMES, 50),
        optional_person(&p.people),
        option::weighted(0.9, seats()),
        option::of(colors()),
        people_set(&p.people),
    )
        .prop_map(|(name, driver, seats, color, passengers)| VehicleDraft {
            name,
            driver,
            seats,
            color,
            passengers,
        });
    arms.push(
        (new_id(p.vehicles.clone(), Tag::Vehicle), draft)
            .prop_map(|(id, draft)| Command::AddVehicle { id, draft })
            .boxed(),
    );
    let patch = (
        maybe(text(VEHICLE_NAMES, 50)),
        patch_of(fresh_or_person(&p.people)),
        maybe(seats()),
        patch_of(colors()),
        people_set(&p.people),
        people_set(&p.people),
    )
        .prop_map(
            |(name, driver, seats, color, passengers_add, passengers_remove)| VehiclePatch {
                name,
                driver,
                seats,
                color,
                passengers_add,
                passengers_remove,
            },
        );
    arms.push(
        (target(p.vehicles.clone(), Tag::Vehicle), patch)
            .prop_map(|(id, patch)| Command::UpdateVehicle { id, patch })
            .boxed(),
    );
    arms.push(
        target(p.vehicles.clone(), Tag::Vehicle)
            .prop_map(|id| Command::RemoveVehicle { id })
            .boxed(),
    );
    let place_name = || {
        prop_oneof![4 => text(PLACE_NAMES, 50), 1 => select(DESTINATIONS).prop_map(str::to_owned)]
            .boxed()
    };
    arms.push(
        (new_id(p.places.clone(), Tag::Place), place_name())
            .prop_map(|(id, name)| Command::AddPlace { id, name })
            .boxed(),
    );
    arms.push(
        (target(p.places.clone(), Tag::Place), place_name())
            .prop_map(|(id, name)| Command::RenamePlace { id, name })
            .boxed(),
    );
    arms.push(
        target(p.places.clone(), Tag::Place)
            .prop_map(|id| Command::RemovePlace { id })
            .boxed(),
    );
}

/// 既有的旅伴或不存在的旅伴（可以清空的欄位用 `patch_of()` 另外產生清空）。
fn fresh_or_person(people: &[PersonId]) -> BoxedStrategy<PersonId> {
    existing_or(people.to_vec(), fresh(Tag::Person))
}

fn schedule_commands(state: &TripState, p: &Pools, arms: &mut Vec<BoxedStrategy<Command>>) {
    // 停靠點：既有的停靠點 id 或新的 id；種類與任務多數相符
    let stop_ids = existing_or(p.stops.clone(), fresh(Tag::Stop));
    let stop = (
        stop_ids,
        p.place_ref(),
        choice(StopKind::ALL),
        prop_oneof![
            3 => Just(None),
            2 => select(StopTask::ALL).prop_map(|task| Some(Input::Ok(task))),
            1 => Just(Some(Input::Bad(json!("teleport")))),
        ],
        text(STOP_NOTES, 100),
        time_input(),
    )
        .prop_map(|(id, place, kind, task, note, time)| StopDraft {
            id,
            place,
            kind,
            task,
            note,
            time,
        });
    // 既有的路線多半沿用它的日子與車輛，使整條取代通常成功
    let existing: Vec<(lm_core::ids::RouteId, Date, VehicleId)> = state
        .routes
        .values()
        .map(|route| (route.id, route.day, route.vehicle))
        .collect();
    let fresh_route = (
        fresh(Tag::Route),
        p.day(),
        option::weighted(0.9, existing_or(p.vehicles.clone(), fresh(Tag::Vehicle))),
    )
        .boxed();
    let key = if existing.is_empty() {
        fresh_route
    } else {
        prop_oneof![
            2 => select(existing).prop_map(|(id, day, vehicle)| (id, day, Some(vehicle))),
            1 => fresh_route,
        ]
        .boxed()
    };
    let route = (
        key,
        p.place_ref(),
        p.place_ref(),
        time_input(),
        vec(stop, 0..=7),
    )
        .prop_map(|((id, day, vehicle), from, to, depart, stops)| RouteDraft {
            id,
            day,
            vehicle,
            from,
            to,
            depart,
            stops,
        });
    arms.push(route.prop_map(|route| Command::SaveRoute { route }).boxed());
    arms.push(
        target(p.routes.clone(), Tag::Route)
            .prop_map(|id| Command::RemoveRoute { id })
            .boxed(),
    );
    let place = existing_or(p.places.clone(), fresh(Tag::Place));
    let setting = (
        patch_of(text(DAY_TITLES, 20)),
        patch_of(place),
        patch_of(
            time_input()
                .prop_filter_map("留空以清空表示", |time| time)
                .boxed(),
        ),
        maybe(choice(RoutePosition::ALL)),
    )
        .prop_map(|(title, place, arrival, route_position)| DaySettingPatch {
            title,
            place,
            arrival,
            route_position,
        });
    arms.push(
        (p.day(), setting)
            .prop_map(|(day, patch)| Command::SaveDaySetting { day, patch })
            .boxed(),
    );
    // 一次加入 1–3 筆活動，id 偶爾重複（與既有的活動或同一個命令中的另一筆）
    let item = (
        time_input(),
        text(ACTIVITY_TITLES, 100),
        choice(ActivityKind::ALL),
        text(ACTIVITY_LOCATIONS, 150),
        text(ACTIVITY_NOTES, 1000),
        participation(p),
    );
    let existing_activities = p.activities.clone();
    let items = (vec(item, 1..=3), option::weighted(0.15, any::<Index>())).prop_map(
        move |(items, duplicate)| {
            items
                .into_iter()
                .enumerate()
                .map(|(k, (time, title, kind, location, note, who))| {
                    let id = match duplicate {
                        Some(index) if k == 0 && !existing_activities.is_empty() => {
                            *index.get(&existing_activities)
                        }
                        Some(_) if k == 1 => id(Tag::Activity, 1000),
                        _ => id(Tag::Activity, 1000 + k as u64),
                    };
                    ActivityDraft {
                        id,
                        time,
                        title,
                        kind,
                        location,
                        note,
                        who,
                    }
                })
                .collect::<Vec<_>>()
        },
    );
    arms.push(
        (p.day(), items)
            .prop_map(|(day, items)| Command::AddActivities { day, items })
            .boxed(),
    );
    let patch = (
        (
            maybe(text(ACTIVITY_TITLES, 100)),
            maybe(p.day()),
            maybe(time_input()),
            maybe(choice(ActivityKind::ALL)),
            maybe(text(ACTIVITY_LOCATIONS, 150)),
            maybe(text(ACTIVITY_NOTES, 1000)),
        ),
        (
            people_set(&p.people),
            people_set(&p.people),
            vehicle_set(&p.vehicles),
            vehicle_set(&p.vehicles),
        ),
    )
        .prop_map(
            |(
                (title, day, time, kind, location, note),
                (people_add, people_remove, vehicles_add, vehicles_remove),
            )| {
                ActivityPatch {
                    title,
                    day,
                    time,
                    kind,
                    location,
                    note,
                    people_add,
                    people_remove,
                    vehicles_add,
                    vehicles_remove,
                }
            },
        );
    arms.push(
        (target(p.activities.clone(), Tag::Activity), patch)
            .prop_map(|(id, patch)| Command::UpdateActivity { id, patch })
            .boxed(),
    );
    arms.push(
        target(p.activities.clone(), Tag::Activity)
            .prop_map(|id| Command::RemoveActivity { id })
            .boxed(),
    );
    arms.push(
        (target(p.activities.clone(), Tag::Activity), any::<bool>())
            .prop_map(|(id, done)| Command::SetActivityDone { id, done })
            .boxed(),
    );
}

fn meal_and_shopping_commands(p: &Pools, arms: &mut Vec<BoxedStrategy<Command>>) {
    let servings = || number(1..=12, vec![0, 101]);
    let ingredients = || {
        prop_oneof![
            8 => arb_ingredients(),
            1 => Just("鹽".repeat(2001)),
            1 => Just("鹽".repeat(101)),
        ]
        .boxed()
    };
    let dish = || option::weighted(0.4, choice(DishKind::ALL));
    let draft = (
        p.day(),
        choice(MealSlot::ALL),
        time_input(),
        text(MEAL_TITLES, 100),
        optional_person(&p.people),
        servings(),
        ingredients(),
        text(MEAL_NOTES, 1000),
        dish(),
    )
        .prop_map(
            |(day, slot, time, title, cook, servings, ingredients, notes, dish)| MealDraft {
                day,
                slot,
                time,
                title,
                cook,
                servings,
                ingredients,
                notes,
                dish,
            },
        );
    arms.push(
        (new_id(p.meals.clone(), Tag::Meal), draft)
            .prop_map(|(id, draft)| Command::AddMeal { id, draft })
            .boxed(),
    );
    let patch = (
        (
            maybe(p.day()),
            maybe(choice(MealSlot::ALL)),
            patch_of(
                time_input()
                    .prop_filter_map("留空以清空表示", |time| time)
                    .boxed(),
            ),
            maybe(text(MEAL_TITLES, 100)),
            patch_of(fresh_or_person(&p.people)),
        ),
        (
            maybe(servings()),
            maybe(ingredients()),
            maybe(text(MEAL_NOTES, 1000)),
            patch_of(choice(DishKind::ALL)),
        ),
    )
        .prop_map(
            |((day, slot, time, title, cook), (servings, ingredients, notes, dish))| MealPatch {
                day,
                slot,
                time,
                title,
                cook,
                servings,
                ingredients,
                notes,
                dish,
            },
        );
    arms.push(
        (target(p.meals.clone(), Tag::Meal), patch)
            .prop_map(|(id, patch)| Command::UpdateMeal { id, patch })
            .boxed(),
    );
    arms.push(
        target(p.meals.clone(), Tag::Meal)
            .prop_map(|id| Command::RemoveMeal { id })
            .boxed(),
    );
    let meals = {
        let meals = p.meals.clone();
        let len = meals.len();
        (
            subsequence(meals, 0..=len),
            option::weighted(0.1, fresh::<lm_core::ids::MealId>(Tag::Meal)),
        )
            .prop_map(|(chosen, extra)| chosen.into_iter().chain(extra).collect::<BTreeSet<_>>())
    };
    arms.push(
        (target(p.shopping.clone(), Tag::Shopping), meals)
            .prop_map(|(item, meals)| Command::RemoveIngredientFromMeals { item, meals })
            .boxed(),
    );
    // 品項名稱：新的名稱、既有品項的名稱（同名）、只有空白或過長
    let item_name = || {
        let names = p.item_names.clone();
        let base = prop_oneof![
            6 => arb_item_name(),
            1 => Just(String::new()),
            1 => Just("品".repeat(101)),
            1 => Just("冰塊\u{0}".to_owned()),
        ]
        .boxed();
        existing_or(names, base)
    };
    let quantity = || text(SHOPPING_QUANTITIES, 40);
    let draft = (
        item_name(),
        quantity(),
        select(Category::ALL),
        optional_person(&p.people),
    )
        .prop_map(|(name, quantity, category, assignee)| ShoppingDraft {
            name,
            quantity,
            category,
            assignee,
        });
    arms.push(
        (new_id(p.shopping.clone(), Tag::Shopping), draft)
            .prop_map(|(id, draft)| Command::AddShoppingItem { id, draft })
            .boxed(),
    );
    let patch = (
        maybe(item_name()),
        maybe(quantity()),
        option::of(select(Category::ALL)),
        patch_of(fresh_or_person(&p.people)),
    )
        .prop_map(|(name, quantity, category, assignee)| ShoppingPatch {
            name,
            quantity,
            category,
            assignee,
        });
    arms.push(
        (target(p.shopping.clone(), Tag::Shopping), patch)
            .prop_map(|(id, patch)| Command::UpdateShoppingItem { id, patch })
            .boxed(),
    );
    arms.push(
        target(p.shopping.clone(), Tag::Shopping)
            .prop_map(|id| Command::RemoveShoppingItem { id })
            .boxed(),
    );
    arms.push(
        (target(p.shopping.clone(), Tag::Shopping), any::<bool>())
            .prop_map(|(id, purchased)| Command::SetShoppingPurchased { id, purchased })
            .boxed(),
    );
}

fn gear_and_ledger_commands(p: &Pools, arms: &mut Vec<BoxedStrategy<Command>>) {
    let scope = || select(GearScope::ALL);
    let draft = (
        text(GEAR_NAMES, 100),
        text(GEAR_QUANTITIES, 40),
        scope(),
        optional_person(&p.people),
    )
        .prop_map(|(name, quantity, scope, assignee)| GearDraft {
            name,
            quantity,
            scope,
            assignee,
        });
    arms.push(
        (new_id(p.gear.clone(), Tag::Gear), draft)
            .prop_map(|(id, draft)| Command::AddGear { id, draft })
            .boxed(),
    );
    let patch = (
        maybe(text(GEAR_NAMES, 100)),
        maybe(text(GEAR_QUANTITIES, 40)),
        option::of(scope()),
        patch_of(fresh_or_person(&p.people)),
    )
        .prop_map(|(name, quantity, scope, assignee)| GearPatch {
            name,
            quantity,
            scope,
            assignee,
        });
    arms.push(
        (target(p.gear.clone(), Tag::Gear), patch)
            .prop_map(|(id, patch)| Command::UpdateGear { id, patch })
            .boxed(),
    );
    arms.push(
        target(p.gear.clone(), Tag::Gear)
            .prop_map(|id| Command::RemoveGear { id })
            .boxed(),
    );
    arms.push(
        (
            target(p.gear.clone(), Tag::Gear),
            fresh_or_person(&p.people),
            any::<bool>(),
        )
            .prop_map(|(id, person, packed)| Command::SetGearPacked { id, person, packed })
            .boxed(),
    );
    arms.push(
        (fresh_or_person(&p.people), any::<bool>())
            .prop_map(|(person, departed)| Command::SetDeparted { person, departed })
            .boxed(),
    );
    // 帳目的日期不限於旅行的日期範圍
    let ledger_day = || {
        prop_oneof![
            4 => p.day(),
            1 => Just(Date::from_ymd_opt(2024, 2, 29).expect("有效的日期")),
        ]
        .boxed()
    };
    let link = || {
        prop_oneof![
            3 => Just(None),
            2 => existing_or(p.shopping.clone(), fresh(Tag::Shopping)).prop_map(Some),
        ]
        .boxed()
    };
    let draft = (
        ledger_day(),
        text(EXPENSE_TITLES, 100),
        amount(),
        optional_person(&p.people),
        people_set(&p.people),
        choice(ExpenseCategory::ALL),
        text(LEDGER_NOTES, 500),
        link(),
    )
        .prop_map(
            |(day, title, amount_cents, payer, participants, category, note, shopping_item)| {
                ExpenseDraft {
                    day,
                    title,
                    amount_cents,
                    payer,
                    participants,
                    category,
                    note,
                    shopping_item,
                }
            },
        );
    arms.push(
        (new_id(p.expenses.clone(), Tag::Expense), draft)
            .prop_map(|(id, draft)| Command::AddExpense { id, draft })
            .boxed(),
    );
    let patch = (
        (
            maybe(ledger_day()),
            maybe(text(EXPENSE_TITLES, 100)),
            maybe(amount()),
            maybe(fresh_or_person(&p.people)),
            people_set(&p.people),
            people_set(&p.people),
        ),
        (
            maybe(choice(ExpenseCategory::ALL)),
            maybe(text(LEDGER_NOTES, 500)),
            patch_of(existing_or(p.shopping.clone(), fresh(Tag::Shopping))),
        ),
    )
        .prop_map(
            |(
                (day, title, amount_cents, payer, participants_add, participants_remove),
                (category, note, shopping_item),
            )| {
                ExpensePatch {
                    day,
                    title,
                    amount_cents,
                    payer,
                    participants_add,
                    participants_remove,
                    category,
                    note,
                    shopping_item,
                }
            },
        );
    arms.push(
        (target(p.expenses.clone(), Tag::Expense), patch)
            .prop_map(|(id, patch)| Command::UpdateExpense { id, patch })
            .boxed(),
    );
    arms.push(
        target(p.expenses.clone(), Tag::Expense)
            .prop_map(|id| Command::RemoveExpense { id })
            .boxed(),
    );
    let draft = (
        ledger_day(),
        optional_person(&p.people),
        optional_person(&p.people),
        amount(),
        text(LEDGER_NOTES, 500),
    )
        .prop_map(|(day, from, to, amount_cents, note)| SettlementDraft {
            day,
            from,
            to,
            amount_cents,
            note,
        });
    arms.push(
        (new_id(p.settlements.clone(), Tag::Settlement), draft)
            .prop_map(|(id, draft)| Command::AddSettlement { id, draft })
            .boxed(),
    );
    let patch = (
        maybe(ledger_day()),
        maybe(fresh_or_person(&p.people)),
        maybe(fresh_or_person(&p.people)),
        maybe(amount()),
        maybe(text(LEDGER_NOTES, 500)),
    )
        .prop_map(|(day, from, to, amount_cents, note)| SettlementPatch {
            day,
            from,
            to,
            amount_cents,
            note,
        });
    arms.push(
        (target(p.settlements.clone(), Tag::Settlement), patch)
            .prop_map(|(id, patch)| Command::UpdateSettlement { id, patch })
            .boxed(),
    );
    arms.push(
        target(p.settlements.clone(), Tag::Settlement)
            .prop_map(|id| Command::RemoveSettlement { id })
            .boxed(),
    );
}
