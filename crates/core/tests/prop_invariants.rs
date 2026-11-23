//! Property 9 的屬性測試（任務 8.11；需求 7.15、9.1–9.13、19.10、33.5、33.6）：成功的命令一定保持不變式。
//!
//! 輸入狀態是 `arb_valid_state()`：`arb_state()` 先以 `sync_meal_ingredients()` 套用一次，並確認它滿足
//! `validate::state(…, Mode::Commit)`。身分是 `arb_caps()` 的五種之一，命令是 `arb_command()` 的任何命令（包括不合法
//! 的命令）。`apply(s, Commit)` 回傳 `Ok(o)` 時：
//!
//! - `validate::state(s ⊕ o.effects(), Commit)` 成立（I1–I12；移除旅伴之後沒有任何引用指向他，需求 19.10）；
//! - 主要效果與衍生效果中每個 Slot 各最多一筆；
//! - `o.created` 恰好是效果中新增、而且有 Ordinal 的列，每個 Slot 一次，它們的暫時 Ordinal 都大於 s 中最大的
//!   Ordinal，而且依 `o.created` 的順序遞增（需求 7.18、7.19）。
//!
//! 回傳 `Err` 時 s 不變：`apply()` 以唯讀參照取得狀態，型別已保證這一點，這裡另外確認命令前後的狀態相同。
//!
//! 使用 proptest 的預設設定（256 個案例，設定 `PROPTEST_CASES=N` 時為 N 個），不覆寫案例數；proptest 找到的失敗案例
//! 寫在同一個目錄的 `prop_invariants.proptest-regressions`，這個檔案提交進版本庫（需求 33.6）。

mod support;

use std::collections::BTreeSet;

use lm_core::apply::{apply, Effect, Mode};
use lm_core::command::Command;
use lm_core::model::{Slot, TripState};
use lm_core::rules::Capabilities;
use lm_core::validate;
use proptest::prelude::*;

use support::commands::{arb_caps, arb_command, arb_valid_state, ctx_of, CommitIds, Identity};

fn arb_case() -> impl Strategy<Value = (TripState, (Identity, Capabilities), Command)> {
    arb_valid_state().prop_flat_map(|state| {
        let caps = arb_caps(&state);
        let command = arb_command(&state);
        (Just(state), caps, command)
    })
}

/// 效果中的 Slot，依出現的順序。
fn slots(effects: &[Effect]) -> Vec<Slot> {
    effects.iter().map(Effect::slot).collect()
}

// Feature: rust-supabase-rewrite, Property 9: 成功的命令一定保持不變式
proptest! {
    /// *For any* 合法狀態 s、任何 `arb_caps()` 與任何 `arb_command(s)`（包含不合法的命令），`apply(s, Commit)` 回傳
    /// `Ok(o)` 時 `validate::state(s ⊕ o.effects(), Commit)` 成立（I1–I12）；回傳 `Err` 時 s 不變。
    ///
    /// **Validates: Requirements 7.15, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10, 9.11, 9.12, 9.13, 19.10**
    #[test]
    fn successful_commands_keep_every_invariant((state, (identity, caps), cmd) in arb_case()) {
        prop_assert_eq!(
            validate::state(&state, Mode::Commit),
            Ok(()),
            "arb_valid_state() 應該滿足 I1–I12"
        );
        let before = state.clone();
        let outcome = apply(&state, &ctx_of(caps), Mode::Commit, &mut CommitIds::default(), &cmd);
        prop_assert_eq!(&state, &before, "apply() 不應該改變輸入的狀態");
        let Ok(outcome) = outcome else {
            return Ok(());
        };

        let mut after = state.clone();
        after.apply_effects(&outcome.effects());
        prop_assert_eq!(
            validate::state(&after, Mode::Commit),
            Ok(()),
            "{:?} 送出 {:?} 之後違反不變式；效果：{:#?}",
            identity,
            cmd,
            outcome.effects()
        );

        for (name, effects) in [("主要效果", &outcome.primary), ("衍生效果", &outcome.derived)] {
            let listed = slots(effects);
            let unique: BTreeSet<Slot> = listed.iter().copied().collect();
            prop_assert_eq!(unique.len(), listed.len(), "{}中有重複的 Slot：{:?}", name, listed);
        }

        // created 恰好是新增、而且有 Ordinal 的列
        let new_rows: BTreeSet<Slot> = outcome
            .effects()
            .iter()
            .filter_map(|effect| match effect {
                Effect::Upsert(row) if row.has_ordinal() && state.get(row.slot()).is_none() => {
                    Some(row.slot())
                }
                _ => None,
            })
            .collect();
        let created: BTreeSet<Slot> = outcome.created.iter().copied().collect();
        prop_assert_eq!(created.len(), outcome.created.len(), "created 有重複的 Slot：{:?}", outcome.created);
        prop_assert_eq!(&created, &new_rows, "created 應該恰好是新增的列");
        let ordinals: Vec<u64> = outcome
            .created
            .iter()
            .map(|&slot| after.get(slot).and_then(|row| row.ordinal()).expect("新增的列有 Ordinal"))
            .collect();
        prop_assert!(
            ordinals.windows(2).all(|pair| pair[0] < pair[1])
                && ordinals.first().is_none_or(|&first| first > state.max_ordinal()),
            "新列的暫時 Ordinal 應該從 {} 之後依 created 的順序遞增：{:?}",
            state.max_ordinal(),
            ordinals
        );
    }
}
