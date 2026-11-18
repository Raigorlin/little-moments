// Bridge between the website Trip_State (the source of truth) and the storybook studio plan.
// toStudio() projects a valid state; fromStudio() writes a studio draft back by changing only the fields the draft
// changed, so an unchanged plan returns a state equal to the input, including absent optional keys.
import { dateRange, isValidState, uid } from './model.js';
import { syncMealIngredients } from './ingredients.js';
import { inferDishKind } from './recipes.js';
import {
  CAR_PALETTE, DEFAULT_STOP_TASK, DESTINATION_REF, PLACE_NAME_MESSAGES, STOP_TASK_KINDS,
  charCount, cleanText, mealTime, mealTitle, placeNameError
} from './itinerary-model.js';
import { StudioValidationError, validate } from './storybook/model.js';
import { shoppingPlan } from './itinerary-derive.js';

export { StudioValidationError };
export const STUDIO_DEST_ID = 'dest';
// The website's edit limits for the trip card (server CARD_LIMITS), applied when the studio changes them.
const CARD_LIMITS = Object.freeze({ title: 100, destination: 100 });
const NEW_VEHICLE_SEATS = 4;
const DEFAULT_DEST_TEMPLATE = 'tent';
const DAY_MS = 86400000;

export class StudioConflictError extends StudioValidationError {
  constructor(message, path) {
    super(message, path);
    this.name = 'StudioConflictError';
    this.code = 'conflict';
  }
}

const TYPE_TO_KIND = Object.freeze({
  meet: 'meet', market: 'market', camp: 'camp', meal: 'meal', night: 'night', travel: 'travel',
  wake: 'sunrise', pitch: 'setup', free: 'explore', tea: 'games', strike: 'pack', clean: 'cleanup', return: 'depart'
});
const KIND_TO_TYPE = Object.freeze({
  ...Object.fromEntries(Object.entries(TYPE_TO_KIND).map(([type, kind]) => [kind, type])),
  bbq: 'meal', breakfast: 'meal', noodles: 'meal', hotpot: 'meal', activity: 'camp'
});

const MEAL_ID = /^m[-_]/;
/** True for a studio event that shows a website meal (event id m-<mealId> or m_<hash>). */
export const isMealEvent = event => typeof event?.id === 'string' && MEAL_ID.test(event.id);

const fail = (message, path) => { throw new StudioValidationError(message, path); };
const conflict = path => { throw new StudioConflictError('這筆資料在你編輯時已被其他人修改，請重新載入後再調整', path); };
const asList = value => (Array.isArray(value) ? value : []);
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

