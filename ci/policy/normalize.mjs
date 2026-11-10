// 掃描報告正規化（Requirement 6.2、6.3、6.4、6.8、17.1；Design Data Models「Finding」、Components §10、Property 9）。
//
// 將各掃描工具的原始輸出轉為 Finding[]（形狀見 design.md）：
//   { scanner, kind, id, location, version?, line?, severity, redactedSnippet? }
// Gitleaks 結果另含選用欄位 commit（Req 6.4 要求保留 commit SHA 以定位秘密）。
//
// 純函式（皆不讀檔、不連網）：
//   normalizeOsv(doc)            osv-scanner v2 JSON（須以 --all-packages 產生，否則無法計算套件數）
//   normalizeSemgrep(doc)        Semgrep JSON
//   normalizeGitleaks(doc)       Gitleaks JSON（陣列）；丟棄 Match／Secret 等含秘密的欄位
//   normalizeTrivy(doc)          Trivy JSON（image 或 fs 掃描；須以 --list-all-pkgs 產生）
//   normalizeZap(doc)            OWASP ZAP traditional-json 報告
//   normalizeSecuritySuite(xml)  tests/security 的 JUnit XML
//   normalize(tool, raw)         分派器；raw 可為已解析物件或原始文字
// 每個函式回傳：
//   { scanner, complete:boolean, reason:string|null, toolVersion:string|null, stats, findings:Finding[] }
// complete 為 false 時代表掃描無法完成（Req 6.8、17.3），findings 一律為空陣列，呼叫端不得視為通過。
//
// 嚴重度：
//   CVSS 分數 ≥9.0 critical、≥7.0 high、≥4.0 medium、其餘 low；可由 CVSS v2／v3.x 向量計算基本分數；
//   無任何分數（含僅有 CVSS v4 向量而無數值）時為 unknown（評估器視為 high，fail closed）。
//   Semgrep：ERROR→high、WARNING→medium、INFO→low（新版 CRITICAL/HIGH/MEDIUM/LOW 直接對應）。
//   Trivy：取 CVSS 分數換算與 Trivy 標示中較嚴重者。ZAP：riskcode 3→high、2→medium、1／0→low。
//
// 輸出絕不包含秘密值：只複製 ID、套件名稱與版本、檔案路徑、行號、URL 路徑與 commit SHA，
// 不複製 Match、Secret、Code、程式碼片段、evidence、attack 或任何訊息內文。
//
// CLI：
//   bun ci/policy/normalize.mjs --tool <name> --in <report> --out <json> [--tool-version <v>]
//   <name>：osv-scanner | semgrep | gitleaks | trivy | zap | security-suite
//   結束碼：0 正規化完成；1 掃描無法完成（仍寫出 complete:false 的報告）；2 參數錯誤或無法讀寫檔案。

import * as nodeFs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOLS = Object.freeze(['osv-scanner', 'semgrep', 'gitleaks', 'trivy', 'zap', 'security-suite']);
export const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low', 'unknown']);

const RANK = { low: 1, medium: 2, high: 3, critical: 4 };

/** 掃描無法完成；reason 不得含報告內容或秘密值。 */
export class IncompleteScanError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'IncompleteScanError';
  }
}

const incomplete = reason => { throw new IncompleteScanError(reason); };

// ---------------------------------------------------------------- 嚴重度

/**
 * CVSS 分數（0..10）換算嚴重度；非有限數或超出範圍回傳 null。
 * @param {number} score
 * @returns {'critical'|'high'|'medium'|'low'|null}
 */
export function severityFromScore(score) {
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 10) return null;
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

/** 取較嚴重者；兩者皆無已知嚴重度時為 'unknown'。 */
export function maxSeverity(...values) {
  let best = null;
  for (const v of values) if (RANK[v] && (!best || RANK[v] > RANK[best])) best = v;
  return best ?? 'unknown';
}

