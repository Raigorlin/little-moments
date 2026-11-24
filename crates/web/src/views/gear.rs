//! Gear_Tab「裝備分工」（`?tab=gear`，需求 27.1、27.9、27.11、27.13、6.17）。沿用 `src/app.js` 的 `gear()` 與
//! `formDialog('gear')` 的元素結構與 class。
//!
//! - 個人裝備（「每個人，都帶一份」）與共用裝備（「公用裝備，一起分工」）兩組，以 `RowStore::grouped()` 依範圍分組，
//!   組內依 Ordinal；沒有裝備的組不顯示，沒有任何裝備時顯示「這裡已經都分配好了。」（需求 27.1）。
//! - 每列有名稱與數量；個人裝備標示「每人一份」，並以旅伴名字列出依 Ordinal 排列的每位旅伴的打包勾選；共用裝備以負責人
//!   選單顯示目前的負責人，有負責人時只列出負責人的打包勾選，待分配時沒有打包勾選。只有檢視者自己的 Bound_Person 的
//!   勾選可以點選（就是他在 My_Gear 中的裝備），送出 `SetGearPacked`（想要的值）；其他旅伴的勾選停用，沒有 Bound_Person
//!   的檢視者全部停用（需求 27.9）。
//! - 「裝備準備 done / total」（Gear_Progress）與「還有 N 項公用裝備待分配，出發前記得找個主人。」（N ≥ 1 時，需求 27.9）。
//! - 負責人選單改選時立即送出只修改負責人的 `UpdateGear`，不開啟表單（需求 27.13）；LM_Core 拒絕時以 Toast 顯示，選單
//!   回到 Optimistic_View 的值。
//! - 「新增裝備」與「編輯 {名稱}」開啟同一個行內的表單（類型、常用露營裝備（只在新增時）、裝備名稱、數量與單位、公用
//!   裝備攜帶人）：`PERSONAL_GEAR_GROUPS` 的建議只把名稱與建議數量填入草稿；類型為個人時隱藏攜帶人，儲存時負責人一律
//!   為空，所以有負責人的共用裝備改為個人裝備時，同一個 Command 也清空負責人（需求 27.11）；編輯時只送出改過的欄位
//!   （需求 7.8）。
//! - 「移除 {名稱}」與表單中的「移除項目」只對 Trip_Manager 顯示（需求 6.17）。

use std::collections::BTreeSet;

use leptos::html;
use leptos::prelude::*;
use lm_core::command::{Command, GearDraft, GearPatch};
use lm_core::ids::{GearId, PersonId};
use lm_core::model::{Entity, GearItem, GearScope, RowKey, Slot};
use lm_core::recipes::{personal_gear_preset, PERSONAL_GEAR_GROUPS};
use lm_core::rules::{gear_progress, unassigned_gear};
use uuid::Uuid;

use crate::art;
use crate::pages::trip::{use_trip, TripContext};
use crate::sync::store::{group_keys, group_names};
use crate::views::editors::{AvatarSize, EditorAvatars};
use crate::views::forms::{
    changed, edit_command, FormError, FormFields, FormNotices, FormSession, FormTarget,
};
use crate::views::icons;

/// 裝備的表單（新增與編輯共用）。
const GEAR_FORM: &str = "gear";

/// 共用裝備沒有負責人時（需求 27.1）。
const UNASSIGNED: &str = "待分配";

/// 沒有任何裝備時（需求 27.1）。
const EMPTY: &str = "這裡已經都分配好了。";

/// 新增裝備時數量的預設值（現行 `item.quantity||'1 個'`）。
const DEFAULT_QUANTITY: &str = "1 個";

/// 現行 `icons.bag`（個人裝備列的圖示）。
const BAG: &str = r#"<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 8h16l-1 13H5L4 8Zm4 0V6a4 4 0 0 1 8 0v2"/></svg>"#;

/// 現行 `icons.tent`（共用裝備列的圖示）。
const TENT: &str = r#"<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m3 20 9-16 9 16H3Zm5 0 4-8 4 8M10 2l4 4m0-4-4 4"/></svg>"#;

fn gear_slot(id: GearId) -> Slot {
    (Entity::Gear, RowKey::Id(id.0))
}

