//! 屬性測試的共用產生器（design「Correctness Properties」的共用產生器，需求 33.5），以及範例測試共用的範例旅行。
//!
//! - [`state::arb_state()`]：滿足不變式 I1–I8、I10–I12 的 Trip_State。
//! - [`vocab`]：產生器使用的詞彙，以及食材文字 [`vocab::arb_ingredients()`] 與採買品項名稱
//!   [`vocab::arb_item_name()`]。
//! - [`ids`]：產生器的 id 配置，以及依序產生採買品項 id 的決定性 `IdSource`（[`ids::SeqIds`]）。
//! - [`example_trip::example_trip()`]：範例測試共用的範例旅行，移植自 `tests/fixtures/example-trip.js` 的
//!   `exampleTrip()`（需求 33.2）。
//!
//! 每個測試檔以 `mod support;` 引入，通常只用到其中一部分，所以整個模組允許沒有用到的項目。
//!
//! 屬性測試使用 proptest 的預設設定：256 個案例，設定環境變數 `PROPTEST_CASES=N` 時為 N 個；測試中不覆寫案例數。
//! proptest 把失敗的案例寫進回歸檔，之後每次執行都先重跑；回歸檔提交進版本庫，修正之後也不刪除（需求 33.6）。
//! 整合測試的目錄往上找不到 `lib.rs` 或 `main.rs`，所以 proptest 的預設 `SourceParallel("proptest-regressions")`
//! 改用 `WithSource`：`tests/prop_x.rs` 的回歸檔是同一個目錄中的 `tests/prop_x.proptest-regressions`。

#![allow(dead_code)]

pub mod example_trip;
pub mod ids;
pub mod state;
pub mod vocab;
