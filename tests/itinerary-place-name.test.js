// Feature: trip-planning-workflow-enhance, Property 15: 地點名稱的同名比較與錯誤原因
// **Validates: Requirements 2.1, 2.2**
//
// placeKey()：同一個名稱的全形與半形寫法（U+FF01–U+FF5E 與對應的 ASCII 字元、U+3000 與半形空白）、A 到 Z 的
// 大小寫與前後空白都得到相同的結果，重複套用不改變結果；含 ①、² 等不在 U+3000 與 U+FF01–U+FFEE 的相容字元時，
// 與其 NFKC 結果不同名（設計「需求解讀」第 4 點）。
// placeNameError()：依「空白、超過 50 字、含控制字元、同名」的順序回傳第一個不符合的原因，全部符合時為 null。
// 參考判斷中的去除空白、字數與控制字元在本檔獨立撰寫；同名依設計「文字規則」的定義是 placeKey() 相等，
// 另以建構方式確認：只換寫全形半形、大小寫與前後空白的名稱一定被判為同名。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { PLACE_NAME_MESSAGES, placeKey, placeNameError } from '../src/itinerary-model.js';

const RUNS = { numRuns: 200 };
const MAX_NAME = 50; // 需求 2.1(b)
// 需求 2.2 與設計「文字規則」的錯誤訊息
const MESSAGES = {
  empty: '請填寫地點名稱。',
  long: '地點名稱最多 50 個字。',
  control: '地點名稱不能包含換行、Tab 或隱藏的控制字元。',
  duplicate: '已有同名地點'
};

// ---- 字元 ----
// White_Space 字元（含全形空白、換行、Tab 與 U+0085），去除前後空白時一律移除（需求 2.1(a)）。
const WHITE = [' ', '\u3000', '\t', '\n', '\r', '\v', '\f', '\u0085', '\u00A0', '\u1680', '\u2003', '\u2028', '\u2029', '\u202F', '\u205F'];
// 類別 Cc 與 Cf 的字元（需求 2.1(c)）。\t、\n 與 U+0085 同時是 White_Space，在名稱前後時會被去除；
// U+180E、U+200B、U+2060 與 U+FEFF 看起來是空白，但不是 White_Space。
const CONTROL = ['\u0000', '\u0007', '\t', '\n', '\u001B', '\u007F', '\u0085', '\u009F', '\u00AD', '\u061C', '\u180E', '\u200B',
  '\u200C', '\u200D', '\u200E', '\u202E', '\u2060', '\u2066', '\uFEFF', '\u{E0001}'];
// 兩種寫法中都不變的字元：中文、全形與半形片假名（U+FF9E、U+FF9F 摺疊後是結合用的濁點與半濁點）、U+FF5F–U+FFEE
// 的其他字元（U+FFE3 摺疊後是半形空白加 U+0304）、結合符號、組合字與單一對應字（U+212A KELVIN SIGN 經 NFC 成為 K）、
// 相容字元、不換行空白、emoji、變體選擇符與連接兩個 emoji 的零寬連接符。都不是 Cc 或 Cf。
const PLAIN = ['夕', '淞', '度', '日', '營', '區', '台', '北', '超', '市', 'カ', 'ガ', 'ｶ', 'ﾊ', 'ﾞ', 'ﾟ', '｡', '｟', 'ﾡ', '￠', '￣', '￦', '￨',
  '\u0300', '\u0301', '\u0308', '\u030C', '\u0316', '\u0338', '\u3099', 'é', 'Á', 'ǰ', 'ß', 'İ', 'ı', '\u212A', '\u212B', '\u2126',
  '①', '²', 'ﬁ', 'Ⅳ', 'ſ', '™', '㍻', '\u00A0', '😀', '\uFE0F', '👨\u200D👩\u200D👧', '🏳\uFE0F\u200D🌈', '👩🏽\u200D💻'];
const LONE_SURROGATES = ['\uD83D', '\uDE00'];
// 經全形半形摺疊、NFC 與轉小寫會互相影響的字元，密集排列以檢查重複套用。
const DENSE = ['A', 'a', 'J', 'j', 'K', 'Ａ', 'ｊ', ' ', '\u3000', '\t', '\u0085', '\u00A0', '<', '＜', 'ｶ', 'ﾞ', '\uFFE3', '\u0301', '\u0304',
  '\u0307', '\u030C', '\u0316', '\u0338', '\u3099', 'ſ', '\u212A', '\u212B', '①', '\u200D', '😀', ...LONE_SURROGATES];
