// SQLite_Importer 範例測試（task 7.2；Requirement 10.9、13.1–13.6、13.8–13.10）。
// 屬性測試由 tasks 7.3–7.6 另行撰寫。
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountService, hashPassword } from '../server/accounts.js';
import { importSqlite, parseArgs, EXIT_OK, EXIT_SOURCE_INVALID, EXIT_TARGET_NOT_EMPTY, EXIT_IMPORT_FAILED, EXIT_USAGE } from '../scripts/import-sqlite.mjs';
import { useTestDatabase, resetTables, serviceDb } from './support/pg.js';
import { buildSqliteFixture } from './support/sqlite-fixture.js';
import { tableOrder } from '../server/db/import-plan.js';

const BASE = 'http://127.0.0.1:5181';
const PASS = 'original password 1';
const db = useTestDatabase();
let dir, lines, errors;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lm-import-test-'));
  lines = []; errors = [];
  await resetTables(db.sql);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const run = (sourcePath, extra = {}) => importSqlite({ sourcePath, sql: db.sql, log: l => lines.push(l), err: l => errors.push(l), ...extra });

async function sampleData() {
  const hash = await hashPassword(PASS);
  const t0 = 1_762_000_000_000;
  return {
    hash,
    data: {
      users: [
        { id: 'u1', username: 'alice', display_name: '露營王 ✨', role: 'admin', password_hash: hash, created_at: t0, deleted_at: null },
        { id: 'u2', username: 'bob', display_name: "O'Brien; --", role: 'member', password_hash: hash, created_at: 9_007_199_254_740_993n, deleted_at: t0 + 5 },
      ],
      sessions: [{ token_hash: 'a'.repeat(64), user_id: 'u1', created_at: t0, expires_at: t0 + 1 }],
      trips: [{ id: 'tr1', owner_id: 'u1', title: '湖邊', destination: '日月潭', start_date: '2026-11-20', end_date: '2026-11-22', description: '', note: '', cover_kind: 'lake', status: 'planning', revision: 3, people_count: 2, state_json: '{"a":1}', created_at: t0, updated_at: t0 }],
      trip_members: [{ trip_id: 'tr1', user_id: 'u1', person_id: 'p1', joined_at: t0 }],
      invites: [{ token_hash: 'b'.repeat(64), trip_id: 'tr1', created_by: 'u1', created_at: t0, expires_at: t0 + 10, revoked_at: null }],
      trip_deletions: [],
      audit: [{ id: 7, at: t0, actor: 'u1', action: 'setup', target: 'u1' }, { id: 42, at: t0, actor: 'u1', action: 'x', target: 'y' }],
      trip_ledgers: [{ trip_id: 'tr1', revision: 1, ledger_json: '{"expenses":[]}', requests_json: '[]', updated_by: 'u1', updated_at: t0 }],
    },
  };
}

