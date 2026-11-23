//! 採買清單：`AddShoppingItem`、`UpdateShoppingItem`、`RemoveShoppingItem`、`SetShoppingPurchased`（需求 26）。
//! 提交時的採買同步由 `apply()` 執行。

use std::collections::BTreeSet;

use crate::command::{
    Rejection, ShoppingDraft, ShoppingPatch, DUPLICATE_NAME, IN_USE, LIMIT_REACHED,
};
use crate::ids::{PersonId, ShoppingId};
use crate::ingredients::{ingredient_key, parse_ingredients};
use crate::limits::{SHOPPING_ITEMS_MAX, SHOPPING_NAME_CHARS, SHOPPING_QUANTITY_CHARS};
use crate::model::{Entity, ItemSource, ShoppingItem, Slot, TripState};
use crate::text::trim_white;

use super::common::{ensure_new, fits, next_ordinal, storable};
use super::{slot, Ctx};

/// 找不到採買品項（需求 26.16）。
const ITEM_NOT_FOUND: &str = "找不到這個採買品項。";

/// 品項名稱經 Trim_White 依需求 26.2 與 26.5 檢查。
fn checked_name(name: &str) -> Result<String, Rejection> {
    let name = trim_white(name);
    if name.is_empty() {
        return Err(Rejection::invalid("name", "請填寫品項名稱。"));
    }
    if !fits(name, SHOPPING_NAME_CHARS) {
        return Err(Rejection::invalid("name", "品項名稱最多 100 個字。"));
    }
    storable("name", name)?;
    Ok(name.to_owned())
}

/// 數量經 Trim_White 檢查；修改時不能是空的（需求 26.5），新增時可以（需求 26.2）。
fn checked_quantity(quantity: &str, required: bool) -> Result<String, Rejection> {
    let quantity = trim_white(quantity);
    if required && quantity.is_empty() {
        return Err(Rejection::invalid("quantity", "請填寫數量與單位。"));
    }
    if !fits(quantity, SHOPPING_QUANTITY_CHARS) {
        return Err(Rejection::invalid("quantity", "數量與單位最多 40 字。"));
    }
    storable("quantity", quantity)?;
    Ok(quantity.to_owned())
}

/// 負責人是這趟旅行的旅伴或待分配。
fn checked_assignee(
    d: &TripState,
    assignee: Option<PersonId>,
) -> Result<Option<PersonId>, Rejection> {
    if assignee.is_some_and(|person| !d.people.contains_key(&person)) {
        return Err(Rejection::invalid(
            "assignee",
            "負責人已不在旅伴名單，請重新選擇。",
        ));
    }
    Ok(assignee)
}

/// 名稱經 Ingredient_Parser 切出的 Ingredient_Key。
fn keys(name: &str) -> BTreeSet<String> {
    parse_ingredients(name)
        .iter()
        .map(|part| ingredient_key(part))
        .collect()
}

/// `AddShoppingItem`：依需求 26.2–26.4 的順序檢查；新增未買的手動品項。
pub(super) fn add_item(
    d: &mut TripState,
    id: ShoppingId,
    draft: &ShoppingDraft,
) -> Result<Vec<Slot>, Rejection> {
    ensure_new(&d.shopping, &id)?;
    let name = checked_name(&draft.name)?;
    let quantity = checked_quantity(&draft.quantity, false)?;
    let assignee = checked_assignee(d, draft.assignee)?;
    let new_keys = keys(&name);
    let taken = d
        .shopping
        .values()
        .any(|item| !keys(&item.name).is_disjoint(&new_keys));
    if taken {
        return Err(Rejection::conflict(
            DUPLICATE_NAME,
            "清單已有同名品項，請編輯既有品項的數量與分類。",
        ));
    }
    if d.shopping.len() >= SHOPPING_ITEMS_MAX {
        return Err(Rejection::conflict(
            LIMIT_REACHED,
            "採買品項最多 1,000 項，請減少食材或整理採買清單後再儲存。",
        ));
    }
    let item = ShoppingItem {
        id,
        name,
        quantity,
        category: draft.category,
        assignee,
        purchased: false,
        source: ItemSource::Manual,
        meal_ids: BTreeSet::new(),
        recipe_removed: None,
        ordinal: next_ordinal(d),
        version: 0,
    };
    d.shopping.insert(id, item);
    Ok(vec![slot(Entity::Shopping, id.0)])
}

/// `UpdateShoppingItem`：只檢查帶有的欄位（需求 26.5）；Linked_Item 改成另一個名稱時 409，整個命令不套用（需求
/// 26.6）。只改數量時來源不變；名稱、分類或負責人改成不同的值時改為手動品項（需求 26.7、26.8）。
pub(super) fn update_item(
    d: &mut TripState,
    id: ShoppingId,
    patch: &ShoppingPatch,
) -> Result<(), Rejection> {
    let Some(current) = d.shopping.get(&id) else {
        return Err(Rejection::not_found(ITEM_NOT_FOUND));
    };
    let name = patch.name.as_deref().map(checked_name).transpose()?;
    let quantity = patch
        .quantity
        .as_deref()
        .map(|quantity| checked_quantity(quantity, true))
        .transpose()?;
    let assignee = patch
        .assignee
        .map(|assignee| checked_assignee(d, assignee))
        .transpose()?;
    if name.as_ref().is_some_and(|name| *name != current.name) && !current.meal_ids.is_empty() {
        return Err(Rejection::conflict(
            IN_USE,
            "連動食材名稱請在料理菜單修改。",
        ));
    }
    let mut item = current.clone();
    let mut reassigned = false;
    if let Some(name) = name {
        reassigned |= name != item.name;
        item.name = name;
    }
    if let Some(category) = patch.category {
        reassigned |= category != item.category;
        item.category = category;
    }
    if let Some(assignee) = assignee {
        reassigned |= assignee != item.assignee;
        item.assignee = assignee;
    }
    if let Some(quantity) = quantity {
        item.quantity = quantity;
    }
    if reassigned {
        item.source = ItemSource::Manual;
    }
    d.shopping.insert(id, item);
    Ok(())
}

/// `RemoveShoppingItem`：已不存在時沒有變化；Linked_Item 時 409（需求 26.12）；刪除並清除支出對它的採買連結
/// （需求 26.11、29.13）。
pub(super) fn remove_item(d: &mut TripState, id: ShoppingId) -> Result<(), Rejection> {
    let Some(item) = d.shopping.get(&id) else {
        return Ok(());
    };
    if !item.meal_ids.is_empty() {
        return Err(Rejection::conflict(
            IN_USE,
            "連動料理的品項不能直接刪除，請改從料理移除這項食材。",
        ));
    }
    d.shopping.remove(&id);
    for expense in d.expenses.values_mut() {
        if expense.shopping_item == Some(id) {
            expense.shopping_item = None;
        }
    }
    Ok(())
}

/// `SetShoppingPurchased`（design A2）：設定已買（冪等）；Collaborator 把已買的 Meal_Item 改為未買時改為手動品項
/// （`retainPurchased()`，需求 26.10）。
pub(super) fn set_purchased(
    d: &mut TripState,
    ctx: &Ctx,
    id: ShoppingId,
    purchased: bool,
) -> Result<(), Rejection> {
    let item = d
        .shopping
        .get_mut(&id)
        .ok_or_else(|| Rejection::not_found(ITEM_NOT_FOUND))?;
    if item.purchased == purchased {
        return Ok(());
    }
    item.purchased = purchased;
    if !purchased && !ctx.caps.can_manage && item.source == ItemSource::Meal {
        item.source = ItemSource::Manual;
    }
    Ok(())
}
