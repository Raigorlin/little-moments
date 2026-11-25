//! 食材與採買同步的範例測試（需求 33.1、33.10）。
//!
//! 移植 `tests/ingredients.test.js` 中以固定輸入斷言第一版規則的案例（食材切分與分類、Shopping_Sync）：輸入與原案例
//! 相同，預期值與原案例相同並直接寫在測試中，也就是 Bun_App 對同一輸入的結果。每個測試上方的註解標明來源的測試名稱，
//! `describe` 之內的測試寫成「describe › test」；`test.each` 表格的每一列是一個案例。該檔的 82 個案例移植 79 個：
//! 15 個測試，以及三個表格的 47、13 與 4 列；不移植的 3 個列在下面。
//!
//! 現行的資料寫成第一版的列：
//!
//! - 陣列的順序改以 Ordinal 表示：旅伴、料理與採買品項依現行陣列的順序逐一加入，每一列取得當時最大的 Ordinal 加 1
//!   （`push_meal()`、`push_item()`）；採買同步新增的 Meal_Item 依 `SyncPlan::created` 的順序接著取得 Ordinal，與
//!   LM_Server 提交時相同（design A1）。所以依 Ordinal 走訪的順序就是現行陣列的順序，`push()` 的品項與同步新增的品項
//!   排在最後。
//! - 字串 id 改為 UUID：旅伴 `p1`–`p6`、`seed()` 的料理 `m1`–`m4` 與採買品項 `s1`–`s12`、`recipeState()` 的料理
//!   `meal-0`、`meal-1` …，以及測試直接寫入的品項（`existing`、`manual`、`one`、`two`、`s-0` …）各對應一個 UUID
//!   （`person()`、`seed_meal()`、`seed_item()`、`recipe_meal()`、`test_item_id()`）。同步新增品項的 id 在現行是
//!   `crypto.randomUUID()`，這裡由決定性的 `SeqIds` 提供；原測試不比較這些 id，這裡也不比較。
//! - 品項的 `done` 是 `purchased`，`assignee: ''` 是 `None`（待分配），`mealIds` 是 `meal_ids`（集合，所以比較時不看
//!   順序），沒有 `recipeRemoved` 屬性是 `None`。沒有 `source` 屬性的品項（`seed()` 的採買清單，以及測試直接寫入的
//!   品項）在 `syncMealIngredients()` 中與 `source: 'manual'` 完全相同（它只檢查 `source === 'meal'`），所以寫成
//!   Manual_Item。
//! - `syncMealIngredients()` 的回傳值 `{changed, added, removed}` 由 `SyncPlan` 算出（`sync()`）；
//!   `expect(isValidState(state)).toBe(true)` 改為 `assert_valid_shopping()`。
//!
//! 不移植的案例與原因：
//!
//! - `recipe-to-shopping synchronization` › `new category and linkage metadata round-trip through old schema version`：
//!   以 localStorage 的 `save()` 與 `load()` 保存再讀回整份狀態，第一版沒有這個功能。同一個測試中讀回之後再同步沒有
//!   變化（與 `same names across meals stay one row and repeated sync is a no-op` 及 Property 4 相同），以及每一種
//!   採買分類都通過 `isValidState()`（第一版由 `Category` 型別保證），都依附在讀回的狀態上。
//! - `recipe-to-shopping synchronization` › `rejects malformed source metadata and nonexistent meal references`：
//!   斷言 `isValidState()` 拒絕整份狀態中格式錯誤的 `source` 與 `mealIds`，以及連動不存在的料理。第一版沒有寫入
//!   整份狀態的功能（沒有 localStorage 與整份 PUT，只接受 Command），品項的來源與連動的料理只由命令的規則與採買同步
//!   設定；列的格式由型別與 serde 決定（不是 meal 或 manual 的來源、不是陣列的 `meal_ids` 都無法解析，`meal_ids` 是
//!   集合所以不會重複），連動不存在的料理違反 `validate::state()` 的 I9。
//! - `one-way storage migration preserves original data and ignores later old-tab writes`：localStorage 從舊鍵單向
//!   搬移，第一版沒有這個功能。
//!
//! 另外依需求寫的範例（不算移植的案例）：
//!
//! - 需求 33.10：Ingredient_Parser 與 Ingredient_Key 使用 JS_Whitespace（U+FEFF 算空白、U+0085 不算），
//!   Ingredient_Classifier 規則中的數字只比對 0–9。預期值是 Bun_App 對同一輸入的結果。
//! - 需求 25.16 的從料理移除食材：`tests/ingredients.test.js` 沒有這類案例，所以依需求 25.16 的例子寫成範例。現行的
//!   `removeIngredientFromMeals()` 在沒有任何料理需要這個品項時直接刪除它，不論它是手動或已買的品項；第一版只改選定
//!   料理的食材文字，品項是否保留由同一次提交的 Shopping_Sync 決定，所以範例的預期值依需求撰寫：已買的品項留下。

