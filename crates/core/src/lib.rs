//! lm-core：日子拾光 / LITTLE MOMENTS 的共用規則，由 lm-server 與 lm-web 共用。
//!
//! 型別、命令、權限、`apply()`、採買同步、文字版、分帳、同步模型、Presence 與編輯者頭像，以及帳號欄位的規則。
//! 只做純計算：不使用網路、檔案、系統時間與執行緒，需要目前時間或新 id 的計算由呼叫端傳入，
//! 同一份輸入在原生目標與 `wasm32-unknown-unknown` 上得到相同的結果（需求 1.3、1.4）。
//! 各模組的內容依 design「Components and Interfaces」1.1，由之後的任務填入；`account` 是註冊與登入的欄位規則，
//! 由 LM_Server 與 LM_Web 的註冊表單共用（需求 3.14）。

pub mod account;
pub mod api;
pub mod apply;
pub mod command;
pub mod dates;
pub mod ids;
pub mod ingredients;
pub mod itinerary;
pub mod itinerary_text;
pub mod ledger;
pub mod limits;
pub mod model;
pub mod presence;
pub mod recipes;
pub mod rules;
pub mod storybook;
pub mod sync;
pub mod text;
pub mod time;
pub mod validate;
