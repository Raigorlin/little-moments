//! Property 13 的屬性測試（任務 6.5；需求 31.1、31.3、31.5、33.5、33.6）：文字版是決定性的。
//!
//! 對共用產生器 `arb_state()` 的狀態 s 檢查：
//!
//! - 決定性（需求 31.1）：把 s 的每一列（包括 Trip_Card）依 proptest 打散的順序 `put()` 進新的 `TripState`，得到與 s
//!   相同的狀態，`itinerary_text()` 的結果也與 s 的逐字相同；同一個 s 呼叫兩次的結果相同。`itinerary_text()` 只接收
//!   `&TripState`，lm-core 也不讀取系統時間、時區與語系，所以檢視的 Account、裝置與產生的時間都沒有途徑影響結果；這裡
//!   檢查狀態之外剩下的兩個來源：列的插入順序與先前的呼叫。
//! - 「第 n 天」行（需求 31.3）：以「第 」開頭、含有「天・」的行（`arb_state()` 的詞彙中只有每一天的標題行如此）剛好有
//!   旅行天數行，第 n 行是「第 {n} 天・{M/D}（週{X}）｜{當日標題}」，日期依序是開始日到結束日的每一天。預期的日期與
//!   星期在測試中以 chrono 另外計算，不使用 lm-core 的 `date_range()` 與 `date_text()`。
//! - 路線行（需求 31.5）：每一天區塊中「路線」一行之後連續以「・」開頭的行，行數等於那一天的路線數，第 i 行是 Ordinal
//!   第 i 小的路線。車名可以重複，所以不以車名辨認路線，而以整行的結構辨認（[`is_route_line()`]）。
//!
//! 每台車每天最多一條路線，`arb_state()` 的出發時間又常常相同或留空，只看 s 不一定分得出「依 Ordinal」與「依出發時間」
//! 的差別。所以每一天的標題行與路線行另外在 s′ 檢查一次：s′ 把 s 每一天的路線依 Ordinal 由小到大改為 23:00、22:00、
//! 21:00… 出發（[`with_departures_against_ordinal()`]），出發時間兩兩不同，順序與 Ordinal 相反。出發時間只出現在路線行，
//! 不影響其他各行，s′ 也滿足 `arb_state()` 保證的每個不變式。
//!
//! 使用 proptest 的預設設定（256 個案例，設定 `PROPTEST_CASES=N` 時為 N 個），不覆寫案例數；proptest 找到的失敗案例
//! 寫在同一個目錄的 `prop_itinerary_text.proptest-regressions`，這個檔案提交進版本庫（需求 33.6）。

mod support;

use lm_core::itinerary::{place_name, stop_task};
use lm_core::itinerary_text::itinerary_text;
use lm_core::model::{Date, PlaceRef, Route, Row, TripState};
use lm_core::text::clean_text;
use lm_core::time::Hm;
use proptest::prelude::*;

use support::state::arb_state;

/// 「未分配採買清單」區塊的第一行（需求 31.13），在最後一天的區塊之後。
const UNASSIGNED_HEADER: &str = "未分配採買清單";

// Feature: rust-supabase-rewrite, Property 13: 文字版是決定性的
proptest! {
    /// *For any* 狀態 s，以不同的插入順序把同樣的列重新放進新的 `TripState`，`itinerary_text()` 的結果完全相同；同一個
    /// s 呼叫兩次結果相同；輸出中「第 n 天」行剛好出現旅行天數次，依日期遞增；每一天的路線行依路線的 ordinal 排列，與
    /// 出發時間無關。
    ///
    /// **Validates: Requirements 31.1, 31.3, 31.5**
    #[test]
    fn itinerary_text_is_deterministic((state, shuffled) in arb_state_with_shuffled_rows()) {
        let text = itinerary_text(&state);
        prop_assert_eq!(&itinerary_text(&state), &text, "同一個狀態呼叫兩次，文字版不同");

        let rebuilt = rebuild(&state, shuffled);
        prop_assert_eq!(&rebuilt, &state, "依打散的順序放進同樣的列，得到的狀態與原本的不同");
        prop_assert_eq!(&itinerary_text(&rebuilt), &text, "依不同的順序放進同樣的列，文字版不同");

        check_days(&state, &text)?;
        let against = with_departures_against_ordinal(&state);
        check_days(&against, &itinerary_text(&against))?;
    }
}

