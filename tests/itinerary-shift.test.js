// Feature: trip-planning-workflow-enhance, Property 14: 伺服器的日期平移一致
// **Validates: Requirements 20.3, 20.4, 20.5, 20.7, 23.5**
//
// shiftByOffset(state, startDate, endDate) 是伺服器在 PATCH /api/trips/:id 與 POST /api/trips 匯入時的日期平移。以需求
// 23.3 的 Trip_State（itineraryState()，另有一部分是匯入的舊手冊 legacyState()）與新的開始、結束日期（新旅行 1 到 31 天）
// 檢查：
// - 平移的天數是「新開始日減 state.trip.startDate」。平移後有 Activity、Meal、Route，或有 Day_Title（去除前後的 Unicode
//   White_Space 後不是空的，需求 4.10）或 Place 的 Day_Settings 落在新範圍外時，結果恰為 { ok: false, categories }：
//   categories 恰為這些類別，依「活動、餐點、路線、每日設定」排列，沒有新的 Trip_State（需求 20.4）。
// - 否則結果恰為 { ok: true, state }：state 等於輸入把每筆 Activity、Meal、Route 與 Day_Settings 的日期平移相同的天數，
//   再捨棄落在新範圍外的 Day_Settings（只有 Arrival_Time、只有空白的 Day_Title，或什麼都沒設定）。其他欄位都不變：
//   識別碼、旅行欄位、車輛與 `meeting`、起點、出發時間、Stop、終點、Day_Title、Day_Location、Arrival_Time、採買品項與
//   留下的 Day_Settings 的順序；缺少的 routes 與 daySettings 鍵仍然缺少（需求 20.3）。
// - 套用新日期（設定 trip.startDate 與 trip.endDate，伺服器的 applyCardToState() 在平移之後做的事）後：通過
//   isValidState()；Route 識別碼集合相同，每個第 N 天的 Route 識別碼集合相同；1 到新天數的每個第 N 天有相同的
//   Day_Title、Day_Location 與 Arrival_Time，變更前不存在的日子視為未設定（需求 20.5）；每台車的 `meeting`、
//   First_Shopping_Stop、每個 Shopping_Stop 的 Stop_Items、採買清單分頁的「第 N 天」、未分配採買清單、First_Day 的
//   舊出發資料與 Trip_Menu 的第 1 天出發都與變更前相同（需求 20.7）。
// - 不論成功或失敗，輸入的 Trip_State 都不變（失敗時不寫入任何資料，需求 20.4）。
// 日期換算（公曆的日期與天數互換）與空白判斷在本檔獨立撰寫，不使用 Date 與 src 的函式；預期的類別與平移後的
// Trip_State 也在本檔算出。
//
// 新的天數有一部分以「最後一個有內容的日子」（有 Activity、Meal、Route，或有 Day_Title 或 Place 的 Day_Settings）的
// 第 N 天為準加減 0 到 2 天，讓剛好放得下與差一兩天放不下的情況常出現。產生的資料很少在最後幾天只有 Day_Settings，
// 所以另一個測試在產生的旅行最後加上 1 到 4 天：這些日子只有沒有 Day_Title 與 Place 的 Day_Settings（新天數放不下時
// 捨棄），或只有 Day_Title 或 Place 的 Day_Settings（只有「每日設定」放不下）；加上後的 Trip_State 仍通過驗證。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { SHIFT_CATEGORIES, shiftByOffset } from '../src/itinerary-dates.js';
import { firstDayDeparture, legacyDepartures, shoppingPlan } from '../src/itinerary-derive.js';
import { isValidState } from '../src/model.js';
import { itineraryState, legacyState } from './support/itinerary-arb.js';

const RUNS = { numRuns: 200 };
// 200 組通常 1 到 2 秒。fc.gen() 產生的 Trip_State 很大，屬性失敗時縮小可能要好幾分鐘，而 bun test 無法中斷同步執行的
// 測試，所以 30 秒後停止縮小並回報目前的反例；尚未跑完 200 組就到時間也算失敗（failOnInterrupt）。
const BOUNDED = { ...RUNS, plugins: [fc.interruptAfterTimeLimit(30000, { failOnInterrupt: true })] };
const TIMEOUT = 60000;
// 需求 20.4 的類別，依回報的順序
const CATEGORIES = ['活動', '餐點', '路線', '每日設定'];
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
/** 日期在 state 中是第幾天（First_Day 為 1）。 */
const dayOf = state => {
  const start = dayNumber(state.trip.startDate);
  return date => dayNumber(date) - start + 1;
};

