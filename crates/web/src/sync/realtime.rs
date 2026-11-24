//! Trip_Channel 的生命週期與補齊（design A7）。
//!
//! - App 外框依目前的畫面呼叫 [`TripChannels::set_active`]：停在某趟旅行的 Trip_Page 或 Departure_Page 時加入它的
//!   Trip_Channel（直接開啟 Departure_Page 也一樣，需求 10.10、11.3），在這兩個畫面之間切換時沿用同一個頻道；前往其他
//!   畫面時離開，之後不再重新連線（需求 11.13）。
//! - 每個頻道一個 `PhoenixSocket`，經 lm-supabase 的瀏覽器傳輸連到同源的 `/realtime/v1/websocket?vsn=1.0.0`（頁面為
//!   http 時用 ws、https 時用 wss，需求 11.1），以 `trip:<小寫 UUID>` 與這個分頁的隨機 Presence_Key 加入；heartbeat、
//!   加入逾時與退避由 `PhoenixSocket` 處理（需求 11.6、11.7），這裡依它的 `wake_at()` 以 gloo-timers 呼叫 `tick()`。
//! - 傳輸的事件在通知中同步交給 `PhoenixSocket`，得到的 `Inbound` 與 Head 比對依到達的順序放進佇列，由一個 async 工作
//!   逐一處理（design A7 的 `run_trip_channel()`），所以同一時間最多一個補齊在進行。
//! - 加入成功之後才讀取 Snapshot 或 `changes?after=<Watermark>`（需求 12.1、12.2）；跳號、Thin_Notice 與無法解析的
//!   broadcast 立即補齊（需求 12.3、12.4）；`snapshot_required` 改讀 Snapshot（需求 12.6）；分頁變為可見、`online`
//!   與可見時每 60 秒比對 Head（需求 12.7）。404 時離開旅行（需求 12.16）；網路錯誤或 5xx 時 Replica 不變，等下一次
//!   事件再補（需求 12.17）。
//! - 換發成功（`SessionHooks::token_changed`）時以 `set_access_token()` 更新頻道（需求 4.5）；Session 失效、登出或切換
//!   帳號時離開頻道（需求 4.9、4.12、4.14）。
//!
//! Presence（`sync::presence`）：加入時把這趟旅行的 `TripPresence` 接上頻道（[`PresenceSink`]），它以
//! [`TripChannels::track`] 回報這個分頁的 Presence_Meta。
//!
//! 瀏覽器的 WebSocket 只在 wasm32 編譯；原生目標（`cargo clippy --workspace`）以不連線的替身代替，只為了讓這個 crate
//! 在原生目標也能編譯，不會在原生目標執行。
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;

use gloo_timers::callback::{Interval, Timeout};
use leptos::ev;
use leptos::prelude::*;
use leptos::task::spawn_local;
use lm_core::api::ChangesResponse;
use lm_core::ids::TripId;
use lm_core::presence::PresenceMeta;
use lm_core::sync::Broadcast;
use lm_supabase::realtime::protocol::Inbound;
use lm_supabase::realtime::socket::PhoenixSocket;
use serde_json::Value;
use uuid::Uuid;
use web_sys::VisibilityState;

use crate::api::{Api, ApiFailure};
use crate::session::{Auth, HookId, Refresh, SessionHooks};
use crate::sync::engine::{ConnState, Resync, TripHandle, TripSyncs};

#[cfg(target_arch = "wasm32")]
use lm_supabase::realtime::web::WebSocketTransport;

/// 加入被拒、原因是權限不足時的訊息（需求 11.10）。
const NO_ACCESS: &str = "你已無法存取這趟旅行。";
/// 分頁可見期間比對 Head 的間隔（需求 12.7）。
const HEAD_CHECK_MS: u32 = 60_000;

