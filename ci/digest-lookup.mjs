// 以 Image_Digest 查詢 Build_Record（Requirements 21.7、21.8；Design「Build_Record」、Property 43）。
//
// main 建置封存 `image-digest.txt`（內容恰為 `<digest>\n`）並 fingerprint；Release_Tag 建置以同一檔案
// fingerprint 找回 main Build_Record，因此兩者都出現在該 fingerprint 的使用紀錄中。本工具：
//   1. 以 MD5(`<digest>\n`) 查詢 Jenkins fingerprint API，取得產生與使用該檔案的建置
//   2. 只保留 release/little-moments/ 底下的建置（ci/ 的 Untrusted 建置可以偽造同內容的檔案，不採信）
//   3. 下載每個建置封存的 Build_Record，驗證結構且 build.job／build.number 與 fingerprint 來源一致
//   4. 套用 lookupByDigest（只回傳 image.digest 完全相等者），輸出 auditSummary：
//      Commit SHA、Release_Tag、核准人、核准時間與 Production 部署時間
// 查無 fingerprint、沒有可信建置或沒有相符紀錄時明確回報「查無對應紀錄」，且不回傳其他 digest 的紀錄（Req 21.8）。
//
// 純函式（測試用）：
//   fingerprintId(digest)                    → MD5(`<digest>\n`) 的 32 字元小寫十六進位
//   parseJenkinsBase(url, { allowLoopbackHttp }) → 正規化的 base URL（僅 HTTPS；loopback HTTP 需明確允許）
//   jobPath(fullName)                        → `job/<a>/job/<b>/…`（每段 encodeURIComponent）
//   buildRefsFromFingerprint(json, { prefix, max }) → { refs: [{job, number}], truncated }
//   isConsistentRecord(record, ref)          → 紀錄結構有效且 build.job／number 與 ref 相同
//   formatResult(result)                     → 主控台顯示文字
// I/O：
//   lookupDigest(digest, { baseUrl, user, token, … }) → { found, digest, records, reason?, skipped }
//
// CLI（憑證只經由環境變數提供，於 Jenkinsfile 的 withCredentials 區塊內設定）：
//   JENKINS_URL=<https://…/> LM_JENKINS_API_USER=<帳號> LM_JENKINS_API_TOKEN=<API token> \
//     bun ci/digest-lookup.mjs --digest sha256:<64 hex> [--out <result.json>] [--record-artifact <path>]
//       [--commit <40 hex> --main-record-out <main-build-record.json>]
//   --main-record-out：Release_Tag 建置用；另寫出產生該 digest 的 main 建置（release/little-moments/main、
//   main_push、commit 相符）之完整 Build_Record（selectMainRecord）；查無時結束碼 1。
//   LM_JENKINS_API_TOKEN 未設定時改讀 LM_JENKINS_API_TOKEN_FILE（0600 暫存檔；避免 token 出現在
//   `docker exec --env` 等程序參數中）。
//   測試用：LM_LOOKUP_ALLOW_LOOPBACK_HTTP=1 允許 http://127.0.0.1／localhost／[::1]。
//   結束碼：0 查得；1 查無對應紀錄；2 參數或設定錯誤（含 digest 格式無效）；3 Jenkins 查詢失敗。
//   查詢失敗（無法連線、認證失敗、5xx、逾時、回應過大或格式無效）不視為「查無」（fail closed）。
//
// 安全：
//   - API token 只放在 Authorization 標頭（Basic），不放在 URL；不跟隨重新導向（避免標頭送往其他來源）
//   - 所有請求 URL 由 base URL 與經驗證的 job 名稱／建置編號組成，不使用 API 回傳的 URL
//   - 錯誤訊息為固定文字，不含回應內容或例外訊息；輸出前以 ci/scrub.mjs 的 findLeaks 確認不含 token
//   - 私有 CA：以 NODE_EXTRA_CA_CERTS 指定，不提供關閉 TLS 驗證的選項

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupByDigest, auditSummary, validateRecord, isDigest } from './record.mjs';
import { findLeaks } from './scrub.mjs';

