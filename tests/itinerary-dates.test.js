// trip-planning-workflow-enhance：旅行日期變更的範例測試（src/itinerary-dates.js）
// 需求 20.2：Trip_Settings_Dialog 縮短天數，而被移除的日子還有 Route、Day_Title 或 Day_Location（Place）時，
//   retimeByDayIndex() 拒絕並回傳 blocked；shortenBlockedMessage() 的訊息依天數順序列出這些日子的第 N 天與原本的日期，
//   標明「路線」「每日設定」或「路線與每日設定」。只有 Arrival_Time、空白的 Day_Title、Activity 或 Meal 的日子不列出。
// 需求 20.4：伺服器平移日期後放不下既有內容時，shiftByOffset() 回傳 categories；outOfRangeMessage() 的訊息依「活動、
//   餐點、路線、每日設定」的順序列出放不下的類別。只有 Arrival_Time 或空白 Day_Title 的 Day_Settings 直接捨棄，不列入。
// 兩者失敗時都只回傳錯誤資訊，不產生新的 Trip_State，也不修改輸入。測試資料以 Example_Trip 為基礎，都通過 isValidState()。
import { describe, expect, test } from 'bun:test';

import {
  SHIFT_CATEGORIES, outOfRangeMessage, retimeByDayIndex, shiftByOffset, shortenBlockedMessage
} from '../src/itinerary-dates.js';
import { DESTINATION_REF } from '../src/itinerary-model.js';
import { dateRange, isValidState } from '../src/model.js';
import { exampleTrip } from './fixtures/example-trip.js';

// 訊息中的全形標點，以碼位寫出，避免與外觀相近的字元（例如 U+002C、U+FF64、U+FE51）混淆
const COMMA = '\uFF0C';                  // 逗號「，」
const COLON = '\uFF1A';                  // 冒號「：」
const OPEN = '\uFF08', CLOSE = '\uFF09'; // 括號「（」「）」
const DUN = '\u3001';                    // 頓號「、」
const PERIOD = '\u3002';                 // 句號「。」

// ---- 測試資料 ----
/** Example_Trip 移到 startDate 到 endDate（至少 3 天）：原本的內容維持第 1 到 3 天，第 4 天以後沒有內容。 */
function exampleTripOn(startDate, endDate) {
  const state = exampleTrip();
  const dates = dateRange(startDate, endDate);
  const dayN = new Map(dateRange(state.trip.startDate, state.trip.endDate).map((date, i) => [date, dates[i]]));
  for (const item of [...state.activities, ...state.meals, ...state.routes, ...state.daySettings]) item.date = dayN.get(item.date);
  Object.assign(state.trip, { startDate, endDate });
  return state;
}
/** Example_Trip 延長為 2026-10-20 到 2026-10-24 的 5 天；第 4、5 天（10/23、10/24）還沒有內容。 */
const fiveDayTrip = () => exampleTripOn('2026-10-20', '2026-10-24');
const dayDate = (state, n) => dateRange(state.trip.startDate, state.trip.endDate)[n - 1];

// 在第 n 天加上內容。Example_Trip 第 4 天以後沒有路線；每台車每天最多一條路線。
const addRoute = (state, n, vehicleId = 'v1') => state.routes.push({
  id: `rt-${n}-${vehicleId}`, date: dayDate(state, n), vehicleId, from: DESTINATION_REF, to: 'pl-taipei', time: '', stops: []
});
const addActivity = (state, n) => state.activities.push({
  id: `a-${n}`, date: dayDate(state, n), time: '09:00', title: '多留一天', type: 'free', location: '', note: '', people: [], done: false
});
const addMeal = (state, n) => state.meals.push({
  id: `m-${n}`, date: dayDate(state, n), slot: '午餐', title: '野餐', cookId: '', servings: 8, ingredients: '', notes: ''
});
/** 把 values 寫入第 n 天的 Day_Settings（還沒有時新增一筆）。 */
function setDay(state, n, values) {
  const date = dayDate(state, n);
  const setting = state.daySettings.find(item => item.date === date);
  if (setting) Object.assign(setting, values);
  else state.daySettings.push({ date, ...values });
}
// 沒有 Day_Title 也沒有 Day_Location 的 Day_Settings：標題只有半形與全形空白，地點是空字串
const BLANK = { title: ' \u3000', place: '' };

