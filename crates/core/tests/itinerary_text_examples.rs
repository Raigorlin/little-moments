//! 文字版的其他範例測試（需求 33.11）：範例旅行的 golden 測試（`itinerary_text_golden.rs`）沒有用到的 Itinerary_Text
//! 規則，依需求 33.11 列出的情況各以一個小型旅行測試，比對 `itinerary_text()` 的完整輸出：
//!
//! - `no_vehicles`：沒有車輛（「車輛：尚未安排」）。
//! - `day_titles_and_day_places`：沒有當日標題（「未命名的一天」）、沒有 Day_Place（「地點：未指定」），以及以地點清單
//!   中的地點為 Day_Place 的一天。
//! - `a_day_without_routes_activities_or_meals`：沒有路線、活動與料理的一天（「活動」之後只有「無安排」）。
//! - `routes_follow_creation_order`：同一天有多條路線、建立順序與出發時間的順序不同，以及出發時間留空的路線
//!   （「出發時間未填」）。
//! - `stops_of_every_kind`：四種種類的停靠點，包括指定任務與沒有指定任務（預設任務）、時間留空（「・時間未填」），以及
//!   備註有填與留空。
//! - `shopping_stop_items`：同時有採買品項與備註的 Shopping_Stop（以「；」連接）、同一台車的第二個 Shopping_Stop
//!   （沒有採買品項），以及恰好 8 項與 9 項採買品項（9 項時為前 7 項加「、等另外 2 項」）。
//! - `arrival_lines`：有預計抵達時間但沒有路線的一天（路線區塊只有抵達行），以及沒有 Day_Place 時的抵達行
//!   （「預計 {HH:MM} 抵達」）。
//! - `same_time_events_done_activities_and_meal_titles`：同一時間的活動與料理（活動在前，再各依建立順序）、已完成的
//!   活動，以及料理名稱是空的或與餐次相同。
//! - `meal_categories`：料理類別的每一種情況（插圖種類為 hotpot、bbq、breakfast 與 toast，以及其他插圖種類時餐次為
//!   早餐、午餐與其他餐次）。
//! - `note_lines`：有備註的活動與料理（備註行），以及只有空白的備註（沒有備註行）。
//! - `route_block_after_activities`：路線位置為「路線在活動之後」的一天（活動區塊在前，路線區塊與抵達行在後）。
//! - `unassigned_shopping_lists_only_items_without_an_assignee` 與 `no_unassigned_shopping_block_without_such_items`：
//!   未分配採買清單列出已買與未買的待分配品項、不列出負責人不在任何車上或負責人的車沒有 Shopping_Stop 的品項，以及沒有
//!   待分配品項時沒有這個區塊。
//! - `user_text_is_cleaned`：含換行與前後空白的使用者文字，以及不含換行的連續空白保留原樣。
//!
//! 預期文字依需求 31.2–31.14 與 31.18 逐行撰寫，不是由 `itinerary_text()` 的輸出產生；`assert_text()` 以 `\n` 連接
//! 各行，第一行之前與最後一行之後都沒有換行字元。固定標點是需求 31.18 的碼位：「・」U+30FB、「｜」U+FF5C、
//! 「：」U+FF1A、「（」U+FF08、「）」U+FF09、「、」U+3001、「；」U+FF1B，以及前後各一個半形空格的「→」U+2192；
//! 數字、HH:MM 的冒號、M/D 的斜線與固定文字中的空格是半形字元。每趟旅行都從 2026-10-20（週二）開始。
//!
//! 每趟旅行都是有效的 Trip_State（需求 9）：引用的列都存在、地點名稱不重複也不等於旅行目的地、旅行目的地是空的時不使用
//! Destination_Place、每台車每天最多一條路線、每條路線最多 6 個停靠點；料理沒有食材（`user_text_is_cleaned` 的料理
//! 除外，它的食材由連動的 Meal_Item 涵蓋），採買品項是 Manual_Item。依各需求儲存 Trim_White 之後內容的使用者文字
//! （旅行名稱與目的地、車名、地點名稱、當日標題、停靠點備註、活動的標題與備註、手動品項的名稱）沒有前後空白，所以前後
//! 空白只出現在料理的名稱與筆記，以及 Ingredient_Parser 切出的 Meal_Item 名稱（例如以 U+0085 開頭的名稱，需求 33.10）。
//!
//! 每一列的 id 是 `support::ids` 的 `id(Tag::…, 1000 − n)`，n 是這一列的建立順序（Ordinal）：依 id 走訪的順序與建立
//! 順序相反，所以文字中依建立順序排列的車輛、路線、活動、料理與採買品項，不會因為依 id 排列而碰巧相同。
//!
//! 撰寫時也把每趟旅行換成現行的資料，與現行行程繪本「複製文字」複製的文字比對過（`src/storybook/app.js` 的
//! `renderItinerary()` 與 `copyItinerary()`，資料由 `src/storybook-adapter.js` 的 `toStudio()` 整理），並加上已確認的
//! 兩處改變：不是空白的備註另起一行、以兩個半形空格開頭，抵達行由預計抵達時間產生。除了 `user_text_is_cleaned`，每個
//! 案例都與預期文字逐字相同。現行只以 `cleanText()` 處理料理標題與採買品項名稱，旅行名稱、車名、地點名稱與旅行目的地、
//! 當日標題、停靠點備註與活動標題中的換行字元在現行複製的文字中原樣保留，所以這個案例依需求 31.14 與現行不同（見
//! `lm_core::itinerary_text` 的說明）。

mod support;

use std::collections::BTreeSet;

