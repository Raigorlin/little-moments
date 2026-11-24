// CSS rule parser and parity checker for the schedule-tab-css-parity spec.
// parseRules flattens a stylesheet into style rules with their at-rule context.
// checkParity compares crates/web/styles/styles.css with Bun_Styles rule by rule
// and checks the position of the Scene_Motion_Layout_Rules (Requirement 1.8).

// The four static-layout rules of src/scene-motion.css (requirements glossary).
export const SCENE_MOTION_LAYOUT_CSS = [
  '.scene-motion{position:relative;display:block;line-height:0}',
  '.hero-art>.scene-motion{position:relative}',
  '.scene-motion>svg{width:100%}',
  '.hero-art .scene-motion>.countdown{left:50%;top:50%;bottom:auto;transform:translate(-50%,-50%) rotate(-6deg);line-height:1.5;z-index:1}',
].join('\n');

const baseName = (file) => String(file ?? '').split(/[\\/]/).pop();

function stripComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      out += c;
      if (c === '\\' && i + 1 < text.length) out += text[++i];
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      out += c;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      out += ' ';
    } else out += c;
  }
  return out;
}

// Splits text on a separator character that sits outside strings, parentheses and brackets.
function splitTop(text, sep) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

// Collapses whitespace outside strings and drops spaces next to the given punctuation.
function normalize(text, tight) {
  let out = '';
  let quote = null;
  let pendingSpace = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      out += c;
      if (c === '\\' && i + 1 < text.length) out += text[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (/\s/.test(c)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && out && !tight.includes(c) && !tight.includes(out[out.length - 1])) out += ' ';
    pendingSpace = false;
    if (c === '"' || c === "'") quote = c;
    out += c;
  }
  return out;
}

const normalizeSelector = (s) => normalize(s.trim(), ',>+~()');
const normalizePrelude = (s) => normalize(s.trim(), '(),:');

function normalizeDeclarations(body) {
  return splitTop(body, ';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const colon = d.indexOf(':');
      if (colon < 0) return normalize(d, '');
      const prop = d.slice(0, colon).trim();
      const value = normalize(d.slice(colon + 1).trim(), ',').replace(/\s*!\s*important$/i, '!important');
      return `${prop.startsWith('--') ? prop : prop.toLowerCase()}:${value}`;
    });
}

// Finds the index of the "}" that closes the "{" at position open.
function closingBrace(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  throw new Error(`Unbalanced "{" at offset ${open}`);
}

function hasTopLevelBlock(body) {
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '{') return true;
  }
  return false;
}

function parseBlockList(text, media, emit) {
  let i = 0;
  let quote = null;
  let depth = 0;
  let start = 0;
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ';' && depth === 0) {
      // Statement at-rule such as @import or @charset.
      const prelude = text.slice(start, i).trim();
      if (prelude) emit(media, normalizePrelude(prelude), []);
      start = i + 1;
    } else if (c === '{' && depth === 0) {
      const end = closingBrace(text, i);
      const prelude = text.slice(start, i).trim();
      const body = text.slice(i + 1, end);
      if (hasTopLevelBlock(body)) {
        parseBlockList(body, [...media, normalizePrelude(prelude)], emit);
      } else {
        const selector = prelude.startsWith('@') ? normalizePrelude(prelude) : normalizeSelector(prelude);
        emit(media, selector, normalizeDeclarations(body));
      }
      i = end;
      start = end + 1;
    }
    i++;
  }
  if (text.slice(start).trim()) throw new Error(`Unterminated rule: ${text.slice(start, start + 80).trim()}`);
}

/**
 * Parses stylesheet text into a flat list of rules in source order.
 * media is the list of enclosing at-rule preludes (outermost first), joined with " / ".
 * declarations are normalized "property:value" strings in source order.
 */
export function parseRules(text, file) {
  const rules = [];
  parseBlockList(stripComments(String(text)), [], (media, selector, declarations) => {
    rules.push({ file, index: rules.length, media: media.join(' / '), selector, declarations });
  });
  return rules;
}

const ruleKey = (r) => `${r.media}\u0000${r.selector}`;
const ruleSig = (r) => `${ruleKey(r)}\u0000${r.declarations.join(';')}`;

// Longest common subsequence of two signature arrays; returns matched [i, j] pairs.
function lcsPairs(a, b) {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ea = a.length;
  let eb = b.length;
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const pairs = [];
  for (let k = 0; k < lo; k++) pairs.push([k, k]);
  const n = ea - lo;
  const m = eb - lo;
  if (n > 0 && m > 0) {
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let x = n - 1; x >= 0; x--) {
      for (let y = m - 1; y >= 0; y--) {
        t[x * w + y] = a[lo + x] === b[lo + y]
          ? t[(x + 1) * w + y + 1] + 1
          : Math.max(t[(x + 1) * w + y], t[x * w + y + 1]);
      }
    }
    let x = 0;
    let y = 0;
    while (x < n && y < m) {
      if (a[lo + x] === b[lo + y]) { pairs.push([lo + x, lo + y]); x++; y++; }
      else if (t[(x + 1) * w + y] >= t[x * w + y + 1]) x++;
      else y++;
    }
  }
  for (let k = 0; k < a.length - ea; k++) pairs.push([ea + k, eb + k]);
  return pairs;
}

