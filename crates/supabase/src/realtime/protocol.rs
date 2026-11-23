//! Realtime 協定 1.0.0 的訊框（design 2.1）：`Frame`、送出的訊框（`join_frame()`、`leave_frame()`、
//! `heartbeat_frame()`、`access_token_frame()` 與 `track_frame()`）、收到的 `Inbound`，以及 `encode()` 與 `decode()`。
//!
//! 每個訊框是一個 JSON 物件的文字訊框，鍵為 `topic`、`event`、`payload`、`ref` 與 `join_ref`（Supabase 的
//! [Realtime Protocol](https://supabase.com/docs/guides/realtime/protocol)）。送出的訊框都帶這五個鍵。收到的訊框只有
//! `ref`、`event`、`payload` 與 `topic` 四個鍵，沒有 `join_ref`（任務 1.3 在 CLI 3.2.0、Realtime v2.167.0 實測）：
//! `phx_reply` 的 `ref` 是被回覆的那個訊框的 `ref`；`phx_close` 與 `phx_error` 的 `ref` 是它們所屬那次加入的
//! join_ref；伺服器主動送出的 broadcast、`presence_state`、`presence_diff` 與 `system` 的 `ref` 是 null。
//!
//! 頻道名稱（例如 `trip:<旅行 id>`）在線上加上 `realtime:` 前綴：送出的訊框由這裡加上，`decode()` 去掉，所以呼叫端
//! 與 `Inbound` 只看到頻道名稱。heartbeat 不屬於任何頻道，topic 是 `phoenix`（`HEARTBEAT_TOPIC`）。
//!
//! # 以 `ref` 分辨回覆
//!
//! 加入、presence track 與離開的成功回覆都是 `status` 為 `ok` 的 `phx_reply`，而收到的訊框沒有 `join_ref`，只有
//! `ref` 能分辨它回覆的是哪一個訊框。`decode()` 不記得送出過什麼，所以把頻道上 `status` 為 `ok` 或 `error` 的每一個
//! `phx_reply` 都解成 `Inbound::JoinOk` 或 `Inbound::JoinError`，並在 `reference` 保留回覆的 `ref`；`phx_close`、
//! `phx_error` 與 heartbeat 的回覆也保留 `ref`。
//!
//! `PhoenixSocket`（`realtime::socket`）記得每個頻道這次加入的 join_ref 與等待中的 heartbeat 的 `ref`，以它們判斷：
//! `reference` 等於 join_ref 的回覆才是加入的結果，其他回覆（track、離開）不往上傳；`reference` 不等於目前 join_ref
//! 的 `phx_close` 與 `phx_error` 屬於先前那次加入（例如重新加入同一個頻道時，伺服器為舊的那次送出的
//! `phx_close`），也不往上傳。
//!
//! 這裡只做訊框與 JSON 文字的轉換，不使用網路與瀏覽器，原生目標與 wasm32 都可以編譯與測試（需求 1.6、1.10）。

use std::fmt;

use lm_core::presence::PresenceMeta;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// 頻道的 topic 在線上的前綴。
const CHANNEL_PREFIX: &str = "realtime:";

/// heartbeat 與它的回覆使用的 topic；不屬於任何頻道。
pub const HEARTBEAT_TOPIC: &str = "phoenix";

/// 一個訊框（協定 1.0.0 的一個 JSON 物件）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Frame {
    /// `realtime:` 加上頻道名稱，例如 `realtime:trip:<uuid>`；heartbeat 使用 `phoenix`。
    pub topic: String,
    /// `phx_join`、`phx_leave`、`heartbeat`、`access_token`、`presence`、`broadcast`、`phx_reply` …
    pub event: String,
    /// 事件的內容，沒有內容時是 `{}`。
    pub payload: Value,
    /// 這個訊框的參照，回覆以它對應到請求；伺服器主動送出的訊框是 null。
    #[serde(rename = "ref", default)]
    pub reference: Option<String>,
    /// 這次加入頻道的參照，等於那個 `phx_join` 的 `ref`；heartbeat 是 null。收到的訊框沒有這個鍵，解析時當成 null。
    #[serde(default)]
    pub join_ref: Option<String>,
}

