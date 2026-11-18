// trip-planning-workflow-enhance：卡片編輯的範例測試（src/itinerary-edits.js）
// - 每一種錯誤的 field 與訊息（設計「各操作的規則」；需求 2.2、2.7、2.8、4.9、5.9、5.10、6.13、7.10、8.11、10.10、18.15）：
//   需求或設計逐字規定的訊息（2.2「已有同名地點」、2.8「地點最多 100 個」、6.2「每台車最多 6 個停靠點」，以及設計
//   「Error Handling」的「資料驗證未通過，沒有儲存。請重新載入後再試。」）比對文字本身，其他訊息比對 EDIT_MESSAGES 與
//   PLACE_NAME_MESSAGES。
// - legacyRouteDraft() 的四種情況（需求 19.11、2.8）：同名地點、新增地點、名稱不合規、已有 100 個地點。
// - saveMeal()：改變餐次時清除自訂時間，套用料理範本時保留（需求 8.4、D18）。
// - saveVehicle()：既有車輛的 meeting 維持原值，新車輛為 ''（需求 3.7）。
// 每個失敗的操作都不修改傳入的 Trip_State、Draft 與表單值，失敗結果的 errors、formError、usages 都存在；
// 成功的結果都通過 isValidState()。
import { describe, expect, test } from 'bun:test';

import {
  EDIT_MESSAGES, activityDraft, addPresets, clearLegacy, deleteActivity, deletePlace, deleteRoute, legacyRouteDraft,
  newActivityDraft, newRouteDraft, routeDraft, saveActivity, saveArrival, saveDaySettings, saveMeal, saveMealTime,
  savePlace, saveRoute, saveVehicle, setActivityDone
} from '../src/itinerary-edits.js';
import { legacyDepartures } from '../src/itinerary-derive.js';
import { DESTINATION_REF, PLACE_NAME_MESSAGES, mealTime } from '../src/itinerary-model.js';
import { isValidState, seed } from '../src/model.js';
import { applyRecipeTemplate } from '../src/recipes.js';
import { exampleTrip } from './fixtures/example-trip.js';

const DAY_1 = '2026-10-20', DAY_2 = '2026-10-21', DAY_3 = '2026-10-22';
/** 不在 Example_Trip 旅行日期內的日子 */
const OUTSIDE = '2026-10-23';

// 需求與設計逐字規定的訊息
const SAME_NAME = '已有同名地點'; // 需求 2.2
const PLACE_LIMIT = '地點最多 100 個'; // 需求 2.8
const STOP_LIMIT = '每台車最多 6 個停靠點'; // 需求 6.2
const INVALID_STATE = '資料驗證未通過，沒有儲存。請重新載入後再試。'; // 設計「Error Handling」、需求 18.15

/** EDIT_MESSAGES 中的訊息；表中沒有這個鍵時讓測試失敗，而不是拿 undefined 比較。 */
function message(key) {
  const value = EDIT_MESSAGES[key];
  if (typeof value !== 'string' || value === '') throw new Error(`EDIT_MESSAGES.${key} 不存在`);
  return value;
}
const fieldError = (field, text) => ({ field, message: text });
/** 失敗結果的完整形狀：沒有用到的鍵為 '' 或 []。 */
const failed = ({ errors = [], formError = '', usages = [] } = {}) => ({ ok: false, errors, formError, usages });
/** 可重現的識別碼產生器：{prefix}-1、{prefix}-2… */
function ids(prefix = 'id') {
  let n = 0;
  return { uid: () => `${prefix}-${++n}` };
}
/** 每次都回傳同一個識別碼的產生器，用來製造與既有項目重複的識別碼。 */
const reuse = id => ({ uid: () => id });

/** 執行一個應該失敗的操作，確認 watched（Trip_State、Draft 或表單值）都沒有被修改，回傳結果。 */
function rejected(run, ...watched) {
  const before = structuredClone(watched);
  const result = run();
  expect(result.ok).toBe(false);
  expect(watched).toStrictEqual(before);
  return result;
}
/** 執行一個應該成功的操作，確認結果通過 isValidState()，且 watched 都沒有被修改，回傳結果。 */
function accepted(run, ...watched) {
  const before = structuredClone(watched);
  const result = run();
  // 失敗時一併顯示 errors 與 formError
  expect(result).toMatchObject({ ok: true });
  expect(isValidState(result.state)).toBe(true);
  expect(watched).toStrictEqual(before);
  return result;
}

function withoutRoute(state, id) {
  state.routes = state.routes.filter(route => route.id !== id);
  return state;
}
/** 加入「地點 7」「地點 8」…，直到地點清單有 total 個地點。 */
function withPlaces(state, total) {
  for (let n = state.places.length + 1; state.places.length < total; n++) state.places.push({ id: `pl-${n}`, name: `地點 ${n}` });
  return state;
}
/** 在第 1 天加入營地時光的活動，直到活動有 total 筆。 */
function withActivities(state, total) {
  for (let n = state.activities.length + 1; state.activities.length < total; n++) {
    state.activities.push({ id: `ax-${n}`, date: DAY_1, time: '09:00', title: `活動 ${n}`, type: 'camp', location: '', note: '', people: [], done: false });
  }
  return state;
}
/** 加入手動新增的採買品項，直到採買清單有 total 項。 */
function withShopping(state, total) {
  for (let n = state.shopping.length + 1; state.shopping.length < total; n++) {
    state.shopping.push({ id: `sx-${n}`, name: `備品 ${n}`, quantity: '1 個', category: '其他', assignee: '', done: false, source: 'manual' });
  }
  return state;
}
/** 第 2 天第一車的新 Route Draft（Example_Trip 第 2 天沒有路線）；changes 覆寫欄位。 */
const draftOf = changes => ({
  routeId: null, date: DAY_2, vehicleId: 'v1', from: 'pl-a', to: DESTINATION_REF, time: '', stops: [], newPlaces: [], legacyText: '',
  ...changes
});
/** Draft 中新增的 Stop。 */
const stopOf = (key, place, kind = 'shop', note = '') => ({ stopId: null, key, place, kind, note });

describe('EDIT_MESSAGES', () => {
  test('訊息表已凍結，每則都是有內容的文字；需求逐字規定的訊息相同', () => {
    expect(Object.isFrozen(EDIT_MESSAGES)).toBe(true);
    for (const [key, value] of Object.entries(EDIT_MESSAGES)) expect([key, typeof value, value.length > 0]).toEqual([key, 'string', true]);
    expect([PLACE_NAME_MESSAGES.duplicate, EDIT_MESSAGES.placeLimit, EDIT_MESSAGES.stopLimit, EDIT_MESSAGES.invalidState])
      .toEqual([SAME_NAME, PLACE_LIMIT, STOP_LIMIT, INVALID_STATE]);
  });
});

