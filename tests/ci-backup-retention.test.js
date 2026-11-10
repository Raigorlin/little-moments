// Feature: jenkins-cicd-deploy, Property 37: 備份保留修剪
// **Validates: Requirements 14.5, 14.7**
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { pruneBackups } from '../ci/retention.mjs';

const RUNS = { numRuns: 200 };
const BASE = Date.UTC(2026, 0, 1);

// createdAt 以 epoch ms 或 ISO 字串表示；時間範圍刻意縮小以產生相同建立時間（測試以 id 決勝）。
const msArb = fc.integer({ min: 0, max: 40 }).map((n) => BASE + n * 3_600_000);
const backupArb = (id) => fc.record({
  ms: msArb,
  iso: fc.boolean(),
  sizeBytes: fc.nat(),
}).map(({ ms, iso, sizeBytes }) => ({ id, createdAt: iso ? new Date(ms).toISOString() : ms, sizeBytes }));

// 唯一 id 的既有備份清單（0..30 份）與一筆 id 不重複的新備份。
const scenarioArb = fc.uniqueArray(fc.stringMatching(/^[a-z0-9-]{1,12}$/), { minLength: 1, maxLength: 31 })
  .chain((ids) => fc.tuple(
    fc.tuple(...ids.slice(1).map(backupArb)),
    backupArb(ids[0]),
    fc.integer({ min: 1, max: 20 }),
  ))
  .map(([existing, newBackup, keep]) => ({ existing, newBackup, keep }));

// 獨立 oracle：建立時間（毫秒）由新到舊，相同時以 id 遞減決勝。
const ms = (b) => (typeof b.createdAt === 'number' ? b.createdAt : Date.parse(b.createdAt));
const oracleSort = (list) => [...list].sort((a, b) => {
  if (ms(a) !== ms(b)) return ms(b) - ms(a);
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
});
const ids = (list) => list.map((b) => b.id);
const sortedIds = (list) => ids(list).sort();

describe('Property 37: 備份保留修剪', () => {
  test('未通過驗證時不刪除任何備份', () => {
    fc.assert(fc.property(scenarioArb, fc.constantFrom(false, undefined, null, 'true', 1), ({ existing, newBackup, keep }, verified) => {
      const snapshot = structuredClone(existing);
      const result = pruneBackups(existing, newBackup, verified, keep);
      expect(result.delete).toEqual([]);
      expect(ids(result.keep)).not.toContain(newBackup.id);
      expect(sortedIds(result.keep)).toEqual(sortedIds(existing));
      expect(existing).toEqual(snapshot);
    }), RUNS);
  });

  test('通過驗證時保留新備份與最新的 min(keep, n+1) 份，其餘最舊者被刪除', () => {
    fc.assert(fc.property(scenarioArb, ({ existing, newBackup, keep }) => {
      const snapshot = structuredClone(existing);
      const result = pruneBackups(existing, newBackup, true, keep);

      const expectedKept = [newBackup, ...oracleSort(existing).slice(0, keep - 1)];
      const expectedDeleted = oracleSort(existing).slice(keep - 1);

      expect(result.keep.length).toBe(Math.min(keep, existing.length + 1));
      expect(ids(result.keep)).toContain(newBackup.id);
      expect(ids(result.delete)).not.toContain(newBackup.id);
      expect(sortedIds(result.keep)).toEqual(sortedIds(expectedKept));
      expect(sortedIds(result.delete)).toEqual(sortedIds(expectedDeleted));
      // 結果依新到舊排序，且原物件原樣保留
      expect(ids(result.keep)).toEqual(ids(oracleSort(expectedKept)));
      for (const b of result.keep) expect(b).toBe(b.id === newBackup.id ? newBackup : existing.find((e) => e.id === b.id));

      // keep ∪ delete = existing ∪ {new}，兩者不重疊
      const union = [...ids(result.keep), ...ids(result.delete)];
      expect(new Set(union).size).toBe(union.length);
      expect(union.sort()).toEqual(sortedIds([...existing, newBackup]));

      // 每個被刪除的既有備份都不比任何被保留的既有備份新
      const keptExisting = result.keep.filter((b) => b.id !== newBackup.id);
      for (const d of result.delete) {
        for (const k of keptExisting) {
          expect(oracleSort([d, k])[0].id).toBe(k.id);
        }
      }

      // 新備份為最新時，保留集合恰為整體最新的 min(keep, n+1) 份
      const all = oracleSort([...existing, newBackup]);
      if (all[0].id === newBackup.id) {
        expect(sortedIds(result.keep)).toEqual(sortedIds(all.slice(0, keep)));
      }
      expect(existing).toEqual(snapshot);
    }), RUNS);
  });

  test('結果與既有清單的輸入順序無關', () => {
    fc.assert(fc.property(
      scenarioArb.chain((s) => fc.tuple(fc.constant(s), fc.shuffledSubarray(s.existing, { minLength: s.existing.length }))),
      ([{ existing, newBackup, keep }, shuffled]) => {
        const a = pruneBackups(existing, newBackup, true, keep);
        const b = pruneBackups(shuffled, newBackup, true, keep);
        expect(ids(b.keep)).toEqual(ids(a.keep));
        expect(sortedIds(b.delete)).toEqual(sortedIds(a.delete));
      },
    ), RUNS);
  });

  test('預設保留 14 份', () => {
    const existing = Array.from({ length: 20 }, (_, i) => ({ id: `b${String(i).padStart(2, '0')}`, createdAt: BASE + i * 1000 }));
    const newBackup = { id: 'new', createdAt: new Date(BASE + 100_000).toISOString() };
    const result = pruneBackups(existing, newBackup, true);
    expect(result.keep.length).toBe(14);
    expect(result.keep[0]).toBe(newBackup);
    expect(ids(result.delete).sort()).toEqual(ids(existing.slice(0, 7)));
  });

  test('無效輸入拋出例外', () => {
    const ok = { id: 'a', createdAt: BASE };
    const nb = { id: 'n', createdAt: BASE + 1 };
    expect(() => pruneBackups([ok, { id: 'a', createdAt: BASE + 5 }], nb, true)).toThrow(TypeError);
    expect(() => pruneBackups([{ id: 'x', createdAt: 'not-a-date' }], nb, true)).toThrow(TypeError);
    expect(() => pruneBackups([{ id: 'x' }], nb, true)).toThrow(TypeError);
    expect(() => pruneBackups([ok], { id: 'n', createdAt: NaN }, true)).toThrow(TypeError);
    expect(() => pruneBackups([ok], { id: '', createdAt: BASE }, true)).toThrow(TypeError);
    expect(() => pruneBackups('nope', nb, true)).toThrow(TypeError);
    for (const keep of [0, -1, 1.5, NaN]) {
      expect(() => pruneBackups([ok], nb, true, keep)).toThrow(TypeError);
    }
  });
});
