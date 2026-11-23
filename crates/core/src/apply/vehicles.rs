//! 車輛：`AddVehicle`、`UpdateVehicle`、`RemoveVehicle`（需求 20）。

use crate::command::{Input, Rejection, VehicleDraft, VehiclePatch, IN_USE, PERSON_NOT_FOUND};
use crate::ids::VehicleId;
use crate::limits::{VEHICLE_NAME_CHARS, VEHICLE_SEATS};
use crate::model::{Entity, Participation, Slot, TripState, Vehicle};
use crate::text::{char_count, trim_white};
use crate::time::date_range;

use super::common::{ensure_new, next_ordinal, storable};
use super::slot;

/// 座位數的輸入。
enum Seats {
    /// 表單中沒有填寫。
    Missing,
    /// 不是整數，或不能放進 `u8`。
    Bad,
    Value(u8),
}

impl Seats {
    fn of(input: Option<&Input<u8>>) -> Seats {
        match input {
            None => Seats::Missing,
            Some(Input::Ok(seats)) => Seats::Value(*seats),
            Some(Input::Bad(_)) => Seats::Bad,
        }
    }
}

/// 以新增或套用修改之後的車輛依需求 20.1–20.3 的順序檢查。`vehicle.seats` 只在 `seats` 是 `Value` 時有意義。
fn check(d: &TripState, vehicle: &Vehicle, seats: Seats) -> Result<u8, Rejection> {
    if vehicle.name.is_empty() || matches!(seats, Seats::Missing) {
        return Err(Rejection::invalid("name", "請填寫必要欄位，不能只有空白。"));
    }
    if char_count(&vehicle.name) > *VEHICLE_NAME_CHARS.end() {
        return Err(Rejection::invalid("name", "車輛暱稱最多 50 個字。"));
    }
    storable("name", &vehicle.name)?;
    let seats = match seats {
        Seats::Value(seats) if VEHICLE_SEATS.contains(&seats) => seats,
        _ => {
            return Err(Rejection::invalid(
                "seats",
                "座位數（含駕駛）請填 1 到 9 的整數。",
            ))
        }
    };
    if vehicle
        .driver
        .is_some_and(|driver| vehicle.passengers.contains(&driver))
    {
        return Err(Rejection::invalid("passengers", "駕駛不能同時是乘客。"));
    }
    if vehicle.passengers.len() + 1 > usize::from(seats) {
        return Err(Rejection::invalid(
            "passengers",
            "乘客加上駕駛不能超過座位數。",
        ));
    }
    let known = vehicle
        .driver
        .iter()
        .chain(&vehicle.passengers)
        .all(|person| d.people.contains_key(person));
    if !known {
        return Err(Rejection::invalid("driver", PERSON_NOT_FOUND));
    }
    if let Some(color) = &vehicle.color {
        if !is_hex_color(color) {
            return Err(Rejection::invalid("color", "車輛顏色需為 #rrggbb"));
        }
    }
    Ok(seats)
}

/// `#` 加上 6 個小寫的十六進位數字（需求 20.3）。
fn is_hex_color(color: &str) -> bool {
    color.len() == 7
        && color.starts_with('#')
        && color[1..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `AddVehicle`：名稱先 Trim_White，再依需求 20.1–20.3 檢查。
pub(super) fn add_vehicle(
    d: &mut TripState,
    id: VehicleId,
    draft: &VehicleDraft,
) -> Result<Vec<Slot>, Rejection> {
    ensure_new(&d.vehicles, &id)?;
    let mut vehicle = Vehicle {
        id,
        name: trim_white(&draft.name).to_owned(),
        driver: draft.driver,
        seats: 0,
        color: draft.color.clone(),
        passengers: draft.passengers.clone(),
        ordinal: next_ordinal(d),
        version: 0,
    };
    vehicle.seats = check(d, &vehicle, Seats::of(draft.seats.as_ref()))?;
    d.vehicles.insert(id, vehicle);
    Ok(vec![slot(Entity::Vehicle, id.0)])
}

/// `UpdateVehicle`：以套用到當下最新狀態之後的車輛檢查（需求 20.9）；乘客以集合加入與移除。
pub(super) fn update_vehicle(
    d: &mut TripState,
    id: VehicleId,
    patch: &VehiclePatch,
) -> Result<(), Rejection> {
    let Some(current) = d.vehicles.get(&id) else {
        return Err(Rejection::not_found("找不到這台車。"));
    };
    let mut vehicle = current.clone();
    if let Some(name) = &patch.name {
        vehicle.name = trim_white(name).to_owned();
    }
    if let Some(driver) = patch.driver {
        vehicle.driver = driver;
    }
    if let Some(color) = &patch.color {
        vehicle.color = color.clone();
    }
    vehicle.passengers.extend(&patch.passengers_add);
    vehicle
        .passengers
        .retain(|person| !patch.passengers_remove.contains(person));
    let seats = match &patch.seats {
        None => Seats::Value(vehicle.seats),
        Some(input) => Seats::of(Some(input)),
    };
    vehicle.seats = check(d, &vehicle, seats)?;
    d.vehicles.insert(id, vehicle);
    Ok(())
}

/// `RemoveVehicle`：仍有路線或仍被活動指定時 409（需求 20.6、20.7）；已不存在時沒有變化。
pub(super) fn remove_vehicle(d: &mut TripState, id: VehicleId) -> Result<(), Rejection> {
    if !d.vehicles.contains_key(&id) {
        return Ok(());
    }
    let days = date_range(d.card.start, d.card.end);
    let route_days: Vec<String> = days
        .iter()
        .enumerate()
        .filter(|(_, &day)| {
            d.routes
                .values()
                .any(|route| route.vehicle == id && route.day == day)
        })
        .map(|(i, _)| format!("第 {} 天", i + 1))
        .collect();
    let assigned = d.activities.values().any(|activity| {
        matches!(&activity.who, Participation::Vehicles(vehicles) if vehicles.contains(&id))
    });
    let mut reasons = Vec::new();
    if !route_days.is_empty() {
        reasons.push(format!(
            "這台車在{}還有路線，請先刪除這些路線，或改派給其他車。",
            route_days.join("、")
        ));
    }
    if assigned {
        reasons.push(
            "這台車仍有指定行程。請先把那些行程改派其他車輛或改為全體，再移除車輛。".to_owned(),
        );
    }
    if !reasons.is_empty() {
        return Err(Rejection::conflict(IN_USE, reasons.join(" ")));
    }
    d.vehicles.remove(&id);
    Ok(())
}
