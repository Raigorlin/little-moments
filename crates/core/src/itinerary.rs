//! 行程推導（design 1.1）：活動類別與常用活動、停靠點的種類與任務、料理的用餐時間、標題與文字版的類別、一天的路線
//! 與活動、Shopping_Plan、Day_Place、地點的使用處與名稱規則、旅行目的地的衝突、車輛的預設顏色，以及一位旅伴參加的
//! 活動。
//!
//! 移植自 `src/itinerary-model.js`（`ACTIVITY_CATEGORIES`、`presetsFor()`、`STOP_KINDS`、`STOP_TASK_KINDS`、
//! `DEFAULT_STOP_TASK`、`MEAL_DEFAULT_TIMES`、`mealTime()`、`mealTitle()`、`placeNameError()`、
//! `destinationConflict()`、`CAR_PALETTE`）、`src/itinerary-derive.js`（`tripDays()`、`placeLabel()`、`dayLocation()`、
//! `sortedRoutes()`、`shoppingPlan()`、`placeUsages()`）、`src/storybook-adapter.js` 的 `project()`（文字版的路線與
//! 活動順序，以及料理的類別 `mealKind()`），與 `src/vehicle-itinerary.js`（`activityForPerson()`、
//! `activityParticipantLabel()`）。
//!
//! 每個函式只讀取 Trip_State，不修改它；Shopping_Plan 也不新增、移除或修改採買品項。現行陣列的順序在這裡是 Ordinal：
//! 依 `TripState` 的 `*_by_ordinal()` 走訪（Ordinal 相同時依 id），所以結果只取決於列的內容，與列插入的順序無關
//! （需求 31.1）。名稱依儲存的值回傳，放進 Itinerary_Text 時由呼叫端以 `clean_text()` 處理；只有 `meal_title()` 本身就是
//! 處理過的料理標題（需求 31.11、31.14）。

use std::collections::{BTreeMap, BTreeSet};

use crate::ids::{PersonId, PlaceId, RouteId, ShoppingId, StopId, VehicleId};
use crate::limits::PLACE_NAME_CHARS;
use crate::model::{
    Activity, ActivityKind, Date, DishKind, Meal, MealSlot, Participation, PlaceRef, Route, Stop,
    StopKind, StopTask, TripState, Vehicle,
};
use crate::recipes::infer_dish_kind;
use crate::text::{char_count, clean_text, has_control_chars, place_key, trim_white};
use crate::time::{date_range, Hm};

/// 以列舉值為索引的表依列舉的宣告順序（也就是 Enum_Table 的順序）排列：第 i 列的第一欄是列舉的第 i 個值，所以
/// `label()` 等方法以 `as usize` 取用。在編譯時確認。
macro_rules! assert_indexed_by {
    ($table:expr, $all:expr) => {
        const _: () = {
            assert!($table.len() == $all.len());
            let mut i = 0;
            while i < $table.len() {
                assert!($table[i].0 as usize == i);
                i += 1;
            }
        };
    };
}

/// 固定的時刻；不在 00:00–23:59 時無法編譯。
const fn hm(hour: u8, minute: u8) -> Hm {
    match Hm::new(hour, minute) {
        Some(time) => time,
        None => panic!("時刻需在 00:00–23:59"),
    }
}

// ── 活動類別與常用活動 ──

/// 活動類別（Activity_Category，13 種）與中文名稱，依 Enum_Table 的順序（現行 `ACTIVITY_CATEGORIES`），例如活動表單的
/// 類別選單。順序與 `ActivityKind::ALL` 相同。
pub const ACTIVITY_CATEGORIES: &[(ActivityKind, &str)] = &[
    (ActivityKind::Meet, "集合"),
    (ActivityKind::Market, "採買"),
    (ActivityKind::Camp, "營地時光"),
    (ActivityKind::Meal, "用餐"),
    (ActivityKind::Night, "夜晚"),
    (ActivityKind::Travel, "移動"),
    (ActivityKind::Wake, "起床"),
    (ActivityKind::Pitch, "搭帳"),
    (ActivityKind::Free, "自由活動"),
    (ActivityKind::Tea, "下午茶／遊戲"),
    (ActivityKind::Strike, "拆帳"),
    (ActivityKind::Clean, "清潔"),
    (ActivityKind::Return, "返程"),
];
assert_indexed_by!(ACTIVITY_CATEGORIES, ActivityKind::ALL);

impl ActivityKind {
    /// 中文名稱，例如 pitch 為「搭帳」：活動列與 Itinerary_Text 中活動的類別（需求 23.8、31.9）。
    pub const fn label(self) -> &'static str {
        ACTIVITY_CATEGORIES[self as usize].1
    }
}

/// Trip_Day 在旅行中的位置，決定它的常用活動（現行 `tripDays()` 的 `kind`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DayKind {
    /// 2 天以上旅行的第 1 天
    First,
    /// 第一天與最後一天以外的日子
    Middle,
    /// 2 天以上旅行的最後一天
    Last,
    /// 一日遊（只有 1 個 Trip_Day 的旅行）
    Single,
}

/// 一個 Trip_Day。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TripDay {
    pub date: Date,
    /// 第幾天，從 1 起算。
    pub n: usize,
    pub kind: DayKind,
}

/// 旅行的每一個 Trip_Day，依日期遞增（現行 `tripDays()`）：第 1 天的 `n` 是 1；只有 1 天時是 `Single`，否則第 1 天是
/// `First`、最後一天是 `Last`、其他是 `Middle`。旅行的起訖日期不是 1–31 天時是空的（只在無效的狀態）。
pub fn trip_days(s: &TripState) -> Vec<TripDay> {
    let dates = date_range(s.card.start, s.card.end);
    let last = dates.len().saturating_sub(1);
    dates
        .into_iter()
        .enumerate()
        .map(|(i, date)| TripDay {
            date,
            n: i + 1,
            kind: if last == 0 {
                DayKind::Single
            } else if i == 0 {
                DayKind::First
            } else if i == last {
                DayKind::Last
            } else {
                DayKind::Middle
            },
        })
        .collect()
}

/// 一個常用活動（Activity_Preset）：加入時在選定的 Trip_Day 新增一筆標題、時間與類別相同，參加者為全體旅伴、地點與
/// 備註空白、未完成的活動（需求 23.1）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ActivityPreset {
    pub kind: ActivityKind,
    pub time: Hm,
    pub title: &'static str,
}

const fn preset(kind: ActivityKind, time: Hm, title: &'static str) -> ActivityPreset {
    ActivityPreset { kind, time, title }
}

/// 第一天的常用活動（現行 `ACTIVITY_PRESETS.first`）。
const FIRST_DAY_PRESETS: &[ActivityPreset] = &[
    preset(ActivityKind::Pitch, hm(13, 0), "搭帳・營地佈置"),
    preset(ActivityKind::Night, hm(20, 0), "星空夜聊・自由活動"),
];

/// 中間的日子的常用活動（現行 `ACTIVITY_PRESETS.middle`）。
const MIDDLE_DAY_PRESETS: &[ActivityPreset] = &[
    preset(ActivityKind::Wake, hm(8, 0), "起床"),
    preset(ActivityKind::Free, hm(10, 0), "自由活動、拍照"),
    preset(ActivityKind::Tea, hm(14, 0), "下午茶、聊天、玩遊戲"),
    preset(ActivityKind::Night, hm(20, 0), "自由活動"),
];

/// 最後一天的常用活動（現行 `ACTIVITY_PRESETS.last`）。
const LAST_DAY_PRESETS: &[ActivityPreset] = &[
    preset(ActivityKind::Wake, hm(8, 0), "起床"),
    preset(ActivityKind::Strike, hm(10, 0), "拆帳、整理裝備"),
    preset(ActivityKind::Clean, hm(11, 30), "環境清潔、裝車"),
    preset(ActivityKind::Return, hm(12, 0), "集合、返程"),
];

/// 需求 23.2（現行 `presetsFor()`）：這種日子的常用活動，依時間由早到晚。
///
/// - 第一天：13:00「搭帳・營地佈置」（搭帳）、20:00「星空夜聊・自由活動」（夜晚）。
/// - 中間的日子：08:00「起床」（起床）、10:00「自由活動、拍照」（自由活動）、14:00「下午茶、聊天、玩遊戲」
///   （下午茶／遊戲）、20:00「自由活動」（夜晚）。
/// - 最後一天：08:00「起床」（起床）、10:00「拆帳、整理裝備」（拆帳）、11:30「環境清潔、裝車」（清潔）、
///   12:00「集合、返程」（返程）。
/// - 一日遊：依序合併第一天與最後一天的項目，同一類別只留先出現的一項（兩者沒有相同的類別，所以是全部 6 項），再依時間
///   排序，時間相同時保持合併的順序。
pub fn presets_for(kind: DayKind) -> Vec<ActivityPreset> {
    let rows = match kind {
        DayKind::First => FIRST_DAY_PRESETS.to_vec(),
        DayKind::Middle => MIDDLE_DAY_PRESETS.to_vec(),
        DayKind::Last => LAST_DAY_PRESETS.to_vec(),
        DayKind::Single => [FIRST_DAY_PRESETS, LAST_DAY_PRESETS].concat(),
    };
    let mut seen = BTreeSet::new();
    let mut presets: Vec<ActivityPreset> = rows
        .into_iter()
        .filter(|preset| seen.insert(preset.kind))
        .collect();
    // 穩定排序：時間相同時保持合併的順序
    presets.sort_by_key(|preset| preset.time);
    presets
}

