//! 產生器使用的詞彙，以及食材文字（[`arb_ingredients()`]）與採買品項名稱（[`arb_item_name()`]）的產生器。
//!
//! 除了食材文字，每一組詞彙都是命令處理函式會儲存的寫法：已經過 Trim_White（旅伴名字與角色是 Participant_Name）、
//! 長度在 `lm_core::limits` 之內、不含 U+0000；旅伴名字、地點名稱與支出的項目名稱也不含 Hidden_Control_Char。
//! 食材文字依 design 刻意混合分隔符號、數字與各種空白，因為料理的食材文字照輸入的內容儲存（需求 24.2）。

use lm_core::ingredients::parse_ingredients;
use lm_core::text::trim_white;
use proptest::collection::vec;
use proptest::option;
use proptest::prelude::*;
use proptest::sample::select;

// ── 旅行、旅伴、車輛與地點 ──

/// 旅行名稱。
pub const TRIP_TITLES: &[&str] = &["雲海裡，住一晚", "森林小旅行", "Lake Weekend"];
/// 旅行目的地：空白（不能使用 Destination_Place）、與 [`PLACE_NAMES`] 中的地點 Place_Key 相同的名稱（產生器因此不把
/// 那個地點放進地點清單，I2），以及不與任何地點同名的名稱。
pub const DESTINATIONS: &[&str] = &["", "山間小日子營地", "ＡＢＣ營地", "海邊"];
/// 旅行介紹。
pub const TRIP_DESCRIPTIONS: &[&str] = &["", "一起煮飯、一起看星星。"];
/// 小叮嚀。
pub const TRIP_NOTES: &[&str] = &["", "山上晚上很冷，記得帶外套。"];

/// 旅伴名字：都已經是 Participant_Name 的結果、1–30 字、沒有 Hidden_Control_Char，而且 Participant_Key 兩兩不同，
/// 所以任取幾個都滿足 I2。
pub const PERSON_NAMES: &[&str] = &[
    "小安",
    "阿哲",
    "Amy",
    "林大華",
    "王小美",
    "陳小明",
    "Kai Chen",
    "🐻小熊",
];
/// 小隊角色；正規化之後是空的角色會改為「新加入的旅伴」（需求 19.1），所以不會是空的。
pub const PERSON_ROLES: &[&str] = &["這趟的召集人", "新加入的旅伴", "司機", "料理長"];

/// 車輛暱稱；車名可以與其他車輛相同（需求 20.1）。
pub const VEHICLE_NAMES: &[&str] = &["山線小巴", "海風號", "露營車", "Mini Van"];
/// 車輛顏色：`#` 加上 6 個小寫的十六進位數字（需求 20.3）。
pub const VEHICLE_COLORS: &[&str] = &["#efa28f", "#7fb5d5", "#a3c585"];

/// 地點名稱：都已經過 Trim_White、1–50 字、沒有 Hidden_Control_Char，而且 Place_Key 兩兩不同。
pub const PLACE_NAMES: &[&str] = &[
    "山下超市",
    "夕淞度日營區",
    "山間小日子營地",
    "abc營地",
    "超市/賣場",
    "湖畔木棧道",
    "觀景台",
    "Sunny 咖啡",
];

// ── 行程表 ──

/// 停靠點備註，0–100 字。
pub const STOP_NOTES: &[&str] = &["", "買冰塊", "接小安", "還車前加油"];
/// 每日設定的標題，1–20 字（只有空白的標題視為未設定，不會儲存）。
pub const DAY_TITLES: &[&str] = &["森林小徑", "抵達營地", "返程日"];
/// 停靠點的待辦清單或旅伴名單的一項，1–100 字。
pub const STOP_ITEMS: &[&str] = &["冰塊", "小安", "借營燈", "Ken"];
/// 每日設定的抵達說明，1–120 字。
pub const ARRIVAL_LABELS: &[&str] = &["營地 14:00 可進場", "晚餐前抵達"];

// ── 繪本 ──

