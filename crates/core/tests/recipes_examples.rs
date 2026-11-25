//! 料理範本與餐次順序的範例測試（需求 33.1）。
//!
//! 移植 Bun_App 測試中以固定輸入斷言第一版規則的案例：輸入與原案例相同，預期值與原案例相同並直接寫在測試中，也就是
//! Bun_App 對同一輸入的結果。每個測試上方的註解標明來源的測試檔與測試名稱，`describe` 之內的測試寫成
//! 「describe › test」；`test.each` 表格的每一列是一個案例。
//!
//! - `tests/meal-order.test.js`（餐次排序）：8 個案例移植 4 個，不移植的 4 個列在下面。
//! - `tests/recipes-invites.test.js` 中料理範本、插圖種類推斷與合併食材的 14 個案例全部移植：
//!   `recipe templates and matching art` 的 7 個測試與 `infers %s` 表格的 4 列，以及
//!   `recognizes common grilled dish %s` 表格的 3 列；其中 3 個案例各有一部分斷言不移植，列在下面。同一檔中旅伴名字
//!   的 13 個案例（`invitation creates a new independent person` 的 6 個測試與 `rejects invalid name %p` 表格的 6 列，
//!   以及 `emoji joined names work while invisible lookalikes and empty names are rejected`）由任務 8.15 移植到
//!   `people_examples.rs`，不在本檔。
//!
//! 現行的資料寫成第一版的列：
//!
//! - 陣列的順序改以 Ordinal 表示：料理、旅伴與採買品項依現行陣列的順序逐一加入，每一列取得當時最大的 Ordinal 加 1
//!   （`push_meal()`、`push_item()`）；採買同步新增的 Meal_Item 依 `SyncPlan::created` 的順序接著取得 Ordinal，與
//!   LM_Server 提交時相同（design A1）。
//! - 字串 id 改為 UUID。`tests/meal-order.test.js` 的料理 id 由 `Menu` 對應，序號與陣列順序相反，所以
//!   `TripState::meals` 依 id 走訪的順序與 Ordinal 相反，Menu_Tab 的順序只能來自日期、餐次與 Ordinal。`seed()` 的
//!   旅伴 `p1`–`p6`、料理 `m1`–`m4` 與採買品項 `s1`–`s12` 依編號對應（`person()`、`seed_meal()`、`seed_item()`），
//!   `pasta-new` 是 `pasta_new()`。
//! - 現行測試的料理物件只寫出部分屬性，例如 `meal(id, date, slot)` 與 `inferDishKind({title})`；第一版的 `Meal`
//!   每個欄位都要有值，沒有寫出的欄位是 `meal()` 的值，它們不影響這裡的規則。`imageKind` 是 `Meal::dish`，沒有這個
//!   屬性是 `None`。`TripState` 需要 Trip_Card，一律使用 `seed()` 的旅行（`card()`）。
//! - 現行 `applyRecipeTemplate()` 的草稿是 `RecipeDraft`，只有套用範本會改的四個欄位：名稱、筆記、食材與插圖種類。
//!
//! 不移植的案例與原因：
//!
//! - `tests/meal-order.test.js` 的 `older aliases have the expected time order`、
//!   `unknown legacy slots appear after known slots on the same date, unchanged` 與
//!   `legacy form option is preserved, not silently replaced with dinner`：斷言舊的餐次名稱（別名早、午、晚、宵夜，
//!   以及其他餐次「早午餐」）的順序與表單選項。第一版的餐次是只有五個值的 `MealSlot`：需求 24.2 拒絕其他餐次，第一版
//!   也不匯入現行的資料，所以沒有 `mealSlotRank()` 的別名、排在五種之後的其他餐次，也沒有為舊餐次保留選項的
//!   `mealSlotOptions()`。
//! - `tests/meal-order.test.js` 的 `new forms have only the five choices and choices are independent copies`：斷言
//!   `mealSlotOptions()` 每次回傳新的陣列，修改它不影響 `MEAL_SLOTS`。第一版沒有 `mealSlotOptions()`，料理表單的
//!   餐次選項就是 `MEAL_SLOTS`，它是不能修改的 `&'static [MealSlot]`；五個選項與順序由
//!   `five meal slots follow chronological order` 檢查。
//! - `recipe templates and matching art` ›
//!   `applying preset merges ingredients without mutating draft, dates, cook or servings` 中 `toMatchObject()` 對
//!   日期、負責人與份數的比較：這三個欄位不在 `RecipeDraft` 中，由料理表單自己保留，`apply_recipe_template()` 拿不到
//!   它們。同一個測試的其他斷言都移植，包括 `toMatchObject()` 對插圖種類的比較。
//! - `recipe templates and matching art` › `explicit type wins; invalid type cannot inject markup` 中
//!   `inferDishKind({imageKind:'<script>'})` 為 custom 的斷言：第一版的插圖種類是 `DishKind` 列舉，無法表示
//!   `'<script>'`；含有這種值的列無法解析，新增或修改料理的命令也依需求 24.2 以 400 拒絕。HTML 跳脫也不是第一版要
//!   移植的規則（需求 33.1）。同一個測試中設定的插圖種類優先的斷言移植。
//! - `recipe templates and matching art` › `saved template retains schema and shopping sync` 中把插圖種類改為
//!   `'evil'` 之後 `isValidState()` 拒絕整份狀態的斷言：`DishKind` 無法表示 `'evil'`，第一版也沒有寫入整份狀態的
//!   功能（沒有 localStorage 與整份 PUT，只接受 Command），料理的插圖種類由命令依需求 24.2 檢查。同一個測試中套用
//!   範本、加入料理並同步採買清單的斷言移植。
//!
//! 第一版依 requirements.md 與現行不同的兩條規則，這兩個 Bun 測試檔都沒有斷言它們的案例，所以不影響移植的預期值：
//! 合併後的食材以 Char_Count 計算、最多 2,000 字（需求 24.11；現行是 500 個 UTF-16 單位），以及常用食材捷徑以
//! Ingredient_Key 判斷是否已選取（需求 24.4；現行比較切出的名稱是否完全相同）。這兩條規則由 `lm_core::recipes` 的
//! 單元測試涵蓋。

