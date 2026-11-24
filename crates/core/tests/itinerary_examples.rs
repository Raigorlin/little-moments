//! 行程推導的範例測試（需求 33.1）：活動類別與常用活動、料理的用餐時間與標題、Hidden_Control_Char、旅行目的地的
//! 衝突、Shopping_Plan 與 Place_Usage。
//!
//! 移植 Bun_App 測試中以固定輸入斷言第一版規則的案例：輸入與原案例相同，預期值與原案例相同並直接寫在測試中，也就是
//! Bun_App 對同一輸入的結果。每個測試上方的註解標明來源的測試檔與測試名稱，`describe` 之內的測試寫成
//! 「describe › test」。只移植一部分斷言的測試，在測試上方與下面的清單說明不移植的部分。
//!
//! - `tests/itinerary-model.test.js`：15 個測試移植 12 個，其中 5 個只移植一部分；`hasControlChars()` 的 20 組字串
//!   全部移植。
//! - `tests/itinerary-derive.test.js`：17 個測試移植 6 個，其中 4 個只移植 Shopping_Plan 的斷言。需求 33.1 把這個檔案
//!   列為 Shopping_Plan 的來源；同一檔的 `placeUsages()` 兩個測試斷言的 Place_Usage 也是第一版的規則（需求 21.4，
//!   `place_usages()` 回傳與現行相同的 `{ n, label }`），所以一併移植。
//! - `tests/itinerary-shopping.test.js`：2 個測試移植 1 個（只移植 Shopping_Plan 的斷言）；另一個是屬性測試。
//! - `tests/itinerary-place-name.test.js`：4 個測試都是屬性測試，每個輸入都由產生器隨機組成，沒有可以移植的固定輸入
//!   （需求 33.1）。為了讓地點名稱的每一條規則都有範例，本檔另以該檔的字元表、測試名稱與註解寫出的輸入寫成範例，
//!   預期值是 Bun_App 的 `placeKey()` 與 `placeNameError()` 對同一輸入的結果。這些範例不算移植的案例。
//!
//! 現行的資料寫成第一版的列：
//!
//! - 範例旅行是 `support::example_trip`（現行 `exampleTrip()`），陣列的順序是 Ordinal，現行的字串 id 依編號對應
//!   UUID：旅伴 p{n}、車輛 v{n}、採買品項 s{n} 是 `id(Tag::…, n)`；地點 pl-a、pl-c、pl-shop、pl-taipei 是 1、3、5、6
//!   （`PL_*`）；路線 rt-{天}-v{k} 是 `route_id(天, k)`；停靠點 st-{n} 是 `id(Tag::Stop, n)`。測試加入的列：旅伴 p9、
//!   地點 pl-hsinchu（7）與 pl-yilan（8）接著編號，停靠點 st-0 是 0x10（`ST_0`），路線 rt-x 與停靠點 st-x 是 0x100。
//! - 現行以 `push()` 加入的列取得當時最大的 Ordinal 加 1，排在最後；`unshift()` 的停靠點插在路線的最前面；
//!   `state.routes.reverse()` 把路線的 Ordinal 反過來（`reverse_routes()`）。
//! - `DESTINATION_REF` 是 `PlaceRef::Destination`；採買品項的 `assignee: ''` 是 `None`（待分配）；沒有 `note` 的停靠點
//!   是空的備註，停靠點都沒有任務與時間。
//! - `shoppingPlan()` 的 `buyerCar`、`firstStop` 與 `unassigned` 是 `ShoppingPlan` 的同名欄位；`stopItems.get(id)` 是
//!   `stop_items(id)`（第一版只為 First_Shopping_Stop 保存品項清單，所以現行 `stopItems` 的鍵是 `first_stop` 的停靠點）；
//!   `locationOf.get(id)` 是 `stop_of(id)` 的天數、地點名稱與車名（`location_of()`）。
//! - `expect(isValidState(state)).toBe(true)` 改為 `assert_valid_itinerary()`。
//!
//! 不移植的案例與原因：
//!
//! - `tests/itinerary-model.test.js` 的 `活動類別` › `Example_Trip 的活動以類別名稱出現在 Example_Text`，以及
//!   `餐點的 Meal_Time、標題與 Meal_Label` › `前言 Example_Trip 的五筆餐點` 中與 Example_Text 比較的斷言：
//!   `EXAMPLE_TEXT` 是 trip-planning-workflow-enhance 舊文字產生器的格式，現行 App 已不顯示（需求 33.2）。第一版的
//!   Itinerary_Text 由 `itinerary_text_golden.rs` 比對。
//! - `餐點的 Meal_Time、標題與 Meal_Label` › `mealLabel()：套用料理範本時依範本的類型，否則依料理名稱與食材判斷`，以及
//!   `前言 Example_Trip 的五筆餐點` 中 Meal_Label 的斷言：Meal_Label 是行程圖（`dayModel()` 的料理項目）與舊文字產生器
//!   的料理標籤，第一版沒有行程圖；文字版的料理類別依需求 31.11（現行行程繪本的 `mealKind()`，`meal_category()`），
//!   規則不同，例如晚餐「週末小聚」的 Meal_Label 是「晚餐」，第一版的類別是「用餐」。
//! - `餐點的 Meal_Time、標題與 Meal_Label` › `mealTitle() 與 mealLabel()：舊資料的餐次照原文字顯示`，以及
//!   `mealTime()：有自訂時間時用它，否則依餐次預設；舊餐次比照料理菜單的排序，其他舊餐次為 12:00` 中舊餐次
//!   （早、午、晚、宵夜、點心、早午餐）的斷言：第一版的餐次是只有五個值的 `MealSlot`，沒有舊的餐次名稱（需求 33.1）。
//! - `活動類別` › `categoryLabel() 以表中的類別名稱顯示每種類型，Legacy_Activity_Type 也改用這些名稱` 中
//!   `categoryLabel(undefined)` 的斷言，以及 `常用活動` › `每種日子的建議類別都不重複；其他日子種類沒有建議` 中「其他
//!   日子種類」（`''`、`'other'`、`'toString'`、`undefined`）的斷言：第一版的活動類別與日子種類是 `ActivityKind` 與
//!   `DayKind` 列舉，沒有 `undefined`，也無法表示其他日子種類。其他不在表中的字串以 `ActivityKind::parse()` 移植。
//! - `destinationConflict()` › `其他情況為 null` 中 `seed()` 與 `emptyState()` 的斷言：斷言本功能之前、沒有 `places`
//!   與 `routes` 欄位的舊資料格式；第一版的 Trip_State 一定有這些集合，也不匯入現行的資料。沒有路線的情況由同一個測試
//!   的 `withRoutes(state, [])` 移植。
//! - `tests/itinerary-derive.test.js` 的 `Example_Trip` › `三天的 Day_Caption 與第 3 天的「地點：」行（需求 11.2、11.3）`、
//!   `路線區塊的終點組（需求 11.5、11.6、12.10、14.12）` › `Example_Trip 每個路線區塊都只有一個終點組` 與
//!   `Last_Day 第一車往台北、第二車往新竹、第三車往台北：依序得到台北與新竹兩組`：斷言行程圖的 `dayModel()`（Day_Caption、
//!   標題、「地點：」行、路線區塊、終點組、抵達與返程行）與 `endGroups()`，第一版沒有行程圖。
//! - `Example_Trip` › `每一天都沒有 Planning_Warning`、`Planning_Warning 的範例（需求 9.1、9.2、9.5）` ›
//!   `需求 9.1：刪除第 1 天第四車的路線後，第 1 天提醒「第四車這一天還沒有路線」` 與
//!   `需求 9.2：第四車 12:30 出發，晚於預計抵達 12:00`，以及同一個 describe 另外兩個測試中 `planningWarnings()` 的
//!   斷言：第一版沒有規劃提醒。`需求 9.5、9.6：…` 的第二步（第四車也加上採買停靠點）只斷言規劃提醒，也不移植。
//! - `Example_Trip` › `placeRouteCounts()：夕淞度日營區 8 條、台北 4 條、超市／賣場 1 條路線（需求 3.2）` 與
//!   `placeRouteCounts()：同一條路線只計一次，Day_Settings 不計入，沒有路線使用的地點為 0`：第一版的「地點與車」只列出
//!   地點名稱（需求 21.5），沒有每個地點的路線數。
//! - `firstDayDeparture()：Trip_Menu 車輛卡片的第 1 天出發（需求 3.8）` 的三個測試
//!   （`有第 1 天的路線時為 route：出發時間與起點名稱`、`沒有第 1 天的路線但有舊的出發資料時為 legacy：seed() 的山線小巴`、
//!   `兩者都沒有時為 none（「第 1 天還沒有路線」）`）：第一版的車輛卡片不顯示第 1 天的出發（需求 20.8），也沒有舊的出發
//!   欄位 `meeting`。
//! - `Example_Trip` › `八個採買品項都在第三車・採買組的 First_Shopping_Stop（需求 6.9、6.11）` 與
//!   `需求 6.11 的「待分配」範例` › `把鮮蝦的「誰負責買」改為待分配後，鮮蝦改屬未分配採買清單，原因為「待分配」` 中
//!   行程圖停靠點（`dayModel()` 的路線行）與 `shoppingSummary()` 的斷言：Shopping_Summary 是行程圖的停靠點摘要，第一版
//!   沒有行程圖；文字版的採買品項依需求 31.7 列出，由 Itinerary_Text 的測試涵蓋。
//! - `tests/itinerary-shopping.test.js` 的 `Property 9: 採買推導的分割與摘要` ›
//!   `參考實作重現需求 6.9 至 6.11 的範例，且與 shoppingPlan() 相同` 中 Shopping_Summary（`summaryOf()` 與行程圖停靠點的
//!   摘要）的斷言，以及只斷言它的變化「名稱的寫法」：原因同上；這個變化的品項名稱 `'\n'` 在第一版也不是有效的名稱
//!   （需求 26.2）。
//! - `Property 9: 採買推導的分割與摘要` ›
//!   `起始狀態與每個操作之後：每個品項恰好在一個 First_Shopping_Stop 或未分配採買清單，原因、位置與摘要依規則，推導不改變輸入`：
//!   輸入都是隨機產生的（屬性測試）。
//! - `tests/itinerary-place-name.test.js` 的 `Property 15: 地點名稱的同名比較與錯誤原因` ›
//!   `全形與半形寫法、A 到 Z 的大小寫與前後空白不改變 placeKey()`、`placeKey() 重複套用不改變結果`、
//!   `含 U+3000 與 U+FF01–U+FFEE 以外的相容字元時，與其 NFKC 結果不同名` 與
//!   `placeNameError() 依空白、超過 50 字、含控制字元、同名的順序回傳第一個原因，都符合時為 null`：輸入都是隨機產生的
//!   （屬性測試）。現行 `placeNameError()` 的 `pending`（Draft 中還沒儲存的新地點）是規劃編輯器的參數；第一版以命令逐一
//!   新增地點，`place_name_error()` 沒有這個參數，所以本檔的範例不使用它。

