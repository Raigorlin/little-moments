// Card edits of the Itinerary_Editor (design 「src/itinerary-edits.js」). Every write the planner makes is one pure
// function here, so src/app.js and the property tests apply the same rules (requirement 23.14). No DOM; neither the
// input Trip_State nor the Draft is modified: a write works on structuredClone(state).
//
// The edits, in file order: Places; Day_Settings and Arrival_Time; Routes with the Route Draft helpers; legacy
// departures; Activities with the Activity Draft helpers; Meal_Moment times; and saveVehicle() and saveMeal(), the
// state changes of the Vehicle_Dialog and the meal dialog taken out of src/app.js (src/app.js uses them from task 13).
// All of them share the result contract and the helpers below (failure(), success(), unknownTarget(), idSource(),
// dayNumber(), errorList()).
//
// Results
//   success  { ok: true, state, message, focus }
//     state    The new Trip_State; it passed isValidState() (requirements 10.10, 18.15). Only the target item changed,
//              plus the listed side effects (the chosen new Draft Places of saveRoute() and saveDaySettings(), the
//              car's `meeting` for a First_Day route, and the shopping items that syncMealIngredients() adds or removes
//              for saveMeal()); every other item of every collection keeps its id and its order (requirement 21.8).
//     message  Text for notify() and the event log naming the action and its target (requirement 16.8), for example
//              「已儲存第三車・採買組第 1 天的路線」. saveVehicle() and saveMeal() keep the texts the dialogs already used.
//     focus    data-focus value of the control that takes focus after the write (requirements 16.7, 16.14(b)). The
//              values are the card keys of design 「planner 狀態」, so a control that toggles a card carries the same
//              value in data-focus:
//                'place:{id}'                a Place row of Places_And_Cars (its 改名 button)
//                'place:new'                 the Places_And_Cars ＋新增地點 button, when no Place is left
//                'day'                       the 這一天的設定 card
//                'arrival'                   the 預計幾點抵達 card; it hides when the time is cleared on a day without
//                                            Arrival_Routes (requirement 4.8), and the editor then falls back
//                'route:{id}'                a Route's collapsed row, wherever the saved Route now sorts
//                'route:legacy:{vehicleId}'  a 舊的出發資料 row (its 轉成路線 button)
//                'route:new'                 the ＋新增路線 button, when the day's route list is left empty
//                'activity:{id}'             an Activity's collapsed row, wherever the saved Activity now sorts
//                'meal:{id}'                 a Meal_Moment's collapsed row
//                'activity:new'              the ＋自訂活動 button, when the day's 活動 list is left empty or a
//                                            自訂活動 was saved on another day (requirement 7.12)
//              and, for controls that toggle no card:
//                'activity-done:{id}'        the 完成 checkbox of an Activity row (requirement 16.14(d))
//                'vehicle:{id}'              a car row of Places_And_Cars (its 編輯 {車名} button); the Vehicle_Dialog
//                                            itself returns focus to the control that opened it
//                'meal-edit-{id}'            the 編輯 {料理名稱} button of a meal card in 料理菜單 (task 9.8)
//   failure  { ok: false, errors, formError, usages }
//     errors     [{ field, message }], at most one per field, in the order of the card's fields; the editor marks
//                each field and focuses the first one (requirement 16.13).
//     formError  A card-level message that belongs to no field, or ''.
//     usages     deletePlace() only: placeUsages() of a Place that is still used (requirement 2.7); otherwise [].
//
// Error fields (stable names that the editor maps to its form fields):
//   savePlace        name
//   saveDaySettings  title, place
//   saveArrival      arrival
//   saveRoute        vehicle, from, to, time, then for each Draft Stop stop-{key}-place, stop-{key}-kind and
//                    stop-{key}-note, where {key} is that Stop's key in the Draft
//   saveActivity     title, date, time, type, participation, vehicles, location, note
//   saveMealTime     time
// addPresets(), saveVehicle() and saveMeal() report formError only. The two dialogs show one message in their
// .form-error, so saveVehicle() and saveMeal() stop at the first check that fails.
// formError texts are EDIT_MESSAGES.invalidState (the result failed isValidState(), or the target no longer exists),
// placeLimit, stopLimit, placeInUse, activityLimit and presetNone, the dialog texts listed at saveVehicle() and
// saveMeal(), and the error message of syncMealIngredients(); saveRoute() joins two of them with 「；」.
//
// ctx: { uid, day }
//   uid  Optional generator of new identifiers (Places, Routes, Stops, Activities, Vehicles and Meals); uid() of
//        ./model.js by default. Tests pass a reproducible one. The shopping items that syncMealIngredients() adds get
//        their ids from crypto.randomUUID() as before.
//   day  saveActivity() only: the Trip_Day the editor shows ('YYYY-MM-DD'), which decides the focus when the Activity
//        is saved on another day (requirement 7.12). Defaults to the saved Activity's date, or the Draft's date for a
//        自訂活動.
import { isValidState, uid } from './model.js';
import { parseVehicleMeeting } from './vehicle-departures.js';
import { mealSlotOptions } from './meal-order.js';
import { DISH_TYPES } from './recipes.js';
import { parseIngredients, syncMealIngredients } from './ingredients.js';
import {
  ACTIVITY_TYPES, DESTINATION_REF, LIMITS, PLACE_NAME_MESSAGES, STOP_KINDS, categoryLabel, charCount, cleanText,
  mealTitle, normalizeTimeInput, placeKey, placeNameError, presetsFor, trimWhite
} from './itinerary-model.js';
import { dayLocation, dayModel, legacyDepartures, placeUsages, sortedRoutes, tripDays } from './itinerary-derive.js';

/** Messages of the edits. Place name errors use PLACE_NAME_MESSAGES of ./itinerary-model.js. */
export const EDIT_MESSAGES = Object.freeze({
  invalidState: '資料驗證未通過，沒有儲存。請重新載入後再試。',
  placeLimit: '地點最多 100 個',
  placeInUse: '這個地點還在使用中，請先把下列使用處改成其他地點。',
  dayTitle: '標題最多 20 個字。',
  dayPlace: '請重新選擇地點。',
  time: '請以 24 小時制填寫完整的時和分，例如 08:30；不填時請清空。',
  vehicle: '請選擇哪一台車。',
  vehicleTaken: '這台車這一天已有路線，請選擇其他車。',
  from: '請選擇從哪裡出發。',
  to: '請選擇最後到哪裡。',
  sameEnds: '起點與終點相同，請選擇其他終點，或新增途中任務。',
  stopLimit: '每台車最多 6 個停靠點',
  stopPlace: '請選擇停在哪裡。',
  stopKind: '請選擇要做什麼。',
  stopNote: '備註最多 100 個字。',
  // Activity and 自訂活動 cards, 常用活動 (requirement 7.10).
  activityTitle: '請填寫標題。',
  activityTitleLong: '標題最多 100 個字。',
  activityDate: '請重新選擇日期。',
  activityTimeRequired: '請填寫時間，例如 08:30。',
  activityTime: '請以 24 小時制填寫完整的時和分，例如 08:30。',
  activityType: '請選擇類別。',
  participation: '請選擇參加方式。',
  activityVehicles: '請至少勾選一台參加的車。',
  activityLocation: '地點最多 150 個字。',
  activityNote: '備註最多 1,000 個字。',
  activityLimit: '活動最多 1,000 筆，請先刪除不需要的活動。',
  presetNone: '請先勾選要加入的常用活動。',
  // Vehicle_Dialog and the meal dialog: the texts the dialogs already showed …
  required: '請填寫必要欄位，不能只有空白。',
  vehicleCapacity: '乘客加上駕駛不能超過座位數。',
  mealSlot: '請選擇有效的餐次。',
  mealImage: '請選擇有效的料理圖片。',
  mealIngredients: '食材最多 500 字，請先整理清單。',
  // … and the limits that only the fields' maxlength, min and max attributes enforced before.
  vehicleName: '車輛暱稱最多 50 個字。',
  vehicleSeats: '座位數（含駕駛）請填 1 到 9 的整數。',
  mealName: '料理名稱最多 100 個字。',
  mealServings: '人數請填 1 到 100 的整數。',
  mealNotes: '料理筆記最多 1,000 個字。'
});

