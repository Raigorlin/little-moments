// Feature: jenkins-cicd-deploy, Property 40: 健康檢查判定器
// **Validates: Requirements 18.3, 18.5, 20.3, 20.4, 20.6, 20.11**
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { healthyAt, healthyWithin, isHealthSuccess, shouldRollback } from '../ci/health.mjs';

const RUNS = { numRuns: 200 };

// ---- 獨立 oracle ----

// Health_Check 成功：HTTP 200（ok 旗標與 status 不得互相矛盾）且 5 秒內回應。
function oracleSuccess(r) {
  if (r === null || typeof r !== 'object') return false;
  if (r.ok === false) return false;
  if (r.ok !== true && r.status !== 200) return false;
  if (r.status !== undefined && r.status !== 200) return false;
  if (r.durationMs !== undefined) {
    if (typeof r.durationMs !== 'number' || !Number.isFinite(r.durationMs)) return false;
    if (r.durationMs < 0 || r.durationMs > 5000) return false;
  }
  return true;
}

const finite = (t) => typeof t === 'number' && Number.isFinite(t);

// 視窗 [0, windowSec] 內的結果依 t 穩定排序後，找第一個「以此為結尾的 n 筆皆成功」的位置。
function oracleHealthyAt(results, windowSec, n) {
  const inWin = [];
  results.forEach((r, i) => {
    if (r && finite(r.t) && r.t >= 0 && r.t <= windowSec) inWin.push({ r, i });
  });
  inWin.sort((a, b) => (a.r.t === b.r.t ? a.i - b.i : a.r.t - b.r.t));
  for (let j = n - 1; j < inWin.length; j++) {
    let all = true;
    for (let k = j - n + 1; k <= j; k++) if (!oracleSuccess(inWin[k].r)) all = false;
    if (all) return inWin[j].r.t;
  }
  return null;
}

// 依陣列順序；略過 t 為數值且不在 [0, periodSec] 的項目；smoke 失敗即觸發；
// 其他項目（health、未知、null）構成健康檢查子序列，最後 consecutive 筆皆失敗即觸發。
function oracleRollback(observations, consecutive, periodSec) {
  const healthSeq = []; // { index, success }
  for (let index = 0; index < observations.length; index++) {
    const o = observations[index];
    const hasT = o != null && finite(o.t);
    if (hasT && (o.t < 0 || o.t > periodSec)) continue;
    const t = hasT ? o.t : null;
    if (o != null && o.type === 'smoke') {
      if (!oracleSuccess(o)) return { index, t, reason: 'smoke_failed' };
      continue;
    }
    const success = o != null && o.type === 'health' && oracleSuccess(o);
    healthSeq.push({ index, success });
    if (healthSeq.length >= consecutive) {
      const tail = healthSeq.slice(-consecutive);
      if (tail.every((h) => !h.success)) {
        return { index, t, reason: 'health_consecutive_failures', failures: tail.map((h) => h.index) };
      }
    }
  }
  return null;
}

// ---- 產生器 ----

const outcomeArb = fc.record(
  {
    ok: fc.constantFrom(true, false, undefined),
    status: fc.constantFrom(200, 200, 500, 503, 404, undefined),
    durationMs: fc.oneof(
      fc.constant(undefined),
      fc.integer({ min: 0, max: 5000 }),
      fc.constantFrom(4999, 5000, 5001, -1, Number.NaN, '100'),
      fc.integer({ min: 5001, max: 20000 }),
    ),
  },
  { requiredKeys: [] },
);

// 偏向成功的結果，讓「連續 n 次成功」能夠出現。
const biasedOutcomeArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant({ ok: true, status: 200, durationMs: 120 }) },
  { weight: 1, arbitrary: fc.constant({ status: 200 }) },
  { weight: 3, arbitrary: outcomeArb },
);

const tArb = fc.oneof(
  { weight: 8, arbitrary: fc.integer({ min: -5, max: 700 }) },
  { weight: 1, arbitrary: fc.double({ min: -1, max: 130, noNaN: true }) },
  { weight: 1, arbitrary: fc.constantFrom(undefined, Number.NaN, Infinity, '10', 0, 120, 600, 601) },
);

