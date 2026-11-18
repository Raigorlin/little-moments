// Feature: trip-planning-workflow-enhance, Property 16: 時間欄位的正規化
// **Validates: Requirements 4.9, 5.10, 7.10, 8.11, 18.3**
//
// normalizeTimeInput(s) 只有三種結果：s 去除前後空白（Unicode White_Space，含全形空白與換行）後為空時為空值
// { value: '' }；s 是一個 00:00 到 23:59 的 HH:MM（可加上前後空白，每個數字與冒號各自可以是全形）時為半形的
// { value: 'HH:MM' }；其他情況（只有時或分、一位數的時或分、24:00 以後或 60 分以後、含秒數、其他文字）為
// { error: 'invalid' }，只填一部分的時間不當成空白（需求 4.9、5.10、7.10、8.11）。
// 只有 U+3000 與 U+FF01–U+FFEE 的字元換成半形（設計「文字規則」）：「①」「²」「﹕」（U+FE55）等其他相容字元不轉換，
// 整串 NFKC 後才是有效時間的輸入仍是錯誤；U+200B、U+FEFF 等看不見但不是 White_Space 的字元不算空白。
// 參考判斷（去除空白、全形數字與冒號、時與分的範圍）在本檔獨立撰寫，不使用 NFKC；另以建構方式產生空白、有效時間與
// 每一類錯誤。需求 18.3：結果的 HH:MM 通過 State_Validator（isValidState()）對 Route 出發時間、Arrival_Time、Meal 與
// Activity 時間的檢查，空值是 Route 出發時間與 Arrival_Time 的未填時間；不需要去除空白或換成半形的輸入，與既有活動
// 時間的檢查結果相同（8:00、24:00 與 08:00:00 都無效）。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { DESTINATION_REF, normalizeTimeInput } from '../src/itinerary-model.js';
import { isValidState, seed } from '../src/model.js';

const RUNS = { numRuns: 200 };

// ---- 字元 ----
// White_Space 字元（含全形空白、換行、Tab、U+0085 與不換行空白），去除前後空白時一律移除。
const WHITE = [' ', '\u3000', '\t', '\n', '\r', '\v', '\f', '\u0085', '\u00A0', '\u1680', '\u2003', '\u2028', '\u2029', '\u202F', '\u205F'];
// 看不見或像空白、但不是 White_Space 的字元（U+200B、U+FEFF、U+2060、U+180E…）、結合符號與孤立的代理字元。
const INVISIBLE = ['\u200B', '\uFEFF', '\u2060', '\u180E', '\u200D', '\u200E', '\u00AD', '\u061C', '\u0301', '\uD83D', '\uDE00'];
// NFKC 後是數字 d、但不在 U+3000 與 U+FF01–U+FFEE 的相容字元：圈號、上標、下標、數學粗體與雙線數字。
const SUPERSCRIPTS = '\u2070\u00B9\u00B2\u00B3\u2074\u2075\u2076\u2077\u2078\u2079';
const compatDigits = d => [String.fromCodePoint(d ? 0x245f + d : 0x24ea), SUPERSCRIPTS[d], String.fromCodePoint(0x2080 + d),
  String.fromCodePoint(0x1d7ce + d), String.fromCodePoint(0x1d7d8 + d)];
// NFKC 後是冒號的相容字元：U+FE55 SMALL COLON、U+FE13 PRESENTATION FORM FOR VERTICAL COLON。
const COMPAT_COLONS = ['\uFE55', '\uFE13'];
// 其他文字系統的數字（NFKC 不改變）：阿拉伯－印度、擴充阿拉伯－印度、天城文與泰文數字的 0。
const SCRIPT_ZEROS = [0x0660, 0x06f0, 0x0966, 0x0e50];
// 冒號以外的分隔符號（ASCII 的部分也會打成全形）；U+2236、U+02D0、U+A789 與 U+05C3 像冒號，但沒有相容分解。
const SEPARATORS = ['.', '-', ';', ',', '/', '::', ' ', '\u3000', '\t', 'h', '時', '\u2236', '\u02D0', '\uA789', '\u05C3'];
// 時間前後的其他文字
const WORDS = ['AM', ' PM', 'am', 'p.m.', '上午', '下午 ', '晚上', '點', '左右', '約', '~', '+', '-', 'T', 'Z'];
// 容易湊出時間的字元：半形與全形的數字與冒號、相容字元、空白與隱藏字元
const TIMEISH = [...'0123459', ...'０１２３４５９', ':', '：', '\uFE55', '\u2460', '\u00B2', ' ', '\u3000', '\t', '\u200B', 'a'];

