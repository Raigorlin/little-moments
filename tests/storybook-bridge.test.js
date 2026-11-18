import { describe, expect, test } from 'bun:test';
import { fromStudio, toStudio, studioId } from '../src/storybook-adapter.js';
import { StudioModel } from '../src/storybook/model.js';
import { emptyState, isValidState } from '../src/model.js';
import { exampleTrip } from './fixtures/example-trip.js';

const copy = value => structuredClone(value);
const day = (plan, date) => plan.days.find(row => row.date === date);

describe('storybook schedule bridge (isolated integration)', () => {
  test('four-car, three-day fixture projects without inventing or dropping route/stop/event IDs', () => {
    const state = exampleTrip();
    expect(isValidState(state)).toBe(true);
    const plan = toStudio(state);
    expect(StudioModel.validate(plan)).toEqual(plan);
    expect(plan.vehicles.map(car => car.id)).toEqual(state.vehicles.map(car => studioId('v', car.id)));
    expect(plan.days.map(d => d.date)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
    expect(day(plan, '2026-10-20').routes.map(route => route.id)).toEqual(state.routes.filter(route => route.date === '2026-10-20').map(route => studioId('r', route.id)));
    expect(day(plan, '2026-10-22').routes.map(route => route.id)).toEqual(state.routes.filter(route => route.date === '2026-10-22').map(route => studioId('r', route.id)));
    expect(day(plan, '2026-10-20').routes.find(route => route.id === studioId('r','rt-1-v3')).stops[0].id).toBe(studioId('s','st-1'));
    expect(day(plan, '2026-10-20').events.some(event => event.id === 'm-m1')).toBe(true);
    expect(day(plan, '2026-10-20').events.some(event => event.id === 'a-a1')).toBe(true);
  });

  test('an untouched plan preserves the full stored trip and all unrelated fields', () => {
    for (const state of [exampleTrip(), emptyState(new Date('2026-10-20T12:00:00Z'))]) {
      expect(isValidState(state)).toBe(true);
      const before = copy(state), basePlan = toStudio(state);
      expect(fromStudio(state, basePlan, { basePlan })).toEqual(before);
      expect(state).toEqual(before);
    }
  });

  test('route, event and poster edits preserve permissions, people, shopping, gear, identity, done and passengers', () => {
    const state = exampleTrip(), original = copy(state), basePlan = toStudio(state), draft = copy(basePlan);
    draft.headline = '四車慢遊';
    draft.days[0].routes.find(route => route.id === studioId('r','rt-1-v3')).stops[0].notes = '記得冰塊';
    draft.days[0].events.find(event => event.id === 'a-a1').title = '先搭好帳篷';
    const next = fromStudio(state, draft, { basePlan });
    expect(isValidState(next)).toBe(true);
    expect(state).toEqual(original);
    expect(next.storybook.headline).toBe('四車慢遊');
    expect(next.routes.find(route => route.id === 'rt-1-v3').stops[0].note).toBe('記得冰塊');
    expect(next.activities.find(activity => activity.id === 'a1').title).toBe('先搭好帳篷');
    for (const key of ['people', 'meals', 'shopping', 'gear', 'events', 'departed', 'currentUser', 'joined', 'revision']) {
      expect(next[key]).toEqual(original[key]);
    }
    expect(next.vehicles.map(vehicle => [vehicle.id, vehicle.driver, vehicle.seats, vehicle.passengers]))
      .toEqual(original.vehicles.map(vehicle => [vehicle.id, vehicle.driver, vehicle.seats, vehicle.passengers]));
  });

  test('divergent same-field website edit conflicts; unrelated website edit survives a draft save', () => {
    const source = exampleTrip(), basePlan = toStudio(source), draft = copy(basePlan);
    draft.days[0].events.find(event => event.id === 'a-a1').title = '我改的行程';
    const conflicting = copy(source);
    conflicting.activities.find(activity => activity.id === 'a1').title = '另一個分頁改的行程';
    expect(() => fromStudio(conflicting, draft, { basePlan })).toThrow();
    const unrelated = copy(source);
    unrelated.shopping[0].quantity = '3 盒';
    const next = fromStudio(unrelated, draft, { basePlan });
    expect(isValidState(next)).toBe(true);
    expect(next.activities.find(activity => activity.id === 'a1').title).toBe('我改的行程');
    expect(next.shopping[0].quantity).toBe('3 盒');
    expect(conflicting.activities.find(activity => activity.id === 'a1').title).toBe('另一個分頁改的行程');
  });

  test('collaborators cannot remove a website meal through its linked studio event', () => {
    const state = exampleTrip(), basePlan = toStudio(state), draft = copy(basePlan);
    draft.days[0].events = draft.days[0].events.filter(event => event.id !== 'm-m1');
    expect(() => fromStudio(state, draft, { canDelete: false, basePlan })).toThrow();
    expect(isValidState(state)).toBe(true);
    expect(state.meals.some(meal => meal.id === 'm1')).toBe(true);
  });

  test('move the trip dates as one interval without orphaning routes, meals and settings', () => {
    const state = exampleTrip(), basePlan = toStudio(state), draft = StudioModel.shiftDates(basePlan, '2026-10-23');
    const next = fromStudio(state, draft, { basePlan });
    expect(isValidState(next)).toBe(true);
    expect([next.trip.startDate, next.trip.endDate]).toEqual(['2026-10-23','2026-10-25']);
    expect(next.routes.filter(route => route.date === '2026-10-23')).toHaveLength(4);
    expect(next.routes.filter(route => route.date === '2026-10-25')).toHaveLength(4);
    expect(next.activities.find(activity => activity.id === 'a1').date).toBe('2026-10-23');
    expect(next.meals.find(meal => meal.id === 'm5').date).toBe('2026-10-25');
    expect(next.daySettings.find(setting => setting.date === '2026-10-23').title).toBe('向山裡出發');
  });

  test('blank departure stays blank when editing other route fields', () => {
    const state = exampleTrip();
    delete state.routes[0].time;
    expect(isValidState(state)).toBe(true);
    const basePlan=toStudio(state), draft=copy(basePlan);
    const route=draft.days[0].routes.find(x => x.id === studioId('r','rt-1-v1'));
    expect(route.departure).toBe('');
    route.stops.push({id:'snew',placeId:studioId('p','pl-shop'),kind:'shopping',time:'',items:['冰塊'],notes:'午後再買'});
    const next=fromStudio(state,draft,{basePlan});
    expect(isValidState(next)).toBe(true);
    expect(next.routes[0].time ?? '').toBe('');
    // Shopping stop items come from the shopping list, so the typed items are not stored.
    expect(next.routes[0].stops[0]).toMatchObject({kind:'shop',place:'pl-shop',note:'午後再買'});
    expect(Object.hasOwn(next.routes[0].stops[0],'items')).toBe(false);
  });

  test('an allowed meal deletion syncs shopping and keeps manual shopping intact', () => {
    const state=exampleTrip(), basePlan=toStudio(state), draft=copy(basePlan);
    draft.days[1].events=draft.days[1].events.filter(e => e.id !== 'm-m2');
    const next=fromStudio(state,draft,{canDelete:true,basePlan});
    expect(isValidState(next)).toBe(true);
    expect(next.meals.some(meal => meal.id === 'm2')).toBe(false);
    expect(next.shopping.filter(item => item.source === 'manual')).toEqual(state.shopping.filter(item => item.source === 'manual'));
    expect(next.shopping.every(item => !item.mealIds?.includes('m2'))).toBe(true);
  });

  test('bad draft is rejected without modifying the trip', () => {
    const state = exampleTrip(), original = copy(state), basePlan = toStudio(state), draft = copy(basePlan);
    draft.days[0].routes[0].vehicleId = 'missing-car';
    expect(() => fromStudio(state, draft, { basePlan })).toThrow();
    expect(state).toEqual(original);
  });
});
