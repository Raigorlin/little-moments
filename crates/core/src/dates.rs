//! 改日期（Retime，需求 18.5–18.9，design A9）：`retime_by_day_index()`、`shorten_blocked_message()` 與
//! `DaySetting::has_title_or_place()`。
//!
//! 移植自 `src/itinerary-dates.js` 的 `retimeByDayIndex()`、`shortenBlockedMessage()` 與 `hasTitleOrPlace()`；同一個
//! 檔案中給現行伺服器平移日期的 `shiftByOffset()` 與 `outOfRangeMessage()` 不移植。旅行的起訖日期改變時，路線、每日
//! 設定、活動與料理依「第 N 天」搬動，只改變它們的日期；縮短天數時，被刪掉的日子上有路線，或有標題、地點的每日設定，
//! 就不改日期。
//!
//! `retime_by_day_index()` 只修改傳入的可寫副本（`apply()` 的 draft，design 1.5），不做其他事：被阻擋時副本不變，
//! 成功時由 `diff()` 與原狀態比較產生變化。

use std::collections::BTreeMap;

use crate::model::{Date, DaySetting, TripState};
use crate::text::trim_white;
use crate::time::{date_range, month_day};

/// 縮短天數時阻擋改日期的一天（需求 18.7）：被刪掉的舊範圍第 N 天（N 大於新天數），上面有路線，或有標題、地點的
/// 每日設定。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct BlockedDay {
    /// 舊範圍的第幾天，從 1 起算。
    pub n: usize,
    /// 那一天原本的日期。
    pub date: Date,
    /// 那一天有路線。
    pub routes: bool,
    /// 那一天的每日設定有標題或地點（`DaySetting::has_title_or_place()`）。
    pub settings: bool,
}

impl DaySetting {
    /// 需求 18.7、18.8（現行 `hasTitleOrPlace()`）：標題經 Trim_White 之後不是空的，或已設定地點；這樣的每日設定阻擋
    /// 縮短天數。只有預計抵達時間與路線位置，或標題只有空白的每日設定不阻擋，縮短天數時整列刪除。
    pub fn has_title_or_place(&self) -> bool {
        self.title
            .as_deref()
            .is_some_and(|title| !trim_white(title).is_empty())
            || self.place.is_some()
    }
}

