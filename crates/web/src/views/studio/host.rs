//! 工作室的宿主 `.story-studio-host`（Bun `mountStoryAfterRender()` 與 `mountStudio()`）。
//!
//! 宿主掛上之後，在它的 open Shadow Root 中以 `leptos::mount::mount_to` 繪製工作室（與 `leptos::Portal` 的
//! `use_shadow` 相同的作法）：新的 Owner 是這個元件之下的子 Owner，所以工作室仍取得 `use_trip()` 與 [`StudioUi`]。
//! Shadow Root 的第一個子元素是 `<style>`，內容是與 Bun `src/storybook/style.css` 逐字相同的樣式。
//!
//! 宿主另外以 ResizeObserver 量測自己的寬度（窄版與編輯器寬度依宿主而不是視窗決定，Decision D4），以 MutationObserver
//! 跟著網站的深色主題，並以 `data-editor-hidden` 告訴頁面的版面編輯器是否收起（storybook-host.css 依它顯示側欄）。
//! 離開 Schedule_Tab 時拆掉工作室與兩個 Observer。
use leptos::html;
use leptos::prelude::*;
use lm_core::time::date_range;
use wasm_bindgen::closure::Closure;
use wasm_bindgen::JsCast;

use super::layout::StudioRoot;
use super::{section_for, PlanSection, StudioUi};
use crate::pages::trip::{use_trip, TripContext};

/// 工作室的樣式，與 Bun `src/storybook/style.css` 逐字相同（tests/storybook-studio-parity.test.js）。
const STUDIO_CSS: &str = include_str!("../../../styles/storybook-studio.css");

/// 宿主寬度的 ResizeObserver；drop 時停止觀察。
struct ResizeWatch {
    observer: web_sys::ResizeObserver,
    _callback: Closure<dyn FnMut(js_sys::Array)>,
}

impl ResizeWatch {
    /// Bun `createWorkspace()` 的 ResizeObserver：以 border box 的寬度（沒有時以 content rect）更新版面。
    fn new(target: &web_sys::Element, studio: StudioUi) -> Option<ResizeWatch> {
        let callback = Closure::<dyn FnMut(js_sys::Array)>::new(move |entries: js_sys::Array| {
            let Ok(entry) = entries.at(-1).dyn_into::<web_sys::ResizeObserverEntry>() else {
                return;
            };
            let width = entry
                .border_box_size()
                .at(0)
                .dyn_into::<web_sys::ResizeObserverSize>()
                .map(|size| size.inline_size())
                .unwrap_or_else(|_| entry.content_rect().width());
            studio.observed_width(width);
        });
        let observer = web_sys::ResizeObserver::new(callback.as_ref().unchecked_ref()).ok()?;
        observer.observe(target);
        Some(ResizeWatch {
            observer,
            _callback: callback,
        })
    }
}

impl Drop for ResizeWatch {
    fn drop(&mut self) {
        self.observer.disconnect();
    }
}

/// `<html data-theme>` 的 MutationObserver：網站切換深色主題時工作室跟著切換（Bun `bind()` 的 `syncTheme`）。
struct ThemeWatch {
    observer: web_sys::MutationObserver,
    _callback: Closure<dyn FnMut(js_sys::Array)>,
}

/// 網站目前是否為深色主題。
fn dark_theme() -> bool {
    document()
        .document_element()
        .and_then(|root| root.get_attribute("data-theme"))
        .as_deref()
        == Some("dark")
}

impl ThemeWatch {
    fn new(studio: StudioUi) -> Option<ThemeWatch> {
        studio.dark.set(dark_theme());
        let callback = Closure::<dyn FnMut(js_sys::Array)>::new(move |_records: js_sys::Array| {
            studio.dark.try_set(dark_theme());
        });
        let observer = web_sys::MutationObserver::new(callback.as_ref().unchecked_ref()).ok()?;
        let options = web_sys::MutationObserverInit::new();
        options.set_attributes(true);
        options.set_attribute_filter(&js_sys::Array::of1(&"data-theme".into()));
        let root = document().document_element()?;
        observer.observe_with_options(&root, &options).ok()?;
        Some(ThemeWatch {
            observer,
            _callback: callback,
        })
    }
}

impl Drop for ThemeWatch {
    fn drop(&mut self) {
        self.observer.disconnect();
    }
}

/// 掛在 Shadow Root 中的工作室與宿主的 Observer。
struct Mounted {
    _view: Box<dyn std::any::Any>,
    _resize: Option<ResizeWatch>,
    _theme: Option<ThemeWatch>,
}

/// 旅行繪本工作室（Schedule_Tab 的內容）。
#[component]
pub fn Studio() -> impl IntoView {
    let TripContext { handle, ui, .. } = use_trip();
    let initial = untrack(|| {
        handle
            .with_view(|state| section_for(state, ui.schedule_day.get_untracked()))
            .unwrap_or(PlanSection::Routes)
    });
    let studio = StudioUi::new(ui, initial);
    provide_context(studio);

    // 需求 22.16：旅行的天數少於選定的第 N 天時改選最後一天
    let days = Memo::new(move |_| {
        handle
            .with_view(|state| date_range(state.card.start, state.card.end).len())
            .unwrap_or(0)
    });
    Effect::new(move |_| {
        let len = days.get();
        if len > 0 && studio.day.get() >= len {
            studio.day.set(len - 1);
        }
    });

    let host = NodeRef::<html::Div>::new();
    let mounted = StoredValue::new_local(None::<Mounted>);
    Effect::new(move |_| {
        let Some(element) = host.get() else {
            return;
        };
        if mounted.with_value(Option::is_some) {
            return;
        }
        let element: web_sys::HtmlElement = element.into();
        studio.set_host(element.clone());
        let root = match element.shadow_root() {
            Some(root) => root,
            None => match element
                .attach_shadow(&web_sys::ShadowRootInit::new(web_sys::ShadowRootMode::Open))
            {
                Ok(root) => root,
                Err(_) => return,
            },
        };
        // 不讓這個 Effect 追蹤工作室繪製時讀到的 signal：Effect 重跑會釋放工作室的 Owner
        let view = untrack(|| {
            leptos::mount::mount_to(root.unchecked_into(), move || {
                view! {
                    <style>{STUDIO_CSS}</style>
                    <StudioRoot />
                }
            })
        });
        let resize = ResizeWatch::new(&element, studio);
        let theme = ThemeWatch::new(studio);
        mounted.set_value(Some(Mounted {
            _view: Box::new(view),
            _resize: resize,
            _theme: theme,
        }));
        untrack(|| studio.apply_width_class(0.0));
    });
    on_cleanup(move || {
        mounted.try_update_value(|mounted| drop(mounted.take()));
    });

    view! {
        <div
            class="story-studio-host"
            role="region"
            aria-label="旅行繪本工作室"
            node_ref=host
            data-editor-hidden=move || studio.editor_hidden.get().then_some("")
        ></div>
    }
}
