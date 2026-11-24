//! Departure_Page（`/<帳號名稱>/trips/<id>/go`，需求 28）。
//!
//! - 開啟時以 App 層的 `TripSyncs` 取得這趟旅行的 `TripSync`：從 Trip_Page 經 App 內的連結前往時沿用記憶體中的 Replica
//!   與 Pending_Command，不重新讀取 Snapshot；直接開啟時與 Trip_Page 相同地由 App 外框加入 Trip_Channel 並讀取 Snapshot
//!   （需求 10.10、28.6）。收到 `trip_deleted` 時由同步引擎的 `leave_trip` 前往 Home_Page（需求 10.12）。
//! - 沿用 `src/app.js` 的 `departure()` 與 `myFoodSection()`：依 Optimistic_View 顯示 Packing_Progress、未分配共用裝備的
//!   提示與「回去分配」、My_Gear 的打包勾選、我負責的食材與已買勾選（附 Shopping_Plan 的「第 N 天在{地點名稱}」）、
//!   「確認準備完成，出發」與下一個未完成的活動（需求 28.1、28.5）；已確認出發時依需求 28.7 改變標題與按鈕，並提供
//!   「完成這一站」。Unbound_Admin 只看到管理員的說明與「回到規劃手冊」（需求 28.8，現行帳號版的 `.empty`）。
//! - 勾選送出想要的值（需求 7.10）；被拒絕時以 Toast 顯示訊息，勾選框回到 Optimistic_View 的狀態。列以 `<For>` 依 id
//!   保留節點，Optimistic_View 改變時焦點不受影響。使用者文字一律以文字節點或屬性輸出（需求 32.6）。
use leptos::html;
use leptos::prelude::*;
use leptos_router::hooks::use_navigate;
use lm_core::command::Command;
use lm_core::ids::{ActivityId, GearId, PersonId, ShoppingId, TripId};
use lm_core::itinerary::{next_activity, participant_label, place_name, shopping_plan};
use lm_core::model::{Date, GearScope};
use lm_core::rules::{can_depart, my_gear, packing_progress, unassigned_gear, Progress};
use lm_core::time::{month_day, Hm};

use crate::app::{trip_path, Shell};
use crate::art;
use crate::pages::trip::{map_link, ConnectionBanners};
use crate::session::use_auth;
use crate::sync::engine::{use_trip_syncs, TripHandle};
use crate::views::icons;

/// 現行 `icons.tent`（出發清單進度列的圖示）。
const TENT: &str = r#"<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m3 20 9-16 9 16H3Zm5 0 4-8 4 8M10 2l4 4m0-4-4 4"/></svg>"#;

/// 採買品項的數量為這個值時不顯示（需求 28.1）。
const QUANTITY_TBD: &str = "數量待確認";

/// 自己的 Departure_Page（App 外框已確認有 Session，而且網址中的帳號名稱是自己的）。
#[component]
pub fn DeparturePage(trip: TripId) -> impl IntoView {
    let handle = use_trip_syncs().open(trip);
    let loaded = Memo::new(move |_| handle.stores.try_get().flatten().is_some());
    view! {
        <Shell
            class="page departure"
            top=Box::new(move || view! { <ConnectionBanners handle /> }.into_any())
        >
            {move || {
                if loaded.get() {
                    view! { <DepartureLoaded trip handle /> }.into_any()
                } else {
                    // 第一次的 Snapshot 合併之前（需求 12.1）
                    view! {
                        <p class="acct-loading" role="status">
                            "正在載入出發清單…"
                        </p>
                    }
                        .into_any()
                }
            }}
        </Shell>
    }
}

/// 第一次的 Snapshot 合併之後：依檢視者有沒有 Bound_Person 顯示行前清單或管理員的說明。
#[component]
fn DepartureLoaded(trip: TripId, handle: TripHandle) -> impl IntoView {
    let user = use_auth().user();
    let planner = Signal::derive(move || {
        user.with(|user| {
            user.as_ref()
                .map(|u| trip_path(&u.username, trip))
                .unwrap_or_default()
        })
    });
    let title = Memo::new(move |_| {
        handle
            .with_view(|state| state.card.title.clone())
            .unwrap_or_default()
    });
    Effect::new(move |_| document().set_title(&format!("{} · 日子拾光", title.get())));
    let me = Memo::new(move |_| handle.viewer().and_then(|viewer| viewer.caps.me));
    move || match me.get() {
        Some(person) => view! { <Checklist handle person planner title /> }.into_any(),
        // Unbound_Admin（需求 28.8）
        None => view! {
            <div class="empty">
                <h1>"你目前以管理員身分檢視"</h1>
                <p>"尚未加入此旅行，因此沒有個人行前清單。你仍可編輯所有旅行內容。"</p>
                <a class="button primary" href=move || planner.get()>
                    "回到規劃手冊"
                </a>
            </div>
        }
        .into_any(),
    }
}