// ---- Day_Settings ----
// 去除前後的 Unicode White_Space（含全形空白、換行與 Tab）後不是空的 Day_Title 才算有標題（需求 4.10）；
// Day_Location 是 Place 時 place 是該 Place 的識別碼，未設定時省略或為空字串。
const trimmed = text => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
const hasTitleOrPlace = setting => (typeof setting.title === 'string' && trimmed(setting.title) !== '')
  || (typeof setting.place === 'string' && setting.place !== '');

// ---- 預期結果 ----
/** 平移後落在新範圍外的判斷。 */
function outsideAfterShift(state, startDate, endDate) {
  const offset = dayNumber(startDate) - dayNumber(state.trip.startDate);
  const first = dayNumber(startDate), last = dayNumber(endDate);
  return item => {
    const day = dayNumber(item.date) + offset;
    return day < first || day > last;
  };
}
/** 放不下的類別，依需求 20.4 的順序；放得下時為空陣列。 */
function expectedCategories(state, startDate, endDate) {
  const outside = outsideAfterShift(state, startDate, endDate);
  const misfit = [
    state.activities.some(outside),
    state.meals.some(outside),
    (state.routes ?? []).some(outside),
    (state.daySettings ?? []).some(setting => outside(setting) && hasTitleOrPlace(setting))
  ];
  return CATEGORIES.filter((_, i) => misfit[i]);
}
/** 輸入把每筆 Activity、Meal、Route 與 Day_Settings 的日期平移相同的天數，再捨棄落在新範圍外的 Day_Settings。 */
function expectedState(state, startDate, endDate) {
  const offset = dayNumber(startDate) - dayNumber(state.trip.startDate);
  const outside = outsideAfterShift(state, startDate, endDate);
  const move = item => ({ ...item, date: dateOf(dayNumber(item.date) + offset) });
  const next = structuredClone(state);
  next.activities = next.activities.map(move);
  next.meals = next.meals.map(move);
  if (next.routes) next.routes = next.routes.map(move);
  if (next.daySettings) next.daySettings = next.daySettings.filter(setting => !outside(setting)).map(move);
  return next;
}
/** 第 N 天 → 當天 Route 的識別碼（排序後），依 N 由小到大。 */
function routesByDay(state) {
  const n = dayOf(state), days = new Map();
  for (const route of state.routes ?? []) days.set(n(route.date), [...(days.get(n(route.date)) ?? []), route.id]);
  return [...days].map(([day, ids]) => [day, ids.sort()]).sort(([a], [b]) => a - b);
}
/** 第 N 天的 Day_Title、Day_Location 與 Arrival_Time；沒有 Day_Settings 的日子三者都是未設定。 */
function settingOn(state, day) {
  const n = dayOf(state);
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

// ---- 新的旅行日期 ----
/** 最後一個有內容的日子的 N（有 Activity、Meal、Route，或有 Day_Title 或 Place 的 Day_Settings）；都沒有時為 0。 */
function lastContentDay(state) {
  const n = dayOf(state);
  const items = [...state.activities, ...state.meals, ...(state.routes ?? []), ...(state.daySettings ?? []).filter(hasTitleOrPlace)];
  return Math.max(0, ...items.map(item => n(item.date)));
}
// 新天數：最後一個有內容的日子的 N 加減 0 到 2 天（限制在 1 到 31）、1 到 31 的任意天數，或與原本相同。
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
  const oldStart = dayNumber(state.trip.startDate);
  const oldDays = dayNumber(state.trip.endDate) - oldStart + 1;
  const days = length.kind === 'same' ? oldDays
    : length.kind === 'fit' ? clamp(lastContentDay(state) + length.delta, 1, MAX_DAYS) : length.days;
  const latest = LAST - (days - 1);
  const wanted = start.kind === 'same' ? oldStart : start.kind === 'near' ? oldStart + start.offset
    : start.kind === 'anywhere' ? start.day : start.late ? latest - start.gap : FIRST + start.gap;
  const first = clamp(wanted, FIRST, latest);
  return { startDate: dateOf(first), endDate: dateOf(first + days - 1), days, oldDays, offset: first - oldStart };
}

