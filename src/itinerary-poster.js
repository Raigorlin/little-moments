// Itinerary_Poster markup (design 「src/itinerary-poster.js（行程圖）」, 「文件結構」). Pure functions that return HTML
// strings; app.js owns the DOM, the events and the Scene_Motion_State. Nothing here reads the DOM, writes state or
// calls the network.
//
// posterHtml(state, { icon, mapLink, print, textOpen, canEdit, models, plan })
//   icon(name): the app's icon helper; mapLink(location, options): maps.js, which returns escaped HTML;
//   models: dayModel() of every Trip_Day (a Map by date, an object by date or an array), derived here when missing;
//   plan: shoppingPlan(state), derived here when missing, so a caller may pass one plan per render.
// Every illustration comes from artFor() only. Every user value is written through escape() exactly once (22.1);
// ids and user text appear only in element text, aria/data attribute values and the mapLink() href (22.5).
// The Planning_Warning is never shown on the poster (9.10).
//
// The Text_Panel (`textOpen`, 15.1) follows the poster content and is not part of the print copy.
import { escape } from './model.js';
import { artFor, fixedRandom } from './itinerary-art.js';
import { carColorIndex, dayModel, shoppingPlan, tripDays } from './itinerary-derive.js';
import { chineseNumeral, cleanText, dateText, durationText, trimWhite } from './itinerary-model.js';
import { itineraryText, momentLines, routeLineText } from './itinerary-text.js';
import { sceneMotionToggle } from './scene-motion.js';

const DOT = '\u30FB'; // ・
const COLON = '\uFF1A'; // ：
const TIME_PATTERN = /^\d{2}:\d{2}$/;
// Line breaks that split the trip description into paragraphs (same as Itinerary_Text, 14.3).
const LINE_BREAK = /\r\n|[\r\n\u000B\u000C\u0085\u2028\u2029]/u;
const DISCLAIMER = '路線僅為示意，非導航或即時位置；不預估返抵時間。';

const list = value => (Array.isArray(value) ? value : []);
const rec = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The day model of `date` from the caller's `models` (Map, object by date or array), otherwise derived. */
function modelFor(state, models, plan, date) {
  let found = null;
  if (models instanceof Map) found = models.get(date) ?? null;
  else if (Array.isArray(models)) found = models.find(model => model?.date === date) ?? null;
  else if (rec(models)) found = models[date] ?? null;
  return found ?? dayModel(state, date, plan);
}

/** `<time datetime>` for an HH:MM time; other text (「時間待定」) is plain text (16.2). */
function timeHtml(time, fallback = '') {
  return TIME_PATTERN.test(time) ? `<time datetime="${escape(time)}">${escape(time)}</time>` : escape(time || fallback);
}
const dateHtml = date => `<time datetime="${escape(date)}">${escape(dateText(date))}</time>`;

/** Top summary text (11.13): Duration_Text・{N}台車・{start}至 {end}, as parts with `<time>` elements and as plain text. */
function summary(state, days) {
  const duration = durationText(days.length);
  const vehicles = list(state?.vehicles).length;
  const parts = [escape(duration)], plain = [duration];
  if (vehicles) {
    parts.push(escape(`${chineseNumeral(vehicles)}台車`));
    plain.push(`${chineseNumeral(vehicles)}台車`);
  }
  if (days.length) {
    const first = days[0].date, last = days[days.length - 1].date;
    parts.push(days.length === 1 ? dateHtml(first) : `${dateHtml(first)}至 ${dateHtml(last)}`);
    plain.push(days.length === 1 ? dateText(first) : `${dateText(first)}至 ${dateText(last)}`);
  }
  return { html: parts.join(DOT), text: plain.join(DOT) };
}

/** Print cover (13.7): trip name, the summary text and the trip description, one paragraph per non-blank line. */
function coverHtml(state, summaryText) {
  const trip = rec(state?.trip) ? state.trip : {};
  const title = cleanText(typeof trip.title === 'string' ? trip.title : '');
  const description = cleanText(typeof trip.description === 'string' ? trip.description : '', { multiline: true });
  const paragraphs = description.split(LINE_BREAK).map(trimWhite).filter(Boolean);
  return `<header class="poster-print-cover">${title ? `<p class="poster-print-title">${escape(title)}</p>` : ''}<p>${escape(summaryText)}</p>${paragraphs.map(text => `<p>${escape(text)}</p>`).join('')}</header>`;
}

/** One place name as a map link, or its fallback text (mapLink() escapes). */
const placeHtml = (mapLink, segment) => mapLink(segment.place, { fallback: segment.text });

const LANE_STEP = 10, LANE_BASE = 12, LANE_MAX = 92, ENTRY_BASE = 26;
const laneWidth = count => Math.min(LANE_MAX, LANE_BASE + LANE_STEP * count);