mod support;

use std::collections::{BTreeSet, HashSet};

use lm_core::ids::{MealId, PersonId, ShoppingId};
use lm_core::ingredients::{classify_ingredient, parse_ingredients, sync_meal_ingredients};
use lm_core::limits::{
    INGREDIENT_NAME_CHARS, MEALS_MAX, MEAL_INGREDIENTS_CHARS, MEAL_NOTES_CHARS, MEAL_SERVINGS,
    MEAL_TITLE_CHARS, SHOPPING_ITEMS_MAX, SHOPPING_NAME_CHARS, SHOPPING_QUANTITY_CHARS,
};
use lm_core::model::{
    Category, Color, CoverKind, Date, DishKind, ItemSource, Meal, MealSlot, Person, Row,
    ShoppingItem, TripCard, TripState, TripStatus,
};
use lm_core::recipes::{
    apply_recipe_template, group_meals_by_date, infer_dish_kind, merge_ingredients,
    recipe_template, RecipeDraft, RecipeTemplate, COMMON_INGREDIENTS, MEAL_SLOTS, RECIPE_TEMPLATES,
};
use lm_core::text::char_count;

use support::ids::{id, SeqIds, Tag};

// ── 餐次順序（tests/meal-order.test.js）──

/// 來源：`tests/meal-order.test.js` 的 `five meal slots follow chronological order`。
#[test]
fn five_meal_slots_follow_chronological_order() {
    let slots: Vec<&str> = MEAL_SLOTS.iter().map(MealSlot::as_str).collect();
    assert_eq!(slots, ["早餐", "午餐", "下午茶", "晚餐", "消夜"]);
}

/// 來源：`tests/meal-order.test.js` 的 `date is sorted before slot, with stable order for same-slot dishes`。
/// 同一天、同一餐次的 lunch1 與 lunch2 依 Ordinal，也就是現行陣列的順序。
#[test]
fn meals_sort_by_date_before_slot_and_keep_their_order_within_a_slot() {
    let menu = Menu::new(&[
        ("night", "2026-11-21", "消夜"),
        ("dinner", "2026-11-20", "晚餐"),
        ("lunch1", "2026-11-21", "午餐"),
        ("breakfast", "2026-11-21", "早餐"),
        ("tea", "2026-11-21", "下午茶"),
        ("lunch2", "2026-11-21", "午餐"),
    ]);
    assert_eq!(
        menu.groups(),
        [
            ("2026-11-20".to_owned(), vec!["dinner"]),
            (
                "2026-11-21".to_owned(),
                vec!["breakfast", "lunch1", "lunch2", "tea", "night"]
            ),
        ]
    );
}