export const EXIT = Object.freeze({ FOUND: 0, NOT_FOUND: 1, USAGE: 2, QUERY_ERROR: 3 });
export const NOT_FOUND_REASON = '查無對應紀錄';
export const TRUSTED_JOB_PREFIX = 'release/little-moments/';
export const DEFAULT_RECORD_ARTIFACT = 'reports/build-record.json';
export const MAX_BUILDS = 200;
export const REQUEST_TIMEOUT_MS = 15_000;
export const TOTAL_TIMEOUT_MS = 120_000;
export const MAX_RESPONSE_BYTES = 1024 * 1024;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const JOB_SEGMENT_RE = /^[A-Za-z0-9._%+-]{1,128}$/;
const ARTIFACT_RE = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]{1,255}$/;

/** 查詢失敗（非「查無」）；message 為固定文字，不含回應內容或憑證。 */
export class LookupError extends Error {
  constructor(message) { super(message); this.name = 'LookupError'; }
}

/** Jenkins fingerprint ID：`image-digest.txt` 內容 `<digest>\n` 的 MD5。 */
export function fingerprintId(digest) {
  if (!isDigest(digest)) throw new TypeError('Image_Digest 格式無效');
  return createHash('md5').update(`${digest}\n`, 'utf8').digest('hex');
}

/**
 * 驗證並正規化 Jenkins base URL（結尾固定為 `/`）。拒絕帳密、query、fragment；
 * 只允許 https:，或在 allowLoopbackHttp 時允許 loopback 主機的 http:。
 */
export function parseJenkinsBase(raw, { allowLoopbackHttp = false } = {}) {
  let u;
  try { u = new URL(String(raw ?? '')); } catch { throw new TypeError('JENKINS_URL 格式無效'); }
  if (u.username || u.password) throw new TypeError('JENKINS_URL 不得包含帳號或密碼');
  if (u.search || u.hash) throw new TypeError('JENKINS_URL 不得包含 query 或 fragment');
  const loopbackHttp = u.protocol === 'http:' && allowLoopbackHttp && LOOPBACK_HOSTS.has(u.hostname);
  if (u.protocol !== 'https:' && !loopbackHttp) throw new TypeError('JENKINS_URL 必須使用 HTTPS');
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.toString();
}

function isJobName(name) {
  if (typeof name !== 'string' || name.length > 512) return false;
  const segs = name.split('/');
  return segs.every((s) => JOB_SEGMENT_RE.test(s) && s !== '.' && s !== '..');
}

/** Jenkins 完整 job 名稱 → URL 路徑（`job/<seg>/job/<seg>/`）。 */
export function jobPath(fullName) {
  if (!isJobName(fullName)) throw new TypeError('job 名稱無效');
  return fullName.split('/').map((s) => `job/${encodeURIComponent(s)}/`).join('');
}

/**
 * 由 fingerprint API JSON 取出可信建置（original 與 usage 的 ranges；Jenkins RangeSet 的 end 不含）。
 * 只保留名稱以 prefix 開頭的 job；去重後依 job 名稱、建置編號由新到舊排序，最多取 max 筆（超過時 truncated）。
 * @returns {{refs: {job:string, number:number}[], truncated: boolean, untrusted: number}}
 */
export function buildRefsFromFingerprint(json, { prefix = TRUSTED_JOB_PREFIX, max = MAX_BUILDS } = {}) {
  const seen = new Map();
  let untrusted = 0;
  let budget = max * 10; // 防止極大的 range 造成大量迭代
  const add = (job, number) => {
    if (!isJobName(job) || !Number.isSafeInteger(number) || number < 1) return;
    if (!job.startsWith(prefix)) { untrusted++; return; }
    seen.set(`${job}#${number}`, { job, number });
  };
  if (json && typeof json === 'object') {
    const o = json.original;
    if (o && typeof o === 'object') add(o.name, o.number);
    for (const u of Array.isArray(json.usage) ? json.usage : []) {
      const ranges = Array.isArray(u?.ranges?.ranges) ? u.ranges.ranges : [];
      for (const r of ranges) {
        const start = r?.start;
        const end = r?.end;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) continue;
        // 由最新往回取，超過預算時捨棄最舊者。
        for (let n = end - 1; n >= start && budget > 0; n--, budget--) add(u?.name, n);
      }
    }
  }
  const refs = [...seen.values()].sort((a, b) => (a.job === b.job ? b.number - a.number : a.job < b.job ? -1 : 1));
  return { refs: refs.slice(0, max), truncated: refs.length > max || budget <= 0, untrusted };
}

