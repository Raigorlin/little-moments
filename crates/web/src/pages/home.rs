//! Home_Page（`/<帳號名稱>/home`）：旅行列表與「新增旅行」（需求 17.1、17.2、17.9）。
//!
//! 沿用 `src/accounts-ui.js` 的 `renderHome()`、`tripCard()`、`coverPicker()` 與 `openTripDialog()` 的結構與 class
//! （`.acct-hero`、`.acct-trip-list`、`.acct-trip-section`、`.acct-trip-card`、`.acct-cover-picker`、`.acct-form`），
//! 以重用現行的樣式。
//!
//! - 列表：`GET /api/trips` 依建立時間由晚到早回傳（LM_Server 的排序）；規劃中的旅行依開始日期由早到晚、已完成的旅行
//!   依開始日期由晚到早排列，都是穩定排序，所以開始日期相同時建立較晚的在前（需求 17.1）。
//! - 「新增旅行」：開啟表單時產生旅行 id，同一個表單的每次送出都使用它（需求 17.9），所以前一次逾時其實已建立時，
//!   再次送出得到同一趟旅行（需求 17.4）。送出前以 LM_Core 的 `new_trip_card()` 與 `creator_name()` 依需求 17.5
//!   檢查，不通過時不送出。
//!
//! 使用者文字（旅行名稱、目的地、顯示名稱）一律以文字節點或屬性輸出；只有插畫與介面圖示以 `art::static_svg()`
//! 放進畫面（需求 32.6）。
use leptos::ev::{self, MouseEvent, SubmitEvent};
use leptos::prelude::*;
use leptos::task::spawn_local;
use lm_core::api::{CreateTripRequest, TripSummary};
use lm_core::apply::{creator_name, new_trip_card};
use lm_core::command::{Input, TripDraft};
use lm_core::ids::TripId;
use lm_core::model::{CoverKind, Date, TripStatus};
use lm_core::time::{parse_date as parse_iso_date, weekday_char};
use uuid::Uuid;
use wasm_bindgen::{JsCast, JsValue};

use crate::api::use_api;
use crate::app::{trip_path, use_toasts, Shell};
use crate::art::{self, Illustration};
use crate::session::use_auth;

/// 開始或結束日期沒有填，或不是 `YYYY-MM-DD`（現行 `validateTripCard()`）。
const DATES_MISSING: &str = "請選擇開始與結束日期。";
/// LM_Core 對含有 U+0000 的旅行資料的訊息（需求 17.5）；它排在日期之後檢查。
const UNSTORABLE_TRIP: &str = "旅行資料含有不允許的字元。";
/// 網路錯誤或逾時（需求 17.9）。
const NOT_SAVED: &str = "尚未儲存，請檢查網路後再試一次。";
/// 表單有修改時關閉的確認（現行 `requestClose()`）。
const DISCARD_CONFIRM: &str = "表單裡還有尚未儲存的內容，確定要關閉並放棄嗎？";
/// 建立成功的 Toast（需求 17.9）。
const CREATED: &str = "旅行已建立";

