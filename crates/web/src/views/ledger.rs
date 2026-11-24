//! Ledger_Tab「分帳記帳」（`?tab=expenses`，需求 6.17、6.18、29.1、29.10、29.11、29.12）。
//!
//! 沿用現行 `src/expenses-ui.js` 的結構與 `.xp-*` class（`styles/expenses.css`），收據辨識、匯出與重新載入不在第一版。
//!
//! - Unbound_Admin（沒有 Bound_Person）只看到「你不是這趟旅行的旅伴，無法查看或記錄分帳。」（需求 6.18、29.12）；
//!   他的 Replica 本來就不含 Ledger_Rows。
//! - Trip_Member：總金額與「{N} 筆支出」、「＋ 新增支出」與「記錄還款」；「誰該還誰」與「建議還款」（`summarize()`，
//!   依 `revision` 整塊重算）；支出依日期分組（日期由新到舊、同一天依 Ordinal，`RowStore` 的排序鍵），每天顯示支出
//!   合計；還款同樣由新到舊。沒有任何支出與還款時只顯示「還沒有支出。」（需求 29.1、29.11）。
//! - 每筆支出與還款都有編輯按鈕；刪除只給有 Bound_Person 的 Trip_Manager（需求 6.17），按下後在那一列顯示確認提示，
//!   選「確認移除」才送出（需求 29.1）。
//! - 表單在工具列之下行內開啟（現行 `editorHtml()` 的位置）。金額以 `parse_amount()` 解析、以 `format_money()` 顯示；
//!   新增支出時，在使用者自己選擇分類之前依標題以 `suggest_expense_category()` 建議分類。修改只送出改過的欄位，分攤旅伴
//!   只送出加入與移除的旅伴（需求 7.8、29.2）。
//! - 日期或金額無法轉成 Command 的欄位時，先依需求 29.2、29.3 的順序在表單上說明排在它們之前的欄位，其餘的檢查都由
//!   LM_Core 在送出前進行。
use std::collections::BTreeSet;

use leptos::ev::SubmitEvent;
use leptos::html;
use leptos::prelude::*;
use lm_core::command::{
    Command, ExpenseDraft, ExpensePatch, Input, SettlementDraft, SettlementPatch,
};
use lm_core::ids::{ExpenseId, PersonId, SettlementId, ShoppingId};
use lm_core::ledger::{
    format_money, parse_amount, suggest_expense_category, summarize, EXPENSE_CATEGORIES,
};
use lm_core::model::{Date, Entity, Expense, ExpenseCategory, RowKey, Settlement, TripState};
use lm_core::text::{char_count, has_control_chars, trim_white};
use lm_core::time::date_text;
use uuid::Uuid;

use crate::art;
use crate::pages::trip::{use_trip, TripContext};
use crate::views::editors::{AvatarSize, EditorAvatars};
use crate::views::forms::{
    changed, edit_command, set_delta, FormError, FormFields, FormNotices, FormSession, FormTarget,
};
use crate::views::icons;

/// 支出的表單（新增與編輯共用）。
const EXPENSE_FORM: &str = "ledger-expense";
/// 還款的表單（新增、「已還款」與編輯共用）。
const SETTLEMENT_FORM: &str = "ledger-settlement";
/// 需求 6.18、29.12。
const NOT_A_MEMBER: &str = "你不是這趟旅行的旅伴，無法查看或記錄分帳。";
/// 帳目提到、但已不在旅伴中的 id（只在不滿足 I10 的過渡狀態出現）。
const UNKNOWN_PERSON: &str = "已移除的旅伴";

/// 在那一列等待確認的刪除。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Confirm {
    Expense(ExpenseId),
    Settlement(SettlementId),
}

/// Ledger_Tab「分帳記帳」。以 `pages::trip::use_trip()` 取得這趟旅行的內容。
#[component]
pub fn LedgerTab() -> impl IntoView {
    let TripContext { handle, .. } = use_trip();
    // (Bound_Person, 是否為 Trip_Manager)
    let access = Memo::new(move |_| {
        handle
            .viewer()
            .map(|viewer| (viewer.caps.me, viewer.caps.can_manage))
    });
    move || match access.get() {
        Some((Some(_), can_manage)) => view! { <Ledger can_remove=can_manage /> }.into_any(),
        // Unbound_Admin：不顯示需求 29.1 與 29.11 的任何內容
        _ => view! {
            <section class="xp-panel" aria-label="分帳記帳">
                <div class="xp-body">
                    <div class="xp-alert xp-alert-info">
                        <p>{NOT_A_MEMBER}</p>
                    </div>
                </div>
            </section>
        }
        .into_any(),
    }
}

