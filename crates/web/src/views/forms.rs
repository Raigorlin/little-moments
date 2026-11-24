//! 編輯表單的共用元件（需求 7.8、13.2、14.4、14.6–14.9、14.11）。
//!
//! - 開啟中的表單與它的草稿放在旅行頁的 [`UiState`]，不放在列元件裡：列因 Remote_Change 移到別的組（例如採買品項換
//!   分類）時，原來的列元件被移除、新的組建立新的元件，表單與草稿都不受影響（需求 14.4、14.6）。同一時間最多一個表單。
//! - [`UiState::open_form`] 開啟時記下當時 Optimistic_View 中的列（[`FormSession::original`]）與開啟時的草稿
//!   （[`FormSession::initial`]）；[`FormSession::save`] 以開啟時的草稿與目前的草稿算出 Command：只放進改過的欄位
//!   （[`changed`]），集合欄位只放加入與移除的元素（[`set_delta`]），沒有任何欄位改變時關閉表單、不送出（需求 7.8、14.8）。
//! - LM_Core 在送出前拒絕時，訊息顯示在表單的錯誤訊息區，表單保持開啟並保留內容（需求 13.2）。
//! - 表單開著時，Remote_Change 改了這一項：草稿不變，表單上方以 `role="status"` 顯示「有人剛更新了這一項」，直到表單
//!   關閉（需求 14.6、14.7；提交者的 Presence_Meta 回報了 Bound_Person 時改為「{旅伴名稱}剛更新了這一項」）。
//!   Remote_Change 刪除了這一項，或正在編輯的
//!   每日設定那一天已不在旅行的日期範圍內：直接關閉表單、捨棄草稿，並以 Toast 顯示「這個項目已被刪除。」（需求 14.9）。
//! - 誰正在編輯（需求 15.1、15.2、15.9–15.15）：開啟編輯既有項目的表單時回報 Edit_Target、關閉時回報沒有正在編輯的
//!   對象；新增項目的表單不回報。開啟時這個對象的 Editor_Stack 不是空的：[`FormNotices`] 顯示 Editing_Notice 與
//!   「仍要編輯」，[`FormFields`] 中的欄位與「儲存」、「移除項目」停用，直到按下「仍要編輯」或關閉表單。
//! - 編輯表單以外、可以輸入文字的欄位（例如採買清單中直接修改的數量）以 [`LiveTextInput`] 輸出：有焦點時不以新的內容
//!   覆蓋欄位中的文字、游標與選取範圍，離開欄位之後才顯示 Optimistic_View 的值（需求 14.11）。
//!
//! 捲動位移（需求 14.10）不需要另外處理：每一列只更新自己的節點，沒有整頁重繪，瀏覽器的捲動錨定（`overflow-anchor`）
//! 在可見範圍上方的內容高度改變時調整捲動位移。
use std::any::Any;
use std::collections::BTreeSet;
use std::rc::Rc;
use std::time::Duration;

use leptos::html;
use leptos::prelude::*;
use lm_core::command::Command;
use lm_core::ids::{PersonId, UserId};
use lm_core::model::{Entity, Row, RowKey, Seq, Slot, TripState};
use lm_core::presence::EditTarget;
use lm_core::time::date_range;

use crate::art;
use crate::pages::trip::UiState;
use crate::sync::engine::RemoteEntry;
use crate::views::icons;

/// Remote_Change 刪除了開啟中的表單的項目（需求 14.9）。
pub const ITEM_DELETED: &str = "這個項目已被刪除。";
/// Remote_Change 改了開啟中的表單的項目，找不到修改者的旅伴名稱時（需求 14.7）。
pub const SOMEONE_UPDATED: &str = "有人剛更新了這一項";
/// 「{旅伴名稱}剛更新了這一項」中旅伴名稱之後的文字（需求 14.6）。
const UPDATED_SUFFIX: &str = "剛更新了這一項";
/// Editing_Notice 旁的按鈕（需求 15.9、15.10）。
pub const EDIT_ANYWAY: &str = "仍要編輯";

/// 表單編輯的對象。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FormTarget {
    /// 編輯一個既有的 Editable_Item（每日設定以日期為鍵，那一天還沒有設定時也是 `Edit`）
    Edit(Slot),
    /// 新增項目的表單：沒有對應的列，不追蹤 Remote_Change，也不回報 Edit_Target（需求 15.12）
    New,
}

