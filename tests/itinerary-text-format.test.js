// Feature: trip-planning-workflow-enhance, Property 5: 文字版的格式固定，且只由資料決定
// **Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.11, 14.12, 14.14, 14.16, 14.18, 23.1, 23.3**
//
// 對每一組通過驗證的 Trip_State s，檢查 itineraryText(s)。
// 格式固定：
// - 需求 14.1：只以 LF 分行（沒有 CR、U+000B、U+000C、U+0085、U+2028、U+2029），第一行與最後一行都不是空行、最後沒有換行
//   字元，沒有連續兩個空行；依序只有標題行、旅行介紹段落、車輛行與每個 Trip_Day 一個段落，相鄰兩部分之間恰好一個空行。
// - 需求 14.16：每一行都已是處理後的樣子：前後沒有 White_Space，也沒有含換行字元的連續空白；所以空行不含任何字元，
//   除了旅行介紹的段落外每一行也都不含換行類字元（旅行介紹本身依換行字元分成段落）。
// - 需求 14.2 至 14.4：第一行是「{旅行名稱}｜{Duration_Text}」（旅行名稱處理後為空時只有 Duration_Text），Duration_Text 依
//   天數；旅行介紹的每個非空白行去除前後空白後各成一段；有車時是「車輛：{車名、…}」（依 state.vehicles 的順序），沒有車
//   時沒有車輛行。
// - 需求 14.5 至 14.7：每個段落的第一行是「第 {N} 天・{月}/{日}（週{星期}）｜{Day_Title}」（沒有 Day_Title 時省略「｜…」），
//   月與日不補零，星期以本檔的公曆公式算出；有 Day_Location 時第二行是「地點：{名稱}」，沒有時沒有地點行；之後每個區塊
//   之前恰好一個空行，以「路線」或「活動」開始，沒有空的區塊，也沒有相鄰的兩個活動區塊；沒有任何 Route、舊出發資料、
//   Activity 與 Meal 的日子只有第一行與地點行。
// - 需求 14.11、14.12、14.15：Arrival 區塊（Arrival_Routes 與 First_Day 的舊出發行）與 Other 區塊（其他路線）有內容時各是
//   一個路線區塊，路線行與舊出發行數相符；到達行只在有 Arrival_Routes 時出現，恰好一行、是 Arrival 區塊的最後一行，
//   文字為「預計 {HH:MM} 抵達」或「預計抵達時間待定」，Arrival_Routes 至少兩條時接上「・{N}車會合」，N 是 Arrival_Routes
//   數的 Chinese_Numeral（舊出發行不計入）；返程行只在 Last_Day 的 Other 區塊有終點不是 Day_Location 的路線時出現，恰好
//   一行、是該區塊的最後一行，終點依需求 5.2 的路線順序、同一地點只列一次。
// - 需求 14.14：活動區塊中，項目行（「HH:MM 」開頭、「）」結尾）之後接該項目的補充行；有補充行的項目不是區塊最後一個項目
//   時接一個空行，其他位置沒有空行；項目行總數等於當天的 Activity 與 Meal 數。
// 只由資料決定（需求 14.18(b)、23.3）：
// - s 與 structuredClone(s) 各產生兩次，四次逐字相同；JSON 往返後物件鍵的順序相反並深度凍結的副本（JSON 值相等，凍結後
//   任何修改都會擲出例外）也相同；s 沒有被修改。
// - 只改變文字版不輸出的欄位（旅行小叮嚀、Activity 的完成狀態、料理的主廚、份數與料理筆記、採買 Stop 的備註，以及
//   revision、目前使用者、旅伴的角色與顏色、採買品項的數量與是否已買、裝備、動態等）後文字相同；沒有任何一行等於
//   planningWarnings() 的 Planning_Warning。
// - 時區（需求 23.1）：先確認執行中把 process.env.TZ 設為 Etc/UTC、Asia/Taipei、America/Los_Angeles 後，
//   new Date(0).getTimezoneOffset() 確實依序為 0、−480、480（之後每次切換也再確認一次）。支援時，每一組都在三個時區各產生
//   一次，結果都必須與第一次相同。不支援執行中切換時，屬性中不切換時區，由最後一個測試在三個以 TZ 環境變數啟動的子行程
//   （Bun.spawn）中產生同一批 Trip_State 的文字，與本行程的結果逐字比較。這個測試在支援時也執行：子行程在啟動前就設定好
//   時區，最接近「裝置在另一個時區」，也讓這段替代做法每次都被執行到。
// - 目前時間與語系：每一組另外在 MIXED_ENVIRONMENTS 五種組合之一（屬性的另一個輸入，每個測試都確認五種都出現）的
//   時區、目前時間（bun:test 的 setSystemTime()）與預設語系下產生一次。Bun 的預設語系在啟動時決定，Windows 上也不依
//   LANG／LC_ALL，無法在執行中切換；改為在產生期間讓依預設語系運作的內建函式（String 的 localeCompare、
//   toLocaleLowerCase、toLocaleUpperCase，Number、BigInt、Date 與 Array 的 toLocale*String，以及 Intl 的建構子）在沒有
//   指定語系時改用指定的語系，結束後還原。
// 預期的內容在本檔依條文獨立寫出：需求 14.16 的空白處理、Chinese_Numeral 與 Duration_Text、公曆的星期、Day_Location、
// Arrival_Routes 與 Other_Routes 的劃分、需求 5.2 的路線順序與到達行、返程行的文字。只沿用條文指定的規則來源：Trip_Day
// 依 dateRange()（State_Validator 的日期範圍），舊出發資料依 parseVehicleMeeting()（需求 14.15、19.7）。
//
// 四個屬性測試使用不同的產生器：itineraryState()（需求 23.3 的值域，200 組）、使用者文字與識別碼為標記文字的變體、
// endMixState()（同一個路線區塊有多個終點組，First_Day 的 Arrival 區塊夾著舊出發行）與 legacyState()（本功能之前的
// Trip_State），各 100 組。每個測試另外確認列出的情況至少出現一次；依產生器的機率，每一種情況在該測試的組數中都幾乎
// 必然出現（沒出現的機率都低於千萬分之一）。
import { describe, expect, setSystemTime, test } from 'bun:test';
import fc from 'fast-check';

