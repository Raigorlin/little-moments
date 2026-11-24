//! Property 12 的屬性測試（任務 8.13；需求 7.5–7.7、33.5、33.6）：不同欄位的 patch 可交換，同一欄位以提交順序決定。
//!
//! 輸入是 `arb_valid_state()` 中既有的一列，以及兩個修改它的 patch p₁、p₂：車輛（名稱、駕駛、座位、顏色與乘客的加入、
//! 移除）、活動（標題、時間、地點、備註與指定旅伴的加入、移除）、料理（名稱、份數、筆記與負責人）、每日設定（標題、
//! 地點、預計抵達時間、抵達說明與路線位置）與支出（標題、金額、備註與分攤旅伴的加入、移除）。值多數是合法的；依 p₁p₂ 與 p₂p₁
//! 兩種順序（各自套用到前一次的結果）都成功時：
//!
//! - 兩者修改的欄位不相交：兩種順序得到相同的狀態；
//! - 修改同一欄位：結果等於後套用者的值，也就是只套用後者時那個欄位的值。集合欄位的每個元素各算一個欄位，所以
//!   不同元素的加入與移除可以交換，同一個元素一個加入、一個移除時以後套用者為準（需求 7.7）。
//!
//! 每日設定只修改既有的設定，而且只產生設定值、不清空的 patch：標題、地點與預計抵達時間都未設定時，那一天的設定
//! 被刪除、路線位置回到 before（需求 22.11），例如只設定路線位置的 patch 不會留下設定；這是需求 22.11 的規則，
//! 不是欄位的合併。
//!
//! 使用 proptest 的預設設定（256 個案例，設定 `PROPTEST_CASES=N` 時為 N 個），不覆寫案例數；proptest 找到的失敗案例
//! 寫在同一個目錄的 `prop_patch_commute.proptest-regressions`，這個檔案提交進版本庫（需求 33.6）。

mod support;

use std::collections::BTreeSet;

use lm_core::apply::{apply, Ctx, Mode};
use lm_core::command::{
    ActivityPatch, Command, DaySettingPatch, ExpensePatch, Input, MealPatch, VehiclePatch,
};
use lm_core::ids::PersonId;
use lm_core::model::{Entity, RoutePosition, RowKey, Slot, TripState};
use proptest::collection::btree_set;
use proptest::option;
use proptest::prelude::*;
use proptest::sample::{select, Index};
use proptest::strategy::Union;
use serde_json::Value;

use support::commands::{arb_valid_state, caps_of, ctx_of, CommitIds, Identity};
use support::state::{arb_amount_cents, arb_hm};
use support::vocab::{
    ACTIVITY_LOCATIONS, ACTIVITY_NOTES, ACTIVITY_TITLES, ARRIVAL_LABELS, DAY_TITLES,
    EXPENSE_TITLES, LEDGER_NOTES, MEAL_NOTES, MEAL_TITLES, VEHICLE_COLORS, VEHICLE_NAMES,
};

/// patch 修改的欄位；集合欄位的元素寫成「欄位:元素」。
type Fields = BTreeSet<String>;

/// 一個案例：要修改的列與兩個修改它的命令。
#[derive(Clone, Debug)]
struct Case {
    slot: Slot,
    first: (Command, Fields),
    second: (Command, Fields),
}

/// 以 `ctx` 執行 `cmd`，成功時回傳套用效果之後的狀態。
fn run(state: &TripState, ctx: &Ctx, cmd: &Command) -> Option<TripState> {
    let outcome = apply(state, ctx, Mode::Commit, &mut CommitIds::default(), cmd).ok()?;
    let mut next = state.clone();
    next.apply_effects(&outcome.effects());
    Some(next)
}

/// `slot` 的列的 `field`：一般欄位是那個欄位的 JSON 值；集合的元素是它是否在集合中。
fn field_value(state: &TripState, slot: Slot, field: &str) -> Value {
    let row = state
        .get(slot)
        .map(|row| serde_json::to_value(row).expect("列可以序列化")["row"].clone())
        .unwrap_or(Value::Null);
    match field.split_once(':') {
        None => row[field].clone(),
        Some((set, element)) => {
            let members = match set {
                // 活動的參加者：{"mode":"people","ids":[…]}
                "people" if row["who"]["mode"] == "people" => row["who"]["ids"].clone(),
                "people" => Value::Array(Vec::new()),
                _ => row[set].clone(),
            };
            let present = members
                .as_array()
                .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(element)));
            Value::Bool(present)
        }
    }
}

