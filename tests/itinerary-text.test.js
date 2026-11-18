// trip-planning-workflow-enhance：文字版的範例測試（src/itinerary-text.js）
// 資料為 Example_Trip（tests/fixtures/example-trip.js，需求文件前言「範例行程與預期文字版」）與 seed()：
// - 需求 14.17、23.1：Example_Trip 的 itineraryText() 與 EXAMPLE_TEXT 逐字相同；在 Etc/UTC、Asia/Taipei 與
//   America/Los_Angeles 三個時區也相同（以設定 TZ 的子行程執行，比較整個字串，不修剪空白）。
// - 需求 23.2（以及 6.8、6.11、9.1、9.5）：Example_Trip 每天都沒有 Planning_Warning；刪除第 1 天第四車的路線，
//   以及把八個採買品項改由第一車的駕駛小安負責，各自逐行比對文字只差預期的行，並比對 Planning_Warning 與
//   未分配採買清單的原因。
// - 需求 14.10：每種途中任務的文字。
// - 需求 14.19：固定字元的碼位。
// - 需求 19.10（與 14.15）：舊出發行，缺少時間或地點時以「出發時間待定」「出發地點待定」代替。
// 修改過的 Trip_State 都以 isValidState() 確認仍是有效的資料。
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { itineraryText, routeLineText, stopText } from '../src/itinerary-text.js';
import { dayModel, planningWarnings, shoppingPlan } from '../src/itinerary-derive.js';
import { isValidState, seed } from '../src/model.js';
import { EXAMPLE_TEXT, exampleTrip } from './fixtures/example-trip.js';

const ROOT = resolve(import.meta.dir, '..');
const DAY_1 = '2026-10-20', DAY_2 = '2026-10-21', DAY_3 = '2026-10-22';
// Example_Trip 的八個採買品項（依採買清單的順序；前三項由小雨負責，後五項由大海負責，兩人都在第三車・採買組）
const MANUAL_NAMES = ['五花肉片', '鮮蝦', '高麗菜', '運動飲料', '洋芋片', '瓦斯', '衛生紙', '免洗餐具'];

/** EXAMPLE_TEXT 的各行逐行套用 edits 的結果：每項為 [原本的行, 取代它的各行]，取代的行為空陣列時刪除該行。
 * 每個原本的行在 EXAMPLE_TEXT 中恰好出現一次，所以修改的位置是確定的；其他行維持原樣。 */
function exampleLinesWith(edits) {
  const lines = EXAMPLE_TEXT.split('\n');
  for (const [line, replacement] of edits) {
    expect([line, lines.filter(entry => entry === line).length]).toEqual([line, 1]);
    lines.splice(lines.indexOf(line), 1, ...replacement);
  }
  return lines;
}
/** 文字版中每一天的段落（各行），依天數排列：從「第 {N} 天」那一行到下一天之前的空行為止。 */
function dayParagraphs(text) {
  const lines = text.split('\n');
  const starts = lines.flatMap((line, index) => (/^第 \d+ 天・/u.test(line) ? [index] : []));
  return starts.map((start, i) => lines.slice(start, i + 1 < starts.length ? starts[i + 1] - 1 : lines.length));
}
/** 一天段落中每個「路線」區塊在「路線」之後的各行，依出現的順序。每個區塊之前都有一個空行。 */
function routeBlocksOf(dayLines) {
  return dayLines.flatMap((line, index) => {
    if (line !== '路線' || dayLines[index - 1] !== '') return [];
    const end = dayLines.indexOf('', index);
    return [dayLines.slice(index + 1, end < 0 ? dayLines.length : end)];
  });
}
/** planningWarnings() 依日期順序的 [日期, 提醒] 清單。 */
const warningsOf = state => [...planningWarnings(state)];
/** 未分配採買清單（Unassigned_Shopping）：依採買清單的順序列出 [品項名稱, 原因]（需求 6.8、6.11）。 */
const unassignedOf = state => shoppingPlan(state).unassigned.map(({ item, reason }) => [item.name, reason]);
/** 料理食材同步加入的品項（「誰負責買」為待分配）在未分配採買清單中的項目。 */
const ingredientRows = state => state.shopping.filter(item => item.source === 'meal').map(item => [item.name, '待分配']);
const occurrences = (text, part) => text.split(part).length - 1;

