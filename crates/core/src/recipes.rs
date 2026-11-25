//! 料理範本、常用食材捷徑、插圖種類推斷、餐次順序與常用裝備建議：`RECIPE_TEMPLATES`、`COMMON_INGREDIENTS`、
//! `merge_ingredients`、`apply_recipe_template`、`infer_dish_kind`、`MEAL_SLOTS`、`group_meals_by_date` 與
//! `PERSONAL_GEAR_GROUPS`。
//!
//! 移植自 `src/recipes.js`、`src/meal-order.js` 與 `src/gear-presets.js`；範本、捷徑與裝備建議的文字與現行逐字相同
//! （需求 24.4）。料理表單的範本與常用食材捷徑只改表單的草稿，使用者儲存表單之前不送出 Command（需求 24.11）：
//! 這裡判斷套用範本之前要不要詢問、算出新的草稿，並在合併後的食材超過 2,000 字時回傳錯誤，草稿因此不變；詢問的
//! 對話框與錯誤訊息由 LM_Web 顯示。
//!
//! 依 requirements.md 與現行不同之處：
//! - 合併後的食材以 Char_Count 計算，上限是 2,000 字（需求 24.11）；現行是 500 個 UTF-16 單位，訊息也寫 500 字。
//! - 捷徑是否已選取以 Ingredient_Key 比較（需求 24.4）；現行比較切出的名稱是否完全相同，所以「雞 蛋」不算選了「雞蛋」。
//! - 套用範本之前，名稱與筆記是否空白以 Trim_White 判斷（需求 24.11）；現行以 JavaScript 的 `trim()`，所以只有
//!   U+FEFF 的名稱現行不詢問、這裡詢問，只有 U+0085 的名稱則相反。
//! - 餐次是只有五個值的 `MealSlot`（需求 24.2 拒絕其他值，第一版也不匯入現行的資料），所以不移植現行為舊資料保留的
//!   別名（早、午、晚、宵夜）、排在五種之後的自訂餐次，以及保留舊餐次的表單選項 `mealSlotOptions()`。

use std::collections::{BTreeSet, HashSet};

use crate::ingredients::{ingredient_key, parse_ingredients};
use crate::limits::MEAL_INGREDIENTS_CHARS;
use crate::model::{Date, DishKind, Meal, MealSlot};
use crate::text::{char_count, trim_white};

// ── 料理範本 ──

/// 一道料理範本（現行 `RECIPE_TEMPLATES` 的一項）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecipeTemplate {
    /// 範本的 id，也是料理表單範本選單的值。
    pub id: &'static str,
    /// 料理名稱。
    pub title: &'static str,
    /// 插圖種類。
    pub dish: DishKind,
    /// 食材，以「、」分隔。
    pub ingredients: &'static str,
    /// 料理筆記。
    pub notes: &'static str,
}

/// 料理表單的 8 道料理範本（現行 `RECIPE_TEMPLATES`），依範本選單的順序（需求 24.4）。
pub const RECIPE_TEMPLATES: &[RecipeTemplate; 8] = &[
    RecipeTemplate {
        id: "sukiyaki",
        title: "暖暖壽喜燒",
        dish: DishKind::Hotpot,
        ingredients: "牛肉片、板豆腐、高麗菜、香菇、洋蔥、壽喜燒醬",
        notes: "先煎洋蔥，再加入醬汁和食材慢慢煮。",
    },
    RecipeTemplate {
        id: "hotpot",
        title: "什錦火鍋",
        dish: DishKind::Hotpot,
        ingredients: "豬肉片、高麗菜、金針菇、板豆腐、玉米、蛤蜊、高湯",
        notes: "依食材熟成時間分批下鍋，生熟食分開夾取。",
    },
    RecipeTemplate {
        id: "bbq",
        title: "星空炭火燒烤",
        dish: DishKind::Bbq,
        ingredients: "雞腿肉、香腸、玉米、甜椒、櫛瓜、烤肉醬",
        notes: "肉類與蔬菜分開處理，雞肉要烤熟。",
    },
    RecipeTemplate {
        id: "toast",
        title: "起司熱壓吐司",
        dish: DishKind::Toast,
        ingredients: "吐司、雞蛋、起司、火腿、奶油",
        notes: "吐司外側薄抹奶油，夾入熟蛋與配料後熱壓。",
    },
    RecipeTemplate {
        id: "curry",
        title: "野炊雞肉咖哩飯",
        dish: DishKind::Curry,
        ingredients: "雞腿肉、馬鈴薯、紅蘿蔔、洋蔥、咖哩塊、白米",
        notes: "先炒香洋蔥與雞肉，燉熟根莖後加入咖哩塊。",
    },
    RecipeTemplate {
        id: "pasta",
        title: "番茄義大利麵",
        dish: DishKind::Pasta,
        ingredients: "義大利麵、番茄、洋蔥、大蒜、絞肉、番茄醬、橄欖油",
        notes: "煮麵水留一小杯，拌醬時調整濃稠度。",
    },
    RecipeTemplate {
        id: "breakfast",
        title: "貝果早安盤",
        dish: DishKind::Breakfast,
        ingredients: "貝果、雞蛋、奶油、蘋果、鮮奶、咖啡豆",
        notes: "烤熱貝果，搭配煎蛋、水果與喜歡的飲品。",
    },
    RecipeTemplate {
        id: "salad",
        title: "清爽野餐沙拉",
        dish: DishKind::Salad,
        ingredients: "萵苣、小黃瓜、番茄、玉米、雞蛋、橄欖油",
        notes: "蔬菜洗淨瀝乾，出餐前再拌入調味。",
    },
];

