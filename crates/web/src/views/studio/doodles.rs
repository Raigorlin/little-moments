//! 「行程手帖」的手繪小圖案與圖示（移植自 `src/storybook/journal.js` 第 1–140 行）。
//!
//! 每個小圖案畫在 48×48 的格子上：粉色底色略為錯位（偏移 1.6/1.4），上面是約 2px 的圓頭線條，整張 SVG 再套上輕微的
//! 抖動濾鏡（[`WOBBLE`]）。表格的路徑與顏色逐字取自現行的 `ICONS`、`D`（含 `Object.assign` 加入的項目）與各個分組；
//! [`hash_str`]、[`Rng`] 與各場景的抽選順序與現行相同，所以同一趟旅行（名稱與第一天）與同一個「換一組小圖案」次數畫出
//! 與 Bun 版逐字相同的 SVG。數字依 JavaScript `String(number)` 與 `toFixed()` 的格式輸出。
//!
//! 這裡產生的 SVG 只由下列固定的表格與數字組成，不含任何使用者文字，是 lm-web 少數可以用 HTML 放進畫面的內容
//! （需求 32.6）。
use lm_core::storybook::StudioKind;

/// 一個手繪小圖案：名稱、底色（路徑、顏色）、線條路徑與額外的 SVG（眼睛、斑點等）。
struct Doodle {
    name: &'static str,
    fills: &'static [(&'static str, &'static str)],
    line: &'static str,
    extra: &'static str,
}

/// 「換一組小圖案」按鈕的圖示內容。
pub(super) const SHUFFLE_ICON: &str = r#"<rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="9" cy="9" r="1.1" fill="currentColor"/><circle cx="15" cy="15" r="1.1" fill="currentColor"/><circle cx="12" cy="12" r="1.1" fill="currentColor"/>"#;

/// 小圖示的 SVG 內容（現行 `ICONS`）。
const ICONS: &[(&str, &str)] = &[
    (
        "sun",
        r##"<circle cx="12" cy="12" r="4" fill="#F2C55B"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>"##,
    ),
    (
        "cup",
        r##"<path d="M5 9h11v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V9Z" fill="#F4E4C8"/><path d="M16 10h1.5a2 2 0 0 1 0 4H16M8 4c0 1 1 1 1 2M11 4c0 1 1 1 1 2"/>"##,
    ),
    (
        "bowl",
        r##"<path d="M4 11h16a8 8 0 0 1-16 0Z" fill="#F4D7B0"/><path d="M9 7c0 1 1 1 1 2M13 6c0 1 1 1 1 2"/>"##,
    ),
    (
        "tent",
        r##"<path d="M3 20 12 5l9 15H3Z" fill="#F2C97A"/><path d="m12 5-3 15M12 5l3 15M2 20h20"/>"##,
    ),
    (
        "pot",
        r##"<path d="M5 10h14v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-6Z" fill="#E98C73"/><path d="M3 10h18M9 6c0 1 1 1 1 2M14 6c0 1 1 1 1 2"/>"##,
    ),
    (
        "moon",
        r##"<path d="M16 4a7 7 0 1 0 4 12 6 6 0 0 1-4-12Z" fill="#F2C55B"/>"##,
    ),
    (
        "camera",
        r##"<rect x="3" y="7" width="18" height="12" rx="2.5" fill="#BFD7DE"/><circle cx="12" cy="13" r="3.2"/><path d="M8.5 7 10 4.5h4L15.5 7"/>"##,
    ),
    (
        "cards",
        r##"<rect x="4" y="6" width="9" height="13" rx="1.5" fill="#F4E4C8" transform="rotate(-8 8 12)"/><rect x="11" y="5" width="9" height="13" rx="1.5" fill="#fff"/><path d="M15.5 9.5v4"/>"##,
    ),
    (
        "car",
        r##"<path d="M4 15v-4l2-4h10l3 4h1v4H4Z" fill="currentColor" stroke="#3e3a39"/><path d="M6.5 11h11" stroke="#3e3a39"/><circle cx="8" cy="16" r="1.8" fill="#fff" stroke="#3e3a39"/><circle cx="16" cy="16" r="1.8" fill="#fff" stroke="#3e3a39"/>"##,
    ),
    (
        "box",
        r##"<path d="M4 8 12 4l8 4v9l-8 4-8-4V8Z" fill="#E9C99B"/><path d="m4 8 8 4 8-4M12 12v9"/>"##,
    ),
    (
        "broom",
        r##"<path d="M15 3 9.5 12" /><path d="M7 11l5 3-2 6-6-3 3-6Z" fill="#F2C97A"/>"##,
    ),
    (
        "basket",
        r##"<path d="M3 10h18l-2 9H5l-2-9Z" fill="#E9C99B"/><path d="M7 10l3-6M17 10l-3-6M9 13v3M12 13v3M15 13v3"/>"##,
    ),
    (
        "people",
        r##"<circle cx="9" cy="8" r="3" fill="#F4D7B0"/><circle cx="16" cy="9" r="2.5" fill="#BFD7DE"/><path d="M4 19c.5-3 2.5-5 5-5s4.5 2 5 5M13.5 19c.3-2 1.5-3.5 3-3.5s2.7 1.5 3 3.5"/>"##,
    ),
    (
        "star",
        r##"<path d="m12 4 2.2 5 5.3.4-4 3.4 1.3 5.2L12 15.3 7.2 18l1.3-5.2-4-3.4 5.3-.4L12 4Z" fill="#F2C55B"/>"##,
    ),
    (
        "pencil",
        r#"<path d="m14 5 5 5M4 20l5-1L21 7l-5-5L4 14v6Z"/>"#,
    ),
    (
        "copy",
        r#"<rect x="8" y="8" width="13" height="13" rx="2.5"/><path d="M16 8V5.5A2.5 2.5 0 0 0 13.5 3h-8A2.5 2.5 0 0 0 3 5.5v8A2.5 2.5 0 0 0 5.5 16H8"/>"#,
    ),
    (
        "check",
        r#"<rect x="4" y="4" width="16" height="16" rx="3"/>"#,
    ),
];

