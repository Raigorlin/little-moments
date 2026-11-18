// Feature: trip-planning-workflow-enhance, Property 23: 終點不同的路線不共用道路
// **Validates: Requirements 11.5, 11.6, 12.10, 13.1, 17.2, 17.3**
//
// 以 tests/support/itinerary-arb.js 的 endMixState() 產生通過驗證的 Trip_State（路線區塊有 1 到 12 條路線、1 到 4 個
// 交錯的終點，First_Day 的 Arrival 區塊可夾著舊出發資料）。對每一天 dayModel() 的每個路線區塊 block：
// (a) 以 HTMLRewriter 解析 posterHtml() 的 `.route-map`：每個終點組恰有一個 `.rm-road` 與一個 `.rm-end`，兩者的 --g 依
//     組的順序為 1..G；`.rm-end` 的停車位數等於該組的 count，第 i 個停車位的顏色類別是該組第 i 條路線的 car-{index}；
//     每條路線的 --g 是它所屬的組，舊出發資料沒有 --g。
// (b) routeMapLayout(block) 的橫式結果：列段依組的順序相連、互不重疊並涵蓋每一列；列不在自己那一組列段的路線是繞回的
//     線條，目標列是自己那一組列段的最後一列且在所在列之上；匯流支線序號互不相同，同一列中的匯入點互不相同且不等於航點
//     高度（26）；沒有繞回的線條（只有一組，或每一組的路線彼此相連）時 cw 為 0；minHeight 為 26 + 10 × m + 12。
// (c) 直式結果：左側道路屬於最後一組；其他組的每條路線都有支線並延伸到自己那一組的終點列；支線序號互不相同，由右往左
//     依組的順序排列；只有一組時，支線恰為有 Stop 的路線。
// (d) 對同一個區塊執行兩次，結果相同，輸入不變。
// 預期值都在本檔依設計直接算出，不使用 routeMapLayout() 的內部結果推導。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { carColorIndex, dayModel, shoppingPlan } from '../src/itinerary-derive.js';
import { posterHtml, routeMapLayout } from '../src/itinerary-poster.js';
import { dateRange, isValidState } from '../src/model.js';
import { endMixState } from './support/itinerary-arb.js';

const OPTIONS = { numRuns: 100, plugins: [fc.interruptAfterTimeLimit(45000, { failOnInterrupt: true })] };
const TIMEOUT = 90000;

const style = (text, name) => {
  const found = new RegExp(`--${name}:(-?\\d+)`).exec(text ?? '');
  return found ? Number(found[1]) : null;
};
const colorClass = text => /(?:^|\s)car-(\d+)(?:\s|$)/.exec(text ?? '')?.[1] ?? null;

/** posterHtml() 中每個 `.route-map` 的道路、終點（含停車位）與路線項目，依文件順序。 */
async function parseMaps(html) {
  const maps = [];
  let map = null, end = null;
  const rewriter = new HTMLRewriter()
    .on('.route-map', { element() { map = { roads: [], ends: [], tracks: [] }; maps.push(map); end = null; } })
    .on('.route-map .rm-road', { element(el) { map.roads.push(style(el.getAttribute('style'), 'g')); } })
    .on('.route-map .rm-end', { element(el) {
      end = { g: style(el.getAttribute('style'), 'g'), parks: [] };
      map.ends.push(end);
    } })
    .on('.route-map .rm-space', { element(el) { end.parks.push(colorClass(el.getAttribute('class'))); } })
    .on('.route-map li.rm-track', { element(el) {
      map.tracks.push({
        kind: el.getAttribute('data-line'), g: style(el.getAttribute('style'), 'g'), color: colorClass(el.getAttribute('class'))
      });
    } });
  await rewriter.transform(new Response(html)).text();
  return maps;
}

const ascending = values => values.every((value, i) => i === 0 || values[i - 1] < value);
const distinct = values => new Set(values).size === values.length;

