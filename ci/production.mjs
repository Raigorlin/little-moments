// Release_Tag 的正式核准與 Production 部署判定（Requirement 12.6、14.1–14.3、19.1–19.8、20.1–20.7、20.9、20.11、
// 20.12、22.5、23.1–23.3、23.5；Design「部署流程（Production）」、Components §12、§15、Property 40）。
//
// 供根目錄 Jenkinsfile 的「Approval」與「Production Deploy」階段使用：Groovy 只負責流程（input、lock、SSH、
// Smoke_Test、計時），所有判讀都在這裡以純函式完成，任何無法解析或不符的輸出一律視為未通過（fail closed）。
//
// 觀察期（Req 20.5、20.6）：切換後 10 分鐘內每 10 秒一次 Health_Check（共 60 次），切換後 60 秒內與結束前 60 秒內
// 各一次 Smoke_Test。每一筆觀察結果追加後立即以 ci/health.mjs 的 shouldRollback 判定；連續 3 次 Health_Check
// 失敗或任一次 Smoke_Test 失敗即回滾（lm-deploy prod rollback：切回仍在執行的舊槽位並停止新槽位，不執行
// Migration_Runner，Req 20.9）。「上線後」關卡通過若且唯若觀察期完整執行且未觸發回滾、finalize 完成。
//
// 純函式：
//   classifyDeploy(exitCode, text, digest)            → DeployResult（`lm-deploy prod deploy` 的判讀）
//   healthObservation(exitCode, text, t, color)        → { type:'health', t, ok, durationMs? }
//   smokeObservation(exitCode, text, t, phase)         → { type:'smoke', t, ok, phase, failedSteps }
//   observationDecision(observations)                  → { rollback, trigger, reason, summary }
//   observationSummary(observations)                   → { healthChecks, healthFailures, smoke, complete, unmet }
//   rollbackNeeded(deploy, statusText, digest)          → { rollback, reason }
//   classifyRestore({...})                              → RestoreResult（自動回滾後的狀態與健康）
//   productionRecord({...})                             → { patch, gate }（「上線後」關卡與 Build_Record）
//   pendingDestructive(files, deployedNames)            → [{ version, migration }]（需另行核准的破壞性遷移）
//   deployedCommit(statusText, configText)              → { statusOk, digest, commit }（Production 目前版本的 OCI revision）
//   parseTagRemote(text, tag)                           → 40 hex commit | null（`git ls-remote` 的輸出）
//   stagingEvidence({ mainRecord, attestationText, commit, digest }) → 核准畫面的 Staging 結果
//   approvalMessage({...})                              → 核准畫面文字（Req 19.2）
//   approvalRecord({...})                               → { patch, gate, evidence }（「正式核准」關卡與 Build_Record）
//
// CLI（結束碼：0 成功／通過；1 未通過；2 參數或輸入錯誤）：
//   bun ci/production.mjs classify --exit <n> --result <deploy.jsonl> --digest <d> --out <deploy-verdict.json>
//   bun ci/production.mjs observe --obs <observations.json> --type health|smoke --t <秒> --exit <n> --result <f>
//       [--color blue|green] [--phase after-switch|before-end] --out <decision.json>
//       追加一筆觀察結果並判定；0：繼續觀察；1：需回滾
//   bun ci/production.mjs summary --obs <observations.json> --out <summary.json>   0：觀察期完整且未觸發回滾
//   bun ci/production.mjs rollback-needed --deploy <deploy-verdict.json> --status <status.json> --digest <d>
//   bun ci/production.mjs active --status <status.json>                            輸出 { ok, color, digest }
//   bun ci/production.mjs restore --status <status.json> --digest <d> [--rollback <f> --rollback-exit <n>]
//       [--health <f> --health-exit <n>] --out <restore.json>
//   bun ci/production.mjs record --dir <reports/production> --commit <sha> --digest <d> --tag <vX.Y.Z>
//       --signature ok|fail|not_run --finalize ok|fail|not_run [--stage-error <訊息>] --out-patch <f> --out-gate <f>
//   bun ci/production.mjs destructive --migrations <dir> --deployed <names.txt>|unknown --out <f>
//       輸出 { known, pending:[{version, migration}] }
//   bun ci/production.mjs deployed-commit --status <status.json> --config <crane config 輸出>
//       輸出 { statusOk, digest, commit }；0：取得 Production 目前版本的 commit
//   bun ci/production.mjs tag-remote --result <ls-remote.txt> --tag <vX.Y.Z> --commit <sha>  0：Tag 仍指向該 commit
//   bun ci/production.mjs approval-message --tag <t> --commit <sha> --digest <d> --main-record <f> --attestation <f>
//       [--destructive <destructive.json>] --build-url <url> --out <message.txt>
//   bun ci/production.mjs approval-record --in <approval-input.json> --out-patch <f> --out-gate <f> --out-evidence <f>
//       0：「正式核准」關卡通過

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HEALTH_TIMEOUT_MS, healthyWithin, isHealthSuccess, shouldRollback } from './health.mjs';
import { NOT_APPLICABLE, NOT_RUN, validateRecord } from './record.mjs';
import { STAGING_PREDICATE_TYPE } from './resolve-digest.mjs';
import { classifyHealth, parseStatus } from './rollback.mjs';
import { healthCadenceOk, parseJsonLines, parseSmoke } from './staging.mjs';
import { parseReleaseTag } from './policy/tag.mjs';
import { hasDestructiveMarker, parseMigrationFileName } from '../server/db/migrations.js';
import { detectDestructive } from '../scripts/lint-migrations.mjs';

export const STARTUP_INTERVAL_SEC = 5;
export const STARTUP_WINDOW_SEC = 120;
export const STARTUP_NEED = 3;
export const OBSERVATION_SEC = 600;
export const OBSERVATION_INTERVAL_SEC = 10;
export const OBSERVATION_CHECKS = 60;
export const SMOKE_WINDOW_SEC = 60;
export const ROLLBACK_CONSECUTIVE = 3;
export const SMOKE_PHASES = Object.freeze(['after-switch', 'before-end']);

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const COLOR_RE = /^(blue|green)$/;
const CODE_RE = /^[a-z][a-z_]{0,39}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const BACKUP_ID_RE = /^prod-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const TEXT_RE = /^[^\u0000-\u001f\u007f]{1,200}$/;
const MIGRATION_PATH_RE = /^migrations\/\d{4,}_[a-z0-9_]+\.sql$/;