mod support;

use std::collections::{BTreeMap, BTreeSet, HashSet};

use lm_core::ids::{PersonId, PlaceId, RouteId, ShoppingId, StopId, VehicleId};
use lm_core::itinerary::{
    destination_conflict, meal_time, meal_title, place_name, place_name_error, place_usages,
    presets_for, shopping_plan, DayKind, DestinationConflict, PlaceNameError, PlaceUsage,
    ShoppingPlan, UnassignedCode, UnassignedShopping, ACTIVITY_CATEGORIES,
};
use lm_core::limits::{DAY_TITLE_CHARS, PLACES_MAX, ROUTE_STOPS, STOP_NOTE_CHARS};
use lm_core::model::{
    ActivityKind, Color, Date, DaySetting, ItemSource, Meal, MealSlot, Person, Place, PlaceRef,
    Route, Row, Stop, StopKind, TripState,
};
use lm_core::text::{char_count, has_control_chars, participant_name, place_key, trim_white};
use lm_core::time::{date_range, Hm};
use unicode_normalization::UnicodeNormalization;

use support::example_trip::example_trip;
use support::ids::{id, Tag};

// ── 活動類別與常用活動（tests/itinerary-model.test.js）──

/// 前言「活動類別」表，依表的順序：（類別名稱, 活動列儲存的值）。前六個沿用現行的 Legacy_Activity_Type，後七個是
/// trip-planning-workflow-enhance 新增的值。
const CATEGORY_TABLE: [(&str, &str); 13] = [
    ("集合", "meet"),
    ("採買", "market"),
    ("營地時光", "camp"),
    ("用餐", "meal"),
    ("夜晚", "night"),
    ("移動", "travel"),
    ("起床", "wake"),
    ("搭帳", "pitch"),
    ("自由活動", "free"),
    ("下午茶／遊戲", "tea"),
    ("拆帳", "strike"),
    ("清潔", "clean"),
    ("返程", "return"),
];

/// 來源：`tests/itinerary-model.test.js` 的 `活動類別` › `依前言「活動類別」表的順序列出 13 個類別與標籤`。
/// 現行的 `ACTIVITY_TYPES` 是 `ActivityKind::ALL` 的字串。
#[test]
fn activity_categories_follow_the_table_order() {
    let categories: Vec<(&str, &str)> = ACTIVITY_CATEGORIES
        .iter()
        .map(|&(kind, label)| (label, kind.as_str()))
        .collect();
    assert_eq!(categories, CATEGORY_TABLE);
    let types: Vec<&str> = ActivityKind::ALL.iter().map(ActivityKind::as_str).collect();
    assert_eq!(types, CATEGORY_TABLE.map(|(_, kind)| kind));
    // 類別名稱與儲存的值都不重複，一個名稱只對應一個值
    let labels: HashSet<&str> = ACTIVITY_CATEGORIES
        .iter()
        .map(|&(_, label)| label)
        .collect();
    assert_eq!(labels.len(), 13);
    assert_eq!(types.iter().collect::<HashSet<_>>().len(), 13);
}

/// 來源：`tests/itinerary-model.test.js` 的 `活動類別` ›
/// `categoryLabel() 以表中的類別名稱顯示每種類型，Legacy_Activity_Type 也改用這些名稱`。現行的 `categoryLabel(type)`
/// 是第一版的 `ActivityKind::parse(type)` 加 `ActivityKind::label()`：不在表中的值無法成為 `ActivityKind`，所以沒有
/// 類別名稱（現行是空字串）。`categoryLabel(undefined)` 不移植（見檔頭）。
#[test]
fn every_activity_type_shows_its_category_name() {
    let label = |text: &str| ActivityKind::parse(text).map(ActivityKind::label);
    for (name, kind) in CATEGORY_TABLE {
        assert_eq!(label(kind), Some(name), "{kind}");
    }
    // 需求 7.9：meet、market、camp、meal、night、travel 依序顯示為集合、採買、營地時光、用餐、夜晚、移動
    assert_eq!(
        ["meet", "market", "camp", "meal", "night", "travel"].map(label),
        ["集合", "採買", "營地時光", "用餐", "夜晚", "移動"].map(Some)
    );
    // 不在表中的類型只會出現在無效的 Trip_State，沒有標籤
    for text in ["", "party", "Wake", "起床", "toString"] {
        assert_eq!(label(text), None, "{text:?}");
    }
}

