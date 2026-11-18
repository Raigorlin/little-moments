// Itinerary derivations shared by the poster, the editor, the text version, the shopping tab, the trip menu
// and the tests: trip days, place names, routes, legacy departures, the shopping plan, the day model
// (Day_Sequence, Day_Caption, route blocks and their end groups) and the Planning_Warnings.
// Pure functions only. They read the Trip_State and never modify it, and they never add, remove or change
// shopping items (requirement 6.12). A missing places, routes or daySettings field is an empty list (18.1).
// Place, vehicle and person names are returned as stored, except the display text that dayModel() and
// planningWarnings() build (names, titles, notes and composed lines already went through cleanText(), 14.16;
// see dayModel() and planningWarnings()).
import { dateRange } from './model.js';
import { parseVehicleMeeting } from './vehicle-departures.js';
import { parseIngredients } from './ingredients.js';
import { inferDishKind } from './recipes.js';
import { mealSlotRank } from './meal-order.js';
import {
  CAR_COLOR_COUNT, DESTINATION_REF, STOP_KINDS, categoryLabel, chineseNumeral, cleanText, mealLabel, mealTime,
  mealTitle, placeKey, trimWhite
} from './itinerary-model.js';

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => (Array.isArray(value) ? value : []);
const text = value => (typeof value === 'string' ? value : '');
const tripOf = state => (isRecord(state?.trip) ? state.trip : {});
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** Departure time of a route: its HH:MM, or '' when the time is left blank (omitted or ''). */
const routeTime = route => (TIME.test(text(route?.time)) ? route.time : '');
/** Order of requirements 5.2 and 19.4: earlier time first, then car order; entries without a time come last. */
const byDeparture = (a, b) => (!a.time - !b.time) || compareText(a.time, b.time) || a.order - b.order;
/** Every reference a route uses: from, each Stop's place, to. */
const routeRefs = route => [route.from, ...list(route.stops).map(stop => stop?.place), route.to];
/** Car_Members: the driver (unless 待分配) and every passenger. */
const carMembers = vehicle => [...(text(vehicle.driver) ? [vehicle.driver] : []), ...list(vehicle.passengers)];

/** Map of Trip_Day date → day number (First_Day is 1). */
function dayNumbers(state) {
  return new Map(tripDays(state).map(day => [day.date, day.n]));
}
/** Map of vehicle id → position in state.vehicles; for a repeated id (invalid state) the first one wins. */
function vehicleOrder(state) {
  const order = new Map();
  list(state?.vehicles).forEach((vehicle, index) => {
    if (isRecord(vehicle) && !order.has(vehicle.id)) order.set(vehicle.id, index);
  });
  return order;
}
/** Reference → name lookup with the rules of placeLabel(), built once for repeated use. */
function placeNamer(state) {
  const names = new Map();
  for (const place of list(state?.places)) if (isRecord(place) && !names.has(place.id)) names.set(place.id, text(place.name));
  const destination = text(tripOf(state).destination);
  return ref => (ref === DESTINATION_REF ? destination : names.get(ref) ?? '');
}
/** Legacy_Departure of a vehicle with the rules of parseVehicleMeeting() (requirement 19.7):
 * { time, location } with '' for a missing part, or null when the trimmed `meeting` is empty (19.7(c)). */
function legacyOf(vehicle) {
  const { time, location } = parseVehicleMeeting(text(vehicle?.meeting));
  return time || location ? { time, location } : null;
}

/** Trip_Days in date order: [{ date, n, kind }]; n starts at 1 and kind is 'first', 'middle', 'last',
 * or 'single' for a one-day trip. Empty when the trip dates are not a valid range. */
export function tripDays(state) {
  const trip = tripOf(state);
  const dates = dateRange(trip.startDate, trip.endDate);
  const last = dates.length - 1;
  return dates.map((date, index) => ({
    date, n: index + 1,
    kind: last === 0 ? 'single' : index === 0 ? 'first' : index === last ? 'last' : 'middle'
  }));
}

/** Name of a place reference: the trip destination for '@destination', otherwise the Place's name
 * ('' for an unknown reference, such as a Stop whose place is not chosen yet in a Draft preview).
 * Names are looked up at every call, so renaming a Place or the destination needs no other change (2.4, 2.6). */
export function placeLabel(state, ref) {
  return placeNamer(state)(ref);
}

