// Feature: trip-planning-workflow-enhance, Property 3: 單一錯誤一定被驗證拒絕
// **Validates: Requirements 2.1, 6.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 23.4**
//
// faultState(kind)（tests/support/itinerary-arb.js）產生 { state, base, fault }：base 是 Property 1 的 itineraryState()
// 加上有效的準備（需要時加入地點、車輛、路線、Stop、每日設定、餐點或活動，或清空旅行目的地），state 是 base 只加入
// fault 這一種錯誤。每一種錯誤各是一個屬性（numRuns 100），所以需求 23.4 列出的每一種錯誤都一定出現，不靠隨機選到。
// 每一組都檢查 isValidState(base) 為真、isValidState(state) 為假；另以本檔獨立撰寫的判斷（去除前後空白、字數、控制字元、
// HH:MM、任務類型與活動類型的值）確認 base 沒有任何一種錯誤、state 只有 fault 這一種，讓測到的確實是條文所列的錯誤。
// 地點的同名依設計「文字規則」的定義（placeKey() 相等，Property 15 另外測試），Trip_Day 依 dateRange()。
// 需求 23.4 的條列在本檔逐項寫出並與 FAULT_KINDS 比對：Day_Settings 的「日期不在旅行日期範圍內或與另一筆重複」是兩種
// 錯誤；「Day_Location 不是存在的 Place（包括使用 Destination_Place）」以不存在的值與 '@destination' 兩種涵蓋；
// 活動類型（需求 18.2）是 Property 3 另外列出的錯誤。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { DESTINATION_REF, placeKey } from '../src/itinerary-model.js';
import { dateRange, isValidState } from '../src/model.js';
import { FAULT_KINDS, FAULT_TEXT, faultState } from './support/itinerary-arb.js';

const RUNS = { numRuns: 100 };
// 每一組都產生一份完整的 Trip_State，一種錯誤的 100 組約 0.5 秒；放寬時限，機器忙碌時也不會逾時。
const TIMEOUT = 60_000;

// ---- 需求 23.4 的條列 ----
// 需求 23.4 第二部分逐項列出的錯誤（依條文順序），以及 faultState() 中產生該錯誤的種類。
const LISTED = [
  // Place（需求 2.1、18.4）
  { field: 'Place', text: '名稱去除前後空白後為空', kinds: ['place-name-blank'] },
  { field: 'Place', text: '名稱超過 50 字', kinds: ['place-name-long'] },
  { field: 'Place', text: '名稱含控制字元', kinds: ['place-name-control'] },
  { field: 'Place', text: '兩個 Place 名稱相同', kinds: ['place-name-duplicate'] },
  { field: 'Place', text: 'Place 名稱與旅行目的地相同', kinds: ['place-name-destination'] },
  { field: 'Place', text: '有 101 個 Place', kinds: ['place-count'] },
  // Route（需求 18.5；7 個 Stop 也是需求 6.1）
  { field: 'Route', text: '日期不在旅行日期範圍內', kinds: ['route-date'] },
  { field: 'Route', text: 'Vehicle 不存在', kinds: ['route-vehicle'] },
  { field: 'Route', text: '與同一天同一台車的另一條 Route 重複', kinds: ['route-car-day'] },
  { field: 'Route', text: '起點或終點不是存在的 Place 或 Destination_Place', kinds: ['route-end'] },
  { field: 'Route', text: '旅行目的地空白時起點或終點使用 Destination_Place', kinds: ['route-destination-blank'] },
  { field: 'Route', text: '出發時間不是空白也不是 HH:MM', kinds: ['route-time'] },
  { field: 'Route', text: '有 7 個 Stop', kinds: ['route-stop-count'] },
  // Stop（需求 18.6）
  { field: 'Stop', text: '地點不存在', kinds: ['stop-place'] },
  { field: 'Stop', text: '旅行目的地空白時地點使用 Destination_Place', kinds: ['stop-destination-blank'] },
  { field: 'Stop', text: '任務類型不是採買、接送、取還裝備或其他', kinds: ['stop-kind'] },
  { field: 'Stop', text: '備註有 101 字', kinds: ['stop-note'] },
  // Day_Settings（需求 18.7）
  { field: 'Day_Settings', text: '日期不在旅行日期範圍內', kinds: ['day-date'] },
  { field: 'Day_Settings', text: '日期與另一筆重複', kinds: ['day-duplicate'] },
  { field: 'Day_Settings', text: 'Day_Title 有 21 字', kinds: ['day-title'] },
  { field: 'Day_Settings', text: 'Day_Location 不是存在的 Place（包括使用 Destination_Place）', kinds: ['day-place', 'day-place-destination'] },
  { field: 'Day_Settings', text: 'Arrival_Time 不是空白也不是 HH:MM', kinds: ['day-arrival'] },
  // Meal（需求 18.8）
  { field: 'Meal', text: 'Meal 的時間不是 HH:MM', kinds: ['meal-time'] }
];
// Property 3 另外列出的錯誤（需求 18.2）。
const EXTRA = [{ field: 'Activity', text: '活動類型不是 13 個類別的值之一', kinds: ['activity-type'] }];
const ENTRIES = [...LISTED, ...EXTRA];

