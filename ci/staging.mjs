// Staging 部署與驗證的判定、staging-verified predicate、Build_Record 與「Staging」關卡
// （Requirement 14.1–14.3、14.8、17.7、17.8、18.1–18.5、18.7、18.8、23.2、23.3、23.5；
//  Design「部署流程」、Components §12、§14、Data Models「Staging 驗證 attestation」）。
//
// 供根目錄 Jenkinsfile 的「Staging Deploy」階段使用：Groovy 只負責流程（lock、SSH、cosign、Smoke_Test），
// 所有判讀都在這裡以純函式完成，任何無法解析或不符的輸出一律視為未通過（fail closed）。
//
// 不變式：Staging 只有在 Health_Check 與 Smoke_Test 全部通過後才 `lm-deploy staging finalize`，
// 因此 Deploy_Host 上 staging 的「目前版本」（未進行部署時的 active，以及部署進行中的 previous）
// 一律是先前已通過 Staging 驗證的 Image_Digest。失敗時 `lm-deploy staging rollback`（自動）切回該版本，
// 不存在時停止新版容器（Req 18.5、18.8）。
//
// 純函式：
//   parseJsonLines(text)                         → object[]（lm-deploy 每行一個 JSON）
//   healthCadenceOk(results, intervalSec = 10)   → boolean：Health_Check 之間至少間隔 intervalSec 秒（Req 18.3）
//   classifyDeploy(exitCode, text, digest)       → DeployResult
//   parseStatus(text)                            → { ok:true, status } | { ok:false, reason }（`lm-deploy staging status`）
//   rollbackNeeded(deploy, statusText, digest)   → { rollback, reason }
//   classifyRestore({...})                       → RestoreResult
//   parseSmoke(exitCode, text)                   → { ok, timedOut, steps, unmet }
//   stagingVerdict({ deploy, smokeExit, smokeText }) → { verified, unmet, smoke }
//   buildPredicate({ commit, digest, build, verifiedAt }) → staging-verified predicate
//   stagingRecord({...})                         → { patch, gate }（ci/record.mjs merge／gate 的輸入）
//
// CLI（結束碼：0 成功／通過；1 未通過；2 參數或輸入錯誤）：
//   bun ci/staging.mjs classify --exit <n> --result <deploy.jsonl> --digest <d> --out <deploy-verdict.json>
//       0：已切換且啟動健康檢查通過；1：其他
//   bun ci/staging.mjs rollback-needed --deploy <deploy-verdict.json> --status <status.json> --digest <d>
//       0：需要 `lm-deploy staging rollback`；1：不需要
//   bun ci/staging.mjs active --status <status.json>
//       輸出 { ok, color }；0：有作用中的槽位；1：沒有
//   bun ci/staging.mjs restore --status <status.json> --digest <d> [--rollback <f> --rollback-exit <n>]
//       [--health <f> --health-exit <n>] --out <restore.json>
//       0：已還原至前一個已通過 Staging 驗證的 Image_Digest 且健康；1：其他（含無可還原者）
//   bun ci/staging.mjs verdict --deploy <deploy-verdict.json> --smoke <smoke.json> --smoke-exit <n>
//       --commit <sha> --digest <d> --build <job#n> --out <verdict.json> --out-predicate <predicate.json>
//       0：已通過 Staging 驗證（並寫出 predicate）；1：未通過（不寫 predicate）
//   bun ci/staging.mjs check-attestation --result <verify-attestation 輸出> --commit <sha> --digest <d>
//       0：attestation 的 predicateType、subject、commit 與 smoke 皆相符
//   bun ci/staging.mjs record --dir <reports/staging> --commit <sha> --digest <d>
//       --signature ok|fail|not_run --finalize ok|fail|not_run --attestation ok|fail|not_run
//       [--stage-error <訊息>] --out-patch <patch.json> --out-gate <gate.json>
//       讀取 <dir> 內的 deploy-verdict.json、verdict.json、restore.json（存在時）；0：「Staging」關卡通過

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { healthyWithin } from './health.mjs';
import { NOT_APPLICABLE, NOT_RUN, validateRecord } from './record.mjs';
import { STAGING_PREDICATE_TYPE, checkStagingAttestation } from './resolve-digest.mjs';