/** 紀錄結構有效，且 build.job／build.number 與 fingerprint 來源建置相同（避免封存檔與建置不符）。 */
export function isConsistentRecord(record, ref) {
  if (!validateRecord(record).ok) return false;
  return record.build?.job === ref.job && Number(record.build?.number) === ref.number;
}

async function readCapped(res, limit) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => {}); throw new LookupError('Jenkins 回應過大'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** GET JSON；404 回傳 null，其他非 2xx、重新導向、逾時或非 JSON 拋出 LookupError。 */
async function getJson(url, { auth, fetchImpl, deadline }) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new LookupError('Jenkins 查詢逾時');
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: auth, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
    });
  } catch (e) {
    throw new LookupError(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'Jenkins 查詢逾時' : '無法連線至 Jenkins');
  }
  if (res.status === 404) { await res.body?.cancel?.()?.catch?.(() => {}); return null; }
  if (res.status === 401 || res.status === 403) throw new LookupError('Jenkins 認證失敗或權限不足');
  if (res.status >= 300 && res.status < 400) throw new LookupError('Jenkins 回應重新導向（不跟隨）');
  if (res.status < 200 || res.status >= 300) throw new LookupError(`Jenkins 回應 HTTP ${res.status}`);
  let text;
  try { text = await readCapped(res, MAX_RESPONSE_BYTES); } catch (e) {
    throw e instanceof LookupError ? e : new LookupError('讀取 Jenkins 回應失敗');
  }
  try { return JSON.parse(text); } catch { throw new LookupError('Jenkins 回應不是有效的 JSON'); }
}

/**
 * 以 Image_Digest 查詢 Build_Record。
 * @returns {Promise<{found:boolean, digest:string, records:object[], reason?:string,
 *   skipped:{untrusted:number, missing:number, inconsistent:number, truncated:boolean}}>}
 * @throws {TypeError} 參數錯誤；{LookupError} Jenkins 查詢失敗
 */
