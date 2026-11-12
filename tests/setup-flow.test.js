// 首次管理員設定流程的範例測試（Task 3.2；Requirement 9）。
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { createAccountService } from '../server/accounts.js';
import { createSetupGuard } from '../server/setup-guard.js';
import { useTestDatabase, resetTables, serviceDb } from './support/pg.js';

const LAN = 'http://192.168.1.10:5173';
const LAN_INFO = { ip: '192.168.1.20', tcpIp: '192.168.1.20', viaProxy: false };
const TOKEN = 'setup-token-placeholder-0123456789abcdef';
const PASS = 'correct horse battery';
const ADMIN = { username: 'admin-one', displayName: '管理員', password: PASS };
let svc, clockMs;
const db = useTestDatabase();

beforeEach(async () => {
  clockMs = Date.parse('2026-11-04T00:00:00Z');
  const setup = createSetupGuard({ bindAddress: '0.0.0.0', setupToken: TOKEN, log: () => {} });
  await resetTables(db.sql);
  svc = await createAccountService({ db: serviceDb(db.sql), now: () => clockMs, setup });
});
afterEach(() => svc.close());

async function call(method, path, { body, raw, cookie, info = LAN_INFO, base = LAN } = {}) {
  const headers = { origin: base };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
  const res = await svc.handle(new Request(base + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), info);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const setup = (extra, opts) => call('POST', '/api/setup', { body: { ...ADMIN, ...extra }, ...opts });

test('session reports setupTokenRequired while setup is pending', async () => {
  expect((await call('GET', '/api/session')).body).toEqual({ user: null, needsSetup: true, setupTokenRequired: true, webSetup: true, registrationOpen: true, inviteRegistration: false });
  expect((await setup({ setupToken: TOKEN })).status).toBe(200);
  expect((await call('GET', '/api/session')).body).toMatchObject({ needsSetup: false, setupTokenRequired: false });
});

test('LAN setup needs the exact token; denials are audited without the token', async () => {
  expect((await setup({})).status).toBe(403);
  expect((await setup({ setupToken: 'wrong-token-value-wrong-token-value-xx' })).status).toBe(403);
  // 未授權時即使 body 格式錯誤也回應 403，而非 400
  expect((await call('POST', '/api/setup', { raw: '{broken' })).status).toBe(403);
  // 輸入驗證失敗 → 400，token 仍有效（Req 9.10）
  expect((await setup({ setupToken: TOKEN, password: 'short' })).status).toBe(400);
  const ok = await setup({ setupToken: TOKEN });
  expect(ok.status).toBe(200);
  expect(ok.body.user).toMatchObject({ username: 'admin-one', role: 'admin' });
  // 已有使用者 → 409，同一 token 不可重用（Req 9.5、9.6）
  expect((await setup({ username: 'admin-two', setupToken: TOKEN })).status).toBe(409);
  expect((await setup({ username: 'admin-two' })).status).toBe(409);

  const events = (await call('GET', '/api/admin/audit', { cookie: ok.cookie })).body.events;
  const denied = events.filter(e => e.action === 'setup.denied').map(e => e.target).sort();
  expect(denied).toEqual(['reason:missing_token ip:192.168.1.20', 'reason:missing_token ip:192.168.1.20', 'reason:token_mismatch ip:192.168.1.20']);
  expect(JSON.stringify(events)).not.toContain(TOKEN);
  expect(JSON.stringify(events)).not.toContain('wrong-token-value');
});

test('requests through a trusted proxy need the token even if they claim loopback', async () => {
  const info = { ip: '127.0.0.1', tcpIp: '127.0.0.1', viaProxy: true };
  const base = 'http://localhost:5173';
  expect((await setup({}, { info, base })).status).toBe(403);
  expect((await setup({ setupToken: TOKEN }, { info, base })).status).toBe(200);
});

test('local loopback setup still works without a token when the guard is enabled', async () => {
  const res = await setup({}, { base: 'http://127.0.0.1:5173', info: { ip: '127.0.0.1', tcpIp: '127.0.0.1', viaProxy: false } });
  expect(res.status).toBe(200);
});

test('30 setup attempts per client per 15 minutes; the 31st is 429 without checking the token', async () => {
  for (let i = 0; i < 30; i++) expect((await setup({ setupToken: 'x'.repeat(40) })).status).toBe(403);
  expect((await setup({ setupToken: TOKEN })).status).toBe(429);
  // 其他用戶端不受影響
  expect((await call('GET', '/api/session')).body.needsSetup).toBe(true);
  clockMs += 15 * 60000;
  expect((await setup({ setupToken: TOKEN })).status).toBe(200);
});

test('default guard (no setup option) rejects non-loopback clients with non_loopback', async () => {
  svc.close();
  svc = await createAccountService({ db: serviceDb(db.sql), now: () => clockMs });
  expect((await call('GET', '/api/session')).body.setupTokenRequired).toBe(false);
  expect((await setup({ setupToken: TOKEN })).status).toBe(403);
  const local = await setup({}, { base: 'http://127.0.0.1:5173', info: { ip: '127.0.0.1' } });
  expect(local.status).toBe(200);
  const events = (await call('GET', '/api/admin/audit', { cookie: local.cookie, base: 'http://127.0.0.1:5173', info: { ip: '127.0.0.1' } })).body.events;
  expect(events.filter(e => e.action === 'setup.denied').map(e => e.target)).toEqual(['reason:non_loopback ip:192.168.1.20']);
});