/// 手繪小圖案（現行 `D`，含 `Object.assign` 加入的項目），依現行的順序。
const DOODLES: &[Doodle] = &[
    Doodle {
        name: "tent",
        fills: &[
            (r#"M6 40 24 8l18 32Z"#, "#F2C97A"),
            (r#"M19 40l5-14 5 14Z"#, "#E59A6B"),
        ],
        line: r#"M6 40 24 8l18 32ZM24 8 17 40M24 8l7 32M19 40l5-14 5 14M3 40h42"#,
        extra: r#"<circle cx="18" cy="30" r=".9" fill="currentColor"/><circle cx="30" cy="30" r=".9" fill="currentColor"/><path d="M21 33q3 2.4 6 0" fill="none" stroke="currentColor" stroke-width=".7" stroke-linecap="round"/>"#,
    },
    Doodle {
        name: "tree",
        fills: &[(r#"M24 6 37 30H11Z"#, "#9FBF92")],
        line: r#"M24 6 37 30H11ZM24 30v11M17 22l7-9"#,
        extra: r#""#,
    },
    Doodle {
        name: "pine",
        fills: &[(r#"M24 5l8 12h-4l7 11H13l7-11h-4Z"#, "#A9C99B")],
        line: r#"M24 5l8 12h-4l7 11H13l7-11h-4ZM24 28v13"#,
        extra: r#""#,
    },
    Doodle {
        name: "cloud",
        fills: &[(
            r#"M12 33c-6 0-8-8-3-10 0-7 9-9 12-3 3-5 12-3 12 4 6 0 7 9 1 9Z"#,
            "#FFFDF6",
        )],
        line: r#"M12 33c-6 0-8-8-3-10 0-7 9-9 12-3 3-5 12-3 12 4 6 0 7 9 1 9Z"#,
        extra: r#""#,
    },
    Doodle {
        name: "sun",
        fills: &[(r#"M24 15a9 9 0 1 0 .1 0Z"#, "#F2C55B")],
        line: r#"M24 15a9 9 0 1 0 .1 0ZM24 3v5M24 40v5M3 24h5M40 24h5M9 9l3.5 3.5M35.5 35.5 39 39M9 39l3.5-3.5M35.5 12.5 39 9"#,
        extra: r#"<circle cx="21" cy="23" r=".9" fill="currentColor"/><circle cx="27.5" cy="23" r=".9" fill="currentColor"/><path d="M22 27q2.5 2 5 0" fill="none" stroke="currentColor" stroke-width=".7" stroke-linecap="round"/>"#,
    },
    Doodle {
        name: "moon",
        fills: &[(r#"M31 8a17 17 0 1 0 11 27A14 14 0 0 1 31 8Z"#, "#F2C55B")],
        line: r#"M31 8a17 17 0 1 0 11 27A14 14 0 0 1 31 8Z"#,
        extra: r#""#,
    },
    Doodle {
        name: "star",
        fills: &[(
            r#"M24 6l5 11 12 1-9 8 3 12-11-6-11 6 3-12-9-8 12-1Z"#,
            "#F2C55B",
        )],
        line: r#"M24 6l5 11 12 1-9 8 3 12-11-6-11 6 3-12-9-8 12-1Z"#,
        extra: r#""#,
    },
    Doodle {
        name: "mushroom",
        fills: &[
            (r#"M7 27c0-11 8-18 17-18s17 7 17 18Z"#, "#E98C73"),
            (r#"M18 27h12v11a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4Z"#, "#F6E6C8"),
        ],
        line: r#"M7 27c0-11 8-18 17-18s17 7 17 18ZM18 27h12v11a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4Z"#,
        extra: r##"<circle cx="16" cy="19" r="2.2" fill="#FFFDF6"/><circle cx="27" cy="15" r="2.6" fill="#FFFDF6"/><circle cx="33" cy="22" r="1.8" fill="#FFFDF6"/>"##,
    },
    Doodle {
        name: "campfire",
        fills: &[
            (
                r#"M24 6c3 6 11 10 11 20a11 11 0 0 1-22 0c0-6 4-8 5-13 2 2 3 3 6-7Z"#,
                "#F2A65A",
            ),
            (
                r#"M24 20c2 4 5 6 5 10a5 5 0 0 1-10 0c0-3 3-4 5-10Z"#,
                "#F6D27A",
            ),
        ],
        line: r#"M24 6c3 6 11 10 11 20a11 11 0 0 1-22 0c0-6 4-8 5-13 2 2 3 3 6-7ZM8 42l32-6M8 36l32 6"#,
        extra: r#""#,
    },
    Doodle {
        name: "kettle",
        fills: &[(r#"M10 22h26v14a6 6 0 0 1-6 6H16a6 6 0 0 1-6-6Z"#, "#BFD7DE")],
        line: r#"M10 22h26v14a6 6 0 0 1-6 6H16a6 6 0 0 1-6-6ZM36 26l7-4v8M8 22c2-8 24-8 26 0M17 12c0-2 2-2 2-4M24 12c0-2 2-2 2-4"#,
        extra: r#""#,
    },
    Doodle {
        name: "mug",
        fills: &[(r#"M9 18h23v17a6 6 0 0 1-6 6H15a6 6 0 0 1-6-6Z"#, "#F4E4C8")],
        line: r#"M9 18h23v17a6 6 0 0 1-6 6H15a6 6 0 0 1-6-6ZM32 22h4a5 5 0 0 1 0 10h-4M15 12c0-3 3-3 3-6M23 12c0-3 3-3 3-6"#,
        extra: r#""#,
    },
    Doodle {
        name: "pot",
        fills: &[(r#"M8 22h32v10a9 9 0 0 1-9 9H17a9 9 0 0 1-9-9Z"#, "#E98C73")],
        line: r#"M8 22h32v10a9 9 0 0 1-9 9H17a9 9 0 0 1-9-9ZM4 22h40M3 28l5 0M40 28h5M16 16c0-3 3-3 3-6M25 16c0-3 3-3 3-6M33 16c0-3 3-3 3-6"#,
        extra: r#"<circle cx="18" cy="31" r=".9" fill="currentColor"/><circle cx="30" cy="31" r=".9" fill="currentColor"/><path d="M22 34q2 2 4 0" fill="none" stroke="currentColor" stroke-width=".7" stroke-linecap="round"/>"#,
    },
    Doodle {
        name: "lantern",
        fills: &[(r#"M15 14h18l3 7v14l-3 5H15l-3-5V21Z"#, "#F6D27A")],
        line: r#"M15 14h18l3 7v14l-3 5H15l-3-5V21ZM19 8h10v6H19M20 8c0-5 8-5 8 0M24 20v12M18 27h12"#,
        extra: r#""#,
    },
    Doodle {
        name: "leaf",
        fills: &[(r#"M9 39C7 20 20 7 40 8c2 20-9 33-31 31Z"#, "#A9C99B")],
        line: r#"M9 39C7 20 20 7 40 8c2 20-9 33-31 31ZM9 39 30 17M20 29l-1-8M26 23l7 0"#,
        extra: r#""#,
    },
    Doodle {
        name: "bird",
        fills: &[],
        line: r#"M6 26c5-8 11-8 15 0 4-8 10-8 15 0M30 12c3-4 7-4 9 0 2-4 6-4 8 0"#,
        extra: r#""#,
    },
    Doodle {
        name: "flower",
        fills: &[
            (
                r#"M24 8a7 7 0 1 1 0 14 7 7 0 0 1 0-14ZM10 20a7 7 0 1 1 13 4 7 7 0 0 1-13-4ZM38 20a7 7 0 1 0-13 4 7 7 0 0 0 13-4Z"#,
                "#F4B9B2",
            ),
            (r#"M24 20a4 4 0 1 0 .1 0Z"#, "#F2C55B"),
        ],
        line: r#"M24 8a7 7 0 1 1 0 14 7 7 0 0 1 0-14ZM24 22v20M24 34c-6 0-9-3-9-7 6 0 9 3 9 7ZM24 38c5 0 8-2 9-5-5 0-8 2-9 5Z"#,
        extra: r#""#,
    },
    Doodle {
        name: "acorn",
        fills: &[
            (r#"M14 22h20c0 12-5 20-10 20s-10-8-10-20Z"#, "#E9C99B"),
            (r#"M11 22c0-8 6-11 13-11s13 3 13 11Z"#, "#C99A6B"),
        ],
        line: r#"M14 22h20c0 12-5 20-10 20s-10-8-10-20ZM11 22c0-8 6-11 13-11s13 3 13 11ZM24 11V6"#,
        extra: r#""#,
    },
    Doodle {
        name: "bear",
        fills: &[
            (
                r#"M8 12a6 6 0 1 1 11 3.5M40 12a6 6 0 1 0-11 3.5"#,
                "#D9A878",
            ),
            (
                r#"M24 12c10 0 16 6 16 14s-7 15-16 15S8 34 8 26s6-14 16-14Z"#,
                "#D9A878",
            ),
            (r#"M24 28a6 5 0 1 0 .1 0Z"#, "#F6E6C8"),
        ],
        line: r#"M24 12c10 0 16 6 16 14s-7 15-16 15S8 34 8 26s6-14 16-14ZM8 12a6 6 0 1 1 11 3.5M40 12a6 6 0 1 0-11 3.5M24 28a6 5 0 1 0 .1 0Z"#,
        extra: r#"<circle cx="17" cy="22" r="1.4" fill="currentColor"/><circle cx="31" cy="22" r="1.4" fill="currentColor"/><path d="M22 28h4l-2 2.5Z" fill="currentColor"/>"#,
    },
    Doodle {
        name: "rabbit",
        fills: &[
            (
                r#"M15 6c-3 0-4 10-2 16h8c1-6 0-16-6-16ZM33 6c3 0 4 10 2 16h-8c-1-6 0-16 6-16Z"#,
                "#FFFDF6",
            ),
            (
                r#"M10 30c0-6 6-9 14-9s14 3 14 9-6 11-14 11-14-5-14-11Z"#,
                "#FFFDF6",
            ),
            (r#"M15 9c-1 0-1 5 0 9M33 9c1 0 1 5 0 9"#, "#F4B9B2"),
        ],
        line: r#"M15 6c-3 0-4 10-2 16h8c1-6 0-16-6-16ZM33 6c3 0 4 10 2 16h-8c-1-6 0-16 6-16ZM10 30c0-6 6-9 14-9s14 3 14 9-6 11-14 11-14-5-14-11Z"#,
        extra: r##"<circle cx="18" cy="30" r="1.3" fill="currentColor"/><circle cx="30" cy="30" r="1.3" fill="currentColor"/><path d="M22 34q2 2 4 0" fill="none" stroke="currentColor" stroke-width=".8" stroke-linecap="round"/><circle cx="14" cy="34" r="2" fill="#F4B9B2" opacity=".7"/><circle cx="34" cy="34" r="2" fill="#F4B9B2" opacity=".7"/>"##,
    },
    Doodle {
        name: "van",
        fills: &[
            (r#"M5 33v-11l7-10h19l8 10h4v11Z"#, "#8EB4C9"),
            (r#"M13 15h7v7h-12Z"#, "#EAF3F5"),
            (r#"M23 15h7l5 7H23Z"#, "#EAF3F5"),
        ],
        line: r#"M5 33v-11l7-10h19l8 10h4v11ZM8 22h35M23 12v10M12 12h19"#,
        extra: r##"<circle cx="14" cy="34" r="4" fill="#FFFDF6" stroke="currentColor" stroke-width="1.4"/><circle cx="35" cy="34" r="4" fill="#FFFDF6" stroke="currentColor" stroke-width="1.4"/>"##,
    },
    Doodle {
        name: "cards",
        fills: &[
            (r#"M8 12h16v24H8Z"#, "#F4E4C8"),
            (r#"M20 10h18v26H20Z"#, "#FFFDF6"),
        ],
        line: r#"M8 12h16v24H8ZM20 10h18v26H20ZM29 18v10M24 23h10"#,
        extra: r#""#,
    },
    Doodle {
        name: "sparkle",
        fills: &[],
        line: r#"M24 8v10M24 30v10M8 24h10M30 24h10M14 14l5 5M29 29l5 5M34 14l-5 5M19 29l-5 5"#,
        extra: r#""#,
    },
    Doodle {
        name: "skewer",
        fills: &[
            (r#"M30 5l12 12-6 6-12-12Z"#, "#FFFDF6"),
            (r#"M20 15l12 12-6 6-12-12Z"#, "#F6D7A8"),
        ],
        line: r#"M30 5l12 12-6 6-12-12ZM20 15l12 12-6 6-12-12ZM14 33 5 43"#,
        extra: r#""#,
    },
    Doodle {
        name: "cat",
        fills: &[(
            r#"M8 20 9 6l9 7h12l9-7 1 14c0 10-7 16-16 16S8 30 8 20Z"#,
            "#F2D2A0",
        )],
        line: r#"M8 20 9 6l9 7h12l9-7 1 14c0 10-7 16-16 16S8 30 8 20ZM14 33 5 31M14 37 5 39M34 33l9-2M34 37l9 2"#,
        extra: r#"<circle cx="18" cy="25" r="1.3" fill="currentColor"/><circle cx="30" cy="25" r="1.3" fill="currentColor"/><path d="M22 30h4l-2 2.4Z" fill="currentColor"/>"#,
    },
    Doodle {
        name: "fox",
        fills: &[
            (
                r#"M5 9l13 9h12l13-9-3 19c-2 8-8 14-16 14S10 36 8 28Z"#,
                "#E9A25F",
            ),
            (r#"M15 34c3-7 15-7 18 0-3 6-15 6-18 0Z"#, "#FFFDF6"),
        ],
        line: r#"M5 9l13 9h12l13-9-3 19c-2 8-8 14-16 14S10 36 8 28Z"#,
        extra: r#"<circle cx="18" cy="27" r="1.3" fill="currentColor"/><circle cx="30" cy="27" r="1.3" fill="currentColor"/><path d="M22 34h4l-2 2.6Z" fill="currentColor"/>"#,
    },
    Doodle {
        name: "owl",
        fills: &[
            (
                r#"M10 12c5-5 23-5 28 0v22c0 6-6 10-14 10S10 40 10 34Z"#,
                "#C9A37A",
            ),
            (r#"M12 20a6 6 0 1 0 12 0a6 6 0 1 0-12 0Z"#, "#FFFDF6"),
            (r#"M24 20a6 6 0 1 0 12 0a6 6 0 1 0-12 0Z"#, "#FFFDF6"),
            (r#"M22 25l2 5 2-5Z"#, "#F2A65A"),
        ],
        line: r#"M10 12c5-5 23-5 28 0v22c0 6-6 10-14 10S10 40 10 34ZM10 12l-2-6 8 4M38 12l2-6-8 4M12 20a6 6 0 1 0 12 0a6 6 0 1 0-12 0ZM24 20a6 6 0 1 0 12 0a6 6 0 1 0-12 0Z"#,
        extra: r#"<circle cx="19" cy="21" r="1.6" fill="currentColor"/><circle cx="29" cy="21" r="1.6" fill="currentColor"/>"#,
    },
    Doodle {
        name: "hedgehog",
        fills: &[
            (r#"M5 36c0-14 8-24 20-24s16 10 16 24Z"#, "#B8956A"),
            (r#"M28 36c0-7 5-10 13-9l-1 9Z"#, "#F6E6C8"),
        ],
        line: r#"M5 36c0-14 8-24 20-24s16 10 16 24ZM11 25l-5-3M16 18l-3-6M24 14l-1-7M32 16l3-7M37 22l6-4M28 36c0-7 5-10 13-9"#,
        extra: r#"<circle cx="36" cy="31" r="1.2" fill="currentColor"/><circle cx="41" cy="30" r="1.6" fill="currentColor"/>"#,
    },
    Doodle {
        name: "duck",
        fills: &[
            (
                r#"M11 31c0-8 6-12 12-12 2-8 14-6 14 2 6 0 8 4 8 4s-3 3-8 3c0 10-8 16-17 16S11 40 11 31Z"#,
                "#F6D27A",
            ),
            (r#"M37 21l8 3-8 3Z"#, "#F2A65A"),
        ],
        line: r#"M11 31c0-8 6-12 12-12 2-8 14-6 14 2l8 3-8 3c0 10-8 16-17 16S11 40 11 31ZM18 34c4 4 10 3 13-2"#,
        extra: r#"<circle cx="31" cy="19" r="1.4" fill="currentColor"/>"#,
    },
    Doodle {
        name: "frog",
        fills: &[
            (
                r#"M7 30c0-9 5-13 10-13 3 0 4 2 7 2s4-2 7-2c5 0 10 4 10 13 0 8-8 12-17 12S7 38 7 30Z"#,
                "#A9C99B",
            ),
            (r#"M12 15a5 5 0 1 0 10 0a5 5 0 1 0-10 0Z"#, "#FFFDF6"),
            (r#"M26 15a5 5 0 1 0 10 0a5 5 0 1 0-10 0Z"#, "#FFFDF6"),
        ],
        line: r#"M7 30c0-9 5-13 10-13 3 0 4 2 7 2s4-2 7-2c5 0 10 4 10 13 0 8-8 12-17 12S7 38 7 30ZM12 15a5 5 0 1 0 10 0a5 5 0 1 0-10 0ZM26 15a5 5 0 1 0 10 0a5 5 0 1 0-10 0ZM17 33q7 5 14 0"#,
        extra: r#"<circle cx="17" cy="16" r="1.4" fill="currentColor"/><circle cx="31" cy="16" r="1.4" fill="currentColor"/>"#,
    },
    Doodle {
        name: "fish",
        fills: &[
            (r#"M5 24c8-11 24-11 30 0-6 11-22 11-30 0Z"#, "#8EB4C9"),
            (r#"M35 24l9-9v18Z"#, "#BFD7DE"),
        ],
        line: r#"M5 24c8-11 24-11 30 0-6 11-22 11-30 0ZM35 24l9-9v18ZM24 15q4 9 0 18"#,
        extra: r#"<circle cx="13" cy="22" r="1.3" fill="currentColor"/>"#,
    },
    Doodle {
        name: "butterfly",
        fills: &[
            (r#"M24 22C20 10 8 8 8 17s8 8 16 5Z"#, "#F4B9B2"),
            (r#"M24 22c4-12 16-14 16-5s-8 8-16 5Z"#, "#F4B9B2"),
            (r#"M24 24c-8 1-13 8-9 13s8-1 9-13Z"#, "#BFD7DE"),
            (r#"M24 24c8 1 13 8 9 13s-8-1-9-13Z"#, "#BFD7DE"),
        ],
        line: r#"M24 22C20 10 8 8 8 17s8 8 16 5ZM24 22c4-12 16-14 16-5s-8 8-16 5ZM24 24c-8 1-13 8-9 13s8-1 9-13ZM24 24c8 1 13 8 9 13s-8-1-9-13ZM24 14v26M24 14l-4-6M24 14l4-6"#,
        extra: r#""#,
    },
    Doodle {
        name: "snail",
        fills: &[
            (r#"M15 22a11 11 0 1 0 22 0a11 11 0 1 0-22 0Z"#, "#E9C99B"),
            (
                r#"M4 38c0-5 4-5 9-5h31c0 7-6 9-14 9H8c-2 0-4-2-4-4Z"#,
                "#F6E6C8",
            ),
        ],
        line: r#"M15 22a11 11 0 1 0 22 0a11 11 0 1 0-22 0ZM21 22a5 5 0 1 0 10 0a4 4 0 0 0-7-3M4 38c0-5 4-5 9-5h31c0 7-6 9-14 9H8c-2 0-4-2-4-4ZM8 33v-8M13 33v-6"#,
        extra: r#""#,
    },
    Doodle {
        name: "bee",
        fills: &[
            (r#"M12 28a12 9 0 1 0 24 0a12 9 0 1 0-24 0Z"#, "#F6D27A"),
            (r#"M17 21c-5-11 6-14 9-6ZM27 21c3-9 14-8 10 1Z"#, "#DCEBEF"),
        ],
        line: r#"M12 28a12 9 0 1 0 24 0a12 9 0 1 0-24 0ZM20 20v16M28 20v16M17 21c-5-11 6-14 9-6M27 21c3-9 14-8 10 1M36 24l6-3M10 26l-5 2"#,
        extra: r#"<circle cx="15" cy="26" r="1.1" fill="currentColor"/>"#,
    },
    Doodle {
        name: "chair",
        fills: &[(r#"M15 6l4 20h18l-3-4H24l-3-16Z"#, "#8EB4C9")],
        line: r#"M15 6l4 20h18l-3-4H24l-3-16ZM19 26l-5 16M33 22l5 20M19 26l15 16M33 22 17 42M12 6h5"#,
        extra: r#""#,
    },
    Doodle {
        name: "camera",
        fills: &[
            (r#"M5 16h38v24H5Z"#, "#BFD7DE"),
            (r#"M17 28a7 7 0 1 0 14 0a7 7 0 1 0-14 0Z"#, "#FFFDF6"),
        ],
        line: r#"M5 16h38v24H5ZM16 16l3-5h10l3 5M17 28a7 7 0 1 0 14 0a7 7 0 1 0-14 0Z"#,
        extra: r#"<circle cx="24" cy="28" r="2.4" fill="currentColor"/>"#,
    },
    Doodle {
        name: "backpack",
        fills: &[
            (
                r#"M11 15c0-7 4-9 13-9s13 2 13 9v24c0 3-2 5-5 5H16c-3 0-5-2-5-5Z"#,
                "#E59A6B",
            ),
            (r#"M15 28h18v12H15Z"#, "#F2C97A"),
        ],
        line: r#"M11 15c0-7 4-9 13-9s13 2 13 9v24c0 3-2 5-5 5H16c-3 0-5-2-5-5ZM15 28h18v12H15ZM19 6c0-3 2-4 5-4s5 1 5 4M24 28v5"#,
        extra: r#""#,
    },
    Doodle {
        name: "boots",
        fills: &[(r#"M10 6h13v20l12 4c4 1 7 3 7 7v5H10Z"#, "#C99A6B")],
        line: r#"M10 6h13v20l12 4c4 1 7 3 7 7v5H10ZM10 38h32M10 14h13"#,
        extra: r#""#,
    },
    Doodle {
        name: "compass",
        fills: &[
            (r#"M7 24a17 17 0 1 0 34 0a17 17 0 1 0-34 0Z"#, "#FFFDF6"),
            (r#"M24 9l5 15h-10Z"#, "#E98C73"),
            (r#"M24 39l-5-15h10Z"#, "#8EB4C9"),
        ],
        line: r#"M7 24a17 17 0 1 0 34 0a17 17 0 1 0-34 0ZM24 9l5 15h-10ZM24 39l-5-15h10ZM24 3v4M24 41v4"#,
        extra: r#""#,
    },
    Doodle {
        name: "map",
        fills: &[(r#"M5 10l13 4 12-4 13 4v26l-13-4-12 4-13-4Z"#, "#F6E6C8")],
        line: r#"M5 10l13 4 12-4 13 4v26l-13-4-12 4-13-4ZM18 14v26M30 10v26M22 30l4-6 4 3 5-8"#,
        extra: r##"<circle cx="35" cy="19" r="1.5" fill="#E98C73"/>"##,
    },
    Doodle {
        name: "binoculars",
        fills: &[
            (r#"M5 18h15v24H5ZM28 18h15v24H28Z"#, "#8EB4C9"),
            (r#"M20 24h8v10h-8Z"#, "#BFD7DE"),
        ],
        line: r#"M5 18h15v24H5ZM28 18h15v24H28ZM20 24h8v10h-8ZM8 18v-6h9v6M31 18v-6h9v6"#,
        extra: r#""#,
    },
    Doodle {
        name: "thermos",
        fills: &[
            (r#"M15 12h18v31H15Z"#, "#BFD7DE"),
            (r#"M14 6h20v6H14Z"#, "#E59A6B"),
        ],
        line: r#"M15 12h18v31H15ZM14 6h20v6H14ZM15 22h18"#,
        extra: r#""#,
    },
    Doodle {
        name: "hat",
        fills: &[
            (
                r#"M4 33c0-4 10-6 20-6s20 2 20 6-10 7-20 7S4 37 4 33Z"#,
                "#F2C97A",
            ),
            (r#"M13 29c0-13 4-19 11-19s11 6 11 19Z"#, "#F2C97A"),
            (r#"M13 27h22v4H13Z"#, "#E59A6B"),
        ],
        line: r#"M4 33c0-4 10-6 20-6s20 2 20 6-10 7-20 7S4 37 4 33ZM13 29c0-13 4-19 11-19s11 6 11 19M13 27h22"#,
        extra: r#""#,
    },
    Doodle {
        name: "umbrella",
        fills: &[(r#"M4 25C6 8 42 8 44 25Z"#, "#F4B9B2")],
        line: r#"M4 25C6 8 42 8 44 25ZM4 25q5-4 10 0t10 0 10 0 10 0M24 25v14a4 4 0 0 1-8 0M24 6V3"#,
        extra: r#""#,
    },
    Doodle {
        name: "kite",
        fills: &[(r#"M24 3l14 17-14 22L10 20Z"#, "#F4B9B2")],
        line: r#"M24 3l14 17-14 22L10 20ZM24 3v39M10 20h28M24 42c-4 2-4 4 0 6s4 3 0 5"#,
        extra: r#""#,
    },
    Doodle {
        name: "bread",
        fills: &[(r#"M5 28c0-13 11-19 19-19s19 6 19 19v11H5Z"#, "#E9C99B")],
        line: r#"M5 28c0-13 11-19 19-19s19 6 19 19v11H5ZM14 19l4 8M24 16l4 8M33 19l4 8"#,
        extra: r#""#,
    },
    Doodle {
        name: "onigiri",
        fills: &[
            (
                r#"M24 5c8 8 17 20 17 29 0 5-4 8-9 8H16c-5 0-9-3-9-8C7 25 16 13 24 5Z"#,
                "#FFFDF6",
            ),
            (r#"M15 30h18v12H15Z"#, "#4B5D52"),
        ],
        line: r#"M24 5c8 8 17 20 17 29 0 5-4 8-9 8H16c-5 0-9-3-9-8C7 25 16 13 24 5ZM15 30h18v12H15Z"#,
        extra: r#""#,
    },
    Doodle {
        name: "bento",
        fills: &[
            (r#"M4 12h40v28H4Z"#, "#F6E6C8"),
            (r#"M8 16h15v20H8Z"#, "#FFFDF6"),
            (r#"M27 16h13v9H27Z"#, "#F6D27A"),
            (r#"M27 28h13v8H27Z"#, "#A9C99B"),
        ],
        line: r#"M4 12h40v28H4ZM8 16h15v20H8ZM27 16h13v9H27ZM27 28h13v8H27Z"#,
        extra: r#""#,
    },
    Doodle {
        name: "teapot",
        fills: &[(r#"M9 22h26v13a8 8 0 0 1-8 8H17a8 8 0 0 1-8-8Z"#, "#A9C99B")],
        line: r#"M9 22h26v13a8 8 0 0 1-8 8H17a8 8 0 0 1-8-8ZM9 27H5c0-5 2-7 6-7M35 26h4a4 4 0 0 1 0 9h-4M16 22c0-6 2-9 6-9s6 3 6 9M22 13v-3"#,
        extra: r#""#,
    },
    Doodle {
        name: "dango",
        fills: &[
            (r#"M18 12a6 6 0 1 0 12 0a6 6 0 1 0-12 0Z"#, "#F4B9B2"),
            (r#"M18 25a6 6 0 1 0 12 0a6 6 0 1 0-12 0Z"#, "#FFFDF6"),
            (r#"M18 38a6 6 0 1 0 12 0a6 6 0 1 0-12 0Z"#, "#A9C99B"),
        ],
        line: r#"M24 2v44M18 12a6 6 0 1 0 12 0a6 6 0 1 0-12 0ZM18 25a6 6 0 1 0 12 0a6 6 0 1 0-12 0ZM18 38a6 6 0 1 0 12 0a6 6 0 1 0-12 0Z"#,
        extra: r#""#,
    },
    Doodle {
        name: "watermelon",
        fills: &[
            (r#"M5 20a19 19 0 0 0 38 0Z"#, "#E98C73"),
            (
                r#"M5 20a19 19 0 0 0 38 0c-3 4-8 8-19 8S8 24 5 20Z"#,
                "#A9C99B",
            ),
        ],
        line: r#"M5 20h38M5 20a19 19 0 0 0 38 0"#,
        extra: r#"<ellipse cx="17" cy="23" rx="1.1" ry="1.8" fill="currentColor"/><ellipse cx="24" cy="25" rx="1.1" ry="1.8" fill="currentColor"/><ellipse cx="31" cy="23" rx="1.1" ry="1.8" fill="currentColor"/>"#,
    },
    Doodle {
        name: "icecream",
        fills: &[
            (r#"M14 22 24 45l10-23Z"#, "#E9C99B"),
            (r#"M11 24a13 13 0 0 1 26 0Z"#, "#F4B9B2"),
            (r#"M15 14a9 9 0 0 1 18 0Z"#, "#FFFDF6"),
        ],
        line: r#"M14 22 24 45l10-23ZM11 24a13 13 0 0 1 26 0ZM15 14a9 9 0 0 1 18 0ZM17 28l7 12M31 28l-7 12"#,
        extra: r#""#,
    },
    Doodle {
        name: "rainbow",
        fills: &[
            (r#"M4 38a20 20 0 0 1 40 0h-6a14 14 0 0 0-28 0Z"#, "#F4B9B2"),
            (r#"M10 38a14 14 0 0 1 28 0h-6a8 8 0 0 0-16 0Z"#, "#F6D27A"),
            (r#"M16 38a8 8 0 0 1 16 0h-5a3 3 0 0 0-6 0Z"#, "#BFD7DE"),
        ],
        line: r#"M4 38a20 20 0 0 1 40 0M10 38a14 14 0 0 1 28 0M16 38a8 8 0 0 1 16 0"#,
        extra: r#""#,
    },
    Doodle {
        name: "bamboo",
        fills: &[(r#"M16 4h7v40h-7ZM29 10h7v34h-7Z"#, "#A9C99B")],
        line: r#"M16 4h7v40h-7ZM29 10h7v34h-7ZM16 16h7M16 28h7M29 20h7M29 32h7M23 14c6-1 10-5 12-9M16 24c-6-1-10-5-12-9"#,
        extra: r#""#,
    },
    Doodle {
        name: "sakura",
        fills: &[
            (
                r#"M17 13a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM28 21a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM24 34a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM10 34a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM6 21a7 7 0 1 0 14 0a7 7 0 1 0-14 0Z"#,
                "#F8CFD2",
            ),
            (
                r#"M20.5 26a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0Z"#,
                "#F2C55B",
            ),
        ],
        line: r#"M17 13a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM28 21a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM24 34a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM10 34a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM6 21a7 7 0 1 0 14 0a7 7 0 1 0-14 0Z"#,
        extra: r#""#,
    },
    Doodle {
        name: "maple",
        fills: &[(
            r#"M24 3l4 10 8-4-2 11 10 2-8 7 4 8-10-1-2 8-4-6-4 6-2-8-10 1 4-8-8-7 10-2-2-11 8 4Z"#,
            "#E98C73",
        )],
        line: r#"M24 3l4 10 8-4-2 11 10 2-8 7 4 8-10-1-2 8-4-6-4 6-2-8-10 1 4-8-8-7 10-2-2-11 8 4ZM24 44V28"#,
        extra: r#""#,
    },
    Doodle {
        name: "ginkgo",
        fills: &[(
            r#"M24 40V29C9 29 5 18 7 9c6 4 11 2 17 7 6-5 11-3 17-7 2 9-2 20-17 20Z"#,
            "#F6D27A",
        )],
        line: r#"M24 44V29C9 29 5 18 7 9c6 4 11 2 17 7 6-5 11-3 17-7 2 9-2 20-17 20ZM24 16v13"#,
        extra: r#""#,
    },
    Doodle {
        name: "sunflower",
        fills: &[
            (
                r#"M24 3l4 8 8-4 0 9 9 0-5 8 7 6-9 2 2 9-8-3-3 8-5-7-5 7-3-8-8 3 2-9-9-2 7-6-5-8 9 0 0-9 8 4Z"#,
                "#F6D27A",
            ),
            (r#"M14 24a10 10 0 1 0 20 0a10 10 0 1 0-20 0Z"#, "#C99A6B"),
        ],
        line: r#"M24 3l4 8 8-4 0 9 9 0-5 8 7 6-9 2 2 9-8-3-3 8-5-7-5 7-3-8-8 3 2-9-9-2 7-6-5-8 9 0 0-9 8 4ZM14 24a10 10 0 1 0 20 0a10 10 0 1 0-20 0Z"#,
        extra: r#""#,
    },
    Doodle {
        name: "tulip",
        fills: &[
            (
                r#"M13 6c0 11 3 19 11 19s11-8 11-19l-6 4-5-6-5 6Z"#,
                "#F4B9B2",
            ),
            (r#"M24 40c-8 0-12-5-12-10 8 0 12 4 12 10Z"#, "#A9C99B"),
        ],
        line: r#"M13 6c0 11 3 19 11 19s11-8 11-19l-6 4-5-6-5 6ZM24 25v20M24 40c-8 0-12-5-12-10 8 0 12 4 12 10Z"#,
        extra: r#""#,
    },
    Doodle {
        name: "clover",
        fills: &[(
            r#"M10 16a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM24 16a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM10 30a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM24 30a7 7 0 1 0 14 0a7 7 0 1 0-14 0Z"#,
            "#A9C99B",
        )],
        line: r#"M10 16a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM24 16a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM10 30a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM24 30a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM24 24l-5 21"#,
        extra: r#""#,
    },
    Doodle {
        name: "pinecone",
        fills: &[(
            r#"M24 5c9 0 13 8 13 19s-4 19-13 19-13-8-13-19S15 5 24 5Z"#,
            "#C99A6B",
        )],
        line: r#"M24 5c9 0 13 8 13 19s-4 19-13 19-13-8-13-19S15 5 24 5ZM13 16q11 6 22 0M12 25q12 7 24 0M14 34q10 6 20 0M24 5v38"#,
        extra: r#""#,
    },
    Doodle {
        name: "cherry",
        fills: &[
            (
                r#"M6 34a8 8 0 1 0 16 0a8 8 0 1 0-16 0ZM26 36a7 7 0 1 0 14 0a7 7 0 1 0-14 0Z"#,
                "#E98C73",
            ),
            (r#"M30 6c6-2 11 0 13 5-6 2-11 0-13-5Z"#, "#A9C99B"),
        ],
        line: r#"M6 34a8 8 0 1 0 16 0a8 8 0 1 0-16 0ZM26 36a7 7 0 1 0 14 0a7 7 0 1 0-14 0ZM14 26C17 15 23 8 30 6M33 29C32 19 31 11 30 6M30 6c6-2 11 0 13 5-6 2-11 0-13-5Z"#,
        extra: r#""#,
    },
    Doodle {
        name: "hammock",
        fills: &[(r#"M5 22c6 14 32 14 38 0Z"#, "#F4B9B2")],
        line: r#"M5 8v36M43 8v36M5 22c6 14 32 14 38 0M5 22h38M10 44h-10M48 44H38"#,
        extra: r#""#,
    },
];

const BIG_CAMP: &[&str] = &["tent", "tent", "campfire", "hammock"];
const ANIMALS: &[&str] = &[
    "bear",
    "rabbit",
    "cat",
    "fox",
    "owl",
    "hedgehog",
    "duck",
    "frog",
    "fish",
    "butterfly",
    "snail",
    "bee",
];
const PLANTS: &[&str] = &[
    "tree",
    "pine",
    "flower",
    "mushroom",
    "leaf",
    "acorn",
    "bamboo",
    "sakura",
    "maple",
    "ginkgo",
    "sunflower",
    "tulip",
    "clover",
    "pinecone",
    "cherry",
];
const GEAR: &[&str] = &[
    "lantern",
    "kettle",
    "mug",
    "chair",
    "camera",
    "backpack",
    "boots",
    "compass",
    "map",
    "binoculars",
    "thermos",
    "hat",
    "umbrella",
    "cards",
    "skewer",
];
const FOOD: &[&str] = &[
    "onigiri",
    "bento",
    "dango",
    "watermelon",
    "icecream",
    "bread",
    "teapot",
    "mug",
];
const SKY: &[&str] = &[
    "cloud",
    "cloud",
    "rainbow",
    "bird",
    "star",
    "sparkle",
    "butterfly",
    "kite",
];
const SMALL: &[&str] = &[
    "bear",
    "rabbit",
    "cat",
    "fox",
    "owl",
    "hedgehog",
    "duck",
    "frog",
    "fish",
    "butterfly",
    "snail",
    "bee",
    "tree",
    "pine",
    "flower",
    "mushroom",
    "leaf",
    "acorn",
    "bamboo",
    "sakura",
    "maple",
    "ginkgo",
    "sunflower",
    "tulip",
    "clover",
    "pinecone",
    "cherry",
    "lantern",
    "kettle",
    "mug",
    "chair",
    "camera",
    "backpack",
    "boots",
    "compass",
    "map",
    "binoculars",
    "thermos",
    "hat",
    "umbrella",
    "cards",
    "skewer",
    "onigiri",
    "bento",
    "dango",
    "watermelon",
    "icecream",
    "bread",
    "teapot",
    "bird",
    "star",
    "sparkle",
    "cloud",
    "rainbow",
    "kite",
];
const GROUND: &[&str] = &[
    "bear",
    "rabbit",
    "cat",
    "fox",
    "owl",
    "hedgehog",
    "duck",
    "frog",
    "fish",
    "butterfly",
    "snail",
    "bee",
    "tree",
    "pine",
    "flower",
    "mushroom",
    "leaf",
    "acorn",
    "bamboo",
    "sakura",
    "maple",
    "ginkgo",
    "sunflower",
    "tulip",
    "clover",
    "pinecone",
    "cherry",
    "lantern",
    "kettle",
    "mug",
    "chair",
    "camera",
    "backpack",
    "boots",
    "compass",
    "map",
    "binoculars",
    "thermos",
    "hat",
    "umbrella",
    "cards",
    "skewer",
];

/// 手帖的抖動濾鏡（現行 `WOBBLE`），讓線條看起來像手繪。
pub(super) const WOBBLE: &str = r#"<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><filter id="j-wobble" x="-6%" y="-6%" width="112%" height="112%"><feTurbulence type="fractalNoise" baseFrequency=".035" numOctaves="2" seed="4" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="2.4"/></filter></svg>"#;

/// 現行 `SVG()`：24×24 的線條圖示，`body` 是 [`icon_body`] 或固定的圖示內容。
pub(super) fn svg(body: &str) -> String {
    format!(
        r#"<svg class="" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">{body}</svg>"#
    )
}

/// 圖示的內容；沒有這個圖示時是星星（現行 `ICONS[name] || ICONS.star`）。
pub(super) fn icon_body(name: &str) -> &'static str {
    ICONS
        .iter()
        .find(|(key, _)| *key == name)
        .or_else(|| ICONS.iter().find(|(key, _)| *key == "star"))
        .map_or("", |(_, body)| body)
}

/// 活動種類的圖示（現行 `KIND_ICON`）。
pub(super) const fn kind_icon(kind: StudioKind) -> &'static str {
    match kind {
        StudioKind::Sunrise => "sun",
        StudioKind::Breakfast => "cup",
        StudioKind::Meal | StudioKind::Noodles => "bowl",
        StudioKind::Setup | StudioKind::Camp => "tent",
        StudioKind::Bbq | StudioKind::Hotpot => "pot",
        StudioKind::Night => "moon",
        StudioKind::Explore => "camera",
        StudioKind::Games => "cards",
        StudioKind::Pack => "box",
        StudioKind::Cleanup => "broom",
        StudioKind::Depart | StudioKind::Travel => "car",
        StudioKind::Market => "basket",
        StudioKind::Meet => "people",
        StudioKind::Activity => "star",
    }
}

/// 現行 `hashStr()`：依 Unicode 碼位的 FNV-1a（32 位元）。
pub(super) fn hash_str(text: &str) -> u32 {
    let mut h: u32 = 2_166_136_261;
    for ch in text.chars() {
        h ^= u32::from(ch);
        h = h.wrapping_mul(16_777_619);
    }
    h
}

/// 現行 `rng()`（mulberry32）：同一個種子產生同一串 0 以上、1 以下的數。
pub(super) struct Rng(u32);

impl Rng {
    pub(super) fn new(seed: u32) -> Rng {
        Rng(seed)
    }

    /// 下一個數。
    pub(super) fn float(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6D2B_79F5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }

    /// `Math.floor(rand() * n)`。
    fn index(&mut self, n: usize) -> usize {
        // n 很小，乘積小於 n，轉換不會溢位
        (self.float() * n as f64).floor() as usize
    }

    /// `Math.round(rand() * span - half)`。
    fn round(&mut self, span: f64, half: f64) -> f64 {
        js_round(self.float() * span - half)
    }
}

/// `Math.round()`：最接近的整數，剛好在兩者中間時取較大的一個。
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// JavaScript `String(number)`：整數不寫小數點，`-0` 寫成「0」，其他是能還原同一個數的最短寫法。
fn js_num(value: f64) -> String {
    if value == 0.0 {
        "0".to_owned()
    } else {
        format!("{value}")
    }
}

/// 現行 `pickFrom()`。
fn pick(rng: &mut Rng, items: &[&'static str]) -> &'static str {
    items[rng.index(items.len())]
}

/// 現行 `shuffled()`（Fisher–Yates，從最後一個往前）。
fn shuffled<T: Copy>(rng: &mut Rng, items: &[T]) -> Vec<T> {
    let mut out = items.to_vec();
    for i in (1..out.len()).rev() {
        let j = rng.index(i + 1);
        out.swap(i, j);
    }
    out
}

/// 現行 `distinct()`（沒有要避開的項目）：打亂之後取前 `n` 個。
fn distinct(rng: &mut Rng, pool: &[&'static str], n: usize) -> Vec<&'static str> {
    let mut out = shuffled(rng, pool);
    out.truncate(n);
    out
}

/// 現行 `doodle()`：把小圖案放在 (x, y)，縮放 `s`、以中心旋轉 `r` 度；`class` 不是空的時外面再包一層 `<g class>`。
fn doodle(name: &str, x: f64, y: f64, s: f64, r: f64, class: &str) -> String {
    let Some(d) = DOODLES.iter().find(|d| d.name == name) else {
        return String::new();
    };
    let fills: String = d
        .fills
        .iter()
        .map(|(path, color)| format!(r#"<path d="{path}" fill="{color}"/>"#))
        .collect();
    let center = js_num(24.0 * s);
    let g = format!(
        r#"<g transform="translate({x} {y}) rotate({r} {center} {center}) scale({s})"><g transform="translate(1.6 1.4)">{fills}</g><path d="{line}" fill="none" stroke="currentColor" stroke-width="{width:.2}" stroke-linecap="round" stroke-linejoin="round"/>{extra}</g>"#,
        x = js_num(x),
        y = js_num(y),
        r = js_num(r),
        s = js_num(s),
        line = d.line,
        width = 2.0 / s,
        extra = d.extra,
    );
    if class.is_empty() {
        g
    } else {
        format!(r#"<g class="{class}">{g}</g>"#)
    }
}

/// 現行 `sceneSvg()`。
fn scene_svg(w: u32, h: u32, body: &str) -> String {
    format!(
        r#"<svg class="j-wob" viewBox="0 0 {w} {h}" width="{w}" height="{h}" color="currentColor" aria-hidden="true" focusable="false">{body}</svg>"#
    )
}

/// 現行 `groundPath()`：一條略為起伏的地面線。
fn ground_path(rng: &mut Rng, w: f64, y: u32, width: u32) -> String {
    let mut jitter = || format!("{:.1}", rng.float() * 10.0 - 5.0);
    let (a, b, c, d, e) = (jitter(), jitter(), jitter(), jitter(), jitter());
    format!(
        r##"<path d="M6 {y}c{w1} {a} {w2} {b} {w3} {c}s{w4} {d} {w5} {e}" fill="none" stroke="#C8D5BC" stroke-width="{width}" stroke-linecap="round"/>"##,
        w1 = js_num(w * 0.18),
        w2 = js_num(w * 0.32),
        w3 = js_num(w * 0.5),
        w4 = js_num(w * 0.3),
        w5 = js_num(w * 0.44),
    )
}

/// 現行 `headerScene()`（300×134）：隨機的主圖案、三種排法之一，以及隨機的天空與地上的小夥伴。
pub(super) fn header_scene(rng: &mut Rng) -> String {
    let main = pick(rng, &["tent", "tent", "van", "campfire", "hammock"]);
    let layout = rng.index(3);
    let main_x = [86.0, 24.0, 178.0][layout];
    let spots: [[(f64, f64, f64); 4]; 3] = [
        [
            (14.0, 66.0, 1.05),
            (236.0, 66.0, 1.05),
            (62.0, 96.0, 0.62),
            (206.0, 98.0, 0.62),
        ],
        [
            (150.0, 70.0, 0.95),
            (196.0, 62.0, 1.0),
            (242.0, 70.0, 0.95),
            (112.0, 98.0, 0.55),
        ],
        [
            (10.0, 70.0, 0.95),
            (58.0, 62.0, 1.0),
            (106.0, 70.0, 0.95),
            (262.0, 98.0, 0.55),
        ],
    ];
    let spots = spots[layout];
    let friends = distinct(rng, GROUND, spots.len());
    let sx = shuffled(rng, &[14.0, 116.0, 218.0]);
    let sky = distinct(rng, SKY, 2);
    let mut svg = ground_path(rng, 288.0, 116, 14);
    svg += &doodle("sun", sx[0], 2.0, 0.95, 0.0, "j-sun");
    svg += &doodle("moon", sx[0], 2.0, 0.95, 0.0, "j-moon");
    let y1 = 4.0 + rng.round(8.0, 0.0);
    let r1 = rng.round(12.0, 6.0);
    svg += &doodle(sky[0], sx[1], y1, 0.8, r1, "");
    let y2 = 8.0 + rng.round(8.0, 0.0);
    let r2 = rng.round(12.0, 6.0);
    svg += &doodle(sky[1], sx[2], y2, 0.7, r2, "");
    let r = rng.round(12.0, 6.0) / 2.0;
    svg += &doodle(main, main_x, 14.0, 2.3, r, "");
    for (friend, (x, y, s)) in friends.iter().zip(spots) {
        let r = rng.round(12.0, 6.0);
        svg += &doodle(friend, x, y, s, r, "");
    }
    scene_svg(300, 134, &svg)
}

/// 現行 `dayScene()`（180×104）：隨機的主圖案與兩個小夥伴，兩種排法之一。
fn day_scene(rng: &mut Rng, mains: &[&'static str], pools: &[&'static str]) -> String {
    let (w, h) = (180, 104);
    let main = pick(rng, mains);
    let flip = rng.float() < 0.5;
    let friends = distinct(rng, pools, 2);
    let top = pick(rng, SKY);
    let (mx, ax, bx) = if flip {
        (100.0, 8.0, 52.0)
    } else {
        (40.0, 128.0, 150.0)
    };
    let mut svg = ground_path(rng, f64::from(w - 10), 94, 8);
    let r = rng.round(6.0, 3.0);
    svg += &doodle(main, mx, 8.0, 1.75, r, "");
    let r = rng.round(12.0, 6.0);
    svg += &doodle(friends[0], ax, 46.0, 0.9, r, "");
    let r = rng.round(14.0, 7.0);
    svg += &doodle(friends[1], if flip { 20.0 } else { bx }, 60.0, 0.6, r, "");
    svg += &doodle(top, if flip { 12.0 } else { 128.0 }, 2.0, 0.55, 8.0, "");
    scene_svg(w, h, &svg)
}

/// 現行 `campScene()`：有路線的日子。
pub(super) fn camp_scene(rng: &mut Rng) -> String {
    let pools: Vec<&'static str> = [
        PLANTS,
        ANIMALS,
        &["lantern", "chair", "kettle", "boots", "backpack"],
    ]
    .concat();
    day_scene(rng, BIG_CAMP, &pools)
}

/// 現行 `lifeScene()`：只有活動的日子。
pub(super) fn life_scene(rng: &mut Rng) -> String {
    let pools: Vec<&'static str> = [ANIMALS, FOOD, PLANTS, &["cards", "mug", "camera"]].concat();
    day_scene(
        rng,
        &[
            "pot",
            "pot",
            "teapot",
            "bento",
            "watermelon",
            "icecream",
            "dango",
        ],
        &pools,
    )
}

/// 現行 `doodleStrip()`：日卡底部一排 `n` 個小圖案。
pub(super) fn doodle_strip(rng: &mut Rng, n: u32) -> String {
    let names = distinct(rng, SMALL, n as usize);
    let mut body = String::new();
    for (i, name) in names.iter().enumerate() {
        let r = rng.round(20.0, 10.0);
        body += &doodle(name, i as f64 * 40.0 + 2.0, 2.0, 0.66, r, "");
    }
    scene_svg(n * 40, 38, &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 參考值以 bun 執行 src/storybook/journal.js 的同名函式取得。

    #[test]
    fn hash_and_rng_match_the_javascript_functions() {
        assert_eq!(hash_str("a"), 3_826_002_220);
        assert_eq!(hash_str("露營|2026-10-20|0#head"), 577_161_634);
        assert_eq!(format!("{}", Rng::new(1).float()), "0.6270739405881613");
        assert_eq!(
            format!("{}", Rng::new(3_826_002_220).float()),
            "0.621685681398958"
        );
    }

    #[test]
    fn doodle_markup_matches_the_javascript_function() {
        assert_eq!(
            doodle("sun", 14.0, 2.0, 0.95, 0.0, "j-sun"),
            r##"<g class="j-sun"><g transform="translate(14 2) rotate(0 22.799999999999997 22.799999999999997) scale(0.95)"><g transform="translate(1.6 1.4)"><path d="M24 15a9 9 0 1 0 .1 0Z" fill="#F2C55B"/></g><path d="M24 15a9 9 0 1 0 .1 0ZM24 3v5M24 40v5M3 24h5M40 24h5M9 9l3.5 3.5M35.5 35.5 39 39M9 39l3.5-3.5M35.5 12.5 39 9" fill="none" stroke="currentColor" stroke-width="2.11" stroke-linecap="round" stroke-linejoin="round"/><circle cx="21" cy="23" r=".9" fill="currentColor"/><circle cx="27.5" cy="23" r=".9" fill="currentColor"/><path d="M22 27q2.5 2 5 0" fill="none" stroke="currentColor" stroke-width=".7" stroke-linecap="round"/></g></g>"##
        );
        assert_eq!(
            doodle("tent", 86.0, 14.0, 2.3, -2.5, ""),
            r##"<g transform="translate(86 14) rotate(-2.5 55.199999999999996 55.199999999999996) scale(2.3)"><g transform="translate(1.6 1.4)"><path d="M6 40 24 8l18 32Z" fill="#F2C97A"/><path d="M19 40l5-14 5 14Z" fill="#E59A6B"/></g><path d="M6 40 24 8l18 32ZM24 8 17 40M24 8l7 32M19 40l5-14 5 14M3 40h42" fill="none" stroke="currentColor" stroke-width="0.87" stroke-linecap="round" stroke-linejoin="round"/><circle cx="18" cy="30" r=".9" fill="currentColor"/><circle cx="30" cy="30" r=".9" fill="currentColor"/><path d="M21 33q3 2.4 6 0" fill="none" stroke="currentColor" stroke-width=".7" stroke-linecap="round"/></g>"##
        );
        assert_eq!(
            svg(icon_body("pencil")),
            r#"<svg class="" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m14 5 5 5M4 20l5-1L21 7l-5-5L4 14v6Z"/></svg>"#
        );
        assert_eq!(icon_body("nope"), icon_body("star"));
    }

    /// 每個場景的長度與 `hashStr()`，以同一個種子各自重新開始。
    #[test]
    fn scenes_match_the_javascript_functions() {
        let expected: &[(&str, &str, usize, u32)] = &[
            ("露營|2026-10-20|0#head", "head", 4460, 1207802321),
            ("露營|2026-10-20|0#head", "camp", 2364, 3384721636),
            ("露營|2026-10-20|0#head", "life", 2021, 3712180538),
            ("露營|2026-10-20|0#head", "strip5", 2068, 722171265),
            ("露營|2026-10-20|0#head", "strip4", 1721, 83001393),
            ("夕淞度日|2026-10-20|0#camp0", "head", 4546, 3899075804),
            ("夕淞度日|2026-10-20|0#camp0", "camp", 2417, 3704618124),
            ("夕淞度日|2026-10-20|0#camp0", "life", 2331, 2250516833),
            ("夕淞度日|2026-10-20|0#camp0", "strip5", 2301, 3558862471),
            ("夕淞度日|2026-10-20|0#camp0", "strip4", 1876, 3911260160),
            ("夕淞度日|2026-10-20|0#life1", "head", 4655, 1133663834),
            ("夕淞度日|2026-10-20|0#life1", "camp", 2118, 562342433),
            ("夕淞度日|2026-10-20|0#life1", "life", 1888, 690433942),
            ("夕淞度日|2026-10-20|0#life1", "strip5", 2583, 4263635406),
            ("夕淞度日|2026-10-20|0#life1", "strip4", 2170, 1371047979),
            ("夕淞度日|2026-10-20|3#strip2", "head", 4636, 1005463061),
            ("夕淞度日|2026-10-20|3#strip2", "camp", 2049, 3328771092),
            ("夕淞度日|2026-10-20|3#strip2", "life", 2102, 200213138),
            ("夕淞度日|2026-10-20|3#strip2", "strip5", 2709, 108553510),
            ("夕淞度日|2026-10-20|3#strip2", "strip4", 2171, 1227254851),
            ("a", "head", 4221, 3903217273),
            ("a", "camp", 2212, 1074674152),
            ("a", "life", 2292, 1894936363),
            ("a", "strip5", 2321, 2133185688),
            ("a", "strip4", 1813, 3689084899),
        ];
        for &(seed, scene, len, hash) in expected {
            let mut rng = Rng::new(hash_str(seed));
            let svg = match scene {
                "head" => header_scene(&mut rng),
                "camp" => camp_scene(&mut rng),
                "life" => life_scene(&mut rng),
                "strip5" => doodle_strip(&mut rng, 5),
                _ => doodle_strip(&mut rng, 4),
            };
            assert_eq!((svg.len(), hash_str(&svg)), (len, hash), "{seed} {scene}");
        }
    }
}
