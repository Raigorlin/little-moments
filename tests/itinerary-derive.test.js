// trip-planning-workflow-enhance：推導模組的範例測試（src/itinerary-derive.js）
// 資料為 Example_Trip（需求文件前言「範例行程與預期文字版」）與 seed()：
// - 需求 11.2、11.3：Example_Trip 三天的 Day_Caption 與第 3 天的「地點：」行。
// - 需求 3.2：placeRouteCounts() 為夕淞度日營區 8、台北 4、超市／賣場 1；同一條路線只計一次，Day_Settings 不計入。
// - 需求 6.11：八個採買品項都在第三車・採買組的 First_Shopping_Stop；把一項改為待分配後，該項改屬未分配採買清單。
// - 需求 9.1、9.2、9.5：Example_Trip 每天都沒有 Planning_Warning；需求條文中的範例提醒（9.5 的兩則依 9.6 的順序）。
// - 需求 2.7：placeUsages() 依天數列出「這一天的地點」與車名。
// - 需求 3.8：firstDayDeparture() 的 route、legacy（seed() 的山線小巴）與 none。
// - 需求 11.5、11.6、12.10、14.12：路線區塊的終點組與返程行。
// 修改過的 Trip_State 都以 isValidState() 確認仍是有效的資料。
import { describe, expect, test } from 'bun:test';

import {
  dayModel, endGroups, firstDayDeparture, placeLabel, placeRouteCounts, placeUsages, planningWarnings,
  shoppingPlan, shoppingSummary, tripDays
} from '../src/itinerary-derive.js';
import { DESTINATION_REF, dateText } from '../src/itinerary-model.js';
import { isValidState, seed } from '../src/model.js';
import { exampleTrip } from './fixtures/example-trip.js';

const DAY_1 = '2026-10-20', DAY_2 = '2026-10-21', DAY_3 = '2026-10-22';
// Example_Trip 的八個採買品項（s1–s3 由第三車・採買組的駕駛小雨負責，s4–s8 由乘客大海負責），
// 以及料理食材同步加入的十個品項（s9–s18，「誰負責買」為待分配）
const MANUAL_IDS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
const MANUAL_NAMES = ['五花肉片', '鮮蝦', '高麗菜', '運動飲料', '洋芋片', '瓦斯', '衛生紙', '免洗餐具'];
const INGREDIENT_IDS = ['s9', 's10', 's11', 's12', 's13', 's14', 's15', 's16', 's17', 's18'];

const routeOf = (state, id) => state.routes.find(route => route.id === id);
function withoutRoute(state, id) {
  state.routes = state.routes.filter(route => route.id !== id);
  return state;
}
/** 每個 Trip_Day 的 dayModel()；比照每次繪製，只推導一次 shoppingPlan()。 */
function dayModels(state) {
  const plan = shoppingPlan(state);
  return tripDays(state).map(day => dayModel(state, day.date, plan));
}
const routeBlocks = model => model.blocks.filter(block => block.type === 'routes');
/** 一天的 dayModel() 中某條 Route 的路線行。 */
const lineOf = (model, routeId) => routeBlocks(model).flatMap(block => block.lines).find(line => line.route?.id === routeId);
/** planningWarnings() 依日期順序的 [日期, 提醒] 清單。 */
const warningsOf = state => [...planningWarnings(state)];