mod support;

use std::collections::BTreeSet;

use lm_core::ids::{MealId, PersonId, ShoppingId};
use lm_core::ingredients::{
    classify_ingredient, ingredient_key, parse_ingredients, remove_ingredient,
    remove_ingredient_from_meals, sync_meal_ingredients, SyncPlan,
};
use lm_core::limits::SHOPPING_ITEMS_MAX;
use lm_core::model::{
    Category, Color, CoverKind, Date, ItemSource, Meal, MealSlot, Person, Row, ShoppingItem,
    TripCard, TripState, TripStatus,
};

use support::ids::{id, SeqIds, Tag};

// ── 食材切分 ──

/// 來源：`tests/ingredients.test.js` 的 `ingredient parsing and classification` ›
/// `accepts ideographic/Chinese/English commas, semicolons and newlines`。
#[test]
fn parse_accepts_ideographic_chinese_and_english_commas_semicolons_and_newlines() {
    assert_eq!(
        parse_ingredients(" 牛肉片、 高麗菜，雞蛋, 起司；白米;番茄\n鮮奶\r\n"),
        ["牛肉片", "高麗菜", "雞蛋", "起司", "白米", "番茄", "鮮奶"]
    );
}

/// 來源：`tests/ingredients.test.js` 的 `ingredient parsing and classification` ›
/// `discards empty tokens and deduplicates normalized names`。
#[test]
fn parse_discards_empty_tokens_and_deduplicates_normalized_names() {
    assert_eq!(parse_ingredients("、 , ，；\n"), Vec::<String>::new());
    assert_eq!(
        parse_ingredients("雞 蛋、雞蛋、 ＡＢＣ , abc"),
        ["雞 蛋", "ABC"]
    );
    // 原測試的 parseIngredients() 沒有傳參數，參數的預設值是空字串
    assert_eq!(parse_ingredients(""), Vec::<String>::new());
}

/// 來源：`tests/ingredients.test.js` 的測試
/// `halfwidth separators normalize before parsing, numeric commas stay in the item`。
#[test]
fn parse_normalizes_halfwidth_separators_and_keeps_numeric_commas() {
    // 「､」是 U+FF64，NFKC 之後是「、」
    assert_eq!(parse_ingredients("牛肉､豬肉"), ["牛肉", "豬肉"]);
    assert_eq!(
        parse_ingredients("1,000g 牛肉、雞蛋"),
        ["1,000g 牛肉", "雞蛋"]
    );
}

/// 來源：`tests/ingredients.test.js` 的測試
/// `ingredient delimiters support slash and periods with numeric decimal preservation`。
#[test]
fn parse_and_sync_split_on_slashes_and_periods_but_keep_decimals() {
    assert_eq!(
        parse_ingredients("牛肉片/高麗菜,雞蛋.起司。白米、鮮奶"),
        ["牛肉片", "高麗菜", "雞蛋", "起司", "白米", "鮮奶"]
    );
    // 全形的「／」「．」「，」在 NFKC 之後是半形
    assert_eq!(
        parse_ingredients("牛肉片／高麗菜．鸡蛋，白米"),
        ["牛肉片", "高麗菜", "鸡蛋", "白米"]
    );
    assert_eq!(
        parse_ingredients("牛奶 1.5L/白米 1,000g.雞蛋"),
        ["牛奶 1.5L", "白米 1,000g", "雞蛋"]
    );
    assert_eq!(parse_ingredients(" /、.,。／． "), Vec::<String>::new());

    let mut state = recipe_state(&["牛肉片/高麗菜,雞蛋.板豆腐。醬油"]);
    sync(&mut state, &mut SeqIds::new());
    let names: Vec<&str> = state
        .shopping_by_ordinal()
        .map(|item| item.name.as_str())
        .collect();
    assert_eq!(names, ["牛肉片", "高麗菜", "雞蛋", "板豆腐", "醬油"]);
    let categories: Vec<&str> = state
        .shopping_by_ordinal()
        .map(|item| item.category.as_str())
        .collect();
    assert_eq!(categories, ["肉類", "蔬菜", "蛋奶", "豆製品", "調味料"]);
}

