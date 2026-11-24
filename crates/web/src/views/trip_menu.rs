//! Trip_Menu「旅行選單」（旅行標題旁的選單與「邀請旅伴」按鈕開啟；`UiState::menu_open` 為真時顯示，需求 32.4）。
//!
//! 沿用 `src/app.js` 的 `tripMenu()`：不是 modal 的抽屜（`.trip-menu`）與背景（`.trip-menu-backdrop`），依序是
//!
//! - 「旅行設定」：`tripDetailsPanel()` 的摘要與「編輯旅行」。表單在行內開啟（`formDialog('trip-settings')` 的欄位，
//!   加上封面與狀態，需求 18.1），儲存時只送出改過的欄位；起訖日期算一個欄位，開始日或結束日改過時兩者一起送出。
//! - 「旅伴」：`memberCards()`，依 Ordinal 列出名字、角色與旅伴代表色，以「我」標示檢視者的 Bound_Person；「編輯旅伴」
//!   只在 Permission_Table 允許檢視者修改的旅伴上，「移除旅伴」只給 Trip_Manager 而且只在沒有綁定 Account 的旅伴上，
//!   「新增旅伴」給每位能開啟這趟旅行的使用者（需求 19.15）。按下「移除旅伴」時先以 LM_Core 檢查（需求 19.13、19.14）：
//!   不能移除時以 Toast 顯示訊息、不開啟對話框；可以移除時開啟「移除這位旅伴？」，按下「確認移除」才送出（需求 19.17）。
//!   清單直接讀 `RowStore`，所以其他分頁的新增、修改與移除不需重新載入就出現（需求 19.18）。
//! - 「車輛」：任務 21.3 的共用車輛清單與表單（`<VehicleList form=MENU_VEHICLE_FORM />`，需求 20.8）。
//! - 「邀請」：沿用 `renderAccountInviteDialog()` 的內容（需求 30.17）：開啟選單時只列出 Active_Invite，不自動建立；
//!   建立成功時顯示完整的邀請網址、到期時間、「複製邀請網址」與「連結只會顯示這一次，請現在複製。」；建立被拒絕時在
//!   「邀請」中顯示訊息；建立或撤銷之後重新列出。
//! - 「刪除旅行」：只給 Trip_Manager（需求 6.17、17.10）。確認對話框沿用 `openDeleteTripDialog()` 的文字；輸入的文字與
//!   目前的旅行名稱逐字相同之前停用「確認刪除旅行」（其他成員在對話框開啟期間改名時以新的名稱為準，需求 32.4）。
//!   成功時以 `TripHandle::leave_trip()` 離開：它只在這趟旅行的 `TripSync` 還在時離開並顯示「這趟旅行已被刪除。」，
//!   所以不論 HTTP 回應與 `trip_deleted` 的 Change_Set 哪一個先到都只顯示一次。失敗時對話框保持開啟，顯示以
//!   「尚未刪除：」開頭的原因；網路錯誤或逾時時顯示「尚未刪除，請檢查網路後再試一次。」（需求 17.10）。
//!
//! 使用者文字一律以文字節點或屬性輸出（需求 32.6）。
use leptos::ev::{self, SubmitEvent};
use leptos::html;
use leptos::prelude::*;
use leptos::task::spawn_local;
use lm_core::api::InviteListItem;
use lm_core::apply::{apply, Ctx, Mode, NoDerivedIds};
use lm_core::command::{Command, DateSpan, Input, PersonPatch, Rejection, TripPatch};
use lm_core::ids::PersonId;
use lm_core::model::{Color, CoverKind, Date, Entity, Person, RowKey, Slot, TripCard, TripStatus};
use lm_core::rules::{packing_progress, Capabilities};
use lm_core::text::trim_js_whitespace;
use uuid::Uuid;
use wasm_bindgen::{JsCast, JsValue};

use crate::api::{use_api, ApiFailure};
use crate::app::use_toasts;
use crate::art::{self, Illustration};
use crate::pages::home::cover_copy;
use crate::pages::trip::{map_link, use_trip, TripContext};
use crate::sync::engine::TripHandle;
use crate::views::editors::EditorAvatars;
use crate::views::forms::{
    changed, edit_command, FormError, FormFields, FormNotices, FormSession, FormTarget,
};
use crate::views::icons;
use crate::views::vehicle_form::{VehicleList, MENU_VEHICLE_FORM};

/// 「編輯旅行」的表單。
const MENU_TRIP_FORM: &str = "menu-trip";
/// 「新增旅伴」與「編輯旅伴」的表單。
const MENU_PERSON_FORM: &str = "menu-person";
/// Trip_Menu 中的表單種類；關閉選單時一起關閉。
const MENU_FORMS: [&str; 3] = [MENU_TRIP_FORM, MENU_PERSON_FORM, MENU_VEHICLE_FORM];

/// 刪除成功（需求 17.10、12.13；與 `trip_deleted` 的訊息相同）。
const TRIP_DELETED: &str = "這趟旅行已被刪除。";
/// 刪除時的網路錯誤或逾時（需求 17.10）。
const DELETE_OFFLINE: &str = "尚未刪除，請檢查網路後再試一次。";
/// 開始或結束日期沒有填，或不是 `YYYY-MM-DD`（與建立旅行的表單相同）。
const DATES_MISSING: &str = "請選擇開始與結束日期。";