// ---- 寫法 ----
const pad2 = n => String(n).padStart(2, '0');
const padding = fc.string({ unit: fc.constantFrom(...WHITE), maxLength: 3 });
// 每個字元依 widths 選擇半形或全形：只有 U+0021–U+007E 有全形寫法（加上 0xFEE0 成為 U+FF01–U+FF5E），其他字元不變。
function typed(text, widths) {
  return [...text].map((char, i) => {
    const code = char.codePointAt(0);
    return widths[i % widths.length] && code >= 0x21 && code <= 0x7e ? String.fromCharCode(code + 0xfee0) : char;
  }).join('');
}
const typing = fc.record({ widths: fc.array(fc.boolean(), { minLength: 16, maxLength: 16 }), lead: padding, trail: padding });
const dress = (body, { widths, lead, trail }) => lead + typed(body, widths) + trail;

const hour = fc.integer({ min: 0, max: 23 }).map(pad2);
const minute = fc.integer({ min: 0, max: 59 }).map(pad2);
const digit = fc.integer({ min: 0, max: 9 });
const clock = fc.tuple(hour, minute).map(([h, m]) => `${h}:${m}`);
// 把 HH:MM 的第 i 個數字（i 為 0 到 3，對應位置 0、1、3、4）換成 swap(該數字)
const swapDigit = (time, i, swap) => {
  const at = [0, 1, 3, 4][i];
  return time.slice(0, at) + swap(Number(time[at])) + time.slice(at + 1);
};

// 空白，以及 00:00 到 23:59 的 HH:MM 加上前後空白、數字與冒號各自打成全形或半形
const blankCase = fc.string({ unit: fc.constantFrom(...WHITE), maxLength: 8 }).map(text => ({ text, value: '' }));
const validCase = fc.tuple(clock, typing).map(([time, how]) => ({ text: dress(time, how), value: time }));

