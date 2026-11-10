// DAST 目標驗證（Req 7.2、7.3、7.4；Property 11）。
//
// validateDastTargets(config, allowlist) 是純函式：輸入為已解析（並已代入變數）的 ZAP Automation
// Framework 計畫物件與 Target_Allowlist（origin 字串陣列），輸出
//   { ok, rejected: string[], details: {target, location, reason}[], invalidAllowlist: string[], errors: string[] }
// ok 為真若且唯若 allowlist 至少有一個有效 origin、計畫至少有一個目標，且每個目標都在 allowlist 內。
// rejected 為不在 allowlist 內的目標集合（去重、保持出現順序）。
//
// 目標來源：
//   - env.contexts[].urls[] 與計畫中任何其他絕對 URL 字串（含 jobs[].parameters.url、驗證設定的
//     loginPageUrl 等，未知 job 類型同樣涵蓋）→ 比對正規化後的 scheme、host、port。
//   - env.contexts[].includePaths[]（爬蟲可跟隨的範圍）→ 必須以 allowlist 中某個 origin 的字面值錨定，
//     且 origin 後緊接 `/` 或樣式結尾，不得含未跳脫的 `|`。
//   excludePaths 只會縮小範圍，不視為目標。
//
// CLI（Pipeline 在發出任何掃描請求前執行）：
//   bun ci/dast/targets.mjs --plan ci/dast/zap-automation.yaml --allowlist <origin>[,<origin>...] \
//     [--render reports/dast/zap-plan.yaml] [--out reports/dast/targets.json]
//   --allowlist 未提供時讀取 DAST_TARGET_ALLOWLIST。計畫中的 ${VAR} 以環境變數代入；未設定的變數保留原文，
//   使該目標無法解析而被拒絕。通過時才寫出 --render 指定的計畫檔。
//   結束碼：0 通過；1 目標或限制驗證失敗；2 用法或檔案錯誤。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORTS = Object.freeze({ 'http:': '80', 'https:': '443' });
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const URL_KEYS = new Set(['url', 'urls', 'apiUrl', 'targetUrl', 'endpoint', 'loginPageUrl', 'loginRequestUrl', 'pollUrl']);

/**
 * 將 origin 或 URL 字串正規化為 `scheme://host[:port]`（小寫、省略預設連接埠）。
 * 只接受 http/https，拒絕 userinfo。`requireOriginOnly` 為真時另拒絕路徑（`/` 除外）、query 與 fragment。
 * @returns {string|null}
 */
