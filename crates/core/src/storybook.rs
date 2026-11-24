//! 旅行繪本工作室（Schedule_Tab）顯示的行程（Studio_Plan）。
//!
//! 移植自 `src/storybook-adapter.js` 的 `project()`、`src/storybook/model.js` 的 `KINDS`、`ACTIVITY_KINDS`、`MEAL_KINDS`、
//! `STOP_KINDS` 與活動排序（`validateDay()`），以及 `src/storybook/journal.js` 的返程日規則。[`studio_plan`] 只讀取
//! Trip_State，不修改它；工作室的每一次編輯另以 Command 送出（`lm-web` 的 `views::studio`）。
//!
//! 與現行的對應：現行以字串 id（`p-…`、`dest`）指稱地點與車輛，這裡直接使用 [`PlaceRef`] 與各列的 id；旅行目的地不是
//! 空白時是 `PlaceRef::Destination`。現行陣列的順序在這裡是 Ordinal（`TripState` 的 `*_by_ordinal()`）。

use crate::ids::{ActivityId, MealId, RouteId, StopId, VehicleId};
use crate::itinerary::{
    day_place, day_routes_by_ordinal, meal_time, meal_title, shopping_plan, stop_task,
    UnassignedCode, CAR_PALETTE,
};
use crate::model::{
    ActivityKind, Date, DishKind, Meal, MealSlot, PlaceRef, PlaceTemplate, RoutePosition, StopKind,
    StopTask, TripState,
};
use crate::recipes::infer_dish_kind;
use crate::text::{clean_text, trim_white};
use crate::time::{date_range, Hm};

/// 採買停靠點最多列出的品項數；超過時列出前 [`SHOP_ITEMS_SHOWN`] 項與「等另外 N 項」（現行 `derivedItems()`）。
pub const SHOP_ITEMS_MAX: usize = 8;
/// 超過 [`SHOP_ITEMS_MAX`] 項時列出的品項數。
pub const SHOP_ITEMS_SHOWN: usize = 7;
/// 採買停靠點的每個品項名稱最多顯示的字數。
pub const SHOP_ITEM_CHARS: usize = 100;

/// 工作室的活動種類（現行 `KINDS` 的 18 種），依現行的宣告順序。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum StudioKind {
    Setup,
    Bbq,
    Night,
    Sunrise,
    Breakfast,
    Explore,
    Noodles,
    Games,
    Hotpot,
    Pack,
    Cleanup,
    Depart,
    Activity,
    Meet,
    Market,
    Camp,
    Travel,
    Meal,
}

impl StudioKind {
    /// 每一種，依現行 `KINDS` 的順序。
    pub const ALL: [StudioKind; 18] = [
        StudioKind::Setup,
        StudioKind::Bbq,
        StudioKind::Night,
        StudioKind::Sunrise,
        StudioKind::Breakfast,
        StudioKind::Explore,
        StudioKind::Noodles,
        StudioKind::Games,
        StudioKind::Hotpot,
        StudioKind::Pack,
        StudioKind::Cleanup,
        StudioKind::Depart,
        StudioKind::Activity,
        StudioKind::Meet,
        StudioKind::Market,
        StudioKind::Camp,
        StudioKind::Travel,
        StudioKind::Meal,
    ];

    /// 與網站活動類別一一對應的種類（現行 `ACTIVITY_KINDS`），也是活動的類別選單的順序。
    pub const ACTIVITY_KINDS: [StudioKind; 13] = [
        StudioKind::Meet,
        StudioKind::Market,
        StudioKind::Camp,
        StudioKind::Meal,
        StudioKind::Night,
        StudioKind::Travel,
        StudioKind::Sunrise,
        StudioKind::Setup,
        StudioKind::Explore,
        StudioKind::Games,
        StudioKind::Pack,
        StudioKind::Cleanup,
        StudioKind::Depart,
    ];

    /// 料理顯示的種類（現行 `MEAL_KINDS`）。
    pub const MEAL_KINDS: [StudioKind; 5] = [
        StudioKind::Hotpot,
        StudioKind::Bbq,
        StudioKind::Breakfast,
        StudioKind::Noodles,
        StudioKind::Meal,
    ];

