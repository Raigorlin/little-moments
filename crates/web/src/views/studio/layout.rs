//! 工作室的版面（`src/storybook/template.js`，相同的 id、class、文字與 aria）與它的操作（`src/storybook/app.js` 的
//! `setEditorHidden()`、`createWorkspace()` 與分隔線）。
//!
//! - 左邊是預覽（`main.stage`）：「收起編輯器」與「行程手帖」（[`super::journal::Journal`]）。Bun 以 CSS 隱藏的海報、
//!   匯出與文字版區塊不繪製。
//! - 中間是分隔線（`#editorSplitter`）：拖曳或以方向鍵調整編輯器寬度，放開時記住。
//! - 右邊是編輯器（`aside#editorPanel`）：頁首（儲存狀態、復原、重做）與「行程／封面／地點與車」分頁；三個分頁的內容由
//!   編輯器的任務填入。
//! - 窄版（宿主窄於 900px，編輯器收起時 560px）一次只顯示一邊，底部是「✎ 編輯／◫ 預覽海報」切換。
use leptos::ev;
use leptos::html;
use leptos::prelude::*;

use wasm_bindgen::JsCast;

use super::assets_tab::AssetsPanel;
use super::cover_tab::CoverPanel;
use super::editor::Editor;
use super::journal::Journal;
use super::plan_tab::PlanPanel;
use super::{use_studio, EditorTab, MobileView, KEY_STEP, MIN_WIDTH, PREVIEW_MIN};
use crate::pages::trip::{use_trip, TripContext};

