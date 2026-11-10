// 秘密遮罩與封存前掃描（Requirement 6.4、15.4、21.9、22.8；Design Components §9、Property 10）。
//
// 純函式（供 property test 使用，皆不回傳或輸出秘密值）：
//   normalizeSecrets(S)    → [{ id, value }]；接受 [{id,value}]、{ id: value } 或 Map，忽略空值
//   secretForms(value)     → [{ form, text }]：原文、Base64（含／不含補齊）、Base64URL（含／不含補齊）、
//                            URL 編碼（大寫／小寫十六進位）；同一字串可能對應多個形式名稱
//   scrub(text, S)         → 將 S 所有形式的每個出現位置（由長到短收集、重疊區段合併）取代為 MASK；
//                            若某形式是 MASK 的子字串（例如秘密為 `********`），改為刪除命中區段
//   findLeaks(text, S)     → [{ id, form }]：text 中實際出現的（憑證 ID × 形式），不含值本身
//
// CLI：
//   bun ci/scrub.mjs (--secrets <0600 秘密檔> | --secrets-dir <0700 目錄>)... --in <暫存目錄> [--out <封存目錄>] [--report <json>]
//   秘密檔為 JSON：{ "<憑證 ID>": "<值>" } 或 [{ "id": "...", "value": "..." }]。
//   --secrets-dir（Jenkinsfile 收尾階段使用）：目錄本身 0700、其中每個檔案 0600、只允許一般檔案：
//     `*.json`  與 --secrets 相同格式（例如各階段 Ephemeral_Database 的 scrub-secrets.json 副本）
//     其他檔案  一個秘密的原值，檔名即憑證 ID（Pipeline 在 withCredentials 內以 shell 內建 printf 或 cat 寫入，
//               值不經命令列）；結尾換行會被移除；多行值（例如私鑰）另將每一行（≥ 16 字元，PEM 標頭除外）列為秘密。
//   兩者可同時提供，秘密集合取聯集。
//   --out 省略時就地處理。遮罩後仍偵測到任一形式的檔案不輸出，改寫為 `<檔名>.withheld.txt` 說明檔
//   （只含檔名、憑證 ID 與形式名稱）。
//   結束碼：0 全部通過；1 有檔案被扣留；2 參數錯誤、秘密檔無法讀取或權限過寬。

import * as nodeFs from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MASK = '********';
const MASK_BYTES = Buffer.from(MASK, 'utf8');

/**
 * 將秘密集合正規化為 [{id, value}]，忽略空字串、非字串值與空白 ID。
 * @param {Array<{id:string, value:string}> | Record<string,string> | Map<string,string>} S
 * @returns {{id:string, value:string}[]}
 */
export function normalizeSecrets(S) {
  let entries = [];
  if (S instanceof Map) entries = [...S].map(([id, value]) => ({ id, value }));
  else if (Array.isArray(S)) entries = S.map(e => ({ id: e?.id, value: e?.value }));
  else if (S && typeof S === 'object') entries = Object.entries(S).map(([id, value]) => ({ id, value }));
  return entries.filter(e => typeof e.id === 'string' && e.id !== '' && typeof e.value === 'string' && e.value !== '');
}

function urlEncode(value) {
  try { return encodeURIComponent(value); } catch { return null; } // 孤立 surrogate 無法編碼
}

/**
 * 產生一個秘密值的所有比對形式。
 * @param {string} value
 * @returns {{form:string, text:string}[]}
 */
export function secretForms(value) {
  if (typeof value !== 'string' || value === '') return [];
  const bytes = Buffer.from(value, 'utf8');
  const b64 = bytes.toString('base64');
  const b64NoPad = b64.replace(/=+$/, '');
  const b64url = bytes.toString('base64url'); // Node/Bun 的 base64url 不含補齊
  const b64urlPad = b64url + '='.repeat((4 - (b64url.length % 4)) % 4);
  const forms = [
    { form: 'raw', text: value },
    { form: 'base64', text: b64 },
    { form: 'base64-nopad', text: b64NoPad },
    { form: 'base64url', text: b64urlPad },
    { form: 'base64url-nopad', text: b64url },
  ];
  const url = urlEncode(value);
  if (url !== null) {
    forms.push({ form: 'url-upper', text: url });
    forms.push({ form: 'url-lower', text: url.replace(/%[0-9A-F]{2}/g, m => m.toLowerCase()) });
  }
  return forms.filter(f => f.text !== '');
}