/**
 * Grid positions of a Route_Block's route map in both layouts (design 「routeMapLayout(block)」, 「路線圖的格線」).
 * Input: the block's `lines` and `ends`. Pure: nothing but the input decides the result and the input is not changed.
 * Rows and group numbers `g` start at 1; a legacy line has `g: null`.
 *  - k: Stop columns (at least 1); cw: width of the merge column; lw: width of the branch column (CSS px).
 *  - ends[i]: { g, h: { row, span }, v: { row, roadFrom } }, in the order of block.ends.
 *  - lines[i]: { g, h: { row, late, lane, entry, target }, v: { row, stopRows, lane, lastRow } }.
 *    Horizontal: late is true when the row is outside the line's own group segment (a wrapped line); lane is its
 *    merge branch (1 = nearest the road), target the last row of its segment, entry where it joins the road in that row.
 *    Vertical: lane is null when the line needs no branch.
 *  - minHeight: [{ row, px }] horizontal rows to raise; vRows: rows of the vertical layout.
 */
export function routeMapLayout(block) {
  const lines = list(block?.lines), ends = list(block?.ends);
  const count = lines.length, groupCount = ends.length;
  const groupOf = new Array(count).fill(null);
  ends.forEach((end, index) => list(end?.lines).forEach(i => { if (i >= 0 && i < count) groupOf[i] = index + 1; }));
  const stopCount = line => (line?.type === 'route' ? list(line.stops).length : 0);
  const k = Math.max(1, ...lines.map(stopCount));

  // Horizontal: consecutive row segments, one per group, starting at the group's first line (the first at row 1).
  const starts = ends.map((end, index) => (index === 0 ? 1 : (list(end?.lines)[0] ?? 0) + 1));
  const segments = starts.map((row, index) => ({ row, span: (index + 1 < groupCount ? starts[index + 1] : count + 1) - row }));
  const entries = new Array(groupCount).fill(0);
  let late = 0;
  const hLines = lines.map((line, i) => {
    const row = i + 1, g = groupOf[i];
    const segment = g === null ? null : segments[g - 1];
    const last = segment ? segment.row + segment.span - 1 : row;
    const wrapped = segment !== null && (row < segment.row || row > last);
    if (!wrapped) return { row, late: false, lane: null, entry: null, target: g === null ? null : last };
    entries[g - 1] += 1;
    late += 1;
    return { row, late: true, lane: late, entry: ENTRY_BASE + LANE_STEP * entries[g - 1], target: last };
  });
  const minHeight = [];
  entries.forEach((m, index) => {
    if (m > 0) minHeight.push({ row: segments[index].row + segments[index].span - 1, px: ENTRY_BASE + LANE_STEP * m + 12 });
  });
  const cw = late > 0 ? Math.min(LANE_MAX, LANE_BASE + LANE_STEP * late) : 0;

  // Vertical: departures, the Stop rows of every route with Stops, one row per end group, then the caption.
  const stopRows = lines.map(() => []);
  let next = count + 1;
  lines.forEach((line, i) => { for (let s = 0; s < stopCount(line); s += 1) stopRows[i].push(next++); });
  const endRow = index => next + index;
  const vRows = next + groupCount;
  const lastGroup = groupCount;
  const lanes = new Array(count).fill(null);
  let lane = 0;
  for (let g = 1; g < lastGroup; g += 1) list(ends[g - 1]?.lines).forEach(i => { lane += 1; lanes[i] = lane; });
  if (lastGroup > 0) list(ends[lastGroup - 1]?.lines).forEach(i => { if (stopRows[i].length) { lane += 1; lanes[i] = lane; } });
  const vLines = lines.map((line, i) => {
    const g = groupOf[i], rows = stopRows[i];
    let lastRow = i + 1;
    if (g !== null) lastRow = g === lastGroup ? (rows.length ? rows[rows.length - 1] : i + 1) : endRow(g - 1);
    return { row: i + 1, stopRows: rows, lane: lanes[i], lastRow };
  });
  const vEnds = ends.map((end, index) => {
    const row = endRow(index);
    const roadFrom = index + 1 === lastGroup ? (lastGroup === 1 ? 1 : (list(end?.lines)[0] ?? 0) + 1) : row;
    return { row, roadFrom };
  });
  return {
    k, cw, lw: laneWidth(lane),
    ends: ends.map((end, index) => ({ g: index + 1, h: segments[index], v: vEnds[index] })),
    lines: lines.map((line, i) => ({ g: groupOf[i], h: hLines[i], v: vLines[i] })),
    minHeight, vRows
  };
}

const px = value => (Number.isFinite(value) ? Math.round(value) : 0);