    /// 現行的字串，例如 sunrise。
    pub const fn as_str(self) -> &'static str {
        match self {
            StudioKind::Setup => "setup",
            StudioKind::Bbq => "bbq",
            StudioKind::Night => "night",
            StudioKind::Sunrise => "sunrise",
            StudioKind::Breakfast => "breakfast",
            StudioKind::Explore => "explore",
            StudioKind::Noodles => "noodles",
            StudioKind::Games => "games",
            StudioKind::Hotpot => "hotpot",
            StudioKind::Pack => "pack",
            StudioKind::Cleanup => "cleanup",
            StudioKind::Depart => "depart",
            StudioKind::Activity => "activity",
            StudioKind::Meet => "meet",
            StudioKind::Market => "market",
            StudioKind::Camp => "camp",
            StudioKind::Travel => "travel",
            StudioKind::Meal => "meal",
        }
    }

    /// 中文名稱（現行 `KINDS`），例如 sunrise 為「起床」。
    pub const fn label(self) -> &'static str {
        match self {
            StudioKind::Setup => "搭帳",
            StudioKind::Bbq => "烤肉",
            StudioKind::Night => "夜晚",
            StudioKind::Sunrise => "起床",
            StudioKind::Breakfast => "早餐",
            StudioKind::Explore => "自由活動",
            StudioKind::Noodles => "午餐",
            StudioKind::Games => "下午茶／遊戲",
            StudioKind::Hotpot => "火鍋",
            StudioKind::Pack => "拆帳",
            StudioKind::Cleanup => "清潔",
            StudioKind::Depart => "返程",
            StudioKind::Activity => "其他活動",
            StudioKind::Meet => "集合",
            StudioKind::Market => "採買",
            StudioKind::Camp => "營地時光",
            StudioKind::Travel => "移動",
            StudioKind::Meal => "用餐",
        }
    }

    /// `as_str()` 的反向；不是工作室種類的字串時是 `None`。
    pub fn parse(text: &str) -> Option<StudioKind> {
        StudioKind::ALL
            .into_iter()
            .find(|kind| kind.as_str() == text)
    }

    /// 網站活動類別顯示的種類（現行 `TYPE_TO_KIND`）：wake 為 sunrise、pitch 為 setup、free 為 explore、tea 為 games、
    /// strike 為 pack、clean 為 cleanup、return 為 depart，其他同名。
    pub const fn from_activity(kind: ActivityKind) -> StudioKind {
        match kind {
            ActivityKind::Meet => StudioKind::Meet,
            ActivityKind::Market => StudioKind::Market,
            ActivityKind::Camp => StudioKind::Camp,
            ActivityKind::Meal => StudioKind::Meal,
            ActivityKind::Night => StudioKind::Night,
            ActivityKind::Travel => StudioKind::Travel,
            ActivityKind::Wake => StudioKind::Sunrise,
            ActivityKind::Pitch => StudioKind::Setup,
            ActivityKind::Free => StudioKind::Explore,
            ActivityKind::Tea => StudioKind::Games,
            ActivityKind::Strike => StudioKind::Pack,
            ActivityKind::Clean => StudioKind::Cleanup,
            ActivityKind::Return => StudioKind::Depart,
        }
    }

    /// 選了這個種類的活動儲存的網站活動類別（現行 `KIND_TO_TYPE`）：`from_activity()` 的反向，另外 bbq、breakfast、
    /// noodles 與 hotpot 為 meal，activity 為 camp。
    pub const fn to_activity(self) -> ActivityKind {
        match self {
            StudioKind::Meet => ActivityKind::Meet,
            StudioKind::Market => ActivityKind::Market,
            StudioKind::Camp | StudioKind::Activity => ActivityKind::Camp,
            StudioKind::Meal
            | StudioKind::Bbq
            | StudioKind::Breakfast
            | StudioKind::Noodles
            | StudioKind::Hotpot => ActivityKind::Meal,
            StudioKind::Night => ActivityKind::Night,
            StudioKind::Travel => ActivityKind::Travel,
            StudioKind::Sunrise => ActivityKind::Wake,
            StudioKind::Setup => ActivityKind::Pitch,
            StudioKind::Explore => ActivityKind::Free,
            StudioKind::Games => ActivityKind::Tea,
            StudioKind::Pack => ActivityKind::Strike,
            StudioKind::Cleanup => ActivityKind::Clean,
            StudioKind::Depart => ActivityKind::Return,
        }
    }

    /// 料理顯示的種類（現行 `mealKind()`）：插圖種類（沒有設定時依 `infer_dish_kind()` 推斷）為 hotpot 或 bbq 時是同名的
    /// 種類、為 breakfast 或 toast 時是 breakfast；否則餐次為早餐時是 breakfast、為午餐時是 noodles，其他是 meal。
    pub fn of_meal(meal: &Meal) -> StudioKind {
        match infer_dish_kind(meal) {
            DishKind::Hotpot => StudioKind::Hotpot,
            DishKind::Bbq => StudioKind::Bbq,
            DishKind::Breakfast | DishKind::Toast => StudioKind::Breakfast,
            _ => match meal.slot {
                MealSlot::Breakfast => StudioKind::Breakfast,
                MealSlot::Lunch => StudioKind::Noodles,
                _ => StudioKind::Meal,
            },
        }
    }
}

