// 映像層級 Smoke 測試輔助（Requirement 16.2、18.3；tasks 12.3）。由 ci/scripts/image-smoke.sh 在與
// App 容器相同的 `--internal` 網路內執行，不在 Deploy_Host 或任何正式環境使用。
//
//   bun ci/scripts/image-smoke-seed.mjs wait-healthy   # 120 秒內連續 3 次 GET /healthz 成功
//   bun ci/scripts/image-smoke-seed.mjs seed           # 以 Setup_Token 建立合成管理員與 smoke-fixture 行程
//
// 環境變數（與 scripts/smoke.mjs 相同的名稱，由 readSmokeConfig 驗證）：
//   CAMPING_SMOKE_BASE_URL、CAMPING_SMOKE_HOST、CAMPING_SMOKE_USERNAME、CAMPING_SMOKE_PASSWORD(_FILE)、
//   CAMPING_SMOKE_FIXTURE；seed 另需 CAMPING_SETUP_TOKEN（App 容器的同一個值，僅存在於 Ephemeral_Database）。
//   wait-healthy 只需要 CAMPING_SMOKE_BASE_URL（與選用的 CAMPING_SMOKE_HOST）。
//
// 合成帳號與行程只建立在本次建置的 Ephemeral_Database，測試結束即隨資料庫容器銷毀。
// 輸出 JSON 只含步驟名稱、狀態碼、耗時與結果，不含回應內容、Cookie、密碼或 Setup_Token（Req 21.10）。
// 結束碼：0 成功；1 失敗；2 設定錯誤。
import { healthyAt } from '../health.mjs';
import { effectiveOrigin, readSmokeConfig } from '../../scripts/smoke.mjs';

export const HEALTH_WINDOW_SEC = 120;
export const HEALTH_CONSECUTIVE = 3;
export const HEALTH_INTERVAL_MS = 2000;
export const HEALTH_TIMEOUT_MS = 5000;
export const STEP_TIMEOUT_MS = 10000;
// 固定日期，讓合成行程的內容可重現；只要求為有效且不超過 31 天的日期範圍。
export const FIXTURE_DATES = Object.freeze({ startDate: '2030-01-01', endDate: '2030-01-02' });
export const DISPLAY_NAME = 'Smoke Bot';

const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));
const hostHeaders = host => (host ? { Host: host } : {});

/**
 * 以固定間隔輪詢 GET /healthz，直到視窗內連續 n 次成功（判定沿用 ci/health.mjs 的 healthyAt，Property 40）。
 * @returns {Promise<{healthy:boolean, at:number|null, attempts:{t:number,status:number|null,durationMs:number}[]}>}
 */
export async function waitHealthy({ baseUrl, host = null }, {
  fetchImpl = globalThis.fetch, now = () => performance.now(), sleep = sleepMs,
  windowSec = HEALTH_WINDOW_SEC, n = HEALTH_CONSECUTIVE, intervalMs = HEALTH_INTERVAL_MS, timeoutMs = HEALTH_TIMEOUT_MS,
} = {}) {
  const started = now();
  const attempts = [];
  for (;;) {
    const before = now();
    const t = (before - started) / 1000;
    if (t > windowSec) break;
    let status = null;
    try {
      const res = await fetchImpl(new URL('/healthz', baseUrl), { method: 'GET', redirect: 'manual', headers: hostHeaders(host), signal: AbortSignal.timeout(timeoutMs) });
      status = res.status;
      await res.arrayBuffer().catch(() => null);
    } catch { status = null; }
    const durationMs = Math.round(now() - before);
    attempts.push({ t: Math.round(t * 1000) / 1000, status, durationMs, ...(status === null ? { ok: false } : {}) });
    const at = healthyAt(attempts, windowSec, n);
    if (at !== null) return { healthy: true, at, attempts };
    await sleep(intervalMs);
  }
  return { healthy: false, at: null, attempts };
}

function sessionFrom(res) {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const m = line.match(/^ggc_session=([^;]*)/);
    if (m && m[1]) return m[1];
  }
  return null;
}