// ---- Car animation (design 「動畫」: motionPlan(), motionCss(), 「車子的接力元素」) ----
const MOVE = { column: 0.9, hop: 0.4, row: 0.3, stopIn: 0.35, stopOut: 0.45, fade: 0.3, park: 0.4, curve: 0.8 };
const ARRIVAL = 3, CAR_HALF = 16;
const num = value => String(Math.round(value * 1e4) / 1e4);

/** FNV-1a (32 bit) of a string as 8 hex digits. */
function fnvHex(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

const hop = (cls, to, extra = {}) => ({ cls, axis: 'X', legs: [{ to, d: MOVE.hop }], ...extra });
const vert = (cls, rr, d, dwell = false) => ({ cls, axis: 'Y', rr, legs: [{ to: 'translateY(100%)', d, dwell }] });
const up = (cls, rr = null) => ({ cls, axis: 'Y', rr, legs: [{ to: 'translateY(-100%)', d: MOVE.row }] });

/** Relay definitions (unscaled move seconds) of one route in the horizontal layout. */
function horizontalRelays(entry, stops, layout, fan = false) {
  const { k, cw } = layout, h = entry.h;
  const legs = [];
  let x = 0;
  for (let j = 1; j <= stops; j += 1) {
    const c = j - 0.5;
    legs.push({ to: `translateX(calc(${num(c / k * 100)}% - ${CAR_HALF}px))`, d: (c - x) * MOVE.column, dwell: true });
    x = c;
  }
  legs.push({ to: `translateX(calc(100% - ${CAR_HALF}px))`, d: (k - x) * MOVE.column });
  const out = [{ cls: 'rm-run', axis: 'X', legs }];
  if (!h.late) {
    if (cw > 0) out.push(hop('rm-hop', 'translateX(100%)'));
    else if (fan) out.push(curveRelay(fan)); // the car follows the fan curve
    return out;
  }
  const bo = (h.lane - 1) * 10;
  out.push(hop('rm-hturn', `translateX(${cw - 9 - bo}px)`));
  out.push(up('rm-up-own'));
  for (let row = h.target + 1; row < h.row; row += 1) out.push(up('rm-up-mid', row - h.target + 1));
  out.push(up('rm-up-top'));
  out.push(hop('rm-hjoin', 'translateX(100%)'));
  return out;
}

/** Relay definitions of one route in the vertical layout (the car follows its branch; Stops are rows on it). */
function verticalRelays(entry, groupCount) {
  const v = entry.v;
  if (v.lane === null) return [hop('rm-vdirect', 'translateX(-100%)')];
  const out = [hop('rm-vh0', 'translateX(-100%)'), vert('rm-vcol rm-vhead', 1, MOVE.row)];
  for (let r = v.row + 1; r <= v.lastRow; r += 1) {
    const rr = r - v.row + 1, stop = v.stopRows.includes(r);
    if (r === v.lastRow && entry.g !== groupCount) out.push(vert('rm-vcol rm-vend', rr, MOVE.row));
    else if (stop) {
      out.push(vert('rm-vcol rm-vtop', rr, MOVE.stopIn, true));
      if (r === v.lastRow) out.push({ ...hop('rm-vroad', 'translateX(-100%)'), rr });
      else out.push(vert('rm-vcol rm-vrest', rr, MOVE.stopOut));
    } else out.push(vert('rm-vcol', rr, MOVE.row));
  }
  return out;
}

/** Keyframes of one relay (or of a parking car when `park` is a number) as text, from its times in seconds. */
function framesText(points, period) {
  const eps = period * 2e-5, frames = new Map();
  let last = -Infinity;
  for (const [t0, opacity, transform] of points) {
    const t = Math.min(period, Math.max(t0, last + eps / 2, 0));
    last = t;
    frames.set(`${(t / period * 100).toFixed(4)}%`, `opacity:${opacity}${transform ? `;transform:${transform}` : ''}`);
  }
  return [...frames].map(([pct, body]) => `${pct}{${body}}`).join('');
}

/**
 * Time table of one Route_Block's cars in one layout ('h' or 'v'). Times are seconds from the start of a round.
 *  - groups by departure time (earliest first, no time last); group g starts at g × gap; each Stop holds `dwell`;
 *    moving seconds are scaled by `factor` so that L (the last car in its parking space) is within 4 to 12 seconds.
 *  - period = L + 3. lines[i] is null for a Legacy_Departure; otherwise { group, start, waypoints, relays, park }:
 *    waypoints = [start, Stop 1 arrival, …, arrival on the road, in the parking space] and each relay is
 *    { role, cls, rr, first, start, hold, end, name, frames }; park = { start, end, name, frames }.
 */
// Fan geometry (CSS px, relative to the road column): shared by the SVG drawing and the cars that follow it.
const FAN_ROW = 72, FAN_ROW_STOPS = 92, FAN_LINE_Y = 26, FAN_WIDTH = 130, CURVE_STEPS = 6;
export function fanGeometry(block, i) {
  const lines = list(block?.lines), n = lines.length;
  const rowPx = lines.some(line => list(line?.stops).length) ? FAN_ROW_STOPS : FAN_ROW;
  return { n, rowPx, y: i * rowPx + FAN_LINE_Y, end: n * rowPx / 2 + (i - (n - 1) / 2) * 3, width: FAN_WIDTH };
}
const round1 = value => Math.round(value * 10) / 10;
/** Relay of a car riding its fan curve: a cubic Bezier sampled into short legs, each a translate plus the heading. */
function curveRelay({ y, end, width }) {
  const c1 = width * 0.55, c2 = width * 0.45;
  const at = t => {
    const u = 1 - t;
    const x = 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * width;
    const py = u * u * u * y + 3 * u * u * t * y + 3 * u * t * t * end + t * t * t * end;
    const dx = 3 * u * u * c1 + 6 * u * t * (c2 - c1) + 3 * t * t * (width - c2);
    const dy = 6 * u * t * (end - y);
    return `translate(${round1(x)}px,${round1(py)}px) rotate(${round1(Math.atan2(dy, dx) * 180 / Math.PI)}deg)`;
  };
  const legs = [];
  for (let k = 1; k <= CURVE_STEPS; k += 1) legs.push({ to: at(k / CURVE_STEPS), d: MOVE.curve / CURVE_STEPS });
  return { cls: 'rm-curve', axis: 'C', zero: at(0), legs };
}

/** True when every route goes to one end and nothing wraps: the lines merge in a smooth fan (see fanHtml). */
export function isFan(block, geometry = routeMapLayout(block)) {
  const lines = list(block?.lines);
  return geometry.cw === 0 && list(block?.ends).length === 1 && lines.length > 0
    && lines.every(line => line?.type === 'route') && geometry.ends[0].h.span === lines.length;
}

export function motionPlan(block, layout) {
  const kind = layout === 'v' ? 'v' : 'h';
  const lines = list(block?.lines), geometry = routeMapLayout(block), groupCount = list(block?.ends).length;
  const routes = lines.map((line, i) => (line?.type === 'route' && geometry.lines[i].g !== null ? i : -1)).filter(i => i >= 0);
  const times = [...new Set(routes.map(i => (TIME_PATTERN.test(lines[i].time) ? lines[i].time : '')))]
    .sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a < b ? -1 : a > b ? 1 : 0));
  const G = times.length;
  const defs = new Map(), info = [];
  for (const i of routes) {
    const stops = list(lines[i].stops).length, entry = geometry.lines[i];
    const relays = kind === 'h' ? horizontalRelays(entry, stops, geometry, isFan(block, geometry) ? fanGeometry(block, i) : null) : verticalRelays(entry, groupCount);
    const move = relays.reduce((sum, relay) => sum + relay.legs.reduce((s, leg) => s + leg.d, 0), 0) + MOVE.fade + MOVE.park;
    defs.set(i, relays);
    info.push({ i, g: times.indexOf(TIME_PATTERN.test(lines[i].time) ? lines[i].time : ''), n: stops, move });
  }
  let gap = G <= 8 ? 0.6 : Math.min(0.6, 7.4 / (G - 1)), dwell = 0.8, factor = 1;
  const length = () => Math.max(0, ...info.map(x => x.g * gap + x.n * dwell + factor * x.move));
  const fit = target => Math.min(...info.map(x => (target - x.g * gap - x.n * dwell) / x.move));
  let L = length();
  if (info.length && L < 4) factor = fit(4);
  else if (L > 12) {
    if (G <= 8) gap = 0.4;
    dwell = 0.6;
    factor = fit(12);
  }
  L = length();
  const period = info.length ? L + ARRIVAL : 0;

  const out = lines.map(() => null);
  for (const x of info) {
    const start = x.g * gap, relays = defs.get(x.i);
    let t = start;
    const waypoints = [start], placed = [];
    relays.forEach((def, index) => {
      const points = [];
      const relay = { role: def.cls.split(' ').pop(), cls: def.cls, rr: def.rr ?? null, first: index === 0, start: t, hold: 0 };
      const zero = def.zero ?? `translate${def.axis}(0)`;
      points.push([0, relay.first ? 1 : 0, zero]);
      if (!relay.first) points.push([t - period * 2e-5, 0, zero]);
      points.push([t, 1, zero]);
      let to = zero;
      def.legs.forEach(leg => {
        t += leg.d * factor;
        to = leg.to;
        points.push([t, 1, to]);
        if (leg.dwell) { waypoints.push(t); t += dwell; relay.hold += dwell; points.push([t, 1, to]); }
      });
      relay.end = t;
      placed.push({ relay, points, to });
    });
    const arrive = placed[placed.length - 1].relay.end, faded = arrive + MOVE.fade * factor, parked = faded + MOVE.park * factor;
    waypoints.push(arrive, parked);
    placed.forEach(({ relay, points, to }, index) => {
      if (index === placed.length - 1) { points.push([faded, 0, to]); relay.end = faded; }
      else points.push([relay.end + period * 2e-5, 0, to]);
      points.push([period, 0, to]);
      const frames = framesText(points, period);
      relay.name = `ipm-${kind}-${fnvHex(`${num(period)}|${frames}`)}`;
      relay.frames = frames;
    });
    const parkFrames = framesText([[0, 0], [faded, 0], [parked, 1], [period, 1]], period);
    out[x.i] = {
      group: x.g + 1, start, waypoints, relays: placed.map(p => p.relay),
      park: { start: faded, end: parked, name: `ipm-${kind}-${fnvHex(`${num(period)}|${parkFrames}`)}`, frames: parkFrames }
    };
  }
  return { layout: kind, period, L, gap, dwell, groups: G, factor, lines: out };
}