describe('Example_Trip', () => {
  test('三天的 Day_Caption 與第 3 天的「地點：」行（需求 11.2、11.3）', () => {
    const state = exampleTrip();
    expect(isValidState(state)).toBe(true);
    const models = dayModels(state);
    expect(models.map(model => [model.n, model.kind, model.heading])).toEqual([
      [1, 'first', '向山裡出發'], [2, 'middle', '住進慢慢的日子'], [3, 'last', '把快樂一起帶回家']
    ]);
    expect(models.map(model => model.caption)).toEqual(['四車出發・採買・會合', '今天，留在夕淞度日營區', '四車出發・返程']);
    // 需求 11.2 的範例：第 1 天的日期與 Day_Caption 以「・」連接
    expect(`${dateText(models[0].date)}・${models[0].caption}`).toBe('10/20（週二）・四車出發・採買・會合');
    // 三天都沒有另外設定地點，Day_Location 都是旅行目的地
    for (const model of models) expect(model.location).toEqual({ ref: DESTINATION_REF, name: '夕淞度日營區' });
    // 第 1 天的路線開往營區，營地插畫已標示 Day_Location；第 2 天的 Day_Caption 是「今天，留在夕淞度日營區」；
    // 第 3 天的路線離開營區開往台北，沒有標示 Day_Location 的營地插畫，所以只有第 3 天顯示「地點：夕淞度日營區」
    expect(models.map(model => model.showLocationLine)).toEqual([false, false, true]);
  });

  test('placeRouteCounts()：夕淞度日營區 8 條、台北 4 條、超市／賣場 1 條路線（需求 3.2）', () => {
    const state = exampleTrip();
    const counts = placeRouteCounts(state);
    // 依 Places_And_Cars 的順序：先旅行目的地，再依地點清單的順序
    expect([...counts.keys()]).toEqual([DESTINATION_REF, 'pl-a', 'pl-b', 'pl-c', 'pl-d', 'pl-shop', 'pl-taipei']);
    expect([...counts].map(([ref, count]) => [placeLabel(state, ref), count])).toEqual([
      ['夕淞度日營區', 8], ['出發地點 A', 1], ['出發地點 B', 1], ['出發地點 C', 1], ['出發地點 D', 1], ['超市／賣場', 1], ['台北', 4]
    ]);
  });

  test('placeRouteCounts()：同一條路線只計一次，Day_Settings 不計入，沒有路線使用的地點為 0', () => {
    const state = exampleTrip();
    state.places.push({ id: 'pl-hsinchu', name: '新竹' });
    // 第一車第 2 天從營區出發，到超市／賣場採買後回到營區：起點與終點都是旅行目的地
    state.routes.push({
      id: 'rt-2-v1', date: DAY_2, vehicleId: 'v1', from: DESTINATION_REF, to: DESTINATION_REF, time: '10:00',
      stops: [{ id: 'st-2', place: 'pl-shop', kind: 'shop' }]
    });
    // 第 3 天的地點設為台北
    state.daySettings[2].place = 'pl-taipei';
    expect(isValidState(state)).toBe(true);
    expect([...placeRouteCounts(state)].map(([ref, count]) => [placeLabel(state, ref), count])).toEqual([
      ['夕淞度日營區', 9], ['出發地點 A', 1], ['出發地點 B', 1], ['出發地點 C', 1], ['出發地點 D', 1], ['超市／賣場', 2],
      ['台北', 4], ['新竹', 0]
    ]);
  });

  test('八個採買品項都在第三車・採買組的 First_Shopping_Stop（需求 6.9、6.11）', () => {
    const state = exampleTrip();
    const plan = shoppingPlan(state);
    // 小雨與大海的 Buyer_Car 都是第三車・採買組
    expect([plan.buyerCar.get('p3'), plan.buyerCar.get('p6')]).toEqual(['v3', 'v3']);
    // 只有第三車・採買組有採買停靠點：第 1 天路線上的超市／賣場
    expect([...plan.firstStop.keys()]).toEqual(['v3']);
    const first = plan.firstStop.get('v3');
    expect([first.route.id, first.stop.id, first.n]).toEqual(['rt-1-v3', 'st-1', 1]);
    expect([...plan.stopItems.keys()]).toEqual(['st-1']);
    // 依採買清單的順序
    const items = plan.stopItems.get('st-1');
    expect(items.map(item => [item.id, item.name])).toEqual(MANUAL_IDS.map((id, index) => [id, MANUAL_NAMES[index]]));
    // 採買清單分頁的「第 1 天在超市／賣場（第三車・採買組）」
    expect([...plan.locationOf]).toEqual(MANUAL_IDS.map(id => [id, { n: 1, placeName: '超市／賣場', vehicleName: '第三車・採買組' }]));
    // 料理食材同步加入的品項是待分配，列在未分配採買清單
    expect(plan.unassigned.map(({ item, code, reason }) => [item.id, item.source, code, reason]))
      .toEqual(INGREDIENT_IDS.map(id => [id, 'meal', 'unassigned', '待分配']));
    // 行程圖與文字版在這個停靠點顯示的 Shopping_Summary
    const [stop] = lineOf(dayModel(state, DAY_1, plan), 'rt-1-v3').stops;
    expect([stop.place, stop.label, stop.items]).toEqual(['超市／賣場', '採買', items]);
    expect(stop.summary).toBe('五花肉片、鮮蝦、高麗菜、運動飲料、洋芋片、瓦斯、衛生紙、免洗餐具');
    expect(shoppingSummary(items)).toBe(stop.summary);
  });

  test('每一天都沒有 Planning_Warning', () => {
    const state = exampleTrip();
    expect(warningsOf(state)).toEqual([[DAY_1, []], [DAY_2, []], [DAY_3, []]]);
    // 需求 9.5：八個品項都已買齊時，停靠點仍有 Stop_Items，也不提醒
    for (const item of state.shopping) if (MANUAL_IDS.includes(item.id)) item.done = true;
    expect(isValidState(state)).toBe(true);
    expect(warningsOf(state)).toEqual([[DAY_1, []], [DAY_2, []], [DAY_3, []]]);
  });
});