export { STAGING_PREDICATE_TYPE };
export const HEALTH_INTERVAL_SEC = 10;
export const HEALTH_WINDOW_SEC = 120;
export const HEALTH_NEED = 3;
export const SMOKE_STEPS = Object.freeze(['login-page', 'session', 'login', 'trips', 'logout']);
/** Jenkins `timeout` 中止或 GNU timeout 的結束碼，視為逾時。 */
export const TIMEOUT_EXITS = Object.freeze([124, 137, 143]);

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const COLOR_RE = /^(blue|green)$/;
const CODE_RE = /^[a-z][a-z_]{0,39}$/;
const BACKUP_ID_RE = /^staging-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const PHASES = new Set(['idle', 'started', 'switched']);
const BUILD_RE = /^[^\u0000-\u001f\u007f]{1,200}$/;
const STAGE_ERROR_RE = /^[^\u0000-\u001f\u007f]{1,200}$/;

export function isDigest(v) { return typeof v === 'string' && DIGEST_RE.test(v); }
const isCommit = (v) => typeof v === 'string' && COMMIT_RE.test(v);
const safeCode = (v) => (typeof v === 'string' && CODE_RE.test(v) ? v : null);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** lm-deploy 的 stdout：每行一個 JSON 物件；其他行（或無法解析的行）略過。 */
export function parseJsonLines(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    try {
      const v = JSON.parse(line);
      if (isObj(v)) out.push(v);
    } catch {
      // 略過
    }
  }
  return out;
}

const lastOf = (lines, pred) => { for (let i = lines.length - 1; i >= 0; i--) if (pred(lines[i])) return lines[i]; return null; };

/** Health_Check 結果的形狀與 ci/health.mjs 相同：{ t, ok, durationMs }；只保留這三個欄位。 */
function sanitizeHealth(results) {
  if (!Array.isArray(results) || results.length === 0 || results.length > 64) return null;
  const out = [];
  for (const r of results) {
    if (!isObj(r) || typeof r.t !== 'number' || !Number.isFinite(r.t) || typeof r.ok !== 'boolean') return null;
    const entry = { t: r.t, ok: r.ok };
    if (r.durationMs !== undefined) {
      if (typeof r.durationMs !== 'number' || !Number.isFinite(r.durationMs)) return null;
      entry.durationMs = r.durationMs;
    }
    out.push(entry);
  }
  return out;
}

/** Req 18.3：相鄰兩次 Health_Check 至少間隔 intervalSec 秒（依 t 排序；空陣列或格式無效為 false）。 */
export function healthCadenceOk(results, intervalSec = HEALTH_INTERVAL_SEC) {
  if (!Array.isArray(results) || results.length === 0) return false;
  if (!results.every((r) => isObj(r) && typeof r.t === 'number' && Number.isFinite(r.t) && r.t >= 0)) return false;
  const ts = results.map((r) => r.t).sort((a, b) => a - b);
  for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] < intervalSec) return false;
  return true;
}

function sanitizeBackup(b) {
  if (!isObj(b) || b.ok !== true || b.command !== 'backup') return null;
  if (typeof b.id !== 'string' || !BACKUP_ID_RE.test(b.id) || b.env !== 'staging') return null;
  if (typeof b.createdAt !== 'string' || !ISO_RE.test(b.createdAt)) return null;
  if (!Number.isSafeInteger(b.sizeBytes) || b.sizeBytes <= 0) return null;
  if (typeof b.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.sha256)) return null;
  return { id: b.id, env: 'staging', createdAt: b.createdAt, sizeBytes: b.sizeBytes, sha256: b.sha256 };
}

const slotOf = (v) => (isObj(v) && COLOR_RE.test(v.color ?? '') && isDigest(v.digest) ? { color: v.color, digest: v.digest } : null);

