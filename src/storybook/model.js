// Studio plan model adapted from demos/storybook-trip-studio/model.js for the website integration.
// Limits accept everything a valid website state can store (local trip text up to 5,000 characters), so projecting
// a trip never fails or truncates; the adapter applies the stricter website edit limits to changed values only.
// Text is neither normalized nor rejected for control characters so round trips stay lossless; the renderer sanitizes
// text for canvas.

export const VERSION = 'storybook-studio-1-integrated';

export const LIMITS = Object.freeze({
  titleMax: 5000, headlineMax: 80, captionMax: 150,
  placesMin: 0, placesMax: 101, placeNameMax: 5000,
  vehiclesMin: 0, vehiclesMax: 1000, vehicleNameMax: 5000,
  daysMin: 1, daysMax: 31, dayTitleMax: 20,
  // Meal events show "slot：title", each part up to 5,000 characters.
  eventsMax: 2000, eventTitleMax: 10001, notesMax: 5000,
  routesMax: 1000, stopsMax: 6, stopNotesMax: 100, stopItemsMax: 8, stopItemMax: 100, arrivalLabelMax: 120,
  shoppingMax: 1000, shoppingItemMax: 5000,
  idMax: 48, minYear: 0, maxYear: 9999
});

export const KINDS = Object.freeze({
  setup: '搭帳', bbq: '烤肉', night: '夜晚', sunrise: '起床', breakfast: '早餐',
  explore: '自由活動', noodles: '午餐', games: '下午茶／遊戲', hotpot: '火鍋',
  pack: '拆帳', cleanup: '清潔', depart: '返程', activity: '其他活動',
  meet: '集合', market: '採買', camp: '營地時光', travel: '移動', meal: '用餐'
});
/** Kinds that map one-to-one to a website activity type. */
export const ACTIVITY_KINDS = Object.freeze(['meet', 'market', 'camp', 'meal', 'night', 'travel', 'sunrise', 'setup', 'explore', 'games', 'pack', 'cleanup', 'depart']);
/** Kinds derived for meal events. */
export const MEAL_KINDS = Object.freeze(['hotpot', 'bbq', 'breakfast', 'noodles', 'meal']);

export const STOP_KINDS = Object.freeze({
  shopping: '採買', 'gear-pickup': '領取租借裝備', 'gear-return': '歸還裝備',
  'passenger-pickup': '接人', 'passenger-dropoff': '送人下車',
  'car-rental': '取租車', 'car-return': '還車', waypoint: '一般停靠'
});

export const TEMPLATES = Object.freeze([
  ['home', '家／出發地', 'home'],
  ['market', '超市／賣場', 'shop'],
  ['seven-eleven', '7-ELEVEN', 'shop'],
  ['familymart', '全家 FamilyMart', 'shop'],
  ['okmart', 'OK mart', 'shop'],
  ['pxmart-mega', '大全聯', 'shop'],
  ['costco', 'Costco 好市多', 'shop'],
  ['ikea', 'IKEA', 'shop'],
  ['carrefour', '家樂福 Carrefour', 'shop'],
  ['tent', '經典帳篷', 'camp'],
  ['bell', '鐘型帳', 'camp'],
  ['dome', '圓頂帳', 'camp'],
  ['tarp', '天幕野餐', 'camp'],
  ['camper', '露營車', 'camp'],
  ['cabin', '小木屋', 'camp']
].map(([id, label, group]) => Object.freeze({ id, label, group })));

export const TEMPLATE_IDS = Object.freeze(TEMPLATES.map(t => t.id));
const TEMPLATE_SET = new Set(TEMPLATE_IDS);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const RESERVED_IDS = new Set(['constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']);
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export class StudioValidationError extends Error {
  constructor(message, path) {
    super(path ? `${path}：${message}` : message);
    this.name = 'StudioValidationError';
    this.path = path || '';
  }
}

const fail = (message, path) => { throw new StudioValidationError(message, path); };
const length = s => Array.from(s).length;

function record(v, path) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail('需為物件', path);
  const proto = Object.getPrototypeOf(v);
  // Realm-agnostic plain-object check so data parsed in another frame is still accepted.
  if (proto !== null && Object.getPrototypeOf(proto) !== null) fail('需為一般物件', path);
  return v;
}

function field(o, key) { return has(o, key) ? o[key] : undefined; }