/// 加入頻道的 `phx_join`（需求 11.3）：私有頻道（`private: true`，由 `realtime.messages` 的 RLS 政策授權，
/// 需求 11.4），帶這個分頁的 presence key 與目前的 access token；`ref` 與 `join_ref` 都是 `join_ref`。
///
/// 其餘設定：`broadcast.self = false` 不收自己送出的 broadcast、`broadcast.ack = false` 不要求確認；
/// `presence.enabled = true` 啟用 presence（Local_Stack 的 tenant 的 `presence_enabled` 是 false，加入時要明確啟用，
/// 任務 1.3）；`postgres_changes` 是空的，不訂閱 Postgres Changes。
///
/// `topic` 是頻道名稱，例如 `trip:<旅行 id>`，不含 `realtime:` 前綴。
pub fn join_frame(topic: &str, join_ref: &str, access_token: &str, presence_key: &str) -> Frame {
    Frame {
        topic: channel_topic(topic),
        event: "phx_join".into(),
        payload: json!({
            "config": {
                "broadcast": { "ack": false, "self": false },
                "presence": { "enabled": true, "key": presence_key },
                "postgres_changes": [],
                "private": true
            },
            "access_token": access_token
        }),
        reference: Some(join_ref.into()),
        join_ref: Some(join_ref.into()),
    }
}

/// 離開頻道的 `phx_leave`，payload 是 `{}`。伺服器先以 `reference` 回覆 ok，再送出 `ref` 為 `join_ref` 的
/// `phx_close`；其他成員收到含這個分頁 presence key 的 `leaves`。
pub fn leave_frame(topic: &str, join_ref: &str, reference: &str) -> Frame {
    channel_push(topic, "phx_leave", json!({}), join_ref, reference)
}

/// heartbeat：topic `phoenix`、payload `{}`、`join_ref` 為 null。伺服器以同一個 `ref` 的 `phx_reply` 回覆。
pub fn heartbeat_frame(reference: &str) -> Frame {
    Frame {
        topic: HEARTBEAT_TOPIC.into(),
        event: "heartbeat".into(),
        payload: json!({}),
        reference: Some(reference.into()),
        join_ref: None,
    }
}

/// 把換發後的 access token 送給已加入的頻道（event `access_token`，payload `{"access_token": <token>}`，需求 4.5）。
/// 成功時伺服器不回覆；token 無效或已過期時伺服器送出 `system` 錯誤並關閉頻道。
pub fn access_token_frame(
    topic: &str,
    join_ref: &str,
    reference: &str,
    access_token: &str,
) -> Frame {
    channel_push(
        topic,
        "access_token",
        json!({ "access_token": access_token }),
        join_ref,
        reference,
    )
}

/// 回報這個分頁的 Presence_Meta（event `presence`，payload `{"type": "presence", "event": "track", "payload": <meta>}`）。
/// 伺服器以 `reference` 回覆，頻道中的每個成員（包括自己）收到含這筆 meta 的 `presence_diff`。
pub fn track_frame(topic: &str, join_ref: &str, reference: &str, meta: &PresenceMeta) -> Frame {
    channel_push(
        topic,
        "presence",
        json!({ "type": "presence", "event": "track", "payload": meta }),
        join_ref,
        reference,
    )
}

/// 把訊框轉成要送出的 JSON 文字。
pub fn encode(frame: &Frame) -> String {
    serde_json::to_string(frame).expect("Frame 只含字串與 JSON 值，序列化不會失敗")
}

