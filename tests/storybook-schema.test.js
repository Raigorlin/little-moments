import { describe, test, expect } from 'bun:test';
import * as M from '../src/storybook/model.js';
import { isValidState } from '../src/model.js';
import { cleanState } from '../server/accounts.js';
import { toStudio, fromStudio } from '../src/storybook-adapter.js';
import { exampleTrip } from './fixtures/example-trip.js';

const plan = () => ({
  schemaVersion: 1, title: '旅行', places: [{ id: 'camp', name: '營區', templateId: 'tent' }], vehicles: [],
  days: [{ id: 'd1', date: '2026-10-20', events: [{ id: 'e1', time: '09:00', title: '起床', kind: 'sunrise', notes: 'a\r\nb' }] }]
});

describe('studio model', () => {
  test('exports the studio API as named, StudioModel and default exports', () => {
    for (const key of ['VERSION', 'LIMITS', 'KINDS', 'STOP_KINDS', 'TEMPLATES', 'StudioValidationError', 'validate', 'canonical', 'fingerprint', 'minutes', 'dateText', 'shiftDates', 'nextId']) {
      expect(M[key]).toBeDefined();
      expect(M.StudioModel[key]).toBe(M[key]);
    }
    expect(M.default).toBe(M.StudioModel);
    expect(M.LIMITS).toMatchObject({ vehiclesMin: 0, placesMin: 0, daysMax: 31 });
  });
  test('keeps optional ids, blank departures, blank titles and text exactly', () => {
    const p = plan();
    p.vehicles.push({ id: 'car', name: '車', color: '#ABCDEF' });
    p.days[0].title = '';
    p.days[0].routes = [{ id: 'r1', vehicleId: 'car', from: 'camp', to: 'camp', departure: '', stops: [{ id: 's1', placeId: 'camp', kind: 'waypoint', time: '' }] }];
    const out = M.validate(p);
    expect(out.vehicles[0].color).toBe('#ABCDEF');
    expect(out.days[0]).toMatchObject({ id: 'd1', title: '', locationId: '', arrival: '' });
    expect(out.days[0].routes[0]).toMatchObject({ id: 'r1', departure: '' });
    expect(out.days[0].routes[0].stops[0].id).toBe('s1');
    expect(out.days[0].events[0]).toEqual({ id: 'e1', time: '09:00', title: '起床', kind: 'sunrise', notes: 'a\r\nb' });
    expect(M.validate(out)).toEqual(out);
    const raw = plan();
    raw.days[0].events[0].title = 'tab\tand\u0000nul';
    expect(M.validate(raw).days[0].events[0].title).toBe('tab\tand\u0000nul');
  });
  test('rejects invalid optional fields and duplicate ids', () => {
    const cases = [
      p => { p.places[0].templateId = 'castle'; },
      p => { p.vehicles.push({ id: 'car', name: '車', color: 'red' }); },
      p => { p.days[0].events[0].time = ''; },
      p => { p.days[0].events[0].id = 'bad id'; },
      p => { p.days[0].events.push({ ...p.days[0].events[0] }); },
      p => { p.days[0].arrival = '9:00'; },
      p => { p.days[0].routePosition = 'middle'; },
      p => { p.days[0].locationId = 'nowhere'; },
      p => { p.days[0].events[0].notes = 1; },
      p => { p.days[0].routes = [{ vehicleId: 'ghost', from: 'camp', to: 'camp', departure: '' }]; },
      p => { p.days.push({ date: '2026-10-20' }); }
    ];
    for (const mutate of cases) {
      const p = plan();
      mutate(p);
      expect(() => M.validate(p)).toThrow(M.StudioValidationError);
    }
  });
  test('accepts any four-digit ISO year the website accepts', () => {
    const p = plan();
    p.days[0].date = '0050-02-28';
    expect(M.validate(p).days[0].date).toBe('0050-02-28');
    expect(M.shiftDates(p, '0099-12-31').days[0].date).toBe('0099-12-31');
  });
});

