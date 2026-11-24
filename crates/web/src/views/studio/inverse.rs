//! 復原用的反向命令（rust-schedule-studio Decision D2）。
//!
//! 工作室的每一次編輯在送出之前，以 [`inverse`] 從送出當下的 Optimistic_View 計算反向命令：「復原」送出反向命令，
//! 「重做」再送出原本的命令。例如新增的路線反向是刪除它、修改路線是存回原本的整條路線、Patch 的反向是帶有原本的值
//! 的 Patch（原本沒有設定時是清空），刪除的列反向是以相同的 id 再新增一次。工作室不會送出的命令沒有反向命令。
//!
//! 這裡只有純函式（不讀取 signal、不接觸 DOM），所以在原生目標上測試。
use std::collections::BTreeSet;

use lm_core::command::{
    ActivityDraft, ActivityPatch, Command, DateSpan, DaySettingPatch, Input, MealDraft, MealPatch,
    RouteDraft, StopDraft, TripPatch, VehicleDraft, VehiclePatch,
};
use lm_core::ids::{PersonId, VehicleId};
use lm_core::model::{Activity, Date, Meal, Participation, Route, Stop, TripState, Vehicle};
use lm_core::time::date_range;

/// 停靠點目前的整份內容。
pub(super) fn stop_draft(stop: &Stop) -> StopDraft {
    StopDraft {
        id: stop.id,
        place: Some(stop.place),
        kind: Input::Ok(stop.kind),
        task: stop.task.map(Input::Ok),
        note: stop.note.clone(),
        time: stop.time.map(Input::Ok),
        items: stop.items.clone(),
    }
}

/// 路線目前的整份內容（`SaveRoute` 一次儲存整條路線）。
pub(super) fn route_draft(route: &Route) -> RouteDraft {
    RouteDraft {
        id: route.id,
        day: route.day,
        vehicle: Some(route.vehicle),
        from: Some(route.from),
        to: Some(route.to),
        depart: route.depart.map(Input::Ok),
        stops: route.stops.iter().map(stop_draft).collect(),
    }
}

/// 以相同的 id 再新增這個活動（完成狀態另以 `SetActivityDone` 還原）。
pub(super) fn activity_draft(activity: &Activity) -> ActivityDraft {
    ActivityDraft {
        id: activity.id,
        time: Some(Input::Ok(activity.time)),
        title: activity.title.clone(),
        kind: Input::Ok(activity.kind),
        location: activity.location.clone(),
        note: activity.note.clone(),
        who: activity.who.clone(),
    }
}

fn meal_draft(meal: &Meal) -> MealDraft {
    MealDraft {
        day: meal.day,
        slot: Input::Ok(meal.slot),
        time: meal.time.map(Input::Ok),
        title: meal.title.clone(),
        cook: meal.cook,
        servings: Input::Ok(meal.servings),
        ingredients: meal.ingredients.clone(),
        notes: meal.notes.clone(),
        dish: meal.dish.map(Input::Ok),
    }
}

fn vehicle_draft(vehicle: &Vehicle) -> VehicleDraft {
    VehicleDraft {
        name: vehicle.name.clone(),
        driver: vehicle.driver,
        seats: Some(Input::Ok(vehicle.seats)),
        color: vehicle.color.clone(),
        passengers: vehicle.passengers.clone(),
    }
}