// ── 停靠點的種類與任務 ──

/// 停靠點種類與中文名稱，依 Enum_Table 的順序（現行 `STOP_KINDS`）。
pub const STOP_KINDS: &[(StopKind, &str)] = &[
    (StopKind::Shop, "採買"),
    (StopKind::Pickup, "接送"),
    (StopKind::Gear, "取還裝備"),
    (StopKind::Other, "其他"),
];
assert_indexed_by!(STOP_KINDS, StopKind::ALL);

/// 每一種停靠點任務、它所屬的停靠點種類，以及路線卡片與 Itinerary_Text 使用的任務名稱，依 Enum_Table 的順序
/// （現行 `STOP_TASK_KINDS`；名稱是行程繪本 `STOP_KINDS` 的名稱）。
pub const STOP_TASK_KINDS: &[(StopTask, StopKind, &str)] = &[
    (StopTask::Shopping, StopKind::Shop, "採買"),
    (StopTask::PassengerPickup, StopKind::Pickup, "接人"),
    (StopTask::PassengerDropoff, StopKind::Pickup, "送人下車"),
    (StopTask::GearPickup, StopKind::Gear, "領取租借裝備"),
    (StopTask::GearReturn, StopKind::Gear, "歸還裝備"),
    (StopTask::CarRental, StopKind::Other, "取租車"),
    (StopTask::CarReturn, StopKind::Other, "還車"),
    (StopTask::Waypoint, StopKind::Other, "一般停靠"),
];
assert_indexed_by!(STOP_TASK_KINDS, StopTask::ALL);

impl StopKind {
    /// 中文名稱，例如 gear 為「取還裝備」。
    pub const fn label(self) -> &'static str {
        STOP_KINDS[self as usize].1
    }

    /// 需求 22.8（現行 `DEFAULT_STOP_TASK`）：沒有指定任務時的預設任務：採買為「採買」、接送為「接人」、取還裝備為
    /// 「領取租借裝備」、其他為「一般停靠」。
    pub const fn default_task(self) -> StopTask {
        match self {
            StopKind::Shop => StopTask::Shopping,
            StopKind::Pickup => StopTask::PassengerPickup,
            StopKind::Gear => StopTask::GearPickup,
            StopKind::Other => StopTask::Waypoint,
        }
    }

    /// 屬於這個種類的任務，依 Enum_Table 的順序，例如路線卡片的任務選單。
    pub fn tasks(self) -> impl Iterator<Item = StopTask> {
        STOP_TASK_KINDS
            .iter()
            .filter(move |&&(_, kind, _)| kind == self)
            .map(|&(task, _, _)| task)
    }
}

impl StopTask {
    /// 這個任務所屬的停靠點種類；停靠點的任務必須屬於它的種類（需求 22.7）。
    pub const fn kind(self) -> StopKind {
        STOP_TASK_KINDS[self as usize].1
    }

    /// 任務名稱，例如 gear-pickup 為「領取租借裝備」。
    pub const fn label(self) -> &'static str {
        STOP_TASK_KINDS[self as usize].2
    }
}

/// 需求 22.8：路線卡片與 Itinerary_Text 寫出的停靠點任務：指定的任務，沒有指定時是種類的預設任務。預設任務不寫入
/// 停靠點，所以停靠點改變種類之後改用新種類的預設任務。
pub fn stop_task(stop: &Stop) -> StopTask {
    stop.task.unwrap_or(stop.kind.default_task())
}

// ── 料理 ──

/// 每個餐次的預設用餐時間，依餐次的順序（現行 `MEAL_DEFAULT_TIMES`，需求 24.3）：早餐 08:30、午餐 12:00、
/// 下午茶 15:00、晚餐 18:00、消夜 21:00。
pub const MEAL_DEFAULT_TIMES: &[(MealSlot, Hm)] = &[
    (MealSlot::Breakfast, hm(8, 30)),
    (MealSlot::Lunch, hm(12, 0)),
    (MealSlot::AfternoonTea, hm(15, 0)),
    (MealSlot::Dinner, hm(18, 0)),
    (MealSlot::LateNight, hm(21, 0)),
];
assert_indexed_by!(MEAL_DEFAULT_TIMES, MealSlot::ALL);

impl MealSlot {
    /// 這個餐次的預設用餐時間（`MEAL_DEFAULT_TIMES`）。
    pub const fn default_time(self) -> Hm {
        MEAL_DEFAULT_TIMES[self as usize].1
    }
}

/// 需求 24.3（現行 `mealTime()`）：料理在 Schedule_Tab 與 Itinerary_Text 中的時間：設定的用餐時間，留空時是餐次的
/// 預設用餐時間；預設時間不寫入料理。
pub fn meal_time(meal: &Meal) -> Hm {
    meal.time.unwrap_or(meal.slot.default_time())
}

/// 需求 31.11（現行 `mealTitle()`）：料理的標題「{餐次}：{料理名稱}」；料理名稱經 `clean_text()` 之後是空字串或與餐次
/// 相同時只寫餐次，例如「午餐：咖哩飯」「早餐」。也是採買清單中連動料理的標題（需求 26.1）。
pub fn meal_title(meal: &Meal) -> String {
    let slot = meal.slot.as_str();
    let title = clean_text(&meal.title);
    if title.is_empty() || title == slot {
        slot.to_owned()
    } else {
        format!("{slot}：{title}")
    }
}

/// 需求 31.11（現行 `project()` 的 `mealKind()`）：Itinerary_Text 中料理的類別，依序取第一個符合的條件：插圖種類
/// （沒有設定時依 `infer_dish_kind()` 推斷）為 hotpot 時為「火鍋」、為 bbq 時為「烤肉」、為 breakfast 或 toast 時為
/// 「早餐」；餐次為早餐時為「早餐」、為午餐時為「午餐」；其他為「用餐」。
pub fn meal_category(meal: &Meal) -> &'static str {
    match infer_dish_kind(meal) {
        DishKind::Hotpot => "火鍋",
        DishKind::Bbq => "烤肉",
        DishKind::Breakfast | DishKind::Toast => "早餐",
        _ => match meal.slot {
            MealSlot::Breakfast => "早餐",
            MealSlot::Lunch => "午餐",
            _ => "用餐",
        },
    }
}

// ── 一天的路線、活動與料理 ──

/// 需求 22.2（現行 `sortedRoutes()`）：這一天的路線卡片的順序：依出發時間由早到晚，出發時間相同時依車輛的 Ordinal；
/// 沒有出發時間的路線排在最後，彼此也依車輛的 Ordinal。不是這趟旅行的車輛（只在無效的狀態）排在同一組的最後，
/// 其餘相同時依路線的 Ordinal。Itinerary_Text 不用這個順序，見 `day_routes_by_ordinal()`。
pub fn sorted_routes(s: &TripState, day: Date) -> Vec<&Route> {
    let positions = vehicle_positions(s);
    let mut routes: Vec<&Route> = day_routes_by_ordinal(s, day).collect();
    // 穩定排序：其餘相同時保持路線的 Ordinal
    routes.sort_by_key(|route| {
        (
            route.depart.is_none(),
            route.depart,
            positions.get(&route.vehicle).copied().unwrap_or(usize::MAX),
        )
    });
    routes
}

/// 需求 31.5：這一天的路線，依建立順序（Ordinal），也就是 Itinerary_Text 列出路線的順序（現行 `project()` 依
/// `state.routes` 陣列的順序），可能與路線卡片的 `sorted_routes()` 不同。
pub fn day_routes_by_ordinal(s: &TripState, day: Date) -> impl Iterator<Item = &Route> + '_ {
    s.routes_by_ordinal().filter(move |route| route.day == day)
}

/// 一天中的一筆活動或料理（`day_events()` 的一項）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DayEvent<'a> {
    Activity(&'a Activity),
    Meal(&'a Meal),
}

impl DayEvent<'_> {
    /// 排序與 Itinerary_Text 使用的時間：活動的時間，或料理的 `meal_time()`。
    pub fn time(&self) -> Hm {
        match self {
            DayEvent::Activity(activity) => activity.time,
            DayEvent::Meal(meal) => meal_time(meal),
        }
    }
}

/// 需求 31.9：日期為這一天的活動與料理，依時間遞增；時間相同時活動排在料理之前，活動之間與料理之間各依建立順序
/// （Ordinal，相同時依 id）。已完成的活動也列出。與現行 `project()` 先列活動、再列料理，再依時間穩定排序的結果相同；
/// 現行 `dayModel()` 在同一時間另依餐次排序料理，這裡依需求只依 Ordinal。
pub fn day_events(s: &TripState, day: Date) -> Vec<DayEvent<'_>> {
    let mut events: Vec<DayEvent<'_>> = s
        .activities_by_ordinal()
        .filter(|activity| activity.day == day)
        .map(DayEvent::Activity)
        .chain(
            s.meals_by_ordinal()
                .filter(|meal| meal.day == day)
                .map(DayEvent::Meal),
        )
        .collect();
    // 穩定排序：同一時間的活動在料理之前，各自保持 Ordinal 的順序
    events.sort_by_key(|event| (event.time(), matches!(event, DayEvent::Meal(_))));
    events
}

// ── Shopping_Plan ──