describe('savePlace()：欄位 name 與地點上限（需求 2.1、2.2、2.8、3.4）', () => {
  // [說明, 名稱, placeNameError() 的原因]；同名的比較對象是其他地點與旅行目的地
  const NAME_CASES = [
    ['空字串', '', 'empty'],
    ['只有空白（含全形空白與 Tab）', ' \u3000\t', 'empty'],
    ['超過 50 個字', '很'.repeat(51), 'long'],
    ['超過 50 個字又含 Tab：只回報超過 50 個字', `新\t竹${'很'.repeat(49)}`, 'long'],
    ['含 Tab', '新\t竹', 'control'],
    ['含零寬空白', '新竹\u200B', 'control'],
    ['與地點清單中的地點同名', '台北', 'duplicate'],
    ['全形、英文大小寫與前後空白不同仍是同名', '　出發地點 ａ ', 'duplicate'],
    ['全形與半形的斜線視為相同', '超市/賣場', 'duplicate'],
    ['與旅行目的地同名', '夕淞度日營區', 'duplicate']
  ];
  test.each(NAME_CASES)('新增地點：%s', (label, name, reason) => {
    const state = exampleTrip(), values = { id: null, name };
    expect(rejected(() => savePlace(state, values, ids('pl')), state, values))
      .toEqual(failed({ errors: [fieldError('name', PLACE_NAME_MESSAGES[reason])] }));
  });

  test('改名：與自己同名不算同名，名稱去除前後空白後保存，位置不變；與其他地點同名時拒絕', () => {
    const state = exampleTrip(), values = { id: 'pl-a', name: ' 出發地點 a　' };
    const result = accepted(() => savePlace(state, values, ids('pl')), state, values);
    const expected = structuredClone(state);
    expected.places[0] = { id: 'pl-a', name: '出發地點 a' };
    expect(result.state).toEqual(expected);
    expect([result.message, result.focus]).toEqual(['已把地點「出發地點 A」改名為「出發地點 a」', 'place:pl-a']);
    const other = { id: 'pl-a', name: '出發地點 Ｂ' };
    expect(rejected(() => savePlace(state, other, ids('pl')), state, other)).toEqual(failed({ errors: [fieldError('name', SAME_NAME)] }));
  });

  test('新增時地點清單已有 100 個：formError「地點最多 100 個」，名稱的錯誤一併回報；改名不受限制', () => {
    const state = withPlaces(exampleTrip(), 100);
    expect(isValidState(state)).toBe(true);
    const add = { id: null, name: '新竹' };
    expect(rejected(() => savePlace(state, add, ids('pl')), state, add)).toEqual(failed({ formError: PLACE_LIMIT }));
    const blank = { id: '', name: '' };
    expect(rejected(() => savePlace(state, blank, ids('pl')), state, blank))
      .toEqual(failed({ errors: [fieldError('name', PLACE_NAME_MESSAGES.empty)], formError: PLACE_LIMIT }));
    const rename = { id: 'pl-taipei', name: '臺北' };
    expect(accepted(() => savePlace(state, rename, ids('pl')), state, rename).state.places).toHaveLength(100);
    // 有 99 個地點時還能新增第 100 個
    const fewer = withPlaces(exampleTrip(), 99);
    const result = accepted(() => savePlace(fewer, add, ids('pl')), fewer, add);
    expect(result.state.places).toHaveLength(100);
    expect(result.state.places.at(-1)).toEqual({ id: 'pl-1', name: '新竹' });
  });
});

describe('deletePlace()：仍在使用中的地點（需求 2.7）', () => {
  test('不刪除；usages 依天數列出使用處，formError 提示先把使用處改成其他地點', () => {
    const state = exampleTrip();
    expect(rejected(() => deletePlace(state, 'pl-taipei'), state)).toEqual(failed({
      formError: message('placeInUse'),
      usages: ['第一車', '第二車', '第三車・採買組', '第四車'].map(label => ({ n: 3, label }))
    }));
    // 只被某一天的 Day_Location 使用的地點也不能刪除
    state.places.push({ id: 'pl-hsinchu', name: '新竹' });
    state.daySettings[1].place = 'pl-hsinchu';
    expect(isValidState(state)).toBe(true);
    expect(rejected(() => deletePlace(state, 'pl-hsinchu'), state))
      .toEqual(failed({ formError: message('placeInUse'), usages: [{ n: 2, label: '這一天的地點' }] }));
  });
});

describe('saveDaySettings() 與 saveArrival()：欄位 title、place、arrival（需求 4.9、2.2、2.8）', () => {
  test('標題去除前後空白後超過 20 個字、地點已不存在：依欄位順序回報；剛好 20 個字可以儲存', () => {
    const state = exampleTrip();
    const draft = { title: `　${'山'.repeat(21)}　`, place: 'pl-gone', newPlaces: [] };
    expect(rejected(() => saveDaySettings(state, DAY_2, draft, ids('pl')), state, draft)).toEqual(failed({
      errors: [fieldError('title', message('dayTitle')), fieldError('place', message('dayPlace'))]
    }));
    // Draft 中沒有的新地點也視為已不存在
    const missing = { title: '', place: 'new:9', newPlaces: [{ ref: 'new:1', name: '新竹' }] };
    expect(rejected(() => saveDaySettings(state, DAY_2, missing, ids('pl')), state, missing))
      .toEqual(failed({ errors: [fieldError('place', message('dayPlace'))] }));
    const fits = { title: `　${'山'.repeat(20)}　`, place: '', newPlaces: [] };
    const result = accepted(() => saveDaySettings(state, DAY_2, fits, ids('pl')), state, fits);
    expect(result.state.daySettings[1]).toEqual({ date: DAY_2, title: '山'.repeat(20) });
  });

  test('選取的新地點不符合需求 2.1 時，在 place 欄位顯示第一個不符合的原因', () => {
    const state = exampleTrip();
    const cases = [['台北', 'duplicate'], [' 夕淞度日營區 ', 'duplicate'], ['　', 'empty'], ['山'.repeat(51), 'long'], ['山\n屋', 'control']];
    for (const [name, reason] of cases) {
      const draft = { title: '住進慢慢的日子', place: 'new:1', newPlaces: [{ ref: 'new:1', name }] };
      expect(rejected(() => saveDaySettings(state, DAY_2, draft, ids('pl')), state, draft))
        .toEqual(failed({ errors: [fieldError('place', PLACE_NAME_MESSAGES[reason])] }));
    }
  });

  test('選取的新地點會讓地點超過 100 個：formError「地點最多 100 個」；沒有選取的新地點不加入，也不受限制', () => {
    const state = withPlaces(exampleTrip(), 100);
    const draft = { title: '', place: 'new:1', newPlaces: [{ ref: 'new:1', name: '新竹' }] };
    expect(rejected(() => saveDaySettings(state, DAY_2, draft, ids('pl')), state, draft)).toEqual(failed({ formError: PLACE_LIMIT }));
    const unchosen = { ...draft, title: '住進慢慢的日子', place: '' };
    const result = accepted(() => saveDaySettings(state, DAY_2, unchosen, ids('pl')), state, unchosen);
    expect(result.state.places).toEqual(state.places);
  });

  test('預計抵達時間不是空白也不是 HH:MM（含只填一部分）時，在 arrival 欄位回報；全形數字可以儲存', () => {
    const state = exampleTrip();
    for (const arrival of ['8:30', '08:3', '12:', '24:00', '08:30:00', '１２：６０']) {
      const values = { arrival };
      expect(rejected(() => saveArrival(state, DAY_1, values), state, values))
        .toEqual(failed({ errors: [fieldError('arrival', message('time'))] }));
    }
    const result = accepted(() => saveArrival(state, DAY_1, { arrival: '１１：３０' }), state);
    expect(result.state.daySettings[0]).toEqual({ date: DAY_1, title: '向山裡出發', arrival: '11:30' });
  });
});