// 子行程的程式：產生 Example_Trip 的文字版，回報 new Date(0) 的時差與文字。模組位置經環境變數傳入；
// 結果以 base64 編碼的 JSON 寫到 stdout，管線與主控台的編碼不會改變任何字元。
const CHILD_SCRIPT = [
  'const { itineraryText } = await import(process.env.ITINERARY_TEXT_MODULE);',
  'const { exampleTrip } = await import(process.env.EXAMPLE_TRIP_MODULE);',
  'const report = { offset: new Date(0).getTimezoneOffset(), text: itineraryText(exampleTrip()) };',
  "process.stdout.write(Buffer.from(JSON.stringify(report), 'utf8').toString('base64'));"
].join(' ');

/** 在環境變數 TZ 為 timeZone 的 Bun 子行程中產生 Example_Trip 的文字版：{ offset, text }。 */
async function exampleTextIn(timeZone) {
  const child = Bun.spawn([process.execPath, '-e', CHILD_SCRIPT], {
    cwd: ROOT,
    env: {
      ...process.env, TZ: timeZone,
      ITINERARY_TEXT_MODULE: pathToFileURL(resolve(ROOT, 'src/itinerary-text.js')).href,
      EXAMPLE_TRIP_MODULE: pathToFileURL(resolve(ROOT, 'tests/fixtures/example-trip.js')).href
    },
    stdout: 'pipe', stderr: 'pipe'
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ timeZone, code, stderr: code === 0 ? '' : stderr }).toEqual({ timeZone, code: 0, stderr: '' });
  return JSON.parse(Buffer.from(stdout, 'base64').toString('utf8'));
}

describe('需求 14.17、23.1：Example_Trip 的文字版與 Example_Text 逐字相同', () => {
  test('itineraryText(exampleTrip()) 與 EXAMPLE_TEXT 逐字相同，且不修改 Trip_State', () => {
    const state = exampleTrip();
    expect(isValidState(state)).toBe(true);
    const before = structuredClone(state);
    const text = itineraryText(state);
    // 比較整個字串，包括每個換行、空行、標點與半形空白，不修剪空白
    expect(text).toBe(EXAMPLE_TEXT);
    // 最後一行是「平安返回台北・不預估返抵時間」，之後沒有換行字元；以 LF 分行，沒有連續兩個空行（需求 14.1）
    expect(text.split('\n').at(-1)).toBe('平安返回台北・不預估返抵時間');
    expect(text).not.toMatch(/^\n|\n$|\r|\n\n\n/u);
    expect(state).toEqual(before);
  });

  test('在 Etc/UTC、Asia/Taipei 與 America/Los_Angeles 的子行程中都與 EXAMPLE_TEXT 逐字相同', async () => {
    const timeZones = ['Etc/UTC', 'Asia/Taipei', 'America/Los_Angeles'];
    const reports = await Promise.all(timeZones.map(exampleTextIn));
    // 先確認 TZ 確實生效：三個子行程中 1970-01-01 的時差各不相同（UTC、UTC+8、UTC-8）
    expect(reports.map(({ offset }, i) => [timeZones[i], offset]))
      .toEqual([['Etc/UTC', 0], ['Asia/Taipei', -480], ['America/Los_Angeles', 480]]);
    // 比較整個字串，不修剪空白
    for (const [i, { text }] of reports.entries()) expect([timeZones[i], text]).toEqual([timeZones[i], EXAMPLE_TEXT]);
  }, 30_000);
});

