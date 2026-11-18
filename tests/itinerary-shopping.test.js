// Feature: trip-planning-workflow-enhance, Property 9: 採買推導的分割與摘要
// **Validates: Requirements 6.9, 6.10, 6.11, 6.12, 23.14**
//
// 從產生的 Trip_State 開始，依序套用 1 到 10 個本檔 shoppingOp() 產生的操作（需求 23.14）。起始狀態與每個被接受的操作
// 之後都檢查（被拒絕或沒有對象的操作不改變 Trip_State，所以不必重新檢查）：
// - State_Validator 接受該 Trip_State。
// - shoppingPlan(state) 的 buyerCar、firstStop、stopItems、unassigned（code 與 reason）與 locationOf 等於本檔 expectedPlan()
//   依詞彙表、需求 6.11 的 (a) 至 (d)、D28、D29 與 D30 獨立算出的結果：Car_Members 是不是待分配的駕駛與全部乘客；
//   Buyer_Car 是依 state.vehicles 的順序第一台 Car_Members 包含該旅伴的車（D29）；First_Shopping_Stop 是該車有
//   Shopping_Stop 的路線中 Trip_Day 最早的一條、其中 Stop 順序最前面的 Shopping_Stop（D28）；品項依序判斷 (a) 待分配
//   「待分配」、(b) 沒有 Buyer_Car「{旅伴}不在任何車上」、(c) Buyer_Car 沒有 First_Shopping_Stop「{車名}還沒有採買停靠點」
//   （D30），其他品項 (d) 列在 Buyer_Car 的 First_Shopping_Stop。Stop_Items 與 Unassigned_Shopping 都依採買清單的順序、
//   含已買齊的品項；stopItems 恰對每個 First_Shopping_Stop 有一項（可以是空的），其他 Shopping_Stop 都沒有（D28）；
//   locationOf 恰為 Stop_Items 中的品項，第 N 天、地點名稱與車名屬於該品項的 First_Shopping_Stop（需求 6.10）。
//   原因與位置中的名稱是儲存的值，改名後就是新的名稱（需求 6.12）；firstStop 的路線與 Stop 是儲存的資料本身。
// - 分割：每個採買品項恰好出現一次，在一個 First_Shopping_Stop 的 Stop_Items 或 Unassigned_Shopping 中；推導中的品項恰為
//   採買清單的品項且內容不變（推導不新增、移除或改變品項，需求 6.12）。
// - Shopping_Summary：每個 Shopping_Stop 的 shoppingSummary() 等於本檔 summaryOf() 依需求 6.9 由參考的 Stop_Items 產生的
//   文字（名稱依需求 14.16 處理，處理後相同的名稱只列第一個，空字串不列出，以「、」連接；不是 First_Shopping_Stop 時為
//   空字串）。行程圖與文字版使用的 dayModel() 中，每個途中任務的品項與 Shopping_Summary 也相同（其他任務類型沒有品項）。
// - 同一個 Trip_State 與它的 JSON 深拷貝各推導兩次，四次的結果（含順序）都相同；推導之後 Trip_State 不變。
//
// shoppingOp() 的操作使用規劃行程、採買清單分頁、Vehicle_Dialog 與料理菜單儲存時的同一組函式：
//   assign        改品項的「誰負責買」：assignShopping()（採買清單分頁）；改給車上的旅伴、兩台以上車輛的旅伴、待分配、
//                 不在車上的旅伴或任何人
//   vehicle       改車輛的駕駛、乘客或車名：saveVehicle()（Vehicle_Dialog）；add-vehicle 以 saveVehicle() 新增車輛
//   add-stop      在路線的任意位置新增途中任務，多半是採買（「新增途中任務」再上移）；remove-stop 移除途中任務（優先移除
//                 Shopping_Stop）；retype-stop 把 Shopping_Stop 改成接送、取還裝備或其他，或把其他任務改成採買；
//                 move-stop 以上移、下移把途中任務移到另一個位置（有時把 First_Shopping_Stop 移到同一條路線的第二個
//                 Shopping_Stop 之後）；new-route 為當天沒有路線的車新增路線（0 到 3 個途中任務）；recar 把路線改給當天
//                 沒有路線的另一台車。都以 routeDraft() 或 newRouteDraft() 建立 Draft，再以 saveRoute() 儲存。
//   delete-route  刪除路線：deleteRoute()
//   delete-item   刪除採買品項：與採買清單分頁的確認移除相同，移除後以 syncMealIngredients() 同步料理食材；分頁不能刪除連動
//                 料理的品項（mealIds 不是空的），所以只刪除其他品項
//   save-meal     新增或修改料理：saveMeal()（內含 syncMealIngredients()）；delete-meal 與料理菜單的確認移除相同，移除後
//                 同步料理食材；sync 只執行 syncMealIngredients()（本機版載入時與伺服器的同步）
// 操作只含選擇用的數字與選項，套用時才依當下的 Trip_State 解析成品項、車輛、路線或途中任務（數字對清單長度取餘數），
// 所以任何操作都能套用在任何 Trip_State 上，縮小後的反例也容易閱讀。拒絕時維持原本的 Trip_State；只接受預期的拒絕：
// 路線的起點與終點相同且沒有途中任務（需求 5.9；產生器的路線可以如此，移除最後一個途中任務或換車重新儲存時被拒絕），
// 以及保留前後有空白的舊餐次（例如「\u3000早」）時料理表單的餐次檢查。其他拒絕都算失敗，直接操作（改負責人、刪除品項
// 或料理、同步）的結果也必須通過驗證。
//
// 起始狀態來自 itineraryState()（需求 23.3 的值域；駕駛可以是待分配、同一位旅伴可在多台車、Stop 隨機為四種任務類型，
// 所以常有沒有 Shopping_Stop 的車，以及同一天或不同天有多個 Shopping_Stop 的車）、endMixState()（同一天有 1 到 12 條
// 路線，路線的操作因此常有對象）與本功能之前的 legacyState()。本檔的 prepareStart() 另以 assignShopping() 把 0 到 4 個
// 品項改給 Buyer_Car 有 First_Shopping_Stop 的旅伴，並把 0 到 6 個品項的名稱改成 ITEM_NAMES 的寫法（前後與中間的空白、
// 換行、空白名稱與處理後相同的名稱），讓 Stop_Items 常有多個品項，需求 6.9 與 14.16 的每一條規則也常出現在同一個
// Shopping_Summary 中。最後確認需求 23.14 列出的產生器特徵在起始狀態中出現，需求 6.11 的四種結果與 COVERAGE 的情況
// 至少出現一次，每一種操作都被接受過 MIN_APPLIED 次以上並改變過推導的結果；實測時每一種情況在 200 組中都出現 20 次
// 以上，所以幾乎必然出現。另一個測試先以需求 6.9 至 6.11 的範例與 Example_Trip 的修改確認參考實作本身。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { syncMealIngredients } from '../src/ingredients.js';
import { dayModel, shoppingPlan, shoppingSummary } from '../src/itinerary-derive.js';
import {
  EDIT_MESSAGES, deleteRoute, newRouteDraft, routeDraft, saveMeal, saveRoute, saveVehicle
} from '../src/itinerary-edits.js';
import { DESTINATION_REF } from '../src/itinerary-model.js';
import { MEAL_SLOTS } from '../src/meal-order.js';
import { assignShopping, dateRange, isValidState } from '../src/model.js';
import { exampleTrip } from './fixtures/example-trip.js';
import { endMixState, itineraryState, legacyState } from './support/itinerary-arb.js';

