// Style_Comparison_Check of the schedule-tab-css-parity spec (design section 6.3).
// Feature: schedule-tab-css-parity, Property 13: Planner computed-style parity
// **Validates: Requirements 6.1, 6.2, 6.3, 7.8, 7.9, 7.10**
//
// The Planner_Snapshot of LM_Web (state S0 of the Comparison_Fixture) is loaded into one static page that
// links Bun_Stylesheets and one that links Rust_Stylesheets, both inside the same `main#main.page`. For each
// Theme, the Compared_Properties of every Key_Element must be equal in both pages. The Viewport_Profile comes
// from the Playwright project (parity-desktop, parity-mobile).
import { test, expect } from '@playwright/test';
import { beforeAllServersReachable, comparisonFixture, loadLmTrip, LM_BASE_URL, LM_SESSION_KEY } from './support/fixture.js';
import { plannerSnapshot, styleHarness } from './support/capture.js';
import { ENTRIES, STATES, evaluatedSelector } from './support/selector-map.js';

const THEMES = ['light', 'dark'];

/** Compared_Properties (Requirements glossary) with the shorthands expanded to longhands (design 6.3 step 4). */
const SIDES = ['top', 'right', 'bottom', 'left'];
const COMPARED_PROPERTIES = [
  'display', 'position', 'width', 'height', 'grid-template-columns', 'flex-direction', 'flex-wrap', 'align-items',
  'justify-content', 'row-gap', 'column-gap',
  ...SIDES.map((side) => `margin-${side}`),
  ...SIDES.map((side) => `padding-${side}`),
  'font-family', 'font-size', 'font-weight', 'line-height', 'color', 'background-color',
  ...SIDES.flatMap((side) => ['width', 'style', 'color'].map((part) => `border-${side}-${part}`)),
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'box-shadow', 'overflow-x', 'overflow-y', 'visibility',
];

/** Key_Element selectors: Match entries of states S0 and S0d (evaluated), plus the swipe markup (design 6.3 step 3). */
const KEY_SELECTORS = [...new Set([
  ...ENTRIES.filter((entry) => entry.status === 'match' && entry.states.some((state) => state === 'S0' || state === 'S0d'))
    .map((entry) => evaluatedSelector(entry.selector)),
  '[data-swipe-row]', '.swipe-actions', '.swipe-toggle',
])];

const MISSING = '<missing>';

/**
 * In the Bun harness page: the data-parity-id of every Key_Element, excluding the .editor-stack subtree.
 * A selector that the browser rejects throws with the selector in the message.
 */
function keyElementIds(page) {
  return page.evaluate((selectors) => {
    const main = document.querySelector('main#main');
    const ids = new Set();
    for (const selector of selectors) {
      let found;
      try {
        found = [...(main.matches(selector) ? [main] : []), ...main.querySelectorAll(selector)];
      } catch (error) {
        throw new Error(`invalid Key_Element selector ${selector}: ${error.message}`);
      }
      for (const el of found) {
        if (el.closest('.editor-stack')) continue;
        const id = el.getAttribute('data-parity-id');
        if (id) ids.add(id);
      }
    }
    return [...ids];
  }, KEY_SELECTORS);
}

/** Reads the Compared_Properties and the `tag.class` path from `main` of each id; absent ids map to null. */
function readStyles(page, ids) {
  return page.evaluate(({ ids, properties }) => {
    const main = document.querySelector('main#main');
    const pathOf = (el) => {
      const parts = [];
      for (let node = el; node && node !== main; node = node.parentElement) {
        parts.unshift(node.localName + [...node.classList].map((name) => `.${name}`).join(''));
      }
      return `main > ${parts.join(' > ')} [${el.getAttribute('data-parity-id')}]`;
    };
    const out = {};
    for (const id of ids) {
      const el = main.querySelector(`[data-parity-id="${id}"]`);
      if (!el) { out[id] = null; continue; }
      const style = getComputedStyle(el);
      out[id] = { path: pathOf(el), values: Object.fromEntries(properties.map((p) => [p, style.getPropertyValue(p)])) };
    }
    return out;
  }, { ids, properties: COMPARED_PROPERTIES });
}

