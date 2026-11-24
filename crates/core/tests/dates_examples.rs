//! 改日期（Retime）的範例測試（需求 33.1）。
//!
//! 移植 `tests/itinerary-dates.test.js` 中 `retimeByDayIndex()` 與 `shortenBlockedMessage()` 的案例：輸入與原案例
//! 相同，預期值與原案例相同並直接寫在測試中，也就是 Bun_App 對同一輸入的結果。每個測試上方的註解標明來源的測試名稱，
//! `describe` 之內的測試寫成「describe › test」。該檔的 19 個案例（`SHIFT_CASES` 表格的每一列各算一個）移植 6 個：
//! `需求 20.2：縮短天數被拒絕時的訊息` 的 5 個測試，以及最後一個測試中 `shortenBlockedMessage([])` 的斷言。
//!
//! 現行的資料與結果寫成第一版的形式：
//!
//! - 範例旅行是 `support::example_trip`（現行 `exampleTrip()`），陣列的順序是 Ordinal。現行的字串 id 依編號對應 UUID：
//!   車輛 v{n} 是 `id(Tag::Vehicle, n)`，地點 pl-shop 與 pl-taipei 是 `id(Tag::Place, 5)` 與 `id(Tag::Place, 6)`；
//!   測試加入的路線 rt-{n}-v{k}、活動 a-{n} 與料理 m-{n} 是 `id(Tag::Route, 100 × n + k)`、`id(Tag::Activity, 100 + n)`
//!   與 `id(Tag::Meal, 100 + n)`，不與範例旅行的列重複。
//! - 現行以 `push()` 加入的列取得當時最大的 Ordinal 加 1；`state.routes.reverse()` 把路線的 Ordinal 反過來
//!   （`reverse_routes()`）。每日設定以日期為鍵，沒有排列順序，所以 `state.daySettings.reverse()` 沒有對應的操作。
//! - 每日設定的 `place: ''` 是 `None`（未設定）；路線的 `DESTINATION_REF` 是 `PlaceRef::Destination`，`time: ''` 是
//!   沒有出發時間。
//! - `retime_by_day_index()` 修改傳入的可寫副本：現行的 `{ ok: false, blocked }` 是 `Err(blocked)`
//!   （`expect_err()`），`expect(state).toStrictEqual(before)`（輸入不變）是被阻擋之後副本與原狀態相同；
//!   `{ ok: true, state }` 是 `Ok(())`，新的狀態就是改日期之後的副本。現行的
//!   `result.state.daySettings.map(setting => setting.date)` 是副本的 `day_settings.keys()`，因為每日設定以日期為鍵。
//! - `expect(isValidState(state)).toBe(true)` 改為 `assert_valid_dates()`。
//!
//! 不移植的案例與原因：
//!
//! - `需求 20.4：平移日期後放不下時的訊息` › `類別依活動、餐點、路線、每日設定排列` 與
//!   `Example_Trip 縮成兩天：第 3 天的活動、餐點、路線與 Day_Title 都放不下`；同一個 describe 之內
//!   `5 天的旅行改為 2026-10-21 到 2026-10-23（平移 1 天，原本的第 4、5 天落在範圍外）` 的 `SHIFT_CASES` 表格 9 列
//!   （`第 5 天的活動`、`第 5 天的餐點`、`第 4 天的路線`、`第 4 天的 Day_Title`、`第 5 天的 Day_Location`、
//!   `第 4 天的路線、第 5 天的活動`、`第 4 天的 Day_Title、第 5 天的餐點`、
//!   `第 4 天的 Day_Location 與路線、第 5 天的餐點與活動`、`第 4 天只有 Arrival_Time，第 5 天有空白的 Day_Title 與路線`），
//!   以及 `範圍外只有 Arrival_Time 或空白 Day_Title 的 Day_Settings 時平移成功，這些 Day_Settings 被捨棄` 與
//!   `訊息的固定字元：U+3001 連接類別，之後是 U+FF0C 與 U+3002`：斷言 `shiftByOffset()`、`SHIFT_CATEGORIES` 與
//!   `outOfRangeMessage()`，也就是現行伺服器 `PATCH /api/trips/:id` 與匯入使用的平移日期。第一版只以 `UpdateTrip`
//!   改日期，一律依第 N 天搬動（需求 18.5–18.8），沒有平移，也沒有匯入。
//! - `沒有被擋下的日子或放不下的類別時，兩種訊息都是空字串` 中 `outOfRangeMessage([])` 的斷言：原因同上。

mod support;

use std::collections::{BTreeMap, BTreeSet};