// lm-deploy 的失敗原因 → 失敗步驟與訊息（訊息為固定字串，不含 lm-deploy 輸出內容）。
const FAILURES = Object.freeze({
  backup_create_failed: ['backup', '備份建立失敗；未執行 Migration_Runner，Staging 維持不變（Req 14.3）'],
  backup_verify_failed: ['backup', '備份驗證失敗；未執行 Migration_Runner，Staging 維持不變（Req 14.3）'],
  backup_timeout: ['backup', '備份未在 30 分鐘內完成；未執行 Migration_Runner，Staging 維持不變（Req 14.3）'],
  backup_dir_invalid: ['backup', '備份目錄不符合權限要求；未執行 Migration_Runner，Staging 維持不變'],
  backup_required: ['migrate', 'Migration_Runner 前缺少已驗證備份；未啟動新版容器'],
  migrate_failed: ['migrate', 'Migration_Runner 失敗；未啟動新版容器，現有 Staging 容器維持執行（Req 18.7）'],
  start_failed: ['start', '新版 App_Server 容器無法啟動；已移除新容器，reverse proxy 未變更'],
  health_failed: ['health', '新版 App_Server 容器未在 120 秒內連續 3 次 Health_Check 成功；已移除新容器，reverse proxy 未變更（Req 18.5）'],
  switch_failed: ['switch', 'reverse proxy 切換失敗；新版容器仍在執行，需回滾'],
});
// 帶 `backup` 失敗原因時 Build_Record 記錄的類別（Req 14.3：建立失敗、驗證失敗或逾時）。
const BACKUP_FAILURE_KIND = Object.freeze({
  backup_create_failed: 'create', backup_verify_failed: 'verify', backup_timeout: 'timeout', backup_dir_invalid: 'create',
});
// lm-deploy 在變更任何東西之前就拒絕的原因（不需回滾，也不得回滾非本次建置造成的狀態）。
const REFUSED = Object.freeze({
  invalid_phase: 'Staging 有未完成的部署（非本次建置），需人工 finalize 或 rollback；未變更 Staging',
  state_invalid: 'Deploy_Host 的 Staging 狀態檔無效，需人工介入；未變更 Staging',
  locked: 'Deploy_Host 的 lm-staging 鎖已被其他程序持有；未變更 Staging',
});

/**
 * app-env 結果行的收據 AI 狀態（lm-deploy 寫入後的實際狀態；Components 第 25.3 節）：只接受 enabled／disabled。
 * Staging 由 lm-deploy 固定為 disabled（enabled 或金鑰在備份前即被拒絕）。
 */
function receiptAiOf(line) {
  return line?.receiptAi === 'enabled' || line?.receiptAi === 'disabled' ? line.receiptAi : null;
}

