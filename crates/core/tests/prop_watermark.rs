//! Property 2 的屬性測試（任務 9.5；需求 12.3、12.11、33.5、33.6）：水位線與缺號回報正確。
//!
//! `ModelServer::run()` 依序執行 `arb_script()` 的命令，得到 Change_Set 1..=n。`Replica` 從 Seq 0 的 Snapshot 開始，
//! 依序收到一串事件：多數是 1..=n 中任選的 Change_Set（所以送達的是任意子集合、依任意順序，也可能重複），也夾雜
//! 0..=n 中任選 Seq 的 Snapshot。每處理一個事件都檢查：
//!
//! - 水位線等於最大的 w，使得 1..=w 都已反映在 Replica：逐則套用，或包含在已合併的 Snapshot 中（Seq 不大於已送達的
//!   Snapshot 的最大 Seq）；水位線只增不減（需求 12.11）。
//! - 已套用、但大於水位線的 Seq（`ahead`）不是空的時，`gap == Some((w + 1, min(ahead) − 1))`，否則是 `None`
//!   （需求 12.3）；整則忽略的事件也回報目前的缺號。
//! - 只有 Seq 不大於水位線或已經套用過的 Change_Set，以及 Seq 不大於水位線的 Snapshot，回報 `duplicate`。
//!
//! 使用 proptest 的預設設定（256 個案例，設定 `PROPTEST_CASES=N` 時為 N 個），不覆寫案例數；proptest 找到的失敗案例
//! 寫在同一個目錄的 `prop_watermark.proptest-regressions`，這個檔案提交進版本庫（需求 33.6）。

mod support;

use std::collections::BTreeSet;

use lm_core::model::Seq;
use lm_core::sync::Replica;
use proptest::collection::vec;
use proptest::prelude::*;
use proptest::sample::Index;

use support::model_server::{arb_script, ModelServer};

/// 送達的一個事件：在 1..=n 中選一則 Change_Set，或在 0..=n 中選一份 Snapshot 的 Seq。
#[derive(Clone, Copy, Debug)]
enum Pick {
    Change(Index),
    Snapshot(Index),
}

/// 0–48 個事件，Change_Set 與 Snapshot 的權重為 6 比 1。
fn arb_picks() -> impl Strategy<Value = Vec<Pick>> {
    let pick = prop_oneof![
        6 => any::<Index>().prop_map(Pick::Change),
        1 => any::<Index>().prop_map(Pick::Snapshot),
    ];
    vec(pick, 0..=48)
}

// Feature: rust-supabase-rewrite, Property 2: 水位線與缺號回報正確
proptest! {
    /// *For any* 1..=n 的任意子集合依任意順序送達，`watermark` 等於最大的 w 使得 1..=w 全部已送達；`ahead` 不為空時
    /// `gap == Some((watermark + 1, min(ahead) − 1))`，否則為 `None`。
    ///
    /// **Validates: Requirements 12.3, 12.11**
    #[test]
    fn watermark_and_gap_follow_the_delivered_seqs(script in arb_script(), picks in arb_picks()) {
        let server = ModelServer::run(&script);
        let n = server.head();
        let mut replica = Replica::from_snapshot(&server.snapshot_at(0)).expect("Snapshot 有 Trip_Card");
        // 已套用的 Change_Set，以及已送達的 Snapshot 中最大的 Seq
        let mut delivered: BTreeSet<Seq> = BTreeSet::new();
        let mut covered: Seq = 0;
        for pick in picks {
            let watermark = replica.watermark;
            let report = match pick {
                Pick::Change(_) if n == 0 => continue,
                Pick::Change(which) => {
                    let seq = which.index(n as usize) as Seq + 1;
                    let report = replica.apply_changeset(server.changeset(seq));
                    let seen = seq <= watermark || delivered.contains(&seq);
                    prop_assert_eq!(report.duplicate, seen, "Change_Set {}，水位線 {}", seq, watermark);
                    delivered.insert(seq);
                    report
                }
                Pick::Snapshot(which) => {
                    let seq = which.index(n as usize + 1) as Seq;
                    let report = replica.apply_snapshot(&server.snapshot_at(seq));
                    prop_assert_eq!(report.duplicate, seq <= watermark, "Snapshot {}，水位線 {}", seq, watermark);
                    covered = covered.max(seq);
                    report
                }
            };
            // 1..=covered 都包含在已合併的 Snapshot 中；之後第一個沒有送達的 Seq 減 1 就是水位線
            let expected = (covered + 1..)
                .find(|seq| !delivered.contains(seq))
                .expect("送達的 Seq 是有限的")
                - 1;
            prop_assert_eq!(replica.watermark, expected, "已送達 {:?}，Snapshot 最大 {}", delivered, covered);
            prop_assert!(replica.watermark >= watermark, "水位線從 {} 退回 {}", watermark, replica.watermark);
            let first_ahead = delivered.range(expected + 1..).next().copied();
            let gap = first_ahead.map(|first| (expected + 1, first - 1));
            prop_assert_eq!(report.gap, gap, "已送達 {:?}，水位線 {}", delivered, expected);
        }
    }
}
