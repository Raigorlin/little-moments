//! 同步引擎 `TripSync`（design 4.2、A6）：一趟旅行的 Replica、Pending_Command 與畫面上的 Optimistic_View。
//!
//! - `submit()` 先以 `apply(Mode::Predict)` 在目前的 Optimistic_View 上檢查命令：不成立時把 `Rejection` 交給呼叫端
//!   （表單顯示在錯誤訊息區，其他操作以 Toast 顯示，需求 13.2）；成立時產生 Command_Id、加到 Pending_Command 的最後、
//!   只更新受影響的列，再通知送出佇列（需求 13.1）。
//! - `refresh_view()` 以 `overlay()` 重算 Optimistic_View（需求 13.6、13.7），只把內容改變的列交給 `RowStore`（需求 14.1），
//!   並遞增 `revision`，讓文字版、未分配採買、分帳餘額、裝備進度、出發清單與各種數量在同一次更新中重算（需求 14.5）。
//! - 命令的回應、推送與補齊的 Change_Set 都經 `merge_changeset()` 合併：Unbound_Admin 先丟棄 Ledger_Rows（需求 6.13）；
//!   Command_Id 屬於某個 Pending_Command 時視為確認並移除它（需求 13.13、13.14）；`trip_deleted` 時離開頁面、前往
//!   Home_Page 並顯示「這趟旅行已被刪除。」（需求 12.13）。讀取 Snapshot 不移除 Pending_Command（需求 13.6）。
//! - 每趟旅行的 `TripSync` 以旅行 id 為鍵保存在 App 層的 [`TripSyncs`]，signal 屬於 App 之下的 Owner，所以前往 `/login`
//!   再回來時沿用（需求 4.9、4.10）；切換帳號時捨棄（需求 4.14）。
//!
//! 送出佇列（任務 20.3）以 [`Outbox`] 接上，Trip_Channel 與補齊（任務 20.4）呼叫 [`TripHandle::on_broadcast`]、
//! [`TripHandle::on_changes`] 與 [`TripHandle::on_snapshot`]，依回傳的 [`Resync`] 繼續補齊。
//!
//! 每個方法都先在 `StoredValue` 內更新狀態，借用結束之後才呼叫 `Outbox`、顯示 Toast 或離開旅行頁，所以 `Outbox` 的實作
//! 可以在這些呼叫中直接讀取 `TripHandle`。
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::rc::Rc;
use std::time::Duration;

use leptos::ev;
use leptos::prelude::*;
use lm_core::api::{ChangesResponse, CommandResponse};
use lm_core::apply::{apply, diff, Ctx, Effect, Mode, NoDerivedIds, Rejection};
use lm_core::command::Command;
use lm_core::ids::{CommandId, TripId, UserId};
use lm_core::model::{Seq, Slot, TripState};
use lm_core::presence::{EditTarget, EditorStack, PresenceMeta};
use lm_core::sync::{overlay, Broadcast, ChangeSet, PendingCmd, Replica, Snapshot, Viewer};
use uuid::Uuid;

use crate::api::{Api, ApiFailure};
use crate::app::{home_path, Screen, Toasts};
use crate::session::{Auth, SessionHooks};
use crate::sync::presence::TripPresence;
use crate::sync::sender::Sender;
use crate::sync::store::TripStores;

/// `trip_deleted` 的 Change_Set（需求 12.13）。
const TRIP_DELETED: &str = "這趟旅行已被刪除。";
/// 第 5 次重送也失敗（需求 13.10）。
const SAVE_REVERTED: &str = "儲存失敗，變更已還原";
/// 第一次的 Snapshot 合併之前沒有 Optimistic_View，畫面顯示載入中、沒有可以操作的項目；仍收到操作時的訊息。
const NOT_LOADED: &str = "旅行還在載入中，請稍後再試。";

/// `TripSync` 保留的 Remote_Change 記錄筆數上限；開啟中的表單在每次畫面更新後立即讀取，所以只需要最近的幾則。
const REMOTE_LOG_LIMIT: usize = 512;

/// 一列因 Remote_Change 而在 Optimistic_View 中改變（包括刪除）的記錄（需求 14.6、14.7、14.9）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RemoteEntry {
    /// 第幾次因 Remote_Change 而更新畫面（[`TripHandle::remote_serial`]）
    pub serial: u64,
    pub slot: Slot,
    /// 使這一列改變的 Change_Set 的 Seq（同時套用多個時為最大者）；來自 Snapshot 時是 Snapshot 的 Seq
    pub seq: Seq,
    /// Change_Set 的提交者；來自 Snapshot 時是 `None`（需求 14.7）
    pub actor: Option<UserId>,
}