/// 來源：`tests/meal-order.test.js` 的 `display sorting does not mutate data or stored array order`。
/// 現行以 `Object.freeze()` 確認排序不修改輸入；`group_meals_by_date()` 只借用料理，所以這裡確認結果中的料理就是
/// Trip_State 中的那一道（`toBe(input[1])`，不是複本），而且 Trip_State 與依 Ordinal 的順序都沒有改變。
#[test]
fn display_sorting_does_not_change_the_meals_or_their_stored_order() {
    let menu = Menu::new(&[("a", "2026-11-22", "晚餐"), ("b", "2026-11-20", "早餐")]);
    let before = menu.state.clone();
    let groups = group_meals_by_date(menu.state.meals.values());
    assert!(std::ptr::eq(
        groups[0].meals[0],
        &menu.state.meals[&menu.meal_id("b")]
    ));
    assert_eq!(menu.state, before);
    assert_eq!(menu.names_by_ordinal(), ["a", "b"]);
}

/// 來源：`tests/meal-order.test.js` 的 `empty menu returns no date groups`。原測試的 `groupMealsByDate()` 沒有傳參數，
/// 參數的預設值是空陣列，也就是沒有任何料理的旅行。
#[test]
fn an_empty_menu_has_no_date_groups() {
    assert_eq!(Menu::new(&[]).groups(), Vec::<(String, Vec<&str>)>::new());
}

// ── 料理範本、插圖種類與合併食材（tests/recipes-invites.test.js）──

/// 來源：`tests/recipes-invites.test.js` 的 `recipe templates and matching art` ›
/// `templates cover registered artwork and have valid classified ingredients`。
#[test]
fn templates_cover_registered_artwork_and_have_classified_ingredients() {
    // expect(DISH_TYPES.map(([k])=>k).sort()).toEqual([...DISH_KINDS].sort())
    let mut dish_types: Vec<&str> = DishKind::ALL.iter().map(DishKind::as_str).collect();
    dish_types.sort_unstable();
    let mut artwork = DISH_KINDS.to_vec();
    artwork.sort_unstable();
    assert_eq!(dish_types, artwork);
    // 範本的 id 不重複
    let ids: HashSet<&str> = RECIPE_TEMPLATES
        .iter()
        .map(|template| template.id)
        .collect();
    assert_eq!(ids.len(), RECIPE_TEMPLATES.len());
    for template in RECIPE_TEMPLATES {
        assert!(
            DISH_KINDS.contains(&template.dish.as_str()),
            "{}",
            template.id
        );
        let names = parse_ingredients(template.ingredients);
        assert!(names.len() > 3, "{}：{names:?}", template.id);
        for name in &names {
            assert_ne!(
                classify_ingredient(name).as_str(),
                "其他",
                "{}：{name}",
                template.id
            );
        }
    }
    // 每一組常用食材捷徑的名稱不重複
    for group in COMMON_INGREDIENTS {
        let names: HashSet<&str> = group.names.iter().copied().collect();
        assert_eq!(names.len(), group.names.len(), "{}", group.label);
    }
}

/// 來源：`tests/recipes-invites.test.js` 的 `recipe templates and matching art` ›
/// `applying preset merges ingredients without mutating draft, dates, cook or servings`。日期、負責人與份數不在
/// `RecipeDraft` 中，所以 `toMatchObject()` 只比較插圖種類（見檔頭）。
#[test]
fn applying_a_template_merges_ingredients_without_changing_the_draft() {
    // const draft={title:'原本',notes:'筆記',ingredients:'雞腿肉、鮮蝦',date:'2026-11-21',cookId:'p2',servings:'9'}
    let draft = RecipeDraft {
        title: "原本".to_owned(),
        notes: "筆記".to_owned(),
        ingredients: "雞腿肉、鮮蝦".to_owned(),
        dish: None,
    };
    let copy = draft.clone();
    let result =
        apply_recipe_template(&draft, template("curry")).expect("合併後的食材沒有超過 2,000 字");
    assert_eq!(draft, copy);
    assert_eq!(result.dish.map(|dish| dish.as_str()), Some("curry"));
    let names = parse_ingredients(&result.ingredients);
    assert_eq!(
        names.iter().filter(|name| *name == "雞腿肉").count(),
        1,
        "{names:?}"
    );
    assert!(
        result.ingredients.contains("鮮蝦"),
        "{}",
        result.ingredients
    );
}

