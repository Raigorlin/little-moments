// 認領 harness 預先建立的 E2E member 帳號（見 tests/support/e2e-seed-members.mjs）。
//
// 每個帳號只會被認領一次：以 O_EXCL（'wx'）在 CAMPING_E2E_POOL_DIR 建立同名標記檔，
// 跨 Playwright worker、project（desktop／mobile）與重啟的 worker 都是原子操作。
// 認領後以 POST /api/login 登入（成功登入不計入任何限速），回傳 /api/login 的 user 物件。
import { openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@playwright/test';

function poolConfig(env = process.env) {
  const dir = env.CAMPING_E2E_POOL_DIR, prefix = env.CAMPING_E2E_POOL_PREFIX, size = Number(env.CAMPING_E2E_POOL_SIZE), password = env.CAMPING_E2E_POOL_PASSWORD;
  const missing = [['CAMPING_E2E_POOL_DIR', dir], ['CAMPING_E2E_POOL_PREFIX', prefix], ['CAMPING_E2E_POOL_PASSWORD', password]].filter(([, v]) => !v).map(([k]) => k);
  if (!Number.isInteger(size) || size < 1) missing.push('CAMPING_E2E_POOL_SIZE');
  if (missing.length) throw new Error(`E2E 帳號池未設定（${missing.join('、')}）；請以 node scripts/check-accounts.mjs 執行瀏覽器測試`);
  return { dir, prefix, size, password };
}

/** 認領下一個未使用的帳號名稱；帳號池用盡時明確失敗。 */
export function claimPoolAccount(env = process.env) {
  const { dir, prefix, size, password } = poolConfig(env);
  for (let i = 0; i < size; i++) {
    const username = `${prefix}-${String(i).padStart(3, '0')}`;
    try { closeSync(openSync(join(dir, username), 'wx')); return { username, password }; }
    catch (e) { if (e?.code !== 'EEXIST') throw e; }
  }
  throw new Error(`E2E 帳號池已用盡（${size} 個）；請調高 scripts/check-accounts.mjs 的 POOL_SIZE`);
}

/** 以全新的 member 帳號登入 `page` 的 request context（與瀏覽器分頁共用 Cookie）。 */
export async function poolMember(page, baseUrl) {
  const { username, password } = claimPoolAccount();
  const res = await page.request.fetch(new URL('/api/login', baseUrl).href, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(baseUrl).origin }, data: { username, password } });
  expect(res.status(), `pool login ${username}`).toBe(200);
  const { user } = await res.json();
  return { ...user, password };
}
