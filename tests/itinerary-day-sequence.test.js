// Feature: trip-planning-workflow-enhance, Property 6: Day_Sequence 的排列規則
// **Validates: Requirements 5.2, 7.1, 8.2, 11.4, 14.8, 14.13**
//
// 對每一組通過驗證的 Trip_State s 與其中每一個 Trip_Day d，檢查 dayModel(s, d, shoppingPlan(s)) 的 blocks（Day_Sequence；
// 行程圖依它排列每一天的路線區塊與活動區塊（需求 11.4），規劃行程的「活動」分段依同樣的順序列出 Activity 與
// Meal_Moment（需求 7.1））：
// (a) 路線區塊（需求 14.8(a)(b)、14.15 與 5.2）：Arrival 區塊恰為當天的 Arrival_Routes（終點是 Day_Location、起點不是
//     Day_Location 的路線），First_Day 另加每台在 First_Day 沒有路線、`meeting` 拆得出時間或地點的車的舊出發行；Other
//     區塊恰為當天其他的路線。兩者都依需求 5.2 排列：有出發時間的在前、由早到晚，時間相同或都沒有時依車輛在
//     state.vehicles 的順序；沒有任何行的區塊省略；排序時間是區塊中最早的出發時間（含舊出發時間），都沒有時為 null。
//     dayModel() 的 arrivalRoutes、otherRoutes，以及規劃行程路線收起列使用的 sortedRoutes()（需求 5.2）也依同一個順序。
// (b) 活動區塊（需求 14.8(e)、14.13 與 8.2）：依序接起來恰為當天每筆 Activity 與每筆 Meal 各一次，時間由早到晚（Meal 為
//     需求 8.2 的 Meal_Time：自訂時間，否則依餐次的預設時間，其他舊資料餐次為 12:00，項目的 time 也等於它）；時間相同時
//     Activity 在前，Activity 依 state.activities 的順序，Meal 依 mealSlotRank() 再依 state.meals 的順序。
// (c) 有排序時間 T 的路線區塊，前面每個 Activity 與 Meal_Moment 的時間都小於等於 T，後面每個都大於 T；沒有排序時間的
//     Arrival 區塊前面沒有項目，Other 區塊後面沒有項目（需求 14.8(c)）。
// (d) 相鄰的兩個路線區塊依排序時間由早到晚，排序時間相同或其中一個沒有排序時間時 Arrival 在前（需求 14.8(d)）。
// (e) 沒有空的區塊，也沒有相鄰的兩個活動區塊（需求 14.8(a)(e)）；區塊只有 Arrival、Other 兩種路線區塊與活動區塊。
// 預期的內容與順序在本檔依條文獨立寫出：Day_Location（Day_Settings 的 Place，未設定時為非空白的旅行目的地）、
// Arrival_Routes 與 Other_Routes 的劃分、舊出發行、需求 5.2 與 14.13 的排序，以及需求 8.2 的餐次預設時間。只沿用條文
// 指定的規則來源：Trip_Day 依 dateRange()（State_Validator 的日期範圍）、舊出發資料依 parseVehicleMeeting()（需求 14.15、
// 19.7）、餐次順序依 mealSlotRank()（需求 14.13 指定與 src/meal-order.js 相同）。
//
// 四個測試使用不同的產生器：itineraryState()（需求 23.3 的值域）；本檔的 sequenceState()（只放 Day_Sequence 用到的資料，
// 時間集中在少數幾個值，讓 (c)、(d) 的每一種情況與 (a)、(b) 的同時間排序都常出現）；endMixState()（同一個區塊有多條
// 路線，First_Day 的 Arrival 區塊夾著舊出發行）；legacyState()（本功能之前的 Trip_State，First_Day 只有舊出發行）。每個
// 測試另外確認列出的情況至少出現一次；依產生器的機率，列出的情況在該測試的組數中都幾乎必然出現（沒出現的機率都低於
// 千萬分之一）。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { dayModel, shoppingPlan, sortedRoutes } from '../src/itinerary-derive.js';
import { ACTIVITY_TYPES, DESTINATION_REF } from '../src/itinerary-model.js';
import { mealSlotRank } from '../src/meal-order.js';
import { dateRange, isValidState } from '../src/model.js';
import { parseVehicleMeeting } from '../src/vehicle-departures.js';
import { endMixState, itineraryState, legacyState } from './support/itinerary-arb.js';

