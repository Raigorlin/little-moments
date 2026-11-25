// Rust 版的 Smoke_Test（plan.md D9、D15）：經 LM_Proxy 檢查 lm-server、Auth 與 Realtime。
// scripts/smoke.mjs 是 Bun 版 App 的工具，不修改；本檔的輸出格式與它相同。
//
//   bun ci/smoke.mjs [--provision]
//
// 環境變數：
//   LM_SMOKE_BASE_URL       必填。受測環境的 origin（只有協定、主機與埠），例如 http://192.168.1.121:8081
//   LM_SMOKE_USERNAME       合成帳號名稱，預設 smoke-bot
//   LM_SMOKE_PASSWORD_FILE  必填。合成帳號密碼檔（Jenkins file credential）；結尾的換行不算密碼
// --provision（只用於 Staging）：登入回應 401 invalid_credentials 時，以 POST /api/auth/signup 建立一次合成帳號
//   （顯示名稱 smoke-bot），再登入一次。Production 不使用：它的 smoke-bot 由 Host_Operator 建立（plan.md D11）。
//
// 步驟（STEPS，每步逾時 10 秒；第一個失敗步驟之後的步驟標記為 skipped，但已登入時仍會登出）：
//   index     GET /              → 200 的 HTML，且引用 .wasm 或 .js（trunk 的輸出）
//   robots    GET /robots.txt    → 200（LM_Proxy 的 Health_Check 也使用這個路徑）
//   login     POST /api/auth/login {username,password} → 200 SessionDto（access_token 與相同的 user.username）
//   me        GET /api/me（Authorization: Bearer）→ 200 且 username 相同
//   trips     GET /api/trips（Authorization: Bearer）→ 200 的陣列
//   realtime  WebSocket /realtime/v1/websocket?vsn=1.0.0 → 開啟後送出 Phoenix heartbeat，收到 status ok 的 phx_reply
//   logout    POST /api/auth/logout（Authorization: Bearer）→ 200
// 輸出：一個 JSON 物件 {ok, steps:[{step,status,ms,result,reason?}]}，只含步驟名稱、狀態碼、耗時、結果與失敗類別；
// 不含 token、密碼或回應內容。內部 CA 憑證以 NODE_EXTRA_CA_CERTS 提供，不關閉 TLS 驗證。
// 結束碼：0 全部通過；1 任一步驟失敗；2 設定錯誤。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STEPS = Object.freeze(['index', 'robots', 'login', 'me', 'trips', 'realtime', 'logout']);
export const STEP_TIMEOUT_MS = 10000;
export const SMOKE_DISPLAY_NAME = 'smoke-bot';
export const REALTIME_PATH = '/realtime/v1/websocket?vsn=1.0.0';
export const HEARTBEAT = Object.freeze({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: '1' });

/** 讀取並驗證設定；錯誤只列變數名與原因，不含值。 */
export function readSmokeConfig(env, { readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  const problems = [];
  let baseUrl = null;
  if (!env.LM_SMOKE_BASE_URL) problems.push({ name: 'LM_SMOKE_BASE_URL', reason: 'unset' });
  else {
    try {
      const url = new URL(env.LM_SMOKE_BASE_URL);
      if (!['http:', 'https:'].includes(url.protocol)) problems.push({ name: 'LM_SMOKE_BASE_URL', reason: 'protocol must be http or https' });
      else if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) problems.push({ name: 'LM_SMOKE_BASE_URL', reason: 'must be an origin without path, query or credentials' });
      else baseUrl = url.origin;
    } catch { problems.push({ name: 'LM_SMOKE_BASE_URL', reason: 'not a URL' }); }
  }
  const username = env.LM_SMOKE_USERNAME || 'smoke-bot';
  let password = '';
  if (!env.LM_SMOKE_PASSWORD_FILE) problems.push({ name: 'LM_SMOKE_PASSWORD_FILE', reason: 'unset' });
  else {
    try {
      password = readFile(env.LM_SMOKE_PASSWORD_FILE).replace(/\r?\n$/, '');
      if (!password) problems.push({ name: 'LM_SMOKE_PASSWORD_FILE', reason: 'empty' });
    } catch { problems.push({ name: 'LM_SMOKE_PASSWORD_FILE', reason: 'unreadable' }); }
  }
  return problems.length ? { ok: false, problems } : { ok: true, config: { baseUrl, username, password } };
}

/** http(s)://host:port → ws(s)://host:port/realtime/v1/websocket?vsn=1.0.0 */
export function realtimeUrl(baseUrl) {
  const url = new URL(REALTIME_PATH, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/**
 * 開啟 WebSocket、送出 heartbeat，等待 ref 為 "1"、status 為 ok 的 phx_reply。
 * @returns {Promise<string|null>} null 表示通過，否則為失敗類別
 */
function realtimeCheck(url, WebSocketImpl, timeoutMs) {
  return new Promise((resolveCheck) => {
    let ws;
    let done = false;
    let opened = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* 已關閉 */ }
      resolveCheck(reason);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    try {
      ws = new WebSocketImpl(url);
    } catch {
      finish('network');
      return;
    }
    ws.onopen = () => {
      opened = true;
      try { ws.send(JSON.stringify(HEARTBEAT)); } catch { finish('network'); }
    };
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
      if (msg?.topic !== 'phoenix' || msg?.event !== 'phx_reply' || msg?.ref !== HEARTBEAT.ref) return;
      finish(msg?.payload?.status === 'ok' ? null : 'reply');
    };
    ws.onerror = () => finish(opened ? 'closed' : 'network');
    ws.onclose = () => finish(opened ? 'closed' : 'network');
  });
}

