// Feature: jenkins-cicd-deploy, Property 27: 遷移規劃
// **Validates: Requirements 12.1, 12.2**
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { planMigrations, runMigrations, EXIT_OK } from '../server/db/migrations.js';

const RUNS = { numRuns: 200 };
const MAX_VERSION = 2147483647;

const hex64 = fc.stringMatching(/^[0-9a-f]{64}$/);

// repo：版本唯一的正整數，順序隨機（不保證已排序），每筆帶 checksum 與 SQL。
const repoArb = fc
  .uniqueArray(fc.integer({ min: 1, max: 1_000_000 }), { maxLength: 30 })
  .chain(versions => fc.tuple(
    fc.shuffledSubarray(versions, { minLength: versions.length, maxLength: versions.length }),
    fc.array(hex64, { minLength: versions.length, maxLength: versions.length }),
  ))
  .map(([versions, sums]) => versions.map((version, i) => ({
    version,
    name: `${String(version).padStart(4, '0')}_m${version}.sql`,
    sql: `-- migration ${version}`,
    checksum: sums[i],
    destructive: false,
  })));

// applied：repo 的子集合（checksum 相符）加上隨機、較 repo 最大版本更新的未知版本；
// 版本值隨機以 number 或 string 表示（DB driver 可能回傳字串），順序隨機。
const scenarioArb = repoArb.chain(repo => {
  const maxRepo = repo.reduce((m, r) => Math.max(m, r.version), 0);
  return fc.record({
    repo: fc.constant(repo),
    appliedSubset: fc.subarray(repo),
    unknown: fc.uniqueArray(fc.integer({ min: maxRepo + 1, max: MAX_VERSION }), { maxLength: 5 }),
    unknownSums: fc.array(hex64, { minLength: 5, maxLength: 5 }),
    asString: fc.boolean(),
    seed: fc.integer(),
  });
}).map(({ repo, appliedSubset, unknown, unknownSums, asString, seed }) => {
  const rows = [
    ...appliedSubset.map(m => ({ version: m.version, checksum: m.checksum })),
    ...unknown.map((v, i) => ({ version: v, checksum: unknownSums[i] })),
  ].map(r => ({ ...r, version: asString ? String(r.version) : r.version }));
  // 以 seed 打亂順序（確定性）。
  rows.sort((a, b) => ((Number(a.version) * 2654435761 + seed) % 97) - ((Number(b.version) * 2654435761 + seed) % 97));
  return { repo, applied: rows, appliedSubset, unknown };
});

const asc = (a, b) => a - b;
const deepCopy = v => JSON.parse(JSON.stringify(v));

describe('Property 27: 遷移規劃（planMigrations）', () => {
  test('toApply 為未套用版本且遞增、unknownApplied 為 repo 中不存在的已套用版本、輸入不被修改', () => {
    fc.assert(fc.property(scenarioArb, ({ repo, applied, appliedSubset, unknown }) => {
      const repoBefore = deepCopy(repo);
      const appliedBefore = deepCopy(applied);

      const plan = planMigrations(repo, applied);

      const appliedSet = new Set(appliedSubset.map(m => m.version));
      const expectedToApply = repo.map(m => m.version).filter(v => !appliedSet.has(v)).sort(asc);
      expect(plan.toApply.map(m => m.version)).toEqual(expectedToApply);
      // toApply 的元素就是 repo 中的遷移物件（含 sql/checksum）。
      for (const m of plan.toApply) expect(repo).toContain(m);
      expect(plan.unknownApplied).toEqual([...unknown].sort(asc));
      expect(plan.checksumMismatch).toEqual([]);

      expect(repo).toEqual(repoBefore);
      expect(applied).toEqual(appliedBefore);
    }), RUNS);
  });

  test('邊界：空 repo 與空紀錄', () => {
    expect(planMigrations([], [])).toEqual({ toApply: [], unknownApplied: [], checksumMismatch: [] });
    expect(planMigrations([], [{ version: 7, checksum: 'x' }]).unknownApplied).toEqual([7]);
  });
});

// 以記憶體內的假 executor 模擬 Bun.SQL，驗證 runMigrations 依規劃遞增套用、且不修改未知版本紀錄。
function createFakeSql(initialRows) {
  const state = { rows: initialRows.map(r => ({ ...r })), executed: [] };
  const make = staged => {
    const target = staged || state;
    const fn = (strings, ...values) => {
      const text = strings.join('?');
      if (/pg_advisory_(un)?lock/.test(text)) return Promise.resolve([]);
      if (/SELECT version, checksum FROM schema_migrations/.test(text)) {
        return Promise.resolve(state.rows.map(r => ({ version: r.version, checksum: r.checksum })));
      }
      if (/INSERT INTO schema_migrations/.test(text)) {
        const [version, name, checksum, destructive] = values;
        target.rows.push({ version, name, checksum, destructive });
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected query: ${text}`));
    };
    fn.unsafe = text => { if (!/CREATE TABLE IF NOT EXISTS schema_migrations/.test(text)) target.executed.push(text); return Promise.resolve([]); };
    fn.begin = async cb => {
      const tx = { rows: [], executed: [] };
      await cb(make(tx));
      state.rows.push(...tx.rows);
      state.executed.push(...tx.executed);
    };
    return fn;
  };
  return { sql: make(null), state };
}

describe('Property 27: 遷移規劃（runMigrations 套用順序）', () => {
  test('依版本遞增套用 toApply，保留未知版本紀錄不動', async () => {
    await fc.assert(fc.asyncProperty(scenarioArb, async ({ repo, applied, appliedSubset, unknown }) => {
      const { sql, state } = createFakeSql(applied);
      const result = await runMigrations(sql, repo);

      const appliedSet = new Set(appliedSubset.map(m => m.version));
      const expected = repo.map(m => m.version).filter(v => !appliedSet.has(v)).sort(asc);

      expect(result.exitCode).toBe(EXIT_OK);
      expect(result.applied).toEqual(expected);
      expect(result.count).toBe(expected.length);
      expect(result.unknownApplied).toEqual([...unknown].sort(asc));
      expect(state.executed).toEqual(expected.map(v => `-- migration ${v}`));
      // 原有紀錄（含未知版本）完全不變，僅在其後追加新紀錄。
      expect(state.rows.slice(0, applied.length)).toEqual(applied);
      expect(state.rows.slice(applied.length).map(r => r.version)).toEqual(expected);
    }), { numRuns: 100 });
  });
});
