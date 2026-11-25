//! `arb_state()`：滿足不變式 I1–I8、I10–I12 的 Trip_State（design「Correctness Properties」的共用產生器）。
//!
//! 先產生一份只含隨機選擇的種子（數量、詞彙、以 [`Index`] 或位元遮罩表示的引用），再由 `StateSeed::build()` 依序
//! 建立每一種列：引用只從已經建立的列中選，名字與地點只從鍵兩兩不同的詞彙中取，所以不變式由建構方式保證，不需要
//! 事後過濾。proptest 縮小失敗案例時，數量、引用與遮罩都往「更少、更前面」縮。

use std::collections::BTreeSet;

use lm_core::ids::{PersonId, ShoppingId, VehicleId};
use lm_core::limits::{ROUTE_STOPS, VEHICLE_SEATS};
use lm_core::model::{
    Activity, ActivityKind, Category, Color, CoverKind, Date, DaySetting, Departure, DishKind,
    Expense, ExpenseCategory, GearItem, GearScope, ItemSource, Meal, MealSlot, Participation,
    Person, Place, PlaceRef, PlaceTemplate, Route, RoutePosition, Row, Settlement, ShoppingItem,
    Stop, StopKind, StopTask, TripCard, TripState, TripStatus, Vehicle,
};
use lm_core::text::{place_key, trim_white};
use lm_core::time::{date_range, Hm};
use proptest::collection::vec;
use proptest::option;
use proptest::prelude::*;
use proptest::sample::{select, subsequence, Index};
use time::Duration;

use super::ids::{id, Tag};
use super::vocab::{
    arb_ingredients, arb_item_name, ACTIVITY_LOCATIONS, ACTIVITY_NOTES, ACTIVITY_TITLES,
    ARRIVAL_LABELS, CLOCK_MINUTES, DAY_TITLES, DESTINATIONS, EXPENSE_TITLES, GEAR_NAMES,
    GEAR_QUANTITIES, LEDGER_NOTES, MEAL_NOTES, MEAL_TITLES, PERSON_NAMES, PERSON_ROLES,
    PLACE_NAMES, SHOPPING_QUANTITIES, STOP_ITEMS, STOP_NOTES, STORYBOOK_CAPTIONS,
    STORYBOOK_HEADLINES, TRIP_DESCRIPTIONS, TRIP_NOTES, TRIP_TITLES, VEHICLE_COLORS, VEHICLE_NAMES,
};

/// 旅行最多 5 天（每一趟 1–5 天）。
pub const MAX_DAYS: usize = 5;
/// 最多 6 位旅伴。
pub const MAX_PEOPLE: usize = 6;
/// 最多 3 台車。
pub const MAX_VEHICLES: usize = 3;
/// 地點清單最多 6 個地點。
pub const MAX_PLACES: usize = 6;
/// 最多 10 筆活動。
pub const MAX_ACTIVITIES: usize = 10;
/// 最多 8 道料理。
pub const MAX_MEALS: usize = 8;
/// 最多 15 個採買品項（遠低於 1000 項的上限，所以採買同步不會超過上限）。
pub const MAX_SHOPPING: usize = 15;
/// 最多 10 個裝備。
pub const MAX_GEAR: usize = 10;
/// 最多 5 筆支出。
pub const MAX_EXPENSES: usize = 5;
/// 最多 5 筆還款。
pub const MAX_SETTLEMENTS: usize = 5;

// 旅伴、車輛與料理以 u8 的位元遮罩選取，所以各最多 8 個
const _: () = assert!(MAX_PEOPLE <= 8 && MAX_VEHICLES <= 8 && MAX_MEALS <= 8);