function list(v, path, min, max, optional) {
  if (v === undefined && optional) return [];
  if (!Array.isArray(v)) fail('需為陣列', path);
  if (v.length < min || v.length > max) fail(`需為 ${min}–${max} 筆`, path);
  return Array.from({ length: v.length }, (_, i) => v[i]);
}

function text(v, path, max, { optional = false } = {}) {
  if (v === undefined && optional) return '';
  if (typeof v !== 'string') fail('需為文字', path);
  if (!optional && v.trim() === '') fail('不可空白', path);
  if (length(v) > max) fail(`最多 ${max} 字`, path);
  return v;
}

function safeId(v, path) {
  if (typeof v !== 'string' || v.length > LIMITS.idMax || !ID_RE.test(v) || RESERVED_IDS.has(v)) {
    fail(`ID 需為 1–${LIMITS.idMax} 個英數、- 或 _，且以英數開頭`, path);
  }
  return v;
}

function optionalId(x, path, seen) {
  const id = field(x, 'id');
  if (id === undefined) return {};
  safeId(id, `${path}.id`);
  if (seen.has(id)) fail(`ID「${id}」重複`, `${path}.id`);
  seen.add(id);
  return { id };
}

function parseTime(v, path) {
  const m = typeof v === 'string' ? TIME_RE.exec(v) : null;
  if (!m) fail('時間需為有效的 HH:mm', path);
  return Number(m[1]) * 60 + Number(m[2]);
}

function optionalTime(v, path) {
  const t = v === undefined ? '' : v;
  if (t !== '') parseTime(t, path);
  return t;
}

export function minutes(t) { return parseTime(t, '時間'); }

function parseDate(v, path) {
  const m = typeof v === 'string' ? DATE_RE.exec(v) : null;
  if (!m) fail('日期需為 YYYY-MM-DD', path);
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < LIMITS.minYear || y > LIMITS.maxYear) fail(`年份需介於 ${LIMITS.minYear}–${LIMITS.maxYear}`, path);
  // setUTCFullYear(), unlike Date.UTC(), does not read years 0–99 as 1900–1999; the website accepts any ISO year.
  const back = new Date(0);
  const ms = back.setUTCFullYear(y, mo - 1, d);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) fail('日期不存在', path);
  return ms;
}