/// 帶有 `patch` 改動的欄位原本的值的 `TripPatch`。縮短天數時，被刪掉的日子上的活動與料理搬到新的最後一天、那幾天的
/// 每日設定被刪除（`retime_by_day_index()`），所以另外把它們搬回原本的日期、存回原本的設定。
fn trip_inverse(s: &TripState, patch: &TripPatch) -> Vec<Command> {
    let card = &s.card;
    let old = TripPatch {
        title: patch.title.as_ref().map(|_| card.title.clone()),
        destination: patch.destination.as_ref().map(|_| card.destination.clone()),
        dates: patch.dates.map(|_| DateSpan {
            start: card.start,
            end: card.end,
        }),
        description: patch.description.as_ref().map(|_| card.description.clone()),
        note: patch.note.as_ref().map(|_| card.note.clone()),
        headline: patch.headline.as_ref().map(|_| card.headline.clone()),
        caption: patch.caption.as_ref().map(|_| card.caption.clone()),
        cover: patch.cover.as_ref().map(|_| Input::Ok(card.cover)),
        status: patch.status.as_ref().map(|_| Input::Ok(card.status)),
    };
    let mut out = vec![Command::UpdateTrip { patch: old }];
    let Some(dates) = patch.dates else {
        return out;
    };
    let old_days = date_range(card.start, card.end);
    let new_len = date_range(dates.start, dates.end).len();
    if new_len == 0 || new_len >= old_days.len() {
        return out;
    }
    let removed: BTreeSet<Date> = old_days[new_len..].iter().copied().collect();
    out.extend(
        s.activities_by_ordinal()
            .filter(|activity| removed.contains(&activity.day))
            .map(|activity| Command::UpdateActivity {
                id: activity.id,
                patch: ActivityPatch {
                    day: Some(activity.day),
                    ..ActivityPatch::default()
                },
            }),
    );
    out.extend(
        s.meals_by_ordinal()
            .filter(|meal| removed.contains(&meal.day))
            .map(|meal| Command::UpdateMeal {
                id: meal.id,
                patch: MealPatch {
                    day: Some(meal.day),
                    ..MealPatch::default()
                },
            }),
    );
    out.extend(
        s.day_settings
            .values()
            .filter(|setting| removed.contains(&setting.day))
            .map(|setting| Command::SaveDaySetting {
                day: setting.day,
                patch: DaySettingPatch {
                    title: Some(setting.title.clone()),
                    place: Some(setting.place),
                    arrival: Some(setting.arrival.map(Input::Ok)),
                    arrival_label: Some(setting.arrival_label.clone()),
                    route_position: Some(Input::Ok(setting.route_position)),
                },
            }),
    );
    out
}

/// 帶有 `patch` 改動的欄位原本的值；那一天原本沒有設定時是清空（`Some(None)`）與 before。
fn day_setting_inverse(s: &TripState, day: Date, patch: &DaySettingPatch) -> DaySettingPatch {
    let old = s.day_settings.get(&day);
    DaySettingPatch {
        title: patch
            .title
            .as_ref()
            .map(|_| old.and_then(|setting| setting.title.clone())),
        place: patch
            .place
            .as_ref()
            .map(|_| old.and_then(|setting| setting.place)),
        arrival: patch
            .arrival
            .as_ref()
            .map(|_| old.and_then(|setting| setting.arrival).map(Input::Ok)),
        arrival_label: patch
            .arrival_label
            .as_ref()
            .map(|_| old.and_then(|setting| setting.arrival_label.clone())),
        route_position: patch.route_position.as_ref().map(|_| {
            Input::Ok(
                old.map(|setting| setting.route_position)
                    .unwrap_or_default(),
            )
        }),
    }
}

/// 參加者中的指定旅伴與指定車輛。
fn participants(who: &Participation) -> (BTreeSet<PersonId>, BTreeSet<VehicleId>) {
    match who {
        Participation::Everyone => (BTreeSet::new(), BTreeSet::new()),
        Participation::People(people) => (people.clone(), BTreeSet::new()),
        Participation::Vehicles(vehicles) => (BTreeSet::new(), vehicles.clone()),
    }
}

/// 集合操作的反向：把真的加入的移除、把真的移除的加回。
fn set_inverse<T: Ord + Copy>(
    current: &BTreeSet<T>,
    add: &BTreeSet<T>,
    remove: &BTreeSet<T>,
) -> (BTreeSet<T>, BTreeSet<T>) {
    let undo_add = remove.intersection(current).copied().collect();
    let undo_remove = add.difference(current).copied().collect();
    (undo_add, undo_remove)
}