/// 繪本的大標題，0–80 字。
pub const STORYBOOK_HEADLINES: &[&str] = &["", "露營小日記", "Camping Days"];
/// 繪本的底部短語，0–150 字。
pub const STORYBOOK_CAPTIONS: &[&str] = &["", "一起去山裡過週末。"];
/// 活動標題，1–100 字。
pub const ACTIVITY_TITLES: &[&str] = &[
    "起床",
    "搭帳・營地佈置",
    "星空夜聊・自由活動",
    "自由活動、拍照",
    "集合、返程",
    "BBQ 晚會",
];
/// 活動地點（自由文字），0–150 字。
pub const ACTIVITY_LOCATIONS: &[&str] = &["", "營地", "湖邊", "山下超市"];
/// 活動備註，0–1000 字：中間可以有換行與連續的空白。
pub const ACTIVITY_NOTES: &[&str] = &["", "記得帶手電筒", "帶水壺\n和外套", "兩個  空格"];
/// 常見的時刻（以分鐘表示）：08:00、08:30、10:00、12:00、13:00、15:00、18:00、20:00、21:00，包括料理的預設用餐時間，
/// 所以同一天常有同一時間的活動與料理。
pub const CLOCK_MINUTES: &[u16] = &[480, 510, 600, 720, 780, 900, 1080, 1200, 1260];

// ── 料理、採買與裝備 ──

/// 料理名稱，0–100 字：包括空的名稱與和餐次相同的名稱。
pub const MEAL_TITLES: &[&str] = &["", "晚餐", "壽喜燒", "烤肉串燒", "熱壓吐司", "咖哩飯"];
/// 料理筆記，0–1000 字。
pub const MEAL_NOTES: &[&str] = &["", "先醃肉", "第一行\n第二行"];

/// 食材名稱：不含分隔符號、最多 9 個字，NFKC 之後的字數也一樣。包括 Ingredient_Key 相同的不同寫法（「雞蛋」與
/// 「雞 蛋」，「ABC」「abc」與全形的「Ａｂｃ」，「Bacon」與「bacon」）、分類容易混淆的名稱（「地瓜」與「地瓜葉」、
/// 「茶葉蛋」、「雞粉」，以及「鹽」加 U+0663），和內含 `1.5`、`1,000` 與全形數字的名稱。
pub const INGREDIENT_WORDS: &[&str] = &[
    "牛肉片",
    "高麗菜",
    "雞蛋",
    "雞 蛋",
    "豆腐",
    "板豆腐",
    "冰塊",
    "鹽",
    "鹽\u{663}",
    "醬油",
    "地瓜",
    "地瓜葉",
    "茶葉蛋",
    "雞粉",
    "甜椒",
    "玉米",
    "洋蔥",
    "牛奶 1.5L",
    "白米 1,000g",
    "１，０００g 麵粉",
    "蘋果 ２ 顆",
    "ABC",
    "abc",
    "Ａｂｃ",
    "Bacon",
    "bacon",
];
/// [`INGREDIENT_WORDS`] 中常用的 7 種寫法（4 個 Ingredient_Key）：產生器有一半的名稱取自這裡，所以不同的料理與採買品項
/// 常常需要或涵蓋同一個食材，同一個鍵的不同寫法也常一起出現。
pub const COMMON_INGREDIENT_WORDS: &[&str] =
    &["牛肉片", "高麗菜", "雞蛋", "雞 蛋", "ABC", "abc", "Ａｂｃ"];
/// 單獨出現的數字；全形的「１．５」在 NFKC 之後是 `1.5`。
pub const INGREDIENT_NUMBERS: &[&str] = &["1.5", "1,000", "２", "１．５"];
/// 分隔符號（需求 25.3）：一律切開的「、」「;」「/」「。」、LF 與 CRLF；全形的「，」「；」「／」與 U+FF64「､」、
/// U+FF61「｡」，NFKC 之後分別是「,」「;」「/」「、」「。」；以及只在前後都是 ASCII 數字時保留的半形「,」「.」。
pub const INGREDIENT_SEPARATORS: &[&str] = &[
    "、", "，", ";", "；", "/", "／", "。", "\n", "\r\n", ",", ".", "､", "｡",
];
/// 空白：半形空格、Tab、全形空白 U+3000、U+FEFF（是 JS_Whitespace，不是 White_Space）與 U+0085（是 White_Space，
/// 不是 JS_Whitespace）。
pub const INGREDIENT_SPACES: &[&str] = &[" ", "  ", "\t", "\u{3000}", "\u{feff}", "\u{85}"];
/// 品項名稱中連接兩個食材的符號，例如「甜椒、玉米」。
pub const ITEM_NAME_JOINERS: &[&str] = &["、", "/", "，"];

/// 採買品項的數量與單位，0–40 字。
pub const SHOPPING_QUANTITIES: &[&str] = &["", "1 份", "數量待確認", "2 盒", "500g"];
/// 裝備名稱，1–100 字。
pub const GEAR_NAMES: &[&str] = &["帳篷", "睡袋", "頭燈", "卡式爐", "營燈", "折疊椅"];
/// 裝備的數量與單位，0–40 字。
pub const GEAR_QUANTITIES: &[&str] = &["", "1 頂", "每人 1 個"];