/// 來源：`tests/recipes-invites.test.js` 的 `recipe templates and matching art` ›
/// `quick ingredients merge normalized names and reject no input safely`。
#[test]
fn merging_ingredients_keeps_one_of_each_name_and_accepts_empty_input() {
    assert_eq!(
        merge_ingredients(" 雞蛋、雞蛋", "雞蛋、高麗菜"),
        "雞蛋、高麗菜"
    );
    assert_eq!(merge_ingredients("", ""), "");
}

/// 來源：`tests/recipes-invites.test.js` 的 `recipe templates and matching art` ›
/// `unknown preset fails without data change`。現行的 `applyRecipeTemplate()` 找不到範本時丟出錯誤；第一版先以
/// `recipe_template()` 找範本，找不到時是 `None`，沒有可以套用的範本，草稿不變。
#[test]
fn an_unknown_template_fails_without_changing_the_draft() {
    // const draft={ingredients:'雞蛋'}
    let draft = RecipeDraft {
        ingredients: "雞蛋".to_owned(),
        ..RecipeDraft::default()
    };
    let applied =
        recipe_template("__proto__").map(|template| apply_recipe_template(&draft, template));
    assert_eq!(applied, None);
    assert_eq!(
        draft,
        RecipeDraft {
            ingredients: "雞蛋".to_owned(),
            ..RecipeDraft::default()
        }
    );
}

/// 來源：`tests/recipes-invites.test.js` 的 `recipe templates and matching art` ›
/// `existing demo meals get matching pictures without data migration`。`seed()` 的四道料理都沒有設定插圖種類，
/// 依名稱與食材推斷，推斷的結果不寫入料理（需求 24.5）。
#[test]
fn seed_meals_get_matching_pictures_without_a_set_dish_kind() {
    let state = seed();
    let kinds: Vec<&str> = state
        .meals_by_ordinal()
        .map(|meal| infer_dish_kind(meal).as_str())
        .collect();
    assert_eq!(kinds, ["hotpot", "toast", "bbq", "breakfast"]);
}

/// 來源：`tests/recipes-invites.test.js` 的 `recipe templates and matching art` › `infers %s`，表格的每一列是一個
/// 案例。原測試的料理只有名稱（`inferDishKind({title})`）。
#[test]
fn dish_kind_is_inferred_from_the_title() {
    let cases: [(&str, &str); 4] = [
        ("咖哩飯", "curry"),
        ("番茄義大利麵", "pasta"),
        ("野餐沙拉", "salad"),
        ("不知道吃什麼", "custom"),
    ];
    for (title, kind) in cases {
        assert_eq!(
            infer_dish_kind(&titled_meal(title, None)).as_str(),
            kind,
            "{title:?}"
        );
    }
}

/// 來源：`tests/recipes-invites.test.js` 的 `recipe templates and matching art` ›
/// `explicit type wins; invalid type cannot inject markup`。只移植設定的插圖種類優先的斷言；`'<script>'` 的斷言不
/// 移植（見檔頭）。
#[test]
fn a_set_dish_kind_wins_over_the_title() {
    // inferDishKind({title:'咖哩飯',imageKind:'salad'})
    assert_eq!(
        infer_dish_kind(&titled_meal("咖哩飯", Some(DishKind::Salad))).as_str(),
        "salad"
    );
}

