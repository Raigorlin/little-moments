//! Schedule_Tab 的旅行繪本工作室（Bun `src/storybook/`，rust-schedule-studio Decision D5）。
//!
//! - [`host`]：Trip_Page 中的 `.story-studio-host`；工作室掛在它的 open Shadow Root 中，樣式是與 Bun
//!   `src/storybook/style.css` 逐字相同的 `styles/storybook-studio.css`，網站的樣式不會套進去。
//! - [`layout`]：`src/storybook/template.js` 的版面（相同的 id、class、文字與 aria），以及 `app.js` 的編輯器收合、
//!   分隔線、窄版的「編輯／預覽」切換與深色主題。
//! - [`journal`] 與 [`doodles`]：「行程手帖」預覽（`journal.js`），由 `lm_core::storybook::studio_plan()` 產生。
//!
//! 工作室的畫面狀態放在 [`StudioUi`]（`Copy`，以 context 提供），選定的日子沿用 `UiState::schedule_day`。Bun 在 studio 根
//! 元素上停止事件傳遞的迴圈（`bind()`）沒有移植：Leptos 的事件直接掛在元素上，網站的其他處理不會收到工作室的事件。
mod doodles;
mod host;
mod journal;
mod layout;

pub use host::Studio;

use leptos::prelude::*;
use lm_core::model::TripState;

use crate::pages::trip::UiState;

/// 編輯器寬度的偏好（使用者拖曳分隔線之後記住；與 Bun 相同的鍵）。
const WIDTH_KEY: &str = "storybook-editor-width-v2";
/// 編輯器是否收起的偏好（`1` 收起、`0` 展開；與 Bun 相同的鍵）。
const HIDDEN_KEY: &str = "storybook-editor-hidden-v2";
/// 編輯器的最小寬度。
const MIN_WIDTH: i32 = 360;
/// 編輯器的最大寬度。
const MAX_WIDTH: i32 = 900;
/// 並排時預覽至少保留的寬度。
const PREVIEW_MIN: i32 = 380;
/// 宿主窄於這個寬度時一次只顯示編輯器或預覽；編輯器收起時是 [`NARROW_COLLAPSED`]。
const NARROW: i32 = 900;
/// 編輯器收起時，宿主窄於這個寬度才改用窄版。
const NARROW_COLLAPSED: i32 = 560;
/// 分隔線每按一次方向鍵改變的寬度。
const KEY_STEP: i32 = 24;

/// 編輯器的分頁（template.js `#editorTabs`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EditorTab {
    Plan,
    Cover,
    Assets,
}

impl EditorTab {
    pub(crate) const ALL: [EditorTab; 3] = [EditorTab::Plan, EditorTab::Cover, EditorTab::Assets];

    /// `data-tab` 與 id 的後綴。
    pub(crate) const fn key(self) -> &'static str {
        match self {
            EditorTab::Plan => "plan",
            EditorTab::Cover => "cover",
            EditorTab::Assets => "assets",
        }
    }

    pub(crate) const fn label(self) -> &'static str {
        match self {
            EditorTab::Plan => "行程",
            EditorTab::Cover => "封面",
            EditorTab::Assets => "地點與車",
        }
    }
}

/// 「行程」分頁中這一天要編輯的內容（template.js `.subnav`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PlanSection {
    Routes,
    Events,
}

/// 窄版一次顯示的畫面（`#workspaceSwitch`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MobileView {
    Editor,
    Preview,
}

/// 工作室的畫面狀態（Bun `mountStudio()` 與 `createWorkspace()` 的變數）。signal 屬於工作室的宿主元件，離開
/// Schedule_Tab 時釋放；只有編輯器的寬度與收合以 localStorage 記住。
#[derive(Clone, Copy)]
pub(crate) struct StudioUi {
    /// 選定的第 N 天（`UiState::schedule_day`，0 為第 1 天）
    pub day: RwSignal<usize>,
    pub tab: RwSignal<EditorTab>,
    /// 「行程」分頁的路線或活動（編輯器的內容讀取）
    #[allow(dead_code)]
    pub section: RwSignal<PlanSection>,
    pub mobile_view: RwSignal<MobileView>,
    pub editor_hidden: RwSignal<bool>,
    /// 宿主窄於 [`NARROW`]（編輯器收起時 [`NARROW_COLLAPSED`]）
    pub narrow: RwSignal<bool>,
    /// 編輯器收起而且不是窄版
    pub collapsed: RwSignal<bool>,
    /// 編輯器的寬度（`--editor-width`）與分隔線允許的最大寬度
    pub width: RwSignal<i32>,
    pub width_max: RwSignal<i32>,
    /// 正在拖曳分隔線
    pub resizing: RwSignal<bool>,
    /// 網站是深色主題（`<html data-theme="dark">`）
    pub dark: RwSignal<bool>,
    /// 使用者拖曳或以方向鍵調整過寬度（之後不再依宿主寬度計算）
    user_sized: StoredValue<bool>,
    /// 最近一次量到的宿主寬度；0 是還沒有量到
    host_width: StoredValue<i32>,
    host: StoredValue<Option<web_sys::HtmlElement>, LocalStorage>,
}

