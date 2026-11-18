// Itinerary_Text (requirement 14): the plain-text itinerary that the Text_Panel shows and copies, and the text
// fragments the poster reuses so that both show the same content (design 「src/itinerary-text.js」).
// Pure functions only. They read the Trip_State and the day models of ./itinerary-derive.js and never modify them.
// Every piece of user text goes through cleanText() (14.16) and nothing is HTML-escaped here: a caller that writes
// HTML escapes these strings exactly once. The result depends only on the data, never on the clock, the time zone
// or the locale (14.18(b)); dates and weekdays come from monthDay() and weekdayChar().
// Itinerary_Text never contains the trip note, Planning_Warnings, Activity completion, or a meal's cook, servings
// and notes (14.1, 9.10, 19.2(d)).
import { STOP_KINDS, cleanText, durationText, monthDay, trimWhite, weekdayChar } from './itinerary-model.js';
import { dayModel, shoppingPlan, tripDays } from './itinerary-derive.js';

// Fixed characters of requirement 14.19, written as code points.
const BAR = '\uFF5C';     // ｜
const DOT = '\u30FB';     // ・
const COLON = '\uFF1A';   // ：
const OPEN = '\uFF08';    // （
const CLOSE = '\uFF09';   // ）
const COMMA = '\u3001';   // 、
const ARROW = ' \u2192 '; // 「 → 」: U+2192 with one U+0020 on each side
const LF = '\n';
// Missing departure time and missing old departure location (requirements 14.9, 14.15, 19.10).
const TIME_PENDING = '出發時間待定';
const PLACE_PENDING = '出發地點待定';
// Line breaks that split the trip description into paragraphs (14.3): the line breaks of 14.16.
const LINE_BREAK = /\r\n|[\r\n\u000B\u000C\u0085\u2028\u2029]/u;
// The 補充行 of an Activity in output order (14.14), keyed by dayModel()'s `extras`.
const EXTRAS = Object.freeze([['location', `地點${COLON}`], ['participants', `參加${COLON}`], ['note', `備註${COLON}`]]);
const TASK_LABELS = new Map(STOP_KINDS.map(entry => [entry.kind, entry.label]));

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => (Array.isArray(value) ? value : []);
/** cleanText() of a string (14.16); any other value is ''. */
const clean = value => cleanText(typeof value === 'string' ? value : '');
/** A place in a line's place chain: { place, detail, text }, the shape stopText() returns. */
const placeSegment = (place, text = place) => ({ place, detail: '', text });

/**
 * Text of one Stop (requirements 14.10, 11.7, 6.9) from a stop view of dayModel()
 * ({ place, kind, note, summary, … }): { place, detail, text }.
 * - place: the Stop's place name; the poster passes it to mapLink().
 * - detail: what Itinerary_Text writes inside the full-width parentheses, '' when nothing:
 *   a Shopping_Stop gives 「採買：{Shopping_Summary}」, or 「採買」 when the summary is '' (its note is never shown);
 *   接送 and 取還裝備 give 「{任務類型}：{備註}」, or only the task type when the note is ''; 其他 gives the note.
 *   The poster shows this text next to the place (11.7).
 * - text: the Itinerary_Text form 「{place}（{detail}）」, or only 「{place}」 when detail is ''.
 */
export function stopText(stopView) {
  const view = isRecord(stopView) ? stopView : {};
  const place = clean(view.place), label = TASK_LABELS.get(view.kind) ?? '', note = clean(view.note);
  let detail;
  if (view.kind === 'shop') {
    const summary = clean(view.summary);
    detail = summary ? `${label}${COLON}${summary}` : label;
  } else if (view.kind === 'other' || !label) detail = note;
  else detail = note ? `${label}${COLON}${note}` : label;
  return { place, detail, text: detail ? `${place}${OPEN}${detail}${CLOSE}` : place };
}

/**
 * Text of one line of a route block of dayModel() (requirements 14.9, 14.15, 19.10, 11.5(a)):
 * { car, departure, start, stops, end, text }.
 * - car: the car name.
 * - departure: 「{HH:MM} 出發」, or 「出發時間待定」 without a departure time. The poster writes line.time in a <time>
 *   element and uses this text only when line.time is ''.
 * - start, end: place segments { place, detail: '', text }, the shape stopText() returns. start is a route's start,
 *   or a legacy line's old departure location; when that location is missing, place is '' and text 「出發地點待定」.
 *   end is a route's end, and null for a legacy line, which has no end (14.15).
 * - stops: stopText() of every Stop in route order; [] for a legacy line.
 * - text: the Itinerary_Text line 「{car}｜{departure}：{start} → {stop} → … → {end}」, every segment's text joined
 *   with 「 → 」.
 * In every segment, place is the name to link ('' when there is none) and text is what Itinerary_Text writes, so
 * mapLink(segment.place, { fallback: segment.text }) shows a link for a place and the plain text otherwise.
 */
