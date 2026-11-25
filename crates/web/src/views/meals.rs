//! Menu_Tab「料理菜單」（`?tab=meals`，需求 24）。沿用現行 `src/app.js` 的 `meals()`、`mealCard()` 與料理表單的結構與
//! class。
//!
//! - 只為有料理的日子各顯示一個日期區塊，依日期遞增；標題為「{M}/{D} 週{X}」與「DAY {兩位數} · {N} 道料理」。區塊內的
//!   料理先依餐次、再依 Ordinal 排列（`RowStore` 的排序鍵 `(日期, 餐次, Ordinal)`），不依用餐時間。旅行沒有料理時顯示
//!   「這趟旅行，想吃點什麼？」與「新增餐次，安排第一道料理。」（需求 24.1）。
//! - 日期區塊以 `grouped()` 由鍵與日期算出，外層與內層的 `<For>` 都以鍵走訪：新增、修改、刪除或改日期搬動的料理只在
//!   受影響的區塊建立、更新或移除那一張卡片（需求 24.9、14.1–14.3）。
//! - 料理卡片（需求 24.10）：插圖（custom 依料理 id 固定選出變化，需求 24.6）、餐次、名稱（Trim_White 之後是空的時改為
//!   餐次）、「{份數} 人份 · 主廚 {旅伴名稱或待分配}」、Ingredient_Parser 切出的食材（沒有時「尚未填寫」）、備註不是
//!   空白時可展開的「料理筆記」（展開狀態放在 `UiState`）與編輯按鈕；卡片與表單的刪除只對 Trip_Manager 顯示（需求 6.17）。
//! - 料理表單在行內開啟（新增的在日期區塊之前，編輯的取代那張卡片）：送出前以 LM_Core 檢查（`FormSession::save()` 以
//!   `apply(Mode::Predict)` 檢查，需求 24.2、13.2）；編輯只送出改過的欄位（需求 7.8）。料理範本與常用食材捷徑只改草稿，
//!   儲存之前不送出 Command（需求 24.4、24.11）。改了餐次而這道料理設定了用餐時間時，在同一個 `UpdateMeal` 中清空用餐
//!   時間（需求 24.12）。

use leptos::prelude::*;
use leptos_router::hooks::{use_navigate, use_url};
use leptos_router::NavigateOptions;
use lm_core::command::{Command, Input, MealDraft, MealPatch};
use lm_core::ids::{MealId, PersonId};
use lm_core::ingredients::{classify_ingredient, parse_ingredients};
use lm_core::model::{Date, DishKind, Entity, Meal, MealSlot, RowKey, Slot};
use lm_core::recipes::{
    add_common_ingredient, apply_recipe_template, infer_dish_kind, recipe_template,
    selected_common_ingredients, template_needs_confirmation, RecipeDraft,
    APPLY_TEMPLATE_CONFIRMATION, COMMON_INGREDIENTS, MEAL_SLOTS, RECIPE_TEMPLATES,
};
use lm_core::text::trim_white;
use lm_core::time::{date_range, days_between, month_day, parse_date, weekday_char};
use uuid::Uuid;
use wasm_bindgen::JsValue;

use crate::art::{self, DishArt};
use crate::pages::trip::{use_trip, TripContext};
use crate::sync::store::{group_keys, group_names};
use crate::views::editors::EditorAvatars;
use crate::views::forms::{
    changed, edit_command, FormError, FormFields, FormNotices, FormSession, FormTarget,
};
use crate::views::icons;

/// 料理表單（「新增餐次」與既有料理共用）。
const MEAL_FORM: &str = "meal";

/// 新增料理時預設的餐次（現行表單預設晚餐）。
const DEFAULT_SLOT: MealSlot = MealSlot::Dinner;

/// 現行 `icon('bag')`（「查看採買清單」）。只在這個分頁使用，所以定義在這裡。
const BAG: &str = r#"<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 8h16l-1 13H5L4 8Zm4 0V6a4 4 0 0 1 8 0v2"/></svg>"#;

