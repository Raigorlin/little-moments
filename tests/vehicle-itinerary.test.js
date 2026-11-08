import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { validActivityVehicles, activityForVehicle, activityForPerson, activityParticipantLabel } from '../src/vehicle-itinerary.js';
import { createAccountService } from '../server/accounts.js';
import { seed, isValidState } from '../src/model.js';

const activity = (state, id) => state.activities.find(a => a.id === id);
const withCars = (state, id, vehicleIds) => Object.assign(activity(state, id), { people: [], vehicleIds });
const BAD_VEHICLE_IDS = [[], ['nope'], ['v1', 'v1'], [''], [1], 'v1', null, {}, ['v1', 'nope']];

describe('validActivityVehicles', () => {
  test('absent vehicleIds keeps every legacy people shape valid', () => {
    const state = seed();
    for (const a of state.activities) expect(validActivityVehicles(a, state.vehicles)).toBe(true);
  });
  test('accepts a nonempty unique list of existing vehicle IDs with no people', () => {
    const state = seed();
    expect(validActivityVehicles({ ...activity(state, 'a3'), people: [], vehicleIds: ['v1'] }, state.vehicles)).toBe(true);
    expect(validActivityVehicles({ ...activity(state, 'a3'), people: [], vehicleIds: ['v2', 'v1'] }, state.vehicles)).toBe(true);
  });
  test('rejects empty, duplicate, unknown and non-string IDs', () => {
    const state = seed();
    for (const vehicleIds of BAD_VEHICLE_IDS) expect(validActivityVehicles({ ...activity(state, 'a3'), people: [], vehicleIds }, state.vehicles)).toBe(false);
  });
  test('rejects a car selection that conflicts with explicit people', () => {
    const state = seed();
    expect(validActivityVehicles({ ...activity(state, 'a3'), people: ['p1'], vehicleIds: ['v1'] }, state.vehicles)).toBe(false);
  });
  test('rejects IDs once the referenced car is gone', () => {
    const state = seed();
    expect(validActivityVehicles({ ...activity(state, 'a3'), people: [], vehicleIds: ['v1'] }, state.vehicles.filter(v => v.id !== 'v1'))).toBe(false);
  });
});

describe('isValidState with vehicle itineraries', () => {
  test('seed and legacy activities stay valid without vehicleIds', () => {
    const state = seed();
    expect(state.activities.some(a => 'vehicleIds' in a)).toBe(false);
    expect(isValidState(state)).toBe(true);
  });
  test('accepts per-car activities', () => {
    const state = seed();
    withCars(state, 'a3', ['v1']);
    withCars(state, 'a4', ['v1', 'v2']);
    expect(isValidState(state)).toBe(true);
  });
  test('rejects every malformed selection and conflicting people', () => {
    for (const vehicleIds of BAD_VEHICLE_IDS) {
      const state = seed();
      withCars(state, 'a3', vehicleIds);
      expect(isValidState(state)).toBe(false);
    }
    const state = seed();
    Object.assign(activity(state, 'a3'), { people: ['p2'], vehicleIds: ['v1'] });
    expect(isValidState(state)).toBe(false);
  });
  test('deleting a referenced car invalidates the state until activities are reassigned', () => {
    const state = seed();
    withCars(state, 'a3', ['v1']);
    state.vehicles = state.vehicles.filter(v => v.id !== 'v1');
    expect(isValidState(state)).toBe(false);
    activity(state, 'a3').vehicleIds = ['v2'];
    expect(isValidState(state)).toBe(true);
    delete activity(state, 'a3').vehicleIds;
    expect(isValidState(state)).toBe(true);
  });
});

