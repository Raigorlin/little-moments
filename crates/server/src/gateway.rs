//! Realtime 轉送（design 3.4，任務 16.2）：瀏覽器連到同源的 `/realtime/v1/websocket?vsn=1.0.0`（需求 11.1），
//! lm-server 連到 Realtime_Service 的 WebSocket，之後雙向逐一轉送訊框（需求 11.2）。
//!
//! - 上游網址：`SUPABASE_URL`（`http://` 換成 `ws://`、`https://` 換成 `wss://`，去掉查詢與片段，可以有路徑前綴）
//!   之下的 `realtime/v1/websocket`。查詢參數只保留瀏覽器送來的第一個 `vsn`，再加上值為 `SUPABASE_ANON_KEY` 的
//!   `apikey`；瀏覽器送來的 `apikey` 與其他參數都不轉送（`Config::realtime_upstream_url`）。
//! - 轉送前不檢查登入，也不解析或修改內容：頻道的授權由 Realtime_Service 以使用者的 access token 與 RLS 決定
//!   （需求 11.4）。文字、二進位、ping、pong 與關閉訊框都原樣轉給另一端；任一端關閉或斷線時也關閉另一端。
//!   兩端的 WebSocket 函式庫（tungstenite）收到 ping 時也各自自動回覆 pong，所以送出 ping 的一端可能收到兩個
//!   pong（WebSocket 允許未經要求的 pong）。
//! - 無法在 `CONNECT_TIMEOUT` 內連上 Realtime_Service（沒有啟動、拒絕連線或握手失敗）時，以關閉代碼 1011 關閉
//!   瀏覽器的 WebSocket，LM_Web 依需求 11.7 重新連線（需求 11.12）。
//!
//! 上游網址含有 anon key，所以網址與 tungstenite 的錯誤訊息（`UnableToConnect` 含有網址）都不直接寫進記錄：
//! 記錄的錯誤先以 `redact` 去掉 anon key（需求 2.9）。送給瀏覽器的訊框只有 Realtime_Service 送出的內容與
//! lm-server 的關閉訊框，不含金鑰。
use std::time::Duration;

use axum::extract::ws::{self, WebSocket, WebSocketUpgrade};
use axum::extract::{RawQuery, State};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::{self as ts, protocol::frame::coding::CloseCode};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::config::percent_encode;
use crate::state::AppState;

/// 連上 Realtime_Service（TCP、TLS 與 WebSocket 握手）的時限；與 LM_Web 等待加入回覆的 10 秒相同（需求 11.7）。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 一端關閉之後，完成另一端關閉訊框的送出的時限，避免不讀取的對端使轉送一直不結束。
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// 無法連上 Realtime_Service 時關閉瀏覽器 WebSocket 的代碼（1011：伺服器遇到無法完成請求的狀況）。
const UPSTREAM_UNAVAILABLE: u16 = 1011;

type Upstream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// `GET /realtime/v1/websocket`（需求 11.2、11.12）。
pub async fn realtime_proxy(
    ws: WebSocketUpgrade,
    State(st): State<AppState>,
    RawQuery(query): RawQuery,
) -> Response {
    let upstream_url = st.config.realtime_upstream_url(query.as_deref());
    ws.on_upgrade(move |mut client| async move {
        let connected = tokio::time::timeout(
            CONNECT_TIMEOUT,
            tokio_tungstenite::connect_async(&upstream_url),
        )
        .await;
        match connected {
            Ok(Ok((upstream, _))) => {
                tracing::debug!("realtime upstream connected");
                pump(client, upstream).await;
                tracing::debug!("realtime proxy closed");
            }
            failed => {
                let reason = match failed {
                    Ok(Err(error)) => redact(&error.to_string(), &st),
                    _ => format!("no response within {} s", CONNECT_TIMEOUT.as_secs()),
                };
                tracing::warn!(%reason, "realtime upstream connect failed");
                let close = ws::CloseFrame {
                    code: UPSTREAM_UNAVAILABLE,
                    reason: ws::Utf8Bytes::from_static(""),
                };
                let _ = tokio::time::timeout(CLOSE_TIMEOUT, async {
                    let _ = client.send(ws::Message::Close(Some(close))).await;
                    let _ = client.close().await;
                })
                .await;
            }
        }
    })
}

/// 雙向逐一轉送訊框，直到任一端送出關閉訊框、斷線或發生錯誤；之後關閉兩端。
async fn pump(mut client: WebSocket, mut upstream: Upstream) {
    loop {
        tokio::select! {
            message = client.next() => {
                let Some(Ok(message)) = message else { break };
                let closing = matches!(message, ws::Message::Close(_));
                if upstream.send(to_upstream(message)).await.is_err() || closing {
                    break;
                }
            }
            message = upstream.next() => {
                let Some(Ok(message)) = message else { break };
                let closing = matches!(message, ts::Message::Close(_));
                let Some(message) = to_client(message) else { continue };
                if client.send(message).await.is_err() || closing {
                    break;
                }
            }
        }
    }
    // 已送出或收到關閉訊框的一端，close() 只完成關閉的交握；另一端則送出沒有代碼的關閉訊框
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, async {
        let _ = tokio::join!(client.close(), upstream.close(None));
    })
    .await;
}

/// 瀏覽器送來的訊框，原樣轉成送往上游的訊框。
fn to_upstream(message: ws::Message) -> ts::Message {
    match message {
        ws::Message::Text(text) => ts::Message::Text(ts::Utf8Bytes::from(text.as_str())),
        ws::Message::Binary(data) => ts::Message::Binary(data),
        ws::Message::Ping(data) => ts::Message::Ping(data),
        ws::Message::Pong(data) => ts::Message::Pong(data),
        ws::Message::Close(frame) => {
            ts::Message::Close(frame.map(|frame| ts::protocol::CloseFrame {
                code: CloseCode::from(frame.code),
                reason: ts::Utf8Bytes::from(frame.reason.as_str()),
            }))
        }
    }
}

/// 上游送來的訊框，原樣轉成送給瀏覽器的訊框；讀取時不會出現的原始訊框（`Frame`）是 `None`。
fn to_client(message: ts::Message) -> Option<ws::Message> {
    Some(match message {
        ts::Message::Text(text) => ws::Message::Text(ws::Utf8Bytes::from(text.as_str())),
        ts::Message::Binary(data) => ws::Message::Binary(data),
        ts::Message::Ping(data) => ws::Message::Ping(data),
        ts::Message::Pong(data) => ws::Message::Pong(data),
        ts::Message::Close(frame) => ws::Message::Close(frame.map(|frame| ws::CloseFrame {
            code: u16::from(frame.code),
            reason: ws::Utf8Bytes::from(frame.reason.as_str()),
        })),
        ts::Message::Frame(_) => return None,
    })
}

/// 去掉錯誤訊息中的 anon key（原樣與百分比編碼後的寫法），使記錄不含它（需求 2.9）。
fn redact(text: &str, st: &AppState) -> String {
    let key = st.config.supabase_anon_key.expose();
    if key.is_empty() {
        return text.to_owned();
    }
    text.replace(&percent_encode(key), "<redacted>")
        .replace(key, "<redacted>")
}
