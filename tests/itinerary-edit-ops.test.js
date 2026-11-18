// Feature: trip-planning-workflow-enhance, Property 11: 編輯操作只改變目標並維持有效
// **Validates: Requirements 2.7, 2.11, 4.10, 4.13, 5.9, 5.10, 5.11, 6.4, 6.13, 7.4, 7.7, 7.10, 7.12, 8.3, 10.10, 18.15, 19.5, 21.8**
//
// 對每一組通過驗證的 Trip_State 與一個隨機的編輯操作（輸入可能有效也可能無效），結果是下列兩者之一：
// (a) ok: false：沒有新狀態，輸入狀態不變；
// (b) ok: true：新狀態通過 isValidState()，旅伴、料理、採買品項、裝備與車輛以相同的 id 與順序保留，除了 First_Day 路線
//     清除該車 meeting 的連帶變更外只有目標項目改變；修改既有 Route 時保留 Route 與既有 Stop 的 id；daySettings 不含
//     '@destination'，也沒有三項都未設定的項目；採買 Stop 沒有 note；只有仍被選取的 Draft 新地點依加入順序加入 Place_List。
//     deletePlace 成功若且唯若該地點沒有任何使用處。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import {
  addPresets, clearLegacy, deleteActivity, deletePlace, deleteRoute, newActivityDraft, activityDraft, newRouteDraft,
  routeDraft, saveActivity, saveArrival, saveDaySettings, saveMealTime, savePlace, saveRoute, setActivityDone
} from '../src/itinerary-edits.js';
import { placeUsages, tripDays } from '../src/itinerary-derive.js';
import { ACTIVITY_TYPES, DESTINATION_REF, STOP_KINDS, normalizeTimeInput, trimWhite } from '../src/itinerary-model.js';
import { isValidState } from '../src/model.js';
import { itineraryState, legacyState } from './support/itinerary-arb.js';

const bounded = numRuns => ({
  numRuns, includeErrorInReport: true, plugins: [fc.interruptAfterTimeLimit(30_000, { failOnInterrupt: true })]
});
const TIMEOUT = 60_000;

// ---- 隨機選擇 ----
const int = (g, min, max) => (max <= min ? min : g(fc.integer, { min, max }));
const chance = (g, percent) => int(g, 0, 99) >= 100 - percent;
const pick = (g, items) => items[int(g, 0, items.length - 1)];
const list = value => (Array.isArray(value) ? value : []);
const isBlank = value => /^\p{White_Space}*$/u.test(String(value ?? ''));
const STOP_KIND_KEYS = STOP_KINDS.map(entry => entry.kind);
const counter = () => {
  let n = 0;
  return () => `edit:${++n}`;
};

const TIMES = ['', '08:30', '０９：１５', '23:59', '8:3', '24:00', '中午'];
const NAMES = ['', '  ', '新地點', ' 前後空白 ', 'x'.repeat(51), 'x'.repeat(50), 'a\u0007b', '營地'];

/** 已儲存的地點引用值：每個 Place 的識別碼，旅行目的地不是空白時另有 '@destination'。 */
const savedRefs = state => [
  ...list(state.places).map(place => place.id),
  ...(isBlank(state.trip.destination) ? [] : [DESTINATION_REF])
];

