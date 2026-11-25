//! 範例旅行（Example_Trip）：移植自 `tests/fixtures/example-trip.js` 的 `exampleTrip()`（需求 33.2）。
//!
//! 三天兩夜（2026-10-20 到 10-22）的「夕淞度日」，目的地是「夕淞度日營區」：8 位旅伴、4 台車、6 個地點；第 1 天四台車
//! 從各自的出發地點開往營區（第三車・採買組途中在超市／賣場採買）、第 3 天四台車回台北，共 8 條路線；10 筆活動、5 道
//! 料理與 18 個採買品項。s1–s8 是手動品項（s1–s3 由小雨、s4–s8 由大海負責，兩人都在第三車・採買組上）；s9–s18 是
//! 現行 `syncMealIngredients()` 依料理的食材加入的 Meal_Item（待分配）。現行的範例已經執行過採買同步，所以再同步一次
//! 不改變狀態。
//!
//! 現行的陣列順序改以 Ordinal 表示：每一列的 Ordinal 是它在現行陣列中的位置（從 1 起）；id 是 `support::ids` 的
//! `id(Tag::…, k)`，k 與 Ordinal 相同，例如 p3 是 `id(Tag::Person, 3)`、s12 是 `id(Tag::Shopping, 12)`。地點依序是
//! pl-a、pl-b、pl-c、pl-d、pl-shop 與 pl-taipei（1–6）；路線依序是 rt-1-v1 到 rt-1-v4（1–4）與 rt-3-v1 到 rt-3-v4
//! （5–8）。旅行是 `id(Tag::Trip, 1)`，唯一的停靠點 st-1 是 `id(Tag::Stop, 1)`。Trip_Card 的 Row_Version 是 0，
//! 其他列是 1。
//!
//! 現行的欄位與第一版資料型別的對應：
//!
//! - 旅行沒有封面與狀態，使用現行的預設值 camp 與規劃中。`schema`、`revision`、`currentUser` 與 `joined` 是本機規劃
//!   的欄位，第一版沒有；旅伴都沒有綁定帳號。
//! - 車輛的 `meeting` 是第一版沒有的舊出發欄位；車輛都沒有設定顏色。
//! - 活動的 `people: []`（沒有 `vehicleIds`）是全體旅伴。
//! - 料理沒有用餐時間（使用餐次的預設時間）、負責人（`cookId: ''`）與插圖種類（由名稱與食材推斷）。
//! - 採買品項的 `done` 是已買，負責人 `''` 是待分配；Meal_Item 的分類是現行 Ingredient_Classifier 的結果，連動的
//!   料理是 `mealIds`，都沒有「料理已移除」標記。
//! - 每日設定只有標題，第 1 天另有預計抵達時間 12:00（現行的 `arrival`；行程繪本的抵達文字 `arrivalLabel` 不在
//!   第一版，範例也沒有設定）；沒有地點與路線位置，所以每一天都跟著旅行目的地、路線在活動之前。停靠點 st-1 沒有
//!   任務、時間與備註。
//! - 沒有裝備、出發確認（`departed: []`）與帳目；舊的 `events: []` 不移植。

use std::collections::BTreeSet;

use lm_core::ids::PersonId;
use lm_core::model::{
    Activity, ActivityKind, Category, Color, CoverKind, Date, DaySetting, ItemSource, Meal,
    MealSlot, Participation, Person, Place, PlaceRef, Route, RoutePosition, Row, ShoppingItem,
    Stop, StopKind, TripCard, TripState, TripStatus, Vehicle,
};
use lm_core::time::Hm;

use super::ids::{id, Tag};

/// 現行 `exampleTrip()` 的 Trip_State；每次呼叫都回傳新的一份，呼叫端可以任意修改。
pub fn example_trip() -> TripState {
    let mut state = TripState::new(TripCard {
        id: id(Tag::Trip, 1),
        title: "夕淞度日".to_owned(),
        destination: "夕淞度日營區".to_owned(),
        start: day(1),
        end: day(3),
        description: "一起，把日子過慢一點。\n把喜歡的小地方，畫進我們的旅程。".to_owned(),
        note: String::new(),
        cover: CoverKind::Camp,
        status: TripStatus::Planning,
        version: 0,
        caption: String::new(),
        headline: String::new(),
    });
    for row in rows() {
        state.put(row);
    }
    state
}

