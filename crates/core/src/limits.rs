//! 所有數量與長度上限（Limits_Table 與 design「列舉與上限」）。
//!
//! 表中寫成「a–b」的項目是 `RangeInclusive`（例如 `TRIP_TITLE_CHARS.contains(&n)`，`*TRIP_TITLE_CHARS.end()`
//! 是上限），只有一個數字的項目是常數。名稱以 `_CHARS` 結尾的是文字長度，一律以 Char_Count（Unicode 碼位，
//! 與 PostgreSQL 的 `char_length()` 相同）計算正規化之後的文字；以 `_MAX` 結尾的是一趟旅行中同一種列的數量上限，
//! 剛好等於上限時仍然成立（需求 9.13）。

use std::ops::RangeInclusive;

// ── 旅行（Trip_Card）──

/// 旅行天數：開始日到結束日，含頭尾 1–31 天。
pub const TRIP_DAYS: RangeInclusive<usize> = 1..=31;
/// 旅行名稱 1–100 字。
pub const TRIP_TITLE_CHARS: RangeInclusive<usize> = 1..=100;
/// 目的地 0–100 字。
pub const TRIP_DESTINATION_CHARS: RangeInclusive<usize> = 0..=100;
/// 介紹 0–1000 字。
pub const TRIP_DESCRIPTION_CHARS: RangeInclusive<usize> = 0..=1000;
/// 小叮嚀 0–1000 字。
pub const TRIP_NOTE_CHARS: RangeInclusive<usize> = 0..=1000;
/// 繪本封面的大標題 0–80 字。
pub const STORYBOOK_HEADLINE_CHARS: RangeInclusive<usize> = 0..=80;
/// 繪本底部短語 0–150 字。
pub const STORYBOOK_CAPTION_CHARS: RangeInclusive<usize> = 0..=150;

// ── 旅伴 ──

/// 一趟旅行最多 100 位旅伴。
pub const PEOPLE_MAX: usize = 100;
/// 旅伴名字（Participant_Name 之後）1–30 字。
pub const PERSON_NAME_CHARS: RangeInclusive<usize> = 1..=30;
/// 小隊角色 0–60 字。
pub const PERSON_ROLE_CHARS: RangeInclusive<usize> = 0..=60;

// ── 地點 ──

/// 一趟旅行最多 100 個地點。
pub const PLACES_MAX: usize = 100;
/// 地點名稱 1–50 字。
pub const PLACE_NAME_CHARS: RangeInclusive<usize> = 1..=50;

// ── 車輛 ──

/// 車輛暱稱 1–50 字。
pub const VEHICLE_NAME_CHARS: RangeInclusive<usize> = 1..=50;
/// 座位數 1–9（含駕駛）。
pub const VEHICLE_SEATS: RangeInclusive<u8> = 1..=9;

// ── 路線與每日設定 ──

/// 每台車在每個 Trip_Day 最多 1 條路線。
pub const ROUTES_PER_VEHICLE_PER_DAY: usize = 1;
/// 每條路線 0–6 個停靠點。
pub const ROUTE_STOPS: RangeInclusive<usize> = 0..=6;
/// 停靠點備註 0–100 字。
pub const STOP_NOTE_CHARS: RangeInclusive<usize> = 0..=100;
/// 採買以外的停靠點，待辦清單或旅伴名單最多 8 項。
pub const STOP_ITEMS_MAX: usize = 8;
/// 停靠點清單的每一項 1–100 字。
pub const STOP_ITEM_CHARS: RangeInclusive<usize> = 1..=100;
/// 每日設定的標題 0–20 字。
pub const DAY_TITLE_CHARS: RangeInclusive<usize> = 0..=20;
/// 每日設定的抵達說明 0–120 字。
pub const ARRIVAL_LABEL_CHARS: RangeInclusive<usize> = 0..=120;

// ── 活動 ──

/// 一趟旅行最多 1000 筆活動。
pub const ACTIVITIES_MAX: usize = 1000;
/// 活動標題 1–100 字。
pub const ACTIVITY_TITLE_CHARS: RangeInclusive<usize> = 1..=100;
/// 活動地點 0–150 字。
pub const ACTIVITY_LOCATION_CHARS: RangeInclusive<usize> = 0..=150;
/// 活動備註 0–1000 字。
pub const ACTIVITY_NOTE_CHARS: RangeInclusive<usize> = 0..=1000;

