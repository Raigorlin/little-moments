// Feature: jenkins-cicd-deploy, Property 10: 秘密遮罩
// **Validates: Requirements 6.4, 15.4, 21.9, 22.8**
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { MASK, normalizeSecrets, secretForms, scrub, findLeaks, scrubBuffer } from '../ci/scrub.mjs';
import { normalizeGitleaks } from '../ci/policy/normalize.mjs';

const RUNS = { numRuns: 150 };
const FORM_NAMES = ['raw', 'base64', 'base64-nopad', 'base64url', 'base64url-nopad', 'url-upper', 'url-lower'];

// 秘密字元集刻意包含遮罩字元 `*`、編碼相關字元（`%`、`=`、`+`、`/`、`-`、`_`）與非 ASCII。
const secretChar = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(...'abcXYZ019') },
  { weight: 2, arbitrary: fc.constantFrom('*', '%', '=', '+', '/', '-', '_', ' ', '&', '?', '#') },
  { weight: 1, arbitrary: fc.constantFrom('é', '密', '碼', '😀', '\n') },
);
// Property 10 的前提：每個秘密長度 ≥ 8。
const secretValue = fc.array(secretChar, { minLength: 8, maxLength: 40 }).map(a => a.join(''));
const secretId = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/);
const secretSet = fc.uniqueArray(fc.record({ id: secretId, value: secretValue }), {
  minLength: 1,
  maxLength: 4,
  selector: e => e.id,
});

const filler = fc.oneof(fc.string({ maxLength: 30 }), fc.string({ unit: 'binary', maxLength: 30 }), fc.constantFrom('', '*', '**', MASK, '%2', '='));

// 依秘密集合產生一段嵌入了任意形式（含兩個秘密重疊拼接）的文字。
function textWithSecrets(S) {
  const pick = fc.tuple(fc.integer({ min: 0, max: S.length - 1 }), fc.constantFrom(...FORM_NAMES));
  const formText = ([i, name]) => secretForms(S[i].value).find(f => f.form === name)?.text ?? S[i].value;
  const segment = fc.oneof(
    filler,
    pick.map(formText),
    // 重疊：前一個秘密的尾端與後一個秘密的開頭共用字元
    fc.tuple(pick, pick, fc.integer({ min: 1, max: 6 })).map(([a, b, k]) => {
      const x = formText(a);
      const y = formText(b);
      return x + y.slice(Math.min(k, y.length - 1));
    }),
    fc.tuple(pick, fc.integer({ min: 1, max: 6 })).map(([a, k]) => {
      const x = formText(a);
      return x.slice(0, -k) + x; // 自身重疊
    }),
  );
  return fc.array(segment, { minLength: 1, maxLength: 8 }).map(a => a.join(''));
}

const scenario = secretSet.chain(S => fc.tuple(fc.constant(S), textWithSecrets(S)));

// 參考實作：直接比對每個（憑證 ID × 形式）是否出現在文字中。
function referenceLeaks(text, S) {
  const out = [];
  for (const { id, value } of S) {
    for (const { form, text: t } of secretForms(value)) {
      if (text.includes(t) && !out.some(o => o.id === id && o.form === form)) out.push({ id, form });
    }
  }
  return out.sort((a, b) => (a.id + '\u0000' + a.form < b.id + '\u0000' + b.form ? -1 : 1));
}

function allFormTexts(S) {
  return S.flatMap(({ value }) => secretForms(value).map(f => f.text));
}