import { planningWarnings } from '../src/itinerary-derive.js';
import { DESTINATION_REF } from '../src/itinerary-model.js';
import { itineraryText } from '../src/itinerary-text.js';
import { COLORS, dateRange, isValidState } from '../src/model.js';
import { parseVehicleMeeting } from '../src/vehicle-departures.js';
import { endMixState, itineraryState, legacyState } from './support/itinerary-arb.js';

// fc.gen() 產生的 Trip_State 很大，屬性失敗時縮小可能要好幾分鐘，而 bun test 無法中斷同步執行的測試，所以 30 秒後
// 停止縮小並回報目前的反例；尚未跑完全部組數就到時間也算失敗（failOnInterrupt）。bun test 不顯示錯誤的 cause，所以把
// 不符合的規則、行號與文字放進回報的訊息（includeErrorInReport）。
const bounded = numRuns => ({
  numRuns, includeErrorInReport: true, plugins: [fc.interruptAfterTimeLimit(30_000, { failOnInterrupt: true })]
});
const TIMEOUT = 60_000;

// ---- 固定字元（需求 14.19，以碼位寫出） ----
const LF = '\n';
const BAR = '\uFF5C';   // ｜
const DOT = '\u30FB';   // ・
const COLON = '\uFF1A'; // ：
const OPEN = '\uFF08';  // （
const CLOSE = '\uFF09'; // ）
const COMMA = '\u3001'; // 、
const ROUTES = '路線', MOMENTS = '活動';

// ---- 本檔獨立撰寫的規則 ----
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
/** HH:MM；沒有時間（省略或空字串）時為 ''。 */
const hhmm = value => (typeof value === 'string' && TIME.test(value) ? value : '');
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// 需求 14.16 的換行字元，以及其中 LF 以外的字元
const BREAK = /[\r\n\u000B\u000C\u0085\u2028\u2029]/u;
const NOT_LF = /[\r\u000B\u000C\u0085\u2028\u2029]/u;
const NOT_LF_ALL = /[\r\u000B\u000C\u0085\u2028\u2029]/gu;
/** 去除前後的 Unicode White_Space（含全形空白、換行與 Tab）。 */
const trimmed = text => String(text ?? '').replace(/^\p{White_Space}+/u, '').replace(/\p{White_Space}+$/u, '');
/** 需求 14.16：去除前後的空白，再把每一段含換行字元的連續空白換成一個半形空白；其他字元原樣保留。 */
const clean = text => trimmed(text).replace(/\p{White_Space}+/gu, run => (BREAK.test(run) ? ' ' : run));
/** 需求 14.3：旅行介紹以換行字元分行，每行去除前後空白後捨棄空字串。 */
const paragraphsOf = text => String(text).split(BREAK).map(trimmed).filter(Boolean);

const DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
/** Chinese_Numeral（詞彙表）：1 到 99 寫作中文數字，單獨的 2 寫作「兩」、其他數值中的 2 寫作「二」；100 以上寫作阿拉伯數字。 */
function numeral(n) {
  if (n >= 100) return String(n);
  if (n === 2) return '兩';
  const tens = Math.floor(n / 10), ones = n % 10;
  return `${tens === 0 ? '' : tens === 1 ? '十' : `${DIGITS[tens]}十`}${DIGITS[ones]}`;
}
/** Duration_Text（詞彙表）：一天為「一日遊」，其他為「{天數}天{天數減 1}夜」。 */
const durationOf = days => (days === 1 ? '一日遊' : `${numeral(days)}天${numeral(days - 1)}夜`);

// 公曆：'YYYY-MM-DD' 是 1970-01-01 之後的第幾天（H. Hinnant 的 days_from_civil，0000 到 9999 年），不使用 Date。
const DAY_MS = 86_400_000;
function dayNumber(date) {
  const [year, month, day] = date.split('-').map(Number);
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400), yoe = y - era * 400;
  const doy = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
}
// 1970-01-01 是星期四；星期一至星期日依序寫作一、二、三、四、五、六、日（需求 14.5）。
const WEEK = '四五六日一二三';
const weekdayOf = date => WEEK[((dayNumber(date) % 7) + 7) % 7];
/** 不補零的「{月}/{日}」。 */
function monthDayOf(date) {
  const [, month, day] = date.split('-').map(Number);
  return `${month}/${day}`;
}

