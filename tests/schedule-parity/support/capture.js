// Capture helpers for the schedule-tab-css-parity Playwright checks (design sections 6.2 and 6.3).
// prepareCapture puts a Bun_App or LM_Web page into the capture state (Requirements 7.3–7.5).
// chromeTree and chromeClip feed the Chrome_Comparison_Test; plannerSnapshot and styleHarness
// feed the Style_Comparison_Check (Requirement 7.8).
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
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

/**
 * Assigns data-parity-id to .workspace and every element inside it, then returns
 * .workspace.outerHTML without <script> elements. The live markup keeps the ids.
 */
export async function plannerSnapshot(page) {
  const html = await page.evaluate(() => {
    const workspace = document.querySelector('.workspace');
    if (!workspace) return null;
    [workspace, ...workspace.querySelectorAll('*')].forEach((el, i) => el.setAttribute('data-parity-id', `p${i}`));
    const copy = workspace.cloneNode(true);
    copy.querySelectorAll('script').forEach((script) => script.remove());
    return copy.outerHTML;
  });
  if (html === null) throw new Error('plannerSnapshot: .workspace not found');
  return html;
}

// Rust_Stylesheets in crates/web/index.html link order (data-trunk rel="css" tags).
export async function rustStylesheets() {
  const index = (await readFile(join(ROOT, 'crates/web/index.html'), 'utf8')).replace(/<!--[\s\S]*?-->/g, '');
  const files = [];
  for (const [tag] of index.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\sdata-trunk\b/i.test(tag) || !/\srel\s*=\s*["']css["']/i.test(tag)) continue;
    const href = tag.match(/\shref\s*=\s*["']([^"']+)["']/i);
    if (href) files.push(join(ROOT, 'crates/web', href[1]));
  }
  if (files.length === 0) throw new Error('crates/web/index.html links no data-trunk css files');
  return files;
}

async function harnessFiles() {
  const read = (path) => readFile(path, 'utf8');
  const bunCss = (await Promise.all(['styles.css', 'accounts.css', 'scene-motion.css']
    .map((name) => read(join(ROOT, 'src', name))))).join('\n');
  const rust = new Map();
  for (const path of await rustStylesheets()) rust.set(basename(path), await read(path));
  return {
    css: new Map([
      ['/bun/bun.css', bunCss],
      ['/bun/expenses.css', await read(join(ROOT, 'src/expenses.css'))],
      ...[...rust].map(([name, text]) => [`/rust/${name}`, text]),
    ]),
    links: {
      bun: ['/bun/bun.css', '/bun/expenses.css'],
      rust: [...rust.keys()].map((name) => `/rust/${name}`),
    },
  };
}

export const HARNESS_ORIGIN = 'http://parity.test';

/**
 * Serves the Planner_Snapshot at http://parity.test/ inside `main#main.page`, linking either the
 * Bun_Stylesheets or the Rust_Stylesheets, then navigates there and waits for fonts.
 * @param {import('@playwright/test').Page} page
 * @param {'bun'|'rust'} sheets
 * @param {string} html Planner_Snapshot from plannerSnapshot
 * @param {'light'|'dark'} [theme] data-theme on the root; omitted when not given
 */
export async function styleHarness(page, sheets, html, theme) {
  if (sheets !== 'bun' && sheets !== 'rust') throw new Error(`unknown sheets: ${sheets}`);
  if (theme !== undefined) checkTheme(theme);
  const { css, links } = await harnessFiles();
  const themeAttr = theme ? ` data-theme="${theme}"` : '';
  const head = links[sheets].map((href) => `<link rel="stylesheet" href="${href}">`).join('');
  const pageHtml = '<!doctype html>'
    + `<html lang="zh-Hant"${themeAttr}><head><meta charset="UTF-8">`
    + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
    + `${head}</head><body><div id="app"><main id="main" class="page">${html}</main></div></body></html>`;
  const fontDir = join(ROOT, 'assets/fonts');
  await page.unroute(`${HARNESS_ORIGIN}/**`);
  await page.route(`${HARNESS_ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/') {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: pageHtml });
    }
    if (css.has(pathname)) {
      return route.fulfill({ status: 200, contentType: 'text/css; charset=utf-8', body: css.get(pathname) });
    }
    const font = pathname.match(/^\/(?:bun|rust)\/assets\/fonts\/([^/]+\.woff2)$/);
    if (font) {
      try {
        const body = await readFile(join(fontDir, basename(decodeURIComponent(font[1]))));
        return route.fulfill({ status: 200, contentType: 'font/woff2', body });
      } catch { /* fall through to 404 */ }
    }
    return route.fulfill({ status: 404, contentType: 'text/plain', body: `not served: ${pathname}` });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${HARNESS_ORIGIN}/`);
  await waitForFonts(page);
  return page;
}
