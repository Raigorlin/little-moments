//! 誰正在編輯：Presence 狀態與這個分頁的回報（design 4.5、A11、A13）。
//!
//! - 其他分頁的 Presence_Meta 以 presence key 為鍵，每個分頁一筆 `(phx_ref, meta)`，不含這個分頁自己（需求 15.7）。
//!   `presence_state` 取代先前保存的全部內容，包括重新加入之前留下的（需求 16.21）；`presence_diff` 的 `leaves` 只移除
//!   `phx_ref` 相同的那一筆，`joins` 寫入新的一筆，所以另一個分頁換了 Edit_Target 時保存的那一筆換成新的內容，不會遺失，
//!   也不會留下新舊兩筆。無法解析成 `PresenceMeta` 的項目直接忽略，同一則訊息中的其他分頁照常處理（需求 15.8）。
//! - [`TripPresence::editors`] 以 `editor_stacks()` 依編輯對象分組，不含檢視者自己的帳號（需求 16.10）；顯示名稱的修剪與
//!   截斷由 LM_Core 處理（需求 16.14）。它是 `Memo`，沒有任何 Editor_Stack 改變時不通知讀取者（需求 16.17）。
//! - 這個分頁的 Presence_Meta 在開啟與關閉表單時改變（[`TripHandle::report_editing`](crate::sync::engine::TripHandle::report_editing)），
//!   交給 `PresenceThrottle`（需求 15.1–15.5），依 `WakeAt` 以 gloo-timers 喚醒。還沒加入 Trip_Channel 時只記下；每次
//!   加入成功先 `on_rejoin()`，再以目前的 Presence_Meta `offer()`，從未回報過時不送（需求 15.6、15.13）。
use std::collections::{BTreeMap, HashMap};

use gloo_timers::callback::Timeout;
use leptos::prelude::*;
use lm_core::ids::{PersonId, TripId, UserId};
use lm_core::presence::{
    editor_stacks, EditTarget, EditorStack, PresenceMeta, PresenceThrottle, ThrottleAction,
};
use serde_json::Value;

use crate::sync::realtime::{PresenceSink, TripChannels};

/// 其他分頁的 Presence：presence key → (phx_ref, Presence_Meta)。
type Others = HashMap<String, (String, PresenceMeta)>;

/// 這個分頁的回報狀態（不是 signal）。
struct Own {
    /// 接上 Trip_Channel 之後才有：送出 track 與判斷是否已加入
    channels: Option<TripChannels>,
    /// 這個分頁的 Presence_Key；`presence_state` 與 `presence_diff` 中這個鍵是自己，不保存
    key: Option<String>,
    /// 最後一次開啟或關閉表單時的 Presence_Meta；從未回報過時是 `None`（需求 15.6）
    current: Option<PresenceMeta>,
    throttle: PresenceThrottle,
    /// `WakeAt` 的計時器；取代或丟棄時取消
    timer: Option<Timeout>,
}

/// 一趟旅行的 Presence。`Copy`；signal 屬於 `TripSync` 的 Owner，`TripSync` 被捨棄時一起釋放（計時器也隨之取消）。
#[derive(Clone, Copy)]
pub struct TripPresence {
    trip: TripId,
    own: StoredValue<Own, LocalStorage>,
    others: RwSignal<Others>,
    /// 檢視者的帳號（最新的 Snapshot）；第一次的 Snapshot 之前是 `None`，`editors` 是空的
    viewer: RwSignal<Option<UserId>>,
    /// 每個編輯對象的 Editor_Stack，不含檢視者自己的帳號（design 4.5 的 `TripSync.editors`）
    pub editors: Memo<BTreeMap<EditTarget, EditorStack>>,
}

