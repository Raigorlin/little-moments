import { exampleTripTest as test, expect, EXAMPLE_TEXT } from './local-planner-fixture.js';
import { STORAGE_KEY } from '../src/model.js';
// 行程圖的瀏覽器測試（需求 13.1 至 13.4、13.6 至 13.9、15.2、15.3、15.7、15.8、23.15）。
// 本機版載入 Example_Trip（tests/fixtures/example-trip.js），不需要伺服器登入。

const MOTION_KEY = 'ggc-scene-motion';
const SUMMARY = '三天兩夜・四台車・10/20（週二）至 10/22（週四）';
const poster = p => p.locator('.itinerary-poster');
const posterToggle = p => poster(p).locator('[data-scene-motion-toggle]');
const menuToggle = p => p.locator('#trip-menu [data-scene-motion-toggle]');
const panelBody = p => p.locator('#text-panel-body');
const panelButton = (p, kind) => p.locator(`[data-text-panel=${kind}]`);
const motion = p => p.locator('html').getAttribute('data-scene-motion');

async function open(p) {
  await p.goto('/demo/#/trip');
  await expect(poster(p)).toBeVisible();
  await expect(p.locator('[data-poster-day]')).toHaveCount(3);
}
async function openMenu(p) {
  await p.getByRole('button', { name: '旅行選單', exact: true }).click();
  await expect(p.locator('#trip-menu')).toBeVisible();
}
// playState of every animation in the poster days that are inside the viewport (12.7, 13.4).
const visibleStates = p => poster(p).evaluate(el => [...el.querySelectorAll('[data-poster-day]:not([data-offscreen])')]
  .flatMap(day => day.getAnimations({ subtree: true })).map(a => a.playState));
const storageValue = p => p.evaluate(k => localStorage.getItem(k), STORAGE_KEY);

test('[TC-ITIN-010] copy text writes exactly Example_Text as text/plain and shows 已複製行程文字, collapsed or expanded, without changing the panel or storage @critical', async ({ page: p, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // Record what the page passes to writeText (the real write still happens), so the exact LF text is checked even
  // where the OS clipboard rewrites line endings on read (Windows returns CRLF).
  await p.addInitScript(() => {
    const clip = navigator.clipboard, write = clip.writeText.bind(clip);
    window.__written = [];
    clip.writeText = text => { window.__written.push(text); return write(text); };
  });
  const clipboardText = async () => (await p.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
  await open(p);
  const stored = await storageValue(p);
  await expect(panelButton(p, 'toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(panelBody(p)).toHaveCount(0);

  await panelButton(p, 'copy').click();
  await expect(p.locator('#toasts')).toHaveText('已複製行程文字');
  expect(await p.evaluate(() => window.__written)).toEqual([EXAMPLE_TEXT]);
  expect(await clipboardText()).toBe(EXAMPLE_TEXT);
  const types = await p.evaluate(async () => (await navigator.clipboard.read()).flatMap(item => item.types));
  expect(types).toEqual(['text/plain']);
  await expect(panelButton(p, 'toggle')).toHaveAttribute('aria-expanded', 'false'); // copying does not expand (15.2)

  await panelButton(p, 'toggle').click();
  await expect(panelButton(p, 'toggle')).toHaveAttribute('aria-expanded', 'true');
  await p.evaluate(() => { window.__written = []; return navigator.clipboard.writeText('placeholder'); });
  await p.evaluate(() => { window.__written = []; });
  await panelButton(p, 'copy').click();
  await expect.poll(() => p.evaluate(() => window.__written)).toEqual([EXAMPLE_TEXT]);
  expect(await clipboardText()).toBe(EXAMPLE_TEXT);
  await expect(panelButton(p, 'toggle')).toHaveAttribute('aria-expanded', 'true');
  expect(await storageValue(p)).toBe(stored); // 15.8: no write
});

test('[TC-ITIN-011] when the clipboard write fails the whole text is selected, the panel opens and 請手動複製已選取的文字 is shown @critical', async ({ page: p }) => {
  await p.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } });
  });
  await open(p);
  await expect(panelBody(p)).toHaveCount(0);
  await panelButton(p, 'copy').click();
  await expect(p.locator('#toasts')).toHaveText('請手動複製已選取的文字');
  await expect(p.locator('#toasts')).not.toContainText('已複製行程文字');
  await expect(panelButton(p, 'toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(panelBody(p)).toBeVisible();
  const selected = await p.evaluate(() => {
    const sel = getSelection(), body = document.querySelector('#text-panel-body');
    return { text: sel.toString(), inside: !!sel.anchorNode && body.contains(sel.anchorNode) && !!sel.focusNode && body.contains(sel.focusNode) };
  });
  expect(selected.inside).toBe(true);
  expect(selected.text).toBe(EXAMPLE_TEXT);
});

test('[TC-ITIN-012] reduced motion renders a static poster with no animations, hides Motion_Toggle and shows the note, live without reload @critical', async ({ page: p }) => {
  await p.emulateMedia({ reducedMotion: 'reduce' });
  await open(p);
  expect(await motion(p)).toBe('reduced');
  expect(await poster(p).evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
  await expect(posterToggle(p)).toBeHidden();
  await expect(poster(p).locator('[data-motion-reduced-note]')).toBeVisible();
  await expect(poster(p).locator('[data-motion-reduced-note]')).toHaveText('依系統減少動態設定，插畫保持靜態。');
  await openMenu(p);
  await expect(menuToggle(p)).toBeHidden();
  await expect(p.locator('#trip-menu [data-motion-reduced-note]')).toBeVisible();
  await p.locator('#trip-menu button[data-action=close-trip-menu]').click();
  await expect(p.locator('#trip-menu')).toHaveCount(0);

  // 13.3: the system setting changes while the page is open.
  await p.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => motion(p)).toBe('running');
  await expect(posterToggle(p)).toBeVisible();
  await expect(poster(p).locator('[data-motion-reduced-note]')).toBeHidden();
  await p.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => motion(p)).toBe('reduced');
  await expect(posterToggle(p)).toBeHidden();
});

