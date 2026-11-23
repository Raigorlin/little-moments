//! 連線狀態機（design 2.1）：`RealtimeTransport`、`SocketEvent`、`Conn` 與 `PhoenixSocket`。
//!
//! `PhoenixSocket` 只經 `RealtimeTransport` 收送文字訊框，不使用瀏覽器、計時器、執行緒與系統時間：目前時間由呼叫端
//! 以 `now_ms`（毫秒，單調不減，例如瀏覽器的 `Date.now()`）傳入，退避的抖動來源在建立時傳入，所以原生目標的測試
//! 可以指定時間與抖動，不必等待實際時間（需求 1.6、33.7）。lm-web 把瀏覽器傳輸（`realtime::web`）回報的事件交給
//! `on_event()`，並在 `wake_at()` 回傳的時間（或定時）呼叫 `tick()`。
//!
//! # 連線、heartbeat 與加入逾時
//!
//! 第一次 `join()` 時建立 WebSocket，最後一個頻道 `leave()` 時關閉。每次 WebSocket 開啟（包括重新連線之後），對每個
//! 登記的頻道各送出一次 `phx_join`，帶目前的 access token 與那個頻道的 presence key，每次都用新的 join_ref。
//!
//! - heartbeat：從開啟起每 20 秒送出一次（第 20、40、60 … 秒，需求 11.6）；送出後滿 20 秒（下一次該送的時候）仍沒有
//!   回覆時，關閉這條 WebSocket、開始退避並回報 `Inbound::Disconnected`（需求 11.7）。等待回覆期間不送出下一個。
//! - 加入逾時：`phx_join` 送出後滿 10 秒仍沒有回覆時回報一次 `Inbound::JoinTimeout`，並放棄這次加入，之後才到的回覆
//!   不往上傳。伺服器拒絕加入時約 5 秒後才回覆，加入期間 heartbeat 的回覆也可能延遲數秒（任務 1.3），都在期限之內。
//!
//! # 退避
//!
//! 需求 11.7 的各種中斷共用一個計數：上次加入成功之後連續的第 1–4 次重試分別等 1、2、5、10 秒（`BACKOFF_MS`），
//! 第 5 次起都等 10 秒，各乘上 1 加 0–20% 的抖動（`BACKOFF_JITTER` 乘上抖動來源回傳的 0 到 1 之間的值）。等待從偵測到
//! 中斷時起算；頻道加入成功（收到這次加入的 `JoinOk`）時計數歸零，下一次中斷又從 1 秒開始。
//!
//! - WebSocket 關閉、無法建立或 heartbeat 逾時：進入 `Conn::Backoff`，到期時由 `tick()` 重新建立 WebSocket，開啟後
//!   重新加入每個頻道。
//! - 頻道的問題（加入被拒、加入逾時、`phx_close`、`phx_error`）：由呼叫端依 design A7 決定，需要退避時呼叫
//!   `rejoin_after_backoff()`；WebSocket 仍開著，所以到期時由 `tick()` 只重送那個頻道的 `phx_join`。
//!
//! 已有重試在等待時（`Conn::Backoff`，或有頻道在等 `rejoin_after_backoff()` 安排的時間），之後偵測到的中斷與它算
//! 同一次，不增加計數，也不另外安排：例如 heartbeat 逾時關閉連線之後傳輸回報的 `Closed`、`phx_error` 之後緊接著的
//! WebSocket 關閉，或同時被關閉的兩個頻道（需求 11.7「同時出現的多個上述情況只算一次」）。
//!
//! # 以 ref 過濾收到的訊框
//!
//! 收到的訊框沒有 `join_ref`（見 `realtime::protocol`），所以這裡記得每個頻道這次加入的 join_ref 與等待中的
//! heartbeat 的 ref：
//!
//! - `JoinOk` 與 `JoinError` 只有 `reference` 等於等待中的那次加入的 join_ref 時才往上傳；presence track、離開與
//!   access token 的回覆，以及已逾時或已被取代的加入的回覆，都不往上傳。
//! - `ChannelClosed` 與 `ChannelError` 只有屬於目前這次加入（`reference` 等於它的 join_ref，或沒有 `reference`）時才
//!   往上傳；重新加入同一個頻道時，伺服器為先前那次加入送出的 `phx_close` 不往上傳。
//! - `HeartbeatOk` 的 `reference` 等於等待中的 heartbeat 時才算收到回覆；heartbeat 的回覆與 `Other` 都不往上傳。
//! - `leave()` 之後不再認得那個頻道：它的離開回覆、`phx_close` 與之後的訊框都不往上傳。

