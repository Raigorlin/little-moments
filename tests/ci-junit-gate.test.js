// Feature: jenkins-cicd-deploy, Property 5: 測試結果關卡
// **Validates: Requirements 4.4, 23.2**
import { afterAll, describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { junitGate, parseJunitSummary, mergeJunitSummaries, inventoryGate, main } from '../ci/gates.mjs';

const RUNS = { numRuns: 200 };

const oracle = (s) => s.tests > 0 && s.failures === 0 && s.errors === 0;

const count = fc.oneof(fc.constant(0), fc.nat({ max: 5 }), fc.nat({ max: 100_000 }));
const summaryArb = fc.record({ tests: count, failures: count, errors: count, skipped: count });

// XML 中的名稱：只含不需跳脫的字元，另以 &quot; 嵌入看似屬性的文字。
const nameArb = fc.oneof(
  fc.stringMatching(/^[A-Za-z0-9 _./-]{0,20}$/),
  fc.constant('weird &quot; tests=&quot;999&quot;'),
);

const sum = (list) =>
  list.reduce(
    (a, s) => ({
      tests: a.tests + s.tests,
      failures: a.failures + s.failures,
      errors: a.errors + s.errors,
      skipped: a.skipped + s.skipped,
    }),
    { tests: 0, failures: 0, errors: 0, skipped: 0 },
  );

// 屬性順序隨機、可省略為 0 的 failures/errors/skipped（JUnit 慣例預設 0）。
function attrs(counts, extra, { omitZero, order }) {
  const pairs = [...extra];
  for (const k of ['tests', 'failures', 'errors', 'skipped']) {
    if (k !== 'tests' && omitZero && counts[k] === 0) continue;
    pairs.push([k, String(counts[k])]);
  }
  const sorted = order.length ? pairs.map((p, i) => [order[i % order.length] + i, p]).sort((a, b) => a[0] - b[0]).map((x) => x[1]) : pairs;
  return sorted.map(([k, v]) => ` ${k}="${v}"`).join('');
}

function suiteXml(name, counts, style, opts) {
  const extra = style === 'bun'
    ? [['name', name], ['file', `tests/${name || 'x'}.test.js`], ['assertions', '3'], ['time', '0.01']]
    : [['name', name], ['timestamp', '2026-01-01T00:00:00.000Z'], ['hostname', 'desktop'], ['time', '1.5']];
  const cases = Array.from({ length: Math.min(counts.tests, 3) }, (_, i) => `    <testcase name="case ${i}" classname="${name}" time="0.001"/>`);
  return `  <testsuite${attrs(counts, extra, opts)}>\n${cases.join('\n')}\n  </testsuite>`;
}

// 產生 Bun 或 Playwright 風格的 JUnit 文件；root 可帶或不帶總數。
const docArb = fc
  .record({
    style: fc.constantFrom('bun', 'playwright'),
    suites: fc.array(fc.record({ name: nameArb, counts: summaryArb }), { minLength: 1, maxLength: 6 }),
    rootTotals: fc.boolean(),
    decl: fc.boolean(),
    omitZero: fc.boolean(),
    order: fc.array(fc.nat({ max: 50 }), { maxLength: 8 }),
  })
  .map(({ style, suites, rootTotals, decl, omitZero, order }) => {
    const total = sum(suites.map((s) => s.counts));
    const rootExtra = style === 'bun' ? [['name', 'bun test'], ['time', '0.2']] : [['id', ''], ['name', ''], ['time', '2.0']];
    const rootAttrs = rootTotals ? attrs(total, rootExtra, { omitZero, order }) : rootExtra.map(([k, v]) => ` ${k}="${v}"`).join('');
    const body = suites.map((s) => suiteXml(s.name, s.counts, style, { omitZero, order })).join('\n');
    const xml = `${decl ? '<?xml version="1.0" encoding="UTF-8"?>\n' : ''}<testsuites${rootAttrs}>\n${body}\n</testsuites>\n`;
    return { xml, total };
  });

describe('Property 5: 測試結果關卡', () => {
  test('junitGate 通過若且唯若 tests > 0 且 failures === 0 且 errors === 0', () => {
    fc.assert(
      fc.property(summaryArb, fc.boolean(), (s, dropSkipped) => {
        const input = dropSkipped ? { tests: s.tests, failures: s.failures, errors: s.errors } : s;
        const r = junitGate(input);
        expect(r.pass).toBe(oracle(s));
        expect(r.unmet.length === 0).toBe(r.pass);
      }),
      RUNS,
    );
  });

  test('skipped 數量不影響判定', () => {
    fc.assert(
      fc.property(summaryArb, count, (s, skipped) => {
        expect(junitGate({ ...s, skipped }).pass).toBe(junitGate(s).pass);
      }),
      RUNS,
    );
  });

  test('缺失或欄位無效的摘要一律未通過', () => {
    const bad = fc.oneof(
      fc.integer({ max: -1 }),
      fc.double({ noInteger: true }),
      fc.constant(NaN),
      fc.constant(Number.MAX_SAFE_INTEGER + 2),
      fc.string(),
      fc.constant(null),
      fc.constant(undefined),
    );
    fc.assert(
      fc.property(summaryArb, fc.constantFrom('tests', 'failures', 'errors', 'skipped'), bad, (s, key, v) => {
        if (key === 'skipped' && v === undefined) return; // skipped 可省略
        expect(junitGate({ ...s, [key]: v }).pass).toBe(false);
      }),
      RUNS,
    );
    for (const v of [null, undefined, 0, 'x', true]) expect(junitGate(v).pass).toBe(false);
  });

  test('parseJunitSummary 對產生的 JUnit 文件回傳與產生計數相同的總和', () => {
    fc.assert(
      fc.property(docArb, ({ xml, total }) => {
        const parsed = parseJunitSummary(xml);
        expect(parsed).toEqual(total);
        expect(junitGate(parsed).pass).toBe(oracle(total));
      }),
      RUNS,
    );
  });

  test('無法解析的 XML 回傳 null，關卡未通過', () => {
    const notJunit = fc.string().filter((s) => !s.includes('<testsuite'));
    const badCount = fc.oneof(fc.constant('-1'), fc.constant('abc'), fc.constant(''), fc.constant('1.5'));
    const badDoc = fc
      .record({ key: fc.constantFrom('tests', 'failures', 'errors', 'skipped'), v: badCount, root: fc.boolean() })
      .map(({ key, v, root }) => {
        const a = { tests: '1', failures: '0', errors: '0', skipped: '0', [key]: v };
        const at = Object.entries(a).map(([k, x]) => ` ${k}="${x}"`).join('');
        return root ? `<testsuites${at}></testsuites>` : `<testsuites><testsuite name="a"${at}></testsuite></testsuites>`;
      });
    const noTests = fc.constant('<testsuites name="x"><testsuite name="a" failures="0"></testsuite></testsuites>');
    fc.assert(
      fc.property(fc.oneof(notJunit, badDoc, noTests), (xml) => {
        const parsed = parseJunitSummary(xml);
        expect(parsed).toBeNull();
        expect(junitGate(parsed).pass).toBe(false);
      }),
      RUNS,
    );
    for (const v of [null, undefined, 42, '', '   ']) expect(parseJunitSummary(v)).toBeNull();
  });

  test('mergeJunitSummaries 加總各份摘要，任一份為 null 即為 null', () => {
    fc.assert(
      fc.property(fc.array(summaryArb, { minLength: 1, maxLength: 8 }), fc.nat(), fc.boolean(), (list, idx, inject) => {
        if (inject) {
          const withNull = [...list];
          withNull.splice(idx % (list.length + 1), 0, null);
          expect(mergeJunitSummaries(withNull)).toBeNull();
          expect(junitGate(mergeJunitSummaries(withNull)).pass).toBe(false);
        } else {
          expect(mergeJunitSummaries(list)).toEqual(sum(list));
        }
      }),
      RUNS,
    );
    expect(mergeJunitSummaries([])).toBeNull();
    expect(mergeJunitSummaries(null)).toBeNull();
  });
});

describe('gates CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lm-junit-gate-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const quiet = { log: () => {}, error: () => {} };

  test('報告檔案不存在時結束碼為 1', () => {
    const lines = [];
    const code = main(['junit', '--gate', 'QA', '--commit', 'a'.repeat(40), join(dir, 'missing.xml')], { log: (l) => lines.push(l), error: () => {} });
    expect(code).toBe(1);
    const out = JSON.parse(lines[0]);
    expect(out.pass).toBe(false);
    expect(out.status).toBe('missing_report');
  });

  test('通過與未通過的報告分別回傳 0 與 1，參數錯誤回傳 2', () => {
    const ok = join(dir, 'ok.xml');
    const bad = join(dir, 'bad.xml');
    writeFileSync(ok, '<testsuites tests="3" failures="0" errors="0" skipped="1"></testsuites>');
    writeFileSync(bad, '<testsuites tests="3" failures="1" errors="0"></testsuites>');
    expect(main(['junit', '--gate', 'QA', ok], quiet)).toBe(0);
    expect(main(['junit', '--gate', 'QA', ok, bad], quiet)).toBe(1);
    expect(main(['junit', '--gate', 'QA'], quiet)).toBe(2);
    expect(main(['junit', '--gate', '不存在', ok], quiet)).toBe(2);
  });

  test('--inventory：QA_Inventory 全數通過才通過，失敗與缺少測試的項目 ID 列於 unmet（Req 5.5、23.2）', () => {
    const ok = join(dir, 'inv-ok.xml');
    writeFileSync(ok, '<testsuites tests="2" failures="0" errors="0"></testsuites>');
    const pass = join(dir, 'inv-pass.json');
    const fail = join(dir, 'inv-fail.json');
    writeFileSync(pass, JSON.stringify({ command: 'compare', ok: true, items: [{ id: 'QA-1', status: 'pass' }], failed: [], missing: [] }));
    writeFileSync(fail, JSON.stringify({
      command: 'compare', ok: false,
      items: [{ id: 'QA-1', status: 'fail' }, { id: 'QA-2', status: 'missing' }, { id: 'QA-3', status: 'pass' }],
      failed: ['QA-1'], missing: ['QA-2'],
    }));
    const run = (args) => { const lines = []; const code = main(args, { log: (l) => lines.push(l), error: () => {} }); return { code, out: JSON.parse(lines[0]) }; };

    const a = run(['junit', '--gate', 'QA', '--inventory', pass, ok]);
    expect(a.code).toBe(0);
    expect(a.out.reports).toEqual([ok, pass]);

    const b = run(['junit', '--gate', 'QA', '--inventory', fail, ok]);
    expect(b.code).toBe(1);
    expect(b.out.status).toBe('fail');
    expect(b.out.unmet.join('\n')).toContain('QA-1');
    expect(b.out.unmet.join('\n')).toContain('QA-2');
    expect(b.out.unmet.join('\n')).not.toContain('QA-3');

    const c = run(['junit', '--gate', 'QA', '--inventory', join(dir, 'none.json'), ok]);
    expect(c.code).toBe(1);
    expect(c.out.status).toBe('missing_report');
  });

  test('--stage-error：檢查階段失敗時即使報告看似通過也未通過（Req 23.3）', () => {
    const ok = join(dir, 'stage-ok.xml');
    writeFileSync(ok, '<testsuites tests="2" failures="0" errors="0"></testsuites>');
    const lines = [];
    const code = main(['junit', '--gate', 'QA', '--stage-error', 'bun test 逾時', ok], { log: (l) => lines.push(l), error: () => {} });
    expect(code).toBe(1);
    const out = JSON.parse(lines[0]);
    expect(out.status).toBe('error');
    expect(out.unmet[0]).toContain('bun test 逾時');
    expect(main(['junit', '--gate', 'QA', '--stage-error', 'a\nb', ok], quiet)).toBe(2);
    expect(main(['junit', '--gate', 'QA', '--stage-error', '', ok], quiet)).toBe(2);
  });

  test('--stage-error 且 JUnit 報告缺失：unmet 依序為階段錯誤與報告缺失，狀態 error（Components 第 24.4 節）', () => {
    const run = (args) => { const lines = []; const code = main(args, { log: (l) => lines.push(l), error: () => {} }); return { code, out: JSON.parse(lines[0]) }; };
    const missing = run(['junit', '--gate', 'QA', '--stage-error', 'Unit Tests 失敗', join(dir, 'stage-missing.xml')]);
    expect(missing.code).toBe(1);
    expect(missing.out.status).toBe('error');
    expect(missing.out.pass).toBe(false);
    expect(missing.out.unmet).toEqual(['檢查階段執行錯誤：Unit Tests 失敗', 'JUnit 報告缺失或無法解析']);

    // 有效 JUnit 時結果不變：只有階段錯誤。
    const ok = join(dir, 'stage-valid.xml');
    writeFileSync(ok, '<testsuites tests="2" failures="0" errors="0"></testsuites>');
    const valid = run(['junit', '--gate', 'QA', '--stage-error', 'Unit Tests 失敗', ok]);
    expect(valid.code).toBe(1);
    expect(valid.out.status).toBe('error');
    expect(valid.out.unmet).toEqual(['檢查階段執行錯誤：Unit Tests 失敗']);
  });
});

describe('inventoryGate', () => {
  test('缺失或格式不明一律未通過', () => {
    expect(inventoryGate(null)).toMatchObject({ pass: false, missingReport: true });
    expect(inventoryGate({ command: 'validate', ok: true })).toMatchObject({ pass: false, missingReport: true });
    expect(inventoryGate({ command: 'compare', ok: true })).toMatchObject({ pass: false, missingReport: false });
    expect(inventoryGate({ command: 'compare', ok: true, items: [], failed: [], missing: [] }).pass).toBe(false);
    // ok 為 true 但項目狀態不是 pass → 未通過。
    expect(inventoryGate({ command: 'compare', ok: true, items: [{ id: 'X', status: 'missing' }], failed: [], missing: [] }).pass).toBe(false);
    expect(inventoryGate({ command: 'compare', ok: true, items: [{ id: 'X', status: 'pass' }], failed: [], missing: [] })).toEqual({ pass: true, missingReport: false, unmet: [] });
  });
});
