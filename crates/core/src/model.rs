//! 資料型別：每一種列、列舉、`Row`、`Entity`、`RowKey` 與 `TripState`（design 1.2）。
//!
//! 快照、增量與推送都使用這裡的列格式（design「線上格式」）：每一列是欄位名稱與 Rust 相同的 JSON 物件，id 是
//! 小寫的 UUID 字串，日期是 `YYYY-MM-DD`，時刻是 `HH:MM`，集合是依 id 遞增排列的陣列，沒有設定的選填欄位是
//! `null`；`Row` 以 `{ "entity": …, "row": … }` 包住一列。列舉的值與 Enum_Table 及現行的字串相同，例如餐次與
//! 採買分類是中文。欄位的長度、範圍與數量上限見 `limits`，由命令的處理函式與 `validate` 檢查，型別本身不檢查。

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::de::{self, Unexpected, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use uuid::Uuid;

use crate::ids::{
    ActivityId, ExpenseId, GearId, MealId, PersonId, PlaceId, RouteId, SettlementId, ShoppingId,
    StopId, TripId, VehicleId,
};
use crate::time::Hm;

/// 沒有時區的日期（西元曆），線上格式為 `YYYY-MM-DD`。
pub type Date = time::Date;

/// 每趟旅行的提交序號（Seq），也是列的版本（Row_Version）：最後新增、修改或刪除這一列的 Seq。
pub type Seq = u64;

/// 以字串序列化的列舉。每個值的字串只寫一次，同時用於線上格式（serde）、`as_str()` 與 `parse()`；
/// `ALL` 與 `Ord` 都依宣告的順序，也就是 Enum_Table 的順序。
macro_rules! string_enum {
    (
        $(#[$meta:meta])*
        pub enum $name:ident {
            $($(#[$variant_meta:meta])* $variant:ident => $value:literal,)+
        }
    ) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        pub enum $name {
            $($(#[$variant_meta])* #[serde(rename = $value)] $variant,)+
        }

        impl $name {
            /// 每一個值，依 Enum_Table 的順序。
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            /// 線上格式與資料庫中的字串。
            pub const fn as_str(&self) -> &'static str {
                match self {
                    $(Self::$variant => $value,)+
                }
            }

            /// `as_str()` 的反向；不是這個列舉的字串時是 `None`。
            pub fn parse(text: &str) -> Option<Self> {
                Self::ALL.iter().copied().find(|value| value.as_str() == text)
            }
        }
    };
}

// ── 列舉（Enum_Table）──

string_enum! {
    /// 旅行封面。插畫與封面同名，只有 mountain 使用 travel 的插畫。
    pub enum CoverKind {
        Camp => "camp",
        Mountain => "mountain",
        Lake => "lake",
        Night => "night",
        Forest => "forest",
        Beach => "beach",
        Sunrise => "sunrise",
    }
}

string_enum! {
    /// 旅行狀態。
    pub enum TripStatus {
        /// 規劃中
        Planning => "planning",
        /// 已完成
        Completed => "completed",
    }
}

string_enum! {
    /// 旅伴顏色。新增旅伴時以新增前的人數除以 6 的餘數取色（需求 19.8），所以順序與現行 `COLORS` 相同。
    pub enum Color {
        Coral => "coral",
        Blue => "blue",
        Green => "green",
        Yellow => "yellow",
        Lavender => "lavender",
        Peach => "peach",
    }
}

string_enum! {
    /// 帳號角色（`app.profiles.role`）。
    pub enum Role {
        /// 管理員（Admin）：可以管理任何旅行
        Admin => "admin",
        /// 一般帳號
        Member => "member",
    }
}

string_enum! {
    /// 活動類別（Activity_Category，13 種）；註解是畫面與文字版使用的中文名稱。
    pub enum ActivityKind {
        /// 集合
        Meet => "meet",
        /// 採買
        Market => "market",
        /// 營地時光
        Camp => "camp",
        /// 用餐
        Meal => "meal",
        /// 夜晚
        Night => "night",
        /// 移動
        Travel => "travel",
        /// 起床
        Wake => "wake",
        /// 搭帳
        Pitch => "pitch",
        /// 自由活動
        Free => "free",
        /// 下午茶／遊戲
        Tea => "tea",
        /// 拆帳
        Strike => "strike",
        /// 清潔
        Clean => "clean",
        /// 返程
        Return => "return",
    }
}

string_enum! {
    /// 停靠點種類。
    pub enum StopKind {
        /// 採買
        Shop => "shop",
        /// 接送
        Pickup => "pickup",
        /// 取還裝備
        Gear => "gear",
        /// 其他
        Other => "other",
    }
}

string_enum! {
    /// 停靠點的任務類型；每一種屬於一種停靠點種類（Enum_Table 的「停靠點種類與任務」），依種類的順序排列。
    pub enum StopTask {
        /// 採買（shop 的預設任務）
        Shopping => "shopping",
        /// 接人（pickup 的預設任務）
        PassengerPickup => "passenger-pickup",
        /// 送人下車（pickup）
        PassengerDropoff => "passenger-dropoff",
        /// 領取租借裝備（gear 的預設任務）
        GearPickup => "gear-pickup",
        /// 歸還裝備（gear）
        GearReturn => "gear-return",
        /// 取租車（other）
        CarRental => "car-rental",
        /// 還車（other）
        CarReturn => "car-return",
        /// 一般停靠（other 的預設任務）
        Waypoint => "waypoint",
    }
}

string_enum! {
    /// 地點的繪本插圖（旅行繪本工作室的 `TEMPLATES`），依工作室的順序；`label()` 是選單中的名稱。
    pub enum PlaceTemplate {
        Home => "home",
        Market => "market",
        SevenEleven => "seven-eleven",
        FamilyMart => "familymart",
        OkMart => "okmart",
        PxmartMega => "pxmart-mega",
        Costco => "costco",
        Ikea => "ikea",
        Carrefour => "carrefour",
        Tent => "tent",
        Bell => "bell",
        Dome => "dome",
        Tarp => "tarp",
        Camper => "camper",
        Cabin => "cabin",
    }
}

impl PlaceTemplate {
    /// 工作室選單中的名稱。
    pub const fn label(self) -> &'static str {
        match self {
            Self::Home => "家／出發地",
            Self::Market => "超市／賣場",
            Self::SevenEleven => "7-ELEVEN",
            Self::FamilyMart => "全家 FamilyMart",
            Self::OkMart => "OK mart",
            Self::PxmartMega => "大全聯",
            Self::Costco => "Costco 好市多",
            Self::Ikea => "IKEA",
            Self::Carrefour => "家樂福 Carrefour",
            Self::Tent => "經典帳篷",
            Self::Bell => "鐘型帳",
            Self::Dome => "圓頂帳",
            Self::Tarp => "天幕野餐",
            Self::Camper => "露營車",
            Self::Cabin => "小木屋",
        }
    }
}

string_enum! {
    /// 這一天的 Itinerary_Text 中，路線在活動之前或之後；沒有設定時是 before。
    #[derive(Default)]
    pub enum RoutePosition {
        /// 路線在活動之前
        #[default]
        Before => "before",
        /// 路線在活動之後
        After => "after",
    }
}

string_enum! {
    /// 餐次，依一天中的順序（早餐 08:30、午餐 12:00、下午茶 15:00、晚餐 18:00、消夜 21:00 是各自的預設用餐時間）。
    pub enum MealSlot {
        Breakfast => "早餐",
        Lunch => "午餐",
        AfternoonTea => "下午茶",
        Dinner => "晚餐",
        LateNight => "消夜",
    }
}

string_enum! {
    /// 料理插圖種類（現行 `DISH_TYPES`）；註解是現行的名稱。
    pub enum DishKind {
        /// 壽喜燒／火鍋
        Hotpot => "hotpot",
        /// 烤肉串燒
        Bbq => "bbq",
        /// 熱壓吐司
        Toast => "toast",
        /// 咖哩飯
        Curry => "curry",
        /// 義大利麵
        Pasta => "pasta",
        /// 貝果早餐
        Breakfast => "breakfast",
        /// 蔬菜沙拉
        Salad => "salad",
        /// 通用餐盤（有 7 種變化）
        Custom => "custom",
    }
}

string_enum! {
    /// 採買分類（現行 `SHOPPING_CATEGORIES`）；採買清單依這個順序分組。
    pub enum Category {
        Meat => "肉類",
        Seafood => "海鮮",
        Vegetables => "蔬菜",
        Fruit => "水果",
        EggsDairy => "蛋奶",
        Soy => "豆製品",
        Staples => "主食",
        Seasoning => "調味料",
        Drinks => "飲料",
        Snacks => "零食",
        Other => "其他",
    }
}

string_enum! {
    /// 採買品項的來源。
    pub enum ItemSource {
        /// 由料理的食材產生（Meal_Item）
        Meal => "meal",
        /// 手動管理（Manual_Item）
        Manual => "manual",
    }
}

string_enum! {
    /// 裝備範圍。
    pub enum GearScope {
        /// 個人：每位旅伴各帶一份
        Personal => "personal",
        /// 共用：由一位負責人準備
        Shared => "shared",
    }
}

/// 支出分類（現行 `EXPENSE_CATEGORIES`，18 種）：食材、交通、住宿、其他、11 種「食材／{採買分類}」、露營耗材、
/// 露營裝備、日用品。「／」是全形斜線 U+FF0F。`ALL` 與 `Ord` 都依這個順序。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ExpenseCategory {
    /// 食材
    Food,
    /// 交通
    Transport,
    /// 住宿
    Lodging,
    /// 其他
    Other,
    /// 食材／{採買分類}，例如「食材／肉類」
    Groceries(Category),
    /// 露營耗材
    CampingSupplies,
    /// 露營裝備
    CampingGear,
    /// 日用品
    Household,
}

impl ExpenseCategory {
    /// 每一個值，依現行 `EXPENSE_CATEGORIES` 的順序。
    pub const ALL: &'static [Self] = &[
        Self::Food,
        Self::Transport,
        Self::Lodging,
        Self::Other,
        Self::Groceries(Category::Meat),
        Self::Groceries(Category::Seafood),
        Self::Groceries(Category::Vegetables),
        Self::Groceries(Category::Fruit),
        Self::Groceries(Category::EggsDairy),
        Self::Groceries(Category::Soy),
        Self::Groceries(Category::Staples),
        Self::Groceries(Category::Seasoning),
        Self::Groceries(Category::Drinks),
        Self::Groceries(Category::Snacks),
        Self::Groceries(Category::Other),
        Self::CampingSupplies,
        Self::CampingGear,
        Self::Household,
    ];

    /// 線上格式與資料庫中的字串。
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Food => "食材",
            Self::Transport => "交通",
            Self::Lodging => "住宿",
            Self::Other => "其他",
            Self::Groceries(category) => match category {
                Category::Meat => "食材／肉類",
                Category::Seafood => "食材／海鮮",
                Category::Vegetables => "食材／蔬菜",
                Category::Fruit => "食材／水果",
                Category::EggsDairy => "食材／蛋奶",
                Category::Soy => "食材／豆製品",
                Category::Staples => "食材／主食",
                Category::Seasoning => "食材／調味料",
                Category::Drinks => "食材／飲料",
                Category::Snacks => "食材／零食",
                Category::Other => "食材／其他",
            },
            Self::CampingSupplies => "露營耗材",
            Self::CampingGear => "露營裝備",
            Self::Household => "日用品",
        }
    }

    /// `as_str()` 的反向；不是支出分類的字串時是 `None`。
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|value| value.as_str() == text)
    }
}

