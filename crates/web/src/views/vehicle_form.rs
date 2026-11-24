//! 車輛清單與共用的車輛表單（需求 20.4、20.8、20.11、6.17）。Schedule_Tab 的「地點與車」與 Trip_Menu 的「車輛」
//! （任務 23.1）編輯同一份車輛資料，兩處都以 [`VehicleList`] 輸出。
//!
//! - 依 Ordinal 列出每台車（沿用 `vehicleCards()`）：名稱、「駕駛 {名字，沒有駕駛時為待分配} · {人數} / {座位數} 人」
//!   （人數是乘客人數，有駕駛時再加 1），以及依旅伴的 Ordinal 排列的乘客名字。車名前的車輛圖示以這台車顯示的顏色為底：
//!   設定了顏色時是它，沒有設定時依位置取 Car_Palette（`vehicle_color()`，需求 20.4），顏色不寫入車輛。
//! - 「編輯 {車名}」與「新增車輛」開啟同一個表單（沿用 `formDialog('vehicle')` 的欄位，在行內開啟）：新增時座位數為 4、
//!   駕駛為檢視者的 Bound_Person（沒有時為待分配）、沒有乘客；編輯時只送出改過的欄位，乘客只送出加入與移除的旅伴
//!   （需求 7.8）。儲存前先從勾選的乘客中去掉選定的駕駛（需求 20.11）。
//! - 只有 Trip_Manager 看得到「移除 {車名}」與表單中的「移除項目」（需求 6.17、20.8）；仍有路線或被活動指定時，LM_Core
//!   的拒絕以 Toast（列上的按鈕）或表單的錯誤訊息區（表單中的按鈕）顯示。
//!
//! 同一時間最多一個表單（`views::forms`）；兩處同時顯示時（行程表上開著 Trip_Menu），以不同的表單種類
//! （[`SCHEDULE_VEHICLE_FORM`]、[`MENU_VEHICLE_FORM`]）區分表單出現在哪一處。Trip_Menu 以
//! `<VehicleList form=MENU_VEHICLE_FORM />` 使用；也可以用 [`open_new_vehicle`]、[`open_vehicle`] 自行開啟表單，再以
//! [`VehicleEditor`] 輸出。
use std::collections::BTreeSet;

use leptos::prelude::*;
use lm_core::command::{Command, Input, VehicleDraft, VehiclePatch};
use lm_core::ids::{PersonId, VehicleId};
use lm_core::itinerary::vehicle_color;
use lm_core::model::{Entity, RowKey, TripState, Vehicle};
use uuid::Uuid;

use crate::art;
use crate::pages::trip::{use_trip, TripContext};
use crate::views::editors::EditorAvatars;
use crate::views::forms::{
    changed, edit_command, set_delta, FormError, FormFields, FormNotices, FormSession, FormTarget,
};
use crate::views::icons;

/// Schedule_Tab「地點與車」中的車輛表單。
pub const SCHEDULE_VEHICLE_FORM: &str = "schedule-vehicle";
/// Trip_Menu「車輛」中的車輛表單（任務 23.1）。
#[allow(dead_code)]
pub const MENU_VEHICLE_FORM: &str = "menu-vehicle";
/// 沒有駕駛時的顯示（需求 20.8）。
const NO_DRIVER: &str = "待分配";
/// 新增車輛的預設座位數（需求 20.8）。
const DEFAULT_SEATS: &str = "4";
/// 座位數沒有填寫（需求 20.1 的第一條訊息）。修改車輛的 Command 無法表示「沒有填寫」，所以在送出前檢查。
const REQUIRED: &str = "請填寫必要欄位，不能只有空白。";

/// 車輛表單的草稿。座位數是欄位中的文字；乘客是勾選的旅伴，可能包含選定的駕駛（儲存時去掉，需求 20.11）。
#[derive(Clone, Debug, PartialEq)]
pub struct VehicleFields {
    pub id: VehicleId,
    pub name: String,
    pub driver: Option<PersonId>,
    pub seats: String,
    pub passengers: BTreeSet<PersonId>,
}

impl VehicleFields {
    /// 新增車輛（需求 20.8）：以隨機的 UUID 為 id（需求 7.18），座位數 4，駕駛為檢視者的 Bound_Person（沒有時為待分配），
    /// 沒有乘客。
    pub fn new(me: Option<PersonId>) -> VehicleFields {
        VehicleFields {
            id: VehicleId(Uuid::new_v4()),
            name: String::new(),
            driver: me,
            seats: DEFAULT_SEATS.to_owned(),
            passengers: BTreeSet::new(),
        }
    }

