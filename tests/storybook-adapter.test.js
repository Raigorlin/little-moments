import { describe, test, expect } from 'bun:test';
// Shopping stop items are derived from the shopping list (items whose assignee rides in that car) and are never
// written back from the studio; the shopping-stop assertions below follow that rule.
import fc from 'fast-check';
import { toStudio, fromStudio, isMealEvent, studioId, StudioConflictError, StudioValidationError, STUDIO_DEST_ID } from '../src/storybook-adapter.js';
import { shiftDates, nextId } from '../src/storybook/model.js';
import { emptyState, seed, isValidState } from '../src/model.js';
import { DESTINATION_REF } from '../src/itinerary-model.js';
import { exampleTrip } from './fixtures/example-trip.js';
import { itineraryState, legacyState } from './support/itinerary-arb.js';

const json = value => JSON.stringify(value);
const clone = value => structuredClone(value);
const day = (plan, n) => plan.days[n - 1];
const event = (plan, id) => plan.days.flatMap(d => d.events).find(e => e.id === id);
const route = (plan, id) => plan.days.flatMap(d => d.routes).find(r => r.id === id);
const moveEvent = (plan, id, toDay) => {
  const from = plan.days.find(d => d.events.some(e => e.id === id));
  const ev = from.events.find(e => e.id === id);
  from.events = from.events.filter(e => e !== ev);
  plan.days[toDay - 1].events.push(ev);
};
function expectNoOp(state) {
  const before = json(state);
  const plan = toStudio(state);
  expect(json(fromStudio(state, plan))).toBe(before);
  expect(json(fromStudio(state, plan, { basePlan: toStudio(state), canDelete: false }))).toBe(before);
  expect(json(fromStudio(state, toStudio(state), { basePlan: plan }))).toBe(before);
  expect(json(state)).toBe(before);
  expect(json(plan)).toBe(json(toStudio(state)));
}