/// 原生目標的替身：不建立連線，也不回報任何事件。lm-web 只在瀏覽器執行，原生目標只做編譯與 clippy 檢查。
#[cfg(not(target_arch = "wasm32"))]
mod native {
    use lm_supabase::realtime::socket::{RealtimeTransport, SocketEvent};

    pub struct WebSocketTransport;

    impl WebSocketTransport {
        pub fn new() -> Self {
            Self
        }

        pub fn set_notify(&mut self, _notify: impl Fn() + 'static) {}

        pub fn pop_event(&mut self) -> Option<SocketEvent> {
            None
        }
    }

    impl RealtimeTransport for WebSocketTransport {
        fn connect(&mut self, _url: &str) {}
        fn send(&mut self, _text: &str) {}
        fn close(&mut self) {}
    }
}

#[cfg(not(target_arch = "wasm32"))]
use native::WebSocketTransport;

type Socket = PhoenixSocket<WebSocketTransport>;

/// 現在的時間（毫秒），作為 `PhoenixSocket` 的 `now_ms`。
fn now_ms() -> f64 {
    js_sys::Date::now()
}

/// 同源的 Realtime 網址：頁面為 https 時用 wss，否則用 ws；主機與埠與頁面相同（需求 11.1）。
fn realtime_url() -> String {
    let location = window().location();
    let scheme = match location.protocol().as_deref() {
        Ok("https:") => "wss",
        _ => "ws",
    };
    let host = location.host().unwrap_or_default();
    format!("{scheme}://{host}/realtime/v1/websocket?vsn=1.0.0")
}

/// 頻道名稱：`trip:` 加上旅行 id 的小寫 UUID 文字（需求 11.3）。
fn topic_for(trip: TripId) -> String {
    format!("trip:{}", trip.0.as_hyphenated())
}

fn page_visible() -> bool {
    document().visibility_state() == VisibilityState::Visible
}

/// Presence 的接口（任務 24.1）。預設的實作什麼都不做。
pub trait PresenceSink {
    /// 加入成功（包括重新加入），在補齊之前呼叫：`on_rejoin()`，再以目前的 Presence_Meta `offer()`（需求 15.6）。
    fn rejoined(&self) {}
    /// `presence_state`：取代全部，包括重新加入之前的（需求 15.7）。
    fn reset(&self, _state: Value) {}
    /// `presence_diff`（需求 15.8）。
    fn apply(&self, _joins: Value, _leaves: Value) {}
}

/// 佇列中等待處理的工作。
enum Work {
    Inbound(Inbound),
    /// 分頁變為可見、`online` 或可見時每 60 秒（需求 12.7）
    CheckHead,
}

/// 一個 Trip_Channel（一趟旅行、一次進入 Trip_Page 或 Departure_Page 到離開為止）。只由 `TripChannels` 持有；
/// 傳輸的通知、計時器與監聽都以弱參照指向它。
struct Channel {
    trip: TripId,
    topic: String,
    presence_key: String,
    handle: TripHandle,
    api: Api,
    auth: Auth,
    /// 取得 access token 之後才建立；離開之後是 `None`
    socket: RefCell<Option<Socket>>,
    queue: RefCell<VecDeque<Work>>,
    draining: Cell<bool>,
    stopped: Cell<bool>,
    /// 下一次呼叫 `tick()` 的計時器
    timer: RefCell<Option<Timeout>>,
    head_interval: RefCell<Option<Interval>>,
    listeners: RefCell<Vec<WindowListenerHandle>>,
    hook: Cell<Option<HookId>>,
    /// 這次加入失敗是在換發之後：再回報 access token 過期時改依退避重試（需求 11.8）
    refreshed_for_join: Cell<bool>,
    /// 收到 `Token has expired` 的 system 訊息，接著的 `phx_close` 要先換發再立即重新加入（需求 11.9）
    token_expired: Cell<bool>,
    presence: RefCell<Option<Rc<dyn PresenceSink>>>,
}

impl Channel {
    fn start(
        trip: TripId,
        handle: TripHandle,
        auth: Auth,
        presence_key: String,
        presence: Option<Rc<dyn PresenceSink>>,
    ) -> Rc<Self> {
        let channel = Rc::new(Self {
            trip,
            topic: topic_for(trip),
            presence_key,
            handle,
            api: Api::new(auth),
            auth,
            socket: RefCell::new(None),
            queue: RefCell::new(VecDeque::new()),
            draining: Cell::new(false),
            stopped: Cell::new(false),
            timer: RefCell::new(None),
            head_interval: RefCell::new(None),
            listeners: RefCell::new(Vec::new()),
            hook: Cell::new(None),
            refreshed_for_join: Cell::new(false),
            token_expired: Cell::new(false),
            presence: RefCell::new(presence),
        });
        handle.set_conn(ConnState::Connecting);
        channel.watch(&auth);
        let this = Rc::clone(&channel);
        spawn_local(async move {
            // 附上 Session 目前的 access token；離到期不到 60 秒時先換發（需求 4.5、11.3）
            let Some(token) = this.auth.access_token().await else {
                // 沒有可用的 Session：已依需求 4.9 處理，路由會離開這個畫面
                return;
            };
            if this.is_live() {
                this.connect(&token);
            }
        });
        channel
    }