/// 開啟中的表單：哪一種表單（由各分頁自己命名，例如 `"meal"`）與它的對象。`serial` 每開一次表單加一。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpenForm {
    pub serial: u64,
    pub kind: &'static str,
    pub target: FormTarget,
}

/// Remote_Change 最近一次（Seq 最大者）改了開啟中的表單的項目（需求 14.6）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RemoteUpdate {
    pub seq: Seq,
    /// Change_Set 的提交者；變化來自 Snapshot 時是 `None`（需求 14.7）
    pub actor: Option<UserId>,
    /// 套用這次變化當下，提交者的 Presence_Meta 回報的 Bound_Person（需求 14.6）；提交者不在 Presence 中或沒有
    /// Bound_Person 時是 `None`（需求 14.7）
    pub person: Option<PersonId>,
}

/// 「{旅伴名稱}剛更新了這一項」（需求 14.6）；回報的 Bound_Person 不在 Optimistic_View 的旅伴中時是
/// 「有人剛更新了這一項」（需求 14.7）。
pub fn updated_text(view: &TripState, person: Option<PersonId>) -> String {
    person
        .and_then(|person| view.people.get(&person))
        .map_or_else(
            || SOMEONE_UPDATED.to_owned(),
            |person| format!("{}{UPDATED_SUFFIX}", person.name),
        )
}

/// `UiState` 中保存的表單：它的 Owner（草稿等 signal 與追蹤 Remote_Change 的 Effect）與型別被抹除的 `FormSession`。
pub(crate) struct SessionSlot {
    serial: u64,
    owner: Owner,
    session: Rc<dyn Any>,
}

/// 一個開啟中的表單。`Copy`，可以放進事件處理；表單關閉之後不要再使用。
pub struct FormSession<D: 'static> {
    pub serial: u64,
    pub kind: &'static str,
    pub target: FormTarget,
    original: StoredValue<Option<Row>, LocalStorage>,
    initial: StoredValue<D, LocalStorage>,
    /// 表單中目前的內容；Remote_Change 不改變它（需求 14.6）
    pub draft: RwSignal<D, LocalStorage>,
    /// 表單的錯誤訊息區（LM_Core 在送出前的拒絕，需求 13.2）
    pub error: RwSignal<Option<String>>,
    /// Remote_Change 改了這一項（需求 14.6）；表單關閉前不再清除
    pub updated: RwSignal<Option<RemoteUpdate>>,
    /// 開啟時這個對象的 Editor_Stack 不是空的：欄位唯讀、會改變內容或資料的按鈕停用，直到按下「仍要編輯」
    /// （需求 15.9、15.10）；之後 Editor_Stack 的變化不改變它（需求 15.15）
    locked: RwSignal<bool>,
    ui: UiState,
}

impl<D: 'static> Clone for FormSession<D> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<D: 'static> Copy for FormSession<D> {}

