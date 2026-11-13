// 還原演練工具 scripts/drill.mjs（打包為 /app/tools/drill.js）的測試（Requirement 14.6、14.7、21.10；tasks 14.5）。
//
// 以真實的 App_Server 處理器（createAccountService + createHttpHandler）連線 Ephemeral_Database，模擬 drill 網路內的設定：
// 非 loopback Bind_Address、Allowed_Hosts 只含 `app`，Database 內已有「還原自 Production」的既有使用者。
// 依序執行 wait-healthy → seed-admin → fixture → Smoke_Test，確認臨時合成管理員足以讓 Smoke_Test 全部通過，
// 且輸出不含任何帳號密碼或既有資料。需要 CAMPING_TEST_DATABASE_*（見 tests/support/pg.js）。伺服器只綁定 127.0.0.1。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rejectionOf, useTestDatabase } from './support/pg.js';
import { createAccountService, hashPassword, verifyPassword } from '../server/accounts.js';
import { pingSql } from '../server/db/connect.js';
import { createHttpHandler } from '../server/http.js';
import { createSetupGuard } from '../server/setup-guard.js';
import { insertUser } from '../server/db/queries.js';
import { DRILL_USERNAME_RE, main, readDrillConfig, runDrill, seedAdmin, waitHealthy } from '../scripts/drill.mjs';

const APP_HOST = 'app';
const DRILL_PASSWORD = 'placeholder-drill-password-'.padEnd(48, '0');
const EXISTING_PASSWORD = 'placeholder-existing-password';
const db = useTestDatabase();
let svc, server, root, baseUrl;