    /// 登記換發與 Session 的通知、`visibilitychange` 與 `online` 的監聽，以及可見時每 60 秒的 Head 比對。
    fn watch(self: &Rc<Self>, auth: &Auth) {
        let weak = Rc::downgrade(self);
        let hook = auth.add_hooks(SessionHooks {
            token_changed: Box::new({
                let weak = weak.clone();
                move |token| {
                    if let Some(channel) = weak.upgrade() {
                        // 已加入的頻道送出 access_token，之後的 phx_join 也帶新的（需求 4.5）
                        channel.with_socket(|socket| socket.set_access_token(token));
                    }
                }
            }),
            session_lost: Box::new({
                let weak = weak.clone();
                move || {
                    if let Some(channel) = weak.upgrade() {
                        channel.stop();
                    }
                }
            }),
            account_changed: Box::new({
                let weak = weak.clone();
                move || {
                    if let Some(channel) = weak.upgrade() {
                        channel.stop();
                    }
                    0
                }
            }),
            pending_count: Box::new(|| 0),
        });
        self.hook.set(Some(hook));

        let on_visible = {
            let weak = weak.clone();
            window_event_listener_untyped("visibilitychange", move |_| {
                if page_visible() {
                    if let Some(channel) = weak.upgrade() {
                        channel.enqueue(Work::CheckHead);
                    }
                }
            })
        };
        let on_online = {
            let weak = weak.clone();
            window_event_listener(ev::online, move |_| {
                if let Some(channel) = weak.upgrade() {
                    channel.enqueue(Work::CheckHead);
                }
            })
        };
        self.listeners.borrow_mut().extend([on_visible, on_online]);
        // 分頁隱藏期間不做每 60 秒的讀取（需求 12.7）
        *self.head_interval.borrow_mut() = Some(Interval::new(HEAD_CHECK_MS, move || {
            if page_visible() {
                if let Some(channel) = weak.upgrade() {
                    channel.enqueue(Work::CheckHead);
                }
            }
        }));
    }

    /// 建立 `PhoenixSocket` 並加入 Trip_Channel。
    fn connect(self: &Rc<Self>, token: &str) {
        let mut transport = WebSocketTransport::new();
        let weak = Rc::downgrade(self);
        // 通知只在瀏覽器的工作中呼叫，不在傳輸的方法之內，所以這裡可以借用 socket
        transport.set_notify(move || {
            if let Some(channel) = weak.upgrade() {
                channel.pump();
            }
        });
        let mut socket = PhoenixSocket::new(transport, realtime_url(), token, js_sys::Math::random);
        socket.join(&self.topic, &self.presence_key, now_ms());
        *self.socket.borrow_mut() = Some(socket);
        self.reschedule();
    }

