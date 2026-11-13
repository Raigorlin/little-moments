// The create-smoke-account CLI and provisionSmokeAccount (Requirement 27.2–27.16; design.md Components §21.2–21.3,
// Testing Strategy「Smoke_Account 佈建（Req 27）」). runCreateSmokeAccount is driven with injected argv, env, stdin
// and prompts against a PostgreSQL Ephemeral_Database (CAMPING_TEST_DATABASE_*, tests/support/pg.js): the CLI reads
// the connection from CAMPING_DATABASE_* built from the test config, and poolOptions points its pool at the test
// schema. Requirement 27 has no Correctness Property; the 16 initial states are enumerated instead.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError, SMOKE_DISPLAY_NAME, createAccountService, hashPassword, validateFixtureTitle, verifyPassword } from '../server/accounts.js';
import { createHttpHandler } from '../server/http.js';
import { insertUser } from '../server/db/queries.js';
import { isValidState } from '../src/model.js';
import { PASSWORD_MISMATCH } from '../scripts/account-cli.mjs';
import { DEFAULT_FIXTURE, DEFAULT_USERNAME, REASONS, USAGE, runCreateSmokeAccount } from '../scripts/create-smoke-account.mjs';
import { SMOKE_FIXTURE_DATES, runSmoke } from '../scripts/smoke.mjs';
import { FIXTURE_DATES } from '../scripts/drill.mjs';
import { resetTables, serviceDb, testQuery, useTestDatabase } from './support/pg.js';

const PASS = 'smoke placeholder pass 01';
const EXISTING_PASS = 'existing placeholder pass 02';
const BASE = 'http://127.0.0.1:5173';
const db = useTestDatabase();
let svc, existingHash;

beforeAll(async () => {
  svc = await createAccountService({ db: serviceDb(db.sql), alertLog: () => {} });
  existingHash = await hashPassword(EXISTING_PASS);
});
afterAll(() => svc?.close());
beforeEach(async () => { await resetTables(db.sql); });

/** CAMPING_DATABASE_* for the test database, as the CLI reads them on the Deploy_Host. */
function pgEnv(extra = {}) {
  const c = db.config;
  return {
    CAMPING_DATABASE_HOST: c.host, CAMPING_DATABASE_PORT: String(c.port), CAMPING_DATABASE_NAME: c.name,
    CAMPING_DATABASE_USER: c.user, CAMPING_DATABASE_PASSWORD: c.password, CAMPING_DATABASE_SSLMODE: c.sslmode, ...extra
  };
}

/** A prompt that answers from a queue and records each question. */
function queue(answers) {
  const asked = [];
  const fn = mock(async question => {
    asked.push(question);
    if (answers.length === 0) throw new Error('Input ended.');
    return answers.shift();
  });
  fn.asked = asked;
  return fn;
}

function run({ argv = [], env = pgEnv(), isTTY = false, input = `${PASS}\n`, hidden = [], ...rest } = {}) {
  const out = [], err = [];
  const promptHidden = queue([...hidden]);
  const readInput = mock(async () => (Buffer.isBuffer(input) ? input : Buffer.from(input)));
  const promise = runCreateSmokeAccount({
    argv, env, isTTY, promptHidden, readInput, poolOptions: { connection: db.sessionParams },
    out: (...a) => out.push(a.join(' ')), err: (...a) => err.push(a.join(' ')), ...rest
  });
  return { promise, out, err, promptHidden, readInput };
}

/** stdout carries exactly one JSON line (Req 27.15). */
function line(r) {
  expect(r.out).toHaveLength(1);
  expect(r.out[0]).not.toContain('\n');
  return JSON.parse(r.out[0]);
}

function expectNoSecrets(r) {
  const text = [...r.out, ...r.err].join('\n');
  for (const secret of [PASS, EXISTING_PASS, 'scrypt$', 'ggc_session', db.config.password]) expect(text).not.toContain(secret);
}

