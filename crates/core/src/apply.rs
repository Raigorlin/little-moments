//! `apply()`、`diff()` 與各命令的處理函式（design 1.5、A2）；前端預測與伺服器提交使用同一個 `apply()`，所以兩者的
//! 主要效果相同（Property 10）。
//!
//! `apply()` 依序：以 `authorize()` 判斷權限（在找目標、驗證與判斷有沒有變化之前，需求 6.4）；在 Trip_State 的可寫
//! 副本上執行處理函式；以 `diff()` 算出主要效果，沒有變化時回傳空的 `Outcome`，也不執行採買同步（需求 7.12）；
//! `Mode::Commit` 而且命令會影響食材時執行採買同步，算出衍生效果；最後以 `validate::state()` 檢查不變式。

mod common;
mod gear;
mod ledger;
mod meals;
mod people;
mod places;
mod schedule;
mod shopping;
mod trip;
mod vehicles;

use std::collections::{BTreeMap, BTreeSet};

use indexmap::IndexMap;

use crate::command::Command;
pub use crate::command::Rejection;
pub use crate::ids::IdSource;
use crate::ids::{ShoppingId, UserId};
use crate::ingredients::{sync_meal_ingredients, ShoppingLimitExceeded};
use crate::model::{Entity, Row, RowKey, Slot, TripState};
use crate::rules::{authorize, Capabilities};
use crate::validate::{self, Violation};
pub use people::join_trip;
pub use trip::{creator_name, new_trip_card};

/// `apply()` 的用途。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Mode {
    /// 前端預測：只算主要效果，不跑採買同步（衍生資料只在伺服器計算，B5）；不檢查 I9。
    Predict,
    /// 伺服器提交：主要效果加上衍生效果。
    Commit,
}

/// 執行命令的身分：送出命令的 Account，以及他對這趟旅行的 `Capabilities`。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ctx {
    pub actor: UserId,
    pub caps: Capabilities,
}

/// 一列的變化：新增或取代為 `Row`，或刪除 `Slot` 的列。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    Upsert(Row),
    Delete(Slot),
}

impl Effect {
    /// 這個變化的列。
    pub fn slot(&self) -> Slot {
        match self {
            Effect::Upsert(row) => row.slot(),
            Effect::Delete(slot) => *slot,
        }
    }
}

/// `apply()` 的結果。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    /// 命令本身造成的變化，依 Slot 遞增，每個 Slot 一筆。
    pub primary: Vec<Effect>,
    /// 採買同步造成的變化（只有 `Mode::Commit` 才有）：品項的新增、更新與刪除，以及清除被刪除品項的支出連結。
    pub derived: Vec<Effect>,
    /// 新增的列（有 Ordinal 的種類）依建立順序：先是主要效果的新列，依命令中的順序（例如一次加入的多個常用活動）；
    /// 再是採買同步新增的 Meal_Item，依 `SyncPlan::created` 的順序。`execute()` 依這個順序指定 Ordinal（需求 7.19）。
    pub created: Vec<Slot>,
}

impl Outcome {
    /// 主要效果在前、衍生效果在後；同一個 Slot 只留最後一筆，位置是它第一次出現的位置。
    pub fn effects(&self) -> Vec<Effect> {
        let mut merged: IndexMap<Slot, Effect> = IndexMap::new();
        for effect in self.primary.iter().chain(&self.derived) {
            merged.insert(effect.slot(), effect.clone());
        }
        merged.into_values().collect()
    }

    /// 沒有任何變化（想要的狀態已經成立，或要刪除的列已不存在）。
    pub fn is_noop(&self) -> bool {
        self.primary.is_empty() && self.derived.is_empty()
    }
}

/// 前端預測用的 `IdSource`：`Mode::Predict` 不執行採買同步，所以不會被呼叫。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NoDerivedIds;

impl IdSource for NoDerivedIds {
    fn shopping_id(&mut self) -> ShoppingId {
        unreachable!("Mode::Predict 不執行採買同步，不會產生採買品項的 id")
    }
}

