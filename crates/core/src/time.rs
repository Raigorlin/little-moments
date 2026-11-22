//! 時刻與日期：`Hm`（`HH:MM`）、`date_range`（Trip_Day）、`month_day`、`weekday_char`、
//! `date_text`（`10/20（週二）`）、`chinese_numeral` 與 `duration_text`。
//!
//! 移植自 `src/model.js` 的 `dateRange()`，以及 `src/itinerary-model.js` 的 `normalizeTimeInput()`、`monthDay()`、
//! `weekdayChar()`、`dateText()`、`chineseNumeral()` 與 `durationText()`。日期是沒有時區的 `chrono::NaiveDate`
//! （西元曆），只由輸入的日期計算，不讀系統時間、時區與語系，所以每台裝置得到相同的文字（需求 31.1、31.3）。

use std::fmt;

use chrono::{Datelike, NaiveDate};
use serde::de::{self, Unexpected, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::limits;
use crate::text::{normalize_time_input, InvalidTime};

/// 24 小時制的時刻（Time_Value 00:00–23:59），以從 00:00 起算的分鐘數（0..1440）儲存，依時間先後比較。
///
/// 線上格式與 `Display` 都是補零的 `HH:MM`，例如 `"08:30"`；選填的時刻（`Option<Hm>`）沒有設定時是 `null`。
/// 反序列化與 `parse()` 都以 `normalize_time_input()` 解析，所以「０８：３０」也是 08:30；「8:30」「24:00」、
/// 只填一部分的「08:」與空字串都不是 `Hm`。
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Hm(u16);

impl Hm {
    /// 一天的分鐘數。
    const MINUTES_PER_DAY: u16 = 24 * 60;

    /// `hour` 時 `minute` 分；不在 00:00–23:59 時是 `None`。
    pub const fn new(hour: u8, minute: u8) -> Option<Hm> {
        if hour < 24 && minute < 60 {
            Some(Hm(hour as u16 * 60 + minute as u16))
        } else {
            None
        }
    }

    /// 從 00:00 起算的分鐘數；不在 0..1440 時是 `None`。
    pub const fn from_minutes(minutes: u16) -> Option<Hm> {
        if minutes < Self::MINUTES_PER_DAY {
            Some(Hm(minutes))
        } else {
            None
        }
    }

    /// 從 00:00 起算的分鐘數（0..1440）。
    pub const fn minutes(self) -> u16 {
        self.0
    }

    /// 時刻欄位的輸入（`normalize_time_input()`）：Time_Value 為 `Ok(Some(_))`，留空為 `Ok(None)`，
    /// 其他為 `Err(InvalidTime)`。
    pub fn parse(raw: &str) -> Result<Option<Hm>, InvalidTime> {
        // normalize_time_input() 只回傳 00:00–23:59 的分鐘數
        normalize_time_input(raw).map(|minutes| minutes.map(Hm))
    }
}

impl fmt::Display for Hm {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:02}:{:02}", self.0 / 60, self.0 % 60)
    }
}

impl fmt::Debug for Hm {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Hm({self})")
    }
}

impl Serialize for Hm {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Hm {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct HmVisitor;

        impl Visitor<'_> for HmVisitor {
            type Value = Hm;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("00:00–23:59 的 HH:MM 時刻")
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Hm, E> {
                match Hm::parse(value) {
                    Ok(Some(hm)) => Ok(hm),
                    Ok(None) | Err(InvalidTime) => {
                        Err(E::invalid_value(Unexpected::Str(value), &self))
                    }
                }
            }
        }

        deserializer.deserialize_str(HmVisitor)
    }
}

/// 星期，依 `Weekday::num_days_from_sunday()` 的順序。
const WEEKDAYS: [char; 7] = ['日', '一', '二', '三', '四', '五', '六'];