/// `arb_state()` 的狀態 s，以及 s 的每一列（包括 Trip_Card）依 proptest 打散的順序排成的清單。
fn arb_state_with_shuffled_rows() -> impl Strategy<Value = (TripState, Vec<Row>)> {
    arb_state().prop_flat_map(|state| {
        let rows: Vec<Row> = state
            .slots()
            .map(|slot| state.get(slot).expect("slots() 的每個 Slot 都有一列"))
            .collect();
        (Just(state), Just(rows).prop_shuffle())
    })
}

/// 依 `rows` 的順序把每一列 `put()` 進新的 `TripState`。`TripState::new()` 需要一張 Trip_Card，先用 `state` 的；`rows`
/// 中的 Trip_Card 之後再取代它。
fn rebuild(state: &TripState, rows: Vec<Row>) -> TripState {
    let mut rebuilt = TripState::new(state.card.clone());
    for row in rows {
        rebuilt.put(row);
    }
    rebuilt
}

/// 需求 31.3、31.5：`text` 是 `state` 的 Itinerary_Text；檢查「第 n 天」行與每一天的路線行。
fn check_days(state: &TripState, text: &str) -> Result<(), TestCaseError> {
    let lines: Vec<&str> = text.split('\n').collect();
    let dates = trip_dates(state);

    // 「第 n 天」行剛好有旅行天數行，依日期遞增
    let headers: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| is_day_header(line))
        .map(|(at, _)| at)
        .collect();
    prop_assert_eq!(
        headers.len(),
        dates.len(),
        "「第 n 天」行的行數不是旅行天數：\n{}",
        text
    );
    for (n, (&at, &date)) in (1..).zip(headers.iter().zip(&dates)) {
        let expected = header_line(state, n, date);
        prop_assert_eq!(lines[at], expected.as_str(), "第 {} 天的標題行", n);
    }

    // 每一天的區塊是它的「第 n 天」行之後、下一天的「第 n 天」行之前的各行；最後一天到「未分配採買清單」或文字的結尾
    for (k, &date) in dates.iter().enumerate() {
        let start = headers[k] + 1;
        let end = headers.get(k + 1).copied().unwrap_or_else(|| {
            lines[start..]
                .iter()
                .position(|line| *line == UNASSIGNED_HEADER)
                .map_or(lines.len(), |at| start + at)
        });
        check_route_lines(state, date, &lines[start..end])?;
    }
    Ok(())
}

/// 旅行的每一天，依日期遞增：開始日到結束日（含兩端）。以 time 另外計算，不使用 lm-core 的 `date_range()`。
fn trip_dates(state: &TripState) -> Vec<Date> {
    std::iter::successors(Some(state.card.start), |date| date.next_day())
        .take_while(|date| *date <= state.card.end)
        .collect()
}

/// 「第 n 天」行：以「第 」開頭、含有「天・」。`arb_state()` 的詞彙中，只有每一天的標題行是這樣的行。
fn is_day_header(line: &str) -> bool {
    line.starts_with("第 ") && line.contains("天・")
}

/// 需求 31.3：第 n 天的標題行「第 {n} 天・{M/D}（週{X}）｜{當日標題}」：M/D 是不補零的月與日，X 是 `date` 的星期；
/// 當日標題沒有設定，或經 `clean_text()` 之後是空字串時為「未命名的一天」。
fn header_line(state: &TripState, n: usize, date: Date) -> String {
    const WEEKDAYS: [char; 7] = ['日', '一', '二', '三', '四', '五', '六'];
    let weekday = WEEKDAYS[date.weekday().number_days_from_sunday() as usize];
    let title = state
        .day_settings
        .get(&date)
        .and_then(|setting| setting.title.as_deref())
        .map(clean_text)
        .filter(|title| !title.is_empty());
    format!(
        "第 {n} 天・{}/{}（週{weekday}）｜{}",
        u8::from(date.month()),
        date.day(),
        title.as_deref().unwrap_or("未命名的一天")
    )
}

