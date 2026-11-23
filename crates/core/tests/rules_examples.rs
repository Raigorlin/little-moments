//! 規則的範例測試（任務 8.14；需求 33.1）：My_Gear、Can_Depart、打包進度、日期範圍與 Trip_State 的驗證。
//!
//! 移植 `tests/model.test.js` 中以固定輸入斷言第一版規則的案例：輸入與原案例相同，預期值與原案例相同並直接寫在
//! 測試中，也就是 Bun_App 對同一輸入的結果。每個測試上方的註解標明來源的測試名稱，`describe` 之內的測試寫成
//! 「describe › test」。該檔的 23 個測試移植 15 個，其中 5 個各有一部分斷言不移植；不移植的 8 個測試與這些斷言列在
//! 下面。
//!
//! 現行的資料與操作寫成第一版的形式：
//!
//! - `seed()` 是 `support::seed` 套用一次採買同步的 `synced_seed()`（陣列的順序是 Ordinal；現行的 `seed()` 沒有涵蓋每一道料理的食材，以 `Mode::Commit` 提交命令時會被 I9 拒絕，同步只新增採買品項，不影響裝備與活動），旅伴 `p{n}` 是 `person(n)`，裝備 `g{n}` 是 `gear(n)`；
//!   現行的 `currentUser` 是 `p1`（`ME`），也就是 `Capabilities` 的 `me`。範例旅行是 `support::example_trip`。
//! - 現行的 `togglePacking(state, id)` 是以 `me` 送出 `SetGearPacked`（打包狀態的相反值，需求 7.10），
//!   `assignGear(state, id, person)` 是 Trip_Manager 送出只改負責人的 `UpdateGear`（需求 27.13）；現行回傳 `false`
//!   是命令被拒絕。`readyCount()` 是 `packing_progress().done`，`myGear()`、`unassigned()`、`canDepart()` 與
//!   `progress()` 的裝備部分是 `my_gear()`、`unassigned_gear()`、`can_depart()` 與 `gear_progress()`。
//! - 現行的 `isValidState()` 是 `validate::state(…, Mode::Predict)`：`isValidState()` 不檢查料理的食材是否被採買
//!   品項涵蓋（I9），`seed()` 也沒有涵蓋每一道料理的食材，所以不以 `Mode::Commit` 檢查。直接改資料的案例在狀態上
//!   直接修改（不經命令），與原案例相同。`dateRange()` 是 `date_range()`。
//!
//! 不移植的案例與原因：
//!
//! - `local camping model` › `persists and restores changes`、`new and malformed local storage starts from a blank
//!   valid planner` 與 `storage failures are reported, not treated as saved`：斷言 localStorage 的保存與讀取
//!   （`save()`、`load()`、`emptyState()`）。第一版沒有 localStorage 的旅行資料（需求 33.1）。
//! - `local camping model` › `renders untrusted text as escaped text` 與 `escapes backticks`：斷言 HTML 跳脫
//!   （`escape()`）；LM_Web 以文字節點輸出使用者文字（需求 32.9），不是 LM_Core 的規則（需求 33.1）。
//! - `local camping model` › `SVG art does not allow class injection`：斷言 SVG 插圖（需求 33.1）。
//! - `local camping model` › `nested malformed backup data is rejected`（`gear[0].ready = 'no'`）與
//!   `unknown active identity is rejected`（`currentUser = 'unknown'`）：第一版的打包勾選是 `BTreeSet<PersonId>`，
//!   無法表示文字；也沒有 `currentUser`，檢視者是 Account 的 Bound_Person（需求 6）。
//! - `local camping model` › `validates date ranges and leap days` 中 `dateRange('bad', 'bad')` 的斷言，以及
//!   `rejects normalized invalid dates and spans longer than one month` 中 `dateRange('2026-02-30', …)` 的斷言：
//!   第一版的日期是 `NaiveDate`，無法表示不是日期的文字與 2 月 30 日（命令中這種值依需求 7.20 以 400 拒絕）。同兩個
//!   測試的其他斷言移植。
//! - `local camping model` › `progress includes personal gear for each participant` 中 `shoppingDone` 與
//!   `shoppingTotal` 的斷言：第一版沒有全隊的採買進度（出發清單只算檢視者負責的品項，需求 28.1）。同一個測試的
//!   Gear_Progress 移植。
//! - `rejects hidden categories and unknown gear assignees in backups` 中 `shopping[0].category = 'invisible'` 的
//!   斷言：第一版的採買分類是 `Category`，無法表示其他文字。同一個測試的未知負責人移植。
//! - `rejects out of trip dates and duplicate passengers` 中 `passengers = ['p1', 'p1']` 的斷言：第一版的乘客是
//!   集合，無法重複。同一個測試的範圍外日期移植。

mod support;