/** Day_Location of a Trip_Day (glossary, D17): { ref, name } of the Place stored in its Day_Settings;
 * otherwise Destination_Place ({ ref: '@destination', name: trip destination }); null when the
 * Day_Location is unset and the trip destination is blank. */
export function dayLocation(state, date) {
  const setting = list(state?.daySettings).find(item => isRecord(item) && item.date === date);
  const ref = setting?.place;
  if (typeof ref === 'string' && ref !== '' && ref !== DESTINATION_REF) {
    const place = list(state?.places).find(item => isRecord(item) && item.id === ref);
    // Only invalid states refer to a missing Place; they fall back to the destination below.
    if (place) return { ref, name: text(place.name) };
  }
  const destination = text(tripOf(state).destination);
  return trimWhite(destination) ? { ref: DESTINATION_REF, name: destination } : null;
}

/** Saved routes of a date (the Route objects) in the order of requirement 5.2: by departure time, then by
 * the car's position in state.vehicles; routes without a departure time come last, also by car order. */
export function sortedRoutes(state, date) {
  const order = vehicleOrder(state);
  return list(state?.routes)
    .filter(route => isRecord(route) && route.date === date)
    .map(route => ({ route, time: routeTime(route), order: order.get(route.vehicleId) ?? order.size }))
    .sort(byDeparture)
    .map(entry => entry.route);
}

/** Legacy_Departures shown on the First_Day (requirements 19.3, 19.4, 19.7):
 * [{ vehicle, vehicleIndex, time, location }] for every vehicle whose `meeting` is not empty after trimming
 * and that has no route on the First_Day. time and location come from parseVehicleMeeting(), '' when
 * missing. Sorted by time, then car order; entries without a time come last, by car order. */
export function legacyDepartures(state) {
  const first = tripDays(state)[0];
  if (!first) return [];
  const routed = new Set(list(state?.routes).filter(route => isRecord(route) && route.date === first.date).map(route => route.vehicleId));
  return list(state?.vehicles)
    .flatMap((vehicle, vehicleIndex) => {
      if (!isRecord(vehicle) || routed.has(vehicle.id)) return [];
      const departure = legacyOf(vehicle);
      return departure ? [{ vehicle, vehicleIndex, time: departure.time, location: departure.location }] : [];
    })
    .sort((a, b) => byDeparture({ time: a.time, order: a.vehicleIndex }, { time: b.time, order: b.vehicleIndex }));
}

/** Shopping derivation of requirement 6.11 (D28, D29, D30); nothing of it is stored in the Trip_State.
 * - buyerCar: Map<personId, vehicleId>, the first vehicle in state.vehicles whose Car_Members include the
 *   person (Buyer_Car, D29).
 * - firstStop: Map<vehicleId, { route, stop, n }>, the vehicle's First_Shopping_Stop: in its route on the
 *   earliest Trip_Day that has a Shopping_Stop, the first Shopping_Stop in Stop order; n is that day's number (D28).
 * - stopItems: Map<stopId, item[]> with an entry for every First_Shopping_Stop (possibly empty) and for no other
 *   Stop: the Stop_Items in shopping list order, bought items included.
 * - unassigned: [{ item, code, reason }] in shopping list order (Unassigned_Shopping): code 'unassigned'
 *   「待分配」, 'no-car'「{旅伴}不在任何車上」 or 'no-stop'「{車名}還沒有採買停靠點」.
 * - locationOf: Map<itemId, { n, placeName, vehicleName }> for every item in a stopItems list, the shopping
 *   tab's 「第 {N} 天在{地點}（{車名}）」 (6.10).
 * Every item is in exactly one stopItems list or in unassigned. A Shopping_Stop counts even when its place is
 * not chosen (a Draft preview); its placeName is then ''. */
