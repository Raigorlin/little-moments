//! Property 17 的屬性測試（任務 5.2；需求 25.4、25.5、33.5、33.6）。
//!
//! 對任何字串 t，Ingredient_Parser 切出的名稱依序以「、」串接後再切一次，得到相同的名稱與順序（需求 25.5）；切出的名稱
//! 兩兩的 Ingredient_Key 都不同（需求 25.4）。
//!
//! 字串 t 來自三種產生器（[`arb_text()`]），各占約三分之一的案例：
//!
//! - 共用產生器的食材文字 `support::vocab::arb_ingredients()`：各種分隔符號、`1.5`、`1,000`、全形數字、前後與中間的
//!   各種空白（包括 U+3000、U+FEFF 與 U+0085）、大小寫英文，以及 Ingredient_Key 相同的不同寫法。
//! - 任意 Unicode 字元組成的字串：proptest 的 `any::<char>()` 有一半取自它的特殊字元（包括 `/`、`.`、CR、LF、Tab 與
//!   U+FEFF），其餘是 ASCII、Latin-1 與任意碼位。
//! - [`arb_piece()`] 的片段串接成的字串：共用產生器的詞彙；NFKC 之後才是分隔符號、空白或含有它們的字元；兩個數字中間
//!   夾著「,」「.」或 NFKC 之後是它們的字元；以及相鄰時 NFKC 會合成或重新排列、中間可能隔著空白或分隔符號的兩段文字。
//!   NFKC、切分與整理空白的順序出錯時，這些文字串接後再切一次會得到不同的名稱。
//!
//! 使用 proptest 的預設設定（256 個案例，設定 `PROPTEST_CASES=N` 時為 N 個），不覆寫案例數；proptest 找到的失敗案例
//! 寫在同一個目錄的 `prop_parse_ingredients.proptest-regressions`，這個檔案提交進版本庫（需求 33.6）。

mod support;

use std::collections::HashMap;

use lm_core::ingredients::{ingredient_key, parse_ingredients};
use proptest::collection::vec;
use proptest::option;
use proptest::prelude::*;
use proptest::sample::select;

use support::vocab::{
    arb_ingredients, INGREDIENT_NUMBERS, INGREDIENT_SEPARATORS, INGREDIENT_SPACES, INGREDIENT_WORDS,
};

// Feature: rust-supabase-rewrite, Property 17: 食材切分再切一次不變
proptest! {
    /// 對任何字串 t：`parse_ingredients(parse_ingredients(t).join("、")) == parse_ingredients(t)`，而且
    /// `parse_ingredients(t)` 中沒有兩個名稱的 `ingredient_key` 相同。
    #[test]
    fn reparsing_the_joined_names_gives_the_same_names_with_distinct_keys(t in arb_text()) {
        let names = parse_ingredients(&t);
        prop_assert_eq!(&parse_ingredients(&names.join("、")), &names);
        prop_assert_eq!(first_names_sharing_a_key(&names), None);
    }
}

/// `names` 中第一對 Ingredient_Key 相同的名稱（先出現的在前）；兩兩都不同時為 `None`。
fn first_names_sharing_a_key(names: &[String]) -> Option<(&str, &str)> {
    let mut first_by_key = HashMap::new();
    names.iter().find_map(|name| {
        first_by_key
            .insert(ingredient_key(name), name.as_str())
            .map(|first| (first, name.as_str()))
    })
}

/// 任何字串 t：共用產生器的食材文字、任意 Unicode 字元組成的字串，以及 [`arb_piece()`] 的片段串接成的字串，各占約
/// 三分之一。
fn arb_text() -> impl Strategy<Value = String> {
    prop_oneof![
        arb_ingredients(),
        vec(any::<char>(), 0..=40).prop_map(String::from_iter),
        vec(arb_piece(), 0..=12).prop_map(|pieces| pieces.concat()),
    ]
}

/// 一個片段：共用產生器的食材名稱、數字、分隔符號或空白，[`TRICKY_CHARS`] 的一個字元，[`arb_number_pair()`]，
/// [`arb_composing_pair()`]，或任意一個 Unicode 字元。
fn arb_piece() -> impl Strategy<Value = String> {
    let vocab = prop_oneof![
        select(INGREDIENT_WORDS),
        select(INGREDIENT_NUMBERS),
        select(INGREDIENT_SEPARATORS),
        select(INGREDIENT_SPACES),
    ];
    prop_oneof![
        4 => vocab.prop_map(str::to_owned),
        2 => select(TRICKY_CHARS).prop_map(str::to_owned),
        2 => arb_number_pair(),
        2 => arb_composing_pair(),
        1 => any::<char>().prop_map(String::from),
    ]
}

