// Feature: jenkins-cicd-deploy, Property 1: 階段規劃只對 Trusted_Ref 包含推送與部署
// **Validates: Requirements 1.2, 1.3, 1.4, 1.8, 2.8, 3.6, 7.1**
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import {
  STAGE, TRUSTED_ONLY_STAGES, classifyTrigger, planStages, triggerFromJenkinsEnv,
} from '../ci/stages.mjs';

const RUNS = { numRuns: 200 };

// 獨立 oracle：Release_Tag 是否有效（v<major>.<minor>.<patch>，0..999999、無前導零）。
function validTag(s) {
  const m = /^v(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.exec(s);
  return m !== null;
}

const TRICKY_BRANCHES = ['main', 'main2', 'Main', 'MAIN', 'feature/main', 'main/x', 'mainline', 'release/main', 'dev', 'v1.2.3'];
const TRICKY_TAGS = ['v1.2.3', 'v0.0.0', 'v999999.0.1', 'v1.2.3-rc.1', 'V1.2.3', 'v01.2.3', 'v1.2', 'v1.2.3.4', '1.2.3', 'v1.2.3 ', 'v1000000.0.0', 'main', ''];

const segment = fc.oneof(fc.constant('0'), fc.integer({ min: 1, max: 999999 }).map(String), fc.constantFrom('01', '00', '1000000', 'x'));
const tagArb = fc.oneof(
  fc.constantFrom(...TRICKY_TAGS),
  fc.tuple(segment, segment, segment, fc.constantFrom('', '-rc.1', '+b')).map(([a, b, c, s]) => `v${a}.${b}.${c}${s}`),
  fc.string({ maxLength: 20 }),
);
const branchArb = fc.oneof(
  fc.constantFrom(...TRICKY_BRANCHES),
  fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,30}$/),
  fc.string({ maxLength: 20 }),
);

const triggerArb = fc.oneof(
  fc.record({ event: fc.constant('pull_request'), ref: branchArb, isPullRequest: fc.boolean(), fork: fc.boolean(), manual: fc.boolean() }),
  fc.record({ event: fc.constant('push'), ref: branchArb, isPullRequest: fc.boolean(), fork: fc.boolean(), manual: fc.boolean() }),
  fc.record({ event: fc.constant('tag'), ref: tagArb, isPullRequest: fc.boolean(), fork: fc.boolean(), manual: fc.boolean() }),
  fc.record({ event: fc.constantFrom('unknown', 'release', undefined), ref: branchArb, fork: fc.boolean(), manual: fc.boolean() }),
);

// 預期種類（獨立於實作計算）。
function expectedKind(t) {
  if (t.event === 'pull_request' || t.isPullRequest === true) return 'pull_request';
  if (t.event === 'tag') return validTag(t.ref) ? 'release_tag' : null;
  if (t.event === 'push') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(t.ref) || t.ref.includes('..')) return null;
    return t.ref === 'main' ? 'main_push' : 'branch_push';
  }
  return null;
}

const QUALITY_ORDER = [STAGE.INSTALL, STAGE.BUILD, STAGE.UNIT, STAGE.BROWSER, STAGE.SECURITY];
const TEST_STAGES = [STAGE.UNIT, STAGE.BROWSER, STAGE.SECURITY, STAGE.MIGRATION_COMPAT, STAGE.DAST];
const idx = (stages, s) => stages.indexOf(s);