/// id 是 `id` 的料理範本；沒有這個範本時是 `None`。現行 `applyRecipeTemplate()` 在這時丟出「請先選擇常用料理範本。」；
/// 這裡的 [`apply_recipe_template`] 直接接受範本，選單沒有選擇範本時 LM_Web 不提供套用。
pub fn recipe_template(id: &str) -> Option<&'static RecipeTemplate> {
    RECIPE_TEMPLATES.iter().find(|template| template.id == id)
}

// ── 常用食材捷徑 ──

/// 常用食材捷徑的一組（現行 `COMMON_INGREDIENTS` 的一個分組）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IngredientGroup {
    /// 分組名稱，例如「肉類」；不一定是採買分類，例如「水果飲料」與「點心」。
    pub label: &'static str,
    /// 這一組的捷徑，每個是一個食材名稱，依按鈕的順序。
    pub names: &'static [&'static str],
}

/// 料理表單的常用食材捷徑（現行 `COMMON_INGREDIENTS`）：9 組、共 57 個，依顯示的順序（需求 24.4）。
pub const COMMON_INGREDIENTS: &[IngredientGroup; 9] = &[
    IngredientGroup {
        label: "肉類",
        names: &[
            "牛肉片",
            "豬肉片",
            "雞腿肉",
            "雞胸肉",
            "香腸",
            "培根",
            "火腿",
            "絞肉",
        ],
    },
    IngredientGroup {
        label: "海鮮",
        names: &["鮮蝦", "蛤蜊", "鮭魚", "花枝", "干貝"],
    },
    IngredientGroup {
        label: "蔬菜",
        names: &[
            "高麗菜",
            "洋蔥",
            "香菇",
            "金針菇",
            "玉米",
            "甜椒",
            "番茄",
            "紅蘿蔔",
            "小黃瓜",
            "櫛瓜",
            "萵苣",
            "大蒜",
        ],
    },
    IngredientGroup {
        label: "蛋奶",
        names: &["雞蛋", "起司", "鮮奶", "奶油", "優格"],
    },
    IngredientGroup {
        label: "豆製品",
        names: &["板豆腐", "豆皮", "豆乾"],
    },
    IngredientGroup {
        label: "主食",
        names: &["白米", "吐司", "貝果", "義大利麵", "烏龍麵", "馬鈴薯"],
    },
    IngredientGroup {
        label: "調味料",
        names: &[
            "壽喜燒醬",
            "烤肉醬",
            "咖哩塊",
            "番茄醬",
            "醬油",
            "橄欖油",
            "鹽",
            "胡椒",
            "高湯",
        ],
    },
    IngredientGroup {
        label: "水果飲料",
        names: &["蘋果", "香蕉", "葡萄", "咖啡豆", "豆漿", "飲用水"],
    },
    IngredientGroup {
        label: "點心",
        names: &["棉花糖", "餅乾", "巧克力"],
    },
];

/// 合併食材（現行 `mergeIngredients()`，需求 24.11）：以 Ingredient_Parser 切分「`current`、`extra`」（兩段之間接上
/// 「、」），再以「、」串接切出的名稱。原有食材保留原本的寫法與順序，`extra` 中 Ingredient_Key 已出現的食材不再加入；
/// 兩者都沒有食材時是空字串。例如「雞 蛋, 牛肉片」合併「雞蛋、高麗菜」得到「雞 蛋、牛肉片、高麗菜」。
pub fn merge_ingredients(current: &str, extra: &str) -> String {
    parse_ingredients(&format!("{current}、{extra}")).join("、")
}

