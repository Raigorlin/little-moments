//! 「行程手帖」預覽（移植自 `src/storybook/journal.js` 的 `renderJournal()`）。
//!
//! 內容由 `lm_core::storybook::studio_plan()` 依 Optimistic_View 產生（`with_view()` 的 `Memo`，包括 Pending_Command 的
//! 效果）；行程改變時整份手帖重新繪製，與 Bun 的 `replaceChildren()` 相同。旅行的文字一律以文字節點輸出；只有
//! [`super::doodles`] 由固定表格產生的 SVG 以 HTML 放進畫面（需求 32.6）。
//!
//! 小圖案的種子是「{旅行名稱}|{第一天}|{換一組小圖案的次數}#{位置}」，與 Bun 相同，所以同一趟旅行畫出相同的圖案；
//! 「換一組小圖案」的次數在這個分頁中保留（Bun 的模組變數）。
//!
//! 「複製文字」把按下當時的 `lm_core::itinerary_text()`（Itinerary_Text，Decision D3）交給
//! `navigator.clipboard.writeText()`；瀏覽器不提供剪貼簿或拒絕寫入時改以隱藏的 `<textarea>` 與 `execCommand('copy')`
//! 複製（Bun `copyItinerary()`）。按鈕文字改為「已複製」或「複製失敗」，1.8 秒後恢復為「複製文字」，再按一次時重新計時。
use std::sync::atomic::{AtomicU32, Ordering};

use gloo_timers::callback::Timeout;
use leptos::html;
use leptos::prelude::*;
use leptos::tachys::html::InertElement;
use leptos::task::spawn_local;
use lm_core::ids::VehicleId;
use lm_core::itinerary_text::itinerary_text;
use lm_core::model::{Date, PlaceRef, StopTask};
use lm_core::storybook::{is_return_day, StudioEvent, StudioPlan, StudioRoute};
use lm_core::time::{month_day, weekday_char, Hm};

use super::doodles::{
    camp_scene, doodle_strip, hash_str, header_scene, icon_body, kind_icon, life_scene, svg, Rng,
    SHUFFLE_ICON, WOBBLE,
};
use super::editor::{use_editor, Editor};

/// 按鈕文字恢復為「複製文字」之前的毫秒數。
const RESTORE_MS: u32 = 1_800;
/// 車輛沒有顏色時車子圖示的顏色。
const DEFAULT_CAR: &str = "#83accc";

/// 「換一組小圖案」按過的次數（Bun `journal.js` 的 `shuffleBump`，在離開頁面之前保留）。
static SHUFFLE_BUMP: AtomicU32 = AtomicU32::new(0);

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

/// 現行 `mdw()`：「{月}/{日}（週{X}）」，`long` 為 `false` 時不寫「週」。
fn mdw(date: Date, long: bool) -> String {
    format!(
        "{}（{}{}）",
        month_day(date),
        if long { "週" } else { "" },
        weekday_char(date)
    )
}

/// 選填時刻的文字，沒有時是 `missing`。
fn time_or(time: Option<Hm>, missing: &str) -> String {
    time.map_or_else(|| missing.to_owned(), |time| time.to_string())
}