describe('saveRoute()：路線卡片的欄位（需求 5.9、5.10、6.13、2.2、2.8、6.2）', () => {
  test('欄位錯誤依卡片的順序回報：車、起點、終點、出發時間，再依序是每個 Stop 的地點、任務類型與備註', () => {
    const state = exampleTrip();
    const draft = draftOf({
      vehicleId: '', from: '', to: '', time: '8:00',
      stops: [stopOf('a', '', ''), stopOf('b', 'pl-shop', 'other', '備'.repeat(101))]
    });
    expect(rejected(() => saveRoute(state, draft, ids()), state, draft)).toEqual(failed({
      errors: [
        fieldError('vehicle', message('vehicle')), fieldError('from', message('from')), fieldError('to', message('to')),
        fieldError('time', message('time')), fieldError('stop-a-place', message('stopPlace')),
        fieldError('stop-a-kind', message('stopKind')), fieldError('stop-b-note', message('stopNote'))
      ]
    }));
  });

  test('已不存在的車、地點與 Draft 新地點，以及旅行目的地空白時的旅行目的地，都視為沒有選擇', () => {
    const state = exampleTrip();
    const draft = draftOf({ vehicleId: 'v-gone', from: 'pl-gone', stops: [stopOf('1', 'new:7')] });
    expect(rejected(() => saveRoute(state, draft, ids()), state, draft)).toEqual(failed({
      errors: [fieldError('vehicle', message('vehicle')), fieldError('from', message('from')), fieldError('stop-1-place', message('stopPlace'))]
    }));
    const blank = exampleTrip();
    blank.routes = [];
    blank.trip.destination = '';
    expect(isValidState(blank)).toBe(true);
    const camp = draftOf({ from: DESTINATION_REF, to: DESTINATION_REF });
    expect(rejected(() => saveRoute(blank, camp, ids()), blank, camp))
      .toEqual(failed({ errors: [fieldError('from', message('from')), fieldError('to', message('to'))] }));
  });

  test('起點與終點相同且沒有途中任務時標示「最後到哪裡」；有途中任務時可以儲存', () => {
    const state = exampleTrip();
    const loop = { ...routeDraft(state, 'rt-3-v1'), to: DESTINATION_REF };
    expect(rejected(() => saveRoute(state, loop, ids()), state, loop)).toEqual(failed({ errors: [fieldError('to', message('sameEnds'))] }));
    const viaShop = { ...loop, stops: [stopOf('1', 'pl-shop')] };
    const result = accepted(() => saveRoute(state, viaShop, ids()), state, viaShop);
    expect(result.state.routes[4]).toEqual({
      id: 'rt-3-v1', date: DAY_3, vehicleId: 'v1', from: DESTINATION_REF, to: DESTINATION_REF, time: '12:00',
      stops: [{ id: 'id-1', place: 'pl-shop', kind: 'shop' }]
    });
  });

  test('這台車這一天已有其他路線時標示「哪一台車」；路線自己的車不算', () => {
    const state = exampleTrip();
    // 第 1 天四台車都有路線，「＋新增路線」沒有預選的車
    const added = { ...newRouteDraft(state, DAY_1), vehicleId: 'v1', from: 'pl-a' };
    expect(rejected(() => saveRoute(state, added, ids()), state, added))
      .toEqual(failed({ errors: [fieldError('vehicle', message('vehicleTaken'))] }));
    const moved = { ...routeDraft(state, 'rt-1-v1'), vehicleId: 'v2' };
    expect(rejected(() => saveRoute(state, moved, ids()), state, moved))
      .toEqual(failed({ errors: [fieldError('vehicle', message('vehicleTaken'))] }));
    accepted(() => saveRoute(state, routeDraft(state, 'rt-1-v1'), ids()), state);
  });

  test('出發時間不是空白也不是 HH:MM（含只填一部分）時標示「幾點出發」；全形數字與空白可以儲存', () => {
    const state = exampleTrip();
    for (const time of ['8:00', '0800', '08:0', '08：', '25:00']) {
      const draft = { ...routeDraft(state, 'rt-1-v1'), time };
      expect(rejected(() => saveRoute(state, draft, ids()), state, draft)).toEqual(failed({ errors: [fieldError('time', message('time'))] }));
    }
    const fullWidth = accepted(() => saveRoute(state, { ...routeDraft(state, 'rt-1-v1'), time: '０７：４５' }, ids()), state);
    expect(fullWidth.state.routes[0].time).toBe('07:45');
    const blank = accepted(() => saveRoute(state, { ...routeDraft(state, 'rt-1-v1'), time: '　' }, ids()), state);
    expect(blank.state.routes[0].time).toBe('');
  });

  test('途中任務：欄位以 Draft 中 Stop 的 key 命名；不是採買時備註去除前後空白後最多 100 個字，採買不檢查也不保存備註', () => {
    const state = exampleTrip();
    const base = routeDraft(state, 'rt-1-v3');
    // routeDraft() 依 Stop 的順序以 1、2… 作為 key
    expect(base.stops.map(stop => stop.key)).toEqual(['1']);
    const unchosen = { ...base, stops: [{ ...base.stops[0], place: '', kind: 'drive' }] };
    expect(rejected(() => saveRoute(state, unchosen, ids()), state, unchosen)).toEqual(failed({
      errors: [fieldError('stop-1-place', message('stopPlace')), fieldError('stop-1-kind', message('stopKind'))]
    }));
    const tooLong = { ...base, stops: [...base.stops, stopOf('2', 'pl-taipei', 'pickup', '接'.repeat(101))] };
    expect(rejected(() => saveRoute(state, tooLong, ids()), state, tooLong))
      .toEqual(failed({ errors: [fieldError('stop-2-note', message('stopNote'))] }));
    const fits = {
      ...base,
      stops: [{ ...base.stops[0], note: '買'.repeat(200) }, stopOf('2', 'pl-taipei', 'pickup', ` ${'接'.repeat(100)}\n`)]
    };
    const result = accepted(() => saveRoute(state, fits, ids()), state, fits);
    expect(result.state.routes[2].stops).toEqual([
      { id: 'st-1', place: 'pl-shop', kind: 'shop' },
      { id: 'id-1', place: 'pl-taipei', kind: 'pickup', note: '接'.repeat(100) }
    ]);
  });

  test('Draft 新地點的名稱不符合需求 2.1 時標示選取它的欄位；比較對象包含地點清單、旅行目的地與同一個 Draft 中較早加入的地點', () => {
    const state = exampleTrip();
    const draft = draftOf({
      from: 'new:1', to: 'new:2', stops: [stopOf('a', 'new:3'), stopOf('b', 'new:4', 'pickup')],
      newPlaces: [
        { ref: 'new:1', name: '台北' }, { ref: 'new:2', name: '夕淞度日營區' }, { ref: 'new:3', name: '新竹' },
        { ref: 'new:4', name: ' 新竹 ' },
        // 沒有被任何下拉選單選取的新地點不檢查（儲存時也不加入，見 legacyRouteDraft() 的需求 2.11 測試）
        { ref: 'new:5', name: '台北' }
      ]
    });
    expect(rejected(() => saveRoute(state, draft, ids()), state, draft)).toEqual(failed({
      errors: [fieldError('from', SAME_NAME), fieldError('to', SAME_NAME), fieldError('stop-b-place', SAME_NAME)]
    }));
  });

  test('Draft 新地點依名稱空白、超過 50 個字、含控制字元、同名的順序只回報第一個原因', () => {
    const state = exampleTrip();
    const draft = draftOf({
      from: 'new:1', to: 'new:2', stops: [stopOf('a', 'new:3'), stopOf('b', 'new:4')],
      newPlaces: [
        { ref: 'new:1', name: '\u3000' },
        { ref: 'new:2', name: `${'山'.repeat(50)}\u200B` }, // 51 個字，也含零寬空白
        { ref: 'new:3', name: '山\u200B屋' },
        { ref: 'new:4', name: '山\u200B屋' } // 含零寬空白，也與 new:3 同名
      ]
    });
    expect(rejected(() => saveRoute(state, draft, ids()), state, draft)).toEqual(failed({
      errors: [
        fieldError('from', PLACE_NAME_MESSAGES.empty), fieldError('to', PLACE_NAME_MESSAGES.long),
        fieldError('stop-a-place', PLACE_NAME_MESSAGES.control), fieldError('stop-b-place', PLACE_NAME_MESSAGES.control)
      ]
    }));
  });

  test('超過 6 個途中任務、新地點會讓地點超過 100 個：formError，兩者以「；」連接，欄位錯誤一併回報', () => {
    const state = exampleTrip();
    const seven = Array.from({ length: 7 }, (_, i) => stopOf(`s${i + 1}`, 'pl-shop', 'other'));
    const many = { ...routeDraft(state, 'rt-1-v3'), stops: seven };
    expect(rejected(() => saveRoute(state, many, ids()), state, many)).toEqual(failed({ formError: STOP_LIMIT }));
    accepted(() => saveRoute(state, { ...many, stops: seven.slice(0, 6) }, ids()), state);

    const full = withPlaces(exampleTrip(), 100);
    const newStart = { ...routeDraft(full, 'rt-1-v3'), from: 'new:1', newPlaces: [{ ref: 'new:1', name: '新竹' }] };
    expect(rejected(() => saveRoute(full, newStart, ids()), full, newStart)).toEqual(failed({ formError: PLACE_LIMIT }));
    const both = { ...newStart, stops: seven };
    expect(rejected(() => saveRoute(full, both, ids()), full, both)).toEqual(failed({ formError: `${STOP_LIMIT}；${PLACE_LIMIT}` }));
    const withField = { ...both, time: '9' };
    expect(rejected(() => saveRoute(full, withField, ids()), full, withField))
      .toEqual(failed({ errors: [fieldError('time', message('time'))], formError: `${STOP_LIMIT}；${PLACE_LIMIT}` }));
  });
});

