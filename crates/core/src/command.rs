//! `Command` 與各種 Patch、Draft：客戶端唯一能送給伺服器的寫入（design 1.3），以及拒絕命令時的 `Rejection`
//! 與共用的文案。
//!
//! - 新列的 id 由客戶端產生（需求 7.18）。
//! - Patch 只帶使用者改過的欄位（需求 7.8）：`None` 是不改；可以清空的欄位是 `Option<Option<T>>`，`Some(None)`
//!   是清空，線上格式中沒有這個欄位是不改、`null` 是清空。集合欄位（車輛的乘客、活動的指定旅伴與指定車輛、支出的
//!   分攤旅伴）以加入與移除表示，與別人同時加入或移除其他元素不會互相覆蓋（需求 7.7）。
//! - 使用者輸入或選擇、而需求規定了 400 訊息的值（時刻、座位數、份數與列舉值）是 `Input<T>`：無法解析成 `T` 的 JSON
//!   值保留為 `Bad`，由處理函式依各需求的檢查順序回應那個欄位的訊息。時刻以使用者輸入的文字送出（「０８：３０」是
//!   08:30）；選填的時刻以 `null` 或空字串表示留空（`optional_time()`）。其他欄位的型別不符時，反序列化失敗，
//!   LM_Server 依需求 7.20 回應 400 `invalid_request`。

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::ids::{
    ActivityId, ExpenseId, GearId, MealId, PersonId, PlaceId, RouteId, SettlementId, ShoppingId,
    StopId, VehicleId,
};
use crate::model::{
    ActivityKind, Category, Color, CoverKind, Date, DishKind, ExpenseCategory, GearScope, MealSlot,
    Participation, PlaceRef, PlaceTemplate, RoutePosition, StopKind, StopTask, TripStatus,
};
use crate::text::InvalidTime;
use crate::time::Hm;

/// 客戶端送給伺服器的一個寫入（design 1.3）。線上格式以 `type` 區分種類，例如
/// `{"type":"set_shopping_purchased","id":"…","purchased":true}`。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    // 旅行
    /// 編輯旅行，含改日期（`retime_by_day_index()`）。
    UpdateTrip {
        patch: TripPatch,
    },
    // 旅伴
    AddPerson {
        id: PersonId,
        name: String,
        role: String,
        /// 沒有指定時依新增前的人數取色（需求 19.8）。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<Color>,
    },
    UpdatePerson {
        id: PersonId,
        patch: PersonPatch,
    },
    RemovePerson {
        id: PersonId,
    },
    // 車輛
    AddVehicle {
        id: VehicleId,
        draft: VehicleDraft,
    },
    UpdateVehicle {
        id: VehicleId,
        patch: VehiclePatch,
    },
    RemoveVehicle {
        id: VehicleId,
    },
    // 地點
    AddPlace {
        id: PlaceId,
        name: String,
        /// 繪本插圖；沒有選擇時不寫出。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        template: Option<Input<PlaceTemplate>>,
    },
    RenamePlace {
        id: PlaceId,
        name: String,
    },
    RemovePlace {
        id: PlaceId,
    },
    // 行程表
    /// 整條路線與它的停靠點（路線卡片一次儲存，需求 7.9）。
    SaveRoute {
        route: RouteDraft,
    },
    RemoveRoute {
        id: RouteId,
    },
    /// 只帶改過的欄位（需求 22.15）；那一天沒有設定時新增。
    SaveDaySetting {
        day: Date,
        patch: DaySettingPatch,
    },
    /// 一筆或多筆活動（常用活動一次加入），全部新增或全部不新增（需求 23.1）。
    AddActivities {
        day: Date,
        items: Vec<ActivityDraft>,
    },
    UpdateActivity {
        id: ActivityId,
        patch: ActivityPatch,
    },
    RemoveActivity {
        id: ActivityId,
    },
    SetActivityDone {
        id: ActivityId,
        done: bool,
    },
    // 料理
    AddMeal {
        id: MealId,
        draft: MealDraft,
    },
    /// 含在規劃行程調整用餐時間（需求 22.13）。
    UpdateMeal {
        id: MealId,
        patch: MealPatch,
    },
    RemoveMeal {
        id: MealId,
    },
    RemoveIngredientFromMeals {
        item: ShoppingId,
        meals: BTreeSet<MealId>,
    },
    // 採買
    AddShoppingItem {
        id: ShoppingId,
        draft: ShoppingDraft,
    },
    UpdateShoppingItem {
        id: ShoppingId,
        patch: ShoppingPatch,
    },
    RemoveShoppingItem {
        id: ShoppingId,
    },
    SetShoppingPurchased {
        id: ShoppingId,
        purchased: bool,
    },
    // 裝備與出發
    AddGear {
        id: GearId,
        draft: GearDraft,
    },
    UpdateGear {
        id: GearId,
        patch: GearPatch,
    },
    RemoveGear {
        id: GearId,
    },
    SetGearPacked {
        id: GearId,
        person: PersonId,
        packed: bool,
    },
    SetDeparted {
        person: PersonId,
        departed: bool,
    },
    // 分帳
    AddExpense {
        id: ExpenseId,
        draft: ExpenseDraft,
    },
    UpdateExpense {
        id: ExpenseId,
        patch: ExpensePatch,
    },
    RemoveExpense {
        id: ExpenseId,
    },
    AddSettlement {
        id: SettlementId,
        draft: SettlementDraft,
    },
    UpdateSettlement {
        id: SettlementId,
        patch: SettlementPatch,
    },
    RemoveSettlement {
        id: SettlementId,
    },
}