/// 組的標題（需求 27.1）。
fn group_title(scope: GearScope) -> &'static str {
    match scope {
        GearScope::Personal => "每個人，都帶一份",
        GearScope::Shared => "公用裝備，一起分工",
    }
}

/// 一位旅伴：依 Ordinal 排列的清單用於打包勾選、負責人選單與表單的攜帶人。
#[derive(Clone, Debug, PartialEq)]
struct PersonInfo {
    id: PersonId,
    name: String,
    /// `data-person-color` 的值（現行 `personColor()`）
    color: &'static str,
}

/// `person` 的 `data-person-color`；找不到（待分配）時為 `unassigned`。
fn person_color(people: &[PersonInfo], person: Option<PersonId>) -> &'static str {
    person
        .and_then(|id| people.iter().find(|p| p.id == id))
        .map_or("unassigned", |p| p.color)
}

/// 裝備表單的草稿。`assignee` 只在類型為共用時儲存。
#[derive(Clone, Debug, PartialEq)]
struct GearFields {
    id: GearId,
    name: String,
    quantity: String,
    scope: GearScope,
    assignee: Option<PersonId>,
}

impl GearFields {
    /// 新增裝備（現行 `formDialog('gear')`）：以隨機的 UUID 為 id（需求 7.18），類型為公用裝備、數量「1 個」、待分配。
    fn new() -> GearFields {
        GearFields {
            id: GearId(Uuid::new_v4()),
            name: String::new(),
            quantity: DEFAULT_QUANTITY.to_owned(),
            scope: GearScope::Shared,
            assignee: None,
        }
    }

    fn of(gear: &GearItem) -> GearFields {
        GearFields {
            id: gear.id,
            name: gear.name.clone(),
            quantity: gear.quantity.clone(),
            scope: gear.scope,
            assignee: gear.assignee,
        }
    }

    /// 儲存的負責人：個人裝備一律沒有負責人（需求 27.11）。
    fn saved_assignee(&self) -> Option<PersonId> {
        match self.scope {
            GearScope::Personal => None,
            GearScope::Shared => self.assignee,
        }
    }

    fn add_command(&self) -> Command {
        Command::AddGear {
            id: self.id,
            draft: GearDraft {
                name: self.name.clone(),
                quantity: self.quantity.clone(),
                scope: self.scope,
                assignee: self.saved_assignee(),
            },
        }
    }
}

/// 只放進改過的欄位（需求 7.8）。負責人以儲存的負責人比較：有負責人的共用裝備改為個人裝備時得到 `Some(None)`，與範圍
/// 在同一個 patch 中送出（需求 27.11）。
fn gear_patch(initial: &GearFields, current: &GearFields) -> GearPatch {
    GearPatch {
        name: changed(&initial.name, &current.name),
        quantity: changed(&initial.quantity, &current.quantity),
        scope: changed(&initial.scope, &current.scope),
        assignee: changed(&initial.saved_assignee(), &current.saved_assignee()),
    }
}

/// 檢視者是 Trip_Manager（看得到裝備的刪除，需求 6.17）；在 reactive 範圍中讀取時依 `revision` 重算。
fn can_manage(ctx: TripContext) -> bool {
    ctx.handle
        .viewer()
        .is_some_and(|viewer| viewer.caps.can_manage)
}