describe('saveActivity() 與 addPresets()：活動（需求 7.10）', () => {
  test('欄位錯誤依卡片的順序回報：標題、日期、時間、類別、參加方式、地點、備註', () => {
    const state = exampleTrip();
    const draft = {
      ...newActivityDraft(state, DAY_2), title: ' \u3000', date: OUTSIDE, time: '', type: 'party', participation: 'some',
      location: '地'.repeat(151), note: '備'.repeat(1001)
    };
    expect(rejected(() => saveActivity(state, draft, ids()), state, draft)).toEqual(failed({
      errors: [
        fieldError('title', message('activityTitle')), fieldError('date', message('activityDate')),
        fieldError('time', message('activityTimeRequired')), fieldError('type', message('activityType')),
        fieldError('participation', message('participation')), fieldError('location', message('activityLocation')),
        fieldError('note', message('activityNote'))
      ]
    }));
  });

  test('標題超過 100 個字、時間不是 HH:MM、「指定車輛」沒有勾選仍存在的車；去除前後空白後在上限內可以儲存', () => {
    const state = exampleTrip();
    const draft = { ...activityDraft(state, 'a1'), title: '搭'.repeat(101), time: '13:0', participation: 'vehicles', vehicleIds: ['v-gone'] };
    expect(rejected(() => saveActivity(state, draft, ids()), state, draft)).toEqual(failed({
      errors: [
        fieldError('title', message('activityTitleLong')), fieldError('time', message('activityTime')),
        fieldError('vehicles', message('activityVehicles'))
      ]
    }));
    const fits = {
      ...activityDraft(state, 'a1'), title: ` ${'搭'.repeat(100)} `, location: '地'.repeat(150), note: '備'.repeat(1000),
      participation: 'vehicles', vehicleIds: ['v-gone', 'v2']
    };
    const result = accepted(() => saveActivity(state, fits, ids()), state, fits);
    expect(result.state.activities[0]).toEqual({
      id: 'a1', date: DAY_1, time: '13:00', title: '搭'.repeat(100), type: 'pitch', location: '地'.repeat(150),
      note: '備'.repeat(1000), people: [], vehicleIds: ['v2'], done: false
    });
  });

  test('「保留原旅伴名單」只適用於已儲存、列有旅伴的活動', () => {
    const state = exampleTrip();
    const notListed = { ...activityDraft(state, 'a1'), participation: 'legacy' };
    expect(rejected(() => saveActivity(state, notListed, ids()), state, notListed))
      .toEqual(failed({ errors: [fieldError('participation', message('participation'))] }));
    const fresh = { ...newActivityDraft(state, DAY_2), title: '午睡', time: '13:00', participation: 'legacy' };
    expect(rejected(() => saveActivity(state, fresh, ids()), state, fresh))
      .toEqual(failed({ errors: [fieldError('participation', message('participation'))] }));
    // seed() 的「把好吃的，一起買齊」列有三位旅伴
    const legacy = seed();
    const draft = activityDraft(legacy, 'a2');
    expect(draft.participation).toBe('legacy');
    expect(accepted(() => saveActivity(legacy, draft, ids()), legacy, draft).state.activities[1].people).toEqual(['p1', 'p3', 'p5']);
  });

  test('新增會讓活動超過 1,000 筆：formError，欄位錯誤一併回報；修改既有活動不受限制', () => {
    const state = withActivities(exampleTrip(), 1000);
    expect(isValidState(state)).toBe(true);
    const fresh = { ...newActivityDraft(state, DAY_2), title: '午睡', time: '13:00' };
    expect(rejected(() => saveActivity(state, fresh, ids()), state, fresh)).toEqual(failed({ formError: message('activityLimit') }));
    const blank = { ...fresh, title: '' };
    expect(rejected(() => saveActivity(state, blank, ids()), state, blank))
      .toEqual(failed({ errors: [fieldError('title', message('activityTitle'))], formError: message('activityLimit') }));
    accepted(() => saveActivity(state, { ...activityDraft(state, 'a1'), title: '搭帳' }, ids()), state);
  });

  test('addPresets()：沒有可以加入的常用活動，或會讓活動超過 1,000 筆時回報 formError', () => {
    const state = exampleTrip();
    // 沒有勾選；第 1 天已經有搭帳與夜晚的活動（顯示為「已加入」）；起床不是第 1 天的建議
    for (const types of [[], ['pitch', 'night'], new Set(['night']), ['wake']]) {
      expect(rejected(() => addPresets(state, DAY_1, types, ids()), state)).toEqual(failed({ formError: message('presetNone') }));
    }
    const crowded = exampleTrip();
    crowded.activities = crowded.activities.filter(activity => activity.date !== DAY_2);
    withActivities(crowded, 999);
    expect(rejected(() => addPresets(crowded, DAY_2, ['wake', 'free'], ids()), crowded))
      .toEqual(failed({ formError: message('activityLimit') }));
    expect(accepted(() => addPresets(crowded, DAY_2, ['wake'], ids()), crowded).state.activities).toHaveLength(1000);
  });
});

