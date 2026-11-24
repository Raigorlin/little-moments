//! lm-web：日子拾光的前端（Leptos 0.8 CSR，以 trunk 建成 wasm32-unknown-unknown）。
//!
//! `app` 是 App 外框（路由、訊息頁與 Toast），`session` 是登入狀態，`api` 是同源 `/api/*` 的用戶端，`pages` 是需求 32.1 的各個畫面；
//! `sync` 是旅行頁的同步引擎（design 4.2、4.3）；`views` 是旅行頁的分頁、Trip_Menu 與編輯表單的共用元件（design 4.1）。
mod api;
mod app;
// 料理插圖與其他插畫由之後的畫面（任務 19 起）使用
#[allow(dead_code)]
mod art;
mod pages;
mod session;
mod swipe;
// 同步引擎由旅行頁（任務 20.2 起）使用
#[allow(dead_code)]
mod sync;
// 編輯表單的共用元件與圖示有一部分由之後的分頁（任務 21 起）使用
#[allow(dead_code)]
mod views;

fn main() {
    leptos::mount::mount_to_body(app::App);
}
