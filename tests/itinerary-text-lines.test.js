// Feature: trip-planning-workflow-enhance, Property 4: 文字版的項目行與資料一一對應
// **Validates: Requirements 8.1, 8.2, 8.7, 14.9, 14.13, 14.15, 14.18, 19.2, 19.3, 19.7, 19.10, 23.3**
//
// 對每一組通過驗證的 Trip_State s（需求 23.3：itineraryState() 的每一組先確認 State_Validator 接受），把 itineraryText(s)
// 依 LF 分行，以本檔算出的每日第一行「第 {N} 天・{月}/{日}（週{星期}）｜{Day_Title}」依日期順序找出每個 Trip_Day 的段落，
// 再依區塊（空行之後的「路線」或「活動」一行）逐行比對本檔依條文寫出的預期行：
// - 路線行（需求 14.9、14.10）：每條 Route 一行「{車名}｜{HH:MM} 出發：{地點串}」，沒有出發時間時以「出發時間待定」取代
//   「{HH:MM} 出發」；地點串依序為起點、每個 Stop 與終點，以「 → 」連接。Stop 依任務類型為「{地點}（採買：{Shopping_Summary}）」
//   （摘要為空字串時「{地點}（採買）」，採買 Stop 的備註不輸出）、「{地點}（接送：{備註}）」與「{地點}（取還裝備：{備註}）」
//   （備註為空字串時只寫任務類型），以及其他的「{地點}（{備註}）」（備註為空字串時只寫地點）。Shopping_Summary 依需求 6.9 與
//   6.11：「誰負責買」的 Buyer_Car 的 First_Shopping_Stop 依採買清單的順序列出 Stop_Items 的名稱（處理後相同的名稱只列第一個，
//   空的不列），其他 Shopping_Stop 為空字串。
// - 舊出發行（需求 14.15、19.3、19.7、19.10）：只在 First_Day，每台在 First_Day 沒有路線、`meeting` 拆得出時間或地點的車一行
//   「{車名}｜{HH:MM} 出發：{舊出發地點}」，沒有時間時為「出發時間待定」，沒有地點時為「出發地點待定」。
// - 項目與補充行（需求 14.13、14.14、8.1、8.2、8.5 至 8.7、19.2）：每筆 Activity 的項目行「{HH:MM} {標題}（{Activity_Category}）」
//   （標題為空字串時以類別代替；舊活動類型依前言「活動類別」表對應類別），之後依序是「地點：」（不是空字串、且與 Day_Location
//   不同名時）、「參加：」（不是全體旅伴時：有指定車輛時依指定順序的車名，否則依名單順序的旅伴名）與「備註：」（不是空字串時）；
//   每筆 Meal 的項目行「{Meal_Time} {餐次}：{料理名稱}（{Meal_Label}）」（料理名稱為空字串或與餐次相同時只寫餐次），有食材時之後
//   是一行食材行（料理卡片「食材」的名稱與順序，以「、」連接）。完成狀態、主廚、份數與料理筆記都不出現。
// 檢查的內容（需求 14.18(a)）：
// - 每個預期的行在其日期的段落中恰好出現一次：路線行與舊出發行在「路線」區塊，Activity 與 Meal 的項目行在「活動」區塊，
//   項目行之後緊接著它的補充行。內容相同的行（例如 Example_Text 第 2 天與第 3 天的「08:00 起床（起床）」）各自在自己的段落中
//   比對，所以「其他段落中沒有」是指其他段落只有屬於那一天的資料的行。
// - 段落中沒有其他路線行、舊出發行或項目行：第一行與地點行（有 Day_Location 時）之後只有區塊；「路線」區塊的每一行都是當天的
//   路線行或舊出發行，只有最後一行可以是到達行或返程行；「活動」區塊的每個項目行都是當天的 Activity 或 Meal；每個區塊至少有
//   一個這樣的行。第一個段落之前（標題、旅行介紹與車輛行）沒有任何路線行、舊出發行或項目行。
// - 產生文字不修改 Trip_State（需求 8.1：顯示 Meal_Moment 不新增 Activity，也不寫入 Trip_State）。
// 區塊與區塊中各行的順序（需求 5.2、14.8、14.13）由 Property 6 驗證；標題、旅行介紹、車輛行、到達行、返程行與空行的格式，
// 以及同一個 Trip_State 與其深拷貝產生的四次文字相同（需求 14.18(b) 與 23.3 的後半），由 Property 5 驗證。
//
// 預期的行在本檔依條文獨立寫出：需求 14.16 的文字處理、活動類別與任務類型的標籤、Meal_Time 的預設時間、Meal_Label、
// Day_Location、Buyer_Car、First_Shopping_Stop 與 Shopping_Summary、參加者，以及每日第一行的星期（以公曆的天數計算）。只沿用
// 條文指定的規則來源：Trip_Day 依 dateRange()（State_Validator 的日期範圍）、舊出發資料依 parseVehicleMeeting()（需求 19.7）、
// 食材名稱依 parseIngredients()（料理卡片的「食材」，需求 8.7）、料理插圖類型依 inferDishKind()（需求 8.6）、餐次依
// mealSlotRank()（需求 8.2 與 14.13 指定與 src/meal-order.js 相同），以及需求 2.1(d) 的同名比較 placeKey()（由 Property 15 驗證）。
//
// 三個屬性測試使用不同的產生器：itineraryState()（需求 23.3 的值域，200 組）；使用者文字與識別碼改用 HTML 標記、字元參照與
// XSS 字串的變體（文字原樣輸出、不跳脫）；legacyState()（本功能之前的 Trip_State：六種舊活動類型、三種參加方式與四種 meeting，
// First_Day 只有舊出發行，需求 19.2、19.3）。每個測試另外確認列出的情況至少出現一次；依產生器的機率，這些情況在該測試的組數中
// 都幾乎必然出現。最後一個測試把同一套預期行套用在需求文件的 Example_Text 上，確認本檔寫出的格式與需求的範例相符。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { parseIngredients } from '../src/ingredients.js';
import { DESTINATION_REF, placeKey } from '../src/itinerary-model.js';
import { itineraryText } from '../src/itinerary-text.js';
import { mealSlotRank } from '../src/meal-order.js';
import { dateRange, isValidState } from '../src/model.js';
import { inferDishKind } from '../src/recipes.js';
import { parseVehicleMeeting } from '../src/vehicle-departures.js';
import { EXAMPLE_TEXT, exampleTrip } from './fixtures/example-trip.js';
import { itineraryState, legacyState } from './support/itinerary-arb.js';

