//! Schedule_Tab「行程表」（`?tab=schedule`，需求 22.1）：「規劃行程」與「文字版」兩個區塊。
//!
//! 規劃行程依序是：
//! - 選日與這一天的設定（[`days`]，任務 21.1）：每個 Trip_Day 一個選項，開啟 Trip_Page 時選第 1 天；旅行的起訖日期改變
//!   時繼續選第 N 天，新的天數少於 N 時改選最後一天（需求 22.16、18.11）。選定的第 N 天放在 `UiState::schedule_day`。
//! - 這一天每條路線的路線卡片與「新增路線」（[`routes`]，任務 21.1）。
//! - 活動（含常用活動）與當天的料理（[`events`]，任務 21.2）。
//! - 地點與車（[`places`]，任務 21.3）：地點清單與車輛（`views::vehicle_form`，與 Trip_Menu 共用）。
//! - 未分配採買清單（[`shopping_plan`]，任務 21.3）。
//!
//! 「文字版」區塊與「複製文字」在「規劃行程」之後（[`text`]，任務 21.4）。各區塊以 [`SelectedDay`] 取得選定的日子；切換日子時只重建這一天的區塊。
mod days;
mod events;
mod places;
mod routes;
mod shopping_plan;
mod text;

use leptos::prelude::*;
use lm_core::command::Input;
use lm_core::ids::PlaceId;
use lm_core::model::{Date, PlaceRef, TripState};
use lm_core::text::trim_white;
use lm_core::time::{date_range, Hm};
use uuid::Uuid;

use crate::pages::trip::{use_trip, TripContext};

/// Schedule_Tab 選定的日子。
#[derive(Clone, Copy)]
pub(crate) struct SelectedDay {
    /// 旅行的每一個 Trip_Day，依日期遞增
    pub days: Memo<Vec<Date>>,
    /// 選定的第 N 天（0 為第 1 天），不超過最後一天
    pub index: Memo<usize>,
    /// 選定的日期；旅行沒有任何 Trip_Day 時（只在無效的狀態）是 `None`
    pub date: Memo<Option<Date>>,
}

/// Schedule_Tab「行程表」。以 `pages::trip::use_trip()` 取得這趟旅行的內容。
#[component]
pub fn ScheduleTab() -> impl IntoView {
    let TripContext { stores, ui, .. } = use_trip();
    let days = Memo::new(move |_| stores.card.with(|card| date_range(card.start, card.end)));
    // 需求 22.16：天數少於 N 時改選最後一天；其他時候保持第 N 天
    Effect::new(move |_| {
        let len = days.with(Vec::len);
        let n = ui.schedule_day.get();
        if len > 0 && n >= len {
            ui.schedule_day.set(len - 1);
        }
    });
    let index = Memo::new(move |_| {
        let len = days.with(Vec::len);
        ui.schedule_day.get().min(len.saturating_sub(1))
    });
    let date = Memo::new(move |_| days.with(|days| days.get(index.get()).copied()));
    let selected = SelectedDay { days, index, date };

    view! {
        <section class="schedule-plan" aria-labelledby="schedule-plan-title">
            <div class="section-title">
                <div>
                    <span class="eyebrow">"PLAN THE DAYS, ENJOY THE MOMENTS"</span>
                    <h2 id="schedule-plan-title">"規劃行程"</h2>
                </div>
            </div>
            <days::DayPicker selected />
            {move || {
                date.get()
                    .map(|day| {
                        view! {
                            <days::DaySettings day />
                            <routes::DayRoutes day />
                            <events::DayActivities day days />
                            <events::DayMeals day />
                        }
                    })
            }}
            <places::PlacesAndCars />
            <shopping_plan::UnassignedShopping />
        </section>
        <text::ItineraryText />
    }
}

// ── 地點選單與時刻欄位（路線卡片與每日設定共用）──

/// 地點選單中「未選擇」的值。
const NO_PLACE: &str = "";
/// 地點選單中 Destination_Place 的值。
const DESTINATION: &str = "destination";

/// 地點引用在 `<select>` 中的值：未選擇是空字串，Destination_Place 是 `destination`，地點清單中的地點是它的 id。
fn place_value(place: Option<PlaceRef>) -> String {
    match place {
        None => NO_PLACE.to_owned(),
        Some(PlaceRef::Destination) => DESTINATION.to_owned(),
        Some(PlaceRef::Place(id)) => id.to_string(),
    }
}

/// [`place_value`] 的反向；無法解析的值視為未選擇。
fn parse_place(value: &str) -> Option<PlaceRef> {
    match value {
        DESTINATION => Some(PlaceRef::Destination),
        _ => Uuid::parse_str(value)
            .ok()
            .map(|id| PlaceRef::Place(PlaceId(id))),
    }
}

/// 可以選擇的地點：旅行目的地不是空白時先列 Destination_Place，再依 Ordinal 列出地點清單（需求 22.6）。
fn place_options(state: &TripState) -> Vec<(PlaceRef, String)> {
    let destination = trim_white(&state.card.destination);
    let mut options = Vec::with_capacity(state.places.len() + 1);
    if !destination.is_empty() {
        options.push((
            PlaceRef::Destination,
            format!("{destination}（旅行目的地）"),
        ));
    }
    options.extend(
        state
            .places_by_ordinal()
            .map(|place| (PlaceRef::Place(place.id), place.name.clone())),
    );
    options
}

/// 時刻欄位的文字：留空是 `None`；Time_Value 是 `Ok`；其他文字原樣送出，由 LM_Core 依各需求的訊息拒絕
/// （「０８：３０」視為 08:30，需求 22.5）。
fn time_input(text: &str) -> Option<Input<Hm>> {
    match Hm::parse(text) {
        Ok(None) => None,
        Ok(Some(time)) => Some(Input::Ok(time)),
        Err(_) => Some(Input::Bad(serde_json::Value::String(text.to_owned()))),
    }
}

/// 選填時刻的顯示文字（`HH:MM`，沒有時是空字串），也是表單一開始的內容。
fn time_text(time: Option<Hm>) -> String {
    time.map(|time| time.to_string()).unwrap_or_default()
}