/// 一台車的 First_Shopping_Stop：這台車有 Shopping_Stop 的路線中日期最早的一條、路線上最前面的 Shopping_Stop。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FirstShoppingStop {
    pub vehicle: VehicleId,
    pub route: RouteId,
    pub stop: StopId,
    pub day: Date,
    /// 第幾天，從 1 起算。
    pub n: usize,
    /// 停靠點的地點。
    pub place: PlaceRef,
}

/// Unassigned_Shopping 的原因（需求 22.14）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum UnassignedCode {
    /// 負責人為待分配：「待分配」。
    Unassigned,
    /// 負責人不是任何車輛的駕駛或乘客：「{旅伴名字}不在任何車上」。
    NoCar,
    /// 負責人所在的車沒有 Shopping_Stop：「{車名}還沒有採買停靠點」。
    NoStop,
}

/// Unassigned_Shopping 中的一個採買品項。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnassignedShopping {
    pub item: ShoppingId,
    pub code: UnassignedCode,
    /// 需求 22.14 的原因文字，名稱是儲存的值，例如「待分配」「阿明不在任何車上」「第一車還沒有採買停靠點」。
    pub reason: String,
}

/// Shopping_Plan（現行 `shoppingPlan()`）：由採買品項的負責人與車輛推導的採買安排，不儲存在 Trip_State 中。每個採買品項
/// 恰好在一個 First_Shopping_Stop 的品項中，或在 Unassigned_Shopping 中；已買的品項也一樣。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ShoppingPlan {
    /// Buyer_Car：每位是某台車駕駛或乘客的旅伴 → 依車輛的 Ordinal，第一台以他為駕駛或乘客的車。
    pub buyer_car: BTreeMap<PersonId, VehicleId>,
    /// 每台有 Shopping_Stop 的車 → 它的 First_Shopping_Stop；沒有 Shopping_Stop 的車沒有項目。
    pub first_stop: BTreeMap<VehicleId, FirstShoppingStop>,
    /// Unassigned_Shopping，依採買品項的 Ordinal。
    pub unassigned: Vec<UnassignedShopping>,
    /// 每個 First_Shopping_Stop → 分到它的品項（可能是空的），依採買品項的 Ordinal。
    stop_items: BTreeMap<StopId, Vec<ShoppingId>>,
    /// 分到 First_Shopping_Stop 的品項 → 那台車。
    item_car: BTreeMap<ShoppingId, VehicleId>,
}

impl ShoppingPlan {
    /// 分到這個停靠點的採買品項（已買的也算），依採買品項的 Ordinal；不是任何一台車的 First_Shopping_Stop 時是空的，
    /// 例如同一台車日期較晚，或同一天在路線上較後面的 Shopping_Stop（需求 31.7），以及其他種類的停靠點。
    pub fn stop_items(&self, stop: StopId) -> &[ShoppingId] {
        self.stop_items
            .get(&stop)
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    /// 這個採買品項分到的 First_Shopping_Stop，例如出發清單的「第 N 天在{地點名稱}」（需求 28.1）；屬於
    /// Unassigned_Shopping 或不是這趟旅行的品項時是 `None`。
    pub fn stop_of(&self, item: ShoppingId) -> Option<&FirstShoppingStop> {
        self.first_stop.get(self.item_car.get(&item)?)
    }
}

/// Shopping_Plan（現行 `shoppingPlan()`，需求 22.14、31.7）：
///
/// 1. Buyer_Car：依車輛的 Ordinal，每位旅伴所在的第一台車（以他為駕駛或乘客）。
/// 2. First_Shopping_Stop：每台車有 Shopping_Stop 的路線中日期最早的一條（同一天的多條路線只在無效的狀態，留下 Ordinal
///    在前的那一條）、路線上最前面的 Shopping_Stop。日期不在旅行範圍內的路線與不是這趟旅行的車輛的路線不算。
/// 3. 依採買品項的 Ordinal 分配每個品項（已買的也算）：負責人為待分配時是 Unassigned_Shopping「待分配」；負責人沒有
///    Buyer_Car 時是「{旅伴名字}不在任何車上」；Buyer_Car 沒有 First_Shopping_Stop 時是「{車名}還沒有採買停靠點」；
///    其他品項分到 Buyer_Car 的 First_Shopping_Stop。
///
/// 原因中的名稱是儲存的值，改名之後就是新的名稱；不是這趟旅行的旅伴（只在無效的狀態）的名字是空字串。
pub fn shopping_plan(s: &TripState) -> ShoppingPlan {
    let mut buyer_car = BTreeMap::new();
    for vehicle in s.vehicles_by_ordinal() {
        for &person in vehicle.driver.iter().chain(&vehicle.passengers) {
            buyer_car.entry(person).or_insert(vehicle.id);
        }
    }

    let days = day_numbers(s);
    let mut first_stop: BTreeMap<VehicleId, FirstShoppingStop> = BTreeMap::new();
    for route in s.routes_by_ordinal() {
        let Some(&n) = days.get(&route.day) else {
            continue;
        };
        if !s.vehicles.contains_key(&route.vehicle) {
            continue;
        }
        let Some(stop) = route.stops.iter().find(|stop| stop.kind == StopKind::Shop) else {
            continue;
        };
        // 日期較早的才取代；同一天的保留 Ordinal 在前的路線
        if first_stop
            .get(&route.vehicle)
            .is_some_and(|first| first.n <= n)
        {
            continue;
        }
        first_stop.insert(
            route.vehicle,
            FirstShoppingStop {
                vehicle: route.vehicle,
                route: route.id,
                stop: stop.id,
                day: route.day,
                n,
                place: stop.place,
            },
        );
    }

    let mut stop_items: BTreeMap<StopId, Vec<ShoppingId>> = first_stop
        .values()
        .map(|first| (first.stop, Vec::new()))
        .collect();
    let mut item_car = BTreeMap::new();
    let mut unassigned = Vec::new();
    for item in s.shopping_by_ordinal() {
        let mut leave = |code, reason| {
            unassigned.push(UnassignedShopping {
                item: item.id,
                code,
                reason,
            });
        };
        let Some(person) = item.assignee else {
            leave(UnassignedCode::Unassigned, "待分配".to_owned());
            continue;
        };
        let Some(&vehicle) = buyer_car.get(&person) else {
            let name = s
                .people
                .get(&person)
                .map_or("", |person| person.name.as_str());
            leave(UnassignedCode::NoCar, format!("{name}不在任何車上"));
            continue;
        };
        let Some(first) = first_stop.get(&vehicle) else {
            let name = s
                .vehicles
                .get(&vehicle)
                .map_or("", |vehicle| vehicle.name.as_str());
            leave(UnassignedCode::NoStop, format!("{name}還沒有採買停靠點"));
            continue;
        };
        stop_items.entry(first.stop).or_default().push(item.id);
        item_car.insert(item.id, vehicle);
    }

    ShoppingPlan {
        buyer_car,
        first_stop,
        unassigned,
        stop_items,
        item_car,
    }
}

// ── 地點 ──

/// 地點引用的名稱（現行 `placeLabel()`）：Destination_Place 是旅行目的地，地點清單中的地點是它目前的名稱，所以改名之後
/// 引用它的路線、停靠點與 Day_Place 都寫出新名稱（需求 21.6）；不在地點清單中的地點（只在無效的狀態）是空字串。
/// 名稱是儲存的值，放進 Itinerary_Text 時另經 `clean_text()`。
pub fn place_name(s: &TripState, place: PlaceRef) -> &str {
    match place {
        PlaceRef::Destination => s.card.destination.as_str(),
        PlaceRef::Place(id) => s.places.get(&id).map_or("", |place| place.name.as_str()),
    }
}

/// Day_Place（現行 `dayLocation()`，需求 31.4）：這一天的每日設定的地點；沒有設定時是非空白的旅行目的地
/// （`PlaceRef::Destination`）；兩者都沒有時是 `None`。設定的地點不在地點清單中時（只在無效的狀態）視為沒有設定。
pub fn day_place(s: &TripState, day: Date) -> Option<PlaceRef> {
    let setting = s
        .day_settings
        .get(&day)
        .and_then(|setting| setting.place)
        .filter(|id| s.places.contains_key(id));
    match setting {
        Some(id) => Some(PlaceRef::Place(id)),
        None => (!trim_white(&s.card.destination).is_empty()).then_some(PlaceRef::Destination),
    }
}

/// 需求 22.12：這一天的預計抵達時間只取規劃者在每日設定填寫的值，不由路線的出發時間、停靠點的時間或行車時間推算；
/// 沒有填寫時是 `None`，Itinerary_Text 就不輸出抵達行（需求 31.8）。
pub fn day_arrival(s: &TripState, day: Date) -> Option<Hm> {
    s.day_settings.get(&day).and_then(|setting| setting.arrival)
}

/// Place_Usage 中「這一天的每日設定以這個地點為地點」的用途。
pub const DAY_PLACE_USAGE: &str = "這一天的地點";

/// 需求 21.4 的訊息開頭。
pub const PLACE_IN_USE: &str = "這個地點還在使用中，請先把下列使用處改成其他地點。";

/// 地點在一個 Trip_Day 的一個使用處（Place_Usage）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlaceUsage {
    /// 第幾天，從 1 起算。
    pub n: usize,
    /// 用途：「這一天的地點」（`DAY_PLACE_USAGE`），或使用這個地點的車輛名稱（儲存的值）。
    pub label: String,
}

