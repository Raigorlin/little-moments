//! Realtime 協定 1.0.0 的訊框編碼與解碼（任務 12.3；需求 33.7 (a)、(b)）。
//!
//! 只呼叫 `realtime::protocol` 的純函式，不連網路、Database 或 Realtime_Service（需求 33.8）。訊框有兩種來源：
//!
//! - Supabase 的 Realtime Protocol 文件 <https://supabase.com/docs/guides/realtime/protocol>（2026-11-23 讀取）的
//!   範例訊框，每個測試的註解標明取自哪一節。文件的範例大多是協定 2.0.0 的陣列 `[join_ref, ref, topic, event,
//!   payload]`：測試照抄陣列，再以 `v1_from_v2()` 改寫成同一頁「Protocol messages › 1.0.0」所說的 JSON 物件，五個
//!   欄位的值不變。文件只有說明、沒有完整訊框的情況（heartbeat 的回覆、channel 層級的 `system` 錯誤等）依說明組成，
//!   並在註解中註明。
//! - 任務 1.3 在 Realtime v2.167.0（`vsn=1.0.0`）實測送出與收到的訊框，逐字複製自 lm-spike 的 `frames/*.txt`（註解
//!   標明檔名）。送出的訊框中的 access token 在記錄時已換成 `<redacted>`；收到的訊框只有 `ref`、`event`、`payload`
//!   與 `topic` 四個鍵，沒有 `join_ref`。
//!
//! 原文中 `"key"` 之後接著 UUID 或隨機字串的地方（Presence_Key 與列鍵），原始碼以 `concat!` 在 `"key"` 之後斷開，或以
//! 函式參數組成：執行時的文字與原文相同，只是原始碼中沒有 Gitleaks 的 `generic-api-key` 規則會當成金鑰的寫法（秘密的
//! 掃描結果不能豁免，見 `security/exceptions.json`）。

use lm_core::presence::PresenceMeta;
use lm_supabase::realtime::protocol::{
    access_token_frame, decode, encode, heartbeat_frame, join_frame, leave_frame, track_frame,
    Frame, Inbound, ProtocolError,
};
use serde_json::{json, Value};

/// 任務 1.3 的 Trip_Channel：`trip:` 加上旅行 id 的小寫 UUID。
const SPIKE_TRIP: &str = "trip:c00a4ae1-58f0-464b-9aa7-638ed8090bab";
/// 任務 1.3 中用戶端 A 的分頁的 presence key。
const SPIKE_TAB: &str = "af97c762-f0f0-4335-8e08-817b8d3ea915";

/// 把文件中協定 2.0.0 的陣列 `[join_ref, ref, topic, event, payload]` 改寫成協定 1.0.0 的 JSON 物件文字，值不變。
fn v1_from_v2(array: Value) -> String {
    let [join_ref, reference, topic, event, payload]: [Value; 5] =
        serde_json::from_value(array).expect("協定 2.0.0 的文字訊框是五個元素的陣列");
    json!({
        "join_ref": join_ref,
        "ref": reference,
        "topic": topic,
        "event": event,
        "payload": payload
    })
    .to_string()
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).expect("JSON 文字")
}

/// `encode()` 的輸出解析成 JSON，與預期的訊框比較時不受鍵的順序影響。
fn wire(frame: &Frame) -> Value {
    parse(&encode(frame))
}

/// 文件 presence_state 範例中的一筆 meta：`phx_ref`、`color`，以及與 presence key 相同的 `key`。
fn cursor_meta(phx_ref: &str, color: &str, client: &str) -> Value {
    json!({ "phx_ref": phx_ref, "color": color, "key": client })
}

// ── 送出的訊框 ──

