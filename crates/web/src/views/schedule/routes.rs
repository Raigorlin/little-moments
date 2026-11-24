//! 這一天的路線卡片與「新增路線」（需求 22.1–22.3、22.17、7.9、7.18；Collaborator 也可以刪除路線與停靠點，需求 6.17）。
//!
//! - 卡片依 `sorted_routes()` 排列：出發時間由早到晚，同一時間依車輛的 Ordinal，沒有出發時間的排在最後（需求 22.2）。
//!   `RowStore` 的路線排序鍵沒有車輛的 Ordinal，所以這裡以 Optimistic_View 算出鍵的順序；`Memo` 的結果不變時不通知，
//!   `<For>` 依鍵只建立、移除或移動那一張卡片（需求 14.2）。
//! - 編輯卡片時，表單取代那張卡片的內容；起點、終點、出發時間與全部停靠點（地點、種類、任務、時間、備註與順序）連同
//!   日期與車輛以一個 `SaveRoute` 整張送出（需求 7.9、22.3）。新的路線與停靠點以隨機的 UUID 為 id（需求 7.18）。
use leptos::prelude::*;
use lm_core::command::{Command, Input, RouteDraft, StopDraft};
use lm_core::ids::{RouteId, StopId, VehicleId};
use lm_core::itinerary::{day_place, place_name, sorted_routes, stop_task, vehicle_color};
use lm_core::limits::ROUTE_STOPS;
use lm_core::model::{Date, Entity, PlaceRef, Route, RowKey, StopKind, StopTask, TripState};
use lm_core::time::Hm;
use uuid::Uuid;

use super::{parse_place, place_options, place_value, time_input, time_text};
use crate::art;
use crate::pages::trip::{use_trip, TripContext};
use crate::views::editors::EditorAvatars;
use crate::views::forms::{FormError, FormFields, FormNotices, FormSession, FormTarget};
use crate::views::icons;

/// 路線卡片的表單。
pub(super) const ROUTE_FORM: &str = "route";
/// 「新增路線」停用的原因（需求 22.17）。
const NO_VEHICLES: &str = "還沒有車輛，新增車輛後就能安排路線";
const ALL_ROUTED: &str = "每台車這一天都已有路線";
/// 車輛已不在這趟旅行時的名稱（只在 Pending_Command 被撤銷的瞬間等過渡狀態）。
const UNKNOWN_VEHICLE: &str = "車輛待確認";

/// 停靠點的上限（需求 22.7）。
fn max_stops() -> usize {
    *ROUTE_STOPS.end()
}

/// 路線卡片的表單中的一個停靠點。時刻是欄位中的文字。
#[derive(Clone, Debug, PartialEq)]
struct StopFields {
    id: StopId,
    place: Option<PlaceRef>,
    kind: StopKind,
    task: Option<StopTask>,
    note: String,
    time: String,
}

impl StopFields {
    fn new() -> StopFields {
        StopFields {
            id: StopId(Uuid::new_v4()),
            place: None,
            kind: StopKind::Shop,
            task: None,
            note: String::new(),
            time: String::new(),
        }
    }
}

/// 路線卡片的表單（整張卡片的草稿）。
#[derive(Clone, Debug, PartialEq)]
pub(super) struct RouteFields {
    id: RouteId,
    vehicle: Option<VehicleId>,
    from: Option<PlaceRef>,
    to: Option<PlaceRef>,
    depart: String,
    stops: Vec<StopFields>,
}

impl RouteFields {
    fn of(route: &Route) -> RouteFields {
        RouteFields {
            id: route.id,
            vehicle: Some(route.vehicle),
            from: Some(route.from),
            to: Some(route.to),
            depart: time_text(route.depart),
            stops: route
                .stops
                .iter()
                .map(|stop| StopFields {
                    id: stop.id,
                    place: Some(stop.place),
                    kind: stop.kind,
                    task: stop.task,
                    note: stop.note.clone(),
                    time: time_text(stop.time),
                })
                .collect(),
        }
    }

