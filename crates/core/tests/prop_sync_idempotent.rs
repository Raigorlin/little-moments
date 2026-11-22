//! Property 4（任務 5.6）：採買同步冪等（需求 25.14）。
//!
//! 對 `arb_state()` 產生的狀態 s 執行採買同步，把它的計畫套用到 s 得到 s′，再對 s′ 執行一次：第二次的計畫沒有要寫入或
//! 刪除的品項。`arb_state()` 刻意不滿足 I9（料理需要的食材不一定被涵蓋、未買的 Meal_Item 可能沒有連動料理，連動的
//! 料理也不一定需要它），所以第一次同步通常會新增、刪除與修改品項。
//!
//! s′ 檢查兩種：`SyncPlan::apply_to()` 的結果，新增的 Meal_Item 仍是暫時的 ordinal 0，排在其他品項之前；以及 LM_Server
//! 提交的結果，新增的 Meal_Item 依 `plan.created` 的順序取得 s 的所有列之後的 ordinal，排在最後，與 `execute()` 相同
//! （需求 7.19）。同一個測試案例的每次同步都使用同一個 `SeqIds`，所以不會回傳 s′ 中已有的 id。
//!
//! `arb_state()` 最多有 15 個採買品項與 8 道料理（每道最多 6 個食材），同步之後遠低於 1000 項，所以採買同步回傳超過
//! 上限的錯誤時視為失敗。

mod support;

use lm_core::ingredients::{sync_meal_ingredients, SyncPlan};
use lm_core::model::TripState;
use proptest::prelude::*;

use support::ids::SeqIds;
use support::state::arb_state;

// Feature: rust-supabase-rewrite, Property 4: 採買同步冪等
proptest! {
    #[test]
    fn shopping_sync_is_idempotent(state in arb_state()) {
        let mut ids = SeqIds::new();
        let plan = sync(&state, &mut ids)?;
        let forms = [
            ("apply_to() 的結果", applied(&state, &plan)),
            ("提交的結果", committed(&state, &plan)),
        ];
        for (form, synced) in forms {
            let again = sync(&synced, &mut ids)?;
            prop_assert!(
                again.upserts.is_empty(),
                "{form}再同步一次，仍要寫入品項：{:#?}",
                again.upserts
            );
            prop_assert!(
                again.deletes.is_empty(),
                "{form}再同步一次，仍要刪除品項：{:?}",
                again.deletes
            );
        }
    }
}

/// 採買同步。`arb_state()` 的狀態同步之後遠低於 1000 項，所以超過上限的錯誤是失敗。
fn sync(state: &TripState, ids: &mut SeqIds) -> Result<SyncPlan, TestCaseError> {
    sync_meal_ingredients(state, ids)
        .map_err(|error| TestCaseError::fail(format!("採買同步失敗：{error}")))
}

/// `state` 套用 `plan` 的結果：`SyncPlan::apply_to()` 寫入與刪除品項，並清除連結到被刪除品項的支出的採買連結；
/// 新增的 Meal_Item 仍是暫時的 ordinal 0。
fn applied(state: &TripState, plan: &SyncPlan) -> TripState {
    let mut synced = state.clone();
    plan.apply_to(&mut synced);
    synced
}

/// LM_Server 提交 `plan` 的結果：`applied()`，再讓新增的 Meal_Item 依 `plan.created` 的順序取得 `state` 的所有列之後的
/// ordinal，與 `execute()` 相同（需求 7.19）。Row_Version 不影響採買同步，所以不改。
fn committed(state: &TripState, plan: &SyncPlan) -> TripState {
    let mut synced = applied(state, plan);
    for (ordinal, id) in (state.max_ordinal() + 1..).zip(&plan.created) {
        let item = synced.shopping.get_mut(id).expect("新增的品項已寫入");
        item.ordinal = ordinal;
    }
    synced
}