describe('Property 10: 秘密遮罩', () => {
  test('secretForms 涵蓋原文、Base64、Base64URL 與 URL 編碼的全部形式', () => {
    fc.assert(
      fc.property(secretValue, v => {
        const forms = Object.fromEntries(secretForms(v).map(f => [f.form, f.text]));
        const b64 = Buffer.from(v, 'utf8').toString('base64');
        const url = encodeURIComponent(v);
        expect(forms).toEqual({
          raw: v,
          base64: b64,
          'base64-nopad': b64.replace(/=+$/, ''),
          base64url: b64.replace(/\+/g, '-').replace(/\//g, '_'),
          'base64url-nopad': b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
          'url-upper': url,
          'url-lower': url.replace(/%[0-9A-F]{2}/g, m => m.toLowerCase()),
        });
      }),
      RUNS,
    );
  });

  test('scrub 之後任何秘密的任何形式都不再出現，findLeaks 為空', () => {
    fc.assert(
      fc.property(scenario, ([S, text]) => {
        const out = scrub(text, S);
        for (const t of allFormTexts(S)) expect(out.includes(t)).toBe(false);
        expect(findLeaks(out, S)).toEqual([]);
        // Buffer 版本結果相同
        const buf = scrubBuffer(Buffer.from(text, 'utf8'), S).out;
        expect(findLeaks(buf, S)).toEqual([]);
      }),
      RUNS,
    );
  });

  test('findLeaks 恰回報實際出現的（憑證 ID × 形式），且不含秘密值', () => {
    fc.assert(
      fc.property(scenario, ([S, text]) => {
        const leaks = findLeaks(text, S);
        expect(leaks).toEqual(referenceLeaks(text, S));
        for (const l of leaks) {
          expect(Object.keys(l).sort()).toEqual(['form', 'id']);
          expect(FORM_NAMES).toContain(l.form);
        }
        // 回報內容只有 ID 與形式名稱，不含秘密值（ID 長度 ≤ 16、形式名稱為固定字串，均不可能含有長度 ≥ 8 的值，除非值恰為其子字串）
        const serialized = JSON.stringify(leaks);
        for (const { value } of S) {
          const isSubstringOfLabel = S.some(e => e.id.includes(value)) || FORM_NAMES.some(f => f.includes(value));
          if (!isSubstringOfLabel) expect(serialized.includes(value)).toBe(false);
        }
      }),
      RUNS,
    );
  });

  test('不含秘密的文字經 scrub 後不變；空秘密與無效項目被忽略', () => {
    const emptyish = fc.constantFrom([], {}, new Map(), [{ id: 'a', value: '' }], { a: '' }, [{ id: '', value: 'abcdefgh12' }], [{ id: 'x', value: 42 }], null, undefined);
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.string({ unit: 'binary' })), emptyish, (text, S) => {
        expect(normalizeSecrets(S)).toEqual([]);
        expect(scrub(text, S)).toBe(text);
        expect(findLeaks(text, S)).toEqual([]);
      }),
      RUNS,
    );
    fc.assert(
      fc.property(secretSet, fc.oneof(fc.string(), fc.string({ unit: 'binary' })), (S, text) => {
        fc.pre(findLeaks(text, S).length === 0);
        expect(scrub(text, S)).toBe(text);
      }),
      RUNS,
    );
  });

  test('normalizeGitleaks 的結果不含原始秘密值', () => {
    const marker = fc.array(fc.constantFrom(...'QWJKVZqwjkvz'), { minLength: 12, maxLength: 32 }).map(a => 'S' + a.join(''));
    const leak = fc.record({
      RuleID: fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/),
      File: fc.stringMatching(/^[a-z0-9_/.-]{1,30}$/),
      StartLine: fc.integer({ min: 1, max: 10000 }),
      Commit: fc.stringMatching(/^[0-9a-f]{40}$/),
    });
    fc.assert(
      fc.property(fc.array(fc.tuple(leak, marker), { minLength: 1, maxLength: 5 }), entries => {
        const raw = entries.map(([l, s]) => ({ ...l, Secret: s, Match: `token=${s}`, Line: `const k = "${s}";` }));
        const serialized = JSON.stringify(normalizeGitleaks(raw));
        for (const [, s] of entries) expect(serialized.includes(s)).toBe(false);
        for (const [l] of entries) {
          expect(serialized).toContain(l.RuleID);
          expect(serialized).toContain(l.Commit);
        }
      }),
      RUNS,
    );
  });

  test('秘密幾乎全由遮罩字元組成時仍完全遮罩', () => {
    const starry = fc.array(fc.constantFrom('*', '*', '*', 'a', '%'), { minLength: 8, maxLength: 12 }).map(a => a.join(''));
    const S2 = fc.uniqueArray(fc.record({ id: secretId, value: starry }), { minLength: 1, maxLength: 3, selector: e => e.id });
    fc.assert(
      fc.property(S2.chain(S => fc.tuple(fc.constant(S), textWithSecrets(S))), ([S, text]) => {
        expect(findLeaks(scrub(text, S), S)).toEqual([]);
        expect(findLeaks(scrubBuffer(Buffer.from(text, 'utf8'), S).out, S)).toEqual([]);
      }),
      RUNS,
    );
  });

  test('邊界範例：秘密含遮罩字元或與 MASK 相鄰', () => {
    // 回歸：秘密恰為 MASK（`********`）時，以 MASK 取代會重現秘密
    expect(findLeaks(scrub('x********y', [{ id: 'c', value: MASK }]), [{ id: 'c', value: MASK }])).toEqual([]);
    for (const value of ['a*******', '*******b', '**x*****y', `${MASK}z`, '*********', MASK]) {
      const S = [{ id: 'cred', value }];
      const out = scrub(`pre${value}${value}post ${MASK}${value}`, S);
      expect(findLeaks(out, S)).toEqual([]);
    }
  });
});