export function shoppingPlan(state) {
  const vehicles = new Map();
  for (const vehicle of list(state?.vehicles)) if (isRecord(vehicle) && !vehicles.has(vehicle.id)) vehicles.set(vehicle.id, vehicle);
  const buyerCar = new Map();
  for (const vehicle of vehicles.values()) {
    for (const person of carMembers(vehicle)) if (!buyerCar.has(person)) buyerCar.set(person, vehicle.id);
  }
  // Earliest Trip_Day wins; an equal day (two routes of one car on one day, only in invalid states) keeps
  // the first route. Routes on dates outside the trip have no day number and are ignored.
  const days = dayNumbers(state), earliest = new Map();
  for (const route of list(state?.routes)) {
    if (!isRecord(route) || !vehicles.has(route.vehicleId) || !days.has(route.date)) continue;
    const stop = list(route.stops).find(item => isRecord(item) && item.kind === 'shop');
    const n = days.get(route.date), current = earliest.get(route.vehicleId);
    if (stop && (!current || n < current.n)) earliest.set(route.vehicleId, { route, stop, n });
  }
  const firstStop = new Map(), stopItems = new Map();
  for (const id of vehicles.keys()) {
    if (!earliest.has(id)) continue;
    firstStop.set(id, earliest.get(id));
    stopItems.set(earliest.get(id).stop.id, []);
  }
  const placeName = placeNamer(state);
  const people = new Map();
  for (const person of list(state?.people)) if (isRecord(person) && !people.has(person.id)) people.set(person.id, text(person.name));
  const unassigned = [], locationOf = new Map();
  for (const item of list(state?.shopping)) {
    if (!isRecord(item)) continue;
    if (!item.assignee) {
      unassigned.push({ item, code: 'unassigned', reason: '待分配' });
      continue;
    }
    const vehicleId = buyerCar.get(item.assignee);
    if (vehicleId === undefined) {
      unassigned.push({ item, code: 'no-car', reason: `${people.get(item.assignee) ?? ''}不在任何車上` });
      continue;
    }
    const vehicle = vehicles.get(vehicleId), first = firstStop.get(vehicleId);
    if (!first) {
      unassigned.push({ item, code: 'no-stop', reason: `${text(vehicle.name)}還沒有採買停靠點` });
      continue;
    }
    stopItems.get(first.stop.id).push(item);
    locationOf.set(item.id, { n: first.n, placeName: placeName(first.stop.place), vehicleName: text(vehicle.name) });
  }
  return { buyerCar, firstStop, stopItems, unassigned, locationOf };
}

/** Shopping_Summary (requirement 6.9): the item names in the given order after cleanText(), without empty
 * names and without repeating an identical name, joined with 「、」; '' when there are no items. */
export function shoppingSummary(items) {
  const names = new Set();
  for (const item of list(items)) {
    const name = cleanText(item?.name);
    if (name) names.add(name);
  }
  return [...names].join('、');
}

// ---- Day model ----
const STOP_LABELS = new Map(STOP_KINDS.map(entry => [entry.kind, entry.label]));
const ARRIVAL_FIRST = { arrival: 0, other: 1 };

/** End groups of a route block (design 「endGroups(lines)」; requirements 11.5(c), 11.6, 12.10):
 * [{ ref, lines }] where ref is a Route's `to` and lines are the indices in `lines` of the routes ending there,
 * ascending. One pass from the front: a `to` without a group yet opens a new group at the end, then the index
 * joins its group. So every route line is in exactly one group, groups are in the order their end first appears,
 * and legacy lines (no end) are in none. Reads nothing but `lines` and does not modify them. */
export function endGroups(lines) {
  const groups = [], byRef = new Map();
  list(lines).forEach((line, index) => {
    if (line?.type !== 'route') return;
    const ref = line.route?.to;
    let group = byRef.get(ref);
    if (!group) {
      group = { ref, lines: [] };
      byRef.set(ref, group);
      groups.push(group);
    }
    group.lines.push(index);
  });
  return groups;
}

/** Lookups shared by the lines and items of one day model. */
function dayContext(state, plan, location, lastDay) {
  const names = placeNamer(state), vehicleNames = new Map(), personNames = new Map();
  for (const vehicle of list(state?.vehicles)) if (isRecord(vehicle) && !vehicleNames.has(vehicle.id)) vehicleNames.set(vehicle.id, text(vehicle.name));
  const people = list(state?.people).filter(isRecord);
  for (const person of people) if (!personNames.has(person.id)) personNames.set(person.id, text(person.name));
  return {
    plan, location, lastDay, vehicleNames, personNames,
    vehicles: list(state?.vehicles), order: vehicleOrder(state), personIds: people.map(person => person.id),
    name: ref => cleanText(names(ref)),
    // Activity locations are compared with the Day_Location by placeKey() (requirements 2.1(d), 14.14).
    dayKey: location ? placeKey(cleanText(location.name)) : null
  };
}