// ---- 每一天依條文應有的內容 ----
const dayKind = (index, count) => (count === 1 ? 'single' : index === 0 ? 'first' : index === count - 1 ? 'last' : 'middle');
/** 地點引用值的名稱：'@destination' 是旅行目的地，其他是 Place 的名稱。 */
const placeName = (state, ref) => (ref === DESTINATION_REF ? state.trip.destination : (state.places ?? []).find(place => place.id === ref).name);
/** Day_Location（詞彙表、D17）：Day_Settings 設定的 Place；未設定時是非空白的旅行目的地，否則沒有 Day_Location。 */
function dayLocationOf(state, setting) {
  if (typeof setting?.place === 'string' && setting.place !== '') return { ref: setting.place, name: placeName(state, setting.place) };
  return trimmed(state.trip.destination) ? { ref: DESTINATION_REF, name: state.trip.destination } : null;
}
/** 第 n 天（日期 date，kind 為 first、middle、last 或 single）的第一行、地點行、到達行與返程行，以及區塊的行數。 */
function expectedDay(state, date, n, kind) {
  const setting = (state.daySettings ?? []).find(item => item.date === date);
  const title = clean(setting?.title ?? '');
  const location = dayLocationOf(state, setting);
  const order = new Map(state.vehicles.map((vehicle, index) => [vehicle.id, index]));
  // 需求 5.2：有出發時間的在前、由早到晚；時間相同或都沒有時依車輛在 state.vehicles 的順序。
  const routes = (state.routes ?? []).filter(route => route.date === date)
    .map(route => ({ route, time: hhmm(route.time), order: order.get(route.vehicleId) }))
    .sort((a, b) => (a.time === '') - (b.time === '') || compare(a.time, b.time) || a.order - b.order)
    .map(entry => entry.route);
  // Arrival_Routes：終點是 Day_Location、起點不是 Day_Location；沒有 Day_Location 時每一條都是 Other_Routes。
  const arriving = route => location !== null && route.to === location.ref && route.from !== location.ref;
  const arrivalRoutes = routes.filter(arriving), otherRoutes = routes.filter(route => !arriving(route));
  // 需求 14.15：First_Day 沒有路線、`meeting` 拆得出時間或地點的車，各有一個舊出發行。
  const legacy = kind === 'first' || kind === 'single'
    ? state.vehicles.filter(vehicle => !routes.some(route => route.vehicleId === vehicle.id)).filter(vehicle => {
      const { time, location: place } = parseVehicleMeeting(vehicle.meeting);
      return Boolean(time || place);
    }).length
    : 0;
  const arrival = hhmm(setting?.arrival), meeting = arrivalRoutes.length;
  // 需求 14.12：Last_Day 的 Other 區塊中終點不是 Day_Location 的路線的終點，依路線行的順序、同一地點只列一次。
  const homes = kind === 'last' || kind === 'single'
    ? [...new Set(otherRoutes.map(route => route.to).filter(ref => location === null || ref !== location.ref))]
    : [];
  return {
    header: `第 ${n} 天${DOT}${monthDayOf(date)}${OPEN}週${weekdayOf(date)}${CLOSE}${title ? `${BAR}${title}` : ''}`,
    locationLine: location ? `地點${COLON}${clean(location.name)}` : null,
    arrivalLine: meeting ? `${arrival ? `預計 ${arrival} 抵達` : '預計抵達時間待定'}${meeting >= 2 ? `${DOT}${numeral(meeting)}車會合` : ''}` : null,
    returnLine: homes.length ? `平安返回${homes.map(ref => clean(placeName(state, ref))).join(COMMA)}${DOT}不預估返抵時間` : null,
    // Arrival 區塊與 Other 區塊的路線行與舊出發行數（不含到達行與返程行），以及當天的 Activity 與 Meal 數
    arrivalLines: arrivalRoutes.length + legacy,
    otherLines: otherRoutes.length,
    items: state.activities.filter(activity => activity.date === date).length + state.meals.filter(meal => meal.date === date).length,
    weekday: weekdayOf(date), title, location, arrival, meeting, legacy, homes
  };
}

// ---- 文字版的格式 ----
const ITEM_LINE = /^(?:[01]\d|2[0-3]):[0-5]\d .*\uFF09$/u;
const ARRIVAL_LINE = /^預計(?: (?:[01]\d|2[0-3]):[0-5]\d 抵達|抵達時間待定)(?:\u30FB[^\uFF5C\uFF1A]*車會合)?$/u;
const RETURN_LINE = /^平安返回.*\u30FB不預估返抵時間$/u;
const codePoint = char => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * 依需求 14.1 至 14.7、14.16 比對 text 的各部分，路線區塊與活動區塊交給 checkBlocks()。回傳 { problems, tags }：
 * problems 是不符合的規則與位置（行號從 1 起算），tags 是這一組出現的情況。部分的順序或內容不符時停在第一個不符的位置。
 */