// ── 分帳 ──

/// 支出的項目名稱：NFC、1–100 字、沒有 Hidden_Control_Char。
pub const EXPENSE_TITLES: &[&str] = &["木炭", "超市採買", "營位費", "油錢", "牛肉片"];
/// 支出與還款的備註，0–500 字：可以有換行。
pub const LEDGER_NOTES: &[&str] = &["", "含停車費", "第一行\n第二行"];

/// 一個食材名稱：一半取自 [`COMMON_INGREDIENT_WORDS`]，一半取自全部的 [`INGREDIENT_WORDS`]。
pub fn arb_ingredient_word() -> impl Strategy<Value = &'static str> {
    prop_oneof![select(COMMON_INGREDIENT_WORDS), select(INGREDIENT_WORDS)]
}

/// 料理的食材文字：開頭可能有一段空白，接著 0–6 段「空白、名稱、空白、分隔符號」，每一部分都可能沒有。名稱是
/// [`arb_ingredient_word()`]、[`INGREDIENT_NUMBERS`] 的數字或空的；分隔符號是 [`INGREDIENT_SEPARATORS`] 的一到兩個，
/// 少數時候沒有，使相鄰的名稱連在一起；空白取自 [`INGREDIENT_SPACES`]。所以前後與中間都可能有各種空白與連續的分隔符號，
/// 同一個名稱或同一個 Ingredient_Key 的不同寫法常常出現不只一次；空字串、只有空白，以及只有分隔符號和空白的文字也會
/// 出現。
///
/// 每一段最多 17 字，所以整段最多 104 字（不超過 2000 字）。每一段最多為切出的名稱貢獻 12 字（空白收成一個、名稱
/// 最多 9 字、數字之間保留的「,」或「.」），開頭的 U+0085 再加 1 字，所以 Ingredient_Parser 切出的每個名稱最多
/// 73 字，不超過 100 字（需求 25.18）。
pub fn arb_ingredients() -> impl Strategy<Value = String> {
    let name = prop_oneof![
        6 => arb_ingredient_word(),
        1 => select(INGREDIENT_NUMBERS),
        1 => Just(""),
    ];
    let separator = prop_oneof![
        1 => Just(String::new()),
        6 => select(INGREDIENT_SEPARATORS).prop_map(str::to_owned),
        1 => (select(INGREDIENT_SEPARATORS), select(INGREDIENT_SEPARATORS))
            .prop_map(|(first, second)| format!("{first}{second}")),
    ];
    let entry =
        (arb_space(), name, arb_space(), separator).prop_map(|(before, name, after, separator)| {
            format!(
                "{}{name}{}{separator}",
                before.unwrap_or(""),
                after.unwrap_or("")
            )
        });
    (arb_space(), vec(entry, 0..=6))
        .prop_map(|(start, entries)| format!("{}{}", start.unwrap_or(""), entries.concat()))
}

/// 食材文字中可能出現的一段空白。
fn arb_space() -> impl Strategy<Value = Option<&'static str>> {
    option::weighted(0.3, select(INGREDIENT_SPACES))
}

/// 採買品項的名稱：[`arb_ingredient_word()`] 的一個名稱，或以 [`ITEM_NAME_JOINERS`] 連接的兩個（例如「甜椒、玉米」
/// 同時涵蓋兩個食材），前面可能有一段空白；再整理成兩種會被儲存的寫法之一：
///
/// - Trim_White 之後的文字，也就是手動新增的品項（需求 26.2）：保留中間的空白、全形字與開頭的 U+FEFF；
/// - Ingredient_Parser 切出的名稱以「、」串接，也就是採買同步新增的品項：NFKC，保留開頭的 U+0085。
///
/// 名稱一定不是空的，最多 21 個字。
pub fn arb_item_name() -> impl Strategy<Value = String> {
    (
        option::of(select(INGREDIENT_SPACES)),
        arb_ingredient_word(),
        option::weighted(0.25, (select(ITEM_NAME_JOINERS), arb_ingredient_word())),
        any::<bool>(),
    )
        .prop_map(|(space, first, second, parsed)| {
            let mut raw = format!("{}{first}", space.unwrap_or(""));
            if let Some((joiner, word)) = second {
                raw.push_str(joiner);
                raw.push_str(word);
            }
            if parsed {
                parse_ingredients(&raw).join("、")
            } else {
                trim_white(&raw).to_owned()
            }
        })
}
