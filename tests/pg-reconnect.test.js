// 資料庫斷線恢復整合測試（Requirement 11.6、11.9；tasks.md 5.17）。
//
// 驗證：
//   - Database 無回應（同 `docker pause`：連線不被拒絕、只是不再回應）時，GET /healthz 於 5 秒內回應 503。
//   - Database 連線全部被切斷（同 DB 重啟）時，GET /healthz 於 5 秒內回應 503。
//   - 恢復後 30 秒內，不重建 db／service 物件（同一程序、同一連線池）/healthz 即回到 200，API 亦可使用。
//
// 斷線模擬方式：
//   預設以測試內的 TCP proxy（Bun.listen + Bun.connect，127.0.0.1:<隨機連接埠>）轉送至 Ephemeral_Database，
//   不會停止或暫停使用者的資料庫服務。
//     - blackhole：雙向暫停轉送（位元組保留在 proxy，恢復後送出），新連線照常接受但不回應，對應 `docker pause`。
//     - refuse：立即關閉所有既有連線，新連線一接受即關閉，對應 DB 重啟。
//   CI 模式：設定 CAMPING_TEST_DB_CONTAINER（Ephemeral_Database 容器名稱）時，另以 `docker pause/unpause`
//   真正暫停該容器；未設定時該測試會以明確的名稱標示為略過。
//
// 隔離（design.md Components §24.3）：App 連線池傳入測試 Database 的 sessionParams，伺服器端看到的
// application_name 與測試連線池相同。afterAll 依序 resume → svc.close → appDb.close → proxy.stop →
// 測試 Database 的 close()（終止所有同名 backend 並 DROP SCHEMA），之後斷言沒有殘留的 backend 與 advisory lock。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, inspectTestSessions, readTestDatabaseConfig } from './support/pg.js';
import { createTcpProxy } from './support/tcp-proxy.js';
import { createDatabase } from '../server/db/connect.js';
import { createAccountService } from '../server/accounts.js';
import { createHttpHandler } from '../server/http.js';

// 未設定 CAMPING_TEST_DATABASE_* 時載入即失敗（不靜默略過）。
readTestDatabaseConfig();
const ROOT = fileURLToPath(new URL('../dist/', import.meta.url));
const BASE = 'http://127.0.0.1:5173';
const FAKE_SERVER = { requestIP: () => ({ address: '127.0.0.1' }) };
const OUTAGE_LIMIT_MS = 5000;
const RECOVERY_LIMIT_MS = 30000;
const CONTAINER = process.env.CAMPING_TEST_DB_CONTAINER || '';

let db, proxy, appDb, svc, handler;

beforeAll(async () => {
  db = await createTestDatabase();
  const { host, port } = db.config;
  proxy = createTcpProxy({ targetHost: host, targetPort: port });
  // App 的連線池經由 proxy 連到測試 schema；與 serve.mjs 相同使用 createDatabase 的預設連線池選項，
  // startup 參數為測試 Database 的 sessionParams（search_path、application_name 與逾時）。
  appDb = createDatabase({ ...db.config, host: '127.0.0.1', port: proxy.port }, { connection: db.sessionParams });
  svc = await createAccountService({ db: appDb });
  handler = createHttpHandler({ root: ROOT, accounts: svc, allowedHosts: ['127.0.0.1'], health: () => appDb.ping(2000) });
}, 60_000);

afterAll(async () => {
  if (!db) return;
  const name = db.sessionParams.application_name;
  // teardown 前屬於本測試檔的 backend（測試連線池與經 proxy 的 App 連線池）。
  const { pids: before } = await inspectTestSessions(name);
  proxy?.resume();
  svc?.close();
  await appDb?.close();
  proxy?.stop();
  await db.close();
  const after = await inspectTestSessions(name);
  expect(after.pids).toEqual([]);
  expect(after.advisoryLocks.filter(l => before.includes(l.pid))).toEqual([]);
}, 30_000);

const healthz = async () => {
  const started = performance.now();
  const res = await handler(new Request(`${BASE}/healthz`, { headers: { Host: '127.0.0.1' } }), FAKE_SERVER);
  const body = await res.json();
  return { status: res.status, body, elapsed: performance.now() - started };
};