use std::collections::BTreeMap;

use lm_core::presence::PresenceMeta;

use super::protocol::{
    access_token_frame, decode, encode, heartbeat_frame, join_frame, leave_frame, track_frame,
    Inbound,
};

/// 收送 Realtime 文字訊框的傳輸（需求 1.6）。瀏覽器以 `web_sys::WebSocket` 實作（`realtime::web`），測試以記錄送出
/// 內容的假傳輸實作。
///
/// 傳輸把連線的事件依發生順序以 `SocketEvent` 交給 `PhoenixSocket::on_event()`，並遵守：
///
/// - `connect()` 之後，這條連線最後一定回報 `Opened` 或 `Closed`；無法建立時（包括 `connect()` 當下就失敗）回報 `Closed`。
/// - 呼叫 `close()` 或下一次 `connect()` 之後，不再回報先前那條連線的任何事件；否則舊連線晚到的 `Closed` 會被當成
///   新連線的中斷。沒有連線時（`Conn::Idle`、`Conn::Backoff`）收到的事件一律不理會，所以同一條連線緊接著重複回報的
///   `Closed`（例如瀏覽器的 `error` 之後的 `close`）沒有影響。
pub trait RealtimeTransport {
    /// 建立連到 `url` 的 WebSocket。只在沒有連線時呼叫。
    fn connect(&mut self, url: &str);
    /// 送出一個文字訊框。只在這條連線回報 `Opened` 之後、關閉之前呼叫。
    fn send(&mut self, text: &str);
    /// 關閉目前的連線（heartbeat 逾時，或最後一個頻道離開時）。
    fn close(&mut self);
}

/// 傳輸回報的事件。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SocketEvent {
    /// WebSocket 已開啟（`open` 事件）。
    Opened,
    /// 收到一個文字訊框（`message` 事件）。
    Text(String),
    /// WebSocket 已關閉或無法建立（`close` 事件）；`code` 是關閉代碼，例如異常中斷的 1006。
    Closed { code: u16 },
}

/// WebSocket 的狀態（`PhoenixSocket::conn()`）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Conn {
    /// 沒有登記任何頻道，也沒有連線。
    Idle,
    /// 已呼叫 `RealtimeTransport::connect()`，等待 `Opened` 或 `Closed`。
    Connecting,
    /// WebSocket 已開啟。
    Open,
    /// WebSocket 已中斷，到 `until_ms` 時重新建立；`attempt` 是上次加入成功之後連續的第幾次重試（從 1 起算）。
    Backoff { attempt: u32, until_ms: f64 },
}

/// Realtime 協定 1.0.0 的用戶端連線：管理 WebSocket、heartbeat、頻道的加入與離開、加入逾時與退避後重連（需求 11.6、
/// 11.7），並過濾收到的訊框，只把呼叫端需要處理的事件交給它（見模組說明與 design A7）。
///
/// 與 design 2.1 的差異：`join()` 與 `rejoin_now()` 多了 `now_ms`，作為 10 秒加入逾時的起點；另外提供抖動的上限
/// `BACKOFF_JITTER`，以及 `conn()`、`is_joined()`、`wake_at()`、`transport()` 與 `transport_mut()`，讓呼叫端與測試
/// 查詢狀態、安排下一次 `tick()`。
pub struct PhoenixSocket<T: RealtimeTransport> {
    transport: T,
    /// 同源的 `/realtime/v1/websocket?vsn=1.0.0`（頁面為 http 時用 ws、https 時用 wss，由 lm-web 組成，需求 11.1）。
    url: String,
    conn: Conn,
    /// 頻道名稱 → 狀態；依名稱排序，所以開啟時依名稱的順序送出 `phx_join`。
    channels: BTreeMap<String, ChannelState>,
    /// 最後用過的 ref；每個送出的訊框（包括 heartbeat）各用一個新的。
    next_ref: u64,
    /// 已送出、還沒收到回覆的 heartbeat。
    pending_heartbeat: Option<PendingHeartbeat>,
    /// 這條連線開啟的時間；heartbeat 從這時起每 20 秒一次。
    opened_at_ms: f64,
    /// 下一次該送 heartbeat 的時間。
    next_heartbeat_ms: f64,
    /// 之後的 `phx_join` 與 `access_token` 帶的 access token。
    access_token: String,
    /// 上次加入成功之後，連續安排過的重試次數。
    retries: u32,
    /// 抖動來源：每次安排重試時呼叫一次。
    jitter: Box<dyn FnMut() -> f64>,
}