/// 前言「常用活動」表：（預設時間, 預設標題, 類別名稱）。
type PresetRow = (&'static str, &'static str, &'static str);

const FIRST_DAY: [PresetRow; 2] = [
    ("13:00", "搭帳・營地佈置", "搭帳"),
    ("20:00", "星空夜聊・自由活動", "夜晚"),
];
const MIDDLE_DAY: [PresetRow; 4] = [
    ("08:00", "起床", "起床"),
    ("10:00", "自由活動、拍照", "自由活動"),
    ("14:00", "下午茶、聊天、玩遊戲", "下午茶／遊戲"),
    ("20:00", "自由活動", "夜晚"),
];
const LAST_DAY: [PresetRow; 4] = [
    ("08:00", "起床", "起床"),
    ("10:00", "拆帳、整理裝備", "拆帳"),
    ("11:30", "環境清潔、裝車", "清潔"),
    ("12:00", "集合、返程", "返程"),
];

/// 現行測試的 `asTable(presetsFor(kind))`：每個常用活動寫成表的欄位，以類別名稱比較。
fn preset_table(kind: DayKind) -> Vec<(String, &'static str, &'static str)> {
    presets_for(kind)
        .into_iter()
        .map(|preset| (preset.time.to_string(), preset.title, preset.kind.label()))
        .collect()
}

/// `table` 寫成 `preset_table()` 的形式。
fn rows(table: &[PresetRow]) -> Vec<(String, &'static str, &'static str)> {
    table
        .iter()
        .map(|&(time, title, label)| (time.to_owned(), title, label))
        .collect()
}

/// 來源：`tests/itinerary-model.test.js` 的 `常用活動` › `First_Day、中間的日子與 Last_Day 各自的建議`。
#[test]
fn first_middle_and_last_days_have_their_own_presets() {
    assert_eq!(preset_table(DayKind::First), rows(&FIRST_DAY));
    assert_eq!(preset_table(DayKind::Middle), rows(&MIDDLE_DAY));
    assert_eq!(preset_table(DayKind::Last), rows(&LAST_DAY));
}

/// 來源：`tests/itinerary-model.test.js` 的 `常用活動` ›
/// `一日遊同時列出 First_Day 與 Last_Day 的項目，依預設時間由早到晚排列`。
#[test]
fn a_one_day_trip_lists_first_and_last_day_presets_by_time() {
    // 兩者的建議沒有相同的類別，所以六項都保留
    assert_eq!(
        preset_table(DayKind::Single),
        rows(&[
            ("08:00", "起床", "起床"),
            ("10:00", "拆帳、整理裝備", "拆帳"),
            ("11:30", "環境清潔、裝車", "清潔"),
            ("12:00", "集合、返程", "返程"),
            ("13:00", "搭帳・營地佈置", "搭帳"),
            ("20:00", "星空夜聊・自由活動", "夜晚"),
        ])
    );
}

/// 來源：`tests/itinerary-model.test.js` 的 `常用活動` › `每種日子的建議類別都不重複；其他日子種類沒有建議`。
/// 只移植前一半；「其他日子種類」不移植（見檔頭）。
#[test]
fn each_day_kind_suggests_each_category_once() {
    for kind in [
        DayKind::First,
        DayKind::Middle,
        DayKind::Last,
        DayKind::Single,
    ] {
        let kinds: Vec<ActivityKind> = presets_for(kind).iter().map(|preset| preset.kind).collect();
        let distinct: HashSet<ActivityKind> = kinds.iter().copied().collect();
        assert_eq!(distinct.len(), kinds.len(), "{kind:?}");
    }
}

// ── 料理的用餐時間與標題（tests/itinerary-model.test.js）──

/// 來源：`tests/itinerary-model.test.js` 的 `餐點的 Meal_Time、標題與 Meal_Label` › `前言 Example_Trip 的五筆餐點`。
/// 只移植 Meal_Time 與標題；Meal_Label 與 Example_Text 的斷言不移植（見檔頭）。料理依 Ordinal，也就是現行陣列的順序。
#[test]
fn example_trip_meals_have_their_meal_time_and_title() {
    let state = example_trip();
    let meals: Vec<(String, String)> = state
        .meals_by_ordinal()
        .map(|meal| (meal_time(meal).to_string(), meal_title(meal)))
        .collect();
    let expected = [
        ("18:00", "晚餐：烤肉派對"),
        ("08:30", "早餐"),
        ("12:00", "午餐"),
        ("18:00", "晚餐：豪華火鍋"),
        ("08:30", "早餐"),
    ]
    .map(|(time, title)| (time.to_owned(), title.to_owned()));
    assert_eq!(meals, expected);
}

/// 來源：`tests/itinerary-model.test.js` 的 `餐點的 Meal_Time、標題與 Meal_Label` ›
/// `mealTime()：有自訂時間時用它，否則依餐次預設；舊餐次比照料理菜單的排序，其他舊餐次為 12:00`。只移植五種餐次與晚餐
/// 的自訂時間；舊餐次的斷言不移植（見檔頭）。原測試的料理名稱與餐次相同（`meal(slot, slot, extra)`）。
#[test]
fn meal_time_is_the_set_time_or_the_slot_default() {
    let time_of =
        |slot: &str, time: Option<Hm>| meal_time(&test_meal(slot, slot, time)).to_string();
    let defaults = ["早餐", "午餐", "下午茶", "晚餐", "消夜"].map(|slot| time_of(slot, None));
    assert_eq!(defaults, ["08:30", "12:00", "15:00", "18:00", "21:00"]);
    assert_eq!(time_of("晚餐", Some(at(19, 30))), "19:30");
}

// ── Hidden_Control_Char（tests/itinerary-model.test.js）──

/// 現行測試的 `CASES`：（說明, 名字, 是否含 Hidden_Control_Char）。只有 Participant_Name 不會改變的字串，所以不必先
/// 正規化（下一個測試確認）。看不見的字元以碼位寫出，❤ 是 U+2764、🏽 是 U+1F3FD。
const CONTROL_CASES: [(&str, &str, bool); 20] = [
    ("一般文字", "小安", false),
    ("半形空白", "Camp 小隊", false),
    ("emoji 與變體選擇符", "小安\u{2764}\u{fe0f}", false),
    (
        "連接兩個 emoji 的零寬連接符",
        "👨\u{200d}👩\u{200d}👧",
        false,
    ),
    ("變體選擇符之後的零寬連接符", "🏳\u{fe0f}\u{200d}🌈", false),
    ("膚色修飾符之後的零寬連接符", "👩\u{1f3fd}\u{200d}💻", false),
    ("BEL（U+0007）", "小\u{7}安", true),
    ("NEL（U+0085，不是 JS 的 \\s）", "小\u{85}安", true),
    ("零寬空白（U+200B）", "小\u{200b}安", true),
    ("軟連字號（U+00AD）", "小\u{ad}安", true),
    ("左至右標記（U+200E）", "小\u{200e}安", true),
    ("右至左覆寫（U+202E）", "小\u{202e}安", true),
    ("方向隔離（U+2066、U+2069）", "\u{2066}小安\u{2069}", true),
    ("字連接符（U+2060）", "小\u{2060}安", true),
    ("文字之間的零寬連接符", "小\u{200d}安", true),
    ("零寬連接符後面不是 emoji", "👨\u{200d}安", true),
    ("零寬連接符前面不是 emoji", "安\u{200d}👩", true),
    ("兩個連續的零寬連接符", "👨\u{200d}\u{200d}👩", true),
    ("結尾的零寬連接符", "👨\u{200d}", true),
    (
        "標籤字元（英格蘭旗）",
        "🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}",
        true,
    ),
];

/// 來源：`tests/itinerary-model.test.js` 的 `hasControlChars() 與 addParticipant() 的控制字元判斷` ›
/// `addParticipant() 的正規化不改變這組字串`。現行的 `normalizeParticipantName()` 是 `participant_name()`。
#[test]
fn participant_name_does_not_change_the_control_char_cases() {
    let changed: Vec<&str> = CONTROL_CASES
        .iter()
        .filter(|&&(_, name, _)| participant_name(name) != name)
        .map(|&(label, _, _)| label)
        .collect();
    assert_eq!(changed, Vec::<&str>::new());
}

/// 來源：`tests/itinerary-model.test.js` 的 `hasControlChars() 與 addParticipant() 的控制字元判斷` ›
/// `兩者對每個字串的判斷相同，且只有連接兩個 emoji 的零寬連接符不算控制字元`。現行的 `addParticipant()` 在第一版是
/// AddPerson（任務 8.7，本檔撰寫時還沒有實作）；它依需求 19.3 以 `has_control_chars()` 檢查 Participant_Name 之後的
/// 名字，所以這裡以同一個條件寫出「新增旅伴時因控制字元被拒絕」。
#[test]
fn only_a_joiner_between_two_emoji_is_not_a_control_char() {
    let verdicts: Vec<(&str, bool, bool)> = CONTROL_CASES
        .iter()
        .map(|&(label, name, _)| {
            let person = has_control_chars(&participant_name(name));
            (label, has_control_chars(name), person)
        })
        .collect();
    let disagree: Vec<&str> = verdicts
        .iter()
        .filter(|&&(_, model, person)| model != person)
        .map(|&(label, _, _)| label)
        .collect();
    assert_eq!(disagree, Vec::<&str>::new());
    let model: Vec<(&str, bool)> = verdicts
        .iter()
        .map(|&(label, model, _)| (label, model))
        .collect();
    let expected: Vec<(&str, bool)> = CONTROL_CASES
        .iter()
        .map(|&(label, _, control)| (label, control))
        .collect();
    assert_eq!(model, expected);
}

// ── 旅行目的地的衝突（tests/itinerary-model.test.js）──

/// 來源：`tests/itinerary-model.test.js` 的 `destinationConflict()` ›
/// `與地點同名時為 duplicate，name 是地點清單中的名稱`。
#[test]
fn a_destination_named_like_a_place_is_a_duplicate() {
    let state = example_trip();
    let before = state.clone();
    assert_eq!(
        destination_conflict(&state, "台北"),
        Some(duplicate("台北"))
    );
    // 需求 2.1(d)：去除前後空白，全形與半形視為相同（「／」與「/」、全形空白與半形空白），並忽略英文大小寫
    assert_eq!(
        destination_conflict(&state, "超市/賣場"),
        Some(duplicate("超市／賣場"))
    );
    assert_eq!(
        destination_conflict(&state, "\u{3000}出發地點\u{3000}ａ "),
        Some(duplicate("出發地點 A"))
    );
    assert_eq!(state, before);
}

/// 來源：`tests/itinerary-model.test.js` 的 `destinationConflict()` ›
/// `改成空白而仍有路線的起點、終點或停靠點使用旅行目的地時為 in-use`。
#[test]
fn a_blank_destination_still_used_by_routes_is_in_use() {
    let state = example_trip();
    assert_eq!(
        destination_conflict(&state, ""),
        Some(DestinationConflict::InUse)
    );
    // 只有空白也是空白
    assert_eq!(
        destination_conflict(&state, " \u{3000}"),
        Some(DestinationConflict::InUse)
    );
    // 第 1 天：終點是旅行目的地；第 3 天：起點是旅行目的地
    let to_destination = routes_on(&state, day(1));
    let from_destination = routes_on(&state, day(3));
    let stop_at_destination = vec![Route {
        stops: vec![new_stop(ST_X, PlaceRef::Destination, StopKind::Gear, "")],
        ..route_x(1, PL_A, None)
    }];
    for routes in [to_destination, from_destination, stop_at_destination] {
        assert_eq!(
            destination_conflict(&with_routes(&state, routes), ""),
            Some(DestinationConflict::InUse)
        );
    }
}

/// 來源：`tests/itinerary-model.test.js` 的 `destinationConflict()` › `其他情況為 null`。`seed()` 與 `emptyState()` 的
/// 斷言不移植（見檔頭）。
#[test]
fn other_destinations_have_no_conflict() {
    let state = example_trip();
    // 目的地不變
    assert_eq!(destination_conflict(&state, "夕淞度日營區"), None);
    assert_eq!(destination_conflict(&state, "山中營地"), None);
    // 路線與停靠點只用地點清單中的地點；Day_Location 未設定的日子跟著旅行目的地，不在檢查範圍
    let places_only = vec![Route {
        stops: vec![new_stop(ST_X, place_ref(PL_SHOP), StopKind::Shop, "")],
        ..route_x(3, PL_C, Some(at(9, 0)))
    }];
    assert_eq!(
        destination_conflict(&with_routes(&state, places_only), ""),
        None
    );
    assert_eq!(
        destination_conflict(&with_routes(&state, Vec::new()), ""),
        None
    );
}

/// `DestinationConflict::Duplicate`：與地點清單中名稱為 `name` 的地點同名。
fn duplicate(name: &str) -> DestinationConflict {
    DestinationConflict::Duplicate {
        name: name.to_owned(),
    }
}

// ── Shopping_Plan（tests/itinerary-derive.test.js 與 tests/itinerary-shopping.test.js）──

/// 範例旅行的 8 個手動品項 s1–s8（s1–s3 由第三車・採買組的駕駛小雨負責，s4–s8 由乘客大海負責）。
const MANUAL: [u64; 8] = [1, 2, 3, 4, 5, 6, 7, 8];
/// s1–s8 的名稱。
const MANUAL_NAMES: [&str; 8] = [
    "五花肉片",
    "鮮蝦",
    "高麗菜",
    "運動飲料",
    "洋芋片",
    "瓦斯",
    "衛生紙",
    "免洗餐具",
];
/// 料理食材同步加入的 10 個品項 s9–s18（「誰負責買」為待分配）。
const INGREDIENT: [u64; 10] = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18];