// ---- editOp()：依 state 隨機產生一個編輯操作 { name, allowed, run(state, ctx), ...參數 } ----
function routeOp(g, state) {
  const dates = tripDays(state).map(day => day.date);
  const routes = list(state.routes);
  const draft = routes.length && chance(g, 60) ? routeDraft(state, pick(g, routes).id) : newRouteDraft(state, pick(g, dates));
  const vehicles = list(state.vehicles);
  if (vehicles.length && (!draft.vehicleId || chance(g, 15))) draft.vehicleId = pick(g, vehicles).id;
  if (chance(g, 3)) draft.vehicleId = '';
  const refs = savedRefs(state);
  let k = 0;
  const addNew = () => {
    const ref = `new:${++k}`;
    draft.newPlaces.push({ ref, name: pick(g, NAMES.concat(['全新地點A', ' 全新地點B ', ...list(state.places).slice(0, 1).map(place => place.name)])) });
    return ref;
  };
  const somePlace = () => (refs.length && !chance(g, 20) ? pick(g, refs) : addNew());
  if (!draft.from || chance(g, 20)) draft.from = somePlace();
  if (!draft.to || chance(g, 20)) draft.to = somePlace();
  if (chance(g, 25)) draft.time = pick(g, TIMES);
  for (let n = int(g, 0, 3); n > 0; n--) {
    const roll = int(g, 0, 9);
    if (roll < 5) {
      draft.stops.push({
        stopId: null, key: `n${n}`, place: somePlace(), kind: pick(g, STOP_KIND_KEYS),
        note: pick(g, ['', '備註', '字'.repeat(100), '字'.repeat(101)])
      });
    } else if (roll < 7 && draft.stops.length) draft.stops.splice(int(g, 0, draft.stops.length - 1), 1);
    else if (roll < 8 && draft.stops.length) pick(g, draft.stops).note = pick(g, ['', '改過', '字'.repeat(101)]);
    else if (draft.stops.length) pick(g, draft.stops).kind = pick(g, STOP_KIND_KEYS);
  }
  if (draft.from === draft.to && !draft.stops.length && chance(g, 90)) draft.to = somePlace();
  return { name: 'saveRoute', allowed: ['places', 'routes', 'vehicles'], draft, run: (s, ctx) => saveRoute(s, draft, ctx) };
}

function activityOp(g, state) {
  const dates = tripDays(state).map(day => day.date);
  const activities = list(state.activities);
  const draft = activities.length && chance(g, 60) ? activityDraft(state, pick(g, activities).id) : newActivityDraft(state, pick(g, dates));
  if (!draft.title || chance(g, 25)) draft.title = pick(g, ['', '新活動', ' 修改 ', '字'.repeat(101)]);
  if (chance(g, 25)) draft.date = chance(g, 10) ? '1999-01-01' : pick(g, dates);
  if (!draft.time || chance(g, 25)) draft.time = pick(g, TIMES);
  if (chance(g, 25)) draft.type = chance(g, 10) ? 'bad' : pick(g, ACTIVITY_TYPES);
  if (chance(g, 30)) draft.participation = pick(g, ['all', 'vehicles', 'legacy', 'bad']);
  if (draft.participation === 'vehicles' || chance(g, 20)) {
    draft.vehicleIds = list(state.vehicles).filter(() => chance(g, 50)).map(vehicle => vehicle.id);
    if (chance(g, 10)) draft.vehicleIds.push('no-such-car');
  }
  if (chance(g, 15)) draft.location = pick(g, ['', '營地', '字'.repeat(151)]);
  if (chance(g, 15)) draft.note = pick(g, ['', '備註', '字'.repeat(1001)]);
  const day = pick(g, dates);
  return { name: 'saveActivity', allowed: ['activities'], draft, run: (s, ctx) => saveActivity(s, { ...draft, vehicleIds: [...draft.vehicleIds] }, { ...ctx, day }) };
}

/**
 * 隨機編輯操作（Property 11）：12 種操作（savePlace、deletePlace、saveDaySettings、saveArrival、saveRoute、deleteRoute、
 * saveActivity、addPresets、deleteActivity、setActivityDone、saveMealTime、clearLegacy），目標多半存在，偶爾不存在；
 * 欄位值有效或無效。回傳 { name, allowed, run(state, ctx), ...參數 }；allowed 是操作可以改變的頂層欄位。
 */
