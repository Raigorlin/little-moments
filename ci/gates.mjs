// Release_Gate 評估（Req 4.4、23.1、23.2、23.3、23.5；Design Property 5、45）。
//
// 純函式：
//   junitGate(summary)            → { pass, unmet: string[] }
//   parseJunitSummary(xml)        → { tests, failures, errors, skipped } | null
//   mergeJunitSummaries(list)     → 加總後的摘要 | null（任一份為 null 即為 null）
//   inventoryGate(compareResult)  → { pass, missingReport, unmet: string[] }
//   runGates(gates, { commit, now }) → { pass, failedGate, results: GateResult[], skipped: string[] }
//
// runGates 依 QA → 安全 → 映像 → Staging → 正式核准 → 上線後 的順序評估，於第一個非通過的關卡停止；
// 拋出例外、逾時、缺少報告或結果格式不明一律視為未通過（fail closed）。本模組不提供任何略過或放寬關卡的選項（Req 23.4）。
//
// CLI：
//   bun ci/gates.mjs junit --gate QA --commit <sha> [--out gate.json] [--inventory reports/qa-inventory.json]
//                          [--stage-error <訊息>] <junit.xml>...
//   --inventory   另以 inventoryGate 檢查 QA_Inventory 比對結果（「QA」關卡：Req 5.4、5.5、23.2）
//   --stage-error 檢查階段已執行錯誤或逾時：關卡一律未通過並記錄原因（Req 23.3）
//   結束碼：0 通過；1 未通過（含報告缺失或無法解析）；2 參數錯誤。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GATE_ORDER = Object.freeze(['QA', '安全', '映像', 'Staging', '正式核准', '上線後']);

const COUNT_KEYS = ['tests', 'failures', 'errors'];
const isCount = (n) => Number.isSafeInteger(n) && n >= 0;

/**
 * 測試結果關卡：通過若且唯若 tests > 0 且 failures === 0 且 errors === 0。
 * 摘要缺失或欄位不是非負整數時視為未通過。
 */
export function junitGate(summary) {
  if (!summary || typeof summary !== 'object') return { pass: false, unmet: ['缺少測試結果摘要'] };
  const unmet = [];
  for (const key of COUNT_KEYS) {
    if (!isCount(summary[key])) unmet.push(`${key} 不是非負整數`);
  }
  if (summary.skipped !== undefined && !isCount(summary.skipped)) unmet.push('skipped 不是非負整數');
  if (unmet.length) return { pass: false, unmet };
  if (summary.tests === 0) unmet.push('執行的測試數量為 0');
  if (summary.failures > 0) unmet.push(`失敗數為 ${summary.failures}`);
  if (summary.errors > 0) unmet.push(`錯誤數為 ${summary.errors}`);
  return { pass: unmet.length === 0, unmet };
}

function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  if (!m) return undefined;
  return /^\d+$/.test(m[1]) ? Number(m[1]) : NaN;
}

function countsFromTag(tag) {
  const tests = attr(tag, 'tests');
  const failures = attr(tag, 'failures') ?? 0;
  const errors = attr(tag, 'errors') ?? 0;
  const skipped = attr(tag, 'skipped') ?? 0;
  const out = { tests, failures, errors, skipped };
  return Object.values(out).every(isCount) ? out : null;
}

/**
 * 由 JUnit XML 讀取摘要：有 <testsuites> 且帶 tests 屬性時採用其屬性，否則加總所有 <testsuite>。
 * 無法解析時回傳 null（關卡視為未通過）。
 */
export function parseJunitSummary(xml) {
  if (typeof xml !== 'string' || xml.trim() === '') return null;
  const root = /<testsuites\b[^>]*>/.exec(xml);
  if (root && /\stests\s*=/.test(root[0])) return countsFromTag(root[0]);
  const suites = xml.match(/<testsuite\b[^>]*>/g);
  if (!suites || suites.length === 0) return null;
  return mergeJunitSummaries(suites.map(countsFromTag));
}

export function mergeJunitSummaries(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const total = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  for (const s of list) {
    if (!s) return null;
    for (const k of Object.keys(total)) total[k] += s[k] ?? 0;
  }
  return total;
}

const STATUSES = new Set(['pass', 'fail', 'error', 'timeout', 'missing_report']);

