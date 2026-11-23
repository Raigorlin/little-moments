//! 旅伴：`AddPerson`、`UpdatePerson`、`RemovePerson`（需求 19），以及以邀請連結加入旅行的 `join_trip()`（需求 30）。

use crate::command::{
    PersonPatch, Rejection, DUPLICATE_NAME, LIMIT_REACHED, PERSON_LOCKED, PERSON_NOT_FOUND,
};
use crate::ids::PersonId;
use crate::limits::{PEOPLE_MAX, PERSON_NAME_CHARS, PERSON_ROLE_CHARS};
use crate::model::{Color, Entity, GearScope, Participation, Person, Slot, TripState};
use crate::text::{
    char_count, has_control_chars, participant_key, participant_name, trim_js_whitespace,
};
use crate::validate::{self, Violation};

use super::common::{ensure_new, next_ordinal};
use super::{diff, slot, Mode, Outcome};

/// 正規化後的角色是空的時的角色（需求 19.1）。
const DEFAULT_ROLE: &str = "新加入的旅伴";

/// 新增旅伴時依新增前的人數除以 6 的餘數取色（需求 19.8）。
const COLORS: [Color; 6] = [
    Color::Coral,
    Color::Blue,
    Color::Green,
    Color::Yellow,
    Color::Lavender,
    Color::Peach,
];

/// 名字經 Participant_Name 之後依需求 19.2 至 19.4 檢查；回傳正規化後的名字。
pub(super) fn checked_name(raw: &str) -> Result<String, Rejection> {
    let name = participant_name(raw);
    if trim_js_whitespace(&participant_key(&name)).is_empty() {
        return Err(Rejection::invalid(
            "name",
            "請填寫名字或暱稱，不能只有空白。",
        ));
    }
    if has_control_chars(&name) {
        return Err(Rejection::invalid("name", "名字不能包含隱藏控制字元。"));
    }
    if char_count(&name) > *PERSON_NAME_CHARS.end() {
        return Err(Rejection::invalid("name", "名字最多 30 個字。"));
    }
    Ok(name)
}

/// 角色經 Participant_Name，是空的時改為「新加入的旅伴」，再依需求 19.5 檢查。
fn checked_role(raw: &str) -> Result<String, Rejection> {
    let role = match participant_name(raw) {
        role if role.is_empty() => DEFAULT_ROLE.to_owned(),
        role => role,
    };
    if char_count(&role) > *PERSON_ROLE_CHARS.end() {
        return Err(Rejection::invalid("role", "小隊角色最多 60 個字。"));
    }
    if role.contains('\0') {
        return Err(Rejection::invalid("role", "小隊角色含有不允許的字元。"));
    }
    Ok(role)
}

/// 需求 19.6：Participant_Key 與另一位旅伴相同時 409；修改時不與這位旅伴自己比較。
fn ensure_unique(d: &TripState, name: &str, except: Option<PersonId>) -> Result<(), Rejection> {
    let key = participant_key(name);
    let taken = d
        .people
        .values()
        .any(|person| Some(person.id) != except && participant_key(&person.name) == key);
    if taken {
        return Err(Rejection::conflict(
            DUPLICATE_NAME,
            "這個名字已在小隊中。請加上姓氏或使用不同暱稱，不會直接切換成同名旅伴。",
        ));
    }
    Ok(())
}

/// 新增一位旅伴（`AddPerson` 與 `join_trip()`）：依需求 19.1 至 19.7 的順序檢查；沒有指定顏色時依需求 19.8 取色；
/// 刪除所有出發確認（需求 19.9）。
fn add(
    d: &mut TripState,
    id: PersonId,
    name: &str,
    role: &str,
    color: Option<Color>,
    bound: bool,
) -> Result<Vec<Slot>, Rejection> {
    ensure_new(&d.people, &id)?;
    let name = checked_name(name)?;
    let role = checked_role(role)?;
    ensure_unique(d, &name, None)?;
    if d.people.len() >= PEOPLE_MAX {
        return Err(Rejection::conflict(
            LIMIT_REACHED,
            "小隊最多 100 位旅伴，目前已額滿。",
        ));
    }
    let person = Person {
        id,
        name,
        role,
        color: color.unwrap_or(COLORS[d.people.len() % COLORS.len()]),
        bound,
        ordinal: next_ordinal(d),
        version: 0,
    };
    d.people.insert(id, person);
    d.departures.clear();
    Ok(vec![slot(Entity::Person, id.0)])
}

