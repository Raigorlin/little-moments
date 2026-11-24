//! 權限拒絕的範例測試（任務 8.16；需求 33.12）：以 `apply()` 比對每一種拒絕的種類與訊息與 Permission_Table 相同。
//!
//! 旅行是 `support::seed` 的示範旅行（套用一次採買同步的 `synced_seed()`），其中小安（`p1`）綁定 Trip_Owner 的帳號、阿哲（`p2`）綁定受邀旅伴的帳號，其他
//! 旅伴沒有綁定帳號。另外加入一筆支出與一筆還款，使刪除帳目的命令有目標；權限的判斷在找目標之前（需求 6.4），所以
//! 拒絕與目標是否存在無關。

mod support;

use std::collections::BTreeSet;

use lm_core::apply::{apply, Ctx, Mode};
use lm_core::command::{
    ActivityDraft, ActivityPatch, Command, DaySettingPatch, ExpenseDraft, ExpensePatch, GearDraft,
    GearPatch, Input, MealDraft, MealPatch, PersonPatch, Rejection, RouteDraft, SettlementDraft,
    SettlementPatch, ShoppingDraft, ShoppingPatch, TripPatch, VehicleDraft, VehiclePatch,
    DENY_LEDGER_REMOVAL, DENY_OTHER_PERSON, DENY_PACKING, DENY_REMOVAL, TRIP_NOT_FOUND,
};
use lm_core::ids::{ExpenseId, PlaceId, RouteId, SettlementId};
use lm_core::model::{
    ActivityKind, Category, Expense, ExpenseCategory, GearScope, MealSlot, Participation, Role,
    Row, Settlement, TripState,
};
use lm_core::rules::capabilities;

use support::commands::{actor, owner, CommitIds};
use support::ids::{id, Tag};
use support::seed::{activity, day, gear, item, meal, person, synced_seed, vehicle};

fn expense() -> ExpenseId {
    id(Tag::Expense, 1)
}

fn settlement() -> SettlementId {
    id(Tag::Settlement, 1)
}

/// 示範旅行：小安綁定 Trip_Owner、阿哲綁定受邀旅伴，另有一筆支出與一筆還款。
fn trip() -> TripState {
    let mut state = synced_seed();
    for n in [1, 2] {
        state.people.get_mut(&person(n)).expect("旅伴存在").bound = true;
    }
    let ordinal = state.max_ordinal() + 1;
    state.put(Row::Expense(Expense {
        id: expense(),
        day: day("2026-11-20"),
        title: "超市採買".to_owned(),
        amount_cents: 90_000,
        payer: person(1),
        participants: [person(1), person(2)].into_iter().collect(),
        category: ExpenseCategory::Food,
        note: String::new(),
        shopping_item: None,
        ordinal,
        version: 0,
    }));
    state.put(Row::Settlement(Settlement {
        id: settlement(),
        day: day("2026-11-22"),
        from: person(2),
        to: person(1),
        amount_cents: 45_000,
        note: String::new(),
        ordinal: ordinal + 1,
        version: 0,
    }));
    state
}

/// Trip_Owner（小安）。
fn owner_ctx() -> Ctx {
    Ctx {
        actor: owner(),
        caps: capabilities(owner(), owner(), Role::Member, Some(person(1))),
    }
}

/// 受邀旅伴（阿哲）。
fn collaborator() -> Ctx {
    Ctx {
        actor: actor(),
        caps: capabilities(owner(), actor(), Role::Member, Some(person(2))),
    }
}

/// 沒有綁定旅伴的 Admin。
fn unbound_admin() -> Ctx {
    Ctx {
        actor: actor(),
        caps: capabilities(owner(), actor(), Role::Admin, None),
    }
}

/// 不是成員也不是 Admin 的 Account。
fn outsider() -> Ctx {
    Ctx {
        actor: actor(),
        caps: capabilities(owner(), actor(), Role::Member, None),
    }
}

