//! Trip_Page（`/<帳號名稱>/trips/<id>?tab=<分頁>`，需求 32.3）。
//!
//! - 開啟時以 App 層的 `TripSyncs` 取得這趟旅行的 `TripSync`（前往 `/login` 再回來、或從 Departure_Page 回來時沿用
//!   記憶體中的 Replica 與 Pending_Command）；Trip_Channel 由 App 外框依目前的畫面加入（任務 20.4）。第一次的 Snapshot
//!   合併之前只顯示載入中。
//! - 沿用 `src/app.js` 的 `trip()` 與 `hero()`：麵包屑、頁首（營地 camp 的靜態插畫，與需求 32.3 的倒數，以台灣時間
//!   （UTC+8）的今天計算）、規劃手冊／出發模式、五個分頁與側欄。分頁由網址的 `tab` 決定，切換時以 `replace` 只改 `tab`，
//!   不重新載入、不新增瀏覽紀錄，也不捲動。
//! - 頁首與 `<main>` 之間是連線與儲存的提示（需求 11.11、11.14、13.9、13.11）。
//! - 畫面狀態放在 [`UiState`]（design 4.3），不放在列元件裡：每張卡片與每個可展開區塊的展開狀態、開啟中的表單與草稿
//!   （`views::forms`）、Trip_Menu 是否開啟，以及 Schedule_Tab 選定的第 N 天。列移到別的組時，新的元件從 `UiState`
//!   取回展開狀態（需求 14.3、14.4）。
//! - 五個分頁（`views::schedule`、`meals`、`shopping`、`gear`、`ledger`）與 Trip_Menu（`views::trip_menu`）以
//!   [`use_trip`] 取得這趟旅行的 [`TripContext`]。
//!
//! 頁面本身只讀 Trip_Card、旅伴的鍵與整體的數量，不讀 `revision` 以外的整份狀態，所以 Optimistic_View 改變時只更新
//! 有變化的節點，捲動位移與焦點都不受影響（需求 14.4、14.10）。使用者文字一律以文字節點或屬性輸出（需求 32.6）。
use std::collections::HashMap;

use leptos::prelude::*;
use leptos_router::hooks::{use_navigate, use_url};
use leptos_router::NavigateOptions;
use lm_core::ids::{PersonId, TripId};
use lm_core::model::{Date, Slot, TripCard};
use lm_core::rules::{gear_progress, unassigned_gear};
use lm_core::text::trim_js_whitespace;
use lm_core::time::{date_range, month_day};

use crate::app::{home_path, trip_path, use_toasts, HeaderKind, Shell, Toasts};
use crate::art::{self, Illustration};
use crate::session::use_auth;
use crate::swipe::SwipeController;
use crate::sync::engine::{use_trip_syncs, ConnState, TripHandle};
use crate::sync::store::TripStores;
use crate::views::editors::EditorAvatars;
use crate::views::forms::{OpenForm, SessionSlot};
use crate::views::gear::GearTab;
use crate::views::icons;
use crate::views::invite_dialog::{CreatedInvite, InviteDialog};
use crate::views::ledger::LedgerTab;
use crate::views::meals::MealsTab;
use crate::views::schedule::ScheduleTab;
use crate::views::shopping::ShoppingTab;
use crate::views::trip_menu::{card_slot, TripMenu};

/// 「重新連線中」的提示（需求 11.11）。
const RECONNECTING: &str = "重新連線中，畫面可能不是最新";
/// 送出失敗、正在重送的提示（需求 13.9）。
const SAVE_RETRYING: &str = "儲存失敗，正在重試";
/// 「匯出手冊」按鈕的提示：這個版本沒有匯出功能（schedule-tab-css-parity Decision D1）。
const EXPORT_UNAVAILABLE: &str = "這個版本還不能匯出手冊";
/// 行程表分頁時 `<main>` 的 class（Bun `trip()` 的 `story-schedule-page`）。
const SCHEDULE_PAGE_CLASS: &str = "story-schedule-page";

/// Trip_Page 的五個分頁（需求 32.3；現行 `TABS` 與 `TAB_ICONS`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tab {
    Schedule,
    Meals,
    Shopping,
    Gear,
    Expenses,
}

