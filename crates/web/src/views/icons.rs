//! Trip_Page 與各分頁的介面圖示（現行 `src/app.js` 的 `icon()` 與 `icons`）：固定的 SVG，不含使用者文字，
//! 以 `art::static_svg()` 放進畫面（需求 32.6）。
//!
//! `icon()` 的外框是 `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" …>`；
//! 這裡另加 `focusable="false"`，與 `pages/home.rs` 的圖示相同。

/// 以 `icons` 的一個項目組成 `icon()` 的 SVG。
macro_rules! icon {
    ($paths:literal) => {
        concat!(
            r#"<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">"#,
            $paths,
            "</svg>"
        )
    };
}

pub const MENU: &str = icon!(r#"<path d="M4 7h16M4 12h16M4 17h16"/>"#);
pub const PIN: &str = icon!(
    r#"<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>"#
);
pub const CALENDAR: &str = icon!(
    r#"<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 5h2m4 0h2"/>"#
);
pub const PEOPLE: &str = icon!(
    r#"<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m1-15a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2"/>"#
);
pub const ARROW: &str = icon!(r#"<path d="M4 12h15m-6-6 6 6-6 6"/>"#);
pub const LEAF: &str = icon!(r#"<path d="M20 3C8 1 1 8 5 16c8 6 17-2 15-13ZM3 21 15 9"/>"#);
pub const INFO: &str = icon!(r#"<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>"#);
pub const D_PIN: &str = icon!(
    r#"<path d="M12 21.2s-6.6-5.9-6.6-11a6.6 6.6 0 0 1 13.2 0c0 5.1-6.6 11-6.6 11z" style="fill:var(--coral)"/><circle cx="12" cy="10.1" r="2.4" style="fill:var(--paper)"/>"#
);
pub const D_BOOK: &str = icon!(
    r#"<path d="M3.6 5.8c3-1 5.7-.8 8.4 1.1 2.7-1.9 5.4-2.1 8.4-1.1v13c-3-1-5.7-.8-8.4 1.1-2.7-1.9-5.4-2.1-8.4-1.1z" style="fill:var(--yellow)"/><path d="M12 6.9v13"/>"#
);
pub const D_TENT: &str = icon!(
    r#"<path d="M12 3.8 2.8 19.6h18.4z" style="fill:var(--blue)"/><path d="M12 10.2 8.4 19.6h7.2z" style="fill:var(--coral)"/><path d="M1.8 20.6h20.4"/>"#
);
pub const D_PEOPLE: &str = icon!(
    r#"<circle cx="9" cy="8.4" r="3.2" style="fill:var(--peach)"/><path d="M3.4 20a5.6 5.6 0 0 1 11.2 0z" style="fill:var(--peach)"/><circle cx="17" cy="9.4" r="2.5" style="fill:var(--yellow)"/><path d="M15.8 14.6a4.6 4.6 0 0 1 4.8 5.4h-4.2" style="fill:none"/>"#
);
pub const D_CALENDAR: &str = icon!(
    r#"<path d="M8 3.2v3.6M16 3.2v3.6"/><path d="M3.6 9.2V8a3 3 0 0 1 3-3h10.8a3 3 0 0 1 3 3v1.2z" style="fill:var(--coral)"/><path d="M3.6 9.2h16.8v8.6a3 3 0 0 1-3 3H6.6a3 3 0 0 1-3-3z" style="fill:var(--paper)"/><circle cx="8.5" cy="13.6" r=".8" fill="currentColor"/><circle cx="12" cy="13.6" r=".8" fill="currentColor"/><circle cx="15.5" cy="13.6" r=".8" fill="currentColor"/><circle cx="8.5" cy="17" r=".8" fill="currentColor"/><circle cx="12" cy="17" r=".8" fill="currentColor"/>"#
);
pub const D_CUP: &str = icon!(
    r#"<path d="M8.4 3.2c-1.2 1.1 1.1 2.1-.1 3.3M12.2 2.8c-1.2 1.2 1.1 2.2-.1 3.6"/><path d="M16 10.2h1.3a2.6 2.6 0 0 1 0 5.2H16" style="fill:none"/><path d="M4.8 8.8h11.4v6.3a4.3 4.3 0 0 1-4.3 4.3H9.1a4.3 4.3 0 0 1-4.3-4.3z" style="fill:var(--yellow)"/><path d="M3.5 20.8h14.2"/>"#
);
pub const D_BAG: &str = icon!(
    r#"<path d="M8.8 10V7.2a3.2 3.2 0 0 1 6.4 0V10"/><path d="M5 8.6h14l-1 10.9a1.6 1.6 0 0 1-1.6 1.4H7.6A1.6 1.6 0 0 1 6 19.5z" style="fill:var(--green)"/><path d="M9.5 13.2c.6 1.4 1.6 2 2.5 2s1.9-.6 2.5-2" style="fill:none"/>"#
);
pub const D_DOWNLOAD: &str = icon!(
    r#"<path d="M4.4 14.2v3.6a2.6 2.6 0 0 0 2.6 2.6h10a2.6 2.6 0 0 0 2.6-2.6v-3.6z" style="fill:var(--blue)"/><path d="M12 3.4v10.4m-4-3.8 4 3.8 4-3.8" style="fill:none"/>"#
);
pub const SUN: &str = icon!(
    r#"<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>"#
);
pub const MOON: &str = icon!(r#"<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"/>"#);
pub const D_WALLET: &str = icon!(
    r#"<path d="M6 6.6 15.4 4l1 2.6" style="fill:none"/><rect x="3.4" y="6.6" width="17.2" height="13.4" rx="3" style="fill:var(--lavender)"/><circle cx="16.6" cy="13.4" r="1.7" style="fill:var(--paper)"/>"#
);

/// `mapLink()` 連結後的「另開分頁」小圖示。
pub const MAP_LINK: &str = r#"<svg class="map-link-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" focusable="false"><path d="M9 2h5v5M14 2 7 9M6 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3"/></svg>"#;
pub const PLUS: &str = icon!(r#"<path d="M12 5v14M5 12h14"/>"#);
pub const CAR: &str =
    icon!(r#"<path d="m4 10 2-6h12l2 6M3 10h18v8H3v-8Zm2 8v3m14-3v3M6 14h2m8 0h2"/>"#);
pub const EDIT: &str = icon!(r#"<path d="m14 5 5 5M4 20l5-1L21 7l-5-5L4 14v6Z"/>"#);
pub const CLOSE: &str = icon!(r#"<path d="m6 6 12 12M6 18 18 6"/>"#);
/// 現行 `icon('link')`（「複製邀請網址」）。
pub const LINK: &str = icon!(
    r#"<path d="m10 14 4-4m-6 6-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 10a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-2 2" transform="translate(1 0) scale(.9)"/>"#
);
pub const UP: &str = icon!(r#"<path d="M12 19V5m-6 6 6-6 6 6"/>"#);
pub const DOWN: &str = icon!(r#"<path d="M12 5v14m-6-6 6 6 6-6"/>"#);
pub const CHECK: &str = icon!(r#"<path d="m5 12 4 4L19 6"/>"#);
/// 把已買的採買品項移回清單（Bun 沒有這個圖示）。
pub const UNDO: &str = icon!(r#"<path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-4"/>"#);
