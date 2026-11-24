// Studio_Comparison_Test (rust-schedule-studio plan item 7): the schedule tab of Bun_App and LM_Web is the storybook
// studio (src/storybook/* in Bun, crates/web/src/views/studio/* in LM), rendered inside the open shadow root of
// `.story-studio-host`. For the same Studio_Fixture both apps are captured side by side at 1024 px, 1440 px (desktop
// project) and in the parity-mobile profile into %LOCALAPPDATA%\lm-ui-check (outside the repository; skipped when
// LOCALAPPDATA is unset), and the studio structure inside both shadow roots must be equal. A last LM-only test edits
// the trip in one window and checks that a second window follows, including 復原 and 重做.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import {
  BUN_BASE_URL, BUN_SCHEDULE_PATH, LM_BASE_URL, LM_SESSION_KEY,
  beforeAllServersReachable, comparisonFixture, fakeBunAccount, loadLmTrip,
} from './support/fixture.js';
import { BUN_EDITOR_HIDDEN_KEY, prepareCapture, waitForCapture } from './support/capture.js';

const SHOT_DIR = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'lm-ui-check') : null;
const EDITOR_WIDTH_KEY = 'storybook-editor-width-v2';
const DESKTOP_SIZES = [
  { name: '1024', viewport: { width: 1024, height: 900 } },
  { name: '1440', viewport: { width: 1440, height: 1000 } },
];

/** comparisonFixture() plus the storybook-only fields: cover texts, one arrival label and one gear stop with items. */
export function studioFixture() {
  const state = comparisonFixture();
  state.storybook = { headline: '夕淞露營小旅行', caption: '一起慢慢度日吧' };
  state.daySettings[0].arrivalLabel = '營地 12:00 可進場';
  const route = state.routes.find(r => r.id === 'rt-1-v1');
  route.stops = [{ id: 'st-2', place: 'pl-shop', kind: 'gear', taskKind: 'gear-pickup', items: ['營燈', '延長線'] }];
  return state;
}

beforeAllServersReachable(test);

/** @type {Awaited<ReturnType<typeof loadLmTrip>>} */
let lmTrip;
test.beforeAll(async ({ playwright }) => {
  test.setTimeout(120000);
  const request = await playwright.request.newContext();
  try {
    lmTrip = await loadLmTrip(request, studioFixture());
  } finally {
    await request.dispose();
  }
});

const profileOf = testInfo => testInfo.project.name.replace(/^parity-/, '');

function contextOptions(testInfo, viewport) {
  const { deviceScaleFactor, hasTouch, isMobile } = testInfo.project.use;
  return {
    viewport: viewport || testInfo.project.use.viewport, deviceScaleFactor, hasTouch, isMobile,
    reducedMotion: 'reduce', serviceWorkers: 'block'
  };
}

/** Editor expanded ('0') or collapsed ('1') through Bun's key, which LM_Web shares (plan D4); default editor width. */
async function studioPreferences(page, hidden) {
  await page.addInitScript(({ hiddenKey, widthKey, hidden }) => {
    try {
      localStorage.setItem(hiddenKey, hidden ? '1' : '0');
      localStorage.removeItem(widthKey);
    } catch { /* preference only */ }
  }, { hiddenKey: BUN_EDITOR_HIDDEN_KEY, widthKey: EDITOR_WIDTH_KEY, hidden });
}

