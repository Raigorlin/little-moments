// migrations/0002_security_harden.sql 的升級測試（task 18.4；Requirement 12.1、12.4、12.6）。
//
// 先只套用 0001，寫入既有資料，再套用完整遷移集合：
// 既有行程、旅伴與邀請保留；邀請取得唯一 id；trips.cover_kind 的七個值（已併入 0001）都可使用；
// 新資料表存在；0002 沒有破壞性語句與 `-- lm:destructive` 標記，被記錄為非破壞性遷移（Property 32）。
//
// 需要 Ephemeral_Database（CAMPING_TEST_DATABASE_*，見 tests/support/pg.js）。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasDestructiveMarker, loadMigrations, runMigrations, EXIT_OK } from '../server/db/migrations.js';
import { readMigrationFiles } from '../scripts/migrate.mjs';
import { createTestDatabase, readTestDatabaseConfig, MIGRATIONS_DIR } from './support/pg.js';
import { analyzeSql } from '../scripts/lint-migrations.mjs';

readTestDatabaseConfig();

let db, onlyInitialDir, files;

beforeAll(async () => {
  files = await readMigrationFiles(MIGRATIONS_DIR);
  onlyInitialDir = await mkdtemp(join(tmpdir(), 'lm-migrations-0001-'));
  const initial = files.find(f => f.name === '0001_initial.sql');
  await writeFile(join(onlyInitialDir, initial.name), initial.content);
  db = await createTestDatabase({ migrationsDir: onlyInitialDir });
}, 60_000);
afterAll(async () => {
  await db?.close();
  if (onlyInitialDir) await rm(onlyInitialDir, { recursive: true, force: true });
}, 30_000);

describe('0002_security_harden upgrade', () => {
  test('0001 and 0002 have no destructive statements and no destructive marker', () => {
    for (const name of ['0001_initial.sql', '0002_security_harden.sql']) {
      const text = new TextDecoder().decode(files.find(f => f.name === name).content);
      const { destructive, nonTransactional, errors } = analyzeSql(text);
      expect(errors).toEqual([]);
      expect(nonTransactional).toEqual([]);
      expect(destructive).toEqual([]);
      expect(hasDestructiveMarker(text)).toBe(false);
    }
  });

  test('upgrading a 0001 database keeps existing rows, backfills invite ids and keeps all cover kinds', async () => {
    const { sql } = db;
    await sql`INSERT INTO users (id, username, display_name, role, password_hash, created_at) VALUES ('u1', 'old-owner', 'Old owner', 'admin', 'hash', 1)`;
    await sql`INSERT INTO trips (id, owner_id, title, destination, start_date, end_date, description, note, cover_kind, status, revision, people_count, state_json, created_at, updated_at)
      VALUES ('t1', 'u1', 'Old trip', 'Lake', '2026-11-20', '2026-11-22', '', '', 'lake', 'planning', 1, 1, '{}', 1, 1)`;
    await sql`INSERT INTO trip_members (trip_id, user_id, person_id, joined_at) VALUES ('t1', 'u1', 'p1', 1)`;
    await sql`INSERT INTO invites (token_hash, trip_id, created_by, created_at, expires_at) VALUES ('h1', 't1', 'u1', 1, 2), ('h2', 't1', 'u1', 1, 2)`;
    // 0001 already accepts all seven cover kinds.
    for (const kind of ['camp', 'mountain', 'lake', 'night', 'forest', 'beach', 'sunrise']) await sql`UPDATE trips SET cover_kind = ${kind} WHERE id = 't1'`;
    await expect(sql`UPDATE trips SET cover_kind = 'ocean' WHERE id = 't1'`).rejects.toThrow();
    await sql`UPDATE trips SET cover_kind = 'lake' WHERE id = 't1'`;

    const result = await runMigrations(sql, loadMigrations(files), { log: () => {} });
    expect(result.exitCode).toBe(EXIT_OK);

    expect(await sql`SELECT id, cover_kind FROM trips`).toEqual([{ id: 't1', cover_kind: 'lake' }]);
    expect(await sql`SELECT trip_id, user_id, person_id FROM trip_members`).toEqual([{ trip_id: 't1', user_id: 'u1', person_id: 'p1' }]);
    const invites = await sql`SELECT token_hash, id, used_at, used_by FROM invites ORDER BY token_hash`;
    expect(invites.map(i => i.token_hash)).toEqual(['h1', 'h2']);
    expect(invites.every(i => /^[0-9a-f-]{36}$/.test(i.id) && i.used_at === null && i.used_by === null)).toBe(true);
    expect(new Set(invites.map(i => i.id)).size).toBe(2);

    for (const kind of ['camp', 'mountain', 'lake', 'night', 'forest', 'beach', 'sunrise']) await sql`UPDATE trips SET cover_kind = ${kind} WHERE id = 't1'`;
    await expect(sql`UPDATE trips SET cover_kind = 'ocean' WHERE id = 't1'`).rejects.toThrow();
    await expect(sql`UPDATE invites SET id = ${invites[0].id} WHERE token_hash = 'h2'`).rejects.toThrow();
    await expect(sql`UPDATE invites SET used_by = 'ghost' WHERE token_hash = 'h2'`).rejects.toThrow();

    for (const table of ['settings', 'receipt_ai_usage', 'security_events', 'security_alerts']) {
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM ${sql(table)}`;
      expect(n).toBe(0);
    }
    const indexes = (await sql`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`).map(r => r.indexname);
    for (const name of ['invites_id', 'receipt_ai_usage_at', 'receipt_ai_usage_user_at', 'security_events_at', 'security_events_user_at', 'security_alerts_open']) {
      expect(indexes).toContain(name);
    }
    const recorded = await sql`SELECT version, destructive FROM schema_migrations ORDER BY version`;
    expect(recorded).toEqual([{ version: 1, destructive: false }, { version: 2, destructive: false }]);
  });
});