function parseVector(vector, prefixRe) {
  const body = vector.replace(prefixRe, '');
  const metrics = {};
  for (const part of body.split('/')) {
    const m = /^([A-Za-z]+):([A-Za-z]+)$/.exec(part);
    if (!m || m[1] in metrics) return null;
    metrics[m[1]] = m[2];
  }
  return metrics;
}

// CVSS v3.1 規格的 Roundup（避免浮點誤差）。
function roundup31(x) {
  const n = Math.round(x * 100000);
  return n % 10000 === 0 ? n / 100000 : (Math.floor(n / 10000) + 1) / 10;
}

function cvss3Score(vector) {
  const m = parseVector(vector, /^CVSS:3\.[01]\//);
  if (!m) return null;
  const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[m.AV];
  const AC = { L: 0.77, H: 0.44 }[m.AC];
  const UI = { N: 0.85, R: 0.62 }[m.UI];
  const S = m.S;
  const CIA = { H: 0.56, L: 0.22, N: 0 };
  const [C, I, A] = [CIA[m.C], CIA[m.I], CIA[m.A]];
  if (S !== 'U' && S !== 'C') return null;
  const PR = (S === 'C' ? { N: 0.85, L: 0.68, H: 0.5 } : { N: 0.85, L: 0.62, H: 0.27 })[m.PR];
  if ([AV, AC, UI, PR, C, I, A].some(v => v === undefined)) return null;
  const iss = 1 - (1 - C) * (1 - I) * (1 - A);
  const impact = S === 'U' ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15);
  if (impact <= 0) return 0;
  const exploitability = 8.22 * AV * AC * PR * UI;
  return S === 'U'
    ? roundup31(Math.min(impact + exploitability, 10))
    : roundup31(Math.min(1.08 * (impact + exploitability), 10));
}

function cvss2Score(vector) {
  const m = parseVector(vector, /^\(?|\)?$/g);
  if (!m) return null;
  const AV = { L: 0.395, A: 0.646, N: 1 }[m.AV];
  const AC = { H: 0.35, M: 0.61, L: 0.71 }[m.AC];
  const Au = { M: 0.45, S: 0.56, N: 0.704 }[m.Au];
  const CIA = { N: 0, P: 0.275, C: 0.66 };
  const [C, I, A] = [CIA[m.C], CIA[m.I], CIA[m.A]];
  if ([AV, AC, Au, C, I, A].some(v => v === undefined)) return null;
  const impact = 10.41 * (1 - (1 - C) * (1 - I) * (1 - A));
  const exploitability = 20 * AV * AC * Au;
  const f = impact === 0 ? 0 : 1.176;
  return Math.round((0.6 * impact + 0.4 * exploitability - 1.5) * f * 10) / 10;
}

/**
 * 由數值、數值字串或 CVSS v2／v3.x 向量取得基本分數；無法計算（含 CVSS v4 向量）回傳 null。
 * @param {unknown} value
 * @returns {number|null}
 */