// fc.gen() 產生的 Trip_State 很大，屬性失敗時縮小可能要好幾分鐘，而 bun test 無法中斷同步執行的測試，所以 30 秒後
// 停止縮小並回報目前的反例；尚未跑完全部組數就到時間也算失敗（failOnInterrupt）。bun test 不顯示錯誤的 cause，所以把
// 失敗的檢查（日期、規則與不符合的行或項目）放進回報的訊息（includeErrorInReport）。
const bounded = numRuns => ({
  numRuns, includeErrorInReport: true, plugins: [fc.interruptAfterTimeLimit(30_000, { failOnInterrupt: true })]
});
const TIMEOUT = 60_000;

// ---- 本檔獨立撰寫的規則 ----
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
/** HH:MM；沒有時間（省略或空字串）時為 ''。 */
const hhmm = value => (typeof value === 'string' && TIME.test(value) ? value : '');
/** 去除前後的 Unicode White_Space（含全形空白、換行與 Tab）後為空。 */
const isBlank = text => String(text ?? '').replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '') === '';
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// 需求 8.2：沒有自訂時間時依餐次預設（早餐、午餐、下午茶、晚餐、消夜依序為下列時間；「早」「午」「晚」「宵夜」依
// 料理菜單的餐次排序視為早餐、午餐、晚餐、消夜），其他舊資料餐次為 12:00。
const MEAL_DEFAULTS = Object.freeze(['08:30', '12:00', '15:00', '18:00', '21:00']);
const mealTimeOf = meal => hhmm(meal.time) || (MEAL_DEFAULTS[mealSlotRank(meal.slot)] ?? '12:00');
/** 需求 5.2（舊出發行依需求 14.15 一起排序）：有出發時間的在前、由早到晚；時間相同或都沒有時依車輛順序。 */
const byDeparture = (a, b) => (a.time === '') - (b.time === '') || compare(a.time, b.time) || a.vehicleIndex - b.vehicleIndex;
/** 需求 14.13：時間由早到晚；時間相同時 Activity 在前，Activity 依 state.activities、Meal 依餐次再依 state.meals 的順序。 */
const byMoment = (a, b) => compare(a.time, b.time) || a.group - b.group || a.rank - b.rank || a.index - b.index;

/**
 * date 這一天依條文算出的預期內容，都已排序：Arrival 區塊與 Other 區塊的行（{ type, id, time, vehicleIndex }，路線行的
 * id 是 Route 的識別碼，舊出發行是車輛的識別碼）、當天全部路線的識別碼（需求 5.2 的順序），以及 Activity 與
 * Meal_Moment（{ type, id, time }）。
 */
