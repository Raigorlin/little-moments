// Feature: trip-planning-workflow-enhance, Property 7: 行程圖與文字版的內容與順序一致
// **Validates: Requirements 8.1, 11.4, 11.5, 11.7, 11.9, 11.10, 16.1**
//
// 對每一組通過驗證的 Trip_State s，把 posterHtml(s) 解析成元素樹（本檔的小型解析器，不依賴 DOM），依文件順序取出帶
// data-line 的元素（day、route、legacy、arrival、return、activity、meal），再與 itineraryText(s) 的各行比對：
// (a) 順序：依序走過文字版的行（略去空行與區塊標題「路線」「活動」），每個元素恰好對應下一批行——day 為「第 N 天・…」
//     （N 依序為 1、2、…，data-id 為該日期；有地點行時多一行）、route 與 legacy 與到達行、返程行各一行、activity 為項目行
//     加上元素中有的「地點：」「參加：」「備註：」行（依 moment-location、moment-participants、moment-note 的順序）、
//     meal 為項目行加上元素中有 moment-ingredients 時的食材行。全部元素走完之後，文字版沒有剩下任何行。
// (b) 內容：每個元素去除 aria-hidden 子樹後的文字，包含對應各行以「｜：（）、→・」與空白切開的每一段文字（日期、
//     Day_Title、時間、車名、地點、任務類型、Shopping_Summary、備註、活動標題、Activity_Category、餐次、料理名稱、
//     Meal_Label、食材與參加者）；到達行與返程行的文字與文字版的行相同；每日標題所在的段落包含 Day_Location 的名稱。
// 沒有任何路線、活動與餐點的 Trip_State 沒有帶 data-line 的元素，行程圖顯示「這趟旅行還沒有行程」，文字版也沒有區塊。
// 三個屬性測試使用不同的產生器：itineraryState()、itineraryState({ markup: true })（HTML 標記與 XSS 字串，文字原樣比對）
// 與 legacyState()（本功能之前的 Trip_State）；最後一個測試比對需求文件的 Example_Trip。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { monthDay, dateText } from '../src/itinerary-model.js';
import { posterHtml } from '../src/itinerary-poster.js';
import { itineraryText } from '../src/itinerary-text.js';
import { dateRange, isValidState } from '../src/model.js';
import { exampleTrip } from './fixtures/example-trip.js';
import { itineraryState, legacyState } from './support/itinerary-arb.js';

const bounded = numRuns => ({
  numRuns, includeErrorInReport: true, plugins: [fc.interruptAfterTimeLimit(30_000, { failOnInterrupt: true })]
});
const TIMEOUT = 60_000;

// ---- 小型 HTML 解析器（posterHtml() 的輸出只含程式產生的標籤，使用者值都已經跳脫） ----
const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'wbr']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = text => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
  if (name[0] === '#') return String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
  return ENTITIES[name.toLowerCase()] ?? whole;
});

