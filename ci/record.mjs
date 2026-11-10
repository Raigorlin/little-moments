// Build_Record 讀寫、完成與查詢（Req 21.1、21.2、21.7、21.8、21.11、23.5；Design Property 42、43）。
//
// 純函式：
//   createRecord(init)                     → 新的 Build_Record（Req 21.1）
//   addGateResult(record, gateResult)       → 追加 Release_Gate 評估結果（Req 23.5）
//   mergeRecord(record, patch)              → 合併已知區段（不接受未知欄位）
//   finalizeRecord(record, { status, firstFailedStage, endedAt }) → 填滿所有必要欄位（Req 21.2、21.11）
//   lookupByDigest(records, digest)         → { found, records, reason? }（Req 21.7、21.8）
//   auditSummary(record)                    → 稽核查詢顯示欄位
//
// Build_Record 只存放識別碼、路徑、digest、時間與結果；欄位採白名單，任何未知欄位或疑似秘密的字串都會被拒絕，
// 封存前另由 ci/scrub.mjs 遮罩與掃描（Req 21.9）。
//
// CLI：
//   bun ci/record.mjs init --record <f> --job <j> --number <n> --url <u> --commit <sha> --trigger <kind> --ref <ref> --build-image-digest <d>
//   bun ci/record.mjs gate --record <f> --result <gate.json>
//   bun ci/record.mjs merge --record <f> --patch <patch.json>
//   bun ci/record.mjs finalize --record <f> --status SUCCESS|FAILURE|ABORTED [--first-failed-stage <name>]
//   bun ci/record.mjs lookup --digest <sha256:…> <record.json>...
//   結束碼：0 成功（lookup 查得）；1 查無或驗證失敗；2 參數錯誤。

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_ORDER } from './gates.mjs';

export const NOT_APPLICABLE = '不適用';
export const NOT_RUN = '未執行';
export const RECORD_SCHEMA = 1;
export const TRIGGER_KINDS = Object.freeze(['pull_request', 'main_push', 'branch_push', 'release_tag']);
export const RESULT_STATUSES = Object.freeze(['SUCCESS', 'FAILURE', 'ABORTED']);
export const REPORT_KEYS = Object.freeze(['unitJunit', 'e2eJunit', 'qaInventory', 'gitleaks', 'osv', 'semgrep', 'zap', 'trivy', 'sbom']);

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const MAX_STRING = 2048;
// 疑似秘密的字串：PEM 私鑰、Authorization 標頭、常見憑證前綴。
const SECRET_LIKE = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]{8,}/, /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}/, /\bAKIA[0-9A-Z]{16}\b/];

export function isDigest(v) { return typeof v === 'string' && DIGEST_RE.test(v); }

// 欄位白名單：每個區段的必要欄位。值為「適用性」類別，供 finalizeRecord 決定填入「不適用」或「未執行」。
//   always   ：所有建置皆適用 → 缺少時「未執行」
//   image    ：main 與 Release_Tag 適用
//   build    ：只有 main 建置產生（映像掃描、SBOM、簽章推送）
//   deploy   ：main 與 Release_Tag 適用（備份、部署）
//   dast     ：Trusted_Ref 適用（DAST、遷移相容性）
//   approval ：僅 Release_Tag 適用
//   rollback ：只在發生回滾時才有值 → 缺少時一律「不適用」
const SECTIONS = Object.freeze({
  build: { job: 'always', number: 'always', url: 'always', startedAt: 'always', endedAt: 'always' },
  source: { commit: 'always', trigger: 'always', ref: 'always' },
  toolchain: { buildImageDigest: 'always', bun: 'always', node: 'always', chromium: 'always' },
  reports: {
    unitJunit: 'always', e2eJunit: 'always', qaInventory: 'always', gitleaks: 'always', osv: 'always', semgrep: 'always',
    zap: 'dast', trivy: 'build', sbom: 'build',
  },
  image: { digest: 'image', tags: 'image', signature: 'image' },
  backup: { id: 'deploy', env: 'deploy', createdAt: 'deploy', sizeBytes: 'deploy', sha256: 'deploy' },
  approval: { approver: 'approval', at: 'approval', digest: 'approval', unauthorizedAttempts: 'list' },
  rollback: { trigger: 'rollback', by: 'rollback', from: 'rollback', to: 'rollback', reason: 'rollback', at: 'rollback' },
  result: { status: 'always', firstFailedStage: 'always' },
});
// 陣列型必要欄位（頂層）。
const TOP_LISTS = Object.freeze({ gates: 'always', deployments: 'deploy' });