/** `plans`: [{ h, v }] from motionPlan() (derived from the day models' route blocks when omitted). */
export function motionCss(models, plans) {
  let all = plans;
  if (!Array.isArray(all)) {
    const values = models instanceof Map ? [...models.values()] : Array.isArray(models) ? models : rec(models) ? Object.values(models) : [];
    all = values.flatMap(model => list(model?.blocks).filter(block => block?.type === 'routes')
      .map(block => ({ h: motionPlan(block, 'h'), v: motionPlan(block, 'v') })));
  }
  const frames = new Map(), rules = { h: new Map(), v: new Map() };
  for (const plan of all) {
    for (const kind of ['h', 'v']) {
      const one = plan?.[kind];
      if (!one) continue;
      const add = (item) => {
        frames.set(item.name, item.frames);
        rules[kind].set(item.name, `${num(one.period)}s`);
      };
      for (const line of one.lines) if (line) { line.relays.forEach(add); add(line.park); }
    }
  }
  if (!frames.size) return '';
  const body = kind => [...rules[kind]].map(([name, seconds]) => `:root[data-scene-motion=running] .${name},:root[data-scene-motion=paused] .${name}{animation:${name} ${seconds} linear infinite}`).join('');
  const query = (kind, width) => (rules[kind].size ? `@media (prefers-reduced-motion: no-preference) and (${width}){${body(kind)}}` : '');
  return `${[...frames].map(([name, text]) => `@keyframes ${name}{${text}}`).join('')}${query('h', 'min-width: 761px')}${query('v', 'max-width: 760px')}`;
}