/** Route line (requirements 14.9, 11.5, 11.7): the stored Route, its vehicle and position in state.vehicles
 * (vehicle null and vehicleIndex −1 only for an unknown vehicle), the departure time ('' when blank) and the
 * display names of the start and the end. Each Stop view has the place name, the task label and the note
 * ('' for a Shopping_Stop, whose note is never shown, 6.4, 14.10); a First_Shopping_Stop also has its
 * Stop_Items from the shopping plan (6.11) and their Shopping_Summary (6.9), other Stops have [] and ''. */
function routeLine(route, ctx) {
  const vehicleIndex = ctx.order.get(route.vehicleId) ?? -1;
  return {
    type: 'route', route,
    vehicle: vehicleIndex < 0 ? null : ctx.vehicles[vehicleIndex], vehicleIndex,
    time: routeTime(route), from: ctx.name(route.from), to: ctx.name(route.to),
    stops: list(route.stops).filter(isRecord).map(stop => {
      const shop = stop.kind === 'shop';
      const items = shop ? [...(ctx.plan.stopItems.get(stop.id) ?? [])] : [];
      return {
        stop, place: ctx.name(stop.place), kind: stop.kind, label: STOP_LABELS.get(stop.kind) ?? '',
        note: shop ? '' : cleanText(text(stop.note)), items, summary: shoppingSummary(items)
      };
    })
  };
}

/** Legacy departure line (requirements 14.15, 19.3, 19.10): a legacyDepartures() entry with its location as
 * display text ('' for a missing part; the views write 出發時間待定 and 出發地點待定). */
function legacyLine(entry) {
  return { type: 'legacy', vehicle: entry.vehicle, vehicleIndex: entry.vehicleIndex, time: entry.time, location: cleanText(entry.location) };
}

/** Participants for the 「參加：」 extra (requirements 14.14, 19.2(b)): '' for 全體旅伴 (no vehicles chosen,
 * and the person list is empty or has every person); otherwise the chosen car names in their order, or the
 * listed person names in list order, joined with 「、」. Same names, order and fallbacks as
 * activityParticipantLabel(), with every name passed through cleanText() on its own (14.16). */
function participants(activity, ctx) {
  if (activity.vehicleIds !== undefined) {
    return list(activity.vehicleIds).map(id => cleanText(ctx.vehicleNames.get(id) || '車輛待確認')).join('、');
  }
  const people = list(activity.people);
  if (!people.length || ctx.personIds.every(id => people.includes(id))) return '';
  return people.map(id => cleanText(ctx.personNames.get(id) || '旅伴待確認')).join('、');
}

/** Activity item (requirements 7.9, 11.9 to 11.11, 14.13, 14.14, 19.2): title is the cleaned title, or the
 * Activity_Category when that is empty (14.13); extras hold the 「地點：」 location (not empty and not the
 * Day_Location by placeKey()), the participants and the note, each '' when it does not apply. */
function activityItem(activity, ctx) {
  const category = categoryLabel(activity.type);
  const location = cleanText(text(activity.location));
  return {
    type: 'activity', activity, time: text(activity.time), title: cleanText(text(activity.title)) || category, category,
    extras: {
      location: location && placeKey(location) !== ctx.dayKey ? location : '',
      participants: participants(activity, ctx),
      note: cleanText(text(activity.note))
    },
    done: activity.done === true
  };
}

/** Meal_Moment item (requirements 8.1, 8.2, 8.5 to 8.7, 8.13): Meal_Time, the 「{餐次}：{料理名稱}」 title,
 * Meal_Label, the ingredient names of the meal card (parseIngredients(), [] when there are none) and the
 * dish illustration kind (inferDishKind()). */
function mealItem(meal) {
  return {
    type: 'meal', meal, time: mealTime(meal), title: mealTitle(meal), label: mealLabel(meal),
    ingredients: typeof meal.ingredients === 'string' ? parseIngredients(meal.ingredients) : [],
    dishKind: inferDishKind(meal)
  };
}

/** The day's Activities and Meal_Moments in the order of requirements 8.2 and 14.13: by time; at the same time
 * Activities first, Activities in state.activities order, Meal_Moments by mealSlotRank() then state.meals order. */
function dayItems(state, date, ctx) {
  const entries = [];
  list(state?.activities).forEach((activity, index) => {
    if (isRecord(activity) && activity.date === date) entries.push({ item: activityItem(activity, ctx), group: 0, rank: 0, index });
  });
  list(state?.meals).forEach((meal, index) => {
    if (isRecord(meal) && meal.date === date) entries.push({ item: mealItem(meal), group: 1, rank: mealSlotRank(meal.slot), index });
  });
  return entries
    .sort((a, b) => compareText(a.item.time, b.item.time) || a.group - b.group || a.rank - b.rank || a.index - b.index)
    .map(entry => entry.item);
}

