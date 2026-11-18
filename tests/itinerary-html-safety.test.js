// Feature: trip-planning-workflow-enhance, Property 20: 產生的 HTML 只在允許的位置放使用者值
// **Validates: Requirements 11.17, 15.5, 16.1, 16.4, 22.1, 22.2, 22.3, 22.5**
//
// 以 markupText() 填入使用者文字（含 XSS_Payload_Set、`]]>`、CSS 文字、字元參照與帶唯一標記碼的文字），
// 用 Bun 的 HTMLRewriter 解析 posterHtml()、posterHtml({ print: true }) 與展開各種卡片的 editorHtml()：
// - 沒有 script、iframe、frame、object、embed、img 元素，沒有以 on 開頭的屬性與 javascript: 網址；
// - 每個 <a> 的 href 等於 mapLink() 對該地點名稱的輸出，且不在 <svg> 內；
// - 每個 <svg> 都有 aria-hidden="true"，其中沒有文字節點與可取得焦點的元素；
// - 使用者文字只出現在文字節點與 aria-label、title、placeholder、value、data-* 的值（與 <a> 的 href）；
//   id、for、name、class、style 與 <style> 的內容不含使用者文字；
// - 每個 aria-controls、aria-describedby、aria-labelledby 與 for 都指向同一份 HTML 中存在的 id；
// - Text_Panel 的 <pre> 文字解碼後與 itineraryText() 逐字相同。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { dayModel, tripDays } from '../src/itinerary-derive.js';
import { activityDraft, legacyRouteDraft, newActivityDraft, newRouteDraft, routeDraft } from '../src/itinerary-edits.js';
import { editorHtml } from '../src/itinerary-editor.js';
import { posterHtml } from '../src/itinerary-poster.js';
import { itineraryText } from '../src/itinerary-text.js';
import { googleMapsUrl, mapLink } from '../src/maps.js';
import { itineraryState, markupText } from './support/itinerary-arb.js';

const bounded = numRuns => ({
  numRuns, includeErrorInReport: true, plugins: [fc.interruptAfterTimeLimit(170_000, { failOnInterrupt: true })]
});
// 每次約 0.5 秒，整套測試並行時會更慢；時間上限與 bun 的逐測試逾時都留足餘裕。
const TIMEOUT = 180_000;

const icon = (name, className = '') => `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z" data-icon="${name}"/></svg>`;

// ---- 解析 ----
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = text => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
  if (name[0] === '#') return String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
  return ENTITIES[name.toLowerCase()] ?? whole;
});

const FORBIDDEN_TAGS = new Set(['script', 'iframe', 'frame', 'object', 'embed', 'img']);
const SVG_FORBIDDEN = new Set(['text', 'tspan', 'textpath', 'title', 'desc', 'foreignobject', 'a', 'button', 'input', 'select', 'textarea', 'script', 'style', 'iframe', 'img', 'audio', 'video']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'data', 'poster', 'srcset']);
const USER_ATTRS = new Set(['aria-label', 'title', 'placeholder', 'value']);
const REFERENCE_ATTRS = ['aria-controls', 'aria-describedby', 'aria-labelledby'];
// 非使用者文字位置的屬性值不得含有的字元與字串（解碼前後都檢查）。
const FRAGMENTS = ['<', '>', '"', "'", '`', '&', 'alert(', 'onerror', 'javascript:', 'example.com', 'url(', 'red;background'];