async function tables() {
  return {
    users: await testQuery(db.sql, 'SELECT * FROM users ORDER BY id'),
    sessions: await testQuery(db.sql, 'SELECT * FROM sessions ORDER BY token_hash'),
    trips: await testQuery(db.sql, 'SELECT * FROM trips ORDER BY id'),
    trip_members: await testQuery(db.sql, 'SELECT * FROM trip_members ORDER BY trip_id, user_id'),
    audit: await testQuery(db.sql, 'SELECT * FROM audit ORDER BY id')
  };
}
const KEYS = { users: r => r.id, sessions: r => r.token_hash, trips: r => r.id, trip_members: r => `${r.trip_id}/${r.user_id}`, audit: r => String(r.id) };
/** Rows added between two snapshots; every earlier row must still be present and unchanged. */
function added(before, after) {
  const result = {};
  for (const [table, key] of Object.entries(KEYS)) {
    const now = new Map(after[table].map(r => [key(r), r]));
    for (const row of before[table]) expect(now.get(key(row))).toEqual(row);
    const old = new Set(before[table].map(key));
    result[table] = after[table].filter(r => !old.has(key(r)));
  }
  return result;
}

async function call(method, path, { cookie, body } = {}) {
  const headers = { origin: BASE };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await svc.handle(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
async function login(username, password) {
  const r = await call('POST', '/api/login', { body: { username, password } });
  expect(r.status).toBe(200);
  return r.cookie;
}
async function createTripAs(cookie, title) {
  const r = await call('POST', '/api/trips', { cookie, body: { title, ...SMOKE_FIXTURE_DATES } });
  expect(r.status).toBe(201);
  return r.body.trip;
}
const insertAdmin = () => insertUser(db.sql, 'u-owner', 'owner', 'Owner', 'admin', existingHash, Date.now());

describe('用法與設定錯誤（Req 27.2、27.5）', () => {
  const cases = [
    ['--password x', ['--password', 'x']],
    ['--password=x', [`--password=${PASS}`]],
    ['--username=value', ['--username=smoke-bot']],
    ['unknown option', ['--display-name', 'Smoke Bot']],
    ['positional argument', ['smoke-bot']],
    ['--help with other arguments', ['--help', '--username', 'smoke-bot']],
    ['option without a value', ['--fixture']],
    ['repeated option', ['--username', 'smoke-bot', '--username', 'smoke-two']],
    ['uppercase username', ['--username', 'Smoke-Bot']],
    ['reserved username', ['--username', 'admin']],
    ['too short username', ['--username', 'ab']],
    ['username with surrounding space', ['--username', ' smoke-bot']],
    ['fixture with leading space', ['--fixture', ' smoke-fixture']],
    ['fixture with trailing space', ['--fixture', 'smoke-fixture ']],
    ['empty fixture', ['--fixture', '']],
    ['101-character fixture', ['--fixture', 'f'.repeat(101)]],
    ['fixture with U+0000', ['--fixture', 'smoke\u0000fixture']]
  ];
  test.each(cases)('%s → exit 2 before connecting', async (_, argv) => {
    const openService = mock(() => { throw new Error('should not open'); });
    const r = run({ argv, openService });
    expect(await r.promise).toBe(2);
    expect(line(r)).toEqual({ ok: false, reason: 'usage' });
    expect(openService).not.toHaveBeenCalled();
    expect(r.readInput).not.toHaveBeenCalled();
    expect(r.promptHidden).not.toHaveBeenCalled();
    expectNoSecrets(r);
  });

  test('missing CAMPING_DATABASE_* → exit 2 naming only the variables', async () => {
    const openService = mock(() => { throw new Error('should not open'); });
    const env = { CAMPING_DATABASE_HOST: 'db.invalid', CAMPING_DATABASE_PASSWORD: 'not-printed-value', CAMPING_SMOKE_PASSWORD: PASS };
    const r = run({ env, openService });
    expect(await r.promise).toBe(2);
    expect(line(r)).toEqual({ ok: false, reason: 'config_invalid' });
    expect(openService).not.toHaveBeenCalled();
    expect(r.readInput).not.toHaveBeenCalled();
    expect(r.err.join('\n')).toContain('CAMPING_DATABASE_NAME');
    expect(r.err.join('\n')).toContain('CAMPING_DATABASE_USER');
    expect([...r.out, ...r.err].join('\n')).not.toContain('not-printed-value');
    expect([...r.out, ...r.err].join('\n')).not.toContain('db.invalid');
  });

  test('--help prints usage and exits 0', async () => {
    const r = run({ argv: ['--help'] });
    expect(await r.promise).toBe(0);
    expect(r.out).toEqual([USAGE]);
    expect(r.readInput).not.toHaveBeenCalled();
  });

  test('validateFixtureTitle accepts 1–100 characters without surrounding whitespace and returns it unchanged', () => {
    expect(validateFixtureTitle('smoke-fixture')).toBe('smoke-fixture');
    expect(validateFixtureTitle('露'.repeat(100))).toBe('露'.repeat(100));
    for (const bad of ['', ' x', 'x\n', '\u3000x', 'f'.repeat(101), 'a\u0000b', null, 1]) expect(() => validateFixtureTitle(bad)).toThrow(HttpError);
  });

  test('every failure reason is from the documented list', () => {
    expect(REASONS).toEqual(['usage', 'config_invalid', 'password_invalid', 'input_ended', 'database', 'no_admin', 'account_is_admin', 'account_disabled']);
  });
});

describe('密碼來源（Req 27.3、27.4）', () => {
  test.each([
    ['11 characters', 'p'.repeat(11)],
    ['129 characters', 'p'.repeat(129)],
    ['two lines', `${PASS}\nsecond line\n`],
    ['more than 4096 bytes', Buffer.alloc(4097, 'p')],
    ['empty stdin', '']
  ])('stdin with %s → exit 1, nothing written', async (_, input) => {
    await insertAdmin();
    const before = await tables();
    const openService = mock(() => { throw new Error('should not open'); });
    const r = run({ input, openService });
    expect(await r.promise).toBe(1);
    expect(line(r)).toEqual({ ok: false, reason: 'password_invalid' });
    expect(openService).not.toHaveBeenCalled();
    expect(await tables()).toEqual(before);
    expectNoSecrets(r);
  });

  test('without a terminal the password is one line of stdin', async () => {
    await insertAdmin();
    const r = run({ input: `${PASS}\r\n` });
    expect(await r.promise).toBe(0);
    expect(r.readInput).toHaveBeenCalledTimes(1);
    expect(r.promptHidden).not.toHaveBeenCalled();
    const [row] = await testQuery(db.sql, 'SELECT password_hash FROM users WHERE username = ?', DEFAULT_USERNAME);
    expect(await verifyPassword(PASS, row.password_hash)).toBe(true);
    expectNoSecrets(r);
  });

  test('--password-file reads one line; a file with more lines is refused', async () => {
    await insertAdmin();
    const dir = mkdtempSync(join(tmpdir(), 'smoke-account-'));
    try {
      const bad = join(dir, 'two-lines.txt');
      writeFileSync(bad, `${PASS}\nsecond line\n`);
      const before = await tables();
      const refused = run({ argv: ['--password-file', bad] });
      expect(await refused.promise).toBe(1);
      expect(line(refused)).toEqual({ ok: false, reason: 'password_invalid' });
      expect(await tables()).toEqual(before);

      const good = join(dir, 'password.txt');
      writeFileSync(good, `${PASS}\n`);
      const r = run({ argv: ['--password-file', good] });
      expect(await r.promise).toBe(0);
      expect(r.readInput).not.toHaveBeenCalled();
      expect(r.promptHidden).not.toHaveBeenCalled();
      const [row] = await testQuery(db.sql, 'SELECT password_hash FROM users WHERE username = ?', DEFAULT_USERNAME);
      expect(await verifyPassword(PASS, row.password_hash)).toBe(true);
      expectNoSecrets(refused);
      expectNoSecrets(r);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('on a terminal the password is asked twice; a mismatch asks again; password variables in env are ignored', async () => {
    await insertAdmin();
    const envPassword = 'environment placeholder 03';
    const r = run({
      isTTY: true, hidden: [PASS, 'different placeholder 04', PASS, PASS],
      env: pgEnv({ CAMPING_SMOKE_PASSWORD: envPassword, CAMPING_SMOKE_ACCOUNT_PASSWORD: envPassword, CAMPING_ADMIN_PASSWORD: envPassword })
    });
    expect(await r.promise).toBe(0);
    expect(r.err).toContain(PASSWORD_MISMATCH);
    expect(r.promptHidden).toHaveBeenCalledTimes(4);
    expect(r.readInput).not.toHaveBeenCalled();
    const [row] = await testQuery(db.sql, 'SELECT password_hash FROM users WHERE username = ?', DEFAULT_USERNAME);
    expect(await verifyPassword(PASS, row.password_hash)).toBe(true);
    expect(await verifyPassword(envPassword, row.password_hash)).toBe(false);
    expect([...r.out, ...r.err].join('\n')).not.toContain(envPassword);
    expectNoSecrets(r);
  });

  test('ended terminal input → exit 1 input_ended, nothing written', async () => {
    await insertAdmin();
    const before = await tables();
    const r = run({ isTTY: true, hidden: [] });
    expect(await r.promise).toBe(1);
    expect(line(r)).toEqual({ ok: false, reason: 'input_ended' });
    expect(await tables()).toEqual(before);
  });
});

describe('Database 錯誤（Req 27.6）', () => {
  test('an unreachable database → exit 1 with host and port only', async () => {
    const r = run({ env: pgEnv({ CAMPING_DATABASE_HOST: '127.0.0.1', CAMPING_DATABASE_PORT: '1' }), poolOptions: { connectionTimeout: 2 } });
    expect(await r.promise).toBe(1);
    expect(line(r)).toEqual({ ok: false, reason: 'database' });
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toStartWith('Cannot use the database at 127.0.0.1:1 (');
    expectNoSecrets(r);
  });

  test('missing tables (migrations not applied) → exit 1', async () => {
    const r = run({ poolOptions: { connection: { search_path: 'lm_no_such_schema' } } });
    expect(await r.promise).toBe(1);
    expect(line(r)).toEqual({ ok: false, reason: 'database' });
    expect(r.err[0]).toStartWith(`Cannot use the database at ${db.config.host}:${db.config.port} (`);
    expectNoSecrets(r);
  });
});

// 「有／沒有管理員」×「Smoke_Account 不存在／member／admin／已刪除」×「Smoke_Fixture 不存在／存在」（Req 27.7–27.12、27.14）。
// Without an administrator the database still holds a deleted administrator, so only active ones count. With
// Smoke_Fixture「存在」a trip titled smoke-fixture always exists in another member's account (not visible to the
// Smoke_Account), and, when the Smoke_Account exists, also in the Smoke_Account's own trips.
const STATES = [true, false].flatMap(admin => ['none', 'member', 'admin', 'deleted'].flatMap(account => [false, true].map(fixture => ({ admin, account, fixture }))));

async function seedState({ admin, account, fixture }) {
  const at = Date.now();
  await insertUser(db.sql, 'u-owner', 'owner', 'Owner', 'admin', existingHash, at);
  if (!admin) await testQuery(db.sql, 'UPDATE users SET deleted_at = ? WHERE id = ?', at, 'u-owner');
  if (fixture) {
    await insertUser(db.sql, 'u-other', 'other-user', 'Other', 'member', existingHash, at);
    await createTripAs(await login('other-user', EXISTING_PASS), DEFAULT_FIXTURE);
  }
  if (account === 'none') return;
  await insertUser(db.sql, 'u-smoke', DEFAULT_USERNAME, 'Existing Smoke', account === 'admin' ? 'admin' : 'member', existingHash, at);
  // A live session, so "sessions unchanged" is meaningful.
  const cookie = await login(DEFAULT_USERNAME, EXISTING_PASS);
  if (fixture) await createTripAs(cookie, DEFAULT_FIXTURE);
  if (account === 'deleted') await testQuery(db.sql, 'UPDATE users SET deleted_at = ? WHERE id = ?', at, 'u-smoke');
}

function expected({ admin, account, fixture }) {
  // An administrator Smoke_Account is itself an active administrator, so that state is refused as account_is_admin.
  if (!admin && account !== 'admin') return { code: 1, json: { ok: false, reason: 'no_admin' } };
  if (account === 'deleted') return { code: 1, json: { ok: false, reason: 'account_disabled' } };
  if (account === 'admin') return { code: 1, json: { ok: false, reason: 'account_is_admin' } };
  const accountStatus = account === 'none' ? 'created' : 'kept';
  const fixtureStatus = account === 'member' && fixture ? 'kept' : 'created';
  return { code: 0, json: { ok: true, username: DEFAULT_USERNAME, account: accountStatus, fixture: DEFAULT_FIXTURE, fixtureStatus } };
}

describe('決策表（Req 27.7–27.12、27.14）', () => {
  test.each(STATES.map(s => [`admin=${s.admin} account=${s.account} fixture=${s.fixture}`, s]))('%s', async (_, state) => {
    await seedState(state);
    const before = await tables();
    const want = expected(state);
    const r = run();
    expect(await r.promise).toBe(want.code);
    expect(line(r)).toEqual(want.json);
    expectNoSecrets(r);
    const after = await tables();
    const diff = added(before, after);

    if (want.code !== 0) {
      expect(after).toEqual(before);
      if (want.json.reason === 'no_admin') expect(r.err.join('\n')).toContain('create-admin');
      return;
    }
    expect(diff.sessions).toEqual([]);
    const smoke = after.users.find(u => u.username === DEFAULT_USERNAME);
    const wantAudit = [];
    if (want.json.account === 'created') {
      expect(diff.users).toEqual([smoke]);
      expect(smoke).toMatchObject({ display_name: SMOKE_DISPLAY_NAME, role: 'member', deleted_at: null });
      expect(await verifyPassword(PASS, smoke.password_hash)).toBe(true);
      wantAudit.push({ actor: DEFAULT_USERNAME, action: 'smoke.account.create', target: `user:${DEFAULT_USERNAME}` });
    } else {
      // Existing member: role, display name, password hash and sessions unchanged (checked by `added`).
      expect(diff.users).toEqual([]);
      expect(smoke.display_name).toBe('Existing Smoke');
      expect(await verifyPassword(EXISTING_PASS, smoke.password_hash)).toBe(true);
    }
    if (want.json.fixtureStatus === 'created') {
      expect(diff.trips).toHaveLength(1);
      const [trip] = diff.trips;
      expect(trip).toMatchObject({ owner_id: smoke.id, title: DEFAULT_FIXTURE, start_date: SMOKE_FIXTURE_DATES.startDate, end_date: SMOKE_FIXTURE_DATES.endDate, revision: 1 });
      expect(diff.trip_members).toHaveLength(1);
      expect(diff.trip_members[0]).toMatchObject({ trip_id: trip.id, user_id: smoke.id });
      wantAudit.push({ actor: DEFAULT_USERNAME, action: 'smoke.fixture.create', target: `trip:${trip.id}` });
    } else {
      expect(diff.trips).toEqual([]);
      expect(diff.trip_members).toEqual([]);
    }
    expect(diff.audit.map(({ actor, action, target }) => ({ actor, action, target }))).toEqual(wantAudit);
    expect(JSON.stringify(diff.audit)).not.toContain(PASS);
    expect(JSON.stringify(diff.audit)).not.toContain('scrypt$');

    // Second run with the same arguments and password: no rows written, both reported as kept (Req 27.14).
    const again = run();
    expect(await again.promise).toBe(0);
    expect(line(again)).toEqual({ ok: true, username: DEFAULT_USERNAME, account: 'kept', fixture: DEFAULT_FIXTURE, fixtureStatus: 'kept' });
    expect(await tables()).toEqual(after);
  }, 30_000);
});

describe('新建的 Smoke_Fixture（Req 27.11）', () => {
  // Person ids, event ids and times are random or clock-based; everything else must match POST /api/trips.
  function comparable(state) {
    const ids = new Map(state.people.map((p, i) => [p.id, `person-${i}`]));
    const copy = JSON.parse(JSON.stringify(state), (_, v) => (typeof v === 'string' && ids.has(v) ? ids.get(v) : v));
    copy.events = copy.events.map(e => ({ ...e, id: 'event', at: 'time' }));
    return copy;
  }
  const rowFields = row => ({ title: row.title, destination: row.destination, start_date: row.start_date, end_date: row.end_date,
    description: row.description, note: row.note, cover_kind: row.cover_kind, status: row.status, revision: row.revision, people_count: row.people_count });

  test('the trip state comes from the POST /api/trips code path', async () => {
    await insertAdmin();
    const r = run();
    expect(await r.promise).toBe(0);
    expect(FIXTURE_DATES).toBe(SMOKE_FIXTURE_DATES);
    const [smoke] = await testQuery(db.sql, 'SELECT * FROM users WHERE username = ?', DEFAULT_USERNAME);
    const [fixture] = await testQuery(db.sql, 'SELECT * FROM trips WHERE owner_id = ?', smoke.id);
    const state = JSON.parse(fixture.state_json);
    expect(isValidState(state)).toBe(true);
    expect(state.revision).toBe(1);
    expect(state.people).toHaveLength(1);
    expect(state.people[0]).toMatchObject({ name: SMOKE_DISPLAY_NAME, role: '這趟的召集人' });
    expect(state.trip).toMatchObject({ title: DEFAULT_FIXTURE, ...SMOKE_FIXTURE_DATES });
    const [member] = await testQuery(db.sql, 'SELECT * FROM trip_members WHERE trip_id = ?', fixture.id);
    expect(member).toMatchObject({ user_id: smoke.id, person_id: state.people[0].id });
    expect(rowFields(fixture)).toEqual({ title: DEFAULT_FIXTURE, destination: '', start_date: '2030-01-01', end_date: '2030-01-02',
      description: '', note: '', cover_kind: 'camp', status: 'planning', revision: 1, people_count: 1 });

    // The same title and dates through the App's own route.
    const viaApi = await createTripAs(await login(DEFAULT_USERNAME, PASS), DEFAULT_FIXTURE);
    const [apiRow] = await testQuery(db.sql, 'SELECT * FROM trips WHERE id = ?', viaApi.id);
    expect(rowFields(fixture)).toEqual(rowFields(apiRow));
    expect(comparable(state)).toEqual(comparable(JSON.parse(apiRow.state_json)));
  });
});

describe('交易回復（Req 27.13）', () => {
  test('a failure while inserting the trip membership rolls back the account and its audit event', async () => {
    await insertAdmin();
    const before = await tables();
    await testQuery(db.sql, `CREATE FUNCTION lm_test_fail_member() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
    await testQuery(db.sql, 'CREATE TRIGGER lm_test_fail_member BEFORE INSERT ON trip_members FOR EACH ROW EXECUTE FUNCTION lm_test_fail_member()');
    try {
      const r = run();
      expect(await r.promise).toBe(1);
      expect(line(r)).toEqual({ ok: false, reason: 'database' });
      expectNoSecrets(r);
      expect(await tables()).toEqual(before);
    } finally {
      await testQuery(db.sql, 'DROP TRIGGER IF EXISTS lm_test_fail_member ON trip_members');
      await testQuery(db.sql, 'DROP FUNCTION IF EXISTS lm_test_fail_member()');
    }
    // Without the injected failure the same run succeeds.
    const ok = run();
    expect(await ok.promise).toBe(0);
    expect(line(ok)).toMatchObject({ account: 'created', fixtureStatus: 'created' });
  });
});

describe('Smoke_Test 往返（Req 27.16）', () => {
  let server, root, baseUrl;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'lm-smoke-account-'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>t</title>');
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: createHttpHandler({ root, accounts: svc, health: () => svc.ping(2000) }) });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => {
    server?.stop(true);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('after create-admin and create-smoke-account every Smoke_Test step passes', async () => {
    await svc.createFirstAdmin({ username: 'owner', displayName: 'Owner', password: EXISTING_PASS }, { auditAction: 'setup.cli' });
    const r = run();
    expect(await r.promise).toBe(0);
    const result = await runSmoke({ baseUrl, username: DEFAULT_USERNAME, password: PASS, fixture: DEFAULT_FIXTURE });
    expect(result.steps.map(s => [s.step, s.result])).toEqual([
      ['login-page', 'pass'], ['session', 'pass'], ['login', 'pass'], ['trips', 'pass'], ['logout', 'pass']
    ]);
    expect(result.ok).toBe(true);
  });

  test('a fixture with another title is not found by the default Smoke_Test', async () => {
    await svc.createFirstAdmin({ username: 'owner', displayName: 'Owner', password: EXISTING_PASS }, { auditAction: 'setup.cli' });
    const r = run({ argv: ['--username', 'smoke-other', '--fixture', 'smoke-other'] });
    expect(await r.promise).toBe(0);
    expect(line(r)).toEqual({ ok: true, username: 'smoke-other', account: 'created', fixture: 'smoke-other', fixtureStatus: 'created' });
    const result = await runSmoke({ baseUrl, username: 'smoke-other', password: PASS });
    expect(result.ok).toBe(false);
    expect(result.steps.find(s => s.step === 'trips')).toMatchObject({ result: 'fail', reason: 'fixture-missing' });
    expect(result.steps.find(s => s.step === 'logout').result).toBe('pass');
  });
});