/// 這次重算 Optimistic_View 的原因中，不是這個分頁的 Pending_Command 造成的部分（Remote_Change 的定義）。
enum RemoteSource {
    /// 其他分頁、裝置或成員的 Change_Set（Command_Id 不屬於這個分頁的 Pending_Command），包括其中的
    /// Derived_Effect：每一列最後一次（Seq 最大）被哪個 Change_Set 改變
    Changes(BTreeMap<Slot, (Seq, UserId)>),
    /// Snapshot 帶來的變化
    Snapshot(Seq),
}

/// 畫面頂端的提示：Offline 時只顯示離線提示，取代重新連線與儲存失敗的提示（需求 11.14、13.11）。由任務 20.4 設定。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnState {
    Connecting,
    Live,
    Reconnecting,
    Offline,
}

/// 合併之後還需要讀取的內容（design A7 的 `resync_from()`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resync {
    /// `GET /api/trips/{id}/changes?after=<Seq>`（需求 12.3、12.4）
    ChangesAfter(Seq),
    /// `GET /api/trips/{id}/snapshot`（需求 12.6）
    Snapshot,
}

/// 送出佇列（任務 20.3）的接口。`TripHandle` 在自己的狀態借用結束之後才呼叫這些方法。預設的實作什麼都不做。
pub trait Outbox {
    /// 有新的 Pending_Command，或排在最前面的有了結果被移除：沒有進行中的請求、也沒有在等待重送時送出最前面的
    /// （需求 13.3）；換發成功或重新登入同一個 Account 後也呼叫，以新的 Session 依原本的順序送出（需求 4.10）。
    fn kick(&self) {}
    /// 這個 Command 的請求已結束（成功、失敗或 15 秒逾時，需求 13.3）。
    fn finished(&self, _id: CommandId) {}
    /// 網路錯誤、逾時或 5xx：安排以同一個 Command_Id 重送並回傳 true；已重送 5 次時回傳 false（需求 13.9、13.10）。
    fn retry_later(&self, _id: CommandId) -> bool {
        false
    }
    /// 推送或補齊先確認了這個 Command：取消尚未進行的重送，仍等進行中的請求結束（需求 13.13）。
    fn cancel_retry(&self, _id: CommandId) {}
    /// Session 失效或登出：停止送出，Pending_Command 留在記憶體中（需求 4.9、4.12）。
    fn pause(&self) {}
    /// 換發成功或重新登入同一個 Account（新的 access token）：`pause()` 之後恢復送出，依原本的順序（需求 4.10）。
    fn resume(&self) {
        self.kick();
    }
    /// 瀏覽器回報離線或恢復上線（`offline`／`online` 事件，需求 13.11、13.12）。
    fn network_changed(&self, _online: bool) {}
    /// `TripSync` 被捨棄（切換帳號、離開已刪除或無法存取的旅行）：不再送出任何 Command（需求 4.14）。
    fn stop(&self) {}
}

/// 還沒有接上送出佇列時。
struct NoOutbox;

impl Outbox for NoOutbox {}

/// 畫面讀取的 signal；與 `TripSync` 屬於同一個 Owner。
#[derive(Clone, Copy)]
struct Signals {
    stores: RwSignal<Option<TripStores>>,
    revision: RwSignal<u64>,
    pending_count: RwSignal<usize>,
    remote_serial: RwSignal<u64>,
    presence: TripPresence,
}

/// 一趟旅行的同步狀態（design 4.2）。
struct TripSync {
    trip: TripId,
    /// 第一次的 Snapshot 合併之後才有
    viewer: Option<Viewer>,
    replica: Option<Replica>,
    /// 第一次的 Snapshot 合併之前收到的 Change_Set；Snapshot 到達後依需求 12.10 一起收斂（需求 12.1）
    early: Vec<ChangeSet>,
    /// 第一次的 Snapshot 合併之前收到的 Thin_Notice 中最大的 Seq；Snapshot 比它舊時補齊（需求 12.4）
    early_head: Seq,
    pending: VecDeque<PendingCmd>,
    /// Optimistic_View：`replica.state` 疊上 `pending`
    view: Option<TripState>,
    stores: Option<TripStores>,
    signals: Signals,
    /// `TripStores` 建立在這個 Owner 之下（App 之下，不是旅行頁的 Owner）；弱參照，避免 Owner 與自己的節點互相持有
    owner: WeakOwner,
    outbox: Rc<dyn Outbox>,
    /// 最近因 Remote_Change 而改變的列（依 `serial` 遞增）
    remote_log: VecDeque<RemoteEntry>,
}

/// 合併 Change_Set 之後要在借用結束後做的事。
#[derive(Default)]
struct Merged {
    /// 經推送或補齊確認的 Pending_Command（需求 13.13）
    confirmed: Vec<CommandId>,
    trip_deleted: bool,
    resync: Option<Resync>,
}