/// Place_Usage（現行 `placeUsages()`，需求 21.4）：依 Trip_Day 的順序，每一天先列「這一天的地點」（那一天的每日設定以
/// 這個地點為地點時），再依車輛的 Ordinal 列出那一天的路線以這個地點為起點、終點或任一停靠點的車，同一天同一台車只算
/// 一個。活動的地點是另外輸入的文字，不算。沒有任何使用處時是空的。
pub fn place_usages(s: &TripState, place: PlaceId) -> Vec<PlaceUsage> {
    let target = PlaceRef::Place(place);
    let mut users: BTreeMap<Date, BTreeSet<VehicleId>> = BTreeMap::new();
    for route in s.routes.values().filter(|route| route_uses(route, target)) {
        users.entry(route.day).or_default().insert(route.vehicle);
    }
    let mut usages = Vec::new();
    for day in trip_days(s) {
        if s.day_settings
            .get(&day.date)
            .is_some_and(|setting| setting.place == Some(place))
        {
            usages.push(PlaceUsage {
                n: day.n,
                label: DAY_PLACE_USAGE.to_owned(),
            });
        }
        if let Some(vehicles) = users.get(&day.date) {
            usages.extend(
                s.vehicles_by_ordinal()
                    .filter(|vehicle| vehicles.contains(&vehicle.id))
                    .map(|vehicle| PlaceUsage {
                        n: day.n,
                        label: vehicle.name.clone(),
                    }),
            );
        }
    }
    usages
}

/// 需求 21.4：刪除仍有 Place_Usage 的地點時的 409 訊息：以「這個地點還在使用中，請先把下列使用處改成其他地點。」開頭，
/// 接著依 `usages` 的順序為每個有使用處的日子寫「第 N 天：{用途}」（同一天的用途以「、」連接），日子之間以「；」連接，
/// 最後加「。」，例如「這個地點還在使用中，請先把下列使用處改成其他地點。第 1 天：第二車；第 3 天：這一天的地點、
/// 第一車。」。`usages` 是 `place_usages()` 的結果，只在不是空的時使用；空的時只有開頭的句子。
pub fn place_in_use_message(usages: &[PlaceUsage]) -> String {
    let mut days: Vec<(usize, Vec<&str>)> = Vec::new();
    for usage in usages {
        match days.last_mut() {
            Some((n, labels)) if *n == usage.n => labels.push(usage.label.as_str()),
            _ => days.push((usage.n, vec![usage.label.as_str()])),
        }
    }
    if days.is_empty() {
        return PLACE_IN_USE.to_owned();
    }
    let list: Vec<String> = days
        .iter()
        .map(|(n, labels)| format!("第 {n} 天：{}", labels.join("、")))
        .collect();
    format!("{PLACE_IN_USE}{}。", list.join("；"))
}

/// 地點名稱不符合需求 21.1 的第一條規則。`Display` 是給使用者看的訊息；`Duplicate` 以 409 回應，其他以 400 回應。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, thiserror::Error)]
pub enum PlaceNameError {
    /// Trim_White 之後是空的。
    #[error("請填寫地點名稱。")]
    Empty,
    /// 超過 50 字。
    #[error("地點名稱最多 50 個字。")]
    TooLong,
    /// 含有 Hidden_Control_Char。
    #[error("地點名稱不能包含換行、Tab 或隱藏的控制字元。")]
    ControlChars,
    /// Place_Key 與其他地點或非空白的旅行目的地相同。
    #[error("已有同名地點")]
    Duplicate,
}

/// 需求 21.1（現行 `placeNameError()`）：新增地點或替地點改名時，以 Trim_White 之後的名稱依序檢查，回傳第一個不符合的
/// 規則，都符合時是 `None`：是空的、超過 50 字、含有 Hidden_Control_Char、Place_Key 等於這趟旅行其他地點的 Place_Key
/// （`except` 是改名的地點自己，所以只改英文大小寫或全形半形的改名可以儲存），或等於非空白旅行目的地的 Place_Key。
pub fn place_name_error(
    s: &TripState,
    name: &str,
    except: Option<PlaceId>,
) -> Option<PlaceNameError> {
    let name = trim_white(name);
    if name.is_empty() {
        return Some(PlaceNameError::Empty);
    }
    if char_count(name) > *PLACE_NAME_CHARS.end() {
        return Some(PlaceNameError::TooLong);
    }
    if has_control_chars(name) {
        return Some(PlaceNameError::ControlChars);
    }
    let key = place_key(name);
    let same_place = s
        .places
        .values()
        .any(|place| Some(place.id) != except && place_key(&place.name) == key);
    let same_destination =
        !trim_white(&s.card.destination).is_empty() && place_key(&s.card.destination) == key;
    (same_place || same_destination).then_some(PlaceNameError::Duplicate)
}

/// 新的旅行目的地與行程的衝突（需求 18.3、18.4），以 409 回應。`Display` 是給使用者看的訊息。
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum DestinationConflict {
    /// 需求 18.3：新的目的地與地點清單中的地點同名；`name` 是那個地點目前的名稱。
    #[error("已有同名地點：{name}。請先在「地點與車」把這個地點改名。")]
    Duplicate { name: String },
    /// 需求 18.4：新的目的地是空白，但仍有路線的起點、終點或停靠點使用 Destination_Place。
    #[error("仍有路線或停靠點使用旅行目的地，不能把目的地清空。")]
    InUse,
}

/// 需求 18.3、18.4（現行 `destinationConflict()`）：把旅行目的地改為 `destination` 時與行程的衝突：Trim_White 之後不是
/// 空的，而且 Place_Key 與某個地點相同時是 `Duplicate`（地點的 Place_Key 兩兩不同，所以最多一個；依 Ordinal 取第一個）；
/// 是空的，而且仍有路線的起點、終點或停靠點使用 Destination_Place 時是 `InUse`；其他情況是 `None`，包括目的地不變。
pub fn destination_conflict(s: &TripState, destination: &str) -> Option<DestinationConflict> {
    if trim_white(destination).is_empty() {
        let in_use = s
            .routes
            .values()
            .any(|route| route_uses(route, PlaceRef::Destination));
        return in_use.then_some(DestinationConflict::InUse);
    }
    let key = place_key(destination);
    s.places_by_ordinal()
        .find(|place| place_key(&place.name) == key)
        .map(|place| DestinationConflict::Duplicate {
            name: place.name.clone(),
        })
}

// ── 車輛的預設顏色 ──

/// Car_Palette：車輛沒有設定顏色時的 8 個顏色，順序與現行 `CAR_PALETTE` 相同（索引 0–7）。
pub const CAR_PALETTE: [&str; 8] = [
    "#efa28f", "#b7dbe5", "#b9cda5", "#f6d27a", "#d6c8df", "#f2cbb0", "#9fc9c0", "#e3a6bd",
];

/// 需求 20.4：Car_Palette 中索引為 `position` 除以 8 的餘數的顏色。
pub fn car_palette_color(position: usize) -> &'static str {
    CAR_PALETTE[position % CAR_PALETTE.len()]
}

/// 需求 20.4：這台車顯示的顏色：設定了顏色時是它；沒有設定時是 `car_palette_color(k)`，k 是這台車在所有車輛中依
/// Ordinal 遞增排列的位置（第一台為 0，有設定顏色的車也計入），所以前面的車被刪除之後依新的位置重新計算。顏色不寫入
/// 車輛。不是這趟旅行的車時是 `None`。
pub fn vehicle_color(s: &TripState, vehicle: VehicleId) -> Option<&str> {
    s.vehicles_by_ordinal()
        .enumerate()
        .find(|(_, row)| row.id == vehicle)
        .map(|(k, row)| row.color.as_deref().unwrap_or(car_palette_color(k)))
}

// ── 一位旅伴參加的活動 ──

/// Person_Activity（現行 `activityForPerson()`）：這筆活動的參加者為全體旅伴、指定旅伴中有這位旅伴，或指定車輛中至少有
/// 一台以他為駕駛或乘客。
pub fn is_person_activity(s: &TripState, activity: &Activity, person: PersonId) -> bool {
    match &activity.who {
        Participation::Everyone => true,
        Participation::People(people) => people.contains(&person),
        Participation::Vehicles(vehicles) => vehicles
            .iter()
            .filter_map(|id| s.vehicles.get(id))
            .any(|vehicle| rides(vehicle, person)),
    }
}

/// 需求 28.5：這位旅伴下一個未完成的活動：他的 Person_Activity 中未完成的活動，依日期、時間與 Ordinal 遞增（Ordinal
/// 相同時依 id）的第一筆；沒有時是 `None`。
pub fn next_activity(s: &TripState, person: PersonId) -> Option<&Activity> {
    s.activities
        .values()
        .filter(|activity| !activity.done && is_person_activity(s, activity, person))
        .min_by_key(|activity| (activity.day, activity.time, activity.ordinal, activity.id))
}

/// 參加者是全體旅伴時的文字。
pub const EVERYONE: &str = "全體旅伴";

