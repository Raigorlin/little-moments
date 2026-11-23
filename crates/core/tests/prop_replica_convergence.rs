//! Property 1 的屬性測試（任務 9.4；需求 12.10、12.12、12.14、33.5、33.6）：任意送達順序都收斂到伺服器狀態。
//!
//! `ModelServer::run()` 依序以 `Mode::Commit` 執行 `arb_script()` 的命令，得到 Change_Set 1..=n 與每個 Seq 的
//! Snapshot。`Replica` 從 Seq 0 的 Snapshot 開始，依 `arb_delivery_plan()` 處理全部事件：Change_Set 任意排列與重複，
//! 在任意位置插入任意 Seq 的 Snapshot，Seq 不大於這些 Snapshot 中最大 Seq 的 Change_Set 可能沒有送達。處理完之後，
//! Replica 的狀態等於伺服器在 Seq n 的狀態，水位線等於 n；沒有 Pending_Command 時，畫面（`overlay()`）也等於伺服器的
//! 狀態（需求 12.14）。
//!
//! 檢視者是 Unbound_Admin 時，每則 Change_Set 移除 Ledger_Rows 的變化、Snapshot 不含 Ledger_Rows；結果等於伺服器的
//! 狀態去掉 Ledger_Rows，水位線同樣是 n（需求 6.12、6.13、12.12）。
//!
//! 使用 proptest 的預設設定（256 個案例，設定 `PROPTEST_CASES=N` 時為 N 個），不覆寫案例數；proptest 找到的失敗案例
//! 寫在同一個目錄的 `prop_replica_convergence.proptest-regressions`，這個檔案提交進版本庫（需求 33.6）。

mod support;

use lm_core::rules::Capabilities;
use lm_core::sync::{overlay, Replica};
use proptest::prelude::*;

use support::commands::ctx_of;
use support::model_server::{
    arb_delivery_plan, arb_script, unbound_admin_snapshot, without_ledger_rows, Delivery,
    ModelServer,
};

/// 依序處理每個事件。
fn deliver(replica: &mut Replica, events: impl IntoIterator<Item = Delivery>) {
    for event in events {
        match event {
            Delivery::Change(cs) => {
                replica.apply_changeset(&cs);
            }
            Delivery::Snapshot(snapshot) => {
                replica.apply_snapshot(&snapshot);
            }
        }
    }
}

// Feature: rust-supabase-rewrite, Property 1: 任意送達順序都收斂到伺服器狀態
proptest! {
    /// *For any* 由 `ModelServer::run()` 產生的變更集 1..=n，以及任何 `arb_delivery_plan()` 產生的送達方式（任意順序、
    /// 重複、在任意位置插入任意 seq 的快照），`Replica` 處理完全部事件後，`state` 等於伺服器在 n 的狀態，
    /// `watermark == n`。
    ///
    /// **Validates: Requirements 12.10, 12.12, 12.14**
    #[test]
    fn replica_converges_under_any_delivery(script in arb_script(), plan in arb_delivery_plan()) {
        let server = ModelServer::run(&script);
        let mut replica = Replica::from_snapshot(&server.snapshot_at(0)).expect("Snapshot 有 Trip_Card");
        deliver(&mut replica, plan.schedule(&server));
        prop_assert_eq!(&replica.state, server.state());
        prop_assert_eq!(replica.watermark, server.head());
        // 沒有 Pending_Command 時，畫面等於 Replica，也就等於伺服器的狀態
        let view = overlay(&replica.state, &[], &ctx_of(Capabilities::NONE));
        prop_assert_eq!(&view, server.state());
    }

    /// 同一個屬性，檢視者是 Unbound_Admin：Change_Set 與 Snapshot 都不含 Ledger_Rows，`Replica` 處理完全部事件後，
    /// `state` 等於伺服器在 n 的狀態去掉 Ledger_Rows，`watermark == n`。
    ///
    /// **Validates: Requirements 12.10, 12.12, 12.14**
    #[test]
    fn unbound_admin_replica_converges_without_ledger_rows(
        script in arb_script(),
        plan in arb_delivery_plan(),
    ) {
        let server = ModelServer::run(&script);
        let start = unbound_admin_snapshot(server.snapshot_at(0));
        let mut replica = Replica::from_snapshot(&start).expect("Snapshot 有 Trip_Card");
        deliver(
            &mut replica,
            plan.schedule(&server).into_iter().map(Delivery::for_unbound_admin),
        );
        prop_assert_eq!(&replica.state, &without_ledger_rows(server.state()));
        prop_assert_eq!(replica.watermark, server.head());
    }
}
