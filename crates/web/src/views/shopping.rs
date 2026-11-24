//! Shopping_Tab「採買清單」（`?tab=shopping`，需求 26.1、26.14、26.15、26.17、6.17、7.10、14.11）。
//!
//! - 沿用 `src/app.js` 的 `shopping()`：品項依採買分類的順序（`Category::ALL`）分組，只顯示有品項的分類，標題旁是
//!   「{N} 項」；同一分類內依 Ordinal（`RowStore` 的排序鍵）。換了分類的品項只在原來的組移除、在新的組建立（需求 14.3）。
//! - 每個品項：「{品項名稱}已買齊」的已買勾選（送出想要的值，也就是操作當下 Optimistic_View 中已買狀態的相反值，
//!   需求 7.10）、名稱、Linked_Item 的「料理：」與連動的料理標題（依需求 24.1 的順序以「、」連接），或帶有「料理已移除」
//!   標記時的「料理已不需要，保留採買品項」（需求 26.14）、「誰負責買」選單（立即送出只改負責人的 Command）、可以直接
//!   修改的數量（只送出數量；有焦點時不被 Remote_Change 覆蓋，需求 14.11），以及編輯與移除的按鈕。
//! - 每一列只讀自己那一列與它連動的料理的 signal，所以勾選或修改一個品項只重繪那一個品項（需求 26.15）。
//! - 新增與編輯共用一個在行內開啟的表單；編輯只送出改過的欄位（需求 7.8）。Linked_Item 的名稱唯讀（需求 26.6）。
//! - 移除：Linked_Item 對每位 Trip_Member 都開啟「移除這項食材？」對話框，列出連動的每一道料理並預設全部勾選，送出
//!   `RemoveIngredientFromMeals`；沒有勾選任何料理時顯示「請至少勾選一道料理。」且不送出（需求 26.17）。其他品項的
//!   直接刪除只對 Trip_Manager 顯示（需求 6.17）。
//!
//! 使用者文字一律以文字節點或屬性輸出（需求 32.6）。
use std::collections::BTreeSet;

use leptos::html;
use leptos::prelude::*;
use lm_core::command::{Command, ShoppingDraft, ShoppingPatch};
use lm_core::ids::{MealId, PersonId, ShoppingId};
use lm_core::itinerary::meal_title;
use lm_core::model::{Category, Date, Entity, Meal, MealSlot, RowKey, ShoppingItem, TripState};
use lm_core::text::{clean_text, trim_white};
use uuid::Uuid;

use crate::art;
use crate::pages::trip::{use_trip, TripContext};
use crate::sync::store::{group_keys, group_names};
use crate::views::editors::{AvatarSize, EditorAvatars};
use crate::views::forms::{
    changed, edit_command, FormError, FormFields, FormNotices, FormSession, FormTarget,
    LiveTextInput,
};
use crate::views::icons;

/// 採買品項的表單（新增與編輯共用）。
const SHOPPING_FORM: &str = "shopping";
/// 沒有填數量的 Meal_Item 的數量；清單中的數量欄位顯示為空白與提示文字（現行 `edit-shopping-quantity`）。
const UNKNOWN_QUANTITY: &str = "數量待確認";
/// 「移除這項食材？」沒有勾選任何料理（需求 26.17）。
const PICK_A_MEAL: &str = "請至少勾選一道料理。";
/// 新品項的數量（現行 `item.quantity || '1 份'`）。
const DEFAULT_QUANTITY: &str = "1 份";

// ── 分頁共用的內容 ──

/// 「誰負責買」選單的一位旅伴。
#[derive(Clone, Debug, PartialEq)]
struct PersonOption {
    id: PersonId,
    name: String,
    color: &'static str,
}

/// 「移除這項食材？」對話框的狀態：要移除的品項、取消勾選的料理（其餘預設勾選），以及錯誤訊息。
#[derive(Clone, Copy)]
struct LinkedRemoval {
    target: RwSignal<Option<ShoppingId>>,
    unchecked: RwSignal<BTreeSet<MealId>>,
    error: RwSignal<Option<String>>,
}

impl LinkedRemoval {
    fn new() -> Self {
        LinkedRemoval {
            target: RwSignal::new(None),
            unchecked: RwSignal::new(BTreeSet::new()),
            error: RwSignal::new(None),
        }
    }

