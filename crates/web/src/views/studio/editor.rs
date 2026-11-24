//! 工作室的編輯器（Bun `app.js` 的 `commit()`、`notice()`、`setInvalid()`、`updateDirty()`、`flushDraft()`、
//! `selectDay()` 與 `reveal()`，rust-schedule-studio Decision D2）。
//!
//! 編輯器沒有本地的草稿：每一次編輯（文字欄位在 `change`，也就是離開欄位或按 Enter 時；選單、勾選與按鈕立即）都以
//! lm-core 的 Command 經 `TripHandle::submit` 送出，其他視窗經 Realtime 看到。送出之前以 `TripHandle::check_batch`
//! 確認全部的命令都成立，並計算復原用的反向命令（[`super::inverse`]）；不成立時那個欄位標示 `aria-invalid`、
//! `#editorNotice` 顯示「未套用：{訊息}」，不送出任何命令，欄位保留輸入的文字。
//!
//! 「已儲存」狀態（`#saveStatus`）：有 N 個欄位未通過檢查時是「有 N 個欄位未通過檢查」；有命令在等待結果、送出失敗正在
//! 重試，或有欄位還在輸入（`input` 之後、`change` 之前）時是「自動儲存中…」；否則是「已儲存」。
use std::collections::BTreeSet;

use leptos::prelude::*;
use lm_core::command::{Command, Input};
use lm_core::ids::PlaceId;
use lm_core::model::{Date, PlaceRef, TripState};
use lm_core::storybook::{studio_plan, StudioPlan};
use lm_core::time::{date_range, date_text, Hm};
use uuid::Uuid;
use wasm_bindgen::JsCast;

use super::history::{Edit, History};
use super::inverse::{inverse, route_draft};
use super::{EditorTab, MobileView, PlanSection, StudioUi};
use crate::sync::engine::TripHandle;

/// 地點選單中 Destination_Place 的值（地點清單中的地點是它的 id）。
const DESTINATION: &str = "destination";

/// 網站圖示風格的垃圾桶（Bun `trashIcon()`）。
pub(super) const TRASH_SVG: &str = r#"<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6m4-6v6"></path></svg>"#;

/// 地點引用在 `<select>` 中的值：Destination_Place 是 `destination`，地點清單中的地點是它的 id。
pub(super) fn place_value(place: PlaceRef) -> String {
    match place {
        PlaceRef::Destination => DESTINATION.to_owned(),
        PlaceRef::Place(id) => id.to_string(),
    }
}

/// [`place_value`] 的反向；空字串或無法解析的值是 `None`。
pub(super) fn parse_place(value: &str) -> Option<PlaceRef> {
    match value {
        DESTINATION => Some(PlaceRef::Destination),
        _ => Uuid::parse_str(value)
            .ok()
            .map(|id| PlaceRef::Place(PlaceId(id))),
    }
}

/// 時刻欄位的文字：留空是 `None`；Time_Value 是 `Ok`；其他文字原樣送出，由 lm-core 依各需求的訊息拒絕。
pub(super) fn time_input(text: &str) -> Option<Input<Hm>> {
    match Hm::parse(text) {
        Ok(None) => None,
        Ok(Some(time)) => Some(Input::Ok(time)),
        Err(_) => Some(Input::Bad(serde_json::Value::String(text.to_owned()))),
    }
}

/// 選填時刻在欄位中的文字（`HH:MM`，沒有時是空字串）。
pub(super) fn time_text(time: Option<Hm>) -> String {
    time.map(|time| time.to_string()).unwrap_or_default()
}

/// Bun `dayLabel()`：「第 N 天・{M/D}（週X）」。
pub(super) fn day_label(date: Date, index: usize) -> String {
    format!("第 {} 天・{}", index + 1, date_text(date))
}

/// Bun `lines()`：每行一項，去掉頭尾空白，略過空行。
pub(super) fn lines(text: &str) -> Vec<String> {
    text.split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

/// 新列的 id（uuid v4，由客戶端產生）。
pub(super) fn new_id<T: From<Uuid>>() -> T {
    T::from(Uuid::new_v4())
}

/// Bun `grow()`：一行高的文字框隨內容長高。還沒有顯示（例如在收起的 `<details>` 中）時不改。
pub(super) fn grow(element: &web_sys::HtmlElement) {
    if !element.is_connected() {
        return;
    }
    let style = element.style();
    let _ = style.set_property("height", "auto");
    let height = element.scroll_height();
    if height > 0 {
        let _ = style.set_property("height", &format!("{}px", height + 2));
    } else {
        let _ = style.remove_property("height");
    }
}

/// `#editorNotice` 的語氣（class `ok` 或 `error`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Tone {
    Plain,
    Ok,
    Error,
}

