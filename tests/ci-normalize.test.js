// Feature: jenkins-cicd-deploy, Property 9: 掃描報告正規化保留必要欄位
// **Validates: Requirements 6.2, 6.3**
//
// Gitleaks 的秘密欄位剝除已由 tests/ci-scrub.test.js（Property 10）涵蓋，這裡只檢查筆數與必要欄位。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import {
  cvssScore,
  normalize,
  normalizeGitleaks,
  normalizeOsv,
  normalizeSemgrep,
  normalizeTrivy,
  severityFromScore,
} from '../ci/policy/normalize.mjs';

const RUNS = { numRuns: 100 };
const RANK = { low: 1, medium: 2, high: 3, critical: 4 };

// 參考實作：CVSS 分數 → 嚴重度（設計文件的對照表）。
const refSeverity = score => (score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low');
const refMax = (...values) => {
  let best = null;
  for (const v of values) if (RANK[v] && (!best || RANK[v] > RANK[best])) best = v;
  return best ?? 'unknown';
};

// ---------------------------------------------------------------- 產生器

const nameArb = fc.stringMatching(/^[a-z@][a-z0-9._-]{0,15}$/);
const versionArb = fc.stringMatching(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/);
const vulnIdArb = fc.oneof(
  fc.stringMatching(/^CVE-20\d{2}-\d{4,6}$/),
  fc.stringMatching(/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/),
);
const tenths = fc.integer({ min: 0, max: 100 });
// osv-scanner 的 severity.score 可能是數值字串或數值；以「十分位整數」表示便於計算期望值。
const scoreArb = tenths.chain(n => fc.constantFrom((n / 10).toFixed(1), n / 10).map(raw => ({ n, raw })));

const osvVulnArb = fc.record({
  id: vulnIdArb,
  scores: fc.array(scoreArb, { maxLength: 3 }),
});
const osvPackageArb = fc.record({
  name: nameArb,
  version: versionArb,
  vulns: fc.array(osvVulnArb, { maxLength: 4 }),
});
// 至少一個套件，使掃描可完成。
const osvDocArb = fc.array(fc.array(osvPackageArb, { maxLength: 4 }), { minLength: 1, maxLength: 3 })
  .filter(results => results.some(pkgs => pkgs.length > 0));

const toOsvDoc = results => ({
  results: results.map((pkgs, i) => ({
    source: { path: `/src/app${i}/bun.lock`, type: 'lockfile' },
    packages: pkgs.map(p => ({
      package: { name: p.name, version: p.version, ecosystem: 'npm' },
      groups: [],
      vulnerabilities: p.vulns.map(v => ({
        id: v.id,
        summary: 'synthetic',
        severity: v.scores.map(s => ({ type: 'CVSS_V3', score: s.raw })),
      })),
    })),
  })),
});

const segmentArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/);
const pathArb = fc.tuple(fc.array(segmentArb, { minLength: 1, maxLength: 4 }), fc.constantFrom('/', '\\'))
  .map(([segs, sep]) => ({ raw: segs.join(sep) + '.js', posix: segs.join('/') + '.js' }));