export function routeLineText(line) {
  const view = isRecord(line) ? line : {};
  const car = clean(view.vehicle?.name);
  const time = typeof view.time === 'string' ? view.time : '';
  const departure = time ? `${time} 出發` : TIME_PENDING;
  let start, stops = [], end = null;
  if (view.type === 'legacy') {
    const location = clean(view.location);
    start = placeSegment(location, location || PLACE_PENDING);
  } else {
    start = placeSegment(clean(view.from));
    stops = list(view.stops).map(stopText);
    end = placeSegment(clean(view.to));
  }
  const chain = [start, ...stops, ...(end ? [end] : [])].map(segment => segment.text).join(ARROW);
  return { car, departure, start, stops, end, text: `${car}${BAR}${departure}${COLON}${chain}` };
}

/**
 * Lines of one item of a moments block of dayModel() (requirements 14.13, 14.14, 8.5 to 8.7, 8.13, 19.2):
 * an array of { kind, prefix, value, text }, first the item line, then the item's 補充行 in order.
 * - 'item': 「{HH:MM} {標題}（{Activity_Category}）」 for an Activity (the category stands in for an empty title), or
 *   「{HH:MM} {Meal_Moment 的標題}（{Meal_Label}）」 for a Meal_Moment, its title as mealTitle() gives it.
 * - 'ingredients': only for a Meal_Moment with ingredients: the ingredient names in order joined with 「、」 (8.7).
 * - 'location', 'participants', 'note': only for an Activity, in this order, each only when dayModel()'s `extras`
 *   has it: 「地點：{地點}」, 「參加：{參加清單}」 and 「備註：{備註}」.
 * prefix is the fixed label before the user text ('地點：', '參加：', '備註：', and '' for 'item' and 'ingredients'),
 * value the rest of the line, and text === prefix + value is the line as Itinerary_Text writes it. The poster shows
 * the 補充行 on the item's card and passes the value of the 'location' line to mapLink().
 */
export function momentLines(item) {
  const view = isRecord(item) ? item : {};
  const time = typeof view.time === 'string' ? view.time : '';
  const line = (kind, value, prefix = '') => ({ kind, prefix, value, text: `${prefix}${value}` });
  if (view.type === 'meal') {
    const lines = [line('item', `${time} ${clean(view.title)}${OPEN}${clean(view.label)}${CLOSE}`)];
    // Names that are empty after cleanText() are left out, so a meal never gets an empty ingredient line (8.13, 14.1).
    const names = list(view.ingredients).map(name => clean(name)).filter(Boolean);
    if (names.length) lines.push(line('ingredients', names.join(COMMA)));
    return lines;
  }
  const category = clean(view.category);
  const lines = [line('item', `${time} ${clean(view.title) || category}${OPEN}${category}${CLOSE}`)];
  const extras = isRecord(view.extras) ? view.extras : {};
  for (const [kind, prefix] of EXTRAS) {
    const value = clean(extras[kind]);
    if (value) lines.push(line(kind, value, prefix));
  }
  return lines;
}

/** One Trip_Day paragraph (requirements 14.5 to 14.15) from the day's dayModel(). */
function dayText(model) {
  const title = clean(model.title);
  const date = `${monthDay(model.date)}${OPEN}週${weekdayChar(model.date)}${CLOSE}`;
  const lines = [`第 ${model.n} 天${DOT}${date}${title ? `${BAR}${title}` : ''}`];
  if (model.location) lines.push(`地點${COLON}${clean(model.location.name)}`);
  for (const block of model.blocks) {
    lines.push(''); // one blank line before every block (14.7)
    if (block.type === 'routes') {
      lines.push('路線', ...block.lines.map(line => routeLineText(line).text));
      // The arrival line (14.11) ends the Arrival block, the return line (14.12) the Last_Day's Other block.
      for (const closing of [block.arrivalLine, block.returnLine]) if (closing) lines.push(clean(closing));
    } else {
      lines.push('活動');
      block.items.forEach((item, index) => {
        const itemLines = momentLines(item);
        lines.push(...itemLines.map(entry => entry.text));
        // An item with 補充行 is followed by a blank line, unless it is the block's last item (14.14).
        if (itemLines.length > 1 && index < block.items.length - 1) lines.push('');
      });
    }
  }
  return lines.join(LF);
}

/**
 * Itinerary_Text of a Trip_State (requirement 14): the title line 「{旅行名稱}｜{Duration_Text}」 (only the Duration_Text
 * when the cleaned name is empty), one paragraph per non-blank line of the trip description, the vehicle line
 * 「車輛：{車名、…}」 when there is a vehicle, and one paragraph per Trip_Day in date order, each part separated from the
 * next by one blank line; parts without content are left out (14.1). Lines are separated by LF, and there is no line
 * break after the last line. The shopping plan is derived once for every day.
 */
export function itineraryText(state) {
  const trip = isRecord(state?.trip) ? state.trip : {};
  const days = tripDays(state);
  const title = clean(trip.title), duration = durationText(days.length);
  const parts = [title ? `${title}${BAR}${duration}` : duration];
  const description = cleanText(typeof trip.description === 'string' ? trip.description : '', { multiline: true });
  for (const paragraph of description.split(LINE_BREAK)) {
    const text = trimWhite(paragraph);
    if (text) parts.push(text);
  }
  const vehicles = list(state?.vehicles);
  if (vehicles.length) parts.push(`車輛${COLON}${vehicles.map(vehicle => clean(vehicle?.name)).join(COMMA)}`);
  const plan = shoppingPlan(state);
  for (const day of days) parts.push(dayText(dayModel(state, day.date, plan)));
  return parts.join(`${LF}${LF}`);
}
