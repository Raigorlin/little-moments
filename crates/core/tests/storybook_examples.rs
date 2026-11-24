//! 旅行繪本工作室顯示的行程（`storybook::studio_plan`）的範例測試，以範例旅行（`support::example_trip`）為準：
//! 活動與料理的順序、料理的標題與種類、活動類別與工作室種類的對應、採買停靠點的品項、每一天的地點、返程日與車輛的
//! 預設顏色。
mod support;

use lm_core::model::{
    ActivityKind, DishKind, MealSlot, PlaceRef, PlaceTemplate, RoutePosition, Row, ShoppingItem,
    StopTask, TripState,
};
use lm_core::storybook::{
    guess_template, is_return_day, stop_task_parts, studio_plan, EventSource, StudioKind,
    STUDIO_STOP_KINDS,
};
use lm_core::time::Hm;
use support::example_trip::example_trip;
use support::ids::{id, Tag};

fn at(hour: u8, minute: u8) -> Hm {
    Hm::new(hour, minute).expect("有效的時刻")
}

/// 第 n 天（從 1 起）的活動與料理：(時間, 標題, 種類, 是否料理)。
fn events(state: &TripState, n: usize) -> Vec<(String, String, StudioKind, bool)> {
    studio_plan(state).days[n - 1]
        .events
        .iter()
        .map(|event| {
            (
                event.time.to_string(),
                event.title.clone(),
                event.kind,
                event.is_meal(),
            )
        })
        .collect()
}

#[test]
fn events_are_sorted_by_time_with_meals_shown_as_events() {
    let state = example_trip();
    assert_eq!(
        events(&state, 2),
        vec![
            ("08:00".into(), "起床".into(), StudioKind::Sunrise, false),
            ("08:30".into(), "早餐".into(), StudioKind::Breakfast, true),
            (
                "10:00".into(),
                "自由活動、拍照".into(),
                StudioKind::Explore,
                false
            ),
            ("12:00".into(), "午餐".into(), StudioKind::Noodles, true),
            (
                "14:00".into(),
                "下午茶、聊天、玩遊戲".into(),
                StudioKind::Games,
                false
            ),
            (
                "18:00".into(),
                "晚餐：豪華火鍋".into(),
                StudioKind::Hotpot,
                true
            ),
            ("20:00".into(), "自由活動".into(), StudioKind::Night, false),
        ]
    );
    assert_eq!(
        events(&state, 1),
        vec![
            (
                "13:00".into(),
                "搭帳・營地佈置".into(),
                StudioKind::Setup,
                false
            ),
            (
                "18:00".into(),
                "晚餐：烤肉派對".into(),
                StudioKind::Bbq,
                true
            ),
            (
                "20:00".into(),
                "星空夜聊・自由活動".into(),
                StudioKind::Night,
                false
            ),
        ]
    );
}

#[test]
fn activities_come_before_meals_at_the_same_time() {
    let mut state = example_trip();
    // 第 1 天的晚餐改在 13:00，與「搭帳・營地佈置」同時
    state.meals.get_mut(&id(Tag::Meal, 1)).expect("m1").time = Some(at(13, 0));
    let day1 = events(&state, 1);
    assert_eq!(day1[0].1, "搭帳・營地佈置");
    assert_eq!(day1[1].1, "晚餐：烤肉派對");
    let plan = studio_plan(&state);
    assert_eq!(
        plan.days[0].events[1].source,
        EventSource::Meal(id(Tag::Meal, 1))
    );
}