/** A route block (requirement 14.8(a), (b)) with its end groups (11.5(c), 11.6, 12.10): endKind is 'camp' for
 * the Day_Location, 'house' for any other end on the Last_Day and 'landmark' otherwise; count is the number
 * of routes in the group and lines their indices. The return line (14.12) lists the 'house' names in order. */
function routeBlock(kind, lines, ctx, arrivalLine) {
  const ends = endGroups(lines).map(({ ref, lines: indices }) => ({
    ref, name: ctx.name(ref),
    endKind: ctx.location && ref === ctx.location.ref ? 'camp' : ctx.lastDay ? 'house' : 'landmark',
    count: indices.length, lines: indices
  }));
  const houses = kind === 'other' ? ends.filter(end => end.endKind === 'house').map(end => end.name) : [];
  return {
    type: 'routes', kind,
    // Lines are in departure order with timed lines first, so the first time is the earliest.
    sortTime: lines.find(line => line.time)?.time ?? null,
    lines, arrivalLine,
    returnLine: houses.length ? `平安返回${houses.join('、')}・不預估返抵時間` : null,
    ends
  };
}

/** Day_Sequence (requirement 14.8(c) to (e)): a block with a sort time T goes after the last item whose time
 * is at most T; without a sort time the Arrival block goes first and the Other block last. Two blocks at the
 * same place are ordered by sort time, the Arrival block first when the times are equal or one is missing.
 * The items before, between and after the blocks form moments blocks; empty blocks are left out. */
function daySequence(items, routeBlocks) {
  const placed = routeBlocks
    .map(block => ({
      block,
      at: block.sortTime === null ? (block.kind === 'arrival' ? 0 : items.length)
        : items.filter(item => item.time <= block.sortTime).length
    }))
    .sort((a, b) => a.at - b.at
      || (a.block.sortTime !== null && b.block.sortTime !== null ? compareText(a.block.sortTime, b.block.sortTime) : 0)
      || ARRIVAL_FIRST[a.block.kind] - ARRIVAL_FIRST[b.block.kind]);
  const blocks = [];
  let next = 0;
  for (const { block, at } of placed) {
    if (at > next) blocks.push({ type: 'moments', items: items.slice(next, at) });
    blocks.push(block);
    next = at;
  }
  if (next < items.length) blocks.push({ type: 'moments', items: items.slice(next) });
  return blocks;
}

/**
 * Day model of one Trip_Day for the poster, the editor and the text version (design 「dayModel() 的回傳值」);
 * null when `date` is not a Trip_Day. Pass the same `plan` for every day of one render so the shopping plan
 * is derived once.
 *
 * { date, n, kind, title, heading, location, arrival, arrivalRoutes, otherRoutes, legacy, meetingCount,
 *   blocks, caption, showLocationLine }
 * - title: cleanText(Day_Title) or ''; heading: title, or 「第 {n} 天」; location: dayLocation() as is;
 *   arrival: Arrival_Time or ''.
 * - arrivalRoutes, otherRoutes: the day's stored Routes in requirement 5.2 order (Arrival_Routes end at the
 *   Day_Location and do not start there; without a Day_Location every route is an Other route);
 *   legacy: legacyDepartures() on the First_Day, otherwise []; meetingCount: Meeting_Count (Arrival_Routes).
 * - blocks (Day_Sequence): { type: 'routes', kind: 'arrival' | 'other', sortTime, lines, arrivalLine,
 *   returnLine, ends } and { type: 'moments', items }. The Arrival block holds the Arrival_Routes and, on the
 *   First_Day, the legacy departures, merged in 5.2 order; the Other block holds the Other_Routes.
 *   sortTime: the earliest departure time in the block, or null. arrivalLine (14.11): 「預計 {HH:MM} 抵達」 or
 *   「預計抵達時間待定」, plus 「・{N}車會合」 for N ≥ 2, when the Arrival block has a route, otherwise null.
 *   returnLine (14.12): 「平安返回{終點}・不預估返抵時間」 in the Last_Day's Other block, otherwise null.
 *   lines: { type: 'route', route, vehicle, vehicleIndex, time, from, to, stops },
 *          stops: { stop, place, kind, label, note, items, summary } (see routeLine()), and
 *          { type: 'legacy', vehicle, vehicleIndex, time, location }.
 *   ends: { ref, name, endKind, count, lines }, one per endGroups(lines) group in the same order.
 *   items: { type: 'activity', activity, time, title, category, extras: { location, participants, note }, done }
 *          and { type: 'meal', meal, time, title, label, ingredients, dishKind }.
 * - caption: Day_Caption (11.3); showLocationLine: whether the 「地點：」 line shows (11.2).
 * title, heading, caption and every name, title, note and line in `blocks` are display text (cleanText(),
 * 14.16), so a line's `to` equals its end group's `name`; location, arrivalRoutes, otherRoutes and legacy are
 * the derived data as stored. Times are HH:MM or ''. route, stop, vehicle, activity, meal and the Stop items are
 * the stored objects themselves (not copies); the model's own arrays are new.
 */
