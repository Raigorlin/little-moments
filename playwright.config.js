import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests', testMatch:'**/*.e2e.js', fullyParallel:true, workers:2, retries:0,
  timeout:60000, expect:{timeout:6000}, reporter:'list',
  use:{baseURL:process.env.CAMPING_BASE_URL||'http://127.0.0.1:5173',headless:true,viewport:{width:1440,height:1000},launchOptions:{executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'},screenshot:'only-on-failure',trace:'retain-on-failure'},
  outputDir:'./test-results'
});
