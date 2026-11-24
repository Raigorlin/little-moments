// Capture helpers for the schedule-tab-css-parity Playwright checks (design sections 6.2 and 6.3).
// prepareCapture puts a Bun_App or LM_Web page into the capture state (Requirements 7.3–7.5).
// chromeTree and chromeClip feed the Chrome_Comparison_Test; studio.e2e.js uses prepareCapture and waitForCapture.

const THEMES = ['light', 'dark'];
const APPS = ['bun', 'lm'];

// Bun_App keys: src/model.js THEMES_KEY (read by src/app.js line 116) and src/storybook/app.js HIDDEN_KEY.
export const BUN_THEME_KEY = 'ggc-local-theme';
export const BUN_EDITOR_HIDDEN_KEY = 'storybook-editor-hidden-v2';
export const FIXED_TIME = '2026-10-01T09:00:00+08:00';

// Bun states that must hold before a capture (Requirement 7.5, design 6.2 step 2).
export const BUN_CAPTURE_STATES = [
  { selector: '.story-studio-host[data-editor-hidden]:not([data-loading])', name: 'Story_Studio editor collapsed' },
  { selector: '.sync-status[hidden]', name: 'sync status hidden' },
];

// Page_Chrome regions serialized by chromeTree (design 6.2 step 3).
export const CHROME_REGIONS = ['header', '.breadcrumb', '.hero', '.trip-toolbar', '.section-tabs'];
// Masked_Areas of the Chrome_Region capture (design 6.2 step 4).
export const CHROME_MASK_SELECTORS = ['.countdown strong', '.sync-status', '.editor-stack'];
export const MASK_COLOR = '#ff00ff';

function checkTheme(theme) {
  if (!THEMES.includes(theme)) throw new Error(`unknown theme: ${theme}`);
}

async function waitForFonts(page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForFunction(() => document.fonts.status === 'loaded');
}

/**
 * Installs the capture state on a page and, when `url` is given, navigates and waits for it.
 * Call before navigation. Theme init script, Reduced_Motion and the fixed clock apply to both apps;
 * Bun also gets its theme key in storage and the editor-hidden key removed, so the editor starts collapsed.
 * @param {import('@playwright/test').Page} page
 * @param {{ app: 'bun'|'lm', theme: 'light'|'dark', url?: string, timeout?: number }} options
 */
export async function prepareCapture(page, { app, theme, url, timeout = 15000 }) {
  if (!APPS.includes(app)) throw new Error(`unknown app: ${app}`);
  checkTheme(theme);
  await page.addInitScript(
    ({ theme, bun, themeKey, hiddenKey }) => {
      if (bun) {
        try {
          localStorage.setItem(themeKey, theme);
          localStorage.removeItem(hiddenKey);
        } catch { /* storage unavailable: the attribute below still applies */ }
      }
      const apply = () => { document.documentElement.dataset.theme = theme; };
      if (document.documentElement) apply();
      else document.addEventListener('readystatechange', apply, { once: true });
    },
    { theme, bun: app === 'bun', themeKey: BUN_THEME_KEY, hiddenKey: BUN_EDITOR_HIDDEN_KEY },
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.setFixedTime(FIXED_TIME);
  if (url === undefined) return;
  await page.goto(url);
  await waitForCapture(page, { app, timeout });
}

/**
 * Waits for fonts and, for Bun_App, for the collapsed editor and the hidden sync status.
 * A missing Bun state fails with an error that names it.
 */
export async function waitForCapture(page, { app, timeout = 15000 }) {
  await waitForFonts(page);
  if (app !== 'bun') return;
  for (const { selector, name } of BUN_CAPTURE_STATES) {
    try {
      await page.waitForSelector(selector, { state: 'attached', timeout });
    } catch (error) {
      throw new Error(`Bun_App capture state missing: ${name} (${selector}) after ${timeout} ms`, { cause: error });
    }
  }
}

/**
 * Serializes the Page_Chrome regions as {tag, classes, children} trees. Skips [hidden] elements,
 * .editor-stack and text; an svg keeps only its own class list.
 * @returns {Promise<Record<string, {tag: string, classes: string[], children: object[]} | null>>}
 */
export function chromeTree(page) {
  return page.evaluate((regions) => {
    const node = (el) => {
      const tag = el.tagName.toLowerCase();
      const classes = [...el.classList].sort();
      if (tag === 'svg') return { tag, classes, children: [] };
      const children = [];
      for (const child of el.children) {
        if (child.hasAttribute('hidden') || child.classList.contains('editor-stack')) continue;
        children.push(node(child));
      }
      return { tag, classes, children };
    };
    const out = {};
    for (const selector of regions) {
      const el = document.querySelector(selector);
      out[selector] = el && !el.hasAttribute('hidden') ? node(el) : null;
    }
    return out;
  }, CHROME_REGIONS);
}

/**
 * Scrolls to the top and returns the Chrome_Region clip: full viewport width, down to the
 * rounded-up bottom of .section-tabs.
 * @returns {Promise<{x: number, y: number, width: number, height: number}>}
 */
export async function chromeClip(page) {
  const height = await page.evaluate(() => {
    window.scrollTo(0, 0);
    const tabs = document.querySelector('.section-tabs');
    if (!tabs) return null;
    return Math.ceil(tabs.getBoundingClientRect().bottom + window.scrollY);
  });
  if (height === null) throw new Error('chromeClip: .section-tabs not found');
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('chromeClip: page has no fixed viewport');
  return { x: 0, y: 0, width: viewport.width, height };
}

/** Screenshot options for the Chrome_Region capture (design 6.2 step 4). */
export async function chromeScreenshotOptions(page) {
  return {
    fullPage: true,
    clip: await chromeClip(page),
    mask: CHROME_MASK_SELECTORS.map((selector) => page.locator(selector)),
    maskColor: MASK_COLOR,
    animations: 'disabled',
  };
}
