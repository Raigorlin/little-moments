import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHttpHandler } from '../server/http.js';

// security-harden's Published_Mode (server-side PUBLISHED flag rewrite) is not part of this merge:
// scripts/build.mjs writes no deployment-mode flag and the server serves the built sw.js unchanged.
const DIST = resolve(import.meta.dir, '..', process.env.CAMPING_DIST || 'dist');
const noAccounts = { async handle() { return null; } };
const count = (text, needle) => text.split(needle).length - 1;

function readBuiltSw() {
  try { return readFileSync(join(DIST, 'sw.js'), 'utf8'); }
  catch { throw new Error(`${DIST}/sw.js is missing; run \`bun run build\` first.`); }
}

/** Evaluate sw.js with fake self/caches/fetch and return a function that dispatches a fetch event. */
function loadSw(text, origin) {
  const listeners = {};
  const self = { addEventListener: (type, fn) => { listeners[type] = fn; }, skipWaiting() {}, clients: { claim() {} } };
  const caches = { open: async () => ({ addAll: async () => {}, add: async () => {} }), keys: async () => [], delete: async () => true, match: async () => undefined };
  const fakeFetch = async () => new Response('ok');
  new Function('self', 'caches', 'fetch', 'location', text)(self, caches, fakeFetch, { origin });
  return (path, mode = 'navigate') => {
    let responded = false;
    listeners.fetch({ request: { url: origin + path, method: 'GET', mode }, respondWith: () => { responded = true; } });
    return responded;
  };
}

describe('built service worker', () => {
  test('has no Published_Mode flag: one fixed cache name and no /demo guard', () => {
    const sw = readBuiltSw();
    expect(sw).not.toContain('PUBLISHED');
    expect(sw).not.toContain('/demo');
    expect(sw.startsWith("const CACHE='ggc-accounts-")).toBe(true);
    expect(count(sw, 'const CACHE=')).toBe(1);
    expect(sw).toMatch(/^const CACHE='ggc-accounts-[0-9a-f]{12}';\n/);
  });

  test('the build script and the client have no Published_Mode flag or deployment meta tag', () => {
    const root = resolve(import.meta.dir, '..');
    const build = readFileSync(join(root, 'scripts', 'build.mjs'), 'utf8');
    expect(build).not.toContain('PUBLISHED');
    expect(build).not.toContain('swResponse');
    for (const file of ['entry.js', 'app.js', 'accounts-ui.js']) {
      const text = readFileSync(join(root, 'src', file), 'utf8');
      expect([file, text.includes('camping-deployment')]).toEqual([file, false]);
      expect([file, /published/i.test(text)]).toEqual([file, false]);
    }
  });

  test('/sw.js is served byte-identical to the build output with no-cache', async () => {
    const handler = createHttpHandler({ root: DIST, accounts: noAccounts });
    const res = await handler(new Request('http://127.0.0.1:5173/sw.js', { headers: { host: '127.0.0.1:5173' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toBe(readBuiltSw());
  });

  test('the served worker handles /demo/ and /login navigations', () => {
    const dispatch = loadSw(readBuiltSw(), 'http://127.0.0.1:5181');
    expect(dispatch('/demo/')).toBe(true);
    expect(dispatch('/login')).toBe(true);
  });
});