#[test]
fn meal_titles_and_kinds() {
    let mut state = example_trip();
    let meal = state.meals.get_mut(&id(Tag::Meal, 2)).expect("m2");
    meal.title = "貝果".to_owned();
    meal.ingredients = String::new();
    meal.notes = "記得帶奶油".to_owned();
    let plan = studio_plan(&state);
    let breakfast = &plan.days[1].events[1];
    assert_eq!(breakfast.title, "早餐：貝果");
    assert_eq!(breakfast.notes, "記得帶奶油");
    assert_eq!(breakfast.kind, StudioKind::Breakfast);

    // 插圖種類優先於餐次；toast 顯示為早餐
    let m3 = |state: &TripState| {
        studio_plan(state).days[1]
            .events
            .iter()
            .find(|event| event.source == EventSource::Meal(id(Tag::Meal, 3)))
            .map(|event| (event.kind, event.title.clone()))
            .expect("m3")
    };
    let mut state = example_trip();
    let meal = state.meals.get_mut(&id(Tag::Meal, 3)).expect("m3");
    meal.dish = Some(DishKind::Toast);
    assert_eq!(m3(&state).0, StudioKind::Breakfast);
    let meal = state.meals.get_mut(&id(Tag::Meal, 3)).expect("m3");
    meal.dish = Some(DishKind::Curry);
    assert_eq!(m3(&state).0, StudioKind::Noodles);
    let meal = state.meals.get_mut(&id(Tag::Meal, 3)).expect("m3");
    meal.slot = MealSlot::AfternoonTea;
    assert_eq!(m3(&state), (StudioKind::Meal, "下午茶：午餐".to_owned()));
    let meal = state.meals.get_mut(&id(Tag::Meal, 3)).expect("m3");
    meal.dish = Some(DishKind::Hotpot);
    assert_eq!(m3(&state).0, StudioKind::Hotpot);
}

#[test]
fn activity_kinds_round_trip() {
    for &kind in ActivityKind::ALL {
        let studio = StudioKind::from_activity(kind);
        assert_eq!(studio.to_activity(), kind);
        assert!(StudioKind::ACTIVITY_KINDS.contains(&studio));
    }
    assert_eq!(
        StudioKind::from_activity(ActivityKind::Wake),
        StudioKind::Sunrise
    );
    assert_eq!(
        StudioKind::from_activity(ActivityKind::Return).label(),
        "返程"
    );
    for kind in [
        StudioKind::Bbq,
        StudioKind::Breakfast,
        StudioKind::Noodles,
        StudioKind::Hotpot,
    ] {
        assert_eq!(kind.to_activity(), ActivityKind::Meal);
    }
    assert_eq!(StudioKind::Activity.to_activity(), ActivityKind::Camp);
    assert_eq!(StudioKind::Activity.label(), "其他活動");
    for kind in StudioKind::ALL {
        assert_eq!(StudioKind::parse(kind.as_str()), Some(kind));
    }
}

#[test]
fn shopping_stop_lists_its_items_and_truncates_long_lists() {
    let mut state = example_trip();
    let plan = studio_plan(&state);
    let stop = &plan.days[0].routes[2].stops[0];
    assert_eq!(stop.kind, StopTask::Shopping);
    assert_eq!(
        stop.items,
        vec![
            "五花肉片",
            "鮮蝦",
            "高麗菜",
            "運動飲料",
            "洋芋片",
            "瓦斯",
            "衛生紙",
            "免洗餐具"
        ]
    );
    // 未分配採買清單是待分配的 Meal_Item
    assert_eq!(plan.shopping.len(), 10);
    assert_eq!(plan.shopping[0], "培根");

    // 第 9 項由小雨負責：列出前 7 項與「等另外 2 項」
    state.put(Row::Shopping(ShoppingItem {
        id: id(Tag::Shopping, 19),
        ordinal: 19,
        name: "  冰塊  ".to_owned(),
        assignee: Some(id(Tag::Person, 3)),
        ..state.shopping[&id(Tag::Shopping, 1)].clone()
    }));
    let plan = studio_plan(&state);
    let items = &plan.days[0].routes[2].stops[0].items;
    assert_eq!(items.len(), 8);
    assert_eq!(items[6], "衛生紙");
    assert_eq!(items[7], "等另外 2 項");
}

#[test]
fn day_location_falls_back_to_the_destination() {
    let mut state = example_trip();
    let plan = studio_plan(&state);
    assert!(plan
        .days
        .iter()
        .all(|day| day.location == Some(PlaceRef::Destination)));
    assert_eq!(plan.places[0].place, PlaceRef::Destination);
    assert_eq!(plan.places[0].template, PlaceTemplate::Tent);
    assert_eq!(plan.places[0].name, "夕淞度日營區");
    assert_eq!(plan.places.len(), 7);
    // 「超市／賣場」推測為超市／賣場的插圖，「台北」為家
    assert_eq!(plan.places[5].template, PlaceTemplate::Market);
    assert_eq!(plan.places[6].template, PlaceTemplate::Home);

    // 每日設定的地點優先
    state
        .day_settings
        .get_mut(&state.card.start)
        .expect("第 1 天")
        .place = Some(id(Tag::Place, 6));
    let plan = studio_plan(&state);
    assert_eq!(
        plan.days[0].location,
        Some(PlaceRef::Place(id(Tag::Place, 6)))
    );

    // 旅行目的地是空白時沒有 Destination_Place
    state.card.destination = "  ".to_owned();
    let plan = studio_plan(&state);
    assert_eq!(plan.days[1].location, None);
    assert_eq!(plan.places.len(), 6);
}

