// Chrome_Comparison_Test (schedule-tab-css-parity design section 6.2).
// For each Viewport_Profile (parity-desktop, parity-mobile) and Theme (light, dark), Bun_App and LM_Web open the
// Comparison_Fixture's schedule tab in separate contexts with the same options. The Page_Chrome element trees must be
// equal (Property 3) and the masked Chrome_Region captures must match within the pixel budget (Property 14).
// Mobile adds one CDP touch swipe on the first activity card (Requirement 7.11); desktop adds the Requirement 2.5
// navigation checks.
//
// Property 3: Page_Chrome structure equivalence. Validates: Requirements 2.1, 2.2, 2.3, 2.4
// Property 14: Page_Chrome pixel parity. Validates: Requirements 6.1, 7.2, 7.6
// Also validates: Requirements 2.5, 7.1, 7.3, 7.4, 7.5, 7.7, 7.11
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test, expect } from '@playwright/test';
import {
  BUN_BASE_URL, BUN_SCHEDULE_PATH, LM_BASE_URL, LM_SESSION_KEY,
  beforeAllServersReachable, comparisonFixture, fakeBunAccount, loadLmTrip,
} from './support/fixture.js';
import { chromeScreenshotOptions, chromeTree, prepareCapture, waitForCapture } from './support/capture.js';

const PROFILES = ['desktop', 'mobile'];
const THEMES = ['light', 'dark'];
const SWIPE = { distance: 120, steps: 8, stepMs: 16 };

beforeAllServersReachable(test);

/** @type {Awaited<ReturnType<typeof loadLmTrip>>} */
let lmTrip;
test.beforeAll(async ({ playwright }) => {
  test.setTimeout(120000);
  const request = await playwright.request.newContext();
  try {
    lmTrip = await loadLmTrip(request, comparisonFixture());
  } finally {
    await request.dispose();
  }
});

const profileOf = testInfo => testInfo.project.name.replace(/^parity-/, '');

/** Context options shared by both apps: the project's Viewport_Profile, Reduced_Motion and no service worker. */
function contextOptions(testInfo) {
  const { viewport, deviceScaleFactor, hasTouch, isMobile } = testInfo.project.use;
  return { viewport, deviceScaleFactor, hasTouch, isMobile, reducedMotion: 'reduce', serviceWorkers: 'block' };
}

async function openBun(browser, testInfo, theme) {
  const context = await browser.newContext(contextOptions(testInfo));
  const page = await context.newPage();
  await fakeBunAccount(page, comparisonFixture());
  await prepareCapture(page, { app: 'bun', theme });
  await page.goto(`${BUN_BASE_URL}${BUN_SCHEDULE_PATH}`);
  await expect(page.locator('.section-tabs')).toBeVisible();
  await waitForCapture(page, { app: 'bun' });
  return { context, page };
}

/**
 * Opens LM_Web at the fixture trip. `theme` undefined leaves data-theme unset and installs no capture state.
 */
async function openLm(browser, testInfo, theme, path = lmTrip.schedulePath) {
  const context = await browser.newContext(contextOptions(testInfo));
  const page = await context.newPage();
  await page.addInitScript(({ key, session }) => {
    try { localStorage.setItem(key, session); } catch { /* the page then shows the login page */ }
  }, { key: LM_SESSION_KEY, session: JSON.stringify(lmTrip.session) });
  if (theme) await prepareCapture(page, { app: 'lm', theme });
  await page.goto(`${LM_BASE_URL}${path}`);
  await expect(page.locator('.section-tabs')).toBeVisible();
  await expect(page.locator('.workspace .activity-card').first()).toBeVisible();
  await waitForCapture(page, { app: 'lm' });
  return { context, page };
}

/**
 * Point inside `row` whose topmost element is row content, not a button, link or form control. The point is in
 * visual-viewport coordinates, which Input.dispatchTouchEvent expects; on a mobile page whose layout viewport is wider
 * than the screen these differ from the client coordinates that elementFromPoint takes.
 */
async function rowContentPoint(row, travel) {
  await row.scrollIntoViewIfNeeded();
  const point = await row.evaluate((el, travel) => {
    const box = el.getBoundingClientRect();
    const vv = window.visualViewport;
    const [left, top, width, height] = vv ? [vv.offsetLeft, vv.offsetTop, vv.width, vv.height]
      : [0, 0, innerWidth, innerHeight];
    const interactive = 'button, a, input, select, textarea, summary';
    for (const fy of [0.5, 0.3, 0.7, 0.2, 0.8]) {
      for (const fx of [0.8, 0.7, 0.6, 0.9, 0.5]) {
        const x = box.left + box.width * fx, y = box.top + box.height * fy;
        const vx = x - left, vy = y - top;
        if (vx - travel < 1 || vx >= width || vy < 1 || vy >= height) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit && el.contains(hit) && !hit.closest(interactive)) return { x: vx, y: vy };
      }
    }
    return null;
  }, travel);
  if (!point) throw new Error('no non-interactive point inside the first activity card for the swipe');
  return point;
}

/** One leftward CDP touch swipe of SWIPE.distance px over SWIPE.steps moves (Requirement 7.11). */
async function touchSwipe(context, page, row) {
  const { x, y } = await rowContentPoint(row, SWIPE.distance);
  const cdp = await context.newCDPSession(page);
  const touch = (type, px) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x: px, y, id: 1, radiusX: 1, radiusY: 1, force: 1 }],
  });
  await touch('touchStart', x);
  for (let step = 1; step <= SWIPE.steps; step++) {
    await page.waitForTimeout(SWIPE.stepMs);
    await touch('touchMove', x - (SWIPE.distance * step) / SWIPE.steps);
  }
  await touch('touchEnd', x - SWIPE.distance);
  await cdp.detach();
}

