// Pipeline 階段規劃（Req 1.2、1.3、1.8、2.3、2.8、3.6；Design Property 1；plan.md D1）。
//
// 純函式：
//   classifyTrigger(trigger) → { kind, trusted, reason? }
//   planStages(trigger)      → { kind, trusted, stages: string[], gates: string[], reject: string|null }
//   triggerFromJenkinsEnv(env, { manual }) → trigger
//
// 信任只由「事件類型 + ref 名稱」決定：手動觸發或重跑（manual）、fork 與否都不會提升信任等級，
// 因此手動重跑的 PR／其他分支建置同樣不含推送、簽章與部署階段（Req 2.8）。
// Rust 版的發布流程（plan.md D1）：非 main 分支（例如 rust）與 PR 只跑品質階段；推送或合併到 main 即發布
// （品質 → App_Image → Staging → Production → 版本標籤），沒有人工核准。Release_Tag（v*）不再觸發建置。
//
// CLI（供 Jenkinsfile 使用，讀取 Jenkins Multibranch 環境變數 BRANCH_NAME、TAG_NAME、CHANGE_ID、CHANGE_FORK）：
//   bun ci/stages.mjs [--manual]
//   輸出規劃 JSON；結束碼 0 可執行、1 觸發被拒絕（例如 Tag 事件、不支援的事件）。

import { fileURLToPath } from 'node:url';

export const STAGE = Object.freeze({
  INIT: 'Init',
  TOOLCHAIN: 'Toolchain',
  INSTALL: 'Install',
  BUILD: 'Build',
  UNIT: 'Unit Tests',
  SECURITY: 'Security Scan',
  IMAGE_BUILD: 'Image Build',
  IMAGE_SCAN: 'Image Scan',
  SBOM: 'SBOM',
  IMAGE_PUSH: 'Image Push',
  IMAGE_SIGN: 'Image Sign',
  STAGING: 'Staging Deploy',
  PRODUCTION: 'Production Deploy',
  VERSION_TAG: 'Version Tag',
  NOTIFY: 'Notify',
});

/** 只允許出現在 Trusted_Ref（main）建置的階段（Req 2.8）。 */
export const TRUSTED_ONLY_STAGES = Object.freeze([
  STAGE.IMAGE_BUILD, STAGE.IMAGE_SCAN, STAGE.SBOM, STAGE.IMAGE_PUSH, STAGE.IMAGE_SIGN,
  STAGE.STAGING, STAGE.PRODUCTION, STAGE.VERSION_TAG,
]);

export const TRIGGER_KINDS = Object.freeze(['pull_request', 'main_push', 'branch_push']);

/** Tag 事件的固定拒絕訊息（plan.md D1：發布由 main 的推送執行）。 */
export const TAG_REJECT = 'Release_Tag 不再觸發建置；發布由 main 的推送執行';

const QUALITY = [STAGE.TOOLCHAIN, STAGE.INSTALL, STAGE.BUILD, STAGE.UNIT, STAGE.SECURITY];

const PLANS = Object.freeze({
  // Req 1.2、1.8：工具鏈、安裝、建置、Rust／bun／bats 測試與 Security_Scanner；不建置映像、不部署。
  pull_request: { stages: [STAGE.INIT, ...QUALITY, STAGE.NOTIFY], gates: ['QA', '安全'] },
  branch_push: { stages: [STAGE.INIT, ...QUALITY, STAGE.NOTIFY], gates: ['QA', '安全'] },
  // plan.md D1：QA、安全 → 映像建置 → 映像關卡 → 推送與簽章 → Staging → Production（觀察期）→ 版本標籤。
  main_push: {
    stages: [
      STAGE.INIT, ...QUALITY,
      STAGE.IMAGE_BUILD, STAGE.IMAGE_SCAN, STAGE.SBOM, STAGE.IMAGE_PUSH, STAGE.IMAGE_SIGN,
      STAGE.STAGING, STAGE.PRODUCTION, STAGE.VERSION_TAG, STAGE.NOTIFY,
    ],
    gates: ['QA', '安全', '映像', 'Staging', '上線後'],
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
    return { kind: null, trusted: false, reason: TAG_REJECT };
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
 * CHANGE_ID → pull_request；TAG_NAME → tag（一律被拒絕）；否則 BRANCH_NAME 的 push。
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