/// Trip_Member 的帳本。`can_remove`：檢視者是有 Bound_Person 的 Trip_Manager（需求 6.17）。
#[component]
fn Ledger(can_remove: bool) -> impl IntoView {
    let TripContext {
        handle, stores, ui, ..
    } = use_trip();
    let confirm = RwSignal::new(None::<Confirm>);
    let expense_keys = stores.expenses.keys();
    let settlement_keys = stores.settlements.keys();
    let empty =
        Memo::new(move |_| expense_keys.with(Vec::is_empty) && settlement_keys.with(Vec::is_empty));
    let total = Memo::new(move |_| {
        handle
            .with_view(|state| {
                state
                    .expenses
                    .values()
                    .map(|expense| expense.amount_cents)
                    .sum::<i64>()
            })
            .unwrap_or(0)
    });
    let new_expense = move |_| {
        let me = handle.viewer().and_then(|viewer| viewer.caps.me);
        if let Some(fields) = handle.with_view(|state| ExpenseFields::new(state, me)) {
            ui.open_form(EXPENSE_FORM, FormTarget::New, fields);
        }
    };
    let new_settlement = move |_| {
        ui.open_form(
            SETTLEMENT_FORM,
            FormTarget::New,
            SettlementFields::new(None),
        );
    };
    view! {
        <section class="xp-panel" aria-labelledby="xp-title">
            <div class="xp-body">
                <header class="xp-head">
                    <h2 id="xp-title">"分帳記帳"</h2>
                </header>
                <div class="xp-toolbar">
                    <p class="xp-total">
                        <b class="xp-total-amount">{move || format_money(total.get())}</b>
                        <span>{move || format!("{} 筆支出", expense_keys.with(Vec::len))}</span>
                    </p>
                    <div class="xp-actions">
                        <button type="button" class="button small primary" on:click=new_expense>
                            "＋ 新增支出"
                        </button>
                        <button type="button" class="button small" on:click=new_settlement>
                            "記錄還款"
                        </button>
                    </div>
                </div>
                <LedgerEditor />
                {move || {
                    if empty.get() {
                        view! { <p class="xp-empty xp-empty-ledger">"還沒有支出。"</p> }.into_any()
                    } else {
                        view! {
                            <Balances />
                            <ExpenseList confirm can_remove />
                            <SettlementList confirm can_remove />
                        }
                            .into_any()
                    }
                }}
            </div>
        </section>
    }
}

// ── 共用的小工具 ──

/// 旅伴的名字；不在旅伴中時為「已移除的旅伴」。
fn person_name(state: &TripState, id: PersonId) -> String {
    state
        .people
        .get(&id)
        .map_or_else(|| UNKNOWN_PERSON.to_owned(), |person| person.name.clone())
}

/// 依 Ordinal 的旅伴 (id, 名字)。
fn people_options(state: &TripState) -> Vec<(PersonId, String)> {
    state
        .people_by_ordinal()
        .map(|person| (person.id, person.name.clone()))
        .collect()
}

/// 金額欄位的文字（現行 `centsToInput()`）：整數元，分不為 0 時加上兩位小數，例如 12050 為「120.50」。
fn cents_input(cents: i64) -> String {
    match cents % 100 {
        0 => (cents / 100).to_string(),
        rest => format!("{}.{rest:02}", cents / 100),
    }
}

/// 瀏覽器所在時區今天的日期（`<input type="date">` 的值），需求 29.11。
fn local_today() -> String {
    let now = js_sys::Date::new_0();
    Date::from_ymd_opt(
        i32::try_from(now.get_full_year()).unwrap_or(1970),
        now.get_month() + 1,
        now.get_date(),
    )
    .map(|date| date.to_string())
    .unwrap_or_default()
}

/// `<input type="date">` 的值；空的或無效時是 `None`。
fn parse_day(text: &str) -> Option<Date> {
    text.trim().parse().ok()
}

/// 選單中的旅伴；「請選擇」是 `None`。
fn parse_person(value: &str) -> Option<PersonId> {
    Uuid::parse_str(value).ok().map(PersonId)
}

/// 現行 `CATEGORY_TONE`：標籤的底色。
fn category_tone(category: ExpenseCategory) -> &'static str {
    match category {
        ExpenseCategory::Food => "green",
        ExpenseCategory::Transport => "blue",
        ExpenseCategory::Lodging => "lavender",
        _ => "peach",
    }
}

/// 表單開啟時把焦點移到第一個欄位（現行 `S.focusId`）。
fn focus_on_mount(element: impl Fn() -> Option<web_sys::HtmlElement> + 'static) {
    Effect::new(move |_| {
        if let Some(element) = element() {
            let _ = element.focus();
        }
    });
}

// ── 誰該還誰與建議還款（需求 29.11）──

/// 「誰該還誰」的一位旅伴。
#[derive(Clone, Debug, PartialEq)]
struct BalanceLine {
    person: PersonId,
    name: String,
    net: String,
    tone: &'static str,
    detail: String,
}

/// 「建議還款」的一筆。
#[derive(Clone, Debug, PartialEq)]
struct TransferLine {
    from: PersonId,
    to: PersonId,
    from_name: String,
    to_name: String,
    amount_cents: i64,
}

fn ledger_lines(state: &TripState) -> (Vec<BalanceLine>, Vec<TransferLine>) {
    let summary = summarize(state);
    let balances = summary
        .listed()
        .map(|balance| BalanceLine {
            person: balance.person,
            name: person_name(state, balance.person),
            net: balance.net_label(),
            tone: match balance.net_cents.signum() {
                1 => "xp-balance-net is-in",
                -1 => "xp-balance-net is-out",
                _ => "xp-balance-net",
            },
            detail: balance.detail_label(),
        })
        .collect();
    let transfers = summary
        .transfers
        .iter()
        .map(|transfer| TransferLine {
            from: transfer.from,
            to: transfer.to,
            from_name: person_name(state, transfer.from),
            to_name: person_name(state, transfer.to),
            amount_cents: transfer.amount_cents,
        })
        .collect();
    (balances, transfers)
}

