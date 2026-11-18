// Server API tests for the trip-planning-workflow-enhance fields (places, routes, daySettings, meals[].time):
// storage, validation, missing-field handling, date shifting, the Requirement 2.10 messages and collaborator rules.
// Requirements 2.10, 18.9, 18.10, 18.11, 20.3, 20.4, 21.3, 21.4, 21.5, 21.7, 23.8, 23.13.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fc from 'fast-check';
import { createAccountService } from '../server/accounts.js';
import { isValidState } from '../src/model.js';
import { DESTINATION_REF } from '../src/itinerary-model.js';
import { useTestDatabase, resetTables, serviceDb } from './support/pg.js';
import { exampleTrip } from './fixtures/example-trip.js';
import { faultState, FAULT_KINDS } from './support/itinerary-arb.js';

const BASE = 'http://127.0.0.1:5181';
const PASS = 'correct horse battery';
const DAY = 86_400_000;
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const byId = (list, id) => list.find(item => item.id === id);

/** exampleTrip() plus one gear item, so the "cannot remove gear" case has something to remove. */
function legacyExample() {
  const state = exampleTrip();
  state.gear.push({ id: 'g1', name: '營燈', quantity: '2 盞', scope: 'shared', assignee: 'p1', ready: [] });
  return state;
}

