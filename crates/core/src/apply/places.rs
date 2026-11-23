//! 地點清單：`AddPlace`、`RenamePlace`、`RemovePlace`（需求 21）。

use crate::command::{Rejection, DUPLICATE_NAME, IN_USE, LIMIT_REACHED};
use crate::ids::PlaceId;
use crate::itinerary::{place_in_use_message, place_name_error, place_usages, PlaceNameError};
use crate::limits::PLACES_MAX;
use crate::model::{Entity, Place, Slot, TripState};
use crate::text::trim_white;

use super::common::{ensure_new, next_ordinal};
use super::slot;

/// 需求 21.1：名稱經 Trim_White 依序檢查；同名為 409，其他為 400。
fn check_name(d: &TripState, name: &str, except: Option<PlaceId>) -> Result<String, Rejection> {
    match place_name_error(d, name, except) {
        None => Ok(trim_white(name).to_owned()),
        Some(error @ PlaceNameError::Duplicate) => {
            Err(Rejection::conflict(DUPLICATE_NAME, error.to_string()))
        }
        Some(error) => Err(Rejection::invalid("name", error.to_string())),
    }
}

/// `AddPlace`：名稱依需求 21.1 檢查；已有 100 個地點時 409（需求 21.2）。
pub(super) fn add_place(
    d: &mut TripState,
    id: PlaceId,
    name: &str,
) -> Result<Vec<Slot>, Rejection> {
    ensure_new(&d.places, &id)?;
    let name = check_name(d, name, None)?;
    if d.places.len() >= PLACES_MAX {
        return Err(Rejection::conflict(LIMIT_REACHED, "地點最多 100 個"));
    }
    let place = Place {
        id,
        name,
        ordinal: next_ordinal(d),
        version: 0,
    };
    d.places.insert(id, place);
    Ok(vec![slot(Entity::Place, id.0)])
}

/// `RenamePlace`：不存在時 404；只改名稱，不改變位置與引用（需求 21.6、21.7）。與原名稱完全相同時沒有變化。
pub(super) fn rename_place(d: &mut TripState, id: PlaceId, name: &str) -> Result<(), Rejection> {
    if !d.places.contains_key(&id) {
        return Err(Rejection::not_found("找不到這個地點。"));
    }
    let name = check_name(d, name, Some(id))?;
    if let Some(place) = d.places.get_mut(&id) {
        place.name = name;
    }
    Ok(())
}

/// `RemovePlace`（design A2）：已不存在時沒有變化；仍有 Place_Usage 時 409（需求 21.3、21.4、21.7）。
pub(super) fn remove_place(d: &mut TripState, id: PlaceId) -> Result<(), Rejection> {
    if !d.places.contains_key(&id) {
        return Ok(());
    }
    let usages = place_usages(d, id);
    if !usages.is_empty() {
        return Err(Rejection::conflict(IN_USE, place_in_use_message(&usages)));
    }
    d.places.remove(&id);
    Ok(())
}
