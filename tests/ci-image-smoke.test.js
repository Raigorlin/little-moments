// ci/scripts/image-smoke-seed.mjs 與 ci/scripts/image-smoke.sh 的測試（Requirement 16.2、18.3；tasks 12.3）。
// 輔助腳本以本機 stub 伺服器驗證；Shell 腳本需要 Docker，這裡只做靜態檢查（隔離、清理與秘密處理）。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { FIXTURE_DATES, main, seedSmokeFixture, waitHealthy } from '../ci/scripts/image-smoke-seed.mjs';

const PASSWORD = 'placeholder-smoke-password';
const TOKEN = 'placeholder-setup-token-0123456789abcdef';
const USER_ID = '00000000-0000-4000-8000-000000000001';
let server, base;
const state = { users: 0, trips: [], health: [], sessions: new Set(), loggedOut: 0, requests: [] };

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      state.requests.push(`${req.method} ${url.pathname}`);
      const json = (status, body, headers = {}) => Response.json(body, { status, headers });
      if (url.pathname === '/healthz') return new Response('', { status: state.health.length ? state.health.shift() : 200 });
      if (req.method === 'POST' && req.headers.get('origin') !== base) return json(403, { error: 'origin' });
      const token = (req.headers.get('cookie') || '').match(/ggc_session=([a-f0-9]{64})/)?.[1];
      if (url.pathname === '/api/setup') {
        const body = await req.json();
        if (state.users) return json(409, { error: 'done' });
        if (body.setupToken !== TOKEN) return json(403, { error: 'token' });
        if (body.username !== 'smoke-bot' || body.password !== PASSWORD || typeof body.displayName !== 'string') return json(400, { error: 'bad' });
        state.users++;
        const session = 'b'.repeat(64);
        state.sessions.add(session);
        return json(200, { user: { id: USER_ID, username: 'smoke-bot', role: 'admin' }, needsSetup: false }, { 'Set-Cookie': `ggc_session=${session}; HttpOnly; Path=/` });
      }
      if (url.pathname === '/api/trips') {
        if (!state.sessions.has(token)) return json(401, { error: 'login' });
        const body = await req.json();
        if (body.expectedUserId !== USER_ID) return json(409, { error: 'user' });
        state.trips.push(body);
        return json(201, { trip: { id: 't1', title: body.title } });
      }
      if (url.pathname === '/api/logout') { state.sessions.delete(token); state.loggedOut++; return json(200, { ok: true }); }
      return json(404, { error: 'nf' });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

const reset = () => Object.assign(state, { users: 0, trips: [], health: [], sessions: new Set(), loggedOut: 0, requests: [] });
const config = () => ({ baseUrl: base, host: null, username: 'smoke-bot', password: PASSWORD, fixture: 'smoke-fixture' });

describe('waitHealthy', () => {
  test('前幾次失敗後達成連續 3 次成功即回報健康', async () => {
    reset();
    state.health = [503, 503, 200, 503, 200, 200, 200];
    const result = await waitHealthy({ baseUrl: base }, { sleep: async () => {}, intervalMs: 0 });
    expect(result.healthy).toBe(true);
    expect(result.attempts.map(a => a.status)).toEqual([503, 503, 200, 503, 200, 200, 200]);
  });

  test('視窗內未達成連續成功時回報不健康（連線失敗視為失敗）', async () => {
    let clock = 0;
    const result = await waitHealthy({ baseUrl: 'http://127.0.0.1:9' }, {
      fetchImpl: async () => { throw new TypeError('connect'); },
      now: () => clock, sleep: async () => { clock += 10000; }, windowSec: 120,
    });
    expect(result.healthy).toBe(false);
    expect(result.attempts.length).toBe(13); // t = 0, 10, …, 120 秒
    expect(result.attempts.every(a => a.status === null && a.ok === false)).toBe(true);
  });
});

describe('seedSmokeFixture', () => {
  test('以 Setup_Token 建立合成管理員與 smoke-fixture 行程後登出', async () => {
    reset();
    const result = await seedSmokeFixture(config(), TOKEN);
    expect(result.ok).toBe(true);
    expect(result.steps.map(s => [s.step, s.status, s.result])).toEqual([
      ['setup', 200, 'pass'], ['create-fixture', 201, 'pass'], ['logout', 200, 'pass'],
    ]);
    expect(state.trips).toEqual([{ title: 'smoke-fixture', ...FIXTURE_DATES, expectedUserId: USER_ID }]);
    expect(state.loggedOut).toBe(1);
    expect(state.sessions.size).toBe(0);
  });

  test('Setup_Token 錯誤時失敗、略過建立行程，且不嘗試登出（未取得 Session）', async () => {
    reset();
    const result = await seedSmokeFixture(config(), 'wrong-token-wrong-token-wrong-token');
    expect(result.ok).toBe(false);
    expect(result.steps.map(s => [s.step, s.result, s.reason])).toEqual([
      ['setup', 'fail', 'status'], ['create-fixture', 'skipped', undefined], ['logout', 'skipped', undefined],
    ]);
    expect(state.trips).toEqual([]);
  });

  test('已有使用者（非全新資料庫）時失敗', async () => {
    reset();
    state.users = 1;
    const result = await seedSmokeFixture(config(), TOKEN);
    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ step: 'setup', status: 409, result: 'fail' });
  });
});

