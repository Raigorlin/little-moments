// 映像層級 Smoke 測試的流程整合測試（Requirement 16.2、18.3；tasks 12.3）。
// 以真實的 App_Server 處理器（createAccountService + createHttpHandler）連線 Ephemeral_Database，模擬
// ci/scripts/image-smoke.sh 在容器內的設定：非 loopback Bind_Address（需要 Setup_Token）、Allowed_Hosts 只含
// 容器名稱，且以該名稱作為 Host。依序執行 wait-healthy → seed → scripts/smoke.mjs，確認輔助腳本建立的
// 合成資料足以讓 Smoke_Test 全部通過。需要 CAMPING_TEST_DATABASE_*（見 tests/support/pg.js）。
// 伺服器只綁定 127.0.0.1。
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTestDatabase } from './support/pg.js';
import { createAccountService } from '../server/accounts.js';
import { pingSql } from '../server/db/connect.js';
import { createHttpHandler } from '../server/http.js';
import { createSetupGuard } from '../server/setup-guard.js';
import { seedSmokeFixture, waitHealthy } from '../ci/scripts/image-smoke-seed.mjs';
import { runSmoke } from '../scripts/smoke.mjs';

const APP_HOST = 'lm-ismoke-test-0000-app';
const SETUP_TOKEN = 'placeholder-setup-token-'.padEnd(48, '0');
const PASSWORD = 'placeholder-smoke-password';
const db = useTestDatabase();
let svc, server, root, baseUrl;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'lm-ismoke-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>t</title>');
  // 與容器內相同：Bind_Address 非 loopback → Setup_Token 必填（不輸出任何值）。
  const setup = createSetupGuard({ bindAddress: '10.0.0.2', setupToken: SETUP_TOKEN, log: () => {} });
  svc = await createAccountService({ db: { sql: db.sql, ping: ms => pingSql(db.sql, ms), close: async () => {} }, setup });
  server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: createHttpHandler({ root, accounts: svc, allowedHosts: [APP_HOST], health: () => svc.ping(2000) }),
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  server?.stop(true);
  svc?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test('wait-healthy → seed → Smoke_Test 在全新資料庫上全部通過', async () => {
  const config = { baseUrl, host: `${APP_HOST}:${server.port}`, username: 'smoke-bot', password: PASSWORD, fixture: 'smoke-fixture' };

  const health = await waitHealthy(config, { intervalMs: 0, sleep: async () => {} });
  expect(health.healthy).toBe(true);

  // 錯誤的 Setup_Token 被拒絕，且不消耗正確的 Setup_Token。
  const denied = await seedSmokeFixture(config, 'wrong-'.padEnd(48, 'x'));
  expect(denied.ok).toBe(false);
  expect(denied.steps[0]).toMatchObject({ step: 'setup', status: 403 });

  const seeded = await seedSmokeFixture(config, SETUP_TOKEN);
  expect(seeded.steps.map(s => [s.step, s.status, s.result])).toEqual([
    ['setup', 200, 'pass'], ['create-fixture', 201, 'pass'], ['logout', 200, 'pass'],
  ]);

  const smoke = await runSmoke(config);
  expect(smoke.steps.map(s => [s.step, s.result])).toEqual([
    ['login-page', 'pass'], ['session', 'pass'], ['login', 'pass'], ['trips', 'pass'], ['logout', 'pass'],
  ]);
  expect(smoke.ok).toBe(true);

  // seed 只能在全新資料庫執行一次：Setup_Token 已失效、管理員已存在。
  const again = await seedSmokeFixture(config, SETUP_TOKEN);
  expect(again.steps[0]).toMatchObject({ step: 'setup', status: 409, result: 'fail' });
});