/// 需求 24.4：食材文字 `ingredients` 中已有相同 Ingredient_Key 的食材的常用食材捷徑；這些捷徑的按鈕停用，並以
/// `aria-pressed="true"` 標示為已選取。例如「雞 蛋、牛肉 片」選了「雞蛋」與「牛肉片」；「番茄醬」只選了「番茄醬」，
/// 沒有選「番茄」。
pub fn selected_common_ingredients(ingredients: &str) -> BTreeSet<&'static str> {
    let keys: HashSet<String> = parse_ingredients(ingredients)
        .iter()
        .map(|name| ingredient_key(name))
        .collect();
    COMMON_INGREDIENTS
        .iter()
        .flat_map(|group| group.names.iter().copied())
        .filter(|name| keys.contains(&ingredient_key(name)))
        .collect()
}

/// 需求 24.11：按下常用食材捷徑 `name` 之後的食材文字，也就是 `merge_ingredients(ingredients, name)`。結果超過
/// 2,000 字（Char_Count）時回傳 [`ShortcutIngredientsTooLong`]，表單的草稿不變。
pub fn add_common_ingredient(
    ingredients: &str,
    name: &str,
) -> Result<String, ShortcutIngredientsTooLong> {
    let merged = merge_ingredients(ingredients, name);
    if MEAL_INGREDIENTS_CHARS.contains(&char_count(&merged)) {
        Ok(merged)
    } else {
        Err(ShortcutIngredientsTooLong)
    }
}

/// 按下常用食材捷徑之後的食材超過 2,000 字（需求 24.11）。`Display` 是給使用者看的訊息，與儲存料理時食材過長的訊息
/// （需求 24.2）相同。
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("食材最多 2,000 字，請先整理清單。")]
pub struct ShortcutIngredientsTooLong;

// ── 套用料理範本 ──

/// 料理表單草稿中，套用範本會改到的欄位。日期、餐次、負責人與份數不受範本影響，由表單自己保留（現行
/// `applyRecipeTemplate()` 也只改這四個欄位）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RecipeDraft {
    /// 料理名稱。
    pub title: String,
    /// 料理筆記。
    pub notes: String,
    /// 食材文字。
    pub ingredients: String,
    /// 插圖種類；`None` 是沒有設定，畫面依名稱與食材推斷（需求 24.5）。
    pub dish: Option<DishKind>,
}

/// 套用範本之前的詢問（需求 24.11）。使用者取消時草稿不變。
pub const APPLY_TEMPLATE_CONFIRMATION: &str =
    "套用範本會更新料理名稱、筆記與圖片；原有食材會保留並合併。確定套用？";

/// 需求 24.11：套用 `template` 之前是否要先以 [`APPLY_TEMPLATE_CONFIRMATION`] 詢問：草稿的名稱或筆記經 Trim_White
/// 之後不是空的，或已設定與範本不同的插圖種類。只有食材的草稿不詢問，因為原有食材會保留並合併。
pub fn template_needs_confirmation(draft: &RecipeDraft, template: &RecipeTemplate) -> bool {
    !trim_white(&draft.title).is_empty()
        || !trim_white(&draft.notes).is_empty()
        || draft.dish.is_some_and(|dish| dish != template.dish)
}

/// 需求 24.11（現行 `applyRecipeTemplate()`）：套用 `template` 之後的草稿：名稱、筆記與插圖種類換成範本的內容，
/// 食材是 `merge_ingredients(原有食材, 範本的食材)`。合併後的食材超過 2,000 字（Char_Count）時回傳
/// [`TemplateIngredientsTooLong`]，草稿不變。只算出新的草稿，不送出 Command；是否先詢問見
/// [`template_needs_confirmation`]。
pub fn apply_recipe_template(
    draft: &RecipeDraft,
    template: &RecipeTemplate,
) -> Result<RecipeDraft, TemplateIngredientsTooLong> {
    let ingredients = merge_ingredients(&draft.ingredients, template.ingredients);
    if !MEAL_INGREDIENTS_CHARS.contains(&char_count(&ingredients)) {
        return Err(TemplateIngredientsTooLong);
    }
    Ok(RecipeDraft {
        title: template.title.to_owned(),
        notes: template.notes.to_owned(),
        ingredients,
        dish: Some(template.dish),
    })
}

/// 套用範本之後合併的食材超過 2,000 字（需求 24.11）。`Display` 是給使用者看的訊息。
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("合併後食材超過 2,000 字，請先整理食材。")]
pub struct TemplateIngredientsTooLong;