use lm_core::dates::{retime_by_day_index, shorten_blocked_message, BlockedDay};
use lm_core::ids::PlaceId;
use lm_core::limits::DAY_TITLE_CHARS;
use lm_core::model::{
    Activity, ActivityKind, Date, DaySetting, Meal, MealSlot, Participation, PlaceRef, Route,
    RoutePosition, Row, TripState,
};
use lm_core::text::{char_count, trim_white};
use lm_core::time::{date_range, Hm};

use support::example_trip::example_trip;
use support::ids::{id, Tag};

// 訊息中的全形標點，以碼位寫出，避免與外觀相近的字元（例如 U+002C、U+FF64、U+FE51）混淆
/// 逗號「，」
const COMMA: char = '\u{ff0c}';
/// 冒號「：」
const COLON: char = '\u{ff1a}';
/// 括號「（」「）」
const OPEN: char = '\u{ff08}';
const CLOSE: char = '\u{ff09}';
/// 頓號「、」
const DUN: char = '\u{3001}';
/// 句號「。」
const PERIOD: char = '\u{3002}';

// ── 需求 20.2：縮短天數被拒絕時的訊息 ──

/// 來源：`tests/itinerary-dates.test.js` 的 `需求 20.2：縮短天數被拒絕時的訊息` ›
/// `設計的範例：5 天縮成 3 天，第 4 天有路線，第 5 天有路線與 Day_Title`。
#[test]
fn design_example_five_days_shortened_to_three() {
    let mut state = five_day_trip();
    add_route(&mut state, 4, 1);
    add_route(&mut state, 5, 2);
    set_day(&mut state, 5, |setting| {
        setting.title = Some("多玩一天".to_owned())
    });
    let blocked = blocked_by(&state, "2026-10-20", "2026-10-22");
    assert_eq!(
        blocked,
        [
            blocked_day(4, "2026-10-23", true, false),
            blocked_day(5, "2026-10-24", true, true),
        ]
    );
    let message = shorten_blocked_message(&blocked);
    assert_eq!(
        message,
        "縮短天數前，請先處理：第 4 天（10/23）的路線、第 5 天（10/24）的路線與每日設定。刪除這些路線、清除這些每日設定後，才能縮短天數。"
    );
    // 標點的碼位：U+FF0C、U+FF1A、U+FF08 與 U+FF09、U+3001、U+3002；第 N 天前後的空白與日期中的斜線是半形
    assert_eq!(
        message,
        format!(
            "縮短天數前{COMMA}請先處理{COLON}第 4 天{OPEN}10/23{CLOSE}的路線{DUN}\
             第 5 天{OPEN}10/24{CLOSE}的路線與每日設定{PERIOD}刪除這些路線{DUN}清除這些每日設定後{COMMA}才能縮短天數{PERIOD}"
        )
    );
}

/// 來源：`tests/itinerary-dates.test.js` 的 `需求 20.2：縮短天數被拒絕時的訊息` ›
/// `依天數順序列出，與資料的排列順序無關；只有 Arrival_Time、活動與餐點的日子不列出`。
#[test]
fn blocked_days_follow_day_order_and_arrival_activities_and_meals_do_not_block() {
    // 縮成 1 天：第 2 天有 Example_Trip 的 Day_Title，第 3 天有 Example_Trip 的四條路線與 Day_Title
    let mut state = five_day_trip();
    set_day(&mut state, 4, |setting| setting.arrival = Some(at(15, 0)));
    add_activity(&mut state, 4);
    add_meal(&mut state, 4);
    add_route(&mut state, 5, 2);
    // 現行的 state.routes.reverse()；state.daySettings.reverse() 沒有對應的操作（見檔頭）
    reverse_routes(&mut state);
    let blocked = blocked_by(&state, "2026-10-20", "2026-10-20");
    assert_eq!(
        blocked,
        [
            blocked_day(2, "2026-10-21", false, true),
            blocked_day(3, "2026-10-22", true, true),
            blocked_day(5, "2026-10-24", true, false),
        ]
    );
    assert_eq!(
        shorten_blocked_message(&blocked),
        "縮短天數前，請先處理：第 2 天（10/21）的每日設定、第 3 天（10/22）的路線與每日設定、第 5 天（10/24）的路線。刪除這些路線、清除這些每日設定後，才能縮短天數。"
    );
}