impl Serialize for ExpenseCategory {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ExpenseCategory {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ExpenseCategoryVisitor;

        impl Visitor<'_> for ExpenseCategoryVisitor {
            type Value = ExpenseCategory;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("18 種支出分類之一")
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<ExpenseCategory, E> {
                ExpenseCategory::parse(value)
                    .ok_or_else(|| E::invalid_value(Unexpected::Str(value), &self))
            }
        }

        deserializer.deserialize_str(ExpenseCategoryVisitor)
    }
}

// ── 列 ──

/// Trip_Card：旅行資料（`app.trips` 中這趟旅行的那一列）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TripCard {
    pub id: TripId,
    /// 1–100 字，不含 U+0000。
    pub title: String,
    /// 0–100 字。
    pub destination: String,
    #[serde(with = "crate::time::iso_date")]
    pub start: Date,
    /// `start..=end` 含頭尾 1–31 天。
    #[serde(with = "crate::time::iso_date")]
    pub end: Date,
    /// 介紹，0–1000 字。
    pub description: String,
    /// 小叮嚀，0–1000 字。
    pub note: String,
    /// 繪本的大標題，0–80 字；空字串是未設定。不輸出到 Itinerary_Text。
    #[serde(default)]
    pub headline: String,
    /// 繪本的底部短語，0–150 字；空字串是未設定。不輸出到 Itinerary_Text。
    #[serde(default)]
    pub caption: String,
    pub cover: CoverKind,
    pub status: TripStatus,
    pub version: Seq,
}

/// 旅伴（Person）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Person {
    pub id: PersonId,
    /// Participant_Name 之後 1–30 字；Participant_Key 在這趟旅行中不重複。
    pub name: String,
    /// 小隊角色，0–60 字。
    pub role: String,
    pub color: Color,
    /// 是否綁定帳號（Bound_Person，由 `app.people.user_id` 推得；不送出帳號 id）。
    pub bound: bool,
    /// 建立順序（Ordinal）。
    pub ordinal: u64,
    pub version: Seq,
}

/// 車輛。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Vehicle {
    pub id: VehicleId,
    /// 車輛暱稱，1–50 字。
    pub name: String,
    pub driver: Option<PersonId>,
    /// 座位數 1–9，含駕駛。
    pub seats: u8,
    /// `#rrggbb`；沒有設定時依車輛的順序取 Car_Palette。
    pub color: Option<String>,
    /// 不含駕駛；人數加 1 不超過座位數。
    pub passengers: BTreeSet<PersonId>,
    pub ordinal: u64,
    pub version: Seq,
}

/// 地點清單中的地點。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Place {
    pub id: PlaceId,
    /// 1–50 字；Place_Key 在這趟旅行中不重複，也不等於非空白旅行目的地的 Place_Key。
    pub name: String,
    /// 繪本插圖；只在新增地點時選擇，沒有選擇時是 `None`。
    #[serde(default)]
    pub template: Option<PlaceTemplate>,
    pub ordinal: u64,
    pub version: Seq,
}

/// 路線端點與停靠點：地點清單中的地點，或旅行目的地（Destination_Place；資料庫存 NULL，取代現行的
/// `'@destination'`）。線上格式是 `{"kind":"destination"}` 或 `{"kind":"place","id":…}`。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum PlaceRef {
    Destination,
    Place(PlaceId),
}

/// 一台車在一個 Trip_Day 的路線，連同它的停靠點。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Route {
    pub id: RouteId,
    #[serde(with = "crate::time::iso_date")]
    pub day: Date,
    /// 每台車每天最多一條路線。
    pub vehicle: VehicleId,
    pub from: PlaceRef,
    pub to: PlaceRef,
    /// 出發時間，可以留空。
    pub depart: Option<Hm>,
    /// 0–6 個，依停靠的順序。
    pub stops: Vec<Stop>,
    pub ordinal: u64,
    pub version: Seq,
}

/// 路線上的停靠點；沒有自己的 Row_Version，變化使所屬路線的 Row_Version 前進。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stop {
    pub id: StopId,
    pub place: PlaceRef,
    pub kind: StopKind,
    /// 必須屬於 `kind`；沒有設定時使用該種類的預設任務，但不寫入。
    pub task: Option<StopTask>,
    /// 0–100 字。
    pub note: String,
    pub time: Option<Hm>,
    /// 待辦清單或旅伴名單：最多 8 項，每項 1–100 字。採買的停靠點一律是空的（品項由採買清單推得）。
    #[serde(default)]
    pub items: Vec<String>,
}

/// 一個 Trip_Day 的設定；以日期為鍵，每天最多一列。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DaySetting {
    #[serde(with = "crate::time::iso_date")]
    pub day: Date,
    /// 0–20 字；只有空白視為未設定。
    pub title: Option<String>,
    /// 地點清單中的地點；未設定時跟著旅行目的地。
    pub place: Option<PlaceId>,
    /// 預計抵達時間：由規劃者填寫，App 不計算。
    pub arrival: Option<Hm>,
    /// 繪本日卡的抵達說明（「抵達：…」），1–120 字；未設定時是 `None`。不輸出到 Itinerary_Text。
    #[serde(default)]
    pub arrival_label: Option<String>,
    pub route_position: RoutePosition,
    pub version: Seq,
}

/// 活動。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Activity {
    pub id: ActivityId,
    #[serde(with = "crate::time::iso_date")]
    pub day: Date,
    pub time: Hm,
    /// 1–100 字。
    pub title: String,
    pub kind: ActivityKind,
    /// 自由文字，0–150 字。
    pub location: String,
    /// 0–1000 字。
    pub note: String,
    pub done: bool,
    pub who: Participation,
    pub ordinal: u64,
    pub version: Seq,
}

/// 活動的參加者：全體旅伴、指定旅伴或指定車輛三者之一。指定旅伴與指定車輛都不會是空集合：命令的結果使指定的
/// 集合變成空的時改為 `Everyone`（需求 23.4、19.11）。線上格式是 `{"mode":"everyone"}`、
/// `{"mode":"people","ids":[…]}` 或 `{"mode":"vehicles","ids":[…]}`。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", content = "ids", rename_all = "snake_case")]
pub enum Participation {
    /// 全體旅伴，包括之後新增的旅伴。
    Everyone,
    People(BTreeSet<PersonId>),
    Vehicles(BTreeSet<VehicleId>),
}

/// 料理。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Meal {
    pub id: MealId,
    #[serde(with = "crate::time::iso_date")]
    pub day: Date,
    pub slot: MealSlot,
    /// 用餐時間；未設定時使用餐次的預設時間（不寫入）。
    pub time: Option<Hm>,
    /// 0–100 字。
    pub title: String,
    /// 負責人；`None` 是待分配。
    pub cook: Option<PersonId>,
    /// 1–100。
    pub servings: u8,
    /// 食材文字，採買同步的來源；0–2000 字。
    pub ingredients: String,
    /// 料理筆記，0–1000 字。
    pub notes: String,
    /// 插圖種類；未設定時由名稱與食材推斷。
    pub dish: Option<DishKind>,
    pub ordinal: u64,
    pub version: Seq,
}