/// 兩個 [`DIGITS`] 中間夾著一個 [`DIGIT_JOINERS`]，兩邊可能有空白：半形「,」「.」只在 NFKC 之後前後都是 ASCII 數字時
/// 保留，其他時候切開（需求 25.3）。
fn arb_number_pair() -> impl Strategy<Value = String> {
    (
        select(DIGITS),
        arb_gap(),
        select(DIGIT_JOINERS),
        arb_gap(),
        select(DIGITS),
    )
        .prop_map(|(before, gap_before, joiner, gap_after, after)| {
            format!("{before}{gap_before}{joiner}{gap_after}{after}")
        })
}

/// [`COMPOSING_PAIRS`] 的一組，中間可能隔著空白或分隔符號：切開與整理空白之後，名稱串接起來再做一次 NFKC 時，不能與
/// 相鄰的字合成或重新排列。
fn arb_composing_pair() -> impl Strategy<Value = String> {
    let between = option::of(prop_oneof![
        select(INGREDIENT_SPACES),
        select(INGREDIENT_SEPARATORS),
    ]);
    (select(COMPOSING_PAIRS), between)
        .prop_map(|((first, second), between)| format!("{first}{}{second}", between.unwrap_or("")))
}

/// 數字與「,」「.」之間可能出現的一段空白，常常沒有。
fn arb_gap() -> impl Strategy<Value = &'static str> {
    option::weighted(0.25, select(INGREDIENT_SPACES)).prop_map(|space| space.unwrap_or(""))
}

/// 數字：ASCII 數字；NFKC 之後是 ASCII 數字的全形「１」、上標「²」、下標「₁」、圈號「①」與數學粗體「𝟎」；以及 NFKC
/// 不改變、也不是 ASCII 數字的阿拉伯-印度數字 U+0661。
const DIGITS: &[&str] = &["1", "0", "１", "²", "₁", "①", "𝟎", "\u{661}"];

/// 數字之間的「,」「.」：半形、全形「，」「．」、小寫「﹐」「﹒」與 U+2024，NFKC 之後都是「,」或「.」；U+2025 在 NFKC
/// 之後是兩個「.」。
const DIGIT_JOINERS: &[&str] = &[",", ".", "，", "．", "﹐", "﹒", "\u{2024}", "\u{2025}"];

/// NFKC 之後才是分隔符號、空白或含有它們的字元，以及其他容易使切分出錯的字元。
const TRICKY_CHARS: &[&str] = &[
    // NFKC 之後是「、」「;」「。」：小寫「﹑」「﹔」、直書「︒」與希臘文問號 U+037E
    "﹑", "﹔", "︒", "\u{37e}",
    // NFKC 之後含有「.」「,」「/」：「⒈」→「1.」、「🄁」→「0,」、「℀」→「a/c」、「㏇」→「Co.」
    "⒈", "🄁", "℀", "㏇",
    // NBSP 在 NFKC 之後是半形空格；U+2028、U+1680 與 VT 是 JS_Whitespace，NFKC 不改變它們
    "\u{a0}", "\u{2028}", "\u{1680}", "\u{b}",
    // 單獨的 CR 切開食材；U+200B 與 U+180E 都不是空白
    "\r", "\u{200b}", "\u{180e}",
    // 小寫取決於前後文或長度不同的字母，以及 NFKC 之後長度不同的字元：「Σ」、「İ」（小寫是兩個字）、「ﬀ」→「ff」、
    // 「Ⅻ」→「XII」
    "Σ", "İ", "ﬀ", "Ⅻ",
];

/// 相鄰時 NFKC 會合成或重新排列的兩段文字。
const COMPOSING_PAIRS: &[(&str, &str)] = &[
    // 「é」加下點 U+0323：NFKC 重新排列為「ẹ」加 U+0301
    ("e\u{301}", "\u{323}"),
    // 「か」加濁點的組合字元 U+3099 →「が」；半形「ｶ」加「ﾞ」→「ガ」
    ("か", "\u{3099}"),
    ("ｶ", "ﾞ"),
    // 韓文相容字母「ㄱ」加「ㅏ」→「가」；「가」加收尾子音 U+11A8 →「각」
    ("ㄱ", "ㅏ"),
    ("가", "\u{11a8}"),
    // 泰米爾文 U+0BC6 加 U+0BBE → U+0BCA：兩個字都不是組合字元
    ("\u{bc6}", "\u{bbe}"),
    // 「=」加 U+0338 →「≠」
    ("=", "\u{338}"),
    // 「´」與「゛」在 NFKC 之後是半形空格加組合字元，不與前一個字合成
    ("a", "´"),
    ("か", "゛"),
];
