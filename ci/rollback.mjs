// 手動回滾的判定與紀錄（Requirement 20.8–20.12；Design Components §15「手動回滾 release/rollback」、Property 41）。
//
// 供 ci/jenkins/pipelines/rollback.Jenkinsfile 使用。Groovy 端只負責流程，所有驗證都在這裡以純函式完成，
// 使用者輸入（reason）只經環境變數 LM_ROLLBACK_REASON 傳入，從不出現在 shell 指令或 argv。
//
// 純函式：
//   validateReason(raw)                       → { ok:true, value } | { ok:false, reason }
//   parseStatus(text)                          → { ok:true, status } | { ok:false, reason }（`lm-deploy prod status` 的輸出）
//   rollbackTargets(status)                    → string[]：可回滾目標（保留集合內且不是目前版本）
//   checkRollback({ triggeredBy, approver, approvers, reason, digest, status }) → { allowed, code, reason }
//   classifyRollback(exitCode, text, digest)   → { outcome, manualIntervention, code, message, color? }
//   classifyHealth(exitCode, text)             → { healthy, code, message }
//   buildRollbackRecord(input)                 → 已填滿所有欄位的 Build_Record（經 ci/record.mjs 驗證）
//
// CLI（結束碼：0 成功／允許；1 拒絕／未通過；2 參數或輸入錯誤）：
//   bun ci/rollback.mjs approvers [--file ci/release-approvers.json]
//       輸出 { ok, approvers: [jenkinsId...] }
//   bun ci/rollback.mjs targets --status <status.json>
//       輸出 { ok, phase, deployInProgress, active, targets }；沒有可回滾目標時結束碼 1
//   bun ci/rollback.mjs check --status <status.json> --digest <sha256:…> --triggered-by <id> --approver <id> [--file <approvers>]
//       reason 取自環境變數 LM_ROLLBACK_REASON；輸出 { allowed, code, reason }
//   bun ci/rollback.mjs classify --exit <n> --result <rollback.jsonl> --digest <sha256:…>
//   bun ci/rollback.mjs health --exit <n> --result <health.jsonl>
//   bun ci/rollback.mjs record --out <f> --job <j> --number <n> --url <u> --started-at <iso> --commit <sha>
//       --build-image-digest <d> --by <id> [--approver <id> --approved-at <iso>] [--from <d>] [--to <d>]
//       --outcome <o> --attempted true|false --manual-intervention true|false --status SUCCESS|FAILURE|ABORTED
//       [--first-failed-stage <name>]
//       reason 取自環境變數 LM_ROLLBACK_REASON（無效時記錄為固定字串，不保存原文）。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DEFAULT_APPROVERS_FILE, isReleaseApprover, loadApprovers } from './approval.mjs';
import { healthyWithin } from './health.mjs';
import { NOT_APPLICABLE, NOT_RUN, RECORD_SCHEMA, REPORT_KEYS, finalizeRecord, validateRecord, writeRecord } from './record.mjs';
import { rollbackAllowed } from './retention.mjs';

