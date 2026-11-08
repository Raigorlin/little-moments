import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHttpHandler } from '../server/http.js';
import { parseDeploymentConfig } from '../server/deploy-config.js';

// Requirements 9.3, 9.6: one built sw.js serves both modes; the server flips the PUBLISHED flag.
const DIST = resolve(import.meta.dir, '..', process.env.CAMPING_DIST || 'dist');
const ORIGIN = 'https://www.our-littlemoments.com';
const noAccounts = { async handle() { return null; } };
const count = (text, needle) => text.split(needle).length - 1;

function readBuiltSw() {
  try { return readFileSync(join(DIST, 'sw.js'), 'utf8'); }
  catch { throw new Error(`${DIST}/sw.js is missing; run \`bun run build\` first.`); }
}

async function publishedSw() {
  const config = parseDeploymentConfig({ CAMPING_PUBLISHED: '1', CAMPING_PUBLIC_ORIGIN: ORIGIN });
  const handler = createHttpHandler({ root: DIST, accounts: noAccounts, config });
  const res = await handler(new Request(ORIGIN + '/sw.js'));
  expect(res.status).toBe(200);
  return res.text();
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
  test('starts with exactly one PUBLISHED=false flag, has the /demo guard and mode-dependent cache name', () => {
    const sw = readBuiltSw();
    expect(sw.startsWith('const PUBLISHED=false;')).toBe(true);
    expect(count(sw, 'const PUBLISHED=false;')).toBe(1);
    expect(sw).not.toContain('const PUBLISHED=true;');
    expect(sw).toContain("if(PUBLISHED&&event.request.mode==='navigate'&&/^\\/demo(?:\\/|$)/.test(url.pathname))return;");
    expect(sw).toMatch(/const CACHE='ggc-accounts-[0-9a-z]+'\+\(PUBLISHED\?'-p':''\);/);
  });

  test('Published_Mode /sw.js is rewritten to PUBLISHED=true with no false flag left', async () => {
    const sw = await publishedSw();
    expect(sw.startsWith('const PUBLISHED=true;')).toBe(true);
    expect(count(sw, 'const PUBLISHED=true;')).toBe(1);
    expect(sw).not.toContain('PUBLISHED=false');
    // Everything after the flag is byte-identical to the build output.
    expect(sw.slice('const PUBLISHED=true;'.length)).toBe(readBuiltSw().slice('const PUBLISHED=false;'.length));
  });

  test('Published_Mode worker leaves /demo navigations to the network but handles /login', async () => {
    const dispatch = loadSw(await publishedSw(), ORIGIN);
    expect(dispatch('/demo/')).toBe(false);
    expect(dispatch('/demo')).toBe(false);
    expect(dispatch('/login')).toBe(true);
    expect(dispatch('/demo-like')).toBe(true);
  });

  test('Local_Mode worker handles /demo/ navigations', () => {
    const dispatch = loadSw(readBuiltSw(), 'http://127.0.0.1:5181');
    expect(dispatch('/demo/')).toBe(true);
    expect(dispatch('/login')).toBe(true);
  });
});
