// Feature: trip-planning-workflow-enhance, Property 17: 中文數字與天數文字
// **Validates: Requirements 3.13, 11.13, 14.2**
//
// chineseNumeral()：需求 3.13 與 11.13 的車輛數等數字。1 到 99 的結果以本檔獨立撰寫的解析函式讀回原數值，且結果含「兩」
// 若且唯若數值是 2（12 為「十二」、22 為「二十二」）；100 以上等於 String(n)，即不加千分位符號的阿拉伯數字（D27），
// 車輛數最多 1,000 台。
// durationText()：需求 11.13 的概要與需求 14.2 的標題行，1 到 31 天。1 天是「一日遊」，其他是
// `${chineseNumeral(d)}天${chineseNumeral(d - 1)}夜`，例如「兩天一夜」「三天兩夜」；天數與夜數也以解析函式讀回。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { chineseNumeral, durationText } from '../src/itinerary-model.js';

const RUNS = { numRuns: 200 };
// 1 到 99 與 1 到 31 的值不多：以 examples 依序檢查範圍內的每個值（計入 numRuns 的次數），其餘次數隨機產生。
const everyValue = (min, max) => Array.from({ length: max - min + 1 }, (_, i) => [min + i]);

// ---- 獨立撰寫的解析函式 ----
// 逐字讀取 1 到 99 的中文數字，寫法不符時回傳 null：1 到 9 是一個數字；10 到 19 是「十」加上可省略的個位數（不寫「一十」）；
// 20 到 99 是十位數（二到九）、「十」與可省略的個位數；不使用「零」「廿」、阿拉伯數字或空白。
// 「二」與「兩」都讀作 2：解析只確認數值與位數的寫法，「兩」只能用在哪裡由屬性另外檢查。
const DIGIT_CHARS = [...'一二三四五六七八九'];
function digitValue(char) {
  if (char === '兩') return 2;
  const index = DIGIT_CHARS.indexOf(char);
  return index === -1 ? null : index + 1;
}
function parseNumeral(text) {
  if (typeof text !== 'string') return null;
  const chars = [...text];
  const ten = chars.indexOf('十');
  if (ten === -1) return chars.length === 1 ? digitValue(chars[0]) : null;
  // 只有一個「十」，前後各最多一個數字
  if (chars.lastIndexOf('十') !== ten || ten > 1 || chars.length > ten + 2) return null;
  const tens = ten === 0 ? 1 : digitValue(chars[0]);
  const ones = chars.length === ten + 2 ? digitValue(chars[ten + 1]) : 0;
  if (tens === null || ones === null || (ten === 1 && tens === 1)) return null;
  return tens * 10 + ones;
}

describe('Property 17: 中文數字與天數文字', () => {
  test('本檔的解析函式只接受正確的位數寫法', () => {
    const read = [['一', 1], ['二', 2], ['兩', 2], ['九', 9], ['十', 10], ['十二', 12], ['二十', 20], ['二十二', 22], ['九十九', 99]];
    for (const [text, value] of read) expect(parseNumeral(text)).toBe(value);
    for (const text of ['', ' 十', '零', '一十', '一十二', '十零', '二十零', '十十', '二二', '一百', '廿', '两', '12']) {
      expect(parseNumeral(text)).toBeNull();
    }
  });

  test('1 到 99：解析結果等於原數值，且只有 2 寫作「兩」', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 99 }), n => {
      const text = chineseNumeral(n);
      expect(parseNumeral(text)).toBe(n);
      expect(text.includes('兩')).toBe(n === 2);
    }), { ...RUNS, examples: everyValue(1, 99) });
  });

  test('100 以上：等於 String(n)，不加千分位符號', () => {
    // 車輛數最多 1,000 台（需求 3.13），另外也檢查更大的整數；100 是兩種寫法的分界
    const atLeast100 = fc.oneof(fc.integer({ min: 100, max: 1000 }), fc.integer({ min: 100, max: Number.MAX_SAFE_INTEGER }));
    fc.assert(fc.property(atLeast100, n => {
      expect(chineseNumeral(n)).toBe(String(n));
    }), { ...RUNS, examples: [[100], [1000]] });
  });

  test('1 到 31 天：1 天為「一日遊」，其他為「{天數}天{天數減 1}夜」', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 31 }), days => {
      const text = durationText(days);
      if (days === 1) {
        expect(text).toBe('一日遊');
        return;
      }
      expect(text).toBe(`${chineseNumeral(days)}天${chineseNumeral(days - 1)}夜`);
      const [, dayCount, nightCount] = /^(.+)天(.+)夜$/u.exec(text);
      expect([parseNumeral(dayCount), parseNumeral(nightCount)]).toEqual([days, days - 1]);
    }), { ...RUNS, examples: everyValue(1, 31) });
  });
});
