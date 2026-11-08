// Debug output, file exposure, key handling, and the database path guard (Req 7, 13, 14, 16.7, 19, 20).
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fc from 'fast-check';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createAccountService, isPublicDbPath, PublicDbPathError } from '../server/accounts.js';
import { createHttpHandler } from '../server/http.js';
import { createReceiptAi } from '../server/receipt-ai.js';
import { LOCAL_DEFAULTS } from '../server/deploy-config.js';
import { GENERIC_500, formatErrorLine } from '../server/safe-log.js';

const ROOT = resolve(import.meta.dir, '..');
const DIST = resolve(ROOT, process.env.CAMPING_DIST || 'dist');
const BASE = 'http://127.0.0.1:5173';
const PASS = 'correct horse battery';
const HTTP_500 = '伺服器暫時無法完成要求。';
const BUN = process.execPath;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/pkAAAAASUVORK5CYII=', 'base64');
const CARD = { title: '週末露營', destination: '湖邊營地', startDate: '2026-11-20', endDate: '2026-11-22', description: '', note: '', coverKind: 'lake', status: 'planning' };
const AI_MODEL = { currency: 'TWD', store: '測試商店', date: '2026-11-04', total: '50', items: [{ title: '木炭', quantity: '1', unitPrice: '50', amount: '50', category: '露營耗材', uncertain: false, warning: '' }], warnings: [] };
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const base62 = n => [...randomBytes(n)].map(b => BASE62[b % 62]).join('');
// Canary OpenAI key built at runtime so no key-shaped literal exists in the repository.
const canaryKey = () => ['sk', base62(40)].join('-');
/** True when `text` holds the key or any 8-character substring of the part after `sk-` (Req 13.2, 13.6). */
function leaksKey(text, key) {
  if (text.includes(key)) return true;
  const tail = key.slice(3);
  for (let i = 0; i + 8 <= tail.length; i++) if (text.includes(tail.slice(i, i + 8))) return true;
  return false;
}
const headerText = res => [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
const bodyText = async res => Buffer.from(await res.arrayBuffer()).toString('latin1');
const peer = { requestIP: () => ({ address: '127.0.0.1' }) };
const sessionCookie = res => (res.headers.get('set-cookie') || '').split(';')[0];

function request(handler, method, path, { cookie, body, raw, headers = {}, origin = BASE } = {}) {
  const h = { ...headers };
  if (method !== 'GET' && method !== 'HEAD' && origin) h.origin = origin;
  if (cookie) h.cookie = cookie;
  if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
  const payload = raw ?? (body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  return handler(new Request(BASE + path, { method, headers: h, body: payload }), peer);
}

/** Collects console output while `fn` runs. */
async function capture(fn) {
  const lines = [];
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const name of Object.keys(saved)) console[name] = (...args) => lines.push(args.map(String).join(' '));
  try { return { value: await fn(), lines }; } finally { Object.assign(console, saved); }
}

function filesUnder(dir) {
  const out = [];
  const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); } };
  walk(dir);
  return out;
}

const cleanEnv = extra => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('CAMPING_') && k !== 'HOST' && k !== 'PORT') env[k] = v;
  return { ...env, ...extra };
};

const temps = [];
const tempDir = prefix => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };

