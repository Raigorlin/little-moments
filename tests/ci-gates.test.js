// Feature: jenkins-cicd-deploy, Property 45: Release_Gate 依序評估並在第一個失敗處停止
// **Validates: Requirements 1.3, 1.4, 16.1, 23.1, 23.2, 23.3**
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import { GATE_ORDER, runGates } from '../ci/gates.mjs';

const RUNS = { numRuns: 200 };

// 每種結果的產生方式與預期是否通過（獨立 oracle）。
const OUTCOME_KINDS = [
  'pass', 'passStatus', 'passWithReports', 'fail', 'failStatus', 'throw', 'timeout', 'missingReport',
  'null', 'undefined', 'malformedNumber', 'malformedEmpty', 'malformedStatus', 'promise',
  'requiredPartial', 'passWithUnmet', 'staticPass', 'staticFail',
];
const PASSING = new Set(['pass', 'passStatus', 'passWithReports', 'staticPass']);

function makeEntry(gate, kind, calls) {
  const reports = [`${gate}.json`, `${gate}.xml`];
  const outcomes = {
    pass: () => ({ pass: true }),
    passStatus: () => ({ status: 'pass' }),
    passWithReports: () => ({ status: 'pass', reports }),
    fail: () => ({ pass: false, unmet: ['x'] }),
    failStatus: () => ({ status: 'fail' }),
    throw: () => { throw new Error('boom'); },
    timeout: () => ({ status: 'timeout' }),
    missingReport: () => ({ status: 'missing_report' }),
    null: () => null,
    undefined: () => undefined,
    malformedNumber: () => 42,
    malformedEmpty: () => ({}),
    malformedStatus: () => ({ status: 'PASS' }),
    promise: () => Promise.resolve({ pass: true }),
    requiredPartial: () => ({ pass: true, reports: [reports[0]] }),
    passWithUnmet: () => ({ pass: true, unmet: ['未達標'] }),
  };
  const entry = { gate };
  if (kind === 'staticPass') entry.check = { pass: true };
  else if (kind === 'staticFail') entry.check = { status: 'error' };
  else {
    entry.check = () => { calls[gate] = (calls[gate] ?? 0) + 1; return outcomes[kind](); };
  }
  if (kind === 'requiredPartial' || kind === 'passWithReports') entry.requiredReports = reports;
  return entry;
}

const scenarioArb = fc
  .subarray([...GATE_ORDER], { minLength: 1 })
  .chain((gates) => fc.tuple(
    fc.shuffledSubarray(gates, { minLength: gates.length, maxLength: gates.length }),
    fc.array(fc.constantFrom(...OUTCOME_KINDS), { minLength: gates.length, maxLength: gates.length }),
  ))
  .map(([shuffled, kinds]) => shuffled.map((gate, i) => ({ gate, kind: kinds[i] })));

const commitArb = fc.stringMatching(/^[0-9a-f]{40}$/);

describe('Property 45: Release_Gate 依序評估並在第一個失敗處停止', () => {
  test('依 GATE_ORDER 評估、首個非通過即停止、後續 check 不被呼叫', () => {
    fc.assert(fc.property(scenarioArb, commitArb, fc.date({ noInvalidDate: true }), (scenario, commit, at) => {
      const calls = {};
      const gates = scenario.map(({ gate, kind }) => makeEntry(gate, kind, calls));
      const run = runGates(gates, { commit, now: () => at });

      const ordered = [...scenario].sort((a, b) => GATE_ORDER.indexOf(a.gate) - GATE_ORDER.indexOf(b.gate));
      const firstFail = ordered.findIndex((s) => !PASSING.has(s.kind));
      const evalCount = firstFail === -1 ? ordered.length : firstFail + 1;
      const evaluated = ordered.slice(0, evalCount);
      const rest = ordered.slice(evalCount);

      expect(run.results.map((r) => r.gate)).toEqual(evaluated.map((s) => s.gate));
      expect(run.pass).toBe(firstFail === -1);
      expect(run.failedGate).toBe(firstFail === -1 ? null : ordered[firstFail].gate);
      expect(run.skipped).toEqual(rest.map((s) => s.gate));

      evaluated.forEach((s, i) => {
        const r = run.results[i];
        expect(r.pass).toBe(PASSING.has(s.kind));
        expect(r.status === 'pass').toBe(r.pass);
        expect(r.commit).toBe(commit);
        expect(r.evaluatedAt).toBe(at.toISOString());
        expect(Array.isArray(r.unmet)).toBe(true);
        if (!r.pass) expect(r.unmet.length).toBeGreaterThan(0);
        if (typeof gates.find((g) => g.gate === s.gate).check === 'function') expect(calls[s.gate]).toBe(1);
      });
      for (const s of rest) expect(calls[s.gate]).toBeUndefined();
    }), RUNS);
  });

  test('未知或重複的關卡名稱一律拋出，且不呼叫任何 check', () => {
    const badName = fc.string({ maxLength: 10 }).filter((s) => !GATE_ORDER.includes(s));
    fc.assert(fc.property(
      fc.subarray([...GATE_ORDER]),
      fc.oneof(badName.map((name) => ({ type: 'unknown', name })), fc.constantFrom(...GATE_ORDER).map((name) => ({ type: 'dup', name }))),
      fc.nat(),
      (gates, bad, pos) => {
        let called = 0;
        const entries = gates.map((gate) => ({ gate, check: () => { called++; return { pass: true }; } }));
        const extra = { gate: bad.name, check: () => { called++; return { pass: true }; } };
        if (bad.type === 'dup' && !gates.includes(bad.name)) entries.push({ gate: bad.name, check: extra.check });
        entries.splice(pos % (entries.length + 1), 0, extra);
        expect(() => runGates(entries)).toThrow(TypeError);
        expect(called).toBe(0);
      },
    ), RUNS);
  });

  test('範例：非陣列與 null 項目拋出；空陣列通過', () => {
    expect(() => runGates(null)).toThrow(TypeError);
    expect(() => runGates([null])).toThrow(TypeError);
    expect(runGates([])).toEqual({ pass: true, failedGate: null, results: [], skipped: [] });
  });
});
