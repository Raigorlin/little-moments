//! 食材與採買同步：`parse_ingredients`、`ingredient_key`、`classify_ingredient`、
//! `sync_meal_ingredients` 與 `remove_ingredient_from_meals`。
//!
//! 移植自 `src/ingredients.js` 的 `parseIngredients()`、`keyOf()`、`classifyIngredient()`、`syncMealIngredients()` 與
//! `removeIngredientFromMeals()`。Ingredient_Parser 與 Ingredient_Key 的空白是 JS_Whitespace（`text::is_js_whitespace()`：
//! U+FEFF 算空白，U+0085 不算），Ingredient_Parser 與 Ingredient_Classifier 的數字只有 ASCII 的 0–9，與現行 JavaScript 的
//! `\s`、`trim()` 與 `\d` 相同（需求 33.10）。

use std::collections::{BTreeSet, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use unicode_normalization::UnicodeNormalization;

use crate::ids::MealId;
use crate::limits::INGREDIENT_NAME_CHARS;
use crate::model::{Category, TripState};
use crate::text::{char_count, collapse_js_whitespace, is_js_whitespace};

/// 採買分類，依現行 `SHOPPING_CATEGORIES` 的順序：肉類、海鮮、蔬菜、水果、蛋奶、豆製品、主食、調味料、飲料、零食、其他。
/// 採買清單依這個順序分組；與 `Category::ALL` 相同。
pub const SHOPPING_CATEGORIES: &[Category] = Category::ALL;

/// Ingredient_Parser（現行 `parseIngredients()`，需求 25.3、25.4）：從食材文字切出食材名稱。
///
/// 1. 整段文字先做 NFKC，所以全形的「，」「；」「／」「．」成為半形的「,」「;」「/」「.」，U+FF64「､」與
///    U+FF61「｡」成為「、」「。」。
/// 2. 逐字掃描：「、」「;」「/」「。」、CR 與 LF 一律切開，在兩個數字之間也切開（「1/2 顆洋蔥」切出「1」「2 顆洋蔥」）；
///    半形「,」與「.」只在整段文字中前一個與後一個字元都是 ASCII 數字 0–9 時保留（1.5、1,000），其他情況一律切開，
///    包括位在開頭或結尾。現行以含 lookbehind 與 lookahead 的 regex 切分，Rust 的 `regex` 不支援，所以逐字判斷。
/// 3. 每一段再做一次 NFKC（與現行相同），去除前後的 JS_Whitespace，把內部連續的 JS_Whitespace 換成一個半形空格，
///    並捨棄變成空字串的段落。
/// 4. 以 Ingredient_Key 去除重複：每個鍵只保留第一次出現的名稱，並保持第一次出現的順序。
///
/// 例如「牛奶 1.5L/白米 1,000g.雞蛋」切出「牛奶 1.5L」「白米 1,000g」「雞蛋」，「雞 蛋、雞蛋、 ＡＢＣ , abc」切出
/// 「雞 蛋」「ABC」；空字串與只有分隔符號和空白的文字切出空的清單。切出的名稱以「、」串接後再切一次，得到相同的
/// 名稱與順序（需求 25.5）。
pub fn parse_ingredients(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.nfkc().collect();
    let mut parts = Vec::new();
    let mut part = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if splits_at(&chars, i) {
            parts.push(std::mem::take(&mut part));
        } else {
            part.push(c);
        }
    }
    parts.push(part);

    let mut seen = HashSet::new();
    parts
        .iter()
        .map(|part| collapse_js_whitespace(&part.nfkc().collect::<String>()))
        .filter(|name| !name.is_empty() && seen.insert(ingredient_key(name)))
        .collect()
}