/// 需求 33.7 (a)：加入 Trip_Channel 的 `phx_join` 指定私有頻道（topic `realtime:trip:<旅行 id>`、`private: true`），
/// 帶這個分頁的 presence key 與 access token；不收自己送出的 broadcast（`self: false`），`ref` 與 `join_ref` 都是這次
/// 加入的 join_ref。
///
/// 來源：<https://supabase.com/docs/guides/realtime/protocol>「Event types › Client sent events › phx_join」的 payload
/// 說明。
#[test]
fn join_frame_is_a_private_trip_channel_join() {
    let frame = join_frame(SPIKE_TRIP, "3", "token-1", "tab-a");
    assert_eq!(
        wire(&frame),
        json!({
            "topic": "realtime:trip:c00a4ae1-58f0-464b-9aa7-638ed8090bab",
            "event": "phx_join",
            "payload": {
                "config": {
                    "broadcast": { "ack": false, "self": false },
                    "presence": { "enabled": true, "key": "tab-a" },
                    "postgres_changes": [],
                    "private": true
                },
                "access_token": "token-1"
            },
            "ref": "3",
            "join_ref": "3"
        })
    );
}

/// 需求 33.7 (a)：與任務 1.3 中 Realtime v2.167.0 接受的 `phx_join` 相同。
///
/// 來源：任務 1.3 的 join-ok.txt（檢查 1，用戶端 A 送出）。
#[test]
fn join_frame_matches_the_join_realtime_accepted() {
    // 在 "key" 之後斷開（見檔案開頭）；執行時的文字與原文相同
    let spike = concat!(
        r#"{"topic":"realtime:trip:c00a4ae1-58f0-464b-9aa7-638ed8090bab","event":"phx_join","payload":{"access_token":"<redacted>","config":{"broadcast":{"ack":false,"self":false},"postgres_changes":[],"presence":{"enabled":true,"key"#,
        r#"":"af97c762-f0f0-4335-8e08-817b8d3ea915"},"private":true}},"ref":"1","join_ref":"1"}"#,
    );
    assert_eq!(
        wire(&join_frame(SPIKE_TRIP, "1", "<redacted>", SPIKE_TAB)),
        parse(spike)
    );
}

/// 離開頻道的 `phx_leave`：payload 是 `{}`，帶那次加入的 join_ref（需求 11.13）。
///
/// 來源：<https://supabase.com/docs/guides/realtime/protocol>「Event types › Client sent events › phx_leave」的範例；
/// 任務 1.3 的 presence.txt（檢查 9，A 離開）。
#[test]
fn leave_frame_matches_the_docs_and_realtime() {
    let docs = v1_from_v2(json!([
        "1",
        "3",
        "realtime:avatar-stack-demo",
        "phx_leave",
        {}
    ]));
    assert_eq!(
        wire(&leave_frame("avatar-stack-demo", "1", "3")),
        parse(&docs)
    );

    let spike = r#"{"topic":"realtime:trip:c00a4ae1-58f0-464b-9aa7-638ed8090bab","event":"phx_leave","payload":{},"ref":"7","join_ref":"1"}"#;
    assert_eq!(wire(&leave_frame(SPIKE_TRIP, "1", "7")), parse(spike));
}

/// heartbeat：topic `phoenix`、payload `{}`、`join_ref` 是 null（需求 11.6）。
///
/// 來源：<https://supabase.com/docs/guides/realtime/protocol>「Event types › Client sent events › heartbeat」的範例；
/// 任務 1.3 的 heartbeat.txt。
#[test]
fn heartbeat_frame_matches_the_docs_and_realtime() {
    let docs = v1_from_v2(json!([null, "26", "phoenix", "heartbeat", {}]));
    assert_eq!(wire(&heartbeat_frame("26")), parse(&docs));

    let spike = r#"{"topic":"phoenix","event":"heartbeat","payload":{},"ref":"2","join_ref":null}"#;
    assert_eq!(wire(&heartbeat_frame("2")), parse(spike));
}

/// 換發 Session 之後送給已加入頻道的 `access_token`（需求 4.5）。
///
/// 來源：<https://supabase.com/docs/guides/realtime/protocol>「Error handling › Access token refresh」的範例（任務 1.3
/// 沒有換發 token）。
#[test]
fn access_token_frame_matches_the_docs() {
    let docs = v1_from_v2(json!([
        "10",
        "1",
        "realtime:my-channel",
        "access_token",
        { "access_token": "<new-token>" }
    ]));
    assert_eq!(
        wire(&access_token_frame("my-channel", "10", "1", "<new-token>")),
        parse(&docs)
    );
}

