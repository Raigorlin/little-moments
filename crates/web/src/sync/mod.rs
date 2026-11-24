//! 旅行頁的同步引擎（design 4.2、4.3）。
//!
//! `store` 是每列一個 signal 的 `RowStore` 與每種列一個 `RowStore` 的 `TripStores`（design 4.3、A12）；
//! `engine` 是 `TripSync`（design 4.2、A6）與 App 層以旅行 id 為鍵保存它們的 `TripSyncs`；
//! `sender` 是每個 `TripSync` 一個的送出佇列（design 4.2、4.6）；
//! `realtime` 是 Trip_Channel 的生命週期與補齊（design A7）；
//! `presence` 是誰正在編輯：其他分頁的 Presence_Meta、Editor_Stack 與這個分頁的回報（design 4.5、A11、A13）。
pub mod engine;
pub mod presence;
pub mod realtime;
pub mod sender;
pub mod store;