/// 工作室的根元素 `div.studio[data-studio-root]`。
#[component]
pub(super) fn StudioRoot() -> impl IntoView {
    let studio = use_studio();
    let TripContext { handle, .. } = use_trip();
    let editor = Editor::new(handle, studio);
    provide_context(editor);
    let layout = NodeRef::<html::Div>::new();
    let splitter = NodeRef::<html::Div>::new();
    let switch = NodeRef::<html::Nav>::new();
    // 拖曳中的指標
    let pointer = StoredValue::new(None::<i32>);

    let root_class = move || {
        let mut class = String::from("studio");
        for (on, name) in [
            (studio.narrow.get(), " narrow"),
            (studio.collapsed.get(), " collapsed"),
            (studio.mobile_view.get() == MobileView::Editor, " editing"),
            (studio.dark.get(), " dark"),
        ] {
            if on {
                class.push_str(name);
            }
        }
        class
    };
    let layout_class = move || {
        // 順序同 Bun 開啟時的 classList（editor-hidden 在 editor-wide 之前加入）
        let mut class = String::from("layout");
        for (on, name) in [
            (studio.editor_hidden.get(), " editor-hidden"),
            (true, " editor-wide"),
            (
                studio.mobile_view.get() == MobileView::Preview,
                " mobile-preview",
            ),
            (studio.resizing.get(), " resizing"),
        ] {
            if on {
                class.push_str(name);
            }
        }
        class
    };

    let on_splitter_key = move |event: ev::KeyboardEvent| {
        let width = studio.width.get_untracked();
        let next = match event.key().as_str() {
            "ArrowLeft" => width + KEY_STEP,
            "ArrowRight" => width - KEY_STEP,
            "Home" => MIN_WIDTH,
            "End" => studio.host_width() - PREVIEW_MIN,
            _ => return,
        };
        event.prevent_default();
        studio.set_width(f64::from(next), true, studio.host_width());
    };
    let on_pointer_down = move |event: ev::PointerEvent| {
        if event.button() != 0 || studio.narrow.get_untracked() {
            return;
        }
        pointer.set_value(Some(event.pointer_id()));
        if let Some(splitter) = splitter.get_untracked() {
            let _ = splitter.set_pointer_capture(event.pointer_id());
        }
        studio.resizing.set(true);
        event.prevent_default();
    };
    let on_pointer_move = move |event: ev::PointerEvent| {
        if pointer.get_value() != Some(event.pointer_id()) {
            return;
        }
        if let Some(layout) = layout.get_untracked() {
            let right = layout.get_bounding_client_rect().right();
            studio.set_width(
                right - f64::from(event.client_x()) - 20.0,
                false,
                studio.host_width(),
            );
        }
    };
    let end_drag = move |_: ev::PointerEvent| {
        if pointer.get_value().is_none() {
            return;
        }
        pointer.set_value(None);
        studio.resizing.set(false);
        studio.set_width(
            f64::from(studio.width.get_untracked()),
            true,
            studio.host_width(),
        );
    };
    let lost_capture = move |_: ev::PointerEvent| {
        pointer.set_value(None);
        studio.resizing.set(false);
    };

    let tabs = EditorTab::ALL
        .into_iter()
        .map(|tab| {
            let selected = move || studio.tab.get() == tab;
            view! {
                <button
                    type="button"
                    id=format!("tab-{}", tab.key())
                    role="tab"
                    data-tab=tab.key()
                    aria-controls=format!("panel-{}", tab.key())
                    aria-selected=move || selected().to_string()
                    tabindex=move || if selected() { "0" } else { "-1" }
                    on:click=move |_| {
                        editor.show_tab(tab);
                    }
                >
                    {tab.label()}
                </button>
            }
        })
        .collect_view();
    // Bun createWorkspace()：分頁以方向鍵、Home 與 End 切換
    let on_tabs_key = move |event: ev::KeyboardEvent| {
        let Some(index) = event
            .target()
            .and_then(|target| target.dyn_into::<web_sys::Element>().ok())
            .and_then(|target| target.get_attribute("data-tab"))
            .and_then(|key| EditorTab::parse(&key))
            .and_then(|tab| EditorTab::ALL.iter().position(|item| *item == tab))
        else {
            return;
        };
        let count = EditorTab::ALL.len();
        let next = match event.key().as_str() {
            "Home" => 0,
            "End" => count - 1,
            "ArrowRight" => (index + 1) % count,
            "ArrowLeft" => (index + count - 1) % count,
            _ => return,
        };
        event.prevent_default();
        let tab = EditorTab::ALL[next];
        if editor.show_tab(tab) {
            if let Some(button) = editor.element(&format!("tab-{}", tab.key())) {
                button.focus().ok();
            }
        }
    };
    let panels = EditorTab::ALL
        .into_iter()
        .map(|tab| {
            let content = match tab {
                EditorTab::Plan => view! { <PlanPanel /> }.into_any(),
                EditorTab::Cover => view! { <CoverPanel /> }.into_any(),
                EditorTab::Assets => view! { <AssetsPanel /> }.into_any(),
            };
            view! {
                <section
                    class="panel"
                    id=format!("panel-{}", tab.key())
                    data-editor-panel=tab.key()
                    role="tabpanel"
                    aria-labelledby=format!("tab-{}", tab.key())
                    hidden=move || studio.tab.get() != tab
                >
                    {content}
                </section>
            }
        })
        .collect_view();
    // Bun：在文字欄位以外按 Ctrl／Cmd+Z 復原，加 Shift 重做
    let on_root_key = move |event: ev::KeyboardEvent| {
        if !(event.ctrl_key() || event.meta_key()) || event.key().to_lowercase() != "z" {
            return;
        }
        let in_text = event
            .target()
            .and_then(|target| target.dyn_into::<web_sys::Element>().ok())
            .is_some_and(|target| {
                target
                    .matches("input,textarea,[contenteditable]")
                    .unwrap_or(false)
            });
        if in_text {
            return;
        }
        event.prevent_default();
        editor.travel(!event.shift_key());
    };
    let status = move || editor.status();

    view! {
        <div class=root_class data-studio-root="" on:keydown=on_root_key>
            <header class="topbar" hidden=true>
                <div class="brand">
                    <strong>"旅行繪本"</strong>
                    <span class="accent">"Storybook Trip Studio"</span>
                </div>
            </header>
            <p class="print-draft" id="printDraft" hidden=true>
                "此為尚未儲存的草稿，與伺服器上的行程不同。"
            </p>
            <div
                class=layout_class
                id="layout"
                style=move || format!("--editor-width:{}px", studio.width.get())
                node_ref=layout
            >
                <main class="stage" aria-label="海報">
                    <p
                        id="message"
                        role="status"
                        aria-live="polite"
                        class=move || editor.notice_class("message")
                    >
                        {move || editor.notice_text()}
                    </p>
                    <p class="hint stage-hint" id="previewHint" hidden=true>
                        "點海報上的任一天，就會打開那一天的編輯；也可以用 Tab 鍵選到日期區塊後按 Enter。"
                    </p>
                    <div class="stage-bar">
                        <button
                            type="button"
                            id="toggleEditor"
                            aria-expanded=move || (!studio.editor_hidden.get()).to_string()
                            aria-controls="editorPanel"
                            on:click=move |_| studio.toggle_editor()
                        >
                            {move || {
                                if studio.editor_hidden.get() { "展開編輯器" } else { "收起編輯器" }
                            }}
                        </button>
                    </div>
                    <Journal />
                </main>
                <div
                    class="splitter"
                    id="editorSplitter"
                    role="separator"
                    tabindex="0"
                    aria-orientation="vertical"
                    aria-controls="editorPanel"
                    aria-label="調整編輯器寬度（左右方向鍵）"
                    aria-valuemin=MIN_WIDTH.to_string()
                    aria-valuemax=move || studio.width_max.get().to_string()
                    aria-valuenow=move || studio.width.get().to_string()
                    aria-valuetext=move || format!("編輯區寬度 {} 像素", studio.width.get())
                    node_ref=splitter
                    on:keydown=on_splitter_key
                    on:pointerdown=on_pointer_down
                    on:pointermove=on_pointer_move
                    on:pointerup=end_drag
                    on:pointercancel=end_drag
                    on:lostpointercapture=lost_capture
                >
                    <span class="splitter-grip" aria-hidden="true"></span>
                </div>
                <aside class="editor" id="editorPanel" aria-label="編輯器">
                    <form
                        id="editorForm"
                        novalidate=true
                        on:submit=|event: ev::SubmitEvent| event.prevent_default()
                    >
                        <fieldset id="editorFields">
                            <legend class="sr">"行程編輯"</legend>
                            <header class="editor-header" id="editorHeader">
                                <div class="editor-actions">
                                    <button type="button" id="saveTrip" class="primary" hidden=true>
                                        "儲存行程"
                                    </button>
                                    <span
                                        id="saveStatus"
                                        class=move || {
                                            if status() == "已儲存" { "status" } else { "status dirty" }
                                        }
                                        aria-live="polite"
                                        title=status
                                    >
                                        {status}
                                    </span>
                                    <span class="editor-actions-end">
                                        <button
                                            type="button"
                                            id="undoEdit"
                                            class="icon"
                                            aria-label="復原"
                                            title="復原（Ctrl+Z）"
                                            disabled=move || editor.history.sizes().0 == 0
                                            on:click=move |_| editor.travel(true)
                                        >
                                            "↶"
                                            <span class="label-text">"復原"</span>
                                        </button>
                                        <button
                                            type="button"
                                            id="redoEdit"
                                            class="icon"
                                            aria-label="重做"
                                            title="重做（Ctrl+Shift+Z）"
                                            disabled=move || editor.history.sizes().1 == 0
                                            on:click=move |_| editor.travel(false)
                                        >
                                            "↷"
                                            <span class="label-text">"重做"</span>
                                        </button>
                                        <button
                                            type="button"
                                            id="wideEditor"
                                            class="icon"
                                            hidden=true
                                            aria-pressed="true"
                                            aria-label="加寬編輯器"
                                            title="加寬編輯器"
                                        >
                                            "⇔"
                                            <span class="label-text">"加寬"</span>
                                        </button>
                                    </span>
                                </div>
                                <div
                                    class="editor-tabs"
                                    id="editorTabs"
                                    role="tablist"
                                    aria-label="編輯項目"
                                    on:keydown=on_tabs_key
                                >
                                    {tabs}
                                </div>
                                <p
                                    class=move || editor.notice_class("editor-notice")
                                    id="editorNotice"
                                    role="status"
                                    aria-live="polite"
                                    hidden=move || editor.notice_hidden()
                                >
                                    {move || editor.notice_text()}
                                </p>
                            </header>
                            {panels}
                        </fieldset>
                    </form>
                </aside>
            </div>
            <nav
                class="workspace-switch"
                id="workspaceSwitch"
                aria-label="切換編輯或預覽"
                node_ref=switch
            >
                <button
                    type="button"
                    id="viewEditor"
                    aria-pressed=move || (studio.mobile_view.get() == MobileView::Editor).to_string()
                    aria-controls="editorPanel"
                    on:click=move |_| studio.set_mobile_view(MobileView::Editor)
                >
                    "✎ 編輯"
                </button>
                <button
                    type="button"
                    id="viewPreview"
                    aria-pressed=move || (studio.mobile_view.get() == MobileView::Preview).to_string()
                    aria-controls="journal"
                    on:click=move |_| {
                        studio.set_mobile_view(MobileView::Preview);
                        if let Some(switch) = switch.get_untracked() {
                            switch.scroll_into_view_with_bool(true);
                        }
                    }
                >
                    "◫ 預覽海報"
                </button>
            </nav>
        </div>
    }
}