/// presence track：payload 是 `{"type": "presence", "event": "track", "payload": <Presence_Meta>}`（需求 15.1）。
///
/// 來源：任務 1.3 的 presence.txt（檢查 9，A track）。<https://supabase.com/docs/guides/realtime/protocol>「Event
/// types › Client sent events › presence」的範例的 meta（`name`、`color`）不是 Presence_Meta，所以以實測的訊框對照。
#[test]
fn track_frame_matches_realtime() {
    let spike = r#"{"topic":"realtime:trip:c00a4ae1-58f0-464b-9aa7-638ed8090bab","event":"presence","payload":{"event":"track","payload":{"display_name":"甲","editing":null,"person":"1b643e52-00fe-4676-abf7-ce3cead227de","user":"a2005867-1ced-43e0-a293-3c007ddd29f1"},"type":"presence"},"ref":"6","join_ref":"1"}"#;
    let meta: PresenceMeta = serde_json::from_value(parse(spike)["payload"]["payload"].clone())
        .expect("A 的 Presence_Meta");
    assert_eq!(
        wire(&track_frame(SPIKE_TRIP, "1", "6", &meta)),
        parse(spike)
    );
}

// ── 收到的訊框（需求 33.7 (b)） ──

/// 需求 33.7 (b)：加入成功的回覆解成 `JoinOk`，保留回覆的 `ref`（等於那次加入的 join_ref）。presence track 的成功回覆
/// 也是 `JoinOk`，只有 `ref` 不同，由 `PhoenixSocket` 以 ref 分辨。
///
/// 來源：<https://supabase.com/docs/guides/realtime/protocol>「Event types › Server sent events › phx_reply」的範例；
/// 任務 1.3 的 join-ok.txt（加入成功）與 presence.txt（track 的回覆）。
#[test]
fn decodes_join_ok() {
    let docs = v1_from_v2(json!(["1", "1", "realtime:chat-room", "phx_reply", {
        "status": "ok",
        "response": {
            "postgres_changes": [
                { "id": 106243155, "event": "*", "schema": "public", "table": "test" }
            ]
        }
    }]));
    assert_eq!(
        decode(&docs),
        Ok(Inbound::JoinOk {
            topic: "chat-room".into(),
            reference: Some("1".into()),
        })
    );

    let join_ok = r#"{"ref":"1","event":"phx_reply","payload":{"status":"ok","response":{"postgres_changes":[]}},"topic":"realtime:trip:c00a4ae1-58f0-464b-9aa7-638ed8090bab"}"#;
    assert_eq!(
        decode(join_ok),
        Ok(Inbound::JoinOk {
            topic: SPIKE_TRIP.into(),
            reference: Some("1".into()),
        })
    );

    let track_ok = r#"{"ref":"6","event":"phx_reply","payload":{"status":"ok","response":{}},"topic":"realtime:trip:c00a4ae1-58f0-464b-9aa7-638ed8090bab"}"#;
    assert_eq!(
        decode(track_ok),
        Ok(Inbound::JoinOk {
            topic: SPIKE_TRIP.into(),
            reference: Some("6".into()),
        })
    );
}