/** Differences `{combination, path, property, bun, rust}` between two readStyles results. */
function compareStyles(combination, ids, bun, rust) {
  const differences = [];
  for (const id of ids) {
    const b = bun[id];
    const r = rust[id];
    if (!b) continue;
    if (!r) {
      differences.push({ combination, path: b.path, property: '(element)', bun: 'present', rust: MISSING });
      continue;
    }
    for (const property of COMPARED_PROPERTIES) {
      if (b.values[property] !== r.values[property]) {
        differences.push({ combination, path: b.path, property, bun: b.values[property], rust: r.values[property] });
      }
    }
  }
  return differences;
}

const report = (differences) => differences
  .map((d) => `${d.combination} ${d.path} ${d.property}: bun=${JSON.stringify(d.bun)} rust=${JSON.stringify(d.rust)}`)
  .join('\n');

/** Opens the LM schedule tab of `trip` with the session and no theme init script. */
async function openLm(browser, trip) {
  const context = await browser.newContext({ baseURL: LM_BASE_URL });
  await context.addInitScript(({ key, session }) => {
    localStorage.setItem(key, JSON.stringify(session));
  }, { key: LM_SESSION_KEY, session: trip.session });
  const page = await context.newPage();
  await page.goto(trip.schedulePath);
  return { context, page };
}

beforeAllServersReachable(test, [LM_BASE_URL]);

test.describe('Style_Comparison_Check', () => {
  test.describe.configure({ mode: 'serial' });

  /** @type {Awaited<ReturnType<typeof loadLmTrip>>} */
  let trip;
  /** @type {string} */
  let snapshot;

  test.beforeAll(async ({ browser, playwright }) => {
    const request = await playwright.request.newContext();
    try {
      trip = await loadLmTrip(request, comparisonFixture());
    } finally {
      await request.dispose();
    }
    const { context, page } = await openLm(browser, trip);
    try {
      await STATES.S0(page);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      snapshot = await plannerSnapshot(page);
    } finally {
      await context.close();
    }
  });

  for (const theme of THEMES) {
    test(`Property 13: Planner computed-style parity (${theme})`, async ({ browser }, testInfo) => {
      const combination = `${testInfo.project.name}-${theme}`;
      const context = await browser.newContext();
      try {
        const bunPage = await styleHarness(await context.newPage(), 'bun', snapshot, theme);
        const rustPage = await styleHarness(await context.newPage(), 'rust', snapshot, theme);
        const ids = await keyElementIds(bunPage);
        expect(ids.length, 'Key_Elements found in the Planner_Snapshot').toBeGreaterThan(100);
        const differences = compareStyles(combination, ids, await readStyles(bunPage, ids), await readStyles(rustPage, ids));
        if (differences.length) {
          await testInfo.attach(`style-differences-${combination}.json`, {
            body: JSON.stringify(differences, null, 2), contentType: 'application/json',
          });
        }
        expect(differences, report(differences)).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  test('dark .swipe-action-danger copies compute #9d3e32 on #fff (Requirement 6.2)', async ({ browser }) => {
    const context = await browser.newContext();
    try {
      for (const sheets of ['bun', 'rust']) {
        const page = await styleHarness(await context.newPage(), sheets, snapshot, 'dark');
        const colors = await page.evaluate(() => [...document.querySelectorAll('.swipe-actions>.swipe-action-danger')]
          .map((el) => { const s = getComputedStyle(el); return [s.backgroundColor, s.color]; }));
        expect(colors.length, `${sheets}: .swipe-action-danger copies in the snapshot`).toBeGreaterThan(0);
        for (const pair of colors) expect(pair, sheets).toEqual(['rgb(157, 62, 50)', 'rgb(255, 255, 255)']);
      }
    } finally {
      await context.close();
    }
  });

  test('the live LM page without an init script renders the light theme (Requirement 6.3)', async ({ browser }) => {
    const { context, page } = await openLm(browser, trip);
    try {
      await STATES.S0(page);
      const root = await page.evaluate(() => ({
        hasTheme: document.documentElement.hasAttribute('data-theme'),
        background: getComputedStyle(document.documentElement).backgroundColor,
      }));
      expect(root).toEqual({ hasTheme: false, background: 'rgb(255, 252, 246)' });
    } finally {
      await context.close();
    }
  });
});