describe('saveMealTime()：欄位 time（需求 8.11）', () => {
  test('時間不是空白也不是 HH:MM 時拒絕儲存', () => {
    const state = exampleTrip();
    for (const time of ['18:7', '6:30', '18', '18:60']) {
      const values = { time };
      expect(rejected(() => saveMealTime(state, 'm1', values), state, values))
        .toEqual(failed({ errors: [fieldError('time', message('time'))] }));
    }
  });
});

describe('目標已不存在，或寫入後的 Trip_State 未通過驗證：formError（需求 10.10、18.15）', () => {
  const STALE = [
    ['savePlace：改名已不存在的地點', state => savePlace(state, { id: 'pl-gone', name: '新竹' }, ids())],
    ['deletePlace：已不存在的地點', state => deletePlace(state, 'pl-gone')],
    ['saveDaySettings：不在旅行日期內的日子', state => saveDaySettings(state, OUTSIDE, { title: '加碼一天', place: '' }, ids())],
    ['saveArrival：不在旅行日期內的日子', state => saveArrival(state, OUTSIDE, { arrival: '12:00' })],
    ['saveRoute：已不存在的路線', state => saveRoute(state, { ...routeDraft(state, 'rt-1-v1'), routeId: 'rt-gone' }, ids())],
    ['saveRoute：不在旅行日期內的日子', state => saveRoute(state, draftOf({ date: OUTSIDE }), ids())],
    ['deleteRoute：已不存在的路線', state => deleteRoute(state, 'rt-gone')],
    ['saveActivity：已不存在的活動', state => saveActivity(state, { ...activityDraft(state, 'a1'), activityId: 'a-gone' }, ids())],
    ['addPresets：不在旅行日期內的日子', state => addPresets(state, OUTSIDE, ['wake'], ids())],
    ['deleteActivity：已不存在的活動', state => deleteActivity(state, 'a-gone')],
    ['setActivityDone：已不存在的活動', state => setActivityDone(state, 'a-gone', true)],
    ['saveMealTime：已不存在的料理', state => saveMealTime(state, 'm-gone', { time: '12:00' })],
    ['clearLegacy：已不存在的車', state => clearLegacy(state, 'v-gone')],
    ['saveVehicle：已不存在的車', state => saveVehicle(state, { id: 'v-gone', name: '露營車', driver: '', seats: '4', passengers: [] }, ids())],
    ['saveMeal：已不存在的料理', state => saveMeal(state, {
      id: 'm-gone', title: '咖哩飯', date: DAY_1, slot: '晚餐', cookId: '', servings: '4', ingredients: '', notes: '', imageKind: 'auto'
    }, ids())]
  ];
  test.each(STALE)('%s', (label, run) => {
    const state = exampleTrip();
    expect(rejected(() => run(state), state)).toEqual(failed({ formError: INVALID_STATE }));
  });

  test('寫入結果未通過 isValidState() 時不回傳新的 Trip_State（例如新識別碼與既有項目重複）', () => {
    const state = exampleTrip();
    // 新地點的識別碼與既有地點相同，或等於代表旅行目的地的引用值
    for (const id of ['pl-a', DESTINATION_REF]) {
      expect(rejected(() => savePlace(state, { id: null, name: '新竹' }, reuse(id)), state)).toEqual(failed({ formError: INVALID_STATE }));
    }
    // 新 Stop 的識別碼與另一條路線的 Stop 相同
    const draft = { ...routeDraft(state, 'rt-1-v1'), stops: [stopOf('1', 'pl-shop')] };
    expect(rejected(() => saveRoute(state, draft, reuse('st-1')), state, draft)).toEqual(failed({ formError: INVALID_STATE }));
    // 新車與新活動的識別碼與既有項目相同
    expect(rejected(() => saveVehicle(state, { id: null, name: '露營車', driver: '', seats: '4', passengers: [] }, reuse('v1')), state))
      .toEqual(failed({ formError: INVALID_STATE }));
    const fresh = { ...newActivityDraft(state, DAY_2), title: '午睡', time: '13:00' };
    expect(rejected(() => saveActivity(state, fresh, reuse('a1')), state, fresh)).toEqual(failed({ formError: INVALID_STATE }));
    // 寫入前就未通過驗證的 Trip_State（座位數超過 9 的車），即使只勾選完成也不回傳新的 Trip_State
    const broken = exampleTrip();
    broken.vehicles[0].seats = 10;
    expect(isValidState(broken)).toBe(false);
    expect(rejected(() => setActivityDone(broken, 'a1', true), broken)).toEqual(failed({ formError: INVALID_STATE }));
  });
});

