//! 「地點與車」（需求 21.5、21.8、20.8）：地點清單與車輛管理。
//!
//! - 地點依 Ordinal 列出（`RowStore` 的排序鍵）；自己新增、還沒有得到 LM_Server 回應的地點在預測時取目前最大的 Ordinal
//!   加 1，所以排在最後，得到回應之後依 LM_Server 指定的 Ordinal 移動（需求 14.3）。
//! - 每一列有「改名 {地點名稱}」與「刪除 {地點名稱}」；「＋新增地點」與改名開啟同一個只有「地點名稱」的表單（在行內開啟，
//!   改名時預填目前的名稱）。Collaborator 也可以刪除地點（需求 6.11、6.17）。
//! - LM_Core 在送出前拒絕時（需求 21.8）：新增或改名的表單保持開啟並保留名稱，需求 21.1 的原因顯示在「地點名稱」欄位，
//!   其他訊息（例如需求 21.2 的「地點最多 100 個」）顯示在表單的錯誤訊息區；刪除時在那一列下方顯示需求 21.4 的訊息。
//! - 車輛以 `views::vehicle_form` 的清單與表單管理，與 Trip_Menu 的「車輛」是同一份資料（需求 20.8）。
use leptos::prelude::*;
use lm_core::command::{Command, Rejection, DUPLICATE_NAME};
use lm_core::ids::PlaceId;
use lm_core::model::{Entity, RowKey};
use uuid::Uuid;

use crate::art;
use crate::pages::trip::{use_trip, TripContext};
use crate::views::editors::EditorAvatars;
use crate::views::forms::{changed, FormError, FormFields, FormNotices, FormSession, FormTarget};
use crate::views::icons;
use crate::views::vehicle_form::{VehicleList, SCHEDULE_VEHICLE_FORM};

/// 地點的表單（「＋新增地點」與改名共用）。
pub(super) const PLACE_FORM: &str = "place";

/// 地點表單的草稿。
#[derive(Clone, Debug, PartialEq)]
struct PlaceFields {
    id: PlaceId,
    name: String,
}

fn place_slot(id: PlaceId) -> lm_core::model::Slot {
    (Entity::Place, RowKey::Id(id.0))
}

/// 「地點與車」區塊。
#[component]
pub(super) fn PlacesAndCars() -> impl IntoView {
    let TripContext { stores, ui, .. } = use_trip();
    let keys = stores.places.keys();
    let vehicles = stores.vehicles.keys();
    let new_form = move || {
        ui.form_session::<PlaceFields>(PLACE_FORM)
            .filter(|form| form.target == FormTarget::New)
    };
    let add = move |_| {
        let draft = PlaceFields {
            id: PlaceId(Uuid::new_v4()),
            name: String::new(),
        };
        ui.open_form(PLACE_FORM, FormTarget::New, draft);
    };
    view! {
        <section class="vehicle-departures" aria-labelledby="places-cars-title">
            <div class="vehicle-departures-heading">
                <div>
                    <span class="eyebrow">"WHERE WE GO, HOW WE RIDE"</span>
                    <h2 id="places-cars-title">
                        "地點與車 "
                        <span>
                            {move || {
                                format!(
                                    "{} 個地點 · {} 台車",
                                    keys.with(Vec::len),
                                    vehicles.with(Vec::len),
                                )
                            }}
                        </span>
                    </h2>
                </div>
                <button
                    type="button"
                    class="button small"
                    disabled=move || new_form().is_some()
                    on:click=add
                >
                    "＋新增地點"
                </button>
            </div>
            <p class="help">"路線的起點、終點與停靠點從這裡的地點選擇。"</p>
            <h3>"地點"</h3>
            <div class="departure-vehicles">
                <For
                    each=move || keys.get()
                    key=|id| *id
                    children=move |id| view! { <PlaceRow id /> }
                />
                {move || {
                    new_form()
                        .map(|form| {
                            view! {
                                <article class="departure-vehicle wide" aria-label="新增地點">
                                    <PlaceEditor form />
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
                                "還沒有地點。新增地點後，就能安排路線與停靠點。"
                            </div>
                        }
                    })
            }}
            <h3>"車輛"</h3>
            <VehicleList form=SCHEDULE_VEHICLE_FORM class="departure-vehicles" swipe=true />
        </section>
    }
}

