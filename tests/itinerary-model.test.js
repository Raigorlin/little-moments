// trip-planning-workflow-enhance：資料規則的範例測試（src/itinerary-model.js）
// 需求 7.9 與 18.2：13 個 Activity_Category 與標籤；需求 7.2：四種日子的常用活動（含一日遊）；
// 需求 8.2、8.5、8.6：前言 Example_Trip 的 Meal_Time、Meal_Moment 標題與 Meal_Label；
// 需求 2.1(c) 與 18.4：hasControlChars() 與旅伴名字（addParticipant()）對同一組字串的判斷相同；
// 需求 2.9、2.10：destinationConflict() 的三種結果。
import { describe, expect, test } from 'bun:test';

import {
  ACTIVITY_CATEGORIES, ACTIVITY_TYPES, DESTINATION_REF, categoryLabel, destinationConflict,
  hasControlChars, mealLabel, mealTime, mealTitle, presetsFor
} from '../src/itinerary-model.js';
import { addParticipant, emptyState, normalizeParticipantName, seed } from '../src/model.js';
import { EXAMPLE_TEXT, exampleTrip } from './fixtures/example-trip.js';

const EXAMPLE_LINES = EXAMPLE_TEXT.split('\n');
const DAY_1 = '2026-10-20', DAY_3 = '2026-10-22';

// ---- 活動類別 ----
// 前言「活動類別」表，依表的順序：[類別（文字版標籤）, 存在 activities[].type 的值]。
// 前六個沿用 Legacy_Activity_Type，後七個是本功能新增的值（需求 18.2）。
const CATEGORY_TABLE = [
  ['集合', 'meet'], ['採買', 'market'], ['營地時光', 'camp'], ['用餐', 'meal'], ['夜晚', 'night'], ['移動', 'travel'],
  ['起床', 'wake'], ['搭帳', 'pitch'], ['自由活動', 'free'], ['下午茶／遊戲', 'tea'], ['拆帳', 'strike'], ['清潔', 'clean'],
  ['返程', 'return']
];

describe('活動類別', () => {
  test('依前言「活動類別」表的順序列出 13 個類別與標籤', () => {
    expect(ACTIVITY_CATEGORIES.map(({ type, label }) => [label, type])).toEqual(CATEGORY_TABLE);
    expect(ACTIVITY_TYPES).toEqual(CATEGORY_TABLE.map(([, type]) => type));
    // 類別名稱與儲存的值都不重複，一個名稱只對應一個值
    expect(new Set(ACTIVITY_CATEGORIES.map(({ label }) => label)).size).toBe(13);
    expect(new Set(ACTIVITY_TYPES).size).toBe(13);
  });

  test('categoryLabel() 以表中的類別名稱顯示每種類型，Legacy_Activity_Type 也改用這些名稱', () => {
    expect(CATEGORY_TABLE.map(([, type]) => categoryLabel(type))).toEqual(CATEGORY_TABLE.map(([label]) => label));
    // 需求 7.9：meet、market、camp、meal、night、travel 依序顯示為集合、採買、營地時光、用餐、夜晚、移動
    expect(['meet', 'market', 'camp', 'meal', 'night', 'travel'].map(type => categoryLabel(type)))
      .toEqual(['集合', '採買', '營地時光', '用餐', '夜晚', '移動']);
    // 不在表中的類型只會出現在無效的 Trip_State，沒有標籤
    for (const type of ['', 'party', 'Wake', '起床', 'toString', undefined]) expect(categoryLabel(type)).toBe('');
  });

  test('Example_Trip 的活動以類別名稱出現在 Example_Text', () => {
    for (const activity of exampleTrip().activities) {
      expect(EXAMPLE_LINES).toContain(`${activity.time} ${activity.title}（${categoryLabel(activity.type)}）`);
    }
  });
});