// 所有秘密的相異比對字串，由長到短排序。
function patternsOf(S) {
  const set = new Set();
  for (const { value } of normalizeSecrets(S)) for (const f of secretForms(value)) set.add(f.text);
  return [...set].sort((a, b) => b.length - a.length);
}

// 收集所有出現位置（含彼此重疊者）並合併為不重疊區段。haystack 為 string 或 Buffer。
function maskedIntervals(haystack, patterns) {
  const intervals = [];
  for (const p of patterns) {
    const len = p.length;
    if (len === 0) continue;
    for (let i = haystack.indexOf(p); i !== -1; i = haystack.indexOf(p, i + 1)) intervals.push([i, i + len]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of intervals) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

function applyMask(haystack, patterns, slice, concat, mask) {
  const merged = maskedIntervals(haystack, patterns);
  if (merged.length === 0) return { out: haystack, count: 0 };
  const parts = [];
  let pos = 0;
  for (const [s, e] of merged) {
    parts.push(slice(haystack, pos, s), mask);
    pos = e;
  }
  parts.push(slice(haystack, pos, haystack.length));
  return { out: concat(parts), count: merged.length };
}

// 遮罩字元與相鄰文字可能拼出新的出現位置（秘密本身含 `*` 時），因此重複至無命中。
// 必定終止：
//   - mask 為 MASK 且沒有任何 pattern 是 MASK 的子字串時，每輪被取代的區段若含非 `*` 字元，
//     非 `*` 字元數減少；否則該區段全為 `*` 且長度 > MASK.length，總長度減少。
//     （非 `*` 字元數, 總長度）依字典序嚴格遞減。
//   - 若有 pattern 是 MASK 的子字串（例如秘密恰為 `********`），以 MASK 取代必然重現秘密，
//     改為直接刪除命中區段（mask 為空）；每輪總長度嚴格遞減。
function scrubGeneric(haystack, patterns, slice, concat, mask) {
  let out = haystack;
  let total = 0;
  for (;;) {
    const r = applyMask(out, patterns, slice, concat, mask);
    out = r.out;
    total += r.count;
    if (r.count === 0) break;
  }
  return { out, count: total };
}

// 選擇遮罩：pattern 為 MASK 子字串時改為刪除（見上方說明）。
const maskFor = (patterns, mask, empty) => (patterns.some(p => mask.includes(p)) ? empty : mask);

const strSlice = (s, a, b) => s.slice(a, b);
const strConcat = parts => parts.join('');
const bufSlice = (b, x, y) => b.subarray(x, y);
const bufConcat = parts => Buffer.concat(parts);

/**
 * 將 text 中 S 每個秘密的所有形式取代為 MASK（不保留任何原文字元）。
 * @param {string} text
 * @param {Parameters<typeof normalizeSecrets>[0]} S
 * @returns {string}
 */
export function scrub(text, S) {
  if (typeof text !== 'string' || text === '') return text;
  const patterns = patternsOf(S);
  return scrubGeneric(text, patterns, strSlice, strConcat, maskFor(patterns, MASK, '')).out;
}

/**
 * 回傳 text 中出現的（憑證 ID、形式名稱）清單，依 ID、形式排序且不重複；絕不回傳秘密值。
 * @param {string | Buffer} text
 * @param {Parameters<typeof normalizeSecrets>[0]} S
 * @returns {{id:string, form:string}[]}
 */
export function findLeaks(text, S) {
  const isBuf = Buffer.isBuffer(text);
  if (!isBuf && typeof text !== 'string') return [];
  const seen = new Set();
  const leaks = [];
  for (const { id, value } of normalizeSecrets(S)) {
    for (const { form, text: t } of secretForms(value)) {
      const key = `${id}\u0000${form}`;
      if (seen.has(key)) continue;
      const needle = isBuf ? Buffer.from(t, 'utf8') : t;
      if (text.indexOf(needle) !== -1) {
        seen.add(key);
        leaks.push({ id, form });
      }
    }
  }
  return leaks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.form < b.form ? -1 : a.form > b.form ? 1 : 0));
}

