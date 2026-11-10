// Feature: jenkins-cicd-deploy, Property 38: 映像內容檢查
// **Validates: Requirements 15.5, 16.2, 16.4, 16.9**
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { imageContentCheck, normalizePath, parseImageUser } from '../ci/image-content-check.mjs';

// ---------------------------------------------------------------------------
// 產生器：以結構化方式產生路徑（段落 + 是否為目錄），再轉為 `tar -t` 風格字串。
// ---------------------------------------------------------------------------

const DIR_POOL = [
  'server', 'dist', 'migrations', 'assets', 'lib', 'data', 'tests', 'src', 'node_modules',
  'fast-check', 'fast-checker', '@playwright', 'test', 'playwright', 'playwright-core',
  '@types', 'bun', 'tests-old', 'source', 'database', 'srcs',
];
const FILE_POOL = [
  'serve.js', 'index.html', 'package.json', 'readme.md', '.env', '.env.local', '.envrc', 'env',
  'accounts.sqlite', 'x.sqlite-wal', 'db.sqlite3', 'store.db', 'STORE.DB', '.db', 'dbx',
  'cert.pem', 'server.KEY', 'a.p12', 'b.pfx', 'c.crt', '.pem', 'crt', 'src', 'tests', 'data',
];
// 基底映像的系統路徑：只有 `.env*`／`*.sqlite*` 規則適用。
const SYSTEM_ROOTS = [
  ['etc', 'ssl', 'certs'], ['usr', 'src', 'linux'], ['var', 'lib', 'data'], ['home', 'tests'],
  ['opt', 'app'], ['usr', 'lib', 'node_modules'], ['application'],
];
// devDependency 候選：含 scoped、無 scope，及會被模組過濾掉的非法名稱。
const DEV_DEP_POOL = ['fast-check', '@playwright/test', 'playwright', 'playwright-core', '@types/bun', '@scope', '', 'a/b/c'];

const prefixArb = fc.constantFrom('', './', '/');
const dirs = (max) => fc.array(fc.constantFrom(...DIR_POOL), { maxLength: max });

// 一般路徑：根目錄為 app 或系統路徑，接隨機目錄，最後為檔案或目錄。
const genericEntry = fc.record({
  root: fc.oneof(fc.constant(['app']), fc.constantFrom(...SYSTEM_ROOTS)),
  mid: dirs(4),
  leaf: fc.option(fc.constantFrom(...FILE_POOL), { nil: null }),
}).map(({ root, mid, leaf }) => ({
  segs: leaf === null ? [...root, ...mid] : [...root, ...mid, leaf],
  isDir: leaf === null,
}));

// devDependency 套件路徑（含巢狀 node_modules 與相近名稱）。
const pkgEntry = fc.record({
  nested: fc.boolean(),
  pkg: fc.constantFrom('fast-check', 'fast-checker', '@playwright/test', '@playwright/testing', 'playwright', 'playwright-core', '@types/bun', 'left-pad'),
  tail: fc.option(fc.constantFrom('index.js', 'package.json', 'src/index.js'), { nil: null }),
}).map(({ nested, pkg, tail }) => {
  const segs = ['app', 'node_modules', ...(nested ? ['host-pkg', 'node_modules'] : []), ...pkg.split('/')];
  if (tail) segs.push(...tail.split('/'));
  return { segs, isDir: tail === null };
});

// 特殊項目：根目錄本身、`./`、空字串。
const specialEntry = fc.constantFrom(
  { raw: './' }, { raw: '' }, { raw: './app/' }, { raw: 'app' }, { raw: '/app/' },
);

const entryArb = fc.oneof(
  { weight: 5, arbitrary: genericEntry },
  { weight: 2, arbitrary: pkgEntry },
  { weight: 1, arbitrary: specialEntry },
).chain(e => (e.raw !== undefined ? fc.constant(e) : prefixArb.map(p => ({
  ...e,
  raw: p + e.segs.join('/') + (e.isDir ? '/' : ''),
}))));