/// 收到的一則訊息。`topic` 是去掉 `realtime:` 前綴的頻道名稱，與加入時傳給 `join_frame()` 的相同。
///
/// 回覆、`phx_close`、`phx_error` 與 heartbeat 的回覆帶 `reference`（訊框的 `ref`），由 `PhoenixSocket` 判斷它們屬於
/// 哪一個請求或哪一次加入（見模組說明）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Inbound {
    /// 頻道上 `status` 為 `ok` 的 `phx_reply`。加入成功時 `reference` 等於這次加入的 join_ref；presence track 與離開
    /// 的成功回覆也解成這一種，只有 `reference` 不同。
    JoinOk {
        topic: String,
        reference: Option<String>,
    },
    /// 頻道上 `status` 為 `error` 的 `phx_reply`，`reason` 是 `response.reason`。加入被拒時的格式是
    /// `<錯誤代碼>: <說明>`，例如 `Unauthorized: You do not have permissions to read from this Channel topic:
    /// trip:<id>`（說明中的頻道名稱沒有 `realtime:` 前綴）或 `InvalidJWTExpiration: Token has expired 300 seconds ago`。
    /// 其他請求的錯誤回覆可能沒有 `reason`（例如被拒絕的 presence track），這時是空字串；`reference` 的用法同 `JoinOk`。
    JoinError {
        topic: String,
        reference: Option<String>,
        reason: String,
    },
    /// broadcast：`event` 與 `payload` 取自訊框 payload 的 `event` 與 `payload`，不保留 `type` 與 `meta`。
    ///
    /// Database 推送的 Change_Set 與 Thin_Notice：`event` 是 `changeset`，`meta` 是 `realtime.messages` 那一列的
    /// `{"id": …}`；`payload` 是推送的內容，多了一個 `realtime.send()` 加入的 `id`（與 `meta.id` 相同）。`payload`
    /// 原樣交給呼叫端，由 lm-web 解析成 lm-core 的 `Broadcast`；無法解析時依需求 12.4 補齊，所以這裡不檢查內容：
    /// 沒有字串的 `event` 時是空字串，沒有 `payload` 時是 null。
    Broadcast {
        topic: String,
        event: String,
        payload: Value,
    },
    /// `presence_state`：整個 payload，形狀是 `{<presence key>: {"metas": [{"phx_ref": …, <Presence_Meta 的欄位>…}]}}`；
    /// 沒有人 track 時是 `{}`。加入成功之後緊接著送達。
    PresenceState { topic: String, state: Value },
    /// `presence_diff`：payload 的 `joins` 與 `leaves`，形狀與 `PresenceState` 的 `state` 相同；缺少時是 `{}`。
    /// 送出 track 的分頁也會收到自己的 `joins`。
    PresenceDiff {
        topic: String,
        joins: Value,
        leaves: Value,
    },
    /// `phx_close`：伺服器關閉了這個頻道，例如離開之後，或 channel 層級的 `system` 錯誤之後。`reference` 是被關閉
    /// 的那次加入的 join_ref。
    ChannelClosed {
        topic: String,
        reference: Option<String>,
    },
    /// `phx_error`：伺服器上這個頻道的程序意外結束，payload 是 `{}`。`reference` 是那次加入的 join_ref。
    ChannelError {
        topic: String,
        reference: Option<String>,
    },
    /// `system`：payload 的 `status`（`ok`、`error` 或 `timeout`）與 `message`，沒有字串時是空字串；不保留
    /// `extension` 與 `channel`。channel 層級的錯誤（例如 message 含 `Token has expired` 或
    /// `Client presence rate limit exceeded`）之後一定接著 `phx_close`。
    System {
        topic: String,
        status: String,
        message: String,
    },
    /// topic `phoenix` 上 `status` 為 `ok` 的 `phx_reply`：heartbeat 的回覆，`reference` 是那次 heartbeat 的 `ref`。
    HeartbeatOk { reference: Option<String> },
    /// 不認得的事件（例如 `postgres_changes`）、頻道上 `status` 不是 `ok` 或 `error` 的回覆、topic `phoenix` 上
    /// `status` 不是 `ok` 的回覆，以及其他不屬於 `realtime:` 頻道的訊框。
    Other,
    /// 不是收到的訊框，而是 `PhoenixSocket` 產生的事件：送出 `phx_join` 後 10 秒內沒有回覆（需求 11.7）。
    JoinTimeout { topic: String },
    /// 不是收到的訊框，而是 `PhoenixSocket` 產生的事件：WebSocket 關閉、無法建立，或 heartbeat 在下一次該送之前
    /// 沒有回覆而主動關閉。
    Disconnected,
}

/// `decode()` 無法解析的文字。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProtocolError {
    /// 不是 JSON；內容是解析器的說明。
    InvalidJson(String),
    /// 是 JSON，但不是協定 1.0.0 的訊框：不是物件、`topic` 或 `event` 缺少或不是字串、缺少 `payload`，或 `ref`、
    /// `join_ref` 不是字串也不是 null。內容是說明。
    NotAFrame(String),
    /// `phx_reply` 的 payload 沒有字串的 `status`。
    MalformedReply,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProtocolError::InvalidJson(detail) => write!(f, "Realtime 訊框不是 JSON：{detail}"),
            ProtocolError::NotAFrame(detail) => write!(f, "Realtime 訊框的格式不對：{detail}"),
            ProtocolError::MalformedReply => f.write_str("phx_reply 的 payload 沒有字串的 status"),
        }
    }
}

impl std::error::Error for ProtocolError {}