/// 這個瀏覽器的 localStorage；無法使用時（例如隱私模式拒絕）是 `None`。
fn storage() -> Option<web_sys::Storage> {
    web_sys::window()?.local_storage().ok().flatten()
}

fn read_pref(key: &str) -> Option<String> {
    storage()?.get_item(key).ok().flatten()
}

/// 寫入偏好；無法寫入時略過（偏好而已）。
fn write_pref(key: &str, value: &str) {
    if let Some(storage) = storage() {
        let _ = storage.set_item(key, value);
    }
}

/// `matchMedia(query).matches`；瀏覽器不支援時是 `false`。
fn media_matches(query: &str) -> bool {
    web_sys::window()
        .and_then(|window| window.match_media(query).ok().flatten())
        .is_some_and(|list| list.matches())
}

/// 這一天有路線時編輯路線，否則編輯活動（Bun `selectDay()`）。
fn section_for(state: &TripState, day: usize) -> PlanSection {
    let card = &state.card;
    let date = lm_core::time::date_range(card.start, card.end)
        .get(day)
        .copied();
    if date.is_some_and(|date| state.routes.values().any(|route| route.day == date)) {
        PlanSection::Routes
    } else {
        PlanSection::Events
    }
}

impl StudioUi {
    /// Bun `start()` 與 `createWorkspace()` 的初始狀態：編輯器預設收起，只有使用者上次展開（偏好為 `0`）時展開；
    /// 收起時窄版先顯示預覽。窄版先依視窗寬度猜測，量到宿主寬度之後由 [`StudioUi::apply_width_class`] 更正。
    fn new(ui: UiState, section: PlanSection) -> StudioUi {
        let hidden = read_pref(HIDDEN_KEY).as_deref() != Some("0");
        let (width, user_sized) =
            match read_pref(WIDTH_KEY).and_then(|pref| pref.parse::<f64>().ok()) {
                Some(pref) if (f64::from(MIN_WIDTH)..=f64::from(MAX_WIDTH)).contains(&pref) => {
                    (pref.round() as i32, true)
                }
                _ => (480, false),
            };
        let threshold = if hidden { NARROW_COLLAPSED } else { NARROW } + 60;
        let narrow = media_matches(&format!("(max-width:{threshold}px)"));
        StudioUi {
            day: ui.schedule_day,
            tab: RwSignal::new(EditorTab::Plan),
            section: RwSignal::new(section),
            mobile_view: RwSignal::new(if hidden {
                MobileView::Preview
            } else {
                MobileView::Editor
            }),
            editor_hidden: RwSignal::new(hidden),
            narrow: RwSignal::new(narrow),
            collapsed: RwSignal::new(false),
            width: RwSignal::new(width),
            width_max: RwSignal::new(MAX_WIDTH),
            resizing: RwSignal::new(false),
            dark: RwSignal::new(false),
            user_sized: StoredValue::new(user_sized),
            host_width: StoredValue::new(0),
            host: StoredValue::new_local(None),
        }
    }

    fn set_host(&self, host: web_sys::HtmlElement) {
        self.host.set_value(Some(host));
    }