// ── 插圖種類 ──

/// 需求 24.5（現行 `inferDishKind()`）：料理顯示的插圖種類。設定了插圖種類時就是它（包括 custom）；沒有設定時以
/// [`infer_dish_kind_from`] 依目前的名稱與食材推斷，推斷的結果不寫入料理。
pub fn infer_dish_kind(meal: &Meal) -> DishKind {
    meal.dish
        .unwrap_or_else(|| infer_dish_kind_from(&meal.title, &meal.ingredients))
}

/// 沒有設定插圖種類時，依名稱與食材推斷插圖種類（需求 24.5）：名稱含有 `TITLE_RULES` 中某條規則的任一詞時，取第一條
/// 這樣的規則；名稱都不符合時，Ingredient_Parser 從 `ingredients` 切出的任一個名稱含有 `INGREDIENT_RULES` 中某條規則的
/// 任一詞時，取第一條這樣的規則；都不符合時為 custom（通用餐盤）。
///
/// 與現行相同，名稱不做正規化；食材以切出的名稱（NFKC 並整理空白之後）逐一比對，所以「貝 果」與分在兩段的
/// 「火鍋、湯底」都不符合。例如「早餐吐司」是 toast（吐司的規則在早餐之前），名稱沒有符合的規則而食材是「吐司、貝果」
/// 時是 breakfast（貝果的規則在吐司之前）。
pub fn infer_dish_kind_from(title: &str, ingredients: &str) -> DishKind {
    if let Some(&(kind, _)) = TITLE_RULES
        .iter()
        .find(|(_, words)| words.iter().any(|word| title.contains(word)))
    {
        return kind;
    }
    let names = parse_ingredients(ingredients);
    INGREDIENT_RULES
        .iter()
        .find(|(_, words)| {
            names
                .iter()
                .any(|name| words.iter().any(|word| name.contains(word)))
        })
        .map_or(DishKind::Custom, |&(kind, _)| kind)
}

/// 現行 `inferDishKind()` 依名稱推斷的規則，順序相同。現行的每條規則是只有文字的 regex（例如 `/壽喜燒|火鍋|涮|湯鍋/`），
/// 這裡寫成詞的清單，以子字串比對，結果相同。
const TITLE_RULES: [(DishKind, &[&str]); 7] = [
    (DishKind::Hotpot, &["壽喜燒", "火鍋", "涮", "湯鍋"]),
    (
        DishKind::Bbq,
        &["烤肉", "燒烤", "串燒", "串烤", "烤雞", "烤魚", "烤玉米"],
    ),
    (DishKind::Toast, &["吐司", "土司", "三明治"]),
    (DishKind::Curry, &["咖哩"]),
    (DishKind::Pasta, &["義大利麵", "意大利麵", "義式麵"]),
    (DishKind::Salad, &["沙拉"]),
    (DishKind::Breakfast, &["貝果", "早餐", "早安"]),
];

/// 名稱都不符合時，現行 `inferDishKind()` 依食材推斷的規則，順序相同。
const INGREDIENT_RULES: [(DishKind, &[&str]); 6] = [
    (DishKind::Breakfast, &["貝果"]),
    (DishKind::Toast, &["吐司", "土司"]),
    (DishKind::Curry, &["咖哩"]),
    (DishKind::Pasta, &["義大利麵"]),
    (DishKind::Hotpot, &["壽喜燒醬", "火鍋湯底"]),
    (DishKind::Bbq, &["烤肉醬"]),
];

// ── 餐次順序與料理菜單的日期分組 ──

/// 餐次的順序（現行 `MEAL_SLOTS`）：早餐、午餐、下午茶、晚餐、消夜，也是料理表單餐次選單的五個選項。與
/// `MealSlot::ALL` 及 `MealSlot` 的 `Ord` 相同。
pub const MEAL_SLOTS: &[MealSlot] = MealSlot::ALL;

/// Menu_Tab 的一個日期區塊（現行 `groupMealsByDate()` 的一組）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MealGroup<'a> {
    /// 這一組的日期。
    pub day: Date,
    /// 這一天的料理：先依餐次（`MEAL_SLOTS` 的順序），再依 Ordinal，Ordinal 相同時依 id；不依用餐時間。
    pub meals: Vec<&'a Meal>,
}

