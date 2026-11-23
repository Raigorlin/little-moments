//! Realtime 連線狀態機的單元測試（任務 12.3；需求 33.7 (a)、(c)–(g)，另含需求 11.7 的加入逾時與頻道的重試）。
//!
//! `PhoenixSocket` 接上記錄送出內容的假傳輸（`FakeTransport`），不連網路、Database 或 Realtime_Service（需求 33.8）。
//! 時間是測試傳給 `on_event()` 與 `tick()` 的毫秒數，退避的抖動是測試放在 `Cell` 中的值，所以不等待實際時間。傳輸的
//! 事件（開啟、收到訊框、中斷）由測試以 `Harness` 的方法交給狀態機；收到的訊框使用任務 1.3 實測的 Realtime v2.167.0
//! 格式：只有 `ref`、`event`、`payload` 與 `topic`，沒有 `join_ref`。

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use lm_supabase::realtime::protocol::Inbound;
use lm_supabase::realtime::socket::{Conn, PhoenixSocket, RealtimeTransport, SocketEvent};
use serde_json::{json, Value};

/// 同源的 Realtime 網址（需求 11.1）；假傳輸只記下它。
const URL: &str = "ws://localhost:8080/realtime/v1/websocket?vsn=1.0.0";
/// Trip_Channel 的名稱：`trip:` 加上旅行 id 的小寫 UUID（需求 11.3）。
const TRIP: &str = "trip:c00a4ae1-58f0-464b-9aa7-638ed8090bab";
const OTHER_TRIP: &str = "trip:4edae78b-2f8f-461c-85c3-2bc503e3f36f";
const THIRD_TRIP: &str = "trip:1b20c20a-ac50-4563-9c39-a96272b5c07d";
/// 這個分頁的 presence key。
const TAB: &str = "tab-a";

// ── 假傳輸與測試的外殼 ──

/// 假傳輸看到的連線狀態。
#[derive(Clone, Copy, Debug, Default, PartialEq)]
enum Link {
    #[default]
    Closed,
    Connecting,
    Open,
}

/// 記錄送出內容的假 `RealtimeTransport`：不連網路，只記下 `connect()`、`send()` 與 `close()`，並檢查 trait 的約定：
/// `connect()` 只在沒有連線時呼叫，`send()` 只在連線開啟之後、關閉之前呼叫。連線何時開啟或中斷由測試決定。
#[derive(Default)]
struct FakeTransport {
    /// 送出的文字訊框，依送出的順序；`Harness::take_sent()` 取出後清空。
    sent: Vec<String>,
    connects: u32,
    closes: u32,
    last_url: Option<String>,
    link: Link,
}

impl RealtimeTransport for FakeTransport {
    fn connect(&mut self, url: &str) {
        assert_eq!(self.link, Link::Closed, "還有連線時呼叫 connect()");
        self.connects += 1;
        self.last_url = Some(url.to_owned());
        self.link = Link::Connecting;
    }

    fn send(&mut self, text: &str) {
        assert_eq!(self.link, Link::Open, "連線沒有開啟時送出 {text}");
        self.sent.push(text.to_owned());
    }

    fn close(&mut self) {
        assert_ne!(self.link, Link::Closed, "沒有連線時呼叫 close()");
        self.closes += 1;
        self.link = Link::Closed;
    }
}

/// 狀態機、假傳輸與測試控制的抖動。
struct Harness {
    socket: PhoenixSocket<FakeTransport>,
    /// 抖動來源每次回傳的值；預設 0，測試可以隨時改。
    jitter: Rc<Cell<f64>>,
}

impl Harness {
    fn new(access_token: &str) -> Self {
        let jitter = Rc::new(Cell::new(0.0));
        let source = Rc::clone(&jitter);
        let socket = PhoenixSocket::new(FakeTransport::default(), URL, access_token, move || {
            source.get()
        });
        Self { socket, jitter }
    }

    fn transport(&self) -> &FakeTransport {
        self.socket.transport()
    }

    /// 傳輸回報 WebSocket 已開啟。
    fn open(&mut self, now_ms: f64) -> Vec<Inbound> {
        let transport = self.socket.transport_mut();
        assert_eq!(transport.link, Link::Connecting, "開啟之前要先 connect()");
        transport.link = Link::Open;
        self.socket.on_event(SocketEvent::Opened, now_ms)
    }