test('[TC-ITIN-013] the poster Motion_Toggle switches running and paused, syncs its label and the animation playState, and the choice survives a reload', async ({ page: p }) => {
  await open(p);
  expect(await motion(p)).toBe('running');
  await expect(posterToggle(p)).toHaveAccessibleName('暫停動畫');
  await expect(posterToggle(p)).toBeVisible();
  await expect(p.locator('[data-poster-day]').first()).not.toHaveAttribute('data-offscreen', '');
  await expect.poll(async () => { const s = await visibleStates(p); return s.length > 0 && s.every(x => x === 'running'); }).toBe(true);

  await posterToggle(p).click();
  expect(await motion(p)).toBe('paused');
  await expect(posterToggle(p)).toHaveAccessibleName('播放動畫');
  await expect(posterToggle(p)).toBeFocused();
  await expect.poll(async () => { const s = await visibleStates(p); return s.length > 0 && s.every(x => x === 'paused'); }).toBe(true);
  expect(await p.evaluate(k => localStorage.getItem(k), MOTION_KEY)).toBe('paused');

  await p.reload();
  await expect(poster(p)).toBeVisible();
  expect(await motion(p)).toBe('paused');
  await expect(posterToggle(p)).toHaveAccessibleName('播放動畫');

  await posterToggle(p).click();
  expect(await motion(p)).toBe('running');
  await expect(posterToggle(p)).toHaveAccessibleName('暫停動畫');
  await expect.poll(async () => { const s = await visibleStates(p); return s.length > 0 && s.every(x => x === 'running'); }).toBe(true);
});

test('[TC-ITIN-014] switching from Trip_Menu changes the poster too, and both toggles share one label', async ({ page: p }) => {
  await open(p);
  await openMenu(p);
  await expect(menuToggle(p)).toHaveAccessibleName('暫停動畫');
  await menuToggle(p).click();
  expect(await motion(p)).toBe('paused');
  await expect(menuToggle(p)).toHaveAccessibleName('播放動畫');
  await expect(posterToggle(p)).toHaveAccessibleName('播放動畫');
  await expect(menuToggle(p)).toBeFocused();
  await expect.poll(async () => { const s = await visibleStates(p); return s.length > 0 && s.every(x => x === 'paused'); }).toBe(true);

  await menuToggle(p).click();
  expect(await motion(p)).toBe('running');
  await expect(menuToggle(p)).toHaveAccessibleName('暫停動畫');
  await expect(posterToggle(p)).toHaveAccessibleName('暫停動畫');
  await expect.poll(async () => { const s = await visibleStates(p); return s.length > 0 && s.every(x => x === 'running'); }).toBe(true);
});