/// 需求 33.10：現行的 Ingredient_Parser 與 Ingredient_Key 以 JavaScript 的 `trim()` 與 `\s`（JS_Whitespace）處理
/// 空白：U+FEFF 算空白、U+0085 不算，與 Rust 的 `char::is_whitespace()` 正好相反。預期值是 Bun_App 對同一輸入的結果。
#[test]
fn parser_and_key_treat_feff_but_not_0085_as_whitespace() {
    assert_eq!(parse_ingredients("\u{feff}雞蛋"), ["雞蛋"]);

    let names = parse_ingredients("雞\u{feff}蛋");
    assert_eq!(names, ["雞 蛋"]);
    assert_eq!(ingredient_key(&names[0]), "雞蛋");

    let names = parse_ingredients("\u{85}雞蛋");
    assert_eq!(names, ["\u{85}雞蛋"]);
    assert!(names[0].starts_with('\u{85}'));
}

// ── 分類 ──

/// 來源：`tests/ingredients.test.js` 的 `ingredient parsing and classification` › `classifies %s as %s`，
/// 表格的每一列是一個案例。
#[test]
fn classify_ingredient_maps_each_name_to_its_category() {
    let cases: [(&str, &str); 47] = [
        ("牛肉片", "肉類"),
        ("豬五花", "肉類"),
        ("雞胸肉", "肉類"),
        ("香腸", "肉類"),
        ("培根", "肉類"),
        ("鮭魚", "海鮮"),
        ("白蝦", "海鮮"),
        ("蛤蜊", "海鮮"),
        ("花枝", "海鮮"),
        ("高麗菜", "蔬菜"),
        ("金針菇", "蔬菜"),
        ("地瓜葉", "蔬菜"),
        ("玉米", "蔬菜"),
        ("甜椒", "蔬菜"),
        ("辣椒", "蔬菜"),
        ("薑", "蔬菜"),
        ("毛豆", "蔬菜"),
        ("番茄", "蔬菜"),
        ("蘋果", "水果"),
        ("水果", "水果"),
        ("雞蛋", "蛋奶"),
        ("鮮奶", "蛋奶"),
        ("奶油", "蛋奶"),
        ("起司", "蛋奶"),
        ("板豆腐", "豆製品"),
        ("豆皮", "豆製品"),
        ("素雞", "豆製品"),
        ("吐司", "主食"),
        ("貝果", "主食"),
        ("白米", "主食"),
        ("義大利麵", "主食"),
        ("地瓜", "主食"),
        ("壽喜燒醬", "調味料"),
        ("雞粉", "調味料"),
        ("魚露醬", "調味料"),
        ("花生醬", "調味料"),
        ("辣椒粉", "調味料"),
        ("肉桂粉", "調味料"),
        ("咖啡豆", "飲料"),
        ("燕麥奶", "飲料"),
        ("蘋果汁", "飲料"),
        ("豆漿", "飲料"),
        ("棉花糖", "零食"),
        ("牛肉乾", "零食"),
        ("冰塊", "其他"),
        ("神秘食材", "其他"),
        // 現行以 Object.hasOwn() 查單字表，所以不會查到 Object.prototype.constructor
        ("constructor", "其他"),
    ];
    for (name, category) in cases {
        assert_eq!(
            classify_ingredient(name).as_str(),
            category,
            "classify_ingredient({name:?})"
        );
    }
}

/// 來源：`tests/ingredients.test.js` 的測試 `specific product classification: %s`，表格的每一列是一個案例。
#[test]
fn classify_ingredient_puts_specific_products_before_broad_food_names() {
    let cases: [(&str, &str); 13] = [
        ("茶葉蛋", "蛋奶"),
        ("蒜味香腸", "肉類"),
        ("薑母鴨", "肉類"),
        ("鹽酥雞", "肉類"),
        ("洋蔥豬肉", "肉類"),
        ("番茄牛腩", "肉類"),
        ("蒜蓉蝦", "海鮮"),
        ("吳郭魚", "海鮮"),
        ("蠔油", "調味料"),
        ("柳橙汁", "飲料"),
        ("蜂蜜蛋糕", "零食"),
        ("玉米片", "零食"),
        ("梅花豬", "肉類"),
    ];
    for (name, category) in cases {
        assert_eq!(
            classify_ingredient(name).as_str(),
            category,
            "classify_ingredient({name:?})"
        );
    }
}

/// 來源：`tests/ingredients.test.js` 的測試 `seasoning names remain recognizable: %s`，表格的每一列是一個案例。
#[test]
fn classify_ingredient_recognizes_seasoning_names() {
    let cases: [&str; 4] = ["醬油 1瓶", "醬油膏", "鹽 1包", "鹽麴"];
    for name in cases {
        assert_eq!(
            classify_ingredient(name).as_str(),
            "調味料",
            "classify_ingredient({name:?})"
        );
    }
}

/// 需求 33.10：現行規則中的 `\d` 只比對 ASCII 的 0–9，所以「鹽」加 U+0663（阿拉伯-印度數字 3）不符合 `^鹽(?:\d|$)`，
/// 也不符合其他規則，Bun_App 分類為「其他」。
#[test]
fn classify_ingredient_rule_digits_are_ascii_only() {
    assert_eq!(classify_ingredient("鹽\u{663}").as_str(), "其他");
}