// passwd 內容與使用者字串。
const passwdArb = fc.option(
  fc.uniqueArray(
    fc.record({ name: fc.constantFrom('root', 'app', 'bun', 'nobody', 'svc'), uid: fc.constantFrom(0, 1000, 10001, 65534), gid: fc.constantFrom(0, 1000, 10001, 65534) }),
    { selector: e => e.name, maxLength: 4 },
  ),
  { nil: undefined },
);

const userArb = fc.oneof(
  fc.constant(''),
  fc.constantFrom('0', '1000', '10001', '65534', '42'),
  fc.tuple(fc.constantFrom('0', '10001', '1000'), fc.constantFrom('0', '10001', 'staff', '')).map(([u, g]) => `${u}:${g}`),
  fc.constantFrom('root', 'app', 'bun', 'nobody', 'ghost'),
  fc.tuple(fc.constantFrom('app', 'root', 'ghost'), fc.constantFrom('0', '10001', 'staff')).map(([u, g]) => `${u}:${g}`),
);

// ---------------------------------------------------------------------------
// 獨立 oracle：依需求逐條陳述規則。
// ---------------------------------------------------------------------------

function oracleSegments(raw) {
  return String(raw).trim().split('/').filter(s => s !== '' && s !== '.');
}

function oracleUser(user, entries) {
  const text = user.trim();
  if (text === '') return { uid: 0, gid: 0 };
  const idx = text.indexOf(':');
  const u = idx === -1 ? text : text.slice(0, idx);
  const g = idx === -1 ? undefined : text.slice(idx + 1);
  const num = s => (/^\d+$/.test(s) ? Number(s) : null);
  const byUid = num(u) !== null ? (entries ?? []).find(e => e.uid === num(u)) : null;
  const byName = num(u) === null ? (entries ?? []).find(e => e.name === u) : null;
  const entry = byUid ?? byName ?? null;
  const uid = num(u) !== null ? num(u) : entry ? entry.uid : null;
  const gid = g !== undefined ? num(g) : entry ? entry.gid : null;
  return { uid, gid };
}

function oracle(rawFiles, user, devDeps, entries) {
  const pkgs = devDeps
    .filter(n => /^[^@/][^/]*$/.test(n) || /^@[^/]+\/[^/]+$/.test(n))
    .map(n => n.split('/'));
  const out = new Map();
  const add = (path, rule) => out.set(`${rule}|${path}`, { path, rule });
  let inAppCount = 0;

  for (const raw of rawFiles) {
    const segs = oracleSegments(raw);
    if (segs.length === 0) continue;
    const path = segs.join('/');
    const name = segs[segs.length - 1];
    const isDir = String(raw).trim().endsWith('/');

    // 全映像：.env* 與 *.sqlite*
    if (/^\.env(\..*)?$/.test(name)) add(path, 'env-file');
    if (/\.sqlite/i.test(name)) add(path, 'database-file');

    if (segs[0] !== 'app' || segs.length < 2) continue;
    inAppCount += 1;
    const rel = segs.slice(1);

    if (/^.+\.(pem|key|p12|pfx|crt)$/i.test(name)) add(path, 'certificate-file');
    if (/^.+\.(db|sqlite|sqlite3)$/i.test(name)) add(path, 'database-file');

    // 目錄成分（不含檔案本身），在第一個 node_modules 處截斷。
    const nmAt = rel.indexOf('node_modules');
    const dirParts = nmAt >= 0 ? rel.slice(0, nmAt) : isDir ? rel : rel.slice(0, -1);
    const hit = dirParts.findIndex(s => s === 'data' || s === 'tests' || s === 'src');
    if (hit >= 0) add(`app/${rel.slice(0, hit + 1).join('/')}/`, `forbidden-dir:${rel[hit]}`);

    rel.forEach((s, i) => {
      if (s !== 'node_modules') return;
      for (const p of pkgs) {
        const slice = rel.slice(i + 1, i + 1 + p.length);
        if (slice.length === p.length && slice.join('/') === p.join('/')) {
          add(`app/${rel.slice(0, i + 1 + p.length).join('/')}/`, `dev-dependency:${p.join('/')}`);
        }
      }
    });
  }

  const v = [...out.values()];
  if (inAppCount === 0) v.push({ field: 'files', rule: 'app-root-missing' });
  const { uid, gid } = oracleUser(user, entries);
  if (uid === null) v.push({ field: 'Config.User', rule: 'uid-unresolved' });
  else if (uid === 0) v.push({ field: 'Config.User', rule: 'uid-root' });
  if (gid === null) v.push({ field: 'Config.User', rule: 'gid-unresolved' });
  else if (gid === 0) v.push({ field: 'Config.User', rule: 'gid-root' });
  return v;
}