// fc.gen() 產生的 Trip_State 很大，屬性失敗時縮小可能要好幾分鐘，而 bun test 無法中斷同步執行的測試，所以 30 秒後停止縮小
// 並回報目前的反例；尚未跑完全部組數就到時間也算失敗（failOnInterrupt）。bun test 不顯示錯誤的 cause，所以把失敗的檢查
// （日期與不符合的行）放進回報的訊息（includeErrorInReport）。
const bounded = numRuns => ({
  numRuns, includeErrorInReport: true, plugins: [fc.interruptAfterTimeLimit(30_000, { failOnInterrupt: true })]
});
const TIMEOUT = 60_000;

// ---- 本檔依條文寫出的文字規則 ----
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
/** HH:MM；沒有時間（省略或空字串）時為 ''。 */
const hhmm = value => (typeof value === 'string' && TIME.test(value) ? value : '');
/** 去除前後的 Unicode White_Space（含全形空白、換行與 Tab）。 */
const trimmed = text => String(text ?? '').replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
// 需求 14.16 的換行字元：CR、LF、U+000B、U+000C、U+0085、U+2028 與 U+2029。
const BREAK = /[\r\n\u000B\u000C\u0085\u2028\u2029]/u;
/** 需求 14.16：去除前後空白，每一段含換行字元的連續空白換成一個半形空白，其他字元原樣（不跳脫、不截斷）。 */
const clean = text => trimmed(text).replace(/\p{White_Space}+/gu, run => (BREAK.test(run) ? ' ' : run));
const MARKUP = /[<>&"'`]/;

// 前言「活動類別」表：活動類型與文字版括號中的 Activity_Category。
const CATEGORY = new Map([
  ['meet', '集合'], ['market', '採買'], ['camp', '營地時光'], ['meal', '用餐'], ['night', '夜晚'], ['travel', '移動'],
  ['wake', '起床'], ['pitch', '搭帳'], ['free', '自由活動'], ['tea', '下午茶／遊戲'], ['strike', '拆帳'], ['clean', '清潔'],
  ['return', '返程']
]);
const LEGACY_TYPES = ['meet', 'market', 'camp', 'meal', 'night', 'travel'];
// 需求 14.10：Stop 的任務類型。
const TASK = new Map([['shop', '採買'], ['pickup', '接送'], ['gear', '取還裝備'], ['other', '其他']]);
// 需求 8.2：早餐、午餐、下午茶、晚餐、消夜（mealSlotRank() 的 0 到 4）的預設時間；其他舊資料餐次為 12:00。
const MEAL_DEFAULTS = Object.freeze(['08:30', '12:00', '15:00', '18:00', '21:00']);

// 公曆日期的星期，以 1970-01-01（星期四）起算的天數計算（H. Hinnant 的 days_from_civil），與時區及語系無關。
const WEEKDAYS = '日一二三四五六';
function weekdayOf(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400), yoe = y - era * 400;
  const doy = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  const days = era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
  return WEEKDAYS[(((days + 4) % 7) + 7) % 7];
}