const CAR_ART = () => artFor('car', 'car', { className: 'rm-car' });

function relayHtml(relay) {
  const style = relay.rr === null ? '' : ` style="--rr:${px(relay.rr)}"`;
  return `<span class="rm-relay ${relay.cls} ip-anim ${relay.name}${relay.first ? ' rm-relay--first' : ''}"${style}>${CAR_ART()}</span>`;
}

/** The aria-hidden line of one route: a static drawing plus the car's relay elements, for both layouts (13.1). Integers only (22.5). */
function laneHtml(entry, plan) {
  const { h, v } = entry;
  const horizontal = `<span class="rm-h" style="--dr:${px(h.row)};--late:${h.late ? 1 : 0};--lane:${px(h.lane ?? 0)};--entry:${px(h.entry ?? 0)};--target:${px(h.target ?? h.row)}">`
    + `${plan.h.relays.filter(relay => relay.cls !== 'rm-curve').map(relayHtml).join('')}</span>`;
  const vertical = `<span class="rm-v" style="--mr:${px(v.row)};--mspan:${px(v.lastRow - v.row + 1)};--lane:${px(v.lane ?? 0)};--last:${px(v.lastRow)}">`
    + `${plan.v.relays.map(relayHtml).join('')}</span>`;
  return `<span class="rm-lane" aria-hidden="true">${horizontal}${vertical}</span>`;
}
/** One Route or Legacy_Departure item of the route map (11.5, 11.7, 19.3, 19.10). */
function routeLineHtml(state, line, layout, mapLink, plan) {
  const text = routeLineText(line);
  const legacy = line.type === 'legacy';
  const color = carColorIndex(state, line.vehicle?.id);
  const id = legacy ? line.vehicle?.id : line.route?.id;
  const departure = line.time ? timeHtml(line.time) : escape(text.departure);
  const { h, v } = layout;
  const stops = text.stops.map((stop, index) => {
    const detail = stop.detail ? `<span class="rm-stop-note">（${escape(stop.detail)}）</span>` : '';
    const kind = line.stops[index]?.kind;
    const at = `--sj:${index + 1};--sr:${px(v.stopRows[index])}`;
    return `<span class="rm-stop-art" aria-hidden="true" style="${at}">${artFor('stop', kind)}</span>`
      + `<p class="rm-stop" style="${at}">${mapLink(stop.place, { fallback: stop.text })}${detail}</p>`;
  }).join('');
  const to = text.end ? `<span class="visually-hidden">，到 ${placeHtml(mapLink, text.end)}</span>` : '';
  const grid = `--dr:${px(h.row)};--mr:${px(v.row)};--mspan:${px(v.lastRow - v.row + 1)}${layout.g === null ? '' : `;--g:${layout.g}`}`;
  return `<li class="rm-track car-${color}${legacy ? ' rm-track--legacy' : ''}" style="${grid}" data-line="${legacy ? 'legacy' : 'route'}" data-id="${escape(id ?? '')}">`
    + `<p class="rm-dep"><span class="rm-chip" aria-hidden="true"></span>${departure} ${escape(text.car)}${COLON}${placeHtml(mapLink, text.start)}</p>${stops}${to}`
    + `${legacy || !plan ? '' : laneHtml(layout, plan)}</li>`;
}