/// 來源：`tests/recipes-invites.test.js` 的 `recipe templates and matching art` ›
/// `saved template retains schema and shopping sync`。只移植套用範本、加入料理並同步採買清單的部分；插圖種類改為
/// `'evil'` 的斷言不移植（見檔頭）。
#[test]
fn a_saved_template_meal_stays_valid_and_adds_its_ingredients_to_shopping() {
    let mut state = seed();
    // state.meals.push({...state.meals[0],...applyRecipeTemplate({ingredients:''},'pasta'),id:'pasta-new'})
    let draft = apply_recipe_template(&RecipeDraft::default(), template("pasta"))
        .expect("合併後的食材沒有超過 2,000 字");
    let first = state
        .meals_by_ordinal()
        .next()
        .expect("seed() 有料理")
        .clone();
    push_meal(
        &mut state,
        Meal {
            id: pasta_new(),
            title: draft.title,
            notes: draft.notes,
            ingredients: draft.ingredients,
            dish: draft.dish,
            ..first
        },
    );
    sync(&mut state);
    assert_valid_menu(&state);
    assert!(state.shopping.values().any(|item| item.name == "義大利麵"));
}

/// 來源：`tests/recipes-invites.test.js` 的測試 `recognizes common grilled dish %s`，表格的每一列是一個案例。
#[test]
fn common_grilled_dishes_are_bbq() {
    for title in ["烤雞", "烤魚", "烤玉米"] {
        assert_eq!(
            infer_dish_kind(&titled_meal(title, None)).as_str(),
            "bbq",
            "{title:?}"
        );
    }
}

// ── 現行測試的資料與輔助函式 ──

/// `src/dish-art.js` 的 `DISH_KINDS`（`Object.keys(DISHES)`，已註冊插圖的種類），依原順序。第一版的插圖在 lm-web，
/// 不在 lm-core，所以直接寫出。
const DISH_KINDS: [&str; 8] = [
    "hotpot",
    "bbq",
    "toast",
    "curry",
    "pasta",
    "breakfast",
    "salad",
    "custom",
];