export function cvssScore(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 && value <= 10 ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return cvssScore(Number(s));
  if (/^CVSS:3\.[01]\//.test(s)) return cvss3Score(s);
  if (/^\(?AV:[LAN]\/AC:/.test(s)) return cvss2Score(s);
  return null;
}

function severityFromScores(scores) {
  const known = scores.map(cvssScore).filter(n => n !== null);
  return known.length === 0 ? 'unknown' : severityFromScore(Math.max(...known));
}

function severityFromLabel(label) {
  const v = typeof label === 'string' ? label.trim().toLowerCase() : '';
  return RANK[v] ? v : null;
}

// ---------------------------------------------------------------- 共用

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = v => (typeof v === 'string' && v.trim() !== '' ? v : null);
const toPosix = p => p.split('\\').join('/');

function positiveLine(v) {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function finding(fields) {
  const f = {
    scanner: fields.scanner,
    kind: fields.kind,
    id: fields.id,
    location: fields.location,
  };
  if (nonEmpty(fields.version)) f.version = fields.version;
  const line = positiveLine(fields.line);
  if (line !== undefined) f.line = line;
  f.severity = fields.severity;
  if (nonEmpty(fields.commit)) f.commit = fields.commit;
  return f;
}

function requireString(value, what) {
  const s = nonEmpty(typeof value === 'number' ? String(value) : value);
  return s ?? incomplete(`報告結構不符：缺少${what}`);
}

function asArray(value, what, { allowMissing = false } = {}) {
  if (Array.isArray(value)) return value;
  if (allowMissing && (value === undefined || value === null)) return [];
  return incomplete(`報告結構不符：${what}不是陣列`);
}

function run(scanner, impl, raw, toolVersion) {
  try {
    const out = impl(raw);
    return {
      scanner,
      complete: true,
      reason: null,
      toolVersion: nonEmpty(out.toolVersion) ?? nonEmpty(toolVersion) ?? null,
      stats: out.stats,
      findings: out.findings,
    };
  } catch (err) {
    if (!(err instanceof IncompleteScanError)) throw err;
    return { scanner, complete: false, reason: err.message, toolVersion: nonEmpty(toolVersion) ?? null, stats: null, findings: [] };
  }
}

// ---------------------------------------------------------------- osv-scanner

function osvImpl(doc) {
  if (!isObj(doc)) incomplete('報告結構不符：根節點不是物件');
  const results = asArray(doc.results, 'results', { allowMissing: true });
  const findings = [];
  let packages = 0;
  for (const result of results) {
    if (!isObj(result)) incomplete('報告結構不符：results 項目不是物件');
    for (const pkg of asArray(result.packages, 'packages', { allowMissing: true })) {
      if (!isObj(pkg) || !isObj(pkg.package)) incomplete('報告結構不符：packages 項目缺少 package');
      const name = requireString(pkg.package.name, '套件名稱');
      packages++;
      // groups[].max_severity 為該群組（含別名）的最高 CVSS 分數字串。
      const groupScore = new Map();
      for (const g of asArray(pkg.groups, 'groups', { allowMissing: true })) {
        if (!isObj(g)) continue;
        for (const gid of [...(Array.isArray(g.ids) ? g.ids : []), ...(Array.isArray(g.aliases) ? g.aliases : [])]) {
          if (typeof gid === 'string') groupScore.set(gid, g.max_severity);
        }
      }
      for (const vuln of asArray(pkg.vulnerabilities, 'vulnerabilities', { allowMissing: true })) {
        if (!isObj(vuln)) incomplete('報告結構不符：vulnerabilities 項目不是物件');
        const id = requireString(vuln.id, '漏洞識別碼');
        const scores = asArray(vuln.severity, 'severity', { allowMissing: true })
          .filter(isObj)
          .map(s => s.score);
        let severity = severityFromScores(scores);
        if (severity === 'unknown' && groupScore.has(id)) severity = severityFromScores([groupScore.get(id)]);
        findings.push(finding({
          scanner: 'osv-scanner',
          kind: 'vulnerability',
          id,
          location: name,
          version: pkg.package.version,
          severity,
        }));
      }
    }
  }
  if (packages === 0) incomplete('解析出的套件數為 0（掃描無法完成；需以 --all-packages 產生報告）');
  return { findings, stats: { results: findings.length, packages }, toolVersion: null };
}

// ---------------------------------------------------------------- Semgrep

const SEMGREP_SEVERITY = {
  ERROR: 'high',
  WARNING: 'medium',
  INFO: 'low',
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
};

function semgrepImpl(doc) {
  if (!isObj(doc)) incomplete('報告結構不符：根節點不是物件');
  const results = asArray(doc.results, 'results');
  const fatal = asArray(doc.errors, 'errors', { allowMissing: true })
    .filter(e => !isObj(e) || e.level === undefined || String(e.level).toLowerCase() === 'error');
  if (fatal.length > 0) incomplete(`Semgrep 回報 ${fatal.length} 個錯誤（掃描無法完成）`);
  if (isObj(doc.paths) && Array.isArray(doc.paths.scanned) && doc.paths.scanned.length === 0) {
    incomplete('Semgrep 未掃描任何檔案');
  }
  const findings = results.map(r => {
    if (!isObj(r)) incomplete('報告結構不符：results 項目不是物件');
    const label = isObj(r.extra) && typeof r.extra.severity === 'string' ? r.extra.severity.toUpperCase() : '';
    return finding({
      scanner: 'semgrep',
      kind: 'sast',
      id: requireString(r.check_id, '規則識別碼'),
      location: toPosix(requireString(r.path, '檔案路徑')),
      line: isObj(r.start) ? r.start.line : undefined,
      severity: SEMGREP_SEVERITY[label] ?? 'unknown',
    });
  });
  return { findings, stats: { results: findings.length }, toolVersion: nonEmpty(doc.version) };
}

// ---------------------------------------------------------------- Gitleaks

function gitleaksImpl(doc) {
  const leaks = asArray(doc, '根節點');
  // 只讀取 RuleID、File、StartLine、Commit；Match、Secret、Line、Message 等欄位一律不讀取。
  const findings = leaks.map(l => {
    if (!isObj(l)) incomplete('報告結構不符：項目不是物件');
    const commit = typeof l.Commit === 'string' && /^[0-9a-f]{7,64}$/i.test(l.Commit) ? l.Commit : undefined;
    return finding({
      scanner: 'gitleaks',
      kind: 'secret',
      id: requireString(l.RuleID, '規則識別碼'),
      location: toPosix(requireString(l.File, '檔案路徑')),
      line: l.StartLine,
      severity: 'high', // Gitleaks 無嚴重度；秘密不論嚴重度皆使建置失敗（Req 6.4）
      commit,
    });
  });
  return { findings, stats: { results: findings.length }, toolVersion: null };
}

// ---------------------------------------------------------------- Trivy

function trivyCvssSeverity(cvss) {
  if (!isObj(cvss)) return 'unknown';
  const scores = [];
  for (const source of Object.values(cvss)) {
    if (!isObj(source)) continue;
    for (const key of ['V40Score', 'V3Score', 'V2Score']) if (source[key] !== undefined) scores.push(source[key]);
    for (const key of ['V3Vector', 'V2Vector']) if (source[key] !== undefined) scores.push(source[key]);
  }
  return severityFromScores(scores);
}

function trivyImpl(doc) {
  if (!isObj(doc)) incomplete('報告結構不符：根節點不是物件');
  const results = asArray(doc.Results, 'Results', { allowMissing: true });
  const findings = [];
  let packages = 0;
  for (const r of results) {
    if (!isObj(r)) incomplete('報告結構不符：Results 項目不是物件');
    const target = toPosix(nonEmpty(r.Target) ?? '(unknown target)');
    packages += asArray(r.Packages, 'Packages', { allowMissing: true }).length;
    for (const v of asArray(r.Vulnerabilities, 'Vulnerabilities', { allowMissing: true })) {
      if (!isObj(v)) incomplete('報告結構不符：Vulnerabilities 項目不是物件');
      findings.push(finding({
        scanner: 'trivy',
        kind: 'vulnerability',
        id: requireString(v.VulnerabilityID, '漏洞識別碼'),
        location: requireString(v.PkgName, '套件名稱'),
        version: v.InstalledVersion,
        severity: maxSeverity(trivyCvssSeverity(v.CVSS), severityFromLabel(v.Severity)),
      }));
    }
    // 只讀取 RuleID、Severity、StartLine；Match 與 Code（含秘密所在行）一律不讀取。
    for (const s of asArray(r.Secrets, 'Secrets', { allowMissing: true })) {
      if (!isObj(s)) incomplete('報告結構不符：Secrets 項目不是物件');
      findings.push(finding({
        scanner: 'trivy',
        kind: 'secret',
        id: requireString(s.RuleID, '規則識別碼'),
        location: target,
        line: s.StartLine,
        severity: severityFromLabel(s.Severity) ?? 'unknown',
      }));
    }
  }
  if (packages === 0) incomplete('解析出的套件數為 0（掃描無法完成；需以 --list-all-pkgs 產生報告）');
  const toolVersion = isObj(doc.Trivy) ? nonEmpty(doc.Trivy.Version) : null;
  return { findings, stats: { results: findings.length, packages }, toolVersion };
}

// ---------------------------------------------------------------- OWASP ZAP

const ZAP_RISK = { 3: 'high', 2: 'medium', 1: 'low', 0: 'low' };

function urlPath(uri) {
  if (typeof uri !== 'string' || uri === '') return '/';
  try { return new URL(uri).pathname || '/'; } catch { return uri.split(/[?#]/)[0] || '/'; }
}

function zapImpl(doc) {
  if (!isObj(doc)) incomplete('報告結構不符：根節點不是物件');
  const sites = asArray(doc.site, 'site');
  if (sites.length === 0) incomplete('ZAP 報告不含任何掃描目標');
  // 每個（alertRef、URL 路徑）為一筆結果；位置使用路徑而非每次建置不同的 Test_Environment 位址，
  // 使 Approved_Exception 可跨建置比對。不複製 evidence、attack、param 或描述文字。
  const seen = new Set();
  const findings = [];
  let alerts = 0;
  for (const site of sites) {
    if (!isObj(site)) incomplete('報告結構不符：site 項目不是物件');
    for (const a of asArray(site.alerts, 'alerts', { allowMissing: true })) {
      if (!isObj(a)) incomplete('報告結構不符：alerts 項目不是物件');
      alerts++;
      const id = requireString(nonEmpty(a.alertRef) ?? a.pluginid, '規則識別碼');
      const severity = ZAP_RISK[Number(a.riskcode)] ?? 'unknown';
      const instances = asArray(a.instances, 'instances', { allowMissing: true });
      const paths = instances.length === 0 ? ['/'] : instances.map(i => urlPath(isObj(i) ? i.uri : undefined));
      for (const location of paths) {
        const key = `${id}\u0000${location}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push(finding({ scanner: 'zap', kind: 'dast', id, location, severity }));
      }
    }
  }
  return { findings, stats: { results: findings.length, alerts, sites: sites.length }, toolVersion: nonEmpty(doc['@version']) };
}

// ---------------------------------------------------------------- 安全測試套件（JUnit XML）

function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'amp') return '&';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

function xmlAttrs(text) {
  const attrs = {};
  for (const m of text.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1]] = decodeXml(m[2] ?? m[3]);
  return attrs;
}

function securitySuiteImpl(xml) {
  if (typeof xml !== 'string') incomplete('報告不是 XML 文字');
  const body = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  if (!/<testsuites?\b/.test(body)) incomplete('報告不是 JUnit XML');
  const findings = [];
  let tests = 0;
  for (const m of body.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    tests++;
    const inner = m[2] ?? '';
    // 失敗、錯誤或略過的案例都代表該類別未被驗證通過（Req 7.6，fail closed）。
    if (!/<(failure|error|skipped)\b/.test(inner)) continue;
    const attrs = xmlAttrs(m[1]);
    const name = requireString(attrs.name, '測試案例名稱');
    const tc = /\[(TC-[A-Za-z0-9-]+)\]/.exec(name);
    findings.push(finding({
      scanner: 'security-suite',
      kind: 'dast',
      id: tc ? tc[1] : name.trim(),
      location: toPosix(nonEmpty(attrs.file) ?? nonEmpty(attrs.classname) ?? 'tests/security'),
      line: attrs.line,
      severity: 'high',
    }));
  }
  if (tests === 0) incomplete('JUnit 報告不含任何測試案例');
  return { findings, stats: { results: findings.length, tests }, toolVersion: null };
}

// ---------------------------------------------------------------- 匯出

export const normalizeOsv = (doc, toolVersion) => run('osv-scanner', osvImpl, doc, toolVersion);
export const normalizeSemgrep = (doc, toolVersion) => run('semgrep', semgrepImpl, doc, toolVersion);
export const normalizeGitleaks = (doc, toolVersion) => run('gitleaks', gitleaksImpl, doc, toolVersion);
export const normalizeTrivy = (doc, toolVersion) => run('trivy', trivyImpl, doc, toolVersion);
export const normalizeZap = (doc, toolVersion) => run('zap', zapImpl, doc, toolVersion);
export const normalizeSecuritySuite = (xml, toolVersion) => run('security-suite', securitySuiteImpl, xml, toolVersion);

const NORMALIZERS = {
  'osv-scanner': normalizeOsv,
  semgrep: normalizeSemgrep,
  gitleaks: normalizeGitleaks,
  trivy: normalizeTrivy,
  zap: normalizeZap,
  'security-suite': normalizeSecuritySuite,
};

/**
 * 依工具名稱分派。raw 為字串時，除 security-suite（XML）外皆以 JSON 解析。
 * @param {string} tool
 * @param {unknown} raw
 * @param {{toolVersion?: string}} [opts]
 */
export function normalize(tool, raw, { toolVersion } = {}) {
  const fn = NORMALIZERS[tool];
  if (!fn) throw new RangeError(`未知的掃描工具：${String(tool)}`);
  let input = raw;
  if (tool !== 'security-suite' && typeof raw === 'string') {
    const text = raw.replace(/^\uFEFF/, '');
    if (text.trim() === '') {
      return { scanner: tool, complete: false, reason: '報告為空', toolVersion: nonEmpty(toolVersion) ?? null, stats: null, findings: [] };
    }
    try { input = JSON.parse(text); } catch {
      return { scanner: tool, complete: false, reason: '報告不是有效的 JSON', toolVersion: nonEmpty(toolVersion) ?? null, stats: null, findings: [] };
    }
  }
  return fn(input, toolVersion);
}

// ---------------------------------------------------------------- CLI

const USAGE = '用法：bun ci/policy/normalize.mjs --tool <' + TOOLS.join('|') + '> --in <report> --out <json> [--tool-version <v>]';

function parseArgs(argv) {
  const args = {};
  const keys = new Set(['--tool', '--in', '--out', '--tool-version']);
  for (let i = 0; i < argv.length; i++) {
    if (!keys.has(argv[i]) || i + 1 >= argv.length || argv[i].slice(2) in args) return null;
    args[argv[i].slice(2)] = argv[++i];
  }
  if (!args.tool || !args.in || !args.out || !TOOLS.includes(args.tool)) return null;
  return args;
}

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error, fs = nodeFs } = {}) {
  const args = parseArgs(argv);
  if (!args) {
    error(USAGE);
    return 2;
  }
  let raw;
  try {
    raw = fs.readFileSync(args.in, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    // 報告檔不存在即代表掃描未產生結果；仍寫出 complete:false 供 Build_Record 保存。
    raw = null;
  }
  const result = raw === null
    ? { scanner: args.tool, complete: false, reason: '報告檔不存在或無法讀取', toolVersion: nonEmpty(args['tool-version']) ?? null, stats: null, findings: [] }
    : normalize(args.tool, raw, { toolVersion: args['tool-version'] });
  try {
    fs.mkdirSync(dirname(resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(result, null, 2) + '\n');
  } catch {
    error('正規化失敗：無法寫入 --out');
    return 2;
  }
  const summary = { scanner: result.scanner, complete: result.complete, reason: result.reason, findings: result.findings.length, stats: result.stats };
  if (!result.complete) {
    error(JSON.stringify(summary));
    return 1;
  }
  log(JSON.stringify(summary));
  return 0;
}

const isMain = import.meta.main
  ?? (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) process.exitCode = main();
