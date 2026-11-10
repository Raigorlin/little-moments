// Feature: jenkins-cicd-deploy, Property 3: 工具鏈版本不一致的回報完整且精確
// **Validates: Requirements 3.3**
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { compareToolchain, TOOLS } from '../ci/verify-toolchain.mjs';

// 小型版本池使「相同」與「不同」兩種情況都經常出現。
const semver = fc.constantFrom('1.3.0', '1.3.1', '22.11.0', '22.12.0');
const chromiumVersion = fc.constantFrom('141.0.7390.37', '141.0.7390.54');
const versionFor = tool => (tool === 'chromium' ? chromiumVersion : semver);

// 預期版本表（toolchain.json）每項皆為非空字串。
const expectedArb = fc.record(Object.fromEntries(TOOLS.map(t => [t, versionFor(t)])));

// 實際版本：與預期相同、其他版本、空字串、null、undefined，或整個鍵缺少。
const actualArb = expected =>
  fc
    .record(
      Object.fromEntries(
        TOOLS.map(t => [
          t,
          fc.oneof(
            fc.constant(expected[t]),
            versionFor(t),
            fc.constantFrom('', null, undefined),
          ),
        ]),
      ),
      { requiredKeys: [] },
    );

const normalizeRef = v => (typeof v === 'string' && v !== '' ? v : null);

describe('Property 3: 工具鏈版本不一致的回報完整且精確', () => {
  test('不一致清單恰為值不同的工具，且每筆含工具名、預期與實際版本', () => {
    fc.assert(
      fc.property(
        expectedArb.chain(expected => fc.tuple(fc.constant(expected), actualArb(expected))),
        ([expected, actual]) => {
          const result = compareToolchain(expected, actual);

          const differing = TOOLS.filter(t => expected[t] !== normalizeRef(actual[t]));

          // 回報的工具集合恰為值不同者，無重複、順序依 TOOLS。
          expect(result.mismatches.map(m => m.tool)).toEqual(differing);

          // 每筆精確記錄預期與實際值（缺少或空字串以 null 表示）。
          for (const m of result.mismatches) {
            expect(m).toEqual({ tool: m.tool, expected: expected[m.tool], actual: normalizeRef(actual[m.tool]) });
          }

          // 清單為空若且唯若三者皆相同。
          expect(result.ok).toBe(differing.length === 0);
          expect(result.ok).toBe(result.mismatches.length === 0);
        },
      ),
      { numRuns: 200 },
    );
  });
});