/// 來源：`tests/itinerary-derive.test.js` 的 `Example_Trip` ›
/// `八個採買品項都在第三車・採買組的 First_Shopping_Stop（需求 6.9、6.11）`。行程圖停靠點與 Shopping_Summary 的斷言
/// 不移植（見檔頭）。
#[test]
fn example_trip_items_go_to_the_first_shopping_stop_of_their_car() {
    let state = example_trip();
    let plan = plan_of(&state);
    // 小雨與大海的 Buyer_Car 都是第三車・採買組
    assert_eq!(
        [3, 6].map(|n| plan.buyer_car.get(&person_id(n)).copied()),
        [Some(vehicle_id(3)); 2]
    );
    // 只有第三車・採買組有採買停靠點：第 1 天路線上的超市／賣場
    assert_eq!(
        plan.first_stop.keys().copied().collect::<Vec<_>>(),
        [vehicle_id(3)]
    );
    let first = plan.first_stop[&vehicle_id(3)];
    assert_eq!(
        (first.route, first.stop, first.n),
        (route_id(1, 3), stop_id(ST_1), 1)
    );
    let stops: Vec<StopId> = stop_lists(&state, &plan)
        .into_iter()
        .map(|(stop, _)| stop)
        .collect();
    assert_eq!(stops, [stop_id(ST_1)]);
    // 依採買清單的順序
    let items: Vec<(ShoppingId, &str)> = plan
        .stop_items(first.stop)
        .iter()
        .map(|item| (*item, state.shopping[item].name.as_str()))
        .collect();
    assert_eq!(
        items,
        MANUAL
            .map(item_id)
            .into_iter()
            .zip(MANUAL_NAMES)
            .collect::<Vec<_>>()
    );
    // 採買清單分頁的「第 1 天在超市／賣場（第三車・採買組）」
    assert_eq!(
        locations(&state, &plan),
        MANUAL.map(|n| (item_id(n), (1, "超市／賣場", "第三車・採買組")))
    );
    // 料理食材同步加入的品項是待分配，列在未分配採買清單
    let unassigned: Vec<_> = plan
        .unassigned
        .iter()
        .map(|entry| {
            (
                entry.item,
                state.shopping[&entry.item].source,
                entry.code,
                entry.reason.as_str(),
            )
        })
        .collect();
    assert_eq!(
        unassigned,
        INGREDIENT.map(|n| (
            item_id(n),
            ItemSource::Meal,
            UnassignedCode::Unassigned,
            "待分配"
        ))
    );
}

/// 來源：`tests/itinerary-derive.test.js` 的 `Planning_Warning 的範例（需求 9.1、9.2、9.5）` ›
/// `需求 9.5：八個品項都改由小安負責後，第 1 天提醒第三車・採買組的採買沒有品項，不提醒第一車`。只移植 Shopping_Plan
/// 的斷言；規劃提醒不移植（見檔頭）。
#[test]
fn items_of_a_buyer_whose_car_has_no_shopping_stop_are_unassigned() {
    let mut state = example_trip();
    for n in MANUAL {
        set_assignee(&mut state, n, Some(1));
    }
    assert_valid_itinerary(&state);
    let plan = plan_of(&state);
    // 小安的 Buyer_Car 是第一車，第一車沒有採買停靠點：這八項只在未分配採買清單說明原因（D30）
    assert_eq!(stop_lists(&state, &plan), [(stop_id(ST_1), Vec::new())]);
    let expected = [
        MANUAL
            .map(|n| (item_id(n), UnassignedCode::NoStop, "第一車還沒有採買停靠點"))
            .to_vec(),
        INGREDIENT
            .map(|n| (item_id(n), UnassignedCode::Unassigned, "待分配"))
            .to_vec(),
    ]
    .concat();
    assert_eq!(unassigned_rows(&plan), expected);
}

/// 來源：`tests/itinerary-derive.test.js` 的 `Planning_Warning 的範例（需求 9.1、9.2、9.5）` ›
/// `需求 9.5、9.6：不是第一個的採買停靠點只標示採買；沒有品項的第一個採買停靠點`。只移植第一步（第 3 天也有採買
/// 停靠點）中 Shopping_Plan 的斷言；規劃提醒與只斷言規劃提醒的第二步不移植（見檔頭）。
#[test]
fn a_later_shopping_stop_of_the_same_car_is_not_its_first() {
    let mut state = example_trip();
    let shop = new_stop(ST_3, place_ref(PL_SHOP), StopKind::Shop, "");
    route_mut(&mut state, route_id(3, 3)).stops.push(shop);
    assert_valid_itinerary(&state);
    let plan = plan_of(&state);
    // 品項仍列在第 1 天的超市／賣場
    assert_eq!(plan.first_stop[&vehicle_id(3)].stop, stop_id(ST_1));
    let stops: Vec<StopId> = stop_lists(&state, &plan)
        .into_iter()
        .map(|(stop, _)| stop)
        .collect();
    assert_eq!(stops, [stop_id(ST_1)]);
}

