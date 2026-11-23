//! Property 14 的屬性測試（任務 10.2；需求 15.3–15.6、33.5、33.6）：Presence 節流遵守 Realtime 的限制且不遺失最後狀態。
//!
//! 輸入是 0–40 個事件：`offer()`（從 4 筆 Presence_Meta 中選一筆：沒有正在編輯、編輯兩個不同的對象，以及同一個對象
//! 但換了顯示名稱）或 `on_rejoin()`，每個事件之前經過 0–20,000 毫秒，常落在 6,500 毫秒前後。與 LM_Web 的用法相同，每次
//! `on_rejoin()` 之後都以當時最後一次 offer 的 meta 再 offer 一次（還沒 offer 過時不 offer），每個 `WakeAt` 指定的時間
//! 一到就呼叫 `wake()`；全部事件之後，再處理剩下的 `WakeAt`。檢查：
//!
//! - 任兩次送出至少相隔 6,500 毫秒，所以任何 30 秒的區間（含兩端）內最多送出 5 次（需求 15.3）。
//! - 每次送出的 meta 都不等於最近一次 `on_rejoin()` 之後上一次送出的 meta（需求 15.5）。
//! - `WakeAt` 的時間晚於當下。
//! - 全部處理完之後，最後一次送出的 meta 等於最後一次 offer 的 meta（需求 15.4）。
//! - 最後一次 `on_rejoin()` 之前若有過 offer，它之後至少送出一次，即使內容與重新加入之前送出的相同（需求 15.6）。
//!
//! 使用 proptest 的預設設定（256 個案例，設定 `PROPTEST_CASES=N` 時為 N 個），不覆寫案例數；proptest 找到的失敗案例
//! 寫在同一個目錄的 `prop_presence_throttle.proptest-regressions`，這個檔案提交進版本庫（需求 33.6）。

mod support;

use lm_core::ids::{PersonId, UserId};
use lm_core::model::{Entity, RowKey};
use lm_core::presence::{EditTarget, PresenceMeta, PresenceThrottle, ThrottleAction};
use proptest::collection::vec;
use proptest::prelude::*;
use proptest::sample::select;
use proptest::test_runner::TestCaseError;
use uuid::Uuid;

const GAP_MS: f64 = PresenceThrottle::MIN_GAP_MS;
const WINDOW_MS: f64 = 30_000.0;

/// 一個事件。
#[derive(Clone, Debug)]
enum Event {
    Offer(PresenceMeta),
    Rejoin,
}

/// 同一個分頁可能回報的 4 筆 Presence_Meta。
fn metas() -> Vec<PresenceMeta> {
    let meta = |name: &str, editing: Option<EditTarget>| PresenceMeta {
        user: UserId(Uuid::from_u128(7)),
        display_name: name.to_owned(),
        person: Some(PersonId(Uuid::from_u128(8))),
        editing,
    };
    let meal = EditTarget {
        entity: Entity::Meal,
        key: RowKey::Id(Uuid::from_u128(100)),
    };
    let gear = EditTarget {
        entity: Entity::Gear,
        key: RowKey::Id(Uuid::from_u128(200)),
    };
    vec![
        meta("陳小明", None),
        meta("陳小明", Some(meal)),
        meta("陳小明", Some(gear)),
        meta("小明", Some(meal)),
    ]
}

/// 事件之前經過的毫秒數，常落在 6,500 毫秒前後。
fn arb_gap() -> impl Strategy<Value = u32> {
    prop_oneof![
        2 => Just(0_u32),
        4 => 1_u32..=6_498,
        2 => 6_499_u32..=6_501,
        2 => 6_502_u32..=20_000,
    ]
}

fn arb_events() -> impl Strategy<Value = Vec<(u32, Event)>> {
    let event = prop_oneof![
        5 => select(metas()).prop_map(Event::Offer),
        1 => Just(Event::Rejoin),
    ];
    vec((arb_gap(), event), 0..=40)
}

/// 依序處理事件，記錄每次送出並檢查每一步。
#[derive(Default)]
struct Run {
    throttle: PresenceThrottle,
    now: f64,
    /// `WakeAt` 指定、還沒呼叫 `wake()` 的時間。
    wakes: Vec<f64>,
    sends: Vec<(f64, PresenceMeta)>,
    /// 最近一次 `on_rejoin()` 之後上一次送出的 meta。
    sent_since_rejoin: Option<PresenceMeta>,
    last_offered: Option<PresenceMeta>,
    /// 最近一次 `on_rejoin()` 之前有過 offer，而且之後還沒送出過。
    owes_send: bool,
}

