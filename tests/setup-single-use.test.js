// Feature: jenkins-cicd-deploy, Property 17: Setup_Token 單次有效
// **Validates: Requirements 9.5, 9.6**
// 成功完成首次設定後，任意後續設定請求（任意 token、任意來源、任意 body）皆回應 409，使用者集合不變；
// 且 guard.verify 對原 token 回傳 false。
import { test, expect } from 'bun:test';
import fc from 'fast-check';
import { createAccountService } from '../server/accounts.js';
import { createSetupGuard } from '../server/setup-guard.js';
import { useTestDatabase, resetTables, serviceDb } from './support/pg.js';

// 每個測試檔一個隔離 schema；每次 fast-check 執行前以 resetTables 清空資料表（任務 5.13）。
const db = useTestDatabase();

const LAN = 'http://192.168.1.10:5173';
const LOOP = 'http://127.0.0.1:5173';
const PASS = 'correct horse battery';

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

test('Property 17: after a successful setup every further setup request is 409 and users are unchanged', async () => {
  await fc.assert(
    fc.asyncProperty(tokenArb, usernameArb, fc.array(followUpArb, { minLength: 1, maxLength: 12 }), async (token, adminName, followUps) => {
      let clockMs = Date.parse('2026-11-04T00:00:00Z');
      const guard = createSetupGuard({ bindAddress: '0.0.0.0', setupToken: token, log: () => {} });
      await resetTables(db.sql);
      const svc = await createAccountService({ db: serviceDb(db.sql), now: () => clockMs, setup: guard });
      try {
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
    }),
    { numRuns: 100 },
  );
}, 300_000);