const key = v => JSON.stringify([v.rule, v.path ?? null, v.field ?? null]);
const asSet = list => [...new Set(list.map(key))].sort();

describe('Property 38: 映像內容檢查', () => {
  test('通過若且唯若無違規，且違規集合（路徑＋規則）與 oracle 完全相同', () => {
    fc.assert(
      fc.property(
        fc.array(entryArb, { maxLength: 25 }),
        userArb,
        fc.subarray(DEV_DEP_POOL),
        passwdArb,
        fc.constantFrom(undefined, 'app', '/app/', './app'),
        (entries, user, devDeps, pw, appRoot) => {
          const files = entries.map(e => e.raw);
          const passwd = pw === undefined
            ? undefined
            : ['# comment', ...pw.map(e => `${e.name}:x:${e.uid}:${e.gid}::/home/${e.name}:/bin/sh`), 'broken:line'].join('\n');
          const options = { passwd };
          if (appRoot !== undefined) options.appRoot = appRoot;

          const result = imageContentCheck(files, user, devDeps, options);
          const expected = oracle(files, user, devDeps, pw);

          expect(asSet(result.violations)).toEqual(asSet(expected));
          expect(result.violations.length).toBe(new Set(result.violations.map(key)).size);
          expect(result.ok).toBe(expected.length === 0);
        },
      ),
      { numRuns: 300 },
    );
  });

  test('乾淨的 app 映像與非 root 使用者通過；系統路徑憑證不視為違規', () => {
    const files = ['./', './app/', './app/server/serve.js', './app/dist/index.html', 'etc/ssl/certs/ca.crt', 'usr/src/', 'app/node_modules/left-pad/index.js'];
    expect(imageContentCheck(files, '10001:10001', ['fast-check'])).toEqual({ ok: true, violations: [] });
  });

  test('app 內 src/、devDependency 與 .env 皆被列出', () => {
    const r = imageContentCheck(['/app/src/model.js', 'app/node_modules/@playwright/test/', 'app/.env'], '', ['@playwright/test']);
    expect(asSet(r.violations)).toEqual(asSet([
      { path: 'app/src/', rule: 'forbidden-dir:src' },
      { path: 'app/node_modules/@playwright/test/', rule: 'dev-dependency:@playwright/test' },
      { path: 'app/.env', rule: 'env-file' },
      { field: 'Config.User', rule: 'uid-root' },
      { field: 'Config.User', rule: 'gid-root' },
    ]));
  });

  test('normalizePath 與 parseImageUser 基本行為', () => {
    expect(normalizePath('./app//dist/')).toEqual(['app', 'dist']);
    expect(normalizePath('./')).toBeNull();
    expect(parseImageUser('app', 'app:x:10001:10001::/:/bin/sh')).toEqual({ uid: 10001, gid: 10001 });
    expect(parseImageUser('ghost', undefined)).toEqual({ uid: null, gid: null });
  });
});