/// 執行命令（design A2）：成功時回傳主要效果、衍生效果與新增的列；失敗時沒有任何副作用（`state` 以唯讀參照傳入）。
/// 相同的 `state`、`ctx`、`mode`、`cmd` 與相同的 `ids` 序列得到相同的結果。
///
/// 新列先取得暫時的 Ordinal：從 `state.max_ordinal() + 1` 起依 `Outcome::created` 的順序遞增，所以預測的新列排在
/// 同一種列的最後（需求 7.18）；`execute()` 再換成正式的 Ordinal。
pub fn apply(
    state: &TripState,
    ctx: &Ctx,
    mode: Mode,
    ids: &mut dyn IdSource,
    cmd: &Command,
) -> Result<Outcome, Rejection> {
    authorize(state, &ctx.caps, cmd)?;
    let mut draft = state.clone();
    let mut created = run(&mut draft, ctx, cmd)?;
    let primary = diff(state, &draft);
    if primary.is_empty() {
        // 想要的狀態已經成立，或要刪除的列已不存在：沒有變化，也不執行採買同步或任何連帶效果（需求 7.12）
        return Ok(Outcome::default());
    }
    let mut derived = Vec::new();
    if mode == Mode::Commit && touches_ingredients(cmd) {
        let plan = sync_meal_ingredients(&draft, ids)
            .map_err(|error| Rejection::conflict(ShoppingLimitExceeded::CODE, error.to_string()))?;
        let mut synced = draft.clone();
        // 也清除被移除品項的支出連結，不檢查帳目的權限（需求 29.13）
        plan.apply_to(&mut synced);
        // 新增的 Meal_Item 排在主要效果的新列之後（需求 7.19）
        for (id, ordinal) in plan.created.iter().zip(draft.max_ordinal() + 1..) {
            if let Some(item) = synced.shopping.get_mut(id) {
                item.ordinal = ordinal;
            }
        }
        derived = diff(&draft, &synced);
        created.extend(
            plan.created
                .iter()
                .map(|id| (Entity::Shopping, RowKey::Id(id.0))),
        );
        draft = synced;
    }
    // 防線：處理函式的疏漏在這裡變成拒絕，不會寫入（需求 9.1、9.16）
    validate::state(&draft, mode).map_err(Violation::into_rejection)?;
    Ok(Outcome {
        primary,
        derived,
        created,
    })
}

/// 會影響料理食材或採買品項、提交時要執行採買同步的命令（需求 25.1）。
fn touches_ingredients(cmd: &Command) -> bool {
    use Command::*;
    matches!(
        cmd,
        AddMeal { .. }
            | UpdateMeal { .. }
            | RemoveMeal { .. }
            | RemoveIngredientFromMeals { .. }
            | AddShoppingItem { .. }
            | UpdateShoppingItem { .. }
            | RemoveShoppingItem { .. }
    )
}

/// 依命令分派給處理函式。處理函式在 `d` 上修改列，回傳新增的列（有 Ordinal 的種類），依命令中的順序。
fn run(d: &mut TripState, ctx: &Ctx, cmd: &Command) -> Result<Vec<Slot>, Rejection> {
    use Command::*;
    let none = |result: Result<(), Rejection>| result.map(|()| Vec::new());
    match cmd {
        UpdateTrip { patch } => none(trip::update_trip(d, patch)),
        AddPerson {
            id,
            name,
            role,
            color,
        } => people::add_person(d, *id, name, role, *color),
        UpdatePerson { id, patch } => none(people::update_person(d, *id, patch)),
        RemovePerson { id } => none(people::remove_person(d, *id)),
        AddVehicle { id, draft } => vehicles::add_vehicle(d, *id, draft),
        UpdateVehicle { id, patch } => none(vehicles::update_vehicle(d, *id, patch)),
        RemoveVehicle { id } => none(vehicles::remove_vehicle(d, *id)),
        AddPlace { id, name, template } => places::add_place(d, *id, name, template.as_ref()),
        RenamePlace { id, name } => none(places::rename_place(d, *id, name)),
        RemovePlace { id } => none(places::remove_place(d, *id)),
        SaveRoute { route } => schedule::save_route(d, route),
        RemoveRoute { id } => {
            schedule::remove_route(d, *id);
            Ok(Vec::new())
        }
        SaveDaySetting { day, patch } => none(schedule::save_day_setting(d, *day, patch)),
        AddActivities { day, items } => schedule::add_activities(d, *day, items),
        UpdateActivity { id, patch } => none(schedule::update_activity(d, *id, patch)),
        RemoveActivity { id } => {
            schedule::remove_activity(d, *id);
            Ok(Vec::new())
        }
        SetActivityDone { id, done } => none(schedule::set_activity_done(d, *id, *done)),
        AddMeal { id, draft } => meals::add_meal(d, *id, draft),
        UpdateMeal { id, patch } => none(meals::update_meal(d, *id, patch)),
        RemoveMeal { id } => {
            meals::remove_meal(d, *id);
            Ok(Vec::new())
        }
        RemoveIngredientFromMeals { item, meals } => {
            none(meals::remove_ingredient(d, *item, meals))
        }
        AddShoppingItem { id, draft } => shopping::add_item(d, *id, draft),
        UpdateShoppingItem { id, patch } => none(shopping::update_item(d, *id, patch)),
        RemoveShoppingItem { id } => none(shopping::remove_item(d, *id)),
        SetShoppingPurchased { id, purchased } => {
            none(shopping::set_purchased(d, ctx, *id, *purchased))
        }
        AddGear { id, draft } => gear::add_gear(d, *id, draft),
        UpdateGear { id, patch } => none(gear::update_gear(d, *id, patch)),
        RemoveGear { id } => {
            gear::remove_gear(d, *id);
            Ok(Vec::new())
        }
        SetGearPacked { id, person, packed } => none(gear::set_packed(d, *id, *person, *packed)),
        SetDeparted { person, departed } => none(gear::set_departed(d, *person, *departed)),
        AddExpense { id, draft } => ledger::add_expense(d, *id, draft),
        UpdateExpense { id, patch } => none(ledger::update_expense(d, *id, patch)),
        RemoveExpense { id } => {
            ledger::remove_expense(d, *id);
            Ok(Vec::new())
        }
        AddSettlement { id, draft } => ledger::add_settlement(d, *id, draft),
        UpdateSettlement { id, patch } => none(ledger::update_settlement(d, *id, patch)),
        RemoveSettlement { id } => {
            ledger::remove_settlement(d, *id);
            Ok(Vec::new())
        }
    }
}