/// 來源：`tests/itinerary-derive.test.js` 的 `需求 6.11 的「待分配」範例` ›
/// `把鮮蝦的「誰負責買」改為待分配後，鮮蝦改屬未分配採買清單，原因為「待分配」`。行程圖停靠點的 Shopping_Summary 不移植
/// （見檔頭）。
#[test]
fn an_item_changed_to_unassigned_moves_to_unassigned_shopping() {
    let mut state = example_trip();
    set_assignee(&mut state, 2, None);
    assert_valid_itinerary(&state);
    let before = state.clone();
    let plan = plan_of(&state);
    let names: Vec<&str> = plan
        .stop_items(stop_id(ST_1))
        .iter()
        .map(|item| state.shopping[item].name.as_str())
        .collect();
    assert_eq!(
        names,
        MANUAL_NAMES
            .into_iter()
            .filter(|&name| name != "鮮蝦")
            .collect::<Vec<_>>()
    );
    // 未分配採買清單依採買清單的順序
    let ids: Vec<ShoppingId> = plan.unassigned.iter().map(|entry| entry.item).collect();
    assert_eq!(
        ids,
        [vec![item_id(2)], INGREDIENT.map(item_id).to_vec()].concat()
    );
    assert_eq!(
        plan.unassigned[0],
        UnassignedShopping {
            item: item_id(2),
            code: UnassignedCode::Unassigned,
            reason: "待分配".to_owned(),
        }
    );
    assert_eq!(location_of(&state, &plan, item_id(2)), None);
    // 推導不改變 Trip_State 與採買品項
    assert_eq!(state, before);
}

/// 來源：`tests/itinerary-shopping.test.js` 的 `Property 9: 採買推導的分割與摘要` ›
/// `參考實作重現需求 6.9 至 6.11 的範例，且與 shoppingPlan() 相同`。原測試以 Example_Trip 的變化確認該檔的參考實作
/// `expectedPlan()` 與 `shoppingPlan()` 相同（`checkState()`），再斷言參考實作的結果；這裡直接斷言 `shopping_plan()`
/// 的結果，`checkState()` 中第一版也有的檢查（通過驗證、每個品項恰好出現一次、重複推導的結果相同）由 `variant()` 進行。
/// Shopping_Summary 的斷言與只斷言它的變化「名稱的寫法」不移植（見檔頭）。
#[test]
fn shopping_plan_examples_of_requirements_6_9_to_6_11() {
    // Example_Trip：八個品項都在第 1 天第三車・採買組在超市／賣場的 Stop_Items（需求 6.11），料理食材都是待分配
    let (state, plan) = variant(|_| {});
    assert_eq!(stop_lists(&state, &plan), [(stop_id(ST_1), items(&MANUAL))]);
    assert_eq!(manual_reasons(&state, &plan), Vec::new());
    assert_eq!(
        plan.unassigned.len(),
        example_trip().shopping.len() - MANUAL.len()
    );
    let buyers: Vec<(PersonId, VehicleId)> = state
        .people_by_ordinal()
        .filter_map(|person| Some((person.id, *plan.buyer_car.get(&person.id)?)))
        .collect();
    let expected = [
        (1, 1),
        (2, 1),
        (3, 3),
        (4, 2),
        (5, 2),
        (6, 3),
        (7, 4),
        (8, 4),
    ];
    assert_eq!(
        buyers,
        expected.map(|(person, car)| (person_id(person), vehicle_id(car)))
    );
    // 需求 6.10 的範例
    assert_eq!(
        MANUAL.map(|n| location_of(&state, &plan, item_id(n))),
        [Some((1, "超市／賣場", "第三車・採買組")); 8]
    );

    // 需求 6.11：其中一項的「誰負責買」改為待分配
    let (state, plan) = variant(|s| set_assignee(s, 1, None));
    assert_eq!(
        stop_lists(&state, &plan),
        [(stop_id(ST_1), items(&MANUAL[1..]))]
    );
    assert_eq!(
        manual_reasons(&state, &plan),
        [(item_id(1), UnassignedCode::Unassigned, "待分配")]
    );
    // 需求 23.2 與 D30：八個品項都改給小安；第一車沒有採買停靠點，超市／賣場的 Stop_Items 是空的
    let (state, plan) = variant(|s| {
        for n in MANUAL {
            set_assignee(s, n, Some(1));
        }
    });
    assert_eq!(stop_lists(&state, &plan), [(stop_id(ST_1), Vec::new())]);
    assert_eq!(
        manual_reasons(&state, &plan),
        MANUAL.map(|n| (item_id(n), UnassignedCode::NoStop, "第一車還沒有採買停靠點"))
    );

    // 需求 6.11 (b)：負責人不在任何車上
    let (state, plan) = variant(|s| {
        push_person(s, 9, "阿明", Color::Green, "");
        set_assignee(s, 4, Some(9));
    });
    assert_eq!(
        manual_reasons(&state, &plan),
        [(item_id(4), UnassignedCode::NoCar, "阿明不在任何車上")]
    );
    assert!(!plan.buyer_car.contains_key(&person_id(9)));

    // D29：小雨也是第一車的乘客，她負責的三項算在排在前面的第一車（沒有採買停靠點）
    let (state, plan) = variant(|s| {
        let first_car = s.vehicles.get_mut(&vehicle_id(1)).expect("第一車");
        first_car.passengers.insert(person_id(3));
    });
    assert_eq!(plan.buyer_car.get(&person_id(3)), Some(&vehicle_id(1)));
    assert_eq!(
        stop_lists(&state, &plan),
        [(stop_id(ST_1), items(&MANUAL[3..]))]
    );
    let first_car = MANUAL[..3]
        .iter()
        .map(|&n| (item_id(n), UnassignedCode::NoStop, "第一車還沒有採買停靠點"))
        .collect::<Vec<_>>();
    assert_eq!(manual_reasons(&state, &plan), first_car);

    // D28：第 3 天也有 Shopping_Stop 時，品項仍列在第 1 天
    let (state, plan) = variant(|s| {
        let shop = new_stop(ST_3, place_ref(PL_SHOP), StopKind::Shop, "");
        route_mut(s, route_id(3, 3)).stops.push(shop);
    });
    assert_eq!(stop_lists(&state, &plan), [(stop_id(ST_1), items(&MANUAL))]);
    // 同一條路線在前面加 Shopping_Stop 時改列在新的那一個
    let (state, plan) = variant(|s| {
        let shop = new_stop(ST_0, place_ref(PL_A), StopKind::Shop, "");
        route_mut(s, route_id(1, 3)).stops.insert(0, shop);
    });
    assert_eq!(stop_lists(&state, &plan), [(stop_id(ST_0), items(&MANUAL))]);
    assert_eq!(
        location_of(&state, &plan, item_id(1)),
        Some((1, "出發地點 A", "第三車・採買組"))
    );

    // D28：只有第 3 天有 Shopping_Stop（在旅行目的地）
    let (state, plan) = variant(|s| {
        route_mut(s, route_id(1, 3)).stops.clear();
        let shop = new_stop(ST_3, PlaceRef::Destination, StopKind::Shop, "");
        route_mut(s, route_id(3, 3)).stops.push(shop);
    });
    assert_eq!(stop_lists(&state, &plan), [(stop_id(ST_3), items(&MANUAL))]);
    assert_eq!(
        location_of(&state, &plan, item_id(8)),
        Some((3, "夕淞度日營區", "第三車・採買組"))
    );
    // 第 1 天的途中任務改成接送時，第三車・採買組沒有採買停靠點
    let (state, plan) = variant(|s| route_mut(s, route_id(1, 3)).stops[0].kind = StopKind::Pickup);
    assert_eq!(stop_lists(&state, &plan), Vec::new());
    assert_eq!(
        manual_reasons(&state, &plan),
        MANUAL.map(|n| (
            item_id(n),
            UnassignedCode::NoStop,
            "第三車・採買組還沒有採買停靠點"
        ))
    );
}

// ── Place_Usage（tests/itinerary-derive.test.js）──

/// 來源：`tests/itinerary-derive.test.js` 的 `placeUsages()：地點的使用處（需求 2.7）` ›
/// `Example_Trip：依天數列出起點、終點或途中任務使用該地點的車`。
#[test]
fn example_trip_place_usages_list_the_cars_by_day() {
    let state = example_trip();
    assert_eq!(place_usages(&state, place_id(PL_A)), [usage(1, "第一車")]);
    assert_eq!(
        place_usages(&state, place_id(PL_SHOP)),
        [usage(1, "第三車・採買組")]
    );
    assert_eq!(
        place_usages(&state, place_id(PL_TAIPEI)),
        ["第一車", "第二車", "第三車・採買組", "第四車"].map(|label| usage(3, label))
    );
}