function compareStyles(bun, rust) {
  const report = [];
  const bunSig = bun.map(ruleSig);
  const rustSig = rust.map(ruleSig);
  const toRust = new Array(bun.length).fill(-1);
  const used = new Array(rust.length).fill(false);
  const kindOf = new Array(bun.length).fill(null);
  const take = (b, r, kind) => { toRust[b] = r; used[r] = true; kindOf[b] = kind; };

  for (const [b, r] of lcsPairs(bunSig, rustSig)) take(b, r, 'same');

  // Identical rules found elsewhere, then rules with the same media and selector.
  for (const [match, kind] of [[(b, r) => bunSig[b] === rustSig[r], 'same'], [(b, r) => ruleKey(bun[b]) === ruleKey(rust[r]), 'different']]) {
    for (let b = 0; b < bun.length; b++) {
      if (toRust[b] >= 0) continue;
      const r = rust.findIndex((_, k) => !used[k] && match(b, k));
      if (r >= 0) take(b, r, kind);
    }
  }

  // Remaining Bun rules pair with an unmatched Rust rule in the same gap (changed selector).
  for (let b = 0; b < bun.length; b++) {
    if (toRust[b] >= 0) continue;
    let lowR = -1;
    for (let p = b - 1; p >= 0; p--) if (toRust[p] >= 0) { lowR = toRust[p]; break; }
    let highR = rust.length;
    for (let s = b + 1; s < bun.length; s++) if (toRust[s] >= 0 && kindOf[s] !== 'gap') { highR = toRust[s]; break; }
    for (let r = lowR + 1; r < highR; r++) {
      if (!used[r] && rust[r].media === bun[b].media) { take(b, r, 'gap'); break; }
    }
  }

  // Out of order: the rule's rank among matched rules differs between the two files.
  const matched = [];
  for (let b = 0; b < bun.length; b++) if (toRust[b] >= 0) matched.push(b);
  const rustRank = new Map([...matched].sort((x, y) => toRust[x] - toRust[y]).map((b, k) => [b, k]));

  matched.forEach((b, rank) => {
    if (kindOf[b] !== 'same') report.push({ kind: 'different', rule: bun[b], expected: bun[b], actual: rust[toRust[b]] });
    if (rustRank.get(b) !== rank) report.push({ kind: 'out-of-order', rule: bun[b], expected: bun[b], actual: rust[toRust[b]] });
  });
  for (let b = 0; b < bun.length; b++) {
    if (toRust[b] < 0) report.push({ kind: 'missing', rule: bun[b], expected: bun[b], actual: null });
  }
  // Rules that Bun_Styles does not have make the files differ as well.
  rust.forEach((r, k) => {
    if (!used[k]) report.push({ kind: 'different', rule: r, expected: null, actual: r });
  });
  return report;
}

function checkSceneMotion(expected, rustSheets) {
  const report = [];
  const isBase = (r) => ['styles.css', 'accounts.css'].includes(baseName(r.file));
  let lastBase = -1;
  rustSheets.forEach((r, k) => { if (isBase(r)) lastBase = k; });
  const candidates = rustSheets.map((r, k) => ({ r, k })).filter(({ r }) => !isBase(r));

  const taken = new Set();
  const found = [];
  for (const rule of expected) {
    const sig = ruleSig(rule);
    const same = candidates.filter(({ r, k }) => !taken.has(k) && ruleSig(r) === sig);
    if (same.length === 0) {
      const near = candidates.find(({ r, k }) => !taken.has(k) && ruleKey(r) === ruleKey(rule));
      if (near) taken.add(near.k);
      report.push(near
        ? { kind: 'different', rule, expected: rule, actual: near.r }
        : { kind: 'missing', rule, expected: rule, actual: null });
      continue;
    }
    const pick = same.find(({ k }) => k > lastBase) ?? same[0];
    taken.add(pick.k);
    found.push({ rule, ...pick });
  }
  // Out of order: before the last styles.css/accounts.css rule, or not in Bun's relative order.
  const after = found.filter((f) => f.k > lastBase);
  const order = [...after].sort((x, y) => x.k - y.k);
  const misplaced = new Set([...found.filter((f) => f.k < lastBase), ...after.filter((f, rank) => order[rank] !== f)]);
  for (const f of found) {
    if (misplaced.has(f)) report.push({ kind: 'out-of-order', rule: f.rule, expected: f.rule, actual: f.r });
  }
  return report;
}

const asRules = (value, file) => (typeof value === 'string' ? parseRules(value, file) : value);

/**
 * Compares the Rust_Stylesheets with Bun_Styles and the Scene_Motion_Layout_Rules.
 * bunStyles: parsed rules (or text) of src/styles.css.
 * rustSheets: parsed rules of the Rust_Stylesheets concatenated in link order; each rule's
 *   file decides which sheet it belongs to (basename styles.css / accounts.css).
 * options.sceneMotion: overrides the expected Scene_Motion_Layout_Rules (rules or text).
 * Returns one entry per broken rule; an empty list means parity holds.
 */
export function checkParity(bunStyles, rustSheets, options = {}) {
  const bun = asRules(bunStyles, 'src/styles.css');
  const rust = rustSheets;
  const sceneMotion = asRules(options.sceneMotion ?? SCENE_MOTION_LAYOUT_CSS, 'src/scene-motion.css');
  return [
    ...compareStyles(bun, rust.filter((r) => baseName(r.file) === 'styles.css')),
    ...checkSceneMotion(sceneMotion, rust),
  ];
}

/** One readable line per report entry, for test failure output. */
export function describeEntry({ kind, rule, actual }) {
  const where = `${rule.file}#${rule.index}`;
  const media = rule.media ? `${rule.media} / ` : '';
  const text = `${media}${rule.selector}{${rule.declarations.join(';')}}`;
  const got = actual && actual !== rule ? ` (found ${actual.file}#${actual.index}: ${actual.selector}{${actual.declarations.join(';')}})` : '';
  return `${kind}: ${where} ${text}${got}`;
}
