// Feature: trip-planning-workflow-enhance, Property 21: 通用餐盤的圖案固定
// **Validates: Requirements 8.10**
//
// 行程圖為每一筆 Meal 輸出的 data-dish-variation 只由 meal.id 與料理插圖類型決定：
// - 重複產生與深拷貝後的 Trip_State 得到相同的值；
// - 改變日期（改成另一個旅行日）、時間、主廚、份數與料理筆記後相同；
// - 通用（custom）料理的值是 dishIllustration() 的通用圖案之一，且等於以 fixedRandom(meal.id) 為亂數得到的圖案；
//   非通用料理沒有 data-dish-variation。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { dishIllustration } from '../src/dish-art.js';
import { fixedRandom } from '../src/itinerary-art.js';
import { tripDays } from '../src/itinerary-derive.js';
import { posterHtml } from '../src/itinerary-poster.js';
import { escape } from '../src/model.js';
import { itineraryState } from './support/itinerary-arb.js';

const GENERIC = ['hotpot', 'bbq', 'toast', 'curry', 'pasta', 'breakfast', 'salad'];
const RUNS = { numRuns: 100 };

/** meal id（已 escape）→ { kind, variation }，取自每張餐點小卡。 */
function dishes(html) {
  const result = new Map();
  for (const card of html.split('<li class="moment-card').slice(1)) {
    if (!card.includes('data-line="meal"')) continue;
    const id = /data-line="meal" data-id="([^"]*)"/.exec(card)?.[1];
    const kind = /data-dish-kind="([^"]*)"/.exec(card)?.[1] ?? null;
    const variation = /data-dish-variation="([^"]*)"/.exec(card)?.[1] ?? null;
    result.set(id, { kind, variation });
  }
  return result;
}

const alter = (state, g) => {
  const copy = JSON.parse(JSON.stringify(state));
  const dates = tripDays(copy).map(day => day.date);
  for (const meal of copy.meals ?? []) {
    if (dates.length) meal.date = dates[g.int(dates.length)];
    meal.time = g.time;
    meal.cookId = g.cook;
    meal.servings = g.servings;
    meal.notes = g.notes;
  }
  return copy;
};

describe('Property 21: 通用餐盤的圖案固定', () => {
  test('data-dish-variation 只由 meal.id 與插圖類型決定', () => {
    const tweak = fc.record({
      time: fc.oneof(fc.constant(''), fc.constant('06:30'), fc.constant('12:00'), fc.constant('23:59')),
      cook: fc.oneof(fc.constant(''), fc.string({ maxLength: 6 })),
      servings: fc.integer({ min: 1, max: 30 }),
      notes: fc.string({ maxLength: 40 }),
      pick: fc.nat(1000)
    });
    fc.assert(fc.property(itineraryState(), tweak, (state, t) => {
      const before = state.meals.length ? JSON.stringify(state) : '';
      const base = dishes(posterHtml(state));
      expect(state.meals.length ? JSON.stringify(state) : '').toBe(before);

      // 重複產生與深拷貝
      expect(dishes(posterHtml(state))).toEqual(base);
      expect(dishes(posterHtml(JSON.parse(JSON.stringify(state))))).toEqual(base);

      // 改變日期、時間、主廚、份數與筆記
      const changed = alter(state, { ...t, int: n => t.pick % n });
      const after = dishes(posterHtml(changed));
      for (const [id, expected] of base) expect(after.get(id)).toEqual(expected);

      // 值本身
      for (const meal of state.meals) {
        const found = base.get(escape(meal.id));
        if (!found) continue; // 不在旅行日內的餐點不會輸出
        if (found.kind === 'custom') {
          expect(GENERIC).toContain(found.variation);
          const expectedHtml = dishIllustration('custom', '', () => fixedRandom(meal.id));
          expect(found.variation).toBe(/data-dish-variation="([^"]*)"/.exec(expectedHtml)[1]);
        } else {
          expect(found.variation).toBeNull();
        }
      }
    }), RUNS);
  }, 120000);
});