use lm_core::itinerary_text::itinerary_text;
use lm_core::model::{
    Activity, ActivityKind, Category, Color, CoverKind, Date, DaySetting, DishKind, ItemSource,
    Meal, MealSlot, Participation, Person, Place, PlaceRef, Route, RoutePosition, Row,
    ShoppingItem, Stop, StopKind, StopTask, TripCard, TripState, TripStatus, Vehicle,
};
use lm_core::time::Hm;
use uuid::Uuid;

use support::ids::{id, Tag};

/// 比對完整的 Itinerary_Text：`expected` 的各行以 `\n` 連接，第一行之前與最後一行之後都沒有換行字元。失敗時另外逐行
/// 列出實際的文字，方便與 `expected` 對照。
#[track_caller]
fn assert_text(s: &TripState, expected: &[&str]) {
    let text = itinerary_text(s);
    assert_eq!(
        text,
        expected.join("\n"),
        "實際的各行：{:#?}",
        text.split('\n').collect::<Vec<_>>()
    );
}

// ── 旅行與列 ──

/// 第 n 個建立的列的 id：`id(tag, 1000 − n)`，所以 id 的順序與建立順序（Ordinal）相反。
fn nth<T: From<Uuid>>(tag: Tag, n: u64) -> T {
    id(tag, 1000 - n)
}

/// 旅行的第 n 天：2026-10-20（週二）是第 1 天。
fn day(n: u32) -> Date {
    u8::try_from(19 + n)
        .ok()
        .and_then(|day| lm_core::time::ymd(2026, 10, day))
        .expect("有效的日期")
}

fn at(hour: u8, minute: u8) -> Hm {
    Hm::new(hour, minute).expect("有效的時刻")
}

/// 從第 1 天起共 `days` 天的旅行，有 `rows` 這些列。
fn trip(
    title: &str,
    destination: &str,
    days: u32,
    rows: impl IntoIterator<Item = Row>,
) -> TripState {
    let mut s = TripState::new(TripCard {
        id: id(Tag::Trip, 1),
        title: title.to_owned(),
        destination: destination.to_owned(),
        start: day(1),
        end: day(days),
        description: String::new(),
        note: String::new(),
        cover: CoverKind::Camp,
        status: TripStatus::Planning,
        version: 0,
        caption: String::new(),
        headline: String::new(),
    });
    for row in rows {
        s.put(row);
    }
    s
}

/// 第 n 位旅伴。
fn person(n: u64, name: &str) -> Row {
    Row::Person(Person {
        id: nth(Tag::Person, n),
        name: name.to_owned(),
        role: String::new(),
        color: Color::Coral,
        bound: false,
        ordinal: n,
        version: 1,
    })
}

/// 第 n 台車：9 人座、沒有設定顏色；`driver` 與 `passengers` 是第幾位旅伴。
fn vehicle(n: u64, name: &str, driver: Option<u64>, passengers: &[u64]) -> Row {
    Row::Vehicle(Vehicle {
        id: nth(Tag::Vehicle, n),
        name: name.to_owned(),
        driver: driver.map(|person| nth(Tag::Person, person)),
        seats: 9,
        color: None,
        passengers: passengers
            .iter()
            .map(|&person| nth(Tag::Person, person))
            .collect(),
        ordinal: n,
        version: 1,
    })
}

/// 地點清單中的第 n 個地點。
fn place(n: u64, name: &str) -> Row {
    Row::Place(Place {
        id: nth(Tag::Place, n),
        name: name.to_owned(),
        ordinal: n,
        version: 1,
        template: None,
    })
}

/// 以地點清單中的第 n 個地點作為路線的端點或停靠點。
fn place_ref(n: u64) -> PlaceRef {
    PlaceRef::Place(nth(Tag::Place, n))
}

/// 以旅行目的地（Destination_Place）作為路線的端點或停靠點。
const DEST: PlaceRef = PlaceRef::Destination;

/// 停靠點；`n` 只用來產生不重複的 id（停靠點依它在路線中的位置排列，沒有 Ordinal）。
fn stop(
    n: u64,
    place: PlaceRef,
    kind: StopKind,
    task: Option<StopTask>,
    time: Option<Hm>,
    note: &str,
) -> Stop {
    Stop {
        id: id(Tag::Stop, n),
        place,
        kind,
        task,
        note: note.to_owned(),
        time,
        items: Vec::new(),
    }
}

/// 第 n 條路線：第 `on` 天、第 `vehicle` 台車。
fn route(
    n: u64,
    on: u32,
    vehicle: u64,
    from: PlaceRef,
    to: PlaceRef,
    depart: Option<Hm>,
    stops: Vec<Stop>,
) -> Row {
    Row::Route(Route {
        id: nth(Tag::Route, n),
        day: day(on),
        vehicle: nth(Tag::Vehicle, vehicle),
        from,
        to,
        depart,
        stops,
        ordinal: n,
        version: 1,
    })
}

/// 第 `on` 天的每日設定；`place` 是地點清單中的第幾個地點，`None` 是跟著旅行目的地。
fn setting(
    on: u32,
    title: Option<&str>,
    place: Option<u64>,
    arrival: Option<Hm>,
    route_position: RoutePosition,
) -> Row {
    Row::DaySetting(DaySetting {
        day: day(on),
        title: title.map(str::to_owned),
        place: place.map(|place| nth(Tag::Place, place)),
        arrival,
        route_position,
        version: 1,
        arrival_label: None,
    })
}

/// 第 n 筆活動：參加者為全體旅伴、沒有地點、未完成。
fn activity(n: u64, on: u32, time: Hm, kind: ActivityKind, title: &str, note: &str) -> Row {
    Row::Activity(Activity {
        id: nth(Tag::Activity, n),
        day: day(on),
        time,
        title: title.to_owned(),
        kind,
        location: String::new(),
        note: note.to_owned(),
        done: false,
        who: Participation::Everyone,
        ordinal: n,
        version: 1,
    })
}

