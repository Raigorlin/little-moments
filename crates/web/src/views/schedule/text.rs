//! 「文字版」區塊與「複製文字」（需求 31.15–31.17、14.5）。
//!
//! 區塊以 `<pre>` 的文字節點顯示 `itinerary_text()` 由 Optimistic_View 產生的 Itinerary_Text（包括 Pending_Command 的
//! 效果）：`<pre>` 保留每個 `\n` 與行內的連續空白，文字節點不被當成 HTML 解讀（需求 31.17、32.6）。文字由 `with_view()`
//! 的 `Memo` 產生，Change_Set 或本機的 Command 套用後，與其他區塊在同一次更新中重算（需求 14.5）。
//!
//! 「複製文字」把按下當時顯示的字串原樣交給 `navigator.clipboard.writeText()`（需求 31.15）：成功時按鈕改為「已複製」；
//! 瀏覽器不提供剪貼簿或拒絕寫入時，選取 `<pre>` 中的整段文字讓使用者手動複製，按鈕改為「複製失敗」（需求 31.16）；
//! 兩者都在 1.8 秒後恢復為「複製文字」，再按一次時重新計時。複製只讀取本機的畫面，離線或 Trip_Channel 重新連線時也可以。
use gloo_timers::callback::Timeout;
use leptos::html;
use leptos::prelude::*;
use leptos::task::spawn_local;
use lm_core::itinerary_text::itinerary_text;

use crate::pages::trip::{use_trip, TripContext};

/// 按鈕文字恢復為「複製文字」之前的毫秒數。
const RESTORE_MS: u32 = 1_800;

/// 「複製文字」按鈕顯示的狀態。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CopyLabel {
    Idle,
    Copied,
    Failed,
}

impl CopyLabel {
    fn text(self) -> &'static str {
        match self {
            Self::Idle => "複製文字",
            Self::Copied => "已複製",
            Self::Failed => "複製失敗",
        }
    }
}

/// 「文字版」區塊。
#[component]
pub(super) fn ItineraryText() -> impl IntoView {
    let TripContext { handle, .. } = use_trip();
    let text = Memo::new(move |_| handle.with_view(itinerary_text).unwrap_or_default());
    let label = RwSignal::new(CopyLabel::Idle);
    let pre = NodeRef::<html::Pre>::new();
    // 進行中的恢復計時；再按一次時取消舊的計時，離開 Schedule_Tab 時一併取消
    let timer = StoredValue::new_local(None::<Timeout>);
    on_cleanup(move || {
        timer.try_update_value(|timer| timer.take());
    });

    let show = move |shown: CopyLabel| {
        label.try_set(shown);
        let restore = Timeout::new(RESTORE_MS, move || {
            label.try_set(CopyLabel::Idle);
        });
        // 取代舊的計時（Timeout 被丟棄時取消）
        timer.try_update_value(|timer| *timer = Some(restore));
    };

    let copy = move |_| {
        // 按下當時顯示的文字
        let shown = text.get_untracked();
        spawn_local(async move {
            if write_clipboard(&shown).await {
                show(CopyLabel::Copied);
            } else {
                if let Some(pre) = pre.get_untracked() {
                    select_contents(&pre);
                }
                show(CopyLabel::Failed);
            }
        });
    };

    view! {
        <section class="schedule-plan" aria-labelledby="itinerary-text-title">
            <div class="section-title">
                <div>
                    <span class="eyebrow">"PLAIN TEXT ITINERARY"</span>
                    <h2 id="itinerary-text-title">"文字版"</h2>
                </div>
                <button type="button" class="button small" on:click=copy>
                    {move || label.get().text()}
                </button>
            </div>
            <pre node_ref=pre>{move || text.get()}</pre>
        </section>
    }
}

/// 以 `navigator.clipboard.writeText()` 寫入純文字；瀏覽器不提供剪貼簿（例如不是安全的來源）或拒絕寫入時回傳 `false`。
#[cfg(target_arch = "wasm32")]
async fn write_clipboard(text: &str) -> bool {
    use wasm_bindgen::JsCast;

    let Some(window) = web_sys::window() else {
        return false;
    };
    let navigator = window.navigator();
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

/// 選取元素中的整段文字（選取範圍恰好是它的全部子節點），讓使用者手動複製（需求 31.16）。
fn select_contents(element: &web_sys::HtmlElement) {
    let Some(selection) =
        web_sys::window().and_then(|window| window.get_selection().ok().flatten())
    else {
        return;
    };
    let _ = selection.select_all_children(element);
}