/// 旅伴代表色的名稱（現行 `colorChoices`）。
const fn color_label(color: Color) -> &'static str {
    match color {
        Color::Coral => "珊瑚粉",
        Color::Blue => "天空藍",
        Color::Green => "草地綠",
        Color::Yellow => "暖陽黃",
        Color::Lavender => "薰衣草紫",
        Color::Peach => "蜜桃色",
    }
}

/// 旅行狀態的選項（現行 `openTripDialog()`）。
const fn status_option(status: TripStatus) -> &'static str {
    match status {
        TripStatus::Planning => "規劃中（還沒出發）",
        TripStatus::Completed => "已完成（收進回憶）",
    }
}

/// 現行 `avatar()` 的第一個字：去除前後空白後的第一個字元，空的時候為「?」。
fn person_initial(name: &str) -> String {
    trim_js_whitespace(name)
        .chars()
        .next()
        .unwrap_or('?')
        .to_string()
}

/// 現行 `inviteTime()`：`new Date(value).toLocaleString('zh-TW')`。
fn invite_time(value: &str) -> String {
    js_sys::Date::new(&JsValue::from_str(value))
        .to_locale_string("zh-TW", &JsValue::UNDEFINED)
        .into()
}

/// `<input type="date">` 的值：`YYYY-MM-DD`，空的或其他寫法為 `None`。
fn parse_date(value: &str) -> Option<Date> {
    if value.len() != 10 {
        return None;
    }
    Date::parse_from_str(value, "%Y-%m-%d").ok()
}

/// 以 LM_Core 在目前的 Optimistic_View 上檢查一個 Command，不送出（需求 19.17 的移除前檢查）。還沒有畫面時視為成立，
/// 由之後的 `submit()` 回報。
fn check(handle: TripHandle, command: &Command) -> Result<(), Rejection> {
    untrack(|| {
        let viewer = handle.viewer()?;
        let ctx = Ctx {
            actor: viewer.user,
            caps: viewer.caps,
        };
        handle.with_view(|state| {
            apply(state, &ctx, Mode::Predict, &mut NoDerivedIds, command).map(|_| ())
        })
    })
    .unwrap_or(Ok(()))
}

/// 檢視者的權限；在 reactive 範圍中讀取時依 `revision` 重算。
fn caps(ctx: TripContext) -> Capabilities {
    ctx.handle
        .viewer()
        .map_or(Capabilities::NONE, |viewer| viewer.caps)
}

/// 關閉 Trip_Menu：一併關閉選單中開啟的表單，焦點回到旅行選單按鈕（現行 `closeTripMenu()`）。
fn close_menu(ctx: TripContext) {
    let ui = ctx.ui;
    let open = untrack(|| ui.open_form_info());
    if open.is_some_and(|open| MENU_FORMS.contains(&open.kind)) {
        ui.close_any_form();
    }
    ui.menu_open.set(false);
    if let Some(button) = document()
        .query_selector(".trip-menu-button")
        .ok()
        .flatten()
        .and_then(|element| element.dyn_into::<web_sys::HtmlElement>().ok())
    {
        let _ = button.focus();
    }
}

/// Trip_Menu「旅行選單」。以 `pages::trip::use_trip()` 取得這趟旅行的內容。
#[component]
pub fn TripMenu() -> impl IntoView {
    let ctx = use_trip();
    // 旅伴卡片與「移除這位旅伴？」對話框共用
    PersonRemoval::provide();
    let heading = NodeRef::<html::H2>::new();
    // 開啟時焦點移到標題（現行 `openTripMenu()`）
    Effect::new(move |_| {
        if let Some(element) = heading.get() {
            let _ = element.focus();
        }
    });
    // Escape 關閉選單；對話框開著時由對話框處理（現行的 keydown 處理）
    let escape = window_event_listener(ev::keydown, move |event| {
        if event.key() != "Escape" {
            return;
        }
        let dialog_open = document()
            .query_selector("dialog[open]")
            .ok()
            .flatten()
            .is_some();
        if !dialog_open {
            close_menu(ctx);
        }
    });
    on_cleanup(move || escape.remove());
    let manager = Memo::new(move |_| caps(ctx).can_manage);
    let inviter = Memo::new(move |_| caps(ctx).can_invite);
    view! {
        <div class="trip-menu-backdrop" aria-hidden="true" on:click=move |_| close_menu(ctx)></div>
        <aside
            id="trip-menu"
            class="trip-menu"
            role="dialog"
            aria-modal="false"
            aria-labelledby="trip-menu-title"
        >
            <div class="trip-menu-heading">
                <h2 id="trip-menu-title" tabindex="-1" node_ref=heading>
                    "旅行選單"
                </h2>
                <button
                    type="button"
                    class="icon-button"
                    aria-label="關閉旅行選單"
                    on:click=move |_| close_menu(ctx)
                >
                    {art::static_svg(icons::CLOSE)}
                </button>
            </div>
            <TripSettingsSection />
            <PeopleSection />
            <section class="trip-menu-section" aria-labelledby="trip-menu-vehicles">
                <h3 id="trip-menu-vehicles">"車輛"</h3>
                <VehicleList form=MENU_VEHICLE_FORM />
            </section>
            {move || inviter.get().then(|| view! { <InviteSection /> })}
            {move || manager.get().then(|| view! { <DeleteTripSection /> })}
        </aside>
        <RemovePersonDialog />
    }
}

// ── 旅行設定與「編輯旅行」──

