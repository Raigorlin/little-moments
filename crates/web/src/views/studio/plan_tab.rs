//! 編輯器的「行程」分頁（template.js `#panel-plan`；Bun `renderDay()`、`renderRoutes()`、`renderStops()`、
//! `companionPicker()`、`renderEvents()`、`addDay()`、`removeDay()`、`addRoute()`、`addStop()` 與 `addEvent()`）。
//!
//! - 編輯哪一天（`#dayTabs`）與「這一天的設定」：標題、抵達說明、路線位置與地點以 `SaveDaySetting` 送出；改某一天的
//!   日期時整趟旅行一起平移，讓這一天落在選的日期（Decision D6）；新增一天與移除最後一天改變旅行的結束日。
//! - 路線：車、出發時間、起點與終點，以及途中任務（停靠點）。每一個改動都以 `SaveRoute` 送出整條路線。採買的停靠點列出
//!   依採買分工分到的品項（唯讀）；接送的停靠點勾選旅伴；其他停靠點是每行一項的待辦清單。
//! - 活動：活動以 `UpdateActivity`、料理（標示「餐點」）以 `UpdateMeal` 修改；料理的插圖由菜單決定，刪除料理需要
//!   Trip_Manager。
//! - 未分配採買清單（唯讀）。
use std::collections::BTreeSet;

use leptos::ev;
use leptos::html;
use leptos::prelude::*;
use lm_core::command::{
    ActivityDraft, ActivityPatch, Command, DateSpan, DaySettingPatch, Input, MealPatch, RouteDraft,
    StopDraft, TripPatch,
};
use lm_core::ids::{ActivityId, RouteId, StopId, VehicleId};
use lm_core::limits::{
    ACTIVITIES_MAX, ACTIVITY_NOTE_CHARS, ACTIVITY_TITLE_CHARS, ARRIVAL_LABEL_CHARS,
    DAY_TITLE_CHARS, ROUTE_STOPS, STOP_NOTE_CHARS, TRIP_DAYS,
};
use lm_core::model::{
    ActivityKind, Date, Participation, PlaceRef, RoutePosition, StopKind, StopTask,
};
use lm_core::storybook::{
    stop_task_parts, EventSource, StudioDay, StudioEvent, StudioKind, StudioRoute, StudioStop,
    STUDIO_STOP_KINDS,
};
use lm_core::time::{date_text, parse_date, Hm};
use uuid::Uuid;

use super::editor::{
    day_label, grow, lines, new_id, parse_place, place_value, time_input, time_text, use_editor,
    Editor, Tone, TRASH_SVG,
};
use super::inverse::activity_draft;
use super::journal::{place_name, vehicle_name};
use super::{EditorTab, PlanSection};

/// Bun `STOP_HINTS`：停靠備註的提示。
fn stop_hint(task: StopTask) -> &'static str {
    match task {
        StopTask::Shopping => "例：先到門口集合",
        StopTask::GearPickup => "例：預約編號、取件人",
        StopTask::GearReturn => "例：歸還期限",
        StopTask::PassengerPickup => "例：乘客姓名、人數、集合點",
        StopTask::PassengerDropoff => "例：乘客姓名",
        StopTask::CarRental => "例：租車預約編號",
        StopTask::CarReturn => "例：還車前加滿油",
        StopTask::Waypoint => "備註",
    }
}

/// Bun `stopItemsLabel()`。
fn stop_items_label(task: StopTask) -> &'static str {
    match task {
        StopTask::Shopping => "要買什麼？（每行一項）",
        StopTask::GearReturn => "要歸還的裝備（每行一項）",
        StopTask::GearPickup => "要領取的裝備（每行一項）",
        StopTask::PassengerPickup | StopTask::PassengerDropoff => "旅伴名單（選填，每行一位）",
        StopTask::CarRental | StopTask::CarReturn => "取還車檢查清單（選填）",
        StopTask::Waypoint => "待辦清單（選填，每行一項）",
    }
}

/// Bun `stopNotesLabel()`。
fn stop_notes_label(task: StopTask) -> &'static str {
    match task {
        StopTask::PassengerPickup | StopTask::PassengerDropoff => "集合位置／接送提醒（選填）",
        StopTask::GearPickup | StopTask::GearReturn | StopTask::CarRental | StopTask::CarReturn => {
            "預約資訊／取還提醒（選填）"
        }
        _ => "停靠備註（選填）",
    }
}

fn is_passenger(task: StopTask) -> bool {
    matches!(task, StopTask::PassengerPickup | StopTask::PassengerDropoff)
}

/// Bun `eventTitle()`。
fn event_title(event: &StudioEvent) -> String {
    if event.title.is_empty() {
        "未命名活動".to_owned()
    } else {
        event.title.clone()
    }
}

/// Bun `routeOverview()`：「起點 → 終點 · N 個停靠點」（沒有停靠點時是「直達」）。
fn route_overview(plan: &lm_core::storybook::StudioPlan, route: &StudioRoute) -> String {
    let stops = if route.stops.is_empty() {
        "直達".to_owned()
    } else {
        format!("{} 個停靠點", route.stops.len())
    };
    format!(
        "{} → {} · {stops}",
        place_name(plan, Some(route.from)),
        place_name(plan, Some(route.to))
    )
}