describe('需求 23.2：Example_Trip 的兩種修改', () => {
  test('Example_Trip 每一天都沒有 Planning_Warning；未分配採買清單只有待分配的料理食材', () => {
    const state = exampleTrip();
    expect(warningsOf(state)).toEqual([[DAY_1, []], [DAY_2, []], [DAY_3, []]]);
    // 八個品項都列在第三車・採買組第 1 天的超市／賣場；料理食材同步加入的十個品項是待分配
    expect(ingredientRows(state)).toHaveLength(10);
    expect(unassignedOf(state)).toEqual(ingredientRows(state));
  });

  test('刪除第 1 天第四車的路線：少了第四車的路線行，到達行改為三車會合', () => {
    const state = exampleTrip();
    state.routes = state.routes.filter(route => route.id !== 'rt-1-v4');
    expect(isValidState(state)).toBe(true);
    // 與 Example_Text 只差兩處，其他每一行（含空行）都相同
    expect(itineraryText(state).split('\n')).toEqual(exampleLinesWith([
      ['第四車｜09:30 出發：出發地點 D → 夕淞度日營區', []],
      ['預計 12:00 抵達・四車會合', ['預計 12:00 抵達・三車會合']]
    ]));
    // 需求 9.1：第 1 天只有這一則提醒，其他天仍沒有提醒
    expect(warningsOf(state)).toEqual([[DAY_1, ['第四車這一天還沒有路線']], [DAY_2, []], [DAY_3, []]]);
    // 採買品項的去處不變
    expect(unassignedOf(state)).toEqual(ingredientRows(state));
  });

  test('把八個採買品項改由第一車的駕駛小安負責：第三車・採買組的停靠點只標示採買', () => {
    const state = exampleTrip();
    const an = state.people.find(person => person.name === '小安').id;
    expect(state.vehicles[0]).toMatchObject({ name: '第一車', driver: an });
    const manual = state.shopping.filter(item => item.source === 'manual');
    expect(manual.map(item => item.name)).toEqual(MANUAL_NAMES);
    for (const item of manual) item.assignee = an;
    expect(isValidState(state)).toBe(true);
    // 與 Example_Text 只差一處：超市／賣場沒有 Stop_Items，只寫「超市／賣場（採買）」（需求 14.10）
    expect(itineraryText(state).split('\n')).toEqual(exampleLinesWith([[
      '第三車・採買組｜09:00 出發：出發地點 C → 超市／賣場（採買：五花肉片、鮮蝦、高麗菜、運動飲料、洋芋片、瓦斯、衛生紙、免洗餐具） → 夕淞度日營區',
      ['第三車・採買組｜09:00 出發：出發地點 C → 超市／賣場（採買） → 夕淞度日營區']
    ]]));
    // 需求 9.5：第 1 天只有這一則提醒，其他天仍沒有提醒；任何一天都沒有關於第一車採買的提醒（D30）
    expect(warningsOf(state)).toEqual([[DAY_1, ['第三車・採買組在超市／賣場的採買沒有品項']], [DAY_2, []], [DAY_3, []]]);
    // 需求 6.8、6.11(c)：小安的 Buyer_Car 是第一車，第一車沒有採買停靠點，八個品項都列在未分配採買清單
    expect(unassignedOf(state)).toEqual([...MANUAL_NAMES.map(name => [name, '第一車還沒有採買停靠點']), ...ingredientRows(state)]);
  });
});

