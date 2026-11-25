//! 行程繪本專用欄位的範例測試：繪本的大標題與底部短語（`TripCard.headline`、`caption`）、每日設定的抵達說明
//! （`DaySetting.arrival_label`）、停靠點的待辦清單（`Stop.items`）與地點的繪本插圖（`Place.template`）。
//!
//! 以範例旅行（`support::example_trip`）送出 `UpdateTrip`、`SaveDaySetting`、`SaveRoute` 與 `AddPlace`，檢查
//! Trim_White、上限與 400 訊息，以及這些欄位不改變 Itinerary_Text；另外檢查沒有這些欄位的舊 JSON（變更紀錄與快照）
//! 仍可解析，欄位取預設值。

mod support;

use lm_core::apply::{apply, Ctx, Mode};
use lm_core::command::{
    Command, DaySettingPatch, Input, Rejection, RouteDraft, StopDraft, TripPatch,
};
use lm_core::ids::{PlaceId, RouteId, StopId};
use lm_core::itinerary_text::itinerary_text;
use lm_core::model::{
    Date, DaySetting, Place, PlaceRef, PlaceTemplate, Route, Row, Stop, StopKind, StopTask,
    TripCard, TripState,
};
use lm_core::rules::capabilities;
use lm_core::validate;
use serde_json::{json, Value};
use support::commands::{owner, CommitIds};
use support::example_trip::example_trip;
use support::ids::{id, Tag};

/// Trip_Owner（範例旅行的旅伴都沒有綁定帳號）。
fn manager() -> Ctx {
    Ctx {
        actor: owner(),
        caps: capabilities(owner(), owner(), lm_core::model::Role::Member, None),
    }
}

/// 以 Trip_Owner 提交 `cmd`，成功時回傳套用效果之後的狀態（並檢查它仍滿足不變式）。
fn commit(state: &TripState, cmd: Command) -> Result<TripState, Rejection> {
    let outcome = apply(
        state,
        &manager(),
        Mode::Commit,
        &mut CommitIds::default(),
        &cmd,
    )?;
    let mut next = state.clone();
    next.apply_effects(&outcome.effects());
    assert_eq!(validate::state(&next, Mode::Commit), Ok(()));
    Ok(next)
}

/// 拒絕的欄位與訊息。
fn rejected(result: Result<TripState, Rejection>) -> (Option<String>, String) {
    let rejection = result.expect_err("應該被拒絕");
    (
        rejection.field().map(str::to_owned),
        rejection.message().to_owned(),
    )
}

/// 範例旅行的第 n 天（從 1 起）。
fn day(state: &TripState, n: u64) -> Date {
    state.card.start + time::Duration::days(n as i64 - 1)
}

fn update_trip(patch: TripPatch) -> Command {
    Command::UpdateTrip { patch }
}

fn save_day(day: Date, patch: DaySettingPatch) -> Command {
    Command::SaveDaySetting { day, patch }
}

// ── 大標題與底部短語 ──

#[test]
fn headline_and_caption_are_trimmed_and_stored() {
    let state = example_trip();
    let next = commit(
        &state,
        update_trip(TripPatch {
            headline: Some("  露營小日記\u{3000}".to_owned()),
            caption: Some(" 一起去山裡過週末。 ".to_owned()),
            ..TripPatch::default()
        }),
    )
    .expect("可以儲存");
    assert_eq!(next.card.headline, "露營小日記");
    assert_eq!(next.card.caption, "一起去山裡過週末。");
    // 其他欄位不變
    assert_eq!(next.card.title, state.card.title);
    // 繪本的文字不輸出到 Itinerary_Text
    assert_eq!(itinerary_text(&next), itinerary_text(&state));

    // 只有空白是清空；沒有帶的欄位保留
    let cleared = commit(
        &next,
        update_trip(TripPatch {
            headline: Some(" \u{3000} ".to_owned()),
            ..TripPatch::default()
        }),
    )
    .expect("可以清空");
    assert_eq!(cleared.card.headline, "");
    assert_eq!(cleared.card.caption, "一起去山裡過週末。");
}

#[test]
fn headline_and_caption_reject_text_over_the_limit() {
    let state = example_trip();
    assert!(commit(
        &state,
        update_trip(TripPatch {
            headline: Some("字".repeat(80)),
            caption: Some("字".repeat(150)),
            ..TripPatch::default()
        }),
    )
    .is_ok());
    assert_eq!(
        rejected(commit(
            &state,
            update_trip(TripPatch {
                headline: Some("字".repeat(81)),
                ..TripPatch::default()
            }),
        )),
        (
            Some("headline".to_owned()),
            "大標題最多 80 個字。".to_owned()
        )
    );
    assert_eq!(
        rejected(commit(
            &state,
            update_trip(TripPatch {
                caption: Some("字".repeat(151)),
                ..TripPatch::default()
            }),
        )),
        (
            Some("caption".to_owned()),
            "底部短語最多 150 個字。".to_owned()
        )
    );
    assert_eq!(
        rejected(commit(
            &state,
            update_trip(TripPatch {
                caption: Some("短語\u{0}".to_owned()),
                ..TripPatch::default()
            }),
        )),
        (
            Some("caption".to_owned()),
            "文字含有無法儲存的字元。".to_owned()
        )
    );
}