    /// 新的路線：以隨機的 UUID 為 id，預先選擇第一台這一天還沒有路線的車，終點預設為這一天的地點。
    fn new(state: &TripState, day: Date) -> RouteFields {
        RouteFields {
            id: RouteId(Uuid::new_v4()),
            vehicle: free_vehicles(state, day, None).first().map(|(id, _)| *id),
            from: None,
            to: day_place(state, day),
            depart: String::new(),
            stops: Vec::new(),
        }
    }

    /// 整張卡片（需求 7.9、22.3）。
    fn command(&self, day: Date) -> Command {
        Command::SaveRoute {
            route: RouteDraft {
                id: self.id,
                day,
                vehicle: self.vehicle,
                from: self.from,
                to: self.to,
                depart: time_input(&self.depart),
                stops: self
                    .stops
                    .iter()
                    .map(|stop| StopDraft {
                        id: stop.id,
                        place: stop.place,
                        kind: Input::Ok(stop.kind),
                        task: stop.task.map(Input::Ok),
                        note: stop.note.clone(),
                        time: time_input(&stop.time),
                        items: Vec::new(),
                    })
                    .collect(),
            },
        }
    }
}

/// 「哪一台車」的選項：依車輛的 Ordinal，只列出這一天沒有其他路線的車（`except` 是正在編輯的路線，需求 22.1）。
fn free_vehicles(
    state: &TripState,
    day: Date,
    except: Option<RouteId>,
) -> Vec<(VehicleId, String)> {
    state
        .vehicles_by_ordinal()
        .filter(|vehicle| {
            !state.routes.values().any(|route| {
                route.day == day && route.vehicle == vehicle.id && Some(route.id) != except
            })
        })
        .map(|vehicle| (vehicle.id, vehicle.name.clone()))
        .collect()
}

/// 「新增路線」停用的原因（需求 22.17）；可以新增時是 `None`。
fn add_route_blocked(state: &TripState, day: Date) -> Option<&'static str> {
    if state.vehicles.is_empty() {
        Some(NO_VEHICLES)
    } else if free_vehicles(state, day, None).is_empty() {
        Some(ALL_ROUTED)
    } else {
        None
    }
}

