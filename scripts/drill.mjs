// 還原演練工具（Requirement 14.6、14.7、21.10；design.md Components §13、§14；tasks 14.5）。
//
// 由 scripts/build-server.mjs 打包為 App_Image 內的 /app/tools/drill.js；Deploy_Host 的 `lm-deploy <env> drill`
// 以 deploy/compose/drill.yaml 的 `tool` 服務（與 Migration_Runner 相同：同一 App_Image、同一組 server/ 模組）
// 在 drill 專用的 internal 網路內執行：
//
//   bun /app/tools/drill.js run
//
// 步驟（任一步失敗即停止；已登入時仍會登出）：
//   wait-healthy  120 秒內連續 3 次 GET /healthz 成功（每 2 秒一次、每次 5 秒逾時）
//   seed-admin    在 drill DB 內插入一個臨時合成管理員：密碼以 App 的 hashPassword（server/accounts.js）雜湊，
//                 以 server/db/queries.js 的 insertUser 寫入。只存在於 drill DB，演練結束即隨資料卷銷毀。
//   fixture       以合成管理員經 App 的 HTTP API 登入 → POST /api/trips 建立 smoke-fixture 行程 → 登出
//   smoke         scripts/smoke.mjs 的 runSmoke（與 Staging／Production 相同的 Smoke_Test）
//
// 環境變數：
//   CAMPING_DATABASE_HOST／PORT／NAME／USER／PASSWORD／SSLMODE   drill DB（由 server/config.js parseConfig 驗證）
//   CAMPING_SMOKE_BASE_URL、CAMPING_SMOKE_HOST、CAMPING_SMOKE_USERNAME、CAMPING_SMOKE_PASSWORD(_FILE)、CAMPING_SMOKE_FIXTURE
//   CAMPING_DRILL_PROJECT   drill Compose 專案名稱 lm-drill-<env>-<8 hex>
//
// 防呆（避免誤用於正式 Database）：CAMPING_DATABASE_NAME 必須為 `lm_drill`、CAMPING_DRILL_PROJECT 必須符合
// lm-drill-<env>-<8 hex>、合成帳號名稱必須為 lm-drill-<8 hex>，且帳號已存在時不覆寫、直接失敗。
//
// 輸出：stdout 一行 JSON { ok, failedStep, steps:[{step,status,ms,result,reason?}], smoke }；只含步驟名稱、
// 狀態碼、耗時與結果，不含回應內容、帳號密碼、Cookie 或資料庫內容（Req 21.10）。
// 結束碼：0 全部通過；1 任一步驟失敗；2 設定錯誤。
import { randomUUID } from 'node:crypto';
import { parseConfig } from '../server/config.js';
import { hashPassword } from '../server/accounts.js';
import { createDatabase } from '../server/db/connect.js';
import { insertUser, userByName } from '../server/db/queries.js';
import { effectiveOrigin, readSmokeConfig, runSmoke } from './smoke.mjs';

export const DRILL_DATABASE_NAME = 'lm_drill';
export const DRILL_PROJECT_RE = /^lm-drill-(staging|prod)-[0-9a-f]{8}$/;
export const DRILL_USERNAME_RE = /^lm-drill-[0-9a-f]{8}$/;
export const MIN_DRILL_PASSWORD_LENGTH = 32;
export const DISPLAY_NAME = 'Restore Drill Bot';
export const STEPS = Object.freeze(['wait-healthy', 'seed-admin', 'fixture', 'smoke']);
export const HEALTH_WINDOW_MS = 120000;
export const HEALTH_CONSECUTIVE = 3;
export const HEALTH_INTERVAL_MS = 2000;
export const HEALTH_TIMEOUT_MS = 5000;
export const STEP_TIMEOUT_MS = 10000;
// 固定日期，使合成行程可重現；只需是有效且不超過 31 天的範圍。
export const FIXTURE_DATES = Object.freeze({ startDate: '2030-01-01', endDate: '2030-01-02' });

