//! 誰正在編輯（design 1.7、A11）：`EditTarget`、`PresenceMeta` 與 `PresenceThrottle`；編輯者頭像由之後的任務填入。
//!
//! Presence 由用戶端自行回報，只作為提示，不影響權限與資料（需求 15.11）。目前時間由呼叫端傳入（毫秒，`f64`，與
//! 瀏覽器的時間相同）。

use serde::{Deserialize, Serialize};

use crate::ids::{PersonId, UserId};
use crate::model::{Entity, RowKey};

// ── Presence ──

/// 正在編輯的對象：卡片或列，例如 (Route, id)、(DaySetting, 日期)、(Meal, id)、(Shopping, id)、(Card, 旅行 id)。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct EditTarget {
    pub entity: Entity,
    pub key: RowKey,
}

/// 每個分頁 track 的內容（Presence_Meta）。由用戶端自行回報，只作為提示，不影響權限與資料。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PresenceMeta {
    pub user: UserId,
    /// 帳號的顯示名稱（app.profiles.display_name，取自 Snapshot 的 viewer），不是旅伴名稱。
    pub display_name: String,
    /// 這個帳號在這趟旅行綁定的旅伴（沒有時為空，例如 Unbound_Admin）；只用來把「剛更新了這一項」對應到旅伴名稱。
    pub person: Option<PersonId>,
    /// 每個分頁同時最多一個（需求 15.1）。
    pub editing: Option<EditTarget>,
}

/// `PresenceThrottle` 要呼叫端做的事。
#[derive(Clone, Debug, PartialEq)]
pub enum ThrottleAction {
    /// 現在以這筆內容 track。
    Send(PresenceMeta),
    /// 還不能送出：在這個時間（毫秒）呼叫 `wake()`。
    WakeAt(f64),
    /// 不需要做任何事。
    Nothing,
}

/// Presence_Throttle：任兩次送出至少相隔 6,500 毫秒，重新加入 Trip_Channel 也不例外，所以任何 30 秒的區間最多送出
/// ⌊30 ÷ 6.5⌋ + 1 = 5 次（Realtime 的每用戶端 presence 限制，需求 15.3）；只保留最後一筆，最後的狀態一定會送出
/// （需求 15.4）。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PresenceThrottle {
    /// 上次送出的時間；重新加入時保留，6.5 秒的間隔跨重新加入仍然成立（需求 15.3、15.6）。
    last_sent: Option<f64>,
    /// 目前這次加入 Trip_Channel 之後最後送出的內容；重新加入時清空（需求 15.5）。
    sent: Option<PresenceMeta>,
    /// 還不能送出的最新一筆（需求 15.4）。
    pending: Option<PresenceMeta>,
}

impl PresenceThrottle {
    /// 任兩次送出的最小間隔（毫秒）。
    pub const MIN_GAP_MS: f64 = 6_500.0;

    /// 還沒送出過任何內容的節流器。
    pub fn new() -> PresenceThrottle {
        PresenceThrottle::default()
    }

    /// 這個分頁的 Presence_Meta 改變了（開啟或關閉表單）。與這次加入之後上次送出的相同時不送，並捨棄保留的那一筆
    /// （需求 15.5）；距離上次送出不到 6.5 秒時只保留最新的一筆，等到 `WakeAt` 的時間（需求 15.4）。
    pub fn offer(&mut self, meta: PresenceMeta, now_ms: f64) -> ThrottleAction {
        if self.sent.as_ref() == Some(&meta) {
            // 這次加入之後對方看到的已是這個狀態
            self.pending = None;
            return ThrottleAction::Nothing;
        }
        match self.last_sent {
            Some(last) if now_ms - last < Self::MIN_GAP_MS => {
                // 只留最新的一筆
                self.pending = Some(meta);
                ThrottleAction::WakeAt(last + Self::MIN_GAP_MS)
            }
            _ => {
                self.last_sent = Some(now_ms);
                self.sent = Some(meta.clone());
                self.pending = None;
                ThrottleAction::Send(meta)
            }
        }
    }

    /// 在 `WakeAt` 指定的時間呼叫：送出保留的那一筆（還不能送時再回傳 `WakeAt`）；沒有保留的內容時不做任何事。
    pub fn wake(&mut self, now_ms: f64) -> ThrottleAction {
        match self.pending.take() {
            Some(meta) => self.offer(meta, now_ms),
            None => ThrottleAction::Nothing,
        }
    }

    /// 加入 Trip_Channel 成功後呼叫：Realtime 已沒有這個分頁的 presence，所以「與上次送出的相同」改為只和這次加入
    /// 之後送出的比較（需求 15.5），保留中的那一筆也一併捨棄；上次送出的時間保留，6.5 秒的間隔跨重新加入仍然成立
    /// （需求 15.3、15.6）。
    ///
    /// 呼叫端接著以這個分頁目前的 Presence_Meta 呼叫 `offer()`，所以最後一次開啟或關閉表單的狀態一定會重送；這個
    /// 分頁從未回報過 Presence_Meta 時，呼叫端不呼叫 `offer()`（需求 15.6）。
    pub fn on_rejoin(&mut self) {
        self.sent = None;
        self.pending = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use uuid::Uuid;

    #[test]
    fn presence_meta_wire_format() {
        let meta = PresenceMeta {
            user: UserId(Uuid::from_u128(1)),
            display_name: "陳小明".to_owned(),
            person: Some(PersonId(Uuid::from_u128(2))),
            editing: Some(EditTarget {
                entity: Entity::DaySetting,
                key: RowKey::Day(chrono::NaiveDate::from_ymd_opt(2026, 7, 1).unwrap()),
            }),
        };
        let value = json!({
            "user": "00000000-0000-0000-0000-000000000001",
            "display_name": "陳小明",
            "person": "00000000-0000-0000-0000-000000000002",
            "editing": { "entity": "day_setting", "key": "2026-07-01" },
        });
        assert_eq!(serde_json::to_value(&meta).unwrap(), value);
        assert_eq!(serde_json::from_value::<PresenceMeta>(value).unwrap(), meta);
    }

    #[test]
    fn missing_person_and_target_are_empty() {
        let meta: PresenceMeta = serde_json::from_value(json!({
            "user": "00000000-0000-0000-0000-000000000001",
            "display_name": "  一個超過三十個字元的名稱也照樣可以解析，之後再修剪與截斷  ",
        }))
        .unwrap();
        assert_eq!(meta.person, None);
        assert_eq!(meta.editing, None);
    }

    #[test]
    fn malformed_meta_is_rejected() {
        for value in [
            json!({ "display_name": "陳小明" }),
            json!({ "user": "not-a-uuid", "display_name": "陳小明" }),
            json!({ "user": "00000000-0000-0000-0000-000000000001", "display_name": 3 }),
            json!({
                "user": "00000000-0000-0000-0000-000000000001",
                "display_name": "陳小明",
                "editing": { "entity": "unknown", "key": "00000000-0000-0000-0000-000000000003" },
            }),
        ] {
            assert!(
                serde_json::from_value::<PresenceMeta>(value.clone()).is_err(),
                "{value}"
            );
        }
    }
}