beforeAll(async () => {
  if (!(await Bun.file(join(DIST, 'index.html')).exists())) throw new Error('dist is missing; run `bun run build` first.');
});
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------------------------
describe('uncaught errors', () => {
  let service, routeHandler, boom = null;
  const throwingAccounts = { handle: async () => { if (boom) throw boom; return null; } };
  const httpHandler = createHttpHandler({ root: DIST, accounts: throwingAccounts, config: LOCAL_DEFAULTS });

  beforeAll(async () => {
    const dir = tempDir('camping-files-err-');
    // The clock throws while armed; the session lookup calls it, so a signed-in route handler throws.
    service = createAccountService({ dbPath: join(dir, 'accounts.sqlite'), now: () => { if (boom) throw boom; return Date.now(); } });
    routeHandler = createHttpHandler({ root: DIST, accounts: service, config: LOCAL_DEFAULTS });
    const res = await request(routeHandler, 'POST', '/api/setup', { body: { username: 'admin-one', displayName: '管理員', password: PASS } });
    if (res.status !== 200) throw new Error(`setup failed: ${res.status}`);
  });
  afterAll(() => { boom = null; service?.close(); });

  const canary = fc.stringMatching(/^[A-Za-z0-9]{12,20}$/).map(s => `cnry${s}`);
  // Error names: ordinary valid names, or canary-bearing names that the sanitizer must replace with 'Error'.
  const errorName = fc.oneof(
    fc.constantFrom('Error', 'TypeError', 'RangeError', 'SQLiteError', 'ReferenceError'),
    canary.map(c => `bad-${c}`),
    canary.map(c => `${c} with spaces`),
    fc.constant(undefined)
  );

  // Feature: security-hardening, Property 25: Uncaught errors reveal nothing
  test('Property 25: uncaught errors give the generic body and one safe log line', async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom('route', 'http'), fc.constantFrom('GET', 'POST'), errorName,
      fc.array(canary, { minLength: 8, maxLength: 8 }),
      async (source, method, name, c) => {
        const [cMsg, cPath, cSql, cStack, cProp, cQuery, cCookie, cBody] = c;
        const error = new Error(`boom ${cMsg} at /srv/app/${cPath}.js SELECT * FROM users WHERE x='${cSql}'`);
        if (name === undefined) delete error.name; else error.name = name;
        error.stack = `${error.name}: trace ${cStack}\n    at handler (/srv/app/server/${cPath}.js:1:1)`;
        error.detail = cProp;
        const path = `/api/trips?q=${cQuery}`;
        const cookie = `other=${cCookie}; ggc_session=${'ab'.repeat(32)}`;
        const handler = source === 'route' ? routeHandler : httpHandler;
        boom = error;
        let res;
        const { lines } = await capture(async () => {
          res = await request(handler, method, path, { cookie, body: method === 'POST' ? { ...CARD, note: cBody } : undefined });
        }).finally(() => { boom = null; });
        expect(res.status).toBe(500);
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({ error: source === 'route' ? GENERIC_500 : HTTP_500 });
        const head = headerText(res);
        for (const value of c) { expect(text.includes(value)).toBe(false); expect(head.includes(value)).toBe(false); }
        expect(lines.length).toBe(1);
        const line = lines[0];
        const at = Date.parse(line.split(' ')[0]);
        expect(Number.isFinite(at)).toBe(true);
        expect(line).toBe(formatErrorLine({ at, method, path: new URL(BASE + path), error }));
        expect(line.endsWith(` ${method} /api/trips ${/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name ?? '') ? name : 'Error'}`)).toBe(true);
        for (const value of c) expect(line.includes(value)).toBe(false);
      }
    ), { numRuns: 100 });
  });
});

