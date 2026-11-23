//! Property 7 的屬性測試（任務 8.10；需求 7.11–7.13、23.6、26.9、27.6、28.2、28.4、33.5、33.6）：勾選是冪等的集合
//! 操作。
//!
//! 輸入是 `arb_valid_state()`（`arb_state()` 套用一次採買同步，滿足 I1–I12）與四種勾選命令：`SetShoppingPurchased`、
//! `SetGearPacked`、`SetDeparted` 與 `SetActivityDone`。打包與出發確認多數以送出者自己的旅伴送出，使它們通過權限檢查。
//! 檢查：
//!
//! - 冪等：`apply(s, c)` 成功得到 s₁ 時，`apply(s₁, c)` 成功且 `is_noop()`；目標的值等於 c 指定的值，與 s 中原本的
//!   值無關。
//! - 可交換：指向不同（項目、旅伴）組合的兩個勾選命令，依兩種順序都成功時得到相同的狀態。需求 7.13 的例外（同一位
//!   旅伴先確認出發、再打包）在出發確認的那一步就被拒絕，所以不在「兩種順序都成功」之中。
//! - 刪除也是冪等的：要刪除的列已不存在時，通過權限檢查的刪除命令回傳 `is_noop()`，主要效果與衍生效果都是空的。
//!
//! 使用 proptest 的預設設定（256 個案例，設定 `PROPTEST_CASES=N` 時為 N 個），不覆寫案例數；proptest 找到的失敗案例
//! 寫在同一個目錄的 `prop_check_commands.proptest-regressions`，這個檔案提交進版本庫（需求 33.6）。

mod support;

use lm_core::apply::{apply, Ctx, Mode};
use lm_core::command::Command;
use lm_core::ids::{
    ActivityId, ExpenseId, GearId, MealId, PersonId, PlaceId, RouteId, SettlementId, ShoppingId,
    VehicleId,
};
use lm_core::model::TripState;
use lm_core::rules::authorize;
use proptest::prelude::*;
use proptest::sample::select;
use proptest::strategy::Union;

use support::commands::{arb_caps, arb_valid_state, caps_of, ctx_of, CommitIds, Identity};
use support::ids::{id, Tag};

/// 以 `ctx` 執行 `cmd`，成功時回傳套用效果之後的狀態。
fn run(state: &TripState, ctx: &Ctx, cmd: &Command) -> Option<TripState> {
    let outcome = apply(state, ctx, Mode::Commit, &mut CommitIds::default(), cmd).ok()?;
    let mut next = state.clone();
    next.apply_effects(&outcome.effects());
    Some(next)
}

/// 一個勾選命令：既有的採買品項、活動與裝備；打包與出發確認多數是 `me`，有時是其他旅伴。
fn arb_check(state: &TripState, me: Option<PersonId>) -> BoxedStrategy<Command> {
    let items: Vec<ShoppingId> = state.shopping.keys().copied().collect();
    let activities: Vec<ActivityId> = state.activities.keys().copied().collect();
    let gear: Vec<GearId> = state.gear.keys().copied().collect();
    let people: Vec<PersonId> = state.people.keys().copied().collect();
    let person: BoxedStrategy<PersonId> = match (me, people.is_empty()) {
        (Some(me), true) => Just(me).boxed(),
        (Some(me), false) => prop_oneof![4 => Just(me), 1 => select(people.clone())].boxed(),
        (None, false) => select(people.clone()).boxed(),
        (None, true) => Just(id(Tag::Person, 1000)).boxed(),
    };
    let mut arms: Vec<BoxedStrategy<Command>> = vec![(person.clone(), any::<bool>())
        .prop_map(|(person, departed)| Command::SetDeparted { person, departed })
        .boxed()];
    if !items.is_empty() {
        arms.push(
            (select(items), any::<bool>())
                .prop_map(|(id, purchased)| Command::SetShoppingPurchased { id, purchased })
                .boxed(),
        );
    }
    if !activities.is_empty() {
        arms.push(
            (select(activities), any::<bool>())
                .prop_map(|(id, done)| Command::SetActivityDone { id, done })
                .boxed(),
        );
    }
    if !gear.is_empty() {
        arms.push(
            (select(gear), person, any::<bool>())
                .prop_map(|(id, person, packed)| Command::SetGearPacked { id, person, packed })
                .boxed(),
        );
    }
    Union::new(arms).boxed()
}

/// 勾選命令的目標：（種類、項目、旅伴）。
fn target(cmd: &Command) -> (u8, uuid::Uuid, Option<PersonId>) {
    match cmd {
        Command::SetShoppingPurchased { id, .. } => (0, id.0, None),
        Command::SetActivityDone { id, .. } => (1, id.0, None),
        Command::SetGearPacked { id, person, .. } => (2, id.0, Some(*person)),
        Command::SetDeparted { person, .. } => (3, person.0, Some(*person)),
        _ => unreachable!("只產生勾選命令"),
    }
}

/// 目標的值是否等於命令指定的值。
fn holds(state: &TripState, cmd: &Command) -> bool {
    match cmd {
        Command::SetShoppingPurchased { id, purchased } => {
            state.shopping[id].purchased == *purchased
        }
        Command::SetActivityDone { id, done } => state.activities[id].done == *done,
        Command::SetGearPacked { id, person, packed } => {
            state.gear[id].packed_by.contains(person) == *packed
        }
        Command::SetDeparted { person, departed } => {
            state.departures.contains_key(person) == *departed
        }
        _ => unreachable!("只產生勾選命令"),
    }
}