impl TripSync {
    fn ctx(&self) -> Option<Ctx> {
        self.viewer.as_ref().map(|viewer| Ctx {
            actor: viewer.user,
            caps: viewer.caps,
        })
    }

    fn hides_ledger(&self) -> bool {
        self.viewer.as_ref().is_some_and(Viewer::hides_ledger)
    }

    /// 在目前的 Optimistic_View 上檢查並預測；成立時加入 Pending_Command（需求 13.1、13.2）。
    fn submit(&mut self, command: Command) -> Result<CommandId, Rejection> {
        let (Some(view), Some(ctx)) = (&self.view, self.ctx()) else {
            return Err(Rejection::conflict("not_loaded", NOT_LOADED));
        };
        // 只計算 Primary_Effect，不執行 Shopping_Sync（需求 13.4）
        apply(view, &ctx, Mode::Predict, &mut NoDerivedIds, &command)?;
        let id = CommandId(Uuid::new_v4());
        self.pending.push_back(PendingCmd { id, command });
        self.refresh_view(None);
        Ok(id)
    }

    fn is_pending(&self, id: CommandId) -> bool {
        self.pending.iter().any(|op| op.id == id)
    }

    /// 移除一個 Pending_Command；回傳是否真的移除。
    fn remove_pending(&mut self, id: CommandId) -> bool {
        let before = self.pending.len();
        self.pending.retain(|op| op.id != id);
        self.pending.len() != before
    }

    /// 合併一個已提交的 Change_Set（命令的回應、推送或補齊）。Command_Id 屬於某個 Pending_Command 時移除它
    /// （需求 13.13、13.14），回傳它的 id。呼叫端之後要 `refresh_view()`。
    fn merge_changeset(&mut self, cs: &ChangeSet, merged: &mut Merged) {
        let hide = self.hides_ledger();
        let Some(replica) = self.replica.as_mut() else {
            return;
        };
        // Unbound_Admin 丟棄 Ledger_Rows，照常推進水位線（需求 6.13）
        let cs = cs.clone().for_viewer(hide);
        let report = replica.apply_changeset(&cs);
        let watermark = replica.watermark;
        if self.remove_pending(cs.command_id) {
            merged.confirmed.push(cs.command_id);
        }
        merged.trip_deleted |= report.trip_deleted;
        merged.resync = report.gap.map(|_| Resync::ChangesAfter(watermark));
    }

    /// 推送與補齊共用：逐一合併，在同一次畫面更新中顯示（需求 10.5）；仍有缺號就繼續補（需求 12.3）。
    fn on_changesets(&mut self, changesets: &[ChangeSet]) -> Merged {
        let mut merged = Merged::default();
        if self.replica.is_none() {
            // 第一次的 Snapshot 之前：先留著，Snapshot 合併後一起套用（需求 12.1）。缺號由 Snapshot 之後再判斷
            merged.trip_deleted = changesets.iter().any(|cs| cs.trip_deleted);
            self.early.extend(changesets.iter().cloned());
            return merged;
        }
        let mut remote = BTreeMap::new();
        for cs in changesets {
            if !self.is_pending(cs.command_id) {
                // 不是這個分頁的 Pending_Command：其中每一列的變化都是 Remote_Change 的候選（需求 14.6）
                for change in &cs.changes {
                    let entry = remote.entry(change.slot()).or_insert((cs.seq, cs.actor));
                    if cs.seq >= entry.0 {
                        *entry = (cs.seq, cs.actor);
                    }
                }
            }
            self.merge_changeset(cs, &mut merged);
            if merged.trip_deleted {
                return merged;
            }
        }
        self.refresh_view(Some(RemoteSource::Changes(remote)));
        merged
    }

    /// 合併 Snapshot（需求 12.1、12.6、12.10）；不移除 Pending_Command（需求 13.6）。
    fn on_snapshot(&mut self, snapshot: &Snapshot) -> Merged {
        let mut merged = Merged::default();
        if snapshot.trip != self.trip {
            return merged;
        }
        self.viewer = Some(snapshot.viewer.clone());
        self.signals.presence.set_viewer(snapshot.viewer.user);
        let remote = match self.replica.as_mut() {
            Some(replica) => {
                let report = replica.apply_snapshot(snapshot);
                merged.resync = report.gap.map(|_| Resync::ChangesAfter(replica.watermark));
                Some(RemoteSource::Snapshot(snapshot.seq))
            }
            None => {
                let Some(replica) = Replica::from_snapshot(snapshot) else {
                    return merged;
                };
                self.replica = Some(replica);
                // 加入 Trip_Channel 之後、Snapshot 回應之前收到的 Change_Set（需求 12.1）
                let mut early = std::mem::take(&mut self.early);
                early.sort_by_key(|cs| cs.seq);
                for cs in &early {
                    self.merge_changeset(cs, &mut merged);
                    if merged.trip_deleted {
                        return merged;
                    }
                }
                let watermark = self.replica.as_ref().map_or(0, |r| r.watermark);
                if merged.resync.is_none() && self.early_head > watermark {
                    merged.resync = Some(Resync::ChangesAfter(watermark));
                }
                // 第一次的 Snapshot：還沒有畫面，也就沒有開啟中的表單
                None
            }
        };
        self.refresh_view(remote);
        merged
    }