    /// 編輯既有的車輛：表單一開始的內容。
    pub fn of(vehicle: &Vehicle) -> VehicleFields {
        VehicleFields {
            id: vehicle.id,
            name: vehicle.name.clone(),
            driver: vehicle.driver,
            seats: vehicle.seats.to_string(),
            passengers: vehicle.passengers.clone(),
        }
    }

    /// 儲存的乘客：勾選的旅伴去掉選定的駕駛（需求 20.11）。
    fn saved_passengers(&self) -> BTreeSet<PersonId> {
        let mut passengers = self.passengers.clone();
        if let Some(driver) = self.driver {
            passengers.remove(&driver);
        }
        passengers
    }

    /// 座位數欄位是空的（只有空白）。
    fn seats_blank(&self) -> bool {
        self.seats.trim().is_empty()
    }

    /// 座位數的輸入：沒有填寫是 `None`；整數是 `Ok`；其他文字原樣送出，由 LM_Core 以需求 20.1 的訊息拒絕。
    fn seats_input(&self) -> Option<Input<u8>> {
        let text = self.seats.trim();
        if text.is_empty() {
            return None;
        }
        Some(match text.parse::<u8>() {
            Ok(seats) => Input::Ok(seats),
            Err(_) => Input::Bad(serde_json::Value::String(text.to_owned())),
        })
    }

    /// 新增車輛的 Command；沒有設定顏色，依位置取 Car_Palette 顯示（需求 20.4）。
    fn add_command(&self) -> Command {
        Command::AddVehicle {
            id: self.id,
            draft: VehicleDraft {
                name: self.name.clone(),
                driver: self.driver,
                seats: self.seats_input(),
                color: None,
                passengers: self.saved_passengers(),
            },
        }
    }
}

/// 只放進改過的欄位；乘客只放加入與移除的旅伴，以去掉駕駛之後的乘客比較（需求 7.8、20.11）。座位數沒有填寫時由
/// [`VehicleEditor`] 在送出前拒絕。
fn vehicle_patch(initial: &VehicleFields, current: &VehicleFields) -> VehiclePatch {
    let (passengers_add, passengers_remove) =
        set_delta(&initial.saved_passengers(), &current.saved_passengers());
    VehiclePatch {
        name: changed(&initial.name, &current.name),
        driver: changed(&initial.driver, &current.driver),
        seats: changed(&initial.seats, &current.seats).and_then(|_| current.seats_input()),
        color: None,
        passengers_add,
        passengers_remove,
    }
}

/// 開啟新增車輛的表單（`kind` 是 [`SCHEDULE_VEHICLE_FORM`] 或 [`MENU_VEHICLE_FORM`]）。
pub fn open_new_vehicle(ctx: TripContext, kind: &'static str) -> FormSession<VehicleFields> {
    let me = untrack(|| ctx.me());
    ctx.ui
        .open_form(kind, FormTarget::New, VehicleFields::new(me))
}

/// 開啟編輯這台車的表單；車輛已不在 Optimistic_View 中時是 `None`。
pub fn open_vehicle(
    ctx: TripContext,
    kind: &'static str,
    id: VehicleId,
) -> Option<FormSession<VehicleFields>> {
    let draft = untrack(|| {
        ctx.handle
            .with_view(|state| state.vehicles.get(&id).map(VehicleFields::of))
            .flatten()
    })?;
    Some(
        ctx.ui
            .open_form(kind, FormTarget::Edit(vehicle_slot(id)), draft),
    )
}

fn vehicle_slot(id: VehicleId) -> lm_core::model::Slot {
    (Entity::Vehicle, RowKey::Id(id.0))
}

/// 檢視者是 Trip_Manager（看得到車輛的移除，需求 6.17、20.8）；在 reactive 範圍中讀取時依 `revision` 重算。
fn can_manage(ctx: TripContext) -> bool {
    ctx.handle
        .viewer()
        .is_some_and(|viewer| viewer.caps.can_manage)
}