export async function lookupDigest(digest, {
  baseUrl, user, token, recordArtifact = DEFAULT_RECORD_ARTIFACT, prefix = TRUSTED_JOB_PREFIX,
  allowLoopbackHttp = false, fetchImpl = fetch, totalTimeoutMs = TOTAL_TIMEOUT_MS, keepRecords = false,
} = {}) {
  if (!isDigest(digest)) throw new TypeError('Image_Digest 格式無效');
  const base = parseJenkinsBase(baseUrl, { allowLoopbackHttp });
  if (typeof user !== 'string' || user === '' || /[:\r\n]/.test(user)) throw new TypeError('LM_JENKINS_API_USER 未設定或無效');
  if (typeof token !== 'string' || token === '' || /[\r\n]/.test(token)) throw new TypeError('LM_JENKINS_API_TOKEN 未設定或無效');
  if (!ARTIFACT_RE.test(recordArtifact)) throw new TypeError('record artifact 路徑無效');
  const auth = `Basic ${Buffer.from(`${user}:${token}`, 'utf8').toString('base64')}`;
  const ctx = { auth, fetchImpl, deadline: Date.now() + totalTimeoutMs };
  const skipped = { untrusted: 0, missing: 0, inconsistent: 0, truncated: false };
  const notFound = () => ({ found: false, digest, records: [], reason: NOT_FOUND_REASON, skipped });

  const id = fingerprintId(digest);
  const tree = 'hash,original[name,number],usage[name,ranges[ranges[start,end]]]';
  const fp = await getJson(new URL(`fingerprint/${id}/api/json?tree=${encodeURIComponent(tree)}`, base).toString(), ctx);
  if (fp === null) return notFound();
  if (!fp || typeof fp !== 'object' || (fp.hash !== undefined && fp.hash !== id)) {
    throw new LookupError('fingerprint 回應格式無效');
  }

  const { refs, truncated, untrusted } = buildRefsFromFingerprint(fp, { prefix });
  Object.assign(skipped, { untrusted, truncated });
  const artifactPath = recordArtifact.split('/').map(encodeURIComponent).join('/');
  const records = [];
  for (const ref of refs) {
    const url = new URL(`${jobPath(ref.job)}${ref.number}/artifact/${artifactPath}`, base).toString();
    const rec = await getJson(url, ctx);
    if (rec === null) { skipped.missing++; continue; }
    if (!isConsistentRecord(rec, ref)) { skipped.inconsistent++; continue; }
    records.push({ ref, rec });
  }

  const res = lookupByDigest(records.map((r) => r.rec), digest);
  if (!res.found) return notFound();
  const summaries = res.records.map((rec) => {
    const ref = records.find((r) => r.rec === rec).ref;
    return { ...auditSummary(rec), url: new URL(`${jobPath(ref.job)}${ref.number}/`, base).toString() };
  });
  const result = { found: true, digest, records: summaries, skipped };
  // 完整紀錄只在呼叫端明確要求時回傳（不可列舉，不會出現在 JSON 輸出或主控台）。
  if (keepRecords) {
    Object.defineProperty(result, 'full', {
      value: records.filter((r) => res.records.includes(r.rec)), enumerable: false,
    });
  }
  return result;
}

export const MAIN_JOB = `${TRUSTED_JOB_PREFIX}main`;

/**
 * 由查得的 Build_Record 中選出「產生該 digest 的 main 建置」（Release_Tag 的「映像」關卡用來確認 SBOM，Design §17）：
 * job 為 release/little-moments/main、source.trigger 為 main_push、source.commit 與 image.digest 皆相符；
 * 多筆時取建置編號最大者。沒有相符者回傳 null。
 * @param {{ref:{job:string, number:number}, rec:object}[]} entries
 */
export function selectMainRecord(entries, { commit, digest }) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? '') || !isDigest(digest)) return null;
  let best = null;
  for (const e of Array.isArray(entries) ? entries : []) {
    const r = e?.rec;
    if (e?.ref?.job !== MAIN_JOB || r?.build?.job !== MAIN_JOB || Number(r?.build?.number) !== e.ref.number) continue;
    if (r?.source?.trigger !== 'main_push' || r.source.ref !== 'main' || r.source.commit !== commit || r?.image?.digest !== digest) continue;
    if (!best || e.ref.number > best.ref.number) best = e;
  }
  return best ? best.rec : null;
}

