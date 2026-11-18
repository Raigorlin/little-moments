// Feature: trip-planning-workflow-enhance, Property 13: Trip_Settings_Dialog 的日期變更維持第 N 天
// **Validates: Requirements 20.1, 20.2, 20.5, 20.6, 20.7, 23.5**
//
// retimeByDayIndex(state, startDate, endDate) 是 Trip_Settings_Dialog 儲存新旅行日期時的計算。以需求 23.3 的 Trip_State
// （itineraryState()，另有一部分是本功能之前、沒有 routes 與 daySettings 鍵的 legacyState()）與新的開始、結束日期（新旅行
// 1 到 31 天）檢查：
// - 被移除的日子（原本的第 N 天中 N 大於新天數的日子）有 Route、Day_Title（去除前後的 Unicode White_Space 後不是空的，
//   需求 4.10）或設為 Place 的 Day_Location 時，結果恰為 { ok: false, blocked }，沒有新的 Trip_State：blocked 依天數順序
//   恰為這些日子，每一天為 { n, date, routes, settings }，date 是原本的日期，routes 與 settings 標明當天有 Route、有
//   Day_Title 或 Place（需求 20.2）。被移除的日子只有 Activity、Meal、Arrival_Time 或空白的 Day_Title 時不列出。
// - 否則結果恰為 { ok: true, state }：state 等於輸入把 trip.startDate 與 trip.endDate 改為新日期，每條 Route 與每筆
//   Day_Settings 的日期改為新開始日加 N − 1 天（需求 20.1），每筆 Activity 與 Meal 改到第 min(N, 新天數) 天，也就是 N 大於
//   新天數時改到新的 Last_Day（需求 20.6），再捨棄被移除日子的 Day_Settings（只有 Arrival_Time、只有空白的 Day_Title，或
//   什麼都沒設定）。其他欄位都不變：識別碼、其他旅行欄位、車輛與 `meeting`、起點、出發時間、Stop、終點、Day_Title、
//   Day_Location、Arrival_Time、Activity 與 Meal 的時間、採買品項，以及各清單的順序；缺少的 routes 與 daySettings 鍵仍然缺少。
// - 新的 Trip_State 通過 isValidState()；Route 識別碼集合相同，每個第 N 天的 Route 識別碼集合相同；1 到新天數的每個第 N 天
//   有相同的 Day_Title、Day_Location 與 Arrival_Time，變更前不存在的日子視為未設定（需求 20.5）；每台車的 `meeting`、
//   First_Shopping_Stop、每個 Shopping_Stop 的 Stop_Items、採買清單分頁的「第 N 天」、未分配採買清單、新 First_Day 的舊出發
//   資料與 Trip_Menu 的第 1 天出發都與變更前相同（需求 20.7）。
// - 不論成功或失敗，輸入的 Trip_State 都不變（拒絕時不變更任何資料，需求 20.2）。成功時新的 Trip_State 與輸入沒有共用的
//   物件：Trip_Settings_Dialog 之後在它上面套用其他欄位再驗證，驗證失敗時輸入也不變（設計「Trip_Settings_Dialog」）。
// 日期換算（公曆的日期與天數互換）與空白判斷在本檔獨立撰寫，不使用 Date 與 src 的函式；預期的 blocked 與新的 Trip_State
// 也在本檔算出。
//
// 新的天數有一部分以「最後一個擋下縮短的日子」（有 Route，或有 Day_Title 或 Place 的 Day_Settings）的第 N 天為準加減 0 到
// 2 天，讓剛好放得下與差一兩天放不下的情況常出現。產生的資料很少在最後幾天只有 Day_Settings，所以另一個測試在產生的旅行
// 最後加上 1 到 4 天：這些日子的 Day_Settings 沒有 Day_Title 與 Place（縮短時捨棄；含 JavaScript trim() 不會去除、但屬於
// White_Space 的 U+0085），或有 Day_Title 或 Place（只有每日設定擋下縮短；含 trim() 會去除、但不屬於 White_Space 的
// U+FEFF，以及看不見的 U+200B），也可以有 Activity 與 Meal（被移除時改到新的 Last_Day）；加上後的 Trip_State 仍通過驗證。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { retimeByDayIndex } from '../src/itinerary-dates.js';
import { firstDayDeparture, legacyDepartures, shoppingPlan } from '../src/itinerary-derive.js';
import { isValidState } from '../src/model.js';
import { itineraryState, legacyState } from './support/itinerary-arb.js';