impl<D: Clone + 'static> FormSession<D> {
    /// 開啟表單時 Optimistic_View 中的列（新增的表單、或那一天還沒有設定的每日設定是 `None`）。
    pub fn original(&self) -> Option<Row> {
        self.original.get_value()
    }

    /// 開啟表單時的草稿；與目前的草稿比較，找出改過的欄位。
    pub fn initial(&self) -> D {
        self.initial.get_value()
    }

    /// 表單仍開著（還沒有儲存、取消或因項目被刪除而關閉）。
    pub fn is_open(&self) -> bool {
        self.ui.is_current_form(self.serial)
    }

    /// 欄位唯讀、「儲存」與「移除項目」等按鈕停用中（需求 15.9）；在 reactive 範圍中讀取時，按下「仍要編輯」後重算。
    pub fn locked(&self) -> bool {
        self.locked.try_get().unwrap_or(false)
    }

    fn locked_untracked(&self) -> bool {
        self.locked.try_get_untracked().unwrap_or(false)
    }

    /// 儲存（需求 7.8、13.1、13.2）：`build(開啟時的草稿, 目前的草稿)` 只放進改過的欄位；回傳 `None` 表示沒有任何欄位改變，
    /// 關閉表單、不送出。LM_Core 拒絕時把訊息放進錯誤訊息區並保留表單；成立時關閉表單。回傳表單是否已關閉。
    pub fn save(&self, build: impl FnOnce(&D, &D) -> Option<Command>) -> bool {
        // 唯讀時「儲存」已停用；以 Enter 等其他方式送出時也不做任何事（需求 15.9）
        if self.locked_untracked() {
            return false;
        }
        let initial = self.initial();
        let command = self.draft.with_untracked(|draft| build(&initial, draft));
        match command {
            None => {
                self.close();
                true
            }
            Some(command) => self.submit(command),
        }
    }

    /// 送出一個 Command（例如表單中的「移除項目」）：LM_Core 拒絕時把訊息放進錯誤訊息區並保留表單；成立時關閉表單。
    /// 回傳表單是否已關閉。
    pub fn submit(&self, command: Command) -> bool {
        if self.locked_untracked() {
            return false;
        }
        // 成立時在同一個事件中關閉：追蹤 Remote_Change 的 Effect 在之後才執行，所以自己刪除這一項不會被當成被刪除
        match self.ui.handle.submit(command) {
            Ok(_) => {
                self.close();
                true
            }
            Err(rejection) => {
                self.error.set(Some(rejection.to_string()));
                false
            }
        }
    }

    /// 取消或關閉表單，捨棄草稿。
    pub fn close(&self) {
        self.ui.close_form(self.serial);
    }
}

impl UiState {
    /// 開啟表單（先關閉開啟中的表單）。`Edit` 的對象記下當時 Optimistic_View 中的列；`draft` 是表單一開始的內容。
    /// 草稿與追蹤 Remote_Change 的 Effect 屬於這個表單自己的 Owner（旅行頁之下），關閉時一起釋放。
    pub fn open_form<D: Clone + 'static>(
        &self,
        kind: &'static str,
        target: FormTarget,
        draft: D,
    ) -> FormSession<D> {
        let was_editing = self.take_form();
        // 每個分頁同時最多回報一個 Edit_Target（需求 15.1）：從一個編輯表單換到另一個時直接回報新的對象；新增項目的
        // 表單不回報 Edit_Target（需求 15.12）
        match target {
            FormTarget::Edit(slot) => self.handle.report_editing(Some(edit_target(slot))),
            FormTarget::New if was_editing => self.handle.report_editing(None),
            FormTarget::New => {}
        }
        let ui = *self;
        let serial = self.next_form_serial();
        let original = match target {
            FormTarget::Edit(slot) => {
                untrack(|| self.handle.with_view(|view| view.get(slot))).flatten()
            }
            FormTarget::New => None,
        };
        // 開啟這一刻有其他 Account 在編輯這個對象時唯讀（需求 15.9）；Editor_Stack 不含檢視者自己的帳號
        let locked = match target {
            FormTarget::Edit(slot) => {
                let target = edit_target(slot);
                self.handle
                    .editors
                    .try_with_untracked(|editors| editors.contains_key(&target))
                    .unwrap_or(false)
            }
            FormTarget::New => false,
        };
        let owner = self.child_owner();
        let session = owner.with(|| {
            let session = FormSession {
                serial,
                kind,
                target,
                original: StoredValue::new_local(original),
                initial: StoredValue::new_local(draft.clone()),
                draft: RwSignal::new_local(draft),
                error: RwSignal::new(None),
                updated: RwSignal::new(None),
                locked: RwSignal::new(locked),
                ui,
            };
            if let FormTarget::Edit(slot) = target {
                watch_remote(ui, serial, slot, session.updated);
            }
            session
        });
        self.sessions.update_value(|current| {
            *current = Some(SessionSlot {
                serial,
                owner,
                session: Rc::new(session),
            });
        });
        self.form.set(Some(OpenForm {
            serial,
            kind,
            target,
        }));
        session
    }

    /// 開啟中的表單；在 reactive 範圍中讀取時，表單開啟或關閉時重算。
    pub fn open_form_info(&self) -> Option<OpenForm> {
        self.form.get()
    }

    /// `kind` 這種表單開著時取得它（草稿的型別也要相符）；在 reactive 範圍中讀取時，表單開啟或關閉時重算。
    /// 各分頁以 `{move || ui.form_session::<Draft>("meal").map(|form| view! { … })}` 輸出表單。
    pub fn form_session<D: Clone + 'static>(&self, kind: &'static str) -> Option<FormSession<D>> {
        let open = self.form.get().filter(|open| open.kind == kind)?;
        self.sessions.with_value(|current| {
            current
                .as_ref()
                .filter(|slot| slot.serial == open.serial)
                .and_then(|slot| slot.session.downcast_ref::<FormSession<D>>().copied())
        })
    }

    /// 關閉 `serial` 這個表單（已關閉或已換成另一個表單時不變）。
    pub fn close_form(&self, serial: u64) {
        if self.is_current_form(serial) {
            self.close_any_form();
        }
    }

    /// 關閉開啟中的表單（沒有時不變），捨棄草稿。關閉的是編輯既有項目的表單時回報沒有正在編輯的對象（需求 15.2）。
    pub fn close_any_form(&self) {
        if self.take_form() {
            self.handle.report_editing(None);
        }
    }

    /// 關閉開啟中的表單，不回報 Presence；回傳關閉的是不是編輯既有項目的表單。
    fn take_form(&self) -> bool {
        let slot = self.sessions.try_update_value(Option::take).flatten();
        let open = self.form.try_get_untracked().flatten();
        if open.is_some() {
            self.form.set(None);
        }
        if let Some(slot) = slot {
            // 表單的畫面可能還在同一輪更新中讀取草稿：等它卸載之後才釋放
            let owner = slot.owner;
            set_timeout(move || drop(owner), Duration::ZERO);
        }
        open.is_some_and(|open| matches!(open.target, FormTarget::Edit(_)))
    }

    /// 離開旅行頁時開啟中的表單隨之關閉（需求 15.2）：是編輯既有項目的表單時回報沒有正在編輯的對象。旅行頁的
    /// signal 可能已釋放，所以只以 `try_` 讀取。
    pub(crate) fn on_page_exit(&self) {
        let editing = self
            .form
            .try_get_untracked()
            .flatten()
            .is_some_and(|open| matches!(open.target, FormTarget::Edit(_)));
        if editing {
            self.handle.report_editing(None);
        }
    }

    pub(crate) fn is_current_form(&self, serial: u64) -> bool {
        self.form
            .try_get_untracked()
            .flatten()
            .is_some_and(|open| open.serial == serial)
    }
}