describe('activityForVehicle', () => {
  test('explicit selection includes only the chosen cars', () => {
    const state = seed();
    const a = withCars(state, 'a3', ['v1']);
    expect(activityForVehicle(state, a, 'v1')).toBe(true);
    expect(activityForVehicle(state, a, 'v2')).toBe(false);
    withCars(state, 'a4', ['v1', 'v2']);
    expect(activityForVehicle(state, activity(state, 'a4'), 'v2')).toBe(true);
  });
  test('legacy empty or full people lists apply to every car', () => {
    const state = seed();
    for (const id of ['a1', 'a5']) for (const v of state.vehicles) expect(activityForVehicle(state, activity(state, id), v.id)).toBe(true);
  });
  test('legacy explicit people intersect with the car driver and passengers', () => {
    const state = seed();
    const coffee = activity(state, 'a6');
    expect(activityForVehicle(state, coffee, 'v1')).toBe(true);
    expect(activityForVehicle(state, coffee, 'v2')).toBe(false);
    const passengerOnly = { ...coffee, people: ['p5'] };
    expect(activityForVehicle(state, passengerOnly, 'v1')).toBe(false);
    expect(activityForVehicle(state, passengerOnly, 'v2')).toBe(true);
  });
  test('legacy explicit people do not match an empty car', () => {
    const state = seed();
    state.vehicles.push({ id: 'v3', name: '空車', driver: '', seats: 4, passengers: [], meeting: '' });
    expect(activityForVehicle(state, activity(state, 'a6'), 'v3')).toBe(false);
    expect(activityForVehicle(state, activity(state, 'a5'), 'v3')).toBe(true);
  });
  test('does not mutate state', () => {
    const state = seed();
    withCars(state, 'a3', ['v1']);
    const before = structuredClone(state);
    for (const a of state.activities) for (const v of state.vehicles) activityForVehicle(state, a, v.id);
    expect(state).toEqual(before);
  });
});

describe('activityForPerson', () => {
  test('selected cars include their driver and passengers only', () => {
    const state = seed();
    const a = withCars(state, 'a3', ['v1']);
    for (const id of ['p1', 'p2', 'p3']) expect(activityForPerson(state, a, id)).toBe(true);
    for (const id of ['p4', 'p5', 'p6']) expect(activityForPerson(state, a, id)).toBe(false);
  });
  test('membership follows the current car roster rather than a stored copy', () => {
    const state = seed();
    const a = withCars(state, 'a3', ['v1']);
    state.vehicles[0].passengers = ['p1'];
    state.vehicles[1].passengers = ['p4', 'p5', 'p3'];
    expect(activityForPerson(state, a, 'p3')).toBe(false);
    expect(activityForPerson(state, a, 'p1')).toBe(true);
  });
  test('people outside every car are not in a car-only activity', () => {
    const state = seed();
    state.vehicles[0].passengers = ['p1'];
    expect(activityForPerson(state, withCars(state, 'a3', ['v1', 'v2']), 'p3')).toBe(false);
  });
  test('legacy empty people means everyone, explicit people stay exact', () => {
    const state = seed();
    for (const p of state.people) expect(activityForPerson(state, activity(state, 'a5'), p.id)).toBe(true);
    expect(activityForPerson(state, activity(state, 'a6'), 'p2')).toBe(true);
    expect(activityForPerson(state, activity(state, 'a6'), 'p1')).toBe(false);
  });
});

describe('activityParticipantLabel', () => {
  test('selected cars show car names, never 全體旅伴', () => {
    const state = seed();
    expect(activityParticipantLabel(state, withCars(state, 'a3', ['v1']))).toBe('山線小巴');
    expect(activityParticipantLabel(state, withCars(state, 'a4', ['v1', 'v2']))).toBe('山線小巴、海風號');
  });
  test('legacy empty or full people show 全體旅伴', () => {
    const state = seed();
    expect(activityParticipantLabel(state, activity(state, 'a5'))).toBe('全體旅伴');
    expect(activityParticipantLabel(state, activity(state, 'a1'))).toBe('全體旅伴');
  });
  test('legacy partial people show names joined with 、', () => {
    const state = seed();
    expect(activityParticipantLabel(state, activity(state, 'a6'))).toBe('阿哲');
    expect(activityParticipantLabel(state, activity(state, 'a2'))).toBe('小安、小雨、米米');
  });
  test('a once-full list stops being 全體旅伴 after someone new joins', () => {
    const state = seed();
    state.people.push({ id: 'p7', name: '新朋友', color: 'coral', role: '' });
    expect(activityParticipantLabel(state, activity(state, 'a1'))).toBe('小安、阿哲、小雨、阿森、米米、大海');
    expect(activityParticipantLabel(state, activity(state, 'a5'))).toBe('全體旅伴');
  });
});