/// 第 n 道料理：4 人份，沒有用餐時間（使用餐次的預設時間）、負責人、食材與插圖種類（依名稱推斷）。
fn meal(n: u64, on: u32, slot: MealSlot, title: &str, notes: &str) -> Row {
    Row::Meal(Meal {
        id: nth(Tag::Meal, n),
        day: day(on),
        slot,
        time: None,
        title: title.to_owned(),
        cook: None,
        servings: 4,
        ingredients: String::new(),
        notes: notes.to_owned(),
        dish: None,
        ordinal: n,
        version: 1,
    })
}

/// 第 n 個採買品項：未買的 Manual_Item；`assignee` 是第幾位旅伴，`None` 是待分配。
fn item(n: u64, name: &str, assignee: Option<u64>) -> Row {
    Row::Shopping(ShoppingItem {
        id: nth(Tag::Shopping, n),
        name: name.to_owned(),
        quantity: "1 份".to_owned(),
        category: Category::Other,
        assignee: assignee.map(|person| nth(Tag::Person, person)),
        purchased: false,
        source: ItemSource::Manual,
        meal_ids: BTreeSet::new(),
        recipe_removed: None,
        ordinal: n,
        version: 1,
    })
}

/// 第 n 個採買品項：採買同步加入的未買 Meal_Item，待分配，連動第 `meal` 道料理。
fn meal_item(n: u64, name: &str, meal: u64) -> Row {
    Row::Shopping(ShoppingItem {
        id: nth(Tag::Shopping, n),
        name: name.to_owned(),
        quantity: "數量待確認".to_owned(),
        category: Category::Other,
        assignee: None,
        purchased: false,
        source: ItemSource::Meal,
        meal_ids: BTreeSet::from([nth(Tag::Meal, meal)]),
        recipe_removed: None,
        ordinal: n,
        version: 1,
    })
}

/// 同一筆活動，已完成。
fn finished(row: Row) -> Row {
    let Row::Activity(activity) = row else {
        panic!("finished() 只用於活動");
    };
    Row::Activity(Activity {
        done: true,
        ..activity
    })
}

/// 同一道料理，用餐時間是 `time`。
fn served_at(time: Hm, row: Row) -> Row {
    let Row::Meal(meal) = row else {
        panic!("served_at() 只用於料理");
    };
    Row::Meal(Meal {
        time: Some(time),
        ..meal
    })
}

/// 同一道料理，插圖種類設為 `dish`。
fn drawn_as(dish: DishKind, row: Row) -> Row {
    let Row::Meal(meal) = row else {
        panic!("drawn_as() 只用於料理");
    };
    Row::Meal(Meal {
        dish: Some(dish),
        ..meal
    })
}

/// 同一道料理，食材是 `ingredients`。
fn cooked_with(ingredients: &str, row: Row) -> Row {
    let Row::Meal(meal) = row else {
        panic!("cooked_with() 只用於料理");
    };
    Row::Meal(Meal {
        ingredients: ingredients.to_owned(),
        ..meal
    })
}

/// 同一個採買品項，已買。
fn purchased(row: Row) -> Row {
    let Row::Shopping(item) = row else {
        panic!("purchased() 只用於採買品項");
    };
    Row::Shopping(ShoppingItem {
        purchased: true,
        ..item
    })
}

// ── 需求 33.11 的情況 ──

/// 需求 31.2：沒有車輛時，車輛行是「車輛：尚未安排」；旅伴不影響這一行。
#[test]
fn no_vehicles() {
    let s = trip(
        "森林小旅行",
        "夕淞度日營區",
        1,
        [
            person(1, "小安"),
            setting(1, Some("向山裡出發"), None, None, RoutePosition::Before),
            activity(1, 1, at(9, 0), ActivityKind::Meet, "集合出發", ""),
        ],
    );
    assert_text(
        &s,
        &[
            "森林小旅行",
            "車輛：尚未安排",
            "第 1 天・10/20（週二）｜向山裡出發",
            "地點：夕淞度日營區",
            "活動",
            "・09:00 集合出發（集合）",
        ],
    );
}

/// 需求 31.3、31.4：沒有當日標題的一天寫「未命名的一天」（第 1、2 天）；每日設定的地點是地點清單中的地點時寫它的
/// 名稱（第 1 天）。旅行目的地是空的，所以沒有設定地點的日子沒有 Day_Place，寫「地點：未指定」：第 2 天沒有每日設定，
/// 第 3 天的每日設定只有標題。
#[test]
fn day_titles_and_day_places() {
    let s = trip(
        "湖邊小旅行",
        "",
        3,
        [
            vehicle(1, "小黃", None, &[]),
            place(1, "湖畔木棧道"),
            setting(1, None, Some(1), None, RoutePosition::Before),
            setting(3, Some("回家"), None, None, RoutePosition::Before),
            activity(1, 1, at(8, 0), ActivityKind::Wake, "起床", ""),
        ],
    );
    assert_text(
        &s,
        &[
            "湖邊小旅行",
            "車輛：小黃",
            "第 1 天・10/20（週二）｜未命名的一天",
            "地點：湖畔木棧道",
            "活動",
            "・08:00 起床（起床）",
            "第 2 天・10/21（週三）｜未命名的一天",
            "地點：未指定",
            "活動",
            "無安排",
            "第 3 天・10/22（週四）｜回家",
            "地點：未指定",
            "活動",
            "無安排",
        ],
    );
}