/**
 * Buffer 版本（CLI 使用，二進位安全）：以 UTF-8 位元組比對所有形式。
 * @param {Buffer} buf
 * @returns {{out: Buffer, count: number}}
 */
export function scrubBuffer(buf, S) {
  const patterns = patternsOf(S).map(p => Buffer.from(p, 'utf8'));
  return scrubGeneric(buf, patterns, bufSlice, bufConcat, maskFor(patterns, MASK_BYTES, Buffer.alloc(0)));
}

// ---------------------------------------------------------------- CLI

export const WITHHELD_SUFFIX = '.withheld.txt';

function parseArgs(argv) {
  const args = {};
  const keys = new Set(['--secrets', '--secrets-dir', '--in', '--out', '--report']);
  for (let i = 0; i < argv.length; i++) {
    if (!keys.has(argv[i]) || i + 1 >= argv.length) return null;
    const key = argv[i].slice(2);
    if (key in args) return null;
    args[key] = argv[++i];
  }
  if ((!args.secrets && !args['secrets-dir']) || !args.in) return null;
  return args;
}

/** --secrets-dir 中允許的檔名（憑證 ID 或 `<名稱>.json`）。 */
export const SECRET_FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MIN_LINE_SECRET = 16;

/**
 * 原值秘密檔的內容 → 秘密項目。移除結尾換行；多行值另將每一行（去除前後空白後 ≥ 16 字元，
 * PEM 的 BEGIN／END 標頭除外）以 `<id>#<行號>` 列為秘密，避免只有部分行出現在日誌時漏遮。
 * @returns {{id:string, value:string}[]}
 */
export function rawSecretEntries(id, text) {
  const value = String(text ?? '').replace(/(?:\r?\n)+$/, '');
  const out = normalizeSecrets([{ id, value }]);
  const lines = value.split(/\r?\n/);
  if (lines.length > 1) {
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.length >= MIN_LINE_SECRET && !/^-----(BEGIN|END) /.test(t)) out.push({ id: `${id}#${i + 1}`, value: t });
    });
  }
  return out;
}

/** 讀取秘密目錄；錯誤訊息不含檔案內容。 */
export function loadSecretsDir(dir, { fs = nodeFs, platform = process.platform } = {}) {
  let stat;
  try { stat = fs.lstatSync(dir); } catch { return { ok: false, reason: '秘密目錄不存在或無法讀取' }; }
  if (!stat.isDirectory()) return { ok: false, reason: '秘密目錄不是目錄' };
  if (platform !== 'win32' && (stat.mode & 0o077) !== 0) return { ok: false, reason: '秘密目錄權限過寬（須為 0700）' };
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { ok: false, reason: '秘密目錄無法讀取' }; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const secrets = [];
  for (const ent of entries) {
    if (!SECRET_FILE_NAME_RE.test(ent.name)) return { ok: false, reason: '秘密目錄含無效的檔名' };
    // Dirent 對符號連結回傳 isFile() === false：不跟隨連結。
    if (!ent.isFile()) return { ok: false, reason: '秘密目錄只能包含一般檔案' };
    const path = join(dir, ent.name);
    let st;
    try { st = fs.statSync(path); } catch { return { ok: false, reason: '秘密檔不存在或無法讀取' }; }
    if (platform !== 'win32' && (st.mode & 0o077) !== 0) return { ok: false, reason: '秘密檔權限過寬（須為 0600）' };
    let text;
    try { text = fs.readFileSync(path, 'utf8'); } catch { return { ok: false, reason: '秘密檔不存在或無法讀取' }; }
    if (ent.name.endsWith('.json')) {
      let doc;
      try { doc = JSON.parse(text); } catch { return { ok: false, reason: '秘密目錄中的 JSON 檔無效' }; }
      if (!doc || typeof doc !== 'object') return { ok: false, reason: '秘密目錄中的 JSON 檔格式不符' };
      secrets.push(...normalizeSecrets(doc));
    } else {
      secrets.push(...rawSecretEntries(ent.name, text));
    }
  }
  return { ok: true, secrets };
}