/**
 * 需求 6.9、6.11：每個 First_Shopping_Stop（以 Stop 物件為鍵）的 { summary, skipped }；不在 Map 中的採買 Stop 沒有 Stop_Items。
 * Buyer_Car 是依 state.vehicles 的順序，第一台駕駛（不是待分配時）或乘客包含該旅伴的車；First_Shopping_Stop 是該車有採買
 * Stop 的路線中日期最早的那一條的第一個採買 Stop；Stop_Items 是「誰負責買」的 Buyer_Car 為該車的品項（依採買清單的順序，
 * 含已買齊的品項）。摘要列出處理後的名稱，相同的名稱只列第一個、空的不列；skipped 表示有名稱因此略去。
 */
function shoppingSummaries(state, dates) {
  const buyerCar = new Map();
  for (const vehicle of state.vehicles) {
    for (const person of [...(vehicle.driver ? [vehicle.driver] : []), ...vehicle.passengers]) {
      if (!buyerCar.has(person)) buyerCar.set(person, vehicle.id);
    }
  }
  const firstStop = new Map();
  for (const route of state.routes ?? []) {
    const stop = (route.stops ?? []).find(item => item.kind === 'shop');
    const day = dates.indexOf(route.date), current = firstStop.get(route.vehicleId);
    if (stop && (!current || day < current.day)) firstStop.set(route.vehicleId, { day, stop });
  }
  const names = new Map([...firstStop.values()].map(({ stop }) => [stop, []]));
  for (const item of state.shopping) {
    const first = item.assignee ? firstStop.get(buyerCar.get(item.assignee)) : undefined;
    if (first) names.get(first.stop).push(clean(item.name));
  }
  return new Map([...names].map(([stop, list]) => {
    const kept = [...new Set(list.filter(Boolean))];
    return [stop, { summary: kept.join('、'), skipped: kept.length < list.length }];
  }));
}

/** 需求 14.10：一個 Stop 在地點串中的文字；tags 收集涵蓋範圍的情況。 */
function stopText(stop, ctx, tags) {
  const place = ctx.place(stop.place), task = TASK.get(stop.kind);
  if (stop.kind === 'shop') {
    const first = ctx.summaries.get(stop);
    if (!first) tags.push('不是 First_Shopping_Stop 的採買 Stop');
    else tags.push(first.summary ? '有 Shopping_Summary 的採買 Stop' : 'Shopping_Summary 為空字串的 First_Shopping_Stop');
    if (first?.skipped) tags.push('Shopping_Summary 略去空白或重複的品項名稱');
    if (trimmed(stop.note)) tags.push('有備註的採買 Stop（備註不輸出）');
    return first?.summary ? `${place}（採買：${first.summary}）` : `${place}（採買）`;
  }
  const note = clean(stop.note);
  tags.push(`${note ? '有' : '沒有'}備註的${task} Stop`);
  if (stop.kind === 'other') return note ? `${place}（${note}）` : place;
  return note ? `${place}（${task}：${note}）` : `${place}（${task}）`;
}

