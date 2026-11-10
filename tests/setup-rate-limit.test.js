// Feature: jenkins-cicd-deploy, Property 18: 首次設定限速
// **Validates: Requirements 9.8, 9.9**
import { test, expect } from 'bun:test';
import fc from 'fast-check';
import { createAccountService } from '../server/accounts.js';
import { createSetupGuard } from '../server/setup-guard.js';
import { useTestDatabase, resetTables, serviceDb } from './support/pg.js';

// 每個測試檔一個隔離 schema；每次 fast-check 執行前以 resetTables 清空資料表（任務 5.13）。
const db = useTestDatabase();

const LAN = 'http://192.168.1.10:5173';
const TOKEN = 'setup-token-placeholder-0123456789abcdef';
const WRONG = 'wrong-token-value-wrong-token-value-xx';
const MAX = 30;
const WINDOW = 15 * 60000;
const ADMIN = { username: 'admin-one', displayName: '管理員', password: 'correct horse battery' };

const infoFor = c => ({ ip: `192.168.1.${20 + c}`, tcpIp: `192.168.1.${20 + c}`, viaProxy: false });

async function call(svc, method, path, { body, info }) {
  const headers = { origin: LAN };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await svc.handle(new Request(LAN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), info);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// 參考模型：每個用戶端一個固定時間窗；先判斷是否已達上限（達上限時不計數、不驗證），再計數。
function modelStep(model, { client, token }, now) {
  const entry = model.limits.get(client);
  if (entry && entry.reset > now && entry.count >= MAX) return 429;
  if (!entry || entry.reset <= now) model.limits.set(client, { count: 1, reset: now + WINDOW });
  else entry.count++;
  if (model.userCreated) return 409;
  if (token !== 'correct') return 403;
  model.userCreated = true;
  return 200;
}

const clientArb = fc.oneof({ weight: 6, arbitrary: fc.constant(0) }, { weight: 2, arbitrary: fc.constant(1) }, { weight: 1, arbitrary: fc.constant(2) });
const tokenArb = fc.oneof(
  { weight: 15, arbitrary: fc.constant('wrong') },
  { weight: 15, arbitrary: fc.constant('missing') },
  { weight: 1, arbitrary: fc.constant('correct') },
);
const advanceArb = fc.oneof(
  { weight: 6, arbitrary: fc.constant(0) },
  { weight: 4, arbitrary: fc.integer({ min: 1, max: 60000 }) },
  { weight: 1, arbitrary: fc.integer({ min: WINDOW - 2000, max: WINDOW + 2000 }) },
);
const singleArb = fc.record({ client: clientArb, token: tokenArb, advance: advanceArb }).map(r => [r]);
// 突發：同一用戶端在同一時間點送出 31..34 次錯誤 token，最後附一個正確 token 的請求
const burstArb = fc.record({ client: clientArb, n: fc.integer({ min: MAX + 1, max: MAX + 4 }), advance: advanceArb })
  .map(({ client, n, advance }) => [
    { client, token: 'wrong', advance },
    ...Array.from({ length: n - 1 }, () => ({ client, token: 'wrong', advance: 0 })),
    { client, token: 'correct', advance: 0 },
  ]);
const opsArb = fc.array(fc.oneof({ weight: 8, arbitrary: singleArb }, { weight: 1, arbitrary: burstArb }), { minLength: 1, maxLength: 40 })
  .map(groups => groups.flat());

test('Property 18: 每用戶端每 15 分鐘最多 30 次設定請求，超過即 429 且不驗證 token、不建立使用者', async () => {
  await fc.assert(fc.asyncProperty(opsArb, async ops => {
    let clockMs = Date.parse('2026-11-04T00:00:00Z');
    const setup = createSetupGuard({ bindAddress: '0.0.0.0', setupToken: TOKEN, log: () => {} });
    await resetTables(db.sql);
    const svc = await createAccountService({ db: serviceDb(db.sql), now: () => clockMs, setup });
    const model = { limits: new Map(), userCreated: false };
    try {
      for (const op of ops) {
        clockMs += op.advance;
        const expected = modelStep(model, op, clockMs);
        const extra = op.token === 'correct' ? { setupToken: TOKEN } : op.token === 'wrong' ? { setupToken: WRONG } : {};
        const res = await call(svc, 'POST', '/api/setup', { body: { ...ADMIN, ...extra }, info: infoFor(op.client) });
        expect(res.status).toBe(expected);
        // 使用者是否建立只由模型決定；429 不得建立使用者（GET /api/session 不計入設定限速）
        const session = await call(svc, 'GET', '/api/session', { info: infoFor(9) });
        expect(session.body.needsSetup).toBe(!model.userCreated);
      }
    } finally {
      svc.close();
    }
  }), { numRuns: 100 });
}, 300000);