/// `tests/meal-order.test.js` 的 `input`：依陣列的順序以 `meal(id, date, slot)` 加入的料理，以及現行的字串 id 與
/// UUID 的對應。第 i 道（從 1 起）料理的 Ordinal 是 i；n 道料理中第 i 道的 id 是 `id(Tag::Meal, n + 1 - i)`，序號與
/// 陣列順序相反，所以 `TripState::meals` 依 id 走訪的順序與 Ordinal 相反：同一天、同一餐次的料理只有依 Ordinal 排列，
/// 才會是現行陣列的順序。
struct Menu {
    state: TripState,
    names: Vec<(&'static str, MealId)>,
}

impl Menu {
    /// `input` 的每一項是（現行的字串 id, 日期, 餐次）。
    fn new(input: &[(&'static str, &str, &str)]) -> Menu {
        let mut state = TripState::new(card());
        let mut names = Vec::new();
        let count = u64::try_from(input.len()).expect("料理的數量放得進 u64");
        for ((name, date, slot), number) in input.iter().zip((1..=count).rev()) {
            let meal_id = id(Tag::Meal, number);
            push_meal(&mut state, meal(meal_id, date, slot));
            names.push((*name, meal_id));
        }
        Menu { state, names }
    }

    /// 現行字串 id 為 `name` 的料理的 id。
    fn meal_id(&self, name: &str) -> MealId {
        self.names
            .iter()
            .find(|(known, _)| *known == name)
            .map(|&(_, meal_id)| meal_id)
            .unwrap_or_else(|| panic!("input 中沒有「{name}」"))
    }

    /// 料理 `meal_id` 的現行字串 id。
    fn name(&self, meal_id: MealId) -> &'static str {
        self.names
            .iter()
            .find(|&&(_, known)| known == meal_id)
            .map(|&(name, _)| name)
            .unwrap_or_else(|| panic!("料理 {meal_id} 不在 input 中"))
    }

    /// 現行測試的 `groupMealsByDate(input).map(g=>[g.date,g.meals.map(m=>m.id)])`：Menu_Tab 的每個日期區塊，以及其中
    /// 依序排列的料理的字串 id。料理依 `TripState::meals` 的順序（依 id）傳入。
    fn groups(&self) -> Vec<(String, Vec<&'static str>)> {
        group_meals_by_date(self.state.meals.values())
            .into_iter()
            .map(|group| {
                let names = group.meals.iter().map(|meal| self.name(meal.id)).collect();
                (group.day.to_string(), names)
            })
            .collect()
    }

    /// 現行測試的 `input.map(m=>m.id)`：依 Ordinal（現行陣列的順序）排列的料理的字串 id。
    fn names_by_ordinal(&self) -> Vec<&'static str> {
        self.state
            .meals_by_ordinal()
            .map(|meal| self.name(meal.id))
            .collect()
    }
}

/// 現行測試的 `seed()`（`src/model.js` 的示範旅行）中料理與採買同步用到的部分：旅行、6 位旅伴、4 道料理與 12 個採買
/// 品項，依現行陣列的順序加入。第一版沒有示範旅行，這裡只把它當成固定的輸入；活動、裝備、車輛與動態不影響這裡的
/// 規則，不移植。
fn seed() -> TripState {
    let mut state = TripState::new(card());
    // （名字, 顏色, 小隊角色）
    let people = [
        ("小安", "coral", "這趟的召集人"),
        ("阿哲", "blue", "咖啡擔當"),
        ("小雨", "green", "料理小隊長"),
        ("阿森", "yellow", "營火守護者"),
        ("米米", "lavender", "底片記錄員"),
        ("大海", "peach", "路上的 DJ"),
    ];
    for (n, (name, color, role)) in (1..).zip(people) {
        let ordinal = next_ordinal(&state);
        state.put(Row::Person(Person {
            id: person(n),
            name: name.to_owned(),
            role: role.to_owned(),
            color: Color::parse(color).unwrap_or_else(|| panic!("「{color}」是旅伴顏色")),
            bound: false,
            ordinal,
            version: 0,
        }));
    }
    // （日期, 餐次, 名稱, 負責人, 食材, 備註）；份數都是 6，都沒有 imageKind
    let meals = [
        (
            "2026-11-20",
            "晚餐",
            "暖暖壽喜燒",
            3,
            "牛肉片、板豆腐、高麗菜、香菇、壽喜燒醬",
            "先煎洋蔥，再加入醬汁和食材慢慢煮。",
        ),
        (
            "2026-11-21",
            "早餐",
            "熱壓吐司與手沖咖啡",
            2,
            "吐司、雞蛋、起司、咖啡豆",
            "起司加倍，咖啡慢慢喝。",
        ),
        (
            "2026-11-21",
            "晚餐",
            "星空下的炭火燒烤",
            4,
            "雞腿肉、香腸、玉米、甜椒、棉花糖",
            "生熟食分開夾取，雞肉要烤熟。",
        ),
        (
            "2026-11-22",
            "早餐",
            "簡單吃，也很幸福",
            1,
            "貝果、奶油、水果、鮮奶",
            "把剩下的食材好好吃完。",
        ),
    ];
    for (n, (date, slot, title, cook, ingredients, notes)) in (1..).zip(meals) {
        push_meal(
            &mut state,
            Meal {
                title: title.to_owned(),
                cook: Some(person(cook)),
                servings: 6,
                ingredients: ingredients.to_owned(),
                notes: notes.to_owned(),
                ..meal(seed_meal(n), date, slot)
            },
        );
    }
    // （名稱, 數量, 分類, 負責人, 已買）；負責人 None 是現行的 `assignee: ''`（待分配）。現行的品項沒有 `source`
    // 屬性，在 `syncMealIngredients()` 中與 `source: 'manual'` 相同（它只檢查 `source === 'meal'`），所以是
    // Manual_Item；還沒有連動料理，也沒有「料理已移除」標記。
    let shopping = [
        ("牛肉片", "2 盒", "肉類", Some(3), false),
        ("雞腿肉", "6 片", "肉類", Some(4), false),
        ("高麗菜", "1 顆", "蔬菜", Some(1), true),
        ("香菇", "2 包", "蔬菜", Some(1), false),
        ("甜椒、玉米", "各 3 個", "蔬菜", Some(5), false),
        ("板豆腐", "2 盒", "蛋奶", Some(3), false),
        ("雞蛋", "1 盒", "蛋奶", Some(1), true),
        ("吐司、貝果", "各 1 包", "主食", Some(5), false),
        ("咖啡豆", "250 g", "飲料", Some(2), true),
        ("飲用水", "12 L", "飲料", Some(6), false),
        ("棉花糖", "1 包", "零食", Some(5), false),
        ("冰塊", "2 袋", "其他", None, false),
    ];
    for (n, (name, quantity, category, assignee, purchased)) in (1..).zip(shopping) {
        push_item(
            &mut state,
            ShoppingItem {
                id: seed_item(n),
                name: name.to_owned(),
                quantity: quantity.to_owned(),
                category: Category::parse(category)
                    .unwrap_or_else(|| panic!("「{category}」是採買分類")),
                assignee: assignee.map(person),
                purchased,
                source: ItemSource::Manual,
                meal_ids: BTreeSet::new(),
                recipe_removed: None,
                ordinal: 0,
                version: 0,
            },
        );
    }
    state
}

/// `seed()` 的旅行：2026-11-20 到 2026-11-22。現行的旅行沒有封面與狀態，這裡是 camp 與規劃中。
fn card() -> TripCard {
    TripCard {
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
    }
}

/// 現行測試的 `meal(id, date, slot)`：只有 id、日期與餐次的料理，`slot` 是餐次的中文名稱。其他欄位不影響這裡的規則：
/// 沒有用餐時間、名稱、負責人（待分配）、食材、備註與插圖種類，份數是 1；Ordinal 由 `push_meal()` 指定。
fn meal(meal_id: MealId, date: &str, slot: &str) -> Meal {
    Meal {
        id: meal_id,
        day: day(date),
        slot: MealSlot::parse(slot).unwrap_or_else(|| panic!("「{slot}」是餐次")),
        time: None,
        title: String::new(),
        cook: None,
        servings: 1,
        ingredients: String::new(),
        notes: String::new(),
        dish: None,
        ordinal: 0,
        version: 0,
    }
}

/// 只有名稱與插圖種類的料理，例如現行的 `inferDishKind({title})`（沒有 `imageKind` 屬性時 `dish` 是 `None`），沒有
/// 食材。日期與餐次不影響插圖種類，固定為 2026-11-20 的晚餐。
fn titled_meal(title: &str, dish: Option<DishKind>) -> Meal {
    Meal {
        title: title.to_owned(),
        dish,
        ..meal(id(Tag::Meal, 1), "2026-11-20", "晚餐")
    }
}

/// id 是 `template_id` 的料理範本。
fn template(template_id: &str) -> &'static RecipeTemplate {
    recipe_template(template_id).unwrap_or_else(|| panic!("有 {template_id} 範本"))
}

