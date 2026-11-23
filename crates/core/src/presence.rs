//! 誰正在編輯（design 1.7、A11、A13）：`EditTarget`、`PresenceMeta`、`PresenceThrottle`；編輯者頭像：
//! `avatar_initial()`、`avatar_color()`、`AVATAR_PALETTE`、`editor_stacks()` 與 `EditorStack`。
//!
//! Presence 由用戶端自行回報，只作為提示，不影響權限與資料（需求 15.11）。目前時間由呼叫端傳入（毫秒，`f64`，與
//! 瀏覽器的時間相同）；頭像的字與顏色只依顯示名稱與帳號 id 決定，執行時的 `avatar_color()` 只用整數運算與查表，
//! 所以每個用戶端、原生與 wasm32 都得到相同的結果（需求 16.18）。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use unicode_segmentation::UnicodeSegmentation;

use crate::ids::{PersonId, UserId};
use crate::limits::DISPLAY_NAME_CHARS;
use crate::model::{Entity, RowKey};
use crate::text;

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

// ── 編輯者頭像 ──

/// 頭像上的字（Avatar_Initial）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AvatarInitial {
    /// 修剪後顯示名稱的第一個擴充字素叢集，例如「陳」、「é」（e 加 U+0301）、「👨‍👩‍👧」、「🇹🇼」。
    Grapheme(String),
    /// 顯示名稱修剪後是空的。
    Placeholder,
}

/// 中性符號（U+30FB）；內建字型的介面子集已包含這個字（需求 16.5）。
pub const AVATAR_PLACEHOLDER: &str = "・";

impl AvatarInitial {
    /// 頭像上顯示的文字；`Placeholder` 是 [`AVATAR_PLACEHOLDER`]。
    pub fn as_str(&self) -> &str {
        match self {
            AvatarInitial::Grapheme(grapheme) => grapheme,
            AvatarInitial::Placeholder => AVATAR_PLACEHOLDER,
        }
    }
}

/// 修剪後（Trim_White）顯示名稱的第一個擴充字素叢集，不轉換大小寫；修剪後是空的時候為 `Placeholder`（需求 16.4、
/// 16.5）。`graphemes(true)` 依 UAX #29 的擴充規則切分，所以 ZWJ 連接的 emoji、國旗（兩個區域指示符號）、膚色修飾
/// 與組合字元都留在同一個叢集。
pub fn avatar_initial(display_name: &str) -> AvatarInitial {
    match text::trim_white(display_name).graphemes(true).next() {
        Some(first) => AvatarInitial::Grapheme(first.to_owned()),
        None => AvatarInitial::Placeholder,
    }
}

/// sRGB 顏色。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Rgb(pub u8, pub u8, pub u8);

impl Rgb {
    /// `#rrggbb`（小寫）。
    pub fn hex(self) -> String {
        let Rgb(r, g, b) = self;
        format!("#{r:02x}{g:02x}{b:02x}")
    }
}

/// 頭像的底色與文字色。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AvatarColor {
    pub background: Rgb,
    pub text: Rgb,
}

/// 與 styles.css 的 `--ink` 相同。
pub const INK: Rgb = Rgb(0x3e, 0x3a, 0x39);
/// 白色。
pub const WHITE: Rgb = Rgb(0xff, 0xff, 0xff);

