// 測試用：trip-planning-workflow-enhance 屬性測試共用的 fast-check 產生器。
//
//   itineraryState(options) → Trip_State（需求 23.3 與設計「Testing Strategy」的值域）
//   legacyState()           → seed() 或 emptyState() 加上只用舊欄位的隨機修改（需求 23.4 第一部分）
//   faultState(kind)        → { state, base, fault }：base 通過驗證；state 是 base 只加入 fault 這一種錯誤（需求 23.4）
//   FAULT_KINDS、FAULT_TEXT → faultState() 的錯誤名稱與說明
//   markupText(limit)       → XSS 與標記文字（Property 20）
//   blockShape()            → 與 dayModel() 路線區塊相同形狀的物件（Property 18）
//   endMixState()           → { state, date, kind, refs, pattern }（Property 22、23）
//
// 隨機值一律由 fast-check 產生（fc.gen()），可以重現與縮小；不使用 Math.random()、目前時間或 crypto。
// 產生器不呼叫 isValidState()，產生的資料是否有效由 Property 1 與 Property 3 驗證。
// 縮小時數值往 0 靠近：選項表的第一個值最簡單，機率型的特徵（chance）縮小後關閉。
import fc from 'fast-check';
import { COLORS, dateRange, emptyState, seed } from '../../src/model.js';
import { SHOPPING_CATEGORIES } from '../../src/ingredients.js';
import { DISH_TYPES } from '../../src/recipes.js';
import { MEAL_SLOTS } from '../../src/meal-order.js';
import { parseVehicleMeeting } from '../../src/vehicle-departures.js';
import {
  ACTIVITY_TYPES, DESTINATION_REF, LIMITS, STOP_KINDS, chineseNumeral, mealTime, mealTitle, placeKey, trimWhite
} from '../../src/itinerary-model.js';