/// 一份 Trip_State，範圍依 design「Correctness Properties」的共用產生器：1–5 天、0–6 位旅伴（隨機綁定帳號）、
/// 0–3 台車、0–6 個地點、每台車每天 0–1 條路線（0–6 個停靠點）、0–5 個每日設定、0–10 筆活動、0–8 道料理、
/// 0–15 個採買品項（料理與手動、已買與未買混合）、0–10 個裝備與出發確認、0–5 筆支出（部分連結採買品項，包括未買的
/// Meal_Item）與 0–5 筆還款。料理的食材文字由 [`arb_ingredients()`] 產生。
///
/// 保證（由建構方式保證，`support_smoke.rs` 另外檢查）：
///
/// - 不變式 I1–I8、I10–I12：每個引用都指向存在的列；旅伴的 Participant_Key 與地點的 Place_Key 兩兩不同，地點也不與
///   非空白的旅行目的地同名；每台車每天最多一條路線、每條最多 6 個停靠點、停靠點 id 不重複；只在目的地不是空白時
///   使用 Destination_Place；活動、料理、路線與每日設定的日期都在旅行範圍內（支出與還款的日期可能在範圍外）；駕駛不在
///   乘客中、乘客加 1 不超過座位數；個人裝備沒有負責人、共用裝備只有負責人能打包；有出發確認的旅伴都滿足 Can_Depart；
///   支出的分攤旅伴有 1 位以上、還款的付款人與收款人不同；指定旅伴與指定車輛的活動不是空集合；數量都遠低於上限。
/// - 每個欄位都是命令處理函式會儲存的值（見 `vocab`）；每日設定至少設定了標題、地點、預計抵達時間與抵達說明其中一項
///   （需求 22.11）。
/// - 每一列的 id 是 `support::ids` 的 `id(Tag::…, k)`，k 依建立的順序從 1 起；旅行 id 一律是 `id(Tag::Trip, 1)`。
///   不使用 `Tag::NewShopping`，所以 `SeqIds` 回傳的 id 都是新的。
/// - 有 Ordinal 的列的 Ordinal 是 1..=N 的一種隨機排列（N 是這些列的總數），所以依 Ordinal 的順序通常與依 id 的順序
///   不同；Row_Version 等於 Ordinal。Trip_Card 的 Row_Version 是 0，每日設定與出發確認依序是 N + 1 起的值。
///
/// 不保證 I9：採買品項是隨機產生的，料理需要的食材不一定被涵蓋，未買的 Meal_Item 可能沒有連動料理，連動的料理也
/// 不一定需要它；這正是採買同步要整理的情況。需要滿足 I9 的屬性先以 `sync_meal_ingredients()` 套用一次。品項的來源與
/// 分類、負責人也各自隨機（例如有負責人的 Meal_Item），使採買同步「不改使用者管理的欄位」的檢查涵蓋每一種品項。
pub fn arb_state() -> impl Strategy<Value = TripState> {
    let plan = (
        arb_card_seed(),
        subsequence(PERSON_NAMES, 0..=MAX_PEOPLE),
        vec(arb_person_seed(), MAX_PEOPLE),
        vec(arb_vehicle_seed(), 0..=MAX_VEHICLES),
        subsequence(PLACE_NAMES, 0..=MAX_PLACES),
        vec(option::of(select(PlaceTemplate::ALL)), MAX_PLACES),
        vec(
            option::weighted(0.35, arb_route_seed()),
            MAX_VEHICLES * MAX_DAYS,
        ),
        vec(option::weighted(0.4, arb_day_setting_seed()), MAX_DAYS),
    );
    let contents = (
        vec(arb_activity_seed(), 0..=MAX_ACTIVITIES),
        vec(arb_meal_seed(), 0..=MAX_MEALS),
        vec(arb_item_seed(), 0..=MAX_SHOPPING),
        vec(arb_gear_seed(), 0..=MAX_GEAR),
        vec(arb_expense_seed(), 0..=MAX_EXPENSES),
        vec(arb_settlement_seed(), 0..=MAX_SETTLEMENTS),
        any::<u64>(),
    );
    (plan, contents).prop_map(
        |(
            (card, names, people, vehicles, places, place_templates, routes, day_settings),
            (activities, meals, shopping, gear, expenses, settlements, shuffle),
        )| {
            StateSeed {
                card,
                names,
                people,
                vehicles,
                places,
                place_templates,
                routes,
                day_settings,
                activities,
                meals,
                shopping,
                gear,
                expenses,
                settlements,
                shuffle,
            }
            .build()
        },
    )
}

// ── 種子 ──

/// 一份 Trip_State 的所有隨機選擇；`build()` 依序建立每一種列。
#[derive(Clone, Debug)]
struct StateSeed {
    card: CardSeed,
    /// 旅伴的名字，決定旅伴人數。
    names: Vec<&'static str>,
    /// 固定 `MAX_PEOPLE` 份，第 k 位旅伴用第 k 份。
    people: Vec<PersonSeed>,
    vehicles: Vec<VehicleSeed>,
    /// 地點的名稱；與非空白旅行目的地同名的不放進地點清單。
    places: Vec<&'static str>,
    /// 固定 `MAX_PLACES` 份：第 k 個地點的繪本插圖。
    place_templates: Vec<Option<PlaceTemplate>>,
    /// 固定 `MAX_VEHICLES * MAX_DAYS` 份：第 v 台車在第 d 天（從 0 起）的路線是 `routes[v * MAX_DAYS + d]`。
    routes: Vec<Option<RouteSeed>>,
    /// 固定 `MAX_DAYS` 份：第 d 天的每日設定。
    day_settings: Vec<Option<DaySettingSeed>>,
    activities: Vec<ActivitySeed>,
    meals: Vec<MealSeed>,
    shopping: Vec<ItemSeed>,
    gear: Vec<GearSeed>,
    expenses: Vec<ExpenseSeed>,
    settlements: Vec<SettlementSeed>,
    /// 打散 Ordinal 的種子；0 時 Ordinal 依建立的順序。
    shuffle: u64,
}

