import { test, expect } from 'bun:test';
import fc from 'fast-check';
import { safeNext, loginPath } from '../src/auth-paths.js';
import { escape } from '../src/model.js';
import { mapLink, googleMapsUrl } from '../src/maps.js';

// ---------- Shared generators ----------

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const HEX = '0123456789abcdef';
const ID_CHARS = LOWER + LOWER.toUpperCase() + DIGITS + '-';
const chars = alphabet => fc.constantFrom(...alphabet.split(''));

const usernameArb = fc.tuple(chars(LOWER), fc.string({ unit: chars(LOWER + DIGITS + '-'), minLength: 2, maxLength: 31 }))
  .map(([first, rest]) => first + rest);
const tripIdArb = fc.string({ unit: chars(ID_CHARS), minLength: 1, maxLength: 64 });
const inviteTokenArb = fc.string({ unit: chars(HEX), minLength: 64, maxLength: 64 });

const privatePathArb = fc.oneof(
  fc.constant('/admin'),
  inviteTokenArb.map(t => `/invite/${t}`),
  usernameArb.map(u => `/${u}/home`),
  fc.tuple(usernameArb, tripIdArb).map(([u, id]) => `/${u}/trips/${id}`),
  fc.tuple(usernameArb, tripIdArb).map(([u, id]) => `/${u}/trips/${id}/go`)
);

// Variants an attacker might send. Each one must be refused.
const unsafeVariantArb = fc.tuple(privatePathArb, fc.integer({ min: 0, max: 9 })).map(([p, kind]) => {
  switch (kind) {
    case 0: return `/${p}`;                              // '//' prefix (protocol-relative)
    case 1: return `/\\${p.slice(1)}`;                   // '/\' prefix
    case 2: return `https://evil.example${p}`;           // absolute URL
    case 3: return `javascript:alert(1)//${p}`;          // script scheme
    case 4: return `${p}?x=1`;                           // query
    case 5: return `${p}#frag`;                          // fragment
    case 6: return p.replace(/\//g, '%2F');              // percent-encoded slashes
    case 7: return ` ${p}`;                              // leading whitespace
    case 8: return `${p}\n`;                             // trailing whitespace
    default: return `${p}/`;                             // trailing slash
  }
});

// Independent oracle for the Private_Page patterns (written without the module's regex).
const allIn = (s, alphabet) => s.length > 0 && [...s].every(c => alphabet.includes(c));
const isUsername = s => s.length >= 3 && s.length <= 32 && LOWER.includes(s[0]) && allIn(s, LOWER + DIGITS + '-');
const isTripId = s => s.length >= 1 && s.length <= 64 && allIn(s, ID_CHARS);
function isPrivatePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return false;
  if (value === '/admin') return true;
  const parts = value.slice(1).split('/');
  if (parts.length === 2 && parts[0] === 'invite') return parts[1].length === 64 && allIn(parts[1], HEX);
  if (!isUsername(parts[0])) return false;
  if (parts.length === 2) return parts[1] === 'home';
  if (parts.length === 3) return parts[1] === 'trips' && isTripId(parts[2]);
  if (parts.length === 4) return parts[1] === 'trips' && isTripId(parts[2]) && parts[3] === 'go';
  return false;
}

// Feature: security-hardening, Property 2: Login return paths are limited to Private_Page patterns
test('Property 2: safeNext accepts exactly Private_Page paths and loginPath round-trips them', () => {
  // **Validates: Requirements 1.2, 1.9**
  const anyValue = fc.oneof(
    privatePathArb,
    unsafeVariantArb,
    fc.string(),
    fc.string({ unit: 'grapheme' }).map(s => `/${s}`),
    fc.constantFrom(null, undefined, 42, {}, ['/admin'], '', '/', '/login', '/ADMIN', '/admin/', '/invite/abc')
  );
  fc.assert(fc.property(anyValue, value => {
    const expected = isPrivatePath(value) ? value : null;
    expect(safeNext(value)).toBe(expected);

    const p = loginPath(value);
    const query = p.includes('?') ? p.slice(p.indexOf('?') + 1) : '';
    const next = new URLSearchParams(query).get('next');
    expect(p.startsWith('/login')).toBe(true);
    if (expected === null) {
      expect(p).toBe('/login');
      expect(next).toBeNull();
    } else {
      expect(next).toBe(value);
    }
  }), { numRuns: 300 });
  // Every generated attacker variant is refused.
  fc.assert(fc.property(unsafeVariantArb, v => safeNext(v) === null && loginPath(v) === '/login'), { numRuns: 200 });
});