/// 依 Ordinal 列出車輛、開在行內的車輛表單與「新增車輛」。`form` 是這一處的表單種類；`class` 是車輛清單外框的
/// class（Trip_Menu 為 `vehicles`，行程表為 `departure-vehicles`）。`swipe` 為真時（行程表）車輛卡片是
/// Schedule_Row：不在編輯時帶 `data-swipe-row`，編輯與移除按鈕帶 `data-row-action`；Trip_Menu 不帶。
#[component]
pub fn VehicleList(
    form: &'static str,
    #[prop(default = "vehicles")] class: &'static str,
    #[prop(optional)] swipe: bool,
) -> impl IntoView {
    let ctx = use_trip();
    let TripContext { stores, ui, .. } = ctx;
    let keys = stores.vehicles.keys();
    let new_form = move || {
        ui.form_session::<VehicleFields>(form)
            .filter(|session| session.target == FormTarget::New)
    };
    let add = move |_| {
        open_new_vehicle(ctx, form);
    };
    view! {
        <div class=class>
            <For
                each=move || keys.get()
                key=|id| *id
                children=move |id| view! { <VehicleCard id form swipe /> }
            />
            {move || {
                new_form()
                    .map(|session| {
                        view! {
                            <article class="vehicle-card" aria-label="新增車輛">
                                <VehicleEditor form=session />
                            </article>
                        }
                    })
            }}
        </div>
        {move || {
            (keys.with(Vec::is_empty) && new_form().is_none())
                .then(|| view! { <div class="departure-vehicles-empty">"還沒有車輛。"</div> })
        }}
        <div>
            <button
                type="button"
                class="button small"
                disabled=move || new_form().is_some()
                on:click=add
            >
                {art::static_svg(icons::PLUS)}
                "新增車輛"
            </button>
        </div>
    }
}

/// 車輛卡片上顯示的內容。
#[derive(Clone, Debug, PartialEq)]
struct VehicleSummary {
    name: String,
    color: Option<String>,
    driver: String,
    /// 乘客人數，有駕駛時再加 1
    riders: usize,
    seats: u8,
    /// 依旅伴的 Ordinal
    passengers: Vec<String>,
}

fn vehicle_summary(state: &TripState, id: VehicleId) -> Option<VehicleSummary> {
    let vehicle = state.vehicles.get(&id)?;
    let driver = vehicle
        .driver
        .and_then(|driver| state.people.get(&driver))
        .map_or_else(|| NO_DRIVER.to_owned(), |person| person.name.clone());
    Some(VehicleSummary {
        name: vehicle.name.clone(),
        color: vehicle_color(state, id).map(str::to_owned),
        driver,
        riders: vehicle.passengers.len() + usize::from(vehicle.driver.is_some()),
        seats: vehicle.seats,
        passengers: state
            .people_by_ordinal()
            .filter(|person| vehicle.passengers.contains(&person.id))
            .map(|person| person.name.clone())
            .collect(),
    })
}

/// 一台車（沿用 `vehicleCards()`）；正在編輯時改為顯示表單。
#[component]
fn VehicleCard(id: VehicleId, form: &'static str, swipe: bool) -> impl IntoView {
    let ctx = use_trip();
    let TripContext { handle, ui, .. } = ctx;
    let summary = Memo::new(move |_| {
        handle
            .with_view(|state| vehicle_summary(state, id))
            .flatten()
    });
    let manager = Memo::new(move |_| can_manage(ctx));
    let editing = move || {
        ui.form_session::<VehicleFields>(form)
            .filter(|session| session.target == FormTarget::Edit(vehicle_slot(id)))
    };
    let edit = move |_| {
        open_vehicle(ctx, form, id);
    };
    let remove = move |_| {
        handle.submit_or_toast(Command::RemoveVehicle { id });
    };
    let card = move || {
        let summary = summary.get()?;
        let name = summary.name.clone();
        let style = summary
            .color
            .as_ref()
            .map(|color| format!("--assignee-color:{color}"));
        Some(view! {
            <div class="vehicle-title">
                <div class="departure-vehicle-name" style=style>
                    {art::static_svg(icons::CAR)}
                    <h3>{name.clone()}</h3>
                </div>
                <EditorAvatars item=vehicle_slot(id) />
                <button
                    type="button"
                    class="icon-button"
                    aria-label=format!("編輯 {name}")
                    data-row-action=swipe.then_some("edit")
                    on:click=edit
                >
                    {art::static_svg(icons::EDIT)}
                </button>
                {move || {
                    let name = name.clone();
                    manager
                        .get()
                        .then(|| {
                            view! {
                                <button
                                    type="button"
                                    class="icon-button danger"
                                    aria-label=format!("移除 {name}")
                                    data-row-action=swipe.then_some("delete")
                                    on:click=remove
                                >
                                    {art::static_svg(icons::CLOSE)}
                                </button>
                            }
                        })
                }}
            </div>
            <p>
                {format!("駕駛 {} ", summary.driver)}
                <span>"·"</span>
                {format!(" {} / {} 人", summary.riders, summary.seats)}
            </p>
            <div class="passenger-list">
                {summary
                    .passengers
                    .iter()
                    .map(|name| view! { <span>{name.clone()}</span> })
                    .collect_view()}
            </div>
        })
    };
    view! {
        <article
            class="vehicle-card"
            data-swipe-row=move || (swipe && editing().is_none()).then_some("")
        >
            {move || match editing() {
                Some(session) => view! { <VehicleEditor form=session /> }.into_any(),
                None => card().into_any(),
            }}
        </article>
    }
}

