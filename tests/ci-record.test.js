// Feature: jenkins-cicd-deploy, Property 42: Build_Record 完整性
// **Validates: Requirements 21.2, 21.11**
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import {
  NOT_APPLICABLE, NOT_RUN, addGateResult, createRecord, finalizeRecord, mergeRecord, validateRecord,
} from '../ci/record.mjs';
import { GATE_ORDER } from '../ci/gates.mjs';

const RUNS = { numRuns: 200 };
const KINDS = ['pull_request', 'branch_push', 'main_push', 'release_tag'];
const NA = '不適用';
const NR = '未執行';

// ---- 獨立 oracle（依設計文件 Build_Record 結構與 Req 21.2 適用性，不引用模組內部表）----
// 每個欄位的適用觸發類型；'never' 表示只在發生時才有值（rollback）。
const ALL = new Set(KINDS);
const TRUSTED = new Set(['main_push', 'release_tag']);
const MAIN_ONLY = new Set(['main_push']);
const TAG_ONLY = new Set(['release_tag']);
const NEVER = new Set();

const ORACLE = {
  build: { job: ALL, number: ALL, url: ALL, startedAt: ALL, endedAt: ALL },
  source: { commit: ALL, trigger: ALL, ref: ALL },
  toolchain: { buildImageDigest: ALL, bun: ALL, node: ALL, chromium: ALL },
  reports: {
    unitJunit: ALL, e2eJunit: ALL, qaInventory: ALL, gitleaks: ALL, osv: ALL, semgrep: ALL,
    zap: TRUSTED, trivy: MAIN_ONLY, sbom: MAIN_ONLY,
  },
  image: { digest: TRUSTED, tags: TRUSTED, signature: TRUSTED },
  backup: { id: TRUSTED, env: TRUSTED, createdAt: TRUSTED, sizeBytes: TRUSTED, sha256: TRUSTED },
  approval: { approver: TAG_ONLY, at: TAG_ONLY, digest: TAG_ONLY, unauthorizedAttempts: 'list' },
  rollback: { trigger: NEVER, by: NEVER, from: NEVER, to: NEVER, reason: NEVER, at: NEVER },
  result: { status: ALL, firstFailedStage: ALL },
};
const ORACLE_TOP = { gates: ALL, deployments: TRUSTED };

function expectedPlaceholder(applicableKinds, kind) {
  if (applicableKinds === NEVER) return NA;
  if (!KINDS.includes(kind)) return NR; // 觸發類型未知：保守標示「未執行」
  return applicableKinds.has(kind) ? NR : NA;
}
const missing = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

// ---- 產生器 ----
const MISSING_TAG = Symbol('absent');
const missingArb = fc.constantFrom(MISSING_TAG, undefined, null, '', []);
const safeStr = fc.stringMatching(/^[a-z0-9][a-z0-9 ._:-]{0,30}$/);
const presentArb = fc.oneof(
  safeStr,
  fc.integer({ min: 0, max: 1_000_000 }),
  fc.boolean(),
  fc.array(safeStr, { minLength: 1, maxLength: 3 }),
  fc.record({ k: safeStr }),
);
const fieldArb = fc.oneof({ weight: 1, arbitrary: missingArb }, { weight: 1, arbitrary: presentArb });
const listArb = fc.oneof(
  fc.constantFrom(MISSING_TAG, undefined, null, []),
  fc.array(fc.record({ id: safeStr, at: safeStr }), { minLength: 1, maxLength: 3 }),
);
const triggerArb = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(...KINDS) },
  { weight: 1, arbitrary: missingArb },
  { weight: 1, arbitrary: fc.constantFrom('manual', 'PR') },
);
const statusArb = fc.oneof(fc.constantFrom('SUCCESS', 'FAILURE', 'ABORTED'), missingArb);

function sectionArb(section) {
  const shape = {};
  for (const [field, cat] of Object.entries(ORACLE[section])) {
    if (section === 'source' && field === 'trigger') shape[field] = triggerArb;
    else if (section === 'result' && field === 'status') shape[field] = statusArb;
    else shape[field] = cat === 'list' ? listArb : fieldArb;
  }
  if (section === 'reports') shape.extraReport = fc.oneof(missingArb, safeStr);
  // 區段本身可整個缺少。
  return fc.oneof({ weight: 1, arbitrary: fc.constant(MISSING_TAG) }, { weight: 5, arbitrary: fc.record(shape) });
}