// ---------- Property 13 ----------

const REFS = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#96;': '`' };
const decodeSix = s => s.replace(/&(?:amp|lt|gt|quot|#39|#96);/g, m => REFS[m]);
const XSS_PAYLOADS = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "'><svg onload=alert(1)>",
  'javascript:alert(1)', '`${alert(1)}`', '</textarea><script>alert(1)</script>'];

// Feature: security-hardening, Property 13: Escaping round trip
test('Property 13: escape removes markup characters and decodes back to the input', () => {
  // **Validates: Requirements 9.2, 9.3, 9.4, 9.5**
  const textArb = fc.oneof(
    fc.string(),
    fc.string({ unit: 'grapheme' }),
    fc.string({ unit: chars('&<>"\'`;#ampltgquo0123456789 x') }),
    fc.constantFrom(...XSS_PAYLOADS, '', '&amp;', '&lt;b&gt;', '&#96;', '日子拾光 🏕️')
  );
  fc.assert(fc.property(textArb, s => {
    const out = escape(s);
    expect(/[<>"'`]/.test(out)).toBe(false);
    // Every '&' starts one of the six references.
    const ampCount = (out.match(/&/g) || []).length;
    const refCount = (out.match(/&(?:amp|lt|gt|quot|#39|#96);/g) || []).length;
    expect(refCount).toBe(ampCount);
    expect(decodeSix(out)).toBe(s);
    // Characters other than the six are unchanged.
    expect(out.replace(/&(?:amp|lt|gt|quot|#39|#96);/g, '')).toBe(s.replace(/[&<>"'`]/g, ''));
  }), { numRuns: 1000 });

  expect(escape(null)).toBe('');
  expect(escape(undefined)).toBe('');
  fc.assert(fc.property(fc.oneof(fc.double(), fc.integer(), fc.boolean()), v => escape(v) === escape(String(v))), { numRuns: 100 });
});

// ---------- Property 14 ----------

const decodeAttr = s => decodeSix(s);
const wellFormed = s => s.isWellFormed();

// Feature: security-hardening, Property 14: Map links never carry user-chosen schemes
test('Property 14: mapLink only links to the fixed Google Maps search URL', () => {
  // **Validates: Requirements 9.7, 9.8**
  const locationArb = fc.oneof(
    fc.string(),
    fc.string({ unit: 'grapheme', maxLength: 80 }),
    fc.string({ unit: 'binary', maxLength: 40 }).filter(wellFormed),
    fc.constantFrom(...XSS_PAYLOADS, 'data:text/html,<b>x</b>', 'http://evil.example', '//evil.example', '  JavaScript:alert(1) ', '', '   ', '地'.repeat(1000)),
    fc.tuple(fc.constantFrom('javascript:', 'data:', 'http:', 'https:', '//', 'vbscript:'), fc.string()).map(([a, b]) => a + b)
  );
  fc.assert(fc.property(locationArb, location => {
    const html = mapLink(location);
    const text = location.trim();
    if (!html.includes('<a')) {
      expect(html).toBe(escape(text || '地點待確認'));
      expect(html).not.toContain('href');
      return;
    }
    expect(html.match(/<a\b/g).length).toBe(1);
    const hrefs = [...html.matchAll(/ href="([^"]*)"/g)];
    expect(hrefs.length).toBe(1);
    const href = decodeAttr(hrefs[0][1]);
    expect(href.startsWith('https://www.google.com/maps/search/')).toBe(true);
    const url = new URL(href);
    expect(url.origin).toBe('https://www.google.com');
    expect(url.searchParams.get('query')).toBe(text);
    expect(href).toBe(googleMapsUrl(location));
    const visible = html.slice(html.indexOf('>') + 1, html.indexOf('<svg'));
    expect(visible).toBe(escape(text));
  }), { numRuns: 300 });
});