function checkHtml(state, block, map, seen) {
  const groups = block.ends.length;
  const order = Array.from({ length: groups }, (_, i) => i + 1);
  expect(map.roads).toEqual(order);
  expect(map.ends.map(end => end.g)).toEqual(order);
  block.ends.forEach((end, index) => {
    expect(map.ends[index].parks.length).toBe(end.count);
    expect(map.ends[index].parks).toEqual(end.lines.map(i => String(carColorIndex(state, block.lines[i].vehicle.id))));
  });
  expect(map.tracks.length).toBe(block.lines.length);
  const groupOf = block.lines.map(() => null);
  block.ends.forEach((end, index) => end.lines.forEach(i => { groupOf[i] = index + 1; }));
  block.lines.forEach((line, i) => {
    expect(map.tracks[i].kind).toBe(line.type === 'route' ? 'route' : 'legacy');
    expect(map.tracks[i].g).toBe(line.type === 'route' ? groupOf[i] : null);
  });
  seen.add(`groups:${Math.min(groups, 4)}`);
}

function checkLayout(block) {
  const layout = routeMapLayout(block);
  const { lines } = block;
  const count = lines.length, groups = block.ends.length;
  const groupOf = lines.map(() => null);
  block.ends.forEach((end, index) => end.lines.forEach(i => { groupOf[i] = index + 1; }));
  const tags = [];

  // (d)
  expect(routeMapLayout(block)).toStrictEqual(layout);
  expect(layout.ends.map(end => end.g)).toEqual(block.ends.map((_, i) => i + 1));
  expect(layout.lines.map(line => line.g)).toEqual(groupOf);

  // (b) 橫式
  const segments = layout.ends.map(end => end.h);
  segments.forEach((segment, index) => {
    expect(segment.row).toBe(index === 0 ? 1 : block.ends[index].lines[0] + 1);
    expect(segment.span).toBeGreaterThan(0);
    if (index > 0) expect(segment.row).toBe(segments[index - 1].row + segments[index - 1].span);
  });
  if (groups > 0) {
    const last = segments[groups - 1];
    expect(last.row + last.span - 1).toBe(count);
  }
  const lateLines = [];
  layout.lines.forEach((entry, i) => {
    const { h } = entry;
    expect(h.row).toBe(i + 1);
    const g = groupOf[i];
    if (g === null) {
      expect(h.late).toBe(false);
      return;
    }
    const segment = segments[g - 1];
    const lastRow = segment.row + segment.span - 1;
    const inside = h.row >= segment.row && h.row <= lastRow;
    expect(h.late).toBe(!inside);
    if (inside) return;
    lateLines.push(entry);
    expect(h.target).toBe(lastRow);
    expect(h.target).toBeLessThan(h.row);
    expect(h.entry).toBeGreaterThan(26);
    expect(h.entry).not.toBe(26);
  });
  expect(distinct(lateLines.map(entry => entry.h.lane))).toBe(true);
  expect(ascending(lateLines.map(entry => entry.h.lane))).toBe(true);
  expect(lateLines.every(entry => entry.h.lane >= 1)).toBe(true);
  const targets = [...new Set(lateLines.map(entry => entry.h.target))];
  for (const target of targets) {
    const here = lateLines.filter(entry => entry.h.target === target);
    expect(distinct(here.map(entry => entry.h.entry))).toBe(true);
    here.forEach((entry, k) => expect(entry.h.entry).toBe(26 + 10 * (k + 1)));
    expect(layout.minHeight.find(item => item.row === target)?.px).toBe(26 + 10 * here.length + 12);
  }
  expect(layout.minHeight.length).toBe(targets.length);
  // 路線在列的順序中彼此相連（不看舊出發資料）時沒有繞回的線條
  const routeGroups = groupOf.filter(g => g !== null);
  const connected = routeGroups.every((g, i) => i === 0 || g === routeGroups[i - 1] || !routeGroups.slice(0, i).includes(g));
  expect(lateLines.length === 0).toBe(connected);
  if (connected) expect(layout.cw).toBe(0);
  else expect(layout.cw).toBe(Math.min(92, 12 + 10 * lateLines.length));
  if (groups <= 1) expect(lateLines.length).toBe(0);
  tags.push(lateLines.length ? 'late lines' : 'no late lines');

  // (c) 直式
  const stops = lines.map(line => (line.type === 'route' ? line.stops.length : 0));
  const lastGroup = groups;
  layout.lines.forEach((entry, i) => {
    expect(entry.v.row).toBe(i + 1);
    expect(entry.v.stopRows.length).toBe(stops[i]);
  });
  const endRows = layout.ends.map(end => end.v.row);
  expect(ascending(endRows)).toBe(true);
  if (groups > 0) {
    expect(endRows[0]).toBeGreaterThan(count + stops.reduce((a, b) => a + b, 0));
    expect(layout.vRows).toBeGreaterThan(endRows[groups - 1]);
    layout.ends.forEach((end, index) => {
      if (index + 1 === lastGroup) expect(end.v.roadFrom).toBe(lastGroup === 1 ? 1 : block.ends[index].lines[0] + 1);
      else expect(end.v.roadFrom).toBe(end.v.row);
    });
  }
  const laneOf = layout.lines.map(entry => entry.v.lane);
  const used = laneOf.filter(lane => lane !== null);
  expect(distinct(used)).toBe(true);
  expect(used.every(lane => lane >= 1)).toBe(true);
  layout.lines.forEach((entry, i) => {
    const g = groupOf[i];
    if (g === null) {
      expect(entry.v.lane).toBeNull();
    } else if (g !== lastGroup) {
      // 其他組：每條路線都有支線並延伸到自己那一組的終點列
      expect(entry.v.lane).not.toBeNull();
      expect(entry.v.lastRow).toBe(endRows[g - 1]);
    } else {
      expect(entry.v.lane !== null).toBe(stops[i] > 0);
      const rows = entry.v.stopRows;
      expect(entry.v.lastRow).toBe(rows.length ? rows[rows.length - 1] : i + 1);
    }
  });
  // 由右往左依組的順序（編號小的在右），同一組內依文字版的順序，最後是最後一組有 Stop 的路線
  const expectedOrder = [];
  block.ends.forEach((end, index) => {
    for (const i of end.lines) if (index + 1 !== lastGroup || stops[i] > 0) expectedOrder.push(i);
  });
  expect(expectedOrder.map(i => laneOf[i])).toEqual(expectedOrder.map((_, k) => k + 1));
  expect(used.length).toBe(expectedOrder.length);
  expect(layout.lw).toBe(Math.min(92, 12 + 10 * used.length));
  // 第 g 組的橫向道路左端（該組最左側的支線）的右側沒有第 g 組以後的支線
  for (let g = 1; g < lastGroup; g += 1) {
    const mine = block.ends[g - 1].lines.map(i => laneOf[i]);
    const leftEnd = Math.max(...mine);
    layout.lines.forEach((entry, i) => {
      const other = groupOf[i];
      if (entry.v.lane === null || other === null) return;
      if (entry.v.lane < leftEnd) expect(other).toBeLessThanOrEqual(g);
      if (entry.v.lane > leftEnd) expect(other).toBeGreaterThan(g);
    });
  }
  // 只有一組時，支線恰為有 Stop 的路線
  if (groups === 1) {
    expect(laneOf.map(lane => lane !== null)).toEqual(lines.map((line, i) => stops[i] > 0));
    tags.push('single group');
  }
  if (groups >= 2) tags.push('several groups');
  return tags;
}

describe('Property 23: 終點不同的路線不共用道路', () => {
  test('每個路線區塊：每組一條道路與一個終點，橫式與直式的支線不共用道路', async () => {
    const seen = new Set();
    await fc.assert(fc.asyncProperty(endMixState(), async ({ state }) => {
      fc.pre(isValidState(state));
      const plan = shoppingPlan(state);
      const blocks = [];
      for (const date of dateRange(state.trip.startDate, state.trip.endDate)) {
        for (const block of dayModel(state, date, plan).blocks) if (block.type === 'routes') blocks.push(block);
      }
      const before = structuredClone(blocks);
      const maps = await parseMaps(posterHtml(state));
      expect(maps.length).toBe(blocks.length);
      blocks.forEach((block, i) => {
        checkHtml(state, block, maps[i], seen);
        for (const tag of checkLayout(block)) seen.add(tag);
      });
      expect(blocks).toStrictEqual(before);
    }), OPTIONS);
    for (const tag of ['single group', 'several groups', 'late lines', 'no late lines']) expect(seen.has(tag)).toBe(true);
  }, TIMEOUT);
});