export function editOp(g, state) {
  const dates = tripDays(state).map(day => day.date);
  const date = chance(g, 5) ? '1999-01-01' : pick(g, dates);
  const targetId = (items, field = 'id') => (items.length && !chance(g, 8) ? pick(g, items)[field] : 'no-such-id');
  switch (int(g, 0, 11)) {
    case 0: {
      const places = list(state.places);
      const id = places.length && chance(g, 50) ? pick(g, places).id : chance(g, 8) ? 'no-such-id' : null;
      const name = chance(g, 30) && places.length ? pick(g, places).name : pick(g, NAMES);
      const values = { id, name };
      return { name: 'savePlace', allowed: ['places'], values, run: (s, ctx) => savePlace(s, values, ctx) };
    }
    case 1: {
      const places = list(state.places);
      const id = chance(g, 5) ? DESTINATION_REF : targetId(places);
      return { name: 'deletePlace', allowed: ['places'], id, run: s => deletePlace(s, id) };
    }
    case 2: {
      const refs = savedRefs(state);
      const roll = int(g, 0, 9);
      const draft = {
        title: pick(g, ['', '  ', '向山裡出發', ' 前後空白 ', '字'.repeat(20), '字'.repeat(21)]),
        place: roll < 2 ? '' : roll < 4 ? DESTINATION_REF : roll < 5 ? 'new:1' : roll < 6 ? 'no-such-id' : refs.length ? pick(g, refs) : '',
        newPlaces: chance(g, 60) ? [{ ref: 'new:1', name: pick(g, NAMES) }] : []
      };
      return { name: 'saveDaySettings', allowed: ['places', 'daySettings'], date, draft, run: (s, ctx) => saveDaySettings(s, date, draft, ctx) };
    }
    case 3: {
      const values = { arrival: pick(g, TIMES) };
      return { name: 'saveArrival', allowed: ['daySettings'], date, values, run: s => saveArrival(s, date, values) };
    }
    case 4: return routeOp(g, state);
    case 5: {
      const id = targetId(list(state.routes));
      return { name: 'deleteRoute', allowed: ['routes'], id, run: s => deleteRoute(s, id) };
    }
    case 6: return activityOp(g, state);
    case 7: {
      const types = ACTIVITY_TYPES.filter(() => chance(g, 30));
      return { name: 'addPresets', allowed: ['activities'], date, types, run: (s, ctx) => addPresets(s, date, types, ctx) };
    }
    case 8: {
      const id = targetId(list(state.activities));
      return { name: 'deleteActivity', allowed: ['activities'], id, run: s => deleteActivity(s, id) };
    }
    case 9: {
      const id = targetId(list(state.activities)), done = chance(g, 50);
      return { name: 'setActivityDone', allowed: ['activities'], id, done, run: s => setActivityDone(s, id, done) };
    }
    case 10: {
      const id = targetId(list(state.meals)), values = { time: pick(g, TIMES) };
      return { name: 'saveMealTime', allowed: ['meals'], id, values, run: s => saveMealTime(s, id, values) };
    }
    default: {
      const id = targetId(list(state.vehicles));
      return { name: 'clearLegacy', allowed: ['vehicles'], id, run: s => clearLegacy(s, id) };
    }
  }
}

// ---- 比較 ----
/** 去掉 ids 指定的項目之後的清單（保留順序）。 */
const without = (items, key, ids) => list(items).filter(item => !ids.has(item[key]));
const keysOf = (items, key) => list(items).map(item => item[key]);
const added = (before, after, key) => {
  const known = new Set(keysOf(before, key));
  return list(after).filter(item => !known.has(item[key]));
};
const entryOf = (state, date) => list(state.daySettings).find(setting => setting.date === date);

