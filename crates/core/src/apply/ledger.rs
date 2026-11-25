//! 分帳：`AddExpense`、`UpdateExpense`、`RemoveExpense`、`AddSettlement`、`UpdateSettlement`、`RemoveSettlement`
//! （需求 29）。

use unicode_normalization::UnicodeNormalization;

use crate::command::{
    ExpenseDraft, ExpensePatch, Input, Rejection, SettlementDraft, SettlementPatch, LIMIT_REACHED,
};
use crate::ids::{ExpenseId, PersonId, SettlementId};
use crate::ledger::check_amount_cents;
use crate::limits::{EXPENSES_MAX, EXPENSE_TITLE_CHARS, LEDGER_NOTE_CHARS, SETTLEMENTS_MAX};
use crate::model::{Date, Entity, Expense, ExpenseCategory, Settlement, Slot, TripState};
use crate::text::{has_control_chars, trim_white};

use super::common::{ensure_new, fits, next_ordinal};
use super::slot;

/// 標題與備註先 NFC 再 Trim_White（需求 29.2）。
fn normalized(text: &str) -> String {
    trim_white(&text.nfc().collect::<String>()).to_owned()
}

/// 帳目的日期：年份 0001–9999 的有效日期（需求 29.2、29.3）。
fn valid_day(day: Date) -> bool {
    (1..=9999).contains(&day.year())
}

/// 金額：1–100,000,000 分（需求 29.5）。
fn amount(cents: i64) -> Result<i64, Rejection> {
    check_amount_cents(cents).map_err(|error| Rejection::invalid("amount_cents", error.to_string()))
}

/// 備註（需求 29.2）：最多 500 字，不含 LF、CRLF 與 Tab 以外的 Hidden_Control_Char。
fn checked_note(note: &str) -> Result<(), Rejection> {
    if !fits(note, LEDGER_NOTE_CHARS) {
        return Err(Rejection::invalid("note", "備註最多 500 字。"));
    }
    let without_breaks = note.replace("\r\n", " ").replace(['\n', '\t'], " ");
    if has_control_chars(&without_breaks) {
        return Err(Rejection::invalid("note", "備註不能包含隱藏控制字元。"));
    }
    Ok(())
}

/// 以新增或套用修改之後的支出依需求 29.2 的順序檢查；標題與備註已經過正規化。
fn check_expense(
    d: &TripState,
    expense: &Expense,
    payer: Option<PersonId>,
    category: Option<&Input<ExpenseCategory>>,
) -> Result<ExpenseCategory, Rejection> {
    if expense.title.is_empty() || !fits(&expense.title, EXPENSE_TITLE_CHARS) {
        return Err(Rejection::invalid("title", "請填寫 1–100 字的項目名稱。"));
    }
    if has_control_chars(&expense.title) {
        return Err(Rejection::invalid(
            "title",
            "項目名稱不能包含隱藏控制字元。",
        ));
    }
    if !valid_day(expense.day) {
        return Err(Rejection::invalid("day", "請選擇有效的日期。"));
    }
    amount(expense.amount_cents)?;
    match payer {
        None => return Err(Rejection::invalid("payer", "請選擇付款人。")),
        Some(payer) if !d.people.contains_key(&payer) => {
            return Err(Rejection::invalid(
                "payer",
                "付款人不是這趟旅行目前的旅伴。",
            ))
        }
        Some(_) => {}
    }
    if expense.participants.is_empty() {
        return Err(Rejection::invalid(
            "participants",
            "請至少選擇一位分攤的旅伴。",
        ));
    }
    if !expense
        .participants
        .iter()
        .all(|p| d.people.contains_key(p))
    {
        return Err(Rejection::invalid(
            "participants",
            "分攤旅伴不是這趟旅行目前的旅伴。",
        ));
    }
    let category = match category {
        None => expense.category,
        Some(input) => input
            .ok()
            .copied()
            .ok_or_else(|| Rejection::invalid("category", "請選擇分類。"))?,
    };
    checked_note(&expense.note)?;
    if expense
        .shopping_item
        .is_some_and(|item| !d.shopping.contains_key(&item))
    {
        return Err(Rejection::invalid(
            "shopping_item",
            "找不到連結的採買品項，請重新選擇。",
        ));
    }
    Ok(category)
}

/// `AddExpense`：依需求 29.2 檢查；已有 1000 筆時 409（需求 29.4）。
pub(super) fn add_expense(
    d: &mut TripState,
    id: ExpenseId,
    draft: &ExpenseDraft,
) -> Result<Vec<Slot>, Rejection> {
    ensure_new(&d.expenses, &id)?;
    let mut expense = Expense {
        id,
        day: draft.day,
        title: normalized(&draft.title),
        amount_cents: draft.amount_cents,
        payer: draft.payer.unwrap_or(PersonId(uuid::Uuid::nil())),
        participants: draft.participants.clone(),
        category: ExpenseCategory::Other,
        note: normalized(&draft.note),
        shopping_item: draft.shopping_item,
        ordinal: next_ordinal(d),
        version: 0,
    };
    expense.category = check_expense(d, &expense, draft.payer, Some(&draft.category))?;
    if d.expenses.len() >= EXPENSES_MAX {
        return Err(Rejection::conflict(LIMIT_REACHED, "支出最多 1000 筆。"));
    }
    d.expenses.insert(id, expense);
    Ok(vec![slot(Entity::Expense, id.0)])
}