/// 來源：`tests/itinerary-derive.test.js` 的 `placeUsages()：地點的使用處（需求 2.7）` ›
/// `同一天先列「這一天的地點」，再依車輛順序列出車名，同一天同一台車只列一次`。現行的 `state.daySettings[i]` 是第
/// i + 1 天的每日設定（`day_setting_mut()`）。
#[test]
fn place_usages_list_the_day_place_first_then_each_car_once_per_day() {
    let mut state = example_trip();
    push_place(&mut state, PL_HSINCHU, "新竹");
    push_place(&mut state, PL_YILAN, "宜蘭");
    // 第 1 天：第二車途中到台北接人
    let pickup = new_stop(ST_2, place_ref(PL_TAIPEI), StopKind::Pickup, "");
    route_mut(&mut state, route_id(1, 2)).stops.push(pickup);
    // 第 2 天的地點設為新竹
    day_setting_mut(&mut state, 2).place = Some(place_id(PL_HSINCHU));
    // 第 3 天的地點設為台北；第四車先在台北還裝備，再回到台北
    day_setting_mut(&mut state, 3).place = Some(place_id(PL_TAIPEI));
    let gear = new_stop(ST_3, place_ref(PL_TAIPEI), StopKind::Gear, "還帳篷");
    route_mut(&mut state, route_id(3, 4)).stops.push(gear);
    // 路線的排列順序與天數、車輛順序相反時，結果仍依天數與車輛順序
    reverse_routes(&mut state);
    assert_valid_itinerary(&state);
    assert_eq!(
        place_usages(&state, place_id(PL_TAIPEI)),
        [
            usage(1, "第二車"),
            usage(3, "這一天的地點"),
            usage(3, "第一車"),
            usage(3, "第二車"),
            usage(3, "第三車・採買組"),
            usage(3, "第四車"),
        ]
    );
    assert_eq!(
        place_usages(&state, place_id(PL_HSINCHU)),
        [usage(2, "這一天的地點")]
    );
    // 沒有使用處時為空清單
    assert_eq!(place_usages(&state, place_id(PL_YILAN)), Vec::new());
}

/// 現行 `placeUsages()` 的一項 `{ n, label }`。
fn usage(n: usize, label: &str) -> PlaceUsage {
    PlaceUsage {
        n,
        label: label.to_owned(),
    }
}

// ── 地點名稱（tests/itinerary-place-name.test.js 的範例，不算移植的案例）──

/// 範例取自 `tests/itinerary-place-name.test.js` 的測試
/// `全形與半形寫法、A 到 Z 的大小寫與前後空白不改變 placeKey()`：同一個名稱的 ASCII 字元與空白換成全形或半形、字母換
/// 大小寫，並加上該檔 `WHITE` 中的前後空白（含 U+0085 與 U+2028）。該檔另外註明的例外：Place_Key 先做 NFC 再把 A 到
/// Z 轉成小寫，所以 A 加 U+0301 成為「Á」、a 加 U+0301 成為「á」，兩者不同名。
#[test]
fn place_key_ignores_width_ascii_case_and_surrounding_white_space() {
    for name in [
        "Taipei 101",
        "ＴＡＩＰＥＩ\u{3000}１０１",
        "  taipei 101\u{3000}",
        "\u{85}TaIpEi\u{3000}101\u{2028}",
    ] {
        assert_eq!(place_key(name), "taipei 101", "{name:?}");
    }
    assert_eq!(place_key("A\u{301}"), "\u{c1}");
    assert_eq!(place_key("a\u{301}"), "\u{e1}");
}

/// 範例取自同一檔的測試 `placeKey() 重複套用不改變結果`：以該檔 `DENSE` 中經全形半形摺疊、NFC 與轉小寫會互相影響的
/// 字元組成的名稱。依現行 `placeKey()` 的註解，「J」加 U+030C 要轉成小寫之後才組合成「ǰ」，開頭的 U+FFE3 摺疊後是
/// 半形空格加 U+0304；U+212A（KELVIN SIGN）經 NFC 是「K」。
#[test]
fn place_key_does_not_change_when_applied_again() {
    for (name, key) in [
        ("J\u{30c}", "\u{1f0}"),
        ("ｊ\u{30c}", "\u{1f0}"),
        ("\u{ffe3}a", "\u{304}a"),
        ("\u{212a}", "k"),
        ("Ａ\u{301}", "\u{c1}"),
    ] {
        assert_eq!(place_key(name), key, "{name:?}");
        assert_eq!(place_key(key), key, "{key:?}");
    }
}

/// 範例取自同一檔的測試 `含 U+3000 與 U+FF01–U+FFEE 以外的相容字元時，與其 NFKC 結果不同名`：該檔 `COMPAT` 的 20 個
/// 相容字元各自作為名稱，與它整串 NFKC 的結果不同名，所以地點清單或旅行目的地已有那個結果時也不是同名，例如「①」
/// 不因已有「1」而被判為同名。
#[test]
fn compatibility_characters_are_not_the_same_name_as_their_nfkc() {
    let compat = [
        "①", "⑩", "²", "₂", "½", "ﬁ", "Ⅳ", "ⅳ", "ſ", "µ", "ª", "™", "℃", "㎏", "㍻", "㈱", "…",
        "ǅ", "ĳ", "№",
    ];
    for name in compat {
        let folded: String = name.nfkc().collect();
        assert_ne!(place_key(name), place_key(&folded), "{name}");
        // 地點清單中已有名稱為 NFKC 結果的地點（旅行目的地是空白）
        let mut with_place = trip_with_destination("");
        push_place(&mut with_place, 1, &folded);
        assert_eq!(place_name_error(&with_place, name, None), None, "{name}");
        // 旅行目的地是 NFKC 結果
        let with_destination = trip_with_destination(&folded);
        assert_eq!(
            place_name_error(&with_destination, name, None),
            None,
            "{name}"
        );
    }
}

/// 範例取自同一檔的測試
/// `placeNameError() 依空白、超過 50 字、含控制字元、同名的順序回傳第一個原因，都符合時為 null`：以範例旅行的地點清單與
/// 旅行目的地為比較對象，產生器 `edgeName` 的 50 字上下（「地」「Ａ」「😀」重複 49 到 51 次，😀 是一個字）、每一種
/// 原因與它們的先後、改名時不與自己比較（`exceptId`，包括不存在的 id），以及該檔 `MESSAGES` 的四則訊息。
#[test]
fn place_name_errors_come_in_the_order_of_requirement_21_1() {
    use PlaceNameError::{ControlChars, Duplicate, Empty, TooLong};
    let state = example_trip();
    let cases = [
        (String::new(), None, Some(Empty)),
        (" \u{3000}\n".to_owned(), None, Some(Empty)),
        ("地".repeat(50), None, None),
        ("地".repeat(51), None, Some(TooLong)),
        ("Ａ".repeat(51), None, Some(TooLong)),
        ("😀".repeat(50), None, None),
        ("😀".repeat(51), None, Some(TooLong)),
        // 超過 50 字先於控制字元
        (
            format!("台\u{200b}{}", "地".repeat(50)),
            None,
            Some(TooLong),
        ),
        // 控制字元先於同名；U+200B 不是 White_Space，不會被去除
        ("台\u{200b}北".to_owned(), None, Some(ControlChars)),
        ("台北\u{200b}".to_owned(), None, Some(ControlChars)),
        // 前後的 Tab 與換行是 White_Space，先去除再檢查控制字元
        ("\t台北\n".to_owned(), None, Some(Duplicate)),
        ("台北".to_owned(), None, Some(Duplicate)),
        ("超市/賣場".to_owned(), None, Some(Duplicate)),
        (
            "\u{3000}出發地點\u{3000}ａ".to_owned(),
            None,
            Some(Duplicate),
        ),
        // 與非空白的旅行目的地同名
        ("夕淞度日營區".to_owned(), None, Some(Duplicate)),
        ("新竹".to_owned(), None, None),
        // 改名時不與這個地點自己比較；其他地點或不存在的 id 仍會比較
        ("台北".to_owned(), Some(PL_TAIPEI), None),
        ("台北".to_owned(), Some(PL_A), Some(Duplicate)),
        ("台北".to_owned(), Some(MISSING_PLACE), Some(Duplicate)),
    ];
    for (name, except, expected) in cases {
        assert_eq!(
            place_name_error(&state, &name, except.map(place_id)),
            expected,
            "{name:?}，除了 {except:?}"
        );
    }
    assert_eq!(Empty.to_string(), "請填寫地點名稱。");
    assert_eq!(TooLong.to_string(), "地點名稱最多 50 個字。");
    assert_eq!(
        ControlChars.to_string(),
        "地點名稱不能包含換行、Tab 或隱藏的控制字元。"
    );
    assert_eq!(Duplicate.to_string(), "已有同名地點");
}

