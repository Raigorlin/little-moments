//! 瀏覽器的 Realtime 傳輸（design 2.1）：以 `web_sys::WebSocket` 實作 `RealtimeTransport`。只在 feature `web` 而且
//! `target_arch = "wasm32"` 時編譯，只由 lm-web 啟用（需求 1.10）。
//!
//! `WebSocketTransport` 把 WebSocket 的事件依發生順序轉成 `SocketEvent` 放進佇列；lm-web 以 `pop_event()` 逐一取出，
//! 交給 `PhoenixSocket::on_event()`。`set_notify()` 設定的通知在每次有事件放進佇列之後呼叫，lm-web 不必輪詢就能立即
//! 處理。heartbeat、逾時與退避的計時（`PhoenixSocket::wake_at()` 與 `tick()`）由 lm-web 負責。
//!
//! 連到的網址就是 `PhoenixSocket` 傳給 `connect()` 的網址，這裡不組成也不改寫：lm-web 以頁面的來源組成同源的
//! `/realtime/v1/websocket?vsn=1.0.0`（頁面為 http 時用 ws、https 時用 wss，需求 11.1）。
//!
//! # 事件的對應
//!
//! | WebSocket 的事件 | `SocketEvent` |
//! | --- | --- |
//! | `open` | `Opened` |
//! | `message`，資料是文字 | `Text`（資料是 Blob 或 ArrayBuffer 的二進位訊框不理會：協定 1.0.0 只用 JSON 文字訊框） |
//! | `error` | `Closed { code: 1006 }` |
//! | `close` | `Closed { code }`，`code` 是 `CloseEvent.code` |
//!
//! 每條連線只回報一次 `Closed`：`error` 與 `close` 中先到的那一個回報，另一個不理會。連線失敗時，瀏覽器在同一個工作中
//! 先觸發 `error`、緊接著觸發 `close`（WHATWG WebSockets 規格的關閉步驟），所以連線失敗（包括無法建立）回報的是
//! `error` 的 1006，與這時 `close` 事件的代碼相同；即使瀏覽器沒有接著觸發 `close`，`Closed` 也已回報。沒有 `error`
//! 的關閉（例如正常關閉）只觸發 `close`，回報它的代碼。`new WebSocket()` 當下就拋出例外（例如網址無效）時同樣回報
//! `Closed { code: 1006 }`，讓 `PhoenixSocket` 開始退避。所以 `connect()` 之後最後一定回報 `Opened` 或 `Closed`，
//! 符合 `RealtimeTransport` 的約定。
//!
//! # 不回報舊連線的事件
//!
//! `close()` 與 `connect()` 先移除目前這條 WebSocket 的四個事件處理函式再關閉它，並清空佇列。瀏覽器在觸發事件時才讀取
//! 處理函式，所以之後不再收到舊連線的事件；佇列中也只會有目前這條連線的事件。`pop_event()` 一次只取出一個，處理某個
//! 事件時若因此關閉或重新建立了連線，佇列中剩下的舊事件已被清除，不會再取出（`RealtimeTransport` 的約定）。
//!
//! # 通知
//!
//! 通知只在瀏覽器的工作中呼叫，不在這個傳輸的方法之內呼叫：WebSocket 的事件處理函式在事件放進佇列之後呼叫它；
//! `connect()` 當下就失敗時，`Closed` 立即放進佇列，通知則以 gloo-timers 的 0 毫秒 `Timeout` 延到之後的工作。所以
//! lm-web 在通知中可以借用自己的狀態、取出事件，並呼叫 `PhoenixSocket` 的方法（因此呼叫到這個傳輸的 `connect()`、
//! `send()` 與 `close()` 也可以）。每個事件各通知一次；佇列可能已被先前的通知取空，取不到事件時不做任何事即可。
//!
//! lm-web 的用法大致如下（`url` 是同源的網址；通知以 `Weak` 參照，避免與傳輸互相參照而無法釋放）：
//!
//! ```ignore
//! let socket = Rc::new(RefCell::new(PhoenixSocket::new(
//!     WebSocketTransport::new(), url, access_token, js_sys::Math::random,
//! )));
//! let weak = Rc::downgrade(&socket);
//! socket.borrow_mut().transport_mut().set_notify(move || {
//!     let Some(socket) = weak.upgrade() else { return };
//!     let mut socket = socket.borrow_mut();
//!     while let Some(event) = socket.transport_mut().pop_event() {
//!         for inbound in socket.on_event(event, js_sys::Date::now()) {
//!             // 交給頻道的處理（design A7）
//!         }
//!     }
//!     // 依 socket.wake_at() 重新安排呼叫 tick() 的計時器
//! });
//! ```

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;