/// 使用者輸入或選擇的值：能解析成 `T` 時是 `Ok`；其他任何 JSON 值是 `Bad`，保留原值。反序列化因此不會在這些欄位
/// 失敗，LM_Core 才能依各需求的檢查順序回應那個欄位的 400 訊息。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Input<T> {
    Ok(T),
    Bad(serde_json::Value),
}

impl<T> Input<T> {
    /// 能解析時的值。
    pub fn ok(&self) -> Option<&T> {
        match self {
            Input::Ok(value) => Some(value),
            Input::Bad(_) => None,
        }
    }
}

impl<T> From<T> for Input<T> {
    fn from(value: T) -> Self {
        Input::Ok(value)
    }
}

/// 選填時刻欄位的輸入：沒有這個欄位、`null` 或空字串（經 `normalize_time_input()` 是留空的文字）為 `Ok(None)`，
/// Time_Value 為 `Ok(Some(_))`，其他為 `Err(InvalidTime)`。
pub fn optional_time(input: Option<&Input<Hm>>) -> Result<Option<Hm>, InvalidTime> {
    match input {
        None => Ok(None),
        Some(Input::Ok(hm)) => Ok(Some(*hm)),
        Some(Input::Bad(serde_json::Value::Null)) => Ok(None),
        Some(Input::Bad(serde_json::Value::String(text))) => Hm::parse(text),
        Some(Input::Bad(_)) => Err(InvalidTime),
    }
}

/// 旅行的起訖日期：開始日與結束日一起帶有、一起生效，不會只改其中一個（需求 18.1）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DateSpan {
    pub start: Date,
    pub end: Date,
}

/// 建立旅行的內容（需求 17.2、17.5）：狀態一律是規劃中，封面預設為 camp。不是 `Command`；LM_Server 的
/// `POST /api/trips` 與 LM_Web 的表單以 `apply::new_trip_card()` 檢查。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TripDraft {
    pub title: String,
    #[serde(default)]
    pub destination: String,
    pub start: Date,
    pub end: Date,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub note: String,
    #[serde(default = "camp")]
    pub cover: Input<CoverKind>,
}

fn camp() -> Input<CoverKind> {
    Input::Ok(CoverKind::Camp)
}

/// 編輯旅行（需求 18.1）：只帶使用者改過的欄位，沒有帶的欄位保留伺服器執行當下的值。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TripPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dates: Option<DateSpan>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// 繪本的大標題；空字串是清空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headline: Option<String>,
    /// 繪本的底部短語；空字串是清空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<Input<CoverKind>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<Input<TripStatus>>,
}

/// 修改旅伴（需求 19.1）：只檢查帶有的欄位。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PersonPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<Color>,
}

/// 新增車輛（需求 20.1–20.3）。座位數沒有填寫是 `None`（「請填寫必要欄位，不能只有空白。」）；顏色沒有設定時依
/// Car_Palette 顯示（需求 20.4）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VehicleDraft {
    pub name: String,
    #[serde(default)]
    pub driver: Option<PersonId>,
    #[serde(default)]
    pub seats: Option<Input<u8>>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub passengers: BTreeSet<PersonId>,
}

