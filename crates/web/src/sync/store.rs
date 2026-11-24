//! `RowStore`：每列一個 signal（design 4.3、A12；需求 14.1–14.3）。
//!
//! 列表元件以 `<For each=move || store.keys().get() key=|k| *k …>` 走訪鍵，列元件只讀自己那一列的 signal：
//! - 改一列只通知讀那一列的元件；內容（不計 Row_Version）相同時不通知任何訂閱者（需求 14.1）。
//! - `keys` 只在新增、刪除或排序鍵改變時更新，`<For>` 依鍵只建立、移除或移動那一列的元素（需求 14.2、14.3）。
//! - 分組（採買依分類、料理與活動依日期、裝備依範圍、支出依日期）以 `grouped()` 的 `Memo` 由鍵與分組欄位算出；
//!   只顯示一部分（例如 Schedule_Tab 選定的那一天）以 `filtered()` 的 `Memo` 算出。`Memo` 的結果不變時不通知，
//!   所以鍵不變時 `<For>` 不動 DOM。
use std::cmp::Reverse;
use std::collections::{BTreeMap, HashMap};
use std::hash::Hash;

use leptos::prelude::*;
use lm_core::ids::{
    ActivityId, ExpenseId, GearId, MealId, PersonId, PlaceId, RouteId, SettlementId, ShoppingId,
    VehicleId,
};
use lm_core::model::{
    Activity, Category, Date, DaySetting, Departure, Entity, Expense, GearItem, GearScope, Meal,
    MealSlot, Person, Place, Route, Row, RowKey, Seq, Settlement, ShoppingItem, Slot, TripCard,
    TripState, Vehicle,
};
use lm_core::time::Hm;

/// 有 Row_Version 的列。需求 14.1：只有 Row_Version 不同的列（例如自己的 Pending_Command 得到確認，
/// 而內容與預測相同）視為沒有改變。
pub trait Versioned: Clone + PartialEq {
    fn version(&self) -> Seq;
    fn set_version(&mut self, version: Seq);

    /// 不計 Row_Version 時內容是否相同。
    fn same_content(&self, other: &Self) -> bool {
        if self.version() == other.version() {
            return self == other;
        }
        let mut normalized = self.clone();
        normalized.set_version(other.version());
        normalized == *other
    }
}

macro_rules! versioned {
    ($($row:ty),+ $(,)?) => {$(
        impl Versioned for $row {
            fn version(&self) -> Seq {
                self.version
            }

            fn set_version(&mut self, version: Seq) {
                self.version = version;
            }
        }
    )+};
}

versioned!(
    TripCard,
    Person,
    Vehicle,
    Place,
    Route,
    DaySetting,
    Activity,
    Meal,
    ShoppingItem,
    GearItem,
    Departure,
    Expense,
    Settlement,
);

/// 一種列的全部列：每列一個 signal，加上依排序鍵排列的鍵。
pub struct RowStore<K: 'static, T: 'static, S> {
    rows: StoredValue<HashMap<K, ArcRwSignal<T>>>,
    /// 顯示順序；只有成員或排序鍵改變時才更新。
    keys: RwSignal<Vec<K>>,
    /// 排序鍵都以 ordinal（或本身就是唯一的鍵）結尾，所以兩列的排序鍵不會相等。
    sort_key: fn(&T) -> S,
}

impl<K: 'static, T: 'static, S> Clone for RowStore<K, T, S> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<K: 'static, T: 'static, S> Copy for RowStore<K, T, S> {}