export const REASON_MAX = 500;
export const REASON_ENV = 'LM_ROLLBACK_REASON';
export const ROLLBACK_TRIGGER = 'manual_rollback';
export const OUTCOMES = Object.freeze([
  'not_started', // 尚未送出回滾（例如觸發者檢查失敗、input 逾時）
  'rejected', // 檢查未通過或 lm-deploy 拒絕；Production 未變更
  'locked', // 已有部署進行中（Req 20.12）
  'aborted', // input 被中止或逾時
  'failed', // 回滾未切換（啟動或切換前健康檢查失敗）；Production 未變更
  'manual_intervention', // 切換後未健康或狀態不明（Req 20.11）
  'completed', // 已切換、健康並 finalize
]);
export const INVALID_REASON_PLACEHOLDER = '（理由無效，未保存）';

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const COLOR_RE = /^(blue|green)$/;
const PHASES = new Set(['idle', 'started', 'switched']);
// 控制字元（含換行、Tab）、行／段分隔符與雙向文字控制字元一律拒絕。
const FORBIDDEN_CHARS = /[\p{Cc}\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export function isDigest(v) { return typeof v === 'string' && DIGEST_RE.test(v); }

/** 手動回滾理由：去除前後空白後 1–500 個字元，不含控制字元，且不像秘密（沿用 Build_Record 的檢查）。 */
export function validateReason(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: '回滾理由必須是字串' };
  if (typeof raw.isWellFormed === 'function' && !raw.isWellFormed()) return { ok: false, reason: '回滾理由含無效的 Unicode' };
  // 控制字元檢查作用於原始輸入（trim 前），前後的換行或 Tab 也一律拒絕。
  if (FORBIDDEN_CHARS.test(raw)) return { ok: false, reason: '回滾理由不得包含控制字元或換行' };
  const value = raw.trim();
  if (value === '') return { ok: false, reason: '回滾理由不得為空' };
  if ([...value].length > REASON_MAX) return { ok: false, reason: `回滾理由不得超過 ${REASON_MAX} 個字元` };
  if (!validateRecord({ rollback: { reason: value } }).ok) return { ok: false, reason: '回滾理由疑似含秘密值' };
  return { ok: true, value };
}

function lastJsonLine(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const v = JSON.parse(lines[i]);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }
  return null;
}

function parseSlot(v) {
  if (v === null || v === undefined) return { ok: true, slot: null };
  if (typeof v !== 'object' || !COLOR_RE.test(v.color ?? '') || !isDigest(v.digest)) return { ok: false };
  return { ok: true, slot: { color: v.color, digest: v.digest } };
}

/** 解析 `lm-deploy prod status` 的 JSON（最後一行）；任何欄位格式不符即視為無效（fail closed）。 */
export function parseStatus(text) {
  const s = lastJsonLine(text);
  if (!s) return { ok: false, reason: '無法解析 lm-deploy status 輸出' };
  if (s.ok !== true || s.command !== 'status' || s.env !== 'prod') return { ok: false, reason: 'lm-deploy status 不是 prod 的成功結果' };
  if (!PHASES.has(s.phase)) return { ok: false, reason: 'lm-deploy status 的 phase 無效' };
  const active = parseSlot(s.active);
  const candidate = parseSlot(s.candidate);
  const previous = parseSlot(s.previous);
  if (!active.ok || !candidate.ok || !previous.ok) return { ok: false, reason: 'lm-deploy status 的槽位格式無效' };
  for (const key of ['history', 'retained', 'rollbackTargets']) {
    if (!Array.isArray(s[key]) || !s[key].every(isDigest)) return { ok: false, reason: `lm-deploy status 的 ${key} 格式無效` };
  }
  if (!(s.deployInProgress === true || s.deployInProgress === false || s.deployInProgress === null)) {
    return { ok: false, reason: 'lm-deploy status 的 deployInProgress 格式無效' };
  }
  return {
    ok: true,
    status: {
      phase: s.phase,
      active: active.slot,
      candidate: candidate.slot,
      previous: previous.slot,
      history: [...s.history],
      retained: [...s.retained],
      rollbackTargets: [...s.rollbackTargets],
      deployInProgress: s.deployInProgress,
    },
  };
}

/** 可回滾目標：lm-deploy 回報的 rollbackTargets 中，同時屬於保留集合（rollbackAllowed）且不是目前版本者，去除重複。 */
export function rollbackTargets(status) {
  const activeDigest = status?.active?.digest ?? null;
  const out = [];
  for (const d of Array.isArray(status?.rollbackTargets) ? status.rollbackTargets : []) {
    if (!isDigest(d) || d === activeDigest || out.includes(d)) continue;
    if (rollbackAllowed(d, status.retained)) out.push(d);
  }
  return out;
}

/**
 * 手動回滾檢查（Req 20.10、20.12）：任何一項不符即拒絕，且回傳指出原因的代碼。
 * triggeredBy 為建置觸發者（UserIdCause），approver 為 input 送出者；兩者必須是同一位 Release_Approver。
 */