function formatProblems(state, text) {
  const problems = [], tags = new Set();
  const fail = (rule, detail) => problems.push(`${rule}：${JSON.stringify(detail)}`);
  const lines = text.split(LF);

  // 需求 14.1 與 14.16：分行與每一行的空白
  const breaks = [...text.matchAll(NOT_LF_ALL)].map(match => `${codePoint(match[0])} @ ${match.index}`);
  if (breaks.length) fail('需求 14.1：只以 LF 分行', breaks.slice(0, 5));
  if (lines[0] === '') fail('需求 14.1：第一行不是空行', lines.slice(0, 2));
  if (lines.at(-1) === '') fail('需求 14.1：最後一行不是空行，最後沒有換行字元', lines.slice(-2));
  lines.forEach((line, i) => {
    if (line === '' && lines[i + 1] === '') fail('需求 14.1：沒有連續兩個空行', { line: i + 1 });
    if (clean(line) !== line) fail('需求 14.16：每一行前後沒有空白，也沒有含換行字元的空白', { line: i + 1, text: line });
  });

  let i = 0;
  const take = (want, rule) => {
    if (lines[i] === want) {
      i++;
      return true;
    }
    fail(rule, { line: i + 1, want, got: lines[i] ?? null });
    return false;
  };
  // 相鄰兩部分之間恰好一個空行（需求 14.1）
  const part = (want, rule) => take('', `${rule}之前恰好一個空行`) && take(want, rule);
  const result = () => ({ problems, tags });

  // 需求 14.2 至 14.4：標題行、旅行介紹段落、車輛行
  const days = dateRange(state.trip.startDate, state.trip.endDate);
  const title = clean(state.trip.title), duration = durationOf(days.length);
  tags.add(title ? '標題行有旅行名稱' : '旅行名稱處理後為空，標題行只有 Duration_Text');
  if (days.length === 1 || days.length === 31) tags.add(`${days.length} 天的旅行`);
  if (!take(title ? `${title}${BAR}${duration}` : duration, '需求 14.2：標題行')) return result();
  const paragraphs = paragraphsOf(state.trip.description);
  tags.add(paragraphs.length === 0 ? '沒有旅行介紹段落' : paragraphs.length === 1 ? '一段旅行介紹' : '兩段以上的旅行介紹');
  if (paragraphs.length > 1 && NOT_LF.test(state.trip.description)) tags.add('旅行介紹以 LF 以外的換行字元分段');
  for (const paragraph of paragraphs) if (!part(paragraph, '需求 14.3：旅行介紹段落')) return result();
  tags.add(state.vehicles.length ? '有車輛行' : '沒有車，也沒有車輛行');
  if (state.vehicles.length && !part(`車輛${COLON}${state.vehicles.map(vehicle => clean(vehicle.name)).join(COMMA)}`, '需求 14.4：車輛行')) return result();

  // 需求 14.5 至 14.7：每一天的段落
  const wants = days.map((date, k) => expectedDay(state, date, k + 1, dayKind(k, days.length)));
  for (const [k, want] of wants.entries()) {
    const day = `第 ${k + 1} 天`;
    tags.add(`星期${want.weekday}`);
    tags.add(want.title ? '有 Day_Title 的日子' : '沒有 Day_Title 的日子');
    tags.add(want.location ? '有地點行的日子' : '沒有 Day_Location 的日子');
    if (!part(want.header, `需求 14.5：${day}的第一行`)) return result();
    if (want.locationLine !== null && !take(want.locationLine, `需求 14.6：${day}的地點行`)) return result();
    if (want.locationLine === null && lines[i]?.startsWith(`地點${COLON}`)) {
      fail(`需求 14.6：${day}沒有 Day_Location，沒有地點行`, { line: i + 1, got: lines[i] });
      return result();
    }
    // 段落在下一天的「空行、第一行」之前結束；區塊在下一個「空行、路線／活動」或段落結束處結束。活動區塊中的空行之後是
    // 以「HH:MM 」開頭的項目行，不會是「路線」「活動」或以「第 」開頭的第一行，所以不會被當成區塊或段落的分界。
    const next = wants[k + 1]?.header;
    const dayEnds = () => i >= lines.length || (next !== undefined && lines[i] === '' && lines[i + 1] === next);
    const blockEnds = () => dayEnds() || (lines[i] === '' && (lines[i + 1] === ROUTES || lines[i + 1] === MOMENTS));
    const blocks = [];
    while (!dayEnds()) {
      if (lines[i] !== '' || (lines[i + 1] !== ROUTES && lines[i + 1] !== MOMENTS)) {
        fail(`需求 14.7：${day}的每個區塊之前恰好一個空行，並以「路線」或「活動」開始`, { line: i + 1, got: lines.slice(i, i + 2) });
        return result();
      }
      const kind = lines[i + 1];
      i += 2;
      const start = i;
      while (!blockEnds()) i++;
      blocks.push({ kind, start, lines: lines.slice(start, i) });
    }
    checkBlocks(day, want, blocks, fail, tags);
  }
  if (i < lines.length) fail('需求 14.1：最後一天的段落之後沒有其他內容', { line: i + 1, got: lines.slice(i, i + 3) });
  return result();
}