/// 來源：`tests/itinerary-dates.test.js` 的 `需求 20.2：縮短天數被拒絕時的訊息` › `Day_Location 設為地點也算每日設定`。
#[test]
fn a_day_place_counts_as_a_day_setting() {
    let mut state = five_day_trip();
    set_day(&mut state, 4, |setting| {
        setting.place = Some(place_id(PL_TAIPEI))
    });
    add_route(&mut state, 5, 1);
    set_day(&mut state, 5, |setting| {
        setting.place = Some(place_id(PL_SHOP));
        setting.arrival = Some(at(16, 0));
    });
    let blocked = blocked_by(&state, "2026-10-20", "2026-10-22");
    assert_eq!(
        blocked,
        [
            blocked_day(4, "2026-10-23", false, true),
            blocked_day(5, "2026-10-24", true, true),
        ]
    );
    assert_eq!(
        shorten_blocked_message(&blocked),
        "縮短天數前，請先處理：第 4 天（10/23）的每日設定、第 5 天（10/24）的路線與每日設定。刪除這些路線、清除這些每日設定後，才能縮短天數。"
    );
}

/// 來源：`tests/itinerary-dates.test.js` 的 `需求 20.2：縮短天數被拒絕時的訊息` ›
/// `空白的 Day_Title 與 Arrival_Time 不算每日設定；被移除的日子只剩這些時可以縮短天數`。
#[test]
fn blank_titles_and_arrival_times_do_not_block_and_their_settings_are_dropped() {
    let mut state = five_day_trip();
    add_route(&mut state, 4, 1);
    // 現行的 { ...BLANK, arrival: '15:00' }：標題只有半形與全形空白，地點是空字串（未設定）
    set_day(&mut state, 4, |setting| {
        setting.title = Some(BLANK_TITLE.to_owned());
        setting.place = None;
        setting.arrival = Some(at(15, 0));
    });
    set_day(&mut state, 5, |setting| {
        setting.title = Some("\u{3000}\u{3000}".to_owned());
        setting.arrival = Some(at(16, 0));
    });
    add_activity(&mut state, 5);
    let blocked = blocked_by(&state, "2026-10-20", "2026-10-22");
    assert_eq!(blocked, [blocked_day(4, "2026-10-23", true, false)]);
    assert_eq!(
        shorten_blocked_message(&blocked),
        "縮短天數前，請先處理：第 4 天（10/23）的路線。刪除這些路線、清除這些每日設定後，才能縮短天數。"
    );
    // 刪除第 4 天的路線後就能縮短，第 4、5 天的 Day_Settings 直接捨棄
    state
        .routes
        .retain(|_, route| route.day != date("2026-10-23"));
    let mut draft = state.clone();
    assert_eq!(
        retime_by_day_index(&mut draft, date("2026-10-20"), date("2026-10-22")),
        Ok(())
    );
    let days: Vec<Date> = draft.day_settings.keys().copied().collect();
    assert_eq!(days, ["2026-10-20", "2026-10-21", "2026-10-22"].map(date));
}

/// 來源：`tests/itinerary-dates.test.js` 的 `需求 20.2：縮短天數被拒絕時的訊息` ›
/// `列出原本的日期（月與日不補零），不受新的開始日期影響`。
#[test]
fn blocked_days_show_their_original_unpadded_dates() {
    // 31 天的旅行（2026-12-20 到 2027-01-19）縮成 10 天：第 13 天是 2027-01-01，第 31 天是 2027-01-19
    let mut state = example_trip_on("2026-12-20", "2027-01-19");
    add_route(&mut state, 13, 1);
    set_day(&mut state, 31, |setting| {
        setting.title = Some("最後一天".to_owned())
    });
    let message = "縮短天數前，請先處理：第 13 天（1/1）的路線、第 31 天（1/19）的每日設定。刪除這些路線、清除這些每日設定後，才能縮短天數。";
    let shorter = blocked_by(&state, "2026-12-20", "2026-12-29");
    assert_eq!(shorten_blocked_message(&shorter), message);
    // 同時改開始日期時，仍列出原本的日期，不是新開始日期加 N − 1 天的 3/13、3/31
    let moved = blocked_by(&state, "2027-03-01", "2027-03-10");
    assert_eq!(shorten_blocked_message(&moved), message);
}

/// 來源：`tests/itinerary-dates.test.js` 的 `沒有被擋下的日子或放不下的類別時，兩種訊息都是空字串`。只移植
/// `shortenBlockedMessage([])`；`outOfRangeMessage([])` 不移植（見檔頭）。
#[test]
fn no_blocked_days_give_an_empty_message() {
    assert_eq!(shorten_blocked_message(&[]), "");
}

// ── 現行測試的資料與輔助函式 ──