function expectedDay(state, date, firstDay) {
  const routes = state.routes ?? [];
  const vehicleIndex = new Map(state.vehicles.map((vehicle, index) => [vehicle.id, index]));
  // Day_Location（詞彙表、D17）：Day_Settings 的 Place；未設定時為旅行目的地，目的地也空白時沒有 Day_Location。
  const setting = (state.daySettings ?? []).find(item => item.date === date);
  const location = typeof setting?.place === 'string' && setting.place !== '' ? setting.place
    : isBlank(state.trip.destination) ? null : DESTINATION_REF;
  const today = routes.filter(route => route.date === date)
    .map(route => ({ type: 'route', id: route.id, time: hhmm(route.time), vehicleIndex: vehicleIndex.get(route.vehicleId), route }));
  // Arrival_Routes：終點是 Day_Location、起點不是 Day_Location；沒有 Day_Location 時每一條都是 Other_Routes。
  const arriving = line => location !== null && line.route.to === location && line.route.from !== location;
  // 需求 14.15：在 First_Day 沒有路線、`meeting` 拆得出時間或地點的車，各有一個舊出發行。
  const legacy = date !== firstDay ? [] : state.vehicles.flatMap((vehicle, index) => {
    if (routes.some(route => route.date === date && route.vehicleId === vehicle.id)) return [];
    const { time, location: place } = parseVehicleMeeting(vehicle.meeting);
    return time || place ? [{ type: 'legacy', id: vehicle.id, time, vehicleIndex: index }] : [];
  });
  const moments = [
    ...state.activities.flatMap((activity, index) => (activity.date === date
      ? [{ type: 'activity', id: activity.id, time: activity.time, group: 0, rank: 0, index }] : [])),
    ...state.meals.flatMap((meal, index) => (meal.date === date
      ? [{ type: 'meal', id: meal.id, time: mealTimeOf(meal), group: 1, rank: mealSlotRank(meal.slot), index }] : []))
  ];
  const lineKey = ({ type, id, time, vehicleIndex: order }) => ({ type, id, time, vehicleIndex: order });
  return {
    arrival: [...today.filter(arriving), ...legacy].sort(byDeparture).map(lineKey),
    other: today.filter(line => !arriving(line)).sort(byDeparture).map(lineKey),
    routes: [...today].sort(byDeparture).map(line => line.id),
    items: moments.sort(byMoment).map(({ type, id, time }) => ({ type, id, time }))
  };
}

// ---- dayModel() 的結果 ----
const isRoutes = block => block.type === 'routes';
const isMoments = block => block.type === 'moments';
const lineOf = line => ({ type: line.type, id: line.type === 'route' ? line.route?.id : line.vehicle?.id, time: line.time, vehicleIndex: line.vehicleIndex });
const itemOf = item => ({ type: item.type, id: item.type === 'activity' ? item.activity?.id : item.meal?.id, time: item.time });
const itemsIn = blocks => blocks.filter(isMoments).flatMap(block => block.items.map(itemOf));
/** 行的最早出發時間；都沒有時為 null（需求 14.8(b)）。 */
const earliest = lines => lines.map(line => line.time).filter(Boolean).sort()[0] ?? null;