/**
 * 判讀 `lm-deploy staging deploy <digest>` 的結束碼與輸出（backup → app-env → migrate → start → health --wait → switch）。
 * outcome：
 *   switched  備份已驗證、遷移完成、新版容器以該 digest 啟動、120 秒內每 10 秒一次且連續 3 次健康、已切換
 *   failed    已知的失敗步驟（lm-deploy 已讓 Staging 回到部署前或需要回滾的已知狀態）
 *   refused   lm-deploy 在變更任何東西前拒絕（參數、設定、鎖、未完成的部署）
 *   unknown   結果不明（SSH 中斷、逾時、輸出不符）；需查詢狀態並視需要回滾
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
    && healthyWithin(health, HEALTH_WINDOW_SEC, HEALTH_NEED);
  const cadenceOk = !!health && healthCadenceOk(health, HEALTH_INTERVAL_SEC);
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
    receiptAi: receiptAiOf(ok('app-env')),
  };
  if (!isDigest(digest)) return { ...base, outcome: 'refused', failedStep: 'input', message: 'digest 格式無效' };

  if (exitCode === 0) {
    const unmet = [];
    if (!backup) unmet.push('缺少已驗證備份的輸出');
    if (!base.migrated) unmet.push('缺少 Migration_Runner 完成的輸出');
    if (!started) unmet.push('新版容器的 Image_Digest 與推送取得的不一致');
    if (!healthy) unmet.push('啟動後 120 秒內未連續 3 次 Health_Check 成功');
    else if (!cadenceOk) unmet.push('Health_Check 間隔小於 10 秒（Req 18.3）');
    if (!sw || sw.to?.digest !== digest || sw.to?.color !== base.color) unmet.push('reverse proxy 未切換至新版容器');
    if (unmet.length === 0) {
      return { ...base, outcome: 'switched', failedStep: null, message: '已部署並切換至新版容器' };
    }
    return { ...base, outcome: 'unknown', failedStep: 'output', message: `lm-deploy 回報成功但輸出不符：${unmet.join('；')}` };
  }
  if (exitCode === 4) return { ...base, outcome: 'refused', failedStep: 'lock', message: REFUSED.locked };
  if (exitCode === 3 && (code === 'invalid_phase' || code === 'state_invalid')) {
    return { ...base, outcome: 'refused', failedStep: 'state', message: REFUSED[code] };
  }
  if (exitCode === 2) return { ...base, outcome: 'refused', failedStep: 'input', message: 'lm-deploy 拒絕部署（參數或設定無效）；未變更 Staging' };
  if ((exitCode === 1 || exitCode === 3) && code && FAILURES[code]) {
    const [step, message] = FAILURES[code];
    // switch 子命令的 health_failed 是切換前的單次檢查（新版容器仍在執行），與啟動健康等待不同。
    if (code === 'health_failed' && failure?.command === 'switch') {
      return { ...base, outcome: 'failed', failedStep: 'switch', message: '切換前健康檢查失敗；新版容器仍在執行，需回滾' };
    }
    return { ...base, outcome: 'failed', failedStep: step, message };
  }
  return { ...base, outcome: 'unknown', failedStep: 'unknown', message: `部署結果不明（結束碼 ${base.exitCode ?? '無'}）；需確認狀態並回滾` };
}

/** 解析 `lm-deploy staging status` 的 JSON（最後一行）；任何欄位格式不符即視為無效。 */
export function parseStatus(text) {
  const lines = parseJsonLines(text);
  const s = lines.length ? lines[lines.length - 1] : null;
  if (!s) return { ok: false, reason: '無法解析 lm-deploy status 輸出' };
  if (s.ok !== true || s.command !== 'status' || s.env !== 'staging') return { ok: false, reason: 'lm-deploy status 不是 staging 的成功結果' };
  if (!PHASES.has(s.phase)) return { ok: false, reason: 'lm-deploy status 的 phase 無效' };
  const slots = {};
  for (const key of ['active', 'candidate', 'previous']) {
    if (s[key] === null || s[key] === undefined) slots[key] = null;
    else {
      slots[key] = slotOf(s[key]);
      if (!slots[key]) return { ok: false, reason: `lm-deploy status 的 ${key} 格式無效` };
    }
  }
  return { ok: true, status: { phase: s.phase, ...slots } };
}

/**
 * 是否需要 `lm-deploy staging rollback`（自動回滾）：lm-deploy 拒絕的部署從不回滾（狀態不是本次建置造成）；
 * 其餘情況下 phase 不是 idle 且候選或作用中槽位為本次 digest 時回滾。狀態無法解析時仍嘗試回滾
 * （phase 為 idle 時 lm-deploy 以 nothing_to_rollback 拒絕，不會變更任何東西）。
 */
export function rollbackNeeded(deploy, statusText, digest) {
  // 判讀結果缺失（例如 classify 本身失敗）時不知道部署走到哪一步，與「結果不明」相同處理。
  if (isObj(deploy) && deploy.outcome === 'refused') return { rollback: false, reason: 'lm-deploy 拒絕部署，Staging 未變更' };
  const p = parseStatus(statusText);
  if (!p.ok) return { rollback: true, reason: `${p.reason}；嘗試回滾` };
  const { phase, active, candidate } = p.status;
  if (phase === 'idle') return { rollback: false, reason: 'Staging 沒有進行中的部署' };
  if (candidate?.digest === digest || active?.digest === digest) return { rollback: true, reason: `部署停在 ${phase}，回滾至前一個已通過 Staging 驗證的 Image_Digest` };
  return { rollback: false, reason: '進行中的部署不是本次建置的 Image_Digest' };
}

/**
 * 判讀還原結果（Req 18.5、18.8）：
 *   - 狀態回到 idle、沒有候選槽位，且作用中槽位不是失敗的 digest → 新版容器已停止
 *   - 有作用中槽位且其 `health <color> --wait` 為 120 秒內連續 3 次成功 → 已還原
 *   - 沒有作用中槽位 → 不存在先前已通過 Staging 驗證的 Image_Digest（無可還原者）
 */