/// 「誰該還誰」與「建議還款」：依 Optimistic_View 整塊重算（需求 29.10）。
#[component]
fn Balances() -> impl IntoView {
    let TripContext { handle, ui, .. } = use_trip();
    let lines = Memo::new(move |_| handle.with_view(ledger_lines).unwrap_or_default());
    let settle = move |line: &TransferLine| {
        let prefill = (line.from, line.to, line.amount_cents);
        move |_| {
            ui.open_form(
                SETTLEMENT_FORM,
                FormTarget::New,
                SettlementFields::new(Some(prefill)),
            );
        }
    };
    view! {
        <section class="xp-section" aria-labelledby="xp-bal-title">
            <div class="xp-section-head">
                <h3 id="xp-bal-title">"誰該還誰"</h3>
            </div>
            {move || {
                let (balances, transfers) = lines.get();
                let balances = (!balances.is_empty())
                    .then(|| {
                        view! {
                            <ul class="xp-balances">
                                {balances
                                    .into_iter()
                                    .map(|line| {
                                        view! {
                                            <li class="xp-balance" data-xp-person=line.person.to_string()>
                                                <span class="xp-balance-name">{line.name}</span>
                                                <span class=line.tone>{line.net}</span>
                                                <small class="xp-balance-meta">{line.detail}</small>
                                            </li>
                                        }
                                    })
                                    .collect_view()}
                            </ul>
                        }
                    });
                let transfers = (!transfers.is_empty())
                    .then(|| {
                        view! {
                            <h4 class="xp-subhead">"建議還款"</h4>
                            <ul class="xp-transfers">
                                {transfers
                                    .iter()
                                    .map(|line| {
                                        let money = format_money(line.amount_cents);
                                        let label = format!(
                                            "記錄 {} 已還給 {} {money}",
                                            line.from_name,
                                            line.to_name,
                                        );
                                        view! {
                                            <li class="xp-transfer">
                                                <span>
                                                    <b>{line.from_name.clone()}</b>
                                                    " → "
                                                    <b>{line.to_name.clone()}</b>
                                                </span>
                                                <span class="xp-money">{money}</span>
                                                <button
                                                    type="button"
                                                    class="button small xp-settle"
                                                    aria-label=label
                                                    on:click=settle(line)
                                                >
                                                    "已還款"
                                                </button>
                                            </li>
                                        }
                                    })
                                    .collect_view()}
                            </ul>
                        }
                    });
                view! {
                    {balances}
                    {transfers}
                }
            }}
        </section>
    }
}

// ── 確認刪除（需求 29.1）──

/// 在那一列顯示的確認提示：「取消」不送出，「確認移除」才送出 `command`。
#[component]
fn ConfirmRow(text: String, confirm: RwSignal<Option<Confirm>>, command: Command) -> impl IntoView {
    let TripContext { handle, .. } = use_trip();
    let cancel_button = NodeRef::<html::Button>::new();
    focus_on_mount(move || cancel_button.get().map(Into::into));
    let command = StoredValue::new(command);
    let remove = move |_| {
        confirm.set(None);
        handle.submit_or_toast(command.get_value());
    };
    view! {
        <li class="xp-row is-confirm">
            <p>{text}</p>
            <div class="xp-actions">
                <button
                    type="button"
                    class="button small"
                    node_ref=cancel_button
                    on:click=move |_| confirm.set(None)
                >
                    "取消"
                </button>
                <button type="button" class="button small danger" on:click=remove>
                    "確認移除"
                </button>
            </div>
        </li>
    }
}

// ── 支出明細 ──

/// 一列支出顯示的內容。
#[derive(Clone, Debug, PartialEq)]
struct ExpenseLine {
    title: String,
    category: ExpenseCategory,
    amount_cents: i64,
    meta: String,
}

/// 「{付款人} 付款 · {全員|N 人}平分」，有連結時「 · 採買：{品項名稱}」，有備註時「 · {備註}」（需求 29.1）。
fn expense_line(state: &TripState, id: ExpenseId) -> Option<ExpenseLine> {
    let expense = state.expenses.get(&id)?;
    let everyone = !expense.participants.is_empty()
        && expense.participants.len() == state.people.len()
        && expense
            .participants
            .iter()
            .all(|person| state.people.contains_key(person));
    let mut meta = format!(
        "{} 付款 · {}平分",
        person_name(state, expense.payer),
        if everyone {
            "全員".to_owned()
        } else {
            format!("{} 人", expense.participants.len())
        }
    );
    if let Some(item) = expense.shopping_item {
        let name = state
            .shopping
            .get(&item)
            .map_or("已移除的採買品項", |item| item.name.as_str());
        meta.push_str(&format!(" · 採買：{name}"));
    }
    if !expense.note.is_empty() {
        meta.push_str(&format!(" · {}", expense.note));
    }
    Some(ExpenseLine {
        title: expense.title.clone(),
        category: expense.category,
        amount_cents: expense.amount_cents,
        meta,
    })
}

/// 「支出明細」：依日期分組（由新到舊），同一天依 Ordinal；每天顯示支出合計。
#[component]
fn ExpenseList(confirm: RwSignal<Option<Confirm>>, can_remove: bool) -> impl IntoView {
    let TripContext { handle, stores, .. } = use_trip();
    let keys = stores.expenses.keys();
    // 鍵已依 (日期由新到舊, Ordinal) 排列；分組只在鍵或某列的日期改變時改變
    let groups = Memo::new(move |_| {
        let keys = keys.get();
        handle
            .with_view(|state| {
                let mut groups: Vec<(Date, Vec<ExpenseId>)> = Vec::new();
                for id in keys {
                    let Some(expense) = state.expenses.get(&id) else {
                        continue;
                    };
                    match groups.last_mut() {
                        Some((day, ids)) if *day == expense.day => ids.push(id),
                        _ => groups.push((expense.day, vec![id])),
                    }
                }
                groups
            })
            .unwrap_or_default()
    });
    view! {
        <section class="xp-section" aria-labelledby="xp-exp-title">
            <div class="xp-section-head">
                <h3 id="xp-exp-title">"支出明細"</h3>
                <p class="help">{move || format!("{} 筆", keys.with(Vec::len))}</p>
            </div>
            <For
                each=move || groups.with(|groups| groups.iter().map(|(day, _)| *day).collect::<Vec<_>>())
                key=|day| *day
                children=move |day| view! { <ExpenseDay day groups confirm can_remove /> }
            />
            {move || {
                groups
                    .with(Vec::is_empty)
                    .then(|| {
                        view! { <p class="xp-empty">"還沒有任何支出。按「＋ 新增支出」開始記帳。"</p> }
                    })
            }}
        </section>
    }
}

