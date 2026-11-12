// 認領 harness 預先建立的 E2E member 帳號（見 tests/support/e2e-seed-members.mjs）。
//
// 每個帳號只會被認領一次：以 O_EXCL（'wx'）在 CAMPING_E2E_POOL_DIR 建立同名標記檔，
// 跨 Playwright worker、project（desktop／mobile）與重啟的 worker 都是原子操作。
// 認領後以 POST /api/login 登入（成功登入不計入任何限速），回傳 /api/login 的 user 物件。
import { openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { expect, request as playwrightRequest } from '@playwright/test';

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

/** scripts/check-accounts.mjs 建立的首次管理員（合成帳號，只存在於拋棄式 E2E DATABASE）。 */
export const E2E_ADMIN = Object.freeze({ username: 'qa-admin', password: 'Local-Only-Test-Pass-2026' });

/**
 * 以全新的 member 帳號登入 `requestContext`（APIRequestContext；page.request 與瀏覽器分頁共用 Cookie）。
 * `displayName` 指定時，由管理員以 PATCH /api/admin/users/<id> 改名（取代原本以註冊 API 指定顯示名稱）。
 */
export async function poolLogin(requestContext, baseUrl, { displayName } = {}) {
  const { username, password } = claimPoolAccount();
  const origin = new URL(baseUrl).origin;
  const headers = { 'Content-Type': 'application/json', Origin: origin };
  const res = await requestContext.fetch(new URL('/api/login', baseUrl).href, { method: 'POST', headers, data: { username, password } });
  expect(res.status(), `pool login ${username}`).toBe(200);
  let { user } = await res.json();
  if (displayName !== undefined && displayName !== user.displayName) {
    const admin = await playwrightRequest.newContext();
    try {
      const login = await admin.fetch(new URL('/api/login', baseUrl).href, { method: 'POST', headers, data: E2E_ADMIN });
      expect(login.status(), 'admin login for pool display name').toBe(200);
      const patched = await admin.fetch(new URL(`/api/admin/users/${user.id}`, baseUrl).href, { method: 'PATCH', headers, data: { displayName } });
      expect(patched.status(), `rename pool account ${username}`).toBe(200);
      const { user: renamed } = await patched.json();
      user = { id: renamed.id, username: renamed.username, displayName: renamed.displayName, role: renamed.role };
    } finally {
      await admin.dispose();
    }
  }
  return { ...user, password };
}

/** 以全新的 member 帳號登入 `page` 的 request context（與瀏覽器分頁共用 Cookie）。 */
export function poolMember(page, baseUrl, options) {
  return poolLogin(page.request, baseUrl, options);
}