/// 需求 31.2、31.9：第 2 天只有每日設定的標題，沒有路線、活動與料理：路線區塊沒有任何行，「活動」之後只有
/// 「無安排」。
#[test]
fn a_day_without_routes_activities_or_meals() {
    let s = trip(
        "山裡兩日",
        "夕淞度日營區",
        2,
        [
            vehicle(1, "小黃", None, &[]),
            place(1, "台北車站"),
            route(1, 1, 1, place_ref(1), DEST, Some(at(8, 0)), vec![]),
            setting(2, Some("在營地發呆"), None, None, RoutePosition::Before),
            activity(1, 1, at(13, 0), ActivityKind::Pitch, "搭帳・營地佈置", ""),
        ],
    );
    assert_text(
        &s,
        &[
            "山裡兩日",
            "車輛：小黃",
            "第 1 天・10/20（週二）｜未命名的一天",
            "地點：夕淞度日營區",
            "路線",
            "・小黃｜08:00 出發：台北車站 → 夕淞度日營區",
            "活動",
            "・13:00 搭帳・營地佈置（搭帳）",
            "第 2 天・10/21（週三）｜在營地發呆",
            "地點：夕淞度日營區",
            "活動",
            "無安排",
        ],
    );
}

/// 需求 31.5：同一天的路線依建立順序列出，與出發時間無關。最先建立的是出發時間留空的第二車（「出發時間未填」），
/// 接著是 10:00 的第三車與 08:00 的第一車，正好與路線卡片依出發時間的順序（需求 22.2）相反；車輛行依車輛的建立順序。
#[test]
fn routes_follow_creation_order() {
    let s = trip(
        "三車會合",
        "夕淞度日營區",
        1,
        [
            vehicle(1, "第一車", None, &[]),
            vehicle(2, "第二車", None, &[]),
            vehicle(3, "第三車", None, &[]),
            place(1, "台北車站"),
            place(2, "台中高鐵站"),
            place(3, "新竹"),
            route(1, 1, 2, place_ref(3), DEST, None, vec![]),
            route(2, 1, 3, place_ref(2), DEST, Some(at(10, 0)), vec![]),
            route(3, 1, 1, place_ref(1), DEST, Some(at(8, 0)), vec![]),
        ],
    );
    assert_text(
        &s,
        &[
            "三車會合",
            "車輛：第一車、第二車、第三車",
            "第 1 天・10/20（週二）｜未命名的一天",
            "地點：夕淞度日營區",
            "路線",
            "・第二車｜出發時間未填：新竹 → 夕淞度日營區",
            "・第三車｜10:00 出發：台中高鐵站 → 夕淞度日營區",
            "・第一車｜08:00 出發：台北車站 → 夕淞度日營區",
            "活動",
            "無安排",
        ],
    );
}

/// 需求 31.6、22.8：停靠點寫成「{地點}（{任務}{時間}{：內容}）」，依停靠點在路線中的順序。四種種類各有指定任務與
/// 沒有指定任務（寫種類的預設任務：採買、接人、領取租借裝備、一般停靠）的停靠點；時間有填時是一個半形空格加 HH:MM，
/// 留空時是「・時間未填」；備註留空時省略「：」與內容。這趟旅行沒有採買品項，所以 Shopping_Stop 只有備註。第 2 天的
/// 第一個停靠點是旅行目的地。
#[test]
fn stops_of_every_kind() {
    let s = trip(
        "租車去露營",
        "夕淞度日營區",
        2,
        [
            vehicle(1, "小黃", None, &[]),
            place(1, "台北車站"),
            place(2, "租車站"),
            place(3, "全聯"),
            place(4, "台中高鐵站"),
            place(5, "租借站"),
            place(6, "湖畔木棧道"),
            route(
                1,
                1,
                1,
                place_ref(1),
                DEST,
                Some(at(8, 0)),
                vec![
                    stop(
                        1,
                        place_ref(2),
                        StopKind::Other,
                        Some(StopTask::CarRental),
                        Some(at(8, 0)),
                        "記得帶駕照",
                    ),
                    stop(2, place_ref(3), StopKind::Shop, None, Some(at(9, 0)), ""),
                    stop(3, place_ref(4), StopKind::Pickup, None, None, ""),
                    stop(
                        4,
                        place_ref(5),
                        StopKind::Gear,
                        None,
                        Some(at(10, 30)),
                        "押金 500 元",
                    ),
                ],
            ),
            route(
                2,
                2,
                1,
                place_ref(6),
                place_ref(1),
                Some(at(15, 0)),
                vec![
                    stop(5, DEST, StopKind::Other, None, None, ""),
                    stop(
                        6,
                        place_ref(5),
                        StopKind::Gear,
                        Some(StopTask::GearReturn),
                        Some(at(15, 30)),
                        "",
                    ),
                    stop(
                        7,
                        place_ref(3),
                        StopKind::Shop,
                        Some(StopTask::Shopping),
                        None,
                        "補買早餐",
                    ),
                    stop(
                        8,
                        place_ref(4),
                        StopKind::Pickup,
                        Some(StopTask::PassengerDropoff),
                        Some(at(17, 0)),
                        "阿哲搭 17:30 的高鐵",
                    ),
                    stop(
                        9,
                        place_ref(2),
                        StopKind::Other,
                        Some(StopTask::CarReturn),
                        None,
                        "油要加滿",
                    ),
                ],
            ),
        ],
    );
    assert_text(
        &s,
        &[
            "租車去露營",
            "車輛：小黃",
            "第 1 天・10/20（週二）｜未命名的一天",
            "地點：夕淞度日營區",
            "路線",
            "・小黃｜08:00 出發：台北車站 → 租車站（取租車 08:00：記得帶駕照） → 全聯（採買 09:00） → 台中高鐵站（接人・時間未填） → 租借站（領取租借裝備 10:30：押金 500 元） → 夕淞度日營區",
            "活動",
            "無安排",
            "第 2 天・10/21（週三）｜未命名的一天",
            "地點：夕淞度日營區",
            "路線",
            "・小黃｜15:00 出發：湖畔木棧道 → 夕淞度日營區（一般停靠・時間未填） → 租借站（歸還裝備 15:30） → 全聯（採買・時間未填：補買早餐） → 台中高鐵站（送人下車 17:00：阿哲搭 17:30 的高鐵） → 租車站（還車・時間未填：油要加滿） → 台北車站",
            "活動",
            "無安排",
        ],
    );
}

