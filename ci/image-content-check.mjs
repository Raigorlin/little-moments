// App_Image 檔案系統內容檢查（Req 15.5、16.2、16.4、16.9）。
// 純函式供 property test 使用；CLI 只在直接執行時啟動。
//
// 用法：
//   docker create --name c <image> && docker export c | tar -t > reports/image-files.txt
//   docker image inspect <image> > reports/image-inspect.json
//   bun ci/image-content-check.mjs --files reports/image-files.txt --inspect reports/image-inspect.json \
//     [--package package.json] [--passwd <從映像取出的 /etc/passwd>] [--app-root app] [--out reports/image-content.json]
// `--files -` 由 stdin 讀取清單。
// 結束碼：0 通過；1 違規；2 輸入無法讀取或解析。
//
// 範圍：
// - `.env*` 與 `*.sqlite*` 在整個映像檔案系統內皆禁止（Req 16.9）。
// - 憑證副檔名、`*.db`、`data/`、`tests/`、`src/` 與 devDependency 套件目錄只檢查應用程式根目錄
//   （預設 `app/`，對應 Dockerfile 的 WORKDIR /app）。基底映像的系統路徑（例如
//   `/etc/ssl/certs/*.crt`、`/usr/src`）不在 App_Server 的建置成品範圍內。
// - `data/`、`tests/`、`src/` 目錄規則不套用於 `node_modules/` 內部（正式相依套件本身可能含 `src/`）；
//   憑證、資料庫與 `.env*` 檔案規則仍套用於 `node_modules/`。
// - 輸出只含路徑與規則名稱，不含檔案內容。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CERT_EXTENSIONS = Object.freeze(['.pem', '.key', '.p12', '.pfx', '.crt']);
export const FORBIDDEN_APP_DIRS = Object.freeze(['data', 'tests', 'src']);