/// 需求 24.1（現行 `groupMealsByDate()`）：只為有料理的日子各建立一組，依日期遞增；組內先依餐次、再依 Ordinal 排列
/// （Ordinal 相同時依 id），不依用餐時間，也與 `meals` 的走訪順序無關。沒有料理時是空的清單。
/// 例如 `group_meals_by_date(state.meals.values())`。
pub fn group_meals_by_date<'a>(meals: impl IntoIterator<Item = &'a Meal>) -> Vec<MealGroup<'a>> {
    let mut sorted: Vec<&Meal> = meals.into_iter().collect();
    sorted.sort_by_key(|meal| (meal.day, meal.slot, meal.ordinal, meal.id));
    let mut groups: Vec<MealGroup<'a>> = Vec::new();
    for meal in sorted {
        match groups.last_mut() {
            Some(group) if group.day == meal.day => group.meals.push(meal),
            _ => groups.push(MealGroup {
                day: meal.day,
                meals: vec![meal],
            }),
        }
    }
    groups
}

// ── 常用裝備建議 ──

/// 一項常用裝備建議（現行 `PERSONAL_GEAR_GROUPS` 的一項）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GearPreset {
    /// 裝備名稱。
    pub name: &'static str,
    /// 建議的數量與單位。
    pub quantity: &'static str,
}

/// 一組常用裝備建議。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GearPresetGroup {
    /// 分組名稱，例如「睡眠與遮蔽」。
    pub label: &'static str,
    /// 這一組的建議，依選單的順序。
    pub items: &'static [GearPreset],
}

/// 裝備表單「常用露營裝備」選單的建議（現行 `PERSONAL_GEAR_GROUPS`）：3 組、共 19 項，依選單的順序。選擇一項只把
/// 名稱與建議的數量填入表單，使用者按下儲存才新增裝備；個人或共用由表單的類型決定。
pub const PERSONAL_GEAR_GROUPS: &[GearPresetGroup; 3] = &[
    GearPresetGroup {
        label: "睡眠與遮蔽",
        items: &[
            GearPreset {
                name: "帳篷",
                quantity: "1 頂",
            },
            GearPreset {
                name: "行軍床",
                quantity: "1 張",
            },
            GearPreset {
                name: "折疊床",
                quantity: "1 張",
            },
            GearPreset {
                name: "充氣床墊",
                quantity: "1 張",
            },
            GearPreset {
                name: "睡墊",
                quantity: "1 張",
            },
            GearPreset {
                name: "睡袋",
                quantity: "1 個",
            },
            GearPreset {
                name: "棉被",
                quantity: "1 件",
            },
            GearPreset {
                name: "枕頭",
                quantity: "1 個",
            },
            GearPreset {
                name: "防潮墊",
                quantity: "1 張",
            },
        ],
    },
    GearPresetGroup {
        label: "穿著與盥洗",
        items: &[
            GearPreset {
                name: "保暖外套",
                quantity: "1 件",
            },
            GearPreset {
                name: "換洗衣物",
                quantity: "1 組",
            },
            GearPreset {
                name: "雨衣",
                quantity: "1 件",
            },
            GearPreset {
                name: "毛巾",
                quantity: "1 條",
            },
            GearPreset {
                name: "盥洗用品",
                quantity: "1 組",
            },
            GearPreset {
                name: "拖鞋",
                quantity: "1 雙",
            },
        ],
    },
    GearPresetGroup {
        label: "隨身用品",
        items: &[
            GearPreset {
                name: "頭燈",
                quantity: "1 個",
            },
            GearPreset {
                name: "行動電源",
                quantity: "1 個",
            },
            GearPreset {
                name: "個人餐具",
                quantity: "1 組",
            },
            GearPreset {
                name: "水壺",
                quantity: "1 個",
            },
        ],
    },
];