function toStrings(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

/** 將檢查結果正規化為 { status, unmet, reports }；不明格式視為 error。 */
function normalizeOutcome(entry, outcome) {
  if (outcome === undefined || outcome === null) {
    return { status: 'missing_report', unmet: ['未產生判定所需的報告'], reports: [] };
  }
  if (typeof outcome !== 'object') return { status: 'error', unmet: ['關卡結果格式無效'], reports: [] };
  let status;
  if (typeof outcome.status === 'string') status = STATUSES.has(outcome.status) ? outcome.status : 'error';
  else if (typeof outcome.pass === 'boolean') status = outcome.pass ? 'pass' : 'fail';
  else status = 'error';
  const unmet = toStrings(outcome.unmet);
  const reports = toStrings(outcome.reports);
  // 宣告的必要報告缺任一份 → 未通過（Req 23.3）。
  const required = toStrings(entry.requiredReports);
  const missing = required.filter((r) => !reports.includes(r));
  if (status === 'pass' && missing.length) {
    return { status: 'missing_report', unmet: [...unmet, ...missing.map((r) => `缺少報告 ${r}`)], reports };
  }
  if (status === 'pass' && unmet.length) status = 'fail';
  if (status !== 'pass' && unmet.length === 0) {
    unmet.push({ fail: '未符合通過條件', error: '檢查階段執行錯誤', timeout: '檢查階段逾時', missing_report: '未產生判定所需的報告' }[status]);
  }
  return { status, unmet, reports };
}

/**
 * 依 GATE_ORDER 評估關卡，於第一個非通過關卡停止，之後的關卡不被評估（其 check 不會被呼叫）。
 * @param {{gate: string, check?: (() => object) | object, requiredReports?: string[]}[]} gates
 *   check 可為同步函式或已算好的結果：{ pass:boolean } 或 { status:'pass'|'fail'|'error'|'timeout'|'missing_report' }，
 *   可附 unmet 與 reports。
 * @param {{commit?: string, now?: () => Date}} [opts]
 */
export function runGates(gates, { commit = '未執行', now = () => new Date() } = {}) {
  if (!Array.isArray(gates)) throw new TypeError('gates 必須是陣列');
  const seen = new Set();
  for (const g of gates) {
    if (!g || !GATE_ORDER.includes(g.gate)) throw new TypeError(`未知的 Release_Gate：${g?.gate}`);
    if (seen.has(g.gate)) throw new TypeError(`重複的 Release_Gate：${g.gate}`);
    seen.add(g.gate);
  }
  const ordered = [...gates].sort((a, b) => GATE_ORDER.indexOf(a.gate) - GATE_ORDER.indexOf(b.gate));
  const results = [];
  let failedGate = null;
  for (const entry of ordered) {
    if (failedGate) break;
    let raw;
    try {
      raw = typeof entry.check === 'function' ? entry.check() : entry.check;
      if (raw && typeof raw.then === 'function') raw = { status: 'error', unmet: ['關卡檢查不可為非同步'] };
    } catch {
      raw = { status: 'error', unmet: ['檢查階段執行錯誤'] };
    }
    const o = normalizeOutcome(entry, raw);
    const result = {
      gate: entry.gate,
      pass: o.status === 'pass',
      status: o.status,
      evaluatedAt: now().toISOString(),
      commit,
      unmet: o.unmet,
      reports: o.reports,
    };
    results.push(result);
    if (!result.pass) failedGate = entry.gate;
  }
  const evaluated = new Set(results.map((r) => r.gate));
  return {
    pass: failedGate === null,
    failedGate,
    results,
    skipped: ordered.map((g) => g.gate).filter((g) => !evaluated.has(g)),
  };
}

const MAX_LISTED_IDS = 50;

function listIds(ids) {
  const shown = ids.slice(0, MAX_LISTED_IDS).map((id) => String(id).slice(0, 64));
  return ids.length > MAX_LISTED_IDS ? `${shown.join(', ')} 等 ${ids.length} 項` : shown.join(', ');
}

/**
 * QA_Inventory 比對結果關卡（Req 5.4、5.5、23.2）：輸入為 `bun scripts/qa-inventory.mjs compare --out` 的 JSON。
 * 通過若且唯若 command === 'compare'、ok === true、items 非空且每個項目 status 為 pass，
 * 且 failed／missing 皆為空陣列。缺失、無法解析或格式不明一律未通過（fail closed）。
 */
export function inventoryGate(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.command !== 'compare') {
    return { pass: false, missingReport: true, unmet: ['QA_Inventory 比對結果缺失或無法解析'] };
  }
  const items = Array.isArray(doc.items) ? doc.items : null;
  const failed = Array.isArray(doc.failed) ? doc.failed : null;
  const missing = Array.isArray(doc.missing) ? doc.missing : null;
  if (!items || !failed || !missing) {
    return { pass: false, missingReport: false, unmet: ['QA_Inventory 比對結果格式無效'] };
  }
  const unmet = [];
  if (items.length === 0) unmet.push('QA_Inventory 比對結果沒有任何項目');
  if (failed.length) unmet.push(`QA_Inventory 失敗項目：${listIds(failed)}`);
  if (missing.length) unmet.push(`QA_Inventory 缺少測試項目：${listIds(missing)}`);
  const notPass = items.filter((i) => i?.status !== 'pass').map((i) => i?.id ?? '(無 ID)')
    .filter((id) => !failed.includes(id) && !missing.includes(id));
  if (notPass.length) unmet.push(`QA_Inventory 未通過項目：${listIds(notPass)}`);
  if (doc.ok !== true && unmet.length === 0) unmet.push('QA_Inventory 比對結果未通過');
  return { pass: unmet.length === 0, missingReport: false, unmet };
}

