// Feature: trip-planning-workflow-enhance, Property 1: 產生的 Trip_State 通過驗證，JSON 往返不變
// **Validates: Requirements 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.13, 23.3**
//
// 對 tests/support/itinerary-arb.js 的 itineraryState() 產生的每一組 Trip_State s：
// - State_Validator 接受 s：isValidState(s) 為 true，其中 validateItinerary() 對 places、routes（含 stops）、daySettings
//   與 meals[].time 的檢查也為 true（需求 18.1 至 18.8；兩者一起列出，失敗時看得出是新欄位還是既有欄位的規則）。
// - JSON 往返不變：JSON.parse(JSON.stringify(s)) 與 s 嚴格深度相等（所以 s 沒有 undefined、NaN 等 JSON 無法保存的值），
//   且同樣通過驗證；本機版以 save() 存入 localStorage、以 readStorage() 重新載入後，狀態為 'ok' 且與 s 相同（需求 18.13）。
//   序列化在驗證之前，所以也確認驗證沒有修改 s。
// - 車名、活動標題與料理名稱（mealTitle()；都以 cleanText() 後的文字比較）彼此不同（需求 23.3）。
// 三個測試分別使用預設的產生器（地點 0 到 12 個，約一成是 13 到 100 個）、地點 13 到 100 個（一半剛好 100 個）的變體，
// 以及使用者文字與識別碼改用 markupText() 的變體。預設產生器的測試另外確認需求 23.3 與設計 Property 1 列出的值域都
// 至少出現一次（1 天與 31 天、0 台與 8 台車、沒有與 6 個 Stop 的路線、採買 Stop、沒有出發時間的路線、三種舊出發資料、
// 有與沒有 Day_Settings 及 Arrival_Time 的日子、13 種活動類別、5 種餐次與舊餐次、有與沒有時間的餐點、時間相同的活動與
// 餐點、三種「誰負責買」），以及需求 18.3 至 18.7 的邊界（前後有空白與剛好 50 字的地點名稱、emoji 零寬連接符、剛好
// 100 字的 Stop 備註、剛好 20 字的 Day_Title、00:00 與 23:59、缺少與空的新欄位）；依產生器的機率，這些特徵在 200 組中
// 都幾乎必然出現（最少見的「0 個地點」每組約 7%，200 組都沒有的機率低於百萬分之一）。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { MEAL_SLOTS } from '../src/meal-order.js';
import { dateRange, isValidState, readStorage, save } from '../src/model.js';
import { parseVehicleMeeting } from '../src/vehicle-departures.js';
import {
  ACTIVITY_TYPES, DESTINATION_REF, LIMITS, charCount, cleanText, mealTime, mealTitle, trimWhite, validateItinerary
} from '../src/itinerary-model.js';
import { itineraryState } from './support/itinerary-arb.js';

// 每組 Trip_State 的產生約需數毫秒；明訂上限，縮小反例時也有足夠的時間。
const TIMEOUT = 60_000;
const NEW_FIELDS = ['places', 'routes', 'daySettings'];

/** 只存在記憶體的 Storage（save() 與 readStorage() 只使用 getItem 與 setItem）。 */
function memoryStorage() {
  const items = new Map();
  return {
    getItem: key => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => { items.set(key, String(value)); }
  };
}
const duplicates = list => list.filter((item, i) => list.indexOf(item) !== i);

/** 屬性本身：通過驗證、JSON 往返不變、名稱彼此不同。 */
function checkState(s) {
  const text = JSON.stringify(s);
  const dates = dateRange(s.trip.startDate, s.trip.endDate);
  expect({ isValidState: isValidState(s), validateItinerary: validateItinerary(s, dates) })
    .toEqual({ isValidState: true, validateItinerary: true });

  const copy = JSON.parse(text);
  expect(copy).toStrictEqual(s);
  expect(isValidState(copy)).toBe(true);

  // 本機版的儲存與重新載入（需求 18.13）
  const storage = memoryStorage();
  expect(save(storage, s)).toBe(true);
  const loaded = readStorage(storage);
  expect(loaded.status).toBe('ok');
  expect(loaded.state).toStrictEqual(s);

  // 需求 23.3：所有車名、Activity 標題與料理名稱彼此不同
  const names = [...s.vehicles.map(v => cleanText(v.name)), ...s.activities.map(a => cleanText(a.title)), ...s.meals.map(mealTitle)];
  expect(duplicates(names)).toEqual([]);
}

