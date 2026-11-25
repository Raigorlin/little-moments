// Feature: jenkins-cicd-deploy, Property 1: 階段規劃只對 Trusted_Ref 包含推送與部署
// **Validates: Requirements 1.2, 1.3, 1.8, 2.8, 3.6；plan.md D1**
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';

import {
  STAGE, TAG_REJECT, TRIGGER_KINDS, TRUSTED_ONLY_STAGES, classifyTrigger, planStages, triggerFromJenkinsEnv,
} from '../ci/stages.mjs';

const RUNS = { numRuns: 200 };

const TRICKY_BRANCHES = ['main', 'main2', 'Main', 'MAIN', 'feature/main', 'main/x', 'mainline', 'release/main', 'dev', 'rust', 'v1.2.3'];
const TRICKY_TAGS = ['v1.2.3', 'v2.0.0', 'v0.0.0', 'v1.2.3-rc.1', 'V1.2.3', 'main', ''];

const branchArb = fc.oneof(
  fc.constantFrom(...TRICKY_BRANCHES),
  fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,30}$/),
  fc.string({ maxLength: 20 }),
);
const tagArb = fc.oneof(fc.constantFrom(...TRICKY_TAGS), fc.string({ maxLength: 20 }));

const triggerArb = fc.oneof(
  fc.record({ event: fc.constant('pull_request'), ref: branchArb, isPullRequest: fc.boolean(), fork: fc.boolean(), manual: fc.boolean() }),
  fc.record({ event: fc.constant('push'), ref: branchArb, isPullRequest: fc.boolean(), fork: fc.boolean(), manual: fc.boolean() }),
  fc.record({ event: fc.constant('tag'), ref: tagArb, isPullRequest: fc.boolean(), fork: fc.boolean(), manual: fc.boolean() }),
  fc.record({ event: fc.constantFrom('unknown', 'release', undefined), ref: branchArb, fork: fc.boolean(), manual: fc.boolean() }),
);

// 預期種類（獨立於實作計算）：PR 優先；Tag 一律拒絕（plan.md D1）；main 推送為 main_push。
function expectedKind(t) {
  if (t.event === 'pull_request' || t.isPullRequest === true) return 'pull_request';
  if (t.event === 'tag') return null;
  if (t.event === 'push') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(t.ref) || t.ref.includes('..')) return null;
    return t.ref === 'main' ? 'main_push' : 'branch_push';
  }
  return null;
}

const QUALITY_ORDER = [STAGE.TOOLCHAIN, STAGE.INSTALL, STAGE.BUILD, STAGE.UNIT, STAGE.SECURITY];
const IMAGE_ORDER = [STAGE.IMAGE_BUILD, STAGE.IMAGE_SCAN, STAGE.SBOM, STAGE.IMAGE_PUSH, STAGE.IMAGE_SIGN];
const DEPLOY_STAGES = [...IMAGE_ORDER, STAGE.STAGING, STAGE.PRODUCTION, STAGE.VERSION_TAG];