// --stage-error 的值來自 Jenkinsfile 的固定訊息；仍限制長度與字元，避免寫入 Build_Record 時夾帶控制字元。
const STAGE_ERROR_RE = /^[^\u0000-\u001f\u007f]{1,200}$/;

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { cmd, files: [], gate: 'QA', commit: '未執行', out: null, inventory: null, 'stage-error': null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--gate' || a === '--commit' || a === '--out' || a === '--inventory' || a === '--stage-error') {
      if (i + 1 >= rest.length) return null;
      opts[a.slice(2)] = rest[++i];
    } else opts.files.push(a);
  }
  if (opts['stage-error'] !== null && !STAGE_ERROR_RE.test(opts['stage-error'])) return null;
  return opts;
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  const opts = parseArgs(argv);
  if (!opts || opts.cmd !== 'junit' || opts.files.length === 0 || !GATE_ORDER.includes(opts.gate)) {
    error('用法：bun ci/gates.mjs junit --gate <關卡> --commit <sha> [--out gate.json] [--inventory qa-inventory.json] [--stage-error <訊息>] <junit.xml>...');
    return 2;
  }
  const summaries = opts.files.map((f) => {
    try { return parseJunitSummary(readFileSync(f, 'utf8')); } catch { return null; }
  });
  const summary = mergeJunitSummaries(summaries);
  const inventory = opts.inventory ? inventoryGate(readJson(opts.inventory)) : null;
  const reports = opts.inventory ? [...opts.files, opts.inventory] : opts.files;
  const run = runGates([{
    gate: opts.gate,
    check: () => {
      // 檢查階段執行錯誤或逾時 → 關卡未通過（Req 23.3），即使已產生的報告看似通過。
      // JUnit 摘要同時缺失時，在階段錯誤之後列出缺少的報告（Components 第 24.4 節）；狀態仍為 error。
      if (opts['stage-error']) {
        const missing = summary ? [] : ['JUnit 報告缺失或無法解析'];
        return { status: 'error', unmet: [`檢查階段執行錯誤：${opts['stage-error']}`, ...missing, ...(inventory?.unmet ?? [])], reports };
      }
      if (!summary) return { status: 'missing_report', unmet: ['JUnit 報告缺失或無法解析', ...(inventory?.unmet ?? [])], reports };
      const junit = junitGate(summary);
      if (inventory?.missingReport) return { status: 'missing_report', unmet: [...junit.unmet, ...inventory.unmet], reports };
      const unmet = [...junit.unmet, ...(inventory?.unmet ?? [])];
      return { pass: unmet.length === 0, unmet, reports };
    },
  }], { commit: opts.commit });
  const result = { ...run.results[0], summary };
  if (inventory) result.inventory = { pass: inventory.pass };
  if (opts.out) {
    mkdirSync(dirname(resolve(opts.out)), { recursive: true });
    writeFileSync(opts.out, JSON.stringify(result, null, 2) + '\n');
  }
  log(JSON.stringify(result));
  if (!result.pass) error(`Release_Gate ${result.gate} 未通過：${result.unmet.join('；')}`);
  return result.pass ? 0 : 1;
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
