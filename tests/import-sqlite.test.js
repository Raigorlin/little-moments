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
      expect(lines.slice(-9)[0]).toBe('table source target');
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

  test('parseArgs', () => {
    expect(parseArgs(['--source', 'a.sqlite'])).toEqual({ ok: true, source: 'a.sqlite' });
    expect(parseArgs(['--source=b.sqlite'])).toEqual({ ok: true, source: 'b.sqlite' });
    expect(parseArgs([]).ok).toBe(false);
    expect(parseArgs(['--bogus']).ok).toBe(false);
    expect(EXIT_USAGE).toBe(2);
  });
});