/// 一天的支出與合計。
#[component]
fn ExpenseDay(
    day: Date,
    groups: Memo<Vec<(Date, Vec<ExpenseId>)>>,
    confirm: RwSignal<Option<Confirm>>,
    can_remove: bool,
) -> impl IntoView {
    let TripContext { handle, .. } = use_trip();
    let total = Memo::new(move |_| {
        handle
            .with_view(|state| {
                state
                    .expenses
                    .values()
                    .filter(|expense| expense.day == day)
                    .map(|expense| expense.amount_cents)
                    .sum::<i64>()
            })
            .unwrap_or(0)
    });
    let ids = move || {
        groups.with(|groups| {
            groups
                .iter()
                .find(|(group, _)| *group == day)
                .map(|(_, ids)| ids.clone())
                .unwrap_or_default()
        })
    };
    view! {
        <div class="xp-day">
            <h4 class="xp-day-head">
                <time datetime=day.to_string()>{date_text(day)}</time>
                <span>{move || format_money(total.get())}</span>
            </h4>
            <ul class="xp-rows">
                <For
                    each=ids
                    key=|id| *id
                    children=move |id| view! { <ExpenseRow id confirm can_remove /> }
                />
            </ul>
        </div>
    }
}

/// 一筆支出：標題、分類、金額、付款人與分攤方式；編輯與（Trip_Manager 的）刪除。
#[component]
fn ExpenseRow(
    id: ExpenseId,
    confirm: RwSignal<Option<Confirm>>,
    can_remove: bool,
) -> impl IntoView {
    let TripContext { handle, ui, .. } = use_trip();
    let slot = (Entity::Expense, RowKey::Id(id.0));
    let line = Memo::new(move |_| handle.with_view(|state| expense_line(state, id)).flatten());
    let asking = Memo::new(move |_| confirm.get() == Some(Confirm::Expense(id)));
    let edit = move |_| {
        if let Some(fields) = handle
            .with_view(|state| state.expenses.get(&id).map(ExpenseFields::of))
            .flatten()
        {
            confirm.set(None);
            ui.open_form(EXPENSE_FORM, FormTarget::Edit(slot), fields);
        }
    };
    move || {
        let line = line.get()?;
        let money = format_money(line.amount_cents);
        if asking.get() {
            let text = format!(
                "確定從帳本移除「{}」{money}？大家的結餘會跟著改變。",
                line.title
            );
            return Some(
                view! { <ConfirmRow text confirm command=Command::RemoveExpense { id } /> }
                    .into_any(),
            );
        }
        let title = line.title.clone();
        Some(
            view! {
                <li class="xp-row" data-xp-expense=id.0.to_string()>
                    <div class="xp-row-main">
                        <b class="xp-row-title">{line.title.clone()}</b>
                        <EditorAvatars item=slot size=AvatarSize::Row />
                        <span class=format!("xp-tag {}", category_tone(line.category))>
                            {line.category.as_str()}
                        </span>
                    </div>
                    <span class="xp-money">{money}</span>
                    <small class="xp-row-meta">{line.meta}</small>
                    <div class="xp-row-actions">
                        <button
                            type="button"
                            class="icon-button"
                            aria-label=format!("編輯 {title}")
                            title="編輯支出"
                            on:click=edit
                        >
                            {art::static_svg(icons::EDIT)}
                        </button>
                        {can_remove
                            .then(|| {
                                view! {
                                    <button
                                        type="button"
                                        class="icon-button danger"
                                        aria-label=format!("移除 {title}")
                                        title=format!("移除 {title}")
                                        on:click=move |_| confirm.set(Some(Confirm::Expense(id)))
                                    >
                                        {art::static_svg(icons::CLOSE)}
                                    </button>
                                }
                            })}
                    </div>
                </li>
            }
            .into_any(),
        )
    }
}

// ── 還款紀錄 ──

/// 一列還款顯示的內容。
#[derive(Clone, Debug, PartialEq)]
struct SettlementLine {
    from: String,
    to: String,
    amount_cents: i64,
    day: Date,
    note: String,
}

fn settlement_line(state: &TripState, id: SettlementId) -> Option<SettlementLine> {
    let settlement = state.settlements.get(&id)?;
    Some(SettlementLine {
        from: person_name(state, settlement.from),
        to: person_name(state, settlement.to),
        amount_cents: settlement.amount_cents,
        day: settlement.day,
        note: settlement.note.clone(),
    })
}

/// 「還款紀錄」：由新到舊，同一天依 Ordinal；沒有還款時不顯示。
#[component]
fn SettlementList(confirm: RwSignal<Option<Confirm>>, can_remove: bool) -> impl IntoView {
    let TripContext { stores, .. } = use_trip();
    let keys = stores.settlements.keys();
    let any = Memo::new(move |_| keys.with(|keys| !keys.is_empty()));
    move || {
        any.get().then(|| {
            view! {
                <section class="xp-section" aria-labelledby="xp-set-title">
                    <div class="xp-section-head">
                        <h3 id="xp-set-title">"還款紀錄"</h3>
                        <p class="help">{move || format!("{} 筆", keys.with(Vec::len))}</p>
                    </div>
                    <ul class="xp-rows">
                        <For
                            each=move || keys.get()
                            key=|id| *id
                            children=move |id| view! { <SettlementRow id confirm can_remove /> }
                        />
                    </ul>
                </section>
            }
        })
    }
}

