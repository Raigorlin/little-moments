//! App 外框：路由（需求 32.1、32.9–32.11 與 4.10）、帳號頁的外框、訊息頁與 Toast。
//!
//! 路由以 leptos_router 的 `<Router>` 與一個接受所有路徑的 `<Route>` 取得網址與前往其他畫面（`use_url()`、
//! `use_navigate()`），網址對應到哪個畫面則由 `Screen::parse()` 判斷：路徑結尾多出的 `/` 一律忽略、旅行 id 必須是 UUID，而且 `/invite/<token>` 優先於
//! `/<帳號名稱>/home` 這類第一段是參數的路徑，這些規則集中在一個函式中，不依賴 `<Routes>` 的比對細節。
//!
//! 畫面中的使用者文字（帳號名稱、顯示名稱等）一律以文字節點或屬性輸出；只有 `art::static_svg()` 放進的靜態 SVG
//! 以 HTML 插入（需求 32.6）。
use std::time::Duration;

use leptos::ev;
use leptos::prelude::*;
use leptos_router::components::{Route, Router, Routes};
use leptos_router::hooks::{use_navigate, use_url};
use leptos_router::location::Url;
use leptos_router::{path, NavigateOptions};
use lm_core::account::check_username;
use lm_core::api::ProfileDto;
use lm_core::ids::TripId;
use uuid::Uuid;
use wasm_bindgen::JsCast;

use crate::art::{self, Illustration};
use crate::pages::auth::{AuthMode, AuthPage};
use crate::pages::departure::DeparturePage;
use crate::pages::home::HomePage;
use crate::pages::invite::InvitePage;
use crate::pages::trip::TripPage;
use crate::session::{use_auth, Auth};
use crate::sync::engine::TripSyncs;
use crate::sync::realtime::TripChannels;
use crate::views::icons;

/// Trip_Page 的五個分頁（`?tab=` 的值，需求 32.3）。
pub const TRIP_TABS: [&str; 5] = ["schedule", "meals", "shopping", "gear", "expenses"];

/// `index.html` 的文件標題。
const DEFAULT_TITLE: &str = "日子拾光 · LITTLE MOMENTS";

/// 每則 Toast 顯示的時間。
const TOAST_DURATION: Duration = Duration::from_millis(4500);

/// 網址的路徑對應到的畫面（需求 32.1），還沒有考慮登入狀態。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Screen {
    /// `/`
    Root,
    /// `/login`
    Login,
    /// `/register`
    Register,
    /// `/invite/<token>`（Invite_Page）；token 的內容由 Invite_Page 向 LM_Server 確認
    Invite { token: String },
    /// `/<帳號名稱>/home`（Home_Page）
    Home { owner: String },
    /// `/<帳號名稱>/trips/<id>`（Trip_Page）
    Trip { owner: String, trip: TripId },
    /// `/<帳號名稱>/trips/<id>/go`（Departure_Page）
    Departure { owner: String, trip: TripId },
    /// 不對應任何畫面（需求 32.11）
    NotFound,
}

impl Screen {
    /// 依網址的路徑（不含查詢字串）找出畫面；結尾多出的 `/` 不影響對應（`/login/` 等同 `/login`）。
    pub fn parse(path: &str) -> Self {
        let path = path.trim_end_matches('/');
        if path.is_empty() {
            return Self::Root;
        }
        let Some(rest) = path.strip_prefix('/') else {
            return Self::NotFound;
        };
        let segments: Vec<&str> = rest.split('/').collect();
        match segments.as_slice() {
            ["login"] => Self::Login,
            ["register"] => Self::Register,
            ["invite", token] if !token.is_empty() => Self::Invite {
                token: (*token).to_owned(),
            },
            [owner, "home"] if !owner.is_empty() => Self::Home {
                owner: (*owner).to_owned(),
            },
            [owner, "trips", id] if !owner.is_empty() => match trip_id(id) {
                Some(trip) => Self::Trip {
                    owner: (*owner).to_owned(),
                    trip,
                },
                None => Self::NotFound,
            },
            [owner, "trips", id, "go"] if !owner.is_empty() => match trip_id(id) {
                Some(trip) => Self::Departure {
                    owner: (*owner).to_owned(),
                    trip,
                },
                None => Self::NotFound,
            },
            _ => Self::NotFound,
        }
    }
}