describe('saveVehicle()：Vehicle_Dialog（需求 3.6、3.7）', () => {
  // seed() 的山線小巴
  const VALUES = { id: 'v1', name: '山線小巴', driver: 'p2', seats: '4', passengers: ['p1', 'p3'] };
  // [說明, 對 VALUES 的修改, EDIT_MESSAGES 的鍵]；對話框只顯示第一個未通過的檢查
  const CASES = [
    ['車輛暱稱只有空白', { name: ' \u3000 ' }, 'required'],
    ['座位數空白', { seats: '' }, 'required'],
    ['車輛暱稱超過 50 個字', { name: '車'.repeat(51) }, 'vehicleName'],
    ['座位數為 0', { seats: '0' }, 'vehicleSeats'],
    ['座位數為 10', { seats: '10' }, 'vehicleSeats'],
    ['座位數不是整數', { seats: '2.5' }, 'vehicleSeats'],
    ['乘客加上駕駛超過座位數', { seats: '2' }, 'vehicleCapacity'],
    ['同時有多個錯誤時只回報第一個', { name: '車'.repeat(51), seats: '0' }, 'vehicleName']
  ];
  test.each(CASES)('%s', (label, changes, key) => {
    const state = seed(), values = { ...VALUES, ...changes };
    expect(rejected(() => saveVehicle(state, values, ids()), state, values)).toEqual(failed({ formError: message(key) }));
  });

  test('儲存既有車輛時 meeting 維持原值（表單送來的 meeting 也不採用），舊的出發資料仍然顯示；駕駛不列為乘客', () => {
    const state = seed();
    const values = { id: 'v1', name: ' 山線小巴二號 ', driver: 'p2', seats: '5', passengers: ['p1', 'p3', 'p4', 'p2'], meeting: '' };
    const result = accepted(() => saveVehicle(state, values, ids()), state, values);
    const expected = structuredClone(state);
    expected.vehicles[0] = { id: 'v1', name: '山線小巴二號', driver: 'p2', seats: 5, passengers: ['p1', 'p3', 'p4'], meeting: '14:00 · 台北車站東三門' };
    expect(result.state).toEqual(expected);
    expect([result.message, result.focus]).toEqual(['旅行手冊已更新', 'vehicle:v1']);
    expect(legacyDepartures(result.state).map(({ vehicle, time, location }) => [vehicle.id, time, location]))
      .toEqual([['v1', '14:00', '台北車站東三門'], ['v2', '14:00', '台北車站東三門']]);
  });

  test('新增的車輛加在最後，meeting 為空白，沒有舊的出發資料', () => {
    const state = seed();
    const values = { id: '', name: '露營車', driver: '', seats: 2, passengers: ['p1'] };
    const result = accepted(() => saveVehicle(state, values, ids('car')), state, values);
    expect(result.state.vehicles).toEqual([...state.vehicles, { id: 'car-1', name: '露營車', driver: '', seats: 2, passengers: ['p1'], meeting: '' }]);
    expect(result.focus).toBe('vehicle:car-1');
    expect(legacyDepartures(result.state).map(({ vehicle }) => vehicle.id)).toEqual(['v1', 'v2']);
  });
});