/// 採買品項。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShoppingItem {
    pub id: ShoppingId,
    /// 1–100 字。
    pub name: String,
    /// 數量與單位，0–40 字。
    pub quantity: String,
    pub category: Category,
    /// 誰負責買；`None` 是待分配。
    pub assignee: Option<PersonId>,
    pub purchased: bool,
    pub source: ItemSource,
    /// 連動的料理；只由採買同步維護。
    pub meal_ids: BTreeSet<MealId>,
    /// 「料理已移除」；只由採買同步維護（現行 `recipeRemoved` 的三態）。
    pub recipe_removed: Option<bool>,
    pub ordinal: u64,
    pub version: Seq,
}

/// 裝備。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GearItem {
    pub id: GearId,
    /// 1–100 字。
    pub name: String,
    /// 數量與單位，0–40 字。
    pub quantity: String,
    pub scope: GearScope,
    /// 只有共用裝備可以有負責人。
    pub assignee: Option<PersonId>,
    /// 已打包的旅伴；共用裝備時只能是負責人。
    pub packed_by: BTreeSet<PersonId>,
    pub ordinal: u64,
    pub version: Seq,
}

/// 出發確認：只為已確認出發的旅伴各存一列，以旅伴 id 為鍵。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Departure {
    pub person: PersonId,
    pub version: Seq,
}

/// 支出（Ledger_Rows）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Expense {
    pub id: ExpenseId,
    #[serde(with = "crate::time::iso_date")]
    pub day: Date,
    /// 項目名稱，1–100 字。
    pub title: String,
    /// 以分計，1–100,000,000（NT$0.01–1,000,000）。
    pub amount_cents: i64,
    pub payer: PersonId,
    /// 1–100 位，平均分攤。
    pub participants: BTreeSet<PersonId>,
    pub category: ExpenseCategory,
    /// 0–500 字。
    pub note: String,
    /// 連結的採買品項。
    pub shopping_item: Option<ShoppingId>,
    pub ordinal: u64,
    pub version: Seq,
}

/// 還款（Ledger_Rows）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settlement {
    pub id: SettlementId,
    #[serde(with = "crate::time::iso_date")]
    pub day: Date,
    pub from: PersonId,
    /// 與 `from` 不同。
    pub to: PersonId,
    /// 以分計，與支出相同的範圍。
    pub amount_cents: i64,
    /// 0–500 字。
    pub note: String,
    pub ordinal: u64,
    pub version: Seq,
}

// ── Row、Entity、RowKey 與 Slot ──

string_enum! {
    /// 列的種類；也是 `Row` 線上格式中 `entity` 的值。`Ord` 依宣告的順序，所以 `Slot` 先依種類排序。
    pub enum Entity {
        /// Trip_Card；鍵是旅行 id
        Card => "card",
        Person => "person",
        Vehicle => "vehicle",
        Place => "place",
        Route => "route",
        /// 每日設定；鍵是日期
        DaySetting => "day_setting",
        Activity => "activity",
        Meal => "meal",
        Shopping => "shopping",
        Gear => "gear",
        /// 出發確認；鍵是旅伴 id
        Departure => "departure",
        Expense => "expense",
        Settlement => "settlement",
    }
}

/// 列的鍵：多數是列的 UUID；DaySetting 是日期；Departure 是旅伴 id；Card 是旅行 id。
/// 線上格式是 UUID 或日期的字串。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RowKey {
    Id(Uuid),
    Day(#[serde(with = "crate::time::iso_date")] Date),
}

impl RowKey {
    fn id(self) -> Option<Uuid> {
        match self {
            RowKey::Id(id) => Some(id),
            RowKey::Day(_) => None,
        }
    }

    fn day(self) -> Option<Date> {
        match self {
            RowKey::Day(day) => Some(day),
            RowKey::Id(_) => None,
        }
    }
}

/// 一列在整趟旅行中的位置。
pub type Slot = (Entity, RowKey);

/// 任何一種列。線上格式是 `{"entity": <Entity 的字串>, "row": <列的內容>}`。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "entity", content = "row", rename_all = "snake_case")]
pub enum Row {
    Card(TripCard),
    Person(Person),
    Vehicle(Vehicle),
    Place(Place),
    Route(Route),
    DaySetting(DaySetting),
    Activity(Activity),
    Meal(Meal),
    Shopping(ShoppingItem),
    Gear(GearItem),
    Departure(Departure),
    Expense(Expense),
    Settlement(Settlement),
}

/// 對每一種列執行同一段程式，`$row` 綁定列的內容。
macro_rules! each_row {
    ($value:expr, $row:ident => $body:expr) => {
        match $value {
            Row::Card($row) => $body,
            Row::Person($row) => $body,
            Row::Vehicle($row) => $body,
            Row::Place($row) => $body,
            Row::Route($row) => $body,
            Row::DaySetting($row) => $body,
            Row::Activity($row) => $body,
            Row::Meal($row) => $body,
            Row::Shopping($row) => $body,
            Row::Gear($row) => $body,
            Row::Departure($row) => $body,
            Row::Expense($row) => $body,
            Row::Settlement($row) => $body,
        }
    };
}

/// 有 ordinal 的列執行 `$body`（`$row` 綁定列的內容），Card、DaySetting 與 Departure 得到 `$none`。
macro_rules! ordinal_row {
    ($value:expr, $row:ident => $body:expr, $none:expr) => {
        match $value {
            Row::Person($row) => $body,
            Row::Vehicle($row) => $body,
            Row::Place($row) => $body,
            Row::Route($row) => $body,
            Row::Activity($row) => $body,
            Row::Meal($row) => $body,
            Row::Shopping($row) => $body,
            Row::Gear($row) => $body,
            Row::Expense($row) => $body,
            Row::Settlement($row) => $body,
            Row::Card(_) | Row::DaySetting(_) | Row::Departure(_) => $none,
        }
    };
}

impl Row {
    /// 這一列的種類與鍵。
    pub fn slot(&self) -> Slot {
        match self {
            Row::Card(row) => (Entity::Card, RowKey::Id(row.id.0)),
            Row::Person(row) => (Entity::Person, RowKey::Id(row.id.0)),
            Row::Vehicle(row) => (Entity::Vehicle, RowKey::Id(row.id.0)),
            Row::Place(row) => (Entity::Place, RowKey::Id(row.id.0)),
            Row::Route(row) => (Entity::Route, RowKey::Id(row.id.0)),
            Row::DaySetting(row) => (Entity::DaySetting, RowKey::Day(row.day)),
            Row::Activity(row) => (Entity::Activity, RowKey::Id(row.id.0)),
            Row::Meal(row) => (Entity::Meal, RowKey::Id(row.id.0)),
            Row::Shopping(row) => (Entity::Shopping, RowKey::Id(row.id.0)),
            Row::Gear(row) => (Entity::Gear, RowKey::Id(row.id.0)),
            Row::Departure(row) => (Entity::Departure, RowKey::Id(row.person.0)),
            Row::Expense(row) => (Entity::Expense, RowKey::Id(row.id.0)),
            Row::Settlement(row) => (Entity::Settlement, RowKey::Id(row.id.0)),
        }
    }

    /// Row_Version：最後修改這一列的 Seq。
    pub fn version(&self) -> Seq {
        each_row!(self, row => row.version)
    }

    /// 同一列，Row_Version 改為 `version`。
    pub fn with_version(mut self, version: Seq) -> Row {
        each_row!(&mut self, row => row.version = version);
        self
    }

    /// 建立順序（Ordinal）；Card、DaySetting 與 Departure 沒有 ordinal，是 `None`。
    pub fn ordinal(&self) -> Option<u64> {
        ordinal_row!(self, row => Some(row.ordinal), None)
    }

    /// Card、DaySetting 與 Departure 沒有 ordinal；其他列有。
    pub fn has_ordinal(&self) -> bool {
        self.ordinal().is_some()
    }

    /// 同一列，ordinal 改為 `ordinal`；沒有 ordinal 的列原樣回傳。
    pub fn with_ordinal(mut self, ordinal: u64) -> Row {
        ordinal_row!(&mut self, row => row.ordinal = ordinal, {});
        self
    }
}

// ── TripState ──

/// 一趟旅行的全部列（Trip_State）。`BTreeMap` 讓走訪順序固定；畫面順序另依 ordinal 或領域規則排序。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TripState {
    pub card: TripCard,
    pub people: BTreeMap<PersonId, Person>,
    pub vehicles: BTreeMap<VehicleId, Vehicle>,
    pub places: BTreeMap<PlaceId, Place>,
    pub routes: BTreeMap<RouteId, Route>,
    pub day_settings: BTreeMap<Date, DaySetting>,
    pub activities: BTreeMap<ActivityId, Activity>,
    pub meals: BTreeMap<MealId, Meal>,
    pub shopping: BTreeMap<ShoppingId, ShoppingItem>,
    pub gear: BTreeMap<GearId, GearItem>,
    /// 以旅伴 id 為鍵。
    pub departures: BTreeMap<PersonId, Departure>,
    pub expenses: BTreeMap<ExpenseId, Expense>,
    pub settlements: BTreeMap<SettlementId, Settlement>,
}