// ── 料理 ──

/// 一趟旅行最多 1000 道料理。
pub const MEALS_MAX: usize = 1000;
/// 份數 1–100。
pub const MEAL_SERVINGS: RangeInclusive<u8> = 1..=100;
/// 料理名稱 0–100 字。
pub const MEAL_TITLE_CHARS: RangeInclusive<usize> = 0..=100;
/// 食材文字 0–2000 字。
pub const MEAL_INGREDIENTS_CHARS: RangeInclusive<usize> = 0..=2000;
/// 食材文字經 Ingredient_Parser 切出的每個食材名稱 1–100 字（需求 25.18）。
pub const INGREDIENT_NAME_CHARS: RangeInclusive<usize> = 1..=100;
/// 料理筆記 0–1000 字。
pub const MEAL_NOTES_CHARS: RangeInclusive<usize> = 0..=1000;

// ── 採買品項 ──

/// 一趟旅行最多 1000 項採買品項，包括採買同步新增的 Meal_Item。
pub const SHOPPING_ITEMS_MAX: usize = 1000;
/// 品項名稱 1–100 字。
pub const SHOPPING_NAME_CHARS: RangeInclusive<usize> = 1..=100;
/// 數量與單位 0–40 字。
pub const SHOPPING_QUANTITY_CHARS: RangeInclusive<usize> = 0..=40;
/// 修改既有品項時，數量與單位 1–40 字（需求 26.5）。
pub const SHOPPING_QUANTITY_EDIT_CHARS: RangeInclusive<usize> = 1..=40;

// ── 裝備 ──

/// 一趟旅行最多 1000 項裝備。
pub const GEAR_ITEMS_MAX: usize = 1000;
/// 裝備名稱 1–100 字。
pub const GEAR_NAME_CHARS: RangeInclusive<usize> = 1..=100;
/// 數量與單位 0–40 字。
pub const GEAR_QUANTITY_CHARS: RangeInclusive<usize> = 0..=40;

// ── 支出與還款 ──

/// 一趟旅行最多 1000 筆支出。
pub const EXPENSES_MAX: usize = 1000;
/// 一趟旅行最多 1000 筆還款。
pub const SETTLEMENTS_MAX: usize = 1000;
/// 支出與還款的金額，以分計：NT$0.01–1,000,000。
pub const AMOUNT_CENTS: RangeInclusive<i64> = 1..=100_000_000;
/// 支出的項目名稱 1–100 字。
pub const EXPENSE_TITLE_CHARS: RangeInclusive<usize> = 1..=100;
/// 支出與還款的備註 0–500 字。
pub const LEDGER_NOTE_CHARS: RangeInclusive<usize> = 0..=500;
/// 每筆支出的分攤旅伴 1–100 位。
pub const EXPENSE_PARTICIPANTS: RangeInclusive<usize> = 1..=100;

// ── 邀請連結 ──

/// 邀請連結在建立 7 天後到期（Database 的 `make_interval(days => …)`；與日期的天數同為 `i64`）。
pub const INVITE_TTL_DAYS: i64 = 7;
/// 每趟旅行最多 20 個 Active_Invite。
pub const TRIP_ACTIVE_INVITES_MAX: usize = 20;
/// 每位 Collaborator 自己建立的 Active_Invite 最多 5 個。
pub const COLLABORATOR_ACTIVE_INVITES_MAX: usize = 5;

// ── 帳號 ──

/// 帳號名稱 3–32 個字元。
pub const USERNAME_CHARS: RangeInclusive<usize> = 3..=32;
/// 顯示名稱（Display_Name）1–30 個字元。
pub const DISPLAY_NAME_CHARS: RangeInclusive<usize> = 1..=30;
/// 密碼 12–72 個字元。
pub const PASSWORD_CHARS: RangeInclusive<usize> = 12..=72;
/// 密碼的 UTF-8 編碼最多 72 位元組。
pub const PASSWORD_MAX_BYTES: usize = 72;

// ── 編輯者頭像 ──

/// 每張卡片或每一列最多顯示 3 個編輯者頭像，其餘以「+N」表示。
pub const EDITOR_AVATARS_SHOWN: usize = 3;
/// 編輯者頭像的色盤有 12 色。
pub const AVATAR_PALETTE_COLORS: usize = 12;