/// 表單的對象在 Presence 中的 Edit_Target：每一張卡片或每一列一個（需求 15.12）。
pub fn edit_target((entity, key): Slot) -> EditTarget {
    EditTarget { entity, key }
}

/// 這一項是否已不在 Optimistic_View 中：每日設定是那一天已不在旅行的日期範圍內（每日設定被移除、但那一天仍在範圍內
/// 時不算，需求 14.9、22.11）；Trip_Card 不會被刪除（旅行被刪除時依需求 12.13 離開旅行頁）。
fn is_gone(view: &TripState, slot: Slot) -> bool {
    match slot {
        (Entity::DaySetting, RowKey::Day(day)) => {
            !date_range(view.card.start, view.card.end).contains(&day)
        }
        (Entity::Card, _) => false,
        _ => view.get(slot).is_none(),
    }
}

/// 這則 Remote_Change 記錄是否影響 `slot` 這一項是否存在：同一列，或正在編輯每日設定時的 Trip_Card（改日期）。
fn affects(entry: &RemoteEntry, slot: Slot) -> bool {
    entry.slot == slot || (slot.0 == Entity::DaySetting && entry.slot.0 == Entity::Card)
}

/// 表單開著時，每次畫面更新後檢查這一項（需求 14.6、14.7、14.9）。
fn watch_remote(ui: UiState, serial: u64, slot: Slot, updated: RwSignal<Option<RemoteUpdate>>) {
    let handle = ui.handle;
    let toasts = ui.toasts;
    let seen = StoredValue::new(handle.remote_serial.get_untracked());
    Effect::new(move |_| {
        handle.revision.track();
        // 自上次檢查以來因 Remote_Change 而改變的列（`remote_serial` 在 `revision` 之前遞增）
        let entries = handle.remote_since(seen.get_value());
        if let Some(last) = entries.last() {
            seen.set_value(last.serial);
        }
        if !ui.is_current_form(serial) {
            return;
        }
        let Some(gone) = untrack(|| handle.with_view(|view| is_gone(view, slot))) else {
            return;
        };
        if gone {
            // 直接關閉並捨棄草稿，不先詢問（需求 14.9）。自己的 Pending_Command 被拒絕而撤銷的新增不是 Remote_Change：
            // 只關閉表單，Toast 留給拒絕的訊息
            ui.close_form(serial);
            if entries.iter().any(|entry| affects(entry, slot)) {
                toasts.show(ITEM_DELETED);
            }
            return;
        }
        // 同時套用多個 Change_Set 時以 Seq 最大者為準（需求 14.6）
        if let Some(latest) = entries
            .iter()
            .filter(|entry| entry.slot == slot)
            .max_by_key(|entry| entry.seq)
        {
            // 旅伴名稱依套用這次變化當下的 Presence 狀態決定（需求 14.6）
            let person = latest
                .actor
                .and_then(|actor| handle.presence.person_of(actor));
            updated.set(Some(RemoteUpdate {
                seq: latest.seq,
                actor: latest.actor,
                person,
            }));
        }
    });
}