const healthResultArb = fc.tuple(tArb, biasedOutcomeArb).map(([t, o]) => (t === undefined ? { ...o } : { ...o, t }));

const observationArb = fc.oneof(
  { weight: 6, arbitrary: healthResultArb.map((r) => ({ type: 'health', ...r })) },
  { weight: 2, arbitrary: healthResultArb.map((r) => ({ type: 'smoke', ...r })) },
  { weight: 1, arbitrary: fc.constantFrom(null, {}, { type: 'other', ok: true, status: 200, t: 5 }, { type: 'health' }) },
);

// ---- 測試 ----

describe('Property 40: 健康檢查判定器', () => {
  test('isHealthSuccess 與 oracle 一致', () => {
    fc.assert(fc.property(fc.oneof(healthResultArb, fc.constantFrom(null, undefined, 1, 'x')), (r) => {
      expect(isHealthSuccess(r)).toBe(oracleSuccess(r));
    }), RUNS);
  });

  test('healthyAt／healthyWithin：視窗內存在連續 n 次成功', () => {
    fc.assert(fc.property(
      fc.array(healthResultArb, { maxLength: 40 }),
      fc.constantFrom(120, 120, 0, 30, 600),
      fc.constantFrom(3, 3, 1, 2, 5),
      (results, windowSec, n) => {
        const expected = oracleHealthyAt(results, windowSec, n);
        expect(healthyAt(results, windowSec, n)).toBe(expected);
        expect(healthyWithin(results, windowSec, n)).toBe(expected !== null);
      },
    ), RUNS);
  });

  test('healthyWithin 預設參數為視窗 120 秒、連續 3 次', () => {
    fc.assert(fc.property(fc.array(healthResultArb, { maxLength: 30 }), (results) => {
      expect(healthyWithin(results)).toBe(oracleHealthyAt(results, 120, 3) !== null);
    }), RUNS);
  });

  test('shouldRollback：回傳第一個觸發點或 null', () => {
    fc.assert(fc.property(
      fc.array(observationArb, { maxLength: 40 }),
      fc.constantFrom(3, 3, 1, 2, 4),
      fc.constantFrom(600, 600, 0, 60),
      (obs, consecutive, periodSec) => {
        expect(shouldRollback(obs, { consecutive, periodSec })).toEqual(oracleRollback(obs, consecutive, periodSec));
      },
    ), RUNS);
  });

  test('shouldRollback 預設參數為連續 3 次、觀察期 600 秒', () => {
    fc.assert(fc.property(fc.array(observationArb, { maxLength: 30 }), (obs) => {
      expect(shouldRollback(obs)).toEqual(oracleRollback(obs, 3, 600));
    }), RUNS);
  });

  test('範例：Smoke_Test 不重置健康檢查失敗連續計數', () => {
    const fail = { type: 'health', status: 503 };
    const obs = [
      { ...fail, t: 10 }, { type: 'smoke', ok: true, t: 15 }, { ...fail, t: 20 }, { ...fail, t: 30 },
    ];
    expect(shouldRollback(obs)).toEqual({ index: 3, t: 30, reason: 'health_consecutive_failures', failures: [0, 2, 3] });
  });

  test('範例：逾時 5 秒以上視為失敗、視窗外不計', () => {
    const ok = (t) => ({ t, status: 200, durationMs: 100 });
    expect(healthyAt([ok(0), ok(5), { t: 10, status: 200, durationMs: 5001 }, ok(15)])).toBeNull();
    expect(healthyAt([ok(0), ok(5), ok(10)])).toBe(10);
    expect(healthyAt([ok(100), ok(110), ok(121)])).toBeNull();
    expect(shouldRollback([{ type: 'smoke', status: 500, t: 601 }, { type: 'smoke', status: 500, t: 2 }]))
      .toEqual({ index: 1, t: 2, reason: 'smoke_failed' });
  });

  test('無效參數會拋出', () => {
    expect(() => healthyAt('x')).toThrow();
    expect(() => healthyAt([], 120, 0)).toThrow();
    expect(() => shouldRollback({}, {})).toThrow();
    expect(() => shouldRollback([], { consecutive: 1.5 })).toThrow();
  });
});