/// 需求 33.7 (b)：被拒的回覆解成 `JoinError`，原樣保留 `response.reason`（加入被拒時是 `<錯誤代碼>: <說明>`）；沒有
/// `reason` 的錯誤回覆（例如被拒的 presence track）是空字串。
///
/// 來源：<https://supabase.com/docs/guides/realtime/protocol>「Error handling › Join errors」（文件只列出 payload，以及
/// 沒有代碼前綴的 `Unknown Error on Channel`；訊框的 topic 與 ref 沿用「phx_reply」的範例）與「Error handling ›
/// Presence errors」（只有說明，依說明組成）；任務 1.3 的 join-unauthorized.txt（檢查 2，沒有綁定旅伴的帳號 C）。
#[test]
fn decodes_join_errors_with_the_reason() {
    for reason in [
        "InvalidJWTExpiration: Token has expired 300 seconds ago",
        "Unknown Error on Channel",
    ] {
        let docs = v1_from_v2(json!(["1", "1", "realtime:chat-room", "phx_reply", {
            "status": "error",
            "response": { "reason": reason }
        }]));
        assert_eq!(
            decode(&docs),
            Ok(Inbound::JoinError {
                topic: "chat-room".into(),
                reference: Some("1".into()),
                reason: reason.into(),
            })
        );
    }

    // presence track 的錯誤回覆：payload 的形狀不對時有 reason，其他失敗沒有 reason
    let shape = v1_from_v2(json!(["1", "5", "realtime:presence-room", "phx_reply", {
        "status": "error",
        "response": { "reason": "Presence track payload must be a map" }
    }]));
    assert_eq!(
        decode(&shape),
        Ok(Inbound::JoinError {
            topic: "presence-room".into(),
            reference: Some("5".into()),
            reason: "Presence track payload must be a map".into(),
        })
    );
    let bare = v1_from_v2(json!(["1", "5", "realtime:presence-room", "phx_reply", {
        "status": "error",
        "response": {}
    }]));
    assert_eq!(
        decode(&bare),
        Ok(Inbound::JoinError {
            topic: "presence-room".into(),
            reference: Some("5".into()),
            reason: String::new(),
        })
    );

    let spike = r#"{"ref":"1","event":"phx_reply","payload":{"status":"error","response":{"reason":"Unauthorized: You do not have permissions to read from this Channel topic: trip:c00a4ae1-58f0-464b-9aa7-638ed8090bab"}},"topic":"realtime:trip:c00a4ae1-58f0-464b-9aa7-638ed8090bab"}"#;
    assert_eq!(
        decode(spike),
        Ok(Inbound::JoinError {
            topic: SPIKE_TRIP.into(),
            reference: Some("1".into()),
            reason: "Unauthorized: You do not have permissions to read from this Channel topic: trip:c00a4ae1-58f0-464b-9aa7-638ed8090bab".into(),
        })
    );
}

