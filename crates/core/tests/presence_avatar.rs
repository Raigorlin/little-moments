//! 編輯者頭像與堆疊的範例測試（任務 10.6；需求 33.3、33.4）。
//!
//! - Avatar_Initial：需求 33.3 與 16.4 的例子。
//! - Avatar_Palette：12 色逐一以 WCAG 2.x 的公式重算對比（這個檔案自己實作公式，不用 lm-core 的
//!   `contrast_ratio()`），每一色都不低於 4.5:1，文字色是 `--ink` 與白色中對比較高的那一個。
//! - FNV-1a 64 位元：公開的測試向量（空輸入與「a」），以及固定帳號 id 的雜湊值與色盤索引。
//! - Editor_Stack：需求 33.4 的人數、去重、排序與各段文字。
//!
//! 固定帳號 id 的雜湊值與色盤索引、12 色的對比，另以 Bun 依 FNV-1a 與 WCAG 2.x 的定義（BigInt 與浮點數）獨立算出，
//! 不是由 lm-core 的輸出抄來的。

mod support;

use std::collections::BTreeMap;

use lm_core::ids::{PersonId, UserId};
use lm_core::model::{Entity, RowKey};
use lm_core::presence::{
    avatar_color, avatar_initial, contrast_ratio, editor_stacks, fnv1a_64, readable_text_on,
    AvatarInitial, EditTarget, EditorStack, PresenceMeta, Rgb, AVATAR_PALETTE, AVATAR_PLACEHOLDER,
    INK, WHITE,
};
use uuid::Uuid;

// ── Avatar_Initial ──

#[test]
fn avatar_initial_examples() {
    let cases = [
        ("陳小明", "陳"),
        ("  amy chen ", "a"),
        ("🐻小熊", "🐻"),
        (
            "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467} 一家",
            "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}",
        ),
        ("🇹🇼台灣", "🇹🇼"),
        ("\u{1f44b}\u{1f3fd}阿明", "\u{1f44b}\u{1f3fd}"),
        ("e\u{301}va", "e\u{301}"),
        // 不轉換大小寫
        ("Amy", "A"),
    ];
    for (name, expected) in cases {
        assert_eq!(
            avatar_initial(name),
            AvatarInitial::Grapheme(expected.to_owned()),
            "{name:?}"
        );
        assert_eq!(avatar_initial(name).as_str(), expected, "{name:?}");
    }
}

#[test]
fn blank_names_use_the_placeholder() {
    assert_eq!(AVATAR_PLACEHOLDER, "\u{30fb}");
    for name in ["", "\u{3000}", "\u{3000}\u{3000}", "\t\n", " \t \n "] {
        assert_eq!(avatar_initial(name), AvatarInitial::Placeholder, "{name:?}");
        assert_eq!(avatar_initial(name).as_str(), "・", "{name:?}");
    }
}

// ── Avatar_Palette ──

