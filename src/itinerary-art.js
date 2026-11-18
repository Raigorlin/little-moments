// Itinerary_Poster illustrations: pure functions returning inline SVG strings (no DOM).
// Original artwork. Colours come from the --ip-* custom properties (with the light-theme value as fallback, so an
// <svg> also works as a standalone document); the car body takes --ip-car, set by the outer car-{index} class.
// No text, foreignObject, links, raster images or external resources (requirements 11.16, 16.1, 22.1, 22.5).
import { dishIllustration } from './dish-art.js';

const INK = 'var(--ip-ink,#3e3a39)';
const CARD = 'var(--ip-card,#fffdf8)';
const ROAD = 'var(--ip-road,#f8e2b0)';
const CORAL = '#efa28f';
const YELLOW = '#f6d27a';
const SKY = '#b7dbe5';
const GREEN = '#b9cda5';
const CAR = 'var(--ip-car,#efa28f)';

// Same stroke style as src/art.js: 3 CSS pixel round ink line.
const STROKE = `stroke="${INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"`;

function escapeAttr(value) {
  return String(value ?? '').replace(/[&<>"'`]/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;'
  })[ch]);
}

function svg(kind, width, height, body, className) {
  const cls = escapeAttr(['ip-art', `ip-art-${kind}`, className].filter(Boolean).join(' '));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="${cls}" aria-hidden="true" focusable="false" fill="none"><g ${STROKE}>${body}</g></svg>`;
}

// ---- Shared pieces ----
const star = (x, y, r = 6) => `<path class="ip-star ip-anim" d="M${x} ${y - r} L${x + r * 0.3} ${y - r * 0.3} L${x + r} ${y} L${x + r * 0.3} ${y + r * 0.3} L${x} ${y + r} L${x - r * 0.3} ${y + r * 0.3} L${x - r} ${y} L${x - r * 0.3} ${y - r * 0.3} Z" fill="${YELLOW}" stroke-width="2"/>`;
const tree = (x, base, h) => `<g class="ip-tree ip-anim"><line x1="${x}" y1="${base}" x2="${x}" y2="${base - h * 0.2}"/><path d="M${x} ${base - h} L${x + h * 0.3} ${base - h * 0.5} H${x + h * 0.15} L${x + h * 0.4} ${base - h * 0.2} H${x - h * 0.4} L${x - h * 0.15} ${base - h * 0.5} H${x - h * 0.3} Z" fill="${GREEN}"/></g>`;
const flag = (x, y, w = 12) => `<path class="ip-flag ip-anim" d="M${x} ${y} L${x + w} ${y + 4} L${x} ${y + 9} Z" fill="${CORAL}" stroke-width="2"/>`;
const flame = (x, y) => `<path class="ip-flame ip-anim" d="M${x} ${y - 18} Q${x + 12} ${y - 6} ${x + 8} ${y + 4} Q${x + 4} ${y + 10} ${x} ${y + 10} Q${x - 8} ${y + 10} ${x - 8} ${y + 2} Q${x - 8} ${y - 6} ${x} ${y - 18} Z" fill="${YELLOW}"/>`;
const steam = (x, y) => `<path class="ip-steam ip-anim" d="M${x} ${y} Q${x - 5} ${y - 6} ${x} ${y - 12} Q${x + 5} ${y - 18} ${x} ${y - 24}" stroke-width="2.5"/>`;
const arrow = (x1, y1, x2, y2) => {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const h = (d) => `${(x2 - Math.cos(a + d) * 9).toFixed(1)} ${(y2 - Math.sin(a + d) * 9).toFixed(1)}`;
  return `<path d="M${x1} ${y1} L${x2} ${y2} M${h(0.5)} L${x2} ${y2} L${h(-0.5)}"/>`;
};
const ground = (y = 80) => `<line x1="8" y1="${y}" x2="88" y2="${y}"/>`;
const tent = (cx, base, w, h, fill = CORAL) => `<path d="M${cx - w / 2} ${base} L${cx} ${base - h} L${cx + w / 2} ${base} Z" fill="${fill}"/><path d="M${cx - w * 0.12} ${base} L${cx} ${base - h * 0.45} L${cx + w * 0.12} ${base}" fill="${CARD}"/>`;


// Characters (original): a bear and a rabbit that keep the camp company. Heads are drawn at (x, y); with `body` a small
// round body in that colour sits under the head. They only use the same ink stroke and the poster palette.
const BROWN = '#d9aa7b';
const CREAM = '#f8efdc';
const BLUSH = '#f3b7ab';
const face = (x, y, r) => `<circle cx="${x - r * 0.4}" cy="${y - r * 0.12}" r="1.6" fill="${INK}" stroke="none"/><circle cx="${x + r * 0.4}" cy="${y - r * 0.12}" r="1.6" fill="${INK}" stroke="none"/><circle cx="${x - r * 0.62}" cy="${y + r * 0.28}" r="${r * 0.2}" fill="${BLUSH}" stroke="none"/><circle cx="${x + r * 0.62}" cy="${y + r * 0.28}" r="${r * 0.2}" fill="${BLUSH}" stroke="none"/>`;
const bear = (x, y, r = 14, body = '') => `${body ? `<ellipse cx="${x}" cy="${y + r * 1.35}" rx="${r * 0.8}" ry="${r * 0.7}" fill="${body}"/>` : ''}<circle cx="${x - r * 0.78}" cy="${y - r * 0.78}" r="${r * 0.38}" fill="${BROWN}"/><circle cx="${x + r * 0.78}" cy="${y - r * 0.78}" r="${r * 0.38}" fill="${BROWN}"/><circle cx="${x}" cy="${y}" r="${r}" fill="${BROWN}"/><ellipse cx="${x}" cy="${y + r * 0.36}" rx="${r * 0.48}" ry="${r * 0.36}" fill="${CREAM}" stroke-width="2"/><circle cx="${x}" cy="${y + r * 0.2}" r="1.8" fill="${INK}" stroke="none"/>${face(x, y, r)}`;
const rabbit = (x, y, r = 13, body = '') => `${body ? `<ellipse cx="${x}" cy="${y + r * 1.3}" rx="${r * 0.75}" ry="${r * 0.7}" fill="${body}"/>` : ''}<ellipse cx="${x - r * 0.45}" cy="${y - r * 1.4}" rx="${r * 0.3}" ry="${r * 0.85}" fill="${CREAM}"/><ellipse cx="${x + r * 0.45}" cy="${y - r * 1.4}" rx="${r * 0.3}" ry="${r * 0.85}" fill="${CREAM}"/><ellipse cx="${x - r * 0.45}" cy="${y - r * 1.38}" rx="${r * 0.12}" ry="${r * 0.55}" fill="${BLUSH}" stroke="none"/><ellipse cx="${x + r * 0.45}" cy="${y - r * 1.38}" rx="${r * 0.12}" ry="${r * 0.55}" fill="${BLUSH}" stroke="none"/><ellipse cx="${x}" cy="${y}" rx="${r}" ry="${r * 0.9}" fill="${CREAM}"/><circle cx="${x}" cy="${y + r * 0.22}" r="1.6" fill="${BLUSH}" stroke-width="1.5"/>${face(x, y, r)}`;
// ---- Activities (13), keyed by ACTIVITY_TYPES ----
const ACTIVITY = {
  meet: () => `${arrow(8, 48, 34, 48)}${arrow(88, 48, 62, 48)}${arrow(48, 10, 48, 30)}${arrow(48, 86, 48, 66)}<circle cx="48" cy="48" r="9" fill="${YELLOW}"/>`,
  market: () => `<path d="M30 40 Q48 6 66 40"/><path d="M14 40 H82 L74 80 H22 Z" fill="${YELLOW}"/><path d="M34 40 L36 80 M48 40 V80 M62 40 L60 80" stroke-width="2"/>`,
  camp: () => `${ground(80)}${tent(38, 80, 56, 46)}${rabbit(76, 54, 10, YELLOW)}${star(14, 18, 5)}`,
  meal: () => `<path d="M14 50 H82 Q82 80 48 80 Q14 80 14 50 Z" fill="${SKY}"/><path d="M62 10 L44 46 M74 14 L58 46"/>`,
  night: () => `<path d="M58 14 A32 32 0 1 0 84 62 A26 26 0 0 1 58 14 Z" fill="${YELLOW}"/>${star(72, 22, 7)}${star(84, 42, 5)}${star(20, 20, 5)}`,
  travel: () => `<path d="M8 82 H88" fill="none"/><path d="M12 82 L84 82" stroke="${ROAD}" stroke-width="8" opacity="0.9"/><path d="M14 66 V52 Q14 44 22 44 L32 30 H62 L74 44 Q82 44 82 52 V66 Z" fill="${CAR}"/><path d="M36 34 H46 V44 H30 Z M52 34 H60 L68 44 H52 Z" fill="${SKY}" stroke-width="2"/><circle cx="30" cy="68" r="8" fill="${CARD}"/><circle cx="66" cy="68" r="8" fill="${CARD}"/>`,
  wake: () => `${ground(66)}<path d="M26 66 A22 22 0 0 1 70 66 Z" fill="${YELLOW}"/><path d="M48 14 V26 M18 30 L26 38 M78 30 L70 38 M8 52 H18 M78 52 H88"/><path d="M20 78 H76" stroke-width="2"/>`,
  pitch: () => `${ground(80)}${tent(32, 80, 44, 38)}${rabbit(60, 58, 9, YELLOW)}<path d="M64 78 L70 62 M78 78 L84 62"/><circle cx="70" cy="60" r="3" fill="${YELLOW}" stroke-width="2"/><circle cx="84" cy="60" r="3" fill="${YELLOW}" stroke-width="2"/>`,
  free: () => `${bear(48, 34, 19, SKY)}<rect x="30" y="58" width="36" height="22" rx="6" fill="${CORAL}"/><path d="M42 58 L45 52 H51 L54 58"/><circle cx="48" cy="69" r="7" fill="${CARD}"/><circle cx="48" cy="69" r="3" fill="${SKY}" stroke-width="2"/>`,
  tea: () => `${bear(24, 32, 13, CORAL)}${rabbit(72, 36, 11, SKY)}<path d="M36 60 H60 V74 Q60 84 48 84 Q36 84 36 74 Z" fill="${CARD}"/><path d="M60 64 Q68 64 68 71 Q68 77 60 77"/>${steam(48, 56)}`,
  strike: () => `${ground(80)}<rect x="12" y="44" width="72" height="28" rx="14" fill="${CORAL}"/><ellipse cx="80" cy="58" rx="6" ry="14" fill="${CARD}"/><path d="M32 44 V72 M54 44 V72" stroke-width="2"/><path d="M40 22 L48 34 L56 22"/>`,
  clean: () => `${rabbit(32, 44, 14, SKY)}<path d="M62 18 L46 84"/><path d="M40 82 L56 78 L58 88 L42 90 Z" fill="${YELLOW}"/><path d="M66 56 Q64 80 78 82 Q92 80 90 60 Q86 54 78 56 Q72 50 66 56 Z" fill="${GREEN}"/>`,
  return: () => `<path d="M12 40 L48 10 L84 40"/><path d="M22 34 V50 M74 34 V50"/>${arrow(16, 72, 80, 72)}`
};

// ---- Stops (4), keyed by STOP_KINDS ----
const STOP = {
  shop: () => `<rect x="16" y="42" width="64" height="38" fill="${CARD}"/><path d="M10 42 L18 18 H78 L86 42 Q80 52 72 42 Q64 52 56 42 Q48 52 40 42 Q32 52 24 42 Q16 52 10 42 Z" fill="${CORAL}"/><rect x="40" y="56" width="18" height="24" fill="${SKY}"/><path d="M18 18 L22 42 M38 18 L40 42 M58 18 L56 42 M78 18 L72 42" stroke-width="2"/>`,
  pickup: () => `<circle cx="48" cy="24" r="12" fill="${YELLOW}"/><path d="M26 82 V58 Q26 42 48 42 Q70 42 70 58 V82 Z" fill="${SKY}"/><path d="M48 46 V82" stroke-width="2"/>`,
  gear: () => `<path d="M32 22 Q32 12 48 12 Q64 12 64 22"/><rect x="20" y="22" width="56" height="60" rx="16" fill="${GREEN}"/><rect x="32" y="52" width="32" height="22" rx="6" fill="${CARD}"/><path d="M32 44 H64 M20 40 Q10 44 12 62 M76 40 Q86 44 84 62" stroke-width="2"/>`,
  other: () => `<path d="M30 86 V12"/><path class="ip-flag ip-anim" d="M30 14 L74 26 L30 40 Z" fill="${CORAL}"/>`
};

// ---- Ends (3) ----
const END = {
  camp: () => `${ground(82)}${tent(34, 82, 52, 42)}<path d="M8 28 Q46 40 88 22" stroke-width="2"/>${flag(22, 33)}${flag(44, 36)}${flag(66, 32)}<path d="M62 82 L78 70 M80 82 L64 70" stroke-width="2.5"/>${flame(70, 66)}${tree(88, 82, 34)}`,
  house: () => `${ground(82)}<path d="M62 32 V16 H72 V44"/><path d="M14 46 L48 16 L82 46 Z" fill="${CORAL}"/><rect x="22" y="46" width="52" height="36" fill="${CARD}"/><rect x="40" y="58" width="16" height="24" fill="${SKY}"/><rect x="28" y="54" width="8" height="8" fill="${YELLOW}" stroke-width="2"/>${steam(67, 12)}`,
  landmark: () => `${ground(84)}<path d="M48 84 V20"/><path d="M48 24 H76 L84 32 L76 40 H48 Z" fill="${YELLOW}"/><path d="M48 50 H20 L12 58 L20 66 H48 Z" fill="${SKY}"/><circle cx="48" cy="16" r="4" fill="${CORAL}"/>`
};

function car(className) {
  return svg('car', 64, 40, `<path d="M6 30 V22 Q6 17 12 17 L18 8 H40 L50 17 Q58 17 58 24 V30 Z" class="ip-car-body" fill="${CAR}"/><path d="M21 11 H29 V17 H15 Z M34 11 H40 L46 17 H34 Z" fill="${SKY}" stroke-width="2"/><circle cx="18" cy="31" r="6" fill="${CARD}"/><circle cx="46" cy="31" r="6" fill="${CARD}"/>`, className);
}

function empty(className) {
  return svg('empty', 160, 110, `<line x1="8" y1="92" x2="152" y2="92"/>${tent(62, 92, 64, 50)}${tree(120, 92, 48)}${tree(138, 92, 34)}${star(22, 22, 7)}${star(104, 16, 6)}${star(142, 40, 5)}<path d="M36 100 Q80 106 124 100" stroke-width="2" stroke="${ROAD}"/>`, className);
}

const TABLES = { activity: [ACTIVITY, 'free'], stop: [STOP, 'other'], end: [END, 'landmark'] };

/** FNV-1a 32-bit hash of `id` mapped to a fixed value in [0, 1). */
export function fixedRandom(id) {
  let hash = 0x811c9dc5;
  const text = String(id ?? '');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 4294967296;
}

/**
 * Illustration for a kind from the fixed tables. `key` only selects a table entry (an unknown key uses the kind's
 * default) and is never written into the markup. Options: seed (dish only, a [0, 1) value), className.
 * Returns '' for an unknown kind.
 */
export function artFor(kind, key, { seed, className = '' } = {}) {
  if (kind === 'dish') {
    const value = Number.isFinite(seed) ? seed : 0;
    return dishIllustration(typeof key === 'string' ? key : 'custom', className, () => value);
  }
  if (kind === 'car') return car(className);
  if (kind === 'empty') return empty(className);
  const entry = TABLES[kind];
  if (!entry) return '';
  const [table, fallback] = entry;
  const draw = typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : table[fallback];
  return svg(kind, 96, 96, draw(), className);
}
