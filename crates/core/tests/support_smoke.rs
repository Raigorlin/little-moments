//! 共用產生器的煙霧測試（任務 5.5）：`support` 能編譯；`arb_state()` 產生的每個 Trip_State 都滿足它保證的不變式
//! （I1–I8、I10–I12）與欄位範圍；採買同步照常執行，`SeqIds` 回傳的 id 都是新的；取樣的狀態涵蓋屬性測試需要的情況，
//! 例如連結未買 Meal_Item 的支出、出發確認、使用旅行目的地的路線，以及食材文字中的各種分隔符號與空白。
//!
//! 不變式在這裡依需求 9.2–9.13 的寫法另外檢查一次，不沿用產生器建構時的推論；`validate::state()`（任務 8.5）完成之後，
//! 屬性測試以它檢查。

mod support;

use std::collections::{BTreeMap, HashSet};
use std::ops::RangeInclusive;

use lm_core::ids::{PersonId, StopId, VehicleId};
use lm_core::ingredients::{
    check_ingredient_names, ingredient_key, parse_ingredients, sync_meal_ingredients, SyncPlan,
};
use lm_core::limits;
use lm_core::model::{
    Date, GearScope, ItemSource, Participation, PlaceRef, Route, RoutePosition, RowKey, StopKind,
    StopTask, TripState,
};
use lm_core::text::{
    char_count, has_control_chars, participant_key, participant_name, place_key, trim_white,
};
use lm_core::time::date_range;
use proptest::prelude::*;
use proptest::strategy::ValueTree;
use proptest::test_runner::{TestCaseError, TestRunner};

use support::ids::{has_tag, SeqIds, Tag};
use support::state::{arb_state, MAX_DAYS};

proptest! {
    /// 每個狀態都滿足 I1–I8、I10–I12，每個欄位都是會被儲存的值；採買同步不超過上限，`SeqIds` 回傳的 id 都是新的。
    #[test]
    fn generated_states_keep_the_invariants_they_promise(state in arb_state()) {
        check_invariants(&state)?;
        check_fields(&state)?;

        let mut ids = SeqIds::new();
        let plan = sync_meal_ingredients(&state, &mut ids)
            .map_err(|error| TestCaseError::fail(format!("採買同步失敗：{error}")))?;
        prop_assert_eq!(ids.taken(), plan.created.len() as u64);
        for created in &plan.created {
            prop_assert!(has_tag(created.0, Tag::NewShopping) && !state.shopping.contains_key(created));
        }
    }
}

/// 以固定的種子取樣的個數；每次執行都取到相同的狀態。
const SAMPLES: usize = 256;