export function classifyRestore({ statusText, digest, rollbackAttempted = false, rollbackExit = null, rollbackText = '', healthExit = null, healthText = '' } = {}) {
  const rb = parseJsonLines(rollbackText);
  const rbLast = rb.length ? rb[rb.length - 1] : null;
  const rollback = {
    attempted: rollbackAttempted === true,
    ok: rollbackAttempted === true && rollbackExit === 0 && rbLast?.ok === true && rbLast.command === 'rollback',
    code: rollbackAttempted === true ? (rollbackExit === 0 ? 'rolled_back' : safeCode(rbLast?.reason) ?? 'rollback_failed') : 'not_needed',
  };
  const base = { digest: isDigest(digest) ? digest : null, rollback, target: null, newStopped: false, noRestoreTarget: false, health: null };
  const p = parseStatus(statusText);
  if (!isDigest(digest)) return { ...base, restored: false, code: 'invalid_input', message: 'digest 格式無效' };
  if (!p.ok) return { ...base, restored: false, code: 'status_unknown', message: `無法確認還原後的 Staging 狀態（${p.reason}），需人工介入` };
  const { phase, active, candidate } = p.status;
  const newStopped = phase === 'idle' && candidate === null && active?.digest !== digest;
  if (!newStopped) {
    return { ...base, restored: false, code: 'new_container_running', message: '失敗的新版容器仍在執行或部署未回到 idle，需人工介入' };
  }
  if (!active) {
    return {
      ...base, restored: false, newStopped: true, noRestoreTarget: true, code: 'no_restore_target',
      message: '不存在先前已通過 Staging 驗證的 Image_Digest；已停止新版容器（Req 18.8）',
    };
  }
  const lines = parseJsonLines(healthText);
  const h = lastOf(lines, (l) => l.command === 'health');
  const health = sanitizeHealth(h?.results);
  const healthy = healthExit === 0 && h?.ok === true && h.healthy === true && h.color === active.color
    && !!health && healthyWithin(health, HEALTH_WINDOW_SEC, HEALTH_NEED);
  if (!healthy) {
    return {
      ...base, restored: false, newStopped: true, target: active.digest, health, code: 'restore_unhealthy',
      message: '已切回前一個已通過 Staging 驗證的 Image_Digest，但還原後未連續 3 次 Health_Check 成功，需人工介入',
    };
  }
  return {
    ...base, restored: true, newStopped: true, target: active.digest, health, code: 'restored',
    message: '已還原至前一個已通過 Staging 驗證的 Image_Digest，且還原後 Health_Check 成功',
  };
}

/** Smoke_Test 輸出（scripts/smoke.mjs 的 JSON）；只保留步驟名稱、狀態碼、耗時與結果（Req 21.10）。 */
export function parseSmoke(exitCode, text) {
  const timedOut = TIMEOUT_EXITS.includes(exitCode);
  const lines = parseJsonLines(text);
  const doc = lines.length ? lines[lines.length - 1] : null;
  const steps = [];
  if (doc && Array.isArray(doc.steps)) {
    for (const s of doc.steps.slice(0, SMOKE_STEPS.length + 1)) {
      if (!isObj(s) || typeof s.step !== 'string') continue;
      const entry = {
        step: SMOKE_STEPS.includes(s.step) ? s.step : 'unknown',
        status: Number.isSafeInteger(s.status) ? s.status : null,
        ms: typeof s.ms === 'number' && Number.isFinite(s.ms) ? Math.round(s.ms) : null,
        result: ['pass', 'fail', 'skipped'].includes(s.result) ? s.result : 'fail',
      };
      const reason = safeCode(typeof s.reason === 'string' ? s.reason.replace(/-/g, '_') : null);
      if (reason) entry.reason = reason;
      steps.push(entry);
    }
  }
  const unmet = [];
  if (timedOut) unmet.push('Smoke_Test 未於 10 分鐘內完成');
  else if (!doc) unmet.push('Smoke_Test 結果缺失或無法解析');
  else {
    const names = steps.map((s) => s.step);
    if (names.join(',') !== SMOKE_STEPS.join(',')) unmet.push('Smoke_Test 步驟不完整');
    const failed = steps.filter((s) => s.result !== 'pass').map((s) => s.step);
    if (failed.length) unmet.push(`Smoke_Test 未通過的項目：${failed.join(', ')}`);
    if (unmet.length === 0 && (exitCode !== 0 || doc.ok !== true)) unmet.push('Smoke_Test 未通過');
  }
  return { ok: unmet.length === 0 && exitCode === 0 && doc?.ok === true, timedOut, steps, unmet };
}