/// 網址中的旅行 id：含連字號的 36 字元 UUID（大小寫都接受）。其他寫法（不含連字號、大括號、`urn:uuid:`）不算。
fn trip_id(segment: &str) -> Option<TripId> {
    if segment.len() != 36 {
        return None;
    }
    Uuid::try_parse(segment).ok().map(TripId)
}

/// 邀請 token 的格式：LM_Server 產生的 64 個小寫十六進位字元。
fn is_invite_token(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 這個值是不是 In_App_Path：Invite_Page、Home_Page、Trip_Page（可以帶 `?tab=<分頁>`）或 Departure_Page 的路徑，
/// 帳號名稱符合需求 3.2 的格式（也不是保留名稱）。每一段都只允許固定的字元，所以符合的值只以一個 `/` 開頭，
/// 不含 scheme、主機、`//`、`\`、`#` 或百分比編碼。
pub fn is_in_app_path(value: &str) -> bool {
    let (path, query) = match value.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (value, None),
    };
    let Some(rest) = path.strip_prefix('/') else {
        return false;
    };
    let segments: Vec<&str> = rest.split('/').collect();
    match (segments.as_slice(), query) {
        (["invite", token], None) => is_invite_token(token),
        ([owner, "home"], None) => check_username(owner).is_ok(),
        ([owner, "trips", id], query) => {
            check_username(owner).is_ok()
                && trip_id(id).is_some()
                && query.is_none_or(|query| {
                    query
                        .strip_prefix("tab=")
                        .is_some_and(|tab| TRIP_TABS.contains(&tab))
                })
        }
        ([owner, "trips", id, "go"], None) => {
            check_username(owner).is_ok() && trip_id(id).is_some()
        }
        _ => false,
    }
}

/// 登入成功或已有 Session 時開啟 `/login`、`/register` 後的目的地（需求 4.10）：`next` 是 In_App_Path，而且不是
/// 另一個帳號名稱的 Home_Page、Trip_Page 或 Departure_Page 時前往 `next`，否則前往這個帳號的 Home_Page。
pub fn login_destination(next: Option<&str>, username: &str) -> String {
    match next {
        Some(next)
            if is_in_app_path(next) && path_owner(next).is_none_or(|owner| owner == username) =>
        {
            next.to_owned()
        }
        _ => home_path(username),
    }
}

/// In_App_Path 中的帳號名稱；Invite_Page 沒有帳號名稱（`invite` 是保留名稱，不會是帳號名稱）。
fn path_owner(path: &str) -> Option<&str> {
    let owner = path.strip_prefix('/')?.split(['/', '?']).next()?;
    (owner != "invite").then_some(owner)
}

/// 帳號的 Home_Page。帳號名稱只有小寫英文字母、數字與連字號（需求 3.2），不需要編碼。
pub fn home_path(username: &str) -> String {
    format!("/{username}/home")
}

/// 帳號的一趟旅行的 Trip_Page（`/<帳號名稱>/trips/<旅行 id>`）。旅行 id 是 UUID，不需要編碼。
pub fn trip_path(username: &str, trip: TripId) -> String {
    format!("/{username}/trips/{trip}")
}
/// 沒有 Session 時前往的登入頁：`/login?next=<目前的路徑與查詢字串>`，經 URL 編碼（需求 32.9、4.9）。
pub fn login_path(current: &str) -> String {
    format!("/login?next={}", Url::escape(current))
}

/// 網址的路徑加上查詢字串（例如 `/alice/trips/<id>?tab=meals`）。路徑結尾多出的 `/` 去掉，使登入後仍以 In_App_Path
/// 回到同一個畫面。
fn current_path(url: &Url) -> String {
    let path = match url.path().trim_end_matches('/') {
        "" => "/",
        path => path,
    };
    if url.search().is_empty() {
        path.to_owned()
    } else {
        format!("{path}?{}", url.search())
    }
}

/// 訊息頁「沒有權限查看這個頁面」是哪一種頁面的網址（需求 32.10）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OthersPage {
    Home,
    Trip,
}

impl OthersPage {
    const fn body(self) -> &'static str {
        match self {
            Self::Home => "這是別人的旅行首頁。每個帳號只能看到自己的首頁，請回到你自己的首頁。",
            Self::Trip => "旅行網址必須使用你自己的帳號名稱。請從你的首頁打開旅行。",
        }
    }
}