/// Trip_Card 以外的每一列，依現行 Trip_State 的欄位順序。
fn rows() -> Vec<Row> {
    let shop_stop = Stop {
        id: id(Tag::Stop, 1),
        place: place_ref(5),
        kind: StopKind::Shop,
        task: None,
        note: String::new(),
        time: None,
        items: Vec::new(),
    };
    vec![
        person(1, "小安", Color::Coral, "這趟的召集人"),
        person(2, "阿哲", Color::Blue, "咖啡擔當"),
        person(3, "小雨", Color::Green, "料理小隊長"),
        person(4, "阿森", Color::Yellow, "營火守護者"),
        person(5, "米米", Color::Lavender, "底片記錄員"),
        person(6, "大海", Color::Peach, "路上的 DJ"),
        person(7, "阿凱", Color::Coral, "帳篷工程師"),
        person(8, "小芸", Color::Blue, "甜點擔當"),
        activity(1, 1, at(13, 0), "搭帳・營地佈置", ActivityKind::Pitch),
        activity(2, 1, at(20, 0), "星空夜聊・自由活動", ActivityKind::Night),
        activity(3, 2, at(8, 0), "起床", ActivityKind::Wake),
        activity(4, 2, at(10, 0), "自由活動、拍照", ActivityKind::Free),
        activity(5, 2, at(14, 0), "下午茶、聊天、玩遊戲", ActivityKind::Tea),
        activity(6, 2, at(20, 0), "自由活動", ActivityKind::Night),
        activity(7, 3, at(8, 0), "起床", ActivityKind::Wake),
        activity(8, 3, at(10, 0), "拆帳、整理裝備", ActivityKind::Strike),
        activity(9, 3, at(11, 30), "環境清潔、裝車", ActivityKind::Clean),
        activity(10, 3, at(12, 0), "四車集合、返程", ActivityKind::Return),
        meal(1, 1, MealSlot::Dinner, "烤肉派對", ""),
        meal(2, 2, MealSlot::Breakfast, "早餐", "培根、炒蛋、吐司、咖啡"),
        meal(3, 2, MealSlot::Lunch, "午餐", "台式炒泡麵、香腸、煎蛋"),
        meal(4, 2, MealSlot::Dinner, "豪華火鍋", ""),
        meal(
            5,
            3,
            MealSlot::Breakfast,
            "早餐",
            "蘿蔔糕、荷包蛋、熱狗、咖啡",
        ),
        manual_item(1, "五花肉片", "2 盒", Category::Meat, 3),
        manual_item(2, "鮮蝦", "1 盒", Category::Seafood, 3),
        manual_item(3, "高麗菜", "1 顆", Category::Vegetables, 3),
        manual_item(4, "運動飲料", "8 瓶", Category::Drinks, 6),
        manual_item(5, "洋芋片", "3 包", Category::Snacks, 6),
        manual_item(6, "瓦斯", "4 罐", Category::Other, 6),
        manual_item(7, "衛生紙", "1 串", Category::Other, 6),
        manual_item(8, "免洗餐具", "1 組", Category::Other, 6),
        // syncMealIngredients() 依料理的順序、再依食材的順序加入；咖啡同時是 m2 與 m5 的食材
        meal_item(9, "培根", Category::Meat, &[2]),
        meal_item(10, "炒蛋", Category::Other, &[2]),
        meal_item(11, "吐司", Category::Staples, &[2]),
        meal_item(12, "咖啡", Category::Drinks, &[2, 5]),
        meal_item(13, "台式炒泡麵", Category::Staples, &[3]),
        meal_item(14, "香腸", Category::Meat, &[3]),
        meal_item(15, "煎蛋", Category::Other, &[3]),
        meal_item(16, "蘿蔔糕", Category::Other, &[5]),
        meal_item(17, "荷包蛋", Category::Other, &[5]),
        meal_item(18, "熱狗", Category::Meat, &[5]),
        vehicle(1, "第一車", 1, 2),
        vehicle(2, "第二車", 4, 5),
        vehicle(3, "第三車・採買組", 3, 6),
        vehicle(4, "第四車", 7, 8),
        place(1, "出發地點 A"),
        place(2, "出發地點 B"),
        place(3, "出發地點 C"),
        place(4, "出發地點 D"),
        place(5, "超市／賣場"),
        place(6, "台北"),
        route(1, 1, 1, place_ref(1), CAMP, at(8, 0), Vec::new()),
        route(2, 1, 2, place_ref(2), CAMP, at(8, 30), Vec::new()),
        route(3, 1, 3, place_ref(3), CAMP, at(9, 0), vec![shop_stop]),
        route(4, 1, 4, place_ref(4), CAMP, at(9, 30), Vec::new()),
        route(5, 3, 1, CAMP, place_ref(6), at(12, 0), Vec::new()),
        route(6, 3, 2, CAMP, place_ref(6), at(12, 0), Vec::new()),
        route(7, 3, 3, CAMP, place_ref(6), at(12, 0), Vec::new()),
        route(8, 3, 4, CAMP, place_ref(6), at(12, 0), Vec::new()),
        // 都沒有設定地點，所以每一天的地點都是旅行目的地
        day_setting(1, "向山裡出發", Some(at(12, 0))),
        day_setting(2, "住進慢慢的日子", None),
        day_setting(3, "把快樂一起帶回家", None),
    ]
}

/// 旅行目的地（Destination_Place，現行的 `DESTINATION_REF`）：夕淞度日營區。
const CAMP: PlaceRef = PlaceRef::Destination;