/// 需求 33.7 (b)：broadcast 解成 `Broadcast`：`event` 與 `payload` 取自訊框 payload 的同名欄位，`payload` 原樣交給
/// 呼叫端。
///
/// 來源：<https://supabase.com/docs/guides/realtime/protocol>「Event types › Server sent events › broadcast (text
/// frame)」的範例；任務 1.3 的 broadcast-changeset.txt（檢查 4，Database 推送的 Change_Set：payload 多了
/// `realtime.send()` 加入的 `id`，與 `meta.id` 相同）與 broadcast-thin.txt（檢查 6，Thin_Notice）。
#[test]
fn decodes_broadcasts() {
    let message = json!({
        "id": "513edcc1-4cbc-4274-aa26-c195f7e8c090",
        "content": "oi",
        "username": "hpK9jN2iY-I2HioHWr5ml",
        "createdAt": "2025-11-18T22:44:29Z"
    });
    let docs = v1_from_v2(json!([null, null, "realtime:chat-room", "broadcast", {
        "event": "message",
        "type": "broadcast",
        "meta": { "id": "006554ce-d22d-469c-877a-88bef47214a3" },
        "payload": message
    }]));
    assert_eq!(
        decode(&docs),
        Ok(Inbound::Broadcast {
            topic: "chat-room".into(),
            event: "message".into(),
            payload: message,
        })
    );

    // 在 "key" 之後斷開（見檔案開頭）；執行時的文字與原文相同
    let changeset = concat!(
        r#"{"ref":null,"event":"broadcast","payload":{"event":"changeset","meta":{"id":"bd56701c-d0cb-4eff-8ef8-b10e33ba0883"},"payload":{"id": "bd56701c-d0cb-4eff-8ef8-b10e33ba0883", "seq": 1, "trip": "c00a4ae1-58f0-464b-9aa7-638ed8090bab", "actor": "a2005867-1ced-43e0-a293-3c007ddd29f1", "changes": [{"key"#,
        r#"": "82d955fb-38e8-449e-ba89-6e2a8c61dc26", "row": {"row": {"id": "82d955fb-38e8-449e-ba89-6e2a8c61dc26", "name": "牛肉片", "source": "meal", "ordinal": 17, "version": 1, "assignee": "fbd9d5ef-4f35-492c-bfd3-cc77ceff02fc", "category": "肉類", "meal_ids": ["8d6b3c9f-aeeb-4439-91f7-34937ce9f382"], "quantity": "2 盒", "purchased": true, "recipe_removed": null}, "entity": "shopping"}, "entity": "shopping", "version": 1}], "command_id": "0e61f819-beaf-48bd-8e90-4e33c55bc644", "trip_deleted": false, "committed_at_ms": 1795433187798},"type":"broadcast"},"topic":"realtime:trip:c00a4ae1-58f0-464b-9aa7-638ed8090bab"}"#,
    );
    let raw = parse(changeset);
    let Ok(Inbound::Broadcast {
        topic,
        event,
        payload,
    }) = decode(changeset)
    else {
        panic!("Change_Set 應解成 Broadcast");
    };
    assert_eq!(topic, SPIKE_TRIP);
    assert_eq!(event, "changeset");
    assert_eq!(payload, raw["payload"]["payload"]);
    assert_eq!(payload["id"], raw["payload"]["meta"]["id"]);
    assert_eq!(payload["seq"], 1);

    let thin = r#"{"ref":null,"event":"broadcast","payload":{"event":"changeset","meta":{"id":"43c1d87f-7c1c-49dc-98a2-e5204501a454"},"payload":{"id": "43c1d87f-7c1c-49dc-98a2-e5204501a454", "seq": 3, "thin": true, "trip": "c00a4ae1-58f0-464b-9aa7-638ed8090bab"},"type":"broadcast"},"topic":"realtime:trip:c00a4ae1-58f0-464b-9aa7-638ed8090bab"}"#;
    assert_eq!(
        decode(thin),
        Ok(Inbound::Broadcast {
            topic: SPIKE_TRIP.into(),
            event: "changeset".into(),
            payload: json!({
                "id": "43c1d87f-7c1c-49dc-98a2-e5204501a454",
                "seq": 3,
                "thin": true,
                "trip": "c00a4ae1-58f0-464b-9aa7-638ed8090bab"
            }),
        })
    );
}

/// 需求 33.7 (b)：presence 的完整狀態解成 `PresenceState`，`state` 是整個 payload（presence key → `metas`）。
///
/// 來源：<https://supabase.com/docs/guides/realtime/protocol>「Event types › Server sent events › presence_state」的
/// 範例（每筆 meta 另有與 presence key 相同的 `key`，以 `cursor_meta()` 組成，見檔案開頭）；任務 1.3 的 join-ok.txt
/// （加入後還沒有人 track）與 presence.txt（檢查 9，B2 加入時含 A 的 meta）。
#[test]
fn decodes_presence_state() {
    let state = json!({
        "2wCojG1xWgxG2ZxwocvSX": {
            "metas": [cursor_meta("GHlA1fShRjMmZhnL", "hsl(204, 100%, 70%)", "2wCojG1xWgxG2ZxwocvSX")]
        },
        "6eorYR7andHiq-7tCkmxQ": {
            "metas": [cursor_meta("GHk99Q_ez6-GzaeG", "hsl(7, 100%, 70%)", "6eorYR7andHiq-7tCkmxQ")]
        },
        "FOeQUamq3OLOWAAZK8iH3": {
            "metas": [cursor_meta("GHk-wA8Z61GGzeoG", "hsl(212, 100%, 70%)", "FOeQUamq3OLOWAAZK8iH3")]
        }
    });
    let docs = v1_from_v2(json!([
        "4",
        null,
        "realtime:cursor-room",
        "presence_state",
        state
    ]));
    assert_eq!(
        decode(&docs),
        Ok(Inbound::PresenceState {
            topic: "cursor-room".into(),
            state,
        })
    );

    let empty = r#"{"ref":null,"event":"presence_state","payload":{},"topic":"realtime:trip:c00a4ae1-58f0-464b-9aa7-638ed8090bab"}"#;
    assert_eq!(
        decode(empty),
        Ok(Inbound::PresenceState {
            topic: SPIKE_TRIP.into(),
            state: json!({}),
        })
    );

    let with_a = r#"{"ref":null,"event":"presence_state","payload":{"af97c762-f0f0-4335-8e08-817b8d3ea915":{"metas":[{"phx_ref":"GOqo_bj1p3Clq74B","display_name":"甲","editing":null,"person":"1b643e52-00fe-4676-abf7-ce3cead227de","user":"a2005867-1ced-43e0-a293-3c007ddd29f1"}]}},"topic":"realtime:trip:c00a4ae1-58f0-464b-9aa7-638ed8090bab"}"#;
    let Ok(Inbound::PresenceState { topic, state }) = decode(with_a) else {
        panic!("presence_state 應解成 PresenceState");
    };
    assert_eq!(topic, SPIKE_TRIP);
    assert_eq!(state, parse(with_a)["payload"]);
    assert_eq!(state[SPIKE_TAB]["metas"][0]["display_name"], "甲");
}

