// 安全政策評估（Requirement 6.4–6.9、7.8、17.2、23.2、23.3；Design Data Models「Finding 與 Approved_Exception」、Property 8）。
//
// 純函式：
//   evaluateFindings(findings, exceptions, today)
//     → { pass, unresolved, expired, invalidExceptions, findings }
//   validateException(entry)      → string[]（問題清單；空陣列代表欄位完整）
//   parseExceptionsDocument(doc)  → ApprovedException[]（接受陣列或 { exceptions: [...] }）
//   isValidDate(s) / localToday(date)
//
// 判定規則（Property 8）：
//   (a) kind === 'secret' 的結果一律未處理，不論嚴重度或是否有例外（Req 6.4、17.2）。
//       scanner === 'security-suite' 的結果（Req 7.6 類別測試失敗）同樣一律未處理（Req 7.8）。
//   (b) critical／high／unknown（unknown 及任何無法辨識的嚴重度視為 high，fail closed）的結果，
//       僅在存在欄位完整（id、location、reason、approver、expires 皆為非空字串且 expires 為有效日期）、
//       id 與 location 完全相同、且 today <= expires 的例外時視為已處理（Req 6.5、6.9）。
//   (c) medium／low 結果只記錄，不使結果失敗（Req 6.5）。
//   (d) pass === (unresolved.length === 0)。
//   過期例外（today > expires）不套用，對應結果的原因為 'exception-expired'，例外列於 expired（Req 6.6）。
//   欄位不完整的例外列於 invalidExceptions 且不套用（Req 6.9）。
//
// today 為 'YYYY-MM-DD'，以 Pipeline 執行當下的本地日期判定（Build_Agent 的 TZ）；可注入以利測試。
//
// CLI：
//   bun ci/policy/evaluate.mjs --reports <normalized.json> [<normalized.json> ...]
//        --exceptions security/exceptions.json --commit <40 hex> --out <json> [--today YYYY-MM-DD]
//   --reports 為 ci/policy/normalize.mjs 的輸出。任一報告 complete:false、無法讀取或結構不符時，
//   視為掃描無法完成（Req 6.8、17.3、23.3），結果為未通過。
//   結束碼：0 通過；1 未通過（含掃描未完成）；2 參數錯誤、例外檔無法讀取／解析，或無法寫入 --out。
//   輸出報告不含秘密值：Finding 本身已由 normalize 移除秘密內容，此處只複製其欄位。

import * as nodeFs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BLOCKING_SEVERITIES = Object.freeze(['critical', 'high']);
const KNOWN_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const NORMALIZED_SCANNERS = new Set(['osv-scanner', 'semgrep', 'gitleaks', 'trivy', 'zap', 'security-suite']);
const EXCEPTION_FIELDS = Object.freeze(['id', 'location', 'reason', 'approver', 'expires']);

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = v => typeof v === 'string' && v.trim() !== '';

// ---------------------------------------------------------------- 日期