/**
 * Staging 驗證（Req 18.3、18.4）：已切換、啟動後 120 秒內每 10 秒一次且連續 3 次 Health_Check 成功、
 * Smoke_Test 全部項目於 10 分鐘內通過。
 */
export function stagingVerdict({ deploy, smokeExit, smokeText } = {}) {
  const unmet = [];
  if (!isObj(deploy) || deploy.outcome !== 'switched') unmet.push(isObj(deploy) && deploy.message ? deploy.message : '部署未完成');
  else {
    if (!deploy.healthy) unmet.push('啟動後 120 秒內未連續 3 次 Health_Check 成功');
    if (!deploy.cadenceOk) unmet.push('Health_Check 間隔小於 10 秒（Req 18.3）');
  }
  const smoke = deploy?.outcome === 'switched' ? parseSmoke(smokeExit, smokeText) : { ok: false, timedOut: false, steps: [], unmet: ['未執行 Smoke_Test'] };
  if (deploy?.outcome === 'switched') unmet.push(...smoke.unmet);
  return { verified: unmet.length === 0 && smoke.ok === true, unmet, smoke };
}

/**
 * staging-verified predicate（Design「Staging 驗證 attestation」）：{commit, verifiedAt, build, healthChecks: 3, smoke: "pass"}，
 * 另含 digest 與 env 方便人工檢視。ci/resolve-digest.mjs checkStagingAttestation 檢查 commit 與 smoke，subject 由 cosign 填入。
 */
export function buildPredicate({ commit, digest, build, verifiedAt }) {
  if (!isCommit(commit)) throw new TypeError('commit 必須為 40 字元小寫十六進位');
  if (!isDigest(digest)) throw new TypeError('digest 格式無效');
  if (typeof build !== 'string' || !BUILD_RE.test(build)) throw new TypeError('build 格式無效');
  if (typeof verifiedAt !== 'string' || !ISO_RE.test(verifiedAt)) throw new TypeError('verifiedAt 必須是含時區的 ISO 8601 時間');
  return { commit, digest, env: 'staging', verifiedAt, build, healthChecks: HEALTH_NEED, smoke: 'pass' };
}

const FACTS = new Set(['ok', 'fail', 'not_run']);

/**
 * Build_Record patch 與「Staging」關卡結果。關卡通過若且唯若：簽章驗證通過、Staging 驗證通過、finalize 完成、
 * staging-verified attestation 已推送且可驗證，且階段沒有執行錯誤或逾時（Req 18.4、23.2、23.3）。
 */