/// Ingredient_Key（現行 `keyOf()`）：比較食材名稱的鍵。NFKC、移除所有 JS_Whitespace，再轉成小寫；
/// 例如「雞 蛋」與「雞蛋」、「ＡＢＣ」與「abc」的鍵相同。U+FEFF 是 JS_Whitespace 所以移除，U+0085 不是所以保留。
pub fn ingredient_key(name: &str) -> String {
    // 現行以 toLocaleLowerCase('zh-TW') 轉小寫；zh-TW 沒有語系專屬的對應，等於 Unicode 預設的轉換（包括字尾的 Σ）
    name.nfkc()
        .filter(|&c| !is_js_whitespace(c))
        .collect::<String>()
        .to_lowercase()
}

/// Ingredient_Classifier（現行 `classifyIngredient()`，需求 25.17）：依名稱的 Ingredient_Key 決定 11 種採買分類之一。
/// 先比對完全相同的單字表（肉、雞、豬、牛為肉類；魚為海鮮；蛋、奶為蛋奶；米、麵為主食；水、茶為飲料；鹽、糖、油為
/// 調味料；蔬菜為蔬菜），再依序比對規則表、採用第一條符合的規則，都不符合時為「其他」。
/// 例如「雞粉」為調味料（調味料的規則在肉類之前）、「茶葉蛋」為蛋奶、「地瓜」為主食、「地瓜葉」為蔬菜、「冰塊」為其他。
pub fn classify_ingredient(name: &str) -> Category {
    let key = ingredient_key(name);
    if let Some(&(_, category)) = EXACT.iter().find(|(word, _)| *word == key) {
        return category;
    }
    RULE_REGEXES
        .iter()
        .find(|(_, rule)| rule.is_match(&key))
        .map_or(Category::Other, |&(category, _)| category)
}

/// Ingredient_Parser 切出的食材名稱超過 100 字（需求 25.18）。`Display` 是給使用者看的訊息。
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("每項食材最多 100 字，請用頓號或換行分隔不同的食材。")]
pub struct IngredientTooLong;

/// 需求 25.18：Ingredient_Parser 從料理的食材文字切出的每個名稱都在 `INGREDIENT_NAME_CHARS`（1–100 字）之內，
/// 字數是 NFKC 與整理空白之後的 Char_Count；恰好 100 字時接受。
/// 新增或修改料理時，這一項在食材文字的 2,000 字上限之後、備註的上限之前檢查（需求 24.2）。
pub fn check_ingredient_names(ingredients: &str) -> Result<(), IngredientTooLong> {
    if parse_ingredients(ingredients)
        .iter()
        .all(|name| INGREDIENT_NAME_CHARS.contains(&char_count(name)))
    {
        Ok(())
    } else {
        Err(IngredientTooLong)
    }
}

/// 需求 25.16：料理的食材文字 `ingredients` 移除採買品項 `item_name` 之後的文字，也就是現行
/// `removeIngredientFromMeals()` 對每道選定料理的處理：Ingredient_Parser 切出的名稱中，去掉 Ingredient_Key 屬於
/// `item_name` 切出之鍵的名稱，其餘依原順序以「、」串接。例如「牛肉片, 板豆腐/高麗菜」移除「高麗菜」後為
/// 「牛肉片、板豆腐」；品項「甜椒、玉米」同時移除「甜椒」與「玉米」。沒有移除任何名稱時，結果仍是切出的名稱以「、」
/// 串接的文字。
pub fn remove_ingredient(ingredients: &str, item_name: &str) -> String {
    without_keys(ingredients, &keys_of(item_name))
}

/// `RemoveIngredientFromMeals` 的主要效果（需求 25.16）：把 `meals` 中每道料理的食材文字換成 `remove_ingredient()` 的
/// 結果，依呼叫當下 `state` 中的食材文字計算，也就是 LM_Server 提交當下的文字；沒有選定的料理不變，`meals` 中不在
/// `state` 的 id 略過。品項不存在、沒有選定料理與選定的料理不存在的拒絕（需求 25.20）由命令的處理函式在呼叫之前檢查。
///
/// 這裡只改料理的食材文字，不刪除採買品項：品項是否保留由同一次提交的 Shopping_Sync 決定，所以手動與已買的品項會留下。
/// 現行在沒有任何料理需要這個品項時直接刪除它，不論來源與是否已買。
pub fn remove_ingredient_from_meals(
    state: &mut TripState,
    item_name: &str,
    meals: &BTreeSet<MealId>,
) {
    let keys = keys_of(item_name);
    for id in meals {
        if let Some(meal) = state.meals.get_mut(id) {
            meal.ingredients = without_keys(&meal.ingredients, &keys);
        }
    }
}