/** 需求 14.9：一條 Route 的路線行。 */
function routeEntry(route, ctx) {
  const stops = route.stops ?? [];
  const tags = [hhmm(route.time) ? '有出發時間的路線' : '沒有出發時間的路線'];
  if (!stops.length) tags.push('沒有 Stop 的路線');
  if (stops.length === 6) tags.push('6 個 Stop 的路線');
  if ([route.from, route.to, ...stops.map(stop => stop.place)].includes(DESTINATION_REF)) tags.push('使用旅行目的地的路線');
  const chain = [ctx.place(route.from), ...stops.map(stop => stopText(stop, ctx, tags)), ctx.place(route.to)].join(' → ');
  const line = `${clean(ctx.vehicleName.get(route.vehicleId))}｜${hhmm(route.time) ? `${route.time} 出發` : '出發時間待定'}：${chain}`;
  if (MARKUP.test(line)) tags.push('含標記字元的路線行');
  return { line, tags };
}

/** 需求 14.15、19.7、19.10：一台車的舊出發行；`meeting` 拆不出時間也拆不出地點時為 null。 */
function legacyEntry(vehicle) {
  const { time, location } = parseVehicleMeeting(vehicle.meeting);
  if (!time && !location) return null;
  const place = clean(location);
  const line = `${clean(vehicle.name)}｜${time ? `${time} 出發` : '出發時間待定'}：${place || '出發地點待定'}`;
  const tags = [time && place ? '有時間與地點的舊出發行' : time ? '只有時間的舊出發行' : '沒有時間的舊出發行'];
  if (MARKUP.test(line)) tags.push('含標記字元的舊出發行');
  return { line, tags };
}

/** 項目行與補充行的標記字元情況。 */
function markupTags(lines, tags) {
  if (MARKUP.test(lines[0])) tags.push('含標記字元的項目行');
  if (lines.slice(1).some(line => MARKUP.test(line))) tags.push('含標記字元的補充行');
}

/** 需求 14.13、14.14、19.2：一筆 Activity 的項目行與補充行。dayKey 是 Day_Location 名稱的同名比較值，沒有時為 null。 */
function activityEntry(activity, ctx, dayKey) {
  const category = CATEGORY.get(activity.type), title = clean(activity.title);
  const tags = [`類別 ${category}`];
  if (!title) tags.push('空白標題的活動');
  const lines = [`${activity.time} ${title || category}（${category}）`];
  const location = clean(activity.location);
  if (location && placeKey(location) === dayKey) tags.push('地點與 Day_Location 同名的活動');
  else if (location) {
    lines.push(`地點：${location}`);
    tags.push('有「地點：」行的活動');
  }
  if (activity.vehicleIds !== undefined) {
    lines.push(`參加：${activity.vehicleIds.map(id => clean(ctx.vehicleName.get(id))).join('、')}`);
    tags.push('指定車輛的活動');
  } else if (activity.people.length && !ctx.personIds.every(id => activity.people.includes(id))) {
    lines.push(`參加：${activity.people.map(id => clean(ctx.personName.get(id))).join('、')}`);
    tags.push('列出旅伴的活動');
  } else tags.push(activity.people.length ? '旅伴名單包含每一位旅伴的活動' : '全體旅伴的活動');
  const note = clean(activity.note);
  if (note) {
    lines.push(`備註：${note}`);
    tags.push('有備註的活動');
  }
  markupTags(lines, tags);
  return { type: 'activity', time: activity.time, lines, tags };
}

/** 需求 14.13、14.14、8.2、8.5 至 8.7：一筆 Meal 的項目行與食材行。 */
function mealEntry(meal) {
  const slot = clean(meal.slot), title = clean(meal.title), kind = inferDishKind(meal), rank = mealSlotRank(meal.slot);
  const label = kind === 'hotpot' ? '火鍋' : kind === 'bbq' ? '烤肉' : slot;
  const time = hhmm(meal.time) || (MEAL_DEFAULTS[rank] ?? '12:00');
  const plain = !title || title === slot;
  const lines = [`${time} ${plain ? slot : `${slot}：${title}`}（${label}）`];
  const names = parseIngredients(meal.ingredients).map(clean).filter(Boolean);
  if (names.length) lines.push(names.join('、'));
  const tags = [
    names.length ? '有食材行的餐點' : '沒有食材的餐點',
    plain ? '料理名稱空白或與餐次相同的餐點' : '「{餐次}：{料理名稱}」的餐點',
    kind === 'hotpot' ? 'Meal_Label 為火鍋' : kind === 'bbq' ? 'Meal_Label 為烤肉' : 'Meal_Label 為餐次',
    hhmm(meal.time) ? '自訂時間的餐點' : rank < MEAL_DEFAULTS.length ? '使用餐次預設時間的餐點' : '其他舊資料餐次的餐點'
  ];
  markupTags(lines, tags);
  return { type: 'meal', time, lines, tags };
}