export const isDigest = (v) => typeof v === 'string' && DIGEST_RE.test(v);
const isCommit = (v) => typeof v === 'string' && COMMIT_RE.test(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTime = (v) => typeof v === 'number' && Number.isFinite(v);
const safeCode = (v) => (typeof v === 'string' && CODE_RE.test(v) ? v : null);
const lastOf = (lines, pred) => { for (let i = lines.length - 1; i >= 0; i--) if (pred(lines[i])) return lines[i]; return null; };
const slotOf = (v) => (isObj(v) && COLOR_RE.test(v.color ?? '') && isDigest(v.digest) ? { color: v.color, digest: v.digest } : null);
const short = (d) => (isDigest(d) ? d.slice(0, 19) : '無');

/** Health_Check 結果只保留 { t, ok, durationMs }（與 ci/health.mjs 的 HealthResult 相同）。 */
function sanitizeHealth(results) {
  if (!Array.isArray(results) || results.length === 0 || results.length > 64) return null;
  const out = [];
  for (const r of results) {
    if (!isObj(r) || !isTime(r.t) || typeof r.ok !== 'boolean') return null;
    const entry = { t: r.t, ok: r.ok };
    if (r.durationMs !== undefined) {
      if (!isTime(r.durationMs)) return null;
      entry.durationMs = r.durationMs;
    }
    out.push(entry);
  }
  return out;
}

function sanitizeBackup(b) {
  if (!isObj(b) || b.ok !== true || b.command !== 'backup') return null;
  if (typeof b.id !== 'string' || !BACKUP_ID_RE.test(b.id) || b.env !== 'prod') return null;
  if (typeof b.createdAt !== 'string' || !ISO_RE.test(b.createdAt)) return null;
  if (!Number.isSafeInteger(b.sizeBytes) || b.sizeBytes <= 0) return null;
  if (typeof b.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.sha256)) return null;
  return { id: b.id, env: 'prod', createdAt: b.createdAt, sizeBytes: b.sizeBytes, sha256: b.sha256 };
}

// lm-deploy 的失敗原因 → 失敗步驟與固定訊息（不含 lm-deploy 輸出內容）。
const FAILURES = Object.freeze({
  backup_create_failed: ['backup', '備份建立失敗；未執行 Migration_Runner，Production 維持不變（Req 14.3）'],
  backup_verify_failed: ['backup', '備份驗證失敗；未執行 Migration_Runner，Production 維持不變（Req 14.3）'],
  backup_timeout: ['backup', '備份未在 30 分鐘內完成；未執行 Migration_Runner，Production 維持不變（Req 14.3）'],
  backup_dir_invalid: ['backup', '備份目錄不符合權限要求；未執行 Migration_Runner，Production 維持不變'],
  backup_required: ['migrate', 'Migration_Runner 前缺少已驗證備份；未啟動新版容器'],
  migrate_failed: ['migrate', 'Migration_Runner 失敗；未啟動新版容器，舊版容器持續處理 100% 流量'],
  start_failed: ['start', '新版 App_Server 容器無法啟動；已移除新容器，reverse proxy 未變更'],
  health_failed: ['health', '新版 App_Server 容器未在 120 秒內連續 3 次 Health_Check 成功；已停止並移除新容器，reverse proxy 未變更（Req 20.4）'],
  switch_failed: ['switch', 'reverse proxy 切換失敗；新版容器仍在執行，需回滾'],
});
const BACKUP_FAILURE_KIND = Object.freeze({
  backup_create_failed: 'create', backup_verify_failed: 'verify', backup_timeout: 'timeout', backup_dir_invalid: 'create',
});
const REFUSED = Object.freeze({
  invalid_phase: 'Production 有未完成的部署（非本次建置），需人工 finalize 或 rollback；未變更 Production',
  state_invalid: 'Deploy_Host 的 Production 狀態檔無效，需人工介入；未變更 Production',
  locked: '已有部署進行中（Deploy_Host 的 lm-prod 鎖已被持有）；未變更 Production',
});

/**
 * 判讀 `lm-deploy prod deploy <digest> --app-env-stdin`（backup → app-env → migrate → start → health --wait → switch）。
 * outcome：switched | failed | refused | unknown（意義與 ci/staging.mjs classifyDeploy 相同）。
 * 啟動健康檢查為 120 秒內每 5 秒一次、連續 3 次成功（Req 20.3、20.4）。
 */
export function classifyDeploy(exitCode, text, digest) {
  const lines = parseJsonLines(text);
  const ok = (cmd) => lastOf(lines, (l) => l.ok === true && l.command === cmd);
  const failure = lastOf(lines, (l) => l.ok === false);
  const code = safeCode(failure?.reason);
  const backup = sanitizeBackup(ok('backup'));
  const migrate = ok('migrate');
  const start = ok('start');
  const healthLine = lastOf(lines, (l) => l.command === 'health');
  const sw = ok('switch');
  const health = sanitizeHealth(healthLine?.results);
  const healthy = !!health && healthLine?.ok === true && healthLine.healthy === true
    && healthyWithin(health, STARTUP_WINDOW_SEC, STARTUP_NEED);
  const cadenceOk = !!health && healthCadenceOk(health, STARTUP_INTERVAL_SEC);
  const started = !!start && start.digest === digest && COLOR_RE.test(start.color ?? '')
    && typeof start.image === 'string' && start.image.endsWith(`@${digest}`);
  const base = {
    digest: isDigest(digest) ? digest : null,
    exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
    code,
    backup,
    backupFailure: code && BACKUP_FAILURE_KIND[code] ? BACKUP_FAILURE_KIND[code] : null,
    migrated: !!migrate && migrate.digest === digest,
    started,
    color: started ? start.color : null,
    health,
    healthy,
    cadenceOk,
    previous: sw ? slotOf(sw.from) : null,
  };
  if (!isDigest(digest)) return { ...base, outcome: 'refused', failedStep: 'input', message: 'digest 格式無效' };
  if (exitCode === 0) {
    const unmet = [];
    if (!backup) unmet.push('缺少已驗證備份的輸出');
    if (!base.migrated) unmet.push('缺少 Migration_Runner 完成的輸出');
    if (!started) unmet.push('新版容器的 Image_Digest 與 Staging 驗證紀錄不一致');
    if (!healthy) unmet.push('啟動後 120 秒內未連續 3 次 Health_Check 成功');
    else if (!cadenceOk) unmet.push('啟動 Health_Check 間隔小於 5 秒（Req 20.3）');
    if (!sw || sw.to?.digest !== digest || sw.to?.color !== base.color) unmet.push('reverse proxy 未切換至新版容器');
    if (unmet.length === 0) return { ...base, outcome: 'switched', failedStep: null, message: '已部署並切換至新版容器' };
    return { ...base, outcome: 'unknown', failedStep: 'output', message: `lm-deploy 回報成功但輸出不符：${unmet.join('；')}` };
  }
  if (exitCode === 4) return { ...base, outcome: 'refused', failedStep: 'lock', message: REFUSED.locked };
  if (exitCode === 3 && (code === 'invalid_phase' || code === 'state_invalid')) {
    return { ...base, outcome: 'refused', failedStep: 'state', message: REFUSED[code] };
  }
  if (exitCode === 2) return { ...base, outcome: 'refused', failedStep: 'input', message: 'lm-deploy 拒絕部署（參數或設定無效）；未變更 Production' };
  if ((exitCode === 1 || exitCode === 3) && code && FAILURES[code]) {
    if (code === 'health_failed' && failure?.command === 'switch') {
      return { ...base, outcome: 'failed', failedStep: 'switch', message: '切換前健康檢查失敗；新版容器仍在執行，需回滾' };
    }
    const [step, message] = FAILURES[code];
    return { ...base, outcome: 'failed', failedStep: step, message };
  }
  return { ...base, outcome: 'unknown', failedStep: 'unknown', message: `部署結果不明（結束碼 ${base.exitCode ?? '無'}）；需確認狀態並回滾` };
}