/** 「{車名}先採買」 under the route map (11.8). '' when no route in the block has a Shopping_Stop. */
function shoppingCaption(block) {
  const lines = block.lines;
  const shoppers = lines.filter(line => line.type === 'route' && list(line.stops).some(stop => stop?.kind === 'shop'));
  if (!shoppers.length) return '';
  const names = shoppers.map(line => routeLineText(line).car).join('、');
  const direct = lines.filter(line => line.type === 'route' && !shoppers.includes(line));
  const onlyDirect = !lines.some(line => line.type === 'legacy') && direct.length > 0
    && direct.every(line => list(line.stops).length === 0);
  return `${names}先採買${onlyDirect ? `，其他${chineseNumeral(direct.length)}車直達` : ''}`;
}

/** One end group (11.6, 12.10, 11.17): illustration, text, the arrival line of the camp and one parking space per route. */
function endHtml(state, model, block, end, layout, mapLink, arrivalAt, plans) {
  const parks = end.lines.map(i => {
    const names = [plans.h.lines[i]?.park.name, plans.v.lines[i]?.park.name].filter(Boolean).join(' ');
    return `<span class="rm-space car-${carColorIndex(state, block.lines[i]?.vehicle?.id)}">${artFor('car', 'car', { className: `rm-car rm-park-car ip-anim ${names}`.trim() })}</span>`;
  }).join('');
  const name = mapLink(cleanText(end.name));
  let label;
  if (end.endKind === 'house') label = `平安回到${name}`;
  else label = name;
  const arrival = arrivalAt && block.arrivalLine
    ? `<p class="rm-arrival" data-line="arrival" data-id="${escape(model.date)}">${escape(block.arrivalLine)}</p>` : '';
  const kind = ['camp', 'house', 'landmark'].includes(end.endKind) ? end.endKind : 'landmark';
  const style = `--g:${layout.g};--hr:${px(layout.h.row)};--hspan:${px(layout.h.span)};--vr:${px(layout.v.row)}`;
  return `<div class="rm-end rm-end--${kind}" style="${style}"><span class="rm-end-art" aria-hidden="true">${artFor('end', kind)}</span>`
    + `<p class="rm-end-name">${label}</p>${arrival}<span class="rm-park" aria-hidden="true">${parks}</span></div>`;
}

// ---- Fan: smooth curves that merge the cars' lines into one road (horizontal layout, one end, no wrapped line) ----
/** Inline SVG (numbers only) behind the cars, in the road column, one row per line; the cars of the rm-curve relays
 *  (CSS keyframes from curveRelay) follow the same Bezier curves in CSS pixels. */
function fanHtml(state, block, plan) {
  const { n, rowPx } = fanGeometry(block, 0), height = n * rowPx, mid = height / 2;
  const ink = [], color = [], cars = [];
  block.lines.forEach((line, i) => {
    const { y, end } = fanGeometry(block, i), cls = `car-${carColorIndex(state, line.vehicle?.id)}`;
    const d = `M0 ${round1(y)} C 55 ${round1(y)} 45 ${round1(end)} 100 ${round1(end)}`;
    ink.push(`<path class="rm-fan-ink" d="${d}"/>`);
    color.push(`<path class="rm-fan-line ${cls}" d="${d}"/>`);
    const relay = plan?.lines[i]?.relays.find(item => item.cls === 'rm-curve');
    if (relay) cars.push(`<span class="rm-relay rm-curve ip-anim ${relay.name} ${cls}">${CAR_ART()}</span>`);
  });
  const f = round1;  const trunk = `M40 ${f(mid)} H100`;
  return `<svg class="rm-fan" viewBox="0 0 100 ${f(height)}" preserveAspectRatio="none" style="height:${f(height)}px" aria-hidden="true" focusable="false">`
    + `<path class="rm-fan-trunk-ink" d="${trunk}"/><path class="rm-fan-trunk" d="${trunk}"/>${ink.join('')}${color.join('')}</svg>${cars.join('')}`;
}