/// 名稱加上集合元素的欄位。
fn fields(scalar: &[(&str, bool)], sets: &[(&str, &BTreeSet<PersonId>)]) -> Fields {
    let mut fields: Fields = scalar
        .iter()
        .filter(|(_, present)| *present)
        .map(|(name, _)| (*name).to_owned())
        .collect();
    for (set, ids) in sets {
        fields.extend(ids.iter().map(|id| format!("{set}:{id}")));
    }
    fields
}

/// 一組旅伴（最多 2 位）。
fn some_people(people: &[PersonId]) -> BoxedStrategy<BTreeSet<PersonId>> {
    if people.is_empty() {
        Just(BTreeSet::new()).boxed()
    } else {
        btree_set(select(people.to_vec()), 0..=2).boxed()
    }
}

fn vehicle_patch(people: &[PersonId]) -> BoxedStrategy<(Command, Fields)> {
    let driver = if people.is_empty() {
        Just(None).boxed()
    } else {
        option::of(option::of(select(people.to_vec()))).boxed()
    };
    (
        option::of(select(VEHICLE_NAMES).prop_map(str::to_owned)),
        driver,
        option::of(1_u8..=9),
        option::of(option::of(select(VEHICLE_COLORS).prop_map(str::to_owned))),
        some_people(people),
        some_people(people),
    )
        .prop_map(|(name, driver, seats, color, add, remove)| {
            let f = fields(
                &[
                    ("name", name.is_some()),
                    ("driver", driver.is_some()),
                    ("seats", seats.is_some()),
                    ("color", color.is_some()),
                ],
                &[("passengers", &add), ("passengers", &remove)],
            );
            let patch = VehiclePatch {
                name,
                driver,
                seats: seats.map(Input::Ok),
                color,
                passengers_add: add,
                passengers_remove: remove,
            };
            (
                Command::UpdateVehicle {
                    id: lm_core::ids::VehicleId(uuid::Uuid::nil()),
                    patch,
                },
                f,
            )
        })
        .boxed()
}

fn activity_patch(people: &[PersonId]) -> BoxedStrategy<(Command, Fields)> {
    (
        option::of(select(ACTIVITY_TITLES).prop_map(str::to_owned)),
        option::of(arb_hm()),
        option::of(select(ACTIVITY_LOCATIONS).prop_map(str::to_owned)),
        option::of(select(ACTIVITY_NOTES).prop_map(str::to_owned)),
        some_people(people),
        some_people(people),
    )
        .prop_map(|(title, time, location, note, add, remove)| {
            let f = fields(
                &[
                    ("title", title.is_some()),
                    ("time", time.is_some()),
                    ("location", location.is_some()),
                    ("note", note.is_some()),
                ],
                &[("people", &add), ("people", &remove)],
            );
            let patch = ActivityPatch {
                title,
                time: time.map(|hm| Some(Input::Ok(hm))),
                location,
                note,
                people_add: add,
                people_remove: remove,
                ..ActivityPatch::default()
            };
            (
                Command::UpdateActivity {
                    id: lm_core::ids::ActivityId(uuid::Uuid::nil()),
                    patch,
                },
                f,
            )
        })
        .boxed()
}