    /// 傳輸回報 WebSocket 中斷或無法建立（異常關閉的代碼 1006）。
    fn drop_connection(&mut self, now_ms: f64) -> Vec<Inbound> {
        self.socket.transport_mut().link = Link::Closed;
        self.socket
            .on_event(SocketEvent::Closed { code: 1006 }, now_ms)
    }

    /// 收到一個訊框。
    fn receive(&mut self, frame: Value, now_ms: f64) -> Vec<Inbound> {
        self.socket
            .on_event(SocketEvent::Text(frame.to_string()), now_ms)
    }

    /// 伺服器回覆加入成功（任務 1.3 的 join-ok.txt 的格式）。
    fn join_ok(&mut self, topic: &str, join_ref: &str, now_ms: f64) -> Vec<Inbound> {
        self.receive(
            json!({
                "ref": join_ref,
                "event": "phx_reply",
                "payload": { "status": "ok", "response": { "postgres_changes": [] } },
                "topic": format!("realtime:{topic}")
            }),
            now_ms,
        )
    }

    /// 伺服器回覆 heartbeat（任務 1.3 的 heartbeat.txt 的格式）。
    fn heartbeat_ok(&mut self, reference: &str, now_ms: f64) -> Vec<Inbound> {
        self.receive(
            json!({
                "ref": reference,
                "event": "phx_reply",
                "payload": { "status": "ok", "response": {} },
                "topic": "phoenix"
            }),
            now_ms,
        )
    }

    /// 取出到目前為止送出的訊框，解析成 JSON。
    fn take_sent(&mut self) -> Vec<Value> {
        self.socket
            .transport_mut()
            .sent
            .drain(..)
            .map(|text| serde_json::from_str(&text).expect("送出的訊框是 JSON"))
            .collect()
    }

    /// 登記 `topic`，在 `now_ms` 開啟 WebSocket 並加入成功；回傳這次加入的 join_ref。
    fn join_and_open(&mut self, topic: &str, now_ms: f64) -> String {
        self.socket.join(topic, TAB, now_ms);
        self.open(now_ms);
        let join_ref = text(&single(self.take_sent())["ref"]);
        assert_eq!(
            self.join_ok(topic, &join_ref, now_ms + 8.0),
            [Inbound::JoinOk {
                topic: topic.into(),
                reference: Some(join_ref.clone()),
            }]
        );
        join_ref
    }

    /// 目前的退避：上次加入成功之後的第幾次重試，以及重新連線的時間。
    fn backoff(&self) -> (u32, f64) {
        match self.socket.conn() {
            Conn::Backoff { attempt, until_ms } => (attempt, until_ms),
            other => panic!("預期在退避中，實際是 {other:?}"),
        }
    }
}

/// 唯一的一個送出的訊框。
fn single(mut frames: Vec<Value>) -> Value {
    assert_eq!(frames.len(), 1, "預期送出一個訊框：{frames:?}");
    frames.remove(0)
}

/// JSON 字串的值。
fn text(value: &Value) -> String {
    value
        .as_str()
        .unwrap_or_else(|| panic!("預期是字串：{value}"))
        .to_owned()
}

/// 頻道上的訊框所屬的頻道名稱（去掉 `realtime:`）。
fn channel(frame: &Value) -> String {
    text(&frame["topic"])
        .strip_prefix("realtime:")
        .unwrap_or_else(|| panic!("不是頻道上的訊框：{frame}"))
        .to_owned()
}

/// 送出的 `phx_join`，依頻道名稱；每個頻道只能有一個。
fn joins_by_topic(frames: &[Value]) -> BTreeMap<String, Value> {
    let mut joins = BTreeMap::new();
    for frame in frames {
        assert_eq!(frame["event"], "phx_join", "{frame}");
        let previous = joins.insert(channel(frame), frame.clone());
        assert!(previous.is_none(), "同一個頻道送出兩次 phx_join：{frame}");
    }
    joins
}

/// 檢查 heartbeat 的格式（topic `phoenix`、payload `{}`、`join_ref` 是 null），回傳它的 ref。
fn heartbeat_ref(frame: &Value) -> String {
    let reference = text(&frame["ref"]);
    assert_eq!(
        *frame,
        json!({
            "topic": "phoenix",
            "event": "heartbeat",
            "payload": {},
            "ref": reference,
            "join_ref": null
        })
    );
    reference
}

// ── 需求 33.7 ──

