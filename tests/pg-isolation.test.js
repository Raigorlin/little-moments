// 測試基礎設施的隔離回歸測試（design.md Components §24.5；tasks.md 26.1）。
//
// 驗證：
//   1. 經共用 TCP proxy 的斷線情境（blackhole 期間持有寫入鎖的交易與 ping、refuse、stop）結束後，
//      同一資料庫中新的 createTestDatabase 可以套用全部遷移並完成一次 withWriteTx，10 秒內完成。
//   2. 另一條連線持有 Migration_Runner 的 advisory lock（726362）時，lock_timeout 覆寫為 1s 的連線上
//      runMigrations 以 55P03 失敗、結束碼非 0、schema_migrations 沒有新紀錄，測試在 bun 的逾時前結束。
//   3. close() 之後沒有該測試 Database application_name 的 backend；被放棄的 BEGIN 交易不會讓 close() 超過 10 秒。
//
// 需要 Ephemeral_Database（CAMPING_TEST_DATABASE_*，見 tests/support/pg.js）。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT_OK, MIGRATION_LOCK_KEY, loadMigrations, runMigrations } from '../server/db/migrations.js';
import { WRITE_LOCK_KEY, withWriteTx } from '../server/db/tx.js';
import { createDatabase } from '../server/db/connect.js';
import { readMigrationFiles } from '../scripts/migrate.mjs';
import { createTestDatabase, inspectTestSessions, openTestPool, readTestDatabaseConfig, MIGRATIONS_DIR } from './support/pg.js';
import { createTcpProxy } from './support/tcp-proxy.js';

// 未設定 CAMPING_TEST_DATABASE_* 時載入即失敗（不靜默略過）。
const DATABASE = readTestDatabaseConfig();
const LOCK_NOT_AVAILABLE = '55P03';

const insertUser = (t, id) => t`INSERT INTO users (id, username, display_name, role, password_hash, created_at)
  VALUES (${id}, ${id}, ${id}, 'member', 'hash', 1)`;

/** 等待 promise 結束（成功或失敗），回傳 { ok, value | error }；用來收回被斷線放棄的查詢。 */
const settle = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));

const opened = [];
afterAll(async () => {
  while (opened.length) await opened.pop().close();
}, 30_000);
const track = db => { opened.push(db); return db; };