// ---- Shared helpers ----
const NEW_REF = 'new:';
const STOP_KIND_KEYS = new Set(STOP_KINDS.map(entry => entry.kind));
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => (Array.isArray(value) ? value : []);
const text = value => (typeof value === 'string' ? value : '');
const destinationOf = state => text(state?.trip?.destination);
/** True for the id of an item that is not saved yet (null, undefined or ''). */
const isNewTarget = id => id === undefined || id === null || id === '';

function failure({ errors = [], formError = '', usages = [] } = {}) {
  return { ok: false, errors, formError, usages };
}
/** Every successful write ends here: the new state must pass the State_Validator (requirements 10.10, 18.15). */
function success(next, message, focus) {
  return isValidState(next) ? { ok: true, state: next, message, focus } : failure({ formError: EDIT_MESSAGES.invalidState });
}
/** The target (a Place, Route, Vehicle or Trip_Day) is not in the saved state, for example after another tab's change. */
const unknownTarget = () => failure({ formError: EDIT_MESSAGES.invalidState });
/** The identifier generator: ctx.uid(), or uid() of ./model.js. */
const idSource = ctx => (typeof ctx?.uid === 'function' ? () => ctx.uid() : uid);
/** Day number N (First_Day is 1) of a Trip_Day; 0 when `date` is not a Trip_Day. */
const dayNumber = (state, date) => tripDays(state).find(day => day.date === date)?.n ?? 0;
/** Field errors in the order they are added, keeping only the first error of each field. */
function errorList() {
  const errors = [];
  const add = (field, message) => {
    if (!errors.some(error => error.field === field)) errors.push({ field, message });
  };
  return { errors, add };
}

/** The Draft's new Places [{ ref, name }] in the order they were added: entries whose ref starts with 'new:' (the
 * first one of a repeated ref), with the name trimmed of White_Space (requirement 2.1(a)). */
function draftPlaces(newPlaces) {
  const seen = new Set();
  return list(newPlaces).flatMap(entry => {
    const ref = text(entry?.ref);
    if (!ref.startsWith(NEW_REF) || seen.has(ref)) return [];
    seen.add(ref);
    return [{ ref, name: trimWhite(text(entry.name)) }];
  });
}
/** The Draft's new Places still chosen in one of `refs` (requirement 2.11), in the order they were added. */
function chosenPlaces(newPlaces, refs) {
  const used = new Set(refs);
  return draftPlaces(newPlaces).filter(entry => used.has(entry.ref));
}
/** Map ref → placeNameError() reason of each chosen new Place whose name breaks requirement 2.1, compared with the
 * saved Places, the trip destination and the chosen new Places before it. */
function placeReasons(state, chosen) {
  const reasons = new Map(), pending = [];
  for (const { ref, name } of chosen) {
    const reason = placeNameError(name, { places: list(state.places), destination: destinationOf(state), pending });
    if (reason) reasons.set(ref, reason);
    pending.push(name);
  }
  return reasons;
}
/** Kind of a Draft place reference: 'new' (one of the Draft's new Places; this wins over a saved Place with the same
 * id), 'destination' (while the trip destination is not blank), 'place' (a saved Place), or null (not chosen, or a
 * reference that no longer exists). */
function placeResolver(state, newPlaces) {
  const drafted = new Set(draftPlaces(newPlaces).map(entry => entry.ref));
  const saved = new Set(list(state.places).filter(isRecord).map(place => place.id));
  const destination = trimWhite(destinationOf(state)) !== '';
  return ref => {
    if (typeof ref !== 'string' || !ref) return null;
    if (drafted.has(ref)) return 'new';
    if (ref === DESTINATION_REF) return destination ? 'destination' : null;
    return saved.has(ref) ? 'place' : null;
  };
}
/** `base`, or `base` with a number added, that is not in `taken`; the result is added to `taken`. */
function unusedId(base, taken) {
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}#${i}`;
  taken.add(id);
  return id;
}
/** Focus keys of a day's route list in screen order: the Route rows (requirement 5.2), then on the First_Day the
 * 舊的出發資料 rows (requirement 19.4). */
function routeRowKeys(state, date) {
  const keys = sortedRoutes(state, date).map(route => `route:${route.id}`);
  if (tripDays(state)[0]?.date === date) keys.push(...legacyDepartures(state).map(entry => `route:legacy:${entry.vehicle.id}`));
  return keys;
}
/** Requirement 16.14(b): the item after `key`, else the item before it, else `fallback` (the list's add button). */
function neighborKey(keys, key, fallback) {
  const index = keys.indexOf(key);
  if (index < 0) return fallback;
  return keys[index + 1] ?? keys[index - 1] ?? fallback;
}

// ---- Places (Places_And_Cars) ----

/**
 * Adds a Place (`id` null, undefined or '') or renames the Place `id` (requirements 2.1–2.3, 2.8, 3.4).
 * Checks: placeNameError() of the name against the other Places and the destination (field `name`); adding when
 * Place_List already has 100 Places (formError placeLimit). A new Place goes at the end of Place_List with the id
 * ctx.uid(); a rename changes only the name and keeps the position. The name is stored without leading and trailing
 * White_Space. Renaming a Place that is not saved fails with formError invalidState.
 */
export function savePlace(state, values, ctx) {
  const id = values?.id;
  const places = list(state.places);
  const adding = isNewTarget(id);
  const index = adding ? -1 : places.findIndex(place => isRecord(place) && place.id === id);
  if (!adding && index < 0) return unknownTarget();
  const name = trimWhite(text(values?.name));
  const reason = placeNameError(name, { places, destination: destinationOf(state), exceptId: adding ? undefined : id });
  const errors = reason ? [{ field: 'name', message: PLACE_NAME_MESSAGES[reason] }] : [];
  const formError = adding && places.length >= LIMITS.places ? EDIT_MESSAGES.placeLimit : '';
  if (errors.length || formError) return failure({ errors, formError });

  const next = structuredClone(state);
  if (adding) {
    const place = { id: idSource(ctx)(), name };
    next.places = [...list(next.places), place];
    return success(next, `已新增地點「${cleanText(name)}」`, `place:${place.id}`);
  }
  const old = text(places[index].name);
  next.places[index] = { ...next.places[index], name };
  const message = old === name ? `已儲存地點「${cleanText(name)}」` : `已把地點「${cleanText(old)}」改名為「${cleanText(name)}」`;
  return success(next, message, `place:${id}`);
}

