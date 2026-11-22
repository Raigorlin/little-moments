//! Property 16 的屬性測試（任務 6.3；需求 18.5–18.8、33.5、33.6）：改日期（Retime）保留「第 N 天」。
//!
//! 對合法的狀態與新的 1–31 天範圍執行 `retime_by_day_index()`，再與測試另外算出的結果比較：
//!
//! - 被刪掉的舊範圍日子（舊第 N 天，N 大於新天數）中，有路線，或有標題（Trim_White 之後不是空的）、有地點的每日設定
//!   的那些日子，依 N 遞增，就是回傳的 `BlockedDay` 清單，而且 `draft` 不變（需求 18.7）。
//! - 沒有這樣的日子時成功：舊第 N 天的路線與每日設定在新的第 N 天（需求 18.5），活動與料理在新的第 min(N, 新天數) 天
//!   （需求 18.6），被刪掉日子的每日設定整列刪除（需求 18.8）；Trip_Card 只改起訖日期，這些列只改日期，其他的列都
//!   不變；結果滿足 I5。
//!
//! 輸入：
//!
//! - 共用產生器 `arb_state()` 的狀態（1–5 天，滿足 I1–I8、I10–I12），再依每一天的 [`DayEdit`] 修改，修改之後仍然
//!   合法。`arb_state()` 的每日設定標題都不是空白，所以一部分標題換成 [`TITLE_OVERRIDES`]：只有 Unicode White_Space
//!   的文字（不阻擋縮短），以及看起來是空白、但不是 White_Space 的 U+FEFF（阻擋縮短）。被刪掉的日子有一半先刪除路線、
//!   把每日設定的地點改為未設定，使縮短成功的案例也常見。
//! - 新範圍的開始日多數在舊開始日前後 6 天內（新舊範圍常常重疊，也包括不變），偶爾相隔很遠；天數多數是舊天數減 4 到
//!   加 1，其餘是 1–31 天中的任一個，或上限 31 天。
//!
//! 使用 proptest 的預設設定（256 個案例，設定 `PROPTEST_CASES=N` 時為 N 個），不覆寫案例數；proptest 找到的失敗案例
//! 寫在同一個目錄的 `prop_retime.proptest-regressions`，這個檔案提交進版本庫（需求 33.6）。

mod support;

use chrono::TimeDelta;
use lm_core::dates::{retime_by_day_index, BlockedDay};
use lm_core::limits::TRIP_DAYS;
use lm_core::model::{Date, DaySetting, TripState};
use proptest::collection::vec;
use proptest::option;
use proptest::prelude::*;
use proptest::sample::select;

use support::state::{arb_state, MAX_DAYS};

// Feature: rust-supabase-rewrite, Property 16: 改日期保留「第 N 天」
proptest! {
    /// *For any* 合法狀態與新的 1–31 天範圍，`retime_by_day_index()` 成功時，舊第 N 天的路線與每日設定都在新的第 N 天，
    /// 活動與料理在新的第 min(N, 新天數) 天，結果滿足 I5；失敗時 `draft` 不變，`blocked` 恰好是被刪掉、且有路線或有
    /// 標題、地點的日子。
    ///
    /// **Validates: Requirements 18.5, 18.6, 18.7, 18.8**
    #[test]
    fn retime_keeps_day_n_or_lists_exactly_the_blocking_days(
        state in arb_state(),
        edits in vec(arb_day_edit(), MAX_DAYS),
        shift in arb_shift(),
        count in arb_day_count(),
    ) {
        let old_days = days_between(state.card.start, state.card.end);
        let start = state
            .card
            .start
            .checked_add_signed(TimeDelta::days(shift))
            .expect("新的開始日在日期範圍內");
        let new_days: Vec<Date> = start.iter_days().take(count.days(old_days.len())).collect();
        let end = new_days[new_days.len() - 1];
        let before = edited(state, &edits, &old_days, new_days.len());
        // retime_by_day_index() 的前提：輸入滿足 I5；下面算預期結果時也依賴它
        check_i5(&before, "輸入")?;

        let blocked = expected_blocked(&before, &old_days, new_days.len());
        let expected = if blocked.is_empty() { Ok(()) } else { Err(blocked) };
        let mut draft = before.clone();
        let result = retime_by_day_index(&mut draft, start, end);
        prop_assert_eq!(
            &result,
            &expected,
            "舊範圍 {}–{}（{} 天）改為 {}–{}（{} 天）",
            before.card.start,
            before.card.end,
            old_days.len(),
            start,
            end,
            new_days.len()
        );
        match result {
            Ok(()) => check_success(&before, &draft, &old_days, &new_days)?,
            Err(_) => prop_assert_eq!(&draft, &before, "縮短天數被阻擋時，draft 應該不變"),
        }
    }
}

// ── 輸入 ──

