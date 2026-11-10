// Feature: jenkins-cicd-deploy, Property 8: 安全政策評估
// **Validates: Requirements 6.4, 6.5, 6.6, 6.9, 7.8, 17.2, 23.2**
//
// 以獨立的參考實作（oracle）比對 evaluateFindings 的判定；例外到期日以評估日為中心 ±3 天產生，
// 涵蓋「到期日當日仍有效」的邊界。另以注入的 fs 驗證 CLI main() 對未完成掃描的處理。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { evaluateFindings, main } from '../ci/policy/evaluate.mjs';

const RUNS = { numRuns: 200 };
const DAY = 86_400_000;

// ---------------------------------------------------------------- 參考實作

const refNonEmpty = v => typeof v === 'string' && v.trim().length > 0;
const refValidDate = s => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const refComplete = e =>
  e !== null && typeof e === 'object' && !Array.isArray(e)
  && ['id', 'location', 'reason', 'approver', 'expires'].every(k => refNonEmpty(e[k]))
  && refValidDate(e.expires);

function oracle(findings, exceptions, today) {
  const valid = [];
  const invalidIdx = [];
  exceptions.forEach((e, i) => (refComplete(e) ? valid.push({ i, e }) : invalidIdx.push(i)));
  const expiredHits = new Map();
  const unresolved = []; // [findingIndex, reason]
  findings.forEach((f, fi) => {
    if (f.kind === 'secret') return unresolved.push([fi, 'secret']);
    if (f.scanner === 'security-suite') return unresolved.push([fi, 'security-suite']);
    if (f.severity === 'medium' || f.severity === 'low') return;
    // critical、high、unknown 或無法辨識 → 需要有效例外
    const matches = valid.filter(({ e }) => e.id === f.id && e.location === f.location);
    if (matches.some(({ e }) => today <= e.expires)) return;
    if (matches.length > 0) {
      for (const { i } of matches) expiredHits.set(i, (expiredHits.get(i) ?? 0) + 1);
      return unresolved.push([fi, 'exception-expired']);
    }
    unresolved.push([fi, 'no-exception']);
  });
  const expired = valid
    .filter(({ e }) => today > e.expires)
    .map(({ i }) => ({ index: i, matchedFindings: expiredHits.get(i) ?? 0 }));
  return { pass: unresolved.length === 0, unresolved, expired, invalidIdx };
}

// ---------------------------------------------------------------- 產生器

const fmt = ms => new Date(ms).toISOString().slice(0, 10);
const todayMsArb = fc.integer({ min: Date.UTC(2020, 0, 1) / DAY, max: Date.UTC(2035, 11, 31) / DAY }).map(d => d * DAY);

// 小型 id／location 池，讓例外與結果有高機率相符（含只差 id 或只差 location 的近似情形）。
const idArb = fc.constantFrom('CVE-2024-0001', 'CVE-2024-0002', 'GHSA-aaaa-bbbb-cccc', 'semgrep.sql-unsafe');
const locArb = fc.constantFrom('lodash', 'tesseract.js', 'server/accounts.js', 'src/app.js');
const severityArb = fc.constantFrom('critical', 'high', 'medium', 'low', 'unknown', 'severe', undefined);
const scannerArb = fc.constantFrom('osv-scanner', 'semgrep', 'gitleaks', 'trivy', 'zap', 'security-suite');
const kindArb = fc.constantFrom('secret', 'vulnerability', 'sast', 'dast');

const findingArb = fc.record({ scanner: scannerArb, kind: kindArb, id: idArb, location: locArb, severity: severityArb });

const textArb = fc.constantFrom('reviewed', 'risk accepted', 'alice', 'bob');
// 欄位值：通常為有效值，偶爾缺少、空字串、純空白或非字串。
const fieldArb = good => fc.oneof(
  { weight: 8, arbitrary: good },
  { weight: 1, arbitrary: fc.constantFrom(undefined, '', '   ', 42, null) },
);

const exceptionArb = todayMs => {
  const goodExpires = fc.integer({ min: -3, max: 3 }).map(off => fmt(todayMs + off * DAY));
  const expiresArb = fc.oneof(
    { weight: 10, arbitrary: goodExpires },
    { weight: 1, arbitrary: fc.constantFrom('2025-02-30', '2025-13-01', '20250101', '2025-1-1', undefined, '') },
  );
  return fc.record(
    { id: fieldArb(idArb), location: fieldArb(locArb), reason: fieldArb(textArb), approver: fieldArb(textArb), expires: expiresArb },
    { requiredKeys: [] },
  ).map(e => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)));
};

const caseArb = todayMsArb.chain(todayMs => fc.record({
  today: fc.constant(fmt(todayMs)),
  findings: fc.array(findingArb, { maxLength: 12 }),
  exceptions: fc.array(fc.oneof({ weight: 12, arbitrary: exceptionArb(todayMs) }, { weight: 1, arbitrary: fc.constantFrom(null, 'x', []) }), { maxLength: 8 }),
}));

// ---------------------------------------------------------------- Property 8