/**
 * Deletes a Place (requirements 2.7, 10.7). While a Route's start, end or Stop, or a Day_Location, still uses it,
 * nothing is written and the failure has the placeUsages() list in `usages` and formError placeInUse; the editor
 * lists the usages and opens no confirmation. Deleting a Place that is not saved fails with formError invalidState.
 * focus is the next Place row, else the previous one, else 'place:new'.
 */
export function deletePlace(state, placeId) {
  const places = list(state.places);
  const index = typeof placeId === 'string' ? places.findIndex(place => isRecord(place) && place.id === placeId) : -1;
  if (index < 0) return unknownTarget();
  const usages = placeUsages(state, placeId);
  if (usages.length) return failure({ formError: EDIT_MESSAGES.placeInUse, usages });

  const next = structuredClone(state);
  next.places.splice(index, 1);
  const focus = neighborKey(places.map(place => `place:${place.id}`), `place:${placeId}`, 'place:new');
  return success(next, `已刪除地點「${cleanText(text(places[index].name))}」`, focus);
}

// ---- Day_Settings and Arrival_Time ----

/** Stores the Day_Settings entry of `date` in `next`, or removes it when Day_Title, Day_Location and Arrival_Time are
 * all unset (requirement 4.10; a title of only White_Space is unset). An entry keeps its position; a new one is added
 * at the end. A missing daySettings field stays missing when there is nothing to store. */
function putDaySetting(next, date, entry) {
  const settings = list(next.daySettings);
  const index = settings.findIndex(setting => isRecord(setting) && setting.date === date);
  if (!trimWhite(text(entry.title)) && !text(entry.place) && !text(entry.arrival)) {
    if (index >= 0) settings.splice(index, 1);
  } else if (index >= 0) settings[index] = entry;
  else next.daySettings = [...settings, entry];
}

/**
 * Saves 這一天的設定 of the Trip_Day `date` (requirements 4.5, 4.9, 4.10, 4.13, D17).
 * draft: { title, place, newPlaces } — title as typed; place is the chosen Day_Location: a Place id, '@destination'
 * (Destination_Place), '' (不指定地點) or a 'new:{k}' reference of `newPlaces` ([{ ref, name }], see the Route Draft).
 * Checks: the trimmed title is longer than 20 characters (field `title`); the chosen reference no longer exists
 * (field `place`, dayPlace) or is a new Place whose name now breaks requirement 2.1 (field `place`, the
 * PLACE_NAME_MESSAGES text); the chosen new Place would make more than 100 Places (formError placeLimit).
 * Writes the trimmed title when it is not blank and the Place when one is chosen; '@destination' and '' leave the
 * place unset. The chosen new Place is added at the end of Place_List; the other Draft Places are dropped. Arrival_Time
 * stays as it is, and the entry is removed when all three are unset. A `date` outside the trip fails with formError
 * invalidState. focus is 'day'.
 */
export function saveDaySettings(state, date, draft, ctx) {
  const n = dayNumber(state, date);
  if (!n) return unknownTarget();
  const title = trimWhite(text(draft?.title));
  const ref = text(draft?.place);
  // 不指定地點 and Destination_Place are both stored as an unset Day_Location (D17).
  const unset = ref === '' || ref === DESTINATION_REF;
  const kind = unset ? null : placeResolver(state, draft?.newPlaces)(ref);
  const chosen = kind === 'new' ? chosenPlaces(draft.newPlaces, [ref]) : [];
  const reasons = placeReasons(state, chosen);
  const { errors, add } = errorList();
  if (charCount(title) > LIMITS.dayTitle) add('title', EDIT_MESSAGES.dayTitle);
  if (!unset && !kind) add('place', EDIT_MESSAGES.dayPlace);
  else if (reasons.has(ref)) add('place', PLACE_NAME_MESSAGES[reasons.get(ref)]);
  const formError = list(state.places).length + chosen.length > LIMITS.places ? EDIT_MESSAGES.placeLimit : '';
  if (errors.length || formError) return failure({ errors, formError });

  const next = structuredClone(state);
  let place = kind === 'place' ? ref : '';
  if (kind === 'new') {
    place = idSource(ctx)();
    next.places = [...list(next.places), { id: place, name: chosen[0].name }];
  }
  const entry = { ...list(next.daySettings).find(setting => isRecord(setting) && setting.date === date), date };
  if (title) entry.title = title;
  else delete entry.title;
  if (place) entry.place = place;
  else delete entry.place;
  putDaySetting(next, date, entry);
  return success(next, `已儲存第 ${n} 天的設定`, 'day');
}

/**
 * Saves the 預計幾點抵達 time of the Trip_Day `date` (requirements 4.8, 4.9, 4.13). `arrival` is the field as typed:
 * blank removes Arrival_Time; otherwise normalizeTimeInput() must give HH:MM (full-width digits are accepted; a partial
 * time is an error, field `arrival`). Day_Title and Day_Location stay as they are, and the entry is removed when all
 * three are unset. A `date` outside the trip fails with formError invalidState. focus is 'arrival'.
 */
export function saveArrival(state, date, values) {
  const n = dayNumber(state, date);
  if (!n) return unknownTarget();
  const time = normalizeTimeInput(text(values?.arrival));
  if (time.error) return failure({ errors: [{ field: 'arrival', message: EDIT_MESSAGES.time }] });

  const next = structuredClone(state);
  const entry = { ...list(next.daySettings).find(setting => isRecord(setting) && setting.date === date), date };
  if (time.value) entry.arrival = time.value;
  else delete entry.arrival;
  putDaySetting(next, date, entry);
  return success(next, `已${time.value ? '儲存' : '清除'}第 ${n} 天的預計抵達時間`, 'arrival');
}

// ---- Routes and Route Drafts ----
//
// Route Draft (design 「Route Draft 的形狀」): the unsaved values of one Route card.
// {
//   routeId,    the saved Route's id; null for a new Route
//   date,       the Trip_Day, 'YYYY-MM-DD'
//   vehicleId,  '' when 哪一台車 is not chosen
//   from, to,   a place reference: a Place id, '@destination', 'new:{k}' (a Draft new Place) or '' (not chosen)
//   time,       the 幾點出發 field as typed
//   stops,      [{ stopId, key, place, kind, note }] in Route order. stopId is the saved Stop's id (null for a Stop
//               added in the Draft); key is unique within the Draft and names the Stop's fields in errors
//               (routeDraft() uses '1', '2', …); place is a place reference; kind is a STOP_KINDS kind; note is the
//               備註 field as typed (ignored for 採買)
//   newPlaces,  [{ ref: 'new:{k}', name }], the Places added with ＋新增地點 or 轉成路線, in the order they were added
//   legacyText  the old departure place shown when 轉成路線 could not choose 從哪裡出發, otherwise ''
// }