/// 中文數字 1–9；索引 0 不寫。
const DIGITS: [&str; 10] = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/// 旅行的每一天（Trip_Day）：`start` 到 `end`（含兩端）依日期遞增（現行 `dateRange()`）。
/// `end` 早於 `start`，或超過 `limits::TRIP_DAYS` 的 31 天時是空的，例如 2028-02-28 到 2028-03-01 是 3 天。
pub fn date_range(start: NaiveDate, end: NaiveDate) -> Vec<NaiveDate> {
    // end 早於 start 時天數小於 1；轉成 usize 失敗或不在 1–31 天都是空的
    let days = end.signed_duration_since(start).num_days() + 1;
    match usize::try_from(days) {
        Ok(days) if limits::TRIP_DAYS.contains(&days) => start.iter_days().take(days).collect(),
        _ => Vec::new(),
    }
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

    fn hm(hour: u8, minute: u8) -> Hm {
        Hm::new(hour, minute).expect("有效的時刻")
    }

    #[test]
    fn hm_holds_minutes_from_midnight() {
        assert_eq!(hm(0, 0).minutes(), 0);
        assert_eq!(hm(8, 30).minutes(), 510);
        assert_eq!(hm(23, 59).minutes(), 1439);
        assert_eq!(Hm::from_minutes(510), Some(hm(8, 30)));
        assert_eq!(Hm::from_minutes(1439), Some(hm(23, 59)));
        assert_eq!(Hm::from_minutes(1440), None);
        assert_eq!(Hm::new(24, 0), None);
        assert_eq!(Hm::new(23, 60), None);
        // 依時間先後比較
        assert!(hm(8, 0) < hm(8, 30) && hm(8, 30) < hm(14, 0));
    }

    #[test]
    fn hm_is_written_as_padded_hh_mm() {
        assert_eq!(hm(8, 5).to_string(), "08:05");
        assert_eq!(hm(0, 0).to_string(), "00:00");
        assert_eq!(hm(23, 59).to_string(), "23:59");
        assert_eq!(format!("{:?}", hm(8, 30)), "Hm(08:30)");
    }

    #[test]
    fn hm_parse_follows_normalize_time_input() {
        assert_eq!(Hm::parse("０８：３０"), Ok(Some(hm(8, 30))));
        assert_eq!(Hm::parse(" 12:00\n"), Ok(Some(hm(12, 0))));
        assert_eq!(Hm::parse(""), Ok(None));
        assert_eq!(Hm::parse("\u{3000}"), Ok(None));
        for raw in ["8:30", "24:00", "08:", "08:30:00", "\u{feff}08:30"] {
            assert_eq!(Hm::parse(raw), Err(InvalidTime), "{raw:?}");
        }
    }

    #[test]
    fn hm_round_trips_through_the_wire_format() {
        let json = serde_json::to_value(hm(8, 30)).expect("可以序列化");
        assert_eq!(json, "08:30");
        assert_eq!(
            serde_json::from_value::<Hm>(json).expect("可以解析"),
            hm(8, 30)
        );
        // 以 normalize_time_input() 解析：全形的時刻也接受，輸出一律是半形
        let wide: Hm = serde_json::from_value(serde_json::json!("２３：５９")).expect("可以解析");
        assert_eq!(serde_json::to_value(wide).expect("可以序列化"), "23:59");
        // 選填的時刻沒有設定時是 null
        let unset: Option<Hm> = serde_json::from_value(serde_json::Value::Null).expect("可以解析");
        assert_eq!(unset, None);
        assert_eq!(
            serde_json::to_value(None::<Hm>).expect("可以序列化"),
            serde_json::Value::Null
        );
    }

    #[test]
    fn hm_rejects_blank_partial_and_out_of_range_values() {
        for value in [
            serde_json::json!(""),
            serde_json::json!(" "),
            serde_json::json!("8:30"),
            serde_json::json!("24:00"),
            serde_json::json!("08:"),
            serde_json::json!(510),
            serde_json::json!(null),
        ] {
            assert!(
                serde_json::from_value::<Hm>(value.clone()).is_err(),
                "{value}"
            );
        }
        // Option<Hm> 只以 null 表示沒有設定，空字串不是
        assert!(serde_json::from_value::<Option<Hm>>(serde_json::json!("")).is_err());
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
