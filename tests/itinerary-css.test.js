// Static checks of src/itinerary.css (trip-planning-workflow-enhance, task 15.2).
// **Validates: Requirements 12.9, 13.1, 13.8, 16.10, 17.5, 17.7**
//
// No browser: the stylesheets are parsed as text. Motion only under no-preference + a Scene_Motion_State, print rules,
// the no-subgrid fallback, WCAG contrast of the poster palette (design 「插圖與顏色」), car-0..car-7 = CAR_PALETTE,
// the build concatenation list and the icon names used by the editor and the poster.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CAR_PALETTE } from '../src/itinerary-model.js';

const root = resolve(import.meta.dir, '..');
const read = file => readFileSync(resolve(root, file), 'utf8');
const itineraryCss = read('src/itinerary.css');
const squash = text => text.replace(/\s+/g, '');

// ---- minimal CSS reader: flat list of { at: [media/supports heads], selector, body } -------------------------------
function parse(source, at = []) {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    const head = src.slice(i, open).split(';').pop().trim();
    let depth = 1, j = open + 1;
    while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
    const body = src.slice(open + 1, j - 1);
    if (/^@(media|supports)/.test(head)) out.push(...parse(body, [...at, squash(head)]));
    else out.push({ at, selector: head, body, keyframes: head.startsWith('@') });
    i = j;
  }
  return out;
}
function decls(body) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (ch === ';' && !depth) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map(text => {
    const k = text.indexOf(':');
    return k < 0 ? null : { prop: text.slice(0, k).trim(), value: text.slice(k + 1).trim() };
  }).filter(Boolean);
}
const selectors = selector => {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of selector) {
    if (ch === '(' || ch === '[') depth++; else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && !depth) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
};
const rules = parse(itineraryCss);
const NO_PREF = '@media(prefers-reduced-motion:no-preference)';
const PRINT = '@mediaprint';

// Custom properties of `selector` (exact), later declarations win, across the given stylesheets in build order.
function themeVars(files, selector) {
  const vars = {};
  for (const file of files) {
    for (const rule of parse(read(file))) {
      if (rule.keyframes || rule.at.length || !selectors(rule.selector).includes(selector)) continue;
      for (const d of decls(rule.body)) if (d.prop.startsWith('--')) vars[d.prop] = d.value;
    }
  }
  return vars;
}