/** Every place reference of a Route Draft. */
const draftRefs = draft => [draft.from, draft.to, ...list(draft.stops).map(stop => stop?.place)];

/** Key that names a Draft Stop's fields: its `key`, or its position from 1 when it has none. */
function stopKey(stop, index) {
  const key = stop?.key;
  if (typeof key === 'string' && key) return key;
  return Number.isFinite(key) ? String(key) : String(index + 1);
}

/**
 * Applies a Route Draft to a copy of `state` as saveRoute() stores it; previewState() uses it without the checks.
 * `ids` gives the identifiers of new things, called in this order: place(entry) for each chosen new Place in the
 * order they were added, route() for a new Route, stop(index) for each new Stop in Stop order. A Draft Stop keeps its
 * stopId when that is a Stop of the saved Route (each id once). Returns { next, route }.
 */
function applyRouteDraft(state, draft, { time, ids }) {
  const next = structuredClone(state);
  const chosen = chosenPlaces(draft.newPlaces, draftRefs(draft));
  const refs = new Map();
  if (chosen.length) {
    next.places = [...list(next.places), ...chosen.map(entry => {
      const id = ids.place(entry);
      refs.set(entry.ref, id);
      return { id, name: entry.name };
    })];
  }
  const ref = value => refs.get(value) ?? text(value);
  const routes = Array.isArray(next.routes) ? next.routes : (next.routes = []);
  const index = isNewTarget(draft.routeId) ? -1 : routes.findIndex(item => isRecord(item) && item.id === draft.routeId);
  const own = new Set(index < 0 ? [] : list(routes[index].stops).map(stop => stop?.id));
  const route = {
    id: index < 0 ? ids.route() : routes[index].id,
    date: text(draft.date), vehicleId: text(draft.vehicleId), from: ref(draft.from), to: ref(draft.to), time,
    stops: list(draft.stops).map((stop, i) => {
      const kind = text(stop?.kind);
      const entry = { id: own.delete(stop?.stopId) ? stop.stopId : ids.stop(i), place: ref(stop?.place), kind };
      // A 採買 Stop has no note (requirement 6.4); other notes are stored trimmed, and only when not blank.
      const note = trimWhite(text(stop?.note));
      if (kind !== 'shop' && note) entry.note = note;
      return entry;
    })
  };
  if (index < 0) routes.push(route);
  else routes[index] = route;
  // A First_Day route now records the car's departure, so its old `meeting` is cleared (requirement 19.5).
  if (route.date === tripDays(state)[0]?.date) {
    const vehicle = list(next.vehicles).find(item => isRecord(item) && item.id === route.vehicleId);
    if (vehicle) vehicle.meeting = '';
  }
  return { next, route };
}

/**
 * Saves a Route card (requirements 2.11, 5.9–5.11, 6.1, 6.4, 6.13, 19.5). Checks, as field errors in card order:
 * - vehicle: 哪一台車 is not chosen or no longer exists (vehicle); the car already has another route that day
 *   (vehicleTaken);
 * - from, to: not chosen or no longer existing (from, to), or a chosen new Place whose name now breaks requirement 2.1
 *   (the PLACE_NAME_MESSAGES text); to: the same place as from while there is no Stop (sameEnds);
 * - time: not blank and not HH:MM after normalizeTimeInput() (time);
 * - each Stop: stop-{key}-place like from (stopPlace); stop-{key}-kind not a STOP_KINDS kind (stopKind);
 *   stop-{key}-note longer than 100 characters after trimming, for a kind other than 採買 (stopNote);
 * and as formError: more than 6 Stops (stopLimit); the chosen new Places would make more than 100 Places (placeLimit).
 * Writes the Route with the Draft's date, car, start, time ('' when blank), Stops in Draft order and end. A saved Route
 * keeps its id and position, and its Stops kept in the Draft keep their ids, also when the car changes; a new Route
 * goes at the end of routes. New Places, Route and Stops get ids from ctx.uid() (in that order). Only the Draft's new
 * Places still chosen are added at the end of Place_List, in the order they were added, and their 'new:{k}'
 * references are replaced by the new ids. A First_Day route sets its car's `meeting` to ''. A Draft for a Route that
 * is no longer saved, or for a date outside the trip, fails with formError invalidState. focus is 'route:{id}'.
 */
export function saveRoute(state, draft, ctx) {
  const d = isRecord(draft) ? draft : {};
  const date = text(d.date);
  const n = dayNumber(state, date);
  const stored = isNewTarget(d.routeId) ? null : list(state.routes).find(route => isRecord(route) && route.id === d.routeId);
  if (!n || stored === undefined) return unknownTarget();

  const resolve = placeResolver(state, d.newPlaces);
  const stops = list(d.stops);
  const chosen = chosenPlaces(d.newPlaces, draftRefs(d));
  const reasons = placeReasons(state, chosen);
  const { errors, add } = errorList();
  const checkPlace = (field, ref, missing) => {
    if (!resolve(ref)) add(field, missing);
    else if (reasons.has(ref)) add(field, PLACE_NAME_MESSAGES[reasons.get(ref)]);
  };
  const vehicle = typeof d.vehicleId === 'string' && d.vehicleId
    ? list(state.vehicles).find(item => isRecord(item) && item.id === d.vehicleId) : undefined;
  if (!vehicle) add('vehicle', EDIT_MESSAGES.vehicle);
  else if (list(state.routes).some(route => isRecord(route) && route !== stored && route.date === date && route.vehicleId === vehicle.id)) {
    add('vehicle', EDIT_MESSAGES.vehicleTaken);
  }
  checkPlace('from', d.from, EDIT_MESSAGES.from);
  checkPlace('to', d.to, EDIT_MESSAGES.to);
  if (resolve(d.to) && d.from === d.to && !stops.length) add('to', EDIT_MESSAGES.sameEnds);
  const time = normalizeTimeInput(text(d.time));
  if (time.error) add('time', EDIT_MESSAGES.time);
  stops.forEach((stop, index) => {
    const key = stopKey(stop, index);
    checkPlace(`stop-${key}-place`, stop?.place, EDIT_MESSAGES.stopPlace);
    if (!STOP_KIND_KEYS.has(stop?.kind)) add(`stop-${key}-kind`, EDIT_MESSAGES.stopKind);
    else if (stop.kind !== 'shop' && charCount(trimWhite(text(stop.note))) > LIMITS.stopNote) add(`stop-${key}-note`, EDIT_MESSAGES.stopNote);
  });
  const formErrors = [];
  if (stops.length > LIMITS.stops) formErrors.push(EDIT_MESSAGES.stopLimit);
  if (list(state.places).length + chosen.length > LIMITS.places) formErrors.push(EDIT_MESSAGES.placeLimit);
  if (errors.length || formErrors.length) return failure({ errors, formError: formErrors.join('；') });

  const makeId = idSource(ctx);
  const { next, route } = applyRouteDraft(state, d, { time: time.value, ids: { place: makeId, route: makeId, stop: makeId } });
  return success(next, `已儲存${cleanText(text(vehicle.name))}第 ${n} 天的路線`, `route:${route.id}`);
}