impl TripPresence {
    /// 在 `TripSync` 的 Owner 之下建立。
    pub fn new(trip: TripId) -> Self {
        let others = RwSignal::new(Others::new());
        let viewer = RwSignal::new(None::<UserId>);
        let editors = Memo::new(move |_| match viewer.get() {
            Some(user) => {
                others.with(|others| editor_stacks(others.values().map(|(_, meta)| meta), user))
            }
            None => BTreeMap::new(),
        });
        TripPresence {
            trip,
            own: StoredValue::new_local(Own {
                channels: None,
                key: None,
                current: None,
                throttle: PresenceThrottle::new(),
                timer: None,
            }),
            others,
            viewer,
            editors,
        }
    }

    /// 這個 Edit_Target 目前的 Editor_Stack（沒有其他 Account 在編輯時是 `None`）；在 reactive 範圍中讀取時依 `editors`
    /// 重算。
    #[allow(dead_code)]
    pub fn stack(&self, target: EditTarget) -> Option<EditorStack> {
        self.editors
            .try_with(|editors| editors.get(&target).cloned())
            .flatten()
    }

    /// 這個帳號目前在 Presence 中回報的 Bound_Person（需求 14.6）：不在 Presence 中、或回報的 Bound_Person 是空的時候
    /// 是 `None`（需求 14.7）。只讀目前保存的狀態，不追蹤 signal。
    pub fn person_of(&self, user: UserId) -> Option<PersonId> {
        self.others
            .try_with_untracked(|others| {
                others
                    .values()
                    .filter(|(_, meta)| meta.user == user)
                    .find_map(|(_, meta)| meta.person)
            })
            .flatten()
    }

    /// 合併 Snapshot 時設定檢視者（`editor_stacks()` 排除這個帳號）。
    pub(crate) fn set_viewer(&self, user: UserId) {
        if self.viewer.try_get_untracked() != Some(Some(user)) {
            self.viewer.try_set(Some(user));
        }
    }

    /// 接上這個分頁的 Trip_Channel（加入之前呼叫）。
    pub(crate) fn attach(&self, channels: TripChannels) {
        let key = channels.presence_key();
        self.own.try_update_value(|own| {
            own.channels = Some(channels);
            own.key = Some(key);
        });
    }

    /// 這個分頁的 Presence_Meta 改變了（開啟或關閉表單，需求 15.1、15.2）：記下來；已加入 Trip_Channel 時交給
    /// `PresenceThrottle`。
    pub(crate) fn report(&self, meta: PresenceMeta) {
        let action = self.own.try_update_value(|own| {
            own.current = Some(meta.clone());
            if !own.joined(self.trip) {
                // 加入成功時再以目前的 Presence_Meta 送出（需求 15.6）
                return ThrottleAction::Nothing;
            }
            own.throttle.offer(meta, js_sys::Date::now())
        });
        if let Some(action) = action {
            self.perform(action);
        }
    }

    /// `WakeAt` 的時間到了：送出保留的那一筆。這時沒有加入 Trip_Channel 時不送，加入成功時會重送目前的內容。
    fn wake(&self) {
        let action = self.own.try_update_value(|own| {
            own.timer = None;
            if !own.joined(self.trip) {
                return ThrottleAction::Nothing;
            }
            own.throttle.wake(js_sys::Date::now())
        });
        if let Some(action) = action {
            self.perform(action);
        }
    }

    /// 依 `PresenceThrottle` 的結果送出 track 或安排計時器。在 `own` 的借用結束之後呼叫。
    fn perform(&self, action: ThrottleAction) {
        match action {
            ThrottleAction::Send(meta) => {
                let channels = self.own.try_with_value(|own| own.channels).flatten();
                if let Some(channels) = channels {
                    channels.track(self.trip, &meta);
                }
            }
            ThrottleAction::WakeAt(at) => {
                let delay = (at - js_sys::Date::now()).clamp(0.0, f64::from(i32::MAX));
                let this = *self;
                // 毫秒的小數進位，避免在 6.5 秒到期前一刻醒來而再等一次
                let timer = Timeout::new(delay.ceil() as u32, move || this.wake());
                // 取代時舊的計時器被丟棄，也就取消了
                self.own.try_update_value(|own| own.timer = Some(timer));
            }
            ThrottleAction::Nothing => {}
        }
    }