function applicable(category, kind) {
  switch (category) {
    case 'always': return true;
    case 'image': case 'deploy': case 'dast': return kind === 'main_push' || kind === 'release_tag';
    case 'build': return kind === 'main_push';
    case 'approval': return kind === 'release_tag';
    case 'rollback': return false;
    default: return true;
  }
}

function placeholder(category, kind) {
  // 觸發類型未知時無法判斷適用性，保守標示「未執行」。
  if (!TRIGGER_KINDS.includes(kind)) return category === 'rollback' ? NOT_APPLICABLE : NOT_RUN;
  return applicable(category, kind) ? NOT_RUN : NOT_APPLICABLE;
}

function isMissing(v) {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function clone(v) { return v === undefined ? undefined : structuredClone(v); }

/** 檢查值只含允許的型別、長度且不像秘密；回傳錯誤訊息清單（不含值本身）。 */
function checkValue(path, v, errors, depth = 0) {
  if (depth > 6) { errors.push(`${path}: 巢狀層級過深`); return; }
  if (v === null || typeof v === 'boolean') return;
  if (typeof v === 'number') { if (!Number.isFinite(v)) errors.push(`${path}: 數值無效`); return; }
  if (typeof v === 'string') {
    if (v.length > MAX_STRING) errors.push(`${path}: 字串過長`);
    // 允許 \t 以外不允許控制字元。
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(v)) errors.push(`${path}: 含控制字元`);
    if (SECRET_LIKE.some((re) => re.test(v))) errors.push(`${path}: 疑似秘密值`);
    return;
  }
  if (Array.isArray(v)) { v.forEach((x, i) => checkValue(`${path}[${i}]`, x, errors, depth + 1)); return; }
  if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)) errors.push(`${path}: 欄位名稱無效`);
      checkValue(`${path}.${k}`, x, errors, depth + 1);
    }
    return;
  }
  errors.push(`${path}: 型別無效`);
}

/**
 * 驗證 Build_Record 結構：只允許白名單區段與欄位（reports 另允許額外的報告鍵）。
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { ok: false, errors: ['紀錄不是物件'] };
  for (const [key, value] of Object.entries(record)) {
    if (key === 'schema') { if (value !== RECORD_SCHEMA) errors.push('schema 版本不符'); continue; }
    if (key in TOP_LISTS) {
      if (!Array.isArray(value) && typeof value !== 'string') errors.push(`${key}: 必須是陣列`);
      checkValue(key, value, errors);
      continue;
    }
    const fields = SECTIONS[key];
    if (!fields) { errors.push(`未知的區段 ${key}`); continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(`${key}: 必須是物件`); continue; }
    for (const field of Object.keys(value)) {
      const extraReport = key === 'reports' && /^[a-z][A-Za-z0-9]{0,63}$/.test(field);
      if (!(field in fields) && !extraReport) errors.push(`${key}.${field}: 未知欄位`);
    }
    checkValue(key, value, errors);
  }
  return { ok: errors.length === 0, errors };
}

function assertValid(record) {
  const v = validateRecord(record);
  if (!v.ok) throw new TypeError(`Build_Record 無效：${v.errors.join('；')}`);
  return record;
}

/** 建立新的 Build_Record（Req 21.1）。 */
export function createRecord({ job, number, url, startedAt, commit, trigger, ref, buildImageDigest } = {}) {
  if (typeof commit !== 'string' || !COMMIT_RE.test(commit)) throw new TypeError('commit 必須是 40 字元小寫十六進位');
  if (!TRIGGER_KINDS.includes(trigger)) throw new TypeError('trigger 無效');
  if (!isDigest(buildImageDigest)) throw new TypeError('buildImageDigest 必須是 sha256 digest');
  const n = Number(number);
  if (!Number.isSafeInteger(n) || n < 1) throw new TypeError('number 必須是正整數');
  const started = startedAt ?? new Date().toISOString();
  return assertValid({
    schema: RECORD_SCHEMA,
    build: { job: String(job ?? ''), number: n, url: String(url ?? ''), startedAt: started },
    source: { commit, trigger, ref: String(ref ?? '') },
    toolchain: { buildImageDigest },
    gates: [],
  });
}