    /// 開啟對話框，連動的料理全部勾選。
    fn open(&self, id: ShoppingId) {
        self.unchecked.set(BTreeSet::new());
        self.error.set(None);
        self.target.set(Some(id));
    }
}

/// Shopping_Tab 的列與表單共用的內容，以 context 提供；整個分頁只算一次。
#[derive(Clone, Copy)]
struct ShoppingContext {
    /// 依 Ordinal 排列的旅伴
    people: Memo<Vec<PersonOption>>,
    /// 檢視者是 Trip_Manager（可以直接刪除品項，需求 6.17）
    manager: Memo<bool>,
    removal: LinkedRemoval,
}

fn use_shopping() -> ShoppingContext {
    expect_context::<ShoppingContext>()
}

fn category_of(item: &ShoppingItem) -> Category {
    item.category
}

/// 料理依需求 24.1 的順序：日期、餐次、Ordinal。
fn meal_order(meal: &Meal) -> (Date, usize, u64) {
    let slot = MealSlot::ALL
        .iter()
        .position(|slot| *slot == meal.slot)
        .unwrap_or(MealSlot::ALL.len());
    (meal.day, slot, meal.ordinal)
}

/// 負責人選單的值：待分配是空字串。
fn assignee_value(assignee: Option<PersonId>) -> String {
    assignee.map(|id| id.to_string()).unwrap_or_default()
}

/// 選單的值轉回負責人；空字串是待分配，無法解析時是 `None`（不改）。
fn parse_assignee(value: &str) -> Option<Option<PersonId>> {
    if value.is_empty() {
        return Some(None);
    }
    Uuid::parse_str(value).ok().map(|id| Some(PersonId(id)))
}

/// 負責人的代表色（現行 `personColor()`）：沒有負責人或找不到旅伴時是 `unassigned`。
fn person_color(people: &[PersonOption], assignee: Option<PersonId>) -> &'static str {
    assignee
        .and_then(|id| people.iter().find(|person| person.id == id))
        .map_or("unassigned", |person| person.color)
}

// ── 分頁 ──

/// Shopping_Tab「採買清單」。以 `pages::trip::use_trip()` 取得這趟旅行的內容。
#[component]
pub fn ShoppingTab() -> impl IntoView {
    let TripContext {
        handle, stores, ui, ..
    } = use_trip();
    let people = Memo::new(move |_| {
        stores
            .people
            .keys()
            .get()
            .into_iter()
            .filter_map(|id| {
                stores.people.get(id).map(|row| {
                    row.with(|person| PersonOption {
                        id: person.id,
                        name: person.name.clone(),
                        color: person.color.as_str(),
                    })
                })
            })
            .collect::<Vec<_>>()
    });
    let manager = Memo::new(move |_| handle.viewer().is_some_and(|viewer| viewer.caps.can_manage));
    provide_context(ShoppingContext {
        people,
        manager,
        removal: LinkedRemoval::new(),
    });

    let groups = stores.shopping.grouped(category_of);
    let progress = Memo::new(move |_| {
        handle
            .with_view(|state| {
                let done = state
                    .shopping
                    .values()
                    .filter(|item| item.purchased)
                    .count();
                (done, state.shopping.len())
            })
            .unwrap_or_default()
    });
    let empty = Memo::new(move |_| stores.shopping.keys().with(Vec::is_empty));
    let new_form = move || {
        ui.form_session::<ShoppingFields>(SHOPPING_FORM)
            .filter(|form| form.target == FormTarget::New)
    };
    let add = move |_| {
        ui.open_form(SHOPPING_FORM, FormTarget::New, ShoppingFields::new());
    };
    view! {
        <div class="section-title">
            <div>
                <span class="eyebrow">"GATHER INGREDIENTS, MAKE MEMORIES"</span>
                <h2>"把好吃的買齊"</h2>
            </div>
            <button
                type="button"
                class="button small"
                disabled=move || new_form().is_some()
                on:click=add
            >
                {art::static_svg(icons::PLUS)}
                "新增品項"
            </button>
        </div>
        <p class="section-description">
            "料理食材會自動分類到這裡；數量可直接修改，負責人與分類也能手動調整。"
        </p>
        <div class="shopping-summary">
            <span>{move || format!("{} / {} 項已買齊", progress.get().0, progress.get().1)}</span>
            <progress
                aria-label="採買完成度"
                max=move || progress.get().1.max(1)
                value=move || progress.get().0
            ></progress>
        </div>
        <div class="shopping-list">
            {move || {
                new_form()
                    .map(|form| {
                        view! {
                            <section class="shopping-category" aria-label="新增採買品項">
                                <ShoppingEditor form />
                            </section>
                        }
                    })
            }}
            <For
                each=group_names(groups)
                key=|category| *category
                children=move |category| view! { <CategoryGroup category groups /> }
            />
            {move || {
                empty
                    .get()
                    .then(|| {
                        view! {
                            <div class="empty">
                                {art::static_svg(icons::CHECK)}
                                <h3>"目前沒有品項"</h3>
                                <p>"新增採買品項，或在料理菜單填寫食材。"</p>
                            </div>
                        }
                    })
            }}
        </div>
        <LinkedRemovalDialog />
    }
}