#[test]
fn return_day_rule() {
    let mut state = example_trip();
    let plan = studio_plan(&state);
    // 第 3 天是最後一天，四條路線都從營區出發
    assert!(!is_return_day(&plan, 0));
    assert!(!is_return_day(&plan, 1));
    assert!(is_return_day(&plan, 2));

    // 第 1 天的路線設在活動之後
    state
        .day_settings
        .get_mut(&state.card.start)
        .expect("第 1 天")
        .route_position = RoutePosition::After;
    assert!(is_return_day(&studio_plan(&state), 0));

    // 最後一天有一條路線不是從這一天的地點出發
    let route = state.routes.get_mut(&id(Tag::Route, 8)).expect("rt-3-v4");
    route.from = PlaceRef::Place(id(Tag::Place, 4));
    assert!(!is_return_day(&studio_plan(&state), 2));

    // 一日遊的那一天不是返程日
    let mut single = example_trip();
    single.card.end = single.card.start;
    assert!(!is_return_day(&studio_plan(&single), 0));
}

#[test]
fn vehicle_colour_falls_back_to_the_car_palette() {
    let mut state = example_trip();
    state
        .vehicles
        .get_mut(&id(Tag::Vehicle, 2))
        .expect("第二車")
        .color = Some("#123456".to_owned());
    let plan = studio_plan(&state);
    let colours: Vec<&str> = plan.vehicles.iter().map(|v| v.color.as_str()).collect();
    assert_eq!(colours, vec!["#efa28f", "#123456", "#b9cda5", "#f6d27a"]);
    assert_eq!(plan.vehicles[2].name, "第三車・採買組");
}

#[test]
fn day_fields_come_from_the_day_settings() {
    let mut state = example_trip();
    state
        .day_settings
        .get_mut(&state.card.start)
        .expect("第 1 天")
        .arrival_label = Some("營地 14:00 可進場".to_owned());
    state.card.headline = "露營小日記".to_owned();
    let plan = studio_plan(&state);
    assert_eq!(plan.headline, "露營小日記");
    assert_eq!(plan.title, "夕淞度日");
    assert_eq!(plan.days[0].title, "向山裡出發");
    assert_eq!(plan.days[0].arrival_label, "營地 14:00 可進場");
    assert_eq!(plan.days[1].arrival_label, "");
    assert_eq!(plan.days[0].routes.len(), 4);
    assert_eq!(plan.days[1].routes.len(), 0);
    assert_eq!(plan.days[0].routes[0].departure, Some(at(8, 0)));
}

#[test]
fn templates_and_stop_kinds() {
    assert_eq!(
        guess_template("7-ELEVEN 台北站"),
        PlaceTemplate::SevenEleven
    );
    assert_eq!(guess_template("全家 FamilyMart"), PlaceTemplate::FamilyMart);
    assert_eq!(guess_template("OK Mart 中山店"), PlaceTemplate::OkMart);
    assert_eq!(guess_template("全聯"), PlaceTemplate::PxmartMega);
    assert_eq!(guess_template("COSTCO"), PlaceTemplate::Costco);
    assert_eq!(guess_template("溪頭營地"), PlaceTemplate::Tent);
    assert_eq!(guess_template("森林小木屋"), PlaceTemplate::Cabin);
    assert_eq!(guess_template("出發地點 A"), PlaceTemplate::Home);
    let labels: Vec<&str> = STUDIO_STOP_KINDS.iter().map(|task| task.label()).collect();
    assert_eq!(
        labels,
        vec![
            "採買",
            "領取租借裝備",
            "歸還裝備",
            "接人",
            "送人下車",
            "取租車",
            "還車",
            "一般停靠"
        ]
    );
    for task in STUDIO_STOP_KINDS {
        let (kind, stored) = stop_task_parts(task);
        assert_eq!(stored, task);
        assert_eq!(kind, task.kind());
    }
}
