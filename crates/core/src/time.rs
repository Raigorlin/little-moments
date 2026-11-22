//! 日期與天數的文字：`date_range`（Trip_Day）、`month_day`、`weekday_char`、`date_text`（`10/20（週二）`）、
//! `chinese_numeral` 與 `duration_text`。
//!
//! 移植自 `src/model.js` 的 `dateRange()`，以及 `src/itinerary-model.js` 的 `monthDay()`、`weekdayChar()`、
//! `dateText()`、`chineseNumeral()` 與 `durationText()`。日期是沒有時區的 `chrono::NaiveDate`（西元曆），
//! 只由輸入的日期計算，不讀系統時間、時區與語系，所以每台裝置得到相同的文字（需求 31.1、31.3）。

use chrono::{Datelike, NaiveDate};

/// 一趟旅行最多的天數（含頭尾 1–31 天）。
const MAX_TRIP_DAYS: i64 = 31;

/// 星期，依 `Weekday::num_days_from_sunday()` 的順序。
const WEEKDAYS: [char; 7] = ['日', '一', '二', '三', '四', '五', '六'];

/// 中文數字 1–9；索引 0 不寫。
const DIGITS: [&str; 10] = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/// 旅行的每一天（Trip_Day）：`start` 到 `end`（含兩端）依日期遞增（現行 `dateRange()`）。
/// `end` 早於 `start`，或超過 31 天時是空的，例如 2028-02-28 到 2028-03-01 是 3 天。
pub fn date_range(start: NaiveDate, end: NaiveDate) -> Vec<NaiveDate> {
    if end < start || end.signed_duration_since(start).num_days() >= MAX_TRIP_DAYS {
        return Vec::new();
    }
    start.iter_days().take_while(|day| *day <= end).collect()
}

/// 不補零的「{月}/{日}」，例如 2026-10-20 為「10/20」、2027-01-05 為「1/5」（現行 `monthDay()`）。
pub fn month_day(date: NaiveDate) -> String {
    format!("{}/{}", date.month(), date.day())
}

/// 星期的一個字：日、一、二、三、四、五、六之一（現行 `weekdayChar()`）。
pub fn weekday_char(date: NaiveDate) -> char {
    WEEKDAYS[date.weekday().num_days_from_sunday() as usize]
}

/// 「{M/D}（週{X}）」，例如 2026-10-20 為「10/20（週二）」（需求 31.3，現行 `dateText()`）；
/// 括號是全形的 U+FF08 與 U+FF09（需求 31.18）。
pub fn date_text(date: NaiveDate) -> String {
    format!("{}（週{}）", month_day(date), weekday_char(date))
}

/// Chinese_Numeral：1–99 寫成中文數字，只有 2 寫作「兩」，例如 10 為「十」、12 為「十二」、22 為「二十二」；
/// 0 與 100 以上寫成不加千分位符號的阿拉伯數字（現行 `chineseNumeral()`）。
pub fn chinese_numeral(n: usize) -> String {
    if n == 2 {
        return "兩".to_owned();
    }
    if !(1..=99).contains(&n) {
        return n.to_string();
    }
    let (tens, ones) = (n / 10, n % 10);
    let mut out = String::new();
    if tens > 1 {
        out.push_str(DIGITS[tens]);
    }
    if tens > 0 {
        out.push('十');
    }
    out.push_str(DIGITS[ones]);
    out
}

/// Duration_Text：1 天為「一日遊」，其他為「{天數}天{天數 − 1}夜」，例如「兩天一夜」「三天兩夜」
/// （現行 `durationText()`）。旅行是 1–31 天；`days` 為 0 時夜數以 0 計。
pub fn duration_text(days: usize) -> String {
    if days == 1 {
        return "一日遊".to_owned();
    }
    format!(
        "{}天{}夜",
        chinese_numeral(days),
        chinese_numeral(days.saturating_sub(1))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(year: i32, month: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(year, month, day).expect("有效的日期")
    }

    #[test]
    fn date_range_lists_one_to_31_days() {
        assert_eq!(
            date_range(day(2028, 2, 28), day(2028, 3, 1)),
            vec![day(2028, 2, 28), day(2028, 2, 29), day(2028, 3, 1)]
        );
        assert_eq!(
            date_range(day(2026, 10, 20), day(2026, 10, 20)),
            vec![day(2026, 10, 20)]
        );
        let january = date_range(day(2026, 1, 1), day(2026, 1, 31));
        assert_eq!(january.len(), 31);
        assert_eq!(january.last(), Some(&day(2026, 1, 31)));
    }

    #[test]
    fn date_range_is_empty_when_reversed_or_longer_than_31_days() {
        assert!(date_range(day(2026, 11, 22), day(2026, 11, 20)).is_empty());
        assert!(date_range(day(2026, 1, 1), day(2026, 2, 1)).is_empty());
        assert!(date_range(day(2026, 1, 1), day(2026, 3, 1)).is_empty());
    }

    #[test]
    fn date_text_uses_unpadded_month_and_day_and_the_weekday() {
        // 需求 31.3 的例子
        assert_eq!(date_text(day(2026, 10, 20)), "10/20（週二）");
        assert_eq!(date_text(day(2026, 10, 21)), "10/21（週三）");
        assert_eq!(month_day(day(2027, 1, 5)), "1/5");
        let week: String = date_range(day(2026, 10, 18), day(2026, 10, 24))
            .into_iter()
            .map(weekday_char)
            .collect();
        assert_eq!(week, "日一二三四五六");
        // 跨過閏日與年份
        assert_eq!(date_text(day(2028, 2, 29)), "2/29（週二）");
        assert_eq!(date_text(day(2027, 1, 1)), "1/1（週五）");
    }

    #[test]
    fn chinese_numeral_writes_1_to_99_in_chinese() {
        let cases = [
            (1, "一"),
            (2, "兩"),
            (9, "九"),
            (10, "十"),
            (11, "十一"),
            (12, "十二"),
            (20, "二十"),
            (22, "二十二"),
            (31, "三十一"),
            (99, "九十九"),
            (0, "0"),
            (100, "100"),
            (1000, "1000"),
        ];
        for (n, text) in cases {
            assert_eq!(chinese_numeral(n), text, "{n}");
        }
    }

    #[test]
    fn duration_text_counts_days_and_nights() {
        assert_eq!(duration_text(1), "一日遊");
        assert_eq!(duration_text(2), "兩天一夜");
        assert_eq!(duration_text(3), "三天兩夜");
        assert_eq!(duration_text(13), "十三天十二夜");
        assert_eq!(duration_text(31), "三十一天三十夜");
    }
}