/// Avatar_Palette：12 個柔和色，配合現有插畫與旅伴顏色的色調，依這個順序以雜湊值除以 12 的餘數選取（需求 16.6）。
/// 文字色在設計時從 INK 與 WHITE 中選對比較高者，結果每一色都是 INK；註解是 WCAG 2.x 公式算出的對比值，測試會重算
/// 並確認都不低於 4.5:1（需求 16.7）。淺色與深色主題使用同一組顏色（需求 16.8）。
pub const AVATAR_PALETTE: [AvatarColor; 12] = [
    // 珊瑚    5.41:1
    AvatarColor {
        background: Rgb(0xf0, 0xa0, 0x8c),
        text: INK,
    },
    // 蜜桃    6.50:1
    AvatarColor {
        background: Rgb(0xf4, 0xb9, 0x8a),
        text: INK,
    },
    // 向日葵  7.26:1
    AvatarColor {
        background: Rgb(0xf2, 0xcc, 0x5e),
        text: INK,
    },
    // 嫩芽    7.19:1
    AvatarColor {
        background: Rgb(0xcb, 0xd6, 0x7a),
        text: INK,
    },
    // 青草    6.46:1
    AvatarColor {
        background: Rgb(0xa8, 0xd0, 0x8d),
        text: INK,
    },
    // 薄荷    6.49:1
    AvatarColor {
        background: Rgb(0x8e, 0xd3, 0xb4),
        text: INK,
    },
    // 湖水    6.36:1
    AvatarColor {
        background: Rgb(0x85, 0xcf, 0xd5),
        text: INK,
    },
    // 天空    6.19:1
    AvatarColor {
        background: Rgb(0x9e, 0xc4, 0xec),
        text: INK,
    },
    // 長春花  5.87:1
    AvatarColor {
        background: Rgb(0xb4, 0xb7, 0xf0),
        text: INK,
    },
    // 薰衣草  6.00:1
    AvatarColor {
        background: Rgb(0xcd, 0xb3, 0xe8),
        text: INK,
    },
    // 櫻花    6.33:1
    AvatarColor {
        background: Rgb(0xf2, 0xb0, 0xc9),
        text: INK,
    },
    // 奶茶    6.38:1
    AvatarColor {
        background: Rgb(0xd9, 0xbf, 0xa1),
        text: INK,
    },
];

/// 頭像的顏色：帳號 id 的 16 個位元組（UUID 文字形式由左到右）→ FNV-1a（64 位元）→ 除以 12 的餘數 → 色盤中的
/// 一色（需求 16.6）。只用整數運算與查表；不受顯示名稱影響。
pub fn avatar_color(user: UserId) -> AvatarColor {
    let index = fnv1a_64(user.0.as_bytes()) % AVATAR_PALETTE.len() as u64;
    AVATAR_PALETTE[index as usize]
}

/// FNV-1a（64 位元）。不用 std 的 `Hasher`：它的演算法不保證跨 Rust 版本穩定，`HashMap` 預設的 `RandomState`
/// 每次執行還會換金鑰。公開是為了讓測試以公開的測試向量驗證（需求 33.3）。
pub fn fnv1a_64(bytes: &[u8]) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    bytes.iter().fold(OFFSET_BASIS, |hash, &byte| {
        (hash ^ u64::from(byte)).wrapping_mul(PRIME)
    })
}

/// 從 INK 與 WHITE 中選與 `background` 對比較高的文字色；只在建立與檢查色盤時使用，執行時不呼叫。
pub fn readable_text_on(background: Rgb) -> Rgb {
    if contrast_ratio(INK, background) >= contrast_ratio(WHITE, background) {
        INK
    } else {
        WHITE
    }
}

