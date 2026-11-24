//! 未分配採買清單（Unassigned_Shopping，需求 22.14、14.5）：唯讀列出 Shopping_Plan 無法分到任何 Shopping_Stop 的
//! 採買品項，包括已買的品項（另外標示「已買」）。
//!
//! 品項依採買分類的順序分組，同一分類內依建立順序（Ordinal）排列；每個品項旁顯示 `shopping_plan()` 的原因：「待分配」、
//! 「{旅伴名字}不在任何車上」或「{車名}還沒有採買停靠點」。整個區塊由 Optimistic_View 重新計算，與其他列在同一次更新
//! 中顯示（需求 14.5）。
use leptos::prelude::*;
use lm_core::itinerary::shopping_plan;
use lm_core::model::{Category, TripState};

use crate::pages::trip::{use_trip, TripContext};

/// 一個未分配的採買品項。
#[derive(Clone, Debug, PartialEq)]
struct UnassignedRow {
    name: String,
    quantity: String,
    purchased: bool,
    reason: String,
}

/// 依採買分類的順序分組，只留下有品項的分類；同一分類內依 Ordinal（`shopping_plan()` 的順序）。
fn unassigned_groups(state: &TripState) -> Vec<(Category, Vec<UnassignedRow>)> {
    let plan = shopping_plan(state);
    let rows: Vec<(Category, UnassignedRow)> = plan
        .unassigned
        .iter()
        .filter_map(|entry| {
            let item = state.shopping.get(&entry.item)?;
            Some((
                item.category,
                UnassignedRow {
                    name: item.name.clone(),
                    quantity: item.quantity.clone(),
                    purchased: item.purchased,
                    reason: entry.reason.clone(),
                },
            ))
        })
        .collect();
    Category::ALL
        .iter()
        .filter_map(|&category| {
            let items: Vec<UnassignedRow> = rows
                .iter()
                .filter(|(of, _)| *of == category)
                .map(|(_, row)| row.clone())
                .collect();
            (!items.is_empty()).then_some((category, items))
        })
        .collect()
}

/// 「未分配採買清單」區塊。
#[component]
pub(super) fn UnassignedShopping() -> impl IntoView {
    let TripContext { handle, .. } = use_trip();
    let groups = Memo::new(move |_| handle.with_view(unassigned_groups).unwrap_or_default());
    let count =
        move || groups.with(|groups| groups.iter().map(|(_, items)| items.len()).sum::<usize>());
    view! {
        <section class="vehicle-departures" aria-labelledby="unassigned-shopping-title">
            <div class="vehicle-departures-heading">
                <div>
                    <span class="eyebrow">"NOT ON THE ROUTE YET"</span>
                    <h2 id="unassigned-shopping-title">
                        "未分配採買清單 " <span>{move || format!("{} 項", count())}</span>
                    </h2>
                </div>
            </div>
            <p class="help">"這些品項還沒有排進任何一台車的採買停靠點。"</p>
            {move || {
                let groups = groups.get();
                if groups.is_empty() {
                    return view! {
                        <div class="departure-vehicles-empty">"每個採買品項都已排進採買停靠點。"</div>
                    }
                        .into_any();
                }
                view! {
                    <div class="shopping-list">
                        {groups
                            .into_iter()
                            .map(|(category, items)| {
                                view! {
                                    <section class="shopping-category">
                                        <h3>
                                            {category.as_str()}
                                            <span>{format!("{} 項", items.len())}</span>
                                        </h3>
                                        {items.into_iter().map(unassigned_row).collect_view()}
                                    </section>
                                }
                            })
                            .collect_view()}
                    </div>
                }
                    .into_any()
            }}
        </section>
    }
}

/// 一個未分配的品項（唯讀）：名稱、原因、數量，已買時標示「已買」。
fn unassigned_row(row: UnassignedRow) -> impl IntoView {
    let quantity = row.quantity.trim().to_owned();
    view! {
        <div class=if row.purchased { "shopping-row done" } else { "shopping-row" }>
            // label 不包控制項，只承擔 `.shopping-row>label` 的版面角色（同 Bun `shopping()`）。
            <label>
                <span>
                    <b>{row.name}</b>
                    <small class="shopping-where is-unrouted">{row.reason}</small>
                </span>
            </label>
            {(!quantity.is_empty()).then(|| view! { <span class="quantity">{quantity}</span> })}
            {row.purchased.then(|| view! { <span class="tag green">"已買"</span> })}
        </div>
    }
}