fn meal_slot(id: MealId) -> Slot {
    (Entity::Meal, RowKey::Id(id.0))
}

/// 檢視者是 Trip_Manager（看得到料理的刪除，需求 6.17、24.10）；在 reactive 範圍中讀取時依 `revision` 重算。
fn can_manage(ctx: TripContext) -> bool {
    ctx.handle
        .viewer()
        .is_some_and(|viewer| viewer.caps.can_manage)
}

/// Menu_Tab「料理菜單」（現行 `meals()`）。
#[component]
pub fn MealsTab() -> impl IntoView {
    let ctx = use_trip();
    let TripContext {
        handle, stores, ui, ..
    } = ctx;
    let days = Memo::new(move |_| stores.card.with(|card| date_range(card.start, card.end)));
    // 需求 24.1：只為有料理的日子各一組，依日期遞增；組內依餐次、再依 Ordinal（RowStore 的排序鍵）
    let groups = stores.meals.grouped(|meal: &Meal| meal.day);
    let new_form = move || {
        ui.form_session::<MealFields>(MEAL_FORM)
            .filter(|form| form.target == FormTarget::New)
    };
    let add = move |_| {
        // 預設為行程表選定的那一天（現行 `dateOptions(day)`），人數為旅伴人數
        let day = days.with_untracked(|days| {
            days.get(ui.schedule_day.get_untracked())
                .or_else(|| days.first())
                .copied()
        });
        let day = day.unwrap_or_else(|| stores.card.with_untracked(|card| card.start));
        let people = handle
            .with_view(|state| state.people.len())
            .unwrap_or_default();
        ui.open_form(MEAL_FORM, FormTarget::New, MealFields::new(day, people));
    };
    view! {
        <div class="section-title">
            <div>
                <span class="eyebrow">"LITTLE MEALS, LASTING MEMORIES"</span>
                <h2>"一起煮，一起吃"</h2>
            </div>
            <button
                type="button"
                class="button small"
                disabled=move || new_form().is_some()
                on:click=add
            >
                {art::static_svg(icons::PLUS)}
                "新增餐次"
            </button>
        </div>
        <p class="section-description">"依日期與餐次安排好每一餐，食材儲存後自動連動採買清單。"</p>
        {move || {
            new_form()
                .map(|form| {
                    view! {
                        <article class="meal-card wide" aria-label="新增料理">
                            <div class="meal-content">
                                <MealEditor form days />
                            </div>
                        </article>
                    }
                })
        }}
        <div class="meal-days">
            <For
                each=group_names(groups)
                key=|day| *day
                children=move |day| view! { <MealDateGroup day groups days /> }
            />
            {move || {
                groups
                    .with(Vec::is_empty)
                    .then(|| {
                        view! {
                            <div class="empty">
                                <h3>"這趟旅行，想吃點什麼？"</h3>
                                <p>"新增餐次，安排第一道料理。"</p>
                            </div>
                        }
                    })
            }}
        </div>
    }
}