// ------------------------------------------------------------------ 觀察期

/** 單次 `lm-deploy prod health <color>` 的結果 → Observation（t 為切換後的秒數）。 */
export function healthObservation(exitCode, text, t, color = null) {
  if (!isTime(t)) throw new TypeError('t 必須是數值');
  const h = lastOf(parseJsonLines(text), (l) => l.command === 'health');
  const durationMs = isTime(h?.durationMs) && h.durationMs >= 0 ? Math.round(h.durationMs) : undefined;
  const colorOk = color === null || h?.color === color;
  const ok = exitCode === 0 && h?.ok === true && h.healthy === true && colorOk
    && (durationMs === undefined || durationMs <= HEALTH_TIMEOUT_MS);
  const o = { type: 'health', t, ok };
  if (durationMs !== undefined) o.durationMs = durationMs;
  return o;
}

/** Smoke_Test（scripts/smoke.mjs）的結果 → Observation；只保留未通過的步驟名稱（Req 21.10）。 */
export function smokeObservation(exitCode, text, t, phase) {
  if (!isTime(t)) throw new TypeError('t 必須是數值');
  if (!SMOKE_PHASES.includes(phase)) throw new TypeError('phase 必須是 after-switch 或 before-end');
  const s = parseSmoke(exitCode, text);
  const failedSteps = s.steps.filter((x) => x.result !== 'pass').map((x) => x.step);
  return { type: 'smoke', t, ok: s.ok === true, phase, failedSteps, timedOut: s.timedOut === true };
}

const REASON_TEXT = Object.freeze({
  health_consecutive_failures: 'Health_Check 連續 3 次失敗',
  smoke_failed: 'Smoke_Test 失敗',
});

/** 以 shouldRollback 判定（Req 20.6）；trigger 為第一個滿足回滾條件的觀察位置。 */
export function observationDecision(observations) {
  if (!Array.isArray(observations)) throw new TypeError('observations 必須是陣列');
  const trigger = shouldRollback(observations, { consecutive: ROLLBACK_CONSECUTIVE, periodSec: OBSERVATION_SEC });
  let reason = null;
  if (trigger) {
    const o = observations[trigger.index];
    if (trigger.reason === 'smoke_failed') {
      const steps = Array.isArray(o?.failedSteps) && o.failedSteps.length ? `（未通過：${o.failedSteps.join(', ')}）` : '';
      reason = `${REASON_TEXT.smoke_failed}${steps}`;
    } else {
      const ts = (trigger.failures ?? []).map((i) => observations[i]?.t).filter(isTime).map((x) => `${Math.round(x)}`);
      reason = `${REASON_TEXT.health_consecutive_failures}${ts.length ? `（切換後 ${ts.join('、')} 秒）` : ''}`;
    }
  }
  return { rollback: trigger !== null, trigger, reason, summary: observationSummary(observations) };
}

/**
 * 觀察期是否完整（「上線後」關卡的報告完整性，Req 23.3）：60 次 Health_Check、切換後 60 秒內與結束前 60 秒內
 * 各一次通過的 Smoke_Test，且未觸發回滾。
 */
export function observationSummary(observations) {
  const list = Array.isArray(observations) ? observations : [];
  const inPeriod = (o) => isObj(o) && isTime(o.t) && o.t >= 0 && o.t <= OBSERVATION_SEC;
  const health = list.filter((o) => inPeriod(o) && o.type === 'health');
  const smoke = list.filter((o) => inPeriod(o) && o.type === 'smoke');
  const healthFailures = health.filter((o) => !isHealthSuccess(o)).length;
  const after = smoke.find((o) => o.phase === 'after-switch' && o.t <= SMOKE_WINDOW_SEC);
  const end = smoke.find((o) => o.phase === 'before-end' && o.t >= OBSERVATION_SEC - SMOKE_WINDOW_SEC);
  const trigger = shouldRollback(list, { consecutive: ROLLBACK_CONSECUTIVE, periodSec: OBSERVATION_SEC });
  const unmet = [];
  if (health.length < OBSERVATION_CHECKS) unmet.push(`觀察期只完成 ${health.length} 次 Health_Check（需 ${OBSERVATION_CHECKS} 次）`);
  if (!after) unmet.push('切換後 60 秒內未執行 Smoke_Test');
  else if (after.ok !== true) unmet.push('切換後的 Smoke_Test 未通過');
  if (!end) unmet.push('觀察期結束前 60 秒內未執行 Smoke_Test');
  else if (end.ok !== true) unmet.push('觀察期結束前的 Smoke_Test 未通過');
  if (trigger) unmet.push(trigger.reason === 'smoke_failed' ? 'Smoke_Test 失敗' : 'Health_Check 連續 3 次失敗');
  return {
    healthChecks: health.length,
    healthFailures,
    smoke: smoke.map((o) => ({ phase: o.phase, t: o.t, ok: o.ok === true, failedSteps: Array.isArray(o.failedSteps) ? o.failedSteps : [] })),
    complete: unmet.length === 0,
    unmet,
  };
}

// ------------------------------------------------------------------ 回滾與還原

/**
 * 是否需要 `lm-deploy prod rollback`（自動回滾）：lm-deploy 拒絕的部署從不回滾；其餘情況下 phase 不是 idle
 * 且候選或作用中槽位為本次 digest 時回滾。狀態無法解析時仍嘗試回滾（idle 時 lm-deploy 以 nothing_to_rollback 拒絕）。
 */
