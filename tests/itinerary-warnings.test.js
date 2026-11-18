// Feature: trip-planning-workflow-enhance, Property 12: 規劃提醒依規則產生
// **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6**
//
// 對每一組通過驗證的 Trip_State，planningWarnings(state, plan) 的結果與本檔依需求 9.1 至 9.5 直接寫成的參考實作
// referenceWarnings() 相同：
// - 結果是依 Trip_Day 的順序、每天恰好一項的 Map（沒有其他日期）；每天的清單與參考實作的文字與順序都相同：依條文
//   9.1 至 9.5 的順序，同一條文的多則提醒依車輛在 state.vehicles 的順序（9.2 也依車輛順序，不依出發時間），同一條路線的
//   多個 Shopping_Stop 依 Stop 的順序，需求 9.5 的兩種提醒不依種類分開（需求 9.6）。
// - 沒有任何路線的日子沒有提醒（每一條條文都需要當天的路線，所以也沒有「這一天還沒有路線」）；出發時間等於
//   Arrival_Time 的 Arrival_Route 不產生「晚於預計抵達」。
// - 不修改 state 與 plan；省略 plan（預設為 shoppingPlan(state)）或傳入 JSON 往返後的 Trip_State 都得到相同的結果。
// 參考實作只取用 tripDays()（Trip_Day 與第 N 天）與 cleanText()（提醒中的車名與地點名稱是顯示文字，需求 14.16）；
// Day_Location、Arrival_Time、Arrival_Routes、Car_Members、Buyer_Car、First_Shopping_Stop、Stop_Items 與提醒文字都依需求
// 與詞彙表在本檔算出。另一個測試先以需求 9 的範例確認參考實作本身。
//
// Trip_State 來自 itineraryState()（另有標記文字的變體）、endMixState()（同一天有多台車的路線區塊）、舊手冊 legacyState()，
// 以及本檔的 aimedState()：在路線最多、且有 Day_Location 的一天，把其他起點的路線終點改成 Day_Location、依車輛順序由晚
// 到早重排這些路線的出發時間，並把 Arrival_Time 設成其中一條的出發時間或 00:00（或清除），有時把每個採買品項的名稱
// 改成空白或都改成已買齊。這讓出發時間等於 Arrival_Time、多則「晚於預計抵達」的車輛順序與出發時間不同、Stop_Items 都已
// 買齊，以及 Stop_Items 的名稱都是空白（Shopping_Summary 為空字串，但仍有 Stop_Items）等少見的情況常常出現。最後確認每一條
// 條文（需求 9.5 的兩種提醒分開計算）與 COVERAGE 列出的情況都至少出現一次。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { legacyDepartures, planningWarnings, shoppingPlan, tripDays } from '../src/itinerary-derive.js';
import { DESTINATION_REF, cleanText } from '../src/itinerary-model.js';
import { isValidState } from '../src/model.js';
import { exampleTrip } from './fixtures/example-trip.js';
import { endMixState, itineraryState, legacyState } from './support/itinerary-arb.js';

const RUNS = { numRuns: 400 };
// 400 組通常 3 到 4 秒。fc.gen() 產生的 Trip_State 很大，屬性失敗時縮小可能要好幾分鐘，而 bun test 無法中斷同步執行的
// 測試，所以 60 秒後停止縮小並回報目前的反例；尚未跑完 400 組就到時間也算失敗（failOnInterrupt）。
const BOUNDED = { ...RUNS, plugins: [fc.interruptAfterTimeLimit(60000, { failOnInterrupt: true })] };
const TIMEOUT = 120000;

// ---- 需求與詞彙表的規則 ----
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
/** 時間欄位的 HH:MM；省略或空字串（沒有時間）時為 ''。 */
const timeOf = value => (typeof value === 'string' && HHMM.test(value) ? value : '');
const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
/** 去除前後的空白字元（Unicode White_Space，含全形空白與換行）後為空。 */
const isBlank = text => /^\p{White_Space}*$/u.test(text);