export function dayModel(state, date, plan = shoppingPlan(state)) {
  const day = tripDays(state).find(entry => entry.date === date);
  if (!day) return null;
  const firstDay = day.kind === 'first' || day.kind === 'single';
  const lastDay = day.kind === 'last' || day.kind === 'single';
  const setting = list(state?.daySettings).find(item => isRecord(item) && item.date === date);
  const title = cleanText(text(setting?.title));
  const location = dayLocation(state, date);
  const arrival = TIME.test(text(setting?.arrival)) ? setting.arrival : '';
  const routes = sortedRoutes(state, date);
  const arrivalRoutes = location ? routes.filter(route => route.to === location.ref && route.from !== location.ref) : [];
  const arriving = new Set(arrivalRoutes);
  const otherRoutes = routes.filter(route => !arriving.has(route));
  const legacy = firstDay ? legacyDepartures(state) : [];
  const meetingCount = arrivalRoutes.length;
  const ctx = dayContext(state, plan, location, lastDay);

  const routeBlocks = [];
  // Requirements 14.15 and 19.4: legacy lines are sorted with the route lines; a car has one or the other.
  const arrivalLines = [...arrivalRoutes.map(route => routeLine(route, ctx)), ...legacy.map(legacyLine)]
    .map(line => ({ line, time: line.time, order: line.vehicleIndex < 0 ? ctx.vehicles.length : line.vehicleIndex }))
    .sort(byDeparture)
    .map(entry => entry.line);
  if (arrivalLines.length) {
    const arrivalLine = meetingCount
      ? `${arrival ? `預計 ${arrival} 抵達` : '預計抵達時間待定'}${meetingCount >= 2 ? `・${chineseNumeral(meetingCount)}車會合` : ''}`
      : null;
    routeBlocks.push(routeBlock('arrival', arrivalLines, ctx, arrivalLine));
  }
  if (otherRoutes.length) routeBlocks.push(routeBlock('other', otherRoutes.map(route => routeLine(route, ctx)), ctx, null));
  const blocks = daySequence(dayItems(state, date, ctx), routeBlocks);

  // Day_Caption (11.3) and the 「地點：」 line (11.2).
  const departures = routes.length + legacy.length;
  let caption;
  if (departures) {
    const parts = [`${chineseNumeral(departures)}車出發`];
    if (routes.some(route => list(route.stops).some(stop => isRecord(stop) && stop.kind === 'shop'))) parts.push('採買');
    if (meetingCount >= 2) parts.push('會合');
    if (routeBlocks.some(block => block.returnLine)) parts.push('返程');
    caption = parts.join('・');
  } else caption = location ? `今天，留在${cleanText(location.name)}` : '今天，自由安排';
  const showLocationLine = Boolean(location) && departures > 0 && !routes.some(route => route.to === location.ref);

  return {
    date, n: day.n, kind: day.kind, title, heading: title || `第 ${day.n} 天`, location, arrival,
    arrivalRoutes, otherRoutes, legacy, meetingCount, blocks, caption, showLocationLine
  };
}

// ---- Planning_Warning ----