/// 出發清單中下一個活動的參加者（需求 28.5，現行 `activityParticipantLabel()`）：全體旅伴，或指定旅伴包含這趟旅行的
/// 每一位旅伴時，是「全體旅伴」；否則是指定的車名或旅伴名字，依 Ordinal 以「、」連接，不是這趟旅行的車輛與旅伴（只在
/// 無效的狀態）寫成「車輛待確認」與「旅伴待確認」，排在最後。現行依活動儲存的順序列出名字；這裡的指定集合沒有順序，
/// 所以依 Ordinal。
pub fn participant_label(s: &TripState, activity: &Activity) -> String {
    match &activity.who {
        Participation::Vehicles(ids) => names_with_unknown(
            s.vehicles_by_ordinal()
                .filter(|vehicle| ids.contains(&vehicle.id))
                .map(|vehicle| vehicle.name.as_str()),
            ids.iter().filter(|id| !s.vehicles.contains_key(id)).count(),
            "車輛待確認",
        ),
        Participation::People(ids) if !s.people.keys().all(|id| ids.contains(id)) => {
            names_with_unknown(
                s.people_by_ordinal()
                    .filter(|person| ids.contains(&person.id))
                    .map(|person| person.name.as_str()),
                ids.iter().filter(|id| !s.people.contains_key(id)).count(),
                "旅伴待確認",
            )
        }
        Participation::Everyone | Participation::People(_) => EVERYONE.to_owned(),
    }
}

// ── 內部工具 ──

/// Trip_Day 的日期 → 第幾天。
fn day_numbers(s: &TripState) -> BTreeMap<Date, usize> {
    trip_days(s)
        .into_iter()
        .map(|day| (day.date, day.n))
        .collect()
}

/// 車輛 → 在所有車輛中依 Ordinal 遞增排列的位置（第一台為 0）。
fn vehicle_positions(s: &TripState) -> BTreeMap<VehicleId, usize> {
    s.vehicles_by_ordinal()
        .enumerate()
        .map(|(k, vehicle)| (vehicle.id, k))
        .collect()
}

/// 路線的起點、終點或任一停靠點是 `place`。
fn route_uses(route: &Route, place: PlaceRef) -> bool {
    route.from == place || route.to == place || route.stops.iter().any(|stop| stop.place == place)
}

/// 這位旅伴是這台車的駕駛或乘客。
fn rides(vehicle: &Vehicle, person: PersonId) -> bool {
    vehicle.driver == Some(person) || vehicle.passengers.contains(&person)
}