/**
 * 一個 Trip_Day 的路線與抵達資料：
 * - dayRoutes：當天的 Route，依車輛在 state.vehicles 的順序（有效的 Trip_State 每台車每天最多一條），每項 { vehicle, route }。
 * - location：Day_Location 的引用值。Day_Settings 中的 Place；未設定時為 Destination_Place（'@destination'）；旅行目的地
 *   也空白時為 null（詞彙表、D17）。
 * - arrival：Arrival_Time（HH:MM），沒有時為 ''。
 * - arriving(entry)：是否為 Arrival_Routes，也就是終點是 Day_Location、起點不是 Day_Location 的 Route（詞彙表）。
 */
function dayFacts(state, date) {
  const routes = state.routes ?? [];
  const dayRoutes = state.vehicles.flatMap(vehicle => routes
    .filter(route => route.date === date && route.vehicleId === vehicle.id)
    .map(route => ({ vehicle, route })));
  const setting = (state.daySettings ?? []).find(item => item.date === date);
  const location = setting?.place ? setting.place : isBlank(state.trip.destination) ? null : DESTINATION_REF;
  const arrival = timeOf(setting?.arrival);
  const arriving = ({ route }) => location !== null && route.to === location && route.from !== location;
  return { dayRoutes, location, arrival, arriving };
}

/**
 * 採買的推導（需求 6.11、D28、D29）：
 * - buyerCar(person)：Buyer_Car，依 state.vehicles 的順序第一台 Car_Members（不是待分配的駕駛與全部乘客）包含該旅伴的車。
 * - firstShoppingStop(vehicle)：First_Shopping_Stop。在該車有 Shopping_Stop 的 Route 中取 Trip_Day 最早的一條，再取其中
 *   Stop 順序最前面的 Shopping_Stop；回傳 { stop, n }（n 是那一天的第 N 天），沒有時為 null。
 * - stopItems(vehicle)：該車 First_Shopping_Stop 的 Stop_Items，也就是 Shopping_Assignee 不是待分配、且其 Buyer_Car 是
 *   這台車的品項（含已買齊的品項）。
 */
function shoppingFacts(state) {
  const dayNumber = new Map(tripDays(state).map(day => [day.date, day.n]));
  const shoppingStops = route => (route.stops ?? []).filter(stop => stop.kind === 'shop');
  const carMembers = vehicle => [...(vehicle.driver === '' ? [] : [vehicle.driver]), ...vehicle.passengers];
  const buyerCar = person => state.vehicles.find(vehicle => carMembers(vehicle).includes(person));
  const firstShoppingStop = vehicle => {
    const candidates = (state.routes ?? []).filter(route => route.vehicleId === vehicle.id && shoppingStops(route).length > 0);
    if (!candidates.length) return null;
    const earliest = candidates.reduce((best, route) => (dayNumber.get(route.date) < dayNumber.get(best.date) ? route : best));
    return { stop: shoppingStops(earliest)[0], n: dayNumber.get(earliest.date) };
  };
  const stopItems = vehicle => state.shopping.filter(item => item.assignee !== '' && buyerCar(item.assignee) === vehicle);
  return { shoppingStops, buyerCar, firstShoppingStop, stopItems };
}

/**
 * 參考實作：依需求 9.1 至 9.5 的條文與 9.6 的順序，直接由 Trip_State 算出每個 Trip_Day 的 Planning_Warning。
 * 回傳依 Trip_Day 順序的 [{ date, n, warnings }]；warnings 的每一項為 { clause, text, vehicle, route }，clause 是
 * '9.1' 至 '9.4'、'9.5 沒有品項' 或 '9.5 只標示採買'，vehicle 與 route 是產生提醒的車與路線（9.3 為 null）。只讀取 state。
 */