// ---- 常用活動 ----
// 前言「常用活動」表：[預設時間, 預設標題, 類別]
const FIRST_DAY = [['13:00', '搭帳・營地佈置', '搭帳'], ['20:00', '星空夜聊・自由活動', '夜晚']];
const MIDDLE_DAY = [
  ['08:00', '起床', '起床'], ['10:00', '自由活動、拍照', '自由活動'], ['14:00', '下午茶、聊天、玩遊戲', '下午茶／遊戲'],
  ['20:00', '自由活動', '夜晚']
];
const LAST_DAY = [['08:00', '起床', '起床'], ['10:00', '拆帳、整理裝備', '拆帳'], ['11:30', '環境清潔、裝車', '清潔'], ['12:00', '集合、返程', '返程']];
// presetsFor() 的每一列是 [type, time, title]；換成表的欄位，以類別名稱比較
const asTable = rows => rows.map(([type, time, title]) => [time, title, categoryLabel(type)]);

describe('常用活動', () => {
  test('First_Day、中間的日子與 Last_Day 各自的建議', () => {
    expect(asTable(presetsFor('first'))).toEqual(FIRST_DAY);
    expect(asTable(presetsFor('middle'))).toEqual(MIDDLE_DAY);
    expect(asTable(presetsFor('last'))).toEqual(LAST_DAY);
  });

  test('一日遊同時列出 First_Day 與 Last_Day 的項目，依預設時間由早到晚排列', () => {
    // 兩者的建議沒有相同的類別，所以六項都保留
    expect(asTable(presetsFor('single'))).toEqual([
      ['08:00', '起床', '起床'], ['10:00', '拆帳、整理裝備', '拆帳'], ['11:30', '環境清潔、裝車', '清潔'],
      ['12:00', '集合、返程', '返程'], ['13:00', '搭帳・營地佈置', '搭帳'], ['20:00', '星空夜聊・自由活動', '夜晚']
    ]);
  });

  test('每種日子的建議類別都不重複；其他日子種類沒有建議', () => {
    for (const kind of ['first', 'middle', 'last', 'single']) {
      const types = presetsFor(kind).map(([type]) => type);
      expect(new Set(types).size).toBe(types.length);
    }
    for (const kind of ['', 'other', 'toString', undefined]) expect(presetsFor(kind)).toEqual([]);
  });
});

// ---- 餐點 ----
// 料理菜單的一筆餐點；只有餐次、料理名稱、食材、imageKind 與 time 影響這三個函式
const meal = (slot, title, extra = {}) => ({ id: 'm', date: DAY_1, slot, title, cookId: '', servings: 4, ingredients: '', notes: '', ...extra });