/** 讀取秘密檔；錯誤訊息不含檔案內容。 */
export function loadSecretsFile(path, { fs = nodeFs, platform = process.platform } = {}) {
  let stat;
  try { stat = fs.statSync(path); } catch { return { ok: false, reason: '秘密檔不存在或無法讀取' }; }
  if (!stat.isFile()) return { ok: false, reason: '秘密檔不是一般檔案' };
  // Windows 不支援 POSIX 權限位元，僅在 POSIX 平台檢查 0600。
  if (platform !== 'win32' && (stat.mode & 0o077) !== 0) return { ok: false, reason: '秘密檔權限過寬（須為 0600）' };
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return { ok: false, reason: '秘密檔不是有效的 JSON' }; }
  if (!doc || typeof doc !== 'object') return { ok: false, reason: '秘密檔格式不符' };
  return { ok: true, secrets: normalizeSecrets(doc) };
}

function listFiles(root, fs) {
  const files = [];
  const skipped = [];
  const walk = dir => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isSymbolicLink()) skipped.push(relative(root, p));
      else if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) files.push(p);
    }
  };
  walk(root);
  return { files: files.sort(), skipped: skipped.sort() };
}

function withheldNote(rel, leaks) {
  const lines = [
    `檔案已扣留，未封存：${rel}`,
    '原因：遮罩後仍偵測到來自 Credential_Store 的秘密（下列僅列憑證 ID 與形式，不含值）。',
    ...leaks.map(l => `- ${l.id} (${l.form})`),
    '',
  ];
  return lines.join('\n');
}

/**
 * 處理暫存目錄中待封存的檔案。
 * @returns {{ok:boolean, files:number, maskedFiles:number, withheld:{file:string, leaks:{id:string, form:string}[]}[], skipped:string[]}}
 */
export function processDirectory(inDir, outDir, S, { fs = nodeFs } = {}) {
  const secrets = normalizeSecrets(S);
  const { files, skipped } = listFiles(inDir, fs);
  const withheld = [];
  let maskedFiles = 0;
  for (const src of files) {
    const rel = relative(inDir, src);
    const dest = join(outDir, rel);
    const { out, count } = scrubBuffer(fs.readFileSync(src), secrets);
    const leaks = findLeaks(out, secrets);
    fs.mkdirSync(dirname(dest), { recursive: true });
    if (leaks.length > 0) {
      if (resolve(dest) === resolve(src)) fs.rmSync(src, { force: true });
      fs.writeFileSync(dest + WITHHELD_SUFFIX, withheldNote(rel.split('\\').join('/'), leaks));
      withheld.push({ file: rel.split('\\').join('/'), leaks });
      continue;
    }
    if (count > 0) maskedFiles++;
    if (count > 0 || resolve(dest) !== resolve(src)) fs.writeFileSync(dest, out);
  }
  return { ok: withheld.length === 0, files: files.length, maskedFiles, withheld, skipped: skipped.map(s => s.split('\\').join('/')) };
}

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error, fs = nodeFs } = {}) {
  const args = parseArgs(argv);
  if (!args) {
    error('用法：bun ci/scrub.mjs (--secrets <0600 秘密檔> | --secrets-dir <0700 目錄>) --in <暫存目錄> [--out <封存目錄>] [--report <json>]');
    return 2;
  }
  const secrets = [];
  for (const loaded of [
    args.secrets ? loadSecretsFile(args.secrets, { fs }) : null,
    args['secrets-dir'] ? loadSecretsDir(args['secrets-dir'], { fs }) : null,
  ]) {
    if (!loaded) continue;
    if (!loaded.ok) {
      error(`秘密遮罩失敗：${loaded.reason}`);
      return 2;
    }
    secrets.push(...loaded.secrets);
  }
  let inStat;
  try { inStat = fs.statSync(args.in); } catch { inStat = null; }
  if (!inStat || !inStat.isDirectory()) {
    error('秘密遮罩失敗：--in 不是目錄');
    return 2;
  }
  const outDir = args.out ?? args.in;
  const summary = processDirectory(args.in, outDir, secrets, { fs });
  const text = JSON.stringify(summary);
  if (args.report) {
    fs.mkdirSync(dirname(resolve(args.report)), { recursive: true });
    fs.writeFileSync(args.report, JSON.stringify(summary, null, 2) + '\n');
  }
  log(text);
  for (const w of summary.withheld) {
    error(`檔案已扣留 ${w.file}: ${w.leaks.map(l => `${l.id}(${l.form})`).join(', ')}`);
  }
  return summary.ok ? 0 : 1;
}

const isMain = import.meta.main
  ?? (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) process.exitCode = main();