/** ok: true 時依操作檢查：只有目標改變，連帶變更限於說明的範圍。 */
function checkSuccess(state, op, result) {
  const { state: next } = result;
  expect(isValidState(next)).toBe(true);
  expect(next).not.toBe(state);
  // 不在 allowed 的頂層欄位完全相同（含鍵是否存在）
  for (const key of new Set([...Object.keys(state), ...Object.keys(next)])) {
    if (op.allowed.includes(key)) continue;
    expect(key in next, `欄位 ${key} 是否存在`).toBe(key in state);
    expect(next[key], `欄位 ${key}`).toStrictEqual(state[key]);
  }
  // 旅伴、料理、採買品項、裝備與車輛以相同的 id 與順序保留
  for (const key of ['people', 'meals', 'shopping', 'gear', 'vehicles']) {
    expect(keysOf(next[key], 'id'), `${key} 的 id 與順序`).toEqual(keysOf(state[key], 'id'));
  }

  switch (op.name) {
    case 'savePlace': {
      const created = added(state.places, next.places, 'id');
      const ids = new Set([op.values.id, ...keysOf(created, 'id')]);
      expect(without(next.places, 'id', ids)).toStrictEqual(without(state.places, 'id', ids));
      if (op.values.id) {
        expect(keysOf(next.places, 'id')).toEqual(keysOf(state.places, 'id'));
        expect(created).toHaveLength(0);
      } else {
        expect(created).toHaveLength(1);
        expect(next.places.at(-1)).toBe(created[0]);
        expect(created[0].name).toBe(trimWhite(op.values.name));
      }
      break;
    }
    case 'deletePlace': {
      expect(keysOf(next.places, 'id')).toEqual(keysOf(state.places, 'id').filter(id => id !== op.id));
      expect(placeUsages(state, op.id)).toHaveLength(0);
      break;
    }
    case 'saveDaySettings': {
      expect(list(next.places).slice(0, list(state.places).length)).toStrictEqual(list(state.places));
      const created = list(next.places).slice(list(state.places).length);
      expect(created.length).toBeLessThanOrEqual(1);
      if (created.length) expect(op.draft.place).toBe('new:1');
      expect(without(next.daySettings, 'date', new Set([op.date]))).toStrictEqual(without(state.daySettings, 'date', new Set([op.date])));
      const entry = entryOf(next, op.date);
      if (entry) {
        expect(entry.place).not.toBe(DESTINATION_REF);
        expect(Boolean(trimWhite(entry.title ?? '') || entry.place || entry.arrival)).toBe(true);
        expect(entry.arrival).toBe(entryOf(state, op.date)?.arrival);
      }
      break;
    }
    case 'saveArrival': {
      expect(without(next.daySettings, 'date', new Set([op.date]))).toStrictEqual(without(state.daySettings, 'date', new Set([op.date])));
      const entry = entryOf(next, op.date), old = entryOf(state, op.date);
      const time = normalizeTimeInput(op.values.arrival).value;
      expect(entry?.arrival ?? '').toBe(time);
      if (entry) {
        expect(entry.title).toBe(old?.title);
        expect(entry.place).toBe(old?.place);
        expect(entry.place).not.toBe(DESTINATION_REF);
        expect(Boolean(trimWhite(entry.title ?? '') || entry.place || entry.arrival)).toBe(true);
      }
      break;
    }
    case 'saveRoute': {
      const { draft } = op;
      const known = new Set(keysOf(state.routes, 'id'));
      const route = draft.routeId ? next.routes.find(item => item.id === draft.routeId) : added(state.routes, next.routes, 'id')[0];
      expect(route).toBeDefined();
      if (draft.routeId) {
        expect(keysOf(next.routes, 'id')).toEqual(keysOf(state.routes, 'id'));
        const saved = state.routes.find(item => item.id === draft.routeId);
        const own = new Set(list(saved.stops).map(stop => stop.id));
        draft.stops.forEach((stop, i) => {
          if (own.has(stop.stopId)) expect(route.stops[i].id).toBe(stop.stopId);
        });
      } else {
        expect(known.has(route.id)).toBe(false);
        expect(next.routes.at(-1)).toBe(route);
        expect(next.routes).toHaveLength(state.routes ? state.routes.length + 1 : 1);
      }
      expect(without(next.routes, 'id', new Set([route.id]))).toStrictEqual(without(state.routes, 'id', new Set([route.id])));
      expect(route.date).toBe(draft.date);
      expect(route.vehicleId).toBe(draft.vehicleId);
      expect(route.stops.map(stop => stop.kind)).toEqual(draft.stops.map(stop => stop.kind));
      for (const stop of route.stops) if (stop.kind === 'shop') expect('note' in stop).toBe(false);
      // 只有仍被選取的 Draft 新地點依加入順序加入 Place_List
      expect(list(next.places).slice(0, list(state.places).length)).toStrictEqual(list(state.places));
      const created = list(next.places).slice(list(state.places).length);
      const chosen = new Set([draft.from, draft.to, ...draft.stops.map(stop => stop.place)]);
      expect(created.map(place => place.name))
        .toEqual(draft.newPlaces.filter(entry => chosen.has(entry.ref)).map(entry => trimWhite(entry.name)));
      for (const ref of [route.from, route.to, ...route.stops.map(stop => stop.place)]) expect(ref.startsWith('new:')).toBe(false);
      // First_Day 路線清除該車的 meeting，其餘車輛不變
      const expected = structuredClone(state.vehicles);
      if (route.date === tripDays(state)[0].date) expected.find(vehicle => vehicle.id === route.vehicleId).meeting = '';
      expect(next.vehicles).toStrictEqual(expected);
      break;
    }
    case 'deleteRoute':
      expect(keysOf(next.routes, 'id')).toEqual(keysOf(state.routes, 'id').filter(id => id !== op.id));
      break;
    case 'saveActivity': {
      const { draft } = op;
      const target = draft.activityId ? next.activities.find(item => item.id === draft.activityId) : added(state.activities, next.activities, 'id')[0];
      expect(target).toBeDefined();
      expect(without(next.activities, 'id', new Set([target.id]))).toStrictEqual(without(state.activities, 'id', new Set([target.id])));
      if (draft.activityId) {
        expect(keysOf(next.activities, 'id')).toEqual(keysOf(state.activities, 'id'));
        expect(target.done).toBe(state.activities.find(item => item.id === draft.activityId).done);
      } else {
        expect(next.activities.at(-1)).toBe(target);
        expect(target.done).toBe(false);
      }
      expect(target.title).toBe(trimWhite(draft.title));
      expect(target.date).toBe(draft.date);
      break;
    }
    case 'addPresets': {
      expect(list(next.activities).slice(0, list(state.activities).length)).toStrictEqual(list(state.activities));
      const created = list(next.activities).slice(list(state.activities).length);
      expect(created.length).toBeGreaterThan(0);
      for (const activity of created) {
        expect(activity.date).toBe(op.date);
        expect(op.types).toContain(activity.type);
        expect(activity.done).toBe(false);
        expect(activity.people).toEqual([]);
      }
      break;
    }
    case 'deleteActivity':
      expect(keysOf(next.activities, 'id')).toEqual(keysOf(state.activities, 'id').filter(id => id !== op.id));
      break;
    case 'setActivityDone': {
      expect(without(next.activities, 'id', new Set([op.id]))).toStrictEqual(without(state.activities, 'id', new Set([op.id])));
      const target = next.activities.find(item => item.id === op.id);
      expect(target.done).toBe(op.done);
      expect({ ...target, done: null }).toStrictEqual({ ...state.activities.find(item => item.id === op.id), done: null });
      break;
    }
    case 'saveMealTime': {
      expect(without(next.meals, 'id', new Set([op.id]))).toStrictEqual(without(state.meals, 'id', new Set([op.id])));
      const old = state.meals.find(item => item.id === op.id);
      const target = next.meals.find(item => item.id === op.id);
      const { time: oldTime, ...oldRest } = old;
      const { time, ...rest } = target;
      expect(rest).toStrictEqual(oldRest);
      expect(time ?? '').toBe(normalizeTimeInput(op.values.time).value);
      break;
    }
    case 'clearLegacy': {
      const expected = structuredClone(state.vehicles);
      expected.find(vehicle => vehicle.id === op.id).meeting = '';
      expect(next.vehicles).toStrictEqual(expected);
      break;
    }
    default: throw new Error(`未知的操作 ${op.name}`);
  }
}