/// 一個採買分類：標題、「{N} 項」與這個分類的品項（依 Ordinal）。
#[component]
fn CategoryGroup(
    category: Category,
    groups: Memo<Vec<(Category, Vec<ShoppingId>)>>,
) -> impl IntoView {
    let members = group_keys(groups, category);
    let keys = Memo::new(move |_| members());
    view! {
        <section class="shopping-category">
            <h3>
                {category.as_str()}
                <span>{move || format!("{} 項", keys.with(Vec::len))}</span>
            </h3>
            <For
                each=move || keys.get()
                key=|id| *id
                children=move |id| view! { <ShoppingRow id /> }
            />
        </section>
    }
}

// ── 品項 ──

/// 一個品項；正在編輯時改為顯示表單。
#[component]
fn ShoppingRow(id: ShoppingId) -> impl IntoView {
    let TripContext { stores, ui, .. } = use_trip();
    let Some(row) = stores.shopping.get(id) else {
        return ().into_any();
    };
    let item = Memo::new(move |_| row.get());
    let slot = (Entity::Shopping, RowKey::Id(id.0));
    let editing = move || {
        ui.form_session::<ShoppingFields>(SHOPPING_FORM)
            .filter(|form| form.target == FormTarget::Edit(slot))
    };
    (move || match editing() {
        Some(form) => view! { <ShoppingEditor form /> }.into_any(),
        None => view! { <ShoppingLine id item /> }.into_any(),
    })
    .into_any()
}