export function rollbackNeeded(deploy, statusText, digest) {
  if (isObj(deploy) && deploy.outcome === 'refused') return { rollback: false, reason: 'lm-deploy 拒絕部署，Production 未變更' };
  const p = parseStatus(statusText);
  if (!p.ok) return { rollback: true, reason: `${p.reason}；嘗試回滾` };
  const { phase, active, candidate } = p.status;
  if (phase === 'idle') return { rollback: false, reason: 'Production 沒有進行中的部署' };
  if (candidate?.digest === digest || active?.digest === digest) return { rollback: true, reason: `部署停在 ${phase}，切回前一個 Image_Digest` };
  return { rollback: false, reason: '進行中的部署不是本次建置的 Image_Digest' };
}

/**
 * 判讀自動回滾後的狀態（Req 20.4、20.6、20.11）：
 *   restored        新版已停止，作用中槽位為前一個 Image_Digest，且 120 秒內連續 3 次 Health_Check 成功
 *   new_stopped     切換前失敗：新版已移除，舊版從未停止服務（不需健康等待以外的動作）
 *   restore_unhealthy／status_unknown／new_container_running／no_restore_target → 需人工介入，不再做任何自動切換
 */
export function classifyRestore({ statusText, digest, rollbackAttempted = false, rollbackExit = null, rollbackText = '', healthExit = null, healthText = '' } = {}) {
  const rbLast = lastOf(parseJsonLines(rollbackText), () => true);
  const rollback = {
    attempted: rollbackAttempted === true,
    ok: rollbackAttempted === true && rollbackExit === 0 && rbLast?.ok === true && rbLast.command === 'rollback'
      && rbLast.mode === 'auto' && rbLast.migrationsRun === false,
    code: rollbackAttempted === true ? (rollbackExit === 0 ? 'rolled_back' : safeCode(rbLast?.reason) ?? 'rollback_failed') : 'not_needed',
  };
  const base = { digest: isDigest(digest) ? digest : null, rollback, target: null, newStopped: false, noRestoreTarget: false, manualIntervention: true };
  if (!isDigest(digest)) return { ...base, restored: false, code: 'invalid_input', message: 'digest 格式無效' };
  const p = parseStatus(statusText);
  if (!p.ok) return { ...base, restored: false, code: 'status_unknown', message: `無法確認回滾後的 Production 狀態（${p.reason}），需人工介入` };
  const { phase, active, candidate } = p.status;
  const newStopped = phase === 'idle' && candidate === null && active?.digest !== digest;
  if (!newStopped) {
    return { ...base, restored: false, code: 'new_container_running', message: '新版容器仍在執行或部署未回到 idle，需人工介入' };
  }
  if (!active) {
    return {
      ...base, restored: false, newStopped: true, noRestoreTarget: true, code: 'no_restore_target',
      message: '沒有前一個 Image_Digest 可切回；已停止新版容器，需人工介入',
    };
  }
  const h = classifyHealth(healthExit ?? -1, healthText);
  const hl = lastOf(parseJsonLines(healthText), (l) => l.command === 'health');
  if (h.healthy !== true || hl?.color !== active.color) {
    return {
      ...base, restored: false, newStopped: true, target: active.digest, code: 'restore_unhealthy',
      message: '已切回前一個 Image_Digest，但 120 秒內未連續 3 次 Health_Check 成功；已停止自動切換，需人工介入（Req 20.11）',
    };
  }
  return {
    ...base, restored: true, newStopped: true, target: active.digest, manualIntervention: false, code: 'restored',
    message: rollback.attempted
      ? '已切回前一個 Image_Digest，且 120 秒內連續 3 次 Health_Check 成功'
      : '新版容器未切換且已移除；前一個 Image_Digest 持續處理 100% 流量，且 120 秒內連續 3 次 Health_Check 成功',
  };
}

// ------------------------------------------------------------------ Build_Record 與「上線後」關卡

const FACTS = new Set(['ok', 'fail', 'not_run']);

/**
 * Build_Record patch（deployments、backup、rollback）與「上線後」關卡（Req 20.7、20.9、23.1、23.2、23.5）。
 * 關卡通過若且唯若：部署前簽章驗證通過、已切換、觀察期完整且未觸發回滾、finalize 完成、沒有階段錯誤。
 */