/// 已送出、還沒收到回覆的 heartbeat。
struct PendingHeartbeat {
    reference: String,
    sent_at_ms: f64,
}

/// 一個登記的頻道。
struct ChannelState {
    /// 這個分頁的 presence key（`phx_join` 的 `presence.key`）。
    presence_key: String,
    /// 這條連線上最後送出、伺服器可能仍保留的那次加入的 join_ref。加入被拒、頻道被關閉或 WebSocket 中斷時清除；加入
    /// 逾時時保留（伺服器可能已經加入），所以 `leave()` 仍以它送出 `phx_leave`。
    join_ref: Option<String>,
    /// `join_ref` 那次加入的狀態。
    state: JoinState,
    /// 伺服器上這次加入使用的 access token：`phx_join` 或之後的 `access_token` 帶的。
    server_token: String,
    /// `rejoin_after_backoff()` 安排的重送 `phx_join` 的時間；只在 WebSocket 開著時有值。
    retry_at_ms: Option<f64>,
}

/// 頻道這次加入的狀態。
#[derive(Clone, Copy, Debug, PartialEq)]
enum JoinState {
    /// 沒有等待中或成功的加入。
    NotJoined,
    /// 已送出 `phx_join`，到 `deadline_ms` 為止等待回覆。
    Pending { deadline_ms: f64 },
    /// 加入成功。
    Joined,
}

impl ChannelState {
    fn new(presence_key: &str) -> Self {
        Self {
            presence_key: presence_key.to_owned(),
            join_ref: None,
            state: JoinState::NotJoined,
            server_token: String::new(),
            retry_at_ms: None,
        }
    }

    /// `reference` 是等待中的那次加入的回覆。
    fn awaits(&self, reference: Option<&str>) -> bool {
        matches!(self.state, JoinState::Pending { .. })
            && matches!((reference, self.join_ref.as_deref()), (Some(got), Some(sent)) if got == sent)
    }

    /// `phx_close` 或 `phx_error` 屬於目前這次加入（等待中或已成功）：`reference` 等於它的 join_ref，或沒有
    /// `reference`（無法判斷是不是先前那次的）。
    fn holds(&self, reference: Option<&str>) -> bool {
        self.state != JoinState::NotJoined
            && (reference.is_none() || reference == self.join_ref.as_deref())
    }

    /// 伺服器結束了這次加入（被拒、關閉或錯誤）：它不再保留這次加入，離開時也不必送出 `phx_leave`。
    fn end_join(&mut self) {
        self.state = JoinState::NotJoined;
        self.join_ref = None;
    }

    /// WebSocket 中斷：這條連線上的加入都已不存在，等待中的頻道重試併入重新連線。
    fn reset(&mut self) {
        self.end_join();
        self.retry_at_ms = None;
    }
}