// 200 組通常 3 到 4 秒。fc.gen() 產生的 Trip_State 很大，屬性失敗時縮小可能要好幾分鐘，而 bun test 無法中斷同步執行的
// 測試，所以 30 秒後停止縮小並回報目前的反例；尚未跑完 200 組就到時間也算失敗（failOnInterrupt）。bun test 不顯示錯誤的
// cause，所以把失敗的位置（起始狀態或第幾個操作與它的內容）與不符合的檢查放進回報的訊息（includeErrorInReport）。
const BOUNDED = {
  numRuns: 200, includeErrorInReport: true, plugins: [fc.interruptAfterTimeLimit(30_000, { failOnInterrupt: true })]
};
const TIMEOUT = 60_000;

// ---- 需求 6.9、6.11、14.16 與詞彙表的規則（本檔獨立撰寫） ----
// 需求 14.16 的換行字元：CR、LF、U+000B、U+000C、U+0085、U+2028 與 U+2029。
const BREAK = /[\r\n\u000B\u000C\u0085\u2028\u2029]/u;
/** 去除前後的 Unicode White_Space（含全形空白、換行與 Tab）。 */
const trimmed = text => String(text ?? '').replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
/** 需求 14.16：去除前後空白，每一段含換行字元的連續空白換成一個半形空白，其他字元原樣（不跳脫、不截斷）。 */
const clean = text => trimmed(text).replace(/\p{White_Space}+/gu, run => (BREAK.test(run) ? ' ' : run));
/** 需求 6.9：依順序以「、」連接處理後的品項名稱；處理後完全相同的名稱只列第一個，空字串不列出。 */
function summaryOf(items) {
  const names = [];
  for (const item of items) {
    const name = clean(item.name);
    if (name !== '' && !names.includes(name)) names.push(name);
  }
  return names.join('、');
}
/** Car_Members：駕駛（不是待分配時）與全部乘客。 */
const carMembers = vehicle => [...(vehicle.driver === '' ? [] : [vehicle.driver]), ...vehicle.passengers];
/** 路線中任務類型為採買的 Stop，依 Stop 的順序。 */
const shopStopsOf = route => (route.stops ?? []).filter(stop => stop.kind === 'shop');

/**
 * 依詞彙表與需求 6.11 由 Trip_State 算出的採買推導（形狀與 shoppingPlan() 相同）：
 * - buyerCar：旅伴識別碼 → Buyer_Car 的識別碼，只有是某台車 Car_Members 的旅伴才有項目。
 * - firstStop：車輛識別碼 → First_Shopping_Stop { route, stop, n }，n 是那一天的第 N 天；沒有 Shopping_Stop 的車沒有項目。
 * - stopItems：First_Shopping_Stop 的識別碼 → Stop_Items。
 * - unassigned：Unassigned_Shopping 的 { item, code, reason }。
 * - locationOf：Stop_Items 中的品項識別碼 → { n, placeName, vehicleName }。
 */
function expectedPlan(state) {
  const dates = dateRange(state.trip.startDate, state.trip.endDate);
  const dayOf = date => dates.indexOf(date) + 1;
  const routes = state.routes ?? [], places = state.places ?? [];
  const buyerOf = person => state.vehicles.find(vehicle => carMembers(vehicle).includes(person));
  const firstStop = new Map();
  for (const vehicle of state.vehicles) {
    const shopping = routes.filter(route => route.vehicleId === vehicle.id && shopStopsOf(route).length > 0);
    if (!shopping.length) continue;
    const route = shopping.reduce((best, next) => (dayOf(next.date) < dayOf(best.date) ? next : best));
    firstStop.set(vehicle.id, { route, stop: shopStopsOf(route)[0], n: dayOf(route.date) });
  }
  const placeName = ref => (ref === DESTINATION_REF ? state.trip.destination : places.find(place => place.id === ref).name);
  const personName = id => state.people.find(person => person.id === id).name;
  const stopItems = new Map([...firstStop.values()].map(({ stop }) => [stop.id, []]));
  const unassigned = [], locationOf = new Map();
  for (const item of state.shopping) {
    if (item.assignee === '') {
      unassigned.push({ item, code: 'unassigned', reason: '待分配' });
      continue;
    }
    const car = buyerOf(item.assignee);
    if (!car) {
      unassigned.push({ item, code: 'no-car', reason: `${personName(item.assignee)}不在任何車上` });
      continue;
    }
    const first = firstStop.get(car.id);
    if (!first) {
      unassigned.push({ item, code: 'no-stop', reason: `${car.name}還沒有採買停靠點` });
      continue;
    }
    stopItems.get(first.stop.id).push(item);
    locationOf.set(item.id, { n: first.n, placeName: placeName(first.stop.place), vehicleName: car.name });
  }
  const buyerCar = new Map();
  for (const person of state.people) {
    const car = buyerOf(person.id);
    if (car) buyerCar.set(person.id, car.id);
  }
  return { buyerCar, firstStop, stopItems, unassigned, locationOf };
}