impl TripState {
    /// 只有 Trip_Card、還沒有其他列的旅行。
    pub fn new(card: TripCard) -> TripState {
        TripState {
            card,
            people: BTreeMap::new(),
            vehicles: BTreeMap::new(),
            places: BTreeMap::new(),
            routes: BTreeMap::new(),
            day_settings: BTreeMap::new(),
            activities: BTreeMap::new(),
            meals: BTreeMap::new(),
            shopping: BTreeMap::new(),
            gear: BTreeMap::new(),
            departures: BTreeMap::new(),
            expenses: BTreeMap::new(),
            settlements: BTreeMap::new(),
        }
    }

    /// `slot` 的列；沒有這一列，或鍵的種類不符（例如以 UUID 找每日設定）時是 `None`。
    pub fn get(&self, (entity, key): Slot) -> Option<Row> {
        let id = key.id();
        match entity {
            Entity::Card => {
                (key == RowKey::Id(self.card.id.0)).then(|| Row::Card(self.card.clone()))
            }
            Entity::Person => lookup(&self.people, id.map(PersonId), Row::Person),
            Entity::Vehicle => lookup(&self.vehicles, id.map(VehicleId), Row::Vehicle),
            Entity::Place => lookup(&self.places, id.map(PlaceId), Row::Place),
            Entity::Route => lookup(&self.routes, id.map(RouteId), Row::Route),
            Entity::DaySetting => lookup(&self.day_settings, key.day(), Row::DaySetting),
            Entity::Activity => lookup(&self.activities, id.map(ActivityId), Row::Activity),
            Entity::Meal => lookup(&self.meals, id.map(MealId), Row::Meal),
            Entity::Shopping => lookup(&self.shopping, id.map(ShoppingId), Row::Shopping),
            Entity::Gear => lookup(&self.gear, id.map(GearId), Row::Gear),
            Entity::Departure => lookup(&self.departures, id.map(PersonId), Row::Departure),
            Entity::Expense => lookup(&self.expenses, id.map(ExpenseId), Row::Expense),
            Entity::Settlement => lookup(&self.settlements, id.map(SettlementId), Row::Settlement),
        }
    }

    /// 新增 `row`，或取代 `row.slot()` 原本的列；Card 取代 Trip_Card。
    pub fn put(&mut self, row: Row) {
        match row {
            Row::Card(card) => self.card = card,
            Row::Person(row) => {
                self.people.insert(row.id, row);
            }
            Row::Vehicle(row) => {
                self.vehicles.insert(row.id, row);
            }
            Row::Place(row) => {
                self.places.insert(row.id, row);
            }
            Row::Route(row) => {
                self.routes.insert(row.id, row);
            }
            Row::DaySetting(row) => {
                self.day_settings.insert(row.day, row);
            }
            Row::Activity(row) => {
                self.activities.insert(row.id, row);
            }
            Row::Meal(row) => {
                self.meals.insert(row.id, row);
            }
            Row::Shopping(row) => {
                self.shopping.insert(row.id, row);
            }
            Row::Gear(row) => {
                self.gear.insert(row.id, row);
            }
            Row::Departure(row) => {
                self.departures.insert(row.person, row);
            }
            Row::Expense(row) => {
                self.expenses.insert(row.id, row);
            }
            Row::Settlement(row) => {
                self.settlements.insert(row.id, row);
            }
        }
    }

    /// 刪除 `slot` 的列並回傳它；沒有這一列，或鍵的種類不符時是 `None`。
    /// 每趟旅行一定有 Trip_Card，所以 Card 的 Slot 一律是 `None`，狀態不變。
    pub fn remove(&mut self, (entity, key): Slot) -> Option<Row> {
        let id = key.id();
        match entity {
            Entity::Card => None,
            Entity::Person => take(&mut self.people, id.map(PersonId), Row::Person),
            Entity::Vehicle => take(&mut self.vehicles, id.map(VehicleId), Row::Vehicle),
            Entity::Place => take(&mut self.places, id.map(PlaceId), Row::Place),
            Entity::Route => take(&mut self.routes, id.map(RouteId), Row::Route),
            Entity::DaySetting => take(&mut self.day_settings, key.day(), Row::DaySetting),
            Entity::Activity => take(&mut self.activities, id.map(ActivityId), Row::Activity),
            Entity::Meal => take(&mut self.meals, id.map(MealId), Row::Meal),
            Entity::Shopping => take(&mut self.shopping, id.map(ShoppingId), Row::Shopping),
            Entity::Gear => take(&mut self.gear, id.map(GearId), Row::Gear),
            Entity::Departure => take(&mut self.departures, id.map(PersonId), Row::Departure),
            Entity::Expense => take(&mut self.expenses, id.map(ExpenseId), Row::Expense),
            Entity::Settlement => {
                take(&mut self.settlements, id.map(SettlementId), Row::Settlement)
            }
        }
    }

    /// 每一列的 Slot，包括 Trip_Card；依 Slot 遞增，也就是先依 `Entity` 的順序，再依鍵。
    pub fn slots(&self) -> impl Iterator<Item = Slot> + '_ {
        std::iter::once((Entity::Card, RowKey::Id(self.card.id.0)))
            .chain(id_slots(Entity::Person, &self.people))
            .chain(id_slots(Entity::Vehicle, &self.vehicles))
            .chain(id_slots(Entity::Place, &self.places))
            .chain(id_slots(Entity::Route, &self.routes))
            .chain(
                self.day_settings
                    .keys()
                    .map(|&day| (Entity::DaySetting, RowKey::Day(day))),
            )
            .chain(id_slots(Entity::Activity, &self.activities))
            .chain(id_slots(Entity::Meal, &self.meals))
            .chain(id_slots(Entity::Shopping, &self.shopping))
            .chain(id_slots(Entity::Gear, &self.gear))
            .chain(id_slots(Entity::Departure, &self.departures))
            .chain(id_slots(Entity::Expense, &self.expenses))
            .chain(id_slots(Entity::Settlement, &self.settlements))
    }

    // 依 Ordinal 的走訪取代現行陣列的順序（例如哪台車是 Buyer_Car）；ordinal 相同時依 id。

    /// 旅伴，依 ordinal。
    pub fn people_by_ordinal(&self) -> impl Iterator<Item = &Person> {
        by_ordinal(&self.people, |row| row.ordinal)
    }

    /// 車輛，依 ordinal。
    pub fn vehicles_by_ordinal(&self) -> impl Iterator<Item = &Vehicle> {
        by_ordinal(&self.vehicles, |row| row.ordinal)
    }

    /// 地點，依 ordinal。
    pub fn places_by_ordinal(&self) -> impl Iterator<Item = &Place> {
        by_ordinal(&self.places, |row| row.ordinal)
    }

    /// 路線，依 ordinal（建立順序）。
    pub fn routes_by_ordinal(&self) -> impl Iterator<Item = &Route> {
        by_ordinal(&self.routes, |row| row.ordinal)
    }

    /// 活動，依 ordinal。
    pub fn activities_by_ordinal(&self) -> impl Iterator<Item = &Activity> {
        by_ordinal(&self.activities, |row| row.ordinal)
    }

    /// 料理，依 ordinal。
    pub fn meals_by_ordinal(&self) -> impl Iterator<Item = &Meal> {
        by_ordinal(&self.meals, |row| row.ordinal)
    }

    /// 採買品項，依 ordinal。
    pub fn shopping_by_ordinal(&self) -> impl Iterator<Item = &ShoppingItem> {
        by_ordinal(&self.shopping, |row| row.ordinal)
    }

    /// 裝備，依 ordinal。
    pub fn gear_by_ordinal(&self) -> impl Iterator<Item = &GearItem> {
        by_ordinal(&self.gear, |row| row.ordinal)
    }

    /// 支出，依 ordinal。
    pub fn expenses_by_ordinal(&self) -> impl Iterator<Item = &Expense> {
        by_ordinal(&self.expenses, |row| row.ordinal)
    }

    /// 還款，依 ordinal。
    pub fn settlements_by_ordinal(&self) -> impl Iterator<Item = &Settlement> {
        by_ordinal(&self.settlements, |row| row.ordinal)
    }

    /// 所有列中最大的 ordinal（沒有任何有 ordinal 的列時為 0）；新列的暫時 ordinal 從它加 1 開始（design 1.5）。
    pub fn max_ordinal(&self) -> u64 {
        [
            self.people.values().map(|row| row.ordinal).max(),
            self.vehicles.values().map(|row| row.ordinal).max(),
            self.places.values().map(|row| row.ordinal).max(),
            self.routes.values().map(|row| row.ordinal).max(),
            self.activities.values().map(|row| row.ordinal).max(),
            self.meals.values().map(|row| row.ordinal).max(),
            self.shopping.values().map(|row| row.ordinal).max(),
            self.gear.values().map(|row| row.ordinal).max(),
            self.expenses.values().map(|row| row.ordinal).max(),
            self.settlements.values().map(|row| row.ordinal).max(),
        ]
        .into_iter()
        .flatten()
        .max()
        .unwrap_or(0)
    }
}

/// `rows` 中鍵為 `key` 的列的複本；`key` 是 `None`（鍵的種類不符）時是 `None`。
fn lookup<K: Ord, V: Clone>(
    rows: &BTreeMap<K, V>,
    key: Option<K>,
    wrap: fn(V) -> Row,
) -> Option<Row> {
    rows.get(&key?).cloned().map(wrap)
}

