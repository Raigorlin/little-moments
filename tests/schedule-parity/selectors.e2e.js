// Selector check of the schedule-tab-css-parity spec (design section 6.4 and the Selector_Map).
//
// For each state in STATES, a freshly loaded LM_Web Trip_Page (Comparison_Fixture, ?tab=schedule) is
// driven into the state, and every Selector_Map entry assigned to that state is evaluated inside
// `.workspace` with user-action pseudo-classes and pseudo-elements stripped (evaluatedSelector).
// A Match entry needs at least one element, all inside its role's target set; an Unreachable entry
// needs none. Each failure is reported as {state, selector, matched, outside}.
//
// Feature: schedule-tab-css-parity, Property 5: Selector_Map conformance
// **Validates: Requirements 3.2, 3.3, 3.4, 4.1**
import { test, expect } from '@playwright/test';
import {
  ENTRIES, STATES, ALL_STATES, MOBILE_STATES, evaluatedSelector, rolesScript, queryWithin,
} from './support/selector-map.js';
import {
  comparisonFixture, loadLmTrip, beforeAllServersReachable, LM_BASE_URL, LM_SESSION_KEY,
} from './support/fixture.js';
import { prepareCapture, waitForCapture } from './support/capture.js';

/** Roles whose every element is a Schedule_Row and must carry `data-swipe-row` (Requirement 4.1). */
const SWIPE_ROW_ROLES = ['activity-card', 'route-card', 'place-row', 'schedule-vehicle-card'];

beforeAllServersReachable(test, [LM_BASE_URL]);

/** One Comparison_Fixture trip per worker; the states only read it (S2's rename is rejected). */
let lmTrip;
test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext();
  try {
    lmTrip = await loadLmTrip(request, comparisonFixture());
  } finally {
    await request.dispose();
  }
});

/**
 * Opens the fixture's schedule tab on a fresh page. S7 installs the page clock itself, so it gets
 * no capture state (whose fixed time would install the clock first); it only waits for fonts.
 */
async function openSchedule(page, state) {
  await page.addInitScript(([key, session]) => {
    localStorage.setItem(key, session);
  }, [LM_SESSION_KEY, JSON.stringify(lmTrip.session)]);
  const url = `${LM_BASE_URL}${lmTrip.schedulePath}`;
  if (state === 'S7') {
    await page.goto(url);
    await waitForCapture(page, { app: 'lm' });
  } else {
    await prepareCapture(page, { app: 'lm', theme: 'light', url });
  }
}

/** In-page library: queryWithin and the ROLES of the Selector_Map. */
function libraryScript() {
  return `(() => { const queryWithin = ${queryWithin.toString()}; const ROLES = ${rolesScript()}; `
    + 'return { queryWithin, ROLES }; })()';
}

/**
 * Evaluates `entries` in the current page state and returns the failures as
 * `{state, id, selector, matched, outside}` (`outside` holds element paths).
 */
async function evaluateEntries(page, state, entries) {
  const lib = await page.evaluateHandle(libraryScript());
  const specs = entries.map((entry) => ({
    id: entry.id, selector: entry.selector, evaluated: evaluatedSelector(entry.selector),
    role: entry.role ?? null, status: entry.status,
  }));
  try {
    return await page.evaluate(([{ queryWithin, ROLES }, specs, state]) => {
      const root = document.querySelector('.workspace');
      const path = (element) => {
        const parts = [];
        for (let el = element; el && el.localName !== 'main'; el = el.parentElement) {
          const index = el.parentElement ? [...el.parentElement.children].indexOf(el) + 1 : 1;
          parts.unshift(`${el.localName}${[...el.classList].map((c) => `.${c}`).join('')}:nth-child(${index})`);
        }
        return parts.join(' > ');
      };
      if (!root) return specs.map((spec) => ({ state, id: spec.id, selector: spec.selector, matched: 0, outside: ['<no .workspace>'] }));
      const failures = [];
      for (const spec of specs) {
        let matched;
        try {
          matched = queryWithin(root, spec.evaluated);
        } catch (error) {
          failures.push({ state, id: spec.id, selector: spec.selector, matched: 0, outside: [`<invalid selector: ${error.message}>`] });
          continue;
        }
        let outside;
        if (spec.status === 'match') {
          const role = ROLES[spec.role];
          if (!role) {
            failures.push({ state, id: spec.id, selector: spec.selector, matched: matched.length, outside: [`<unknown role ${spec.role}>`] });
            continue;
          }
          const targets = new Set(role(root));
          outside = matched.filter((el) => !targets.has(el));
          if (matched.length > 0 && outside.length === 0) continue;
        } else {
          outside = matched;
          if (matched.length === 0) continue;
        }
        failures.push({ state, id: spec.id, selector: spec.selector, matched: matched.length, outside: outside.map(path) });
      }
      return failures;
    }, [lib, specs, state]);
  } finally {
    await lib.dispose();
  }
}

const entriesFor = (state) => ENTRIES.filter((entry) => entry.states.includes(state));
const isMobile = (page) => (page.viewportSize()?.width ?? Infinity) <= 760;

for (const state of ALL_STATES) {
  test(`Selector_Map conformance in ${state}`, async ({ page }) => {
    test.skip(MOBILE_STATES.includes(state) && !isMobile(page), `${state} needs Touch_Layout (parity-mobile)`);
    await openSchedule(page, state);
    await STATES[state](page);
    const entries = entriesFor(state);
    expect(entries.length, `entries assigned to ${state}`).toBeGreaterThan(0);
    const failures = await evaluateEntries(page, state, entries);
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
  });
}

test('the selector check rejects an entry whose role does not own the matched elements', async ({ page }) => {
  await openSchedule(page, 'S0');
  await STATES.S0(page);
  // `.activity-card` matches activity articles; the route-card role owns none of them.
  const wrong = { id: 'self-test', selector: '.activity-card', lines: '9', role: 'route-card', states: ['S0'], status: 'match' };
  const failures = await evaluateEntries(page, 'S0', [wrong]);
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ state: 'S0', selector: '.activity-card' });
  expect(failures[0].matched).toBeGreaterThan(0);
  expect(failures[0].outside).toHaveLength(failures[0].matched);
});

test('every activity card, route card, place row and schedule vehicle card has data-swipe-row (Requirement 4.1)', async ({ page }) => {
  await openSchedule(page, 'S0');
  await STATES.S0(page);
  const lib = await page.evaluateHandle(libraryScript());
  const report = await page.evaluate(([{ ROLES }, roles]) => {
    const root = document.querySelector('.workspace');
    if (!root) return { error: 'no .workspace' };
    return Object.fromEntries(roles.map((role) => {
      const elements = ROLES[role](root);
      return [role, { count: elements.length, missing: elements.filter((el) => !el.hasAttribute('data-swipe-row')).length }];
    }));
  }, [lib, SWIPE_ROW_ROLES]);
  await lib.dispose();
  const expected = Object.fromEntries(SWIPE_ROW_ROLES.map((role) => [role, { missing: 0 }]));
  expect(report, JSON.stringify(report)).toMatchObject(expected);
  for (const role of SWIPE_ROW_ROLES) expect(report[role].count, `${role} elements`).toBeGreaterThan(0);
});