describe('saveMeal()：料理對話框（需求 8.4、D18）', () => {
  /** 料理對話框送出的值；changes 覆寫欄位。 */
  const mealValues = (meal, changes = {}) => ({
    id: meal.id, title: meal.title, date: meal.date, slot: meal.slot, cookId: meal.cookId, servings: String(meal.servings),
    ingredients: meal.ingredients, notes: meal.notes, imageKind: meal.imageKind ?? 'auto', ...changes
  });
  /** Example_Trip，第 1 天的晚餐「烤肉派對」有自訂時間 19:30。 */
  function timedTrip() {
    const state = exampleTrip();
    state.meals[0].time = '19:30';
    expect(isValidState(state)).toBe(true);
    return state;
  }
  /** 這次儲存新增的採買品項：[名稱, 來源, 誰負責買, mealIds] */
  const addedItems = (before, after) => after.shopping
    .filter(item => !before.shopping.some(old => old.id === item.id))
    .map(item => [item.name, item.source, item.assignee, item.mealIds]);

  // [說明, 對烤肉派對的修改, EDIT_MESSAGES 的鍵]；對話框只顯示第一個未通過的檢查
  const CASES = [
    ['料理名稱只有空白', { title: '　' }, 'required'],
    ['餐次空白', { slot: '' }, 'required'],
    ['人數空白', { servings: ' ' }, 'required'],
    ['料理名稱超過 100 個字', { title: '烤'.repeat(101) }, 'mealName'],
    ['不是料理菜單提供的餐次', { slot: '早午餐' }, 'mealSlot'],
    ['人數為 0', { servings: '0' }, 'mealServings'],
    ['人數為 101', { servings: '101' }, 'mealServings'],
    ['人數不是整數', { servings: '1.5' }, 'mealServings'],
    ['食材超過 500 字', { ingredients: '肉'.repeat(501) }, 'mealIngredients'],
    ['料理筆記超過 1,000 個字', { notes: '記'.repeat(1001) }, 'mealNotes'],
    ['不是料理插圖類型的圖片', { imageKind: 'evil' }, 'mealImage'],
    ['同時有多個錯誤時只回報第一個', { title: '烤'.repeat(101), slot: '早午餐', servings: '0' }, 'mealName']
  ];
  test.each(CASES)('%s', (label, changes, key) => {
    const state = exampleTrip(), values = mealValues(state.meals[0], changes);
    expect(rejected(() => saveMeal(state, values, ids()), state, values)).toEqual(failed({ formError: message(key) }));
  });

  test('料理食材同步會讓採買品項超過 1,000 項時，回報 syncMealIngredients() 的訊息', () => {
    const state = withShopping(exampleTrip(), 1000);
    expect(isValidState(state)).toBe(true);
    const values = mealValues(state.meals[0], { ingredients: '牛排' });
    expect(rejected(() => saveMeal(state, values, ids()), state, values))
      .toEqual(failed({ formError: '採買品項最多 1,000 項，請減少食材或整理採買清單後再儲存。' }));
  });

  test('改變餐次時移除自訂時間，Meal_Time 回到新餐次的預設時間', () => {
    const state = timedTrip(), values = mealValues(state.meals[0], { slot: '消夜' });
    const result = accepted(() => saveMeal(state, values, ids()), state, values);
    const expected = structuredClone(state);
    expected.meals[0] = { id: 'm1', date: DAY_1, slot: '消夜', title: '烤肉派對', cookId: '', servings: 8, ingredients: '', notes: '' };
    expect(result.state).toEqual(expected);
    expect(Object.hasOwn(result.state.meals[0], 'time')).toBe(false);
    expect(mealTime(result.state.meals[0])).toBe('21:00');
    expect([result.message, result.focus]).toEqual(['料理已儲存，食材已同步採買清單', 'meal-edit-m1']);
  });

  test('餐次沒有改變時保留自訂時間：修改日期、料理名稱、主廚、人數、食材與料理筆記', () => {
    const state = timedTrip();
    const values = mealValues(state.meals[0], {
      date: DAY_2, title: '炭烤之夜', cookId: 'p4', servings: '6', ingredients: '雞腿肉、玉米', notes: '記得帶炭'
    });
    const result = accepted(() => saveMeal(state, values, ids()), state, values);
    expect(result.state.meals[0]).toEqual({
      id: 'm1', date: DAY_2, slot: '晚餐', title: '炭烤之夜', cookId: 'p4', servings: 6, ingredients: '雞腿肉、玉米', notes: '記得帶炭',
      time: '19:30'
    });
    expect(mealTime(result.state.meals[0])).toBe('19:30');
    // 食材已同步採買清單，新增的品項是待分配
    expect(addedItems(state, result.state)).toEqual([['雞腿肉', 'meal', '', ['m1']], ['玉米', 'meal', '', ['m1']]]);
  });

  test('套用料理範本時保留自訂時間；套用範本又改了餐次時仍移除', () => {
    const state = timedTrip();
    const values = applyRecipeTemplate(mealValues(state.meals[0]), 'bbq');
    const result = accepted(() => saveMeal(state, values, ids()), state, values);
    expect(result.state.meals[0]).toEqual({
      id: 'm1', date: DAY_1, slot: '晚餐', title: '星空炭火燒烤', cookId: '', servings: 8,
      ingredients: '雞腿肉、香腸、玉米、甜椒、櫛瓜、烤肉醬', notes: '肉類與蔬菜分開處理，雞肉要烤熟。', imageKind: 'bbq', time: '19:30'
    });
    // 範本的食材同步到採買清單；香腸已在清單上（午餐的食材），改為同時連動兩筆料理
    expect(addedItems(state, result.state)).toEqual(['雞腿肉', '玉米', '甜椒', '櫛瓜', '烤肉醬'].map(name => [name, 'meal', '', ['m1']]));
    expect(result.state.shopping.find(item => item.name === '香腸').mealIds).toEqual(['m1', 'm3']);

    const lunch = applyRecipeTemplate(mealValues(state.meals[0], { slot: '午餐' }), 'bbq');
    const moved = accepted(() => saveMeal(state, lunch, ids()), state, lunch);
    expect(Object.hasOwn(moved.state.meals[0], 'time')).toBe(false);
    expect(mealTime(moved.state.meals[0])).toBe('12:00');
  });

  test('餐次去除前後空白後相同時不算改變：舊資料的「 晚餐 」存為「晚餐」並保留自訂時間', () => {
    const state = timedTrip();
    state.meals[0].slot = ' 晚餐 ';
    expect(isValidState(state)).toBe(true);
    const values = mealValues(state.meals[0]);
    const result = accepted(() => saveMeal(state, values, ids()), state, values);
    expect([result.state.meals[0].slot, result.state.meals[0].time]).toEqual(['晚餐', '19:30']);
  });

  test('新增的料理加在最後，沒有自訂時間', () => {
    const state = exampleTrip();
    const values = {
      id: null, title: '咖哩飯', date: DAY_2, slot: '晚餐', cookId: 'p3', servings: '8', ingredients: '', notes: '', imageKind: 'curry'
    };
    const result = accepted(() => saveMeal(state, values, ids('meal')), state, values);
    expect(result.state.meals).toEqual([
      ...state.meals,
      { id: 'meal-1', title: '咖哩飯', date: DAY_2, slot: '晚餐', cookId: 'p3', servings: 8, ingredients: '', notes: '', imageKind: 'curry' }
    ]);
    expect(mealTime(result.state.meals.at(-1))).toBe('18:00');
  });
});