const partialRecordArb = fc.record({
  ...Object.fromEntries(Object.keys(ORACLE).map((s) => [s, sectionArb(s)])),
  gates: fc.oneof(missingArb, fc.array(fc.record({ gate: fc.constantFrom(...GATE_ORDER), pass: fc.boolean() }), { minLength: 1, maxLength: 3 })),
  deployments: fc.oneof(missingArb, fc.array(fc.record({ env: fc.constantFrom('staging', 'production'), at: safeStr }), { minLength: 1, maxLength: 2 })),
}).map(stripAbsent);

function stripAbsent(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (x !== MISSING_TAG) out[k] = stripAbsent(x);
    return out;
  }
  return v;
}

const optsArb = fc.record({
  status: fc.option(fc.constantFrom('SUCCESS', 'FAILURE', 'ABORTED', 'BOGUS'), { nil: undefined }),
  firstFailedStage: fc.option(fc.oneof(fc.constant(''), safeStr), { nil: undefined }),
  endedAt: fc.option(fc.oneof(fc.constant(''), fc.constant('2026-01-02T03:04:05.000Z')), { nil: undefined }),
}, { requiredKeys: [] });

describe('Property 42: Build_Record 完整性', () => {
  test('finalizeRecord 填滿所有必要欄位、保留既有值、依適用性填入「不適用」或「未執行」', () => {
    fc.assert(fc.property(partialRecordArb, optsArb, (record, opts) => {
      const snapshot = structuredClone(record);
      const out = finalizeRecord(record, opts);
      // 不修改輸入。
      expect(record).toEqual(snapshot);
      expect(NOT_APPLICABLE).toBe(NA);
      expect(NOT_RUN).toBe(NR);

      const kind = record.source?.trigger;
      const inResult = record.result ?? {};

      // result 與 build.endedAt：只在缺少時由 opts 填入。
      let expStatus = inResult.status;
      if (missing(expStatus)) expStatus = ['SUCCESS', 'FAILURE', 'ABORTED'].includes(opts.status) ? opts.status : NR;
      let expFfs = inResult.firstFailedStage;
      if (missing(expFfs)) {
        if (typeof opts.firstFailedStage === 'string' && opts.firstFailedStage !== '') expFfs = opts.firstFailedStage;
        else if (expStatus === 'SUCCESS') expFfs = NA;
        else expFfs = NR;
      }
      expect(out.result.status).toEqual(expStatus);
      expect(out.result.firstFailedStage).toEqual(expFfs);
      const inEnded = record.build?.endedAt;
      const expEnded = !missing(inEnded) ? inEnded
        : (typeof opts.endedAt === 'string' && opts.endedAt !== '' ? opts.endedAt : NR);
      expect(out.build.endedAt).toEqual(expEnded);

      for (const [section, fields] of Object.entries(ORACLE)) {
        expect(out[section]).toBeObject();
        const src = record[section] ?? {};
        for (const [field, applicableKinds] of Object.entries(fields)) {
          if (section === 'result' || (section === 'build' && field === 'endedAt')) continue; // 已於上方驗證
          const before = src[field];
          const after = out[section][field];
          if (applicableKinds === 'list') {
            // 0 次越權嘗試是有效值：缺少時為 []，既有清單保留。
            expect(after).toEqual(before === undefined || before === null ? [] : before);
            continue;
          }
          expect(missing(after)).toBe(false);
          if (missing(before)) expect(after).toBe(expectedPlaceholder(applicableKinds, kind));
          else expect(after).toEqual(before);
        }
        // 額外報告鍵原樣保留。
        if (section === 'reports' && 'extraReport' in src) expect(out.reports.extraReport).toEqual(src.extraReport);
      }
      for (const [key, applicableKinds] of Object.entries(ORACLE_TOP)) {
        if (missing(record[key])) expect(out[key]).toBe(expectedPlaceholder(applicableKinds, kind));
        else expect(out[key]).toEqual(record[key]);
      }
      expect(out.schema).toBe(1);
    }), RUNS);
  });

  test('經 createRecord／mergeRecord／addGateResult 建立的紀錄，finalize 後仍通過 validateRecord', () => {
    const hex = (n) => fc.stringMatching(new RegExp(`^[0-9a-f]{${n}}$`));
    fc.assert(fc.property(
      fc.constantFrom(...KINDS), hex(40), hex(64), fc.integer({ min: 1, max: 99999 }),
      fc.array(fc.record({ gate: fc.constantFrom(...GATE_ORDER), pass: fc.boolean() }), { maxLength: 4 }),
      fc.option(hex(64), { nil: undefined }),
      fc.constantFrom('SUCCESS', 'FAILURE', 'ABORTED'),
      (trigger, commit, bid, number, gates, imageDigest, status) => {
        let r = createRecord({ job: 'release/little-moments/main', number, url: 'https://jenkins.example.lan/x', commit, trigger, ref: 'main', buildImageDigest: `sha256:${bid}` });
        for (const g of gates) r = addGateResult(r, g);
        if (imageDigest) r = mergeRecord(r, { image: { digest: `sha256:${imageDigest}` } });
        const out = finalizeRecord(r, { status, endedAt: '2026-01-02T03:04:05.000Z' });
        expect(validateRecord(out)).toEqual({ ok: true, errors: [] });
        expect(out.source.commit).toBe(commit);
        expect(out.result.status).toBe(status);
        expect(out.approval.unauthorizedAttempts).toEqual([]);
        expect(out.image.digest).toBe(imageDigest ? `sha256:${imageDigest}` : (TRUSTED.has(trigger) ? NR : NA));
        expect(out.reports.trivy).toBe(trigger === 'main_push' ? NR : NA);
        expect(out.approval.approver).toBe(trigger === 'release_tag' ? NR : NA);
        expect(out.rollback.reason).toBe(NA);
        if (gates.length === 0) expect(out.gates).toBe(NR);
        else expect(out.gates).toHaveLength(gates.length);
      },
    ), RUNS);
  });

  test('validateRecord 拒絕未知區段與未知欄位', () => {
    const knownSections = new Set([...Object.keys(ORACLE), ...Object.keys(ORACLE_TOP), 'schema']);
    const name = fc.stringMatching(/^[a-z][A-Za-z0-9]{0,15}$/);
    fc.assert(fc.property(name, name, fc.constantFrom(...Object.keys(ORACLE).filter((s) => s !== 'reports')), safeStr, (sec, field, section, value) => {
      if (!knownSections.has(sec)) {
        const v = validateRecord({ schema: 1, [sec]: { a: value } });
        expect(v.ok).toBe(false);
      }
      if (!(field in ORACLE[section])) {
        const v = validateRecord({ schema: 1, [section]: { [field]: value } });
        expect(v.ok).toBe(false);
        expect(() => mergeRecord({ schema: 1 }, { [section]: { [field]: value } })).toThrow();
      }
    }), RUNS);
  });

  test('validateRecord 拒絕疑似秘密的字串且錯誤訊息不含該值', () => {
    const tail = fc.stringMatching(/^[A-Za-z0-9]{16,32}$/);
    const upperTail = fc.stringMatching(/^[0-9A-Z]{16}$/);
    const secretArb = fc.oneof(
      tail.map((t) => `-----BEGIN RSA PRIVATE KEY-----${t}`),
      tail.map((t) => `-----BEGIN PRIVATE KEY-----${t}`),
      tail.map((t) => `Bearer ${t}`),
      tail.map((t) => `Basic ${t}`),
      tail.map((t) => `ghp_${t}`),
      tail.map((t) => `github_pat_${t}`),
      upperTail.map((t) => `AKIA${t}`),
    ).map((s) => ({ s, token: s.slice(-16) }));
    const placementArb = fc.constantFrom(
      (s) => ({ build: { url: s } }),
      (s) => ({ source: { ref: `x ${s}` } }),
      (s) => ({ image: { tags: ['ok', s] } }),
      (s) => ({ approval: { unauthorizedAttempts: [{ id: s }] } }),
      (s) => ({ deployments: [{ env: 'production', result: s }] }),
      (s) => ({ reports: { custom: s } }),
    );
    fc.assert(fc.property(secretArb, placementArb, ({ s, token }, place) => {
      const record = { schema: 1, ...place(s) };
      const v = validateRecord(record);
      expect(v.ok).toBe(false);
      const joined = v.errors.join('\n');
      expect(joined).toContain('疑似秘密值');
      expect(joined.includes(s)).toBe(false);
      expect(joined.includes(token)).toBe(false);
      let msg = '';
      try { mergeRecord({ schema: 1 }, place(s)); } catch (e) { msg = e.message; }
      expect(msg).not.toBe('');
      expect(msg.includes(token)).toBe(false);
    }), RUNS);
  });
});