// ── 抵達說明 ──

#[test]
fn arrival_label_is_trimmed_set_and_cleared() {
    let state = example_trip();
    let second = day(&state, 2);
    let next = commit(
        &state,
        save_day(
            second,
            DaySettingPatch {
                arrival_label: Some(Some("  營地 14:00 可進場 ".to_owned())),
                ..DaySettingPatch::default()
            },
        ),
    )
    .expect("可以儲存");
    let setting = &next.day_settings[&second];
    assert_eq!(setting.arrival_label.as_deref(), Some("營地 14:00 可進場"));
    assert_eq!(setting.title, state.day_settings[&second].title);
    // 抵達說明不輸出到 Itinerary_Text（抵達行仍由預計抵達時間產生）
    assert_eq!(itinerary_text(&next), itinerary_text(&state));

    // null 與只有空白都是清空
    for label in [None, Some(" \u{3000} ".to_owned())] {
        let cleared = commit(
            &next,
            save_day(
                second,
                DaySettingPatch {
                    arrival_label: Some(label),
                    ..DaySettingPatch::default()
                },
            ),
        )
        .expect("可以清空");
        assert_eq!(cleared.day_settings[&second].arrival_label, None);
    }
}

#[test]
fn a_setting_with_only_an_arrival_label_is_kept() {
    let state = example_trip();
    let second = day(&state, 2);
    // 清空標題、同時設定抵達說明：這一天的設定只剩抵達說明，仍然保留
    let next = commit(
        &state,
        save_day(
            second,
            DaySettingPatch {
                title: Some(None),
                arrival_label: Some(Some("晚餐前抵達".to_owned())),
                ..DaySettingPatch::default()
            },
        ),
    )
    .expect("可以儲存");
    assert_eq!(
        next.day_settings.get(&second),
        Some(&DaySetting {
            day: second,
            title: None,
            place: None,
            arrival: None,
            arrival_label: Some("晚餐前抵達".to_owned()),
            route_position: state.day_settings[&second].route_position,
            version: state.day_settings[&second].version,
        })
    );
    // 再清空抵達說明：每一項都未設定，這一天的設定被刪除
    let removed = commit(
        &next,
        save_day(
            second,
            DaySettingPatch {
                arrival_label: Some(None),
                ..DaySettingPatch::default()
            },
        ),
    )
    .expect("可以清空");
    assert!(!removed.day_settings.contains_key(&second));
}

#[test]
fn arrival_label_rejects_text_over_the_limit() {
    let state = example_trip();
    let second = day(&state, 2);
    let patch = |text: String| DaySettingPatch {
        arrival_label: Some(Some(text)),
        ..DaySettingPatch::default()
    };
    assert!(commit(&state, save_day(second, patch("字".repeat(120)))).is_ok());
    assert_eq!(
        rejected(commit(&state, save_day(second, patch("字".repeat(121))))),
        (
            Some("arrival_label".to_owned()),
            "抵達說明最多 120 個字。".to_owned()
        )
    );
}

// ── 停靠點的待辦清單 ──

/// 範例旅行中唯一有停靠點的路線：第 1 天第三車・採買組，途中在超市／賣場採買（st-1）。
fn shopping_route(state: &TripState) -> &Route {
    &state.routes[&id::<RouteId>(Tag::Route, 3)]
}

/// 路線卡片的整份內容（不改任何值）。
fn draft_of(route: &Route) -> RouteDraft {
    RouteDraft {
        id: route.id,
        day: route.day,
        vehicle: Some(route.vehicle),
        from: Some(route.from),
        to: Some(route.to),
        depart: route.depart.map(Input::Ok),
        stops: route.stops.iter().map(stop_draft).collect(),
    }
}

fn stop_draft(stop: &Stop) -> StopDraft {
    StopDraft {
        id: stop.id,
        place: Some(stop.place),
        kind: Input::Ok(stop.kind),
        task: stop.task.map(Input::Ok),
        note: stop.note.clone(),
        time: stop.time.map(Input::Ok),
        items: stop.items.clone(),
    }
}

