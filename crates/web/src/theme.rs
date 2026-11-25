//! 深色模式（現行 `src/app.js` 的 `theme` 與 `src/accounts-ui.js` 的 `setTheme()`）。
//!
//! 主題存在 localStorage 的 `ggc-local-theme`（與 Bun 的 `THEMES_KEY` 相同），值為 `dark` 或 `light`，預設為淺色，
//! 不跟隨系統的 `prefers-color-scheme`（同 Bun）。主題以根元素的 `data-theme` 套用：styles.css 等樣式檔的
//! `:root[data-theme=dark]` 規則，以及行程表工作室的 MutationObserver（`views::studio::host`）都讀這個屬性。
use leptos::prelude::*;

use crate::art;
use crate::views::icons;

/// localStorage 中主題的 key（Bun `src/model.js` 的 `THEMES_KEY`）。
const THEME_KEY: &str = "ggc-local-theme";

/// 目前的主題；在 App 的最外層建立一次並放進 context。
#[derive(Clone, Copy)]
pub struct Theme {
    dark: RwSignal<bool>,
}

fn storage() -> Option<web_sys::Storage> {
    web_sys::window()?.local_storage().ok().flatten()
}

fn set_root_theme(dark: bool) {
    if let Some(root) = document().document_element() {
        let _ = root.set_attribute("data-theme", if dark { "dark" } else { "light" });
    }
}

impl Theme {
    /// 讀取存下的主題並套用到根元素。沒有存過主題時不改動根元素：沒有 `data-theme` 時是淺色主題
    /// （schedule-tab-css-parity 需求 6），已經有 `data-theme` 時（例如測試預先設定）沿用它。
    pub fn provide() -> Self {
        let stored = storage()
            .and_then(|storage| storage.get_item(THEME_KEY).ok().flatten())
            .map(|theme| theme == "dark");
        let dark = match stored {
            Some(dark) => {
                set_root_theme(dark);
                dark
            }
            None => document()
                .document_element()
                .and_then(|root| root.get_attribute("data-theme"))
                .is_some_and(|theme| theme == "dark"),
        };
        let theme = Self {
            dark: RwSignal::new(dark),
        };
        provide_context(theme);
        theme
    }

    /// 是否為深色主題（會追蹤變化）。
    pub fn is_dark(&self) -> bool {
        self.dark.get()
    }

    /// 切換深色與淺色，套用到根元素並存下；無法寫入 localStorage 時只在這次瀏覽中生效。
    pub fn toggle(&self) {
        let dark = !self.dark.get_untracked();
        set_root_theme(dark);
        if let Some(storage) = storage() {
            let _ = storage.set_item(THEME_KEY, if dark { "dark" } else { "light" });
        }
        self.dark.set(dark);
    }
}

/// 取得 App 提供的主題。
pub fn use_theme() -> Theme {
    expect_context::<Theme>()
}

/// 主題按鈕：深色時顯示太陽、淺色時顯示月亮。`class` 是按鈕的 class，`light_label` 與 `dark_label` 是
/// 目前為淺色與深色時的說明（Trip_Page 的頁首與帳號頁的頁首用字不同，同 Bun）。`typed` 時加上
/// `type="button"`（帳號頁的頁首有，Trip_Page 的頁首沒有，同 Bun 的標記）。
#[component]
pub fn ThemeButton(
    class: &'static str,
    light_label: &'static str,
    dark_label: &'static str,
    #[prop(optional)] typed: bool,
) -> impl IntoView {
    let theme = use_theme();
    view! {
        <button
            type=typed.then_some("button")
            class=class
            aria-label=move || if theme.is_dark() { dark_label } else { light_label }
            on:click=move |_| theme.toggle()
        >
            {move || art::static_svg(if theme.is_dark() { icons::SUN } else { icons::MOON })}
        </button>
    }
}