/// My_Gear 的一列。
#[derive(Clone, Debug, PartialEq, Eq)]
struct PackRow {
    id: GearId,
    name: String,
    quantity: String,
    packed: bool,
}

/// 我負責的食材的一列。
#[derive(Clone, Debug, PartialEq, Eq)]
struct FoodRow {
    id: ShoppingId,
    name: String,
    quantity: String,
    purchased: bool,
    /// Shopping_Plan 分到的 Shopping_Stop：第幾天與地點名稱
    stop: Option<(usize, String)>,
}

/// 下一個未完成的活動（需求 28.5）。
#[derive(Clone, Debug, PartialEq, Eq)]
struct NextStop {
    id: ActivityId,
    title: String,
    day: Date,
    time: Hm,
    location: String,
    participants: String,
    note: String,
}

/// 現行 `Math.round(done / Math.max(1, total) * 100)`。
fn percent(progress: Progress) -> usize {
    let total = progress.total.max(1);
    (progress.done * 200 + total) / (2 * total)
}

/// Bound_Person 的行前清單（`departure()`）。
#[component]
fn Checklist(
    handle: TripHandle,
    person: PersonId,
    planner: Signal<String>,
    title: Memo<String>,
) -> impl IntoView {
    let name = Memo::new(move |_| {
        handle
            .with_view(|state| state.people.get(&person).map(|p| p.name.clone()))
            .flatten()
            .unwrap_or_default()
    });
    let departed = Memo::new(move |_| {
        handle
            .with_view(|state| state.departures.contains_key(&person))
            .unwrap_or(false)
    });
    let progress = Memo::new(move |_| {
        handle
            .with_view(|state| packing_progress(state, person))
            .unwrap_or_default()
    });
    let missing = Memo::new(move |_| {
        handle
            .with_view(|state| {
                unassigned_gear(state)
                    .map(|gear| gear.name.as_str())
                    .collect::<Vec<_>>()
                    .join("、")
            })
            .unwrap_or_default()
    });
    let ready = Memo::new(move |_| {
        handle
            .with_view(|state| can_depart(state, person))
            .unwrap_or(false)
    });
    let gear_rows = move |scope: GearScope| {
        Memo::new(move |_| {
            handle
                .with_view(|state| {
                    my_gear(state, person)
                        .filter(|gear| gear.scope == scope)
                        .map(|gear| PackRow {
                            id: gear.id,
                            name: gear.name.clone(),
                            quantity: gear.quantity.clone(),
                            packed: gear.packed_by.contains(&person),
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        })
    };
    let food = Memo::new(move |_| {
        handle
            .with_view(|state| {
                let plan = shopping_plan(state);
                state
                    .shopping_by_ordinal()
                    .filter(|item| item.assignee == Some(person))
                    .map(|item| FoodRow {
                        id: item.id,
                        name: item.name.clone(),
                        quantity: item.quantity.clone(),
                        purchased: item.purchased,
                        stop: plan
                            .stop_of(item.id)
                            .map(|stop| (stop.n, place_name(state, stop.place).to_owned())),
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    });
    let next = Memo::new(move |_| {
        handle
            .with_view(|state| {
                next_activity(state, person).map(|activity| NextStop {
                    id: activity.id,
                    title: activity.title.clone(),
                    day: activity.day,
                    time: activity.time,
                    location: activity.location.clone(),
                    participants: participant_label(state, activity),
                    note: activity.note.clone(),
                })
            })
            .flatten()
    });

    let navigate = use_navigate();
    let resolve_gear = move |_| {
        navigate(
            &format!("{}?tab=gear", planner.get_untracked()),
            Default::default(),
        )
    };
    let depart = move |_| {
        handle.submit_or_toast(Command::SetDeparted {
            person,
            departed: true,
        });
    };

    let columns = [GearScope::Personal, GearScope::Shared]
        .into_iter()
        .map(|scope| {
            let rows = gear_rows(scope);
            let heading = match scope {
                GearScope::Personal => "自己的小行李",
                GearScope::Shared => "我負責的公用裝備",
            };
            view! {
                <section>
                    <h2>{heading}</h2>
                    <div class="packing-list">
                        <For
                            each=move || rows.with(|rows| rows.iter().map(|row| row.id).collect::<Vec<_>>())
                            key=|id| *id
                            children=move |id| view! { <PackItem handle person id rows /> }
                        />
                        {move || {
                            rows.with(Vec::is_empty)
                                .then(|| {
                                    view! { <p class="help">"目前沒有分配給你的公用裝備。"</p> }
                                })
                        }}
                    </div>
                </section>
            }
        })
        .collect_view();

    let food_done = move || food.with(|rows| rows.iter().filter(|row| row.purchased).count());

    view! {
        <a class="back-link" href=move || planner.get()>
            "← 回到規劃手冊"
        </a>
        <div class="departure-heading">
            <span class="eyebrow">"LESS PLANNING, MORE LIVING"</span>
            <h1>
                {move || {
                    if departed.get() { "準備好了，一起出發！" } else { "出發前，把小幸福帶齊。" }
                }}
            </h1>
            <p>{move || format!("{} · {}的行前清單", title.get(), name.get())}</p>
        </div>
        <div class="departure-banner">
            {art::static_svg(TENT)}
            <div>
                <strong>
                    {move || {
                        let progress = progress.get();
                        format!("{} / {} 項準備完成", progress.done, progress.total)
                    }}
                </strong>
                <progress
                    max=move || progress.get().total.max(1)
                    value=move || progress.get().done
                    aria-label="我的準備進度"
                ></progress>
            </div>
            <span>{move || format!("{}%", percent(progress.get()))}</span>
        </div>
        {move || {
            let names = missing.get();
            (!names.is_empty())
                .then(|| {
                    let resolve_gear = resolve_gear.clone();
                    view! {
                        <div class="notice">
                            {art::static_svg(icons::INFO)}
                            <div>
                                <b>"別落下全隊的裝備"</b>
                                <p>{format!("{names}還沒有人負責。")}</p>
                                <button type="button" class="text-button" on:click=resolve_gear>
                                    "回去分配 "
                                    {art::static_svg(icons::ARROW)}
                                </button>
                            </div>
                        </div>
                    }
                })
        }}
        <div class="packing-columns">{columns}</div>
        <section class="departure-food">
            <h2>
                "我負責的食材 "
                <small>{move || format!("{} / {}", food_done(), food.with(Vec::len))}</small>
            </h2>
            <div class="packing-list">
                <For
                    each=move || food.with(|rows| rows.iter().map(|row| row.id).collect::<Vec<_>>())
                    key=|id| *id
                    children=move |id| view! { <FoodItem handle id rows=food /> }
                />
                {move || {
                    food.with(Vec::is_empty)
                        .then(|| view! { <p class="help">"目前沒有分配給你的食材。"</p> })
                }}
            </div>
        </section>
        <div class="departure-confirm">
            <button
                type="button"
                class="button primary"
                disabled=move || departed.get() || !ready.get()
                on:click=depart
            >
                {move || {
                    if departed.get() {
                        view! {
                            {art::static_svg(icons::CHECK)}
                            "已準備完成"
                        }
                            .into_any()
                    } else {
                        view! {
                            "確認準備完成，出發 "
                            {art::static_svg(icons::ARROW)}
                        }
                            .into_any()
                    }
                }}
            </button>
            <p>
                {move || {
                    let progress = progress.get();
                    if !missing.with(String::is_empty) {
                        "先分配公用裝備，再完成自己的清單。"
                    } else if progress.done < progress.total {
                        "不用急，帶齊了再出發。"
                    } else {
                        "好日子，就從現在開始。"
                    }
                }}
            </p>
        </div>
        <section class="next-stop">
            <span class="eyebrow">
                {move || if departed.get() { "YOUR NEXT LITTLE MOMENT" } else { "FIRST STOP" }}
            </span>
            {move || match next.get() {
                Some(stop) => {
                    let id = stop.id;
                    let advance = move |_| {
                        handle.submit_or_toast(Command::SetActivityDone { id, done: true });
                    };
                    view! {
                        <h2>{stop.title}</h2>
                        <p>
                            {format!("{} {} · ", month_day(stop.day), stop.time)}
                            {map_link(&stop.location)}
                        </p>
                        <p class="help">{stop.participants}</p>
                        <p class="help">{stop.note}</p>
                        {move || {
                            departed
                                .get()
                                .then(|| {
                                    view! {
                                        <button type="button" class="button" on:click=advance>
                                            "完成這一站 "
                                            {art::static_svg(icons::ARROW)}
                                        </button>
                                    }
                                })
                        }}
                    }
                        .into_any()
                }
                None => view! {
                    <h2>"你目前沒有待完成的行程。"</h2>
                    <p>"可回規劃手冊查看全隊行程，或確認自己搭乘的車輛。"</p>
                }
                    .into_any(),
            }}
        </section>
    }
}

/// My_Gear 的一項與這位旅伴的打包勾選（需求 27.6）。
#[component]
fn PackItem(
    handle: TripHandle,
    person: PersonId,
    id: GearId,
    rows: Memo<Vec<PackRow>>,
) -> impl IntoView {
    let row = Memo::new(move |_| rows.with(|rows| rows.iter().find(|row| row.id == id).cloned()));
    let packed = move || row.with(|row| row.as_ref().is_some_and(|row| row.packed));
    let check = NodeRef::<html::Input>::new();
    let toggle = move |_| {
        let current = || {
            handle
                .with_view(|state| {
                    state
                        .gear
                        .get(&id)
                        .map(|gear| gear.packed_by.contains(&person))
                })
                .flatten()
        };
        let Some(now) = current() else {
            return;
        };
        handle.submit_or_toast(Command::SetGearPacked {
            id,
            person,
            packed: !now,
        });
        // 被拒絕時勾選框回到 Optimistic_View 的狀態
        if let (Some(element), Some(now)) = (check.get_untracked(), current()) {
            element.set_checked(now);
        }
    };
    let text =
        move |f: fn(&PackRow) -> String| row.with(|row| row.as_ref().map(f).unwrap_or_default());
    view! {
        <label class=move || if packed() { "packing-item done" } else { "packing-item" }>
            <input
                node_ref=check
                type="checkbox"
                prop:checked=packed
                aria-label=move || format!("{}已裝好", text(|row| row.name.clone()))
                on:change=toggle
            />
            <span>{move || text(|row| row.name.clone())}</span>
            <small>{move || text(|row| row.quantity.clone())}</small>
        </label>
    }
}

/// 我負責的一個採買品項與已買勾選（需求 26.9）。
#[component]
fn FoodItem(handle: TripHandle, id: ShoppingId, rows: Memo<Vec<FoodRow>>) -> impl IntoView {
    let row = Memo::new(move |_| rows.with(|rows| rows.iter().find(|row| row.id == id).cloned()));
    let purchased = move || row.with(|row| row.as_ref().is_some_and(|row| row.purchased));
    let check = NodeRef::<html::Input>::new();
    let toggle = move |_| {
        let current = || {
            handle
                .with_view(|state| state.shopping.get(&id).map(|item| item.purchased))
                .flatten()
        };
        let Some(now) = current() else {
            return;
        };
        handle.submit_or_toast(Command::SetShoppingPurchased {
            id,
            purchased: !now,
        });
        // 被拒絕時勾選框回到 Optimistic_View 的狀態
        if let (Some(element), Some(now)) = (check.get_untracked(), current()) {
            element.set_checked(now);
        }
    };
    let name = move || row.with(|row| row.as_ref().map(|row| row.name.clone()).unwrap_or_default());
    let stop = move || row.with(|row| row.as_ref().and_then(|row| row.stop.clone()));
    let quantity = move || {
        row.with(|row| {
            row.as_ref()
                .map(|row| row.quantity.clone())
                .filter(|quantity| quantity != QUANTITY_TBD)
                .unwrap_or_default()
        })
    };
    view! {
        <label class=move || if purchased() { "packing-item done" } else { "packing-item" }>
            <input
                node_ref=check
                type="checkbox"
                prop:checked=purchased
                aria-label=move || format!("{}已買齊", name())
                on:change=toggle
            />
            <span>
                {name}
                {move || {
                    stop()
                        .map(|(n, place)| {
                            view! { <small class="shopping-where">{format!("第 {n} 天在{place}")}</small> }
                        })
                }}
            </span>
            <small>{quantity}</small>
        </label>
    }
}
