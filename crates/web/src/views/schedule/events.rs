//! 選定日子的活動（含常用活動）與當天的料理（需求 23.1、23.2、23.8、23.9、22.13、24.3、7.8、7.10）。
//!
//! - 活動依時間由早到晚、時間相同時依 Ordinal 排列（`day_events()`，需求 23.8）；每一列有時間、標題、類別的中文名稱與
//!   「完成」勾選。勾選送出想要的值，也就是操作當下 Optimistic_View 中完成狀態的相反值（需求 7.10）。
//! - 常用活動依時間列出選定日子的 Activity_Preset；類別與這一天任一筆活動相同的項目顯示為已勾選、停用並標示「已加入」，
//!   「加入 N 個活動」只在其餘已勾選的項目至少 1 個時可以使用（需求 23.2）。一次加入的活動放在同一個 Command 中
//!   （需求 23.1）。
//! - 「＋自訂活動」與既有活動共用一個表單（表單在行內開啟）；既有活動只送出改過的欄位，參加者只送出加入與移除的元素
//!   （需求 7.8、23.9）。Collaborator 也可以刪除活動（需求 6.17）。
//! - 當天的料理以用餐時間，或留空時以餐次的預設用餐時間顯示（需求 24.3）；在列上修改用餐時間只送出用餐時間，留空時
//!   清除（需求 22.13）。
use std::collections::BTreeSet;

use leptos::html;
use leptos::prelude::*;
use lm_core::command::{ActivityDraft, ActivityPatch, Command, Input, MealPatch};
use lm_core::ids::{ActivityId, MealId, PersonId, VehicleId};
use lm_core::itinerary::{
    day_events, meal_time, meal_title, participant_label, presets_for, trip_days, DayEvent,
    DayKind, ACTIVITY_CATEGORIES,
};
use lm_core::model::{Activity, ActivityKind, Date, Entity, Participation, RowKey, TripState};
use lm_core::time::{month_day, weekday_char, Hm};
use uuid::Uuid;

use super::{time_input, time_text};
use crate::art;
use crate::pages::trip::{map_link, use_trip, TripContext};
use crate::views::editors::EditorAvatars;
use crate::views::forms::{
    changed, edit_command, set_delta, FormError, FormFields, FormNotices, FormSession, FormTarget,
    LiveTextInput,
};
use crate::views::icons;

/// 活動的表單（「＋自訂活動」與既有活動共用）。
pub(super) const ACTIVITY_FORM: &str = "activity";
/// 時間軸的標記依位置輪流使用的顏色（現行 `COLORS[i % 3]`）。
const COLORS: [&str; 3] = ["coral", "blue", "green"];

// ── 活動列表 ──

