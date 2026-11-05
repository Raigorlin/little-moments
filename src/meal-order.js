// Display-only ordering. Stored arrays and older custom slot names are never rewritten.
export const MEAL_SLOTS = Object.freeze(['早餐', '午餐', '下午茶', '晚餐', '消夜']);
const ALIASES = new Map([['早','早餐'], ['午','午餐'], ['晚','晚餐'], ['宵夜','消夜']]);
export function mealSlotRank(slot) {
  const label = String(slot ?? '').normalize('NFKC').trim();
  const rank = MEAL_SLOTS.indexOf(ALIASES.get(label) || label);
  return rank < 0 ? MEAL_SLOTS.length : rank;
}
export function mealSlotOptions(current = '晚餐') {
  const value = String(current || '晚餐');
  return MEAL_SLOTS.includes(value) ? [...MEAL_SLOTS] : [...MEAL_SLOTS, value];
}
export function groupMealsByDate(meals = []) {
  const sorted = meals.map((meal, index) => ({meal, index})).sort((a, b) =>
    a.meal.date.localeCompare(b.meal.date) || mealSlotRank(a.meal.slot) - mealSlotRank(b.meal.slot) || a.index - b.index);
  const groups = [];
  for (const {meal} of sorted) {
    if (groups.at(-1)?.date !== meal.date) groups.push({date: meal.date, meals: []});
    groups.at(-1).meals.push(meal);
  }
  return groups;
}