describe('餐點的 Meal_Time、標題與 Meal_Label', () => {
  test('前言 Example_Trip 的五筆餐點', () => {
    const meals = exampleTrip().meals;
    expect(meals.map(item => [mealTime(item), mealTitle(item), mealLabel(item)])).toEqual([
      ['18:00', '晚餐：烤肉派對', '烤肉'],
      ['08:30', '早餐', '早餐'],
      ['12:00', '午餐', '午餐'],
      ['18:00', '晚餐：豪華火鍋', '火鍋'],
      ['08:30', '早餐', '早餐']
    ]);
    // 與 Example_Text 的餐點行「{Meal_Time} {標題}（{Meal_Label}）」相同
    for (const item of meals) expect(EXAMPLE_LINES).toContain(`${mealTime(item)} ${mealTitle(item)}（${mealLabel(item)}）`);
  });

  test('mealTime()：有自訂時間時用它，否則依餐次預設；舊餐次比照料理菜單的排序，其他舊餐次為 12:00', () => {
    const timeOf = (slot, extra) => mealTime(meal(slot, slot, extra));
    expect(['早餐', '午餐', '下午茶', '晚餐', '消夜'].map(slot => timeOf(slot))).toEqual(['08:30', '12:00', '15:00', '18:00', '21:00']);
    expect(['早', '午', '晚', '宵夜'].map(slot => timeOf(slot))).toEqual(['08:30', '12:00', '18:00', '21:00']);
    expect(['點心', '早午餐'].map(slot => timeOf(slot))).toEqual(['12:00', '12:00']);
    expect(timeOf('晚餐', { time: '19:30' })).toBe('19:30');
    expect(timeOf('點心', { time: '07:05' })).toBe('07:05');
  });

  test('mealTitle() 與 mealLabel()：舊資料的餐次照原文字顯示', () => {
    const lateSnack = meal('宵夜', '鹹酥雞');
    expect([mealTitle(lateSnack), mealLabel(lateSnack), mealTime(lateSnack)]).toEqual(['宵夜：鹹酥雞', '宵夜', '21:00']);
    const custom = meal('點心', '點心');
    expect([mealTitle(custom), mealLabel(custom), mealTime(custom)]).toEqual(['點心', '點心', '12:00']);
  });

  test('mealLabel()：套用料理範本時依範本的類型，否則依料理名稱與食材判斷', () => {
    expect(mealLabel(meal('晚餐', '週末小聚'))).toBe('晚餐'); // 通用餐盤
    expect(mealLabel(meal('晚餐', '週末小聚', { ingredients: '火鍋湯底、豬肉片' }))).toBe('火鍋');
    expect(mealLabel(meal('晚餐', '週末小聚', { imageKind: 'bbq' }))).toBe('烤肉');
    expect(mealLabel(meal('晚餐', '豪華火鍋', { imageKind: 'curry' }))).toBe('晚餐');
  });
});

// ---- 控制字元 ----
describe('hasControlChars() 與 addParticipant() 的控制字元判斷', () => {
  // addParticipant() 先做 NFKC、去除前後空白，並把每段 \s（含 LF、Tab 與 U+FEFF）換成一個空白，之後才檢查控制字元，
  // 例如 'a\nb' 檢查時已經是 'a b'。所以只比較這些處理不會改變的字串（下面第一個測試確認）。
  const CASES = [
    { label: '一般文字', name: '小安', control: false },
    { label: '半形空白', name: 'Camp 小隊', control: false },
    { label: 'emoji 與變體選擇符', name: '小安❤\uFE0F', control: false },
    { label: '連接兩個 emoji 的零寬連接符', name: '👨\u200D👩\u200D👧', control: false },
    { label: '變體選擇符之後的零寬連接符', name: '🏳\uFE0F\u200D🌈', control: false },
    { label: '膚色修飾符之後的零寬連接符', name: '👩🏽\u200D💻', control: false },
    { label: 'BEL（U+0007）', name: '小\u0007安', control: true },
    { label: 'NEL（U+0085，不是 JS 的 \\s）', name: '小\u0085安', control: true },
    { label: '零寬空白（U+200B）', name: '小\u200B安', control: true },
    { label: '軟連字號（U+00AD）', name: '小\u00AD安', control: true },
    { label: '左至右標記（U+200E）', name: '小\u200E安', control: true },
    { label: '右至左覆寫（U+202E）', name: '小\u202E安', control: true },
    { label: '方向隔離（U+2066、U+2069）', name: '\u2066小安\u2069', control: true },
    { label: '字連接符（U+2060）', name: '小\u2060安', control: true },
    { label: '文字之間的零寬連接符', name: '小\u200D安', control: true },
    { label: '零寬連接符後面不是 emoji', name: '👨\u200D安', control: true },
    { label: '零寬連接符前面不是 emoji', name: '安\u200D👩', control: true },
    { label: '兩個連續的零寬連接符', name: '👨\u200D\u200D👩', control: true },
    { label: '結尾的零寬連接符', name: '👨\u200D', control: true },
    { label: '標籤字元（英格蘭旗）', name: '🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}', control: true }
  ];
  const CONTROL_ERROR = '名字不能包含隱藏控制字元。';
  // addParticipant() 是否因控制字元拒絕；其他錯誤（空白、太長、同名）表示測試字串選錯了，讓測試直接失敗
  function participantRejects(name) {
    try {
      addParticipant(emptyState(), name);
      return false;
    } catch (error) {
      if (error.message === CONTROL_ERROR) return true;
      throw error;
    }
  }

  test('addParticipant() 的正規化不改變這組字串', () => {
    expect(CASES.filter(({ name }) => normalizeParticipantName(name) !== name).map(({ label }) => label)).toEqual([]);
  });

  test('兩者對每個字串的判斷相同，且只有連接兩個 emoji 的零寬連接符不算控制字元', () => {
    const verdicts = CASES.map(({ label, name }) => ({ label, model: hasControlChars(name), participant: participantRejects(name) }));
    expect(verdicts.filter(({ model, participant }) => model !== participant)).toEqual([]);
    expect(verdicts.map(({ label, model }) => [label, model])).toEqual(CASES.map(({ label, control }) => [label, control]));
  });
});