// ---- 本檔獨立撰寫的判斷 ----
// 去除前後的 White_Space（含全形空白、換行、Tab 與 U+0085，需求 2.1(a)）；字數是碼位數（Char_Count，需求 18.3(d)）。
const trim = text => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
const chars = text => [...text].length;
// 類別 Cc 與 Cf 的字元，連接兩個 emoji 的零寬連接符除外（需求 2.1(c)、18.4）：前面是 emoji（之後可接一個變體選擇符、
// 再接一個膚色修飾符），後面也是 emoji。
const CC_CF = /^[\p{Cc}\p{Cf}]$/u, PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const SELECTOR = /^\p{Variation_Selector}$/u, MODIFIER = /^\p{Emoji_Modifier}$/u;
const is = (pattern, codePoint) => codePoint !== undefined && pattern.test(codePoint);
function joinsEmoji(codePoints, i) {
  let j = i - 1;
  if (is(MODIFIER, codePoints[j])) j--;
  if (is(SELECTOR, codePoints[j])) j--;
  return is(PICTOGRAPHIC, codePoints[j]) && is(PICTOGRAPHIC, codePoints[i + 1]);
}
const hasControl = text => [...text].some((codePoint, i, codePoints) =>
  CC_CF.test(codePoint) && !(codePoint === '\u200D' && joinsEmoji(codePoints, i)));
// 需求 18.3(a)：24 小時制、時與分各兩位數的 00:00 到 23:59；不去除空白，也不接受全形數字。
function isTime(value) {
  if (typeof value !== 'string' || value.length !== 5 || value[2] !== ':') return false;
  const digits = [0, 1, 3, 4].map(i => value.charCodeAt(i) - 0x30);
  return digits.every(d => d >= 0 && d <= 9) && digits[0] * 10 + digits[1] <= 23 && digits[2] * 10 + digits[3] <= 59;
}
// 需求 18.3(b)：未填時間是省略或空字串。
const blankOrTime = value => value === undefined || value === '' || isTime(value);
// 任務類型（採買、接送、取還裝備、其他，需求 6.4、18.6）與 13 個活動類型值（需求 18.2）。
const STOP_KIND_VALUES = ['shop', 'pickup', 'gear', 'other'];
const ACTIVITY_VALUES = ['meet', 'market', 'camp', 'meal', 'night', 'travel', 'wake', 'pitch', 'free', 'tea', 'strike', 'clean', 'return'];
const duplicated = keys => new Set(keys).size !== keys.length;

function facts(s) {
  const places = s.places ?? [];
  const routes = s.routes ?? [];
  const placeIds = new Set(places.map(place => place.id));
  return {
    s, places, routes, placeIds,
    stops: routes.flatMap(route => (Array.isArray(route.stops) ? route.stops : [])),
    settings: s.daySettings ?? [],
    days: new Set(dateRange(s.trip.startDate, s.trip.endDate)), // Trip_Day（需求 18.3(c)）
    vehicleIds: new Set(s.vehicles.map(vehicle => vehicle.id)),
    destination: trim(s.trip.destination) !== '',
    // 存在的 Place 或 Destination_Place 的引用值；旅行目的地空白時使用 Destination_Place 是另一種錯誤
    known: ref => placeIds.has(ref) || ref === DESTINATION_REF
  };
}

