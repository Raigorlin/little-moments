// Feature: jenkins-cicd-deploy, Property 39: OCI 標籤格式
// **Validates: Requirements 16.5**
// 依更新後的 Req 16.5：`org.opencontainers.image.version` 一律為 `main-<7 字元短 SHA>`，
// Release_Tag 建置也不改變（Tag 名稱只記錄於 Registry 版本標籤與 Build_Record）。
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { imageLabels, rfc3339Utc, buildArgs, LABEL_KEYS } from '../ci/image-labels.mjs';

const RUNS = { numRuns: 200 };
const HEX = '0123456789abcdef'.split('');
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const commitArb = fc.string({ unit: fc.constantFrom(...HEX), minLength: 40, maxLength: 40 });

// 0001-01-01T00:00:00Z .. 9999-12-31T23:59:59.999Z
const MIN_MS = new Date('0001-01-01T00:00:00.000Z').getTime();
const MAX_MS = new Date('9999-12-31T23:59:59.999Z').getTime();
const msArb = fc.integer({ min: MIN_MS, max: MAX_MS });

/** 期望值：截斷至秒（向下取整）後的 UTC 時間點。 */
const truncated = ms => Math.floor(ms / 1000) * 1000;

/** 將 ms 以指定時區偏移（分鐘）格式化為 ISO 8601 字串，例如 2024-01-02T03:04:05.678+05:30。 */
function isoWithOffset(ms, offsetMin) {
  const local = new Date(ms + offsetMin * 60_000).toISOString().slice(0, -1); // 去掉 Z
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${local}${sign}${hh}:${mm}`;
}

function assertLabels(labels, commit, ms) {
  expect(Object.keys(labels).sort()).toEqual(Object.values(LABEL_KEYS).sort());
  expect(labels[LABEL_KEYS.revision]).toBe(commit);
  expect(labels[LABEL_KEYS.version]).toBe(`main-${commit.slice(0, 7)}`);
  expect(labels[LABEL_KEYS.version]).toMatch(/^main-[0-9a-f]{7}$/);
  const created = labels[LABEL_KEYS.created];
  expect(created).toMatch(RFC3339_UTC);
  expect(new Date(created).getTime()).toBe(truncated(ms));
}

describe('Property 39: OCI 標籤格式', () => {
  test('Date 輸入：revision、version、created 皆符合格式且 created 為截斷至秒的同一時間點', () => {
    fc.assert(fc.property(commitArb, msArb, (commit, ms) => {
      assertLabels(imageLabels({ commit, createdAt: new Date(ms) }), commit, ms);
    }), RUNS);
  });

  test('epoch 毫秒輸入', () => {
    fc.assert(fc.property(commitArb, msArb, (commit, ms) => {
      assertLabels(imageLabels({ commit, createdAt: ms }), commit, ms);
    }), RUNS);
  });

  test('含時區偏移的 ISO 8601 字串輸入轉為 UTC', () => {
    const midMs = fc.integer({
      min: new Date('1000-01-02T00:00:00Z').getTime(),
      max: new Date('9000-12-30T00:00:00Z').getTime(),
    });
    const offsetArb = fc.integer({ min: -14 * 60, max: 14 * 60 });
    fc.assert(fc.property(commitArb, midMs, offsetArb, (commit, ms, offset) => {
      const iso = isoWithOffset(ms, offset);
      expect(new Date(iso).getTime()).toBe(ms); // 產生器自我檢查
      assertLabels(imageLabels({ commit, createdAt: iso }), commit, ms);
    }), RUNS);
  });

  test('version 不隨 Release_Tag 或其他輸入改變：只由 commit 決定', () => {
    fc.assert(fc.property(commitArb, msArb, msArb, (commit, a, b) => {
      const la = imageLabels({ commit, createdAt: a });
      const lb = imageLabels({ commit, createdAt: b });
      expect(la[LABEL_KEYS.version]).toBe(lb[LABEL_KEYS.version]);
      expect(la[LABEL_KEYS.revision]).toBe(lb[LABEL_KEYS.revision]);
    }), RUNS);
  });

  test('buildArgs 對應 REVISION / VERSION / CREATED', () => {
    fc.assert(fc.property(commitArb, msArb, (commit, ms) => {
      const labels = imageLabels({ commit, createdAt: ms });
      expect(buildArgs(labels)).toEqual({
        REVISION: labels[LABEL_KEYS.revision],
        VERSION: labels[LABEL_KEYS.version],
        CREATED: labels[LABEL_KEYS.created],
      });
    }), RUNS);
  });

  test('無效 commit 一律 throw', () => {
    const badChar = fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZghijklmnopqrstuvwxyz -_/.:'.split(''));
    const invalidCommit = fc.oneof(
      // 長度不為 40（含 39、41）
      fc.integer({ min: 0, max: 80 }).filter(n => n !== 40)
        .chain(n => fc.string({ unit: fc.constantFrom(...HEX), minLength: n, maxLength: n })),
      // 40 字元但含至少一個非小寫十六進位字元（含大寫 A-F）
      fc.tuple(commitArb, fc.integer({ min: 0, max: 39 }), badChar)
        .map(([c, i, ch]) => c.slice(0, i) + ch + c.slice(i + 1)),
      // 非字串
      fc.constantFrom(undefined, null, 0, 123n, {}, []),
    );
    fc.assert(fc.property(invalidCommit, msArb, (commit, ms) => {
      expect(() => imageLabels({ commit, createdAt: ms })).toThrow();
    }), RUNS);
  });

  test('無效時間一律 throw', () => {
    const commit = 'a'.repeat(40);
    const invalidDate = fc.oneof(
      fc.constantFrom('', '   ', 'not a date', '2024-13-01T00:00:00Z', NaN, Infinity, -Infinity,
        null, undefined, {}, [], true, new Date(NaN)),
      // 超出 RFC 3339 年份範圍（年份 > 9999 或 < 0）
      fc.integer({ min: MAX_MS + 1, max: 8.64e15 }),
      fc.integer({ min: -8.64e15, max: new Date('-000001-12-31T23:59:59.999Z').getTime() }),
    );
    fc.assert(fc.property(invalidDate, value => {
      expect(() => imageLabels({ commit, createdAt: value })).toThrow();
      expect(() => rfc3339Utc(value)).toThrow();
    }), RUNS);
  });

  test('範例：已知輸入', () => {
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const labels = imageLabels({ commit, createdAt: '2026-03-04T05:06:07.999+08:00' });
    expect(labels).toEqual({
      'org.opencontainers.image.revision': commit,
      'org.opencontainers.image.version': 'main-0123456',
      'org.opencontainers.image.created': '2026-03-03T21:06:07Z',
    });
  });
});