/// 需求 31.6、31.7：Shopping_Stop 的內容是 Shopping_Plan 分到它的採買品項（已買與未買都算），依採買品項的建立順序以
/// 「、」連接，再以「；」接上備註。小安是小黃的駕駛，分到小黃日期最早、路線上最前面的全聯，恰好 8 項全部列出（甜椒
/// 已買）；同一條路線後面的山下超市，以及第 2 天的全聯（那條路線最先建立，但日期較晚）是同一台車的其他 Shopping_Stop，
/// 沒有採買品項。阿哲與小雨在第二車上，9 項分到家樂福，只列前 7 項再加「、等另外 2 項」（啤酒已買）。兩台車的品項
/// 交錯建立。
#[test]
fn shopping_stop_items() {
    let s = trip(
        "採買日",
        "夕淞度日營區",
        2,
        [
            person(1, "小安"),
            person(2, "阿哲"),
            person(3, "小雨"),
            vehicle(1, "小黃", Some(1), &[]),
            vehicle(2, "第二車", Some(2), &[3]),
            place(1, "台北車站"),
            place(2, "全聯"),
            place(3, "山下超市"),
            place(4, "台中高鐵站"),
            place(5, "家樂福"),
            route(
                1,
                2,
                1,
                DEST,
                DEST,
                Some(at(9, 0)),
                vec![stop(
                    3,
                    place_ref(2),
                    StopKind::Shop,
                    None,
                    Some(at(9, 30)),
                    "補冰塊",
                )],
            ),
            route(
                2,
                1,
                1,
                place_ref(1),
                DEST,
                Some(at(8, 0)),
                vec![
                    stop(
                        1,
                        place_ref(2),
                        StopKind::Shop,
                        None,
                        Some(at(9, 30)),
                        "記得帶保冷袋",
                    ),
                    stop(2, place_ref(3), StopKind::Shop, None, None, ""),
                ],
            ),
            route(
                3,
                1,
                2,
                place_ref(4),
                DEST,
                Some(at(8, 30)),
                vec![stop(
                    4,
                    place_ref(5),
                    StopKind::Shop,
                    None,
                    Some(at(10, 0)),
                    "停車場在地下室",
                )],
            ),
            item(1, "豬肉片", Some(1)),
            item(2, "牛肉片", Some(2)),
            item(3, "高麗菜", Some(1)),
            item(4, "香菇", Some(3)),
            item(5, "雞蛋", Some(1)),
            item(6, "金針菇", Some(2)),
            item(7, "豆腐", Some(1)),
            item(8, "白飯", Some(3)),
            item(9, "洋蔥", Some(1)),
            item(10, "醬油", Some(2)),
            item(11, "玉米", Some(1)),
            purchased(item(12, "啤酒", Some(3))),
            purchased(item(13, "甜椒", Some(1))),
            item(14, "可樂", Some(2)),
            item(15, "冰塊", Some(1)),
            item(16, "洋芋片", Some(3)),
            item(17, "棉花糖", Some(2)),
        ],
    );
    assert_text(
        &s,
        &[
            "採買日",
            "車輛：小黃、第二車",
            "第 1 天・10/20（週二）｜未命名的一天",
            "地點：夕淞度日營區",
            "路線",
            "・小黃｜08:00 出發：台北車站 → 全聯（採買 09:30：豬肉片、高麗菜、雞蛋、豆腐、洋蔥、玉米、甜椒、冰塊；記得帶保冷袋） → 山下超市（採買・時間未填） → 夕淞度日營區",
            "・第二車｜08:30 出發：台中高鐵站 → 家樂福（採買 10:00：牛肉片、香菇、金針菇、白飯、醬油、啤酒、可樂、等另外 2 項；停車場在地下室） → 夕淞度日營區",
            "活動",
            "無安排",
            "第 2 天・10/21（週三）｜未命名的一天",
            "地點：夕淞度日營區",
            "路線",
            "・小黃｜09:00 出發：夕淞度日營區 → 全聯（採買 09:30：補冰塊） → 夕淞度日營區",
            "活動",
            "無安排",
        ],
    );
}

/// 需求 31.8、22.12：抵達行是「預計 {HH:MM} 抵達{Day_Place 的名稱}」，是路線區塊的最後一行，只取每日設定的預計抵達
/// 時間。旅行目的地是空的：第 1 天以地點清單中的地點為 Day_Place、沒有路線，路線區塊只有抵達行；第 2 天沒有 Day_Place，
/// 抵達行是「預計 09:00 抵達」，接在路線之後（與 08:00 的出發時間無關）；第 3 天兩者都沒有，路線區塊只有
/// 「預計 14:00 抵達」。
#[test]
fn arrival_lines() {
    let s = trip(
        "湖邊三日",
        "",
        3,
        [
            vehicle(1, "小黃", None, &[]),
            place(1, "湖畔木棧道"),
            place(2, "山頂停車場"),
            route(1, 2, 1, place_ref(1), place_ref(2), Some(at(8, 0)), vec![]),
            setting(1, None, Some(1), Some(at(10, 30)), RoutePosition::Before),
            setting(2, None, None, Some(at(9, 0)), RoutePosition::Before),
            setting(3, None, None, Some(at(14, 0)), RoutePosition::Before),
            activity(1, 1, at(11, 0), ActivityKind::Free, "湖邊散步", ""),
        ],
    );
    assert_text(
        &s,
        &[
            "湖邊三日",
            "車輛：小黃",
            "第 1 天・10/20（週二）｜未命名的一天",
            "地點：湖畔木棧道",
            "預計 10:30 抵達湖畔木棧道",
            "活動",
            "・11:00 湖邊散步（自由活動）",
            "第 2 天・10/21（週三）｜未命名的一天",
            "地點：未指定",
            "路線",
            "・小黃｜08:00 出發：湖畔木棧道 → 山頂停車場",
            "預計 09:00 抵達",
            "活動",
            "無安排",
            "第 3 天・10/22（週四）｜未命名的一天",
            "地點：未指定",
            "預計 14:00 抵達",
            "活動",
            "無安排",
        ],
    );
}