/// 需求 33.7 (b)：presence 的增減解成 `PresenceDiff`，`joins` 與 `leaves` 取自 payload。
///
/// 來源：<https://supabase.com/docs/guides/realtime/protocol>「Event types › Server sent events › presence_diff」的
/// 範例；任務 1.3 的 presence.txt（檢查 9：A track 之後 B 收到的 `joins`，A 離開之後 B 收到的 `leaves`）。
#[test]
fn decodes_presence_diff() {
    let joins = json!({
        "XnAJXkZVEJuBYZcp9GCG5": {
            "metas": [{ "phx_ref": "GHlE8VLvxuKGzQJN", "color": "hsl(60, 100%, 70%)", "user": "123" }]
        }
    });
    let leaves = json!({
        "ouCsaiOdKZ9yauoy4x5pv": {
            "metas": [{ "phx_ref": "GHlE8HyhSPAmZgdB", "color": "hsl(72, 100%, 70%)", "user": "456" }]
        }
    });
    let docs = v1_from_v2(
        json!([null, null, "realtime:cursor-room", "presence_diff", {
            "joins": joins,
            "leaves": leaves
        }]),
    );
    assert_eq!(
        decode(&docs),
        Ok(Inbound::PresenceDiff {
            topic: "cursor-room".into(),
            joins,
            leaves,
        })
    );

    let joined = r#"{"ref":null,"event":"presence_diff","payload":{"joins":{"af97c762-f0f0-4335-8e08-817b8d3ea915":{"metas":[{"phx_ref":"GOqo_bj1p3Clq74B","display_name":"甲","editing":null,"person":"1b643e52-00fe-4676-abf7-ce3cead227de","user":"a2005867-1ced-43e0-a293-3c007ddd29f1"}]}},"leaves":{}},"topic":"realtime:trip:c00a4ae1-58f0-464b-9aa7-638ed8090bab"}"#;
    assert_eq!(
        decode(joined),
        Ok(Inbound::PresenceDiff {
            topic: SPIKE_TRIP.into(),
            joins: parse(joined)["payload"]["joins"].clone(),
            leaves: json!({}),
        })
    );

    let left = r#"{"ref":null,"event":"presence_diff","payload":{"joins":{},"leaves":{"af97c762-f0f0-4335-8e08-817b8d3ea915":{"metas":[{"phx_ref":"GOqo_bj1p3Clq74B","display_name":"甲","editing":null,"person":"1b643e52-00fe-4676-abf7-ce3cead227de","user":"a2005867-1ced-43e0-a293-3c007ddd29f1"}]}}},"topic":"realtime:trip:c00a4ae1-58f0-464b-9aa7-638ed8090bab"}"#;
    assert_eq!(
        decode(left),
        Ok(Inbound::PresenceDiff {
            topic: SPIKE_TRIP.into(),
            joins: json!({}),
            leaves: parse(left)["payload"]["leaves"].clone(),
        })
    );
}