describe('測試 Database 隔離（design.md §24.5）', () => {
  test('after a shared-proxy outage (blackhole with a held write lock, refuse, stop) a new test database migrates and writes within 10 s', async () => {
    const first = track(await createTestDatabase());
    const proxy = createTcpProxy({ targetHost: first.config.host, targetPort: first.config.port });
    const appDb = createDatabase({ ...first.config, host: '127.0.0.1', port: proxy.port }, { connection: first.sessionParams });
    const pending = [];
    try {
      expect(await appDb.ping(2000)).toBe(true);
      // 寫入交易取得 726361 並寫入一列，proxy 進入 blackhole 後才送出下一個敘述：
      // 伺服器端留下持有寫入鎖、idle in transaction 的 backend。
      let inTx, release;
      const holding = new Promise(resolve => { inTx = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      pending.push(settle(withWriteTx(appDb.sql, async t => {
        await insertUser(t, 'proxy-writer');
        inTx();
        await gate;
        await t`SELECT 1`; // 留在 proxy 的佇列，不會得到回應
      })));
      await holding;
      proxy.blackhole();
      release();
      const during = await inspectTestSessions(first.sessionParams.application_name);
      expect(during.advisoryLocks.some(l => during.pids.includes(l.pid) && l.objid === WRITE_LOCK_KEY && l.granted)).toBe(true);
      pending.push(settle(withWriteTx(appDb.sql, t => insertUser(t, 'blackholed-writer'))));
      const pings = await Promise.all([appDb.ping(300), appDb.ping(300), appDb.ping(300)]);
      expect(pings).toEqual([false, false, false]);
      // refuse：強制關閉所有經 proxy 的連線（含持有寫入鎖的交易），新連線一接受即關閉。
      proxy.refuse();
      expect(await appDb.ping(300)).toBe(false);
    } finally {
      // 與 pg-reconnect 相同的 teardown 順序（resume → close → stop），接著由 close() 終止同名 backend。
      // 不在 appDb.close() 之前 stop：Bun 1.3.14 時發現 sql.close() 在仍有等待連線的查詢、而目標已停止監聽時
      // 會占用 CPU 不返回（任務 26.1 的調查）。Bun 1.4.4 上先 stop 再 close({ timeout: 5 }) 約 35 ms 即返回
      // （任務 28.3），此順序保留以防回歸。
      proxy.resume();
      await appDb.close();
      proxy.stop();
      await first.close();
    }
    const outcomes = await Promise.all(pending);
    // 持有寫入鎖的交易在 refuse 時失去連線；blackhole 期間送出的交易可能在 resume 後完成，兩者都必須結束。
    expect(outcomes[0].ok).toBe(false);
    expect(outcomes).toHaveLength(2);

    const started = performance.now();
    const second = track(await createTestDatabase());
    await withWriteTx(second.sql, t => insertUser(t, 'after-outage'));
    const [{ n }] = await second.sql`SELECT count(*)::int AS n FROM users WHERE id = 'after-outage'`;
    expect(n).toBe(1);
    expect(performance.now() - started).toBeLessThan(10_000);
    await second.close();
  }, 60_000);

  describe('Migration_Runner lock held by another session', () => {
    let db, onlyInitialDir, files;
    beforeAll(async () => {
      files = await readMigrationFiles(MIGRATIONS_DIR);
      onlyInitialDir = await mkdtemp(join(tmpdir(), 'lm-isolation-0001-'));
      const initial = files.find(f => f.name === '0001_initial.sql');
      await writeFile(join(onlyInitialDir, initial.name), initial.content);
      db = track(await createTestDatabase({ migrationsDir: onlyInitialDir }));
    }, 60_000);
    afterAll(async () => {
      await db?.close();
      if (onlyInitialDir) await rm(onlyInitialDir, { recursive: true, force: true });
    }, 30_000);

    test('runMigrations on a connection with a 1s lock_timeout fails with 55P03, exits non-zero and records nothing', async () => {
      const before = await db.sql`SELECT version FROM schema_migrations ORDER BY version`;
      expect(before.map(r => r.version)).toEqual([1]);

      // 另一條連線（與測試 Database 同名，close() 會一併終止）持有 726362。
      const holder = openTestPool(DATABASE, db.sessionParams, { max: 1 });
      const short = openTestPool(DATABASE, { ...db.sessionParams, lock_timeout: '1s' }, { max: 2 });
      const reserved = await holder.reserve();
      const errors = [];
      try {
        await reserved`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
        // 記錄 runMigrations 在保留連線上遇到的錯誤（runMigrations 只回傳訊息文字）。
        const recording = {
          async reserve() {
            const conn = await short.reserve();
            const tag = (strings, ...values) => (async () => {
              try { return await conn(strings, ...values); } catch (error) { errors.push(error); throw error; }
            })();
            tag.unsafe = (...args) => conn.unsafe(...args);
            tag.begin = (...args) => conn.begin(...args);
            tag.release = () => conn.release();
            return tag;
          },
        };
        const started = performance.now();
        const result = await runMigrations(recording, loadMigrations(files), { log: () => {} });
        const elapsed = performance.now() - started;

        expect(result.exitCode).not.toBe(EXIT_OK);
        expect(result.applied).toEqual([]);
        expect(errors.map(e => e.errno)).toEqual([LOCK_NOT_AVAILABLE]);
        expect(elapsed).toBeLessThan(10_000);
      } finally {
        await reserved`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
        reserved.release();
        await holder.close({ timeout: 5 });
        await short.close({ timeout: 5 });
      }
      const after = await db.sql`SELECT version FROM schema_migrations ORDER BY version`;
      expect(after.map(r => r.version)).toEqual([1]);
    }, 20_000);
  });

  test('close() leaves no backend with the test application_name, and an abandoned BEGIN does not hold close() past 10 s', async () => {
    const db = track(await createTestDatabase());
    const name = db.sessionParams.application_name;
    // 一條保留連線開始交易並取得寫入鎖，之後不 COMMIT、不 release。
    const conn = await db.sql.reserve();
    await conn`BEGIN`;
    await conn`SELECT pg_advisory_xact_lock(${WRITE_LOCK_KEY}::bigint)`;
    await insertUser(conn, 'abandoned');
    const { pids, advisoryLocks } = await inspectTestSessions(name);
    expect(pids.length).toBeGreaterThan(0);
    expect(advisoryLocks.some(l => pids.includes(l.pid) && l.objid === WRITE_LOCK_KEY && l.granted)).toBe(true);

    const started = performance.now();
    await db.close();
    expect(performance.now() - started).toBeLessThan(10_000);

    const after = await inspectTestSessions(name);
    expect(after.pids).toEqual([]);
    expect(after.advisoryLocks.filter(l => pids.includes(l.pid))).toEqual([]);
  }, 30_000);
});