// ── 只送出改過的欄位（需求 7.8）──

/// 開啟時的值與目前的值不同時回傳目前的值，相同時是 `None`（不改）。選填欄位（`Option<T>`）因此得到 Command 的
/// `Option<Option<T>>`：清空時是 `Some(None)`，與沒有改的 `None` 區分。
pub fn changed<T: PartialEq + Clone>(initial: &T, current: &T) -> Option<T> {
    (initial != current).then(|| current.clone())
}

/// 集合欄位（乘客、活動參加者、分攤旅伴）：(加入的元素, 移除的元素)，即儲存時有、開啟時沒有的，以及開啟時有、儲存時
/// 沒有的（需求 7.7、7.8）。
pub fn set_delta<T: Ord + Clone>(
    initial: &BTreeSet<T>,
    current: &BTreeSet<T>,
) -> (BTreeSet<T>, BTreeSet<T>) {
    (
        current.difference(initial).cloned().collect(),
        initial.difference(current).cloned().collect(),
    )
}

/// 以 patch 組成編輯既有列的 Command；patch 沒有任何欄位（等於 `Default`）時是 `None`，不送出（需求 7.8）。
pub fn edit_command<P: Default + PartialEq>(
    patch: P,
    make: impl FnOnce(P) -> Command,
) -> Option<Command> {
    (patch != P::default()).then(|| make(patch))
}

// ── 表單上方的提示與錯誤訊息區 ──

/// 表單上方的兩則提示，各自是一開始就在的 `role="status"` live region，提示出現時才有內容：
///
/// - Editing_Notice（需求 15.9、15.15）：這個對象的 Editor_Stack 不是空的時顯示 `EditorStack::notice()`；以自己的
///   `Memo` 跟著 Editor_Stack 出現、更新或移除。表單開啟時唯讀的話，旁邊有「仍要編輯」：按下後恢復欄位與按鈕、移除
///   按鈕，焦點移到第一個欄位（需求 15.10）。
/// - 「{旅伴名稱}剛更新了這一項」（需求 14.6、14.7）：旅伴名稱取自 Optimistic_View，所以旅伴改名時跟著更新。
#[component]
pub fn FormNotices<D: Clone + 'static>(form: FormSession<D>) -> impl IntoView {
    let handle = form.ui.handle;
    let notice = Memo::new(move |_| match form.target {
        FormTarget::Edit(slot) => {
            let target = edit_target(slot);
            handle
                .editors
                .with(|editors| editors.get(&target).map(|stack| stack.notice()))
        }
        FormTarget::New => None,
    });
    let updated = move || {
        let update = form.updated.get()?;
        Some(
            handle
                .with_view(|view| updated_text(view, update.person))
                .unwrap_or_else(|| SOMEONE_UPDATED.to_owned()),
        )
    };
    let edit_anyway = move |event: leptos::ev::MouseEvent| {
        // 先找到表單：按鈕在下一次畫面更新時被移除
        let form_element = event_target::<web_sys::Element>(&event)
            .closest("form")
            .ok()
            .flatten();
        form.locked.set(false);
        // 欄位在畫面更新之後才恢復可以使用，所以在下一個畫格移動焦點
        request_animation_frame(move || {
            if let Some(field) = form_element.and_then(first_field) {
                let _ = field.focus();
            }
        });
    };
    view! {
        <div role="status">
            {move || {
                notice
                    .get()
                    .map(|text| {
                        view! {
                            <div class="notice">
                                {art::static_svg(icons::INFO)}
                                <span>{text}</span>
                                {move || {
                                    form.locked()
                                        .then(|| {
                                            view! {
                                                <button
                                                    type="button"
                                                    class="button small"
                                                    on:click=edit_anyway
                                                >
                                                    {EDIT_ANYWAY}
                                                </button>
                                            }
                                        })
                                }}
                            </div>
                        }
                    })
            }}
        </div>
        <div role="status">
            {move || {
                updated()
                    .map(|text| {
                        view! {
                            <p class="notice">
                                {art::static_svg(icons::INFO)}
                                <span>{text}</span>
                            </p>
                        }
                    })
            }}
        </div>
    }
}