/// 品項列（現行 `.shopping-row`）：已買勾選與名稱、「誰負責買」、數量與操作按鈕。
#[component]
fn ShoppingLine(id: ShoppingId, item: Memo<ShoppingItem>) -> impl IntoView {
    let TripContext {
        handle, stores, ui, ..
    } = use_trip();
    let shop = use_shopping();
    let slot = (Entity::Shopping, RowKey::Id(id.0));
    let name = Memo::new(move |_| item.with(|item| item.name.clone()));
    let purchased = Memo::new(move |_| item.with(|item| item.purchased));
    let assignee = Memo::new(move |_| item.with(|item| item.assignee));
    let linked = Memo::new(move |_| item.with(|item| !item.meal_ids.is_empty()));
    let recipe_removed = Memo::new(move |_| item.with(|item| item.recipe_removed == Some(true)));
    // 連動的料理標題（需求 31.11 的「{餐次}：{料理名稱}」），依需求 24.1 的順序；只讀這些料理的 signal
    let meal_titles = Memo::new(move |_| {
        stores.meals.keys().track();
        let ids = item.with(|item| item.meal_ids.clone());
        let mut meals: Vec<_> = ids
            .into_iter()
            .filter_map(|meal| {
                stores
                    .meals
                    .get(meal)
                    .map(|row| row.with(|meal| (meal_order(meal), meal_title(meal))))
            })
            .collect();
        meals.sort();
        meals
            .into_iter()
            .map(|(_, title)| title)
            .collect::<Vec<_>>()
    });

    let check = NodeRef::<html::Input>::new();
    // 需求 7.10：送出要設定的值，也就是操作當下 Optimistic_View 中已買狀態的相反值
    let toggle = move |_| {
        let current = purchased.get_untracked();
        handle.submit_or_toast(Command::SetShoppingPurchased {
            id,
            purchased: !current,
        });
        // 被拒絕時勾選框回到 Optimistic_View 的狀態
        if let Some(element) = check.get_untracked() {
            element.set_checked(purchased.get_untracked());
        }
    };

    let select = NodeRef::<html::Select>::new();
    // 立即送出只改負責人的 Command（需求 26.8）
    let assign = move |event: leptos::ev::Event| {
        if let Some(next) = parse_assignee(&event_target_value(&event)) {
            if next != assignee.get_untracked() {
                handle.submit_or_toast(Command::UpdateShoppingItem {
                    id,
                    patch: ShoppingPatch {
                        assignee: Some(next),
                        ..ShoppingPatch::default()
                    },
                });
            }
        }
        // 被拒絕時選單回到 Optimistic_View 的負責人
        if let Some(element) = select.get_untracked() {
            element.set_value(&assignee_value(assignee.get_untracked()));
        }
    };

    // 數量欄位：「數量待確認」顯示為空白與提示文字；只送出數量（需求 26.7、14.11）
    let quantity = Signal::derive(move || {
        item.with(|item| {
            if item.quantity == UNKNOWN_QUANTITY {
                String::new()
            } else {
                item.quantity.clone()
            }
        })
    });
    let commit_quantity = Callback::new(move |text: String| {
        let current = item.with_untracked(|item| item.quantity.clone());
        let value = trim_white(&text);
        if value == current || (value.is_empty() && current == UNKNOWN_QUANTITY) {
            return;
        }
        handle.submit_or_toast(Command::UpdateShoppingItem {
            id,
            patch: ShoppingPatch {
                quantity: Some(value.to_owned()),
                ..ShoppingPatch::default()
            },
        });
    });

    let edit = move |_| {
        let draft = item.with_untracked(ShoppingFields::of);
        ui.open_form(SHOPPING_FORM, FormTarget::Edit(slot), draft);
    };
    // Linked_Item 對每位 Trip_Member 開啟「移除這項食材？」（需求 26.17）；其他品項只有 Trip_Manager 可以直接刪除
    let can_remove = move || linked.get() || shop.manager.get();
    let remove = move |_| {
        if linked.get_untracked() {
            shop.removal.open(id);
        } else {
            handle.submit_or_toast(Command::RemoveShoppingItem { id });
        }
    };

    view! {
        <div class=move || if purchased.get() { "shopping-row done" } else { "shopping-row" }>
            <label>
                <input
                    node_ref=check
                    type="checkbox"
                    prop:checked=move || purchased.get()
                    aria-label=move || format!("{}已買齊", name.get())
                    on:change=toggle
                />
                <span>
                    <b>{move || name.get()} <EditorAvatars item=slot size=AvatarSize::Row /></b>
                    {move || {
                        let titles = meal_titles.get();
                        if !titles.is_empty() {
                            Some(
                                view! {
                                    <small class="recipe-source">
                                        {format!("料理：{}", titles.join("、"))}
                                    </small>
                                }
                                    .into_any(),
                            )
                        } else if recipe_removed.get() {
                            Some(
                                view! {
                                    <small class="recipe-source">
                                        "料理已不需要，保留採買品項"
                                    </small>
                                }
                                    .into_any(),
                            )
                        } else {
                            None
                        }
                    }}
                </span>
            </label>
            <select
                node_ref=select
                class="assignee-select"
                data-person-select=""
                data-person-color=move || shop.people.with(|people| person_color(people, assignee.get()))
                aria-label=move || format!("{}採買負責人", name.get())
                title="選擇負責人後立即儲存"
                on:change=assign
            >
                <option value="" data-person-color="unassigned" prop:selected=move || assignee.get().is_none()>
                    "待分配"
                </option>
                <For
                    each=move || shop.people.get()
                    key=|person| (person.id, person.name.clone(), person.color)
                    children=move |person| {
                        let person_id = person.id;
                        view! {
                            <option
                                value=person_id.to_string()
                                data-person-color=person.color
                                prop:selected=move || assignee.get() == Some(person_id)
                            >
                                {format!("{}負責", person.name)}
                            </option>
                        }
                    }
                />
            </select>
            <LiveTextInput
                class="quantity quantity-input"
                value=quantity
                on_commit=commit_quantity
                label=Signal::derive(move || format!("{}數量", name.get()))
                maxlength=40
                placeholder=UNKNOWN_QUANTITY.to_owned()
            />
            <div class="shopping-row-actions">
                <button
                    type="button"
                    class="icon-button"
                    aria-label=move || format!("編輯 {}", name.get())
                    on:click=edit
                >
                    {art::static_svg(icons::EDIT)}
                </button>
                {move || {
                    can_remove()
                        .then(|| {
                            view! {
                                <button
                                    type="button"
                                    class="icon-button meal-remove-button"
                                    aria-label=move || format!("移除 {}", name.get())
                                    on:click=remove
                                >
                                    {art::static_svg(icons::CLOSE)}
                                </button>
                            }
                        })
                }}
            </div>
        </div>
    }
}