/** 檢查 date 這一天的 Day_Sequence 符合 (a) 至 (e)，回傳這一天出現的情況（涵蓋範圍的檢查用）。 */
function checkDay(state, date, firstDay, plan) {
  const model = dayModel(state, date, plan);
  expect({ date, model: model === null ? null : 'day model' }).toEqual({ date, model: 'day model' });
  const want = expectedDay(state, date, firstDay);
  const { blocks } = model;
  const kinds = blocks.map(block => (isRoutes(block) ? block.kind : block.type));

  // (e) 區塊只有 Arrival、Other 兩種路線區塊與活動區塊；(a) 路線區塊只在有行時出現，各一個。
  expect({ date, arrival: kinds.filter(kind => kind === 'arrival').length, other: kinds.filter(kind => kind === 'other').length,
    unknown: kinds.filter(kind => !['arrival', 'other', 'moments'].includes(kind)) })
    .toEqual({ date, arrival: want.arrival.length ? 1 : 0, other: want.other.length ? 1 : 0, unknown: [] });

  // (a) 每個路線區塊的行與順序，以及排序時間。
  for (const [kind, lines] of [['arrival', want.arrival], ['other', want.other]]) {
    const block = blocks.find(item => isRoutes(item) && item.kind === kind);
    if (!block) continue;
    expect({ date, kind, lines: block.lines.map(lineOf), sortTime: block.sortTime })
      .toEqual({ date, kind, lines, sortTime: earliest(lines) });
  }
  expect({
    date,
    arrivalRoutes: model.arrivalRoutes.map(route => route.id),
    otherRoutes: model.otherRoutes.map(route => route.id),
    sortedRoutes: sortedRoutes(state, date).map(route => route.id)
  }).toEqual({
    date,
    arrivalRoutes: want.arrival.filter(line => line.type === 'route').map(line => line.id),
    otherRoutes: want.other.map(line => line.id),
    sortedRoutes: want.routes
  });

  // (b) 活動區塊依序接起來恰為當天的每筆 Activity 與 Meal 各一次，依需求 14.13 排列。
  expect({ date, items: itemsIn(blocks) }).toEqual({ date, items: want.items });

  // (e) 沒有空的區塊，也沒有相鄰的兩個活動區塊。
  const empty = blocks.flatMap((block, i) => ((isRoutes(block) ? block.lines : block.items)?.length ? [] : [i]));
  const adjacentMoments = blocks.flatMap((block, i) => (i > 0 && isMoments(block) && isMoments(blocks[i - 1]) ? [i] : []));
  expect({ date, kinds, empty, adjacentMoments }).toEqual({ date, kinds, empty: [], adjacentMoments: [] });

  // (c) 路線區塊與前後項目的時間。
  blocks.forEach((block, p) => {
    if (!isRoutes(block)) return;
    const before = itemsIn(blocks.slice(0, p)), after = itemsIn(blocks.slice(p + 1));
    const sortTime = block.sortTime;
    const misplaced = sortTime !== null
      ? [...before.filter(item => !(item.time <= sortTime)), ...after.filter(item => !(item.time > sortTime))]
      : block.kind === 'arrival' ? before : after;
    expect({ date, kinds, block: block.kind, sortTime, misplaced }).toEqual({ date, kinds, block: block.kind, sortTime, misplaced: [] });
  });

  // (d) 相鄰的兩個路線區塊。
  for (let i = 1; i < blocks.length; i++) {
    const [a, b] = [blocks[i - 1], blocks[i]];
    if (!isRoutes(a) || !isRoutes(b)) continue;
    const pair = [[a.kind, a.sortTime], [b.kind, b.sortTime]];
    const inOrder = a.sortTime !== null && b.sortTime !== null && a.sortTime !== b.sortTime ? a.sortTime < b.sortTime : a.kind === 'arrival';
    expect({ date, pair, inOrder }).toEqual({ date, pair, inOrder: true });
  }
  return dayCases(blocks);
}