/// 範例旅行的地點 pl-shop（超市／賣場）與 pl-taipei（台北）。
const PL_SHOP: u64 = 5;
const PL_TAIPEI: u64 = 6;
/// 現行的 `BLANK.title`：只有半形與全形空白的標題。
const BLANK_TITLE: &str = " \u{3000}";

fn place_id(n: u64) -> PlaceId {
    id(Tag::Place, n)
}

fn date(text: &str) -> Date {
    text.parse().expect("有效的日期")
}

fn at(hour: u8, minute: u8) -> Hm {
    Hm::new(hour, minute).expect("有效的時刻")
}

/// 現行的 `{ n, date, routes, settings }`。
fn blocked_day(n: usize, on: &str, routes: bool, settings: bool) -> BlockedDay {
    BlockedDay {
        n,
        date: date(on),
        routes,
        settings,
    }
}

/// 現行的 `exampleTripOn(startDate, endDate)`：範例旅行移到 `start` 到 `end`（至少 3 天）。原本的內容維持第 1 到 3 天，
/// 第 4 天以後沒有內容。
fn example_trip_on(start: &str, end: &str) -> TripState {
    let mut state = example_trip();
    let old_days = date_range(state.card.start, state.card.end);
    let day_n: BTreeMap<Date, Date> = old_days
        .into_iter()
        .zip(date_range(date(start), date(end)))
        .collect();
    for activity in state.activities.values_mut() {
        activity.day = day_n[&activity.day];
    }
    for meal in state.meals.values_mut() {
        meal.day = day_n[&meal.day];
    }
    for route in state.routes.values_mut() {
        route.day = day_n[&route.day];
    }
    state.day_settings = std::mem::take(&mut state.day_settings)
        .into_values()
        .map(|setting| {
            let day = day_n[&setting.day];
            (day, DaySetting { day, ..setting })
        })
        .collect();
    state.card.start = date(start);
    state.card.end = date(end);
    state
}

/// 現行的 `fiveDayTrip()`：範例旅行延長為 2026-10-20 到 2026-10-24 的 5 天；第 4、5 天（10/23、10/24）還沒有內容。
fn five_day_trip() -> TripState {
    example_trip_on("2026-10-20", "2026-10-24")
}

/// 現行的 `dayDate(state, n)`：旅行的第 n 天。
fn day_date(state: &TripState, n: u64) -> Date {
    let index = usize::try_from(n - 1).expect("天數放得進 usize");
    date_range(state.card.start, state.card.end)[index]
}

/// 下一列的 Ordinal：目前最大的 Ordinal 加 1，所以依序加入的列排在最後（現行的 `push()`）。
fn next_ordinal(state: &TripState) -> u64 {
    state.max_ordinal() + 1
}

/// 現行的 `addRoute(state, n, vehicleId)`：第 `vehicle` 台車在第 n 天從旅行目的地開往台北的路線 rt-{n}-v{vehicle}，
/// 沒有出發時間與停靠點。範例旅行第 4 天以後沒有路線；每台車每天最多一條路線。
fn add_route(state: &mut TripState, n: u64, vehicle: u64) {
    let route = Route {
        id: id(Tag::Route, 100 * n + vehicle),
        day: day_date(state, n),
        vehicle: id(Tag::Vehicle, vehicle),
        from: PlaceRef::Destination,
        to: PlaceRef::Place(place_id(PL_TAIPEI)),
        depart: None,
        stops: Vec::new(),
        ordinal: next_ordinal(state),
        version: 1,
    };
    state.put(Row::Route(route));
}

/// 現行的 `addActivity(state, n)`：第 n 天 09:00 的自由活動「多留一天」a-{n}，參加者為全體旅伴，沒有地點與備註，
/// 未完成。
fn add_activity(state: &mut TripState, n: u64) {
    let activity = Activity {
        id: id(Tag::Activity, 100 + n),
        day: day_date(state, n),
        time: at(9, 0),
        title: "多留一天".to_owned(),
        kind: ActivityKind::Free,
        location: String::new(),
        note: String::new(),
        done: false,
        who: Participation::Everyone,
        ordinal: next_ordinal(state),
        version: 1,
    };
    state.put(Row::Activity(activity));
}

/// 現行的 `addMeal(state, n)`：第 n 天的 8 人份午餐「野餐」m-{n}，沒有用餐時間、負責人、食材、筆記與插圖種類。
fn add_meal(state: &mut TripState, n: u64) {
    let meal = Meal {
        id: id(Tag::Meal, 100 + n),
        day: day_date(state, n),
        slot: MealSlot::Lunch,
        time: None,
        title: "野餐".to_owned(),
        cook: None,
        servings: 8,
        ingredients: String::new(),
        notes: String::new(),
        dish: None,
        ordinal: next_ordinal(state),
        version: 1,
    };
    state.put(Row::Meal(meal));
}