#[derive(Clone, Debug)]
struct CardSeed {
    title: &'static str,
    destination: &'static str,
    /// 開始日是 2026-01-01 之後的第幾天（涵蓋跨年與 2028-02-29）。
    start_offset: u64,
    days: usize,
    description: &'static str,
    note: &'static str,
    headline: &'static str,
    caption: &'static str,
    cover: CoverKind,
    status: TripStatus,
}

#[derive(Clone, Debug)]
struct PersonSeed {
    role: &'static str,
    color: Color,
    bound: bool,
    /// 已打包自己 My_Gear 中的每一項，所以通常滿足 Can_Depart。
    ready: bool,
    /// 滿足 Can_Depart 時有出發確認。
    depart: bool,
}

#[derive(Clone, Debug)]
struct VehicleSeed {
    name: &'static str,
    seats: u8,
    driver: Option<Index>,
    /// 第 k 個位元為 1 時，第 k 位旅伴想當乘客（不是駕駛，而且還有座位時）。
    passengers: u8,
    color: Option<&'static str>,
}

#[derive(Clone, Debug)]
struct RouteSeed {
    from: Index,
    to: Index,
    depart: Option<Hm>,
    stops: Vec<StopSeed>,
}

#[derive(Clone, Debug)]
struct StopSeed {
    place: Index,
    kind: StopKind,
    /// 這個種類的任務之一；`None` 時使用種類的預設任務。
    task: Option<Index>,
    note: &'static str,
    time: Option<Hm>,
    /// 待辦清單；採買的停靠點不使用。
    items: Vec<&'static str>,
}

#[derive(Clone, Debug)]
struct DaySettingSeed {
    title: Option<&'static str>,
    place: Option<Index>,
    arrival: Option<Hm>,
    arrival_label: Option<&'static str>,
    route_position: RoutePosition,
}

/// 活動的參加者：指定旅伴與指定車輛都是「一個一定選到的成員，加上遮罩選到的其他成員」，所以不是空集合（I11）；
/// 沒有旅伴或沒有車時改為全體。
#[derive(Clone, Debug)]
enum WhoSeed {
    Everyone,
    People(Index, u8),
    Vehicles(Index, u8),
}

#[derive(Clone, Debug)]
struct ActivitySeed {
    day: Index,
    time: Hm,
    title: &'static str,
    kind: ActivityKind,
    location: &'static str,
    note: &'static str,
    done: bool,
    who: WhoSeed,
}

#[derive(Clone, Debug)]
struct MealSeed {
    day: Index,
    slot: MealSlot,
    time: Option<Hm>,
    title: &'static str,
    cook: Option<Index>,
    servings: u8,
    ingredients: String,
    notes: &'static str,
    dish: Option<DishKind>,
}

#[derive(Clone, Debug)]
struct ItemSeed {
    name: String,
    quantity: &'static str,
    category: Category,
    assignee: Option<Index>,
    purchased: bool,
    source: ItemSource,
    /// 第 k 個位元為 1 時連動第 k 道料理（不一定需要這個品項）。
    meals: u8,
    recipe_removed: Option<bool>,
}

#[derive(Clone, Debug)]
struct GearSeed {
    name: &'static str,
    quantity: &'static str,
    shared: bool,
    /// 共用裝備的負責人；`None` 是待分配。個人裝備不使用。
    assignee: Option<Index>,
    /// 個人裝備：第 k 個位元為 1 時第 k 位旅伴已打包；共用裝備：第 0 個位元為 1 時負責人已打包。
    packed: u8,
}

/// 支出連結的採買品項。
#[derive(Clone, Debug)]
enum LinkSeed {
    None,
    /// 任一個品項。
    Any(Index),
    /// 未買的 Meal_Item 之一（沒有時任一個品項），採買同步可能刪除它並清除這個連結。
    UnboughtMealItem(Index),
}

#[derive(Clone, Debug)]
struct ExpenseSeed {
    /// 日期是旅行開始日加幾天；不限於旅行範圍。
    day_offset: i64,
    title: &'static str,
    amount_cents: i64,
    payer: Index,
    first_participant: Index,
    participants: u8,
    category: ExpenseCategory,
    note: &'static str,
    link: LinkSeed,
}

#[derive(Clone, Debug)]
struct SettlementSeed {
    day_offset: i64,
    from: Index,
    /// 收款人是付款人之後的第幾位（繞回開頭），所以兩人不同。
    to: Index,
    amount_cents: i64,
    note: &'static str,
}

// ── 種子的產生器 ──

