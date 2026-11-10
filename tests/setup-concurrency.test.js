// Feature: jenkins-cicd-deploy, Property 20: 並行首次設定只建立一個管理員
// 2..6 個同時送出、皆通過授權（Setup_Token 或本機 loopback）的有效設定請求：
// 恰有一個回應 200，其餘回應 409，Database 中恰有一個 admin 使用者，且即為勝出者。
// **Validates: Requirements 9.11**
import { test, expect } from 'bun:test';
import fc from 'fast-check';
import { createAccountService } from '../server/accounts.js';
import { createSetupGuard } from '../server/setup-guard.js';
import { useTestDatabase, resetTables, serviceDb } from './support/pg.js';

// 每個測試檔一個隔離 schema；每次 fast-check 執行前以 resetTables 清空資料表（任務 5.13）。
const db = useTestDatabase();

const NOW = Date.parse('2026-11-04T00:00:00Z');
const PASS = 'correct horse battery';
const RESERVED = new Set(['api', 'admin', 'setup', 'login', 'register', 'logout', 'demo', 'assets']);
const ORIGINS = {
  lan: { base: 'http://192.168.1.10:5173', info: { ip: '192.168.1.20', tcpIp: '192.168.1.20', viaProxy: false } },
  loopback: { base: 'http://127.0.0.1:5173', info: { ip: '127.0.0.1', tcpIp: '127.0.0.1', viaProxy: false } },
};

// 任務 5.13：工廠改用 PostgreSQL 測試 schema；每次執行前清空資料表。
async function makeService(setupToken) {
  const setup = createSetupGuard({ bindAddress: '0.0.0.0', setupToken, log: () => {} });
  await resetTables(db.sql);
  const svc = await createAccountService({ db: serviceDb(db.sql), now: () => NOW, setup });
  return { svc, close: async () => { await svc.close(); } };
}

async function call(svc, method, path, { origin, body, cookie }) {
  const { base, info } = ORIGINS[origin];
  const headers = { origin: base };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await svc.handle(new Request(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), info);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

const tokenArb = fc.string({ unit: fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'), minLength: 32, maxLength: 48 });
const usernameArb = fc.stringMatching(/^[a-z][a-z0-9-]{2,12}$/).filter(u => !RESERVED.has(u));
// 每個請求：不同帳號名稱 + 授權方式（LAN 附 token，或本機 loopback 不附 token）
const requestsArb = fc.uniqueArray(usernameArb, { minLength: 2, maxLength: 6 }).chain(names =>
  fc.tuple(...names.map(username => fc.record({ username: fc.constant(username), origin: fc.constantFrom('lan', 'loopback') }))));

test('Property 20: 並行首次設定只建立一個管理員', async () => {
  await fc.assert(fc.asyncProperty(tokenArb, requestsArb, async (token, requests) => {
    const { svc, close } = await makeService(token);
    try {
      const results = await Promise.all(requests.map(r => call(svc, 'POST', '/api/setup', {
        origin: r.origin,
        body: { username: r.username, displayName: '管理員', password: PASS, ...(r.origin === 'lan' ? { setupToken: token } : {}) },
      })));
      const statuses = results.map(r => r.status);
      const winners = results.map((r, i) => [r, requests[i]]).filter(([r]) => r.status === 200);
      expect(winners.length).toBe(1);
      expect(statuses.filter(s => s === 409).length).toBe(requests.length - 1);

      const [winRes, winReq] = winners[0];
      expect(winRes.body.user).toMatchObject({ username: winReq.username, role: 'admin' });
      const list = await call(svc, 'GET', '/api/admin/users', { origin: winReq.origin, cookie: winRes.cookie });
      expect(list.status).toBe(200);
      expect(list.body.users.length).toBe(1);
      expect(list.body.users[0]).toMatchObject({ username: winReq.username, role: 'admin' });
      // 直接查詢 Database：恰一個使用者，且為 admin
      const rows = await db.sql`SELECT username, role FROM users`;
      expect(Array.from(rows, r => ({ ...r }))).toEqual([{ username: winReq.username, role: 'admin' }]);
    } finally {
      await close();
    }
  }), { numRuns: 100 });
}, 300_000);