impl<T: RealtimeTransport> PhoenixSocket<T> {
    /// heartbeat 的間隔，從連線開啟起算（Supabase 的文件要求至少每 25 秒一次，需求 11.6）。
    pub const HEARTBEAT_MS: f64 = 20_000.0;
    /// heartbeat 送出後等待回覆的時間，也就是到下一次該送的時候；逾時就關閉連線並開始退避（需求 11.7）。
    pub const HEARTBEAT_TIMEOUT_MS: f64 = 20_000.0;
    /// `phx_join` 送出後等待回覆的時間；逾時回報 `Inbound::JoinTimeout`（需求 11.7）。
    pub const JOIN_TIMEOUT_MS: f64 = 10_000.0;
    /// 連續的第 1–4 次重試分別等 1、2、5、10 秒，第 5 次起都等最後一個值（需求 11.7）。
    pub const BACKOFF_MS: [f64; 4] = [1_000.0, 2_000.0, 5_000.0, 10_000.0];
    /// 抖動的上限：每次的等待乘上 1 加上這個值乘以抖動來源回傳的值，也就是延長 0–20%。
    pub const BACKOFF_JITTER: f64 = 0.2;

    /// 建立還沒連線的用戶端（`Conn::Idle`）；第一次 `join()` 時才建立 WebSocket。
    ///
    /// - `url`：同源的 `/realtime/v1/websocket?vsn=1.0.0` 的完整網址（ws 或 wss）。
    /// - `access_token`：Session 目前的 access token，之後的 `phx_join` 都帶它，換發後以 `set_access_token()` 更新。
    /// - `jitter`：每次安排重試時呼叫一次，回傳 0 到 1 之間的值（例如 `Math.random()`）；超出範圍時截到範圍內，NaN
    ///   當成 0。測試可以傳入固定的值或序列。
    pub fn new(
        transport: T,
        url: impl Into<String>,
        access_token: impl Into<String>,
        jitter: impl FnMut() -> f64 + 'static,
    ) -> Self {
        Self {
            transport,
            url: url.into(),
            conn: Conn::Idle,
            channels: BTreeMap::new(),
            next_ref: 0,
            pending_heartbeat: None,
            opened_at_ms: 0.0,
            next_heartbeat_ms: 0.0,
            access_token: access_token.into(),
            retries: 0,
            jitter: Box::new(jitter),
        }
    }

    /// 登記要加入的頻道 `topic`（例如 `trip:<小寫 UUID>`，不含 `realtime:` 前綴），以 `presence_key` 作為這個分頁的
    /// presence key（需求 11.3）。WebSocket 已開啟時立即送出 `phx_join`；還沒有連線時建立 WebSocket；正在連線或退避
    /// 時等開啟後再送出。之後每次重新連線都重新加入，直到 `leave()`。
    ///
    /// 已登記的頻道不重複登記，也不改變它的 presence key；要立即重新加入請用 `rejoin_now()`。`now_ms` 是立即送出
    /// `phx_join` 時加入逾時的起點（design 2.1 沒有這個參數）。
    pub fn join(&mut self, topic: &str, presence_key: &str, now_ms: f64) {
        if self.channels.contains_key(topic) {
            return;
        }
        self.channels
            .insert(topic.to_owned(), ChannelState::new(presence_key));
        match self.conn {
            Conn::Idle => self.connect(),
            Conn::Open => self.send_join(topic, now_ms),
            Conn::Connecting | Conn::Backoff { .. } => {}
        }
    }

    /// 離開頻道 `topic` 並忘記它：之後不再重新加入，也不再往上傳這個頻道的任何訊框（包括離開的回覆與 `phx_close`）。
    /// WebSocket 開著、而且伺服器可能保留這個頻道的加入時，送出 `phx_leave`，伺服器因此從其他成員的 Presence 移除
    /// 這個分頁（需求 11.13）。
    ///
    /// 離開的是最後一個頻道時關閉 WebSocket，取消等待中的重新連線，並把退避的計數歸零（回到 `Conn::Idle`）；之後的
    /// `join()` 重新建立連線。沒有登記的頻道不做任何事。
    pub fn leave(&mut self, topic: &str) {
        let Some(channel) = self.channels.remove(topic) else {
            return;
        };
        if self.conn == Conn::Open {
            if let Some(join_ref) = &channel.join_ref {
                let reference = take_ref(&mut self.next_ref);
                self.transport
                    .send(&encode(&leave_frame(topic, join_ref, &reference)));
            }
        }
        if self.channels.is_empty() {
            self.stop();
        }
    }