describe('placeUsages()：地點的使用處（需求 2.7）', () => {
  test('Example_Trip：依天數列出起點、終點或途中任務使用該地點的車', () => {
    const state = exampleTrip();
    expect(placeUsages(state, 'pl-a')).toEqual([{ n: 1, label: '第一車' }]);
    expect(placeUsages(state, 'pl-shop')).toEqual([{ n: 1, label: '第三車・採買組' }]);
    expect(placeUsages(state, 'pl-taipei')).toEqual(['第一車', '第二車', '第三車・採買組', '第四車'].map(label => ({ n: 3, label })));
  });

  test('同一天先列「這一天的地點」，再依車輛順序列出車名，同一天同一台車只列一次', () => {
    const state = exampleTrip();
    state.places.push({ id: 'pl-hsinchu', name: '新竹' }, { id: 'pl-yilan', name: '宜蘭' });
    // 第 1 天：第二車途中到台北接人
    routeOf(state, 'rt-1-v2').stops.push({ id: 'st-2', place: 'pl-taipei', kind: 'pickup', note: '' });
    // 第 2 天的地點設為新竹
    state.daySettings[1].place = 'pl-hsinchu';
    // 第 3 天的地點設為台北；第四車先在台北還裝備，再回到台北
    state.daySettings[2].place = 'pl-taipei';
    routeOf(state, 'rt-3-v4').stops.push({ id: 'st-3', place: 'pl-taipei', kind: 'gear', note: '還帳篷' });
    // 路線的排列順序與天數、車輛順序相反時，結果仍依天數與車輛順序
    state.routes.reverse();
    expect(isValidState(state)).toBe(true);
    expect(placeUsages(state, 'pl-taipei')).toEqual([
      { n: 1, label: '第二車' },
      { n: 3, label: '這一天的地點' },
      { n: 3, label: '第一車' }, { n: 3, label: '第二車' }, { n: 3, label: '第三車・採買組' }, { n: 3, label: '第四車' }
    ]);
    expect(placeUsages(state, 'pl-hsinchu')).toEqual([{ n: 2, label: '這一天的地點' }]);
    // 沒有使用處時為空清單
    expect(placeUsages(state, 'pl-yilan')).toEqual([]);
  });
});