// ---- WCAG 2.x contrast ---------------------------------------------------------------------------------------------
const rgb = hex => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map(k => parseInt(h.slice(k, k + 2), 16) / 255);
};
const luminance = hex => {
  const [r, g, b] = rgb(hex).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('motion (12.9, 13.1)', () => {
  test('every animation is declared under no-preference and a running or paused Scene_Motion_State', () => {
    const animated = [];
    for (const rule of rules) {
      if (rule.keyframes) continue;
      for (const d of decls(rule.body)) {
        if (!/^animation(-name)?$/.test(d.prop) || /^none\b/.test(d.value)) continue;
        animated.push(rule);
        expect(rule.at).toContain(NO_PREF);
        for (const part of selectors(rule.selector)) expect(part).toMatch(/:root\[data-scene-motion=(running|paused)\]/);
      }
    }
    expect(animated.length).toBeGreaterThan(0);
    // both states are covered for each animated element
    const text = animated.map(rule => rule.selector).join('\n');
    expect(text).toContain('data-scene-motion=running');
    expect(text).toContain('data-scene-motion=paused');
  });

  test('no transition or animation-name leaks into poster rules outside that media query', () => {
    for (const rule of rules) {
      if (rule.keyframes || !/\.(itinerary-poster|poster-|moment-|rm-|ip-)/.test(rule.selector)) continue;
      for (const d of decls(rule.body)) {
        if (d.prop === 'animation-play-state') continue;
        if (/^animation/.test(d.prop) && !/^none\b/.test(d.value)) expect(rule.at).toContain(NO_PREF);
        expect(d.prop).not.toBe('transition');
      }
    }
  });

  test('paused and off-screen days stop the animation in place', () => {
    const paused = rules.filter(rule => decls(rule.body).some(d => d.prop === 'animation-play-state' && d.value === 'paused'));
    expect(paused.some(rule => rule.selector.includes('data-scene-motion=paused'))).toBe(true);
    expect(paused.some(rule => rule.selector.includes('[data-offscreen]'))).toBe(true);
  });

  test('keyframes stay small and slow (cycles of at least 2.4s)', () => {
    for (const rule of rules.filter(r => !r.keyframes)) {
      for (const d of decls(rule.body).filter(x => x.prop === 'animation' && !/^none\b/.test(x.value))) {
        const seconds = Number(/(\d+(?:\.\d+)?)s/.exec(d.value)?.[1]);
        expect(seconds).toBeGreaterThanOrEqual(2.4);
      }
    }
  });
});

describe('print (13.8, 17.5)', () => {
  const printRules = rules.filter(rule => rule.at.includes(PRINT) && !rule.keyframes);
  const scoped = printRules.filter(rule => rule.selector.includes('body[data-print-scope="itinerary"]'));

  test('the print rules are scoped to the itinerary print scope and hide the chrome', () => {
    const hide = scoped.find(rule => rule.selector.includes(':is(.topbar'));
    expect(hide).toBeTruthy();
    for (const name of ['.itinerary-editor', '.itinerary-text-panel', '[data-scene-motion-toggle]', '.plan-view-switch', '#toasts', 'button']) {
      expect(hide.selector).toContain(name);
    }
    expect(squash(hide.body)).toContain('display:none!important');
  });

  test('the print copy is hidden on screen and shown in print', () => {
    const screen = rules.find(rule => !rule.at.length && rule.selector === '.itinerary-print-copy');
    expect(decls(screen.body).find(d => d.prop === 'display').value).toBe('none');
    const print = scoped.find(rule => rule.selector.endsWith('.itinerary-print-copy'));
    expect(decls(print.body).find(d => d.prop === 'display').value).toBe('block');
  });

  test('the poster prints in the light palette on white, in either theme', () => {
    const light = themeVars(['src/itinerary.css'], ':root');
    const poster = scoped.find(rule => rule.selector.endsWith('.itinerary-poster') && rule.body.includes('--ip-paper'));
    expect(poster).toBeTruthy();
    const printed = Object.fromEntries(decls(poster.body).map(d => [d.prop, d.value]));
    for (const name of ['--ip-paper', '--ip-card', '--ip-ink', '--ip-muted', '--ip-road', '--ip-badge-ink', '--ip-tone-0', '--ip-tone-1', '--ip-tone-2']) {
      expect(printed[name]).toBe(light[name]);
    }
    expect(printed.background).toBe('#fff');
    expect(printed.color).toBe(light['--ip-ink']);
    const bodyRule = scoped.find(rule => rule.selector === 'body[data-print-scope="itinerary"]');
    expect(squash(bodyRule.body)).toContain('background:#fff');
  });

  test('animations are off in print', () => {
    expect(printRules.some(rule => rule.selector.includes('.ip-anim') && /animation:none!important/.test(squash(rule.body)))).toBe(true);
    expect(scoped.some(rule => rule.selector.includes('.itinerary-poster *') && /animation:none!important/.test(squash(rule.body)))).toBe(true);
  });

  test('the cover is printed and the text panel and summary are not', () => {
    expect(scoped.some(rule => rule.selector.endsWith('.poster-print-cover') && /display:block/.test(squash(rule.body)))).toBe(true);
    expect(scoped.some(rule => rule.selector.endsWith('.poster-summary') && /display:none/.test(squash(rule.body)))).toBe(true);
  });
});

describe('subgrid fallback (11.x layout, design: 擴充點)', () => {
  const fallback = rules.filter(rule => rule.at.includes('@supportsnot(grid-template-rows:subgrid)'));

  test('a @supports not (subgrid) block stacks the route map and hides lines, roads and cars', () => {
    expect(fallback.length).toBeGreaterThan(0);
    const stack = fallback.find(rule => /display:block/.test(squash(rule.body)) && rule.selector.includes('.route-map'));
    expect(stack).toBeTruthy();
    for (const name of ['.rm-list', '.rm-track', '.rm-ends']) expect(stack.selector).toContain(name);
    const hidden = fallback.find(rule => /display:none!important/.test(squash(rule.body)));
    for (const name of ['.rm-h', '.rm-v', '.rm-road']) expect(hidden.selector).toContain(name);
  });

  test('subgrid is only used in rules that the fallback overrides', () => {
    for (const rule of rules.filter(r => !r.keyframes && /subgrid/.test(r.body))) {
      expect(rule.selector).toMatch(/\.rm-(list|track|h|v)\b/);
    }
  });
});

describe('colour contrast (16.10, 17.5)', () => {
  const light = themeVars(['src/itinerary.css'], ':root');
  const dark = themeVars(['src/itinerary.css'], ':root[data-theme=dark]');
  const themes = { light, dark };
  const toneNames = ['--ip-tone-0', '--ip-tone-1', '--ip-tone-2'];
  const carColors = CAR_PALETTE.map(value => value.toLowerCase());

  test('the palette is the one in the design', () => {
    expect(light).toMatchObject({ '--ip-paper': '#fffcf6', '--ip-card': '#fffdf8', '--ip-ink': '#3e3a39', '--ip-muted': '#766e63', '--ip-road': '#f8e2b0', '--ip-badge-ink': '#3e3a39', '--ip-tone-0': '#efa28f', '--ip-tone-1': '#b7dbe5', '--ip-tone-2': '#b9cda5' });
    expect(dark).toMatchObject({ '--ip-paper': '#252b28', '--ip-card': '#2d332e', '--ip-ink': '#f1ebdd', '--ip-muted': '#bdbbae', '--ip-road': '#5c533f', '--ip-badge-ink': '#131915', '--ip-tone-0': '#be7768', '--ip-tone-1': '#6696a4', '--ip-tone-2': '#809c68' });
  });

  for (const [name, vars] of Object.entries(themes)) {
    test(`${name}: text is at least 4.5:1 on its own background`, () => {
      for (const bg of ['--ip-paper', '--ip-card']) {
        expect(contrast(vars['--ip-ink'], vars[bg])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(vars['--ip-muted'], vars[bg])).toBeGreaterThanOrEqual(4.5);
      }
      for (const tone of toneNames) expect(contrast(vars['--ip-badge-ink'], vars[tone])).toBeGreaterThanOrEqual(4.5);
    });

    test(`${name}: outlines and graphics are at least 3:1 against what they touch`, () => {
      for (const bg of ['--ip-paper', '--ip-card']) expect(contrast(vars['--ip-ink'], vars[bg])).toBeGreaterThanOrEqual(3);
      expect(contrast(vars['--ip-ink'], vars['--ip-road'])).toBeGreaterThanOrEqual(3);
      // light: the ink outline is the boundary of car bodies and badges; dark: the fill itself must stand out from the paper
      for (const color of carColors) {
        if (name === 'light') expect(contrast(vars['--ip-ink'], color)).toBeGreaterThanOrEqual(3);
        else expect(contrast(color, vars['--ip-card'])).toBeGreaterThanOrEqual(3);
      }
      for (const tone of toneNames) {
        if (name === 'light') expect(contrast(vars['--ip-ink'], vars[tone])).toBeGreaterThanOrEqual(3);
        else expect(contrast(vars[tone], vars['--ip-paper'])).toBeGreaterThanOrEqual(3);
      }
    });
  }

  test('dark: Car_Colors are also at least 3:1 on the card (the stroke is the only boundary of the car body)', () => {
    for (const color of carColors) expect(contrast(color, dark['--ip-card'])).toBeGreaterThanOrEqual(3);
  });

  test('design figures: ink on paper about 10.9:1 (light), 12:1 (dark), outlines at least 10:1', () => {
    expect(contrast(light['--ip-ink'], light['--ip-paper'])).toBeGreaterThan(10.5);
    expect(contrast(dark['--ip-ink'], dark['--ip-paper'])).toBeGreaterThan(11.5);
    expect(contrast(dark['--ip-ink'], dark['--ip-card'])).toBeGreaterThan(10.5);
  });

  test('the only backgrounds the poster draws come from the theme variables (no light literal in dark)', () => {
    for (const rule of rules) {
      if (rule.keyframes || rule.at.includes(PRINT) || selectors(rule.selector).some(part => /^:root/.test(part))) continue;
      for (const d of decls(rule.body)) {
        if (!/^background(-color)?$/.test(d.prop)) continue;
        for (const hex of d.value.match(/#[0-9a-f]{3,8}\b/gi) ?? []) {
          const full = hex.length === 4 ? `#${[...hex.slice(1)].map(c => c + c).join('')}` : hex.slice(0, 7);
          expect({ selector: rule.selector, hex, light: luminance(full) > 0.6 }).toEqual({ selector: rule.selector, hex, light: false });
        }
      }
    }
  });

  // Editor colours come from styles.css theme variables (+ later sheets in build order).
  const sheets = ['src/styles.css', 'src/accounts.css', 'src/scene-motion.css', 'src/itinerary.css', 'src/expenses.css'];
  for (const [name, selector] of [['light', ':root'], ['dark', ':root[data-theme=dark]']]) {
    test(`${name}: editor text, placeholders, disabled-reason text and 「已加入」 are at least 4.5:1`, () => {
      const base = { ...themeVars(sheets, ':root'), ...(name === 'dark' ? themeVars(sheets, selector) : {}) };
      const need = (fg, bg) => expect(contrast(base[fg], base[bg])).toBeGreaterThanOrEqual(4.5);
      need('--muted', '--card');        // placeholder in .plan-card, .plan-summary
      need('--muted', '--paper');
      need('--muted', '--soft');        // .plan-empty / .plan-preview notes
      need('--ink', '--soft');          // .plan-added, .plan-bought, preview notes
      need('--ink', '--warn');          // .plan-warnings
      need('--danger', '--card');       // .field-error
      need('--danger', '--paper');
      need('--paper', '--danger');      // .date-tab-count
      expect(contrast('#3e3a39', base['--yellow'])).toBeGreaterThanOrEqual(4.5); // selected segment / day button
      need('--ink', '--card');          // unselected day button (text colour, no opacity)
    });
  }

  test('unselected day buttons use a text colour, not opacity (16.10)', () => {
    for (const file of ['src/styles.css', 'src/itinerary.css']) {
      for (const rule of parse(read(file))) {
        if (rule.keyframes || !/date-tabs/.test(rule.selector) || /selected|aria-pressed|aria-selected/.test(rule.selector)) continue;
        expect(decls(rule.body).filter(d => d.prop === 'opacity').map(d => d.value)).not.toContain('.75');
      }
    }
  });

  test('every font-size in itinerary.css is at least 12px (16.11)', () => {
    for (const rule of rules.filter(r => !r.keyframes)) {
      for (const d of decls(rule.body).filter(x => x.prop === 'font-size')) {
        const px = /^(\d+(?:\.\d+)?)px$/.exec(d.value);
        if (px) expect({ selector: rule.selector, px: Number(px[1]) >= 12 }).toEqual({ selector: rule.selector, px: true });
      }
    }
  });
});

describe('car colours, build list and icons (22.6, 17.7)', () => {
  test('car-0 to car-7 in itinerary.css equal CAR_PALETTE in order', () => {
    const found = [];
    for (const rule of rules) {
      for (const part of selectors(rule.selector)) {
        const match = /^\.car-(\d+)$/.exec(part);
        if (!match) continue;
        const color = decls(rule.body).find(d => d.prop === '--ip-car')?.value.toLowerCase();
        found[Number(match[1])] = color;
      }
    }
    expect(found).toEqual(CAR_PALETTE.map(value => value.toLowerCase()));
    expect(CAR_PALETTE).toHaveLength(8);
  });

  test('scripts/build.mjs concatenates itinerary.css after styles.css', () => {
    const list = /\[((?:'[^']+',?\s*)+)\]\.map\(file=>readFile/.exec(read('scripts/build.mjs'));
    expect(list).toBeTruthy();
    const files = [...list[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
    expect(files).toContain('itinerary.css');
    expect(files.indexOf('itinerary.css')).toBeGreaterThan(files.indexOf('styles.css'));
  });

  test('every icon the editor and the poster ask for exists in the icons of src/app.js', () => {
    const app = read('src/app.js');
    const block = /const icons\s*=\s*\{([\s\S]*?)\n\};/.exec(app)[1];
    const known = new Set([...block.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map(m => m[1]));
    expect(known.size).toBeGreaterThan(10);
    const used = new Set();
    for (const file of ['src/itinerary-editor.js', 'src/itinerary-poster.js']) {
      for (const m of read(file).matchAll(/\bicon\(\s*(['"`])([\w-]+)\1/g)) used.add(m[2]);
    }
    expect(used.size).toBeGreaterThan(0);
    for (const name of used) expect({ name, known: known.has(name) }).toEqual({ name, known: true });
  });
});
