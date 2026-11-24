//! 行程表列的滑動操作（design 4）：從 Bun 版 `src/mobile-swipe.js` 移植。
//!
//! `physics` 是不碰 DOM 的手勢計算，`rows` 準備與還原 DOM 裡的列，`controller` 是事件、手勢狀態與收尾。
mod controller;
mod physics;
mod rows;

pub use controller::SwipeController;