/// 一筆還款：「{付款人} → {收款人}」、金額與日期；編輯與（Trip_Manager 的）刪除。
#[component]
fn SettlementRow(
    id: SettlementId,
    confirm: RwSignal<Option<Confirm>>,
    can_remove: bool,
) -> impl IntoView {
    let TripContext { handle, ui, .. } = use_trip();
    let slot = (Entity::Settlement, RowKey::Id(id.0));
    let line = Memo::new(move |_| {
        handle
            .with_view(|state| settlement_line(state, id))
            .flatten()
    });
    let asking = Memo::new(move |_| confirm.get() == Some(Confirm::Settlement(id)));
    let edit = move |_| {
        if let Some(fields) = handle
            .with_view(|state| state.settlements.get(&id).map(SettlementFields::of))
            .flatten()
        {
            confirm.set(None);
            ui.open_form(SETTLEMENT_FORM, FormTarget::Edit(slot), fields);
        }
    };
    move || {
        let line = line.get()?;
        if asking.get() {
            let text =
                "確定移除這筆還款紀錄？只會修改帳本，不會退回或取消任何實際付款。".to_owned();
            return Some(
                view! { <ConfirmRow text confirm command=Command::RemoveSettlement { id } /> }
                    .into_any(),
            );
        }
        let pair = format!("{} 給 {}", line.from, line.to);
        Some(
            view! {
                <li class="xp-row" data-xp-settlement=id.0.to_string()>
                    <div class="xp-row-main">
                        <b class="xp-row-title">{format!("{} → {}", line.from, line.to)}</b>
                        <EditorAvatars item=slot size=AvatarSize::Row />
                    </div>
                    <span class="xp-money">{format_money(line.amount_cents)}</span>
                    <small class="xp-row-meta">
                        <time datetime=line.day.to_string()>{date_text(line.day)}</time>
                        {(!line.note.is_empty()).then(|| format!(" · {}", line.note))}
                    </small>
                    <div class="xp-row-actions">
                        <button
                            type="button"
                            class="icon-button"
                            aria-label=format!("編輯 {pair} 的還款紀錄")
                            title="編輯還款"
                            on:click=edit
                        >
                            {art::static_svg(icons::EDIT)}
                        </button>
                        {can_remove
                            .then(|| {
                                view! {
                                    <button
                                        type="button"
                                        class="button small quiet danger"
                                        aria-label=format!("移除 {pair} 的還款紀錄")
                                        on:click=move |_| {
                                            confirm.set(Some(Confirm::Settlement(id)))
                                        }
                                    >
                                        "移除"
                                    </button>
                                }
                            })}
                    </div>
                </li>
            }
            .into_any(),
        )
    }
}

// ── 表單 ──

/// 工具列之下開啟中的支出或還款表單。
#[component]
fn LedgerEditor() -> impl IntoView {
    let TripContext { ui, .. } = use_trip();
    move || {
        if let Some(form) = ui.form_session::<ExpenseFields>(EXPENSE_FORM) {
            view! { <ExpenseEditor form /> }.into_any()
        } else if let Some(form) = ui.form_session::<SettlementFields>(SETTLEMENT_FORM) {
            view! { <SettlementEditor form /> }.into_any()
        } else {
            ().into_any()
        }
    }
}

/// 支出表單的草稿：日期與金額是欄位中的文字。
#[derive(Clone, Debug, PartialEq)]
struct ExpenseFields {
    id: ExpenseId,
    title: String,
    day: String,
    amount: String,
    payer: Option<PersonId>,
    participants: BTreeSet<PersonId>,
    category: ExpenseCategory,
    /// 使用者自己選過分類（或是既有的支出）：之後不再依標題建議分類
    category_chosen: bool,
    note: String,
    shopping_item: Option<ShoppingId>,
}

impl ExpenseFields {
    /// 新增支出：隨機的 UUID、今天、付款人是檢視者的 Bound_Person、全部旅伴分攤、分類為食材（現行 `openExpense(null)`）。
    fn new(state: &TripState, me: Option<PersonId>) -> ExpenseFields {
        ExpenseFields {
            id: ExpenseId(Uuid::new_v4()),
            title: String::new(),
            day: local_today(),
            amount: String::new(),
            payer: me.filter(|me| state.people.contains_key(me)),
            participants: state.people.keys().copied().collect(),
            category: ExpenseCategory::Food,
            category_chosen: false,
            note: String::new(),
            shopping_item: None,
        }
    }

    fn of(expense: &Expense) -> ExpenseFields {
        ExpenseFields {
            id: expense.id,
            title: expense.title.clone(),
            day: expense.day.to_string(),
            amount: cents_input(expense.amount_cents),
            payer: Some(expense.payer),
            participants: expense.participants.clone(),
            category: expense.category,
            category_chosen: true,
            note: expense.note.clone(),
            shopping_item: expense.shopping_item,
        }
    }
}

/// 需求 29.2 中排在日期之前的標題規則（日期或金額無法轉成 Command 時在表單上先說明）。
fn title_error(title: &str) -> Option<&'static str> {
    let title = trim_white(title);
    if title.is_empty() || char_count(title) > 100 {
        Some("請填寫 1–100 字的項目名稱。")
    } else if has_control_chars(title) {
        Some("項目名稱不能包含隱藏控制字元。")
    } else {
        None
    }
}