/** A Route_Block (routes): the route map with its roads and ends, the arrival line (14.11) and the return line (14.12). */
function routeBlockHtml(state, model, block, mapLink, kit) {
  const layout = routeMapLayout(block);
  const plans = { h: motionPlan(block, 'h'), v: motionPlan(block, 'v') };
  kit.plans.push(plans);
  const lines = block.lines.map((line, i) => routeLineHtml(state, line, layout.lines[i], mapLink, plans.h.lines[i] ? { h: plans.h.lines[i], v: plans.v.lines[i] } : null)).join('');
  // Fan layout: when every route goes to one end and nothing wraps, the lines bend smoothly into one shared road.
  const fan = isFan(block, layout);
  const roads = layout.ends.map(end => `<span class="rm-road" aria-hidden="true" style="--g:${end.g};--hr:${px(end.h.row)};--hspan:${px(end.h.span)};--vr:${px(end.v.roadFrom)};--vspan:${px(end.v.row - end.v.roadFrom + 1)}">${fan ? fanHtml(state, block, plans.h) : ''}</span>`).join('');
  const camp = block.ends.findIndex(end => end.endKind === 'camp');
  const ends = block.ends.map((end, index) => endHtml(state, model, block, end, layout.ends[index], mapLink, index === camp, plans)).join('');
  // An arrival line without a camp end still follows the lines, as in Itinerary_Text.
  const stray = camp < 0 && block.arrivalLine
    ? `<p class="rm-arrival" data-line="arrival" data-id="${escape(model.date)}">${escape(block.arrivalLine)}</p>` : '';
  const back = block.returnLine ? `<p class="rm-return visually-hidden" data-line="return" data-id="${escape(model.date)}">${escape(block.returnLine)}</p>` : '';
  const caption = shoppingCaption(block);
  const vars = `--k:${layout.k};--t:${block.lines.length};--e:${block.ends.length};--cw:${px(layout.cw)};--lw:${px(layout.lw)};--mrows:${px(layout.vRows)}`;
  const heights = layout.minHeight.map(item => `--mh-${px(item.row)}:${px(item.px)}`).join(';');
  return `<div class="route-map${fan ? ' rm-fanmap' : ''}" style="${vars}${fan ? `;--R:${fanGeometry(block, 0).rowPx}px` : ''}${heights ? `;${heights}` : ''}"><ul class="rm-list" aria-label="路線">${lines}</ul>${roads}`
    + `<div class="rm-ends">${ends}${stray}${back}</div>${caption ? `<p class="rm-caption">${escape(caption)}</p>` : ''}</div>`;
}

/** One card of an Activity or a Meal_Moment (11.9 to 11.11, 8.5 to 8.7, 8.10, 8.13). */
function momentHtml(item, kit) {
  const { icon, mapLink } = kit;
  const meal = item.type === 'meal';
  const art = meal
    ? artFor('dish', item.dishKind, { className: 'moment-dish', seed: fixedRandom(item.meal.id) })
    : artFor('activity', item.activity.type);
  const id = meal ? item.meal.id : item.activity.id;
  const lines = momentLines(item);
  const extras = lines.filter(line => line.kind !== 'item' && line.kind !== 'ingredients').map(line => (
    `<p class="moment-${line.kind}">${escape(line.prefix)}${line.kind === 'location' ? mapLink(line.value) : escape(line.value)}</p>`
  )).join('');
  const ingredients = lines.find(line => line.kind === 'ingredients');
  const done = !meal && item.done
    ? `<p class="moment-done">${icon('check')}<span>已完成</span></p>` : '';
  return `<li class="moment-card ${meal ? 'moment-card--meal' : 'moment-card--activity'}${done ? ' is-done' : ''}" data-line="${meal ? 'meal' : 'activity'}" data-id="${escape(id)}">`
    + `<span class="moment-art" aria-hidden="true">${art}</span>`
    + `<div class="moment-body"><p class="moment-time">${timeHtml(item.time, '時間待定')}</p>`
    + `<p class="moment-title">${escape(item.title)}</p><p class="moment-tag">${escape(meal ? item.label : item.category)}</p>`
    + `${ingredients ? `<p class="moment-ingredients">${escape(ingredients.value)}</p>` : ''}${extras}${done}</div></li>`;
}

