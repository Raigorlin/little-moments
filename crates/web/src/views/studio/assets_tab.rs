//! 編輯器的「地點與車」分頁（template.js `#panel-assets`；Bun `renderPlaces()`、`renderVehicles()`、`addPlace()`、
//! `removePlace()`、`addVehicle()` 與 `removeVehicle()`）。
//!
//! - 地點：選擇地點、改名稱（旅行目的地以 `UpdateTrip` 改目的地，其他以 `RenamePlace`）、新增（「新地點」，插圖是
//!   家／出發地）與移除。Bun 一律隱藏插圖選擇（`#placeArt`），這裡也只保留隱藏的版面。
//! - 車輛：顏色與名稱（`UpdateVehicle`）、新增（「第 N 台車」，4 個座位，取還沒有車使用的顏色）與移除。移除有路線的
//!   車時先確認，再在同一筆編輯中刪除它的路線與這台車。座位、駕駛與乘客在 Trip_Menu 中修改。
use std::collections::BTreeSet;

use leptos::prelude::*;
use lm_core::command::{Command, Input, TripPatch, VehicleDraft, VehiclePatch};
use lm_core::ids::{PlaceId, VehicleId};
use lm_core::limits::{PLACES_MAX, PLACE_NAME_CHARS, TRIP_DESTINATION_CHARS, VEHICLE_NAME_CHARS};
use lm_core::model::{PlaceRef, PlaceTemplate};
use lm_core::storybook::StudioPlan;

use super::editor::{new_id, parse_place, place_value, use_editor, Editor, Tone, TRASH_SVG};
use super::journal::vehicle_name;

/// 新車輛的顏色（Bun `COLORS`）：第一個還沒有車使用的顏色，都用過時依車輛數輪流。
const COLORS: [&str; 6] = [
    "#83accc", "#dd775f", "#69a9a0", "#e7b84d", "#a58bc4", "#8fae6b",
];

/// 插圖選單的分組（Bun `GROUP_LABELS` 與 `TEMPLATES` 的 group）。
const TEMPLATE_GROUPS: [(&str, &[PlaceTemplate]); 3] = [
    ("住家", &[PlaceTemplate::Home]),
    (
        "商店",
        &[
            PlaceTemplate::Market,
            PlaceTemplate::SevenEleven,
            PlaceTemplate::FamilyMart,
            PlaceTemplate::OkMart,
            PlaceTemplate::PxmartMega,
            PlaceTemplate::Costco,
            PlaceTemplate::Ikea,
            PlaceTemplate::Carrefour,
        ],
    ),
    (
        "露營",
        &[
            PlaceTemplate::Tent,
            PlaceTemplate::Bell,
            PlaceTemplate::Dome,
            PlaceTemplate::Tarp,
            PlaceTemplate::Camper,
            PlaceTemplate::Cabin,
        ],
    ),
];

/// 選定的地點：`editor.place` 仍在地點清單中時是它，否則是第一個地點（Bun `changed()`）。
fn selected_place(editor: Editor, plan: &StudioPlan) -> Option<PlaceRef> {
    let chosen = editor.place.get();
    chosen
        .filter(|place| plan.places.iter().any(|item| item.place == *place))
        .or_else(|| plan.places.first().map(|item| item.place))
}

/// Bun `placeRefs()`：還在使用這個地點的日子、路線與途中任務。
fn place_refs(plan: &StudioPlan, place: PlaceRef) -> Vec<String> {
    let mut refs = Vec::new();
    for (i, day) in plan.days.iter().enumerate() {
        if day.location == Some(place) {
            refs.push(format!("第 {} 天的所在地點", i + 1));
        }
        for route in &day.routes {
            if route.from == place || route.to == place {
                refs.push(format!(
                    "第 {} 天 {} 的路線",
                    i + 1,
                    vehicle_name(plan, route.vehicle)
                ));
            } else if route.stops.iter().any(|stop| stop.place == place) {
                refs.push(format!(
                    "第 {} 天 {} 的途中任務",
                    i + 1,
                    vehicle_name(plan, route.vehicle)
                ));
            }
        }
    }
    refs
}