use gloo_timers::callback::Timeout;
use wasm_bindgen::closure::Closure;
use wasm_bindgen::JsCast;
use web_sys::{CloseEvent, MessageEvent, WebSocket};

use super::socket::{RealtimeTransport, SocketEvent};

/// 正常關閉的關閉代碼（RFC 6455 7.4.1）：`close()` 以它關閉 WebSocket。
const NORMAL_CLOSURE: u16 = 1000;

/// 異常中斷的關閉代碼（RFC 6455 7.4.1）：沒有收到關閉訊框就結束，例如連線失敗或無法建立。
const ABNORMAL_CLOSURE: u16 = 1006;

/// 以瀏覽器的 `WebSocket` 實作的 `RealtimeTransport`（見模組說明）。
///
/// 同一時間最多一條 WebSocket。丟棄時（例如 lm-web 丟棄 `PhoenixSocket`）也移除事件處理函式並關閉 WebSocket，並取消
/// 延後的通知。
pub struct WebSocketTransport {
    /// 目前這條 WebSocket；還沒有 `connect()`、`close()` 之後，以及 `new WebSocket()` 失敗時是 `None`。
    connection: Option<Connection>,
    /// `connect()` 當下就失敗時，在之後的工作呼叫通知的計時器；丟棄時取消。
    deferred_notify: Option<Timeout>,
    /// 與事件處理函式共用的佇列與通知。
    shared: Rc<Shared>,
}

/// 事件處理函式與 `WebSocketTransport` 共用的狀態。
#[derive(Default)]
struct Shared {
    /// 還沒取出的事件，依發生順序。
    events: RefCell<VecDeque<SocketEvent>>,
    /// `set_notify()` 設定的通知。
    notify: RefCell<Option<Rc<dyn Fn()>>>,
}

impl Shared {
    /// 放進一個事件，再呼叫通知。只由事件處理函式呼叫（瀏覽器的工作中）。
    fn push(&self, event: SocketEvent) {
        self.events.borrow_mut().push_back(event);
        self.notify();
    }

    /// 呼叫通知。先複製出來、不再借用之後才呼叫，所以通知中可以取出事件，也可以重新設定通知。
    fn notify(&self) {
        let notify = self.notify.borrow().clone();
        if let Some(notify) = notify {
            notify();
        }
    }
}

/// 一條 WebSocket 與它的四個事件處理函式。丟棄時先移除處理函式再關閉 WebSocket，之後瀏覽器不再呼叫它們。
struct Connection {
    socket: WebSocket,
    // 只為了讓事件處理函式活到這條連線結束而保留；丟棄之後 JavaScript 端的函式也失效
    _on_open: Closure<dyn Fn()>,
    _on_message: Closure<dyn Fn(MessageEvent)>,
    _on_error: Closure<dyn Fn()>,
    _on_close: Closure<dyn Fn(CloseEvent)>,
}