/// `known` 的名字，再接 `unknown` 個 `placeholder`，以「、」連接。
fn names_with_unknown<'a>(
    known: impl Iterator<Item = &'a str>,
    unknown: usize,
    placeholder: &'a str,
) -> String {
    known
        .chain(std::iter::repeat_n(placeholder, unknown))
        .collect::<Vec<_>>()
        .join("、")
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;
    use crate::ids::{ActivityId, MealId, TripId};
    use crate::model::{
        Category, Color, CoverKind, DaySetting, ItemSource, Person, Place, RoutePosition, Row,
        ShoppingItem, TripCard, TripStatus,
    };

    fn at(hour: u8, minute: u8) -> Hm {
        Hm::new(hour, minute).expect("有效的時刻")
    }

    /// 旅行的第 n 天：2026-10-20（週二）是第 1 天。
    fn day(n: u64) -> Date {
        crate::time::ymd(2026, 10, 20).expect("有效的日期") + time::Duration::days(n as i64 - 1)
    }

    fn person_id(n: u64) -> PersonId {
        PersonId(Uuid::from_u128(0x1000 + u128::from(n)))
    }

    fn vehicle_id(n: u64) -> VehicleId {
        VehicleId(Uuid::from_u128(0x2000 + u128::from(n)))
    }

    fn place_id(n: u64) -> PlaceId {
        PlaceId(Uuid::from_u128(0x3000 + u128::from(n)))
    }

    fn route_id(n: u64) -> RouteId {
        RouteId(Uuid::from_u128(0x4000 + u128::from(n)))
    }

    fn stop_id(n: u64) -> StopId {
        StopId(Uuid::from_u128(0x5000 + u128::from(n)))
    }

    fn item_id(n: u64) -> ShoppingId {
        ShoppingId(Uuid::from_u128(0x6000 + u128::from(n)))
    }

    /// 第 1 天起 `days` 天、目的地為「夕淞度日營區」的旅行，還沒有其他列。
    fn trip(days: u64) -> TripState {
        TripState::new(TripCard {
            id: TripId(Uuid::from_u128(1)),
            title: "向山裡出發".to_owned(),
            destination: "夕淞度日營區".to_owned(),
            start: day(1),
            end: day(days),
            description: String::new(),
            note: String::new(),
            cover: CoverKind::Camp,
            status: TripStatus::Planning,
            version: 0,
            caption: String::new(),
            headline: String::new(),
        })
    }

    /// 第 n 位旅伴，Ordinal 也是 n。
    fn person(n: u64, name: &str) -> Row {
        Row::Person(Person {
            id: person_id(n),
            name: name.to_owned(),
            role: String::new(),
            color: Color::Coral,
            bound: false,
            ordinal: n,
            version: 1,
        })
    }

    /// 第 n 台車，Ordinal 是 `ordinal`，沒有設定顏色。
    fn vehicle(
        n: u64,
        ordinal: u64,
        name: &str,
        driver: Option<u64>,
        passengers: &[u64],
    ) -> Vehicle {
        Vehicle {
            id: vehicle_id(n),
            name: name.to_owned(),
            driver: driver.map(person_id),
            seats: 9,
            color: None,
            passengers: passengers.iter().copied().map(person_id).collect(),
            ordinal,
            version: 1,
        }
    }

    /// 地點清單中的第 n 個地點，Ordinal 也是 n。
    fn place(n: u64, name: &str) -> Row {
        Row::Place(Place {
            id: place_id(n),
            name: name.to_owned(),
            ordinal: n,
            version: 1,
            template: None,
        })
    }

    /// 第 n 個停靠點：沒有指定任務、沒有備註與時間。
    fn stop(n: u64, place: PlaceRef, kind: StopKind) -> Stop {
        Stop {
            id: stop_id(n),
            place,
            kind,
            task: None,
            note: String::new(),
            time: None,
            items: Vec::new(),
        }
    }

    /// 第 n 條路線，Ordinal 也是 n：從旅行目的地出發、回到旅行目的地，沒有出發時間。
    fn route(n: u64, on: Date, vehicle: u64, stops: Vec<Stop>) -> Route {
        Route {
            id: route_id(n),
            day: on,
            vehicle: vehicle_id(vehicle),
            from: PlaceRef::Destination,
            to: PlaceRef::Destination,
            depart: None,
            stops,
            ordinal: n,
            version: 1,
        }
    }

    /// 第 n 筆活動，Ordinal 也是 n：參加者為全體旅伴、未完成。
    fn activity(n: u64, on: Date, time: Hm, kind: ActivityKind, title: &str) -> Activity {
        Activity {
            id: ActivityId(Uuid::from_u128(0x7000 + u128::from(n))),
            day: on,
            time,
            title: title.to_owned(),
            kind,
            location: String::new(),
            note: String::new(),
            done: false,
            who: Participation::Everyone,
            ordinal: n,
            version: 1,
        }
    }

    /// 第 n 道料理，Ordinal 也是 n：沒有用餐時間、食材與插圖種類。
    fn meal(n: u64, on: Date, slot: MealSlot, title: &str) -> Meal {
        Meal {
            id: MealId(Uuid::from_u128(0x8000 + u128::from(n))),
            day: on,
            slot,
            time: None,
            title: title.to_owned(),
            cook: None,
            servings: 4,
            ingredients: String::new(),
            notes: String::new(),
            dish: None,
            ordinal: n,
            version: 1,
        }
    }

    /// 第 n 個採買品項，Ordinal 是 `ordinal`：未買的 Manual_Item。
    fn item(n: u64, ordinal: u64, name: &str, assignee: Option<u64>) -> ShoppingItem {
        ShoppingItem {
            id: item_id(n),
            name: name.to_owned(),
            quantity: "1 份".to_owned(),
            category: Category::Other,
            assignee: assignee.map(person_id),
            purchased: false,
            source: ItemSource::Manual,
            meal_ids: BTreeSet::new(),
            recipe_removed: None,
            ordinal,
            version: 1,
        }
    }

    fn setting(on: Date) -> DaySetting {
        DaySetting {
            day: on,
            title: None,
            place: None,
            arrival: None,
            route_position: RoutePosition::Before,
            version: 1,
            arrival_label: None,
        }
    }

    fn with(mut s: TripState, rows: impl IntoIterator<Item = Row>) -> TripState {
        for row in rows {
            s.put(row);
        }
        s
    }

    #[test]
    fn labels_and_defaults_follow_the_enum_table() {
        let categories: Vec<&str> = ActivityKind::ALL.iter().map(|kind| kind.label()).collect();
        assert_eq!(
            categories.join("、"),
            "集合、採買、營地時光、用餐、夜晚、移動、起床、搭帳、自由活動、下午茶／遊戲、拆帳、清潔、返程"
        );
        // 需求 22.8：每一種停靠點的名稱、預設任務與它的任務
        let kinds: Vec<(&str, &str, Vec<&str>)> = StopKind::ALL
            .iter()
            .map(|&kind| {
                (
                    kind.label(),
                    kind.default_task().label(),
                    kind.tasks().map(StopTask::label).collect(),
                )
            })
            .collect();
        assert_eq!(
            kinds,
            [
                ("採買", "採買", vec!["採買"]),
                ("接送", "接人", vec!["接人", "送人下車"]),
                ("取還裝備", "領取租借裝備", vec!["領取租借裝備", "歸還裝備"]),
                ("其他", "一般停靠", vec!["取租車", "還車", "一般停靠"]),
            ]
        );
        for &task in StopTask::ALL {
            assert!(task.kind().tasks().any(|other| other == task), "{task:?}");
        }
        // 沒有指定任務時用種類的預設任務，改變種類後改用新種類的預設任務
        let mut gear = stop(1, PlaceRef::Destination, StopKind::Gear);
        assert_eq!(stop_task(&gear), StopTask::GearPickup);
        gear.kind = StopKind::Other;
        assert_eq!(stop_task(&gear), StopTask::Waypoint);
        gear.task = Some(StopTask::CarReturn);
        assert_eq!(stop_task(&gear).label(), "還車");

        let times: Vec<String> = MealSlot::ALL
            .iter()
            .map(|slot| slot.default_time().to_string())
            .collect();
        assert_eq!(times, ["08:30", "12:00", "15:00", "18:00", "21:00"]);
        assert_eq!(
            CAR_PALETTE,
            [
                "#efa28f", "#b7dbe5", "#b9cda5", "#f6d27a", "#d6c8df", "#f2cbb0", "#9fc9c0",
                "#e3a6bd"
            ]
        );
    }

    #[test]
    fn presets_follow_requirement_23_2() {
        let lines = |kind| -> Vec<String> {
            presets_for(kind)
                .iter()
                .map(|p| format!("{} {}（{}）", p.time, p.title, p.kind.label()))
                .collect()
        };
        assert_eq!(
            lines(DayKind::First),
            [
                "13:00 搭帳・營地佈置（搭帳）",
                "20:00 星空夜聊・自由活動（夜晚）"
            ]
        );
        assert_eq!(
            lines(DayKind::Middle),
            [
                "08:00 起床（起床）",
                "10:00 自由活動、拍照（自由活動）",
                "14:00 下午茶、聊天、玩遊戲（下午茶／遊戲）",
                "20:00 自由活動（夜晚）"
            ]
        );
        assert_eq!(
            lines(DayKind::Last),
            [
                "08:00 起床（起床）",
                "10:00 拆帳、整理裝備（拆帳）",
                "11:30 環境清潔、裝車（清潔）",
                "12:00 集合、返程（返程）"
            ]
        );
        // 一日遊：第一天與最後一天的全部 6 項，依時間由早到晚
        assert_eq!(
            lines(DayKind::Single),
            [
                "08:00 起床（起床）",
                "10:00 拆帳、整理裝備（拆帳）",
                "11:30 環境清潔、裝車（清潔）",
                "12:00 集合、返程（返程）",
                "13:00 搭帳・營地佈置（搭帳）",
                "20:00 星空夜聊・自由活動（夜晚）"
            ]
        );
    }

    #[test]
    fn trip_days_are_numbered_from_one_with_their_kind() {
        let kinds = |days| -> Vec<(usize, DayKind)> {
            trip_days(&trip(days))
                .iter()
                .map(|day| (day.n, day.kind))
                .collect()
        };
        assert_eq!(kinds(1), [(1, DayKind::Single)]);
        assert_eq!(kinds(2), [(1, DayKind::First), (2, DayKind::Last)]);
        assert_eq!(
            kinds(4),
            [
                (1, DayKind::First),
                (2, DayKind::Middle),
                (3, DayKind::Middle),
                (4, DayKind::Last)
            ]
        );
        assert_eq!(trip_days(&trip(3))[2].date, day(3));
    }

    #[test]
    fn meal_time_title_and_category_follow_requirement_31_11() {
        let line = |meal: &Meal| {
            format!(
                "{} {}（{}）",
                meal_time(meal),
                meal_title(meal),
                meal_category(meal)
            )
        };
        // 需求 31.11 的例子
        assert_eq!(
            line(&meal(1, day(1), MealSlot::Lunch, "咖哩飯")),
            "12:00 午餐：咖哩飯（午餐）"
        );
        assert_eq!(
            line(&meal(2, day(1), MealSlot::Breakfast, "")),
            "08:30 早餐（早餐）"
        );
        assert_eq!(
            line(&meal(3, day(1), MealSlot::Dinner, "什錦火鍋")),
            "18:00 晚餐：什錦火鍋（火鍋）"
        );
        // 名稱與餐次相同、含換行與前後空白；設定的用餐時間
        assert_eq!(
            meal_title(&meal(4, day(1), MealSlot::Dinner, " 晚餐\n")),
            "晚餐"
        );
        let party = Meal {
            time: Some(at(19, 30)),
            ..meal(5, day(1), MealSlot::Dinner, "烤肉\n 派對")
        };
        assert_eq!(line(&party), "19:30 晚餐：烤肉 派對（烤肉）");
        // 插圖種類優先於餐次；其他插圖種類依餐次
        let category_of = |slot, kind| {
            meal_category(&Meal {
                dish: Some(kind),
                ..meal(6, day(1), slot, "週末小聚")
            })
        };
        assert_eq!(category_of(MealSlot::Breakfast, DishKind::Hotpot), "火鍋");
        assert_eq!(category_of(MealSlot::Lunch, DishKind::Bbq), "烤肉");
        assert_eq!(category_of(MealSlot::Dinner, DishKind::Toast), "早餐");
        assert_eq!(
            category_of(MealSlot::AfternoonTea, DishKind::Breakfast),
            "早餐"
        );
        assert_eq!(category_of(MealSlot::Breakfast, DishKind::Curry), "早餐");
        assert_eq!(category_of(MealSlot::Lunch, DishKind::Custom), "午餐");
        assert_eq!(category_of(MealSlot::LateNight, DishKind::Pasta), "用餐");
        assert_eq!(category_of(MealSlot::Dinner, DishKind::Salad), "用餐");
    }

    #[test]
    fn route_cards_sort_by_departure_then_vehicle_ordinal() {
        // 車輛的 Ordinal 與 id 的順序不同：依 Ordinal 是 v3、v5、v1、v4、v2
        let s = with(
            trip(2),
            [
                vehicle(1, 3, "第三車", None, &[]),
                vehicle(2, 5, "第五車", None, &[]),
                vehicle(3, 1, "第一車", None, &[]),
                vehicle(4, 4, "第四車", None, &[]),
                vehicle(5, 2, "第二車", None, &[]),
            ]
            .map(Row::Vehicle),
        );
        let depart = |route: Route, time| Route {
            depart: time,
            ..route
        };
        let s = with(
            s,
            [
                depart(route(1, day(1), 4, Vec::new()), None),
                depart(route(2, day(1), 1, Vec::new()), Some(at(9, 0))),
                depart(route(3, day(1), 3, Vec::new()), None),
                depart(route(4, day(1), 2, Vec::new()), Some(at(8, 0))),
                depart(route(5, day(1), 5, Vec::new()), Some(at(8, 0))),
                depart(route(6, day(2), 3, Vec::new()), Some(at(7, 0))),
            ]
            .map(Row::Route),
        );
        let ids = |routes: Vec<&Route>| -> Vec<RouteId> {
            routes.into_iter().map(|route| route.id).collect()
        };
        // 08:00 的兩條依車輛的 Ordinal（第二車在第五車之前）、09:00，最後是沒有出發時間的兩條（第一車、第四車）
        assert_eq!(
            ids(sorted_routes(&s, day(1))),
            [5, 4, 2, 3, 1].map(route_id)
        );
        // 文字版依建立順序
        assert_eq!(
            ids(day_routes_by_ordinal(&s, day(1)).collect()),
            [1, 2, 3, 4, 5].map(route_id)
        );
        assert_eq!(ids(sorted_routes(&s, day(2))), [route_id(6)]);
    }

    #[test]
    fn day_events_sort_by_time_with_activities_first_then_by_ordinal() {
        let s = with(
            trip(2),
            [
                activity(1, day(1), at(18, 0), ActivityKind::Night, "營火"),
                activity(2, day(1), at(12, 0), ActivityKind::Free, "散步"),
                activity(3, day(1), at(12, 0), ActivityKind::Meet, "集合"),
                activity(4, day(1), at(8, 0), ActivityKind::Wake, "起床"),
                activity(5, day(2), at(7, 0), ActivityKind::Wake, "第二天起床"),
            ]
            .map(Row::Activity)
            .into_iter()
            .chain(
                [
                    // 設定 12:00 的消夜排在預設 12:00 的午餐之前：同一時間的料理依 Ordinal，不依餐次
                    Meal {
                        time: Some(at(12, 0)),
                        ..meal(6, day(1), MealSlot::LateNight, "宵夜")
                    },
                    meal(7, day(1), MealSlot::Lunch, "咖哩飯"),
                    meal(8, day(1), MealSlot::Dinner, "火鍋"),
                    meal(9, day(2), MealSlot::Breakfast, ""),
                ]
                .map(Row::Meal),
            ),
        );
        let lines: Vec<String> = day_events(&s, day(1))
            .iter()
            .map(|event| match event {
                DayEvent::Activity(activity) => format!("{} {}", event.time(), activity.title),
                DayEvent::Meal(meal) => format!("{} {}・餐點", event.time(), meal_title(meal)),
            })
            .collect();
        assert_eq!(
            lines,
            [
                "08:00 起床",
                "12:00 散步",
                "12:00 集合",
                "12:00 消夜：宵夜・餐點",
                "12:00 午餐：咖哩飯・餐點",
                "18:00 營火",
                "18:00 晚餐：火鍋・餐點"
            ]
        );
        assert_eq!(day_events(&s, day(2)).len(), 2);
        assert!(day_events(&s, day(3)).is_empty());
    }

    /// 需求 22.14 與 Shopping_Plan 的每一種結果：
    /// - 阿哲是第一車的乘客，也是第二車的駕駛；第一車的 Ordinal 在前（id 在後），所以他的 Buyer_Car 是第一車。
    /// - 第三車・採買組在第 3 天與第 1 天都有採買；第 3 天的路線 Ordinal 在前，品項仍列在第 1 天路線上第一個
    ///   Shopping_Stop。
    fn shopping_trip() -> TripState {
        let s = with(
            trip(3),
            [
                person(1, "小安"),
                person(2, "阿哲"),
                person(3, "小雨"),
                person(4, "阿明"),
                place(1, "全聯"),
                place(2, "台中高鐵站"),
            ],
        );
        let s = with(
            s,
            [
                vehicle(1, 2, "第二車", Some(2), &[]),
                vehicle(2, 3, "第三車・採買組", None, &[3]),
                vehicle(3, 1, "第一車", Some(1), &[2]),
            ]
            .map(Row::Vehicle),
        );
        let shop = PlaceRef::Place(place_id(1));
        let station = PlaceRef::Place(place_id(2));
        let routes = [
            Route {
                ordinal: 1,
                ..route(4, day(3), 2, vec![stop(1, shop, StopKind::Shop)])
            },
            Route {
                ordinal: 2,
                ..route(
                    3,
                    day(1),
                    2,
                    vec![
                        stop(2, station, StopKind::Pickup),
                        stop(3, shop, StopKind::Shop),
                        stop(4, shop, StopKind::Shop),
                    ],
                )
            },
            route(5, day(2), 1, vec![stop(5, shop, StopKind::Shop)]),
            route(6, day(1), 3, vec![stop(6, station, StopKind::Pickup)]),
        ];
        let items = [
            item(1, 2, "五花肉片", Some(3)),
            item(2, 3, "鮮蝦", None),
            item(3, 4, "高麗菜", Some(4)),
            item(4, 5, "瓦斯", Some(1)),
            ShoppingItem {
                purchased: true,
                ..item(5, 1, "運動飲料", Some(3))
            },
            item(6, 6, "冰塊", Some(2)),
        ];
        with(with(s, routes.map(Row::Route)), items.map(Row::Shopping))
    }

    #[test]
    fn shopping_plan_assigns_items_to_the_first_shopping_stop_of_the_buyer_car() {
        let s = shopping_trip();
        let plan = shopping_plan(&s);
        assert_eq!(
            plan.buyer_car,
            BTreeMap::from([
                (person_id(1), vehicle_id(3)),
                (person_id(2), vehicle_id(3)),
                (person_id(3), vehicle_id(2)),
            ])
        );
        let first = FirstShoppingStop {
            vehicle: vehicle_id(2),
            route: route_id(3),
            stop: stop_id(3),
            day: day(1),
            n: 1,
            place: PlaceRef::Place(place_id(1)),
        };
        assert_eq!(
            plan.first_stop,
            BTreeMap::from([
                (
                    vehicle_id(1),
                    FirstShoppingStop {
                        vehicle: vehicle_id(1),
                        route: route_id(5),
                        stop: stop_id(5),
                        day: day(2),
                        n: 2,
                        place: PlaceRef::Place(place_id(1)),
                    }
                ),
                (vehicle_id(2), first),
            ])
        );
        // 依採買品項的 Ordinal，已買的也算；同一條路線後面的、其他天的與其他種類的停靠點沒有品項
        assert_eq!(plan.stop_items(stop_id(3)), [item_id(5), item_id(1)]);
        for other in [1, 2, 4, 5, 6] {
            assert!(plan.stop_items(stop_id(other)).is_empty(), "{other}");
        }
        assert_eq!(plan.stop_of(item_id(1)), Some(&first));
        assert_eq!(plan.stop_of(item_id(2)), None);
        // 需求 22.14 的三種原因
        let reasons: Vec<(ShoppingId, UnassignedCode, &str)> = plan
            .unassigned
            .iter()
            .map(|u| (u.item, u.code, u.reason.as_str()))
            .collect();
        assert_eq!(
            reasons,
            [
                (item_id(2), UnassignedCode::Unassigned, "待分配"),
                (item_id(3), UnassignedCode::NoCar, "阿明不在任何車上"),
                (item_id(4), UnassignedCode::NoStop, "第一車還沒有採買停靠點"),
                (item_id(6), UnassignedCode::NoStop, "第一車還沒有採買停靠點"),
            ]
        );
    }

    #[test]
    fn shopping_plan_follows_the_current_rows() {
        let mut s = shopping_trip();
        // 刪除第 1 天的路線：第三車・採買組改到第 3 天的 Shopping_Stop
        s.routes.remove(&route_id(3));
        let plan = shopping_plan(&s);
        assert_eq!(plan.stop_items(stop_id(1)), [item_id(5), item_id(1)]);
        assert_eq!(plan.stop_of(item_id(1)).map(|first| first.n), Some(3));
        // 第三車・採買組的 Shopping_Stop 都改成接送；車名改了，原因跟著改
        for route in s.routes.values_mut() {
            for stop in &mut route.stops {
                stop.kind = StopKind::Pickup;
            }
        }
        s.vehicles.get_mut(&vehicle_id(3)).expect("第一車").name = "小黃".to_owned();
        let plan = shopping_plan(&s);
        assert!(plan.first_stop.is_empty());
        let reasons: Vec<&str> = plan.unassigned.iter().map(|u| u.reason.as_str()).collect();
        assert_eq!(
            reasons,
            [
                "第三車・採買組還沒有採買停靠點",
                "第三車・採買組還沒有採買停靠點",
                "待分配",
                "阿明不在任何車上",
                "小黃還沒有採買停靠點",
                "小黃還沒有採買停靠點"
            ]
        );
    }

    #[test]
    fn day_place_is_the_day_setting_place_then_the_destination() {
        let s = with(
            trip(3),
            [
                place(1, "台北"),
                Row::DaySetting(DaySetting {
                    place: Some(place_id(1)),
                    arrival: Some(at(12, 0)),
                    ..setting(day(1))
                }),
                Row::DaySetting(DaySetting {
                    title: Some("向山裡出發".to_owned()),
                    ..setting(day(2))
                }),
            ],
        );
        assert_eq!(day_place(&s, day(1)), Some(PlaceRef::Place(place_id(1))));
        assert_eq!(day_place(&s, day(2)), Some(PlaceRef::Destination));
        assert_eq!(day_place(&s, day(3)), Some(PlaceRef::Destination));
        assert_eq!(place_name(&s, PlaceRef::Place(place_id(1))), "台北");
        assert_eq!(place_name(&s, PlaceRef::Destination), "夕淞度日營區");
        assert_eq!(place_name(&s, PlaceRef::Place(place_id(9))), "");
        // 需求 22.12：只取規劃者填寫的預計抵達時間
        assert_eq!(day_arrival(&s, day(1)), Some(at(12, 0)));
        assert_eq!(day_arrival(&s, day(2)), None);
        // 旅行目的地是空白時，沒有設定地點的日子沒有 Day_Place
        let mut blank = s.clone();
        blank.card.destination = String::new();
        assert_eq!(
            day_place(&blank, day(1)),
            Some(PlaceRef::Place(place_id(1)))
        );
        assert_eq!(day_place(&blank, day(2)), None);
    }

    #[test]
    fn place_usages_list_days_then_the_day_place_then_vehicles_by_ordinal() {
        let taipei = PlaceRef::Place(place_id(1));
        let s = with(
            trip(3),
            [
                place(1, "台北"),
                place(2, "新竹"),
                Row::DaySetting(DaySetting {
                    place: Some(place_id(1)),
                    ..setting(day(3))
                }),
            ],
        );
        let s = with(
            s,
            [
                vehicle(1, 2, "第二車", None, &[]),
                vehicle(2, 1, "第一車", None, &[]),
            ]
            .map(Row::Vehicle),
        );
        let s = with(
            s,
            [
                Route {
                    from: taipei,
                    ..route(1, day(1), 1, Vec::new())
                },
                // 起點與停靠點都是台北：同一天同一台車只算一個
                Route {
                    from: taipei,
                    ..route(2, day(3), 2, vec![stop(1, taipei, StopKind::Gear)])
                },
                Route {
                    to: taipei,
                    ..route(3, day(3), 1, Vec::new())
                },
            ]
            .map(Row::Route),
        );
        let usages = place_usages(&s, place_id(1));
        let pairs: Vec<(usize, &str)> = usages.iter().map(|u| (u.n, u.label.as_str())).collect();
        assert_eq!(
            pairs,
            [
                (1, "第二車"),
                (3, "這一天的地點"),
                (3, "第一車"),
                (3, "第二車")
            ]
        );
        assert_eq!(
            place_in_use_message(&usages),
            "這個地點還在使用中，請先把下列使用處改成其他地點。第 1 天：第二車；第 3 天：這一天的地點、第一車、第二車。"
        );
        // 需求 21.4 的例子
        let example =
            [(1, "第二車"), (3, "這一天的地點"), (3, "第一車")].map(|(n, label)| PlaceUsage {
                n,
                label: label.to_owned(),
            });
        assert_eq!(
            place_in_use_message(&example),
            "這個地點還在使用中，請先把下列使用處改成其他地點。第 1 天：第二車；第 3 天：這一天的地點、第一車。"
        );
        assert!(place_usages(&s, place_id(2)).is_empty());
    }

    #[test]
    fn place_name_errors_follow_the_order_of_requirement_21_1() {
        let s = with(trip(1), [place(1, "ＡＢＣ營地"), place(2, "超市／賣場")]);
        let error = |name: &str, except| place_name_error(&s, name, except);
        assert_eq!(error("", None), Some(PlaceNameError::Empty));
        assert_eq!(error(" \u{3000}\n", None), Some(PlaceNameError::Empty));
        // 超過 50 字先於控制字元
        let long = format!("{}\t安", "營".repeat(49));
        assert_eq!(error(long.as_str(), None), Some(PlaceNameError::TooLong));
        assert_eq!(error("營".repeat(50).as_str(), None), None);
        assert_eq!(
            error("台北\n車站", None),
            Some(PlaceNameError::ControlChars)
        );
        assert_eq!(
            error("小\u{200b}安", None),
            Some(PlaceNameError::ControlChars)
        );
        // 控制字元先於同名
        assert_eq!(
            error("ABC\u{200b}營地", None),
            Some(PlaceNameError::ControlChars)
        );
        // 同名：其他地點（全形半形、英文大小寫與前後空白都視為相同）與非空白的旅行目的地
        assert_eq!(error(" abc營地 ", None), Some(PlaceNameError::Duplicate));
        assert_eq!(
            error("超市/賣場", Some(place_id(1))),
            Some(PlaceNameError::Duplicate)
        );
        assert_eq!(error("夕淞度日營區", None), Some(PlaceNameError::Duplicate));
        // 改名時不與自己比較
        assert_eq!(error("abc營地", Some(place_id(1))), None);
        let mut blank = s.clone();
        blank.card.destination = String::new();
        assert_eq!(place_name_error(&blank, "夕淞度日營區", None), None);

        let messages: Vec<String> = [
            PlaceNameError::Empty,
            PlaceNameError::TooLong,
            PlaceNameError::ControlChars,
            PlaceNameError::Duplicate,
        ]
        .iter()
        .map(ToString::to_string)
        .collect();
        assert_eq!(
            messages,
            [
                "請填寫地點名稱。",
                "地點名稱最多 50 個字。",
                "地點名稱不能包含換行、Tab 或隱藏的控制字元。",
                "已有同名地點"
            ]
        );
    }

    #[test]
    fn destination_conflicts_follow_requirements_18_3_and_18_4() {
        let s = with(
            trip(3),
            [
                place(1, "台北"),
                place(2, "超市／賣場"),
                place(3, "出發地點 A"),
            ],
        );
        let duplicate = |name: &str| {
            Some(DestinationConflict::Duplicate {
                name: name.to_owned(),
            })
        };
        assert_eq!(destination_conflict(&s, "台北"), duplicate("台北"));
        assert_eq!(
            destination_conflict(&s, "超市/賣場"),
            duplicate("超市／賣場")
        );
        assert_eq!(
            destination_conflict(&s, "\u{3000}出發地點\u{3000}ａ "),
            duplicate("出發地點 A")
        );
        assert_eq!(
            duplicate("台北").map(|conflict| conflict.to_string()),
            Some("已有同名地點：台北。請先在「地點與車」把這個地點改名。".to_owned())
        );
        assert_eq!(destination_conflict(&s, "夕淞度日營區"), None);
        assert_eq!(destination_conflict(&s, "山中營地"), None);
        // 沒有路線使用旅行目的地時可以清空
        assert_eq!(destination_conflict(&s, ""), None);

        let taipei = PlaceRef::Place(place_id(1));
        let s = with(s, [Row::Vehicle(vehicle(1, 1, "第一車", None, &[]))]);
        let only_places = with(
            s.clone(),
            [Row::Route(Route {
                from: taipei,
                to: taipei,
                ..route(1, day(1), 1, vec![stop(1, taipei, StopKind::Shop)])
            })],
        );
        assert_eq!(destination_conflict(&only_places, ""), None);
        for uses in [
            Route {
                from: taipei,
                ..route(1, day(1), 1, Vec::new())
            },
            Route {
                to: taipei,
                ..route(1, day(1), 1, Vec::new())
            },
            Route {
                from: taipei,
                to: taipei,
                ..route(
                    1,
                    day(1),
                    1,
                    vec![stop(1, PlaceRef::Destination, StopKind::Gear)],
                )
            },
        ] {
            let s = with(s.clone(), [Row::Route(uses)]);
            assert_eq!(
                destination_conflict(&s, ""),
                Some(DestinationConflict::InUse)
            );
            assert_eq!(
                destination_conflict(&s, " \u{3000}"),
                Some(DestinationConflict::InUse)
            );
        }
        assert_eq!(
            DestinationConflict::InUse.to_string(),
            "仍有路線或停靠點使用旅行目的地，不能把目的地清空。"
        );
    }

    #[test]
    fn vehicle_colors_follow_the_ordinal_position() {
        // 9 台車，Ordinal 與 id 的順序相反；依 Ordinal 第 2 台（k = 1）設定了顏色
        let mut s = with(
            trip(1),
            (1..=9).map(|n| Row::Vehicle(vehicle(n, 10 - n, "車", None, &[]))),
        );
        s.vehicles.get_mut(&vehicle_id(8)).expect("第 2 台").color = Some("#123abc".to_owned());
        let colors: Vec<&str> = (1..=9)
            .rev()
            .map(|n| vehicle_color(&s, vehicle_id(n)).expect("這趟旅行的車"))
            .collect();
        assert_eq!(
            colors,
            [
                "#efa28f", "#123abc", "#b9cda5", "#f6d27a", "#d6c8df", "#f2cbb0", "#9fc9c0",
                "#e3a6bd", "#efa28f"
            ]
        );
        assert_eq!(vehicle_color(&s, vehicle_id(10)), None);
        // 刪除第一台之後依新的位置重新計算
        s.vehicles.remove(&vehicle_id(9));
        assert_eq!(vehicle_color(&s, vehicle_id(7)), Some("#b7dbe5"));
        assert_eq!(car_palette_color(17), "#b7dbe5");
    }

    #[test]
    fn person_activities_and_the_next_unfinished_one() {
        let s = with(
            trip(2),
            [
                person(1, "小安"),
                person(2, "阿哲"),
                person(3, "小雨"),
                Row::Vehicle(vehicle(1, 2, "第二車", None, &[])),
                Row::Vehicle(vehicle(2, 1, "第一車", Some(1), &[2])),
            ],
        );
        let joined_by = |activity: Activity, who| Activity { who, ..activity };
        let s = with(
            s,
            [
                Activity {
                    done: true,
                    ..activity(1, day(1), at(7, 0), ActivityKind::Wake, "起床")
                },
                joined_by(
                    activity(2, day(1), at(9, 0), ActivityKind::Meet, "集合"),
                    Participation::Vehicles(BTreeSet::from([vehicle_id(2)])),
                ),
                activity(3, day(1), at(9, 0), ActivityKind::Market, "採買"),
                joined_by(
                    activity(4, day(1), at(8, 0), ActivityKind::Travel, "接人"),
                    Participation::People(BTreeSet::from([person_id(3)])),
                ),
                joined_by(
                    activity(5, day(2), at(6, 0), ActivityKind::Return, "返程"),
                    Participation::Vehicles(BTreeSet::from([vehicle_id(1)])),
                ),
            ]
            .map(Row::Activity),
        );
        let activity_of =
            |n: u64| &s.activities[&ActivityId(Uuid::from_u128(0x7000 + u128::from(n)))];
        // 指定車輛：第一車的駕駛與乘客；指定旅伴：只有小雨
        let joins = |n, person| is_person_activity(&s, activity_of(n), person_id(person));
        assert!(joins(2, 1) && joins(2, 2) && !joins(2, 3));
        assert!(joins(4, 3) && !joins(4, 1));
        assert!(!joins(5, 1) && !joins(5, 2) && !joins(5, 3));
        assert!(joins(1, 3) && joins(3, 3));
        // 依日期、時間與 Ordinal；已完成的不算
        let next =
            |person| next_activity(&s, person_id(person)).map(|activity| activity.title.as_str());
        assert_eq!(next(1), Some("集合"));
        assert_eq!(next(3), Some("接人"));
        let mut done = s.clone();
        for activity in done.activities.values_mut() {
            activity.done = true;
        }
        assert_eq!(next_activity(&done, person_id(1)), None);

        // 參加者
        let label = |who| {
            participant_label(
                &s,
                &Activity {
                    who,
                    ..activity(9, day(1), at(9, 0), ActivityKind::Camp, "營地時光")
                },
            )
        };
        assert_eq!(label(Participation::Everyone), "全體旅伴");
        assert_eq!(
            label(Participation::People(BTreeSet::from([
                person_id(3),
                person_id(2),
                person_id(1)
            ]))),
            "全體旅伴"
        );
        assert_eq!(
            label(Participation::People(BTreeSet::from([
                person_id(3),
                person_id(1)
            ]))),
            "小安、小雨"
        );
        assert_eq!(
            label(Participation::People(BTreeSet::from([
                person_id(9),
                person_id(2)
            ]))),
            "阿哲、旅伴待確認"
        );
        assert_eq!(
            label(Participation::Vehicles(BTreeSet::from([
                vehicle_id(1),
                vehicle_id(2)
            ]))),
            "第一車、第二車"
        );
    }
}