/// `UpdateExpense`：不存在時 404；只更新帶有的欄位，分攤旅伴以加入與移除套用（需求 29.2）。
pub(super) fn update_expense(
    d: &mut TripState,
    id: ExpenseId,
    patch: &ExpensePatch,
) -> Result<(), Rejection> {
    let Some(current) = d.expenses.get(&id) else {
        return Err(Rejection::not_found("找不到這筆支出。"));
    };
    let mut expense = current.clone();
    if let Some(day) = patch.day {
        expense.day = day;
    }
    if let Some(title) = &patch.title {
        expense.title = normalized(title);
    }
    if let Some(cents) = patch.amount_cents {
        expense.amount_cents = cents;
    }
    if let Some(payer) = patch.payer {
        expense.payer = payer;
    }
    expense.participants.extend(&patch.participants_add);
    expense
        .participants
        .retain(|person| !patch.participants_remove.contains(person));
    if let Some(note) = &patch.note {
        expense.note = normalized(note);
    }
    if let Some(item) = patch.shopping_item {
        expense.shopping_item = item;
    }
    expense.category = check_expense(d, &expense, Some(expense.payer), patch.category.as_ref())?;
    d.expenses.insert(id, expense);
    Ok(())
}

/// 以新增或套用修改之後的還款依需求 29.3 的順序檢查；備註已經過正規化。
fn check_settlement(
    d: &TripState,
    settlement: &Settlement,
    from: Option<PersonId>,
    to: Option<PersonId>,
) -> Result<(), Rejection> {
    let (Some(from), Some(to)) = (from, to) else {
        return Err(Rejection::invalid("from", "請選擇付款與收款的旅伴。"));
    };
    if !d.people.contains_key(&from) {
        return Err(Rejection::invalid("from", "付款人不是這趟旅行目前的旅伴。"));
    }
    if !d.people.contains_key(&to) {
        return Err(Rejection::invalid("to", "收款人不是這趟旅行目前的旅伴。"));
    }
    if from == to {
        return Err(Rejection::invalid("to", "付款人與收款人不能是同一位。"));
    }
    amount(settlement.amount_cents)?;
    if !valid_day(settlement.day) {
        return Err(Rejection::invalid("day", "請選擇還款日期。"));
    }
    checked_note(&settlement.note)
}

/// `AddSettlement`：依需求 29.3 檢查；已有 1000 筆時 409（需求 29.4）。
pub(super) fn add_settlement(
    d: &mut TripState,
    id: SettlementId,
    draft: &SettlementDraft,
) -> Result<Vec<Slot>, Rejection> {
    ensure_new(&d.settlements, &id)?;
    let nobody = PersonId(uuid::Uuid::nil());
    let settlement = Settlement {
        id,
        day: draft.day,
        from: draft.from.unwrap_or(nobody),
        to: draft.to.unwrap_or(nobody),
        amount_cents: draft.amount_cents,
        note: normalized(&draft.note),
        ordinal: next_ordinal(d),
        version: 0,
    };
    check_settlement(d, &settlement, draft.from, draft.to)?;
    if d.settlements.len() >= SETTLEMENTS_MAX {
        return Err(Rejection::conflict(LIMIT_REACHED, "還款紀錄最多 1000 筆。"));
    }
    d.settlements.insert(id, settlement);
    Ok(vec![slot(Entity::Settlement, id.0)])
}

/// `UpdateSettlement`：不存在時 404；只更新帶有的欄位。
pub(super) fn update_settlement(
    d: &mut TripState,
    id: SettlementId,
    patch: &SettlementPatch,
) -> Result<(), Rejection> {
    let Some(current) = d.settlements.get(&id) else {
        return Err(Rejection::not_found("找不到這筆還款。"));
    };
    let mut settlement = current.clone();
    if let Some(day) = patch.day {
        settlement.day = day;
    }
    if let Some(from) = patch.from {
        settlement.from = from;
    }
    if let Some(to) = patch.to {
        settlement.to = to;
    }
    if let Some(cents) = patch.amount_cents {
        settlement.amount_cents = cents;
    }
    if let Some(note) = &patch.note {
        settlement.note = normalized(note);
    }
    check_settlement(d, &settlement, Some(settlement.from), Some(settlement.to))?;
    d.settlements.insert(id, settlement);
    Ok(())
}

/// `RemoveExpense`：刪除支出與它的分攤旅伴；已不存在時沒有變化；其他帳目與採買品項不變（需求 29.9）。
pub(super) fn remove_expense(d: &mut TripState, id: ExpenseId) {
    d.expenses.remove(&id);
}

/// `RemoveSettlement`：已不存在時沒有變化（需求 29.9）。
pub(super) fn remove_settlement(d: &mut TripState, id: SettlementId) {
    d.settlements.remove(&id);
}