export function productionRecord({
  commit, digest, tag, deploy = null, observations = null, restore = null,
  signature = 'not_run', finalize = 'not_run', stageError = null, at = new Date().toISOString(), reports = [],
} = {}) {
  for (const [name, v] of [['signature', signature], ['finalize', finalize]]) {
    if (!FACTS.has(v)) throw new TypeError(`${name} 必須是 ok、fail 或 not_run`);
  }
  if (stageError !== null && (typeof stageError !== 'string' || !TEXT_RE.test(stageError))) throw new TypeError('stageError 格式無效');
  const switched = isObj(deploy) && deploy.outcome === 'switched';
  const decision = switched && Array.isArray(observations) ? observationDecision(observations) : null;
  const summary = decision ? decision.summary : null;
  const unmet = [];
  if (stageError) unmet.push(`檢查階段執行錯誤：${stageError}`);
  if (signature !== 'ok') unmet.push(signature === 'fail' ? 'Image_Digest 的簽章無法以設定的公鑰驗證，未部署（Req 17.8）' : '未驗證 Image_Digest 的簽章');
  else if (!deploy) unmet.push('未執行 Production 部署');
  else if (!switched) unmet.push(deploy.message || '部署未完成');
  else if (!summary) unmet.push('未執行觀察期');
  else unmet.push(...summary.unmet);
  const observed = !!summary && summary.complete;
  if (observed && finalize !== 'ok') unmet.push('lm-deploy prod finalize 未完成');
  if (restore && !restore.restored && restore.code !== 'not_needed') unmet.push(restore.message || '回滾後狀態未確認，需人工介入');
  const pass = unmet.length === 0 && signature === 'ok' && switched && observed && finalize === 'ok' && !restore;
  const status = pass ? 'pass' : (stageError ? 'error' : 'fail');
  const gate = {
    gate: '上線後', pass, status, commit: isCommit(commit) ? commit : NOT_RUN,
    unmet: pass ? [] : (unmet.length ? [...new Set(unmet)] : ['未符合通過條件']),
    reports: reports.filter((r) => typeof r === 'string'),
  };

  let result;
  if (pass) result = 'released';
  else if (signature !== 'ok') result = 'signature_failed';
  else if (!deploy) result = 'not_deployed';
  else if (deploy.outcome === 'refused') result = 'refused';
  else if (restore?.restored && !restore.rollback?.attempted) result = 'not_switched';
  else if (restore?.restored) result = 'rolled_back';
  else if (restore) result = 'manual_intervention';
  else if (observed) result = 'observed_not_finalized';
  else result = 'manual_intervention';

  const entry = {
    env: 'production',
    digest: isDigest(digest) ? digest : NOT_APPLICABLE,
    commit: isCommit(commit) ? commit : NOT_APPLICABLE,
    tag: typeof tag === 'string' && parseReleaseTag(tag) ? tag : NOT_APPLICABLE,
    at,
    result,
    signature,
    migrationsRun: !!deploy?.migrated,
  };
  if (deploy) {
    entry.outcome = deploy.outcome;
    if (deploy.failedStep) entry.failedStep = deploy.failedStep;
    if (deploy.code) entry.code = deploy.code;
    entry.backupId = deploy.backup?.id ?? NOT_APPLICABLE;
    if (deploy.backupFailure) entry.backupFailure = deploy.backupFailure;
    if (deploy.color) entry.color = deploy.color;
    if (Array.isArray(deploy.health)) entry.startupHealthChecks = deploy.health;
    if (deploy.previous) entry.previousDigest = deploy.previous.digest;
  }
  if (summary) {
    entry.observation = {
      healthChecks: summary.healthChecks,
      healthFailures: summary.healthFailures,
      smoke: summary.smoke,
      complete: summary.complete,
      rollbackTriggered: decision.rollback,
    };
    if (decision.reason) entry.observation.rollbackReason = decision.reason;
  }
  if (observed) entry.finalize = finalize;
  if (restore) {
    entry.manualInterventionRequired = restore.manualIntervention === true;
    entry.restore = {
      restored: restore.restored === true,
      newStopped: restore.newStopped === true,
      target: isDigest(restore.target) ? restore.target : NOT_APPLICABLE,
      code: safeCode(restore.code) ?? 'unknown',
      rollback: restore.rollback?.code ?? 'not_needed',
    };
  }

  const patch = { deployments: [entry] };
  if (deploy?.backup) patch.backup = { ...deploy.backup };
  // 只有切換後（觀察期或切換結果不明）才是 Req 20.9 的「回滾」；切換前失敗由 lm-deploy 移除新容器，舊版從未停止服務。
  if (restore && restore.rollback?.attempted) {
    const why = decision?.reason ?? (deploy?.message ? `部署未完成：${deploy.message}` : (stageError ?? '部署未完成'));
    patch.rollback = {
      trigger: 'auto',
      by: 'pipeline',
      from: isDigest(digest) ? digest : NOT_APPLICABLE,
      to: restore.restored && isDigest(restore.target) ? restore.target : NOT_APPLICABLE,
      reason: restore.restored ? why.slice(0, 500) : `${why}；回滾後需人工介入`.slice(0, 500),
      at,
    };
  }
  const v = validateRecord(patch);
  if (!v.ok) throw new TypeError(`Build_Record patch 無效：${v.errors.join('；')}`);
  return { patch, gate };
}

/** 建置摘要（Req 22.5）：回滾原因、回滾前與回滾後的 Image_Digest（皆為固定文字或已驗證的 digest）。 */
export function rollbackSummary({ digest, restore, reason }) {
  const to = restore?.restored && isDigest(restore.target) ? short(restore.target) : '未確認（需人工介入）';
  return `Production 自動回滾：${reason || '部署或觀察期失敗'}；回滾前 ${short(digest)} → 回滾後 ${to}`;
}

// ------------------------------------------------------------------ 破壞性遷移、Tag 與核准

/**
 * 需在套用至 Production 前另行核准的破壞性遷移（Req 12.6）：本次 commit 的遷移檔中，標記 `-- lm:destructive`
 * 或含破壞性語句者，且版本號不在 Production 目前版本的遷移檔中。deployedNames 為 null（無法判定 Production
 * 目前版本）時，所有破壞性遷移皆需核准（fail closed）。
 * @param {{name:string, content:string}[]} files
 * @param {string[]|null} deployedNames
 */