prop_compose! {
    fn arb_card_seed()(
        title in select(TRIP_TITLES),
        destination in select(DESTINATIONS),
        start_offset in 0..=1100_u64,
        days in 1..=MAX_DAYS,
        description in select(TRIP_DESCRIPTIONS),
        note in select(TRIP_NOTES),
        headline in select(STORYBOOK_HEADLINES),
        caption in select(STORYBOOK_CAPTIONS),
        cover in select(CoverKind::ALL),
        status in select(TripStatus::ALL),
    ) -> CardSeed {
        CardSeed {
            title, destination, start_offset, days, description, note, headline, caption, cover,
            status,
        }
    }
}

prop_compose! {
    fn arb_person_seed()(
        role in select(PERSON_ROLES),
        color in select(Color::ALL),
        bound in any::<bool>(),
        ready in any::<bool>(),
        depart in any::<bool>(),
    ) -> PersonSeed {
        PersonSeed { role, color, bound, ready, depart }
    }
}

prop_compose! {
    fn arb_vehicle_seed()(
        name in select(VEHICLE_NAMES),
        seats in VEHICLE_SEATS,
        driver in option::weighted(0.75, any::<Index>()),
        passengers in any::<u8>(),
        color in option::of(select(VEHICLE_COLORS)),
    ) -> VehicleSeed {
        VehicleSeed { name, seats, driver, passengers, color }
    }
}

prop_compose! {
    fn arb_route_seed()(
        from in any::<Index>(),
        to in any::<Index>(),
        depart in option::of(arb_hm()),
        stops in vec(arb_stop_seed(), ROUTE_STOPS),
    ) -> RouteSeed {
        RouteSeed { from, to, depart, stops }
    }
}

prop_compose! {
    fn arb_stop_seed()(
        place in any::<Index>(),
        kind in select(StopKind::ALL),
        task in option::of(any::<Index>()),
        note in select(STOP_NOTES),
        time in option::of(arb_hm()),
        items in vec(select(STOP_ITEMS), 0..=3),
    ) -> StopSeed {
        StopSeed { place, kind, task, note, time, items }
    }
}

prop_compose! {
    fn arb_day_setting_seed()(
        title in option::of(select(DAY_TITLES)),
        place in option::of(any::<Index>()),
        arrival in option::of(arb_hm()),
        arrival_label in option::weighted(0.3, select(ARRIVAL_LABELS)),
        route_position in select(RoutePosition::ALL),
    ) -> DaySettingSeed {
        DaySettingSeed { title, place, arrival, arrival_label, route_position }
    }
}

fn arb_who_seed() -> impl Strategy<Value = WhoSeed> {
    prop_oneof![
        2 => Just(WhoSeed::Everyone),
        1 => (any::<Index>(), any::<u8>()).prop_map(|(first, more)| WhoSeed::People(first, more)),
        1 => (any::<Index>(), any::<u8>()).prop_map(|(first, more)| WhoSeed::Vehicles(first, more)),
    ]
}

prop_compose! {
    fn arb_activity_seed()(
        day in any::<Index>(),
        time in arb_hm(),
        title in select(ACTIVITY_TITLES),
        kind in select(ActivityKind::ALL),
        location in select(ACTIVITY_LOCATIONS),
        note in select(ACTIVITY_NOTES),
        done in any::<bool>(),
        who in arb_who_seed(),
    ) -> ActivitySeed {
        ActivitySeed { day, time, title, kind, location, note, done, who }
    }
}

prop_compose! {
    fn arb_meal_seed()(
        day in any::<Index>(),
        slot in select(MealSlot::ALL),
        time in option::weighted(0.3, arb_hm()),
        title in select(MEAL_TITLES),
        cook in option::of(any::<Index>()),
        servings in prop_oneof![Just(1_u8), Just(100_u8), 2..=8_u8],
        ingredients in arb_ingredients(),
        notes in select(MEAL_NOTES),
        dish in option::weighted(0.3, select(DishKind::ALL)),
    ) -> MealSeed {
        MealSeed { day, slot, time, title, cook, servings, ingredients, notes, dish }
    }
}

prop_compose! {
    fn arb_item_seed()(
        name in arb_item_name(),
        quantity in select(SHOPPING_QUANTITIES),
        category in select(Category::ALL),
        assignee in option::of(any::<Index>()),
        purchased in any::<bool>(),
        source in select(ItemSource::ALL),
        meals in any::<u8>(),
        recipe_removed in option::of(any::<bool>()),
    ) -> ItemSeed {
        ItemSeed { name, quantity, category, assignee, purchased, source, meals, recipe_removed }
    }
}

