// Feature: jenkins-cicd-deploy, Property 17: Setup_Token 單次有效
// **Validates: Requirements 9.5, 9.6**
// 成功完成首次設定後，任意後續設定請求（任意 token、任意來源、任意 body）皆回應 409，使用者集合不變；
// 且 guard.verify 對原 token 回傳 false。
import { test, expect } from 'bun:test';
import fc from 'fast-check';
import { createAccountService } from '../server/accounts.js';
import { createSetupGuard } from '../server/setup-guard.js';
import { useTestDatabase, resetTables, serviceDb, testQuery } from './support/pg.js';

// 每個測試檔一個隔離 schema；每次 fast-check 執行前以 resetTables 清空資料表（任務 5.13）。
const db = useTestDatabase();

const LAN = 'http://192.168.1.10:5173';
const LOOP = 'http://127.0.0.1:5173';
const PASS = 'correct horse battery';
// 與 server/accounts.js 的 RESERVED 相同；validateUsername 以 400 拒絕這些名稱（design.md Components 第 29 節）。
const RESERVED = new Set(['api', 'admin', 'setup', 'login', 'register', 'logout', 'demo', 'assets']);
// 建置 #16 的反例 seed：修正前產生 adminName = "api"（任務 31.1）。
const BUILD_16_SEED = 1236998821;

// 來源組合：LAN 直連、loopback 直連、經 Trusted_Proxy 轉送（宣稱 loopback）
const sources = [
  { base: LAN, info: { ip: '192.168.1.20', tcpIp: '192.168.1.20', viaProxy: false } },
  { base: LAN, info: { ip: '192.168.1.77', tcpIp: '192.168.1.77', viaProxy: false } },
  { base: LOOP, info: { ip: '127.0.0.1', tcpIp: '127.0.0.1', viaProxy: false } },
  { base: 'http://localhost:5173', info: { ip: '127.0.0.1', tcpIp: '127.0.0.1', viaProxy: true } },
  { base: 'http://[::1]:5173', info: { ip: '::1', tcpIp: '::1', viaProxy: false } },
];

const tokenArb = fc.stringMatching(/^[A-Za-z0-9_-]{32,48}$/);
const usernameArb = fc.stringMatching(/^[a-z][a-z0-9-]{2,15}$/);
// 第一次設定的帳號名稱必須有效，所以排除保留名稱；後續請求的 username 仍用 usernameArb，
// 因為設定完成後 /api/setup 在讀取 body 之前就回應 409，保留名稱也應得到 409。
const adminNameArb = usernameArb.filter(u => !RESERVED.has(u));

// 後續請求的 body：有效、token 缺失、錯誤 token、原 token、無效欄位、格式錯誤的 JSON
const followUpArb = fc.record({
  source: fc.nat({ max: sources.length - 1 }),
  tokenKind: fc.constantFrom('same', 'other', 'missing', 'empty', 'nonString'),
  otherToken: tokenArb,
  username: usernameArb,
  displayName: fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim() !== ''),
  password: fc.oneof(fc.constant(PASS), fc.string({ maxLength: 40 })),
  rawBody: fc.option(fc.constantFrom('{broken', '', 'null', '[]', '"x"'), { freq: 5 }),
  advanceMs: fc.integer({ min: 0, max: 5 * 60_000 }),
});

// 以 Bind_Address 0.0.0.0 建立需要 Setup_Token 的服務，並回傳呼叫 handle 的輔助函式。
async function openService(token, now) {
  const guard = createSetupGuard({ bindAddress: '0.0.0.0', setupToken: token, log: () => {} });
  await resetTables(db.sql);
  const svc = await createAccountService({ db: serviceDb(db.sql), now, setup: guard });
  const call = async (method, path, { body, raw, cookie, source = sources[0] } = {}) => {
    const headers = { origin: source.base };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
    const res = await svc.handle(new Request(source.base + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), source.info);
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  return { guard, svc, call };
}

const userRows = async () => testQuery(db.sql, 'SELECT id, username, display_name, role, password_hash, created_at, deleted_at FROM users ORDER BY id');

const property17 = () =>
  fc.asyncProperty(tokenArb, adminNameArb, fc.array(followUpArb, { minLength: 1, maxLength: 12 }), async (token, adminName, followUps) => {
    let clockMs = Date.parse('2026-11-04T00:00:00Z');
    const { guard, svc, call } = await openService(token, () => clockMs);
    try {
      const first = await call('POST', '/api/setup', { body: { username: adminName, displayName: '管理員', password: PASS, setupToken: token } });
      expect(first.status).toBe(200);
      expect(guard.verify(token)).toBe(false);

      const usersBefore = (await call('GET', '/api/admin/users', { cookie: first.cookie })).body.users;
      expect(usersBefore).toHaveLength(1);

      for (const f of followUps) {
        clockMs += f.advanceMs;
        const setupToken = { same: token, other: f.otherToken, missing: undefined, empty: '', nonString: 12345 }[f.tokenKind];
        const body = { username: f.username, displayName: f.displayName, password: f.password, setupToken };
        const res = f.rawBody !== null
          ? await call('POST', '/api/setup', { raw: f.rawBody, source: sources[f.source] })
          : await call('POST', '/api/setup', { body, source: sources[f.source] });
        expect(res.status).toBe(409);
        expect(res.cookie).toBe('');
      }

      const usersAfter = (await call('GET', '/api/admin/users', { cookie: first.cookie })).body.users;
      expect(usersAfter).toEqual(usersBefore);
      expect(guard.verify(token)).toBe(false);
      expect((await call('GET', '/api/session')).body).toMatchObject({ needsSetup: false, setupTokenRequired: false });
    } finally {
      svc.close();
    }
  });

test('Property 17: after a successful setup every further setup request is 409 and users are unchanged', async () => {
  await fc.assert(property17(), { numRuns: 100 });
}, 300_000);

const TOKEN = 'A'.repeat(20) + '-_0123456789abcd';

test('a reserved name as the first setup username is 400, creates no user and leaves the Setup_Token valid', async () => {
  const { guard, svc, call } = await openService(TOKEN, () => Date.parse('2026-11-04T00:00:00Z'));
  try {
    const res = await call('POST', '/api/setup', { body: { username: 'api', displayName: '管理員', password: PASS, setupToken: TOKEN } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('這個帳號名稱已保留，請換一個。');
    expect(res.cookie).toBe('');
    expect(await userRows()).toEqual([]);
    expect(guard.verify(TOKEN)).toBe(true);
    expect((await call('GET', '/api/session')).body).toMatchObject({ needsSetup: true, setupTokenRequired: true });
  } finally {
    svc.close();
  }
});

test('after setup, a reserved username with the original token is 409 and users are unchanged', async () => {
  const { guard, svc, call } = await openService(TOKEN, () => Date.parse('2026-11-04T00:00:00Z'));
  try {
    const first = await call('POST', '/api/setup', { body: { username: 'admin-one', displayName: '管理員', password: PASS, setupToken: TOKEN } });
    expect(first.status).toBe(200);
    const before = await userRows();
    expect(before).toHaveLength(1);

    const res = await call('POST', '/api/setup', { body: { username: 'api', displayName: '管理員', password: PASS, setupToken: TOKEN } });
    expect(res.status).toBe(409);
    expect(res.cookie).toBe('');
    expect(await userRows()).toEqual(before);
    expect(guard.verify(TOKEN)).toBe(false);
  } finally {
    svc.close();
  }
});

test('Property 17 regression: build #16 seed passes', async () => {
  await fc.assert(property17(), { numRuns: 100, seed: BUILD_16_SEED });
}, 300_000);