// 300 組：最少見的涵蓋種類（「fail:both」與「fail:only:U+FEFF」，實測每組約 6.5% 到 7%）在 300 組中都沒出現的機率
// 低於一億分之一；每個屬性約 1 到 2 秒。
const RUNS = { numRuns: 300 };
// fc.gen() 產生的 Trip_State 很大，屬性失敗時縮小可能要好幾分鐘，而 bun test 無法中斷同步執行的測試，所以 30 秒後停止
// 縮小並回報目前的反例；尚未跑完 300 組就到時間也算失敗（failOnInterrupt）。
const BOUNDED = { ...RUNS, plugins: [fc.interruptAfterTimeLimit(30000, { failOnInterrupt: true })] };
const TIMEOUT = 60000;
const MAX_DAYS = 31;

// ---- 日期（公曆） ----
const pad2 = n => String(n).padStart(2, '0');
// 'YYYY-MM-DD' 與 1970-01-01 起算的天數互換（H. Hinnant 的 days_from_civil 與 civil_from_days），0000 到 9999 年。
function dayNumber(date) {
  const [year, month, day] = date.split('-').map(Number);
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400), yoe = y - era * 400;
  const doy = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
}
function dateOf(number) {
  const z = number + 719468;
  const era = Math.floor(z / 146097), doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const month = mp < 10 ? mp + 3 : mp - 9, day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  return `${String(yoe + era * 400 + (month <= 2 ? 1 : 0)).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}
const FIRST = dayNumber('0000-01-01'), LAST = dayNumber('9999-12-31');
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
/** 以 startDate 為第 1 天時，日期是第幾天。 */
const dayFrom = startDate => {
  const start = dayNumber(startDate);
  return date => dayNumber(date) - start + 1;
};
/** 日期在 state 中是第幾天（First_Day 為 1）。 */
const dayOf = state => dayFrom(state.trip.startDate);
/** state 的旅行天數。 */
const tripLength = state => dayNumber(state.trip.endDate) - dayNumber(state.trip.startDate) + 1;

// ---- Day_Settings ----
// 去除前後的 Unicode White_Space（含全形空白、換行、Tab 與 U+0085）後不是空的 Day_Title 才算有標題（需求 4.10）；
// Day_Location 是 Place 時 place 是該 Place 的識別碼，未設定時省略或為空字串。
const trimmed = text => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
const hasTitle = setting => typeof setting.title === 'string' && trimmed(setting.title) !== '';
const hasPlace = setting => typeof setting.place === 'string' && setting.place !== '';
const hasTitleOrPlace = setting => hasTitle(setting) || hasPlace(setting);

// ---- 預期結果 ----
/** 被移除的日子中擋下縮短的日子，依天數順序：{ n, date（原本的日期）, routes, settings }；沒有時為空陣列。 */
function expectedBlocked(state, days) {
  const n = dayOf(state), start = dayNumber(state.trip.startDate);
  const routeDays = new Set((state.routes ?? []).map(route => n(route.date)));
  const settingDays = new Set((state.daySettings ?? []).filter(hasTitleOrPlace).map(setting => n(setting.date)));
  const blocked = [];
  for (let day = days + 1; day <= tripLength(state); day++) {
    const routes = routeDays.has(day), settings = settingDays.has(day);
    if (routes || settings) blocked.push({ n: day, date: dateOf(start + day - 1), routes, settings });
  }
  return blocked;
}
/**
 * 輸入改為 startDate 開始的 days 天：Route 與 Day_Settings 維持第 N 天，Activity 與 Meal 改到第 min(N, days) 天，
 * 捨棄被移除日子的 Day_Settings，其他欄位不變。
 */
function expectedState(state, startDate, days) {
  const n = dayOf(state), first = dayNumber(startDate);
  const on = day => dateOf(first + day - 1);
  const keepDay = item => ({ ...item, date: on(n(item.date)) });
  const lastDayAtMost = item => ({ ...item, date: on(Math.min(n(item.date), days)) });
  const next = structuredClone(state);
  next.trip.startDate = startDate;
  next.trip.endDate = on(days);
  next.activities = next.activities.map(lastDayAtMost);
  next.meals = next.meals.map(lastDayAtMost);
  if (next.routes) next.routes = next.routes.map(keepDay);
  if (next.daySettings) next.daySettings = next.daySettings.filter(setting => n(setting.date) <= days).map(keepDay);
  return next;
}
/** 第 N 天 → 當天 Route 的識別碼（排序後），依 N 由小到大；N 以 startDate 為第 1 天計算。 */
function routesByDay(state, startDate) {
  const n = dayFrom(startDate), days = new Map();
  for (const route of state.routes ?? []) days.set(n(route.date), [...(days.get(n(route.date)) ?? []), route.id]);
  return [...days].map(([day, ids]) => [day, ids.sort()]).sort(([a], [b]) => a - b);
}
/** 第 N 天的 Day_Title、Day_Location 與 Arrival_Time（N 以 startDate 為第 1 天計算）；沒有 Day_Settings 的日子三者都是未設定。 */
function settingOn(state, startDate, day) {
  const n = dayFrom(startDate);
  const setting = (state.daySettings ?? []).find(item => n(item.date) === day);
  return { title: setting?.title, place: setting?.place, arrival: setting?.arrival };
}
/** 需求 20.7 比較的採買推導：First_Shopping_Stop、Stop_Items、採買位置與未分配採買清單（以識別碼表示）。 */
function shoppingView(state) {
  const plan = shoppingPlan(state);
  return {
    firstStop: [...plan.firstStop].map(([vehicleId, { route, stop, n }]) => [vehicleId, route.id, stop.id, n]),
    stopItems: [...plan.stopItems].map(([stopId, items]) => [stopId, items.map(item => item.id)]),
    locationOf: [...plan.locationOf].map(([itemId, { n, placeName, vehicleName }]) => [itemId, n, placeName, vehicleName]),
    unassigned: plan.unassigned.map(({ item, code, reason }) => [item.id, code, reason])
  };
}
/** 需求 20.7 比較的出發資訊：每台車的 `meeting`、First_Day 的舊出發資料與 Trip_Menu 的第 1 天出發。 */
function departureView(state) {
  return {
    meeting: state.vehicles.map(vehicle => [vehicle.id, vehicle.meeting]),
    legacy: legacyDepartures(state).map(({ vehicle, vehicleIndex, time, location }) => [vehicle.id, vehicleIndex, time, location]),
    firstDay: state.vehicles.map(vehicle => [vehicle.id, firstDayDeparture(state, vehicle.id)])
  };
}
/** result 中與 input 共用的物件（含陣列）的路徑，最多 5 個；沒有共用時為空陣列。 */
function sharedPaths(result, input) {
  const inputs = new Set();
  const collect = node => {
    if (node === null || typeof node !== 'object' || inputs.has(node)) return;
    inputs.add(node);
    for (const value of Object.values(node)) collect(value);
  };
  collect(input);
  const shared = [], visited = new Set();
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object' || visited.has(node) || shared.length >= 5) return;
    visited.add(node);
    if (inputs.has(node)) shared.push(path || '(整個 Trip_State)');
    else for (const [key, value] of Object.entries(node)) walk(value, Array.isArray(node) ? `${path}[${key}]` : `${path}.${key}`);
  };
  walk(result, '');
  return shared;
}

// ---- 新的旅行日期 ----
/** 最後一個擋下縮短的日子的 N（有 Route，或有 Day_Title 或 Place 的 Day_Settings）；都沒有時為 0。 */
function lastBlockingDay(state) {
  const n = dayOf(state);
  const items = [...(state.routes ?? []), ...(state.daySettings ?? []).filter(hasTitleOrPlace)];
  return Math.max(0, ...items.map(item => n(item.date)));
}
// 新天數：最後一個擋下縮短的日子的 N 加減 0 到 2 天（限制在 1 到 31）、1 到 31 的任意天數，或與原本相同。
const fitPlan = fc.record({ kind: fc.constant('fit'), delta: fc.integer({ min: -2, max: 2 }) });
const lengthPlan = fc.oneof(
  { weight: 3, arbitrary: fitPlan },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('any'), days: fc.integer({ min: 1, max: MAX_DAYS }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('same') }) }
);
// 新開始日：與原本相同、前後 60 天內（跨月、跨年與 2 月 29 日）、0000 到 9999 年的任一天，或靠近 0000-01-01 與
// 9999-12-31 的日子；新的結束日不超過 9999-12-31。
const startPlan = fc.oneof(
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('same') }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('near'), offset: fc.integer({ min: -60, max: 60 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('anywhere'), day: fc.integer({ min: FIRST, max: LAST }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('edge'), late: fc.boolean(), gap: fc.integer({ min: 0, max: 40 }) }) }
);
function newDates(state, length, start) {
  const oldStart = dayNumber(state.trip.startDate), oldDays = tripLength(state);
  const days = length.kind === 'same' ? oldDays
    : length.kind === 'fit' ? clamp(lastBlockingDay(state) + length.delta, 1, MAX_DAYS) : length.days;
  const latest = LAST - (days - 1);
  const wanted = start.kind === 'same' ? oldStart : start.kind === 'near' ? oldStart + start.offset
    : start.kind === 'anywhere' ? start.day : start.late ? latest - start.gap : FIRST + start.gap;
  const first = clamp(wanted, FIRST, latest);
  return { startDate: dateOf(first), endDate: dateOf(first + days - 1), days, oldDays, moved: first !== oldStart };
}

// ---- 在旅行最後加上的日子 ----
// 每一天依 kind：'none' 沒有 Day_Settings；'blank' 沒有 Day_Title（省略或只有 White_Space，含 JavaScript trim() 不會去除
// 的 U+0085）也沒有 Place，可以有 Arrival_Time；'titled' 的 Day_Title 含有不是 White_Space 的字元（U+200B 與 U+FEFF 看不見，
// 但不是空白；trim() 會去除 U+FEFF）；'placed' 的 Day_Location 是一個 Place（沒有 Place 時同 'blank'）。extra 決定當天是否
// 另有一筆 Activity、Meal 或兩者。Day_Settings、Activity 與 Meal 插在各自清單的任意位置。
const BLANK_TITLES = [
  undefined, '', ' ', '  ', '\u3000', '\t', '\n', '\r\n', '\u2028', ' \u3000\n',
  '\u0085', ' \u0085', '\n\u0085', '\u0085\t', '\u0085\u3000\u0085'
];
const TITLES = ['慢慢', ' 收帳 ', 'A&B', '\u200B', '\uFEFF', ' \uFEFF ', '\u3000\uFEFF\n'];
const ARRIVALS = [undefined, '', '00:00', '08:30', '12:00', '23:59'];
const tailDay = fc.record({
  kind: fc.oneof(
    { weight: 1, arbitrary: fc.constant('none') }, { weight: 3, arbitrary: fc.constant('blank') },
    { weight: 2, arbitrary: fc.constant('titled') }, { weight: 1, arbitrary: fc.constant('placed') }
  ),
  blank: fc.constantFrom(...BLANK_TITLES),
  title: fc.constantFrom(...TITLES),
  place: fc.constantFrom(undefined, ''),
  arrival: fc.constantFrom(...ARRIVALS),
  extra: fc.constantFrom('none', 'activity', 'meal', 'both'),
  pick: fc.nat(),
  at: fc.nat()
});
/** generated 的副本，在旅行最後加上 tail 的日子（總天數不超過 31，結束日不超過 9999-12-31）。 */
function withTail(generated, tail) {
  const state = structuredClone(generated);
  const end = dayNumber(state.trip.endDate);
  const extra = Math.min(tail.length, MAX_DAYS - tripLength(state), LAST - end);
  if (extra <= 0) return state;
  state.trip.endDate = dateOf(end + extra);
  tail.slice(0, extra).forEach((day, i) => {
    const date = dateOf(end + 1 + i);
    const insert = (list, item) => list.splice(day.at % (list.length + 1), 0, item);
    if (day.kind !== 'none') {
      const places = state.places ?? [];
      const title = day.kind === 'titled' ? day.title : day.blank;
      const place = day.kind === 'placed' && places.length ? places[day.pick % places.length].id : day.place;
      const setting = { date };
      if (title !== undefined) setting.title = title;
      if (place !== undefined) setting.place = place;
      if (day.arrival !== undefined) setting.arrival = day.arrival;
      state.daySettings ??= [];
      insert(state.daySettings, setting);
    }
    if (day.extra === 'activity' || day.extra === 'both') {
      insert(state.activities, {
        id: `tail-a${i}`, date, time: '09:00', title: `尾聲活動〔${i}〕`, type: 'free', location: '', note: '', people: [], done: false
      });
    }
    if (day.extra === 'meal' || day.extra === 'both') {
      insert(state.meals, { id: `tail-m${i}`, date, slot: '午餐', title: `尾聲野餐〔${i}〕`, cookId: '', servings: 4, ingredients: '', notes: '' });
    }
  });
  return state;
}

// ---- 屬性 ----
/** 以 before 與新日期的設定檢查 retimeByDayIndex()，回傳這一組輸入的種類（供涵蓋範圍的檢查）。 */
function checkRetime(before, length, start) {
  const { startDate, endDate, days, oldDays, moved } = newDates(before, length, start);
  const snapshot = structuredClone(before);
  const result = retimeByDayIndex(before, startDate, endDate);
  // 不論成功或失敗，輸入都不變
  expect(before).toStrictEqual(snapshot);

  const n = dayOf(before);
  const blocked = expectedBlocked(before, days);
  if (blocked.length) {
    // 需求 20.2：拒絕；blocked 依天數順序恰為擋下縮短的日子（原本的日期），沒有新的 Trip_State
    expect(result).toStrictEqual({ ok: false, blocked });
    const byDay = new Map(blocked.map(day => [day.n, day]));
    const tags = ['fail', ...blocked.map(day => (day.routes && day.settings ? 'fail:both' : day.routes ? 'fail:routes' : 'fail:settings'))];
    if (blocked.length > 1) tags.push('fail:several');
    if (blocked.every(day => !day.routes)) tags.push('fail:settings-only');
    // 被移除的日子有內容卻不列出：只有 Activity、Meal，或沒有 Day_Title 與 Place 的 Day_Settings
    const content = [...before.activities, ...before.meals, ...(before.daySettings ?? [])];
    if (content.some(item => n(item.date) > days && !byDay.has(n(item.date)))) tags.push('fail:quiet');
    // 只因為 Day_Title 列出、而這個標題經 trim() 後是空字串的日子（標題只有 U+FEFF 與空白）
    if ((before.daySettings ?? []).some(setting => {
      const day = byDay.get(n(setting.date));
      return day && !day.routes && !hasPlace(setting) && typeof setting.title === 'string' && setting.title.trim() === '';
    })) tags.push('fail:only:U+FEFF');
    return tags;
  }

  expect(result.ok).toBe(true);
  expect(Object.keys(result).sort()).toEqual(['ok', 'state']);
  const after = result.state, m = dayFrom(startDate);
  // 需求 20.1：每條 Route 與留下的 Day_Settings 都在原本的第 N 天（新開始日加 N − 1 天），被移除日子的 Day_Settings 被捨棄
  expect((after.routes ?? []).map(route => [route.id, m(route.date)]))
    .toStrictEqual((before.routes ?? []).map(route => [route.id, n(route.date)]));
  expect((after.daySettings ?? []).map(setting => m(setting.date)))
    .toStrictEqual((before.daySettings ?? []).map(setting => n(setting.date)).filter(day => day <= days));
  // 需求 20.6：每筆 Activity 與 Meal 在第 min(N, 新天數) 天
  for (const key of ['activities', 'meals']) {
    expect(after[key].map(item => [item.id, m(item.date)])).toStrictEqual(before[key].map(item => [item.id, Math.min(n(item.date), days)]));
  }
  // 新的旅行日期；其他欄位都不變（含 Activity 與 Meal 的時間、缺少的鍵與各清單的順序）
  expect(after).toStrictEqual(expectedState(before, startDate, days));
  expect(isValidState(after)).toBe(true);
  // 需求 20.5：Route 識別碼集合與每個第 N 天的 Route 識別碼集合相同；1 到新天數的每一天有相同的每日設定
  const routeIds = state => (state.routes ?? []).map(route => route.id).sort();
  expect(routeIds(after)).toStrictEqual(routeIds(before));
  expect(routesByDay(after, startDate)).toStrictEqual(routesByDay(before, before.trip.startDate));
  for (let day = 1; day <= days; day++) expect(settingOn(after, startDate, day)).toStrictEqual(settingOn(before, before.trip.startDate, day));
  // 需求 20.7：採買推導、`meeting`、舊出發資料與第 1 天出發都與變更前相同
  expect(shoppingView(after)).toStrictEqual(shoppingView(before));
  expect(departureView(after)).toStrictEqual(departureView(before));
  // 新的 Trip_State 與輸入沒有共用的物件
  expect(sharedPaths(after, before)).toEqual([]);

  const dropped = (before.daySettings ?? []).filter(setting => n(setting.date) > days);
  const tags = ['ok', days > oldDays ? 'ok:longer' : days < oldDays ? 'ok:shorter' : 'ok:same-length', moved ? 'ok:moved' : 'ok:same-start'];
  if ([...before.activities, ...before.meals].some(item => n(item.date) > days)) tags.push('ok:clamped');
  if (dropped.length) tags.push('ok:dropped');
  // 捨棄的 Day_Settings 有只含 White_Space 的 Day_Title，而 trim() 去不掉其中的 U+0085
  if (dropped.some(setting => typeof setting.title === 'string' && setting.title.trim() !== '')) tags.push('ok:dropped:U+0085');
  if (!('routes' in before) || !('daySettings' in before)) tags.push('ok:missing-key');
  return tags;
}
/** required 中沒有出現在 seen 的種類。 */
const missing = (seen, required) => required.filter(tag => !seen.has(tag));

describe('Property 13: Trip_Settings_Dialog 的日期變更維持第 N 天', () => {
  test('本檔的日期換算與 Date 相同（0000 到 9999 年）', () => {
    const examples = ['0000-01-01', '0000-02-29', '1900-03-01', '1970-01-01', '2000-02-29', '2024-02-29', '2100-02-28', '9999-12-31'];
    fc.assert(fc.property(fc.integer({ min: FIRST, max: LAST }), number => {
      const date = dateOf(number);
      expect(date).toBe(new Date(number * 86400000).toISOString().slice(0, 10));
      expect(dayNumber(date)).toBe(number);
    }), { ...RUNS, examples: examples.map(date => [dayNumber(date)]) });
    for (const date of examples) expect(dateOf(dayNumber(date))).toBe(date);
  });

  test('被移除的日子有路線、Day_Title 或 Place 時恰列出這些日子；否則路線與每日設定維持第 N 天，活動與餐點在第 min(N, 新天數) 天，其他內容不變並通過驗證', () => {
    const seen = new Set();
    const scenario = fc.record({
      generated: fc.oneof({ weight: 4, arbitrary: itineraryState() }, { weight: 1, arbitrary: legacyState() }),
      length: lengthPlan,
      start: startPlan
    });
    fc.assert(fc.property(scenario, ({ generated, length, start }) => {
      fc.pre(isValidState(generated));
      for (const tag of checkRetime(structuredClone(generated), length, start)) seen.add(tag);
    }), BOUNDED);
    // 產生的輸入涵蓋拒絕與接受；拒絕時有只因路線、只因每日設定與兩者都有的日子、多個日子，以及不列出的被移除日子；
    // 接受時有縮短與延長、改與不改開始日、活動與餐點改到新的 Last_Day，以及缺少的鍵
    expect(missing(seen, ['fail', 'fail:routes', 'fail:settings', 'fail:both', 'fail:several', 'fail:quiet',
      'ok', 'ok:shorter', 'ok:longer', 'ok:moved', 'ok:same-start', 'ok:clamped', 'ok:missing-key'])).toEqual([]);
  }, TIMEOUT);

  test('旅行最後的日子：沒有 Day_Title 與 Place 的 Day_Settings 被捨棄、活動與餐點改到新的 Last_Day，有 Day_Title 或 Place 的日子列入 blocked', () => {
    const seen = new Set();
    const scenario = fc.record({
      generated: itineraryState(),
      tail: fc.array(tailDay, { minLength: 1, maxLength: 4 }),
      length: fitPlan,
      start: startPlan
    });
    fc.assert(fc.property(scenario, ({ generated, tail, length, start }) => {
      fc.pre(isValidState(generated));
      const before = withTail(generated, tail);
      // 加上的日子、Day_Settings、Activity 與 Meal 仍符合驗證規則
      expect(isValidState(before)).toBe(true);
      for (const tag of checkRetime(before, length, start)) seen.add(tag);
    }), BOUNDED);
    // 涵蓋縮短天數並捨棄 Day_Settings（含 U+0085 的空白標題）、活動與餐點改到新的 Last_Day，以及只有每日設定擋下縮短
    // （含只有 U+FEFF 的標題）與不列出的被移除日子
    expect(missing(seen, ['ok', 'ok:shorter', 'ok:clamped', 'ok:dropped', 'ok:dropped:U+0085',
      'fail', 'fail:settings-only', 'fail:quiet', 'fail:only:U+FEFF'])).toEqual([]);
  }, TIMEOUT);
});