/** Waits for fonts and for the journal and the editor day tabs inside the studio shadow root. */
async function waitForStudio(page) {
  await waitForCapture(page, { app: 'lm' }); // fonts only; the Bun collapsed-editor state does not apply here
  await page.waitForFunction(() => {
    const host = document.querySelector('.story-studio-host');
    const root = host?.shadowRoot;
    return !!root && !host.hasAttribute('data-loading')
      && root.querySelectorAll('.j-day').length > 0 && root.querySelectorAll('#dayTabs button').length > 0;
  }, null, { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function openApp(browser, testInfo, app, { viewport, hidden = false, session = lmTrip?.session, path } = {}) {
  const context = await browser.newContext(contextOptions(testInfo, viewport));
  const page = await context.newPage();
  if (app === 'bun') await fakeBunAccount(page, studioFixture());
  else {
    await page.addInitScript(({ key, session }) => {
      try { localStorage.setItem(key, session); } catch { /* the page then shows the login page */ }
    }, { key: LM_SESSION_KEY, session: JSON.stringify(session) });
  }
  await prepareCapture(page, { app, theme: 'light' });
  await studioPreferences(page, hidden);
  await page.goto(app === 'bun' ? `${BUN_BASE_URL}${BUN_SCHEDULE_PATH}` : `${LM_BASE_URL}${path || lmTrip.schedulePath}`);
  await expect(page.locator('.section-tabs')).toBeVisible();
  await waitForStudio(page);
  return { context, page };
}

/** Full-page screenshot to %LOCALAPPDATA%\lm-ui-check\studio-{app}-{name}.png; no file when LOCALAPPDATA is unset. */
async function shoot(page, app, name, testInfo) {
  const body = await page.screenshot({ fullPage: true, animations: 'disabled' });
  await testInfo.attach(`studio-${app}-${name}.png`, { body, contentType: 'image/png' });
  if (!SHOT_DIR) return;
  await mkdir(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, `studio-${app}-${name}.png`), fullPage: true, animations: 'disabled' });
}

/** The studio structure that both apps must render the same way, read from the host's shadow root. */
function studioStructure(page) {
  return page.evaluate(() => {
    const host = document.querySelector('.story-studio-host');
    const root = host.shadowRoot;
    const text = node => (node ? node.textContent.replace(/\s+/g, ' ').trim() : null);
    const texts = (scope, selector) => [...scope.querySelectorAll(selector)].map(text);
    // Leptos leaves empty comment markers after inner_html content; they are invisible and not part of the art.
    const markup = node => (node ? node.innerHTML.replace(/<!--[\s\S]*?-->/g, '') : null);
    const headArt = root.querySelector('.j-head-art')?.cloneNode(true);
    headArt?.querySelectorAll('.j-head-note').forEach(note => note.remove());
    const switcher = root.querySelector('#workspaceSwitch');
    return {
      days: [...root.querySelectorAll('.j-day')].map(day => ({
        classes: day.className,
        title: text(day.querySelector('.j-day-title')),
        routes: texts(day, '.j-route'),
        events: texts(day, '.j-event'),
      })),
      title: text(root.querySelector('.j-title')),
      sub: text(root.querySelector('.j-sub')),
      headNote: text(root.querySelector('.j-head-note')),
      editorTabs: texts(root, '#editorTabs [role=tab]'),
      dayTabs: texts(root, '#dayTabs button'),
      saveStatus: text(root.querySelector('#saveStatus')),
      headArt: markup(headArt),
      firstDayArt: markup(root.querySelector('.j-art')),
      narrow: !!root.querySelector('.studio.narrow'),
      switchVisible: !!switcher && switcher.getClientRects().length > 0 && getComputedStyle(switcher).display !== 'none',
    };
  });
}

/** Opens both apps with the same options, captures them, compares the structure and returns both pages. */
async function compareApps(browser, testInfo, name, options) {
  const bun = await openApp(browser, testInfo, 'bun', options);
  const lm = await openApp(browser, testInfo, 'lm', options);
  await shoot(bun.page, 'bun', name, testInfo);
  await shoot(lm.page, 'lm', name, testInfo);
  const [bunStructure, lmStructure] = [await studioStructure(bun.page), await studioStructure(lm.page)];
  expect(bunStructure.days.length, `${name}: Bun_App journal has days`).toBeGreaterThan(0);
  expect(bunStructure.saveStatus, `${name}: Bun_App #saveStatus`).toBe('已儲存');
  expect(lmStructure, `${name}: LM_Web studio structure equals Bun_App`).toEqual(bunStructure);
  return { bun, lm, structure: bunStructure };
}

async function closeAll(...apps) {
  for (const app of apps) await app?.context.close();
}

/** Runs the same studio action (click and wait) in each app. */
async function inBoth(apps, action) {
  for (const { page } of apps) await action(page);
}

for (const size of DESKTOP_SIZES) {
  test(`[studio] desktop ${size.name}: Bun_App and LM_Web render the same studio`, async ({ browser }, testInfo) => {
    test.skip(profileOf(testInfo) !== 'desktop', 'runs in parity-desktop');
    test.setTimeout(120000);
    const { bun, lm, structure } = await compareApps(browser, testInfo, size.name, { viewport: size.viewport });
    try {
      expect(structure.narrow, `${size.name}: the studio is not narrow`).toBe(false);
      expect(structure.title).toBe('夕淞露營小旅行');
      expect(structure.headNote).toBe('一起慢慢度日吧');
      expect(structure.days[0].routes.join('|')).toContain('超市／賣場');
      if (size.name !== '1440') return;
      const apps = [bun, lm];
      for (const tab of ['cover', 'assets']) {
        await inBoth(apps, async page => {
          await page.locator(`#tab-${tab}`).click();
          await expect(page.locator(`#panel-${tab}`)).toBeVisible();
        });
        await shoot(bun.page, 'bun', `1440-${tab}`, testInfo);
        await shoot(lm.page, 'lm', `1440-${tab}`, testInfo);
      }
      await inBoth(apps, async page => {
        await page.locator('#tab-plan').click();
        await page.locator('#toggleEditor').click();
        await expect(page.locator('.story-studio-host')).toHaveAttribute('data-editor-hidden', '');
        await expect(page.locator('#editorPanel')).toBeHidden();
      });
      await shoot(bun.page, 'bun', '1440-collapsed', testInfo);
      await shoot(lm.page, 'lm', '1440-collapsed', testInfo);
      const [bunCollapsed, lmCollapsed] = [await studioStructure(bun.page), await studioStructure(lm.page)];
      expect(lmCollapsed, '1440 collapsed: LM_Web studio structure equals Bun_App').toEqual(bunCollapsed);
      for (const { page } of apps) await expect(page.locator('.workspace .sidebar')).toBeVisible();
    } finally {
      await closeAll(bun, lm);
    }
  });
}

test('[studio] mobile: Bun_App and LM_Web render the same narrow studio', async ({ browser }, testInfo) => {
  test.skip(profileOf(testInfo) !== 'mobile', 'runs in parity-mobile');
  test.setTimeout(120000);
  const { bun, lm, structure } = await compareApps(browser, testInfo, 'mobile', {});
  try {
    expect(structure.narrow, 'mobile: .studio.narrow').toBe(true);
    expect(structure.switchVisible, 'mobile: #workspaceSwitch is visible').toBe(true);
    for (const { page } of [bun, lm]) await expect(page.locator('#viewEditor')).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await closeAll(bun, lm);
  }
});

test('[studio] desktop: edits, 復原 and 重做 in one LM window reach a second window', async ({ browser, playwright }, testInfo) => {
  test.skip(profileOf(testInfo) !== 'desktop', 'runs in parity-desktop');
  test.setTimeout(240000);
  // A trip of its own, so that the comparison tests above keep the unchanged fixture.
  const request = await playwright.request.newContext();
  let trip;
  try {
    trip = await loadLmTrip(request, studioFixture());
  } finally {
    await request.dispose();
  }
  const options = { viewport: { width: 1440, height: 1000 }, session: trip.session, path: trip.schedulePath };
  const a = await openApp(browser, testInfo, 'lm', options);
  const b = await openApp(browser, testInfo, 'lm', options);
  const within = { timeout: 10000 };
  try {
    const pa = a.page, pb = b.page;
    const dayB = pb.locator('.j-day').first();

    // 第 1 天: 當日標題
    await pa.locator('#day-tab-0').click();
    await pa.locator('#daySettings > summary').click();
    await pa.locator('#dayTitle').fill('出發囉');
    await pa.locator('#dayTitle').blur();
    await expect(pb.locator('#j-day-0')).toHaveText('出發囉', within);

    // 新增途中任務 on the first route (第一車, 出發地點 A → … → 夕淞度日營區) and its 待辦清單.
    await pa.locator('#section-routes').click();
    const routeOpen = await pa.locator('#route-entry-0').evaluate(el => el.open);
    if (!routeOpen) await pa.locator('#route-entry-0 > summary').click();
    const pathB = dayB.locator('.j-route').first().locator('.j-route-path');
    const segments = async () => (await pathB.textContent()).split(' → ').length;
    const segmentsBefore = await segments();
    await pa.locator('#addStop-0').click();
    await expect.poll(segments, within).toBe(segmentsBefore + 1);
    const stop = pa.locator('#stop-entry-0-1');
    await expect(stop).toHaveCount(1);
    if (!(await stop.evaluate(el => el.open))) await stop.locator(':scope > summary').click();
    await pa.locator('#stop-0-1-items').fill('冰塊\n炭');
    await pa.locator('#stop-0-1-items').blur();
    // The journal lists only shopping items (journal.js routeItem), so window B's editor shows the 待辦清單.
    await expect(pb.locator('#stop-0-1-items')).toHaveValue('冰塊\n炭', within);

    // 活動: ＋ 新增活動, then rename it (the new title is focused and selected).
    await pa.locator('#section-events').click();
    const eventsBefore = await dayB.locator('.j-event').count();
    await pa.locator('#addEvent').click();
    await expect(dayB.locator('.j-event')).toHaveCount(eventsBefore + 1, within);
    await expect(dayB.locator('.j-event-title', { hasText: '新活動' })).toHaveCount(1, within);
    const title = pa.locator('#eventList input[id$="-title"]:focus');
    await expect(title).toHaveCount(1);
    await title.fill('營火晚會');
    await title.blur();
    await expect(dayB.locator('.j-event-title', { hasText: '營火晚會' })).toHaveCount(1, within);

    // 復原 reverts the last edit (the rename) in the other window; 重做 brings it back.
    await pa.locator('#undoEdit').click();
    await expect(dayB.locator('.j-event-title', { hasText: '營火晚會' })).toHaveCount(0, within);
    await expect(dayB.locator('.j-event-title', { hasText: '新活動' })).toHaveCount(1, within);
    await pa.locator('#redoEdit').click();
    await expect(dayB.locator('.j-event-title', { hasText: '營火晚會' })).toHaveCount(1, within);
    await expect(pb.locator('#j-day-0')).toHaveText('出發囉');
    await expect(pb.locator('#stop-0-1-items')).toHaveValue('冰塊\n炭');

    await expect(pa.locator('#saveStatus')).toHaveText('已儲存', { timeout: 15000 });
    await shoot(pb, 'lm', '1440-synced', testInfo);

    // The edits are stored by lm-server: a reload of window B reads them back (stop items are a storybook field, D1).
    await pb.reload();
    await expect(pb.locator('#j-day-0')).toHaveText('出發囉', within);
    await expect(pb.locator('.j-day').first().locator('.j-event-title', { hasText: '營火晚會' })).toHaveCount(1, within);
    await pb.locator('#section-routes').click();
    const routeOpenB = await pb.locator('#route-entry-0').evaluate(el => el.open);
    if (!routeOpenB) await pb.locator('#route-entry-0 > summary').click();
    const stopB = pb.locator('#stop-entry-0-1');
    if (!(await stopB.evaluate(el => el.open))) await stopB.locator(':scope > summary').click();
    await expect(pb.locator('#stop-0-1-items')).toHaveValue('冰塊\n炭', within);
  } finally {
    await closeAll(a, b);
  }
});