// ── 範例旅行的 id ──

/// 範例旅行的地點：pl-a（出發地點 A）、pl-c（出發地點 C）、pl-shop（超市／賣場）與 pl-taipei（台北）。
const PL_A: u64 = 1;
const PL_C: u64 = 3;
const PL_SHOP: u64 = 5;
const PL_TAIPEI: u64 = 6;
/// 測試加入的地點 pl-hsinchu（新竹）與 pl-yilan（宜蘭）。
const PL_HSINCHU: u64 = 7;
const PL_YILAN: u64 = 8;
/// 不在地點清單中的地點 id（現行的 `'p-missing'`）。
const MISSING_PLACE: u64 = 0x100;
/// 範例旅行唯一的停靠點 st-1（第三車・採買組在超市／賣場採買），以及測試加入的 st-2、st-3、st-0 與 st-x。
const ST_1: u64 = 1;
const ST_2: u64 = 2;
const ST_3: u64 = 3;
const ST_0: u64 = 0x10;
const ST_X: u64 = 0x100;
/// 測試直接寫入的路線 rt-x。
const RT_X: u64 = 0x100;

/// 第 n 位旅伴（現行的 p{n}）。
fn person_id(n: u64) -> PersonId {
    id(Tag::Person, n)
}

/// 第 n 台車（v{n}）：第一車、第二車、第三車・採買組、第四車。
fn vehicle_id(n: u64) -> VehicleId {
    id(Tag::Vehicle, n)
}

fn place_id(n: u64) -> PlaceId {
    id(Tag::Place, n)
}

fn place_ref(n: u64) -> PlaceRef {
    PlaceRef::Place(place_id(n))
}

/// 範例旅行第 `on` 天第 `vehicle` 台車的路線（現行的 rt-{on}-v{vehicle}）：第 1 天是 1–4，第 3 天是 5–8。
fn route_id(on: u64, vehicle: u64) -> RouteId {
    let n = match on {
        1 => vehicle,
        3 => 4 + vehicle,
        _ => panic!("範例旅行只有第 1 天與第 3 天有路線"),
    };
    id(Tag::Route, n)
}

fn stop_id(n: u64) -> StopId {
    id(Tag::Stop, n)
}

/// 第 n 個採買品項（s{n}）。
fn item_id(n: u64) -> ShoppingId {
    id(Tag::Shopping, n)
}

/// 第 `numbers` 個採買品項，依序。
fn items(numbers: &[u64]) -> Vec<ShoppingId> {
    numbers.iter().copied().map(item_id).collect()
}

/// 範例旅行的第 n 天（1–3）：2026-10-20 是第 1 天。
fn day(n: u32) -> Date {
    Date::from_ymd_opt(2026, 10, 19 + n).expect("有效的日期")
}

fn at(hour: u8, minute: u8) -> Hm {
    Hm::new(hour, minute).expect("有效的時刻")
}

// ── 修改範例旅行 ──

/// 現行測試的 `meal(slot, title, extra)`：2026-10-20 的 4 人份料理，沒有負責人、食材、筆記與插圖種類；`extra` 只有
/// 用餐時間 `time`。`slot` 是餐次的中文名稱。
fn test_meal(slot: &str, title: &str, time: Option<Hm>) -> Meal {
    Meal {
        id: id(Tag::Meal, 0x100),
        day: day(1),
        slot: MealSlot::parse(slot).unwrap_or_else(|| panic!("「{slot}」是餐次")),
        time,
        title: title.to_owned(),
        cook: None,
        servings: 4,
        ingredients: String::new(),
        notes: String::new(),
        dish: None,
        ordinal: 1,
        version: 1,
    }
}

/// 現行的停靠點 `{ id, place, kind, note }`：沒有任務與時間。
fn new_stop(n: u64, place: PlaceRef, kind: StopKind, note: &str) -> Stop {
    Stop {
        id: stop_id(n),
        place,
        kind,
        task: None,
        note: note.to_owned(),
        time: None,
        items: Vec::new(),
    }
}

/// 現行測試的路線 rt-x：第 1 天第 `vehicle` 台車從地點 `from` 開往台北，還沒有停靠點；它是 `withRoutes()` 唯一的路線，
/// 所以 Ordinal 是 1。
fn route_x(vehicle: u64, from: u64, depart: Option<Hm>) -> Route {
    Route {
        id: id(Tag::Route, RT_X),
        day: day(1),
        vehicle: vehicle_id(vehicle),
        from: place_ref(from),
        to: place_ref(PL_TAIPEI),
        depart,
        stops: Vec::new(),
        ordinal: 1,
        version: 1,
    }
}

/// 現行測試的 `routeOf(state, id)`：可以修改的路線。
fn route_mut(state: &mut TripState, route: RouteId) -> &mut Route {
    state.routes.get_mut(&route).expect("範例旅行的路線")
}

/// 現行測試的 `state.daySettings[n - 1]`：第 n 天的每日設定（範例旅行三天都有）。
fn day_setting_mut(state: &mut TripState, n: u32) -> &mut DaySetting {
    state
        .day_settings
        .get_mut(&day(n))
        .expect("範例旅行每一天都有每日設定")
}

/// 現行測試的 `state.routes.filter(route => route.date === on)`：這一天的路線，依 Ordinal。
fn routes_on(state: &TripState, on: Date) -> Vec<Route> {
    state
        .routes_by_ordinal()
        .filter(|route| route.day == on)
        .cloned()
        .collect()
}

/// 現行測試的 `withRoutes(state, routes)`：路線換成 `routes` 的 Trip_State，其他資料不變。
fn with_routes(state: &TripState, routes: Vec<Route>) -> TripState {
    let mut next = state.clone();
    next.routes = routes.into_iter().map(|route| (route.id, route)).collect();
    next
}

/// 現行的 `state.routes.reverse()`：把路線的 Ordinal 反過來，使依 Ordinal 走訪的順序與原本相反。
fn reverse_routes(state: &mut TripState) {
    let order: Vec<RouteId> = state.routes_by_ordinal().map(|route| route.id).collect();
    for (ordinal, route) in (1..).zip(order.iter().rev()) {
        route_mut(state, *route).ordinal = ordinal;
    }
}

/// 現行的 `state.places.push({ id, name })`：Ordinal 是當時最大的 Ordinal 加 1，排在最後。
fn push_place(state: &mut TripState, n: u64, name: &str) {
    let ordinal = state.max_ordinal() + 1;
    state.put(Row::Place(Place {
        id: place_id(n),
        name: name.to_owned(),
        ordinal,
        version: 1,
        template: None,
    }));
}

/// 現行的 `state.people.push({ id, name, color, role })`：沒有綁定帳號的旅伴，排在最後。
fn push_person(state: &mut TripState, n: u64, name: &str, color: Color, role: &str) {
    let ordinal = state.max_ordinal() + 1;
    state.put(Row::Person(Person {
        id: person_id(n),
        name: name.to_owned(),
        role: role.to_owned(),
        color,
        bound: false,
        ordinal,
        version: 1,
    }));
}

/// 把第 `item` 個採買品項的「誰負責買」改為第 `person` 位旅伴；`None` 是待分配（現行的 `assignee = ''`）。
fn set_assignee(state: &mut TripState, item: u64, person: Option<u64>) {
    let row = state
        .shopping
        .get_mut(&item_id(item))
        .expect("範例旅行的採買品項");
    row.assignee = person.map(person_id);
}

/// 只有範例旅行的 Trip_Card、旅行目的地改為 `destination` 的旅行：比照地點名稱的屬性測試，只有指定的比較對象。
fn trip_with_destination(destination: &str) -> TripState {
    let mut state = TripState::new(example_trip().card);
    state.card.destination = destination.to_owned();
    state
}

// ── Shopping_Plan 的檢查 ──

/// 現行的 `shoppingPlan(state)`，加上原測試 `checkState()` 中第一版也有的兩項檢查：每個採買品項恰好出現一次，在一個
/// First_Shopping_Stop 的品項或 Unassigned_Shopping 中（分割），而且同一個 Trip_State 與它的複本推導的結果相同。
/// `shopping_plan()` 只借用 Trip_State，所以推導不會修改它。
fn plan_of(state: &TripState) -> ShoppingPlan {
    let plan = shopping_plan(state);
    let mut placements: BTreeMap<ShoppingId, usize> = BTreeMap::new();
    let at_stops = plan
        .first_stop
        .values()
        .flat_map(|first| plan.stop_items(first.stop).iter().copied());
    for item in at_stops.chain(plan.unassigned.iter().map(|entry| entry.item)) {
        *placements.entry(item).or_default() += 1;
    }
    let once: BTreeMap<ShoppingId, usize> = state.shopping.keys().map(|&item| (item, 1)).collect();
    assert_eq!(placements, once, "每個採買品項恰好出現一次");
    assert_eq!(
        shopping_plan(&state.clone()),
        plan,
        "同一個 Trip_State 的推導結果相同"
    );
    plan
}