function referenceWarnings(state) {
  const places = state.places ?? [];
  // 顯示的車名與地點名稱（需求 14.16）；Destination_Place 的名稱是旅行目的地
  const carName = vehicle => cleanText(vehicle.name);
  const placeName = ref => cleanText(ref === DESTINATION_REF ? state.trip.destination : places.find(place => place.id === ref).name);
  const { shoppingStops, firstShoppingStop, stopItems } = shoppingFacts(state);

  return tripDays(state).map(({ date, n }) => {
    const { dayRoutes, arrival, arriving } = dayFacts(state, date);
    const warnings = [];
    const add = (clause, text, vehicle = null, route = null) => warnings.push({ clause, text, vehicle, route });

    // 9.1：當天至少有一條 Route 時，每台當天沒有 Route 的車（包含只有 Legacy_Departure 的車）
    if (dayRoutes.length) {
      for (const vehicle of state.vehicles) {
        if (!dayRoutes.some(entry => entry.vehicle === vehicle)) add('9.1', `${carName(vehicle)}這一天還沒有路線`, vehicle);
      }
    }
    // 9.2：有 Arrival_Time 時，Arrival_Routes 中出發時間晚於 Arrival_Time 的 Route（相等、沒有出發時間與 Other_Routes 都不算）
    if (arrival) {
      for (const entry of dayRoutes.filter(arriving)) {
        const time = timeOf(entry.route.time);
        if (time && minutes(time) > minutes(arrival)) {
          add('9.2', `${carName(entry.vehicle)} ${time} 出發，晚於預計抵達 ${arrival}`, entry.vehicle, entry.route);
        }
      }
    }
    // 9.3：有 Arrival_Routes 但沒有 Arrival_Time，不論 Arrival_Routes 有幾條都只有一則
    if (!arrival && dayRoutes.some(arriving)) add('9.3', '還沒填預計抵達時間');
    // 9.4：沒有出發時間的 Route，Arrival_Routes 與 Other_Routes 都適用（Legacy_Departure 不是 Route）
    for (const { vehicle, route } of dayRoutes) {
      if (!timeOf(route.time)) add('9.4', `${carName(vehicle)}的出發時間待定`, vehicle, route);
    }
    // 9.5：每個 Shopping_Stop，依車輛順序、同一條 Route 依 Stop 的順序，兩種提醒一起排列
    for (const { vehicle, route } of dayRoutes) {
      const first = firstShoppingStop(vehicle);
      for (const stop of shoppingStops(route)) {
        const at = `${carName(vehicle)}在${placeName(stop.place)}`;
        if (stop !== first.stop) {
          add('9.5 只標示採買', `${at}只標示採買，品項列在第 ${first.n} 天的${placeName(first.stop.place)}`, vehicle, route);
        } else if (!stopItems(vehicle).length) add('9.5 沒有品項', `${at}的採買沒有品項`, vehicle, route);
      }
    }
    return { date, n, warnings };
  });
}
const referenceTexts = state => referenceWarnings(state).map(({ date, warnings }) => [date, warnings.map(warning => warning.text)]);

// ---- 讓少見情況常出現的 Trip_State ----
/** 3/4 的機率為 true；縮小時變成 false。 */
const often = fc.integer({ min: 0, max: 3 }).map(n => n !== 0);
const aimPlan = fc.record({
  base: fc.oneof(itineraryState(), endMixState().map(mix => mix.state)),
  gather: often,
  invert: often,
  arrival: fc.oneof(
    { weight: 2, arbitrary: fc.constant('equal') }, { weight: 2, arbitrary: fc.constant('before') },
    { weight: 1, arbitrary: fc.constant('clear') }
  ),
  pick: fc.nat(),
  items: fc.constantFrom('keep', 'blank', 'done')
});
/**
 * base 的副本，在路線最多、且有 Day_Location 的一天（都沒有 Day_Location 時為路線最多的一天）：
 * - gather：起點不是 Day_Location 的路線，終點都改成 Day_Location（成為 Arrival_Routes）。
 * - invert：這一天有出發時間的 Arrival_Routes 依車輛順序由晚到早重新分配原本的出發時間。
 * - arrival：'equal' 時 Arrival_Time 為其中一條的出發時間，'before' 時為 00:00，'clear' 時移除 Arrival_Time。
 * - items：'blank' 時每個採買品項的名稱改成空白，'done' 時每個採買品項都改成已買齊。
 * 這些修改都在驗證規則之內；屬性仍以 isValidState() 篩選。
 */