/// 一個日期區塊：「{M}/{D} 週{X}」、「DAY {兩位數} · {N} 道料理」與這一天的料理卡片（需求 24.1）。
#[component]
fn MealDateGroup(
    day: Date,
    groups: Memo<Vec<(Date, Vec<MealId>)>>,
    days: Memo<Vec<Date>>,
) -> impl IntoView {
    let members = group_keys(groups, day);
    let keys = Memo::new(move |_| members());
    let count = Memo::new(move |_| keys.with(Vec::len));
    // 第幾天：在旅行的 Trip_Day 中的位置；不在範圍內時（只在過渡狀態）以與開始日的差計算
    let number = Memo::new(move |_| {
        days.with(|days| match days.iter().position(|date| *date == day) {
            Some(index) => index as i64 + 1,
            None => days
                .first()
                .map_or(1, |start| days_between(*start, day) + 1),
        })
    });
    let heading = format!("meal-date-{day}");
    let labelled_by = heading.clone();
    view! {
        <section class="meal-date-group" data-meal-date=day.to_string() aria-labelledby=labelled_by>
            <div class="meal-date-heading">
                <h3 id=heading>
                    <time datetime=day.to_string()>
                        {month_day(day)} " " <span>{format!("週{}", weekday_char(day))}</span>
                    </time>
                </h3>
                <span class="meal-day-count">
                    {move || format!("DAY {:02} ", number.get())}
                    <span aria-hidden="true">"·"</span>
                    {move || format!(" {} 道料理", count.get())}
                </span>
            </div>
            <div class="meal-grid">
                <For each=move || keys.get() key=|id| *id children=move |id| view! { <MealCard id days /> } />
            </div>
        </section>
    }
}

/// 料理卡片顯示的內容。
#[derive(Clone, Debug, PartialEq)]
struct MealSummary {
    slot: MealSlot,
    /// 卡片標題：名稱經 Trim_White 之後是空的時為餐次（需求 24.10）
    heading: String,
    servings: u8,
    /// 負責人的旅伴名稱，沒有負責人時「待分配」
    cook: String,
    /// Ingredient_Parser 切出的名稱
    ingredients: Vec<String>,
    /// 料理筆記；經 Trim_White 之後是空的時不顯示
    notes: String,
    /// 設定的，或依需求 24.5 推斷的插圖種類
    kind: DishKind,
}

fn meal_summary(state: &lm_core::model::TripState, id: MealId) -> Option<MealSummary> {
    let meal = state.meals.get(&id)?;
    let heading = if trim_white(&meal.title).is_empty() {
        meal.slot.as_str().to_owned()
    } else {
        meal.title.clone()
    };
    let cook = meal
        .cook
        .and_then(|cook| state.people.get(&cook))
        .map_or_else(|| "待分配".to_owned(), |person| person.name.clone());
    Some(MealSummary {
        slot: meal.slot,
        heading,
        servings: meal.servings,
        cook,
        ingredients: parse_ingredients(&meal.ingredients),
        notes: meal.notes.clone(),
        kind: infer_dish_kind(meal),
    })
}

/// 插圖（現行 `dishIllustration(kind)` 的結構）：外層 `<span>` 帶有樣式表使用的 class 與 data 屬性，SVG 是隨 App 提供的
/// 靜態檔案（需求 32.6）。custom 依料理 id 固定選出變化（需求 24.6）。
fn dish_illustration(kind: DishKind, id: MealId) -> impl IntoView {
    let dish = DishArt::new(kind, id);
    let kind = dish.kind.as_str();
    view! {
        <span
            class=format!("dish-illustration dish-illustration--{kind}")
            data-dish-kind=kind
            data-dish-variation=dish.variation
            style="display:block"
        >
            {art::static_svg(dish.svg)}
        </span>
    }
}

/// 把網址的 `tab` 換成採買清單，其他參數不變（與旅行頁切換分頁相同）。
fn shopping_url(path: &str, search: &str) -> String {
    let mut params: Vec<&str> = search
        .trim_start_matches('?')
        .split('&')
        .filter(|param| !param.is_empty() && param.split('=').next() != Some("tab"))
        .collect();
    params.push("tab=shopping");
    format!("{path}?{}", params.join("&"))
}

/// `<details>` 目前是否展開（`toggle` 事件）。
fn details_open(event: &leptos::ev::Event) -> Option<bool> {
    let target: JsValue = event.target()?.into();
    js_sys::Reflect::get(&target, &JsValue::from_str("open"))
        .ok()?
        .as_bool()
}