/** 追加 Release_Gate 評估結果（名稱、結果、評估時間、commit；Req 23.5）。 */
export function addGateResult(record, gateResult) {
  const g = gateResult ?? {};
  if (!GATE_ORDER.includes(g.gate)) throw new TypeError('未知的 Release_Gate');
  if (typeof g.pass !== 'boolean') throw new TypeError('pass 必須是布林值');
  const entry = {
    gate: g.gate,
    pass: g.pass,
    status: typeof g.status === 'string' ? g.status : (g.pass ? 'pass' : 'fail'),
    evaluatedAt: typeof g.evaluatedAt === 'string' ? g.evaluatedAt : new Date().toISOString(),
    commit: typeof g.commit === 'string' ? g.commit : (record?.source?.commit ?? NOT_RUN),
    unmet: Array.isArray(g.unmet) ? g.unmet.filter((x) => typeof x === 'string') : [],
    reports: Array.isArray(g.reports) ? g.reports.filter((x) => typeof x === 'string') : [],
  };
  const next = clone(record);
  next.gates = Array.isArray(next.gates) ? [...next.gates, entry] : [entry];
  return assertValid(next);
}

/** 合併已知區段；頂層陣列 deployments 以追加方式合併。 */
export function mergeRecord(record, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('patch 必須是物件');
  const next = clone(record);
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'schema') continue;
    if (key === 'deployments' || key === 'gates') {
      const items = Array.isArray(value) ? value : [value];
      next[key] = [...(Array.isArray(next[key]) ? next[key] : []), ...clone(items)];
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      next[key] = { ...(next[key] && typeof next[key] === 'object' ? next[key] : {}), ...clone(value) };
    } else {
      next[key] = clone(value);
    }
  }
  return assertValid(next);
}

/**
 * 填滿所有必要欄位：已存在的值不變；缺少（undefined、null、空字串、空陣列）的欄位
 * 依觸發類型填入「不適用」或「未執行」（Req 21.2）。
 * opts.status／firstFailedStage／endedAt 只在對應欄位缺少時套用（Req 21.11）。
 * approval.unauthorizedAttempts 為清單：缺少時為 []（0 次越權嘗試是有效值）。
 */
export function finalizeRecord(record, { status, firstFailedStage, endedAt } = {}) {
  const src = record && typeof record === 'object' && !Array.isArray(record) ? record : {};
  const out = clone(src);
  const kind = src.source?.trigger;
  out.schema = RECORD_SCHEMA;

  const result = { ...(out.result ?? {}) };
  if (isMissing(result.status) && RESULT_STATUSES.includes(status)) result.status = status;
  if (isMissing(result.firstFailedStage)) {
    if (typeof firstFailedStage === 'string' && firstFailedStage !== '') result.firstFailedStage = firstFailedStage;
    else if (result.status === 'SUCCESS') result.firstFailedStage = NOT_APPLICABLE;
  }
  out.result = result;
  if (isMissing(out.build?.endedAt) && typeof endedAt === 'string' && endedAt !== '') {
    out.build = { ...(out.build ?? {}), endedAt };
  }

  for (const [section, fields] of Object.entries(SECTIONS)) {
    const current = out[section] && typeof out[section] === 'object' && !Array.isArray(out[section]) ? out[section] : {};
    const filled = { ...current };
    for (const [field, category] of Object.entries(fields)) {
      if (category === 'list') {
        if (filled[field] === undefined || filled[field] === null) filled[field] = [];
        continue;
      }
      if (isMissing(filled[field])) filled[field] = placeholder(category, kind);
    }
    out[section] = filled;
  }
  for (const [key, category] of Object.entries(TOP_LISTS)) {
    if (isMissing(out[key])) out[key] = placeholder(category, kind);
  }
  return out;
}