describe('firstDayDeparture()：Trip_Menu 車輛卡片的第 1 天出發（需求 3.8）', () => {
  test('有第 1 天的路線時為 route：出發時間與起點名稱', () => {
    const state = exampleTrip();
    // 例如第一車為「第 1 天・08:00 出發：出發地點 A」
    expect(state.vehicles.map(vehicle => firstDayDeparture(state, vehicle.id))).toEqual([
      { kind: 'route', time: '08:00', place: '出發地點 A' },
      { kind: 'route', time: '08:30', place: '出發地點 B' },
      { kind: 'route', time: '09:00', place: '出發地點 C' },
      { kind: 'route', time: '09:30', place: '出發地點 D' }
    ]);
    // 沒有出發時間時 time 為空字串（「第 1 天・出發時間待定：出發地點 A」）
    routeOf(state, 'rt-1-v1').time = '';
    delete routeOf(state, 'rt-1-v2').time;
    expect(isValidState(state)).toBe(true);
    expect(firstDayDeparture(state, 'v1')).toEqual({ kind: 'route', time: '', place: '出發地點 A' });
    expect(firstDayDeparture(state, 'v2')).toEqual({ kind: 'route', time: '', place: '出發地點 B' });
  });

  test('沒有第 1 天的路線但有舊的出發資料時為 legacy：seed() 的山線小巴', () => {
    const state = seed();
    // 山線小巴為「第 1 天・14:00 出發：台北車站東三門（舊的出發資料）」
    expect(firstDayDeparture(state, 'v1')).toEqual({ kind: 'legacy', time: '14:00', place: '台北車站東三門' });
    // 無法分出時間的自由文字整段作為地點；只有時間時沒有地點（顯示為「出發地點待定」）
    state.vehicles[0].meeting = '早上八點在家門口';
    state.vehicles[1].meeting = '07:30';
    expect(isValidState(state)).toBe(true);
    expect(firstDayDeparture(state, 'v1')).toEqual({ kind: 'legacy', time: '', place: '早上八點在家門口' });
    expect(firstDayDeparture(state, 'v2')).toEqual({ kind: 'legacy', time: '07:30', place: '' });
    // 有第 1 天的路線時改用路線，即使 meeting 還有內容
    state.places = [{ id: 'pl-1', name: '台北車站' }];
    state.routes = [{ id: 'r1', date: '2026-11-20', vehicleId: 'v1', from: 'pl-1', to: DESTINATION_REF, time: '13:30', stops: [] }];
    expect(isValidState(state)).toBe(true);
    expect(firstDayDeparture(state, 'v1')).toEqual({ kind: 'route', time: '13:30', place: '台北車站' });
    expect(firstDayDeparture(state, 'v2')).toEqual({ kind: 'legacy', time: '07:30', place: '' });
  });

  test('兩者都沒有時為 none（「第 1 天還沒有路線」）', () => {
    // 第四車只剩第 3 天的路線，meeting 是空白
    const state = withoutRoute(exampleTrip(), 'rt-1-v4');
    expect(firstDayDeparture(state, 'v4')).toEqual({ kind: 'none' });
    // 只有空白的 meeting 不算舊的出發資料
    state.vehicles[3].meeting = ' \u3000 ';
    expect(isValidState(state)).toBe(true);
    expect(firstDayDeparture(state, 'v4')).toEqual({ kind: 'none' });
    expect(firstDayDeparture(state, 'v9')).toEqual({ kind: 'none' });
  });
});