/**
 * Deletes a Route with its Stops (requirement 10.7); shopping items do not change (they are derived again, 6.11).
 * focus is the next row of that day's route list (Route rows, then 舊的出發資料 rows on the First_Day), else the
 * previous row, else 'route:new'. Deleting a Route that is not saved fails with formError invalidState.
 */
export function deleteRoute(state, routeId) {
  const routes = list(state.routes);
  const index = typeof routeId === 'string' ? routes.findIndex(route => isRecord(route) && route.id === routeId) : -1;
  if (index < 0) return unknownTarget();
  const route = routes[index];
  const vehicle = list(state.vehicles).find(item => isRecord(item) && item.id === route.vehicleId);
  const focus = neighborKey(routeRowKeys(state, route.date), `route:${routeId}`, 'route:new');

  const next = structuredClone(state);
  next.routes.splice(index, 1);
  return success(next, `已刪除${cleanText(text(vehicle?.name))}第 ${dayNumber(state, route.date)} 天的路線`, focus);
}

/** Draft of a saved Route card (requirement 5.3), or null when the Route is not saved. */
export function routeDraft(state, routeId) {
  const route = list(state?.routes).find(item => isRecord(item) && item.id === routeId);
  if (!route) return null;
  return {
    routeId: route.id, date: route.date, vehicleId: route.vehicleId, from: route.from, to: route.to, time: text(route.time),
    stops: list(route.stops).map((stop, index) => ({
      stopId: stop.id, key: String(index + 1), place: stop.place, kind: stop.kind, note: text(stop.note)
    })),
    newPlaces: [], legacyText: ''
  };
}

/** Draft of ＋新增路線 on `date` (requirement 5.6): the first car in state.vehicles without a route that day ('' when
 * there is none), no start, no time, no Stop, and the Day_Location as the end ('' when the day has none). */
export function newRouteDraft(state, date) {
  const busy = new Set(list(state?.routes).filter(route => isRecord(route) && route.date === date).map(route => route.vehicleId));
  const vehicle = list(state?.vehicles).find(item => isRecord(item) && !busy.has(item.id));
  return {
    routeId: null, date, vehicleId: vehicle?.id ?? '', from: '', to: dayLocation(state, date)?.ref ?? '', time: '',
    stops: [], newPlaces: [], legacyText: ''
  };
}

/**
 * Draft of 轉成路線 for a car's Legacy_Departure (requirement 19.11), or null when the car does not exist. The Route
 * is on the First_Day with that car, the old time (parseVehicleMeeting(), '' when none), the First_Day's Day_Location
 * as the end ('' when none) and no Stop. 從哪裡出發 is the Destination_Place or Place with the same name as the old
 * place (placeKey(), requirement 2.1(d)); otherwise a new Place with that name is added to the Draft as 'new:1' and
 * chosen. When the old place is blank, breaks requirement 2.1, or Place_List already has 100 Places, nothing is chosen
 * and legacyText keeps the old place for the card (legacyText stays '' for a blank place). A car that already has a
 * First_Day route still gets a Draft; saveRoute() then reports vehicleTaken.
 */
export function legacyRouteDraft(state, vehicleId) {
  const vehicle = list(state?.vehicles).find(item => isRecord(item) && item.id === vehicleId);
  const first = tripDays(state)[0];
  if (!vehicle || !first) return null;
  const { time, location } = parseVehicleMeeting(text(vehicle.meeting));
  const draft = {
    routeId: null, date: first.date, vehicleId: vehicle.id, from: '', to: dayLocation(state, first.date)?.ref ?? '', time,
    stops: [], newPlaces: [], legacyText: ''
  };
  const name = trimWhite(location);
  if (!name) return draft;
  const places = list(state.places).filter(isRecord), destination = destinationOf(state), key = placeKey(name);
  const same = trimWhite(destination) && placeKey(destination) === key
    ? DESTINATION_REF : places.find(place => placeKey(text(place.name)) === key)?.id;
  if (same) draft.from = same;
  else if (!placeNameError(name, { places, destination }) && places.length < LIMITS.places) {
    draft.newPlaces = [{ ref: `${NEW_REF}1`, name }];
    draft.from = `${NEW_REF}1`;
  } else draft.legacyText = location;
  return draft;
}

/**
 * Trip_State with a Route Draft applied the way saveRoute() would store it, without any check, for the 要買的品項
 * preview only (requirement 6.6, D31): run shoppingPlan() on it. Stops without a place (place '') and other unfinished
 * values are kept; a time that is not valid is ''. The Draft's route keeps its saved id and position, or is added at
 * the end with an id no other route uses; its stops are the Draft's Stops in order (a saved Stop keeps its id, a new
 * one gets an id no other Stop uses). The chosen new Places are added at the end of Place_List with ids no other Place
 * uses. So for the Draft's car, shoppingPlan(preview).firstStop.get(vehicleId) gives { route, stop, n }; when that
 * route is the Draft's route (the car's only route on the Draft's date), route.stops.indexOf(stop) is the index of the
 * First_Shopping_Stop among the Draft's Stops, otherwise the car's items are listed on another day's Stop.
 * `state` itself is not modified and the result is not validated.
 */
export function previewState(state, draft) {
  const d = isRecord(draft) ? draft : {};
  const routes = list(state?.routes);
  const placeIds = new Set(list(state?.places).map(place => place?.id));
  const routeIds = new Set(routes.map(route => route?.id));
  const stopIds = new Set(routes.flatMap(route => list(route?.stops).map(stop => stop?.id)));
  return applyRouteDraft(state, d, {
    time: normalizeTimeInput(text(d.time)).value ?? '',
    ids: {
      place: entry => unusedId(entry.ref, placeIds),
      route: () => unusedId(`${NEW_REF}route`, routeIds),
      stop: index => unusedId(`${NEW_REF}stop:${index + 1}`, stopIds)
    }
  }).next;
}

// ---- Legacy departures ----

/**
 * 不使用舊資料 for a car (requirement 19.6): sets its `meeting` to ''; the car's other fields, other cars and activities
 * stay as they are. focus is the next row of the First_Day route list after that car's 舊的出發資料 row, else the
 * previous row, else 'route:new'. A car that does not exist fails with formError invalidState.
 */
export function clearLegacy(state, vehicleId) {
  const vehicles = list(state.vehicles);
  const index = typeof vehicleId === 'string' ? vehicles.findIndex(item => isRecord(item) && item.id === vehicleId) : -1;
  if (index < 0) return unknownTarget();
  const first = tripDays(state)[0];
  const focus = first ? neighborKey(routeRowKeys(state, first.date), `route:legacy:${vehicleId}`, 'route:new') : 'route:new';

  const next = structuredClone(state);
  next.vehicles[index].meeting = '';
  return success(next, `已不使用${cleanText(text(vehicles[index].name))}的舊出發資料`, focus);
}