describe('independent car itineraries', () => {
  test('one car reaching camp does not change the other car itinerary', () => {
    const state = seed();
    state.activities.push(
      { id: 'arrive-v1', date: '2026-11-20', time: '16:00', title: '山線小巴抵達營地', type: 'camp', location: '營地', note: '', people: [], vehicleIds: ['v1'], done: false },
      { id: 'arrive-v2', date: '2026-11-20', time: '17:30', title: '海風號抵達營地', type: 'camp', location: '營地', note: '', people: [], vehicleIds: ['v2'], done: false }
    );
    activity(state, 'arrive-v1').done = true;
    expect(isValidState(state)).toBe(true);
    const v2 = state.activities.filter(a => activityForVehicle(state, a, 'v2'));
    expect(v2.map(a => a.id)).toContain('arrive-v2');
    expect(v2.map(a => a.id)).not.toContain('arrive-v1');
    expect(activity(state, 'arrive-v2').done).toBe(false);
    expect(activityForPerson(state, activity(state, 'arrive-v1'), 'p4')).toBe(false);
    expect(activityForPerson(state, activity(state, 'arrive-v2'), 'p4')).toBe(true);
    expect(activityForPerson(state, activity(state, 'a5'), 'p4')).toBe(true);
  });
});

describe('account API round-trip', () => {
  const BASE = 'http://127.0.0.1:5181';
  const PASS = 'correct horse battery';
  let svc, clockMs;
  beforeEach(() => {
    clockMs = Date.parse('2026-11-04T00:00:00Z');
    svc = createAccountService({ dbPath: ':memory:', now: () => clockMs });
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
  async function setup(legacyState = seed()) {
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

  test('legacy import keeps vehicleIds and leaves legacy activities without the field', async () => {
    const legacy = seed();
    withCars(legacy, 'a3', ['v1']);
    const { owner, id } = await setup(legacy);
    const { state } = await getTrip(owner, id);
    expect(activity(state, 'a3').vehicleIds).toEqual(['v1']);
    expect(activity(state, 'a3').people).toEqual([]);
    expect(state.activities.filter(a => 'vehicleIds' in a).map(a => a.id)).toEqual(['a3']);
    expect(isValidState(state)).toBe(true);
  });
  test('legacy states without vehicleIds still import and save unchanged in shape', async () => {
    const { owner, id } = await setup();
    const res = ok(await putState(owner, id, s => { activity(s, 'a6').people = ['p2', 'p3']; }));
    expect(activity(res.body.state, 'a6').people).toEqual(['p2', 'p3']);
    expect(res.body.state.activities.some(a => 'vehicleIds' in a)).toBe(false);
  });
  test('PUT stores vehicleIds and GET returns them', async () => {
    const { owner, id } = await setup();
    ok(await putState(owner, id, s => { withCars(s, 'a3', ['v2', 'v1']); }));
    expect(activity((await getTrip(owner, id)).state, 'a3')).toMatchObject({ people: [], vehicleIds: ['v2', 'v1'] });
  });
  test('malformed selections and conflicting people are rejected atomically', async () => {
    const { owner, id } = await setup();
    for (const vehicleIds of BAD_VEHICLE_IDS) {
      const before = await getTrip(owner, id);
      rejected(await putState(owner, id, s => { s.trip.title = '不應儲存'; withCars(s, 'a4', ['v1']); withCars(s, 'a3', vehicleIds); }), [400]);
      await expectUnchanged(owner, id, before);
    }
    const before = await getTrip(owner, id);
    rejected(await putState(owner, id, s => { Object.assign(activity(s, 'a3'), { people: ['p1'], vehicleIds: ['v1'] }); }), [400]);
    await expectUnchanged(owner, id, before);
  });
  test('a car referenced by an activity cannot be deleted until activities are reassigned', async () => {
    const { owner, id } = await setup();
    ok(await putState(owner, id, s => { withCars(s, 'a3', ['v1']); }));
    const before = await getTrip(owner, id);
    rejected(await putState(owner, id, s => { s.vehicles = s.vehicles.filter(v => v.id !== 'v1'); }), [400]);
    await expectUnchanged(owner, id, before);
    ok(await putState(owner, id, s => { activity(s, 'a3').vehicleIds = ['v2']; }));
    const res = ok(await putState(owner, id, s => { s.vehicles = s.vehicles.filter(v => v.id !== 'v1'); }));
    expect(res.body.state.vehicles.map(v => v.id)).toEqual(['v2']);
    expect(activity(res.body.state, 'a3').vehicleIds).toEqual(['v2']);
  });
  test('unrelated PUT and PATCH edits preserve vehicleIds', async () => {
    const { owner, id } = await setup();
    ok(await putState(owner, id, s => { withCars(s, 'a3', ['v1']); }));
    ok(await putState(owner, id, s => {
      s.trip.title = '新標題';
      activity(s, 'a6').note = '換一包豆子';
      activity(s, 'a3').done = true;
      s.vehicles[1].meeting = '07:30 · 台中高鐵站';
      s.vehicles[0].passengers = ['p1'];
    }));
    const env = await getTrip(owner, id);
    ok(await call('PATCH', `/api/trips/${id}`, { cookie: owner, body: { revision: env.trip.revision, title: '再改一次' } }));
    const { state } = await getTrip(owner, id);
    expect(activity(state, 'a3')).toMatchObject({ people: [], vehicleIds: ['v1'], done: true });
    expect(state.trip.title).toBe('再改一次');
  });
  test('each car itinerary stays independent after one car reaches camp', async () => {
    const legacy = seed();
    legacy.activities.push(
      { id: 'arrive-v1', date: '2026-11-20', time: '16:00', title: '山線小巴抵達營地', type: 'camp', location: '營地', note: '', people: [], vehicleIds: ['v1'], done: false },
      { id: 'arrive-v2', date: '2026-11-20', time: '17:30', title: '海風號抵達營地', type: 'camp', location: '營地', note: '', people: [], vehicleIds: ['v2'], done: false }
    );
    const { owner, id } = await setup(legacy);
    ok(await putState(owner, id, s => { activity(s, 'arrive-v1').done = true; }));
    const { state } = await getTrip(owner, id);
    expect(activity(state, 'arrive-v1')).toMatchObject({ done: true, vehicleIds: ['v1'] });
    expect(activity(state, 'arrive-v2')).toMatchObject({ done: false, vehicleIds: ['v2'] });
    expect(state.activities.filter(a => activityForVehicle(state, a, 'v2')).map(a => a.id)).not.toContain('arrive-v1');
  });
  test('invited members can assign cars but cannot delete a car; outsiders cannot edit', async () => {
    const { owner, member, outsider, id } = await setup();
    ok(await putState(member, id, s => { withCars(s, 'a3', ['v2']); }));
    expect(activity((await getTrip(owner, id)).state, 'a3').vehicleIds).toEqual(['v2']);
    const before = await getTrip(owner, id);
    rejected(await putState(member, id, s => { activity(s, 'a3').vehicleIds = ['v1']; s.vehicles = s.vehicles.filter(v => v.id !== 'v2'); }), [400, 403]);
    await expectUnchanged(owner, id, before);
    rejected(await call('PUT', `/api/trips/${id}`, { cookie: outsider, body: { revision: before.trip.revision, state: before.state } }), [404]);
    await expectUnchanged(owner, id, before);
  });
  test('a stale save cannot overwrite a newer car assignment', async () => {
    const { owner, member, id } = await setup();
    const stale = await getTrip(member, id);
    ok(await putState(owner, id, s => { withCars(s, 'a3', ['v1']); }));
    const state = structuredClone(stale.state);
    delete activity(state, 'a3').vehicleIds;
    activity(state, 'a3').people = ['p4'];
    rejected(await call('PUT', `/api/trips/${id}`, { cookie: member, body: { revision: stale.trip.revision, state } }), [409]);
    expect(activity((await getTrip(owner, id)).state, 'a3')).toMatchObject({ people: [], vehicleIds: ['v1'] });
  });
});
