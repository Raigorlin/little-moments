// Example tests of motionCss() (trip-planning-workflow-enhance task 11.17; requirements 13.1, 13.6, 17.2, 17.3).
import { describe, expect, test } from 'bun:test';

import { dayModel } from '../src/itinerary-derive.js';
import { motionCss } from '../src/itinerary-poster.js';
import { exampleTrip } from './fixtures/example-trip.js';

const state = exampleTrip();
const models = ['2026-10-20', '2026-10-21', '2026-10-22'].map(date => dayModel(state, date));
const css = motionCss(models);

/** Splits CSS into top-level items: { head, body } where body may itself contain nested rules. */
function topLevel(text) {
  const items = [];
  let depth = 0, start = 0, head = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '{') { if (depth === 0) head = text.slice(start, i); depth += 1; }
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) { items.push({ head: head.trim(), body: text.slice(text.indexOf('{', start) + 1, i) }); start = i + 1; }
    }
  }
  expect(depth).toBe(0);
  return items;
}

describe('motionCss()', () => {
  test('is empty without route blocks', () => {
    expect(motionCss([])).toBe('');
    expect(motionCss([dayModel(state, '2026-10-21')])).toBe('');
  });

  test('contains only generated names and numbers', () => {
    expect(css.length).toBeGreaterThan(0);
    expect(css).toMatch(/^[A-Za-z0-9 _\-.,:;%(){}@=[\]]*$/);
    expect(css).not.toMatch(/url\(|@import|expression|javascript|</i);
    const names = css.match(/@keyframes ([^{]+)\{/g).map(item => item.slice(11, -1));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(/^ipm-[hv]-[0-9a-f]{8}$/);
    // Not one of the example's user-visible texts appears in the style.
    for (const word of ['夕淞度日', '第一車', 'p1', 'v1', 'rt-1']) expect(css).not.toContain(word);
  });

  test('keyframes at the top level; animations only inside prefers-reduced-motion: no-preference', () => {
    const items = topLevel(css);
    const frames = items.filter(item => item.head.startsWith('@keyframes'));
    const queries = items.filter(item => !item.head.startsWith('@keyframes'));
    expect(frames.length + queries.length).toBe(items.length);
    expect(queries.length).toBe(2);
    expect(queries[0].head).toBe('@media (prefers-reduced-motion: no-preference) and (min-width: 761px)');
    expect(queries[1].head).toBe('@media (prefers-reduced-motion: no-preference) and (max-width: 760px)');
    expect(css.match(/animation:/g).length).toBe(css.match(/animation:ipm-/g).length);
    for (const frame of frames) expect(frame.body).not.toContain('animation');
  });

  test('every animation needs data-scene-motion running or paused, uses a defined keyframe and loops linearly', () => {
    const defined = new Set(css.match(/@keyframes (ipm-[hv]-[0-9a-f]{8})/g).map(item => item.slice(11)));
    const rules = topLevel(css).filter(item => !item.head.startsWith('@keyframes')).flatMap(item => topLevel(item.body));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const [running, paused, ...rest] = rule.head.split(',');
      expect(rest.length).toBe(0);
      const name = /\.(ipm-[hv]-[0-9a-f]{8})$/.exec(running)[1];
      expect(running).toBe(`:root[data-scene-motion=running] .${name}`);
      expect(paused).toBe(`:root[data-scene-motion=paused] .${name}`);
      expect(rule.body).toMatch(new RegExp(`^animation:${name} \\d+(\\.\\d+)?s linear infinite$`));
      expect(defined.has(name)).toBe(true);
    }
    expect(css).not.toMatch(/data-scene-motion=(reduced|static)/);
  });

  test('the same input gives the same output', () => {
    expect(motionCss(models)).toBe(css);
  });
});