/// 把收到的文字訊框解成 `Inbound`。
///
/// 文字不是 JSON、不是訊框，或 `phx_reply` 沒有 `status` 時回傳錯誤；其餘依 `event`（與 topic）分類，不認得的是
/// `Inbound::Other`。各種類取用 payload 的哪些欄位見 `Inbound`。
pub fn decode(text: &str) -> Result<Inbound, ProtocolError> {
    let value: Value = serde_json::from_str(text)
        .map_err(|error| ProtocolError::InvalidJson(error.to_string()))?;
    // 結構體也可以從 JSON 陣列解析（依欄位順序），而協定 1.0.0 的訊框一定是物件（陣列是 2.0.0 的格式）
    if !value.is_object() {
        return Err(ProtocolError::NotAFrame("不是 JSON 物件".into()));
    }
    let frame =
        Frame::deserialize(value).map_err(|error| ProtocolError::NotAFrame(error.to_string()))?;
    classify(frame)
}

/// 依 topic 與 event 分類一個已解析的訊框。
fn classify(frame: Frame) -> Result<Inbound, ProtocolError> {
    let Frame {
        topic,
        event,
        mut payload,
        reference,
        join_ref: _,
    } = frame;
    let Some(channel) = topic.strip_prefix(CHANNEL_PREFIX) else {
        // 不屬於任何頻道：只認得 heartbeat 的回覆
        if topic == HEARTBEAT_TOPIC && event == "phx_reply" {
            return Ok(match reply_status(&payload)? {
                ReplyStatus::Ok => Inbound::HeartbeatOk { reference },
                ReplyStatus::Error | ReplyStatus::Unknown => Inbound::Other,
            });
        }
        return Ok(Inbound::Other);
    };
    let topic = channel.to_owned();
    let inbound = match event.as_str() {
        "phx_reply" => match reply_status(&payload)? {
            ReplyStatus::Ok => Inbound::JoinOk { topic, reference },
            ReplyStatus::Error => Inbound::JoinError {
                topic,
                reference,
                reason: string_at(&payload, "/response/reason"),
            },
            ReplyStatus::Unknown => Inbound::Other,
        },
        "broadcast" => Inbound::Broadcast {
            topic,
            event: string_at(&payload, "/event"),
            payload: take(&mut payload, "payload").unwrap_or(Value::Null),
        },
        "presence_state" => Inbound::PresenceState {
            topic,
            state: payload,
        },
        "presence_diff" => Inbound::PresenceDiff {
            topic,
            joins: take(&mut payload, "joins").unwrap_or_else(empty_object),
            leaves: take(&mut payload, "leaves").unwrap_or_else(empty_object),
        },
        "phx_close" => Inbound::ChannelClosed { topic, reference },
        "phx_error" => Inbound::ChannelError { topic, reference },
        "system" => Inbound::System {
            topic,
            status: string_at(&payload, "/status"),
            message: string_at(&payload, "/message"),
        },
        _ => Inbound::Other,
    };
    Ok(inbound)
}

/// `phx_reply` 的 `status`。
enum ReplyStatus {
    Ok,
    Error,
    /// 伺服器只會回 `ok` 或 `error`；其他值與 Phoenix 的 JavaScript 用戶端一樣不處理。
    Unknown,
}

fn reply_status(payload: &Value) -> Result<ReplyStatus, ProtocolError> {
    match payload.get("status").and_then(Value::as_str) {
        Some("ok") => Ok(ReplyStatus::Ok),
        Some("error") => Ok(ReplyStatus::Error),
        Some(_) => Ok(ReplyStatus::Unknown),
        None => Err(ProtocolError::MalformedReply),
    }
}

/// `pointer`（RFC 6901）指到的字串；沒有或不是字串時是空字串。
fn string_at(value: &Value, pointer: &str) -> String {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// 從物件中取出一個欄位，不複製內容（推送的 Change_Set 可能有數十 KB）。
fn take(value: &mut Value, key: &str) -> Option<Value> {
    value.as_object_mut()?.remove(key)
}

fn empty_object() -> Value {
    Value::Object(Map::new())
}

/// 頻道名稱在線上的 topic。
fn channel_topic(topic: &str) -> String {
    format!("{CHANNEL_PREFIX}{topic}")
}

/// 已加入的頻道上的一個請求：帶這次加入的 `join_ref` 與這個請求的 `reference`。
fn channel_push(
    topic: &str,
    event: &str,
    payload: Value,
    join_ref: &str,
    reference: &str,
) -> Frame {
    Frame {
        topic: channel_topic(topic),
        event: event.into(),
        payload,
        reference: Some(reference.into()),
        join_ref: Some(join_ref.into()),
    }
}