/// 地點清單的一列：名稱、「改名」與「刪除」；正在改名時改為顯示表單。刪除被拒絕時在這一列下方顯示訊息。
#[component]
fn PlaceRow(id: PlaceId) -> impl IntoView {
    let TripContext { handle, ui, .. } = use_trip();
    let slot = place_slot(id);
    let name = Memo::new(move |_| {
        handle
            .with_view(|state| state.places.get(&id).map(|place| place.name.clone()))
            .flatten()
    });
    let error = RwSignal::new(None::<String>);
    let editing = move || {
        ui.form_session::<PlaceFields>(PLACE_FORM)
            .filter(|form| form.target == FormTarget::Edit(slot))
    };
    let rename = move |_| {
        error.set(None);
        if let Some(current) = name.get_untracked() {
            ui.open_form(
                PLACE_FORM,
                FormTarget::Edit(slot),
                PlaceFields { id, name: current },
            );
        }
    };
    // 需求 21.8：不送出，訊息顯示在這一列下方；Collaborator 也可以刪除（需求 6.11）
    let remove = move |_| match handle.submit(Command::RemovePlace { id }) {
        Ok(_) => error.set(None),
        Err(rejection) => error.set(Some(rejection.to_string())),
    };
    let row = move || {
        let name = name.get()?;
        Some(view! {
            <div class="departure-vehicle-top">
                <div class="departure-vehicle-name">
                    {art::static_svg(icons::PIN)}
                    <h3>{name.clone()}</h3>
                </div>
                <div class="vehicle-swipe-actions">
                    <EditorAvatars item=slot />
                    <button
                        type="button"
                        class="icon-button"
                        data-row-action="edit"
                        aria-label=format!("改名 {name}")
                        on:click=rename
                    >
                        {art::static_svg(icons::EDIT)}
                    </button>
                    <button
                        type="button"
                        class="icon-button danger"
                        data-row-action="delete"
                        aria-label=format!("刪除 {name}")
                        on:click=remove
                    >
                        {art::static_svg(icons::CLOSE)}
                    </button>
                </div>
            </div>
        })
    };
    view! {
        <article
            class="departure-vehicle"
            class:wide=move || editing().is_some()
            data-swipe-row=move || editing().is_none().then_some("")
        >
            {move || match editing() {
                Some(form) => view! { <PlaceEditor form /> }.into_any(),
                None => row().into_any(),
            }}
            <p class="form-error" role="alert">
                {move || error.get()}
            </p>
        </article>
    }
}

/// 需求 21.1 的拒絕（顯示在「地點名稱」欄位）：名稱是空的、過長、含有控制字元，或同名。
fn is_name_rejection(rejection: &Rejection) -> bool {
    match rejection {
        Rejection::Invalid { field, .. } => field.as_deref() == Some("name"),
        Rejection::Conflict { code, .. } => code == DUPLICATE_NAME,
        _ => false,
    }
}

/// 地點的表單（「＋新增地點」與改名共用），只有「地點名稱」一個欄位。
#[component]
fn PlaceEditor(form: FormSession<PlaceFields>) -> impl IntoView {
    let TripContext { handle, .. } = use_trip();
    let draft = form.draft;
    let current = draft.get_untracked();
    let id = current.id;
    let is_new = form.target == FormTarget::New;
    let field_error = RwSignal::new(None::<String>);
    let error_id = format!("place-name-error-{}", form.serial);
    let save = move |event: leptos::ev::SubmitEvent| {
        event.prevent_default();
        let fields = draft.get_untracked();
        let command = if is_new {
            Some(Command::AddPlace {
                id,
                name: fields.name,
                template: None,
            })
        } else {
            changed(&form.initial().name, &fields.name)
                .map(|name| Command::RenamePlace { id, name })
        };
        let Some(command) = command else {
            form.close();
            return;
        };
        // 需求 21.8：拒絕時不送出，表單保持開啟並保留名稱
        match handle.submit(command) {
            Ok(_) => form.close(),
            Err(rejection) if is_name_rejection(&rejection) => {
                form.error.set(None);
                field_error.set(Some(rejection.to_string()));
            }
            Err(rejection) => {
                field_error.set(None);
                form.error.set(Some(rejection.to_string()));
            }
        }
    };
    view! {
        <form class="route-form" novalidate on:submit=save>
            <FormNotices form />
            <FormFields form>
                <h3>{if is_new { "新增地點" } else { "地點改名" }}</h3>
                <div class="form-grid">
                    <label class="field wide">
                        <span>"地點名稱"</span>
                        <input
                            type="text"
                            autocomplete="off"
                            value=current.name.clone()
                            aria-invalid=move || field_error.with(Option::is_some).then_some("true")
                            aria-describedby=error_id.clone()
                            on:input=move |event| {
                                let text = event_target_value(&event);
                                draft.update(|draft| draft.name = text);
                            }
                        />
                    </label>
                    <p class="form-error wide" id=error_id role="alert">
                        {move || field_error.get()}
                    </p>
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