export function checkRollback({ triggeredBy, approver, approvers, reason, digest, status } = {}) {
  const deny = (code, msg) => ({ allowed: false, code, reason: msg });
  if (!isReleaseApprover(triggeredBy, approvers)) return deny('not_release_approver', '觸發者不是 Release_Approver');
  if (approver !== triggeredBy) return deny('submitter_mismatch', '選擇回滾目標的帳號必須與觸發者相同');
  const r = validateReason(reason);
  if (!r.ok) return deny('invalid_reason', r.reason);
  if (!isDigest(digest)) return deny('invalid_digest', 'digest 格式必須為 sha256:<64 hex>');
  if (!status || !PHASES.has(status.phase)) return deny('status_invalid', '無法取得 Production 狀態');
  if (status.deployInProgress === true || status.phase !== 'idle') return deny('deploy_in_progress', '已有部署進行中');
  if (status.active?.digest === digest) return deny('already_active', '目標 digest 已是 Production 目前版本');
  if (!rollbackAllowed(digest, status.retained) || !rollbackAllowed(digest, rollbackTargets(status))) {
    return deny('not_retained', '目標 digest 不在 Deploy_Host 保留的最近 3 個 Image_Digest 中');
  }
  return { allowed: true, code: 'allowed', reason: '觸發者為 Release_Approver 且目標在保留集合中' };
}

function safeCode(v) {
  return typeof v === 'string' && /^[a-z_]{1,40}$/.test(v) ? v : 'unknown';
}

/**
 * 判讀 `lm-deploy prod rollback <digest>` 的結束碼與輸出。
 * 只有在確知 Production 未變更（啟動失敗、切換前健康失敗、拒絕、鎖）時 manualIntervention 才為 false；
 * 其餘（切換失敗、狀態檔無效、SSH 中斷等狀態不明）一律需人工介入，且不做任何自動切換（Req 20.11）。
 */
export function classifyRollback(exitCode, text, digest) {
  const r = lastJsonLine(text);
  const code = safeCode(r?.reason);
  if (exitCode === 0) {
    const ok = r && r.ok === true && r.command === 'rollback' && r.mode === 'manual' && r.migrationsRun === false
      && r.to && r.to.digest === digest && COLOR_RE.test(r.to.color ?? '')
      && Array.isArray(r.results) && healthyWithin(r.results, 120, 3);
    if (ok) return { outcome: 'switched', manualIntervention: false, code: 'switched', message: '已切換至目標 digest', color: r.to.color };
    return { outcome: 'manual_intervention', manualIntervention: true, code: 'unexpected_output', message: 'lm-deploy 回報成功但輸出與目標不符，需人工檢查' };
  }
  if (exitCode === 4) return { outcome: 'locked', manualIntervention: false, code: 'deploy_in_progress', message: '已有部署進行中' };
  if (exitCode === 2) return { outcome: 'rejected', manualIntervention: false, code, message: 'lm-deploy 拒絕回滾（目標不在保留集合或參數無效）；Production 未變更' };
  if (exitCode === 3) {
    const manual = code === 'state_invalid';
    return {
      outcome: manual ? 'manual_intervention' : 'rejected', manualIntervention: manual, code,
      message: manual ? 'Deploy_Host 狀態檔無效，需人工介入' : '目前狀態不允許回滾（已有未完成的部署）；Production 未變更',
    };
  }
  if (exitCode === 1 && (code === 'health_failed' || code === 'start_failed')) {
    return { outcome: 'failed', manualIntervention: false, code, message: '回滾目標未能啟動或未健康；已移除新容器，reverse proxy 未變更' };
  }
  return { outcome: 'manual_intervention', manualIntervention: true, code, message: '回滾結果不明或切換失敗，需人工介入' };
}

/** 判讀切換後 `lm-deploy prod health --wait` 的結果：120 秒內連續 3 次成功才算健康（Req 20.11）。 */
export function classifyHealth(exitCode, text) {
  const r = lastJsonLine(text);
  const healthy = exitCode === 0 && r?.ok === true && r.command === 'health' && r.healthy === true
    && Array.isArray(r.results) && healthyWithin(r.results, 120, 3);
  return healthy
    ? { healthy: true, code: 'healthy', message: '切換後 120 秒內連續 3 次 Health_Check 成功' }
    : { healthy: false, code: safeCode(r?.reason ?? 'health_failed'), message: '切換後 120 秒內未連續 3 次 Health_Check 成功，需人工介入' };
}