use lm_core::apply::{apply, Ctx, Mode};
use lm_core::command::{Command, GearPatch, Rejection, PERSON_NOT_FOUND};
use lm_core::ids::GearId;
use lm_core::model::{ActivityKind, Departure, Role, TripState};
use lm_core::rules::{
    can_depart, capabilities, gear_progress, my_gear, packing_progress, unassigned_gear,
    Capabilities, Progress,
};
use lm_core::time::date_range;
use lm_core::validate::{self, Violation};

use support::commands::{owner, CommitIds};
use support::example_trip::example_trip;
use support::seed::{activity, day, gear, person, synced_seed as seed, ME};

/// 以 `p1` 送出命令的 Trip_Manager（現行的 `currentUser`）。
fn me() -> Ctx {
    let caps: Capabilities = capabilities(owner(), owner(), Role::Member, Some(person(ME)));
    Ctx {
        actor: owner(),
        caps,
    }
}

/// 以 `ctx` 執行命令；成功時回傳新的狀態，失敗時回傳拒絕。
fn run(state: &TripState, ctx: &Ctx, cmd: Command) -> Result<TripState, Rejection> {
    let outcome = apply(state, ctx, Mode::Commit, &mut CommitIds::default(), &cmd)?;
    let mut next = state.clone();
    next.apply_effects(&outcome.effects());
    Ok(next)
}

/// 現行的 `togglePacking(state, id)`：以 `me` 送出打包狀態的相反值。
fn toggle_packing(state: &TripState, id: GearId) -> Result<TripState, Rejection> {
    let packed = state.gear[&id].packed_by.contains(&person(ME));
    run(
        state,
        &me(),
        Command::SetGearPacked {
            id,
            person: person(ME),
            packed: !packed,
        },
    )
}

/// 現行的 `assignGear(state, id, person)`：只改負責人。
fn assign_gear(
    state: &TripState,
    id: GearId,
    assignee: Option<lm_core::ids::PersonId>,
) -> Result<TripState, Rejection> {
    let patch = GearPatch {
        assignee: Some(assignee),
        ..GearPatch::default()
    };
    run(state, &me(), Command::UpdateGear { id, patch })
}

/// 現行的 `isValidState()`。
fn is_valid(state: &TripState) -> bool {
    validate::state(state, Mode::Predict).is_ok()
}

/// 來源：`tests/model.test.js` 的 `local camping model` › `demo data has a valid complete schema`。
#[test]
fn the_demo_trip_is_valid() {
    assert!(is_valid(&seed()));
}

/// 來源：`tests/model.test.js` 的 `local camping model` › `validates date ranges and leap days`。
/// `dateRange('bad', 'bad')` 的斷言不移植（見檔頭）。
#[test]
fn date_ranges_include_leap_days_and_reject_reversed_ranges() {
    assert_eq!(date_range(day("2028-02-28"), day("2028-03-01")).len(), 3);
    assert!(date_range(day("2026-11-22"), day("2026-11-20")).is_empty());
}

/// 來源：`tests/model.test.js` 的 `local camping model` › `packing marks belong to the chosen participant`。
#[test]
fn packing_marks_belong_to_the_chosen_participant() {
    let state = toggle_packing(&seed(), gear(1)).expect("p1 可以打包自己的個人裝備");
    assert_eq!(packing_progress(&state, person(ME)).done, 1);
    // state.currentUser = 'p2'
    assert_eq!(
        state.gear[&gear(1)].packed_by,
        [person(1)].into_iter().collect()
    );
    assert_eq!(packing_progress(&state, person(2)).done, 1);
}

/// 來源：`tests/model.test.js` 的 `local camping model` › `cannot tick another participants shared equipment`。
#[test]
fn another_participants_shared_equipment_cannot_be_ticked() {
    let rejection = toggle_packing(&seed(), gear(6)).expect_err("g6 由 p4 負責");
    assert_eq!(
        rejection,
        Rejection::forbidden("只能勾選自己的個人裝備或負責的共用裝備。")
    );
}

/// 來源：`tests/model.test.js` 的 `local camping model` › `unassigned group items block departure`。
#[test]
fn unassigned_group_items_block_departure() {
    let mut state = seed();
    let mine: Vec<GearId> = my_gear(&state, person(ME)).map(|g| g.id).collect();
    for id in mine {
        state = toggle_packing(&state, id).expect("p1 可以打包自己的裝備");
    }
    assert!(!can_depart(&state, person(ME)));
    assert_eq!(unassigned_gear(&state).count(), 2);
}

/// 來源：`tests/model.test.js` 的 `local camping model` › `departure succeeds only after assignment and own packing`。
#[test]
fn departure_succeeds_only_after_assignment_and_own_packing() {
    let mut state = seed();
    state = assign_gear(&state, gear(10), Some(person(2))).expect("Trip_Manager 可以分配");
    state = assign_gear(&state, gear(11), Some(person(2))).expect("Trip_Manager 可以分配");
    let mine: Vec<GearId> = my_gear(&state, person(ME)).map(|g| g.id).collect();
    for id in mine {
        state = toggle_packing(&state, id).expect("p1 可以打包自己的裝備");
    }
    assert!(can_depart(&state, person(ME)));
}