describe('Planning_Warning 的範例（需求 9.1、9.2、9.5）', () => {
  test('需求 9.1：刪除第 1 天第四車的路線後，第 1 天提醒「第四車這一天還沒有路線」', () => {
    const state = withoutRoute(exampleTrip(), 'rt-1-v4');
    expect(isValidState(state)).toBe(true);
    // 第 2 天沒有任何路線，不產生這則提醒；第 3 天四台車都有路線
    expect(warningsOf(state)).toEqual([[DAY_1, ['第四車這一天還沒有路線']], [DAY_2, []], [DAY_3, []]]);
    // 出發與會合的車數依路線計算（需求 3.13、11.3）
    const [day1] = dayModels(state);
    expect(day1.caption).toBe('三車出發・採買・會合');
    expect(routeBlocks(day1).map(block => block.arrivalLine)).toEqual(['預計 12:00 抵達・三車會合']);
    // 只有舊的出發資料的車也算這一天沒有路線；「{N}車出發」加上這台車，會合的車數不變
    state.vehicles[3].meeting = '09:30 · 出發地點 D';
    expect(isValidState(state)).toBe(true);
    expect(planningWarnings(state).get(DAY_1)).toEqual(['第四車這一天還沒有路線']);
    const [withLegacy] = dayModels(state);
    expect(withLegacy.caption).toBe('四車出發・採買・會合');
    expect(routeBlocks(withLegacy).map(block => block.arrivalLine)).toEqual(['預計 12:00 抵達・三車會合']);
  });

  test('需求 9.2：第四車 12:30 出發，晚於預計抵達 12:00', () => {
    const state = exampleTrip();
    routeOf(state, 'rt-1-v4').time = '12:30';
    expect(warningsOf(state)).toEqual([[DAY_1, ['第四車 12:30 出發，晚於預計抵達 12:00']], [DAY_2, []], [DAY_3, []]]);
    // 出發時間等於預計抵達時間時不提醒
    routeOf(state, 'rt-1-v4').time = '12:00';
    expect(planningWarnings(state).get(DAY_1)).toEqual([]);
    // 沒有出發時間的路線只提醒出發時間待定（需求 9.4）
    routeOf(state, 'rt-1-v4').time = '';
    expect(planningWarnings(state).get(DAY_1)).toEqual(['第四車的出發時間待定']);
    // 第 3 天的路線離開營區，屬於 Other_Routes：出發時間晚於預計抵達時間也不提醒
    state.daySettings[2].arrival = '11:00';
    expect(isValidState(state)).toBe(true);
    expect(planningWarnings(state).get(DAY_3)).toEqual([]);
  });

  test('需求 9.5：八個品項都改由小安負責後，第 1 天提醒第三車・採買組的採買沒有品項，不提醒第一車', () => {
    const state = exampleTrip();
    for (const item of state.shopping) if (MANUAL_IDS.includes(item.id)) item.assignee = 'p1';
    expect(isValidState(state)).toBe(true);
    expect(warningsOf(state)).toEqual([[DAY_1, ['第三車・採買組在超市／賣場的採買沒有品項']], [DAY_2, []], [DAY_3, []]]);
    // 小安的 Buyer_Car 是第一車，第一車沒有採買停靠點：這八項只在未分配採買清單說明原因（D30）
    const plan = shoppingPlan(state);
    expect(plan.stopItems.get('st-1')).toEqual([]);
    expect(plan.unassigned.map(({ item, code, reason }) => [item.id, code, reason])).toEqual([
      ...MANUAL_IDS.map(id => [id, 'no-stop', '第一車還沒有採買停靠點']),
      ...INGREDIENT_IDS.map(id => [id, 'unassigned', '待分配'])
    ]);
  });

  test('需求 9.5、9.6：不是第一個的採買停靠點只標示採買；沒有品項的第一個採買停靠點', () => {
    const state = exampleTrip();
    routeOf(state, 'rt-3-v3').stops.push({ id: 'st-3', place: 'pl-shop', kind: 'shop' });
    expect(isValidState(state)).toBe(true);
    expect(warningsOf(state)).toEqual([
      [DAY_1, []], [DAY_2, []], [DAY_3, ['第三車・採買組在超市／賣場只標示採買，品項列在第 1 天的超市／賣場']]
    ]);
    // 品項仍列在第 1 天的超市／賣場
    const plan = shoppingPlan(state);
    expect(plan.firstStop.get('v3').stop.id).toBe('st-1');
    expect([...plan.stopItems.keys()]).toEqual(['st-1']);
    // 第四車也加上採買停靠點：這是第四車的 First_Shopping_Stop，但阿凱與小芸沒有負責買的品項；兩則依車輛順序排列
    routeOf(state, 'rt-3-v4').stops.push({ id: 'st-4', place: 'pl-shop', kind: 'shop' });
    expect(isValidState(state)).toBe(true);
    expect(planningWarnings(state).get(DAY_3)).toEqual([
      '第三車・採買組在超市／賣場只標示採買，品項列在第 1 天的超市／賣場',
      '第四車在超市／賣場的採買沒有品項'
    ]);
  });
});

describe('需求 6.11 的「待分配」範例', () => {
  test('把鮮蝦的「誰負責買」改為待分配後，鮮蝦改屬未分配採買清單，原因為「待分配」', () => {
    const state = exampleTrip();
    const shrimp = state.shopping.find(item => item.id === 's2');
    shrimp.assignee = '';
    expect(isValidState(state)).toBe(true);
    const before = structuredClone(state);
    const plan = shoppingPlan(state);
    expect(plan.stopItems.get('st-1').map(item => item.name)).toEqual(MANUAL_NAMES.filter(name => name !== '鮮蝦'));
    // 未分配採買清單依採買清單的順序
    expect(plan.unassigned.map(({ item }) => item.id)).toEqual(['s2', ...INGREDIENT_IDS]);
    expect(plan.unassigned[0]).toEqual({ item: shrimp, code: 'unassigned', reason: '待分配' });
    expect(plan.locationOf.has('s2')).toBe(false);
    // 停靠點的 Shopping_Summary 跟著改變；推導不改變 Trip_State 與採買品項
    expect(lineOf(dayModel(state, DAY_1, plan), 'rt-1-v3').stops[0].summary).toBe('五花肉片、高麗菜、運動飲料、洋芋片、瓦斯、衛生紙、免洗餐具');
    expect(state).toEqual(before);
  });
});

