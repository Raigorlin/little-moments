// 正在 Production 執行之 Image_Digest 的建置保留（Requirement 21.6；Design「Jenkins 資料夾與 Job」）。
//
// Release_Tag 建置通過「上線後」觀察期後，該 Image_Digest 即在 Production 執行。本工具以 Jenkins API 對
//   1. 本次 Release_Tag 建置（部署該 Image_Digest），以及
//   2. 產生該 Image_Digest 的 main 建置（Resolve Digest 以 fingerprint 找回的 reports/release/main-build-record.json）
// 設定 keepLog=true（「Keep this build forever」），使其 Build_Record 不受第 3 至 5 條保留期限刪除。
// 被保留的建置之後仍屬 Deploy_Host 保留的最近 3 個可回滾 Image_Digest；移出保留集合時解除 keepLog
// 需要 Run/Delete 權限（Jenkins 的 Run#keepLog(false) 檢查 DELETE），與 Req 21.12 的「非管理員不可刪除」衝突，
// 因此不由 Pipeline 自動解除（由 Jenkins 管理員處理；程序記載於 ci/jenkins/README.md，Task 13.9）。
//
// 純函式：
//   keepLogTargets({ job, number, trigger, observed, digest, mainRecord }) → { targets: [{job, number, role}], reason? }
// I/O：
//   ensureKeepLog(targets, { baseUrl, user, token, fetchImpl, allowLoopbackHttp }) → [{job, number, role, changed}]
//     每個建置：GET `<build>/api/json?tree=keepLog` → 尚未保留時 POST `<build>/toggleLogKeep`
//     （toggle，因此先讀取目前值）→ 再次 GET 確認為 true；任何一步失敗即拋出 KeepLogError（固定訊息）。
//
// CLI（Jenkinsfile 收尾階段；憑證只經由環境變數或 0600 檔提供）：
//   JENKINS_URL=<https://…/> LM_JENKINS_API_USER=<帳號> LM_JENKINS_API_TOKEN_FILE=<0600 檔> \
//     bun ci/keep-log.mjs --job <JOB_NAME> --number <BUILD_NUMBER> --trigger <kind> --observed true|false \
//       [--digest sha256:<64 hex> --main-record <main-build-record.json>] [--out <result.json>]
//   結束碼：0 已設定（或依規則不需設定）；1 Jenkins API 設定失敗；2 參數或設定錯誤。
//   需要的 Jenkins 權限：release/little-moments 的 Job/Read 與 Run/Update（只用於 keepLog=true）。
//
// 安全：API token 只放在 Authorization 標頭；不跟隨重新導向；請求 URL 只由 base URL 與經驗證的 job 名稱、
// 建置編號組成；錯誤訊息為固定文字，不含回應內容。

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDigest } from './record.mjs';
import { parseJenkinsBase, jobPath, TRUSTED_JOB_PREFIX, MAIN_JOB, REQUEST_TIMEOUT_MS } from './digest-lookup.mjs';

export const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2 });

/** 不經 API 回傳的資料組 URL；job 名稱必須在 release/little-moments/ 底下。 */
function validRef(job, number) {
  if (typeof job !== 'string' || !job.startsWith(TRUSTED_JOB_PREFIX)) return false;
  try { jobPath(job); } catch { return false; }
  return Number.isSafeInteger(number) && number >= 1;
}

/**
 * 依本次建置結果決定要保留的建置。只有 Release_Tag 建置且觀察期已通過（Image_Digest 已在 Production 執行）才保留。
 * main 建置只在 Build_Record 結構相符（release/little-moments/main、main_push、image.digest 與本次相同）時列入。
 * @returns {{targets: {job:string, number:number, role:'release'|'main'}[], reason?: string}}
 */
export function keepLogTargets({ job, number, trigger, observed, digest, mainRecord } = {}) {
  if (trigger !== 'release_tag') return { targets: [], reason: '不是 Release_Tag 建置' };
  if (observed !== true) return { targets: [], reason: 'Image_Digest 未通過觀察期（不在 Production 執行）' };
  const n = Number(number);
  if (!validRef(job, n)) throw new TypeError('job 或建置編號無效');
  const targets = [{ job, number: n, role: 'release' }];
  const b = mainRecord?.build;
  const mainNumber = Number(b?.number);
  if (isDigest(digest) && b?.job === MAIN_JOB && validRef(b.job, mainNumber)
    && mainRecord?.source?.trigger === 'main_push' && mainRecord?.image?.digest === digest
    && !(b.job === job && mainNumber === n)) {
    targets.push({ job: b.job, number: mainNumber, role: 'main' });
  }
  return { targets };
}

/** keepLog 設定失敗；message 為固定文字。 */
export class KeepLogError extends Error {
  constructor(message) { super(message); this.name = 'KeepLogError'; }
}