/// 需求 33.7 (b)：頻道關閉（`phx_close`）解成 `ChannelClosed`，保留 `ref`（被關閉的那次加入的 join_ref）。
///
/// 來源：<https://supabase.com/docs/guides/realtime/protocol>「Event types › Server sent events › phx_close」的範例；
/// 任務 1.3 的 presence.txt（檢查 9，A 離開之後）。
#[test]
fn decodes_channel_close() {
    let docs = v1_from_v2(json!([
        "3",
        "3",
        "realtime:avatar-stack-demo",
        "phx_close",
        {}
    ]));
    assert_eq!(
        decode(&docs),
        Ok(Inbound::ChannelClosed {
            topic: "avatar-stack-demo".into(),
            reference: Some("3".into()),
        })
    );

    let spike = r#"{"ref":"1","event":"phx_close","payload":{},"topic":"realtime:trip:c00a4ae1-58f0-464b-9aa7-638ed8090bab"}"#;
    assert_eq!(
        decode(spike),
        Ok(Inbound::ChannelClosed {
            topic: SPIKE_TRIP.into(),
            reference: Some("1".into()),
        })
    );
}

/// 需求 33.7 (b)：頻道錯誤（`phx_error`）解成 `ChannelError`，保留 `ref`。
///
/// 來源：<https://supabase.com/docs/guides/realtime/protocol>「Event types › Server sent events › phx_error」的範例
/// （任務 1.3 沒有收到 `phx_error`）。
#[test]
fn decodes_channel_error() {
    let docs = v1_from_v2(json!([
        "3",
        "3",
        "realtime:avatar-stack-demo",
        "phx_error",
        {}
    ]));
    assert_eq!(
        decode(&docs),
        Ok(Inbound::ChannelError {
            topic: "avatar-stack-demo".into(),
            reference: Some("3".into()),
        })
    );
}

/// 需求 33.7 (b)：系統通知（`system`）解成 `System`，保留 `status` 與 `message`。
///
/// 來源：<https://supabase.com/docs/guides/realtime/protocol>「Event types › Server sent events › system」的兩個範例；
/// channel 層級的錯誤依「Error handling › Channel-level system errors」的說明組成（`extension` 是 `system`、`status`
/// 是 `error`，`message` 取表中的文字；文件沒有完整的訊框）。任務 1.3 沒有收到 `system`（system.txt）。
#[test]
fn decodes_system_messages() {
    let cases = [
        ("13", "Subscribed to PostgreSQL", "ok", "postgres_changes"),
        ("14", "Replication connection established", "ok", "system"),
        // 以下依說明組成
        ("13", "Token has expired", "error", "system"),
        (
            "13",
            "Client presence rate limit exceeded",
            "error",
            "system",
        ),
    ];
    for (join_ref, message, status, extension) in cases {
        let docs = v1_from_v2(json!([join_ref, null, "realtime:chat-room", "system", {
            "message": message,
            "status": status,
            "extension": extension,
            "channel": "main"
        }]));
        assert_eq!(
            decode(&docs),
            Ok(Inbound::System {
                topic: "chat-room".into(),
                status: status.into(),
                message: message.into(),
            }),
            "{message}"
        );
    }
}