// ── 採買同步 ──

/// 來源：`tests/ingredients.test.js` 的 `recipe-to-shopping synchronization` ›
/// `creates categorized entries with explicit unknown quantities and valid schema`。
#[test]
fn sync_creates_categorized_entries_with_unknown_quantities() {
    let mut state = recipe_state(&["牛肉片、高麗菜、雞蛋、板豆腐、醬油、鮮蝦、水果"]);
    assert_eq!(
        sync(&mut state, &mut SeqIds::new()),
        Synced {
            changed: true,
            added: 7,
            removed: 0
        }
    );
    let categories: Vec<&str> = state
        .shopping_by_ordinal()
        .map(|item| item.category.as_str())
        .collect();
    assert_eq!(
        categories,
        ["肉類", "蔬菜", "蛋奶", "豆製品", "調味料", "海鮮", "水果"]
    );
    assert!(state
        .shopping
        .values()
        .all(|item| item.quantity == "數量待確認" && !item.purchased && item.assignee.is_none()));
    assert_valid_shopping(&state);
}

/// 來源：`tests/ingredients.test.js` 的 `recipe-to-shopping synchronization` ›
/// `same names across meals stay one row and repeated sync is a no-op`。
#[test]
fn sync_keeps_one_row_per_name_across_meals_and_repeating_it_is_a_no_op() {
    let mut state = recipe_state(&["牛肉片、牛肉片、高麗菜", "高麗菜、牛肉片"]);
    let mut ids = SeqIds::new();
    sync(&mut state, &mut ids);
    let before = state.clone();
    assert_eq!(
        sync(&mut state, &mut ids),
        Synced {
            changed: false,
            added: 0,
            removed: 0
        }
    );
    assert_eq!(state, before);
    assert_eq!(state.shopping.len(), 2);
    assert_eq!(
        find(&state, "牛肉片").map(|item| &item.meal_ids),
        Some(&BTreeSet::from([recipe_meal(0), recipe_meal(1)]))
    );
}

/// 來源：`tests/ingredients.test.js` 的 `recipe-to-shopping synchronization` ›
/// `meal edits remove only unused generated entries; shared needs remain`。
#[test]
fn sync_removes_only_unused_generated_entries_after_meal_edits() {
    let mut state = recipe_state(&["牛肉片、高麗菜", "高麗菜"]);
    let mut ids = SeqIds::new();
    sync(&mut state, &mut ids);
    let cabbage_id = find(&state, "高麗菜").expect("同步新增了高麗菜").id;
    // state.meals[0].ingredients='白蝦'
    meal_mut(&mut state, recipe_meal(0)).ingredients = "白蝦".to_owned();
    sync(&mut state, &mut ids);
    assert!(find(&state, "牛肉片").is_none());
    let cabbage = find(&state, "高麗菜").expect("第二道料理仍需要高麗菜");
    assert_eq!(cabbage.id, cabbage_id);
    assert_eq!(cabbage.meal_ids, BTreeSet::from([recipe_meal(1)]));
    assert_eq!(
        find(&state, "白蝦").map(|item| item.category.as_str()),
        Some("海鮮")
    );
    // state.meals=[]
    state.meals.clear();
    sync(&mut state, &mut ids);
    assert!(state.shopping.is_empty());
    assert_valid_shopping(&state);
}

/// 來源：`tests/ingredients.test.js` 的 `recipe-to-shopping synchronization` ›
/// `purchased items, manual rows and user-edited auto rows survive removing meals`。
#[test]
fn sync_keeps_purchased_manual_and_user_edited_rows_when_meals_are_removed() {
    let mut state = recipe_state(&["牛肉片、雞蛋"]);
    let mut ids = SeqIds::new();
    sync(&mut state, &mut ids);
    find_mut(&mut state, "牛肉片").purchased = true;
    // Object.assign(find(state,'雞蛋'),{source:'manual',quantity:'2 盒',category:'其他',assignee:'p2'})
    let eggs = find_mut(&mut state, "雞蛋");
    eggs.source = ItemSource::Manual;
    eggs.quantity = "2 盒".to_owned();
    eggs.category = Category::Other;
    eggs.assignee = Some(person(2));
    // state.shopping.push({id:'manual',name:'冰塊',quantity:'2 袋',category:'其他',assignee:'p1',done:false})
    push_item(
        &mut state,
        written_item(
            test_item_id(1),
            "冰塊",
            "2 袋",
            Category::Other,
            Some(person(1)),
            false,
        ),
    );
    state.meals.clear();
    sync(&mut state, &mut ids);
    assert_eq!(state.shopping.len(), 3);
    assert_eq!(
        find(&state, "牛肉片").map(|item| item.purchased),
        Some(true)
    );
    let eggs = find(&state, "雞蛋").expect("雞蛋留下了");
    assert_eq!(
        (
            eggs.quantity.as_str(),
            eggs.category.as_str(),
            eggs.assignee,
            &eggs.meal_ids
        ),
        ("2 盒", "其他", Some(person(2)), &BTreeSet::new())
    );
    assert_valid_shopping(&state);
}