export function stagingRecord({
  commit, digest, deploy = null, verdict = null, restore = null,
  signature = 'not_run', finalize = 'not_run', attestation = 'not_run', stageError = null, at = new Date().toISOString(), reports = [],
} = {}) {
  for (const [name, v] of [['signature', signature], ['finalize', finalize], ['attestation', attestation]]) {
    if (!FACTS.has(v)) throw new TypeError(`${name} 必須是 ok、fail 或 not_run`);
  }
  if (stageError !== null && (typeof stageError !== 'string' || !STAGE_ERROR_RE.test(stageError))) throw new TypeError('stageError 格式無效');
  const verified = verdict?.verified === true && deploy?.outcome === 'switched';
  const unmet = [];
  if (stageError) unmet.push(`檢查階段執行錯誤：${stageError}`);
  if (signature !== 'ok') unmet.push(signature === 'fail' ? 'Image_Digest 的簽章無法以設定的公鑰驗證，未部署（Req 17.8）' : '未驗證 Image_Digest 的簽章');
  if (signature === 'ok') {
    if (!deploy) unmet.push('未執行 Staging 部署');
    else if (deploy.outcome !== 'switched') unmet.push(deploy.message || '部署未完成');
    else if (!verdict) unmet.push('未產生 Staging 驗證結果');
    else if (!verified) unmet.push(...(Array.isArray(verdict.unmet) && verdict.unmet.length ? verdict.unmet : ['Staging 驗證未通過']));
  }
  if (verified && finalize !== 'ok') unmet.push('lm-deploy staging finalize 未完成');
  if (verified && attestation !== 'ok') unmet.push('staging-verified attestation 未推送或無法驗證');
  if (restore) {
    if (restore.noRestoreTarget) unmet.push('不存在先前已通過 Staging 驗證的 Image_Digest，已停止新版容器（Req 18.8）');
    else if (!restore.restored) unmet.push(restore.message || '還原未確認');
  }
  const pass = unmet.length === 0 && verified && finalize === 'ok' && attestation === 'ok' && signature === 'ok';
  const status = pass ? 'pass' : (stageError ? 'error' : 'fail');
  const reportList = reports.filter((r) => typeof r === 'string');
  const gate = { gate: 'Staging', pass, status, commit: isCommit(commit) ? commit : '未執行', unmet: pass ? [] : (unmet.length ? unmet : ['未符合通過條件']), reports: reportList };

  let result;
  if (pass) result = 'staging_verified';
  else if (signature !== 'ok') result = 'signature_failed';
  else if (!deploy) result = 'not_deployed';
  else if (deploy.outcome === 'refused') result = 'refused';
  else if (restore?.noRestoreTarget) result = 'no_restore_target';
  else if (restore?.restored) result = 'restored';
  else if (verified) result = 'verified_not_recorded';
  else result = 'manual_intervention';

  const entry = {
    env: 'staging',
    digest: isDigest(digest) ? digest : NOT_APPLICABLE,
    commit: isCommit(commit) ? commit : NOT_APPLICABLE,
    at,
    result,
    stagingVerified: pass,
    signature,
    // 沒有 app-env 結果行（例如備份前就失敗）或值不是 enabled／disabled 時為「未執行」。
    receiptAi: receiptAiOf(deploy) ?? NOT_RUN,
  };
  if (pass) entry.verifiedAt = at;
  if (deploy) {
    entry.outcome = deploy.outcome;
    if (deploy.failedStep) entry.failedStep = deploy.failedStep;
    if (deploy.code) entry.code = deploy.code;
    entry.backupId = deploy.backup?.id ?? NOT_APPLICABLE;
    if (deploy.backupFailure) entry.backupFailure = deploy.backupFailure;
    entry.migrated = deploy.migrated === true;
    if (deploy.color) entry.color = deploy.color;
    if (Array.isArray(deploy.health)) entry.healthChecks = deploy.health;
  }
  if (verdict?.smoke) entry.smoke = { ok: verdict.smoke.ok === true, steps: verdict.smoke.steps ?? [] };
  if (verified) { entry.finalize = finalize; entry.attestation = attestation; }
  if (restore) {
    entry.restore = {
      restored: restore.restored === true,
      noRestoreTarget: restore.noRestoreTarget === true,
      newStopped: restore.newStopped === true,
      target: isDigest(restore.target) ? restore.target : NOT_APPLICABLE,
      code: safeCode(restore.code) ?? 'unknown',
      rollback: restore.rollback?.code ?? 'not_needed',
    };
  }

  const patch = { deployments: [entry] };
  if (deploy?.backup) patch.backup = { ...deploy.backup };
  if (restore) {
    patch.rollback = {
      trigger: 'auto',
      by: 'pipeline',
      from: isDigest(digest) ? digest : NOT_APPLICABLE,
      to: restore.restored && isDigest(restore.target) ? restore.target : NOT_APPLICABLE,
      reason: restore.noRestoreTarget ? 'Staging 驗證失敗且無可還原的 Image_Digest' : 'Staging 驗證失敗',
      at,
    };
  }
  const v = validateRecord(patch);
  if (!v.ok) throw new TypeError(`Build_Record patch 無效：${v.errors.join('；')}`);
  return { patch, gate };
}

// ------------------------------------------------------------------ CLI

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { cmd };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    if (!flag?.startsWith('--') || i + 1 >= rest.length) return null;
    opts[flag.slice(2)] = rest[i + 1];
  }
  return opts;
}

const intArg = (v) => (typeof v === 'string' && /^-?\d{1,4}$/.test(v) ? Number(v) : null);