prop_compose! {
    fn arb_gear_seed()(
        name in select(GEAR_NAMES),
        quantity in select(GEAR_QUANTITIES),
        shared in any::<bool>(),
        assignee in option::weighted(0.75, any::<Index>()),
        packed in any::<u8>(),
    ) -> GearSeed {
        GearSeed { name, quantity, shared, assignee, packed }
    }
}

fn arb_link_seed() -> impl Strategy<Value = LinkSeed> {
    prop_oneof![
        2 => Just(LinkSeed::None),
        1 => any::<Index>().prop_map(LinkSeed::Any),
        2 => any::<Index>().prop_map(LinkSeed::UnboughtMealItem),
    ]
}

prop_compose! {
    fn arb_expense_seed()(
        day_offset in -3..=8_i64,
        title in select(EXPENSE_TITLES),
        amount_cents in arb_amount_cents(),
        payer in any::<Index>(),
        first_participant in any::<Index>(),
        participants in any::<u8>(),
        category in select(ExpenseCategory::ALL),
        note in select(LEDGER_NOTES),
        link in arb_link_seed(),
    ) -> ExpenseSeed {
        ExpenseSeed {
            day_offset, title, amount_cents, payer, first_participant, participants, category, note, link,
        }
    }
}

prop_compose! {
    fn arb_settlement_seed()(
        day_offset in -3..=8_i64,
        from in any::<Index>(),
        to in any::<Index>(),
        amount_cents in arb_amount_cents(),
        note in select(LEDGER_NOTES),
    ) -> SettlementSeed {
        SettlementSeed { day_offset, from, to, amount_cents, note }
    }
}

/// 時刻：多數取自 [`CLOCK_MINUTES`]（同一時間的活動與料理因此常見），其餘是 00:00–23:59 的任意分鐘。
pub fn arb_hm() -> impl Strategy<Value = Hm> {
    prop_oneof![
        3 => select(CLOCK_MINUTES),
        1 => 0..24 * 60_u16,
    ]
    .prop_map(|minutes| Hm::from_minutes(minutes).expect("0..1440 的分鐘數"))
}

/// 金額（分）：NT$0.01 與 NT$1,000,000 兩個邊界，多數是 NT$2,000 以內的金額，其餘是範圍內的任意金額。
pub fn arb_amount_cents() -> impl Strategy<Value = i64> {
    prop_oneof![
        1 => Just(1_i64),
        1 => Just(100_000_000_i64),
        6 => 1..=200_000_i64,
        2 => 1..=100_000_000_i64,
    ]
}

// ── 建立狀態 ──

