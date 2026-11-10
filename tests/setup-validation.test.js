// Feature: jenkins-cicd-deploy, Property 19: 輸入驗證失敗不消耗 Setup_Token
// 已通過授權（附正確 Setup_Token）但帳號、顯示名稱或密碼無效的設定請求 → 400、不建立使用者；
// 之後以同一 token 送出有效請求仍會成功。
// **Validates: Requirements 9.10**
import { test, expect } from 'bun:test';
import fc from 'fast-check';
import { createAccountService } from '../server/accounts.js';
import { createSetupGuard } from '../server/setup-guard.js';
import { useTestDatabase, resetTables, serviceDb } from './support/pg.js';

// 每個測試檔一個隔離 schema；每次 fast-check 執行前以 resetTables 清空資料表（任務 5.13）。
const db = useTestDatabase();

const LAN = 'http://192.168.1.10:5173';
const LAN_INFO = { ip: '192.168.1.20', tcpIp: '192.168.1.20', viaProxy: false };
const USERNAME = /^[a-z][a-z0-9-]{2,31}$/;
const RESERVED = new Set(['api', 'admin', 'setup', 'login', 'register', 'logout', 'demo', 'assets']);

// 長度 ≥ 32、僅含 base64url 字元的 token
const tokenArb = fc.string({ unit: fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'), minLength: 32, maxLength: 64 });

// ---- 有效欄位 ----
const validUsernameArb = fc.stringMatching(/^[a-z][a-z0-9-]{2,12}$/).filter(u => !RESERVED.has(u));
const validDisplayNameArb = fc.constantFrom('管理員', 'Camp Admin', '小林 🏕️', 'Ada');
const validPasswordArb = fc.string({ unit: fc.constantFrom('a', 'Z', '9', ' ', '露', '🏕'), minLength: 12, maxLength: 40 });

// ---- 無效欄位（undefined 代表欄位缺漏，JSON.stringify 會省略）----
const nonString = fc.oneof(fc.constant(undefined), fc.constant(null), fc.integer(), fc.boolean(), fc.constant([]), fc.constant({}));
const invalidUsernameArb = fc.oneof(
  nonString,
  fc.constantFrom(...RESERVED),
  fc.constantFrom('', 'ab', 'Admin-one', '1admin', '-admin', 'admin_one', 'admin one', 'ädmin', 'a'.repeat(33)),
  fc.string({ maxLength: 40 }).filter(s => !USERNAME.test(s)),
);
const invalidDisplayNameArb = fc.oneof(
  nonString,
  fc.constantFrom('', '   ', '\t\n', '\u200B', '名字\u0001', 'abc\u202Edef'),
  fc.integer({ min: 31, max: 60 }).map(n => '露'.repeat(n)),
);
const invalidPasswordArb = fc.oneof(
  nonString,
  fc.string({ unit: fc.constantFrom('a', '9', ' ', '露', '🏕'), maxLength: 11 }),
  fc.string({ unit: fc.constantFrom('a', '9', '露', '🏕'), minLength: 129, maxLength: 160 }),
);

// 至少一個欄位無效；其餘欄位可能有效
const invalidBodyArb = fc
  .record({ badUser: fc.boolean(), badName: fc.boolean(), badPass: fc.boolean() })
  .filter(f => f.badUser || f.badName || f.badPass)
  .chain(f => fc.record({
    username: f.badUser ? invalidUsernameArb : validUsernameArb,
    displayName: f.badName ? invalidDisplayNameArb : validDisplayNameArb,
    password: f.badPass ? invalidPasswordArb : validPasswordArb,
  }));

async function post(svc, body) {
  const res = await svc.handle(new Request(LAN + '/api/setup', {
    method: 'POST',
    headers: { origin: LAN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), LAN_INFO);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function needsSetup(svc) {
  const res = await svc.handle(new Request(LAN + '/api/session', { headers: { origin: LAN } }), LAN_INFO);
  return (await res.json()).needsSetup;
}

test('Property 19: 輸入驗證失敗回應 400、不建立使用者，且 Setup_Token 仍可使用', async () => {
  await fc.assert(fc.asyncProperty(
    tokenArb,
    fc.array(invalidBodyArb, { minLength: 1, maxLength: 5 }), // 遠低於每 15 分 30 次限速
    fc.integer({ min: 0, max: 3 }).map(n => n === 0),         // 約 1/4 的執行以完整有效請求收尾（scrypt 較慢）
    validUsernameArb,
    async (token, invalidBodies, finishWithValid, username) => {
      const guard = createSetupGuard({ bindAddress: '0.0.0.0', setupToken: token, log: () => {} });
      await resetTables(db.sql);
      const svc = await createAccountService({ db: serviceDb(db.sql), now: () => Date.parse('2026-11-04T00:00:00Z'), setup: guard });
      try {
        for (const body of invalidBodies) {
          const res = await post(svc, { ...body, setupToken: token });
          expect(res.status).toBe(400);
          expect(await needsSetup(svc)).toBe(true); // 使用者數仍為 0
        }
        // token 未被消耗
        expect(guard.verify(token)).toBe(true);
        if (finishWithValid) {
          const ok = await post(svc, { username, displayName: '管理員', password: 'correct horse battery', setupToken: token });
          expect(ok.status).toBe(200);
          expect(ok.body.user).toMatchObject({ username, role: 'admin' });
          expect(await needsSetup(svc)).toBe(false);
        }
      } finally {
        svc.close();
      }
    },
  ), { numRuns: 120 });
}, 120_000);

test('Property 19 (example): 至少一次以同一 token 在多次 400 後成功建立管理員', async () => {
  const token = 'setup-token-placeholder-0123456789abcdef';
  const guard = createSetupGuard({ bindAddress: '0.0.0.0', setupToken: token, log: () => {} });
  await resetTables(db.sql);
  const svc = await createAccountService({ db: serviceDb(db.sql), now: () => Date.parse('2026-11-04T00:00:00Z'), setup: guard });
  try {
    for (const body of [
      { username: 'admin', displayName: '管理員', password: 'correct horse battery' },
      { username: 'admin-one', displayName: '   ', password: 'correct horse battery' },
      { username: 'admin-one', displayName: '管理員', password: 'short' },
      { username: 'admin-one', displayName: '管理員' },
    ]) expect((await post(svc, { ...body, setupToken: token })).status).toBe(400);
    expect(await needsSetup(svc)).toBe(true);
    expect((await post(svc, { username: 'admin-one', displayName: '管理員', password: 'correct horse battery', setupToken: token })).status).toBe(200);
  } finally {
    svc.close();
  }
});