/// 現行的 `syncMealIngredients(state)`：執行採買同步並套用到 `state`。新增的 Meal_Item 與 LM_Server 提交時相同，依
/// `plan.created` 的順序取得 Ordinal（design A1），排在現行陣列的最後。
fn sync(state: &mut TripState) {
    let plan = sync_meal_ingredients(state, &mut SeqIds::new()).expect("採買品項沒有超過 1000 項");
    let first = next_ordinal(state);
    plan.apply_to(state);
    for (ordinal, item_id) in (first..).zip(&plan.created) {
        state
            .shopping
            .get_mut(item_id)
            .expect("同步新增的品項")
            .ordinal = ordinal;
    }
}

/// 原測試的 `expect(isValidState(state)).toBe(true)`。第一版的 State_Validator 是 `validate::state()`（任務 8.5，
/// 還沒有實作），資料格式也不同，所以這裡以第一版的規則檢查 `isValidState()` 對料理與採買清單的條件中型別沒有保證
/// 的部分：
///
/// - 料理最多 1000 道，採買品項最多 1000 項（I12）。
/// - 料理的日期在旅行範圍內（I5），負責人是旅伴或待分配（I1），份數 1–100；名稱、食材與筆記的長度不超過需求 24.2
///   的上限，也不含 U+0000，切出的每個食材 1–100 字（需求 25.18）。現行只有每個欄位 5000 字的通用上限。
/// - 採買品項的名稱 1–100 字、數量 0–40 字（現行同樣只有 5000 字的上限），連動的料理都存在（I1），負責人是旅伴或
///   待分配（I1）。
///
/// 插圖種類、餐次、採買分類與來源由型別保證是列舉值，連動的料理是集合，不會重複。
fn assert_valid_menu(state: &TripState) {
    assert!(
        state.meals.len() <= MEALS_MAX,
        "料理有 {} 道",
        state.meals.len()
    );
    for meal in state.meals.values() {
        let title = &meal.title;
        assert!(
            (state.card.start..=state.card.end).contains(&meal.day),
            "「{title}」的日期 {} 不在旅行範圍內",
            meal.day
        );
        assert!(
            meal.cook
                .is_none_or(|cook| state.people.contains_key(&cook)),
            "「{title}」的負責人不是旅伴"
        );
        assert!(
            MEAL_SERVINGS.contains(&meal.servings),
            "「{title}」是 {} 人份",
            meal.servings
        );
        assert!(
            MEAL_TITLE_CHARS.contains(&char_count(title)),
            "「{title}」的名稱太長"
        );
        assert!(
            MEAL_INGREDIENTS_CHARS.contains(&char_count(&meal.ingredients)),
            "「{title}」的食材太長"
        );
        assert!(
            MEAL_NOTES_CHARS.contains(&char_count(&meal.notes)),
            "「{title}」的筆記太長"
        );
        assert!(
            [title, &meal.ingredients, &meal.notes]
                .iter()
                .all(|text| !text.contains('\0')),
            "「{title}」含有 U+0000"
        );
        assert!(
            parse_ingredients(&meal.ingredients)
                .iter()
                .all(|name| INGREDIENT_NAME_CHARS.contains(&char_count(name))),
            "「{title}」的食材有超過 100 字的名稱"
        );
    }
    assert!(
        state.shopping.len() <= SHOPPING_ITEMS_MAX,
        "採買品項有 {} 項",
        state.shopping.len()
    );
    for item in state.shopping.values() {
        let name = &item.name;
        assert!(
            SHOPPING_NAME_CHARS.contains(&char_count(name)),
            "品項名稱「{name}」的長度不對"
        );
        assert!(
            SHOPPING_QUANTITY_CHARS.contains(&char_count(&item.quantity)),
            "「{name}」的數量太長"
        );
        assert!(
            item.meal_ids
                .iter()
                .all(|meal| state.meals.contains_key(meal)),
            "「{name}」連動了不存在的料理：{:?}",
            item.meal_ids
        );
        assert!(
            item.assignee
                .is_none_or(|assignee| state.people.contains_key(&assignee)),
            "「{name}」的負責人不是旅伴"
        );
    }
}