/// 每日設定標題的替換文字。前五段只有 Unicode White_Space（包括 U+3000、U+0085、NBSP 與 U+2028），Trim_White 之後是
/// 空的，視為沒有標題，不阻擋縮短（需求 18.8）；最後一段 U+FEFF 是 JavaScript 的空白，但不是 Unicode White_Space，
/// 所以 Trim_White 之後不是空的，是有標題的每日設定，阻擋縮短（需求 18.7）。
const TITLE_OVERRIDES: &[&str] = &[
    "",
    " ",
    "\u{3000}",
    "\t\r\n",
    " \u{85}\u{a0}\u{2028}",
    "\u{feff}",
];

/// 對舊範圍某一天的修改：`edits[i]` 用於舊第 i + 1 天。修改之後的狀態仍然合法：只刪除路線、改每日設定的標題與地點，
/// 不改任何日期，也沒有其他列引用路線。
#[derive(Clone, Copy, Debug)]
struct DayEdit {
    /// 這一天的每日設定（有的話）的標題改為這段文字（[`TITLE_OVERRIDES`] 之一）。
    title: Option<&'static str>,
    /// 這一天被刪掉時（舊第 N 天，N 大於新天數）刪除這一天的路線，並把每日設定（有的話）的地點改為未設定：剩下的標題
    /// 是空白或沒有標題時，這一天不阻擋縮短。
    clear: bool,
}

fn arb_day_edit() -> impl Strategy<Value = DayEdit> {
    (
        option::weighted(0.4, select(TITLE_OVERRIDES)),
        any::<bool>(),
    )
        .prop_map(|(title, clear)| DayEdit { title, clear })
}

/// 新開始日相對舊開始日的天數：多數在前後 6 天內（新舊範圍常常重疊），也常常不變，偶爾相隔很遠。
fn arb_shift() -> impl Strategy<Value = i64> {
    prop_oneof![
        2 => Just(0_i64),
        6 => -6..=6_i64,
        1 => -1200..=1200_i64,
    ]
}

/// 新範圍的天數。
#[derive(Clone, Copy, Debug)]
enum DayCount {
    /// 舊天數加上這個值（可以是負數），至少 1 天。
    Relative(isize),
    /// 恰好這麼多天（1–31）。
    Exactly(usize),
}

impl DayCount {
    /// 舊範圍是 `old` 天時的新天數，1–31 天。
    fn days(self, old: usize) -> usize {
        match self {
            DayCount::Relative(delta) => old
                .saturating_add_signed(delta)
                .clamp(*TRIP_DAYS.start(), *TRIP_DAYS.end()),
            DayCount::Exactly(days) => days,
        }
    }
}

/// 多數是舊天數減 4 到加 1（縮短、不變與延長），其餘是 1–31 天中的任一個，或上限 31 天。
fn arb_day_count() -> impl Strategy<Value = DayCount> {
    prop_oneof![
        8 => (-4..=1_isize).prop_map(DayCount::Relative),
        1 => TRIP_DAYS.prop_map(DayCount::Exactly),
        1 => Just(DayCount::Exactly(*TRIP_DAYS.end())),
    ]
}

/// `state` 依 `edits` 修改的結果；`old_days` 是舊範圍的每一天，新範圍有 `new_count` 天。
fn edited(
    mut state: TripState,
    edits: &[DayEdit],
    old_days: &[Date],
    new_count: usize,
) -> TripState {
    for (i, (&day, edit)) in old_days.iter().zip(edits).enumerate() {
        if edit.clear && i >= new_count {
            state.routes.retain(|_, route| route.day != day);
            if let Some(setting) = state.day_settings.get_mut(&day) {
                setting.place = None;
            }
        }
        if let (Some(title), Some(setting)) = (edit.title, state.day_settings.get_mut(&day)) {
            setting.title = Some(title.to_owned());
        }
    }
    state
}

// ── 預期結果 ──

/// `start` 到 `end`（含兩端）的每一天，依日期遞增。
fn days_between(start: Date, end: Date) -> Vec<Date> {
    start.iter_days().take_while(|&day| day <= end).collect()
}

/// Trim_White 之後不是空的：含有不是 Unicode White_Space 的字元。
fn has_text(text: &str) -> bool {
    text.chars().any(|c| !c.is_whitespace())
}

/// 需求 18.7：被刪掉的舊範圍日子（舊第 N 天，N 大於新天數 `new_count`）中，有路線，或有標題（Trim_White 之後不是
/// 空的）、有地點的每日設定的日子，依 N 遞增；活動與料理不阻擋。
fn expected_blocked(state: &TripState, old_days: &[Date], new_count: usize) -> Vec<BlockedDay> {
    old_days
        .iter()
        .enumerate()
        .skip(new_count)
        .map(|(i, &date)| BlockedDay {
            n: i + 1,
            date,
            routes: state.routes.values().any(|route| route.day == date),
            settings: state.day_settings.values().any(|setting| {
                setting.day == date
                    && (setting.place.is_some() || setting.title.as_deref().is_some_and(has_text))
            }),
        })
        .filter(|day| day.routes || day.settings)
        .collect()
}

