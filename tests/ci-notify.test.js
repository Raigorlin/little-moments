// Feature: jenkins-cicd-deploy, Property 44: 通知重試不影響建置結果
// **Validates: Requirements 22.7**
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import {
  DESCRIPTION_MAX,
  MAX_ATTEMPTS,
  githubState,
  notifyWithRetry,
  statusDescription,
} from '../ci/notify.mjs';

const RUNS = { numRuns: 150 };

// 秘密標記含不安全字元（= 與 :），確認不會以原樣出現在任何輸出中。
const SECRET = 'SECRET=tok3n:ghp_abc';

const FAIL_MODES = ['sync', 'async', 'string', 'null', 'secretObj', 'secretError'];

const channelSpecArb = fc.record({
  k: fc.integer({ min: 0, max: 6 }),
  mode: fc.constantFrom(...FAIL_MODES, 'missingSend'),
});

const resultArb = fc.oneof(
  fc.anything(),
  fc.constantFrom('SUCCESS', 'FAILURE', 'ABORTED', NaN, -0, null, undefined),
  fc.func(fc.anything()),
  fc.object().map((o) => Object.freeze(o)),
);

const statusArb = fc.oneof(
  fc.constantFrom('pending', 'success', 'failure', 'aborted', 'timeout', 'rejected', 'error', ' Success ', 'PENDING'),
  fc.string(),
  fc.anything(),
);

const backoffArb = fc.array(fc.oneof(fc.nat(5000), fc.constantFrom(-1, NaN, Infinity)), { minLength: 0, maxLength: 4 });

// 獨立 oracle：第 r 次重試前的等待時間。
function expectedBackoff(arr, r) {
  if (arr.length === 0) return 0;
  const v = arr[Math.min(r, arr.length - 1)];
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function thrower(mode) {
  switch (mode) {
    case 'sync': return () => { throw new TypeError(SECRET); };
    case 'async': return () => Promise.reject(new RangeError(SECRET));
    case 'string': return () => { throw SECRET; };
    case 'null': return () => { throw null; };
    case 'secretObj': return () => { throw { message: SECRET, token: SECRET }; };
    case 'secretError': return () => { const e = new Error(SECRET); e.name = SECRET; throw e; };
    default: throw new Error('unknown mode');
  }
}

function buildChannels(specs, events) {
  return specs.map((spec, i) => {
    const name = `ch-${i}`;
    if (spec.mode === 'missingSend') return { name };
    let calls = 0;
    const fail = thrower(spec.mode);
    return {
      name,
      send: (status, context) => {
        events.push({ type: 'send', i });
        calls += 1;
        if (calls <= spec.k) return fail();
        return spec.mode === 'async' ? Promise.resolve('ok') : 'ok';
      },
    };
  });
}

describe('Property 44: 通知重試不影響建置結果', () => {
  test('notifyWithRetry 每管道最多 4 次、結果不變、摘要只列失敗管道、不洩漏秘密', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(channelSpecArb, { minLength: 0, maxLength: 5 }),
        statusArb,
        resultArb,
        backoffArb,
        fc.boolean(),
        async (specs, status, result, backoffMs, sleepThrows) => {
          const events = [];
          const channels = buildChannels(specs, events);
          const sleep = async (ms) => {
            events.push({ type: 'sleep', ms });
            if (sleepThrows) throw new Error(SECRET);
          };

          let out;
          let threw = false;
          try {
            out = await notifyWithRetry(channels, status, result, { context: { commit: 'a'.repeat(40) }, backoffMs, sleep });
          } catch {
            threw = true;
          }
          expect(threw).toBe(false);
          expect(Object.is(out.result, result)).toBe(true);
          expect(out.deliveries).toHaveLength(specs.length);

          const expectedEvents = [];
          const expectedSummary = [];
          specs.forEach((spec, i) => {
            const d = out.deliveries[i];
            const name = `ch-${i}`;
            expect(d.channel).toBe(name);
            if (spec.mode === 'missingSend') {
              expect(d).toEqual({ channel: name, attempts: 0, ok: false, error: 'InvalidChannel' });
              expectedSummary.push(`通知失敗：${name}`);
              return;
            }
            const attempts = Math.min(spec.k + 1, MAX_ATTEMPTS);
            const ok = spec.k < MAX_ATTEMPTS;
            expect(d.attempts).toBe(attempts);
            expect(d.ok).toBe(ok);
            if (ok) {
              expect('error' in d).toBe(false);
            } else {
              expectedSummary.push(`通知失敗：${name}`);
              expect(typeof d.error).toBe('string');
              expect(d.error).toMatch(/^[A-Za-z][A-Za-z0-9]{0,63}$/);
              expect(d.error.includes(SECRET)).toBe(false);
            }
            for (let a = 0; a < attempts; a += 1) {
              if (a > 0) expectedEvents.push({ type: 'sleep', ms: expectedBackoff(backoffMs, a - 1) });
              expectedEvents.push({ type: 'send', i });
            }
          });

          // 依序執行、互不影響、sleep 次數與值正確。
          expect(events).toEqual(expectedEvents);
          expect(out.summary).toEqual(expectedSummary);
          expect(JSON.stringify({ d: out.deliveries, s: out.summary }).includes(SECRET)).toBe(false);
        },
      ),
      RUNS,
    );
  });

  test('githubState：pending/success 對應自身，其餘一律 failure', () => {
    fc.assert(
      fc.property(statusArb, (status) => {
        const key = typeof status === 'string' ? status.trim().toLowerCase() : '';
        const expected = key === 'pending' || key === 'success' ? key : 'failure';
        expect(githubState(status)).toBe(expected);
      }),
      RUNS,
    );
  });

  test('statusDescription 不超過 140 字元且不含秘密標記', () => {
    const unsafe = fc.string({ unit: fc.constantFrom('<', '>', '"', "'", '=', ':', '$', '{', '}', '\n', '&', '%', '`') });
    const stageArb = fc.oneof(
      fc.tuple(fc.string(), unsafe, fc.string()).map(([a, u, b]) => `${a}${u}${SECRET}${u}${b}`),
      fc.string({ maxLength: 300 }),
      fc.anything(),
    );
    const commitArb = fc.oneof(
      fc.stringMatching(/^[0-9a-f]{40}$/),
      fc.constant(SECRET),
      fc.anything(),
    );
    fc.assert(
      fc.property(statusArb, stageArb, commitArb, (status, failedStage, commit) => {
        const desc = statusDescription(status, { failedStage, commit });
        expect(typeof desc).toBe('string');
        expect(desc.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
        expect(desc.includes(SECRET)).toBe(false);
        if (githubState(status) !== 'failure') expect(desc.includes('失敗階段')).toBe(false);
      }),
      RUNS,
    );
  });
});
