// Release_Tag 的 Image_Digest 解析與版本標籤
// （Requirements 1.4、1.10、16.6、16.10、17.7、19.5、20.1；Design Components §17、Property 47）。
//
// Release_Tag 建置不重新建置 App_Image，而是以 `main` 建置推送的「40 字元完整 Commit SHA」標籤
// 找回 Image_Digest，再依序評估：
//   1. Resolve Digest：完整 SHA 標籤是否存在（不存在 → 「查無 Image_Digest」，Req 1.10；
//      Registry 其他錯誤 → 「Registry 查詢失敗」，不視為查無）
//   2. 「映像」關卡：cosign 簽章驗證通過，且 `main` 的 Build_Record 已記錄 SBOM 與相同 commit
//   3. 版本標籤：不存在 → 建立；指向相同 digest → 不動作；指向不同 digest → 拒絕覆寫（Req 16.10）
//   4. 「Staging」關卡：staging-verified attestation 的 commit 與 digest 相符（Req 19.5）
// 後續核准與 Production 部署一律使用回傳的 `repo@sha256:…`（Req 17.7、20.1）。
//
// 純函式（輸入皆為已蒐集的事實，不做 I/O）：
//   classifyCraneDigest(result)                       → {kind:'found',digest} | {kind:'not_found'} | {kind:'error',reason}
//   resolveReleaseDigest(facts, { through })          → {ok:true,digest} | {ok:false,gate,stage,reason,code}
//   versionTagDecision(existingDigest, digest)        → 'create' | 'noop' | 'conflict'
//   checkSignatureOutput(stdout, digest)              → boolean
//   checkStagingAttestation(stdout, {commit,digest,predicateType}) → boolean
//   checkMainRecord(record, {commit,digest})          → boolean
//
// CLI：
//   bun ci/resolve-digest.mjs --repo <registry/name> --commit <40 hex> --tag <vX.Y.Z> \
//       --key <cosign.pub> --main-record <main build-record.json> [--predicate-type <URI>]
//   成功時於 stdout 輸出 JSON；失敗時於 stderr 輸出 JSON（含 gate、stage、reason）。
//   結束碼：0 通過；1 查無 Image_Digest；2 Registry 查詢失敗；3 「映像」關卡未通過；
//           4 版本標籤衝突（拒絕覆寫）；5 「Staging」關卡未通過；6 參數錯誤；7 無法執行外部工具。
//
// 外部工具假設（本機未安裝 crane／cosign，以下依官方文件與實際錯誤格式撰寫）：
//   - crane 對所有錯誤皆以結束碼 1 結束，因此「查無」須以 stderr 判斷：OCI Distribution 錯誤碼
//     `MANIFEST_UNKNOWN`，或 HEAD 請求無 body 時的 `unexpected status code 404`。
//     `NAME_UNKNOWN`（repository 不存在）、401/403、5xx、網路錯誤皆視為 Registry 查詢失敗
//     （fail closed：設定錯誤不應被誤判為「該 commit 沒有映像」）。
//   - cosign v2 以金鑰模式且簽章時 `--tlog-upload=false`，驗證時需 `--insecure-ignore-tlog=true`；
//     `cosign verify` 在 stdout 輸出 JSON 陣列，`cosign verify-attestation` 每行輸出一個 DSSE envelope。
//   - Registry 憑證只經由 docker config（`DOCKER_CONFIG`／`~/.docker/config.json`）提供給 crane／cosign，
//     本腳本不接受任何憑證參數，也不輸出外部工具的原始 stderr。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReleaseTag } from './policy/tag.mjs';

export const STAGING_PREDICATE_TYPE = 'https://little-moments.lan/attestations/staging-verified/v1';

export const EXIT = Object.freeze({
  OK: 0,
  NOT_FOUND: 1,
  REGISTRY_ERROR: 2,
  IMAGE_GATE: 3,
  TAG_CONFLICT: 4,
  STAGING_GATE: 5,
  USAGE: 6,
  TOOL: 7,
});

export const REASONS = Object.freeze({
  NOT_FOUND: '查無 Image_Digest',
  REGISTRY_ERROR: 'Registry 查詢失敗',
  SIGNATURE: '簽章驗證未通過',
  SBOM: 'main Build_Record 未記錄 SBOM 或 commit／digest 不符',
  TAG_CONFLICT: '版本標籤已指向不同的 Image_Digest，拒絕覆寫',
  STAGING: '缺少 Staging 驗證',
});

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
// registry 主機（可含連接埠）+ 一或多段小寫 repository 路徑；不得以 '-' 開頭，不含 tag 或 digest。
const REPO_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::\d{1,5})?(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)+$/;