const orNA = (v) => (typeof v === 'string' && v !== '' ? v : NOT_APPLICABLE);
const digestOr = (v, fallback) => (isDigest(v) ? v : fallback);

/**
 * 建立手動回滾的 Build_Record（Req 20.9、20.11）：rollback 區段記錄觸發方式、帳號、來源與目標 digest、理由與完成時間；
 * 送出回滾後另於 deployments 追加一筆，標示是否執行遷移（一律 false）與是否需人工介入。回滾不涉及的區段標示「不適用」。
 */
export function buildRollbackRecord(input = {}) {
  const {
    job, number, url, startedAt, endedAt = new Date().toISOString(), commit, buildImageDigest,
    by, approver, approvedAt, from, to, reason, outcome, attempted = false, manualIntervention = false,
    status, firstFailedStage,
  } = input;
  if (!OUTCOMES.includes(outcome)) throw new TypeError('outcome 無效');
  if (!['SUCCESS', 'FAILURE', 'ABORTED'].includes(status)) throw new TypeError('status 無效');
  const n = Number(number);
  if (!Number.isSafeInteger(n) || n < 1) throw new TypeError('number 必須是正整數');
  const r = validateReason(reason);
  const toDigest = digestOr(to, NOT_APPLICABLE);
  const fromDigest = digestOr(from, NOT_APPLICABLE);
  const reports = Object.fromEntries(REPORT_KEYS.map((k) => [k, NOT_APPLICABLE]));
  const record = {
    schema: RECORD_SCHEMA,
    build: { job: String(job ?? ''), number: n, url: String(url ?? ''), startedAt: String(startedAt ?? endedAt), endedAt },
    source: { commit: /^[0-9a-f]{40}$/.test(commit ?? '') ? commit : NOT_RUN, trigger: ROLLBACK_TRIGGER, ref: 'release/rollback' },
    toolchain: { buildImageDigest: digestOr(buildImageDigest, NOT_RUN), bun: NOT_APPLICABLE, node: NOT_APPLICABLE, chromium: NOT_APPLICABLE },
    reports,
    image: { digest: NOT_APPLICABLE, tags: NOT_APPLICABLE, signature: NOT_APPLICABLE },
    backup: { id: NOT_APPLICABLE, env: NOT_APPLICABLE, createdAt: NOT_APPLICABLE, sizeBytes: NOT_APPLICABLE, sha256: NOT_APPLICABLE },
    approval: { approver: orNA(approver), at: orNA(approvedAt), digest: approver ? toDigest : NOT_APPLICABLE, unauthorizedAttempts: [] },
    gates: NOT_APPLICABLE,
    deployments: attempted
      ? [{
        env: 'production',
        digest: toDigest,
        from: fromDigest,
        at: endedAt,
        result: outcome,
        migrationsRun: false,
        manualInterventionRequired: manualIntervention === true,
      }]
      : NOT_APPLICABLE,
    rollback: {
      trigger: 'manual',
      by: orNA(by),
      from: fromDigest,
      to: toDigest,
      reason: r.ok ? r.value : (typeof reason === 'string' && reason.trim() !== '' ? INVALID_REASON_PLACEHOLDER : NOT_RUN),
      at: endedAt,
    },
    result: { status, firstFailedStage: status === 'SUCCESS' ? NOT_APPLICABLE : (firstFailedStage || NOT_RUN) },
  };
  const finalized = finalizeRecord(record, { status, endedAt });
  const v = validateRecord(finalized);
  if (!v.ok) throw new TypeError(`Build_Record 無效：${v.errors.join('；')}`);
  return finalized;
}

// ------------------------------------------------------------------ CLI

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { cmd };
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--') || i + 1 >= rest.length) return null;
    const key = rest[i].slice(2);
    if (!/^[a-z][a-z-]*$/.test(key) || key in opts) return null;
    opts[key] = rest[++i];
  }
  return opts;
}