/// `li.vehicle`：顏色、名稱與移除。
#[component]
fn VehicleRow(i: usize, id: VehicleId) -> impl IntoView {
    let editor = use_editor();
    let vehicle = Memo::new(move |_| {
        editor.plan.with(|plan| {
            plan.as_ref()
                .and_then(|plan| plan.vehicles.iter().find(|vehicle| vehicle.id == id))
                .map(|vehicle| (vehicle.name.clone(), vehicle.color.to_lowercase()))
        })
    });
    let name =
        move || vehicle.with(|vehicle| vehicle.as_ref().map(|v| v.0.clone()).unwrap_or_default());
    let name_id = format!("vehicle-{i}-name");
    let color_id = format!("vehicle-{i}-color");
    let name_bad = editor.bad(name_id.clone());
    let update = move |source: &str, patch: VehiclePatch| {
        editor.commit(Some(source), vec![Command::UpdateVehicle { id, patch }]);
    };
    let remove = move |_: leptos::ev::MouseEvent| remove_vehicle(editor, id);
    view! {
        <li class="vehicle">
            <label for=name_id.clone() class="sr">
                {format!("第 {} 台車名稱", i + 1)}
            </label>
            <input
                id=color_id.clone()
                type="color"
                prop:value=move || {
                    vehicle
                        .with(|vehicle| vehicle.as_ref().map(|v| v.1.clone()))
                        .unwrap_or_else(|| COLORS[0].to_owned())
                }
                aria-label=move || format!("{} 顏色", name())
                on:change={
                    let color_id = color_id.clone();
                    move |event| {
                        update(
                            &color_id,
                            VehiclePatch {
                                color: Some(Some(event_target_value(&event))),
                                ..VehiclePatch::default()
                            },
                        )
                    }
                }
            />
            <input
                id=name_id.clone()
                prop:value=name
                maxlength=VEHICLE_NAME_CHARS.end().to_string()
                autocomplete="off"
                aria-invalid=move || name_bad.get().then_some("true")
                aria-describedby={
                    let error = format!("{name_id}-error");
                    move || name_bad.get().then(|| error.clone())
                }
                on:input={
                    let name_id = name_id.clone();
                    move |_| editor.set_typing(&name_id, true)
                }
                on:change={
                    let name_id = name_id.clone();
                    move |event| {
                        editor.set_typing(&name_id, false);
                        update(
                            &name_id,
                            VehiclePatch {
                                name: Some(event_target_value(&event)),
                                ..VehiclePatch::default()
                            },
                        )
                    }
                }
            />
            {editor.error_view(name_id.clone())}
            <button
                type="button"
                id=format!("removeVehicle-{i}")
                class="danger icon trash"
                aria-label=move || format!("移除 {}", name())
                disabled=move || !editor.can_manage.get()
                title=move || {
                    if editor.can_manage.get() { "移除這台車" } else { "你沒有刪除車輛的權限" }
                }
                on:click=remove
                inner_html=TRASH_SVG
            ></button>
        </li>
    }
}

/// Bun `removeVehicle()`。
fn remove_vehicle(editor: Editor, id: VehicleId) {
    if !editor.can_manage.get_untracked() {
        editor.notice("你沒有刪除車輛的權限。", Tone::Error);
        return;
    }
    let Some((name, used, routes)) = editor.plan.with_untracked(|plan| {
        let plan = plan.as_ref()?;
        let name = vehicle_name(plan, id);
        let mut used = Vec::new();
        let mut routes = Vec::new();
        for (k, day) in plan.days.iter().enumerate() {
            let mine: Vec<_> = day
                .routes
                .iter()
                .filter(|route| route.vehicle == id)
                .map(|route| route.id)
                .collect();
            if !mine.is_empty() {
                used.push((k + 1).to_string());
                routes.extend(mine);
            }
        }
        Some((name, used, routes))
    }) else {
        return;
    };
    let days = used.join("、");
    if !used.is_empty() {
        let question = format!(
            "「{name}」在第 {days} 天有路線。移除車輛會一併刪除這 {} 條路線（含途中任務）。確定移除？",
            used.len()
        );
        let confirmed = web_sys::window()
            .and_then(|window| window.confirm_with_message(&question).ok())
            .unwrap_or(false);
        if !confirmed {
            editor.notice(format!("已取消：「{name}」與其路線都保留。"), Tone::Plain);
            return;
        }
    }
    editor.open_stops.set(BTreeSet::new());
    let mut commands: Vec<Command> = routes
        .iter()
        .map(|route| Command::RemoveRoute { id: *route })
        .collect();
    commands.push(Command::RemoveVehicle { id });
    if editor.commit(None, commands) {
        editor.notice(
            if used.is_empty() {
                format!("已移除「{name}」。")
            } else {
                format!(
                    "已移除「{name}」，並刪除第 {days} 天共 {} 條路線。",
                    used.len()
                )
            },
            Tone::Ok,
        );
    }
}