impl Tone {
    fn suffix(self) -> &'static str {
        match self {
            Tone::Plain => "",
            Tone::Ok => " ok",
            Tone::Error => " error",
        }
    }
}

/// Bun `notice()` 的內容。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Notice {
    pub text: String,
    pub tone: Tone,
}

/// 編輯器的狀態與操作（`Copy`，以 context 提供給工作室的元件）。
#[derive(Clone, Copy)]
pub(super) struct Editor {
    pub handle: TripHandle,
    pub studio: StudioUi,
    /// 工作室顯示的行程（`studio_plan()`），手帖與編輯器共用
    pub plan: Memo<Option<StudioPlan>>,
    /// 檢視者是 Trip_Manager（Bun `canDelete`：刪除車輛與菜單餐點）
    pub can_manage: Memo<bool>,
    /// 旅伴的名字，依 Ordinal（接送停靠點的旅伴名單）
    pub people: Memo<Vec<String>>,
    pub history: History,
    /// `None` 是還沒有任何提示（`#editorNotice` 保持 template.js 的 class）
    notice: RwSignal<Option<Notice>>,
    /// 未通過檢查的欄位 id 與訊息，依標示的順序
    invalid: RwSignal<Vec<(String, String)>>,
    /// 還在輸入、尚未送出的欄位 id
    typing: RwSignal<BTreeSet<String>>,
    /// 展開的路線（Bun `selectedRoute`；`None` 是全部收起）
    pub selected_route: RwSignal<Option<usize>>,
    /// 展開的活動（Bun `selectedEvent`）
    pub selected_event: RwSignal<Option<usize>>,
    /// 停靠點的展開狀態（Bun `openStops`：`stop-{日}-{路線}-{站}` 與 `closed-…`）
    pub open_stops: RwSignal<BTreeSet<String>>,
    /// 「地點與車」選定的地點（Bun `placeId`）；`None` 或已不存在時是第一個地點
    pub place: RwSignal<Option<PlaceRef>>,
}

/// 取得工作室提供的 [`Editor`]。
pub(super) fn use_editor() -> Editor {
    expect_context::<Editor>()
}

impl Editor {
    pub(super) fn new(handle: TripHandle, studio: StudioUi) -> Editor {
        Editor {
            handle,
            studio,
            plan: Memo::new(move |_| handle.with_view(studio_plan)),
            can_manage: Memo::new(move |_| {
                handle.viewer().is_some_and(|viewer| viewer.caps.can_manage)
            }),
            people: Memo::new(move |_| {
                handle
                    .with_view(|state| {
                        state
                            .people_by_ordinal()
                            .map(|person| person.name.clone())
                            .filter(|name| !name.is_empty())
                            .collect()
                    })
                    .unwrap_or_default()
            }),
            history: History::new(),
            notice: RwSignal::new(None),
            invalid: RwSignal::new(Vec::new()),
            typing: RwSignal::new(BTreeSet::new()),
            selected_route: RwSignal::new(Some(0)),
            selected_event: RwSignal::new(Some(0)),
            open_stops: RwSignal::new(BTreeSet::new()),
            place: RwSignal::new(None),
        }
    }

    /// 讀取 Optimistic_View，不追蹤（事件處理中使用）。
    pub(super) fn state<R>(&self, f: impl FnOnce(&TripState) -> R) -> Option<R> {
        untrack(|| self.handle.with_view(f))
    }

    /// 選定的那一天的日期；旅行還沒有載入時是 `None`。
    pub(super) fn day_date(&self) -> Option<Date> {
        let index = self.studio.day.get_untracked();
        self.state(|state| {
            date_range(state.card.start, state.card.end)
                .get(index)
                .copied()
        })
        .flatten()
    }

    // ── 提示、欄位檢查與儲存狀態 ──

    /// Bun `notice()`：`#editorNotice` 與 `#message` 的文字；空字串時隱藏。
    pub(super) fn notice(&self, text: impl Into<String>, tone: Tone) {
        self.notice.set(Some(Notice {
            text: text.into(),
            tone,
        }));
    }

    /// `#editorNotice` 的 class（template.js 的 `editor-notice`，有提示之後是 `message editor-notice {語氣}`）。
    pub(super) fn notice_class(&self, base: &str) -> String {
        self.notice.with(|notice| match notice {
            None if base == "editor-notice" => base.to_owned(),
            None => "message".to_owned(),
            Some(notice) if base == "editor-notice" => {
                format!("message editor-notice{}", notice.tone.suffix())
            }
            Some(notice) => format!("message{}", notice.tone.suffix()),
        })
    }

