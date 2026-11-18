// Feature: trip-planning-workflow-enhance, Property 8: 行程圖的結構與資料相符
// **Validates: Requirements 1.8, 11.1, 11.2, 11.3, 11.5, 11.15, 11.19, 16.2**
//
// 對每一組通過驗證的 Trip_State s，把 posterHtml(s) 解析成元素樹，檢查：
// - 沒有任何 Route、Legacy_Departure、Activity 與 Meal：有「這趟旅行還沒有行程」提示、沒有每日段落；
// - 否則每個 Trip_Day 恰有一個 [data-poster-day] 段落與一個第 3 層標題，天數徽章為補零兩位數，色調為 day-tone-{(n-1)%3}；
// - 「地點：」行只在 showLocationLine 時出現，Day_Caption 等於 dayModel() 的規則值；
// - 每條路線恰有一組 .rm-lane，舊出發標記沒有；
// - 「路線僅為示意…」只在有路線或舊出發資料時出現；
// - 每個路線區塊與活動區塊各是無障礙名稱為「路線」「活動」的清單。
// 道路、終點插畫與停車位依終點組的規則由 Property 23 檢查。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { dayModel, tripDays } from '../src/itinerary-derive.js';
import { posterHtml } from '../src/itinerary-poster.js';
import { isValidState } from '../src/model.js';
import { exampleTrip } from './fixtures/example-trip.js';
import { itineraryState, legacyState } from './support/itinerary-arb.js';

const bounded = numRuns => ({
  numRuns, includeErrorInReport: true, plugins: [fc.interruptAfterTimeLimit(30_000, { failOnInterrupt: true })]
});
const TIMEOUT = 60_000;

// ---- 小型 HTML 解析器 ----
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
      continue;
    } else if (closing) {
      let node = current;
      while (node !== root && node.tag !== name.toLowerCase()) node = node.parent;
      if (node !== root) current = node.parent;
    } else {
      const attrs = {};
      for (const [, key, value] of rest.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[key] = decode(value);
      if (/\sdata-poster-day(\s|$)/.test(` ${rest} `)) attrs['data-poster-day'] = '';
      const node = { tag: name.toLowerCase(), attrs, children: [], parent: current };
      current.children.push(node);
      if (!selfClosing && !VOID.has(node.tag)) current = node;
    }
  }
  return root;
}
const isElement = node => node.tag !== undefined;
const classes = node => (node.attrs.class ?? '').split(/\s+/);
function all(node, test_ = () => true, found = []) {
  if (!isElement(node)) return found;
  if (test_(node)) found.push(node);
  for (const child of node.children) all(child, test_, found);
  return found;
}
const hasClass = (node, name) => classes(node).includes(name);
const text = node => (isElement(node) ? node.children.map(text).join('') : node.text);

const DISCLAIMER = '路線僅為示意，非導航或即時位置；不預估返抵時間。';

function check(state, seen) {
  const html = posterHtml(state);
  const root = parse(html);
  const days = tripDays(state);
  const models = days.map(day => dayModel(state, day.date));
  const route = models.reduce((sum, m) => sum + m.blocks.filter(b => b.type === 'routes').length, 0);
  const hasContent = models.some(m => m.blocks.length > 0);
  const sections = all(root, n => n.attrs['data-poster-day'] !== undefined);
  const hasRoutes = route > 0;

  // 路線僅為示意…：只在有路線或舊出發資料時出現
  expect(html.includes(DISCLAIMER)).toBe(hasRoutes);

  if (!hasContent) {
    seen.add('empty');
    expect(text(root)).toContain('這趟旅行還沒有行程');
    expect(sections.length).toBe(0);
    return;
  }
  seen.add('content');
  expect(text(root)).not.toContain('這趟旅行還沒有行程');
  expect(sections.length).toBe(days.length);

  sections.forEach((section, index) => {
    const model = models[index];
    expect(all(section, n => n.tag === 'h3').length).toBe(1);
    const badge = all(section, n => hasClass(n, 'day-badge'))[0];
    expect(text(badge)).toBe(String(model.n).padStart(2, '0'));
    expect(classes(section)).toContain(`day-tone-${(model.n - 1) % 3}`);

    const locations = all(section, n => hasClass(n, 'day-location'));
    expect(locations.length).toBe(model.showLocationLine ? 1 : 0);
    if (model.showLocationLine) {
      seen.add('location');
      expect(text(locations[0]).startsWith('地點：')).toBe(true);
    } else seen.add('nolocation');

    const meta = all(section, n => hasClass(n, 'day-meta'))[0];
    expect(text(meta).endsWith(model.caption)).toBe(true);
    if (model.caption.startsWith('今天，')) seen.add('idle-caption');
    else seen.add('departure-caption');

    // 路線與活動區塊的清單
    const blockLists = all(section, n => n.tag === 'ul' && (n.attrs['aria-label'] === '路線' || n.attrs['aria-label'] === '活動'));
    const lanes = blockLists.filter(n => n.attrs['aria-label'] === '路線');
    const acts = blockLists.filter(n => n.attrs['aria-label'] === '活動');
    expect(lanes.length).toBe(model.blocks.filter(b => b.type === 'routes').length);
    expect(acts.length).toBe(model.blocks.filter(b => b.type !== 'routes').length);

    // 每條路線恰有一組 .rm-lane，舊出發標記沒有
    const tracks = all(section, n => hasClass(n, 'rm-track'));
    for (const track of tracks) {
      const lane = all(track, n => hasClass(n, 'rm-lane')).length;
      if (track.attrs['data-line'] === 'legacy') { expect(lane).toBe(0); seen.add('legacy'); }
      else { expect(track.attrs['data-line']).toBe('route'); expect(lane).toBe(1); seen.add('route'); }
    }
    const expected = model.blocks.filter(b => b.type === 'routes').reduce((sum, b) => sum + b.lines.length, 0);
    expect(tracks.length).toBe(expected);
  });
}

describe('Property 8: 行程圖的結構與資料相符', () => {
  test('itineraryState()', () => {
    const seen = new Set();
    fc.assert(fc.property(itineraryState(), state => {
      expect(isValidState(state)).toBe(true);
      check(state, seen);
    }), bounded(100));
    expect(['content', 'route', 'location'].filter(k => !seen.has(k))).toEqual([]);
  }, TIMEOUT);

  test('itineraryState({ markup: true })', () => {
    fc.assert(fc.property(itineraryState({ markup: true }), state => {
      expect(isValidState(state)).toBe(true);
      check(state, new Set());
    }), bounded(100));
  }, TIMEOUT);

  test('legacyState()：舊出發標記沒有線條與接力元素', () => {
    const seen = new Set();
    fc.assert(fc.property(legacyState(), state => {
      fc.pre(isValidState(state));
      check(state, seen);
    }), bounded(100));
    expect(seen.has('legacy')).toBe(true);
  }, TIMEOUT);

  test('需求文件的 Example_Trip', () => {
    const seen = new Set();
    check(exampleTrip(), seen);
    expect(seen.has('route')).toBe(true);
  });

  test('沒有任何行程時顯示空白提示', () => {
    const seen = new Set();
    const base = exampleTrip();
    check({ ...base, routes: [], activities: [], meals: [], vehicles: base.vehicles.map(v => ({ ...v, departure: undefined })) }, seen);
  });
});