describe('importSqlite', () => {
  test('imports every table, preserves values and password hashes, and resets the audit identity', async () => {
    const { data, hash } = await sampleData();
    const source = join(dir, 'accounts.sqlite');
    const live = buildSqliteFixture(source, data, { wal: true, keepOpen: true }); // 來源含未 checkpoint 的 -wal
    const listing = (await readdir(dir)).sort();
    try {
      const result = await run(source);
      expect(errors).toEqual([]);
      expect(result.exitCode).toBe(EXIT_OK);
      expect(result.counts.find(c => c.table === 'users')).toEqual({ table: 'users', source: 2, target: 2 });
      expect(lines.slice(-(tableOrder().length + 1))[0]).toBe('table source target');
      expect(lines).toContain('audit 2 2');
      expect((await readdir(dir)).sort()).toEqual(listing);
    } finally {
      live.close();
    }

    const users = await db.sql`SELECT id, display_name, password_hash, created_at::text AS created_at, deleted_at FROM users ORDER BY id`;
    expect(users.map(u => u.display_name)).toEqual(['露營王 ✨', "O'Brien; --"]);
    expect(users.every(u => u.password_hash === hash)).toBe(true);
    expect(users[1].created_at).toBe('9007199254740993');
    expect(users[0].deleted_at).toBeNull();

    const [{ id }] = await db.sql`INSERT INTO audit (at, actor, action, target) VALUES (1, 'a', 'b', 'c') RETURNING id`;
    expect(Number(id)).toBe(43);

    const svc = await createAccountService({ db: serviceDb(db.sql) });
    try {
      const login = password => svc.handle(new Request(`${BASE}/api/login`, {
        method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password }),
      }));
      expect((await login(PASS)).status).toBe(200);
      expect((await login('wrong password 1')).status).not.toBe(200);
    } finally {
      svc.close();
    }
  });

  test('empty audit table leaves the next identity at 1', async () => {
    const source = join(dir, 'empty.sqlite');
    buildSqliteFixture(source, {});
    expect((await run(source)).exitCode).toBe(EXIT_OK);
    const [{ id }] = await db.sql`INSERT INTO audit (at, actor, action, target) VALUES (1, 'a', 'b', 'c') RETURNING id`;
    expect(Number(id)).toBe(1);
  });

  test('refuses a non-empty target and leaves it unchanged', async () => {
    const { data } = await sampleData();
    const source = join(dir, 'accounts.sqlite');
    buildSqliteFixture(source, data);
    await db.sql`INSERT INTO users (id, username, display_name, role, password_hash, created_at) VALUES ('x', 'x', 'x', 'member', 'h', 1)`;
    const result = await run(source);
    expect(result.exitCode).toBe(EXIT_TARGET_NOT_EMPTY);
    expect(errors.join('\n')).toContain('users');
    const [{ n }] = await db.sql`SELECT count(*)::int AS n FROM users`;
    expect(n).toBe(1);
    const [{ m }] = await db.sql`SELECT count(*)::int AS m FROM trips`;
    expect(m).toBe(0);
  });

  test('rolls back everything when a row cannot be converted, without echoing row contents', async () => {
    const { data } = await sampleData();
    data.trips[0].revision = 2 ** 31; // 超出 int4
    const source = join(dir, 'accounts.sqlite');
    buildSqliteFixture(source, data);
    const result = await run(source);
    expect(result.exitCode).toBe(EXIT_IMPORT_FAILED);
    expect(result.error).toContain('trips');
    expect(result.error).toContain('revision');
    expect(result.error).not.toContain(String(2 ** 31));
    const [{ n }] = await db.sql`SELECT count(*)::int AS n FROM users`;
    expect(n).toBe(0);
  });

  test('rejects invalid sources before touching the target', async () => {
    const connect = () => { throw new Error('must not connect'); };
    const missing = await importSqlite({ sourcePath: join(dir, 'nope.sqlite'), connect, err: l => errors.push(l) });
    expect(missing.exitCode).toBe(EXIT_SOURCE_INVALID);

    const garbage = join(dir, 'garbage.sqlite');
    await writeFile(garbage, 'not a database at all, definitely not');
    expect((await importSqlite({ sourcePath: garbage, connect })).exitCode).toBe(EXIT_SOURCE_INVALID);

    const partial = join(dir, 'partial.sqlite');
    buildSqliteFixture(partial, {});
    const { Database } = await import('bun:sqlite');
    const p = new Database(partial);
    p.exec('DROP TABLE trip_ledgers');
    p.close();
    const r = await importSqlite({ sourcePath: partial, connect, err: l => errors.push(l) });
    expect(r.exitCode).toBe(EXIT_SOURCE_INVALID);
    expect(r.error).toContain('trip_ledgers');
  });

  test('an old (pre security-harden) source imports with 0 rows for the 0002 tables and NULL invite columns', async () => {
    const { data } = await sampleData();
    const source = join(dir, 'old.sqlite');
    buildSqliteFixture(source, data, { schema: 'old' });
    const result = await run(source);
    expect(errors).toEqual([]);
    expect(result.exitCode).toBe(EXIT_OK);
    for (const table of ['settings', 'receipt_ai_usage', 'security_events', 'security_alerts']) {
      expect(result.counts.find(c => c.table === table)).toEqual({ table, source: 0, target: 0 });
      expect(lines).toContain(`${table} 0 0`);
    }
    expect(result.counts.find(c => c.table === 'invites')).toEqual({ table: 'invites', source: 1, target: 1 });
    expect(await db.sql`SELECT token_hash, used_at, used_by, id FROM invites`).toEqual([{ token_hash: 'b'.repeat(64), used_at: null, used_by: null, id: null }]);
  });

  test('a security-harden source imports the 0002 tables, invite columns and the security_events identity', async () => {
    const { data } = await sampleData();
    const t0 = 1_762_000_000_000;
    data.trips[0].cover_kind = 'sunrise';
    data.invites = [
      { ...data.invites[0], used_at: t0 + 3, used_by: 'u2', id: 'inv-1' },
      { token_hash: 'c'.repeat(64), trip_id: 'tr1', created_by: 'u1', created_at: t0, expires_at: t0 + 10, revoked_at: null, used_at: null, used_by: null, id: 'inv-2' },
    ];
    data.settings = [{ key: 'receiptAiPolicy', value: 'admins', updated_at: t0, updated_by: 'alice' }];
    data.receipt_ai_usage = [{ id: 'r1', at: t0, user_id: 'u1', trip_id: 'gone-trip', model_id: 'gpt-x', prompt_tokens: 120, completion_tokens: 30, outcome: 'success' }];
    data.security_events = [
      { id: 5, at: t0, client: '203.0.113.9', username: 'alice', reason: 'bad_credentials' },
      { id: 9, at: t0 + 1, client: '203.0.113.9', username: '(invalid)', reason: 'invalid_input' },
    ];
    data.security_alerts = [
      { id: 'al-1', at: t0, kind: 'username', username: 'alice', client: '203.0.113.9', count: 5, window_start: t0 - 900_000, window_end: t0, acknowledged_at: t0 + 2, acknowledged_by: 'alice' },
      { id: 'al-2', at: t0, kind: 'global', username: '(all)', client: '203.0.113.9', count: 20, window_start: t0 - 900_000, window_end: t0, acknowledged_at: null, acknowledged_by: null },
    ];
    const source = join(dir, 'harden.sqlite');
    buildSqliteFixture(source, data, { schema: 'harden' });
    const result = await run(source);
    expect(errors).toEqual([]);
    expect(result.exitCode).toBe(EXIT_OK);
    for (const table of tableOrder()) {
      const expected = (data[table] ?? []).length;
      expect(result.counts.find(c => c.table === table)).toEqual({ table, source: expected, target: expected });
    }
    expect((await db.sql`SELECT cover_kind FROM trips`)[0].cover_kind).toBe('sunrise');
    const invites = await db.sql`SELECT id, used_at::text AS used_at, used_by FROM invites ORDER BY id`;
    expect(invites).toEqual([{ id: 'inv-1', used_at: String(t0 + 3), used_by: 'u2' }, { id: 'inv-2', used_at: null, used_by: null }]);
    // Imported alerts keep the source (rowid) order in seq, so same-millisecond alerts list deterministically.
    expect((await db.sql`SELECT id FROM security_alerts ORDER BY seq`).map(r => r.id)).toEqual(['al-1', 'al-2']);
    // Req 13.10: the security_events identity continues after the largest imported id.
    const [{ id }] = await db.sql`INSERT INTO security_events (at, client, username, reason) VALUES (1, 'c', 'u', 'invalid_input') RETURNING id`;
    expect(Number(id)).toBe(10);

    const svc = await createAccountService({ db: serviceDb(db.sql), receiptAiPolicySeed: 'all' });
    try {
      // The stored setting wins over the seed.
      expect(await svc.receiptAiPolicy()).toMatchObject({ value: 'admins', source: 'stored' });
    } finally {
      svc.close();
    }
  });

  test('parseArgs', () => {
    expect(parseArgs(['--source', 'a.sqlite'])).toEqual({ ok: true, source: 'a.sqlite' });
    expect(parseArgs(['--source=b.sqlite'])).toEqual({ ok: true, source: 'b.sqlite' });
    expect(parseArgs([]).ok).toBe(false);
    expect(parseArgs(['--bogus']).ok).toBe(false);
    expect(EXIT_USAGE).toBe(2);
  });
});