async function request(url, method, auth, fetchImpl) {
  try {
    return await fetchImpl(url, {
      method,
      headers: { Authorization: auth, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new KeepLogError(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'Jenkins API 逾時' : '無法連線至 Jenkins');
  }
}

async function readKeepLog(buildUrl, auth, fetchImpl) {
  const res = await request(`${buildUrl}api/json?tree=keepLog`, 'GET', auth, fetchImpl);
  if (res.status === 401 || res.status === 403) throw new KeepLogError('Jenkins 認證失敗或權限不足');
  if (res.status === 404) throw new KeepLogError('找不到要保留的建置');
  if (res.status < 200 || res.status >= 300) throw new KeepLogError(`Jenkins 回應 HTTP ${res.status}`);
  let json;
  try { json = await res.json(); } catch { throw new KeepLogError('Jenkins 回應不是有效的 JSON'); }
  if (!json || typeof json.keepLog !== 'boolean') throw new KeepLogError('Jenkins 回應缺少 keepLog');
  return json.keepLog;
}

/**
 * 對每個建置確保 keepLog 為 true。
 * @returns {Promise<{job:string, number:number, role:string, changed:boolean}[]>}
 */
export async function ensureKeepLog(targets, { baseUrl, user, token, fetchImpl = fetch, allowLoopbackHttp = false } = {}) {
  const base = parseJenkinsBase(baseUrl, { allowLoopbackHttp });
  if (typeof user !== 'string' || user === '' || /[:\r\n]/.test(user)) throw new TypeError('LM_JENKINS_API_USER 未設定或無效');
  if (typeof token !== 'string' || token === '' || /[\r\n]/.test(token)) throw new TypeError('LM_JENKINS_API_TOKEN 未設定或無效');
  const auth = `Basic ${Buffer.from(`${user}:${token}`, 'utf8').toString('base64')}`;
  const out = [];
  for (const t of Array.isArray(targets) ? targets : []) {
    if (!validRef(t?.job, t?.number)) throw new TypeError('job 或建置編號無效');
    const buildUrl = new URL(`${jobPath(t.job)}${t.number}/`, base).toString();
    let changed = false;
    if (!(await readKeepLog(buildUrl, auth, fetchImpl))) {
      // toggleLogKeep 成功時回應 302（forwardToPreviousPage）；不跟隨。
      const res = await request(`${buildUrl}toggleLogKeep`, 'POST', auth, fetchImpl);
      await res.body?.cancel?.()?.catch?.(() => {});
      if (res.status === 401 || res.status === 403) throw new KeepLogError('Jenkins 帳號沒有 Run/Update 權限，無法保留建置');
      if (!(res.status >= 200 && res.status < 400)) throw new KeepLogError(`toggleLogKeep 回應 HTTP ${res.status}`);
      changed = true;
      if (!(await readKeepLog(buildUrl, auth, fetchImpl))) throw new KeepLogError('設定後 keepLog 仍為 false');
    }
    out.push({ job: t.job, number: t.number, role: t.role, changed });
  }
  return out;
}

function parseArgs(argv) {
  const known = new Set(['--job', '--number', '--trigger', '--observed', '--digest', '--main-record', '--out']);
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!known.has(argv[i]) || argv[i + 1] === undefined || argv[i].slice(2) in out) return null;
    out[argv[i].slice(2)] = argv[i + 1];
  }
  if (!out.job || !out.number || !out.trigger || !['true', 'false'].includes(out.observed)) return null;
  if (!/^[1-9][0-9]{0,9}$/.test(out.number)) return null;
  return out;
}

function writeAtomic(file, text) {
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, path);
}

export async function main(argv = process.argv.slice(2), {
  env = process.env, log = console.log, error = console.error, fetchImpl = fetch, readFile = readFileSync,
} = {}) {
  const args = parseArgs(argv);
  if (!args) {
    error('用法：bun ci/keep-log.mjs --job <job> --number <n> --trigger <kind> --observed true|false [--digest <d> --main-record <f>] [--out <f>]');
    return EXIT.USAGE;
  }
  let mainRecord = null;
  if (args['main-record']) {
    try { mainRecord = JSON.parse(readFile(args['main-record'], 'utf8')); } catch { mainRecord = null; }
  }
  let plan;
  try {
    plan = keepLogTargets({
      job: args.job, number: Number(args.number), trigger: args.trigger, observed: args.observed === 'true',
      digest: args.digest, mainRecord,
    });
  } catch (e) {
    error(`參數錯誤：${e instanceof TypeError ? e.message : '無效的輸入'}`);
    return EXIT.USAGE;
  }
  const write = (result) => {
    if (!args.out) return true;
    try { writeAtomic(args.out, JSON.stringify(result, null, 2) + '\n'); return true; } catch { error('無法寫入結果檔'); return false; }
  };
  if (plan.targets.length === 0) {
    log(`不需保留建置：${plan.reason}`);
    return write({ kept: [], reason: plan.reason }) ? EXIT.OK : EXIT.USAGE;
  }
  let token = env.LM_JENKINS_API_TOKEN;
  if ((token === undefined || token === '') && env.LM_JENKINS_API_TOKEN_FILE) {
    try { token = readFile(env.LM_JENKINS_API_TOKEN_FILE, 'utf8').replace(/\r?\n$/, ''); } catch {
      error('參數錯誤：無法讀取 LM_JENKINS_API_TOKEN_FILE');
      return EXIT.USAGE;
    }
  }
  let kept;
  try {
    kept = await ensureKeepLog(plan.targets, {
      baseUrl: env.JENKINS_URL, user: env.LM_JENKINS_API_USER, token, fetchImpl,
      allowLoopbackHttp: env.LM_LOOKUP_ALLOW_LOOPBACK_HTTP === '1',
    });
  } catch (e) {
    if (e instanceof KeepLogError) { error(`keepLog 設定失敗：${e.message}`); write({ kept: [], error: e.message }); return EXIT.FAILED; }
    if (e instanceof TypeError) { error(`參數錯誤：${e.message}`); return EXIT.USAGE; }
    error('keepLog 設定失敗：未預期的錯誤');
    return EXIT.FAILED;
  }
  for (const k of kept) log(`已保留 ${k.job} #${k.number}（${k.role}${k.changed ? '' : '，原已保留'}）`);
  return write({ kept }) ? EXIT.OK : EXIT.USAGE;
}

const isMain = import.meta.main
  ?? (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) process.exitCode = await main();
