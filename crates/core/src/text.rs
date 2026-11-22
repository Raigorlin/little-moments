//! 文字規則：`trim_white`（Unicode White_Space）、`is_js_whitespace`、`trim_js_whitespace`、
//! `collapse_js_whitespace`（JS_Whitespace）、`char_count`、`has_control_chars`、`participant_name`、
//! `participant_key`、`place_key`、`clean_text` 與 `normalize_time_input`。
//!
//! 移植自 `src/itinerary-model.js` 的 `trimWhite()`、`charCount()`、`hasControlChars()`、`placeKey()`、
//! `cleanText()` 與 `normalizeTimeInput()`，以及 `src/model.js` 的 `normalizeParticipantName()` 與
//! `participantKey()`。
//!
//! 這裡有兩種空白，由各需求指定使用哪一種：
//! - Trim_White 的空白是 Unicode White_Space，也就是 Rust 的 `char::is_whitespace()`：包括 U+0085，不包括 U+FEFF。
//! - JS_Whitespace 是現行 JavaScript 的 `\s` 與 `trim()` 所稱的空白：包括 U+FEFF，不包括 U+0085。
//!
//! Unicode 的一般類別與屬性以 `regex` 的 `\p{…}` 判斷，與現行 JavaScript 的 `\p{…}` 是同一份定義。

use std::sync::LazyLock;

use regex::Regex;
use unicode_normalization::UnicodeNormalization;

/// Trim_White：去除前後的 Unicode White_Space，包括全形空白（U+3000）、換行、Tab 與 U+0085（現行 `trimWhite()`）。
/// U+FEFF 與 U+200B 不是 White_Space，所以保留。
pub fn trim_white(text: &str) -> &str {
    // str::trim() 依 Unicode 的 White_Space 屬性判斷空白
    text.trim()
}

/// JS_Whitespace：現行 JavaScript 的 `\s` 與 `trim()` 所稱的空白。與 Unicode White_Space 不同，U+FEFF 算空白，
/// U+0085 不算（需求 19.1、25.4、33.10）。
pub fn is_js_whitespace(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | '\u{2028}' | '\u{2029}' | '\u{feff}')
        // 一般類別 Zs
        || matches!(
            c,
            ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}'
        )
}