impl<K, T, S> RowStore<K, T, S>
where
    K: Copy + Eq + Hash + Send + Sync + 'static,
    T: Versioned + Send + Sync + 'static,
    S: Ord + 'static,
{
    /// 以 `rows` 建立；signal 屬於目前的 Owner。
    pub fn new(sort_key: fn(&T) -> S, rows: impl IntoIterator<Item = (K, T)>) -> Self {
        let store = RowStore {
            rows: StoredValue::new(
                rows.into_iter()
                    .map(|(key, row)| (key, ArcRwSignal::new(row)))
                    .collect(),
            ),
            keys: RwSignal::new(Vec::new()),
            sort_key,
        };
        store.resort();
        store
    }

    /// 這一列的 signal；沒有這一列時是 `None`。
    pub fn get(&self, key: K) -> Option<ArcRwSignal<T>> {
        self.rows.with_value(|map| map.get(&key).cloned())
    }

    /// 依排序鍵排列的鍵。
    pub fn keys(&self) -> RwSignal<Vec<K>> {
        self.keys
    }

    /// `next` 為 `None` 表示刪除。內容（不計 Row_Version）相同時不通知任何訂閱者，只默默記下新的 Row_Version。
    pub fn sync(&self, key: K, next: Option<T>) {
        match (self.get(key), next) {
            (Some(signal), Some(row)) => {
                let (moved, changed) = signal.with_untracked(|old| {
                    (
                        (self.sort_key)(old) != (self.sort_key)(&row),
                        !old.same_content(&row),
                    )
                });
                if changed {
                    // 只通知讀這一列的元件
                    signal.set(row);
                } else {
                    signal.update_untracked(|old| *old = row);
                }
                if moved {
                    self.resort();
                }
            }
            (None, Some(row)) => {
                self.rows.update_value(|map| {
                    map.insert(key, ArcRwSignal::new(row));
                });
                self.resort();
            }
            (Some(_), None) => {
                self.rows.update_value(|map| {
                    map.remove(&key);
                });
                self.keys.update(|keys| keys.retain(|k| *k != key));
            }
            (None, None) => {}
        }
    }

    /// 使這個 store 與 `next` 相同：`next` 中的每一列依 `sync()` 新增或更新，`next` 中沒有的列刪除。
    pub fn sync_all(&self, next: &BTreeMap<K, T>)
    where
        K: Ord,
    {
        let removed: Vec<K> = self.rows.with_value(|map| {
            map.keys()
                .filter(|key| !next.contains_key(key))
                .copied()
                .collect()
        });
        for key in removed {
            self.sync(key, None);
        }
        for (&key, row) in next {
            self.sync(key, Some(row.clone()));
        }
    }

    /// 依鍵的順序分組，每組內也依鍵的順序；組依第一次出現的順序。分組欄位都在排序鍵的開頭，所以每組在
    /// `keys` 中是連續的。`Memo` 讀 `keys` 與每一列的 signal，結果不變時不通知。
    ///
    /// 外層 `<For>` 走訪 `group_names(memo)`、內層走訪 `group_keys(memo, 組)`，換組的列只在原來的組移除、
    /// 在新的組建立（需求 14.3），其他組不動。
    pub fn grouped<G>(&self, group: fn(&T) -> G) -> Memo<Vec<(G, Vec<K>)>>
    where
        G: Clone + PartialEq + Send + Sync + 'static,
    {
        let store = *self;
        Memo::new(move |_| {
            let mut groups: Vec<(G, Vec<K>)> = Vec::new();
            store.keys.with(|keys| {
                for &key in keys {
                    let Some(signal) = store.get(key) else {
                        continue;
                    };
                    let name = signal.with(group);
                    match groups.iter_mut().find(|(existing, _)| *existing == name) {
                        Some((_, members)) => members.push(key),
                        None => groups.push((name, vec![key])),
                    }
                }
            });
            groups
        })
    }

    /// 符合 `keep` 的鍵，依鍵的順序；`keep` 可以讀其他 signal（例如 Schedule_Tab 選定的日子）。
    /// 移出或移入顯示範圍的列只被移除或只被建立（需求 14.3）。
    pub fn filtered(&self, keep: impl Fn(&T) -> bool + Send + Sync + 'static) -> Memo<Vec<K>> {
        let store = *self;
        Memo::new(move |_| {
            store.keys.with(|keys| {
                keys.iter()
                    .copied()
                    .filter(|&key| store.get(key).is_some_and(|signal| signal.with(&keep)))
                    .collect()
            })
        })
    }

    fn resort(&self) {
        let sorted: Vec<K> = self.rows.with_value(|map| {
            let mut entries: Vec<(S, K)> = map
                .iter()
                .map(|(key, signal)| signal.with_untracked(|row| ((self.sort_key)(row), *key)))
                .collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            entries.into_iter().map(|(_, key)| key).collect()
        });
        if self.keys.with_untracked(|current| *current != sorted) {
            self.keys.set(sorted);
        }
    }
}

/// `grouped()` 的組，依顯示順序；給外層 `<For>` 的 `each`。
pub fn group_names<G, K>(groups: Memo<Vec<(G, Vec<K>)>>) -> impl Fn() -> Vec<G> + Copy
where
    G: Clone + Send + Sync + 'static,
    K: Send + Sync + 'static,
{
    move || groups.with(|groups| groups.iter().map(|(name, _)| name.clone()).collect())
}

