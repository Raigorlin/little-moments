//! `itinerary_text()`：行程表的文字版（Itinerary_Text，需求 31）。
//!
//! 格式維持現行行程繪本「複製文字」複製的文字（前言 U8、design A10 與已確認 5）：`src/storybook/app.js` 的
//! `renderItinerary()` 決定各行的內容與先後，`copyItinerary()` 逐一取出 `h3`、`h4`、`p` 與 `li` 的文字（`li` 前面加
//! 「・」）並以 `\n` 連接，資料由 `src/storybook-adapter.js` 的 `project()` 整理。與現行的差異只有 U7 的兩處：
//!
//! - 活動與料理不是空白的備註另起一行，以兩個半形空格開頭（需求 31.10）；現行以 `li.textContent` 擷取，備註接在同一行
//!   的最後。
//! - 抵達行是「預計 {HH:MM} 抵達{Day_Place 的名稱}」，只取規劃者填寫的預計抵達時間（需求 31.8、22.12）；現行是繪本的
//!   自由文字 `arrivalLabel`。
//!
//! 只屬於行程繪本的標語、說明與非採買停靠點的自訂品項不在第一版，所以不輸出（需求 31.2、31.6）。下列兩處依需求，與現行
//! 程式不同：
//!
//! - 每段使用者文字都先經 `clean_text()`（需求 31.14）。現行只這樣處理料理標題與採買品項名稱，旅行名稱、車名、地點名稱與
//!   旅行目的地、當日標題、停靠點備註與活動標題照原樣放進文字，其中的換行（例如 U+2028）在複製的文字中會變成另一行。
//! - 使用者文字的前後只以 Trim_White 去除空白。現行 `copyItinerary()` 另以 JavaScript 的 `trim()` 修剪每一行，所以位在
//!   行首或行尾的 U+FEFF（是 JS_Whitespace，不是 White_Space）也被去掉；這裡保留。
//!
//! 名稱經 `clean_text()` 之後是空字串的採買品項（例如名稱只有 U+0085 的 Meal_Item）：在 Shopping_Stop 與現行 `project()`
//! 的 `derivedItems` 相同，先略過這些品項，再決定是否只列前 7 項（需求 31.7 沒有規定）；在「未分配採買清單」依需求 31.13
//! 照常輸出一行「・」，與現行相同。

use crate::ids::ShoppingId;
use crate::itinerary::{
    day_arrival, day_events, day_place, day_routes_by_ordinal, meal_category, meal_title,
    place_name, shopping_plan, stop_task, trip_days, DayEvent, ShoppingPlan, UnassignedCode,
};
use crate::model::{Date, PlaceRef, Route, RoutePosition, Stop, StopKind, TripState};
use crate::text::clean_text;
use crate::time::date_text;

/// 需求 31.7：Shopping_Stop 的採買品項超過這個數目時，只列前 [`STOP_ITEMS_SHOWN`] 項，再接「等另外 N 項」。
const STOP_ITEMS_MAX: usize = 8;
/// 需求 31.7：超過 [`STOP_ITEMS_MAX`] 項時列出的品項數。
const STOP_ITEMS_SHOWN: usize = 7;

