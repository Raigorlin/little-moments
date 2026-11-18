// Feature: trip-planning-workflow-enhance, Property 19: Car_Color 只由車輛位置決定
// **Validates: Requirements 11.12, 22.6**
//
// 對任意車輛清單（itineraryState()，另外補上額外車輛讓清單有 9 到 14 台，確認第 8 台之後循環），carColorIndex()
// 等於車輛在 state.vehicles 中的位置除以 8 的餘數，posterHtml() 為每條路線與舊出發資料輸出的顏色類別都是
// car-{index}。改名、改駕駛、改識別碼（同步更新路線的 vehicleId）之後，同一個位置的顏色類別與索引不變，
// 而且整份輸出中出現的 car-N 類別（含停車位）也與變化前相同。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { carColorIndex } from '../src/itinerary-derive.js';
import { CAR_COLOR_COUNT } from '../src/itinerary-model.js';
import { posterHtml } from '../src/itinerary-poster.js';
import { itineraryState } from './support/itinerary-arb.js';

const BOUNDED = { numRuns: 100, plugins: [fc.interruptAfterTimeLimit(30000, { failOnInterrupt: true })] };
const TIMEOUT = 60000;

/** 補上額外車輛（不改動既有車輛的位置），讓清單可超過 8 台。 */
function withExtraVehicles(state, extra) {
  const base = state.vehicles[0] ?? { id: 'v-base', name: '額外', driver: '', passengers: [], meeting: '' };
  const added = Array.from({ length: extra }, (_, i) => ({ ...structuredClone(base), id: `extra-${i}`, name: `額外車${i}`, meeting: '' }));
  return { ...structuredClone(state), vehicles: [...structuredClone(state.vehicles), ...added] };
}
/** 改名、改駕駛、改識別碼（同步更新路線），位置不變。 */
function mutate(state, suffix) {
  const next = structuredClone(state);
  const ids = new Map();
  next.vehicles = next.vehicles.map((vehicle, i) => {
    const id = `renamed-${i}-${suffix}`;
    ids.set(vehicle.id, id);
    return { ...vehicle, id, name: `新名${suffix}-${i}`, driver: `駕駛${suffix}` };
  });
  next.routes = (next.routes ?? []).map(route => ({ ...route, vehicleId: ids.get(route.vehicleId) ?? route.vehicleId }));
  return next;
}
/** 以路線 id（或舊出發資料的車輛識別碼）為鍵，取出 rm-track 的顏色類別。 */
function trackColors(html) {
  const colors = new Map();
  for (const match of html.matchAll(/<li class="rm-track car-(\d+)[^"]*"[^>]*data-line="(route|legacy)" data-id="([^"]*)"/g)) {
    colors.set(`${match[2]}:${match[3]}`, Number(match[1]));
  }
  return colors;
}
const allColorClasses = html => [...html.matchAll(/\bcar-(\d+)\b/g)].map(match => Number(match[1])).sort((a, b) => a - b);

describe('Property 19: Car_Color 只由車輛位置決定', () => {
  test('carColorIndex() 是位置除以 8 的餘數，posterHtml() 的顏色類別為 car-{index}，改名、改駕駛、改識別碼後不變', () => {
    let wrapped = 0, tracked = 0;
    fc.assert(fc.property(itineraryState(), fc.integer({ min: 0, max: 6 }), fc.boolean(), (generated, extra, markup) => {
      const state = withExtraVehicles(generated, markup ? extra : 0);
      const before = structuredClone(state);
      const html = posterHtml(state);
      const colors = trackColors(html);

      state.vehicles.forEach((vehicle, index) => {
        expect(carColorIndex(state, vehicle.id)).toBe(index % CAR_COLOR_COUNT);
        if (index >= CAR_COLOR_COUNT) wrapped++;
      });
      for (const route of state.routes ?? []) {
        const index = state.vehicles.findIndex(vehicle => vehicle.id === route.vehicleId);
        const color = colors.get(`route:${route.id}`);
        if (color === undefined) continue;
        tracked++;
        expect(color).toBe(index % CAR_COLOR_COUNT);
      }
      for (const [key, color] of colors) {
        if (!key.startsWith('legacy:')) continue;
        const index = state.vehicles.findIndex(vehicle => vehicle.id === key.slice(7));
        expect(color).toBe(index % CAR_COLOR_COUNT);
      }
      expect(state).toStrictEqual(before);

      // 改名、改駕駛、改識別碼：索引與顏色類別不變
      const changed = mutate(state, 'x');
      changed.vehicles.forEach((vehicle, index) => {
        expect(carColorIndex(changed, vehicle.id)).toBe(carColorIndex(state, state.vehicles[index].id));
      });
      const changedHtml = posterHtml(changed);
      const changedColors = trackColors(changedHtml);
      for (const route of state.routes ?? []) {
        if (colors.has(`route:${route.id}`)) expect(changedColors.get(`route:${route.id}`)).toBe(colors.get(`route:${route.id}`));
      }
      expect(allColorClasses(changedHtml)).toEqual(allColorClasses(html));
    }), BOUNDED);
    expect(tracked).toBeGreaterThan(0);
    expect(wrapped).toBeGreaterThan(0);
  }, TIMEOUT);
});