export function pendingDestructive(files, deployedNames) {
  if (!Array.isArray(files)) throw new TypeError('files 必須是陣列');
  const deployed = Array.isArray(deployedNames)
    ? new Set(deployedNames.map((n) => parseMigrationFileName(String(n).replace(/^.*\//, ''))).filter((v) => v !== null))
    : null;
  const out = [];
  for (const f of files) {
    const version = parseMigrationFileName(f?.name);
    if (version === null || typeof f.content !== 'string') continue;
    let destructive = hasDestructiveMarker(f.content);
    if (!destructive) {
      try { destructive = detectDestructive(f.content); } catch { destructive = true; }
    }
    if (!destructive) continue;
    if (deployed && deployed.has(version)) continue;
    out.push({ version, migration: `migrations/${f.name}` });
  }
  return out.sort((a, b) => a.version - b.version);
}

/**
 * Production 目前版本的 commit：`lm-deploy prod status` 的作用中 digest，與 `crane config <repo>@<digest>` 的
 * OCI 標籤 `org.opencontainers.image.revision`（main 建置時寫入、內容定址不可變，Req 16.5）。任何一項無法判定即為 null。
 */
export function deployedCommit(statusText, configText) {
  const p = parseStatus(statusText);
  const digest = p.ok ? p.status.active?.digest ?? null : null;
  let commit = null;
  if (digest) {
    try {
      const rev = JSON.parse(String(configText ?? ''))?.config?.Labels?.['org.opencontainers.image.revision'];
      commit = isCommit(rev) ? rev : null;
    } catch {
      commit = null;
    }
  }
  return { statusOk: p.ok, digest, commit };
}

/**
 * `git ls-remote origin refs/tags/<tag> refs/tags/<tag>^{}` 的輸出 → Tag 指向的 commit（annotated tag 取 peeled 值）。
 * 格式不符、缺少或多個不同結果時回傳 null。
 */
export function parseTagRemote(text, tag) {
  if (typeof text !== 'string' || !parseReleaseTag(tag)) return null;
  let direct = null;
  let peeled = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([0-9a-f]{40})\s+(\S+)$/.exec(line);
    if (!m) return null;
    if (m[2] === `refs/tags/${tag}^{}`) { if (peeled && peeled !== m[1]) return null; peeled = m[1]; }
    else if (m[2] === `refs/tags/${tag}`) { if (direct && direct !== m[1]) return null; direct = m[1]; }
    else return null;
  }
  return peeled ?? direct;
}

/** 由 staging-verified attestation（verify-attestation 每行一個 DSSE envelope）取出符合 commit 與 digest 的 predicate。 */
function attestedPredicate(text, { commit, digest }) {
  const hex = isDigest(digest) ? digest.slice(7) : null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const env = JSON.parse(line);
      const st = JSON.parse(Buffer.from(String(env?.payload ?? ''), 'base64').toString('utf8'));
      if (st?.predicateType !== STAGING_PREDICATE_TYPE) continue;
      if (!(Array.isArray(st.subject) && st.subject.some((s) => s?.digest?.sha256 === hex))) continue;
      if (st.predicate?.commit === commit && st.predicate?.smoke === 'pass') return st.predicate;
    } catch {
      // 略過
    }
  }
  return null;
}

/**
 * 核准畫面的 Staging 結果（Req 19.2）：main Build_Record 中該 digest 的 Staging 驗證紀錄（Health_Check 與
 * Smoke_Test 結果、完成時間），以 staging-verified attestation 補充。只回傳計數、步驟名稱與時間。
 */
export function stagingEvidence({ mainRecord, attestationText, commit, digest }) {
  const deployments = Array.isArray(mainRecord?.deployments) ? mainRecord.deployments : [];
  const entry = lastOf(deployments, (d) => isObj(d) && d.env === 'staging' && d.digest === digest && d.stagingVerified === true);
  const predicate = attestedPredicate(attestationText, { commit, digest });
  const health = sanitizeHealth(entry?.healthChecks);
  const steps = Array.isArray(entry?.smoke?.steps) ? entry.smoke.steps.filter(isObj) : [];
  const time = (v) => (typeof v === 'string' && ISO_RE.test(v) ? v : null);
  return {
    verified: !!entry || !!predicate,
    verifiedAt: time(entry?.verifiedAt) ?? time(predicate?.verifiedAt) ?? null,
    healthChecks: health ? { total: health.length, passed: health.filter((r) => isHealthSuccess(r)).length } : null,
    healthChecksAttested: Number.isSafeInteger(predicate?.healthChecks) ? predicate.healthChecks : null,
    smoke: entry?.smoke ? { ok: entry.smoke.ok === true, passed: steps.filter((s) => s.result === 'pass').length, total: steps.length } : null,
    smokeAttested: predicate?.smoke === 'pass' ? 'pass' : null,
    build: typeof mainRecord?.build?.job === 'string' && Number.isSafeInteger(mainRecord?.build?.number)
      ? `${mainRecord.build.job}#${mainRecord.build.number}` : null,
  };
}

/** 核准畫面文字（Req 19.2）：Release_Tag、完整 Commit SHA、完整 Image_Digest、Staging 結果與完成時間、安全報告連結。 */
export function approvalMessage({ tag, commit, digest, staging, links = [], destructive = [] }) {
  if (!parseReleaseTag(tag)) throw new TypeError('tag 格式無效');
  if (!isCommit(commit)) throw new TypeError('commit 格式無效');
  if (!isDigest(digest)) throw new TypeError('digest 格式無效');
  const s = staging ?? {};
  const health = s.healthChecks
    ? `${s.healthChecks.passed}/${s.healthChecks.total} 次成功`
    : (s.healthChecksAttested ? `連續 ${s.healthChecksAttested} 次成功（attestation）` : '無紀錄');
  const smoke = s.smoke
    ? `${s.smoke.ok ? '通過' : '未通過'}（${s.smoke.passed}/${s.smoke.total} 項）`
    : (s.smokeAttested === 'pass' ? '通過（attestation）' : '無紀錄');
  const lines = [
    `核准正式發布 ${tag} 至 Production？`,
    `Release_Tag：${tag}`,
    `Commit SHA：${commit}`,
    `Image_Digest：${digest}`,
    `Staging Health_Check：${health}`,
    `Staging Smoke_Test：${smoke}`,
    `Staging 驗證完成時間：${s.verifiedAt ?? '無紀錄'}${s.build ? `（${s.build}）` : ''}`,
  ];
  const safeLinks = links.filter((l) => typeof l === 'string' && /^https?:\/\/[^\s<>"']+$/.test(l));
  lines.push(`安全掃描報告：${safeLinks.length ? safeLinks.join(' ') : '無'}`);
  if (destructive.length) {
    lines.push(`破壞性遷移（核准後另需非作者的 Release_Approver 逐一核准）：${destructive.map((d) => d.version).join(', ')}`);
  }
  lines.push('核准後才會變更 Production；24 小時內未核准即中止。');
  return lines.join('\n');
}

const DECISIONS = new Set(['approved', 'rejected', 'timeout', 'aborted', 'tag_changed', 'destructive_rejected']);

function sanitizeAttempts(list) {
  const out = [];
  for (const a of Array.isArray(list) ? list.slice(0, 200) : []) {
    if (!isObj(a)) continue;
    out.push({
      id: typeof a.id === 'string' && ID_RE.test(a.id) ? a.id : '（帳號格式無效）',
      at: typeof a.at === 'string' && ISO_RE.test(a.at) ? a.at : NOT_RUN,
      action: ['approve', 'reject', 'destructive_approve', 'destructive_reject'].includes(a.action) ? a.action : 'unknown',
      ...(typeof a.migration === 'string' && MIGRATION_PATH_RE.test(a.migration) ? { migration: a.migration } : {}),
    });
  }
  return out;
}

/**
 * 「正式核准」關卡與 Build_Record（Req 12.6、19.3、19.4、19.6–19.8、23.5）。
 * input：{ decision, approver, at, digest, tag, commit, attempts, destructive:[{version, migration, approver, at}],
 *          pendingDestructive:[{version, migration}], rejectedBy, rejectedAt, remoteCommit }
 * 通過若且唯若 decision 為 approved、核准人與時間有效、所有破壞性遷移皆已核准，且 Tag 仍指向同一 commit。
 */
export function approvalRecord(input = {}) {
  const decision = DECISIONS.has(input.decision) ? input.decision : 'aborted';
  const approverOk = typeof input.approver === 'string' && ID_RE.test(input.approver);
  const atOk = typeof input.at === 'string' && ISO_RE.test(input.at);
  const digestOk = isDigest(input.digest);
  const attempts = sanitizeAttempts(input.attempts);
  const pending = Array.isArray(input.pendingDestructive) ? input.pendingDestructive.filter((d) => isObj(d) && MIGRATION_PATH_RE.test(d.migration ?? '')) : [];
  const approvedDestructive = (Array.isArray(input.destructive) ? input.destructive : [])
    .filter((d) => isObj(d) && MIGRATION_PATH_RE.test(d.migration ?? '') && typeof d.approver === 'string' && ID_RE.test(d.approver)
      && typeof d.at === 'string' && ISO_RE.test(d.at))
    .map((d) => ({ version: Number(d.version), migration: d.migration, approver: d.approver, at: d.at }));
  const missing = pending.filter((p) => !approvedDestructive.some((d) => d.migration === p.migration));
  const unmet = [];
  if (decision === 'rejected') {
    const who = typeof input.rejectedBy === 'string' && ID_RE.test(input.rejectedBy) ? input.rejectedBy : '（帳號未知）';
    const when = typeof input.rejectedAt === 'string' && ISO_RE.test(input.rejectedAt) ? input.rejectedAt : '（時間未知）';
    unmet.push(`Release_Approver ${who} 於 ${when} 拒絕正式部署（Req 19.7）`);
  } else if (decision === 'timeout') unmet.push('24 小時內未收到 Release_Approver 的核准或拒絕（Req 19.4）');
  else if (decision === 'aborted') unmet.push('核准等待被中止');
  else if (decision === 'destructive_rejected') unmet.push('破壞性遷移的核准被拒絕或未完成（Req 12.6）');
  if (decision === 'approved' || decision === 'tag_changed' || decision === 'destructive_rejected') {
    if (!approverOk || !atOk) unmet.push('缺少核准人帳號或核准時間');
    if (!digestOk) unmet.push('缺少核准畫面顯示的 Image_Digest');
  }
  if (decision !== 'rejected' && decision !== 'timeout' && decision !== 'aborted' && missing.length) {
    unmet.push(`破壞性遷移未取得核准：${missing.map((m) => m.version).join(', ')}`);
  }
  if (decision === 'tag_changed') unmet.push('Release_Tag 已變更，指向的 Commit SHA 與核准畫面顯示的不一致（Req 19.8）');
  const pass = decision === 'approved' && unmet.length === 0;
  const gate = {
    gate: '正式核准', pass, status: pass ? 'pass' : 'fail', commit: isCommit(input.commit) ? input.commit : NOT_RUN,
    unmet: pass ? [] : (unmet.length ? unmet : ['未符合通過條件']), reports: ['reports/production/approval.json'],
  };
  const approval = { unauthorizedAttempts: attempts };
  if (approverOk && atOk && (decision === 'approved' || decision === 'tag_changed' || decision === 'destructive_rejected')) {
    approval.approver = input.approver;
    approval.at = input.at;
    approval.digest = digestOk ? input.digest : NOT_APPLICABLE;
  }
  const patch = { approval, reports: { productionApproval: 'reports/production/approval.json' } };
  const v = validateRecord(patch);
  if (!v.ok) throw new TypeError(`Build_Record patch 無效：${v.errors.join('；')}`);
  const evidence = {
    decision,
    tag: typeof input.tag === 'string' && parseReleaseTag(input.tag) ? input.tag : NOT_APPLICABLE,
    commit: isCommit(input.commit) ? input.commit : NOT_APPLICABLE,
    digest: digestOk ? input.digest : NOT_APPLICABLE,
    approver: approval.approver ?? NOT_APPLICABLE,
    at: approval.at ?? NOT_APPLICABLE,
    rejectedBy: decision === 'rejected' && typeof input.rejectedBy === 'string' && ID_RE.test(input.rejectedBy) ? input.rejectedBy : NOT_APPLICABLE,
    rejectedAt: decision === 'rejected' && typeof input.rejectedAt === 'string' && ISO_RE.test(input.rejectedAt) ? input.rejectedAt : NOT_APPLICABLE,
    remoteCommit: isCommit(input.remoteCommit) ? input.remoteCommit : NOT_APPLICABLE,
    pendingDestructive: pending.map((p) => ({ version: Number(p.version), migration: p.migration })),
    destructiveApprovals: approvedDestructive,
    unauthorizedAttempts: attempts,
  };
  return { patch, gate, evidence };
}

// ------------------------------------------------------------------ CLI

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { cmd };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    if (!flag?.startsWith('--') || i + 1 >= rest.length) return null;
    const key = flag.slice(2);
    if (!/^[a-z][a-z-]*$/.test(key) || key in opts) return null;
    opts[key] = rest[i + 1];
  }
  return opts;
}

const intArg = (v) => (typeof v === 'string' && /^-?\d{1,4}$/.test(v) ? Number(v) : null);
const numArg = (v) => (typeof v === 'string' && /^\d{1,5}(?:\.\d{1,3})?$/.test(v) ? Number(v) : null);

function writeJson(file, value) {
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function writeText(file, text) {
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const USAGE = '用法：bun ci/production.mjs classify|observe|summary|rollback-needed|active|restore|record|destructive|tag-remote|approval-message|approval-record …（見檔頭說明）';

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error, readFile = (p) => readFileSync(p, 'utf8'), listDir = (p) => readdirSync(p), now = () => new Date() } = {}) {
  const o = parseArgs(argv);
  if (!o) { error(USAGE); return 2; }
  const read = (p) => { try { return readFile(p); } catch { return ''; } };
  const readJson = (p) => { try { return JSON.parse(readFile(p)); } catch { return null; } };
  const usage = () => { error(USAGE); return 2; };
  try {
    switch (o.cmd) {
      case 'classify': {
        const exit = intArg(o.exit);
        if (exit === null || !o.result || !o.out || !isDigest(o.digest)) return usage();
        const r = classifyDeploy(exit, read(o.result), o.digest);
        writeJson(o.out, r);
        log(JSON.stringify({ outcome: r.outcome, failedStep: r.failedStep, message: r.message }));
        return r.outcome === 'switched' ? 0 : 1;
      }
      case 'observe': {
        const exit = intArg(o.exit);
        const t = numArg(o.t);
        if (exit === null || t === null || !o.obs || !o.out || !o.result || !['health', 'smoke'].includes(o.type)) return usage();
        if (o.type === 'health' && o.color !== undefined && !COLOR_RE.test(o.color)) return usage();
        if (o.type === 'smoke' && !SMOKE_PHASES.includes(o.phase)) return usage();
        const prev = existsSync(resolve(o.obs)) ? readJson(o.obs) : [];
        if (!Array.isArray(prev)) return usage();
        const obs = o.type === 'health'
          ? healthObservation(exit, read(o.result), t, o.color ?? null)
          : smokeObservation(exit, read(o.result), t, o.phase);
        const next = [...prev, obs];
        writeJson(o.obs, next);
        const d = observationDecision(next);
        writeJson(o.out, { rollback: d.rollback, trigger: d.trigger, reason: d.reason, last: obs, healthChecks: d.summary.healthChecks });
        log(JSON.stringify({ rollback: d.rollback, reason: d.reason, ok: obs.ok, t: obs.t, type: obs.type }));
        return d.rollback ? 1 : 0;
      }
      case 'summary': {
        if (!o.obs || !o.out) return usage();
        const list = readJson(o.obs);
        const d = observationDecision(Array.isArray(list) ? list : []);
        writeJson(o.out, { ...d.summary, rollback: d.rollback, reason: d.reason });
        log(JSON.stringify({ complete: d.summary.complete, rollback: d.rollback, unmet: d.summary.unmet }));
        return d.summary.complete && !d.rollback ? 0 : 1;
      }
      case 'rollback-needed': {
        if (!o.deploy || !o.status || !isDigest(o.digest)) return usage();
        const r = rollbackNeeded(readJson(o.deploy), read(o.status), o.digest);
        log(JSON.stringify(r));
        return r.rollback ? 0 : 1;
      }
      case 'active': {
        if (!o.status) return usage();
        const p = parseStatus(read(o.status));
        const a = p.ok ? p.status.active : null;
        log(JSON.stringify({ ok: p.ok, phase: p.ok ? p.status.phase : null, color: a?.color ?? null, digest: a?.digest ?? null }));
        return a ? 0 : 1;
      }
      case 'restore': {
        if (!o.status || !o.out || !isDigest(o.digest)) return usage();
        const rollbackExit = o['rollback-exit'] === undefined ? null : intArg(o['rollback-exit']);
        const healthExit = o['health-exit'] === undefined ? null : intArg(o['health-exit']);
        const r = classifyRestore({
          statusText: read(o.status), digest: o.digest,
          rollbackAttempted: o.rollback !== undefined && rollbackExit !== null && rollbackExit >= 0,
          rollbackExit, rollbackText: o.rollback ? read(o.rollback) : '',
          healthExit, healthText: o.health ? read(o.health) : '',
        });
        writeJson(o.out, r);
        log(JSON.stringify({ restored: r.restored, code: r.code, message: r.message }));
        return r.restored ? 0 : 1;
      }
      case 'record': {
        if (!o.dir || !o['out-patch'] || !o['out-gate']) return usage();
        const dir = o.dir.replace(/\\/g, '/').replace(/\/$/, '');
        const file = (n) => join(o.dir, n);
        const present = (n) => existsSync(file(n));
        const keyed = {
          productionDeploy: 'deploy.jsonl', productionObservation: 'observations.json', productionRestore: 'restore.json',
          productionFinalize: 'finalize.jsonl',
        };
        const reportPatch = Object.fromEntries(Object.entries(keyed).filter(([, n]) => present(n)).map(([k, n]) => [k, `${dir}/${n}`]));
        const restore = present('restore.json') ? readJson(file('restore.json')) : null;
        const { patch, gate } = productionRecord({
          commit: o.commit, digest: o.digest, tag: o.tag,
          deploy: present('deploy-verdict.json') ? readJson(file('deploy-verdict.json')) : null,
          observations: present('observations.json') ? readJson(file('observations.json')) : null,
          restore,
          signature: o.signature ?? 'not_run', finalize: o.finalize ?? 'not_run',
          stageError: o['stage-error'] ?? null, at: now().toISOString(), reports: Object.values(reportPatch),
        });
        if (Object.keys(reportPatch).length) patch.reports = reportPatch;
        const v = validateRecord(patch);
        if (!v.ok) throw new TypeError(`Build_Record patch 無效：${v.errors.join('；')}`);
        writeJson(o['out-patch'], patch);
        writeJson(o['out-gate'], gate);
        if (patch.rollback) {
          writeText(join(o.dir, 'rollback-summary.txt'), rollbackSummary({ digest: o.digest, restore, reason: patch.rollback.reason }) + '\n');
        }
        log(JSON.stringify({ pass: gate.pass, unmet: gate.unmet }));
        return gate.pass ? 0 : 1;
      }
      case 'destructive': {
        if (!o.migrations || !o.deployed || !o.out) return usage();
        const names = listDir(o.migrations).filter((n) => n.endsWith('.sql')).sort();
        const files = names.map((name) => ({ name, content: read(join(o.migrations, name)) }));
        let deployed = null;
        if (o.deployed !== 'unknown') {
          const text = read(o.deployed);
          deployed = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        }
        const pending = pendingDestructive(files, deployed);
        writeJson(o.out, { known: deployed !== null, pending });
        log(JSON.stringify({ known: deployed !== null, pending: pending.map((p) => p.version) }));
        return 0;
      }
      case 'deployed-commit': {
        if (!o.status || !o.config) return usage();
        const r = deployedCommit(read(o.status), read(o.config));
        log(JSON.stringify(r));
        return r.commit ? 0 : 1;
      }
      case 'tag-remote': {
        if (!o.result || !parseReleaseTag(o.tag ?? '') || !isCommit(o.commit)) return usage();
        const remote = parseTagRemote(read(o.result), o.tag);
        log(JSON.stringify({ remote, matches: remote === o.commit }));
        return remote === o.commit ? 0 : 1;
      }
      case 'approval-message': {
        if (!parseReleaseTag(o.tag ?? '') || !isCommit(o.commit) || !isDigest(o.digest) || !o.out) return usage();
        const base = typeof o['build-url'] === 'string' && /^https?:\/\/[^\s<>"']+\/$/.test(o['build-url']) ? o['build-url'] : null;
        const reportPaths = ['reports/security/evaluation.json', 'reports/security/evaluation-dast.json', 'reports/gate-security.json', 'reports/gate-security-dast.json'];
        const links = base ? reportPaths.filter((p) => existsSync(resolve(p))).map((p) => `${base}artifact/${p}`) : [];
        const staging = stagingEvidence({
          mainRecord: o['main-record'] ? readJson(o['main-record']) : null,
          attestationText: o.attestation ? read(o.attestation) : '',
          commit: o.commit, digest: o.digest,
        });
        const pendingDoc = o.destructive ? readJson(o.destructive) : null;
        const destructive = Array.isArray(pendingDoc?.pending) ? pendingDoc.pending : [];
        writeText(o.out, approvalMessage({ tag: o.tag, commit: o.commit, digest: o.digest, staging, links, destructive }) + '\n');
        log(JSON.stringify({ staging }));
        return 0;
      }
      case 'approval-record': {
        if (!o.in || !o['out-patch'] || !o['out-gate'] || !o['out-evidence']) return usage();
        const input = readJson(o.in);
        if (!isObj(input)) return usage();
        const { patch, gate, evidence } = approvalRecord(input);
        writeJson(o['out-patch'], patch);
        writeJson(o['out-gate'], gate);
        writeJson(o['out-evidence'], evidence);
        log(JSON.stringify({ pass: gate.pass, unmet: gate.unmet }));
        return gate.pass ? 0 : 1;
      }
      default:
        return usage();
    }
  } catch (e) {
    error(`Production 判定失敗：${e instanceof Error ? e.message : 'unknown'}`);
    return 2;
  }
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