// ── 品項的表單 ──

/// 採買品項表單的草稿。
#[derive(Clone, Debug, PartialEq)]
struct ShoppingFields {
    id: ShoppingId,
    name: String,
    quantity: String,
    category: Category,
    assignee: Option<PersonId>,
}

impl ShoppingFields {
    fn of(item: &ShoppingItem) -> ShoppingFields {
        ShoppingFields {
            id: item.id,
            name: item.name.clone(),
            quantity: item.quantity.clone(),
            category: item.category,
            assignee: item.assignee,
        }
    }

    /// 「新增品項」：以隨機的 UUID 為 id（需求 7.18）、「1 份」、其他、待分配（現行 `editForm('shopping')`）。
    fn new() -> ShoppingFields {
        ShoppingFields {
            id: ShoppingId(Uuid::new_v4()),
            name: String::new(),
            quantity: DEFAULT_QUANTITY.to_owned(),
            category: Category::Other,
            assignee: None,
        }
    }

    /// 新增的 Command（需求 26.2）；LM_Core 修剪名稱與數量並檢查。
    fn add_command(&self) -> Command {
        Command::AddShoppingItem {
            id: self.id,
            draft: ShoppingDraft {
                name: self.name.clone(),
                quantity: self.quantity.clone(),
                category: self.category,
                assignee: self.assignee,
            },
        }
    }
}

/// 只放進改過的欄位（需求 7.8、26.5）。
fn shopping_patch(initial: &ShoppingFields, current: &ShoppingFields) -> ShoppingPatch {
    ShoppingPatch {
        name: changed(&initial.name, &current.name),
        quantity: changed(&initial.quantity, &current.quantity),
        category: changed(&initial.category, &current.category),
        assignee: changed(&initial.assignee, &current.assignee),
    }
}