fn rejection(ctx: &Ctx, cmd: &Command) -> Option<Rejection> {
    apply(&trip(), ctx, Mode::Commit, &mut CommitIds::default(), cmd).err()
}

/// 每一種命令各一個，內容是合法的。
fn every_command() -> Vec<Command> {
    let n = 1000;
    vec![
        Command::UpdateTrip {
            patch: TripPatch {
                note: Some("帶外套".to_owned()),
                ..TripPatch::default()
            },
        },
        Command::AddPerson {
            id: id(Tag::Person, n),
            name: "小樹".to_owned(),
            role: String::new(),
            color: None,
        },
        Command::UpdatePerson {
            id: person(3),
            patch: PersonPatch {
                role: Some("料理長".to_owned()),
                ..PersonPatch::default()
            },
        },
        Command::RemovePerson { id: person(6) },
        Command::AddVehicle {
            id: id(Tag::Vehicle, n),
            draft: VehicleDraft {
                name: "露營車".to_owned(),
                driver: None,
                seats: Some(Input::Ok(4)),
                color: None,
                passengers: BTreeSet::new(),
            },
        },
        Command::UpdateVehicle {
            id: vehicle(1),
            patch: VehiclePatch {
                name: Some("小巴".to_owned()),
                ..VehiclePatch::default()
            },
        },
        Command::RemoveVehicle { id: vehicle(2) },
        Command::AddPlace {
            id: id(Tag::Place, n),
            name: "山下超市".to_owned(),
            template: None,
        },
        Command::RenamePlace {
            id: id::<PlaceId>(Tag::Place, n),
            name: "超市".to_owned(),
        },
        Command::RemovePlace {
            id: id::<PlaceId>(Tag::Place, n),
        },
        Command::SaveRoute {
            route: RouteDraft {
                id: id::<RouteId>(Tag::Route, n),
                day: day("2026-11-20"),
                vehicle: Some(vehicle(1)),
                from: Some(lm_core::model::PlaceRef::Destination),
                to: Some(lm_core::model::PlaceRef::Destination),
                depart: None,
                stops: Vec::new(),
            },
        },
        Command::RemoveRoute {
            id: id::<RouteId>(Tag::Route, n),
        },
        Command::SaveDaySetting {
            day: day("2026-11-21"),
            patch: DaySettingPatch {
                title: Some(Some("森林日".to_owned())),
                ..DaySettingPatch::default()
            },
        },
        Command::AddActivities {
            day: day("2026-11-21"),
            items: vec![ActivityDraft {
                id: id(Tag::Activity, n),
                time: Some(Input::Ok(lm_core::time::Hm::new(8, 0).expect("時刻"))),
                title: "起床".to_owned(),
                kind: Input::Ok(ActivityKind::Wake),
                location: String::new(),
                note: String::new(),
                who: Participation::Everyone,
            }],
        },
        Command::UpdateActivity {
            id: activity(1),
            patch: ActivityPatch {
                note: Some("早點到".to_owned()),
                ..ActivityPatch::default()
            },
        },
        Command::RemoveActivity { id: activity(2) },
        Command::SetActivityDone {
            id: activity(3),
            done: true,
        },
        Command::AddMeal {
            id: id(Tag::Meal, n),
            draft: MealDraft {
                day: day("2026-11-21"),
                slot: Input::Ok(MealSlot::Lunch),
                time: None,
                title: "炒飯".to_owned(),
                cook: None,
                servings: Input::Ok(4),
                ingredients: "雞蛋".to_owned(),
                notes: String::new(),
                dish: None,
            },
        },
        Command::UpdateMeal {
            id: meal(1),
            patch: MealPatch {
                servings: Some(Input::Ok(5)),
                ..MealPatch::default()
            },
        },
        Command::RemoveMeal { id: meal(4) },
        Command::RemoveIngredientFromMeals {
            item: item(7),
            meals: [meal(2)].into_iter().collect(),
        },
        Command::AddShoppingItem {
            id: id(Tag::Shopping, n),
            draft: ShoppingDraft {
                name: "木炭".to_owned(),
                quantity: "1 包".to_owned(),
                category: Category::Other,
                assignee: None,
            },
        },
        Command::UpdateShoppingItem {
            id: item(1),
            patch: ShoppingPatch {
                quantity: Some("3 盒".to_owned()),
                ..ShoppingPatch::default()
            },
        },
        Command::RemoveShoppingItem { id: item(12) },
        Command::SetShoppingPurchased {
            id: item(1),
            purchased: true,
        },
        Command::AddGear {
            id: id(Tag::Gear, n),
            draft: GearDraft {
                name: "頭燈".to_owned(),
                quantity: String::new(),
                scope: GearScope::Personal,
                assignee: None,
            },
        },
        Command::UpdateGear {
            id: gear(1),
            patch: GearPatch {
                quantity: Some("2 個".to_owned()),
                ..GearPatch::default()
            },
        },
        Command::RemoveGear { id: gear(11) },
        Command::SetGearPacked {
            id: gear(1),
            person: person(1),
            packed: true,
        },
        Command::SetDeparted {
            person: person(1),
            departed: false,
        },
        Command::AddExpense {
            id: id(Tag::Expense, n),
            draft: ExpenseDraft {
                day: day("2026-11-21"),
                title: "油錢".to_owned(),
                amount_cents: 120_000,
                payer: Some(person(1)),
                participants: [person(1), person(2)].into_iter().collect(),
                category: Input::Ok(ExpenseCategory::Transport),
                note: String::new(),
                shopping_item: None,
            },
        },
        Command::UpdateExpense {
            id: expense(),
            patch: ExpensePatch {
                note: Some("含停車費".to_owned()),
                ..ExpensePatch::default()
            },
        },
        Command::RemoveExpense { id: expense() },
        Command::AddSettlement {
            id: id(Tag::Settlement, n),
            draft: SettlementDraft {
                day: day("2026-11-22"),
                from: Some(person(2)),
                to: Some(person(1)),
                amount_cents: 10_000,
                note: String::new(),
            },
        },
        Command::UpdateSettlement {
            id: settlement(),
            patch: SettlementPatch {
                note: Some("現金".to_owned()),
                ..SettlementPatch::default()
            },
        },
        Command::RemoveSettlement { id: settlement() },
    ]
}

