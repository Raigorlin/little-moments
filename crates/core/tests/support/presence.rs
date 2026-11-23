//! 顯示名稱與帳號 id 的產生器（design「Correctness Properties」的 `arb_display_name()` 與 `arb_user_id()`，任務 10.4）。
//!
//! - [`arb_display_name()`]：一半是任意的字串：任意 Unicode 純量值、容易讓字素叢集切錯的字元（組合字元、ZWJ、
//!   區域指示符號、膚色修飾、異體字選擇器、韓文字母、CR 與 LF、U+0085、U+FEFF 與各種空白）、空字串，以及只有空白的
//!   字串。另一半從 [`KNOWN_CLUSTERS`] 任選 0–5 個串接，前後加上半形空白、全形空白 U+3000、tab 與換行；這組叢集兩兩
//!   串接都不會跨界合併，所以這一半有獨立的預期值：第一個被選的叢集，一個都沒選時為 `Placeholder`。
//! - [`arb_user_id()`]：任意 16 個位元組組成的 `UserId`。

use lm_core::ids::UserId;
use lm_core::presence::AvatarInitial;
use proptest::collection::vec;
use proptest::prelude::*;
use proptest::sample::select;
use uuid::Uuid;

/// 已知的擴充字素叢集：「陳」、`e` 加 U+0301、👨‍👩‍👧（以 U+200D 連接）、🇹🇼、👋🏽、「한」、`a` 與 `1`。
pub const KNOWN_CLUSTERS: &[&str] = &[
    "陳",
    "e\u{301}",
    "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}",
    "\u{1f1f9}\u{1f1fc}",
    "\u{1f44b}\u{1f3fd}",
    "한",
    "a",
    "1",
];

/// 名稱前後的空白：半形空白、全形空白 U+3000、tab 與換行。
pub const PADDING: &[&str] = &[" ", "\u{3000}", "\t", "\n"];

/// 容易讓字素叢集切錯的字元。
const TRICKY_CHARS: &[char] = &[
    'a',
    'e',
    '陳',
    '\u{301}',
    '\u{200d}',
    '\u{fe0f}',
    '\u{1f468}',
    '\u{1f469}',
    '\u{1f3fd}',
    '\u{1f1f9}',
    '\u{1f1fc}',
    '\u{1100}',
    '\u{1161}',
    '\u{11a8}',
    '\u{e0067}',
    '\r',
    '\n',
    '\t',
    ' ',
    '\u{3000}',
    '\u{85}',
    '\u{feff}',
];

/// `arb_display_name()` 產生的顯示名稱。
#[derive(Clone, Debug)]
pub struct DisplayName {
    pub name: String,
    /// 由已知叢集組成時的預期 Avatar_Initial；任意字串時為 `None`。
    pub expected: Option<AvatarInitial>,
}

/// 一半是任意的字串，一半由已知叢集組成（有預期值）。
pub fn arb_display_name() -> impl Strategy<Value = DisplayName> {
    let whitespace = || vec(select(PADDING), 0..=3).prop_map(|parts| parts.concat());
    let arbitrary = prop_oneof![
        4 => vec(any::<char>(), 0..=12).prop_map(|chars| chars.into_iter().collect::<String>()),
        4 => vec(select(TRICKY_CHARS), 0..=12).prop_map(|chars| chars.into_iter().collect::<String>()),
        1 => Just(String::new()),
        1 => whitespace(),
    ]
    .prop_map(|name| DisplayName {
        name,
        expected: None,
    });
    let known = (
        whitespace(),
        vec(select(KNOWN_CLUSTERS), 0..=5),
        whitespace(),
    )
        .prop_map(|(before, clusters, after)| {
            let expected = match clusters.first() {
                Some(first) => AvatarInitial::Grapheme((*first).to_owned()),
                None => AvatarInitial::Placeholder,
            };
            DisplayName {
                name: format!("{before}{}{after}", clusters.concat()),
                expected: Some(expected),
            }
        });
    prop_oneof![arbitrary, known]
}

/// 任意 16 個位元組組成的帳號 id。
pub fn arb_user_id() -> impl Strategy<Value = UserId> {
    any::<[u8; 16]>().prop_map(|bytes| UserId(Uuid::from_bytes(bytes)))
}