describe('需求 14.10：途中任務的文字', () => {
  test('stopText() 依任務類型組合地點、備註與 Shopping_Summary', () => {
    // [任務類型, 備註, Shopping_Summary, 括號中的文字（detail）, 文字版的寫法（text）]
    const cases = [
      ['shop', '', '五花肉片、鮮蝦', '採買：五花肉片、鮮蝦', '休息站（採買：五花肉片、鮮蝦）'],
      // Shopping_Summary 為空字串時（例如不是 First_Shopping_Stop 的採買停靠點）只寫任務類型
      ['shop', '', '', '採買', '休息站（採買）'],
      // 採買停靠點的備註不輸出
      ['shop', '記得帶購物袋', '', '採買', '休息站（採買）'],
      ['shop', '記得帶購物袋', '鮮蝦', '採買：鮮蝦', '休息站（採買：鮮蝦）'],
      ['pickup', '接朋友', '', '接送：接朋友', '休息站（接送：接朋友）'],
      ['pickup', '', '', '接送', '休息站（接送）'],
      ['gear', '還帳篷', '', '取還裝備：還帳篷', '休息站（取還裝備：還帳篷）'],
      ['gear', '', '', '取還裝備', '休息站（取還裝備）'],
      // 其他：括號中只寫備註；備註為空字串時只有地點
      ['other', '買咖啡', '', '買咖啡', '休息站（買咖啡）'],
      ['other', '', '', '', '休息站']
    ];
    expect(cases.map(([kind, note, summary]) => stopText({ place: '休息站', kind, note, summary })))
      .toEqual(cases.map(([, , , detail, text]) => ({ place: '休息站', detail, text })));
  });

  test('Example_Trip 第 3 天的路線依序經過每一種途中任務', () => {
    const state = exampleTrip();
    state.places.push({ id: 'pl-station', name: '轉運站' }, { id: 'pl-gear', name: '露營用品店' }, { id: 'pl-rest', name: '休息站' });
    const stops = {
      'rt-3-v1': [{ id: 'st-2', place: 'pl-station', kind: 'pickup', note: '接朋友' }, { id: 'st-3', place: 'pl-rest', kind: 'other', note: '買咖啡' }],
      'rt-3-v2': [{ id: 'st-4', place: 'pl-gear', kind: 'gear', note: '' }],
      // 第三車・採買組的 First_Shopping_Stop 是第 1 天的超市／賣場，這一站沒有 Stop_Items
      'rt-3-v3': [{ id: 'st-5', place: 'pl-shop', kind: 'shop' }],
      // 第四車的 First_Shopping_Stop：阿凱與小芸沒有負責買的品項；採買停靠點的備註不輸出
      'rt-3-v4': [
        { id: 'st-6', place: 'pl-gear', kind: 'gear', note: '還帳篷' }, { id: 'st-7', place: 'pl-station', kind: 'pickup', note: '' },
        { id: 'st-8', place: 'pl-rest', kind: 'other', note: '' }, { id: 'st-9', place: 'pl-shop', kind: 'shop', note: '記得帶購物袋' }
      ]
    };
    for (const route of state.routes) if (stops[route.id]) route.stops = stops[route.id];
    expect(isValidState(state)).toBe(true);
    expect(itineraryText(state).split('\n')).toEqual(exampleLinesWith([
      ['第一車｜12:00 出發：夕淞度日營區 → 台北', ['第一車｜12:00 出發：夕淞度日營區 → 轉運站（接送：接朋友） → 休息站（買咖啡） → 台北']],
      ['第二車｜12:00 出發：夕淞度日營區 → 台北', ['第二車｜12:00 出發：夕淞度日營區 → 露營用品店（取還裝備） → 台北']],
      ['第三車・採買組｜12:00 出發：夕淞度日營區 → 台北', ['第三車・採買組｜12:00 出發：夕淞度日營區 → 超市／賣場（採買） → 台北']],
      ['第四車｜12:00 出發：夕淞度日營區 → 台北', ['第四車｜12:00 出發：夕淞度日營區 → 露營用品店（取還裝備：還帳篷） → 轉運站（接送） → 休息站 → 超市／賣場（採買） → 台北']]
    ]));
  });
});

