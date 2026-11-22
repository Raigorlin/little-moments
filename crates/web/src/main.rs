//! lm-web：日子拾光的前端（Leptos 0.8 CSR，以 trunk 建成 wasm32-unknown-unknown）。
//!
//! 目前只掛載空白的 App；路由、畫面與同步引擎依 design「Components and Interfaces」4，由之後的任務加入。

use leptos::prelude::*;

/// 空白的 App。
#[component]
fn App() -> impl IntoView {}

fn main() {
    leptos::mount::mount_to_body(App);
}
