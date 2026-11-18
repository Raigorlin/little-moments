// Feature: trip-planning-workflow-enhance, Property 18: 動畫時間表符合範圍
// 路線區塊（1 到 200 條路線、每條 0 到 6 個 Stop、1 到 200 組出發時間、1 到 4 個交錯終點組）在兩種排列下：
// 第 0 組 0 秒開始；組數 ≤ 8 時相鄰組間隔 0.4 到 0.8 秒，超過 8 時間隔 > 0；Stop 停留 0.6 到 1 秒；
// L 在 4 到 12 秒；到達畫面停留 2 到 4 秒，period = L + 停留；每台車接力元素首尾相接、不重疊。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { motionPlan } from '../src/itinerary-poster.js';
import { blockShape } from './support/itinerary-arb.js';

const EPS = 1e-6;

function check(block, layout) {
  const plan = motionPlan(block, layout);
  const cars = plan.lines.map((entry, i) => ({ entry, line: block.lines[i] })).filter(x => x.entry);
  expect(cars.length).toBe(block.lines.length);

  // 第 0 組 0 秒開始；各組開始時間
  const starts = new Map();
  for (const { entry } of cars) starts.set(entry.group, entry.start);
  expect(starts.get(1)).toBe(0);
  const groups = [...starts.keys()].sort((a, b) => a - b);
  expect(groups.length).toBe(plan.groups);
  for (let i = 1; i < groups.length; i += 1) {
    const diff = starts.get(groups[i]) - starts.get(groups[i - 1]);
    if (plan.groups <= 8) {
      expect(diff).toBeGreaterThanOrEqual(0.4 - EPS);
      expect(diff).toBeLessThanOrEqual(0.8 + EPS);
    } else expect(diff).toBeGreaterThan(0);
  }

  // Stop 停留
  expect(plan.dwell).toBeGreaterThanOrEqual(0.6 - EPS);
  expect(plan.dwell).toBeLessThanOrEqual(1 + EPS);
  for (const { entry, line } of cars) {
    const hold = entry.relays.reduce((sum, relay) => sum + relay.hold, 0);
    expect(Math.abs(hold - line.stops.length * plan.dwell)).toBeLessThan(1e-6);
  }

  // L 與 period
  const last = Math.max(...cars.map(({ entry }) => entry.park.end));
  expect(Math.abs(last - plan.L)).toBeLessThan(1e-6);
  expect(plan.L).toBeGreaterThanOrEqual(4 - 1e-6);
  expect(plan.L).toBeLessThanOrEqual(12 + 1e-6);
  const stay = plan.period - plan.L;
  expect(stay).toBeGreaterThanOrEqual(2 - EPS);
  expect(stay).toBeLessThanOrEqual(4 + EPS);

  // 接力元素首尾相接、不重疊，任何時刻最多一個不透明
  for (const { entry } of cars) {
    const relays = entry.relays;
    expect(relays.length).toBeGreaterThan(0);
    expect(relays[0].start).toBe(entry.start);
    for (let i = 0; i < relays.length; i += 1) {
      expect(relays[i].end).toBeGreaterThanOrEqual(relays[i].start - EPS);
      if (i > 0) expect(Math.abs(relays[i].start - relays[i - 1].end)).toBeLessThan(1e-6);
    }
    expect(Math.abs(entry.park.start - relays[relays.length - 1].end)).toBeLessThan(1e-6);
    expect(entry.park.end).toBeGreaterThanOrEqual(entry.park.start);
    expect(entry.park.end).toBeLessThanOrEqual(plan.L + EPS);
  }
}

describe('Property 18: 動畫時間表符合範圍', () => {
  test('motionPlan() 的時間表在兩種排列下都符合範圍', () => {
    fc.assert(
      fc.property(blockShape(), block => {
        check(block, 'h');
        check(block, 'v');
      }),
      { numRuns: 100 }
    );
  }, 120000);
});