/// 需求 33.7 (b)：heartbeat 的回覆（topic `phoenix` 上 `status` 為 `ok` 的 `phx_reply`）解成 `HeartbeatOk`，保留
/// `ref`。
///
/// 來源：<https://supabase.com/docs/guides/realtime/protocol> 沒有 heartbeat 回覆的範例，依「Event types › Client
/// sent events › heartbeat」的範例（ref `26`）與「Server sent events › phx_reply」的說明組成；任務 1.3 的
/// heartbeat.txt。
#[test]
fn decodes_heartbeat_replies() {
    let docs = v1_from_v2(json!([null, "26", "phoenix", "phx_reply", {
        "status": "ok",
        "response": {}
    }]));
    assert_eq!(
        decode(&docs),
        Ok(Inbound::HeartbeatOk {
            reference: Some("26".into()),
        })
    );

    let spike = r#"{"ref":"2","event":"phx_reply","payload":{"status":"ok","response":{}},"topic":"phoenix"}"#;
    assert_eq!(
        decode(spike),
        Ok(Inbound::HeartbeatOk {
            reference: Some("2".into()),
        })
    );
}

/// 需求 33.7 (b)：不認得的事件解碼為 `Other`。
///
/// 來源：<https://supabase.com/docs/guides/realtime/protocol>「Event types › Server sent events › postgres_changes」的
/// 範例（Trip_Channel 不訂閱 Postgres Changes），以及「Protocol messages › 1.0.0」的範例原文（用戶端送出的
/// `phx_join`，不是收到的種類）。
#[test]
fn unknown_events_decode_as_other() {
    let postgres_changes = v1_from_v2(
        json!([null, null, "realtime:chat-room", "postgres_changes", {
            "ids": [104868189],
            "data": {
                "schema": "public",
                "table": "test",
                "commit_timestamp": "2025-11-19T00:22:40.877Z",
                "type": "UPDATE",
                "columns": [
                    { "name": "id", "type": "int8" },
                    { "name": "created_at", "type": "timestamptz" },
                    { "name": "text", "type": "text" }
                ],
                "record": { "id": 46, "text": "content", "created_at": "2025-11-03T09:32:55+00:00" },
                "old_record": { "id": 46 },
                "errors": null
            }
        }]),
    );
    assert_eq!(decode(&postgres_changes), Ok(Inbound::Other));

    let join = r#"{
  "topic": "realtime:presence-room",
  "event": "phx_join",
  "payload": {
    "config": {
      "broadcast": {
        "ack": false,
        "self": false
      },
      "presence": {
        "enabled": false
      },
      "private": false
    }
  },
  "ref": "1",
  "join_ref": "1"
}"#;
    assert_eq!(decode(join), Ok(Inbound::Other));
}

/// 需求 33.7 (b)：無法解析的文字回傳錯誤：不是 JSON、不是協定 1.0.0 的訊框（包括 2.0.0 的陣列），或 `phx_reply`
/// 沒有 `status`。
///
/// 來源：<https://supabase.com/docs/guides/realtime/protocol>「Event types › Client sent events › heartbeat」的 2.0.0
/// 範例原文；其餘由任務 1.3 的 heartbeat.txt 的回覆改寫（截斷、缺少欄位或型別不對）。
#[test]
fn unparseable_text_is_an_error() {
    for text in [
        "",
        "not json",
        r#"{"ref":"2","event":"phx_reply","payload":"#,
    ] {
        assert!(
            matches!(decode(text), Err(ProtocolError::InvalidJson(_))),
            "{text:?}"
        );
    }
    for text in [
        r#"[null, "26", "phoenix", "heartbeat", {}]"#,
        r#""phx_reply""#,
        r#"{"ref":"2","event":"phx_reply","topic":"phoenix"}"#,
        r#"{"ref":"2","payload":{"status":"ok","response":{}},"topic":"phoenix"}"#,
        r#"{"ref":2,"event":"phx_reply","payload":{"status":"ok","response":{}},"topic":"phoenix"}"#,
        r#"{"ref":"2","event":"phx_reply","payload":{"status":"ok","response":{}},"topic":null}"#,
    ] {
        assert!(
            matches!(decode(text), Err(ProtocolError::NotAFrame(_))),
            "{text:?}"
        );
    }
    let no_status =
        r#"{"ref":"2","event":"phx_reply","payload":{"response":{}},"topic":"phoenix"}"#;
    assert_eq!(decode(no_status), Err(ProtocolError::MalformedReply));
}