// 有相容分解、不是 White_Space、不在 U+3000 與 U+FF01–U+FFEE、經 NFC 不變的字元。
const COMPAT = ['①', '⑩', '²', '₂', '½', 'ﬁ', 'Ⅳ', 'ⅳ', 'ſ', 'µ', 'ª', '™', '℃', '㎏', '㍻', '㈱', '…', 'ǅ', 'ĳ', '№'];

// ---- 同一個名稱的兩種寫法 ----
// 名稱由字元單位組成。ascii（U+0021–U+007E）與 space（U+0020）在寫法 a、b 中各自選擇全形或半形，
// 字母另外選擇大小寫；fixed 在兩種寫法中相同。
const choice = fc.record({ wide: fc.boolean(), upper: fc.boolean() });
const asciiToken = fc.record({ kind: fc.constant('ascii'), code: fc.integer({ min: 0x21, max: 0x7e }), a: choice, b: choice });
const spaceToken = fc.record({ kind: fc.constant('space'), a: choice, b: choice });
const fixedToken = texts => fc.constantFrom(...texts).map(text => ({ kind: 'fixed', text }));
const graphemeToken = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 1 }).map(text => ({ kind: 'fixed', text }));
const toTokens = text => [...text].map(codePoint => ({ kind: 'fixed', text: codePoint }));
const withToken = (tokens, token, at) => {
  const index = at % (tokens.length + 1);
  return [...tokens.slice(0, index), token, ...tokens.slice(index)];
};