async function expectPrintPoster(p) {
  await p.emulateMedia({ media: 'print' });
  await expect(poster(p)).toBeVisible();
  const cover = poster(p).locator('.poster-print-cover');
  await expect(cover).toBeVisible();
  const lines = cover.locator('p');
  await expect(lines).toHaveText(['夕淞度日', SUMMARY, '一起，把日子過慢一點。', '把喜歡的小地方，畫進我們的旅程。']);
  const firstDay = poster(p).locator('[data-poster-day]').first();
  const coverBox = await cover.boundingBox(), dayBox = await firstDay.boundingBox();
  expect(coverBox.y + coverBox.height).toBeLessThanOrEqual(dayBox.y + 1);
  for (const hidden of ['.itinerary-editor', '.plan-view-switch', '[data-scene-motion-toggle]', '.itinerary-text-panel', '.poster-summary']) {
    await expect(p.locator(hidden).first(), hidden).toBeHidden();
  }
  expect(await poster(p).evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
  const breaks = await poster(p).locator('[data-poster-day]').evaluateAll(days => days.map(d => getComputedStyle(d).breakInside));
  expect(breaks).toEqual(['avoid', 'avoid', 'avoid']);
}

test('[TC-ITIN-015] printing the poster view shows the print cover first, hides the controls and Text_Panel, has no animation and keeps each day together', async ({ page: p }) => {
  await open(p);
  await panelButton(p, 'toggle').click(); // an open Text_Panel is still not printed (15.9)
  await expect(panelBody(p)).toBeVisible();
  await expectPrintPoster(p);
  await expect(panelBody(p)).toBeHidden();
});

test('[TC-ITIN-016] printing from the planner view prints the same poster from the stored state and hides the editor', async ({ page: p }) => {
  await open(p);
  await p.locator('[data-plan-nav=view][data-view=editor]').click();
  await expect(p.locator('.itinerary-editor')).toBeVisible();
  await expectPrintPoster(p);
  await p.emulateMedia({ media: 'screen' });
  await expect(p.locator('.itinerary-editor')).toBeVisible(); // printing does not change the view (13.6)
});

test('[TC-ITIN-017] the Text_Panel starts collapsed after every load, keeps the last choice across tab switches and writes nothing when toggled', async ({ page: p }) => {
  await open(p);
  const stored = await storageValue(p);
  await expect(panelButton(p, 'toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(panelButton(p, 'copy')).toBeVisible();
  await panelButton(p, 'toggle').click();
  await expect(panelButton(p, 'toggle')).toHaveAttribute('aria-expanded', 'true');
  await p.locator('[data-tab=meals]').first().click();
  await p.locator('[data-tab=schedule]').first().click();
  await expect(panelButton(p, 'toggle')).toHaveAttribute('aria-expanded', 'true');
  await panelButton(p, 'toggle').click();
  await expect(panelButton(p, 'toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(panelBody(p)).toHaveCount(0);
  await panelButton(p, 'toggle').click();
  expect(await storageValue(p)).toBe(stored);
  await p.reload();
  await expect(poster(p)).toBeVisible();
  await expect(panelButton(p, 'toggle')).toHaveAttribute('aria-expanded', 'false');
});

test('[TC-ITIN-018] the expanded Text_Panel shows Example_Text verbatim, read-only, wrapped without horizontal scroll, and is the last block before the closing note', async ({ page: p }) => {
  await p.setViewportSize({ width: 320, height: 900 });
  await open(p);
  await panelButton(p, 'toggle').click();
  await expect(panelBody(p)).toBeVisible();
  expect(await panelBody(p).evaluate(el => el.textContent)).toBe(EXAMPLE_TEXT);
  const fits = await panelBody(p).evaluate(el => el.scrollWidth <= el.clientWidth + 1);
  expect(fits).toBe(true);
  expect(await panelBody(p).evaluate(el => el.isContentEditable || el.tagName === 'TEXTAREA')).toBe(false);
  const order = await p.evaluate(() => {
    const panel = document.querySelector('.itinerary-text-panel'), end = document.querySelector('.endnote'), poster = document.querySelector('.itinerary-poster');
    return { panelAfterPoster: !!(poster.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_CONTAINED_BY), endAfterPanel: !!(panel.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING) };
  });
  expect(order).toEqual({ panelAfterPoster: true, endAfterPanel: true });
  await expect(p.locator('.endnote')).toContainText('好日子，不用急。');
});

test('[TC-ITIN-019] Motion_Toggle and the reduced-motion note are never both visible, and the toggle name always matches the state', async ({ page: p }) => {
  await open(p);
  for (const reduced of [false, true, false]) {
    await p.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await expect.poll(() => motion(p)).toBe(reduced ? 'reduced' : 'running');
    if (reduced) {
      await expect(posterToggle(p)).toBeHidden();
      await expect(poster(p).locator('[data-motion-reduced-note]')).toBeVisible();
    } else {
      await expect(posterToggle(p)).toBeVisible();
      await expect(posterToggle(p)).toHaveAccessibleName('暫停動畫');
      await expect(poster(p).locator('[data-motion-reduced-note]')).toBeHidden();
    }
  }
});