// ---- Stable, reversible studio IDs ----
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ID_MAX = 48;
function hash64(text) {
  let a = 0x811c9dc5, b = 0x050c5d1f;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193 ^ 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
/** Studio ID for a website ID: `<prefix>-<id>` when that is a safe ID, otherwise `<prefix>_<hash>`. */
export function studioId(prefix, id) {
  return SAFE_ID.test(id) && prefix.length + 1 + id.length <= ID_MAX ? `${prefix}-${id}` : `${prefix}_${hash64(id)}`;
}
function table(prefix, ids) {
  const toStudioId = new Map(), toWebId = new Map();
  for (const id of ids) {
    const sid = studioId(prefix, id);
    if (toWebId.has(sid)) fail('資料 ID 無法對應到編輯器', sid);
    toStudioId.set(id, sid);
    toWebId.set(sid, id);
  }
  return { toStudioId, toWebId, prefix };
}
function tables(state) {
  const stops = asList(state.routes).flatMap(route => asList(route.stops));
  return {
    places: table('p', asList(state.places).map(p => p.id)),
    vehicles: table('v', state.vehicles.map(v => v.id)),
    activities: table('a', state.activities.map(a => a.id)),
    meals: table('m', state.meals.map(m => m.id)),
    routes: table('r', asList(state.routes).map(r => r.id)),
    stops: table('s', stops.map(s => s.id))
  };
}
// Website ID for a record the studio created; never reuses an existing website ID.
function newWebId(sid, taken) {
  let id = sid.startsWith('__') ? '' : /^[a-z]-./.test(sid) ? sid.slice(2) : sid;
  if (!id || taken.has(id)) id = uid();
  while (taken.has(id)) id = uid();
  taken.add(id);
  return id;
}

// ---- Projection ----
const TEMPLATE_GUESSES = [
  [/7-?11|7-ELEVEN|統一超商/i, 'seven-eleven'], [/全家|familymart/i, 'familymart'], [/OK ?mart|OK超商/i, 'okmart'],
  [/全聯/, 'pxmart-mega'], [/costco|好市多/i, 'costco'], [/ikea/i, 'ikea'], [/家樂福|carrefour/i, 'carrefour'],
  [/超市|賣場|市場|超商|商店|market|mart/i, 'market'], [/小木屋|cabin/i, 'cabin'], [/露營車|camper/i, 'camper'],
  [/營|camp/i, 'tent']
];
// Display-only default; a template is stored only after the user picks one.
const guessTemplate = name => TEMPLATE_GUESSES.find(([re]) => re.test(name))?.[1] ?? 'home';

function mealKind(meal) {
  const dish = inferDishKind(meal);
  if (dish === 'hotpot' || dish === 'bbq') return dish;
  if (dish === 'breakfast' || dish === 'toast') return 'breakfast';
  const slot = cleanText(meal.slot);
  return slot === '早餐' ? 'breakfast' : slot === '午餐' ? 'noodles' : 'meal';
}

const hasDestination = state => state.trip.destination.trim() !== '';

function project(state, ids) {
  const dest = hasDestination(state);
  // Shopping stops show the shopping items whose assignee rides in that car (driver or passenger), derived like the site.
  const plan = shoppingPlan(state), itemName = item => cleanText(item.name);
  // The studio allows 8 non-blank items of up to 100 characters per stop: a longer list ends with 「等另外 N 項」.
  const derivedItems = items => {
    const names = items.map(itemName).filter(Boolean).map(n => [...n].slice(0, 100).join(''));
    return names.length > 8 ? [...names.slice(0, 7), `等另外 ${names.length - 7} 項`] : names;
  };
  const stopItems = st => st.kind === 'shop' ? derivedItems(plan.stopItems.get(st.id) ?? []) : [...asList(st.items)];
  const placeRef = ref => (ref === DESTINATION_REF ? STUDIO_DEST_ID : ids.places.toStudioId.get(ref));
  const places = [
    ...(dest ? [{ id: STUDIO_DEST_ID, name: state.trip.destination, templateId: state.storybook?.destinationTemplate ?? DEFAULT_DEST_TEMPLATE }] : []),
    ...asList(state.places).map(p => ({ id: ids.places.toStudioId.get(p.id), name: p.name, templateId: p.templateId ?? guessTemplate(p.name) }))
  ];
  const vehicles = state.vehicles.map((v, i) => ({ id: ids.vehicles.toStudioId.get(v.id), name: v.name, color: v.color ?? CAR_PALETTE[i % CAR_PALETTE.length] }));
  const settings = new Map(asList(state.daySettings).map(s => [s.date, s]));
  const days = dateRange(state.trip.startDate, state.trip.endDate).map((date, i) => {
    const s = settings.get(date) ?? {};
    const events = [
      ...state.activities.filter(a => a.date === date).map(a => ({
        id: ids.activities.toStudioId.get(a.id), time: a.time, title: a.title, kind: TYPE_TO_KIND[a.type], notes: a.note
      })),
      ...state.meals.filter(m => m.date === date).map(m => ({
        id: ids.meals.toStudioId.get(m.id), time: mealTime(m), title: mealTitle(m), kind: mealKind(m), notes: m.notes
      }))
    ];
    const routes = asList(state.routes).filter(r => r.date === date).map(r => ({
      id: ids.routes.toStudioId.get(r.id), vehicleId: ids.vehicles.toStudioId.get(r.vehicleId),
      from: placeRef(r.from), to: placeRef(r.to), departure: r.time ?? '',
      stops: asList(r.stops).map(st => ({
        id: ids.stops.toStudioId.get(st.id), placeId: placeRef(st.place), kind: st.taskKind ?? DEFAULT_STOP_TASK[st.kind],
        time: st.time ?? '', items: stopItems(st), notes: st.note ?? ''
      }))
    }));
    return {
      id: `d${i + 1}`, date, title: s.title ?? '',
      locationId: s.place ? ids.places.toStudioId.get(s.place) : dest ? STUDIO_DEST_ID : '',
      routePosition: s.routePosition ?? 'before', arrivalLabel: s.arrivalLabel ?? '', arrival: s.arrival ?? '',
      routes, events
    };
  });
  return {
    schemaVersion: 1, title: state.trip.title,
    headline: state.storybook?.headline ?? '', caption: state.storybook?.caption ?? '',
    places, vehicles, shopping: plan.unassigned.map(u => itemName(u.item)), days
  };
}

/** Studio plan for a valid Trip_State. Pure; throws StudioValidationError for an invalid state. */
export function toStudio(state) {
  if (!isValidState(state)) fail('旅行資料格式不正確，無法開啟行程編輯器');
  return validate(project(state, tables(state)));
}

// ---- Three-way merge on a flat view of the plan ----
// Records without an ID get a key no studio ID can have, unique across every flatten() call.
let tempKeys = 0;
function flatten(plan) {
  const p = validate(plan);
  const key = item => item.id ?? `__${++tempKeys}`;
  const out = {
    meta: { title: p.title, headline: p.headline, caption: p.caption, shopping: p.shopping },
    places: new Map(p.places.map(x => [x.id, { name: x.name, templateId: x.templateId }])),
    vehicles: new Map(p.vehicles.map(x => [x.id, { name: x.name, color: x.color }])),
    days: new Map(), events: new Map(), routes: new Map(), stops: new Map()
  };
  for (const day of p.days) {
    const d = key(day);
    out.days.set(d, { date: day.date, title: day.title, locationId: day.locationId, routePosition: day.routePosition, arrivalLabel: day.arrivalLabel, arrival: day.arrival });
    for (const e of day.events) out.events.set(key(e), { day: d, time: e.time, title: e.title, kind: e.kind, notes: e.notes });
    for (const r of day.routes) {
      const stops = r.stops.map(st => {
        const s = key(st);
        out.stops.set(s, { placeId: st.placeId, kind: st.kind, time: st.time, items: st.items, notes: st.notes });
        return s;
      });
      out.routes.set(key(r), { day: d, vehicleId: r.vehicleId, from: r.from, to: r.to, departure: r.departure, stops });
    }
  }
  return out;
}

function mergeFields(name, id, b, m, t) {
  const out = {};
  for (const k of Object.keys(t)) {
    if (same(m[k], b[k])) out[k] = t[k];
    else if (same(t[k], b[k]) || same(t[k], m[k])) out[k] = m[k];
    // A meal's kind is derived from the recipe, so a studio kind edit loses to the current recipe.
    else if (name === 'events' && k === 'kind' && MEAL_ID.test(id)) out[k] = t[k];
    else conflict(`${name}.${id}.${k}`);
  }
  return out;
}

function mergeMap(name, base, mine, theirs) {
  const out = new Map();
  for (const [id, t] of theirs) {
    const b = base.get(id), m = mine.get(id);
    if (!b) {
      if (m && !same(m, t)) conflict(`${name}.${id}`);
      out.set(id, t);
    } else if (!m) {
      if (!same(b, t)) conflict(`${name}.${id}`);
    } else out.set(id, mergeFields(name, id, b, m, t));
  }
  for (const [id, m] of mine) {
    if (theirs.has(id)) continue;
    const b = base.get(id);
    if (!b) out.set(id, m);
    else if (!same(b, m)) conflict(`${name}.${id}`);
  }
  return out;
}

function merge(base, mine, theirs) {
  if (!same(mine.meta.shopping, base.meta.shopping)) fail('採買清單請在「採買清單」分頁修改', 'shopping');
  const meta = mergeFields('meta', 'trip', base.meta, mine.meta, theirs.meta);
  meta.shopping = theirs.meta.shopping;
  const merged = { meta };
  for (const name of ['places', 'vehicles', 'days', 'events', 'routes', 'stops']) merged[name] = mergeMap(name, base[name], mine[name], theirs[name]);
  checkReferences(merged);
  return merged;
}

// A merge can combine edits that no longer fit together (for example a stop on a place someone else removed).
function checkReferences(r) {
  const place = (id, path) => { if (!r.places.has(id)) conflict(path); };
  for (const [id, d] of r.days) if (d.locationId !== '') place(d.locationId, `days.${id}.locationId`);
  for (const [id, e] of r.events) if (!r.days.has(e.day)) conflict(`events.${id}`);
  const carDays = new Set(), usedStops = new Set();
  for (const [id, route] of r.routes) {
    if (!r.days.has(route.day) || !r.vehicles.has(route.vehicleId)) conflict(`routes.${id}`);
    const carDay = `${route.day}\u0000${route.vehicleId}`;
    if (carDays.has(carDay)) conflict(`routes.${id}.vehicleId`);
    carDays.add(carDay);
    place(route.from, `routes.${id}.from`);
    place(route.to, `routes.${id}.to`);
    for (const s of route.stops) {
      if (!r.stops.has(s) || usedStops.has(s)) conflict(`routes.${id}.stops`);
      usedStops.add(s);
      place(r.stops.get(s).placeId, `stops.${s}.placeId`);
    }
  }
}

// ---- Writing the merged plan into a copy of the state ----
function consecutiveDates(days) {
  const sorted = [...days].sort((a, b) => (a[1].date < b[1].date ? -1 : 1));
  sorted.forEach(([, d], i) => {
    if (i && Date.parse(`${d.date}T00:00:00Z`) - Date.parse(`${sorted[i - 1][1].date}T00:00:00Z`) !== DAY_MS) fail('行程日期需連續，不能跳過日期', 'days');
  });
  if (!sorted.length || sorted.length > 31) fail('行程需為 1–31 天', 'days');
  return sorted;
}

function checkPlaceName(name, path) {
  const error = placeNameError(name);
  if (error) fail(PLACE_NAME_MESSAGES[error], path);
}

function setOrDelete(target, key, value, blank) {
  if (value === blank) delete target[key];
  else target[key] = value;
}

function apply(state, ids, theirs, r, canDelete) {
  const next = structuredClone(state);
  const diff = (name, id, k) => !same(r[name].get(id)[k], theirs[name].get(id)?.[k]);

  // Days and trip range.
  const sortedDays = consecutiveDates(r.days);
  const dateOf = new Map(sortedDays.map(([id, d]) => [id, d.date]));
  const startDate = sortedDays[0][1].date, endDate = sortedDays.at(-1)[1].date;
  if (next.trip.startDate !== startDate) next.trip.startDate = startDate;
  if (next.trip.endDate !== endDate) next.trip.endDate = endDate;

  // Trip text and storybook metadata.
  if (r.meta.title !== theirs.meta.title) {
    if (charCount(r.meta.title.trim()) > CARD_LIMITS.title) fail(`旅行名稱最多 ${CARD_LIMITS.title} 個字`, 'title');
    next.trip.title = r.meta.title;
  }
  const storybook = () => (next.storybook ??= {});
  for (const k of ['headline', 'caption']) if (r.meta[k] !== theirs.meta[k]) setOrDelete(storybook(), k, r.meta[k], '');

  // Places, with the trip destination as STUDIO_DEST_ID.
  const placeTaken = new Set(asList(state.places).map(p => p.id));
  const placeIds = new Map(ids.places.toWebId);
  placeIds.set(STUDIO_DEST_ID, DESTINATION_REF);
  const removedPlaces = new Set();
  for (const id of theirs.places.keys()) {
    if (r.places.has(id)) continue;
    if (id === STUDIO_DEST_ID) fail('旅行目的地請在旅行設定中修改，不能在行程編輯器移除', `places.${id}`);
    removedPlaces.add(ids.places.toWebId.get(id));
  }
  if (removedPlaces.size) next.places = next.places.filter(p => !removedPlaces.has(p.id));
  for (const [id, p] of r.places) {
    if (id === STUDIO_DEST_ID) {
      if (!theirs.places.has(id) || diff('places', id, 'name')) {
        if (charCount(p.name.trim()) > CARD_LIMITS.destination) fail(`目的地最多 ${CARD_LIMITS.destination} 個字`, `places.${id}.name`);
        next.trip.destination = p.name;
      }
      if (!theirs.places.has(id) || diff('places', id, 'templateId')) storybook().destinationTemplate = p.templateId;
      continue;
    }
    if (theirs.places.has(id)) {
      const place = next.places.find(x => x.id === ids.places.toWebId.get(id));
      if (diff('places', id, 'name')) { checkPlaceName(p.name, `places.${id}.name`); place.name = p.name; }
      if (diff('places', id, 'templateId')) place.templateId = p.templateId;
    } else {
      checkPlaceName(p.name, `places.${id}.name`);
      const webId = newWebId(id, placeTaken);
      placeIds.set(id, webId);
      (next.places ??= []).push({ id: webId, name: p.name, templateId: p.templateId });
    }
  }
  const placeRef = id => placeIds.get(id);

  // Events: activities and meals.
  const activityTaken = new Set(state.activities.map(a => a.id));
  let mealsRemoved = false;
  const removedActivities = new Set(), removedMeals = new Set();
  for (const id of theirs.events.keys()) {
    if (r.events.has(id)) continue;
    if (ids.meals.toWebId.has(id)) {
      if (!canDelete) fail('受邀旅伴可以編輯，但不能刪除既有餐點；請聯絡主辦人或管理員。', `events.${id}`);
      removedMeals.add(ids.meals.toWebId.get(id));
    } else removedActivities.add(ids.activities.toWebId.get(id));
  }
  if (removedActivities.size) next.activities = next.activities.filter(a => !removedActivities.has(a.id));
  if (removedMeals.size) { next.meals = next.meals.filter(m => !removedMeals.has(m.id)); mealsRemoved = true; }
  for (const [id, e] of r.events) {
    const date = dateOf.get(e.day);
    if (ids.meals.toWebId.has(id)) {
      const meal = next.meals.find(m => m.id === ids.meals.toWebId.get(id));
      if (meal.date !== date) meal.date = date;
      if (diff('events', id, 'time')) meal.time = e.time;
      if (diff('events', id, 'title')) {
        const prefix = `${cleanText(meal.slot)}：`;
        meal.title = e.title.startsWith(prefix) ? e.title.slice(prefix.length) : e.title;
      }
      if (diff('events', id, 'notes')) meal.notes = e.notes;
    } else if (ids.activities.toWebId.has(id)) {
      const activity = next.activities.find(a => a.id === ids.activities.toWebId.get(id));
      if (activity.date !== date) activity.date = date;
      if (diff('events', id, 'time')) activity.time = e.time;
      if (diff('events', id, 'title')) activity.title = e.title;
      if (diff('events', id, 'kind')) activity.type = KIND_TO_TYPE[e.kind];
      if (diff('events', id, 'notes')) activity.note = e.notes;
    } else {
      next.activities.push({
        id: newWebId(id, activityTaken), date, time: e.time, title: e.title, type: KIND_TO_TYPE[e.kind],
        location: '', note: e.notes, people: [], done: false
      });
    }
  }

  // Vehicles: seats, driver, passengers and meeting are never changed here.
  const vehicleTaken = new Set(state.vehicles.map(v => v.id));
  const vehicleIds = new Map(ids.vehicles.toWebId);
  const removedVehicles = new Set([...theirs.vehicles.keys()].filter(id => !r.vehicles.has(id)).map(id => ids.vehicles.toWebId.get(id)));
  if (removedVehicles.size) {
    if (!canDelete) fail('受邀旅伴可以編輯，但不能刪除既有車輛；請聯絡主辦人或管理員。', 'vehicles');
    if (next.activities.some(a => a.vehicleIds?.some(v => removedVehicles.has(v)))) fail('這台車仍有指定行程。請先把那些行程改派其他車輛或改為全體，再移除車輛。', 'vehicles');
    next.vehicles = next.vehicles.filter(v => !removedVehicles.has(v.id));
  }
  for (const [id, v] of r.vehicles) {
    if (theirs.vehicles.has(id)) {
      const vehicle = next.vehicles.find(x => x.id === ids.vehicles.toWebId.get(id));
      if (diff('vehicles', id, 'name')) vehicle.name = v.name;
      if (diff('vehicles', id, 'color')) vehicle.color = v.color;
    } else {
      const webId = newWebId(id, vehicleTaken);
      vehicleIds.set(id, webId);
      next.vehicles.push({ id: webId, name: v.name, driver: '', seats: NEW_VEHICLE_SEATS, passengers: [], meeting: '', color: v.color });
    }
  }

  // Routes and their stops.
  const oldStops = new Map(asList(state.routes).flatMap(route => asList(route.stops)).map(st => [st.id, st]));
  const stopTaken = new Set(oldStops.keys());
  const routeTaken = new Set(asList(state.routes).map(x => x.id));
  const buildStop = sid => {
    const st = r.stops.get(sid), old = theirs.stops.get(sid);
    const webId = ids.stops.toWebId.get(sid);
    const out = old ? structuredClone(oldStops.get(webId)) : { id: newWebId(sid, stopTaken) };
    const touched = k => !old || !same(st[k], old[k]);
    if (touched('placeId')) out.place = placeRef(st.placeId);
    if (touched('kind')) {
      out.kind = STOP_TASK_KINDS[st.kind];
      setOrDelete(out, 'taskKind', st.kind, DEFAULT_STOP_TASK[out.kind]);
    }
    if (touched('time')) setOrDelete(out, 'time', st.time, '');
    // Shopping stop items are derived from the shopping list, never written back from the studio.
    if (touched('items') && out.kind !== 'shop') { if (st.items.length) out.items = [...st.items]; else delete out.items; }
    if (touched('notes')) setOrDelete(out, 'note', st.notes, '');
    return out;
  };
  const stopsChanged = (route, old) => !old || !same(route.stops, old.stops)
    || route.stops.some(s => !same(r.stops.get(s), theirs.stops.get(s)));
  const removedRoutes = new Set([...theirs.routes.keys()].filter(id => !r.routes.has(id)).map(id => ids.routes.toWebId.get(id)));
  if (removedRoutes.size) next.routes = next.routes.filter(x => !removedRoutes.has(x.id));
  for (const [id, route] of r.routes) {
    const old = theirs.routes.get(id);
    const date = dateOf.get(route.day);
    if (old) {
      const target = next.routes.find(x => x.id === ids.routes.toWebId.get(id));
      if (target.date !== date) target.date = date;
      if (diff('routes', id, 'vehicleId')) target.vehicleId = vehicleIds.get(route.vehicleId);
      if (diff('routes', id, 'from')) target.from = placeRef(route.from);
      if (diff('routes', id, 'to')) target.to = placeRef(route.to);
      if (diff('routes', id, 'departure')) setOrDelete(target, 'time', route.departure, '');
      if (stopsChanged(route, old)) {
        if (route.stops.length || target.stops !== undefined) target.stops = route.stops.map(buildStop);
      }
    } else {
      (next.routes ??= []).push({
        id: newWebId(id, routeTaken), date, vehicleId: vehicleIds.get(route.vehicleId),
        from: placeRef(route.from), to: placeRef(route.to),
        ...(route.departure ? { time: route.departure } : {}),
        ...(route.stops.length ? { stops: route.stops.map(buildStop) } : {})
      });
    }
  }

  // Day settings follow their day; settings of removed days are dropped with the day.
  const defaultLocation = hasDestination(state) ? STUDIO_DEST_ID : '';
  const blankDay = { title: '', locationId: defaultLocation, routePosition: 'before', arrivalLabel: '', arrival: '' };
  const byOldDate = new Map(asList(state.daySettings).map((s, i) => [s.date, i]));
  const keep = new Set(), created = [];
  const settings = asList(next.daySettings);
  for (const [id, d] of r.days) {
    const old = theirs.days.get(id);
    const index = old ? byOldDate.get(old.date) : undefined;
    let entry = index === undefined ? undefined : settings[index];
    const before = old ?? blankDay;
    const touched = Object.keys(blankDay).filter(k => !same(d[k], before[k]));
    if (!entry && !touched.length) continue;
    const fresh = !entry;
    if (fresh) entry = { date: d.date };
    for (const k of touched) {
      if (k === 'locationId') {
        if (d.locationId === '' || d.locationId === STUDIO_DEST_ID) delete entry.place;
        else entry.place = placeRef(d.locationId);
      } else if (k === 'routePosition') setOrDelete(entry, k, d[k], 'before');
      else setOrDelete(entry, k, d[k], '');
    }
    if (entry.date !== d.date) entry.date = d.date;
    if (fresh) { if (Object.keys(entry).length > 1) created.push(entry); }
    else if (touched.length && Object.keys(entry).length === 1) continue;
    else keep.add(index);
  }
  if (Array.isArray(next.daySettings) || created.length) {
    next.daySettings = [...settings.filter((_, i) => keep.has(i)), ...created];
  }

  if (mealsRemoved) {
    try { syncMealIngredients(next); } catch (error) { fail(error.message, 'meals'); }
  }
  if (!isValidState(next)) fail('儲存後的旅行資料不符合網站格式，請檢查地點名稱、日期與路線');
  return next;
}

/**
 * Writes a studio plan back into a copy of `state` (never modified). `basePlan` is the toStudio() plan the draft
 * started from; edits made to the state since then are kept, and a field both sides changed differently throws
 * StudioConflictError. Without `basePlan` the plan is compared with toStudio(state). `canDelete: false` (invited
 * members) blocks removing meals and vehicles. Throws StudioValidationError for any other invalid change.
 */
export function fromStudio(state, plan, { canDelete = true, basePlan } = {}) {
  if (!isValidState(state)) fail('旅行資料格式不正確，無法儲存行程');
  const ids = tables(state);
  const theirs = flatten(project(state, ids));
  const mine = flatten(plan);
  const base = basePlan === undefined ? theirs : flatten(basePlan);
  return apply(state, ids, theirs, merge(base, mine, theirs), canDelete);
}
