// 還原演練 Job `release/restore-drill` 的判讀與 Build_Record（Requirement 14.6、14.7、21.10；design.md Components §13）。
//
// 純函式：
//   parseDrillResult(exitCode, text)  → 判讀 `lm-deploy prod drill` 的結束碼與最後一行 JSON（fail closed）
//   buildDrillRecord(input)           → 已填滿所有欄位的 Build_Record（經 ci/record.mjs 驗證）
//
// Build_Record 內容（Req 14.6、14.7）：
//   backup       使用的備份識別碼、環境、建立時間、大小與校驗碼（drill 讀取時重算的 sha256）
//   deployments  一筆 { type: 'restore_drill', backupId, restoreSeconds, smokeResult, result, failedStep, digest, … }
//                不使用 env 欄位，因此不會被 auditSummary 誤認為 Production 部署。
//   result       建置結果與第一個失敗的步驟（演練失敗時為 drill 的失敗步驟，例如 restore、smoke）
// 只記錄識別碼、數值、步驟名稱與狀態碼；不含備份內容、帳號、密碼或回應內容（Req 21.10）。
// 演練永遠不刪除或修剪備份；backupCount 為演練結束時 Deploy_Host 上的已驗證備份數，供稽核確認（Req 14.7）。
//
// CLI（結束碼：0 通過；1 未通過；2 參數或輸入錯誤）：
//   bun ci/restore-drill.mjs classify --exit <n> --result <drill.jsonl>
//   bun ci/restore-drill.mjs record --out <f> --job <j> --number <n> --url <u> --started-at <iso> --commit <sha>
//       --build-image-digest <d> --by <id|空字串> --result <drill.jsonl|空字串> --exit <n|空字串>
//       --status SUCCESS|FAILURE|ABORTED --first-failed-stage <stage|空字串>

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NOT_APPLICABLE, NOT_RUN, RECORD_SCHEMA, REPORT_KEYS, finalizeRecord, validateRecord, writeRecord } from './record.mjs';

export const DRILL_TRIGGER = 'restore_drill';
export const DRILL_REF = 'release/restore-drill';
// lm-deploy drill 的步驟（Deploy_Host 端）與 /app/tools/drill.js 的步驟（drill 網路內）。
export const DRILL_STEPS = Object.freeze([
  'backup_select', 'backup_verify', 'setup', 'db_start', 'restore', 'migrate', 'app_start',
  'wait-healthy', 'seed-admin', 'fixture', 'smoke', 'drill_tool', 'cleanup',
]);
const TOOL_STEPS = new Set(['wait-healthy', 'seed-admin', 'fixture', 'smoke']);
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const BACKUP_ID_RE = /^prod-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const PROJECT_RE = /^lm-drill-prod-[0-9a-f]{8}$/;
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const STEP_NAME_RE = /^[a-z][a-z-]{0,31}$/;
const REASON_RE = /^[a-z][a-z0-9:-]{0,63}$/;

export const isDigest = (v) => typeof v === 'string' && DIGEST_RE.test(v);

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

/** smoke／tool 步驟只保留名稱、狀態碼、耗時、結果與失敗類別（格式不符的步驟捨棄）。 */
function cleanSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.slice(0, 20).filter((s) => s && typeof s === 'object' && STEP_NAME_RE.test(s.step ?? '')).map((s) => ({
    step: s.step,
    status: Number.isInteger(s.status) && s.status >= 100 && s.status <= 599 ? s.status : null,
    ms: Number.isFinite(s.ms) && s.ms >= 0 ? Math.round(s.ms) : null,
    result: ['pass', 'fail', 'skipped'].includes(s.result) ? s.result : 'fail',
    ...(typeof s.reason === 'string' && REASON_RE.test(s.reason) ? { reason: s.reason } : {}),
  }));
}

function parseBackup(v, id) {
  if (!v || typeof v !== 'object' || v.id !== id) return null;
  return {
    id,
    createdAt: typeof v.createdAt === 'string' && ISO_RE.test(v.createdAt) ? v.createdAt : null,
    sizeBytes: Number.isSafeInteger(v.sizeBytes) && v.sizeBytes >= 0 ? v.sizeBytes : null,
    sha256: typeof v.sha256 === 'string' && SHA_RE.test(v.sha256) ? v.sha256 : null,
  };
}