/// 現行測試的 `variant(label, change)`：範例旅行套用 `change` 之後的 Trip_State（通過驗證）與它的 Shopping_Plan。
fn variant(change: impl FnOnce(&mut TripState)) -> (TripState, ShoppingPlan) {
    let mut state = example_trip();
    change(&mut state);
    assert_valid_itinerary(&state);
    let plan = plan_of(&state);
    (state, plan)
}

/// 現行測試的 `stopIds(want)`：每個 First_Shopping_Stop 與分到它的品項，依車輛的 Ordinal（現行 `state.vehicles` 的
/// 順序）。第一版只為 First_Shopping_Stop 保存品項清單，所以這些停靠點也就是現行 `[...plan.stopItems.keys()]`。
fn stop_lists(state: &TripState, plan: &ShoppingPlan) -> Vec<(StopId, Vec<ShoppingId>)> {
    state
        .vehicles_by_ordinal()
        .filter_map(|vehicle| plan.first_stop.get(&vehicle.id))
        .map(|first| (first.stop, plan.stop_items(first.stop).to_vec()))
        .collect()
}

/// 現行測試的 `plan.unassigned.map(({ item, code, reason }) => [item.id, code, reason])`。
fn unassigned_rows(plan: &ShoppingPlan) -> Vec<(ShoppingId, UnassignedCode, &str)> {
    plan.unassigned
        .iter()
        .map(|entry| (entry.item, entry.code, entry.reason.as_str()))
        .collect()
}

/// 現行測試的 `reasons(want)`：手動品項在 Unassigned_Shopping 的（品項, 原因代碼, 原因），依採買品項的 Ordinal；同時
/// 確認料理食材的品項（Meal_Item）都是待分配。
fn manual_reasons<'a>(
    state: &TripState,
    plan: &'a ShoppingPlan,
) -> Vec<(ShoppingId, UnassignedCode, &'a str)> {
    let (meal, manual): (Vec<_>, Vec<_>) = unassigned_rows(plan)
        .into_iter()
        .partition(|&(item, _, _)| state.shopping[&item].source == ItemSource::Meal);
    for (item, code, reason) in meal {
        assert_eq!(
            (code, reason),
            (UnassignedCode::Unassigned, "待分配"),
            "{item}"
        );
    }
    manual
}

/// 現行 `plan.locationOf.get(id)` 的 `{ n, placeName, vehicleName }`：品項分到的 First_Shopping_Stop 是第幾天、地點的
/// 名稱與車名；屬於 Unassigned_Shopping 的品項是 `None`（現行 `locationOf` 沒有這個鍵）。
fn location_of<'a>(
    state: &'a TripState,
    plan: &ShoppingPlan,
    item: ShoppingId,
) -> Option<(usize, &'a str, &'a str)> {
    let first = plan.stop_of(item)?;
    let car = &state.vehicles[&first.vehicle];
    Some((first.n, place_name(state, first.place), car.name.as_str()))
}

/// 現行測試的 `[...plan.locationOf]`：有位置的品項與它的位置，依採買品項的 Ordinal（現行 Map 加入的順序）。
fn locations<'a>(
    state: &'a TripState,
    plan: &ShoppingPlan,
) -> Vec<(ShoppingId, (usize, &'a str, &'a str))> {
    state
        .shopping_by_ordinal()
        .filter_map(|item| Some((item.id, location_of(state, plan, item.id)?)))
        .collect()
}

/// 原測試的 `expect(isValidState(state)).toBe(true)`。第一版的 State_Validator 是 `validate::state()`（任務 8.5，還沒有
/// 實作），資料格式也不同，所以這裡以第一版的規則，只檢查這些測試修改的資料（旅伴、車輛、地點、路線與停靠點、每日
/// 設定、採買品項的負責人）中型別沒有保證的條件：
///
/// - 地點最多 100 個，名稱符合需求 21.1：不是空白、最多 50 字、沒有 Hidden_Control_Char，也不與其他地點或非空白的
///   旅行目的地同名（I2、I12）。
/// - 車輛的駕駛與乘客都是旅伴，駕駛不在乘客中，乘客加上駕駛不超過座位數（I1、I6）。
/// - 路線的日期在旅行範圍內、車輛存在、每台車每天最多一條；起點、終點與停靠點是地點清單中的地點，或非空白的旅行
///   目的地；最多 6 個停靠點，停靠點 id 在整趟旅行中唯一，任務屬於停靠點的種類，備註最多 100 字（I1、I3、I4、I5，
///   需求 22.7）。
/// - 每日設定的日期在旅行範圍內，地點是地點清單中的地點，標題最多 20 字（I1、I5）。
/// - 採買品項的負責人是旅伴或待分配（I1）。
fn assert_valid_itinerary(state: &TripState) {
    let days: BTreeSet<Date> = date_range(state.card.start, state.card.end)
        .into_iter()
        .collect();
    let destination = !trim_white(&state.card.destination).is_empty();
    let usable = |place: PlaceRef| match place {
        PlaceRef::Destination => destination,
        PlaceRef::Place(id) => state.places.contains_key(&id),
    };
    assert!(
        state.places.len() <= PLACES_MAX,
        "地點有 {} 個",
        state.places.len()
    );
    for place in state.places.values() {
        let error = place_name_error(state, &place.name, Some(place.id));
        assert_eq!(error, None, "地點「{}」", place.name);
    }
    for car in state.vehicles.values() {
        let name = &car.name;
        let mut riders = car.driver.iter().chain(&car.passengers);
        assert!(
            riders.all(|person| state.people.contains_key(person)),
            "「{name}」的駕駛或乘客不是旅伴"
        );
        let driver_rides = car
            .driver
            .is_some_and(|driver| car.passengers.contains(&driver));
        assert!(!driver_rides, "「{name}」的駕駛也是乘客");
        assert!(
            car.passengers.len() < usize::from(car.seats),
            "「{name}」的乘客加上駕駛超過座位數"
        );
    }
    let mut car_days = BTreeSet::new();
    let mut stops = BTreeSet::new();
    for route in state.routes.values() {
        let at = format!("{} 的路線", route.day);
        assert!(days.contains(&route.day), "{at}不在旅行範圍內");
        assert!(
            state.vehicles.contains_key(&route.vehicle),
            "{at}的車輛不存在"
        );
        assert!(
            car_days.insert((route.day, route.vehicle)),
            "{at}：這台車這一天已有路線"
        );
        assert!(
            usable(route.from) && usable(route.to),
            "{at}的起點或終點無法使用"
        );
        assert!(
            ROUTE_STOPS.contains(&route.stops.len()),
            "{at}有 {} 個停靠點",
            route.stops.len()
        );
        for stop in &route.stops {
            assert!(stops.insert(stop.id), "{at}：停靠點 {} 重複", stop.id);
            assert!(
                usable(stop.place),
                "{at}：停靠點 {} 的地點無法使用",
                stop.id
            );
            let task_fits = stop.task.is_none_or(|task| task.kind() == stop.kind);
            assert!(task_fits, "{at}：停靠點 {} 的任務不屬於它的種類", stop.id);
            assert!(
                STOP_NOTE_CHARS.contains(&char_count(&stop.note)),
                "{at}：停靠點 {} 的備註太長",
                stop.id
            );
        }
    }
    for (&key, setting) in &state.day_settings {
        assert_eq!(key, setting.day, "每日設定的鍵是它的日期");
        assert!(days.contains(&key), "{key} 的每日設定不在旅行範圍內");
        let place_known = setting
            .place
            .is_none_or(|place| state.places.contains_key(&place));
        assert!(place_known, "{key} 的每日設定的地點不在地點清單中");
        let title_fits = setting
            .title
            .as_deref()
            .is_none_or(|title| DAY_TITLE_CHARS.contains(&char_count(title)));
        assert!(title_fits, "{key} 的每日設定的標題太長");
    }
    for item in state.shopping.values() {
        let known = item
            .assignee
            .is_none_or(|person| state.people.contains_key(&person));
        assert!(known, "「{}」的負責人不是旅伴", item.name);
    }
}