/// 採買品項的表單（新增與編輯共用，在行內開啟）。
#[component]
fn ShoppingEditor(form: FormSession<ShoppingFields>) -> impl IntoView {
    let TripContext { stores, .. } = use_trip();
    let shop = use_shopping();
    let draft = form.draft;
    let current = draft.get_untracked();
    let id = current.id;
    let is_new = form.target == FormTarget::New;
    // 依 Optimistic_View：Linked_Item 的名稱與料理連動，只能在料理菜單修改（需求 26.6）
    let linked = Memo::new(move |_| {
        !is_new
            && stores
                .shopping
                .get(id)
                .is_some_and(|row| row.with(|item| !item.meal_ids.is_empty()))
    });
    let can_remove = move || !is_new && (linked.get() || shop.manager.get());
    let save = move |event: leptos::ev::SubmitEvent| {
        event.prevent_default();
        if is_new {
            form.save(|_, current| Some(current.add_command()));
        } else {
            form.save(|initial, current| {
                edit_command(shopping_patch(initial, current), |patch| {
                    Command::UpdateShoppingItem { id, patch }
                })
            });
        }
    };
    let remove = move |_| {
        if linked.get_untracked() {
            // 先關閉表單、捨棄草稿，再開啟「移除這項食材？」（現行 `delete()`）
            form.close();
            shop.removal.open(id);
        } else {
            form.submit(Command::RemoveShoppingItem { id });
        }
    };
    let chosen = Memo::new(move |_| draft.with(|draft| draft.assignee));
    view! {
        <form class="dialog-content" novalidate on:submit=save>
            <FormNotices form />
            <FormFields form>
                <h3>{if is_new { "把好吃的加進清單" } else { "編輯採買品項" }}</h3>
                <div class="form-grid">
                    <label class="field wide">
                        <span>"品項名稱"</span>
                        <input
                            type="text"
                            autocomplete="off"
                            maxlength="100"
                            aria-label="品項名稱"
                            value=current.name.clone()
                            readonly=move || linked.get()
                            aria-describedby=move || linked.get().then_some("linked-name-help")
                            on:input=move |event| {
                                let text = event_target_value(&event);
                                draft.update(|draft| draft.name = text);
                            }
                        />
                        {move || {
                            linked
                                .get()
                                .then(|| {
                                    view! {
                                        <small id="linked-name-help" class="help">
                                            "食材名稱與料理連動，請在料理菜單修改；數量、分類與負責人可在這裡調整。"
                                        </small>
                                    }
                                })
                        }}
                    </label>
                    <label class="field">
                        <span>"數量與單位"</span>
                        <input
                            type="text"
                            autocomplete="off"
                            maxlength="40"
                            value=current.quantity.clone()
                            on:input=move |event| {
                                let text = event_target_value(&event);
                                draft.update(|draft| draft.quantity = text);
                            }
                        />
                    </label>
                    <label class="field">
                        <span>"分類"</span>
                        <select on:change=move |event| {
                            if let Some(category) = Category::parse(&event_target_value(&event)) {
                                draft.update(|draft| draft.category = category);
                            }
                        }>
                            {Category::ALL
                                .iter()
                                .map(|category| {
                                    view! {
                                        <option
                                            value=category.as_str()
                                            selected=*category == current.category
                                        >
                                            {category.as_str()}
                                        </option>
                                    }
                                })
                                .collect_view()}
                        </select>
                    </label>
                    <label class="field wide">
                        <span>"誰負責買"</span>
                        <select
                            class="assignee-select"
                            data-person-select=""
                            data-person-color=move || shop.people.with(|people| person_color(people, chosen.get()))
                            on:change=move |event| {
                                if let Some(next) = parse_assignee(&event_target_value(&event)) {
                                    draft.update(|draft| draft.assignee = next);
                                }
                            }
                        >
                            <option
                                value=""
                                data-person-color="unassigned"
                                selected=current.assignee.is_none()
                            >
                                "待分配"
                            </option>
                            {move || {
                                let chosen = draft.with_untracked(|draft| draft.assignee);
                                shop.people
                                    .get()
                                    .into_iter()
                                    .map(|person| {
                                        view! {
                                            <option
                                                value=person.id.to_string()
                                                data-person-color=person.color
                                                selected=chosen == Some(person.id)
                                            >
                                                {person.name}
                                            </option>
                                        }
                                    })
                                    .collect_view()
                            }}
                        </select>
                    </label>
                </div>
            </FormFields>
            <FormError form />
            <div class="form-actions">
                {move || {
                    can_remove()
                        .then(|| {
                            view! {
                                <button type="button" class="text-button danger" disabled=move || form.locked() on:click=remove>
                                    "移除項目"
                                </button>
                            }
                        })
                }}
                <button type="button" class="button" on:click=move |_| form.close()>
                    "取消"
                </button>
                <button type="submit" class="button primary" disabled=move || form.locked()>
                    "儲存"
                    {art::static_svg(icons::CHECK)}
                </button>
            </div>
        </form>
    }
}

// ── 「移除這項食材？」 ──

/// 對話框中的一道連動料理。
#[derive(Clone, Debug, PartialEq)]
struct MealChoice {
    id: MealId,
    label: String,
}

/// 對話框的內容：品項名稱與它連動的料理（依需求 24.1 的順序）；品項已不存在或不再連動任何料理時是 `None`。
fn linked_removal(state: &TripState, id: ShoppingId) -> Option<(String, Vec<MealChoice>)> {
    let item = state.shopping.get(&id)?;
    let mut meals: Vec<&Meal> = item
        .meal_ids
        .iter()
        .filter_map(|meal| state.meals.get(meal))
        .collect();
    if meals.is_empty() {
        return None;
    }
    meals.sort_by_key(|meal| meal_order(meal));
    let choices = meals
        .into_iter()
        .map(|meal| {
            let slot = meal.slot.as_str();
            let title = clean_text(&meal.title);
            let title = if title.is_empty() {
                slot.to_owned()
            } else {
                title
            };
            // 現行 `linkedShoppingDialog()`：「{料理名稱}（{日期} {餐次}）」
            MealChoice {
                id: meal.id,
                label: format!("{title}（{} {slot}）", meal.day),
            }
        })
        .collect();
    Some((item.name.clone(), choices))
}