impl Connection {
    /// 為剛建立的 `socket` 設定事件處理函式，把它的事件放進 `shared` 的佇列。
    fn new(socket: WebSocket, shared: &Rc<Shared>) -> Self {
        // error 與 close 中先到的那一個回報 Closed，這條連線只回報一次
        let closed = Rc::new(Cell::new(false));
        let on_open = {
            let shared = Rc::clone(shared);
            Closure::<dyn Fn()>::new(move || shared.push(SocketEvent::Opened))
        };
        let on_message = {
            let shared = Rc::clone(shared);
            Closure::<dyn Fn(MessageEvent)>::new(move |event: MessageEvent| {
                // 協定 1.0.0 只用 JSON 文字訊框；二進位訊框（data 是 Blob 或 ArrayBuffer）不理會
                if let Some(text) = event.data().as_string() {
                    shared.push(SocketEvent::Text(text));
                }
            })
        };
        let on_error = {
            let shared = Rc::clone(shared);
            let closed = Rc::clone(&closed);
            Closure::<dyn Fn()>::new(move || {
                if !closed.replace(true) {
                    shared.push(SocketEvent::Closed {
                        code: ABNORMAL_CLOSURE,
                    });
                }
            })
        };
        let on_close = {
            let shared = Rc::clone(shared);
            Closure::<dyn Fn(CloseEvent)>::new(move |event: CloseEvent| {
                if !closed.replace(true) {
                    shared.push(SocketEvent::Closed { code: event.code() });
                }
            })
        };
        socket.set_onopen(Some(on_open.as_ref().unchecked_ref()));
        socket.set_onmessage(Some(on_message.as_ref().unchecked_ref()));
        socket.set_onerror(Some(on_error.as_ref().unchecked_ref()));
        socket.set_onclose(Some(on_close.as_ref().unchecked_ref()));
        Self {
            socket,
            _on_open: on_open,
            _on_message: on_message,
            _on_error: on_error,
            _on_close: on_close,
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.socket.set_onopen(None);
        self.socket.set_onmessage(None);
        self.socket.set_onerror(None);
        self.socket.set_onclose(None);
        // 正在連線或已開啟時開始關閉，已在關閉或已關閉時不做任何事；1000 是允許的代碼，不會拋出例外
        let _ = self.socket.close_with_code(NORMAL_CLOSURE);
    }
}

impl WebSocketTransport {
    /// 建立還沒有連線的傳輸；`PhoenixSocket` 第一次 `join()` 時才呼叫 `connect()`。
    pub fn new() -> Self {
        Self {
            connection: None,
            deferred_notify: None,
            shared: Rc::default(),
        }
    }

    /// 設定（或取代）通知：每次有事件放進佇列之後呼叫一次，只在瀏覽器的工作中呼叫（見模組說明）。
    ///
    /// 請在第一次 `connect()`（也就是 `PhoenixSocket` 第一次 `join()`）之前設定；設定之前已放進佇列的事件不另外通知。
    pub fn set_notify(&mut self, notify: impl Fn() + 'static) {
        *self.shared.notify.borrow_mut() = Some(Rc::new(notify));
    }

    /// 取出最早的一個事件，交給 `PhoenixSocket::on_event()`；佇列是空的時回傳 `None`。
    ///
    /// 一次只取出一個：處理事件時若關閉或重新建立了連線，佇列中剩下的舊連線事件已被清除，不會再取出。
    pub fn pop_event(&mut self) -> Option<SocketEvent> {
        self.shared.events.borrow_mut().pop_front()
    }

    /// 結束目前的連線：移除事件處理函式並關閉 WebSocket、取消延後的通知，並清空佇列。
    fn reset(&mut self) {
        self.connection = None;
        self.deferred_notify = None;
        self.shared.events.borrow_mut().clear();
    }
}

impl Default for WebSocketTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl RealtimeTransport for WebSocketTransport {
    /// 先結束先前的連線（與 `close()` 相同），再建立連到 `url` 的 WebSocket。
    ///
    /// `new WebSocket()` 當下就拋出例外時（例如網址無效），把 `Closed { code: 1006 }` 放進佇列，並以 0 毫秒的
    /// `Timeout` 在之後的工作呼叫通知，不在這個方法之內呼叫。
    fn connect(&mut self, url: &str) {
        self.reset();
        match WebSocket::new(url) {
            Ok(socket) => self.connection = Some(Connection::new(socket, &self.shared)),
            Err(_) => {
                self.shared
                    .events
                    .borrow_mut()
                    .push_back(SocketEvent::Closed {
                        code: ABNORMAL_CLOSURE,
                    });
                let shared = Rc::clone(&self.shared);
                self.deferred_notify = Some(Timeout::new(0, move || shared.notify()));
            }
        }
    }

    /// 以 `send_with_str()` 送出一個文字訊框。
    ///
    /// 沒有連線，或瀏覽器拒絕送出時（只發生在還沒開啟的時候，`PhoenixSocket` 不會這樣呼叫）丟棄這個訊框，不 panic；
    /// 正在關閉或已關閉的 WebSocket 由瀏覽器丟棄訊框。遺失的 `phx_join` 與 heartbeat 由 `PhoenixSocket` 的逾時處理。
    fn send(&mut self, text: &str) {
        if let Some(connection) = &self.connection {
            let _ = connection.socket.send_with_str(text);
        }
    }

    /// 移除事件處理函式、以關閉代碼 1000 關閉 WebSocket，並清空佇列與取消延後的通知：之後不再回報這條連線的任何
    /// 事件。沒有連線時只清空佇列。
    fn close(&mut self) {
        self.reset();
    }
}