/** 主控台顯示文字（Req 21.7、21.8）。 */
export function formatResult(result) {
  const lines = [`Image_Digest：${result.digest}`];
  if (!result.found) {
    lines.push(`結果：${result.reason ?? NOT_FOUND_REASON}（未回傳任何其他 Image_Digest 的 Build_Record）`);
  } else {
    lines.push(`結果：找到 ${result.records.length} 筆 Build_Record`);
    for (const s of result.records) {
      lines.push(
        '',
        `建置：${s.build}`,
        `  Commit SHA：${s.commit}`,
        `  Release_Tag：${s.releaseTag}`,
        `  核准人：${s.approver}`,
        `  核准時間：${s.approvedAt}`,
        `  Production 部署時間：${s.productionDeployedAt}`,
        `  連結：${s.url}`,
      );
    }
  }
  const k = result.skipped ?? {};
  const notes = [];
  if (k.untrusted) notes.push(`忽略 ${k.untrusted} 個非 ${TRUSTED_JOB_PREFIX} 建置`);
  if (k.missing) notes.push(`${k.missing} 個建置已無 Build_Record`);
  if (k.inconsistent) notes.push(`${k.inconsistent} 個 Build_Record 結構無效或與建置不符`);
  if (k.truncated) notes.push(`使用紀錄超過 ${MAX_BUILDS} 個建置，只查詢最新者`);
  if (notes.length) lines.push('', `附註：${notes.join('；')}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const known = new Set(['--digest', '--out', '--record-artifact', '--commit', '--main-record-out']);
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!known.has(argv[i]) || argv[i + 1] === undefined) return null;
    out[argv[i].slice(2)] = argv[i + 1];
  }
  if (out.digest === undefined) return null;
  // --main-record-out 與 --commit 必須一起提供。
  if ((out['main-record-out'] === undefined) !== (out.commit === undefined)) return null;
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
  env = process.env, log = console.log, error = console.error, fetchImpl = fetch,
} = {}) {
  const args = parseArgs(argv);
  if (!args) {
    error('用法：bun ci/digest-lookup.mjs --digest sha256:<64 hex> [--out <result.json>] [--record-artifact <path>]');
    return EXIT.USAGE;
  }
  let token = env.LM_JENKINS_API_TOKEN;
  if ((token === undefined || token === '') && env.LM_JENKINS_API_TOKEN_FILE) {
    try { token = readFileSync(env.LM_JENKINS_API_TOKEN_FILE, 'utf8').replace(/\r?\n$/, ''); } catch {
      error('參數錯誤：無法讀取 LM_JENKINS_API_TOKEN_FILE');
      return EXIT.USAGE;
    }
  }
  const secrets = typeof token === 'string' && token !== '' ? { LM_JENKINS_API_TOKEN: token } : {};
  // 任何輸出前確認不含 token（原文、Base64、URL 編碼）；命中時不輸出。
  const safe = (text) => (findLeaks(text, secrets).length ? null : text);

  let result;
  try {
    result = await lookupDigest(args.digest, {
      baseUrl: env.JENKINS_URL,
      user: env.LM_JENKINS_API_USER,
      token,
      recordArtifact: args['record-artifact'] ?? DEFAULT_RECORD_ARTIFACT,
      allowLoopbackHttp: env.LM_LOOKUP_ALLOW_LOOPBACK_HTTP === '1',
      fetchImpl,
      keepRecords: args['main-record-out'] !== undefined,
    });
  } catch (e) {
    if (e instanceof LookupError) { error(`Jenkins 查詢失敗：${e.message}（不視為查無）`); return EXIT.QUERY_ERROR; }
    if (e instanceof TypeError) { error(`參數錯誤：${e.message}`); return EXIT.USAGE; }
    error('Jenkins 查詢失敗：未預期的錯誤（不視為查無）');
    return EXIT.QUERY_ERROR;
  }

  const json = safe(JSON.stringify(result, null, 2) + '\n');
  const text = safe(formatResult(result));
  if (json === null || text === null) { error('查詢結果疑似含有憑證，不輸出'); return EXIT.QUERY_ERROR; }
  if (args.out) {
    try { writeAtomic(args.out, json); } catch { error('無法寫入查詢結果檔'); return EXIT.USAGE; }
  }
  log(text);
  if (args['main-record-out'] !== undefined) {
    // Release_Tag 的「映像」關卡：只輸出產生該 digest 的 main 建置之 Build_Record（已通過白名單驗證）。
    const rec = result.found ? selectMainRecord(result.full, { commit: args.commit, digest: args.digest }) : null;
    if (!rec) { error('查無產生該 Image_Digest 的 main 建置 Build_Record'); return EXIT.NOT_FOUND; }
    const recJson = safe(JSON.stringify(rec, null, 2) + '\n');
    if (recJson === null) { error('Build_Record 疑似含有憑證，不輸出'); return EXIT.QUERY_ERROR; }
    try { writeAtomic(args['main-record-out'], recJson); } catch { error('無法寫入 main Build_Record'); return EXIT.USAGE; }
    return EXIT.FOUND;
  }
  return result.found ? EXIT.FOUND : EXIT.NOT_FOUND;
}

const isMain = import.meta.main
  ?? (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) process.exitCode = await main();