impl StateSeed {
    fn build(self) -> TripState {
        let card = self.card.build();
        let days = date_range(card.start, card.end);
        let destination_usable = !trim_white(&card.destination).is_empty();
        let destination_key = place_key(&card.destination);

        // 旅伴：名字取自 Participant_Key 兩兩不同的詞彙（I2）
        let people: Vec<Person> = self
            .names
            .iter()
            .zip(&self.people)
            .enumerate()
            .map(|(k, (name, seed))| Person {
                id: id(Tag::Person, number(k)),
                name: (*name).to_owned(),
                role: seed.role.to_owned(),
                color: seed.color,
                bound: seed.bound,
                ordinal: 0,
                version: 0,
            })
            .collect();
        let person_ids: Vec<PersonId> = people.iter().map(|person| person.id).collect();
        let person_seeds = &self.people[..people.len()];

        // 車輛：駕駛不當乘客，乘客最多座位數減 1（I6）
        let vehicles: Vec<Vehicle> = self
            .vehicles
            .iter()
            .enumerate()
            .map(|(k, seed)| {
                let driver = pick(&person_ids, seed.driver);
                let passengers = masked(&person_ids, seed.passengers)
                    .filter(|&person| Some(person) != driver)
                    .take(usize::from(seed.seats) - 1)
                    .collect();
                Vehicle {
                    id: id(Tag::Vehicle, number(k)),
                    name: seed.name.to_owned(),
                    driver,
                    seats: seed.seats,
                    color: seed.color.map(str::to_owned),
                    passengers,
                    ordinal: 0,
                    version: 0,
                }
            })
            .collect();
        let vehicle_ids: Vec<VehicleId> = vehicles.iter().map(|vehicle| vehicle.id).collect();

        // 地點：Place_Key 兩兩不同，與非空白旅行目的地同名的不放進清單（I2）
        let places: Vec<Place> = self
            .places
            .iter()
            .filter(|name| !(destination_usable && place_key(name) == destination_key))
            .enumerate()
            .map(|(k, name)| Place {
                id: id(Tag::Place, number(k)),
                name: (*name).to_owned(),
                template: self.place_templates[k],
                ordinal: 0,
                version: 0,
            })
            .collect();

        // 路線端點與停靠點可以使用的地點：目的地不是空白時才有 Destination_Place（I1、I4）
        let refs: Vec<PlaceRef> = destination_usable
            .then_some(PlaceRef::Destination)
            .into_iter()
            .chain(places.iter().map(|place| PlaceRef::Place(place.id)))
            .collect();

        // 路線：每台車每天最多一條，最多 6 個停靠點，停靠點 id 在整趟旅行中不重複（I3、I5）
        let mut routes: Vec<Route> = Vec::new();
        let mut stop_count = 0;
        for (v, vehicle) in vehicles.iter().enumerate() {
            for (d, &day) in days.iter().enumerate() {
                let Some(seed) = &self.routes[v * MAX_DAYS + d] else {
                    continue;
                };
                if refs.is_empty() {
                    continue;
                }
                let mut stops = Vec::new();
                for stop in &seed.stops {
                    stops.push(Stop {
                        id: id(Tag::Stop, number(stop_count)),
                        place: *stop.place.get(&refs),
                        kind: stop.kind,
                        task: stop.task.map(|task| *task.get(tasks_of(stop.kind))),
                        note: stop.note.to_owned(),
                        time: stop.time,
                        items: if stop.kind == StopKind::Shop {
                            Vec::new()
                        } else {
                            stop.items.iter().map(|item| (*item).to_owned()).collect()
                        },
                    });
                    stop_count += 1;
                }
                routes.push(Route {
                    id: id(Tag::Route, number(routes.len())),
                    day,
                    vehicle: vehicle.id,
                    from: *seed.from.get(&refs),
                    to: *seed.to.get(&refs),
                    depart: seed.depart,
                    stops,
                    ordinal: 0,
                    version: 0,
                });
            }
        }

        // 每日設定：日期在旅行範圍內，地點取自地點清單；標題、地點與預計抵達時間都未設定時不存在（需求 22.11）
        let place_ids: Vec<_> = places.iter().map(|place| place.id).collect();
        let day_settings: Vec<DaySetting> = days
            .iter()
            .zip(&self.day_settings)
            .filter_map(|(&day, seed)| {
                let seed = seed.as_ref()?;
                let place = pick(&place_ids, seed.place);
                if seed.title.is_none()
                    && place.is_none()
                    && seed.arrival.is_none()
                    && seed.arrival_label.is_none()
                {
                    return None;
                }
                Some(DaySetting {
                    day,
                    title: seed.title.map(str::to_owned),
                    place,
                    arrival: seed.arrival,
                    arrival_label: seed.arrival_label.map(str::to_owned),
                    route_position: seed.route_position,
                    version: 0,
                })
            })
            .collect();

        // 活動：日期在旅行範圍內（I5），指定的旅伴或車輛不是空集合（I11）
        let activities: Vec<Activity> = self
            .activities
            .iter()
            .enumerate()
            .map(|(k, seed)| Activity {
                id: id(Tag::Activity, number(k)),
                day: *seed.day.get(&days),
                time: seed.time,
                title: seed.title.to_owned(),
                kind: seed.kind,
                location: seed.location.to_owned(),
                note: seed.note.to_owned(),
                done: seed.done,
                who: participation(&seed.who, &person_ids, &vehicle_ids),
                ordinal: 0,
                version: 0,
            })
            .collect();

        // 料理
        let meals: Vec<Meal> = self
            .meals
            .iter()
            .enumerate()
            .map(|(k, seed)| Meal {
                id: id(Tag::Meal, number(k)),
                day: *seed.day.get(&days),
                slot: seed.slot,
                time: seed.time,
                title: seed.title.to_owned(),
                cook: pick(&person_ids, seed.cook),
                servings: seed.servings,
                ingredients: seed.ingredients.clone(),
                notes: seed.notes.to_owned(),
                dish: seed.dish,
                ordinal: 0,
                version: 0,
            })
            .collect();
        let meal_ids: Vec<_> = meals.iter().map(|meal| meal.id).collect();

        // 採買品項：連動的料理只取存在的料理（I1），其他欄位隨機（I9 留給採買同步）
        let shopping: Vec<ShoppingItem> = self
            .shopping
            .iter()
            .enumerate()
            .map(|(k, seed)| ShoppingItem {
                id: id(Tag::Shopping, number(k)),
                name: seed.name.clone(),
                quantity: seed.quantity.to_owned(),
                category: seed.category,
                assignee: pick(&person_ids, seed.assignee),
                purchased: seed.purchased,
                source: seed.source,
                meal_ids: masked(&meal_ids, seed.meals).collect(),
                recipe_removed: seed.recipe_removed,
                ordinal: 0,
                version: 0,
            })
            .collect();

        // 裝備：個人裝備沒有負責人；共用裝備只有負責人能打包，待分配的沒有打包勾選（I7）
        let gear: Vec<GearItem> = self
            .gear
            .iter()
            .enumerate()
            .map(|(k, seed)| {
                let (scope, assignee, packed_by) = if seed.shared {
                    let assignee = seed
                        .assignee
                        .filter(|_| !people.is_empty())
                        .map(|index| index.index(people.len()));
                    let packed_by = match assignee {
                        Some(a) if person_seeds[a].ready || seed.packed & 1 != 0 => {
                            BTreeSet::from([person_ids[a]])
                        }
                        _ => BTreeSet::new(),
                    };
                    (
                        GearScope::Shared,
                        assignee.map(|a| person_ids[a]),
                        packed_by,
                    )
                } else {
                    // 已打包自己 My_Gear 的旅伴，加上遮罩選到的旅伴
                    let packed_by = person_ids
                        .iter()
                        .zip(person_seeds)
                        .enumerate()
                        .filter(|&(p, (_, person))| person.ready || (seed.packed >> p) & 1 == 1)
                        .map(|(_, (&person, _))| person)
                        .collect();
                    (GearScope::Personal, None, packed_by)
                };
                GearItem {
                    id: id(Tag::Gear, number(k)),
                    name: seed.name.to_owned(),
                    quantity: seed.quantity.to_owned(),
                    scope,
                    assignee,
                    packed_by,
                    ordinal: 0,
                    version: 0,
                }
            })
            .collect();

        // 出發確認：只給滿足 Can_Depart 的旅伴（I8）
        let unassigned_shared = gear
            .iter()
            .any(|item| item.scope == GearScope::Shared && item.assignee.is_none());
        let departures: Vec<Departure> = person_ids
            .iter()
            .zip(person_seeds)
            .filter(|&(&person, seed)| {
                seed.depart
                    && !unassigned_shared
                    && gear
                        .iter()
                        .filter(|item| is_my_gear(item, person))
                        .all(|item| item.packed_by.contains(&person))
            })
            .map(|(&person, _)| Departure { person, version: 0 })
            .collect();

        // 支出：付款人與分攤旅伴都存在、分攤旅伴有 1 位以上（I10、I12）；連結的品項存在（I1）
        let shopping_ids: Vec<ShoppingId> = shopping.iter().map(|item| item.id).collect();
        let unbought_meal_items: Vec<ShoppingId> = shopping
            .iter()
            .filter(|item| item.source == ItemSource::Meal && !item.purchased)
            .map(|item| item.id)
            .collect();
        let expenses: Vec<Expense> = if person_ids.is_empty() {
            Vec::new()
        } else {
            self.expenses
                .iter()
                .enumerate()
                .map(|(k, seed)| Expense {
                    id: id(Tag::Expense, number(k)),
                    day: offset_day(card.start, seed.day_offset),
                    title: seed.title.to_owned(),
                    amount_cents: seed.amount_cents,
                    payer: *seed.payer.get(&person_ids),
                    participants: chosen(&person_ids, seed.first_participant, seed.participants),
                    category: seed.category,
                    note: seed.note.to_owned(),
                    shopping_item: match seed.link {
                        LinkSeed::None => None,
                        LinkSeed::Any(index) => pick(&shopping_ids, Some(index)),
                        LinkSeed::UnboughtMealItem(index) => {
                            pick(&unbought_meal_items, Some(index))
                                .or_else(|| pick(&shopping_ids, Some(index)))
                        }
                    },
                    ordinal: 0,
                    version: 0,
                })
                .collect()
        };

        // 還款：付款人與收款人是兩位不同的旅伴（I10）
        let settlements: Vec<Settlement> = if person_ids.len() < 2 {
            Vec::new()
        } else {
            let n = person_ids.len();
            self.settlements
                .iter()
                .enumerate()
                .map(|(k, seed)| {
                    let from = seed.from.index(n);
                    let to = (from + 1 + seed.to.index(n - 1)) % n;
                    Settlement {
                        id: id(Tag::Settlement, number(k)),
                        day: offset_day(card.start, seed.day_offset),
                        from: person_ids[from],
                        to: person_ids[to],
                        amount_cents: seed.amount_cents,
                        note: seed.note.to_owned(),
                        ordinal: 0,
                        version: 0,
                    }
                })
                .collect()
        };

        // 有 Ordinal 的列依建立的順序排好，Ordinal 取 1..=N 的一種排列，Row_Version 等於 Ordinal
        let rows: Vec<Row> = people
            .into_iter()
            .map(Row::Person)
            .chain(vehicles.into_iter().map(Row::Vehicle))
            .chain(places.into_iter().map(Row::Place))
            .chain(routes.into_iter().map(Row::Route))
            .chain(activities.into_iter().map(Row::Activity))
            .chain(meals.into_iter().map(Row::Meal))
            .chain(shopping.into_iter().map(Row::Shopping))
            .chain(gear.into_iter().map(Row::Gear))
            .chain(expenses.into_iter().map(Row::Expense))
            .chain(settlements.into_iter().map(Row::Settlement))
            .collect();
        let total = rows.len() as u64;
        let mut state = TripState::new(card);
        for (row, ordinal) in rows.into_iter().zip(shuffled_ordinals(total, self.shuffle)) {
            state.put(row.with_ordinal(ordinal).with_version(ordinal));
        }
        let unordered = day_settings
            .into_iter()
            .map(Row::DaySetting)
            .chain(departures.into_iter().map(Row::Departure));
        for (row, version) in unordered.zip(total + 1..) {
            state.put(row.with_version(version));
        }
        state
    }
}

