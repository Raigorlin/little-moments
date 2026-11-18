// Feature: trip-planning-workflow-enhance, Property 2: 本功能之前的 Trip_State 仍然有效
// **Validates: Requirements 18.1, 18.12, 19.8, 23.4**
//
// 對 tests/support/itinerary-arb.js 的 legacyState()（seed() 或 emptyState() 加上只用舊欄位的隨機修改）產生的每一組
// Trip_State s：isValidState(s) 為 true，且 itineraryText()、posterHtml()（含列印與可編輯）與 editorHtml()（每一天、
// 路線與活動兩個分段）都不擲出例外並回傳字串。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { editorHtml } from '../src/itinerary-editor.js';
import { itineraryText } from '../src/itinerary-text.js';
import { posterHtml } from '../src/itinerary-poster.js';
import { dateRange, isValidState } from '../src/model.js';
import { legacyState } from './support/itinerary-arb.js';

const OPTIONS = { numRuns: 100, plugins: [fc.interruptAfterTimeLimit(45000, { failOnInterrupt: true })] };
const TIMEOUT = 90000;

describe('Property 2: 本功能之前的 Trip_State 仍然有效', () => {
  test('legacyState()：通過驗證，且文字、行程圖與編輯畫面都不擲出例外', () => {
    fc.assert(fc.property(legacyState(), s => {
      expect(isValidState(s)).toBe(true);
      expect(typeof itineraryText(s)).toBe('string');
      expect(typeof posterHtml(s)).toBe('string');
      expect(typeof posterHtml(s, { print: true })).toBe('string');
      expect(typeof posterHtml(s, { canEdit: true, textOpen: true })).toBe('string');
      const days = dateRange(s.trip.startDate, s.trip.endDate).length;
      for (const dayIndex of new Set([0, days - 1])) {
        for (const segment of ['routes', 'activities']) {
          expect(typeof editorHtml(s, { dayIndex, segment, card: null })).toBe('string');
        }
      }
    }), OPTIONS);
  }, TIMEOUT);
});