    pub(super) fn notice_text(&self) -> String {
        self.notice
            .with(|notice| notice.as_ref().map(|notice| notice.text.clone()))
            .unwrap_or_default()
    }

    /// 提示是空字串（Bun 隱藏 `#editorNotice`）。
    pub(super) fn notice_hidden(&self) -> bool {
        self.notice
            .with(|notice| notice.as_ref().is_some_and(|notice| notice.text.is_empty()))
    }

    /// Bun `setInvalid()`：`message` 是 `Some` 時標示欄位未通過檢查，`None` 時取消標示。
    pub(super) fn set_invalid(&self, id: &str, message: Option<&str>) {
        self.invalid.update(|invalid| {
            let at = invalid.iter().position(|(field, _)| field == id);
            match (at, message) {
                (Some(at), Some(message)) => invalid[at].1 = message.to_owned(),
                (None, Some(message)) => invalid.push((id.to_owned(), message.to_owned())),
                (Some(at), None) => {
                    invalid.remove(at);
                }
                (None, None) => {}
            }
        });
    }

    /// 欄位未通過檢查時的訊息。
    pub(super) fn invalid_message(&self, id: &str) -> Option<String> {
        self.invalid.with(|invalid| {
            invalid
                .iter()
                .find(|(field, _)| field == id)
                .map(|(_, message)| message.clone())
        })
    }

    /// 欄位是否未通過檢查（`aria-invalid` 與錯誤訊息讀取）。
    pub(super) fn bad(&self, id: String) -> Signal<bool> {
        let invalid = self.invalid;
        Signal::derive(move || {
            invalid.with(|invalid| invalid.iter().any(|(field, _)| *field == id))
        })
    }

    /// 欄位下方的錯誤訊息（Bun `setInvalid()` 加在欄位之後的 `p.field-error`）。
    pub(super) fn error_view(&self, id: String) -> impl IntoView {
        let editor = *self;
        move || {
            editor.invalid_message(&id).map(|message| {
                view! {
                    <p id=format!("{id}-error") class="field-error">
                        {message}
                    </p>
                }
            })
        }
    }

    /// 欄位開始輸入（`input`）或結束輸入（`change`）。
    pub(super) fn set_typing(&self, id: &str, typing: bool) {
        let has = self.typing.with_untracked(|set| set.contains(id));
        if has != typing {
            self.typing.update(|set| {
                if typing {
                    set.insert(id.to_owned());
                } else {
                    set.remove(id);
                }
            });
        }
    }

    /// `#saveStatus` 的文字（Bun `updateDirty()`）。
    pub(super) fn status(&self) -> String {
        let invalid = self.invalid.with(Vec::len);
        if invalid > 0 {
            format!("有 {invalid} 個欄位未通過檢查")
        } else if self.handle.pending_count.get() > 0
            || self.handle.save_retrying.get()
            || !self.typing.with(BTreeSet::is_empty)
        {
            "自動儲存中…".to_owned()
        } else {
            "已儲存".to_owned()
        }
    }

    // ── 送出、復原與重做 ──

    /// Bun `commit()`：依序送出 `commands`，成功時記入復原記錄（`source` 是欄位 id，同一個欄位的連續編輯合併）。
    /// 有一個命令不成立時什麼都不送出，`source` 標示未通過檢查，顯示「未套用：{訊息}」，回傳 `false`。
    pub(super) fn commit(&self, source: Option<&str>, commands: Vec<Command>) -> bool {
        if commands.is_empty() {
            return true;
        }
        let mut steps: Vec<Vec<Command>> = Vec::with_capacity(commands.len());
        let changed = match self.handle.check_batch(&commands, |state, command| {
            steps.push(inverse(state, command))
        }) {
            Ok(changed) => changed,
            Err(rejection) => {
                if let Some(id) = source {
                    self.set_invalid(id, Some(rejection.message()));
                }
                self.notice(format!("未套用：{}", rejection.message()), Tone::Error);
                return false;
            }
        };
        if let Some(id) = source {
            self.set_invalid(id, None);
        }
        if changed {
            for (sent, command) in commands.iter().enumerate() {
                if let Err(rejection) = self.handle.submit(command.clone()) {
                    // 同一份 Optimistic_View 上已確認成立，不應發生；仍把已送出的命令還原
                    for undo in steps[..sent].iter().rev().flatten() {
                        let _ = self.handle.submit(undo.clone());
                    }
                    self.notice(format!("未套用：{}", rejection.message()), Tone::Error);
                    return false;
                }
            }
            self.history.record(Edit {
                key: source.map(str::to_owned),
                forward: commands,
                inverse: steps.into_iter().rev().flatten().collect(),
                day: self.studio.day.get_untracked(),
            });
        }
        let error = self
            .notice
            .with_untracked(|notice| notice.as_ref().is_some_and(|n| n.tone == Tone::Error));
        if error && self.invalid.with_untracked(Vec::is_empty) {
            self.notice("", Tone::Plain);
        }
        true
    }