/// 需求 33.7 (a)：加入 Trip_Channel 的訊息指定私有頻道 `trip:<旅行 id>`，帶這個分頁的 presence key 與目前的 access
/// token。
#[test]
fn join_targets_the_private_trip_channel_with_presence_key_and_token() {
    let mut h = Harness::new("token-1");
    h.socket.join(TRIP, TAB, 0.0);
    // 第一次 join() 建立 WebSocket；開啟之前不送出任何訊框
    assert_eq!(h.transport().connects, 1);
    assert_eq!(h.transport().last_url.as_deref(), Some(URL));
    assert_eq!(h.socket.conn(), Conn::Connecting);
    assert!(h.take_sent().is_empty());

    assert!(h.open(5.0).is_empty());
    let join = single(h.take_sent());
    assert_eq!(
        join["topic"],
        "realtime:trip:c00a4ae1-58f0-464b-9aa7-638ed8090bab"
    );
    assert_eq!(join["event"], "phx_join");
    assert_eq!(join["payload"]["config"]["private"], true);
    assert_eq!(
        join["payload"]["config"]["presence"],
        json!({ "enabled": true, "key": TAB })
    );
    assert_eq!(
        join["payload"]["config"]["broadcast"],
        json!({ "ack": false, "self": false })
    );
    assert_eq!(join["payload"]["access_token"], "token-1");
    assert!(join["ref"].is_string());
    assert_eq!(join["join_ref"], join["ref"]);
}

/// 需求 33.7 (c)：WebSocket 連上後（包括重新連線之後），對每個要加入的頻道各送出一次加入頻道的訊息。
#[test]
fn every_open_sends_one_join_per_channel() {
    let mut h = Harness::new("token-1");
    h.socket.join(TRIP, TAB, 0.0);
    // 正在連線時登記的頻道等開啟後再送出；已登記的頻道不重複登記
    h.socket.join(OTHER_TRIP, TAB, 1.0);
    h.socket.join(TRIP, TAB, 2.0);
    assert_eq!(h.transport().connects, 1);
    assert!(h.take_sent().is_empty());

    h.open(10.0);
    let first = joins_by_topic(&h.take_sent());
    assert_eq!(first.len(), 2);
    for (topic, join) in &first {
        assert_eq!(h.join_ok(topic, &text(&join["ref"]), 20.0).len(), 1);
    }
    // 加入成功之後不再送出加入
    assert!(h.socket.tick(1_000.0).is_empty());
    assert!(h.take_sent().is_empty());

    // 重新連線之後再各送出一次，每次都用新的 join_ref
    assert_eq!(h.drop_connection(5_000.0), [Inbound::Disconnected]);
    let (_, until_ms) = h.backoff();
    h.socket.tick(until_ms);
    assert_eq!(h.transport().connects, 2);
    assert!(h.take_sent().is_empty());
    h.open(until_ms + 5.0);
    let second = joins_by_topic(&h.take_sent());
    assert_eq!(second.len(), 2);
    for (topic, join) in &second {
        assert_ne!(join["ref"], first[topic]["ref"], "{topic}");
    }

    // 斷線期間離開的頻道不再加入
    assert_eq!(h.drop_connection(until_ms + 100.0), [Inbound::Disconnected]);
    h.socket.leave(OTHER_TRIP);
    let (_, until_ms) = h.backoff();
    h.socket.tick(until_ms);
    h.open(until_ms + 5.0);
    let third = joins_by_topic(&h.take_sent());
    assert_eq!(third.keys().map(String::as_str).collect::<Vec<_>>(), [TRIP]);
}

/// 需求 33.7 (d)：連上後未滿 20 秒不送出 heartbeat，滿 20 秒時送出，之後每 20 秒一次（從連線開啟起算，需求 11.6）。
#[test]
fn heartbeat_every_20_seconds_from_open() {
    let mut h = Harness::new("token-1");
    let opened_at = 3_000.0;
    h.join_and_open(TRIP, opened_at);
    for n in 1..=5 {
        let due = opened_at + 20_000.0 * f64::from(n);
        assert_eq!(h.socket.wake_at(), Some(due));
        assert!(h.socket.tick(due - 1.0).is_empty());
        assert!(
            h.take_sent().is_empty(),
            "第 {n} 個 heartbeat 在滿 20 秒之前送出"
        );
        assert!(h.socket.tick(due).is_empty());
        let reference = heartbeat_ref(&single(h.take_sent()));
        // 任務 1.3 量到最慢的回覆約 4.5 秒
        assert!(h.heartbeat_ok(&reference, due + 4_600.0).is_empty());
    }
    assert_eq!(h.transport().closes, 0);
    assert_eq!(h.socket.conn(), Conn::Open);
}