/// 修改車輛。乘客是集合操作，與別人同時加入或移除其他乘客不會互相覆蓋。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct VehiclePatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    pub driver: Option<Option<PersonId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seats: Option<Input<u8>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    pub color: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub passengers_add: BTreeSet<PersonId>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub passengers_remove: BTreeSet<PersonId>,
}

/// 路線卡片的整份內容（需求 7.9、22.3）：路線所屬的日子、車輛、起點、終點、出發時間，以及依卡片順序排列的停靠點。
/// 車輛、起點、終點與停靠點的地點沒有選擇時是 `None`。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RouteDraft {
    pub id: RouteId,
    pub day: Date,
    #[serde(default)]
    pub vehicle: Option<VehicleId>,
    #[serde(default)]
    pub from: Option<PlaceRef>,
    #[serde(default)]
    pub to: Option<PlaceRef>,
    /// 出發時間；`null`、空字串或沒有這個欄位是留空。
    #[serde(default)]
    pub depart: Option<Input<Hm>>,
    #[serde(default)]
    pub stops: Vec<StopDraft>,
}

/// 路線卡片中的一個停靠點。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StopDraft {
    pub id: StopId,
    #[serde(default)]
    pub place: Option<PlaceRef>,
    pub kind: Input<StopKind>,
    /// 任務類型；沒有指定時使用種類的預設任務（需求 22.8）。
    #[serde(default)]
    pub task: Option<Input<StopTask>>,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub time: Option<Input<Hm>>,
    /// 待辦清單或旅伴名單；每項經 Trim_White，空白的項目略過；採買的停靠點不儲存。
    #[serde(default)]
    pub items: Vec<String>,
}

/// 一天的設定（需求 22.10、22.15）：只帶改過的欄位；`Some(None)` 是清空。
/// `place` 只能是地點清單中的地點；選擇旅行目的地或「不指定地點」時，LM_Web 送出 `Some(None)`。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DaySettingPatch {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    pub title: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    pub place: Option<Option<PlaceId>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    pub arrival: Option<Option<Input<Hm>>>,
    /// 繪本日卡的抵達說明；`Some(None)` 或只有空白是清空。
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    pub arrival_label: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route_position: Option<Input<RoutePosition>>,
}

/// 新增的一筆活動（需求 23.1、23.3）：日期是命令的 `day`；新增的活動都是未完成。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ActivityDraft {
    pub id: ActivityId,
    /// 必填；`null`、空字串或沒有這個欄位是「請填寫時間，例如 08:30。」。
    #[serde(default)]
    pub time: Option<Input<Hm>>,
    pub title: String,
    pub kind: Input<ActivityKind>,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub note: String,
    /// 參加者；指定的集合是空的時為全體旅伴（需求 23.4）。
    #[serde(default = "everyone")]
    pub who: Participation,
}

fn everyone() -> Participation {
    Participation::Everyone
}

/// 修改活動（需求 23.9）：只帶改過的欄位。參加者以指定旅伴與指定車輛的加入與移除表示；結果的指定集合是空的時為
/// 全體旅伴（需求 23.4）。例如從指定旅伴改為指定車輛，是移除每一位指定旅伴並加入車輛。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ActivityPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day: Option<Date>,
    /// 時間是必填的欄位：帶有 `null` 或空字串時是「請填寫時間，例如 08:30。」。
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    pub time: Option<Option<Input<Hm>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<Input<ActivityKind>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub people_add: BTreeSet<PersonId>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub people_remove: BTreeSet<PersonId>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub vehicles_add: BTreeSet<VehicleId>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub vehicles_remove: BTreeSet<VehicleId>,
}

/// 新增料理（需求 24.2）。負責人沒有選擇是待分配；插圖種類沒有設定時依名稱與食材推斷（需求 24.5）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MealDraft {
    pub day: Date,
    pub slot: Input<MealSlot>,
    /// 用餐時間；留空時使用餐次的預設時間（需求 24.3）。
    #[serde(default)]
    pub time: Option<Input<Hm>>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub cook: Option<PersonId>,
    pub servings: Input<u8>,
    #[serde(default)]
    pub ingredients: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub dish: Option<Input<DishKind>>,
}

/// 修改料理：只帶改過的欄位。改了餐次而原本有用餐時間時，表單在同一個 patch 中清空用餐時間（需求 24.12）。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MealPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day: Option<Date>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<Input<MealSlot>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    pub time: Option<Option<Input<Hm>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    pub cook: Option<Option<PersonId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub servings: Option<Input<u8>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ingredients: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    pub dish: Option<Option<Input<DishKind>>>,
}