    /// 立即重新加入 `topic`（換發 Session 之後，需求 11.8、11.9）：WebSocket 開著時立即以目前的 access token 送出新的
    /// `phx_join`，並取消這個頻道等待中的退避；WebSocket 在退避中時立即重新建立（開啟後重新加入每個頻道），不增加
    /// 退避的計數；正在連線時等開啟後加入。沒有登記的頻道不做任何事。
    ///
    /// `now_ms` 是加入逾時的起點（design 2.1 沒有這個參數）。
    pub fn rejoin_now(&mut self, topic: &str, now_ms: f64) {
        if !self.channels.contains_key(topic) {
            return;
        }
        match self.conn {
            Conn::Open => self.send_join(topic, now_ms),
            Conn::Idle | Conn::Backoff { .. } => self.connect(),
            Conn::Connecting => {}
        }
    }

    /// 依退避的間隔重新加入 `topic`：加入被拒（需求 11.8、11.10 以外的原因）、加入逾時、頻道被關閉（包括 Presence
    /// 超過速率限制，需求 15.13）或發生錯誤之後（需求 11.7）。
    ///
    /// WebSocket 開著時，這個頻道改為未加入（放棄等待中的加入），在下一次重試的時間由 `tick()` 重送 `phx_join`；已有
    /// 重試在等待時沿用它的時間，不增加計數。WebSocket 已中斷或正在連線時不做任何事：重新連線之後本來就會重新加入
    /// 每個頻道，所以這次與 WebSocket 的中斷算同一次。沒有登記的頻道不做任何事。
    pub fn rejoin_after_backoff(&mut self, topic: &str, now_ms: f64) {
        if self.conn != Conn::Open {
            return;
        }
        let Some(channel) = self.channels.get(topic) else {
            return;
        };
        if channel.retry_at_ms.is_some() {
            return;
        }
        let retry_at_ms = match self.pending_retry_at() {
            Some(at) => at,
            None => self.schedule_retry(now_ms),
        };
        if let Some(channel) = self.channels.get_mut(topic) {
            channel.state = JoinState::NotJoined;
            channel.retry_at_ms = Some(retry_at_ms);
        }
    }

    /// 在已加入的頻道回報這個分頁的 Presence_Meta（presence track，需求 15.1、15.2）。
    ///
    /// 頻道還沒加入成功（正在加入、等待重試，或 WebSocket 正在重新連線）時不送出，也不保留：呼叫端在每次 `JoinOk`
    /// 之後依需求 15.6 重新 offer 目前的 Presence_Meta，所以最後的狀態仍會送出。這裡不做節流，節流由呼叫端的
    /// `PresenceThrottle` 負責（需求 15.3）。
    pub fn track(&mut self, topic: &str, meta: &PresenceMeta) {
        let Some(channel) = self.channels.get(topic) else {
            return;
        };
        if channel.state != JoinState::Joined {
            return;
        }
        if let Some(join_ref) = &channel.join_ref {
            let reference = take_ref(&mut self.next_ref);
            self.transport
                .send(&encode(&track_frame(topic, join_ref, &reference, meta)));
        }
    }

    /// 換發 Session 之後改用 `token`（需求 4.5、4.6）：對每個已加入的頻道各送出一則帶 `token` 的 `access_token`，之後
    /// 的 `phx_join` 也帶 `token`。伺服器上已經是這個 token 的頻道不重送；正在加入的頻道在加入成功時補送，因為它的
    /// `phx_join` 帶的是舊的 token。
    pub fn set_access_token(&mut self, token: &str) {
        token.clone_into(&mut self.access_token);
        for (topic, channel) in &mut self.channels {
            if channel.state != JoinState::Joined || channel.server_token == token {
                continue;
            }
            if let Some(join_ref) = &channel.join_ref {
                let reference = take_ref(&mut self.next_ref);
                self.transport.send(&encode(&access_token_frame(
                    topic, join_ref, &reference, token,
                )));
            }
            token.clone_into(&mut channel.server_token);
        }
    }

