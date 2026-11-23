//! 旅伴名字規則的範例測試（任務 8.15；需求 33.1、33.10）。
//!
//! 以 `AddPerson` 與 `UpdatePerson` 移植 `tests/recipes-invites.test.js` 中 Participant_Name 的正規化、同名與
//! 100 位上限的 13 個案例（`invitation creates a new independent person` 的 6 個測試與 `rejects invalid name %p`
//! 表格的 6 列，以及 `emoji joined names work while invisible lookalikes and empty names are rejected`）：輸入與原
//! 案例相同，預期值與原案例相同並直接寫在測試中。每個測試上方的註解標明來源的測試名稱，`describe` 之內的測試寫成
//! 「describe › test」；`test.each` 表格的每一列是一個案例。
//!
//! 現行的 `addParticipant(state, name, role)` 是 Trip_Manager（`p1`）送出的 `AddPerson`：現行丟出錯誤是命令被
//! 拒絕，`toThrow(文字)` 檢查拒絕的訊息含有這段文字；原案例只斷言丟出錯誤時，另外比對 Bun_App 丟出的訊息，也就是
//! 需求 19.2–19.7 的訊息。現行回傳的 `result.state` 是套用效果之後的狀態，`result.person` 是新增的旅伴。
//! `seed()` 是 `support::seed` 套用一次採買同步的 `synced_seed()`（陣列的順序是 Ordinal）：現行的 `addParticipant()` 不執行採買同步，`seed()` 本身沒有涵蓋每一道料理的食材，以 `Mode::Commit` 提交時會被 I9 拒絕。
//!
//! 不移植的斷言：`adds a unique person without mutating existing data or taking an identity` 中
//! `result.person.id` 不是 `currentUser`，以及 `rejects duplicate existing person rather than impersonating` 中
//! `currentUser` 仍是 `p1`：第一版沒有 `currentUser`，新旅伴的 id 由客戶端產生（需求 7.18），檢視者是 Account 的
//! Bound_Person（需求 6）；新增的旅伴不綁定帳號，也不會變成任何人的 Bound_Person。同兩個測試的其他斷言移植。

mod support;

use lm_core::apply::{apply, Ctx, Mode};
use lm_core::command::{Command, PersonPatch, Rejection, DUPLICATE_NAME, LIMIT_REACHED};
use lm_core::ids::PersonId;
use lm_core::model::{Departure, Person, Role, Row, TripState};
use lm_core::rules::capabilities;
use lm_core::text::participant_name;
use lm_core::validate;

use support::commands::{owner, CommitIds};
use support::ids::{id, Tag};
use support::seed::{person, synced_seed as seed, ME};

/// 需求 19.2 的訊息。
const BLANK: &str = "請填寫名字或暱稱，不能只有空白。";
/// 需求 19.3 的訊息。
const CONTROL: &str = "名字不能包含隱藏控制字元。";
/// 需求 19.4 的訊息。
const TOO_LONG: &str = "名字最多 30 個字。";

/// 新增的旅伴的 id。
fn new_person() -> PersonId {
    id(Tag::Person, 1000)
}

/// Trip_Manager `p1`。
fn manager() -> Ctx {
    Ctx {
        actor: owner(),
        caps: capabilities(owner(), owner(), Role::Member, Some(person(ME))),
    }
}

/// 現行的 `addParticipant(state, name, role)`：成功時回傳套用效果之後的狀態。
fn add_participant(state: &TripState, name: &str, role: &str) -> Result<TripState, Rejection> {
    let cmd = Command::AddPerson {
        id: new_person(),
        name: name.to_owned(),
        role: role.to_owned(),
        color: None,
    };
    let outcome = apply(
        state,
        &manager(),
        Mode::Commit,
        &mut CommitIds::default(),
        &cmd,
    )?;
    let mut next = state.clone();
    next.apply_effects(&outcome.effects());
    Ok(next)
}

/// 新增的旅伴。
fn added(state: &TripState) -> &Person {
    &state.people[&new_person()]
}