export function normalizeOrigin(value, { requireOriginOnly = false } = {}) {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) return null;
  if (!ABSOLUTE_URL.test(value)) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (!(u.protocol in DEFAULT_PORTS)) return null;
  // 字面 authority 中出現 `@` 或 `\` 一律拒絕（userinfo 或 WHATWG 將 `\` 視為 `/` 造成的解讀差異）。
  const authority = value.slice(value.indexOf('//') + 2).split(/[/?#]/)[0];
  if (u.username !== '' || u.password !== '' || /[@\\]/.test(authority)) return null;
  if (u.hostname === '' || u.hostname.includes('*')) return null;
  if (requireOriginOnly && ((u.pathname !== '/' && u.pathname !== '') || u.search !== '' || u.hash !== '')) return null;
  if (requireOriginOnly && /[?#]/.test(value)) return null;
  const port = u.port === '' || u.port === DEFAULT_PORTS[u.protocol] ? '' : `:${u.port}`;
  return `${u.protocol}//${u.hostname.toLowerCase()}${port}`;
}

/**
 * 解析 Target_Allowlist。
 * @param {unknown} allowlist 字串陣列或逗號分隔字串
 * @returns {{origins: Set<string>, invalid: string[]}}
 */
export function parseAllowlist(allowlist) {
  const items = typeof allowlist === 'string'
    ? allowlist.split(',').map((s) => s.trim()).filter((s) => s !== '')
    : Array.isArray(allowlist) ? allowlist : [];
  const origins = new Set();
  const invalid = [];
  for (const item of items) {
    const o = typeof item === 'string' ? normalizeOrigin(item.replace(/\/$/, ''), { requireOriginOnly: true }) : null;
    if (o) origins.add(o); else invalid.push(String(item));
  }
  return { origins, invalid };
}

/**
 * 列出計畫中的所有目標。
 * @returns {{target: string, location: string, kind: 'url'|'pattern'}[]}
 */
export function collectDastTargets(config) {
  const out = [];
  const contexts = Array.isArray(config?.env?.contexts) ? config.env.contexts : [];
  contexts.forEach((ctx, i) => {
    const base = `env.contexts[${i}]`;
    const urls = ctx?.urls;
    if (Array.isArray(urls)) urls.forEach((u, j) => out.push({ target: String(u), location: `${base}.urls[${j}]`, kind: 'url' }));
    else if (urls !== undefined && urls !== null) out.push({ target: String(urls), location: `${base}.urls`, kind: 'url' });
    const inc = ctx?.includePaths;
    if (Array.isArray(inc)) inc.forEach((p, j) => out.push({ target: String(p), location: `${base}.includePaths[${j}]`, kind: 'pattern' }));
    else if (inc !== undefined && inc !== null) out.push({ target: String(inc), location: `${base}.includePaths`, kind: 'pattern' });
    walk(ctx, base, out, new Set(['urls', 'includePaths', 'excludePaths']));
  });
  if (config && typeof config === 'object') {
    for (const [k, v] of Object.entries(config)) {
      if (k === 'env') {
        for (const [ek, ev] of Object.entries(v ?? {})) if (ek !== 'contexts') walk(ev, `env.${ek}`, out);
      } else {
        walk(v, k, out);
      }
    }
  }
  return out;
}

// 走訪任意巢狀結構：絕對 URL 字串一律視為目標；URL_KEYS 下的非絕對字串（例如相對路徑或未代入的變數）
// 也視為目標，使其因無法解析而被拒絕。
function walk(node, path, out, skipKeys = new Set()) {
  if (typeof node === 'string') {
    if (ABSOLUTE_URL.test(node.trim()) || node.includes('${')) out.push({ target: node, location: path, kind: 'url' });
    return;
  }
  if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`, out)); return; }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (skipKeys.has(k)) continue;
    const p = `${path}.${k}`;
    if (URL_KEYS.has(k) && typeof v === 'string' && v !== '' && !ABSOLUTE_URL.test(v.trim()) && !v.includes('${')) {
      out.push({ target: v, location: p, kind: 'url' });
      continue;
    }
    walk(v, p, out);
  }
}

/**
 * 取出 Java regex 開頭的字面前綴（支援 `^`、`\Q...\E` 與跳脫的標點）。
 * 遇到任何未跳脫的中繼字元或字母跳脫（如 `\d`）即停止。
 * @returns {{literal: string, rest: string}}
 */
export function regexLiteralPrefix(pattern) {
  let i = pattern.startsWith('^') ? 1 : 0;
  let literal = '';
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '\\') {
      const n = pattern[i + 1];
      if (n === undefined) break;
      if (n === 'Q') {
        const end = pattern.indexOf('\\E', i + 2);
        if (end < 0) { literal += pattern.slice(i + 2); i = pattern.length; break; }
        literal += pattern.slice(i + 2, end);
        i = end + 2;
        continue;
      }
      if (/[A-Za-z0-9]/.test(n)) break;
      literal += n;
      i += 2;
      continue;
    }
    if ('.[]{}()*+?|^$'.includes(c)) break;
    literal += c;
    i += 1;
  }
  return { literal, rest: pattern.slice(i) };
}

// 樣式中是否有未跳脫（且不在 \Q...\E 內）的 `|`。字元類別中的 `|` 也一併拒絕（保守）。
function hasUnescapedAlternation(pattern) {
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      if (pattern[i + 1] === 'Q') {
        const end = pattern.indexOf('\\E', i + 2);
        if (end < 0) return false;
        i = end + 1;
      } else {
        i += 1;
      }
      continue;
    }
    if (c === '|') return true;
  }
  return false;
}

/**
 * includePaths 樣式是否錨定在 allowlist 內的 origin。
 * @returns {string|null} 拒絕原因；null 表示允許
 */
export function patternRejectReason(pattern, origins) {
  if (typeof pattern !== 'string' || pattern === '') return 'empty_pattern';
  if (hasUnescapedAlternation(pattern)) return 'unanchored_alternation';
  const { literal, rest } = regexLiteralPrefix(pattern);
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)(.*)$/is.exec(literal);
  if (!m) return 'unanchored_pattern';
  const [, writtenOrigin, after] = m;
  const origin = normalizeOrigin(writtenOrigin, { requireOriginOnly: true });
  if (!origin) return 'invalid_origin';
  if (!origins.has(origin)) return 'not_in_allowlist';
  // origin 之後必須緊接 `/`（字面）或樣式結尾，避免 `http://host.*` 之類比對到 `http://host.evil`。
  if (after.startsWith('/')) return null;
  if (after === '' && (rest === '' || rest === '$')) return null;
  return 'unanchored_pattern';
}

/**
 * @param {object} config 已代入變數的 ZAP Automation Framework 計畫
 * @param {string[]|string} allowlist Target_Allowlist
 */
export function validateDastTargets(config, allowlist) {
  const { origins, invalid } = parseAllowlist(allowlist);
  const errors = [];
  if (origins.size === 0) errors.push('empty_allowlist');
  const targets = collectDastTargets(config);
  if (targets.length === 0) errors.push('no_targets');

  const details = [];
  for (const t of targets) {
    let reason = null;
    if (t.kind === 'pattern') {
      reason = patternRejectReason(t.target, origins);
    } else {
      const o = normalizeOrigin(t.target.trim());
      if (!o) reason = t.target.includes('${') ? 'unresolved_variable' : 'invalid_url';
      else if (!origins.has(o)) reason = 'not_in_allowlist';
    }
    if (reason) details.push({ target: t.target, location: t.location, reason });
  }
  const rejected = [...new Set(details.map((d) => d.target))];
  return { ok: errors.length === 0 && rejected.length === 0, rejected, details, invalidAllowlist: invalid, errors };
}

/** 本範本的速率、並行與時間上限（Req 7.4）。 */
export const DAST_LIMITS = Object.freeze({ maxThreads: 5, minDelayMs: 250, maxTotalMinutes: 60 });

/**
 * 檢查計畫中的執行緒數、請求間隔與各 job 時間上限總和。未設定的值視為不符合（ZAP 預設為依 CPU 核心數或無上限）。
 * @returns {{ok: boolean, problems: {job: string, field: string, reason: string}[]}}
 */
export function validateDastLimits(config, limits = DAST_LIMITS) {
  const problems = [];
  const jobs = Array.isArray(config?.jobs) ? config.jobs : [];
  let total = 0;
  jobs.forEach((job, i) => {
    const name = `jobs[${i}](${job?.type})`;
    const p = job?.parameters ?? {};
    const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
    if (job?.type === 'spider' || job?.type === 'spiderAjax') {
      if (job.type === 'spider' && !intIn(p.threadCount, 1, limits.maxThreads)) problems.push({ job: name, field: 'threadCount', reason: `須為 1..${limits.maxThreads}` });
      if (job.type === 'spiderAjax' && !intIn(p.numberOfBrowsers, 1, limits.maxThreads)) problems.push({ job: name, field: 'numberOfBrowsers', reason: `須為 1..${limits.maxThreads}` });
      if (!intIn(p.maxDuration, 1, limits.maxTotalMinutes)) problems.push({ job: name, field: 'maxDuration', reason: '須設定正整數分鐘' });
      else total += p.maxDuration;
    } else if (job?.type === 'activeScan') {
      if (!intIn(p.threadPerHost, 1, limits.maxThreads)) problems.push({ job: name, field: 'threadPerHost', reason: `須為 1..${limits.maxThreads}` });
      if (!Number.isInteger(p.delayInMs) || p.delayInMs < limits.minDelayMs) problems.push({ job: name, field: 'delayInMs', reason: `須 >= ${limits.minDelayMs}` });
      if (!intIn(p.maxScanDurationInMins, 1, limits.maxTotalMinutes)) problems.push({ job: name, field: 'maxScanDurationInMins', reason: '須設定正整數分鐘' });
      else total += p.maxScanDurationInMins;
    } else if (job?.type === 'passiveScan-wait') {
      if (!intIn(p.maxDuration, 1, limits.maxTotalMinutes)) problems.push({ job: name, field: 'maxDuration', reason: '須設定正整數分鐘' });
      else total += p.maxDuration;
    }
  });
  if (total > limits.maxTotalMinutes) problems.push({ job: '*', field: 'duration', reason: `各 job 時間上限合計 ${total} 分鐘，超過 ${limits.maxTotalMinutes}` });
  return { ok: problems.length === 0, problems };
}

/** 在解析後的物件上代入 `${NAME}`；未設定的變數保留原文。 */
export function substituteVars(node, env) {
  if (typeof node === 'string') {
    return node.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, name) => (typeof env?.[name] === 'string' ? env[name] : all));
  }
  if (Array.isArray(node)) return node.map((v) => substituteVars(v, env));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, substituteVars(v, env)]));
  }
  return node;
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function writeFile(path, text) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, text);
}