/** One Trip_Day section (11.2, 11.4). */
function dayHtml(state, model, kit) {
  const { pre, mapLink } = kit;
  const tone = (model.n - 1) % 3, headId = `${pre}poster-day-${model.n}`;
  const full = `${dateText(model.date)}`;
  const heading = model.title
    ? `<span class="visually-hidden">第 ${model.n} 天${DOT}${escape(full)}${DOT}</span>${escape(model.title)}`
    : `第 ${model.n} 天<span class="visually-hidden">${DOT}${escape(full)}</span>`;
  const location = model.showLocationLine && model.location
    ? `<p class="day-location">地點${COLON}${mapLink(cleanText(model.location.name))}</p>` : '';
  const blocks = model.blocks.map(block => (block.type === 'routes'
    ? routeBlockHtml(state, model, block, mapLink, kit)
    : `<ul class="moment-list" aria-label="活動">${block.items.map(item => momentHtml(item, kit)).join('')}</ul>`)).join('');
  return `<section class="poster-day day-tone-${tone}" data-poster-day aria-labelledby="${headId}">`
    + `<div class="poster-day-head"><span class="day-badge" aria-hidden="true">${String(model.n).padStart(2, '0')}</span>`
    + `<h3 id="${headId}" data-line="day" data-id="${escape(model.date)}">${heading}</h3>`
    + `<p class="day-meta">${dateHtml(model.date)}${DOT}${escape(model.caption)}</p>${location}</div>${blocks}</section>`;
}

/** The empty state (1.8, 1.9, 11.19). */
function emptyHtml(canEdit) {
  return `<div class="poster-empty"><span class="poster-empty-art" aria-hidden="true">${artFor('empty')}</span>`
    + `<p class="poster-empty-title">這趟旅行還沒有行程</p>${canEdit ? '<button type="button" class="btn primary" data-plan-nav="view">開始規劃</button>' : ''}</div>`;
}

/** The Text_Panel (15.1, 16.4): the body is written only while open; the text goes through escape() (15.5, 22.1). */
function textPanelHtml(state, open) {
  return '<section class="itinerary-text-panel" aria-labelledby="text-panel-title"><div class="text-panel-head">'
    + '<h3 id="text-panel-title">文字版</h3>'
    + `<button type="button" class="button small" data-text-panel="toggle" data-focus="text-panel-toggle" aria-expanded="${open}"${open ? ' aria-controls="text-panel-body"' : ''}>${open ? '收起文字版' : '展開文字版'}</button>`
    + '<button type="button" class="button small" data-text-panel="copy" data-focus="text-panel-copy">複製文字</button></div>'
    + `${open ? `<pre id="text-panel-body" class="itinerary-text">${escape(itineraryText(state))}</pre>` : ''}</section>`;
}

export function posterHtml(state, {
  icon = () => '', mapLink = (location, options = {}) => escape(options.label ?? (location || options.fallback) ?? ''),
  print = false, textOpen = false, canEdit = false, models, plan
} = {}) {
  const days = tripDays(state);
  const shopping = plan ?? shoppingPlan(state);
  const dayModels = days.map(day => modelFor(state, models, shopping, day.date)).filter(Boolean);
  const hasContent = dayModels.some(model => model.blocks.length > 0);
  const hasRoutes = dayModels.some(model => model.blocks.some(block => block.type === 'routes'));
  const { html: summaryHtml, text: summaryText } = summary(state, days);
  const pre = print ? 'print-' : '';
  const kit = { icon, mapLink, pre, plans: [] };
  const vehicles = list(state?.vehicles).length;
  const duration = durationText(days.length);
  const closing = `${vehicles ? `${chineseNumeral(vehicles)}台車，` : ''}${duration}，一整頁的小小快樂。`;

  const head = `<h2 id="${pre}poster-title" class="visually-hidden">行程圖</h2>${coverHtml(state, summaryText)}`
    + `<div class="poster-summary"><p>${summaryHtml}</p>${print ? '' : sceneMotionToggle()}</div>`;
  const body = hasContent
    ? `${dayModels.map(model => dayHtml(state, model, kit)).join('')}`
      + `<p class="poster-closing">${escape(closing)}</p>${hasRoutes ? `<p class="poster-disclaimer">${DISCLAIMER}</p>` : ''}`
    : emptyHtml(canEdit);
  const css = print ? '' : motionCss(dayModels, kit.plans);
  const panel = print ? '' : textPanelHtml(state, textOpen === true);
  return `<section class="itinerary-poster" aria-labelledby="${pre}poster-title">${head}${body}${css ? `<style>${css}</style>` : ''}${panel}</section>`;
}