fn meal_patch(people: &[PersonId]) -> BoxedStrategy<(Command, Fields)> {
    let cook = if people.is_empty() {
        Just(None).boxed()
    } else {
        option::of(option::of(select(people.to_vec()))).boxed()
    };
    (
        option::of(select(MEAL_TITLES).prop_map(str::to_owned)),
        option::of(1_u8..=12),
        option::of(select(MEAL_NOTES).prop_map(str::to_owned)),
        cook,
    )
        .prop_map(|(title, servings, notes, cook)| {
            let f = fields(
                &[
                    ("title", title.is_some()),
                    ("servings", servings.is_some()),
                    ("notes", notes.is_some()),
                    ("cook", cook.is_some()),
                ],
                &[],
            );
            let patch = MealPatch {
                title,
                servings: servings.map(Input::Ok),
                notes,
                cook,
                ..MealPatch::default()
            };
            (
                Command::UpdateMeal {
                    id: lm_core::ids::MealId(uuid::Uuid::nil()),
                    patch,
                },
                f,
            )
        })
        .boxed()
}

fn day_setting_patch(places: &[lm_core::ids::PlaceId]) -> BoxedStrategy<(Command, Fields)> {
    let place = if places.is_empty() {
        Just(None).boxed()
    } else {
        option::of(select(places.to_vec()).prop_map(Some)).boxed()
    };
    (
        option::of(select(DAY_TITLES).prop_map(|t| Some(t.to_owned()))),
        place,
        option::of(arb_hm().prop_map(|hm| Some(Input::Ok(hm)))),
        option::of(select(RoutePosition::ALL).prop_map(Input::Ok)),
        option::of(select(ARRIVAL_LABELS).prop_map(|t| Some(t.to_owned()))),
    )
        .prop_map(|(title, place, arrival, route_position, arrival_label)| {
            let f = fields(
                &[
                    ("title", title.is_some()),
                    ("place", place.is_some()),
                    ("arrival", arrival.is_some()),
                    ("route_position", route_position.is_some()),
                    ("arrival_label", arrival_label.is_some()),
                ],
                &[],
            );
            let patch = DaySettingPatch {
                title,
                place,
                arrival,
                arrival_label,
                route_position,
            };
            let day = lm_core::model::Date::MIN;
            (Command::SaveDaySetting { day, patch }, f)
        })
        .boxed()
}

fn expense_patch(people: &[PersonId]) -> BoxedStrategy<(Command, Fields)> {
    (
        option::of(select(EXPENSE_TITLES).prop_map(str::to_owned)),
        option::of(arb_amount_cents()),
        option::of(select(LEDGER_NOTES).prop_map(str::to_owned)),
        some_people(people),
        some_people(people),
    )
        .prop_map(|(title, amount_cents, note, add, remove)| {
            let f = fields(
                &[
                    ("title", title.is_some()),
                    ("amount_cents", amount_cents.is_some()),
                    ("note", note.is_some()),
                ],
                &[("participants", &add), ("participants", &remove)],
            );
            let patch = ExpensePatch {
                title,
                amount_cents,
                note,
                participants_add: add,
                participants_remove: remove,
                ..ExpensePatch::default()
            };
            (
                Command::UpdateExpense {
                    id: lm_core::ids::ExpenseId(uuid::Uuid::nil()),
                    patch,
                },
                f,
            )
        })
        .boxed()
}

/// 把命令的目標換成 `slot` 的列。
fn aimed((cmd, fields): (Command, Fields), slot: Slot) -> (Command, Fields) {
    let key = slot.1;
    let uuid = match key {
        RowKey::Id(id) => id,
        RowKey::Day(_) => uuid::Uuid::nil(),
    };
    let cmd = match cmd {
        Command::UpdateVehicle { patch, .. } => Command::UpdateVehicle {
            id: uuid.into(),
            patch,
        },
        Command::UpdateActivity { patch, .. } => Command::UpdateActivity {
            id: uuid.into(),
            patch,
        },
        Command::UpdateMeal { patch, .. } => Command::UpdateMeal {
            id: uuid.into(),
            patch,
        },
        Command::UpdateExpense { patch, .. } => Command::UpdateExpense {
            id: uuid.into(),
            patch,
        },
        Command::SaveDaySetting { patch, .. } => match key {
            RowKey::Day(day) => Command::SaveDaySetting { day, patch },
            RowKey::Id(_) => unreachable!("每日設定以日期為鍵"),
        },
        other => other,
    };
    (cmd, fields)
}

