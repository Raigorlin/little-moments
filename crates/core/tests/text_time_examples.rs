//! 文字與時間規則的範例測試（需求 33.1、33.10）。
//!
//! 移植 Bun_App 測試中以固定輸入斷言第一版規則的案例：輸入與原案例相同，預期值與原案例相同並直接寫在測試中，也就是
//! Bun_App 對同一輸入的結果。每個測試上方的註解標明來源的測試檔與測試名稱；表格的每一列是一個案例。
//!
//! - `tests/itinerary-numerals.test.js`（trip-planning-workflow-enhance 的 Property 17）：固定輸入是 fast-check 每次都
//!   先執行的 `examples`，也就是 Chinese_Numeral 的 1 到 99、100 與 1000，以及 Duration_Text 的 1 到 31 天，共 132 個
//!   案例，全部移植。同一個測試中隨機產生的輸入不移植（需求 33.1）。
//! - `tests/itinerary-time-input.test.js`（Property 16）：四個測試都沒有 `examples`，每個輸入都由產生器隨機組成，
//!   沒有可以移植的固定輸入。為了讓 Time_Value 的每一類輸入都有範例，本檔另以該檔的測試名稱、檔頭註解與錯誤產生器的
//!   註解寫出的輸入（例如「08:」「8:00」「24:00」「0⑧:30」）寫成範例，預期值是該檔對那一類輸入的斷言，與 Bun_App
//!   對同一輸入的結果相同。這些範例不算移植的案例。
//! - 需求 33.10 的 Participant_Name 案例：「小」加 U+FEFF 加「安」正規化為「小 安」。
//!
//! 不移植的案例與原因：
//!
//! - `tests/itinerary-numerals.test.js` 的 `本檔的解析函式只接受正確的位數寫法`：斷言的是該檔自己撰寫的解析函式
//!   `parseNumeral()`，不是 Bun_App 的規則；本檔直接寫出每個預期的文字，不使用這個解析函式。
//! - `tests/itinerary-time-input.test.js` 的四個測試：`回傳空值、HH:MM 或錯誤三者之一，與參考判斷相同`、
//!   `去除前後空白後為空時為空值；00:00 到 23:59 的 HH:MM 加上前後空白、數字與冒號換成全形時為半形的 HH:MM`、
//!   `只有時或分、一位數的時或分、24:00 以後、含秒數與其他文字為錯誤`，以及
//!   `結果的 HH:MM 與空值符合 State_Validator 的定義，不需要正規化的輸入與既有活動時間的檢查結果相同（需求 18.3）`：
//!   輸入都是隨機產生的。最後一個測試另外以現行的 `isValidState()` 檢查 `seed()` 加上路線、每日設定、料理或活動的
//!   時間欄位；第一版的 State_Validator 是 `validate::state()`，資料格式也不同。

use lm_core::text::{normalize_time_input, participant_name, InvalidTime};
use lm_core::time::{chinese_numeral, duration_text, Hm};
use unicode_normalization::UnicodeNormalization;

/// `normalize_time_input(raw)` 寫成現行 `normalizeTimeInput()` 的形式：`Ok(None)` 是留空（`{ value: '' }`），
/// `Ok(Some("HH:MM"))` 是 Time_Value（`{ value: 'HH:MM' }`，以 `Hm` 寫成補零的 `HH:MM`），`Err(InvalidTime)` 是
/// `{ error: 'invalid' }`。
fn time_input(raw: &str) -> Result<Option<String>, InvalidTime> {
    normalize_time_input(raw).map(|minutes| {
        minutes.map(|minutes| {
            Hm::from_minutes(minutes)
                .expect("Time_Value 是 0..1440 的分鐘數")
                .to_string()
        })
    })
}

/// `normalize_time_input(raw)` 的結果是 `expected`。
fn assert_time_input(raw: &str, expected: Result<Option<&str>, InvalidTime>) {
    assert_eq!(
        time_input(raw),
        expected.map(|value| value.map(str::to_owned)),
        "normalize_time_input({raw:?})"
    );
}