/// 支出的日期與金額（分）；無法轉成 Command 時依需求 29.2 的順序回傳訊息。
fn expense_inputs(fields: &ExpenseFields) -> Result<(Date, i64), String> {
    let day = parse_day(&fields.day);
    let amount = parse_amount(&fields.amount);
    if let (Some(day), Ok(cents)) = (day, amount) {
        return Ok((day, cents));
    }
    if let Some(message) = title_error(&fields.title) {
        return Err(message.to_owned());
    }
    let day = day.ok_or_else(|| "請選擇有效的日期。".to_owned())?;
    amount
        .map(|cents| (day, cents))
        .map_err(|error| error.to_string())
}

/// 只放進改過的欄位；分攤旅伴只放加入與移除的旅伴（需求 7.8、29.2）。
fn expense_patch(
    initial: &ExpenseFields,
    current: &ExpenseFields,
    day: Date,
    cents: i64,
) -> ExpensePatch {
    let (participants_add, participants_remove) =
        set_delta(&initial.participants, &current.participants);
    ExpensePatch {
        day: (parse_day(&initial.day) != Some(day)).then_some(day),
        title: changed(&initial.title, &current.title),
        amount_cents: (parse_amount(&initial.amount).ok() != Some(cents)).then_some(cents),
        payer: changed(&initial.payer, &current.payer).flatten(),
        participants_add,
        participants_remove,
        category: changed(&initial.category, &current.category).map(Input::Ok),
        note: changed(&initial.note, &current.note),
        shopping_item: changed(&initial.shopping_item, &current.shopping_item),
    }
}