/// `grouped()` 中 `name` 這一組的鍵（沒有這一組時是空的）；給內層 `<For>` 的 `each`。
pub fn group_keys<G, K>(groups: Memo<Vec<(G, Vec<K>)>>, name: G) -> impl Fn() -> Vec<K>
where
    G: PartialEq + Send + Sync + 'static,
    K: Clone + Send + Sync + 'static,
{
    move || {
        groups.with(|groups| {
            groups
                .iter()
                .find(|(existing, _)| *existing == name)
                .map(|(_, keys)| keys.clone())
                .unwrap_or_default()
        })
    }
}

// ── 每種列的排序鍵（design 4.3）──

/// `value` 在 `all`（Enum_Table 的順序）中的位置。
fn rank<E: PartialEq>(all: &[E], value: &E) -> u8 {
    all.iter()
        .position(|item| item == value)
        .unwrap_or(all.len()) as u8
}

/// 路線依日期、出發時間由早到晚，沒有出發時間的排在最後（需求 22.2），再依 ordinal。
/// 需求 22.2 的同一時間依車輛 Ordinal 由 Schedule_Tab 以車輛的 store 決定；這裡的鍵只讀路線本身。
pub type RouteOrder = (Date, bool, Option<Hm>, u64);
/// 活動依日期、時間與 ordinal。
pub type ActivityOrder = (Date, Hm, u64);
/// 料理依日期、餐次（一天中的順序）與 ordinal。
pub type MealOrder = (Date, u8, u64);
/// 採買依分類（`Category::ALL` 的順序）與 ordinal；裝備依範圍（個人、共用）與 ordinal。
pub type RankOrder = (u8, u64);
/// 支出與還款依日期由新到舊，同一天依 ordinal 由小到大（需求 29.1）。
pub type LedgerOrder = (Reverse<Date>, u64);

fn person_order(row: &Person) -> u64 {
    row.ordinal
}

fn vehicle_order(row: &Vehicle) -> u64 {
    row.ordinal
}

fn place_order(row: &Place) -> u64 {
    row.ordinal
}

fn route_order(row: &Route) -> RouteOrder {
    (row.day, row.depart.is_none(), row.depart, row.ordinal)
}

fn day_setting_order(row: &DaySetting) -> Date {
    row.day
}

fn activity_order(row: &Activity) -> ActivityOrder {
    (row.day, row.time, row.ordinal)
}

fn meal_order(row: &Meal) -> MealOrder {
    (row.day, rank(MealSlot::ALL, &row.slot), row.ordinal)
}

fn shopping_order(row: &ShoppingItem) -> RankOrder {
    (rank(Category::ALL, &row.category), row.ordinal)
}

fn gear_order(row: &GearItem) -> RankOrder {
    (rank(GearScope::ALL, &row.scope), row.ordinal)
}

fn departure_order(row: &Departure) -> PersonId {
    row.person
}

fn expense_order(row: &Expense) -> LedgerOrder {
    (Reverse(row.day), row.ordinal)
}

fn settlement_order(row: &Settlement) -> LedgerOrder {
    (Reverse(row.day), row.ordinal)
}

// ── TripStores ──

/// 每種列一個 `RowStore`；Trip_Card 只有一列，是一個 signal。
#[derive(Clone, Copy)]
pub struct TripStores {
    pub card: RwSignal<TripCard>,
    pub people: RowStore<PersonId, Person, u64>,
    pub vehicles: RowStore<VehicleId, Vehicle, u64>,
    pub places: RowStore<PlaceId, Place, u64>,
    pub routes: RowStore<RouteId, Route, RouteOrder>,
    pub day_settings: RowStore<Date, DaySetting, Date>,
    pub activities: RowStore<ActivityId, Activity, ActivityOrder>,
    pub meals: RowStore<MealId, Meal, MealOrder>,
    pub shopping: RowStore<ShoppingId, ShoppingItem, RankOrder>,
    pub gear: RowStore<GearId, GearItem, RankOrder>,
    pub departures: RowStore<PersonId, Departure, PersonId>,
    pub expenses: RowStore<ExpenseId, Expense, LedgerOrder>,
    pub settlements: RowStore<SettlementId, Settlement, LedgerOrder>,
}

fn entries<K: Copy, T: Clone>(map: &BTreeMap<K, T>) -> impl Iterator<Item = (K, T)> + '_ {
    map.iter().map(|(key, row)| (*key, row.clone()))
}