/**
 * 每個 Trip_Day 的預期內容，依日期順序：{ date, header, locationLine, lines, moments, tags }。header 是段落的第一行，
 * locationLine 是「地點：{Day_Location}」（沒有 Day_Location 時為 null）；lines 是路線行與舊出發行 { line, tags }，moments 是
 * Activity 與 Meal 的 { lines: [項目行, ...補充行], tags }；tags 收集涵蓋範圍的情況。
 */
function expectedDays(state) {
  const { trip } = state;
  const dates = dateRange(trip.startDate, trip.endDate);
  const places = new Map((state.places ?? []).map(place => [place.id, place.name]));
  const ctx = {
    place: ref => clean(ref === DESTINATION_REF ? trip.destination : places.get(ref)),
    vehicleName: new Map(state.vehicles.map(vehicle => [vehicle.id, vehicle.name])),
    personName: new Map(state.people.map(person => [person.id, person.name])),
    personIds: state.people.map(person => person.id),
    summaries: shoppingSummaries(state, dates)
  };
  return dates.map((date, index) => {
    const [year, month, day] = date.split('-').map(Number);
    const setting = (state.daySettings ?? []).find(item => item.date === date);
    const title = clean(setting?.title);
    // Day_Location：Day_Settings 的 Place；未設定時為旅行目的地，目的地也空白時沒有 Day_Location。
    const location = setting?.place ? places.get(setting.place) : trimmed(trip.destination) ? trip.destination : null;
    const routes = (state.routes ?? []).filter(route => route.date === date);
    // 舊出發資料一律屬於 First_Day，且只給這一天沒有路線的車（需求 14.15、19.3）。
    const legacy = index > 0 ? [] : state.vehicles
      .filter(vehicle => !routes.some(route => route.vehicleId === vehicle.id))
      .map(legacyEntry)
      .filter(Boolean);
    const dayKey = location === null ? null : placeKey(clean(location));
    const activities = state.activities.filter(activity => activity.date === date).map(activity => activityEntry(activity, ctx, dayKey));
    const meals = state.meals.filter(meal => meal.date === date).map(mealEntry);
    const tags = [location === null ? '沒有地點行的日子' : '有地點行的日子'];
    if (activities.some(activity => meals.some(meal => meal.time === activity.time))) tags.push('時間相同的活動與餐點');
    return {
      date,
      header: `第 ${index + 1} 天・${month}/${day}（週${weekdayOf(year, month, day)}）${title ? `｜${title}` : ''}`,
      locationLine: location === null ? null : `地點：${clean(location)}`,
      lines: [...routes.map(route => routeEntry(route, ctx)), ...legacy],
      moments: [...activities, ...meals],
      tags
    };
  });
}

// ---- 比對 ----
// 到達行（需求 14.11）或返程行（需求 14.12）：「路線」區塊中只有最後一行可以不是路線行或舊出發行；它們的內容由 Property 5 檢查。
const CLOSING = /^(?:預計(?: (?:[01]\d|2[0-3]):[0-5]\d 抵達|抵達時間待定)(?:・(?:[一二三四五六七八九十兩]+|\d+)車會合)?|平安返回.+・不預估返抵時間)$/u;
const show = value => JSON.stringify(value);

/** 「路線」區塊：每一行都要是 pool 中尚未使用的路線行或舊出發行，只有最後一行可以是到達行或返程行。 */
function routeBlockProblems(content, pool, problems) {
  let found = 0;
  content.forEach((line, k) => {
    const i = pool.findIndex(entry => entry.line === line);
    if (i >= 0) {
      pool.splice(i, 1);
      found += 1;
    } else if (k < content.length - 1 || !CLOSING.test(line)) problems.push(`「路線」區塊中不對應任何路線或舊出發資料的行 ${show(line)}`);
  });
  if (!found) problems.push(`沒有路線行與舊出發行的「路線」區塊 ${show(content)}`);
}