/// 去除前後的 JS_Whitespace（現行 JavaScript 的 `trim()`）。
pub fn trim_js_whitespace(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// 去除前後的 JS_Whitespace，並把內部連續的 JS_Whitespace 換成一個半形空格
/// （現行 `text.trim().replace(/\s+/gu, ' ')`）。
pub fn collapse_js_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for word in text.split(is_js_whitespace).filter(|word| !word.is_empty()) {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

/// Char_Count：以 Unicode 碼位計算的字數，與現行的 `[...text].length` 及 PostgreSQL 的 `char_length()` 相同，
/// 例如「👨‍👩‍👧」是 5 個字。
pub fn char_count(text: &str) -> usize {
    text.chars().count()
}

/// 文字中有 Hidden_Control_Char 時為 true（現行 `hasControlChars()`）：一般類別為 Cc 或 Cf 的字元，但連接兩個 emoji 的
/// U+200D 除外，也就是前面是 Extended_Pictographic 字元（中間最多依序隔著一個變體選擇符與一個膚色修飾符）、
/// 後面緊接 Extended_Pictographic 字元的 U+200D，例如「👨‍👩‍👧」「🏳️‍🌈」「👩🏽‍💻」中的 U+200D。
/// Tab、換行與 U+0085 是 Cc；U+200B、U+00AD、U+202E、U+FEFF 與標籤字元是 Cf。
pub fn has_control_chars(text: &str) -> bool {
    FORMAT_OR_CONTROL
        .find_iter(text)
        .any(|m| m.as_str() != ZWJ || !joins_emoji(&text[..m.start()], &text[m.end()..]))
}

/// Participant_Name：旅伴名字、角色與顯示名稱的正規化（現行 `normalizeParticipantName()`）：NFKC，去除前後的
/// JS_Whitespace，並把內部連續的 JS_Whitespace 換成一個半形空格。例如「 Ａｌｉｃｅ　 Lin 」成為「Alice Lin」；
/// U+FEFF 換成空格，U+0085 不是 JS_Whitespace 所以保留（之後由 `has_control_chars()` 拒絕）。
pub fn participant_name(value: &str) -> String {
    collapse_js_whitespace(&value.nfkc().collect::<String>())
}

/// Participant_Key：比較旅伴名字的鍵（現行 `participantKey()`）：`participant_name()` 之後移除
/// Default_Ignorable_Code_Point（例如 U+200B、U+FE0F、U+3164），再轉成小寫。所以「Alice」「 ＡＬＩＣＥ 」與「alice」，
/// 以及「小安」與「小安」加 U+FE0F 的鍵都相同。
pub fn participant_key(value: &str) -> String {
    // 現行以 toLocaleLowerCase('zh-TW') 轉小寫；zh-TW 沒有語系專屬的對應，等於 Unicode 預設的轉換（包括字尾的 Σ）
    DEFAULT_IGNORABLE
        .replace_all(&participant_name(value), "")
        .to_lowercase()
}

/// Place_Key：比較地點名稱的鍵（現行 `placeKey()`）：Trim_White，只對 U+3000 與 U+FF01–U+FFEE 做 NFKC
/// （所以「①」「²」保持原樣），整串做 NFC，再把 A–Z 轉成小寫。例如「ＡＢＣ營地」與「abc營地」、
/// 「超市／賣場」與「超市/賣場」的鍵相同。
///
/// 與現行相同，最後再做一次 NFC 與 Trim_White，使鍵再算一次也不變：「J」加 U+030C 要轉成小寫之後才組合成「ǰ」，
/// 開頭的 U+FFE3 摺疊後是半形空格加 U+0304。
pub fn place_key(name: &str) -> String {
    let lowered: String = fold_width(trim_white(name))
        .nfc()
        .map(|c| c.to_ascii_lowercase())
        .collect();
    trim_white(&lowered.nfc().collect::<String>()).to_owned()
}

/// 放進 Itinerary_Text 的使用者文字（需求 31.14，現行 `cleanText()`）：先 Trim_White，再把每一段含有換行字元
/// （U+000A、U+000B、U+000C、U+000D、U+0085、U+2028、U+2029）的連續 Unicode White_Space 換成一個半形空格；
/// 不含換行字元的連續空白（例如兩個空格或一個 Tab）保留原樣。文字不跳脫、不截斷。
pub fn clean_text(text: &str) -> String {
    let mut rest = trim_white(text);
    let mut out = String::with_capacity(rest.len());
    while let Some(start) = rest.find(char::is_whitespace) {
        let (before, from_run) = rest.split_at(start);
        out.push_str(before);
        let len = from_run
            .find(|c: char| !c.is_whitespace())
            .unwrap_or(from_run.len());
        let (run, after) = from_run.split_at(len);
        if run.contains(is_line_break) {
            out.push(' ');
        } else {
            out.push_str(run);
        }
        rest = after;
    }
    out.push_str(rest);
    out
}

/// 不是 Time_Value 也不是留空的時刻輸入（現行 `normalizeTimeInput()` 的 `{ error: 'invalid' }`）。
/// 給使用者看的訊息依各需求決定。
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("時刻需為 00:00–23:59 的 HH:MM，或留空")]
pub struct InvalidTime;

/// 時刻欄位的輸入（Time_Value，現行 `normalizeTimeInput()`）：先 Trim_White，再把全形數字與全形冒號換成半形
/// （只對 U+3000 與 U+FF01–U+FFEE 做 NFKC）。
///
/// - 結果是空字串：`Ok(None)`，也就是留空。
/// - 結果是 00:00–23:59 的 `HH:MM`：`Ok(Some(分鐘數))`，分鐘數從 00:00 起算（0..1440），例如「０８：３０」為 510。
/// - 其他：`Err(InvalidTime)`，包括只填一部分的「08:」、一位數的「8:30」、「24:00」、含秒數的「08:30:00」，
///   以及「①」「﹕」這類不在 U+3000 與 U+FF01–U+FFEE 的相容字元。U+200B、U+FEFF 這類看不見但不是 White_Space 的字元
///   不算空白。
pub fn normalize_time_input(raw: &str) -> Result<Option<u16>, InvalidTime> {
    let text = trim_white(raw);
    if text.is_empty() {
        return Ok(None);
    }
    // 摺疊後必須剛好是 5 個 ASCII 字元：兩位數的時、冒號、兩位數的分
    if let [h1 @ b'0'..=b'2', h2 @ b'0'..=b'9', b':', m1 @ b'0'..=b'5', m2 @ b'0'..=b'9'] =
        *fold_width(text).as_bytes()
    {
        let hour = u16::from(h1 - b'0') * 10 + u16::from(h2 - b'0');
        let minute = u16::from(m1 - b'0') * 10 + u16::from(m2 - b'0');
        if hour <= 23 {
            return Ok(Some(hour * 60 + minute));
        }
    }
    Err(InvalidTime)
}

/// 連接兩個 emoji 時不算 Hidden_Control_Char 的零寬連接符。
const ZWJ: &str = "\u{200d}";

/// Hidden_Control_Char 的候選字元：一般類別 Cf 與 Cc。
static FORMAT_OR_CONTROL: LazyLock<Regex> = LazyLock::new(|| unicode_class(r"[\p{Cf}\p{Cc}]"));
static DEFAULT_IGNORABLE: LazyLock<Regex> =
    LazyLock::new(|| unicode_class(r"\p{Default_Ignorable_Code_Point}"));
static EXTENDED_PICTOGRAPHIC: LazyLock<Regex> =
    LazyLock::new(|| unicode_class(r"\p{Extended_Pictographic}"));
static VARIATION_SELECTOR: LazyLock<Regex> =
    LazyLock::new(|| unicode_class(r"\p{Variation_Selector}"));
static EMOJI_MODIFIER: LazyLock<Regex> = LazyLock::new(|| unicode_class(r"\p{Emoji_Modifier}"));

fn unicode_class(pattern: &str) -> Regex {
    Regex::new(pattern).expect("Unicode 類別與屬性的寫法固定不變")
}

/// `c` 是否屬於只含一個字元類別的 `class`。
fn is_in(class: &Regex, c: char) -> bool {
    class.is_match(c.encode_utf8(&mut [0; 4]))
}

fn is_extended_pictographic(c: char) -> bool {
    is_in(&EXTENDED_PICTOGRAPHIC, c)
}

fn is_variation_selector(c: char) -> bool {
    is_in(&VARIATION_SELECTOR, c)
}

fn is_emoji_modifier(c: char) -> bool {
    is_in(&EMOJI_MODIFIER, c)
}

/// `before` 與 `after` 之間的 U+200D 是否連接兩個 emoji，與現行 `hasControlChars()` 以
/// `(\p{Extended_Pictographic}\p{Variation_Selector}?\p{Emoji_Modifier}?)\u200D(?=\p{Extended_Pictographic})`
/// 由左而右取代掉的 U+200D 相同。Rust 的 `regex` 不支援 lookahead，所以逐字判斷：U+200D 本身不屬於這三種屬性，
/// 一次比對只會結束在起點之後的第一個 U+200D，而且比對用掉的字元中只有起點是 Extended_Pictographic；
/// 因此每個 U+200D 是否被取代，只取決於它前面 1–3 個字元與後面 1 個字元。
fn joins_emoji(before: &str, after: &str) -> bool {
    if !after.chars().next().is_some_and(is_extended_pictographic) {
        return false;
    }
    // U+200D 前面的三個字元，由近到遠
    let mut back = before.chars().rev();
    let (p1, p2, p3) = (back.next(), back.next(), back.next());
    // emoji 加 U+200D
    p1.is_some_and(is_extended_pictographic)
        // emoji、變體選擇符或膚色修飾符，再加 U+200D
        || (p1.is_some_and(|c| is_variation_selector(c) || is_emoji_modifier(c))
            && p2.is_some_and(is_extended_pictographic))
        // emoji、變體選擇符、膚色修飾符，再加 U+200D
        || (p1.is_some_and(is_emoji_modifier)
            && p2.is_some_and(is_variation_selector)
            && p3.is_some_and(is_extended_pictographic))
}

/// 現行 `foldWidth()`：只把 U+3000 與 U+FF01–U+FFEE（半形與全形字元區）的字元各自換成 NFKC 的結果。
fn fold_width(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if c == '\u{3000}' || ('\u{ff01}'..='\u{ffee}').contains(&c) {
            out.extend(std::iter::once(c).nfkc());
        } else {
            out.push(c);
        }
    }
    out
}