// ── 差異 ──

/// 逐一比較兩份狀態的每個 Slot（design A2）：只在 `after` 有、或內容不同的產生 `Upsert`，只在 `before` 有的產生
/// `Delete`；依 Slot 遞增，每個 Slot 最多一筆。以日期為鍵的每日設定在改日期時會整張重建，靠這裡產生正確的刪除與新增。
pub fn diff(before: &TripState, after: &TripState) -> Vec<Effect> {
    let mut effects = Vec::new();
    if before.card != after.card {
        effects.push(Effect::Upsert(Row::Card(after.card.clone())));
    }
    let (b, a, out) = (before, after, &mut effects);
    diff_map(
        &b.people,
        &a.people,
        |k| slot(Entity::Person, k.0),
        Row::Person,
        out,
    );
    diff_map(
        &b.vehicles,
        &a.vehicles,
        |k| slot(Entity::Vehicle, k.0),
        Row::Vehicle,
        out,
    );
    diff_map(
        &b.places,
        &a.places,
        |k| slot(Entity::Place, k.0),
        Row::Place,
        out,
    );
    diff_map(
        &b.routes,
        &a.routes,
        |k| slot(Entity::Route, k.0),
        Row::Route,
        out,
    );
    diff_map(
        &b.day_settings,
        &a.day_settings,
        |day| (Entity::DaySetting, RowKey::Day(day)),
        Row::DaySetting,
        out,
    );
    diff_map(
        &b.activities,
        &a.activities,
        |k| slot(Entity::Activity, k.0),
        Row::Activity,
        out,
    );
    diff_map(
        &b.meals,
        &a.meals,
        |k| slot(Entity::Meal, k.0),
        Row::Meal,
        out,
    );
    diff_map(
        &b.shopping,
        &a.shopping,
        |k| slot(Entity::Shopping, k.0),
        Row::Shopping,
        out,
    );
    diff_map(
        &b.gear,
        &a.gear,
        |k| slot(Entity::Gear, k.0),
        Row::Gear,
        out,
    );
    diff_map(
        &b.departures,
        &a.departures,
        |k| slot(Entity::Departure, k.0),
        Row::Departure,
        out,
    );
    diff_map(
        &b.expenses,
        &a.expenses,
        |k| slot(Entity::Expense, k.0),
        Row::Expense,
        out,
    );
    diff_map(
        &b.settlements,
        &a.settlements,
        |k| slot(Entity::Settlement, k.0),
        Row::Settlement,
        out,
    );
    effects
}

/// 以 UUID 為鍵的列的 Slot。
pub(crate) fn slot(entity: Entity, id: uuid::Uuid) -> Slot {
    (entity, RowKey::Id(id))
}

/// 一種列的差異，依鍵遞增。
fn diff_map<K: Ord + Copy, V: PartialEq + Clone>(
    before: &BTreeMap<K, V>,
    after: &BTreeMap<K, V>,
    slot: impl Fn(K) -> Slot,
    row: impl Fn(V) -> Row,
    out: &mut Vec<Effect>,
) {
    let keys: BTreeSet<&K> = before.keys().chain(after.keys()).collect();
    for key in keys {
        match (before.get(key), after.get(key)) {
            (Some(old), Some(new)) if old == new => {}
            (_, Some(new)) => out.push(Effect::Upsert(row(new.clone()))),
            (Some(_), None) => out.push(Effect::Delete(slot(*key))),
            (None, None) => {}
        }
    }
}

impl TripState {
    /// 依序套用 `effects`：`Upsert` 新增或取代那一列，`Delete` 刪除那一列（已不存在時沒有變化）。
    pub fn apply_effects<'a>(&mut self, effects: impl IntoIterator<Item = &'a Effect>) {
        for effect in effects {
            match effect {
                Effect::Upsert(row) => self.put(row.clone()),
                Effect::Delete(slot) => {
                    self.remove(*slot);
                }
            }
        }
    }
}