/// 工作室停靠點類型的順序（現行 `STOP_KINDS`）；名稱是 `StopTask::label()`，例如「領取租借裝備」。
pub const STUDIO_STOP_KINDS: [StopTask; 8] = [
    StopTask::Shopping,
    StopTask::GearPickup,
    StopTask::GearReturn,
    StopTask::PassengerPickup,
    StopTask::PassengerDropoff,
    StopTask::CarRental,
    StopTask::CarReturn,
    StopTask::Waypoint,
];

/// 工作室的停靠點類型儲存成的停靠點種類與任務（現行 `STOP_TASK_KINDS`）：任務屬於它的種類；任務是種類的預設任務時，
/// 現行不寫入 `taskKind`，由呼叫端決定是否寫入。
pub const fn stop_task_parts(task: StopTask) -> (StopKind, StopTask) {
    (task.kind(), task)
}

/// 地點名稱推測的插圖（現行 `TEMPLATE_GUESSES`，不分英文大小寫）：只用於顯示，插圖在使用者選擇之後才儲存。
pub fn guess_template(name: &str) -> PlaceTemplate {
    let lower = name.to_lowercase();
    let any = |words: &[&str]| words.iter().any(|word| lower.contains(word));
    if any(&["711", "7-11", "7-eleven", "統一超商"]) {
        PlaceTemplate::SevenEleven
    } else if any(&["全家", "familymart"]) {
        PlaceTemplate::FamilyMart
    } else if any(&["ok mart", "okmart", "ok超商"]) {
        PlaceTemplate::OkMart
    } else if any(&["全聯"]) {
        PlaceTemplate::PxmartMega
    } else if any(&["costco", "好市多"]) {
        PlaceTemplate::Costco
    } else if any(&["ikea"]) {
        PlaceTemplate::Ikea
    } else if any(&["家樂福", "carrefour"]) {
        PlaceTemplate::Carrefour
    } else if any(&["超市", "賣場", "市場", "超商", "商店", "market", "mart"]) {
        PlaceTemplate::Market
    } else if any(&["小木屋", "cabin"]) {
        PlaceTemplate::Cabin
    } else if any(&["露營車", "camper"]) {
        PlaceTemplate::Camper
    } else if any(&["營", "camp"]) {
        PlaceTemplate::Tent
    } else {
        PlaceTemplate::Home
    }
}

/// 工作室顯示的行程（現行 `toStudio()` 的結果）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StudioPlan {
    /// 旅行名稱（儲存的值）。
    pub title: String,
    /// 繪本的大標題；空字串是未設定。
    pub headline: String,
    /// 繪本的底部短語；空字串是未設定。
    pub caption: String,
    /// 旅行目的地不是空白時先列 Destination_Place，再依 Ordinal 列出地點清單。
    pub places: Vec<StudioPlace>,
    /// 依 Ordinal。
    pub vehicles: Vec<StudioVehicle>,
    /// 未分配採買清單：負責人為待分配的採買品項名稱（`clean_text()` 之後），依 Ordinal。
    pub shopping: Vec<String>,
    /// 旅行的每一天，依日期遞增。
    pub days: Vec<StudioDay>,
}