// ---- 值域 ----
// 需求 23.3 與設計 Property 1 列出的值域，以及需求 18.3 至 18.7 的邊界；每一項至少要在一組 Trip_State 中出現。
const DOMAIN = [
  '1 天', '31 天', '0 台車', '8 台車', '0 個地點',
  '名稱前後有空白的地點', '名稱剛好 50 字的地點', '名稱含 emoji 零寬連接符的地點',
  '沒有 Stop 的路線', '6 個 Stop 的路線', '採買 Stop', '備註剛好 100 字的 Stop',
  '有出發時間的路線', '沒有出發時間的路線', '起點、終點或 Stop 是旅行目的地',
  '舊出發資料：時間與地點', '舊出發資料：只有時間', '舊出發資料：無法分出時間',
  '有 Day_Settings 的日子', '沒有 Day_Settings 的日子', '有 Arrival_Time 的日子', '有 Day_Settings 但沒有 Arrival_Time 的日子',
  'Day_Title 剛好 20 字',
  ...ACTIVITY_TYPES.map(type => `活動類別 ${type}`), '全體旅伴', '指定車輛', '舊旅伴名單',
  ...MEAL_SLOTS.map(slot => `餐次 ${slot}`), '舊餐次或自訂餐次', '有時間的餐點', '沒有時間的餐點', '時間相同的活動與餐點',
  '待分配的採買品項', '車上旅伴負責的採買品項', '不在車上的旅伴負責的採買品項',
  '缺少 places、routes 或 daySettings 欄位', 'places、routes 或 daySettings 是空清單', '時間 00:00', '時間 23:59'
];
const MARKUP_CHARS = /[<>&"'`]/;

/** s 具有的值域特徵（DOMAIN 的項目，以及變體測試使用的「100 個地點」與標記文字）。 */
function features(s) {
  const out = new Set();
  const has = (label, condition) => { if (condition) out.add(label); };
  const dates = dateRange(s.trip.startDate, s.trip.endDate);
  const places = s.places ?? [], routes = s.routes ?? [], settings = s.daySettings ?? [];
  has('1 天', dates.length === 1);
  has('31 天', dates.length === 31);
  has('0 台車', s.vehicles.length === 0);
  has('8 台車', s.vehicles.length === 8);
  has('0 個地點', places.length === 0);
  has('100 個地點', places.length === LIMITS.places);
  for (const place of places) {
    has('名稱前後有空白的地點', trimWhite(place.name) !== place.name);
    has('名稱剛好 50 字的地點', charCount(trimWhite(place.name)) === LIMITS.placeName);
    has('名稱含 emoji 零寬連接符的地點', place.name.includes('\u200D'));
    has('含標記字元的地點名稱', MARKUP_CHARS.test(place.name));
    has('含標記字元的識別碼', MARKUP_CHARS.test(place.id));
  }
  for (const route of routes) {
    const stops = route.stops ?? [];
    has('沒有 Stop 的路線', stops.length === 0);
    has('6 個 Stop 的路線', stops.length === LIMITS.stops);
    has('有出發時間的路線', Boolean(route.time));
    has('沒有出發時間的路線', !route.time);
    has('起點、終點或 Stop 是旅行目的地', [route.from, route.to, ...stops.map(stop => stop.place)].includes(DESTINATION_REF));
    for (const stop of stops) {
      has('採買 Stop', stop.kind === 'shop');
      has('備註剛好 100 字的 Stop', typeof stop.note === 'string' && charCount(stop.note) === LIMITS.stopNote);
    }
  }
  // 舊出發資料：First_Day 沒有路線、meeting 有內容的車，依 parseVehicleMeeting() 的結果分成三種（需求 19.7）
  const firstDayCars = new Set(routes.filter(route => route.date === dates[0]).map(route => route.vehicleId));
  for (const vehicle of s.vehicles.filter(v => !firstDayCars.has(v.id))) {
    const { time, location } = parseVehicleMeeting(vehicle.meeting);
    has('舊出發資料：時間與地點', Boolean(time && location));
    has('舊出發資料：只有時間', Boolean(time && !location));
    has('舊出發資料：無法分出時間', Boolean(!time && location));
  }
  has('有 Day_Settings 的日子', settings.length > 0);
  has('沒有 Day_Settings 的日子', dates.some(date => !settings.some(setting => setting.date === date)));
  for (const setting of settings) {
    has('有 Arrival_Time 的日子', Boolean(setting.arrival));
    has('有 Day_Settings 但沒有 Arrival_Time 的日子', !setting.arrival);
    has('Day_Title 剛好 20 字', typeof setting.title === 'string' && charCount(setting.title) === LIMITS.dayTitle);
  }
  for (const activity of s.activities) {
    out.add(`活動類別 ${activity.type}`);
    has('全體旅伴', activity.vehicleIds === undefined && activity.people.length === 0);
    has('指定車輛', activity.vehicleIds !== undefined);
    has('舊旅伴名單', activity.people.length > 0);
  }
  for (const meal of s.meals) {
    out.add(MEAL_SLOTS.includes(meal.slot) ? `餐次 ${meal.slot}` : '舊餐次或自訂餐次');
    has('有時間的餐點', meal.time !== undefined);
    has('沒有時間的餐點', meal.time === undefined);
  }
  has('時間相同的活動與餐點', s.activities.some(a => s.meals.some(m => m.date === a.date && mealTime(m) === a.time)));
  const onCar = new Set(s.vehicles.flatMap(v => [v.driver, ...v.passengers]).filter(Boolean));
  for (const item of s.shopping) {
    out.add(!item.assignee ? '待分配的採買品項' : onCar.has(item.assignee) ? '車上旅伴負責的採買品項' : '不在車上的旅伴負責的採買品項');
  }
  has('缺少 places、routes 或 daySettings 欄位', NEW_FIELDS.some(key => !Object.hasOwn(s, key)));
  has('places、routes 或 daySettings 是空清單', NEW_FIELDS.some(key => Array.isArray(s[key]) && s[key].length === 0));
  const times = [...s.activities.map(a => a.time), ...routes.map(r => r.time), ...settings.map(x => x.arrival), ...s.meals.map(m => m.time)];
  has('時間 00:00', times.includes('00:00'));
  has('時間 23:59', times.includes('23:59'));
  return out;
}

/** 執行屬性並回傳所有 Trip_State 出現過的特徵。 */
function run(arb, numRuns, each = () => {}) {
  const seen = new Set();
  fc.assert(fc.property(arb, s => {
    checkState(s);
    each(s);
    for (const feature of features(s)) seen.add(feature);
  }), { numRuns });
  return seen;
}
const missing = (labels, seen) => labels.filter(label => !seen.has(label));

describe('Property 1: 產生的 Trip_State 通過驗證，JSON 往返不變', () => {
  test('itineraryState()：每一組都通過驗證、JSON 往返不變，且涵蓋需求 23.3 的值域', () => {
    const seen = run(itineraryState(), 200);
    expect(missing(DOMAIN, seen)).toEqual([]);
  }, TIMEOUT);

  test('地點 13 到 100 個的變體（一半剛好 100 個）', () => {
    const seen = run(itineraryState({ places: 'many' }), 100, s => {
      expect(s.places.length).toBeGreaterThan(12);
    });
    expect(missing(['100 個地點'], seen)).toEqual([]);
  }, TIMEOUT);

  test('使用者文字與識別碼為標記文字的變體', () => {
    const seen = run(itineraryState({ markup: true }), 100);
    expect(missing(['含標記字元的地點名稱', '含標記字元的識別碼'], seen)).toEqual([]);
  }, TIMEOUT);
});