/// 需求 31.2–31.14、31.18：這趟旅行的 Itinerary_Text。只由 Trip_State 的內容與順序鍵（日期、時間與 Ordinal）決定，與列
/// 插入的順序、檢視的 Account、裝置的時區與語系，以及產生的時間都無關（需求 31.1）。依序是下列各行：
///
/// ```text
/// {旅行名稱}
/// 車輛：{車名}、{車名}…（沒有車輛時為「車輛：尚未安排」）
/// 每個 Trip_Day 依日期遞增各一個區塊：
///   第 {n} 天・{M/D}（週{X}）｜{當日標題，沒有時為「未命名的一天」}
///   地點：{Day_Place 的名稱，沒有時為「未指定」}
///   路線區塊：
///     路線（這一天有路線時）
///     ・{車名}｜{HH:MM} 出發：{起點} → {停靠點} → … → {終點}（依路線的建立順序；出發時間留空時為「出發時間未填」）
///     預計 {HH:MM} 抵達{Day_Place 的名稱}（有預計抵達時間時）
///   活動區塊：
///     活動
///     ・{HH:MM} {標題}（{類別}），料理再加「・餐點」（沒有任何活動與料理時為「無安排」一行）
///       {備註}（備註不是空白時，以兩個半形空格開頭）
/// 未分配採買清單（有負責人為待分配的採買品項時）
/// ・{品項名稱}
/// ```
///
/// 停靠點寫成「{地點}（{任務}{ HH:MM，留空時為「・時間未填」}{：採買品項；備註}）」。每日設定的路線位置為「路線在活動
/// 之後」時，那一天的活動區塊在路線區塊（包括抵達行）之前（需求 31.12）。各行以一個 `\n` 分隔，區塊之間不加空行，第一行
/// 之前與最後一行之後都沒有換行字元；使用者文字都經 `clean_text()`，所以換行字元只有分隔各行的 `\n`。
///
/// 輸入是 `validate::state()` 成立的狀態；不是這趟旅行的車輛與地點（只在無效的狀態）寫成空字串。
pub fn itinerary_text(s: &TripState) -> String {
    let plan = shopping_plan(s);
    let mut lines = vec![clean_text(&s.card.title), vehicles_line(s)];
    for day in trip_days(s) {
        let setting = s.day_settings.get(&day.date);
        let title = setting
            .and_then(|setting| setting.title.as_deref())
            .map(clean_text)
            .filter(|title| !title.is_empty());
        lines.push(format!(
            "第 {} 天・{}｜{}",
            day.n,
            date_text(day.date),
            title.as_deref().unwrap_or("未命名的一天")
        ));
        let place = day_place(s, day.date).map(|place| place_text(s, place));
        lines.push(format!("地點：{}", place.as_deref().unwrap_or("未指定")));

        let routes = route_block(s, &plan, day.date, place.as_deref());
        let activities = activity_block(s, day.date);
        if setting.is_some_and(|setting| setting.route_position == RoutePosition::After) {
            lines.extend(activities);
            lines.extend(routes);
        } else {
            lines.extend(routes);
            lines.extend(activities);
        }
    }
    lines.extend(unassigned_block(s, &plan));
    lines.join("\n")
}

/// 需求 31.2：「車輛：{車名}、{車名}…」，依車輛的建立順序（Ordinal）；沒有車輛時為「車輛：尚未安排」。
fn vehicles_line(s: &TripState) -> String {
    let names: Vec<String> = s
        .vehicles_by_ordinal()
        .map(|vehicle| clean_text(&vehicle.name))
        .collect();
    if names.is_empty() {
        "車輛：尚未安排".to_owned()
    } else {
        format!("車輛：{}", names.join("、"))
    }
}

/// 需求 31.5、31.8：這一天的路線區塊。有路線時是「路線」一行，接著每條路線一行，依路線的建立順序（現行 `project()` 依
/// `state.routes` 的順序），所以可能與路線卡片依出發時間的 `sorted_routes()` 不同；有預計抵達時間時，最後一行是抵達行，
/// 這一天沒有路線時只有這一行。兩者都沒有時沒有任何行。`place` 是 Day_Place 的名稱。
fn route_block(s: &TripState, plan: &ShoppingPlan, day: Date, place: Option<&str>) -> Vec<String> {
    let mut lines: Vec<String> = day_routes_by_ordinal(s, day)
        .map(|route| format!("・{}", route_text(s, plan, route)))
        .collect();
    if !lines.is_empty() {
        lines.insert(0, "路線".to_owned());
    }
    if let Some(arrival) = day_arrival(s, day) {
        lines.push(format!("預計 {arrival} 抵達{}", place.unwrap_or_default()));
    }
    lines
}

/// 需求 31.5（現行 `routeText()`）：「{車名}｜{HH:MM} 出發：{起點} → {停靠點} → … → {終點}」，停靠點依它在路線中的順序；
/// 出發時間留空時以「出發時間未填」取代「{HH:MM} 出發」。
fn route_text(s: &TripState, plan: &ShoppingPlan, route: &Route) -> String {
    let vehicle = s
        .vehicles
        .get(&route.vehicle)
        .map(|vehicle| clean_text(&vehicle.name))
        .unwrap_or_default();
    let depart = route
        .depart
        .map_or_else(|| "出發時間未填".to_owned(), |time| format!("{time} 出發"));
    let mut parts = vec![place_text(s, route.from)];
    parts.extend(route.stops.iter().map(|stop| stop_text(s, plan, stop)));
    parts.push(place_text(s, route.to));
    format!("{vehicle}｜{depart}：{}", parts.join(" → "))
}