/// 介面圖示（現行 `icon()`）：固定的 SVG，不含使用者文字。
macro_rules! icon {
    ($paths:literal) => {
        concat!(
            r#"<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">"#,
            $paths,
            "</svg>"
        )
    };
}
pub(crate) const ICON_PIN: &str = icon!(
    r#"<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>"#
);
pub(crate) const ICON_CALENDAR: &str =
    icon!(r#"<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18"/>"#);
pub(crate) const ICON_PEOPLE: &str = icon!(
    r#"<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m1-15a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2"/>"#
);
const ICON_BOOK: &str =
    icon!(r#"<path d="M12 6C8 3 4 4 2 5v15c3-1 7-1 10 1 3-2 7-2 10-1V5c-3-1-7-1-10 1Zm0 0v15"/>"#);
const ICON_PLUS: &str = icon!(r#"<path d="M12 5v14M5 12h14"/>"#);
const ICON_CLOSE: &str = icon!(r#"<path d="m6 6 12 12M6 18 18 6"/>"#);
const ICON_TENT: &str = icon!(r#"<path d="m3 20 9-16 9 16H3Zm5 0 4-8 4 8"/>"#);
const ICON_ARROW: &str = icon!(r#"<path d="M4 12h15m-6-6 6 6-6 6"/>"#);

/// 封面選擇的名稱與底色（現行 `COVERS`），依 `CoverKind::ALL` 的順序。Trip_Menu 的「編輯旅行」也使用。
pub(crate) const fn cover_copy(cover: CoverKind) -> (&'static str, &'static str) {
    match cover {
        CoverKind::Camp => ("營地帳篷", "green"),
        CoverKind::Mountain => ("山間旅途", "peach"),
        CoverKind::Lake => ("湖畔水岸", "blue"),
        CoverKind::Night => ("星空夜晚", "night"),
        CoverKind::Forest => ("森林小屋", "green"),
        CoverKind::Beach => ("海邊假期", "blue"),
        CoverKind::Sunrise => ("日出山嵐", "peach"),
    }
}

const fn status_label(status: TripStatus) -> &'static str {
    match status {
        TripStatus::Planning => "規劃中",
        TripStatus::Completed => "已完成",
    }
}

/// 現行 `fullDate()`：`toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })`，
/// 例如 2026-10-20 為「2026年10月20日 週二」。
pub fn full_date(date: Date) -> String {
    format!(
        "{:04}年{}月{}日 週{}",
        date.year(),
        u8::from(date.month()),
        date.day(),
        weekday_char(date)
    )
}

/// 現行 `dateSpan()`：開始日等於結束日時只有一個日期，否則以「 – 」連接（需求 17.1）。
pub fn date_span(start: Date, end: Date) -> String {
    if start == end {
        full_date(start)
    } else {
        format!("{} – {}", full_date(start), full_date(end))
    }
}

/// 依狀態分成規劃中與已完成兩組並排序（需求 17.1）。`trips` 依建立時間由晚到早，排序是穩定的，所以開始日期相同時
/// 建立較晚的在前。
fn split_trips(trips: Vec<TripSummary>) -> (Vec<TripSummary>, Vec<TripSummary>) {
    let (mut completed, mut planning): (Vec<_>, Vec<_>) = trips
        .into_iter()
        .partition(|trip| trip.status == TripStatus::Completed);
    planning.sort_by_key(|trip| trip.start);
    completed.sort_by_key(|trip| std::cmp::Reverse(trip.start));
    (planning, completed)
}

/// `<input type="date">` 的值：`YYYY-MM-DD`，空的或其他寫法為 `None`。
fn parse_date(value: &str) -> Option<Date> {
    if value.len() != 10 {
        return None;
    }
    parse_iso_date(value)
}

/// 表單中填寫的內容（尚未修剪）。
struct TripFields {
    title: String,
    destination: String,
    start: String,
    end: String,
    description: String,
    note: String,
    cover: CoverKind,
}

/// 送出前的檢查（需求 17.9）：依現行 `validateTripCard()` 的順序（名稱、目的地、起訖日期、介紹與小叮嚀、U+0000、
/// 封面），再檢查建立者的 Display_Name（需求 17.5）。通過時回傳以修剪後的文字組成的請求，否則回傳第一個不通過的訊息。
fn build_request(
    id: TripId,
    fields: &TripFields,
    display_name: &str,
) -> Result<CreateTripRequest, String> {
    let dates = parse_date(&fields.start).zip(parse_date(&fields.end));
    // 日期沒有填時先以一個有效的日期檢查名稱與目的地：它們排在日期之前
    let (start, end) = dates.unwrap_or((Date::MIN, Date::MIN));
    let draft = TripDraft {
        title: fields.title.clone(),
        destination: fields.destination.clone(),
        start,
        end,
        description: fields.description.clone(),
        note: fields.note.clone(),
        cover: Input::Ok(fields.cover),
    };
    let card = match (new_trip_card(id, &draft), dates) {
        (Err(rejection), Some(_)) => return Err(rejection.message().to_owned()),
        (Err(rejection), None)
            if matches!(rejection.field(), Some("title" | "destination"))
                && rejection.message() != UNSTORABLE_TRIP =>
        {
            return Err(rejection.message().to_owned());
        }
        (_, None) => return Err(DATES_MISSING.to_owned()),
        (Ok(card), Some(_)) => card,
    };
    creator_name(display_name).map_err(|rejection| rejection.message().to_owned())?;
    Ok(CreateTripRequest {
        id,
        title: card.title,
        start: card.start,
        end: card.end,
        destination: card.destination,
        description: card.description,
        note: card.note,
        cover: Input::Ok(card.cover),
    })
}

/// 這個瀏覽器的 `<dialog>` 是否支援 `closedby`：支援時點選背景經 `cancel` 事件關閉，不需要另外處理點選。
fn supports_closed_by() -> bool {
    js_sys::Reflect::get(&window(), &JsValue::from_str("HTMLDialogElement"))
        .ok()
        .and_then(|class| js_sys::Reflect::get(&class, &JsValue::from_str("prototype")).ok())
        .is_some_and(|prototype| {
            js_sys::Reflect::has(&prototype, &JsValue::from_str("closedBy")).unwrap_or(false)
        })
}

/// 旅行列表的狀態。
#[derive(Clone, Debug, PartialEq)]
enum TripList {
    Loading,
    Ready(Vec<TripSummary>),
    Failed(String),
}

/// 自己的 Home_Page（App 外框已確認有 Session，而且網址中的帳號名稱是自己的）。
#[component]
pub fn HomePage() -> impl IntoView {
    let api = use_api();
    let toasts = use_toasts();
    let user = use_auth().user();
    let display_name = move || {
        user.with(|user| {
            user.as_ref()
                .map(|user| user.display_name.clone())
                .unwrap_or_default()
        })
    };
    let username = move || {
        user.with(|user| {
            user.as_ref()
                .map(|user| user.username.clone())
                .unwrap_or_default()
        })
    };
    document().set_title(&format!(
        "{} 的旅行 · 日子拾光",
        user.with_untracked(|user| user
            .as_ref()
            .map(|user| user.display_name.clone())
            .unwrap_or_default())
    ));

    // 旅行列表；重新讀取時只採用最後一次請求的結果
    let trips = RwSignal::new(TripList::Loading);
    let loads = StoredValue::new(0_u64);
    let load = move || {
        let id = loads.get_value() + 1;
        loads.set_value(id);
        spawn_local(async move {
            let result = api.trips().await;
            if loads.try_get_value() != Some(id) {
                return;
            }
            match result {
                Ok(list) => trips.set(TripList::Ready(list)),
                // Session 已失效：登入狀態依需求 4.9 前往 /login
                Err(failure) if failure.is_unauthorized() => {}
                Err(failure) => trips.set(TripList::Failed(failure.message)),
            }
        });
    };
    load();
    let retry = move |_: MouseEvent| {
        trips.set(TripList::Loading);
        load();
    };

    // 「新增旅行」的對話框：每次開啟建立新的表單（新的旅行 id 與空白的欄位）
    let open = RwSignal::new(false);
    let dirty = RwSignal::new(false);
    let busy = RwSignal::new(false);
    let dialog_ref = NodeRef::<leptos::html::Dialog>::new();
    Effect::new(move |_| {
        if !open.get() {
            return;
        }
        let Some(dialog) = dialog_ref.get() else {
            return;
        };
        if !dialog.open() {
            let _ = dialog.show_modal();
        }
        if let Some(first) = dialog
            .query_selector("#trip-title")
            .ok()
            .flatten()
            .and_then(|element| element.dyn_into::<web_sys::HtmlElement>().ok())
        {
            let _ = first.focus();
        }
    });
    let close_dialog = move || {
        dirty.set(false);
        busy.set(false);
        open.set(false);
        if let Some(dialog) = dialog_ref.get_untracked() {
            if dialog.open() {
                dialog.close();
            }
        }
    };
    let request_close = move || {
        if busy.get_untracked() {
            return;
        }
        if dirty.get_untracked()
            && !window()
                .confirm_with_message(DISCARD_CONFIRM)
                .unwrap_or(false)
        {
            return;
        }
        close_dialog();
    };
    let open_dialog = move |_: MouseEvent| {
        dirty.set(false);
        busy.set(false);
        open.set(true);
    };
    let on_created = move |_: TripId| {
        close_dialog();
        toasts.show(CREATED);
        load();
    };
    // 表單有修改或正在送出時，離開頁面前請瀏覽器確認
    let unload = window_event_listener(ev::beforeunload, move |event| {
        if open.get_untracked() && (dirty.get_untracked() || busy.get_untracked()) {
            event.prevent_default();
        }
    });
    on_cleanup(move || unload.remove());
    let closed_by = supports_closed_by();

    let list = move || {
        match trips.get() {
        TripList::Loading => view! {
            <p class="acct-loading" role="status">
                "正在載入你的旅行…"
            </p>
        }
        .into_any(),
        TripList::Failed(message) => view! {
            <div class="acct-error" role="alert">
                <p>{message}</p>
                <div class="acct-actions">
                    <button type="button" class="button small" on:click=retry>
                        "重新整理"
                    </button>
                </div>
            </div>
        }
        .into_any(),
        TripList::Ready(list) if list.is_empty() => view! {
            <div class="empty acct-empty">
                {art::static_svg(ICON_TENT)} <h3>"還沒有任何旅行"</h3>
                <p>
                    "按「新增旅行」建立第一趟。已經去過的旅行也可以補記，之後在旅行選單的「編輯旅行」把狀態改成「已完成」，就會收進回憶區。這裡不會自動放入範例旅行。"
                </p>
            </div>
        }
        .into_any(),
        TripList::Ready(list) => {
            let (planning, completed) = split_trips(list);
            let owner = username();
            view! {
                <TripSection status=TripStatus::Planning trips=planning owner=owner.clone() />
                <TripSection status=TripStatus::Completed trips=completed owner />
            }
            .into_any()
        }
    }
    };

    view! {
        <Shell current="home">
            <section class="hero hero-home acct-hero">
                <div class="hero-copy">
                    <span class="eyebrow">"MY LITTLE MOMENTS"</span>
                    <h1>{display_name}" 的旅行手帳"</h1>
                    <p>"把平凡的日子，留成喜歡的回憶。"</p>
                    <div class="acct-actions">
                        <button type="button" class="button primary" on:click=open_dialog>
                            {art::static_svg(ICON_PLUS)}
                            " 新增旅行"
                        </button>
                    </div>
                </div>
                <div class="hero-art">{art::static_svg(Illustration::Camp.svg())}</div>
            </section>
            <div id="trip-list" class="acct-trip-list" aria-live="polite">
                {list}
            </div>
        </Shell>
        <dialog
            id="dialog"
            aria-labelledby="dialog-title"
            closedby="any"
            node_ref=dialog_ref
            on:cancel=move |event: ev::Event| {
                event.prevent_default();
                request_close();
            }
            on:close=move |_| {
                dirty.set(false);
                busy.set(false);
                open.set(false);
            }
            on:click=move |event: MouseEvent| {
                // 不支援 closedby 的瀏覽器：點選背景（對話框本身）時關閉
                let on_backdrop = match (event.target(), event.current_target()) {
                    (Some(target), Some(current)) => JsValue::from(target) == JsValue::from(current),
                    _ => false,
                };
                if on_backdrop && !closed_by {
                    request_close();
                }
            }
        >
            {move || {
                open.get()
                    .then(|| {
                        view! {
                            <div class="dialog-heading">
                                <h2 id="dialog-title">"新增旅行"</h2>
                                <button
                                    type="button"
                                    class="icon-button"
                                    aria-label="關閉對話框"
                                    on:click=move |_| request_close()
                                >
                                    {art::static_svg(ICON_CLOSE)}
                                </button>
                            </div>
                            <div class="dialog-content acct-dialog">
                                <p class="dialog-note">
                                    "建立後會先放在「規劃中的旅行」。過去的旅行也可以補記：之後在旅行選單的「編輯旅行」把狀態改成「已完成」，就會收進回憶區。建立後不會自動放入範例內容。"
                                </p>
                                <NewTripForm
                                    display_name=Signal::derive(display_name)
                                    dirty
                                    busy
                                    on_cancel=Callback::new(move |_| request_close())
                                    on_created=Callback::new(on_created)
                                />
                            </div>
                        }
                    })
            }}
        </dialog>
    }
}

/// 「規劃中的旅行」或「已完成的回憶」一區（現行 `renderHome()` 的 `section()`）。
#[component]
fn TripSection(status: TripStatus, trips: Vec<TripSummary>, owner: String) -> impl IntoView {
    let (key, heading, empty) = match status {
        TripStatus::Planning => ("planning", "規劃中的旅行", "目前沒有規劃中的旅行。"),
        TripStatus::Completed => (
            "completed",
            "已完成的回憶",
            "還沒有已完成的旅行。在旅行選單的「編輯旅行」把狀態改成「已完成」，就會出現在這裡。",
        ),
    };
    let heading_id = format!("sec-{key}");
    let labelled_by = heading_id.clone();
    let count = trips.len();
    let body = if trips.is_empty() {
        view! { <p class="empty">{empty}</p> }.into_any()
    } else {
        let cards = trips
            .into_iter()
            .map(|trip| view! { <TripCard trip owner=owner.clone() /> })
            .collect_view();
        view! { <div class="acct-trip-grid">{cards}</div> }.into_any()
    };
    view! {
        <section class="acct-trip-section" aria-labelledby=labelled_by>
            <h2 id=heading_id>{heading}<span class="count-bubble">{count}</span></h2>
            {body}
        </section>
    }
}

/// 一趟旅行的卡片（現行 `tripCard()`）：封面與狀態、連到 Trip_Page 的名稱、地點、日期、旅伴人數與狀態（需求 17.1）。
#[component]
fn TripCard(trip: TripSummary, owner: String) -> impl IntoView {
    let (_, tone) = cover_copy(trip.cover);
    let status = status_label(trip.status);
    let href = trip_path(&owner, trip.id);
    let destination = if trip.destination.is_empty() {
        "尚未填寫地點".to_owned()
    } else {
        trip.destination
    };
    view! {
        <article class="acct-trip-card" data-trip-id=trip.id.to_string()>
            <div class=format!("acct-trip-art tone-{tone}")>
                {art::static_svg(Illustration::for_cover(trip.cover).svg())}
                <span class=format!("tag acct-status status-{}", trip.status.as_str())>{status}</span>
            </div>
            <div class="acct-trip-body">
                <h3>
                    <a href=href.clone()>{trip.title}</a>
                </h3>
                <dl class="acct-trip-meta">
                    <div>
                        <dt>{art::static_svg(ICON_PIN)}<span>"地點"</span></dt>
                        <dd>{destination}</dd>
                    </div>
                    <div>
                        <dt>{art::static_svg(ICON_CALENDAR)}<span>"日期"</span></dt>
                        <dd>{date_span(trip.start, trip.end)}</dd>
                    </div>
                    <div>
                        <dt>{art::static_svg(ICON_PEOPLE)}<span>"旅伴"</span></dt>
                        <dd>{format!("{} 位旅伴", trip.member_count)}</dd>
                    </div>
                    <div>
                        <dt>{art::static_svg(ICON_BOOK)}<span>"狀態"</span></dt>
                        <dd>{status}</dd>
                    </div>
                </dl>
                <div class="acct-actions">
                    <a class="button primary small" href=href>
                        "開啟旅行手冊 "
                        {art::static_svg(ICON_ARROW)}
                    </a>
                </div>
            </div>
        </article>
    }
}

/// 建立旅行的表單（現行 `openTripDialog({ mode: 'create' })`，不含狀態，需求 17.2）。每次開啟對話框建立一個，
/// 旅行 id 在這時產生，之後每次送出都使用它（需求 17.9）。
#[component]
fn NewTripForm(
    display_name: Signal<String>,
    dirty: RwSignal<bool>,
    busy: RwSignal<bool>,
    on_cancel: Callback<()>,
    on_created: Callback<TripId>,
) -> impl IntoView {
    let api = use_api();
    let trip_id = TripId(Uuid::new_v4());
    let title = RwSignal::new(String::new());
    let destination = RwSignal::new(String::new());
    let start = RwSignal::new(String::new());
    let end = RwSignal::new(String::new());
    let description = RwSignal::new(String::new());
    let note = RwSignal::new(String::new());
    let cover = RwSignal::new(CoverKind::Camp);
    let error = RwSignal::new(String::new());
    let error_ref = NodeRef::<leptos::html::P>::new();
    // `showFormError()`：顯示訊息並把焦點移到訊息上
    let show_error = move |message: String| {
        let focus = !message.is_empty();
        error.set(message);
        if focus {
            request_animation_frame(move || {
                if let Some(element) = error_ref.get_untracked() {
                    let _ = element.focus();
                }
            });
        }
    };
    let on_submit = move |event: SubmitEvent| {
        event.prevent_default();
        if busy.get_untracked() {
            return;
        }
        let fields = TripFields {
            title: title.get_untracked(),
            destination: destination.get_untracked(),
            start: start.get_untracked(),
            end: end.get_untracked(),
            description: description.get_untracked(),
            note: note.get_untracked(),
            cover: cover.get_untracked(),
        };
        let request = match build_request(trip_id, &fields, &display_name.get_untracked()) {
            Ok(request) => request,
            Err(message) => {
                show_error(message);
                return;
            }
        };
        show_error(String::new());
        busy.set(true);
        spawn_local(async move {
            match api.create_trip(&request).await {
                Ok(created) => on_created.run(created.id),
                Err(failure) => {
                    // 已填寫的內容都保留；下一次送出仍使用同一個旅行 id
                    busy.set(false);
                    show_error(if failure.is_network() {
                        NOT_SAVED.to_owned()
                    } else {
                        failure.message
                    });
                }
            }
        });
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
                        name="trip-cover"
                        value=kind.as_str()
                        prop:checked=move || cover.get() == kind
                        on:change=move |_| cover.set(kind)
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
    view! {
        <form
            class="acct-form"
            novalidate
            aria-busy=move || busy.get().to_string()
            on:submit=on_submit
            on:input=move |_| dirty.set(true)
            on:change=move |_| dirty.set(true)
        >
            <div class="form-grid">
                <Field id="trip-title" label="旅行名稱" value=title required=true maxlength="100" wide=true />
                <Field id="trip-destination" label="地點" value=destination maxlength="100" wide=true />
                <Field id="trip-start" label="開始日期" kind="date" value=start required=true />
                <Field
                    id="trip-end"
                    label="結束日期"
                    kind="date"
                    value=end
                    required=true
                    help="一趟最多 31 天。"
                />
                <Field
                    id="trip-description"
                    label="旅行介紹"
                    kind="textarea"
                    value=description
                    maxlength="1000"
                    wide=true
                />
                <Field
                    id="trip-note"
                    label="旅行小叮嚀"
                    kind="textarea"
                    value=note
                    maxlength="1000"
                    wide=true
                />
                <fieldset class="acct-cover-picker acct-wide">
                    <legend>"封面插畫"</legend>
                    <div class="acct-cover-options">{covers}</div>
                </fieldset>
            </div>
            <p class="form-error" role="alert" tabindex="-1" node_ref=error_ref>
                {move || error.get()}
            </p>
            <div class="form-actions">
                <button
                    type="button"
                    class="button quiet"
                    disabled=move || busy.get()
                    on:click=move |_| on_cancel.run(())
                >
                    "取消"
                </button>
                <button type="submit" class="button primary" disabled=move || busy.get()>
                    {move || if busy.get() { "儲存中…" } else { "建立旅行" }}
                </button>
            </div>
        </form>
    }
}

/// 表單的一個欄位（現行 `field()`）：`<div class="field">` 中的 label、input 或 textarea，以及選填的說明。
#[component]
fn Field(
    id: &'static str,
    label: &'static str,
    value: RwSignal<String>,
    #[prop(default = "text")] kind: &'static str,
    #[prop(optional)] required: bool,
    #[prop(optional)] maxlength: Option<&'static str>,
    #[prop(optional)] help: Option<&'static str>,
    #[prop(optional)] wide: bool,
) -> impl IntoView {
    let help_id = help.map(|_| format!("{id}-help"));
    let input = if kind == "textarea" {
        view! {
            <textarea
                id=id
                name=id
                rows="3"
                maxlength=maxlength
                aria-describedby=help_id.clone()
                prop:value=move || value.get()
                on:input=move |event| value.set(event_target_value(&event))
            ></textarea>
        }
        .into_any()
    } else {
        view! {
            <input
                id=id
                name=id
                type=kind
                required=required
                maxlength=maxlength
                aria-describedby=help_id.clone()
                prop:value=move || value.get()
                on:input=move |event| value.set(event_target_value(&event))
            />
        }
        .into_any()
    };
    view! {
        <div class="field" class:acct-wide=wide>
            <label for=id>{label}</label>
            {input}
            {help.map(|help| view! { <small class="help" id=help_id>{help}</small> })}
        </div>
    }
}

#[cfg(test)]
mod tests {
    use lm_core::time::ymd;

    use super::{date_span, full_date, parse_date};

    #[test]
    fn full_dates_match_to_locale_date_string_zh_tw() {
        let day = |y, m, d| ymd(y, m, d).expect("有效的日期");
        assert_eq!(full_date(day(2026, 10, 20)), "2026年10月20日 週二");
        assert_eq!(full_date(day(2027, 1, 5)), "2027年1月5日 週二");
        assert_eq!(
            date_span(day(2026, 12, 30), day(2026, 12, 30)),
            "2026年12月30日 週三"
        );
        assert_eq!(
            date_span(day(2026, 12, 30), day(2027, 1, 2)),
            "2026年12月30日 週三 – 2027年1月2日 週六"
        );
    }

    #[test]
    fn date_inputs_are_yyyy_mm_dd() {
        assert_eq!(parse_date("2026-12-30"), ymd(2026, 12, 30));
        for value in ["", "2026-2-30", "2026-02-30", "2026-12-3", " 2026-12-30"] {
            assert_eq!(parse_date(value), None, "{value:?}");
        }
    }
}