/// 在路線最後加上一個一般停靠點（停在出發地點 A），清單是 `items`；採買的停靠點也帶上一項。
fn route_with_items(state: &TripState, items: Vec<String>) -> Command {
    let mut draft = draft_of(shopping_route(state));
    draft.stops[0].items = vec!["不該儲存".to_owned()];
    draft.stops.push(StopDraft {
        id: id::<StopId>(Tag::Stop, 1000),
        place: Some(PlaceRef::Place(id(Tag::Place, 1))),
        kind: Input::Ok(StopKind::Other),
        task: Some(Input::Ok(StopTask::Waypoint)),
        note: String::new(),
        time: None,
        items,
    });
    Command::SaveRoute { route: draft }
}

#[test]
fn stop_items_are_normalized_and_shopping_stops_keep_none() {
    let state = example_trip();
    let items = ["  冰塊 ", "", "\u{3000}", "小安"]
        .map(str::to_owned)
        .to_vec();
    let next = commit(&state, route_with_items(&state, items)).expect("可以儲存");
    let stops = &shopping_route(&next).stops;
    assert_eq!(stops.len(), 2);
    // 採買的停靠點不儲存清單（品項由採買清單推得）
    assert_eq!(stops[0].kind, StopKind::Shop);
    assert!(stops[0].items.is_empty());
    // 每項經 Trim_White，空白的項目略過
    assert_eq!(stops[1].items, ["冰塊", "小安"]);
}

#[test]
fn stop_items_reject_more_than_eight_and_long_items() {
    let state = example_trip();
    assert!(commit(&state, route_with_items(&state, vec!["冰塊".to_owned(); 8])).is_ok());
    // 空白的項目不算在 8 項之內
    let mut padded = vec!["冰塊".to_owned(); 8];
    padded.push("  ".to_owned());
    assert!(commit(&state, route_with_items(&state, padded)).is_ok());
    assert_eq!(
        rejected(commit(
            &state,
            route_with_items(&state, vec!["冰塊".to_owned(); 9])
        )),
        (Some("stops".to_owned()), "每個停靠點最多 8 項。".to_owned())
    );
    assert!(commit(&state, route_with_items(&state, vec!["字".repeat(100)])).is_ok());
    assert_eq!(
        rejected(commit(
            &state,
            route_with_items(&state, vec!["字".repeat(101)])
        )),
        (Some("stops".to_owned()), "每一項最多 100 個字。".to_owned())
    );
}

#[test]
fn stop_items_do_not_change_the_itinerary_text() {
    let state = example_trip();
    let mut draft = draft_of(shopping_route(&state));
    draft.stops[0].items = vec!["冰塊".to_owned()];
    let next = commit(&state, Command::SaveRoute { route: draft }).expect("可以儲存");
    // 採買的停靠點略過清單，所以路線不變
    assert_eq!(shopping_route(&next).stops, shopping_route(&state).stops);
    // 一般停靠點的清單也不輸出
    let with_stop = commit(&state, route_with_items(&state, Vec::new())).expect("可以儲存");
    let with_items = commit(
        &state,
        route_with_items(&state, vec!["冰塊".to_owned(), "小安".to_owned()]),
    )
    .expect("可以儲存");
    assert_eq!(itinerary_text(&with_items), itinerary_text(&with_stop));
}

// ── 地點的繪本插圖 ──

fn add_place(template: Option<Input<PlaceTemplate>>) -> Command {
    Command::AddPlace {
        id: id::<PlaceId>(Tag::Place, 1000),
        name: "湖畔營地".to_owned(),
        template,
    }
}

#[test]
fn add_place_stores_the_template() {
    let state = example_trip();
    let new_place = id::<PlaceId>(Tag::Place, 1000);
    let next = commit(&state, add_place(Some(Input::Ok(PlaceTemplate::Tent)))).expect("可以新增");
    assert_eq!(next.places[&new_place].template, Some(PlaceTemplate::Tent));
    let plain = commit(&state, add_place(None)).expect("可以新增");
    assert_eq!(plain.places[&new_place].template, None);
    // 改名不改變插圖
    let renamed = commit(
        &next,
        Command::RenamePlace {
            id: new_place,
            name: "湖邊營地".to_owned(),
        },
    )
    .expect("可以改名");
    assert_eq!(
        renamed.places[&new_place].template,
        Some(PlaceTemplate::Tent)
    );
    assert_eq!(
        rejected(commit(
            &state,
            add_place(Some(Input::Bad(json!("volcano"))))
        )),
        (Some("template".to_owned()), "請選擇插圖。".to_owned())
    );
}