/// WCAG 2.x 的相對亮度（這個檔案自己的實作）。
fn luminance(Rgb(r, g, b): Rgb) -> f64 {
    let channel = |v: u8| {
        let c = f64::from(v) / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/// WCAG 2.x 的對比值（這個檔案自己的實作）。
fn contrast(a: Rgb, b: Rgb) -> f64 {
    let (lighter, darker) = {
        let (la, lb) = (luminance(a), luminance(b));
        (la.max(lb), la.min(lb))
    };
    (lighter + 0.05) / (darker + 0.05)
}

/// 色盤依序的底色，以及文字色（`--ink`）與底色的對比（Bun 算出，四捨五入到小數第二位）。
const PALETTE: [(&str, &str, f64); 12] = [
    ("珊瑚", "#f0a08c", 5.41),
    ("蜜桃", "#f4b98a", 6.50),
    ("向日葵", "#f2cc5e", 7.26),
    ("嫩芽", "#cbd67a", 7.19),
    ("青草", "#a8d08d", 6.46),
    ("薄荷", "#8ed3b4", 6.49),
    ("湖水", "#85cfd5", 6.36),
    ("天空", "#9ec4ec", 6.19),
    ("長春花", "#b4b7f0", 5.87),
    ("薰衣草", "#cdb3e8", 6.00),
    ("櫻花", "#f2b0c9", 6.33),
    ("奶茶", "#d9bfa1", 6.38),
];

#[test]
fn palette_has_twelve_distinct_colors_in_order() {
    assert_eq!(INK.hex(), "#3e3a39");
    assert_eq!(WHITE.hex(), "#ffffff");
    let backgrounds: Vec<String> = AVATAR_PALETTE
        .iter()
        .map(|color| color.background.hex())
        .collect();
    let expected: Vec<&str> = PALETTE.iter().map(|(_, hex, _)| *hex).collect();
    assert_eq!(backgrounds, expected);
}

#[test]
fn every_palette_color_has_readable_text() {
    for (color, (name, _, ratio)) in AVATAR_PALETTE.iter().zip(PALETTE) {
        let ink = contrast(INK, color.background);
        let white = contrast(WHITE, color.background);
        assert!(ink >= 4.5, "{name}：--ink 的對比只有 {ink}");
        assert!(
            (ink - ratio).abs() < 0.005,
            "{name}：對比是 {ink}，不是 {ratio}"
        );
        assert!(
            ink > white,
            "{name}：白色的對比 {white} 比 --ink 的 {ink} 高"
        );
        assert_eq!(color.text, INK, "{name}：文字色應該是 --ink");
        assert_eq!(readable_text_on(color.background), INK, "{name}");
        // lm-core 的公式與這裡的實作一致
        assert!(
            (contrast_ratio(color.text, color.background) - ink).abs() < 1e-12,
            "{name}"
        );
    }
}

// ── FNV-1a 與色盤索引 ──

#[test]
fn fnv1a_matches_the_public_test_vectors() {
    assert_eq!(fnv1a_64(b""), 0xcbf2_9ce4_8422_2325);
    assert_eq!(fnv1a_64(b"a"), 0xaf63_dc4c_8601_ec8c);
    assert_eq!(fnv1a_64(&[0x00; 16]), 0x8820_1fb9_60ff_6465);
    assert_eq!(fnv1a_64(&[0xff; 16]), 0xd660_7508_f5a1_e855);
}

/// 固定帳號 id 的色盤索引（Bun 算出）。改動雜湊或色盤順序會改變每個人的顏色，這個測試會擋下這種改動。
const GOLDEN: [(&str, usize); 7] = [
    ("00000000-0000-0000-0000-000000000000", 9),
    ("ffffffff-ffff-ffff-ffff-ffffffffffff", 9),
    ("00000000-0000-0000-0000-000000000001", 2),
    ("3c51b8aa-0000-4000-8000-00000000000a", 2),
    ("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", 1),
    ("7b2e9f40-1c3d-4e5f-8a9b-0c1d2e3f4a5b", 3),
    ("a1b2c3d4-e5f6-4789-9abc-def012345678", 2),
];

#[test]
fn fixed_accounts_keep_their_palette_index() {
    for (id, index) in GOLDEN {
        let user = UserId(Uuid::parse_str(id).unwrap());
        assert_eq!(avatar_color(user), AVATAR_PALETTE[index], "{id}");
    }
}

// ── Editor_Stack ──

const VIEWER: u128 = 0xff;

fn user(n: u128) -> UserId {
    UserId(Uuid::from_u128(n))
}

fn meal(n: u128) -> EditTarget {
    EditTarget {
        entity: Entity::Meal,
        key: RowKey::Id(Uuid::from_u128(0x1000 + n)),
    }
}

fn meta(n: u128, name: &str, editing: Option<EditTarget>) -> PresenceMeta {
    PresenceMeta {
        user: user(n),
        display_name: name.to_owned(),
        person: n
            .is_multiple_of(2)
            .then(|| PersonId(Uuid::from_u128(0x2000 + n))),
        editing,
    }
}

fn stacks(metas: &[PresenceMeta]) -> BTreeMap<EditTarget, EditorStack> {
    editor_stacks(metas, user(VIEWER))
}

/// `n` 位編輯者（帳號 id 1..=n）編輯同一道料理。
fn editors(n: u128) -> Vec<PresenceMeta> {
    (1..=n)
        .map(|k| meta(k, &format!("旅伴{k}"), Some(meal(1))))
        .collect()
}

fn shown_ids(stack: &EditorStack) -> Vec<UserId> {
    stack.shown.iter().map(|avatar| avatar.user).collect()
}

#[test]
fn nobody_editing_means_no_stack() {
    let metas = [
        meta(1, "陳小明", None),
        meta(2, "林大華", None),
        // 檢視者自己在其他分頁與裝置上的編輯
        meta(VIEWER, "我", Some(meal(1))),
        meta(VIEWER, "我", Some(meal(1))),
    ];
    assert!(stacks(&metas).is_empty());
    assert!(stacks(&[]).is_empty());
}

#[test]
fn up_to_three_editors_are_all_shown() {
    for n in [1, 3] {
        let result = stacks(&editors(n));
        let stack = &result[&meal(1)];
        assert_eq!(
            shown_ids(stack),
            (1..=n).map(user).collect::<Vec<_>>(),
            "{n} 位"
        );
        assert!(stack.hidden.is_empty(), "{n} 位");
        assert_eq!(stack.total(), n as usize);
        assert_eq!(stack.overflow_label(), None);
        assert_eq!(stack.overflow_tooltip(), None);
    }
}

#[test]
fn more_than_three_editors_overflow_into_plus_n() {
    for (n, plus) in [(4, 1), (10, 7)] {
        let result = stacks(&editors(n));
        let stack = &result[&meal(1)];
        assert_eq!(shown_ids(stack), vec![user(1), user(2), user(3)], "{n} 位");
        assert_eq!(stack.hidden.len(), plus, "{n} 位");
        assert_eq!(stack.total(), n as usize);
        let expected: Vec<String> = (4..=n).map(|k| format!("旅伴{k}")).collect();
        assert_eq!(stack.hidden, expected);
    }
}

#[test]
fn one_account_in_two_tabs_counts_once() {
    let metas = [
        meta(1, "陳小明", Some(meal(1))),
        meta(1, "陳小明", Some(meal(1))),
        meta(2, "林大華", Some(meal(1))),
    ];
    let result = stacks(&metas);
    assert_eq!(shown_ids(&result[&meal(1)]), vec![user(1), user(2)]);
    assert_eq!(result[&meal(1)].total(), 2);
}

#[test]
fn one_account_editing_two_targets_appears_in_both() {
    let metas = [
        meta(1, "陳小明", Some(meal(1))),
        meta(1, "陳小明", Some(meal(2))),
    ];
    let result = stacks(&metas);
    assert_eq!(result.len(), 2);
    assert_eq!(shown_ids(&result[&meal(1)]), vec![user(1)]);
    assert_eq!(shown_ids(&result[&meal(2)]), vec![user(1)]);
}

#[test]
fn the_viewer_is_never_listed() {
    let metas = [
        meta(VIEWER, "我", Some(meal(1))),
        meta(3, "王小美", Some(meal(1))),
        meta(VIEWER, "我", Some(meal(1))),
    ];
    let result = stacks(&metas);
    assert_eq!(shown_ids(&result[&meal(1)]), vec![user(3)]);
    assert_eq!(result[&meal(1)].notice(), "王小美 正在編輯這一項");
}

#[test]
fn editors_are_ordered_by_account_id() {
    let descending: Vec<PresenceMeta> = (1..=5)
        .rev()
        .map(|k| meta(k, &format!("旅伴{k}"), Some(meal(1))))
        .collect();
    let result = stacks(&descending);
    let stack = &result[&meal(1)];
    assert_eq!(shown_ids(stack), vec![user(1), user(2), user(3)]);
    assert_eq!(stack.hidden, vec!["旅伴4".to_owned(), "旅伴5".to_owned()]);
    // 依 16 個位元組比較，也就是小寫十六進位字串的字典序
    let low = UserId(Uuid::parse_str("0fffffff-ffff-ffff-ffff-ffffffffffff").unwrap());
    let high = UserId(Uuid::parse_str("10000000-0000-0000-0000-000000000000").unwrap());
    let metas = [
        PresenceMeta {
            user: high,
            ..meta(0, "後", Some(meal(1)))
        },
        PresenceMeta {
            user: low,
            ..meta(0, "前", Some(meal(1)))
        },
    ];
    assert_eq!(shown_ids(&stacks(&metas)[&meal(1)]), vec![low, high]);
}

#[test]
fn avatar_texts() {
    let metas = [meta(1, "陳小明", Some(meal(1))), meta(2, "", Some(meal(2)))];
    let result = stacks(&metas);
    let named = &result[&meal(1)].shown[0];
    assert_eq!(named.label(), "陳小明 正在編輯");
    assert_eq!(named.tooltip(), "陳小明");
    assert_eq!(named.initial, AvatarInitial::Grapheme("陳".to_owned()));
    assert_eq!(named.color, avatar_color(user(1)));
    let blank = &result[&meal(2)].shown[0];
    assert_eq!(blank.label(), "有人 正在編輯");
    assert_eq!(blank.tooltip(), "未設定顯示名稱");
    assert_eq!(blank.initial, AvatarInitial::Placeholder);
}

#[test]
fn overflow_texts() {
    let metas = [
        meta(1, "陳小明", Some(meal(1))),
        meta(2, "旅伴2", Some(meal(1))),
        meta(3, "旅伴3", Some(meal(1))),
        meta(4, "林大華", Some(meal(1))),
        meta(5, "王小美", Some(meal(1))),
    ];
    let stack = &stacks(&metas)[&meal(1)];
    assert_eq!(
        stack.overflow_label().as_deref(),
        Some("另外 2 人正在編輯：林大華、王小美")
    );
    assert_eq!(stack.overflow_tooltip().as_deref(), Some("林大華、王小美"));
    assert_eq!(stack.notice(), "陳小明 等 5 人正在編輯這一項");
}

#[test]
fn editing_notice_texts() {
    let alone = stacks(&[meta(1, "陳小明", Some(meal(1)))]);
    assert_eq!(alone[&meal(1)].notice(), "陳小明 正在編輯這一項");
    let four = [
        meta(1, "陳小明", Some(meal(1))),
        meta(2, "林大華", Some(meal(1))),
        meta(3, "王小美", Some(meal(1))),
        meta(4, "張阿土", Some(meal(1))),
    ];
    assert_eq!(
        stacks(&four)[&meal(1)].notice(),
        "陳小明 等 4 人正在編輯這一項"
    );
}

#[test]
fn blank_names_become_someone() {
    let metas = [
        meta(1, " \u{3000} ", Some(meal(1))),
        meta(2, "旅伴2", Some(meal(1))),
        meta(3, "旅伴3", Some(meal(1))),
        meta(4, "", Some(meal(1))),
        meta(5, "王小美", Some(meal(1))),
    ];
    let stack = &stacks(&metas)[&meal(1)];
    assert_eq!(stack.notice(), "有人 等 5 人正在編輯這一項");
    assert_eq!(
        stack.overflow_label().as_deref(),
        Some("另外 2 人正在編輯：有人、王小美")
    );
    assert_eq!(
        stack.overflow_tooltip().as_deref(),
        Some("未設定顯示名稱、王小美")
    );
    let alone = stacks(&[meta(1, "", Some(meal(1)))]);
    assert_eq!(alone[&meal(1)].notice(), "有人 正在編輯這一項");
}

#[test]
fn names_are_trimmed_and_cut_to_thirty_characters() {
    let long = "一二三四五六七八九十".repeat(3) + "多出來的字";
    let metas = [
        meta(1, &format!(" \t{long}\u{3000}"), Some(meal(1))),
        meta(2, "  林大華  ", Some(meal(1))),
        meta(3, "旅伴3", Some(meal(1))),
        meta(4, &format!("\n{long} "), Some(meal(1))),
    ];
    let thirty = "一二三四五六七八九十".repeat(3);
    let stack = &stacks(&metas)[&meal(1)];
    assert_eq!(stack.shown[0].display_name, thirty);
    assert_eq!(stack.shown[0].label(), format!("{thirty} 正在編輯"));
    assert_eq!(stack.shown[0].tooltip(), thirty);
    assert_eq!(stack.shown[1].tooltip(), "林大華");
    assert_eq!(stack.notice(), format!("{thirty} 等 4 人正在編輯這一項"));
    assert_eq!(
        stack.overflow_label(),
        Some(format!("另外 1 人正在編輯：{thirty}"))
    );
    assert_eq!(stack.overflow_tooltip(), Some(thirty.clone()));
    // 頭像的字由完整的顯示名稱算出
    assert_eq!(
        stack.shown[0].initial,
        AvatarInitial::Grapheme("一".to_owned())
    );
}