/// 範例旅行的第 n 天（1–3）：2026-10-20（週二）是第 1 天。
fn day(n: u32) -> Date {
    u8::try_from(19 + n)
        .ok()
        .and_then(|day| lm_core::time::ymd(2026, 10, day))
        .expect("有效的日期")
}

fn at(hour: u8, minute: u8) -> Hm {
    Hm::new(hour, minute).expect("有效的時刻")
}

/// 第 n 位旅伴（p{n}）。
fn person_id(n: u64) -> PersonId {
    id(Tag::Person, n)
}

/// 地點清單中的第 n 個地點。
fn place_ref(n: u64) -> PlaceRef {
    PlaceRef::Place(id(Tag::Place, n))
}

fn person(n: u64, name: &str, color: Color, role: &str) -> Row {
    Row::Person(Person {
        id: person_id(n),
        name: name.to_owned(),
        role: role.to_owned(),
        color,
        bound: false,
        ordinal: n,
        version: 1,
    })
}

/// 參加者為全體旅伴、沒有地點與備註、未完成的活動。
fn activity(n: u64, on: u32, time: Hm, title: &str, kind: ActivityKind) -> Row {
    Row::Activity(Activity {
        id: id(Tag::Activity, n),
        day: day(on),
        time,
        title: title.to_owned(),
        kind,
        location: String::new(),
        note: String::new(),
        done: false,
        who: Participation::Everyone,
        ordinal: n,
        version: 1,
    })
}

/// 8 人份、沒有用餐時間、負責人、筆記與插圖種類的料理。
fn meal(n: u64, on: u32, slot: MealSlot, title: &str, ingredients: &str) -> Row {
    Row::Meal(Meal {
        id: id(Tag::Meal, n),
        day: day(on),
        slot,
        time: None,
        title: title.to_owned(),
        cook: None,
        servings: 8,
        ingredients: ingredients.to_owned(),
        notes: String::new(),
        dish: None,
        ordinal: n,
        version: 1,
    })
}

/// 未買的 Manual_Item，由第 `assignee` 位旅伴負責。
fn manual_item(n: u64, name: &str, quantity: &str, category: Category, assignee: u64) -> Row {
    Row::Shopping(ShoppingItem {
        id: id(Tag::Shopping, n),
        name: name.to_owned(),
        quantity: quantity.to_owned(),
        category,
        assignee: Some(person_id(assignee)),
        purchased: false,
        source: ItemSource::Manual,
        meal_ids: BTreeSet::new(),
        recipe_removed: None,
        ordinal: n,
        version: 1,
    })
}

/// 採買同步加入的未買 Meal_Item：數量待確認、待分配，連動第 `meals` 道料理。
fn meal_item(n: u64, name: &str, category: Category, meals: &[u64]) -> Row {
    Row::Shopping(ShoppingItem {
        id: id(Tag::Shopping, n),
        name: name.to_owned(),
        quantity: "數量待確認".to_owned(),
        category,
        assignee: None,
        purchased: false,
        source: ItemSource::Meal,
        meal_ids: meals.iter().map(|&meal| id(Tag::Meal, meal)).collect(),
        recipe_removed: None,
        ordinal: n,
        version: 1,
    })
}

/// 4 人座、沒有設定顏色的車，駕駛與一位乘客。
fn vehicle(n: u64, name: &str, driver: u64, passenger: u64) -> Row {
    Row::Vehicle(Vehicle {
        id: id(Tag::Vehicle, n),
        name: name.to_owned(),
        driver: Some(person_id(driver)),
        seats: 4,
        color: None,
        passengers: BTreeSet::from([person_id(passenger)]),
        ordinal: n,
        version: 1,
    })
}

fn place(n: u64, name: &str) -> Row {
    Row::Place(Place {
        id: id(Tag::Place, n),
        name: name.to_owned(),
        ordinal: n,
        version: 1,
        template: None,
    })
}

/// 第 n 條路線：第 `on` 天，第 `vehicle` 台車。
fn route(
    n: u64,
    on: u32,
    vehicle: u64,
    from: PlaceRef,
    to: PlaceRef,
    depart: Hm,
    stops: Vec<Stop>,
) -> Row {
    Row::Route(Route {
        id: id(Tag::Route, n),
        day: day(on),
        vehicle: id(Tag::Vehicle, vehicle),
        from,
        to,
        depart: Some(depart),
        stops,
        ordinal: n,
        version: 1,
    })
}

/// 第 `on` 天的每日設定：只有標題與預計抵達時間。
fn day_setting(on: u32, title: &str, arrival: Option<Hm>) -> Row {
    Row::DaySetting(DaySetting {
        day: day(on),
        title: Some(title.to_owned()),
        place: None,
        arrival,
        route_position: RoutePosition::Before,
        version: 1,
        arrival_label: None,
    })
}