/// 來源：`tests/itinerary-numerals.test.js` 的測試 `1 到 99：解析結果等於原數值，且只有 2 寫作「兩」`，
/// `examples: everyValue(1, 99)` 的每個值各是一個案例。原測試以該檔的解析函式讀回原數值，並斷言結果含「兩」若且唯若
/// 數值是 2；這裡直接寫出 Bun_App 的 `chineseNumeral()` 對每個值的結果。
#[test]
fn chinese_numeral_writes_1_to_99_in_chinese() {
    let cases = [
        (1, "一"),
        (2, "兩"),
        (3, "三"),
        (4, "四"),
        (5, "五"),
        (6, "六"),
        (7, "七"),
        (8, "八"),
        (9, "九"),
        (10, "十"),
        (11, "十一"),
        (12, "十二"),
        (13, "十三"),
        (14, "十四"),
        (15, "十五"),
        (16, "十六"),
        (17, "十七"),
        (18, "十八"),
        (19, "十九"),
        (20, "二十"),
        (21, "二十一"),
        (22, "二十二"),
        (23, "二十三"),
        (24, "二十四"),
        (25, "二十五"),
        (26, "二十六"),
        (27, "二十七"),
        (28, "二十八"),
        (29, "二十九"),
        (30, "三十"),
        (31, "三十一"),
        (32, "三十二"),
        (33, "三十三"),
        (34, "三十四"),
        (35, "三十五"),
        (36, "三十六"),
        (37, "三十七"),
        (38, "三十八"),
        (39, "三十九"),
        (40, "四十"),
        (41, "四十一"),
        (42, "四十二"),
        (43, "四十三"),
        (44, "四十四"),
        (45, "四十五"),
        (46, "四十六"),
        (47, "四十七"),
        (48, "四十八"),
        (49, "四十九"),
        (50, "五十"),
        (51, "五十一"),
        (52, "五十二"),
        (53, "五十三"),
        (54, "五十四"),
        (55, "五十五"),
        (56, "五十六"),
        (57, "五十七"),
        (58, "五十八"),
        (59, "五十九"),
        (60, "六十"),
        (61, "六十一"),
        (62, "六十二"),
        (63, "六十三"),
        (64, "六十四"),
        (65, "六十五"),
        (66, "六十六"),
        (67, "六十七"),
        (68, "六十八"),
        (69, "六十九"),
        (70, "七十"),
        (71, "七十一"),
        (72, "七十二"),
        (73, "七十三"),
        (74, "七十四"),
        (75, "七十五"),
        (76, "七十六"),
        (77, "七十七"),
        (78, "七十八"),
        (79, "七十九"),
        (80, "八十"),
        (81, "八十一"),
        (82, "八十二"),
        (83, "八十三"),
        (84, "八十四"),
        (85, "八十五"),
        (86, "八十六"),
        (87, "八十七"),
        (88, "八十八"),
        (89, "八十九"),
        (90, "九十"),
        (91, "九十一"),
        (92, "九十二"),
        (93, "九十三"),
        (94, "九十四"),
        (95, "九十五"),
        (96, "九十六"),
        (97, "九十七"),
        (98, "九十八"),
        (99, "九十九"),
    ];
    // 與 everyValue(1, 99) 相同：1 到 99 依序各一列
    assert!(cases.iter().map(|&(n, _)| n).eq(1..=99));
    for (n, expected) in cases {
        let text = chinese_numeral(n);
        assert_eq!(text, expected, "chinese_numeral({n})");
        // 原測試的第二個斷言：只有 2 寫作「兩」
        assert_eq!(text.contains('兩'), n == 2, "chinese_numeral({n})");
    }
}

/// 來源：`tests/itinerary-numerals.test.js` 的測試 `100 以上：等於 String(n)，不加千分位符號`，
/// `examples: [[100], [1000]]` 的兩個值各是一個案例。
#[test]
fn chinese_numeral_writes_100_and_above_in_arabic_numerals() {
    for (n, expected) in [(100, "100"), (1000, "1000")] {
        assert_eq!(chinese_numeral(n), expected, "chinese_numeral({n})");
    }
}

/// 來源：`tests/itinerary-numerals.test.js` 的測試 `1 到 31 天：1 天為「一日遊」，其他為「{天數}天{天數減 1}夜」`，
/// `examples: everyValue(1, 31)` 的每個值各是一個案例；這裡直接寫出 Bun_App 的 `durationText()` 對每個值的結果。
#[test]
fn duration_text_for_1_to_31_days() {
    let cases = [
        (1, "一日遊"),
        (2, "兩天一夜"),
        (3, "三天兩夜"),
        (4, "四天三夜"),
        (5, "五天四夜"),
        (6, "六天五夜"),
        (7, "七天六夜"),
        (8, "八天七夜"),
        (9, "九天八夜"),
        (10, "十天九夜"),
        (11, "十一天十夜"),
        (12, "十二天十一夜"),
        (13, "十三天十二夜"),
        (14, "十四天十三夜"),
        (15, "十五天十四夜"),
        (16, "十六天十五夜"),
        (17, "十七天十六夜"),
        (18, "十八天十七夜"),
        (19, "十九天十八夜"),
        (20, "二十天十九夜"),
        (21, "二十一天二十夜"),
        (22, "二十二天二十一夜"),
        (23, "二十三天二十二夜"),
        (24, "二十四天二十三夜"),
        (25, "二十五天二十四夜"),
        (26, "二十六天二十五夜"),
        (27, "二十七天二十六夜"),
        (28, "二十八天二十七夜"),
        (29, "二十九天二十八夜"),
        (30, "三十天二十九夜"),
        (31, "三十一天三十夜"),
    ];
    // 與 everyValue(1, 31) 相同：1 到 31 天依序各一列
    assert!(cases.iter().map(|&(days, _)| days).eq(1..=31));
    for (days, expected) in cases {
        assert_eq!(duration_text(days), expected, "duration_text({days})");
    }
}