/// 表單的欄位：開啟時唯讀的表單在按下「仍要編輯」之前，其中每個欄位與按鈕都停用（需求 15.9）。以不產生外框的
/// `fieldset` 包住，停用的狀態也套用到之後才建立的元素；「取消」與「儲存」等表單底部的按鈕放在外面，
/// 「儲存」與「移除項目」另外以 [`FormSession::locked`] 停用。
#[component]
pub fn FormFields<D: Clone + 'static>(form: FormSession<D>, children: Children) -> impl IntoView {
    view! {
        <fieldset style="display:contents" disabled=move || form.locked()>
            {children()}
        </fieldset>
    }
}

/// 表單中第一個可以輸入的欄位（「仍要編輯」之後的焦點，需求 15.10）。
fn first_field(form: web_sys::Element) -> Option<web_sys::HtmlElement> {
    use wasm_bindgen::JsCast;
    form.query_selector(
        "input:not([type=hidden]):not(:disabled), select:not(:disabled), textarea:not(:disabled)",
    )
    .ok()
    .flatten()
    .and_then(|element| element.dyn_into::<web_sys::HtmlElement>().ok())
}

/// 表單的錯誤訊息區（現行 `formError()`）：LM_Core 拒絕時的訊息以文字節點輸出（需求 13.2）。
#[component]
pub fn FormError<D: Clone + 'static>(form: FormSession<D>) -> impl IntoView {
    view! { <p class="form-error" role="alert">{move || form.error.get()}</p> }
}

// ── 編輯表單以外的文字欄位（需求 14.11）──

/// 列上直接修改的文字欄位：`value` 是 Optimistic_View 中的值，`on_commit` 在 `change` 事件（離開欄位或按 Enter）時
/// 收到欄位中的文字。有焦點時 `value` 改變不覆蓋欄位中的文字、游標與選取範圍；離開欄位時才顯示最新的 `value`
/// （送出的命令已經預測，或被拒絕而回復）。
#[component]
pub fn LiveTextInput(
    #[prop(into)] value: Signal<String>,
    #[prop(into)] on_commit: Callback<String>,
    #[prop(optional)] class: &'static str,
    #[prop(optional, into)] label: MaybeProp<String>,
    #[prop(optional)] maxlength: Option<usize>,
    #[prop(optional, into)] disabled: Signal<bool>,
    #[prop(optional, into)] placeholder: MaybeProp<String>,
) -> impl IntoView {
    let input = NodeRef::<html::Input>::new();
    let focused = StoredValue::new(false);
    let show = move |text: &str| {
        if let Some(element) = input.get_untracked() {
            if element.value() != text {
                element.set_value(text);
            }
        }
    };
    Effect::new(move |_| {
        let text = value.get();
        if !focused.get_value() {
            show(&text);
        }
    });
    view! {
        <input
            node_ref=input
            type="text"
            class=class
            value=value.get_untracked()
            aria-label=move || label.get()
            placeholder=move || placeholder.get()
            maxlength=maxlength
            disabled=move || disabled.get()
            on:focus=move |_| focused.set_value(true)
            on:change=move |event| on_commit.run(event_target_value(&event))
            on:blur=move |_| {
                focused.set_value(false);
                value.with_untracked(|text| show(text));
            }
        />
    }
}