/// 需求 33.12：不是 Trip_Member 也不是 Admin 的 Account 送出任一種 Command 時為 404「找不到這趟旅行。」。
#[test]
fn outsiders_get_trip_not_found_for_every_command() {
    let commands = every_command();
    assert_eq!(commands.len(), 36, "每一種命令各一個");
    for cmd in &commands {
        assert_eq!(
            rejection(&outsider(), cmd),
            Some(Rejection::not_found(TRIP_NOT_FOUND)),
            "{cmd:?}"
        );
    }
}

/// 對照：同樣的命令由 Trip_Owner 送出時都不因權限被拒絕（打包與出發確認是他自己的旅伴）。
#[test]
fn the_owner_is_not_denied_by_the_permission_table() {
    for cmd in every_command() {
        let denied = matches!(
            rejection(&owner_ctx(), &cmd),
            Some(Rejection::Forbidden { .. })
        ) || rejection(&owner_ctx(), &cmd)
            == Some(Rejection::not_found(TRIP_NOT_FOUND));
        assert!(!denied, "{cmd:?}: {:?}", rejection(&owner_ctx(), &cmd));
    }
}

/// 需求 33.12：Collaborator 移除旅伴，或刪除車輛、料理、採買品項或裝備時為 403。
#[test]
fn collaborators_cannot_remove_people_vehicles_meals_items_or_gear() {
    for cmd in [
        Command::RemovePerson { id: person(6) },
        Command::RemoveVehicle { id: vehicle(2) },
        Command::RemoveMeal { id: meal(4) },
        Command::RemoveShoppingItem { id: item(12) },
        Command::RemoveGear { id: gear(11) },
        // 目標不存在時也是 403（需求 6.4、26.16）
        Command::RemoveShoppingItem {
            id: id(Tag::Shopping, 1000),
        },
    ] {
        assert_eq!(
            rejection(&collaborator(), &cmd),
            Some(Rejection::forbidden(DENY_REMOVAL)),
            "{cmd:?}"
        );
    }
}