/// 依畫面與登入狀態決定要顯示的內容。
#[derive(Clone, Debug, PartialEq, Eq)]
enum Outcome {
    /// 以 `replace` 前往另一個網址，這段期間不顯示任何畫面
    Redirect(String),
    Auth(AuthMode),
    Invite(String),
    Home,
    Trip(TripId),
    Departure(TripId),
    Forbidden(OthersPage),
    NotFound,
}

fn decide(screen: Screen, user: Option<&ProfileDto>, next: Option<&str>, current: &str) -> Outcome {
    match (screen, user) {
        (Screen::Root, Some(user)) => Outcome::Redirect(home_path(&user.username)),
        (Screen::Root, None) => Outcome::Redirect("/login".to_owned()),
        (Screen::Login | Screen::Register, Some(user)) => {
            Outcome::Redirect(login_destination(next, &user.username))
        }
        (Screen::Login, None) => Outcome::Auth(AuthMode::Login),
        (Screen::Register, None) => Outcome::Auth(AuthMode::Register),
        (Screen::Invite { token }, _) => Outcome::Invite(token),
        // 沒有 Session：不讀取旅行資料，先登入再回來（需求 32.9）
        (Screen::Home { .. } | Screen::Trip { .. } | Screen::Departure { .. }, None) => {
            Outcome::Redirect(login_path(current))
        }
        (Screen::Home { owner }, Some(user)) if owner != user.username => {
            Outcome::Forbidden(OthersPage::Home)
        }
        (Screen::Trip { owner, .. } | Screen::Departure { owner, .. }, Some(user))
            if owner != user.username =>
        {
            Outcome::Forbidden(OthersPage::Trip)
        }
        (Screen::Home { .. }, Some(_)) => Outcome::Home,
        (Screen::Trip { trip, .. }, Some(_)) => Outcome::Trip(trip),
        (Screen::Departure { trip, .. }, Some(_)) => Outcome::Departure(trip),
        (Screen::NotFound, _) => Outcome::NotFound,
    }
}

/// 整個 App：登入狀態、Toast 與路由。
#[component]
pub fn App() -> impl IntoView {
    let toasts = Toasts::provide();
    let auth = Auth::provide(toasts);
    // 每趟旅行的同步引擎屬於 App 的 Owner：前往 /login 再回來時沿用，切換帳號時捨棄（需求 4.9、4.10、4.14）
    let syncs = TripSyncs::provide(auth, toasts);
    // 停在某趟旅行的 Trip_Page 或 Departure_Page 時加入它的 Trip_Channel（需求 11.3、11.13）
    TripChannels::provide(auth, syncs);
    view! {
        <Router>
            <a class="skip-link" href="#main">
                "跳到主要內容"
            </a>
            <div id="app">
                // 每個網址都由 Screens 依 Screen::parse() 判斷；放在 <Routes> 中，點選連結後網址列才會更新
                <Routes fallback=Screens>
                    <Route path=path!("/*any") view=Screens />
                </Routes>
            </div>
            <div
                id="toasts"
                class="toasts"
                class:visible=move || toasts.visible.get()
                role="status"
                aria-live="polite"
                aria-atomic="true"
            >
                {move || toasts.message.get()}
            </div>
        </Router>
    }
}

/// 依網址與登入狀態顯示畫面；需要前往其他網址時以 `replace` 前往，不新增瀏覽紀錄。
#[component]
fn Screens() -> impl IntoView {
    let auth = use_auth();
    let user = auth.user();
    let url = use_url();
    // 登入狀態要求前往的網址（Session 失效、登出或切換帳號，需求 4.9、4.12、4.14）：到達那個路徑之後清除
    Effect::new(move |_| {
        let arrived = auth.redirect_target().is_some_and(|to| {
            let path = to.split('?').next().unwrap_or_default();
            url.with(|url| url.path().trim_end_matches('/') == path.trim_end_matches('/'))
        });
        if arrived {
            auth.clear_redirect();
        }
    });
    let outcome = Memo::new(move |_| {
        let url = url.read();
        if let Some(to) = auth.redirect_target() {
            let path = to.split('?').next().unwrap_or_default();
            if url.path().trim_end_matches('/') != path.trim_end_matches('/') {
                return Outcome::Redirect(to);
            }
        }
        let user = user.read();
        decide(
            Screen::parse(url.path()),
            user.as_ref(),
            url.search_params().get_str("next"),
            &current_path(&url),
        )
    });
    // 這趟旅行的 Trip_Page 與 Departure_Page 之間切換時沿用同一個 Trip_Channel；前往其他畫面時離開（需求 11.13）
    let channels = expect_context::<TripChannels>();
    let active_trip = Memo::new(move |_| match outcome.get() {
        Outcome::Trip(trip) | Outcome::Departure(trip) => Some(trip),
        _ => None,
    });
    Effect::new(move |_| channels.set_active(active_trip.get()));
    let navigate = use_navigate();
    Effect::new(move |_| {
        if let Outcome::Redirect(to) = outcome.get() {
            navigate(
                &to,
                NavigateOptions {
                    replace: true,
                    ..Default::default()
                },
            );
        }
    });
    move || {
        // 每換一個畫面先恢復 index.html 的文件標題；訊息頁等畫面在建立時再設定自己的標題
        let outcome = outcome.get();
        document().set_title(DEFAULT_TITLE);
        screen_view(outcome)
    }
}