/**
 * 以 Image_Digest 查詢 Build_Record：只回傳 image.digest 與查詢值完全相同的紀錄（不做前綴或大小寫寬鬆比對）。
 * @returns {{found: true, records: object[]} | {found: false, records: [], reason: string}}
 */
export function lookupByDigest(records, digest) {
  if (!isDigest(digest)) return { found: false, records: [], reason: 'Image_Digest 格式無效' };
  const matches = (Array.isArray(records) ? records : []).filter((r) => r?.image?.digest === digest);
  if (matches.length === 0) return { found: false, records: [], reason: '查無對應紀錄' };
  return { found: true, records: matches };
}

/** 稽核查詢顯示欄位（Req 21.7）：Commit SHA、Release_Tag、核准人、核准時間與 Production 部署時間。 */
export function auditSummary(record) {
  const r = finalizeRecord(record);
  const prod = Array.isArray(r.deployments) ? r.deployments.filter((d) => d?.env === 'production') : [];
  return {
    digest: r.image.digest,
    commit: r.source.commit,
    releaseTag: r.source.trigger === 'release_tag' ? r.source.ref : NOT_APPLICABLE,
    approver: r.approval.approver,
    approvedAt: r.approval.at,
    productionDeployedAt: prod.length ? prod[prod.length - 1].at ?? NOT_RUN : NOT_APPLICABLE,
    build: `${r.build.job}#${r.build.number}`,
  };
}

export function readRecord(file) {
  return assertValid(JSON.parse(readFileSync(file, 'utf8')));
}

/** 驗證後以暫存檔 + rename 原子寫入。 */
export function writeRecord(file, record) {
  assertValid(record);
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o644 });
  renameSync(tmp, path);
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { cmd, files: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      if (i + 1 >= rest.length) return null;
      opts[a.slice(2)] = rest[++i];
    } else opts.files.push(a);
  }
  return opts;
}

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  const o = parseArgs(argv);
  const usage = () => { error('用法：bun ci/record.mjs init|gate|merge|finalize|lookup …（見檔頭說明）'); return 2; };
  if (!o) return usage();
  try {
    switch (o.cmd) {
      case 'init': {
        if (!o.record) return usage();
        writeRecord(o.record, createRecord({
          job: o.job, number: o.number, url: o.url, commit: o.commit, trigger: o.trigger, ref: o.ref,
          buildImageDigest: o['build-image-digest'],
        }));
        return 0;
      }
      case 'gate': {
        if (!o.record || !o.result) return usage();
        writeRecord(o.record, addGateResult(readRecord(o.record), JSON.parse(readFileSync(o.result, 'utf8'))));
        return 0;
      }
      case 'merge': {
        if (!o.record || !o.patch) return usage();
        writeRecord(o.record, mergeRecord(readRecord(o.record), JSON.parse(readFileSync(o.patch, 'utf8'))));
        return 0;
      }
      case 'finalize': {
        if (!o.record || !RESULT_STATUSES.includes(o.status)) return usage();
        writeRecord(o.record, finalizeRecord(readRecord(o.record), {
          status: o.status, firstFailedStage: o['first-failed-stage'], endedAt: new Date().toISOString(),
        }));
        return 0;
      }
      case 'lookup': {
        if (!o.digest) return usage();
        const records = o.files.map((f) => { try { return readRecord(f); } catch { return null; } }).filter(Boolean);
        const res = lookupByDigest(records, o.digest);
        log(JSON.stringify(res.found ? { found: true, records: res.records.map(auditSummary) } : res));
        return res.found ? 0 : 1;
      }
      default:
        return usage();
    }
  } catch (e) {
    // 只輸出錯誤訊息（驗證訊息不含欄位值）。
    error(`Build_Record 操作失敗：${e instanceof Error ? e.message : 'unknown'}`);
    return 1;
  }
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
