//! 裝備與出發：`AddGear`、`UpdateGear`、`RemoveGear`、`SetGearPacked`（需求 27）與 `SetDeparted`（需求 28）。

use std::collections::BTreeSet;

use crate::command::{
    GearDraft, GearPatch, Rejection, CANNOT_DEPART, LIMIT_REACHED, PERSON_NOT_FOUND,
};
use crate::ids::{GearId, PersonId};
use crate::limits::{GEAR_ITEMS_MAX, GEAR_NAME_CHARS, GEAR_QUANTITY_CHARS};
use crate::model::{Departure, Entity, GearItem, GearScope, Slot, TripState};
use crate::rules::{can_depart, my_gear};
use crate::text::trim_white;

use super::common::{ensure_new, fits, next_ordinal, storable};
use super::slot;

/// 找不到裝備（需求 27.12）。
const GEAR_NOT_FOUND: &str = "找不到這個裝備。";

/// 以新增或修改之後的裝備依需求 27.2 的順序檢查；名稱與數量已經過 Trim_White。
fn check(d: &TripState, gear: &GearItem) -> Result<(), Rejection> {
    if gear.name.is_empty() {
        return Err(Rejection::invalid("name", "請填寫必要欄位，不能只有空白。"));
    }
    if !fits(&gear.name, GEAR_NAME_CHARS) {
        return Err(Rejection::invalid("name", "裝備名稱最多 100 個字。"));
    }
    storable("name", &gear.name)?;
    if !fits(&gear.quantity, GEAR_QUANTITY_CHARS) {
        return Err(Rejection::invalid("quantity", "數量與單位最多 40 個字。"));
    }
    storable("quantity", &gear.quantity)?;
    match (gear.scope, gear.assignee) {
        (GearScope::Personal, Some(_)) => Err(Rejection::invalid(
            "assignee",
            "個人裝備每人各帶一份，不能指定負責人。",
        )),
        (GearScope::Shared, Some(person)) if !d.people.contains_key(&person) => {
            Err(Rejection::invalid("assignee", PERSON_NOT_FOUND))
        }
        _ => Ok(()),
    }
}

/// `AddGear`：依需求 27.2 檢查；已有 1000 項時 409（需求 27.3）；刪除所有出發確認（需求 27.5）。
pub(super) fn add_gear(
    d: &mut TripState,
    id: GearId,
    draft: &GearDraft,
) -> Result<Vec<Slot>, Rejection> {
    ensure_new(&d.gear, &id)?;
    let gear = GearItem {
        id,
        name: trim_white(&draft.name).to_owned(),
        quantity: trim_white(&draft.quantity).to_owned(),
        scope: draft.scope,
        assignee: draft.assignee,
        packed_by: BTreeSet::new(),
        ordinal: next_ordinal(d),
        version: 0,
    };
    check(d, &gear)?;
    if d.gear.len() >= GEAR_ITEMS_MAX {
        return Err(Rejection::conflict(
            LIMIT_REACHED,
            "裝備最多 1000 項，目前已額滿。",
        ));
    }
    d.gear.insert(id, gear);
    d.departures.clear();
    Ok(vec![slot(Entity::Gear, id.0)])
}

/// `UpdateGear`：不存在時 404；以修改之後的裝備檢查。範圍改變，或共用裝備的負責人改變時清空打包勾選（需求 27.4）；
/// 名稱、數量、範圍或負責人至少一項的值改變時，刪除所有出發確認（需求 27.5）。
pub(super) fn update_gear(
    d: &mut TripState,
    id: GearId,
    patch: &GearPatch,
) -> Result<(), Rejection> {
    let Some(current) = d.gear.get(&id) else {
        return Err(Rejection::not_found(GEAR_NOT_FOUND));
    };
    let mut gear = current.clone();
    if let Some(name) = &patch.name {
        gear.name = trim_white(name).to_owned();
    }
    if let Some(quantity) = &patch.quantity {
        gear.quantity = trim_white(quantity).to_owned();
    }
    if let Some(scope) = patch.scope {
        gear.scope = scope;
    }
    if let Some(assignee) = patch.assignee {
        gear.assignee = assignee;
    }
    check(d, &gear)?;
    let scope_changed = gear.scope != current.scope;
    let owner_changed = gear.scope == GearScope::Shared && gear.assignee != current.assignee;
    if scope_changed || owner_changed {
        gear.packed_by.clear();
    }
    let changed = gear.name != current.name
        || gear.quantity != current.quantity
        || scope_changed
        || gear.assignee != current.assignee;
    d.gear.insert(id, gear);
    if changed {
        d.departures.clear();
    }
    Ok(())
}

/// `RemoveGear`：刪除裝備與它的打包勾選，並刪除所有出發確認；已不存在時沒有變化（需求 27.5、27.10）。
pub(super) fn remove_gear(d: &mut TripState, id: GearId) {
    if d.gear.remove(&id).is_some() {
        d.departures.clear();
    }
}

/// `SetGearPacked`（design A2）：`authorize()` 已確認 `person` 是自己；不存在時 404，不在 My_Gear 時 403（需求
/// 27.6、27.7）；取消時一併刪除自己的出發確認（需求 27.8）。
pub(super) fn set_packed(
    d: &mut TripState,
    id: GearId,
    person: PersonId,
    packed: bool,
) -> Result<(), Rejection> {
    if !d.gear.contains_key(&id) {
        return Err(Rejection::not_found(GEAR_NOT_FOUND));
    }
    if !my_gear(d, person).any(|gear| gear.id == id) {
        return Err(Rejection::forbidden(
            "只能勾選自己的個人裝備或負責的共用裝備。",
        ));
    }
    let gear = d.gear.get_mut(&id).expect("上面已確認裝備存在");
    if packed {
        gear.packed_by.insert(person);
    } else {
        gear.packed_by.remove(&person);
        d.departures.remove(&person);
    }
    Ok(())
}

/// `SetDeparted`：確認時必須滿足 Can_Depart（需求 28.2、28.3），取消時不檢查（需求 28.4）；冪等。
pub(super) fn set_departed(
    d: &mut TripState,
    person: PersonId,
    departed: bool,
) -> Result<(), Rejection> {
    if !departed {
        d.departures.remove(&person);
        return Ok(());
    }
    if d.departures.contains_key(&person) {
        return Ok(());
    }
    if !can_depart(d, person) {
        return Err(Rejection::invalid("departed", CANNOT_DEPART));
    }
    d.departures
        .insert(person, Departure { person, version: 0 });
    Ok(())
}