describe('canonical optional storybook fields', () => {
  const valid = mutate => { const s = exampleTrip(); mutate(s); return isValidState(s); };
  test('accepts validated visual and task fields', () => {
    expect(valid(s => {
      s.storybook = { headline: '慢慢來', caption: '三天兩夜', destinationTemplate: 'bell' };
      s.places[0].templateId = 'home';
      s.vehicles[0].color = '#83ACCC';
      Object.assign(s.routes[2].stops[0], { time: '09:30', items: ['肉', '菜'], taskKind: 'shopping' });
      Object.assign(s.daySettings[0], { arrivalLabel: '四車會合', routePosition: 'after' });
    })).toBe(true);
    expect(valid(s => { s.storybook = {}; })).toBe(true);
  });
  test('rejects invalid visual and task fields', () => {
    const bad = [
      s => { s.storybook = { headline: 'x'.repeat(81) }; },
      s => { s.storybook = { other: 1 }; },
      s => { s.storybook = []; },
      s => { s.storybook = { destinationTemplate: 'castle' }; },
      s => { s.places[0].templateId = 'castle'; },
      s => { s.vehicles[0].color = 'blue'; },
      s => { s.routes[2].stops[0].taskKind = 'gear-return'; },
      s => { s.routes[2].stops[0].time = '9:30'; },
      s => { s.routes[2].stops[0].items = Array(9).fill('x'); },
      s => { s.routes[2].stops[0].items = [' ']; },
      s => { s.daySettings[0].arrivalLabel = 'x'.repeat(121); },
      s => { s.daySettings[0].routePosition = 'middle'; }
    ];
    for (const mutate of bad) expect(valid(mutate)).toBe(false);
  });
});

describe('server cleanState whitelist', () => {
  test('retains storybook fields and strips unknown ones', () => {
    const s = exampleTrip();
    s.storybook = { headline: 'h', caption: 'c', destinationTemplate: 'bell', secret: 'x' };
    s.places[0].templateId = 'home'; s.places[0].junk = 1;
    s.vehicles[0].color = '#83accc'; s.vehicles[0].junk = 1;
    Object.assign(s.routes[2].stops[0], { time: '09:30', items: ['肉'], taskKind: 'shopping', junk: 1 });
    Object.assign(s.daySettings[0], { arrivalLabel: 'a', routePosition: 'after', junk: 1 });
    const out = cleanState(s);
    expect(out.storybook).toEqual({ headline: 'h', caption: 'c', destinationTemplate: 'bell' });
    expect(out.places[0]).toEqual({ id: 'pl-a', name: '出發地點 A', templateId: 'home' });
    expect(out.vehicles[0].color).toBe('#83accc');
    expect(out.vehicles[0].junk).toBeUndefined();
    expect(out.routes[2].stops[0]).toEqual({ id: 'st-1', place: 'pl-shop', kind: 'shop', time: '09:30', items: ['肉'], taskKind: 'shopping' });
    expect(out.daySettings[0]).toEqual({ date: '2026-10-20', title: '向山裡出發', arrival: '12:00', arrivalLabel: 'a', routePosition: 'after' });
    expect(isValidState(out)).toBe(true);
  });
  test('clearing the last headline sends an explicit empty storybook so PUT cannot resurrect it', () => {
    const current = exampleTrip();
    current.storybook = { headline: '原封面' };
    const draft = toStudio(current);
    draft.headline = '';
    const next = cleanState(fromStudio(current, draft, { basePlan: toStudio(current) }));
    expect(Object.hasOwn(next, 'storybook')).toBe(true);
    expect(next.storybook).toEqual({});
    expect(isValidState(next)).toBe(true);
  });
  test('leaves a state without storybook fields unchanged', () => {
    const s = exampleTrip();
    const out = cleanState(s);
    expect(Object.hasOwn(out, 'storybook')).toBe(false);
    expect(out).toEqual(s);
  });
});