/**
 * 判讀 `lm-deploy prod drill` 的結果。通過的條件：結束碼 0、最後一行為 prod drill 的成功 JSON、result 為 pass、
 * 備份識別碼與 digest 格式正確、Smoke_Test 全部通過且 drill 專案已銷毀。其餘一律未通過（fail closed）。
 * @returns {{passed:boolean, code:string, failedStep:string|null, backupId:string|null, backup:object|null,
 *   digest:string|null, project:string|null, restoreSeconds:number|null, smokeResult:'pass'|'fail'|'not_run',
 *   smokeSteps:object[], toolSteps:object[], cleanedUp:boolean|null, backupCount:number|null}}
 */
export function parseDrillResult(exitCode, text) {
  const r = lastJsonLine(text);
  const fromHost = r && r.command === 'drill' && r.env === 'prod';
  const backupId = fromHost && typeof r.backupId === 'string' && BACKUP_ID_RE.test(r.backupId) ? r.backupId : null;
  const tool = fromHost && r.tool && typeof r.tool === 'object' ? r.tool : null;
  const smoke = tool && tool.smoke && typeof tool.smoke === 'object' ? tool.smoke : null;
  const smokeSteps = cleanSteps(smoke?.steps);
  let smokeResult = 'not_run';
  if (smoke) smokeResult = smoke.ok === true && smokeSteps.length > 0 && smokeSteps.every((s) => s.result === 'pass') ? 'pass' : 'fail';
  const restoreSeconds = fromHost && Number.isFinite(r.restoreSeconds) && r.restoreSeconds >= 0 ? r.restoreSeconds : null;
  let failedStep = fromHost && typeof r.failedStep === 'string' && DRILL_STEPS.includes(r.failedStep) ? r.failedStep : null;
  const out = {
    passed: false,
    code: fromHost && typeof r.reason === 'string' && CODE_RE.test(r.reason) ? r.reason : 'unknown',
    failedStep,
    backupId,
    backup: backupId ? parseBackup(r.backup, backupId) : null,
    digest: fromHost && isDigest(r.digest) ? r.digest : null,
    project: fromHost && typeof r.project === 'string' && PROJECT_RE.test(r.project) ? r.project : null,
    restoreSeconds,
    smokeResult,
    smokeSteps,
    toolSteps: cleanSteps(tool?.steps),
    cleanedUp: fromHost && typeof r.cleanedUp === 'boolean' ? r.cleanedUp : null,
    backupCount: fromHost && Number.isSafeInteger(r.backupCount) && r.backupCount >= 0 ? r.backupCount : null,
  };
  if (!fromHost) {
    out.code = exitCode === 255 ? 'ssh_failed' : 'invalid_output';
    out.failedStep = 'drill_tool';
    return out;
  }
  const passed = exitCode === 0 && r.ok === true && r.result === 'pass' && failedStep === null
    && backupId !== null && out.digest !== null && restoreSeconds !== null && smokeResult === 'pass' && out.cleanedUp === true;
  if (passed) return { ...out, passed: true, code: 'passed' };
  if (exitCode === 4) out.code = 'drill_in_progress';
  if (!out.failedStep) {
    const toolFailed = out.toolSteps.find((s) => s.result === 'fail');
    out.failedStep = toolFailed && TOOL_STEPS.has(toolFailed.step) ? toolFailed.step : (smokeResult === 'pass' && out.cleanedUp !== true ? 'cleanup' : 'drill_tool');
  }
  return out;
}

const orNA = (v) => (typeof v === 'string' && v !== '' ? v : NOT_APPLICABLE);

