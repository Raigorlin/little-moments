// 安全測試：XSS（Requirement 7.6）。注入的腳本內容於頁面中以文字呈現且不被執行（window.__xss 未被設定）。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BASE, CONNECT, ORIGIN, createTrip, registerMember } from './support.js';

const PAYLOADS = [
  '<script>window.__xss=1</script>',
  '<img src=x onerror="window.__xss=2">',
  '<svg onload="window.__xss=3"></svg>',
  '"><iframe srcdoc="<script>parent.__xss=4</script>">',
  "javascript:window.__xss=5//",
];

let browser;
beforeAll(async () => {
  const chromePath = process.env.CHROME_PATH;
  if (!chromePath) throw new Error('測試環境變數無效 CHROME_PATH: unset（XSS 檢查需要 Chromium）');
  const { chromium } = await import('playwright');
  // CAMPING_SECURITY_CONNECT_ADDRESS 設定時，讓瀏覽器把 base URL 的主機名稱解析到該位址（Host 標頭仍為原名稱）。
  const hostname = BASE.hostname.replace(/^\[|\]$/g, '');
  const args = CONNECT !== hostname ? [`--host-resolver-rules=MAP ${hostname} ${CONNECT}`] : [];
  browser = await chromium.launch({ headless: true, executablePath: chromePath, args });
});
afterAll(async () => { await browser?.close(); });

describe('XSS', () => {
  test('[TC-SEC-010] XSS：行程卡片與行程頁以文字呈現注入內容且不執行腳本', async () => {
    const member = await registerMember('sec-xss');
    const trips = [];
    for (const payload of PAYLOADS) trips.push({ payload, trip: await createTrip(member.cookie, payload) });
    const context = await browser.newContext({ baseURL: ORIGIN, serviceWorkers: 'block' });
    try {
      await context.addCookies([{ name: 'ggc_session', value: member.cookie, url: ORIGIN, httpOnly: true, sameSite: 'Strict', secure: BASE.protocol === 'https:' }]);
      const page = await context.newPage();
      const dialogs = [];
      page.on('dialog', d => { dialogs.push(d.message()); void d.dismiss(); });
      await page.goto(`/${member.user.username}/home`);
      for (const { payload, trip } of trips) {
        const card = page.locator(`.acct-trip-card[data-trip-id="${trip.id}"]`);
        await card.waitFor({ timeout: 15000 });
        expect(await card.innerText()).toContain(payload);
      }
      expect(await page.evaluate(() => window.__xss)).toBeUndefined();
      expect(await page.locator('.acct-trip-card iframe, .acct-trip-card script, .acct-trip-card img[src="x"]').count()).toBe(0);
      for (const { payload, trip } of trips.slice(0, 2)) {
        await page.goto(`/${member.user.username}/trips/${trip.id}`);
        await page.locator('.hero h1').waitFor({ timeout: 15000 });
        expect(await page.locator('.hero h1').innerText()).toBe(payload);
        expect(await page.evaluate(() => window.__xss)).toBeUndefined();
      }
      expect(dialogs).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120000);
});