/** 「活動」區塊：每個項目行都要是 pool 中尚未使用的 Activity 或 Meal，且緊接著它的補充行；項目之間可以有空行。 */
function momentBlockProblems(content, pool, problems) {
  let found = 0;
  for (let k = 0; k < content.length;) {
    if (content[k] === '') {
      k += 1;
      continue;
    }
    // 項目行相同的預期項目（只在內容相同時發生）先試補充行較多的。
    const candidates = pool.filter(entry => entry.lines[0] === content[k]).sort((a, b) => b.lines.length - a.lines.length);
    const match = candidates.find(entry => entry.lines.every((line, j) => content[k + j] === line));
    if (match) {
      pool.splice(pool.indexOf(match), 1);
      found += 1;
      k += match.lines.length;
      continue;
    }
    problems.push(candidates.length
      ? `項目行 ${show(content[k])} 之後應為 ${show(candidates[0].lines.slice(1))}，實際為 ${show(content.slice(k + 1, k + candidates[0].lines.length))}`
      : `「活動」區塊中不對應任何 Activity 或 Meal 的行 ${show(content[k])}`);
    k += 1;
  }
  if (!found) problems.push(`沒有項目行的「活動」區塊 ${show(content)}`);
}

/**
 * 一天的段落（第一行到最後一個非空行）與預期內容不符的地方：區塊之外的行、不對應任何預期行的路線行、舊出發行或項目行、
 * 補充行不符的項目、沒有路線行或項目行的區塊，以及段落中找不到的預期行。每個預期的行只能使用一次。
 */
function dayProblems(section, day) {
  const problems = [], lines = [...day.lines], moments = [...day.moments];
  let p = 1;
  if (day.locationLine !== null) {
    if (section[1] === day.locationLine) p = 2;
    else problems.push(`第二行應為地點行 ${show(day.locationLine)}，實際為 ${show(section[1] ?? null)}`);
  }
  const blockAt = q => section[q] === '' && (section[q + 1] === '路線' || section[q + 1] === '活動');
  while (p < section.length) {
    if (!blockAt(p)) {
      problems.push(`區塊之外的行 ${show(section[p])}`);
      p += 1;
      continue;
    }
    let end = p + 2;
    while (end < section.length && !blockAt(end)) end += 1;
    const content = section.slice(p + 2, end);
    if (section[p + 1] === '路線') routeBlockProblems(content, lines, problems);
    else momentBlockProblems(content, moments, problems);
    p = end;
  }
  for (const entry of lines) problems.push(`段落中缺少的行 ${show(entry.line)}`);
  for (const entry of moments) problems.push(`段落中缺少的項目 ${show(entry.lines)}`);
  return problems;
}

/** 以 state 的預期內容比對 text（itineraryText() 的結果），並把出現的情況加入 seen。 */
function checkText(state, text, seen) {
  const days = expectedDays(state);
  const lines = text.split('\n');
  // 每個 Trip_Day 的段落從它的第一行開始，依日期順序排列。
  const starts = [];
  for (const day of days) {
    const at = lines.indexOf(day.header, starts.length ? starts.at(-1) + 1 : 0);
    expect({ date: day.date, header: day.header, found: at >= 0 }).toEqual({ date: day.date, header: day.header, found: true });
    starts.push(at);
  }
  // 第一個段落之前只有標題、旅行介紹與車輛行，沒有任何路線行、舊出發行或項目行。
  const itemLines = new Set(days.flatMap(day => [...day.lines.map(entry => entry.line), ...day.moments.map(entry => entry.lines[0])]));
  expect({ beforeFirstDay: lines.slice(0, starts[0]).filter(line => itemLines.has(line)) }).toEqual({ beforeFirstDay: [] });
  days.forEach((day, i) => {
    const section = lines.slice(starts[i], starts[i + 1] ?? lines.length);
    while (section.at(-1) === '') section.pop(); // 與下一個段落之間的空行
    expect({ date: day.date, problems: dayProblems(section, day) }).toEqual({ date: day.date, problems: [] });
    for (const tag of [...day.tags, ...[...day.lines, ...day.moments].flatMap(entry => entry.tags)]) seen.add(tag);
  });
}

