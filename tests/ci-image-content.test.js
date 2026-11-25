// Feature: jenkins-cicd-deploy, Property 38: 映像內容檢查（Rust 版 App_Image；plan.md D4）
// **Validates: Requirements 15.5, 16.2, 16.4, 16.9**
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { imageContentCheck, normalizePath, parseEntry, parseImageUser } from '../ci/image-content-check.mjs';

// ---------------------------------------------------------------------------
// 產生器：以結構化方式產生項目（段落、類型、權限、擁有者），再轉為 `tar -tv --numeric-owner` 或 `tar -t` 的行。
// ---------------------------------------------------------------------------

const DIR_POOL = [
  'bin', 'dist', 'migrations', 'assets', 'fonts', 'crates', 'target', 'src', 'tests', 'node_modules', 'data',
  'crate', 'targets', 'source', 'test', 'database',
];
const FILE_POOL = [
  'little-moments-server', 'index.html', 'lm-web-1a2b_bg.wasm', 'lm-web-1a2b.js', '20260101000000_app_schema.sql',
  'robots.txt', 'main.rs', 'lib.RS', '.rs', 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'Trunk.toml',
  'package.json', 'cargo.toml', 'bun', 'bunx', 'bun.lock', 'bun.lockb', 'bunfig.toml', 'bundle.js',
  '.env', '.env.local', '.envrc', 'accounts.sqlite', 'x.sqlite-wal', 'store.db', 'STORE.DB', '.db',
  'cert.pem', 'server.KEY', 'a.p12', 'b.pfx', 'c.crt', '.pem', 'notes.sql', 'x.wasm',
];
// 基底映像的系統路徑：只有整個映像的規則（.env*、*.sqlite*、bun）適用。
const SYSTEM_ROOTS = [['etc', 'ssl', 'certs'], ['usr', 'local', 'bin'], ['var', 'lib', 'data'], ['home', 'nonroot'], ['application'], ['opt', 'app']];
const MODES = ['r--r--r--', 'r-xr-xr-x', 'rw-r--r--', 'rwxr-xr-x', 'rw-rw-r--', 'rw-r--rw-', 'r-xr-xr--', 'r-xr-xr-t', 'rwxrwxrwx'];
const OWNERS = ['0/0', '0/0', 'root/root', '65532/65532', '0/65532', '1000/0'];