/// 支出的表單（現行 `expenseFormHtml()`）。
#[component]
fn ExpenseEditor(form: FormSession<ExpenseFields>) -> impl IntoView {
    let TripContext { handle, .. } = use_trip();
    let draft = form.draft;
    let current = draft.get_untracked();
    let id = current.id;
    let is_new = form.target == FormTarget::New;
    let heading = if is_new {
        "新增支出"
    } else {
        "編輯支出"
    };
    let people = Memo::new(move |_| handle.with_view(people_options).unwrap_or_default());
    let items = Memo::new(move |_| {
        handle
            .with_view(|state| {
                state
                    .shopping_by_ordinal()
                    .map(|item| (item.id, item.name.clone()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    });
    let title_input = NodeRef::<html::Input>::new();
    focus_on_mount(move || title_input.get().map(Into::into));
    let save = move |event: SubmitEvent| {
        event.prevent_default();
        let fields = draft.get_untracked();
        let (day, cents) = match expense_inputs(&fields) {
            Ok(values) => values,
            Err(message) => {
                form.error.set(Some(message));
                return;
            }
        };
        if is_new {
            form.save(|_, current| {
                Some(Command::AddExpense {
                    id,
                    draft: ExpenseDraft {
                        day,
                        title: current.title.clone(),
                        amount_cents: cents,
                        payer: current.payer,
                        participants: current.participants.clone(),
                        category: Input::Ok(current.category),
                        note: current.note.clone(),
                        shopping_item: current.shopping_item,
                    },
                })
            });
        } else if fields.payer.is_none() {
            form.error.set(Some("請選擇付款人。".to_owned()));
        } else {
            form.save(|initial, current| {
                edit_command(expense_patch(initial, current, day, cents), |patch| {
                    Command::UpdateExpense { id, patch }
                })
            });
        }
    };
    let on_title = move |event| {
        let text = event_target_value(&event);
        draft.update(|draft| {
            if !draft.category_chosen {
                // 需求 29.8：依標題建議分類，直到使用者自己選擇分類
                draft.category = if trim_white(&text).is_empty() {
                    ExpenseCategory::Food
                } else {
                    suggest_expense_category(&text)
                };
            }
            draft.title = text;
        });
    };
    let all = move |_| {
        let ids: BTreeSet<PersonId> = people.get_untracked().iter().map(|(id, _)| *id).collect();
        draft.update(|draft| draft.participants = ids);
    };
    let none = move |_| draft.update(|draft| draft.participants.clear());
    view! {
        <form class="xp-editor" novalidate aria-label=heading on:submit=save>
            <FormNotices form />
            <h3>{heading}</h3>
            <FormFields form>
                <fieldset class="xp-fieldset">
                    <legend class="xp-sr">"支出內容"</legend>
                    <div class="xp-grid">
                        <label class="field xp-wide">
                            "項目名稱"
                            <input
                                node_ref=title_input
                                type="text"
                                maxlength="100"
                                autocomplete="off"
                                placeholder="例如：超市食材"
                                value=current.title.clone()
                                on:input=on_title
                            />
                        </label>
                        <label class="field">
                            "日期"
                            <input
                                type="date"
                                value=current.day.clone()
                                on:input=move |event| {
                                    let text = event_target_value(&event);
                                    draft.update(|draft| draft.day = text);
                                }
                            />
                        </label>
                        <label class="field">
                            "金額（新台幣）"
                            <input
                                type="text"
                                inputmode="decimal"
                                autocomplete="off"
                                placeholder="例如 1280"
                                value=current.amount.clone()
                                on:input=move |event| {
                                    let text = event_target_value(&event);
                                    draft.update(|draft| draft.amount = text);
                                }
                            />
                        </label>
                        <label class="field">
                            "付款人"
                            <select on:change=move |event| {
                                let payer = parse_person(&event_target_value(&event));
                                draft.update(|draft| draft.payer = payer);
                            }>
                                <option value="" prop:selected=move || draft.with(|d| d.payer.is_none())>
                                    "請選擇"
                                </option>
                                {move || {
                                    people
                                        .get()
                                        .into_iter()
                                        .map(|(person, name)| {
                                            view! {
                                                <option
                                                    value=person.to_string()
                                                    prop:selected=move || {
                                                        draft.with(|d| d.payer == Some(person))
                                                    }
                                                >
                                                    {name}
                                                </option>
                                            }
                                        })
                                        .collect_view()
                                }}
                            </select>
                        </label>
                        <label class="field">
                            "分類"
                            <select on:change=move |event| {
                                if let Some(category) = ExpenseCategory::parse(&event_target_value(&event)) {
                                    draft.update(|draft| {
                                        draft.category = category;
                                        draft.category_chosen = true;
                                    });
                                }
                            }>
                                {EXPENSE_CATEGORIES
                                    .iter()
                                    .map(|&category| {
                                        view! {
                                            <option
                                                value=category.as_str()
                                                prop:selected=move || {
                                                    draft.with(|d| d.category == category)
                                                }
                                            >
                                                {category.as_str()}
                                            </option>
                                        }
                                    })
                                    .collect_view()}
                            </select>
                        </label>
                        <fieldset class="xp-wide xp-sub">
                            <legend>"分攤的旅伴（平均分攤）"</legend>
                            {move || {
                                let people = people.get();
                                if people.is_empty() {
                                    return view! { <p class="help">"目前沒有旅伴可以選擇。"</p> }
                                        .into_any();
                                }
                                view! {
                                    <div class="xp-people">
                                        {people
                                            .into_iter()
                                            .map(|(person, name)| {
                                                view! {
                                                    <label class="xp-check-label">
                                                        <input
                                                            type="checkbox"
                                                            value=person.to_string()
                                                            prop:checked=move || {
                                                                draft.with(|d| d.participants.contains(&person))
                                                            }
                                                            on:change=move |event| {
                                                                let on = event_target_checked(&event);
                                                                draft
                                                                    .update(|draft| {
                                                                        if on {
                                                                            draft.participants.insert(person);
                                                                        } else {
                                                                            draft.participants.remove(&person);
                                                                        }
                                                                    });
                                                            }
                                                        />
                                                        <span>{name}</span>
                                                    </label>
                                                }
                                            })
                                            .collect_view()}
                                    </div>
                                }
                                    .into_any()
                            }}
                            <div class="xp-actions">
                                <button type="button" class="button small" on:click=all>
                                    "全選"
                                </button>
                                <button type="button" class="button small" on:click=none>
                                    "清除"
                                </button>
                            </div>
                        </fieldset>
                        <label class="field xp-wide">
                            "連結採買品項（選填，只作標示，不會改變採買狀態）"
                            <select on:change=move |event| {
                                let value = event_target_value(&event);
                                let item = Uuid::parse_str(&value).ok().map(ShoppingId);
                                draft.update(|draft| draft.shopping_item = item);
                            }>
                                <option
                                    value=""
                                    prop:selected=move || draft.with(|d| d.shopping_item.is_none())
                                >
                                    "不連結"
                                </option>
                                {move || {
                                    let items = items.get();
                                    let chosen = draft.with(|d| d.shopping_item);
                                    let missing = chosen
                                        .filter(|chosen| !items.iter().any(|(item, _)| item == chosen));
                                    let options = items
                                        .into_iter()
                                        .map(|(item, name)| {
                                            view! {
                                                <option
                                                    value=item.0.to_string()
                                                    prop:selected=move || {
                                                        draft.with(|d| d.shopping_item == Some(item))
                                                    }
                                                >
                                                    {name}
                                                </option>
                                            }
                                        })
                                        .collect_view();
                                    let missing = missing
                                        .map(|item| {
                                            view! {
                                                <option value=item.0.to_string() selected>
                                                    "（原連結的採買品項已移除）"
                                                </option>
                                            }
                                        });
                                    view! {
                                        {options}
                                        {missing}
                                    }
                                }}
                            </select>
                        </label>
                        <label class="field xp-wide">
                            "備註（選填）"
                            <textarea
                                rows="2"
                                maxlength="500"
                                prop:value=current.note.clone()
                                on:input=move |event| {
                                    let text = event_target_value(&event);
                                    draft.update(|draft| draft.note = text);
                                }
                            ></textarea>
                        </label>
                    </div>
                </fieldset>
            </FormFields>
            <FormError form />
            <div class="xp-actions xp-form-actions">
                <button type="button" class="button small" on:click=move |_| form.close()>
                    "取消"
                </button>
                <button type="submit" class="button small primary" disabled=move || form.locked()>
                    "儲存支出"
                </button>
            </div>
        </form>
    }
}

/// 還款表單的草稿：金額與日期是欄位中的文字。
#[derive(Clone, Debug, PartialEq)]
struct SettlementFields {
    id: SettlementId,
    from: Option<PersonId>,
    to: Option<PersonId>,
    amount: String,
    day: String,
    note: String,
    /// 由「已還款」開啟（預填了付款人、收款人與金額）
    prefilled: bool,
}

impl SettlementFields {
    /// 「記錄還款」，或「已還款」預填建議轉帳的付款人、收款人與金額；日期是今天（需求 29.11）。
    fn new(prefill: Option<(PersonId, PersonId, i64)>) -> SettlementFields {
        SettlementFields {
            id: SettlementId(Uuid::new_v4()),
            from: prefill.map(|(from, _, _)| from),
            to: prefill.map(|(_, to, _)| to),
            amount: prefill.map_or_else(String::new, |(_, _, cents)| cents_input(cents)),
            day: local_today(),
            note: String::new(),
            prefilled: prefill.is_some(),
        }
    }

    fn of(settlement: &Settlement) -> SettlementFields {
        SettlementFields {
            id: settlement.id,
            from: Some(settlement.from),
            to: Some(settlement.to),
            amount: cents_input(settlement.amount_cents),
            day: settlement.day.to_string(),
            note: settlement.note.clone(),
            prefilled: false,
        }
    }
}

/// 還款的付款人、收款人、金額（分）與日期；無法轉成 Command 時依需求 29.3 的順序回傳訊息。
fn settlement_inputs(fields: &SettlementFields) -> Result<(PersonId, PersonId, i64, Date), String> {
    let (Some(from), Some(to)) = (fields.from, fields.to) else {
        return Err("請選擇付款與收款的旅伴。".to_owned());
    };
    if from == to {
        return Err("付款人與收款人不能是同一位。".to_owned());
    }
    let cents = parse_amount(&fields.amount).map_err(|error| error.to_string())?;
    let day = parse_day(&fields.day).ok_or_else(|| "請選擇還款日期。".to_owned())?;
    Ok((from, to, cents, day))
}

/// 還款的表單（現行 `settlementFormHtml()`）。
#[component]
fn SettlementEditor(form: FormSession<SettlementFields>) -> impl IntoView {
    let TripContext { handle, .. } = use_trip();
    let draft = form.draft;
    let current = draft.get_untracked();
    let id = current.id;
    let is_new = form.target == FormTarget::New;
    let heading = if is_new {
        "記錄已還款"
    } else {
        "編輯還款"
    };
    let people = Memo::new(move |_| handle.with_view(people_options).unwrap_or_default());
    let from_select = NodeRef::<html::Select>::new();
    let day_input = NodeRef::<html::Input>::new();
    // 現行：預填時焦點在日期，否則在付款的旅伴
    if current.prefilled {
        focus_on_mount(move || day_input.get().map(Into::into));
    } else {
        focus_on_mount(move || from_select.get().map(Into::into));
    }
    let save = move |event: SubmitEvent| {
        event.prevent_default();
        let (from, to, cents, day) = match draft.with_untracked(settlement_inputs) {
            Ok(values) => values,
            Err(message) => {
                form.error.set(Some(message));
                return;
            }
        };
        if is_new {
            form.save(|_, current| {
                Some(Command::AddSettlement {
                    id,
                    draft: SettlementDraft {
                        day,
                        from: Some(from),
                        to: Some(to),
                        amount_cents: cents,
                        note: current.note.clone(),
                    },
                })
            });
        } else {
            form.save(|initial, current| {
                let patch = SettlementPatch {
                    day: (parse_day(&initial.day) != Some(day)).then_some(day),
                    from: (initial.from != Some(from)).then_some(from),
                    to: (initial.to != Some(to)).then_some(to),
                    amount_cents: (parse_amount(&initial.amount).ok() != Some(cents))
                        .then_some(cents),
                    note: changed(&initial.note, &current.note),
                };
                edit_command(patch, |patch| Command::UpdateSettlement { id, patch })
            });
        }
    };
    // 付款與收款的旅伴選單的選項：「請選擇」與依 Ordinal 的旅伴
    let person_options = move |pick: fn(&SettlementFields) -> Option<PersonId>| {
        view! {
            <option value="" prop:selected=move || draft.with(|d| pick(d).is_none())>
                "請選擇"
            </option>
            {move || {
                people
                    .get()
                    .into_iter()
                    .map(|(person, name)| {
                        view! {
                            <option
                                value=person.to_string()
                                prop:selected=move || draft.with(|d| pick(d) == Some(person))
                            >
                                {name}
                            </option>
                        }
                    })
                    .collect_view()
            }}
        }
        .into_any()
    };
    let from_options = person_options(|d| d.from);
    let to_options = person_options(|d| d.to);
    view! {
        <form class="xp-editor" novalidate aria-label=heading on:submit=save>
            <FormNotices form />
            <h3>{heading}</h3>
            <p class="help">"只在錢已經實際交付後才記錄。這裡不會轉帳，也不會通知任何付款服務。"</p>
            <FormFields form>
                <fieldset class="xp-fieldset">
                    <legend class="xp-sr">"還款內容"</legend>
                    <div class="xp-grid">
                        <label class="field">
                            "付款的旅伴"
                            <select
                                node_ref=from_select
                                on:change=move |event| {
                                    let person = parse_person(&event_target_value(&event));
                                    draft.update(|draft| draft.from = person);
                                }
                            >
                                {from_options}
                            </select>
                        </label>
                        <label class="field">
                            "收款的旅伴"
                            <select on:change=move |event| {
                                let person = parse_person(&event_target_value(&event));
                                draft.update(|draft| draft.to = person);
                            }>{to_options}</select>
                        </label>
                        <label class="field">
                            "實際已付金額（新台幣）"
                            <input
                                type="text"
                                inputmode="decimal"
                                autocomplete="off"
                                value=current.amount.clone()
                                on:input=move |event| {
                                    let text = event_target_value(&event);
                                    draft.update(|draft| draft.amount = text);
                                }
                            />
                        </label>
                        <label class="field">
                            "還款日期"
                            <input
                                node_ref=day_input
                                type="date"
                                value=current.day.clone()
                                on:input=move |event| {
                                    let text = event_target_value(&event);
                                    draft.update(|draft| draft.day = text);
                                }
                            />
                        </label>
                        <label class="field xp-wide">
                            "備註（選填）"
                            <textarea
                                rows="2"
                                maxlength="500"
                                placeholder="例如：現金當面交付"
                                prop:value=current.note.clone()
                                on:input=move |event| {
                                    let text = event_target_value(&event);
                                    draft.update(|draft| draft.note = text);
                                }
                            ></textarea>
                        </label>
                    </div>
                </fieldset>
            </FormFields>
            <FormError form />
            <div class="xp-actions xp-form-actions">
                <button type="button" class="button small" on:click=move |_| form.close()>
                    "取消"
                </button>
                <button type="submit" class="button small primary" disabled=move || form.locked()>
                    {if is_new { "記錄這筆還款" } else { "儲存還款" }}
                </button>
            </div>
        </form>
    }
}