    /// 重算 Optimistic_View，只把內容改變的列交給 `RowStore`（B2、需求 14.1），並遞增 `revision`（需求 14.5）。
    /// `remote` 是這次重算中不是這個分頁的 Pending_Command 造成的變化：Optimistic_View 中因它而改變的列記入
    /// `remote_log`，並在遞增 `revision` 之前遞增 `remote_serial`，讓開啟中的表單判斷 Remote_Change（需求 14.6、14.9）。
    fn refresh_view(&mut self, remote: Option<RemoteSource>) {
        let (Some(replica), Some(ctx)) = (&self.replica, self.ctx()) else {
            return;
        };
        let next = overlay(&replica.state, self.pending.make_contiguous(), &ctx);
        let mut remote_slots = Vec::new();
        match (&self.view, self.stores) {
            (Some(previous), Some(stores)) => {
                for effect in diff(previous, &next) {
                    let slot = match &effect {
                        Effect::Upsert(row) => row.slot(),
                        Effect::Delete(slot) => *slot,
                    };
                    // 只有 Optimistic_View 真的改變的列才算 Remote_Change；被自己的 Pending_Command 蓋過的不算
                    match &remote {
                        Some(RemoteSource::Changes(touched)) => {
                            if let Some(&(seq, actor)) = touched.get(&slot) {
                                remote_slots.push((slot, seq, Some(actor)));
                            }
                        }
                        Some(RemoteSource::Snapshot(seq)) => remote_slots.push((slot, *seq, None)),
                        None => {}
                    }
                    match effect {
                        Effect::Upsert(row) => stores.sync(slot, Some(row)),
                        Effect::Delete(slot) => stores.sync(slot, None),
                    }
                }
            }
            _ => {
                // 第一次的 Snapshot：建立每種列的 RowStore
                let Some(owner) = self.owner.upgrade() else {
                    return;
                };
                let stores = owner.with(|| TripStores::new(&next));
                self.stores = Some(stores);
                self.signals.stores.set(Some(stores));
            }
        }
        self.view = Some(next);
        if !remote_slots.is_empty() {
            let serial = self.signals.remote_serial.get_untracked() + 1;
            for (slot, seq, actor) in remote_slots {
                self.remote_log.push_back(RemoteEntry {
                    serial,
                    slot,
                    seq,
                    actor,
                });
            }
            while self.remote_log.len() > REMOTE_LOG_LIMIT {
                self.remote_log.pop_front();
            }
            self.signals.remote_serial.set(serial);
        }
        self.signals.revision.update(|revision| *revision += 1);
        let count = self.pending.len();
        if self.signals.pending_count.get_untracked() != count {
            self.signals.pending_count.set(count);
        }
    }
}

/// 一趟旅行的 `TripSync`。`Copy`，可以放進事件處理、async 區塊與 Leptos context。被捨棄之後每個方法都不做任何事。
#[derive(Clone, Copy)]
pub struct TripHandle {
    trip: TripId,
    inner: StoredValue<TripSync, LocalStorage>,
    /// 每種列一個 `RowStore`；第一次的 Snapshot 合併之前是 `None`，畫面顯示載入中。
    pub stores: RwSignal<Option<TripStores>>,
    /// Optimistic_View 每變一次加一；文字版、餘額等整體計算的 `Memo` 經 [`TripHandle::with_view`] 依它重算。
    pub revision: RwSignal<u64>,
    /// 由 Trip_Channel（任務 20.4）設定。
    pub conn: RwSignal<ConnState>,
    /// 目前 Pending_Command 的數量（需求 13.11）。
    pub pending_count: RwSignal<usize>,
    /// 排在最前面的 Pending_Command 送出失敗、正在等待重送或重送中：畫面頂端顯示「儲存失敗，正在重試」，
    /// 直到它有了結果（需求 13.9）。由送出佇列設定。
    pub save_retrying: RwSignal<bool>,
    /// 瀏覽器是否回報有網路連線（`navigator.onLine` 與 `online`／`offline` 事件）；為假時畫面頂端只顯示
    /// 「離線中，有 N 項變更尚未送出」（N 是 `pending_count`，需求 11.14、13.11）。整個分頁共用。
    pub online: Signal<bool>,
    /// 因 Remote_Change 而更新畫面的次數；每次在遞增 `revision` 之前遞增。開啟中的表單以
    /// [`TripHandle::remote_since`] 取得之後的記錄（需求 14.6、14.9）。
    pub remote_serial: RwSignal<u64>,
    /// 誰正在編輯（`sync::presence`）：其他分頁的 Presence_Meta 與這個分頁的回報。
    pub presence: TripPresence,
    /// 每個編輯對象的 Editor_Stack，不含檢視者自己的帳號（需求 16.10）；沒有任何 Editor_Stack 改變時不通知（需求 16.17）。
    pub editors: Memo<BTreeMap<EditTarget, EditorStack>>,
    registry: TripSyncs,
}

