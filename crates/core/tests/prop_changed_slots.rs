//! Property 3 的屬性測試（任務 9.6；需求 14.1、33.5、33.6）：只回報內容真的改變的列。
//!
//! `ModelServer::run()` 與 `arb_delivery_plan()` 產生一串事件（Change_Set 任意排列與重複，夾雜任意 Seq 的
//! Snapshot），檢視者是 Trip_Owner 或 Unbound_Admin（不含 Ledger_Rows）；`Replica` 依序處理。依序處理的過程經過
//! 各種狀態的 Replica（亂序、重複、有缺號、與 Snapshot 重疊），每個事件都是一次「任意 Replica 與任意變更集或快照」。
//! 每處理一個事件，都比較處理前後每個 Slot 的 `state.get(slot)`（包括 Row_Version）：`ApplyReport.changed` 作為集合
//! 恰好等於內容不同的 Slot，而且每個 Slot 只出現一次。
//!
//! 使用 proptest 的預設設定（256 個案例，設定 `PROPTEST_CASES=N` 時為 N 個），不覆寫案例數；proptest 找到的失敗案例
//! 寫在同一個目錄的 `prop_changed_slots.proptest-regressions`，這個檔案提交進版本庫（需求 33.6）。

mod support;

use std::collections::BTreeSet;

use lm_core::model::{Slot, TripState};
use lm_core::sync::Replica;
use proptest::prelude::*;

use support::model_server::{
    arb_delivery_plan, arb_script, unbound_admin_snapshot, Delivery, ModelServer,
};

/// `before` 與 `after` 中 `get(slot)` 不同的 Slot（一邊沒有這一列也算）。
fn differing_slots(before: &TripState, after: &TripState) -> BTreeSet<Slot> {
    before
        .slots()
        .chain(after.slots())
        .filter(|&slot| before.get(slot) != after.get(slot))
        .collect()
}

// Feature: rust-supabase-rewrite, Property 3: 只回報內容真的改變的列
proptest! {
    /// *For any* `Replica` 與任何變更集或快照，`ApplyReport.changed` 作為集合，恰好等於「套用前後 `state.get(slot)`
    /// 不同」的 Slot 集合。
    ///
    /// **Validates: Requirements 14.1**
    #[test]
    fn apply_report_lists_exactly_the_changed_slots(
        script in arb_script(),
        plan in arb_delivery_plan(),
        unbound_admin in any::<bool>(),
    ) {
        let server = ModelServer::run(&script);
        let start = if unbound_admin {
            unbound_admin_snapshot(server.snapshot_at(0))
        } else {
            server.snapshot_at(0)
        };
        let mut replica = Replica::from_snapshot(&start).expect("Snapshot 有 Trip_Card");
        for event in plan.schedule(&server) {
            let event = if unbound_admin { event.for_unbound_admin() } else { event };
            let before = replica.state.clone();
            let report = match &event {
                Delivery::Change(cs) => replica.apply_changeset(cs),
                Delivery::Snapshot(snapshot) => replica.apply_snapshot(snapshot),
            };
            let reported: BTreeSet<Slot> = report.changed.iter().copied().collect();
            prop_assert_eq!(
                reported.len(),
                report.changed.len(),
                "同一個 Slot 回報了不只一次：{:?}",
                report.changed
            );
            prop_assert_eq!(reported, differing_slots(&before, &replica.state), "事件 {:?}", event);
        }
    }
}