/// `#panel-assets` 的內容。
#[component]
pub(super) fn AssetsPanel() -> impl IntoView {
    let editor = use_editor();
    let plan = editor.plan;
    let has_places = Memo::new(move |_| {
        plan.with(|plan| plan.as_ref().is_some_and(|plan| !plan.places.is_empty()))
    });
    let selected = Memo::new(move |_| {
        plan.with(|plan| plan.as_ref().and_then(|plan| selected_place(editor, plan)))
    });
    let place_bad = editor.bad("placeName".to_owned());
    let place_count = Memo::new(move |_| {
        editor
            .handle
            .with_view(|state| state.places.len())
            .unwrap_or(0)
    });
    let vehicles = Memo::new(move |_| {
        plan.with(|plan| {
            plan.as_ref()
                .map(|plan| {
                    plan.vehicles
                        .iter()
                        .enumerate()
                        .map(|(i, vehicle)| (i, vehicle.id))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        })
    });

    let place_options = move || {
        let chosen = selected.get();
        plan.with(|plan| {
            plan.as_ref().map(|plan| {
                plan.places
                    .iter()
                    .map(|item| {
                        let value = place_value(item.place);
                        view! {
                            <option
                                value=value.clone()
                                data-place-id=value
                                prop:selected=chosen == Some(item.place)
                            >
                                {item.name.clone()}
                            </option>
                        }
                    })
                    .collect_view()
            })
        })
    };
    let on_select = move |event: leptos::ev::Event| {
        if editor.invalid_message("placeName").is_some() {
            // 回到原本選的地點
            if let Some(place) = selected.get_untracked() {
                event_target::<web_sys::HtmlSelectElement>(&event).set_value(&place_value(place));
            }
            editor.flush_draft();
            return;
        }
        editor.place.set(parse_place(&event_target_value(&event)));
    };
    let on_rename = move |event: leptos::ev::Event| {
        editor.set_typing("placeName", false);
        let name = event_target_value(&event);
        let command = match selected.get_untracked() {
            Some(PlaceRef::Destination) => Command::UpdateTrip {
                patch: TripPatch {
                    destination: Some(name),
                    ..TripPatch::default()
                },
            },
            Some(PlaceRef::Place(id)) => Command::RenamePlace { id, name },
            None => return,
        };
        editor.commit(Some("placeName"), vec![command]);
    };
    // Bun addPlace()
    let add_place = move |_: leptos::ev::MouseEvent| {
        if !editor.flush_draft() {
            return;
        }
        let id: PlaceId = new_id();
        if editor.commit(
            None,
            vec![Command::AddPlace {
                id,
                name: "新地點".to_owned(),
                template: Some(Input::Ok(PlaceTemplate::Home)),
            }],
        ) {
            editor.place.set(Some(PlaceRef::Place(id)));
            editor.focus_later("placeName".to_owned(), true);
        }
    };
    // Bun removePlace()
    let remove_place = move |_: leptos::ev::MouseEvent| {
        let Some((place, name, refs)) = plan.with_untracked(|plan| {
            let plan = plan.as_ref()?;
            let place = selected.get_untracked()?;
            let name = plan
                .places
                .iter()
                .find(|item| item.place == place)?
                .name
                .clone();
            Some((place, name, place_refs(plan, place)))
        }) else {
            return;
        };
        if !refs.is_empty() {
            editor.notice(
                format!(
                    "無法移除「{name}」：仍被 {} 使用。請先改掉這些設定。",
                    refs.join("、")
                ),
                Tone::Error,
            );
            return;
        }
        let PlaceRef::Place(id) = place else {
            editor.notice(
                "未套用：旅行目的地請在旅行設定中修改，不能在行程編輯器移除",
                Tone::Error,
            );
            return;
        };
        if editor.commit(None, vec![Command::RemovePlace { id }]) {
            editor.notice(format!("已移除地點「{name}」。"), Tone::Ok);
        }
    };
    // Bun addVehicle()
    let add_vehicle = move |_: leptos::ev::MouseEvent| {
        let Some((n, used)) = plan.with_untracked(|plan| {
            plan.as_ref().map(|plan| {
                (
                    plan.vehicles.len(),
                    plan.vehicles
                        .iter()
                        .map(|vehicle| vehicle.color.to_lowercase())
                        .collect::<Vec<_>>(),
                )
            })
        }) else {
            return;
        };
        let color = COLORS
            .iter()
            .find(|color| !used.iter().any(|used| used == *color))
            .copied()
            .unwrap_or(COLORS[n % COLORS.len()]);
        let id: VehicleId = new_id();
        if editor.commit(
            None,
            vec![Command::AddVehicle {
                id,
                draft: VehicleDraft {
                    name: format!("第 {} 台車", n + 1),
                    driver: None,
                    seats: Some(Input::Ok(4)),
                    color: Some(color.to_owned()),
                    passengers: BTreeSet::new(),
                },
            }],
        ) {
            editor.focus_later(format!("vehicle-{n}-name"), false);
        }
    };
    let templates = TEMPLATE_GROUPS
        .iter()
        .map(|(group, templates)| {
            let options = templates
                .iter()
                .map(|template| {
                    view! { <option value=template.as_str()>{template.label()}</option> }
                })
                .collect_view();
            view! { <optgroup label=*group>{options}</optgroup> }
        })
        .collect_view();

    view! {
        <h2>"地點"</h2>
        <p class="empty" id="noPlaces" hidden=move || has_places.get()>
            "還沒有地點。新增地點後，就能安排路線與停靠點。"
        </p>
        <div class="form-grid" id="placeFields" hidden=move || !has_places.get()>
            <div>
                <label for="placeSelect">"選擇地點"</label>
                <select id="placeSelect" on:change=on_select>
                    {place_options}
                </select>
            </div>
            <div>
                <label for="placeName">"名稱"</label>
                <input
                    id="placeName"
                    autocomplete="off"
                    maxlength=move || {
                        if selected.get() == Some(PlaceRef::Destination) {
                            TRIP_DESTINATION_CHARS.end().to_string()
                        } else {
                            PLACE_NAME_CHARS.end().to_string()
                        }
                    }
                    prop:value=move || {
                        let chosen = selected.get();
                        plan.with(|plan| {
                            plan.as_ref()
                                .and_then(|plan| {
                                    plan.places.iter().find(|item| Some(item.place) == chosen)
                                })
                                .map(|item| item.name.clone())
                        })
                            .unwrap_or_default()
                    }
                    aria-invalid=move || place_bad.get().then_some("true")
                    aria-describedby=move || place_bad.get().then_some("placeName-error")
                    on:input=move |_| editor.set_typing("placeName", true)
                    on:change=on_rename
                />
                {editor.error_view("placeName".to_owned())}
            </div>
        </div>
        <div id="placeArt" hidden=true>
            <label for="placeTemplate">
                "插圖 " <span class="hint">"· 也可直接點下方縮圖"</span>
            </label>
            <select id="placeTemplate">{templates}</select>
            <div class="template-grid" id="templateGrid" role="group" aria-label="選擇插圖"></div>
        </div>
        <div class="route-actions">
            <button
                type="button"
                id="addPlace"
                disabled=move || { place_count.get() >= PLACES_MAX }
                on:click=add_place
            >
                "＋ 新增地點"
            </button>
            <button
                type="button"
                id="removePlace"
                class="danger icon trash"
                aria-label="移除此地點"
                title="移除此地點"
                disabled=move || !has_places.get()
                on:click=remove_place
                inner_html=TRASH_SVG
            ></button>
        </div>
        <h2 class="section-break">"車輛"</h2>
        <p class="hint">"顏色就是海報上這台車的路線顏色。"</p>
        <ul id="vehicleList" class="list">
            <For
                each=move || vehicles.get()
                key=|row| *row
                children=move |(i, id)| view! { <VehicleRow i id /> }
            />
        </ul>
        <button type="button" id="addVehicle" class="add" on:click=add_vehicle>
            "＋ 新增車輛"
        </button>
    }
}