/// 整段文字 NFKC 之後的 `chars[i]` 是否切開食材（現行 `/[、，;；\/。\r\n]+|(?<!\d)[,.]|[,.](?!\d)/u`；
/// 全形的「，」「；」在 NFKC 之後已是半形，`\d` 只比對 ASCII 的 0–9）。
fn splits_at(chars: &[char], i: usize) -> bool {
    match chars[i] {
        '、' | ';' | '/' | '。' | '\r' | '\n' => true,
        ',' | '.' => {
            let digit_before = i > 0 && chars[i - 1].is_ascii_digit();
            let digit_after = chars.get(i + 1).is_some_and(char::is_ascii_digit);
            !(digit_before && digit_after)
        }
        _ => false,
    }
}

/// 名稱切出的每個 Ingredient_Key。
fn keys_of(name: &str) -> HashSet<String> {
    parse_ingredients(name)
        .iter()
        .map(|part| ingredient_key(part))
        .collect()
}

/// `ingredients` 切出的名稱中，去掉 Ingredient_Key 屬於 `keys` 的名稱，其餘依原順序以「、」串接。
fn without_keys(ingredients: &str, keys: &HashSet<String>) -> String {
    parse_ingredients(ingredients)
        .into_iter()
        .filter(|name| !keys.contains(&ingredient_key(name)))
        .collect::<Vec<_>>()
        .join("、")
}

/// 現行 `exact`：Ingredient_Key 與單字完全相同時的分類，比規則表先比對。
const EXACT: [(&str, Category); 15] = [
    ("肉", Category::Meat),
    ("雞", Category::Meat),
    ("豬", Category::Meat),
    ("牛", Category::Meat),
    ("魚", Category::Seafood),
    ("蛋", Category::EggsDairy),
    ("奶", Category::EggsDairy),
    ("米", Category::Staples),
    ("麵", Category::Staples),
    ("水", Category::Drinks),
    ("茶", Category::Drinks),
    ("鹽", Category::Seasoning),
    ("糖", Category::Seasoning),
    ("油", Category::Seasoning),
    ("蔬菜", Category::Vegetables),
];