    /// 處理傳輸回報的事件，回傳要交給呼叫端的事件（design A7）。
    ///
    /// - `Opened`：開始計算 heartbeat，對每個登記的頻道各送出一次 `phx_join`；不回傳事件。
    /// - `Text`：解碼後依模組說明過濾，可能回傳一個 `JoinOk`、`JoinError`、`Broadcast`、`PresenceState`、
    ///   `PresenceDiff`、`ChannelClosed`、`ChannelError` 或 `System`；heartbeat 的回覆、`Other`、不屬於登記頻道的
    ///   訊框，以及無法解碼的文字都不回傳（不會 panic）。
    /// - `Closed`：WebSocket 開著或正在連線時開始退避，回傳 `Disconnected`；已在退避或沒有連線時不理會（同一次中斷
    ///   只算一次）。
    ///
    /// 不在預期狀態收到的 `Opened` 與 `Text`（例如退避中收到的）屬於已關閉的連線，不理會。
    pub fn on_event(&mut self, event: SocketEvent, now_ms: f64) -> Vec<Inbound> {
        match event {
            SocketEvent::Opened => {
                if self.conn == Conn::Connecting {
                    self.opened(now_ms);
                }
                Vec::new()
            }
            SocketEvent::Text(text) => {
                if self.conn != Conn::Open {
                    return Vec::new();
                }
                decode(&text)
                    .ok()
                    .and_then(|inbound| self.on_frame(inbound))
                    .into_iter()
                    .collect()
            }
            SocketEvent::Closed { .. } => match self.conn {
                Conn::Connecting | Conn::Open => vec![self.disconnected(now_ms)],
                Conn::Idle | Conn::Backoff { .. } => Vec::new(),
            },
        }
    }

    /// 處理到期的計時，回傳要交給呼叫端的事件：
    ///
    /// - heartbeat 送出後滿 20 秒仍沒有回覆：關閉 WebSocket、開始退避，只回傳 `Disconnected`（等待中的加入與重試都
    ///   併入這次中斷）。
    /// - 加入逾時：每個逾時的頻道各回傳一次 `JoinTimeout`。
    /// - 送出到期的頻道重試（`phx_join`）與 heartbeat；退避到期時重新建立 WebSocket。
    ///
    /// 在 `wake_at()` 的時間呼叫即可；提早或多呼叫沒有影響。
    pub fn tick(&mut self, now_ms: f64) -> Vec<Inbound> {
        match self.conn {
            Conn::Backoff { until_ms, .. } => {
                if now_ms >= until_ms {
                    self.connect();
                }
                Vec::new()
            }
            Conn::Open => self.tick_open(now_ms),
            Conn::Idle | Conn::Connecting => Vec::new(),
        }
    }

    /// 下一次 `tick()` 有事要做的時間：退避到期、heartbeat 該送或逾時、加入逾時或頻道重試的最早一個。沒有連線或
    /// 正在連線時是 `None`（等傳輸的事件即可）。
    pub fn wake_at(&self) -> Option<f64> {
        match self.conn {
            Conn::Backoff { until_ms, .. } => Some(until_ms),
            Conn::Open => {
                let heartbeat = match &self.pending_heartbeat {
                    Some(heartbeat) => heartbeat.sent_at_ms + Self::HEARTBEAT_TIMEOUT_MS,
                    None => self.next_heartbeat_ms,
                };
                let channels = self
                    .channels
                    .values()
                    .filter_map(|channel| match channel.state {
                        JoinState::Pending { deadline_ms } => Some(deadline_ms),
                        JoinState::NotJoined | JoinState::Joined => channel.retry_at_ms,
                    });
                Some(channels.fold(heartbeat, f64::min))
            }
            Conn::Idle | Conn::Connecting => None,
        }
    }

    /// WebSocket 目前的狀態。
    pub fn conn(&self) -> Conn {
        self.conn
    }

    /// `topic` 這次加入已成功（收到它的 `JoinOk`），而且還沒有被關閉、中斷或放棄。
    pub fn is_joined(&self, topic: &str) -> bool {
        self.channels
            .get(topic)
            .is_some_and(|channel| channel.state == JoinState::Joined)
    }

    /// 傳輸，例如測試讀取記錄的訊框。
    pub fn transport(&self) -> &T {
        &self.transport
    }

    /// 傳輸，例如 lm-web 取出瀏覽器傳輸佇列中的事件。
    pub fn transport_mut(&mut self) -> &mut T {
        &mut self.transport
    }

