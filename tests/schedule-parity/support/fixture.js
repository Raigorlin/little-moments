// Comparison_Fixture loaders for the schedule-tab-css-parity spec (design section 6.1, Requirement 7.1).
//
// - comparisonFixture(): exampleTrip() with a fourth empty day, a done activity with a location and note, one
//   unassigned shared gear item and one purchased ingredient item, so that every Selector_Map state has content.
// - fakeBunAccount(page, state): serves that Trip_State to Bun_App through page.route (as tests/storybook-account.e2e.js).
// - loadLmTrip(request, state): writes the same trip into LM_Server through its API with lm_core::command::Command
//   values, checks the snapshot entity counts, and returns the Trip_Page path and the Session.
// - beforeAllServersReachable(test): a beforeAll that fails with the URL that did not answer.
import { randomUUID } from 'node:crypto';
import { exampleTrip } from '../../fixtures/example-trip.js';
import { DESTINATION_REF } from '../../../src/itinerary-model.js';

const trimSlash = url => String(url).replace(/\/+$/, '');
export const BUN_BASE_URL = trimSlash(process.env.BUN_BASE_URL || 'http://127.0.0.1:5173');
export const LM_BASE_URL = trimSlash(process.env.LM_BASE_URL || 'http://127.0.0.1:8081');

/** The Bun Trip_Page of the fake account, relative to BUN_BASE_URL. */
export const BUN_TRIP_PATH = '/qa-user/trips/qa-trip';
export const BUN_SCHEDULE_PATH = `${BUN_TRIP_PATH}?tab=schedule`;
/** localStorage key where LM_Web keeps its Session (crates/web/src/session.rs STORAGE_KEY). */
export const LM_SESSION_KEY = 'lm.session.v1';

export const BUN_USER = { id: 'qa-user-id', username: 'qa-user', displayName: '隔離測試', role: 'member' };
const OWNER_CAPS = { canEdit: true, canDelete: true, canInvite: true, canManage: true, personId: 'p1' };

/** The fourth day added by comparisonFixture(); it has no activities, routes or meals (state S4). */
export const EMPTY_DAY = '2026-10-23';

/** The counts loadLmTrip() checks in the LM snapshot (design section 6.1). */
export const EXPECTED_COUNTS = Object.freeze({
  people: 8, vehicles: 4, places: 6, routes: 8, activities: 10, meals: 5, unassignedGear: 1
});

/** A new Comparison_Fixture Trip_State on every call (design section 6.1). */
export function comparisonFixture() {
  const state = exampleTrip();
  state.trip.endDate = EMPTY_DAY;
  const a1 = state.activities.find(activity => activity.id === 'a1');
  Object.assign(a1, { done: true, location: '夕淞度日營區 A 區', note: '先搭客廳帳，再搭睡帳。' });
  state.gear.push({ id: 'g1', name: '營燈', quantity: '2 盞', scope: 'shared', assignee: '', ready: [] });
  state.shopping[state.shopping.length - 1].done = true; // s18 熱狗
  for (const item of state.shopping) if (!item.assignee && !item.quantity) item.quantity = '數量待確認';
  return state;
}

// ── Bun_App ──

/**
 * Serves `state` to Bun_App for the page: `/api/session` returns the QA user, `GET /api/trips/qa-trip` returns the
 * state with owner capabilities, and every other `/api/**` request gets a JSON 404. Open BUN_SCHEDULE_PATH afterwards.
 */
export async function fakeBunAccount(page, state) {
  const revision = 3;
  const served = structuredClone({ ...state, revision });
  const trip = {
    id: 'qa-trip', revision, title: served.trip.title, destination: served.trip.destination,
    startDate: served.trip.startDate, endDate: served.trip.endDate
  };
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const reply = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/session') return reply(200, { user: BUN_USER });
    if (path === '/api/trips/qa-trip' && request.method() === 'GET') {
      return reply(200, { state: structuredClone(served), trip, permissions: OWNER_CAPS });
    }
    return reply(404, { error: '此測試未模擬該 API' });
  });
  return { url: BUN_SCHEDULE_PATH, user: BUN_USER };
}

// ── LM_Server ──

const nullable = value => (value ? value : null);

/** Fails with the request, the response status and the body. */
async function expectOk(response, what) {
  if (response.ok()) return response.json();
  const body = await response.text().catch(() => '<unreadable body>');
  throw new Error(`${what} failed: HTTP ${response.status()} ${body}`);
}