/** 將 `tar -t` 的路徑正規化為不含開頭 `./`、`/` 與結尾 `/` 的段落陣列；空路徑回傳 null。 */
export function normalizePath(raw) {
  const text = String(raw ?? '').replace(/\\/g, '/').trim();
  const segments = text.split('/').filter(s => s !== '' && s !== '.');
  return segments.length ? segments : null;
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
    entry = entries.find(e => e.name === userPart) ?? null;
    uid = entry ? entry.uid : null;
  } else {
    entry = entries.find(e => e.uid === uid) ?? null;
  }
  let gid;
  if (groupPart !== undefined) {
    // 群組名稱需 /etc/group 才能解析；不猜測，非數字時為 null 使檢查保守失敗。
    gid = toId(groupPart);
  } else {
    // 未指定群組時 Docker 採用 passwd 的主要 GID；查無時為 0。無法確認時保守視為 null（未通過）。
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

function isEnvFile(name) {
  return name === '.env' || name.startsWith('.env.');
}

// `*.sqlite*`：含 `.sqlite`、`.sqlite3`、`.sqlite-wal`、`.sqlite-shm` 等。
function isSqliteFile(name) {
  return /\.sqlite/i.test(name);
}

function hasExtension(name, exts) {
  const lower = name.toLowerCase();
  return exts.some(ext => lower.endsWith(ext) && lower.length > ext.length);
}

/** devDependency 套件名稱 → 段落陣列（`@scope/name` → ['@scope', 'name']）。 */
function packageSegments(name) {
  const parts = String(name).split('/');
  if (parts.length === 1 && parts[0] && !parts[0].startsWith('@')) return parts;
  if (parts.length === 2 && parts[0].startsWith('@') && parts[0].length > 1 && parts[1]) return parts;
  return null;
}

/**
 * @param {string[]} files `tar -t` 輸出的路徑清單
 * @param {string|null|undefined} user `Config.User`
 * @param {string[]} devDeps package.json 的 devDependencies 名稱
 * @param {{appRoot?: string, passwd?: string}} [options]
 * @returns {{ok: boolean, violations: ({path: string, rule: string} | {field: string, rule: string})[]}}
 */
export function imageContentCheck(files, user, devDeps, options = {}) {
  const appRoot = normalizePath(options.appRoot ?? 'app') ?? ['app'];
  const devPkgs = (devDeps ?? []).map(packageSegments).filter(Boolean);
  const found = new Map();
  const add = (path, rule) => found.set(`${rule}\u0000${path}`, { path, rule });
  let appFiles = 0;

  for (const raw of files ?? []) {
    const segs = normalizePath(raw);
    if (!segs) continue;
    const name = segs[segs.length - 1];
    const full = segs.join('/');

    if (isEnvFile(name)) add(full, 'env-file');
    if (isSqliteFile(name)) add(full, 'database-file');

    const inApp = appRoot.every((s, i) => segs[i] === s) && segs.length > appRoot.length;
    if (!inApp) continue;
    appFiles += 1;
    const rel = segs.slice(appRoot.length);

    if (hasExtension(name, CERT_EXTENSIONS)) add(full, 'certificate-file');
    if (hasExtension(name, ['.db', '.sqlite', '.sqlite3'])) add(full, 'database-file');

    // 目錄規則：只看第一個 node_modules 之前的段落；最後一段若為檔案（無結尾 `/`）不視為目錄。
    const nm = rel.indexOf('node_modules');
    const outside = nm === -1 ? rel : rel.slice(0, nm);
    for (let i = 0; i < outside.length; i += 1) {
      const isLastFile = i === outside.length - 1 && nm === -1 && !String(raw).trim().endsWith('/');
      if (FORBIDDEN_APP_DIRS.includes(outside[i]) && !isLastFile) {
        add([...appRoot, ...rel.slice(0, i + 1)].join('/') + '/', `forbidden-dir:${outside[i]}`);
        break;
      }
    }

    // devDependency：任一層 node_modules/<pkg>/
    for (let i = 0; i < rel.length; i += 1) {
      if (rel[i] !== 'node_modules') continue;
      for (const pkg of devPkgs) {
        if (pkg.every((s, j) => rel[i + 1 + j] === s)) {
          add([...appRoot, ...rel.slice(0, i + 1 + pkg.length)].join('/') + '/', `dev-dependency:${pkg.join('/')}`);
        }
      }
    }
  }

  const violations = [...found.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0);

  if (appFiles === 0) violations.push({ field: 'files', rule: 'app-root-missing' });

  const { uid, gid } = parseImageUser(user, options.passwd);
  if (uid === null) violations.push({ field: 'Config.User', rule: 'uid-unresolved' });
  else if (uid === 0) violations.push({ field: 'Config.User', rule: 'uid-root' });
  if (gid === null) violations.push({ field: 'Config.User', rule: 'gid-unresolved' });
  else if (gid === 0) violations.push({ field: 'Config.User', rule: 'gid-root' });

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
  let files, user, devDeps, passwd;
  try {
    const filesPath = arg(argv, '--files', null);
    const inspectPath = arg(argv, '--inspect', null);
    if (!filesPath || !inspectPath) throw new Error('需要 --files 與 --inspect');
    const listing = readFileSync(filesPath === '-' ? 0 : filesPath, 'utf8');
    files = listing.split(/\r?\n/).filter(l => l.trim() !== '');
    user = userFromInspect(JSON.parse(readFileSync(inspectPath, 'utf8')));
    const pkg = JSON.parse(readFileSync(arg(argv, '--package', 'package.json'), 'utf8'));
    devDeps = Object.keys(pkg.devDependencies ?? {});
    const passwdPath = arg(argv, '--passwd', null);
    passwd = passwdPath ? readFileSync(passwdPath, 'utf8') : undefined;
  } catch (error) {
    console.error(`映像內容檢查無法執行: ${error.message}`);
    return 2;
  }
  const result = imageContentCheck(files, user, devDeps, { appRoot: arg(argv, '--app-root', 'app'), passwd });
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