/// 需求 33.7 (e)：送出 heartbeat 後滿 20 秒仍沒有收到它的回覆時，關閉連線並開始退避；ref 不同的回覆不算數。
#[test]
fn heartbeat_without_reply_for_20_seconds_closes_and_backs_off() {
    let mut h = Harness::new("token-1");
    let join_ref = h.join_and_open(TRIP, 0.0);
    assert!(h.socket.tick(20_000.0).is_empty());
    let heartbeat = heartbeat_ref(&single(h.take_sent()));
    // 別的 ref 的回覆不是這個 heartbeat 的回覆
    assert_ne!(join_ref, heartbeat);
    assert!(h.heartbeat_ok(&join_ref, 21_000.0).is_empty());

    // 未滿 20 秒：連線仍開著，也不送出下一個 heartbeat
    assert!(h.socket.tick(39_999.0).is_empty());
    assert_eq!(h.socket.conn(), Conn::Open);
    assert_eq!(h.transport().closes, 0);
    assert!(h.take_sent().is_empty());

    assert_eq!(h.socket.tick(40_000.0), [Inbound::Disconnected]);
    assert_eq!(h.transport().closes, 1);
    assert!(h.take_sent().is_empty());
    assert!(!h.socket.is_joined(TRIP));
    // 抖動是 0：第 1 次重試在 1 秒後
    assert_eq!(h.backoff(), (1, 41_000.0));

    // 之後傳輸回報的 Closed 屬於同一次中斷：不再回報，也不改變退避
    assert!(h.drop_connection(40_010.0).is_empty());
    assert_eq!(h.backoff(), (1, 41_000.0));
    assert!(h.socket.tick(40_999.0).is_empty());
    assert_eq!(h.transport().connects, 1);
    assert!(h.socket.tick(41_000.0).is_empty());
    assert_eq!(h.transport().connects, 2);
    assert_eq!(h.socket.conn(), Conn::Connecting);
}

/// 需求 33.7 (f)：斷線後第 1 至第 4 次重新連線前的等待分別不少於 1、2、5、10 秒、不超過這些秒數的 1.2 倍，第 5 次起
/// 都在 10 至 12 秒之間（需求 11.7；與協定文件「Error handling › Reconnection」中 JS 用戶端的
/// `[1000, 2000, 5000, 10000]` 相同）。抖動取 0、0.5 與 1，分別落在下限、中間與上限。
///
/// 每次重新連線都失敗：單數次在開啟之前（無法建立），雙數次在開啟之後、加入成功之前（例如 LM_Server 連不到
/// Realtime_Service 而關閉，需求 11.12）。兩種都不是重新加入成功，所以次數繼續累計。
#[test]
fn reconnect_waits_follow_the_backoff_schedule() {
    const BASE_MS: [f64; 7] = [
        1_000.0, 2_000.0, 5_000.0, 10_000.0, 10_000.0, 10_000.0, 10_000.0,
    ];
    for jitter in [0.0, 0.5, 1.0] {
        let mut h = Harness::new("token-1");
        h.jitter.set(jitter);
        h.join_and_open(TRIP, 0.0);
        let mut detected_at = 5_000.0;
        assert_eq!(h.drop_connection(detected_at), [Inbound::Disconnected]);
        for (attempt, base) in (1_u32..).zip(BASE_MS) {
            let (counted, until_ms) = h.backoff();
            assert_eq!(counted, attempt);
            let wait = until_ms - detected_at;
            assert!(
                base <= wait && wait <= base * 1.2,
                "抖動 {jitter}：第 {attempt} 次等了 {wait} 毫秒"
            );
            assert!((wait - base * (1.0 + 0.2 * jitter)).abs() < 1e-6);

            // 到期之前不重新連線，到期時重新連線
            assert!(h.socket.tick(until_ms - 1.0).is_empty());
            assert_eq!(h.transport().connects, attempt);
            assert!(h.socket.tick(until_ms).is_empty());
            assert_eq!(h.transport().connects, attempt + 1);

            if attempt.is_multiple_of(2) {
                h.open(until_ms + 20.0);
                assert_eq!(joins_by_topic(&h.take_sent()).len(), 1);
            }
            detected_at = until_ms + 40.0;
            assert_eq!(h.drop_connection(detected_at), [Inbound::Disconnected]);
        }
    }
}