function writeJson(file, value) {
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

const USAGE = '用法：bun ci/staging.mjs classify|rollback-needed|active|restore|verdict|check-attestation|record …（見檔頭說明）';

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error, readFile = (p) => readFileSync(p, 'utf8'), now = () => new Date() } = {}) {
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
      case 'rollback-needed': {
        if (!o.deploy || !o.status || !isDigest(o.digest)) return usage();
        const r = rollbackNeeded(readJson(o.deploy), read(o.status), o.digest);
        log(JSON.stringify(r));
        return r.rollback ? 0 : 1;
      }
      case 'active': {
        if (!o.status) return usage();
        const p = parseStatus(read(o.status));
        const color = p.ok && p.status.active ? p.status.active.color : null;
        log(JSON.stringify({ ok: p.ok, color }));
        return color ? 0 : 1;
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
      case 'verdict': {
        const smokeExit = intArg(o['smoke-exit']);
        if (!o.deploy || !o.smoke || smokeExit === null || !o.out || !o['out-predicate'] || !isCommit(o.commit) || !isDigest(o.digest) || !BUILD_RE.test(o.build ?? '')) return usage();
        const deploy = readJson(o.deploy);
        const v = stagingVerdict({ deploy: deploy?.digest === o.digest ? deploy : null, smokeExit, smokeText: read(o.smoke) });
        const verifiedAt = now().toISOString();
        const result = { ...v, verifiedAt: v.verified ? verifiedAt : null, commit: o.commit, digest: o.digest };
        writeJson(o.out, result);
        if (v.verified) writeJson(o['out-predicate'], buildPredicate({ commit: o.commit, digest: o.digest, build: o.build, verifiedAt }));
        log(JSON.stringify({ verified: v.verified, unmet: v.unmet }));
        return v.verified ? 0 : 1;
      }
      case 'check-attestation': {
        if (!o.result || !isCommit(o.commit) || !isDigest(o.digest)) return usage();
        const ok = checkStagingAttestation(read(o.result), { commit: o.commit, digest: o.digest, predicateType: STAGING_PREDICATE_TYPE });
        log(JSON.stringify({ ok }));
        return ok ? 0 : 1;
      }
      case 'record': {
        if (!o.dir || !o['out-patch'] || !o['out-gate']) return usage();
        const dir = o.dir;
        const file = (n) => join(dir, n);
        const present = (n) => existsSync(file(n));
        const reports = ['deploy.jsonl', 'deploy-verdict.json', 'smoke.json', 'verdict.json', 'attestation.jsonl', 'restore.json']
          .filter(present).map((n) => `${dir.replace(/\\/g, '/').replace(/\/$/, '')}/${n}`);
        const { patch, gate } = stagingRecord({
          commit: o.commit, digest: o.digest,
          deploy: present('deploy-verdict.json') ? readJson(file('deploy-verdict.json')) : null,
          verdict: present('verdict.json') ? readJson(file('verdict.json')) : null,
          restore: present('restore.json') ? readJson(file('restore.json')) : null,
          signature: o.signature ?? 'not_run', finalize: o.finalize ?? 'not_run', attestation: o.attestation ?? 'not_run',
          stageError: o['stage-error'] ?? null, at: now().toISOString(), reports,
        });
        const keyed = {
          stagingDeploy: 'deploy.jsonl', stagingSmoke: 'smoke.json', stagingVerdict: 'verdict.json',
          stagingAttestation: 'attestation.jsonl', stagingRestore: 'restore.json',
        };
        const reportPatch = Object.fromEntries(Object.entries(keyed).filter(([, n]) => present(n))
          .map(([k, n]) => [k, `${dir.replace(/\\/g, '/').replace(/\/$/, '')}/${n}`]));
        if (Object.keys(reportPatch).length) patch.reports = reportPatch;
        const v = validateRecord(patch);
        if (!v.ok) throw new TypeError(`Build_Record patch 無效：${v.errors.join('；')}`);
        writeJson(o['out-patch'], patch);
        writeJson(o['out-gate'], gate);
        log(JSON.stringify({ pass: gate.pass, unmet: gate.unmet }));
        return gate.pass ? 0 : 1;
      }
      default:
        return usage();
    }
  } catch (e) {
    error(`Staging 判定失敗：${e instanceof Error ? e.message : 'unknown'}`);
    return 2;
  }
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