fn screen_view(outcome: Outcome) -> AnyView {
    match outcome {
        Outcome::Redirect(_) => ().into_any(),
        Outcome::Auth(mode) => view! { <AuthPage mode /> }.into_any(),
        Outcome::Invite(token) => view! { <InvitePage token /> }.into_any(),
        Outcome::Home => view! { <HomePage /> }.into_any(),
        Outcome::Trip(trip) => view! { <TripPage trip /> }.into_any(),
        Outcome::Departure(trip) => view! { <DeparturePage trip /> }.into_any(),
        Outcome::Forbidden(page) => view! {
            <MessagePage title="沒有權限查看這個頁面" body=page.body()>
                <HomeLink />
            </MessagePage>
        }
        .into_any(),
        Outcome::NotFound => view! {
            <MessagePage title="找不到這個頁面" body="網址可能打錯了，或這個頁面已經不存在。">
                <HomeOrLoginLink />
            </MessagePage>
        }
        .into_any(),
    }
}

/// 外框使用哪一種頁首。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum HeaderKind {
    /// `.acct-topbar`（Home_Page、Departure_Page、訊息頁）
    #[default]
    Account,
    /// 現行 `accountHeader()` 的 `.topbar`：只用於 Trip_Page（schedule-tab-css-parity 需求 2.1）
    Trip,
}

/// 帳號頁的外框（`shell()`）：頁首、`<main id="main" class="acct-page">` 與頁尾。`current` 為 `"home"` 時，
/// 帳號選單中的「我的旅行」標示為目前的頁面。`class` 取代 `<main>` 的 `acct-page`（Trip_Page 沿用 `trip()` 的
/// `page`）；`header` 選擇頁首（預設為帳號頁的頁首）；`top` 放在頁首與 `<main>` 之間（現行 `.save-warning` 的位置），
/// 例如 Trip_Page 頂端的連線與儲存提示。
#[component]
pub fn Shell(
    #[prop(optional)] current: &'static str,
    #[prop(optional)] class: Option<&'static str>,
    #[prop(optional)] header: HeaderKind,
    #[prop(optional)] top: Option<Children>,
    children: Children,
) -> impl IntoView {
    view! {
        {match header {
            HeaderKind::Account => view! { <Header current /> }.into_any(),
            HeaderKind::Trip => view! { <TripHeader /> }.into_any(),
        }}
        {top.map(|top| top())}
        <main id="main" class=class.unwrap_or("acct-page") tabindex="-1">
            {children()}
        </main>
        <Footer />
    }
}

/// 頁首（`header()`）：品牌標誌與帳號選單。第一版沒有主題切換與管理後台（需求 32.7、design「第一版的範圍」）。
#[component]
fn Header(current: &'static str) -> impl IntoView {
    let user = use_auth().user();
    let brand_href = move || {
        user.with(|user| match user {
            Some(user) => home_path(&user.username),
            None => "/login".to_owned(),
        })
    };
    view! {
        <header class="acct-topbar">
            <div class="acct-topbar-inner">
                <a class="brand" href=brand_href>
                    {art::static_svg(art::LOGO)}
                    <span>
                        "日子拾光 "<small>"LITTLE MOMENTS"</small>
                        <span class="visually-hidden">" 首頁"</span>
                    </span>
                </a>
                <nav class="acct-nav" aria-label="帳號選單">
                    {move || user.get().map(|user| view! { <AccountMenu user current /> })}
                </nav>
            </div>
        </header>
    }
}

/// 主題按鈕的提示：這個版本只有淺色畫面（schedule-tab-css-parity Decision D1）。
const THEME_UNAVAILABLE: &str = "這個版本還不能切換深色模式";