/// 「移除這項食材？」對話框（現行 `linkedShoppingDialog()`，需求 26.17）。
#[component]
fn LinkedRemovalDialog() -> impl IntoView {
    let TripContext { handle, .. } = use_trip();
    let removal = use_shopping().removal;
    let dialog = NodeRef::<html::Dialog>::new();
    let content = Memo::new(move |_| {
        let id = removal.target.get()?;
        handle
            .with_view(|state| linked_removal(state, id))
            .flatten()
    });
    // 有內容時開啟；品項被刪除或不再連動任何料理時關閉
    Effect::new(move |_| {
        let open = content.with(Option::is_some);
        let Some(element) = dialog.get() else {
            return;
        };
        if open && !element.open() {
            let _ = element.show_modal();
        } else if !open && element.open() {
            element.close();
        }
    });
    let close = move || match dialog.get_untracked() {
        Some(element) if element.open() => element.close(),
        _ => removal.target.set(None),
    };
    let confirm = move || {
        let Some(item) = removal.target.get_untracked() else {
            return;
        };
        let meals: BTreeSet<MealId> = content
            .get_untracked()
            .map(|(_, choices)| {
                removal.unchecked.with_untracked(|unchecked| {
                    choices
                        .into_iter()
                        .map(|choice| choice.id)
                        .filter(|meal| !unchecked.contains(meal))
                        .collect()
                })
            })
            .unwrap_or_default();
        if meals.is_empty() {
            removal.error.set(Some(PICK_A_MEAL.to_owned()));
            return;
        }
        match handle.submit(Command::RemoveIngredientFromMeals { item, meals }) {
            Ok(_) => close(),
            Err(rejection) => removal.error.set(Some(rejection.to_string())),
        }
    };
    view! {
        <dialog
            node_ref=dialog
            aria-labelledby="linked-remove-title"
            on:close=move |_| removal.target.set(None)
        >
            {move || {
                content
                    .get()
                    .map(|(name, choices)| {
                        let many = choices.len() > 1;
                        view! {
                            <div class="dialog-heading">
                                <h2 id="linked-remove-title">"移除這項食材？"</h2>
                                <button
                                    type="button"
                                    class="icon-button"
                                    aria-label="關閉視窗"
                                    on:click=move |_| close()
                                >
                                    {art::static_svg(icons::CLOSE)}
                                </button>
                            </div>
                            <div class="dialog-content">
                                <p>
                                    <b>{name}</b>
                                    " 是料理食材。"
                                    {if many {
                                        "它同時用在下面幾道料理，請勾選要移除的料理："
                                    } else {
                                        "移除後，料理菜單上的這項食材也會一併刪除："
                                    }}
                                </p>
                                <div class="linked-meals">
                                    {choices
                                        .into_iter()
                                        .map(|choice| {
                                            let meal = choice.id;
                                            view! {
                                                <label class="check-row">
                                                    <input
                                                        type="checkbox"
                                                        name="linked-meal"
                                                        value=meal.to_string()
                                                        prop:checked=move || {
                                                            !removal.unchecked.with(|set| set.contains(&meal))
                                                        }
                                                        on:change=move |event| {
                                                            let on = event_target_checked(&event);
                                                            removal.error.set(None);
                                                            removal
                                                                .unchecked
                                                                .update(|set| {
                                                                    if on {
                                                                        set.remove(&meal);
                                                                    } else {
                                                                        set.insert(meal);
                                                                    }
                                                                });
                                                        }
                                                    />
                                                    " "
                                                    {choice.label}
                                                </label>
                                            }
                                        })
                                        .collect_view()}
                                </div>
                                <p class="help">
                                    "提醒：這會同步修改對應料理的食材清單，其他旅伴也會看到變更。"
                                    {many.then_some("若只勾選部分料理，採買品項會保留給其餘料理使用。")}
                                </p>
                                <p class="form-error" role="alert">
                                    {move || removal.error.get()}
                                </p>
                                <div class="form-actions">
                                    <button type="button" class="button" on:click=move |_| close()>
                                        "取消"
                                    </button>
                                    <button
                                        type="button"
                                        class="button danger"
                                        on:click=move |_| confirm()
                                    >
                                        "確認移除"
                                    </button>
                                </div>
                            </div>
                        }
                    })
            }}
        </dialog>
    }
}