describe('Property 8: 安全政策評估', () => {
  test('evaluateFindings 與參考實作一致', () => {
    fc.assert(fc.property(caseArb, ({ today, findings, exceptions }) => {
      const want = oracle(findings, exceptions, today);
      const got = evaluateFindings(findings, exceptions, today);

      // (d) pass 若且唯若無未處理結果
      expect(got.pass).toBe(want.pass);
      expect(got.pass).toBe(got.unresolved.length === 0);

      // 未處理的結果集合與原因
      const unresolvedIdx = got.findings.map((f, i) => (f.blocking ? i : -1)).filter(i => i >= 0);
      expect(unresolvedIdx).toEqual(want.unresolved.map(([i]) => i));
      expect(got.unresolved.map(u => u.reason)).toEqual(want.unresolved.map(([, r]) => r));

      // (a) 秘密與安全測試套件一律未處理；(c) medium／low（非秘密、非安全套件）永不阻擋
      got.findings.forEach((f, i) => {
        const src = findings[i];
        if (src.kind === 'secret' || src.scanner === 'security-suite') expect(f.blocking).toBe(true);
        else if (src.severity === 'medium' || src.severity === 'low') expect(f.blocking).toBe(false);
        if (f.exception.status === 'applied') expect(today <= f.exception.expires).toBe(true);
      });

      // 過期例外與欄位不完整的例外
      expect(got.expired.map(e => ({ index: e.index, matchedFindings: e.matchedFindings }))).toEqual(want.expired);
      expect(got.invalidExceptions.map(e => e.index)).toEqual(want.invalidIdx);
      for (const inv of got.invalidExceptions) expect(inv.problems.length).toBeGreaterThan(0);
    }), RUNS);
  });

  test('到期日當日仍有效、隔日即過期', () => {
    const f = { scanner: 'osv-scanner', kind: 'vulnerability', id: 'CVE-2024-0001', location: 'lodash', severity: 'high' };
    const ex = { id: 'CVE-2024-0001', location: 'lodash', reason: 'r', approver: 'a', expires: '2026-03-10' };
    expect(evaluateFindings([f], [ex], '2026-03-10').pass).toBe(true);
    const next = evaluateFindings([f], [ex], '2026-03-11');
    expect(next.pass).toBe(false);
    expect(next.unresolved[0].reason).toBe('exception-expired');
    expect(next.expired).toEqual([{ index: 0, id: 'CVE-2024-0001', location: 'lodash', expires: '2026-03-10', matchedFindings: 1 }]);
  });

  test('秘密結果即使有相符的有效例外仍失敗', () => {
    const f = { scanner: 'gitleaks', kind: 'secret', id: 'aws-key', location: '.env', severity: 'low' };
    const ex = { id: 'aws-key', location: '.env', reason: 'r', approver: 'a', expires: '2099-01-01' };
    const r = evaluateFindings([f], [ex], '2026-01-01');
    expect(r.pass).toBe(false);
    expect(r.unresolved[0].reason).toBe('secret');
  });
});

// ---------------------------------------------------------------- CLI

function memFs(files) {
  const written = {};
  return {
    written,
    readFileSync(p) {
      if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[p];
    },
    mkdirSync() {},
    writeFileSync(p, data) { written[p] = data; },
  };
}

const COMMIT = 'a'.repeat(40);
const cliArgs = reports => ['--reports', ...reports, '--exceptions', 'ex.json', '--commit', COMMIT, '--out', 'out/policy.json', '--today', '2026-01-01'];
const quiet = { log: () => {}, error: () => {} };

describe('evaluate CLI', () => {
  test('complete:false 的報告視為掃描未完成，結束碼 1', () => {
    const fs = memFs({
      'ex.json': '[]',
      'osv.json': JSON.stringify({ scanner: 'osv-scanner', toolVersion: '2.0.0', complete: false, reason: '解析套件數為 0', findings: [] }),
    });
    expect(main(cliArgs(['osv.json']), { ...quiet, fs })).toBe(1);
    const report = JSON.parse(Object.values(fs.written)[0]);
    expect(report.pass).toBe(false);
    expect(report.incomplete).toHaveLength(1);
    expect(report.commit).toBe(COMMIT);
  });

  test('報告不存在時結束碼 1；完整且無阻擋結果時結束碼 0', () => {
    expect(main(cliArgs(['missing.json']), { ...quiet, fs: memFs({ 'ex.json': '[]' }) })).toBe(1);
    const fs = memFs({
      'ex.json': '{"exceptions":[]}',
      'sg.json': JSON.stringify({ scanner: 'semgrep', toolVersion: '1', complete: true, findings: [
        { scanner: 'semgrep', kind: 'sast', id: 'r', location: 'a.js', line: 1, severity: 'low' },
      ] }),
    });
    expect(main(cliArgs(['sg.json']), { ...quiet, fs })).toBe(0);
  });

  test('例外檔無法解析時結束碼 2', () => {
    expect(main(cliArgs(['x.json']), { ...quiet, fs: memFs({ 'ex.json': '{bad' }) })).toBe(2);
  });
});