/// 「編輯旅行」表單的草稿（日期是欄位中的文字）。
#[derive(Clone, Debug, PartialEq)]
struct CardFields {
    title: String,
    destination: String,
    start: String,
    end: String,
    description: String,
    note: String,
    cover: CoverKind,
    status: TripStatus,
}

impl CardFields {
    fn of(card: &TripCard) -> CardFields {
        CardFields {
            title: card.title.clone(),
            destination: card.destination.clone(),
            start: card.start.to_string(),
            end: card.end.to_string(),
            description: card.description.clone(),
            note: card.note.clone(),
            cover: card.cover,
            status: card.status,
        }
    }
}

/// 只放進改過的欄位（需求 7.8、18.1）。開始日或結束日改過時兩者一起放進 `dates`；改過但其中一個不是有效的日期時，
/// 回傳的第二個值是 `false`，`dates` 不放。
fn card_patch(initial: &CardFields, current: &CardFields) -> (TripPatch, bool) {
    let dates_changed = initial.start != current.start || initial.end != current.end;
    let dates = dates_changed
        .then(|| parse_date(&current.start).zip(parse_date(&current.end)))
        .flatten()
        .map(|(start, end)| DateSpan { start, end });
    let patch = TripPatch {
        title: changed(&initial.title, &current.title),
        destination: changed(&initial.destination, &current.destination),
        dates,
        description: changed(&initial.description, &current.description),
        note: changed(&initial.note, &current.note),
        cover: changed(&initial.cover, &current.cover).map(Input::Ok),
        status: changed(&initial.status, &current.status).map(Input::Ok),
        headline: None,
        caption: None,
    };
    (patch, !dates_changed || dates.is_some())
}

pub(crate) fn card_slot(ctx: TripContext) -> Slot {
    (Entity::Card, RowKey::Id(ctx.trip.0))
}

/// 「旅行設定」（`tripDetailsPanel()` 與「編輯旅行」）。
#[component]
fn TripSettingsSection() -> impl IntoView {
    let ctx = use_trip();
    let TripContext { stores, ui, .. } = ctx;
    let card = stores.card;
    let editing = move || ui.form_session::<CardFields>(MENU_TRIP_FORM);
    let edit = move |_| {
        let draft = card.with_untracked(CardFields::of);
        ui.open_form(MENU_TRIP_FORM, FormTarget::Edit(card_slot(ctx)), draft);
    };
    view! {
        <section class="trip-menu-section" aria-labelledby="trip-menu-trip">
            <h3 id="trip-menu-trip">"旅行設定"</h3>
            {move || match editing() {
                Some(form) => view! { <TripCardEditor form /> }.into_any(),
                None => {
                    view! {
                        <section class="settings-panel">
                            <dl>
                                <dt>"旅行名稱"</dt>
                                <dd>{move || card.with(|card| card.title.clone())}</dd>
                                <dt>"旅行日期"</dt>
                                <dd>
                                    {move || card.with(|card| format!("{} — {}", card.start, card.end))}
                                </dd>
                                <dt>"目的地"</dt>
                                <dd>{move || card.with(|card| map_link(&card.destination))}</dd>
                                <dt>"旅行小叮嚀"</dt>
                                <dd>{move || card.with(|card| card.note.clone())}</dd>
                            </dl>
                        </section>
                        <div>
                            <button type="button" class="button small" on:click=edit>
                                {art::static_svg(icons::EDIT)}
                                "編輯旅行"
                            </button>
                        </div>
                    }
                        .into_any()
                }
            }}
        </section>
    }
}