/// 需求 31.5：這一天的路線行依路線的 Ordinal 排列，與出發時間無關。`block` 是這一天的區塊（「第 n 天」行之後的各行）；
/// 路線行是「路線」一行之後連續以「・」開頭的行，之後是抵達行、「活動」一行或區塊的結尾；沒有「路線」一行時沒有路線行。
fn check_route_lines(state: &TripState, date: Date, block: &[&str]) -> Result<(), TestCaseError> {
    let routes = routes_by_ordinal(state, date);
    let lines: Vec<&str> = match block.iter().position(|line| *line == "路線") {
        Some(at) => block[at + 1..]
            .iter()
            .take_while(|line| line.starts_with('・'))
            .copied()
            .collect(),
        None => Vec::new(),
    };
    prop_assert_eq!(
        lines.len(),
        routes.len(),
        "{} 的路線行數不是這一天的路線數；這一天的區塊：{:#?}",
        date,
        block
    );
    for (k, (line, route)) in (1..).zip(lines.iter().zip(&routes)) {
        prop_assert!(
            is_route_line(state, route, line),
            "{date} 的第 {k} 個路線行不是 Ordinal 第 {k} 小的路線 {}（Ordinal {}）：{line:?}\n這一天依 Ordinal 的路線：{routes:#?}",
            route.id,
            route.ordinal
        );
    }
    Ok(())
}

/// 日期為 `date` 的路線，依 Ordinal（相同時依 id）。在測試中另外排序，不使用 lm-core 的 `day_routes_by_ordinal()`。
fn routes_by_ordinal(state: &TripState, date: Date) -> Vec<&Route> {
    let mut routes: Vec<&Route> = state
        .routes
        .values()
        .filter(|route| route.day == date)
        .collect();
    routes.sort_by_key(|route| (route.ordinal, route.id));
    routes
}

/// `line` 是不是路線 `route` 的路線行（需求 31.5、31.6）：以「 → 」分成起點、每個停靠點與終點的部分。起點的部分是
/// 「・{車名}｜{HH:MM} 出發：{起點}」（出發時間留空時以「出發時間未填」取代「{HH:MM} 出發」），終點的部分是終點的名稱，
/// 第 j 個停靠點的部分以「{地點}（{任務}{ HH:MM，留空時為「・時間未填」}」開頭、以「）」結尾；停靠點的採買品項與備註
/// 依 Shopping_Plan，這裡不比對。名稱都經 `clean_text()`；`arb_state()` 的使用者文字都不含「 → 」。
fn is_route_line(state: &TripState, route: &Route, line: &str) -> bool {
    let vehicle = state
        .vehicles
        .get(&route.vehicle)
        .map(|vehicle| clean_text(&vehicle.name))
        .unwrap_or_default();
    let depart = route
        .depart
        .map_or_else(|| "出發時間未填".to_owned(), |time| format!("{time} 出發"));
    let parts: Vec<&str> = line.split(" → ").collect();
    let [first, stops @ .., last] = parts.as_slice() else {
        return false;
    };
    *first == format!("・{vehicle}｜{depart}：{}", place_text(state, route.from))
        && *last == place_text(state, route.to)
        && stops.len() == route.stops.len()
        && stops.iter().zip(&route.stops).all(|(part, stop)| {
            let time = stop
                .time
                .map_or_else(|| "・時間未填".to_owned(), |time| format!(" {time}"));
            let start = format!(
                "{}（{}{time}",
                place_text(state, stop.place),
                stop_task(stop).label()
            );
            part.starts_with(start.as_str()) && part.ends_with('）')
        })
}

/// 路線端點與停靠點的地點名稱，經 `clean_text()`：Destination_Place 是旅行目的地，地點清單中的地點是它目前的名稱。
fn place_text(state: &TripState, at: PlaceRef) -> String {
    clean_text(place_name(state, at))
}

/// s′：`state` 每一天的路線依 Ordinal 由小到大，出發時間依序改為 23:00、22:00、21:00…，其他都不變。出發時間兩兩不同，
/// 順序與 Ordinal 相反：依出發時間排列的路線行會整個倒過來，每一行也可以由出發時間辨認。
fn with_departures_against_ordinal(state: &TripState) -> TripState {
    let mut changed = state.clone();
    for date in trip_dates(state) {
        for (k, route) in (0_u8..).zip(routes_by_ordinal(state, date)) {
            // 每台車每天最多一條路線，arb_state() 最多 3 台車
            let depart = Hm::new(23 - k, 0).expect("每天最多 3 條路線，出發時間在 21:00–23:00");
            if let Some(target) = changed.routes.get_mut(&route.id) {
                target.depart = Some(depart);
            }
        }
    }
    changed
}