// ---- 檢查 ----
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortRows = rows => [...rows].sort((a, b) => compareText(a[0], b[0]));
const sortById = items => [...items].sort((a, b) => compareText(a.id, b.id));
/** 推導結果以識別碼、代碼、原因、第 N 天與名稱表示（Map 換成項目陣列，順序不變）。 */
const rawView = plan => ({
  buyerCar: [...plan.buyerCar],
  firstStop: [...plan.firstStop].map(([id, { route, stop, n }]) => [id, route.id, stop.id, n]),
  stopItems: [...plan.stopItems].map(([id, items]) => [id, items.map(item => item.id)]),
  unassigned: plan.unassigned.map(({ item, code, reason }) => [item.id, code, reason]),
  locationOf: [...plan.locationOf].map(([id, { n, placeName, vehicleName }]) => [id, n, placeName, vehicleName])
});
/** rawView() 中順序沒有規定的 Map（buyerCar、firstStop、stopItems、locationOf）依鍵排序；unassigned 依採買清單的順序。 */
const sortedView = plan => {
  const view = rawView(plan);
  return {
    buyerCar: sortRows(view.buyerCar), firstStop: sortRows(view.firstStop), stopItems: sortRows(view.stopItems),
    unassigned: view.unassigned, locationOf: sortRows(view.locationOf)
  };
};
/** dayModel() 路線區塊中每個途中任務的顯示資料，以 Stop 的識別碼為鍵。 */
function stopViews(model) {
  const views = new Map();
  for (const block of model?.blocks ?? []) {
    if (block.type !== 'routes') continue;
    for (const line of block.lines) if (line.type === 'route') for (const view of line.stops) views.set(view.stop.id, view);
  }
  return views;
}

/**
 * 檢查一個 Trip_State（where 說明它是起始狀態或第幾個操作之後），回傳 { tags, view }：tags 是它涵蓋的 COVERAGE 情況，
 * view 是推導結果的文字（判斷操作是否改變了推導）。
 */
function checkState(state, where) {
  try {
    return checkPlan(state);
  } catch (error) {
    throw new Error(`${where}：${error instanceof Error ? error.message : String(error)}`);
  }
}

function checkPlan(state) {
  // 需求 23.14：State_Validator 接受這個 Trip_State
  expect(isValidState(state)).toBe(true);
  const snapshot = structuredClone(state);
  const plan = shoppingPlan(state);
  const want = expectedPlan(state);

  // Buyer_Car、First_Shopping_Stop、Stop_Items、Unassigned_Shopping 與原因、採買位置都等於參考實作
  expect(sortedView(plan)).toEqual(sortedView(want));
  // First_Shopping_Stop 的路線與 Stop 是儲存的資料本身
  for (const [vehicleId, { route, stop }] of plan.firstStop) {
    expect([vehicleId, (state.routes ?? []).includes(route), (route.stops ?? []).includes(stop)]).toEqual([vehicleId, true, true]);
  }

  // 分割：每個品項恰好出現一次，在一個 Stop_Items 或 Unassigned_Shopping 中，且沒有採買清單以外的品項
  const placements = new Map(state.shopping.map(item => [item.id, []]));
  const extra = [];
  const put = (item, at) => (placements.has(item.id) ? placements.get(item.id).push(at) : extra.push([item.id, at]));
  for (const [stopId, items] of plan.stopItems) for (const item of items) put(item, `Stop_Items ${stopId}`);
  for (const { item } of plan.unassigned) put(item, 'Unassigned_Shopping');
  expect({ notOnce: [...placements].filter(([, at]) => at.length !== 1), extra }).toEqual({ notOnce: [], extra: [] });
  // 推導不新增、移除或改變品項（需求 6.12）：推導中的品項恰為採買清單的品項，內容相同
  const derived = [...[...plan.stopItems.values()].flat(), ...plan.unassigned.map(entry => entry.item)];
  expect(sortById(derived)).toStrictEqual(sortById(state.shopping));

  // Shopping_Summary（需求 6.9）：每個 Shopping_Stop 都依參考的 Stop_Items 產生，不是 First_Shopping_Stop 時為空字串
  const stops = (state.routes ?? []).flatMap(route => (route.stops ?? []).map(stop => ({ route, stop })));
  const shops = stops.filter(({ stop }) => stop.kind === 'shop');
  const itemsAt = stop => (stop.kind === 'shop' ? want.stopItems.get(stop.id) ?? [] : []);
  expect(shops.map(({ stop }) => [stop.id, shoppingSummary(plan.stopItems.get(stop.id) ?? [])]))
    .toEqual(shops.map(({ stop }) => [stop.id, summaryOf(itemsAt(stop))]));
  // 行程圖與文字版的 dayModel()：每個途中任務的品項與 Shopping_Summary 相同，其他任務類型沒有品項
  for (const date of new Set(shops.map(({ route }) => route.date))) {
    const views = stopViews(dayModel(state, date, plan));
    const today = stops.filter(({ route }) => route.date === date);
    const shown = today.map(({ stop }) => {
      const view = views.get(stop.id);
      return [stop.id, view ? view.items.map(item => item.id) : '（沒有這個途中任務）', view?.summary];
    });
    expect({ date, stops: shown }).toEqual({ date, stops: today.map(({ stop }) => [stop.id, itemsAt(stop).map(item => item.id), summaryOf(itemsAt(stop))]) });
  }

  // 同一個 Trip_State 與它的 JSON 深拷貝各推導兩次，四次的結果（含順序）都相同
  const copy = JSON.parse(JSON.stringify(state));
  const views = [plan, shoppingPlan(state), shoppingPlan(copy), shoppingPlan(copy)].map(rawView);
  expect(views.slice(1)).toStrictEqual([views[0], views[0], views[0]]);
  // 推導不修改 Trip_State
  expect(state).toStrictEqual(snapshot);
  return { tags: coverage(state, want), view: JSON.stringify(views[0]) };
}

// ---- 涵蓋範圍 ----
const REASON_TAGS = Object.freeze({
  unassigned: '(a) 待分配', 'no-car': '(b) 不在任何車上', 'no-stop': '(c) Buyer_Car 沒有採買停靠點'
});
// 需求 23.14 列出的產生器特徵：每一項都要在起始狀態中出現
const GENERATOR_FEATURES = [
  '同一位旅伴是兩台以上車輛的駕駛或乘客', '駕駛為待分配的車', '沒有 Shopping_Stop 的車',
  '同一天有多個 Shopping_Stop 的車', '不同天有 Shopping_Stop 的車'
];
const COVERAGE = [
  ...Object.values(REASON_TAGS), '(d) Buyer_Car 的 First_Shopping_Stop',
  '沒有品項的 First_Shopping_Stop', 'Stop_Items 有兩個以上的品項', 'Stop_Items 含已買齊的品項',
  'D28 同一條路線後面的 Shopping_Stop 沒有品項', 'D28 其他天的 Shopping_Stop 沒有品項',
  'First_Shopping_Stop 不在第 1 天', 'First_Shopping_Stop 前面有其他途中任務', 'First_Shopping_Stop 在旅行目的地',
  'D29 負責人是兩台以上車輛的駕駛或乘客', 'D29 負責人的另一台車有 First_Shopping_Stop',
  'Shopping_Summary 略過處理後為空字串的名稱', 'Shopping_Summary 只列一次處理後相同的名稱',
  'Shopping_Summary 把含換行的連續空白換成一個空白', 'Shopping_Summary 保留不含換行的連續空白'
];

