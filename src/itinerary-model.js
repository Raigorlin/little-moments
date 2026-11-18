// Itinerary rules shared by the browser, the server and the tests. Pure functions only.
// Do not import ./model.js here: isValidState() calls validateItinerary() from this module (no import cycle).
import { inferDishKind } from './recipes.js';
import { mealSlotRank } from './meal-order.js';
import { COLOR_RE, TEMPLATE_IDS } from './storybook/model.js';

const frozenRows = rows => Object.freeze(rows.map(row => Object.freeze(row)));

/** Reference value for the trip destination (Destination_Place) in routes and stops. */
export const DESTINATION_REF = '@destination';
/** Car_Color values of the car-0 to car-7 classes, in that order. */
export const CAR_PALETTE = Object.freeze(['#efa28f', '#b7dbe5', '#b9cda5', '#f6d27a', '#d6c8df', '#f2cbb0', '#9fc9c0', '#e3a6bd']);
export const CAR_COLOR_COUNT = CAR_PALETTE.length;
export const LIMITS = Object.freeze({
  places: 100, placeName: 50, stops: 6, stopNote: 100, dayTitle: 20,
  activityTitle: 100, activityLocation: 150, activityNote: 1000, activities: 1000
});

// Activity_Category in the order of the requirements table; `type` is the stored activities[].type.
export const ACTIVITY_CATEGORIES = frozenRows([
  { type: 'meet', label: '集合' }, { type: 'market', label: '採買' }, { type: 'camp', label: '營地時光' },
  { type: 'meal', label: '用餐' }, { type: 'night', label: '夜晚' }, { type: 'travel', label: '移動' },
  { type: 'wake', label: '起床' }, { type: 'pitch', label: '搭帳' }, { type: 'free', label: '自由活動' },
  { type: 'tea', label: '下午茶／遊戲' }, { type: 'strike', label: '拆帳' }, { type: 'clean', label: '清潔' },
  { type: 'return', label: '返程' }
]);
export const ACTIVITY_TYPES = Object.freeze(ACTIVITY_CATEGORIES.map(category => category.type));
/** Label of an activity type; '' for a type outside ACTIVITY_CATEGORIES (only in invalid states). */
export function categoryLabel(type) {
  return ACTIVITY_CATEGORIES.find(category => category.type === type)?.label ?? '';
}

// Activity_Preset rows are [type, time, title].
export const ACTIVITY_PRESETS = Object.freeze({
  first: frozenRows([['pitch', '13:00', '搭帳・營地佈置'], ['night', '20:00', '星空夜聊・自由活動']]),
  middle: frozenRows([['wake', '08:00', '起床'], ['free', '10:00', '自由活動、拍照'], ['tea', '14:00', '下午茶、聊天、玩遊戲'], ['night', '20:00', '自由活動']]),
  last: frozenRows([['wake', '08:00', '起床'], ['strike', '10:00', '拆帳、整理裝備'], ['clean', '11:30', '環境清潔、裝車'], ['return', '12:00', '集合、返程']])
});
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Presets suggested for a day kind ('first', 'middle', 'last' or 'single'), sorted by default time.
 * A one-day trip merges First_Day then Last_Day; for a repeated category the earlier table row wins. */
export function presetsFor(dayKind) {
  const rows = dayKind === 'single' ? [...ACTIVITY_PRESETS.first, ...ACTIVITY_PRESETS.last]
    : Object.hasOwn(ACTIVITY_PRESETS, dayKind) ? ACTIVITY_PRESETS[dayKind] : [];
  const seen = new Set();
  return rows.filter(([type]) => !seen.has(type) && seen.add(type)).sort((a, b) => byText(a[1], b[1]));
}

export const STOP_KINDS = frozenRows([
  { kind: 'shop', label: '採買' }, { kind: 'pickup', label: '接送' },
  { kind: 'gear', label: '取還裝備' }, { kind: 'other', label: '其他' }
]);
/** Optional storybook task of a stop (stops[].taskKind) and the stop kind it belongs to. */
export const STOP_TASK_KINDS = Object.freeze({
  shopping: 'shop', 'gear-pickup': 'gear', 'gear-return': 'gear', 'passenger-pickup': 'pickup',
  'passenger-dropoff': 'pickup', 'car-rental': 'other', 'car-return': 'other', waypoint: 'other'
});
/** Storybook task shown for a stop that has no taskKind. */
export const DEFAULT_STOP_TASK = Object.freeze({ shop: 'shopping', pickup: 'passenger-pickup', gear: 'gear-pickup', other: 'waypoint' });
/** Optional storybook visual fields (state.storybook, stops[].items, daySettings[].arrivalLabel). */
export const STORYBOOK_LIMITS = Object.freeze({ headline: 80, caption: 150, stopItems: 8, stopItem: 100, arrivalLabel: 120 });
/** Default Meal_Time in MEAL_SLOTS order (早餐、午餐、下午茶、晚餐、消夜). */
export const MEAL_DEFAULT_TIMES = Object.freeze(['08:30', '12:00', '15:00', '18:00', '21:00']);