/// 需求 31.9、31.11：活動與料理依時間排列，同一時間的活動在料理之前，活動之間與料理之間各依建立順序，所以 12:00 的
/// 咖哩飯雖然最先建立，仍排在兩筆 12:00 的活動之後；08:30 的晨間集合最後建立，也排在早餐之前。已完成的「整理營地」
/// 照常列出，也沒有完成狀態。料理的時間是用餐時間，沒有設定時是餐次的預設時間（下午茶設為 12:00，其他使用預設
/// 時間）；料理名稱經需求 31.14 處理後是空的（早餐、消夜），或與餐次相同（下午茶、晚餐）時只寫餐次。
#[test]
fn same_time_events_done_activities_and_meal_titles() {
    let s = trip(
        "慢活一日",
        "夕淞度日營區",
        1,
        [
            meal(1, 1, MealSlot::Lunch, "咖哩飯", ""),
            finished(activity(
                2,
                1,
                at(12, 0),
                ActivityKind::Camp,
                "整理營地",
                "",
            )),
            activity(3, 1, at(12, 0), ActivityKind::Free, "午休", ""),
            served_at(at(12, 0), meal(4, 1, MealSlot::AfternoonTea, "下午茶", "")),
            meal(5, 1, MealSlot::Breakfast, "", ""),
            meal(6, 1, MealSlot::Dinner, " 晚餐\u{3000}", ""),
            meal(7, 1, MealSlot::LateNight, "\u{3000}", ""),
            activity(8, 1, at(8, 30), ActivityKind::Meet, "晨間集合", ""),
        ],
    );
    assert_text(
        &s,
        &[
            "慢活一日",
            "車輛：尚未安排",
            "第 1 天・10/20（週二）｜未命名的一天",
            "地點：夕淞度日營區",
            "活動",
            "・08:30 晨間集合（集合）",
            "・08:30 早餐（早餐）・餐點",
            "・12:00 整理營地（營地時光）",
            "・12:00 午休（自由活動）",
            "・12:00 午餐：咖哩飯（午餐）・餐點",
            "・12:00 下午茶（用餐）・餐點",
            "・18:00 晚餐（用餐）・餐點",
            "・21:00 消夜（用餐）・餐點",
        ],
    );
}

/// 需求 31.11：料理的類別依序取第一個符合的條件。第 1 天的插圖種類 bbq、hotpot、toast 與 breakfast 分別是烤肉、火鍋、
/// 早餐與早餐，與餐次無關（這四道的名稱都推斷不出插圖種類）。第 2 天是其他插圖種類，類別依餐次：早餐為「早餐」、午餐為
/// 「午餐」、下午茶、晚餐與消夜為「用餐」；「烤肉飯」設定了 curry，所以不是由名稱推斷的 bbq，鬆餅沒有設定插圖種類，推斷
/// 為 custom。第 3 天沒有設定插圖種類，由名稱推斷為 hotpot（麻辣火鍋）與 breakfast（起司貝果）。
#[test]
fn meal_categories() {
    let s = trip(
        "吃飯皇帝大",
        "夕淞度日營區",
        3,
        [
            drawn_as(
                DishKind::Bbq,
                meal(1, 1, MealSlot::Breakfast, "炭火香腸", ""),
            ),
            drawn_as(DishKind::Hotpot, meal(2, 1, MealSlot::Lunch, "大鍋菜", "")),
            drawn_as(
                DishKind::Toast,
                meal(3, 1, MealSlot::AfternoonTea, "熱壓點心", ""),
            ),
            drawn_as(
                DishKind::Breakfast,
                meal(4, 1, MealSlot::Dinner, "法式拼盤", ""),
            ),
            drawn_as(
                DishKind::Salad,
                meal(5, 2, MealSlot::Breakfast, "蔬菜沙拉", ""),
            ),
            drawn_as(DishKind::Curry, meal(6, 2, MealSlot::Lunch, "烤肉飯", "")),
            meal(7, 2, MealSlot::AfternoonTea, "鬆餅", ""),
            drawn_as(
                DishKind::Pasta,
                meal(8, 2, MealSlot::Dinner, "番茄義大利麵", ""),
            ),
            drawn_as(
                DishKind::Custom,
                meal(9, 2, MealSlot::LateNight, "宵夜粥", ""),
            ),
            meal(10, 3, MealSlot::Lunch, "麻辣火鍋", ""),
            meal(11, 3, MealSlot::LateNight, "起司貝果", ""),
        ],
    );
    assert_text(
        &s,
        &[
            "吃飯皇帝大",
            "車輛：尚未安排",
            "第 1 天・10/20（週二）｜未命名的一天",
            "地點：夕淞度日營區",
            "活動",
            "・08:30 早餐：炭火香腸（烤肉）・餐點",
            "・12:00 午餐：大鍋菜（火鍋）・餐點",
            "・15:00 下午茶：熱壓點心（早餐）・餐點",
            "・18:00 晚餐：法式拼盤（早餐）・餐點",
            "第 2 天・10/21（週三）｜未命名的一天",
            "地點：夕淞度日營區",
            "活動",
            "・08:30 早餐：蔬菜沙拉（早餐）・餐點",
            "・12:00 午餐：烤肉飯（午餐）・餐點",
            "・15:00 下午茶：鬆餅（用餐）・餐點",
            "・18:00 晚餐：番茄義大利麵（用餐）・餐點",
            "・21:00 消夜：宵夜粥（用餐）・餐點",
            "第 3 天・10/22（週四）｜未命名的一天",
            "地點：夕淞度日營區",
            "活動",
            "・12:00 午餐：麻辣火鍋（火鍋）・餐點",
            "・21:00 消夜：起司貝果（早餐）・餐點",
        ],
    );
}