/** Entity counts of an LM `GET /api/trips/{id}/snapshot` body (rows are `{entity, row}`). */
export function snapshotCounts(snapshot) {
  const rows = snapshot.rows || [];
  const count = entity => rows.filter(r => r.entity === entity).length;
  return {
    people: count('person'), vehicles: count('vehicle'), places: count('place'), routes: count('route'),
    activities: count('activity'), meals: count('meal'),
    unassignedGear: rows.filter(r => r.entity === 'gear' && r.row.scope === 'shared' && r.row.assignee == null).length
  };
}

/**
 * Writes `state` (a Comparison_Fixture) into LM_Server as a new trip of a fresh account and returns
 * `{path, schedulePath, tripId, session, ids}`. `path` is the Trip_Page path; store `session` in
 * localStorage[LM_SESSION_KEY] through addInitScript. `ids` maps the fixture ids to the LM UUIDs.
 *
 * `request` is a Playwright APIRequestContext; URLs are absolute on LM_BASE_URL.
 */
export async function loadLmTrip(request, state) {
  const api = path => `${LM_BASE_URL}/api${path}`;
  const username = `parity-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const signup = await expectOk(await request.post(api('/auth/signup'), {
    data: { username, display_name: '隔離測試', password: `parity-${randomUUID()}` }
  }), 'POST /api/auth/signup');
  const { trip_id: _tripId, ...session } = signup;
  const headers = { Authorization: `Bearer ${session.access_token}` };

  const tripId = randomUUID();
  const t = state.trip;
  await expectOk(await request.post(api('/trips'), {
    headers,
    data: {
      id: tripId, title: t.title, destination: t.destination, start: t.startDate, end: t.endDate,
      description: t.description, note: t.note, cover: 'camp'
    }
  }), 'POST /api/trips');

  const readSnapshot = async () =>
    expectOk(await request.get(api(`/trips/${tripId}/snapshot`), { headers }), `GET /api/trips/${tripId}/snapshot`);

  // Fixture id → LM UUID. The owner's Person (created with the trip) stands for the fixture's currentUser.
  const ids = new Map();
  const uuid = id => {
    if (!ids.has(id)) ids.set(id, randomUUID());
    return ids.get(id);
  };
  const creator = (await readSnapshot()).rows.find(r => r.entity === 'person');
  if (!creator) throw new Error('the new LM trip has no owner Person in its snapshot');
  ids.set(state.currentUser, creator.row.id);
  const placeRef = ref => (ref === DESTINATION_REF ? { kind: 'destination' } : { kind: 'place', id: uuid(ref) });
  const person = id => (id ? uuid(id) : null);

  let index = 0;
  const send = async command => {
    const at = index++;
    const response = await request.post(api(`/trips/${tripId}/commands`), {
      headers, data: { command_id: randomUUID(), command }
    });
    if (!response.ok()) {
      const body = await response.text().catch(() => '<unreadable body>');
      throw new Error(`command #${at} (${command.type}) failed: HTTP ${response.status()} ${body}\n${JSON.stringify(command)}`);
    }
    return response.json();
  };

  // People: the owner first (rename and recolor), then the others in fixture order.
  for (const p of state.people) {
    if (p.id === state.currentUser) {
      await send({ type: 'update_person', id: uuid(p.id), patch: { name: p.name, role: p.role, color: p.color } });
    } else {
      await send({ type: 'add_person', id: uuid(p.id), name: p.name, role: p.role, color: p.color });
    }
  }
  for (const v of state.vehicles) {
    await send({
      type: 'add_vehicle', id: uuid(v.id),
      draft: { name: v.name, driver: person(v.driver), seats: v.seats, color: null, passengers: v.passengers.map(uuid) }
    });
  }
  for (const pl of state.places) await send({ type: 'add_place', id: uuid(pl.id), name: pl.name });
  for (const r of state.routes) {
    await send({
      type: 'save_route',
      route: {
        id: uuid(r.id), day: r.date, vehicle: uuid(r.vehicleId), from: placeRef(r.from), to: placeRef(r.to),
        depart: nullable(r.time),
        stops: (r.stops || []).map(s => ({
          id: uuid(s.id), place: placeRef(s.place), kind: s.kind, note: s.note || '', time: nullable(s.time)
        }))
      }
    });
  }
  for (const d of state.daySettings) {
    const patch = {};
    if (d.title) patch.title = d.title;
    if (d.place) patch.place = uuid(d.place);
    if (d.arrival) patch.arrival = d.arrival;
    await send({ type: 'save_day_setting', day: d.date, patch });
  }
  for (const a of state.activities) {
    const who = a.people?.length ? { mode: 'people', ids: a.people.map(uuid) }
      : a.vehicleIds?.length ? { mode: 'vehicles', ids: a.vehicleIds.map(uuid) } : { mode: 'everyone' };
    await send({
      type: 'add_activities', day: a.date,
      items: [{ id: uuid(a.id), time: a.time, title: a.title, kind: a.type, location: a.location, note: a.note, who }]
    });
    if (a.done) await send({ type: 'set_activity_done', id: uuid(a.id), done: true });
  }
  // Manual shopping items go before the meals, so that their ordinals precede the ingredient items that the
  // server's shopping sync adds for the meals, as in the fixture's shopping order (s1–s8, then s9–s18).
  const manual = state.shopping.filter(item => item.source !== 'meal');
  for (const item of manual) {
    await send({
      type: 'add_shopping_item', id: uuid(item.id),
      draft: { name: item.name, quantity: item.quantity, category: item.category, assignee: person(item.assignee) }
    });
    if (item.done) await send({ type: 'set_shopping_purchased', id: uuid(item.id), purchased: true });
  }
  for (const m of state.meals) {
    await send({
      type: 'add_meal', id: uuid(m.id),
      draft: {
        day: m.date, slot: m.slot, time: nullable(m.time), title: m.title, cook: person(m.cookId),
        servings: m.servings, ingredients: m.ingredients, notes: m.notes
      }
    });
  }
  // Ingredient items: the server created them with its own ids; match them by name and apply the fixture's changes.
  const synced = (await readSnapshot()).rows.filter(r => r.entity === 'shopping' && r.row.source === 'meal');
  for (const item of state.shopping.filter(i => i.source === 'meal')) {
    const row = synced.find(r => r.row.name === item.name)?.row;
    if (!row) throw new Error(`LM shopping sync did not create the ingredient item 「${item.name}」 (${item.id})`);
    ids.set(item.id, row.id);
    const patch = {};
    if (item.quantity !== row.quantity) patch.quantity = item.quantity;
    if (item.category !== row.category) patch.category = item.category;
    if (person(item.assignee) !== (row.assignee ?? null)) patch.assignee = person(item.assignee);
    if (Object.keys(patch).length) await send({ type: 'update_shopping_item', id: row.id, patch });
    if (item.done && !row.purchased) await send({ type: 'set_shopping_purchased', id: row.id, purchased: true });
  }
  for (const g of state.gear) {
    await send({
      type: 'add_gear', id: uuid(g.id),
      draft: { name: g.name, quantity: g.quantity, scope: g.scope, assignee: person(g.assignee) }
    });
  }

  const actual = snapshotCounts(await readSnapshot());
  const wrong = Object.keys(EXPECTED_COUNTS).filter(key => actual[key] !== EXPECTED_COUNTS[key]);
  if (wrong.length) {
    throw new Error(`LM snapshot entity counts differ: expected ${JSON.stringify(EXPECTED_COUNTS)}, actual ${JSON.stringify(actual)}`);
  }

  const path = `/${username}/trips/${tripId}`;
  return { path, schedulePath: `${path}?tab=schedule`, tripId, session, ids: Object.fromEntries(ids) };
}

// ── Reachability ──

/** Throws with every URL in `urls` that did not answer an HTTP request within `timeout` ms. */
export async function assertReachable(urls = [BUN_BASE_URL, LM_BASE_URL], timeout = 5000) {
  const failures = [];
  for (const url of urls) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'manual' });
    } catch (error) {
      failures.push(`${url} (${error?.cause?.code || error?.name || error})`);
    }
  }
  if (failures.length) throw new Error(`unreachable: ${failures.join(', ')}`);
}

/** Registers a beforeAll on `test` (from @playwright/test) that fails with the unreachable URL. */
export function beforeAllServersReachable(test, urls = [BUN_BASE_URL, LM_BASE_URL]) {
  test.beforeAll(async () => assertReachable(urls));
}