const baseEnv = () => ({
  CAMPING_DATABASE_HOST: 'db', CAMPING_DATABASE_PORT: '5432', CAMPING_DATABASE_NAME: 'lm_drill',
  CAMPING_DATABASE_USER: 'lm_drill', CAMPING_DATABASE_PASSWORD: 'placeholder-db-password', CAMPING_DATABASE_SSLMODE: 'disable',
  CAMPING_DRILL_PROJECT: 'lm-drill-prod-0123abcd', CAMPING_SMOKE_BASE_URL: 'http://app:5173',
  CAMPING_SMOKE_USERNAME: 'lm-drill-89abcdef', CAMPING_SMOKE_PASSWORD: DRILL_PASSWORD,
});

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'lm-drill-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>t</title>');
  const setup = createSetupGuard({ bindAddress: '10.0.0.2', setupToken: 'placeholder-setup-token-'.padEnd(48, '0'), log: () => {} });
  svc = await createAccountService({ db: { sql: db.sql, ping: ms => pingSql(db.sql, ms), close: async () => {} }, setup });
  server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: createHttpHandler({ root, accounts: svc, allowedHosts: [APP_HOST], health: () => svc.ping(2000) }),
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
  // 模擬還原後的 Production 資料：既有管理員與其私人行程（演練不得讀出或輸出）。
  await insertUser(db.sql, 'existing-admin-id', 'alice', 'Alice', 'admin', await hashPassword(EXISTING_PASSWORD), Date.now());
});
afterAll(() => {
  server?.stop(true);
  svc?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('readDrillConfig 防呆', () => {
  test('合法的 drill 設定通過', () => {
    const r = readDrillConfig(baseEnv());
    expect(r.ok).toBe(true);
    expect(r.database.name).toBe('lm_drill');
    expect(DRILL_USERNAME_RE.test(r.smoke.username)).toBe(true);
  });

  test.each([
    ['CAMPING_DATABASE_NAME', 'little_moments'],
    ['CAMPING_DRILL_PROJECT', 'lm-prod'],
    ['CAMPING_SMOKE_USERNAME', 'smoke-bot'],
    ['CAMPING_SMOKE_PASSWORD', 'short-password'],
  ])('%s 不符合 drill 格式時拒絕', (name, value) => {
    const r = readDrillConfig({ ...baseEnv(), [name]: value });
    expect(r.ok).toBe(false);
    expect(r.problems.map(p => p.name)).toContain(name);
    if (name === 'CAMPING_SMOKE_PASSWORD') expect(JSON.stringify(r)).not.toContain(value);
  });

  test('main：參數或設定錯誤以結束碼 2 結束，訊息不含密碼', async () => {
    const errors = [];
    expect(await main([], baseEnv(), { error: m => errors.push(m), log: () => {} })).toBe(2);
    expect(await main(['run'], { ...baseEnv(), CAMPING_DATABASE_NAME: 'prod_db' }, { error: m => errors.push(m), log: () => {} })).toBe(2);
    expect(errors.join('\n')).not.toContain(DRILL_PASSWORD);
    expect(errors.join('\n')).not.toContain('placeholder-db-password');
  });
});

test('waitHealthy：需要連續 3 次 200，視窗內未達成即失敗', async () => {
  let clock = 0;
  const seq = [200, 500, 200, 200, 200];
  const fetchImpl = async () => new Response('', { status: seq.shift() ?? 500 });
  const ok = await waitHealthy({ baseUrl: 'http://app:5173' }, { fetchImpl, now: () => clock, sleep: async ms => { clock += ms; } });
  expect(ok).toMatchObject({ ok: true, attempts: 5 });
  clock = 0;
  const bad = await waitHealthy({ baseUrl: 'http://app:5173' }, { fetchImpl: async () => new Response('', { status: 503 }), now: () => clock, sleep: async ms => { clock += ms; } });
  expect(bad.ok).toBe(false);
});

test('還原後的 Database：插入臨時合成管理員 → smoke-fixture → Smoke_Test 全部通過，輸出不含秘密或既有資料', async () => {
  const smoke = { baseUrl, host: `${APP_HOST}:${server.port}`, username: 'lm-drill-89abcdef', password: DRILL_PASSWORD, fixture: 'smoke-fixture' };
  const result = await runDrill({ sql: db.sql, smoke }, { intervalMs: 0, sleep: async () => {} });
  expect(result.steps.map(s => [s.step, s.result])).toEqual([
    ['wait-healthy', 'pass'], ['seed-admin', 'pass'], ['fixture', 'pass'], ['smoke', 'pass'],
  ]);
  expect(result.ok).toBe(true);
  expect(result.failedStep).toBeNull();
  expect(result.smoke.steps.every(s => s.result === 'pass')).toBe(true);

  // 合成管理員以 App 的 hashPassword 雜湊（scrypt），角色為 admin；既有使用者不受影響。
  const [row] = await db.sql`SELECT role, password_hash FROM users WHERE username = ${'lm-drill-89abcdef'}`;
  expect(row.role).toBe('admin');
  expect(row.password_hash.startsWith('scrypt$')).toBe(true);
  expect(await verifyPassword(DRILL_PASSWORD, row.password_hash)).toBe(true);
  const [alice] = await db.sql`SELECT role, password_hash FROM users WHERE username = ${'alice'}`;
  expect(alice.role).toBe('admin');
  expect(await verifyPassword(EXISTING_PASSWORD, alice.password_hash)).toBe(true);

  const text = JSON.stringify(result);
  for (const secret of [DRILL_PASSWORD, EXISTING_PASSWORD, 'ggc_session', 'alice']) expect(text).not.toContain(secret);
  // 只含步驟名稱、狀態碼、耗時與結果（JSON 字元集與 lm-deploy 嵌入時的檢查相同）。
  expect(text).toMatch(/^\{[\][{}"A-Za-z0-9_:,.-]*\}$/);
});

test('合成帳號已存在時不覆寫並在 seed-admin 失敗', async () => {
  const before = await db.sql`SELECT password_hash FROM users WHERE username = ${'lm-drill-89abcdef'}`;
  // rejectionOf：Bun 1.3.14 時發現 expect(<查詢 Database 的 promise>).rejects 可能等不到查詢；
  // Bun 1.4.4 上已不重現，保留以防回歸（tests/support/pg.js）。
  expect(await rejectionOf(seedAdmin(db.sql, { username: 'lm-drill-89abcdef', password: 'another-placeholder-password-'.padEnd(40, '1') }))).toMatchObject({ code: 'exists' });
  const after = await db.sql`SELECT password_hash FROM users WHERE username = ${'lm-drill-89abcdef'}`;
  expect(after[0].password_hash).toBe(before[0].password_hash);

  const smoke = { baseUrl, host: `${APP_HOST}:${server.port}`, username: 'lm-drill-89abcdef', password: DRILL_PASSWORD, fixture: 'smoke-fixture' };
  const result = await runDrill({ sql: db.sql, smoke }, { intervalMs: 0, sleep: async () => {} });
  expect(result).toMatchObject({ ok: false, failedStep: 'seed-admin', smoke: null });
  expect(result.steps.at(-1)).toMatchObject({ step: 'seed-admin', result: 'fail', reason: 'exists' });
});

test('seedAdmin 只接受 lm-drill-<8 hex> 帳號名稱', async () => {
  await expect(seedAdmin(db.sql, { username: 'smoke-bot', password: DRILL_PASSWORD })).rejects.toThrow(TypeError);
  const rows = await db.sql`SELECT 1 FROM users WHERE username = ${'smoke-bot'}`;
  expect(rows.length).toBe(0);
});