/// 需求 33.12：Trip_Manager 或 Collaborator 變更其他旅伴的打包或出發確認時為 403。
#[test]
fn nobody_changes_another_persons_packing_or_departure() {
    for (ctx, other) in [(owner_ctx(), person(2)), (collaborator(), person(1))] {
        for cmd in [
            Command::SetGearPacked {
                id: gear(1),
                person: other,
                packed: true,
            },
            Command::SetDeparted {
                person: other,
                departed: true,
            },
        ] {
            assert_eq!(
                rejection(&ctx, &cmd),
                Some(Rejection::forbidden(DENY_PACKING)),
                "{cmd:?}"
            );
        }
    }
    // 沒有 Bound_Person 的 Unbound_Admin 對任何旅伴都是這個回應（需求 6.7）
    assert_eq!(
        rejection(
            &unbound_admin(),
            &Command::SetDeparted {
                person: person(3),
                departed: false
            }
        ),
        Some(Rejection::forbidden(DENY_PACKING))
    );
}

/// 需求 33.12：Collaborator 修改綁定其他 Account 的旅伴時為 403；修改自己與沒有綁定帳號的旅伴照常執行。
#[test]
fn collaborators_only_edit_themselves_and_unbound_people() {
    let rename = |id| Command::UpdatePerson {
        id,
        patch: PersonPatch {
            role: Some("司機".to_owned()),
            ..PersonPatch::default()
        },
    };
    assert_eq!(
        rejection(&collaborator(), &rename(person(1))),
        Some(Rejection::forbidden(DENY_OTHER_PERSON))
    );
    assert_eq!(rejection(&collaborator(), &rename(person(2))), None);
    assert_eq!(rejection(&collaborator(), &rename(person(3))), None);
    // Trip_Manager 可以修改任何旅伴
    assert_eq!(rejection(&owner_ctx(), &rename(person(2))), None);
}

/// 需求 33.12：Collaborator 刪除支出或還款時為 403。
#[test]
fn collaborators_cannot_remove_ledger_rows() {
    for cmd in [
        Command::RemoveExpense { id: expense() },
        Command::RemoveSettlement { id: settlement() },
    ] {
        assert_eq!(
            rejection(&collaborator(), &cmd),
            Some(Rejection::forbidden(DENY_LEDGER_REMOVAL)),
            "{cmd:?}"
        );
    }
}

/// 需求 33.12：Unbound_Admin 新增、修改或刪除支出或還款時為 404「找不到這趟旅行。」。
#[test]
fn unbound_admins_cannot_touch_the_ledger() {
    let ledger: Vec<Command> = every_command()
        .into_iter()
        .filter(|cmd| {
            matches!(
                cmd,
                Command::AddExpense { .. }
                    | Command::UpdateExpense { .. }
                    | Command::RemoveExpense { .. }
                    | Command::AddSettlement { .. }
                    | Command::UpdateSettlement { .. }
                    | Command::RemoveSettlement { .. }
            )
        })
        .collect();
    assert_eq!(ledger.len(), 6);
    for cmd in &ledger {
        assert_eq!(
            rejection(&unbound_admin(), cmd),
            Some(Rejection::not_found(TRIP_NOT_FOUND)),
            "{cmd:?}"
        );
    }
}