/** 一組 state 與一個操作；回傳 { name, ok }。 */
function check(state, op) {
  const before = structuredClone(state);
  const result = op.run(state, { uid: counter() });
  // 兩種結果都不修改輸入
  expect(state).toStrictEqual(before);
  if (op.name === 'deletePlace') {
    const known = list(state.places).some(place => place.id === op.id);
    expect(result.ok, 'deletePlace 成功若且唯若地點存在且沒有使用處').toBe(known && placeUsages(state, op.id).length === 0);
  }
  if (result.ok) checkSuccess(state, op, result);
  else {
    expect(result.state).toBeUndefined();
    expect(Array.isArray(result.errors)).toBe(true);
    expect(typeof result.formError).toBe('string');
    expect(result.errors.length > 0 || result.formError !== '').toBe(true);
  }
  return { name: op.name, ok: result.ok };
}

describe('Property 11: 編輯操作只改變目標並維持有效', () => {
  test('隨機編輯操作：失敗時不改變輸入，成功時只改變目標且仍通過驗證', () => {
    const seen = new Map();
    const states = fc.oneof({ weight: 4, arbitrary: itineraryState() }, { weight: 1, arbitrary: legacyState() });
    fc.assert(fc.property(states, fc.gen(), (state, g) => {
      fc.pre(isValidState(state));
      const { name, ok } = check(state, editOp(g, state));
      const key = `${name}:${ok ? 'ok' : 'rejected'}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }), bounded(200));
    const ok = [...seen.keys()].filter(key => key.endsWith(':ok'));
    expect(ok.length).toBeGreaterThanOrEqual(8);
    expect([...seen.keys()].some(key => key.endsWith(':rejected'))).toBe(true);
    if (process.env.ITINERARY_EDIT_STATS) console.log('Property 11', Object.fromEntries([...seen].sort()));
  }, TIMEOUT);
});