// ---- Activities and Activity Drafts ----
//
// Activity Draft (design 「擴充點」, 「卡片的 Draft」): the unsaved values of one Activity card or 自訂活動 card, with the
// fields of requirement 7.6 in card order.
// {
//   activityId,     the saved Activity's id; null for a 自訂活動 (a new Activity)
//   title,          標題 as typed
//   date,           日期: the chosen Trip_Day, 'YYYY-MM-DD'; another day than the saved one moves the Activity there (D25)
//   time,           時間 as typed
//   type,           類別: an ACTIVITY_TYPES value (requirement 7.9)
//   participation,  參加方式: 'all' (全體旅伴), 'vehicles' (指定車輛) or 'legacy' (保留原旅伴名單, offered only for a
//                   saved Activity that lists people, requirement 7.7)
//   vehicleIds,     the cars checked under 指定車輛, in any order; used only when participation is 'vehicles'
//   location,       地點 as typed
//   note            備註 as typed
// }

/** Display name of an Activity in messages: its title, or its Activity_Category when the title is blank (14.13). */
const activityName = activity => cleanText(text(activity?.title)) || categoryLabel(activity?.type);

/** Focus keys of a day's 活動 list in screen order (requirements 7.1, 8.2, 14.13): 'activity:{id}' for an Activity
 * row and 'meal:{id}' for a Meal_Moment row, in the order of dayModel()'s moments. Empty for a date outside the trip. */
function momentRowKeys(state, date) {
  const model = dayModel(state, date);
  if (!model) return [];
  return model.blocks
    .flatMap(block => (block.type === 'moments' ? block.items : []))
    .map(item => (item.type === 'activity' ? `activity:${item.activity.id}` : `meal:${item.meal.id}`));
}

/** Draft of a saved Activity card (requirements 7.6, 7.7, 19.2(b)), or null when the Activity is not saved. The
 * participation is 'vehicles' when the Activity has vehicleIds, 'legacy' when it lists people, otherwise 'all'.
 * Task 9.6 builds the card's Draft with it; a later drag and drop (F2) changes date or time and calls saveActivity(). */
export function activityDraft(state, activityId) {
  const activity = list(state?.activities).find(item => isRecord(item) && item.id === activityId);
  if (!activity) return null;
  const vehicles = activity.vehicleIds !== undefined;
  return {
    activityId: activity.id, title: text(activity.title), date: text(activity.date), time: text(activity.time),
    type: text(activity.type),
    participation: vehicles ? 'vehicles' : list(activity.people).length ? 'legacy' : 'all',
    vehicleIds: vehicles ? list(activity.vehicleIds).filter(id => typeof id === 'string') : [],
    location: text(activity.location), note: text(activity.note)
  };
}

/** Draft of ＋自訂活動 on `date` (requirement 7.5): no title and no time, that date, 營地時光, 全體旅伴, no location and
 * no note. `state` is not read; it keeps the call shape of the other Draft helpers, such as newRouteDraft(). */
export function newActivityDraft(state, date) {
  return { activityId: null, title: '', date, time: '', type: 'camp', participation: 'all', vehicleIds: [], location: '', note: '' };
}

/**
 * Saves an Activity card or a 自訂活動 card (requirements 7.5–7.7, 7.10, 7.12, D25). Checks, as field errors in card
 * order:
 * - title: blank after trimming White_Space (activityTitle), or longer than 100 characters (activityTitleLong);
 * - date: not a Trip_Day (activityDate);
 * - time: not HH:MM after normalizeTimeInput() (activityTime), or blank (activityTimeRequired);
 * - type: not an ACTIVITY_TYPES value (activityType);
 * - participation: not 'all' or 'vehicles', and not 'legacy' for a saved Activity that lists people (participation);
 * - vehicles: 'vehicles' without a checked car that is in state.vehicles (activityVehicles);
 * - location, note: longer than 150 or 1,000 characters after trimming (activityLocation, activityNote);
 * and as formError: a 自訂活動 while the trip already has 1,000 Activities (activityLimit).
 * Writes every field: the trimmed title, date, time, type, trimmed location and note. 'all' writes people: [] and
 * removes vehicleIds; 'vehicles' writes people: [] and vehicleIds in state.vehicles order (checked ids of cars that
 * no longer exist are dropped); 'legacy' keeps people as they are. `done` does not change; a 自訂活動 is added at the
 * end of state.activities, not done, with the id ctx.uid(). A saved Activity keeps its id and position, also when its
 * date moves to another day. Saving an Activity that is not saved anymore fails with formError invalidState.
 * focus is 'activity:{id}' when the Activity is on ctx.day (see the header) after the save; when it left that day,
 * the row after it in that day's 活動 list before the save, else the row before it, else 'activity:new'; and
 * 'activity:new' for a 自訂活動 saved on another day (requirements 7.12, 16.14(b)). message names the title and the day.
 */
export function saveActivity(state, draft, ctx) {
  const d = isRecord(draft) ? draft : {};
  const activities = list(state.activities);
  const adding = isNewTarget(d.activityId);
  const index = adding ? -1 : activities.findIndex(item => isRecord(item) && item.id === d.activityId);
  if (!adding && index < 0) return unknownTarget();
  const stored = adding ? null : activities[index];

  const title = trimWhite(text(d.title));
  const date = text(d.date);
  const n = dayNumber(state, date);
  const time = normalizeTimeInput(text(d.time));
  const type = text(d.type);
  const participation = text(d.participation);
  // 保留原旅伴名單 exists only for a saved person list (requirement 7.7); a valid Activity with vehicleIds lists no one.
  const legacyOffered = Boolean(stored) && stored.vehicleIds === undefined && list(stored.people).length > 0;
  const checked = new Set(list(d.vehicleIds));
  const vehicleIds = [];
  for (const vehicle of list(state.vehicles)) {
    if (isRecord(vehicle) && checked.has(vehicle.id) && !vehicleIds.includes(vehicle.id)) vehicleIds.push(vehicle.id);
  }
  const location = trimWhite(text(d.location)), note = trimWhite(text(d.note));

  const { errors, add } = errorList();
  if (!title) add('title', EDIT_MESSAGES.activityTitle);
  else if (charCount(title) > LIMITS.activityTitle) add('title', EDIT_MESSAGES.activityTitleLong);
  if (!n) add('date', EDIT_MESSAGES.activityDate);
  if (time.error) add('time', EDIT_MESSAGES.activityTime);
  else if (!time.value) add('time', EDIT_MESSAGES.activityTimeRequired);
  if (!ACTIVITY_TYPES.includes(type)) add('type', EDIT_MESSAGES.activityType);
  if (participation !== 'all' && participation !== 'vehicles' && !(participation === 'legacy' && legacyOffered)) {
    add('participation', EDIT_MESSAGES.participation);
  } else if (participation === 'vehicles' && !vehicleIds.length) add('vehicles', EDIT_MESSAGES.activityVehicles);
  if (charCount(location) > LIMITS.activityLocation) add('location', EDIT_MESSAGES.activityLocation);
  if (charCount(note) > LIMITS.activityNote) add('note', EDIT_MESSAGES.activityNote);
  const formError = adding && activities.length >= LIMITS.activities ? EDIT_MESSAGES.activityLimit : '';
  if (errors.length || formError) return failure({ errors, formError });

  const next = structuredClone(state);
  let activity;
  if (adding) {
    activity = { id: idSource(ctx)(), date, time: time.value, title, type, location, note, people: [], done: false };
    next.activities = [...list(next.activities), activity];
  } else {
    activity = { ...next.activities[index], date, time: time.value, title, type, location, note };
    next.activities[index] = activity;
  }
  if (participation === 'all') {
    activity.people = [];
    delete activity.vehicleIds;
  } else if (participation === 'vehicles') {
    activity.people = [];
    activity.vehicleIds = vehicleIds;
  }

  const shown = typeof ctx?.day === 'string' && ctx.day ? ctx.day : stored ? stored.date : date;
  let focus = 'activity:new';
  if (date === shown) focus = `activity:${activity.id}`;
  else if (stored && stored.date === shown) focus = neighborKey(momentRowKeys(state, shown), `activity:${stored.id}`, 'activity:new');
  const name = cleanText(title);
  const message = adding ? `已新增第 ${n} 天的活動「${name}」`
    : stored.date !== date ? `已把活動「${name}」移到第 ${n} 天` : `已儲存第 ${n} 天的活動「${name}」`;
  return success(next, message, focus);
}