impl TripHandle {
    pub fn trip(&self) -> TripId {
        self.trip
    }

    /// 還沒有被捨棄（切換帳號，或離開已刪除、無法存取的旅行）。
    pub fn is_open(&self) -> bool {
        self.inner.try_with_value(|_| ()).is_some()
    }

    /// 已合併過 Snapshot。
    pub fn has_replica(&self) -> bool {
        self.inner
            .try_with_value(|sync| sync.replica.is_some())
            .unwrap_or(false)
    }

    /// Replica 的水位線；還沒有 Replica 時是 0。
    pub fn watermark(&self) -> Seq {
        self.inner
            .try_with_value(|sync| sync.replica.as_ref().map_or(0, |r| r.watermark))
            .unwrap_or(0)
    }

    /// 讀取 Optimistic_View；在 `Memo` 中呼叫時依 `revision` 重算。第一次的 Snapshot 之前是 `None`。
    pub fn with_view<R>(&self, f: impl FnOnce(&TripState) -> R) -> Option<R> {
        self.revision.track();
        self.inner
            .try_with_value(|sync| sync.view.as_ref().map(f))
            .flatten()
    }

    /// 檢視者（最新的 Snapshot）；在 `Memo` 中呼叫時依 `revision` 重算。
    pub fn viewer(&self) -> Option<Viewer> {
        self.revision.track();
        self.inner
            .try_with_value(|sync| sync.viewer.clone())
            .flatten()
    }