impl Tab {
    pub const ALL: [Tab; 5] = [
        Tab::Schedule,
        Tab::Meals,
        Tab::Shopping,
        Tab::Gear,
        Tab::Expenses,
    ];

    /// `?tab=` 的值。
    pub const fn key(self) -> &'static str {
        match self {
            Tab::Schedule => "schedule",
            Tab::Meals => "meals",
            Tab::Shopping => "shopping",
            Tab::Gear => "gear",
            Tab::Expenses => "expenses",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Tab::Schedule => "行程表",
            Tab::Meals => "料理菜單",
            Tab::Shopping => "採買清單",
            Tab::Gear => "裝備分工",
            Tab::Expenses => "分帳記帳",
        }
    }

    const fn icon(self) -> &'static str {
        match self {
            Tab::Schedule => icons::D_CALENDAR,
            Tab::Meals => icons::D_CUP,
            Tab::Shopping => icons::D_BAG,
            Tab::Gear => icons::D_TENT,
            Tab::Expenses => icons::D_WALLET,
        }
    }

    /// `tab` 缺少或不是五個值之一時為行程表（需求 32.3）。
    pub fn parse(value: Option<&str>) -> Tab {
        Tab::ALL
            .into_iter()
            .find(|tab| Some(tab.key()) == value)
            .unwrap_or(Tab::Schedule)
    }
}

/// 把網址的查詢字串中的 `tab` 換成 `tab` 的值，其他參數不變。
fn tab_url(path: &str, search: &str, tab: Tab) -> String {
    let pair = format!("tab={}", tab.key());
    let mut params: Vec<&str> = search
        .trim_start_matches('?')
        .split('&')
        .filter(|param| !param.is_empty() && param.split('=').next() != Some("tab"))
        .collect();
    params.push(&pair);
    format!("{path}?{}", params.join("&"))
}