/// 下一列的 Ordinal：目前最大的 Ordinal 加 1，與 LM_Server 為新列指定的 Ordinal 相同（design A1）。所以依序加入的列
/// 依現行陣列的順序排列，之後加入的列排在最後。
fn next_ordinal(state: &TripState) -> u64 {
    state.max_ordinal() + 1
}

/// 依現行陣列的順序加入料理（現行的 `push()`），Ordinal 是 `next_ordinal()`。
fn push_meal(state: &mut TripState, row: Meal) {
    let ordinal = next_ordinal(state);
    state.put(Row::Meal(Meal { ordinal, ..row }));
}

/// 依現行陣列的順序加入採買品項，Ordinal 是 `next_ordinal()`。
fn push_item(state: &mut TripState, row: ShoppingItem) {
    let ordinal = next_ordinal(state);
    state.put(Row::Shopping(ShoppingItem { ordinal, ..row }));
}

/// 現行的旅伴 `p{n}`（`seed()` 的 6 位旅伴，n 為 1–6）。
fn person(n: u64) -> PersonId {
    id(Tag::Person, n)
}

/// `seed()` 的料理 `m{n}`（n 為 1–4）。
fn seed_meal(n: u64) -> MealId {
    id(Tag::Meal, n)
}

/// 現行測試加入的料理 `pasta-new`；序號是 0x100，所以與 `seed_meal()` 不重複。
fn pasta_new() -> MealId {
    id(Tag::Meal, 0x100)
}

/// `seed()` 的採買品項 `s{n}`（n 為 1–12）。
fn seed_item(n: u64) -> ShoppingId {
    id(Tag::Shopping, n)
}

fn day(text: &str) -> Date {
    lm_core::time::parse_date(text).expect("有效的日期")
}