    /// Bun `hostWidth()`：宿主的寬度（border box）；量到一次之後沿用 ResizeObserver 給的值。還沒有掛上時是 960，最少 320。
    fn host_width(&self) -> i32 {
        let cached = self.host_width.get_value();
        if cached > 0 {
            return cached;
        }
        let measured = self.host.with_value(|host| {
            host.as_ref().map_or(0.0, |host| {
                let width = host.get_bounding_client_rect().width();
                if width > 0.0 {
                    width
                } else {
                    f64::from(host.client_width())
                }
            })
        });
        if measured > 0.0 {
            self.host_width.set_value(measured.round() as i32);
        }
        let width = if measured > 0.0 { measured } else { 960.0 };
        (width.round() as i32).max(320)
    }

    /// ResizeObserver 量到的寬度；0 表示宿主已不在畫面中，下次重新量測。
    fn observed_width(&self, width: f64) {
        let rounded = if width > 0.0 { width.round() as i32 } else { 0 };
        if self.host_width.try_set_value(rounded).is_some() {
            return;
        }
        self.apply_width_class(width);
    }

    /// Bun `setWidth()`：編輯器的寬度限制在 360 到 min(900, 宿主寬度 − 380) 之間（窄版是 900）；`persist` 時記住。
    fn set_width(&self, value: f64, persist: bool, host_width: i32) {
        let max = if self.narrow.get_untracked() {
            MAX_WIDTH
        } else {
            MIN_WIDTH.max(MAX_WIDTH.min(host_width - PREVIEW_MIN))
        };
        let width = value.max(f64::from(MIN_WIDTH)).min(f64::from(max)).round() as i32;
        self.width.set(width);
        self.width_max.set(max);
        if persist {
            self.user_sized.set_value(true);
            write_pref(WIDTH_KEY, &width.to_string());
        }
    }

    /// Bun `applyWidthClass()`：依宿主的寬度決定窄版與收合，再重新限制編輯器的寬度；沒有調整過寬度時是宿主寬度的 53%。
    fn apply_width_class(&self, measured: f64) {
        let host_width = if measured > 0.0 {
            (measured.round() as i32).max(320)
        } else {
            self.host_width()
        };
        let hidden = self.editor_hidden.get_untracked();
        let narrow = host_width < if hidden { NARROW_COLLAPSED } else { NARROW };
        if narrow != self.narrow.get_untracked() {
            self.narrow.set(narrow);
        }
        self.collapsed.set(hidden && !narrow);
        let width = if self.user_sized.get_value() {
            f64::from(self.width.get_untracked())
        } else {
            (f64::from(host_width) * 0.53).floor()
        };
        self.set_width(width, false, host_width);
    }

    /// Bun `setEditorHidden()`：收起或展開編輯器；`persist` 時記住使用者的選擇。
    fn set_editor_hidden(&self, hidden: bool, persist: bool) {
        self.editor_hidden.set(hidden);
        if persist {
            write_pref(HIDDEN_KEY, if hidden { "1" } else { "0" });
        }
    }

    /// Bun `setMobileView()`：顯示編輯器時一併展開編輯器（不記住）。
    fn set_mobile_view(&self, view: MobileView) {
        self.mobile_view.set(view);
        if view == MobileView::Editor {
            self.editor_hidden.set(false);
        }
    }

    /// 「收起編輯器」／「展開編輯器」。
    fn toggle_editor(&self) {
        let hidden = !self.editor_hidden.get_untracked();
        self.set_editor_hidden(hidden, true);
        self.set_mobile_view(if hidden {
            MobileView::Preview
        } else {
            MobileView::Editor
        });
        self.apply_width_class(0.0);
    }

    /// Bun `showTab()`。
    fn show_tab(&self, tab: EditorTab) {
        self.tab.set(tab);
    }

    /// Bun `selectDay()`：選定第 `index` 天（0 起），顯示「行程」分頁與這一天的路線（沒有路線時是活動）。
    fn select_day(&self, index: usize, section: PlanSection) {
        self.day.set(index);
        self.show_tab(EditorTab::Plan);
        self.section.set(section);
    }

    /// 手帖日卡上的「編輯這一天」（Bun `onEditDay`）：編輯器收起時不做事；否則選定那一天並顯示編輯器。
    fn edit_day(&self, index: usize, section: PlanSection) {
        if self.editor_hidden.get_untracked() {
            return;
        }
        self.select_day(index, section);
        self.set_mobile_view(MobileView::Editor);
    }
}

/// 取得工作室宿主提供的 [`StudioUi`]。
fn use_studio() -> StudioUi {
    expect_context::<StudioUi>()
}