function aimedState({ base, gather, invert, arrival, pick, items }) {
  const state = structuredClone(base);
  const days = tripDays(state).map(({ date }) => ({ date, ...dayFacts(state, date) }));
  if (!days.length) return state; // 日期無效的 Trip_State 由屬性的 isValidState() 篩掉
  const rank = day => (day.location !== null ? 1000 : 0) + day.dayRoutes.length;
  const day = days.reduce((best, next) => (rank(next) > rank(best) ? next : best));
  if (gather && day.location !== null) {
    for (const { route } of day.dayRoutes) if (route.from !== day.location) route.to = day.location;
  }
  const timed = day.dayRoutes.filter(day.arriving).map(entry => entry.route).filter(route => timeOf(route.time));
  if (invert) {
    const times = timed.map(route => route.time).sort().reverse();
    timed.forEach((route, i) => { route.time = times[i]; });
  }
  state.daySettings ??= [];
  let setting = state.daySettings.find(item => item.date === day.date);
  if (arrival === 'clear') {
    if (setting) delete setting.arrival;
  } else {
    if (!setting) state.daySettings.push(setting = { date: day.date });
    setting.arrival = arrival === 'equal' && timed.length ? timed[pick % timed.length].time : '00:00';
  }
  for (const item of state.shopping) {
    if (items === 'blank') item.name = pick % 2 ? '' : ' ';
    if (items === 'done') item.done = true;
  }
  return state;
}
const anyState = fc.oneof(
  { weight: 3, arbitrary: itineraryState() },
  { weight: 1, arbitrary: itineraryState({ markup: true }) },
  { weight: 2, arbitrary: endMixState().map(mix => mix.state) },
  { weight: 4, arbitrary: aimPlan.map(aimedState) },
  { weight: 1, arbitrary: legacyState() }
);

// ---- 屬性 ----
/** shoppingPlan() 的內容（Map 換成項目陣列），用來確認 planningWarnings() 沒有修改 plan。 */
const planEntries = plan => ({
  buyerCar: [...plan.buyerCar], firstStop: [...plan.firstStop], stopItems: [...plan.stopItems],
  unassigned: [...plan.unassigned], locationOf: [...plan.locationOf]
});

/** 檢查一組 Trip_State，回傳它涵蓋的情況。 */
function checkWarnings(state) {
  const snapshot = structuredClone(state);
  const plan = shoppingPlan(state);
  const planSnapshot = structuredClone(planEntries(plan));
  const actual = planningWarnings(state, plan);
  // 只讀取輸入：Trip_State 與 plan 都不變
  expect(state).toStrictEqual(snapshot);
  expect(planEntries(plan)).toStrictEqual(planSnapshot);

  // 依 Trip_Day 的順序每天恰好一項，每天的清單與參考實作的文字與順序都相同
  const expected = referenceWarnings(state);
  expect(actual).toBeInstanceOf(Map);
  const entries = [...actual];
  expect(entries).toStrictEqual(expected.map(({ date, warnings }) => [date, warnings.map(warning => warning.text)]));

  for (const { date } of expected) {
    const { dayRoutes, arrival, arriving } = dayFacts(state, date);
    // 沒有任何路線的日子沒有提醒，所以也沒有「這一天還沒有路線」
    if (!dayRoutes.length) expect(actual.get(date)).toEqual([]);
    // 出發時間等於 Arrival_Time 的 Arrival_Route 不產生「晚於預計抵達」
    for (const { vehicle, route } of dayRoutes.filter(arriving)) {
      if (arrival && route.time === arrival) {
        expect(actual.get(date)).not.toContain(`${cleanText(vehicle.name)} ${arrival} 出發，晚於預計抵達 ${arrival}`);
      }
    }
  }

  // 省略 plan，或傳入 JSON 往返後的 Trip_State，都得到相同的結果
  expect([...planningWarnings(state)]).toStrictEqual(entries);
  expect([...planningWarnings(JSON.parse(JSON.stringify(state)))]).toStrictEqual(entries);
  expect(state).toStrictEqual(snapshot);
  return coverage(state, expected);
}

