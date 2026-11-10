// Feature: jenkins-cicd-deploy, Property 7: QA_Inventory 與測試結果比對
// **Validates: Requirements 5.4, 5.5, 5.7**
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { compareInventory, extractResults, validateInventory } from '../scripts/qa-inventory.mjs';

const RUNS = { numRuns: 200 };
const POOL = ['TC-AUTH-001', 'TC-HOME-001', 'TC-HOME-002', 'TC-TRIP-001', 'TC-ADMIN-001', 'TC-UNAUTH-001'];
const OUTCOMES = ['passed', 'failed', 'skipped', 'absent'];

// 合法 inventory：三種角色與兩類越權項目固定存在，其餘項目隨機。
const item = fc.record({
  testCases: fc.uniqueArray(fc.constantFrom(...POOL), { minLength: 1, maxLength: 3 }),
  critical: fc.boolean(),
  role: fc.constantFrom('anonymous', 'member', 'admin'),
});
const inventory = fc.array(item, { maxLength: 6 }).map(extra => {
  const fixed = [
    { role: 'admin', testCases: [POOL[4]], critical: true },
    { role: 'anonymous', testCases: [POOL[5]], critical: true, unauthorized: true },
    { role: 'member', testCases: [POOL[5], POOL[1]], critical: false, unauthorized: true },
  ];
  return {
    version: 1,
    items: [...fixed, ...extra].map((x, i) => ({
      id: `QA-${i + 1}`, page: '/p', control: 'c', scenario: 's',
      expected: x.unauthorized ? '被拒絕且資料未被變更' : '顯示內容',
      ...x,
    })),
  };
});
const record = fc.record({
  testCase: fc.constantFrom(...POOL, 'TC-OTHER-001'),
  viewport: fc.constantFrom('desktop', 'mobile', 'tablet'),
  outcome: fc.constantFrom(...OUTCOMES),
});
const results = fc.array(record, { maxLength: 30 });

// 獨立 oracle：直接依 Property 7 的文字定義逐項判定。
function oracleStatus(item, list) {
  const viewports = item.critical ? ['desktop', 'mobile'] : ['desktop'];
  let anyFailed = false, anyMissing = false;
  for (const tc of item.testCases) {
    for (const vp of viewports) {
      const outcomes = list.filter(r => r.testCase === tc && r.viewport === vp).map(r => r.outcome);
      if (outcomes.includes('failed')) anyFailed = true;
      else if (outcomes.length === 0 || outcomes.some(o => o !== 'passed')) anyMissing = true;
    }
  }
  return anyFailed ? 'fail' : anyMissing ? 'missing' : 'pass';
}

// 將結果轉為 Playwright JSON reporter 形狀；failed 隨機對應 failed／timedOut／interrupted，並加入較早的重試。
const STATUS_FOR = { passed: ['passed'], failed: ['failed', 'timedOut', 'interrupted'], skipped: ['skipped'] };
function toReport(list, pick) {
  const specs = list.map((r, i) => {
    let test;
    if (r.outcome === 'absent') test = { projectName: r.viewport, status: 'expected', results: [] };
    else {
      const choices = STATUS_FOR[r.outcome];
      const final = { retry: 1, status: choices[pick[i % pick.length] % choices.length] };
      // 較早的重試結果與最終結果不同，確認只採用最後一次（retry 最大者）。
      const earlier = { retry: 0, status: r.outcome === 'passed' ? 'failed' : 'passed' };
      test = { projectName: r.viewport, results: i % 2 ? [final, earlier] : [earlier, final] };
    }
    return { title: `[${r.testCase}] case ${i}`, tests: [test] };
  });
  // 分散到巢狀 suites，並加入沒有 TC 標記的 spec（應被忽略）。
  const half = Math.floor(specs.length / 2);
  return {
    suites: [
      { title: 'a.e2e.js', specs: specs.slice(0, half), suites: [{ title: 'describe', specs: specs.slice(half) }] },
      { title: 'b.e2e.js', specs: [{ title: 'untagged test', tests: [{ projectName: 'desktop', results: [{ retry: 0, status: 'failed' }] }] }] },
    ],
  };
}

describe('Property 7: QA_Inventory 與測試結果比對', () => {
  test('每個項目的狀態符合 oracle；ok 若且唯若全部 pass；failed／missing 清單與狀態一致', () => {
    fc.assert(
      fc.property(inventory, results, (inv, list) => {
        expect(validateInventory(inv).ok).toBe(true);
        const out = compareInventory(inv, list);
        expect(out.items.map(i => i.id)).toEqual(inv.items.map(i => i.id));
        const expected = inv.items.map(i => oracleStatus(i, list));
        expect(out.items.map(i => i.status)).toEqual(expected);
        expect(out.ok).toBe(expected.every(s => s === 'pass'));
        expect(new Set([...out.failed, ...out.missing])).toEqual(new Set(inv.items.filter((_, k) => expected[k] !== 'pass').map(i => i.id)));
        expect(out.failed).toEqual(inv.items.filter((_, k) => expected[k] === 'fail').map(i => i.id));
        expect(out.missing).toEqual(inv.items.filter((_, k) => expected[k] === 'missing').map(i => i.id));
        // 明細只涵蓋所需視窗：critical 為 desktop 與 mobile，否則只有 desktop。
        out.items.forEach((o, k) => {
          const vps = inv.items[k].critical ? ['desktop', 'mobile'] : ['desktop'];
          expect(o.detail.length).toBe(inv.items[k].testCases.length * vps.length);
          for (const d of o.detail) expect(vps).toContain(d.viewport);
        });
      }),
      RUNS,
    );
  });

  test('Playwright JSON 報告與等價的結果清單得到相同比對結果', () => {
    fc.assert(
      fc.property(inventory, results, fc.array(fc.nat(), { minLength: 1, maxLength: 5 }), (inv, list, pick) => {
        const report = toReport(list, pick);
        const extracted = extractResults(report);
        const key = r => `${r.testCase}|${r.viewport}|${r.outcome}`;
        expect(extracted.map(key).sort()).toEqual(list.map(key).sort());
        expect(compareInventory(inv, report)).toEqual(compareInventory(inv, list));
      }),
      RUNS,
    );
  });

  test('只出現在 desktop 的 critical 案例判定為 missing，非 critical 判定為 pass', () => {
    fc.assert(
      fc.property(inventory, inv => {
        const list = inv.items.flatMap(i => i.testCases).map(testCase => ({ testCase, viewport: 'desktop', outcome: 'passed' }));
        const out = compareInventory(inv, list);
        out.items.forEach((o, k) => expect(o.status).toBe(inv.items[k].critical ? 'missing' : 'pass'));
        expect(out.ok).toBe(inv.items.every(i => !i.critical));
      }),
      { numRuns: 50 },
    );
  });

  test('範例：同一案例多筆結果時 failed 優先於 skipped，skipped 視為未執行', () => {
    const inv = { version: 1, items: [{ id: 'QA-1', testCases: ['TC-A-001'], critical: false }] };
    const r = (outcome) => ({ testCase: 'TC-A-001', viewport: 'desktop', outcome });
    expect(compareInventory(inv, [r('passed'), r('skipped')]).items[0].status).toBe('missing');
    expect(compareInventory(inv, [r('skipped'), r('failed')]).items[0].status).toBe('fail');
    expect(compareInventory(inv, [r('passed'), r('passed')]).items[0].status).toBe('pass');
    expect(compareInventory(inv, []).items[0].status).toBe('missing');
  });
});