export function isDigest(value) {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

/**
 * 將 `crane digest` 的執行結果分類。
 * @param {{status:number|null, stdout?:string, stderr?:string, error?:unknown}} result
 */
export function classifyCraneDigest(result) {
  if (!result || result.error) return { kind: 'error', reason: '無法執行 crane' };
  const stdout = String(result.stdout ?? '').trim();
  const stderr = String(result.stderr ?? '');
  if (result.status === 0) {
    return isDigest(stdout) ? { kind: 'found', digest: stdout } : { kind: 'error', reason: 'crane 回傳無效的 digest' };
  }
  if (/\bMANIFEST_UNKNOWN\b/.test(stderr) || /unexpected status code 404\b/.test(stderr)) {
    return { kind: 'not_found' };
  }
  if (/\b(UNAUTHORIZED|DENIED)\b|status code 40[13]\b/.test(stderr)) return { kind: 'error', reason: '認證失敗' };
  if (/\bNAME_UNKNOWN\b/.test(stderr)) return { kind: 'error', reason: 'repository 不存在' };
  if (/status code 5\d\d\b/.test(stderr)) return { kind: 'error', reason: 'Registry 伺服器錯誤' };
  return { kind: 'error', reason: '連線或其他錯誤' };
}

const STEPS = ['lookup', 'image', 'staging'];

/**
 * 依序評估 Release_Tag 的 digest 解析與關卡；第一個未通過的條件決定結果。
 * 未提供（undefined）的事實一律視為未通過（fail closed）。
 *
 * @param {{
 *   commit: string,
 *   shaTagDigest: {kind:'found',digest:string}|{kind:'not_found'}|{kind:'error',reason?:string},
 *   signatureOk?: boolean, sbomRecorded?: boolean, stagingVerified?: boolean,
 * }} facts
 * @param {{through?: 'lookup'|'image'|'staging'}} [options] 評估到哪一步為止（CLI 分段蒐集事實時使用）
 */
export function resolveReleaseDigest(facts, { through = 'staging' } = {}) {
  const last = STEPS.indexOf(through);
  if (last < 0) throw new RangeError(`未知的評估步驟 ${through}`);
  const { commit, shaTagDigest, signatureOk, sbomRecorded, stagingVerified } = facts ?? {};
  const fail = (gate, stage, reason, code, extra = {}) => ({ ok: false, gate, stage, reason, code, ...extra });

  if (typeof commit !== 'string' || !COMMIT_RE.test(commit)) {
    return fail('Resolve Digest', 'Resolve Digest', 'commit SHA 格式無效', EXIT.USAGE);
  }
  // 1. 完整 SHA 標籤（Req 1.10）：於核准前失敗
  if (shaTagDigest?.kind === 'not_found') {
    return fail('Resolve Digest', 'Resolve Digest', `${REASONS.NOT_FOUND}：commit ${commit} 查無由 main 建置產生的 Image_Digest`, EXIT.NOT_FOUND);
  }
  if (shaTagDigest?.kind !== 'found' || !isDigest(shaTagDigest.digest)) {
    const detail = shaTagDigest?.kind === 'error' && shaTagDigest.reason ? `：${shaTagDigest.reason}` : '';
    return fail('Resolve Digest', 'Resolve Digest', `${REASONS.REGISTRY_ERROR}${detail}`, EXIT.REGISTRY_ERROR);
  }
  const digest = shaTagDigest.digest;
  if (last < 1) return { ok: true, digest };

  // 2. 「映像」關卡（Req 1.4、23.2）
  if (signatureOk !== true) return fail('映像', 'Verify Image', REASONS.SIGNATURE, EXIT.IMAGE_GATE, { digest });
  if (sbomRecorded !== true) return fail('映像', 'Verify Image', REASONS.SBOM, EXIT.IMAGE_GATE, { digest });
  if (last < 2) return { ok: true, digest };

  // 3. 「Staging」關卡（Req 19.5）
  if (stagingVerified !== true) return fail('Staging', 'Verify Staging', REASONS.STAGING, EXIT.STAGING_GATE, { digest });
  return { ok: true, digest };
}

/**
 * 版本標籤決策：絕不覆寫指向不同 digest 的既有標籤（Req 16.10）。
 * @param {string|null|undefined} existingDigest 既有版本標籤指向的 digest；不存在為 null
 * @param {string} digest
 * @returns {'create'|'noop'|'conflict'}
 */
export function versionTagDecision(existingDigest, digest) {
  if (!isDigest(digest)) throw new TypeError('digest 格式無效');
  if (existingDigest === null || existingDigest === undefined) return 'create';
  return existingDigest === digest ? 'noop' : 'conflict';
}

/** `cosign verify` 的 stdout（JSON 陣列）中至少一筆簽章對象為該 digest。 */
export function checkSignatureOutput(stdout, digest) {
  if (!isDigest(digest)) return false;
  let entries;
  try {
    entries = JSON.parse(String(stdout ?? '').trim());
  } catch {
    return false;
  }
  if (!Array.isArray(entries) || entries.length === 0) return false;
  return entries.some(e => e?.critical?.image?.['docker-manifest-digest'] === digest);
}

/**
 * `cosign verify-attestation` 的 stdout（每行一個 DSSE envelope）中，至少一筆 in-toto statement
 * 的 predicateType 正確、subject 包含該 digest，且 predicate.commit 等於 Tag commit、smoke 為 pass。
 */
export function checkStagingAttestation(stdout, { commit, digest, predicateType = STAGING_PREDICATE_TYPE }) {
  if (!isDigest(digest) || typeof commit !== 'string' || !COMMIT_RE.test(commit)) return false;
  const hex = digest.slice('sha256:'.length);
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const envelope = JSON.parse(line);
      if (typeof envelope?.payload !== 'string') continue;
      const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
      if (statement?.predicateType !== predicateType) continue;
      const subjects = Array.isArray(statement.subject) ? statement.subject : [];
      if (!subjects.some(s => s?.digest?.sha256 === hex)) continue;
      const p = statement.predicate;
      if (p?.commit === commit && p?.smoke === 'pass') return true;
    } catch {
      // 無法解析的行不計入（fail closed）
    }
  }
  return false;
}

