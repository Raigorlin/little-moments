//! Property 5 的屬性測試（任務 5.7）：採買同步不刪除 Manual_Item 與已買的品項，也不改留下的品項中使用者管理的欄位；
//! 對帳目唯一的改變，是清除連結到被刪除品項的支出的採買連結（需求 25.10、25.11、25.19、29.13）。
//!
//! 輸入是共用產生器 `arb_state()` 的狀態：滿足 I1–I8、I10–I12，刻意不保證 I9。所以料理需要的食材不一定被涵蓋，
//! 未買的 Meal_Item 可能已沒有料理需要，已買的 Meal_Item 可能失去料理，支出也可能連結會被刪除的品項；這些正是採買同步
//! 會刪除品項、改變來源與清除支出連結的情況。

mod support;

use std::collections::BTreeSet;

use lm_core::ids::{PersonId, ShoppingId};
use lm_core::ingredients::{sync_meal_ingredients, SyncPlan};
use lm_core::model::{Category, Expense, ItemSource, ShoppingItem, TripState};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;

use support::ids::SeqIds;
use support::state::arb_state;

proptest! {
    // Feature: rust-supabase-rewrite, Property 5: 採買同步不刪除手動與已買的品項，也不改使用者管理的欄位
    /// 對任何狀態 s：`sync_meal_ingredients(s).deletes` 中沒有 `source == Manual` 或 `purchased == true` 的品項；
    /// 以 `SyncPlan::apply_to()` 套用之後，每個留下的品項的名稱、數量、分類、負責人與已買狀態都與 s 相同；帳目唯一的
    /// 改變是連結到被刪除品項的支出改為不連結採買品項：沒有任何支出連結到不存在的品項，這些支出的其他欄位、其他支出與
    /// 還款都與 s 相同。
    ///
    /// **Validates: Requirements 25.10, 25.11, 25.19, 29.13**
    #[test]
    fn sync_keeps_manual_and_bought_items_their_user_fields_and_the_ledger(state in arb_state()) {
        // 每個測試案例使用一個 SeqIds：它回傳的 id 不與 arb_state() 產生的任何一列重複
        let mut ids = SeqIds::new();
        let plan = sync(&state, &mut ids)?;
        let mut synced = state.clone();
        plan.apply_to(&mut synced);

        let deleted: BTreeSet<ShoppingId> = plan.deletes.iter().copied().collect();
        check_deletes(&state, &plan.deletes)?;
        check_kept_items(&state, &deleted, &synced)?;
        check_ledger(&state, &deleted, &synced)?;
    }
}

/// 執行採買同步。`arb_state()` 最多 15 個品項與 8 道料理，每道料理的食材文字最多切出 6 個名稱，所以留下的品項加上
/// 新增的 Meal_Item 遠低於 1000 項的上限（需求 25.15）：這裡不會遇到超過上限的拒絕，遇到就是錯誤。
fn sync(state: &TripState, ids: &mut SeqIds) -> Result<SyncPlan, TestCaseError> {
    sync_meal_ingredients(state, ids).map_err(|error| {
        TestCaseError::fail(format!("採買同步拒絕了遠低於品項上限的狀態：{error}"))
    })
}

/// 被刪除的品項都在同步前的狀態中，而且沒有 Manual_Item，也沒有已買的品項（需求 25.10、25.11）。
fn check_deletes(state: &TripState, deletes: &[ShoppingId]) -> Result<(), TestCaseError> {
    for id in deletes {
        let Some(item) = state.shopping.get(id) else {
            return Err(TestCaseError::fail(format!(
                "刪除的品項 {id} 不在同步前的狀態中"
            )));
        };
        prop_assert!(
            item.source != ItemSource::Manual && !item.purchased,
            "採買同步刪除了 Manual_Item 或已買的品項：{item:?}"
        );
    }
    Ok(())
}

/// 套用之後，每個留下的品項（同步前的品項中不在 `deleted` 的）都還在，名稱、數量、分類、負責人與已買狀態都與同步前
/// 相同（需求 25.11）。
fn check_kept_items(
    state: &TripState,
    deleted: &BTreeSet<ShoppingId>,
    synced: &TripState,
) -> Result<(), TestCaseError> {
    for (id, before) in &state.shopping {
        if deleted.contains(id) {
            continue;
        }
        let Some(after) = synced.shopping.get(id) else {
            return Err(TestCaseError::fail(format!(
                "沒有列在 deletes 的品項 {id} 在套用之後不見了"
            )));
        };
        prop_assert_eq!(
            user_fields(after),
            user_fields(before),
            "品項 {} 的使用者管理的欄位改變了",
            id
        );
    }
    Ok(())
}

/// 帳目唯一的改變，是連結到被刪除品項的支出改為不連結採買品項（需求 25.19、29.13）：支出的集合不變，這些支出的其他
/// 欄位與其他支出都與同步前相同，還款也不變；套用之後沒有任何支出連結到不存在的品項。
fn check_ledger(
    state: &TripState,
    deleted: &BTreeSet<ShoppingId>,
    synced: &TripState,
) -> Result<(), TestCaseError> {
    prop_assert_eq!(
        synced.expenses.keys().collect::<Vec<_>>(),
        state.expenses.keys().collect::<Vec<_>>(),
        "採買同步新增或刪除了支出"
    );
    for (id, before) in &state.expenses {
        let expected = Expense {
            shopping_item: before.shopping_item.filter(|item| !deleted.contains(item)),
            ..before.clone()
        };
        prop_assert_eq!(&synced.expenses[id], &expected, "支出 {}", id);
    }
    for expense in synced.expenses.values() {
        if let Some(item) = expense.shopping_item {
            prop_assert!(
                synced.shopping.contains_key(&item),
                "支出 {} 連結到不存在的採買品項 {}",
                expense.id,
                item
            );
        }
    }
    prop_assert_eq!(
        &synced.settlements,
        &state.settlements,
        "採買同步改變了還款"
    );
    Ok(())
}

/// 採買品項中使用者管理的欄位：採買同步留下品項時，這些欄位都不改變。
#[derive(Debug, PartialEq)]
struct UserFields<'a> {
    name: &'a str,
    quantity: &'a str,
    category: Category,
    assignee: Option<PersonId>,
    purchased: bool,
}

fn user_fields(item: &ShoppingItem) -> UserFields<'_> {
    UserFields {
        name: &item.name,
        quantity: &item.quantity,
        category: item.category,
        assignee: item.assignee,
        purchased: item.purchased,
    }
}