describe('legacyRouteDraft()：「轉成路線」（需求 19.11、2.8、2.11、19.5）', () => {
  /** 第四車沒有第 1 天的路線，舊的出發資料為 meeting。 */
  function legacyTrip(meeting, state = exampleTrip()) {
    withoutRoute(state, 'rt-1-v4');
    state.vehicles[3].meeting = meeting;
    expect(isValidState(state)).toBe(true);
    return state;
  }

  test('哪一台車為該車、幾點出發為舊出發時間、最後到哪裡為第 1 天的 Day_Location、沒有途中任務', () => {
    const state = legacyTrip('早上八點在家門口');
    state.daySettings[0].place = 'pl-taipei';
    expect(isValidState(state)).toBe(true);
    expect(legacyRouteDraft(state, 'v4')).toMatchObject({ routeId: null, date: DAY_1, vehicleId: 'v4', time: '', to: 'pl-taipei', stops: [] });
    // 旅行目的地空白、第 1 天也沒有設定地點時，最後到哪裡不選取
    const blank = seed();
    blank.trip.destination = '';
    expect(isValidState(blank)).toBe(true);
    expect(legacyRouteDraft(blank, 'v2')).toMatchObject({ date: '2026-11-20', vehicleId: 'v2', time: '14:00', to: '', stops: [] });
  });

  test('同名地點：選取名稱相同（依需求 2.1(d) 比較）的地點或旅行目的地，不新增地點', () => {
    const state = legacyTrip('09:30 · 出發地點 ｄ');
    const draft = legacyRouteDraft(state, 'v4');
    expect(draft).toEqual({
      routeId: null, date: DAY_1, vehicleId: 'v4', from: 'pl-d', to: DESTINATION_REF, time: '09:30',
      stops: [], newPlaces: [], legacyText: ''
    });
    // 儲存時新增第四車第 1 天的路線並清除它的 meeting；地點清單與其他車不變（需求 19.5）
    const result = accepted(() => saveRoute(state, draft, ids()), state, draft);
    const expected = structuredClone(state);
    expected.routes.push({ id: 'id-1', date: DAY_1, vehicleId: 'v4', from: 'pl-d', to: DESTINATION_REF, time: '09:30', stops: [] });
    expected.vehicles[3].meeting = '';
    expect(result.state).toEqual(expected);
    expect([result.message, result.focus]).toEqual(['已儲存第四車第 1 天的路線', 'route:id-1']);
    // 與旅行目的地同名時選取旅行目的地
    expect(legacyRouteDraft(legacyTrip('夕淞度日營區　'), 'v4')).toMatchObject({ from: DESTINATION_REF, time: '', newPlaces: [], legacyText: '' });
  });

  test('新增地點：沒有同名地點時，把以舊出發地點為名稱的新地點加入 Draft 並選取，儲存時才加入地點清單', () => {
    // seed() 的山線小巴：「14:00 · 台北車站東三門」，旅行沒有地點清單
    const state = seed();
    const draft = legacyRouteDraft(state, 'v1');
    expect(draft).toEqual({
      routeId: null, date: '2026-11-20', vehicleId: 'v1', from: 'new:1', to: DESTINATION_REF, time: '14:00',
      stops: [], newPlaces: [{ ref: 'new:1', name: '台北車站東三門' }], legacyText: ''
    });
    // 建立 Draft 不寫入 Trip_State
    expect(state.places).toBeUndefined();
    const result = accepted(() => saveRoute(state, draft, ids()), state, draft);
    const expected = structuredClone(state);
    expected.places = [{ id: 'id-1', name: '台北車站東三門' }];
    expected.routes = [{ id: 'id-2', date: '2026-11-20', vehicleId: 'v1', from: 'id-1', to: DESTINATION_REF, time: '14:00', stops: [] }];
    expected.vehicles[0].meeting = '';
    expect(result.state).toEqual(expected);
    // 海風號的舊出發地點同名，改為選取剛加入的地點
    expect(legacyRouteDraft(result.state, 'v2')).toMatchObject({ from: 'id-1', time: '14:00', newPlaces: [], legacyText: '' });
    // 儲存前改選其他起點時，不再被選取的新地點不加入地點清單（需求 2.11）
    const trip = legacyTrip('09:30 · 新竹交流道');
    const changed = { ...legacyRouteDraft(trip, 'v4'), from: 'pl-d' };
    expect(changed.newPlaces).toEqual([{ ref: 'new:1', name: '新竹交流道' }]);
    const kept = accepted(() => saveRoute(trip, changed, ids()), trip, changed);
    expect(kept.state.places).toEqual(trip.places);
    expect(kept.state.routes.at(-1)).toEqual({ id: 'id-1', date: DAY_1, vehicleId: 'v4', from: 'pl-d', to: DESTINATION_REF, time: '09:30', stops: [] });
  });

  test('名稱不合規：舊出發地點含換行、超過 50 個字或是空白時，不選取起點，legacyText 保留舊出發地點原文', () => {
    const state = legacyTrip('早上八點\n在家門口');
    const draft = legacyRouteDraft(state, 'v4');
    expect(draft).toEqual({
      routeId: null, date: DAY_1, vehicleId: 'v4', from: '', to: DESTINATION_REF, time: '', stops: [], newPlaces: [],
      legacyText: '早上八點\n在家門口'
    });
    // 儲存時要求選擇起點，Draft 與 Trip_State 不變
    expect(rejected(() => saveRoute(state, draft, ids()), state, draft)).toEqual(failed({ errors: [fieldError('from', message('from'))] }));
    const long = `${'很遠的'.repeat(17)}停車場`; // 54 個字
    expect(legacyRouteDraft(legacyTrip(`07:45 ・ ${long}`), 'v4')).toMatchObject({ from: '', time: '07:45', newPlaces: [], legacyText: long });
    // 只有舊出發時間：沒有地點可以選取，legacyText 為空白
    expect(legacyRouteDraft(legacyTrip('07:30'), 'v4')).toMatchObject({ from: '', time: '07:30', newPlaces: [], legacyText: '' });
  });

  test('已有 100 個地點：沒有同名地點時不選取起點；Draft 的新地點會讓地點超過 100 個時拒絕儲存並保留 Draft（需求 2.8）', () => {
    const full = legacyTrip('09:30 · 新竹交流道', withPlaces(exampleTrip(), 100));
    expect(legacyRouteDraft(full, 'v4')).toMatchObject({ from: '', time: '09:30', newPlaces: [], legacyText: '新竹交流道' });
    // 同名地點不必新增，仍然選取
    full.vehicles[3].meeting = '09:30 · 出發地點 D';
    expect(legacyRouteDraft(full, 'v4')).toMatchObject({ from: 'pl-d', newPlaces: [], legacyText: '' });
    // 99 個地點時建立的 Draft 帶有新地點；儲存前地點清單已有 100 個（例如另一個分頁新增了地點）
    const state = legacyTrip('09:30 · 新竹交流道', withPlaces(exampleTrip(), 99));
    const draft = legacyRouteDraft(state, 'v4');
    expect(draft).toMatchObject({ from: 'new:1', newPlaces: [{ ref: 'new:1', name: '新竹交流道' }] });
    const fuller = withPlaces(structuredClone(state), 100);
    expect(rejected(() => saveRoute(fuller, draft, ids()), fuller, draft)).toEqual(failed({ formError: PLACE_LIMIT }));
    // 地點清單還有空位時可以儲存，新地點是第 100 個
    const result = accepted(() => saveRoute(state, draft, ids()), state, draft);
    expect(result.state.places).toHaveLength(100);
    expect(result.state.places.at(-1)).toEqual({ id: 'id-1', name: '新竹交流道' });
  });

  test('沒有這台車時為 null；第 1 天已有路線的車仍建立 Draft，儲存時標示「哪一台車」', () => {
    const state = exampleTrip();
    expect(legacyRouteDraft(state, 'v-gone')).toBeNull();
    state.vehicles[0].meeting = '07:00 · 出發地點 A';
    const draft = legacyRouteDraft(state, 'v1');
    expect(draft).toMatchObject({ vehicleId: 'v1', from: 'pl-a', time: '07:00', newPlaces: [] });
    expect(rejected(() => saveRoute(state, draft, ids()), state, draft))
      .toEqual(failed({ errors: [fieldError('vehicle', message('vehicleTaken'))] }));
  });
});