const USAGE = '用法：bun ci/rollback.mjs approvers|targets|check|classify|health|record …（見檔頭說明）';

function readApprovers(file, readFile) {
  try { return JSON.parse(readFile(file ?? DEFAULT_APPROVERS_FILE, 'utf8')); } catch { return null; }
}

function readStatus(file, readFile) {
  try { return parseStatus(readFile(file, 'utf8')); } catch { return { ok: false, reason: '無法讀取 lm-deploy status 輸出' }; }
}

function parseExit(v) {
  return typeof v === 'string' && /^\d{1,3}$/.test(v) ? Number(v) : null;
}

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error, readFile = readFileSync, env = process.env } = {}) {
  const o = parseArgs(argv);
  if (!o) { error(USAGE); return 2; }
  const out = (obj, code) => { (code === 0 ? log : error)(JSON.stringify(obj)); return code; };
  try {
    switch (o.cmd) {
      case 'approvers': {
        const loaded = loadApprovers(readApprovers(o.file, readFile));
        if (!loaded.ok) return out({ ok: false, reason: loaded.reason ?? '無法讀取核准人清單' }, 2);
        return out({ ok: true, approvers: loaded.approvers.map((a) => a.jenkinsId) }, 0);
      }
      case 'targets': {
        if (!o.status) break;
        const s = readStatus(o.status, readFile);
        if (!s.ok) return out({ ok: false, reason: s.reason }, 2);
        const targets = rollbackTargets(s.status);
        return out({
          ok: targets.length > 0,
          phase: s.status.phase,
          deployInProgress: s.status.deployInProgress,
          active: s.status.active,
          targets,
          ...(targets.length ? {} : { reason: 'Deploy_Host 沒有可回滾的 Image_Digest' }),
        }, targets.length ? 0 : 1);
      }
      case 'check': {
        if (!o.status || !o.digest || !o['triggered-by'] || !o.approver) break;
        const doc = readApprovers(o.file, readFile);
        const s = readStatus(o.status, readFile);
        if (!s.ok) return out({ allowed: false, code: 'status_invalid', reason: s.reason }, 1);
        const decision = checkRollback({
          triggeredBy: o['triggered-by'], approver: o.approver, approvers: doc,
          reason: env[REASON_ENV], digest: o.digest, status: s.status,
        });
        return out({ ...decision, digest: isDigest(o.digest) ? o.digest : null, from: s.status.active?.digest ?? null }, decision.allowed ? 0 : 1);
      }
      case 'classify': {
        const code = parseExit(o.exit);
        if (code === null || !o.result || !o.digest) break;
        let text = '';
        try { text = readFile(o.result, 'utf8'); } catch { text = ''; }
        const c = classifyRollback(code, text, o.digest);
        return out(c, c.outcome === 'switched' ? 0 : 1);
      }
      case 'health': {
        const code = parseExit(o.exit);
        if (code === null || !o.result) break;
        let text = '';
        try { text = readFile(o.result, 'utf8'); } catch { text = ''; }
        const h = classifyHealth(code, text);
        return out(h, h.healthy ? 0 : 1);
      }
      case 'record': {
        if (!o.out) break;
        const record = buildRollbackRecord({
          job: o.job, number: o.number, url: o.url, startedAt: o['started-at'], commit: o.commit,
          buildImageDigest: o['build-image-digest'], by: o.by, approver: o.approver, approvedAt: o['approved-at'],
          from: o.from, to: o.to, reason: env[REASON_ENV], outcome: o.outcome,
          attempted: o.attempted === 'true', manualIntervention: o['manual-intervention'] === 'true',
          status: o.status, firstFailedStage: o['first-failed-stage'],
        });
        writeRecord(o.out, record);
        return out({ ok: true, out: o.out, outcome: record.deployments?.[0]?.result ?? o.outcome }, 0);
      }
      default:
        break;
    }
  } catch (e) {
    // 只輸出驗證訊息，不含使用者輸入原文。
    error(`rollback 操作失敗：${e instanceof Error ? e.message : 'unknown'}`);
    return 2;
  }
  error(USAGE);
  return 2;
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