#[test]
fn place_templates_follow_the_studio_list() {
    let ids: Vec<&str> = PlaceTemplate::ALL
        .iter()
        .map(PlaceTemplate::as_str)
        .collect();
    assert_eq!(
        ids,
        [
            "home",
            "market",
            "seven-eleven",
            "familymart",
            "okmart",
            "pxmart-mega",
            "costco",
            "ikea",
            "carrefour",
            "tent",
            "bell",
            "dome",
            "tarp",
            "camper",
            "cabin",
        ]
    );
    assert_eq!(PlaceTemplate::SevenEleven.label(), "7-ELEVEN");
    assert_eq!(PlaceTemplate::Cabin.label(), "小木屋");
    for template in PlaceTemplate::ALL {
        assert_eq!(PlaceTemplate::parse(template.as_str()), Some(*template));
        assert_eq!(
            serde_json::to_value(template).expect("可以序列化"),
            json!(template.as_str())
        );
    }
    let command: Command = serde_json::from_value(json!({
        "type": "add_place",
        "id": id::<PlaceId>(Tag::Place, 1000),
        "name": "湖畔營地",
        "template": "pxmart-mega",
    }))
    .expect("可以解析");
    assert_eq!(
        command,
        add_place(Some(Input::Ok(PlaceTemplate::PxmartMega)))
    );
}

// ── 舊 JSON ──

/// `row` 的線上格式去掉 `fields` 之後，再解析回同一種列。
fn without<T: serde::Serialize + serde::de::DeserializeOwned>(row: &T, fields: &[&str]) -> T {
    let mut value = serde_json::to_value(row).expect("可以序列化");
    let object = value.as_object_mut().expect("列是 JSON 物件");
    for field in fields {
        assert!(object.remove(*field).is_some(), "線上格式有 {field}");
    }
    serde_json::from_value(value).expect("沒有新欄位的舊 JSON 可以解析")
}

#[test]
fn old_rows_without_the_storybook_fields_still_parse() {
    let state = example_trip();
    let first = day(&state, 1);

    let card = TripCard {
        headline: "露營小日記".to_owned(),
        caption: "一起去山裡過週末。".to_owned(),
        ..state.card.clone()
    };
    assert_eq!(without(&card, &["headline", "caption"]), state.card);

    let place = state.places[&id::<PlaceId>(Tag::Place, 1)].clone();
    let templated = Place {
        template: Some(PlaceTemplate::Home),
        ..place.clone()
    };
    assert_eq!(without(&templated, &["template"]), place);

    let stop = Stop {
        id: id(Tag::Stop, 2),
        place: PlaceRef::Destination,
        kind: StopKind::Other,
        task: None,
        note: String::new(),
        time: None,
        items: vec!["冰塊".to_owned()],
    };
    assert!(without(&stop, &["items"]).items.is_empty());

    let setting = state.day_settings[&first].clone();
    let labelled = DaySetting {
        arrival_label: Some("晚餐前抵達".to_owned()),
        ..setting.clone()
    };
    assert_eq!(without(&labelled, &["arrival_label"]), setting);

    // 變更紀錄與快照中的 Row 也一樣
    let row: Row = serde_json::from_value(json!({
        "entity": "place",
        "row": {"id": place.id, "name": place.name, "ordinal": place.ordinal, "version": place.version},
    }))
    .expect("可以解析");
    assert_eq!(row, Row::Place(place));

    // 路線中沒有 items 的停靠點
    let route = shopping_route(&state).clone();
    let mut value = serde_json::to_value(&route).expect("可以序列化");
    for stop in value["stops"].as_array_mut().expect("停靠點是陣列") {
        stop.as_object_mut().expect("停靠點是物件").remove("items");
    }
    assert_eq!(
        serde_json::from_value::<Route>(value).expect("可以解析"),
        route
    );
}

#[test]
fn old_commands_without_the_storybook_fields_still_parse() {
    let place = id::<PlaceId>(Tag::Place, 1000);
    let command: Command =
        serde_json::from_value(json!({"type": "add_place", "id": place, "name": "湖畔營地"}))
            .expect("可以解析");
    assert_eq!(command, add_place(None));
    // 沒有選擇插圖時不寫出 template
    assert_eq!(
        serde_json::to_value(add_place(None)).expect("可以序列化"),
        json!({"type": "add_place", "id": place, "name": "湖畔營地"})
    );

    let patch: TripPatch =
        serde_json::from_value(json!({"title": "森林小旅行"})).expect("可以解析");
    assert_eq!((patch.headline, patch.caption), (None, None));

    let patch: DaySettingPatch =
        serde_json::from_value(json!({"title": "森林小徑"})).expect("可以解析");
    assert_eq!(patch.arrival_label, None);
    let cleared: DaySettingPatch =
        serde_json::from_value(json!({"arrival_label": null})).expect("可以解析");
    assert_eq!(cleared.arrival_label, Some(None));

    let stop: StopDraft = serde_json::from_value(json!({
        "id": id::<StopId>(Tag::Stop, 1000),
        "kind": "other",
    }))
    .expect("可以解析");
    assert!(stop.items.is_empty());
    let value: Value = serde_json::to_value(&stop).expect("可以序列化");
    assert_eq!(value["items"], json!([]));
}
