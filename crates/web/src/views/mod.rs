//! Trip_Page 的分頁、Trip_Menu 與共用元件（design 4.1）。
//!
//! `forms` 是編輯表單的共用元件（任務 20.5）；`icons` 是介面圖示。五個分頁（`schedule`、`meals`、`shopping`、`gear`、
//! `ledger`）與 Trip_Menu（`trip_menu`）先各有自己的佔位檔，由任務 21 至 23 填入；它們以 `pages::trip::use_trip()`
//! 取得這趟旅行的同步引擎、每種列的 `RowStore` 與旅行頁的 `UiState`。`vehicle_form` 是 Schedule_Tab 與 Trip_Menu 共用的
//! 車輛清單與表單（任務 21.3）。`editors` 是每張卡片與每一列上的編輯者頭像（任務 24.2）。`studio` 是 Schedule_Tab 的
//! 旅行繪本工作室（rust-schedule-studio）。
pub mod editors;
pub mod forms;
pub mod gear;
pub mod icons;
pub mod ledger;
pub mod meals;
pub mod schedule;
pub mod shopping;
pub mod studio;
pub mod trip_menu;
pub mod vehicle_form;
