// Feature: jenkins-cicd-deploy, Property 41: 可回滾映像保留
// **Validates: Requirements 20.7, 20.10**
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { retainImages, rollbackAllowed } from '../ci/retention.mjs';

const RUNS = { numRuns: 200 };

// 小池子的 digest 讓 history 中常出現重複（同一 digest 多次部署／回滾後再部署）。
const hex64 = fc.stringMatching(/^[0-9a-f]{64}$/);
const digestArb = hex64.map((h) => `sha256:${h}`);
const poolArb = fc.uniqueArray(digestArb, { minLength: 1, maxLength: 8 });

// history 項目：digest 字串或 state/active.json 形狀的物件。
function entryArb(pool) {
  return fc.tuple(fc.constantFrom(...pool), fc.boolean(), fc.nat(10_000)).map(([digest, asObject, n]) =>
    asObject ? { digest, finalizedAt: new Date(n * 1000).toISOString(), build: `release/little-moments/v1.0.${n}#1` } : digest);
}
const historyArb = poolArb.chain((pool) =>
  fc.tuple(fc.constant(pool), fc.array(entryArb(pool), { maxLength: 30 })));
const keepArb = fc.integer({ min: 1, max: 6 });

const digestOf = (e) => (typeof e === 'string' ? e : e.digest);

/** 獨立 oracle：依「最後一次出現的位置」由新到舊排列相異 digest。 */
function oracle(history, keep) {
  const lastIndex = new Map();
  history.forEach((e, i) => lastIndex.set(digestOf(e), i));
  const order = [...lastIndex.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
  return { retained: order.slice(0, keep), removed: order.slice(keep) };
}

describe('Property 41: 可回滾映像保留', () => {
  test('retainImages 保留最新 keep 個相異 digest，其餘移除', () => {
    fc.assert(fc.property(historyArb, keepArb, ([, history], keep) => {
      const snapshot = JSON.stringify(history);
      const result = retainImages(history, keep);
      const expected = oracle(history, keep);
      expect(result.retained).toEqual(expected.retained);
      expect(result.removed).toEqual(expected.removed);

      const distinct = new Set(history.map(digestOf));
      expect(result.retained.length).toBe(Math.min(keep, distinct.size));
      expect(result.retained.filter((d) => result.removed.includes(d))).toEqual([]);
      expect(new Set([...result.retained, ...result.removed])).toEqual(distinct);
      expect(new Set(result.retained).size).toBe(result.retained.length);
      if (history.length > 0) {
        // 目前 Production 版本（最後一筆）永遠保留且排在最前。
        expect(result.retained[0]).toBe(digestOf(history[history.length - 1]));
      }
      expect(JSON.stringify(history)).toBe(snapshot); // 輸入不被修改
    }), RUNS);
  });

  test('預設 keep 為 3', () => {
    fc.assert(fc.property(historyArb, ([, history]) => {
      expect(retainImages(history)).toEqual(retainImages(history, 3));
    }), { numRuns: 100 });
  });

  test('rollbackAllowed 為真若且唯若 digest 與保留集合某項完全相同', () => {
    const nearMiss = (d) => fc.constantFrom(
      d.toUpperCase(),
      d.slice(0, -1),
      `${d} `,
      ` ${d}`,
      `${d}\n`,
      d.replace('sha256:', ''),
      `${d}0`,
    );
    fc.assert(fc.property(
      historyArb.chain(([pool, history]) => fc.tuple(
        fc.constant(history),
        fc.constantFrom(...pool).chain((d) => fc.oneof(fc.constant(d), nearMiss(d))),
        digestArb,
      )),
      keepArb,
      ([history, candidate, unrelated], keep) => {
        const retained = retainImages(history, keep);
        const expected = oracle(history, keep).retained.includes(candidate);
        expect(rollbackAllowed(candidate, retained)).toBe(expected);
        expect(rollbackAllowed(candidate, retained.retained)).toBe(expected);
        expect(rollbackAllowed(unrelated, retained)).toBe(retained.retained.includes(unrelated));
        // 被移除的 digest 一律不可作為回滾目標。
        for (const d of retained.removed) expect(rollbackAllowed(d, retained)).toBe(false);
        for (const d of retained.retained) expect(rollbackAllowed(d, retained)).toBe(true);
      },
    ), RUNS);
  });

  test('範例：重新部署較舊的 digest 會以最後出現位置計算', () => {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((x) => `sha256:${x.repeat(64)}`);
    const history = [a, b, { digest: c }, a, d];
    expect(retainImages(history)).toEqual({ retained: [d, a, c], removed: [b] });
    expect(rollbackAllowed(b, retainImages(history))).toBe(false);
    expect(rollbackAllowed(a.toUpperCase(), retainImages(history))).toBe(false);
    expect(retainImages([])).toEqual({ retained: [], removed: [] });
    expect(rollbackAllowed('', [''])).toBe(false);
  });
});