/// 車輛表單（沿用 `formDialog('vehicle')` 的欄位）：車輛暱稱、駕駛、座位數（含駕駛）與乘客。
#[component]
pub fn VehicleEditor(form: FormSession<VehicleFields>) -> impl IntoView {
    let ctx = use_trip();
    let handle = ctx.handle;
    let draft = form.draft;
    let current = draft.get_untracked();
    let id = current.id;
    let is_new = form.target == FormTarget::New;
    let manager = Memo::new(move |_| can_manage(ctx));
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
    let save = move |event: leptos::ev::SubmitEvent| {
        event.prevent_default();
        if is_new {
            form.save(|_, current| Some(current.add_command()));
            return;
        }
        // 修改的 Command 無法表示「座位數沒有填寫」：與 LM_Core 的第一條檢查相同的訊息（需求 20.1）
        if draft.with_untracked(VehicleFields::seats_blank) {
            form.error.set(Some(REQUIRED.to_owned()));
            return;
        }
        form.save(|initial, current| {
            edit_command(vehicle_patch(initial, current), |patch| {
                Command::UpdateVehicle { id, patch }
            })
        });
    };
    let remove = move |_| {
        form.submit(Command::RemoveVehicle { id });
    };
    view! {
        <form class="route-form" novalidate on:submit=save>
            <FormNotices form />
            <FormFields form>
                <h3>{if is_new { "新增一台出發的車" } else { "編輯這台車" }}</h3>
                <div class="form-grid">
                    <label class="field wide">
                        <span>"車輛暱稱"</span>
                        <input
                            type="text"
                            autocomplete="off"
                            value=current.name.clone()
                            on:input=move |event| {
                                let text = event_target_value(&event);
                                draft.update(|draft| draft.name = text);
                            }
                        />
                    </label>
                    <label class="field">
                        <span>"駕駛"</span>
                        {move || {
                            let chosen = draft.with_untracked(|draft| draft.driver);
                            view! {
                                <select
                                    aria-label="駕駛"
                                    on:change=move |event| {
                                        let value = event_target_value(&event);
                                        let driver = Uuid::parse_str(&value).ok().map(PersonId);
                                        draft.update(|draft| draft.driver = driver);
                                    }
                                >
                                    <option value="" selected=chosen.is_none()>
                                        {NO_DRIVER}
                                    </option>
                                    {people
                                        .get()
                                        .into_iter()
                                        .map(|(person, name)| {
                                            view! {
                                                <option
                                                    value=person.to_string()
                                                    selected=chosen == Some(person)
                                                >
                                                    {name}
                                                </option>
                                            }
                                        })
                                        .collect_view()}
                                </select>
                            }
                        }}
                    </label>
                    <label class="field">
                        <span>"座位數（含駕駛）"</span>
                        <input
                            type="number"
                            min="1"
                            max="9"
                            inputmode="numeric"
                            value=current.seats.clone()
                            on:input=move |event| {
                                let text = event_target_value(&event);
                                draft.update(|draft| draft.seats = text);
                            }
                        />
                    </label>
                    <p class="help wide">"每天的出發時間與地點，請在規劃行程的路線填寫。"</p>
                    <fieldset class="wide">
                        <legend>"乘客（請勿重複選駕駛）"</legend>
                        <div class="passenger-checks">
                            {move || {
                                people
                                    .get()
                                    .into_iter()
                                    .map(|(person, name)| {
                                        let checked = draft
                                            .with_untracked(|draft| draft.passengers.contains(&person));
                                        view! {
                                            <label>
                                                <input
                                                    type="checkbox"
                                                    value=person.to_string()
                                                    checked=checked
                                                    on:change=move |event| {
                                                        let on = event_target_checked(&event);
                                                        draft
                                                            .update(|draft| {
                                                                if on {
                                                                    draft.passengers.insert(person);
                                                                } else {
                                                                    draft.passengers.remove(&person);
                                                                }
                                                            });
                                                    }
                                                />
                                                {name}
                                            </label>
                                        }
                                    })
                                    .collect_view()
                            }}
                        </div>
                    </fieldset>
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