/// 新增手動的採買品項（需求 26.2）。負責人沒有選擇是待分配。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ShoppingDraft {
    pub name: String,
    #[serde(default)]
    pub quantity: String,
    pub category: Category,
    #[serde(default)]
    pub assignee: Option<PersonId>,
}

/// 修改採買品項（需求 26.5）：只帶改過的欄位；在清單中直接修改數量或負責人時只帶那一個欄位。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ShoppingPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quantity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<Category>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    pub assignee: Option<Option<PersonId>>,
}

/// 新增裝備（需求 27.2）。個人裝備沒有負責人；共用裝備沒有負責人時是待分配。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GearDraft {
    pub name: String,
    #[serde(default)]
    pub quantity: String,
    pub scope: GearScope,
    #[serde(default)]
    pub assignee: Option<PersonId>,
}

/// 修改裝備：只帶改過的欄位。有負責人的共用裝備改為個人裝備時，表單在同一個 patch 中清空負責人（需求 27.11）。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct GearPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quantity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<GearScope>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    pub assignee: Option<Option<PersonId>>,
}

/// 新增支出（需求 29.2）。金額是整數的分；付款人沒有選擇是 `None`；不連結採買品項時 `shopping_item` 是 `None`。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ExpenseDraft {
    pub day: Date,
    pub title: String,
    pub amount_cents: i64,
    #[serde(default)]
    pub payer: Option<PersonId>,
    #[serde(default)]
    pub participants: BTreeSet<PersonId>,
    pub category: Input<ExpenseCategory>,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub shopping_item: Option<ShoppingId>,
}

/// 修改支出：只帶改過的欄位；分攤旅伴以加入與移除套用（需求 29.2）。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ExpensePatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day: Option<Date>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount_cents: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payer: Option<PersonId>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub participants_add: BTreeSet<PersonId>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub participants_remove: BTreeSet<PersonId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<Input<ExpenseCategory>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    pub shopping_item: Option<Option<ShoppingId>>,
}

/// 新增還款（需求 29.3）。付款人或收款人沒有選擇是 `None`。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SettlementDraft {
    pub day: Date,
    #[serde(default)]
    pub from: Option<PersonId>,
    #[serde(default)]
    pub to: Option<PersonId>,
    pub amount_cents: i64,
    #[serde(default)]
    pub note: String,
}

/// 修改還款：只帶改過的欄位。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SettlementPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day: Option<Date>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<PersonId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<PersonId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount_cents: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

// ── 拒絕 ──

/// 命令被拒絕的原因（design 1.5）：HTTP 400、403、404 或 409，訊息可以直接顯示給使用者（需求 5.5、7.15）。
/// `Invalid` 的 `field` 是不符合的欄位（例如 `title`），讓表單把訊息顯示在那個欄位。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Rejection {
    /// HTTP 400。
    #[error("{message}")]
    Invalid {
        code: String,
        field: Option<String>,
        message: String,
    },
    /// HTTP 403。
    #[error("{message}")]
    Forbidden { message: String },
    /// HTTP 404。
    #[error("{message}")]
    NotFound { message: String },
    /// HTTP 409。
    #[error("{message}")]
    Conflict { code: String, message: String },
}

impl Rejection {
    /// 400：`field` 欄位不符合規則，代碼為 [`INVALID`]。
    pub fn invalid(field: &str, message: impl Into<String>) -> Rejection {
        Rejection::Invalid {
            code: INVALID.to_owned(),
            field: Some(field.to_owned()),
            message: message.into(),
        }
    }

    /// 403。
    pub fn forbidden(message: impl Into<String>) -> Rejection {
        Rejection::Forbidden {
            message: message.into(),
        }
    }

    /// 404。
    pub fn not_found(message: impl Into<String>) -> Rejection {
        Rejection::NotFound {
            message: message.into(),
        }
    }

    /// 409。
    pub fn conflict(code: &str, message: impl Into<String>) -> Rejection {
        Rejection::Conflict {
            code: code.to_owned(),
            message: message.into(),
        }
    }

    /// HTTP 狀態碼：400、403、404 或 409。
    pub fn status(&self) -> u16 {
        match self {
            Rejection::Invalid { .. } => 400,
            Rejection::Forbidden { .. } => 403,
            Rejection::NotFound { .. } => 404,
            Rejection::Conflict { .. } => 409,
        }
    }