/// 地點選單的選項（Bun `placeOptions()`）：旅行目的地不是空白時先列它，再依 Ordinal 列出地點清單。
fn place_options(editor: Editor, chosen: Option<PlaceRef>) -> impl IntoView {
    editor.plan.with(|plan| {
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
}

/// 欄位的 `aria-invalid` 與 `aria-describedby`（未通過檢查時指向錯誤訊息）。
fn invalid_attrs(
    editor: Editor,
    id: &str,
) -> (
    impl Fn() -> Option<&'static str> + Send + Sync + 'static,
    impl Fn() -> Option<String> + Send + Sync + 'static,
) {
    let bad = editor.bad(id.to_owned());
    let error = format!("{id}-error");
    (
        move || bad.get().then_some("true"),
        move || bad.get().then(|| error.clone()),
    )
}

/// 選定的那一天在 Studio_Plan 中的內容。
type Today = Memo<Option<StudioDay>>;

/// 文字框隨內容長高：掛上之後與 `value` 改變時。
fn auto_grow(node: NodeRef<html::Textarea>, value: impl Fn() -> String + 'static) {
    Effect::new(move |_| {
        value();
        if let Some(textarea) = node.get() {
            request_animation_frame(move || grow(&textarea));
        }
    });
}

// ── 途中任務 ──

/// `li.stop-entry`：一個停靠點（Bun `renderStops()` 的 `items`）。
#[component]
fn StopEntry(i: usize, j: usize, route: RouteId, id: StopId, today: Today) -> impl IntoView {
    let editor = use_editor();
    let stop = Memo::new(move |_| {
        today.with(|day| {
            day.as_ref()
                .and_then(|day| day.routes.iter().find(|r| r.id == route))
                .and_then(|r| r.stops.iter().find(|stop| stop.id == id))
                .cloned()
        })
    });
    let task =
        Memo::new(move |_| stop.with(|stop| stop.as_ref().map_or(StopTask::Waypoint, |s| s.kind)));
    let read = move |f: fn(&StudioStop) -> String| {
        stop.with(|stop| stop.as_ref().map(f).unwrap_or_default())
    };
    let p = format!("stop-{i}-{j}");
    let stop_key = move || format!("stop-{}-{i}-{j}", editor.studio.day.get_untracked());
    let open = move || {
        let key = stop_key();
        editor.open_stops.with(|open| {
            !open.contains(&format!("closed-{key}")) && (j == 0 || open.contains(&key))
        })
    };
    let on_toggle = move |event: ev::Event| {
        let details = event_target::<web_sys::HtmlDetailsElement>(&event);
        if !details.is_connected() {
            return;
        }
        let key = stop_key();
        let closed = format!("closed-{key}");
        let is_open = details.open();
        if is_open
            == editor
                .open_stops
                .with_untracked(|s| !s.contains(&closed) && (j == 0 || s.contains(&key)))
        {
            return;
        }
        editor.open_stops.update(|set| {
            if is_open {
                set.insert(key);
                set.remove(&closed);
            } else {
                set.remove(&key);
                set.insert(closed);
            }
        });
    };
    let save = move |source: &str, change: Box<dyn FnOnce(&mut StopDraft)>| {
        editor.save_stop(route, id, Some(source), change)
    };

    let kind_id = format!("{p}-kind");
    let time_id = format!("{p}-time");
    let place_id = format!("{p}-place");
    let items_id = format!("{p}-items");
    let notes_id = format!("{p}-notes");

    let kind_select = {
        let source = kind_id.clone();
        let (invalid, described) = invalid_attrs(editor, &kind_id);
        let options = STUDIO_STOP_KINDS
            .into_iter()
            .map(|option| {
                view! {
                    <option value=option.as_str() prop:selected=move || task.get() == option>
                        {option.label()}
                    </option>
                }
            })
            .collect_view();
        view! {
            <select
                id=kind_id.clone()
                aria-invalid=invalid
                aria-describedby=described
                on:change=move |event| {
                    let Some(chosen) = StopTask::parse(&event_target_value(&event)) else {
                        return;
                    };
                    let (kind, chosen) = stop_task_parts(chosen);
                    save(
                        &source,
                        Box::new(move |draft| {
                            draft.kind = Input::Ok(kind);
                            draft.task = (chosen != kind.default_task()).then_some(Input::Ok(chosen));
                            if kind == StopKind::Shop {
                                draft.items.clear();
                            }
                        }),
                    );
                }
            >
                {options}
            </select>
        }
    };
    let time_field = {
        let source = time_id.clone();
        let (invalid, described) = invalid_attrs(editor, &time_id);
        view! {
            <input
                id=time_id.clone()
                type="time"
                step="900"
                prop:value=move || stop.with(|s| time_text(s.as_ref().and_then(|s| s.time)))
                aria-invalid=invalid
                aria-describedby=described
                on:input={
                    let source = source.clone();
                    move |_| editor.set_typing(&source, true)
                }
                on:change=move |event| {
                    editor.set_typing(&source, false);
                    let time = time_input(&event_target_value(&event));
                    save(&source, Box::new(move |draft| draft.time = time));
                }
            />
        }
    };
    let place_select = {
        let source = place_id.clone();
        let (invalid, described) = invalid_attrs(editor, &place_id);
        view! {
            <select
                id=place_id.clone()
                aria-invalid=invalid
                aria-describedby=described
                on:change=move |event| {
                    let place = parse_place(&event_target_value(&event));
                    save(&source, Box::new(move |draft| draft.place = place));
                }
            >
                {move || place_options(editor, stop.with(|s| s.as_ref().map(|s| s.place)))}
            </select>
        }
    };

    // 文字框與它的清除按鈕（Bun `textRow()`）
    let notes_node = NodeRef::<html::Textarea>::new();
    auto_grow(notes_node, move || read(|s| s.note.clone()));
    let notes_row = {
        let source = notes_id.clone();
        let input_source = notes_id.clone();
        let (invalid, described) = invalid_attrs(editor, &notes_id);
        view! {
            <div class="stop-text">
                <div>
                    <label for=notes_id.clone()>{move || stop_notes_label(task.get())}</label>
                    <textarea
                        id=notes_id.clone()
                        rows="2"
                        maxlength=STOP_NOTE_CHARS.end().to_string()
                        placeholder=move || stop_hint(task.get())
                        node_ref=notes_node
                        prop:value=move || read(|s| s.note.clone())
                        aria-invalid=invalid
                        aria-describedby=described
                        on:input=move |event| {
                            editor.set_typing(&input_source, true);
                            grow(&event_target::<web_sys::HtmlElement>(&event));
                        }
                        on:change={
                            let source = source.clone();
                            move |event| {
                                editor.set_typing(&source, false);
                                let note = event_target_value(&event);
                                save(&source, Box::new(move |draft| draft.note = note));
                            }
                        }
                    ></textarea>
                    {editor.error_view(notes_id.clone())}
                </div>
                <button
                    type="button"
                    class="danger icon trash"
                    title="清除備註"
                    aria-label=format!("清除第 {} 站的備註", j + 1)
                    disabled=move || read(|s| s.note.clone()).is_empty()
                    on:click=move |_| {
                        save(&source, Box::new(|draft| draft.note.clear()));
                    }
                    inner_html=TRASH_SVG
                ></button>
            </div>
        }
    };

    let items_block = {
        let items_id = items_id.clone();
        move || {
            let current = task.get();
            if current == StopTask::Shopping {
                let items_id = items_id.clone();
                view! {
                    <div class="stop-auto">
                        <span class="stop-auto-label">"要買的品項（依本車乘客的採買分工）"</span>
                        <p id=items_id class="stop-auto-items">
                            {move || {
                                let items = stop.with(|s| s.as_ref().map(|s| s.items.clone()).unwrap_or_default());
                                if items.is_empty() {
                                    "本車乘客目前沒有負責的採買品項".to_owned()
                                } else {
                                    items.join("、")
                                }
                            }}
                        </p>
                        <p class="hint">"到網站的採買清單調整負責人，品項會自動分配到該旅伴搭乘的車。"</p>
                    </div>
                }
                .into_any()
            } else if is_passenger(current) {
                companion_picker(editor, &items_id, stop, save).into_any()
            } else {
                items_row(editor, &items_id, j, stop, current, save).into_any()
            }
        }
    };

    let summary = move || {
        editor.plan.with(|plan| {
            let plan = plan.as_ref()?;
            stop.with(|s| {
                s.as_ref().map(|s| {
                    format!(
                        "{} · {} · {}",
                        s.time
                            .map_or_else(|| "時間未填".to_owned(), |t| t.to_string()),
                        s.kind.label(),
                        place_name(plan, Some(s.place))
                    )
                })
            })
        })
    };
    let remove = move |_: ev::MouseEvent| {
        editor.save_route(route, None, |draft| {
            draft.stops.retain(|stop| stop.id != id)
        });
    };

    view! {
        <li class="stop-entry">
            <details
                id=format!("stop-entry-{i}-{j}")
                class="entry-details"
                prop:open=open
                on:toggle=on_toggle
            >
                <summary
                    class="entry-summary"
                    on:click=move |event: ev::MouseEvent| {
                        if !editor.flush_draft() {
                            event.prevent_default();
                        }
                    }
                >
                    <span class="entry-time">{format!("{:02}", j + 1)}</span>
                    <span class="entry-title" id=format!("stop-{i}-{j}-summary")>
                        {summary}
                    </span>
                </summary>
                <div class="entry-body">
                    <div class="item-head">
                        <strong class="accent">{format!("第 {} 站", j + 1)}</strong>
                        <button
                            type="button"
                            id=format!("removeStop-{i}-{j}")
                            class="danger icon trash"
                            title="刪除這一站"
                            aria-label=format!("刪除第 {} 站", j + 1)
                            on:click=remove
                            inner_html=TRASH_SVG
                        ></button>
                    </div>
                    <div class="grid3">
                        <div>
                            <label for=kind_id.clone()>"任務"</label>
                            {kind_select}
                            {editor.error_view(kind_id.clone())}
                        </div>
                        <div>
                            <label for=time_id.clone()>"時間（選填）"</label>
                            {time_field}
                            {editor.error_view(time_id.clone())}
                        </div>
                        <div>
                            <label for=place_id.clone()>"在哪裡停靠"</label>
                            {place_select}
                            {editor.error_view(place_id.clone())}
                        </div>
                    </div>
                    {items_block}
                    {notes_row}
                </div>
            </details>
        </li>
    }
}

/// 待辦清單（每行一項）與清除按鈕（Bun `textRow(list, stopItemsLabel(...))`）。
fn items_row(
    editor: Editor,
    items_id: &str,
    j: usize,
    stop: Memo<Option<StudioStop>>,
    task: StopTask,
    save: impl Fn(&str, Box<dyn FnOnce(&mut StopDraft)>) -> bool + Copy + Send + Sync + 'static,
) -> impl IntoView {
    let items = move || stop.with(|s| s.as_ref().map(|s| s.items.join("\n")).unwrap_or_default());
    let node = NodeRef::<html::Textarea>::new();
    auto_grow(node, items);
    let source = items_id.to_owned();
    let input_source = items_id.to_owned();
    let change_source = items_id.to_owned();
    let (invalid, described) = invalid_attrs(editor, items_id);
    view! {
        <div class="stop-text">
            <div>
                <label for=items_id.to_owned()>{stop_items_label(task)}</label>
                <textarea
                    id=items_id.to_owned()
                    rows="1"
                    class="grow"
                    placeholder="每行一項"
                    node_ref=node
                    prop:value=items
                    aria-invalid=invalid
                    aria-describedby=described
                    on:input=move |event| {
                        editor.set_typing(&input_source, true);
                        grow(&event_target::<web_sys::HtmlElement>(&event));
                    }
                    on:change=move |event| {
                        editor.set_typing(&change_source, false);
                        let items = lines(&event_target_value(&event));
                        save(&change_source, Box::new(move |draft| draft.items = items));
                    }
                ></textarea>
                {editor.error_view(items_id.to_owned())}
            </div>
            <button
                type="button"
                class="danger icon trash"
                title="清除待辦清單"
                aria-label=format!("清除第 {} 站的待辦清單", j + 1)
                disabled=move || items().is_empty()
                on:click=move |_| {
                    save(&source, Box::new(|draft| draft.items.clear()));
                }
                inner_html=TRASH_SVG
            ></button>
        </div>
    }
}

/// Bun `companionPicker()`：接送停靠點勾選旅伴（網站的旅伴名單，加上已不在名單中、但仍在停靠點上的名字）。
fn companion_picker(
    editor: Editor,
    items_id: &str,
    stop: Memo<Option<StudioStop>>,
    save: impl Fn(&str, Box<dyn FnOnce(&mut StopDraft)>) -> bool + Copy + Send + Sync + 'static,
) -> impl IntoView {
    let prefix = items_id.trim_end_matches("-items").to_owned();
    let chips = move || {
        let people = editor.people.get();
        let chosen: Vec<String> =
            stop.with(|s| s.as_ref().map(|s| s.items.clone()).unwrap_or_default());
        let mut names = people.clone();
        names.extend(chosen.iter().filter(|name| !people.contains(name)).cloned());
        if names.is_empty() {
            return view! { <p class="hint">"網站的夥伴名單還沒有人，請先在「夥伴」新增。"</p> }
                .into_any();
        }
        names
            .into_iter()
            .enumerate()
            .map(|(k, name)| {
                let id = format!("{prefix}-who-{k}");
                let checked = chosen.contains(&name);
                let text = if people.contains(&name) {
                    name.clone()
                } else {
                    format!("{name}（已不在名單）")
                };
                let source = id.clone();
                let label_for = id.clone();
                view! {
                    <label class="companion-chip" for=label_for>
                        <input
                            type="checkbox"
                            id=id
                            prop:checked=checked
                            on:change=move |event| {
                                let on = event_target_checked(&event);
                                let name = name.clone();
                                let people = editor.people.get_untracked();
                                save(
                                    &source,
                                    Box::new(move |draft| {
                                        let mut current: BTreeSet<String> = draft.items.iter().cloned().collect();
                                        if on {
                                            current.insert(name);
                                        } else {
                                            current.remove(&name);
                                        }
                                        let mut next: Vec<String> = people
                                            .iter()
                                            .filter(|person| current.contains(*person))
                                            .cloned()
                                            .collect();
                                        next.extend(
                                            draft
                                                .items
                                                .iter()
                                                .filter(|item| !people.contains(item) && current.contains(*item))
                                                .cloned(),
                                        );
                                        next.truncate(lm_core::limits::STOP_ITEMS_MAX);
                                        draft.items = next;
                                    }),
                                );
                            }
                        />
                        <span>{text}</span>
                    </label>
                }
            })
            .collect_view()
            .into_any()
    };
    view! {
        <div class="stop-text">
            <div class="field">
                <span class="field-label">"旅伴名單（可多選，選填）"</span>
                <div
                    id=items_id.to_owned()
                    class="companion-picker"
                    role="group"
                    aria-label="旅伴名單（可多選）"
                >
                    {chips}
                </div>
            </div>
        </div>
    }
}

// ── 路線 ──

/// `li.entry`：一條路線（Bun `renderRoutes()`）。
#[component]
fn RouteEntry(i: usize, id: RouteId, today: Today) -> impl IntoView {
    let editor = use_editor();
    let route = Memo::new(move |_| {
        today.with(|day| {
            day.as_ref()
                .and_then(|day| day.routes.iter().find(|route| route.id == id))
                .cloned()
        })
    });
    let stops = Memo::new(move |_| {
        route.with(|route| {
            route
                .as_ref()
                .map(|route| {
                    route
                        .stops
                        .iter()
                        .enumerate()
                        .map(|(j, stop)| (j, stop.id))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        })
    });
    let vehicle = move || {
        editor.plan.with(|plan| {
            plan.as_ref()
                .zip(route.with(|route| route.as_ref().map(|route| route.vehicle)))
                .map(|(plan, vehicle)| vehicle_name(plan, vehicle))
                .unwrap_or_default()
        })
    };
    let p = format!("route-{i}");
    let vehicle_id = format!("{p}-vehicle");
    let departure_id = format!("{p}-departure");
    let from_id = format!("{p}-from");
    let to_id = format!("{p}-to");
    let key = move || format!("{}-{i}", editor.studio.day.get_untracked());

    let on_toggle = move |event: ev::Event| {
        let details = event_target::<web_sys::HtmlDetailsElement>(&event);
        if !details.is_connected() {
            return;
        }
        if details.open() {
            editor.selected_route.set(Some(i));
        } else if editor.selected_route.get_untracked() == Some(i) {
            editor.selected_route.set(None);
        }
    };

    let vehicle_select = {
        let source = vehicle_id.clone();
        let (invalid, described) = invalid_attrs(editor, &vehicle_id);
        let options = move || {
            let current = route.with(|route| route.as_ref().map(|route| route.vehicle));
            let taken: Vec<VehicleId> = today.with(|day| {
                day.as_ref()
                    .map(|day| day.routes.iter().map(|route| route.vehicle).collect())
                    .unwrap_or_default()
            });
            editor.plan.with(|plan| {
                plan.as_ref().map(|plan| {
                    plan.vehicles
                        .iter()
                        .map(|vehicle| {
                            let value = vehicle.id.to_string();
                            let selected = current == Some(vehicle.id);
                            let disabled = !selected && taken.contains(&vehicle.id);
                            view! {
                                <option
                                    value=value.clone()
                                    data-vehicle-id=value
                                    disabled=disabled
                                    prop:selected=selected
                                >
                                    {vehicle.name.clone()}
                                </option>
                            }
                        })
                        .collect_view()
                })
            })
        };
        view! {
            <select
                id=vehicle_id.clone()
                aria-invalid=invalid
                aria-describedby=described
                on:change=move |event| {
                    let Ok(vehicle) = Uuid::parse_str(&event_target_value(&event)) else {
                        return;
                    };
                    editor.save_route(id, Some(&source), |draft| {
                        draft.vehicle = Some(VehicleId(vehicle));
                    });
                }
            >
                {options}
            </select>
        }
    };
    let departure = {
        let source = departure_id.clone();
        let input_source = departure_id.clone();
        let (invalid, described) = invalid_attrs(editor, &departure_id);
        view! {
            <input
                id=departure_id.clone()
                type="time"
                step="900"
                prop:value=move || route.with(|route| time_text(route.as_ref().and_then(|r| r.departure)))
                aria-invalid=invalid
                aria-describedby=described
                on:input=move |_| editor.set_typing(&input_source, true)
                on:change=move |event| {
                    editor.set_typing(&source, false);
                    let depart = time_input(&event_target_value(&event));
                    editor.save_route(id, Some(&source), |draft| draft.depart = depart);
                }
            />
        }
    };
    let endpoint = |field_id: &str, to: bool| {
        let source = field_id.to_owned();
        let (invalid, described) = invalid_attrs(editor, field_id);
        view! {
            <select
                id=field_id.to_owned()
                aria-invalid=invalid
                aria-describedby=described
                on:change=move |event| {
                    let place = parse_place(&event_target_value(&event));
                    editor.save_route(id, Some(&source), |draft| {
                        if to {
                            draft.to = place;
                        } else {
                            draft.from = place;
                        }
                    });
                }
            >
                {move || {
                    place_options(
                        editor,
                        route.with(|route| route.as_ref().map(|r| if to { r.to } else { r.from })),
                    )
                }}
            </select>
        }
    };
    let from = endpoint(&from_id, false);
    let to = endpoint(&to_id, true);

    let places = Memo::new(move |_| {
        editor
            .plan
            .with(|plan| plan.as_ref().map_or(0, |plan| plan.places.len()))
    });
    // Bun addStop()
    let add_stop = move |_: ev::MouseEvent| {
        editor.open_stops.update(|open| {
            open.remove(&format!("closed-{}", key()));
        });
        let candidate = editor.plan.with_untracked(|plan| {
            let plan = plan.as_ref()?;
            let (from, to) =
                route.with_untracked(|route| route.as_ref().map(|r| (r.from, r.to)))?;
            plan.places
                .iter()
                .find(|item| item.place != from && item.place != to)
                .or_else(|| plan.places.first())
                .map(|item| item.place)
        });
        let Some(place) = candidate else {
            editor.notice("需要至少一個地點才能新增停靠點。", Tone::Error);
            return;
        };
        let mut index = 0;
        let added = editor.save_route(id, None, |draft| {
            draft.stops.push(StopDraft {
                id: new_id(),
                place: Some(place),
                kind: Input::Ok(StopKind::Other),
                task: None,
                note: String::new(),
                time: None,
                items: Vec::new(),
            });
            index = draft.stops.len() - 1;
        });
        if added {
            editor.focus_later(format!("stop-{i}-{index}-kind"), false);
        }
    };
    let remove_route = move |_: ev::MouseEvent| {
        if editor.commit(None, vec![Command::RemoveRoute { id }]) {
            editor.open_stops.set(BTreeSet::new());
        }
    };
    let stops_open = move || {
        let closed = format!("closed-{}", key());
        editor.open_stops.with(|open| !open.contains(&closed))
    };
    let stops_toggle = move |event: ev::Event| {
        let details = event_target::<web_sys::HtmlDetailsElement>(&event);
        if !details.is_connected() {
            return;
        }
        let closed = format!("closed-{}", key());
        let is_open = details.open();
        if is_open
            == editor
                .open_stops
                .with_untracked(|open| !open.contains(&closed))
        {
            return;
        }
        editor.open_stops.update(|open| {
            if is_open {
                open.remove(&closed);
            } else {
                open.insert(closed);
            }
        });
    };

    view! {
        <li class="entry">
            <details
                id=format!("route-entry-{i}")
                class="entry-details"
                prop:open=move || editor.selected_route.get() == Some(i)
                on:toggle=on_toggle
            >
                <summary
                    class="entry-summary"
                    on:click=move |event: ev::MouseEvent| {
                        if !editor.flush_draft() {
                            event.prevent_default();
                        }
                    }
                >
                    <span id=format!("{p}-summary-time") class="entry-time">
                        {move || {
                            route
                                .with(|route| route.as_ref().and_then(|r| r.departure))
                                .map_or_else(|| "時間未填".to_owned(), |t| t.to_string())
                        }}
                    </span>
                    <span class="entry-title">
                        <strong id=format!("{p}-summary-title")>{vehicle}</strong>
                        <span id=format!("{p}-summary-meta") class="entry-meta">
                            {move || {
                                editor.plan.with(|plan| {
                                    plan.as_ref()
                                        .zip(route.get())
                                        .map(|(plan, route)| route_overview(plan, &route))
                                })
                            }}
                        </span>
                    </span>
                </summary>
                <div class="entry-body">
                    <div class="grid4">
                        <div>
                            <label for=vehicle_id.clone()>"哪一台車"</label>
                            {vehicle_select}
                            {editor.error_view(vehicle_id.clone())}
                        </div>
                        <div>
                            <label for=departure_id.clone()>"幾點出發（可留空）"</label>
                            {departure}
                            {editor.error_view(departure_id.clone())}
                        </div>
                        <div>
                            <label for=from_id.clone()>"從哪裡出發"</label>
                            {from}
                            {editor.error_view(from_id.clone())}
                        </div>
                        <div>
                            <label for=to_id.clone()>"最後到哪裡"</label>
                            {to}
                            {editor.error_view(to_id.clone())}
                        </div>
                    </div>
                    <div id=format!("{p}-stops") class="stops-compact">
                        <Show when=move || !stops.with(Vec::is_empty)>
                            <details class="stops" prop:open=stops_open on:toggle=stops_toggle>
                                <summary>{move || format!("途中任務（{}）", stops.with(Vec::len))}</summary>
                                <ol class="list">
                                    <For
                                        each=move || stops.get()
                                        key=|stop| *stop
                                        children=move |(j, stop)| {
                                            view! { <StopEntry i j route=id id=stop today /> }
                                        }
                                    />
                                </ol>
                            </details>
                        </Show>
                        <div class="route-actions">
                            <button
                                type="button"
                                id=format!("addStop-{i}")
                                disabled=move || {
                                    stops.with(Vec::len) >= *ROUTE_STOPS.end() || places.get() == 0
                                }
                                on:click=add_stop
                            >
                                "新增途中任務"
                            </button>
                            <button
                                type="button"
                                id=format!("removeRoute-{i}")
                                class="danger icon trash"
                                title="刪除這條路線"
                                aria-label=move || format!("刪除 {} 的路線", vehicle())
                                on:click=remove_route
                                inner_html=TRASH_SVG
                            ></button>
                        </div>
                    </div>
                </div>
            </details>
        </li>
    }
}

// ── 活動 ──

/// `li.entry`：一個活動或料理（Bun `renderEvents()`）。
#[component]
fn EventEntry(i: usize, source: EventSource, today: Today) -> impl IntoView {
    let editor = use_editor();
    let event = Memo::new(move |_| {
        today.with(|day| {
            day.as_ref()
                .and_then(|day| day.events.iter().find(|event| event.source == source))
                .cloned()
        })
    });
    let meal = matches!(source, EventSource::Meal(_));
    let read =
        move |f: fn(&StudioEvent) -> String| event.with(|e| e.as_ref().map(f).unwrap_or_default());
    let p = format!("event-{i}");
    let title_id = format!("{p}-title");
    let time_id = format!("{p}-time");
    let kind_id = format!("{p}-kind");
    let notes_id = format!("{p}-notes");

    // 料理的標題不含「{餐次}：」
    let meal_title = move |text: String| {
        let slot = editor
            .state(|state| match source {
                EventSource::Meal(id) => state
                    .meals
                    .get(&id)
                    .map(|meal| meal.slot.as_str().to_owned()),
                EventSource::Activity(_) => None,
            })
            .flatten()
            .unwrap_or_default();
        let text = text.trim().to_owned();
        if text == slot {
            String::new()
        } else {
            text.strip_prefix(&format!("{slot}："))
                .map(str::to_owned)
                .unwrap_or(text)
        }
    };
    let update = move |field: &str, activity: ActivityPatch, meal_patch: MealPatch| -> bool {
        let command = match source {
            EventSource::Activity(id) => Command::UpdateActivity {
                id,
                patch: activity,
            },
            EventSource::Meal(id) => Command::UpdateMeal {
                id,
                patch: meal_patch,
            },
        };
        editor.commit(Some(field), vec![command])
    };
    // 改了時間之後順序可能改變：展開的活動跟著它
    let follow = move || {
        request_animation_frame(move || {
            let index = today.with_untracked(|day| {
                day.as_ref()
                    .and_then(|day| day.events.iter().position(|event| event.source == source))
            });
            if index.is_some() {
                editor.selected_event.set(index);
            }
        });
    };

    let on_toggle = move |event: ev::Event| {
        let details = event_target::<web_sys::HtmlDetailsElement>(&event);
        if !details.is_connected() {
            return;
        }
        if details.open() {
            editor.selected_event.set(Some(i));
        } else if editor.selected_event.get_untracked() == Some(i) {
            editor.selected_event.set(None);
        }
    };

    let title_field = {
        let source_id = title_id.clone();
        let input_source = title_id.clone();
        let (invalid, described) = invalid_attrs(editor, &title_id);
        view! {
            <input
                id=title_id.clone()
                maxlength=ACTIVITY_TITLE_CHARS.end().to_string()
                autocomplete="off"
                prop:value=move || read(|e| e.title.clone())
                aria-invalid=invalid
                aria-describedby=described
                on:input=move |_| editor.set_typing(&input_source, true)
                on:change=move |ev| {
                    editor.set_typing(&source_id, false);
                    let text = event_target_value(&ev);
                    update(
                        &source_id,
                        ActivityPatch { title: Some(text.clone()), ..ActivityPatch::default() },
                        MealPatch { title: Some(meal_title(text)), ..MealPatch::default() },
                    );
                }
            />
        }
    };
    let time_field = {
        let source_id = time_id.clone();
        let input_source = time_id.clone();
        let (invalid, described) = invalid_attrs(editor, &time_id);
        view! {
            <input
                id=time_id.clone()
                type="time"
                step="900"
                prop:value=move || event.with(|e| e.as_ref().map(|e| e.time.to_string()).unwrap_or_default())
                aria-invalid=invalid
                aria-describedby=described
                on:input=move |_| editor.set_typing(&input_source, true)
                on:change=move |ev| {
                    editor.set_typing(&source_id, false);
                    let time = time_input(&event_target_value(&ev));
                    if update(
                        &source_id,
                        ActivityPatch { time: Some(time.clone()), ..ActivityPatch::default() },
                        MealPatch { time: Some(time), ..MealPatch::default() },
                    ) {
                        follow();
                    }
                }
            />
        }
    };
    let kind_select = {
        let source_id = kind_id.clone();
        let (invalid, described) = invalid_attrs(editor, &kind_id);
        let options = move || {
            let current = event.with(|e| e.as_ref().map_or(StudioKind::Meet, |e| e.kind));
            let allowed: &[StudioKind] = if meal {
                &StudioKind::MEAL_KINDS
            } else {
                &StudioKind::ACTIVITY_KINDS
            };
            let mut kinds: Vec<StudioKind> = Vec::with_capacity(allowed.len() + 1);
            if !allowed.contains(&current) {
                kinds.push(current);
            }
            kinds.extend_from_slice(allowed);
            kinds
                .into_iter()
                .map(|kind| {
                    view! {
                        <option value=kind.as_str() prop:selected=kind == current>
                            {kind.label()}
                        </option>
                    }
                })
                .collect_view()
        };
        view! {
            <select
                id=kind_id.clone()
                disabled=meal
                title=if meal { "餐點插圖由網站的菜單決定" } else { "" }
                aria-invalid=invalid
                aria-describedby=described
                on:change=move |ev| {
                    let Some(kind) = StudioKind::parse(&event_target_value(&ev)) else {
                        return;
                    };
                    update(
                        &source_id,
                        ActivityPatch { kind: Some(Input::Ok(kind.to_activity())), ..ActivityPatch::default() },
                        MealPatch::default(),
                    );
                }
            >
                {options}
            </select>
        }
    };
    let notes_node = NodeRef::<html::Textarea>::new();
    auto_grow(notes_node, move || read(|e| e.notes.clone()));
    let notes_field = {
        let source_id = notes_id.clone();
        let input_source = notes_id.clone();
        let (invalid, described) = invalid_attrs(editor, &notes_id);
        view! {
            <textarea
                id=notes_id.clone()
                rows="1"
                class="grow"
                maxlength=ACTIVITY_NOTE_CHARS.end().to_string()
                placeholder="餐點、要帶的東西，或想提醒旅伴的事"
                node_ref=notes_node
                prop:value=move || read(|e| e.notes.clone())
                aria-invalid=invalid
                aria-describedby=described
                on:input=move |ev| {
                    editor.set_typing(&input_source, true);
                    grow(&event_target::<web_sys::HtmlElement>(&ev));
                }
                on:change=move |ev| {
                    editor.set_typing(&source_id, false);
                    let text = event_target_value(&ev);
                    update(
                        &source_id,
                        ActivityPatch { note: Some(text.clone()), ..ActivityPatch::default() },
                        MealPatch { notes: Some(text), ..MealPatch::default() },
                    );
                }
            ></textarea>
        }
    };

    let activities = Memo::new(move |_| {
        editor
            .handle
            .with_view(|state| state.activities.len())
            .unwrap_or(0)
    });
    // Bun 複製活動：複製出來的新活動不連結到菜單（料理的複製是類別「用餐」的活動）
    let copy = move |_: ev::MouseEvent| {
        let Some(day) = editor.day_date() else {
            return;
        };
        let Some(studio_event) = event.get_untracked() else {
            return;
        };
        let new: ActivityId = new_id();
        let draft = match source {
            EventSource::Activity(id) => editor
                .state(|state| state.activities.get(&id).map(activity_draft))
                .flatten()
                .map(|draft| ActivityDraft { id: new, ..draft }),
            EventSource::Meal(_) => Some(ActivityDraft {
                id: new,
                time: Some(Input::Ok(studio_event.time)),
                title: studio_event.title.clone(),
                kind: Input::Ok(ActivityKind::Meal),
                location: String::new(),
                note: studio_event.notes.clone(),
                who: Participation::Everyone,
            }),
        };
        let Some(draft) = draft else {
            return;
        };
        if editor.commit(
            None,
            vec![Command::AddActivities {
                day,
                items: vec![draft],
            }],
        ) {
            request_animation_frame(move || {
                let index = today.with_untracked(|day| {
                    day.as_ref().and_then(|day| {
                        day.events
                            .iter()
                            .position(|event| event.source == EventSource::Activity(new))
                    })
                });
                editor.selected_event.set(index);
            });
        }
    };
    let can_remove = move || !meal || editor.can_manage.get();
    let remove = move |_: ev::MouseEvent| {
        let command = match source {
            EventSource::Activity(id) => Command::RemoveActivity { id },
            EventSource::Meal(id) => Command::RemoveMeal { id },
        };
        editor.commit(None, vec![command]);
    };

    view! {
        <li class="entry">
            <details
                id=format!("event-entry-{i}")
                class="entry-details"
                prop:open=move || editor.selected_event.get() == Some(i)
                on:toggle=on_toggle
            >
                <summary
                    class="entry-summary"
                    on:click=move |ev: ev::MouseEvent| {
                        if !editor.flush_draft() {
                            ev.prevent_default();
                        }
                    }
                >
                    <span id=format!("{p}-summary-time") class="entry-time">
                        {move || event.with(|e| e.as_ref().map(|e| e.time.to_string()).unwrap_or_default())}
                    </span>
                    <span class="entry-title">
                        <strong id=format!("{p}-summary-title")>
                            {move || event.with(|e| e.as_ref().map(event_title).unwrap_or_default())}
                        </strong>
                        {meal.then(|| view! { <span class="meal-badge">"餐點"</span> })}
                        <span id=format!("{p}-summary-meta") class="entry-meta">
                            {move || event.with(|e| e.as_ref().map(|e| e.kind.label()).unwrap_or_default())}
                        </span>
                    </span>
                </summary>
                <div class="entry-body">
                    <div class="grid3">
                        <div>
                            <label for=title_id.clone()>"想做什麼？"</label>
                            {title_field}
                            {editor.error_view(title_id.clone())}
                        </div>
                        <div>
                            <label for=time_id.clone()>"幾點開始"</label>
                            {time_field}
                            {editor.error_view(time_id.clone())}
                        </div>
                        <div>
                            <label for=kind_id.clone()>"搭配的插圖"</label>
                            {kind_select}
                            {editor.error_view(kind_id.clone())}
                        </div>
                    </div>
                    <div>
                        <label for=notes_id.clone()>"活動備註（選填）"</label>
                        {notes_field}
                        {editor.error_view(notes_id.clone())}
                    </div>
                    {meal
                        .then(|| {
                            view! {
                                <p class="locked-note">
                                    "這個活動來自網站的菜單安排：插圖由菜單決定（儲存時以菜單為準），時間與備註可以改。複製出來的新活動不會連結到菜單。"
                                </p>
                            }
                        })}
                    <div class="route-actions">
                        <button
                            type="button"
                            id=format!("copyEvent-{i}")
                            disabled=move || { activities.get() >= ACTIVITIES_MAX }
                            on:click=copy
                        >
                            "複製活動"
                        </button>
                        <button
                            type="button"
                            id=format!("removeEvent-{i}")
                            class="danger icon trash"
                            aria-label=move || {
                                format!("刪除活動 {}", event.with(|e| e.as_ref().map(event_title).unwrap_or_default()))
                            }
                            disabled=move || !can_remove()
                            title=move || {
                                if can_remove() { "刪除這個活動" } else { "菜單餐點需要刪除權限" }
                            }
                            on:click=remove
                            inner_html=TRASH_SVG
                        ></button>
                    </div>
                </div>
            </details>
        </li>
    }
}

// ── 分頁 ──

/// 旅行日期平移 `from` 到 `to` 的天數（Decision D6）。
fn shifted(start: Date, end: Date, from: Date, to: Date) -> Option<DateSpan> {
    let offset = to - from;
    Some(DateSpan {
        start: start.checked_add(offset)?,
        end: end.checked_add(offset)?,
    })
}

/// `#panel-plan` 的內容。
#[component]
pub(super) fn PlanPanel() -> impl IntoView {
    let editor = use_editor();
    let studio = editor.studio;
    let plan = editor.plan;
    let today: Today = Memo::new(move |_| {
        plan.with(|plan| {
            plan.as_ref()
                .and_then(|plan| plan.days.get(studio.day.get()).cloned())
        })
    });
    let dates = Memo::new(move |_| {
        plan.with(|plan| {
            plan.as_ref()
                .map(|plan| plan.days.iter().map(|day| day.date).collect::<Vec<_>>())
                .unwrap_or_default()
        })
    });
    let routes = Memo::new(move |_| {
        today.with(|day| {
            day.as_ref()
                .map(|day| {
                    day.routes
                        .iter()
                        .enumerate()
                        .map(|(i, route)| (i, route.id))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        })
    });
    let events = Memo::new(move |_| {
        today.with(|day| {
            day.as_ref()
                .map(|day| {
                    day.events
                        .iter()
                        .enumerate()
                        .map(|(i, event)| (i, event.source))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        })
    });
    let vehicles =
        Memo::new(move |_| plan.with(|plan| plan.as_ref().map_or(0, |plan| plan.vehicles.len())));
    let activities = Memo::new(move |_| {
        editor
            .handle
            .with_view(|state| state.activities.len())
            .unwrap_or(0)
    });
    let read = move |f: fn(&StudioDay) -> String| {
        today.with(|day| day.as_ref().map(f).unwrap_or_default())
    };

    let save_setting = move |source: &str, patch: DaySettingPatch| {
        if let Some(day) = editor.day_date() {
            editor.commit(Some(source), vec![Command::SaveDaySetting { day, patch }]);
        }
    };
    let optional = |text: String| {
        let text = text.trim().to_owned();
        (!text.is_empty()).then_some(text)
    };

    let day_tabs = move || {
        dates
            .get()
            .into_iter()
            .enumerate()
            .map(|(i, date)| {
                view! {
                    <button
                        type="button"
                        id=format!("day-tab-{i}")
                        class="day-button"
                        aria-label=format!("編輯{}", day_label(date, i))
                        aria-pressed=move || (studio.day.get() == i).to_string()
                        on:click=move |_| {
                            editor.select_day(i);
                        }
                    >
                        <span>{format!("第 {} 天", i + 1)}</span>
                        <span class="entry-meta">{date_text(date)}</span>
                    </button>
                }
            })
            .collect_view()
    };
    let context = move || {
        today.with(|day| {
            day.as_ref().map(|day| {
                format!(
                    "{} · {} 條路線 / {} 個活動",
                    if day.title.is_empty() {
                        "未命名的一天"
                    } else {
                        &day.title
                    },
                    day.routes.len(),
                    day.events.len()
                )
            })
        })
    };
    let day_options = move || {
        dates
            .get()
            .into_iter()
            .enumerate()
            .map(|(i, date)| {
                view! {
                    <option value=i.to_string() prop:selected=move || studio.day.get() == i>
                        {day_label(date, i)}
                    </option>
                }
            })
            .collect_view()
    };
    let on_day_select = move |event: ev::Event| {
        let select = event_target::<web_sys::HtmlSelectElement>(&event);
        let Ok(index) = select.value().parse::<usize>() else {
            return;
        };
        if !editor.select_day(index) {
            select.set_value(&studio.day.get_untracked().to_string());
        }
    };

    let (title_invalid, title_described) = invalid_attrs(editor, "dayTitle");
    let (date_invalid, date_described) = invalid_attrs(editor, "dayDate");
    let (location_invalid, location_described) = invalid_attrs(editor, "dayLocation");
    let (position_invalid, position_described) = invalid_attrs(editor, "dayRoutePosition");
    let (arrival_invalid, arrival_described) = invalid_attrs(editor, "dayArrival");

    let on_date = move |event: ev::Event| {
        let Some(to) = parse_date(&event_target_value(&event)) else {
            return;
        };
        let Some(from) = editor.day_date() else {
            return;
        };
        let Some(dates) = editor
            .state(|state| shifted(state.card.start, state.card.end, from, to))
            .flatten()
        else {
            return;
        };
        editor.commit(
            Some("dayDate"),
            vec![Command::UpdateTrip {
                patch: TripPatch {
                    dates: Some(dates),
                    ..TripPatch::default()
                },
            }],
        );
    };
    // Bun addDay()
    let add_day = move |_: ev::MouseEvent| {
        if !editor.flush_draft() {
            return;
        }
        let Some((start, end)) = editor.state(|state| (state.card.start, state.card.end)) else {
            return;
        };
        let Some(next) = end.next_day() else {
            return;
        };
        let added = editor.commit(
            None,
            vec![Command::UpdateTrip {
                patch: TripPatch {
                    dates: Some(DateSpan { start, end: next }),
                    ..TripPatch::default()
                },
            }],
        );
        if added {
            let last = lm_core::time::date_range(start, next)
                .len()
                .saturating_sub(1);
            editor.reset_day_state();
            studio.day.set(last);
            studio.show_tab(EditorTab::Plan);
            studio.section.set(PlanSection::Events);
            editor.notice(format!("已新增{}。", day_label(next, last)), Tone::Ok);
        }
    };
    // Bun removeDay()
    let remove_day = move |_: ev::MouseEvent| {
        if !editor.flush_draft() {
            return;
        }
        let Some((len, last)) = plan.with_untracked(|plan| {
            plan.as_ref()
                .and_then(|plan| plan.days.last().cloned().map(|day| (plan.days.len(), day)))
        }) else {
            return;
        };
        if len <= 1 {
            editor.notice("至少需要保留一天。", Tone::Error);
            return;
        }
        let i = len - 1;
        let label = day_label(last.date, i);
        let meals = last.events.iter().filter(|event| event.is_meal()).count();
        if meals > 0 && !editor.can_manage.get_untracked() {
            editor.notice(
                format!("無法移除{label}：這天有 {meals} 個菜單餐點，你沒有刪除權限。"),
                Tone::Error,
            );
            return;
        }
        if !last.events.is_empty() || !last.routes.is_empty() {
            let question = format!(
                "移除{label}會刪除這天的 {} 個活動與 {} 條路線。確定？",
                last.events.len(),
                last.routes.len()
            );
            let confirmed = web_sys::window()
                .and_then(|window| window.confirm_with_message(&question).ok())
                .unwrap_or(false);
            if !confirmed {
                return;
            }
        }
        let Some((start, end)) = editor.state(|state| (state.card.start, state.card.end)) else {
            return;
        };
        let Some(previous) = end.previous_day() else {
            return;
        };
        editor.open_stops.set(BTreeSet::new());
        if editor.commit(
            None,
            vec![Command::UpdateTrip {
                patch: TripPatch {
                    dates: Some(DateSpan {
                        start,
                        end: previous,
                    }),
                    ..TripPatch::default()
                },
            }],
        ) {
            editor.notice("已移除最後一天。", Tone::Ok);
        }
    };
    // Bun addRoute()
    let add_route = move |_: ev::MouseEvent| {
        let Some(day) = editor.day_date() else {
            return;
        };
        let draft = plan.with_untracked(|plan| {
            let plan = plan.as_ref()?;
            let today = today.get_untracked()?;
            let Some(vehicle) = plan
                .vehicles
                .iter()
                .find(|vehicle| !today.routes.iter().any(|route| route.vehicle == vehicle.id))
            else {
                return Some(Err(if plan.vehicles.is_empty() {
                    "還沒有車輛，請先在「地點與車」新增一台車。"
                } else {
                    "每台車每天只能有一條路線；請先新增車輛。"
                }));
            };
            let Some(to) = today
                .location
                .or_else(|| plan.places.first().map(|item| item.place))
            else {
                return Some(Err("需要至少一個地點才能建立路線。"));
            };
            let from = plan
                .places
                .iter()
                .find(|item| item.place != to)
                .map_or(to, |item| item.place);
            Some(Ok(RouteDraft {
                id: new_id(),
                day,
                vehicle: Some(vehicle.id),
                from: Some(from),
                to: Some(to),
                depart: None,
                stops: Vec::new(),
            }))
        });
        let draft = match draft {
            Some(Ok(draft)) => draft,
            Some(Err(message)) => {
                editor.notice(message, Tone::Error);
                return;
            }
            None => return,
        };
        let route = draft.id;
        if editor.commit(None, vec![Command::SaveRoute { route: draft }]) {
            request_animation_frame(move || {
                let index = today.with_untracked(|day| {
                    day.as_ref()
                        .and_then(|day| day.routes.iter().position(|r| r.id == route))
                });
                if let Some(index) = index {
                    editor.selected_route.set(Some(index));
                    editor.focus_later(format!("route-{index}-departure"), false);
                }
            });
        }
    };
    // Bun addEvent()
    let add_event = move |_: ev::MouseEvent| {
        let Some(day) = editor.day_date() else {
            return;
        };
        let time = today
            .with_untracked(|day| {
                day.as_ref()
                    .and_then(|day| day.events.last())
                    .map(|event| Hm::from_minutes((event.time.minutes() + 60).min(23 * 60 + 59)))
            })
            .flatten()
            .or_else(|| Hm::new(9, 0));
        let id: ActivityId = new_id();
        let added = editor.commit(
            None,
            vec![Command::AddActivities {
                day,
                items: vec![ActivityDraft {
                    id,
                    time: time.map(Input::Ok),
                    title: "新活動".to_owned(),
                    kind: Input::Ok(StudioKind::ACTIVITY_KINDS[0].to_activity()),
                    location: String::new(),
                    note: String::new(),
                    who: Participation::Everyone,
                }],
            }],
        );
        if added {
            studio.section.set(PlanSection::Events);
            request_animation_frame(move || {
                let index = today.with_untracked(|day| {
                    day.as_ref().and_then(|day| {
                        day.events
                            .iter()
                            .position(|event| event.source == EventSource::Activity(id))
                    })
                });
                if let Some(index) = index {
                    editor.selected_event.set(Some(index));
                    editor.focus_later(format!("event-{index}-title"), true);
                }
            });
        }
    };

    view! {
        <div class="day-picker">
            <h2 id="dayTabsLabel">"編輯哪一天"</h2>
            <div class="day-tabs" id="dayTabs" role="group" aria-labelledby="dayTabsLabel">
                {day_tabs}
            </div>
            <p class="context-note" id="dayContext" aria-live="polite">
                {context}
            </p>
        </div>

        <details class="disclosure" id="daySettings">
            <summary>
                "這一天的設定 " <span class="hint">"標題、日期、地點、增減天數"</span>
            </summary>
            <div class="disclosure-body">
                <label for="daySelect">"切換日子"</label>
                <select id="daySelect" on:change=on_day_select>
                    {day_options}
                </select>
                <div class="grid4">
                    <div>
                        <label for="dayTitle">
                            "當日標題 " <span class="hint">"· 海報每日區塊的大字"</span>
                        </label>
                        <input
                            id="dayTitle"
                            autocomplete="off"
                            maxlength=DAY_TITLE_CHARS.end().to_string()
                            prop:value=move || read(|day| day.title.clone())
                            aria-invalid=title_invalid
                            aria-describedby=title_described
                            on:input=move |_| editor.set_typing("dayTitle", true)
                            on:change=move |event| {
                                editor.set_typing("dayTitle", false);
                                let title = optional(event_target_value(&event));
                                save_setting(
                                    "dayTitle",
                                    DaySettingPatch { title: Some(title), ..DaySettingPatch::default() },
                                );
                            }
                        />
                        {editor.error_view("dayTitle".to_owned())}
                    </div>
                    <div>
                        <label for="dayDate">"日期"</label>
                        <input
                            id="dayDate"
                            type="date"
                            prop:value=move || today.with(|day| day.as_ref().map(|day| day.date.to_string()).unwrap_or_default())
                            aria-invalid=date_invalid
                            aria-describedby=date_described
                            on:change=on_date
                        />
                        {editor.error_view("dayDate".to_owned())}
                    </div>
                    <div>
                        <label for="dayLocation">"所在地點"</label>
                        <select
                            id="dayLocation"
                            aria-invalid=location_invalid
                            aria-describedby=location_described
                            on:change=move |event| {
                                // 旅行目的地與「未指定」都是不指定地點（跟著旅行目的地）
                                let place = match parse_place(&event_target_value(&event)) {
                                    Some(PlaceRef::Place(id)) => Some(id),
                                    _ => None,
                                };
                                save_setting(
                                    "dayLocation",
                                    DaySettingPatch { place: Some(place), ..DaySettingPatch::default() },
                                );
                            }
                        >
                            {move || {
                                let chosen = today.with(|day| day.as_ref().and_then(|day| day.location));
                                view! {
                                    <option value="" prop:selected=chosen.is_none()>
                                        "未指定"
                                    </option>
                                    {place_options(editor, chosen)}
                                }
                            }}
                        </select>
                        {editor.error_view("dayLocation".to_owned())}
                    </div>
                    <div>
                        <label for="dayRoutePosition">"路線位置"</label>
                        <select
                            id="dayRoutePosition"
                            aria-invalid=position_invalid
                            aria-describedby=position_described
                            on:change=move |event| {
                                let Some(position) = RoutePosition::parse(&event_target_value(&event)) else {
                                    return;
                                };
                                save_setting(
                                    "dayRoutePosition",
                                    DaySettingPatch {
                                        route_position: Some(Input::Ok(position)),
                                        ..DaySettingPatch::default()
                                    },
                                );
                            }
                        >
                            <option
                                value="before"
                                prop:selected=move || today.with(|day| day.as_ref().is_none_or(|day| day.route_position == RoutePosition::Before))
                            >
                                "行程之前（出發）"
                            </option>
                            <option
                                value="after"
                                prop:selected=move || today.with(|day| day.as_ref().is_some_and(|day| day.route_position == RoutePosition::After))
                            >
                                "行程之後（返程）"
                            </option>
                        </select>
                        {editor.error_view("dayRoutePosition".to_owned())}
                    </div>
                </div>
                <label for="dayArrival">
                    "抵達說明 " <span class="hint">"· 寫在抵達地點旁"</span>
                </label>
                <input
                    id="dayArrival"
                    autocomplete="off"
                    maxlength=ARRIVAL_LABEL_CHARS.end().to_string()
                    prop:value=move || read(|day| day.arrival_label.clone())
                    aria-invalid=arrival_invalid
                    aria-describedby=arrival_described
                    on:input=move |_| editor.set_typing("dayArrival", true)
                    on:change=move |event| {
                        editor.set_typing("dayArrival", false);
                        let label = optional(event_target_value(&event));
                        save_setting(
                            "dayArrival",
                            DaySettingPatch { arrival_label: Some(label), ..DaySettingPatch::default() },
                        );
                    }
                />
                {editor.error_view("dayArrival".to_owned())}
                <div class="route-actions">
                    <button
                        type="button"
                        id="addDay"
                        disabled=move || { dates.with(Vec::len) >= *TRIP_DAYS.end() }
                        on:click=add_day
                    >
                        "＋ 新增一天"
                    </button>
                    <button
                        type="button"
                        id="removeDay"
                        class="danger"
                        disabled=move || { dates.with(Vec::len) <= 1 }
                        on:click=remove_day
                    >
                        "移除最後一天"
                    </button>
                </div>
            </div>
        </details>

        <div class="subnav" role="group" aria-label="這一天要編輯的內容">
            <button
                type="button"
                id="section-routes"
                data-section="routes"
                aria-pressed=move || (studio.section.get() == PlanSection::Routes).to_string()
                aria-controls="routeSection"
                on:click=move |_| {
                    editor.show_section(PlanSection::Routes);
                }
            >
                "路線"
            </button>
            <button
                type="button"
                id="section-events"
                data-section="events"
                aria-pressed=move || (studio.section.get() == PlanSection::Events).to_string()
                aria-controls="eventSection"
                on:click=move |_| {
                    editor.show_section(PlanSection::Events);
                }
            >
                "活動"
            </button>
        </div>

        <section
            class="plan-section"
            id="routeSection"
            aria-labelledby="section-routes"
            hidden=move || studio.section.get() != PlanSection::Routes
        >
            <p class="hint" id="routeHelp">
                "每台車可安排途中停靠點，時間可稍後填。"
            </p>
            <ol id="routeList" class="list entries">
                <Show
                    when=move || !routes.with(Vec::is_empty)
                    fallback=move || {
                        view! {
                            <li class="empty">
                                {move || {
                                    if vehicles.get() > 0 {
                                        "這天不開車就不用填。需要移動時，新增一台車的路線。"
                                    } else {
                                        "還沒有車輛。先到「地點與車」新增車輛，才能安排路線。"
                                    }
                                }}
                            </li>
                        }
                    }
                >
                    <For
                        each=move || routes.get()
                        key=|route| *route
                        children=move |(i, id)| view! { <RouteEntry i id today /> }
                    />
                </Show>
            </ol>
            <button
                type="button"
                id="addRoute"
                class="add"
                disabled=move || {
                    let count = vehicles.get();
                    count == 0 || routes.with(Vec::len) >= count
                }
                on:click=add_route
            >
                "＋ 新增路線"
            </button>
        </section>

        <section
            class="plan-section"
            id="eventSection"
            aria-labelledby="section-events"
            hidden=move || studio.section.get() != PlanSection::Events
        >
            <p class="hint">"依時間排在海報的當日區塊。標示「餐點」的活動來自菜單安排。"</p>
            <ol id="eventList" class="list entries">
                <Show
                    when=move || !events.with(Vec::is_empty)
                    fallback=|| {
                        view! {
                            <li class="empty">
                                "這天留白也很好。按「新增活動」，安排第一件想做的事。"
                            </li>
                        }
                    }
                >
                    <For
                        each=move || events.get()
                        key=|event| *event
                        children=move |(i, source)| view! { <EventEntry i source today /> }
                    />
                </Show>
            </ol>
            <button
                type="button"
                id="addEvent"
                class="add"
                disabled=move || { activities.get() >= ACTIVITIES_MAX }
                on:click=add_event
            >
                "＋ 新增活動"
            </button>
        </section>

        <details class="disclosure" id="unassignedSection">
            <summary>
                "未分配採買清單 " <span class="hint">"採買清單中「待分配」的品項，這裡唯讀"</span>
            </summary>
            <div class="disclosure-body">
                <p class="hint">
                    "要修改採買項目，請到網站的採買頁；各車途中任務的清單可在路線中編輯。"
                </p>
                <label for="shopping">"目前清單"</label>
                <textarea
                    id="shopping"
                    rows="5"
                    readonly=true
                    prop:value=move || {
                        plan.with(|plan| plan.as_ref().map(|plan| plan.shopping.join("\n")).unwrap_or_default())
                    }
                ></textarea>
            </div>
        </details>
    }
}