const prefixArb = fc.constantFrom('', './', '/');
const entryArb = fc.record({
  root: fc.oneof({ weight: 3, arbitrary: fc.constant(['app']) }, { weight: 1, arbitrary: fc.constantFrom(...SYSTEM_ROOTS) }),
  mid: fc.array(fc.constantFrom(...DIR_POOL), { maxLength: 3 }),
  leaf: fc.option(fc.constantFrom(...FILE_POOL), { nil: null }),
  type: fc.constantFrom('-', '-', '-', 'l', 'h'),
  mode: fc.constantFrom(...MODES),
  owner: fc.constantFrom(...OWNERS),
  verbose: fc.oneof({ weight: 9, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
  prefix: prefixArb,
}).map((e) => {
  const isDir = e.leaf === null;
  const segs = isDir ? [...e.root, ...e.mid] : [...e.root, ...e.mid, e.leaf];
  const type = isDir ? 'd' : e.type;
  const path = e.prefix + segs.join('/') + (isDir ? '/' : '');
  const suffix = type === 'l' ? ' -> ../target' : type === 'h' ? ' link to app/other' : '';
  const raw = e.verbose ? `${type}${e.mode} ${e.owner}        1234 2026-11-25 10:00 ${path}${suffix}` : path;
  return { raw, segs, isDir, type: e.verbose ? type : null, mode: e.verbose ? e.mode : null, owner: e.verbose ? e.owner : null };
});
const specialArb = fc.constantFrom(
  { raw: './' }, { raw: '' }, { raw: 'drwxr-xr-x 0/0 0 2026-11-25 10:00 ./app/' }, { raw: 'app' }, { raw: '/app/' },
);
const listArb = fc.array(fc.oneof({ weight: 8, arbitrary: entryArb }, { weight: 1, arbitrary: specialArb }), { maxLength: 25 });

// 必要檔案：多數情況下加入，使違規集合不只剩 missing:*。
const REQUIRED_LINES = [
  '-r-xr-xr-x 0/0 9999 2026-11-25 10:00 app/bin/little-moments-server',
  '-r--r--r-- 0/0 900 2026-11-25 10:00 app/dist/index.html',
  '-r--r--r-- 0/0 900 2026-11-25 10:00 app/dist/lm-web-1a2b_bg.wasm',
  '-r--r--r-- 0/0 900 2026-11-25 10:00 app/migrations/20260101000000_app_schema.sql',
];
const requiredArb = fc.subarray(REQUIRED_LINES);

const passwdArb = fc.option(
  fc.uniqueArray(
    fc.record({ name: fc.constantFrom('root', 'nonroot', 'nobody', 'svc'), uid: fc.constantFrom(0, 1000, 65532, 65534), gid: fc.constantFrom(0, 1000, 65532, 65534) }),
    { selector: (e) => e.name, maxLength: 4 },
  ),
  { nil: undefined },
);
const userArb = fc.oneof(
  fc.constant(''),
  fc.constantFrom('0', '1000', '65532', '65534'),
  fc.tuple(fc.constantFrom('0', '65532', '1000'), fc.constantFrom('0', '65532', '1000', 'staff')).map(([u, g]) => `${u}:${g}`),
  fc.constantFrom('root', 'nonroot', 'ghost'),
  fc.tuple(fc.constantFrom('nonroot', 'root', 'ghost'), fc.constantFrom('0', '65532', 'staff')).map(([u, g]) => `${u}:${g}`),
);

// ---------------------------------------------------------------------------
// 獨立 oracle：依規則逐條陳述。
// ---------------------------------------------------------------------------

const VERBOSE_RE = /^([-dlh])([-rwxt]{9}) (\S+)\/(\S+)\s+\d+ \S+ \S+ (.*)$/;

function oracleEntry(raw) {
  const m = VERBOSE_RE.exec(raw);
  const path = m ? m[5].replace(/ -> .*$| link to .*$/, '') : raw;
  const segs = path.trim().split('/').filter((s) => s !== '' && s !== '.');
  if (!segs.length) return null;
  return {
    segs, isDir: m ? m[1] === 'd' : path.trim().endsWith('/'), type: m?.[1] ?? null, mode: m?.[2] ?? null,
    ownerRoot: m ? ['0', 'root'].includes(m[3]) && ['0', 'root'].includes(m[4]) : null,
  };
}

function oracleUser(user, entries) {
  const text = user.trim();
  if (text === '') return { uid: 0, gid: 0 };
  const idx = text.indexOf(':');
  const u = idx === -1 ? text : text.slice(0, idx);
  const g = idx === -1 ? undefined : text.slice(idx + 1);
  const num = (s) => (/^\d+$/.test(s) ? Number(s) : null);
  const entry = num(u) !== null ? (entries ?? []).find((e) => e.uid === num(u)) : (entries ?? []).find((e) => e.name === u);
  const uid = num(u) !== null ? num(u) : entry ? entry.uid : null;
  const gid = g !== undefined ? num(g) : entry ? entry.gid : null;
  return { uid, gid };
}

function oracle(rawFiles, user, entries) {
  const out = new Map();
  const add = (path, rule) => out.set(`${rule}|${path}`, { path, rule });
  const fields = new Map();
  const addField = (field, rule) => fields.set(`${rule}|${field}`, { field, rule });
  let inApp = 0;
  const have = { server: false, index: false, wasm: false, sql: false };

  for (const raw of rawFiles) {
    const e = oracleEntry(raw);
    if (!e) continue;
    const path = e.segs.join('/');
    const name = e.segs.at(-1);
    if (!e.isDir) {
      if (/^\.env(\..*)?$/.test(name)) add(path, 'env-file');
      if (/\.sqlite/i.test(name)) add(path, 'database-file');
      if (['bun', 'bunx', 'bun.lock', 'bun.lockb', 'bunfig.toml'].includes(name)) add(path, 'bun-file');
    }
    if (e.segs[0] !== 'app' || e.segs.length < 2) continue;
    inApp += 1;
    const rel = e.segs.slice(1);
    const relPath = rel.join('/');
    if (!e.isDir) {
      if (relPath === 'bin/little-moments-server') have.server = true;
      if (relPath === 'dist/index.html') have.index = true;
      if (/^dist\/[^/]+\.wasm$/.test(relPath)) have.wasm = true;
      if (/^migrations\/[^/]+\.sql$/.test(relPath)) have.sql = true;
      if (/^.+\.(pem|key|p12|pfx|crt)$/i.test(name)) add(path, 'certificate-file');
      if (/^.+\.(db|sqlite|sqlite3)$/i.test(name)) add(path, 'database-file');
      if (/^.+\.rs$/i.test(name) || ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'Trunk.toml', 'package.json'].includes(name)) add(path, 'source-file');
    }
    const dirParts = e.isDir ? rel : rel.slice(0, -1);
    const hit = dirParts.findIndex((s) => ['crates', 'target', 'src', 'tests', 'node_modules', 'data'].includes(s));
    if (hit >= 0) add(`app/${rel.slice(0, hit + 1).join('/')}/`, `forbidden-dir:${rel[hit]}`);
    if (e.mode === null) addField('files', 'mode-missing');
    else if (e.type !== 'l') {
      if (!e.ownerRoot) add(path, 'owner-not-root');
      if (e.mode[4] === 'w' || e.mode[7] === 'w') add(path, 'writable');
      if (!e.isDir && relPath === 'bin/little-moments-server' && !/[xt]/.test(e.mode[8])) add(path, 'server-not-executable');
    }
  }
  if (inApp === 0) addField('files', 'app-root-missing');
  else {
    if (!have.server) addField('files', 'missing:server-binary');
    if (!have.index) addField('files', 'missing:index-html');
    if (!have.wasm) addField('files', 'missing:wasm');
    if (!have.sql) addField('files', 'missing:migration');
  }
  const v = [...out.values(), ...fields.values()];
  const { uid, gid } = oracleUser(user, entries);
  if (uid === null) v.push({ field: 'Config.User', rule: 'uid-unresolved' });
  else if (uid === 0) v.push({ field: 'Config.User', rule: 'uid-root' });
  else if (uid !== 65532) v.push({ field: 'Config.User', rule: 'uid-unexpected' });
  if (gid === null) v.push({ field: 'Config.User', rule: 'gid-unresolved' });
  else if (gid === 0) v.push({ field: 'Config.User', rule: 'gid-root' });
  else if (gid !== 65532) v.push({ field: 'Config.User', rule: 'gid-unexpected' });
  return v;
}

const key = (v) => JSON.stringify([v.rule, v.path ?? null, v.field ?? null]);
const asSet = (list) => [...new Set(list.map(key))].sort();

// 由 Dockerfile 建出的映像的典型清單（distroless cc-debian13 + /app）。
const CLEAN = [
  'drwxr-xr-x 0/0 0 2026-11-25 10:00 ./',
  'lrwxrwxrwx 0/0 0 2026-11-25 10:00 bin -> usr/bin',
  '-rw-r--r-- 0/0 219807 2026-11-25 10:00 etc/ssl/certs/ca-certificates.crt',
  '-rw-r--r-- 0/0 512 2026-11-25 10:00 etc/passwd',
  'drwxr-xr-x 65532/65532 0 2026-11-25 10:00 home/nonroot/',
  'drwxr-xr-x 0/0 0 2026-11-25 10:00 app/',
  'dr-xr-xr-x 0/0 0 2026-11-25 10:00 app/bin/',
  '-r-xr-xr-x 0/0 14000000 2026-11-25 10:00 app/bin/little-moments-server',
  'dr-xr-xr-x 0/0 0 2026-11-25 10:00 app/dist/',
  '-r--r--r-- 0/0 1800 2026-11-25 10:00 app/dist/index.html',
  '-r--r--r-- 0/0 3000000 2026-11-25 10:00 app/dist/lm-web-1a2b3c_bg.wasm',
  '-r--r--r-- 0/0 40000 2026-11-25 10:00 app/dist/lm-web-1a2b3c.js',
  '-r--r--r-- 0/0 100 2026-11-25 10:00 app/dist/robots.txt',
  'dr-xr-xr-x 0/0 0 2026-11-25 10:00 app/dist/assets/fonts/',
  '-r--r--r-- 0/0 900000 2026-11-25 10:00 app/dist/assets/fonts/jf-openhuninn-ui-204a1ba7.woff2',
  'dr-xr-xr-x 0/0 0 2026-11-25 10:00 app/migrations/',
  '-r--r--r-- 0/0 9000 2026-11-25 10:00 app/migrations/20260101000000_app_schema.sql',
];

describe('Property 38: 映像內容檢查', () => {
  test('通過若且唯若無違規，且違規集合（路徑＋規則）與 oracle 完全相同', () => {
    fc.assert(
      fc.property(listArb, requiredArb, userArb, passwdArb, fc.constantFrom(undefined, 'app', '/app/', './app'), (entries, req, user, pw, appRoot) => {
        const files = [...entries.map((e) => e.raw), ...req];
        const passwd = pw === undefined
          ? undefined
          : ['# comment', ...pw.map((e) => `${e.name}:x:${e.uid}:${e.gid}::/home/${e.name}:/sbin/nologin`), 'broken:line'].join('\n');
        const options = { passwd };
        if (appRoot !== undefined) options.appRoot = appRoot;
        const result = imageContentCheck(files, user, options);
        const expected = oracle(files, user, pw);
        expect(asSet(result.violations)).toEqual(asSet(expected));
        expect(result.violations.length).toBe(new Set(result.violations.map(key)).size);
        expect(result.ok).toBe(expected.length === 0);
      }),
      { numRuns: 400 },
    );
  });

  test('Dockerfile 的映像佈局與 USER 65532:65532 通過；系統路徑的憑證與 home 目錄不視為違規', () => {
    expect(imageContentCheck(CLEAN, '65532:65532')).toEqual({ ok: true, violations: [] });
    // distroless 的 passwd 解析 nonroot 與其主要 GID。
    expect(imageContentCheck(CLEAN, 'nonroot', { passwd: 'nonroot:x:65532:65532:nonroot:/home/nonroot:/sbin/nologin' }).ok).toBe(true);
  });

  test('缺少必要檔案、含原始碼、Bun 或可寫入的檔案時列出每個違規', () => {
    const files = [
      'drwxr-xr-x 0/0 0 2026-11-25 10:00 app/',
      '-rw-rw-r-- 0/0 10 2026-11-25 10:00 app/dist/index.html',
      '-r--r--r-- 0/0 10 2026-11-25 10:00 app/crates/core/src/lib.rs',
      '-r--r--r-- 65532/65532 10 2026-11-25 10:00 app/Cargo.toml',
      '-rwxr-xr-x 0/0 10 2026-11-25 10:00 usr/local/bin/bun',
      '-r--r--r-- 0/0 10 2026-11-25 10:00 app/.env',
    ];
    const r = imageContentCheck(files, '');
    expect(asSet(r.violations)).toEqual(asSet([
      { path: 'app/dist/index.html', rule: 'writable' },
      { path: 'app/crates/', rule: 'forbidden-dir:crates' },
      { path: 'app/crates/core/src/lib.rs', rule: 'source-file' },
      { path: 'app/Cargo.toml', rule: 'source-file' },
      { path: 'app/Cargo.toml', rule: 'owner-not-root' },
      { path: 'usr/local/bin/bun', rule: 'bun-file' },
      { path: 'app/.env', rule: 'env-file' },
      { field: 'files', rule: 'missing:server-binary' },
      { field: 'files', rule: 'missing:wasm' },
      { field: 'files', rule: 'missing:migration' },
      { field: 'Config.User', rule: 'uid-root' },
      { field: 'Config.User', rule: 'gid-root' },
    ]));
  });

  test('只有路徑的 tar -t 清單：app 內的項目記為 mode-missing（fail closed）', () => {
    const files = ['app/', 'app/bin/little-moments-server', 'app/dist/index.html', 'app/dist/x_bg.wasm', 'app/migrations/1_a.sql'];
    expect(imageContentCheck(files, '65532:65532').violations).toEqual([{ field: 'files', rule: 'mode-missing' }]);
  });

  test('伺服器執行檔不可由其他人執行、UID 不是 65532 時未通過', () => {
    const files = CLEAN.map((l) => l.replace('-r-xr-xr-x 0/0 14000000', '-r-xr-x--- 0/0 14000000'));
    expect(imageContentCheck(files, '1000:1000').violations).toEqual([
      { path: 'app/bin/little-moments-server', rule: 'server-not-executable' },
      { field: 'Config.User', rule: 'uid-unexpected' },
      { field: 'Config.User', rule: 'gid-unexpected' },
    ]);
  });

  test('normalizePath、parseEntry 與 parseImageUser 基本行為', () => {
    expect(normalizePath('./app//dist/')).toEqual(['app', 'dist']);
    expect(normalizePath('./')).toBeNull();
    expect(parseEntry('lrwxrwxrwx 0/0 0 2026-11-25 10:00 bin -> usr/bin')).toEqual({ segs: ['bin'], isDir: false, type: 'l', mode: 'rwxrwxrwx', ownerRoot: true });
    expect(parseEntry('crw-rw-rw- 0/0 1,3 2026-11-25 10:00 dev/null')).toMatchObject({ segs: ['dev', 'null'], type: 'c' });
    expect(parseEntry('app/dist/')).toEqual({ segs: ['app', 'dist'], isDir: true, type: null, mode: null, ownerRoot: null });
    expect(parseImageUser('nonroot', 'nonroot:x:65532:65532::/:/sbin/nologin')).toEqual({ uid: 65532, gid: 65532 });
    expect(parseImageUser('ghost', undefined)).toEqual({ uid: null, gid: null });
  });
});
