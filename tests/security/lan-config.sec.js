// 安全測試：非 loopback 部署設定（Requirement 10.10、10.11）。
//
// Pipeline 以 CAMPING_BIND_ADDRESS=0.0.0.0、Allowed_Hosts 含非 loopback Host 名稱啟動 Test_Environment，
// 並設定 CAMPING_SECURITY_REQUIRE_LAN_HOST=1，使整個套件經由該非 loopback Host 名稱發送請求。
// 本機以 scripts/security-suite.mjs 的 lan 組執行：伺服器綁定 127.0.0.1（避免暴露給 LAN），Host 標頭為
// lm-test.lan，TCP 經 CAMPING_SECURITY_CONNECT_ADDRESS 連到 127.0.0.1。
// Req 10 第 1–6 條由同一套件的 origin／session／paths-headers 檔案在此設定下驗證；本檔補上
// 設定本身的檢查與第 7–8 條可由外部觀察的行為。第 7–8 條的儲存格式（scrypt 參數、16 位元組鹽值）
// 由 tests/password.test.js（Property 23）驗證；第 9 條（SQLite_Importer 保留密碼雜湊）由
// tests/import-sqlite-roundtrip.test.js（Property 33）驗證，兩者都不受網路設定影響。
import { describe, expect, test } from 'bun:test';
import { BASE, ORIGIN, PORT, ensureReady, isLoopbackHostname, login, registerMember, request } from './support.js';

const requireLan = process.env.CAMPING_SECURITY_REQUIRE_LAN_HOST === '1';

describe('非 loopback 部署設定', () => {
  test('[TC-SEC-100] LAN 設定：base URL 使用非 loopback Host 名稱（CAMPING_SECURITY_REQUIRE_LAN_HOST=1 時強制）', () => {
    if (requireLan) expect(isLoopbackHostname(BASE.hostname)).toBe(false);
    else expect(typeof BASE.hostname).toBe('string');
  });

  test('[TC-SEC-101] LAN 設定 Origin 檢查：經 LAN Host 名稱的請求：Origin 為 localhost 或 127.0.0.1 時一律拒絕（Req 10.2）', async () => {
    const member = await registerMember('sec-lan');
    for (const origin of ['http://localhost', `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]) {
      if (origin === ORIGIN) continue;
      const r = await request('/api/trips', { method: 'POST', origin, cookie: member.cookie, body: { title: 'LAN Origin 測試' } });
      expect(r.status).toBe(403);
    }
    expect((await request('/api/trips', { cookie: member.cookie })).json.trips.some(t => t.title === 'LAN Origin 測試')).toBe(false);
  }, 30000);

  test('[TC-SEC-102] LAN 設定：首次管理員設定在非 loopback 用戶端不可繞過（已設定時一律 409，未授權時 403）', async () => {
    // 本程序在要求設定碼的全新目標上完成設定時，先記錄了三種未授權嘗試（support.js ensureReady）：
    // 缺少設定碼、設定碼錯誤、偽造 X-Forwarded-For: 127.0.0.1，皆須 403 且不建立 Session（Req 9.1、9.4、9.12）。
    // 本機以 loopback 綁定執行時不啟用設定碼，該部分由 tests/setup-guard.test.js（Property 16）涵蓋。
    const { setupAttempts } = await ensureReady();
    if (setupAttempts) {
      expect(setupAttempts.map(a => [a.reason, a.status, a.sessionIssued])).toEqual([
        ['missing_token', 403, false], ['token_mismatch', 403, false], ['forged_forwarded_for', 403, false],
      ]);
    }
    // 已有管理員：不論來源、設定碼或偽造的轉送標頭一律 409（Req 9.6）。
    for (const headers of [{}, { 'X-Forwarded-For': '127.0.0.1' }]) {
      const r = await request('/api/setup', { method: 'POST', headers, body: { username: 'sec-takeover', displayName: '接管', password: 'Sec-Takeover-Placeholder-1', setupToken: 'x'.repeat(43) } });
      expect([409, 429]).toContain(r.status);
      expect(r.setCookies.some(c => /^ggc_session=[^;]+/.test(c))).toBe(false);
    }
  }, 30000);

  test('[TC-SEC-103] LAN 設定 密碼驗證：正確密碼登入成功，錯誤、大小寫不同或截斷的密碼失敗（Req 10.7、10.8 可觀察行為）', async () => {
    const member = await registerMember('sec-pass');
    expect((await login(member.user.username, member.password)).status).toBe(200);
    for (const wrong of [member.password.toLowerCase(), member.password.slice(0, -1), `${member.password} `]) {
      const r = await login(member.user.username, wrong);
      expect(r.status).toBe(401);
      expect(r.cookie).toBeNull();
    }
    expect((await login(member.user.username, member.password)).status).toBe(200);
  }, 30000);
});