/// 來源：`tests/ingredients.test.js` 的 `recipe-to-shopping synchronization` ›
/// `existing/manual matched entries keep identity, quantity, category and buyer`。
#[test]
fn sync_keeps_identity_quantity_category_and_buyer_of_a_matching_row() {
    let mut state = recipe_state(&["雞蛋"]);
    // state.shopping=[{id:'existing',name:'雞 蛋',quantity:'3 盒',category:'其他',assignee:'p3',done:true}]
    push_item(
        &mut state,
        written_item(
            test_item_id(1),
            "雞 蛋",
            "3 盒",
            Category::Other,
            Some(person(3)),
            true,
        ),
    );
    let existing = state.shopping[&test_item_id(1)].clone();
    sync(&mut state, &mut SeqIds::new());
    let shopping: Vec<&ShoppingItem> = state.shopping_by_ordinal().collect();
    assert_eq!(
        shopping,
        [&ShoppingItem {
            meal_ids: BTreeSet::from([recipe_meal(0)]),
            ..existing
        }]
    );
}

/// 來源：`tests/ingredients.test.js` 的 `recipe-to-shopping synchronization` ›
/// `legacy combined rows cover each ingredient without duplicating their quantities`。
#[test]
fn sync_lets_combined_legacy_rows_cover_each_ingredient() {
    let mut state = seed();
    let old: Vec<ShoppingItem> = state.shopping_by_ordinal().cloned().collect();
    sync(&mut state, &mut SeqIds::new());
    let split_names = ["甜椒", "玉米", "吐司", "貝果"];
    assert_eq!(
        state
            .shopping
            .values()
            .filter(|item| split_names.contains(&item.name.as_str()))
            .count(),
        0
    );
    // toMatchObject(item)：現行品項的每個屬性都不變
    for item in &old {
        let after = state
            .shopping
            .get(&item.id)
            .unwrap_or_else(|| panic!("「{}」應該留下", item.name));
        assert_eq!(written_fields(after), written_fields(item));
    }
    assert_eq!(
        find(&state, "甜椒、玉米").map(|item| &item.meal_ids),
        Some(&BTreeSet::from([seed_meal(3)]))
    );
    assert_eq!(
        find(&state, "吐司、貝果").map(|item| &item.meal_ids),
        Some(&BTreeSet::from([seed_meal(2), seed_meal(4)]))
    );
    assert_eq!(
        find(&state, "壽喜燒醬").map(|item| item.category.as_str()),
        Some("調味料")
    );
    assert_valid_shopping(&state);
}

/// 來源：`tests/ingredients.test.js` 的 `recipe-to-shopping synchronization` ›
/// `clearing a recipe removes obsolete references and retains purchased entries`。
#[test]
fn sync_clearing_a_recipe_drops_references_and_keeps_purchased_rows() {
    let mut state = recipe_state(&["牛肉片、雞蛋"]);
    let mut ids = SeqIds::new();
    sync(&mut state, &mut ids);
    find_mut(&mut state, "雞蛋").purchased = true;
    // state.meals[0].ingredients=''
    meal_mut(&mut state, recipe_meal(0)).ingredients = String::new();
    sync(&mut state, &mut ids);
    assert_eq!(state.shopping.len(), 1);
    assert_eq!(
        find(&state, "雞蛋").map(|item| &item.meal_ids),
        Some(&BTreeSet::new())
    );
}

/// 來源：`tests/ingredients.test.js` 的 `recipe-to-shopping synchronization` ›
/// `capacity failure leaves original list untouched`。
#[test]
fn sync_over_capacity_leaves_the_list_untouched() {
    let mut state = recipe_state(&["new ingredient"]);
    // state.shopping=Array.from({length:1000},(_,i)=>({id:`s-${i}`,name:`manual-${i}`,quantity:'1',category:'其他',assignee:'',done:false}))
    for i in 0..1000 {
        push_item(
            &mut state,
            written_item(
                test_item_id(i + 1),
                &format!("manual-{i}"),
                "1",
                Category::Other,
                None,
                false,
            ),
        );
    }
    let before = state.clone();
    let error = sync_meal_ingredients(&state, &mut SeqIds::new())
        .expect_err("留下的 1000 項加上新增的 1 項超過上限");
    // 原測試的 toThrow('1,000')：錯誤訊息含有「1,000」
    assert!(error.to_string().contains("1,000"), "{error}");
    assert_eq!(state, before);
}