// ---- 涵蓋範圍 ----
/** 這一天的 Day_Sequence 出現的情況。 */
function dayCases(blocks) {
  const cases = [];
  const routeBlocks = blocks.filter(isRoutes);
  const items = blocks.filter(isMoments).flatMap(block => block.items);
  if (!blocks.length) cases.push('沒有任何區塊的日子');
  else if (!routeBlocks.length) cases.push('只有活動區塊的日子');
  else if (!items.length) cases.push('只有路線區塊的日子');
  blocks.forEach((block, p) => {
    if (!isRoutes(block)) return;
    const name = block.kind === 'arrival' ? 'Arrival' : 'Other';
    const before = itemsIn(blocks.slice(0, p)), after = itemsIn(blocks.slice(p + 1));
    cases.push(`${name} 區塊${block.sortTime === null ? '沒有' : '有'}排序時間`);
    const types = new Set(block.lines.map(line => line.type));
    if (types.has('legacy')) cases.push(types.has('route') ? '舊出發行與路線行在同一個區塊' : '只有舊出發行的區塊');
    const times = block.lines.map(line => line.time);
    if (times.some((time, i) => i > 0 && time !== '' && time === times[i - 1])) cases.push('出發時間相同的行');
    if (times.some((time, i) => i > 0 && time === '' && times[i - 1] === '')) cases.push('兩行以上沒有出發時間');
    if (times[0] !== '' && times.at(-1) === '') cases.push('沒有出發時間的行排在有時間的行之後');
    if (block.sortTime === null) {
      if (block.kind === 'arrival' && after.length) cases.push('沒有排序時間的 Arrival 區塊之後有項目');
      if (block.kind === 'other' && before.length) cases.push('沒有排序時間的 Other 區塊之前有項目');
      return;
    }
    if (before.length && after.length) cases.push(`${name} 區塊前後都有項目`);
    if (before.some(item => item.time === block.sortTime)) cases.push('項目的時間等於排序時間');
  });
  let adjacent = false;
  for (let i = 1; i < blocks.length; i++) {
    const [a, b] = [blocks[i - 1], blocks[i]];
    if (!isRoutes(a) || !isRoutes(b)) continue;
    adjacent = true;
    if (a.sortTime === null && b.sortTime === null) cases.push('相鄰的路線區塊都沒有排序時間');
    else if (a.sortTime === null || b.sortTime === null) {
      cases.push((a.kind === 'arrival' ? a : b).sortTime === null ? '相鄰時 Arrival 區塊沒有排序時間' : '相鄰時 Other 區塊沒有排序時間');
    } else if (a.sortTime === b.sortTime) cases.push('相鄰的路線區塊排序時間相同');
    else cases.push(a.kind === 'other' ? '相鄰時 Other 區塊較早' : '相鄰時 Arrival 區塊較早');
  }
  if (routeBlocks.length === 2 && !adjacent) cases.push('兩個路線區塊之間有活動區塊');
  items.forEach((item, i) => {
    const prev = items[i - 1];
    if (!prev || prev.time !== item.time) return;
    if (prev.type === 'activity') cases.push(item.type === 'activity' ? '時間相同的 Activity' : '時間相同的 Activity 與 Meal');
    else if (item.type === 'meal') {
      cases.push(mealSlotRank(prev.meal.slot) === mealSlotRank(item.meal.slot) ? '時間與餐次都相同的 Meal' : '時間相同、餐次不同的 Meal');
    }
  });
  for (const item of items) {
    if (item.type !== 'meal' || item.meal.time !== undefined) continue;
    cases.push(mealSlotRank(item.meal.slot) < MEAL_DEFAULTS.length ? '使用餐次預設時間的 Meal' : '其他舊資料餐次的 Meal');
  }
  return cases;
}
const missing = (seen, required) => required.filter(name => !seen.has(name));
// 路線區塊的放置（(c)、(d)）與同時間排序（(a)、(b)）的每一種情況；sequenceState() 的測試要求全部出現。
const PLACEMENT_CASES = Object.freeze([
  '沒有任何區塊的日子', '只有活動區塊的日子', '只有路線區塊的日子',
  'Arrival 區塊有排序時間', 'Arrival 區塊沒有排序時間', 'Other 區塊有排序時間', 'Other 區塊沒有排序時間',
  'Arrival 區塊前後都有項目', 'Other 區塊前後都有項目', '項目的時間等於排序時間',
  '沒有排序時間的 Arrival 區塊之後有項目', '沒有排序時間的 Other 區塊之前有項目',
  '相鄰時 Arrival 區塊較早', '相鄰時 Other 區塊較早', '相鄰的路線區塊排序時間相同',
  '相鄰時 Arrival 區塊沒有排序時間', '相鄰時 Other 區塊沒有排序時間', '相鄰的路線區塊都沒有排序時間', '兩個路線區塊之間有活動區塊'
]);
const ORDER_CASES = Object.freeze([
  '只有舊出發行的區塊', '舊出發行與路線行在同一個區塊',
  '出發時間相同的行', '兩行以上沒有出發時間', '沒有出發時間的行排在有時間的行之後',
  '時間相同的 Activity', '時間相同的 Activity 與 Meal', '時間與餐次都相同的 Meal', '時間相同、餐次不同的 Meal',
  '使用餐次預設時間的 Meal', '其他舊資料餐次的 Meal'
]);

/** 檢查 state 的每一個 Trip_Day，把出現的情況加入 seen。 */
function checkState(state, seen) {
  const dates = dateRange(state.trip.startDate, state.trip.endDate);
  const plan = shoppingPlan(state);
  for (const date of dates) for (const name of checkDay(state, date, dates[0], plan)) seen.add(name);
}