const SEMGREP_MAP = {
  ERROR: 'high', WARNING: 'medium', INFO: 'low',
  CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low',
};
const semgrepLabelArb = fc.oneof(
  fc.constantFrom('ERROR', 'WARNING', 'INFO', 'error', 'Warning', 'info', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'),
  fc.constantFrom('INVENTORY', 'EXPERIMENT', ''),
);
const semgrepResultArb = fc.record({
  ruleId: fc.stringMatching(/^[a-z][a-z0-9.-]{0,30}$/),
  path: pathArb,
  line: fc.integer({ min: 1, max: 100_000 }),
  label: semgrepLabelArb,
});

const trivyVulnArb = fc.record({
  id: vulnIdArb,
  pkg: nameArb,
  version: versionArb,
  label: fc.constantFrom('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'),
  score: fc.option(tenths, { nil: undefined }),
});
const trivyResultArb = fc.record({
  packages: fc.integer({ min: 1, max: 5 }),
  vulns: fc.array(trivyVulnArb, { maxLength: 5 }),
});

// ---------------------------------------------------------------- 嚴重度換算

describe('Property 9: CVSS 嚴重度換算', () => {
  test('severityFromScore 依 9.0／7.0／4.0 門檻換算，超出 0..10 回傳 null', () => {
    fc.assert(
      fc.property(fc.double({ min: -5, max: 15, noNaN: true }), score => {
        const got = severityFromScore(score);
        if (score < 0 || score > 10) expect(got).toBeNull();
        else expect(got).toBe(refSeverity(score));
      }),
      RUNS,
    );
  });

  test('門檻邊界', () => {
    expect(severityFromScore(9.0)).toBe('critical');
    expect(severityFromScore(8.9)).toBe('high');
    expect(severityFromScore(7.0)).toBe('high');
    expect(severityFromScore(6.9)).toBe('medium');
    expect(severityFromScore(4.0)).toBe('medium');
    expect(severityFromScore(3.9)).toBe('low');
    expect(severityFromScore(0)).toBe('low');
    expect(severityFromScore(Number.NaN)).toBeNull();
  });

  test('cvssScore 解析數值字串與 CVSS v2／v3 向量，v4 向量無分數', () => {
    expect(cvssScore('7.5')).toBe(7.5);
    expect(cvssScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8);
    expect(cvssScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N')).toBe(6.1);
    expect(cvssScore('AV:N/AC:L/Au:N/C:P/I:P/A:P')).toBe(7.5);
    expect(cvssScore('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N')).toBeNull();
    expect(cvssScore('11')).toBeNull();
  });
});

// ---------------------------------------------------------------- osv-scanner

describe('Property 9: osv-scanner 正規化', () => {
  test('筆數相等，保留套件名稱、版本、漏洞 ID，嚴重度依最高分數換算', () => {
    fc.assert(
      fc.property(osvDocArb, results => {
        const out = normalizeOsv(toOsvDoc(results));
        const expected = results.flat().flatMap(p => p.vulns.map(v => ({
          scanner: 'osv-scanner',
          kind: 'vulnerability',
          id: v.id,
          location: p.name,
          version: p.version,
          severity: v.scores.length === 0 ? 'unknown' : refSeverity(Math.max(...v.scores.map(s => s.n)) / 10),
        })));
        expect(out.complete).toBe(true);
        expect(out.findings.length).toBe(expected.length);
        expect(out.findings).toEqual(expected);
        expect(out.stats.packages).toBe(results.flat().length);
      }),
      RUNS,
    );
  });

  test('解析出的套件數為 0 時回報掃描無法完成', () => {
    fc.assert(
      fc.property(fc.array(fc.constant([]), { maxLength: 3 }), results => {
        const out = normalizeOsv(toOsvDoc(results));
        expect(out.complete).toBe(false);
        expect(out.findings).toEqual([]);
        expect(out.reason).toContain('套件數為 0');
      }),
      RUNS,
    );
  });

  test('無分數時以 groups.max_severity 補足', () => {
    const doc = {
      results: [{
        packages: [{
          package: { name: 'lodash', version: '4.17.20' },
          groups: [{ ids: ['GHSA-aaaa-bbbb-cccc'], aliases: ['CVE-2021-23337'], max_severity: '7.2' }],
          vulnerabilities: [{ id: 'GHSA-aaaa-bbbb-cccc' }],
        }],
      }],
    };
    expect(normalizeOsv(doc).findings[0].severity).toBe('high');
  });
});

// ---------------------------------------------------------------- Semgrep

describe('Property 9: Semgrep 正規化', () => {
  test('筆數相等，保留規則 ID、檔案路徑（POSIX）、行號，嚴重度依對照表', () => {
    fc.assert(
      fc.property(fc.array(semgrepResultArb, { maxLength: 8 }), rs => {
        const doc = {
          version: '1.90.0',
          errors: [],
          paths: { scanned: ['server/http.js'] },
          results: rs.map(r => ({
            check_id: r.ruleId,
            path: r.path.raw,
            start: { line: r.line, col: 1 },
            end: { line: r.line, col: 2 },
            extra: { severity: r.label, message: 'm', lines: 'code' },
          })),
        };
        const out = normalizeSemgrep(doc);
        expect(out.complete).toBe(true);
        expect(out.toolVersion).toBe('1.90.0');
        expect(out.findings).toEqual(rs.map(r => ({
          scanner: 'semgrep',
          kind: 'sast',
          id: r.ruleId,
          location: r.path.posix,
          line: r.line,
          severity: SEMGREP_MAP[r.label.toUpperCase()] ?? 'unknown',
        })));
      }),
      RUNS,
    );
  });

  test('Semgrep 回報錯誤或未掃描任何檔案時掃描無法完成', () => {
    expect(normalizeSemgrep({ results: [], errors: [{ level: 'error' }] }).complete).toBe(false);
    expect(normalizeSemgrep({ results: [], errors: [], paths: { scanned: [] } }).complete).toBe(false);
  });
});

// ---------------------------------------------------------------- Trivy

describe('Property 9: Trivy 正規化', () => {
  test('筆數相等，保留套件與版本，嚴重度取 CVSS 與標示中較嚴重者', () => {
    fc.assert(
      fc.property(fc.array(trivyResultArb, { minLength: 1, maxLength: 3 }), rs => {
        const doc = {
          Trivy: { Version: '0.58.0' },
          Results: rs.map((r, i) => ({
            Target: `layer-${i}`,
            Packages: Array.from({ length: r.packages }, (_, k) => ({ Name: `p${k}`, Version: '1.0.0' })),
            Vulnerabilities: r.vulns.map(v => ({
              VulnerabilityID: v.id,
              PkgName: v.pkg,
              InstalledVersion: v.version,
              Severity: v.label,
              ...(v.score === undefined ? {} : { CVSS: { nvd: { V3Score: v.score / 10 } } }),
            })),
          })),
        };
        const out = normalizeTrivy(doc);
        expect(out.complete).toBe(true);
        expect(out.toolVersion).toBe('0.58.0');
        expect(out.findings).toEqual(rs.flatMap(r => r.vulns.map(v => ({
          scanner: 'trivy',
          kind: 'vulnerability',
          id: v.id,
          location: v.pkg,
          version: v.version,
          severity: refMax(v.score === undefined ? null : refSeverity(v.score / 10), v.label.toLowerCase()),
        }))));
      }),
      RUNS,
    );
  });

  test('不含任何套件時掃描無法完成', () => {
    const out = normalizeTrivy({ Results: [{ Target: 'x', Vulnerabilities: [] }] });
    expect(out.complete).toBe(false);
    expect(out.findings).toEqual([]);
  });
});

// ---------------------------------------------------------------- Gitleaks 與分派器

describe('Property 9: Gitleaks 筆數與分派器', () => {
  test('Gitleaks 筆數相等並保留規則 ID、路徑、行號', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ rule: fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/), path: pathArb, line: fc.integer({ min: 1, max: 9999 }) }), { maxLength: 6 }),
        leaks => {
          const out = normalizeGitleaks(leaks.map(l => ({ RuleID: l.rule, File: l.path.raw, StartLine: l.line, Secret: 'REDACTED', Match: 'REDACTED' })));
          expect(out.complete).toBe(true);
          expect(out.findings.map(f => [f.kind, f.id, f.location, f.line])).toEqual(leaks.map(l => ['secret', l.rule, l.path.posix, l.line]));
        },
      ),
      RUNS,
    );
  });

  test('normalize 以 JSON 文字分派的結果與直接呼叫相同', () => {
    fc.assert(
      fc.property(osvDocArb, results => {
        const doc = toOsvDoc(results);
        expect(normalize('osv-scanner', JSON.stringify(doc))).toEqual(normalizeOsv(doc));
      }),
      RUNS,
    );
  });

  test('空白或無效 JSON 視為掃描無法完成，未知工具拋出例外', () => {
    expect(normalize('semgrep', '  ').complete).toBe(false);
    expect(normalize('trivy', '{oops').complete).toBe(false);
    expect(() => normalize('unknown-tool', '{}')).toThrow(RangeError);
  });
});