/// 一張料理卡片（現行 `mealCard()`）；正在編輯時改為顯示表單。
#[component]
fn MealCard(id: MealId, days: Memo<Vec<Date>>) -> impl IntoView {
    let ctx = use_trip();
    let TripContext { handle, ui, .. } = ctx;
    let slot = meal_slot(id);
    let summary = Memo::new(move |_| handle.with_view(|state| meal_summary(state, id)).flatten());
    let manager = Memo::new(move |_| can_manage(ctx));
    // 展開狀態放在 UiState：卡片因改日期移到別的區塊而重建時不變（需求 14.4）
    let notes_open = ui.expanded(slot, false);
    let url = use_url();
    let navigate = StoredValue::new_local(use_navigate());
    let go_shopping = move |_| {
        let target = url.with_untracked(|url| shopping_url(url.path(), url.search()));
        navigate.with_value(|navigate| {
            navigate(
                &target,
                NavigateOptions {
                    replace: true,
                    scroll: false,
                    ..Default::default()
                },
            );
        });
    };
    let editing = move || {
        ui.form_session::<MealFields>(MEAL_FORM)
            .filter(|form| form.target == FormTarget::Edit(slot))
    };
    let edit = move |_| {
        if let Some(draft) = handle
            .with_view(|state| state.meals.get(&id).map(MealFields::of))
            .flatten()
        {
            ui.open_form(MEAL_FORM, FormTarget::Edit(slot), draft);
        }
    };
    let remove = move |_| {
        handle.submit_or_toast(Command::RemoveMeal { id });
    };
    let card = move || {
        let summary = summary.get()?;
        let heading = summary.heading.clone();
        let notes = summary.notes.clone();
        let ingredients = if summary.ingredients.is_empty() {
            "尚未填寫".to_owned()
        } else {
            summary.ingredients.join("、")
        };
        Some(view! {
            <div class="meal-illustration">{dish_illustration(summary.kind, id)}</div>
            <div class="meal-content">
                <div class="meal-heading">
                    <div>
                        <span class="meal-slot">{summary.slot.as_str()}</span>
                        <h4>{heading.clone()}</h4>
                    </div>
                    <div class="meal-actions">
                        <EditorAvatars item=slot />
                        <button
                            type="button"
                            class="icon-button"
                            aria-label=format!("編輯 {heading}")
                            on:click=edit
                        >
                            {art::static_svg(icons::EDIT)}
                        </button>
                        {move || {
                            let label = format!("移除 {heading}");
                            manager
                                .get()
                                .then(|| {
                                    view! {
                                        <button
                                            type="button"
                                            class="icon-button meal-remove-button"
                                            aria-label=label
                                            on:click=remove
                                        >
                                            {art::static_svg(icons::CLOSE)}
                                        </button>
                                    }
                                })
                        }}
                    </div>
                </div>
                <p class="meal-meta">
                    {format!("{} 人份 ", summary.servings)} <span aria-hidden="true">"·"</span>
                    {format!(" 主廚 {}", summary.cook)}
                </p>
                <p class="meal-ingredients">
                    <span>"食材"</span>
                    {format!(" {ingredients}")}
                </p>
                <div class="meal-card-footer">
                    {(!trim_white(&notes).is_empty())
                        .then(|| {
                            view! {
                                <details
                                    class="meal-notes"
                                    prop:open=move || notes_open.get()
                                    on:toggle=move |event| {
                                        if let Some(open) = details_open(&event) {
                                            if notes_open.get_untracked() != open {
                                                notes_open.set(open);
                                            }
                                        }
                                    }
                                >
                                    <summary>"料理筆記"</summary>
                                    <p>{notes}</p>
                                </details>
                            }
                        })}
                    <button type="button" class="text-button" on:click=go_shopping>
                        {art::static_svg(BAG)}
                        "查看採買清單"
                    </button>
                </div>
            </div>
        })
    };
    view! {
        <article
            class=move || if editing().is_some() { "meal-card wide" } else { "meal-card" }
            data-meal-id=id.0.to_string()
            data-meal-slot=move || {
                summary.with(|summary| summary.as_ref().map(|summary| summary.slot.as_str()))
            }
        >
            {move || match editing() {
                Some(form) => {
                    view! {
                        <div class="meal-content">
                            <MealEditor form days />
                        </div>
                    }
                        .into_any()
                }
                None => card().into_any(),
            }}
        </article>
    }
}