/// 來源：`tests/ingredients.test.js` 的測試 `a manual duplicate supersedes a generated row without losing details`。
#[test]
fn sync_lets_a_manual_duplicate_supersede_a_generated_row() {
    let mut state = recipe_state(&["雞蛋"]);
    let mut ids = SeqIds::new();
    sync(&mut state, &mut ids);
    // state.shopping.push({id:'manual',name:'雞蛋',quantity:'1 盒',category:'蛋奶',assignee:'p2',done:false,source:'manual'})
    push_item(
        &mut state,
        written_item(
            test_item_id(1),
            "雞蛋",
            "1 盒",
            Category::EggsDairy,
            Some(person(2)),
            false,
        ),
    );
    sync(&mut state, &mut ids);
    assert_eq!(state.shopping.len(), 1);
    let first = state.shopping_by_ordinal().next().expect("留下一個品項");
    assert_eq!(
        (first.id, first.quantity.as_str(), &first.meal_ids),
        (test_item_id(1), "1 盒", &BTreeSet::from([recipe_meal(0)]))
    );
}

/// 來源：`tests/ingredients.test.js` 的測試
/// `purchased orphans stay after being unchecked; manual orphans are visibly marked`。
#[test]
fn sync_keeps_purchased_orphans_after_unchecking_and_marks_manual_orphans() {
    let mut state = recipe_state(&["雞蛋、牛肉片"]);
    let mut ids = SeqIds::new();
    sync(&mut state, &mut ids);
    find_mut(&mut state, "雞蛋").purchased = true;
    find_mut(&mut state, "牛肉片").source = ItemSource::Manual;
    state.meals.clear();
    sync(&mut state, &mut ids);
    assert!(state
        .shopping
        .values()
        .all(|item| item.recipe_removed == Some(true)));
    find_mut(&mut state, "雞蛋").purchased = false;
    sync(&mut state, &mut ids);
    assert_eq!(state.shopping.len(), 2);
    assert_valid_shopping(&state);
}

/// 來源：`tests/ingredients.test.js` 的測試 `only one legacy duplicate is linked so the other remains removable`。
#[test]
fn sync_links_only_one_of_two_legacy_duplicates() {
    let mut state = recipe_state(&["雞蛋"]);
    // state.shopping=['one','two'].map(id=>({id,name:'雞蛋',quantity:'1 盒',category:'蛋奶',assignee:'',done:false}))
    for n in 1..=2 {
        push_item(
            &mut state,
            written_item(
                test_item_id(n),
                "雞蛋",
                "1 盒",
                Category::EggsDairy,
                None,
                false,
            ),
        );
    }
    sync(&mut state, &mut SeqIds::new());
    let linked: Vec<usize> = state
        .shopping_by_ordinal()
        .map(|item| item.meal_ids.len())
        .collect();
    assert_eq!(linked, [1, 0]);
}

// ── 從料理移除食材 ──

/// 需求 25.16：選定料理的食材文字去掉這個品項名稱切出的鍵，其餘依原順序以「、」串接，沒有選定的料理不變；品項是否保留
/// 由同一次提交的 Shopping_Sync 決定。`tests/ingredients.test.js` 沒有這類案例，所以依需求的例子寫成範例（見檔頭）。
#[test]
fn removing_an_ingredient_from_chosen_meals_leaves_the_item_to_shopping_sync() {
    // 需求 25.16 的例子
    assert_eq!(
        remove_ingredient("牛肉片, 板豆腐/高麗菜", "高麗菜"),
        "牛肉片、板豆腐"
    );

    // 兩道料理都需要高麗菜，只從第一道移除：第二道料理不變，仍需要高麗菜，所以採買同步留下品項，只連動第二道料理
    let mut state = recipe_state(&["牛肉片, 板豆腐/高麗菜", "高麗菜"]);
    let mut ids = SeqIds::new();
    sync(&mut state, &mut ids);
    let cabbage = find(&state, "高麗菜").expect("同步新增了高麗菜").id;
    remove_ingredient_from_meals(&mut state, "高麗菜", &BTreeSet::from([recipe_meal(0)]));
    assert_eq!(meal_texts(&state), ["牛肉片、板豆腐", "高麗菜"]);
    sync(&mut state, &mut ids);
    assert_eq!(
        state.shopping.get(&cabbage).map(|item| &item.meal_ids),
        Some(&BTreeSet::from([recipe_meal(1)]))
    );

    // 品項已買之後再從第二道料理移除：現行的 removeIngredientFromMeals() 這時直接刪除品項；第一版的採買同步保留已買
    // 的品項（需求 25.11–25.13），改為 Manual_Item 並標示「料理已移除」
    state
        .shopping
        .get_mut(&cabbage)
        .expect("高麗菜留下了")
        .purchased = true;
    remove_ingredient_from_meals(&mut state, "高麗菜", &BTreeSet::from([recipe_meal(1)]));
    assert_eq!(meal_texts(&state), ["牛肉片、板豆腐", ""]);
    sync(&mut state, &mut ids);
    let kept = state.shopping.get(&cabbage).expect("已買的品項留下了");
    assert_eq!(
        (
            kept.purchased,
            kept.source,
            kept.recipe_removed,
            kept.meal_ids.len()
        ),
        (true, ItemSource::Manual, Some(true), 0)
    );
}