/// 名稱是 `name` 的裝備建議（現行 `personalGearPreset()`，名稱要完全相同）；沒有時是 `None`。
pub fn personal_gear_preset(name: &str) -> Option<&'static GearPreset> {
    PERSONAL_GEAR_GROUPS
        .iter()
        .flat_map(|group| group.items)
        .find(|preset| preset.name == name)
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;
    use crate::ids::MealId;
    use crate::time::Hm;

    #[test]
    fn tables_keep_the_current_order_and_sizes() {
        let ids: Vec<&str> = RECIPE_TEMPLATES
            .iter()
            .map(|template| template.id)
            .collect();
        assert_eq!(
            ids.join(" "),
            "sukiyaki hotpot bbq toast curry pasta breakfast salad"
        );
        let dishes: Vec<&str> = RECIPE_TEMPLATES
            .iter()
            .map(|template| template.dish.as_str())
            .collect();
        assert_eq!(
            dishes.join(" "),
            "hotpot hotpot bbq toast curry pasta breakfast salad"
        );
        let labels: Vec<&str> = COMMON_INGREDIENTS.iter().map(|group| group.label).collect();
        assert_eq!(
            labels.join(" "),
            "肉類 海鮮 蔬菜 蛋奶 豆製品 主食 調味料 水果飲料 點心"
        );
        let sizes: Vec<usize> = COMMON_INGREDIENTS
            .iter()
            .map(|group| group.names.len())
            .collect();
        assert_eq!(sizes, [8, 5, 12, 5, 3, 6, 9, 6, 3]);
        let labels: Vec<&str> = PERSONAL_GEAR_GROUPS
            .iter()
            .map(|group| group.label)
            .collect();
        assert_eq!(labels.join(" "), "睡眠與遮蔽 穿著與盥洗 隨身用品");
        let sizes: Vec<usize> = PERSONAL_GEAR_GROUPS
            .iter()
            .map(|group| group.items.len())
            .collect();
        assert_eq!(sizes, [9, 6, 4]);
        let slots: Vec<&str> = MEAL_SLOTS.iter().map(MealSlot::as_str).collect();
        assert_eq!(slots.join(" "), "早餐 午餐 下午茶 晚餐 消夜");
    }

    #[test]
    fn each_shortcut_is_one_ingredient_with_its_own_key() {
        // 按下捷徑恰好加入那一個名稱，而且每個捷徑的已選取狀態互不影響
        let names: Vec<&str> = COMMON_INGREDIENTS
            .iter()
            .flat_map(|group| group.names.iter().copied())
            .collect();
        assert_eq!(names.len(), 57);
        for name in &names {
            assert_eq!(parse_ingredients(name), [*name]);
        }
        let keys: HashSet<String> = names.iter().map(|name| ingredient_key(name)).collect();
        assert_eq!(keys.len(), names.len());
    }

    #[test]
    fn templates_and_gear_presets_are_found_by_exact_id_or_name() {
        for template in RECIPE_TEMPLATES {
            assert_eq!(recipe_template(template.id), Some(template));
            // 名稱推斷出的插圖種類就是範本的插圖種類
            assert_eq!(
                infer_dish_kind_from(template.title, template.ingredients),
                template.dish,
                "{}",
                template.id
            );
        }
        for id in ["", "__proto__", "Curry", " curry"] {
            assert_eq!(recipe_template(id), None, "{id:?}");
        }
        let names: HashSet<&str> = PERSONAL_GEAR_GROUPS
            .iter()
            .flat_map(|group| group.items)
            .map(|preset| preset.name)
            .collect();
        assert_eq!(names.len(), 19);
        assert_eq!(
            personal_gear_preset("睡袋"),
            Some(&GearPreset {
                name: "睡袋",
                quantity: "1 個"
            })
        );
        for name in ["", " 睡袋", "睡 袋", "露營椅"] {
            assert_eq!(personal_gear_preset(name), None, "{name:?}");
        }
    }

    #[test]
    fn merge_keeps_the_existing_names_and_adds_only_new_keys() {
        assert_eq!(
            merge_ingredients("牛肉片, 板豆腐", "雞蛋"),
            "牛肉片、板豆腐、雞蛋"
        );
        assert_eq!(
            merge_ingredients("雞 蛋、ＡＢＣ", "雞蛋、abc、高麗菜"),
            "雞 蛋、ABC、高麗菜"
        );
        assert_eq!(merge_ingredients("", "雞蛋"), "雞蛋");
        assert_eq!(merge_ingredients(" 雞蛋 ", ""), "雞蛋");
        assert_eq!(merge_ingredients("", ""), "");
    }

    #[test]
    fn applying_a_template_replaces_title_notes_and_dish_and_merges_ingredients() {
        let curry = recipe_template("curry").expect("有咖哩範本");
        let draft = RecipeDraft {
            title: "原本".to_owned(),
            notes: "筆記".to_owned(),
            ingredients: "雞腿肉 ,鮮蝦".to_owned(),
            dish: Some(DishKind::Salad),
        };
        assert_eq!(
            apply_recipe_template(&draft, curry),
            Ok(RecipeDraft {
                title: "野炊雞肉咖哩飯".to_owned(),
                notes: "先炒香洋蔥與雞肉，燉熟根莖後加入咖哩塊。".to_owned(),
                ingredients: "雞腿肉、鮮蝦、馬鈴薯、紅蘿蔔、洋蔥、咖哩塊、白米".to_owned(),
                dish: Some(DishKind::Curry),
            })
        );
    }

    #[test]
    fn merged_ingredients_may_have_at_most_2000_chars() {
        // 以 Char_Count 計算合併之後的文字；「蛋」是 3 個 UTF-8 位元組，仍算 1 個字
        let salad = recipe_template("salad").expect("有沙拉範本");
        let room = 2000 - char_count("、") - char_count(salad.ingredients);
        let fits = RecipeDraft {
            ingredients: "蛋".repeat(room),
            ..RecipeDraft::default()
        };
        let applied = apply_recipe_template(&fits, salad).expect("恰好 2,000 字");
        assert_eq!(char_count(&applied.ingredients), 2000);
        let over = RecipeDraft {
            ingredients: "蛋".repeat(room + 1),
            ..RecipeDraft::default()
        };
        assert_eq!(
            apply_recipe_template(&over, salad),
            Err(TemplateIngredientsTooLong)
        );

        assert_eq!(
            add_common_ingredient(&"蛋".repeat(1998), "鹽"),
            Ok(format!("{}、鹽", "蛋".repeat(1998)))
        );
        assert_eq!(
            add_common_ingredient(&"蛋".repeat(1999), "鹽"),
            Err(ShortcutIngredientsTooLong)
        );
        // 原有的文字超過 2,000 字，但整理之後沒有超過
        let messy = format!("{}{}", "蛋".repeat(1995), "、".repeat(10));
        assert_eq!(
            add_common_ingredient(&messy, "鹽"),
            Ok(format!("{}、鹽", "蛋".repeat(1995)))
        );

        assert_eq!(
            TemplateIngredientsTooLong.to_string(),
            "合併後食材超過 2,000 字，請先整理食材。"
        );
        assert_eq!(
            ShortcutIngredientsTooLong.to_string(),
            "食材最多 2,000 字，請先整理清單。"
        );
    }

    #[test]
    fn confirmation_is_needed_when_the_title_notes_or_another_dish_would_be_replaced() {
        let pasta = recipe_template("pasta").expect("有義大利麵範本");
        let fields =
            |title: &str, notes: &str, ingredients: &str, dish: Option<DishKind>| RecipeDraft {
                title: title.to_owned(),
                notes: notes.to_owned(),
                ingredients: ingredients.to_owned(),
                dish,
            };
        for (draft, expected) in [
            (RecipeDraft::default(), false),
            // 只有食材時不詢問：原有食材會保留並合併
            (fields("", "", "雞蛋", None), false),
            // 只有 Trim_White 的空白（包括 U+3000 與 U+0085）視為空的；U+FEFF 不是 White_Space
            (fields(" \u{3000}\u{85}\n", "\t", "", None), false),
            (fields("\u{feff}", "", "", None), true),
            (fields("番茄麵", "", "", None), true),
            (fields("", "記得帶鍋子", "", None), true),
            // 插圖種類：與範本相同時不詢問，不同時（包括 custom）詢問
            (fields("", "", "", Some(DishKind::Pasta)), false),
            (fields("", "", "", Some(DishKind::Custom)), true),
            (fields("", "", "", Some(DishKind::Salad)), true),
        ] {
            assert_eq!(
                template_needs_confirmation(&draft, pasta),
                expected,
                "{draft:?}"
            );
        }
        assert_eq!(
            APPLY_TEMPLATE_CONFIRMATION,
            "套用範本會更新料理名稱、筆記與圖片；原有食材會保留並合併。確定套用？"
        );
    }

    #[test]
    fn selected_shortcuts_compare_whole_ingredient_keys() {
        assert_eq!(selected_common_ingredients(""), BTreeSet::new());
        assert_eq!(
            selected_common_ingredients("雞 蛋、高麗菜, 牛肉 片/冰塊"),
            BTreeSet::from(["雞蛋", "高麗菜", "牛肉片"])
        );
        // 比較整個食材的 Ingredient_Key，不比對部分文字
        assert_eq!(
            selected_common_ingredients("番茄醬、蛋"),
            BTreeSet::from(["番茄醬"])
        );
        // 按下已選取的捷徑不重複加入
        assert_eq!(
            add_common_ingredient("雞 蛋", "雞蛋"),
            Ok("雞 蛋".to_owned())
        );
        assert_eq!(
            add_common_ingredient("牛肉片 , 高麗菜", "雞蛋"),
            Ok("牛肉片、高麗菜、雞蛋".to_owned())
        );
    }

    #[test]
    fn a_set_dish_kind_wins_over_the_title_and_ingredients() {
        let meal = |title: &str, ingredients: &str, dish: Option<DishKind>| Meal {
            title: title.to_owned(),
            ingredients: ingredients.to_owned(),
            dish,
            ..meal_on(1, "2026-11-20", MealSlot::Dinner)
        };
        assert_eq!(
            infer_dish_kind(&meal("咖哩飯", "貝果", Some(DishKind::Salad))),
            DishKind::Salad
        );
        assert_eq!(
            infer_dish_kind(&meal("什錦火鍋", "", Some(DishKind::Custom))),
            DishKind::Custom
        );
        assert_eq!(
            infer_dish_kind(&meal("咖哩飯", "貝果", None)),
            DishKind::Curry
        );
        assert_eq!(
            infer_dish_kind(&meal("晚餐", "貝果", None)),
            DishKind::Breakfast
        );
    }

    #[test]
    fn the_title_decides_before_the_ingredients_by_rule_order() {
        use DishKind::*;
        for (title, ingredients, kind) in [
            // 名稱：取第一條符合的規則
            ("涮涮鍋", "", Hotpot),
            ("昆布湯鍋", "", Hotpot),
            ("火鍋烤肉吃到飽", "", Hotpot),
            ("烤玉米", "", Bbq),
            ("早餐吐司", "", Toast),
            ("鮪魚三明治", "", Toast),
            ("咖哩義大利麵", "", Curry),
            ("意大利麵", "", Pasta),
            ("早安沙拉", "", Salad),
            ("早安", "", Breakfast),
            // 名稱有符合的規則時不看食材
            ("沙拉", "貝果、壽喜燒醬", Salad),
            // 名稱不做正規化
            ("火 鍋", "", Custom),
            // 食材：取第一條有任一個名稱符合的規則
            ("晚餐", "吐司、貝果", Breakfast),
            ("", "烤肉醬、火鍋湯底", Hotpot),
            ("", "壽喜燒醬", Hotpot),
            ("", "烤肉醬", Bbq),
            ("", "咖哩塊", Curry),
            ("", "義大利麵 200g", Pasta),
            ("", "厚片土司", Toast),
            // 食材以切出的名稱比對
            ("", "貝 果", Custom),
            ("", "火鍋、湯底", Custom),
            ("", "\u{feff}貝果", Breakfast),
            // 名稱的規則不用在食材上
            ("", "火鍋料、沙拉", Custom),
            ("不知道吃什麼", "", Custom),
        ] {
            assert_eq!(
                infer_dish_kind_from(title, ingredients),
                kind,
                "{title:?} {ingredients:?}"
            );
        }
    }

    #[test]
    fn meals_group_by_day_then_slot_then_ordinal_not_by_time() {
        let at = |n: u64, day: &str, slot: MealSlot, time: Option<Hm>| Meal {
            time,
            ..meal_on(n, day, slot)
        };
        let meals = [
            at(1, "2026-11-21", MealSlot::LateNight, None),
            at(2, "2026-11-20", MealSlot::Dinner, None),
            at(3, "2026-11-21", MealSlot::Lunch, Hm::new(13, 0)),
            at(4, "2026-11-21", MealSlot::Breakfast, Hm::new(23, 0)),
            at(5, "2026-11-21", MealSlot::AfternoonTea, None),
            at(6, "2026-11-21", MealSlot::Lunch, Hm::new(11, 0)),
            // Ordinal 與 3 相同時依 id
            Meal {
                ordinal: 3,
                ..at(7, "2026-11-21", MealSlot::Lunch, None)
            },
        ];
        // 走訪的順序不影響結果
        let groups = group_meals_by_date(meals.iter().rev());
        let summary: Vec<(String, Vec<u64>)> = groups
            .iter()
            .map(|group| {
                let numbers = group
                    .meals
                    .iter()
                    .map(|meal| u64::try_from(meal.id.0.as_u128()).expect("小的 id"))
                    .collect();
                (group.day.to_string(), numbers)
            })
            .collect();
        assert_eq!(
            summary,
            [
                ("2026-11-20".to_owned(), vec![2]),
                ("2026-11-21".to_owned(), vec![4, 3, 7, 6, 5, 1]),
            ]
        );
        assert!(group_meals_by_date(std::iter::empty::<&Meal>()).is_empty());
    }

    /// 第 n 道料理，id 與 Ordinal 都是 n。
    fn meal_on(n: u64, day: &str, slot: MealSlot) -> Meal {
        Meal {
            id: MealId(Uuid::from_u128(u128::from(n))),
            day: crate::time::parse_date(day).expect("有效的日期"),
            slot,
            time: None,
            title: String::new(),
            cook: None,
            servings: 4,
            ingredients: String::new(),
            notes: String::new(),
            dish: None,
            ordinal: n,
            version: n,
        }
    }
}