// ---- 需求 20.2 ----
/** retimeByDayIndex() 改為 startDate 到 endDate：確認被拒絕、只回傳 blocked，而且輸入不變，再回傳 blocked。 */
function blockedBy(state, startDate, endDate) {
  expect(isValidState(state)).toBe(true);
  const before = structuredClone(state);
  const result = retimeByDayIndex(state, startDate, endDate);
  expect(Object.keys(result).sort()).toEqual(['blocked', 'ok']);
  expect(result.ok).toBe(false);
  expect(state).toStrictEqual(before);
  return result.blocked;
}

describe('需求 20.2：縮短天數被拒絕時的訊息', () => {
  test('設計的範例：5 天縮成 3 天，第 4 天有路線，第 5 天有路線與 Day_Title', () => {
    const state = fiveDayTrip();
    addRoute(state, 4, 'v1');
    addRoute(state, 5, 'v2');
    setDay(state, 5, { title: '多玩一天' });
    const blocked = blockedBy(state, '2026-10-20', '2026-10-22');
    expect(blocked).toStrictEqual([
      { n: 4, date: '2026-10-23', routes: true, settings: false },
      { n: 5, date: '2026-10-24', routes: true, settings: true }
    ]);
    const message = shortenBlockedMessage(blocked);
    expect(message).toBe('縮短天數前，請先處理：第 4 天（10/23）的路線、第 5 天（10/24）的路線與每日設定。刪除這些路線、清除這些每日設定後，才能縮短天數。');
    // 標點的碼位：U+FF0C、U+FF1A、U+FF08 與 U+FF09、U+3001、U+3002；第 N 天前後的空白與日期中的斜線是半形
    expect(message).toBe(`縮短天數前${COMMA}請先處理${COLON}第 4 天${OPEN}10/23${CLOSE}的路線${DUN}`
      + `第 5 天${OPEN}10/24${CLOSE}的路線與每日設定${PERIOD}刪除這些路線${DUN}清除這些每日設定後${COMMA}才能縮短天數${PERIOD}`);
  });

  test('依天數順序列出，與資料的排列順序無關；只有 Arrival_Time、活動與餐點的日子不列出', () => {
    // 縮成 1 天：第 2 天有 Example_Trip 的 Day_Title，第 3 天有 Example_Trip 的四條路線與 Day_Title
    const state = fiveDayTrip();
    setDay(state, 4, { arrival: '15:00' });
    addActivity(state, 4);
    addMeal(state, 4);
    addRoute(state, 5, 'v2');
    state.routes.reverse();
    state.daySettings.reverse();
    const blocked = blockedBy(state, '2026-10-20', '2026-10-20');
    expect(blocked).toStrictEqual([
      { n: 2, date: '2026-10-21', routes: false, settings: true },
      { n: 3, date: '2026-10-22', routes: true, settings: true },
      { n: 5, date: '2026-10-24', routes: true, settings: false }
    ]);
    expect(shortenBlockedMessage(blocked)).toBe('縮短天數前，請先處理：第 2 天（10/21）的每日設定、第 3 天（10/22）的路線與每日設定、第 5 天（10/24）的路線。刪除這些路線、清除這些每日設定後，才能縮短天數。');
  });

  test('Day_Location 設為地點也算每日設定', () => {
    const state = fiveDayTrip();
    setDay(state, 4, { place: 'pl-taipei' });
    addRoute(state, 5);
    setDay(state, 5, { place: 'pl-shop', arrival: '16:00' });
    const blocked = blockedBy(state, '2026-10-20', '2026-10-22');
    expect(blocked).toStrictEqual([
      { n: 4, date: '2026-10-23', routes: false, settings: true },
      { n: 5, date: '2026-10-24', routes: true, settings: true }
    ]);
    expect(shortenBlockedMessage(blocked)).toBe('縮短天數前，請先處理：第 4 天（10/23）的每日設定、第 5 天（10/24）的路線與每日設定。刪除這些路線、清除這些每日設定後，才能縮短天數。');
  });

  test('空白的 Day_Title 與 Arrival_Time 不算每日設定；被移除的日子只剩這些時可以縮短天數', () => {
    const state = fiveDayTrip();
    addRoute(state, 4);
    setDay(state, 4, { ...BLANK, arrival: '15:00' });
    setDay(state, 5, { title: '\u3000\u3000', arrival: '16:00' });
    addActivity(state, 5);
    const blocked = blockedBy(state, '2026-10-20', '2026-10-22');
    expect(blocked).toStrictEqual([{ n: 4, date: '2026-10-23', routes: true, settings: false }]);
    expect(shortenBlockedMessage(blocked)).toBe('縮短天數前，請先處理：第 4 天（10/23）的路線。刪除這些路線、清除這些每日設定後，才能縮短天數。');
    // 刪除第 4 天的路線後就能縮短，第 4、5 天的 Day_Settings 直接捨棄
    state.routes = state.routes.filter(route => route.date !== '2026-10-23');
    const result = retimeByDayIndex(state, '2026-10-20', '2026-10-22');
    expect(result.ok).toBe(true);
    expect(result.state.daySettings.map(setting => setting.date)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
  });

  test('列出原本的日期（月與日不補零），不受新的開始日期影響', () => {
    // 31 天的旅行（2026-12-20 到 2027-01-19）縮成 10 天：第 13 天是 2027-01-01，第 31 天是 2027-01-19
    const state = exampleTripOn('2026-12-20', '2027-01-19');
    addRoute(state, 13);
    setDay(state, 31, { title: '最後一天' });
    const message = '縮短天數前，請先處理：第 13 天（1/1）的路線、第 31 天（1/19）的每日設定。刪除這些路線、清除這些每日設定後，才能縮短天數。';
    expect(shortenBlockedMessage(blockedBy(state, '2026-12-20', '2026-12-29'))).toBe(message);
    // 同時改開始日期時，仍列出原本的日期，不是新開始日期加 N − 1 天的 3/13、3/31
    expect(shortenBlockedMessage(blockedBy(state, '2027-03-01', '2027-03-10'))).toBe(message);
  });
});

// ---- 需求 20.4 ----
/** shiftByOffset() 改為 startDate 到 endDate：確認失敗、只回傳 categories，而且輸入不變，再回傳 categories。 */
function misfitBy(state, startDate, endDate) {
  expect(isValidState(state)).toBe(true);
  const before = structuredClone(state);
  const result = shiftByOffset(state, startDate, endDate);
  expect(Object.keys(result).sort()).toEqual(['categories', 'ok']);
  expect(result.ok).toBe(false);
  expect(state).toStrictEqual(before);
  return result.categories;
}

// SHIFT_CASES 中放在第 n 天的內容
const PUT = {
  activity: addActivity,
  meal: addMeal,
  route: addRoute,
  title: (state, n) => setDay(state, n, { title: '多玩一天' }),
  place: (state, n) => setDay(state, n, { place: 'pl-taipei' }),
  arrival: (state, n) => setDay(state, n, { arrival: '15:00' }),
  blank: (state, n) => setDay(state, n, BLANK)
};
// content 是放在第 4、5 天的內容，依加入的順序；不同天的類別順序與回報的順序相反時，回報的順序仍固定
const SHIFT_CASES = [
  { label: '第 5 天的活動', content: [[5, 'activity']], categories: ['活動'], message: '新日期範圍放不下既有的活動，請先調整行程或延長日期。' },
  { label: '第 5 天的餐點', content: [[5, 'meal']], categories: ['餐點'], message: '新日期範圍放不下既有的餐點，請先調整行程或延長日期。' },
  { label: '第 4 天的路線', content: [[4, 'route']], categories: ['路線'], message: '新日期範圍放不下既有的路線，請先調整行程或延長日期。' },
  { label: '第 4 天的 Day_Title', content: [[4, 'title']], categories: ['每日設定'], message: '新日期範圍放不下既有的每日設定，請先調整行程或延長日期。' },
  { label: '第 5 天的 Day_Location', content: [[5, 'place']], categories: ['每日設定'], message: '新日期範圍放不下既有的每日設定，請先調整行程或延長日期。' },
  {
    label: '第 4 天的路線、第 5 天的活動', content: [[4, 'route'], [5, 'activity']],
    categories: ['活動', '路線'], message: '新日期範圍放不下既有的活動、路線，請先調整行程或延長日期。'
  },
  {
    label: '第 4 天的 Day_Title、第 5 天的餐點', content: [[4, 'title'], [5, 'meal']],
    categories: ['餐點', '每日設定'], message: '新日期範圍放不下既有的餐點、每日設定，請先調整行程或延長日期。'
  },
  {
    label: '第 4 天的 Day_Location 與路線、第 5 天的餐點與活動', content: [[4, 'place'], [4, 'route'], [5, 'meal'], [5, 'activity']],
    categories: ['活動', '餐點', '路線', '每日設定'], message: '新日期範圍放不下既有的活動、餐點、路線、每日設定，請先調整行程或延長日期。'
  },
  {
    label: '第 4 天只有 Arrival_Time，第 5 天有空白的 Day_Title 與路線', content: [[4, 'arrival'], [5, 'blank'], [5, 'route']],
    categories: ['路線'], message: '新日期範圍放不下既有的路線，請先調整行程或延長日期。'
  }
];

describe('需求 20.4：平移日期後放不下時的訊息', () => {
  test('類別依活動、餐點、路線、每日設定排列', () => {
    expect(SHIFT_CATEGORIES).toEqual(['活動', '餐點', '路線', '每日設定']);
    expect(Object.isFrozen(SHIFT_CATEGORIES)).toBe(true);
  });

  test('Example_Trip 縮成兩天：第 3 天的活動、餐點、路線與 Day_Title 都放不下', () => {
    const categories = misfitBy(exampleTrip(), '2026-10-20', '2026-10-21');
    expect(categories).toStrictEqual(['活動', '餐點', '路線', '每日設定']);
    expect(outOfRangeMessage(categories)).toBe('新日期範圍放不下既有的活動、餐點、路線、每日設定，請先調整行程或延長日期。');
  });

  describe('5 天的旅行改為 2026-10-21 到 2026-10-23（平移 1 天，原本的第 4、5 天落在範圍外）', () => {
    for (const { label, content, categories, message } of SHIFT_CASES) {
      test(label, () => {
        const state = fiveDayTrip();
        for (const [n, kind] of content) PUT[kind](state, n);
        const result = misfitBy(state, '2026-10-21', '2026-10-23');
        expect(result).toStrictEqual(categories);
        expect(outOfRangeMessage(result)).toBe(message);
      });
    }

    test('範圍外只有 Arrival_Time 或空白 Day_Title 的 Day_Settings 時平移成功，這些 Day_Settings 被捨棄', () => {
      const state = fiveDayTrip();
      PUT.arrival(state, 4);
      PUT.blank(state, 5);
      expect(isValidState(state)).toBe(true);
      const result = shiftByOffset(state, '2026-10-21', '2026-10-23');
      expect(result.ok).toBe(true);
      expect(result.state.daySettings.map(setting => setting.date)).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
    });

    test('訊息的固定字元：U+3001 連接類別，之後是 U+FF0C 與 U+3002', () => {
      const state = fiveDayTrip();
      addRoute(state, 4);
      addActivity(state, 5);
      expect(outOfRangeMessage(misfitBy(state, '2026-10-21', '2026-10-23')))
        .toBe(`新日期範圍放不下既有的活動${DUN}路線${COMMA}請先調整行程或延長日期${PERIOD}`);
    });
  });
});

test('沒有被擋下的日子或放不下的類別時，兩種訊息都是空字串', () => {
  expect(shortenBlockedMessage([])).toBe('');
  expect(outOfRangeMessage([])).toBe('');
});