    /// Bun `travelHistory()`：「復原」（`backwards`）送出最上面一筆的反向命令，「重做」再送出它的命令。不成立時顯示
    /// 「無法回到這一步：{訊息}」，兩疊記錄不變。成功時回到那一筆編輯時的日子。
    pub(super) fn travel(&self, backwards: bool) {
        let Some(edit) = self.history.top(backwards) else {
            return;
        };
        let commands = if backwards {
            edit.inverse
        } else {
            edit.forward
        };
        if let Err(rejection) = self.handle.check_batch(&commands, |_, _| {}) {
            self.notice(
                format!("無法回到這一步：{}", rejection.message()),
                Tone::Error,
            );
            return;
        }
        for command in commands {
            if let Err(rejection) = self.handle.submit(command) {
                self.notice(
                    format!("無法回到這一步：{}", rejection.message()),
                    Tone::Error,
                );
                return;
            }
        }
        self.history.travel(backwards);
        let days = self
            .state(|state| date_range(state.card.start, state.card.end).len())
            .unwrap_or(0);
        if days > 0 {
            self.studio.day.set(edit.day.min(days - 1));
        }
        self.open_stops.set(BTreeSet::new());
        self.invalid.set(Vec::new());
        self.notice(
            if backwards {
                "已復原上一步；記得按「儲存行程」。"
            } else {
                "已重做；記得按「儲存行程」。"
            },
            Tone::Ok,
        );
    }

    /// 以路線目前的整份內容加上 `change` 送出 `SaveRoute`。
    pub(super) fn save_route(
        &self,
        route: lm_core::ids::RouteId,
        source: Option<&str>,
        change: impl FnOnce(&mut lm_core::command::RouteDraft),
    ) -> bool {
        let Some(mut draft) = self
            .state(|state| state.routes.get(&route).map(route_draft))
            .flatten()
        else {
            return false;
        };
        change(&mut draft);
        self.commit(source, vec![Command::SaveRoute { route: draft }])
    }

    /// 修改路線上的一個停靠點（送出整條路線）。
    pub(super) fn save_stop(
        &self,
        route: lm_core::ids::RouteId,
        stop: lm_core::ids::StopId,
        source: Option<&str>,
        change: impl FnOnce(&mut lm_core::command::StopDraft),
    ) -> bool {
        self.save_route(route, source, |draft| {
            if let Some(draft) = draft.stops.iter_mut().find(|draft| draft.id == stop) {
                change(draft);
            }
        })
    }

    // ── 切換與定位 ──

    /// 工作室中 id 為 `id` 的元素。
    pub(super) fn element(&self, id: &str) -> Option<web_sys::HtmlElement> {
        self.studio
            .shadow_root()?
            .get_element_by_id(id)?
            .dyn_into::<web_sys::HtmlElement>()
            .ok()
    }

    /// Bun `flushDraft()`：先讓正在輸入的欄位送出；仍有未通過檢查的欄位時顯示提示、移到第一個，回傳 `false`。
    pub(super) fn flush_draft(&self) -> bool {
        if let Some(active) = self
            .studio
            .shadow_root()
            .and_then(|root| root.active_element())
            .and_then(|active| active.dyn_into::<web_sys::HtmlElement>().ok())
        {
            if active.closest("#editorPanel").ok().flatten().is_some() {
                active.blur().ok();
            }
        }
        // 欄位已不在畫面上（例如那一列被別人刪除）時不再擋住
        let gone: Vec<String> = self.invalid.with_untracked(|invalid| {
            invalid
                .iter()
                .filter(|(id, _)| self.element(id).is_none())
                .map(|(id, _)| id.clone())
                .collect()
        });
        for id in gone {
            self.set_invalid(&id, None);
        }
        let invalid = self.invalid.get_untracked();
        let Some((first, _)) = invalid.first() else {
            return true;
        };
        self.notice(
            format!(
                "有 {} 個欄位未通過檢查，海報與輸出仍是上一次有效的內容。請先修正標示的欄位。",
                invalid.len()
            ),
            Tone::Error,
        );
        if let Some(element) = self.element(first) {
            self.reveal(&element);
            element.focus().ok();
        }
        false
    }