/** 屬性本身：itineraryText(state) 不修改 state，且每個預期的行恰好出現在其日期的段落中。 */
function checkState(state, seen) {
  const before = structuredClone(state);
  const text = itineraryText(state);
  expect(state).toStrictEqual(before);
  checkText(state, text, seen);
}

// ---- 涵蓋範圍 ----
const missing = (seen, required) => required.filter(name => !seen.has(name));
const LEGACY_LINE_CASES = ['有時間與地點的舊出發行', '只有時間的舊出發行', '沒有時間的舊出發行'];
const PARTICIPANT_CASES = ['全體旅伴的活動', '旅伴名單包含每一位旅伴的活動', '指定車輛的活動', '列出旅伴的活動'];
const ITINERARY_CASES = Object.freeze([
  '有出發時間的路線', '沒有出發時間的路線', '沒有 Stop 的路線', '6 個 Stop 的路線', '使用旅行目的地的路線',
  '有 Shopping_Summary 的採買 Stop', 'Shopping_Summary 為空字串的 First_Shopping_Stop', '不是 First_Shopping_Stop 的採買 Stop',
  'Shopping_Summary 略去空白或重複的品項名稱', '有備註的採買 Stop（備註不輸出）',
  ...[...TASK.values()].filter(task => task !== '採買').flatMap(task => [`有備註的${task} Stop`, `沒有備註的${task} Stop`]),
  ...LEGACY_LINE_CASES,
  ...[...CATEGORY.values()].map(label => `類別 ${label}`), '空白標題的活動',
  '有「地點：」行的活動', '地點與 Day_Location 同名的活動', ...PARTICIPANT_CASES, '有備註的活動',
  '有食材行的餐點', '沒有食材的餐點', '「{餐次}：{料理名稱}」的餐點', '料理名稱空白或與餐次相同的餐點',
  'Meal_Label 為火鍋', 'Meal_Label 為烤肉', 'Meal_Label 為餐次',
  '自訂時間的餐點', '使用餐次預設時間的餐點', '其他舊資料餐次的餐點', '時間相同的活動與餐點',
  '有地點行的日子', '沒有地點行的日子'
]);

describe('Property 4: 文字版的項目行與資料一一對應', () => {
  test('itineraryState()：每條路線、舊出發資料、活動與餐點在其日期的段落中恰有一個相符的行', () => {
    const seen = new Set();
    fc.assert(fc.property(itineraryState(), state => {
      expect(isValidState(state)).toBe(true); // 需求 23.3：先確認 State_Validator 接受每一組
      checkState(state, seen);
    }), bounded(200));
    expect(missing(seen, ITINERARY_CASES)).toEqual([]);
  }, TIMEOUT);

  test('使用者文字與識別碼為 HTML 標記、字元參照與 XSS 字串：各行原樣輸出，不跳脫', () => {
    const seen = new Set();
    fc.assert(fc.property(itineraryState({ markup: true }), state => {
      expect(isValidState(state)).toBe(true);
      checkState(state, seen);
    }), bounded(100));
    expect(missing(seen, ['含標記字元的路線行', '含標記字元的舊出發行', '含標記字元的項目行', '含標記字元的補充行'])).toEqual([]);
  }, TIMEOUT);

  test('legacyState()：本功能之前的 Trip_State 的活動與舊出發資料', () => {
    const seen = new Set();
    fc.assert(fc.property(legacyState(), state => {
      fc.pre(isValidState(state));
      checkState(state, seen);
    }), bounded(100));
    expect(missing(seen, [
      ...LEGACY_LINE_CASES, ...LEGACY_TYPES.map(type => `類別 ${CATEGORY.get(type)}`), ...PARTICIPANT_CASES,
      '有「地點：」行的活動', '地點與 Day_Location 同名的活動', '有備註的活動', '有食材行的餐點'
    ])).toEqual([]);
  }, TIMEOUT);

  test('本檔依條文寫出的預期行與需求文件的 Example_Text 相符', () => {
    const seen = new Set();
    checkText(exampleTrip(), EXAMPLE_TEXT, seen);
    expect(missing(seen, [
      '有 Shopping_Summary 的採買 Stop', '有食材行的餐點', 'Meal_Label 為火鍋', 'Meal_Label 為烤肉', 'Meal_Label 為餐次'
    ])).toEqual([]);
  });
});
