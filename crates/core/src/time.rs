//! 時刻與日期：`Hm`（`HH:MM`）、`date_range`（Trip_Day）、`month_day`、`weekday_char`、
//! `date_text`（`10/20（週二）`）、`chinese_numeral` 與 `duration_text`。
//!
//! 移植自 `src/model.js` 的 `dateRange()`，以及 `src/itinerary-model.js` 的 `normalizeTimeInput()`、`monthDay()`、
//! `weekdayChar()`、`dateText()`、`chineseNumeral()` 與 `durationText()`。日期是沒有時區的 `time::Date`
//! （西元曆），只由輸入的日期計算，不讀系統時間、時區與語系，所以每台裝置得到相同的文字（需求 31.1、31.3）。

use std::fmt;

use serde::de::{self, Unexpected, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use time::macros::format_description;
use time::{Date, Duration, Month};

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

/// 日期欄位的 serde（`#[serde(with = "crate::time::iso_date")]`）：線上格式只有補零的 `YYYY-MM-DD` 字串
/// （`parse_date()`），與改用 time 之前的 chrono 寫出的字串相同；其他寫法、數字與陣列都不是日期。
/// `option` 用於 `Option<Date>`（`null` 為 `None`；欄位另加 `#[serde(default)]`）。
pub mod iso_date {
    use std::fmt;

    use serde::de::{self, Unexpected, Visitor};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use time::Date;

    /// 以 `YYYY-MM-DD` 讀寫的日期。
    #[derive(Clone, Copy)]
    struct Iso(Date);

    impl Serialize for Iso {
        fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.collect_str(&self.0)
        }
    }

    impl<'de> Deserialize<'de> for Iso {
        fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            struct IsoVisitor;
            impl Visitor<'_> for IsoVisitor {
                type Value = Iso;
                fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                    f.write_str("YYYY-MM-DD 的日期")
                }
                fn visit_str<E: de::Error>(self, value: &str) -> Result<Iso, E> {
                    super::parse_date(value)
                        .map(Iso)
                        .ok_or_else(|| E::invalid_value(Unexpected::Str(value), &self))
                }
            }
            deserializer.deserialize_str(IsoVisitor)
        }
    }

    pub fn serialize<S: Serializer>(date: &Date, serializer: S) -> Result<S::Ok, S::Error> {
        Iso(*date).serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Date, D::Error> {
        Iso::deserialize(deserializer).map(|iso| iso.0)
    }

    /// `Option<Date>`：`None` 為 `null`。
    pub mod option {
        use super::*;

        pub fn serialize<S: Serializer>(
            date: &Option<Date>,
            serializer: S,
        ) -> Result<S::Ok, S::Error> {
            date.map(Iso).serialize(serializer)
        }

        pub fn deserialize<'de, D: Deserializer<'de>>(
            deserializer: D,
        ) -> Result<Option<Date>, D::Error> {
            Option::<Iso>::deserialize(deserializer).map(|date| date.map(|iso| iso.0))
        }
    }
}

/// 星期，依 `Weekday::number_days_from_sunday()` 的順序。
const WEEKDAYS: [char; 7] = ['日', '一', '二', '三', '四', '五', '六'];

/// 中文數字 1–9；索引 0 不寫。
const DIGITS: [&str; 10] = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/// 旅行的每一天（Trip_Day）：`start` 到 `end`（含兩端）依日期遞增（現行 `dateRange()`）。
/// `end` 早於 `start`，或超過 `limits::TRIP_DAYS` 的 31 天時是空的，例如 2028-02-28 到 2028-03-01 是 3 天。
pub fn date_range(start: Date, end: Date) -> Vec<Date> {
    // end 早於 start 時天數小於 1；轉成 usize 失敗或不在 1–31 天都是空的
    let days = days_between(start, end) + 1;
    match usize::try_from(days) {
        Ok(days) if limits::TRIP_DAYS.contains(&days) => iter_days(start).take(days).collect(),
        _ => Vec::new(),
    }
}
/// `year` 年 `month` 月 `day` 日；不是有效的日期時是 `None`。
pub fn ymd(year: i32, month: u8, day: u8) -> Option<Date> {
    Date::from_calendar_date(year, Month::try_from(month).ok()?, day).ok()
}
/// 補零的 `YYYY-MM-DD`（與 JSON 中的日期同一格式，例如 `<input type="date">` 的值）；其他寫法、空字串或不是
/// 有效的日期時是 `None`。
pub fn parse_date(text: &str) -> Option<Date> {
    // 與 Bun 的 /^\d{4}-\d{2}-\d{2}$/ 相同：年份恰好四位數字，沒有正負號（time 的 [year] 另外接受 +／-）
    if text.len() != 10 || !text.as_bytes()[..4].iter().all(u8::is_ascii_digit) {
        return None;
    }
    Date::parse(text, format_description!("[year]-[month]-[day]")).ok()
}
/// `from` 到 `to` 的天數；`to` 早於 `from` 時是負數。
pub fn days_between(from: Date, to: Date) -> i64 {
    (to - from).whole_days()
}
/// `date` 加上 `days` 天（可以是負數）；超出可表示的日期時是 `None`。
pub fn add_days(date: Date, days: i64) -> Option<Date> {
    date.checked_add(Duration::days(days))
}
/// 從 `start` 起依日期遞增的每一天。
pub fn iter_days(start: Date) -> impl Iterator<Item = Date> {
    std::iter::successors(Some(start), |day| day.next_day())
}