for (const profile of PROFILES) {
  for (const theme of THEMES) {
    const combination = `${profile}-${theme}`;
    test(`[chrome] ${combination}: Page_Chrome structure and pixels match Bun_App`, async ({ browser }, testInfo) => {
      test.skip(profileOf(testInfo) !== profile, `${combination} runs in parity-${profile}`);
      const bun = await openBun(browser, testInfo, theme);
      const lm = await openLm(browser, testInfo, theme);
      try {
        // Property 3: structure (Requirements 2.1–2.4)
        const [bunTree, lmTree] = [await chromeTree(bun.page), await chromeTree(lm.page)];
        for (const [region, tree] of Object.entries(bunTree)) {
          expect(tree, `${combination}: Bun_App renders ${region}`).not.toBeNull();
        }
        expect(lmTree, `${combination}: LM_Web Page_Chrome tree equals Bun_App`).toEqual(bunTree);
        await expect(lm.page.locator('.hero-art>.scene-motion.illustration.scene-motion--camp>svg+.countdown')).toHaveCount(1);
        await expect(lm.page.locator('main#main.page')).toHaveCount(1);
        await expect(lm.page.locator('.section-tabs+.workspace')).toHaveCount(1);
        await expect(lm.page.locator(':root')).toHaveAttribute('data-theme', theme);

        // Property 14: pixels (Requirements 6.1, 7.2, 7.6, 7.7). The Bun capture is the expected image.
        const name = `chrome-${combination}.png`;
        const bunShot = await bun.page.screenshot(await chromeScreenshotOptions(bun.page));
        const expected = testInfo.snapshotPath(name);
        await mkdir(dirname(expected), { recursive: true });
        await writeFile(expected, bunShot);
        await testInfo.attach(`bun-${name}`, { body: bunShot, contentType: 'image/png' });
        const lmShot = await lm.page.screenshot(await chromeScreenshotOptions(lm.page));
        expect(lmShot).toMatchSnapshot(name, { threshold: 0.2, maxDiffPixelRatio: 0.01 });

        // Requirement 7.11: left swipe opens the first activity card in Touch_Layout.
        if (profile === 'mobile') {
          const row = lm.page.locator('.workspace .activity-card').first();
          await expect(row).toHaveAttribute('data-swipe-ready', 'true');
          await touchSwipe(lm.context, lm.page, row);
          await expect(row).toHaveClass(/(^|\s)swipe-open(\s|$)/);
          const actions = row.locator(':scope > .swipe-actions > .swipe-action');
          expect(await actions.count(), `${combination}: the swipe panel has buttons`).toBeGreaterThan(0);
          for (const action of await actions.all()) await expect(action).toBeVisible();
        }
      } finally {
        await bun.context.close();
        await lm.context.close();
      }
    });
  }
}

test('[chrome] desktop: Page_Chrome navigation keeps working (Requirement 2.5)', async ({ browser }, testInfo) => {
  test.skip(profileOf(testInfo) !== 'desktop', 'runs in parity-desktop');
  const lm = await openLm(browser, testInfo, 'light');
  const { page } = lm;
  try {
    // Countdown under the fixed clock: 2026-10-01 to 2026-10-20 is 19 days.
    const countdown = page.locator('.hero-art .countdown');
    await expect(countdown.locator('small')).toHaveText('距離出發');
    await expect(countdown.locator('strong')).toHaveText('19');
    await expect(countdown.locator('span')).toHaveText('天');

    // Section tabs update ?tab= in place.
    const tabs = page.getByRole('navigation', { name: '旅行內容' }).getByRole('button');
    await expect(tabs).toHaveCount(5);
    for (const key of ['meals', 'shopping', 'gear', 'expenses', 'schedule']) {
      const tab = page.locator(`.section-tabs [data-tab="${key}"]`);
      await tab.click();
      await expect(page).toHaveURL(new RegExp(`[?&]tab=${key}(&|$)`));
      await expect(tab).toHaveAttribute('aria-current', 'page');
    }

    // 「邀請旅伴」 opens the Trip_Menu.
    await page.getByRole('button', { name: '邀請旅伴' }).click();
    await expect(page.getByRole('dialog', { name: '旅行選單' })).toBeVisible();
    await page.getByRole('button', { name: '關閉旅行選單' }).click();
    await expect(page.getByRole('dialog', { name: '旅行選單' })).toHaveCount(0);

    // 「出發模式」 goes to the Departure_Page.
    await page.getByRole('navigation', { name: '旅行模式' }).getByRole('link', { name: /出發模式/ }).click();
    await expect(page).toHaveURL(new RegExp(`${lmTrip.path}/go$`));

    // The breadcrumb goes to the Home_Page.
    await page.goto(`${LM_BASE_URL}${lmTrip.schedulePath}`);
    await page.getByRole('navigation', { name: '麵包屑' }).getByRole('link', { name: '我的旅行' }).click();
    const username = lmTrip.path.split('/')[1];
    await expect(page).toHaveURL(new RegExp(`/${username}/home$`));
  } finally {
    await lm.context.close();
  }
});