/// 這一天的路線卡片與「新增路線」。
#[component]
pub(super) fn DayRoutes(day: Date) -> impl IntoView {
    let TripContext { handle, ui, .. } = use_trip();
    let keys = Memo::new(move |_| {
        handle
            .with_view(|state| {
                sorted_routes(state, day)
                    .into_iter()
                    .map(|route| route.id)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    });
    let blocked = Memo::new(move |_| {
        handle
            .with_view(|state| add_route_blocked(state, day))
            .flatten()
    });
    let new_form = move || {
        ui.form_session::<RouteFields>(ROUTE_FORM)
            .filter(|form| form.target == FormTarget::New)
    };
    let add = move |_| {
        if let Some(draft) = handle.with_view(|state| RouteFields::new(state, day)) {
            ui.open_form(ROUTE_FORM, FormTarget::New, draft);
        }
    };
    view! {
        <section class="vehicle-departures" aria-labelledby="day-routes-title">
            <div class="vehicle-departures-heading">
                <div>
                    <span class="eyebrow">"DIFFERENT STARTS, SHARED MEMORIES"</span>
                    <h2 id="day-routes-title">
                        "各車路線 " <span>{move || format!("{} 條路線", keys.with(Vec::len))}</span>
                    </h2>
                </div>
                <button
                    type="button"
                    class="button small"
                    disabled=move || blocked.get().is_some()
                    aria-describedby=move || blocked.get().map(|_| "add-route-reason")
                    on:click=add
                >
                    {art::static_svg(icons::PLUS)}
                    "新增路線"
                </button>
            </div>
            {move || {
                blocked
                    .get()
                    .map(|reason| {
                        view! {
                            <p class="help" id="add-route-reason">
                                {reason}
                            </p>
                        }
                    })
            }}
            <p class="help">"每台車每天一條路線，可安排途中最多 6 個停靠點，時間可稍後填。"</p>
            <div class="departure-vehicles">
                <For
                    each=move || keys.get()
                    key=|id| *id
                    children=move |id| view! { <RouteCard id day /> }
                />
                {move || {
                    new_form()
                        .map(|form| {
                            view! {
                                <article class="departure-vehicle wide" aria-label="新增路線">
                                    <RouteEditor form day />
                                </article>
                            }
                        })
                }}
            </div>
            {move || {
                (keys.with(Vec::is_empty) && new_form().is_none())
                    .then(|| {
                        view! {
                            <div class="departure-vehicles-empty">
                                "這一天還沒有路線。"
                            </div>
                        }
                    })
            }}
        </section>
    }
}

/// 路線卡片上顯示的內容。
#[derive(Clone, Debug, PartialEq)]
struct RouteSummary {
    vehicle: String,
    color: Option<String>,
    depart: Option<Hm>,
    from: String,
    to: String,
    stops: Vec<StopSummary>,
}

#[derive(Clone, Debug, PartialEq)]
struct StopSummary {
    id: StopId,
    place: String,
    task: &'static str,
    time: Option<Hm>,
    note: String,
}

fn route_summary(state: &TripState, id: RouteId) -> Option<RouteSummary> {
    let route = state.routes.get(&id)?;
    Some(RouteSummary {
        vehicle: state.vehicles.get(&route.vehicle).map_or_else(
            || UNKNOWN_VEHICLE.to_owned(),
            |vehicle| vehicle.name.clone(),
        ),
        color: vehicle_color(state, route.vehicle).map(str::to_owned),
        depart: route.depart,
        from: place_name(state, route.from).to_owned(),
        to: place_name(state, route.to).to_owned(),
        stops: route
            .stops
            .iter()
            .map(|stop| StopSummary {
                id: stop.id,
                place: place_name(state, stop.place).to_owned(),
                task: stop_task(stop).label(),
                time: stop.time,
                note: stop.note.clone(),
            })
            .collect(),
    })
}

/// 一張路線卡片；正在編輯時改為顯示表單。
#[component]
fn RouteCard(id: RouteId, day: Date) -> impl IntoView {
    let TripContext { handle, ui, .. } = use_trip();
    let slot = (Entity::Route, RowKey::Id(id.0));
    let summary = Memo::new(move |_| handle.with_view(|state| route_summary(state, id)).flatten());
    let editing = move || {
        ui.form_session::<RouteFields>(ROUTE_FORM)
            .filter(|form| form.target == FormTarget::Edit(slot))
    };
    let edit = move |_| {
        if let Some(draft) = handle
            .with_view(|state| state.routes.get(&id).map(RouteFields::of))
            .flatten()
        {
            ui.open_form(ROUTE_FORM, FormTarget::Edit(slot), draft);
        }
    };
    // Collaborator 也可以刪除路線（需求 6.17、22.9）
    let remove = move |_| {
        handle.submit_or_toast(Command::RemoveRoute { id });
    };
    let card = move || {
        let summary = summary.get()?;
        let vehicle = summary.vehicle.clone();
        let style = summary
            .color
            .as_ref()
            .map(|color| format!("--assignee-color:{color}"));
        let depart = match summary.depart {
            Some(time) => view! {
                <time datetime=format!("{day}T{time}")>{time.to_string()}</time>
                <span>"出發"</span>
            }
            .into_any(),
            None => view! { <span class="help">"出發時間待確認"</span> }.into_any(),
        };
        let stops = if summary.stops.is_empty() {
            "沒有停靠點".into_any()
        } else {
            view! {
                <ol>
                    {summary
                        .stops
                        .iter()
                        .map(|stop| {
                            let time = stop.time.map(|time| format!("{time} ")).unwrap_or_default();
                            let note = (!stop.note.is_empty()).then(|| format!("（{}）", stop.note));
                            view! {
                                <li data-stop=stop.id.to_string()>
                                    {format!("{time}{}・{}", stop.place, stop.task)}
                                    {note}
                                </li>
                            }
                        })
                        .collect_view()}
                </ol>
            }
            .into_any()
        };
        Some(view! {
            <div class="departure-vehicle-top">
                <div class="departure-vehicle-name" style=style>
                    {art::static_svg(icons::CAR)}
                    <h3>{vehicle.clone()}</h3>
                </div>
                <div class="vehicle-swipe-actions">
                    <EditorAvatars item=slot />
                    <button
                        type="button"
                        class="icon-button"
                        data-row-action="edit"
                        aria-label=format!("編輯 {vehicle}的路線")
                        on:click=edit
                    >
                        {art::static_svg(icons::EDIT)}
                    </button>
                    <button
                        type="button"
                        class="icon-button danger"
                        data-row-action="delete"
                        aria-label=format!("刪除 {vehicle}的路線")
                        on:click=remove
                    >
                        {art::static_svg(icons::CLOSE)}
                    </button>
                </div>
            </div>
            <div class="departure-vehicle-time">{depart}</div>
            <p class="departure-vehicle-place">
                {art::static_svg(icons::PIN)}
                <span>{format!("{} → {}", summary.from, summary.to)}</span>
            </p>
            <dl>
                <div>
                    <dt>"停靠"</dt>
                    <dd>{stops}</dd>
                </div>
            </dl>
        })
    };
    view! {
        <article
            class="departure-vehicle"
            class:wide=move || editing().is_some()
            data-swipe-row=move || editing().is_none().then_some("")
        >
            {move || match editing() {
                Some(form) => view! { <RouteEditor form day /> }.into_any(),
                None => card().into_any(),
            }}
        </article>
    }
}

/// `<select>` 的一個選項。
fn option_view(value: String, label: String, selected: bool) -> impl IntoView {
    view! {
        <option value=value selected=selected>
            {label}
        </option>
    }
}

/// 地點的 `<select>`：「請選擇」與 [`place_options`]；`chosen` 不在選項中（例如已被其他成員刪除）時選「請選擇」。
fn place_select(
    label: &'static str,
    options: Memo<Vec<(PlaceRef, String)>>,
    chosen: Option<PlaceRef>,
    on_change: impl Fn(Option<PlaceRef>) + 'static,
) -> impl IntoView {
    let options = options.get();
    let chosen = chosen.filter(|place| options.iter().any(|(option, _)| option == place));
    view! {
        <label class="field">
            <span>{label}</span>
            <select on:change=move |event| on_change(parse_place(&event_target_value(&event)))>
                {option_view(String::new(), "請選擇".to_owned(), chosen.is_none())}
                {options
                    .into_iter()
                    .map(|(place, name)| {
                        option_view(place_value(Some(place)), name, Some(place) == chosen)
                    })
                    .collect_view()}
            </select>
        </label>
    }
}

/// 路線卡片的表單（新增與編輯共用）。
#[component]
fn RouteEditor(form: FormSession<RouteFields>, day: Date) -> impl IntoView {
    let TripContext { handle, .. } = use_trip();
    let draft = form.draft;
    let route_id = draft.with_untracked(|draft| draft.id);
    let is_new = form.target == FormTarget::New;
    let vehicles = Memo::new(move |_| {
        handle
            .with_view(|state| free_vehicles(state, day, Some(route_id)))
            .unwrap_or_default()
    });
    let places = Memo::new(move |_| handle.with_view(place_options).unwrap_or_default());
    let stop_ids = Memo::new(move |_| {
        draft.with(|draft| draft.stops.iter().map(|stop| stop.id).collect::<Vec<_>>())
    });
    let full = move || stop_ids.with(Vec::len) >= max_stops();
    let save = move |event: leptos::ev::SubmitEvent| {
        event.prevent_default();
        // 路線的日期：編輯時是路線目前的日期（改日期後可能已搬到另一天），新增時是選定的日子
        let day = handle
            .with_view(|state| state.routes.get(&route_id).map(|route| route.day))
            .flatten()
            .unwrap_or(day);
        form.save(|initial, current| (is_new || initial != current).then(|| current.command(day)));
    };
    let remove = move |_| {
        form.submit(Command::RemoveRoute { id: route_id });
    };
    let add_stop = move |_| {
        draft.update(|draft| {
            if draft.stops.len() < max_stops() {
                draft.stops.push(StopFields::new());
            }
        });
    };
    view! {
        <form class="route-form" novalidate on:submit=save>
            <FormNotices form />
            <FormFields form>
                <h3>{if is_new { "新增路線" } else { "編輯路線" }}</h3>
                <div class="form-grid">
                    <label class="field">
                        <span>"哪一台車"</span>
                        {move || {
                            let options = vehicles.get();
                            let chosen = draft
                                .with_untracked(|draft| draft.vehicle)
                                .filter(|id| options.iter().any(|(option, _)| option == id));
                            view! {
                                <select on:change=move |event| {
                                    let value = event_target_value(&event);
                                    let vehicle = Uuid::parse_str(&value).ok().map(VehicleId);
                                    draft.update(|draft| draft.vehicle = vehicle);
                                }>
                                    {option_view(String::new(), "請選擇".to_owned(), chosen.is_none())}
                                    {options
                                        .into_iter()
                                        .map(|(id, name)| {
                                            option_view(id.to_string(), name, Some(id) == chosen)
                                        })
                                        .collect_view()}
                                </select>
                            }
                        }}
                    </label>
                    <label class="field">
                        <span>"出發時間"</span>
                        <input
                            type="text"
                            inputmode="numeric"
                            autocomplete="off"
                            placeholder="例如 08:30"
                            value=draft.with_untracked(|draft| draft.depart.clone())
                            on:input=move |event| {
                                let text = event_target_value(&event);
                                draft.update(|draft| draft.depart = text);
                            }
                        />
                    </label>
                    {move || {
                        place_select(
                            "從哪裡出發",
                            places,
                            draft.with_untracked(|draft| draft.from),
                            move |place| draft.update(|draft| draft.from = place),
                        )
                    }}
                    {move || {
                        place_select(
                            "最後到哪裡",
                            places,
                            draft.with_untracked(|draft| draft.to),
                            move |place| draft.update(|draft| draft.to = place),
                        )
                    }}
                </div>
                <ol class="route-stops">
                    <For
                        each=move || stop_ids.get()
                        key=|id| *id
                        children=move |id| view! { <StopEditor form id places /> }
                    />
                </ol>
                <button type="button" class="text-button" disabled=full on:click=add_stop>
                    {art::static_svg(icons::PLUS)}
                    "新增停靠點"
                </button>
                {move || full().then(|| view! { <p class="help">"每台車最多 6 個停靠點"</p> })}
            </FormFields>
            <FormError form />
            <div class="form-actions">
                {(!is_new)
                    .then(|| {
                        view! {
                            <button type="button" class="text-button danger" disabled=move || form.locked() on:click=remove>
                                "刪除路線"
                            </button>
                        }
                    })}
                <button type="button" class="button" on:click=move |_| form.close()>
                    "取消"
                </button>
                <button type="submit" class="button primary" disabled=move || form.locked()>
                    "儲存"
                    {art::static_svg(icons::CHECK)}
                </button>
            </div>
        </form>
    }
}

/// 表單中的一個停靠點：地點、種類、任務、時間與備註，以及上移、下移與移除。
#[component]
fn StopEditor(
    form: FormSession<RouteFields>,
    id: StopId,
    places: Memo<Vec<(PlaceRef, String)>>,
) -> impl IntoView {
    let draft = form.draft;
    let position =
        Memo::new(move |_| draft.with(|draft| draft.stops.iter().position(|stop| stop.id == id)));
    let count = Memo::new(move |_| draft.with(|draft| draft.stops.len()));
    let edit = move |change: &dyn Fn(&mut StopFields)| {
        draft.update(|draft| {
            if let Some(stop) = draft.stops.iter_mut().find(|stop| stop.id == id) {
                change(stop);
            }
        });
    };
    let initial = draft
        .with_untracked(|draft| draft.stops.iter().find(|stop| stop.id == id).cloned())
        .unwrap_or_else(StopFields::new);
    let kind = Memo::new(move |_| {
        draft.with(|draft| {
            draft
                .stops
                .iter()
                .find(|stop| stop.id == id)
                .map_or(StopKind::Shop, |stop| stop.kind)
        })
    });
    let shift = move |offset: isize| {
        draft.update(|draft| {
            let Some(from) = draft.stops.iter().position(|stop| stop.id == id) else {
                return;
            };
            let Some(to) = from
                .checked_add_signed(offset)
                .filter(|to| *to < draft.stops.len())
            else {
                return;
            };
            draft.stops.swap(from, to);
        });
    };
    let number = move || position.get().map_or(0, |index| index + 1);
    view! {
        <li>
            <fieldset>
                <legend>{move || format!("第 {} 個停靠點", number())}</legend>
                <div class="form-grid">
                    {move || {
                        place_select(
                            "停在哪裡",
                            places,
                            draft
                                .with_untracked(|draft| {
                                    draft.stops.iter().find(|stop| stop.id == id).and_then(|stop| stop.place)
                                }),
                            move |place| edit(&|stop| stop.place = place),
                        )
                    }}
                    <label class="field">
                        <span>"停靠點種類"</span>
                        <select on:change=move |event| {
                            if let Some(next) = StopKind::parse(&event_target_value(&event)) {
                                // 任務必須屬於種類：改種類時改用新種類的預設任務（需求 22.8）
                                edit(&|stop| {
                                    if stop.kind != next {
                                        stop.kind = next;
                                        stop.task = None;
                                    }
                                });
                            }
                        }>
                            {StopKind::ALL
                                .iter()
                                .map(|value| {
                                    option_view(
                                        value.as_str().to_owned(),
                                        value.label().to_owned(),
                                        *value == initial.kind,
                                    )
                                })
                                .collect_view()}
                        </select>
                    </label>
                    <label class="field">
                        <span>"要做什麼"</span>
                        {move || {
                            let kind = kind.get();
                            let chosen = draft
                                .with_untracked(|draft| {
                                    draft.stops.iter().find(|stop| stop.id == id).and_then(|stop| stop.task)
                                })
                                .filter(|task| task.kind() == kind);
                            view! {
                                <select on:change=move |event| {
                                    let task = StopTask::parse(&event_target_value(&event));
                                    edit(&|stop| stop.task = task);
                                }>
                                    {option_view(
                                        String::new(),
                                        format!("{}（預設）", kind.default_task().label()),
                                        chosen.is_none(),
                                    )}
                                    {kind
                                        .tasks()
                                        .map(|task| {
                                            option_view(
                                                task.as_str().to_owned(),
                                                task.label().to_owned(),
                                                Some(task) == chosen,
                                            )
                                        })
                                        .collect_view()}
                                </select>
                            }
                        }}
                    </label>
                    <label class="field">
                        <span>"時間"</span>
                        <input
                            type="text"
                            inputmode="numeric"
                            autocomplete="off"
                            placeholder="例如 10:00"
                            value=initial.time.clone()
                            on:input=move |event| {
                                let text = event_target_value(&event);
                                edit(&|stop| stop.time = text.clone());
                            }
                        />
                    </label>
                    <label class="field wide">
                        <span>"備註"</span>
                        <input
                            type="text"
                            autocomplete="off"
                            value=initial.note.clone()
                            on:input=move |event| {
                                let text = event_target_value(&event);
                                edit(&|stop| stop.note = text.clone());
                            }
                        />
                    </label>
                </div>
                <div class="form-actions">
                    <button
                        type="button"
                        class="icon-button"
                        aria-label=move || format!("上移第 {} 個停靠點", number())
                        disabled=move || position.get() == Some(0)
                        on:click=move |_| shift(-1)
                    >
                        {art::static_svg(icons::UP)}
                    </button>
                    <button
                        type="button"
                        class="icon-button"
                        aria-label=move || format!("下移第 {} 個停靠點", number())
                        disabled=move || position.get().is_none_or(|index| index + 1 >= count.get())
                        on:click=move |_| shift(1)
                    >
                        {art::static_svg(icons::DOWN)}
                    </button>
                    <button
                        type="button"
                        class="text-button danger"
                        on:click=move |_| {
                            draft.update(|draft| draft.stops.retain(|stop| stop.id != id));
                        }
                    >
                        {move || format!("移除第 {} 個停靠點", number())}
                    </button>
                </div>
            </fieldset>
        </li>
    }
}
