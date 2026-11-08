// Pure secret detection rules for scripts/scan-secrets.mjs (Requirement 15).
// No filesystem or process access. The patterns below are written so that this
// file's own source text does not match them; do not add literal example secrets.

export const MIN_SECRET_LENGTH = 20;
export const MIN_ENTROPY = 3.5;

// Names that make an assignment worth an entropy check (case-insensitive).
const SECRET_NAME = '[A-Za-z0-9_.-]*(?:key|secret|token|password)[A-Za-z0-9_.-]*';
// Value characters for the assignment rule. The dot is left out on purpose so that
// property chains such as process.env.X split into short pieces.
const VALUE_CHARS = '[A-Za-z0-9+/=_~-]';

const highEntropyValue = value =>
  value.length >= MIN_SECRET_LENGTH &&
  /[0-9]/.test(value) &&
  /[A-Za-z]/.test(value) &&
  !/^[A-Z0-9_]+$/.test(value) && // environment variable names and constants
  shannonEntropy(value) >= MIN_ENTROPY;

// `group` names the capture group holding the secret part of the match (0 = whole match).
// `generic` rules are suppressed where a specific rule already reported the same span.
export const RULES = Object.freeze([
  { id: 'openai-key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, group: 0 },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, group: 0 },
  { id: 'pem-private-key', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g, group: 0 },
  { id: 'bearer-token', re: /Bearer ([A-Za-z0-9._~+/=-]{20,})/g, group: 1 },
  { id: 'url-credentials', re: /[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@/gi, group: 1 },
  {
    id: 'high-entropy-assignment',
    re: new RegExp(`(${SECRET_NAME})["']?\\s*[:=]{1,2}\\s*["'\`]?(${VALUE_CHARS}{${MIN_SECRET_LENGTH},})`, 'gi'),
    group: 2,
    generic: true,
    accept: highEntropyValue
  }
].map(rule => Object.freeze(rule)));

export const RULE_IDS = Object.freeze(RULES.map(rule => rule.id));

/** Shannon entropy of a string in bits per character (by code point). */
export function shannonEntropy(text) {
  const chars = [...String(text ?? '')];
  if (chars.length === 0) return 0;
  const counts = new Map();
  for (const ch of chars) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / chars.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Redacted_Value: first 4 + '…' + last 4 for 16 or more characters, else '[redacted]'. */
export function redact(value) {
  const chars = [...String(value ?? '')];
  if (chars.length < 16) return '[redacted]';
  return `${chars.slice(0, 4).join('')}…${chars.slice(-4).join('')}`;
}

/**
 * Scan text and return findings `{ path, line, rule, redacted }` with 1-based lines.
 * Each finding also carries a non-enumerable `value` (the secret part) so the caller
 * can match exact-value allowlist entries; it never shows up in JSON or console output.
 */
export function scanText(text, { path = '' } = {}) {
  const findings = [];
  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((lineText, index) => {
    const spans = [];
    for (const rule of RULES) {
      for (const match of lineText.matchAll(new RegExp(rule.re.source, rule.re.flags))) {
        const value = match[rule.group];
        if (!value) continue;
        if (rule.accept && !rule.accept(value)) continue;
        const start = rule.group === 0 ? match.index : match.index + match[0].lastIndexOf(value);
        const end = start + value.length;
        if (rule.generic && spans.some(s => start < s.end && s.start < end)) continue;
        spans.push({ start, end });
        const finding = { path, line: index + 1, rule: rule.id, redacted: redact(value) };
        Object.defineProperty(finding, 'value', { value, enumerable: false });
        findings.push(finding);
      }
    }
  });
  return findings;
}

export class AllowlistError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AllowlistError';
  }
}

const normalizePath = p => String(p).replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Parse the allowlist JSON (string or parsed value) of the form
 * `{ "entries": [ { "value", "reason" } | { "rule", "path", "reason" } ] }`.
 * A `path` ending in `/` matches every file below that directory.
 * Throws AllowlistError naming the invalid entry by index (values are never printed).
 */
export function parseAllowlist(json) {
  let data = json;
  if (typeof json === 'string') {
    try {
      data = JSON.parse(json);
    } catch {
      throw new AllowlistError('Allowlist is not valid JSON.');
    }
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.entries)) {
    throw new AllowlistError('Allowlist must be an object with an "entries" array.');
  }
  const entries = data.entries.map((entry, i) => {
    const where = `Allowlist entry ${i}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new AllowlistError(`${where} is not an object.`);
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') throw new AllowlistError(`${where} has a missing or empty reason.`);
    const reason = entry.reason.trim();
    if (entry.value !== undefined) {
      if (typeof entry.value !== 'string' || entry.value === '') throw new AllowlistError(`${where} has an empty or non-string value.`);
      return Object.freeze({ value: entry.value, reason });
    }
    if (typeof entry.rule !== 'string' || !RULE_IDS.includes(entry.rule)) throw new AllowlistError(`${where} needs a "value" or a known "rule".`);
    if (typeof entry.path !== 'string' || entry.path.trim() === '') throw new AllowlistError(`${where} needs a non-empty "path" with its rule.`);
    return Object.freeze({ rule: entry.rule, path: normalizePath(entry.path.trim()), reason });
  });
  return Object.freeze({ entries: Object.freeze(entries) });
}

/** True when a finding from scanText matches an entry of a parsed allowlist. */
export function isAllowlisted(finding, allowlist) {
  const path = normalizePath(finding.path ?? '');
  return (allowlist?.entries ?? []).some(entry =>
    entry.value !== undefined
      ? entry.value === finding.value
      : entry.rule === finding.rule && (entry.path.endsWith('/') ? path.startsWith(entry.path) : path === entry.path));
}