    /// 還在這個畫面，而且 `TripSync` 沒有被捨棄（`trip_deleted`、切換帳號等）。
    fn is_live(&self) -> bool {
        !self.stopped.get() && self.handle.is_open()
    }

    /// 對 `PhoenixSocket` 做一件事，之後依 `wake_at()` 重新安排計時器。還沒建立或已離開時不做任何事。
    fn with_socket<R>(self: &Rc<Self>, f: impl FnOnce(&mut Socket) -> R) -> Option<R> {
        let result = self.socket.borrow_mut().as_mut().map(f);
        self.reschedule();
        result
    }

    fn is_joined(&self) -> bool {
        self.socket
            .borrow()
            .as_ref()
            .is_some_and(|socket| socket.is_joined(&self.topic))
    }

    /// 依 `wake_at()` 安排下一次 `tick()`；沒有要等的時間時取消計時器。
    fn reschedule(self: &Rc<Self>) {
        let wake = self.socket.borrow().as_ref().and_then(Socket::wake_at);
        let next = wake.map(|at| {
            let delay = (at - now_ms()).clamp(0.0, f64::from(i32::MAX));
            let weak = Rc::downgrade(self);
            // 毫秒的小數進位，避免在到期前一刻醒來而白跑一次
            Timeout::new(delay.ceil() as u32, move || {
                if let Some(channel) = weak.upgrade() {
                    channel.on_timer();
                }
            })
        });
        // 取代時舊的計時器被丟棄，也就取消了
        *self.timer.borrow_mut() = next;
    }

    fn on_timer(self: &Rc<Self>) {
        let inbound = self
            .socket
            .borrow_mut()
            .as_mut()
            .map(|socket| socket.tick(now_ms()))
            .unwrap_or_default();
        self.reschedule();
        for event in inbound {
            self.enqueue(Work::Inbound(event));
        }
    }

    /// 傳輸的通知：取出佇列中的事件，交給 `PhoenixSocket`。
    fn pump(self: &Rc<Self>) {
        let mut inbound = Vec::new();
        if let Some(socket) = self.socket.borrow_mut().as_mut() {
            while let Some(event) = socket.transport_mut().pop_event() {
                inbound.extend(socket.on_event(event, now_ms()));
            }
        }
        self.reschedule();
        for event in inbound {
            self.enqueue(Work::Inbound(event));
        }
    }

    /// 放進佇列；沒有在處理時開始處理。
    fn enqueue(self: &Rc<Self>, work: Work) {
        if !self.is_live() {
            return;
        }
        self.queue.borrow_mut().push_back(work);
        if !self.draining.replace(true) {
            let this = Rc::clone(self);
            spawn_local(async move { this.drain().await });
        }
    }

    /// 依序處理佇列（design A7 的事件迴圈）；同一時間最多一個補齊在進行。
    async fn drain(self: Rc<Self>) {
        loop {
            let next = self.queue.borrow_mut().pop_front();
            let Some(work) = next else { break };
            if !self.is_live() {
                break;
            }
            match work {
                Work::Inbound(event) => self.on_inbound(event).await,
                Work::CheckHead => self.check_head().await,
            }
            if !self.handle.is_open() {
                // TripSync 已被捨棄（例如 trip_deleted 的 Change_Set）：不再重新連線
                self.stop();
            }
        }
        self.queue.borrow_mut().clear();
        self.draining.set(false);
    }