fn activity_inverse(activity: &Activity, patch: &ActivityPatch) -> ActivityPatch {
    let (people, vehicles) = participants(&activity.who);
    let (people_add, people_remove) = set_inverse(&people, &patch.people_add, &patch.people_remove);
    let (vehicles_add, vehicles_remove) =
        set_inverse(&vehicles, &patch.vehicles_add, &patch.vehicles_remove);
    ActivityPatch {
        title: patch.title.as_ref().map(|_| activity.title.clone()),
        day: patch.day.map(|_| activity.day),
        time: patch.time.as_ref().map(|_| Some(Input::Ok(activity.time))),
        kind: patch.kind.as_ref().map(|_| Input::Ok(activity.kind)),
        location: patch.location.as_ref().map(|_| activity.location.clone()),
        note: patch.note.as_ref().map(|_| activity.note.clone()),
        people_add,
        people_remove,
        vehicles_add,
        vehicles_remove,
    }
}

fn meal_inverse(meal: &Meal, patch: &MealPatch) -> MealPatch {
    MealPatch {
        day: patch.day.map(|_| meal.day),
        slot: patch.slot.as_ref().map(|_| Input::Ok(meal.slot)),
        time: patch.time.as_ref().map(|_| meal.time.map(Input::Ok)),
        title: patch.title.as_ref().map(|_| meal.title.clone()),
        cook: patch.cook.map(|_| meal.cook),
        servings: patch.servings.as_ref().map(|_| Input::Ok(meal.servings)),
        ingredients: patch.ingredients.as_ref().map(|_| meal.ingredients.clone()),
        notes: patch.notes.as_ref().map(|_| meal.notes.clone()),
        dish: patch.dish.as_ref().map(|_| meal.dish.map(Input::Ok)),
    }
}

fn vehicle_inverse(vehicle: &Vehicle, patch: &VehiclePatch) -> VehiclePatch {
    let (passengers_add, passengers_remove) = set_inverse(
        &vehicle.passengers,
        &patch.passengers_add,
        &patch.passengers_remove,
    );
    VehiclePatch {
        name: patch.name.as_ref().map(|_| vehicle.name.clone()),
        driver: patch.driver.map(|_| vehicle.driver),
        seats: patch.seats.as_ref().map(|_| Input::Ok(vehicle.seats)),
        color: patch.color.as_ref().map(|_| vehicle.color.clone()),
        passengers_add,
        passengers_remove,
    }
}