/// 工作室的地點。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StudioPlace {
    pub place: PlaceRef,
    /// 儲存的名稱；Destination_Place 是旅行目的地。
    pub name: String,
    /// 儲存的插圖，沒有時依名稱推測；Destination_Place 是經典帳篷。
    pub template: PlaceTemplate,
}

/// 工作室的車輛。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StudioVehicle {
    pub id: VehicleId,
    pub name: String,
    /// 設定的顏色，沒有時是 Car_Palette 中依車輛位置取的顏色。
    pub color: String,
}

/// 工作室的一天。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StudioDay {
    pub date: Date,
    /// 每日設定的標題；沒有時是空字串。
    pub title: String,
    /// Day_Place：每日設定的地點，沒有時是非空白的旅行目的地。
    pub location: Option<PlaceRef>,
    pub route_position: RoutePosition,
    /// 每日設定的抵達說明；沒有時是空字串。
    pub arrival_label: String,
    /// 這一天的路線，依 Ordinal。
    pub routes: Vec<StudioRoute>,
    /// 活動與料理，依時間排序；時間相同時活動（依 Ordinal）在料理（依 Ordinal）之前。
    pub events: Vec<StudioEvent>,
}

/// 工作室的路線。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StudioRoute {
    pub id: RouteId,
    pub vehicle: VehicleId,
    pub from: PlaceRef,
    pub to: PlaceRef,
    pub departure: Option<Hm>,
    pub stops: Vec<StudioStop>,
}

/// 工作室的停靠點。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StudioStop {
    pub id: StopId,
    pub place: PlaceRef,
    /// 停靠點的任務；沒有指定時是種類的預設任務。
    pub kind: StopTask,
    pub time: Option<Hm>,
    /// 採買的停靠點是分到它的採買品項名稱（超過 8 項時是前 7 項與「等另外 N 項」）；其他是停靠點的待辦清單。
    pub items: Vec<String>,
    pub note: String,
}

/// 活動或料理。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EventSource {
    Activity(ActivityId),
    Meal(MealId),
}

/// 工作室的活動（料理也是一個活動，標示「餐點」）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StudioEvent {
    pub source: EventSource,
    /// 活動的時間；料理是 `meal_time()`。
    pub time: Hm,
    /// 活動的標題；料理是 `meal_title()`。
    pub title: String,
    pub kind: StudioKind,
    /// 活動的備註；料理的筆記。
    pub notes: String,
}

impl StudioEvent {
    /// 料理（Bun `isMealEvent()`）。
    pub fn is_meal(&self) -> bool {
        matches!(self.source, EventSource::Meal(_))
    }
}

/// 採買停靠點列出的品項（現行 `derivedItems()`）：名稱經 `clean_text()`，略過空的，每項最多 100 字；超過 8 項時是
/// 前 7 項與「等另外 N 項」。
fn derived_items(names: impl Iterator<Item = String>) -> Vec<String> {
    let names: Vec<String> = names
        .filter(|name| !name.is_empty())
        .map(|name| name.chars().take(SHOP_ITEM_CHARS).collect())
        .collect();
    if names.len() > SHOP_ITEMS_MAX {
        let rest = names.len() - SHOP_ITEMS_SHOWN;
        let mut shown: Vec<String> = names.into_iter().take(SHOP_ITEMS_SHOWN).collect();
        shown.push(format!("等另外 {rest} 項"));
        shown
    } else {
        names
    }
}