/// 一種有既有列的命令，以及兩個修改同一列的 patch。
fn arb_pair(state: &TripState) -> BoxedStrategy<Case> {
    let people: Vec<PersonId> = state.people.keys().copied().collect();
    let places: Vec<lm_core::ids::PlaceId> = state.places.keys().copied().collect();
    let mut arms: Vec<BoxedStrategy<Case>> = Vec::new();
    let mut add = |slots: Vec<Slot>, patch: BoxedStrategy<(Command, Fields)>| {
        if slots.is_empty() {
            return;
        }
        arms.push(
            (select(slots), patch.clone(), patch)
                .prop_map(|(slot, first, second)| Case {
                    slot,
                    first: aimed(first, slot),
                    second: aimed(second, slot),
                })
                .boxed(),
        );
    };
    let ids = |entity: Entity, keys: Vec<uuid::Uuid>| -> Vec<Slot> {
        keys.into_iter()
            .map(|id| (entity, RowKey::Id(id)))
            .collect()
    };
    add(
        ids(
            Entity::Vehicle,
            state.vehicles.keys().map(|k| k.0).collect(),
        ),
        vehicle_patch(&people),
    );
    add(
        ids(
            Entity::Activity,
            state.activities.keys().map(|k| k.0).collect(),
        ),
        activity_patch(&people),
    );
    add(
        ids(Entity::Meal, state.meals.keys().map(|k| k.0).collect()),
        meal_patch(&people),
    );
    add(
        ids(
            Entity::Expense,
            state.expenses.keys().map(|k| k.0).collect(),
        ),
        expense_patch(&people),
    );
    // 既有的每日設定至少設定了標題、地點與預計抵達時間其中一項，patch 又不清空欄位，所以不會被刪除
    let days = state
        .day_settings
        .keys()
        .map(|&day| (Entity::DaySetting, RowKey::Day(day)))
        .collect();
    add(days, day_setting_patch(&places));
    Union::new(arms).boxed()
}

fn arb_case() -> impl Strategy<Value = (TripState, Ctx, Case)> {
    arb_valid_state()
        .prop_filter("至少有一種可以修改的列", |state| {
            !state.people.is_empty()
        })
        .prop_flat_map(|state| {
            let pair = arb_pair(&state);
            (Just(state), any::<Index>(), pair)
        })
        .prop_map(|(state, me, case)| {
            let ctx = ctx_of(caps_of(&state, Identity::Owner, me));
            (state, ctx, case)
        })
}

// Feature: rust-supabase-rewrite, Property 12: 不同欄位的 patch 可交換，同一欄位以提交順序決定
proptest! {
    /// *For any* 一列與兩個 patch p₁、p₂：若兩者修改的欄位不相交，依 p₁p₂ 與 p₂p₁ 的順序套用得到相同的列；若修改
    /// 同一欄位，結果等於後套用者的值。對集合欄位（乘客、參加者），不同元素的加入與移除也可交換。
    ///
    /// **Validates: Requirements 7.5, 7.6, 7.7**
    #[test]
    fn patches_commute_by_field((state, ctx, case) in arb_case()) {
        let (c1, f1) = &case.first;
        let (c2, f2) = &case.second;
        let (Some(only1), Some(only2)) = (run(&state, &ctx, c1), run(&state, &ctx, c2)) else {
            return Ok(());
        };
        let (Some(s12), Some(s21)) = (run(&only1, &ctx, c2), run(&only2, &ctx, c1)) else {
            return Ok(());
        };
        let shared: Fields = f1.intersection(f2).cloned().collect();
        if shared.is_empty() {
            prop_assert_eq!(&s12, &s21, "{:?} 與 {:?} 修改不同的欄位，兩種順序的結果應該相同", c1, c2);
        }
        for field in &shared {
            prop_assert_eq!(
                field_value(&s12, case.slot, field),
                field_value(&only2, case.slot, field),
                "先 {:?} 再 {:?} 時，{} 應該是後者的值",
                c1,
                c2,
                field
            );
            prop_assert_eq!(
                field_value(&s21, case.slot, field),
                field_value(&only1, case.slot, field),
                "先 {:?} 再 {:?} 時，{} 應該是後者的值",
                c2,
                c1,
                field
            );
        }
    }
}