// ---- 涵蓋範圍 ----
const CLAUSES = ['9.1', '9.2', '9.3', '9.4', '9.5 沒有品項', '9.5 只標示採買'];
const COVERAGE = [
  ...CLAUSES,
  '沒有路線的日子（有車）',
  '9.1 只有舊出發資料的車',
  '9.2 出發時間等於 Arrival_Time 的 Arrival_Route',
  '9.2 出發時間早於 Arrival_Time 的 Arrival_Route',
  '9.2 有 Arrival_Time 時沒有出發時間的 Arrival_Route',
  '9.2 出發時間晚於 Arrival_Time 的 Other_Route',
  '9.2 有 Arrival_Time 但沒有 Day_Location 的日子有晚於它的路線',
  '9.2 兩則以上，車輛順序與出發時間的順序不同',
  '9.3 兩條以上的 Arrival_Routes',
  'Day_Location 是 Place 的 Arrival_Routes',
  'Day_Location 是旅行目的地的 Arrival_Routes',
  '起點與終點都是 Day_Location 的路線',
  '9.4 沒有出發時間的 Arrival_Route',
  '9.4 沒有出發時間的 Other_Route',
  '9.4 第 1 天沒有出發時間的舊出發資料',
  '9.5 只標示採買：First_Shopping_Stop 在同一天',
  '9.5 只標示採買：First_Shopping_Stop 在其他日子',
  '9.5 兩種提醒交錯：只標示採買在沒有品項之前',
  '9.5 兩則以上，車輛順序與出發時間的順序不同',
  '9.5 有 Stop_Items 的 First_Shopping_Stop',
  '9.5 Stop_Items 都已買齊',
  '9.5 Stop_Items 的名稱都是空白',
  'D30 Buyer_Car 沒有採買停靠點的品項',
  '一天有四條條文的提醒'
];
/** 需求 5.2 的出發順序：有出發時間的依時間，沒有出發時間的排最後。 */
const departureRank = route => (timeOf(route.time) ? minutes(route.time) : 24 * 60);
/** 依清單順序，前一項的出發順序晚於後一項（因此依出發時間排列會得到不同的順序）。 */
const outOfDepartureOrder = warnings => warnings.some((warning, i) => i > 0
  && warnings[i - 1].route !== warning.route && departureRank(warnings[i - 1].route) > departureRank(warning.route));