/// 現行 `project()`：Trip_State 在工作室中顯示的行程。
pub fn studio_plan(s: &TripState) -> StudioPlan {
    let destination = !trim_white(&s.card.destination).is_empty();
    let plan = shopping_plan(s);
    let item_name = |id| {
        s.shopping
            .get(id)
            .map(|item| clean_text(&item.name))
            .unwrap_or_default()
    };

    let mut places = Vec::with_capacity(s.places.len() + 1);
    if destination {
        places.push(StudioPlace {
            place: PlaceRef::Destination,
            name: s.card.destination.clone(),
            template: PlaceTemplate::Tent,
        });
    }
    places.extend(s.places_by_ordinal().map(|place| {
        StudioPlace {
            place: PlaceRef::Place(place.id),
            name: place.name.clone(),
            template: place
                .template
                .unwrap_or_else(|| guess_template(&place.name)),
        }
    }));

    let vehicles = s
        .vehicles_by_ordinal()
        .enumerate()
        .map(|(i, vehicle)| StudioVehicle {
            id: vehicle.id,
            name: vehicle.name.clone(),
            color: vehicle
                .color
                .clone()
                .unwrap_or_else(|| CAR_PALETTE[i % CAR_PALETTE.len()].to_owned()),
        })
        .collect();

    let days = date_range(s.card.start, s.card.end)
        .into_iter()
        .map(|date| {
            let setting = s.day_settings.get(&date);
            let mut events: Vec<StudioEvent> = s
                .activities_by_ordinal()
                .filter(|activity| activity.day == date)
                .map(|activity| StudioEvent {
                    source: EventSource::Activity(activity.id),
                    time: activity.time,
                    title: activity.title.clone(),
                    kind: StudioKind::from_activity(activity.kind),
                    notes: activity.note.clone(),
                })
                .chain(
                    s.meals_by_ordinal()
                        .filter(|meal| meal.day == date)
                        .map(|meal| StudioEvent {
                            source: EventSource::Meal(meal.id),
                            time: meal_time(meal),
                            title: meal_title(meal),
                            kind: StudioKind::of_meal(meal),
                            notes: meal.notes.clone(),
                        }),
                )
                .collect();
            // 穩定排序：時間相同時保持活動在前、料理在後
            events.sort_by_key(|event| event.time);
            let routes = day_routes_by_ordinal(s, date)
                .map(|route| StudioRoute {
                    id: route.id,
                    vehicle: route.vehicle,
                    from: route.from,
                    to: route.to,
                    departure: route.depart,
                    stops: route
                        .stops
                        .iter()
                        .map(|stop| StudioStop {
                            id: stop.id,
                            place: stop.place,
                            kind: stop_task(stop),
                            time: stop.time,
                            items: if stop.kind == StopKind::Shop {
                                derived_items(plan.stop_items(stop.id).iter().map(item_name))
                            } else {
                                stop.items.clone()
                            },
                            note: stop.note.clone(),
                        })
                        .collect(),
                })
                .collect();
            StudioDay {
                date,
                title: setting
                    .and_then(|setting| setting.title.clone())
                    .unwrap_or_default(),
                location: day_place(s, date),
                route_position: setting
                    .map(|setting| setting.route_position)
                    .unwrap_or_default(),
                arrival_label: setting
                    .and_then(|setting| setting.arrival_label.clone())
                    .unwrap_or_default(),
                routes,
                events,
            }
        })
        .collect();

    StudioPlan {
        title: s.card.title.clone(),
        headline: s.card.headline.clone(),
        caption: s.card.caption.clone(),
        places,
        vehicles,
        shopping: plan
            .unassigned
            .iter()
            .filter(|unassigned| unassigned.code == UnassignedCode::Unassigned)
            .map(|unassigned| item_name(&unassigned.item))
            .collect(),
        days,
    }
}

/// 現行 `journal.js` 的返程日：路線設在活動之後，或第 2 天以後的最後一天有路線、有地點，而且每條路線都從這一天的
/// 地點出發。返程日的路線欄是「回程路線」，排在「收帳與返程」之後。
pub fn is_return_day(plan: &StudioPlan, index: usize) -> bool {
    let Some(day) = plan.days.get(index) else {
        return false;
    };
    if day.route_position == RoutePosition::After {
        return true;
    }
    index + 1 == plan.days.len()
        && index > 0
        && !day.routes.is_empty()
        && day
            .location
            .is_some_and(|location| day.routes.iter().all(|route| route.from == location))
}
