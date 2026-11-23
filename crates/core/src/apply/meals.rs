//! 料理：`AddMeal`、`UpdateMeal`、`RemoveMeal`（需求 24）與 `RemoveIngredientFromMeals`（需求 25.16、25.20）。
//! 提交時的採買同步由 `apply()` 執行。

use std::collections::BTreeSet;

use crate::command::{
    optional_time, Input, MealDraft, MealPatch, Rejection, LIMIT_REACHED, TIME_OR_BLANK,
    UNSTORABLE_TEXT,
};
use crate::ids::{MealId, ShoppingId};
use crate::ingredients::{check_ingredient_names, remove_ingredient_from_meals};
use crate::limits::{
    MEALS_MAX, MEAL_INGREDIENTS_CHARS, MEAL_NOTES_CHARS, MEAL_SERVINGS, MEAL_TITLE_CHARS,
};
use crate::model::{DishKind, Entity, Meal, MealSlot, Slot, TripState};
use crate::time::Hm;

use super::common::{ensure_new, fits, in_trip, next_ordinal};
use super::slot;

/// 料理表單中使用者輸入或選擇的值；`None` 是沿用料理目前的值。
struct Inputs<'a> {
    slot: Option<&'a Input<MealSlot>>,
    /// `Some(None)` 是清除插圖種類。
    dish: Option<Option<&'a Input<DishKind>>>,
    /// `Some(None)` 是清除用餐時間。
    time: Option<Option<&'a Input<Hm>>>,
    servings: Option<&'a Input<u8>>,
}

/// 以新增或修改之後的料理依需求 24.2 的順序檢查（修改的料理不存在的 404 由呼叫端先檢查）：餐次、插圖種類與
/// U+0000，日期，用餐時間，名稱，負責人，份數，食材，每項食材（需求 25.18），筆記。
fn checked(d: &TripState, mut meal: Meal, inputs: Inputs<'_>) -> Result<Meal, Rejection> {
    if let Some(input) = inputs.slot {
        meal.slot = input
            .ok()
            .copied()
            .ok_or_else(|| Rejection::invalid("slot", "請選擇餐次。"))?;
    }
    if let Some(dish) = inputs.dish {
        meal.dish = match dish {
            None => None,
            Some(input) => Some(
                input
                    .ok()
                    .copied()
                    .ok_or_else(|| Rejection::invalid("dish", "請選擇料理圖片。"))?,
            ),
        };
    }
    for (field, text) in [
        ("title", &meal.title),
        ("ingredients", &meal.ingredients),
        ("notes", &meal.notes),
    ] {
        if text.contains('\0') {
            return Err(Rejection::invalid(field, UNSTORABLE_TEXT));
        }
    }
    if !in_trip(d, meal.day) {
        return Err(Rejection::invalid("day", "請重新選擇日期。"));
    }
    if let Some(time) = inputs.time {
        meal.time = optional_time(time).map_err(|_| Rejection::invalid("time", TIME_OR_BLANK))?;
    }
    if !fits(&meal.title, MEAL_TITLE_CHARS) {
        return Err(Rejection::invalid("title", "料理名稱最多 100 個字。"));
    }
    if meal.cook.is_some_and(|cook| !d.people.contains_key(&cook)) {
        return Err(Rejection::invalid(
            "cook",
            "負責人已不在旅伴名單，請重新選擇。",
        ));
    }
    if let Some(servings) = inputs.servings {
        meal.servings = servings
            .ok()
            .copied()
            .filter(|servings| MEAL_SERVINGS.contains(servings))
            .ok_or_else(|| Rejection::invalid("servings", "人數請填 1 到 100 的整數。"))?;
    }
    if !fits(&meal.ingredients, MEAL_INGREDIENTS_CHARS) {
        return Err(Rejection::invalid(
            "ingredients",
            "食材最多 2,000 字，請先整理清單。",
        ));
    }
    check_ingredient_names(&meal.ingredients)
        .map_err(|error| Rejection::invalid("ingredients", error.to_string()))?;
    if !fits(&meal.notes, MEAL_NOTES_CHARS) {
        return Err(Rejection::invalid("notes", "料理筆記最多 1,000 個字。"));
    }
    Ok(meal)
}