/** state 涵蓋的情況（COVERAGE 的項目），由參考實作的結果與每一天的資料判斷。 */
function coverage(state, expected) {
  const tags = new Set();
  const has = (tag, condition) => { if (condition) tags.add(tag); };
  const { shoppingStops, buyerCar, firstShoppingStop, stopItems } = shoppingFacts(state);
  const legacy = legacyDepartures(state);
  has('9.4 第 1 天沒有出發時間的舊出發資料', legacy.some(entry => !entry.time));
  has('D30 Buyer_Car 沒有採買停靠點的品項', state.shopping.some(item => {
    const car = item.assignee === '' ? undefined : buyerCar(item.assignee);
    return car !== undefined && !firstShoppingStop(car);
  }));

  for (const { date, n, warnings } of expected) {
    const { dayRoutes, location, arrival, arriving } = dayFacts(state, date);
    const clauses = warnings.map(warning => warning.clause);
    for (const clause of clauses) tags.add(clause);
    const late = route => timeOf(route.time) && minutes(route.time) > minutes(arrival);
    const arrivalRoutes = dayRoutes.filter(arriving).map(entry => entry.route);
    const otherRoutes = dayRoutes.filter(entry => !arriving(entry)).map(entry => entry.route);

    has('沒有路線的日子（有車）', !dayRoutes.length && state.vehicles.length > 0);
    has('9.1 只有舊出發資料的車', n === 1 && warnings.some(warning => warning.clause === '9.1' && legacy.some(entry => entry.vehicle === warning.vehicle)));
    if (arrival) {
      has('9.2 出發時間等於 Arrival_Time 的 Arrival_Route', arrivalRoutes.some(route => route.time === arrival));
      has('9.2 出發時間早於 Arrival_Time 的 Arrival_Route', arrivalRoutes.some(route => timeOf(route.time) && minutes(route.time) < minutes(arrival)));
      has('9.2 有 Arrival_Time 時沒有出發時間的 Arrival_Route', arrivalRoutes.some(route => !timeOf(route.time)));
      has('9.2 出發時間晚於 Arrival_Time 的 Other_Route', location !== null && otherRoutes.some(late));
      has('9.2 有 Arrival_Time 但沒有 Day_Location 的日子有晚於它的路線', location === null && otherRoutes.some(late));
    }
    has('9.2 兩則以上，車輛順序與出發時間的順序不同', outOfDepartureOrder(warnings.filter(warning => warning.clause === '9.2')));
    has('9.3 兩條以上的 Arrival_Routes', clauses.includes('9.3') && arrivalRoutes.length >= 2);
    has('Day_Location 是 Place 的 Arrival_Routes', location !== null && location !== DESTINATION_REF && arrivalRoutes.length > 0);
    has('Day_Location 是旅行目的地的 Arrival_Routes', location === DESTINATION_REF && arrivalRoutes.length > 0);
    has('起點與終點都是 Day_Location 的路線', location !== null && otherRoutes.some(route => route.from === location && route.to === location));
    has('9.4 沒有出發時間的 Arrival_Route', arrivalRoutes.some(route => !timeOf(route.time)));
    has('9.4 沒有出發時間的 Other_Route', otherRoutes.some(route => !timeOf(route.time)));

    const shopping = warnings.filter(warning => warning.clause.startsWith('9.5'));
    for (const warning of shopping.filter(item => item.clause === '9.5 只標示採買')) {
      const first = firstShoppingStop(warning.vehicle);
      has(first.n === n ? '9.5 只標示採買：First_Shopping_Stop 在同一天' : '9.5 只標示採買：First_Shopping_Stop 在其他日子', true);
    }
    has('9.5 兩種提醒交錯：只標示採買在沒有品項之前', shopping.some((warning, i) => warning.clause === '9.5 只標示採買'
      && shopping.slice(i + 1).some(next => next.clause === '9.5 沒有品項')));
    has('9.5 兩則以上，車輛順序與出發時間的順序不同', outOfDepartureOrder(shopping));
    for (const { vehicle, route } of dayRoutes) {
      const first = firstShoppingStop(vehicle);
      if (!first || !shoppingStops(route).includes(first.stop)) continue;
      const items = stopItems(vehicle);
      if (!items.length) continue;
      has('9.5 有 Stop_Items 的 First_Shopping_Stop', true);
      has('9.5 Stop_Items 都已買齊', items.every(item => item.done));
      has('9.5 Stop_Items 的名稱都是空白', items.every(item => cleanText(item.name) === ''));
    }
    has('一天有四條條文的提醒', new Set(clauses.map(clause => clause.slice(0, 3))).size >= 4);
  }
  return tags;
}

