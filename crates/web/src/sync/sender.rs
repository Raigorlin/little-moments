//! 送出佇列（design 4.2、4.6）：每個 `TripSync` 一個，實作 [`Outbox`]。
//!
//! - 一次只送一個、先進先出：只送排在最前面的 Pending_Command；它有了結果（成功、拒絕、放棄或經推送、補齊確認）
//!   而且它的請求已結束之後，`TripHandle` 才把它移除並呼叫 [`Outbox::kick`]，這時才送出下一個（需求 13.3）。
//! - 每次送出最多等待 15 秒（`Api::command` 以 `REQUEST_TIMEOUT` 送出），逾時與網路錯誤相同（需求 13.9）。
//! - 網路錯誤、逾時或 5xx：以同一個 Command_Id 在前一次失敗後 1、2、4、8、16 秒重送；第 5 次重送也失敗時
//!   [`Outbox::retry_later`] 回傳 false，由 `TripHandle` 移除並以 Toast 顯示「儲存失敗，變更已還原」（需求 13.10）。
//!   等待重送的期間後面的 Pending_Command 也不送出（需求 13.3）；[`TripHandle::save_retrying`] 在這段期間為真，
//!   畫面頂端據此顯示「儲存失敗，正在重試」，直到這個 Command 有了結果（需求 13.9）。
//! - 離線時暫停送出與重送，離線期間的失敗不計入次數；恢復上線時不等剩餘的退避時間，依原本的順序立即送出，
//!   重送次數從 0 重新計算（需求 13.11、13.12）。
//! - 推送或補齊先確認了等待重送的 Command 時取消尚未進行的重送，進行中的請求仍等它結束（需求 13.13）。
//! - 400、403、404、409 的拒絕由 `TripHandle::on_command_result` 移除並顯示訊息（需求 13.8），這裡只送出下一個。
use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use leptos::prelude::*;
use leptos::task::spawn_local;
use lm_core::api::CommandRequest;
use lm_core::ids::CommandId;
use lm_core::sync::PendingCmd;

use crate::api::Api;
use crate::sync::engine::{Outbox, TripHandle};

/// 第 5 次重送（第 6 次送出）也失敗時放棄（需求 13.10）。
const MAX_RETRIES: u32 = 5;

/// 第 `retries + 1` 次重送前等待的時間：1、2、4、8、16 秒（需求 13.9）。
fn backoff(retries: u32) -> Duration {
    Duration::from_secs(1 << retries.min(MAX_RETRIES))
}

#[derive(Default)]
struct State {
    /// 進行中的請求（同一時間最多一個，需求 13.3）
    inflight: Option<CommandId>,
    /// 目前處理中的、排在最前面的 Pending_Command
    front: Option<CommandId>,
    /// `front` 已安排過的重送次數；換了 `front` 或恢復上線時歸零（需求 13.12）
    retries: u32,
    /// 等待中的重送計時器的代號；計時器到期時代號仍相同才送出，取消時設為 `None`
    waiting: Option<u64>,
    next_timer: u64,
    /// Session 失效或登出（需求 4.9、4.12）
    paused: bool,
    /// `TripSync` 已被捨棄（需求 4.14）
    stopped: bool,
}

struct Inner {
    handle: TripHandle,
    api: Api,
    /// 瀏覽器是否回報有網路連線（App 層共用）
    online: Signal<bool>,
    /// 排在最前面的 Pending_Command 送出失敗、正在等待重送或重送中（需求 13.9）
    retrying: RwSignal<bool>,
    state: RefCell<State>,
}

/// 一趟旅行的送出佇列。`Clone` 只複製參照，計時器與請求的 future 以它回到同一個佇列。
#[derive(Clone)]
pub struct Sender(Rc<Inner>);

impl Sender {
    pub fn new(
        handle: TripHandle,
        api: Api,
        online: Signal<bool>,
        retrying: RwSignal<bool>,
    ) -> Self {
        Self(Rc::new(Inner {
            handle,
            api,
            online,
            retrying,
            state: RefCell::new(State::default()),
        }))
    }

    fn is_online(&self) -> bool {
        self.0.online.try_get_untracked().unwrap_or(true)
    }

