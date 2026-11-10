// scripts/smoke.mjs 的行為測試（Requirement 14.6、18.3、20.5、21.10），以本機 stub 伺服器模擬受測環境。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SECURITY_HEADERS } from '../server/http.js';
import { STEPS, main, readSmokeConfig, runSmoke } from '../scripts/smoke.mjs';

const PASSWORD = 'placeholder-smoke-password';
const SECRET_TITLE = 'private-user-trip-title';
let server, base;
const state = { fixture: true, headers: true, loginOk: true, sessions: new Set(), loggedOut: 0, slow: false };

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const json = (status, body, extra = {}) => Response.json(body, { status, headers: { ...SECURITY_HEADERS, ...extra } });
      if (state.slow && url.pathname === '/api/session') await Bun.sleep(300);
      if (url.pathname === '/login') return new Response('<html>login</html>', { headers: state.headers ? SECURITY_HEADERS : {} });
      if (url.pathname === '/api/session') return json(200, { user: null, needsSetup: false });
      if (url.pathname === '/api/login') {
        if (req.headers.get('origin') !== base) return json(403, { error: 'origin' });
        const body = await req.json();
        if (!state.loginOk || body.username !== 'smoke-bot' || body.password !== PASSWORD) return json(401, { error: 'bad' });
        const token = 'a'.repeat(64);
        state.sessions.add(token);
        return json(200, { user: { username: 'smoke-bot' } }, { 'Set-Cookie': `ggc_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800` });
      }
      const token = (req.headers.get('cookie') || '').match(/ggc_session=([a-f0-9]{64})/)?.[1];
      if (url.pathname === '/api/trips') {
        if (!state.sessions.has(token)) return json(401, { error: 'login' });
        return json(200, { trips: [{ title: SECRET_TITLE }, ...(state.fixture ? [{ title: 'smoke-fixture' }] : [])] });
      }
      if (url.pathname === '/api/logout') { state.sessions.delete(token); state.loggedOut++; return json(200, { ok: true }); }
      return json(404, { error: 'nf' });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

const config = () => ({ baseUrl: base, username: 'smoke-bot', password: PASSWORD, fixture: 'smoke-fixture' });
const reset = patch => Object.assign(state, { fixture: true, headers: true, loginOk: true, slow: false, loggedOut: 0 }, patch);