/**
 * 執行 Smoke_Test。`fetchImpl`、`WebSocketImpl`、`now` 與 `timeoutMs` 供測試注入。
 * check 回傳 null 表示通過，否則回傳失敗類別字串（不含回應內容）。
 * @returns {Promise<{ok:boolean, steps:{step:string, status:number|null, ms:number, result:'pass'|'fail'|'skipped', reason?:string, provisioned?:boolean}[]}>}
 */
export async function runSmoke({ baseUrl, username, password }, {
  provision = false, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket,
  now = () => performance.now(), timeoutMs = STEP_TIMEOUT_MS,
} = {}) {
  const steps = [];
  let token = null;
  let failed = false;

  const request = (path, init) => fetchImpl(new URL(path, baseUrl), { redirect: 'manual', ...init, signal: AbortSignal.timeout(timeoutMs) });
  const json = (res) => res.json().catch(() => null);
  const drain = (res) => res.arrayBuffer().catch(() => null);
  const bearer = () => ({ Authorization: `Bearer ${token}` });
  const errorClass = (err) => (err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network');

  /** run 回傳 { status, reason, extra? }；例外只記錄類別，不輸出錯誤內容。 */
  async function step(name, run) {
    if (failed) { steps.push({ step: name, status: null, ms: 0, result: 'skipped' }); return; }
    const started = now();
    let outcome;
    try { outcome = await run(); } catch (err) { outcome = { status: null, reason: errorClass(err) }; }
    const entry = { step: name, status: outcome.status ?? null, ms: Math.round(now() - started), result: outcome.reason ? 'fail' : 'pass' };
    if (outcome.reason) entry.reason = outcome.reason;
    if (outcome.extra) Object.assign(entry, outcome.extra);
    steps.push(entry);
    if (outcome.reason) failed = true;
  }

  const login = async () => {
    const res = await request('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    });
    const body = await json(res);
    return { res, body };
  };
  const sessionReason = (res, body) => {
    if (res.status !== 200) return 'status';
    if (typeof body?.access_token !== 'string' || body.access_token === '') return 'no-session';
    return body?.user?.username === username ? null : 'username';
  };

  await step('index', async () => {
    const res = await request('/', { method: 'GET' });
    const text = await res.text().catch(() => '');
    if (res.status !== 200) return { status: res.status, reason: 'status' };
    if (!/text\/html/i.test(res.headers.get('content-type') ?? '')) return { status: res.status, reason: 'content-type' };
    return { status: res.status, reason: /\.(?:wasm|js)["'?#]/.test(text) ? null : 'no-app' };
  });
  await step('robots', async () => {
    const res = await request('/robots.txt', { method: 'GET' });
    await drain(res);
    return { status: res.status, reason: res.status === 200 ? null : 'status' };
  });
  await step('login', async () => {
    let { res, body } = await login();
    if (res.status === 401 && body?.code === 'invalid_credentials' && provision) {
      const signup = await request('/api/auth/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, display_name: SMOKE_DISPLAY_NAME, password }),
      });
      await drain(signup);
      if (signup.status !== 200) return { status: signup.status, reason: 'signup-status', extra: { provisioned: false } };
      ({ res, body } = await login());
      const reason = sessionReason(res, body);
      if (!reason) token = body.access_token;
      return { status: res.status, reason, extra: { provisioned: true } };
    }
    const reason = sessionReason(res, body);
    if (!reason) token = body.access_token;
    return { status: res.status, reason };
  });
  await step('me', async () => {
    const res = await request('/api/me', { method: 'GET', headers: bearer() });
    const body = await json(res);
    if (res.status !== 200) return { status: res.status, reason: 'status' };
    return { status: res.status, reason: body?.username === username ? null : 'username' };
  });
  await step('trips', async () => {
    const res = await request('/api/trips', { method: 'GET', headers: bearer() });
    const body = await json(res);
    if (res.status !== 200) return { status: res.status, reason: 'status' };
    return { status: res.status, reason: Array.isArray(body) ? null : 'body' };
  });
  await step('realtime', async () => {
    if (typeof WebSocketImpl !== 'function') return { status: null, reason: 'no-websocket' };
    const reason = await realtimeCheck(realtimeUrl(baseUrl), WebSocketImpl, timeoutMs);
    return { status: reason === 'network' ? null : 101, reason };
  });
  // 已登入就一定登出，即使前面步驟失敗，避免留下有效的 refresh token。
  if (token) failed = false;
  await step('logout', async () => {
    const res = await request('/api/auth/logout', { method: 'POST', headers: { ...bearer(), 'Content-Type': 'application/json' }, body: '{}' });
    await drain(res);
    return { status: res.status, reason: res.status === 200 ? null : 'status' };
  });
  // 登出之前已有失敗步驟時，整體仍為失敗。
  return { ok: steps.length === STEPS.length && steps.every((s) => s.result === 'pass'), steps };
}

export async function main(argv = process.argv.slice(2), env = process.env, { log = console.log, error = console.error, ...deps } = {}) {
  const unknown = argv.filter((a) => a !== '--provision');
  if (unknown.length) {
    error('用法：bun ci/smoke.mjs [--provision]');
    return 2;
  }
  const parsed = readSmokeConfig(env, deps);
  if (!parsed.ok) {
    for (const p of parsed.problems) error(`Smoke_Test 設定無效 ${p.name}: ${p.reason}`);
    return 2;
  }
  const result = await runSmoke(parsed.config, { ...deps, provision: argv.includes('--provision') });
  log(JSON.stringify(result));
  return result.ok ? 0 : 1;
}

const isMain = import.meta.main ?? (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) process.exit(await main());