impl TripStores {
    /// 以 `state`（Optimistic_View）建立；signal 屬於目前的 Owner。
    pub fn new(state: &TripState) -> TripStores {
        TripStores {
            card: RwSignal::new(state.card.clone()),
            people: RowStore::new(person_order, entries(&state.people)),
            vehicles: RowStore::new(vehicle_order, entries(&state.vehicles)),
            places: RowStore::new(place_order, entries(&state.places)),
            routes: RowStore::new(route_order, entries(&state.routes)),
            day_settings: RowStore::new(day_setting_order, entries(&state.day_settings)),
            activities: RowStore::new(activity_order, entries(&state.activities)),
            meals: RowStore::new(meal_order, entries(&state.meals)),
            shopping: RowStore::new(shopping_order, entries(&state.shopping)),
            gear: RowStore::new(gear_order, entries(&state.gear)),
            departures: RowStore::new(departure_order, entries(&state.departures)),
            expenses: RowStore::new(expense_order, entries(&state.expenses)),
            settlements: RowStore::new(settlement_order, entries(&state.settlements)),
        }
    }

    /// Trip_Card 內容（不計 Row_Version）相同時不通知。
    pub fn sync_card(&self, next: TripCard) {
        if self.card.with_untracked(|old| old.same_content(&next)) {
            self.card.update_untracked(|old| *old = next);
        } else {
            self.card.set(next);
        }
    }

    /// 同步一列：`row` 為 `None` 表示 `slot` 這一列已刪除。Trip_Card 不會被刪除，`None` 時不變；
    /// 鍵的種類與 `slot` 不符（例如以 UUID 指每日設定）時不變。
    pub fn sync(&self, slot: Slot, row: Option<Row>) {
        match row {
            Some(row) => self.put(row),
            None => self.remove(slot),
        }
    }

    /// 使每個 store 與 `view` 相同（例如合併 Snapshot 之後）；內容沒有改變的列不通知。
    pub fn sync_state(&self, view: &TripState) {
        self.sync_card(view.card.clone());
        self.people.sync_all(&view.people);
        self.vehicles.sync_all(&view.vehicles);
        self.places.sync_all(&view.places);
        self.routes.sync_all(&view.routes);
        self.day_settings.sync_all(&view.day_settings);
        self.activities.sync_all(&view.activities);
        self.meals.sync_all(&view.meals);
        self.shopping.sync_all(&view.shopping);
        self.gear.sync_all(&view.gear);
        self.departures.sync_all(&view.departures);
        self.expenses.sync_all(&view.expenses);
        self.settlements.sync_all(&view.settlements);
    }

    fn put(&self, row: Row) {
        match row {
            Row::Card(row) => self.sync_card(row),
            Row::Person(row) => self.people.sync(row.id, Some(row)),
            Row::Vehicle(row) => self.vehicles.sync(row.id, Some(row)),
            Row::Place(row) => self.places.sync(row.id, Some(row)),
            Row::Route(row) => self.routes.sync(row.id, Some(row)),
            Row::DaySetting(row) => self.day_settings.sync(row.day, Some(row)),
            Row::Activity(row) => self.activities.sync(row.id, Some(row)),
            Row::Meal(row) => self.meals.sync(row.id, Some(row)),
            Row::Shopping(row) => self.shopping.sync(row.id, Some(row)),
            Row::Gear(row) => self.gear.sync(row.id, Some(row)),
            Row::Departure(row) => self.departures.sync(row.person, Some(row)),
            Row::Expense(row) => self.expenses.sync(row.id, Some(row)),
            Row::Settlement(row) => self.settlements.sync(row.id, Some(row)),
        }
    }

    fn remove(&self, (entity, key): Slot) {
        let id = match key {
            RowKey::Id(id) => id,
            RowKey::Day(day) => {
                if entity == Entity::DaySetting {
                    self.day_settings.sync(day, None);
                }
                return;
            }
        };
        match entity {
            Entity::Card | Entity::DaySetting => {}
            Entity::Person => self.people.sync(PersonId(id), None),
            Entity::Vehicle => self.vehicles.sync(VehicleId(id), None),
            Entity::Place => self.places.sync(PlaceId(id), None),
            Entity::Route => self.routes.sync(RouteId(id), None),
            Entity::Activity => self.activities.sync(ActivityId(id), None),
            Entity::Meal => self.meals.sync(MealId(id), None),
            Entity::Shopping => self.shopping.sync(ShoppingId(id), None),
            Entity::Gear => self.gear.sync(GearId(id), None),
            Entity::Departure => self.departures.sync(PersonId(id), None),
            Entity::Expense => self.expenses.sync(ExpenseId(id), None),
            Entity::Settlement => self.settlements.sync(SettlementId(id), None),
        }
    }
}