    fn connect(&mut self) {
        self.transport.connect(&self.url);
        self.conn = Conn::Connecting;
    }

    /// WebSocket 開啟：heartbeat 從現在起算，對每個登記的頻道各送出一次 `phx_join`。
    fn opened(&mut self, now_ms: f64) {
        self.conn = Conn::Open;
        self.opened_at_ms = now_ms;
        self.next_heartbeat_ms = now_ms + Self::HEARTBEAT_MS;
        self.pending_heartbeat = None;
        let topics: Vec<String> = self.channels.keys().cloned().collect();
        for topic in &topics {
            self.send_join(topic, now_ms);
        }
    }

    /// 沒有頻道了：關閉 WebSocket、取消等待中的重新連線，回到 `Conn::Idle`。
    fn stop(&mut self) {
        if matches!(self.conn, Conn::Connecting | Conn::Open) {
            self.transport.close();
        }
        self.conn = Conn::Idle;
        self.pending_heartbeat = None;
        self.retries = 0;
    }

    /// 對 `topic` 送出新的 `phx_join`（新的 join_ref、目前的 access token），等待回覆 10 秒。
    fn send_join(&mut self, topic: &str, now_ms: f64) {
        let Some(channel) = self.channels.get_mut(topic) else {
            return;
        };
        let join_ref = take_ref(&mut self.next_ref);
        self.transport.send(&encode(&join_frame(
            topic,
            &join_ref,
            &self.access_token,
            &channel.presence_key,
        )));
        channel.join_ref = Some(join_ref);
        channel.state = JoinState::Pending {
            deadline_ms: now_ms + Self::JOIN_TIMEOUT_MS,
        };
        channel.server_token.clone_from(&self.access_token);
        channel.retry_at_ms = None;
    }

    /// WebSocket 中斷（關閉、無法建立或 heartbeat 逾時）：這條連線上的加入與 heartbeat 都作廢，安排重新連線，回傳要
    /// 交給呼叫端的 `Disconnected`。已有頻道在等重試時與它算同一次中斷，沿用它的時間與計數。
    fn disconnected(&mut self, now_ms: f64) -> Inbound {
        let until_ms = match self.pending_retry_at() {
            Some(at) => at,
            None => self.schedule_retry(now_ms),
        };
        for channel in self.channels.values_mut() {
            channel.reset();
        }
        self.pending_heartbeat = None;
        self.conn = Conn::Backoff {
            attempt: self.retries.max(1),
            until_ms,
        };
        Inbound::Disconnected
    }

    /// 最早的一個等待中的頻道重試。
    fn pending_retry_at(&self) -> Option<f64> {
        self.channels
            .values()
            .filter_map(|channel| channel.retry_at_ms)
            .reduce(f64::min)
    }

    /// 安排下一次重試：計數加 1，回傳從 `now_ms` 起等待依計數與抖動決定的時間之後的時刻。
    fn schedule_retry(&mut self, now_ms: f64) -> f64 {
        self.retries = self.retries.saturating_add(1);
        let index = (self.retries as usize - 1).min(Self::BACKOFF_MS.len() - 1);
        let jitter = (self.jitter)();
        let jitter = if jitter.is_nan() {
            0.0
        } else {
            jitter.clamp(0.0, 1.0)
        };
        now_ms + Self::BACKOFF_MS[index] * (1.0 + Self::BACKOFF_JITTER * jitter)
    }