// ---- 在旅行最後加上的日子 ----
// 每一天依 kind：'none' 沒有 Day_Settings；'blank' 沒有 Day_Title（省略或只有 White_Space，含 JavaScript trim() 不會
// 去除的 U+0085）也沒有 Place，可以有 Arrival_Time；'titled' 的 Day_Title 含有不是 White_Space 的字元（U+200B 與 U+FEFF
// 看不見，但不是空白）；'placed' 的 Day_Location 是一個 Place（沒有 Place 時同 'blank'）。Day_Settings 插在
// daySettings 的任意位置。
const BLANK_TITLES = [undefined, '', ' ', '  ', '\u3000', '\t', '\n', '\r\n', '\u0085', '\u2028', ' \u3000\n'];
const TITLES = ['慢慢', ' 收帳 ', '\u200B', '\uFEFF', 'A&B'];
const ARRIVALS = [undefined, '', '00:00', '08:30', '12:00', '23:59'];
const tailDay = fc.record({
  kind: fc.oneof(
    { weight: 1, arbitrary: fc.constant('none') }, { weight: 4, arbitrary: fc.constant('blank') },
    { weight: 1, arbitrary: fc.constant('titled') }, { weight: 1, arbitrary: fc.constant('placed') }
  ),
  blank: fc.constantFrom(...BLANK_TITLES),
  title: fc.constantFrom(...TITLES),
  place: fc.constantFrom(undefined, ''),
  arrival: fc.constantFrom(...ARRIVALS),
  pick: fc.nat(),
  at: fc.nat()
});
/** generated 的副本，在旅行最後加上 tail 的日子（總天數不超過 31，結束日不超過 9999-12-31）。 */
function withTail(generated, tail) {
  const state = structuredClone(generated);
  const end = dayNumber(state.trip.endDate);
  const extra = Math.min(tail.length, MAX_DAYS - (end - dayNumber(state.trip.startDate) + 1), LAST - end);
  if (extra <= 0) return state;
  state.trip.endDate = dateOf(end + extra);
  tail.slice(0, extra).forEach((day, i) => {
    if (day.kind === 'none') return;
    const places = state.places ?? [];
    const title = day.kind === 'titled' ? day.title : day.blank;
    const place = day.kind === 'placed' && places.length ? places[day.pick % places.length].id : day.place;
    const setting = { date: dateOf(end + 1 + i) };
    if (title !== undefined) setting.title = title;
    if (place !== undefined) setting.place = place;
    if (day.arrival !== undefined) setting.arrival = day.arrival;
    state.daySettings ??= [];
    state.daySettings.splice(day.at % (state.daySettings.length + 1), 0, setting);
  });
  return state;
}