function parse(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  let current = root;
  const pattern = /<!--[\s\S]*?-->|<(\/?)([A-Za-z][\w:-]*)([^>]*?)(\/?)>|([^<]+)/g;
  for (const match of html.matchAll(pattern)) {
    const [, closing, name, rest, selfClosing, text] = match;
    if (text !== undefined) {
      current.children.push({ text: decode(text) });
    } else if (name === undefined) {
      continue; // 註解
    } else if (closing) {
      let node = current;
      while (node !== root && node.tag !== name.toLowerCase()) node = node.parent;
      if (node !== root) current = node.parent;
    } else {
      const attrs = {};
      for (const [, key, value] of rest.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[key] = decode(value);
      const node = { tag: name.toLowerCase(), attrs, children: [], parent: current };
      current.children.push(node);
      if (!selfClosing && !VOID.has(node.tag)) current = node;
    }
  }
  return root;
}
const isElement = node => node.tag !== undefined;
/** 去除 aria-hidden 子樹、<style> 與 <script> 之後的文字。 */
function visible(node) {
  if (!isElement(node)) return node.text;
  if (node.attrs['aria-hidden'] === 'true' || node.tag === 'style' || node.tag === 'script') return '';
  return node.children.map(visible).join('');
}
function walk(node, visit) {
  if (!isElement(node)) return;
  visit(node);
  for (const child of node.children) walk(child, visit);
}
const classes = node => (node.attrs.class ?? '').split(/\s+/);
/** node 之下（不含 aria-hidden 子樹）帶 className 的元素，依文件順序。 */
function withClass(node, names) {
  const found = [];
  const go = element => {
    if (!isElement(element) || element.attrs['aria-hidden'] === 'true') return;
    const hit = classes(element).find(name => names.includes(name));
    if (hit) found.push(hit);
    element.children.forEach(go);
  };
  go(node);
  return found;
}

// ---- 比對 ----
const DELIMITER = /[\p{White_Space}｜：（）、，→・]+/u;
/** 一行文字的每一段文字（固定的「N 出發」只保留時間）。 */
const tokensOf = line => line.replace(/(\d\d:\d\d) 出發/g, '$1').split(DELIMITER).filter(Boolean);
const EXTRA_PREFIX = { 'moment-location': '地點：', 'moment-participants': '參加：', 'moment-note': '備註：' };
const TIME_ITEM = /^\d\d:\d\d /;

/** 回傳 text 中沒有出現在 shown 的每一段文字。 */
const missingTokens = (lines, shown) => lines.flatMap(tokensOf).filter(token => !shown.includes(token));

function checkPoster(state, seen) {
  const text = itineraryText(state);
  const lines = text.split('\n');
  const root = parse(posterHtml(state));
  const elements = [];
  walk(root, node => { if (node.attrs['data-line'] !== undefined) elements.push(node); });
  const dates = dateRange(state.trip.startDate, state.trip.endDate);

  if (!elements.length) {
    // 沒有任何行程：行程圖顯示空白提示，文字版只有每日標題
    expect(visible(root)).toContain('這趟旅行還沒有行程');
    expect(lines.some((line, i) => (line === '路線' || line === '活動') && lines[i - 1] === '')).toBe(false);
    seen.add('empty');
    return;
  }

  // 第一個每日標題：前面是空行（標題、旅行介紹與車輛行之後）
  let at = lines.findIndex((line, i) => i > 0 && lines[i - 1] === '' && line.startsWith('第 1 天・'));
  expect(at).toBeGreaterThan(-1);
  const take = () => {
    while (at < lines.length && lines[at] === '') {
      at += 1;
      if (lines[at] === '路線' || lines[at] === '活動') at += 1;
    }
    expect(at).toBeLessThan(lines.length);
    return lines[at++];
  };

  let day = 0, dayScope = '';
  for (const element of elements) {
    const kind = element.attrs['data-line'];
    seen.add(kind);
    const shown = visible(element);
    const problem = (what, extra) => ({ kind, id: element.attrs['data-id'], what, extra });
    if (kind === 'day') {
      day += 1;
      const header = take();
      expect(header.startsWith(`第 ${day} 天・${monthDay(dates[day - 1])}`)).toBe(true);
      expect(element.attrs['data-id']).toBe(dates[day - 1]);
      // 有地點行時（下一行不是空行）多一行
      const location = at < lines.length && lines[at] !== '' ? take() : null;
      if (location !== null) expect(location.startsWith('地點：')).toBe(true);
      let section = element;
      while (section.parent && !section.attrs['data-poster-day']) section = section.parent;
      dayScope = visible(section);
      const head = visible(element.parent);
      expect({ ...problem('每日標題', header), missing: missingTokens([header], head) }).toEqual({ ...problem('每日標題', header), missing: [] });
      expect(head).toContain(dateText(dates[day - 1]));
      if (location !== null) {
        expect({ ...problem('地點行', location), missing: missingTokens([location.slice(3)], dayScope) })
          .toEqual({ ...problem('地點行', location), missing: [] });
        seen.add('location');
      }
      continue;
    }
    if (kind === 'route' || kind === 'legacy') {
      const line = take();
      expect({ ...problem('路線行', line), missing: missingTokens([line], shown) }).toEqual({ ...problem('路線行', line), missing: [] });
      continue;
    }
    if (kind === 'arrival' || kind === 'return') {
      const line = take();
      expect(shown.trim()).toBe(line);
      continue;
    }
    if (kind === 'activity') {
      const own = [take()];
      expect(TIME_ITEM.test(own[0])).toBe(true);
      for (const name of withClass(element, Object.keys(EXTRA_PREFIX))) {
        const extra = take();
        expect(extra.startsWith(EXTRA_PREFIX[name])).toBe(true);
        own.push(extra);
      }
      expect({ ...problem('活動', own), missing: missingTokens(own, shown) }).toEqual({ ...problem('活動', own), missing: [] });
      continue;
    }
    expect(kind).toBe('meal');
    const own = [take()];
    expect(TIME_ITEM.test(own[0])).toBe(true);
    if (withClass(element, ['moment-ingredients']).length) own.push(take());
    expect({ ...problem('餐點', own), missing: missingTokens(own, shown) }).toEqual({ ...problem('餐點', own), missing: [] });
    if (own.length > 1) seen.add('ingredients');
  }
  // 文字版沒有剩下任何行
  expect(lines.slice(at).filter(line => line !== '')).toEqual([]);
  expect(day).toBe(dates.length);
}

const missing = (seen, required) => required.filter(name => !seen.has(name));
const BASIC = ['day', 'route', 'activity', 'meal'];

describe('Property 7: 行程圖與文字版的內容與順序一致', () => {
  test('itineraryState()：行程圖的元素與文字版的行順序與內容相同', () => {
    const seen = new Set();
    fc.assert(fc.property(itineraryState(), state => {
      expect(isValidState(state)).toBe(true);
      checkPoster(state, seen);
    }), bounded(100));
    expect(missing(seen, [...BASIC, 'arrival', 'location', 'ingredients'])).toEqual([]);
  }, TIMEOUT);

  test('使用者文字為 HTML 標記與 XSS 字串：行程圖的文字與文字版的行相同', () => {
    const seen = new Set();
    fc.assert(fc.property(itineraryState({ markup: true }), state => {
      expect(isValidState(state)).toBe(true);
      checkPoster(state, seen);
    }), bounded(100));
    expect(missing(seen, BASIC)).toEqual([]);
  }, TIMEOUT);

  test('legacyState()：舊出發資料與舊活動類型', () => {
    const seen = new Set();
    fc.assert(fc.property(legacyState(), state => {
      fc.pre(isValidState(state));
      checkPoster(state, seen);
    }), bounded(100));
    expect(missing(seen, ['day', 'legacy', 'activity'])).toEqual([]);
  }, TIMEOUT);

  test('需求文件的 Example_Trip', () => {
    const seen = new Set();
    checkPoster(exampleTrip(), seen);
    expect(missing(seen, [...BASIC, 'arrival', 'return', 'ingredients'])).toEqual([]);
  });
});
