//! Property 10 的屬性測試（任務 8.12；需求 13.4、13.5、25.2、33.5、33.6）：前端預測與伺服器的主要效果相同。
//!
//! 輸入是 `arb_valid_state()`、`arb_caps()` 的五種身分與 `arb_command()` 的任何命令；同一份狀態分別以
//! `Mode::Predict`（`NoDerivedIds`，不執行採買同步）與 `Mode::Commit` 執行。檢查：
//!
//! - 兩者都成功時主要效果相同，Predict 的衍生效果是空的，Predict 新增的列是 Commit 新增的列的開頭（Commit 另外依
//!   採買同步新增 Meal_Item）。
//! - Predict 失敗則 Commit 也失敗。
//! - Commit 只會在採買同步超過 1000 項時比 Predict 多一種失敗（`shopping_limit`）。
//!
//! Unbound_Admin 的 Replica 不含 Ledger_Rows，他的預測與提交不是同一份狀態（需求 13.5），不在本屬性的範圍內；這裡的
//! 兩次執行一律使用同一份狀態。
//!
//! 使用 proptest 的預設設定（256 個案例，設定 `PROPTEST_CASES=N` 時為 N 個），不覆寫案例數；proptest 找到的失敗案例
//! 寫在同一個目錄的 `prop_predict_commit.proptest-regressions`，這個檔案提交進版本庫（需求 33.6）。

mod support;

use lm_core::apply::{apply, Mode, NoDerivedIds};
use lm_core::command::{Command, Rejection};
use lm_core::ingredients::ShoppingLimitExceeded;
use lm_core::model::TripState;
use lm_core::rules::Capabilities;
use proptest::prelude::*;

use support::commands::{arb_caps, arb_command, arb_valid_state, ctx_of, CommitIds, Identity};

fn arb_case() -> impl Strategy<Value = (TripState, (Identity, Capabilities), Command)> {
    arb_valid_state().prop_flat_map(|state| {
        let caps = arb_caps(&state);
        let command = arb_command(&state);
        (Just(state), caps, command)
    })
}

// Feature: rust-supabase-rewrite, Property 10: 前端預測與伺服器的主要效果相同
proptest! {
    /// *For any* s、caps 與命令 c，`apply(s, Predict)` 與 `apply(s, Commit)` 都成功時兩者的 `primary` 相同，且 Predict
    /// 的 `derived` 為空；Predict 失敗則 Commit 也失敗；Commit 只會在採買同步超過 1000 項時比 Predict 多一種失敗。
    ///
    /// **Validates: Requirements 13.4, 13.5, 25.2**
    #[test]
    fn predict_and_commit_share_the_primary_effects((state, (identity, caps), cmd) in arb_case()) {
        let ctx = ctx_of(caps);
        let predicted = apply(&state, &ctx, Mode::Predict, &mut NoDerivedIds, &cmd);
        let committed = apply(&state, &ctx, Mode::Commit, &mut CommitIds::default(), &cmd);
        match (&predicted, &committed) {
            (Ok(predicted), Ok(committed)) => {
                prop_assert_eq!(&predicted.primary, &committed.primary, "{:?} 送出 {:?}", identity, cmd);
                prop_assert!(predicted.derived.is_empty(), "Predict 不應該有衍生效果：{:?}", predicted.derived);
                prop_assert!(
                    committed.created.starts_with(&predicted.created),
                    "Predict 新增的列 {:?} 應該是 Commit 新增的列 {:?} 的開頭",
                    predicted.created,
                    committed.created
                );
            }
            (Err(rejection), Ok(_)) => {
                prop_assert!(false, "Predict 以 {:?} 拒絕 {:?}，Commit 卻成功", rejection, cmd);
            }
            (Ok(_), Err(rejection)) => {
                let limit = matches!(
                    rejection,
                    Rejection::Conflict { code, .. } if code == ShoppingLimitExceeded::CODE
                );
                prop_assert!(limit, "Commit 只會多出採買品項上限的拒絕：{:?} 送出 {:?}", rejection, cmd);
            }
            (Err(_), Err(_)) => {}
        }
    }
}