/** 需求 23.14 列出的產生器特徵（GENERATOR_FEATURES 的項目）中 state 具有的項目。 */
function generatorFeatures(state) {
  const routes = state.routes ?? [];
  const carsOf = person => state.vehicles.filter(vehicle => carMembers(vehicle).includes(person));
  const shopRoutes = vehicle => routes.filter(route => route.vehicleId === vehicle.id && shopStopsOf(route).length > 0);
  const features = new Set();
  const has = (feature, condition) => { if (condition) features.add(feature); };
  has(GENERATOR_FEATURES[0], state.people.some(person => carsOf(person.id).length >= 2));
  has(GENERATOR_FEATURES[1], state.vehicles.some(vehicle => vehicle.driver === ''));
  has(GENERATOR_FEATURES[2], state.vehicles.some(vehicle => shopRoutes(vehicle).length === 0));
  // 每台車每天最多一條路線，所以同一天有多個 Shopping_Stop 就是同一條路線有多個
  has(GENERATOR_FEATURES[3], routes.some(route => shopStopsOf(route).length >= 2));
  has(GENERATOR_FEATURES[4], state.vehicles.some(vehicle => shopRoutes(vehicle).length >= 2));
  return features;
}

/** state 涵蓋的 COVERAGE 情況，由參考實作的結果判斷。 */
function coverage(state, want) {
  const tags = new Set();
  const has = (tag, condition) => { if (condition) tags.add(tag); };
  const routes = state.routes ?? [];
  const carsOf = person => state.vehicles.filter(vehicle => carMembers(vehicle).includes(person));
  for (const { code } of want.unassigned) tags.add(REASON_TAGS[code]);
  has('(d) Buyer_Car 的 First_Shopping_Stop', want.locationOf.size > 0);
  for (const [vehicleId, { route, stop, n }] of want.firstStop) {
    const items = want.stopItems.get(stop.id);
    has('沒有品項的 First_Shopping_Stop', items.length === 0);
    if (!items.length) continue;
    has('Stop_Items 有兩個以上的品項', items.length >= 2);
    has('Stop_Items 含已買齊的品項', items.some(item => item.done));
    has('D28 同一條路線後面的 Shopping_Stop 沒有品項', shopStopsOf(route).length >= 2);
    has('D28 其他天的 Shopping_Stop 沒有品項', routes.some(other => other !== route && other.vehicleId === vehicleId && shopStopsOf(other).length > 0));
    has('First_Shopping_Stop 不在第 1 天', n > 1);
    has('First_Shopping_Stop 前面有其他途中任務', route.stops[0] !== stop);
    has('First_Shopping_Stop 在旅行目的地', stop.place === DESTINATION_REF);
    const names = items.map(item => clean(item.name));
    has('Shopping_Summary 略過處理後為空字串的名稱', names.includes(''));
    has('Shopping_Summary 只列一次處理後相同的名稱', names.some((name, i) => name !== '' && names.indexOf(name) !== i));
    has('Shopping_Summary 把含換行的連續空白換成一個空白', items.some(item => BREAK.test(trimmed(item.name))));
    has('Shopping_Summary 保留不含換行的連續空白', names.some(name => /\p{White_Space}{2}/u.test(name)));
  }
  for (const item of state.shopping) {
    const cars = item.assignee === '' ? [] : carsOf(item.assignee);
    if (cars.length < 2) continue;
    has('D29 負責人是兩台以上車輛的駕駛或乘客', true);
    // cars[0] 是 Buyer_Car；後面的車有 First_Shopping_Stop 時，品項仍算在 Buyer_Car
    has('D29 負責人的另一台車有 First_Shopping_Stop', cars.slice(1).some(car => want.firstStop.has(car.id)));
  }
  return tags;
}

// ---- 操作（shoppingOp()） ----
const OTHER_KINDS = Object.freeze(['pickup', 'gear', 'other']);
const TIMES = Object.freeze(['', '07:30', '12:00', '23:59']);
// 料理食材：與產生器的採買品項名稱有相同的（牛肉片、高麗菜、冰塊、甜椒與玉米），也有新的名稱
const INGREDIENTS = Object.freeze(['培根', '炒蛋', '吐司', '咖啡', '牛肉片', '高麗菜', '冰塊', '甜椒', '玉米', '鮮蝦', ' 洋蔥 ', 'A&B', '<b>醬</b>', '牛肉片 2 盒']);
const pickArb = fc.nat();
const otherKindArb = fc.constantFrom(...OTHER_KINDS);
const stopKindArb = fc.oneof({ weight: 3, arbitrary: fc.constant('shop') }, { weight: 1, arbitrary: otherKindArb });
const opArb = (op, weight, fields = {}) => ({ weight, arbitrary: fc.record({ op: fc.constant(op), ...fields }) });
const OP_NAMES = Object.freeze([
  'assign', 'vehicle', 'add-vehicle', 'add-stop', 'remove-stop', 'retype-stop', 'move-stop', 'new-route', 'recar',
  'delete-route', 'delete-item', 'save-meal', 'delete-meal', 'sync'
]);

/**
 * 一個隨機操作：{ op, ... }，op 是 OP_NAMES 之一，其他欄位是選擇用的數字（套用時對清單長度取餘數）與選項。
 * @returns {fc.Arbitrary<object>}
 */