describe('main', () => {
  const env = () => ({ CAMPING_SMOKE_BASE_URL: base, CAMPING_SMOKE_PASSWORD: PASSWORD, CAMPING_SETUP_TOKEN: TOKEN });

  test('seed 輸出只含步驟摘要，不含密碼、Setup_Token 或 Cookie', async () => {
    reset();
    const out = [], err = [];
    const code = await main(['seed'], env(), { log: m => out.push(m), error: m => err.push(m) });
    expect(code).toBe(0);
    const text = [...out, ...err].join('\n');
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('b'.repeat(64));
    expect(JSON.parse(out[0]).ok).toBe(true);
  });

  test('seed 缺少 CAMPING_SETUP_TOKEN 時以結束碼 2 結束且不送出請求', async () => {
    reset();
    const err = [];
    const { CAMPING_SETUP_TOKEN, ...rest } = env();
    expect(await main(['seed'], rest, { log: () => {}, error: m => err.push(m) })).toBe(2);
    expect(err.join('\n')).toContain('CAMPING_SETUP_TOKEN');
    expect(state.requests).toEqual([]);
  });

  test('wait-healthy 不需要密碼；未知子命令為結束碼 2', async () => {
    reset();
    expect(await main(['wait-healthy'], { CAMPING_SMOKE_BASE_URL: base }, { log: () => {}, error: () => {}, sleep: async () => {}, intervalMs: 0 })).toBe(0);
    expect(await main(['nope'], env(), { log: () => {}, error: () => {} })).toBe(2);
    expect(await main([], env(), { log: () => {}, error: () => {} })).toBe(2);
  });
});

describe('ci/scripts/image-smoke.sh（靜態檢查）', () => {
  const script = readFileSync(new URL('../ci/scripts/image-smoke.sh', import.meta.url), 'utf8');
  const code = script.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');

  test('LF 換行、嚴格模式與 trap 清理', () => {
    expect(script).not.toContain('\r');
    expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(code).toContain('set -euo pipefail');
    expect(code).toMatch(/trap cleanup EXIT/);
    expect(code).toMatch(/rm -fv/);
    expect(code).toMatch(/network rm/);
    expect(code).not.toMatch(/set -x|set -o xtrace/);
  });

  test('只使用 --internal 網路且不發布任何連接埠', () => {
    expect(code).toContain('network create --internal');
    // 合併以 \ 續行的指令，只檢查 docker run／create。
    const commands = code.replace(/\\\n/g, ' ').split('\n').filter(l => /"\$DOCKER_BIN" (run|create) /.test(l));
    expect(commands.length).toBe(4); // database、migrate、app、runner
    for (const cmd of commands) {
      expect(cmd).not.toMatch(/\s(-p|--publish|--publish-all|-P)[\s=]/);
      expect(cmd).toContain('--network "$net"');
      expect(cmd).toContain('"${labels[@]}"');
      // 不使用 bind mount 或具名卷：PGDATA 為 tmpfs，runner 檔案以 docker cp 複製。
      expect(cmd).not.toMatch(/\s(-v|--volume|--mount)[\s=]/);
    }
    expect(code).not.toMatch(/--network[ =]host/);
  });

  test('秘密只經由 --env-file 傳遞，不出現在 -e 參數或輸出', () => {
    for (const name of ['POSTGRES_PASSWORD', 'CAMPING_DATABASE_PASSWORD', 'CAMPING_SETUP_TOKEN', 'CAMPING_SMOKE_PASSWORD']) {
      expect(code).not.toMatch(new RegExp(`-e\\s+"?${name}`));
    }
    expect(code).toContain('--env-file');
    expect(code).not.toMatch(/echo[^\n]*\$\{?(db_password|setup_token|smoke_password)/);
  });

  test('以映像內的 migrate.js 與預設 ENTRYPOINT 執行，並固定 Ephemeral_Database 映像 digest', () => {
    expect(code).toContain('/app/server/migrate.js');
    expect(code).toContain('scripts/smoke.mjs');
    expect(code).toMatch(/@sha256:\[0-9a-f\]\{64\}/);
  });
});