function main(argv, env) {
  const planPath = arg(argv, '--plan');
  const allowlist = arg(argv, '--allowlist') ?? env.DAST_TARGET_ALLOWLIST ?? '';
  if (!planPath) {
    console.error('用法：bun ci/dast/targets.mjs --plan <zap-automation.yaml> --allowlist <origin,...> [--render <out.yaml>] [--out <result.json>]');
    return 2;
  }
  let plan;
  try {
    plan = Bun.YAML.parse(readFileSync(planPath, 'utf8'));
  } catch (e) {
    console.error(`DAST 計畫無法解析：${planPath}（${e?.name ?? 'Error'}）`);
    return 2;
  }
  const rendered = substituteVars(plan, env);
  const targets = validateDastTargets(rendered, allowlist);
  const limits = validateDastLimits(rendered);
  const result = { ok: targets.ok && limits.ok, targets, limits };

  const out = arg(argv, '--out');
  if (out) writeFile(out, JSON.stringify(result, null, 2) + '\n');
  for (const e of targets.errors) console.error(`DAST 目標驗證失敗：${e}`);
  for (const a of targets.invalidAllowlist) console.error(`Target_Allowlist 項目無效：${a}`);
  for (const d of targets.details) console.error(`DAST 目標被拒絕：${d.target}（${d.location}，${d.reason}）`);
  for (const p of limits.problems) console.error(`DAST 限制不符：${p.job} ${p.field} ${p.reason}`);
  if (!result.ok) return 1;

  const render = arg(argv, '--render');
  // JSON 是 YAML 的子集，ZAP（SnakeYAML）可直接讀取；輸出內容即為已驗證的物件。
  if (render) writeFile(render, JSON.stringify(rendered, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, allowlist: [...parseAllowlist(allowlist).origins] }));
  return 0;
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