/// `command` 在狀態 `s` 上執行之後，把狀態還原成 `s` 的命令（依送出的順序）。列已不存在或工作室不會送出的命令是空的。
pub(super) fn inverse(s: &TripState, command: &Command) -> Vec<Command> {
    match command {
        Command::UpdateTrip { patch } => trip_inverse(s, patch),
        Command::AddVehicle { id, .. } => vec![Command::RemoveVehicle { id: *id }],
        Command::UpdateVehicle { id, patch } => s
            .vehicles
            .get(id)
            .map(|vehicle| {
                vec![Command::UpdateVehicle {
                    id: *id,
                    patch: vehicle_inverse(vehicle, patch),
                }]
            })
            .unwrap_or_default(),
        Command::RemoveVehicle { id } => s
            .vehicles
            .get(id)
            .map(|vehicle| {
                vec![Command::AddVehicle {
                    id: *id,
                    draft: vehicle_draft(vehicle),
                }]
            })
            .unwrap_or_default(),
        Command::AddPlace { id, .. } => vec![Command::RemovePlace { id: *id }],
        Command::RenamePlace { id, .. } => s
            .places
            .get(id)
            .map(|place| {
                vec![Command::RenamePlace {
                    id: *id,
                    name: place.name.clone(),
                }]
            })
            .unwrap_or_default(),
        Command::RemovePlace { id } => s
            .places
            .get(id)
            .map(|place| {
                vec![Command::AddPlace {
                    id: *id,
                    name: place.name.clone(),
                    template: place.template.map(Input::Ok),
                }]
            })
            .unwrap_or_default(),
        Command::SaveRoute { route } => vec![match s.routes.get(&route.id) {
            Some(old) => Command::SaveRoute {
                route: route_draft(old),
            },
            None => Command::RemoveRoute { id: route.id },
        }],
        Command::RemoveRoute { id } => s
            .routes
            .get(id)
            .map(|route| {
                vec![Command::SaveRoute {
                    route: route_draft(route),
                }]
            })
            .unwrap_or_default(),
        Command::SaveDaySetting { day, patch } => vec![Command::SaveDaySetting {
            day: *day,
            patch: day_setting_inverse(s, *day, patch),
        }],
        Command::AddActivities { items, .. } => items
            .iter()
            .map(|item| Command::RemoveActivity { id: item.id })
            .collect(),
        Command::UpdateActivity { id, patch } => s
            .activities
            .get(id)
            .map(|activity| {
                vec![Command::UpdateActivity {
                    id: *id,
                    patch: activity_inverse(activity, patch),
                }]
            })
            .unwrap_or_default(),
        Command::RemoveActivity { id } => s
            .activities
            .get(id)
            .map(|activity| {
                let mut out = vec![Command::AddActivities {
                    day: activity.day,
                    items: vec![activity_draft(activity)],
                }];
                if activity.done {
                    out.push(Command::SetActivityDone {
                        id: *id,
                        done: true,
                    });
                }
                out
            })
            .unwrap_or_default(),
        Command::SetActivityDone { id, .. } => s
            .activities
            .get(id)
            .map(|activity| {
                vec![Command::SetActivityDone {
                    id: *id,
                    done: activity.done,
                }]
            })
            .unwrap_or_default(),
        Command::AddMeal { id, .. } => vec![Command::RemoveMeal { id: *id }],
        Command::UpdateMeal { id, patch } => s
            .meals
            .get(id)
            .map(|meal| {
                vec![Command::UpdateMeal {
                    id: *id,
                    patch: meal_inverse(meal, patch),
                }]
            })
            .unwrap_or_default(),
        Command::RemoveMeal { id } => s
            .meals
            .get(id)
            .map(|meal| {
                vec![Command::AddMeal {
                    id: *id,
                    draft: meal_draft(meal),
                }]
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use lm_core::apply::{apply, Ctx, Mode, NoDerivedIds};
    use lm_core::ids::{ActivityId, MealId, PlaceId, RouteId, StopId, TripId, UserId, VehicleId};
    use lm_core::model::{
        ActivityKind, CoverKind, DaySetting, MealSlot, Place, PlaceRef, PlaceTemplate,
        RoutePosition, StopKind, StopTask, TripCard, TripStatus,
    };
    use lm_core::rules::Capabilities;
    use lm_core::time::Hm;
    use uuid::Uuid;

    use super::*;

    fn id<T: From<Uuid>>(n: u128) -> T {
        T::from(Uuid::from_u128(n))
    }

    fn date(day: u32) -> Date {
        Date::from_ymd_opt(2026, 10, day).expect("日期")
    }

    fn hm(hour: u8, minute: u8) -> Hm {
        Hm::new(hour, minute).expect("時刻")
    }

    fn ctx() -> Ctx {
        Ctx {
            actor: id::<UserId>(1),
            caps: Capabilities {
                can_edit: true,
                can_manage: true,
                can_invite: true,
                me: None,
            },
        }
    }

    /// 三天的旅行：一個地點、一台車、第 1 天一條有停靠點的路線、第 3 天一個已完成的活動與一份料理，以及第 3 天只有
    /// 抵達說明的每日設定。
    fn state() -> TripState {
        let mut s = TripState::new(TripCard {
            id: id::<TripId>(2),
            title: "露營".to_owned(),
            destination: "營地".to_owned(),
            start: date(20),
            end: date(22),
            description: String::new(),
            note: String::new(),
            headline: "小日記".to_owned(),
            caption: String::new(),
            cover: CoverKind::Camp,
            status: TripStatus::Planning,
            version: 1,
        });
        s.places.insert(
            id(10),
            Place {
                id: id(10),
                name: "全家".to_owned(),
                template: Some(PlaceTemplate::FamilyMart),
                ordinal: 1,
                version: 1,
            },
        );
        s.vehicles.insert(
            id(20),
            Vehicle {
                id: id(20),
                name: "小藍".to_owned(),
                driver: None,
                seats: 5,
                color: Some("#83accc".to_owned()),
                passengers: BTreeSet::new(),
                ordinal: 2,
                version: 1,
            },
        );
        s.routes.insert(
            id(30),
            Route {
                id: id(30),
                day: date(20),
                vehicle: id(20),
                from: PlaceRef::Place(id(10)),
                to: PlaceRef::Destination,
                depart: Some(hm(8, 0)),
                stops: vec![Stop {
                    id: id::<StopId>(31),
                    place: PlaceRef::Place(id(10)),
                    kind: StopKind::Other,
                    task: Some(StopTask::CarRental),
                    note: "預約".to_owned(),
                    time: None,
                    items: vec!["冰塊".to_owned()],
                }],
                ordinal: 3,
                version: 1,
            },
        );
        s.activities.insert(
            id(40),
            Activity {
                id: id(40),
                day: date(22),
                time: hm(10, 0),
                title: "收帳".to_owned(),
                kind: ActivityKind::Strike,
                location: String::new(),
                note: "慢慢來".to_owned(),
                done: true,
                who: Participation::Everyone,
                ordinal: 4,
                version: 1,
            },
        );
        s.meals.insert(
            id(50),
            Meal {
                id: id(50),
                day: date(22),
                slot: MealSlot::Lunch,
                time: None,
                title: "咖哩飯".to_owned(),
                cook: None,
                servings: 4,
                ingredients: String::new(),
                notes: String::new(),
                dish: None,
                ordinal: 5,
                version: 1,
            },
        );
        s.day_settings.insert(
            date(22),
            DaySetting {
                day: date(22),
                title: None,
                place: None,
                arrival: None,
                arrival_label: Some("營地 14:00".to_owned()),
                route_position: RoutePosition::After,
                version: 1,
            },
        );
        s
    }

    /// 執行一個命令（前端預測）。
    fn run(s: &TripState, command: &Command) -> TripState {
        let outcome = apply(s, &ctx(), Mode::Predict, &mut NoDerivedIds, command)
            .unwrap_or_else(|rejection| panic!("{command:?} 不成立：{rejection}"));
        let mut next = s.clone();
        next.apply_effects(outcome.effects().iter());
        next
    }

    /// 不比較 Row_Version 與 Ordinal（再新增的列取得新的 Ordinal）。
    fn normalized(s: &TripState) -> TripState {
        let mut s = s.clone();
        s.card.version = 0;
        s.places
            .values_mut()
            .for_each(|row| (row.version, row.ordinal) = (0, 0));
        s.vehicles
            .values_mut()
            .for_each(|row| (row.version, row.ordinal) = (0, 0));
        s.routes
            .values_mut()
            .for_each(|row| (row.version, row.ordinal) = (0, 0));
        s.activities
            .values_mut()
            .for_each(|row| (row.version, row.ordinal) = (0, 0));
        s.meals
            .values_mut()
            .for_each(|row| (row.version, row.ordinal) = (0, 0));
        s.day_settings.values_mut().for_each(|row| row.version = 0);
        s
    }

    /// 執行 `commands`，再依序執行它們的反向命令（最後一個命令的反向最先），狀態回到原本的樣子。
    fn assert_round_trip(commands: &[Command]) {
        let start = state();
        let mut s = start.clone();
        let mut undo = Vec::new();
        for command in commands {
            undo.push(inverse(&s, command));
            s = run(&s, command);
        }
        assert_ne!(
            normalized(&s),
            normalized(&start),
            "{commands:?} 沒有改變狀態"
        );
        for command in undo.into_iter().rev().flatten() {
            s = run(&s, &command);
        }
        assert_eq!(normalized(&s), normalized(&start), "{commands:?}");
    }

    #[test]
    fn saving_a_new_route_is_undone_by_removing_it() {
        let s = state();
        let draft = RouteDraft {
            id: id(60),
            day: date(21),
            vehicle: Some(id(20)),
            from: Some(PlaceRef::Destination),
            to: Some(PlaceRef::Place(id(10))),
            depart: None,
            stops: Vec::new(),
        };
        assert_eq!(
            inverse(
                &s,
                &Command::SaveRoute {
                    route: draft.clone()
                }
            ),
            vec![Command::RemoveRoute { id: id(60) }]
        );
        assert_round_trip(&[Command::SaveRoute { route: draft }]);
    }

    #[test]
    fn editing_a_route_is_undone_by_saving_the_old_route() {
        let s = state();
        let old = route_draft(&s.routes[&id::<RouteId>(30)]);
        let mut draft = old.clone();
        draft.depart = None;
        draft.stops[0].items = vec!["營燈".to_owned(), "木炭".to_owned()];
        draft.stops.push(StopDraft {
            id: id(32),
            place: Some(PlaceRef::Destination),
            kind: Input::Ok(StopKind::Pickup),
            task: Some(Input::Ok(StopTask::PassengerDropoff)),
            note: String::new(),
            time: Some(Input::Ok(hm(9, 15))),
            items: vec!["小安".to_owned()],
        });
        let command = Command::SaveRoute { route: draft };
        assert_eq!(
            inverse(&s, &command),
            vec![Command::SaveRoute { route: old }]
        );
        assert_round_trip(&[command]);
        assert_round_trip(&[Command::RemoveRoute { id: id(30) }]);
    }

    #[test]
    fn day_setting_patches_restore_old_values_or_clear_them() {
        let s = state();
        let patch = DaySettingPatch {
            title: Some(Some("出發".to_owned())),
            arrival_label: Some(Some("下午到".to_owned())),
            ..DaySettingPatch::default()
        };
        // 第 1 天原本沒有設定：清空
        assert_eq!(
            inverse(
                &s,
                &Command::SaveDaySetting {
                    day: date(20),
                    patch: patch.clone()
                }
            ),
            vec![Command::SaveDaySetting {
                day: date(20),
                patch: DaySettingPatch {
                    title: Some(None),
                    arrival_label: Some(None),
                    ..DaySettingPatch::default()
                },
            }]
        );
        assert_round_trip(&[Command::SaveDaySetting {
            day: date(20),
            patch: patch.clone(),
        }]);
        assert_round_trip(&[Command::SaveDaySetting {
            day: date(22),
            patch,
        }]);
        assert_round_trip(&[Command::SaveDaySetting {
            day: date(22),
            patch: DaySettingPatch {
                route_position: Some(Input::Ok(RoutePosition::Before)),
                ..DaySettingPatch::default()
            },
        }]);
    }

    #[test]
    fn trip_patches_restore_only_the_touched_fields() {
        let s = state();
        let command = Command::UpdateTrip {
            patch: TripPatch {
                headline: Some(String::new()),
                caption: Some("星空".to_owned()),
                ..TripPatch::default()
            },
        };
        assert_eq!(
            inverse(&s, &command),
            vec![Command::UpdateTrip {
                patch: TripPatch {
                    headline: Some("小日記".to_owned()),
                    caption: Some(String::new()),
                    ..TripPatch::default()
                },
            }]
        );
        assert_round_trip(&[command]);
        // 平移日期（出發日期、某一天的日期）
        assert_round_trip(&[Command::UpdateTrip {
            patch: TripPatch {
                dates: Some(DateSpan {
                    start: date(24),
                    end: date(26),
                }),
                ..TripPatch::default()
            },
        }]);
        // 新增一天
        assert_round_trip(&[Command::UpdateTrip {
            patch: TripPatch {
                dates: Some(DateSpan {
                    start: date(20),
                    end: date(23),
                }),
                ..TripPatch::default()
            },
        }]);
    }

    #[test]
    fn removing_the_last_day_is_undone_with_its_events_and_setting() {
        let s = state();
        let command = Command::UpdateTrip {
            patch: TripPatch {
                dates: Some(DateSpan {
                    start: date(20),
                    end: date(21),
                }),
                ..TripPatch::default()
            },
        };
        let undo = inverse(&s, &command);
        assert_eq!(undo.len(), 4, "{undo:?}");
        assert!(matches!(
            &undo[1],
            Command::UpdateActivity { id: row, patch } if *row == id::<ActivityId>(40) && patch.day == Some(date(22))
        ));
        assert!(matches!(
            &undo[2],
            Command::UpdateMeal { id: row, patch } if *row == id::<MealId>(50) && patch.day == Some(date(22))
        ));
        assert_round_trip(&[command]);
    }

    #[test]
    fn removed_rows_come_back_with_the_same_id() {
        let s = state();
        assert_eq!(
            inverse(&s, &Command::RemoveActivity { id: id(40) }),
            vec![
                Command::AddActivities {
                    day: date(22),
                    items: vec![activity_draft(&s.activities[&id::<ActivityId>(40)])],
                },
                Command::SetActivityDone {
                    id: id(40),
                    done: true,
                },
            ]
        );
        assert_round_trip(&[Command::RemoveActivity { id: id(40) }]);
        assert_round_trip(&[Command::RemoveMeal { id: id(50) }]);
        assert_round_trip(&[
            Command::RemoveRoute { id: id(30) },
            Command::RemovePlace { id: id(10) },
        ]);
        assert_round_trip(&[
            Command::RemoveRoute { id: id(30) },
            Command::RemoveVehicle { id: id(20) },
        ]);
    }

    #[test]
    fn added_rows_are_undone_by_removing_them() {
        let s = state();
        let add = Command::AddActivities {
            day: date(21),
            items: vec![ActivityDraft {
                id: id(70),
                time: Some(Input::Ok(hm(9, 0))),
                title: "新活動".to_owned(),
                kind: Input::Ok(ActivityKind::Meet),
                location: String::new(),
                note: String::new(),
                who: Participation::Everyone,
            }],
        };
        assert_eq!(
            inverse(&s, &add),
            vec![Command::RemoveActivity { id: id(70) }]
        );
        assert_round_trip(&[add]);
        assert_round_trip(&[Command::AddPlace {
            id: id::<PlaceId>(71),
            name: "新地點".to_owned(),
            template: Some(Input::Ok(PlaceTemplate::Home)),
        }]);
        assert_round_trip(&[Command::AddVehicle {
            id: id::<VehicleId>(72),
            draft: VehicleDraft {
                name: "第 2 台車".to_owned(),
                driver: None,
                seats: Some(Input::Ok(4)),
                color: Some("#dd775f".to_owned()),
                passengers: BTreeSet::new(),
            },
        }]);
    }

    #[test]
    fn patches_of_rows_restore_their_old_values() {
        assert_round_trip(&[Command::UpdateActivity {
            id: id(40),
            patch: ActivityPatch {
                title: Some("拆帳".to_owned()),
                time: Some(Some(Input::Ok(hm(11, 0)))),
                kind: Some(Input::Ok(ActivityKind::Clean)),
                note: Some(String::new()),
                ..ActivityPatch::default()
            },
        }]);
        assert_round_trip(&[Command::UpdateMeal {
            id: id(50),
            patch: MealPatch {
                time: Some(Some(Input::Ok(hm(12, 30)))),
                title: Some("咖哩".to_owned()),
                notes: Some("多煮一點".to_owned()),
                ..MealPatch::default()
            },
        }]);
        assert_round_trip(&[Command::UpdateVehicle {
            id: id(20),
            patch: VehiclePatch {
                name: Some("小紅".to_owned()),
                color: Some(Some("#dd775f".to_owned())),
                ..VehiclePatch::default()
            },
        }]);
        assert_round_trip(&[Command::RenamePlace {
            id: id(10),
            name: "7-11".to_owned(),
        }]);
    }
}