/**
 * Planning_Warnings of every Trip_Day (requirement 9; design 「planningWarnings(state, plan)」), derived from the
 * saved Trip_State only: it reads `state` and `plan` and writes nothing, so a warning never blocks or triggers a
 * save (9.7) and a Draft does not change it (9.9). `plan` is shoppingPlan(state) of the same state; pass the
 * plan of the current render so it is derived once.
 *
 * Returns Map<date, string[]> with an entry for every Trip_Day, in date order, and for no other date. A day
 * without warnings has [], so `get(date).length` is the count on its day button (9.8) and an empty list means
 * no warning list (9.6). A day's list follows the clause order 9.1 to 9.5; warnings of one clause are in the
 * order of their cars in state.vehicles, and those of one route's Shopping_Stops in Stop order, with both kinds
 * of 9.5 in that one order (9.6):
 * 1. 「{車名}這一天還沒有路線」 for every car without a route, on a day that has at least one route; a car with
 *    only a Legacy_Departure has no route (9.1).
 * 2. 「{車名} {HH:MM} 出發，晚於預計抵達 {HH:MM}」 for every Arrival_Route that departs after the day's
 *    Arrival_Time; an equal time, a route without a time and the Other_Routes give none (9.2).
 * 3. 「還沒填預計抵達時間」 once, when the day has Arrival_Routes but no Arrival_Time (9.3).
 * 4. 「{車名}的出發時間待定」 for every route without a departure time, Arrival_Route or not; Legacy_Departures
 *    give none (9.4).
 * 5. For every Shopping_Stop: 「{車名}在{地點}的採買沒有品項」 when it is its car's First_Shopping_Stop and has no
 *    Stop_Items; 「{車名}在{地點}只標示採買，品項列在第 {N} 天的{第一個地點}」 when it is not, with the day number
 *    and the place of the car's First_Shopping_Stop (9.5, D28). Unassigned_Shopping, including the items of a
 *    car without any Shopping_Stop, gives no warning (D30).
 * Arrival_Routes and Arrival_Time follow the rules of dayModel(). Car and place names are display text
 * (cleanText(), 14.16), like the names in dayModel(); times are HH:MM. A route of an unknown car (only in
 * invalid states) gives no warning and does not count as a route of its day.
 */
export function planningWarnings(state, plan = shoppingPlan(state)) {
  const order = vehicleOrder(state), cars = [];
  // One car per id, in state.vehicles order; a repeated id (invalid states only) keeps its first vehicle.
  list(state?.vehicles).forEach((vehicle, index) => {
    if (isRecord(vehicle) && order.get(vehicle.id) === index) cars.push(vehicle);
  });
  const carName = new Map(cars.map(vehicle => [vehicle.id, cleanText(text(vehicle.name))]));
  const names = placeNamer(state);
  const placeName = ref => cleanText(names(ref));
  const routesOn = new Map();
  for (const route of list(state?.routes)) {
    if (!isRecord(route) || !carName.has(route.vehicleId)) continue;
    if (!routesOn.has(route.date)) routesOn.set(route.date, []);
    routesOn.get(route.date).push(route);
  }

  const warnings = new Map();
  for (const { date } of tripDays(state)) {
    // Car order (9.6); the stable sort keeps two routes of one car (invalid states only) in state.routes order.
    const routes = (routesOn.get(date) ?? []).sort((a, b) => order.get(a.vehicleId) - order.get(b.vehicleId));
    const day = [];
    if (routes.length) {
      const routed = new Set(routes.map(route => route.vehicleId));
      for (const car of cars) if (!routed.has(car.id)) day.push(`${carName.get(car.id)}這一天還沒有路線`);
    }
    const location = dayLocation(state, date);
    const setting = list(state?.daySettings).find(item => isRecord(item) && item.date === date);
    const arrival = TIME.test(text(setting?.arrival)) ? setting.arrival : '';
    const arrivalRoutes = location ? routes.filter(route => route.to === location.ref && route.from !== location.ref) : [];
    if (arrival) {
      for (const route of arrivalRoutes) {
        const time = routeTime(route);
        // HH:MM strings compare in time order.
        if (time && time > arrival) day.push(`${carName.get(route.vehicleId)} ${time} 出發，晚於預計抵達 ${arrival}`);
      }
    } else if (arrivalRoutes.length) day.push('還沒填預計抵達時間');
    for (const route of routes) if (!routeTime(route)) day.push(`${carName.get(route.vehicleId)}的出發時間待定`);
    for (const route of routes) {
      // A car with a Shopping_Stop on a Trip_Day always has a First_Shopping_Stop.
      const first = plan.firstStop.get(route.vehicleId);
      if (!first) continue;
      for (const stop of list(route.stops)) {
        if (!isRecord(stop) || stop.kind !== 'shop') continue;
        const at = `${carName.get(route.vehicleId)}在${placeName(stop.place)}`;
        if (stop.id !== first.stop.id) day.push(`${at}只標示採買，品項列在第 ${first.n} 天的${placeName(first.stop.place)}`);
        else if (!plan.stopItems.get(stop.id)?.length) day.push(`${at}的採買沒有品項`);
      }
    }
    warnings.set(date, day);
  }
  return warnings;
}

