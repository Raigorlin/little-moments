// Feature: jenkins-cicd-deploy, Property 2: Release_Tag 格式判定與往返
// **Validates: Requirements 1.5**
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { parseReleaseTag, formatReleaseTag, MAX_COMPONENT } from '../ci/policy/tag.mjs';

const RUNS = { numRuns: 200 };

// 獨立 oracle：逐字元判定，不使用正規式，避免與實作共用相同錯誤。
function oracle(s) {
  if (typeof s !== 'string' || s.length < 1 || s[0] !== 'v') return null;
  const segs = s.slice(1).split('.');
  if (segs.length !== 3) return null;
  const nums = [];
  for (const seg of segs) {
    if (seg.length < 1 || seg.length > 6) return null;
    for (let i = 0; i < seg.length; i++) {
      const c = seg.charCodeAt(i);
      if (c < 48 || c > 57) return null; // 僅 ASCII 0-9
    }
    if (seg.length > 1 && seg[0] === '0') return null; // 前導零
    let n = 0;
    for (let i = 0; i < seg.length; i++) n = n * 10 + (seg.charCodeAt(i) - 48);
    nums.push(n);
  }
  return { major: nums[0], minor: nums[1], patch: nums[2] };
}

const component = fc.integer({ min: 0, max: MAX_COMPONENT });
const parts = fc.record({ major: component, minor: component, patch: component });
const validTag = parts.map(p => `v${p.major}.${p.minor}.${p.patch}`);

// 混合字元集：讓隨機字串有相當機率接近合法格式。
const tagChars = fc.constantFrom(
  'v', 'V', '0', '1', '2', '5', '9', '.', '-', '+', ' ', '\t', '\n', 'r', 'c', 'x', '０', '١',
);
const nearTag = fc.array(tagChars, { maxLength: 24 }).map(a => a.join(''));

describe('Property 2: Release_Tag 格式判定與往返', () => {
  test('合法元件格式化後解析回相同元件，且往返字串不變', () => {
    fc.assert(
      fc.property(parts, p => {
        const s = formatReleaseTag(p);
        expect(oracle(s)).toEqual(p);
        expect(parseReleaseTag(s)).toEqual(p);
        expect(formatReleaseTag(parseReleaseTag(s))).toBe(s);
      }),
      RUNS,
    );
  });

  test('任意字串：parseReleaseTag 與獨立 oracle 判定一致，接受者可往返', () => {
    fc.assert(
      fc.property(fc.oneof(nearTag, fc.string(), fc.string({ unit: 'binary' }), validTag), s => {
        const got = parseReleaseTag(s);
        expect(got).toEqual(oracle(s));
        if (got !== null) expect(formatReleaseTag(got)).toBe(s);
      }),
      RUNS,
    );
  });

  test('由合法 Tag 突變產生的字串一律被拒絕', () => {
    const segIndex = fc.integer({ min: 0, max: 2 });
    const replaceSeg = (s, i, f) => {
      const segs = s.slice(1).split('.');
      segs[i] = f(segs[i]);
      return `v${segs.join('.')}`;
    };
    const mutated = fc.oneof(
      // 前導零
      fc.tuple(validTag, segIndex).map(([s, i]) => replaceSeg(s, i, x => `0${x}`)),
      // 後綴
      fc.tuple(validTag, fc.constantFrom('-rc.1', '-beta', '+build.5', '.0', 'a', ' ', '\n', '.')).map(([s, x]) => s + x),
      // 前綴
      fc.tuple(validTag, fc.constantFrom('x', ' ', 'refs/tags/', 'v', '\t', '1')).map(([s, x]) => x + s),
      // 超出範圍
      fc.tuple(validTag, segIndex, fc.integer({ min: MAX_COMPONENT + 1, max: Number.MAX_SAFE_INTEGER }))
        .map(([s, i, n]) => replaceSeg(s, i, () => String(n))),
      // 內部空白
      fc.tuple(validTag, segIndex, fc.constantFrom(' ', '\t', '\u00a0'))
        .map(([s, i, w]) => replaceSeg(s, i, x => w + x)),
      // 大寫 V 或缺少 v
      validTag.map(s => `V${s.slice(1)}`),
      validTag.map(s => s.slice(1)),
      // 段數錯誤
      validTag.map(s => s.slice(0, s.lastIndexOf('.'))),
      fc.tuple(validTag, component).map(([s, n]) => `${s}.${n}`),
      // 空段
      fc.tuple(validTag, segIndex).map(([s, i]) => replaceSeg(s, i, () => '')),
      // 非 ASCII 數字
      fc.tuple(validTag, segIndex, fc.constantFrom('０', '١', '٣', '５'))
        .map(([s, i, d]) => replaceSeg(s, i, () => d)),
    );
    fc.assert(
      fc.property(mutated, s => {
        expect(oracle(s)).toBeNull();
        expect(parseReleaseTag(s)).toBeNull();
      }),
      RUNS,
    );
  });

  test('非字串輸入回傳 null', () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer(), fc.constant(null), fc.constant(undefined), fc.object(), fc.array(fc.string())), v => {
        expect(parseReleaseTag(v)).toBeNull();
      }),
      RUNS,
    );
  });

  test('formatReleaseTag 對不合法元件拋出 RangeError', () => {
    const badComponent = fc.oneof(
      fc.integer({ min: MAX_COMPONENT + 1 }),
      fc.integer({ max: -1 }),
      fc.double({ noInteger: true }),
      fc.constant(Number.NaN),
      fc.string(),
      fc.constant(undefined),
    );
    fc.assert(
      fc.property(parts, badComponent, fc.constantFrom('major', 'minor', 'patch'), (p, bad, key) => {
        expect(() => formatReleaseTag({ ...p, [key]: bad })).toThrow(RangeError);
      }),
      RUNS,
    );
  });

  test('範例邊界', () => {
    expect(parseReleaseTag('v0.0.0')).toEqual({ major: 0, minor: 0, patch: 0 });
    expect(parseReleaseTag('v999999.999999.999999')).toEqual({ major: 999999, minor: 999999, patch: 999999 });
    for (const s of ['v1000000.0.0', 'v01.2.3', 'v1.2.3-rc.1', 'V1.2.3', ' v1.2.3', 'v1.2.3\n', 'v1.2', '']) {
      expect(parseReleaseTag(s)).toBeNull();
    }
  });
});
