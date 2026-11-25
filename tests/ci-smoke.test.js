// ci/smoke.mjs（Rust 版 Smoke_Test）的行為測試：以本機 Bun.serve 模擬 LM_Proxy 後的 lm-server（含 Realtime 的
// WebSocket），檢查步驟順序、--provision、失敗後略過與登出、逾時，以及輸出不含秘密（plan.md D9、D15）。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { STEPS, main, readSmokeConfig, realtimeUrl, runSmoke } from '../ci/smoke.mjs';

const PASSWORD = 'placeholder-smoke-password-0123';
const ACCESS = 'access-token-placeholder-'.padEnd(64, 'a');
let server, base;
const state = {};

function reset(overrides = {}) {
  Object.assign(state, {
    users: new Set(['smoke-bot']), signups: 0, tokens: new Set(), loggedOut: 0, requests: [],
    robotsStatus: 200, robotsDelayMs: 0, heartbeat: 'ok', meUsername: null, html: '<script type="module">import init from \'/lm-web-1a2b.js\';init(\'/lm-web-1a2b_bg.wasm\')</script>',
    ...overrides,
  });
}

beforeAll(() => {
  reset();
  server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      state.requests.push(`${req.method} ${url.pathname}${url.search}`);
      const json = (status, body) => Response.json(body, { status });
      const token = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
      const authed = state.tokens.has(token);
      if (url.pathname === '/realtime/v1/websocket') {
        if (url.searchParams.get('vsn') !== '1.0.0') return new Response('bad', { status: 400 });
        return srv.upgrade(req) ? undefined : new Response('upgrade', { status: 400 });
      }
      if (url.pathname === '/') return new Response(state.html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      if (url.pathname === '/robots.txt') {
        if (state.robotsDelayMs) await Bun.sleep(state.robotsDelayMs);
        return new Response('User-agent: *\n', { status: state.robotsStatus });
      }
      if (url.pathname === '/api/auth/login' && req.method === 'POST') {
        const body = await req.json();
        if (!state.users.has(body.username) || body.password !== PASSWORD) {
          return json(401, { code: 'invalid_credentials', message: '帳號或密碼不正確。', field: null });
        }
        state.tokens.add(ACCESS);
        return json(200, {
          access_token: ACCESS, refresh_token: 'refresh-placeholder', expires_at: 1795000000,
          user: { id: '00000000-0000-4000-8000-000000000001', username: body.username, display_name: 'smoke-bot', role: 'admin' },
        });
      }
      if (url.pathname === '/api/auth/signup' && req.method === 'POST') {
        const body = await req.json();
        state.signups++;
        if (body.display_name !== 'smoke-bot' || body.password !== PASSWORD) return json(400, { code: 'invalid_request', message: 'x', field: null });
        state.users.add(body.username);
        return json(200, { access_token: 'signup-token', refresh_token: 'r', expires_at: 1, user: { username: body.username }, trip_id: null });
      }
      if (!authed && url.pathname.startsWith('/api/')) return json(401, { code: 'unauthorized', message: 'x', field: null });
      if (url.pathname === '/api/me') return json(200, { id: 'u', username: state.meUsername ?? 'smoke-bot', display_name: 'smoke-bot', role: 'admin' });
      if (url.pathname === '/api/trips') return json(200, []);
      if (url.pathname === '/api/auth/logout' && req.method === 'POST') { state.tokens.delete(token); state.loggedOut++; return json(200, {}); }
      return json(404, { code: 'api_not_found', message: 'x', field: null });
    },
    websocket: {
      message(ws, message) {
        const msg = JSON.parse(String(message));
        if (msg.topic !== 'phoenix' || msg.event !== 'heartbeat' || state.heartbeat === 'silent') return;
        ws.send(JSON.stringify({ topic: 'phoenix', event: 'phx_reply', ref: msg.ref, payload: { status: state.heartbeat, response: {} } }));
      },
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

const config = () => ({ baseUrl: base, username: 'smoke-bot', password: PASSWORD });
const summary = (r) => r.steps.map((s) => [s.step, s.status, s.result, s.reason]);

describe('runSmoke', () => {
  test('全部通過：固定的步驟順序，WebSocket 收到 heartbeat 的 phx_reply，最後登出', async () => {
    reset();
    const r = await runSmoke(config());
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.step)).toEqual([...STEPS]);
    expect(summary(r)).toEqual([
      ['index', 200, 'pass', undefined], ['robots', 200, 'pass', undefined], ['login', 200, 'pass', undefined],
      ['me', 200, 'pass', undefined], ['trips', 200, 'pass', undefined], ['realtime', 101, 'pass', undefined],
      ['logout', 200, 'pass', undefined],
    ]);
    expect(state.requests).toContain('GET /realtime/v1/websocket?vsn=1.0.0');
    expect(state.loggedOut).toBe(1);
    expect(state.tokens.size).toBe(0);
    expect(state.signups).toBe(0);
  });

  test('--provision：登入 401 invalid_credentials 時註冊一次 smoke-bot 再登入', async () => {
    reset({ users: new Set() });
    const r = await runSmoke(config(), { provision: true });
    expect(r.ok).toBe(true);
    expect(r.steps[2]).toMatchObject({ step: 'login', status: 200, result: 'pass', provisioned: true });
    expect(state.signups).toBe(1);
    expect(state.requests.filter((q) => q === 'POST /api/auth/login').length).toBe(2);
  });

  test('沒有 --provision 時 401 即失敗：不註冊，之後的步驟略過，未登入所以不登出', async () => {
    reset({ users: new Set() });
    const r = await runSmoke(config());
    expect(r.ok).toBe(false);
    expect(summary(r)).toEqual([
      ['index', 200, 'pass', undefined], ['robots', 200, 'pass', undefined], ['login', 401, 'fail', 'status'],
      ['me', null, 'skipped', undefined], ['trips', null, 'skipped', undefined], ['realtime', null, 'skipped', undefined],
      ['logout', null, 'skipped', undefined],
    ]);
    expect(state.signups).toBe(0);
    expect(state.requests).not.toContain('POST /api/auth/logout');
  });

  test('登入後的步驟失敗時仍登出；整體結果為失敗', async () => {
    reset({ meUsername: 'someone-else' });
    const r = await runSmoke(config());
    expect(r.ok).toBe(false);
    expect(summary(r).slice(3)).toEqual([
      ['me', 200, 'fail', 'username'], ['trips', null, 'skipped', undefined], ['realtime', null, 'skipped', undefined],
      ['logout', 200, 'pass', undefined],
    ]);
    expect(state.loggedOut).toBe(1);
  });

  test('heartbeat 的回覆不是 ok 或沒有回覆時 realtime 失敗', async () => {
    reset({ heartbeat: 'error' });
    let r = await runSmoke(config());
    expect(r.steps[5]).toMatchObject({ step: 'realtime', result: 'fail', reason: 'reply' });
    expect(r.steps[6]).toMatchObject({ step: 'logout', result: 'pass' });
    reset({ heartbeat: 'silent' });
    r = await runSmoke(config(), { timeoutMs: 300 });
    expect(r.steps[5]).toMatchObject({ step: 'realtime', result: 'fail', reason: 'timeout' });
  });

  test('逾時：回應超過每步的時限時記錄 timeout 並略過之後的步驟', async () => {
    reset({ robotsDelayMs: 1500 });
    const r = await runSmoke(config(), { timeoutMs: 200 });
    expect(r.steps[1]).toMatchObject({ step: 'robots', status: null, result: 'fail', reason: 'timeout' });
    expect(r.steps.slice(2).every((s) => s.result === 'skipped')).toBe(true);
  });

  test('index 不是 trunk 的輸出、robots 不是 200 時失敗', async () => {
    reset({ html: '<html><body>maintenance</body></html>' });
    expect((await runSmoke(config())).steps[0]).toMatchObject({ step: 'index', result: 'fail', reason: 'no-app' });
    reset({ robotsStatus: 404 });
    expect((await runSmoke(config())).steps[1]).toMatchObject({ step: 'robots', status: 404, result: 'fail', reason: 'status' });
  });

  test('連線失敗只記錄類別', async () => {
    const r = await runSmoke({ ...config(), baseUrl: 'http://127.0.0.1:9' }, { timeoutMs: 2000 });
    expect(r.steps[0]).toMatchObject({ step: 'index', status: null, result: 'fail' });
    expect(['network', 'timeout']).toContain(r.steps[0].reason);
  });
});

describe('設定與 CLI', () => {
  const files = { '/run/pw': `${PASSWORD}\n`, '/run/empty': '\n' };
  const readFile = (p) => { if (p in files) return files[p]; throw new Error('ENOENT'); };

  test('readSmokeConfig：只接受 origin；密碼檔必填、不可為空；錯誤不含值', () => {
    expect(readSmokeConfig({ LM_SMOKE_BASE_URL: 'http://192.168.1.121:8081', LM_SMOKE_PASSWORD_FILE: '/run/pw' }, { readFile }))
      .toEqual({ ok: true, config: { baseUrl: 'http://192.168.1.121:8081', username: 'smoke-bot', password: PASSWORD } });
    const bad = readSmokeConfig({ LM_SMOKE_BASE_URL: 'https://www.our-littlemoments.com/app?x=1', LM_SMOKE_PASSWORD_FILE: '/run/empty' }, { readFile });
    expect(bad.problems.map((p) => p.name)).toEqual(['LM_SMOKE_BASE_URL', 'LM_SMOKE_PASSWORD_FILE']);
    expect(readSmokeConfig({}, { readFile }).problems.map((p) => [p.name, p.reason])).toEqual([['LM_SMOKE_BASE_URL', 'unset'], ['LM_SMOKE_PASSWORD_FILE', 'unset']]);
    expect(readSmokeConfig({ LM_SMOKE_BASE_URL: 'ftp://x', LM_SMOKE_PASSWORD_FILE: '/nope' }, { readFile }).problems.map((p) => p.reason))
      .toEqual(['protocol must be http or https', 'unreadable']);
  });

  test('realtimeUrl：http → ws、https → wss', () => {
    expect(realtimeUrl('http://192.168.1.121:8081')).toBe('ws://192.168.1.121:8081/realtime/v1/websocket?vsn=1.0.0');
    expect(realtimeUrl('https://www.our-littlemoments.com')).toBe('wss://www.our-littlemoments.com/realtime/v1/websocket?vsn=1.0.0');
  });

  test('main：輸出一個 JSON 物件，不含 token 或密碼；結束碼 0／1／2', async () => {
    reset();
    const out = [], err = [];
    const io = { log: (m) => out.push(m), error: (m) => err.push(m), readFile };
    const env = { LM_SMOKE_BASE_URL: base, LM_SMOKE_PASSWORD_FILE: '/run/pw' };
    expect(await main([], env, io)).toBe(0);
    expect(out.length).toBe(1);
    const text = [...out, ...err].join('\n');
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(ACCESS);
    expect(text).not.toContain('refresh-placeholder');
    expect(JSON.parse(out[0]).ok).toBe(true);

    reset({ users: new Set() });
    expect(await main([], env, { ...io, log: () => {} })).toBe(1);
    expect(await main(['--bogus'], env, io)).toBe(2);
    expect(await main([], {}, io)).toBe(2);
    expect(err.join('\n')).toContain('LM_SMOKE_BASE_URL');
  });
});