/// 需求 33.7 (f)：連上並重新加入成功之後再斷線，等待又從 1 秒開始（需求 11.7）。
#[test]
fn backoff_restarts_from_1_second_after_rejoining() {
    let mut h = Harness::new("token-1");
    h.jitter.set(1.0);
    h.join_and_open(TRIP, 0.0);
    // 連續 3 次中斷
    let mut detected_at = 1_000.0;
    h.drop_connection(detected_at);
    for _ in 0..2 {
        let (_, until_ms) = h.backoff();
        h.socket.tick(until_ms);
        detected_at = until_ms + 40.0;
        h.drop_connection(detected_at);
    }
    let (attempt, until_ms) = h.backoff();
    assert_eq!(attempt, 3);
    assert!((5_000.0..=6_000.0).contains(&(until_ms - detected_at)));

    // 重新連線並加入成功
    h.socket.tick(until_ms);
    h.open(until_ms + 20.0);
    let join_ref = text(&single(h.take_sent())["ref"]);
    assert_eq!(h.join_ok(TRIP, &join_ref, until_ms + 30.0).len(), 1);
    assert!(h.socket.is_joined(TRIP));

    // 再斷線：從 1 秒開始
    let detected_at = until_ms + 5_000.0;
    assert_eq!(h.drop_connection(detected_at), [Inbound::Disconnected]);
    let (attempt, until_ms) = h.backoff();
    assert_eq!(attempt, 1);
    let wait = until_ms - detected_at;
    assert!((1_000.0..=1_200.0).contains(&wait), "等了 {wait} 毫秒");
}

/// 需求 33.7 (f)：抖動來源回傳 0 到 1 以外的值（或 NaN）時，等待仍不少於 1 秒、不超過 1.2 秒。
#[test]
fn jitter_outside_0_to_1_keeps_waits_within_bounds() {
    for jitter in [-0.5, 1.5, 7.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let mut h = Harness::new("token-1");
        h.jitter.set(jitter);
        h.join_and_open(TRIP, 0.0);
        h.drop_connection(1_000.0);
        let (_, until_ms) = h.backoff();
        let wait = until_ms - 1_000.0;
        assert!(
            (1_000.0..=1_200.0).contains(&wait),
            "抖動 {jitter}：等了 {wait} 毫秒"
        );
    }
}

/// 需求 33.7 (g)：換發 Session 時，對每個已加入的頻道各送出一則帶有新 access token 的訊息，之後加入頻道的訊息也帶新的
/// access token（需求 4.5）。
#[test]
fn session_refresh_sends_the_new_token_to_joined_channels_and_later_joins() {
    let mut h = Harness::new("token-1");
    for topic in [TRIP, OTHER_TRIP, THIRD_TRIP] {
        h.socket.join(topic, TAB, 0.0);
    }
    h.open(10.0);
    let joins = joins_by_topic(&h.take_sent());
    assert_eq!(joins.len(), 3);
    for join in joins.values() {
        assert_eq!(join["payload"]["access_token"], "token-1");
    }
    // TRIP 與 OTHER_TRIP 加入成功；THIRD_TRIP 還在等回覆
    for topic in [TRIP, OTHER_TRIP] {
        assert_eq!(h.join_ok(topic, &text(&joins[topic]["ref"]), 20.0).len(), 1);
    }

    h.socket.set_access_token("token-2");
    let pushes = h.take_sent();
    for push in &pushes {
        assert_eq!(push["event"], "access_token");
        assert_eq!(push["payload"], json!({ "access_token": "token-2" }));
        assert_eq!(push["join_ref"], joins[&channel(push)]["ref"]);
        assert!(push["ref"].is_string());
        assert_ne!(push["ref"], push["join_ref"]);
    }
    let topics: BTreeSet<String> = pushes.iter().map(channel).collect();
    assert_eq!(pushes.len(), 2);
    assert_eq!(topics, BTreeSet::from([TRIP.into(), OTHER_TRIP.into()]));

    // THIRD_TRIP 的 phx_join 帶的是舊的 token：加入成功時補送一則
    assert_eq!(
        h.join_ok(THIRD_TRIP, &text(&joins[THIRD_TRIP]["ref"]), 30.0)
            .len(),
        1
    );
    let push = single(h.take_sent());
    assert_eq!(channel(&push), THIRD_TRIP);
    assert_eq!(push["event"], "access_token");
    assert_eq!(push["payload"], json!({ "access_token": "token-2" }));

    // 同一個 token 不重送
    h.socket.set_access_token("token-2");
    assert!(h.take_sent().is_empty());

    // 之後的加入帶新的 token：立即重新加入
    h.socket.rejoin_now(TRIP, 100.0);
    let rejoin = single(h.take_sent());
    assert_eq!(rejoin["event"], "phx_join");
    assert_eq!(rejoin["payload"]["access_token"], "token-2");

    // 斷線期間換發：沒有連線，不送出；重新連線之後每個頻道的加入都帶最新的 token
    assert_eq!(h.drop_connection(200.0), [Inbound::Disconnected]);
    h.socket.set_access_token("token-3");
    assert!(h.take_sent().is_empty());
    let (_, until_ms) = h.backoff();
    h.socket.tick(until_ms);
    h.open(until_ms + 5.0);
    let rejoins = joins_by_topic(&h.take_sent());
    assert_eq!(rejoins.len(), 3);
    for join in rejoins.values() {
        assert_eq!(join["payload"]["access_token"], "token-3");
    }
}