describe('Smoke_Test', () => {
  test('全部步驟通過時 ok 為 true，依序回報五個步驟並登出', async () => {
    reset();
    const r = await runSmoke(config());
    expect(r.ok).toBe(true);
    expect(r.steps.map(s => s.step)).toEqual([...STEPS]);
    expect(r.steps.every(s => s.result === 'pass' && Number.isInteger(s.ms) && s.ms >= 0)).toBe(true);
    expect(r.steps.map(s => s.status)).toEqual([200, 200, 200, 200, 200]);
    expect(state.loggedOut).toBe(1);
    expect(state.sessions.size).toBe(0);
  });

  test('缺少合成行程時 trips 失敗，但仍會登出', async () => {
    reset({ fixture: false });
    const r = await runSmoke(config());
    expect(r.ok).toBe(false);
    expect(r.steps.find(s => s.step === 'trips')).toMatchObject({ result: 'fail', reason: 'fixture-missing', status: 200 });
    expect(r.steps.find(s => s.step === 'logout').result).toBe('pass');
    expect(state.sessions.size).toBe(0);
  });

  test('登入頁缺少安全標頭即失敗，後續步驟 skipped 且不登入', async () => {
    reset({ headers: false });
    const r = await runSmoke(config());
    expect(r.ok).toBe(false);
    expect(r.steps.map(s => s.result)).toEqual(['fail', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(state.loggedOut).toBe(0);
  });

  test('登入失敗時 trips 與 logout 均為 skipped', async () => {
    reset({ loginOk: false });
    const r = await runSmoke(config());
    expect(r.steps.map(s => [s.step, s.result])).toEqual([['login-page', 'pass'], ['session', 'pass'], ['login', 'fail'], ['trips', 'skipped'], ['logout', 'skipped']]);
    expect(r.steps[2].status).toBe(401);
  });

  test('步驟逾時視為失敗，狀態碼為 null', async () => {
    reset({ slow: true });
    const r = await runSmoke(config(), { timeoutMs: 50 });
    expect(r.ok).toBe(false);
    expect(r.steps[1]).toMatchObject({ step: 'session', status: null, result: 'fail', reason: 'timeout' });
  });

  test('Host 覆寫：每個請求帶 Host，POST 的 Origin 為連線協定加覆寫 Host（假 fetch）', async () => {
    const seen = [];
    const fakeFetch = async (url, init) => {
      const h = new Headers(init.headers);
      seen.push({ path: url.pathname, method: init.method, host: h.get('host'), origin: h.get('origin'), cookie: h.get('cookie'), timed: init.signal instanceof AbortSignal });
      const headers = new Headers(SECURITY_HEADERS);
      if (url.pathname === '/login') return new Response('x', { headers });
      if (url.pathname === '/api/session') return Response.json({ user: null, needsSetup: false }, { headers });
      if (url.pathname === '/api/login') { headers.append('Set-Cookie', 'ggc_session=tok; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800'); return Response.json({}, { headers }); }
      if (url.pathname === '/api/trips') return Response.json({ trips: [{ title: 'smoke-fixture' }] }, { headers });
      return Response.json({ ok: true }, { headers });
    };
    const r = await runSmoke({ baseUrl: 'http://10.0.0.5:8081', host: 'lm-staging.lan:8081', username: 'smoke-bot', password: PASSWORD, fetch: fakeFetch });
    expect(r.ok).toBe(true);
    expect(seen.every(s => s.host === 'lm-staging.lan:8081' && s.timed)).toBe(true);
    expect(seen.filter(s => s.method === 'POST').map(s => s.origin)).toEqual(['http://lm-staging.lan:8081', 'http://lm-staging.lan:8081']);
    expect(seen.find(s => s.path === '/api/trips').cookie).toBe('ggc_session=tok');
    // HTML 路由的 Cache-Control 必須為 no-store；改成 no-cache 即視為標頭不符
    const bad = async (url, init) => url.pathname === '/login' ? new Response('x', { headers: { ...SECURITY_HEADERS, 'Cache-Control': 'no-cache' } }) : fakeFetch(url, init);
    const r2 = await runSmoke({ baseUrl: 'http://10.0.0.5:8081', username: 'smoke-bot', password: PASSWORD, fetch: bad });
    expect(r2.steps[0]).toMatchObject({ result: 'fail', reason: 'headers' });
    const down = async () => { throw new TypeError('ECONNREFUSED 10.0.0.5'); };
    const r3 = await runSmoke({ baseUrl: 'http://10.0.0.5:8081', username: 'smoke-bot', password: PASSWORD, fetch: down });
    expect(r3.steps[0]).toMatchObject({ status: null, reason: 'network' });
    expect(JSON.stringify(r3)).not.toContain('ECONNREFUSED');
  });

  test('輸出 JSON 只含步驟名稱、狀態碼、耗時與結果，不含回應內容或憑證', async () => {
    reset();
    const out = [];
    const code = await main({ CAMPING_SMOKE_BASE_URL: base, CAMPING_SMOKE_PASSWORD: PASSWORD }, { log: s => out.push(s), error: s => out.push(s) });
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]);
    expect(Object.keys(parsed).sort()).toEqual(['ok', 'steps']);
    for (const s of parsed.steps) expect(Object.keys(s).sort()).toEqual(['ms', 'result', 'status', 'step']);
    for (const leak of [PASSWORD, SECRET_TITLE, 'smoke-fixture', 'a'.repeat(64), 'login</html>']) expect(out[0]).not.toContain(leak);
    reset({ fixture: false });
    expect(await main({ CAMPING_SMOKE_BASE_URL: base, CAMPING_SMOKE_PASSWORD: PASSWORD }, { log: () => {}, error: () => {} })).toBe(1);
  });

  test('設定錯誤只列變數名與原因（結束碼 2），密碼檔優先於環境變數', async () => {
    const errors = [];
    expect(await main({}, { log: () => {}, error: s => errors.push(s) })).toBe(2);
    expect(errors.join('\n')).toContain('CAMPING_SMOKE_BASE_URL');
    for (const bad of ['ftp://x', 'not a url', 'https://h/path', 'https://user:pw@h']) {
      const r = readSmokeConfig({ CAMPING_SMOKE_BASE_URL: bad, CAMPING_SMOKE_PASSWORD: 'x' });
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain('pw@');
    }
    const fromFile = readSmokeConfig({ CAMPING_SMOKE_BASE_URL: 'https://lm.lan', CAMPING_SMOKE_PASSWORD_FILE: '/run/secret', CAMPING_SMOKE_PASSWORD: 'env-value' }, { readFile: () => 'file-value\n' });
    expect(fromFile).toEqual({ ok: true, config: { baseUrl: 'https://lm.lan', host: null, username: 'smoke-bot', password: 'file-value', fixture: 'smoke-fixture' } });
    const unreadable = readSmokeConfig({ CAMPING_SMOKE_BASE_URL: 'https://lm.lan', CAMPING_SMOKE_PASSWORD_FILE: '/missing' }, { readFile: () => { throw new Error('ENOENT secret-path'); } });
    expect(unreadable.ok).toBe(false);
    expect(JSON.stringify(unreadable)).not.toContain('secret-path');
    for (const bad of ['http://h', 'h/path', 'h:99999', 'u@h']) expect(readSmokeConfig({ CAMPING_SMOKE_BASE_URL: 'https://lm.lan', CAMPING_SMOKE_PASSWORD: 'x', CAMPING_SMOKE_HOST: bad }).ok).toBe(false);
    expect(readSmokeConfig({ CAMPING_SMOKE_BASE_URL: 'http://10.0.0.5', CAMPING_SMOKE_PASSWORD: 'x', CAMPING_SMOKE_HOST: 'LM.lan:8081' }).config.host).toBe('lm.lan:8081');
  });
});