    async fn on_inbound(self: &Rc<Self>, event: Inbound) {
        match event {
            Inbound::JoinOk { .. } => {
                self.refreshed_for_join.set(false);
                let presence = self.presence.borrow().clone();
                if let Some(presence) = presence {
                    presence.rejoined();
                }
                // 加入之後才補齊，不留空窗（需求 12.1、12.2）
                let need = if !self.handle.has_replica() || self.handle.watermark() == 0 {
                    Resync::Snapshot
                } else {
                    Resync::ChangesAfter(self.handle.watermark())
                };
                self.resync(need).await;
            }
            Inbound::JoinError { reason, .. } if reason.starts_with("Unauthorized") => {
                // 權限不足：不是 Trip_Member 也不是 Admin、旅行已刪除，或頻道名稱不對（需求 11.10）
                self.leave(NO_ACCESS);
            }
            Inbound::JoinError { reason, .. }
                if reason.starts_with("InvalidJWTExpiration") && !self.refreshed_for_join.get() =>
            {
                // 換發後立即重新加入一次（需求 11.8）
                self.refreshed_for_join.set(true);
                self.handle.set_conn(ConnState::Reconnecting);
                self.refresh_then_rejoin().await;
            }
            Inbound::JoinError { .. } | Inbound::JoinTimeout { .. } => {
                // 暫時性的拒絕、換發後仍回報過期，或 10 秒內沒有回覆：依退避重試，不離開（需求 11.7）
                self.handle.set_conn(ConnState::Reconnecting);
                self.with_socket(|socket| socket.rejoin_after_backoff(&self.topic, now_ms()));
            }
            Inbound::Broadcast { payload, .. } => {
                let need = match serde_json::from_value::<Broadcast>(payload) {
                    Ok(message) => self.handle.on_broadcast(message),
                    // 看不懂的訊息：直接補齊（需求 12.4）
                    Err(_) => Some(Resync::ChangesAfter(self.handle.watermark())),
                };
                if let Some(need) = need {
                    if self.handle.has_replica() || need == Resync::Snapshot {
                        self.resync(need).await;
                    }
                    // 還沒有 Replica：加入成功之後的 Snapshot 會一起收斂（需求 12.1）
                }
            }
            Inbound::PresenceState { state, .. } => {
                let presence = self.presence.borrow().clone();
                if let Some(presence) = presence {
                    presence.reset(state);
                }
            }
            Inbound::PresenceDiff { joins, leaves, .. } => {
                let presence = self.presence.borrow().clone();
                if let Some(presence) = presence {
                    presence.apply(joins, leaves);
                }
            }
            // channel 層級的 system 錯誤之後一定是 phx_close（需求 11.9、15.13）
            Inbound::System { message, .. } => {
                self.token_expired
                    .set(message.contains("Token has expired"));
            }
            Inbound::ChannelClosed { .. } | Inbound::ChannelError { .. } => {
                self.handle.set_conn(ConnState::Reconnecting);
                if self.token_expired.replace(false) {
                    // 連線中 access token 過期：換發後立即重新加入，加入成功後補齊（需求 11.9）
                    self.refresh_then_rejoin().await;
                } else {
                    // 包括 Presence 超過速率限制（需求 15.13）
                    self.with_socket(|socket| socket.rejoin_after_backoff(&self.topic, now_ms()));
                }
            }
            // WebSocket 斷線、無法建立或 heartbeat 逾時：PhoenixSocket 依退避重新連線並重送 phx_join（需求 11.7）
            Inbound::Disconnected => self.handle.set_conn(ConnState::Reconnecting),
            _ => {}
        }
    }

    /// 換發 Session；成功時立即以新的 access token 重新加入（需求 11.8、11.9）。換發被拒絕時已依需求 4.9 處理
    /// （`session_lost` 會離開頻道）；網路錯誤、429 或 5xx 時依退避重試（需求 4.13）。
    async fn refresh_then_rejoin(self: &Rc<Self>) {
        let result = self.auth.refresh().await;
        if !self.is_live() {
            return;
        }
        match result {
            Refresh::Ok => {
                // token_changed 通常已更新；另一個分頁換發的 Session 也一樣以目前的 access token 加入
                let token = self.auth.access_token_now();
                self.with_socket(|socket| {
                    if let Some(token) = &token {
                        socket.set_access_token(token);
                    }
                    socket.rejoin_now(&self.topic, now_ms());
                });
            }
            Refresh::Rejected => self.stop(),
            Refresh::Unavailable(_) => {
                self.with_socket(|socket| socket.rejoin_after_backoff(&self.topic, now_ms()));
            }
        }
    }