const NOT_PRODUCED = new Set(['', '不適用', '未執行']);

/** `main` 的 Build_Record 是否記錄相同 commit 與 digest，且已封存 SBOM。 */
export function checkMainRecord(record, { commit, digest }) {
  if (!record || typeof record !== 'object') return false;
  const sbom = record.reports?.sbom;
  return record.source?.trigger === 'main_push'
    && record.source?.commit === commit
    && record.image?.digest === digest
    && typeof sbom === 'string' && !NOT_PRODUCED.has(sbom.trim());
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const known = new Set(['--repo', '--commit', '--tag', '--key', '--main-record', '--predicate-type']);
  const out = { predicateType: STAGING_PREDICATE_TYPE };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!known.has(flag) || value === undefined) return null;
    const key = flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = value;
  }
  for (const k of ['repo', 'commit', 'tag', 'key', 'mainRecord']) if (!out[k]) return null;
  return out;
}

function validateArgs(args) {
  if (!REPO_RE.test(args.repo) || args.repo.length > 255) return 'repository 名稱格式無效';
  if (!COMMIT_RE.test(args.commit)) return 'commit 必須為 40 字元小寫十六進位';
  if (!parseReleaseTag(args.tag)) return 'Release_Tag 格式不符 v<major>.<minor>.<patch>';
  if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(args.predicateType)) return 'predicate type 格式無效';
  for (const [name, p] of [['key', args.key], ['main-record', args.mainRecord]]) {
    if (p.startsWith('-')) return `${name} 路徑無效`;
    const abs = resolve(p);
    if (!existsSync(abs) || !statSync(abs).isFile()) return `${name} 檔案不存在`;
  }
  return null;
}