/// Retime（現行 `retimeByDayIndex()`，需求 18.5–18.9）：把旅行的起訖日期改為 `start` 到 `end`。舊範圍是 `draft`
/// 目前的起訖日期（在 LM_Server 是執行當下的日期），所以呼叫端在 Trip_Card 換成新的起訖日期之前呼叫：
///
/// - 舊第 N 天的路線與每日設定到新的第 N 天；新舊範圍重疊時也依搬動前的日子對應，不互相覆蓋（需求 18.5）。
/// - 舊第 N 天的活動與料理到新的第 min(N, 新天數) 天；日期不在舊範圍內的到新的第 1 天（需求 18.6）。
/// - 縮短天數時，被刪掉的日子（舊第 N 天，N 大於新天數）的每日設定連同預計抵達時間與路線位置整列刪除（需求 18.8）。
///
/// 只改變這些列的日期與 Trip_Card 的起訖日期：時間、完成狀態、Ordinal、Row_Version 等其他欄位不變，支出、還款與其他
/// 種類的列也不變（需求 18.9）。
///
/// 被刪掉的日子上有路線，或有標題、地點的每日設定（`DaySetting::has_title_or_place()`）時，回傳這些日子的
/// `BlockedDay`（依 N 遞增），`draft` 不變；活動與料理不阻擋縮短（需求 18.7）。409 的訊息由
/// `shorten_blocked_message()` 產生。
///
/// 日期不在舊範圍內的路線與每日設定只在無效的狀態（不滿足 I5）：它們沒有第 N 天，日期不變（與現行相同）；這樣的每日
/// 設定所在的日期有搬過來的每日設定時，由搬過來的取代。
///
/// # Panics
///
/// `start` 到 `end` 不是 1–31 天時（現行丟出 `RangeError`）；呼叫端先依需求 17.5 檢查起訖日期。
pub fn retime_by_day_index(
    draft: &mut TripState,
    start: Date,
    end: Date,
) -> Result<(), Vec<BlockedDay>> {
    let new_days = date_range(start, end);
    assert!(
        !new_days.is_empty(),
        "retime_by_day_index() 的新範圍需為 1–31 天"
    );
    let old_days = date_range(draft.card.start, draft.card.end);
    let blocked: Vec<BlockedDay> = old_days
        .iter()
        .enumerate()
        .skip(new_days.len())
        .filter_map(|(i, &date)| {
            let routes = draft.routes.values().any(|route| route.day == date);
            let settings = draft
                .day_settings
                .get(&date)
                .is_some_and(DaySetting::has_title_or_place);
            (routes || settings).then_some(BlockedDay {
                n: i + 1,
                date,
                routes,
                settings,
            })
        })
        .collect();
    if !blocked.is_empty() {
        return Err(blocked);
    }

    // 舊範圍的日期 → 第幾天減 1
    let index: BTreeMap<Date, usize> = old_days
        .iter()
        .enumerate()
        .map(|(i, &day)| (day, i))
        .collect();
    let last = new_days.len() - 1;
    // 活動與料理：舊第 N 天到新的第 min(N, 新天數) 天，舊範圍之外的到新的第 1 天
    let clamped = |day: Date| new_days[index.get(&day).map_or(0, |&i| i.min(last))];
    for activity in draft.activities.values_mut() {
        activity.day = clamped(activity.day);
    }
    for meal in draft.meals.values_mut() {
        meal.day = clamped(meal.day);
    }
    // 路線：舊第 N 天到新第 N 天；被刪掉的日子上已確認沒有路線，舊範圍之外的日期不變
    for route in draft.routes.values_mut() {
        if let Some(&day) = index.get(&route.day).and_then(|&i| new_days.get(i)) {
            route.day = day;
        }
    }
    // 每日設定以日期為鍵：依新的日期重建整張表，新舊範圍重疊時也不會互相覆蓋
    let mut settings = BTreeMap::new();
    let mut outside = Vec::new();
    for setting in std::mem::take(&mut draft.day_settings).into_values() {
        match index.get(&setting.day) {
            Some(&i) if i <= last => {
                let day = new_days[i];
                settings.insert(day, DaySetting { day, ..setting });
            }
            // 被刪掉的日子：已確認沒有標題與地點，整列刪除
            Some(_) => {}
            None => outside.push(setting),
        }
    }
    for setting in outside {
        settings.entry(setting.day).or_insert(setting);
    }
    draft.day_settings = settings;
    draft.card.start = start;
    draft.card.end = end;
    Ok(())
}