/**
 * 加入 N 個活動 on the Trip_Day `date` (requirements 7.2–7.4, 7.10). `types` (an array or a Set) holds the checked
 * Activity_Preset categories; only presetsFor() of that day counts, and a category that one of the day's Activities
 * already has is skipped (the editor shows it as 已加入, requirement 7.3). Adds one Activity per remaining preset, in
 * presetsFor() order at the end of state.activities: the preset's title, time and category, people: [] (全體旅伴),
 * no location and no note, not done, ids from ctx.uid(). Fails with formError presetNone when no preset is left to
 * add, and with activityLimit when the trip would have more than 1,000 Activities; a `date` outside the trip fails
 * with formError invalidState. No Draft is read or changed. focus is the new Activity that comes first in the day's
 * 活動 list (requirement 16.7).
 */
export function addPresets(state, date, types, ctx) {
  const day = tripDays(state).find(entry => entry.date === date);
  if (!day) return unknownTarget();
  const wanted = new Set(Array.isArray(types) || types instanceof Set ? types : []);
  const present = new Set(list(state.activities).filter(item => isRecord(item) && item.date === date).map(item => item.type));
  const rows = presetsFor(day.kind).filter(([type]) => wanted.has(type) && !present.has(type));
  if (!rows.length) return failure({ formError: EDIT_MESSAGES.presetNone });
  if (list(state.activities).length + rows.length > LIMITS.activities) return failure({ formError: EDIT_MESSAGES.activityLimit });

  const makeId = idSource(ctx);
  const added = rows.map(([type, time, title]) => ({ id: makeId(), date, time, title, type, location: '', note: '', people: [], done: false }));
  const next = structuredClone(state);
  next.activities = [...list(next.activities), ...added];
  const keys = new Set(added.map(activity => `activity:${activity.id}`));
  const focus = momentRowKeys(next, date).find(key => keys.has(key)) ?? `activity:${added[0].id}`;
  return success(next, `已在第 ${day.n} 天加入 ${added.length} 個活動`, focus);
}

/**
 * Deletes an Activity (requirements 7.11, 10.7). focus is the row after it in its day's 活動 list (Activities and
 * Meal_Moments, requirement 14.13), else the row before it, else 'activity:new' (requirement 16.14(b)). Deleting an
 * Activity that is not saved fails with formError invalidState.
 */
export function deleteActivity(state, activityId) {
  const activities = list(state.activities);
  const index = typeof activityId === 'string' ? activities.findIndex(item => isRecord(item) && item.id === activityId) : -1;
  if (index < 0) return unknownTarget();
  const activity = activities[index];
  const focus = neighborKey(momentRowKeys(state, activity.date), `activity:${activityId}`, 'activity:new');

  const next = structuredClone(state);
  next.activities.splice(index, 1);
  return success(next, `已刪除第 ${dayNumber(state, activity.date)} 天的活動「${activityName(activity)}」`, focus);
}

/**
 * The 完成 checkbox of an Activity row (requirement 7.8): sets `done` to true when `done` is true, otherwise to false;
 * nothing else changes and no Draft is read. focus stays on the checkbox, 'activity-done:{id}' (16.14(d)). An Activity
 * that is not saved fails with formError invalidState.
 */
export function setActivityDone(state, activityId, done) {
  const activities = list(state.activities);
  const index = typeof activityId === 'string' ? activities.findIndex(item => isRecord(item) && item.id === activityId) : -1;
  if (index < 0) return unknownTarget();

  const next = structuredClone(state);
  next.activities[index].done = done === true;
  const name = activityName(activities[index]);
  return success(next, done === true ? `「${name}」已完成` : `「${name}」改為未完成`, `activity-done:${activityId}`);
}

// ---- Meal_Moment times ----

/**
 * Saves the 時間 of a Meal_Moment card (requirements 8.3, 8.11). `time` is the field as typed: blank removes the
 * meal's `time`, so Meal_Time is the slot's default again; otherwise normalizeTimeInput() must give HH:MM (field
 * `time`, EDIT_MESSAGES.time). The meal's date, slot, title, ingredients and other fields, and the shopping list, do
 * not change. A meal that is not saved fails with formError invalidState. focus is 'meal:{id}'.
 */
export function saveMealTime(state, mealId, values) {
  const meals = list(state.meals);
  const index = typeof mealId === 'string' ? meals.findIndex(item => isRecord(item) && item.id === mealId) : -1;
  if (index < 0) return unknownTarget();
  const time = normalizeTimeInput(text(values?.time));
  if (time.error) return failure({ errors: [{ field: 'time', message: EDIT_MESSAGES.time }] });

  const next = structuredClone(state);
  if (time.value) next.meals[index].time = time.value;
  else delete next.meals[index].time;
  const name = mealTitle(meals[index]);
  return success(next, time.value ? `已儲存「${name}」的時間` : `已把「${name}」改回預設時間`, `meal:${mealId}`);
}

// ---- Vehicle_Dialog and the meal dialog ----
//
// The state changes the two dialogs' submit handler in src/app.js makes, with its checks and its texts. The dialogs
// keep showing the errors themselves (one message in .form-error), so these functions report formError only.

/** A dialog field's value trimmed with String.prototype.trim(), as the submit handler trims every FormData value;
 * a number (such as seats) becomes its text, anything else ''. */
const fieldText = value => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '');
const dialogFailure = formError => failure({ formError });
const DIALOG_LIMITS = Object.freeze({ vehicleName: 50, seats: 9, mealName: 100, servings: 100, ingredients: 500, mealNotes: 1000 });