/**
 * 在全新（尚無使用者）的 Database 上：POST /api/setup 建立合成管理員 → POST /api/trips 建立合成行程
 * → POST /api/logout。任一步驟失敗即停止（登出仍會嘗試）。
 * @returns {Promise<{ok:boolean, steps:{step:string,status:number|null,ms:number,result:'pass'|'fail'|'skipped',reason?:string}[]}>}
 */
export async function seedSmokeFixture({ baseUrl, host = null, username, password, fixture }, setupToken, {
  fetchImpl = globalThis.fetch, now = () => performance.now(), timeoutMs = STEP_TIMEOUT_MS,
} = {}) {
  const origin = effectiveOrigin(baseUrl, host);
  const steps = [];
  let session = null, userId = null, failed = false;

  async function step(name, path, body, check) {
    if (failed) { steps.push({ step: name, status: null, ms: 0, result: 'skipped' }); return; }
    const started = now();
    let status = null, reason = null;
    try {
      const headers = { 'Content-Type': 'application/json', Origin: origin, ...hostHeaders(host), ...(session ? { Cookie: `ggc_session=${session}` } : {}) };
      const res = await fetchImpl(new URL(path, baseUrl), { method: 'POST', redirect: 'manual', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      status = res.status;
      reason = await check(res);
    } catch (err) {
      reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network';
    }
    const entry = { step: name, status, ms: Math.round(now() - started), result: reason ? 'fail' : 'pass' };
    if (reason) entry.reason = reason;
    steps.push(entry);
    if (reason) failed = true;
  }

  await step('setup', '/api/setup', { setupToken, username, displayName: DISPLAY_NAME, password }, async res => {
    const body = await res.json().catch(() => null);
    if (res.status !== 200) return 'status';
    session = sessionFrom(res);
    userId = typeof body?.user?.id === 'string' ? body.user.id : null;
    if (!session) return 'no-session';
    return userId ? null : 'body';
  });
  await step('create-fixture', '/api/trips', { title: fixture, ...FIXTURE_DATES, expectedUserId: userId }, async res => {
    const body = await res.json().catch(() => null);
    if (res.status !== 201) return 'status';
    return body?.trip?.title === fixture ? null : 'body';
  });
  if (session) failed = false;
  await step('logout', '/api/logout', {}, async res => {
    await res.arrayBuffer().catch(() => null);
    return res.status === 200 ? null : 'status';
  });
  return { ok: steps.every(s => s.result === 'pass'), steps };
}

export async function main(argv = process.argv.slice(2), env = process.env, { log = console.log, error = console.error, ...deps } = {}) {
  const [cmd] = argv;
  if (argv.length !== 1 || !['wait-healthy', 'seed'].includes(cmd)) {
    error('用法：bun ci/scripts/image-smoke-seed.mjs wait-healthy | seed');
    return 2;
  }
  if (cmd === 'wait-healthy') {
    // 只驗證連線設定；健康檢查不需要帳號密碼。
    const parsed = readSmokeConfig({ ...env, CAMPING_SMOKE_PASSWORD: env.CAMPING_SMOKE_PASSWORD || 'unused', CAMPING_SMOKE_PASSWORD_FILE: '' }, deps);
    if (!parsed.ok) {
      for (const p of parsed.problems) error(`image-smoke 設定無效 ${p.name}: ${p.reason}`);
      return 2;
    }
    const result = await waitHealthy(parsed.config, deps);
    log(JSON.stringify(result));
    if (!result.healthy) error(`${HEALTH_WINDOW_SEC} 秒內未達成連續 ${HEALTH_CONSECUTIVE} 次 Health_Check 成功`);
    return result.healthy ? 0 : 1;
  }
  const parsed = readSmokeConfig(env, deps);
  const problems = parsed.ok ? [] : [...parsed.problems];
  if (!env.CAMPING_SETUP_TOKEN) problems.push({ name: 'CAMPING_SETUP_TOKEN', reason: 'unset' });
  if (problems.length) {
    for (const p of problems) error(`image-smoke 設定無效 ${p.name}: ${p.reason}`);
    return 2;
  }
  const result = await seedSmokeFixture(parsed.config, env.CAMPING_SETUP_TOKEN, deps);
  log(JSON.stringify(result));
  return result.ok ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