/// 可展開的區塊：一列（以 Slot 為鍵，換組之後仍是同一個鍵）或分頁中固定的區塊。
// 展開狀態、選定的日子與 `TripContext` 的一部分由之後的分頁（任務 21 至 23）使用
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ExpandKey {
    Row(Slot),
    Block(&'static str),
}

impl From<Slot> for ExpandKey {
    fn from(slot: Slot) -> Self {
        ExpandKey::Row(slot)
    }
}

/// 旅行頁的畫面狀態（design 4.3）。`Copy`；signal 屬於旅行頁的 Owner，離開旅行頁時釋放。
#[allow(dead_code)]
#[derive(Clone, Copy)]
pub struct UiState {
    pub(crate) handle: TripHandle,
    pub(crate) toasts: Toasts,
    /// 旅行頁的 Owner（弱參照，避免 Owner 與自己的節點互相持有）；展開狀態與每個表單的 Owner 建立在它之下
    pub(crate) owner: StoredValue<WeakOwner, LocalStorage>,
    expanded: StoredValue<HashMap<ExpandKey, RwSignal<bool>>, LocalStorage>,
    /// 開啟中的表單（`views::forms`）
    pub(crate) form: RwSignal<Option<OpenForm>>,
    pub(crate) sessions: StoredValue<Option<SessionSlot>, LocalStorage>,
    form_serial: StoredValue<u64>,
    /// Trip_Menu 是否開啟
    pub menu_open: RwSignal<bool>,
    /// 「邀請旅伴」對話框是否開啟
    pub invite_open: RwSignal<bool>,
    /// 「邀請旅伴」對話框產生的連結；再次開啟時仍有效就沿用
    pub invite_link: RwSignal<Option<CreatedInvite>>,
    /// Schedule_Tab 選定的第 N 天（0 為第 1 天）；旅行日期改變時由 Schedule_Tab 依需求 22.16 調整
    pub schedule_day: RwSignal<usize>,
}

impl UiState {
    /// 在旅行頁的 Owner 之下建立。
    fn new(handle: TripHandle, toasts: Toasts) -> Self {
        let owner = Owner::current().unwrap_or_default();
        UiState {
            handle,
            toasts,
            owner: StoredValue::new_local(owner.downgrade()),
            expanded: StoredValue::new_local(HashMap::new()),
            form: RwSignal::new(None),
            sessions: StoredValue::new_local(None),
            form_serial: StoredValue::new(0),
            menu_open: RwSignal::new(false),
            invite_open: RwSignal::new(false),
            invite_link: RwSignal::new(None),
            schedule_day: RwSignal::new(0),
        }
    }

    /// 旅行頁的 Owner 之下的子 Owner（表單用）；旅行頁已卸載時是一個獨立的 Owner。
    pub(crate) fn child_owner(&self) -> Owner {
        self.owner
            .with_value(WeakOwner::upgrade)
            .map(|owner| owner.child())
            .unwrap_or_default()
    }

    pub(crate) fn next_form_serial(&self) -> u64 {
        let serial = self.form_serial.get_value() + 1;
        self.form_serial.set_value(serial);
        serial
    }

    /// `key` 的展開狀態；第一次讀取時是 `default`。signal 屬於旅行頁，所以列元件因換組而重建時取回同一個狀態
    /// （需求 14.3、14.4）。
    #[allow(dead_code)]
    pub fn expanded(&self, key: impl Into<ExpandKey>, default: bool) -> RwSignal<bool> {
        let key = key.into();
        if let Some(signal) = self.expanded.with_value(|map| map.get(&key).copied()) {
            return signal;
        }
        let owner = self
            .owner
            .with_value(WeakOwner::upgrade)
            .unwrap_or_default();
        let signal = owner.with(|| RwSignal::new(default));
        self.expanded.update_value(|map| {
            map.insert(key, signal);
        });
        signal
    }
}

/// 旅行頁的元件共用的內容，以 Leptos context 提供（[`use_trip`]）。
#[allow(dead_code)]
#[derive(Clone, Copy)]
pub struct TripContext {
    pub trip: TripId,
    pub handle: TripHandle,
    pub stores: TripStores,
    pub ui: UiState,
}

#[allow(dead_code)]
impl TripContext {
    /// 檢視者在這趟旅行的 Bound_Person；在 reactive 範圍中讀取時依 `revision` 重算。
    pub fn me(&self) -> Option<PersonId> {
        self.handle.viewer().and_then(|viewer| viewer.caps.me)
    }
}

/// 取得旅行頁提供的 [`TripContext`]。
pub fn use_trip() -> TripContext {
    expect_context::<TripContext>()
}

/// 自己的 Trip_Page（App 外框已確認有 Session，而且網址中的帳號名稱是自己的）。
#[component]
pub fn TripPage(trip: TripId) -> impl IntoView {
    let handle = use_trip_syncs().open(trip);
    view! {
        <Shell
            class="page"
            header=HeaderKind::Trip
            top=Box::new(move || view! { <ConnectionBanners handle /> }.into_any())>
            {move || match handle.stores.try_get().flatten() {
                // 第一次的 Snapshot 合併之前（需求 12.1）
                None => {
                    view! {
                        <p class="acct-loading" role="status">
                            "正在載入旅行…"
                        </p>
                    }
                        .into_any()
                }
                Some(stores) => view! { <TripLoaded trip handle stores /> }.into_any(),
            }}
        </Shell>
    }
}

/// 頂端的連線與儲存提示（現行 `.save-warning` 的樣式）。離線時只顯示「離線中，有 N 項變更尚未送出」（N 為 0 時只顯示
/// 「離線中」），取代另外兩個提示（需求 11.14、13.11）；上線時依情況顯示「重新連線中，畫面可能不是最新」（需求 11.11）
/// 與「儲存失敗，正在重試」（需求 13.9）。Departure_Page 也使用。
#[component]
pub fn ConnectionBanners(handle: TripHandle) -> impl IntoView {
    let banners = move || {
        let online = handle.online.try_get().unwrap_or(true);
        if !online {
            let pending = handle.pending_count.try_get().unwrap_or(0);
            return vec![if pending == 0 {
                "離線中".to_owned()
            } else {
                format!("離線中，有 {pending} 項變更尚未送出")
            }];
        }
        let mut banners = Vec::new();
        if handle.conn.try_get() == Some(ConnState::Reconnecting) {
            banners.push(RECONNECTING.to_owned());
        }
        if handle.save_retrying.try_get().unwrap_or(false) {
            banners.push(SAVE_RETRYING.to_owned());
        }
        banners
    };
    view! {
        <div role="status" aria-live="polite">
            {move || {
                banners()
                    .into_iter()
                    .map(|text| {
                        view! {
                            <div class="save-warning">
                                <span>{text}</span>
                            </div>
                        }
                    })
                    .collect_view()
            }}
        </div>
    }
}

/// 第一次的 Snapshot 合併之後的旅行頁（`trip()`）。
#[component]
fn TripLoaded(trip: TripId, handle: TripHandle, stores: TripStores) -> impl IntoView {
    let ui = UiState::new(handle, use_toasts());
    // 離開旅行頁（例如前往 Departure_Page，頻道仍在）時開啟中的編輯表單隨之關閉（需求 15.2）
    on_cleanup(move || ui.on_page_exit());
    let context = TripContext {
        trip,
        handle,
        stores,
        ui,
    };
    provide_context(context);

    let user = use_auth().user();
    let username = move || user.with(|user| user.as_ref().map(|u| u.username.clone()));
    let home = move || username().map(|name| home_path(&name)).unwrap_or_default();
    let planner = move || {
        username()
            .map(|name| trip_path(&name, trip))
            .unwrap_or_default()
    };
    let departure = move || format!("{}/go", planner());

    let title = Memo::new(move |_| stores.card.with(|card| card.title.clone()));
    Effect::new(move |_| document().set_title(&format!("{} · 日子拾光", title.get())));

    // 分頁由網址的 tab 決定（需求 32.3）
    let url = use_url();
    let tab = Memo::new(move |_| {
        url.with(|url| {
            let params = url.search_params();
            Tab::parse(params.get_str("tab"))
        })
    });
    // 行程表分頁時 `<main>` 另有 `story-schedule-page`（Bun `trip()`；版面規則在 storybook-host.css）
    Effect::new(move |_| {
        let schedule = tab.get() == Tab::Schedule;
        if let Some(main) = document().get_element_by_id("main") {
            let _ = main
                .class_list()
                .toggle_with_force(SCHEDULE_PAGE_CLASS, schedule);
        }
    });
    on_cleanup(|| {
        if let Some(main) = document().get_element_by_id("main") {
            let _ = main.class_list().remove_1(SCHEDULE_PAGE_CLASS);
        }
    });
    let navigate = use_navigate();
    let select = move |next: Tab| {
        let target = url.with_untracked(|url| tab_url(url.path(), url.search(), next));
        navigate(
            &target,
            NavigateOptions {
                replace: true,
                scroll: false,
                ..Default::default()
            },
        );
    };

    let unassigned = Memo::new(move |_| {
        handle
            .with_view(|state| unassigned_gear(state).count())
            .unwrap_or(0)
    });

    let tabs = Tab::ALL
        .into_iter()
        .enumerate()
        .map(|(index, item)| {
            let select = select.clone();
            view! {
                <button
                    type="button"
                    data-tab=item.key()
                    aria-current=move || (tab.get() == item).then_some("page")
                    on:click=move |_| {
                        if tab.get_untracked() != item {
                            select(item);
                        }
                    }
                >
                    <span class="tab-icon">{art::static_svg(item.icon())}</span>
                    <span class="tab-number">{format!("0{}", index + 1)}</span>
                    <span class="tab-label">{item.label()}</span>
                    {(item == Tab::Gear)
                        .then_some({
                            move || {
                                let count = unassigned.get();
                                (count > 0)
                                    .then(|| {
                                        view! {
                                            <span
                                                class="tab-badge"
                                                aria-label=format!("{count} 項待分配")
                                            >
                                                {count}
                                            </span>
                                        }
                                    })
                            }
                        })}
                </button>
            }
        })
        .collect_view();

    // `.workspace` 是 Swipe_Controller 掛載的位置（design 4.3）；離開頁面時 drop 控制器，拆掉監聽與 Observer（需求 5.17）
    let workspace = NodeRef::<leptos::html::Div>::new();
    let swipe = StoredValue::new_local(None::<SwipeController>);
    Effect::new(move |_| {
        if let Some(element) = workspace.get() {
            if swipe.with_value(Option::is_none) {
                swipe.set_value(Some(SwipeController::mount(element.into())));
            }
        }
    });
    on_cleanup(move || swipe.update_value(|controller| drop(controller.take())));

    let open_gear = {
        let select = select.clone();
        move || {
            if tab.get_untracked() != Tab::Gear {
                select(Tab::Gear);
            }
        }
    };

    view! {
        <nav class="breadcrumb" aria-label="麵包屑">
            <a href=home>"我的旅行"</a>
            <span>"/"</span>
            <span>{move || title.get()}</span>
        </nav>
        <Hero />
        <div class="trip-toolbar">
            <nav class="mode-switch" aria-label="旅行模式">
                <a href=planner aria-current="page">
                    {art::static_svg(icons::D_BOOK)}
                    " "
                    <span class="mode-label">"規劃手冊"</span>
                </a>
                <a href=departure>
                    {art::static_svg(icons::D_TENT)}
                    " "
                    <span class="mode-label">"出發模式"</span>
                    " "
                    {art::static_svg(icons::ARROW)}
                </a>
            </nav>
            <div class="toolbar-actions">
                // 版面與現行相同；這個版本沒有匯出功能，按下只顯示提示（Decision D1）
                <button
                    type="button"
                    class="button quiet"
                    aria-label="匯出手冊"
                    title="匯出手冊"
                    on:click=move |_| ui.toasts.show(EXPORT_UNAVAILABLE)
                >
                    {art::static_svg(icons::D_DOWNLOAD)}
                    <span>"匯出手冊"</span>
                </button>
                // 開啟「邀請旅伴」對話框並自動產生連結；沒有邀請權限時開啟 Trip_Menu（需求 30.17、32.4）
                <button
                    type="button"
                    class="button blue"
                    aria-label="邀請旅伴"
                    title="邀請旅伴"
                    on:click=move |_| {
                        let can_invite = untrack(|| {
                            handle.viewer().is_some_and(|viewer| viewer.caps.can_invite)
                        });
                        if can_invite {
                            ui.invite_open.set(true);
                        } else {
                            ui.menu_open.set(true);
                        }
                    }
                >
                    {art::static_svg(icons::D_PEOPLE)}
                    <span>"邀請旅伴"</span>
                </button>
            </div>
        </div>
        <nav class="section-tabs" aria-label="旅行內容">
            {tabs}
        </nav>
        // 行程表（Bun `scheduleTab()`）：工作室的宿主直接放在 `.workspace.story-schedule-layout` 中，沒有 `.workspace-main`
        <div
            class=move || {
                if tab.get() == Tab::Schedule {
                    "workspace story-schedule-layout"
                } else {
                    "workspace"
                }
            }
            node_ref=workspace
        >
            {move || match tab.get() {
                Tab::Schedule => view! { <ScheduleTab /> }.into_any(),
                other => {
                    view! {
                        <section class="workspace-main" aria-label=other.label()>
                            {match other {
                                Tab::Meals => view! { <MealsTab /> }.into_any(),
                                Tab::Shopping => view! { <ShoppingTab /> }.into_any(),
                                Tab::Gear => view! { <GearTab /> }.into_any(),
                                _ => view! { <LedgerTab /> }.into_any(),
                            }}
                        </section>
                    }
                        .into_any()
                }
            }}
            <Sidebar departure=Signal::derive(departure) open_gear />
        </div>
        {move || ui.menu_open.get().then(|| view! { <TripMenu /> })}
        <InviteDialog />
    }
}

/// 台灣時間（UTC+8）今天的日期。
fn taiwan_today() -> Option<Date> {
    const UTC8_MS: i64 = 8 * 3_600_000;
    const DAY_MS: i64 = 86_400_000;
    // 1970-01-01 是西元第 719,163 天（0001-01-01 為第 1 天）
    const UNIX_EPOCH_FROM_CE: i64 = 719_163;
    let now_ms = js_sys::Date::now() as i64;
    let days = (now_ms + UTC8_MS).div_euclid(DAY_MS) + UNIX_EPOCH_FROM_CE;
    Date::from_num_days_from_ce_opt(i32::try_from(days).ok()?)
}

/// 倒數（需求 32.3）：D = 開始日減去今天。D 大於 0 時「距離出發」「{D}」「天」，D 等於 0 時「今天出發」「GO」「!」，
/// D 小於 0 時「旅行手冊」「{Trip_Day 的天數}」「天的好日子」。
fn countdown(card: &TripCard, today: Date) -> (&'static str, String, &'static str) {
    let days = card.start.signed_duration_since(today).num_days();
    match days {
        d if d > 0 => ("距離出發", d.to_string(), "天"),
        0 => ("今天出發", "GO".to_owned(), "!"),
        _ => (
            "旅行手冊",
            date_range(card.start, card.end).len().to_string(),
            "天的好日子",
        ),
    }
}

/// 現行 `googleMapsUrl()`：以 `URLSearchParams` 的編碼（application/x-www-form-urlencoded）組成 Google Maps 的搜尋網址；
/// 地點修剪後是空的，或網址超過 2,048 個字元時沒有連結。
fn google_maps_url(location: &str) -> Option<String> {
    let query = trim_js_whitespace(location);
    if query.is_empty() {
        return None;
    }
    let mut url = String::from("https://www.google.com/maps/search/?api=1&query=");
    for byte in query.bytes() {
        match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                url.push(char::from(byte));
            }
            b' ' => url.push('+'),
            _ => url.push_str(&format!("%{byte:02X}")),
        }
    }
    (url.len() <= 2048).then_some(url)
}