// ── 現行測試的資料與輔助函式 ──

/// 現行 `syncMealIngredients(state)` 的回傳值。
#[derive(Debug, PartialEq, Eq)]
struct Synced {
    changed: bool,
    added: usize,
    removed: usize,
}

/// 現行的 `syncMealIngredients(state)`：執行採買同步並套用到 `state`。新增的 Meal_Item 與 LM_Server 提交時相同，依
/// `plan.created` 的順序取得 Ordinal（design A1），排在現行陣列的最後。回傳值的 `changed` 是計畫不是空的，也就是有
/// 品項被新增、修改或刪除；`added` 與 `removed` 是新增與刪除的品項數。
fn sync(state: &mut TripState, ids: &mut SeqIds) -> Synced {
    let plan = sync_meal_ingredients(state, ids).expect("採買品項沒有超過 1000 項");
    let first = next_ordinal(state);
    plan.apply_to(state);
    for (ordinal, item_id) in (first..).zip(&plan.created) {
        state
            .shopping
            .get_mut(item_id)
            .expect("同步新增的品項")
            .ordinal = ordinal;
    }
    Synced {
        changed: plan != SyncPlan::default(),
        added: plan.created.len(),
        removed: plan.deletes.len(),
    }
}

/// 原測試的 `expect(isValidState(state)).toBe(true)`。第一版的 State_Validator 是 `validate::state()`，資料格式也
/// 不同，所以這裡只檢查 `isValidState()` 對採買清單的條件中，`ShoppingItem` 的型別沒有保證的引用與數量：最多 1000 個
/// 品項、每個品項連動的料理都存在，以及負責人是旅伴或待分配（已買、分類、來源與「料理已移除」的格式，以及連動的料理
/// 不重複，都由型別保證）。採買同步只改採買清單，所以 `isValidState()` 對其他資料的檢查結果與同步之前相同。
fn assert_valid_shopping(state: &TripState) {
    assert!(
        state.shopping.len() <= SHOPPING_ITEMS_MAX,
        "採買品項有 {} 項",
        state.shopping.len()
    );
    for item in state.shopping.values() {
        assert!(
            item.meal_ids
                .iter()
                .all(|meal| state.meals.contains_key(meal)),
            "「{}」連動了不存在的料理：{:?}",
            item.name,
            item.meal_ids
        );
        assert!(
            item.assignee
                .is_none_or(|assignee| state.people.contains_key(&assignee)),
            "「{}」的負責人不是旅伴",
            item.name
        );
    }
}

/// 現行測試的 `seed()`（`src/model.js`）中採買同步用到的部分：旅行、6 位旅伴、4 道料理與 12 個採買品項，依現行陣列的
/// 順序加入。活動、裝備、車輛與動態不影響採買同步，不移植。
fn seed() -> TripState {
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
    // （日期, 餐次, 名稱, 負責人, 食材, 備註）；份數都是 6
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
        push_meal(
            &mut state,
            Meal {
                id: seed_meal(n),
                day: day(date),
                slot,
                time: None,
                title: title.to_owned(),
                cook: Some(person(cook)),
                servings: 6,
                ingredients: ingredients.to_owned(),
                notes: notes.to_owned(),
                dish: None,
                ordinal: 0,
                version: 0,
            },
        );
    }
    // （名稱, 數量, 分類, 負責人, 已買）
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
        push_item(
            &mut state,
            written_item(
                seed_item(n),
                name,
                quantity,
                category,
                assignee.map(person),
                purchased,
            ),
        );
    }
    state
}

/// 現行測試的 `recipeState(...ingredients)`：`seed()` 的採買清單清空，料理換成每段食材文字各一道 `meal-{i}`，其他欄位
/// 與 `seed()` 的第一道料理相同；料理依參數的順序取得 Ordinal。
fn recipe_state(ingredients: &[&str]) -> TripState {
    let mut state = seed();
    let first = state.meals[&seed_meal(1)].clone();
    state.shopping.clear();
    state.meals.clear();
    for (i, text) in (0..).zip(ingredients) {
        push_meal(
            &mut state,
            Meal {
                id: recipe_meal(i),
                ingredients: (*text).to_owned(),
                ..first.clone()
            },
        );
    }
    state
}