/** 解析 html，回傳違反本性質的描述清單與供比對的資料。 */
async function inspect(html, { markers }) {
  const problems = [];
  const ids = new Set();
  const refs = [];
  const anchors = [];
  const stack = [];
  const preTexts = [];
  let styleText = '';
  let svgDepth = 0;

  const handler = {
    element(el) {
      const tag = el.tagName.toLowerCase();
      const attrs = [...el.attributes];
      const inSvg = svgDepth > 0;
      if (FORBIDDEN_TAGS.has(tag)) problems.push(`forbidden element <${tag}>`);
      if (inSvg && SVG_FORBIDDEN.has(tag)) problems.push(`<${tag}> inside <svg>`);
      const node = { tag, inSvg, text: '', attrs: Object.fromEntries(attrs) };
      for (const [rawName, value] of attrs) {
        const name = rawName.toLowerCase();
        if (name.startsWith('on')) problems.push(`event attribute ${name} on <${tag}>`);
        if (URL_ATTRS.has(name) && /^[\s\u0000-\u001f]*javascript:/i.test(value)) problems.push(`javascript: URL in ${name} on <${tag}>`);
        if (inSvg && name === 'tabindex') problems.push(`tabindex inside <svg> on <${tag}>`);
        if (name === 'id') ids.add(value);
        if (name === 'for') refs.push(...value.split(/\s+/).filter(Boolean).map(id => [`for on <${tag}>`, id]));
        if (REFERENCE_ATTRS.includes(name)) refs.push(...value.split(/\s+/).filter(Boolean).map(id => [`${name} on <${tag}>`, id]));
        const allowed = USER_ATTRS.has(name) || name.startsWith('data-') || (tag === 'a' && name === 'href');
        if (!allowed) {
          const found = markers.filter(marker => value.includes(marker));
          const bad = FRAGMENTS.filter(fragment => value.includes(fragment));
          if (found.length || bad.length) problems.push(`user text in ${name}="${value}" on <${tag}>`);
        }
      }
      if (tag === 'svg') {
        if (node.attrs['aria-hidden'] !== 'true') problems.push('<svg> without aria-hidden="true"');
      }
      if (tag === 'a') {
        if (inSvg) problems.push('<a> inside <svg>');
        anchors.push(node);
      }
      const hasEnd = el.canHaveContent !== false && !el.selfClosing;
      if (hasEnd && typeof el.onEndTag === 'function') {
        stack.push(node);
        if (tag === 'svg') svgDepth++;
        el.onEndTag(() => {
          if (tag === 'svg') svgDepth--;
          if (tag === 'pre' && node.attrs.id === 'text-panel-body') preTexts.push(decode(node.text));
          stack.pop();
        });
      }
    },
    text(chunk) {
      const top = stack[stack.length - 1];
      if (!top) return;
      if (top.tag === 'style') styleText += chunk.text;
      if (svgDepth > 0 && chunk.text.trim()) problems.push(`text node inside <svg>: ${JSON.stringify(chunk.text)}`);
      top.text += chunk.text;
      const anchor = [...stack].reverse().find(node => node.tag === 'a');
      if (anchor && anchor !== top) anchor.text += chunk.text;
    }
  };
  await new HTMLRewriter().on('*', handler).transform(new Response(html)).text();

  for (const [what, id] of refs) if (!ids.has(id)) problems.push(`${what} points to missing id "${id}"`);
  for (const anchor of anchors) {
    const name = decode(anchor.text);
    const expected = googleMapsUrl(name);
    const href = anchor.attrs.href ?? '';
    if (!expected || decode(href) !== expected) problems.push(`<a> href is not mapLink() of its name: ${JSON.stringify(name)} -> ${href}`);
    if (!mapLink(name).startsWith('<a ')) problems.push(`mapLink() of anchor name is not a link: ${JSON.stringify(name)}`);
  }
  const styleHit = markers.find(marker => styleText.includes(marker))
    ?? ['alert(', 'onerror', 'javascript:', 'example.com', 'A&B', '&', '`', 'red;background'].find(fragment => styleText.includes(fragment));
  if (styleHit) problems.push(`user text in <style> content: ${styleHit}`);
  return { problems, preTexts };
}

// ---- 規劃行程的 planner ----
const markerPattern = /mk[0-9a-z]{6}/g;
const markersOf = (...values) => [...new Set(values.flatMap(value => JSON.stringify(value).match(markerPattern) ?? []))];