/// 成功時的預期狀態（需求 18.5、18.6、18.8）：Trip_Card 的起訖日期改為新範圍；舊第 N 天的路線與每日設定改到新的
/// 第 N 天，活動與料理改到新的第 min(N, 新天數) 天，都只改日期；被刪掉日子的每日設定整列刪除；其他的列都不變。
/// 只在預期成功時呼叫，所以被刪掉的日子上沒有路線。
fn expected_success(
    before: &TripState,
    old_days: &[Date],
    new_days: &[Date],
) -> Result<TripState, TestCaseError> {
    let last = new_days.len() - 1;
    // 舊第 N 天在 old_days 的位置是 N − 1；輸入滿足 I5，所以這些列的日期都找得到
    let position = |day: Date| old_days.iter().position(|&old| old == day);
    // 路線與每日設定：新的第 N 天；N 大於新天數（被刪掉的日子）時沒有
    let same_n = |day: Date| position(day).and_then(|i| new_days.get(i).copied());
    // 活動與料理：新的第 min(N, 新天數) 天；不在舊範圍內的到新的第 1 天
    let clamped = |day: Date| new_days[position(day).map_or(0, |i| i.min(last))];

    let mut expected = before.clone();
    expected.card.start = new_days[0];
    expected.card.end = new_days[last];
    for route in expected.routes.values_mut() {
        let Some(day) = same_n(route.day) else {
            return Err(TestCaseError::fail(format!(
                "路線 {} 在被刪掉的 {}，卻預期縮短成功",
                route.id, route.day
            )));
        };
        route.day = day;
    }
    expected.day_settings = before
        .day_settings
        .values()
        .filter_map(|setting| {
            let day = same_n(setting.day)?;
            Some((
                day,
                DaySetting {
                    day,
                    ..setting.clone()
                },
            ))
        })
        .collect();
    for activity in expected.activities.values_mut() {
        activity.day = clamped(activity.day);
    }
    for meal in expected.meals.values_mut() {
        meal.day = clamped(meal.day);
    }
    Ok(expected)
}

// ── 檢查 ──

/// 成功時：結果與 [`expected_success()`] 相同，並滿足 I5。
fn check_success(
    before: &TripState,
    after: &TripState,
    old_days: &[Date],
    new_days: &[Date],
) -> Result<(), TestCaseError> {
    let expected = expected_success(before, old_days, new_days)?;
    prop_assert_eq!(&after.card, &expected.card, "Trip_Card 應該只改起訖日期");
    prop_assert_eq!(
        &after.routes,
        &expected.routes,
        "舊第 N 天的路線應該在新的第 N 天，而且只改日期"
    );
    prop_assert_eq!(
        &after.day_settings,
        &expected.day_settings,
        "舊第 N 天的每日設定應該在新的第 N 天、只改日期，被刪掉日子的每日設定應該刪除"
    );
    prop_assert_eq!(
        &after.activities,
        &expected.activities,
        "舊第 N 天的活動應該在新的第 min(N, 新天數) 天，而且只改日期"
    );
    prop_assert_eq!(
        &after.meals,
        &expected.meals,
        "舊第 N 天的料理應該在新的第 min(N, 新天數) 天，而且只改日期"
    );
    check_i5(after, "結果")?;
    prop_assert_eq!(after, &expected, "其他的列應該都不變");
    Ok(())
}

/// I5：活動、料理、路線與每日設定的日期都在旅行範圍內（Trip_Card 的起訖日期之間）；每日設定的鍵就是它的日期。
fn check_i5(state: &TripState, what: &str) -> Result<(), TestCaseError> {
    let days = days_between(state.card.start, state.card.end);
    for activity in state.activities.values() {
        prop_assert!(
            days.contains(&activity.day),
            "{what}的活動 {} 的日期 {} 不在旅行範圍內",
            activity.id,
            activity.day
        );
    }
    for meal in state.meals.values() {
        prop_assert!(
            days.contains(&meal.day),
            "{what}的料理 {} 的日期 {} 不在旅行範圍內",
            meal.id,
            meal.day
        );
    }
    for route in state.routes.values() {
        prop_assert!(
            days.contains(&route.day),
            "{what}的路線 {} 的日期 {} 不在旅行範圍內",
            route.id,
            route.day
        );
    }
    for (key, setting) in &state.day_settings {
        prop_assert!(
            *key == setting.day && days.contains(key),
            "{what}的每日設定以 {key} 為鍵、日期是 {}：鍵與日期不同，或不在旅行範圍內",
            setting.day
        );
    }
    Ok(())
}