/// 拒絕的訊息。
fn message(result: Result<TripState, Rejection>) -> String {
    result.expect_err("應該被拒絕").message().to_owned()
}

/// 來源：`tests/recipes-invites.test.js` 的 `invitation creates a new independent person` ›
/// `adds a unique person without mutating existing data or taking an identity`。
#[test]
fn adds_a_unique_person_without_mutating_existing_data() {
    let state = seed();
    let copy = state.clone();
    let result = add_participant(&state, " 小樹 ", "").expect("可以新增");
    assert_eq!(state, copy);
    assert_eq!(result.people.len(), 7);
    let person = added(&result);
    assert_eq!(
        (person.name.as_str(), person.role.as_str()),
        ("小樹", "新加入的旅伴")
    );
    assert!(!person.bound);
    assert_eq!(validate::state(&result, Mode::Commit), Ok(()));
}

/// 來源：`tests/recipes-invites.test.js` 的 `invitation creates a new independent person` ›
/// `normalizes fullwidth characters and internal spaces`。原案例直接呼叫 `normalizeParticipantName()`；這裡也以
/// `AddPerson` 與 `UpdatePerson` 確認存下的名字。
#[test]
fn names_normalize_fullwidth_characters_and_internal_spaces() {
    let input = " Ａｌｉｃｅ   Lin ";
    assert_eq!(participant_name(input), "Alice Lin");
    let state = add_participant(&seed(), input, "").expect("可以新增");
    assert_eq!(added(&state).name, "Alice Lin");
    let cmd = Command::UpdatePerson {
        id: person(2),
        patch: PersonPatch {
            name: Some(" Ｂｏｂ \t Lee ".to_owned()),
            ..PersonPatch::default()
        },
    };
    let outcome = apply(
        &seed(),
        &manager(),
        Mode::Commit,
        &mut CommitIds::default(),
        &cmd,
    )
    .expect("可以改名");
    let mut renamed = seed();
    renamed.apply_effects(&outcome.effects());
    assert_eq!(renamed.people[&person(2)].name, "Bob Lee");
}

/// 來源：`tests/recipes-invites.test.js` 的 `invitation creates a new independent person` ›
/// `rejects invalid name %p` 表格的 6 列：`''`、`'   '`、`'\u3000'`、`'\u200b'`、`'\u202eJack'` 與 31 個「樹」。
#[test]
fn invalid_names_are_rejected() {
    let long = "樹".repeat(31);
    for (name, expected) in [
        ("", BLANK),
        ("   ", BLANK),
        ("\u{3000}", BLANK),
        ("\u{200b}", BLANK),
        ("\u{202e}Jack", CONTROL),
        (long.as_str(), TOO_LONG),
    ] {
        let state = seed();
        let result = add_participant(&state, name, "");
        assert_eq!(
            result,
            Err(Rejection::invalid("name", expected)),
            "{name:?}"
        );
        assert_eq!(state.people.len(), 6);
    }
}

/// 來源：`tests/recipes-invites.test.js` 的 `invitation creates a new independent person` ›
/// `rejects duplicate existing person rather than impersonating`。`currentUser` 的斷言不移植（見檔頭）。
#[test]
fn a_duplicate_of_an_existing_person_is_rejected() {
    let result = add_participant(&seed(), " 小安 ", "");
    assert!(matches!(
        &result,
        Err(Rejection::Conflict { code, message }) if code == DUPLICATE_NAME && message.contains("已在小隊")
    ));
    // UpdatePerson：把阿哲改名為「 小安 」也是同名
    let cmd = Command::UpdatePerson {
        id: person(2),
        patch: PersonPatch {
            name: Some(" 小安 ".to_owned()),
            ..PersonPatch::default()
        },
    };
    let rejection = apply(
        &seed(),
        &manager(),
        Mode::Commit,
        &mut CommitIds::default(),
        &cmd,
    )
    .expect_err("同名");
    assert!(rejection.message().contains("已在小隊"), "{rejection}");
}

