//! 現行 `src/model.js` 的 `seed()`（示範旅行），給規則與旅伴的範例測試共用：旅行、6 位旅伴、10 筆活動、4 道料理、
//! 12 個採買品項、11 個裝備與 2 台車，依現行陣列的順序加入，每一列取得當時最大的 Ordinal 加 1，所以陣列的順序就是
//! Ordinal。第一版沒有示範旅行，範例測試只把它當成固定的輸入。
//!
//! - 現行的字串 id 依編號對應：旅伴 `p{n}` 是 [`person(n)`]，活動 `a{n}`、料理 `m{n}`、採買品項 `s{n}`、裝備
//!   `g{n}` 與車輛 `v{n}` 是各自 `Tag` 的 `id(Tag::…, n)`。
//! - 沒有旅伴綁定帳號；現行的 `currentUser` 是 `p1`（[`ME`]），由測試以 `Capabilities` 的 `me` 表示。
//! - 活動的 `people: []` 是全體旅伴，其他是指定旅伴；`type` 是 `ActivityKind`。料理都沒有 `imageKind` 與用餐時間。
//! - 採買品項沒有 `source` 屬性，在 `syncMealIngredients()` 中與 `source: 'manual'` 相同，所以是 Manual_Item；
//!   `seed()` 的品項沒有涵蓋每一道料理的食材（例如壽喜燒醬），所以這份狀態不滿足 I9。
//! - 裝備的 `ready` 是 `packed_by`；`assignee: ''` 是待分配。車輛的舊出發欄位 `meeting` 與動態 `events` 不移植；
//!   `departed: []` 是沒有出發確認。

use std::collections::BTreeSet;

use lm_core::ids::{ActivityId, GearId, MealId, PersonId, ShoppingId, VehicleId};
use lm_core::model::{
    Activity, ActivityKind, Category, Color, CoverKind, Date, GearItem, GearScope, ItemSource,
    Meal, MealSlot, Participation, Person, Row, ShoppingItem, TripCard, TripState, TripStatus,
    Vehicle,
};
use lm_core::time::Hm;

use super::ids::{id, Tag};

/// 現行 `seed()` 的 `currentUser`：小安（`p1`）。
pub const ME: u64 = 1;

pub fn person(n: u64) -> PersonId {
    id(Tag::Person, n)
}

pub fn activity(n: u64) -> ActivityId {
    id(Tag::Activity, n)
}

pub fn meal(n: u64) -> MealId {
    id(Tag::Meal, n)
}

pub fn item(n: u64) -> ShoppingId {
    id(Tag::Shopping, n)
}

pub fn gear(n: u64) -> GearId {
    id(Tag::Gear, n)
}

pub fn vehicle(n: u64) -> VehicleId {
    id(Tag::Vehicle, n)
}

/// `YYYY-MM-DD` 的日期。
pub fn day(text: &str) -> Date {
    text.parse()
        .unwrap_or_else(|error| panic!("{text:?} 不是有效的日期：{error}"))
}

/// `HH:MM` 的時刻。
fn at(text: &str) -> Hm {
    match Hm::parse(text) {
        Ok(Some(hm)) => hm,
        _ => panic!("{text:?} 不是 HH:MM 的時刻"),
    }
}

/// 活動的（日期, 時間, 標題, 類別, 地點, 備註, 指定旅伴）；指定旅伴是空的時為全體。
type ActivitySeed = (
    &'static str,
    &'static str,
    &'static str,
    ActivityKind,
    &'static str,
    &'static str,
    &'static [u64],
);

/// 裝備的（名稱, 數量, 範圍, 負責人, 打包勾選）。
type GearSeed = (
    &'static str,
    &'static str,
    GearScope,
    Option<u64>,
    &'static [u64],
);

fn next_ordinal(state: &TripState) -> u64 {
    state.max_ordinal() + 1
}

/// `seed()` 套用一次採買同步（`commands::synced()`），使它也滿足 I9：以 `Mode::Commit` 執行命令的範例測試使用它，
/// 否則提交時的 `validate::state()` 會因為沒有涵蓋的食材而拒絕每一個命令。
pub fn synced_seed() -> TripState {
    super::commands::synced(seed())
}