// ---- 小工具 ----
// 所有整數都由同一個 fc.integer() 依比例換算到 min 至 max：fc.gen() 依參數快取 arbitrary，參數固定時查詢最快。
// 換算是單調的，所以縮小時往 min 靠近，fast-check 偏向兩端的取值也對應到範圍的兩端。
const UNIT = Object.freeze({ min: 0, max: 2 ** 31 - 1 });
const int = (g, min, max) => (max <= min ? min : min + Math.min(max - min, Math.floor((g(fc.integer, UNIT) / 2 ** 31) * (max - min + 1))));
/** percent% 的機率為 true；縮小時變成 false。 */
const chance = (g, percent) => int(g, 0, 99) >= 100 - percent;
const pick = (g, list) => list[int(g, 0, list.length - 1)];
function shuffle(g, list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(g, 0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
/** 隨機順序、min 到 max 個不重複的項目。 */
const sample = (g, list, min = 0, max = list.length) =>
  shuffle(g, list).slice(0, int(g, Math.min(min, list.length), Math.min(max, list.length)));
const count = text => [...text].length;
const cut = (text, limit) => [...text].slice(0, Math.max(0, limit)).join('');
const pad2 = n => String(n).padStart(2, '0');
const range = n => Array.from({ length: n }, (_, i) => i);
const DAY_MS = 86400000;
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
const tag = (word, index) => `${word}〔${index}〕`;

// ---- 文字片段 ----
// INNER 不含 Cc／Cf 字元，地點名稱也可以用（emoji 之間的零寬連接符是允許的例外）。
const INNER = Object.freeze([
  '', 'A', 'abc', 'Ａ', '１２', 'é', 'e\u0301', '🏕️', '👨‍👩‍👧', '&', '<b>', '"', "'", '`',
  '・', '｜', '：', ' → ', '（', '）', '、', '／', ' ', '\u3000', '\u2028', 'ﾊﾟ', '①', '營火', 'Camp'
]);
// 只用在地點名稱以外的文字：換行、Tab 與其他控制字元（cleanText() 會把含換行的空白換成一個空白）。
const FREE = Object.freeze(['\n', '\r\n', '\t', '\n\n', '\u0085', '\u200B']);
// 前後的空白（都是 White_Space，trimWhite() 會去除）。
const PAD = Object.freeze(['', ' ', '\u3000', '\n', '\t', '\r\n', '\u00A0', '\u2028', '\u0085']);
const FILLERS = Object.freeze(['字', '🌲', 'ab', '一 ', 'é']);
// 地點名稱用的填充字：不含空白，所以去除前後空白後字數不變。
const NAME_FILLERS = Object.freeze(['字', '🌲', 'ab', 'é']);
const WORDS = Object.freeze(['營地草坪', '帶水和輕便外套', 'A&B', '<b>粗體</b>', 'javascript:alert(1)', 'https://example.com/', '第一行\n第二行', '  ', '']);
const TITLES = Object.freeze(['夕淞度日', '我的露營旅行', '  山與海  ', 'A&B <b>', '一起\n出發', '🏕️', '\u0085', '一'.repeat(100)]);
const DESCRIPTION_LINES = Object.freeze(['一起，把日子過慢一點。', '  把喜歡的小地方，畫進我們的旅程。  ', '', '   ', 'A&B <b>', '\u3000', '第二段']);
const LINE_BREAKS = Object.freeze(['\n', '\r\n', '\r', '\u2028', '\u2029', '\u0085', '\u000B', '\u000C']);
const NOTES = Object.freeze(['', '山上早晚溫差大，記得帶保暖外套。', 'A&B', '<b>x</b>']);
const ROLES = Object.freeze(['這趟的召集人', '料理小隊長', '', 'A&B']);
const DAY_TITLES = Object.freeze(['向山裡出發', '住進慢慢的日子', '  ', '', 'A&B <b>', '一\n二', '\u3000慢慢\u3000']);
const LOCATIONS = Object.freeze(['營地草坪', '台北車站東三門', 'javascript:alert(1)', 'https://example.com/', 'A&B', '<b>x</b>', '  ']);
const COMMON_TIMES = Object.freeze(['08:00', '08:30', '12:00', '15:00', '18:00', '21:00', '00:00', '23:59', '09:00', '13:00', '20:00']);
// 「早」「午」「晚」「宵夜」是舊資料的餐次；「早午餐」「點心時間」是自訂餐次；前後空白的寫法仍依同一個餐次排序。
const SLOTS = Object.freeze([...MEAL_SLOTS, '早', '午', '晚', '宵夜', '早午餐', '點心時間', ' 晚餐 ', '\u3000早']);
const DISH_WORDS = Object.freeze(['', '火鍋', '烤肉', '壽喜燒', '吐司', '咖哩', '沙拉', '貝果早餐', '義大利麵']);
const DISH_IDS = Object.freeze(DISH_TYPES.map(([id]) => id));
const INGREDIENTS = Object.freeze(['培根', '炒蛋', '吐司', '咖啡', '牛肉片', '壽喜燒醬', '烤肉醬', ' 高麗菜 ', 'A&B', '<b>', '1.5 kg 雞腿', '雞腿, 雞翅']);
const INGREDIENT_SEPARATORS = Object.freeze(['、', '，', '/', ';', '\n', ', ', '。']);
const SHOPPING_NAMES = Object.freeze(['牛肉片', ' 牛肉片 ', '高麗菜', '', ' ', '冰塊', 'A&B', '<b>醬</b>', '甜椒、玉米', '牛肉片\n', '🧊']);
const QUANTITIES = Object.freeze(['1 包', '2 盒', '數量待確認', '', '12 L']);
const GEAR_NAMES = Object.freeze(['睡袋', '天幕', '營燈']);
const MEETING_SEPARATORS = Object.freeze([' · ', ' ・ ', '|', ' | ', '｜', ' ｜ ', '·', '・ ']);
const MEETING_PLACES = Object.freeze(['', '台北車站東三門', '台中高鐵站', '  家門口  ', 'A&B', '<b>']);
// 無法分出時間的舊出發資料（需求 19.7(b)）；不以 U+0085 或 U+FEFF 開頭或結尾（JavaScript trim() 與 trimWhite() 對這兩個字元不同）。
const FREE_MEETINGS = Object.freeze(['早上八點在家門口', '9:00 台北車站', '14:00 台北車站', '24:00 · 車站', '台北車站 · 東三門', '家門口\n巷口', '<b>x</b> & "y"', '08:00台北']);
const STOP_KIND_KEYS = Object.freeze(STOP_KINDS.map(entry => entry.kind));
const LEGACY_TYPES = Object.freeze(['meet', 'market', 'camp', 'meal', 'night', 'travel']);

/** XSS_Payload_Set（security-hardening 詞彙表，逐字）與需求 22.2、22.3、設計「Testing Strategy」列出的標記文字。 */
export const MARKUP_PAYLOADS = Object.freeze([
  '<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "'><svg onload=alert(1)>",
  'javascript:alert(1)', '`${alert(1)}`', '</textarea><script>alert(1)</script>',
  ']]><img src=x onerror=alert(1)>', 'red;background:url(https://example.com/x.png)', 'A&B', '<b>',
  'https://example.com/', '&amp;&lt;b&gt;', '&#39;&quot;&#96;', '"\'`'
]);
const markerArb = fc.integer({ min: 0, max: 36 ** 6 - 1 }).map(n => `mk${n.toString(36).padStart(6, '0')}`);
const payloadArb = fc.constantFrom(...MARKUP_PAYLOADS);

/**
 * 使用者文字的標記版本（Property 20）：MARKUP_PAYLOADS 之一，或以標記碼開頭（`mk` 加 6 個小寫英數字）、
 * 接著一到兩段 MARKUP_PAYLOADS 的文字。依碼位數截斷成最多 limit 個字（需求 22.2），標記碼在最前面，
 * 所以 limit 至少 8 時一定保留。標記碼只含英數字，跳脫後不變，測試可以用它找出使用者文字出現在 HTML 的哪裡。
 * @param {number} [limit]
 * @returns {fc.Arbitrary<string>}
 */
export function markupText(limit = Number.MAX_SAFE_INTEGER) {
  return fc.oneof(
    payloadArb,
    fc.tuple(markerArb, payloadArb).map(([marker, payload]) => `${marker}${payload}`),
    fc.tuple(markerArb, payloadArb, payloadArb).map(([marker, a, b]) => `${marker}${a}${b}`)
  ).map(text => cut(text, limit));
}

// ---- 文字 ----
function pieces(g, max, free) {
  let text = '';
  for (let i = int(g, 0, max); i > 0; i--) text += free && chance(g, 25) ? pick(g, FREE) : pick(g, INNER);
  return text;
}
/** 帶唯一標記（例如「車〔3〕」）的名稱，最多 limit 個字；地點名稱另外加上前後空白，且不含控制字元。 */
function nameWith(g, ctx, label, limit, { place = false } = {}) {
  let core;
  if (ctx.markup) core = `${cut(g(markupText, limit), limit - count(label))}${label}`;
  else if (place && chance(g, 10)) core = `${label}${cut(pick(g, NAME_FILLERS).repeat(limit), limit - count(label))}`; // 剛好 limit 個字
  else {
    core = `${pieces(g, 2, !place)}${label}${pieces(g, 2, !place)}`;
    if (count(core) > limit) core = label;
  }
  return place ? `${pick(g, PAD)}${core}${pick(g, PAD)}` : core;
}
function freeText(g, ctx, limit, pool = WORDS) {
  if (ctx.markup) return g(markupText, limit);
  return cut(`${pieces(g, 2, true)}${pick(g, pool)}${pieces(g, 2, true)}`, limit);
}
/** 剛好 n 個碼位的文字（含 emoji 與結尾空白，驗證以原始值計算字數）。 */
const exactText = (g, n) => cut(pick(g, FILLERS).repeat(n), n);
const anyTime = g => (chance(g, 50) ? pick(g, COMMON_TIMES) : `${pad2(int(g, 0, 23))}:${pad2(int(g, 0, 59))}`);

/**
 * 與 name 依需求 2.1(d) 同名的寫法：前後加空白、ASCII 字元換成全形、半形空白換成全形空白，以及
 * 後面沒有組合字元的英文字母換大小寫。placeKey() 不相同時（不應發生）改用原名加上前後空白。
 */
function sameNameVariant(g, name) {
  const list = [...trimWhite(name)];
  const out = list.map((char, i) => {
    let c = char;
    if (/^[A-Za-z]$/.test(c) && !/^\p{M}/u.test(list[i + 1] ?? '') && chance(g, 50)) c = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
    if (c >= '!' && c <= '~' && chance(g, 50)) c = String.fromCodePoint(c.codePointAt(0) + 0xFEE0);
    else if (c === ' ' && chance(g, 50)) c = '\u3000';
    return c;
  });
  const variant = `${pick(g, PAD)}${out.join('')}${pick(g, PAD)}`;
  return placeKey(variant) === placeKey(name) ? variant : `${pick(g, PAD)}${trimWhite(name)}${pick(g, PAD)}`;
}

// ---- 識別碼 ----
const ID_TAILS = Object.freeze(['x', 'ü', '雲', 'a b', '🏕️', '00000000-0000-4000-8000-000000000000']);
/** 同一個 prefix 與 index 只產生一次，所以識別碼不重複；地點的識別碼不會等於 '@destination'。 */
function makeId(g, ctx, prefix, index) {
  if (ctx.markup) return `${g(markupText, 40)}#${prefix}${index}`;
  return chance(g, 20) ? `${prefix}-${index}-${pick(g, ID_TAILS)}` : `${prefix}${index}`;
}
const newCtx = markup => ({ markup, routes: 0, stops: 0, activities: 0, meals: 0, people: 0, vehicles: 0 });

// ---- 旅行、旅伴、車輛、地點 ----
const BASE_DAY = Date.UTC(2020, 0, 1);
const MIN_DAY = Date.parse('0000-01-01T00:00:00Z');
const MAX_DAY = Date.parse('9999-12-01T00:00:00Z');
/** 1 到 31 天；多數在 2020 到 2035 年，少數在 0000 到 9999 年之間（星期計算的邊界）。 */
function tripDates(g) {
  const days = chance(g, 15) ? pick(g, [1, 31]) : int(g, 1, 31);
  const start = chance(g, 10)
    ? MIN_DAY + int(g, 0, Math.floor((MAX_DAY - MIN_DAY) / DAY_MS)) * DAY_MS
    : BASE_DAY + int(g, 0, 365 * 16) * DAY_MS;
  return { startDate: isoDay(start), endDate: isoDay(start + (days - 1) * DAY_MS) };
}
function description(g, ctx) {
  let text = '';
  for (let i = 0, n = int(g, 0, 4); i < n; i++) text += (i ? pick(g, LINE_BREAKS) : '') + (ctx.markup ? g(markupText, 100) : pick(g, DESCRIPTION_LINES));
  return text;
}
const blankDestination = g => pick(g, ['', ' ', '\u3000', '\n']);
/** destination：'blank'、'set' 或 'any'。 */
function tripFields(g, ctx, destination = 'any') {
  const { startDate, endDate } = tripDates(g);
  const set = destination === 'set' || (destination === 'any' && chance(g, 75));
  return {
    title: ctx.markup ? g(markupText, 100) : pick(g, TITLES),
    destination: set ? nameWith(g, ctx, tag('營區', 0), 100) : blankDestination(g),
    startDate, endDate,
    description: description(g, ctx),
    note: ctx.markup ? g(markupText, 200) : pick(g, NOTES)
  };
}
function makePeople(g, ctx, n = int(g, 1, chance(g, 10) ? 12 : 6)) {
  return range(n).map(() => {
    const index = ctx.people++;
    return {
      id: makeId(g, ctx, 'p', index),
      name: nameWith(g, ctx, tag('旅伴', index), 30),
      color: pick(g, COLORS),
      role: ctx.markup ? g(markupText, 60) : pick(g, ROLES)
    };
  });
}
/** 「HH:MM · 地點」（含其他分隔符號）、只有時間、無法分出時間的自由文字，以及空白（需求 19.7）。 */
function meetingText(g, ctx, kind = int(g, 0, 3)) {
  if (kind === 0) return pick(g, ['', '  ', '\u3000']);
  if (kind === 1) return `${anyTime(g)}${pick(g, MEETING_SEPARATORS)}${ctx.markup ? g(markupText, 100) : pick(g, MEETING_PLACES)}`;
  if (kind === 2) return `${anyTime(g)}${pick(g, ['', '  ', ' '])}`;
  return ctx.markup ? g(markupText, 150) : pick(g, FREE_MEETINGS);
}
/** 駕駛可以是待分配；同一位旅伴可以在多台車上；乘客不含駕駛，乘客加駕駛不超過座位數。 */
function makeVehicle(g, ctx, people, { meeting } = {}) {
  const index = ctx.vehicles++;
  const driver = chance(g, 25) ? '' : pick(g, people).id;
  const seats = int(g, 1, 9);
  const passengers = sample(g, people.map(p => p.id).filter(id => id !== driver), 0, seats - 1);
  return {
    id: makeId(g, ctx, 'v', index), name: nameWith(g, ctx, tag('車', index), 50), driver, seats, passengers,
    meeting: meeting ?? meetingText(g, ctx)
  };
}
/** mode：'normal'（0 到 12 個）或 'many'（13 到 100 個，一半剛好 100 個）。 */
function makePlaces(g, ctx, mode) {
  const n = mode === 'many' ? (chance(g, 50) ? LIMITS.places : int(g, 13, LIMITS.places)) : int(g, 0, 12);
  return range(n).map(i => ({ id: makeId(g, ctx, 'pl', i), name: nameWith(g, ctx, tag('地點', i), LIMITS.placeName, { place: true }) }));
}
const placeRefs = (places, destination) => [...places.map(p => p.id), ...(trimWhite(destination) ? [DESTINATION_REF] : [])];

// ---- 路線與途中任務 ----
function stopNote(g, ctx, kind) {
  // 採買 Stop 沒有備註欄位（需求 6.4）；資料仍可能帶著備註，文字版不輸出（需求 14.10）。
  if (kind === 'shop') return chance(g, 10) ? pick(g, ['', '這段不會顯示']) : undefined;
  const mode = int(g, 0, 3);
  if (mode === 0) return undefined;
  if (mode === 1) return pick(g, ['', '  ']);
  return mode === 2 ? freeText(g, ctx, LIMITS.stopNote) : exactText(g, LIMITS.stopNote);
}
function makeStops(g, ctx, refs, max = LIMITS.stops) {
  return range(chance(g, 15) ? max : int(g, 0, max)).map(() => {
    const kind = pick(g, STOP_KIND_KEYS);
    const stop = { id: makeId(g, ctx, 'st', ctx.stops++), place: pick(g, refs), kind };
    const note = stopNote(g, ctx, kind);
    if (note !== undefined) stop.note = note;
    return stop;
  });
}
/** time：undefined 時隨機；'' 表示沒有出發時間（省略或空字串）；其他為 HH:MM。 */
function makeRoute(g, ctx, { date, vehicleId, from, to, refs, time }) {
  const route = { id: makeId(g, ctx, 'rt', ctx.routes++), date, vehicleId, from, to };
  const mode = time === undefined ? int(g, 0, 3) : time === '' ? int(g, 0, 1) : 2;
  if (mode === 1) route.time = '';
  if (mode >= 2) route.time = time ?? anyTime(g);
  const stops = makeStops(g, ctx, refs);
  if (stops.length || chance(g, 70)) route.stops = stops;
  return route;
}
/** 每天隨機一部分車輛有路線（每台車每天最多一條），起點、終點與 Stop 隨機取自地點與 '@destination'。 */
function randomRoutes(g, ctx, { dates, vehicles, refs, skip = () => false }) {
  if (!refs.length) return [];
  const density = pick(g, [0, 30, 60, 100]);
  const routes = [];
  for (const date of dates) {
    for (const vehicle of vehicles) {
      if (skip(date, vehicle) || !chance(g, density)) continue;
      routes.push(makeRoute(g, ctx, { date, vehicleId: vehicle.id, from: pick(g, refs), to: pick(g, refs), refs }));
    }
  }
  return routes;
}

// ---- 每日設定 ----
function dayTitle(g, ctx) {
  if (ctx.markup) return g(markupText, LIMITS.dayTitle);
  return chance(g, 15) ? exactText(g, LIMITS.dayTitle) : pick(g, DAY_TITLES);
}
/** place：undefined 時隨機；null 表示不設定地點（省略或空字串）；其他為 Place 的識別碼。 */
function daySetting(g, ctx, date, places, place) {
  const setting = { date };
  const title = int(g, 0, 3);
  if (title === 1) setting.title = pick(g, ['', '  ']);
  if (title >= 2) setting.title = dayTitle(g, ctx);
  if (place === undefined) {
    const mode = int(g, 0, 3);
    if (mode === 1) setting.place = '';
    if (mode >= 2 && places.length) setting.place = pick(g, places).id;
  } else if (place === null) {
    if (chance(g, 30)) setting.place = '';
  } else setting.place = place;
  const arrival = int(g, 0, 3);
  if (arrival === 1) setting.arrival = '';
  if (arrival >= 2) setting.arrival = anyTime(g);
  return setting;
}
function randomDaySettings(g, ctx, { dates, places, skip = () => false }) {
  return dates.filter(date => !skip(date) && chance(g, 55)).map(date => daySetting(g, ctx, date, places));
}
/** Day_Location 的名稱：該天的 Place，未設定時為非空白的旅行目的地，否則為 null。 */
function dayLocationName(date, daySettings, places, destination) {
  const setting = daySettings.find(d => d.date === date);
  if (setting?.place) return places.find(p => p.id === setting.place)?.name ?? null;
  return trimWhite(destination) ? destination : null;
}

// ---- 活動、餐點、採買、裝備 ----
function activityLocation(g, ctx, dayName) {
  const mode = int(g, 0, 3);
  if (mode === 0) return '';
  if (mode === 3 && dayName) return sameNameVariant(g, dayName); // 與 Day_Location 同名，補充行不列出（需求 14.14）
  return freeText(g, ctx, LIMITS.activityLocation, LOCATIONS);
}
function activityNote(g, ctx) {
  const mode = int(g, 0, 9);
  if (mode < 5) return '';
  return mode === 9 ? exactText(g, LIMITS.activityNote) : freeText(g, ctx, LIMITS.activityNote, NOTES);
}
/** 三種參加方式：全體旅伴（people 為空）、指定車輛（vehicleIds）與舊的旅伴名單。 */
function makeActivity(g, ctx, { date, time, title, people, vehicles, dayName, types = ACTIVITY_TYPES }) {
  const index = ctx.activities++;
  const activity = {
    id: makeId(g, ctx, 'a', index), date, time: time ?? anyTime(g),
    title: title ?? nameWith(g, ctx, tag('活動', index), LIMITS.activityTitle),
    type: pick(g, types), location: activityLocation(g, ctx, dayName), note: activityNote(g, ctx), people: [], done: chance(g, 30)
  };
  const mode = int(g, 0, 2);
  if (mode === 1 && vehicles.length) activity.vehicleIds = sample(g, vehicles.map(v => v.id), 1);
  if (mode === 2) activity.people = sample(g, people.map(p => p.id), 1);
  return activity;
}
function randomActivities(g, ctx, { dates, people, vehicles, dayName }) {
  const activities = [];
  let blank = false;
  for (const date of dates) {
    for (let i = int(g, 0, 3); i > 0; i--) {
      // 最多一筆空白標題（文字版以類別代替標題，需求 14.13），其他標題都帶唯一標記。
      const title = !blank && chance(g, 5) ? pick(g, ['', '  ']) : undefined;
      if (title !== undefined) blank = true;
      activities.push(makeActivity(g, ctx, { date, title, people, vehicles, dayName: dayName(date) }));
    }
  }
  return activities;
}
function ingredients(g, ctx) {
  if (!chance(g, 60)) return '';
  if (ctx.markup) return g(markupText, 200);
  return sample(g, INGREDIENTS, 1, 5).map((name, i) => (i ? pick(g, INGREDIENT_SEPARATORS) : '') + name).join('');
}
const mealName = (g, ctx) => `${pick(g, DISH_WORDS)}${nameWith(g, ctx, tag('料理', ctx.meals++), LIMITS.activityTitle - 4)}`;
/** 料理名稱：帶標記的名稱、空白或與餐次相同（需求 8.5）。 */
function makeMeal(g, ctx, date, people) {
  const slot = pick(g, SLOTS);
  const mode = int(g, 0, 2);
  const meal = {
    id: makeId(g, ctx, 'm', ctx.meals), date, slot,
    title: mode === 0 ? mealName(g, ctx) : mode === 1 ? pick(g, ['', ' ']) : slot,
    cookId: chance(g, 60) ? pick(g, people).id : '',
    servings: int(g, 1, 100),
    ingredients: ingredients(g, ctx),
    notes: chance(g, 40) ? freeText(g, ctx, 200, NOTES) : ''
  };
  if (mode !== 0) ctx.meals++;
  if (chance(g, 30)) meal.imageKind = pick(g, DISH_IDS);
  if (chance(g, 50)) meal.time = anyTime(g);
  return meal;
}
function randomMeals(g, ctx, { dates, people }) {
  const meals = [];
  for (const date of dates) for (let i = int(g, 0, 3); i > 0; i--) meals.push(makeMeal(g, ctx, date, people));
  // 料理名稱彼此不同：mealTitle() 與前面的餐點相同時改用帶標記的名稱。
  const seen = new Set();
  for (const meal of meals) {
    if (seen.has(mealTitle(meal))) meal.title = mealName(g, ctx);
    seen.add(mealTitle(meal));
  }
  return meals;
}
/** 「誰負責買」為待分配、車上的旅伴（駕駛或乘客）或不在任何車上的旅伴。 */
function randomShopping(g, ctx, { people, vehicles, meals }) {
  const onCar = new Set(vehicles.flatMap(v => [v.driver, ...v.passengers]).filter(Boolean));
  const groups = [[], people.filter(p => onCar.has(p.id)), people.filter(p => !onCar.has(p.id))];
  return range(int(g, 0, 10)).map(i => {
    const choices = groups[int(g, 0, 2)];
    const item = {
      id: makeId(g, ctx, 's', i), name: ctx.markup ? g(markupText, 100) : pick(g, SHOPPING_NAMES), quantity: pick(g, QUANTITIES),
      category: pick(g, SHOPPING_CATEGORIES), assignee: choices.length ? pick(g, choices).id : '', done: chance(g, 30)
    };
    const source = int(g, 0, 2);
    if (source === 1) item.source = 'manual';
    if (source === 2) {
      item.source = 'meal';
      item.mealIds = sample(g, meals.map(m => m.id), 0, 3);
    }
    if (chance(g, 15)) item.recipeRemoved = chance(g, 50);
    return item;
  });
}
function randomGear(g, ctx, people) {
  return range(int(g, 0, 3)).map(i => {
    const shared = chance(g, 50);
    const assignee = chance(g, 50) ? pick(g, people).id : '';
    return {
      id: makeId(g, ctx, 'g', i), name: pick(g, GEAR_NAMES), quantity: '1 個', scope: shared ? 'shared' : 'personal', assignee,
      ready: shared ? (assignee && chance(g, 50) ? [assignee] : []) : sample(g, people.map(p => p.id))
    };
  });
}
/** 其他旅行欄位（旅伴以外的舊集合）與新欄位組成 Trip_State；空的新清單有時省略鍵（需求 18.1）。 */
function assemble(g, ctx, { trip, people, vehicles, places, routes, daySettings, activities, meals }) {
  const state = {
    schema: 1, revision: int(g, 0, 5000), currentUser: pick(g, people).id, joined: chance(g, 80), trip, people,
    activities: shuffle(g, activities), meals: shuffle(g, meals),
    shopping: randomShopping(g, ctx, { people, vehicles, meals }), gear: randomGear(g, ctx, people), vehicles,
    events: range(int(g, 0, 2)).map(i => ({ id: makeId(g, ctx, 'e', i), text: '建立了這本旅行手冊', at: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(), actor: pick(g, people).name })),
    departed: sample(g, people.map(p => p.id))
  };
  const optional = (key, list) => { if (list.length || chance(g, 60)) state[key] = list; };
  optional('places', places);
  optional('routes', shuffle(g, routes));
  optional('daySettings', shuffle(g, daySettings));
  return state;
}
/** 時間相同的 Activity 與 Meal_Moment：在某筆餐點的日期與 Meal_Time 加一筆活動。 */
function sameTimeActivity(g, ctx, { meals, people, vehicles, dayName }) {
  if (!meals.length || !chance(g, 40)) return [];
  const meal = pick(g, meals);
  return [makeActivity(g, ctx, { date: meal.date, time: mealTime(meal), people, vehicles, dayName: dayName(meal.date) })];
}

function buildItinerary(g, { places = 'mixed', markup = false } = {}) {
  const ctx = newCtx(markup);
  const trip = tripFields(g, ctx);
  const dates = dateRange(trip.startDate, trip.endDate);
  const people = makePeople(g, ctx);
  const vehicles = range(int(g, 0, 8)).map(() => makeVehicle(g, ctx, people));
  const placeList = makePlaces(g, ctx, places === 'mixed' ? (chance(g, 10) ? 'many' : 'normal') : places);
  const routes = randomRoutes(g, ctx, { dates, vehicles, refs: placeRefs(placeList, trip.destination) });
  const daySettings = randomDaySettings(g, ctx, { dates, places: placeList });
  const dayName = date => dayLocationName(date, daySettings, placeList, trip.destination);
  const meals = randomMeals(g, ctx, { dates, people });
  const activities = [
    ...randomActivities(g, ctx, { dates, people, vehicles, dayName }),
    ...sameTimeActivity(g, ctx, { meals, people, vehicles, dayName })
  ];
  return assemble(g, ctx, { trip, people, vehicles, places: placeList, routes, daySettings, activities, meals });
}

/**
 * Trip_State（Property 1 等）：1 到 31 天；1 到 12 位旅伴；0 到 8 台車（駕駛可以待分配、同一位旅伴可在多台車）；
 * 0 到 12 個地點，約一成是 13 到 100 個（一半剛好 100 個）；每天隨機一部分車輛有路線，起點、終點與 Stop 隨機取自
 * 地點與 '@destination'，所以同一個路線區塊常有多個終點組；0 到 6 個 Stop（四種任務類型、省略、空白、隨機與剛好
 * 100 字的備註）；有與沒有出發時間；舊出發資料使用 parseVehicleMeeting() 的四類文字；Day_Settings 隨機設定標題、
 * 地點與抵達時間；13 種活動類別與三種參加方式；5 種餐次與舊餐次、有與沒有 time 與食材；時間相同的活動與餐點；
 * 「誰負責買」為待分配、車上的旅伴或不在車上的旅伴。車名、活動標題與 mealTitle() 彼此不同，且除了最多一筆空白的
 * 活動標題與以餐次為標題的餐點外，都含有唯一的標記（例如「車〔3〕」「活動〔12〕」「料理〔5〕」）。
 * @param {{places?: 'mixed'|'normal'|'many', markup?: boolean}} [options]
 *   places：'mixed'（預設）、只用 0 到 12 個的 'normal'，或只用 13 到 100 個的 'many'。
 *   markup：true 時使用者文字與識別碼改用 markupText()（Property 20），名稱仍保留唯一標記。
 * @returns {fc.Arbitrary<object>}
 */
export function itineraryState(options = {}) {
  return fc.gen().map(g => buildItinerary(g, options));
}

// ---- 本功能之前的 Trip_State ----
function buildLegacy(g) {
  const ctx = newCtx(false);
  const fromSeed = chance(g, 50);
  const state = fromSeed ? seed() : emptyState(new Date(Date.UTC(2026, 0, 1, 12)));
  if (!fromSeed) Object.assign(state.trip, tripDates(g)); // 不依執行環境的時區決定日期
  const dates = dateRange(state.trip.startDate, state.trip.endDate);
  if (chance(g, 30)) state.trip.title = pick(g, TITLES);
  if (chance(g, 30)) state.trip.destination = chance(g, 70) ? nameWith(g, ctx, tag('營區', 0), 100) : blankDestination(g);
  if (chance(g, 30)) state.trip.description = description(g, ctx);
  ctx.people = 100; // 新旅伴的識別碼與既有的 p1…p6、me 不同
  state.people.push(...makePeople(g, ctx, int(g, 0, 4)));
  ctx.vehicles = 100;
  for (const vehicle of state.vehicles) if (chance(g, 50)) vehicle.meeting = meetingText(g, ctx);
  state.vehicles.push(...range(int(g, 0, 3)).map(() => makeVehicle(g, ctx, state.people)));
  const participation = activity => {
    delete activity.vehicleIds;
    activity.people = [];
    const mode = int(g, 0, 2);
    if (mode === 1 && state.vehicles.length) activity.vehicleIds = sample(g, state.vehicles.map(v => v.id), 1);
    if (mode === 2) activity.people = chance(g, 20) ? state.people.map(p => p.id) : sample(g, state.people.map(p => p.id), 1);
  };
  for (const activity of state.activities) {
    if (chance(g, 40)) activity.type = pick(g, LEGACY_TYPES);
    if (chance(g, 40)) participation(activity);
  }
  ctx.activities = 100;
  for (let i = int(g, 0, 6); i > 0; i--) {
    state.activities.push(makeActivity(g, ctx, { date: pick(g, dates), people: state.people, vehicles: state.vehicles, dayName: () => null, types: LEGACY_TYPES }));
  }
  ctx.meals = 100;
  for (let i = int(g, 0, 3); i > 0; i--) {
    const meal = makeMeal(g, ctx, pick(g, dates), state.people);
    delete meal.time; // Meal 的時間是本功能新增的欄位
    state.meals.push(meal);
  }
  for (const item of state.shopping) if (chance(g, 30)) item.assignee = chance(g, 30) ? '' : pick(g, state.people).id;
  return state;
}
/**
 * 本功能之前的 Trip_State（Property 2）：seed() 或 emptyState() 加上只用舊欄位的隨機修改。沒有 places、routes、
 * daySettings 與 meals[].time；活動類型只有六種 Legacy_Activity_Type；參加方式有全體旅伴、指定車輛與舊旅伴名單
 * （含包含每位旅伴的名單）；meeting 有「HH:MM · 地點」、只有時間、無法分出時間的自由文字與空白四種。
 * @returns {fc.Arbitrary<object>}
 */
export function legacyState() {
  return fc.gen().map(buildLegacy);
}

// ---- 單一錯誤（需求 23.4，Property 3） ----
/** faultState() 的錯誤，依需求 23.4 的順序；最後一項是 Property 3 另外列出的活動類型。 */
export const FAULT_TEXT = Object.freeze({
  'place-name-blank': 'Place 名稱去除前後空白後為空',
  'place-name-long': 'Place 名稱超過 50 字',
  'place-name-control': 'Place 名稱含控制字元',
  'place-name-duplicate': '兩個 Place 名稱相同',
  'place-name-destination': 'Place 名稱與旅行目的地相同',
  'place-count': '有 101 個 Place',
  'route-date': 'Route 的日期不在旅行日期範圍內',
  'route-vehicle': 'Route 的 Vehicle 不存在',
  'route-car-day': 'Route 與同一天同一台車的另一條 Route 重複',
  'route-end': 'Route 的起點或終點不是存在的 Place 或 Destination_Place',
  'route-destination-blank': '旅行目的地空白時 Route 的起點或終點使用 Destination_Place',
  'route-time': 'Route 的出發時間不是空白也不是 HH:MM',
  'route-stop-count': 'Route 有 7 個 Stop',
  'stop-place': 'Stop 的地點不存在',
  'stop-destination-blank': '旅行目的地空白時 Stop 的地點使用 Destination_Place',
  'stop-kind': 'Stop 的任務類型不是採買、接送、取還裝備或其他',
  'stop-note': 'Stop 的備註有 101 字',
  'day-date': 'Day_Settings 的日期不在旅行日期範圍內',
  'day-duplicate': 'Day_Settings 的日期與另一筆重複',
  'day-title': 'Day_Title 有 21 字',
  'day-place': 'Day_Location 不是存在的 Place',
  'day-place-destination': 'Day_Location 使用 Destination_Place',
  'day-arrival': 'Arrival_Time 不是空白也不是 HH:MM',
  'meal-time': 'Meal 的時間不是 HH:MM',
  'activity-type': '活動類型不是 13 個類別的值之一'
});
export const FAULT_KINDS = Object.freeze(Object.keys(FAULT_TEXT));
const CONTROLS = Object.freeze(['\u0000', '\u0007', '\t', '\n', '\r', '\u001F', '\u007F', '\u0085', '\u00AD', '\u200B', '\u200D', '\u200E', '\u202E', '\u2066', '\uFEFF', '\u061C', '\u{E0001}']);
const BLANK_NAMES = Object.freeze(['', ' ', '\u3000', '\n\t', '\u00A0\u2028', '\r\n\u0085']);
const BAD_TIMES = Object.freeze(['8:00', '24:00', '08:00:00', '0800', '08:', '：', ' 08:00', '08:00 ', '０８:００', '12:60', 'noon', '\n', null, 800]);
const BAD_MEAL_TIMES = Object.freeze(['', '8:30', '24:00', '18:00:00', ' 18:00', '１８:００', null, 1800]);
const BAD_KINDS = Object.freeze(['', 'Shop', 'buy', 'shopping', 'pickup ', 'other\n', null, 0]);
const BAD_TYPES = Object.freeze(['', 'unknown', 'Meet', 'camp ', 'breakfast', 'shop']);

/** 在 s 上做有效的準備（加入需要的地點、車輛、路線等），再由各錯誤函式加入錯誤。 */
function faultTools(g, s) {
  let serial = 0;
  const fresh = prefix => `${prefix}-fault-${++serial}`;
  const dates = dateRange(s.trip.startDate, s.trip.endDate);
  const newPlace = () => ({ id: fresh('pl'), name: tag('地點', `f${serial}`) });
  const tools = {
    fresh,
    newPlace,
    label: word => tag(word, `f${++serial}`),
    refs: () => placeRefs(s.places ?? [], s.trip.destination),
    ensurePlace() {
      s.places ??= [];
      if (!s.places.length) s.places.push(newPlace());
      return pick(g, s.places);
    },
    twoPlaces() {
      s.places ??= [];
      while (s.places.length < 2) s.places.push(newPlace());
      const [a, b] = sample(g, s.places, 2, 2);
      return [a, b];
    },
    /** 一條路線；room 為 true 時該路線還能再加一個 Stop。 */
    ensureRoute({ room = false } = {}) {
      s.routes ??= [];
      const fits = s.routes.filter(r => !room || (r.stops ?? []).length < LIMITS.stops);
      if (fits.length && chance(g, 80)) return pick(g, fits);
      if (!tools.refs().length) tools.ensurePlace();
      const used = new Set(s.routes.map(r => JSON.stringify([r.date, r.vehicleId])));
      let free = dates.flatMap(date => s.vehicles.map(v => [date, v.id])).filter(pair => !used.has(JSON.stringify(pair)));
      if (!free.length) {
        const vehicle = { id: fresh('v'), name: tag('車', `f${serial}`), driver: '', seats: 4, passengers: [], meeting: '' };
        s.vehicles.push(vehicle);
        free = dates.map(date => [date, vehicle.id]);
      }
      const [date, vehicleId] = pick(g, free);
      const refs = tools.refs();
      const route = { id: fresh('rt'), date, vehicleId, from: pick(g, refs), to: pick(g, refs), time: '', stops: [] };
      s.routes.splice(int(g, 0, s.routes.length), 0, route);
      return route;
    },
    ensureStop() {
      const withStops = (s.routes ?? []).filter(r => Array.isArray(r.stops) && r.stops.length);
      if (withStops.length && chance(g, 70)) return pick(g, pick(g, withStops).stops);
      const route = tools.ensureRoute({ room: true });
      route.stops ??= [];
      const stop = { id: fresh('st'), place: pick(g, tools.refs()), kind: pick(g, STOP_KIND_KEYS) };
      route.stops.push(stop);
      return stop;
    },
    ensureDaySetting() {
      s.daySettings ??= [];
      const used = new Set(s.daySettings.map(d => d.date));
      const free = dates.filter(date => !used.has(date));
      if ((s.daySettings.length && chance(g, 70)) || !free.length) return pick(g, s.daySettings);
      const setting = { date: pick(g, free), title: '新的一天' };
      s.daySettings.splice(int(g, 0, s.daySettings.length), 0, setting);
      return setting;
    },
    ensureMeal() {
      if (s.meals.length && chance(g, 70)) return pick(g, s.meals);
      const meal = { id: fresh('m'), date: pick(g, dates), slot: '午餐', title: tools.label('料理'), cookId: '', servings: 4, ingredients: '', notes: '' };
      s.meals.push(meal);
      return meal;
    },
    ensureActivity() {
      if (s.activities.length && chance(g, 70)) return pick(g, s.activities);
      const activity = { id: fresh('a'), date: pick(g, dates), time: '10:00', title: tools.label('活動'), type: 'camp', location: '', note: '', people: [], done: false };
      s.activities.push(activity);
      return activity;
    },
    /** 清空旅行目的地，並把使用 '@destination' 的起點、終點與 Stop 改成某個 Place。 */
    blankDestination() {
      if (trimWhite(s.trip.destination)) {
        const place = tools.ensurePlace();
        const swap = ref => (ref === DESTINATION_REF ? place.id : ref);
        for (const route of s.routes ?? []) {
          route.from = swap(route.from);
          route.to = swap(route.to);
          for (const stop of route.stops ?? []) stop.place = swap(stop.place);
        }
      }
      s.trip.destination = blankDestination(g);
    },
    /** 不在旅行日期內的日期（含格式錯誤的文字與 null）。 */
    outsideDate() {
      const first = Date.parse(`${dates[0]}T00:00:00Z`), last = Date.parse(`${dates.at(-1)}T00:00:00Z`);
      return pick(g, [isoDay(first - DAY_MS), isoDay(last + DAY_MS), isoDay(last + 400 * DAY_MS), '2026-02-30', '', 'bad', null]);
    },
    /** 不是 Place 也不是 '@destination' 的引用值。 */
    badRef() {
      return pick(g, [fresh('pl-missing'), '', null, '@Destination', 'destination', ...s.vehicles.map(v => v.id).slice(0, 1), s.people[0].id]);
    }
  };
  return tools;
}
/** 每個函式先在 s 上做有效的準備，再回傳加入錯誤的函式。 */
const FAULTS = {
  'place-name-blank': (g, s, t) => { const place = t.ensurePlace(); return () => { place.name = pick(g, BLANK_NAMES); }; },
  'place-name-long': (g, s, t) => {
    const place = t.ensurePlace();
    return () => {
      const label = t.label('地點');
      place.name = `${pick(g, PAD)}${label}${cut(pick(g, NAME_FILLERS).repeat(60), LIMITS.placeName + 1 - count(label))}${pick(g, PAD)}`;
    };
  },
  'place-name-control': (g, s, t) => {
    const place = t.ensurePlace();
    return () => { const [first, ...rest] = [...t.label('地點')]; place.name = `${first}${pick(g, CONTROLS)}${rest.join('')}`; };
  },
  'place-name-duplicate': (g, s, t) => { const [a, b] = t.twoPlaces(); return () => { b.name = sameNameVariant(g, a.name); }; },
  'place-name-destination': (g, s, t) => { const place = t.ensurePlace(); return () => { s.trip.destination = sameNameVariant(g, place.name); }; },
  'place-count': (g, s, t) => { s.places ??= []; return () => { while (s.places.length <= LIMITS.places) s.places.push(t.newPlace()); }; },
  'route-date': (g, s, t) => { const route = t.ensureRoute(); return () => { route.date = t.outsideDate(); }; },
  'route-vehicle': (g, s, t) => { const route = t.ensureRoute(); return () => { route.vehicleId = pick(g, [t.fresh('v-missing'), '', null, s.people[0].id]); }; },
  'route-car-day': (g, s, t) => {
    const route = t.ensureRoute();
    return () => { s.routes.splice(int(g, 0, s.routes.length), 0, { id: t.fresh('rt'), date: route.date, vehicleId: route.vehicleId, from: route.from, to: route.to, time: '', stops: [] }); };
  },
  'route-end': (g, s, t) => { const route = t.ensureRoute(); return () => { route[pick(g, ['from', 'to'])] = t.badRef(); }; },
  'route-destination-blank': (g, s, t) => { t.blankDestination(); const route = t.ensureRoute(); return () => { route[pick(g, ['from', 'to'])] = DESTINATION_REF; }; },
  'route-time': (g, s, t) => { const route = t.ensureRoute(); return () => { route.time = pick(g, BAD_TIMES); }; },
  'route-stop-count': (g, s, t) => {
    const route = t.ensureRoute();
    const refs = t.refs();
    return () => {
      route.stops = [...(route.stops ?? [])];
      while (route.stops.length <= LIMITS.stops) route.stops.push({ id: t.fresh('st'), place: pick(g, refs), kind: pick(g, STOP_KIND_KEYS) });
    };
  },
  'stop-place': (g, s, t) => { const stop = t.ensureStop(); return () => { stop.place = t.badRef(); }; },
  'stop-destination-blank': (g, s, t) => { t.blankDestination(); const stop = t.ensureStop(); return () => { stop.place = DESTINATION_REF; }; },
  'stop-kind': (g, s, t) => { const stop = t.ensureStop(); return () => { stop.kind = pick(g, BAD_KINDS); }; },
  'stop-note': (g, s, t) => { const stop = t.ensureStop(); return () => { stop.note = exactText(g, LIMITS.stopNote + 1); }; },
  'day-date': (g, s, t) => {
    s.daySettings ??= [];
    const setting = s.daySettings.length && chance(g, 50) ? pick(g, s.daySettings) : null;
    return () => {
      if (setting) setting.date = t.outsideDate();
      else s.daySettings.splice(int(g, 0, s.daySettings.length), 0, { date: t.outsideDate(), title: '不在旅行中' });
    };
  },
  'day-duplicate': (g, s, t) => {
    const setting = t.ensureDaySetting();
    return () => { s.daySettings.splice(int(g, 0, s.daySettings.length), 0, { date: setting.date, ...(chance(g, 50) ? { arrival: '10:00' } : {}) }); };
  },
  'day-title': (g, s, t) => { const setting = t.ensureDaySetting(); return () => { setting.title = exactText(g, LIMITS.dayTitle + 1); }; },
  'day-place': (g, s, t) => {
    const setting = t.ensureDaySetting();
    return () => { setting.place = pick(g, [t.fresh('pl-missing'), null, 0, '@Destination', s.people[0].id]); };
  },
  'day-place-destination': (g, s, t) => { const setting = t.ensureDaySetting(); return () => { setting.place = DESTINATION_REF; }; },
  'day-arrival': (g, s, t) => { const setting = t.ensureDaySetting(); return () => { setting.arrival = pick(g, BAD_TIMES); }; },
  'meal-time': (g, s, t) => { const meal = t.ensureMeal(); return () => { meal.time = pick(g, BAD_MEAL_TIMES); }; },
  'activity-type': (g, s, t) => { const activity = t.ensureActivity(); return () => { activity.type = pick(g, BAD_TYPES); }; }
};

/**
 * 只有一種錯誤的 Trip_State（Property 3）：{ state, base, fault }。base 是 itineraryState() 的結果加上有效的準備
 * （需要時加入地點、車輛、路線、Stop、每日設定、餐點或活動，或清空旅行目的地並把 '@destination' 改成某個 Place），
 * 通過驗證；state 是 base 只加入 fault 這一種錯誤；fault 是 FAULT_KINDS 之一（說明見 FAULT_TEXT）。
 * 指定 kind 時只產生該種錯誤，測試可以逐一涵蓋每一種；省略時隨機選一種。
 * @param {string} [kind]
 * @returns {fc.Arbitrary<{state: object, base: object, fault: string}>}
 */
export function faultState(kind) {
  if (kind !== undefined && !FAULT_KINDS.includes(kind)) throw new Error(`未知的錯誤種類：${kind}`);
  return fc.gen().map(g => {
    const state = buildItinerary(g, {});
    const fault = kind ?? pick(g, FAULT_KINDS);
    const inject = FAULTS[fault](g, state, faultTools(g, state));
    const base = structuredClone(state);
    inject();
    return { state, base, fault };
  });
}

// ---- 路線區塊（Property 18） ----
/** 依各終點第一次出現的順序組成終點組（與設計「endGroups(lines)」相同的規則，在這裡獨立實作）。 */
function endsOf(lines, endInfo) {
  const ends = [];
  lines.forEach((line, i) => {
    if (line.type !== 'route') return;
    let end = ends.find(entry => entry.ref === line.route.to);
    if (!end) ends.push(end = { ref: line.route.to, name: endInfo(line.route.to).name, endKind: endInfo(line.route.to).endKind, count: 0, lines: [] });
    end.count += 1;
    end.lines.push(i);
  });
  return ends;
}
/** n 個由小到大、互不相同的 00:00 至 23:59 分鐘數（n 不超過 1440）。 */
function increasingMinutes(g, n) {
  const out = [];
  let minute = int(g, 0, 1439 - (n - 1));
  for (let i = 0; i < n; i++) {
    if (i) minute += int(g, 1, Math.min(1439 - minute - (n - 1 - i), 120));
    out.push(minute);
  }
  return out;
}
const minuteText = minute => `${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`;
/** 同一組時間（或同樣沒有時間）的行中，車輛順序由小到大，所以依需求 5.2 排序後就是位置的順序。 */
function vehicleOrder(g, times, total = times.length) {
  const order = shuffle(g, range(total)).slice(0, times.length);
  for (let start = 0; start < times.length;) {
    let end = start + 1;
    while (end < times.length && times[end] === times[start]) end++;
    const sorted = order.slice(start, end).sort((a, b) => a - b);
    order.splice(start, end - start, ...sorted);
    start = end;
  }
  return order;
}

function buildBlockShape(g) {
  const size = int(g, 0, 19);
  const n = size >= 18 ? 200 : size >= 12 ? int(g, 13, 200) : int(g, 1, 12);
  // 出發時間組：1 組、每條各一組，或 1 到 n 組；有時最後一組沒有出發時間。
  const groupMode = int(g, 0, 3);
  const groups = groupMode === 0 ? 1 : groupMode === 1 ? n : int(g, 1, n);
  const blank = chance(g, 30);
  const timed = increasingMinutes(g, groups - (blank ? 1 : 0)).map(minuteText);
  const groupTimes = blank ? [...timed, ''] : timed;
  const sizes = Array(groups).fill(1);
  for (let k = n - groups; k > 0; k--) sizes[int(g, 0, groups - 1)] += 1;
  const times = sizes.flatMap((length, i) => Array(length).fill(groupTimes[i]));
  // 1 到 4 個終點，以任意順序交錯；每個終點至少一條路線。
  const m = int(g, 1, Math.min(4, n));
  const labels = range(n).map(() => int(g, 0, m - 1));
  shuffle(g, range(n)).slice(0, m).forEach((position, label) => { labels[position] = label; });
  const dayKind = pick(g, ['first', 'middle', 'last', 'single']);
  const pool = [DESTINATION_REF, ...range(8).map(i => `pl${i}`)];
  const refs = sample(g, pool, m, m);
  const camp = chance(g, 50) ? int(g, 0, m - 1) : -1;             // 其中一個終點是 Day_Location
  const lastDay = dayKind === 'last' || dayKind === 'single';
  const names = new Map(pool.map((ref, i) => [ref, ref === DESTINATION_REF ? '夕淞度日營區' : `地點${chineseNumeral(i)}`]));
  const endInfo = ref => {
    const index = refs.indexOf(ref);
    return { name: names.get(ref), endKind: index === camp ? 'camp' : lastDay ? 'house' : 'landmark' };
  };
  const kind = m === 1 && camp === 0 && chance(g, 50) ? 'arrival' : 'other';
  const campRef = camp >= 0 ? refs[camp] : null;
  const order = vehicleOrder(g, times);
  const vehicles = range(n).map(i => ({ id: `v${i}`, name: tag('車', i), driver: '', seats: 4, passengers: [], meeting: '' }));
  const date = '2026-10-20';
  const lines = range(n).map(i => {
    const to = refs[labels[i]];
    // Other 區塊中終點是 Day_Location 的路線也從 Day_Location 出發；Arrival 區塊的路線不從 Day_Location 出發。
    const fromChoices = pool.filter(ref => ref !== campRef);
    const from = kind === 'other' && to === campRef ? campRef : pick(g, fromChoices);
    const stops = range(chance(g, 15) ? LIMITS.stops : int(g, 0, LIMITS.stops)).map(j => {
      const stopKind = pick(g, STOP_KIND_KEYS);
      return { id: `st${i}-${j}`, place: pick(g, pool), kind: stopKind };
    });
    const vehicleIndex = order[i];
    const route = { id: `rt${i}`, date, vehicleId: vehicles[vehicleIndex].id, from, to, time: times[i], stops };
    return {
      type: 'route', route, vehicle: vehicles[vehicleIndex], vehicleIndex, time: times[i], from: names.get(from), to: names.get(to),
      stops: stops.map(stop => ({ stop, place: names.get(stop.place), kind: stop.kind, label: STOP_KINDS.find(k => k.kind === stop.kind).label, note: '', items: [], summary: '' }))
    };
  });
  const ends = endsOf(lines, endInfo);
  const houses = ends.filter(end => end.endKind === 'house').map(end => end.name);
  // 到達行依當天的 Arrival_Time（需求 14.11）；這個區塊沒有對應的日子，所以隨機決定有沒有抵達時間。
  const arrival = chance(g, 50) ? anyTime(g) : '';
  const arrivalLine = `${arrival ? `預計 ${arrival} 抵達` : '預計抵達時間待定'}${n >= 2 ? `・${chineseNumeral(n)}車會合` : ''}`;
  return {
    type: 'routes', kind, sortTime: times.find(Boolean) ?? null, lines,
    arrivalLine: kind === 'arrival' ? arrivalLine : null,
    returnLine: kind === 'other' && houses.length ? `平安返回${houses.join('、')}・不預估返抵時間` : null,
    ends
  };
}

/**
 * 路線區塊（Property 18），形狀與 dayModel() 的 { type: 'routes' } 區塊相同：
 *   { type: 'routes', kind: 'arrival' | 'other', sortTime, lines, arrivalLine, returnLine, ends }
 *   lines：{ type: 'route', route, vehicle, vehicleIndex, time, from, to, stops }，route 是儲存的 Route（to 是終點的引用值），
 *          time 是出發時間（沒有時為 ''），from 與 to 是地點名稱，stops 是 { stop, place, kind, label, note, items, summary }；
 *   ends：{ ref, name, endKind, count, lines }，依各終點在 lines 中第一次出現的順序（由產生器自行組成）；
 *   arrivalLine 與 returnLine 不適用時為 null。
 * 1 到 200 條路線、每條 0 到 6 個 Stop；出發時間形成 1 到 200 組（有時最後一組沒有出發時間），lines 依需求 5.2 排列
 * （時間由早到晚、同時間依車輛順序、沒有時間的在最後）；終點形成 1 到 4 個以任意順序交錯的終點組。
 * @returns {fc.Arbitrary<object>}
 */
export function blockShape() {
  return fc.gen().map(buildBlockShape);
}

// ---- 多個終點組的 Trip_State（Property 22、23） ----
const PATTERNS = Object.freeze(['same', 'single', 'contiguous', 'interleaved', 'random']);
/** k 條路線的終點組序號（依第一次出現的順序為 0、1、2…）。 */
function endSequence(g, pattern, k) {
  const relabel = raw => {
    const map = new Map();
    return raw.map(label => (map.has(label) ? map.get(label) : (map.set(label, map.size), map.size - 1)));
  };
  const covering = (length, m) => {
    const raw = range(length).map(() => int(g, 0, m - 1));
    shuffle(g, range(length)).slice(0, m).forEach((position, label) => { raw[position] = label; });
    return raw;
  };
  if (pattern === 'same') return Array(k).fill(0);
  if (pattern === 'contiguous') {
    // 每組的路線彼此相連，例如台北、台北、新竹。
    const m = int(g, 2, Math.min(4, k));
    const sizes = Array(m).fill(1);
    for (let rest = k - m; rest > 0; rest--) sizes[int(g, 0, m - 1)] += 1;
    return sizes.flatMap((length, label) => Array(length).fill(label));
  }
  if (pattern === 'interleaved') {
    // 同一組的路線之間夾著其他組的路線，例如台北、新竹、台北：前 k − 1 條用到 m 組，最後一條回到前面出現過、
    // 但不是第 k − 1 條的組。
    const m = int(g, 2, Math.min(4, k - 1));
    const head = relabel(covering(k - 1, m));
    const back = range(m).filter(label => label !== head.at(-1));
    return [...head, pick(g, back)];
  }
  if (pattern === 'single') {
    // 至少一組只有一條路線。
    const m = k === 1 ? 1 : int(g, 2, Math.min(4, k));
    if (m === 1) return [0];
    const raw = covering(k - 1, m - 1);
    raw.splice(int(g, 0, k - 1), 0, m - 1);
    return relabel(raw);
  }
  return relabel(covering(k, int(g, 1, Math.min(4, k))));
}
/** 依時間由早到晚（可以相同）的 k 個出發時間，最後 blank 個沒有出發時間。 */
function departureTimes(g, k) {
  const mode = int(g, 0, 3);
  const blank = mode === 1 ? k : mode === 2 ? int(g, 1, k) : 0;
  const times = [];
  let minute = int(g, 0, 1439);
  for (let i = 0; i < k - blank; i++) {
    if (i) minute = Math.min(1439, minute + (chance(g, 30) ? 0 : int(g, 1, 90)));
    times.push(minuteText(minute));
  }
  return [...times, ...Array(blank).fill('')];
}
/** 解析後得到 time（'' 表示沒有時間）的舊出發資料文字。 */
function legacyMeeting(g, ctx, time) {
  const text = time ? (chance(g, 50) ? `${time}${pick(g, MEETING_SEPARATORS)}${pick(g, MEETING_PLACES)}` : time) : pick(g, FREE_MEETINGS);
  const parsed = parseVehicleMeeting(text);
  return parsed.time === time && trimWhite(text) ? text : time || '早上八點在家門口';
}

function buildEndMix(g) {
  const ctx = newCtx(false);
  const kind = chance(g, 25) ? 'arrival' : 'other';
  const pattern = kind === 'arrival' ? 'same' : pick(g, PATTERNS);
  const minRoutes = pattern === 'interleaved' ? 3 : pattern === 'contiguous' ? 2 : 1;
  const k = chance(g, 15) ? 12 : int(g, minRoutes, 12);
  const sequence = endSequence(g, pattern, k);
  const m = Math.max(...sequence) + 1;
  // Day_Location：none（旅行目的地空白、當天沒有地點，所以每條路線都是 Other_Routes）、destination 或 place。
  const locMode = kind === 'arrival' ? pick(g, ['destination', 'place']) : pick(g, ['none', 'destination', 'place']);
  const trip = tripFields(g, ctx, locMode === 'none' ? 'blank' : locMode === 'destination' ? 'set' : 'any');
  const dates = dateRange(trip.startDate, trip.endDate);
  const date = kind === 'arrival' ? dates[0] : pick(g, dates);
  const people = makePeople(g, ctx);
  const places = range(int(g, 4, 12)).map(i => ({ id: makeId(g, ctx, 'pl', i), name: nameWith(g, ctx, tag('地點', i), LIMITS.placeName, { place: true }) }));
  const refs = placeRefs(places, trip.destination);
  const location = locMode === 'none' ? null : locMode === 'destination' ? DESTINATION_REF : pick(g, places).id;
  // 區塊中的行：k 條路線，Arrival 區塊另有 1 到 3 筆 First_Day 的舊出發資料，依時間與車輛順序排列。
  const slots = shuffle(g, [...Array(k).fill('route'), ...Array(kind === 'arrival' ? int(g, 1, 3) : 0).fill('legacy')]);
  const times = departureTimes(g, slots.length);
  // 不在區塊中的車：Other 區塊時有時另有不在區塊中的舊出發資料車輛，以及 0 到 2 台其他車輛。
  const outsideLegacy = kind === 'other' && chance(g, 40) ? int(g, 1, 2) : 0;
  const extra = int(g, 0, 2);
  const total = slots.length + outsideLegacy + extra;
  const order = vehicleOrder(g, times, total);
  const roles = Array(total).fill('extra');
  order.forEach((index, i) => { roles[index] = slots[i]; });
  const rest = range(total).filter(index => roles[index] === 'extra');
  shuffle(g, rest).slice(0, outsideLegacy).forEach(index => { roles[index] = 'outside-legacy'; });
  const meetings = new Map(order.map((index, i) => [index, slots[i] === 'legacy' ? legacyMeeting(g, ctx, times[i]) : undefined]));
  const vehicles = range(total).map(index => makeVehicle(g, ctx, people, {
    meeting: roles[index] === 'legacy' ? meetings.get(index)
      : roles[index] === 'outside-legacy' ? meetingText(g, ctx, int(g, 1, 3))
      : kind === 'arrival' && roles[index] === 'extra' ? '' : undefined
  }));
  // 終點組依第一次出現的順序對應到 m 個不同的地點；Other 區塊中終點是 Day_Location 的路線也從 Day_Location 出發。
  const ends = kind === 'arrival' ? [location] : sample(g, refs, m, m);
  const routes = [];
  const blockRefs = [];
  let routeIndex = 0;
  slots.forEach((slot, i) => {
    if (slot === 'legacy') { blockRefs.push(null); return; }
    const to = ends[sequence[routeIndex++]];
    const from = kind === 'arrival' ? pick(g, refs.filter(ref => ref !== location)) : to === location ? location : pick(g, refs);
    routes.push(makeRoute(g, ctx, { date, vehicleId: vehicles[order[i]].id, from, to, refs, time: times[i] }));
    blockRefs.push(to);
  });
  // 同一天其他車的路線放在另一個區塊：Other 區塊時是到達 Day_Location 的路線，Arrival 區塊時是不到達的路線。
  for (const index of range(total).filter(i => roles[i] === 'extra')) {
    if (!chance(g, 50)) continue;
    if (kind === 'other' && location) {
      routes.push(makeRoute(g, ctx, { date, vehicleId: vehicles[index].id, from: pick(g, refs.filter(ref => ref !== location)), to: location, refs }));
    }
    if (kind === 'arrival') {
      const others = refs.filter(ref => ref !== location);
      routes.push(makeRoute(g, ctx, { date, vehicleId: vehicles[index].id, from: pick(g, refs), to: pick(g, others), refs }));
    }
  }
  // 其他日子隨機；First_Day 的舊出發資料車輛在 First_Day 沒有路線。
  const legacyIds = new Set(range(total).filter(i => roles[i] === 'legacy' || roles[i] === 'outside-legacy').map(i => vehicles[i].id));
  routes.push(...randomRoutes(g, ctx, {
    dates, vehicles, refs,
    skip: (day, vehicle) => day === date || (day === dates[0] && legacyIds.has(vehicle.id))
  }));
  const daySettings = [
    ...(locMode === 'place' || chance(g, 50) ? [daySetting(g, ctx, date, places, locMode === 'place' ? location : null)] : []),
    ...randomDaySettings(g, ctx, { dates, places, skip: day => day === date })
  ];
  const dayName = day => dayLocationName(day, daySettings, places, trip.destination);
  const meals = randomMeals(g, ctx, { dates, people });
  const activities = randomActivities(g, ctx, { dates, people, vehicles, dayName });
  const state = assemble(g, ctx, { trip, people, vehicles, places, routes, daySettings, activities, meals });
  return { state, date, kind, refs: blockRefs, pattern };
}

/**
 * 有多個終點組的 Trip_State（Property 22、23）：{ state, date, kind, refs, pattern }。
 * state 的 date 那一天有一個路線區塊（kind 為 'other' 或 'arrival'）含 1 到 12 條路線、每條 0 到 6 個 Stop；
 * 每台車每天最多一條路線，所以車輛數隨路線數增加（最多 17 台，超過 8 台時 Car_Color 會重複）。終點從 1 到 4 個地點
 * 中隨機選取，pattern 表示終點組的排列：
 *   'interleaved'：同一組的路線之間夾著其他組的路線（例如台北、新竹、台北）；
 *   'single'：至少一組只有一條路線；'same'：全部同一組；'contiguous'：至少兩組，各組的路線彼此相連；'random'：任意。
 * kind 為 'arrival' 時區塊是 First_Day 的 Arrival 區塊（終點都是 Day_Location），另含 1 到 3 筆 First_Day 的舊出發資料，
 * 依需求 5.2 與路線交錯排列；kind 為 'other' 時區塊在任一天，有時另有不在這個區塊中的 First_Day 舊出發資料。
 * refs 是區塊各行依序的終點引用值（Route 的 to），舊出發資料為 null，測試可以用來確認取得的是同一個區塊。
 * 同一天其他車的路線在另一個區塊；其他日子的路線、每日設定、活動與餐點依 itineraryState() 的規則隨機產生。
 * @returns {fc.Arbitrary<{state: object, date: string, kind: 'other'|'arrival', refs: Array<string|null>, pattern: string}>}
 */
export function endMixState() {
  return fc.gen().map(buildEndMix);
}