    fn tick_open(&mut self, now_ms: f64) -> Vec<Inbound> {
        let heartbeat_timed_out = self
            .pending_heartbeat
            .as_ref()
            .is_some_and(|heartbeat| now_ms >= heartbeat.sent_at_ms + Self::HEARTBEAT_TIMEOUT_MS);
        if heartbeat_timed_out {
            // 先關閉這條 WebSocket 再重新連線（需求 11.7）
            self.transport.close();
            return vec![self.disconnected(now_ms)];
        }
        let mut events = Vec::new();
        for (topic, channel) in &mut self.channels {
            if matches!(channel.state, JoinState::Pending { deadline_ms } if now_ms >= deadline_ms)
            {
                // 放棄這次加入，之後才到的回覆不往上傳；join_ref 保留，因為伺服器可能已經加入
                channel.state = JoinState::NotJoined;
                events.push(Inbound::JoinTimeout {
                    topic: topic.clone(),
                });
            }
        }
        let due: Vec<String> = self
            .channels
            .iter()
            .filter(|(_, channel)| channel.retry_at_ms.is_some_and(|at| now_ms >= at))
            .map(|(topic, _)| topic.clone())
            .collect();
        for topic in &due {
            self.send_join(topic, now_ms);
        }
        if self.pending_heartbeat.is_none() && now_ms >= self.next_heartbeat_ms {
            let reference = take_ref(&mut self.next_ref);
            self.transport.send(&encode(&heartbeat_frame(&reference)));
            self.pending_heartbeat = Some(PendingHeartbeat {
                reference,
                sent_at_ms: now_ms,
            });
            // 下一次仍從連線開啟起算；tick() 晚到時排在現在之後的那一次，不補送錯過的
            let periods = ((now_ms - self.opened_at_ms) / Self::HEARTBEAT_MS).floor() + 1.0;
            self.next_heartbeat_ms = self.opened_at_ms + periods * Self::HEARTBEAT_MS;
        }
        events
    }

    /// 過濾一個收到的訊框（見模組說明），回傳要交給呼叫端的事件。
    fn on_frame(&mut self, inbound: Inbound) -> Option<Inbound> {
        match inbound {
            Inbound::HeartbeatOk { reference } => {
                let answered = self.pending_heartbeat.as_ref().is_some_and(|heartbeat| {
                    reference.as_deref() == Some(heartbeat.reference.as_str())
                });
                if answered {
                    self.pending_heartbeat = None;
                }
                None
            }
            Inbound::JoinOk { topic, reference } => {
                let channel = self.channels.get_mut(&topic)?;
                if !channel.awaits(reference.as_deref()) {
                    return None;
                }
                channel.state = JoinState::Joined;
                self.retries = 0;
                if channel.server_token != self.access_token {
                    // 加入期間換發了 Session：伺服器上的是 phx_join 帶的舊 token，補送新的（需求 4.5）
                    if let Some(join_ref) = &channel.join_ref {
                        let push_ref = take_ref(&mut self.next_ref);
                        self.transport.send(&encode(&access_token_frame(
                            &topic,
                            join_ref,
                            &push_ref,
                            &self.access_token,
                        )));
                    }
                    channel.server_token.clone_from(&self.access_token);
                }
                Some(Inbound::JoinOk { topic, reference })
            }
            Inbound::JoinError {
                topic,
                reference,
                reason,
            } => {
                let channel = self.channels.get_mut(&topic)?;
                if !channel.awaits(reference.as_deref()) {
                    return None;
                }
                channel.end_join();
                Some(Inbound::JoinError {
                    topic,
                    reference,
                    reason,
                })
            }
            Inbound::ChannelClosed { topic, reference } => {
                let channel = self.channels.get_mut(&topic)?;
                if !channel.holds(reference.as_deref()) {
                    return None;
                }
                channel.end_join();
                Some(Inbound::ChannelClosed { topic, reference })
            }
            Inbound::ChannelError { topic, reference } => {
                let channel = self.channels.get_mut(&topic)?;
                if !channel.holds(reference.as_deref()) {
                    return None;
                }
                channel.end_join();
                Some(Inbound::ChannelError { topic, reference })
            }
            // broadcast、presence 與 system 不帶 ref，屬於登記的頻道就往上傳；Other 不往上傳
            other => {
                let known = match &other {
                    Inbound::Broadcast { topic, .. }
                    | Inbound::PresenceState { topic, .. }
                    | Inbound::PresenceDiff { topic, .. }
                    | Inbound::System { topic, .. } => self.channels.contains_key(topic),
                    _ => false,
                };
                known.then_some(other)
            }
        }
    }
}

/// 下一個 ref：每個送出的訊框各用一個，從 `"1"` 起遞增。
fn take_ref(counter: &mut u64) -> String {
    *counter += 1;
    counter.to_string()
}