/// 選定日子的活動、常用活動與「＋自訂活動」。`days` 是旅行的每一個 Trip_Day（表單的日期選單）。
#[component]
pub(super) fn DayActivities(day: Date, days: Memo<Vec<Date>>) -> impl IntoView {
    let TripContext { handle, ui, .. } = use_trip();
    // 需求 23.8：依時間由早到晚，時間相同時依 Ordinal
    let keys = Memo::new(move |_| {
        handle
            .with_view(|state| {
                day_events(state, day)
                    .into_iter()
                    .filter_map(|event| match event {
                        DayEvent::Activity(activity) => Some(activity.id),
                        DayEvent::Meal(_) => None,
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    });
    let new_form = move || {
        ui.form_session::<ActivityFields>(ACTIVITY_FORM)
            .filter(|form| form.target == FormTarget::New)
    };
    let add = move |_| {
        ui.open_form(ACTIVITY_FORM, FormTarget::New, ActivityFields::new(day));
    };
    view! {
        <section class="vehicle-departures" aria-labelledby="day-activities-title">
            <div class="vehicle-departures-heading">
                <div>
                    <span class="eyebrow">"SLOW DOWN, ENJOY THE DAY"</span>
                    <h2 id="day-activities-title">
                        "活動 " <span>{move || format!("{} 個活動", keys.with(Vec::len))}</span>
                    </h2>
                </div>
                <button
                    type="button"
                    class="button small"
                    disabled=move || new_form().is_some()
                    on:click=add
                >
                    "＋自訂活動"
                </button>
            </div>
            <ActivityPresets day />
            {move || {
                new_form()
                    .map(|form| {
                        view! {
                            <article class="activity-card" aria-label="新增自訂活動">
                                <ActivityEditor form days />
                            </article>
                        }
                    })
            }}
            <div class="timeline">
                <For
                    each=move || keys.get()
                    key=|id| *id
                    children=move |id| view! { <ActivityCard id keys days /> }
                />
                {move || {
                    keys.with(Vec::is_empty)
                        .then(|| {
                            view! {
                                <div class="empty">
                                    {art::static_svg(icons::LEAF)}
                                    <h3>"這一天，留給新的故事。"</h3>
                                    <p>"勾選常用活動，或新增自訂活動，一起開始規劃。"</p>
                                </div>
                            }
                        })
                }}
            </div>
        </section>
    }
}

/// 選定日子的種類（決定常用活動）；不是 Trip_Day 時（只在過渡狀態）是 `None`。
fn day_kind(state: &TripState, day: Date) -> Option<DayKind> {
    trip_days(state)
        .into_iter()
        .find(|trip_day| trip_day.date == day)
        .map(|trip_day| trip_day.kind)
}

/// 常用活動（需求 23.2）：依時間列出；已加入的已勾選、停用並標示「已加入」；「加入 N 個活動」在 N 至少為 1 時才能按。
#[component]
fn ActivityPresets(day: Date) -> impl IntoView {
    let TripContext { handle, .. } = use_trip();
    let presets = Memo::new(move |_| {
        handle
            .with_view(|state| day_kind(state, day).map(presets_for))
            .flatten()
            .unwrap_or_default()
    });
    // 依 Optimistic_View：這一天已有活動的類別
    let present = Memo::new(move |_| {
        handle
            .with_view(|state| {
                state
                    .activities
                    .values()
                    .filter(|activity| activity.day == day)
                    .map(|activity| activity.kind)
                    .collect::<BTreeSet<_>>()
            })
            .unwrap_or_default()
    });
    let checked = RwSignal::new(BTreeSet::<ActivityKind>::new());
    let wanted = Memo::new(move |_| {
        let present = present.get();
        presets
            .get()
            .into_iter()
            .filter(|preset| checked.with(|set| set.contains(&preset.kind)))
            .filter(|preset| !present.contains(&preset.kind))
            .collect::<Vec<_>>()
    });
    let count = move || wanted.with(Vec::len);
    let add = move |_| {
        let items: Vec<ActivityDraft> = wanted
            .get_untracked()
            .into_iter()
            .map(|preset| ActivityDraft {
                id: ActivityId(Uuid::new_v4()),
                time: Some(Input::Ok(preset.time)),
                title: preset.title.to_owned(),
                kind: Input::Ok(preset.kind),
                location: String::new(),
                note: String::new(),
                who: Participation::Everyone,
            })
            .collect();
        if items.is_empty() {
            return;
        }
        if handle
            .submit_or_toast(Command::AddActivities { day, items })
            .is_some()
        {
            checked.set(BTreeSet::new());
        }
    };
    view! {
        <fieldset class="activity-vehicle-choices">
            <legend>"常用活動"</legend>
            {move || {
                presets
                    .get()
                    .into_iter()
                    .map(|preset| {
                        let kind = preset.kind;
                        let added = move || present.with(|set| set.contains(&kind));
                        view! {
                            <label>
                                <input
                                    type="checkbox"
                                    prop:checked=move || {
                                        added() || checked.with(|set| set.contains(&kind))
                                    }
                                    disabled=added
                                    on:change=move |event| {
                                        let on = event_target_checked(&event);
                                        checked
                                            .update(|set| {
                                                if on {
                                                    set.insert(kind);
                                                } else {
                                                    set.remove(&kind);
                                                }
                                            });
                                    }
                                />
                                <span>
                                    <strong>{format!("{} {}", preset.time, preset.title)}</strong>
                                    <small>
                                        {kind.label()}
                                        {move || added().then_some(" · 已加入")}
                                    </small>
                                </span>
                            </label>
                        }
                    })
                    .collect_view()
            }}
            <div class="form-actions">
                <button
                    type="button"
                    class="button small"
                    disabled=move || count() == 0
                    on:click=add
                >
                    {art::static_svg(icons::PLUS)}
                    {move || format!("加入 {} 個活動", count())}
                </button>
            </div>
        </fieldset>
    }
}

/// 活動列上顯示的內容。
#[derive(Clone, Debug, PartialEq)]
struct ActivitySummary {
    day: Date,
    title: String,
    time: Hm,
    kind: ActivityKind,
    location: String,
    note: String,
    done: bool,
    who: String,
    by_vehicle: bool,
}

fn activity_summary(state: &TripState, id: ActivityId) -> Option<ActivitySummary> {
    let activity = state.activities.get(&id)?;
    Some(ActivitySummary {
        day: activity.day,
        title: activity.title.clone(),
        time: activity.time,
        kind: activity.kind,
        location: activity.location.clone(),
        note: activity.note.clone(),
        done: activity.done,
        who: participant_label(state, activity),
        by_vehicle: matches!(activity.who, Participation::Vehicles(_)),
    })
}

/// 時間軸標記的圖示（現行依活動類別）。
fn kind_icon(kind: ActivityKind) -> &'static str {
    match kind {
        ActivityKind::Meet => icons::PEOPLE,
        ActivityKind::Market => icons::D_BAG,
        ActivityKind::Meal | ActivityKind::Tea => icons::D_CUP,
        ActivityKind::Travel | ActivityKind::Return => icons::CAR,
        _ => icons::D_TENT,
    }
}

/// 一筆活動：時間、類別、標題、地點、備註、參加者與「完成」勾選；正在編輯時改為顯示表單。
#[component]
fn ActivityCard(
    id: ActivityId,
    keys: Memo<Vec<ActivityId>>,
    days: Memo<Vec<Date>>,
) -> impl IntoView {
    let TripContext { handle, ui, .. } = use_trip();
    let slot = (Entity::Activity, RowKey::Id(id.0));
    let summary = Memo::new(move |_| {
        handle
            .with_view(|state| activity_summary(state, id))
            .flatten()
    });
    let color = Memo::new(move |_| {
        let index = keys.with(|keys| keys.iter().position(|key| *key == id).unwrap_or(0));
        COLORS[index % COLORS.len()]
    });
    let editing = move || {
        ui.form_session::<ActivityFields>(ACTIVITY_FORM)
            .filter(|form| form.target == FormTarget::Edit(slot))
    };
    let done = move || summary.with(|summary| summary.as_ref().is_some_and(|summary| summary.done));
    let edit = move |_| {
        if let Some(draft) = handle
            .with_view(|state| state.activities.get(&id).map(ActivityFields::of))
            .flatten()
        {
            ui.open_form(ACTIVITY_FORM, FormTarget::Edit(slot), draft);
        }
    };
    // Collaborator 也可以刪除活動（需求 6.17、23.7）
    let remove = move |_| {
        handle.submit_or_toast(Command::RemoveActivity { id });
    };
    let check = NodeRef::<html::Input>::new();
    // 需求 7.10：送出要設定的值，也就是操作當下 Optimistic_View 中完成狀態的相反值
    let toggle = move |_| {
        let done = || {
            handle
                .with_view(|state| state.activities.get(&id).map(|activity| activity.done))
                .flatten()
        };
        let Some(current) = done() else {
            return;
        };
        handle.submit_or_toast(Command::SetActivityDone { id, done: !current });
        // 被拒絕時勾選框回到 Optimistic_View 的狀態
        if let (Some(element), Some(now)) = (check.get_untracked(), done()) {
            element.set_checked(now);
        }
    };
    let card = move || {
        let summary = summary.get()?;
        let title = summary.title.clone();
        let location = summary.location.trim().to_owned();
        let note = summary.note.clone();
        Some(view! {
            <span class=move || format!("timeline-stamp {}", color.get())>
                {art::static_svg(kind_icon(summary.kind))}
            </span>
            <div class="activity-top">
                <time datetime=format!("{}T{}", summary.day, summary.time)>
                    {summary.time.to_string()}
                </time>
                <span class=move || format!("tag {}", color.get())>{summary.kind.label()}</span>
                <div class="activity-actions">
                    <EditorAvatars item=slot />
                    <button
                        type="button"
                        class="icon-button activity-edit"
                        data-row-action="edit"
                        aria-label=format!("編輯 {title}")
                        on:click=edit
                    >
                        {art::static_svg(icons::EDIT)}
                    </button>
                    <button
                        type="button"
                        class="icon-button danger"
                        data-row-action="delete"
                        aria-label=format!("移除 {title}")
                        on:click=remove
                    >
                        {art::static_svg(icons::CLOSE)}
                    </button>
                </div>
            </div>
            <h3>{title.clone()}</h3>
            {(!location.is_empty())
                .then(|| {
                    view! {
                        <div class="activity-location">
                            {art::static_svg(icons::PIN)}
                            {map_link(&location)}
                        </div>
                    }
                })}
            {(!note.is_empty()).then(|| view! { <p>{note}</p> })}
            <div class="activity-bottom">
                <span>
                    {art::static_svg(if summary.by_vehicle { icons::CAR } else { icons::PEOPLE })}
                    <span>{summary.who.clone()}</span>
                </span>
                <label class="mini-check">
                    <input
                        node_ref=check
                        type="checkbox"
                        prop:checked=summary.done
                        aria-label=format!("{title}已完成")
                        on:change=toggle
                    />
                    <span>{if summary.done { "已完成" } else { "完成" }}</span>
                </label>
            </div>
        })
    };
    view! {
        // 靜態的 class 加上 `class:` 切換，避免覆寫 Swipe_Controller 加上的 `swipe-row`／`swipe-open`
        <article
            class="activity-card"
            class:done=move || done() && editing().is_none()
            data-swipe-row=move || editing().is_none().then_some("")
        >
            {move || match editing() {
                Some(form) => view! { <ActivityEditor form days /> }.into_any(),
                None => card().into_any(),
            }}
        </article>
    }
}

// ── 活動的表單 ──

/// 參加者的選擇（需求 23.4）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WhoMode {
    Everyone,
    People,
    Vehicles,
}

impl WhoMode {
    const ALL: [(WhoMode, &'static str, &'static str); 3] = [
        (WhoMode::Everyone, "everyone", "全體旅伴"),
        (WhoMode::People, "people", "指定旅伴（可複選）"),
        (WhoMode::Vehicles, "vehicles", "指定車輛（可複選）"),
    ];

    fn value(self) -> &'static str {
        Self::ALL
            .iter()
            .find(|(mode, _, _)| *mode == self)
            .map_or("everyone", |(_, value, _)| value)
    }

    fn parse(value: &str) -> Option<WhoMode> {
        Self::ALL
            .iter()
            .find(|(_, text, _)| *text == value)
            .map(|(mode, _, _)| *mode)
    }
}

/// 活動表單的草稿。時間是欄位中的文字；指定旅伴與指定車輛在切換參加者的選擇時保留，儲存時只取目前選擇的那一種。
#[derive(Clone, Debug, PartialEq)]
struct ActivityFields {
    id: ActivityId,
    title: String,
    day: Date,
    time: String,
    kind: ActivityKind,
    location: String,
    note: String,
    mode: WhoMode,
    people: BTreeSet<PersonId>,
    vehicles: BTreeSet<VehicleId>,
}

impl ActivityFields {
    fn of(activity: &Activity) -> ActivityFields {
        let (mode, people, vehicles) = match &activity.who {
            Participation::Everyone => (WhoMode::Everyone, BTreeSet::new(), BTreeSet::new()),
            Participation::People(ids) => (WhoMode::People, ids.clone(), BTreeSet::new()),
            Participation::Vehicles(ids) => (WhoMode::Vehicles, BTreeSet::new(), ids.clone()),
        };
        ActivityFields {
            id: activity.id,
            title: activity.title.clone(),
            day: activity.day,
            time: activity.time.to_string(),
            kind: activity.kind,
            location: activity.location.clone(),
            note: activity.note.clone(),
            mode,
            people,
            vehicles,
        }
    }

    /// 「＋自訂活動」：以隨機的 UUID 為 id（需求 7.18），選定的日子、營地時光、全體旅伴，沒有標題與時間（現行
    /// `customActivityDraft()`）。
    fn new(day: Date) -> ActivityFields {
        ActivityFields {
            id: ActivityId(Uuid::new_v4()),
            title: String::new(),
            day,
            time: String::new(),
            kind: ActivityKind::Camp,
            location: String::new(),
            note: String::new(),
            mode: WhoMode::Everyone,
            people: BTreeSet::new(),
            vehicles: BTreeSet::new(),
        }
    }

    /// 儲存的指定旅伴（不是「指定旅伴」時是空的）。
    fn chosen_people(&self) -> BTreeSet<PersonId> {
        match self.mode {
            WhoMode::People => self.people.clone(),
            _ => BTreeSet::new(),
        }
    }

    /// 儲存的指定車輛（不是「指定車輛」時是空的）。
    fn chosen_vehicles(&self) -> BTreeSet<VehicleId> {
        match self.mode {
            WhoMode::Vehicles => self.vehicles.clone(),
            _ => BTreeSet::new(),
        }
    }

    /// 新增的參加者；指定的集合是空的時為全體旅伴（需求 23.4）。
    fn who(&self) -> Participation {
        let people = self.chosen_people();
        let vehicles = self.chosen_vehicles();
        if !people.is_empty() {
            Participation::People(people)
        } else if !vehicles.is_empty() {
            Participation::Vehicles(vehicles)
        } else {
            Participation::Everyone
        }
    }

    /// 「＋自訂活動」的 Command（需求 23.1）：在表單選擇的 Trip_Day 新增一筆。
    fn add_command(&self) -> Command {
        Command::AddActivities {
            day: self.day,
            items: vec![ActivityDraft {
                id: self.id,
                time: time_input(&self.time),
                title: self.title.clone(),
                kind: Input::Ok(self.kind),
                location: self.location.clone(),
                note: self.note.clone(),
                who: self.who(),
            }],
        }
    }
}

/// 只放進改過的欄位；參加者只放加入與移除的指定旅伴與指定車輛（需求 7.8、23.9）。
fn activity_patch(initial: &ActivityFields, current: &ActivityFields) -> ActivityPatch {
    let (people_add, people_remove) = set_delta(&initial.chosen_people(), &current.chosen_people());
    let (vehicles_add, vehicles_remove) =
        set_delta(&initial.chosen_vehicles(), &current.chosen_vehicles());
    ActivityPatch {
        title: changed(&initial.title, &current.title),
        day: changed(&initial.day, &current.day),
        time: changed(&initial.time, &current.time).map(|text| time_input(&text)),
        kind: changed(&initial.kind, &current.kind).map(Input::Ok),
        location: changed(&initial.location, &current.location),
        note: changed(&initial.note, &current.note),
        people_add,
        people_remove,
        vehicles_add,
        vehicles_remove,
    }
}

/// 日期選單的文字：「第 {N} 天 {M}/{D} 週{X}」。
fn day_label(index: usize, date: Date) -> String {
    format!(
        "第 {} 天 {} 週{}",
        index + 1,
        month_day(date),
        weekday_char(date)
    )
}

/// 活動的表單（「＋自訂活動」與既有活動共用）。
#[component]
fn ActivityEditor(form: FormSession<ActivityFields>, days: Memo<Vec<Date>>) -> impl IntoView {
    let TripContext { handle, .. } = use_trip();
    let draft = form.draft;
    let current = draft.get_untracked();
    let id = current.id;
    let is_new = form.target == FormTarget::New;
    let people = Memo::new(move |_| {
        handle
            .with_view(|state| {
                state
                    .people_by_ordinal()
                    .map(|person| (person.id, person.name.clone()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    });
    let vehicles = Memo::new(move |_| {
        handle
            .with_view(|state| {
                state
                    .vehicles_by_ordinal()
                    .map(|vehicle| (vehicle.id, vehicle.name.clone()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    });
    let mode = Memo::new(move |_| draft.with(|draft| draft.mode));
    let save = move |event: leptos::ev::SubmitEvent| {
        event.prevent_default();
        if is_new {
            form.save(|_, current| Some(current.add_command()));
        } else {
            form.save(|initial, current| {
                edit_command(activity_patch(initial, current), |patch| {
                    Command::UpdateActivity { id, patch }
                })
            });
        }
    };
    let remove = move |_| {
        form.submit(Command::RemoveActivity { id });
    };
    view! {
        <form class="activity-form" novalidate on:submit=save>
            <FormNotices form />
            <FormFields form>
                <h3>{if is_new { "新增自訂活動" } else { "編輯活動" }}</h3>
                <div class="form-grid">
                    <label class="field wide">
                        <span>"活動名稱"</span>
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
                        <span>"日期"</span>
                        {move || {
                            let chosen = draft.with_untracked(|draft| draft.day);
                            view! {
                                <select on:change=move |event| {
                                    if let Ok(day) = event_target_value(&event).parse::<Date>() {
                                        draft.update(|draft| draft.day = day);
                                    }
                                }>
                                    {days
                                        .get()
                                        .into_iter()
                                        .enumerate()
                                        .map(|(index, date)| {
                                            view! {
                                                <option value=date.to_string() selected=date == chosen>
                                                    {day_label(index, date)}
                                                </option>
                                            }
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
                            placeholder="例如 08:30"
                            value=current.time.clone()
                            on:input=move |event| {
                                let text = event_target_value(&event);
                                draft.update(|draft| draft.time = text);
                            }
                        />
                    </label>
                    <label class="field">
                        <span>"活動類型"</span>
                        <select on:change=move |event| {
                            if let Some(kind) = ActivityKind::parse(&event_target_value(&event)) {
                                draft.update(|draft| draft.kind = kind);
                            }
                        }>
                            {ACTIVITY_CATEGORIES
                                .iter()
                                .map(|(kind, label)| {
                                    view! {
                                        <option value=kind.as_str() selected=*kind == current.kind>
                                            {*label}
                                        </option>
                                    }
                                })
                                .collect_view()}
                        </select>
                    </label>
                    <label class="field">
                        <span>"地點"</span>
                        <input
                            type="text"
                            autocomplete="off"
                            value=current.location.clone()
                            on:input=move |event| {
                                let text = event_target_value(&event);
                                draft.update(|draft| draft.location = text);
                            }
                        />
                    </label>
                    <label class="field wide">
                        <span>"備註"</span>
                        <textarea
                            rows="3"
                            on:input=move |event| {
                                let text = event_target_value(&event);
                                draft.update(|draft| draft.note = text);
                            }
                        >
                            {current.note.clone()}
                        </textarea>
                    </label>
                    <label class="field wide">
                        <span>"這一站誰參加"</span>
                        <select on:change=move |event| {
                            if let Some(mode) = WhoMode::parse(&event_target_value(&event)) {
                                draft.update(|draft| draft.mode = mode);
                            }
                        }>
                            {WhoMode::ALL
                                .iter()
                                .map(|(mode, value, label)| {
                                    view! {
                                        <option value=*value selected=*mode == current.mode>
                                            {*label}
                                        </option>
                                    }
                                })
                                .collect_view()}
                        </select>
                    </label>
                    {move || match mode.get() {
                        WhoMode::Everyone => ().into_any(),
                        WhoMode::People => {
                            choices(
                                "參加的旅伴（至少選一位）",
                                people.get(),
                                "還沒有旅伴。",
                                move |person| draft.with_untracked(|draft| draft.people.contains(&person)),
                                move |person, on| {
                                    draft
                                        .update(|draft| {
                                            if on {
                                                draft.people.insert(person);
                                            } else {
                                                draft.people.remove(&person);
                                            }
                                        })
                                },
                            )
                                .into_any()
                        }
                        WhoMode::Vehicles => {
                            choices(
                                "參加的車（至少選一台）",
                                vehicles.get(),
                                "還沒有車輛，請先在「旅行選單」新增車輛。",
                                move |vehicle| draft.with_untracked(|draft| draft.vehicles.contains(&vehicle)),
                                move |vehicle, on| {
                                    draft
                                        .update(|draft| {
                                            if on {
                                                draft.vehicles.insert(vehicle);
                                            } else {
                                                draft.vehicles.remove(&vehicle);
                                            }
                                        })
                                },
                            )
                                .into_any()
                        }
                    }}
                </div>
            </FormFields>
            <FormError form />
            <div class="form-actions">
                {(!is_new)
                    .then(|| {
                        view! {
                            <button type="button" class="text-button danger" disabled=move || form.locked() on:click=remove>
                                "移除項目"
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

/// 指定旅伴或指定車輛的勾選清單（依 Ordinal）。
fn choices<K: Copy + ToString + 'static>(
    legend: &'static str,
    options: Vec<(K, String)>,
    empty: &'static str,
    is_checked: impl Fn(K) -> bool + 'static,
    set: impl Fn(K, bool) + Copy + 'static,
) -> impl IntoView {
    let empty = options
        .is_empty()
        .then(|| view! { <p class="help">{empty}</p> });
    view! {
        <fieldset class="wide activity-vehicle-choices">
            <legend>{legend}</legend>
            {empty}
            {options
                .into_iter()
                .map(|(key, name)| {
                    view! {
                        <label>
                            <input
                                type="checkbox"
                                value=key.to_string()
                                checked=is_checked(key)
                                on:change=move |event| set(key, event_target_checked(&event))
                            />
                            <span>
                                <strong>{name}</strong>
                            </span>
                        </label>
                    }
                })
                .collect_view()}
        </fieldset>
    }
}

// ── 當天的料理 ──

/// 當天的料理（需求 22.1、22.13、24.3）：依顯示的時間由早到晚，時間相同時依 Ordinal。
#[component]
pub(super) fn DayMeals(day: Date) -> impl IntoView {
    let TripContext { handle, .. } = use_trip();
    let keys = Memo::new(move |_| {
        handle
            .with_view(|state| {
                day_events(state, day)
                    .into_iter()
                    .filter_map(|event| match event {
                        DayEvent::Meal(meal) => Some(meal.id),
                        DayEvent::Activity(_) => None,
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    });
    view! {
        <section class="vehicle-departures" aria-labelledby="day-meals-title">
            <div class="vehicle-departures-heading">
                <div>
                    <span class="eyebrow">"GOOD FOOD, GOOD MOOD"</span>
                    <h2 id="day-meals-title">
                        "當天的料理 " <span>{move || format!("{} 道料理", keys.with(Vec::len))}</span>
                    </h2>
                </div>
            </div>
            <p class="help">"用餐時間留空時，使用餐次的預設時間。"</p>
            {move || {
                keys.with(Vec::is_empty)
                    .then(|| {
                        view! {
                            <div class="departure-vehicles-empty">"這一天還沒有安排料理。"</div>
                        }
                    })
            }}
            <ul class="event-list">
                <For
                    each=move || keys.get()
                    key=|id| *id
                    children=move |id| view! { <MealTimeRow id day /> }
                />
            </ul>
        </section>
    }
}

/// 當天料理的一列顯示的內容。
#[derive(Clone, Debug, PartialEq)]
struct MealSummary {
    title: String,
    /// 顯示的時間：用餐時間，留空時是餐次的預設用餐時間（需求 24.3）
    shown: Hm,
    /// 設定的用餐時間
    time: Option<Hm>,
}

/// 當天的一道料理：顯示的時間、標題與可以修改的用餐時間（需求 22.13）。
#[component]
fn MealTimeRow(id: MealId, day: Date) -> impl IntoView {
    let TripContext { handle, .. } = use_trip();
    let summary = Memo::new(move |_| {
        handle
            .with_view(|state| {
                state.meals.get(&id).map(|meal| MealSummary {
                    title: meal_title(meal),
                    shown: meal_time(meal),
                    time: meal.time,
                })
            })
            .flatten()
    });
    let value = Signal::derive(move || {
        summary.with(|summary| time_text(summary.as_ref().and_then(|summary| summary.time)))
    });
    let label = Signal::derive(move || {
        summary.with(|summary| {
            summary
                .as_ref()
                .map(|summary| format!("{}的用餐時間", summary.title))
                .unwrap_or_default()
        })
    });
    let placeholder = Signal::derive(move || {
        summary.with(|summary| {
            summary
                .as_ref()
                .map(|summary| format!("預設 {}", summary.shown))
                .unwrap_or_default()
        })
    });
    // 只送出用餐時間；與目前的值相同時不送出，留空時清除（需求 7.8、22.13）
    let commit = move |text: String| {
        let Some(current) = handle
            .with_view(|state| state.meals.get(&id).map(|meal| meal.time))
            .flatten()
        else {
            return;
        };
        if Hm::parse(&text).is_ok_and(|time| time == current) {
            return;
        }
        handle.submit_or_toast(Command::UpdateMeal {
            id,
            patch: MealPatch {
                time: Some(time_input(&text)),
                ..MealPatch::default()
            },
        });
    };
    // 欄位的節點保持不變，修改用餐時間之後焦點不會離開（需求 14.11）
    let shown = move || summary.with(|summary| summary.as_ref().map(|summary| summary.shown));
    view! {
        <li>
            <span>
                <time datetime=move || {
                    shown().map(|time| format!("{day}T{time}")).unwrap_or_default()
                }>{move || shown().map(|time| time.to_string())}</time>
                " "
                <b>
                    {move || {
                        summary.with(|summary| {
                            summary.as_ref().map(|summary| summary.title.clone())
                        })
                    }}
                </b>
                {move || {
                    summary
                        .with(|summary| {
                            summary.as_ref().is_some_and(|summary| summary.time.is_none())
                        })
                        .then_some("（預設時間）")
                }}
            </span>
            <label class="field">
                <span>"用餐時間"</span>
                <LiveTextInput value on_commit=commit label placeholder />
            </label>
        </li>
    }
}