// ---- 只放 Day_Sequence 用到的資料的 Trip_State ----
// 1 到 5 天；0 到 6 台車；Day_Location 是旅行目的地、一個 Place（Day_Settings）、兩者依日子混合，或沒有（旅行目的地空白，
// 每條路線都是 Other_Routes）。每台車每天沒有路線、有一條 Arrival 路線（終點是 Day_Location、起點不是），或一條 Other
// 路線（終點不是 Day_Location，或起點與終點都是 Day_Location）。每一天的 Arrival 與 Other 路線各自選一種時間方式：都沒有
// 出發時間（省略或空字串）、都取自 SEQ_TIMES，或兩者混合；舊出發資料有時間與地點、只有時間、只有地點或空白。一半的
// 日子沒有活動與餐點，其他日子有 1 到 4 筆活動與 0 到 3 筆餐點，時間取自 SEQ_TIMES，餐點也可能沿用餐次的預設時間
// （含舊資料與自訂餐次）。SEQ_TIMES 含早餐、午餐、晚餐的預設時間，以及比它們都早的 07:00，所以 PLACEMENT_CASES 與
// ORDER_CASES 的每一種情況都常出現。state.routes、state.activities 與 state.meals 的順序打亂，與日期及車輛順序無關。
const SEQ_TIMES = Object.freeze(['07:00', '08:30', '12:00', '18:00']);
const SEQ_SLOTS = Object.freeze(['早餐', '午餐', '下午茶', '晚餐', '消夜', '早', '宵夜', '點心時間', '早午餐']);
const SEQ_MEETINGS = Object.freeze(['', '07:00', '12:00 · 集合點', '集合點']);
const SEQ_DATES = Object.freeze(['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']);
const SEQ_ROUTE_TIMES = Object.freeze({
  untimed: [undefined, ''], timed: SEQ_TIMES, mixed: [undefined, '', ...SEQ_TIMES]
});
function buildSequenceState(g) {
  const int = (min, max) => g(fc.integer, { min, max });
  const pick = list => list[int(0, list.length - 1)];
  const shuffle = list => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const dates = SEQ_DATES.slice(0, int(1, SEQ_DATES.length));
  const mode = pick(['destination', 'place', 'mixed', 'none']);
  const destination = mode === 'none' ? '' : '夕淞度日營區';
  const places = [{ id: 'pl-a', name: '出發地點 A' }, { id: 'pl-b', name: '出發地點 B' }, { id: 'pl-camp', name: '營位' }];
  const refs = [...places.map(place => place.id), ...(destination ? [DESTINATION_REF] : [])];
  const vehicles = Array.from({ length: int(0, 6) }, (_, i) => ({
    id: `v${i}`, name: `車${i}`, driver: '', seats: 4, passengers: [], meeting: pick(SEQ_MEETINGS)
  }));
  const routes = [], activities = [], meals = [], daySettings = [];
  for (const date of dates) {
    const camp = mode === 'place' || (mode === 'mixed' && int(0, 1) === 1);
    if (camp) daySettings.push({ date, place: 'pl-camp' });
    const location = camp ? 'pl-camp' : destination ? DESTINATION_REF : null;
    const times = { arrival: pick(Object.keys(SEQ_ROUTE_TIMES)), other: pick(Object.keys(SEQ_ROUTE_TIMES)) };
    for (const vehicle of vehicles) {
      const role = pick(['none', 'arrival', 'arrival', 'other', 'other']);
      if (role === 'none') continue;
      const arrival = role === 'arrival' && location !== null;
      const to = arrival ? location : pick(refs);
      const from = arrival ? pick(refs.filter(ref => ref !== location)) : to === location ? location : pick(refs);
      const route = { id: `rt-${date}-${vehicle.id}`, date, vehicleId: vehicle.id, from, to };
      const time = pick(SEQ_ROUTE_TIMES[arrival ? times.arrival : times.other]);
      if (time !== undefined) route.time = time;
      routes.push(route);
    }
    if (int(0, 1) === 0) continue;
    for (let i = int(1, 4); i > 0; i--) {
      const n = activities.length;
      activities.push({ id: `a${n}`, date, time: pick(SEQ_TIMES), title: `活動${n}`, type: pick(ACTIVITY_TYPES), location: '', note: '', people: [], done: false });
    }
    for (let i = int(0, 3); i > 0; i--) {
      const n = meals.length;
      const meal = { id: `m${n}`, date, slot: pick(SEQ_SLOTS), title: `料理${n}`, cookId: '', servings: 4, ingredients: '', notes: '' };
      const time = pick([undefined, undefined, ...SEQ_TIMES]);
      if (time !== undefined) meal.time = time;
      meals.push(meal);
    }
  }
  return {
    schema: 1, revision: 0, currentUser: 'p1', joined: true,
    trip: { title: '小小旅行', destination, startDate: dates[0], endDate: dates.at(-1), description: '', note: '' },
    people: [{ id: 'p1', name: '小安', color: 'coral', role: '' }],
    activities: shuffle(activities), meals: shuffle(meals), shopping: [], gear: [], vehicles, events: [], departed: [],
    places, routes: shuffle(routes), daySettings: shuffle(daySettings)
  };
}
const sequenceState = () => fc.gen().map(buildSequenceState);