describe('路線區塊的終點組（需求 11.5、11.6、12.10、14.12）', () => {
  test('Example_Trip 每個路線區塊都只有一個終點組', () => {
    const [day1, day2, day3] = dayModels(exampleTrip());
    // 第 1 天：四條路線都開往夕淞度日營區（Day_Location），匯合到同一個營地插畫，旁邊停四台車
    expect(routeBlocks(day1).map(block => block.kind)).toEqual(['arrival']);
    const [arrive] = routeBlocks(day1);
    expect(arrive.lines.map(line => [line.time, line.vehicle.name, line.from, line.to])).toEqual([
      ['08:00', '第一車', '出發地點 A', '夕淞度日營區'],
      ['08:30', '第二車', '出發地點 B', '夕淞度日營區'],
      ['09:00', '第三車・採買組', '出發地點 C', '夕淞度日營區'],
      ['09:30', '第四車', '出發地點 D', '夕淞度日營區']
    ]);
    expect(arrive.ends).toEqual([{ ref: DESTINATION_REF, name: '夕淞度日營區', endKind: 'camp', count: 4, lines: [0, 1, 2, 3] }]);
    expect([arrive.arrivalLine, arrive.returnLine]).toEqual(['預計 12:00 抵達・四車會合', null]);
    // 第 2 天沒有路線
    expect(routeBlocks(day2)).toEqual([]);
    // 第 3 天：四條路線都從營區開往台北；Last_Day 中不是 Day_Location 的終點畫房屋（「平安回到台北」）
    expect(routeBlocks(day3).map(block => block.kind)).toEqual(['other']);
    const [home] = routeBlocks(day3);
    expect(home.ends).toEqual([{ ref: 'pl-taipei', name: '台北', endKind: 'house', count: 4, lines: [0, 1, 2, 3] }]);
    expect([home.arrivalLine, home.returnLine]).toEqual([null, '平安返回台北・不預估返抵時間']);
    // endGroups() 直接由區塊的 lines 得到相同的組
    for (const block of [arrive, home]) expect(endGroups(block.lines)).toEqual(block.ends.map(({ ref, lines }) => ({ ref, lines })));
  });

  test('Last_Day 第一車往台北、第二車往新竹、第三車往台北：依序得到台北與新竹兩組', () => {
    const state = withoutRoute(exampleTrip(), 'rt-3-v4');
    state.places.push({ id: 'pl-hsinchu', name: '新竹' });
    routeOf(state, 'rt-3-v2').to = 'pl-hsinchu';
    expect(isValidState(state)).toBe(true);
    const day3 = dayModel(state, DAY_3);
    expect(routeBlocks(day3).map(block => block.kind)).toEqual(['other']);
    const [block] = routeBlocks(day3);
    // 三條路線都是 12:00 出發，依車輛順序排列
    expect(block.lines.map(line => [line.vehicle.name, line.to])).toEqual([['第一車', '台北'], ['第二車', '新竹'], ['第三車・採買組', '台北']]);
    expect(endGroups(block.lines)).toEqual([{ ref: 'pl-taipei', lines: [0, 2] }, { ref: 'pl-hsinchu', lines: [1] }]);
    expect(block.ends).toEqual([
      { ref: 'pl-taipei', name: '台北', endKind: 'house', count: 2, lines: [0, 2] },
      { ref: 'pl-hsinchu', name: '新竹', endKind: 'house', count: 1, lines: [1] }
    ]);
    // 返程行依路線行的順序列出終點，台北只列一次
    expect(block.returnLine).toBe('平安返回台北、新竹・不預估返抵時間');
    expect(day3.caption).toBe('三車出發・返程');
  });
});
