//! 選日與這一天的設定（需求 22.1、22.10、22.11、22.15、22.16，以及需求 14.2 的每日設定區塊）。
use leptos::prelude::*;
use lm_core::command::{Command, DaySettingPatch, Input};
use lm_core::ids::PlaceId;
use lm_core::itinerary::day_place;
use lm_core::model::{Date, DaySetting, Entity, PlaceRef, RoutePosition, RowKey};
use lm_core::text::trim_white;
use lm_core::time::{month_day, weekday_char};

use super::{parse_place, place_options, place_value, time_input, time_text, SelectedDay};
use crate::art;
use crate::pages::trip::{use_trip, TripContext};
use crate::views::editors::EditorAvatars;
use crate::views::forms::{
    changed, edit_command, FormError, FormFields, FormNotices, FormSession, FormTarget,
};
use crate::views::icons;

/// 每日設定的表單。
pub(super) const DAY_FORM: &str = "day";
/// 選日按鈕依位置輪流使用的顏色（現行 `COLORS[i % 3]`）。
const DAY_COLORS: [&str; 3] = ["coral", "blue", "green"];

/// 路線位置的選項（需求 22.10）。
const ROUTE_POSITIONS: [(RoutePosition, &str); 2] = [
    (RoutePosition::Before, "路線在活動之前"),
    (RoutePosition::After, "路線在活動之後"),
];

fn position_label(position: RoutePosition) -> &'static str {
    ROUTE_POSITIONS
        .iter()
        .find(|(value, _)| *value == position)
        .map_or("", |(_, label)| label)
}

/// 選日（需求 22.1）：「第 {N} 天」「{M}/{D}」「週{X}」。切換日子時關閉行程表中開啟的表單。
#[component]
pub(super) fn DayPicker(selected: SelectedDay) -> impl IntoView {
    let TripContext { ui, .. } = use_trip();
    let select = move |index: usize| {
        if ui.schedule_day.get_untracked() == index {
            return;
        }
        let schedule_form = ui.form.get_untracked().is_some_and(|open| {
            [
                DAY_FORM,
                super::routes::ROUTE_FORM,
                super::events::ACTIVITY_FORM,
            ]
            .contains(&open.kind)
        });
        if schedule_form {
            ui.close_any_form();
        }
        ui.schedule_day.set(index);
    };
    let entries = move || {
        selected
            .days
            .get()
            .into_iter()
            .enumerate()
            .collect::<Vec<_>>()
    };
    view! {
        <div class="schedule-bar">
            <div class="date-tabs" role="group" aria-label="選擇行程日期">
                <For
                    each=entries
                    key=|entry| *entry
                    children=move |(index, date)| {
                        let pressed = move || selected.index.get() == index;
                        view! {
                            <button
                                type="button"
                                class=move || {
                                    let color = DAY_COLORS[index % DAY_COLORS.len()];
                                    if pressed() { format!("selected {color}") } else { color.to_owned() }
                                }
                                aria-pressed=move || pressed().to_string()
                                on:click=move |_| select(index)
                            >
                                <small>{format!("第 {} 天", index + 1)}</small>
                                <b>{month_day(date)}</b>
                                <span>{format!("週{}", weekday_char(date))}</span>
                            </button>
                        }
                    }
                />
            </div>
        </div>
    }
}

/// 每日設定的草稿。地點是 `<select>` 的值（[`place_value`]）。
#[derive(Clone, Debug, PartialEq)]
struct DayDraft {
    title: String,
    place: String,
    arrival: String,
    position: RoutePosition,
}

impl DayDraft {
    fn of(setting: Option<&DaySetting>) -> DayDraft {
        DayDraft {
            title: setting
                .and_then(|setting| setting.title.clone())
                .unwrap_or_default(),
            place: place_value(
                setting
                    .and_then(|setting| setting.place)
                    .map(PlaceRef::Place),
            ),
            arrival: time_text(setting.and_then(|setting| setting.arrival)),
            position: setting.map_or(RoutePosition::Before, |setting| setting.route_position),
        }
    }

    /// 儲存的地點：只有地點清單中的地點；Destination_Place 與「不指定地點」都是未設定（需求 22.10）。
    fn place_id(&self) -> Option<PlaceId> {
        match parse_place(&self.place) {
            Some(PlaceRef::Place(id)) => Some(id),
            Some(PlaceRef::Destination) | None => None,
        }
    }
}

/// 只放進改過的欄位（需求 22.15）。
fn day_patch(initial: &DayDraft, current: &DayDraft) -> DaySettingPatch {
    DaySettingPatch {
        title: changed(&initial.title, &current.title).map(|title| {
            let trimmed = trim_white(&title);
            (!trimmed.is_empty()).then(|| title.clone())
        }),
        place: changed(&initial.place_id(), &current.place_id()),
        arrival: changed(&initial.arrival, &current.arrival).map(|text| time_input(&text)),
        route_position: changed(&initial.position, &current.position).map(Input::Ok),
        arrival_label: None,
    }
}