/// 現行測試直接寫入採買清單的品項 `{id, name, quantity, category, assignee, done}`：沒有 `source` 屬性，或是
/// `source: 'manual'`，在 `syncMealIngredients()` 中兩者相同，所以是 Manual_Item；還沒有連動料理，也沒有「料理已移除」
/// 標記。Ordinal 由 `push_item()` 指定。
fn written_item(
    item_id: ShoppingId,
    name: &str,
    quantity: &str,
    category: Category,
    assignee: Option<PersonId>,
    purchased: bool,
) -> ShoppingItem {
    ShoppingItem {
        id: item_id,
        name: name.to_owned(),
        quantity: quantity.to_owned(),
        category,
        assignee,
        purchased,
        source: ItemSource::Manual,
        meal_ids: BTreeSet::new(),
        recipe_removed: None,
        ordinal: 0,
        version: 0,
    }
}

/// 現行品項寫入的屬性（`id` 之外）：名稱、數量、分類、負責人與已買（`done`）。`toMatchObject(item)` 比較的就是這些
/// 屬性；第一版另有的來源、連動的料理與「料理已移除」不在其中。
fn written_fields(item: &ShoppingItem) -> (&str, &str, Category, Option<PersonId>, bool) {
    (
        &item.name,
        &item.quantity,
        item.category,
        item.assignee,
        item.purchased,
    )
}

/// 下一列的 Ordinal：目前最大的 Ordinal 加 1，與 LM_Server 為新列指定的 Ordinal 相同（design A1）。所以依序加入的列
/// 依現行陣列的順序排列，之後加入的列排在最後。
fn next_ordinal(state: &TripState) -> u64 {
    state.max_ordinal() + 1
}

/// 依現行陣列的順序加入料理，Ordinal 是 `next_ordinal()`。
fn push_meal(state: &mut TripState, meal: Meal) {
    let ordinal = next_ordinal(state);
    state.put(Row::Meal(Meal { ordinal, ..meal }));
}

/// 依現行陣列的順序加入採買品項（現行的 `push()`），Ordinal 是 `next_ordinal()`。
fn push_item(state: &mut TripState, item: ShoppingItem) {
    let ordinal = next_ordinal(state);
    state.put(Row::Shopping(ShoppingItem { ordinal, ..item }));
}

/// 現行測試的 `find(state, name)`：依 Ordinal 第一個名稱是 `name` 的品項。
fn find<'a>(state: &'a TripState, name: &str) -> Option<&'a ShoppingItem> {
    state.shopping_by_ordinal().find(|item| item.name == name)
}

/// `find()` 找到的品項，可以修改；現行測試直接修改 `find()` 回傳的物件。
fn find_mut<'a>(state: &'a mut TripState, name: &str) -> &'a mut ShoppingItem {
    let item_id = find(state, name)
        .unwrap_or_else(|| panic!("清單中應該有「{name}」"))
        .id;
    state.shopping.get_mut(&item_id).expect("剛找到的品項")
}

/// 可以修改的料理 `meal_id`。
fn meal_mut(state: &mut TripState, meal_id: MealId) -> &mut Meal {
    state.meals.get_mut(&meal_id).expect("料理存在")
}

/// 每道料理的食材文字，依 Ordinal。
fn meal_texts(state: &TripState) -> Vec<&str> {
    state
        .meals_by_ordinal()
        .map(|meal| meal.ingredients.as_str())
        .collect()
}

/// 現行的旅伴 `p{n}`（`seed()` 的 6 位旅伴，n 為 1–6）。
fn person(n: u64) -> PersonId {
    id(Tag::Person, n)
}

/// `seed()` 的料理 `m{n}`（n 為 1–4）。
fn seed_meal(n: u64) -> MealId {
    id(Tag::Meal, n)
}

/// `recipeState()` 的料理 `meal-{i}`（i 從 0 起）；序號是 0x100 + i，所以與 `seed_meal()` 不重複。
fn recipe_meal(i: u64) -> MealId {
    id(Tag::Meal, 0x100 + i)
}

/// `seed()` 的採買品項 `s{n}`（n 為 1–12）。
fn seed_item(n: u64) -> ShoppingId {
    id(Tag::Shopping, n)
}

/// 測試直接寫入採買清單的第 n 個品項（n 從 1 起，例如 `existing`、`manual`、`one`、`two`、`s-{n - 1}`）；序號是
/// 0x100 + n，所以與 `seed_item()` 不重複。
fn test_item_id(n: u64) -> ShoppingId {
    id(Tag::Shopping, 0x100 + n)
}

fn day(text: &str) -> Date {
    lm_core::time::parse_date(text).expect("有效的日期")
}