/// 來源：`tests/model.test.js` 的 `local camping model` › `reassigning clears obsolete readiness and departure`。
#[test]
fn reassigning_clears_obsolete_readiness_and_departure() {
    let mut state = seed();
    // state.departed = ['p2']
    state.departures.insert(
        person(2),
        Departure {
            person: person(2),
            version: 0,
        },
    );
    let state = assign_gear(&state, gear(8), Some(person(1))).expect("Trip_Manager 可以改派");
    assert!(state.gear[&gear(8)].packed_by.is_empty());
    assert!(state.departures.is_empty());
}

/// 來源：`tests/model.test.js` 的 `local camping model` › `unknown assignment is not accepted`。
#[test]
fn an_unknown_assignee_is_not_accepted() {
    let rejection = assign_gear(&seed(), gear(8), Some(person(1000))).expect_err("找不到這位旅伴");
    assert_eq!(rejection, Rejection::invalid("assignee", PERSON_NOT_FOUND));
}

/// 來源：`tests/model.test.js` 的 `local camping model` › `progress includes personal gear for each participant`。
/// 原案例預期 `{ shoppingDone: 3, shoppingTotal: 12, gearDone: 1, gearTotal: 31 }`；採買的兩項不移植（見檔頭）。
#[test]
fn gear_progress_counts_personal_gear_for_each_participant() {
    assert_eq!(gear_progress(&seed()), Progress { done: 1, total: 31 });
}

/// 來源：`tests/model.test.js` 的 `rejects hidden categories and unknown gear assignees in backups`。
/// `category = 'invisible'` 的斷言不移植（見檔頭）。
#[test]
fn an_unknown_gear_assignee_is_rejected() {
    let mut state = seed();
    // other.gear[4].assignee = 'ghost'
    state.gear.get_mut(&gear(5)).expect("g5 存在").assignee = Some(person(1000));
    assert!(matches!(
        validate::state(&state, Mode::Predict),
        Err(Violation::DanglingReference { .. })
    ));
}

/// 來源：`tests/model.test.js` 的 `rejects out of trip dates and duplicate passengers`。
/// `passengers = ['p1', 'p1']` 的斷言不移植（見檔頭）。
#[test]
fn out_of_trip_dates_are_rejected() {
    let mut state = seed();
    // state.activities[0].date = '2030-01-01'
    state.activities.get_mut(&activity(1)).expect("a1 存在").day = day("2030-01-01");
    assert!(!is_valid(&state));
}

/// 來源：`tests/model.test.js` 的 `rejects normalized invalid dates and spans longer than one month`。
/// `dateRange('2026-02-30', '2026-03-04')` 的斷言不移植（見檔頭）。
#[test]
fn spans_longer_than_one_month_are_rejected() {
    assert!(date_range(day("2026-01-01"), day("2026-03-01")).is_empty());
}

/// 現行的 `withActivityType(type)`：第一筆活動改為 `kind`。
fn with_activity_type(kind: ActivityKind) -> TripState {
    let mut state = seed();
    state
        .activities
        .get_mut(&activity(1))
        .expect("a1 存在")
        .kind = kind;
    state
}

/// 來源：`tests/model.test.js` 的 `activity types and Example_Trip` › `the seven new activity types are valid`。
#[test]
fn the_seven_new_activity_types_are_valid() {
    let types = ["wake", "pitch", "free", "tea", "strike", "clean", "return"];
    let invalid: Vec<&str> = types
        .into_iter()
        .filter(|text| {
            !ActivityKind::parse(text).is_some_and(|kind| is_valid(&with_activity_type(kind)))
        })
        .collect();
    assert!(invalid.is_empty(), "{invalid:?}");
}

/// 來源：`tests/model.test.js` 的 `activity types and Example_Trip` ›
/// `unknown activity types and the empty string are invalid`。第一版的活動類別是 `ActivityKind`，不是這 13 種之一的
/// 文字無法解析，所以以 `ActivityKind::parse()` 比對。
#[test]
fn unknown_activity_types_and_the_empty_string_are_invalid() {
    // '起床' 是類別的中文名稱，不是儲存的值
    let types = ["", "party", "Wake", " wake", "起床"];
    let valid: Vec<&str> = types
        .into_iter()
        .filter(|text| ActivityKind::parse(text).is_some())
        .collect();
    assert!(valid.is_empty(), "{valid:?}");
}

/// 來源：`tests/model.test.js` 的 `activity types and Example_Trip` › `Example_Trip is valid`。
#[test]
fn the_example_trip_is_valid() {
    assert!(is_valid(&example_trip()));
}