// ── 需求 11.7 的其他情況 ──

/// 需求 11.7：送出加入要求後 10 秒內沒有回覆時回報一次 `JoinTimeout`，之後才到的回覆不往上傳。
#[test]
fn join_without_reply_for_10_seconds_times_out_once() {
    let mut h = Harness::new("token-1");
    h.socket.join(TRIP, TAB, 0.0);
    h.open(1_000.0);
    let join_ref = text(&single(h.take_sent())["ref"]);
    assert_eq!(h.socket.wake_at(), Some(11_000.0));
    assert!(h.socket.tick(10_999.0).is_empty());
    assert_eq!(
        h.socket.tick(11_000.0),
        [Inbound::JoinTimeout { topic: TRIP.into() }]
    );
    assert!(h.socket.tick(11_001.0).is_empty());
    assert!(h.join_ok(TRIP, &join_ref, 12_000.0).is_empty());
    assert!(!h.socket.is_joined(TRIP));
}

/// 需求 11.7：頻道回報錯誤（`phx_error`）之後，呼叫端以 `rejoin_after_backoff()` 依同一組間隔只重送那個頻道的
/// `phx_join`；等待期間 WebSocket 也中斷時，與等待中的重試算同一次。
#[test]
fn channel_errors_rejoin_after_the_same_backoff() {
    let mut h = Harness::new("token-1");
    let join_ref = h.join_and_open(TRIP, 0.0);
    let error = json!({
        "ref": join_ref,
        "event": "phx_error",
        "payload": {},
        "topic": format!("realtime:{TRIP}")
    });
    assert_eq!(
        h.receive(error, 5_000.0),
        [Inbound::ChannelError {
            topic: TRIP.into(),
            reference: Some(join_ref),
        }]
    );

    // 第 1 次：1 秒後重送 phx_join，WebSocket 不重建
    h.socket.rejoin_after_backoff(TRIP, 5_000.0);
    assert!(h.socket.tick(5_999.0).is_empty());
    assert!(h.take_sent().is_empty());
    assert!(h.socket.tick(6_000.0).is_empty());
    let rejoin = single(h.take_sent());
    assert_eq!(rejoin["event"], "phx_join");
    assert_eq!(h.transport().connects, 1);

    // 這次加入被拒（服務暫時無法使用）：第 2 次等 2 秒
    let rejected = json!({
        "ref": rejoin["ref"],
        "event": "phx_reply",
        "payload": {
            "status": "error",
            "response": { "reason": "RealtimeRestarting: Realtime is restarting" }
        },
        "topic": format!("realtime:{TRIP}")
    });
    assert_eq!(h.receive(rejected, 6_100.0).len(), 1);
    h.socket.rejoin_after_backoff(TRIP, 6_100.0);
    // 等待期間 WebSocket 也中斷：算同一次，沿用等待中的時間
    assert_eq!(h.drop_connection(7_000.0), [Inbound::Disconnected]);
    assert_eq!(h.backoff(), (2, 8_100.0));
}