/// `AddMeal`：依需求 24.2 檢查；已有 1000 道料理時 409（需求 24.7）。
pub(super) fn add_meal(
    d: &mut TripState,
    id: MealId,
    draft: &MealDraft,
) -> Result<Vec<Slot>, Rejection> {
    ensure_new(&d.meals, &id)?;
    let base = Meal {
        id,
        day: draft.day,
        slot: MealSlot::Dinner,
        time: None,
        title: draft.title.clone(),
        cook: draft.cook,
        servings: 1,
        ingredients: draft.ingredients.clone(),
        notes: draft.notes.clone(),
        dish: None,
        ordinal: next_ordinal(d),
        version: 0,
    };
    let inputs = Inputs {
        slot: Some(&draft.slot),
        dish: Some(draft.dish.as_ref()),
        time: Some(draft.time.as_ref()),
        servings: Some(&draft.servings),
    };
    let meal = checked(d, base, inputs)?;
    if d.meals.len() >= MEALS_MAX {
        return Err(Rejection::conflict(
            LIMIT_REACHED,
            "料理最多 1,000 道，請先刪除不需要的料理。",
        ));
    }
    d.meals.insert(id, meal);
    Ok(vec![slot(Entity::Meal, id.0)])
}

/// `UpdateMeal`：不存在時 404（在其他檢查之前）；只更新帶有的欄位，以修改之後的料理依需求 24.2 檢查。
pub(super) fn update_meal(
    d: &mut TripState,
    id: MealId,
    patch: &MealPatch,
) -> Result<(), Rejection> {
    let Some(current) = d.meals.get(&id) else {
        return Err(Rejection::not_found("找不到這道料理。"));
    };
    let mut meal = current.clone();
    if let Some(day) = patch.day {
        meal.day = day;
    }
    if let Some(title) = &patch.title {
        meal.title = title.clone();
    }
    if let Some(cook) = patch.cook {
        meal.cook = cook;
    }
    if let Some(ingredients) = &patch.ingredients {
        meal.ingredients = ingredients.clone();
    }
    if let Some(notes) = &patch.notes {
        meal.notes = notes.clone();
    }
    let inputs = Inputs {
        slot: patch.slot.as_ref(),
        dish: patch.dish.as_ref().map(Option::as_ref),
        time: patch.time.as_ref().map(Option::as_ref),
        servings: patch.servings.as_ref(),
    };
    let meal = checked(d, meal, inputs)?;
    d.meals.insert(id, meal);
    Ok(())
}

/// `RemoveMeal`：已不存在時沒有變化（需求 24.8）。
pub(super) fn remove_meal(d: &mut TripState, id: MealId) {
    d.meals.remove(&id);
}

/// `RemoveIngredientFromMeals`：依需求 25.20 的順序檢查，再依提交當下的食材文字從選定料理移除這個品項名稱切出的鍵
/// （需求 25.16）；品項是否保留由同一次提交的採買同步決定。
pub(super) fn remove_ingredient(
    d: &mut TripState,
    item: ShoppingId,
    meals: &BTreeSet<MealId>,
) -> Result<(), Rejection> {
    let Some(item) = d.shopping.get(&item) else {
        return Err(Rejection::not_found("找不到這個採買品項。"));
    };
    if meals.is_empty() {
        return Err(Rejection::invalid("meals", "請至少勾選一道料理。"));
    }
    if !meals.iter().all(|id| d.meals.contains_key(id)) {
        return Err(Rejection::not_found("找不到這道料理。"));
    }
    let name = item.name.clone();
    remove_ingredient_from_meals(d, &name, meals);
    Ok(())
}
