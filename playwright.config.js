import { defineConfig } from '@playwright/test';

// 瀏覽器測試設定（Requirement 3.8、3.9、5.3、5.6、5.7）。由 scripts/check-accounts.mjs 啟動；
// CHROME_PATH 必須指向 Chromium／Chrome 可執行檔，不提供任何預設路徑（含 Windows Chrome 路徑）。
// harness 已在啟動前驗證路徑存在且可執行；這裡只拒絕未設定的情況。
const chromePath = process.env.CHROME_PATH;
if (!chromePath) throw new Error('測試環境變數無效 CHROME_PATH: unset');

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.js',
  fullyParallel: true,
  workers: 2,
  retries: 0, // 失敗不自動重試（Req 5.3）
  timeout: 60000,
  expect: { timeout: 6000 },
  reporter: [
    ['list'],
    ['junit', { outputFile: 'reports/e2e-junit.xml' }],
    ['json', { outputFile: 'reports/e2e.json' }],
  ],
  use: {
    baseURL: process.env.CAMPING_BASE_URL || 'http://127.0.0.1:5173',
    headless: true,
    launchOptions: { executablePath: chromePath },
    // 失敗證據（Req 5.6）：截圖與 trace 依 project（視窗尺寸）與測試標題（含 TC ID）存於 outputDir。
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    // 重要頁面另於手機視窗執行（Req 5.7）；以測試標題中的 @critical 標記選取。
    { name: 'mobile', grep: /@critical/, use: { viewport: { width: 390, height: 844 } } },
  ],
  outputDir: './test-results',
});