/**
 * Saves the Vehicle_Dialog (requirements 3.6, 3.7). values: { id, name, driver, seats, passengers } — id of the car
 * being edited, or null, undefined or '' for 新增車輛; name, driver (a person id, '' for 待分配) and seats (text or a
 * number) as the form gives them; passengers, the checked person ids. Checks, in this order, with the first failure as
 * formError: name or seats blank (required); name longer than 50 characters (vehicleName); seats not an integer from
 * 1 to 9 (vehicleSeats); passengers plus the driver's seat more than seats (vehicleCapacity). The driver is dropped from
 * the passengers, as the dialog always did. An edited car keeps its id, position, `meeting` and other fields; a new
 * car goes at the end of state.vehicles with the id ctx.uid() and meeting ''. Unlike the old handler, which added
 * a car that is not saved anymore as a new one, editing such a car fails with formError invalidState.
 * message is the dialog's 「旅行手冊已更新」; focus is 'vehicle:{id}'.
 */
export function saveVehicle(state, values, ctx) {
  const id = values?.id;
  const vehicles = list(state.vehicles);
  const adding = isNewTarget(id);
  const index = adding ? -1 : vehicles.findIndex(item => isRecord(item) && item.id === id);
  if (!adding && index < 0) return unknownTarget();
  const name = fieldText(values?.name), driver = fieldText(values?.driver), seatsText = fieldText(values?.seats);
  if (!name || !seatsText) return dialogFailure(EDIT_MESSAGES.required);
  if (charCount(name) > DIALOG_LIMITS.vehicleName) return dialogFailure(EDIT_MESSAGES.vehicleName);
  const seats = Number(seatsText);
  if (!Number.isInteger(seats) || seats < 1 || seats > DIALOG_LIMITS.seats) return dialogFailure(EDIT_MESSAGES.vehicleSeats);
  const passengers = list(values?.passengers).filter(person => typeof person === 'string' && person !== driver);
  if (passengers.length + 1 > seats) return dialogFailure(EDIT_MESSAGES.vehicleCapacity);

  const next = structuredClone(state);
  let vehicle;
  if (adding) {
    vehicle = { id: idSource(ctx)(), name, driver, seats, passengers, meeting: '' };
    next.vehicles = [...list(next.vehicles), vehicle];
  } else {
    vehicle = { ...next.vehicles[index], name, driver, seats, passengers };
    next.vehicles[index] = vehicle;
  }
  return success(next, '旅行手冊已更新', `vehicle:${vehicle.id}`);
}

/**
 * Saves the meal dialog of 料理菜單 (requirements 6.12, 8.4, D18). values: { id, title, date, slot, cookId, servings,
 * ingredients, notes, imageKind } — id of the meal being edited, or null, undefined or '' for a new meal; the other
 * fields as the form gives them (servings may be a number); imageKind is 'auto' (the title and ingredients decide the
 * illustration), a DISH_TYPES key, or undefined to keep the stored one. Checks, in this order, with the first failure
 * as formError: title, slot or servings blank (required); title longer than 100 characters (mealName); slot not one
 * of mealSlotOptions() of the stored slot (mealSlot); servings not an integer from 1 to 100 (mealServings);
 * ingredients longer than 500 characters (mealIngredients); notes longer than 1,000 characters (mealNotes); imageKind
 * not 'auto' or a DISH_TYPES key (mealImage); then the error message of syncMealIngredients(), for example when the
 * shopping list would have more than 1,000 items. Writes the fields with ingredients as parseIngredients() joined with
 * 「、」; 'auto' removes imageKind. A changed slot (the trimmed stored slot differs from the trimmed new one) removes
 * the meal's custom `time`, so Meal_Time is the new slot's default; any other change, a recipe template included,
 * keeps it (requirement 8.4). As in the old handler, a stored slot with leading or trailing White_Space whose trimmed
 * text is not in MEAL_SLOTS, such as '\u3000早', fails mealSlot until another slot is chosen. An edited meal keeps its
 * id, position and other fields; a new meal goes at the end of state.meals with the id ctx.uid() and no time. Then
 * syncMealIngredients() adds and removes the meal-generated shopping items. Unlike the old handler, editing a meal
 * that is not saved anymore fails with formError invalidState. message is the dialog's
 * 「料理已儲存，食材已同步採買清單」; focus is 'meal-edit-{id}'.
 */
export function saveMeal(state, values, ctx) {
  const id = values?.id;
  const meals = list(state.meals);
  const adding = isNewTarget(id);
  const index = adding ? -1 : meals.findIndex(item => isRecord(item) && item.id === id);
  if (!adding && index < 0) return unknownTarget();
  const old = adding ? undefined : meals[index];
  const title = fieldText(values?.title), slot = fieldText(values?.slot), servingsText = fieldText(values?.servings);
  const ingredients = fieldText(values?.ingredients), notes = fieldText(values?.notes);
  if (!title || !slot || !servingsText) return dialogFailure(EDIT_MESSAGES.required);
  if (charCount(title) > DIALOG_LIMITS.mealName) return dialogFailure(EDIT_MESSAGES.mealName);
  if (!mealSlotOptions(old?.slot).includes(slot)) return dialogFailure(EDIT_MESSAGES.mealSlot);
  const servings = Number(servingsText);
  if (!Number.isInteger(servings) || servings < 1 || servings > DIALOG_LIMITS.servings) return dialogFailure(EDIT_MESSAGES.mealServings);
  if (charCount(ingredients) > DIALOG_LIMITS.ingredients) return dialogFailure(EDIT_MESSAGES.mealIngredients);
  if (charCount(notes) > DIALOG_LIMITS.mealNotes) return dialogFailure(EDIT_MESSAGES.mealNotes);
  const imageKind = values?.imageKind === undefined ? old?.imageKind : fieldText(values.imageKind);
  if (imageKind !== undefined && imageKind !== 'auto' && !DISH_TYPES.some(([key]) => key === imageKind)) {
    return dialogFailure(EDIT_MESSAGES.mealImage);
  }

  const next = structuredClone(state);
  const fields = {
    title, date: fieldText(values?.date), slot, cookId: fieldText(values?.cookId), servings,
    ingredients: parseIngredients(ingredients).join('、'), notes
  };
  const meal = adding ? { id: idSource(ctx)(), ...fields } : { ...next.meals[index], ...fields };
  if (imageKind === undefined || imageKind === 'auto') delete meal.imageKind;
  else meal.imageKind = imageKind;
  // A custom Meal_Time belongs to its slot (D18). The stored slot is compared as the dialog submits it (trimmed), so
  // a legacy slot such as ' 晚餐 ', which is saved back as '晚餐', counts as unchanged.
  if (old && fieldText(old.slot) !== slot) delete meal.time;
  if (adding) next.meals = [...list(next.meals), meal];
  else next.meals[index] = meal;
  try {
    syncMealIngredients(next);
  } catch (error) {
    return dialogFailure(error instanceof Error ? error.message : EDIT_MESSAGES.invalidState);
  }
  return success(next, '料理已儲存，食材已同步採買清單', `meal-edit-${meal.id}`);
}