const isLetter = code => (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
// placeKey() 先做 NFC 再把 A 到 Z 轉成小寫，所以 A + U+0301 成為 Á、a + U+0301 成為 á，兩者不同名。
// 後面接著結合符號的字母（U+FF9E 與 U+FF9F 摺疊後也是結合符號）在兩種寫法中保持相同的大小寫，其他字母可以換。
const MARK_AHEAD = /^[\p{M}\uFF9E\uFF9F]/u;
const caseFree = (tokens, i) => !(tokens[i + 1]?.kind === 'fixed' && MARK_AHEAD.test(tokens[i + 1].text));

function render(tokens, side) {
  return tokens.map((token, i) => {
    if (token.kind === 'fixed') return token.text;
    const { wide, upper } = token[side];
    if (token.kind === 'space') return wide ? '\u3000' : ' ';
    let code = token.code;
    if (isLetter(code)) code = (caseFree(tokens, i) ? upper : token.a.upper) ? code & ~0x20 : code | 0x20;
    return String.fromCharCode(wide ? code + 0xfee0 : code);
  }).join('');
}

const padding = fc.string({ unit: fc.constantFrom(...WHITE), maxLength: 3 });
const anyToken = fc.oneof(
  { weight: 6, arbitrary: asciiToken },
  { weight: 1, arbitrary: spaceToken },
  { weight: 3, arbitrary: fixedToken(PLAIN) },
  { weight: 1, arbitrary: fixedToken([...CONTROL, ...WHITE, ...LONE_SURROGATES]) },
  { weight: 1, arbitrary: graphemeToken }
);
const nameToken = fc.oneof(
  { weight: 6, arbitrary: asciiToken },
  { weight: 1, arbitrary: spaceToken },
  { weight: 3, arbitrary: fixedToken(PLAIN) },
  { weight: 1, arbitrary: graphemeToken }
);

// ---- 參考判斷 ----
const refTrim = text => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
const CC_CF = /^[\p{Cc}\p{Cf}]$/u, PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const SELECTOR = /^\p{Variation_Selector}$/u, MODIFIER = /^\p{Emoji_Modifier}$/u;
const is = (pattern, codePoint) => codePoint !== undefined && pattern.test(codePoint);
// 連接兩個 emoji 的零寬連接符（與旅伴名字的規則相同）：前面是 emoji，之後可接一個變體選擇符、再接一個膚色修飾符；
// 後面也是 emoji。
function joinsEmoji(codePoints, i) {
  let j = i - 1;
  if (is(MODIFIER, codePoints[j])) j--;
  if (is(SELECTOR, codePoints[j])) j--;
  return is(PICTOGRAPHIC, codePoints[j]) && is(PICTOGRAPHIC, codePoints[i + 1]);
}
const refHasControl = text => [...text].some((codePoint, i, codePoints) =>
  CC_CF.test(codePoint) && !(codePoint === '\u200D' && joinsEmoji(codePoints, i)));

function expectedError(name, { places = [], destination = '', exceptId, pending = [] }) {
  const text = refTrim(name);
  if (!text) return 'empty';
  if ([...text].length > MAX_NAME) return 'long';
  // 控制字元檢查只看去除前後空白後的名稱（設計「需求解讀」第 3 點）。
  if (refHasControl(text)) return 'control';
  const others = [
    ...places.filter(place => place.id !== exceptId).map(place => place.name),
    ...(refTrim(destination) ? [destination] : []),
    ...pending.map(entry => (typeof entry === 'string' ? entry : entry.name))
  ];
  return others.some(other => placeKey(other) === placeKey(name)) ? 'duplicate' : null;
}

// ---- placeNameError() 的情境 ----
// 地點清單、旅行目的地與 Draft 中新增地點的名稱：多半是短名稱，也有 44 到 56 個單位的長名稱；
// 少數含有控制字元（不合規的資料也要能比較）。
const sourceTokens = fc.record({
  tokens: fc.oneof(
    { weight: 3, arbitrary: fc.array(nameToken, { minLength: 1, maxLength: 10 }) },
    { weight: 1, arbitrary: fc.array(nameToken, { minLength: 44, maxLength: 56 }) }
  ),
  control: fc.oneof({ weight: 9, arbitrary: fc.constant(null) }, { weight: 1, arbitrary: fixedToken(CONTROL) }),
  at: fc.nat()
}).map(({ tokens, control, at }) => (control ? withToken(tokens, control, at) : tokens));
const rawName = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.string({ unit: 'grapheme', maxLength: 8 }),
  fc.string({ unit: 'binary', maxLength: 8 }),
  fc.string({ unit: fc.constantFrom(...PLAIN, ...CONTROL, ...WHITE), maxLength: 8 })
);
// 50 字上下：一個字元重複 49 到 51 次（😀 是兩個 UTF-16 單位、一個碼位）。
const edgeName = fc.tuple(fc.constantFrom('地', 'Ａ', '😀'), fc.integer({ min: 49, max: 51 })).map(([char, count]) => char.repeat(count));

function buildScenario({ places, destination, pending, except, candidate, insert, lead, trail }) {
  const placeList = places.map((tokens, i) => ({ id: `p${i}`, name: render(tokens, 'a') }));
  const pendingList = pending.map(({ tokens, shape }, i) => {
    const name = render(tokens, 'a');
    return shape === 'string' ? name : shape === 'name' ? { name } : { id: `new:${i + 1}`, name };
  });
  // 候選名稱可以是這些名稱之一的另一種寫法
  const sources = [
    ...places.map((tokens, i) => ({ tokens, placeId: `p${i}` })),
    ...(Array.isArray(destination) ? [{ tokens: destination }] : []),
    ...pending.map(({ tokens }) => ({ tokens }))
  ];
  const source = candidate.type === 'variant' && sources.length ? sources[candidate.pick % sources.length] : null;
  const exceptId = { none: undefined, source: source?.placeId, first: placeList[0]?.id, missing: 'p-missing' }[except];
  let tokens = source ? source.tokens : candidate.tokens;
  if (insert) tokens = withToken(tokens, insert.token, insert.at);
  const name = lead + render(tokens, source ? 'b' : 'a') + trail;
  const ctx = {
    places: placeList,
    destination: Array.isArray(destination) ? render(destination, 'a') : destination,
    exceptId,
    pending: pendingList
  };
  // 只換寫全形半形、大小寫與前後空白，且來源仍是比較對象：依需求 2.1(d) 一定同名。
  const sameName = Boolean(source) && !insert && (!source.placeId || source.placeId !== exceptId);
  return { name, ctx, sameName };
}