// ---- 屬性 ----
/** 以 before 與新日期的設定檢查 shiftByOffset()，回傳這一組輸入的種類（供涵蓋範圍的檢查）。 */
function checkShift(before, length, start) {
  const { startDate, endDate, days, oldDays, offset } = newDates(before, length, start);
  const snapshot = structuredClone(before);
  const result = shiftByOffset(before, startDate, endDate);
  // 不論成功或失敗，輸入都不變
  expect(before).toStrictEqual(snapshot);

  const categories = expectedCategories(before, startDate, endDate);
  if (categories.length) {
    // 放不下：恰為這些類別，沒有新的 Trip_State
    expect(result).toStrictEqual({ ok: false, categories });
    const tags = ['fail', ...categories.map(category => `fail:${category}`)];
    if (categories.length < CATEGORIES.length) tags.push('fail:partial');
    if (categories.length === 1) tags.push(`fail:only:${categories[0]}`);
    return tags;
  }

  expect(result.ok).toBe(true);
  expect(Object.keys(result).sort()).toEqual(['ok', 'state']);
  const after = result.state;
  const expected = expectedState(before, startDate, endDate);
  // 每筆 Activity、Meal、Route 與留下的 Day_Settings 都平移相同的天數
  for (const key of ['activities', 'meals', 'routes', 'daySettings']) {
    expect(after[key]?.map(item => item.date)).toStrictEqual(expected[key]?.map(item => item.date));
  }
  // 只捨棄落在新範圍外的 Day_Settings，其他欄位（含缺少的鍵與 Day_Settings 的順序）都不變
  expect(after).toStrictEqual(expected);

  // 套用新日期後的 Trip_State
  const applied = { ...after, trip: { ...after.trip, startDate, endDate } };
  expect(isValidState(applied)).toBe(true);
  // 需求 20.5：Route 識別碼集合與每個第 N 天的 Route 識別碼集合相同；1 到新天數的每一天有相同的每日設定
  expect(new Set((applied.routes ?? []).map(route => route.id))).toEqual(new Set((before.routes ?? []).map(route => route.id)));
  expect(routesByDay(applied)).toStrictEqual(routesByDay(before));
  for (let n = 1; n <= days; n++) expect(settingOn(applied, n)).toStrictEqual(settingOn(before, n));
  // 需求 20.7：採買推導、`meeting`、舊出發資料與第 1 天出發都與變更前相同
  expect(shoppingView(applied)).toStrictEqual(shoppingView(before));
  expect(departureView(applied)).toStrictEqual(departureView(before));

  const tags = ['ok', offset ? 'ok:offset' : 'ok:offset0'];
  if (days > oldDays) tags.push('ok:longer');
  if (days < oldDays) tags.push('ok:shorter');
  if ((after.daySettings?.length ?? 0) < (before.daySettings?.length ?? 0)) tags.push('ok:dropped');
  if (!('routes' in before) || !('daySettings' in before)) tags.push('ok:missing-key');
  return tags;
}
/** required 中沒有出現在 seen 的種類。 */
const missing = (seen, required) => required.filter(tag => !seen.has(tag));

describe('Property 14: 伺服器的日期平移一致', () => {
  test('本檔的日期換算與 Date 相同（0000 到 9999 年）', () => {
    const examples = ['0000-01-01', '0000-02-29', '1900-03-01', '1970-01-01', '2000-02-29', '2024-02-29', '2100-02-28', '9999-12-31'];
    fc.assert(fc.property(fc.integer({ min: FIRST, max: LAST }), number => {
      const date = dateOf(number);
      expect(date).toBe(new Date(number * 86400000).toISOString().slice(0, 10));
      expect(dayNumber(date)).toBe(number);
    }), { ...RUNS, examples: examples.map(date => [dayNumber(date)]) });
    for (const date of examples) expect(dateOf(dayNumber(date))).toBe(date);
  });

  test('放不下時恰為放不下的類別；放得下時日期平移相同的天數、其他內容不變，套用新日期後通過驗證', () => {
    expect([...SHIFT_CATEGORIES]).toEqual(CATEGORIES);
    const seen = new Set();
    const scenario = fc.record({
      generated: fc.oneof({ weight: 4, arbitrary: itineraryState() }, { weight: 1, arbitrary: legacyState() }),
      length: lengthPlan,
      start: startPlan
    });
    fc.assert(fc.property(scenario, ({ generated, length, start }) => {
      fc.pre(isValidState(generated));
      for (const tag of checkShift(structuredClone(generated), length, start)) seen.add(tag);
    }), BOUNDED);
    // 產生的輸入涵蓋成功與失敗、每一個類別、只有部分類別放不下、平移 0 天與其他天數、延長天數與缺少的鍵
    expect(missing(seen, ['fail', 'fail:partial', ...CATEGORIES.map(category => `fail:${category}`),
      'ok', 'ok:offset', 'ok:offset0', 'ok:longer', 'ok:missing-key'])).toEqual([]);
  }, TIMEOUT);

  test('旅行最後只有 Day_Settings 的日子：沒有 Day_Title 與 Place 的被捨棄，有 Day_Title 或 Place 的回報「每日設定」', () => {
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
      // 加上的日子與 Day_Settings 仍符合驗證規則
      expect(isValidState(before)).toBe(true);
      for (const tag of checkShift(before, length, start)) seen.add(tag);
    }), BOUNDED);
    // 涵蓋縮短天數並捨棄 Day_Settings 的成功，以及只有「每日設定」放不下的失敗
    expect(missing(seen, ['ok', 'ok:shorter', 'ok:dropped', 'fail', 'fail:only:每日設定'])).toEqual([]);
  }, TIMEOUT);
});