    /// 可以直接顯示的訊息。
    pub fn message(&self) -> &str {
        match self {
            Rejection::Invalid { message, .. }
            | Rejection::Forbidden { message }
            | Rejection::NotFound { message }
            | Rejection::Conflict { message, .. } => message,
        }
    }

    /// 400 與 409 的代碼；403 與 404 沒有代碼，由 LM_Server 依種類補上（任務 13.2）。
    pub fn code(&self) -> Option<&str> {
        match self {
            Rejection::Invalid { code, .. } | Rejection::Conflict { code, .. } => Some(code),
            Rejection::Forbidden { .. } | Rejection::NotFound { .. } => None,
        }
    }

    /// 400 的欄位。
    pub fn field(&self) -> Option<&str> {
        match self {
            Rejection::Invalid { field, .. } => field.as_deref(),
            _ => None,
        }
    }
}

// ── 代碼 ──

/// 400：欄位不符合規則。
pub const INVALID: &str = "invalid";
/// 409：新列的 id 已被同一種列使用（需求 7.22）。
pub const DUPLICATE_ID: &str = "duplicate_id";
/// 409：與既有的列同名（旅伴、地點、採買品項）。
pub const DUPLICATE_NAME: &str = "duplicate_name";
/// 409：數量已達上限。
pub const LIMIT_REACHED: &str = "limit_reached";
/// 409：仍被其他列使用，不能刪除或修改（車輛、地點、旅行目的地、連動料理的品項）。
pub const IN_USE: &str = "in_use";
/// 409：這台車這一天已有路線（需求 22.4）。
pub const ROUTE_EXISTS: &str = "route_exists";
/// 409：縮短天數會刪掉有路線或每日設定的日子（需求 18.7）。
pub const SHORTEN_BLOCKED: &str = "shorten_blocked";
/// 409：已綁定帳號的旅伴，或仍有帳目的旅伴（需求 19.13、19.14）。
pub const PERSON_LOCKED: &str = "person_locked";
/// 409：沒有對應規則的不變式違反（需求 9.16）。
pub const VALIDATION_FAILED: &str = "validation_failed";

// ── 共用文案（沿用現行文字） ──

/// 不是這趟旅行的成員，或旅行不存在、已刪除（需求 6.2、6.3）。
pub const TRIP_NOT_FOUND: &str = "找不到這趟旅行。";
/// Collaborator 移除旅伴，或刪除車輛、料理、採買品項或裝備（需求 6.6）。
pub const DENY_REMOVAL: &str = "受邀旅伴可以編輯，但不能刪除既有項目；請聯絡主辦人或管理員。";
/// 變更其他旅伴的打包或出發確認（需求 6.7）。
pub const DENY_PACKING: &str = "只能變更自己的行前準備。";
/// Collaborator 修改綁定其他 Account 的旅伴（需求 6.8）。
pub const DENY_OTHER_PERSON: &str = "只能修改自己的旅伴資料。";
/// Collaborator 刪除支出或還款（需求 6.10）。
pub const DENY_LEDGER_REMOVAL: &str =
    "受邀旅伴可以新增或修改帳目，但不能刪除既有帳目；請聯絡主辦人或管理員。";
/// 新列的 id 已被同一種列使用（需求 7.22）。
pub const DUPLICATE_ID_MESSAGE: &str = "這個項目已經存在，請重新整理後再試。";
/// 沒有對應規則的不變式違反（需求 9.16）。
pub const VALIDATION_FAILED_MESSAGE: &str = "資料驗證未通過，沒有儲存。";
/// 路線與每日設定的日期不在旅行範圍內（需求 22.5、22.10）。
pub const RELOAD_AND_RETRY: &str = "資料驗證未通過，沒有儲存。請重新載入後再試。";
/// 選填的時刻不是 Time_Value 也不是留空（需求 22.5、22.7、22.10、22.13、24.2）。
pub const TIME_OR_BLANK: &str = "請以 24 小時制填寫完整的時和分，例如 08:30；不填時請清空。";
/// 文字含有 U+0000（需求 8.12），旅行資料、旅伴名字、小隊角色與地點名稱以外的欄位。
pub const UNSTORABLE_TEXT: &str = "文字含有無法儲存的字元。";
/// 找不到旅伴（需求 19.16、20.2、27.2）。
pub const PERSON_NOT_FOUND: &str = "找不到這位旅伴。";
/// 個人裝備尚未準備完成，或仍有共用裝備未分配（需求 28.3）。
pub const CANNOT_DEPART: &str = "個人裝備尚未準備完成，或仍有共用裝備未分配。";