function shoppingOp() {
  return fc.oneof(
    opArb('assign', 4, { item: pickArb, to: fc.constantFrom('member', 'shared', 'unassigned', 'off-car', 'anyone'), pick: pickArb }),
    opArb('vehicle', 3, {
      car: pickArb, driver: fc.constantFrom('keep', 'unassigned', 'person'), passengers: fc.constantFrom('keep', 'add', 'remove', 'replace'),
      pick: pickArb, mask: pickArb, rename: fc.boolean()
    }),
    opArb('add-vehicle', 1, { driver: fc.constantFrom('unassigned', 'person'), pick: pickArb, mask: pickArb, seats: fc.integer({ min: 1, max: 9 }) }),
    opArb('add-stop', 3, { route: pickArb, at: pickArb, place: pickArb, kind: stopKindArb }),
    opArb('remove-stop', 2, { route: pickArb, stop: pickArb }),
    opArb('retype-stop', 2, { route: pickArb, stop: pickArb, away: fc.boolean(), kind: otherKindArb }),
    opArb('move-stop', 2, { route: pickArb, stop: pickArb, to: pickArb, shops: fc.boolean() }),
    opArb('new-route', 2, {
      slot: pickArb, from: pickArb, to: pickArb, keepEnd: fc.boolean(), time: fc.constantFrom(...TIMES),
      stops: fc.array(fc.record({ place: pickArb, kind: stopKindArb }), { maxLength: 3 })
    }),
    opArb('recar', 2, { route: pickArb, car: pickArb }),
    opArb('delete-route', 2, { route: pickArb, shop: fc.boolean() }),
    opArb('delete-item', 1, { item: pickArb }),
    opArb('save-meal', 2, {
      meal: fc.oneof({ weight: 1, arbitrary: fc.constant('new') }, { weight: 2, arbitrary: pickArb }),
      date: pickArb, moveDate: fc.boolean(), slot: fc.constantFrom('keep', ...MEAL_SLOTS),
      ingredients: fc.oneof({ weight: 1, arbitrary: fc.constant('keep') }, { weight: 3, arbitrary: fc.array(fc.constantFrom(...INGREDIENTS), { maxLength: 5 }) }),
      separator: fc.constantFrom('、', '，', '\n', '/')
    }),
    opArb('delete-meal', 1, { meal: pickArb }),
    opArb('sync', 1)
  );
}