function editorPlanners(state, seed, text) {
  state = { ...state, places: state.places ?? [], routes: state.routes ?? [] };
  const days = tripDays(state);
  const dayIndex = seed % days.length;
  const date = days[dayIndex].date;
  const model = dayModel(state, date);
  const keys = ['place:new', 'day', 'route:new', 'arrival', 'activity:new'];
  if (state.places[0]) keys.push(`place:${state.places[0].id}`);
  for (const route of state.routes.filter(item => item.date === date).slice(0, 2)) keys.push(`route:${route.id}`);
  for (const entry of (model?.legacy ?? []).slice(0, 2)) keys.push(`route:legacy:${entry.vehicle.id}`);
  for (const activity of state.activities.filter(item => item.date === date).slice(0, 2)) keys.push(`activity:${activity.id}`);
  for (const meal of state.meals.filter(item => item.date === date).slice(0, 2)) keys.push(`meal:${meal.id}`);
  const draftOf = key => {
    if (key === 'place:new') return { name: text };
    if (key === 'day') return { title: text, place: '', newPlaces: [{ id: 'new-1', name: text }] };
    if (key === 'arrival') return { arrival: text };
    if (key === 'activity:new') return newActivityDraft(state, date);
    if (key.startsWith('activity:')) return activityDraft(state, key.slice(9));
    if (key.startsWith('meal:')) return { time: text };
    if (key.startsWith('place:')) return { name: text };
    let draft = null;
    if (key === 'route:new') draft = newRouteDraft(state, date);
    else if (key.startsWith('route:legacy:')) draft = legacyRouteDraft(state, key.slice(13));
    else if (key.startsWith('route:')) draft = routeDraft(state, key.slice(6));
    if (draft) {
      draft.newPlaces = [{ id: 'new-1', name: text }];
      draft.stops?.forEach((stop, index) => { if (typeof stop.key !== 'string' || !stop.key) stop.key = String(index + 1); });
    }
    return draft;
  };
  const base = {
    view: 'editor', shown: true, dayIndex, segment: 'routes', placesOpen: true, unassignedOpen: true, textOpen: false,
    presets: new Set(['wake', 'free']), card: null, notice: state.places[0] ? { key: `place:${state.places[0].id}`, text } : null, focus: ''
  };
  const planners = [base, { ...base, segment: 'activities' }, { ...base, placesOpen: false, unassignedOpen: false }];
  for (const key of keys) {
    const draft = draftOf(key);
    if (!draft) continue;
    planners.push({
      ...base,
      segment: /^(activity|meal):/.test(key) ? 'activities' : 'routes',
      card: {
        key, draft, dirty: false, errors: new Proxy({}, { get: () => text }), formError: text,
        inlinePlace: { name: text, error: text, target: key === 'day' ? 'day' : '' }, sending: false
      }
    });
  }
  return planners;
}

describe('Property 20: 產生的 HTML 只在允許的位置放使用者值', () => {
  test('行程圖（畫面與列印）與規劃行程的 HTML 只在允許的位置放使用者文字', async () => {
    await fc.assert(fc.asyncProperty(
      itineraryState({ markup: true }), fc.nat(), markupText(100),
      async (state, seed, text) => {
        const markers = markersOf(state, text);
        const kit = { icon, mapLink };
        const outputs = [
          ['poster', posterHtml(state, { ...kit, canEdit: true, textOpen: true })],
          ['poster-closed', posterHtml(state, { ...kit, canEdit: false, textOpen: false })],
          ['poster-print', posterHtml(state, { ...kit, print: true })]
        ];
        for (const [name, html] of outputs) {
          const { problems, preTexts } = await inspect(html, { markers });
          expect({ name, problems }).toEqual({ name, problems: [] });
          if (name === 'poster') {
            expect(preTexts.length).toBe(1);
            expect(preTexts[0]).toBe(itineraryText(state));
          } else {
            expect(preTexts).toEqual([]);
          }
        }
        for (const [index, planner] of editorPlanners(state, seed, text).entries()) {
          const html = editorHtml(state, planner, { ...kit, canDeleteVehicle: true });
          const { problems } = await inspect(html, { markers });
          expect({ editor: index, card: planner.card?.key ?? null, problems }).toEqual({ editor: index, card: planner.card?.key ?? null, problems: [] });
        }
      }
    ), bounded(100));
  }, TIMEOUT);
});