    /// Bun `showTab()`。
    pub(super) fn show_tab(&self, tab: EditorTab) -> bool {
        if !self.flush_draft() {
            return false;
        }
        self.history.break_coalescing();
        self.studio.show_tab(tab);
        true
    }

    /// Bun `showSection()`。
    pub(super) fn show_section(&self, section: PlanSection) -> bool {
        if !self.flush_draft() {
            return false;
        }
        self.studio.section.set(section);
        true
    }

    /// 第 `index` 天有路線時編輯路線，否則編輯活動。
    pub(super) fn section_of(&self, index: usize) -> PlanSection {
        let routes = self.plan.with_untracked(|plan| {
            plan.as_ref()
                .and_then(|plan| plan.days.get(index))
                .is_some_and(|day| !day.routes.is_empty())
        });
        if routes {
            PlanSection::Routes
        } else {
            PlanSection::Events
        }
    }

    /// Bun `selectDay()`：選定第 `index` 天，顯示「行程」分頁與這一天的路線（沒有路線時是活動）。
    pub(super) fn select_day(&self, index: usize) -> bool {
        let days = self
            .plan
            .with_untracked(|plan| plan.as_ref().map_or(0, |plan| plan.days.len()));
        if index >= days || !self.flush_draft() {
            return false;
        }
        self.reset_day_state();
        self.studio.select_day(index, self.section_of(index));
        true
    }

    /// 換了日子：第一條路線與第一個活動展開，停靠點回到預設的展開狀態。
    pub(super) fn reset_day_state(&self) {
        self.selected_route.set(Some(0));
        self.selected_event.set(Some(0));
        self.open_stops.set(BTreeSet::new());
        self.history.break_coalescing();
    }

    /// 手帖日卡上的「編輯這一天」（Bun `onEditDay`）：編輯器收起時不做事；否則選定那一天、顯示編輯器並移到那一天的按鈕。
    pub(super) fn edit_day(&self, index: usize) {
        if self.studio.editor_hidden.get_untracked() || !self.select_day(index) {
            return;
        }
        self.studio.set_mobile_view(MobileView::Editor);
        let editor = *self;
        request_animation_frame(move || {
            if let Some(tab) = editor.element(&format!("day-tab-{index}")) {
                editor.reveal(&tab);
                let options = web_sys::FocusOptions::new();
                options.set_prevent_scroll(true);
                tab.focus_with_options(&options).ok();
            }
        });
    }

    /// Bun `reveal()`：顯示元素所在的分頁、區段與 `<details>`，切到編輯器，捲到看得見的位置。
    pub(super) fn reveal(&self, node: &web_sys::Element) {
        let closest = |selector: &str| node.closest(selector).ok().flatten();
        if let Some(panel) = closest("[data-editor-panel]") {
            let tab = panel.get_attribute("data-editor-panel");
            if let Some(tab) = tab.as_deref().and_then(EditorTab::parse) {
                self.studio.show_tab(tab);
            }
        }
        if closest("#routeSection").is_some() {
            self.studio.section.set(PlanSection::Routes);
        }
        if closest("#eventSection").is_some() {
            self.studio.section.set(PlanSection::Events);
        }
        let mut parent = node.parent_element();
        while let Some(element) = parent {
            if let Some(details) = element.dyn_ref::<web_sys::HtmlDetailsElement>() {
                details.set_open(true);
            }
            parent = element.parent_element();
        }
        let index = |selector: &str| {
            closest(selector)
                .and_then(|entry| entry.id().rsplit('-').next().map(str::to_owned))
                .and_then(|index| index.parse::<usize>().ok())
        };
        if let Some(i) = index("details[id^=route-entry-]") {
            self.selected_route.set(Some(i));
        }
        if let Some(i) = index("details[id^=event-entry-]") {
            self.selected_event.set(Some(i));
        }
        self.studio.set_mobile_view(MobileView::Editor);
        let options = web_sys::ScrollIntoViewOptions::new();
        options.set_block(web_sys::ScrollLogicalPosition::Nearest);
        options.set_inline(web_sys::ScrollLogicalPosition::Nearest);
        node.scroll_into_view_with_scroll_into_view_options(&options);
    }

    /// 畫面更新之後移到 id 為 `id` 的欄位（`select` 時選取它的文字）。
    pub(super) fn focus_later(&self, id: String, select: bool) {
        let editor = *self;
        request_animation_frame(move || {
            let Some(element) = editor.element(&id) else {
                return;
            };
            editor.reveal(&element);
            element.focus().ok();
            if select {
                if let Some(input) = element.dyn_ref::<web_sys::HtmlInputElement>() {
                    input.select();
                }
            }
        });
    }
}