/** 一天的區塊：路線區塊依需求 14.7、14.11、14.12、14.15，活動區塊依需求 14.13、14.14。start 是區塊第一行內容的索引。 */
function checkBlocks(day, want, blocks, fail, tags) {
  blocks.forEach((block, j) => {
    if (!block.lines.length) fail(`需求 14.7：${day}沒有空的區塊`, { line: block.start, kind: block.kind });
    if (j > 0 && block.kind === MOMENTS && blocks[j - 1].kind === MOMENTS) fail(`需求 14.8(e)：${day}沒有相鄰的兩個活動區塊`, { line: block.start });
  });
  if (!blocks.length) tags.add('沒有任何區塊的日子');

  // 路線區塊：路線行與舊出發行，到達行或返程行只可能是最後一行。Arrival 區塊以到達行結束（只有舊出發行時沒有），
  // Other 區塊在 Last_Day 有終點不是 Day_Location 的路線時以返程行結束；以（行數、最後一行）比對兩個區塊。
  const closing = line => line === want.arrivalLine || line === want.returnLine || ARRIVAL_LINE.test(line) || RETURN_LINE.test(line);
  const routeBlocks = blocks.filter(block => block.kind === ROUTES);
  const got = routeBlocks.map(block => {
    const last = block.lines.at(-1);
    const end = last !== undefined && closing(last) ? last : null;
    const body = end === null ? block.lines : block.lines.slice(0, -1);
    const misplaced = body.filter(closing);
    if (misplaced.length) fail(`需求 14.11、14.12：${day}的到達行與返程行只在路線區塊的最後一行`, { line: block.start, misplaced });
    return { lines: body.length, closing: end };
  });
  const expected = [
    ...(want.arrivalLines ? [{ lines: want.arrivalLines, closing: want.arrivalLine }] : []),
    ...(want.otherLines ? [{ lines: want.otherLines, closing: want.returnLine }] : [])
  ];
  const keys = list => list.map(entry => JSON.stringify([entry.lines, entry.closing])).sort();
  if (JSON.stringify(keys(got)) !== JSON.stringify(keys(expected))) {
    fail(`需求 14.7、14.11、14.12、14.15：${day}的路線區塊（路線行與舊出發行數，以及最後的到達行或返程行）`, { want: expected, got });
  }
  if (routeBlocks.length === 2) tags.add('兩個路線區塊的日子');
  if (want.arrivalLine) {
    tags.add(want.arrival ? '到達行：預計 {HH:MM} 抵達' : '到達行：預計抵達時間待定');
    tags.add(want.meeting >= 2 ? '到達行：兩車以上會合' : '到達行：一條 Arrival_Route，沒有會合');
    if (want.legacy) tags.add('舊出發行與 Arrival_Routes 在同一個路線區塊');
  } else if (want.arrivalLines) tags.add('只有舊出發行的路線區塊，沒有到達行');
  if (want.returnLine) {
    tags.add('返程行');
    if (want.homes.length >= 2) tags.add('返程行有兩個以上的終點');
    if (!want.location) tags.add('Last_Day 沒有 Day_Location 的返程行');
  } else if (want.otherLines) tags.add('Other 區塊沒有返程行');

  // 活動區塊：每一行是項目行、補充行或空行
  let items = 0;
  for (const block of blocks.filter(item => item.kind === MOMENTS)) {
    const kinds = block.lines.map(line => (line === '' ? 'blank' : ITEM_LINE.test(line) ? 'item' : 'extra'));
    kinds.forEach((kind, j) => {
      const at = { line: block.start + j + 1, text: block.lines[j] };
      if (j === 0 && kind !== 'item') fail(`需求 14.7、14.13：${day}的活動區塊以項目行開始`, at);
      if (kind === 'blank' && kinds[j - 1] !== 'extra') fail(`需求 14.14：${day}的空行只接在補充行之後`, at);
      if (kind === 'blank' && kinds[j + 1] !== 'item') fail(`需求 14.14：${day}的空行之後是同一個區塊的下一個項目行`, at);
      if (kind === 'item' && kinds[j - 1] === 'extra') fail(`需求 14.14：${day}有補充行的項目不是區塊最後一個項目時，之後接一個空行`, at);
      if (kind === 'blank') tags.add('有補充行的項目之後接一個空行');
      if (kind === 'item' && kinds[j - 1] === 'item') tags.add('沒有補充行的項目之後直接接下一個項目');
    });
    if (kinds.at(-1) === 'extra') tags.add('區塊最後一個項目有補充行，之後沒有空行');
    items += kinds.filter(kind => kind === 'item').length;
  }
  if (items !== want.items) fail(`需求 14.7、14.13：${day}的項目行數等於當天的 Activity 與 Meal 數`, { want: want.items, got: items });
}

// ---- 只由資料決定 ----
const ZONES = Object.freeze([['Etc/UTC', 0], ['Asia/Taipei', -480], ['America/Los_Angeles', 480]]);
const ZONE_OFFSET = new Map(ZONES);
const START_TZ = process.env.TZ;
const START_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const START_OFFSET = new Date(0).getTimezoneOffset();
/** 還原開始時的時區。bun test 沒有設定 TZ 時以 UTC 執行，而刪除 TZ 會改用作業系統的時區，所以改設為開始時的時區名稱。 */
const restoreZone = () => { process.env.TZ = START_TZ ?? START_ZONE; };
/** 執行中依序把 process.env.TZ 設為三個時區時 new Date(0).getTimezoneOffset() 的值。 */
function switchedOffsets() {
  try {
    return ZONES.map(([zone]) => {
      process.env.TZ = zone;
      return new Date(0).getTimezoneOffset();
    });
  } finally {
    restoreZone();
  }
}
const OFFSETS = switchedOffsets();
/** 執行環境支援執行中切換時區：三個時區的 getTimezoneOffset() 都符合。 */
const SWITCHABLE = ZONES.every(([, offset], index) => OFFSETS[index] === offset);

// 依預設語系運作的內建函式與 locales 參數的位置，以及 Intl 的建構子（第一個參數是 locales）。
const LOCALE_METHODS = Object.freeze([
  [String.prototype, [['localeCompare', 1], ['toLocaleLowerCase', 0], ['toLocaleUpperCase', 0]]],
  [Number.prototype, [['toLocaleString', 0]]],
  [BigInt.prototype, [['toLocaleString', 0]]],
  [Date.prototype, [['toLocaleString', 0], ['toLocaleDateString', 0], ['toLocaleTimeString', 0]]],
  [Array.prototype, [['toLocaleString', 0]]]
]);
const INTL_CONSTRUCTORS = Object.freeze(['Collator', 'DateTimeFormat', 'DisplayNames', 'ListFormat', 'NumberFormat', 'PluralRules', 'RelativeTimeFormat', 'Segmenter']);
const isDefaultLocale = locales => locales === undefined || (Array.isArray(locales) && locales.length === 0);
/** 讓上述函式在沒有指定語系時改用 locale（模擬裝置的預設語系）；回傳還原的函式。 */
function simulateLocale(locale) {
  const saved = [];
  const replace = (target, key, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    saved.push([target, key, descriptor]);
    Object.defineProperty(target, key, { ...descriptor, value });
  };
  for (const [prototype, methods] of LOCALE_METHODS) {
    for (const [name, at] of methods) {
      const original = prototype[name];
      replace(prototype, name, function withDefaultLocale(...args) {
        if (isDefaultLocale(args[at])) args[at] = locale;
        return Reflect.apply(original, this, args);
      });
    }
  }
  const withLocale = args => (isDefaultLocale(args[0]) ? [locale, ...args.slice(1)] : args);
  for (const name of INTL_CONSTRUCTORS) {
    if (typeof Intl[name] !== 'function') continue;
    replace(Intl, name, new Proxy(Intl[name], {
      construct: (target, args, newTarget) => Reflect.construct(target, withLocale(args), newTarget),
      apply: (target, thisArg, args) => Reflect.apply(target, thisArg, withLocale(args))
    }));
  }
  return () => {
    for (const [target, key, descriptor] of saved.reverse()) Object.defineProperty(target, key, descriptor);
  };
}