// ---- Text rules ----
const WHITE = /\p{White_Space}/u;
const NEWLINE = /[\r\n\v\f\u0085\u2028\u2029]/u;
const WIDE_FORMS = /[\u3000\uFF01-\uFFEE]/gu;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
// Same emoji zero-width-joiner exception as addParticipant() in ./model.js.
const EMOJI_JOINER = /(\p{Extended_Pictographic}\p{Variation_Selector}?\p{Emoji_Modifier}?)\u200D(?=\p{Extended_Pictographic})/gu;
// NFKC only for U+3000 and the Halfwidth and Fullwidth Forms block, so ① and ² stay as typed.
const foldWidth = text => text.replace(WIDE_FORMS, char => char.normalize('NFKC'));

/** Removes leading and trailing Unicode White_Space (full-width space, CR, LF, Tab, U+0085…). */
export function trimWhite(text) {
  const value = String(text ?? '');
  let start = 0, end = value.length;
  // Every White_Space code point is in the BMP, so testing UTF-16 units is exact. A loop, not /\s+$/, stays linear.
  while (start < end && WHITE.test(value[start])) start++;
  while (end > start && WHITE.test(value[end - 1])) end--;
  return value.slice(start, end);
}
/** Char_Count: number of Unicode code points. */
export function charCount(text) {
  let count = 0;
  for (const _ of String(text ?? '')) count++;
  return count;
}
/** True when the text has a Cc or Cf character other than a zero-width joiner between two emoji. */
export function hasControlChars(text) {
  return /[\p{Cf}\p{Cc}]/u.test(String(text ?? '').replace(EMOJI_JOINER, '$1'));
}
/** Comparison key for place names: equal keys are the same name (requirement 2.1(d)).
 * Trim, NFKC for U+3000 and U+FF01–U+FFEE only, NFC for the whole name, then lowercase A–Z. */
export function placeKey(name) {
  const key = foldWidth(trimWhite(name)).normalize('NFC').replace(/[A-Z]/g, letter => letter.toLowerCase());
  // One more NFC and trim keep the key unchanged when computed again (j + U+030C composes only after
  // lowercasing; a leading U+FFE3 becomes a space plus U+0304).
  return trimWhite(key.normalize('NFC'));
}
export const PLACE_NAME_MESSAGES = Object.freeze({
  empty: '請填寫地點名稱。',
  long: '地點名稱最多 50 個字。',
  control: '地點名稱不能包含換行、Tab 或隱藏的控制字元。',
  duplicate: '已有同名地點'
});
/** First rule the name breaks, in the order 'empty', 'long', 'control', 'duplicate'; null when it is valid.
 * Duplicates are checked against every place except `exceptId`, a non-blank destination and the
 * Draft's `pending` names (strings or { name } entries). */
export function placeNameError(name, { places = [], destination = '', exceptId, pending = [] } = {}) {
  const text = trimWhite(name);
  if (!text) return 'empty';
  if (charCount(text) > LIMITS.placeName) return 'long';
  if (hasControlChars(text)) return 'control';
  const key = placeKey(text);
  const others = [
    ...places.filter(place => place.id !== exceptId).map(place => place.name),
    ...(trimWhite(destination) ? [destination] : []),
    ...pending.map(entry => (typeof entry === 'string' ? entry : entry?.name))
  ];
  return others.some(other => placeKey(other) === key) ? 'duplicate' : null;
}
/** User text for Itinerary_Text (requirement 14.16): trims White_Space; unless `multiline`, every
 * White_Space run that contains a line break becomes one space. No escaping, no truncation. */
export function cleanText(text, { multiline = false } = {}) {
  const value = trimWhite(text);
  return multiline ? value : value.replace(/\p{White_Space}+/gu, run => (NEWLINE.test(run) ? ' ' : run));
}
/** Time field input: { value: '' } when blank, { value: 'HH:MM' } when valid
 * (full-width digits and colon are accepted), otherwise { error: 'invalid' } — a partial time is not blank. */
export function normalizeTimeInput(raw) {
  const text = trimWhite(raw);
  if (!text) return { value: '' };
  const value = foldWidth(text);
  return TIME.test(value) ? { value } : { error: 'invalid' };
}