// ---- 旅行目的地的檢查 ----
describe('destinationConflict()', () => {
  const withRoutes = (state, routes) => ({ ...state, routes });

  test('與地點同名時為 duplicate，name 是地點清單中的名稱', () => {
    const state = exampleTrip();
    const before = structuredClone(state);
    expect(destinationConflict(state, '台北')).toEqual({ type: 'duplicate', name: '台北' });
    // 需求 2.1(d)：去除前後空白，全形與半形視為相同（「／」與「/」、全形空白與半形空白），並忽略英文大小寫
    expect(destinationConflict(state, '超市/賣場')).toEqual({ type: 'duplicate', name: '超市／賣場' });
    expect(destinationConflict(state, '　出發地點　ａ ')).toEqual({ type: 'duplicate', name: '出發地點 A' });
    expect(state).toEqual(before);
  });

  test('改成空白而仍有路線的起點、終點或停靠點使用旅行目的地時為 in-use', () => {
    const state = exampleTrip();
    expect(destinationConflict(state, '')).toEqual({ type: 'in-use' });
    expect(destinationConflict(state, ' \u3000')).toEqual({ type: 'in-use' }); // 只有空白也是空白
    const toDestination = state.routes.filter(route => route.date === DAY_1); // 第 1 天：終點是旅行目的地
    const fromDestination = state.routes.filter(route => route.date === DAY_3); // 第 3 天：起點是旅行目的地
    const stopAtDestination = [{
      id: 'rt-x', date: DAY_1, vehicleId: 'v1', from: 'pl-a', to: 'pl-taipei', time: '',
      stops: [{ id: 'st-x', place: DESTINATION_REF, kind: 'gear' }]
    }];
    for (const routes of [toDestination, fromDestination, stopAtDestination]) {
      expect(destinationConflict(withRoutes(state, routes), '')).toEqual({ type: 'in-use' });
    }
  });

  test('其他情況為 null', () => {
    const state = exampleTrip();
    expect(destinationConflict(state, '夕淞度日營區')).toBeNull(); // 目的地不變
    expect(destinationConflict(state, '山中營地')).toBeNull();
    // 路線與停靠點只用地點清單中的地點；Day_Location 未設定的日子跟著旅行目的地，不在檢查範圍
    const placesOnly = [{
      id: 'rt-x', date: DAY_1, vehicleId: 'v3', from: 'pl-c', to: 'pl-taipei', time: '09:00',
      stops: [{ id: 'st-x', place: 'pl-shop', kind: 'shop' }]
    }];
    expect(destinationConflict(withRoutes(state, placesOnly), '')).toBeNull();
    expect(destinationConflict(withRoutes(state, []), '')).toBeNull();
    // 本功能之前的資料沒有地點清單與路線
    for (const legacy of [seed(), emptyState()]) {
      expect(destinationConflict(legacy, '')).toBeNull();
      expect(destinationConflict(legacy, '山中營地')).toBeNull();
    }
  });
});