// ── 料理表單 ──

/// 料理表單的草稿。份數是欄位中的文字，儲存時才解析；插圖種類只由料理範本改變（現行的隱藏欄位 `imageKind`）。
#[derive(Clone, Debug, PartialEq)]
struct MealFields {
    id: MealId,
    day: Date,
    slot: MealSlot,
    title: String,
    cook: Option<PersonId>,
    servings: String,
    ingredients: String,
    notes: String,
    dish: Option<DishKind>,
}

impl MealFields {
    fn of(meal: &Meal) -> MealFields {
        MealFields {
            id: meal.id,
            day: meal.day,
            slot: meal.slot,
            title: meal.title.clone(),
            cook: meal.cook,
            servings: meal.servings.to_string(),
            ingredients: meal.ingredients.clone(),
            notes: meal.notes.clone(),
            dish: meal.dish,
        }
    }
    /// 「新增餐次」：以隨機的 UUID 為 id（需求 7.18），晚餐、待分配，人數為旅伴人數（至少 1）。
    fn new(day: Date, people: usize) -> MealFields {
        MealFields {
            id: MealId(Uuid::new_v4()),
            day,
            slot: DEFAULT_SLOT,
            title: String::new(),
            cook: None,
            servings: people.max(1).to_string(),
            ingredients: String::new(),
            notes: String::new(),
            dish: None,
        }
    }
    fn recipe(&self) -> RecipeDraft {
        RecipeDraft {
            title: self.title.clone(),
            notes: self.notes.clone(),
            ingredients: self.ingredients.clone(),
            dish: self.dish,
        }
    }
    fn add_command(&self) -> Command {
        Command::AddMeal {
            id: self.id,
            draft: MealDraft {
                day: self.day,
                slot: Input::Ok(self.slot),
                time: None,
                title: self.title.clone(),
                cook: self.cook,
                servings: servings_input(&self.servings),
                ingredients: self.ingredients.clone(),
                notes: self.notes.clone(),
                dish: self.dish.map(Input::Ok),
            },
        }
    }
}

/// 份數欄位的文字：是 0–255 的整數時交給 LM_Core 檢查範圍，其他文字（包括空白）原樣送出，由 LM_Core 回應
/// 「人數請填 1 到 100 的整數。」（需求 24.2）。
fn servings_input(text: &str) -> Input<u8> {
    match text.trim().parse::<u8>() {
        Ok(servings) => Input::Ok(servings),
        Err(_) => Input::Bad(serde_json::Value::String(text.to_owned())),
    }
}

/// 只放進改過的欄位（需求 7.8）；改了餐次而這道料理設定了用餐時間時，在同一個 patch 中清空用餐時間（需求 24.12）。
fn meal_patch(initial: &MealFields, current: &MealFields, has_time: bool) -> MealPatch {
    let slot = changed(&initial.slot, &current.slot);
    MealPatch {
        day: changed(&initial.day, &current.day),
        time: (slot.is_some() && has_time).then_some(None),
        slot: slot.map(Input::Ok),
        title: changed(&initial.title, &current.title),
        cook: changed(&initial.cook, &current.cook),
        servings: changed(&initial.servings, &current.servings).map(|text| servings_input(&text)),
        ingredients: changed(&initial.ingredients, &current.ingredients),
        notes: changed(&initial.notes, &current.notes),
        dish: changed(&initial.dish, &current.dish).map(|dish| dish.map(Input::Ok)),
    }
}

/// 日期選單的文字（現行 `dateOptions()`）：「{M}/{D} 週{X}」。
fn day_label(date: Date) -> String {
    format!("{} 週{}", month_day(date), weekday_char(date))
}