function run(spawn, cmd, args) {
  // 陣列參數、不經 shell；環境變數沿用（DOCKER_CONFIG 提供 Registry 憑證）。
  return spawn(cmd, args, { shell: false, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
}

// ---------------------------------------------------------------- 分段 CLI（根目錄 Jenkinsfile 使用）
//
// Jenkinsfile 的 Agent 上沒有 Bun，Build_Image 內沒有 crane／cosign（也沒有 Registry 憑證）：crane／cosign 以
// 只讀 digest 固定的工具容器在 Agent 上執行並保存結束碼與輸出，再由本段在 Build_Image 內以上面的純函式判讀。
// 判讀順序與 resolveReleaseDigest 相同：lookup →「映像」關卡 →「Staging」關卡；每一步都要求前一步的結果檔通過。
//   bun ci/resolve-digest.mjs step lookup --commit <sha> --exit <n> --stdout <f> --stderr <f> --out <f>
//       0 查得；1 查無 Image_Digest（Req 1.10）；2 Registry 查詢失敗
//   bun ci/resolve-digest.mjs step image --commit <sha> --lookup <lookup.json> --signature-exit <n> --signature <f>
//       --main-record <f> --out-gate <gate.json>                                       0 通過；3 未通過
//   bun ci/resolve-digest.mjs step staging --commit <sha> --lookup <lookup.json> --image-gate <gate.json>
//       --attestation-exit <n> --attestation <f> --out-gate <gate.json>                0 通過；5 未通過
//   bun ci/resolve-digest.mjs step version-tag --digest <d> --exit <n> --stdout <f> --stderr <f> --out <f>
//       0 create／noop；4 conflict（拒絕覆寫）；2 Registry 查詢失敗
//   bun ci/resolve-digest.mjs step version-tag-verify --digest <d> --exit <n> --stdout <f> --stderr <f>
//       0 標籤指向該 digest；4 其他
// 關卡結果檔為 ci/record.mjs gate 的輸入：{ gate, pass, status, commit, unmet, reports }。

const STEP_COMMANDS = new Set(['lookup', 'image', 'staging', 'version-tag', 'version-tag-verify']);

function parseStepArgs(argv) {
  const [, cmd, ...rest] = argv;
  if (!STEP_COMMANDS.has(cmd)) return null;
  const opts = { cmd };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    if (!flag?.startsWith('--') || rest[i + 1] === undefined) return null;
    const key = flag.slice(2);
    if (!/^[a-z][a-z-]*$/.test(key) || key in opts) return null;
    opts[key] = rest[i + 1];
  }
  return opts;
}

const exitArg = (v) => (typeof v === 'string' && /^\d{1,3}$/.test(v) ? Number(v) : null);

function gateResult(gate, commit, unmet, reports) {
  return { gate, pass: unmet.length === 0, status: unmet.length === 0 ? 'pass' : 'fail', commit, unmet, reports };
}

/** 前一步的結果檔：lookup 成功且 commit 相同 → digest；否則 null。 */
function lookupDigest(doc, commit) {
  return doc && doc.ok === true && doc.commit === commit && isDigest(doc.digest) ? doc.digest : null;
}

export function stepMain(argv, { log, error, readFile, writeFile }) {
  const o = parseStepArgs(argv);
  const usage = () => { error('用法：bun ci/resolve-digest.mjs step lookup|image|staging|version-tag|version-tag-verify …（見檔頭說明）'); return EXIT.USAGE; };
  if (!o) return usage();
  const read = (p) => { try { return readFile(resolve(p), 'utf8'); } catch { return ''; } };
  const readJson = (p) => { try { return JSON.parse(readFile(resolve(p), 'utf8')); } catch { return null; } };
  const write = (p, v) => writeFile(resolve(p), JSON.stringify(v, null, 2) + '\n');
  const crane = () => {
    const status = exitArg(o.exit);
    return status === null ? null : classifyCraneDigest({ status, stdout: read(o.stdout), stderr: read(o.stderr) });
  };
  switch (o.cmd) {
    case 'lookup': {
      const result = crane();
      if (!result || !o.out || !o.stdout || !o.stderr) return usage();
      const r = resolveReleaseDigest({ commit: o.commit, shaTagDigest: result }, { through: 'lookup' });
      const out = r.ok ? { ok: true, commit: o.commit, digest: r.digest } : { ok: false, commit: o.commit ?? null, stage: r.stage, gate: r.gate, reason: r.reason, code: r.code };
      write(o.out, out);
      (r.ok ? log : error)(JSON.stringify(out));
      return r.ok ? EXIT.OK : r.code;
    }
    case 'image': {
      const sigExit = exitArg(o['signature-exit']);
      if (!COMMIT_RE.test(o.commit ?? '') || !o.lookup || sigExit === null || !o.signature || !o['main-record'] || !o['out-gate']) return usage();
      const digest = lookupDigest(readJson(o.lookup), o.commit);
      const facts = { commit: o.commit, shaTagDigest: digest ? { kind: 'found', digest } : { kind: 'error', reason: 'lookup 結果缺失' } };
      facts.signatureOk = !!digest && sigExit === 0 && checkSignatureOutput(read(o.signature), digest);
      facts.sbomRecorded = !!digest && checkMainRecord(readJson(o['main-record']), { commit: o.commit, digest });
      const r = resolveReleaseDigest(facts, { through: 'image' });
      const unmet = [];
      if (!digest) unmet.push('未查得 Image_Digest');
      else {
        if (!facts.signatureOk) unmet.push(`${REASONS.SIGNATURE}（Registry 中沒有可以設定的公鑰驗證、且對象為該 Image_Digest 的簽章）`);
        if (!facts.sbomRecorded) unmet.push(REASONS.SBOM);
      }
      const gate = gateResult('映像', o.commit, r.ok ? [] : (unmet.length ? unmet : [r.reason]), ['reports/release/signature.json', 'reports/release/main-build-record.json']);
      write(o['out-gate'], gate);
      log(JSON.stringify({ pass: gate.pass, unmet: gate.unmet }));
      return gate.pass ? EXIT.OK : EXIT.IMAGE_GATE;
    }
    case 'staging': {
      const attExit = exitArg(o['attestation-exit']);
      if (!COMMIT_RE.test(o.commit ?? '') || !o.lookup || !o['image-gate'] || attExit === null || !o.attestation || !o['out-gate']) return usage();
      const digest = lookupDigest(readJson(o.lookup), o.commit);
      const image = readJson(o['image-gate']);
      const imageOk = !!image && image.gate === '映像' && image.pass === true && image.commit === o.commit;
      const facts = {
        commit: o.commit,
        shaTagDigest: digest ? { kind: 'found', digest } : { kind: 'error', reason: 'lookup 結果缺失' },
        signatureOk: imageOk, sbomRecorded: imageOk,
        stagingVerified: !!digest && attExit === 0
          && checkStagingAttestation(read(o.attestation), { commit: o.commit, digest, predicateType: STAGING_PREDICATE_TYPE }),
      };
      const r = resolveReleaseDigest(facts);
      const unmet = [];
      if (!digest) unmet.push('未查得 Image_Digest');
      else if (!imageOk) unmet.push('「映像」關卡未通過或結果缺失');
      else if (!facts.stagingVerified) unmet.push(`${REASONS.STAGING}：該 Image_Digest 沒有 commit 相符且 Smoke_Test 通過的 staging-verified attestation（Req 19.5）`);
      const gate = gateResult('Staging', o.commit, r.ok ? [] : (unmet.length ? unmet : [r.reason]), ['reports/release/staging-attestation.jsonl']);
      write(o['out-gate'], gate);
      log(JSON.stringify({ pass: gate.pass, unmet: gate.unmet }));
      return gate.pass ? EXIT.OK : EXIT.STAGING_GATE;
    }
    case 'version-tag': {
      const existing = crane();
      if (!existing || !isDigest(o.digest) || !o.out || !o.stdout || !o.stderr) return usage();
      let out;
      if (existing.kind === 'error') out = { decision: 'error', reason: `${REASONS.REGISTRY_ERROR}：${existing.reason}` };
      else {
        const decision = versionTagDecision(existing.kind === 'found' ? existing.digest : null, o.digest);
        out = { decision, ...(decision === 'conflict' ? { existingDigest: existing.digest, reason: REASONS.TAG_CONFLICT } : {}) };
      }
      write(o.out, out);
      log(JSON.stringify(out));
      if (out.decision === 'error') return EXIT.REGISTRY_ERROR;
      return out.decision === 'conflict' ? EXIT.TAG_CONFLICT : EXIT.OK;
    }
    case 'version-tag-verify': {
      const after = crane();
      if (!after || !isDigest(o.digest)) return usage();
      const ok = after.kind === 'found' && after.digest === o.digest;
      log(JSON.stringify({ ok }));
      return ok ? EXIT.OK : EXIT.TAG_CONFLICT;
    }
    default:
      return usage();
  }
}

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error, spawn = spawnSync, readFile = readFileSync, writeFile = writeFileSync } = {}) {
  if (argv[0] === 'step') return stepMain(argv, { log, error, readFile, writeFile });
  const report = (obj, code) => {
    (code === 0 ? log : error)(JSON.stringify(obj));
    return code;
  };
  const args = parseArgs(argv);
  if (!args) {
    error('用法：bun ci/resolve-digest.mjs --repo <registry/name> --commit <40 hex> --tag <vX.Y.Z> --key <cosign.pub> --main-record <build-record.json> [--predicate-type <URI>]');
    return EXIT.USAGE;
  }
  const invalid = validateArgs(args);
  if (invalid) return report({ ok: false, stage: 'Resolve Digest', reason: invalid }, EXIT.USAGE);

  const { repo, commit, tag, predicateType } = args;
  const key = resolve(args.key);
  const base = { tag, commit, repo };
  const fail = r => report({ ...base, ...r }, r.code);

  // 1. 完整 SHA 標籤 → digest
  const facts = { commit, shaTagDigest: classifyCraneDigest(run(spawn, 'crane', ['digest', `${repo}:${commit}`])) };
  let r = resolveReleaseDigest(facts, { through: 'lookup' });
  if (!r.ok) return fail(r);
  const digest = r.digest;
  const ref = `${repo}@${digest}`;

  // 2. 「映像」關卡：簽章 + main Build_Record 的 SBOM
  const sig = run(spawn, 'cosign', ['verify', '--key', key, '--insecure-ignore-tlog=true', '--output', 'json', ref]);
  if (sig.error) return report({ ...base, digest, ok: false, stage: 'Verify Image', reason: '無法執行 cosign' }, EXIT.TOOL);
  facts.signatureOk = sig.status === 0 && checkSignatureOutput(sig.stdout, digest);
  try {
    facts.sbomRecorded = checkMainRecord(JSON.parse(readFile(resolve(args.mainRecord), 'utf8')), { commit, digest });
  } catch {
    facts.sbomRecorded = false;
  }
  r = resolveReleaseDigest(facts, { through: 'image' });
  if (!r.ok) return fail(r);

  // 3. 版本標籤（不覆寫）
  const existing = classifyCraneDigest(run(spawn, 'crane', ['digest', `${repo}:${tag}`]));
  if (existing.kind === 'error') {
    return report({ ...base, digest, ok: false, stage: 'Version Tag', reason: `${REASONS.REGISTRY_ERROR}：${existing.reason}` }, EXIT.REGISTRY_ERROR);
  }
  const decision = versionTagDecision(existing.kind === 'found' ? existing.digest : null, digest);
  if (decision === 'conflict') {
    return report({ ...base, digest, existingDigest: existing.digest, ok: false, stage: 'Version Tag', reason: REASONS.TAG_CONFLICT }, EXIT.TAG_CONFLICT);
  }
  if (decision === 'create') {
    const tagged = run(spawn, 'crane', ['tag', ref, tag]);
    if (tagged.error) return report({ ...base, digest, ok: false, stage: 'Version Tag', reason: '無法執行 crane' }, EXIT.TOOL);
    if (tagged.status !== 0) {
      return report({ ...base, digest, ok: false, stage: 'Version Tag', reason: `${REASONS.REGISTRY_ERROR}：crane tag 失敗` }, EXIT.REGISTRY_ERROR);
    }
    // 檢查與寫入之間可能有競態：寫入後再次確認標籤指向本 digest
    const after = classifyCraneDigest(run(spawn, 'crane', ['digest', `${repo}:${tag}`]));
    if (after.kind !== 'found' || after.digest !== digest) {
      return report({ ...base, digest, ok: false, stage: 'Version Tag', reason: REASONS.TAG_CONFLICT }, EXIT.TAG_CONFLICT);
    }
  }

  // 4. 「Staging」關卡：staging-verified attestation
  const att = run(spawn, 'cosign', ['verify-attestation', '--key', key, '--insecure-ignore-tlog=true', '--type', predicateType, ref]);
  if (att.error) return report({ ...base, digest, ok: false, stage: 'Verify Staging', reason: '無法執行 cosign' }, EXIT.TOOL);
  facts.stagingVerified = att.status === 0 && checkStagingAttestation(att.stdout, { commit, digest, predicateType });
  r = resolveReleaseDigest(facts);
  if (!r.ok) return fail(r);

  return report({ ...base, ok: true, digest, ref, versionTag: decision }, EXIT.OK);
}

const isMain = import.meta.main
  ?? (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) process.exit(main());