/// 現行 `rules`，順序相同：較特定的商品在前，例如「雞粉」是調味料而不是肉類；比對的對象是 Ingredient_Key。
/// 寫法與現行只有三處不同，比對的結果相同：Rust 的 `regex` 不支援 lookahead，所以 `地瓜(?!葉)` 改寫成等價的
/// `地瓜(?:[^葉]|$)`；`regex` 的 `\d` 是 Unicode 的十進位數字、`\s` 是 Unicode White_Space，所以 `\d` 改寫成 `[0-9]`、
/// `\s` 改寫成 JS_Whitespace 的字元（U+0009–U+000D、U+0020、U+00A0、U+1680、U+2000–U+200A、U+2028、U+2029、
/// U+202F、U+205F、U+3000 與 U+FEFF）。例如「鹽」加 U+0663 不符合 `^鹽(?:[0-9]|$)`，分類為「其他」。
const RULES: [(Category, &str); 15] = [
    (Category::Snacks, "玉米片|蛋糕"),
    (Category::EggsDairy, "茶葉蛋"),
    (
        Category::Meat,
        "(?:蒜味|蒜香)香腸|薑母鴨|鹽酥雞|麻油雞|醬燒雞腿",
    ),
    (
        Category::Seasoning,
        r"醬油|鹽麴|^鹽(?:[0-9]|$)|醬(?:油|汁|料|包)?$|醬[0-9\x{9}-\x{d}\x{20}\x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]|魚露|蠔油|醋|鹽(?:巴|粒)?$|胡椒|香料|調味|咖哩粉|咖哩塊|雞粉|雞精粉|高湯|湯底|味醂|米酒|料酒|味噌|芥末|孜然|八角|肉桂|橄欖油|沙拉油|食用油|麻油|香油|砂糖|冰糖|黑糖|紅糖|白糖|蜂蜜|辣油|辣粉|辣椒粉|辣椒油|味精|柴魚粉",
    ),
    (
        Category::Snacks,
        "棉花糖|餅乾|洋芋片|薯片|爆米花|巧克力|糖果|布丁|果凍|冰淇淋|堅果|瓜子|花生糖|鳳梨酥|蛋捲|肉乾|魚酥",
    ),
    (
        Category::Drinks,
        "豆漿|米漿|燕麥奶|椰奶|杏仁奶|奶茶|咖啡|可可粉|茶葉|紅茶|綠茶|烏龍茶|汽水|氣泡水|飲用水|礦泉水|果汁|柳橙汁|啤酒|紅酒|白酒|運動飲料",
    ),
    (
        Category::Soy,
        "豆腐|豆乾|豆干|豆皮|腐竹|素肉|素雞|素鴨|百頁|百葉豆腐",
    ),
    (
        Category::Staples,
        "吐司|土司|貝果|麵包|饅頭|烏龍麵|泡麵|拉麵|義大利麵|冬粉|米粉|米線|麵條|麵粉|餃子皮|餃皮|水餃|餛飩|年糕|白米|糙米|糯米|燕麥|麥片|白飯|米飯|地瓜(?:[^葉]|$)|馬鈴薯|餅皮",
    ),
    (
        Category::EggsDairy,
        "雞蛋|鴨蛋|鵪鶉蛋|皮蛋|鹹蛋|牛奶|鮮奶|奶油|起司|乳酪|優格|優酪乳|煉乳|蛋液|奶粉",
    ),
    (Category::Meat, "(?:洋蔥|番茄)豬肉|番茄牛腩"),
    (Category::Seafood, "蒜蓉蝦"),
    (
        Category::Vegetables,
        "高麗菜|白菜|青江菜|小松菜|空心菜|菠菜|花椰菜|青花菜|地瓜葉|大陸妹|萵苣|茼蒿|芥藍|油菜|娃娃菜|包心菜|水蓮|菇|木耳|洋蔥|青蔥|大蔥|蒜|薑|韭菜|芹菜|香菜|九層塔|羅勒|薄荷|玉米|甜椒|青椒|彩椒|辣椒|番茄|蕃茄|茄子|小黃瓜|大黃瓜|櫛瓜|絲瓜|苦瓜|南瓜|冬瓜|胡蘿蔔|紅蘿蔔|白蘿蔔|筍|竹筍|蘆筍|蓮藕|芋頭|秋葵|豆芽|毛豆|豌豆|四季豆|荷蘭豆|甜豆|花生|海帶|紫菜|海苔",
    ),
    (
        Category::Fruit,
        "水果|蘋果|香蕉|芭樂|鳳梨|奇異果|柳丁|橘子|橙子|葡萄|草莓|藍莓|西瓜|哈密瓜|香瓜|木瓜|芒果|水蜜桃|百香果|火龍果|檸檬|柚子|酪梨|櫻桃|荔枝|龍眼|蓮霧|梨子|水梨",
    ),
    (
        Category::Seafood,
        "吳郭魚|鮭魚|鯖魚|鱈魚|鯛魚|鮪魚|秋刀魚|虱目魚|鱸魚|魚片|魚排|魚丸|魚板|蝦|蟹|蛤蜊|蛤蠣|蛤仔|扇貝|干貝|蛎|牡蠣|蚵|透抽|小卷|中卷|花枝|魷魚|章魚|海鮮",
    ),
    (
        Category::Meat,
        "牛肉|牛排|牛腩|牛肋|牛五花|豬肉|豬排|豬五花|豬梅花|豬里肌|豬絞肉|雞肉|雞腿|雞胸|雞翅|雞柳|全雞|鴨肉|鴨胸|鴨腿|羊肉|羊排|培根|香腸|火腿|熱狗|貢丸|肉丸|絞肉|排骨|五花肉|里肌肉|梅花肉|梅花豬|肉片",
    ),
];

