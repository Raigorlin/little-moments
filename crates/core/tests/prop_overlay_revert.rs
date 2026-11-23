//! Property 11 的屬性測試（任務 9.7；需求 13.6、13.8、33.5、33.6）：回復不留下殘留。
//!
//! 輸入是已確認狀態（`arb_valid_state()`）、送出命令的身分（`arb_sender_caps()`）、0–6 個 Pending_Command
//! （`arb_command()`，可能在它的位置不成立）與被拒絕的命令 k。檢查：
//!
//! - pending 為空時，`overlay()` 等於已確認狀態（需求 13.6）。
//! - 移除 k 之後的 `overlay()`，等於另一個從來沒有 k 的佇列（其餘命令依原本的順序，Command_Id 不同）的 `overlay()`
//!   （需求 13.8）。
//! - k 在它的位置不成立或沒有變化（從來沒有顯示在畫面上）時，移除它不改變畫面。
//! - k 是最後一個時，移除它之後的畫面等於送出 k 之前的畫面。
//!
//! 使用 proptest 的預設設定（256 個案例，設定 `PROPTEST_CASES=N` 時為 N 個），不覆寫案例數；proptest 找到的失敗案例
//! 寫在同一個目錄的 `prop_overlay_revert.proptest-regressions`，這個檔案提交進版本庫（需求 33.6）。

mod support;

use lm_core::apply::{apply, Ctx, Mode, NoDerivedIds};
use lm_core::command::Command;
use lm_core::ids::CommandId;
use lm_core::model::TripState;
use lm_core::sync::{overlay, PendingCmd};
use proptest::collection::vec;
use proptest::prelude::*;
use proptest::sample::Index;
use uuid::Uuid;

use support::commands::{arb_command, arb_sender_caps, arb_valid_state, ctx_of};

fn arb_case() -> impl Strategy<Value = (TripState, Ctx, Vec<Command>, Index)> {
    arb_valid_state().prop_flat_map(|confirmed| {
        let ctx = arb_sender_caps(&confirmed).prop_map(ctx_of);
        let pending = vec(arb_command(&confirmed), 0..=6);
        (Just(confirmed), ctx, pending, any::<Index>())
    })
}

/// 依序以 `first`、`first + 1`… 作為 Command_Id 的 Pending_Command。
fn queue(commands: impl IntoIterator<Item = Command>, first: u128) -> Vec<PendingCmd> {
    commands
        .into_iter()
        .zip(first..)
        .map(|(command, id)| PendingCmd {
            id: CommandId(Uuid::from_u128(id)),
            command,
        })
        .collect()
}

// Feature: rust-supabase-rewrite, Property 11: 回復不留下殘留
proptest! {
    /// *For any* 已確認狀態、pending 命令序列與其中任一個被拒絕的命令 k，移除 k 之後的 `overlay()` 等於只以其餘命令
    /// 計算的 `overlay()`；pending 為空時 `overlay()` 等於已確認狀態。
    ///
    /// **Validates: Requirements 13.6, 13.8**
    #[test]
    fn reverting_a_rejected_command_leaves_no_residue(
        (confirmed, ctx, commands, which) in arb_case(),
    ) {
        prop_assert_eq!(&overlay(&confirmed, &[], &ctx), &confirmed);
        if commands.is_empty() {
            return Ok(());
        }
        let pending = queue(commands, 1);
        let k = which.index(pending.len());
        let mut remaining = pending.clone();
        let rejected = remaining.remove(k);
        let reverted = overlay(&confirmed, &remaining, &ctx);

        // 只以其餘命令計算：另一個從來沒有 k 的佇列
        let others = queue(remaining.iter().map(|op| op.command.clone()), 1_000);
        prop_assert_eq!(&reverted, &overlay(&confirmed, &others, &ctx), "移除第 {} 個命令 {:?}", k, rejected.command);

        // k 從來沒有顯示在畫面上時，移除它不改變畫面
        let before_k = overlay(&confirmed, &pending[..k], &ctx);
        let shown = apply(&before_k, &ctx, Mode::Predict, &mut NoDerivedIds, &rejected.command)
            .is_ok_and(|outcome| !outcome.primary.is_empty());
        if !shown {
            prop_assert_eq!(&reverted, &overlay(&confirmed, &pending, &ctx), "沒有顯示的命令 {:?}", rejected.command);
        }

        // k 是最後一個時，回到送出 k 之前的畫面
        if k + 1 == pending.len() {
            prop_assert_eq!(&reverted, &before_k);
        }
    }
}