// 時區、目前時間（當地的午夜前後、閏日與很遠的年份）與預設語系（中文、阿拉伯數字字形、土耳其語的大小寫、泰國佛曆、
// 日本年號）的組合；每一組在其中一種下產生（屬性的輸入）。
const MIXED_ENVIRONMENTS = Object.freeze([
  { zone: 'Asia/Taipei', clock: '2026-10-19T16:00:00.000Z', locale: 'zh-TW' },
  { zone: 'America/Los_Angeles', clock: '2026-10-21T06:59:59.000Z', locale: 'ar-EG' },
  { zone: 'Etc/UTC', clock: '2000-02-29T12:00:00.000Z', locale: 'tr-TR' },
  { clock: '9999-12-31T23:59:59.000Z', locale: 'th-TH-u-ca-buddhist-nu-thai' },
  { clock: '1989-01-07T15:00:00.000Z', locale: 'ja-JP-u-ca-japanese' }
]);
const environmentName = env => [env.zone ?? '原本的時區', env.clock ?? '目前時間', env.locale ?? '原本的語系'].join('、');
const ENVIRONMENT_TAGS = Object.freeze(MIXED_ENVIRONMENTS.map(env => `在「${environmentName(env)}」下產生`));
/** 在 env 的時區（執行環境支援時）、目前時間與預設語系下執行 fn，結束後全部還原。 */
function inEnvironment(env, fn) {
  const zone = SWITCHABLE ? env.zone : undefined;
  let restoreLocale = null;
  try {
    if (zone !== undefined) {
      process.env.TZ = zone;
      const offset = new Date(0).getTimezoneOffset();
      if (offset !== ZONE_OFFSET.get(zone)) throw new Error(`（測試本身）切換到 ${zone} 後 getTimezoneOffset() 為 ${offset}`);
    }
    if (env.clock !== undefined) setSystemTime(new Date(env.clock));
    if (env.locale !== undefined) restoreLocale = simulateLocale(env.locale);
    return fn();
  } finally {
    restoreLocale?.();
    if (env.clock !== undefined) setSystemTime();
    if (zone !== undefined) restoreZone();
  }
}

/** 物件鍵的順序相反的深拷貝（JSON 值相等）。 */
const reversedKeys = value => (Array.isArray(value) ? value.map(reversedKeys)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversedKeys(item)]))
    : value);
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
/**
 * 只改變文字版不輸出的欄位的深拷貝，每個欄位都換成其他有效值：需求 14.1 列出的旅行小叮嚀、Activity 的完成狀態、
 * 料理的主廚、份數與料理筆記，需求 14.10 的採買 Stop 備註，以及需求 14 沒有列出的 revision、joined、目前使用者、動態、
 * 出發狀態、裝備、旅伴的角色與顏色、採買品項的數量與是否已買（Stop_Items 包含已買齊的品項，需求 6.11）。
 */
function withHiddenChanges(state) {
  const s = structuredClone(state);
  const ids = s.people.map(person => person.id);
  s.trip.note = s.trip.note ? '' : '旅行小叮嚀：<b>A&B</b>\n記得帶保暖外套。';
  s.revision += 1;
  s.joined = !s.joined;
  s.currentUser = ids[(ids.indexOf(s.currentUser) + 1) % ids.length];
  s.events = s.events.length ? [] : [{ id: 'hidden-event', text: '更新了行程', at: '2026-01-01T00:00:00.000Z', actor: s.people[0].name }];
  s.departed = s.departed.length ? [] : [...ids];
  s.gear = [];
  for (const person of s.people) {
    person.role = person.role ? '' : '料理小隊長';
    person.color = COLORS[(COLORS.indexOf(person.color) + 1) % COLORS.length];
  }
  for (const activity of s.activities) activity.done = !activity.done;
  s.meals.forEach((meal, index) => {
    meal.cookId = meal.cookId ? '' : ids[index % ids.length];
    meal.servings = (meal.servings % 100) + 1;
    meal.notes = meal.notes ? '' : '料理筆記：<b>A&B</b>\n先煎再煮。';
  });
  for (const item of s.shopping) {
    item.done = !item.done;
    item.quantity = item.quantity ? '' : '3 包';
  }
  for (const route of s.routes ?? []) {
    for (const stop of route.stops ?? []) if (stop.kind === 'shop') stop.note = stop.note ? '' : '採買 Stop 的備註';
  }
  return s;
}
/** want 與 got 第一個不同的行。 */
function difference(want, got) {
  const a = want.split(LF), b = String(got).split(LF);
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return JSON.stringify({ line: k + 1, want: a[k] ?? null, got: b[k] ?? null, wantLines: a.length, gotLines: b.length });
}
/**
 * 需求 14.18(b)：與 text 不同的產生結果。JSON 值相等的副本、只改變不輸出欄位的副本、三個時區（執行環境支援執行中切換
 * 時），以及 env 的時區、目前時間與預設語系。
 */