// ---------------------------------------------------------------------------------------------
describe('static file exposure', () => {
  const handler = createHttpHandler({ root: DIST, accounts: { handle: async () => null }, config: LOCAL_DEFAULTS });
  const TARGETS = ['package.json', 'bun.lock', 'Dockerfile', 'server/accounts.js', '.secrets/openai_api_key', 'data/accounts.sqlite', '.env', '.git/config'];
  // Distinctive bytes of each project file that exists, to prove no response carries them.
  const markers = TARGETS.map(t => join(ROOT, t)).filter(p => existsSync(p) && statSync(p).isFile() && statSync(p).size >= 24)
    .map(p => readFileSync(p).subarray(0, 64).toString('latin1'));

  test('sensitive paths and case variants return 404 or 403 with no file bytes (Req 20.1)', async () => {
    const paths = ['/.env', '/.env.local', '/.secrets/openai_api_key', '/data/accounts.sqlite', '/data/accounts.sqlite-wal', '/data/accounts.sqlite-shm',
      '/package.json', '/bun.lock', '/Dockerfile', '/server/accounts.js', '/.git/config', '/.kiro/', '/.ENV', '/.Env.Local', '/PACKAGE.JSON',
      '/Server/Accounts.js', '/DATA/ACCOUNTS.SQLITE', '/.KIRO/', '/assets/../package.json', '/chunks/../server/accounts.js'];
    for (const path of paths) {
      for (const method of ['GET', 'HEAD']) {
        const res = await request(handler, method, path);
        expect({ path, method, ok: [403, 404].includes(res.status) }).toEqual({ path, method, ok: true });
        const body = await bodyText(res);
        for (const m of markers) expect(body.includes(m)).toBe(false);
      }
    }
  });

  test('non-allowlisted paths get the same status whether or not a file exists (Req 20.2)', async () => {
    const root = tempDir('camping-files-root-');
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>x</title>');
    writeFileSync(join(root, 'secret.txt'), 'should never be served');
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'a.md'), 'nope');
    const h = createHttpHandler({ root, accounts: { handle: async () => null }, config: LOCAL_DEFAULTS });
    for (const [present, missing] of [['/secret.txt', '/missing.txt'], ['/notes/a.md', '/notes/b.md']]) {
      const a = await request(h, 'GET', present), b = await request(h, 'GET', missing);
      expect(a.status).toBe(b.status);
      expect(a.status).toBe(404);
      expect(await a.text()).toBe(await b.text());
    }
  });

  const TOKENS = ['../', '%2e%2e/', '..%2f', '%2e%2e%2f', '%252e%252e%252f', '..\\', '..%5c', '%5c', '%00', '\\', '%2e%2e%5c'];
  // Feature: security-hardening, Property 26: Traversal never escapes the Build_Output
  test('Property 26: traversal never escapes the Build_Output', async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom('', 'assets/', 'chunks/', 'assets/fonts/', 'invite/'),
      fc.array(fc.constantFrom(...TOKENS), { minLength: 1, maxLength: 6 }),
      fc.constantFrom(...TARGETS),
      fc.constantFrom('GET', 'HEAD'),
      async (prefix, tokens, target, method) => {
        const path = `/${prefix}${tokens.join('')}${target}`;
        const res = await request(handler, method, path);
        expect({ path, ok: [400, 403, 404].includes(res.status) }).toEqual({ path, ok: true });
        const body = await bodyText(res);
        for (const m of markers) expect(body.includes(m)).toBe(false);
      }
    ), { numRuns: 200 });
    // Still serving after the traversal attempts.
    expect((await request(handler, 'GET', '/styles.css')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
describe('database path guard', () => {
  const PUBLIC = new Set(['dist', 'public']);
  const fold = s => process.platform === 'win32' ? s.toLowerCase() : s;
  const hasPublicSegment = p => p.split(/[\\/]+/).some(s => PUBLIC.has(s.toLowerCase()));
  const inside = (p, root) => { const r = relative(fold(root), fold(p)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
  const SEGMENTS = ['dist', 'DIST', 'Dist', 'public', 'PUBLIC', 'data', 'out', 'x', 'distro', 'republic', 'dist-old', 'node'];
  const base = process.platform === 'win32' ? 'C:\\srv\\app' : '/srv/app';
  const other = process.platform === 'win32' ? 'D:\\mnt\\real' : '/mnt/real';

  // Feature: security-hardening, Property 27: The database path guard rejects public locations
  test('Property 27: isPublicDbPath matches the reference model', () => {
    fc.assert(fc.property(
      fc.array(fc.constantFrom(...SEGMENTS), { maxLength: 4 }),
      fc.option(fc.array(fc.constantFrom(...SEGMENTS), { maxLength: 4 }), { nil: null }),
      fc.boolean(),
      (segs, realSegs, withRoot) => {
        const full = resolve(base, ...segs, 'accounts.sqlite');
        const real = realSegs === null ? full : resolve(other, ...realSegs, 'accounts.sqlite');
        const roots = withRoot ? [resolve(base, 'out'), resolve(other, 'out')] : [];
        const expected = hasPublicSegment(full) || hasPublicSegment(real) || roots.some(r => inside(full, r) || inside(real, r));
        expect(isPublicDbPath(full, real, roots)).toBe(expected);
      }
    ), { numRuns: 300 });
  });

  test('Property 27: createAccountService refuses exactly the public paths and creates nothing', () => {
    const tmp = tempDir('camping-files-db-');
    // The temp base itself must be private for this model; skip loudly if the OS put it under dist/public.
    if (hasPublicSegment(tmp)) { console.log(`skipped: temp dir ${tmp} has a dist/public segment`); return; }
    const outRoot = join(tmp, 'build-out');
    let run = 0;
    fc.assert(fc.property(
      fc.boolean(),
      fc.array(fc.constantFrom('dist', 'Public', 'data', 'x', 'distro', 'republic'), { maxLength: 3 }),
      (underRoot, segs) => {
        const runDir = join(tmp, `run-${run++}`);
        const dbPath = join(runDir, ...(underRoot ? ['site-out'] : []), ...segs, 'accounts.sqlite');
        // `underRoot` places the db inside a configured Build_Output (a public root without a dist/public name).
        const roots = underRoot ? [outRoot, join(runDir, 'site-out')] : [outRoot];
        const expected = segs.some(s => PUBLIC.has(s.toLowerCase())) || underRoot;
        let threw = null, svc = null;
        try { svc = createAccountService({ dbPath, publicRoots: roots }); } catch (error) { threw = error; } finally { svc?.close(); }
        if (expected) {
          expect(threw).toBeInstanceOf(PublicDbPathError);
          expect(threw.message).toContain('Database path is publicly servable');
          expect(existsSync(dbPath)).toBe(false);
          expect(existsSync(runDir)).toBe(false);
        } else {
          expect(threw).toBe(null);
          expect(existsSync(dbPath)).toBe(true);
        }
      }
    ), { numRuns: 100 });
  });

  test('a symlink or junction into the Build_Output or a dist directory is refused', () => {
    const tmp = tempDir('camping-files-link-');
    const out = join(tmp, 'site-out'), distDir = join(tmp, 'dist');
    mkdirSync(out); mkdirSync(distDir);
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    try {
      symlinkSync(out, join(tmp, 'link-out'), type);
      symlinkSync(distDir, join(tmp, 'link-dist'), type);
    } catch (error) {
      console.log(`skipped symlink case: the OS refused to create a ${type} (${error?.code || error?.name})`);
      return;
    }
    for (const [db, roots] of [[join(tmp, 'link-out', 'accounts.sqlite'), [out]], [join(tmp, 'link-dist', 'nested', 'accounts.sqlite'), []]]) {
      expect(() => createAccountService({ dbPath: db, publicRoots: roots })).toThrow(PublicDbPathError);
      expect(existsSync(db)).toBe(false);
    }
    expect(readdirSync(out)).toEqual([]);
    expect(readdirSync(distDir)).toEqual([]);
  });

  test('scripts/serve.mjs exits 1 before listening for a Build_Output path and a public path (Req 20.9)', async () => {
    const tmp = tempDir('camping-files-serve-');
    const out = join(tmp, 'site-out');
    const cases = [
      { CAMPING_DIST: out, CAMPING_DB: join(out, 'data', 'accounts.sqlite') },
      { CAMPING_DB: join(tmp, 'public', 'accounts.sqlite') }
    ];
    for (const extra of cases) {
      const proc = Bun.spawn([BUN, 'scripts/serve.mjs'], {
        cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
        env: cleanEnv({ PORT: '0', CAMPING_OPENAI_API_KEY_FILE: join(tmp, 'no-key'), ...extra })
      });
      const timer = setTimeout(() => proc.kill(), 20000);
      const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      clearTimeout(timer);
      expect({ code, ready: stdout.includes('Camping accounts ready') }).toEqual({ code: 1, ready: false });
      expect(stderr).toContain('Database path is publicly servable');
      expect(existsSync(extra.CAMPING_DB)).toBe(false);
      expect(existsSync(dirname(extra.CAMPING_DB))).toBe(false);
    }
  }, 60000);
});

// ---------------------------------------------------------------------------------------------
describe('static SQL check (Req 7.4, 7.5)', () => {
  const IDENT = /^[A-Za-z_$][\w$]*$/;
  const DB_RECEIVER = /^(?:db|database|sqlite|\w*Db|\w*DB)$/;

  function readQuoted(src, i) { // src[i] is the quote; returns index after the closing quote
    const q = src[i];
    for (let j = i + 1; j < src.length; j++) { if (src[j] === '\\') { j++; continue; } if (src[j] === q) return j + 1; }
    throw new Error('unterminated string');
  }
  function readTemplate(src, i) { // returns { end, exprs }
    const exprs = [];
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue; }
      if (src[j] === '`') return { end: j + 1, exprs };
      if (src[j] === '$' && src[j + 1] === '{') {
        let depth = 1, k = j + 2;
        for (; k < src.length && depth; k++) { if (src[k] === '{') depth++; else if (src[k] === '}') depth--; }
        exprs.push(src.slice(j + 2, k - 1).trim());
        j = k - 1;
      }
    }
    throw new Error('unterminated template');
  }
  /** Names of `const NAME = <string literal or interpolation-free template>` declarations. */
  function literalConstants(src) {
    const names = new Set();
    for (const m of src.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*(['"`])/g)) {
      const start = m.index + m[0].length - 1;
      if (m[2] === '`') { if (readTemplate(src, start).exprs.length === 0) names.add(m[1]); } else names.add(m[1]);
    }
    return names;
  }
  /** Each db.query/prepare/exec/run call whose SQL is not built only from literals and allowed constants. */
  function sqlViolations(src, file, constants) {
    const out = [];
    for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*(query|prepare|exec|run)\s*\(/g)) {
      if (!DB_RECEIVER.test(m[1])) continue;
      let i = m.index + m[0].length, problem = null;
      const ws = () => { while (/\s/.test(src[i] ?? '')) i++; };
      for (;;) {
        ws();
        const ch = src[i];
        if (ch === "'" || ch === '"') i = readQuoted(src, i);
        else if (ch === '`') {
          const t = readTemplate(src, i);
          const bad = t.exprs.find(e => !(IDENT.test(e) && constants.has(e)));
          if (bad !== undefined) { problem = `interpolates \${${bad}}`; break; }
          i = t.end;
        } else {
          const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))?.[0];
          if (!id || !constants.has(id)) { problem = `uses ${id ? `non-constant ${id}` : 'an expression'}`; break; }
          i += id.length;
        }
        ws();
        if (src[i] === '+') { i++; continue; }
        if (src[i] === ',' || src[i] === ')') break;
        problem = 'builds SQL with an expression'; break;
      }
      if (problem) out.push({ file, line: src.slice(0, m.index).split('\n').length, call: `${m[1]}.${m[2]}`, problem });
    }
    return out;
  }

  const FAIL_FIXTURE = [
    'export function find(db, name) {',
    '  return db.query(`SELECT * FROM users WHERE username = \'${name}\'`).get();',
    '}',
    "export const byId = (db, id) => db.query('SELECT * FROM users WHERE id = ' + id).get();"
  ].join('\n');
  const PASS_FIXTURE = [
    "const COLUMNS = 'id, username';",
    "const WHERE_LIVE = 'deleted_at IS NULL';",
    'export const find = db => db.query(`SELECT ${COLUMNS} FROM users WHERE id = ? AND ${WHERE_LIVE}`);',
    "export const all = db => db.query('SELECT ' + COLUMNS + ' FROM users').all();",
    "export const ok = (db, id) => db.query('SELECT * FROM users WHERE id = ?').get(id);"
  ].join('\n');

  test('the check fails on interpolated parameters and passes on constants', () => {
    const bad = sqlViolations(FAIL_FIXTURE, 'fail-fixture.js', literalConstants(FAIL_FIXTURE));
    expect(bad.map(v => v.line)).toEqual([2, 4]);
    expect(sqlViolations(PASS_FIXTURE, 'pass-fixture.js', literalConstants(PASS_FIXTURE))).toEqual([]);
  });

  test('every SQL call in server/ uses only literals, constants, and placeholders', () => {
    const files = readdirSync(join(ROOT, 'server')).filter(f => f.endsWith('.js')).map(f => join(ROOT, 'server', f));
    const sources = files.map(f => [relative(ROOT, f), readFileSync(f, 'utf8')]);
    const constants = new Set(sources.flatMap(([, s]) => [...literalConstants(s)]));
    const violations = sources.flatMap(([f, s]) => sqlViolations(s, f, constants));
    expect(violations).toEqual([]);
    // Sanity: the scan saw the real query calls.
    expect(sources.reduce((n, [, s]) => n + (s.match(/\bdb\.query\(/g) || []).length, 0)).toBeGreaterThan(40);
  });
});

// ---------------------------------------------------------------------------------------------
describe('OpenAI key handling', () => {
  test('a canary key never reaches responses, logs, or the database (Req 13.2, 13.4, 13.5, 13.6)', async () => {
    const key = canaryKey();
    const dir = tempDir('camping-files-key-');
    const dbPath = join(dir, 'accounts.sqlite');
    let aiMode = 'ok';
    const fetchCalls = [];
    const fetchImpl = async (url, init) => {
      fetchCalls.push({ origin: new URL(url).origin, redirect: init.redirect });
      if (aiMode === 'ok') return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(AI_MODEL) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      if (aiMode === 'error') return new Response(`upstream echo ${key}`, { status: 500, headers: { 'x-echo': key } });
      if (aiMode === 'garbage') return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: `not json ${key}` } }] }));
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    };
    const texts = [];
    const { value: ctx, lines } = await capture(async () => {
      const receiptAi = createReceiptAi({ env: { CAMPING_OPENAI_API_KEY: key }, fetchImpl, timeoutMs: 100 });
      const service = createAccountService({ dbPath, receiptAi });
      const handler = createHttpHandler({ root: DIST, accounts: service, config: LOCAL_DEFAULTS });
      const send = async (method, path, opts) => {
        const res = await request(handler, method, path, opts);
        texts.push(`${method} ${path} ${res.status}\n${headerText(res)}\n${await bodyText(res)}`);
        return res;
      };
      const setup = await send('POST', '/api/setup', { body: { username: 'admin-one', displayName: '管理員', password: PASS } });
      const cookie = sessionCookie(setup);
      const admin = JSON.parse(texts.at(-1).split('\n').slice(-1)[0]).user;
      const tripRes = await request(handler, 'POST', '/api/trips', { cookie, body: CARD });
      const trip = (await tripRes.json()).trip;
      const id = trip.id, token = 'cd'.repeat(32), inviteId = '00000000-0000-4000-8000-000000000000';
      const ai = { raw: PNG, headers: { 'content-type': 'image/png', 'x-camping-user-id': admin.id, 'x-receipt-consent': 'openai-v1' } };
      const routes = [
        ['GET', '/api/session'], ['POST', '/api/setup', { body: {} }], ['POST', '/api/login', { body: { username: 'admin-one', password: 'wrong password here' } }],
        ['POST', '/api/register', { body: {} }], ['GET', '/api/trips'], ['POST', '/api/trips', { body: {} }],
        ['GET', `/api/trips/${id}`], ['PUT', `/api/trips/${id}`, { body: {} }], ['PATCH', `/api/trips/${id}`, { body: {} }],
        ['POST', `/api/trips/${id}/check`, { body: {} }], ['GET', `/api/trips/${id}/ledger`], ['PUT', `/api/trips/${id}/ledger`, { body: {} }],
        ['GET', `/api/trips/${id}/receipt-ai`], ['GET', `/api/trips/${id}/invites`], ['POST', `/api/trips/${id}/invites`, { body: {} }],
        ['POST', `/api/trips/${id}/invites/${inviteId}/revoke`, { body: {} }], ['POST', `/api/trips/${id}/delete`, { body: {} }],
        ['GET', `/api/invites/${token}`], ['POST', `/api/invites/${token}/join`, { body: {} }], ['GET', `/api/invites/${token}/preview`],
        ['POST', `/api/invites/${token}/register`, { body: {} }], ['GET', '/api/admin/users'], ['PATCH', '/api/admin/users/nobody', { body: {} }],
        ['POST', '/api/admin/users/nobody/delete', { body: {} }], ['POST', '/api/admin/trips/nobody/delete', { body: {} }],
        ['GET', '/api/admin/audit'], ['GET', '/api/admin/settings'], ['PATCH', '/api/admin/settings', { body: {} }],
        ['GET', '/api/admin/receipt-ai-usage'], ['GET', '/api/admin/security'], ['GET', '/api/no-such-route'], ['OPTIONS', '/api/trips']
      ];
      for (const [method, path, opts = {}] of routes) {
        await send(method, path, { ...opts, cookie });
        await send(method, path, opts);
      }
      const recognized = [];
      for (const mode of ['ok', 'error', 'garbage', 'timeout']) {
        aiMode = mode;
        recognized.push((await send('POST', `/api/trips/${id}/receipt-ai`, { ...ai, cookie })).status);
      }
      const statics = ['/', '/index.html', '/login', '/entry.js', '/styles.css', '/favicon.svg', '/sw.js', '/package.json',
        ...filesUnder(DIST).map(f => '/' + relative(DIST, f).split(sep).join('/')).filter(p => /^\/(?:chunks|assets)\//.test(p))];
      for (const path of statics) await send('GET', path);
      await send('POST', '/api/logout', { cookie });
      service.close();
      return { recognized };
    });
    // The fake provider was reached for each recognition, only at the OpenAI origin and with redirects refused.
    expect(ctx.recognized[0]).toBe(200);
    expect(ctx.recognized.slice(1).every(s => s >= 400)).toBe(true);
    expect(fetchCalls.length).toBe(4);
    expect(fetchCalls.every(c => c.origin === 'https://api.openai.com' && c.redirect === 'error')).toBe(true);
    // Provider error bodies and headers are not forwarded (Req 13.4).
    expect(texts.some(t => t.includes('upstream echo') || t.includes('not json'))).toBe(false);
    expect(texts.length).toBeGreaterThan(60);
    const leaking = texts.filter(t => leaksKey(t, key)).map(t => t.split('\n')[0]);
    expect(leaking).toEqual([]);
    expect(lines.filter(l => leaksKey(l, key)).length).toBe(0);
    // Accounts_DB rows (audit, security events, usage) and the raw files hold no copy of the key.
    const raw = new Database(dbPath, { readonly: true });
    const tables = raw.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
    const dump = tables.map(t => JSON.stringify(raw.query(`SELECT * FROM "${t.replaceAll('"', '""')}"`).all())).join('\n');
    raw.close();
    expect(tables).toContain('audit');
    expect(leaksKey(dump, key)).toBe(false);
    for (const f of [dbPath, `${dbPath}-wal`]) if (existsSync(f)) expect(leaksKey(readFileSync(f).toString('latin1'), key)).toBe(false);
  }, 60000);

  test('a rotated key file is used by the next createReceiptAi (Req 13.1, 16.7)', async () => {
    const dir = tempDir('camping-files-rotate-');
    const file = join(dir, 'openai_api_key');
    const first = canaryKey(), second = canaryKey();
    let auth = null;
    const fetchImpl = async (url, init) => {
      auth = { origin: new URL(url).origin, redirect: init.redirect, value: init.headers.Authorization };
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(AI_MODEL) } }] }));
    };
    writeFileSync(file, `${first}\n`);
    const a = createReceiptAi({ env: { CAMPING_OPENAI_API_KEY_FILE: file }, fetchImpl });
    expect(a.status.enabled).toBe(true);
    await a.recognize(PNG, 'image/png');
    // Compare without printing the key on failure.
    expect(auth.value === `Bearer ${first}`).toBe(true);
    expect(auth.origin).toBe('https://api.openai.com');
    expect(auth.redirect).toBe('error');
    writeFileSync(file, `  \n${second}  \n`);
    const b = createReceiptAi({ env: { CAMPING_OPENAI_API_KEY: '', CAMPING_OPENAI_API_KEY_FILE: file }, fetchImpl });
    await b.recognize(PNG, 'image/png');
    expect(auth.value === `Bearer ${second}`).toBe(true);
    expect(JSON.stringify(b.status).includes(second.slice(3, 11))).toBe(false);
  });

  test('src/ has no OpenAI host and no key variable read (Req 13.9)', () => {
    const files = filesUnder(join(ROOT, 'src'));
    expect(files.length).toBeGreaterThan(5);
    const hits = files.filter(f => /api\.openai\.com|CAMPING_OPENAI_API_KEY/.test(readFileSync(f, 'latin1'))).map(f => relative(ROOT, f));
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('fresh build into a temporary CAMPING_DIST', () => {
  test('no maps, no forbidden files, no OCR, PUBLISHED literal, and no canary from the environment (Req 13.3, 14.3, 14.4, 19.4, 19.9, 20.4)', async () => {
    const out = join(tempDir('camping-files-build-'), 'out');
    const names = ['CAMPING_OPENAI_API_KEY', 'CAMPING_OPENAI_API_KEY_FILE', 'CAMPING_OPENAI_MODEL_ID', 'CAMPING_DB', 'CAMPING_PUBLIC_ORIGIN',
      'CAMPING_PUBLISHED', 'CAMPING_TRUSTED_PROXIES', 'CAMPING_REGISTRATION', 'CAMPING_RECEIPT_AI_POLICY', 'CAMPING_SESSION_SECRET',
      'CAMPING_RECEIPT_AI_DAILY_LIMIT', 'CAMPING_RECEIPT_AI_MONTHLY_LIMIT', 'CAMPING_RECEIPT_AI_USER_LIMIT'];
    const canaries = Object.fromEntries(names.map(n => [n, n === 'CAMPING_OPENAI_API_KEY' ? canaryKey() : `cnry${base62(24)}`]));
    const proc = Bun.spawn([BUN, 'scripts/build.mjs'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: cleanEnv({ ...canaries, CAMPING_DIST: out }) });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect({ code, stderr: code === 0 ? '' : stderr.slice(0, 2000) }).toEqual({ code: 0, stderr: '' });
    for (const value of Object.values(canaries)) expect(stdout.includes(value) || stderr.includes(value)).toBe(false);

    const files = filesUnder(out);
    const rel = files.map(f => relative(out, f).split(sep).join('/'));
    expect(rel).toContain('index.html');
    expect(rel).toContain('sw.js');
    expect(rel.filter(p => p.endsWith('.map'))).toEqual([]);
    expect(rel.filter(p => p.startsWith('assets/ocr/'))).toEqual([]);
    const forbidden = p => {
      const parts = p.split('/'), name = parts.at(-1).toLowerCase();
      return parts.slice(0, -1).some(d => ['.secrets', '.git', '.kiro', 'server'].includes(d.toLowerCase()))
        || name === '.env' || name.startsWith('.env.') || /\.(?:sqlite|sqlite-wal|sqlite-shm|db|pem|key|p12|pfx)$/.test(name)
        || name === 'package.json' || name === 'bun.lock';
    };
    expect(rel.filter(forbidden)).toEqual([]);
    expect(readFileSync(join(out, 'sw.js'), 'utf8').startsWith('const PUBLISHED=false;')).toBe(true);
    const offenders = [];
    for (const [i, f] of files.entries()) {
      const text = readFileSync(f).toString('latin1');
      if (text.includes('sourceMappingURL')) offenders.push(`${rel[i]}: sourceMappingURL`);
      if (/api\.openai\.com|CAMPING_OPENAI_API_KEY/.test(text)) offenders.push(`${rel[i]}: OpenAI reference`);
      for (const [name, value] of Object.entries(canaries)) {
        if (name === 'CAMPING_OPENAI_API_KEY' ? leaksKey(text, value) : text.includes(value)) offenders.push(`${rel[i]}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  }, 120000);
});
