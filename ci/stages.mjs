// Pipeline 階段規劃（Req 1.2、1.3、1.4、1.5、1.8、2.3、2.8、3.6、7.1；Design Property 1）。
//
// 純函式：
//   classifyTrigger(trigger) → { kind, trusted, reason? }
//   planStages(trigger)      → { kind, trusted, stages: string[], gates: string[], reject: string|null }
//   triggerFromJenkinsEnv(env, { manual }) → trigger
//
// 信任只由「事件類型 + ref 名稱」決定：手動觸發或重跑（manual）、fork 與否都不會提升信任等級，
// 因此手動重跑的 PR／其他分支建置同樣不含推送、簽章、部署與核准階段（Req 2.8）。
// Release_Tag 的「commit 位於 main 歷史中」檢查在執行期由 Tag Verify 階段（ci/policy/tag.mjs）完成，
// 該階段位於所有推送／部署階段之前（Req 1.5）。
//
// CLI（供 Jenkinsfile 使用，讀取 Jenkins Multibranch 環境變數 BRANCH_NAME、TAG_NAME、CHANGE_ID、CHANGE_FORK）：
//   bun ci/stages.mjs [--manual]
//   輸出規劃 JSON；結束碼 0 可執行、1 觸發被拒絕（例如 Tag 格式不符、不支援的事件）。

import { fileURLToPath } from 'node:url';
import { parseReleaseTag } from './policy/tag.mjs';

export const STAGE = Object.freeze({
  INIT: 'Init',
  TAG_VERIFY: 'Tag Verify',
  TOOLCHAIN: 'Toolchain',
  INSTALL: 'Install',
  BUILD: 'Build',
  UNIT: 'Unit Tests',
  BROWSER: 'Browser Tests',
  SECURITY: 'Security Scan',
  MIGRATION_COMPAT: 'Migration Compatibility',
  DAST: 'DAST',
  IMAGE_BUILD: 'Image Build',
  IMAGE_SCAN: 'Image Scan',
  SBOM: 'SBOM',
  IMAGE_PUSH: 'Image Push',
  IMAGE_SIGN: 'Image Sign',
  STAGING: 'Staging Deploy',
  RESOLVE_DIGEST: 'Resolve Digest',
  VERSION_TAG: 'Version Tag',
  APPROVAL: 'Approval',
  PRODUCTION: 'Production Deploy',
  NOTIFY: 'Notify',
});

/** 只允許出現在 Trusted_Ref 建置的階段（Req 2.8、7.1）。 */
export const TRUSTED_ONLY_STAGES = Object.freeze([
  STAGE.MIGRATION_COMPAT, STAGE.DAST, STAGE.IMAGE_BUILD, STAGE.IMAGE_SCAN, STAGE.SBOM,
  STAGE.IMAGE_PUSH, STAGE.IMAGE_SIGN, STAGE.STAGING, STAGE.RESOLVE_DIGEST, STAGE.VERSION_TAG,
  STAGE.APPROVAL, STAGE.PRODUCTION,
]);

export const TRIGGER_KINDS = Object.freeze(['pull_request', 'main_push', 'branch_push', 'release_tag']);

const QUALITY = [STAGE.TOOLCHAIN, STAGE.INSTALL, STAGE.BUILD, STAGE.UNIT, STAGE.BROWSER, STAGE.SECURITY];

const PLANS = Object.freeze({
  // Req 1.2、1.8：安裝、建置、單元測試、瀏覽器測試與 Security_Scanner；無 DAST（Req 7.1）。
  pull_request: { stages: [STAGE.INIT, ...QUALITY, STAGE.NOTIFY], gates: ['QA', '安全'] },
  branch_push: { stages: [STAGE.INIT, ...QUALITY, STAGE.NOTIFY], gates: ['QA', '安全'] },
  // Req 1.3：QA、安全 → 映像建置 → 映像關卡 → 推送與簽章 → Staging。
  main_push: {
    stages: [
      STAGE.INIT, ...QUALITY, STAGE.MIGRATION_COMPAT, STAGE.DAST,
      STAGE.IMAGE_BUILD, STAGE.IMAGE_SCAN, STAGE.SBOM, STAGE.IMAGE_PUSH, STAGE.IMAGE_SIGN,
      STAGE.STAGING, STAGE.NOTIFY,
    ],
    gates: ['QA', '安全', '映像', 'Staging'],
  },
  // Req 1.4：重跑 QA 與安全，不重新建置；解析 main 產生的 digest → 映像、Staging 關卡 → 核准 → Production。
  release_tag: {
    stages: [
      STAGE.INIT, STAGE.TAG_VERIFY, ...QUALITY, STAGE.MIGRATION_COMPAT, STAGE.DAST,
      STAGE.RESOLVE_DIGEST, STAGE.VERSION_TAG, STAGE.APPROVAL, STAGE.PRODUCTION, STAGE.NOTIFY,
    ],
    gates: ['QA', '安全', '映像', 'Staging', '正式核准', '上線後'],
  },
});

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