function stabilityProblems(state, text, env) {
  const problems = [];
  const same = (label, produce) => {
    let got;
    try {
      got = produce();
    } catch (error) {
      problems.push(`${label}：擲出 ${error}`);
      return;
    }
    if (got !== text) problems.push(`需求 14.18(b)：${label}的文字不同：${difference(text, got)}`);
  };
  same('同一個 Trip_State 第二次產生', () => itineraryText(state));
  const copy = structuredClone(state);
  same('structuredClone() 的副本第一次產生', () => itineraryText(copy));
  same('structuredClone() 的副本第二次產生', () => itineraryText(copy));
  same('JSON 往返後物件鍵的順序相反並深度凍結的副本', () => itineraryText(deepFreeze(reversedKeys(JSON.parse(JSON.stringify(state))))));
  const hidden = withHiddenChanges(state);
  if (!isValidState(hidden)) problems.push('（測試本身）只改變不輸出欄位的副本沒有通過驗證');
  else same('只改變文字版不輸出的欄位後', () => itineraryText(hidden));
  if (SWITCHABLE) for (const [zone] of ZONES) same(`在 ${zone} 時區`, () => inEnvironment({ zone }, () => itineraryText(state)));
  same(`在「${environmentName(env)}」下`, () => inEnvironment(env, () => itineraryText(state)));
  return problems;
}
/** 需求 14.1：文字版不包含 Planning_Warning。 */
function warningProblems(state, text) {
  const warnings = new Set([...planningWarnings(state).values()].flat());
  const leaked = text.split(LF).filter(line => warnings.has(line));
  return leaked.length ? [`需求 14.1：文字版不包含 Planning_Warning：${JSON.stringify(leaked)}`] : [];
}

// ---- 屬性 ----
/** 屬性本身：s 在 env 的目前時間與語系下也一樣；回傳這一組出現的情況。 */
function checkState(state, env) {
  const snapshot = structuredClone(state);
  const text = itineraryText(state);
  expect(typeof text).toBe('string');
  const { problems, tags } = formatProblems(state, text);
  problems.push(...stabilityProblems(state, text, env), ...warningProblems(state, text));
  expect({ problems }).toEqual({ problems: [] });
  // 每一次產生都只讀取輸入
  expect(state).toStrictEqual(snapshot);
  tags.add(ENVIRONMENT_TAGS[MIXED_ENVIRONMENTS.indexOf(env)]);
  return tags;
}
/** 以 arb 的每一組通過驗證的 Trip_State 執行屬性，回傳出現過的情況。 */
function run(arb, numRuns) {
  const seen = new Set();
  fc.assert(fc.property(arb, fc.constantFrom(...MIXED_ENVIRONMENTS), (state, env) => {
    fc.pre(isValidState(state));
    for (const tag of checkState(state, env)) seen.add(tag);
  }), bounded(numRuns));
  return seen;
}
const missing = (seen, required) => required.filter(tag => !seen.has(tag));