const scenario = fc.record({
  places: fc.array(sourceTokens, { maxLength: 5 }),
  destination: fc.oneof(padding, sourceTokens),
  pending: fc.array(fc.record({ tokens: sourceTokens, shape: fc.constantFrom('string', 'name', 'draft') }), { maxLength: 3 }),
  except: fc.constantFrom('none', 'source', 'first', 'missing'),
  candidate: fc.oneof(
    { weight: 4, arbitrary: fc.record({ type: fc.constant('variant'), pick: fc.nat(), tokens: sourceTokens }) },
    { weight: 3, arbitrary: fc.record({ type: fc.constant('fresh'), tokens: sourceTokens }) },
    { weight: 1, arbitrary: fc.record({ type: fc.constant('blank'), tokens: padding.map(toTokens) }) },
    { weight: 1, arbitrary: fc.record({ type: fc.constant('edge'), tokens: edgeName.map(toTokens) }) },
    { weight: 1, arbitrary: fc.record({ type: fc.constant('raw'), tokens: rawName.map(toTokens) }) }
  ),
  insert: fc.oneof({ weight: 3, arbitrary: fc.constant(null) }, { weight: 1, arbitrary: fc.record({ token: fixedToken(CONTROL), at: fc.nat() }) }),
  lead: padding,
  trail: padding
}).map(buildScenario);

describe('Property 15: 地點名稱的同名比較與錯誤原因', () => {
  test('全形與半形寫法、A 到 Z 的大小寫與前後空白不改變 placeKey()', () => {
    fc.assert(fc.property(fc.array(anyToken, { maxLength: 16 }), padding, padding, padding, padding, (tokens, leadA, trailA, leadB, trailB) => {
      expect(placeKey(leadB + render(tokens, 'b') + trailB)).toBe(placeKey(leadA + render(tokens, 'a') + trailA));
    }), RUNS);
  });

  test('placeKey() 重複套用不改變結果', () => {
    const anyName = fc.oneof(
      fc.tuple(padding, fc.array(anyToken, { maxLength: 16 }), padding).map(([lead, tokens, trail]) => lead + render(tokens, 'a') + trail),
      fc.string({ unit: fc.constantFrom(...DENSE), maxLength: 12 }),
      fc.string({ unit: 'grapheme', maxLength: 12 }),
      fc.string({ unit: 'binary', maxLength: 12 })
    );
    fc.assert(fc.property(anyName, name => {
      const key = placeKey(name);
      expect(placeKey(key)).toBe(key);
    }), RUNS);
  });

  test('含 U+3000 與 U+FF01–U+FFEE 以外的相容字元時，與其 NFKC 結果不同名', () => {
    const side = fc.array(anyToken, { maxLength: 8 }).map(tokens => render(tokens, 'a'));
    const target = fc.constantFrom('place', 'destination', 'pending');
    fc.assert(fc.property(side, fc.constantFrom(...COMPAT), side, target, (left, compat, right, where) => {
      const name = left + compat + right;
      const folded = name.normalize('NFKC');
      expect(placeKey(name)).not.toBe(placeKey(folded));
      // 例如「①」不因已有「1」而被判為同名
      const ctx = { place: { places: [{ id: 'p0', name: folded }] }, destination: { destination: folded }, pending: { pending: [folded] } }[where];
      expect(placeNameError(name, ctx)).not.toBe('duplicate');
    }), RUNS);
  });

  test('placeNameError() 依空白、超過 50 字、含控制字元、同名的順序回傳第一個原因，都符合時為 null', () => {
    const seen = new Set();
    fc.assert(fc.property(scenario, ({ name, ctx, sameName }) => {
      const reason = placeNameError(name, ctx);
      expect(reason).toBe(expectedError(name, ctx));
      // 與比較對象同名的名稱一定有不符合的原因（不會是 null）
      if (sameName) expect(reason).not.toBeNull();
      if (reason !== null) expect(PLACE_NAME_MESSAGES[reason]).toBe(MESSAGES[reason]);
      seen.add(String(reason));
    }), RUNS);
    // 產生的情境涵蓋每一種結果
    expect([...seen].sort()).toEqual(['control', 'duplicate', 'empty', 'long', 'null']);
  });
});