// 每一種錯誤的判斷：Trip_State 有這種錯誤時為真。只依條文的描述判斷，與驗證程式的寫法無關；
// 「有 101 個」「有 7 個」「有 101 字」「有 21 字」依條文判斷剛好等於該數量。
const WITNESS = {
  'place-name-blank': f => f.places.some(p => typeof p.name === 'string' && trim(p.name) === ''),
  'place-name-long': f => f.places.some(p => typeof p.name === 'string' && chars(trim(p.name)) > 50),
  'place-name-control': f => f.places.some(p => typeof p.name === 'string' && hasControl(trim(p.name))),
  'place-name-duplicate': f => duplicated(f.places.map(p => placeKey(p.name))),
  'place-name-destination': f => f.destination && f.places.some(p => placeKey(p.name) === placeKey(f.s.trip.destination)),
  'place-count': f => f.places.length === 101,
  'route-date': f => f.routes.some(r => !f.days.has(r.date)),
  'route-vehicle': f => f.routes.some(r => !f.vehicleIds.has(r.vehicleId)),
  'route-car-day': f => duplicated(f.routes.map(r => JSON.stringify([r.date, r.vehicleId]))),
  'route-end': f => f.routes.some(r => !f.known(r.from) || !f.known(r.to)),
  'route-destination-blank': f => !f.destination && f.routes.some(r => r.from === DESTINATION_REF || r.to === DESTINATION_REF),
  'route-time': f => f.routes.some(r => !blankOrTime(r.time)),
  'route-stop-count': f => f.routes.some(r => Array.isArray(r.stops) && r.stops.length === 7),
  'stop-place': f => f.stops.some(stop => !f.known(stop.place)),
  'stop-destination-blank': f => !f.destination && f.stops.some(stop => stop.place === DESTINATION_REF),
  'stop-kind': f => f.stops.some(stop => !STOP_KIND_VALUES.includes(stop.kind)),
  'stop-note': f => f.stops.some(stop => typeof stop.note === 'string' && chars(stop.note) === 101),
  'day-date': f => f.settings.some(d => !f.days.has(d.date)),
  'day-duplicate': f => duplicated(f.settings.map(d => d.date)),
  'day-title': f => f.settings.some(d => typeof d.title === 'string' && chars(d.title) === 21),
  'day-place': f => f.settings.some(d => d.place !== undefined && d.place !== '' && d.place !== DESTINATION_REF && !f.placeIds.has(d.place)),
  'day-place-destination': f => f.settings.some(d => d.place === DESTINATION_REF),
  'day-arrival': f => f.settings.some(d => !blankOrTime(d.arrival)),
  'meal-time': f => f.s.meals.some(m => m.time !== undefined && !isTime(m.time)),
  'activity-type': f => f.s.activities.some(a => !ACTIVITY_VALUES.includes(a.type))
};
/** Trip_State 中有的錯誤種類，依 FAULT_KINDS 的順序。 */
function faultsIn(state) {
  const f = facts(state);
  return FAULT_KINDS.filter(kind => WITNESS[kind](f));
}

describe('Property 3: 單一錯誤一定被驗證拒絕', () => {
  test('需求 23.4 列出的每一種錯誤都有 faultState() 的錯誤種類，FAULT_KINDS 依條文順序且沒有多出的種類', () => {
    for (const entry of ENTRIES) expect(entry.kinds.length).toBeGreaterThan(0);
    expect(ENTRIES.flatMap(entry => entry.kinds)).toEqual([...FAULT_KINDS]);
    expect(Object.keys(WITNESS)).toEqual([...FAULT_KINDS]);
    for (const kind of FAULT_KINDS) expect(typeof FAULT_TEXT[kind]).toBe('string');
  });

  for (const { field, text, kinds } of ENTRIES) {
    for (const kind of kinds) {
      test(`${field}：${text}（${kind}）`, () => {
        let runs = 0;
        fc.assert(fc.property(faultState(kind), ({ state, base, fault }) => {
          // base 通過驗證且沒有任何一種錯誤；state 只多了 fault 這一種錯誤，因此被拒絕
          expect({
            fault,
            baseValid: isValidState(base),
            baseFaults: faultsIn(base),
            stateValid: isValidState(state),
            stateFaults: faultsIn(state)
          }).toEqual({ fault: kind, baseValid: true, baseFaults: [], stateValid: false, stateFaults: [kind] });
          runs++;
        }), RUNS);
        // 這一種錯誤出現了 numRuns 次
        expect(runs).toBe(RUNS.numRuns);
      }, TIMEOUT);
    }
  }
});