// 每一類錯誤。body 是打成全形或半形之前的寫法；compat 的 nfkc 是整串 NFKC 後的有效時間；invisible 的字元在加上
// 前後空白之後插入任意位置（含前後空白之中）。
const ERROR_SHAPES = {
  // 只有時或分，或少了冒號：08、08:、8:、:30、0830、:
  partial: fc.tuple(hour, minute, fc.nat(5)).map(([h, m, i]) => ({ body: [h, `${h}:`, `${Number(h)}:`, `:${m}`, h + m, ':'][i] })),
  // 一位數的時或分：8:00、08:5、8:5
  'one-digit': fc.tuple(digit, hour, minute, fc.nat(2)).map(([d, h, m, i]) => ({ body: [`${d}:${m}`, `${h}:${d}`, `${d}:${d}`][i] })),
  // 超出範圍：24:00、時為 24 到 99、分為 60 到 99
  range: fc.oneof(
    fc.constant({ body: '24:00' }),
    fc.tuple(fc.integer({ min: 24, max: 99 }), minute).map(([h, m]) => ({ body: `${h}:${m}` })),
    fc.tuple(hour, fc.integer({ min: 60, max: 99 })).map(([h, m]) => ({ body: `${h}:${m}` }))
  ),
  // 含秒數：08:30:00、08:30:
  seconds: fc.tuple(hour, minute, minute, fc.boolean()).map(([h, m, s, colonOnly]) => ({ body: colonOnly ? `${h}:${m}:` : `${h}:${m}:${s}` })),
  // 時或分多一位數：008:30、08:300、08:030
  digits: fc.tuple(hour, minute, fc.nat(2)).map(([h, m, i]) => ({ body: [`0${h}:${m}`, `${h}:${m}0`, `${h}:0${m}`][i] })),
  // 其他文字：冒號以外的分隔符號、時間前後的文字、時間中間的空白、其他文字系統的數字
  text: fc.oneof(
    fc.tuple(hour, fc.constantFrom(...SEPARATORS), minute).map(([h, sep, m]) => ({ body: h + sep + m })),
    fc.tuple(clock, fc.constantFrom(...WORDS), fc.boolean()).map(([time, word, before]) => ({ body: before ? word + time : time + word })),
    fc.tuple(clock, fc.constantFrom(...WHITE), fc.integer({ min: 1, max: 4 })).map(([time, white, at]) => ({ body: time.slice(0, at) + white + time.slice(at) })),
    fc.tuple(clock, fc.nat(3), fc.constantFrom(...SCRIPT_ZEROS)).map(([time, i, zero]) => ({ body: swapDigit(time, i, d => String.fromCodePoint(zero + d)) }))
  ),
  // 不在 U+3000 與 U+FF01–U+FFEE 的相容字元：0⑧:30、²3:00、08﹕30，整串 NFKC 後才是有效時間
  compat: fc.tuple(clock, fc.nat(4), fc.nat()).map(([time, i, pick]) => ({
    body: i === 4 ? time.slice(0, 2) + COMPAT_COLONS[pick % COMPAT_COLONS.length] + time.slice(3) : swapDigit(time, i, d => compatDigits(d)[pick % 5]),
    nfkc: time
  })),
  // 不是 White_Space 的隱藏字元、結合符號與孤立的代理字元不會被當成空白去除（也包括只有這種字元的輸入）
  invisible: fc.tuple(fc.oneof(clock, fc.constant('')), fc.constantFrom(...INVISIBLE), fc.nat()).map(([body, char, at]) => ({ body, insert: { char, at } }))
};
function finish(kind, { body, nfkc, insert }, how) {
  let text = dress(body, how);
  if (insert) {
    const chars = [...text];
    chars.splice(insert.at % (chars.length + 1), 0, insert.char);
    text = chars.join('');
  }
  return { kind, body, text, nfkc };
}
const errorCase = fc.oneof(...Object.entries(ERROR_SHAPES).map(([kind, shape]) => fc.tuple(shape, typing).map(([parts, how]) => finish(kind, parts, how))));

const anyInput = fc.oneof(
  { weight: 2, arbitrary: blankCase.map(entry => entry.text) },
  { weight: 3, arbitrary: validCase.map(entry => entry.text) },
  { weight: 3, arbitrary: errorCase.map(entry => entry.text) },
  { weight: 3, arbitrary: fc.string({ unit: fc.constantFrom(...TIMEISH), maxLength: 9 }) },
  { weight: 1, arbitrary: fc.string({ maxLength: 9 }) },
  { weight: 1, arbitrary: fc.string({ unit: 'grapheme', maxLength: 9 }) },
  { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 9 }) }
);

// ---- 參考判斷 ----
const refTrim = text => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
// 半形（U+0030–U+0039）或全形（U+FF10–U+FF19）數字的值，其他字元為 -1。
function digitValue(char) {
  const code = char.codePointAt(0);
  return code >= 0x30 && code <= 0x39 ? code - 0x30 : code >= 0xff10 && code <= 0xff19 ? code - 0xff10 : -1;
}
function expected(s) {
  const text = refTrim(s);
  if (text === '') return { value: '' };
  const chars = [...text];
  // 兩位數的時、半形或全形（U+FF1A）的冒號、兩位數的分，沒有其他字元
  if (chars.length !== 5 || (chars[2] !== ':' && chars[2] !== '\uFF1A')) return { error: 'invalid' };
  const [h1, h2, m1, m2] = [chars[0], chars[1], chars[3], chars[4]].map(digitValue);
  if (Math.min(h1, h2, m1, m2) < 0) return { error: 'invalid' };
  const h = h1 * 10 + h2, m = m1 * 10 + m2;
  return h <= 23 && m <= 59 ? { value: `${pad2(h)}:${pad2(m)}` } : { error: 'invalid' };
}

