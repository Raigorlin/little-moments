// Smoke_Test（Requirement 14.6、18.3、20.5、21.10；design.md Components §14）。
//
//   bun scripts/smoke.mjs        （Node.js 22 亦可：node scripts/smoke.mjs）
//
// 環境變數：
//   CAMPING_SMOKE_BASE_URL        必填。受測環境的連線 origin，例如 https://lm-staging.lan 或 http://127.0.0.1:8081
//   CAMPING_SMOKE_HOST            選填。覆寫 Host 標頭（host 或 host:port），用於以 IP 連線但須通過 Allowed_Hosts
//                                 的情境；設定時 POST 的 Origin 為「BASE_URL 協定 + 此 Host」，與伺服器重建的
//                                 有效請求網址逐字元相同（Req 10.1）。Host 覆寫在 Bun 下生效；Node 的 fetch 可能忽略。
//   CAMPING_SMOKE_USERNAME        合成帳號名稱，預設 smoke-bot
//   CAMPING_SMOKE_PASSWORD_FILE   合成帳號密碼檔（Jenkins file credential；優先於下一項）
//   CAMPING_SMOKE_PASSWORD        合成帳號密碼（僅在無法使用檔案時）
//   CAMPING_SMOKE_FIXTURE         合成行程標題，預設 smoke-fixture
//   內部 CA 憑證以 NODE_EXTRA_CA_CERTS 提供，不關閉 TLS 驗證。
//
// 合成資料：smoke-bot 帳號與其可見的 smoke-fixture 行程須事先存在。Staging／Production 由 Host_Operator 以
// Credential_Store 中的 smoke 憑證執行 `lm-deploy <env> smoke-account <digest>` 建立一次（映像內的
// scripts/create-smoke-account.mjs，即 /app/tools/create-smoke-account.js；Requirement 27、design.md §21）；
// 還原演練（lm-deploy drill）於還原後在 drill DB 內插入臨時合成管理員與行程（design.md §13、§14）。
// 兩者的行程日期皆為 SMOKE_FIXTURE_DATES。本腳本只讀取，不建立任何資料；行程不存在即失敗。
//
// 步驟：GET /login（200 且含 server/http.js 的 SECURITY_HEADERS，HTML 路由的 Cache-Control 須為 no-store）
// → GET /api/session → POST /api/login → GET /api/trips（確認合成行程存在）→ POST /api/logout。
// 每步逾時 10 秒；第一個失敗步驟之後的步驟標記為 skipped，但已登入時仍會登出。
// SECURITY_HEADERS 直接自 repository 的 server/http.js 匯入（Pipeline 在已 checkout 的工作目錄或映像 smoke
// 腳本旁執行），確保檢查值與實作相同。
// 輸出 JSON 只含步驟名稱、狀態碼、耗時、結果與失敗類別，不含任何回應內容或憑證（Req 21.10）。
// 結束碼：0 全部通過；1 任一步驟失敗；2 設定錯誤。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECURITY_HEADERS } from '../server/http.js';

export const STEPS = Object.freeze(['login-page', 'session', 'login', 'trips', 'logout']);
export const STEP_TIMEOUT_MS = 10000;
// Smoke_Fixture 的固定日期（create-smoke-account 與還原演練共用）；只需是有效且不超過 31 天的範圍。
export const SMOKE_FIXTURE_DATES = Object.freeze({ startDate: '2030-01-01', endDate: '2030-01-02' });
const COOKIE = 'ggc_session';
// host、host:port、[IPv6] 或 [IPv6]:port；不得含協定、路徑或認證資訊。
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/** 讀取並驗證設定；錯誤只列變數名與原因，不含值。 */
export function readSmokeConfig(env, { readFile = p => readFileSync(p, 'utf8') } = {}) {
  const problems = [];
  let baseUrl = null;
  if (!env.CAMPING_SMOKE_BASE_URL) problems.push({ name: 'CAMPING_SMOKE_BASE_URL', reason: 'unset' });
  else {
    try {
      const url = new URL(env.CAMPING_SMOKE_BASE_URL);
      if (!['http:', 'https:'].includes(url.protocol)) problems.push({ name: 'CAMPING_SMOKE_BASE_URL', reason: 'protocol must be http or https' });
      else if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) problems.push({ name: 'CAMPING_SMOKE_BASE_URL', reason: 'must be an origin without path, query or credentials' });
      else baseUrl = url.origin;
    } catch { problems.push({ name: 'CAMPING_SMOKE_BASE_URL', reason: 'not a URL' }); }
  }
  let host = null;
  if (env.CAMPING_SMOKE_HOST) {
    const port = env.CAMPING_SMOKE_HOST.match(/:(\d+)$/)?.[1];
    if (!HOST_RE.test(env.CAMPING_SMOKE_HOST) || (port !== undefined && (Number(port) < 1 || Number(port) > 65535))) problems.push({ name: 'CAMPING_SMOKE_HOST', reason: 'must be host or host:port' });
    else host = env.CAMPING_SMOKE_HOST.toLowerCase();
  }
  const username = env.CAMPING_SMOKE_USERNAME || 'smoke-bot';
  let password = '';
  if (env.CAMPING_SMOKE_PASSWORD_FILE) {
    try { password = readFile(env.CAMPING_SMOKE_PASSWORD_FILE).replace(/\r?\n$/, ''); }
    catch { problems.push({ name: 'CAMPING_SMOKE_PASSWORD_FILE', reason: 'unreadable' }); }
    if (!password && !problems.some(p => p.name === 'CAMPING_SMOKE_PASSWORD_FILE')) problems.push({ name: 'CAMPING_SMOKE_PASSWORD_FILE', reason: 'empty' });
  } else if (env.CAMPING_SMOKE_PASSWORD) password = env.CAMPING_SMOKE_PASSWORD;
  else problems.push({ name: 'CAMPING_SMOKE_PASSWORD_FILE', reason: 'unset (or set CAMPING_SMOKE_PASSWORD)' });
  const fixture = env.CAMPING_SMOKE_FIXTURE || 'smoke-fixture';
  return problems.length ? { ok: false, problems } : { ok: true, config: { baseUrl, host, username, password, fixture } };
}