const at = (list, index) => list[index % list.length];
/** 依 mask 的位元從 list 選出的項目（順序不變）。 */
const bits = (list, mask) => list.filter((_, i) => ((mask >>> (i % 31)) & 1) === 1);
const tripDates = state => dateRange(state.trip.startDate, state.trip.endDate);
/** 路線起點、終點與途中任務可以選的地點：每個 Place，以及旅行目的地不是空白時的 '@destination'。 */
const refsOf = state => [...(state.places ?? []).map(place => place.id), ...(trimmed(state.trip.destination) ? [DESTINATION_REF] : [])];
const pairKey = (date, vehicleId) => JSON.stringify([date, vehicleId]);
/** 旅伴識別碼 → 他是幾台車的 Car_Members。 */
function memberCounts(state) {
  const counts = new Map();
  for (const vehicle of state.vehicles) for (const id of carMembers(vehicle)) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

const applied = state => ({ status: 'applied', state });
const skipped = reason => ({ status: 'skipped', reason });
const rejected = reason => ({ status: 'rejected', reason });
/** 需求 5.9：起點與終點相同且沒有途中任務，是唯一的錯誤。 */
const sameEndsOnly = result => !result.formError && result.errors.length === 1
  && result.errors[0].field === 'to' && result.errors[0].message === EDIT_MESSAGES.sameEnds;
const never = () => false;
/** itinerary-edits.js 的結果：成功時採用新的 Trip_State；expected(result) 為 true 的拒絕維持原狀，其他拒絕都是失敗。 */
function fromEdit(result, expected) {
  if (result.ok) return applied(result.state);
  const reason = JSON.stringify({ errors: result.errors, formError: result.formError });
  if (expected(result)) return rejected(reason);
  throw new Error(`操作被拒絕：${reason}`);
}

/** 在 state 上套用 op，回傳 applied（新的 Trip_State）、rejected（預期的拒絕）或 skipped（沒有可以操作的對象）。 */
function applyOp(state, op, ctx) {
  const routes = state.routes ?? [];
  const people = state.people.map(person => person.id);
  switch (op.op) {
    case 'assign': {
      if (!state.shopping.length) return skipped('沒有採買品項');
      const item = at(state.shopping, op.item);
      const counts = memberCounts(state);
      const pools = {
        member: people.filter(id => counts.has(id)),
        shared: people.filter(id => (counts.get(id) ?? 0) >= 2),
        unassigned: [''],
        'off-car': people.filter(id => !counts.has(id)),
        anyone: ['', ...people]
      };
      let pool = pools[op.to].filter(id => id !== item.assignee);
      if (!pool.length) pool = pools.anyone.filter(id => id !== item.assignee);
      const person = at(pool, op.pick);
      const next = structuredClone(state);
      if (!assignShopping(next, item.id, person)) throw new Error(`assignShopping() 沒有把 ${item.id} 改給「${person}」`);
      return applied(next);
    }
    case 'vehicle': {
      if (!state.vehicles.length) return skipped('沒有車輛');
      const vehicle = at(state.vehicles, op.car);
      const driver = op.driver === 'keep' ? vehicle.driver : op.driver === 'unassigned' ? '' : at(people, op.pick);
      let passengers = vehicle.passengers.filter(id => id !== driver);
      const others = people.filter(id => id !== driver && !passengers.includes(id));
      if (op.passengers === 'add' && others.length) passengers = [...passengers, at(others, op.mask)];
      if (op.passengers === 'remove' && passengers.length) passengers = passengers.filter((_, i) => i !== op.mask % passengers.length);
      if (op.passengers === 'replace') passengers = bits(people.filter(id => id !== driver), op.mask);
      passengers = passengers.slice(0, 8);
      // 對話框中座位數不夠時，使用者先調高座位數（最多 9 個）
      const seats = Math.min(9, Math.max(vehicle.seats, passengers.length + 1));
      const name = op.rename ? `改名的車〔${ctx.uid()}〕` : vehicle.name;
      return fromEdit(saveVehicle(state, { id: vehicle.id, name, driver, seats, passengers }, ctx), never);
    }
    case 'add-vehicle': {
      const driver = op.driver === 'unassigned' ? '' : at(people, op.pick);
      const passengers = bits(people.filter(id => id !== driver), op.mask).slice(0, 8);
      const seats = Math.min(9, Math.max(op.seats, passengers.length + 1));
      return fromEdit(saveVehicle(state, { id: null, name: `新的車〔${ctx.uid()}〕`, driver, seats, passengers }, ctx), never);
    }
    case 'add-stop': {
      const refs = refsOf(state);
      const room = routes.filter(route => (route.stops ?? []).length < 6);
      if (!room.length || !refs.length) return skipped('沒有還能新增途中任務的路線');
      const draft = routeDraft(state, at(room, op.route).id);
      draft.stops.splice(op.at % (draft.stops.length + 1), 0, { stopId: null, key: 'added', place: at(refs, op.place), kind: op.kind, note: '' });
      return fromEdit(saveRoute(state, draft, ctx), never);
    }
    case 'remove-stop': {
      const withStops = routes.filter(route => (route.stops ?? []).length > 0);
      if (!withStops.length) return skipped('沒有途中任務');
      const shopping = withStops.filter(route => shopStopsOf(route).length > 0);
      const draft = routeDraft(state, at(shopping.length ? shopping : withStops, op.route).id);
      const shopIndexes = draft.stops.flatMap((stop, i) => (stop.kind === 'shop' ? [i] : []));
      draft.stops.splice(shopIndexes.length ? at(shopIndexes, op.stop) : op.stop % draft.stops.length, 1);
      return fromEdit(saveRoute(state, draft, ctx), sameEndsOnly);
    }
    case 'retype-stop': {
      // away：把 Shopping_Stop 改成其他任務類型；否則把其他任務改成採買。沒有這種途中任務時改任何一個。
      const withStops = routes.filter(route => (route.stops ?? []).length > 0);
      if (!withStops.length) return skipped('沒有途中任務');
      const wanted = withStops.filter(route => route.stops.some(stop => (stop.kind === 'shop') === op.away));
      const draft = routeDraft(state, at(wanted.length ? wanted : withStops, op.route).id);
      const choices = draft.stops.filter(stop => (stop.kind === 'shop') === op.away);
      const stop = at(choices.length ? choices : draft.stops, op.stop);
      stop.kind = stop.kind === 'shop' ? op.kind : 'shop';
      return fromEdit(saveRoute(state, draft, ctx), never);
    }
    case 'move-stop': {
      // 在同一張卡片中連按上移或下移，把一個途中任務移到另一個位置後才儲存。shops 時選某台車 First_Shopping_Stop 所在、
      // 有兩個以上 Shopping_Stop 的路線，把第一個 Shopping_Stop 移到第二個之後，所以這台車的 First_Shopping_Stop 改變。
      const movable = routes.filter(route => (route.stops ?? []).length >= 2);
      if (!movable.length) return skipped('沒有兩個以上途中任務的路線');
      const firstRoutes = new Set([...expectedPlan(state).firstStop.values()].map(entry => entry.route));
      const doubled = movable.filter(route => firstRoutes.has(route) && shopStopsOf(route).length >= 2);
      const shops = op.shops && doubled.length > 0;
      const draft = routeDraft(state, at(shops ? doubled : movable, op.route).id);
      const length = draft.stops.length;
      let from, to;
      if (shops) {
        // 移除第一個 Shopping_Stop 之後，第二個 Shopping_Stop 之後的位置是 second 到 length − 1
        const [first, second] = draft.stops.flatMap((stop, i) => (stop.kind === 'shop' ? [i] : []));
        from = first;
        to = second + (op.to % (length - second));
      } else {
        from = op.stop % length;
        to = op.to % (length - 1);
        if (to >= from) to += 1; // 一定移到另一個位置
      }
      const [stop] = draft.stops.splice(from, 1);
      draft.stops.splice(to, 0, stop);
      return fromEdit(saveRoute(state, draft, ctx), never);
    }
    case 'new-route': {
      const refs = refsOf(state);
      const busy = new Set(routes.map(route => pairKey(route.date, route.vehicleId)));
      const free = tripDates(state).flatMap(date => state.vehicles.filter(vehicle => !busy.has(pairKey(date, vehicle.id))).map(vehicle => [date, vehicle.id]));
      if (!refs.length || !free.length) return skipped('沒有可以新增路線的車與日子');
      const [date, vehicleId] = at(free, op.slot);
      const draft = newRouteDraft(state, date);
      draft.vehicleId = vehicleId;
      draft.from = at(refs, op.from);
      if (!op.keepEnd || !draft.to) draft.to = at(refs, op.to);
      draft.time = op.time;
      draft.stops = op.stops.map((stop, i) => ({ stopId: null, key: String(i + 1), place: at(refs, stop.place), kind: stop.kind, note: '' }));
      // 起點與終點相同時一定要有途中任務（需求 5.9），這時加一個採買
      if (draft.from === draft.to && !draft.stops.length) draft.stops.push({ stopId: null, key: '1', place: at(refs, op.to), kind: 'shop', note: '' });
      return fromEdit(saveRoute(state, draft, ctx), never);
    }
    case 'recar': {
      // 只有當天還有沒有路線的車時，「哪一台車」才有其他選擇
      const freeCars = route => {
        const busy = new Set(routes.filter(other => other.date === route.date).map(other => other.vehicleId));
        return state.vehicles.filter(vehicle => !busy.has(vehicle.id));
      };
      const movable = routes.filter(route => freeCars(route).length > 0);
      if (!movable.length) return skipped('沒有可以改派給其他車的路線');
      const route = at(movable, op.route);
      const draft = routeDraft(state, route.id);
      draft.vehicleId = at(freeCars(route), op.car).id;
      return fromEdit(saveRoute(state, draft, ctx), sameEndsOnly);
    }
    case 'delete-route': {
      if (!routes.length) return skipped('沒有路線');
      const shopping = routes.filter(route => shopStopsOf(route).length > 0);
      return fromEdit(deleteRoute(state, at(op.shop && shopping.length ? shopping : routes, op.route).id), never);
    }
    case 'delete-item': {
      const items = state.shopping.filter(item => !item.mealIds?.length);
      if (!items.length) return skipped('沒有可以刪除的採買品項');
      const item = at(items, op.item);
      const next = structuredClone(state);
      next.shopping = next.shopping.filter(other => other.id !== item.id);
      syncMealIngredients(next);
      return applied(next);
    }
    case 'save-meal': {
      const old = op.meal === 'new' || !state.meals.length ? null : at(state.meals, op.meal);
      const dates = tripDates(state);
      const ingredients = op.ingredients === 'keep' ? old?.ingredients ?? '' : op.ingredients.join(op.separator);
      const slot = op.slot === 'keep' ? old?.slot ?? '晚餐' : op.slot;
      // 料理名稱是必填欄位；舊資料的名稱是空白時，使用者先填寫名稱
      const title = old && old.title.trim() ? old.title : `料理〔${ctx.uid()}〕`;
      const values = old
        ? { id: old.id, title, date: op.moveDate ? at(dates, op.date) : old.date, slot, cookId: old.cookId, servings: old.servings, ingredients, notes: old.notes }
        : { id: null, title, date: at(dates, op.date), slot, cookId: '', servings: 4, ingredients, notes: '' };
      // 保留前後有空白的舊餐次（例如「\u3000早」）時，表單送出去除空白後的餐次，不在選項中而被拒絕
      const keptSlot = result => Boolean(old) && op.slot === 'keep' && result.formError === EDIT_MESSAGES.mealSlot;
      return fromEdit(saveMeal(state, values, ctx), keptSlot);
    }
    case 'delete-meal': {
      if (!state.meals.length) return skipped('沒有料理');
      const meal = at(state.meals, op.meal);
      const next = structuredClone(state);
      next.meals = next.meals.filter(other => other.id !== meal.id);
      syncMealIngredients(next);
      return applied(next);
    }
    case 'sync': {
      const next = structuredClone(state);
      syncMealIngredients(next);
      return applied(next);
    }
    default:
      throw new Error(`未知的操作：${op.op}`);
  }
}

// ---- 起始狀態 ----
// 採買品項名稱的寫法（需求 6.9、14.16）。
const ITEM_NAMES = Object.freeze([
  // 處理後都是「牛肉片」：去除前後的空白（含全形空白、換行與 U+0085）
  '牛肉片', ' 牛肉片\u3000', '牛肉片\n', '\u0085牛肉片',
  // 處理後都是「A B」：含換行的連續空白換成一個半形空白
  'A B', 'A\r\nB', 'A\u2028\u3000B', ' A\n\nB ',
  // 不含換行的連續空白原樣保留，與「A B」不同
  'A  B', 'A\u3000B',
  // 處理後是空字串
  '', ' ', '\u3000\n',
  // 其他：U+200B 不是空白字元；舊的合併品項
  '\u200B', '甜椒、玉米', '鮮蝦'
]);
/** Buyer_Car 有 First_Shopping_Stop 的旅伴：品項改給他們就會列在某個 Stop_Items。 */
function shoppers(state) {
  const want = expectedPlan(state);
  return state.people.map(person => person.id).filter(id => want.firstStop.has(want.buyerCar.get(id)));
}
/**
 * base 的副本（沒有修改時就是 base）：
 * - gather：以 assignShopping() 把最多 gather 個品項改給 Buyer_Car 有 First_Shopping_Stop 的旅伴，讓 Stop_Items 常有兩個
 *   以上的品項。
 * - names：依序改寫品項名稱為 ITEM_NAMES 的寫法；有 Stop_Items 時改寫品項最多的那一個 Stop_Items 中的品項，讓需求 6.9 的
 *   去除重複、略過空白與需求 14.16 的空白規則常出現在同一個 Shopping_Summary 中。
 * 這些修改都在驗證規則之內；屬性仍以 isValidState() 檢查起始狀態。
 */
function prepareStart({ base, gather, names, pick }) {
  if (!base.shopping.length || (!gather && !names.length)) return base;
  const state = structuredClone(base);
  const candidates = shoppers(state);
  if (candidates.length) {
    state.shopping.filter(item => !candidates.includes(item.assignee)).slice(0, gather)
      .forEach((item, i) => assignShopping(state, item.id, at(candidates, pick + i)));
  }
  if (names.length) {
    const lists = [...expectedPlan(state).stopItems.values()].filter(list => list.length);
    const target = lists.length ? lists.reduce((most, list) => (list.length > most.length ? list : most)) : state.shopping;
    names.forEach((name, i) => { at(target, pick + i).name = name; });
  }
  return state;
}
// itineraryState() 是需求 23.3 的值域；endMixState() 一定有車與路線（同一天 1 到 12 條），路線的操作因此常有對象；
// legacyState() 是本功能之前、沒有地點與路線欄位的 Trip_State。
const startState = fc.record({
  base: fc.oneof(
    { weight: 3, arbitrary: itineraryState() },
    { weight: 2, arbitrary: endMixState().map(mix => mix.state) },
    { weight: 1, arbitrary: legacyState() }
  ),
  gather: fc.nat({ max: 4 }),
  names: fc.array(fc.constantFrom(...ITEM_NAMES), { maxLength: 6 }),
  pick: pickArb
}).map(prepareStart);
/** 新識別碼的產生器（saveRoute()、saveVehicle() 與 saveMeal() 的 ctx.uid），每組操作序列從頭編號，不與產生器的識別碼相同。 */
function uidContext() {
  let serial = 0;
  return { uid: () => `op-${++serial}` };
}

// 每一種操作至少要被接受這麼多次。實測 200 組約 1,100 個操作，被接受最少的 delete-item 也有約 20 次，其他都在 30 次以上。
const MIN_APPLIED = 5;

describe('Property 9: 採買推導的分割與摘要', () => {
  test('參考實作重現需求 6.9 至 6.11 的範例，且與 shoppingPlan() 相同', () => {
    const manual = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
    const routeOf = (state, id) => state.routes.find(route => route.id === id);
    const itemOf = (state, id) => state.shopping.find(item => item.id === id);
    /** Example_Trip 套用 change 之後的 Trip_State：通過驗證，shoppingPlan() 與參考實作相同；回傳參考實作的結果。 */
    const variant = (label, change) => {
      const state = exampleTrip();
      change(state);
      expect(isValidState(state)).toBe(true);
      checkState(state, label);
      return expectedPlan(state);
    };
    const stopIds = want => [...want.stopItems].map(([id, items]) => [id, items.map(item => item.id)]);
    /** 手動加入的品項（s1 至 s8）在 Unassigned_Shopping 的原因；料理食材的品項（source 'meal'）都是待分配。 */
    const reasons = want => {
      const meal = want.unassigned.filter(({ item }) => item.source === 'meal');
      expect(meal.map(({ code, reason }) => [code, reason])).toEqual(meal.map(() => ['unassigned', '待分配']));
      return want.unassigned.filter(({ item }) => item.source !== 'meal').map(({ item, code, reason }) => [item.id, code, reason]);
    };

    // Example_Trip：八個品項都在第 1 天第三車・採買組在超市／賣場的 Stop_Items（需求 6.11），料理食材都是待分配
    let want = variant('Example_Trip', () => {});
    expect(stopIds(want)).toEqual([['st-1', manual]]);
    expect(reasons(want)).toEqual([]);
    expect(want.unassigned.length).toBe(exampleTrip().shopping.length - manual.length);
    expect([...want.buyerCar]).toEqual([['p1', 'v1'], ['p2', 'v1'], ['p3', 'v3'], ['p4', 'v2'], ['p5', 'v2'], ['p6', 'v3'], ['p7', 'v4'], ['p8', 'v4']]);
    // 需求 6.9 與 6.10 的範例
    expect(summaryOf(want.stopItems.get('st-1'))).toBe('五花肉片、鮮蝦、高麗菜、運動飲料、洋芋片、瓦斯、衛生紙、免洗餐具');
    expect(manual.map(id => want.locationOf.get(id))).toEqual(manual.map(() => ({ n: 1, placeName: '超市／賣場', vehicleName: '第三車・採買組' })));

    // 需求 6.11：其中一項的「誰負責買」改為待分配
    want = variant('一項改為待分配', s => { itemOf(s, 's1').assignee = ''; });
    expect(stopIds(want)).toEqual([['st-1', manual.slice(1)]]);
    expect(reasons(want)).toEqual([['s1', 'unassigned', '待分配']]);
    // 需求 23.2 與 D30：八個品項都改給小安；第一車沒有採買停靠點，超市／賣場的 Stop_Items 是空的，摘要為空字串
    want = variant('八個品項都改給小安', s => { for (const id of manual) itemOf(s, id).assignee = 'p1'; });
    expect(stopIds(want)).toEqual([['st-1', []]]);
    expect(reasons(want)).toEqual(manual.map(id => [id, 'no-stop', '第一車還沒有採買停靠點']));
    expect(summaryOf(want.stopItems.get('st-1'))).toBe('');
    // 需求 6.11 (b)：負責人不在任何車上
    want = variant('負責人不在任何車上', s => {
      s.people.push({ id: 'p9', name: '阿明', color: 'green', role: '' });
      itemOf(s, 's4').assignee = 'p9';
    });
    expect(reasons(want)).toEqual([['s4', 'no-car', '阿明不在任何車上']]);
    expect(want.buyerCar.has('p9')).toBe(false);
    // D29：小雨也是第一車的乘客，她負責的三項算在排在前面的第一車（沒有採買停靠點）
    want = variant('小雨也在第一車', s => { s.vehicles[0].passengers.push('p3'); });
    expect(want.buyerCar.get('p3')).toBe('v1');
    expect(stopIds(want)).toEqual([['st-1', manual.slice(3)]]);
    expect(reasons(want)).toEqual(manual.slice(0, 3).map(id => [id, 'no-stop', '第一車還沒有採買停靠點']));
    // D28：第 3 天也有 Shopping_Stop 時，品項仍列在第 1 天；同一條路線在前面加 Shopping_Stop 時改列在新的那一個
    want = variant('第 3 天也有採買', s => { routeOf(s, 'rt-3-v3').stops.push({ id: 'st-3', place: 'pl-shop', kind: 'shop' }); });
    expect(stopIds(want)).toEqual([['st-1', manual]]);
    want = variant('第 1 天先在出發地點 A 採買', s => { routeOf(s, 'rt-1-v3').stops.unshift({ id: 'st-0', place: 'pl-a', kind: 'shop' }); });
    expect(stopIds(want)).toEqual([['st-0', manual]]);
    expect(want.locationOf.get('s1')).toEqual({ n: 1, placeName: '出發地點 A', vehicleName: '第三車・採買組' });
    // D28：只有第 3 天有 Shopping_Stop（在旅行目的地）；第 1 天的途中任務改成接送時，第三車・採買組沒有採買停靠點
    want = variant('只在第 3 天採買', s => {
      routeOf(s, 'rt-1-v3').stops = [];
      routeOf(s, 'rt-3-v3').stops.push({ id: 'st-3', place: DESTINATION_REF, kind: 'shop' });
    });
    expect(stopIds(want)).toEqual([['st-3', manual]]);
    expect(want.locationOf.get('s8')).toEqual({ n: 3, placeName: '夕淞度日營區', vehicleName: '第三車・採買組' });
    want = variant('採買改成接送', s => { routeOf(s, 'rt-1-v3').stops[0].kind = 'pickup'; });
    expect(stopIds(want)).toEqual([]);
    expect(reasons(want)).toEqual(manual.map(id => [id, 'no-stop', '第三車・採買組還沒有採買停靠點']));
    // 需求 6.9 與 14.16：處理後相同的名稱只列一次、空白名稱不列出、含換行的連續空白換成一個空白，其他空白保留
    want = variant('名稱的寫法', s => {
      itemOf(s, 's2').name = ' 五花肉片\u3000';
      itemOf(s, 's3').name = '\n';
      itemOf(s, 's4').name = '運動\r\n\u3000飲料';
      itemOf(s, 's5').name = '洋芋  片';
    });
    expect(summaryOf(want.stopItems.get('st-1'))).toBe('五花肉片、運動 飲料、洋芋  片、瓦斯、衛生紙、免洗餐具');
  });

  test('起始狀態與每個操作之後：每個品項恰好在一個 First_Shopping_Stop 或未分配採買清單，原因、位置與摘要依規則，推導不改變輸入', () => {
    const seen = new Set(), features = new Set();
    const stats = new Map(OP_NAMES.map(name => [name, { tried: 0, applied: 0, changed: 0, skipped: 0, rejected: 0 }]));
    const property = fc.property(startState, fc.array(shoppingOp(), { minLength: 1, maxLength: 10 }), (start, ops) => {
      for (const feature of generatorFeatures(start)) features.add(feature);
      let state = start;
      let checked = checkState(state, '起始狀態');
      for (const tag of checked.tags) seen.add(tag);
      const ctx = uidContext();
      ops.forEach((op, index) => {
        const where = `第 ${index + 1} 個操作 ${JSON.stringify(op)}`;
        const entry = stats.get(op.op);
        entry.tried += 1;
        let result;
        try {
          result = applyOp(state, op, ctx);
        } catch (error) {
          throw new Error(`${where}：${error instanceof Error ? error.message : String(error)}`);
        }
        // 被拒絕或沒有對象的操作不改變 Trip_State
        if (result.status !== 'applied') {
          entry[result.status] += 1;
          return;
        }
        entry.applied += 1;
        state = result.state;
        const previous = checked.view;
        checked = checkState(state, `${where}之後`);
        if (checked.view !== previous) entry.changed += 1;
        for (const tag of checked.tags) seen.add(tag);
      });
    });
    fc.assert(property, BOUNDED);

    // 需求 23.14 列出的產生器特徵都在起始狀態中出現，需求 6.11 的四種結果與 COVERAGE 的情況都至少出現一次
    expect(GENERATOR_FEATURES.filter(feature => !features.has(feature))).toEqual([]);
    expect(COVERAGE.filter(tag => !seen.has(tag))).toEqual([]);
    // 每一種操作都被接受過 MIN_APPLIED 次以上，而且改變過推導的結果
    const weak = OP_NAMES.filter(name => stats.get(name).applied < MIN_APPLIED || stats.get(name).changed === 0);
    expect(weak.map(name => [name, stats.get(name)])).toEqual([]);
  }, TIMEOUT);
});