#[cfg(test)]
mod tests {
    use serde_json::json;
    use uuid::Uuid;

    use super::*;

    fn id<T: From<Uuid>>(n: u128) -> T {
        T::from(Uuid::from_u128(n))
    }

    #[test]
    fn commands_are_tagged_by_type_in_snake_case() {
        let command = Command::SetShoppingPurchased {
            id: id(1),
            purchased: true,
        };
        let value = serde_json::to_value(&command).expect("可以序列化");
        assert_eq!(
            value,
            json!({"type": "set_shopping_purchased", "id": "00000000-0000-0000-0000-000000000001", "purchased": true})
        );
        assert_eq!(
            serde_json::from_value::<Command>(value).expect("可以解析"),
            command
        );
    }

    #[test]
    fn patches_tell_unchanged_from_cleared() {
        let patch: VehiclePatch =
            serde_json::from_value(json!({"driver": null})).expect("可以解析");
        assert_eq!(patch.driver, Some(None));
        assert_eq!(patch.color, None);
        let unchanged: VehiclePatch = serde_json::from_value(json!({})).expect("可以解析");
        assert_eq!(unchanged, VehiclePatch::default());
        // 不改的欄位不寫出，清空的欄位寫成 null，所以可以來回轉換
        let cleared = VehiclePatch {
            driver: Some(None),
            ..VehiclePatch::default()
        };
        let value = serde_json::to_value(&cleared).expect("可以序列化");
        assert_eq!(value, json!({"driver": null}));
        assert_eq!(
            serde_json::from_value::<VehiclePatch>(value).expect("可以解析"),
            cleared
        );
    }

    #[test]
    fn inputs_keep_values_that_do_not_parse() {
        let patch: VehiclePatch = serde_json::from_value(json!({"seats": 2.5})).expect("可以解析");
        assert_eq!(patch.seats, Some(Input::Bad(json!(2.5))));
        let patch: VehiclePatch = serde_json::from_value(json!({"seats": 4})).expect("可以解析");
        assert_eq!(patch.seats, Some(Input::Ok(4)));
        let patch: TripPatch =
            serde_json::from_value(json!({"cover": "volcano"})).expect("可以解析");
        assert_eq!(patch.cover, Some(Input::Bad(json!("volcano"))));
        // 時刻以使用者輸入的文字送出
        let setting: DaySettingPatch =
            serde_json::from_value(json!({"arrival": "０８：３０"})).expect("可以解析");
        assert_eq!(
            setting.arrival,
            Some(Some(Input::Ok(Hm::new(8, 30).expect("時刻"))))
        );
    }

    #[test]
    fn optional_times_accept_null_and_blank_text() {
        let hm = Hm::new(8, 30).expect("時刻");
        for (input, expected) in [
            (None, Ok(None)),
            (Some(Input::Ok(hm)), Ok(Some(hm))),
            (Some(Input::Bad(json!(null))), Ok(None)),
            (Some(Input::Bad(json!(""))), Ok(None)),
            (Some(Input::Bad(json!("　"))), Ok(None)),
            (Some(Input::Bad(json!("8:30"))), Err(InvalidTime)),
            (Some(Input::Bad(json!("08:"))), Err(InvalidTime)),
            (Some(Input::Bad(json!(830))), Err(InvalidTime)),
        ] {
            assert_eq!(optional_time(input.as_ref()), expected, "{input:?}");
        }
    }

    #[test]
    fn rejections_report_status_code_field_and_message() {
        let invalid = Rejection::invalid("title", "請填寫標題。");
        assert_eq!(invalid.status(), 400);
        assert_eq!(invalid.code(), Some(INVALID));
        assert_eq!(invalid.field(), Some("title"));
        assert_eq!(invalid.to_string(), "請填寫標題。");
        assert_eq!(Rejection::forbidden(DENY_REMOVAL).status(), 403);
        assert_eq!(Rejection::not_found(TRIP_NOT_FOUND).code(), None);
        let conflict = Rejection::conflict(DUPLICATE_ID, DUPLICATE_ID_MESSAGE);
        assert_eq!(
            (conflict.status(), conflict.message()),
            (409, DUPLICATE_ID_MESSAGE)
        );
        assert_eq!(
            serde_json::to_value(&conflict).expect("可以序列化"),
            json!({"kind": "conflict", "code": "duplicate_id", "message": DUPLICATE_ID_MESSAGE})
        );
    }
}