/// Gear_Tab「裝備分工」。以 `pages::trip::use_trip()` 取得這趟旅行的內容。
#[component]
pub fn GearTab() -> impl IntoView {
    let ctx = use_trip();
    let TripContext {
        handle, stores, ui, ..
    } = ctx;
    let people = Memo::new(move |_| {
        handle
            .with_view(|state| {
                state
                    .people_by_ordinal()
                    .map(|person| PersonInfo {
                        id: person.id,
                        name: person.name.clone(),
                        color: person.color.as_str(),
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    });
    let me = Memo::new(move |_| ctx.me());
    let manager = Memo::new(move |_| can_manage(ctx));
    let progress = Memo::new(move |_| handle.with_view(gear_progress).unwrap_or_default());
    let missing = Memo::new(move |_| {
        handle
            .with_view(|state| unassigned_gear(state).count())
            .unwrap_or(0)
    });
    let groups = stores.gear.grouped(|gear| gear.scope);
    let keys = stores.gear.keys();
    let new_form = move || {
        ui.form_session::<GearFields>(GEAR_FORM)
            .filter(|form| form.target == FormTarget::New)
    };
    let add = move |_| {
        ui.open_form(GEAR_FORM, FormTarget::New, GearFields::new());
    };
    view! {
        <div class="section-title">
            <div>
                <span class="eyebrow">"PACK A LITTLE HAPPINESS"</span>
                <h2>"小隊裝備分工"</h2>
            </div>
            <button
                type="button"
                class="button small"
                disabled=move || new_form().is_some()
                on:click=add
            >
                {art::static_svg(icons::PLUS)}
                "新增裝備"
            </button>
        </div>
        <p class="section-description">"個人的自己帶，公用的一起分工。選擇攜帶人後會立即儲存。"</p>
        <div class="shopping-summary">
            <span>
                {move || {
                    let progress = progress.get();
                    format!("裝備準備 {} / {}", progress.done, progress.total)
                }}
            </span>
            <progress
                class="yellow-progress"
                aria-label="裝備準備進度"
                max=move || progress.get().total.max(1)
                value=move || progress.get().done
            ></progress>
        </div>
        {move || {
            let count = missing.get();
            (count > 0)
                .then(|| {
                    view! {
                        <div class="notice">
                            {art::static_svg(icons::INFO)}
                            <span>
                                "還有 " <b>{format!("{count} 項")}</b> "公用裝備待分配，出發前記得找個主人。"
                            </span>
                        </div>
                    }
                })
        }}
        {move || {
            new_form()
                .map(|form| {
                    view! {
                        <section class="gear-group" aria-label="新增裝備">
                            <div class="gear-table">
                                <div class="dialog-content">
                                    <GearEditor form people manager />
                                </div>
                            </div>
                        </section>
                    }
                })
        }}
        <For
            each=group_names(groups)
            key=|scope| *scope
            children=move |scope| {
                let members = group_keys(groups, scope);
                let count = Memo::new(move |_| members().len());
                view! {
                    <section class="gear-group">
                        <h3>
                            {group_title(scope)} <span>{move || format!("{} 項", count.get())}</span>
                        </h3>
                        <div class="gear-table">
                            <For
                                each=group_keys(groups, scope)
                                key=|id| *id
                                children=move |id| view! { <GearRow id people me manager /> }
                            />
                        </div>
                    </section>
                }
            }
        />
        {move || {
            keys.with(Vec::is_empty)
                .then(|| {
                    view! {
                        <div class="empty">
                            <h3>{EMPTY}</h3>
                        </div>
                    }
                })
        }}
    }
}

/// 一個裝備（現行 `.gear-row`）；正在編輯時改為顯示表單。
#[component]
fn GearRow(
    id: GearId,
    people: Memo<Vec<PersonInfo>>,
    me: Memo<Option<PersonId>>,
    manager: Memo<bool>,
) -> impl IntoView {
    let TripContext {
        handle, stores, ui, ..
    } = use_trip();
    let slot = gear_slot(id);
    let row = stores.gear.get(id);
    let item = Memo::new(move |_| row.as_ref().map(|row| row.get()));
    let scope = Memo::new(move |_| item.with(|item| item.as_ref().map(|gear| gear.scope)));
    let name = Memo::new(move |_| {
        item.with(|item| item.as_ref().map(|gear| gear.name.clone()))
            .unwrap_or_default()
    });
    let quantity = Memo::new(move |_| {
        item.with(|item| item.as_ref().map(|gear| gear.quantity.clone()))
            .unwrap_or_default()
    });
    let assignee =
        Memo::new(move |_| item.with(|item| item.as_ref().and_then(|gear| gear.assignee)));
    // 列出打包勾選的旅伴（需求 27.9）：個人裝備是每位旅伴，有負責人的共用裝備只有負責人，待分配時沒有
    let packers = Memo::new(move |_| {
        let people = people.get();
        match (scope.get(), assignee.get()) {
            (Some(GearScope::Personal), _) => people.iter().map(|person| person.id).collect(),
            (Some(GearScope::Shared), Some(owner)) => people
                .iter()
                .filter(|person| person.id == owner)
                .map(|person| person.id)
                .collect(),
            _ => Vec::new(),
        }
    });
    let packed = Memo::new(move |_| {
        item.with(|item| {
            item.as_ref()
                .map(|gear| gear.packed_by.clone())
                .unwrap_or_default()
        })
    });
    let editing = move || {
        ui.form_session::<GearFields>(GEAR_FORM)
            .filter(|form| form.target == FormTarget::Edit(slot))
    };
    let edit = move |_| {
        if let Some(draft) = handle
            .with_view(|state| state.gear.get(&id).map(GearFields::of))
            .flatten()
        {
            ui.open_form(GEAR_FORM, FormTarget::Edit(slot), draft);
        }
    };
    let remove = move |_| {
        handle.submit_or_toast(Command::RemoveGear { id });
    };
    let checks = move || {
        view! {
            <span class="passenger-checks">
                <For
                    each=move || packers.get()
                    key=|person| *person
                    children=move |person| {
                        view! { <PackCheck id person name people me packed /> }
                    }
                />
            </span>
        }
    };
    let row_view = move || {
        let scope = scope.get()?;
        let side = match scope {
            GearScope::Personal => view! { <span class="tag green">"每人一份"</span> }.into_any(),
            GearScope::Shared => view! { <AssigneeSelect id name assignee people /> }.into_any(),
        };
        Some(view! {
            <div class="gear-row">
                <div class="gear-item">
                    {art::static_svg(if scope == GearScope::Personal { BAG } else { TENT })}
                    <span>
                        <strong>
                            {move || name.get()} <EditorAvatars item=slot size=AvatarSize::Row />
                        </strong>
                        <small>{move || quantity.get()}</small>
                        {checks}
                    </span>
                </div>
                {side}
                <div class="gear-row-actions">
                    <button
                        type="button"
                        class="icon-button"
                        aria-label=move || format!("編輯 {}", name.get())
                        on:click=edit
                    >
                        {art::static_svg(icons::EDIT)}
                    </button>
                    {move || {
                        manager
                            .get()
                            .then(|| {
                                view! {
                                    <button
                                        type="button"
                                        class="icon-button danger"
                                        aria-label=move || format!("移除 {}", name.get())
                                        on:click=remove
                                    >
                                        {art::static_svg(icons::CLOSE)}
                                    </button>
                                }
                            })
                    }}
                </div>
            </div>
        })
    };
    view! {
        {move || match editing() {
            Some(form) => {
                view! {
                    <div class="dialog-content">
                        <GearEditor form people manager />
                    </div>
                }
                    .into_any()
            }
            None => row_view.into_any(),
        }}
    }
}

/// 一位旅伴在這個裝備的打包勾選（需求 27.6、27.9）：只有檢視者自己的 Bound_Person 可以點選，送出想要的值。
#[component]
fn PackCheck(
    id: GearId,
    person: PersonId,
    name: Memo<String>,
    people: Memo<Vec<PersonInfo>>,
    me: Memo<Option<PersonId>>,
    packed: Memo<BTreeSet<PersonId>>,
) -> impl IntoView {
    let TripContext { handle, .. } = use_trip();
    let check = NodeRef::<html::Input>::new();
    let person_name = Memo::new(move |_| {
        people.with(|people| {
            people
                .iter()
                .find(|p| p.id == person)
                .map(|p| p.name.clone())
                .unwrap_or_default()
        })
    });
    let is_packed = move || packed.with(|packed| packed.contains(&person));
    let toggle = move |_| {
        let current = || {
            handle
                .with_view(|state| {
                    state
                        .gear
                        .get(&id)
                        .map(|gear| gear.packed_by.contains(&person))
                })
                .flatten()
        };
        let Some(now) = current() else {
            return;
        };
        handle.submit_or_toast(Command::SetGearPacked {
            id,
            person,
            packed: !now,
        });
        // 被拒絕時勾選框回到 Optimistic_View 的狀態
        if let (Some(element), Some(now)) = (check.get_untracked(), current()) {
            element.set_checked(now);
        }
    };
    view! {
        <label>
            <input
                node_ref=check
                type="checkbox"
                prop:checked=is_packed
                disabled=move || me.get() != Some(person)
                aria-label=move || format!("{}已打包{}", person_name.get(), name.get())
                on:change=toggle
            />
            {move || person_name.get()}
        </label>
    }
}

/// 共用裝備列上的負責人選單（現行 `assigneeSelect(g, 'gear')`）：改選時立即送出只修改負責人的 Command（需求 27.13）。
#[component]
fn AssigneeSelect(
    id: GearId,
    name: Memo<String>,
    assignee: Memo<Option<PersonId>>,
    people: Memo<Vec<PersonInfo>>,
) -> impl IntoView {
    let TripContext { handle, .. } = use_trip();
    let select = NodeRef::<html::Select>::new();
    let value_of = |person: Option<PersonId>| person.map(|p| p.to_string()).unwrap_or_default();
    let change = move |event: leptos::ev::Event| {
        let chosen = Uuid::parse_str(&event_target_value(&event))
            .ok()
            .map(PersonId);
        let current = handle
            .with_view(|state| state.gear.get(&id).map(|gear| gear.assignee))
            .flatten();
        let Some(current) = current else {
            return;
        };
        if chosen != current {
            handle.submit_or_toast(Command::UpdateGear {
                id,
                patch: GearPatch {
                    assignee: Some(chosen),
                    ..GearPatch::default()
                },
            });
        }
        // 被拒絕時選單回到 Optimistic_View 的值
        if let (Some(element), Some(now)) = (
            select.get_untracked(),
            handle
                .with_view(|state| state.gear.get(&id).map(|gear| gear.assignee))
                .flatten(),
        ) {
            element.set_value(&value_of(now));
        }
    };
    view! {
        <select
            node_ref=select
            class="assignee-select"
            data-person-select=""
            data-person-color=move || people.with(|people| person_color(people, assignee.get()))
            aria-label=move || format!("{}攜帶人", name.get())
            title="選擇負責人後立即儲存"
            on:change=change
        >
            <option
                value=""
                data-person-color="unassigned"
                prop:selected=move || assignee.get().is_none()
            >
                {UNASSIGNED}
            </option>
            {move || {
                people
                    .get()
                    .into_iter()
                    .map(|person| {
                        let id = person.id;
                        view! {
                            <option
                                value=id.to_string()
                                data-person-color=person.color
                                prop:selected=move || assignee.get() == Some(id)
                            >
                                {format!("{}負責", person.name)}
                            </option>
                        }
                    })
                    .collect_view()
            }}
        </select>
    }
}

/// 裝備表單（沿用 `formDialog('gear')` 的欄位）。
#[component]
fn GearEditor(
    form: FormSession<GearFields>,
    people: Memo<Vec<PersonInfo>>,
    manager: Memo<bool>,
) -> impl IntoView {
    let draft = form.draft;
    let current = draft.get_untracked();
    let id = current.id;
    let is_new = form.target == FormTarget::New;
    // 「常用露營裝備」選單目前的選擇；名稱改成與它不同時回到「自行輸入裝備名稱」
    let preset = RwSignal::new(String::new());
    let shared = move || draft.with(|draft| draft.scope == GearScope::Shared);
    let save = move |event: leptos::ev::SubmitEvent| {
        event.prevent_default();
        if is_new {
            form.save(|_, current| Some(current.add_command()));
        } else {
            form.save(|initial, current| {
                edit_command(gear_patch(initial, current), |patch| Command::UpdateGear {
                    id,
                    patch,
                })
            });
        }
    };
    let remove = move |_| {
        form.submit(Command::RemoveGear { id });
    };
    // 建議只填入草稿的名稱與數量，按「儲存」才新增（需求 27.1、現行 `applyGearPreset()`）
    let choose_preset = move |event: leptos::ev::Event| {
        let value = event_target_value(&event);
        preset.set(value.clone());
        if let Some(item) = personal_gear_preset(&value) {
            draft.update(|draft| {
                draft.name = item.name.to_owned();
                draft.quantity = item.quantity.to_owned();
            });
            form.error.set(None);
        }
    };
    let preset_field = is_new.then(|| {
        view! {
            <label class="field wide">
                <span>"常用露營裝備（選填）"</span>
                <select
                    id="gear-preset"
                    aria-describedby="gear-preset-help"
                    prop:value=move || preset.get()
                    on:change=choose_preset
                >
                    <option value="">"自行輸入裝備名稱"</option>
                    {PERSONAL_GEAR_GROUPS
                        .iter()
                        .map(|group| {
                            view! {
                                <optgroup label=group.label>
                                    {group
                                        .items
                                        .iter()
                                        .map(|item| view! { <option value=item.name>{item.name}</option> })
                                        .collect_view()}
                                </optgroup>
                            }
                        })
                        .collect_view()}
                </select>
            </label>
            <p class="help wide gear-preset-help" id="gear-preset-help">
                "選擇後只填入名稱與建議數量，個人清單請選「每人一份」，共同攜帶則選「公用裝備」；按「儲存」才會加入。"
            </p>
        }
    });
    view! {
        <form id="edit-form" data-kind="gear" novalidate on:submit=save>
            <FormNotices form />
            <FormFields form>
                <h3>{if is_new { "帶上新的小幫手" } else { "編輯裝備" }}</h3>
                <div class="form-grid">
                    <label class="field wide">
                        <span>"類型"</span>
                        <select
                            class="gear-scope-select"
                            on:change=move |event| {
                                let scope = if event_target_value(&event) == "personal" {
                                    GearScope::Personal
                                } else {
                                    GearScope::Shared
                                };
                                draft.update(|draft| draft.scope = scope);
                            }
                        >
                            <option value="personal" selected=current.scope == GearScope::Personal>
                                "每人一份"
                            </option>
                            <option value="shared" selected=current.scope == GearScope::Shared>
                                "公用裝備"
                            </option>
                        </select>
                    </label>
                    {preset_field}
                    <label class="field wide">
                        <span>"裝備名稱"</span>
                        <input
                            type="text"
                            name="name"
                            autocomplete="off"
                            required
                            maxlength="100"
                            prop:value=move || draft.with(|draft| draft.name.clone())
                            on:input=move |event| {
                                let text = event_target_value(&event);
                                if preset.with_untracked(|preset| !preset.is_empty() && *preset != text) {
                                    preset.set(String::new());
                                }
                                draft.update(|draft| draft.name = text);
                            }
                        />
                    </label>
                    <label class="field wide">
                        <span>"數量與單位"</span>
                        <input
                            type="text"
                            name="quantity"
                            autocomplete="off"
                            maxlength="40"
                            prop:value=move || draft.with(|draft| draft.quantity.clone())
                            on:input=move |event| {
                                let text = event_target_value(&event);
                                draft.update(|draft| draft.quantity = text);
                            }
                        />
                    </label>
                    <label class="field wide" data-gear-assignee-field="" hidden=move || !shared()>
                        <span>"公用裝備攜帶人"</span>
                        <select
                            name="assignee"
                            class="assignee-select"
                            data-person-select=""
                            data-person-color=move || {
                                let chosen = draft.with(|draft| draft.assignee);
                                people.with(|people| person_color(people, chosen))
                            }
                            disabled=move || !shared()
                            on:change=move |event| {
                                let chosen = Uuid::parse_str(&event_target_value(&event))
                                    .ok()
                                    .map(PersonId);
                                draft.update(|draft| draft.assignee = chosen);
                            }
                        >
                            <option
                                value=""
                                data-person-color="unassigned"
                                prop:selected=move || draft.with(|draft| draft.assignee.is_none())
                            >
                                {UNASSIGNED}
                            </option>
                            {move || {
                                people
                                    .get()
                                    .into_iter()
                                    .map(|person| {
                                        let id = person.id;
                                        view! {
                                            <option
                                                value=id.to_string()
                                                data-person-color=person.color
                                                prop:selected=move || {
                                                    draft.with(|draft| draft.assignee == Some(id))
                                                }
                                            >
                                                {person.name}
                                            </option>
                                        }
                                    })
                                    .collect_view()
                            }}
                        </select>
                    </label>
                </div>
            </FormFields>
            <FormError form />
            <div class="form-actions">
                {move || {
                    (!is_new && manager.get())
                        .then(|| {
                            view! {
                                <button type="button" class="text-button danger" disabled=move || form.locked() on:click=remove>
                                    "移除項目"
                                </button>
                            }
                        })
                }}
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