/// 現行的 `setDay(state, n, values)`：以 `change` 修改第 n 天的每日設定（現行的 `Object.assign(setting, values)`）；
/// 還沒有時先新增一筆沒有標題、地點與預計抵達時間，路線在活動之前的每日設定。
fn set_day(state: &mut TripState, n: u64, change: impl FnOnce(&mut DaySetting)) {
    let day = day_date(state, n);
    let setting = state.day_settings.entry(day).or_insert(DaySetting {
        day,
        title: None,
        place: None,
        arrival: None,
        arrival_label: None,
        route_position: RoutePosition::Before,
        version: 1,
    });
    change(setting);
}

/// 現行的 `state.routes.reverse()`：把路線的 Ordinal 反過來，使依 Ordinal 走訪的順序與原本相反。
fn reverse_routes(state: &mut TripState) {
    let order: Vec<_> = state.routes_by_ordinal().map(|route| route.id).collect();
    for (ordinal, route) in (1..).zip(order.iter().rev()) {
        state.routes.get_mut(route).expect("路線").ordinal = ordinal;
    }
}

/// 現行測試的 `blockedBy(state, startDate, endDate)`：確認 `state` 通過驗證，把旅行改為 `start` 到 `end` 被阻擋，而且
/// 輸入不變（被阻擋時 `retime_by_day_index()` 不修改傳入的副本），再回傳阻擋的日子。
fn blocked_by(state: &TripState, start: &str, end: &str) -> Vec<BlockedDay> {
    assert_valid_dates(state);
    let mut draft = state.clone();
    let blocked =
        retime_by_day_index(&mut draft, date(start), date(end)).expect_err("縮短天數被阻擋");
    assert_eq!(draft, *state);
    blocked
}

/// 原測試的 `expect(isValidState(state)).toBe(true)`。第一版的 State_Validator 是 `validate::state()`（任務 8.5，還沒有
/// 實作），資料格式也不同，所以這裡以第一版的規則，只檢查這些測試修改的資料（活動、料理、路線與每日設定）中型別沒有
/// 保證的條件：
///
/// - 活動、料理、路線與每日設定的日期都在旅行範圍內（I5）。
/// - 路線的車輛存在，每台車每天最多一條路線；起點與終點是地點清單中的地點，或非空白的旅行目的地（I1、I3、I4）。
/// - 每日設定的鍵是它的日期，地點是地點清單中的地點，標題最多 20 字（I1，需求 22.10）。
fn assert_valid_dates(state: &TripState) {
    let days: BTreeSet<Date> = date_range(state.card.start, state.card.end)
        .into_iter()
        .collect();
    assert!(!days.is_empty(), "旅行是 1–31 天");
    let in_range = |day: &Date| days.contains(day);
    let activities_fit = state
        .activities
        .values()
        .all(|activity| in_range(&activity.day));
    assert!(activities_fit, "活動的日期不在旅行範圍內");
    assert!(
        state.meals.values().all(|meal| in_range(&meal.day)),
        "料理的日期不在旅行範圍內"
    );
    let usable = |place: PlaceRef| match place {
        PlaceRef::Destination => !trim_white(&state.card.destination).is_empty(),
        PlaceRef::Place(id) => state.places.contains_key(&id),
    };
    let mut car_days = BTreeSet::new();
    for route in state.routes.values() {
        let at = format!("{} 的路線", route.day);
        assert!(in_range(&route.day), "{at}不在旅行範圍內");
        assert!(
            state.vehicles.contains_key(&route.vehicle),
            "{at}的車輛不存在"
        );
        assert!(
            car_days.insert((route.day, route.vehicle)),
            "{at}：這台車這一天已有路線"
        );
        assert!(
            usable(route.from) && usable(route.to),
            "{at}的起點或終點無法使用"
        );
    }
    for (&key, setting) in &state.day_settings {
        assert_eq!(key, setting.day, "每日設定的鍵是它的日期");
        assert!(in_range(&key), "{key} 的每日設定不在旅行範圍內");
        let place_known = setting
            .place
            .is_none_or(|place| state.places.contains_key(&place));
        assert!(place_known, "{key} 的每日設定的地點不在地點清單中");
        let title_fits = setting
            .title
            .as_deref()
            .is_none_or(|title| DAY_TITLE_CHARS.contains(&char_count(title)));
        assert!(title_fits, "{key} 的每日設定的標題太長");
    }
}