/// 需求 31.10：活動與料理的備註不是空白時，緊接在那一行之後另起一行，以兩個半形空格開頭；備註是空的（森林健行）或
/// 只有空白（烤肉派對的筆記是空格、全形空白、換行與 Tab）時沒有備註行。
#[test]
fn note_lines() {
    let s = trip(
        "慢慢吃",
        "夕淞度日營區",
        1,
        [
            activity(1, 1, at(9, 0), ActivityKind::Meet, "集合出發", "記得帶頭燈"),
            activity(2, 1, at(10, 0), ActivityKind::Free, "森林健行", ""),
            meal(1, 1, MealSlot::Lunch, "咖哩飯", "先把飯煮好"),
            meal(2, 1, MealSlot::Dinner, "烤肉派對", " \u{3000}\n\t"),
        ],
    );
    assert_text(
        &s,
        &[
            "慢慢吃",
            "車輛：尚未安排",
            "第 1 天・10/20（週二）｜未命名的一天",
            "地點：夕淞度日營區",
            "活動",
            "・09:00 集合出發（集合）",
            "  記得帶頭燈",
            "・10:00 森林健行（自由活動）",
            "・12:00 午餐：咖哩飯（午餐）・餐點",
            "  先把飯煮好",
            "・18:00 晚餐：烤肉派對（烤肉）・餐點",
        ],
    );
}

/// 需求 31.12：路線位置為「路線在活動之後」的日子，在「地點」行之後先輸出整個活動區塊，再輸出整個路線區塊與抵達行。
/// 第 1 天沒有每日設定，路線在活動之前；第 2 天以地點清單中的湖畔木棧道為 Day_Place（取代旅行目的地）；第 3 天沒有
/// 路線、活動與料理，「無安排」之後只有抵達行。
#[test]
fn route_block_after_activities() {
    let s = trip(
        "湖邊與營地",
        "夕淞度日營區",
        3,
        [
            vehicle(1, "小黃", None, &[]),
            place(1, "台北車站"),
            place(2, "湖畔木棧道"),
            place(3, "台中高鐵站"),
            route(1, 1, 1, place_ref(1), DEST, Some(at(8, 0)), vec![]),
            route(
                2,
                2,
                1,
                DEST,
                place_ref(2),
                Some(at(13, 0)),
                vec![stop(
                    1,
                    place_ref(3),
                    StopKind::Pickup,
                    None,
                    Some(at(14, 0)),
                    "",
                )],
            ),
            setting(
                2,
                Some("轉往湖邊"),
                Some(2),
                Some(at(15, 30)),
                RoutePosition::After,
            ),
            setting(
                3,
                Some("在湖邊發呆"),
                Some(2),
                Some(at(10, 0)),
                RoutePosition::After,
            ),
            activity(1, 1, at(13, 0), ActivityKind::Pitch, "搭帳・營地佈置", ""),
            activity(2, 2, at(8, 0), ActivityKind::Wake, "起床", ""),
            activity(3, 2, at(10, 0), ActivityKind::Strike, "拆帳、整理裝備", ""),
        ],
    );
    assert_text(
        &s,
        &[
            "湖邊與營地",
            "車輛：小黃",
            "第 1 天・10/20（週二）｜未命名的一天",
            "地點：夕淞度日營區",
            "路線",
            "・小黃｜08:00 出發：台北車站 → 夕淞度日營區",
            "活動",
            "・13:00 搭帳・營地佈置（搭帳）",
            "第 2 天・10/21（週三）｜轉往湖邊",
            "地點：湖畔木棧道",
            "活動",
            "・08:00 起床（起床）",
            "・10:00 拆帳、整理裝備（拆帳）",
            "路線",
            "・小黃｜13:00 出發：夕淞度日營區 → 台中高鐵站（接人 14:00） → 湖畔木棧道",
            "預計 15:30 抵達湖畔木棧道",
            "第 3 天・10/22（週四）｜在湖邊發呆",
            "地點：湖畔木棧道",
            "活動",
            "無安排",
            "預計 10:00 抵達湖畔木棧道",
        ],
    );
}