const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));
const hostHeaders = host => (host ? { Host: host } : {});
const failKind = err => (err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network');

/** 驗證設定；錯誤只列變數名與原因，不含值。 */
export function readDrillConfig(env = process.env, deps = {}) {
  const problems = [];
  const smoke = readSmokeConfig(env, deps);
  if (!smoke.ok) problems.push(...smoke.problems);
  const parsed = parseConfig({
    CAMPING_DATABASE_HOST: env.CAMPING_DATABASE_HOST,
    CAMPING_DATABASE_PORT: env.CAMPING_DATABASE_PORT,
    CAMPING_DATABASE_NAME: env.CAMPING_DATABASE_NAME,
    CAMPING_DATABASE_USER: env.CAMPING_DATABASE_USER,
    CAMPING_DATABASE_PASSWORD: env.CAMPING_DATABASE_PASSWORD,
    CAMPING_DATABASE_SSLMODE: env.CAMPING_DATABASE_SSLMODE,
  });
  if (!parsed.ok) problems.push(...parsed.errors);
  else if (parsed.config.database.name !== DRILL_DATABASE_NAME) problems.push({ name: 'CAMPING_DATABASE_NAME', reason: `must be ${DRILL_DATABASE_NAME}` });
  if (!DRILL_PROJECT_RE.test(env.CAMPING_DRILL_PROJECT ?? '')) problems.push({ name: 'CAMPING_DRILL_PROJECT', reason: 'must be lm-drill-<env>-<8 hex>' });
  if (smoke.ok) {
    if (!DRILL_USERNAME_RE.test(smoke.config.username)) problems.push({ name: 'CAMPING_SMOKE_USERNAME', reason: 'must be lm-drill-<8 hex>' });
    if ([...smoke.config.password].length < MIN_DRILL_PASSWORD_LENGTH || [...smoke.config.password].length > 128) {
      problems.push({ name: 'CAMPING_SMOKE_PASSWORD', reason: `length must be ${MIN_DRILL_PASSWORD_LENGTH}-128` });
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, smoke: smoke.config, database: parsed.config.database };
}

/** 以固定間隔輪詢 GET /healthz，直到連續 n 次 200；視窗內未達成即失敗。 */
export async function waitHealthy({ baseUrl, host = null }, {
  fetchImpl = globalThis.fetch, now = () => performance.now(), sleep = sleepMs,
  windowMs = HEALTH_WINDOW_MS, n = HEALTH_CONSECUTIVE, intervalMs = HEALTH_INTERVAL_MS, timeoutMs = HEALTH_TIMEOUT_MS,
} = {}) {
  const started = now();
  let streak = 0, attempts = 0, last = null;
  while (now() - started <= windowMs) {
    attempts++;
    let status = null;
    try {
      const res = await fetchImpl(new URL('/healthz', baseUrl), { method: 'GET', redirect: 'manual', headers: hostHeaders(host), signal: AbortSignal.timeout(timeoutMs) });
      status = res.status;
      await res.arrayBuffer().catch(() => null);
    } catch { status = null; }
    last = status;
    streak = status === 200 ? streak + 1 : 0;
    if (streak >= n) return { ok: true, attempts, status: last };
    await sleep(intervalMs);
  }
  return { ok: false, attempts, status: last };
}

/**
 * 在 drill DB 插入臨時合成管理員（與 POST /api/setup 相同的 hashPassword 與 insertUser）。
 * 帳號名稱已存在時不覆寫、直接失敗。回傳新使用者的 id。
 */
export async function seedAdmin(sql, { username, password }, { clock = Date.now, hash = hashPassword } = {}) {
  if (!DRILL_USERNAME_RE.test(username)) throw new TypeError('合成帳號名稱格式無效');
  const passwordHash = await hash(password);
  return sql.begin(async t => {
    if (await userByName(t, username)) {
      const err = new Error('合成帳號已存在');
      err.code = 'exists';
      throw err;
    }
    const id = randomUUID();
    if ((await insertUser(t, id, username, DISPLAY_NAME, 'admin', passwordHash, clock())) !== 1) throw new Error('插入合成帳號失敗');
    return id;
  });
}

function sessionFrom(res) {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const m = line.match(/^ggc_session=([^;]*)/);
    if (m && m[1]) return m[1];
  }
  return null;
}

/** 以合成管理員登入 → 建立 smoke-fixture 行程 → 登出（皆經 App 的 HTTP API）。 */
export async function createFixture({ baseUrl, host = null, username, password, fixture }, userId, {
  fetchImpl = globalThis.fetch, now = () => performance.now(), timeoutMs = STEP_TIMEOUT_MS,
} = {}) {
  const origin = effectiveOrigin(baseUrl, host);
  const steps = [];
  let session = null, failed = false;
  async function step(name, path, body, check) {
    if (failed) { steps.push({ step: name, status: null, ms: 0, result: 'skipped' }); return; }
    const started = now();
    let status = null, reason = null;
    try {
      const headers = { 'Content-Type': 'application/json', Origin: origin, ...hostHeaders(host), ...(session ? { Cookie: `ggc_session=${session}` } : {}) };
      const res = await fetchImpl(new URL(path, baseUrl), { method: 'POST', redirect: 'manual', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      status = res.status;
      reason = await check(res);
    } catch (err) { reason = failKind(err); }
    const entry = { step: name, status, ms: Math.round(now() - started), result: reason ? 'fail' : 'pass' };
    if (reason) entry.reason = reason;
    steps.push(entry);
    if (reason) failed = true;
  }
  await step('fixture-login', '/api/login', { username, password }, async res => {
    const body = await res.json().catch(() => null);
    if (res.status !== 200) return 'status';
    session = sessionFrom(res);
    if (!session) return 'no-session';
    return body?.user?.id === userId ? null : 'body';
  });
  await step('fixture-create', '/api/trips', { title: fixture, ...FIXTURE_DATES, expectedUserId: userId }, async res => {
    const body = await res.json().catch(() => null);
    if (res.status !== 201) return 'status';
    return body?.trip?.title === fixture ? null : 'body';
  });
  if (session) failed = false;
  await step('fixture-logout', '/api/logout', {}, async res => {
    await res.arrayBuffer().catch(() => null);
    return res.status === 200 ? null : 'status';
  });
  return { ok: steps.every(s => s.result === 'pass'), steps };
}

/**
 * 依序執行 wait-healthy → seed-admin → fixture → smoke。
 * @param {{sql:object, smoke:object}} target  sql：drill DB 連線池；smoke：readSmokeConfig 的 config
 */
export async function runDrill({ sql, smoke }, deps = {}) {
  const { now = () => performance.now() } = deps;
  const steps = [];
  let smokeResult = null;
  const done = failedStep => ({ ok: failedStep === null, failedStep, steps, smoke: smokeResult });
  const record = (step, started, ok, extra = {}) => {
    steps.push({ step, status: extra.status ?? null, ms: Math.round(now() - started), result: ok ? 'pass' : 'fail', ...(ok || !extra.reason ? {} : { reason: extra.reason }) });
    return ok;
  };

  let t = now();
  const health = await waitHealthy(smoke, deps);
  if (!record('wait-healthy', t, health.ok, { status: health.status, reason: 'unhealthy' })) return done('wait-healthy');

  t = now();
  let userId = null, reason = null;
  try { userId = await seedAdmin(sql, smoke, deps); }
  catch (err) { reason = err?.code === 'exists' ? 'exists' : 'database'; }
  if (!record('seed-admin', t, userId !== null, { reason })) return done('seed-admin');

  t = now();
  const fixture = await createFixture(smoke, userId, deps);
  const failedFixture = fixture.steps.find(s => s.result === 'fail');
  if (!record('fixture', t, fixture.ok, { status: failedFixture?.status ?? null, reason: failedFixture ? `${failedFixture.step}:${failedFixture.reason}` : null })) return done('fixture');

  t = now();
  smokeResult = await runSmoke(smoke, deps);
  const failedSmoke = smokeResult.steps.find(s => s.result === 'fail');
  if (!record('smoke', t, smokeResult.ok, { status: failedSmoke?.status ?? null, reason: failedSmoke ? `${failedSmoke.step}:${failedSmoke.reason}` : null })) return done('smoke');
  return done(null);
}

export async function main(argv = process.argv.slice(2), env = process.env, { log = console.log, error = console.error, connect = createDatabase, ...deps } = {}) {
  if (argv.length !== 1 || argv[0] !== 'run') {
    error('用法：bun /app/tools/drill.js run');
    return 2;
  }
  const parsed = readDrillConfig(env, deps);
  if (!parsed.ok) {
    for (const p of parsed.problems) error(`還原演練設定無效 ${p.name}: ${p.reason}`);
    return 2;
  }
  const db = connect(parsed.database, { max: 2, connectionTimeout: 10 });
  try {
    const result = await runDrill({ sql: db.sql, smoke: parsed.smoke }, deps);
    log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  } finally {
    await db.close();
  }
}

if (import.meta.main) process.exit(await main());