/// 現行 `seed()` 的示範旅行（見模組說明）。
pub fn seed() -> TripState {
    let mut state = TripState::new(TripCard {
        id: id(Tag::Trip, 1),
        title: "雲海裡，住一晚".to_owned(),
        destination: "山間小日子營地".to_owned(),
        start: day("2026-11-20"),
        end: day("2026-11-22"),
        description: "一起煮飯、一起看星星。把忙碌留在山下，把好日子帶上來。".to_owned(),
        note: "山上早晚溫差大，記得帶保暖外套。這趟不趕路，慢慢來就好。".to_owned(),
        cover: CoverKind::Camp,
        status: TripStatus::Planning,
        version: 0,
        caption: String::new(),
        headline: String::new(),
    });
    let people = [
        ("小安", Color::Coral, "這趟的召集人"),
        ("阿哲", Color::Blue, "咖啡擔當"),
        ("小雨", Color::Green, "料理小隊長"),
        ("阿森", Color::Yellow, "營火守護者"),
        ("米米", Color::Lavender, "底片記錄員"),
        ("大海", Color::Peach, "路上的 DJ"),
    ];
    for (n, (name, color, role)) in (1..).zip(people) {
        let ordinal = next_ordinal(&state);
        state.put(Row::Person(Person {
            id: person(n),
            name: name.to_owned(),
            role: role.to_owned(),
            color,
            bound: false,
            ordinal,
            version: 0,
        }));
    }
    let everyone: &[u64] = &[1, 2, 3, 4, 5, 6];
    let activities: [ActivitySeed; 10] = [
        (
            "2026-11-20",
            "14:00",
            "城市集合，把日常暫停",
            ActivityKind::Meet,
            "台北車站東三門",
            "先吃飽再集合，帶上你的好心情。",
            everyone,
        ),
        (
            "2026-11-20",
            "15:00",
            "把好吃的，一起買齊",
            ActivityKind::Market,
            "山下超市",
            "照著採買清單分頭行動，別忘了冰塊。",
            &[1, 3, 5],
        ),
        (
            "2026-11-20",
            "16:30",
            "你好，山間小日子",
            ActivityKind::Camp,
            "山間小日子營地",
            "分工搭帳、擺好椅子，再慢慢喝杯咖啡。",
            everyone,
        ),
        (
            "2026-11-20",
            "18:30",
            "營地的第一頓晚餐",
            ActivityKind::Meal,
            "我們的天幕下",
            "熱騰騰的壽喜燒，配上今晚的聊天時間。",
            everyone,
        ),
        (
            "2026-11-20",
            "20:00",
            "把星星留給今晚",
            ActivityKind::Night,
            "營地草坪",
            "關掉大燈、泡一杯熱可可，一起抬頭看看。",
            &[],
        ),
        (
            "2026-11-21",
            "08:30",
            "被咖啡香叫醒",
            ActivityKind::Meal,
            "天幕下",
            "沒有鬧鐘的早晨，從一杯手沖開始。",
            &[2],
        ),
        (
            "2026-11-21",
            "10:00",
            "走一段森林小徑",
            ActivityKind::Camp,
            "營地周邊步道",
            "帶水和輕便外套，遇到喜歡的風景就停下。",
            &[],
        ),
        (
            "2026-11-21",
            "18:00",
            "炭火上的小派對",
            ActivityKind::Meal,
            "我們的營位",
            "阿森負責生火，其他人一起串蔬菜。",
            &[3, 4],
        ),
        (
            "2026-11-22",
            "09:00",
            "最後一杯咖啡，再慢慢收拾",
            ActivityKind::Meal,
            "營地",
            "一起留下比來時更乾淨的營地。",
            &[],
        ),
        (
            "2026-11-22",
            "11:00",
            "把回憶帶回家",
            ActivityKind::Travel,
            "回程路上",
            "下次，換一座山見。",
            &[],
        ),
    ];
    for (n, (date, time, title, kind, location, note, people)) in (1..).zip(activities) {
        let ordinal = next_ordinal(&state);
        let who = if people.is_empty() {
            Participation::Everyone
        } else {
            Participation::People(people.iter().map(|&p| person(p)).collect())
        };
        state.put(Row::Activity(Activity {
            id: activity(n),
            day: day(date),
            time: at(time),
            title: title.to_owned(),
            kind,
            location: location.to_owned(),
            note: note.to_owned(),
            done: false,
            who,
            ordinal,
            version: 0,
        }));
    }
    let meals = [
        (
            "2026-11-20",
            MealSlot::Dinner,
            "暖暖壽喜燒",
            3,
            "牛肉片、板豆腐、高麗菜、香菇、壽喜燒醬",
            "先煎洋蔥，再加入醬汁和食材慢慢煮。",
        ),
        (
            "2026-11-21",
            MealSlot::Breakfast,
            "熱壓吐司與手沖咖啡",
            2,
            "吐司、雞蛋、起司、咖啡豆",
            "起司加倍，咖啡慢慢喝。",
        ),
        (
            "2026-11-21",
            MealSlot::Dinner,
            "星空下的炭火燒烤",
            4,
            "雞腿肉、香腸、玉米、甜椒、棉花糖",
            "生熟食分開夾取，雞肉要烤熟。",
        ),
        (
            "2026-11-22",
            MealSlot::Breakfast,
            "簡單吃，也很幸福",
            1,
            "貝果、奶油、水果、鮮奶",
            "把剩下的食材好好吃完。",
        ),
    ];
    for (n, (date, slot, title, cook, ingredients, notes)) in (1..).zip(meals) {
        let ordinal = next_ordinal(&state);
        state.put(Row::Meal(Meal {
            id: meal(n),
            day: day(date),
            slot,
            time: None,
            title: title.to_owned(),
            cook: Some(person(cook)),
            servings: 6,
            ingredients: ingredients.to_owned(),
            notes: notes.to_owned(),
            dish: None,
            ordinal,
            version: 0,
        }));
    }
    let shopping = [
        ("牛肉片", "2 盒", Category::Meat, Some(3), false),
        ("雞腿肉", "6 片", Category::Meat, Some(4), false),
        ("高麗菜", "1 顆", Category::Vegetables, Some(1), true),
        ("香菇", "2 包", Category::Vegetables, Some(1), false),
        (
            "甜椒、玉米",
            "各 3 個",
            Category::Vegetables,
            Some(5),
            false,
        ),
        ("板豆腐", "2 盒", Category::EggsDairy, Some(3), false),
        ("雞蛋", "1 盒", Category::EggsDairy, Some(1), true),
        ("吐司、貝果", "各 1 包", Category::Staples, Some(5), false),
        ("咖啡豆", "250 g", Category::Drinks, Some(2), true),
        ("飲用水", "12 L", Category::Drinks, Some(6), false),
        ("棉花糖", "1 包", Category::Snacks, Some(5), false),
        ("冰塊", "2 袋", Category::Other, None, false),
    ];
    for (n, (name, quantity, category, assignee, purchased)) in (1..).zip(shopping) {
        let ordinal = next_ordinal(&state);
        state.put(Row::Shopping(ShoppingItem {
            id: item(n),
            name: name.to_owned(),
            quantity: quantity.to_owned(),
            category,
            assignee: assignee.map(person),
            purchased,
            source: ItemSource::Manual,
            meal_ids: BTreeSet::new(),
            recipe_removed: None,
            ordinal,
            version: 0,
        }));
    }
    let gear: [GearSeed; 11] = [
        ("睡袋", "1 個", GearScope::Personal, None, &[]),
        ("睡墊", "1 個", GearScope::Personal, None, &[]),
        ("餐具與水杯", "1 組", GearScope::Personal, None, &[]),
        ("保暖外套", "1 件", GearScope::Personal, None, &[]),
        ("雙人帳篷", "1 頂", GearScope::Shared, Some(1), &[]),
        ("天幕與營柱", "1 組", GearScope::Shared, Some(4), &[]),
        ("卡式爐與瓦斯", "1 組", GearScope::Shared, Some(3), &[]),
        ("手沖咖啡組", "1 組", GearScope::Shared, Some(2), &[2]),
        ("冰桶", "1 個", GearScope::Shared, Some(6), &[]),
        ("營燈", "2 盞", GearScope::Shared, None, &[]),
        ("延長線", "1 條", GearScope::Shared, None, &[]),
    ];
    for (n, (name, quantity, scope, assignee, ready)) in (1..).zip(gear) {
        let ordinal = next_ordinal(&state);
        state.put(Row::Gear(GearItem {
            id: self::gear(n),
            name: name.to_owned(),
            quantity: quantity.to_owned(),
            scope,
            assignee: assignee.map(person),
            packed_by: ready.iter().map(|&p| person(p)).collect(),
            ordinal,
            version: 0,
        }));
    }
    let vehicles = [("山線小巴", 2, [1, 3]), ("海風號", 6, [4, 5])];
    for (n, (name, driver, passengers)) in (1..).zip(vehicles) {
        let ordinal = next_ordinal(&state);
        state.put(Row::Vehicle(Vehicle {
            id: vehicle(n),
            name: name.to_owned(),
            driver: Some(person(driver)),
            seats: 4,
            color: None,
            passengers: passengers.iter().map(|&p| person(p)).collect(),
            ordinal,
            version: 0,
        }));
    }
    state
}