const headersMatch = headers => Object.entries(SECURITY_HEADERS).every(([k, v]) => headers.get(k) === v);

function sessionFrom(res) {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const m = line.match(/^ggc_session=([^;]*)/);
    if (m && m[1]) return m[1];
  }
  return null;
}

/** 有效 origin：設定 Host 覆寫時為「連線協定 + Host」，否則為 baseUrl。 */
export function effectiveOrigin(baseUrl, host) {
  return host ? `${new URL(baseUrl).protocol}//${host}` : new URL(baseUrl).origin;
}

/**
 * 執行 Smoke_Test。`fetch`（可放在 config 或 deps.fetchImpl）與 `now` 供測試注入。
 * check 回傳 null 表示通過，否則回傳失敗類別字串（不含回應內容）。
 * @returns {Promise<{ok:boolean, steps:{step:string, status:number|null, ms:number, result:'pass'|'fail'|'skipped', reason?:string}[]}>}
 */
export async function runSmoke({ baseUrl, host = null, username, password, fixture = 'smoke-fixture', fetch: configFetch }, { fetchImpl, now = () => performance.now(), timeoutMs = STEP_TIMEOUT_MS } = {}) {
  const doFetch = configFetch ?? fetchImpl ?? globalThis.fetch;
  const origin = effectiveOrigin(baseUrl, host);
  const steps = [];
  let session = null;
  let failed = false;

  async function step(name, path, init, check) {
    if (failed) { steps.push({ step: name, status: null, ms: 0, result: 'skipped' }); return; }
    const started = now();
    let status = null, reason = null;
    try {
      const headers = { ...(init.headers || {}), ...(host ? { Host: host } : {}) };
      const res = await doFetch(new URL(path, baseUrl), { redirect: 'manual', ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
      status = res.status;
      reason = await check(res);
    } catch (err) {
      // 逾時或連線錯誤：只記錄類別，不輸出錯誤內容。
      reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network';
    }
    const entry = { step: name, status, ms: Math.round(now() - started), result: reason ? 'fail' : 'pass' };
    if (reason) entry.reason = reason;
    steps.push(entry);
    if (reason) failed = true;
  }

  const authed = extra => ({ ...extra, ...(session ? { Cookie: `${COOKIE}=${session}` } : {}) });
  const drain = res => res.arrayBuffer().catch(() => null);
  await step('login-page', '/login', { method: 'GET' }, async res => {
    await drain(res);
    if (res.status !== 200) return 'status';
    return headersMatch(res.headers) ? null : 'headers';
  });
  await step('session', '/api/session', { method: 'GET' }, async res => {
    const body = await res.json().catch(() => null);
    if (res.status !== 200) return 'status';
    if (body === null || typeof body !== 'object') return 'body';
    return body.needsSetup === false ? null : 'needs-setup';
  });
  await step('login', '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username, password }),
  }, async res => {
    await drain(res);
    if (res.status !== 200) return 'status';
    session = sessionFrom(res);
    return session ? null : 'no-session';
  });
  await step('trips', '/api/trips', { method: 'GET', headers: authed({}) }, async res => {
    const body = await res.json().catch(() => null);
    if (res.status !== 200) return 'status';
    if (!Array.isArray(body?.trips)) return 'body';
    return body.trips.some(t => t?.title === fixture) ? null : 'fixture-missing';
  });
  // 已登入就一定登出，即使前面步驟失敗，避免留下有效 Session。
  if (session) failed = false;
  await step('logout', '/api/logout', {
    method: 'POST',
    headers: authed({ 'Content-Type': 'application/json', Origin: origin }),
    body: '{}',
  }, async res => {
    await drain(res);
    return res.status === 200 ? null : 'status';
  });
  // 登出之前已有失敗步驟時，整體仍為失敗。
  const ok = steps.every(s => s.result === 'pass');
  return { ok, steps };
}

export async function main(env = process.env, { log = console.log, error = console.error, ...deps } = {}) {
  const parsed = readSmokeConfig(env, deps);
  if (!parsed.ok) {
    for (const p of parsed.problems) error(`Smoke_Test 設定無效 ${p.name}: ${p.reason}`);
    return 2;
  }
  const result = await runSmoke(parsed.config, deps);
  log(JSON.stringify(result));
  return result.ok ? 0 : 1;
}

const isMain = import.meta.main ?? (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) process.exit(await main());