/**
 * 依觸發描述分類。
 * @param {{event?: 'pull_request'|'push'|'tag', ref?: string, isPullRequest?: boolean, fork?: boolean, manual?: boolean}} trigger
 * @returns {{kind: string|null, trusted: boolean, reason?: string}}
 */
export function classifyTrigger(trigger) {
  const t = trigger ?? {};
  const ref = typeof t.ref === 'string' ? t.ref : '';
  // 任何 PR 建置一律視為 Untrusted_PR，不論 ref 名稱為何（包含 fork 與手動重跑）。
  if (t.event === 'pull_request' || t.isPullRequest === true) {
    return { kind: 'pull_request', trusted: false };
  }
  if (t.event === 'tag') {
    if (!parseReleaseTag(ref)) {
      return { kind: null, trusted: false, reason: 'Release_Tag 格式不符 v<major>.<minor>.<patch>' };
    }
    return { kind: 'release_tag', trusted: true };
  }
  if (t.event === 'push') {
    if (!BRANCH_RE.test(ref) || ref.includes('..')) {
      return { kind: null, trusted: false, reason: '分支名稱無效' };
    }
    if (ref === 'main') return { kind: 'main_push', trusted: true };
    return { kind: 'branch_push', trusted: false };
  }
  return { kind: null, trusted: false, reason: '不支援的觸發事件' };
}

/**
 * 回傳本次建置的階段序列與要評估的 Release_Gate。
 * 被拒絕的觸發（reject 非 null）只含 Init 與 Notify，不含任何品質、推送或部署階段。
 */
export function planStages(trigger) {
  const c = classifyTrigger(trigger);
  if (!c.kind) {
    return { kind: null, trusted: false, stages: [STAGE.INIT, STAGE.NOTIFY], gates: [], reject: c.reason };
  }
  const plan = PLANS[c.kind];
  return {
    kind: c.kind,
    trusted: c.trusted,
    manual: trigger?.manual === true,
    stages: [...plan.stages],
    gates: [...plan.gates],
    reject: null,
  };
}

/**
 * 由 Jenkins Multibranch 環境變數建立觸發描述。
 * TAG_NAME → tag；CHANGE_ID → pull_request；否則 BRANCH_NAME 的 push。
 */
export function triggerFromJenkinsEnv(env, { manual = false } = {}) {
  const e = env ?? {};
  const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
  if (nonEmpty(e.CHANGE_ID)) {
    return { event: 'pull_request', ref: e.BRANCH_NAME ?? '', isPullRequest: true, fork: nonEmpty(e.CHANGE_FORK), manual };
  }
  if (nonEmpty(e.TAG_NAME)) return { event: 'tag', ref: e.TAG_NAME, isPullRequest: false, fork: false, manual };
  if (nonEmpty(e.BRANCH_NAME)) return { event: 'push', ref: e.BRANCH_NAME, isPullRequest: false, fork: false, manual };
  return { event: 'unknown', ref: '', isPullRequest: false, fork: false, manual };
}

export function main(argv = process.argv.slice(2), { env = process.env, log = console.log, error = console.error } = {}) {
  const plan = planStages(triggerFromJenkinsEnv(env, { manual: argv.includes('--manual') }));
  log(JSON.stringify(plan));
  if (plan.reject) {
    error(`觸發被拒絕：${plan.reject}`);
    return 1;
  }
  return 0;
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