/// 這一天的設定（需求 22.1）：每個 Trip_Day 都有這個區塊；設定被移除（例如標題、地點與預計抵達時間都清空，
/// 需求 22.11）時保留區塊，改為顯示未設定的內容（需求 14.2）。
#[component]
pub(super) fn DaySettings(day: Date) -> impl IntoView {
    let TripContext {
        handle, stores, ui, ..
    } = use_trip();
    let slot = (Entity::DaySetting, RowKey::Day(day));
    let setting = Memo::new(move |_| {
        stores.day_settings.keys().track();
        stores.day_settings.get(day).map(|row| row.get())
    });
    let place = Memo::new(move |_| {
        handle
            .with_view(|state| match day_place(state, day) {
                Some(PlaceRef::Place(id)) => state
                    .places
                    .get(&id)
                    .map(|place| place.name.clone())
                    .unwrap_or_default(),
                Some(PlaceRef::Destination) => {
                    format!("{}（跟著旅行目的地）", trim_white(&state.card.destination))
                }
                None => "未指定".to_owned(),
            })
            .unwrap_or_default()
    });
    let editing = move || {
        ui.form_session::<DayDraft>(DAY_FORM)
            .filter(|form| form.target == FormTarget::Edit(slot))
    };
    let open = move |_| {
        let draft = DayDraft::of(setting.get_untracked().as_ref());
        ui.open_form(DAY_FORM, FormTarget::Edit(slot), draft);
    };
    let summary = move || {
        let setting = setting.get();
        let title = setting
            .as_ref()
            .and_then(|setting| setting.title.clone())
            .unwrap_or_else(|| "未設定".to_owned());
        let arrival = setting
            .as_ref()
            .and_then(|setting| setting.arrival)
            .map_or_else(|| "未填寫".to_owned(), |time| time.to_string());
        let position = position_label(
            setting
                .as_ref()
                .map_or(RoutePosition::Before, |setting| setting.route_position),
        );
        view! {
            <div class="departure-vehicle">
                <dl>
                    <div>
                        <dt>"標題"</dt>
                        <dd>{title}</dd>
                    </div>
                    <div>
                        <dt>"地點"</dt>
                        <dd>{move || place.get()}</dd>
                    </div>
                    <div>
                        <dt>"抵達"</dt>
                        <dd>{arrival}</dd>
                    </div>
                    <div>
                        <dt>"路線"</dt>
                        <dd>{position}</dd>
                    </div>
                </dl>
            </div>
        }
    };
    view! {
        <section class="vehicle-departures" aria-labelledby="day-settings-title">
            <div class="vehicle-departures-heading">
                <div>
                    <span class="eyebrow">"TODAY'S LITTLE PLAN"</span>
                    <h2 id="day-settings-title">"這一天的設定"</h2>
                </div>
                <EditorAvatars item=slot />
                <button
                    type="button"
                    class="button small"
                    aria-label="編輯這一天的設定"
                    on:click=open
                    disabled=move || editing().is_some()
                >
                    {art::static_svg(icons::EDIT)}
                    "編輯"
                </button>
            </div>
            <p class="help">"標題、地點、預計幾點抵達與路線位置；預計抵達時間由你填寫，不會自動推算。"</p>
            {move || match editing() {
                Some(form) => view! { <DaySettingsForm form day /> }.into_any(),
                None => summary().into_any(),
            }}
        </section>
    }
}

/// 每日設定的表單：標題、地點、預計幾點抵達與路線位置，只送出改過的欄位（需求 22.10、22.15）。
#[component]
fn DaySettingsForm(form: FormSession<DayDraft>, day: Date) -> impl IntoView {
    let TripContext { handle, .. } = use_trip();
    let draft = form.draft;
    let current = draft.get_untracked();
    let options = Memo::new(move |_| {
        handle
            .with_view(|state| {
                place_options(state)
                    .into_iter()
                    .map(|(place, label)| (place_value(Some(place)), label))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    });
    let save = move |event: leptos::ev::SubmitEvent| {
        event.prevent_default();
        form.save(|initial, current| {
            edit_command(day_patch(initial, current), |patch| {
                Command::SaveDaySetting { day, patch }
            })
        });
    };
    view! {
        <form class="day-settings-form" novalidate on:submit=save>
            <FormNotices form />
            <FormFields form>
                <div class="form-grid">
                    <label class="field">
                        <span>"當日標題"</span>
                        <input
                            type="text"
                            autocomplete="off"
                            value=current.title.clone()
                            on:input=move |event| {
                                let text = event_target_value(&event);
                                draft.update(|draft| draft.title = text);
                            }
                        />
                    </label>
                    <label class="field">
                        <span>"所在地點"</span>
                        {move || {
                            let chosen = draft.with_untracked(|draft| draft.place.clone());
                            view! {
                                <select on:change=move |event| {
                                    let value = event_target_value(&event);
                                    draft.update(|draft| draft.place = value);
                                }>
                                    <option value="" selected=chosen.is_empty()>
                                        "不指定地點"
                                    </option>
                                    {options
                                        .get()
                                        .into_iter()
                                        .map(|(value, label)| {
                                            let selected = value == chosen;
                                            view! {
                                                <option value=value selected=selected>
                                                    {label}
                                                </option>
                                            }
                                        })
                                        .collect_view()}
                                </select>
                            }
                        }}
                    </label>
                    <label class="field">
                        <span>"預計幾點抵達"</span>
                        <input
                            type="text"
                            inputmode="numeric"
                            autocomplete="off"
                            placeholder="例如 15:30"
                            value=current.arrival.clone()
                            on:input=move |event| {
                                let text = event_target_value(&event);
                                draft.update(|draft| draft.arrival = text);
                            }
                        />
                    </label>
                    <label class="field">
                        <span>"路線位置"</span>
                        <select on:change=move |event| {
                            let value = event_target_value(&event);
                            if let Some((position, _)) = ROUTE_POSITIONS
                                .iter()
                                .find(|(position, _)| position.as_str() == value)
                            {
                                let position = *position;
                                draft.update(|draft| draft.position = position);
                            }
                        }>
                            {ROUTE_POSITIONS
                                .iter()
                                .map(|(position, label)| {
                                    view! {
                                        <option
                                            value=position.as_str()
                                            selected=*position == current.position
                                        >
                                            {*label}
                                        </option>
                                    }
                                })
                                .collect_view()}
                        </select>
                    </label>
                </div>
            </FormFields>
            <FormError form />
            <div class="form-actions">
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