/** 'YYYY-MM-DD' 且為實際存在的日曆日期。 */
export function isValidDate(s) {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** 本地日期（依程序 TZ）格式化為 'YYYY-MM-DD'。 */
export function localToday(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ---------------------------------------------------------------- 例外

/**
 * 檢查單一 Approved_Exception 的欄位；回傳問題清單（欄位名稱:原因），空陣列代表有效。
 * @param {unknown} entry
 * @returns {string[]}
 */
export function validateException(entry) {
  if (!isObj(entry)) return ['entry:不是物件'];
  const problems = [];
  for (const field of EXCEPTION_FIELDS) {
    if (!nonEmpty(entry[field])) problems.push(`${field}:缺少或為空`);
  }
  if (nonEmpty(entry.expires) && !isValidDate(entry.expires)) problems.push('expires:不是有效的 YYYY-MM-DD 日期');
  return problems;
}

/**
 * 例外檔內容 → 例外陣列。接受陣列或 { exceptions: [...] }；結構不符時 throw。
 * @param {unknown} doc
 */
export function parseExceptionsDocument(doc) {
  if (Array.isArray(doc)) return doc;
  if (isObj(doc) && Array.isArray(doc.exceptions)) return doc.exceptions;
  throw new TypeError('例外檔結構不符：需為陣列或含 exceptions 陣列的物件');
}

const exceptionRef = (e, index) => ({
  index,
  id: isObj(e) && typeof e.id === 'string' ? e.id : null,
  location: isObj(e) && typeof e.location === 'string' ? e.location : null,
});

// ---------------------------------------------------------------- 評估

/** 有效嚴重度：無法辨識或 unknown 一律視為 high（fail closed）。 */
export function effectiveSeverity(severity) {
  return KNOWN_SEVERITIES.has(severity) ? severity : 'high';
}

/**
 * @param {object[]} findings   正規化後的 Finding[]
 * @param {object[]} exceptions Approved_Exception[]
 * @param {string}   today      'YYYY-MM-DD'
 */
export function evaluateFindings(findings, exceptions, today) {
  if (!isValidDate(today)) throw new RangeError('today 必須為有效的 YYYY-MM-DD 日期');
  if (!Array.isArray(findings)) throw new TypeError('findings 必須為陣列');
  if (!Array.isArray(exceptions)) throw new TypeError('exceptions 必須為陣列');

  const valid = [];
  const invalidExceptions = [];
  exceptions.forEach((e, index) => {
    const problems = validateException(e);
    if (problems.length > 0) invalidExceptions.push({ ...exceptionRef(e, index), problems });
    else valid.push({ index, e });
  });

  const expiredMatches = new Map(); // index → 對應的結果數
  const annotated = [];
  const unresolved = [];

  for (const f of findings) {
    const fin = isObj(f) ? f : {};
    const severity = effectiveSeverity(fin.severity);
    let exception;
    let blocking;
    let reason = null;

    if (fin.kind === 'secret') {
      blocking = true;
      reason = 'secret';
      exception = { status: 'not-applicable' };
    } else if (fin.scanner === 'security-suite') {
      blocking = true;
      reason = 'security-suite';
      exception = { status: 'not-applicable' };
    } else if (BLOCKING_SEVERITIES.includes(severity)) {
      const matches = valid.filter(({ e }) => e.id === fin.id && e.location === fin.location);
      const active = matches.find(({ e }) => today <= e.expires);
      if (active) {
        blocking = false;
        exception = {
          status: 'applied',
          index: active.index,
          approver: active.e.approver,
          expires: active.e.expires,
        };
      } else if (matches.length > 0) {
        blocking = true;
        reason = 'exception-expired';
        for (const { index } of matches) expiredMatches.set(index, (expiredMatches.get(index) ?? 0) + 1);
        exception = { status: 'expired', indexes: matches.map(m => m.index) };
      } else {
        blocking = true;
        reason = 'no-exception';
        exception = { status: 'none' };
      }
    } else {
      blocking = false;
      exception = { status: 'not-required' };
    }

    const entry = { ...fin, effectiveSeverity: severity, blocking, exception };
    annotated.push(entry);
    if (blocking) unresolved.push({ ...entry, reason });
  }

  // 所有欄位完整但已過期的例外皆列出；matchedFindings 為因過期而未處理的結果數。
  const expired = valid
    .filter(({ e }) => today > e.expires)
    .map(({ index, e }) => ({ index, id: e.id, location: e.location, expires: e.expires, matchedFindings: expiredMatches.get(index) ?? 0 }));

  return { pass: unresolved.length === 0, unresolved, expired, invalidExceptions, findings: annotated };
}

// ---------------------------------------------------------------- CLI

const USAGE = '用法：bun ci/policy/evaluate.mjs --reports <normalized.json> [...] --exceptions <exceptions.json> --commit <40 hex> --out <json> [--today YYYY-MM-DD]';

function parseArgs(argv) {
  const args = { reports: [] };
  const single = new Set(['--exceptions', '--commit', '--out', '--today']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reports') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args.reports.push(argv[++i]);
      continue;
    }
    if (!single.has(a) || i + 1 >= argv.length || a.slice(2) in args) return null;
    args[a.slice(2)] = argv[++i];
  }
  if (args.reports.length === 0 || !args.exceptions || !args.out) return null;
  if (!/^[0-9a-f]{40}$/i.test(args.commit ?? '')) return null;
  if (args.today !== undefined && !isValidDate(args.today)) return null;
  return args;
}

function loadReport(fs, path) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return { scanner: null, toolVersion: null, complete: false, reason: '報告檔不存在、無法讀取或不是有效的 JSON', findings: [], file: path };
  }
  if (!isObj(doc) || !NORMALIZED_SCANNERS.has(doc.scanner) || typeof doc.complete !== 'boolean' || !Array.isArray(doc.findings)) {
    return { scanner: isObj(doc) && typeof doc.scanner === 'string' ? doc.scanner : null, toolVersion: null, complete: false, reason: '報告結構不符（非 normalize 輸出）', findings: [], file: path };
  }
  return {
    scanner: doc.scanner,
    toolVersion: typeof doc.toolVersion === 'string' ? doc.toolVersion : null,
    complete: doc.complete,
    reason: doc.complete ? null : (typeof doc.reason === 'string' ? doc.reason : '掃描無法完成'),
    findings: doc.complete ? doc.findings : [],
    file: path,
  };
}

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error, fs = nodeFs, now = () => new Date() } = {}) {
  const args = parseArgs(argv);
  if (!args) {
    error(USAGE);
    return 2;
  }

  let exceptions;
  try {
    exceptions = parseExceptionsDocument(JSON.parse(fs.readFileSync(args.exceptions, 'utf8').replace(/^\uFEFF/, '')));
  } catch {
    error('評估失敗：無法讀取或解析 --exceptions');
    return 2;
  }

  const today = args.today ?? localToday(now());
  const scans = args.reports.map(p => loadReport(fs, p));
  const incomplete = scans.filter(s => !s.complete).map(s => ({ file: s.file, scanner: s.scanner, reason: s.reason }));
  const result = evaluateFindings(scans.flatMap(s => s.findings), exceptions, today);
  const pass = result.pass && incomplete.length === 0;

  const report = {
    schema: 1,
    commit: args.commit.toLowerCase(),
    evaluatedAt: now().toISOString(),
    today,
    pass,
    scans: scans.map(s => ({ file: s.file, scanner: s.scanner, toolVersion: s.toolVersion, complete: s.complete, reason: s.reason, findings: s.findings.length })),
    incomplete,
    exceptionsFile: args.exceptions,
    exceptionsApplied: result.findings.filter(f => f.exception.status === 'applied').length,
    findings: result.findings,
    unresolved: result.unresolved,
    expired: result.expired,
    invalidExceptions: result.invalidExceptions,
  };

  try {
    fs.mkdirSync(dirname(resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n');
  } catch {
    error('評估失敗：無法寫入 --out');
    return 2;
  }

  const summary = {
    pass,
    commit: report.commit,
    findings: result.findings.length,
    unresolved: result.unresolved.length,
    incomplete: incomplete.length,
    expired: result.expired.length,
    invalidExceptions: result.invalidExceptions.length,
  };
  if (!pass) {
    error(JSON.stringify(summary));
    return 1;
  }
  log(JSON.stringify(summary));
  return 0;
}

const isMain = import.meta.main
  ?? (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) process.exitCode = main();