/// 需求 31.14 的換行字元。
fn is_line_break(c: char) -> bool {
    matches!(
        c,
        '\n' | '\u{b}' | '\u{c}' | '\r' | '\u{85}' | '\u{2028}' | '\u{2029}'
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_white_removes_unicode_white_space_only() {
        assert_eq!(trim_white("\u{3000}\t\n 小安\u{85}\u{a0}\r"), "小安");
        assert_eq!(trim_white(" \u{2028}\u{3000}\u{2029} "), "");
        // U+FEFF 與 U+200B 不是 White_Space
        assert_eq!(trim_white("\u{feff}小安\u{200b}"), "\u{feff}小安\u{200b}");
    }

    #[test]
    fn js_whitespace_includes_feff_but_not_nel() {
        let white = [
            '\t', '\n', '\u{b}', '\u{c}', '\r', ' ', '\u{a0}', '\u{1680}', '\u{2000}', '\u{200a}',
            '\u{2028}', '\u{2029}', '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}',
        ];
        for c in white {
            assert!(is_js_whitespace(c), "{c:?}");
        }
        for c in ['\u{85}', '\u{180e}', '\u{200b}', '\u{2060}', 'a', '安'] {
            assert!(!is_js_whitespace(c), "{c:?}");
        }
        assert_eq!(trim_js_whitespace("\u{feff} 小安\u{3000}\n"), "小安");
        assert_eq!(trim_js_whitespace("\u{85}小安\u{85}"), "\u{85}小安\u{85}");
    }

    #[test]
    fn collapse_js_whitespace_trims_and_joins_runs_with_one_space() {
        assert_eq!(
            collapse_js_whitespace("  a\u{feff}b \t\u{3000} c\r\n"),
            "a b c"
        );
        assert_eq!(collapse_js_whitespace("\u{85}a"), "\u{85}a");
        assert_eq!(collapse_js_whitespace(" \u{feff}\n\u{3000}"), "");
    }

    #[test]
    fn char_count_counts_code_points() {
        assert_eq!(char_count(""), 0);
        assert_eq!(char_count("小安"), 2);
        assert_eq!(char_count(&"😀".repeat(100)), 100);
        assert_eq!(char_count("👨\u{200d}👩\u{200d}👧"), 5);
    }

    #[test]
    fn emoji_joiners_are_not_hidden_control_chars() {
        // 需求 19.3
        for name in [
            "小安",
            "Camp 小隊",
            "小安❤\u{fe0f}",
            "👨\u{200d}👩\u{200d}👧",
            "🏳\u{fe0f}\u{200d}🌈",
            "👩🏽\u{200d}💻",
            "🏳\u{fe0f}\u{200d}🌈 與 👩🏽\u{200d}💻",
        ] {
            assert!(!has_control_chars(name), "{name:?}");
        }
    }

    #[test]
    fn other_cc_and_cf_chars_are_hidden_control_chars() {
        // 需求 19.3、21.1
        for between in [
            '\u{200b}', '\u{ad}', '\u{202e}', '\u{85}', '\u{200d}', '\u{7}', '\t', '\n',
            '\u{feff}', '\u{2060}', '\u{200e}', '\u{2066}',
        ] {
            assert!(has_control_chars(&format!("小{between}安")), "{between:?}");
        }
        // 結尾、開頭或連續的 U+200D，以及前面或後面不是 emoji 的 U+200D
        for name in [
            "👨\u{200d}",
            "\u{200d}👩",
            "👨\u{200d}\u{200d}👩",
            "👨\u{200d}安",
            "安\u{200d}👩",
            // 膚色修飾符在變體選擇符之前，順序不符
            "👩🏽\u{fe0f}\u{200d}💻",
            // 以標籤字元組成的英格蘭旗
            "🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}",
        ] {
            assert!(has_control_chars(name), "{name:?}");
        }
        // U+2028 是 Zl，不是 Cc 或 Cf
        assert!(!has_control_chars("小\u{2028}安"));
    }

    #[test]
    fn participant_name_uses_nfkc_and_js_whitespace() {
        // 需求 19.1
        assert_eq!(participant_name(" Ａｌｉｃｅ\u{3000} Lin "), "Alice Lin");
        assert_eq!(participant_name("\u{feff}小安\t\u{feff}"), "小安");
        assert_eq!(participant_name("小\u{85}安"), "小\u{85}安");
        assert_eq!(participant_name(" \u{3000}\n"), "");
    }

    #[test]
    fn participant_key_ignores_case_width_and_default_ignorables() {
        // 需求 19.6
        let alice = participant_key("Alice");
        assert_eq!(alice, "alice");
        assert_eq!(participant_key(" ＡＬＩＣＥ "), alice);
        assert_eq!(participant_key("alice"), alice);
        assert_eq!(participant_key("小安\u{fe0f}"), participant_key("小安"));
        assert_ne!(participant_key("小 安"), participant_key("小安"));
        // 需求 19.2：只有空白或 Default_Ignorable_Code_Point 的名字，鍵去除前後空白後是空的
        for name in [
            "",
            "  ",
            "\u{3000}",
            "\u{200b}",
            "\u{fe0f}",
            "\u{3164}",
            "\u{200b} \u{200b}",
        ] {
            assert_eq!(trim_js_whitespace(&participant_key(name)), "", "{name:?}");
        }
    }

    #[test]
    fn place_key_folds_width_and_ascii_case_only() {
        // 需求 9.3、21.1
        assert_eq!(place_key("ＡＢＣ營地"), "abc營地");
        assert_eq!(place_key("abc營地"), "abc營地");
        assert_eq!(place_key("超市／賣場"), place_key("超市/賣場"));
        assert_eq!(
            place_key("\u{3000}出發地點\u{3000}ａ "),
            place_key("出發地點 A")
        );
        // 只對 U+3000 與 U+FF01–U+FFEE 做 NFKC
        assert_ne!(place_key("①號營地"), place_key("1號營地"));
        // 只有 A–Z 轉成小寫
        assert_eq!(place_key("ÄBC"), "Äbc");
        // 最後的 NFC 與 Trim_White
        assert_eq!(place_key("J\u{30c}"), "\u{1f0}");
        assert_eq!(place_key("\u{ffe3}a"), "\u{304}a");
        for name in ["J\u{30c}", "\u{ffe3}a", " ＡＢＣ　營地 ", "Café", "ｶﾞ"] {
            let key = place_key(name);
            assert_eq!(place_key(&key), key, "{name:?}");
        }
    }

    #[test]
    fn clean_text_turns_white_space_runs_with_line_breaks_into_one_space() {
        // 需求 31.14
        assert_eq!(clean_text("  第一行\n第二行\u{3000}"), "第一行 第二行");
        assert_eq!(clean_text("a \r\n\t b"), "a b");
        for line_break in ['\u{b}', '\u{c}', '\r', '\u{85}', '\u{2028}', '\u{2029}'] {
            assert_eq!(
                clean_text(&format!("a{line_break}b")),
                "a b",
                "{line_break:?}"
            );
        }
        // 不含換行字元的連續空白保留原樣；不跳脫
        assert_eq!(
            clean_text("a  b\tc\u{3000}\u{3000}d"),
            "a  b\tc\u{3000}\u{3000}d"
        );
        assert_eq!(clean_text("<b>&amp;</b>"), "<b>&amp;</b>");
        assert_eq!(clean_text("\n \u{3000}"), "");
    }

    #[test]
    fn normalize_time_input_accepts_full_width_hh_mm() {
        // 需求 22.5
        assert_eq!(normalize_time_input("０８：３０"), Ok(Some(8 * 60 + 30)));
        assert_eq!(normalize_time_input(" 08:30 "), Ok(Some(8 * 60 + 30)));
        assert_eq!(
            normalize_time_input("\u{3000}23:59\n"),
            Ok(Some(23 * 60 + 59))
        );
        assert_eq!(normalize_time_input("00:00"), Ok(Some(0)));
        assert_eq!(normalize_time_input("2３:0０"), Ok(Some(23 * 60)));
    }

    #[test]
    fn normalize_time_input_blank_is_none() {
        for raw in ["", " ", "\u{3000}\t\n\u{85}"] {
            assert_eq!(normalize_time_input(raw), Ok(None), "{raw:?}");
        }
    }

    #[test]
    fn normalize_time_input_rejects_partial_and_out_of_range() {
        for raw in [
            "08:",
            ":30",
            "08",
            "0830",
            "8:30",
            "08:5",
            "24:00",
            "23:60",
            "08:30:00",
            "008:30",
            "08.30",
            "08 :30",
            "08\u{3000}:30",
            "0⑧:30",
            "08﹕30",
            "上午 08:30",
            "\u{200b}",
            "\u{feff}08:30",
            "٠٨:٣٠",
        ] {
            assert_eq!(normalize_time_input(raw), Err(InvalidTime), "{raw:?}");
        }
    }
}
