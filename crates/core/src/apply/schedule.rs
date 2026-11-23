//! 行程表：`SaveRoute`、`RemoveRoute`、`SaveDaySetting`（需求 22），以及 `AddActivities`、`UpdateActivity`、
//! `RemoveActivity`、`SetActivityDone`（需求 23）。命令指定的日期不在當下的旅行範圍內時依各需求回應 400，不依
//! Retime 改動（需求 18.10）。

use std::collections::BTreeSet;

use crate::command::{
    optional_time, ActivityDraft, ActivityPatch, DaySettingPatch, Input, Rejection, RouteDraft,
    LIMIT_REACHED, RELOAD_AND_RETRY, ROUTE_EXISTS, TIME_OR_BLANK, VALIDATION_FAILED,
    VALIDATION_FAILED_MESSAGE,
};
use crate::ids::{ActivityId, PersonId, RouteId, VehicleId};
use crate::limits::{
    ACTIVITIES_MAX, ACTIVITY_LOCATION_CHARS, ACTIVITY_NOTE_CHARS, ACTIVITY_TITLE_CHARS,
    DAY_TITLE_CHARS, ROUTE_STOPS, STOP_NOTE_CHARS,
};
use crate::model::{
    Activity, ActivityKind, Date, DaySetting, Entity, Participation, PlaceRef, Route,
    RoutePosition, Slot, Stop, TripState,
};
use crate::text::trim_white;
use crate::time::Hm;

use super::common::{
    ensure_new, fits, in_trip, next_ordinal, required_time, storable, RequiredTime,
};
use super::slot;

// ── 路線 ──

/// 路線的地點：地點清單中的地點，或旅行目的地不是空白時的 Destination_Place（需求 22.6）。
fn route_place(
    d: &TripState,
    place: Option<PlaceRef>,
    field: &str,
    message: &str,
) -> Result<PlaceRef, Rejection> {
    let ok = match place {
        Some(PlaceRef::Destination) => !trim_white(&d.card.destination).is_empty(),
        Some(PlaceRef::Place(id)) => d.places.contains_key(&id),
        None => false,
    };
    match place {
        Some(place) if ok => Ok(place),
        _ => Err(Rejection::invalid(field, message)),
    }
}