/// WCAG 2.x 的相對亮度：每個 sRGB 分量轉成線性值後加權。
pub fn relative_luminance(Rgb(r, g, b): Rgb) -> f64 {
    let linear = |v: u8| {
        let c = f64::from(v) / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/// WCAG 2.x 的對比值，1 到 21。
pub fn contrast_ratio(a: Rgb, b: Rgb) -> f64 {
    let (la, lb) = (relative_luminance(a), relative_luminance(b));
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

/// 一位編輯者的頭像（Editor_Avatar）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditorAvatar {
    pub user: UserId,
    /// 顯示用的名稱：Trim_White 之後，最多 30 個字元（需求 16.14）。
    pub display_name: String,
    /// 由完整的顯示名稱算出。
    pub initial: AvatarInitial,
    pub color: AvatarColor,
}

/// 名稱是空的時候用「有人」，避免出現「 正在編輯」這種沒有主詞的文字。
fn who(display_name: &str) -> &str {
    if display_name.is_empty() {
        "有人"
    } else {
        display_name
    }
}

/// 滑鼠提示中的名稱：空的時候是「未設定顯示名稱」。
fn tooltip_name(display_name: &str) -> &str {
    if display_name.is_empty() {
        "未設定顯示名稱"
    } else {
        display_name
    }
}

impl EditorAvatar {
    /// 無障礙名稱：「陳小明 正在編輯」；名稱是空的時候為「有人 正在編輯」（需求 16.11）。
    pub fn label(&self) -> String {
        format!("{} 正在編輯", who(&self.display_name))
    }

    /// 滑鼠提示：完整的顯示名稱；名稱是空的時候為「未設定顯示名稱」（需求 16.11）。
    pub fn tooltip(&self) -> String {
        tooltip_name(&self.display_name).to_owned()
    }
}

/// 一個編輯對象上的頭像堆疊（Editor_Stack）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EditorStack {
    /// 最多 `MAX_SHOWN` 位，依帳號 id 遞增。
    pub shown: Vec<EditorAvatar>,
    /// 其餘編輯者的顯示名稱（已修剪、最多 30 個字元），同樣依帳號 id 遞增；「+N」的 N 是它的長度。
    pub hidden: Vec<String>,
}

impl EditorStack {
    /// 最多顯示的頭像數；其餘計入「+N」（需求 16.9）。
    pub const MAX_SHOWN: usize = 3;

    /// 編輯者總數（頭像與「+N」代表的人數），不含檢視者。
    pub fn total(&self) -> usize {
        self.shown.len() + self.hidden.len()
    }

    /// 「+N」的無障礙名稱：「另外 2 人正在編輯：林大華、王小美」，空的名稱寫成「有人」；沒有其餘的人時為 `None`
    /// （需求 16.12）。
    pub fn overflow_label(&self) -> Option<String> {
        (!self.hidden.is_empty()).then(|| {
            let names: Vec<&str> = self.hidden.iter().map(|name| who(name)).collect();
            format!(
                "另外 {} 人正在編輯：{}",
                self.hidden.len(),
                names.join("、")
            )
        })
    }

    /// 「+N」的滑鼠提示：「林大華、王小美」，空的名稱寫成「未設定顯示名稱」；沒有其餘的人時為 `None`（需求 16.12）。
    pub fn overflow_tooltip(&self) -> Option<String> {
        (!self.hidden.is_empty()).then(|| {
            let names: Vec<&str> = self.hidden.iter().map(|name| tooltip_name(name)).collect();
            names.join("、")
        })
    }

    /// 開啟表單時的提示（Editing_Notice）：「陳小明 正在編輯這一項」，多人時「陳小明 等 4 人正在編輯這一項」；排在第一位
    /// 的名稱是空的時候以「有人」代替（需求 16.13）。`editor_stacks()` 不會產生空的堆疊。
    pub fn notice(&self) -> String {
        let first = self
            .shown
            .first()
            .map_or("有人", |avatar| who(&avatar.display_name));
        match self.total() {
            1 => format!("{first} 正在編輯這一項"),
            n => format!("{first} 等 {n} 人正在編輯這一項"),
        }
    }
}

/// 依編輯對象分組（需求 16.9、16.10）：同一帳號的多個分頁只算一位（保留它的第一筆 Presence_Meta）；不含 `viewer`
/// 自己的帳號（包括其他分頁與裝置）；依帳號 id 遞增，前 3 位成為頭像、其餘計入「+N」；沒有人在編輯的對象不出現在
/// 結果中。頭像的字由完整的顯示名稱算出；顯示用的名稱經 Trim_White 後截到 30 個字元（需求 16.14）。
pub fn editor_stacks<'a>(
    metas: impl IntoIterator<Item = &'a PresenceMeta>,
    viewer: UserId,
) -> BTreeMap<EditTarget, EditorStack> {
    // 每個對象：帳號 id → 該帳號的第一筆 meta。內層 BTreeMap 讓同一帳號只留一筆，也讓順序固定為帳號 id 遞增，所以
    // 每個人看到的頭像順序相同（需求 16.18）。
    let mut by_target: BTreeMap<EditTarget, BTreeMap<UserId, &'a PresenceMeta>> = BTreeMap::new();
    for meta in metas {
        let Some(target) = meta.editing else {
            continue;
        };
        if meta.user == viewer {
            continue;
        }
        by_target
            .entry(target)
            .or_default()
            .entry(meta.user)
            .or_insert(meta);
    }
    by_target
        .into_iter()
        .map(|(target, users)| {
            let mut stack = EditorStack::default();
            for (user, meta) in users {
                let display_name: String = text::trim_white(&meta.display_name)
                    .chars()
                    .take(*DISPLAY_NAME_CHARS.end())
                    .collect();
                if stack.shown.len() < EditorStack::MAX_SHOWN {
                    stack.shown.push(EditorAvatar {
                        user,
                        display_name,
                        initial: avatar_initial(&meta.display_name),
                        color: avatar_color(user),
                    });
                } else {
                    stack.hidden.push(display_name);
                }
            }
            (target, stack)
        })
        .collect()
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

    #[test]
    fn rgb_hex_is_lowercase() {
        assert_eq!(INK.hex(), "#3e3a39");
        assert_eq!(Rgb(0xF0, 0xA0, 0x8C).hex(), "#f0a08c");
    }
}