describe('Property 12: 規劃提醒依規則產生', () => {
  test('參考實作重現需求 9 的範例與條文的順序', () => {
    const [DAY_1, DAY_2, DAY_3] = ['2026-10-20', '2026-10-21', '2026-10-22'];
    const byDay = (day1 = [], day2 = [], day3 = []) => [[DAY_1, day1], [DAY_2, day2], [DAY_3, day3]];
    const routeOf = (state, id) => state.routes.find(route => route.id === id);
    const variant = change => {
      const state = exampleTrip();
      change(state);
      expect(isValidState(state)).toBe(true);
      return state;
    };

    // Example_Trip：每天都沒有 Planning_Warning
    expect(referenceTexts(variant(() => {}))).toStrictEqual(byDay());
    // 需求 9.1：刪除第 1 天第四車的 Route
    expect(referenceTexts(variant(state => { state.routes = state.routes.filter(route => route.id !== 'rt-1-v4'); })))
      .toStrictEqual(byDay(['第四車這一天還沒有路線']));
    // 需求 9.2：第 1 天的第四車 12:30 出發（預計 12:00 抵達）；兩則時依車輛順序，不依出發時間
    expect(referenceTexts(variant(state => { routeOf(state, 'rt-1-v4').time = '12:30'; })))
      .toStrictEqual(byDay(['第四車 12:30 出發，晚於預計抵達 12:00']));
    expect(referenceTexts(variant(state => { routeOf(state, 'rt-1-v1').time = '12:40'; routeOf(state, 'rt-1-v2').time = '12:10'; })))
      .toStrictEqual(byDay(['第一車 12:40 出發，晚於預計抵達 12:00', '第二車 12:10 出發，晚於預計抵達 12:00']));
    // 需求 9.3：第 1 天的四條 Arrival_Routes 沒有 Arrival_Time，只有一則
    expect(referenceTexts(variant(state => { delete state.daySettings[0].arrival; })))
      .toStrictEqual(byDay(['還沒填預計抵達時間']));
    // 需求 9.5：八個品項的「誰負責買」都改成第一車的駕駛小安（第一車沒有採買停靠點，不產生提醒，D30）
    expect(referenceTexts(variant(state => {
      for (const item of state.shopping) if (item.source === 'manual') item.assignee = 'p1';
    }))).toStrictEqual(byDay(['第三車・採買組在超市／賣場的採買沒有品項']));
    // 需求 9.5：第 3 天第三車・採買組的 Route 加上超市／賣場的採買 Stop
    expect(referenceTexts(variant(state => { routeOf(state, 'rt-3-v3').stops.push({ id: 'st-3-v3', place: 'pl-shop', kind: 'shop' }); })))
      .toStrictEqual(byDay([], [], ['第三車・採買組在超市／賣場只標示採買，品項列在第 1 天的超市／賣場']));
    // 需求 9.6：第 3 天第三車・採買組與第四車的 Route 各加上超市／賣場的採買 Stop
    expect(referenceTexts(variant(state => {
      routeOf(state, 'rt-3-v3').stops.push({ id: 'st-3-v3', place: 'pl-shop', kind: 'shop' });
      routeOf(state, 'rt-3-v4').stops.push({ id: 'st-3-v4', place: 'pl-shop', kind: 'shop' });
    }))).toStrictEqual(byDay([], [], ['第三車・採買組在超市／賣場只標示採買，品項列在第 1 天的超市／賣場', '第四車在超市／賣場的採買沒有品項']));
    // 條文順序：同一天的 9.1、9.2、9.4、9.5 依序排列
    expect(referenceTexts(variant(state => {
      state.routes = state.routes.filter(route => route.id !== 'rt-1-v4');
      routeOf(state, 'rt-1-v1').time = '12:30';
      routeOf(state, 'rt-1-v2').time = '';
      routeOf(state, 'rt-1-v3').stops.push({ id: 'st-1-a', place: 'pl-a', kind: 'shop' });
    }))).toStrictEqual(byDay([
      '第四車這一天還沒有路線', '第一車 12:30 出發，晚於預計抵達 12:00', '第二車的出發時間待定',
      '第三車・採買組在出發地點 A只標示採買，品項列在第 1 天的超市／賣場'
    ]));
  });

  test('每一天的提醒與參考實作的文字與順序相同，且不修改輸入', () => {
    const seen = new Set();
    fc.assert(fc.property(anyState, state => {
      fc.pre(isValidState(state));
      for (const tag of checkWarnings(state)) seen.add(tag);
    }), BOUNDED);
    // 每一條條文（需求 9.5 的兩種提醒分開計算）與 COVERAGE 列出的情況都至少出現一次
    expect(COVERAGE.filter(tag => !seen.has(tag))).toEqual([]);
  }, TIMEOUT);
});