/// Trip_Page 的頁首（現行 `accountHeader()`）：品牌標誌、主題按鈕與帳號選單。LM_Web 沒有 `/admin`，
/// 所以沒有 `.header-admin`。
#[component]
fn TripHeader() -> impl IntoView {
    let user = use_auth().user();
    let brand_href = move || {
        user.with(|user| match user {
            Some(user) => home_path(&user.username),
            None => "/login".to_owned(),
        })
    };
    view! {
        <header class="topbar">
            <div class="topbar-inner">
                <a class="brand" href=brand_href>
                    {art::static_svg(art::LOGO)}
                    <span>
                        "日子拾光 "<small>"LITTLE MOMENTS"</small>
                        <span class="visually-hidden">" 首頁"</span>
                    </span>
                </a>
                {move || user.get().map(|user| view! { <TripHeaderActions user /> })}
            </div>
        </header>
    }
}

/// `.header-actions`：主題按鈕、帳號選單的開合按鈕與 `#header-menu`（「我的首頁」、「登出」）。
#[component]
fn TripHeaderActions(user: ProfileDto) -> impl IntoView {
    let auth = use_auth();
    let toasts = use_toasts();
    // 只在建立時讀一次根元素的 data-theme，決定主題按鈕的圖示與說明（現行 `theme` 預設為 light）
    let dark = document()
        .document_element()
        .and_then(|root| root.get_attribute("data-theme"))
        .is_some_and(|theme| theme == "dark");
    let open = RwSignal::new(false);
    // 點選選單與開合按鈕以外的地方時收起選單
    let listener = window_event_listener(ev::click, move |event| {
        if !open.get_untracked() {
            return;
        }
        let inside = event
            .target()
            .and_then(|target| target.dyn_into::<web_sys::Element>().ok())
            .and_then(|element| {
                element
                    .closest("#header-menu, .header-menu-toggle")
                    .ok()
                    .flatten()
            })
            .is_some();
        if !inside {
            open.set(false);
        }
    });
    on_cleanup(move || listener.remove());
    let initial = initial_of(&user.display_name);
    let home = home_path(&user.username);
    // 登出的請求完成或 5 秒後，登入狀態清除 Session 並前往 /login（需求 4.12）
    let logout = move |_| auth.logout();
    view! {
        <div class="header-actions">
            <button
                class="icon-button header-theme"
                aria-label=if dark { "切換淺色模式" } else { "切換深色模式" }
                on:click=move |_| toasts.show(THEME_UNAVAILABLE)
            >
                {art::static_svg(if dark { icons::SUN } else { icons::MOON })}
            </button>
            <button
                type="button"
                class="icon-button header-menu-toggle"
                aria-expanded=move || open.get().to_string()
                aria-controls="header-menu"
                aria-label=format!("帳號選單：{}", user.display_name)
                title=user.display_name.clone()
                on:click=move |_| open.update(|open| *open = !*open)
            >
                <span class="header-avatar-mark" aria-hidden="true">
                    {initial}
                </span>
            </button>
            <div class="header-collapse" class:open=move || open.get() id="header-menu">
                <a class="text-link header-home" href=home>
                    "我的首頁"
                </a>
                <button class="text-button header-logout" on:click=logout>
                    "登出"
                </button>
            </div>
        </div>
    }
}

/// 顯示名稱的第一個字（`initialOf()`）；空的時候為「?」。
fn initial_of(name: &str) -> String {
    name.trim().chars().next().unwrap_or('?').to_string()
}