function isoDate(ms) {
  const d = new Date(ms);
  if (!Number.isFinite(ms)) fail('日期超出範圍', '日期');
  const y = d.getUTCFullYear();
  if (y < LIMITS.minYear || y > LIMITS.maxYear) fail(`年份需介於 ${LIMITS.minYear}–${LIMITS.maxYear}`, '日期');
  return `${String(y).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function uniqueIds(items, path) {
  const seen = new Set();
  return items.map((item, i) => {
    const p = `${path}[${i}]`;
    record(item, p);
    const id = safeId(field(item, 'id'), `${p}.id`);
    if (seen.has(id)) fail(`ID「${id}」重複`, `${p}.id`);
    seen.add(id);
    return id;
  });
}

function validatePlace(x, i) {
  const p = `places[${i}]`;
  const templateId = field(x, 'templateId');
  if (typeof templateId !== 'string' || !TEMPLATE_SET.has(templateId)) fail('未知的建築模板', `${p}.templateId`);
  return { id: x.id, name: text(field(x, 'name'), `${p}.name`, LIMITS.placeNameMax), templateId };
}

function validateVehicle(x, i) {
  const p = `vehicles[${i}]`;
  const color = field(x, 'color');
  if (typeof color !== 'string' || !COLOR_RE.test(color)) fail('車輛顏色需為 #rrggbb', `${p}.color`);
  // The website stores any vehicle name string, including a blank one.
  return { id: x.id, name: text(field(x, 'name'), `${p}.name`, LIMITS.vehicleNameMax, { optional: true }), color };
}

function validateEvent(x, path, seen) {
  record(x, path);
  const time = field(x, 'time');
  parseTime(time, `${path}.time`);
  const kind = field(x, 'kind');
  if (typeof kind !== 'string' || !has(KINDS, kind)) fail('未知的活動種類', `${path}.kind`);
  const notes = field(x, 'notes');
  return {
    ...optionalId(x, path, seen.events),
    time,
    title: text(field(x, 'title'), `${path}.title`, LIMITS.eventTitleMax, { optional: true }),
    kind,
    notes: notes === null ? '' : text(notes, `${path}.notes`, LIMITS.notesMax, { optional: true })
  };
}

function validateRoute(x, path, places, vehicles, used, seen) {
  record(x, path);
  const id = optionalId(x, path, seen.routes);
  const vehicleId = field(x, 'vehicleId');
  if (typeof vehicleId !== 'string' || !vehicles.has(vehicleId)) fail('車輛不存在', `${path}.vehicleId`);
  if (used.has(vehicleId)) fail('同一天同一台車只能有一條路線', `${path}.vehicleId`);
  used.add(vehicleId);
  const ref = key => {
    const v = field(x, key);
    if (typeof v !== 'string' || !places.has(v)) fail('地點不存在', `${path}.${key}`);
    return v;
  };
  const from = ref('from'), to = ref('to');
  // A blank departure is a real "not decided yet" and must stay blank.
  const departure = optionalTime(field(x, 'departure'), `${path}.departure`);
  const stops = field(x, 'stops') !== undefined
    ? list(field(x, 'stops'), `${path}.stops`, 0, LIMITS.stopsMax).map((st, i) => validateStop(st, `${path}.stops[${i}]`, places, seen))
    : legacyVia(field(x, 'via'), `${path}.via`, places);
  return { ...id, vehicleId, from, to, departure, stops, via: stops.map(st => st.placeId) };
}

function validateStop(x, path, places, seen) {
  record(x, path);
  const id = optionalId(x, path, seen.stops);
  const placeId = field(x, 'placeId');
  if (typeof placeId !== 'string' || !places.has(placeId)) fail('停靠地點不存在', `${path}.placeId`);
  const kind = field(x, 'kind');
  if (typeof kind !== 'string' || !has(STOP_KINDS, kind)) fail('未知的停靠類型', `${path}.kind`);
  const time = optionalTime(field(x, 'time'), `${path}.time`);
  const notes = field(x, 'notes');
  const items = list(field(x, 'items'), `${path}.items`, 0, LIMITS.stopItemsMax, true)
    .map((it, i) => text(it, `${path}.items[${i}]`, LIMITS.stopItemMax));
  return {
    ...id, placeId, kind, time, items,
    notes: notes === null ? '' : text(notes, `${path}.notes`, LIMITS.stopNotesMax, { optional: true })
  };
}

// Legacy via carried no purpose, so it becomes a neutral waypoint rather than a guessed task.
function legacyVia(v, path, places) {
  return list(v, path, 0, LIMITS.stopsMax, true).map((id, i) => {
    if (typeof id !== 'string' || !places.has(id)) fail('途經地點不存在', `${path}[${i}]`);
    return { placeId: id, kind: 'waypoint', time: '', items: [], notes: '' };
  });
}

function validateDay(x, i, places, vehicles, seen) {
  const p = `days[${i}]`;
  record(x, p);
  const id = optionalId(x, p, seen.days);
  const date = field(x, 'date');
  const ms = parseDate(date, `${p}.date`);
  const title = text(field(x, 'title'), `${p}.title`, LIMITS.dayTitleMax, { optional: true });
  const rawLocation = field(x, 'locationId');
  const locationId = rawLocation === undefined ? '' : rawLocation;
  if (typeof locationId !== 'string' || (locationId !== '' && !places.has(locationId))) fail('活動地點不存在', `${p}.locationId`);
  const routePosition = field(x, 'routePosition') === undefined ? 'before' : field(x, 'routePosition');
  if (routePosition !== 'before' && routePosition !== 'after') fail('路線時段需為 before 或 after', `${p}.routePosition`);
  const arrivalLabel = text(field(x, 'arrivalLabel'), `${p}.arrivalLabel`, LIMITS.arrivalLabelMax, { optional: true });
  const arrival = optionalTime(field(x, 'arrival'), `${p}.arrival`);

  const used = new Set();
  const routes = list(field(x, 'routes'), `${p}.routes`, 0, LIMITS.routesMax, true)
    .map((r, j) => validateRoute(r, `${p}.routes[${j}]`, places, vehicles, used, seen));

  const events = list(field(x, 'events'), `${p}.events`, 0, LIMITS.eventsMax, true)
    .map((e, j) => ({ e: validateEvent(e, `${p}.events[${j}]`, seen), j }))
    .sort((a, b) => minutes(a.e.time) - minutes(b.e.time) || a.j - b.j)
    .map(v => v.e);

  return { ms, day: { ...id, date, title, locationId, routePosition, arrivalLabel, arrival, routes, events } };
}

function validateUnsafe(input) {
  record(input, '');
  if (field(input, 'schemaVersion') !== 1) fail('不支援的行程格式，需 schemaVersion: 1', 'schemaVersion');
  const title = text(field(input, 'title'), 'title', LIMITS.titleMax);
  const headline = text(field(input, 'headline'), 'headline', LIMITS.headlineMax, { optional: true });
  const caption = text(field(input, 'caption'), 'caption', LIMITS.captionMax, { optional: true });

  const rawPlaces = list(field(input, 'places'), 'places', LIMITS.placesMin, LIMITS.placesMax);
  const places = new Set(uniqueIds(rawPlaces, 'places'));
  const rawVehicles = list(field(input, 'vehicles'), 'vehicles', LIMITS.vehiclesMin, LIMITS.vehiclesMax);
  const vehicles = new Set(uniqueIds(rawVehicles, 'vehicles'));
  const outPlaces = rawPlaces.map(validatePlace);
  const outVehicles = rawVehicles.map(validateVehicle);

  const shopping = list(field(input, 'shopping'), 'shopping', 0, LIMITS.shoppingMax, true)
    .map((s, i) => text(s, `shopping[${i}]`, LIMITS.shoppingItemMax, { optional: true }));

  const seen = { days: new Set(), events: new Set(), routes: new Set(), stops: new Set() };
  let prev = -Infinity;
  const days = list(field(input, 'days'), 'days', LIMITS.daysMin, LIMITS.daysMax).map((d, i) => {
    const { ms, day } = validateDay(d, i, places, vehicles, seen);
    if (ms <= prev) fail('日期需依序遞增且不可重複', `days[${i}].date`);
    prev = ms;
    return day;
  });

  return { schemaVersion: 1, title, headline, caption, places: outPlaces, vehicles: outVehicles, shopping, days };
}

export function validate(input) {
  try {
    return validateUnsafe(input);
  } catch (err) {
    if (err instanceof StudioValidationError) throw err;
    // Hostile inputs (throwing getters, proxies, revoked objects) must surface as a validation failure, not a crash.
    throw new StudioValidationError('行程資料無法讀取');
  }
}

export function canonical(plan) { return JSON.stringify(validate(plan)); }

export async function fingerprint(plan) {
  const raw = `${VERSION}|${canonical(plan)}`;
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (subtle && typeof subtle.digest === 'function' && typeof TextEncoder === 'function') {
    try {
      const buf = await subtle.digest('SHA-256', new TextEncoder().encode(raw));
      return 'sha256:' + Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
    } catch (_) { /* fall through to the deterministic raw key */ }
  }
  return 'raw:' + raw;
}

export function dateText(d) {
  const ms = parseDate(d, '日期');
  return new Date(ms).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short', timeZone: 'UTC' });
}

export function shiftDates(plan, start) {
  const p = validate(plan);
  const offset = parseDate(start, '開始日期') - parseDate(p.days[0].date, 'days[0].date');
  p.days = p.days.map(d => ({ ...d, date: isoDate(parseDate(d.date, '日期') + offset) }));
  return validate(p);
}

export function nextId(items, prefix) {
  if (typeof prefix !== 'string' || !ID_RE.test(prefix) || prefix.length > LIMITS.idMax - 3) fail('ID 前綴格式不正確', 'prefix');
  const ids = new Set();
  if (Array.isArray(items)) {
    for (const it of items) if (it && typeof it === 'object' && typeof it.id === 'string') ids.add(it.id);
  }
  const re = new RegExp('^' + prefix.replace(/[-]/g, '\\-') + '(\\d+)$');
  let n = 0;
  for (const id of ids) {
    const m = re.exec(id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  let candidate;
  do { candidate = prefix + (++n); } while (ids.has(candidate));
  return candidate;
}

export const StudioModel = Object.freeze({
  VERSION, LIMITS, KINDS, ACTIVITY_KINDS, MEAL_KINDS, STOP_KINDS, TEMPLATES, TEMPLATE_IDS, COLOR_RE, StudioValidationError,
  validate, canonical, fingerprint, minutes, dateText, shiftDates, nextId
});
export default StudioModel;