    /// 這則訊息中每個分頁的內容：presence key → 最後一筆可以解析的 (phx_ref, meta)；不含這個分頁自己（需求 15.7、15.8）。
    fn parse(&self, value: &Value) -> Vec<(String, String, PresenceMeta)> {
        let own_key = self.own.try_with_value(|own| own.key.clone()).flatten();
        let mut parsed = Vec::new();
        let Some(entries) = value.as_object() else {
            return parsed;
        };
        for (key, entry) in entries {
            if own_key.as_deref() == Some(key.as_str()) {
                continue;
            }
            let last = metas(entry).iter().rev().find_map(|item| {
                // 無法解析成 Presence_Meta 的項目忽略（需求 15.8）；多出來的 phx_ref 等欄位不影響解析
                let meta = serde_json::from_value::<PresenceMeta>(item.clone()).ok()?;
                Some((phx_ref(item).unwrap_or_default().to_owned(), meta))
            });
            if let Some((reference, meta)) = last {
                parsed.push((key.clone(), reference, meta));
            }
        }
        parsed
    }
}

impl Own {
    fn joined(&self, trip: TripId) -> bool {
        self.channels
            .is_some_and(|channels| channels.is_joined(trip))
    }
}

/// `{"metas": [...]}` 中的項目；形狀不符時是空的。
fn metas(entry: &Value) -> &[Value] {
    entry
        .get("metas")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn phx_ref(item: &Value) -> Option<&str> {
    item.get("phx_ref").and_then(Value::as_str)
}

impl PresenceSink for TripPresence {
    /// 加入成功（包括重新加入，需求 11.7–11.9、15.13）：`on_rejoin()`，再以目前的 Presence_Meta `offer()`；從未回報過
    /// 時不送（需求 15.6）。
    fn rejoined(&self) {
        let action = self.own.try_update_value(|own| {
            own.throttle.on_rejoin();
            // 保留中的那一筆已捨棄，它的計時器也不再需要
            own.timer = None;
            match own.current.clone() {
                Some(meta) => own.throttle.offer(meta, js_sys::Date::now()),
                None => ThrottleAction::Nothing,
            }
        });
        if let Some(action) = action {
            self.perform(action);
        }
    }

    /// `presence_state`：取代先前保存的全部內容，包括重新加入之前的（需求 15.7、16.21）。
    fn reset(&self, state: Value) {
        let next: Others = self
            .parse(&state)
            .into_iter()
            .map(|(key, reference, meta)| (key, (reference, meta)))
            .collect();
        self.others.try_maybe_update(|others| {
            let changed = *others != next;
            if changed {
                *others = next;
            }
            (changed, ())
        });
    }

    /// `presence_diff`：`leaves` 只移除 `phx_ref` 相同的那一筆，`joins` 寫入新的一筆（需求 15.7）。
    fn apply(&self, joins: Value, leaves: Value) {
        let joined = self.parse(&joins);
        let own_key = self.own.try_with_value(|own| own.key.clone()).flatten();
        self.others.try_maybe_update(|others| {
            let mut changed = false;
            if let Some(entries) = leaves.as_object() {
                for (key, entry) in entries {
                    if own_key.as_deref() == Some(key.as_str()) {
                        continue;
                    }
                    let same = others.get(key).is_some_and(|(stored, _)| {
                        metas(entry)
                            .iter()
                            .any(|item| phx_ref(item) == Some(stored.as_str()))
                    });
                    if same {
                        others.remove(key);
                        changed = true;
                    }
                }
            }
            for (key, reference, meta) in joined {
                let entry = (reference, meta);
                if others.get(&key) != Some(&entry) {
                    others.insert(key, entry);
                    changed = true;
                }
            }
            (changed, ())
        });
    }
}