const session = async () => {
  const res = await handler(new Request(`${BASE}/api/session`, { headers: { Host: '127.0.0.1' } }), FAKE_SERVER);
  return res.status;
};

/** 每 500 ms 檢查一次 /healthz，直到 200；回傳自恢復起的耗時與最後狀態。 */
async function waitHealthy(limitMs = RECOVERY_LIMIT_MS) {
  const started = performance.now();
  let last;
  while (performance.now() - started < limitMs) {
    last = await healthz();
    if (last.status === 200) return { ok: true, elapsed: performance.now() - started, last };
    await Bun.sleep(500);
  }
  return { ok: false, elapsed: performance.now() - started, last };
}

async function expectOutage() {
  // 連續數次：持續斷線時每次都必須在 5 秒內回應失敗（含連線池中有掛起查詢的情況）。
  for (let i = 0; i < 3; i++) {
    const r = await healthz();
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ status: 'error', database: 'unavailable' });
    expect(r.elapsed).toBeLessThan(OUTAGE_LIMIT_MS);
  }
}

async function expectRecovered(sameDb, sameSvc) {
  const r = await waitHealthy();
  expect(r.ok).toBe(true);
  expect(r.elapsed).toBeLessThan(RECOVERY_LIMIT_MS);
  expect(r.last.body).toEqual({ status: 'ok', database: 'ok' });
  // 不重建物件：仍是同一個連線池與服務實例
  expect(appDb).toBe(sameDb);
  expect(svc).toBe(sameSvc);
  // 服務本身的查詢也恢復
  expect(await session()).toBe(200);
}

describe('Database 斷線與恢復（Req 11.6、11.9）', () => {
  test('baseline: /healthz is 200 through the proxy', async () => {
    const r = await healthz();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'ok', database: 'ok' });
    expect(await session()).toBe(200);
  }, 30_000);

  test('unresponsive Database (proxy blackhole, like docker pause): 503 within 5 s, then 200 within 30 s without restart', async () => {
    const sameDb = appDb, sameSvc = svc;
    expect((await healthz()).status).toBe(200);
    proxy.blackhole();
    try {
      await expectOutage();
    } finally {
      proxy.resume();
    }
    await expectRecovered(sameDb, sameSvc);
  }, 90_000);

  test('dropped connections (proxy hard-close, like a DB restart): 503 within 5 s, then 200 within 30 s without restart', async () => {
    const sameDb = appDb, sameSvc = svc;
    expect((await healthz()).status).toBe(200);
    proxy.refuse();
    try {
      await expectOutage();
      expect(proxy.connections).toBe(0);
    } finally {
      proxy.resume();
    }
    await expectRecovered(sameDb, sameSvc);
  }, 90_000);

  test('prolonged unresponsive outage (> 10 s, many hung pings) still answers 503 within 5 s and recovers within 30 s', async () => {
    const sameDb = appDb, sameSvc = svc;
    proxy.blackhole();
    try {
      await expectOutage();
      await Bun.sleep(2000);
      await expectOutage();
    } finally {
      proxy.resume();
    }
    await expectRecovered(sameDb, sameSvc);
  }, 120_000);

  const dockerTitle = CONTAINER
    ? 'docker pause/unpause of CAMPING_TEST_DB_CONTAINER: 503 within 5 s, then 200 within 30 s without restart'
    : 'docker pause/unpause mode (skipped: CAMPING_TEST_DB_CONTAINER is not set; proxy modes above cover the outage)';
  test.skipIf(!CONTAINER)(dockerTitle, async () => {
    const docker = args => {
      const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000 });
      if (r.status !== 0) throw new Error(`docker ${args[0]} 失敗（結束碼 ${r.status}）`);
    };
    const sameDb = appDb, sameSvc = svc;
    expect((await healthz()).status).toBe(200);
    docker(['pause', CONTAINER]);
    try {
      await expectOutage();
    } finally {
      docker(['unpause', CONTAINER]);
    }
    await expectRecovered(sameDb, sameSvc);
  }, 120_000);
});