/// 從 `rows` 刪除鍵為 `key` 的列並回傳它；`key` 是 `None`（鍵的種類不符）時不刪除。
fn take<K: Ord, V>(rows: &mut BTreeMap<K, V>, key: Option<K>, wrap: fn(V) -> Row) -> Option<Row> {
    rows.remove(&key?).map(wrap)
}

/// 以 UUID 為鍵的一種列的每個 Slot，依鍵遞增。
fn id_slots<K, V>(entity: Entity, rows: &BTreeMap<K, V>) -> impl Iterator<Item = Slot> + '_
where
    K: Copy + Into<Uuid>,
{
    rows.keys().map(move |&id| (entity, RowKey::Id(id.into())))
}

/// 依 `ordinal` 遞增走訪；ordinal 相同時保持 `BTreeMap` 的 id 順序（穩定排序）。
fn by_ordinal<K, V>(rows: &BTreeMap<K, V>, ordinal: fn(&V) -> u64) -> impl Iterator<Item = &V> {
    let mut sorted: Vec<&V> = rows.values().collect();
    sorted.sort_by_key(|row| ordinal(row));
    sorted.into_iter()
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;

    const TRIP: &str = "6f1c2a9e-0000-4000-8000-000000000001";
    const P1: &str = "5e0a4c12-0000-4000-8000-000000000001";
    const P2: &str = "5e0a4c12-0000-4000-8000-000000000002";
    const P3: &str = "5e0a4c12-0000-4000-8000-000000000003";
    const V1: &str = "7b2f9d40-0000-4000-8000-000000000001";
    const V2: &str = "7b2f9d40-0000-4000-8000-000000000002";
    const PL1: &str = "a4c8e1f2-0000-4000-8000-000000000001";
    const R1: &str = "c0ffee00-0000-4000-8000-000000000001";
    const S1: &str = "c0ffee00-0000-4000-8000-0000000000a1";
    const S2: &str = "c0ffee00-0000-4000-8000-0000000000a2";
    const A1: &str = "ac71e000-0000-4000-8000-000000000001";
    const A2: &str = "ac71e000-0000-4000-8000-000000000002";
    const A3: &str = "ac71e000-0000-4000-8000-000000000003";
    const M1: &str = "91d3e6b0-0000-4000-8000-000000000001";
    const M2: &str = "91d3e6b0-0000-4000-8000-000000000002";
    const SH1: &str = "3c51b8aa-0000-4000-8000-000000000001";
    const SH2: &str = "3c51b8aa-0000-4000-8000-000000000002";
    const G1: &str = "9ea70000-0000-4000-8000-000000000001";
    const G2: &str = "9ea70000-0000-4000-8000-000000000002";
    const E1: &str = "e0000000-0000-4000-8000-000000000001";
    const E2: &str = "e0000000-0000-4000-8000-000000000002";
    const ST1: &str = "5e771e00-0000-4000-8000-000000000001";

    fn uuid(text: &str) -> Uuid {
        Uuid::parse_str(text).expect("有效的 UUID")
    }

    fn day(text: &str) -> Date {
        crate::time::parse_date(text).expect("有效的日期")
    }

    fn hm(hour: u8, minute: u8) -> Hm {
        Hm::new(hour, minute).expect("有效的時刻")
    }

    fn person_id(text: &str) -> PersonId {
        PersonId(uuid(text))
    }

    fn card() -> TripCard {
        TripCard {
            id: TripId(uuid(TRIP)),
            title: "雲海裡，住一晚".to_owned(),
            destination: "山間小日子營地".to_owned(),
            start: day("2026-11-20"),
            end: day("2026-11-22"),
            description: "一起煮飯、一起看星星。".to_owned(),
            note: String::new(),
            cover: CoverKind::Mountain,
            status: TripStatus::Planning,
            version: 0,
            caption: String::new(),
            headline: String::new(),
        }
    }

    fn vehicle() -> Vehicle {
        Vehicle {
            id: VehicleId(uuid(V1)),
            name: "山線小巴".to_owned(),
            driver: Some(person_id(P2)),
            seats: 4,
            color: None,
            passengers: [person_id(P3), person_id(P1)].into(),
            ordinal: 6,
            version: 3,
        }
    }

    fn place() -> Place {
        Place {
            id: PlaceId(uuid(PL1)),
            name: "山下超市".to_owned(),
            ordinal: 8,
            version: 5,
            template: None,
        }
    }

    fn day_setting() -> DaySetting {
        DaySetting {
            day: day("2026-11-21"),
            title: Some("森林小徑".to_owned()),
            place: Some(PlaceId(uuid(PL1))),
            arrival: Some(hm(12, 0)),
            route_position: RoutePosition::After,
            version: 8,
            arrival_label: None,
        }
    }

    fn departure() -> Departure {
        Departure {
            person: person_id(P2),
            version: 16,
        }
    }

    /// 每一種列各一到三個例子，連同它的線上格式。
    fn examples() -> Vec<(Row, Value)> {
        vec![
            (
                Row::Card(card()),
                json!({
                    "entity": "card",
                    "row": {
                        "id": TRIP, "title": "雲海裡，住一晚", "destination": "山間小日子營地",
                        "start": "2026-11-20", "end": "2026-11-22",
                        "description": "一起煮飯、一起看星星。", "note": "",
                        "headline": "", "caption": "",
                        "cover": "mountain", "status": "planning", "version": 0
                    }
                }),
            ),
            (
                Row::Person(Person {
                    id: person_id(P1),
                    name: "小安".to_owned(),
                    role: "這趟的召集人".to_owned(),
                    color: Color::Coral,
                    bound: true,
                    ordinal: 0,
                    version: 0,
                }),
                json!({
                    "entity": "person",
                    "row": {
                        "id": P1, "name": "小安", "role": "這趟的召集人", "color": "coral",
                        "bound": true, "ordinal": 0, "version": 0
                    }
                }),
            ),
            (
                Row::Person(Person {
                    id: person_id(P2),
                    name: "阿哲".to_owned(),
                    role: String::new(),
                    color: Color::Blue,
                    bound: false,
                    ordinal: 1,
                    version: 2,
                }),
                json!({
                    "entity": "person",
                    "row": {
                        "id": P2, "name": "阿哲", "role": "", "color": "blue",
                        "bound": false, "ordinal": 1, "version": 2
                    }
                }),
            ),
            (
                Row::Vehicle(vehicle()),
                json!({
                    "entity": "vehicle",
                    "row": {
                        "id": V1, "name": "山線小巴", "driver": P2, "seats": 4, "color": null,
                        "passengers": [P1, P3], "ordinal": 6, "version": 3
                    }
                }),
            ),
            (
                Row::Vehicle(Vehicle {
                    id: VehicleId(uuid(V2)),
                    name: "海風號".to_owned(),
                    driver: None,
                    seats: 1,
                    color: Some("#efa28f".to_owned()),
                    passengers: BTreeSet::new(),
                    ordinal: 7,
                    version: 4,
                }),
                json!({
                    "entity": "vehicle",
                    "row": {
                        "id": V2, "name": "海風號", "driver": null, "seats": 1, "color": "#efa28f",
                        "passengers": [], "ordinal": 7, "version": 4
                    }
                }),
            ),
            (
                Row::Place(place()),
                json!({
                    "entity": "place",
                    "row": {
                        "id": PL1, "name": "山下超市", "template": null, "ordinal": 8, "version": 5
                    }
                }),
            ),
            (
                Row::Route(Route {
                    id: RouteId(uuid(R1)),
                    day: day("2026-11-20"),
                    vehicle: VehicleId(uuid(V1)),
                    from: PlaceRef::Place(PlaceId(uuid(PL1))),
                    to: PlaceRef::Destination,
                    depart: Some(hm(8, 30)),
                    stops: vec![
                        Stop {
                            id: StopId(uuid(S1)),
                            place: PlaceRef::Place(PlaceId(uuid(PL1))),
                            kind: StopKind::Shop,
                            task: None,
                            note: "記得買冰塊".to_owned(),
                            time: Some(hm(9, 15)),
                            items: Vec::new(),
                        },
                        Stop {
                            id: StopId(uuid(S2)),
                            place: PlaceRef::Destination,
                            kind: StopKind::Pickup,
                            task: Some(StopTask::PassengerDropoff),
                            note: String::new(),
                            time: None,
                            items: vec!["小安".to_owned(), "阿哲".to_owned()],
                        },
                    ],
                    ordinal: 9,
                    version: 7,
                }),
                json!({
                    "entity": "route",
                    "row": {
                        "id": R1, "day": "2026-11-20", "vehicle": V1,
                        "from": { "kind": "place", "id": PL1 }, "to": { "kind": "destination" },
                        "depart": "08:30",
                        "stops": [
                            {
                                "id": S1, "place": { "kind": "place", "id": PL1 }, "kind": "shop",
                                "task": null, "note": "記得買冰塊", "time": "09:15", "items": []
                            },
                            {
                                "id": S2, "place": { "kind": "destination" }, "kind": "pickup",
                                "task": "passenger-dropoff", "note": "", "time": null,
                                "items": ["小安", "阿哲"]
                            }
                        ],
                        "ordinal": 9, "version": 7
                    }
                }),
            ),
            (
                Row::DaySetting(day_setting()),
                json!({
                    "entity": "day_setting",
                    "row": {
                        "day": "2026-11-21", "title": "森林小徑", "place": PL1, "arrival": "12:00",
                        "arrival_label": null, "route_position": "after", "version": 8
                    }
                }),
            ),
            (
                Row::DaySetting(DaySetting {
                    day: day("2026-11-22"),
                    title: None,
                    place: None,
                    arrival: Some(hm(17, 30)),
                    arrival_label: Some("營地 14:00 可進場".to_owned()),
                    route_position: RoutePosition::Before,
                    version: 9,
                }),
                json!({
                    "entity": "day_setting",
                    "row": {
                        "day": "2026-11-22", "title": null, "place": null, "arrival": "17:30",
                        "arrival_label": "營地 14:00 可進場", "route_position": "before",
                        "version": 9
                    }
                }),
            ),
            (
                Row::Activity(Activity {
                    id: ActivityId(uuid(A1)),
                    day: day("2026-11-20"),
                    time: hm(14, 0),
                    title: "城市集合，把日常暫停".to_owned(),
                    kind: ActivityKind::Meet,
                    location: "台北車站東三門".to_owned(),
                    note: "先吃飽再集合。".to_owned(),
                    done: false,
                    who: Participation::Everyone,
                    ordinal: 12,
                    version: 10,
                }),
                json!({
                    "entity": "activity",
                    "row": {
                        "id": A1, "day": "2026-11-20", "time": "14:00", "title": "城市集合，把日常暫停",
                        "kind": "meet", "location": "台北車站東三門", "note": "先吃飽再集合。",
                        "done": false, "who": { "mode": "everyone" }, "ordinal": 12, "version": 10
                    }
                }),
            ),
            (
                Row::Activity(Activity {
                    id: ActivityId(uuid(A2)),
                    day: day("2026-11-21"),
                    time: hm(10, 0),
                    title: "走一段森林小徑".to_owned(),
                    kind: ActivityKind::Free,
                    location: String::new(),
                    note: String::new(),
                    done: true,
                    who: Participation::People([person_id(P2), person_id(P1)].into()),
                    ordinal: 10,
                    version: 11,
                }),
                json!({
                    "entity": "activity",
                    "row": {
                        "id": A2, "day": "2026-11-21", "time": "10:00", "title": "走一段森林小徑",
                        "kind": "free", "location": "", "note": "", "done": true,
                        "who": { "mode": "people", "ids": [P1, P2] }, "ordinal": 10, "version": 11
                    }
                }),
            ),
            (
                Row::Activity(Activity {
                    id: ActivityId(uuid(A3)),
                    day: day("2026-11-22"),
                    time: hm(12, 0),
                    title: "集合、返程".to_owned(),
                    kind: ActivityKind::Return,
                    location: String::new(),
                    note: "第一行\n第二行".to_owned(),
                    done: false,
                    who: Participation::Vehicles([VehicleId(uuid(V1))].into()),
                    ordinal: 11,
                    version: 12,
                }),
                json!({
                    "entity": "activity",
                    "row": {
                        "id": A3, "day": "2026-11-22", "time": "12:00", "title": "集合、返程",
                        "kind": "return", "location": "", "note": "第一行\n第二行", "done": false,
                        "who": { "mode": "vehicles", "ids": [V1] }, "ordinal": 11, "version": 12
                    }
                }),
            ),
            (
                Row::Meal(Meal {
                    id: MealId(uuid(M1)),
                    day: day("2026-11-20"),
                    slot: MealSlot::Dinner,
                    time: None,
                    title: "暖暖壽喜燒".to_owned(),
                    cook: Some(person_id(P3)),
                    servings: 6,
                    ingredients: "牛肉片、板豆腐、高麗菜".to_owned(),
                    notes: "先煎洋蔥，再加入醬汁。".to_owned(),
                    dish: Some(DishKind::Hotpot),
                    ordinal: 13,
                    version: 13,
                }),
                json!({
                    "entity": "meal",
                    "row": {
                        "id": M1, "day": "2026-11-20", "slot": "晚餐", "time": null,
                        "title": "暖暖壽喜燒", "cook": P3, "servings": 6,
                        "ingredients": "牛肉片、板豆腐、高麗菜", "notes": "先煎洋蔥，再加入醬汁。",
                        "dish": "hotpot", "ordinal": 13, "version": 13
                    }
                }),
            ),
            (
                Row::Meal(Meal {
                    id: MealId(uuid(M2)),
                    day: day("2026-11-21"),
                    slot: MealSlot::LateNight,
                    time: Some(hm(21, 30)),
                    title: String::new(),
                    cook: None,
                    servings: 1,
                    ingredients: String::new(),
                    notes: String::new(),
                    dish: None,
                    ordinal: 14,
                    version: 14,
                }),
                json!({
                    "entity": "meal",
                    "row": {
                        "id": M2, "day": "2026-11-21", "slot": "消夜", "time": "21:30", "title": "",
                        "cook": null, "servings": 1, "ingredients": "", "notes": "", "dish": null,
                        "ordinal": 14, "version": 14
                    }
                }),
            ),
            // design「線上格式」的例子：seq 42 勾選已買的採買品項
            (
                Row::Shopping(ShoppingItem {
                    id: ShoppingId(uuid(SH1)),
                    name: "牛肉片".to_owned(),
                    quantity: "2 盒".to_owned(),
                    category: Category::Meat,
                    assignee: Some(person_id(P3)),
                    purchased: true,
                    source: ItemSource::Meal,
                    meal_ids: [MealId(uuid(M1))].into(),
                    recipe_removed: None,
                    ordinal: 17,
                    version: 42,
                }),
                json!({
                    "entity": "shopping",
                    "row": {
                        "id": SH1, "name": "牛肉片", "quantity": "2 盒", "category": "肉類",
                        "assignee": P3, "purchased": true, "source": "meal",
                        "meal_ids": [M1], "recipe_removed": null, "ordinal": 17, "version": 42
                    }
                }),
            ),
            (
                Row::Shopping(ShoppingItem {
                    id: ShoppingId(uuid(SH2)),
                    name: "冰塊".to_owned(),
                    quantity: String::new(),
                    category: Category::Other,
                    assignee: None,
                    purchased: false,
                    source: ItemSource::Manual,
                    meal_ids: BTreeSet::new(),
                    recipe_removed: Some(true),
                    ordinal: 18,
                    version: 15,
                }),
                json!({
                    "entity": "shopping",
                    "row": {
                        "id": SH2, "name": "冰塊", "quantity": "", "category": "其他",
                        "assignee": null, "purchased": false, "source": "manual",
                        "meal_ids": [], "recipe_removed": true, "ordinal": 18, "version": 15
                    }
                }),
            ),
            (
                Row::Gear(GearItem {
                    id: GearId(uuid(G1)),
                    name: "手沖咖啡組".to_owned(),
                    quantity: "1 組".to_owned(),
                    scope: GearScope::Shared,
                    assignee: Some(person_id(P2)),
                    packed_by: [person_id(P2)].into(),
                    ordinal: 15,
                    version: 16,
                }),
                json!({
                    "entity": "gear",
                    "row": {
                        "id": G1, "name": "手沖咖啡組", "quantity": "1 組", "scope": "shared",
                        "assignee": P2, "packed_by": [P2], "ordinal": 15, "version": 16
                    }
                }),
            ),
            (
                Row::Gear(GearItem {
                    id: GearId(uuid(G2)),
                    name: "睡袋".to_owned(),
                    quantity: "1 個".to_owned(),
                    scope: GearScope::Personal,
                    assignee: None,
                    packed_by: [person_id(P3), person_id(P1)].into(),
                    ordinal: 16,
                    version: 17,
                }),
                json!({
                    "entity": "gear",
                    "row": {
                        "id": G2, "name": "睡袋", "quantity": "1 個", "scope": "personal",
                        "assignee": null, "packed_by": [P1, P3], "ordinal": 16, "version": 17
                    }
                }),
            ),
            (
                Row::Departure(departure()),
                json!({ "entity": "departure", "row": { "person": P2, "version": 16 } }),
            ),
            (
                Row::Expense(Expense {
                    id: ExpenseId(uuid(E1)),
                    day: day("2026-11-20"),
                    title: "超市採買".to_owned(),
                    amount_cents: 123_456,
                    payer: person_id(P1),
                    participants: [person_id(P3), person_id(P1), person_id(P2)].into(),
                    category: ExpenseCategory::Groceries(Category::Meat),
                    note: String::new(),
                    shopping_item: Some(ShoppingId(uuid(SH1))),
                    ordinal: 19,
                    version: 18,
                }),
                json!({
                    "entity": "expense",
                    "row": {
                        "id": E1, "day": "2026-11-20", "title": "超市採買", "amount_cents": 123_456,
                        "payer": P1, "participants": [P1, P2, P3], "category": "食材／肉類",
                        "note": "", "shopping_item": SH1, "ordinal": 19, "version": 18
                    }
                }),
            ),
            (
                Row::Expense(Expense {
                    id: ExpenseId(uuid(E2)),
                    day: day("2026-11-22"),
                    title: "油錢".to_owned(),
                    amount_cents: 100_000_000,
                    payer: person_id(P2),
                    participants: [person_id(P2)].into(),
                    category: ExpenseCategory::Transport,
                    note: "回程加滿".to_owned(),
                    shopping_item: None,
                    ordinal: 20,
                    version: 19,
                }),
                json!({
                    "entity": "expense",
                    "row": {
                        "id": E2, "day": "2026-11-22", "title": "油錢", "amount_cents": 100_000_000,
                        "payer": P2, "participants": [P2], "category": "交通",
                        "note": "回程加滿", "shopping_item": null, "ordinal": 20, "version": 19
                    }
                }),
            ),
            (
                Row::Settlement(Settlement {
                    id: SettlementId(uuid(ST1)),
                    day: day("2026-11-22"),
                    from: person_id(P2),
                    to: person_id(P1),
                    amount_cents: 41_152,
                    note: "現金".to_owned(),
                    ordinal: 21,
                    version: 20,
                }),
                json!({
                    "entity": "settlement",
                    "row": {
                        "id": ST1, "day": "2026-11-22", "from": P2, "to": P1, "amount_cents": 41_152,
                        "note": "現金", "ordinal": 21, "version": 20
                    }
                }),
            ),
        ]
    }

    /// 每一列都放進只有 Trip_Card 的旅行。
    fn full_state() -> TripState {
        let mut state = TripState::new(card());
        for (row, _) in examples() {
            state.put(row);
        }
        state
    }

    #[test]
    fn every_kind_of_row_matches_the_wire_format() {
        let mut entities = BTreeSet::new();
        for (row, wire) in examples() {
            assert_eq!(
                serde_json::to_value(&row).expect("可以序列化"),
                wire,
                "{:?}",
                row.slot()
            );
            assert_eq!(
                serde_json::from_value::<Row>(wire.clone()).expect("可以解析"),
                row
            );
            let text = serde_json::to_string(&row).expect("可以序列化");
            assert_eq!(serde_json::from_str::<Row>(&text).expect("可以解析"), row);
            // entity 的值就是 Entity 的字串
            assert_eq!(wire["entity"], row.slot().0.as_str());
            entities.insert(row.slot().0);
        }
        assert_eq!(entities.len(), Entity::ALL.len(), "每一種列都有例子");
    }

    #[test]
    fn rows_parse_in_jsonb_key_order() {
        // PostgreSQL 的 jsonb 把較短的鍵排在前面：row 在 entity 之前、id 在 kind 之前、ids 在 mode 之前
        let text = r#"{"row": {"id": "{a2}", "day": "2026-11-21", "who": {"ids": ["{p2}", "{p1}"], "mode": "people"},
            "done": true, "kind": "free", "note": "", "time": "10:00", "title": "走一段森林小徑", "ordinal": 10,
            "version": 11, "location": ""}, "entity": "activity"}"#
            .replace("{a2}", A2)
            .replace("{p1}", P1)
            .replace("{p2}", P2);
        let row: Row = serde_json::from_str(&text).expect("可以解析");
        let expected = examples()
            .into_iter()
            .map(|(row, _)| row)
            .find(|row| row.slot() == (Entity::Activity, RowKey::Id(uuid(A2))))
            .expect("有這個例子");
        assert_eq!(row, expected);

        let place: PlaceRef =
            serde_json::from_str(&r#"{"id": "{pl1}", "kind": "place"}"#.replace("{pl1}", PL1))
                .expect("可以解析");
        assert_eq!(place, PlaceRef::Place(PlaceId(uuid(PL1))));
    }

    #[test]
    fn place_refs_and_participation_are_tagged_objects() {
        assert_eq!(
            serde_json::to_value(PlaceRef::Destination).expect("可以序列化"),
            json!({ "kind": "destination" })
        );
        assert_eq!(
            serde_json::to_value(PlaceRef::Place(PlaceId(uuid(PL1)))).expect("可以序列化"),
            json!({ "kind": "place", "id": PL1 })
        );
        assert_eq!(
            serde_json::to_value(Participation::Everyone).expect("可以序列化"),
            json!({ "mode": "everyone" })
        );
        assert_eq!(
            serde_json::to_value(Participation::People([person_id(P3), person_id(P1)].into()))
                .expect("可以序列化"),
            json!({ "mode": "people", "ids": [P1, P3] })
        );
        assert_eq!(
            serde_json::to_value(Participation::Vehicles([VehicleId(uuid(V2))].into()))
                .expect("可以序列化"),
            json!({ "mode": "vehicles", "ids": [V2] })
        );
        for invalid in [
            json!({ "kind": "place" }),
            json!({ "kind": "home" }),
            json!("@destination"),
        ] {
            assert!(
                serde_json::from_value::<PlaceRef>(invalid.clone()).is_err(),
                "{invalid}"
            );
        }
        assert!(serde_json::from_value::<Participation>(json!({ "mode": "all" })).is_err());
    }

    #[test]
    fn row_keys_are_uuid_or_date_strings() {
        let id = RowKey::Id(uuid(P1));
        let date = RowKey::Day(day("2026-11-21"));
        assert_eq!(serde_json::to_value(id).expect("可以序列化"), json!(P1));
        assert_eq!(
            serde_json::to_value(date).expect("可以序列化"),
            json!("2026-11-21")
        );
        assert_eq!(
            serde_json::from_value::<RowKey>(json!(P1)).expect("可以解析"),
            id
        );
        assert_eq!(
            serde_json::from_value::<RowKey>(json!("2026-11-21")).expect("可以解析"),
            date
        );
        for invalid in [json!("p1"), json!("2026-02-30"), json!(1)] {
            assert!(
                serde_json::from_value::<RowKey>(invalid.clone()).is_err(),
                "{invalid}"
            );
        }
        // Slot 先依 Entity 的宣告順序，再依鍵
        assert!((Entity::Card, date) < (Entity::Person, id));
        assert!((Entity::DaySetting, id) < (Entity::DaySetting, date));
    }

    #[test]
    fn rows_report_their_slot_version_and_ordinal() {
        assert_eq!(
            Row::Card(card()).slot(),
            (Entity::Card, RowKey::Id(uuid(TRIP)))
        );
        assert_eq!(
            Row::DaySetting(day_setting()).slot(),
            (Entity::DaySetting, RowKey::Day(day("2026-11-21")))
        );
        assert_eq!(
            Row::Departure(departure()).slot(),
            (Entity::Departure, RowKey::Id(uuid(P2)))
        );
        for (row, _) in examples() {
            let slot = row.slot();
            let bumped = row.clone().with_version(99);
            assert_eq!(bumped.version(), 99, "{slot:?}");
            assert_eq!(bumped.slot(), slot);
            assert_eq!(bumped.ordinal(), row.ordinal());

            let has_ordinal = !matches!(
                slot.0,
                Entity::Card | Entity::DaySetting | Entity::Departure
            );
            assert_eq!(row.has_ordinal(), has_ordinal, "{slot:?}");
            let moved = row.clone().with_ordinal(500);
            if has_ordinal {
                assert_eq!(moved.ordinal(), Some(500), "{slot:?}");
                assert_eq!(
                    moved
                        .clone()
                        .with_ordinal(row.ordinal().expect("有 ordinal")),
                    row
                );
            } else {
                assert_eq!(moved.ordinal(), None);
                assert_eq!(moved, row);
            }
            assert_eq!(moved.version(), row.version());
        }
    }

    #[test]
    fn new_state_has_only_the_trip_card() {
        let state = TripState::new(card());
        let card_slot = (Entity::Card, RowKey::Id(uuid(TRIP)));
        assert_eq!(state.slots().collect::<Vec<_>>(), [card_slot]);
        assert_eq!(state.get(card_slot), Some(Row::Card(card())));
        assert_eq!(state.max_ordinal(), 0);
    }

    #[test]
    fn put_get_and_remove_every_kind_of_row() {
        let mut state = TripState::new(card());
        for (row, _) in examples() {
            let slot = row.slot();
            state.put(row.clone());
            assert_eq!(state.get(slot), Some(row), "{slot:?}");
        }
        // 每一列恰好一次，依 Slot 遞增
        let mut expected: Vec<Slot> = examples().iter().map(|(row, _)| row.slot()).collect();
        expected.sort();
        assert_eq!(state.slots().collect::<Vec<_>>(), expected);

        for (row, _) in examples() {
            let slot = row.slot();
            if slot.0 == Entity::Card {
                // 每趟旅行一定有 Trip_Card
                assert_eq!(state.remove(slot), None);
                assert_eq!(state.get(slot), Some(row));
            } else {
                assert_eq!(state.remove(slot), Some(row), "{slot:?}");
                assert_eq!(state.get(slot), None, "{slot:?}");
                assert_eq!(state.remove(slot), None, "{slot:?}");
            }
        }
        assert_eq!(state, TripState::new(card()));
    }

    #[test]
    fn put_replaces_the_row_in_the_same_slot() {
        let mut state = full_state();
        let renamed = Place {
            name: "山腳超市".to_owned(),
            version: 30,
            ..place()
        };
        state.put(Row::Place(renamed.clone()));
        assert_eq!(state.places.len(), 1);
        assert_eq!(
            state.get(Row::Place(place()).slot()),
            Some(Row::Place(renamed))
        );

        let retitled = TripCard {
            title: "改名的旅行".to_owned(),
            ..card()
        };
        state.put(Row::Card(retitled.clone()));
        assert_eq!(state.card, retitled);
    }

    #[test]
    fn keys_of_another_kind_find_nothing() {
        let mut state = full_state();
        let before = state.clone();
        for slot in [
            (Entity::DaySetting, RowKey::Id(uuid(P1))),
            (Entity::Person, RowKey::Day(day("2026-11-21"))),
            (Entity::Card, RowKey::Id(uuid(P1))),
            (Entity::Card, RowKey::Day(day("2026-11-20"))),
            // 旅伴的 id 不是車輛的 id；出發確認以旅伴 id 為鍵
            (Entity::Vehicle, RowKey::Id(uuid(P1))),
            (Entity::Departure, RowKey::Id(uuid(P1))),
        ] {
            assert_eq!(state.get(slot), None, "{slot:?}");
            assert_eq!(state.remove(slot), None, "{slot:?}");
        }
        assert_eq!(state, before);
    }

    #[test]
    fn rows_are_walked_in_ordinal_order() {
        let mut state = TripState::new(card());
        // id 的順序與 ordinal 不同；ordinal 相同時依 id
        for (n, ordinal) in [(1, 30), (2, 10), (3, 20), (4, 10)] {
            state.put(Row::Vehicle(Vehicle {
                id: VehicleId(Uuid::from_u128(n)),
                ordinal,
                ..vehicle()
            }));
        }
        let order: Vec<u128> = state
            .vehicles_by_ordinal()
            .map(|row| row.id.0.as_u128())
            .collect();
        assert_eq!(order, [2, 4, 3, 1]);

        // 例子中的活動：A1 的 ordinal 是 12、A2 是 10、A3 是 11
        let state = full_state();
        let activities: Vec<Uuid> = state.activities_by_ordinal().map(|row| row.id.0).collect();
        assert_eq!(activities, [uuid(A2), uuid(A3), uuid(A1)]);

        fn sorted<'a, T: 'a>(
            rows: impl Iterator<Item = &'a T>,
            ordinal: fn(&T) -> u64,
        ) -> Vec<u64> {
            let ordinals: Vec<u64> = rows.map(ordinal).collect();
            assert!(
                ordinals.windows(2).all(|pair| pair[0] <= pair[1]),
                "{ordinals:?}"
            );
            ordinals
        }
        assert_eq!(sorted(state.people_by_ordinal(), |row| row.ordinal), [0, 1]);
        assert_eq!(
            sorted(state.vehicles_by_ordinal(), |row| row.ordinal),
            [6, 7]
        );
        assert_eq!(sorted(state.places_by_ordinal(), |row| row.ordinal), [8]);
        assert_eq!(sorted(state.routes_by_ordinal(), |row| row.ordinal), [9]);
        assert_eq!(
            sorted(state.activities_by_ordinal(), |row| row.ordinal),
            [10, 11, 12]
        );
        assert_eq!(
            sorted(state.meals_by_ordinal(), |row| row.ordinal),
            [13, 14]
        );
        assert_eq!(
            sorted(state.shopping_by_ordinal(), |row| row.ordinal),
            [17, 18]
        );
        assert_eq!(sorted(state.gear_by_ordinal(), |row| row.ordinal), [15, 16]);
        assert_eq!(
            sorted(state.expenses_by_ordinal(), |row| row.ordinal),
            [19, 20]
        );
        assert_eq!(
            sorted(state.settlements_by_ordinal(), |row| row.ordinal),
            [21]
        );
    }

    #[test]
    fn max_ordinal_covers_every_kind_of_row_with_an_ordinal() {
        assert_eq!(full_state().max_ordinal(), 21);
        for (row, _) in examples() {
            let mut state = TripState::new(card());
            let has_ordinal = row.has_ordinal();
            state.put(row.clone().with_ordinal(1000));
            let expected = if has_ordinal { 1000 } else { 0 };
            assert_eq!(state.max_ordinal(), expected, "{:?}", row.slot());
        }
    }

    /// `$ty::ALL` 依序是 `$text`，而且 serde、`as_str()` 與 `parse()` 使用同一個字串。
    macro_rules! assert_wire_strings {
        ($ty:ty, [$($text:literal),+ $(,)?]) => {{
            let expected: Vec<&str> = vec![$($text),+];
            let actual: Vec<&str> = <$ty>::ALL.iter().map(|value| value.as_str()).collect();
            assert_eq!(actual, expected, stringify!($ty));
            for value in <$ty>::ALL {
                let text = value.as_str();
                assert_eq!(serde_json::to_value(value).expect("可以序列化"), json!(text));
                assert_eq!(
                    serde_json::from_value::<$ty>(json!(text)).expect("可以解析"),
                    *value
                );
                assert_eq!(<$ty>::parse(text), Some(*value));
            }
        }};
    }

    #[test]
    fn enum_values_match_the_enum_table() {
        assert_wire_strings!(
            CoverKind,
            ["camp", "mountain", "lake", "night", "forest", "beach", "sunrise"]
        );
        assert_wire_strings!(TripStatus, ["planning", "completed"]);
        assert_wire_strings!(
            Color,
            ["coral", "blue", "green", "yellow", "lavender", "peach"]
        );
        assert_wire_strings!(Role, ["admin", "member"]);
        assert_wire_strings!(
            ActivityKind,
            [
                "meet", "market", "camp", "meal", "night", "travel", "wake", "pitch", "free",
                "tea", "strike", "clean", "return"
            ]
        );
        assert_wire_strings!(StopKind, ["shop", "pickup", "gear", "other"]);
        assert_wire_strings!(
            PlaceTemplate,
            [
                "home",
                "market",
                "seven-eleven",
                "familymart",
                "okmart",
                "pxmart-mega",
                "costco",
                "ikea",
                "carrefour",
                "tent",
                "bell",
                "dome",
                "tarp",
                "camper",
                "cabin"
            ]
        );
        assert_wire_strings!(
            StopTask,
            [
                "shopping",
                "passenger-pickup",
                "passenger-dropoff",
                "gear-pickup",
                "gear-return",
                "car-rental",
                "car-return",
                "waypoint"
            ]
        );
        assert_wire_strings!(RoutePosition, ["before", "after"]);
        assert_wire_strings!(MealSlot, ["早餐", "午餐", "下午茶", "晚餐", "消夜"]);
        assert_wire_strings!(
            DishKind,
            [
                "hotpot",
                "bbq",
                "toast",
                "curry",
                "pasta",
                "breakfast",
                "salad",
                "custom"
            ]
        );
        assert_wire_strings!(
            Category,
            [
                "肉類",
                "海鮮",
                "蔬菜",
                "水果",
                "蛋奶",
                "豆製品",
                "主食",
                "調味料",
                "飲料",
                "零食",
                "其他"
            ]
        );
        assert_wire_strings!(ItemSource, ["meal", "manual"]);
        assert_wire_strings!(GearScope, ["personal", "shared"]);
        assert_wire_strings!(
            ExpenseCategory,
            [
                "食材",
                "交通",
                "住宿",
                "其他",
                "食材／肉類",
                "食材／海鮮",
                "食材／蔬菜",
                "食材／水果",
                "食材／蛋奶",
                "食材／豆製品",
                "食材／主食",
                "食材／調味料",
                "食材／飲料",
                "食材／零食",
                "食材／其他",
                "露營耗材",
                "露營裝備",
                "日用品"
            ]
        );
        assert_wire_strings!(
            Entity,
            [
                "card",
                "person",
                "vehicle",
                "place",
                "route",
                "day_setting",
                "activity",
                "meal",
                "shopping",
                "gear",
                "departure",
                "expense",
                "settlement"
            ]
        );
    }

    #[test]
    fn expense_categories_have_one_groceries_value_per_shopping_category() {
        let groceries: Vec<Category> = ExpenseCategory::ALL
            .iter()
            .filter_map(|value| match value {
                ExpenseCategory::Groceries(category) => Some(*category),
                _ => None,
            })
            .collect();
        assert_eq!(groceries, Category::ALL);
        for category in Category::ALL {
            // 「食材」加全形斜線 U+FF0F 加採買分類，與現行 `食材／${category}` 相同
            assert_eq!(
                ExpenseCategory::Groceries(*category).as_str(),
                format!("食材\u{ff0f}{}", category.as_str())
            );
        }
    }

    #[test]
    fn values_outside_the_enum_table_are_rejected() {
        assert!(serde_json::from_value::<Category>(json!("肉")).is_err());
        // 現行的「宵夜」只是顯示排序用的別名，不是儲存的值
        assert!(serde_json::from_value::<MealSlot>(json!("宵夜")).is_err());
        // 半形斜線不是支出分類
        assert!(serde_json::from_value::<ExpenseCategory>(json!("食材/肉類")).is_err());
        assert!(serde_json::from_value::<ExpenseCategory>(json!(3)).is_err());
        assert!(serde_json::from_value::<StopTask>(json!("gear_pickup")).is_err());
        assert!(serde_json::from_value::<ActivityKind>(json!("Meet")).is_err());
        assert!(serde_json::from_value::<Entity>(json!("DaySetting")).is_err());
        assert_eq!(CoverKind::parse(""), None);
        assert_eq!(ExpenseCategory::parse("食材／"), None);
        assert_eq!(RoutePosition::default(), RoutePosition::Before);
    }
}