// ---- Numbers and dates ----
const DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
/** Chinese_Numeral: 1–99 in Chinese numerals (2 alone is 兩, 12 is 十二); other values in Arabic numerals. */
export function chineseNumeral(n) {
  if (n === 2) return '兩';
  if (!Number.isInteger(n) || n < 1 || n > 99) return String(n);
  const tens = Math.floor(n / 10), ones = n % 10;
  return `${tens > 1 ? DIGITS[tens] : ''}${tens ? '十' : ''}${DIGITS[ones]}`;
}
/** Duration_Text: 一日遊, or {days}天{days − 1}夜 such as 三天兩夜. */
export function durationText(days) {
  return days === 1 ? '一日遊' : `${chineseNumeral(days)}天${chineseNumeral(days - 1)}夜`;
}
const WEEKDAYS = '日一二三四五六';
const dateParts = date => String(date ?? '').split('-').map(Number);
/** 'YYYY-MM-DD' → '10/20' (no zero padding). */
export function monthDay(date) {
  const [, month, day] = dateParts(date);
  return `${month}/${day}`;
}
/** Weekday character 一…六、日 for 'YYYY-MM-DD', independent of the device time zone and locale. */
export function weekdayChar(date) {
  const [year, month, day] = dateParts(date);
  // Date.UTC() reads years 0–99 as 1900–1999; the calendar repeats every 400 years (a whole number of weeks).
  return WEEKDAYS[new Date(Date.UTC(year < 100 ? year + 400 : year, month - 1, day)).getUTCDay()] ?? '';
}
/** 'YYYY-MM-DD' → '10/20（週二）'. */
export function dateText(date) {
  return `${monthDay(date)}（週${weekdayChar(date)}）`;
}

// ---- Meals ----
/** Meal_Time: the meal's own valid time, otherwise the default for its slot; other legacy slots use 12:00. */
export function mealTime(meal) {
  if (typeof meal.time === 'string' && TIME.test(meal.time)) return meal.time;
  return MEAL_DEFAULT_TIMES[mealSlotRank(meal.slot)] ?? '12:00';
}
/** Meal_Label: 火鍋 or 烤肉 by dish illustration kind, otherwise the slot text. */
export function mealLabel(meal) {
  const kind = inferDishKind(meal);
  return kind === 'hotpot' ? '火鍋' : kind === 'bbq' ? '烤肉' : cleanText(meal.slot);
}
/** Meal_Moment title: {slot}：{title}, or only the slot when the title is blank or equals the slot. */
export function mealTitle(meal) {
  const slot = cleanText(meal.slot), title = cleanText(meal.title);
  return !title || title === slot ? slot : `${slot}：${title}`;
}

// ---- Validation ----
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// The identifier rule of the other collections in isValidState(): a non-empty string of at most 5,000 UTF-16 units.
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 5000;
// HH:MM, or a time left blank (omitted or '').
const optionalTime = value => value === undefined || value === '' || (typeof value === 'string' && TIME.test(value));
// A missing list field is an empty list; null when the field is present but is not an array.
const listField = value => (value === undefined ? [] : Array.isArray(value) ? value : null);
const asList = value => (Array.isArray(value) ? value : []);
const STOP_KIND_KEYS = Object.freeze(STOP_KINDS.map(entry => entry.kind));
const optionalText = (value, max) => value === undefined || (typeof value === 'string' && !value.includes('\u0000') && charCount(value) <= max);
const optionalTemplate = value => value === undefined || TEMPLATE_IDS.includes(value);
const validStopItems = items => items === undefined || (Array.isArray(items) && items.length <= STORYBOOK_LIMITS.stopItems
  && items.every(item => typeof item === 'string' && trimWhite(item) !== '' && optionalText(item, STORYBOOK_LIMITS.stopItem)));
// state.storybook holds only optional poster text and the destination's building template.
const validStorybook = value => value === undefined || (isRecord(value)
  && Object.keys(value).every(key => ['headline', 'caption', 'destinationTemplate'].includes(key))
  && optionalText(value.headline, STORYBOOK_LIMITS.headline) && optionalText(value.caption, STORYBOOK_LIMITS.caption)
  && optionalTemplate(value.destinationTemplate));

/** State_Validator rules for places, routes (with stops), daySettings and meals[].time (requirements 18.3–18.8).
 * isValidState() calls it after its own checks with `dates` = dateRange(startDate, endDate). A missing places,
 * routes or daySettings field is an empty list. Returns false when any rule is broken; any JSON value is safe input. */