describe('trip itinerary account API', () => {
  let svc, clockMs;
  const db = useTestDatabase();
  beforeEach(async () => {
    clockMs = Date.parse('2026-10-04T00:00:00Z');
    await resetTables(db.sql);
    svc = await createAccountService({ db: serviceDb(db.sql), now: () => clockMs });
  });
  afterEach(() => svc.close());

  async function call(method, path, { body, cookie } = {}) {
    const headers = { origin: BASE };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await svc.handle(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), {});
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  }
  const ok = (res, status = 200) => { if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`); return res; };
  const rejected = (res, statuses) => { expect(statuses).toContain(res.status); expect(typeof res.body.error).toBe('string'); return res; };
  const account = async (path, username, displayName) => ok(await call('POST', path, { body: { username, displayName, password: PASS } })).cookie;
  const getTrip = async (cookie, id) => ok(await call('GET', `/api/trips/${id}`, { cookie })).body;
  async function putState(cookie, id, mutate) {
    const env = await getTrip(cookie, id);
    const state = structuredClone(env.state);
    mutate(state);
    return call('PUT', `/api/trips/${id}`, { cookie, body: { revision: env.trip.revision, state } });
  }
  const patchTrip = async (cookie, id, fields) => {
    const env = await getTrip(cookie, id);
    return call('PATCH', `/api/trips/${id}`, { cookie, body: { revision: env.trip.revision, ...fields } });
  };
  async function setup(legacyState = legacyExample()) {
    const admin = await account('/api/setup', 'admin-one', '管理員');
    const owner = await account('/api/register', 'owner-a', '主辦人');
    const member = await account('/api/register', 'member-b', '阿哲');
    const outsider = await account('/api/register', 'outsider-c', '路人');
    const trip = ok(await call('POST', '/api/trips', { cookie: owner, body: { legacyState } }), 201).body.trip;
    const inv = ok(await call('POST', `/api/trips/${trip.id}/invites`, { cookie: owner, body: {} }), 201).body;
    ok(await call('POST', `/api/invites/${inv.token}/join`, { cookie: member, body: { name: '阿哲哲', role: '咖啡' } }));
    return { admin, owner, member, outsider, id: trip.id };
  }
  async function expectUnchanged(cookie, id, before) {
    const after = await getTrip(cookie, id);
    expect(after.trip.revision).toBe(before.trip.revision);
    expect(after.state).toEqual(before.state);
  }
  const tripCount = async () => (await db.sql`SELECT count(*)::int AS n FROM trips`)[0].n;

  describe('storing the new fields (23.13)', () => {
    test('import keeps places, routes, stops, daySettings and meal times', async () => {
      const legacy = legacyExample();
      byId(legacy.meals, 'm2').time = '07:45';
      const { owner, id } = await setup(legacy);
      const { state } = await getTrip(owner, id);
      expect(state.places).toEqual(legacy.places);
      expect(state.routes).toEqual(legacy.routes);
      expect(state.daySettings).toEqual(legacy.daySettings);
      expect(byId(state.meals, 'm2').time).toBe('07:45');
      expect(byId(state.routes, 'rt-1-v3').stops).toEqual([{ id: 'st-1', place: 'pl-shop', kind: 'shop' }]);
      expect(isValidState(state)).toBe(true);
    });

    test('PUT saves new places, a route with a stop note, day settings and a meal time; GET returns them', async () => {
      const { owner, id } = await setup();
      const res = ok(await putState(owner, id, s => {
        s.places.push({ id: 'pl-new', name: '新地點' });
        s.routes.push({ id: 'rt-2-v1', date: '2026-10-21', vehicleId: 'v1', from: 'pl-new', to: DESTINATION_REF, time: '10:00', stops: [{ id: 'st-2', place: 'pl-new', kind: 'other', note: '順路拿東西' }] });
        s.daySettings[1] = { date: '2026-10-21', title: '慢慢逛', place: 'pl-new', arrival: '10:30' };
        byId(s.meals, 'm2').time = '07:45';
      }));
      const { state } = await getTrip(owner, id);
      expect(res.body.state.routes.map(r => r.id)).toContain('rt-2-v1');
      expect(byId(state.places, 'pl-new')).toEqual({ id: 'pl-new', name: '新地點' });
      expect(byId(state.routes, 'rt-2-v1')).toEqual({ id: 'rt-2-v1', date: '2026-10-21', vehicleId: 'v1', from: 'pl-new', to: DESTINATION_REF, time: '10:00', stops: [{ id: 'st-2', place: 'pl-new', kind: 'other', note: '順路拿東西' }] });
      expect(state.daySettings.find(d => d.date === '2026-10-21')).toEqual({ date: '2026-10-21', title: '慢慢逛', place: 'pl-new', arrival: '10:30' });
      expect(byId(state.meals, 'm2').time).toBe('07:45');
      expect(isValidState(state)).toBe(true);
    });
  });

  describe('invalid itinerary data (23.4)', () => {
    test('every invalid variant sent by PUT is rejected with 400 and nothing changes', async () => {
      const { owner, id } = await setup();
      for (const kind of FAULT_KINDS) {
        const samples = fc.sample(faultState(kind), { numRuns: 2, seed: 20260423 });
        for (const { state: bad } of samples) {
          const before = await getTrip(owner, id);
          expect(isValidState(bad)).toBe(false);
          rejected(await call('PUT', `/api/trips/${id}`, { cookie: owner, body: { revision: before.trip.revision, state: bad } }), [400]);
          await expectUnchanged(owner, id, before);
        }
      }
    });

    test('targeted invalid edits of the stored trip are rejected with 400 and nothing changes', async () => {
      const { owner, id } = await setup();
      const edits = [
        s => { s.places[0].name = ' '; },
        s => { s.places[1].name = s.places[0].name; },
        s => { s.trip.destination = s.places[0].name; },
        s => { s.routes[0].time = '8:00'; },
        s => { s.routes[0].vehicleId = 'nope'; },
        s => { s.routes[0].to = 'pl-missing'; },
        s => { s.routes[1].vehicleId = s.routes[0].vehicleId; s.routes[1].date = s.routes[0].date; },
        s => { s.routes[2].stops[0].kind = 'buy'; },
        s => { s.daySettings[0].place = DESTINATION_REF; },
        s => { s.daySettings[1].date = s.daySettings[0].date; },
        s => { s.daySettings[0].arrival = '24:00'; },
        s => { byId(s.meals, 'm2').time = ''; },
        s => { byId(s.activities, 'a1').type = 'unknown'; }
      ];
      for (const edit of edits) {
        const before = await getTrip(owner, id);
        rejected(await putState(owner, id, edit), [400]);
        await expectUnchanged(owner, id, before);
      }
    });
  });

  describe('missing fields keep the server values (18.11)', () => {
    test('a PUT without places, routes or daySettings keeps the stored lists', async () => {
      const { owner, id } = await setup();
      const before = await getTrip(owner, id);
      ok(await putState(owner, id, s => { delete s.places; delete s.routes; delete s.daySettings; s.trip.note = '舊頁面儲存'; }));
      const { state } = await getTrip(owner, id);
      expect(state.places).toEqual(before.state.places);
      expect(state.routes).toEqual(before.state.routes);
      expect(state.daySettings).toEqual(before.state.daySettings);
      expect(state.trip.note).toBe('舊頁面儲存');
    });

    test('an empty daySettings list is stored as an empty list and is not refilled afterwards', async () => {
      const { owner, id } = await setup();
      ok(await putState(owner, id, s => { s.daySettings = []; }));
      expect((await getTrip(owner, id)).state.daySettings).toEqual([]);
      ok(await putState(owner, id, s => { delete s.daySettings; s.trip.note = '再存一次'; }));
      const { state } = await getTrip(owner, id);
      expect(state.daySettings).toEqual([]);
      expect(state.routes.length).toBeGreaterThan(0);
    });
  });

  describe('date changes shift the itinerary (20.3, 20.4)', () => {
    const shifted = (before, state, days) => {
      expect(state.trip.startDate).toBe(addDays(before.trip.startDate, days));
      expect(state.trip.endDate).toBe(addDays(before.trip.endDate, days));
      expect(state.activities.map(a => [a.id, a.date])).toEqual(before.activities.map(a => [a.id, addDays(a.date, days)]));
      expect(state.meals.filter(m => before.meals.some(b => b.id === m.id)).map(m => [m.id, m.date]))
        .toEqual(before.meals.map(m => [m.id, addDays(m.date, days)]));
      expect(state.routes.map(r => [r.id, r.date])).toEqual(before.routes.map(r => [r.id, addDays(r.date, days)]));
      expect(state.daySettings.map(d => [d.date, d.title, d.arrival])).toEqual(before.daySettings.map(d => [addDays(d.date, days), d.title, d.arrival]));
      expect(state.routes.map(r => [r.vehicleId, r.from, r.to, r.time, r.stops])).toEqual(before.routes.map(r => [r.vehicleId, r.from, r.to, r.time, r.stops]));
    };

    test('PATCH moves activities, meals, routes and daySettings by the same number of days', async () => {
      const { owner, id } = await setup();
      const before = (await getTrip(owner, id)).state;
      ok(await patchTrip(owner, id, { startDate: '2026-10-23', endDate: '2026-10-25' }));
      shifted(before, (await getTrip(owner, id)).state, 3);
      ok(await patchTrip(owner, id, { startDate: '2026-10-19', endDate: '2026-10-21' }));
      shifted(before, (await getTrip(owner, id)).state, -1);
    });

    test('importing a legacyState whose dates differ shifts everything by the same number of days', async () => {
      const legacy = legacyExample();
      const { owner } = await setup();
      const created = ok(await call('POST', '/api/trips', { cookie: owner, body: { legacyState: legacy, startDate: '2026-11-05', endDate: '2026-11-07' } }), 201).body.trip;
      const { state } = await getTrip(owner, created.id);
      shifted(legacy, state, 16);
      expect(isValidState(state)).toBe(true);
    });

    test('PATCH that cannot fit the itinerary returns 400 and writes nothing', async () => {
      const { owner, id } = await setup();
      for (const fields of [{ endDate: '2026-10-21' }, { startDate: '2026-10-21' }, { startDate: '2026-10-22', endDate: '2026-10-22' }]) {
        const before = await getTrip(owner, id);
        const res = rejected(await patchTrip(owner, id, fields), [400]);
        expect(res.body.error).toContain('新日期範圍放不下');
        await expectUnchanged(owner, id, before);
      }
    });

    test('importing a legacyState that cannot fit returns 400 and creates no trip', async () => {
      const { owner } = await setup();
      const count = await tripCount();
      const res = rejected(await call('POST', '/api/trips', { cookie: owner, body: { legacyState: legacyExample(), startDate: '2026-10-20', endDate: '2026-10-21' } }), [400]);
      expect(res.body.error).toContain('新日期範圍放不下');
      expect(await tripCount()).toBe(count);
    });
  });

  describe('trip destination checks (2.10)', () => {
    const SAME_NAME = '旅行目的地與地點清單中的地點同名，請先把該地點改名。';
    const IN_USE = '仍有路線或停靠點使用旅行目的地，不能把目的地清空。';

    test('a destination with the same name as a place is rejected by PATCH and by import', async () => {
      const { owner, id } = await setup();
      const before = await getTrip(owner, id);
      expect(rejected(await patchTrip(owner, id, { destination: '超市／賣場' }), [400]).body.error).toBe(SAME_NAME);
      await expectUnchanged(owner, id, before);
      const count = await tripCount();
      expect(rejected(await call('POST', '/api/trips', { cookie: owner, body: { legacyState: legacyExample(), destination: '台北' } }), [400]).body.error).toBe(SAME_NAME);
      expect(await tripCount()).toBe(count);
    });

    test('clearing the destination while routes still use it is rejected by PATCH and by import', async () => {
      const { owner, id } = await setup();
      const before = await getTrip(owner, id);
      expect(rejected(await patchTrip(owner, id, { destination: '' }), [400]).body.error).toBe(IN_USE);
      await expectUnchanged(owner, id, before);
      const count = await tripCount();
      expect(rejected(await call('POST', '/api/trips', { cookie: owner, body: { legacyState: legacyExample(), destination: '' } }), [400]).body.error).toBe(IN_USE);
      expect(await tripCount()).toBe(count);
    });
  });

  describe('invited collaborators (21.3, 21.4, 21.5, 21.7, 23.8)', () => {
    test('can remove an activity, a stop, a route and unused places; GET no longer has them', async () => {
      const { member, id } = await setup();
      ok(await putState(member, id, s => { s.activities = s.activities.filter(a => a.id !== 'a1'); }));
      expect(byId((await getTrip(member, id)).state.activities, 'a1')).toBeUndefined();

      ok(await putState(member, id, s => { byId(s.routes, 'rt-1-v3').stops = []; }));
      expect(byId((await getTrip(member, id)).state.routes, 'rt-1-v3').stops).toEqual([]);

      ok(await putState(member, id, s => { s.places = s.places.filter(p => p.id !== 'pl-shop'); }));
      expect(byId((await getTrip(member, id)).state.places, 'pl-shop')).toBeUndefined();

      ok(await putState(member, id, s => { s.routes = s.routes.filter(r => r.id !== 'rt-1-v4'); }));
      ok(await putState(member, id, s => { s.places = s.places.filter(p => p.id !== 'pl-d'); }));
      const { state } = await getTrip(member, id);
      expect(byId(state.routes, 'rt-1-v4')).toBeUndefined();
      expect(byId(state.places, 'pl-d')).toBeUndefined();
      expect(isValidState(state)).toBe(true);
    });

    test('cannot remove an unbound participant, meal, gear, vehicle or shopping item', async () => {
      const { member, id } = await setup();
      const removals = {
        participant: s => { s.people = s.people.filter(p => p.id !== 'p8'); byId(s.vehicles, 'v4').passengers = []; },
        meal: s => { s.meals = s.meals.filter(m => m.id !== 'm5'); },
        gear: s => { s.gear = s.gear.filter(g => g.id !== 'g1'); },
        vehicle: s => { s.vehicles = s.vehicles.filter(v => v.id !== 'v4'); s.routes = s.routes.filter(r => r.vehicleId !== 'v4'); },
        shopping: s => { s.shopping = s.shopping.filter(i => i.id !== 's1'); }
      };
      for (const [name, mutate] of Object.entries(removals)) {
        const before = await getTrip(member, id);
        const res = await putState(member, id, mutate);
        expect([name, res.status]).toEqual([name, 403]);
        expect(typeof res.body.error).toBe('string');
        await expectUnchanged(member, id, before);
      }
    });

    test('cannot change meal ingredient marking', async () => {
      const { member, id } = await setup();
      const before = await getTrip(member, id);
      rejected(await putState(member, id, s => { Object.assign(byId(s.shopping, 's1'), { source: 'meal', mealIds: ['m2'] }); }), [403]);
      await expectUnchanged(member, id, before);
    });

    test('can change day settings, a shopping assignee, driver and passengers, and clear a meeting', async () => {
      const { owner, member, id } = await setup();
      ok(await putState(owner, id, s => { byId(s.vehicles, 'v1').meeting = '08:00 · 台北車站'; }));
      ok(await putState(member, id, s => { s.daySettings[0].title = '改個標題'; s.daySettings[0].arrival = '13:00'; }));
      ok(await putState(member, id, s => { byId(s.shopping, 's1').assignee = 'p1'; }));
      ok(await putState(member, id, s => { Object.assign(byId(s.vehicles, 'v1'), { driver: 'p2', passengers: ['p1'] }); }));
      ok(await putState(member, id, s => { byId(s.vehicles, 'v1').meeting = ''; }));
      const { state } = await getTrip(owner, id);
      expect(state.daySettings[0]).toMatchObject({ title: '改個標題', arrival: '13:00' });
      expect(byId(state.shopping, 's1').assignee).toBe('p1');
      expect(byId(state.vehicles, 'v1')).toMatchObject({ driver: 'p2', passengers: ['p1'], meeting: '' });
    });

    test('a non-member gets 404 on GET and PUT', async () => {
      const { owner, outsider, id } = await setup();
      const before = await getTrip(owner, id);
      rejected(await call('GET', `/api/trips/${id}`, { cookie: outsider }), [404]);
      rejected(await call('PUT', `/api/trips/${id}`, { cookie: outsider, body: { revision: before.trip.revision, state: before.state } }), [404]);
    });
  });
});
