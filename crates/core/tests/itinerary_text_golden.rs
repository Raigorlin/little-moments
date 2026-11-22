//! 文字版的 golden 測試（需求 33.2）：範例旅行（`support::example_trip`，移植自 `tests/fixtures/example-trip.js` 的
//! `exampleTrip()`）的 Itinerary_Text 與 `tests/fixtures/example-itinerary.txt` 逐字相同。
//!
//! 預期文字檔依需求 31 逐行撰寫，不使用 `example-trip.js` 的 `EXAMPLE_TEXT`（trip-planning-workflow-enhance 舊文字
//! 產生器的格式，現行 App 已不顯示），也不是由 `itinerary_text()` 的輸出產生。它等於現行行程繪本「複製文字」對同一份
//! 資料複製的文字（`src/storybook/app.js` 的 `renderItinerary()` 與 `copyItinerary()`，資料由
//! `src/storybook-adapter.js` 的 `toStudio()` 整理），只多了第 1 天路線區塊的最後一行「預計 12:00 抵達夕淞度日營區」
//! （需求 31.8）：現行的抵達行是繪本的自由文字 `arrivalLabel`，範例沒有設定。範例的活動與料理都沒有備註，所以沒有
//! 需求 31.10 的備註行。
//!
//! 預期文字檔以 LF 分隔各行，最後一行之後沒有換行字元；同一個目錄的 `.gitattributes` 讓 git 不轉換 `.txt` 的行尾，
//! 所以 Windows 以 `core.autocrlf` 檢出時也得到相同的位元組。

mod support;

use lm_core::ingredients::{sync_meal_ingredients, SyncPlan};
use lm_core::itinerary_text::itinerary_text;

use support::example_trip::example_trip;
use support::ids::SeqIds;

/// 範例旅行的預期 Itinerary_Text。
const EXPECTED: &str = include_str!("fixtures/example-itinerary.txt");

#[test]
fn example_trip_text_matches_the_expected_file() {
    assert!(
        !EXPECTED.contains('\r'),
        "預期文字檔含有 CR：檢查 tests/fixtures/.gitattributes 是否讓檢出保持 LF"
    );
    assert!(
        !EXPECTED.ends_with('\n'),
        "預期文字檔的最後一行之後不能有換行字元"
    );
    assert_eq!(itinerary_text(&example_trip()), EXPECTED);
}

/// 移植的範例旅行與現行相同，已經執行過採買同步：s9–s18 正是料理需要、而手動品項沒有涵蓋的食材，所以再同步一次
/// 不改變狀態（`example-trip.js` 的說明）。
#[test]
fn example_trip_is_already_synced() {
    let plan = sync_meal_ingredients(&example_trip(), &mut SeqIds::new())
        .expect("範例旅行遠低於採買品項的上限");
    assert_eq!(plan, SyncPlan::default());
}
