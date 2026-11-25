// App_Image 檔案系統內容檢查（Rust 版映像；plan.md D4）。
// 純函式供 property test 使用；CLI 只在直接執行時啟動。
//
// 用法：
//   docker create --name c <image> && docker export c | tar -tv --numeric-owner > reports/image-files.txt
//   docker image inspect <image> > reports/image-inspect.json
//   bun ci/image-content-check.mjs --files reports/image-files.txt --inspect reports/image-inspect.json \
//     [--passwd <從映像取出的 /etc/passwd>] [--app-root app] [--out reports/image-content.json]
// `--files -` 由 stdin 讀取清單。`--package` 仍被接受但不使用（相容 ci/scripts/build-image.sh 的呼叫）。
// 結束碼：0 通過；1 違規；2 輸入無法讀取或解析。
//
// 清單每行可為 `tar -tv --numeric-owner` 的格式（`-r--r--r-- 0/0 123 2026-01-01 00:00 app/dist/index.html`），
// 或只有路徑的 `tar -t` 格式；後者沒有權限與擁有者，應用程式根目錄內的項目因此一律記為 `mode-missing`（fail closed）。
//
// 規則：
// - 整個映像：`.env*`（env-file）、`*.sqlite*`（database-file）、Bun 的執行檔與設定（bun-file）。
// - 應用程式根目錄（預設 `app/`，對應 Dockerfile 的 WORKDIR /app）：
//   - 必要：`bin/little-moments-server`、`dist/index.html`、至少一個 `dist/*.wasm`、至少一個 `migrations/*.sql`（missing:*）。
//   - 禁止：原始碼與建置目錄 `crates/`、`target/`、`src/`、`tests/`、`node_modules/`、`data/`（forbidden-dir:*）；
//     `*.rs`、`Cargo.toml`、`Cargo.lock`、`rust-toolchain.toml`、`Trunk.toml`、`package.json`（source-file）；
//     憑證副檔名（certificate-file）、`*.db|sqlite|sqlite3`（database-file）。
//   - 權限：擁有者必須是 root（owner-not-root），群組與其他人不可寫入（writable）；伺服器執行檔須可由其他人執行
//     （server-not-executable）。符號連結不檢查權限。
//   基底映像的系統路徑（例如 `/etc/ssl/certs/*.crt`）不在 App_Server 的建置成品範圍內，只套用整個映像的規則。
// - `docker image inspect` 的 Config.User 必須解析為 UID／GID 65532（uid-root、uid-unexpected、uid-unresolved 與 gid-*）。
// - 輸出只含路徑與規則名稱，不含檔案內容。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_UID = 65532;
export const RUNTIME_GID = 65532;
export const CERT_EXTENSIONS = Object.freeze(['.pem', '.key', '.p12', '.pfx', '.crt']);
export const FORBIDDEN_APP_DIRS = Object.freeze(['crates', 'target', 'src', 'tests', 'node_modules', 'data']);
export const SOURCE_FILES = Object.freeze(['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'Trunk.toml', 'package.json']);
export const BUN_FILES = Object.freeze(['bun', 'bunx', 'bun.lock', 'bun.lockb', 'bunfig.toml']);
export const SERVER_BINARY = 'bin/little-moments-server';
/** 應用程式根目錄內必須存在的檔案（相對路徑）。 */
export const REQUIRED = Object.freeze([
  Object.freeze({ rule: 'missing:server-binary', match: (rel) => rel === SERVER_BINARY }),
  Object.freeze({ rule: 'missing:index-html', match: (rel) => rel === 'dist/index.html' }),
  Object.freeze({ rule: 'missing:wasm', match: (rel) => /^dist\/[^/]+\.wasm$/.test(rel) }),
  Object.freeze({ rule: 'missing:migration', match: (rel) => /^migrations\/[^/]+\.sql$/.test(rel) }),
]);

// `tar -tv`：類型 + 9 個權限字元、擁有者/群組、大小（裝置為 主,次）、日期、時間、路徑（符號連結含 ` -> 目標`）。
const VERBOSE = /^([-dlhcbps])([-rwxsStT]{9})\s+([^\s/]+)\/(\S+)\s+\d+(?:,\s*\d+)?\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.+)$/;

/** 將 `tar -t` 的路徑正規化為不含開頭 `./`、`/` 與結尾 `/` 的段落陣列；空路徑回傳 null。 */
export function normalizePath(raw) {
  const text = String(raw ?? '').replace(/\\/g, '/').trim();
  const segments = text.split('/').filter((s) => s !== '' && s !== '.');
  return segments.length ? segments : null;
}

/**
 * 解析清單的一行。
 * @returns {{segs: string[], isDir: boolean, type: string|null, mode: string|null, ownerRoot: boolean|null} | null}
 */
export function parseEntry(raw) {
  const line = String(raw ?? '').replace(/\r$/, '');
  const m = VERBOSE.exec(line);
  if (m) {
    let path = m[5];
    if (m[1] === 'l') path = path.replace(/ -> .*$/, '');
    else if (m[1] === 'h') path = path.replace(/ link to .*$/, '');
    const segs = normalizePath(path);
    if (!segs) return null;
    const isRoot = (v) => v === '0' || v === 'root';
    return { segs, isDir: m[1] === 'd', type: m[1], mode: m[2], ownerRoot: isRoot(m[3]) && isRoot(m[4]) };
  }
  const segs = normalizePath(line);
  if (!segs) return null;
  return { segs, isDir: line.trim().endsWith('/'), type: null, mode: null, ownerRoot: null };
}

/**
 * 解析 `docker image inspect` 的 Config.User。
 * @param {string|null|undefined} user
 * @param {string} [passwd] 映像內 /etc/passwd 內容（解析名稱與主要 GID 用）
 * @returns {{uid: number|null, gid: number|null}}
 */
export function parseImageUser(user, passwd) {
  const text = String(user ?? '').trim();
  if (text === '') return { uid: 0, gid: 0 }; // 未設定 USER 即為 root
  const [userPart, groupPart] = text.split(':', 2);
  const entries = parsePasswd(passwd);
  let uid = toId(userPart);
  let entry = null;
  if (uid === null) {
    entry = entries.find((e) => e.name === userPart) ?? null;
    uid = entry ? entry.uid : null;
  } else {
    entry = entries.find((e) => e.uid === uid) ?? null;
  }
  let gid;
  if (groupPart !== undefined) {
    // 群組名稱需 /etc/group 才能解析；不猜測，非數字時為 null 使檢查保守失敗。
    gid = toId(groupPart);
  } else {
    // 未指定群組時 Docker 採用 passwd 的主要 GID；無法確認時保守視為 null（未通過）。
    gid = entry ? entry.gid : null;
  }
  return { uid, gid };
}

function toId(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function parsePasswd(passwd) {
  if (typeof passwd !== 'string') return [];
  const out = [];
  for (const line of passwd.split(/\r?\n/)) {
    const f = line.split(':');
    if (f.length < 4) continue;
    const uid = toId(f[2]);
    const gid = toId(f[3]);
    if (f[0] && uid !== null && gid !== null) out.push({ name: f[0], uid, gid });
  }
  return out;
}

const isEnvFile = (name) => name === '.env' || name.startsWith('.env.');
// `*.sqlite*`：含 `.sqlite`、`.sqlite3`、`.sqlite-wal`、`.sqlite-shm` 等。
const isSqliteFile = (name) => /\.sqlite/i.test(name);

function hasExtension(name, exts) {
  const lower = name.toLowerCase();
  return exts.some((ext) => lower.endsWith(ext) && lower.length > ext.length);
}

/**
 * @param {string[]} files `tar -tv --numeric-owner`（或 `tar -t`）輸出的清單
 * @param {string|null|undefined} user `Config.User`
 * @param {{appRoot?: string, passwd?: string}} [options]
 * @returns {{ok: boolean, violations: ({path: string, rule: string} | {field: string, rule: string})[]}}
 */
export function imageContentCheck(files, user, options = {}) {
  const appRoot = normalizePath(options.appRoot ?? 'app') ?? ['app'];
  const found = new Map();
  const add = (path, rule) => found.set(`${rule}\u0000${path}`, { path, rule });
  const fields = new Map();
  const addField = (field, rule) => fields.set(`${rule}\u0000${field}`, { field, rule });
  const required = new Set();
  let appEntries = 0;

  for (const raw of files ?? []) {
    const entry = parseEntry(raw);
    if (!entry) continue;
    const { segs, isDir } = entry;
    const name = segs[segs.length - 1];
    const full = segs.join('/');

    if (!isDir) {
      if (isEnvFile(name)) add(full, 'env-file');
      if (isSqliteFile(name)) add(full, 'database-file');
      if (BUN_FILES.includes(name)) add(full, 'bun-file');
    }

    const inApp = appRoot.every((s, i) => segs[i] === s) && segs.length > appRoot.length;
    if (!inApp) continue;
    appEntries += 1;
    const rel = segs.slice(appRoot.length);
    const relPath = rel.join('/');

    if (!isDir) {
      for (const r of REQUIRED) if (r.match(relPath)) required.add(r.rule);
      if (hasExtension(name, CERT_EXTENSIONS)) add(full, 'certificate-file');
      if (hasExtension(name, ['.db', '.sqlite', '.sqlite3'])) add(full, 'database-file');
      if (hasExtension(name, ['.rs']) || SOURCE_FILES.includes(name)) add(full, 'source-file');
    }

    // 目錄規則：最後一段為檔案時不視為目錄；只記錄第一個命中的目錄。
    const dirParts = isDir ? rel : rel.slice(0, -1);
    const hit = dirParts.findIndex((s) => FORBIDDEN_APP_DIRS.includes(s));
    if (hit >= 0) add(`${[...appRoot, ...rel.slice(0, hit + 1)].join('/')}/`, `forbidden-dir:${rel[hit]}`);

    if (entry.mode === null) {
      addField('files', 'mode-missing');
    } else if (entry.type !== 'l') {
      if (!entry.ownerRoot) add(full, 'owner-not-root');
      if (entry.mode[4] === 'w' || entry.mode[7] === 'w') add(full, 'writable');
      if (relPath === SERVER_BINARY && !isDir && !['x', 't'].includes(entry.mode[8])) add(full, 'server-not-executable');
    }
  }

  const violations = [...found.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0);

  if (appEntries === 0) addField('files', 'app-root-missing');
  else for (const r of REQUIRED) if (!required.has(r.rule)) addField('files', r.rule);
  violations.push(...fields.values());

  const { uid, gid } = parseImageUser(user, options.passwd);
  if (uid === null) violations.push({ field: 'Config.User', rule: 'uid-unresolved' });
  else if (uid === 0) violations.push({ field: 'Config.User', rule: 'uid-root' });
  else if (uid !== RUNTIME_UID) violations.push({ field: 'Config.User', rule: 'uid-unexpected' });
  if (gid === null) violations.push({ field: 'Config.User', rule: 'gid-unresolved' });
  else if (gid === 0) violations.push({ field: 'Config.User', rule: 'gid-root' });
  else if (gid !== RUNTIME_GID) violations.push({ field: 'Config.User', rule: 'gid-unexpected' });

  return { ok: violations.length === 0, violations };
}

/** 從 `docker image inspect` JSON（陣列或單一物件）取出 Config.User。 */
export function userFromInspect(doc) {
  const item = Array.isArray(doc) ? doc[0] : doc;
  if (!item || typeof item !== 'object') throw new Error('inspect JSON 不含映像資料');
  const user = item.Config?.User;
  return typeof user === 'string' ? user : '';
}

function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function main(argv) {
  let files, user, passwd;
  try {
    const filesPath = arg(argv, '--files', null);
    const inspectPath = arg(argv, '--inspect', null);
    if (!filesPath || !inspectPath) throw new Error('需要 --files 與 --inspect');
    const listing = readFileSync(filesPath === '-' ? 0 : filesPath, 'utf8');
    files = listing.split(/\r?\n/).filter((l) => l.trim() !== '');
    user = userFromInspect(JSON.parse(readFileSync(inspectPath, 'utf8')));
    const passwdPath = arg(argv, '--passwd', null);
    passwd = passwdPath ? readFileSync(passwdPath, 'utf8') : undefined;
  } catch (error) {
    console.error(`映像內容檢查無法執行: ${error.message}`);
    return 2;
  }
  const result = imageContentCheck(files, user, { appRoot: arg(argv, '--app-root', 'app'), passwd });
  const out = arg(argv, '--out', null);
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  }
  console.log(JSON.stringify({ ok: result.ok, violations: result.violations.length }));
  for (const v of result.violations) console.error(`映像內容違規 ${v.rule}: ${v.path ?? v.field}`);
  return result.ok ? 0 : 1;
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