impl Run {
    fn handle(&mut self, action: ThrottleAction) -> Result<(), TestCaseError> {
        match action {
            ThrottleAction::Send(meta) => {
                prop_assert_ne!(
                    Some(&meta),
                    self.sent_since_rejoin.as_ref(),
                    "與這次加入之後上次送出的相同"
                );
                if let Some((last, _)) = self.sends.last() {
                    prop_assert!(
                        self.now - last >= GAP_MS,
                        "{} 毫秒與 {} 毫秒兩次送出",
                        last,
                        self.now
                    );
                }
                self.sends.push((self.now, meta.clone()));
                self.sent_since_rejoin = Some(meta);
                self.owes_send = false;
            }
            ThrottleAction::WakeAt(at) => {
                prop_assert!(
                    at > self.now,
                    "在 {} 毫秒要求 {} 毫秒的 wake()",
                    self.now,
                    at
                );
                self.wakes.push(at);
            }
            ThrottleAction::Nothing => {}
        }
        Ok(())
    }

    /// 依時間順序呼叫到期時間不晚於 `until` 的每一個 `wake()`，包括其間新要求的。
    fn wake_until(&mut self, until: f64) -> Result<(), TestCaseError> {
        while let Some((index, at)) = self
            .wakes
            .iter()
            .copied()
            .enumerate()
            .filter(|&(_, at)| at <= until)
            .min_by(|a, b| a.1.total_cmp(&b.1))
        {
            self.wakes.swap_remove(index);
            self.now = self.now.max(at);
            let action = self.throttle.wake(self.now);
            self.handle(action)?;
        }
        Ok(())
    }

    fn offer(&mut self, meta: PresenceMeta) -> Result<(), TestCaseError> {
        let action = self.throttle.offer(meta, self.now);
        self.handle(action)
    }
}

// Feature: rust-supabase-rewrite, Property 14: Presence 節流遵守 Realtime 的限制且不遺失最後狀態
proptest! {
    /// *For any* 時間不遞減、任意穿插 `on_rejoin()` 的 `offer` 序列（每次 `on_rejoin()` 之後都以當時最後一次 offer 的
    /// meta 再 offer 一次，與 LM_Web 的用法相同），並在每個 `WakeAt` 指定的時間呼叫 `wake`：任何 30 秒區間內的 `Send`
    /// 不超過 5 次；每次 `Send` 的 meta 都不等於最近一次 `on_rejoin()` 之後上一次送出的 meta；全部處理完之後，最後一次
    /// 送出的 meta 等於最後一次 offer 的 meta；最後一次 `on_rejoin()` 之前若有過 offer，它之後至少送出一次，即使內容與
    /// 重新加入之前送出的相同。
    ///
    /// **Validates: Requirements 15.3, 15.4, 15.5, 15.6**
    #[test]
    fn presence_throttle_respects_the_limit_and_keeps_the_last_state(events in arb_events()) {
        let mut run = Run::default();
        for (gap, event) in events {
            let at = run.now + f64::from(gap);
            run.wake_until(at)?;
            run.now = at;
            match event {
                Event::Offer(meta) => {
                    run.last_offered = Some(meta.clone());
                    run.offer(meta)?;
                }
                Event::Rejoin => {
                    run.throttle.on_rejoin();
                    run.sent_since_rejoin = None;
                    if let Some(meta) = run.last_offered.clone() {
                        run.owes_send = true;
                        run.offer(meta)?;
                    }
                }
            }
        }
        run.wake_until(f64::INFINITY)?;

        // 任何 30 秒的區間（含兩端）內最多 5 次：第 i 次與第 i + 5 次相隔超過 30 秒
        for (first, sixth) in run.sends.iter().zip(run.sends.iter().skip(5)) {
            prop_assert!(sixth.0 - first.0 > WINDOW_MS, "{} 毫秒到 {} 毫秒送出 6 次", first.0, sixth.0);
        }
        prop_assert_eq!(
            run.sends.last().map(|(_, meta)| meta),
            run.last_offered.as_ref(),
            "最後一次送出的應該是最後一次 offer 的內容"
        );
        prop_assert!(!run.owes_send, "重新加入之後沒有送出");
    }
}