/// 現行 `mapLink()`：有 Google Maps 網址時是另開分頁的連結，否則是文字（空的時候為「地點待確認」）。
pub(crate) fn map_link(location: &str) -> AnyView {
    let text = trim_js_whitespace(location).to_owned();
    match google_maps_url(location) {
        Some(url) => view! {
            <a
                class="map-link"
                href=url
                target="_blank"
                rel="noopener noreferrer"
                aria-label=format!("在 Google Maps 開啟 {text}（另開分頁）")
                title="在 Google Maps 開啟（另開分頁）"
            >
                {text.clone()}
                {art::static_svg(icons::MAP_LINK)}
            </a>
        }
        .into_any(),
        None if text.is_empty() => "地點待確認".into_any(),
        None => text.into_any(),
    }
}

/// 旅行頁的頁首（`hero()`）：插畫一律是營地 camp 的靜態插畫，不隨封面改變（design 4.1）。
#[component]
fn Hero() -> impl IntoView {
    let ctx = use_trip();
    let TripContext { stores, ui, .. } = ctx;
    let card = stores.card;
    let people = Memo::new(move |_| stores.people.keys().with(Vec::len));
    let today = taiwan_today();
    let countdown = Memo::new(move |_| today.map(|today| card.with(|card| countdown(card, today))));
    let destination = Memo::new(move |_| card.with(|card| card.destination.clone()));
    view! {
        <section class="hero">
            <div class="hero-copy">
                <span class="eyebrow">"LITTLE MOMENTS"</span>
                <div class="trip-title-row">
                    <h1 id="trip-title">{move || card.with(|card| card.title.clone())}</h1>
                    <button
                        type="button"
                        class="icon-button trip-menu-button"
                        aria-label="旅行選單"
                        aria-haspopup="dialog"
                        aria-expanded=move || ui.menu_open.get().to_string()
                        aria-controls=move || ui.menu_open.get().then_some("trip-menu")
                        on:click=move |_| ui.menu_open.update(|open| *open = !*open)
                    >
                        {art::static_svg(icons::MENU)}
                    </button>
                    {move || {
                        let destination = destination.get();
                        google_maps_url(&destination)
                            .map(|url| {
                                view! {
                                    <a
                                        class="hero-pin"
                                        href=url
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        aria-label=format!(
                                            "在 Google Maps 開啟 {destination}（另開分頁）",
                                        )
                                        title=destination.clone()
                                    >
                                        {art::static_svg(icons::D_PIN)}
                                    </a>
                                }
                            })
                    }}
                    // Trip_Card 的 Editor_Stack 在旅行標題列的右側（需求 16.2）
                    <EditorAvatars item=card_slot(ctx) />
                </div>
                <p>{move || card.with(|card| card.description.clone())}</p>
                <div class="hero-tags">
                    <span>
                        {art::static_svg(icons::CALENDAR)}
                        {move || {
                            card.with(|card| {
                                format!("{} — {}", month_day(card.start), month_day(card.end))
                            })
                        }}
                    </span>
                    <span class="hero-destination">
                        {art::static_svg(icons::PIN)}
                        {move || map_link(&destination.get())}
                    </span>
                    <span>{art::static_svg(icons::PEOPLE)} {move || people.get()} " 位旅伴"</span>
                </div>
                <div class="hero-note">
                    {art::static_svg(icons::LEAF)} " 旅行前一起規劃，出發後專心玩。"
                </div>
            </div>
            <div class="hero-art">
                <span class="postcard-sticker">"Let's go camping!"</span>
                <div class="scene-motion illustration scene-motion--camp">
                    {art::static_svg(Illustration::Camp.svg())}
                    {move || {
                        countdown
                            .get()
                            .map(|(label, value, unit)| {
                                view! {
                                    <div class="countdown">
                                        <small>{label}</small>
                                        <strong>{value}</strong>
                                        <span>{unit}</span>
                                    </div>
                                }
                            })
                    }}
                </div>
            </div>
        </section>
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

/// 側欄（`sidebar()`）的小隊與準備進度；第一版沒有每日小語（design「第一版的範圍」）。
#[component]
fn Sidebar(
    departure: Signal<String>,
    open_gear: impl Fn() + Clone + Send + Sync + 'static,
) -> impl IntoView {
    let TripContext { handle, stores, .. } = use_trip();
    let people = Memo::new(move |_| stores.people.keys().with(Vec::len));
    let shopping = Memo::new(move |_| {
        handle
            .with_view(|state| {
                let done = state
                    .shopping
                    .values()
                    .filter(|item| item.purchased)
                    .count();
                (done, state.shopping.len())
            })
            .unwrap_or_default()
    });
    let gear = Memo::new(move |_| handle.with_view(gear_progress).unwrap_or_default());
    let unassigned = Memo::new(move |_| {
        handle
            .with_view(|state| unassigned_gear(state).count())
            .unwrap_or(0)
    });
    view! {
        <aside class="sidebar">
            <section class="crew-panel">
                <span class="eyebrow">"OUR TRAVEL CREW"</span>
                <h2>"小隊準備好了嗎？"</h2>
                <div class="avatar-stack">
                    <For
                        each=move || stores.people.keys().get()
                        key=|id| *id
                        children=move |id| {
                            let row = stores.people.get(id);
                            move || {
                                row.as_ref()
                                    .map(|row| {
                                        row.with(|person| {
                                            view! {
                                                <span
                                                    class=format!("avatar {}", person.color.as_str())
                                                    aria-label=person.name.clone()
                                                >
                                                    {person_initial(&person.name)}
                                                </span>
                                            }
                                        })
                                    })
                            }
                        }
                    />
                </div>
                <p>{move || people.get()} " 位旅伴，一起收集回憶。"</p>
                <div class="progress-line">
                    <span>"食材採買"</span>
                    <b>
                        {move || shopping.get().0} " "
                        <span>{move || format!("/ {}", shopping.get().1)}</span>
                    </b>
                </div>
                <progress
                    aria-label="食材採買進度"
                    max=move || shopping.get().1.max(1)
                    value=move || shopping.get().0
                ></progress>
                <div class="progress-line">
                    <span>"裝備準備"</span>
                    <b>
                        {move || gear.get().done} " "
                        <span>{move || format!("/ {}", gear.get().total)}</span>
                    </b>
                </div>
                <progress
                    class="yellow-progress"
                    aria-label="裝備準備進度"
                    max=move || gear.get().total.max(1)
                    value=move || gear.get().done
                ></progress>
                {move || {
                    let count = unassigned.get();
                    (count > 0)
                        .then(|| {
                            view! {
                                <button
                                    type="button"
                                    class="unassigned-link"
                                    on:click={
                                        let open_gear = open_gear.clone();
                                        move |_| open_gear()
                                    }
                                >
                                    {art::static_svg(icons::INFO)}
                                    {format!(" {count} 項裝備還在等主人 ")}
                                    {art::static_svg(icons::ARROW)}
                                </button>
                            }
                        })
                }}
                <a href=move || departure.get() class="button full">
                    "看看我的行前清單 "
                    {art::static_svg(icons::ARROW)}
                </a>
            </section>
            <div class="side-footnote">
                {art::static_svg(icons::LEAF)} " 把垃圾帶走，把風景留下。"
            </div>
        </aside>
    }
}