// ---- 子行程 ----
const TEXT_MODULE = new URL('../src/itinerary-text.js', import.meta.url).href;
// 從 stdin 讀入 Trip_State 的 JSON 陣列，輸出時區位移與每一組的文字版。
const CHILD_SCRIPT = [
  `const { itineraryText } = await import(${JSON.stringify(TEXT_MODULE)});`,
  'const states = JSON.parse(await Bun.stdin.text());',
  'process.stdout.write(JSON.stringify({ offset: new Date(0).getTimezoneOffset(), texts: states.map(state => itineraryText(state)) }));'
].join('\n');
/** 在以 TZ=zone 啟動的子行程中產生 input（Trip_State 的 JSON 陣列）的文字版。 */
async function textsInZone(zone, input) {
  const child = Bun.spawn([process.execPath, '-e', CHILD_SCRIPT], {
    env: { ...process.env, TZ: zone }, stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe'
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`TZ=${zone} 的子行程結束碼為 ${code}：${stderr.slice(0, 2000)}`);
  return JSON.parse(stdout);
}

describe('Property 5: 文字版的格式固定，且只由資料決定', () => {
  test('本檔的公曆星期、中文數字、時區切換、目前時間與語系模擬（測試本身的檢查）', () => {
    // 公曆的星期與 Date 相同（0000 到 9999 年）；Example_Text 的三天是週二、週三、週四
    const first = Date.parse('0000-01-01T00:00:00Z') / DAY_MS, last = Date.parse('9999-12-31T00:00:00Z') / DAY_MS;
    fc.assert(fc.property(fc.integer({ min: first, max: last }), number => {
      const date = new Date(number * DAY_MS).toISOString().slice(0, 10);
      expect({ date, weekday: weekdayOf(date) }).toEqual({ date, weekday: '日一二三四五六'[new Date(number * DAY_MS).getUTCDay()] });
      expect(dayNumber(date)).toBe(number);
    }), { numRuns: 1000, examples: [[first], [last], [0], [Date.parse('2000-02-29T00:00:00Z') / DAY_MS]] });
    expect(['2026-10-20', '2026-10-21', '2026-10-22'].map(weekdayOf)).toEqual(['二', '三', '四']);
    // Chinese_Numeral 與 Duration_Text 的詞彙表範例
    expect([1, 2, 3, 10, 11, 12, 20, 22, 31, 99, 100, 120].map(numeral))
      .toEqual(['一', '兩', '三', '十', '十一', '十二', '二十', '二十二', '三十一', '九十九', '100', '120']);
    expect([1, 2, 3, 31].map(durationOf)).toEqual(['一日遊', '兩天一夜', '三天兩夜', '三十一天三十夜']);

    // 時區：先確認的結果（不支援執行中切換時，由子行程的測試涵蓋三個時區）；支援時當地時間也跟著改變
    expect(OFFSETS.length).toBe(ZONES.length);
    if (SWITCHABLE) {
      const noon = Date.UTC(2026, 9, 20, 12);
      expect(ZONES.map(([zone]) => inEnvironment({ zone }, () => new Date(noon).getHours()))).toEqual([12, 20, 5]);
    }
    // 目前時間
    for (const clock of MIXED_ENVIRONMENTS.map(env => env.clock).filter(Boolean)) {
      expect({ clock, set: inEnvironment({ clock }, () => Math.abs(Date.now() - Date.parse(clock)) < 60_000) }).toEqual({ clock, set: true });
    }
    expect(Math.abs(Date.now() - (performance.timeOrigin + performance.now())) < 60_000).toBe(true);
    // 語系：沒有指定語系時的結果等於指定該語系的結果
    const builtins = [String.prototype.localeCompare, Number.prototype.toLocaleString, Date.prototype.toLocaleDateString, Intl.DateTimeFormat, Intl.Collator];
    for (const locale of MIXED_ENVIRONMENTS.map(env => env.locale).filter(Boolean)) {
      const sample = (pick = value => value) => ({
        dateTime: new Intl.DateTimeFormat(pick(locale)).resolvedOptions().locale,
        collator: Intl.Collator(pick(locale)).resolvedOptions().locale,
        number: (1234.5).toLocaleString(pick(locale)),
        date: new Date(Date.UTC(2026, 9, 20)).toLocaleDateString(pick(locale), { timeZone: 'UTC' }),
        lower: 'I'.toLocaleLowerCase(pick(locale)),
        order: 'a'.localeCompare('ä', pick(locale))
      });
      expect({ locale, ...inEnvironment({ locale }, () => sample(() => undefined)) }).toEqual({ locale, ...sample() });
    }
    expect([String.prototype.localeCompare, Number.prototype.toLocaleString, Date.prototype.toLocaleDateString, Intl.DateTimeFormat, Intl.Collator])
      .toEqual(builtins);
    // 全部還原
    expect({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone, offset: new Date(0).getTimezoneOffset() })
      .toEqual({ zone: START_ZONE, offset: START_OFFSET });
  });

  // 列出的情況在 200 組中最少見的是「Last_Day 沒有 Day_Location 的返程行」與「旅行名稱處理後為空」，每組約一成。
  test('itineraryState()：格式固定且只由資料決定，涵蓋標題、旅行介紹、車輛、每日段落、到達行、返程行與補充行的各種情況', () => {
    const seen = run(itineraryState(), 200);
    expect(missing(seen, [
      '標題行有旅行名稱', '旅行名稱處理後為空，標題行只有 Duration_Text', '1 天的旅行', '31 天的旅行',
      '沒有旅行介紹段落', '一段旅行介紹', '兩段以上的旅行介紹', '旅行介紹以 LF 以外的換行字元分段',
      '有車輛行', '沒有車，也沒有車輛行',
      ...[...'一二三四五六日'].map(weekday => `星期${weekday}`),
      '有 Day_Title 的日子', '沒有 Day_Title 的日子', '有地點行的日子', '沒有 Day_Location 的日子', '沒有任何區塊的日子',
      '兩個路線區塊的日子', '到達行：預計 {HH:MM} 抵達', '到達行：預計抵達時間待定', '到達行：兩車以上會合',
      '到達行：一條 Arrival_Route，沒有會合', '只有舊出發行的路線區塊，沒有到達行',
      '返程行', '返程行有兩個以上的終點', 'Last_Day 沒有 Day_Location 的返程行', 'Other 區塊沒有返程行',
      '有補充行的項目之後接一個空行', '沒有補充行的項目之後直接接下一個項目', '區塊最後一個項目有補充行，之後沒有空行',
      ...ENVIRONMENT_TAGS
    ])).toEqual([]);
  }, TIMEOUT);

  test('使用者文字與識別碼為標記文字（itineraryState({ markup: true })）', () => {
    const seen = run(itineraryState({ markup: true }), 100);
    expect(missing(seen, ENVIRONMENT_TAGS)).toEqual([]);
  }, TIMEOUT);

  test('endMixState()：同一個路線區塊有多個終點組，First_Day 的 Arrival 區塊夾著舊出發行', () => {
    const seen = run(endMixState().map(({ state }) => state), 100);
    expect(missing(seen, ['返程行有兩個以上的終點', '舊出發行與 Arrival_Routes 在同一個路線區塊', ...ENVIRONMENT_TAGS])).toEqual([]);
  }, TIMEOUT);

  test('legacyState()：本功能之前的 Trip_State（舊出發資料、舊活動類型與舊旅伴名單）', () => {
    const seen = run(legacyState(), 100);
    expect(missing(seen, ['只有舊出發行的路線區塊，沒有到達行', ...ENVIRONMENT_TAGS])).toEqual([]);
  }, TIMEOUT);

  test('以 TZ 環境變數啟動的三個子行程（Etc/UTC、Asia/Taipei、America/Los_Angeles）產生的文字與本行程逐字相同', async () => {
    const states = [
      ...fc.sample(itineraryState(), 60),
      ...fc.sample(itineraryState({ markup: true }), 20),
      ...fc.sample(endMixState(), 20).map(({ state }) => state),
      ...fc.sample(legacyState(), 20)
    ].filter(isValidState);
    expect(states.length).toBeGreaterThanOrEqual(100);
    const texts = states.map(state => itineraryText(state));
    const input = JSON.stringify(states);
    const results = await Promise.all(ZONES.map(([zone]) => textsInZone(zone, input)));
    results.forEach((result, index) => {
      const [zone, offset] = ZONES[index];
      // 子行程確實在該時區執行
      expect({ zone, offset: result.offset, count: result.texts.length }).toEqual({ zone, offset, count: texts.length });
      const differences = texts.flatMap((text, k) => (result.texts[k] === text ? [] : [{
        zone, state: k, difference: difference(text, result.texts[k]), json: JSON.stringify(states[k]).slice(0, 4000)
      }]));
      expect(differences).toEqual([]);
    });
  }, TIMEOUT);
});
