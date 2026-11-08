import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import fc from 'fast-check';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALERT_RULES,
  INVALID_USERNAME,
  ALL_USERNAMES,
  EVENT_REASONS,
  SECURITY_EVENTS_SCHEMA,
  eventUsername,
  evaluateAlerts,
  formatAlertLine,
  createAlertDispatcher,
  createSecurityEventStore
} from '../server/security-events.js';
import { createAccountService } from '../server/accounts.js';

const WINDOW = 900_000;
const COOLDOWN = 900_000;
const T0 = Date.UTC(2025, 0, 1, 0, 0, 0);

// Wait until queued microtasks and already-settled promise chains have run.
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('security events (pure)', () => {
  test('eventUsername keeps valid usernames and normalizes case and padding', () => {
    expect(eventUsername('alice')).toBe('alice');
    expect(eventUsername('a-b-9')).toBe('a-b-9');
    expect(eventUsername('ALICE')).toBe('alice');
    expect(eventUsername('  Bob-2  ')).toBe('bob-2');
    expect(eventUsername('a'.repeat(32))).toBe('a'.repeat(32));
  });

  test('eventUsername stores out-of-format and non-string input as (invalid)', () => {
    for (const raw of ['', 'ab', '1abc', '-abc', 'a'.repeat(33), 'bad name', 'al_ice', '<script>', 'élise', "' OR 1=1 --"]) {
      expect(eventUsername(raw)).toBe(INVALID_USERNAME);
    }
    for (const raw of [null, undefined, 42, true, {}, ['alice']]) {
      expect(eventUsername(raw)).toBe(INVALID_USERNAME);
    }
  });

  test('formatAlertLine holds type, username, count, and window', () => {
    const line = formatAlertLine({
      kind: 'username', username: 'alice', count: 5, client: '203.0.113.9',
      windowStart: T0, windowEnd: T0 + WINDOW
    });
    expect(line).toBe('security-alert type=username username=alice count=5 window=2025-01-01T00:00:00.000Z..2025-01-01T00:15:00.000Z');

    const global = formatAlertLine({ kind: 'global', username: 'whatever', count: 20, windowStart: T0, windowEnd: T0 + 1000 });
    expect(global).toBe('security-alert type=global username=(all) count=20 window=2025-01-01T00:00:00.000Z..2025-01-01T00:00:01.000Z');
  });

  test('formatAlertLine never writes out-of-format usernames', () => {
    const secret = 'Canary-Secret-Password-1234567890';
    const line = formatAlertLine({ kind: 'username', username: secret, count: 5, windowStart: T0, windowEnd: T0 });
    expect(line).toContain(`username=${INVALID_USERNAME}`);
    expect(line).not.toContain(secret);
    expect(line.toLowerCase()).not.toContain(secret.toLowerCase());
  });

  // Reference model for Requirement 23.6, written independently of evaluateAlerts.
  function referenceAlerts(timeline) {
    const seen = [];
    const last = new Map();
    const out = [];
    for (const event of timeline) {
      seen.push(event);
      const inWindow = seen.filter(item => event.at - item.at < WINDOW);
      const produced = [];
      if (event.username !== INVALID_USERNAME) {
        const count = inWindow.filter(item => item.username === event.username).length;
        const key = `u:${event.username}`;
        if (count >= 5 && (!last.has(key) || event.at - last.get(key) >= COOLDOWN)) {
          produced.push({ kind: 'username', username: event.username, count, at: event.at });
          last.set(key, event.at);
        }
      }
      if (inWindow.length >= 20 && (!last.has('g') || event.at - last.get('g') >= COOLDOWN)) {
        produced.push({ kind: 'global', username: ALL_USERNAMES, count: inWindow.length, at: event.at });
        last.set('g', event.at);
      }
      out.push(produced);
    }
    return out;
  }

  // Drive evaluateAlerts the way the store does: recent events from the window,
  // lastAlertAt updated from the alerts it returned.
  function implementationAlerts(timeline) {
    const seen = [];
    const lastAlertAt = {};
    const out = [];
    for (const event of timeline) {
      seen.push(event);
      const recent = seen.filter(item => item.at > event.at - ALERT_RULES.windowMs);
      const alerts = evaluateAlerts({ event, recent, lastAlertAt: { ...lastAlertAt } });
      for (const alert of alerts) {
        lastAlertAt[alert.kind === 'global' ? 'global' : `username:${alert.username}`] = alert.at;
        expect(alert.windowStart).toBe(event.at - WINDOW);
        expect(alert.windowEnd).toBe(event.at);
        expect(alert.client).toBe(event.client);
      }
      out.push(alerts.map(({ kind, username, count, at }) => ({ kind, username, count, at })));
    }
    return out;
  }

  const timelineArb = fc.array(
    fc.record({
      gap: fc.oneof(
        { weight: 3, arbitrary: fc.constant(0) },
        { weight: 5, arbitrary: fc.integer({ min: 1, max: 60_000 }) },
        { weight: 2, arbitrary: fc.integer({ min: 60_000, max: 1_200_000 }) },
        { weight: 1, arbitrary: fc.constantFrom(WINDOW - 1, WINDOW, WINDOW + 1) }
      ),
      username: fc.constantFrom('alice', 'bob', 'carol', INVALID_USERNAME),
      client: fc.constantFrom('203.0.113.1', '198.51.100.7', '::1')
    }),
    { minLength: 0, maxLength: 120 }
  ).map(items => {
    let at = T0;
    return items.map(({ gap, username, client }) => {
      at += gap;
      return { at, username, client, reason: 'bad_credentials' };
    });
  });

  // Feature: security-hardening, Property 29: Alerts follow thresholds and cooldowns
  test('Property 29: alerts follow thresholds and cooldowns', () => {
    fc.assert(
      fc.property(timelineArb, timeline => {
        expect(implementationAlerts(timeline)).toEqual(referenceAlerts(timeline));
      }),
      { numRuns: 200 }
    );
  });

  test('alert thresholds: 4 events give nothing, the 5th gives one username alert, (invalid) never does', () => {
    const events = [0, 1, 2, 3, 4].map(i => ({ at: T0 + i * 1000, username: 'alice', client: 'c', reason: 'bad_credentials' }));
    expect(evaluateAlerts({ event: events[3], recent: events.slice(0, 4) })).toEqual([]);
    const [alert] = evaluateAlerts({ event: events[4], recent: events });
    expect(alert).toMatchObject({ kind: 'username', username: 'alice', count: 5 });

    const invalid = events.map(item => ({ ...item, username: INVALID_USERNAME }));
    expect(evaluateAlerts({ event: invalid[4], recent: invalid })).toEqual([]);
  });

  const notifierKindArb = fc.constantFrom('return', 'async', 'throw', 'reject', 'never');

  function makeNotifier(kind, index, calls) {
    const fn = alert => {
      calls[index].push(alert);
      if (kind === 'throw') throw new TypeError('boom');
      if (kind === 'reject') return Promise.reject(new RangeError('nope'));
      if (kind === 'never') return new Promise(() => {});
      if (kind === 'async') return Promise.resolve('ok');
      return undefined;
    };
    Object.defineProperty(fn, 'name', { value: `notifier${index}` });
    return fn;
  }

  // Feature: security-hardening, Property 30: Notifiers cannot affect alert storage or each other
  test('Property 30: notifiers cannot affect alert storage or each other', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(notifierKindArb, { minLength: 0, maxLength: 6 }),
        fc.boolean(),
        async (kinds, viaRegister) => {
          const inserted = [];
          const store = {
            insertAlert(alert) {
              const stored = { ...alert, id: `alert-${inserted.length + 1}` };
              inserted.push(stored);
              return stored;
            }
          };
          const lines = [];
          const calls = kinds.map(() => []);
          const notifiers = kinds.map((kind, index) => makeNotifier(kind, index, calls));
          const dispatcher = createAlertDispatcher({ store, log: line => lines.push(line), notifiers: viaRegister ? [] : notifiers });
          if (viaRegister) notifiers.forEach(fn => dispatcher.register(fn));

          const alert = { at: T0, kind: 'username', username: 'alice', client: 'c', count: 5, windowStart: T0 - WINDOW, windowEnd: T0 };
          const stored = dispatcher.dispatch(alert);

          // Stored once, returned synchronously, alert line written, no notifier run yet.
          expect(inserted.length).toBe(1);
          expect(stored).toBe(inserted[0]);
          expect(lines).toEqual([formatAlertLine(stored)]);
          expect(calls.every(list => list.length === 0)).toBe(true);

          await settle();

          calls.forEach(list => {
            expect(list.length).toBe(1);
            expect(list[0]).toBe(stored);
          });
          expect(inserted.length).toBe(1);
          const failures = lines.slice(1);
          const expected = kinds
            .map((kind, index) => (kind === 'throw' ? `notifier=notifier${index} error=TypeError`
              : kind === 'reject' ? `notifier=notifier${index} error=RangeError` : null))
            .filter(Boolean);
          expect(failures.length).toBe(expected.length);
          for (const part of expected) {
            expect(failures.filter(line => line.startsWith('security-alert-notifier-failed') && line.includes(part)).length).toBe(1);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test('a throwing log does not break dispatch, and register rejects non-functions', () => {
    const store = { insertAlert: alert => ({ ...alert, id: 'x' }) };
    const dispatcher = createAlertDispatcher({ store, log: () => { throw new Error('log down'); } });
    expect(() => dispatcher.dispatch({ kind: 'global', username: ALL_USERNAMES, count: 20, windowStart: T0, windowEnd: T0 })).not.toThrow();
    expect(() => dispatcher.register('not a function')).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Service tests: Failed_Login_Events, Security_Alerts, and the admin routes,
// through accounts.handle with the context server/http.js passes in Local_Mode.

describe('security events (service)', () => {
  const LOCAL_BASE = 'http://127.0.0.1:5173';
  const PASS = 'correct horse battery';
  const WRONG = 'wrong horse battery';
  // Canary values: must never reach the Security_Event_Store or the alert log (Req 23.3).
  const CANARY_PW = 'Canary-Pass-Q7v2Lx9Rk4Tz';
  const CANARY_USER = 'Canary_User_M3n8Bq5Wd1';
  const MSG = {
    badJson: 'JSON 格式不正確。',
    notJson: '請以 JSON 格式送出資料。',
    notObject: '資料必須是 JSON 物件。',
    missing: '請輸入帳號與密碼。',
    wrong: '帳號或密碼不正確。',
    limited: '登入失敗次數太多，請 15 分鐘後再試。',
    noAlert: '找不到這個警示，或已經確認過。'
  };
  const MINUTE = 60_000;

  let sNow = Date.parse('2032-05-01T00:00:00.000Z');
  const clock = () => sNow;
  let dir;
  const opened = [];

  function open(name, options = {}) {
    const dbPath = join(dir, `${name}.sqlite`);
    const alertLines = [];
    const service = createAccountService({ dbPath, now: clock, alertLog: line => alertLines.push(line), ...options });
    const raw = new Database(dbPath);
    raw.exec('PRAGMA busy_timeout = 5000;');
    opened.push(service, raw);
    return { service, raw, alertLines };
  }

  function call(service, method, path, { cookie, body, rawBody, type, client = 'sec-default' } = {}) {
    const headers = {};
    if (method !== 'GET') headers.origin = LOCAL_BASE;
    if (cookie) headers.cookie = `ggc_session=${cookie}`;
    const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    if (type !== undefined) { if (type) headers['content-type'] = type; } else if (payload !== undefined) headers['content-type'] = 'application/json';
    const request = new Request(LOCAL_BASE + path, { method, headers, body: payload });
    return service.handle(request, { clientAddress: client, ip: '127.0.0.1' });
  }
  const tokenOf = res => (res.headers.get('set-cookie') || '').match(/^ggc_session=([^;]*)/)?.[1] ?? null;
  const login = (service, username, password, client) => call(service, 'POST', '/api/login', { body: { username, password }, client });

  async function seed(service, admin, users) {
    const setup = await call(service, 'POST', '/api/setup', { body: { username: admin, displayName: admin, password: PASS }, client: 'seed-setup' });
    if (setup.status !== 200) throw new Error(`setup: ${setup.status} ${await setup.text()}`);
    let n = 0;
    for (const username of users) {
      const res = await call(service, 'POST', '/api/register', { body: { username, displayName: username, password: PASS }, client: `seed-${++n}` });
      if (res.status !== 200) throw new Error(`register ${username}: ${res.status} ${await res.text()}`);
    }
    return tokenOf(setup);
  }

  const storeDump = raw => JSON.stringify([
    raw.query('SELECT * FROM security_events').all(),
    raw.query('SELECT * FROM security_alerts').all()
  ]);
  const noCanary = text => {
    const lower = text.toLowerCase();
    for (const canary of [CANARY_PW, CANARY_USER]) expect(lower).not.toContain(canary.toLowerCase());
  };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));

  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'camping-sec-events-')); });
  afterAll(() => {
    for (const item of opened) { try { item.close(); } catch { /* already closed */ } }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the WAL briefly */ }
  });

  // ---- Property 28 ---------------------------------------------------------

  describe('failed-login classification', () => {
    let p;
    beforeAll(async () => {
      p = open('p28');
      await seed(p.service, 'p-admin', ['p-live', 'p-gone']);
      p.raw.query('UPDATE users SET deleted_at = ? WHERE username = ?').run(sNow, 'p-gone');
    });

    // Stored users and their passwords, keyed by the login normalization (trim, lowercase, 64 chars).
    const USERS = { 'p-live': { password: PASS, deleted: false }, 'p-gone': { password: PASS, deleted: true } };
    const PASSWORDS = { correct: PASS, wrong: WRONG, canary: CANARY_PW, empty: '' };

    const nameArb = fc.oneof(
      { weight: 5, arbitrary: fc.constantFrom('p-live', '  P-Live ') },
      { weight: 3, arbitrary: fc.constantFrom('p-gone', 'p-nobody', CANARY_USER) }
    );
    const passwordArb = fc.oneof(
      { weight: 4, arbitrary: fc.constant('wrong') },
      { weight: 1, arbitrary: fc.constantFrom('correct', 'canary', 'empty') }
    );
    const loginArb = fc.record({ kind: fc.constant('login'), username: nameArb, password: passwordArb, client: fc.constantFrom('a', 'b') });
    const requestArb = fc.oneof(
      { weight: 6, arbitrary: loginArb },
      { weight: 1, arbitrary: fc.record({ kind: fc.constantFrom('badJson', 'textPlain', 'array'), client: fc.constantFrom('a', 'b') }) },
      {
        weight: 1,
        arbitrary: fc.record({
          kind: fc.constant('nonString'),
          username: fc.constantFrom('p-live', ' P-GONE', CANARY_USER, undefined, 42),
          client: fc.constantFrom('a', 'b')
        })
      }
    );
    // A burst run reaches the per-username limit: five failures for p-live, then one more request.
    const burstArb = fc.tuple(
      fc.constantFrom('p-live', '  P-Live '),
      fc.constantFrom('wrong', 'canary', 'empty'),
      fc.oneof({ weight: 3, arbitrary: loginArb.map(r => ({ ...r, username: 'p-live' })) }, { weight: 1, arbitrary: requestArb })
    ).map(([username, password, last]) => [
      ...Array.from({ length: 5 }, (_, i) => ({ kind: 'login', username, password, client: i % 2 ? 'a' : 'b' })),
      last
    ]);
    const runArb = fc.oneof({ weight: 2, arbitrary: fc.array(requestArb, { minLength: 1, maxLength: 6 }) }, { weight: 1, arbitrary: burstArb });

    function send(req, client) {
      if (req.kind === 'badJson') return call(p.service, 'POST', '/api/login', { rawBody: '{"username":', client });
      if (req.kind === 'textPlain') return call(p.service, 'POST', '/api/login', { rawBody: JSON.stringify({ username: 'p-live', password: PASS }), type: 'text/plain', client });
      if (req.kind === 'array') return call(p.service, 'POST', '/api/login', { rawBody: '[]', client });
      if (req.kind === 'nonString') return call(p.service, 'POST', '/api/login', { body: { username: req.username, password: 12345 }, client });
      return login(p.service, req.username, PASSWORDS[req.password], client);
    }

    // Reference model: expected response and expected event (or null) per request.
    function model(req, state, client, now) {
      const invalid = (status, error, username = null) => ({ status, body: { error }, event: { at: now, client, username: eventUsername(username), reason: 'invalid_input' } });
      if (req.kind === 'badJson') return invalid(400, MSG.badJson);
      if (req.kind === 'textPlain') return invalid(415, MSG.notJson);
      if (req.kind === 'array') return invalid(400, MSG.notObject);
      if (req.kind === 'nonString') return invalid(400, MSG.missing, req.username);
      const key = req.username.trim().toLowerCase().slice(0, 64);
      const entry = state.get(key);
      if (entry && entry.count >= 5) {
        const first = !entry.noted;
        entry.noted = true;
        return {
          status: 429, body: { error: MSG.limited }, retryAfter: Math.max(1, Math.ceil((entry.firstAt + 15 * MINUTE - now) / 1000)),
          event: first ? { at: now, client, username: eventUsername(req.username), reason: 'rate_limited' } : null
        };
      }
      const user = USERS[key];
      const password = PASSWORDS[req.password];
      const ok = !!user && password !== '' && password === user.password;
      if (ok && !user.deleted) {
        state.delete(key);
        return { status: 200, session: true, event: null };
      }
      if (entry) entry.count++; else state.set(key, { count: 1, firstAt: now, noted: false });
      return {
        status: 401, body: { error: MSG.wrong },
        event: { at: now, client, username: eventUsername(req.username), reason: ok && user.deleted ? 'deleted_account' : 'bad_credentials' }
      };
    }

    let runNo = 0;
    const reasonsSeen = new Set();

    // Feature: security-hardening, Property 28: Each failed login is classified once without secrets
    test('Property 28: each failed login is classified once without secrets', async () => {
      await fc.assert(
        fc.asyncProperty(runArb, async requests => {
          // Step past every limiter window so each run starts from empty limiter state.
          sNow += 16 * MINUTE;
          runNo++;
          const lastId = p.raw.query('SELECT COALESCE(MAX(id), 0) AS n FROM security_events').get().n;
          const state = new Map();
          const expectedEvents = [];
          for (const req of requests) {
            sNow += 1000;
            const client = `p28-${runNo}-${req.client}`;
            const expected = model(req, state, client, sNow);
            const res = await send(req, client);
            expect(res.status).toBe(expected.status);
            if (expected.session) {
              expect(tokenOf(res)).toMatch(/^[0-9a-f]{64}$/);
            } else {
              expect(res.headers.get('set-cookie')).toBeNull();
              expect(await res.json()).toEqual(expected.body);
            }
            if (expected.status === 429) expect(res.headers.get('retry-after')).toBe(String(expected.retryAfter));
            else expect(res.headers.get('retry-after')).toBeNull();
            if (expected.event) expectedEvents.push(expected.event);
          }
          const rows = p.raw.query('SELECT at, client, username, reason FROM security_events WHERE id > ? ORDER BY id').all(lastId);
          expect(rows).toEqual(expectedEvents);
          for (const row of rows) reasonsSeen.add(row.reason);
          noCanary(storeDump(p.raw));
          noCanary(p.alertLines.join('\n'));
        }),
        {
          numRuns: 100,
          // deleted_account needs p-gone with the correct password (~0.6% of generated logins), so one
          // fixed example guarantees the reason is exercised instead of relying on the random sample.
          examples: [[[{ kind: 'login', username: 'p-gone', password: 'correct', client: 'a' }]]]
        }
      );
      // The generators reached every reason at least once.
      expect([...reasonsSeen].sort()).toEqual([...EVENT_REASONS].sort());
    }, 120_000);

    test('rate_limited is written once per blocked key per window, with the same 429 each time', async () => {
      sNow += 16 * MINUTE;
      const lastId = p.raw.query('SELECT COALESCE(MAX(id), 0) AS n FROM security_events').get().n;
      for (let i = 0; i < 5; i++) { sNow += 1000; expect((await login(p.service, 'p-live', WRONG, `rl-${i}`)).status).toBe(401); }
      const blocked = [];
      for (let i = 0; i < 3; i++) {
        sNow += 1000;
        const res = await login(p.service, 'p-live', i === 1 ? PASS : WRONG, `rl-b-${i}`);
        blocked.push({ status: res.status, body: await res.json() });
      }
      expect(blocked).toEqual(Array(3).fill({ status: 429, body: { error: MSG.limited } }));
      const reasons = p.raw.query('SELECT reason FROM security_events WHERE id > ? ORDER BY id').all(lastId).map(r => r.reason);
      expect(reasons).toEqual([...Array(5).fill('bad_credentials'), 'rate_limited']);
    });
  });

  // ---- Retention (Req 23.4) ------------------------------------------------

  test('the service keeps only the newest events under lowered caps and leaves audit unchanged', async () => {
    const r = open('retention', { securityEventLimits: { maxEvents: 3, maxAlerts: 2 } });
    await seed(r.service, 'r-admin', []);
    const auditBefore = r.raw.query('SELECT * FROM audit ORDER BY id').all();
    for (let i = 0; i < 8; i++) {
      sNow += 1000;
      expect((await call(r.service, 'POST', '/api/login', { rawBody: '{', client: `ret-${i}` })).status).toBe(400);
    }
    const rows = r.raw.query('SELECT client FROM security_events ORDER BY id').all().map(row => row.client);
    expect(rows).toEqual(['ret-5', 'ret-6', 'ret-7']);
    expect(r.raw.query('SELECT * FROM audit ORDER BY id').all()).toEqual(auditBefore);
  });

  test('alert retention removes acknowledged alerts before unacknowledged ones, oldest first', () => {
    const db = new Database(':memory:');
    db.exec(SECURITY_EVENTS_SCHEMA);
    const store = createSecurityEventStore(db, clock, { maxEvents: 100, maxAlerts: 2 });
    const add = at => store.insertAlert({ at, kind: 'global', username: ALL_USERNAMES, client: 'c', count: 20, windowStart: at - WINDOW, windowEnd: at });
    const a1 = add(1000), a2 = add(2000), a3 = add(3000);
    expect(store.acknowledge(a2.id, 'admin', 3500)).toBe(true);
    store.trim();
    const ids = () => db.query('SELECT id FROM security_alerts ORDER BY at').all().map(row => row.id);
    expect(ids()).toEqual([a1.id, a3.id]);
    const a4 = add(4000);
    store.trim();
    expect(ids()).toEqual([a3.id, a4.id]);
    db.close();
  });

  // ---- Admin routes (Req 23.8, 23.10, 23.11, 23.14) -------------------------

  describe('admin security routes', () => {
    let s, adminToken;
    beforeAll(async () => {
      s = open('admin');
      adminToken = await seed(s.service, 's-admin', ['alice-sec']);
    });
    const getSecurity = () => call(s.service, 'GET', '/api/admin/security', { cookie: adminToken });
    const ack = id => call(s.service, 'POST', `/api/admin/security/alerts/${id}/acknowledge`, { cookie: adminToken, body: {} });
    const auditRows = () => s.raw.query("SELECT actor, action, target FROM audit WHERE action = 'security.alert.ack' ORDER BY id").all();
    let userAlertId, globalAlertId;

    test('GET /api/admin/security returns alerts and the 200 newest events, newest first', async () => {
      const empty = await (await getSecurity()).json();
      expect(empty).toEqual({ unacknowledged: 0, alerts: [], events: [] });

      sNow += 16 * MINUTE;
      for (let i = 0; i < 5; i++) { sNow += 1000; expect((await login(s.service, 'alice-sec', WRONG, 'client-alice')).status).toBe(401); }
      const userAlertAt = sNow;
      // 200 more cheap invalid_input events; the 15th brings the window to 20 and creates the global alert.
      let globalAlertAt;
      for (let i = 0; i < 200; i++) {
        sNow += 1000;
        if (i === 14) globalAlertAt = sNow;
        expect((await call(s.service, 'POST', '/api/login', { rawBody: '{', client: `flood-${i}` })).status).toBe(400);
      }

      const res = await getSecurity();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.unacknowledged).toBe(2);
      expect(data.alerts.length).toBe(2);
      for (const alert of data.alerts) {
        expect(Object.keys(alert).sort()).toEqual(['at', 'client', 'count', 'id', 'kind', 'username', 'windowEnd', 'windowStart']);
      }
      const [global, user] = data.alerts;
      expect(global).toMatchObject({
        kind: 'global', username: ALL_USERNAMES, client: 'flood-14', count: 20,
        at: new Date(globalAlertAt).toISOString(), windowStart: new Date(globalAlertAt - WINDOW).toISOString(), windowEnd: new Date(globalAlertAt).toISOString()
      });
      expect(user).toMatchObject({
        kind: 'username', username: 'alice-sec', client: 'client-alice', count: 5,
        at: new Date(userAlertAt).toISOString(), windowStart: new Date(userAlertAt - WINDOW).toISOString(), windowEnd: new Date(userAlertAt).toISOString()
      });
      userAlertId = user.id;
      globalAlertId = global.id;

      expect(data.events.length).toBe(200);
      expect(data.events[0]).toEqual({ at: new Date(sNow).toISOString(), username: INVALID_USERNAME, client: 'flood-199', reason: 'invalid_input' });
      for (const event of data.events) expect(Object.keys(event).sort()).toEqual(['at', 'client', 'reason', 'username']);
      const times = data.events.map(event => Date.parse(event.at));
      expect(times).toEqual([...times].sort((a, b) => b - a));
      // The five alice events are the oldest of 205 and fall outside the newest 200.
      expect(data.events.some(event => event.username === 'alice-sec')).toBe(false);
    });

    test('acknowledging an alert marks it, writes one audit row, and lowers the count', async () => {
      sNow += 1000;
      const res = await ack(userAlertId);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ acknowledged: true, unacknowledged: 1 });
      expect(auditRows()).toEqual([{ actor: 's-admin', action: 'security.alert.ack', target: `alert:${userAlertId}` }]);
      const row = s.raw.query('SELECT acknowledged_at, acknowledged_by FROM security_alerts WHERE id = ?').get(userAlertId);
      expect(row).toEqual({ acknowledged_at: sNow, acknowledged_by: 's-admin' });
      const data = await (await getSecurity()).json();
      expect(data.unacknowledged).toBe(1);
      expect(data.alerts.map(alert => alert.id)).toEqual([globalAlertId]);
    });

    test('repeated, unknown, and malformed alert IDs get 404 with no audit row and no change', async () => {
      const before = s.raw.query('SELECT * FROM security_alerts ORDER BY id').all();
      for (const id of [userAlertId, '00000000-0000-4000-8000-000000000000', 'bad%20id', 'x'.repeat(65)]) {
        const res = await ack(id);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: MSG.noAlert });
      }
      expect(auditRows().length).toBe(1);
      expect(s.raw.query('SELECT * FROM security_alerts ORDER BY id').all()).toEqual(before);
    });
  });

  // ---- Write failure (Req 23.15) --------------------------------------------

  test('a failed event write keeps the login response and writes one log line', async () => {
    const w = open('write-failure');
    await seed(w.service, 'w-admin', ['w-user']);
    sNow += 16 * MINUTE;
    const snap = async res => ({
      status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie'),
      headers: [...res.headers.keys()].sort()
    });
    const normalWrong = await snap(await login(w.service, 'w-user', WRONG, 'w-1'));
    const normalBad = await snap(await call(w.service, 'POST', '/api/login', { rawBody: '{', client: 'w-1' }));
    expect(w.raw.query('SELECT COUNT(*) AS n FROM security_events').get().n).toBe(2);

    w.raw.exec('DROP TABLE security_events');
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    let failedWrong, failedBad;
    try {
      failedWrong = await snap(await login(w.service, 'w-user', CANARY_PW, 'w-2'));
      failedBad = await snap(await call(w.service, 'POST', '/api/login', { rawBody: '{', client: 'w-2' }));
    } finally {
      console.error = original;
    }
    expect(failedWrong).toEqual(normalWrong);
    expect(failedBad).toEqual(normalBad);
    expect(normalWrong.cookie).toBeNull();
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line).toContain('POST /api/login');
      noCanary(line);
    }
    // The login itself still works.
    expect((await login(w.service, 'w-user', PASS, 'w-3')).status).toBe(200);
  });

  // ---- Notifiers (Req 23.16–23.18) -------------------------------------------

  test('throwing and never-resolving notifiers do not change the login response or block a later notifier', async () => {
    const n = open('notifiers');
    await seed(n.service, 'n-admin', ['n-user']);
    sNow += 16 * MINUTE;
    const recorded = [];
    function throwingNotifier() { throw new TypeError('notifier down'); }
    function neverNotifier() { return new Promise(() => {}); }
    function recordingNotifier(alert) { recorded.push(alert); }
    n.service.registerAlertNotifier(throwingNotifier);
    n.service.registerAlertNotifier(neverNotifier);
    n.service.registerAlertNotifier(recordingNotifier);

    const responses = [];
    for (let i = 0; i < 5; i++) {
      sNow += 1000;
      const res = await login(n.service, 'n-user', WRONG, `n-${i}`);
      responses.push({ status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie') });
    }
    expect(responses).toEqual(Array(5).fill({ status: 401, body: { error: MSG.wrong }, cookie: null }));

    const stored = n.raw.query('SELECT * FROM security_alerts').all();
    expect(stored.length).toBe(1);
    expect(stored[0]).toMatchObject({ kind: 'username', username: 'n-user', count: 5, client: 'n-4', acknowledged_at: null });

    await tick();
    expect(recorded.length).toBe(1);
    expect(recorded[0]).toMatchObject({ id: stored[0].id, kind: 'username', username: 'n-user', count: 5 });
    expect(n.alertLines).toEqual([
      formatAlertLine(recorded[0]),
      'security-alert-notifier-failed notifier=throwingNotifier error=TypeError'
    ]);

    await tick();
    expect(recorded.length).toBe(1);
  });
});
