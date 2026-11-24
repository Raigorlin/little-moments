//! Schedule_Tab「行程表」（`?tab=schedule`，需求 22.1）：與 Bun 相同，整個分頁是旅行繪本工作室
//! （[`crate::views::studio::Studio`]）：左邊是「行程手帖」預覽，右邊是編輯器，兩者以可拖曳的分隔線隔開。
//!
//! 工作室取代了原本的「規劃行程」各區塊與「文字版」（rust-schedule-studio Decision D3）：料理以標示「餐點」的活動顯示，
//! 文字版改由手帖的「複製文字」複製，地點與車在編輯器的「地點與車」分頁。Trip_Page 把這個元件直接放在
//! `.workspace.story-schedule-layout` 中（Bun `scheduleTab()`），側欄在它之後，只在編輯器收起時顯示。
use leptos::prelude::*;

use crate::views::studio::Studio;

/// Schedule_Tab「行程表」。以 `pages::trip::use_trip()` 取得這趟旅行的內容。
#[component]
pub fn ScheduleTab() -> impl IntoView {
    view! { <Studio /> }
}