/// 現行 `placeName()`：工作室地點的名稱；找不到或名稱是空的時是「（已移除的地點）」，沒有地點時是「未指定」。
pub(super) fn place_name(plan: &StudioPlan, place: Option<PlaceRef>) -> String {
    let Some(place) = place else {
        return "未指定".to_owned();
    };
    plan.places
        .iter()
        .find(|item| item.place == place)
        .map(|item| item.name.as_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("（已移除的地點）")
        .to_owned()
}

/// 現行 `vehicleName()`。
pub(super) fn vehicle_name(plan: &StudioPlan, vehicle: VehicleId) -> String {
    plan.vehicles
        .iter()
        .find(|item| item.id == vehicle)
        .map(|item| item.name.as_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("（已移除的車輛）")
        .to_owned()
}

fn vehicle_color(plan: &StudioPlan, vehicle: VehicleId) -> Option<&str> {
    plan.vehicles
        .iter()
        .find(|item| item.id == vehicle)
        .map(|item| item.color.as_str())
}

/// 現行 `icon()`：`<span class>` 中的線條圖示。
fn icon(name: &str, class: &'static str) -> impl IntoView {
    view! { <span class=class inner_html=svg(icon_body(name))></span> }
}

/// 現行 `carIcon()`：塗上車輛顏色的車子圖示。
fn car_icon(color: Option<&str>) -> impl IntoView {
    let color = color.unwrap_or(DEFAULT_CAR).to_owned();
    view! { <span class="j-car" style:color=color inner_html=svg(icon_body("car"))></span> }
}

/// 小圖案位置 `key` 的亂數（現行 `R(key)`）。
fn rng(seed: &str, key: &str) -> Rng {
    Rng::new(hash_str(&format!("{seed}#{key}")))
}

/// 一條路線（現行 `routeItem()`）。
fn route_item(plan: &StudioPlan, route: &StudioRoute) -> impl IntoView {
    let mut parts = vec![place_name(plan, Some(route.from))];
    parts.extend(route.stops.iter().map(|stop| {
        format!(
            "{}（{}・{}）",
            place_name(plan, Some(stop.place)),
            stop.kind.label(),
            time_or(stop.time, "時間未填")
        )
    }));
    parts.push(place_name(plan, Some(route.to)));
    let notes = route
        .stops
        .iter()
        .filter(|stop| stop.kind == StopTask::Shopping && !stop.items.is_empty())
        .map(|stop| {
            let text = format!("要買：{}", stop.items.join("、"));
            view! { <p class="j-route-note">{text}</p> }
        })
        .collect_view();
    let departure = route
        .departure
        .map_or_else(|| "出發時間未填".to_owned(), |time| format!("{time} 出發"));
    view! {
        <li class="j-route">
            <div class="j-route-top">
                {car_icon(vehicle_color(plan, route.vehicle))}
                <b>{vehicle_name(plan, route.vehicle)}</b>
                <span class="j-route-time">{departure}</span>
            </div>
            <p class="j-route-path">{parts.join(" → ")}</p>
            {notes}
        </li>
    }
}

/// 一個活動或料理（現行 `eventItem()`）。
fn event_item(event: &StudioEvent) -> impl IntoView {
    let title = if event.title.is_empty() {
        "未命名活動".to_owned()
    } else {
        event.title.clone()
    };
    let tag = if event.is_meal() {
        view! { <span class="j-tag">"餐點"</span> }.into_any()
    } else {
        view! { <span class="j-kind">{event.kind.label()}</span> }.into_any()
    };
    let notes = (!event.notes.is_empty()).then(|| {
        let notes = event.notes.clone();
        view! { <span class="j-event-note">{notes}</span> }
    });
    view! {
        <li class="j-event">
            <span class="j-event-time">{event.time.to_string()}</span>
            {icon(kind_icon(event.kind), "j-icon")}
            <span class="j-event-body">
                <span class="j-event-title">{title}</span>
                {tag}
                {notes}
            </span>
        </li>
    }
}

/// 第 `i` 天的日卡（現行 `renderJournal()` 的 `days`）。
fn day_card(plan: &StudioPlan, i: usize, seed: &str, editor: Editor) -> impl IntoView {
    let day = &plan.days[i];
    let after = is_return_day(plan, i);
    let has_routes = !day.routes.is_empty();

    let routes = has_routes.then(|| {
        let arrival = (!day.arrival_label.is_empty()).then(|| {
            let text = format!("抵達：{}", day.arrival_label);
            view! { <p class="j-small">{text}</p> }
        });
        let missing: Vec<&str> = plan
            .vehicles
            .iter()
            .filter(|vehicle| !day.routes.iter().any(|route| route.vehicle == vehicle.id))
            .map(|vehicle| vehicle.name.as_str())
            .collect();
        let missing = (!missing.is_empty()).then(|| {
            let text = format!(
                "{}：還沒有{}路線",
                missing.join("、"),
                if after { "回程" } else { "去程" }
            );
            view! { <p class="j-small">{text}</p> }
        });
        let items = day
            .routes
            .iter()
            .map(|route| route_item(plan, route))
            .collect_view();
        view! {
            <section class="j-col">
                <h3 class="j-col-title">{if after { "回程路線" } else { "去程路線" }}</h3>
                <ul class="j-list">{items}</ul>
                {arrival}
                {missing}
            </section>
        }
        .into_any()
    });
    let events_title = if after {
        "收帳與返程"
    } else if has_routes {
        "營地活動"
    } else {
        "今天的安排"
    };
    let events_list = if day.events.is_empty() {
        view! { <p class="j-small">"這一天留白，慢慢安排。"</p> }.into_any()
    } else {
        let items = day.events.iter().map(event_item).collect_view();
        view! { <ul class="j-list">{items}</ul> }.into_any()
    };
    let events = view! {
        <section class="j-col">
            <h3 class="j-col-title">{events_title}</h3>
            {events_list}
        </section>
    }
    .into_any();
    let art = if after && has_routes {
        let cars = day
            .routes
            .iter()
            .map(|route| car_icon(vehicle_color(plan, route.vehicle)))
            .collect_view();
        view! {
            <div class="j-art cars">
                <div class="j-art-cars">{cars}</div>
            </div>
        }
        .into_any()
    } else {
        let scene = if has_routes {
            camp_scene(&mut rng(seed, &format!("camp{i}")))
        } else {
            life_scene(&mut rng(seed, &format!("life{i}")))
        };
        view! { <div class="j-art" inner_html=scene></div> }.into_any()
    };
    let cols = if after {
        vec![Some(events), routes]
    } else {
        vec![routes, Some(events)]
    };
    let cols: Vec<AnyView> = cols.into_iter().flatten().collect();
    let strip = doodle_strip(
        &mut rng(seed, &format!("strip{i}")),
        if after { 4 } else { 5 },
    );
    let n = i + 1;
    let title = if day.title.is_empty() {
        "未命名的一天".to_owned()
    } else {
        day.title.clone()
    };
    let location = format!(
        "地點：{}",
        day.location.map_or_else(
            || "未指定".to_owned(),
            |place| place_name(plan, Some(place))
        )
    );
    view! {
        <article
            class=format!("j-day tone-{}{}", i % 3, if has_routes { " two" } else { "" })
            aria-labelledby=format!("j-day-{i}")
        >
            <span class="j-tape" aria-hidden="true"></span>
            <header class="j-day-head">
                <span class="j-day-no">{format!("DAY {n}")}</span>
                <span class="j-day-date">{mdw(day.date, true)}</span>
                <button
                    type="button"
                    class="j-edit"
                    title="編輯這一天"
                    aria-label=format!("編輯第 {n} 天")
                    on:click=move |_| editor.edit_day(i)
                    inner_html=svg(icon_body("pencil"))
                ></button>
            </header>
            <h2 class="j-day-title" id=format!("j-day-{i}")>
                {title}
            </h2>
            <p class="j-small">{location}</p>
            <div class="j-cols">{cols} {art}</div>
            <div class="j-strip" inner_html=strip></div>
        </article>
    }
}

/// 整份手帖（現行 `renderJournal()` 的 `replaceChildren()`）。
fn journal_body(
    plan: &StudioPlan,
    bump: u32,
    editor: Editor,
    label: RwSignal<CopyLabel>,
    on_copy: impl Fn() + Copy + 'static,
    on_shuffle: impl Fn() + Copy + 'static,
) -> impl IntoView {
    let first = plan
        .days
        .first()
        .map(|day| day.date.to_string())
        .unwrap_or_default();
    let seed = format!("{}|{first}|{bump}", plan.title);

    let title = [plan.headline.as_str(), plan.title.as_str()]
        .into_iter()
        .find(|text| !text.is_empty())
        .unwrap_or("未命名旅程")
        .to_owned();
    let dates = plan
        .days
        .iter()
        .map(|day| mdw(day.date, false))
        .collect::<Vec<_>>()
        .join("・");
    let dates = if dates.is_empty() {
        "日期未填".to_owned()
    } else {
        dates
    };
    let destination = plan.days.iter().find_map(|day| day.location);
    let sub = format!(
        "露營行程手帖 ／ 地點：{}",
        destination.map_or_else(
            || "未指定".to_owned(),
            |place| place_name(plan, Some(place))
        )
    );
    let cars = (!plan.vehicles.is_empty()).then(|| {
        let items = plan
            .vehicles
            .iter()
            .map(|vehicle| {
                let name = vehicle.name.clone();
                view! {
                    <li>
                        {car_icon(Some(&vehicle.color))}
                        <span>{name}</span>
                    </li>
                }
            })
            .collect_view();
        view! {
            <ul class="j-cars" aria-label="車輛">
                {items}
            </ul>
        }
    });
    let note = if plan.caption.is_empty() {
        "一起慢慢度日".to_owned()
    } else {
        plan.caption.clone()
    };
    let head_art = InertElement::new(header_scene(&mut rng(&seed, "head")));

    let days = (0..plan.days.len())
        .map(|i| day_card(plan, i, &seed, editor))
        .collect_view();

    let shop = (!plan.shopping.is_empty()).then(|| {
        let items = plan
            .shopping
            .iter()
            .map(|item| {
                let item = item.clone();
                view! {
                    <li>
                        <span class="j-box" aria-hidden="true"></span>
                        <span>{item}</span>
                    </li>
                }
            })
            .collect_view();
        view! {
            <section class="j-shop" aria-labelledby="j-shop-title">
                <span class="j-tape right" aria-hidden="true"></span>
                <div class="j-shop-head">
                    {icon("basket", "j-shop-icon")}
                    <div>
                        <h2 id="j-shop-title">"未分配採買清單"</h2>
                        <p class="j-small">"還沒有人負責，記得到採買清單分工。"</p>
                    </div>
                </div>
                <ul class="j-shop-list">{items}</ul>
            </section>
        }
    });

    view! {
        <span inner_html=WOBBLE></span>
        <div class="j-tools">
            <button
                type="button"
                class="j-copy j-shuffle"
                title="換一組小圖案"
                aria-label="換一組小圖案"
                on:click=move |_| on_shuffle()
                inner_html=svg(SHUFFLE_ICON)
            ></button>
            <button
                type="button"
                id="copyItinerary"
                class="j-copy"
                title="複製文字版行程"
                aria-label="複製文字版行程"
                on:click=move |_| on_copy()
            >
                {InertElement::new(svg(icon_body("copy")))}
                <span class="copy-label">{move || label.get().text()}</span>
            </button>
        </div>
        <header class="j-head">
            <div class="j-head-copy">
                <span class="j-eyebrow">
                    <span class="j-eye-light">"CAMPING JOURNAL"</span>
                    <span class="j-eye-dark">"UNDER THE STARS"</span>
                </span>
                <div class="j-title">{title}</div>
                <p class="j-dates">{dates}</p>
                <p class="j-sub">{sub}</p>
                {cars}
            </div>
            <div class="j-head-art">
                {head_art}
                <span class="j-head-note">{note}</span>
            </div>
        </header>
        <div class="j-days">{days}</div>
        {shop}
        <div class="j-foot">
            <span>"時間未填的項目，之後再補上就好。"</span>
            <span>"HAVE A LITTLE GOOD DAY"</span>
        </div>
    }
}

/// `section#journal`（template.js）與其中的手帖。
#[component]
pub(super) fn Journal() -> impl IntoView {
    let editor = use_editor();
    let handle = editor.handle;
    let plan = editor.plan;
    let bump = RwSignal::new(SHUFFLE_BUMP.load(Ordering::Relaxed));
    let label = RwSignal::new(CopyLabel::Idle);
    let journal = NodeRef::<html::Section>::new();
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
    let on_copy = move || {
        // 按下當時的文字版行程
        let text = untrack(|| handle.with_view(itinerary_text)).unwrap_or_default();
        spawn_local(async move {
            let copied = write_clipboard(&text).await
                || journal
                    .get_untracked()
                    .is_some_and(|journal| copy_with_textarea(&journal, &text));
            show(if copied {
                CopyLabel::Copied
            } else {
                CopyLabel::Failed
            });
        });
    };
    let on_shuffle = move || {
        let next = SHUFFLE_BUMP.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
        bump.set(next);
    };

    view! {
        <section class="journal" id="journal" aria-label="行程手帖" node_ref=journal>
            {move || {
                plan.with(|plan| {
                    plan.as_ref()
                        .map(|plan| journal_body(plan, bump.get(), editor, label, on_copy, on_shuffle))
                })
            }}
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

/// Bun `copyItinerary()` 的備用方式：在 `parent` 中放一個隱藏的 `<textarea>`，選取後以 `document.execCommand('copy')`
/// 複製，再移除它。呼叫沒有拋出錯誤時視為成功（與 Bun 相同）。
fn copy_with_textarea(parent: &web_sys::Element, text: &str) -> bool {
    use wasm_bindgen::JsCast;

    let document = document();
    let Some(area) = document
        .create_element("textarea")
        .ok()
        .and_then(|area| area.dyn_into::<web_sys::HtmlTextAreaElement>().ok())
    else {
        return false;
    };
    area.set_class_name("sr");
    area.set_value(text);
    if parent.append_child(&area).is_err() {
        return false;
    }
    area.select();
    let copied = js_sys::Reflect::get(&document, &"execCommand".into())
        .ok()
        .and_then(|exec| exec.dyn_into::<js_sys::Function>().ok())
        .is_some_and(|exec| exec.call1(&document, &"copy".into()).is_ok());
    area.remove();
    copied
}