/// 來源：`tests/recipes-invites.test.js` 的 `invitation creates a new independent person` ›
/// `duplicate names compare normalized spelling and case`。
#[test]
fn duplicate_names_compare_normalized_spelling_and_case() {
    let state = add_participant(&seed(), "Alice", "").expect("可以新增");
    let cmd = Command::AddPerson {
        id: id(Tag::Person, 1001),
        name: " ＡＬＩＣＥ ".to_owned(),
        role: String::new(),
        color: None,
    };
    let rejection = apply(
        &state,
        &manager(),
        Mode::Commit,
        &mut CommitIds::default(),
        &cmd,
    )
    .expect_err("同名");
    assert!(rejection.message().contains("已在小隊"), "{rejection}");
}

/// 來源：`tests/recipes-invites.test.js` 的 `invitation creates a new independent person` ›
/// `checks role length and total participant cap`。
#[test]
fn role_length_and_the_participant_cap_are_checked() {
    let role = "角".repeat(61);
    assert!(message(add_participant(&seed(), "小樹", &role)).contains("60"));
    // state.people = Array.from({length: 100}, (_, i) => ({...state.people[0], id: `p-${i}`, name: `name-${i}`}))
    let mut state = seed();
    let first = state.people[&person(1)].clone();
    state.people.clear();
    for i in 0..100 {
        let person = Person {
            id: id(Tag::Person, 100 + i),
            name: format!("name-{i}"),
            ordinal: 100 + i,
            ..first.clone()
        };
        state.put(Row::Person(person));
    }
    let result = add_participant(&state, "One more", "");
    assert!(matches!(
        &result,
        Err(Rejection::Conflict { code, message }) if code == LIMIT_REACHED && message.contains("100")
    ));
}

/// 來源：`tests/recipes-invites.test.js` 的 `invitation creates a new independent person` ›
/// `invalid additions preserve packing while valid new member clears readiness declaration`。
#[test]
fn invalid_additions_keep_departures_and_valid_ones_clear_them() {
    let mut state = seed();
    // state.departed = ['p1']
    state.departures.insert(
        person(1),
        Departure {
            person: person(1),
            version: 0,
        },
    );
    assert!(add_participant(&state, "小安", "").is_err());
    assert_eq!(
        state.departures.keys().copied().collect::<Vec<_>>(),
        [person(1)]
    );
    let added = add_participant(&state, "小樹", "").expect("可以新增");
    assert!(added.departures.is_empty());
}

/// 來源：`tests/recipes-invites.test.js` 的
/// `emoji joined names work while invisible lookalikes and empty names are rejected`。
#[test]
fn emoji_joined_names_work_while_invisible_lookalikes_and_empty_names_are_rejected() {
    let chef = add_participant(&seed(), "小樹👩\u{200d}🍳", "").expect("可以新增");
    assert_eq!(added(&chef).name, "小樹👩\u{200d}🍳");
    let family =
        add_participant(&seed(), "露營👨\u{200d}👩\u{200d}👧\u{200d}👦", "").expect("可以新增");
    assert!(added(&family)
        .name
        .contains("👨\u{200d}👩\u{200d}👧\u{200d}👦"));
    for name in ["小安\u{fe0f}", "小安\u{3164}", "小安\u{115f}"] {
        assert!(
            message(add_participant(&seed(), name, "")).contains("已在小隊"),
            "{name:?}"
        );
    }
    for name in ["\u{3164}", "\u{fe0f}", "\u{115f}"] {
        assert!(
            message(add_participant(&seed(), name, "")).contains("空白"),
            "{name:?}"
        );
    }
    assert!(message(add_participant(&seed(), "A\u{200d}B", "")).contains("控制"));
}

/// 需求 33.10：名字為「小」加 U+0085 加「安」的旅伴以「名字不能包含隱藏控制字元。」拒絕（U+0085 不是
/// JS_Whitespace，所以不會被換成空格）。
#[test]
fn a_name_with_u0085_is_rejected_as_a_hidden_control_character() {
    assert_eq!(
        add_participant(&seed(), "小\u{85}安", ""),
        Err(Rejection::invalid("name", CONTROL))
    );
}