/** First_Day departure of a vehicle for the Trip_Menu vehicle card (requirement 3.8):
 * { kind: 'route', time, place } from its First_Day route (time '' when blank, place = start name),
 * { kind: 'legacy', time, place } from its Legacy_Departure ('' for a missing part), or { kind: 'none' }. */
export function firstDayDeparture(state, vehicleId) {
  const first = tripDays(state)[0];
  const vehicle = list(state?.vehicles).find(item => isRecord(item) && item.id === vehicleId);
  if (!first || !vehicle) return { kind: 'none' };
  const route = list(state?.routes).find(item => isRecord(item) && item.date === first.date && item.vehicleId === vehicleId);
  if (route) return { kind: 'route', time: routeTime(route), place: placeLabel(state, route.from) };
  const legacy = legacyOf(vehicle);
  return legacy ? { kind: 'legacy', time: legacy.time, place: legacy.location } : { kind: 'none' };
}

/** Where a Place is used (requirement 2.7), in Trip_Day order: [{ n, label }]. On each day 「這一天的地點」
 * comes first (its Day_Location), then, in car order, the name of each car whose route on that day starts,
 * stops or ends there; a car is listed once per day. Empty when the place is not used. */
export function placeUsages(state, placeId) {
  if (typeof placeId !== 'string' || !placeId) return [];
  const dayPlaces = new Map(), users = new Map();
  for (const setting of list(state?.daySettings)) {
    if (isRecord(setting) && !dayPlaces.has(setting.date)) dayPlaces.set(setting.date, setting.place);
  }
  for (const route of list(state?.routes)) {
    if (!isRecord(route) || !routeRefs(route).includes(placeId)) continue;
    if (!users.has(route.date)) users.set(route.date, new Set());
    users.get(route.date).add(route.vehicleId);
  }
  const usages = [];
  for (const { date, n } of tripDays(state)) {
    if (dayPlaces.get(date) === placeId) usages.push({ n, label: '這一天的地點' });
    const ids = users.get(date);
    if (!ids) continue;
    for (const vehicle of list(state?.vehicles)) {
      // Deleting the id lists a repeated vehicle id (invalid state) only once.
      if (isRecord(vehicle) && ids.delete(vehicle.id)) usages.push({ n, label: text(vehicle.name) });
    }
  }
  return usages;
}

/** Map<ref, count>: how many saved routes use each place as start, end or a Stop, counting a route once
 * (requirement 3.2). Has an entry, possibly 0, for '@destination' (when the trip destination is not blank)
 * and for every Place, in the order the Places_And_Cars list shows them; Day_Settings do not count. */
export function placeRouteCounts(state) {
  const counts = new Map();
  if (trimWhite(text(tripOf(state).destination))) counts.set(DESTINATION_REF, 0);
  for (const place of list(state?.places)) if (isRecord(place) && !counts.has(place.id)) counts.set(place.id, 0);
  for (const route of list(state?.routes)) {
    if (!isRecord(route)) continue;
    for (const ref of new Set(routeRefs(route))) {
      if (typeof ref === 'string' && ref) counts.set(ref, (counts.get(ref) ?? 0) + 1);
    }
  }
  return counts;
}

/** Day numbers N, ascending and without repeats, of the Trip_Days on which the vehicle has a saved route
 * (requirements 3.5, 3.9). */
export function vehicleRouteDays(state, vehicleId) {
  const days = dayNumbers(state), result = new Set();
  for (const route of list(state?.routes)) {
    if (isRecord(route) && route.vehicleId === vehicleId && days.has(route.date)) result.add(days.get(route.date));
  }
  return [...result].sort((a, b) => a - b);
}

/** Car_Color index (requirements 11.12, 22.6): the vehicle's position in state.vehicles modulo 8, so only
 * the position decides the color, never a name or an id. An unknown vehicle gets 0, a palette color. */
export function carColorIndex(state, vehicleId) {
  const index = list(state?.vehicles).findIndex(vehicle => isRecord(vehicle) && vehicle.id === vehicleId);
  return index < 0 ? 0 : index % CAR_COLOR_COUNT;
}