// ---- 需求 18.3：State_Validator ----
const BASE = seed();
const DAY = BASE.trip.startDate;
// seed() 加上使用 time 的一個欄位：Route 的出發時間、Arrival_Time、Meal 的時間或既有 Activity 的時間。
function withTime(field, time) {
  const state = structuredClone(BASE);
  if (field === 'route') {
    state.places = [{ id: 'pl1', name: '山下超市' }];
    state.routes = [{ id: 'rt1', date: DAY, vehicleId: state.vehicles[0].id, from: DESTINATION_REF, to: 'pl1', time }];
  } else if (field === 'arrival') {
    state.daySettings = [{ date: DAY, title: '向山裡出發', arrival: time }];
  } else if (field === 'meal') {
    state.meals[0].time = time;
  } else {
    state.activities[0].time = time;
  }
  return state;
}
const accepts = (field, time) => isValidState(withTime(field, time));
// 不需要去除空白或換成半形的輸入：非空白、前後不是 White_Space，也沒有 U+3000 與 U+FF01–U+FFEE 的字元。
const EDGE_WHITE = /^\p{White_Space}|\p{White_Space}$/u, WIDE_FORM = /[\u3000\uFF01-\uFFEE]/u;
const asTyped = s => s !== '' && !EDGE_WHITE.test(s) && !WIDE_FORM.test(s);

describe('Property 16: 時間欄位的正規化', () => {
  test('回傳空值、HH:MM 或錯誤三者之一，與參考判斷相同', () => {
    const seen = new Set();
    fc.assert(fc.property(anyInput, s => {
      const result = normalizeTimeInput(s);
      expect(result).toStrictEqual(expected(s));
      seen.add('error' in result ? 'error' : result.value ? 'time' : 'blank');
    }), RUNS);
    // 產生的輸入涵蓋三種結果
    expect([...seen].sort()).toEqual(['blank', 'error', 'time']);
  });

  test('去除前後空白後為空時為空值；00:00 到 23:59 的 HH:MM 加上前後空白、數字與冒號換成全形時為半形的 HH:MM', () => {
    fc.assert(fc.property(fc.oneof(blankCase, validCase), ({ text, value }) => {
      expect(normalizeTimeInput(text)).toStrictEqual({ value });
    }), RUNS);
  });

  test('只有時或分、一位數的時或分、24:00 以後、含秒數與其他文字為錯誤', () => {
    const seen = new Set();
    fc.assert(fc.property(errorCase, ({ kind, text, nfkc }) => {
      expect(normalizeTimeInput(text)).toStrictEqual({ error: 'invalid' });
      // 只有 U+3000 與 U+FF01–U+FFEE 換成半形：這些輸入要整串 NFKC 後才是有效的時間
      if (nfkc) expect(normalizeTimeInput(text.normalize('NFKC'))).toStrictEqual({ value: nfkc });
      seen.add(kind);
    }), RUNS);
    // 產生的輸入涵蓋每一類錯誤
    expect([...seen].sort()).toEqual(Object.keys(ERROR_SHAPES).sort());
  });

  test('結果的 HH:MM 與空值符合 State_Validator 的定義，不需要正規化的輸入與既有活動時間的檢查結果相同（需求 18.3）', () => {
    const seen = new Set();
    const input = fc.oneof(clock, errorCase.map(entry => entry.body), anyInput);
    fc.assert(fc.property(input, s => {
      const result = normalizeTimeInput(s);
      if ('value' in result) {
        // 再輸入一次不變：已儲存的時間預先填入欄位後原樣儲存
        expect(normalizeTimeInput(result.value)).toStrictEqual(result);
        // 空值是未填時間（需求 18.3(b)）：Route 的出發時間與 Arrival_Time 可以留空，Meal 與 Activity 的時間要有值
        expect(accepts('route', result.value)).toBe(true);
        expect(accepts('arrival', result.value)).toBe(true);
        if (result.value) {
          expect(accepts('meal', result.value)).toBe(true);
          expect(accepts('activity', result.value)).toBe(true);
        }
      }
      if (asTyped(s)) {
        // 有效若且唯若既有活動時間的檢查接受，有效時結果就是輸入本身
        const valid = accepts('activity', s);
        expect(result).toStrictEqual(valid ? { value: s } : { error: 'invalid' });
        seen.add(valid ? 'time' : 'error');
      }
    }), RUNS);
    expect([...seen].sort()).toEqual(['error', 'time']);
  });
});