/// 有綁定旅伴的身分（擁有者、Admin 或 Collaborator）與勾選命令。
fn arb_check_case(count: usize) -> impl Strategy<Value = (TripState, Ctx, Vec<Command>)> {
    arb_valid_state().prop_flat_map(move |state| {
        let identity = select(vec![
            Identity::Owner,
            Identity::Admin,
            Identity::Collaborator,
        ]);
        (Just(state), identity, any::<proptest::sample::Index>()).prop_flat_map(
            move |(state, identity, me)| {
                let caps = caps_of(&state, identity, me);
                let commands = proptest::collection::vec(arb_check(&state, caps.me), count);
                (Just(state), Just(ctx_of(caps)), commands)
            },
        )
    })
}

/// 一種刪除命令，目標是不存在的列。
fn arb_missing_delete() -> impl Strategy<Value = Command> {
    let n = 1000;
    select(vec![
        Command::RemovePerson {
            id: id::<PersonId>(Tag::Person, n),
        },
        Command::RemoveVehicle {
            id: id::<VehicleId>(Tag::Vehicle, n),
        },
        Command::RemovePlace {
            id: id::<PlaceId>(Tag::Place, n),
        },
        Command::RemoveRoute {
            id: id::<RouteId>(Tag::Route, n),
        },
        Command::RemoveActivity {
            id: id::<ActivityId>(Tag::Activity, n),
        },
        Command::RemoveMeal {
            id: id::<MealId>(Tag::Meal, n),
        },
        Command::RemoveShoppingItem {
            id: id::<ShoppingId>(Tag::Shopping, n),
        },
        Command::RemoveGear {
            id: id::<GearId>(Tag::Gear, n),
        },
        Command::RemoveExpense {
            id: id::<ExpenseId>(Tag::Expense, n),
        },
        Command::RemoveSettlement {
            id: id::<SettlementId>(Tag::Settlement, n),
        },
    ])
}

// Feature: rust-supabase-rewrite, Property 7: 勾選是冪等的集合操作
proptest! {
    /// *For any* 狀態 s 與任何勾選命令 c，若 `apply(s, c)` 成功得到 s₁，則 `apply(s₁, c)` 成功且 `is_noop()`；目標
    /// 欄位的最後值等於 c 指定的值，與 s 中原本的值無關。
    ///
    /// **Validates: Requirements 7.11, 7.12, 7.13, 23.6, 26.9, 27.6, 28.2, 28.4**
    #[test]
    fn a_check_command_sets_the_value_and_repeating_it_is_a_noop((state, ctx, commands) in arb_check_case(1)) {
        let cmd = &commands[0];
        let Ok(first) = apply(&state, &ctx, Mode::Commit, &mut CommitIds::default(), cmd) else {
            return Ok(());
        };
        let mut once = state.clone();
        once.apply_effects(&first.effects());
        prop_assert!(holds(&once, cmd), "{:?} 之後目標的值不是指定的值", cmd);
        let again = apply(&once, &ctx, Mode::Commit, &mut CommitIds::default(), cmd);
        prop_assert!(
            again.as_ref().is_ok_and(|outcome| outcome.is_noop()),
            "再執行一次 {:?} 應該成功而且沒有變化：{:?}",
            cmd,
            again
        );
    }

    /// *For any* 兩個指向不同（項目、旅伴）組合的勾選命令 c₁、c₂，依 c₁c₂ 或 c₂c₁ 的順序套用得到相同的狀態。
    ///
    /// **Validates: Requirements 7.11, 7.12, 7.13, 23.6, 26.9, 27.6, 28.2, 28.4**
    #[test]
    fn check_commands_on_different_targets_commute((state, ctx, commands) in arb_check_case(2)) {
        let (c1, c2) = (&commands[0], &commands[1]);
        prop_assume!(target(c1) != target(c2));
        let forward = run(&state, &ctx, c1).and_then(|s| run(&s, &ctx, c2));
        let backward = run(&state, &ctx, c2).and_then(|s| run(&s, &ctx, c1));
        if let (Some(forward), Some(backward)) = (forward, backward) {
            prop_assert_eq!(forward, backward, "{:?} 與 {:?} 依不同順序執行的結果不同", c1, c2);
        }
    }

    /// 要刪除的列已不存在時，通過權限檢查的刪除命令回傳 `is_noop()`，主要效果與衍生效果都是空的。
    ///
    /// **Validates: Requirements 7.12**
    #[test]
    fn deleting_a_missing_row_is_a_noop(
        (state, (_, caps)) in arb_valid_state().prop_flat_map(|state| {
            let caps = arb_caps(&state);
            (Just(state), caps)
        }),
        cmd in arb_missing_delete(),
    ) {
        prop_assume!(authorize(&state, &caps, &cmd).is_ok());
        let outcome = apply(&state, &ctx_of(caps), Mode::Commit, &mut CommitIds::default(), &cmd);
        prop_assert!(
            outcome.as_ref().is_ok_and(|outcome| outcome.is_noop() && outcome.created.is_empty()),
            "刪除不存在的列 {:?} 應該沒有變化：{:?}",
            cmd,
            outcome
        );
    }
}