describe('no-op round trips', () => {
  test('empty state projects without inventing places, vehicles, routes or times', () => {
    const state = emptyState(new Date('2026-11-16T04:00:00Z'));
    const plan = toStudio(state);
    expect(plan.places).toEqual([]);
    expect(plan.vehicles).toEqual([]);
    expect(plan.days).toHaveLength(1);
    expect(plan.days[0]).toMatchObject({ locationId: '', title: '', routes: [], events: [] });
    expectNoOp(state);
    expect(Object.hasOwn(fromStudio(state, plan), 'places')).toBe(false);
    expect(Object.hasOwn(fromStudio(state, plan), 'storybook')).toBe(false);
  });
  test('seed, exampleTrip and legacy states are unchanged, including absent keys', () => {
    expectNoOp(seed());
    expectNoOp(exampleTrip());
    fc.assert(fc.property(legacyState(), state => { if (isValidState(state)) expectNoOp(state); }), { numRuns: 60 });
  });
  test('any valid itinerary state round trips exactly', () => {
    fc.assert(fc.property(itineraryState(), state => { if (isValidState(state)) expectNoOp(state); }), { numRuns: 150 });
  }, 20000);
  test('shifting any valid trip by whole days moves every dated record and keeps the plan content', () => {
    fc.assert(fc.property(itineraryState(), fc.integer({ min: -400, max: 400 }), (state, offset) => {
      if (!isValidState(state)) return;
      const plan = toStudio(state);
      const start = new Date(Date.parse(`${plan.days[0].date}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
      let shifted;
      try { shifted = shiftDates(plan, start); } catch { return; }
      const next = fromStudio(state, shifted);
      expect(isValidState(next)).toBe(true);
      const withoutDates = p => json(p.days.map(d => ({ ...d, date: '' })));
      expect(withoutDates(toStudio(next))).toBe(withoutDates(plan));
    }), { numRuns: 150 });
  });
  test('exampleTrip keeps all ids, blank and given departure times and stop kinds', () => {
    const plan = toStudio(exampleTrip());
    expect(plan.days.map(d => d.routes.length)).toEqual([4, 0, 4]);
    expect(route(plan, 'r-rt-1-v3')).toMatchObject({ vehicleId: 'v-v3', from: 'p-pl-c', to: STUDIO_DEST_ID, departure: '09:00' });
    expect(route(plan, 'r-rt-1-v3').stops[0]).toMatchObject({ id: 's-st-1', placeId: 'p-pl-shop', kind: 'shopping', time: '', items: ['五花肉片', '鮮蝦', '高麗菜', '運動飲料', '洋芋片', '瓦斯', '衛生紙', '免洗餐具'] });
    expect(event(plan, 'm-m1')).toMatchObject({ time: '18:00', title: '晚餐：烤肉派對', kind: 'bbq' });
    expect(isMealEvent(event(plan, 'm-m1'))).toBe(true);
    expect(isMealEvent(event(plan, 'a-a1'))).toBe(false);
    expect(day(plan, 1)).toMatchObject({ title: '向山裡出發', arrival: '12:00', locationId: STUDIO_DEST_ID });
  });
  test('31 days, 100 places and 1000 activities are accepted without truncation', () => {
    const state = emptyState(new Date('2026-01-01T04:00:00Z'));
    state.trip.startDate = '2026-01-01'; state.trip.endDate = '2026-01-31';
    state.places = Array.from({ length: 100 }, (_, i) => ({ id: `pl${i}`, name: `地點 ${i}` }));
    state.activities = Array.from({ length: 1000 }, (_, i) => ({
      id: `a${i}`, date: `2026-01-${String((i % 31) + 1).padStart(2, '0')}`, time: '09:00', title: 'x'.repeat(i ? 10 : 5000),
      type: 'camp', location: '', note: 'n'.repeat(i ? 1 : 5000), people: [], done: false
    }));
    state.trip.title = 't'.repeat(5000);
    state.trip.destination = 'd'.repeat(5000);
    state.vehicles = [{ id: 'v1', name: '', driver: '', seats: 1, passengers: [], meeting: '' }];
    state.activities[1].note = 'line\r\nbreak\ttab\u0000';
    expect(isValidState(state)).toBe(true);
    const plan = toStudio(state);
    expect(plan.days).toHaveLength(31);
    expect(plan.places).toHaveLength(101);
    expect(plan.days.reduce((n, d) => n + d.events.length, 0)).toBe(1000);
    expectNoOp(state);
  });
});

describe('activities', () => {
  test('edits change only studio fields and keep location, people, done and vehicles', () => {
    const state = seed();
    state.activities[1].vehicleIds = ['v1']; state.activities[1].people = []; state.activities[1].done = true;
    const plan = toStudio(state);
    Object.assign(event(plan, 'a-a2'), { title: '新標題', time: '15:30', kind: 'setup', notes: '新筆記' });
    const next = fromStudio(state, plan);
    expect(next.activities[1]).toEqual({ ...state.activities[1], title: '新標題', time: '15:30', type: 'pitch', note: '新筆記' });
    expect(next.activities.filter((_, i) => i !== 1)).toEqual(state.activities.filter((_, i) => i !== 1));
    expect(next.meals).toEqual(state.meals);
    expect(next.shopping).toEqual(state.shopping);
    expect(state.activities[1].title).toBe('把好吃的，一起買齊');
  });
  test('moving an event to another day changes its date; new events become activities', () => {
    const state = seed();
    const plan = toStudio(state);
    moveEvent(plan, 'a-a1', 2);
    day(plan, 3).events.push({ time: '07:00', title: '晨跑', kind: 'explore', notes: '' });
    day(plan, 3).events.push({ id: 'a-run2', time: '07:30', title: '看日出', kind: 'bbq', notes: '' });
    const next = fromStudio(state, plan);
    expect(next.activities.find(a => a.id === 'a1').date).toBe('2026-11-21');
    const added = next.activities.slice(state.activities.length);
    expect(added).toHaveLength(2);
    expect(added[0]).toMatchObject({ date: '2026-11-22', time: '07:00', title: '晨跑', type: 'free', location: '', people: [], done: false });
    expect(added[1]).toMatchObject({ id: 'run2', type: 'meal' });
    expect(new Set(next.activities.map(a => a.id)).size).toBe(next.activities.length);
    expect(isValidState(next)).toBe(true);
  });
  test('collaborators may delete activities', () => {
    const state = seed();
    const plan = toStudio(state);
    day(plan, 1).events = day(plan, 1).events.filter(e => e.id !== 'a-a5');
    expect(fromStudio(state, plan, { canDelete: false }).activities.some(a => a.id === 'a5')).toBe(false);
  });
});

describe('meals', () => {
  test('meal events edit time, title and notes and keep recipe, cook and servings', () => {
    const state = seed();
    const plan = toStudio(state);
    Object.assign(event(plan, 'm-m1'), { time: '19:00', title: '晚餐：番茄鍋', notes: '少辣', kind: 'bbq' });
    const next = fromStudio(state, plan);
    const meal = next.meals.find(m => m.id === 'm1');
    expect(meal).toEqual({ ...state.meals[0], time: '19:00', title: '番茄鍋', notes: '少辣' });
    expect(next.shopping).toEqual(state.shopping);
  });
  test('moving a meal event moves the meal date', () => {
    const state = seed();
    const plan = toStudio(state);
    moveEvent(plan, 'm-m4', 2);
    expect(fromStudio(state, plan).meals.find(m => m.id === 'm4').date).toBe('2026-11-21');
  });
  test('only organizers can delete meals; deleting syncs recipe shopping rows', () => {
    const state = exampleTrip();
    const plan = toStudio(state);
    day(plan, 2).events = day(plan, 2).events.filter(e => e.id !== 'm-m3');
    expect(() => fromStudio(state, plan, { canDelete: false })).toThrow(StudioValidationError);
    const next = fromStudio(state, plan);
    expect(next.meals.some(m => m.id === 'm3')).toBe(false);
    expect(next.shopping.some(s => s.mealIds?.includes('m3'))).toBe(false);
    expect(next.shopping.filter(s => s.source === 'manual')).toEqual(state.shopping.filter(s => s.source === 'manual'));
  });
});

describe('hashed meal ids', () => {
  test('a meal with an unsafe id becomes m_<hash>: editable by collaborators but not removable', () => {
    const state = seed();
    const unsafe = 'meal id/with spaces';
    state.meals[0].id = unsafe;
    expect(isValidState(state)).toBe(true);
    const sid = studioId('m', unsafe);
    expect(sid).toMatch(/^m_[0-9a-f]{16}$/);
    const plan = toStudio(state);
    expect(isMealEvent(event(plan, sid))).toBe(true);
    Object.assign(event(plan, sid), { time: '19:30', notes: '改筆記' });
    const edited = fromStudio(state, plan, { canDelete: false });
    expect(edited.meals[0]).toEqual({ ...state.meals[0], time: '19:30', notes: '改筆記' });
    const removal = toStudio(state);
    for (const d of removal.days) d.events = d.events.filter(e => e.id !== sid);
    expect(() => fromStudio(state, removal, { canDelete: false })).toThrow(/不能刪除既有餐點/);
    expect(fromStudio(state, removal).meals.some(m => m.id === unsafe)).toBe(false);
  });
});

describe('vehicles, routes and stops', () => {
  test('vehicle name and color edits keep driver, seats, passengers and meeting', () => {
    const state = seed();
    const plan = toStudio(state);
    Object.assign(plan.vehicles[0], { name: '新名字', color: '#123ABC' });
    const next = fromStudio(state, plan);
    expect(next.vehicles[0]).toEqual({ ...state.vehicles[0], name: '新名字', color: '#123ABC' });
    expect(next.vehicles[1]).toEqual(state.vehicles[1]);
    expectNoOp(next);
  });
  test('a new vehicle has no driver or passengers; collaborators cannot delete vehicles', () => {
    const state = seed();
    const plan = toStudio(state);
    plan.vehicles.push({ id: 'car9', name: '第三車', color: '#83accc' });
    const next = fromStudio(state, plan);
    expect(next.vehicles[2]).toEqual({ id: 'car9', name: '第三車', driver: '', seats: 4, passengers: [], meeting: '', color: '#83accc' });
    const removal = toStudio(state);
    removal.vehicles.pop();
    expect(() => fromStudio(state, removal, { canDelete: false })).toThrow(StudioValidationError);
    expect(fromStudio(state, removal).vehicles.map(v => v.id)).toEqual(['v1']);
  });
  test('a vehicle still assigned to activities cannot be removed', () => {
    const state = seed();
    Object.assign(state.activities[0], { people: [], vehicleIds: ['v2'] });
    const plan = toStudio(state);
    plan.vehicles.pop();
    expect(() => fromStudio(state, plan)).toThrow(/指定行程/);
  });
  test('a new route with a blank departure stores no time; stop tasks round trip', () => {
    const state = seed();
    const plan = toStudio(state);
    plan.places.push({ id: 'shop', name: '山下全聯', templateId: 'pxmart-mega' });
    day(plan, 1).routes.push({
      vehicleId: 'v-v1', from: 'shop', to: STUDIO_DEST_ID, departure: '',
      stops: [
        { placeId: 'shop', kind: 'shopping', time: '', items: ['肉', '菜'], notes: '' },
        { id: 'pick', placeId: 'shop', kind: 'passenger-dropoff', time: '10:15', items: [], notes: '門口' }
      ]
    });
    const next = fromStudio(state, plan);
    expect(isValidState(next)).toBe(true);
    expect(next.places).toEqual([{ id: 'shop', name: '山下全聯', templateId: 'pxmart-mega' }]);
    const r = next.routes[0];
    expect(Object.hasOwn(r, 'time')).toBe(false);
    expect(r).toMatchObject({ date: '2026-11-20', vehicleId: 'v1', from: 'shop', to: DESTINATION_REF });
    expect(r.stops[0]).toMatchObject({ place: 'shop', kind: 'shop' });
    expect(Object.keys(r.stops[0]).sort()).toEqual(['id', 'kind', 'place']);
    expect(r.stops[1]).toEqual({ id: 'pick', place: 'shop', kind: 'pickup', taskKind: 'passenger-dropoff', time: '10:15', note: '門口' });
    const again = toStudio(next);
    expect(again.days[0].routes[0].departure).toBe('');
    expect(again.days[0].routes[0].stops.map(s => s.kind)).toEqual(['shopping', 'passenger-dropoff']);
    expectNoOp(next);
  });
  test('stop edits keep stop and route ids; removing a stop keeps the others', () => {
    const state = exampleTrip();
    const plan = toStudio(state);
    const r = route(plan, 'r-rt-1-v3');
    r.stops[0].items = ['肉類']; // ignored: shopping stop items come from the shopping list
    r.stops.push({ id: 's-st-2', placeId: 'p-pl-a', kind: 'gear-return', time: '', items: [], notes: '' });
    route(plan, 'r-rt-1-v1').departure = '';
    let next = fromStudio(state, plan);
    const v3 = next.routes.find(x => x.id === 'rt-1-v3');
    expect(v3.stops).toEqual([{ id: 'st-1', place: 'pl-shop', kind: 'shop' }, { id: 'st-2', place: 'pl-a', kind: 'gear', taskKind: 'gear-return' }]);
    expect(Object.hasOwn(next.routes.find(x => x.id === 'rt-1-v1'), 'time')).toBe(false);
    const plan2 = toStudio(next);
    route(plan2, 'r-rt-1-v3').stops.shift();
    next = fromStudio(next, plan2);
    expect(next.routes.find(x => x.id === 'rt-1-v3').stops.map(s => s.id)).toEqual(['st-2']);
  });
});

describe('ids', () => {
  test('unsafe or long website ids map to stable hashed studio ids and back', () => {
    const state = seed();
    const long = 'x'.repeat(80), spaced = 'id with space', unicode = '活動一';
    state.activities[0].id = long; state.activities[1].id = spaced; state.meals[0].id = unicode;
    expect(isValidState(state)).toBe(true);
    const plan = toStudio(state);
    const ids = plan.days.flatMap(d => d.events.map(e => e.id));
    expect(ids).toContain(studioId('a', long));
    expect(studioId('a', long)).toMatch(/^a_[0-9a-f]{16}$/);
    expect(studioId('a', spaced)).not.toBe(studioId('a', long));
    expect(ids).toContain(studioId('m', unicode));
    event(plan, studioId('a', spaced)).title = '改名';
    const next = fromStudio(state, plan);
    expect(next.activities[1]).toEqual({ ...state.activities[1], title: '改名' });
    expectNoOp(state);
  });
  test('studio-created ids never reuse an existing website id', () => {
    const state = seed();
    const plan = toStudio(state);
    day(plan, 1).events.push({ id: nextId(day(plan, 1).events, 'a1x'), time: '10:00', title: '新', kind: 'camp', notes: '' });
    const next = fromStudio(state, plan);
    expect(new Set(next.activities.map(a => a.id)).size).toBe(next.activities.length);
  });
});

describe('dates', () => {
  test('shifting the studio start date moves activities, meals, routes and day settings', () => {
    const state = exampleTrip();
    const next = fromStudio(state, shiftDates(toStudio(state), '2026-12-01'));
    expect(next.trip).toMatchObject({ startDate: '2026-12-01', endDate: '2026-12-03' });
    const moved = { '2026-10-20': '2026-12-01', '2026-10-21': '2026-12-02', '2026-10-22': '2026-12-03' };
    expect(next.activities.map(a => a.date)).toEqual(state.activities.map(a => moved[a.date]));
    expect(next.meals.find(m => m.id === 'm5').date).toBe('2026-12-03');
    expect(next.routes.find(r => r.id === 'rt-3-v1').date).toBe('2026-12-03');
    expect(next.daySettings).toEqual([
      { date: '2026-12-01', title: '向山裡出發', arrival: '12:00' }, { date: '2026-12-02', title: '住進慢慢的日子' }, { date: '2026-12-03', title: '把快樂一起帶回家' }
    ]);
    expect(isValidState(next)).toBe(true);
  });
  test('adding a day extends the trip; removing a day removes what was on it', () => {
    const state = seed();
    const plan = toStudio(state);
    plan.days.push({ id: 'd9', date: '2026-11-23', title: '多留一天', routes: [], events: [] });
    const longer = fromStudio(state, plan);
    expect(longer.trip.endDate).toBe('2026-11-23');
    expect(longer.daySettings).toEqual([{ date: '2026-11-23', title: '多留一天' }]);
    const shorter = toStudio(seed());
    shorter.days.pop();
    expect(() => fromStudio(seed(), shorter, { canDelete: false })).toThrow(StudioValidationError);
    const cut = fromStudio(seed(), shorter);
    expect(cut.trip.endDate).toBe('2026-11-21');
    expect(cut.activities.some(a => a.date === '2026-11-22')).toBe(false);
  });
  test('removing a middle day keeps later days by index rather than dropping them', () => {
    const state = exampleTrip();
    const plan = toStudio(state);
    for (const d of plan.days) d.events = d.events.filter(e => !isMealEvent(e) || plan.days.indexOf(d) !== 1);
    plan.days.splice(1, 1);
    expect(() => fromStudio(state, plan)).toThrow(/連續/);
    plan.days[1].date = '2026-10-21';
    const next = fromStudio(state, plan);
    expect(next.trip.endDate).toBe('2026-10-21');
    expect(next.routes.filter(r => r.date === '2026-10-21').map(r => r.id)).toEqual(['rt-3-v1', 'rt-3-v2', 'rt-3-v3', 'rt-3-v4']);
    expect(next.daySettings.map(s => s.title)).toEqual(['向山裡出發', '把快樂一起帶回家']);
  });
});

describe('concurrent edits with basePlan', () => {
  test('newer website edits to other records and fields are kept', () => {
    const state = exampleTrip();
    const base = toStudio(state);
    const draft = clone(base);
    event(draft, 'a-a1').title = '草稿標題';
    const current = clone(state);
    current.meals[0].notes = '別人新增的筆記';
    current.meals[0].cookId = 'p3';
    current.activities[1].title = '別人改的';
    current.activities.push({ id: 'a99', date: '2026-10-21', time: '09:00', title: '別人新增', type: 'camp', location: '', note: '', people: [], done: false });
    current.vehicles[0].passengers = ['p2', 'p5'];
    current.shopping[0].assignee = 'p1';
    const next = fromStudio(current, draft, { basePlan: base });
    expect(next.activities[0].title).toBe('草稿標題');
    expect(next.activities[1].title).toBe('別人改的');
    expect(next.activities.some(a => a.id === 'a99')).toBe(true);
    expect(next.meals[0]).toEqual(current.meals[0]);
    expect(next.vehicles[0].passengers).toEqual(['p2', 'p5']);
    expect(next.shopping).toEqual(current.shopping);
  });
  test('the same field changed differently on both sides is a conflict', () => {
    const state = exampleTrip();
    const base = toStudio(state);
    const draft = clone(base);
    event(draft, 'a-a1').title = '我的';
    const current = clone(state);
    current.activities[0].title = '別人的';
    expect(() => fromStudio(current, draft, { basePlan: base })).toThrow(StudioConflictError);
    current.activities[0].title = '我的';
    expect(fromStudio(current, draft, { basePlan: base }).activities[0].title).toBe('我的');
  });
  test('editing a record someone else deleted, or a route on a removed place, is a conflict', () => {
    const state = exampleTrip();
    const base = toStudio(state);
    const draft = clone(base);
    event(draft, 'a-a2').notes = '改';
    const current = clone(state);
    current.activities = current.activities.filter(a => a.id !== 'a2');
    expect(() => fromStudio(current, draft, { basePlan: base })).toThrow(StudioConflictError);
    const untouched = fromStudio(current, clone(base), { basePlan: base });
    expect(json(untouched)).toBe(json(current));
  });
  test('an external trip date shift is kept when the draft changed other things', () => {
    const state = exampleTrip();
    const base = toStudio(state);
    const draft = clone(base);
    draft.headline = '標題';
    const current = fromStudio(state, shiftDates(base, '2026-11-01'));
    const next = fromStudio(current, draft, { basePlan: base });
    expect(next.trip.startDate).toBe('2026-11-01');
    expect(next.storybook).toEqual({ headline: '標題' });
  });
});

describe('trip text, destination and day settings', () => {
  test('headline, caption and destination template use state.storybook', () => {
    const state = exampleTrip();
    const plan = toStudio(state);
    plan.headline = '慢慢來'; plan.caption = '三天兩夜';
    plan.places[0].templateId = 'bell';
    const next = fromStudio(state, plan);
    expect(next.storybook).toEqual({ headline: '慢慢來', caption: '三天兩夜', destinationTemplate: 'bell' });
    const cleared = toStudio(next);
    cleared.headline = ''; cleared.caption = '';
    expect(fromStudio(next, cleared).storybook).toEqual({ destinationTemplate: 'bell' });
  });
  test('renaming the destination place renames the trip destination; removing it is rejected', () => {
    const state = exampleTrip();
    const plan = toStudio(state);
    plan.places[0].name = '新營區';
    expect(fromStudio(state, plan).trip.destination).toBe('新營區');
    const removed = toStudio(state);
    removed.places = removed.places.filter(p => p.id !== STUDIO_DEST_ID);
    for (const d of removed.days) { d.locationId = 'p-pl-a'; d.routes = []; }
    expect(() => fromStudio(state, removed)).toThrow(/目的地/);
  });
  test('day location, title, route position and arrival label are stored only when changed', () => {
    const state = exampleTrip();
    const plan = toStudio(state);
    Object.assign(day(plan, 2), { locationId: 'p-pl-taipei', routePosition: 'after', arrivalLabel: '傍晚抵達', title: '' });
    let next = fromStudio(state, plan);
    expect(next.daySettings[1]).toEqual({ date: '2026-10-21', place: 'pl-taipei', routePosition: 'after', arrivalLabel: '傍晚抵達' });
    const back = toStudio(next);
    Object.assign(day(back, 2), { locationId: STUDIO_DEST_ID, routePosition: 'before', arrivalLabel: '' });
    next = fromStudio(next, back);
    expect(next.daySettings.map(s => s.date)).toEqual(['2026-10-20', '2026-10-22']);
  });
  test('place names follow the website rules; shopping is read-only', () => {
    const state = exampleTrip();
    const plan = toStudio(state);
    plan.places[1].name = '出發地點 B';
    expect(() => fromStudio(state, plan)).toThrow(StudioValidationError);
    const long = toStudio(state);
    long.places[1].name = '長'.repeat(51);
    expect(() => fromStudio(state, long)).toThrow(/50/);
    const shop = toStudio(state);
    shop.shopping.push('新品項');
    expect(() => fromStudio(state, shop)).toThrow(/採買清單/);
  });
  test('an invalid plan or state is rejected without changing the state', () => {
    const state = seed();
    const before = json(state);
    const plan = toStudio(state);
    plan.days[0].events[0].time = '25:00';
    expect(() => fromStudio(state, plan)).toThrow(StudioValidationError);
    expect(() => toStudio({ ...state, schema: 2 })).toThrow(StudioValidationError);
    expect(json(state)).toBe(before);
  });
});
