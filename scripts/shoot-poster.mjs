// Dev helper: screenshot the poster at exact viewport widths, light and dark (Playwright + local Chrome).
//   bun scripts/shoot-poster.mjs
import { chromium } from '@playwright/test';
import { writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { posterHtml } from '../src/itinerary-poster.js';
import { mapLink } from '../src/maps.js';
import { exampleTrip } from '../tests/fixtures/example-trip.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const body = posterHtml(exampleTrip(), { icon: () => '', mapLink, canEdit: false });
const page = resolve(root, '.shoot-poster.html');
const browser = await chromium.launch({ executablePath: chrome });
for (const theme of ['light', 'dark']) {
  writeFileSync(page, `<!doctype html><html lang="zh-Hant" data-scene-motion="static"${theme === 'dark' ? ' data-theme="dark"' : ''}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="./src/styles.css"><link rel="stylesheet" href="./src/accounts.css"><link rel="stylesheet" href="./src/scene-motion.css"><link rel="stylesheet" href="./src/itinerary.css"></head>
<body><main id="main" style="max-width:1200px;margin:0 auto;padding:12px">${body}</main></body></html>`);
  for (const width of [390, 760, 1200]) {
    const tab = await browser.newPage({ viewport: { width, height: 900 } });
    await tab.goto('file:///' + page.replace(/\\/g, '/'));
    await tab.waitForTimeout(400);
    const out = resolve(root, 'previews', `poster-${theme}-${width}.png`);
    await tab.screenshot({ path: out, fullPage: true });
    const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log(`${theme} ${width}: horizontal overflow ${overflow}px -> ${out}`);
    await tab.close();
  }
}
await browser.close();
rmSync(page, { force: true });