/** 建立還原演練的 Build_Record（Req 14.6、14.7）。drill 為 null 表示未執行到 lm-deploy drill。 */
export function buildDrillRecord(input = {}) {
  const {
    job, number, url, startedAt, endedAt = new Date().toISOString(), commit, buildImageDigest, by,
    drill = null, status, firstFailedStage,
  } = input;
  if (!['SUCCESS', 'FAILURE', 'ABORTED'].includes(status)) throw new TypeError('status 無效');
  const n = Number(number);
  if (!Number.isSafeInteger(n) || n < 1) throw new TypeError('number 必須是正整數');
  // 演練未通過時，建置必定為失敗（Req 14.7）；通過但 Pipeline 其他步驟失敗時維持呼叫端的狀態。
  const finalStatus = status === 'SUCCESS' && drill?.passed !== true ? 'FAILURE' : status;
  const reports = Object.fromEntries(REPORT_KEYS.map((k) => [k, NOT_APPLICABLE]));
  const b = drill?.backup ?? null;
  const backup = drill
    ? {
      id: drill.backupId ?? NOT_RUN,
      env: drill.backupId ? 'production' : NOT_RUN,
      createdAt: b?.createdAt ?? NOT_RUN,
      sizeBytes: b?.sizeBytes ?? NOT_RUN,
      sha256: b?.sha256 ?? NOT_RUN,
    }
    : { id: NOT_RUN, env: NOT_RUN, createdAt: NOT_RUN, sizeBytes: NOT_RUN, sha256: NOT_RUN };
  const failed = finalStatus === 'SUCCESS' ? NOT_APPLICABLE
    : (drill && !drill.passed && drill.failedStep ? `Drill:${drill.failedStep}` : (firstFailedStage || NOT_RUN));
  const record = {
    schema: RECORD_SCHEMA,
    build: { job: String(job ?? ''), number: n, url: String(url ?? ''), startedAt: String(startedAt ?? endedAt), endedAt },
    source: { commit: /^[0-9a-f]{40}$/.test(commit ?? '') ? commit : NOT_RUN, trigger: DRILL_TRIGGER, ref: DRILL_REF },
    toolchain: { buildImageDigest: isDigest(buildImageDigest) ? buildImageDigest : NOT_RUN, bun: NOT_APPLICABLE, node: NOT_APPLICABLE, chromium: NOT_APPLICABLE },
    reports,
    image: { digest: NOT_APPLICABLE, tags: NOT_APPLICABLE, signature: NOT_APPLICABLE },
    backup,
    approval: { approver: NOT_APPLICABLE, at: NOT_APPLICABLE, digest: NOT_APPLICABLE, unauthorizedAttempts: [] },
    gates: NOT_APPLICABLE,
    deployments: drill
      ? [{
        type: 'restore_drill',
        sourceEnv: 'production',
        by: orNA(by),
        backupId: drill.backupId ?? NOT_RUN,
        restoreSeconds: drill.restoreSeconds ?? NOT_RUN,
        smokeResult: drill.smokeResult,
        smokeSteps: drill.smokeSteps,
        result: drill.passed ? 'pass' : 'fail',
        code: drill.code,
        failedStep: drill.passed ? NOT_APPLICABLE : (drill.failedStep ?? NOT_RUN),
        digest: drill.digest ?? NOT_RUN,
        project: drill.project ?? NOT_RUN,
        cleanedUp: drill.cleanedUp,
        backupsDeleted: 0,
        backupCount: drill.backupCount,
        at: endedAt,
      }]
      : NOT_RUN,
    result: { status: finalStatus, firstFailedStage: failed },
  };
  const finalized = finalizeRecord(record, { status: finalStatus, endedAt });
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

const parseExit = (v) => (typeof v === 'string' && /^\d{1,3}$/.test(v) ? Number(v) : null);
const USAGE = '用法：bun ci/restore-drill.mjs classify|record …（見檔頭說明）';

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error, readFile = readFileSync } = {}) {
  const o = parseArgs(argv);
  if (!o) { error(USAGE); return 2; }
  const out = (obj, code) => { (code === 0 ? log : error)(JSON.stringify(obj)); return code; };
  const readText = (f) => { try { return readFile(f, 'utf8'); } catch { return ''; } };
  try {
    switch (o.cmd) {
      case 'classify': {
        const code = parseExit(o.exit);
        if (code === null || !o.result) break;
        const d = parseDrillResult(code, readText(o.result));
        return out(d, d.passed ? 0 : 1);
      }
      case 'record': {
        if (!o.out || !o.status) break;
        const code = parseExit(o.exit ?? '');
        const drill = o.result && code !== null ? parseDrillResult(code, readText(o.result)) : null;
        const record = buildDrillRecord({
          job: o.job, number: o.number, url: o.url, startedAt: o['started-at'], commit: o.commit,
          buildImageDigest: o['build-image-digest'], by: o.by, drill,
          status: o.status, firstFailedStage: o['first-failed-stage'],
        });
        writeRecord(o.out, record);
        return out({ ok: true, out: o.out, status: record.result.status, backupId: record.backup.id }, 0);
      }
      default:
        break;
    }
  } catch (e) {
    error(`restore-drill 操作失敗：${e instanceof Error ? e.message : 'unknown'}`);
    return 2;
  }
  error(USAGE);
  return 2;
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
