//! Property 6（任務 5.8）：採買同步之後，每道料理需要的每個食材都由某個採買品項涵蓋，而且新增的品項數不超過
//! 同步前沒有被涵蓋的鍵數（需求 9.10、25.6、25.7、25.8）。
//!
//! 料理需要的鍵是料理的食材文字經 Ingredient_Parser 切出的每個名稱的 Ingredient_Key；品項涵蓋一個鍵，是指品項名稱
//! 經 Ingredient_Parser 切出的名稱中，有一個的 Ingredient_Key 等於這個鍵（需求 25.6：「甜椒、玉米」涵蓋「甜椒」與
//! 「玉米」，「雞 蛋」涵蓋「雞蛋」）。`arb_state()` 不保證 I9，所以同步前常有沒有被涵蓋的鍵、同一個鍵的不同寫法、
//! 名稱含兩個食材的品項，以及不再被需要的品項。

mod support;

use std::collections::BTreeSet;

use lm_core::ingredients::{ingredient_key, parse_ingredients, sync_meal_ingredients, SyncPlan};
use lm_core::limits::SHOPPING_ITEMS_MAX;
use lm_core::model::TripState;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;

use support::ids::SeqIds;
use support::state::arb_state;

// Feature: rust-supabase-rewrite, Property 6: 採買同步涵蓋每一個需要的食材
// **Validates: Requirements 9.10, 25.6, 25.7, 25.8**
proptest! {
    /// *For any* 狀態 s，套用同步之後，每道料理的 `parse_ingredients(ingredients)` 中每個名稱的 `ingredient_key`，
    /// 都等於某個品項名稱切分後的某個鍵；新增的品項數不超過同步前未被涵蓋的鍵數。
    #[test]
    fn shopping_sync_covers_every_needed_ingredient(state in arb_state()) {
        check_sync_coverage(&state)?;
    }
}

/// 對 `state` 執行一次採買同步並套用，檢查 Property 6 的兩個條件。
fn check_sync_coverage(state: &TripState) -> Result<(), TestCaseError> {
    // 同步前：料理需要的鍵中，沒有被任何品項涵蓋的鍵
    let uncovered: BTreeSet<String> = needed_keys(state)
        .difference(&covered_keys(state))
        .cloned()
        .collect();

    // 每個測試案例一個 SeqIds：新品項的 id 不與狀態中的任何一列重複
    let mut ids = SeqIds::new();
    let plan = match sync_meal_ingredients(state, &mut ids) {
        Ok(plan) => plan,
        Err(error) => {
            // 需求 25.15：同步之後會超過 1000 項時整個同步被拒絕，沒有「套用同步之後」的狀態，這個屬性不適用。
            // 留下的品項不超過同步前的品項數，新增的品項每個沒有被涵蓋的鍵最多一個，所以拒絕時兩者的和一定超過
            // 上限。arb_state() 最多 15 個品項與 8 道料理，不會走到這裡。
            let items = state.shopping.len();
            let keys = uncovered.len();
            prop_assert!(
                items + keys > SHOPPING_ITEMS_MAX,
                "同步前有 {items} 個品項、{keys} 個沒有被涵蓋的鍵，沒有超過 {SHOPPING_ITEMS_MAX} 項卻被拒絕：{error}"
            );
            return Ok(());
        }
    };
    let synced = applied(state, &plan);

    // 套用同步之後：每道料理切出的每個名稱的鍵，都是某個品項名稱切分後的某個鍵（需求 9.10、25.6）
    let covered = covered_keys(&synced);
    for meal in synced.meals_by_ordinal() {
        for name in parse_ingredients(&meal.ingredients) {
            let key = ingredient_key(&name);
            prop_assert!(
                covered.contains(&key),
                "料理 {} 的食材 {:?} 切出 {name:?}（鍵 {key:?}），同步之後沒有品項涵蓋它；品項：{:?}",
                meal.id,
                meal.ingredients,
                item_names(&synced)
            );
        }
    }

    // 新增的品項（同步之後才有的列）不超過同步前沒有被涵蓋的鍵數（需求 25.7、25.8）
    let added: Vec<&str> = synced
        .shopping
        .values()
        .filter(|item| !state.shopping.contains_key(&item.id))
        .map(|item| item.name.as_str())
        .collect();
    prop_assert!(
        added.len() <= uncovered.len(),
        "新增了 {} 個品項 {added:?}，但同步前只有 {} 個鍵沒有被涵蓋：{uncovered:?}",
        added.len(),
        uncovered.len()
    );
    Ok(())
}

/// 料理需要的每個 Ingredient_Key：每道料理的食材文字經 Ingredient_Parser 切出的每個名稱的鍵。
fn needed_keys(state: &TripState) -> BTreeSet<String> {
    state
        .meals
        .values()
        .flat_map(|meal| parse_ingredients(&meal.ingredients))
        .map(|name| ingredient_key(&name))
        .collect()
}

/// 採買品項涵蓋的每個 Ingredient_Key：每個品項名稱經 Ingredient_Parser 切出的每個名稱的鍵。
fn covered_keys(state: &TripState) -> BTreeSet<String> {
    state
        .shopping
        .values()
        .flat_map(|item| parse_ingredients(&item.name))
        .map(|name| ingredient_key(&name))
        .collect()
}

/// `state` 套用採買同步的計畫 `plan` 之後的狀態。
fn applied(state: &TripState, plan: &SyncPlan) -> TripState {
    let mut synced = state.clone();
    plan.apply_to(&mut synced);
    synced
}

/// 每個品項的名稱，依 Ordinal；失敗訊息用。
fn item_names(state: &TripState) -> Vec<&str> {
    state
        .shopping_by_ordinal()
        .map(|item| item.name.as_str())
        .collect()
}
