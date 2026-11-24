//! 編輯器的「封面」分頁（template.js `#panel-cover`）：大標題、旅程名稱、出發日期與底部短語，各以 `UpdateTrip` 送出。
use leptos::prelude::*;
use lm_core::command::{Command, DateSpan, TripPatch};
use lm_core::limits::{STORYBOOK_CAPTION_CHARS, STORYBOOK_HEADLINE_CHARS, TRIP_TITLE_CHARS};
use lm_core::model::Date;

use super::editor::{use_editor, Editor};

/// 封面的一個文字欄位：`change` 時以 `patch(文字)` 送出。
fn text_input(
    editor: Editor,
    id: &'static str,
    max: usize,
    value: impl Fn(&lm_core::storybook::StudioPlan) -> String + Send + Sync + 'static,
    patch: fn(String) -> TripPatch,
) -> impl IntoView {
    let bad = editor.bad(id.to_owned());
    view! {
        <input
            id=id
            autocomplete="off"
            maxlength=max.to_string()
            prop:value=move || editor.plan.with(|plan| plan.as_ref().map(&value).unwrap_or_default())
            aria-invalid=move || bad.get().then_some("true")
            aria-describedby=move || bad.get().then(|| format!("{id}-error"))
            on:input=move |_| editor.set_typing(id, true)
            on:change=move |event| {
                editor.set_typing(id, false);
                let text = event_target_value(&event);
                editor.commit(Some(id), vec![Command::UpdateTrip { patch: patch(text) }]);
            }
        />
        {editor.error_view(id.to_owned())}
    }
}

/// `#panel-cover` 的內容。
#[component]
pub(super) fn CoverPanel() -> impl IntoView {
    let editor = use_editor();
    let start_bad = editor.bad("startDate".to_owned());
    // Bun `shiftDates()`：所有日期一起平移，天數不變
    let on_start = move |event: leptos::ev::Event| {
        editor.set_typing("startDate", false);
        let Ok(start) = event_target_value(&event).parse::<Date>() else {
            return;
        };
        let Some((old, end)) = editor.state(|state| (state.card.start, state.card.end)) else {
            return;
        };
        let Some(end) = end.checked_add_signed(start.signed_duration_since(old)) else {
            return;
        };
        editor.commit(
            Some("startDate"),
            vec![Command::UpdateTrip {
                patch: TripPatch {
                    dates: Some(DateSpan { start, end }),
                    ..TripPatch::default()
                },
            }],
        );
    };
    view! {
        <h2>"海報封面"</h2>
        <p class="hint">"這些文字印在海報頂端與底部，不影響每日行程。"</p>
        <div class="form-grid cover-grid">
            <div class="span-all">
                <label for="headline">
                    "大標題 "
                    <span class="hint">"· 海報最上方的大字；留空時改用旅程名稱"</span>
                </label>
                {text_input(
                    editor,
                    "headline",
                    *STORYBOOK_HEADLINE_CHARS.end(),
                    |plan| plan.headline.clone(),
                    |text| TripPatch { headline: Some(text), ..TripPatch::default() },
                )}
            </div>
            <div>
                <label for="title">
                    "旅程名稱 " <span class="hint">"· 大標題下方的小字，和日期並列"</span>
                </label>
                {text_input(
                    editor,
                    "title",
                    *TRIP_TITLE_CHARS.end(),
                    |plan| plan.title.clone(),
                    |text| TripPatch { title: Some(text), ..TripPatch::default() },
                )}
            </div>
            <div>
                <label for="startDate">
                    "出發日期 " <span class="hint">"· 改這裡，所有日期一起平移"</span>
                </label>
                <input
                    id="startDate"
                    type="date"
                    prop:value=move || {
                        editor
                            .plan
                            .with(|plan| {
                                plan.as_ref()
                                    .and_then(|plan| plan.days.first())
                                    .map(|day| day.date.to_string())
                            })
                            .unwrap_or_default()
                    }
                    aria-invalid=move || start_bad.get().then_some("true")
                    aria-describedby=move || start_bad.get().then_some("startDate-error")
                    on:change=on_start
                />
                {editor.error_view("startDate".to_owned())}
            </div>
            <div class="span-all">
                <label for="caption">
                    "底部短語 " <span class="hint">"· 海報最下方左側的一句話"</span>
                </label>
                {text_input(
                    editor,
                    "caption",
                    *STORYBOOK_CAPTION_CHARS.end(),
                    |plan| plan.caption.clone(),
                    |text| TripPatch { caption: Some(text), ..TripPatch::default() },
                )}
            </div>
        </div>
    }
}