    /// 分頁變為可見、`online` 或可見時每 60 秒：比對 Head，有落後才補齊（需求 12.7）。
    async fn check_head(self: &Rc<Self>) {
        if !self.handle.has_replica() {
            // 第一次的 Snapshot 失敗過：直接重讀，不先比對 Head（需求 12.17）；還沒加入成功時等加入之後再讀（需求 12.1）
            if self.is_joined() {
                self.resync(Resync::Snapshot).await;
            }
            return;
        }
        match self.api.head(self.handle.trip()).await {
            Ok(head) if head > self.handle.watermark() => {
                // Watermark 為 0 時讀取 Snapshot（需求 12.2）
                let need = match self.handle.watermark() {
                    0 => Resync::Snapshot,
                    watermark => Resync::ChangesAfter(watermark),
                };
                self.resync(need).await;
            }
            Ok(_) => self.mark_live(),
            Err(failure) => self.on_resync_error(&failure),
        }
    }

    /// 讀取 Snapshot 或 Change_Set 並合併，直到沒有缺號（需求 12.3、12.6）。
    async fn resync(self: &Rc<Self>, mut need: Resync) {
        let trip = self.handle.trip();
        loop {
            if !self.is_live() {
                return;
            }
            let next = match need {
                Resync::Snapshot => match self.api.snapshot(trip).await {
                    Ok(snapshot) if self.is_live() => self.handle.on_snapshot(snapshot),
                    Ok(_) => return,
                    Err(failure) => return self.on_resync_error(&failure),
                },
                Resync::ChangesAfter(watermark) => match self.api.changes(trip, watermark).await {
                    Ok(_) if !self.is_live() => return,
                    // Head 減 Watermark 超過 500（需求 12.6）
                    Ok(ChangesResponse::SnapshotRequired { .. }) => Some(Resync::Snapshot),
                    // 補齊期間又有新提交或仍有缺號時繼續（需求 12.3）
                    Ok(changes) => self.handle.on_changes(changes),
                    Err(failure) => return self.on_resync_error(&failure),
                },
            };
            match next {
                Some(more) => need = more,
                None => return self.mark_live(),
            }
        }
    }

    /// 補齊完成：已重新加入時移除「重新連線中」的提示（需求 11.11）。
    fn mark_live(&self) {
        if self.is_live() && self.handle.has_replica() && self.is_joined() {
            self.handle.set_conn(ConnState::Live);
        }
    }

    /// 補齊失敗。404（例如旅行已被刪除，但 trip_deleted 的推送沒有送達）時停止補齊並離開，顯示伺服器的訊息
    /// （需求 12.16）；網路錯誤、逾時或 5xx 時 Replica 與 Watermark 不變，等下一次事件再補（需求 12.17）。401 已在
    /// API 層處理（需求 4.8）。
    fn on_resync_error(&self, failure: &ApiFailure) {
        if failure.status == Some(404) {
            self.leave(&failure.message);
        }
    }

    /// 離開頻道與這趟旅行：前往 Home_Page 並以 Toast 顯示 `message`。
    fn leave(&self, message: &str) {
        self.stop();
        self.handle.leave_trip(message);
    }