describe('需求 14.19：固定字元的碼位', () => {
  // 固定字元以碼位寫出，與外觀相同的字元（例如 U+007C、U+00B7、U+2027、U+0028）區分；使用者文字照原樣寫出。
  // 半形空白、「/」與「:」的碼位由下一個測試以 \u0020、\u002F 與 \u003A 檢查。
  const BAR = '\uFF5C', DOT = '\u30FB', COLON = '\uFF1A', OPEN = '\uFF08', CLOSE = '\uFF09', COMMA = '\u3001';
  const ARROW = '\u0020\u2192\u0020';

  test('「｜」「・」「：」「（」「）」「、」與「 → 」在每一種行中的碼位', () => {
    const lines = itineraryText(exampleTrip()).split('\n');
    expect(lines[0]).toBe(`夕淞度日${BAR}三天兩夜`);
    expect(lines).toContain(`車輛${COLON}第一車${COMMA}第二車${COMMA}第三車・採買組${COMMA}第四車`);
    expect(lines).toContain(`第 1 天${DOT}10/20${OPEN}週二${CLOSE}${BAR}向山裡出發`);
    expect(lines).toContain(`地點${COLON}夕淞度日營區`);
    expect(lines).toContain(`第一車${BAR}08:00 出發${COLON}出發地點 A${ARROW}夕淞度日營區`);
    expect(lines).toContain(
      `第三車・採買組${BAR}09:00 出發${COLON}出發地點 C${ARROW}超市／賣場${OPEN}採買${COLON}${MANUAL_NAMES.join(COMMA)}${CLOSE}${ARROW}夕淞度日營區`
    );
    expect(lines).toContain(`預計 12:00 抵達${DOT}四車會合`);
    expect(lines).toContain(`13:00 搭帳・營地佈置${OPEN}搭帳${CLOSE}`);
    expect(lines).toContain(`18:00 晚餐${COLON}烤肉派對${OPEN}烤肉${CLOSE}`);
    expect(lines).toContain(`培根${COMMA}炒蛋${COMMA}吐司${COMMA}咖啡`);
    expect(lines.at(-1)).toBe(`平安返回台北${DOT}不預估返抵時間`);
  });

  test('日期的「/」、時間的「:」與固定位置的空格都是半形字元，時間都是補零的 24 小時制 HH:MM', () => {
    const text = itineraryText(exampleTrip());
    const lines = text.split('\n');
    const count = pattern => lines.filter(line => pattern.test(line)).length;
    // 每一天的第一行：「第 {N} 天」中的兩個空格為 U+0020，日期的「/」為 U+002F
    expect(count(/^第\u0020[1-9]\d*\u0020天\u30FB[1-9]\d?\u002F[1-9]\d?\uFF08週[一二三四五六日]\uFF09/u)).toBe(3);
    // 8 條路線行的「{HH:MM} 出發」、到達行的「預計 {Arrival_Time} 抵達」與 15 個項目行時間之後的空格
    expect(count(/\uFF5C(?:[01]\d|2[0-3])\u003A[0-5]\d\u0020出發\uFF1A/u)).toBe(8);
    expect(count(/^預計\u0020(?:[01]\d|2[0-3])\u003A[0-5]\d\u0020抵達\u30FB/u)).toBe(1);
    expect(count(/^(?:[01]\d|2[0-3])\u003A[0-5]\d\u0020\S/u)).toBe(15);
    // 文字中的每個時間（含全形數字與冒號的寫法）都是以 U+003A 分隔、補零的 HH:MM
    const times = text.match(/\p{Nd}+[:\uFF1A\uFE55\u2236]\p{Nd}+/gu);
    expect(times).toHaveLength(24);
    for (const time of times) expect(time).toMatch(/^(?:[01]\d|2[0-3])\u003A[0-5]\d$/u);
  });

  test('「→」為 U+2192，前後各一個半形空白；除了半形空白與換行字元，沒有其他空白字元', () => {
    const text = itineraryText(exampleTrip());
    // 第 1 天 5 個、第 3 天 4 個箭頭，每一個都在「 → 」之中
    expect(occurrences(text, '\u2192')).toBe(9);
    expect(occurrences(text, ARROW)).toBe(9);
    // 沒有連續兩個半形空白，所以箭頭前後都恰好一個
    expect(text).not.toMatch(/\u0020\u0020/u);
    // 沒有 U+3000、U+00A0、Tab、CR 等其他空白字元
    expect(text).not.toMatch(/[^\S\u0020\u000A]/u);
  });
});