/// 範例取自 `tests/itinerary-time-input.test.js` 的測試
/// `去除前後空白後為空時為空值；00:00 到 23:59 的 HH:MM 加上前後空白、數字與冒號換成全形時為半形的 HH:MM`：
/// 檔頭註解舉出的全形空白與換行，以及測試名稱中的 00:00 與 23:59。
#[test]
fn time_input_blank_and_clock_examples() {
    // 去除前後的 White_Space 之後是空的：留空
    assert_time_input("\u{3000}", Ok(None));
    assert_time_input("\n", Ok(None));
    // Time_Value 的兩端
    assert_time_input("00:00", Ok(Some("00:00")));
    assert_time_input("23:59", Ok(Some("23:59")));
}

/// 範例取自 `tests/itinerary-time-input.test.js` 的測試
/// `只有時或分、一位數的時或分、24:00 以後、含秒數與其他文字為錯誤`：各類錯誤的產生器註解舉出的寫法。
#[test]
fn time_input_error_examples() {
    let examples: [(&str, &[&str]); 5] = [
        (
            "只有時或分，或少了冒號",
            &["08", "08:", "8:", ":30", "0830", ":"],
        ),
        ("一位數的時或分", &["8:00", "08:5", "8:5"]),
        ("超出範圍", &["24:00"]),
        ("含秒數", &["08:30:00", "08:30:"]),
        ("時或分多一位數", &["008:30", "08:300", "08:030"]),
    ];
    for (kind, inputs) in examples {
        for &raw in inputs {
            assert_eq!(
                time_input(raw),
                Err(InvalidTime),
                "{kind}：normalize_time_input({raw:?})"
            );
        }
    }
}

/// 範例取自同一個測試的相容字元產生器：註解舉出的「0⑧:30」「²3:00」「08﹕30」。不在 U+3000 與 U+FF01–U+FFEE 的
/// 相容字元不換成半形，所以是錯誤；原測試另外斷言這些輸入整串 NFKC 之後是有效的時刻。
#[test]
fn time_input_compatibility_characters_are_not_folded() {
    // （輸入, 整串 NFKC 之後）：⑧ 是 U+2467，² 是 U+00B2，﹕ 是 U+FE55
    for (raw, nfkc) in [
        ("0\u{2467}:30", "08:30"),
        ("\u{b2}3:00", "23:00"),
        ("08\u{fe55}30", "08:30"),
    ] {
        assert_time_input(raw, Err(InvalidTime));
        assert_eq!(raw.nfkc().collect::<String>(), nfkc, "{raw:?} 的 NFKC");
        assert_time_input(nfkc, Ok(Some(nfkc)));
    }
}

/// 範例取自同一個測試的隱藏字元產生器與檔頭註解：U+200B、U+FEFF 這類看不見但不是 White_Space 的字元不算空白，
/// 只有這種字元的輸入是錯誤，不是留空。
#[test]
fn time_input_invisible_characters_are_not_blank() {
    for raw in ["\u{200b}", "\u{feff}"] {
        assert_time_input(raw, Err(InvalidTime));
    }
}

/// 範例取自 `tests/itinerary-time-input.test.js` 的測試
/// `結果的 HH:MM 與空值符合 State_Validator 的定義，不需要正規化的輸入與既有活動時間的檢查結果相同（需求 18.3）`：
/// 檔頭註解舉出的 8:00、24:00 與 08:00:00 都無效。
#[test]
fn time_input_examples_that_need_no_normalization() {
    for raw in ["8:00", "24:00", "08:00:00"] {
        assert_time_input(raw, Err(InvalidTime));
    }
}

/// 需求 33.10：現行的 Participant_Name（`normalizeParticipantName()`）以 JavaScript 的 `\s`（JS_Whitespace）摺疊
/// 空白，U+FEFF 算空白，所以 Bun_App 把「小」加 U+FEFF 加「安」正規化為「小 安」。
#[test]
fn participant_name_treats_feff_as_js_whitespace() {
    assert_eq!(participant_name("小\u{feff}安"), "小 安");
}