/// 已登入時的帳號選單：窄畫面的開合按鈕、「我的旅行」、帳號名稱與登出。
#[component]
fn AccountMenu(user: ProfileDto, current: &'static str) -> impl IntoView {
    let auth = use_auth();
    let open = RwSignal::new(false);
    // 點選選單與開合按鈕以外的地方時收起選單
    let listener = window_event_listener(ev::click, move |event| {
        if !open.get_untracked() {
            return;
        }
        let inside = event
            .target()
            .and_then(|target| target.dyn_into::<web_sys::Element>().ok())
            .and_then(|element| {
                element
                    .closest("#acct-menu, .acct-menu-toggle")
                    .ok()
                    .flatten()
            })
            .is_some();
        if !inside {
            open.set(false);
        }
    });
    on_cleanup(move || listener.remove());
    let initial = initial_of(&user.display_name);
    let home = home_path(&user.username);
    // 登出的請求完成或 5 秒後，登入狀態清除 Session 並前往 /login（需求 4.12）
    let logout = move |_| auth.logout();
    view! {
        <button
            type="button"
            class="icon-button acct-menu-toggle"
            aria-expanded=move || open.get().to_string()
            aria-controls="acct-menu"
            aria-label=format!("帳號選單：{}", user.display_name)
            title=user.display_name.clone()
            on:click=move |_| open.update(|open| *open = !*open)
        >
            <span aria-hidden="true">{initial.clone()}</span>
        </button>
        <div class="acct-collapse" class:open=move || open.get() id="acct-menu">
            <a class="acct-home-link" href=home aria-current=(current == "home").then_some("page")>
                "我的旅行"
            </a>
            <span class="acct-user">
                <span class="avatar small yellow" aria-hidden="true">
                    {initial}
                </span>
                <span class="acct-user-name">
                    <b>{user.display_name}</b>
                    <small>"@"{user.username}</small>
                </span>
            </span>
            <button type="button" class="button small acct-logout" on:click=logout>
                "登出"
            </button>
        </div>
    }
}

/// 頁尾（`footer()`）；第一版沒有場景動畫，所以沒有「畫面偏好」。
#[component]
fn Footer() -> impl IntoView {
    view! {
        <footer class="acct-footer">
            <p class="acct-footer-note">"把日常摺進行囊，沿著喜歡的風，慢慢走成自己的故事。"</p>
        </footer>
    }
}

/// 訊息頁（`messagePage()`）：帳號頁的外框中，左邊是夜晚的插畫，右邊是標題、說明與 `children` 的按鈕。
/// 標題與說明以文字節點輸出；也把文件標題設為「{標題} · 日子拾光」。
#[component]
pub fn MessagePage(
    #[prop(into)] title: String,
    #[prop(into)] body: String,
    children: Children,
) -> impl IntoView {
    document().set_title(&format!("{title} · 日子拾光"));
    view! {
        <Shell>
            <section class="acct-message">
                <div class="acct-message-art">{art::static_svg(Illustration::Night.svg())}</div>
                <div class="acct-message-copy">
                    <h1>{title}</h1>
                    <p>{body}</p>
                    <div class="acct-actions">{children()}</div>
                </div>
            </section>
        </Shell>
    }
}

/// 「回到我的旅行首頁」按鈕；沒有 Session 時不顯示。
#[component]
pub fn HomeLink() -> impl IntoView {
    let user = use_auth().user();
    move || {
        user.get().map(|user| {
            view! {
                <a class="button primary" href=home_path(&user.username)>
                    "回到我的旅行首頁"
                </a>
            }
        })
    }
}

/// 有 Session 時為「回到我的旅行首頁」，沒有 Session 時為前往 `/login` 的「前往登入」（需求 32.11）。
#[component]
fn HomeOrLoginLink() -> impl IntoView {
    let user = use_auth().user();
    move || match user.get() {
        Some(_) => view! { <HomeLink /> }.into_any(),
        None => view! {
            <a class="button primary" href="/login">
                "前往登入"
            </a>
        }
        .into_any(),
    }
}

/// 畫面底部的 Toast（`toast()`）：每則顯示 4.5 秒，新的訊息取代正在顯示的訊息並重新計時；
/// 所在的區域是 `aria-live="polite"`，訊息以文字節點輸出。
#[derive(Clone, Copy)]
pub struct Toasts {
    message: RwSignal<String>,
    visible: RwSignal<bool>,
    /// 已顯示的則數；計時結束時只在仍是同一則時收起
    shown: StoredValue<u64>,
}

impl Toasts {
    /// 建立 Toast 並放進 context；在 App 的最外層、登入狀態之前呼叫一次。
    fn provide() -> Self {
        let toasts = Self {
            message: RwSignal::new(String::new()),
            visible: RwSignal::new(false),
            shown: StoredValue::new(0),
        };
        provide_context(toasts);
        toasts
    }

    /// 顯示一則訊息。
    pub fn show(&self, message: impl Into<String>) {
        let toasts = *self;
        let id = self.shown.get_value() + 1;
        self.shown.set_value(id);
        self.message.set(message.into());
        self.visible.set(true);
        set_timeout(
            move || {
                if toasts.shown.get_value() == id {
                    toasts.visible.set(false);
                }
            },
            TOAST_DURATION,
        );
    }
}

/// 取得 App 提供的 Toast。
pub fn use_toasts() -> Toasts {
    expect_context::<Toasts>()
}