describe('需求 19.10：舊出發行', () => {
  test('seed() 的山線小巴與海風號只在第 1 天，寫出舊出發時間與地點，沒有到達行', () => {
    const days = dayParagraphs(itineraryText(seed()));
    expect(days).toHaveLength(3);
    expect(routeBlocksOf(days[0])).toEqual([['山線小巴｜14:00 出發：台北車站東三門', '海風號｜14:00 出發：台北車站東三門']]);
    for (const day of days.slice(1)) {
      expect(routeBlocksOf(day)).toEqual([]);
      expect(day.join('\n')).not.toContain('台北車站東三門');
    }
  });

  test('沒有舊出發時間時寫「出發時間待定」，沒有舊出發地點時寫「出發地點待定」', () => {
    const state = seed();
    state.vehicles[0].meeting = '早上八點在家門口';
    state.vehicles[1].meeting = '00:00';
    expect(isValidState(state)).toBe(true);
    // 依舊出發時間排序，沒有時間的排在最後（需求 19.4）
    expect(routeBlocksOf(dayParagraphs(itineraryText(state))[0])).toEqual([[
      '海風號｜00:00 出發：出發地點待定',
      '山線小巴｜出發時間待定：早上八點在家門口'
    ]]);
    // 行程圖使用的片段：沒有地點時 start.place 為空字串（不產生地圖連結），舊出發行沒有途中任務與終點
    const [block] = dayModel(state, '2026-11-20').blocks.filter(entry => entry.type === 'routes');
    expect(block.lines.map(routeLineText)).toEqual([
      {
        car: '海風號', departure: '00:00 出發', start: { place: '', detail: '', text: '出發地點待定' }, stops: [], end: null,
        text: '海風號｜00:00 出發：出發地點待定'
      },
      {
        car: '山線小巴', departure: '出發時間待定', start: { place: '早上八點在家門口', detail: '', text: '早上八點在家門口' }, stops: [],
        end: null, text: '山線小巴｜出發時間待定：早上八點在家門口'
      }
    ]);
  });

  test('無法拆出時間的文字整段作為舊出發地點，其中的換行改為一個半形空白（需求 14.16、19.7）', () => {
    const state = seed();
    state.vehicles[0].meeting = '早上八點\n在家門口';
    state.vehicles[1].meeting = '9:00 台北車站';
    expect(isValidState(state)).toBe(true);
    // 兩台車都沒有舊出發時間，依車輛順序排列
    expect(routeBlocksOf(dayParagraphs(itineraryText(state))[0])).toEqual([[
      '山線小巴｜出發時間待定：早上八點 在家門口',
      '海風號｜出發時間待定：9:00 台北車站'
    ]]);
  });

  test('Example_Trip 第四車改用只有時間的舊出發資料：與路線行一起排序，不寫終點，也不計入會合車數', () => {
    const state = exampleTrip();
    state.routes = state.routes.filter(route => route.id !== 'rt-1-v4');
    state.vehicles[3].meeting = '09:30';
    expect(isValidState(state)).toBe(true);
    expect(itineraryText(state).split('\n')).toEqual(exampleLinesWith([
      ['第四車｜09:30 出發：出發地點 D → 夕淞度日營區', ['第四車｜09:30 出發：出發地點待定']],
      ['預計 12:00 抵達・四車會合', ['預計 12:00 抵達・三車會合']]
    ]));
    // 需求 9.1：只有舊的出發資料的車，這一天也還沒有路線
    expect(warningsOf(state)).toEqual([[DAY_1, ['第四車這一天還沒有路線']], [DAY_2, []], [DAY_3, []]]);
  });
});