    fn set_retrying(&self, value: bool) {
        if self
            .0
            .retrying
            .try_get_untracked()
            .is_some_and(|v| v != value)
        {
            self.0.retrying.try_set(value);
        }
    }

    /// 送出一個 Command；結果交給 `TripHandle::on_command_result`，它會先呼叫 [`Outbox::finished`]。
    fn send(&self, cmd: PendingCmd) {
        let handle = self.0.handle;
        let api = self.0.api;
        spawn_local(async move {
            let id = cmd.id;
            let request = CommandRequest {
                command_id: cmd.id,
                command: cmd.command,
            };
            let result = api.command(handle.trip(), &request).await;
            handle.on_command_result(id, result);
        });
    }

    /// 重送的計時器到期。
    fn retry_due(&self, timer: u64) {
        let due = {
            let mut state = self.0.state.borrow_mut();
            let due = state.waiting == Some(timer);
            if due {
                state.waiting = None;
            }
            due
        };
        if due {
            self.kick();
        }
    }
}

impl Outbox for Sender {
    fn kick(&self) {
        let front = self.0.handle.front_pending();
        let online = self.is_online();
        let (send, front_changed) = {
            let mut state = self.0.state.borrow_mut();
            if state.stopped {
                return;
            }
            let front_id = front.as_ref().map(|cmd| cmd.id);
            // 排在最前面的換了一個：前一個已有結果，重新計算重送次數
            let front_changed = state.front != front_id;
            if front_changed {
                state.front = front_id;
                state.retries = 0;
                state.waiting = None;
            }
            let blocked =
                state.paused || !online || state.inflight.is_some() || state.waiting.is_some();
            let send = if blocked { None } else { front };
            if let Some(cmd) = &send {
                state.inflight = Some(cmd.id);
            }
            (send, front_changed)
        };
        if front_changed {
            self.set_retrying(false);
        }
        if let Some(cmd) = send {
            self.send(cmd);
        }
    }

    fn finished(&self, id: CommandId) {
        let mut state = self.0.state.borrow_mut();
        if state.inflight == Some(id) {
            state.inflight = None;
        }
    }

    fn retry_later(&self, id: CommandId) -> bool {
        let online = self.is_online();
        let timer = {
            let mut state = self.0.state.borrow_mut();
            if state.stopped {
                return true;
            }
            if state.front != Some(id) {
                state.front = Some(id);
                state.retries = 0;
                state.waiting = None;
            }
            if !online {
                // 離線期間的失敗不計入次數；恢復上線時立即重送（需求 13.11、13.12）
                None
            } else if state.retries >= MAX_RETRIES {
                // 第 5 次重送也失敗：由 TripHandle 移除並還原（需求 13.10）
                return false;
            } else {
                let delay = backoff(state.retries);
                state.retries += 1;
                state.next_timer += 1;
                let timer = state.next_timer;
                state.waiting = Some(timer);
                Some((timer, delay))
            }
        };
        self.set_retrying(true);
        if let Some((timer, delay)) = timer {
            let sender = self.clone();
            set_timeout(move || sender.retry_due(timer), delay);
        }
        true
    }

    fn cancel_retry(&self, id: CommandId) {
        let mut state = self.0.state.borrow_mut();
        if state.front == Some(id) {
            state.waiting = None;
        }
    }

    fn pause(&self) {
        let mut state = self.0.state.borrow_mut();
        state.paused = true;
        state.waiting = None;
    }

    fn resume(&self) {
        {
            let mut state = self.0.state.borrow_mut();
            if state.paused {
                // 以新的 Session 依原本的順序立即送出（需求 4.10）；只是換發了 access token 時照常等待退避
                state.paused = false;
                state.waiting = None;
            }
        }
        self.kick();
    }

    fn network_changed(&self, online: bool) {
        {
            let mut state = self.0.state.borrow_mut();
            // 離線時暫停重送；恢復上線時不等剩餘的退避時間，重送次數從 0 重新計算（需求 13.11、13.12）
            state.waiting = None;
            if online {
                state.retries = 0;
            }
        }
        if online {
            self.kick();
        }
    }

    fn stop(&self) {
        {
            let mut state = self.0.state.borrow_mut();
            state.stopped = true;
            state.waiting = None;
        }
        self.set_retrying(false);
    }
}