impl CardSeed {
    fn build(&self) -> TripCard {
        let first = lm_core::time::ymd(2026, 1, 1).expect("有效的日期");
        let start = first
            .checked_add(Duration::days(self.start_offset as i64))
            .expect("開始日在日期範圍內");
        let end = start
            .checked_add(Duration::days(self.days as i64 - 1))
            .expect("結束日在日期範圍內");
        TripCard {
            id: id(Tag::Trip, 1),
            title: self.title.to_owned(),
            destination: self.destination.to_owned(),
            start,
            end,
            description: self.description.to_owned(),
            note: self.note.to_owned(),
            headline: self.headline.to_owned(),
            caption: self.caption.to_owned(),
            cover: self.cover,
            status: self.status,
            version: 0,
        }
    }
}

/// 第 k 個（從 0 起）列的 id 序號（從 1 起）。
fn number(k: usize) -> u64 {
    k as u64 + 1
}

/// `index` 選到的 `items` 中的一個；`index` 是 `None` 或 `items` 是空的時是 `None`。
fn pick<T: Copy>(items: &[T], index: Option<Index>) -> Option<T> {
    index
        .filter(|_| !items.is_empty())
        .map(|index| *index.get(items))
}

/// `mask` 的第 k 個位元為 1 的 `items[k]`，依 `items` 的順序；只看前 8 個。
fn masked<T: Copy>(items: &[T], mask: u8) -> impl Iterator<Item = T> + '_ {
    items
        .iter()
        .enumerate()
        .filter(move |&(k, _)| k < 8 && (mask >> k) & 1 == 1)
        .map(|(_, &item)| item)
}