/// 「編輯旅行」的表單（`formDialog('trip-settings')` 的欄位，加上封面與狀態）。
#[component]
fn TripCardEditor(form: FormSession<CardFields>) -> impl IntoView {
    let handle = use_trip().handle;
    let draft = form.draft;
    let current = draft.get_untracked();
    let text_input = move |set: fn(&mut CardFields, String)| {
        move |event: ev::Event| {
            let text = event_target_value(&event);
            draft.update(|draft| set(draft, text));
        }
    };
    let save = move |event: SubmitEvent| {
        event.prevent_default();
        let (patch, dates_ok) =
            draft.with_untracked(|current| card_patch(&form.initial(), current));
        if !dates_ok {
            // 名稱與目的地排在起訖日期之前檢查（需求 18.2）
            let probe = Command::UpdateTrip {
                patch: patch.clone(),
            };
            let message = match check(handle, &probe) {
                Err(rejection) if matches!(rejection.field(), Some("title" | "destination")) => {
                    rejection.to_string()
                }
                _ => DATES_MISSING.to_owned(),
            };
            form.error.set(Some(message));
            return;
        }
        form.save(move |_, _| edit_command(patch, |patch| Command::UpdateTrip { patch }));
    };
    let covers = CoverKind::ALL
        .iter()
        .map(|&kind| {
            let (label, tone) = cover_copy(kind);
            view! {
                <label class="acct-cover-option">
                    <input
                        class="visually-hidden"
                        type="radio"
                        name="menu-trip-cover"
                        value=kind.as_str()
                        prop:checked=move || draft.with(|draft| draft.cover == kind)
                        on:change=move |_| draft.update(|draft| draft.cover = kind)
                    />
                    <span class="acct-cover-option-content">
                        <span class=format!("acct-cover-preview tone-{tone}")>
                            {art::static_svg(Illustration::for_cover(kind).svg())}
                        </span>
                        <span class="acct-cover-label">{label}</span>
                    </span>
                </label>
            }
        })
        .collect_view();
    let statuses = TripStatus::ALL
        .iter()
        .map(|&status| {
            view! {
                <option value=status.as_str() selected=current.status == status>
                    {status_option(status)}
                </option>
            }
        })
        .collect_view();
    view! {
        <form class="route-form" novalidate on:submit=save>
            <FormNotices form />
            <FormFields form>
                <h3>"把旅行，寫成你喜歡的樣子"</h3>
                <div class="form-grid">
                    <label class="field wide">
                        <span>"旅行名稱"</span>
                        <input
                            type="text"
                            required
                            maxlength="100"
                            value=current.title.clone()
                            on:input=text_input(|draft, text| draft.title = text)
                        />
                    </label>
                    <label class="field wide">
                        <span>"目的地"</span>
                        <input
                            type="text"
                            maxlength="100"
                            value=current.destination.clone()
                            on:input=text_input(|draft, text| draft.destination = text)
                        />
                    </label>
                    <label class="field">
                        <span>"開始日期"</span>
                        <input
                            type="date"
                            required
                            value=current.start.clone()
                            on:input=text_input(|draft, text| draft.start = text)
                        />
                    </label>
                    <label class="field">
                        <span>"結束日期"</span>
                        <input
                            type="date"
                            required
                            value=current.end.clone()
                            on:input=text_input(|draft, text| draft.end = text)
                        />
                    </label>
                    <p class="help wide">
                        "若更改日期，手冊裡的行程與料理會依「第幾天」對應移到新日期。一趟最多 31 天。"
                    </p>
                    <label class="field wide">
                        <span>"旅行介紹"</span>
                        <textarea
                            rows="2"
                            maxlength="1000"
                            prop:value=current.description.clone()
                            on:input=text_input(|draft, text| draft.description = text)
                        ></textarea>
                    </label>
                    <label class="field wide">
                        <span>"旅行小叮嚀"</span>
                        <textarea
                            rows="2"
                            maxlength="1000"
                            prop:value=current.note.clone()
                            on:input=text_input(|draft, text| draft.note = text)
                        ></textarea>
                    </label>
                    <fieldset class="acct-cover-picker wide">
                        <legend>"封面插畫"</legend>
                        <div class="acct-cover-options">{covers}</div>
                    </fieldset>
                    <label class="field wide">
                        <span>"旅行狀態"</span>
                        <select
                            aria-label="旅行狀態"
                            on:change=move |event| {
                                let value = event_target_value(&event);
                                if let Some(status) = TripStatus::parse(&value) {
                                    draft.update(|draft| draft.status = status);
                                }
                            }
                        >
                            {statuses}
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

// ── 旅伴 ──

/// 等待確認移除的旅伴（需求 19.17）；以 context 在旅伴卡片與確認對話框之間共用。
#[derive(Clone, Copy)]
struct PersonRemoval {
    target: RwSignal<Option<PersonId>>,
    error: RwSignal<Option<String>>,
}

impl PersonRemoval {
    /// 在 [`TripMenu`] 之下建立並放進 context。
    fn provide() {
        provide_context(PersonRemoval {
            target: RwSignal::new(None),
            error: RwSignal::new(None),
        });
    }
}

fn use_removal() -> PersonRemoval {
    expect_context::<PersonRemoval>()
}

/// 旅伴表單的草稿。
#[derive(Clone, Debug, PartialEq)]
struct PersonFields {
    id: PersonId,
    name: String,
    role: String,
    color: Color,
}

fn person_slot(id: PersonId) -> Slot {
    (Entity::Person, RowKey::Id(id.0))
}

/// Permission_Table 允許檢視者修改這位旅伴：Trip_Manager 可以修改任何旅伴，Collaborator 只能修改沒有綁定 Account
/// 的旅伴與自己（需求 6.8、19.15）。
fn can_edit_person(caps: &Capabilities, person: &Person) -> bool {
    caps.can_edit && (caps.can_manage || !person.bound || caps.me == Some(person.id))
}

/// 「移除旅伴」只給 Trip_Manager，而且只在沒有綁定 Account 的旅伴上（需求 19.15）。
fn can_remove_person(caps: &Capabilities, person: &Person) -> bool {
    caps.can_manage && !person.bound
}

/// 「旅伴」（`identityNote()`、`memberCards()` 與「新增旅伴」）。
#[component]
fn PeopleSection() -> impl IntoView {
    let ctx = use_trip();
    let TripContext {
        handle, stores, ui, ..
    } = ctx;
    let keys = stores.people.keys();
    let me = Memo::new(move |_| {
        let me = ctx.me()?;
        handle
            .with_view(|state| state.people.get(&me).map(|person| person.name.clone()))
            .flatten()
    });
    let can_add = Memo::new(move |_| caps(ctx).can_edit);
    let new_form = move || {
        ui.form_session::<PersonFields>(MENU_PERSON_FORM)
            .filter(|form| form.target == FormTarget::New)
    };
    let add = move |_| {
        // 新增時代表色預設為新增前的人數除以 6 的餘數（需求 19.8、19.15）
        let count = keys.with_untracked(Vec::len);
        let draft = PersonFields {
            id: PersonId(Uuid::new_v4()),
            name: String::new(),
            role: String::new(),
            color: Color::ALL[count % Color::ALL.len()],
        };
        ui.open_form(MENU_PERSON_FORM, FormTarget::New, draft);
    };
    view! {
        <section class="trip-menu-section" aria-labelledby="trip-menu-people">
            <h3 id="trip-menu-people">"旅伴"</h3>
            {move || {
                me.get()
                    .map(|name| {
                        view! {
                            <div class="identity-note">
                                {art::static_svg(icons::INFO)} "你現在是 " <b>{name}</b>
                            </div>
                        }
                    })
            }}
            <div class="member-grid">
                <For
                    each=move || keys.get()
                    key=|id| *id
                    children=move |id| view! { <MemberCard id /> }
                />
                {move || {
                    new_form()
                        .map(|form| {
                            view! {
                                <article class="member-card" aria-label="新增旅伴">
                                    <PersonEditor form />
                                </article>
                            }
                        })
                }}
            </div>
            {move || {
                can_add
                    .get()
                    .then(|| {
                        view! {
                            <div>
                                <button
                                    type="button"
                                    class="button small"
                                    disabled=move || new_form().is_some()
                                    on:click=add
                                >
                                    {art::static_svg(icons::PLUS)}
                                    "新增旅伴"
                                </button>
                            </div>
                        }
                    })
            }}
        </section>
    }
}

/// 旅伴卡片上顯示的內容。
#[derive(Clone, Debug, PartialEq)]
struct MemberSummary {
    name: String,
    role: String,
    color: Color,
    is_me: bool,
    can_edit: bool,
    can_remove: bool,
    /// 行前準備：(已打包, My_Gear 項數)
    ready: (usize, usize),
}

/// 一位旅伴（沿用 `memberCards()`）；正在編輯時改為顯示表單。
#[component]
fn MemberCard(id: PersonId) -> impl IntoView {
    let ctx = use_trip();
    let TripContext { handle, ui, .. } = ctx;
    let toasts = use_toasts();
    let removal = use_removal();
    let summary = Memo::new(move |_| {
        let caps = caps(ctx);
        handle
            .with_view(|state| {
                let person = state.people.get(&id)?;
                let progress = packing_progress(state, id);
                Some(MemberSummary {
                    name: person.name.clone(),
                    role: person.role.clone(),
                    color: person.color,
                    is_me: caps.me == Some(id),
                    can_edit: can_edit_person(&caps, person),
                    can_remove: can_remove_person(&caps, person),
                    ready: (progress.done, progress.total),
                })
            })
            .flatten()
    });
    let editing = move || {
        ui.form_session::<PersonFields>(MENU_PERSON_FORM)
            .filter(|form| form.target == FormTarget::Edit(person_slot(id)))
    };
    let edit = move |_| {
        let draft = untrack(|| {
            handle
                .with_view(|state| {
                    state.people.get(&id).map(|person| PersonFields {
                        id,
                        name: person.name.clone(),
                        role: person.role.clone(),
                        color: person.color,
                    })
                })
                .flatten()
        });
        if let Some(draft) = draft {
            ui.open_form(MENU_PERSON_FORM, FormTarget::Edit(person_slot(id)), draft);
        }
    };
    // 先以 LM_Core 檢查（綁定帳號、仍有帳目）：不能移除時以 Toast 顯示訊息，不開啟對話框（需求 19.17）
    let remove = move |_| match check(handle, &Command::RemovePerson { id }) {
        Err(rejection) => toasts.show(rejection.to_string()),
        Ok(()) => {
            removal.error.set(None);
            removal.target.set(Some(id));
        }
    };
    let card = move || {
        let summary = summary.get()?;
        let (done, total) = summary.ready;
        Some(view! {
            <span class=format!("avatar {}", summary.color.as_str()) aria-label=summary.name.clone()>
                {person_initial(&summary.name)}
            </span>
            <div>
                <h3>
                    {summary.name.clone()}
                    {summary.is_me.then(|| view! { <span class="tag yellow">"我"</span> })}
                    <EditorAvatars item=person_slot(id) />
                </h3>
                <p>{summary.role.clone()}</p>
                <small>{format!("行前準備 {done} / {total}")}</small>
                {summary
                    .can_edit
                    .then(|| {
                        view! {
                            <button type="button" class="button text-button" on:click=edit>
                                "編輯旅伴"
                            </button>
                        }
                    })}
                {summary
                    .can_remove
                    .then(|| {
                        view! {
                            <button type="button" class="button text-button danger" on:click=remove>
                                "移除旅伴"
                            </button>
                        }
                    })}
            </div>
        })
    };
    view! {
        <article class="member-card">
            {move || match editing() {
                Some(form) => view! { <PersonEditor form /> }.into_any(),
                None => card().into_any(),
            }}
        </article>
    }
}

/// 旅伴表單（現行 `formDialog('person')` 的欄位）：旅伴名字、小隊角色與旅伴代表色。
#[component]
fn PersonEditor(form: FormSession<PersonFields>) -> impl IntoView {
    let draft = form.draft;
    let current = draft.get_untracked();
    let id = current.id;
    let is_new = form.target == FormTarget::New;
    let save = move |event: SubmitEvent| {
        event.prevent_default();
        if is_new {
            // 沒有改過代表色時不指定，由 LM_Core 依新增當下的人數取色（需求 19.8）
            form.save(|initial, current| {
                Some(Command::AddPerson {
                    id,
                    name: current.name.clone(),
                    role: current.role.clone(),
                    color: changed(&initial.color, &current.color),
                })
            });
            return;
        }
        form.save(|initial, current| {
            let patch = PersonPatch {
                name: changed(&initial.name, &current.name),
                role: changed(&initial.role, &current.role),
                color: changed(&initial.color, &current.color),
            };
            edit_command(patch, |patch| Command::UpdatePerson { id, patch })
        });
    };
    let colors = Color::ALL
        .iter()
        .map(|&color| {
            view! {
                <option value=color.as_str() selected=current.color == color>
                    {color_label(color)}
                </option>
            }
        })
        .collect_view();
    view! {
        <form class="route-form" novalidate on:submit=save>
            <FormNotices form />
            <FormFields form>
                <h3>{if is_new { "多一個人，多一份快樂" } else { "編輯旅伴" }}</h3>
                <div class="form-grid">
                    <label class="field wide">
                        <span>"旅伴名字"</span>
                        <input
                            type="text"
                            required
                            maxlength="30"
                            autocomplete="off"
                            value=current.name.clone()
                            on:input=move |event| {
                                let text = event_target_value(&event);
                                draft.update(|draft| draft.name = text);
                            }
                        />
                    </label>
                    <label class="field wide">
                        <span>"小隊角色"</span>
                        <input
                            type="text"
                            maxlength="60"
                            placeholder="例如：早餐擔當"
                            value=current.role.clone()
                            on:input=move |event| {
                                let text = event_target_value(&event);
                                draft.update(|draft| draft.role = text);
                            }
                        />
                    </label>
                    <label class="field wide">
                        <span>"旅伴代表色"</span>
                        <select
                            aria-label="旅伴代表色"
                            on:change=move |event| {
                                let value = event_target_value(&event);
                                if let Some(color) = Color::parse(&value) {
                                    draft.update(|draft| draft.color = color);
                                }
                            }
                        >
                            {colors}
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

/// 「移除這位旅伴？」對話框（需求 19.17）。按下「確認移除」才送出；「取消」或關閉對話框時不送出。旅伴已被移除時關閉。
#[component]
fn RemovePersonDialog() -> impl IntoView {
    let TripContext { handle, .. } = use_trip();
    let removal = use_removal();
    let dialog = NodeRef::<html::Dialog>::new();
    let name = Memo::new(move |_| {
        let id = removal.target.get()?;
        handle
            .with_view(|state| state.people.get(&id).map(|person| person.name.clone()))
            .flatten()
    });
    Effect::new(move |_| {
        let open = name.with(Option::is_some);
        let Some(element) = dialog.get() else {
            return;
        };
        if open && !element.open() {
            let _ = element.show_modal();
        } else if !open && element.open() {
            element.close();
        }
    });
    let close = move || match dialog.get_untracked() {
        Some(element) if element.open() => element.close(),
        _ => removal.target.set(None),
    };
    let confirm = move |_| {
        let Some(id) = removal.target.get_untracked() else {
            return;
        };
        match handle.submit(Command::RemovePerson { id }) {
            Ok(_) => close(),
            Err(rejection) => removal.error.set(Some(rejection.to_string())),
        }
    };
    view! {
        <dialog
            node_ref=dialog
            aria-labelledby="remove-person-title"
            on:close=move |_| {
                removal.target.set(None);
                removal.error.set(None);
            }
        >
            {move || {
                name.get()
                    .map(|name| {
                        view! {
                            <div class="dialog-heading">
                                <h2 id="remove-person-title">"移除這位旅伴？"</h2>
                                <button
                                    type="button"
                                    class="icon-button"
                                    aria-label="關閉視窗"
                                    on:click=move |_| close()
                                >
                                    {art::static_svg(icons::CLOSE)}
                                </button>
                            </div>
                            <div class="dialog-content">
                                <p>
                                    {format!(
                                        "會從這趟旅行移除{name}，並清除車輛、活動、料理、採買與裝備中對這位旅伴的安排；其他旅伴也會看到變更。",
                                    )}
                                </p>
                                <p class="form-error" role="alert">
                                    {move || removal.error.get()}
                                </p>
                                <div class="form-actions">
                                    <button type="button" class="button" on:click=move |_| close()>
                                        "取消"
                                    </button>
                                    <button type="button" class="button danger" on:click=confirm>
                                        "確認移除"
                                    </button>
                                </div>
                            </div>
                        }
                    })
            }}
        </dialog>
    }
}

// ── 邀請 ──

/// 剛建立的邀請連結：只在這個畫面顯示這一次（需求 30.2、30.17）。
#[derive(Clone, Debug, PartialEq)]
struct CreatedInvite {
    id: Uuid,
    /// 目前網頁的 origin 加上 `/invite/<token>`
    url: String,
    expires_at: String,
}

/// 「邀請」（沿用 `renderAccountInviteDialog()`，需求 30.17）。
#[component]
fn InviteSection() -> impl IntoView {
    let TripContext { trip, .. } = use_trip();
    let api = use_api();
    let toasts = use_toasts();
    let invites = RwSignal::new(Vec::<InviteListItem>::new());
    let created = RwSignal::new(None::<CreatedInvite>);
    let error = RwSignal::new(None::<String>);
    let busy = RwSignal::new(false);
    let url_input = NodeRef::<html::Input>::new();
    // 只採用最後一次列出的結果
    let loads = StoredValue::new(0_u64);
    let message = |failure: ApiFailure| (!failure.is_unauthorized()).then_some(failure.message);

    let load = move || async move {
        let serial = loads.get_value() + 1;
        loads.set_value(serial);
        let result = api.invites(trip).await;
        if loads.try_get_value() != Some(serial) {
            return;
        }
        match result {
            Ok(list) => {
                invites.try_set(list);
            }
            Err(failure) => {
                if let Some(text) = message(failure) {
                    toasts.show(text);
                }
            }
        }
    };
    // 開啟時只列出，不自動建立連結
    spawn_local(load());

    // 建立成功時焦點移到邀請網址（現行 `focus='#invite-url'`）
    Effect::new(move |_| {
        if created.with(Option::is_some) {
            if let Some(input) = url_input.get() {
                let _ = input.focus();
            }
        }
    });

    let create = move |_| {
        if busy.get_untracked() {
            return;
        }
        busy.set(true);
        spawn_local(async move {
            match api.create_invite(trip).await {
                Ok(invite) => {
                    let origin = window().location().origin().unwrap_or_default();
                    created.try_set(Some(CreatedInvite {
                        id: invite.id,
                        url: format!("{origin}{}", invite.url_path),
                        expires_at: invite.expires_at,
                    }));
                    error.try_set(None);
                    load().await;
                }
                // 建立被拒絕（例如已有 20 個有效連結）時在「邀請」中顯示訊息
                Err(failure) => {
                    error.try_set(message(failure));
                }
            }
            busy.try_set(false);
        });
    };
    let revoke = move |id: Uuid| {
        if busy.get_untracked() {
            return;
        }
        busy.set(true);
        spawn_local(async move {
            match api.revoke_invite(trip, id).await {
                Ok(()) => {
                    toasts.show("邀請連結已撤銷");
                    if created
                        .try_with_untracked(|shown| shown.as_ref().is_some_and(|c| c.id == id))
                        .unwrap_or(false)
                    {
                        created.try_set(None);
                    }
                }
                Err(failure) => {
                    if let Some(text) = message(failure) {
                        toasts.show(text);
                    }
                }
            }
            // 成功或失敗（例如連結已被使用）之後都重新列出
            load().await;
            busy.try_set(false);
        });
    };
    let copy = move |_| {
        let Some(url) = created.with_untracked(|shown| shown.as_ref().map(|c| c.url.clone()))
        else {
            return;
        };
        spawn_local(async move {
            if write_clipboard(&url).await {
                toasts.show("已複製邀請網址");
            } else {
                if let Some(input) = url_input.get_untracked() {
                    input.select();
                }
                toasts.show("請選取邀請網址後手動複製");
            }
        });
    };

    let link = move || {
        created.get().map(|invite| {
            view! {
                <label class="field">
                    <span>"邀請網址"</span>
                    <input id="invite-url" type="text" readonly value=invite.url node_ref=url_input />
                </label>
                <div class="form-actions">
                    <button type="button" class="button" on:click=copy>
                        "複製邀請網址"
                    </button>
                </div>
                <p>
                    {format!(
                        "這個連結只能讓一位旅伴加入，建立 7 天後失效（有效期限：{}）。沒有帳號的人可以直接在邀請頁建立帳號。",
                        invite_time(&invite.expires_at),
                    )}
                </p>
                <p class="dialog-note">
                    <b>"連結只會顯示這一次，請現在複製。"</b>
                </p>
            }
        })
    };
    let list = move || {
        let items = invites.get();
        if items.is_empty() {
            return view! { <p class="dialog-note">"目前沒有可撤銷的邀請連結。"</p> }.into_any();
        }
        view! {
            <ul class="invite-links">
                {items
                    .into_iter()
                    .map(|invite| {
                        let created_at = invite_time(&invite.created_at);
                        let label = format!(
                            "撤銷 {} 於 {created_at} 建立的連結",
                            invite.creator_name,
                        );
                        let id = invite.id;
                        view! {
                            <li>
                                <span>
                                    <b>{invite.creator_name.clone()}</b>
                                    {format!(
                                        " · 建立於 {created_at} · 到期 {}",
                                        invite_time(&invite.expires_at),
                                    )}
                                </span>
                                <button
                                    type="button"
                                    class="button text-button danger"
                                    aria-label=label
                                    disabled=move || busy.get()
                                    on:click=move |_| revoke(id)
                                >
                                    "撤銷"
                                </button>
                            </li>
                        }
                    })
                    .collect_view()}
            </ul>
        }
        .into_any()
    };
    view! {
        <section class="trip-menu-section" aria-labelledby="trip-menu-invites">
            <h3 id="trip-menu-invites">"邀請"</h3>
            <p>"對方用邀請連結登入或建立帳號後，再自行填寫這趟旅行使用的名字。"</p>
            {link}
            <p class="form-error" role="alert">
                {move || error.get()}
            </p>
            <div class="form-actions">
                <button
                    type="button"
                    class="button primary"
                    disabled=move || busy.get()
                    on:click=create
                >
                    "建立邀請連結"
                </button>
            </div>
            <h3>"尚未使用的邀請連結"</h3>
            {list}
        </section>
    }
}

/// 以 `navigator.clipboard.writeText()` 寫入純文字；瀏覽器不提供剪貼簿或拒絕寫入時回傳 `false`。
#[cfg(target_arch = "wasm32")]
async fn write_clipboard(text: &str) -> bool {
    let navigator = window().navigator();
    // 沒有剪貼簿時 `navigator.clipboard` 是 undefined，不能直接呼叫它的方法
    let clipboard = match js_sys::Reflect::get(&navigator, &"clipboard".into()) {
        Ok(value) if !value.is_undefined() && !value.is_null() => {
            value.unchecked_into::<web_sys::Clipboard>()
        }
        _ => return false,
    };
    wasm_bindgen_futures::JsFuture::from(clipboard.write_text(text))
        .await
        .is_ok()
}

/// 原生目標（只用於 `cargo clippy` 與 `cargo test` 的編譯）沒有剪貼簿。
#[cfg(not(target_arch = "wasm32"))]
async fn write_clipboard(_text: &str) -> bool {
    false
}

// ── 刪除旅行 ──

/// 「刪除旅行」（只給 Trip_Manager）與確認對話框（沿用 `openDeleteTripDialog()`，需求 17.10、32.4）。
#[component]
fn DeleteTripSection() -> impl IntoView {
    let TripContext {
        trip,
        handle,
        stores,
        ..
    } = use_trip();
    let api = use_api();
    let open = RwSignal::new(false);
    let typed = RwSignal::new(String::new());
    let error = RwSignal::new(None::<String>);
    let busy = RwSignal::new(false);
    let dialog = NodeRef::<html::Dialog>::new();
    let input = NodeRef::<html::Input>::new();
    // 目前的旅行名稱：其他成員在對話框開啟期間改名時以新的名稱為準（需求 32.4）
    let title = Memo::new(move |_| stores.card.with(|card| card.title.clone()));
    let matches = move || title.with(|title| typed.with(|typed| typed == title));

    Effect::new(move |_| {
        let Some(element) = dialog.get() else {
            return;
        };
        if open.get() {
            if !element.open() {
                let _ = element.show_modal();
            }
            if let Some(input) = input.get() {
                let _ = input.focus();
            }
        } else if element.open() {
            element.close();
        }
    });
    let start = move |_| {
        typed.set(String::new());
        error.set(None);
        busy.set(false);
        open.set(true);
    };
    let close = move || {
        if !busy.get_untracked() {
            open.set(false);
        }
    };
    let submit = move |event: SubmitEvent| {
        event.prevent_default();
        if busy.get_untracked() {
            return;
        }
        if !matches() {
            error.set(Some("尚未刪除：旅行名稱不一致。".to_owned()));
            return;
        }
        error.set(None);
        busy.set(true);
        spawn_local(async move {
            match api.delete_trip(trip).await {
                // 只在這趟旅行的 TripSync 還在時離開並顯示訊息：`trip_deleted` 的 Change_Set 先到時已離開，這裡什麼都
                // 不做，所以訊息只顯示一次（需求 17.10）
                Ok(()) => handle.leave_trip(TRIP_DELETED),
                Err(failure) => {
                    busy.try_set(false);
                    let message = if failure.is_network() {
                        DELETE_OFFLINE.to_owned()
                    } else {
                        format!("尚未刪除：{}", failure.message)
                    };
                    error.try_set(Some(message));
                }
            }
        });
    };
    view! {
        <div class="reset-area">
            <span>"刪除這趟旅行，所有旅伴的首頁都不再列出它。"</span>
            <button type="button" class="button danger" on:click=start>
                "刪除旅行"
            </button>
        </div>
        <dialog
            node_ref=dialog
            aria-labelledby="delete-trip-title"
            on:cancel=move |event: ev::Event| {
                // 刪除中不關閉
                if busy.get_untracked() {
                    event.prevent_default();
                }
            }
            on:close=move |_| open.set(false)
        >
            {move || {
                open.get()
                    .then(|| {
                        view! {
                            <div class="dialog-heading">
                                <h2 id="delete-trip-title">"刪除旅行"</h2>
                                <button
                                    type="button"
                                    class="icon-button"
                                    aria-label="關閉視窗"
                                    disabled=move || busy.get()
                                    on:click=move |_| close()
                                >
                                    {art::static_svg(icons::CLOSE)}
                                </button>
                            </div>
                            <div class="dialog-content">
                                <div class="acct-delete-explain">
                                    <p>"確定刪除「" <b>{move || title.get()}</b> "」？"</p>
                                    <p>
                                        "這張卡片與整趟旅行將從所有旅伴的首頁移除，原邀請連結也會失效。旅伴帳號不受影響；旅行內容保留於資料庫。"
                                    </p>
                                </div>
                                <form
                                    class="acct-form"
                                    novalidate
                                    aria-busy=move || busy.get().to_string()
                                    on:submit=submit
                                >
                                    <div class="field">
                                        <label for="delete-trip-confirm">"輸入旅行名稱以確認"</label>
                                        <input
                                            id="delete-trip-confirm"
                                            name="delete-trip-confirm"
                                            type="text"
                                            required
                                            autocomplete="off"
                                            spellcheck="false"
                                            maxlength="200"
                                            aria-describedby="delete-trip-confirm-help"
                                            node_ref=input
                                            prop:value=move || typed.get()
                                            on:input=move |event| typed.set(event_target_value(&event))
                                        />
                                        <small class="help" id="delete-trip-confirm-help">
                                            {move || title.get()}
                                        </small>
                                    </div>
                                    <p class="form-error" role="alert">
                                        {move || error.get()}
                                    </p>
                                    <div class="form-actions">
                                        <button
                                            type="button"
                                            class="button quiet"
                                            disabled=move || busy.get()
                                            on:click=move |_| close()
                                        >
                                            "取消"
                                        </button>
                                        <button
                                            type="submit"
                                            class="button danger"
                                            disabled=move || !matches() || busy.get()
                                        >
                                            {move || if busy.get() { "刪除中…" } else { "確認刪除旅行" }}
                                        </button>
                                    </div>
                                </form>
                            </div>
                        }
                    })
            }}
        </dialog>
    }
}