/// 不補零的「{月}/{日}」，例如 2026-10-20 為「10/20」、2027-01-05 為「1/5」（現行 `monthDay()`）。
pub fn month_day(date: Date) -> String {
    format!("{}/{}", u8::from(date.month()), date.day())
}

/// 星期的一個字：日、一、二、三、四、五、六之一（現行 `weekdayChar()`）。
pub fn weekday_char(date: Date) -> char {
    WEEKDAYS[date.weekday().number_days_from_sunday() as usize]
}

/// 「{M/D}（週{X}）」，例如 2026-10-20 為「10/20（週二）」（需求 31.3，現行 `dateText()`）；
/// 括號是全形的 U+FF08 與 U+FF09（需求 31.18）。
pub fn date_text(date: Date) -> String {
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

    fn day(year: i32, month: u8, day: u8) -> Date {
        ymd(year, month, day).expect("有效的日期")
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

    /// 日期欄位（`iso_date` 與 `iso_date::option`）的線上格式。
    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Dated {
        #[serde(with = "iso_date")]
        day: Date,
        #[serde(default, with = "iso_date::option")]
        maybe: Option<Date>,
    }

    #[test]
    fn dates_are_written_and_parsed_as_yyyy_mm_dd() {
        // 線上格式（與改用 time 之前的 chrono 相同）：補零的 YYYY-MM-DD
        for (date, text) in [
            (day(2026, 10, 20), "2026-10-20"),
            (day(2027, 1, 5), "2027-01-05"),
            (day(1, 1, 1), "0001-01-01"),
            (day(9999, 12, 31), "9999-12-31"),
        ] {
            assert_eq!(date.to_string(), text);
            assert_eq!(parse_date(text), Some(date), "{text}");
            let dated = Dated {
                day: date,
                maybe: Some(date),
            };
            let json = serde_json::json!({ "day": text, "maybe": text });
            assert_eq!(serde_json::to_value(&dated).expect("可以序列化"), json);
            assert_eq!(
                serde_json::from_value::<Dated>(json).expect("可以解析"),
                dated
            );
        }
        let unset = Dated {
            day: day(2026, 10, 20),
            maybe: None,
        };
        assert_eq!(
            serde_json::to_string(&unset).expect("可以序列化"),
            r#"{"day":"2026-10-20","maybe":null}"#
        );
        for json in [
            r#"{"day":"2026-10-20","maybe":null}"#,
            r#"{"day":"2026-10-20"}"#,
        ] {
            assert_eq!(
                serde_json::from_str::<Dated>(json).expect("可以解析"),
                unset,
                "{json}"
            );
        }
        // 只接受 YYYY-MM-DD 字串：其他寫法、不存在的日期、數字、陣列（[年, 一年中的第幾天]）與 null 都不是日期
        for text in [
            "",
            "2026-02-30",
            "2026-13-01",
            "2026-1-5",
            "26-01-05",
            "2026/01/05",
            "2026-01-05T00:00",
            " 2026-01-05",
            "2026-01-05 ",
            "+2026-01-05",
            "+02026-01-05",
            "-2026-01-05",
            "２０２６-01-05",
        ] {
            assert_eq!(parse_date(text), None, "{text:?}");
            let json = serde_json::json!({ "day": text });
            assert!(serde_json::from_value::<Dated>(json).is_err(), "{text:?}");
        }
        for value in [
            serde_json::json!([2026, 293]),
            serde_json::json!(20261020),
            serde_json::json!(null),
            serde_json::json!({ "year": 2026 }),
        ] {
            let json = serde_json::json!({ "day": value.clone() });
            assert!(serde_json::from_value::<Dated>(json).is_err(), "{value}");
            let json = serde_json::json!({ "day": "2026-10-20", "maybe": value.clone() });
            assert_eq!(
                serde_json::from_value::<Dated>(json).is_ok(),
                value.is_null(),
                "{value}"
            );
        }
    }
    #[test]
    fn date_helpers_count_and_step_days() {
        assert_eq!(ymd(2026, 2, 29), None);
        assert_eq!(ymd(2026, 0, 1), None);
        assert_eq!(days_between(day(2026, 10, 20), day(2026, 10, 27)), 7);
        assert_eq!(days_between(day(2026, 10, 27), day(2026, 10, 20)), -7);
        assert_eq!(add_days(day(2028, 2, 28), 1), Some(day(2028, 2, 29)));
        assert_eq!(add_days(day(2027, 1, 1), -1), Some(day(2026, 12, 31)));
        assert_eq!(add_days(Date::MAX, 1), None);
        let days: Vec<Date> = iter_days(day(2026, 12, 30)).take(3).collect();
        assert_eq!(
            days,
            [day(2026, 12, 30), day(2026, 12, 31), day(2027, 1, 1)]
        );
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