/// `AddPerson`：沒有綁定帳號的旅伴。
pub(super) fn add_person(
    d: &mut TripState,
    id: PersonId,
    name: &str,
    role: &str,
    color: Option<Color>,
) -> Result<Vec<Slot>, Rejection> {
    add(d, id, name, role, color, false)
}

/// `UpdatePerson`：只檢查帶有的欄位，規則與新增相同；不受 100 位的上限限制，也不改變出發確認（需求 19.1–19.9）。
pub(super) fn update_person(
    d: &mut TripState,
    id: PersonId,
    patch: &PersonPatch,
) -> Result<(), Rejection> {
    if !d.people.contains_key(&id) {
        return Err(Rejection::not_found(PERSON_NOT_FOUND));
    }
    let name = patch.name.as_deref().map(checked_name).transpose()?;
    let role = patch.role.as_deref().map(checked_role).transpose()?;
    if let Some(name) = &name {
        ensure_unique(d, name, Some(id))?;
    }
    let person = d.people.get_mut(&id).expect("上面已確認旅伴存在");
    if let Some(name) = name {
        person.name = name;
    }
    if let Some(role) = role {
        person.role = role;
    }
    if let Some(color) = patch.color {
        person.color = color;
    }
    Ok(())
}

/// `RemovePerson`（現行 `detachPerson()`，需求 19.10–19.14）：綁定帳號或仍有帳目的旅伴 409；刪除旅伴並清除駕駛、
/// 乘客、活動參加者（清空後為全體）、料理、採買與裝備的負責人與打包勾選中的引用；共用裝備因此失去負責人時清空那些
/// 裝備的打包並刪除所有出發確認，否則只刪除他自己的出發確認。已不存在時沒有變化。
pub(super) fn remove_person(d: &mut TripState, id: PersonId) -> Result<(), Rejection> {
    let Some(person) = d.people.get(&id) else {
        return Ok(());
    };
    if person.bound {
        return Err(Rejection::conflict(
            PERSON_LOCKED,
            "已綁定帳號的旅伴不能在手冊中移除或更換，請由管理員處理帳號。",
        ));
    }
    let in_ledger = d
        .expenses
        .values()
        .any(|e| e.payer == id || e.participants.contains(&id))
        || d.settlements.values().any(|s| s.from == id || s.to == id);
    if in_ledger {
        return Err(Rejection::conflict(
            PERSON_LOCKED,
            "這位旅伴仍有支出或還款紀錄。請先在分帳記帳修改或刪除這些帳目，再移除旅伴。",
        ));
    }
    d.people.remove(&id);
    for vehicle in d.vehicles.values_mut() {
        if vehicle.driver == Some(id) {
            vehicle.driver = None;
        }
        vehicle.passengers.remove(&id);
    }
    for activity in d.activities.values_mut() {
        if let Participation::People(people) = &mut activity.who {
            people.remove(&id);
            if people.is_empty() {
                activity.who = Participation::Everyone;
            }
        }
    }
    for meal in d.meals.values_mut() {
        if meal.cook == Some(id) {
            meal.cook = None;
        }
    }
    for item in d.shopping.values_mut() {
        if item.assignee == Some(id) {
            item.assignee = None;
        }
    }
    let mut orphaned_shared = false;
    for gear in d.gear.values_mut() {
        gear.packed_by.remove(&id);
        if gear.assignee == Some(id) {
            gear.assignee = None;
            if gear.scope == GearScope::Shared {
                gear.packed_by.clear();
                orphaned_shared = true;
            }
        }
    }
    if orphaned_shared {
        d.departures.clear();
    } else {
        d.departures.remove(&id);
    }
    Ok(())
}

/// 以邀請連結加入旅行（需求 30）：不經 `authorize()`；名字與角色依需求 19.1–19.7 檢查（角色是選填的），新增綁定
/// 帳號的旅伴（顏色依需求 19.8），並刪除所有出發確認（需求 19.9）。回傳的 `Outcome` 與 `apply()` 相同，由
/// LM_Server 以與 `execute()` 相同的方式指定 Seq、Row_Version 與 Ordinal。
pub fn join_trip(
    state: &TripState,
    id: PersonId,
    name: &str,
    role: &str,
) -> Result<Outcome, Rejection> {
    let mut draft = state.clone();
    let created = add(&mut draft, id, name, role, None, true)?;
    validate::state(&draft, Mode::Commit).map_err(Violation::into_rejection)?;
    Ok(Outcome {
        primary: diff(state, &draft),
        derived: Vec::new(),
        created,
    })
}