/// 編譯好的 `RULES`，順序相同。
static RULE_REGEXES: LazyLock<Vec<(Category, Regex)>> = LazyLock::new(|| {
    RULES
        .iter()
        .map(|&(category, rule)| (category, Regex::new(rule).expect("規則表的寫法固定不變")))
        .collect()
});

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;
    use crate::ids::TripId;
    use crate::model::{CoverKind, Date, Meal, MealSlot, TripCard, TripStatus};

    #[test]
    fn parse_splits_on_separators_and_keeps_numbers_with_ascii_digits_on_both_sides() {
        // 需求 25.3 的例子
        assert_eq!(
            parse_ingredients("牛奶 1.5L/白米 1,000g.雞蛋"),
            ["牛奶 1.5L", "白米 1,000g", "雞蛋"]
        );
        assert_eq!(parse_ingredients("牛肉､豬肉"), ["牛肉", "豬肉"]);
        assert_eq!(parse_ingredients("１，０００g 麵粉"), ["1,000g 麵粉"]);
        assert_eq!(parse_ingredients("1/2 顆洋蔥"), ["1", "2 顆洋蔥"]);
        // 「、」「;」「/」「。」、CR 與 LF 在數字之間也切開
        assert_eq!(
            parse_ingredients("1、2;3/4。5\r6\n7"),
            ["1", "2", "3", "4", "5", "6", "7"]
        );
        // 「,」「.」位在開頭或結尾，或只有一邊是數字時切開
        assert_eq!(parse_ingredients(".5 杯米,2."), ["5 杯米", "2"]);
        assert_eq!(parse_ingredients("1,a.2"), ["1", "a", "2"]);
        // 數字只有 ASCII 的 0–9；U+0661、U+0662 是阿拉伯-印度數字，NFKC 不改變它們
        assert_eq!(parse_ingredients("\u{661}.\u{662}"), ["\u{661}", "\u{662}"]);
        // 全形數字與全形句點在 NFKC 之後是 ASCII
        assert_eq!(parse_ingredients("糖 １．５ 匙"), ["糖 1.5 匙"]);
    }

    #[test]
    fn parse_tidies_js_whitespace_and_keeps_the_first_name_of_each_key() {
        // 需求 25.4 的例子
        assert_eq!(
            parse_ingredients("雞 蛋、雞蛋、 ＡＢＣ , abc"),
            ["雞 蛋", "ABC"]
        );
        for text in ["", "、 , ，；", " /、.,。／． ", "\u{3000}\u{feff}\t"] {
            assert!(parse_ingredients(text).is_empty(), "{text:?}");
        }
        // 需求 33.10：U+FEFF 是 JS_Whitespace，U+0085 不是
        assert_eq!(parse_ingredients("\u{feff}雞蛋"), ["雞蛋"]);
        assert_eq!(parse_ingredients("雞\u{feff}蛋"), ["雞 蛋"]);
        assert_eq!(parse_ingredients("\u{85}雞蛋"), ["\u{85}雞蛋"]);
        // U+2028 與 Tab 不切開食材，是名稱中的空白
        assert_eq!(parse_ingredients("牛\u{2028}肉\t\t片"), ["牛 肉 片"]);
    }

    #[test]
    fn parse_again_after_joining_with_ideographic_commas_gives_the_same_names() {
        // 需求 25.5
        for text in [
            "牛奶 1.5L/白米 1,000g.雞蛋",
            "雞 蛋、雞蛋、 ＡＢＣ , abc",
            "1/2 顆洋蔥",
            "１，０００g 麵粉。\u{85}鹽\u{feff}、1.,2",
        ] {
            let names = parse_ingredients(text);
            assert_eq!(parse_ingredients(&names.join("、")), names, "{text:?}");
        }
    }

    #[test]
    fn ingredient_key_ignores_js_whitespace_width_and_case() {
        assert_eq!(ingredient_key("雞 蛋"), "雞蛋");
        assert_eq!(ingredient_key(" ＡＢＣ\u{3000}"), "abc");
        // 需求 33.10
        assert_eq!(ingredient_key("雞\u{feff}蛋"), "雞蛋");
        assert_eq!(ingredient_key("\u{85}雞蛋"), "\u{85}雞蛋");
    }

    #[test]
    fn classify_matches_exact_words_then_the_first_matching_rule() {
        for (name, category) in [
            // 需求 25.17 的例子
            ("雞粉", Category::Seasoning),
            ("茶葉蛋", Category::EggsDairy),
            ("地瓜", Category::Staples),
            ("地瓜葉", Category::Vegetables),
            ("冰塊", Category::Other),
            // 單字表比對整個 Ingredient_Key
            ("雞", Category::Meat),
            (" 蔬 菜 ", Category::Vegetables),
            ("雞雞", Category::Other),
            // 地瓜(?!葉)
            ("地瓜球", Category::Staples),
            ("地瓜葉地瓜", Category::Staples),
            // ^鹽(?:\d|$) 與 醬[\d\s] 的數字只有 ASCII 的 0–9；全形數字在 NFKC 之後是 ASCII（需求 33.10）
            ("鹽 1包", Category::Seasoning),
            ("鹽１", Category::Seasoning),
            ("鹽\u{663}", Category::Other),
            ("醬 1", Category::Seasoning),
            ("醬\u{663}", Category::Other),
        ] {
            assert_eq!(classify_ingredient(name), category, "{name:?}");
        }
    }

    #[test]
    fn sauce_followed_by_ascii_digit_or_js_whitespace_is_seasoning() {
        // `醬[\d\s]` 改寫成 `醬[0-9…]`，字元類別是 ASCII 數字與 JS_Whitespace。Ingredient_Key 不含空白，所以實際上只會
        // 比對到數字，但規則本身與現行相同。「醬」後面接油、汁、料、包、醬、醋、鹽時，也符合同一條規則的其他寫法
        // （`醬油`、`醬(?:油|汁|料|包)?$`、`醋`、`鹽(?:巴|粒)?$`）。
        let (_, rule) = RULE_REGEXES
            .iter()
            .find(|(category, _)| *category == Category::Seasoning)
            .expect("規則表有調味料");
        for c in (0..=0xffff).filter_map(char::from_u32) {
            let expected =
                c.is_ascii_digit() || is_js_whitespace(c) || "油汁料包醬醋鹽".contains(c);
            assert_eq!(rule.is_match(&format!("醬{c}")), expected, "{c:?}");
        }
    }

    #[test]
    fn rules_and_categories_keep_the_current_order() {
        let order: Vec<&str> = RULE_REGEXES
            .iter()
            .map(|(category, _)| category.as_str())
            .collect();
        assert_eq!(
            order.join(" "),
            "零食 蛋奶 肉類 調味料 零食 飲料 豆製品 主食 蛋奶 肉類 海鮮 蔬菜 水果 海鮮 肉類"
        );
        let categories: Vec<&str> = SHOPPING_CATEGORIES.iter().map(Category::as_str).collect();
        assert_eq!(
            categories.join(" "),
            "肉類 海鮮 蔬菜 水果 蛋奶 豆製品 主食 調味料 飲料 零食 其他"
        );
    }

    #[test]
    fn each_parsed_ingredient_has_at_most_100_chars() {
        // 需求 25.18：以 Ingredient_Parser 切出的名稱計算，恰好 100 字時接受
        assert_eq!(check_ingredient_names(""), Ok(()));
        assert_eq!(check_ingredient_names(&"蛋".repeat(100)), Ok(()));
        assert_eq!(
            check_ingredient_names(&"蛋".repeat(101)),
            Err(IngredientTooLong)
        );
        let two = format!("{}、{}", "蛋".repeat(100), "米".repeat(100));
        assert_eq!(check_ingredient_names(&two), Ok(()));
        // 先整理空白再計算：50 + 1 + 49 字
        let spaced = format!("  {}  {}  ", "蛋".repeat(50), "米".repeat(49));
        assert_eq!(check_ingredient_names(&spaced), Ok(()));
        // NFKC 之後的字數：「㎏」是「kg」
        assert_eq!(check_ingredient_names(&"㎏".repeat(50)), Ok(()));
        assert_eq!(
            check_ingredient_names(&"㎏".repeat(51)),
            Err(IngredientTooLong)
        );
        assert_eq!(
            IngredientTooLong.to_string(),
            "每項食材最多 100 字，請用頓號或換行分隔不同的食材。"
        );
    }

    #[test]
    fn remove_ingredient_drops_every_key_of_the_item_name() {
        // 需求 25.16 的例子
        assert_eq!(
            remove_ingredient("牛肉片, 板豆腐/高麗菜", "高麗菜"),
            "牛肉片、板豆腐"
        );
        // 以 Ingredient_Key 比較；合併的品項名稱切出的每個鍵都移除
        assert_eq!(
            remove_ingredient("雞 蛋、甜椒/玉米、吐司", "甜椒、玉米"),
            "雞 蛋、吐司"
        );
        assert_eq!(remove_ingredient("雞 蛋、吐司", "ＴＯＡＳＴ、雞蛋"), "吐司");
        // 沒有移除任何名稱時仍以「、」重新串接
        assert_eq!(
            remove_ingredient(" 牛肉片 ,板豆腐", "高麗菜"),
            "牛肉片、板豆腐"
        );
        assert_eq!(remove_ingredient("高麗菜", "高麗菜"), "");
    }

    #[test]
    fn remove_ingredient_from_meals_changes_only_the_chosen_meals() {
        let mut state = trip_with([
            meal(1, "牛肉片、高麗菜"),
            meal(2, "高麗菜/雞蛋"),
            meal(3, "高麗菜"),
        ]);
        // 不在旅行中的 id 略過
        let chosen = BTreeSet::from([meal_id(1), meal_id(2), meal_id(9)]);
        remove_ingredient_from_meals(&mut state, "高麗菜", &chosen);
        // 只改選定料理的食材文字，其他欄位與沒有選定的料理不變
        assert_eq!(
            state,
            trip_with([meal(1, "牛肉片"), meal(2, "雞蛋"), meal(3, "高麗菜")])
        );
    }

    fn trip_with<const N: usize>(meals: [Meal; N]) -> TripState {
        let mut state = TripState::new(card());
        state.meals.extend(meals.map(|meal| (meal.id, meal)));
        state
    }

    fn meal_id(n: u64) -> MealId {
        MealId(Uuid::from_u128(u128::from(n)))
    }

    fn meal(n: u64, ingredients: &str) -> Meal {
        Meal {
            id: meal_id(n),
            day: day(),
            slot: MealSlot::Dinner,
            time: None,
            title: format!("料理 {n}"),
            cook: None,
            servings: 4,
            ingredients: ingredients.to_owned(),
            notes: String::new(),
            dish: None,
            ordinal: n,
            version: n,
        }
    }

    fn day() -> Date {
        "2026-11-20".parse().expect("有效的日期")
    }

    fn card() -> TripCard {
        TripCard {
            id: TripId(Uuid::from_u128(1)),
            title: "雲海裡，住一晚".to_owned(),
            destination: String::new(),
            start: day(),
            end: day(),
            description: String::new(),
            note: String::new(),
            cover: CoverKind::Camp,
            status: TripStatus::Planning,
            version: 0,
        }
    }
}