describe('Property 1: 階段規劃只對 Trusted_Ref 包含推送與部署', () => {
  test('信任分類與 Trusted_Ref 專屬階段（不受 manual／fork 影響）', () => {
    fc.assert(fc.property(triggerArb, (t) => {
      const plan = planStages(t);
      const kind = expectedKind(t);
      expect(plan.kind).toBe(kind);
      expect(classifyTrigger(t).kind).toBe(kind);
      const trusted = kind === 'main_push';
      expect(plan.trusted).toBe(trusted);
      const hasTrustedOnly = plan.stages.some((s) => TRUSTED_ONLY_STAGES.includes(s));
      expect(hasTrustedOnly).toBe(trusted);
      // 手動重跑或 fork 不改變結果（Req 2.8）
      expect(planStages({ ...t, manual: !t.manual }).stages).toEqual(plan.stages);
      expect(planStages({ ...t, fork: !t.fork }).stages).toEqual(plan.stages);
      expect(new Set(plan.stages).size).toBe(plan.stages.length);
    }), RUNS);
  });

  test('各觸發種類的階段順序：分支與 PR 只有品質階段；main 為品質 → 映像 → Staging → Production → Version Tag', () => {
    fc.assert(fc.property(triggerArb, (t) => {
      const { kind, stages, reject, gates } = planStages(t);
      if (kind === null) {
        expect(typeof reject).toBe('string');
        expect(stages).toEqual([STAGE.INIT, STAGE.NOTIFY]);
        expect(gates).toEqual([]);
        return;
      }
      expect(reject).toBeNull();
      if (kind === 'pull_request' || kind === 'branch_push') {
        expect(stages).toEqual([STAGE.INIT, ...QUALITY_ORDER, STAGE.NOTIFY]);
        expect(gates).toEqual(['QA', '安全']);
        for (const s of DEPLOY_STAGES) expect(stages).not.toContain(s);
      } else {
        expect(kind).toBe('main_push');
        expect(stages).toEqual([STAGE.INIT, ...QUALITY_ORDER, ...IMAGE_ORDER, STAGE.STAGING, STAGE.PRODUCTION, STAGE.VERSION_TAG, STAGE.NOTIFY]);
        expect(gates).toEqual(['QA', '安全', '映像', 'Staging', '上線後']);
      }
    }), RUNS);
  });

  test('Tag 事件一律以固定訊息拒絕（plan.md D1），且不在觸發種類內', () => {
    fc.assert(fc.property(tagArb, fc.boolean(), (ref, manual) => {
      const plan = planStages({ event: 'tag', ref, manual });
      expect(plan).toMatchObject({ kind: null, trusted: false, reject: TAG_REJECT });
    }), RUNS);
    expect(TAG_REJECT).toBe('Release_Tag 不再觸發建置；發布由 main 的推送執行');
    expect(TRIGGER_KINDS).toEqual(['pull_request', 'main_push', 'branch_push']);
    expect(Object.values(STAGE)).not.toContain('Approval');
    expect(Object.values(STAGE)).not.toContain('Tag Verify');
    expect(Object.values(STAGE)).not.toContain('Resolve Digest');
  });

  test('triggerFromJenkinsEnv 對應：CHANGE_ID 優先於 TAG_NAME 與 BRANCH_NAME', () => {
    const opt = fc.option(fc.oneof(fc.constantFrom('', ' ', 'main', 'rust', 'v1.2.3', '12'), fc.string({ maxLength: 10 })), { nil: undefined });
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
          expect(planStages(t).reject).toBe(TAG_REJECT);
        } else if (ne(env.BRANCH_NAME)) {
          expect(t).toMatchObject({ event: 'push', ref: env.BRANCH_NAME });
        } else {
          expect(t.event).toBe('unknown');
          expect(planStages(t).reject).not.toBeNull();
        }
      },
    ), RUNS);
  });

  test('範例：rust 分支只跑 CI；PR 指向 main（含 fork、手動重跑）仍為不可信；main 推送才發布', () => {
    const rust = planStages(triggerFromJenkinsEnv({ BRANCH_NAME: 'rust' }, { manual: true }));
    expect(rust).toMatchObject({ kind: 'branch_push', trusted: false, reject: null });
    expect(rust.stages).toEqual([STAGE.INIT, ...QUALITY_ORDER, STAGE.NOTIFY]);
    for (const manual of [false, true]) {
      const t = triggerFromJenkinsEnv({ CHANGE_ID: '42', BRANCH_NAME: 'main', CHANGE_FORK: 'someone' }, { manual });
      const plan = planStages(t);
      expect(plan.kind).toBe('pull_request');
      expect(plan.stages.some((s) => TRUSTED_ONLY_STAGES.includes(s))).toBe(false);
    }
    expect(planStages({ event: 'push', ref: 'main2' }).kind).toBe('branch_push');
    expect(planStages({ event: 'push', ref: 'feature/main' }).kind).toBe('branch_push');
    const main = planStages({ event: 'push', ref: 'main' }).stages;
    expect(main.indexOf(STAGE.PRODUCTION)).toBe(main.indexOf(STAGE.STAGING) + 1);
    expect(main.indexOf(STAGE.VERSION_TAG)).toBe(main.indexOf(STAGE.PRODUCTION) + 1);
  });
});