/// 一種要涵蓋的情況：名稱，以及狀態是不是這種情況。
type Case = (&'static str, fn(&TripState) -> bool);

/// 食材文字中要出現的一類字元：名稱，以及字元是不是這一類。
type CharClass = (&'static str, fn(char) -> bool);

/// 以固定的種子取樣 `SAMPLES` 個狀態，下列每一種情況至少出現一次，屬性測試才會測到它們。
#[test]
fn sampled_states_cover_the_cases_the_properties_need() {
    let cases: &[Case] = &[
        ("一日遊", |s| trip_days(s) == 1),
        ("5 天的旅行", |s| trip_days(s) == MAX_DAYS),
        ("沒有旅伴", |s| s.people.is_empty()),
        ("6 位旅伴，綁定與沒有綁定帳號的都有", |s| {
            s.people.len() == 6
                && s.people.values().any(|person| person.bound)
                && s.people.values().any(|person| !person.bound)
        }),
        ("坐滿乘客的車", |s| {
            s.vehicles.values().any(|vehicle| {
                !vehicle.passengers.is_empty()
                    && vehicle.passengers.len() + 1 == usize::from(vehicle.seats)
            })
        }),
        ("沒有駕駛的車", |s| {
            s.vehicles.values().any(|vehicle| vehicle.driver.is_none())
        }),
        ("使用旅行目的地的路線", |s| {
            s.routes.values().any(uses_destination)
        }),
        ("旅行目的地是空白，而且有路線", |s| {
            trim_white(&s.card.destination).is_empty() && !s.routes.is_empty()
        }),
        ("有 6 個停靠點的路線", |s| {
            s.routes.values().any(|route| route.stops.len() == 6)
        }),
        ("沒有出發時間的路線", |s| {
            s.routes.values().any(|route| route.depart.is_none())
        }),
        ("路線在活動之後的每日設定", |s| {
            s.day_settings
                .values()
                .any(|setting| setting.route_position == RoutePosition::After)
        }),
        ("指定旅伴的活動", |s| {
            s.activities
                .values()
                .any(|activity| matches!(activity.who, Participation::People(_)))
        }),
        ("指定車輛的活動", |s| {
            s.activities
                .values()
                .any(|activity| matches!(activity.who, Participation::Vehicles(_)))
        }),
        ("空的食材文字", |s| {
            s.meals.values().any(|meal| meal.ingredients.is_empty())
        }),
        (
            "同一個 Ingredient_Key 的不同寫法",
            has_key_spelled_differently,
        ),
        ("兩道料理需要同一個食材", needed_by_two_meals),
        (
            "手動與料理產生、已買與未買的品項都有",
            |s| {
                let items = || s.shopping.values();
                items().any(|item| item.source == ItemSource::Manual)
                    && items().any(|item| item.source == ItemSource::Meal)
                    && items().any(|item| item.purchased)
                    && items().any(|item| !item.purchased)
            },
        ),
        ("標記「料理已移除」的品項", |s| {
            s.shopping
                .values()
                .any(|item| item.recipe_removed == Some(true))
        }),
        ("名稱含兩個食材的品項", |s| {
            s.shopping
                .values()
                .any(|item| parse_ingredients(&item.name).len() >= 2)
        }),
        ("連結未買 Meal_Item 的支出", |s| {
            s.expenses.values().any(|expense| {
                expense
                    .shopping_item
                    .and_then(|id| s.shopping.get(&id))
                    .is_some_and(|item| item.source == ItemSource::Meal && !item.purchased)
            })
        }),
        ("日期在旅行範圍外的支出", |s| {
            s.expenses
                .values()
                .any(|expense| expense.day < s.card.start || expense.day > s.card.end)
        }),
        ("還款", |s| !s.settlements.is_empty()),
        ("出發確認", |s| !s.departures.is_empty()),
        ("待分配的共用裝備", |s| {
            s.gear
                .values()
                .any(|item| item.scope == GearScope::Shared && item.assignee.is_none())
        }),
        ("已打包的共用裝備", |s| {
            s.gear
                .values()
                .any(|item| item.scope == GearScope::Shared && !item.packed_by.is_empty())
        }),
        ("採買同步新增品項", |s| !sync(s).created.is_empty()),
        ("採買同步刪除品項", |s| !sync(s).deletes.is_empty()),
        ("採買同步清除支出的採買連結", |s| {
            !sync(s).unlinked_expenses.is_empty()
        }),
        (
            "採買同步把已買的 Meal_Item 改為 Manual_Item",
            |s| {
                sync(s).upserts.iter().any(|item| {
                    item.source == ItemSource::Manual
                        && s.shopping
                            .get(&item.id)
                            .is_some_and(|before| before.source == ItemSource::Meal)
                })
            },
        ),
        ("依 Ordinal 與依 id 的旅伴順序不同", |s| {
            !s.people_by_ordinal()
                .map(|person| person.id)
                .eq(s.people.keys().copied())
        }),
    ];
    // 食材文字中的分隔符號、數字與空白（design 的共用產生器範圍）
    let pieces = [
        "、", "，", ";", "；", "/", "。", "\n", "1.5", "1,000", "\u{3000}", "\u{feff}", "\u{85}",
    ];
    let chars: &[CharClass] = &[
        ("全形數字", |c| ('０'..='９').contains(&c)),
        ("英文大寫", |c| c.is_ascii_uppercase()),
        ("英文小寫", |c| c.is_ascii_lowercase()),
    ];

    let mut runner = TestRunner::deterministic();
    let strategy = arb_state();
    let states: Vec<TripState> = (0..SAMPLES)
        .map(|_| {
            strategy
                .new_tree(&mut runner)
                .expect("產生器不會拒絕輸入")
                .current()
        })
        .collect();
    let any_ingredients = |found: &dyn Fn(&str) -> bool| {
        states
            .iter()
            .any(|state| state.meals.values().any(|meal| found(&meal.ingredients)))
    };

    let mut missing: Vec<String> = cases
        .iter()
        .filter(|(_, case)| !states.iter().any(case))
        .map(|(name, _)| (*name).to_owned())
        .collect();
    missing.extend(
        pieces
            .iter()
            .filter(|piece| !any_ingredients(&|text| text.contains(**piece)))
            .map(|piece| format!("食材文字含有 {piece:?}")),
    );
    missing.extend(
        chars
            .iter()
            .filter(|(_, class)| !any_ingredients(&|text| text.chars().any(class)))
            .map(|(name, _)| format!("食材文字含有{name}")),
    );
    assert!(
        missing.is_empty(),
        "取樣的 {SAMPLES} 個狀態沒有涵蓋：{missing:#?}"
    );
}

/// I1–I8、I10–I12（design「Data Models」的不變式，依需求 9.2–9.13 的寫法）。I9 是採買同步之後才成立的條件，
/// 產生器不保證。
fn check_invariants(s: &TripState) -> Result<(), TestCaseError> {
    let days = date_range(s.card.start, s.card.end);
    let destination_usable = !trim_white(&s.card.destination).is_empty();
    let is_person = |id: &PersonId| s.people.contains_key(id);
    let is_vehicle = |id: &VehicleId| s.vehicles.contains_key(id);
    // I4：只在旅行目的地不是空白時使用 Destination_Place
    let usable = |place: &PlaceRef| match place {
        PlaceRef::Destination => destination_usable,
        PlaceRef::Place(id) => s.places.contains_key(id),
    };

    // I1：每個已設定的引用都指向存在的列（I10 與 I11 的引用也在這裡）
    for vehicle in s.vehicles.values() {
        prop_assert!(
            vehicle
                .driver
                .iter()
                .chain(&vehicle.passengers)
                .all(is_person),
            "車輛 {}：駕駛或乘客不存在",
            vehicle.id
        );
    }
    for route in s.routes.values() {
        prop_assert!(is_vehicle(&route.vehicle), "路線 {}：車輛不存在", route.id);
        prop_assert!(
            usable(&route.from)
                && usable(&route.to)
                && route.stops.iter().all(|stop| usable(&stop.place)),
            "路線 {}：起點、終點或停靠點不能使用",
            route.id
        );
    }
    for setting in s.day_settings.values() {
        prop_assert!(
            setting.place.iter().all(|id| s.places.contains_key(id)),
            "{} 的每日設定：地點不存在",
            setting.day
        );
    }
    for activity in s.activities.values() {
        // I11：指定旅伴與指定車輛都不是空集合
        let valid = match &activity.who {
            Participation::Everyone => true,
            Participation::People(ids) => !ids.is_empty() && ids.iter().all(is_person),
            Participation::Vehicles(ids) => !ids.is_empty() && ids.iter().all(is_vehicle),
        };
        prop_assert!(valid, "活動 {}：參加者 {:?}", activity.id, activity.who);
    }
    for meal in s.meals.values() {
        prop_assert!(
            meal.cook.iter().all(is_person),
            "料理 {}：負責人不存在",
            meal.id
        );
    }
    for item in s.shopping.values() {
        prop_assert!(
            item.assignee.iter().all(is_person)
                && item.meal_ids.iter().all(|id| s.meals.contains_key(id)),
            "採買品項 {}：負責人或連動的料理不存在",
            item.id
        );
    }
    for item in s.gear.values() {
        prop_assert!(
            item.assignee.iter().chain(&item.packed_by).all(is_person),
            "裝備 {}：負責人或打包勾選的旅伴不存在",
            item.id
        );
    }
    for (person, departure) in &s.departures {
        prop_assert!(
            *person == departure.person && is_person(person),
            "出發確認 {person}：旅伴不存在"
        );
    }
    for expense in s.expenses.values() {
        prop_assert!(
            is_person(&expense.payer)
                && expense.participants.iter().all(is_person)
                && expense
                    .shopping_item
                    .iter()
                    .all(|id| s.shopping.contains_key(id)),
            "支出 {}：付款人、分攤旅伴或採買品項不存在",
            expense.id
        );
    }
    for settlement in s.settlements.values() {
        // I10：付款人與收款人是兩位不同的旅伴
        prop_assert!(
            is_person(&settlement.from)
                && is_person(&settlement.to)
                && settlement.from != settlement.to,
            "還款 {}：付款人或收款人",
            settlement.id
        );
    }

    // I2：Participant_Key 與 Place_Key 兩兩不同，地點也不與非空白的旅行目的地同名
    let person_keys: HashSet<String> = s
        .people
        .values()
        .map(|person| participant_key(&person.name))
        .collect();
    prop_assert_eq!(person_keys.len(), s.people.len(), "旅伴同名");
    let place_keys: HashSet<String> = s
        .places
        .values()
        .map(|place| place_key(&place.name))
        .collect();
    prop_assert_eq!(place_keys.len(), s.places.len(), "地點同名");
    prop_assert!(
        !destination_usable || !place_keys.contains(&place_key(&s.card.destination)),
        "地點與旅行目的地同名"
    );

    // I3：每台車每天最多一條路線、每條最多 6 個停靠點、停靠點 id 不重複
    let route_days: HashSet<(VehicleId, Date)> = s
        .routes
        .values()
        .map(|route| (route.vehicle, route.day))
        .collect();
    prop_assert_eq!(route_days.len(), s.routes.len(), "同一台車同一天有兩條路線");
    prop_assert!(s
        .routes
        .values()
        .all(|route| limits::ROUTE_STOPS.contains(&route.stops.len())));
    let stops: Vec<StopId> = s
        .routes
        .values()
        .flat_map(|route| route.stops.iter().map(|stop| stop.id))
        .collect();
    prop_assert_eq!(
        stops.iter().collect::<HashSet<_>>().len(),
        stops.len(),
        "停靠點 id 重複"
    );

    // I5：活動、料理、路線與每日設定的日期都在旅行範圍內
    let in_trip = |day: &Date| days.contains(day);
    prop_assert!(
        s.activities.values().all(|activity| in_trip(&activity.day))
            && s.meals.values().all(|meal| in_trip(&meal.day))
            && s.routes.values().all(|route| in_trip(&route.day))
            && s.day_settings.keys().all(in_trip),
        "日期不在旅行範圍內"
    );

    // I6：駕駛不在乘客中，乘客人數加 1 不超過座位數
    for vehicle in s.vehicles.values() {
        prop_assert!(
            vehicle
                .driver
                .is_none_or(|driver| !vehicle.passengers.contains(&driver))
                && vehicle.passengers.len() < usize::from(vehicle.seats),
            "車輛 {}：駕駛、乘客與座位數",
            vehicle.id
        );
    }

    // I7：個人裝備沒有負責人；共用裝備的打包勾選只有負責人
    for item in s.gear.values() {
        let valid = match item.scope {
            GearScope::Personal => item.assignee.is_none(),
            GearScope::Shared => item
                .packed_by
                .iter()
                .all(|person| Some(*person) == item.assignee),
        };
        prop_assert!(valid, "裝備 {}：負責人與打包勾選", item.id);
    }

    // I8：有出發確認的旅伴滿足 Can_Depart
    let unassigned_shared = s
        .gear
        .values()
        .any(|item| item.scope == GearScope::Shared && item.assignee.is_none());
    for person in s.departures.keys() {
        let my_gear_packed = s
            .gear
            .values()
            .filter(|item| item.scope == GearScope::Personal || item.assignee == Some(*person))
            .all(|item| item.packed_by.contains(person));
        prop_assert!(
            !unassigned_shared && my_gear_packed,
            "旅伴 {person} 有出發確認，但不滿足 Can_Depart"
        );
    }

    // I12：數量不超過上限，每筆支出有 1–100 位分攤旅伴
    prop_assert!(
        s.people.len() <= limits::PEOPLE_MAX
            && s.places.len() <= limits::PLACES_MAX
            && s.activities.len() <= limits::ACTIVITIES_MAX
            && s.meals.len() <= limits::MEALS_MAX
            && s.shopping.len() <= limits::SHOPPING_ITEMS_MAX
            && s.gear.len() <= limits::GEAR_ITEMS_MAX
            && s.expenses.len() <= limits::EXPENSES_MAX
            && s.settlements.len() <= limits::SETTLEMENTS_MAX,
        "數量超過上限"
    );
    prop_assert!(
        s.expenses
            .values()
            .all(|expense| limits::EXPENSE_PARTICIPANTS.contains(&expense.participants.len())),
        "支出的分攤旅伴人數"
    );
    Ok(())
}

/// 每個欄位都是命令處理函式會儲存的值（見 `support::vocab`），以及 `arb_state()` 的其他保證。
fn check_fields(s: &TripState) -> Result<(), TestCaseError> {
    let card = &s.card;
    prop_assert!((1..=MAX_DAYS).contains(&date_range(card.start, card.end).len()));
    prop_assert!(
        stored(&card.title, limits::TRIP_TITLE_CHARS)
            && stored(&card.destination, limits::TRIP_DESTINATION_CHARS)
            && stored(&card.description, limits::TRIP_DESCRIPTION_CHARS)
            && stored(&card.note, limits::TRIP_NOTE_CHARS),
        "旅行資料 {:?}",
        card
    );
    for person in s.people.values() {
        prop_assert!(
            participant_name(&person.name) == person.name
                && limits::PERSON_NAME_CHARS.contains(&char_count(&person.name))
                && !has_control_chars(&person.name)
                && participant_name(&person.role) == person.role
                && limits::PERSON_ROLE_CHARS.contains(&char_count(&person.role)),
            "旅伴 {:?}",
            person
        );
    }
    for vehicle in s.vehicles.values() {
        prop_assert!(
            stored(&vehicle.name, limits::VEHICLE_NAME_CHARS)
                && limits::VEHICLE_SEATS.contains(&vehicle.seats)
                && vehicle.color.as_deref().is_none_or(is_hex_color),
            "車輛 {:?}",
            vehicle
        );
    }
    for place in s.places.values() {
        prop_assert!(
            stored(&place.name, limits::PLACE_NAME_CHARS) && !has_control_chars(&place.name),
            "地點 {:?}",
            place
        );
    }
    for stop in s.routes.values().flat_map(|route| &route.stops) {
        prop_assert!(
            stored(&stop.note, limits::STOP_NOTE_CHARS)
                && stop.task.is_none_or(|task| kind_of(task) == stop.kind),
            "停靠點 {:?}",
            stop
        );
    }
    for setting in s.day_settings.values() {
        prop_assert!(
            setting
                .title
                .as_deref()
                .is_none_or(|title| !title.is_empty() && stored(title, limits::DAY_TITLE_CHARS))
                && (setting.title.is_some()
                    || setting.place.is_some()
                    || setting.arrival.is_some()),
            "每日設定 {:?}",
            setting
        );
    }
    for activity in s.activities.values() {
        prop_assert!(
            stored(&activity.title, limits::ACTIVITY_TITLE_CHARS)
                && stored(&activity.location, limits::ACTIVITY_LOCATION_CHARS)
                && stored(&activity.note, limits::ACTIVITY_NOTE_CHARS),
            "活動 {:?}",
            activity
        );
    }
    for meal in s.meals.values() {
        prop_assert!(
            stored(&meal.title, limits::MEAL_TITLE_CHARS)
                && stored(&meal.notes, limits::MEAL_NOTES_CHARS)
                && limits::MEAL_SERVINGS.contains(&meal.servings)
                && limits::MEAL_INGREDIENTS_CHARS.contains(&char_count(&meal.ingredients))
                && !meal.ingredients.contains('\0')
                && check_ingredient_names(&meal.ingredients).is_ok(),
            "料理 {:?}",
            meal
        );
    }
    for item in s.shopping.values() {
        prop_assert!(
            !trim_white(&item.name).is_empty()
                && limits::SHOPPING_NAME_CHARS.contains(&char_count(&item.name))
                && !item.name.contains('\0')
                && stored(&item.quantity, limits::SHOPPING_QUANTITY_CHARS),
            "採買品項 {:?}",
            item
        );
    }
    for item in s.gear.values() {
        prop_assert!(
            stored(&item.name, limits::GEAR_NAME_CHARS)
                && stored(&item.quantity, limits::GEAR_QUANTITY_CHARS),
            "裝備 {:?}",
            item
        );
    }
    for expense in s.expenses.values() {
        prop_assert!(
            stored(&expense.title, limits::EXPENSE_TITLE_CHARS)
                && !has_control_chars(&expense.title)
                && limits::AMOUNT_CENTS.contains(&expense.amount_cents)
                && stored(&expense.note, limits::LEDGER_NOTE_CHARS),
            "支出 {:?}",
            expense
        );
    }
    for settlement in s.settlements.values() {
        prop_assert!(
            limits::AMOUNT_CENTS.contains(&settlement.amount_cents)
                && stored(&settlement.note, limits::LEDGER_NOTE_CHARS),
            "還款 {:?}",
            settlement
        );
    }

    // Ordinal 兩兩不同（lm-server 以 trips.next_ordinal 遞增指定），而且不使用保留給 SeqIds 的 id
    let ordinals: Vec<u64> = s
        .slots()
        .filter_map(|slot| s.get(slot)?.ordinal())
        .collect();
    prop_assert_eq!(
        ordinals.iter().collect::<HashSet<_>>().len(),
        ordinals.len(),
        "Ordinal 重複"
    );
    let reserved_unused = s.slots().all(|(_, key)| match key {
        RowKey::Id(id) => !has_tag(id, Tag::NewShopping),
        RowKey::Day(_) => true,
    });
    prop_assert!(reserved_unused, "使用了保留給 SeqIds 的 id");
    Ok(())
}

/// 已經過 Trim_White、字數在 `chars` 之內、不含 U+0000 的文字。
fn stored(text: &str, chars: RangeInclusive<usize>) -> bool {
    trim_white(text) == text && chars.contains(&char_count(text)) && !text.contains('\0')
}

/// `#` 加上 6 個小寫的十六進位數字（需求 20.3）。
fn is_hex_color(color: &str) -> bool {
    color.len() == 7
        && color.starts_with('#')
        && color[1..]
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// 任務所屬的停靠點種類（Enum_Table 的「停靠點種類與任務」）。
fn kind_of(task: StopTask) -> StopKind {
    match task {
        StopTask::Shopping => StopKind::Shop,
        StopTask::PassengerPickup | StopTask::PassengerDropoff => StopKind::Pickup,
        StopTask::GearPickup | StopTask::GearReturn => StopKind::Gear,
        StopTask::CarRental | StopTask::CarReturn | StopTask::Waypoint => StopKind::Other,
    }
}

fn trip_days(s: &TripState) -> usize {
    date_range(s.card.start, s.card.end).len()
}

fn uses_destination(route: &Route) -> bool {
    [route.from, route.to]
        .into_iter()
        .chain(route.stops.iter().map(|stop| stop.place))
        .any(|place| place == PlaceRef::Destination)
}

/// 料理切出的名稱中，同一個 Ingredient_Key 有兩種以上的寫法（例如「雞蛋」與「雞 蛋」）。
fn has_key_spelled_differently(s: &TripState) -> bool {
    let mut spellings: BTreeMap<String, HashSet<String>> = BTreeMap::new();
    for name in s
        .meals
        .values()
        .flat_map(|meal| parse_ingredients(&meal.ingredients))
    {
        spellings
            .entry(ingredient_key(&name))
            .or_default()
            .insert(name);
    }
    spellings.values().any(|names| names.len() >= 2)
}

/// 有兩道料理需要同一個 Ingredient_Key。
fn needed_by_two_meals(s: &TripState) -> bool {
    let mut seen: HashSet<String> = HashSet::new();
    for meal in s.meals.values() {
        let keys: HashSet<String> = parse_ingredients(&meal.ingredients)
            .iter()
            .map(|name| ingredient_key(name))
            .collect();
        if keys.iter().any(|key| seen.contains(key)) {
            return true;
        }
        seen.extend(keys);
    }
    false
}

fn sync(s: &TripState) -> SyncPlan {
    sync_meal_ingredients(s, &mut SeqIds::new()).expect("產生的狀態不會超過採買品項的上限")
}