/// 需求 31.6、22.8（現行 `stopText()`）：「{地點}（{任務}{時間}{：內容}）」。任務是指定的任務，沒有指定時是種類的預設
/// 任務；時間有填時是一個半形空格加 HH:MM，留空時是「・時間未填」；內容依序是採買品項與備註，兩者都有時以「；」連接，
/// 都沒有時省略「：」與內容。
fn stop_text(s: &TripState, plan: &ShoppingPlan, stop: &Stop) -> String {
    let time = stop
        .time
        .map_or_else(|| "・時間未填".to_owned(), |time| format!(" {time}"));
    // 只有 Shopping_Stop 有採買品項；現行繪本為其他種類的停靠點自訂的品項不在第一版（需求 31.6）
    let items = if stop.kind == StopKind::Shop {
        stop_items(s, plan.stop_items(stop.id))
    } else {
        String::new()
    };
    let note = clean_text(&stop.note);
    let content: Vec<&str> = [items.as_str(), note.as_str()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect();
    let content = if content.is_empty() {
        String::new()
    } else {
        format!("：{}", content.join("；"))
    };
    format!(
        "{}（{}{time}{content}）",
        place_text(s, stop.place),
        stop_task(stop).label()
    )
}

/// 需求 31.7（現行 `project()` 的 `derivedItems`）：Shopping_Plan 分到這個 Shopping_Stop 的採買品項（已買與未買都算）的
/// 名稱，依採買品項的建立順序以「、」連接；超過 8 項時只列前 7 項，再接「等另外 N 項」，N 是名稱的總數減 7。名稱經
/// `clean_text()` 之後是空字串的品項與現行相同，先略過再計數。沒有分到任何品項時是空字串。
fn stop_items(s: &TripState, items: &[ShoppingId]) -> String {
    let mut names: Vec<String> = items
        .iter()
        .filter_map(|id| s.shopping.get(id))
        .map(|item| clean_text(&item.name))
        .filter(|name| !name.is_empty())
        .collect();
    if names.len() > STOP_ITEMS_MAX {
        let rest = names.len() - STOP_ITEMS_SHOWN;
        names.truncate(STOP_ITEMS_SHOWN);
        names.push(format!("等另外 {rest} 項"));
    }
    names.join("、")
}

/// 需求 31.9–31.11：這一天的活動區塊：「活動」一行，接著依 `day_events()` 的順序（時間遞增，同一時間活動在前，再各依
/// 建立順序），每筆活動「・{HH:MM} {標題}（{類別}）」、每道料理「・{HH:MM} {餐次}：{名稱}（{類別}）・餐點」一行，備註經
/// `clean_text()` 之後不是空字串時，下一行是兩個半形空格加備註；沒有任何活動與料理時，「活動」之後只有「無安排」一行。
fn activity_block(s: &TripState, day: Date) -> Vec<String> {
    let events = day_events(s, day);
    let mut lines = vec!["活動".to_owned()];
    if events.is_empty() {
        lines.push("無安排".to_owned());
    }
    for event in events {
        let time = event.time();
        let (line, note) = match event {
            DayEvent::Activity(activity) => (
                format!(
                    "・{time} {}（{}）",
                    clean_text(&activity.title),
                    activity.kind.label()
                ),
                activity.note.as_str(),
            ),
            DayEvent::Meal(meal) => (
                format!(
                    "・{time} {}（{}）・餐點",
                    meal_title(meal),
                    meal_category(meal)
                ),
                meal.notes.as_str(),
            ),
        };
        lines.push(line);
        let note = clean_text(note);
        if !note.is_empty() {
            lines.push(format!("  {note}"));
        }
    }
    lines
}

/// 需求 31.13：「未分配採買清單」一行，接著依採買品項的建立順序，每個負責人為待分配的品項（已買與未買都算）一行
/// 「・{品項名稱}」，名稱經 `clean_text()` 之後是空字串的品項也一樣（與現行相同）；負責人不在任何車上，或負責人所在的車
/// 沒有 Shopping_Stop 的品項不列出。沒有負責人為待分配的品項時沒有任何行。
fn unassigned_block(s: &TripState, plan: &ShoppingPlan) -> Vec<String> {
    let items: Vec<String> = plan
        .unassigned
        .iter()
        .filter(|entry| entry.code == UnassignedCode::Unassigned)
        .filter_map(|entry| s.shopping.get(&entry.item))
        .map(|item| format!("・{}", clean_text(&item.name)))
        .collect();
    if items.is_empty() {
        return items;
    }
    std::iter::once("未分配採買清單".to_owned())
        .chain(items)
        .collect()
}

/// 路線端點、停靠點與 Day_Place 的名稱（`place_name()` 經 `clean_text()`）：Destination_Place 寫旅行目的地，地點清單中
/// 的地點寫它目前的名稱。
fn place_text(s: &TripState, place: PlaceRef) -> String {
    clean_text(place_name(s, place))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use chrono::Days;
    use uuid::Uuid;

    use super::*;
    use crate::ids::{ActivityId, MealId, PersonId, PlaceId, RouteId, StopId, TripId, VehicleId};
    use crate::model::{
        Activity, ActivityKind, Category, Color, CoverKind, DaySetting, ItemSource, Meal, MealSlot,
        Participation, Person, Place, Row, ShoppingItem, StopTask, TripCard, TripStatus, Vehicle,
    };
    use crate::time::Hm;

    fn at(hour: u8, minute: u8) -> Hm {
        Hm::new(hour, minute).expect("有效的時刻")
    }

    /// 旅行的第 n 天：2026-10-20（週二）是第 1 天。
    fn day(n: u64) -> Date {
        "2026-10-20".parse::<Date>().expect("有效的日期") + Days::new(n - 1)
    }

    fn person_id(n: u64) -> PersonId {
        PersonId(Uuid::from_u128(0x1000 + u128::from(n)))
    }

    fn place_id(n: u64) -> PlaceId {
        PlaceId(Uuid::from_u128(0x3000 + u128::from(n)))
    }

    /// 第 1 天起 `days` 天的旅行，還沒有其他列。
    fn trip(title: &str, destination: &str, days: u64) -> TripState {
        TripState::new(TripCard {
            id: TripId(Uuid::from_u128(1)),
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
        })
    }

    fn with(mut s: TripState, rows: impl IntoIterator<Item = Row>) -> TripState {
        for row in rows {
            s.put(row);
        }
        s
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

    /// 第 n 台車，Ordinal 也是 n。
    fn vehicle(n: u64, name: &str, driver: Option<u64>, passengers: &[u64]) -> Row {
        Row::Vehicle(Vehicle {
            id: VehicleId(Uuid::from_u128(0x2000 + u128::from(n))),
            name: name.to_owned(),
            driver: driver.map(person_id),
            seats: 9,
            color: None,
            passengers: passengers.iter().copied().map(person_id).collect(),
            ordinal: n,
            version: 1,
        })
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

    /// 第 n 個停靠點，沒有指定任務。
    fn stop(n: u64, place: PlaceRef, kind: StopKind, time: Option<Hm>, note: &str) -> Stop {
        Stop {
            id: StopId(Uuid::from_u128(0x5000 + u128::from(n))),
            place,
            kind,
            task: None,
            note: note.to_owned(),
            time,
            items: Vec::new(),
        }
    }

    /// 第 n 條路線，Ordinal 也是 n；`vehicle` 是第幾台車。
    fn route(
        n: u64,
        on: Date,
        vehicle: u64,
        (from, to): (PlaceRef, PlaceRef),
        depart: Option<Hm>,
        stops: Vec<Stop>,
    ) -> Row {
        Row::Route(Route {
            id: RouteId(Uuid::from_u128(0x4000 + u128::from(n))),
            day: on,
            vehicle: VehicleId(Uuid::from_u128(0x2000 + u128::from(vehicle))),
            from,
            to,
            depart,
            stops,
            ordinal: n,
            version: 1,
        })
    }

    /// 這一天的每日設定；`place` 是地點清單中的第幾個地點。
    fn setting(
        on: Date,
        title: Option<&str>,
        place: Option<u64>,
        arrival: Option<Hm>,
        route_position: RoutePosition,
    ) -> Row {
        Row::DaySetting(DaySetting {
            day: on,
            title: title.map(str::to_owned),
            place: place.map(place_id),
            arrival,
            route_position,
            version: 1,
            arrival_label: None,
        })
    }

    /// 第 n 筆活動，Ordinal 也是 n：參加者為全體旅伴、未完成、沒有地點。
    fn activity(n: u64, on: Date, time: Hm, kind: ActivityKind, title: &str, note: &str) -> Row {
        Row::Activity(Activity {
            id: ActivityId(Uuid::from_u128(0x7000 + u128::from(n))),
            day: on,
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

    /// 第 n 道料理，Ordinal 也是 n：沒有用餐時間、負責人、食材與插圖種類。
    fn meal(n: u64, on: Date, slot: MealSlot, title: &str, notes: &str) -> Row {
        Row::Meal(Meal {
            id: MealId(Uuid::from_u128(0x8000 + u128::from(n))),
            day: on,
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

    /// 第 n 個採買品項，Ordinal 也是 n：未買的 Manual_Item；`assignee` 是第幾位旅伴，`None` 是待分配。
    fn item(n: u64, name: &str, assignee: Option<u64>) -> Row {
        Row::Shopping(ShoppingItem {
            id: ShoppingId(Uuid::from_u128(0x6000 + u128::from(n))),
            name: name.to_owned(),
            quantity: "1 份".to_owned(),
            category: Category::Other,
            assignee: assignee.map(person_id),
            purchased: false,
            source: ItemSource::Manual,
            meal_ids: BTreeSet::new(),
            recipe_removed: None,
            ordinal: n,
            version: 1,
        })
    }

    /// 兩天的旅行，用到需求 31 的大部分規則：
    /// - 第二車的路線先建立，所以列在出發時間較早的小黃之前（需求 31.5）。
    /// - 小安是小黃的駕駛，豬肉片與高麗菜分到小黃的 Shopping_Stop；冰塊待分配；阿哲在第二車上，第二車沒有
    ///   Shopping_Stop，所以木炭不出現在文字中（需求 31.7、31.13）。
    /// - 同一時間的活動排在料理之前；只有空白的料理筆記沒有備註行（需求 31.9、31.10）。
    fn sample() -> TripState {
        let pickup = stop(1, PlaceRef::Place(place_id(2)), StopKind::Pickup, None, "");
        let shop = stop(
            2,
            PlaceRef::Place(place_id(1)),
            StopKind::Shop,
            Some(at(9, 30)),
            "記得帶保冷袋",
        );
        let gear = Stop {
            task: Some(StopTask::GearReturn),
            ..stop(
                3,
                PlaceRef::Destination,
                StopKind::Gear,
                Some(at(10, 0)),
                "",
            )
        };
        with(
            trip("向山裡出發", "夕淞度日營區", 2),
            [
                person(1, "小安"),
                person(2, "阿哲"),
                vehicle(1, "小黃", Some(1), &[]),
                vehicle(2, "第二車", None, &[2]),
                place(1, "全聯"),
                place(2, "台中高鐵站"),
                route(
                    1,
                    day(1),
                    2,
                    (PlaceRef::Destination, PlaceRef::Destination),
                    None,
                    vec![pickup],
                ),
                route(
                    2,
                    day(1),
                    1,
                    (PlaceRef::Place(place_id(2)), PlaceRef::Destination),
                    Some(at(8, 0)),
                    vec![shop, gear],
                ),
                setting(
                    day(1),
                    Some("向山裡出發"),
                    None,
                    Some(at(15, 30)),
                    RoutePosition::Before,
                ),
                activity(1, day(1), at(9, 0), ActivityKind::Meet, "集合出發", ""),
                activity(
                    2,
                    day(1),
                    at(12, 0),
                    ActivityKind::Free,
                    "午休",
                    "記得帶頭燈",
                ),
                meal(1, day(1), MealSlot::Lunch, "咖哩飯", "  "),
                item(1, "豬肉片", Some(1)),
                item(2, "冰塊", None),
                item(3, "高麗菜", Some(1)),
                item(4, "木炭", Some(2)),
            ],
        )
    }

    #[test]
    fn writes_each_line_of_requirement_31() {
        assert_eq!(
            itinerary_text(&sample()).split('\n').collect::<Vec<_>>(),
            [
                "向山裡出發",
                "車輛：小黃、第二車",
                "第 1 天・10/20（週二）｜向山裡出發",
                "地點：夕淞度日營區",
                "路線",
                "・第二車｜出發時間未填：夕淞度日營區 → 台中高鐵站（接人・時間未填） → 夕淞度日營區",
                "・小黃｜08:00 出發：台中高鐵站 → 全聯（採買 09:30：豬肉片、高麗菜；記得帶保冷袋） → 夕淞度日營區（歸還裝備 10:00） → 夕淞度日營區",
                "預計 15:30 抵達夕淞度日營區",
                "活動",
                "・09:00 集合出發（集合）",
                "・12:00 午休（自由活動）",
                "  記得帶頭燈",
                "・12:00 午餐：咖哩飯（午餐）・餐點",
                "第 2 天・10/21（週三）｜未命名的一天",
                "地點：夕淞度日營區",
                "活動",
                "無安排",
                "未分配採買清單",
                "・冰塊",
            ]
        );
    }

    #[test]
    fn a_trip_without_rows_still_lists_every_day() {
        assert_eq!(
            itinerary_text(&trip("森林小旅行", "", 1)),
            [
                "森林小旅行",
                "車輛：尚未安排",
                "第 1 天・10/20（週二）｜未命名的一天",
                "地點：未指定",
                "活動",
                "無安排",
            ]
            .join("\n")
        );
    }

    /// 需求 31.8、31.12：路線在活動之後的一天先輸出活動區塊，抵達行仍是路線區塊的最後一行；沒有路線的一天只有抵達行，
    /// 沒有 Day_Place 時寫「預計 {HH:MM} 抵達」。
    #[test]
    fn route_position_and_arrival_lines() {
        let s = with(
            trip("森林小旅行", "", 2),
            [
                vehicle(1, "小黃", None, &[]),
                place(1, "湖畔木棧道"),
                route(
                    1,
                    day(1),
                    1,
                    (PlaceRef::Place(place_id(1)), PlaceRef::Place(place_id(1))),
                    Some(at(7, 30)),
                    Vec::new(),
                ),
                setting(day(1), None, Some(1), Some(at(17, 0)), RoutePosition::After),
                setting(day(2), None, None, Some(at(9, 0)), RoutePosition::Before),
                activity(1, day(1), at(8, 0), ActivityKind::Wake, "起床", ""),
            ],
        );
        assert_eq!(
            itinerary_text(&s).split('\n').collect::<Vec<_>>(),
            [
                "森林小旅行",
                "車輛：小黃",
                "第 1 天・10/20（週二）｜未命名的一天",
                "地點：湖畔木棧道",
                "活動",
                "・08:00 起床（起床）",
                "路線",
                "・小黃｜07:30 出發：湖畔木棧道 → 湖畔木棧道",
                "預計 17:00 抵達湖畔木棧道",
                "第 2 天・10/21（週三）｜未命名的一天",
                "地點：未指定",
                "預計 09:00 抵達",
                "活動",
                "無安排",
            ]
        );
    }

    /// 需求 31.7、31.13：Shopping_Stop 最多列 8 個名稱，超過時列前 7 個再加「等另外 N 項」；名稱經 `clean_text()` 之後是
    /// 空字串的品項（例如只有 U+0085 的 Meal_Item）與現行相同，先略過再計數，在未分配採買清單則照常一行「・」。同一台車
    /// 第二個 Shopping_Stop 沒有採買品項。
    #[test]
    fn shopping_stop_lists_at_most_eight_names() {
        let stops = vec![
            stop(1, PlaceRef::Place(place_id(1)), StopKind::Shop, None, ""),
            stop(
                2,
                PlaceRef::Place(place_id(2)),
                StopKind::Shop,
                None,
                "補冰塊",
            ),
        ];
        let names = [
            "豬肉片",
            "高麗菜",
            "雞蛋",
            "豆腐",
            "洋蔥",
            "\u{85}",
            "玉米",
            "甜椒",
            "冰塊",
        ];
        let s = with(
            trip("向山裡出發", "夕淞度日營區", 1),
            [
                person(1, "小安"),
                vehicle(1, "小黃", Some(1), &[]),
                place(1, "全聯"),
                place(2, "山下超市"),
                route(
                    1,
                    day(1),
                    1,
                    (PlaceRef::Destination, PlaceRef::Destination),
                    None,
                    stops,
                ),
                item(20, "\u{85}", None),
            ]
            .into_iter()
            .chain((1..).zip(names).map(|(n, name)| item(n, name, Some(1)))),
        );
        let route_line = |s: &TripState| {
            itinerary_text(s)
                .split('\n')
                .find(|line| line.starts_with("・小黃"))
                .map(str::to_owned)
        };
        assert_eq!(
            itinerary_text(&s).split('\n').collect::<Vec<_>>(),
            [
                "向山裡出發",
                "車輛：小黃",
                "第 1 天・10/20（週二）｜未命名的一天",
                "地點：夕淞度日營區",
                "路線",
                "・小黃｜出發時間未填：夕淞度日營區 → 全聯（採買・時間未填：豬肉片、高麗菜、雞蛋、豆腐、洋蔥、玉米、甜椒、冰塊） → 山下超市（採買・時間未填：補冰塊） → 夕淞度日營區",
                "活動",
                "無安排",
                "未分配採買清單",
                "・",
            ]
        );
        // 第 9 個名稱：前 7 個加「等另外 2 項」
        let s = with(s, [item(10, "木炭", Some(1))]);
        assert_eq!(
            route_line(&s).as_deref(),
            Some("・小黃｜出發時間未填：夕淞度日營區 → 全聯（採買・時間未填：豬肉片、高麗菜、雞蛋、豆腐、洋蔥、玉米、甜椒、等另外 2 項） → 山下超市（採買・時間未填：補冰塊） → 夕淞度日營區")
        );
    }

    /// 需求 31.14：每段使用者文字先 Trim_White，再把含換行字元的空白換成一個半形空格；不含換行字元的連續空白保留，
    /// 不是 White_Space 的 U+FEFF 也保留。
    #[test]
    fn user_text_is_cleaned() {
        let s = with(
            trip(" 向山\n裡出發 ", "\u{feff}夕淞度日營區", 1),
            [
                vehicle(1, "小黃\u{2028}號", None, &[]),
                place(1, "湖畔  木棧道"),
                route(
                    1,
                    day(1),
                    1,
                    (PlaceRef::Place(place_id(1)), PlaceRef::Destination),
                    Some(at(8, 0)),
                    vec![stop(
                        1,
                        PlaceRef::Place(place_id(1)),
                        StopKind::Other,
                        Some(at(8, 30)),
                        "記得\n帶冰塊",
                    )],
                ),
                setting(
                    day(1),
                    Some("森林\r\n小徑"),
                    None,
                    None,
                    RoutePosition::Before,
                ),
                activity(
                    1,
                    day(1),
                    at(9, 0),
                    ActivityKind::Meet,
                    "集合 \n 出發",
                    "帶水壺\n和外套\t兩個  空格",
                ),
                meal(1, day(1), MealSlot::Dinner, "烤肉\n派對", "\u{feff}先醃肉"),
            ],
        );
        assert_eq!(
            itinerary_text(&s).split('\n').collect::<Vec<_>>(),
            [
                "向山 裡出發",
                "車輛：小黃 號",
                "第 1 天・10/20（週二）｜森林 小徑",
                "地點：\u{feff}夕淞度日營區",
                "路線",
                "・小黃 號｜08:00 出發：湖畔  木棧道 → 湖畔  木棧道（一般停靠 08:30：記得 帶冰塊） → \u{feff}夕淞度日營區",
                "活動",
                "・09:00 集合 出發（集合）",
                "  帶水壺 和外套\t兩個  空格",
                "・18:00 晚餐：烤肉 派對（烤肉）・餐點",
                "  \u{feff}先醃肉",
            ]
        );
    }

    /// 需求 31.18：固定的標點只用這 8 個碼位，「→」前後各一個半形空格。範例的使用者文字只有漢字，固定文字的數字、冒號、
    /// 斜線與空格是 ASCII，所以其他字元都是固定的標點。
    #[test]
    fn fixed_punctuation_uses_the_code_points_of_requirement_31_18() {
        let text = itinerary_text(&sample());
        let punctuation: BTreeSet<char> = text
            .chars()
            .filter(|c| !c.is_ascii() && !('\u{4e00}'..='\u{9fff}').contains(c))
            .collect();
        assert_eq!(
            punctuation,
            BTreeSet::from([
                '\u{30fb}', '\u{ff5c}', '\u{ff1a}', '\u{ff08}', '\u{ff09}', '\u{3001}', '\u{ff1b}',
                '\u{2192}',
            ])
        );
        let arrows = text.matches('\u{2192}').count();
        assert!(arrows > 0);
        assert_eq!(text.matches(" \u{2192} ").count(), arrows);
    }
}