/// `SaveRoute`：依需求 22.4–22.7 的順序檢查；整條取代並保留路線與既有停靠點的 id；路線不存在時新增；不改變
/// 採買品項。
pub(super) fn save_route(d: &mut TripState, draft: &RouteDraft) -> Result<Vec<Slot>, Rejection> {
    if !in_trip(d, draft.day) {
        return Err(Rejection::invalid("day", RELOAD_AND_RETRY));
    }
    let vehicle = draft
        .vehicle
        .filter(|id| d.vehicles.contains_key(id))
        .ok_or_else(|| Rejection::invalid("vehicle", "請選擇哪一台車。"))?;
    let depart = optional_time(draft.depart.as_ref())
        .map_err(|_| Rejection::invalid("depart", TIME_OR_BLANK))?;
    let from = route_place(d, draft.from, "from", "請選擇從哪裡出發。")?;
    let to = route_place(d, draft.to, "to", "請選擇最後到哪裡。")?;
    let places = draft
        .stops
        .iter()
        .map(|stop| route_place(d, stop.place, "stops", "請選擇停在哪裡。"))
        .collect::<Result<Vec<_>, _>>()?;
    if draft.stops.len() > *ROUTE_STOPS.end() {
        return Err(Rejection::invalid("stops", "每台車最多 6 個停靠點"));
    }
    let mut kinds = Vec::with_capacity(draft.stops.len());
    for stop in &draft.stops {
        let kind = stop.kind.ok().copied();
        let task = match &stop.task {
            None => Ok(None),
            Some(Input::Ok(task)) => Ok(Some(*task)),
            Some(Input::Bad(_)) => Err(()),
        };
        match (kind, task) {
            (Some(kind), Ok(task)) if task.is_none_or(|task| kind.tasks().any(|t| t == task)) => {
                kinds.push((kind, task));
            }
            _ => return Err(Rejection::invalid("stops", "請選擇要做什麼。")),
        }
    }
    let mut notes = Vec::with_capacity(draft.stops.len());
    for stop in &draft.stops {
        let note = trim_white(&stop.note);
        if !fits(note, STOP_NOTE_CHARS) {
            return Err(Rejection::invalid("stops", "備註最多 100 個字。"));
        }
        storable("stops", note)?;
        notes.push(note.to_owned());
    }
    let times = draft
        .stops
        .iter()
        .map(|stop| optional_time(stop.time.as_ref()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| Rejection::invalid("stops", TIME_OR_BLANK))?;
    let taken = d
        .routes
        .values()
        .any(|route| route.id != draft.id && route.vehicle == vehicle && route.day == draft.day);
    if taken {
        return Err(Rejection::conflict(
            ROUTE_EXISTS,
            "這台車這一天已有路線，請選擇其他車。",
        ));
    }
    let stops = draft
        .stops
        .iter()
        .zip(places)
        .zip(kinds)
        .zip(notes.into_iter().zip(times))
        .map(|(((stop, place), (kind, task)), (note, time))| Stop {
            id: stop.id,
            place,
            kind,
            task,
            note,
            time,
        })
        .collect();
    let existing = d.routes.get(&draft.id);
    let created = existing.is_none();
    let route = Route {
        id: draft.id,
        day: draft.day,
        vehicle,
        from,
        to,
        depart,
        stops,
        ordinal: existing.map_or_else(|| next_ordinal(d), |route| route.ordinal),
        version: existing.map_or(0, |route| route.version),
    };
    d.routes.insert(draft.id, route);
    Ok(if created {
        vec![slot(Entity::Route, draft.id.0)]
    } else {
        Vec::new()
    })
}

/// `RemoveRoute`：刪除路線與它的停靠點；已不存在時沒有變化；不改變採買品項（需求 22.9）。
pub(super) fn remove_route(d: &mut TripState, id: RouteId) {
    d.routes.remove(&id);
}

// ── 每日設定 ──

/// `SaveDaySetting`：只合併帶有的欄位，依需求 22.10 的順序檢查；合併後標題、地點與預計抵達時間都未設定時刪除這一天
/// 的設定，路線位置因此回到 before（需求 22.11、22.15）。
pub(super) fn save_day_setting(
    d: &mut TripState,
    day: Date,
    patch: &DaySettingPatch,
) -> Result<(), Rejection> {
    if !in_trip(d, day) {
        return Err(Rejection::invalid("day", RELOAD_AND_RETRY));
    }
    let mut setting = d.day_settings.get(&day).cloned().unwrap_or(DaySetting {
        day,
        title: None,
        place: None,
        arrival: None,
        route_position: RoutePosition::Before,
        version: 0,
    });
    if let Some(title) = &patch.title {
        let title = title.as_deref().map(trim_white).filter(|t| !t.is_empty());
        if let Some(title) = title {
            if !fits(title, DAY_TITLE_CHARS) {
                return Err(Rejection::invalid("title", "標題最多 20 個字。"));
            }
            storable("title", title)?;
        }
        setting.title = title.map(str::to_owned);
    }
    if let Some(place) = patch.place {
        if place.is_some_and(|id| !d.places.contains_key(&id)) {
            return Err(Rejection::invalid("place", "請重新選擇地點。"));
        }
        setting.place = place;
    }
    if let Some(arrival) = &patch.arrival {
        setting.arrival = optional_time(arrival.as_ref())
            .map_err(|_| Rejection::invalid("arrival", TIME_OR_BLANK))?;
    }
    if let Some(position) = &patch.route_position {
        setting.route_position = position
            .ok()
            .copied()
            .ok_or_else(|| Rejection::invalid("route_position", "請選擇路線在活動之前或之後。"))?;
    }
    if setting.title.is_none() && setting.place.is_none() && setting.arrival.is_none() {
        d.day_settings.remove(&day);
    } else {
        d.day_settings.insert(day, setting);
    }
    Ok(())
}

// ── 活動 ──

/// 活動的標題、地點或備註，經 Trim_White 依需求 23.10 檢查。
fn activity_text(
    text: &str,
    field: &str,
    range: std::ops::RangeInclusive<usize>,
    too_long: &str,
) -> Result<String, Rejection> {
    let text = trim_white(text);
    if !fits(text, range) {
        return Err(Rejection::invalid(field, too_long));
    }
    storable(field, text)?;
    Ok(text.to_owned())
}

/// 活動的標題（需求 23.10）：經 Trim_White 後是空的「請填寫標題。」，超過 100 字「標題最多 100 個字。」。
fn activity_title(title: &str) -> Result<String, Rejection> {
    if trim_white(title).is_empty() {
        return Err(Rejection::invalid("title", "請填寫標題。"));
    }
    activity_text(title, "title", ACTIVITY_TITLE_CHARS, "標題最多 100 個字。")
}

/// 活動的時間（必填）。
fn activity_time(input: Option<&Input<Hm>>) -> Result<Hm, Rejection> {
    required_time(input).map_err(|error| match error {
        RequiredTime::Blank => Rejection::invalid("time", "請填寫時間，例如 08:30。"),
        RequiredTime::Invalid => {
            Rejection::invalid("time", "請以 24 小時制填寫完整的時和分，例如 08:30。")
        }
    })
}

/// 活動的類別：13 種之一。
fn activity_kind(input: &Input<ActivityKind>) -> Result<ActivityKind, Rejection> {
    input
        .ok()
        .copied()
        .ok_or_else(|| Rejection::invalid("kind", "請選擇類別。"))
}

/// 參加者（需求 23.4）：指定的旅伴與車輛都存在；指定的集合是空的時為全體旅伴。同時指定旅伴與車輛時（例如兩位成員
/// 同時改了參加者的種類）以 409「資料驗證未通過，沒有儲存。」拒絕（需求 9.12、9.16）。
fn participation(
    d: &TripState,
    people: BTreeSet<PersonId>,
    vehicles: BTreeSet<VehicleId>,
) -> Result<Participation, Rejection> {
    if !people.iter().all(|id| d.people.contains_key(id)) {
        return Err(Rejection::invalid("who", "請重新選擇參加的旅伴。"));
    }
    if !vehicles.iter().all(|id| d.vehicles.contains_key(id)) {
        return Err(Rejection::invalid("who", "請重新選擇參加的車。"));
    }
    match (people.is_empty(), vehicles.is_empty()) {
        (true, true) => Ok(Participation::Everyone),
        (false, true) => Ok(Participation::People(people)),
        (true, false) => Ok(Participation::Vehicles(vehicles)),
        (false, false) => Err(Rejection::conflict(
            VALIDATION_FAILED,
            VALIDATION_FAILED_MESSAGE,
        )),
    }
}

/// 參加者的兩個集合：指定旅伴與指定車輛。
fn sets(who: &Participation) -> (BTreeSet<PersonId>, BTreeSet<VehicleId>) {
    match who {
        Participation::Everyone => (BTreeSet::new(), BTreeSet::new()),
        Participation::People(people) => (people.clone(), BTreeSet::new()),
        Participation::Vehicles(vehicles) => (BTreeSet::new(), vehicles.clone()),
    }
}

/// 一筆新增的活動，依標題、日期、時間、類別、參加者、地點、備註的順序檢查（需求 23.10）。
fn new_activity(d: &TripState, day: Date, item: &ActivityDraft) -> Result<Activity, Rejection> {
    let title = activity_title(&item.title)?;
    if !in_trip(d, day) {
        return Err(Rejection::invalid("day", "請重新選擇日期。"));
    }
    let time = activity_time(item.time.as_ref())?;
    let kind = activity_kind(&item.kind)?;
    let (people, vehicles) = sets(&item.who);
    let who = participation(d, people, vehicles)?;
    let location = activity_text(
        &item.location,
        "location",
        ACTIVITY_LOCATION_CHARS,
        "地點最多 150 個字。",
    )?;
    let note = activity_text(
        &item.note,
        "note",
        ACTIVITY_NOTE_CHARS,
        "備註最多 1,000 個字。",
    )?;
    Ok(Activity {
        id: item.id,
        day,
        time,
        title,
        kind,
        location,
        note,
        done: false,
        who,
        ordinal: next_ordinal(d),
        version: 0,
    })
}

/// `AddActivities`：依送出的順序檢查每一筆，全部新增或全部不新增；新增之後超過 1000 筆時整個命令拒絕（需求 23.1、
/// 23.5）。
pub(super) fn add_activities(
    d: &mut TripState,
    day: Date,
    items: &[ActivityDraft],
) -> Result<Vec<Slot>, Rejection> {
    let mut created = Vec::with_capacity(items.len());
    for item in items {
        ensure_new(&d.activities, &item.id)?;
        let activity = new_activity(d, day, item)?;
        d.activities.insert(item.id, activity);
        created.push(slot(Entity::Activity, item.id.0));
    }
    if d.activities.len() > ACTIVITIES_MAX {
        return Err(Rejection::conflict(
            LIMIT_REACHED,
            "活動最多 1,000 筆，請先刪除不需要的活動。",
        ));
    }
    Ok(created)
}

/// `UpdateActivity`：只合併帶有的欄位，以合併後的活動依需求 23.10 的順序檢查；不改變完成狀態與 Ordinal。
pub(super) fn update_activity(
    d: &mut TripState,
    id: ActivityId,
    patch: &ActivityPatch,
) -> Result<(), Rejection> {
    let Some(current) = d.activities.get(&id) else {
        return Err(Rejection::not_found("找不到這個活動。"));
    };
    let mut activity = current.clone();
    if let Some(title) = &patch.title {
        activity.title = activity_title(title)?;
    }
    if let Some(day) = patch.day {
        activity.day = day;
    }
    if !in_trip(d, activity.day) {
        return Err(Rejection::invalid("day", "請重新選擇日期。"));
    }
    if let Some(time) = &patch.time {
        activity.time = activity_time(time.as_ref())?;
    }
    if let Some(kind) = &patch.kind {
        activity.kind = activity_kind(kind)?;
    }
    let (mut people, mut vehicles) = sets(&activity.who);
    people.extend(&patch.people_add);
    people.retain(|person| !patch.people_remove.contains(person));
    vehicles.extend(&patch.vehicles_add);
    vehicles.retain(|vehicle| !patch.vehicles_remove.contains(vehicle));
    activity.who = participation(d, people, vehicles)?;
    if let Some(location) = &patch.location {
        activity.location = activity_text(
            location,
            "location",
            ACTIVITY_LOCATION_CHARS,
            "地點最多 150 個字。",
        )?;
    }
    if let Some(note) = &patch.note {
        activity.note = activity_text(note, "note", ACTIVITY_NOTE_CHARS, "備註最多 1,000 個字。")?;
    }
    d.activities.insert(id, activity);
    Ok(())
}

/// `RemoveActivity`：刪除活動與它的指定旅伴、指定車輛；已不存在時沒有變化（需求 23.7）。
pub(super) fn remove_activity(d: &mut TripState, id: ActivityId) {
    d.activities.remove(&id);
}

/// `SetActivityDone`：設定完成狀態（冪等）；不存在時 404（需求 23.6、23.11）。
pub(super) fn set_activity_done(
    d: &mut TripState,
    id: ActivityId,
    done: bool,
) -> Result<(), Rejection> {
    let activity = d
        .activities
        .get_mut(&id)
        .ok_or_else(|| Rejection::not_found("找不到這個活動。"))?;
    activity.done = done;
    Ok(())
}
