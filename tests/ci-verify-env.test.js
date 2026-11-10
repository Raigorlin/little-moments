// Feature: jenkins-cicd-deploy, Property 4: 測試環境變數驗證只指出有問題的變數
// **Validates: Requirements 3.9**
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { verifyEnv, REQUIRED_EXECUTABLES } from '../ci/verify-env.mjs';

const RUNS = { numRuns: 200 };
const WINDOWS_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// 模擬檔案系統：path → 'exec'（可執行檔）、'noexec'（一般檔案）、'dir'（目錄）；其餘路徑不存在。
function fakeFs(entries) {
  return {
    statSync(p) {
      const kind = entries.get(p);
      if (!kind) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { isFile: () => kind !== 'dir' };
    },
    accessSync(p) {
      if (entries.get(p) !== 'exec') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    },
  };
}

// 每個變數的狀態與預期原因（null 表示有效）。
const STATES = {
  unset: 'unset',
  empty: 'empty',
  missing: 'not_found',
  dir: 'not_file',
  noexec: 'not_executable',
  valid: null,
};

const segmentArb = fc.stringMatching(/^[a-z0-9._-]{1,12}$/);
const pathArb = fc.array(segmentArb, { minLength: 1, maxLength: 4 }).map(parts => `/opt/lm-${parts.join('/')}`);
const varArb = fc.record({
  state: fc.constantFrom(...Object.keys(STATES)),
  path: pathArb,
  blank: fc.constantFrom('', ' ', '\t', '  \n'),
});

describe('Property 4: 測試環境變數驗證只指出有問題的變數', () => {
  test('回報的名稱集合恰為無效變數，原因正確且不含路徑值', () => {
    fc.assert(
      fc.property(
        varArb,
        varArb,
        fc.dictionary(fc.stringMatching(/^X_[A-Z]{1,6}$/), fc.string(), { maxKeys: 3 }),
        (chrome, bun, extraEnv) => {
          const specs = { CHROME_PATH: chrome, CAMPING_BUN: bun };
          const env = { ...extraEnv };
          const entries = new Map();
          const expected = [];
          for (const name of REQUIRED_EXECUTABLES) {
            const { state, path, blank } = specs[name];
            if (state === 'empty') env[name] = blank;
            else if (state !== 'unset') env[name] = path;
            // 兩個變數可能產生相同路徑：先寫入的有效檔案不被後者的 missing 狀態移除，因此以實際 entries 推導預期值。
            if (state === 'dir') entries.set(path, 'dir');
            if (state === 'noexec') entries.set(path, 'noexec');
            if (state === 'valid') entries.set(path, 'exec');
          }
          for (const name of REQUIRED_EXECUTABLES) {
            const { state, path } = specs[name];
            let reason = STATES[state];
            if (state !== 'unset' && state !== 'empty') {
              const kind = entries.get(path);
              reason = !kind ? 'not_found' : kind === 'dir' ? 'not_file' : kind === 'noexec' ? 'not_executable' : null;
            }
            if (reason) expected.push({ name, reason });
          }

          const result = verifyEnv(env, fakeFs(entries));

          expect(result.ok).toBe(expected.length === 0);
          expect(result.problems).toEqual(expected);
          for (const p of result.problems) expect(Object.keys(p).sort()).toEqual(['name', 'reason']);

          const serialized = JSON.stringify(result);
          for (const name of REQUIRED_EXECUTABLES) {
            const value = env[name];
            if (typeof value === 'string' && value.trim() !== '') expect(serialized).not.toContain(value);
          }
          expect(serialized).not.toContain('chrome.exe');
          expect(serialized).not.toContain(JSON.stringify(WINDOWS_CHROME).slice(1, -1));
        },
      ),
      RUNS,
    );
  });

  test('範例：兩者皆有效時通過；env 未提供時兩者皆 unset', () => {
    const fs = fakeFs(new Map([['/usr/bin/chromium', 'exec'], ['/usr/local/bin/bun', 'exec']]));
    expect(verifyEnv({ CHROME_PATH: '/usr/bin/chromium', CAMPING_BUN: '/usr/local/bin/bun' }, fs))
      .toEqual({ ok: true, problems: [] });
    expect(verifyEnv(undefined, fs)).toEqual({
      ok: false,
      problems: [{ name: 'CHROME_PATH', reason: 'unset' }, { name: 'CAMPING_BUN', reason: 'unset' }],
    });
  });
});