/// `items[first]` 加上 `masked(items, more)`：不是空的集合。`items` 不能是空的。
fn chosen<T: Copy + Ord>(items: &[T], first: Index, more: u8) -> BTreeSet<T> {
    std::iter::once(*first.get(items))
        .chain(masked(items, more))
        .collect()
}

fn participation(who: &WhoSeed, people: &[PersonId], vehicles: &[VehicleId]) -> Participation {
    match *who {
        WhoSeed::People(first, more) if !people.is_empty() => {
            Participation::People(chosen(people, first, more))
        }
        WhoSeed::Vehicles(first, more) if !vehicles.is_empty() => {
            Participation::Vehicles(chosen(vehicles, first, more))
        }
        _ => Participation::Everyone,
    }
}

/// 屬於停靠點種類 `kind` 的任務（Enum_Table 的「停靠點種類與任務」），第一個是預設任務。
fn tasks_of(kind: StopKind) -> &'static [StopTask] {
    match kind {
        StopKind::Shop => &[StopTask::Shopping],
        StopKind::Pickup => &[StopTask::PassengerPickup, StopTask::PassengerDropoff],
        StopKind::Gear => &[StopTask::GearPickup, StopTask::GearReturn],
        StopKind::Other => &[StopTask::Waypoint, StopTask::CarRental, StopTask::CarReturn],
    }
}

/// `item` 是不是 `person` 的 My_Gear：所有個人裝備，加上他負責的共用裝備。
fn is_my_gear(item: &GearItem, person: PersonId) -> bool {
    item.scope == GearScope::Personal || item.assignee == Some(person)
}

/// `start` 加 `days` 天（可以是負數）。
fn offset_day(start: Date, days: i64) -> Date {
    start
        .checked_add(Duration::days(days))
        .expect("日期在範圍內")
}

/// 1..=n 的一種排列：`seed` 為 0 時依原順序（proptest 縮小失敗案例時把 `seed` 縮到 0），否則以 SplitMix64 洗牌。
fn shuffled_ordinals(n: u64, seed: u64) -> Vec<u64> {
    let mut ordinals: Vec<u64> = (1..=n).collect();
    if seed != 0 {
        let mut state = seed;
        for i in (1..ordinals.len()).rev() {
            let j = (splitmix64(&mut state) % (i as u64 + 1)) as usize;
            ordinals.swap(i, j);
        }
    }
    ordinals
}

/// SplitMix64 的下一個值。
fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}