describe('Property 6: Day_Sequence 的排列規則', () => {
  test('itineraryState()：每一天的 blocks 符合 (a) 至 (e)', () => {
    const seen = new Set();
    fc.assert(fc.property(itineraryState(), state => {
      fc.pre(isValidState(state));
      checkState(state, seen);
    }), bounded(200));
    expect(missing(seen, [
      '沒有任何區塊的日子', '只有活動區塊的日子', '只有路線區塊的日子',
      'Arrival 區塊有排序時間', 'Arrival 區塊沒有排序時間', 'Other 區塊有排序時間', 'Other 區塊沒有排序時間',
      'Arrival 區塊前後都有項目', 'Other 區塊前後都有項目', '項目的時間等於排序時間',
      '沒有排序時間的 Arrival 區塊之後有項目', '沒有排序時間的 Other 區塊之前有項目',
      '相鄰時 Arrival 區塊較早', '相鄰時 Other 區塊較早', '相鄰時 Arrival 區塊沒有排序時間', '兩個路線區塊之間有活動區塊',
      '只有舊出發行的區塊', '出發時間相同的行', '兩行以上沒有出發時間', '沒有出發時間的行排在有時間的行之後',
      '時間相同的 Activity', '時間相同的 Activity 與 Meal', '時間與餐次都相同的 Meal', '時間相同、餐次不同的 Meal',
      '使用餐次預設時間的 Meal', '其他舊資料餐次的 Meal'
    ])).toEqual([]);
  }, TIMEOUT);

  test('sequenceState()：路線區塊放置與同時間排序的每一種情況', () => {
    const seen = new Set();
    fc.assert(fc.property(sequenceState(), state => {
      // 本檔產生的資料必須通過驗證，否則就不是 Property 6 的輸入
      expect(isValidState(state)).toBe(true);
      checkState(state, seen);
    }), bounded(500));
    expect(missing(seen, [...PLACEMENT_CASES, ...ORDER_CASES])).toEqual([]);
  }, TIMEOUT);

  test('endMixState()：同一個區塊有多條路線，First_Day 的 Arrival 區塊夾著舊出發行', () => {
    const seen = new Set();
    fc.assert(fc.property(endMixState(), ({ state }) => {
      fc.pre(isValidState(state));
      checkState(state, seen);
    }), bounded(100));
    expect(missing(seen, [
      '舊出發行與路線行在同一個區塊', '出發時間相同的行', '兩行以上沒有出發時間', '沒有出發時間的行排在有時間的行之後'
    ])).toEqual([]);
  }, TIMEOUT);

  test('legacyState()：本功能之前的 Trip_State，First_Day 只有舊出發行', () => {
    const seen = new Set();
    fc.assert(fc.property(legacyState(), state => {
      fc.pre(isValidState(state));
      checkState(state, seen);
    }), bounded(100));
    expect(missing(seen, ['只有舊出發行的區塊', 'Arrival 區塊有排序時間', '項目的時間等於排序時間'])).toEqual([]);
  }, TIMEOUT);
});