describe('Property 1: 階段規劃只對 Trusted_Ref 包含推送與部署', () => {
  test('信任分類與 Trusted_Ref 專屬階段（不受 manual／fork 影響）', () => {
    fc.assert(fc.property(triggerArb, (t) => {
      const plan = planStages(t);
      const kind = expectedKind(t);
      expect(plan.kind).toBe(kind);
      expect(classifyTrigger(t).kind).toBe(kind);
      const trusted = kind === 'main_push' || kind === 'release_tag';
      expect(plan.trusted).toBe(trusted);
      const hasTrustedOnly = plan.stages.some((s) => TRUSTED_ONLY_STAGES.includes(s));
      expect(hasTrustedOnly).toBe(trusted);
      // 手動重跑不改變結果（Req 2.8）
      expect(planStages({ ...t, manual: !t.manual }).stages).toEqual(plan.stages);
      expect(planStages({ ...t, fork: !t.fork }).stages).toEqual(plan.stages);
      // 階段不重複
      expect(new Set(plan.stages).size).toBe(plan.stages.length);
    }), RUNS);
  });

  test('各觸發種類的階段順序', () => {
    fc.assert(fc.property(triggerArb, (t) => {
      const { kind, stages, reject } = planStages(t);
      if (kind === null) {
        expect(typeof reject).toBe('string');
        expect(stages).toEqual([STAGE.INIT, STAGE.NOTIFY]);
        return;
      }
      expect(reject).toBeNull();
      expect(stages[0]).toBe(STAGE.INIT);
      expect(stages.at(-1)).toBe(STAGE.NOTIFY);
      // Install → Build → Unit → Browser → Security 依序（Req 1.2、3.6）
      const q = QUALITY_ORDER.map((s) => idx(stages, s));
      expect(q.every((i) => i >= 0)).toBe(true);
      for (let i = 1; i < q.length; i++) expect(q[i]).toBeGreaterThan(q[i - 1]);
      // Build 先於任何測試階段（Req 3.6）
      for (const s of TEST_STAGES) if (stages.includes(s)) expect(idx(stages, s)).toBeGreaterThan(idx(stages, STAGE.BUILD));

      if (kind === 'pull_request' || kind === 'branch_push') {
        expect(stages).toEqual([STAGE.INIT, STAGE.TOOLCHAIN, ...QUALITY_ORDER, STAGE.NOTIFY]);
        expect(stages).not.toContain(STAGE.DAST); // Req 7.1
      }
      if (kind === 'main_push') {
        for (const s of [STAGE.DAST, STAGE.IMAGE_BUILD, STAGE.IMAGE_PUSH, STAGE.STAGING]) expect(stages).toContain(s);
        expect(stages).not.toContain(STAGE.APPROVAL);
        expect(stages).not.toContain(STAGE.PRODUCTION);
        const order = [STAGE.SECURITY, STAGE.DAST, STAGE.IMAGE_BUILD, STAGE.IMAGE_PUSH, STAGE.IMAGE_SIGN, STAGE.STAGING].map((s) => idx(stages, s));
        for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
      }
      if (kind === 'release_tag') {
        expect(stages).not.toContain(STAGE.IMAGE_BUILD); // 不重新建置（Req 1.4）
        expect(stages).not.toContain(STAGE.IMAGE_PUSH);
        expect(stages).toContain(STAGE.DAST);
        const tv = idx(stages, STAGE.TAG_VERIFY);
        expect(tv).toBeGreaterThan(0);
        for (const s of TRUSTED_ONLY_STAGES) if (stages.includes(s)) expect(idx(stages, s)).toBeGreaterThan(tv);
        expect(idx(stages, STAGE.PRODUCTION)).toBeGreaterThan(idx(stages, STAGE.APPROVAL));
        expect(idx(stages, STAGE.APPROVAL)).toBeGreaterThan(idx(stages, STAGE.RESOLVE_DIGEST));
      }
    }), RUNS);
  });

  test('triggerFromJenkinsEnv 對應：CHANGE_ID 優先於 TAG_NAME 與 BRANCH_NAME', () => {
    const opt = fc.option(fc.oneof(fc.constantFrom('', ' ', 'main', 'v1.2.3', '12'), fc.string({ maxLength: 10 })), { nil: undefined });
    fc.assert(fc.property(
      fc.record({ CHANGE_ID: opt, CHANGE_FORK: opt, TAG_NAME: opt, BRANCH_NAME: opt }), fc.boolean(),
      (env, manual) => {
        const t = triggerFromJenkinsEnv(env, { manual });
        const ne = (v) => typeof v === 'string' && v.trim() !== '';
        expect(t.manual).toBe(manual);
        if (ne(env.CHANGE_ID)) {
          expect(t.event).toBe('pull_request');
          expect(t.fork).toBe(ne(env.CHANGE_FORK));
          expect(planStages(t).trusted).toBe(false);
        } else if (ne(env.TAG_NAME)) {
          expect(t).toMatchObject({ event: 'tag', ref: env.TAG_NAME });
        } else if (ne(env.BRANCH_NAME)) {
          expect(t).toMatchObject({ event: 'push', ref: env.BRANCH_NAME });
        } else {
          expect(t.event).toBe('unknown');
          expect(planStages(t).reject).not.toBeNull();
        }
      },
    ), RUNS);
  });

  test('範例：PR 指向 main（含 fork、手動重跑）仍為不可信', () => {
    for (const manual of [false, true]) {
      const t = triggerFromJenkinsEnv({ CHANGE_ID: '42', BRANCH_NAME: 'main', CHANGE_FORK: 'someone' }, { manual });
      const plan = planStages(t);
      expect(plan.kind).toBe('pull_request');
      expect(plan.stages.some((s) => TRUSTED_ONLY_STAGES.includes(s))).toBe(false);
    }
    expect(planStages({ event: 'push', ref: 'main2' }).kind).toBe('branch_push');
    expect(planStages({ event: 'push', ref: 'feature/main' }).kind).toBe('branch_push');
    expect(planStages({ event: 'tag', ref: 'v1.2.3-rc.1' }).kind).toBeNull();
    expect(planStages({ event: 'tag', ref: 'V1.2.3' }).kind).toBeNull();
    expect(planStages({ event: 'tag', ref: 'v01.2.3' }).kind).toBeNull();
    expect(planStages({ event: 'tag', ref: 'v1.2.3' }).kind).toBe('release_tag');
  });
});