/// 需求 31.13：最後一天的區塊之後是「未分配採買清單」，依建立順序列出負責人為待分配的品項，已買的衛生紙也列出。
/// 豬肉片分到小黃的全聯；阿哲在第二車上，第二車沒有 Shopping_Stop，小雨不在任何車上，所以木炭與防蚊液雖然也在
/// Unassigned_Shopping 中，仍不列在這個區塊。
#[test]
fn unassigned_shopping_lists_only_items_without_an_assignee() {
    let s = trip(
        "分工採買",
        "夕淞度日營區",
        2,
        [
            person(1, "小安"),
            person(2, "阿哲"),
            person(3, "小雨"),
            vehicle(1, "小黃", Some(1), &[]),
            vehicle(2, "第二車", None, &[2]),
            place(1, "台北車站"),
            place(2, "全聯"),
            place(3, "台中高鐵站"),
            route(
                1,
                1,
                1,
                place_ref(1),
                DEST,
                Some(at(8, 0)),
                vec![stop(
                    1,
                    place_ref(2),
                    StopKind::Shop,
                    None,
                    Some(at(9, 0)),
                    "",
                )],
            ),
            route(2, 1, 2, place_ref(3), DEST, Some(at(8, 30)), vec![]),
            item(1, "冰塊", None),
            item(2, "豬肉片", Some(1)),
            item(3, "木炭", Some(2)),
            item(4, "防蚊液", Some(3)),
            purchased(item(5, "衛生紙", None)),
            item(6, "打火機", None),
        ],
    );
    assert_text(
        &s,
        &[
            "分工採買",
            "車輛：小黃、第二車",
            "第 1 天・10/20（週二）｜未命名的一天",
            "地點：夕淞度日營區",
            "路線",
            "・小黃｜08:00 出發：台北車站 → 全聯（採買 09:00：豬肉片） → 夕淞度日營區",
            "・第二車｜08:30 出發：台中高鐵站 → 夕淞度日營區",
            "活動",
            "無安排",
            "第 2 天・10/21（週三）｜未命名的一天",
            "地點：夕淞度日營區",
            "活動",
            "無安排",
            "未分配採買清單",
            "・冰塊",
            "・衛生紙",
            "・打火機",
        ],
    );
}

/// 需求 31.13：沒有負責人為待分配的品項時沒有「未分配採買清單」，文字在最後一天的區塊結束；木炭（第二車沒有路線）與
/// 已買的防蚊液（小雨不在任何車上）在 Unassigned_Shopping 中，但不是待分配。
#[test]
fn no_unassigned_shopping_block_without_such_items() {
    let s = trip(
        "分工採買",
        "夕淞度日營區",
        1,
        [
            person(1, "小安"),
            person(2, "阿哲"),
            person(3, "小雨"),
            vehicle(1, "小黃", Some(1), &[]),
            vehicle(2, "第二車", None, &[2]),
            place(1, "台北車站"),
            place(2, "全聯"),
            route(
                1,
                1,
                1,
                place_ref(1),
                DEST,
                Some(at(8, 0)),
                vec![stop(
                    1,
                    place_ref(2),
                    StopKind::Shop,
                    None,
                    Some(at(9, 0)),
                    "",
                )],
            ),
            item(1, "豬肉片", Some(1)),
            item(2, "木炭", Some(2)),
            purchased(item(3, "防蚊液", Some(3))),
        ],
    );
    assert_text(
        &s,
        &[
            "分工採買",
            "車輛：小黃、第二車",
            "第 1 天・10/20（週二）｜未命名的一天",
            "地點：夕淞度日營區",
            "路線",
            "・小黃｜08:00 出發：台北車站 → 全聯（採買 09:00：豬肉片） → 夕淞度日營區",
            "活動",
            "無安排",
        ],
    );
}

/// 需求 31.14：每段使用者文字先 Trim_White，再把含換行字元的連續空白換成一個半形空格；不含換行字元的連續空白
/// （兩個空格、Tab、兩個全形空白）保留原樣，文字也不跳脫。換行字元依序出現在旅行名稱（U+000A）、旅行目的地
/// （U+000D U+000A）、車名（U+2028）、地點名稱（U+2029，與採買品項名稱）、當日標題（U+000B）、停靠點備註（U+000C，
/// 前後各有一個空格）、活動標題（空格、Tab、U+000A、空格）、活動備註（U+0085）與料理名稱。前後空白出現在料理的名稱與
/// 筆記，以及 Ingredient_Parser 從「U+0085 加雞蛋」切出、仍以 U+0085 開頭的 Meal_Item 名稱。
#[test]
fn user_text_is_cleaned() {
    let s = trip(
        "向山\n裡出發",
        "夕淞\r\n度日營區",
        1,
        [
            person(1, "小安"),
            vehicle(1, "小黃\u{2028}號", Some(1), &[]),
            place(1, "湖畔\u{2029}木棧道"),
            place(2, "山下  超市"),
            route(
                1,
                1,
                1,
                place_ref(1),
                DEST,
                Some(at(8, 0)),
                vec![stop(
                    1,
                    place_ref(2),
                    StopKind::Shop,
                    None,
                    Some(at(8, 30)),
                    "記得 \u{c} 帶冰塊 & 保冷袋",
                )],
            ),
            setting(1, Some("森林\u{b}小徑"), None, None, RoutePosition::Before),
            activity(
                1,
                1,
                at(9, 0),
                ActivityKind::Meet,
                "集合 \t\n 出發 <準時>",
                "帶水壺\u{85}和外套\t兩個  空格",
            ),
            cooked_with(
                "\u{85}雞蛋",
                meal(
                    1,
                    1,
                    MealSlot::Dinner,
                    " \u{3000}烤肉\r\n派對 ",
                    "\n先醃肉\u{3000}\u{3000}再烤 \n",
                ),
            ),
            item(1, "豬肉\u{2029}片", Some(1)),
            item(2, "冰塊\t兩包", None),
            meal_item(3, "\u{85}雞蛋", 1),
        ],
    );
    assert_text(
        &s,
        &[
            "向山 裡出發",
            "車輛：小黃 號",
            "第 1 天・10/20（週二）｜森林 小徑",
            "地點：夕淞 度日營區",
            "路線",
            "・小黃 號｜08:00 出發：湖畔 木棧道 → 山下  超市（採買 08:30：豬肉 片；記得 帶冰塊 & 保冷袋） → 夕淞 度日營區",
            "活動",
            "・09:00 集合 出發 <準時>（集合）",
            "  帶水壺 和外套\t兩個  空格",
            "・18:00 晚餐：烤肉 派對（烤肉）・餐點",
            "  先醃肉\u{3000}\u{3000}再烤",
            "未分配採買清單",
            "・冰塊\t兩包",
            "・雞蛋",
        ],
    );
}