/// 需求 18.7（現行 `shortenBlockedMessage()`）：縮短天數被阻擋時的 409 訊息。依 `blocked` 的順序
/// （`retime_by_day_index()` 依 N 遞增）以「、」連接每一天的「第 {N} 天（{M/D}）的{內容}」：{M/D} 是那一天原本的月與日
/// （不補零），{內容} 只有路線時為「路線」、只有每日設定時為「每日設定」、兩者都有時為「路線與每日設定」，例如
/// 「縮短天數前，請先處理：第 4 天（10/23）的路線、第 5 天（10/24）的路線與每日設定。刪除這些路線、清除這些每日設定後，
/// 才能縮短天數。」。`blocked` 是空的時是空字串（與現行相同）。
pub fn shorten_blocked_message(blocked: &[BlockedDay]) -> String {
    if blocked.is_empty() {
        return String::new();
    }
    let days: Vec<String> = blocked
        .iter()
        .map(|day| {
            let content = match (day.routes, day.settings) {
                (true, true) => "路線與每日設定",
                (true, false) => "路線",
                (false, _) => "每日設定",
            };
            format!("第 {} 天（{}）的{content}", day.n, month_day(day.date))
        })
        .collect();
    format!(
        "縮短天數前，請先處理：{}。刪除這些路線、清除這些每日設定後，才能縮短天數。",
        days.join("、")
    )
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use uuid::Uuid;

    use super::*;
    use crate::ids::{
        ActivityId, ExpenseId, MealId, PersonId, PlaceId, RouteId, SettlementId, TripId, VehicleId,
    };
    use crate::model::{
        Activity, ActivityKind, CoverKind, Expense, ExpenseCategory, Meal, MealSlot, Participation,
        PlaceRef, Route, RoutePosition, Row, Settlement, TripCard, TripStatus,
    };
    use crate::time::Hm;

    fn day(text: &str) -> Date {
        crate::time::parse_date(text).expect("有效的日期")
    }

    fn at(hour: u8, minute: u8) -> Hm {
        Hm::new(hour, minute).expect("有效的時刻")
    }

    fn person_id(n: u128) -> PersonId {
        PersonId(Uuid::from_u128(0x1000 + n))
    }

    fn place_id(n: u128) -> PlaceId {
        PlaceId(Uuid::from_u128(0x3000 + n))
    }

    fn route_id(n: u64) -> RouteId {
        RouteId(Uuid::from_u128(0x4000 + u128::from(n)))
    }

    fn activity_id(n: u64) -> ActivityId {
        ActivityId(Uuid::from_u128(0x7000 + u128::from(n)))
    }

    fn meal_id(n: u64) -> MealId {
        MealId(Uuid::from_u128(0x8000 + u128::from(n)))
    }

    /// `start` 到 `end` 的旅行，還沒有其他列。
    fn trip(start: &str, end: &str) -> TripState {
        TripState::new(TripCard {
            id: TripId(Uuid::from_u128(1)),
            title: "向山裡出發".to_owned(),
            destination: "夕淞度日營區".to_owned(),
            start: day(start),
            end: day(end),
            description: String::new(),
            note: String::new(),
            cover: CoverKind::Camp,
            status: TripStatus::Planning,
            version: 1,
            caption: String::new(),
            headline: String::new(),
        })
    }

    /// 第 n 條路線，Ordinal 與 Row_Version 也是 n：第 `vehicle` 台車 08:30 從旅行目的地出發、回到旅行目的地。
    fn route(n: u64, on: &str, vehicle: u128) -> Route {
        Route {
            id: route_id(n),
            day: day(on),
            vehicle: VehicleId(Uuid::from_u128(0x2000 + vehicle)),
            from: PlaceRef::Destination,
            to: PlaceRef::Destination,
            depart: Some(at(8, 30)),
            stops: Vec::new(),
            ordinal: n,
            version: n,
        }
    }

    /// `on` 的每日設定：沒有預計抵達時間，路線在活動之前。
    fn setting(on: &str, title: Option<&str>, place: Option<u128>) -> DaySetting {
        DaySetting {
            day: day(on),
            title: title.map(str::to_owned),
            place: place.map(place_id),
            arrival: None,
            route_position: RoutePosition::Before,
            version: 1,
            arrival_label: None,
        }
    }

    /// 第 n 筆活動，Ordinal 與 Row_Version 也是 n：09:00 的自由活動，參加者為全體旅伴、未完成。
    fn activity(n: u64, on: &str) -> Activity {
        Activity {
            id: activity_id(n),
            day: day(on),
            time: at(9, 0),
            title: "多留一天".to_owned(),
            kind: ActivityKind::Free,
            location: String::new(),
            note: String::new(),
            done: false,
            who: Participation::Everyone,
            ordinal: n,
            version: n,
        }
    }

    /// 第 n 道料理，Ordinal 與 Row_Version 也是 n：12:30 的午餐。
    fn meal(n: u64, on: &str) -> Meal {
        Meal {
            id: meal_id(n),
            day: day(on),
            slot: MealSlot::Lunch,
            time: Some(at(12, 30)),
            title: "野餐".to_owned(),
            cook: None,
            servings: 8,
            ingredients: String::new(),
            notes: String::new(),
            dish: None,
            ordinal: n,
            version: n,
        }
    }

    fn expense(on: &str) -> Expense {
        Expense {
            id: ExpenseId(Uuid::from_u128(0x9001)),
            day: day(on),
            title: "營位".to_owned(),
            amount_cents: 120_000,
            payer: person_id(1),
            participants: BTreeSet::from([person_id(1), person_id(2)]),
            category: ExpenseCategory::Lodging,
            note: String::new(),
            shopping_item: None,
            ordinal: 1,
            version: 1,
        }
    }

    fn settlement(on: &str) -> Settlement {
        Settlement {
            id: SettlementId(Uuid::from_u128(0xa001)),
            day: day(on),
            from: person_id(2),
            to: person_id(1),
            amount_cents: 60_000,
            note: String::new(),
            ordinal: 1,
            version: 1,
        }
    }

    fn with(mut s: TripState, rows: impl IntoIterator<Item = Row>) -> TripState {
        for row in rows {
            s.put(row);
        }
        s
    }

    fn route_days(s: &TripState) -> Vec<Date> {
        s.routes_by_ordinal().map(|route| route.day).collect()
    }

    fn activity_days(s: &TripState) -> Vec<Date> {
        s.activities_by_ordinal()
            .map(|activity| activity.day)
            .collect()
    }

    fn meal_days(s: &TripState) -> Vec<Date> {
        s.meals_by_ordinal().map(|meal| meal.day).collect()
    }

    /// 每日設定的日期與標題，依日期；也確認列鍵就是列的日期。
    fn titles(s: &TripState) -> Vec<(Date, Option<&str>)> {
        s.day_settings
            .iter()
            .map(|(&key, setting)| {
                assert_eq!(key, setting.day);
                (key, setting.title.as_deref())
            })
            .collect()
    }

    #[test]
    fn rows_keep_their_day_n_and_only_dates_change() {
        // 需求 18.5、18.6、18.9：3 天（10/20–10/22）改為 11/1 起的 5 天
        let first = DaySetting {
            arrival: Some(at(12, 0)),
            ..setting("2026-10-20", Some("出發"), Some(1))
        };
        let third = DaySetting {
            arrival: Some(at(16, 0)),
            route_position: RoutePosition::After,
            ..setting("2026-10-22", None, None)
        };
        let before = with(
            trip("2026-10-20", "2026-10-22"),
            [
                Row::Route(route(1, "2026-10-20", 1)),
                Row::Route(route(2, "2026-10-22", 1)),
                Row::DaySetting(first.clone()),
                Row::DaySetting(third.clone()),
                Row::Activity(Activity {
                    done: true,
                    ..activity(1, "2026-10-21")
                }),
                Row::Meal(meal(1, "2026-10-22")),
                Row::Expense(expense("2026-10-21")),
                Row::Settlement(settlement("2026-10-22")),
            ],
        );
        let mut draft = before.clone();
        assert_eq!(
            retime_by_day_index(&mut draft, day("2026-11-01"), day("2026-11-05")),
            Ok(())
        );

        let mut expected = before.clone();
        expected.card.start = day("2026-11-01");
        expected.card.end = day("2026-11-05");
        expected.routes.get_mut(&route_id(1)).expect("路線").day = day("2026-11-01");
        expected.routes.get_mut(&route_id(2)).expect("路線").day = day("2026-11-03");
        expected.day_settings = BTreeMap::from([
            (
                day("2026-11-01"),
                DaySetting {
                    day: day("2026-11-01"),
                    ..first
                },
            ),
            (
                day("2026-11-03"),
                DaySetting {
                    day: day("2026-11-03"),
                    ..third
                },
            ),
        ]);
        expected
            .activities
            .get_mut(&activity_id(1))
            .expect("活動")
            .day = day("2026-11-02");
        expected.meals.get_mut(&meal_id(1)).expect("料理").day = day("2026-11-03");
        // 時間、完成狀態、Ordinal 與 Row_Version 不變；支出與還款保留原本的日期
        assert_eq!(draft, expected);

        // 起訖日期不變時沒有變化
        let mut same = before.clone();
        assert_eq!(
            retime_by_day_index(&mut same, day("2026-10-20"), day("2026-10-22")),
            Ok(())
        );
        assert_eq!(same, before);
    }

    #[test]
    fn overlapping_ranges_move_by_day_n_without_overwriting() {
        // 需求 18.5：每天都有路線與每日設定的 3 天旅行往後、往前各移一天
        let before = with(
            trip("2026-10-20", "2026-10-22"),
            [
                Row::Route(route(1, "2026-10-20", 1)),
                Row::Route(route(2, "2026-10-21", 1)),
                Row::Route(route(3, "2026-10-22", 1)),
                Row::DaySetting(setting("2026-10-20", Some("出發"), None)),
                Row::DaySetting(setting("2026-10-21", Some("森林小徑"), None)),
                Row::DaySetting(setting("2026-10-22", Some("返程日"), None)),
            ],
        );
        for (start, end) in [("2026-10-21", "2026-10-23"), ("2026-10-19", "2026-10-21")] {
            let mut draft = before.clone();
            assert_eq!(
                retime_by_day_index(&mut draft, day(start), day(end)),
                Ok(())
            );
            let days = date_range(day(start), day(end));
            assert_eq!(route_days(&draft), days);
            assert_eq!(
                titles(&draft),
                [
                    (days[0], Some("出發")),
                    (days[1], Some("森林小徑")),
                    (days[2], Some("返程日")),
                ]
            );
        }
    }

    #[test]
    fn shortening_moves_later_activities_and_meals_and_drops_empty_settings() {
        // 需求 18.6、18.8：5 天（10/20–10/24）縮成 3 天；第 4、5 天只有活動、料理，以及沒有標題與地點的每日設定
        let kept = setting("2026-10-22", Some("返程日"), Some(1));
        let before = with(
            trip("2026-10-20", "2026-10-24"),
            [
                Row::DaySetting(kept.clone()),
                Row::DaySetting(DaySetting {
                    arrival: Some(at(15, 0)),
                    route_position: RoutePosition::After,
                    ..setting("2026-10-23", None, None)
                }),
                Row::DaySetting(DaySetting {
                    arrival: Some(at(16, 0)),
                    ..setting("2026-10-24", Some(" \u{3000}"), None)
                }),
                Row::Activity(activity(1, "2026-10-21")),
                Row::Activity(activity(2, "2026-10-23")),
                Row::Activity(activity(3, "2026-10-24")),
                Row::Meal(meal(1, "2026-10-24")),
                Row::Meal(meal(2, "2026-10-20")),
            ],
        );
        let mut draft = before.clone();
        assert_eq!(
            retime_by_day_index(&mut draft, day("2026-10-20"), day("2026-10-22")),
            Ok(())
        );
        assert_eq!(
            activity_days(&draft),
            [day("2026-10-21"), day("2026-10-22"), day("2026-10-22")]
        );
        assert_eq!(meal_days(&draft), [day("2026-10-22"), day("2026-10-20")]);
        // 第 4、5 天的每日設定連同預計抵達時間與路線位置整列刪除
        assert_eq!(draft.day_settings, BTreeMap::from([(kept.day, kept)]));
        assert_eq!(
            (draft.card.start, draft.card.end),
            (day("2026-10-20"), day("2026-10-22"))
        );
    }

    #[test]
    fn removed_days_with_routes_or_titled_or_placed_settings_block_shortening() {
        // 需求 18.7：5 天（10/20–10/24）縮成 11/1 的一日遊
        let before = with(
            trip("2026-10-20", "2026-10-24"),
            [
                // 第 2 天：有標題的每日設定
                Row::DaySetting(setting("2026-10-21", Some("多玩一天"), None)),
                // 第 3 天：只有空白標題與預計抵達時間的每日設定、活動與料理，都不阻擋
                Row::DaySetting(DaySetting {
                    arrival: Some(at(15, 0)),
                    ..setting("2026-10-22", Some("\u{3000}\u{3000}"), None)
                }),
                Row::Activity(activity(1, "2026-10-22")),
                Row::Meal(meal(1, "2026-10-22")),
                // 第 5 天：路線與設定了地點的每日設定；第 4 天：路線，建立順序在第 5 天的路線之後
                Row::Route(route(1, "2026-10-24", 2)),
                Row::DaySetting(setting("2026-10-24", None, Some(1))),
                Row::Route(route(2, "2026-10-23", 1)),
            ],
        );
        let mut draft = before.clone();
        let blocked = retime_by_day_index(&mut draft, day("2026-11-01"), day("2026-11-01"))
            .expect_err("縮短天數被阻擋");
        assert_eq!(draft, before);
        assert_eq!(
            blocked,
            [
                BlockedDay {
                    n: 2,
                    date: day("2026-10-21"),
                    routes: false,
                    settings: true,
                },
                BlockedDay {
                    n: 4,
                    date: day("2026-10-23"),
                    routes: true,
                    settings: false,
                },
                BlockedDay {
                    n: 5,
                    date: day("2026-10-24"),
                    routes: true,
                    settings: true,
                },
            ]
        );
        // 列出原本的日期，不是新開始日期加 N − 1 天
        assert_eq!(
            shorten_blocked_message(&blocked),
            "縮短天數前，請先處理：第 2 天（10/21）的每日設定、第 4 天（10/23）的路線、第 5 天（10/24）的路線與每日設定。刪除這些路線、清除這些每日設定後，才能縮短天數。"
        );
    }

    #[test]
    fn only_a_title_that_is_not_blank_or_a_place_blocks() {
        let empty = setting("2026-10-20", None, None);
        let cases = [
            (
                DaySetting {
                    arrival: Some(at(15, 0)),
                    route_position: RoutePosition::After,
                    ..empty.clone()
                },
                false,
            ),
            (
                DaySetting {
                    title: Some(String::new()),
                    ..empty.clone()
                },
                false,
            ),
            (
                DaySetting {
                    title: Some(" \u{3000}\t\n\u{85}".to_owned()),
                    ..empty.clone()
                },
                false,
            ),
            (
                DaySetting {
                    title: Some("多玩一天".to_owned()),
                    ..empty.clone()
                },
                true,
            ),
            (
                DaySetting {
                    place: Some(place_id(1)),
                    ..empty.clone()
                },
                true,
            ),
        ];
        for (setting, blocks) in cases {
            assert_eq!(setting.has_title_or_place(), blocks, "{setting:?}");
        }
    }

    #[test]
    fn blocked_message_follows_requirement_18_7() {
        let blocked = [
            BlockedDay {
                n: 4,
                date: day("2026-10-23"),
                routes: true,
                settings: false,
            },
            BlockedDay {
                n: 5,
                date: day("2026-10-24"),
                routes: true,
                settings: true,
            },
        ];
        // 需求 18.7 的例子；標點是 U+FF0C、U+FF1A、U+FF08 與 U+FF09、U+3001、U+3002，第 N 天前後的空白與日期中的
        // 斜線是半形
        assert_eq!(
            shorten_blocked_message(&blocked),
            "縮短天數前\u{FF0C}請先處理\u{FF1A}第 4 天\u{FF08}10/23\u{FF09}的路線\u{3001}\
             第 5 天\u{FF08}10/24\u{FF09}的路線與每日設定\u{3002}\
             刪除這些路線\u{3001}清除這些每日設定後\u{FF0C}才能縮短天數\u{3002}"
        );
        // 月與日不補零
        let new_year = BlockedDay {
            n: 13,
            date: day("2027-01-01"),
            routes: false,
            settings: true,
        };
        assert_eq!(
            shorten_blocked_message(&[new_year]),
            "縮短天數前，請先處理：第 13 天（1/1）的每日設定。刪除這些路線、清除這些每日設定後，才能縮短天數。"
        );
        assert_eq!(shorten_blocked_message(&[]), "");
    }

    #[test]
    fn rows_outside_the_old_range_move_to_day_1_or_keep_their_date() {
        // 只在無效的狀態：活動與料理到新的第 1 天（需求 18.6）；路線與每日設定沒有第 N 天，日期不變，但那一天有
        // 搬過來的每日設定時由它取代
        let before = with(
            trip("2026-10-20", "2026-10-22"),
            [
                Row::Activity(activity(1, "2026-10-10")),
                Row::Meal(meal(1, "2026-10-30")),
                Row::Route(route(1, "2026-10-30", 1)),
                Row::DaySetting(setting("2026-10-22", Some("返程日"), None)),
                Row::DaySetting(setting("2026-10-23", Some("多出來的一天"), None)),
                Row::DaySetting(setting("2026-10-30", Some("更遠的一天"), None)),
            ],
        );
        let mut draft = before.clone();
        assert_eq!(
            retime_by_day_index(&mut draft, day("2026-10-21"), day("2026-10-23")),
            Ok(())
        );
        assert_eq!(activity_days(&draft), [day("2026-10-21")]);
        assert_eq!(meal_days(&draft), [day("2026-10-21")]);
        assert_eq!(route_days(&draft), [day("2026-10-30")]);
        assert_eq!(
            titles(&draft),
            [
                (day("2026-10-23"), Some("返程日")),
                (day("2026-10-30"), Some("更遠的一天")),
            ]
        );
    }

    #[test]
    #[should_panic(expected = "新範圍需為 1–31 天")]
    fn a_new_range_that_is_not_1_to_31_days_panics() {
        let mut draft = trip("2026-10-20", "2026-10-22");
        let _ = retime_by_day_index(&mut draft, day("2026-10-22"), day("2026-10-20"));
    }
}