    /// 離開 Trip_Channel，之後不再重新連線或重新加入（需求 11.13）。送出 `phx_leave`，使這個分頁的 Presence_Meta
    /// 從其他成員的 Presence 中移除。
    fn stop(&self) {
        if self.stopped.replace(true) {
            return;
        }
        if let Some(mut socket) = self.socket.borrow_mut().take() {
            // 最後一個頻道離開時 PhoenixSocket 關閉 WebSocket；丟棄傳輸時也移除事件處理函式
            socket.leave(&self.topic);
        }
        self.timer.borrow_mut().take();
        self.head_interval.borrow_mut().take();
        for listener in self.listeners.borrow_mut().drain(..) {
            listener.remove();
        }
        if let Some(hook) = self.hook.take() {
            self.auth.remove_hooks(hook);
        }
        self.queue.borrow_mut().clear();
    }
}

/// App 層的 Trip_Channel：同一個分頁同時最多一個（目前畫面的那趟旅行）。`Copy`，以 Leptos context 提供。
#[derive(Clone, Copy)]
pub struct TripChannels {
    inner: StoredValue<Channels, LocalStorage>,
    auth: Auth,
    syncs: TripSyncs,
}

struct Channels {
    /// 這個分頁的 Presence_Key：每個分頁隨機產生一次（需求 11.3）
    presence_key: String,
    current: Option<Rc<Channel>>,
}

impl TripChannels {
    /// 建立並放進 context。在 App 的最外層、`TripSyncs::provide()` 之後呼叫一次。
    pub fn provide(auth: Auth, syncs: TripSyncs) -> Self {
        let channels = Self {
            inner: StoredValue::new_local(Channels {
                presence_key: Uuid::new_v4().to_string(),
                current: None,
            }),
            auth,
            syncs,
        };
        provide_context(channels);
        channels
    }

    /// 目前畫面的旅行：停在它的 Trip_Page 或 Departure_Page 時是 `Some`（需求 10.10、11.3），其他畫面是 `None`
    /// （需求 11.13）。同一趟旅行的頻道還在時沿用；離開過（權限不足、404、Session 失效）或 `TripSync` 已被捨棄時，
    /// 再次進入這趟旅行才重新加入。
    pub fn set_active(&self, trip: Option<TripId>) {
        let keep = self
            .inner
            .try_with_value(|state| {
                state
                    .current
                    .as_ref()
                    .is_some_and(|channel| Some(channel.trip) == trip && channel.is_live())
            })
            .unwrap_or(false);
        if keep {
            return;
        }
        let previous = self
            .inner
            .try_update_value(|state| state.current.take())
            .flatten();
        if let Some(previous) = previous {
            previous.stop();
        }
        let Some(trip) = trip else {
            return;
        };
        let handle = self.syncs.open(trip);
        let presence_key = self.presence_key();
        // 這趟旅行的 Presence：接收其他分頁的狀態，並經這個頻道回報這個分頁的 Presence_Meta（任務 24.1）
        handle.presence.attach(*self);
        let sink: Rc<dyn PresenceSink> = Rc::new(handle.presence);
        let channel = Channel::start(trip, handle, self.auth, presence_key, Some(sink));
        self.inner
            .update_value(|state| state.current = Some(channel));
    }

    /// 這個分頁的 Presence_Key（每個分頁隨機產生一次，需求 11.3）。
    pub fn presence_key(&self) -> String {
        self.inner
            .try_with_value(|state| state.presence_key.clone())
            .unwrap_or_default()
    }

    /// 這趟旅行的 Trip_Channel 目前已加入成功。
    pub fn is_joined(&self, trip: TripId) -> bool {
        self.current(trip)
            .is_some_and(|channel| channel.is_joined())
    }

    /// 在已加入的 Trip_Channel 回報這個分頁的 Presence_Meta（需求 15.1、15.2）；還沒加入成功時不送出。
    pub fn track(&self, trip: TripId, meta: &PresenceMeta) {
        if let Some(channel) = self.current(trip) {
            channel.with_socket(|socket| socket.track(&channel.topic, meta));
        }
    }

    fn current(&self, trip: TripId) -> Option<Rc<Channel>> {
        self.inner
            .try_with_value(|state| {
                state
                    .current
                    .as_ref()
                    .filter(|channel| channel.trip == trip && channel.is_live())
                    .cloned()
            })
            .flatten()
    }
}