/// 料理表單（現行 `editForm('meal')`）。
#[component]
fn MealEditor(form: FormSession<MealFields>, days: Memo<Vec<Date>>) -> impl IntoView {
    let ctx = use_trip();
    let TripContext { handle, .. } = ctx;
    let draft = form.draft;
    let current = draft.get_untracked();
    let id = current.id;
    let is_new = form.target == FormTarget::New;
    let manager = Memo::new(move |_| can_manage(ctx));
    let people = Memo::new(move |_| {
        handle
            .with_view(|state| {
                state
                    .people_by_ordinal()
                    .map(|person| (person.id, person.name.clone()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    });
    // 範本或捷徑改了草稿時加一，使名稱、食材與筆記欄位顯示新的內容；使用者輸入時不重設欄位（游標保持原位）
    let replaced = RwSignal::new(0_u32);
    let shown = move |field: fn(&MealFields) -> String| {
        move || {
            replaced.track();
            draft.with_untracked(field)
        }
    };
    let ingredients = Memo::new(move |_| draft.with(|draft| draft.ingredients.clone()));
    let selected = Memo::new(move |_| ingredients.with(|text| selected_common_ingredients(text)));
    let names = Memo::new(move |_| ingredients.with(|text| parse_ingredients(text)));
    let template = RwSignal::new(None::<&'static str>);
    let chosen = move || template.get().and_then(recipe_template);
    // 需求 24.11：套用範本只改草稿；名稱或筆記不是空白、或已設定不同的插圖種類時先詢問；合併後超過 2,000 字時草稿不變
    let apply_template = move |_| {
        let Some(recipe) = template.get_untracked().and_then(recipe_template) else {
            return;
        };
        let before = draft.with_untracked(MealFields::recipe);
        if template_needs_confirmation(&before, recipe)
            && !window()
                .confirm_with_message(APPLY_TEMPLATE_CONFIRMATION)
                .unwrap_or(false)
        {
            return;
        }
        match apply_recipe_template(&before, recipe) {
            Ok(next) => {
                draft.update(|draft| {
                    draft.title = next.title;
                    draft.notes = next.notes;
                    draft.ingredients = next.ingredients;
                    draft.dish = next.dish;
                });
                form.error.set(None);
                replaced.update(|n| *n += 1);
            }
            Err(error) => form.error.set(Some(error.to_string())),
        }
    };
    // 需求 24.11：常用食材捷徑以 merge_ingredients() 合併，只改草稿；超過 2,000 字時草稿不變
    let add_ingredient = move |name: &'static str| {
        let before = draft.with_untracked(|draft| draft.ingredients.clone());
        match add_common_ingredient(&before, name) {
            Ok(next) => {
                draft.update(|draft| draft.ingredients = next);
                replaced.update(|n| *n += 1);
            }
            Err(error) => form.error.set(Some(error.to_string())),
        }
    };
    let save = move |event: leptos::ev::SubmitEvent| {
        event.prevent_default();
        if is_new {
            form.save(|_, current| Some(current.add_command()));
        } else {
            // 儲存當下的料理是否設定了用餐時間（需求 24.12）
            let has_time = handle
                .with_view(|state| state.meals.get(&id).map(|meal| meal.time.is_some()))
                .flatten()
                .unwrap_or(false);
            form.save(|initial, current| {
                edit_command(meal_patch(initial, current, has_time), |patch| {
                    Command::UpdateMeal { id, patch }
                })
            });
        }
    };
    let remove = move |_| {
        form.submit(Command::RemoveMeal { id });
    };
    view! {
        <form class="meal-form" novalidate on:submit=save>
            <FormNotices form />
            <FormFields form>
                <h3>{if is_new { "新增一道好日子" } else { "編輯餐次" }}</h3>
                <div class="form-grid">
                    <section class="wide recipe-tools">
                        <div class="recipe-tools-heading">
                            <span class="eyebrow">"A LITTLE HELP IN THE KITCHEN"</span>
                            <h3>"今晚想煮什麼？"</h3>
                            <p>"從常用料理開始，或直接往下填。食材會合併，不會清空你的清單。"</p>
                        </div>
                        <div class="template-controls">
                            <label class="field">
                                <span>"常用料理範本"</span>
                                <select
                                    id="recipe-template"
                                    aria-label="常用料理範本"
                                    on:change=move |event| {
                                        let value = event_target_value(&event);
                                        template
                                            .set(
                                                RECIPE_TEMPLATES
                                                    .iter()
                                                    .find(|recipe| recipe.id == value)
                                                    .map(|recipe| recipe.id),
                                            );
                                    }
                                >
                                    <option value="">"選一道常用料理"</option>
                                    {RECIPE_TEMPLATES
                                        .iter()
                                        .map(|recipe| {
                                            view! { <option value=recipe.id>{recipe.title}</option> }
                                        })
                                        .collect_view()}
                                </select>
                            </label>
                            <button
                                type="button"
                                class="button primary"
                                disabled=move || chosen().is_none()
                                on:click=apply_template
                            >
                                "套用範本"
                            </button>
                        </div>
                        <div id="template-preview" hidden=move || chosen().is_none()>
                            {move || {
                                chosen()
                                    .map(|recipe| {
                                        view! {
                                            <strong>{recipe.title}</strong>
                                            <p>{recipe.ingredients}</p>
                                        }
                                    })
                            }}
                        </div>
                    </section>
                    <label class="field wide">
                        <span>"料理名稱"</span>
                        <input
                            name="title"
                            type="text"
                            autocomplete="off"
                            maxlength="100"
                            aria-label="料理名稱"
                            prop:value=shown(|draft| draft.title.clone())
                            on:input=move |event| {
                                let text = event_target_value(&event);
                                draft.update(|draft| draft.title = text);
                            }
                        />
                    </label>
                    <label class="field">
                        <span>"日期"</span>
                        {move || {
                            let chosen = draft.with_untracked(|draft| draft.day);
                            view! {
                                <select
                                    name="date"
                                    aria-label="日期"
                                    on:change=move |event| {
                                        if let Some(day) = parse_date(&event_target_value(&event)) {
                                            draft.update(|draft| draft.day = day);
                                        }
                                    }
                                >
                                    {days
                                        .get()
                                        .into_iter()
                                        .map(|date| {
                                            view! {
                                                <option value=date.to_string() selected=date == chosen>
                                                    {day_label(date)}
                                                </option>
                                            }
                                        })
                                        .collect_view()}
                                </select>
                            }
                        }}
                    </label>
                    <label class="field">
                        <span>"餐次"</span>
                        <select
                            name="slot"
                            aria-label="餐次"
                            required
                            on:change=move |event| {
                                if let Some(slot) = MealSlot::parse(&event_target_value(&event)) {
                                    draft.update(|draft| draft.slot = slot);
                                }
                            }
                        >
                            {MEAL_SLOTS
                                .iter()
                                .map(|slot| {
                                    view! {
                                        <option value=slot.as_str() selected=*slot == current.slot>
                                            {slot.as_str()}
                                        </option>
                                    }
                                })
                                .collect_view()}
                        </select>
                    </label>
                    <label class="field">
                        <span>"主廚"</span>
                        {move || {
                            let cook = draft.with_untracked(|draft| draft.cook);
                            view! {
                                <select
                                    name="cookId"
                                    aria-label="主廚"
                                    on:change=move |event| {
                                        let value = event_target_value(&event);
                                        let cook = Uuid::parse_str(&value).ok().map(PersonId);
                                        draft.update(|draft| draft.cook = cook);
                                    }
                                >
                                    <option value="" selected=cook.is_none()>
                                        "待分配"
                                    </option>
                                    {people
                                        .get()
                                        .into_iter()
                                        .map(|(person, name)| {
                                            view! {
                                                <option
                                                    value=person.0.to_string()
                                                    selected=cook == Some(person)
                                                >
                                                    {name}
                                                </option>
                                            }
                                        })
                                        .collect_view()}
                                </select>
                            }
                        }}
                    </label>
                    <label class="field">
                        <span>"人數"</span>
                        <input
                            name="servings"
                            type="number"
                            min="1"
                            max="100"
                            required
                            value=current.servings.clone()
                            on:input=move |event| {
                                let text = event_target_value(&event);
                                draft.update(|draft| draft.servings = text);
                            }
                        />
                    </label>
                    <label class="field wide">
                        <span>"食材（以頓號、/、逗號或句點分隔）"</span>
                        <textarea
                            name="ingredients"
                            aria-label="食材（以頓號、/、逗號或句點分隔）"
                            rows="3"
                            aria-describedby="ingredient-help"
                            placeholder="牛肉片、高麗菜、雞蛋、壽喜燒醬"
                            prop:value=shown(|draft| draft.ingredients.clone())
                            on:input=move |event| {
                                let text = event_target_value(&event);
                                draft.update(|draft| draft.ingredients = text);
                            }
                        ></textarea>
                    </label>
                    <details class="wide common-ingredients">
                        <summary>"常用食材，點一下加進來"</summary>
                        <p class="help">"已在清單裡的食材不會重複加入；移除請直接編輯食材欄。"</p>
                        {COMMON_INGREDIENTS
                            .iter()
                            .map(|group| {
                                view! {
                                    <fieldset>
                                        <legend>{group.label}</legend>
                                        <div class="ingredient-shortcuts">
                                            {group
                                                .names
                                                .iter()
                                                .map(|&name| {
                                                    // 需求 24.4：已有相同 Ingredient_Key 的捷徑停用並標示為已選取
                                                    let included = move || {
                                                        selected.with(|set| set.contains(name))
                                                    };
                                                    view! {
                                                        <button
                                                            type="button"
                                                            disabled=included
                                                            aria-pressed=move || {
                                                                if included() { "true" } else { "false" }
                                                            }
                                                            on:click=move |_| add_ingredient(name)
                                                        >
                                                            {name}
                                                        </button>
                                                    }
                                                })
                                                .collect_view()}
                                        </div>
                                    </fieldset>
                                }
                            })
                            .collect_view()}
                    </details>
                    <div id="ingredient-preview" class="wide ingredient-preview" aria-live="polite">
                        <p class="help">
                            {move || {
                                format!(
                                    "{} 項食材 · 分類預覽，儲存後才會更新採買清單。",
                                    names.with(Vec::len),
                                )
                            }}
                        </p>
                        <div class="ingredient-tags">
                            {move || {
                                names
                                    .get()
                                    .into_iter()
                                    .map(|name| {
                                        let category = classify_ingredient(&name).as_str();
                                        view! {
                                            <span>
                                                {name}
                                                <b>{category}</b>
                                            </span>
                                        }
                                    })
                                    .collect_view()
                            }}
                        </div>
                        <p id="ingredient-help" class="help">
                            "可用頓號、/、逗號、句點或換行分隔；數字中的小數點會保留。數量請到採買清單填寫，無法辨識的歸「其他」；既有品項保留原分類。"
                        </p>
                    </div>
                    <label class="field wide">
                        <span>"料理筆記"</span>
                        <textarea
                            name="notes"
                            aria-label="料理筆記"
                            rows="3"
                            prop:value=shown(|draft| draft.notes.clone())
                            on:input=move |event| {
                                let text = event_target_value(&event);
                                draft.update(|draft| draft.notes = text);
                            }
                        ></textarea>
                    </label>
                </div>
            </FormFields>
            <FormError form />
            <div class="form-actions">
                {move || {
                    (!is_new && manager.get())
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