    /// `serial` 之後（不含）因 Remote_Change 而改變的列，依 `serial` 遞增；不追蹤任何 signal。
    pub fn remote_since(&self, serial: u64) -> Vec<RemoteEntry> {
        self.inner
            .try_with_value(|sync| {
                sync.remote_log
                    .iter()
                    .filter(|entry| entry.serial > serial)
                    .copied()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 開啟（`Some`）或關閉（`None`）Editable_Item 的編輯表單時回報這個分頁正在編輯的對象（需求 15.1、15.2）：
    /// Presence_Meta 的 `display_name` 取自 Snapshot 的 `viewer`，`person` 取自 `viewer.caps.me`（Unbound_Admin 為空），
    /// 經 `PresenceThrottle` 送出。第一次的 Snapshot 之前（還沒有畫面，也就沒有表單）不做任何事。
    pub fn report_editing(&self, editing: Option<EditTarget>) {
        let viewer = self
            .inner
            .try_with_value(|sync| sync.viewer.clone())
            .flatten();
        let Some(viewer) = viewer else {
            return;
        };
        self.presence.report(PresenceMeta {
            user: viewer.user,
            display_name: viewer.display_name,
            person: viewer.caps.me,
            editing,
        });
    }

    /// 本地操作（需求 13.1、13.2）：命令在目前的 Optimistic_View 上不成立時回傳 `Rejection`，不建立 Pending_Command，
    /// 畫面不變；成立時顯示 Primary_Effect 並排入送出佇列。
    pub fn submit(&self, command: Command) -> Result<CommandId, Rejection> {
        let (result, outbox) = self
            .inner
            .try_update_value(|sync| (sync.submit(command), Rc::clone(&sync.outbox)))
            .ok_or_else(|| Rejection::conflict("not_loaded", NOT_LOADED))?;
        if result.is_ok() {
            outbox.kick();
        }
        result
    }

    /// 在 Optimistic_View 的副本上依序預測 `commands`（只計算 Primary_Effect），不建立 Pending_Command，畫面不變。
    /// 每個命令預測之前的狀態交給 `before`（工作室以它計算復原用的反向命令）；有一個命令不成立時回傳它的
    /// `Rejection`，之後的命令不再預測。一次送出多個命令之前先以它確認全部成立，不會只送出一部分。成立時回傳是否有任何
    /// 命令改變了狀態（`false` 是想要的狀態已經成立）。
    pub fn check_batch(
        &self,
        commands: &[Command],
        mut before: impl FnMut(&TripState, &Command),
    ) -> Result<bool, Rejection> {
        self.inner
            .try_with_value(|sync| {
                let (Some(view), Some(ctx)) = (&sync.view, sync.ctx()) else {
                    return Err(Rejection::conflict("not_loaded", NOT_LOADED));
                };
                let mut state = view.clone();
                let mut changed = false;
                for command in commands {
                    before(&state, command);
                    let outcome = apply(&state, &ctx, Mode::Predict, &mut NoDerivedIds, command)?;
                    changed |= !outcome.is_noop();
                    state.apply_effects(outcome.effects().iter());
                }
                Ok(changed)
            })
            .unwrap_or_else(|| Err(Rejection::conflict("not_loaded", NOT_LOADED)))
    }

    /// 不是來自表單的操作（勾選、列上的選單）：不成立時以 Toast 顯示訊息（需求 13.2）。
    pub fn submit_or_toast(&self, command: Command) -> Option<CommandId> {
        match self.submit(command) {
            Ok(id) => Some(id),
            Err(rejection) => {
                self.registry.toasts.show(rejection.to_string());
                None
            }
        }
    }

    /// 排在最前面的 Pending_Command（送出佇列一次只送它，需求 13.3）。
    pub fn front_pending(&self) -> Option<PendingCmd> {
        self.inner
            .try_with_value(|sync| sync.pending.front().cloned())
            .flatten()
    }

    /// 這個 Command 仍在等待結果。
    pub fn is_pending(&self, id: CommandId) -> bool {
        self.inner
            .try_with_value(|sync| sync.is_pending(id))
            .unwrap_or(false)
    }

    /// 送出佇列交來的結果（design A6）。401 已在 API 層依需求 4.8 換發並重試一次，這裡收到的是重試之後的結果。
    pub fn on_command_result(&self, id: CommandId, result: Result<CommandResponse, ApiFailure>) {
        let Some(outbox) = self.outbox() else {
            return;
        };
        // 這個請求已結束；佇列可以送出下一個（需求 13.3）
        outbox.finished(id);
        if !self.is_pending(id) {
            // 已由推送或補齊確認：回應或失敗都不再改變畫面（需求 13.13）
            return;
        }
        let mut toast = None;
        let mut merged = Merged::default();
        match result {
            Ok(response) => {
                self.inner.update_value(|sync| {
                    // 重送得到的第一次提交也一樣（需求 7.14、13.14）；「沒有變化」時不合併任何內容，只移除
                    if let Some(cs) = &response.changeset {
                        sync.merge_changeset(cs, &mut merged);
                    }
                    sync.remove_pending(id);
                    if !merged.trip_deleted {
                        sync.refresh_view(None);
                    }
                });
            }
            // Session 已失效並依需求 4.9 處理：保留 Pending_Command，之後依需求 4.10 或 4.14 處理
            Err(failure) if failure.is_unauthorized() => return,
            // 網路錯誤、15 秒逾時、5xx：保留預測，以同一個 Command_Id 重送（需求 13.9）
            Err(failure) if failure.is_retryable() && outbox.retry_later(id) => return,
            Err(failure) => {
                // 第 5 次重送也失敗時還原（需求 13.10）；400／403／404／409 時回復並顯示訊息（需求 13.8）
                toast = Some(if failure.is_retryable() {
                    SAVE_REVERTED.to_owned()
                } else {
                    failure.message
                });
                self.inner.update_value(|sync| {
                    // 畫面 = Replica 疊上其餘的 Pending_Command（需求 13.8、屬性 11）
                    sync.remove_pending(id);
                    sync.refresh_view(None);
                });
            }
        }
        if merged.trip_deleted {
            self.leave_trip(TRIP_DELETED);
            return;
        }
        if let Some(message) = toast {
            self.registry.toasts.show(message);
        }
        outbox.kick();
    }

    /// Trip_Channel 的 broadcast（需求 10.5、12.4）。
    pub fn on_broadcast(&self, payload: Broadcast) -> Option<Resync> {
        match payload {
            Broadcast::Thin { seq, .. } if !self.has_replica() => {
                // Snapshot 還沒到：記下來，Snapshot 比它舊時再補齊
                self.inner
                    .try_update_value(|sync| sync.early_head = sync.early_head.max(seq));
                None
            }
            Broadcast::Thin { seq, .. } if seq > self.watermark() => {
                Some(Resync::ChangesAfter(self.watermark()))
            }
            Broadcast::Thin { .. } => None,
            Broadcast::Full(cs) => self.on_changesets(std::slice::from_ref(&cs)),
        }
    }

    /// `GET /api/trips/{id}/changes` 的回應（需求 12.3、12.6）。
    pub fn on_changes(&self, response: ChangesResponse) -> Option<Resync> {
        match response {
            ChangesResponse::SnapshotRequired { .. } => Some(Resync::Snapshot),
            ChangesResponse::Changes { changesets, .. } => self.on_changesets(&changesets),
        }
    }

    /// `GET /api/trips/{id}/snapshot` 的回應：第一次時建立 Replica 並一起合併之前收到的 Change_Set（需求 12.1）；
    /// 之後依需求 12.10 合併。不移除 Pending_Command（需求 13.6）。合併之後仍有缺號時回傳要讀取的 Change_Set。
    pub fn on_snapshot(&self, snapshot: Snapshot) -> Option<Resync> {
        let merged = self
            .inner
            .try_update_value(|sync| sync.on_snapshot(&snapshot))?;
        self.after_merge(merged)
    }

    fn on_changesets(&self, changesets: &[ChangeSet]) -> Option<Resync> {
        let merged = self
            .inner
            .try_update_value(|sync| sync.on_changesets(changesets))?;
        self.after_merge(merged)
    }

    fn after_merge(&self, merged: Merged) -> Option<Resync> {
        if merged.trip_deleted {
            self.leave_trip(TRIP_DELETED);
            return None;
        }
        if !merged.confirmed.is_empty() {
            if let Some(outbox) = self.outbox() {
                for id in &merged.confirmed {
                    // 取消尚未進行的重送（需求 13.13）
                    outbox.cancel_retry(*id);
                }
                outbox.kick();
            }
        }
        merged.resync
    }

    /// 接上送出佇列（任務 20.3）。
    pub fn set_outbox(&self, outbox: Rc<dyn Outbox>) {
        self.inner.try_update_value(|sync| sync.outbox = outbox);
    }

    fn outbox(&self) -> Option<Rc<dyn Outbox>> {
        self.inner.try_with_value(|sync| Rc::clone(&sync.outbox))
    }

    fn pending_len(&self) -> usize {
        self.inner
            .try_with_value(|sync| sync.pending.len())
            .unwrap_or(0)
    }

    /// 設定畫面頂端的連線狀態（任務 20.4）。
    pub fn set_conn(&self, state: ConnState) {
        if self.conn.try_get_untracked() != Some(state) {
            self.conn.try_set(state);
        }
    }

    /// 離開這趟旅行（`trip_deleted`、需求 11.10 的權限不足、需求 12.16 的 404）：捨棄這個 `TripSync`，停在這趟旅行的
    /// Trip_Page 或 Departure_Page 時前往 Home_Page，並以 Toast 顯示 `message`。
    pub fn leave_trip(&self, message: &str) {
        self.registry.leave(self.trip, message);
    }
}

/// App 層的 `TripSync`，以旅行 id 為鍵。`Copy`，以 Leptos context 提供。
#[derive(Clone, Copy)]
pub struct TripSyncs {
    inner: StoredValue<Registry, LocalStorage>,
    auth: Auth,
    toasts: Toasts,
    /// 瀏覽器是否回報有網路連線
    online: RwSignal<bool>,
}

struct Registry {
    /// App 的 Owner；每個 `TripSync` 是它的一個子 Owner，不隨旅行頁卸載而釋放
    owner: Owner,
    entries: HashMap<TripId, Entry>,
}

struct Entry {
    /// 這個 `TripSync` 的 signal 與 `TripStores` 所屬的 Owner；捨棄時放掉它，裡面的 signal 一起釋放
    owner: Owner,
    handle: TripHandle,
}

impl TripSyncs {
    /// 建立並放進 context，並向登入狀態登記通知。在 App 的最外層、`Auth::provide()` 之後呼叫一次。
    pub fn provide(auth: Auth, toasts: Toasts) -> Self {
        let owner = Owner::current().unwrap_or_default();
        let syncs = Self {
            inner: StoredValue::new_local(Registry {
                owner,
                entries: HashMap::new(),
            }),
            auth,
            toasts,
            online: RwSignal::new(window().navigator().on_line()),
        };
        provide_context(syncs);
        // 監聽持續到分頁關閉：離線時暫停送出與重送，恢復上線時立即依原本的順序重送（需求 13.11、13.12）
        let _ = window_event_listener(ev::online, move |_| syncs.network_changed(true));
        let _ = window_event_listener(ev::offline, move |_| syncs.network_changed(false));
        auth.add_hooks(SessionHooks {
            // 新的 access token：以它依原本的順序送出保留的 Pending_Command（需求 4.10）
            token_changed: Box::new(move |_| {
                for handle in syncs.handles() {
                    if let Some(outbox) = handle.outbox() {
                        outbox.resume();
                    }
                }
            }),
            // 停止送出，Pending_Command 留在記憶體中（需求 4.9、4.12）
            session_lost: Box::new(move || {
                for handle in syncs.handles() {
                    if let Some(outbox) = handle.outbox() {
                        outbox.pause();
                    }
                }
            }),
            // 捨棄原 Account 的 Pending_Command 而不送出（需求 4.14）
            account_changed: Box::new(move || syncs.discard_all()),
            pending_count: Box::new(move || {
                syncs.handles().iter().map(TripHandle::pending_len).sum()
            }),
        });
        syncs
    }

    /// 瀏覽器是否回報有網路連線（需求 13.11）。
    pub fn online(&self) -> Signal<bool> {
        self.online.into()
    }

    fn network_changed(&self, online: bool) {
        if self.online.get_untracked() != online {
            self.online.set(online);
        }
        for handle in self.handles() {
            if let Some(outbox) = handle.outbox() {
                outbox.network_changed(online);
            }
        }
    }

    /// 這趟旅行的 `TripSync`：已有時沿用（例如前往 `/login` 再回來、在 Trip_Page 與 Departure_Page 之間切換），
    /// 否則建立一個還沒有 Replica 的。
    pub fn open(&self, trip: TripId) -> TripHandle {
        if let Some(handle) = self.get(trip) {
            return handle;
        }
        let registry = *self;
        let (owner, handle) = self.inner.with_value(|registry_state| {
            let owner = registry_state.owner.child();
            let weak = owner.downgrade();
            let handle = owner.with(|| {
                let signals = Signals {
                    stores: RwSignal::new(None),
                    revision: RwSignal::new(0),
                    pending_count: RwSignal::new(0),
                    remote_serial: RwSignal::new(0),
                    presence: TripPresence::new(trip),
                };
                TripHandle {
                    trip,
                    inner: StoredValue::new_local(TripSync {
                        trip,
                        viewer: None,
                        replica: None,
                        early: Vec::new(),
                        early_head: 0,
                        pending: VecDeque::new(),
                        view: None,
                        stores: None,
                        signals,
                        owner: weak,
                        outbox: Rc::new(NoOutbox),
                        remote_log: VecDeque::new(),
                    }),
                    stores: signals.stores,
                    revision: signals.revision,
                    conn: RwSignal::new(ConnState::Connecting),
                    pending_count: signals.pending_count,
                    save_retrying: RwSignal::new(false),
                    online: registry.online(),
                    remote_serial: signals.remote_serial,
                    presence: signals.presence,
                    editors: signals.presence.editors,
                    registry,
                }
            });
            (owner, handle)
        });
        self.inner.update_value(|registry_state| {
            registry_state.entries.insert(trip, Entry { owner, handle });
        });
        // 每個 TripSync 一個送出佇列（需求 13.3）
        handle.set_outbox(Rc::new(Sender::new(
            handle,
            Api::new(self.auth),
            handle.online,
            handle.save_retrying,
        )));
        handle
    }

    /// 已有的 `TripSync`。
    pub fn get(&self, trip: TripId) -> Option<TripHandle> {
        self.inner
            .try_with_value(|registry| registry.entries.get(&trip).map(|entry| entry.handle))
            .flatten()
    }

    fn handles(&self) -> Vec<TripHandle> {
        self.inner
            .try_with_value(|registry| registry.entries.values().map(|e| e.handle).collect())
            .unwrap_or_default()
    }

    /// 移除並捨棄；回傳捨棄的 Pending_Command 數量。
    fn discard(&self, entries: Vec<Entry>) -> usize {
        let mut discarded = 0;
        for entry in entries {
            discarded += entry.handle.pending_len();
            if let Some(outbox) = entry.handle.outbox() {
                outbox.stop();
            }
            // 旅行頁可能還在同一輪更新中讀取這些 signal：等路由前往別的畫面、旅行頁卸載之後才釋放
            let owner = entry.owner;
            set_timeout(move || drop(owner), Duration::ZERO);
        }
        discarded
    }

    /// 切換帳號（需求 4.14）：捨棄每個 `TripSync`，回傳捨棄的 Pending_Command 數量。
    fn discard_all(&self) -> usize {
        let entries: Vec<Entry> = self
            .inner
            .try_update_value(|registry| registry.entries.drain().map(|(_, e)| e).collect())
            .unwrap_or_default();
        self.discard(entries)
    }

    /// 離開一趟旅行（[`TripHandle::leave_trip`]）。
    fn leave(&self, trip: TripId, message: &str) {
        let entry = self
            .inner
            .try_update_value(|registry| registry.entries.remove(&trip))
            .flatten();
        let Some(entry) = entry else {
            return;
        };
        self.discard(vec![entry]);
        let path = window().location().pathname().unwrap_or_default();
        let on_trip = matches!(
            Screen::parse(&path),
            Screen::Trip { trip: t, .. } | Screen::Departure { trip: t, .. } if t == trip
        );
        if on_trip {
            if let Some(user) = self.auth.user().get_untracked() {
                self.auth.redirect_to(home_path(&user.username));
            }
        }
        self.toasts.show(message);
    }
}

/// 取得 App 提供的 `TripSyncs`。
pub fn use_trip_syncs() -> TripSyncs {
    expect_context::<TripSyncs>()
}