export function validateItinerary(state, dates) {
  if (!isRecord(state)) return false;
  const places = listField(state.places), routes = listField(state.routes), daySettings = listField(state.daySettings);
  if (!places || !routes || !daySettings || places.length > LIMITS.places) return false;
  const days = new Set(asList(dates).filter(date => typeof date === 'string'));
  const destination = trimWhite(isRecord(state.trip) ? state.trip.destination : '');
  const placeIds = new Set(), names = new Set(destination ? [placeKey(destination)] : []);
  for (const place of places) {
    // Without other names, placeNameError() checks only empty, long and control; duplicates are found below in one pass.
    if (!isRecord(place) || !validId(place.id) || place.id === DESTINATION_REF || placeIds.has(place.id)
      || typeof place.name !== 'string' || placeNameError(place.name) !== null || !optionalTemplate(place.templateId)) return false;
    const key = placeKey(place.name);
    if (names.has(key)) return false;
    placeIds.add(place.id);
    names.add(key);
  }
  // Route ends and Stop places: a Place, or Destination_Place while the trip destination is not blank.
  const placeRef = ref => placeIds.has(ref) || (ref === DESTINATION_REF && destination !== '');
  const vehicleIds = new Set(asList(state.vehicles).map(vehicle => vehicle?.id).filter(validId));
  if (!asList(state.vehicles).every(vehicle => vehicle?.color === undefined || (typeof vehicle.color === 'string' && COLOR_RE.test(vehicle.color)))) return false;
  if (!validStorybook(state.storybook)) return false;
  const routeIds = new Set(), carDays = new Set(), stopIds = new Set();
  for (const route of routes) {
    if (!isRecord(route) || !validId(route.id) || routeIds.has(route.id)) return false;
    if (!days.has(route.date) || !vehicleIds.has(route.vehicleId)) return false;
    // At most one route per car and day; both values are strings here.
    const carDay = JSON.stringify([route.date, route.vehicleId]);
    if (carDays.has(carDay) || !placeRef(route.from) || !placeRef(route.to) || !optionalTime(route.time)) return false;
    const stops = listField(route.stops);
    if (!stops || stops.length > LIMITS.stops) return false;
    for (const stop of stops) {
      // Stop identifiers are unique across every route.
      if (!isRecord(stop) || !validId(stop.id) || stopIds.has(stop.id) || !placeRef(stop.place) || !STOP_KIND_KEYS.includes(stop.kind)) return false;
      if (stop.note !== undefined && (typeof stop.note !== 'string' || charCount(stop.note) > LIMITS.stopNote)) return false;
      if (!optionalTime(stop.time) || !validStopItems(stop.items)) return false;
      if (stop.taskKind !== undefined && (!Object.hasOwn(STOP_TASK_KINDS, stop.taskKind) || STOP_TASK_KINDS[stop.taskKind] !== stop.kind)) return false;
      stopIds.add(stop.id);
    }
    routeIds.add(route.id);
    carDays.add(carDay);
  }
  const settingDays = new Set();
  for (const setting of daySettings) {
    if (!isRecord(setting) || !days.has(setting.date) || settingDays.has(setting.date)) return false;
    if (setting.title !== undefined && (typeof setting.title !== 'string' || charCount(setting.title) > LIMITS.dayTitle)) return false;
    // Day_Location is unset or a Place; choosing Destination_Place is stored as unset, so '@destination' is invalid.
    if (!(setting.place === undefined || setting.place === '' || placeIds.has(setting.place)) || !optionalTime(setting.arrival)) return false;
    if (!optionalText(setting.arrivalLabel, STORYBOOK_LIMITS.arrivalLabel)) return false;
    if (!(setting.routePosition === undefined || setting.routePosition === 'before' || setting.routePosition === 'after')) return false;
    settingDays.add(setting.date);
  }
  // meals[].time may be omitted; when present it must be HH:MM ('' is not allowed).
  return asList(state.meals).every(meal => meal?.time === undefined || (typeof meal.time === 'string' && TIME.test(meal.time)));
}

/** Checks a new trip destination against the itinerary (requirements 2.9, 2.10):
 * { type: 'duplicate', name } when a Place has the same name (requirement 2.1(d); `name` is that Place's name),
 * { type: 'in-use' } when the destination would be blank while a Route's from, to or a Stop still uses
 * Destination_Place, otherwise null. */
export function destinationConflict(state, destination) {
  if (trimWhite(destination)) {
    const key = placeKey(destination);
    const place = asList(state?.places).find(item => typeof item?.name === 'string' && placeKey(item.name) === key);
    return place ? { type: 'duplicate', name: place.name } : null;
  }
  const inUse = asList(state?.routes).some(route => route?.from === DESTINATION_REF || route?.to === DESTINATION_REF
    || asList(route?.stops).some(stop => stop?.place === DESTINATION_REF));
  return inUse ? { type: 'in-use' } : null;
}
