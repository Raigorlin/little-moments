#!/usr/bin/env bun
// 本機重現 Jenkins「安全」關卡的 Gitleaks 部分（design.md Components 第 27.5、31 節）。
//
//   bun scripts/gitleaks-check.mjs [--commit <rev>] [--range <a..b | sha>]
//
// 下載 Gitleaks 8.30.1（與 Jenkinsfile 的 ghcr.io/gitleaks/gitleaks:v8.30.1 同版本），以釘選的 SHA-256
// 驗證後，依 Jenkinsfile 的 prepareScanSources 匯出建置 commit 的受版本控制檔案（刪除 repo 內的掃描器設定）
// 並建立只含該 commit 的 bare repository，執行 `gitleaks dir` 與 `gitleaks git`，再以 ci/policy/normalize.mjs
// 與 ci/policy/evaluate.mjs（security/exceptions.json）評估。預設歷史範圍為 `<LM_GITLEAKS_HISTORY_BASE>..<sha>`
// （沒有上次成功建置時 CI 使用的範圍，也是它可能使用的最大範圍）；--range 用於審查新起點。
// 只輸出規則、檔案、行號與 commit，不輸出原始報告。
//
// 結束碼：0 通過、1 不通過、2 無法執行或無法評估。
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const GITLEAKS_VERSION = '8.30.1';
const RELEASE = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/`;
// 來源：上游發行的 gitleaks_8.30.1_checksums.txt；下載後重新計算並比對。
export const ASSETS = {
  linux: { name: `gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz`, sha256: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb', bin: 'gitleaks' },
  win32: { name: `gitleaks_${GITLEAKS_VERSION}_windows_x64.zip`, sha256: 'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e', bin: 'gitleaks.exe' },
};
// 與 Jenkinsfile「export scan sources」刪除的檔案相同：repo 不能以自己的設定放寬掃描。
export const SCANNER_CONFIG_FILES = ['.gitleaks.toml', '.gitleaksignore', 'osv-scanner.toml', '.semgrepignore', '.trivyignore', '.trivyignore.yaml', 'trivy.yaml'];

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const HEX40 = /^[0-9a-f]{40}$/;

/** 取出 Jenkinsfile 的 LM_GITLEAKS_HISTORY_BASE；不是恰好一個 40 hex 常數時回傳 null。 */
export function parseHistoryBase(text) {
  const all = [...String(text).matchAll(/^\s*LM_GITLEAKS_HISTORY_BASE\s*=\s*'([^']*)'\s*$/gm)];
  if (all.length !== 1 || !HEX40.test(all[0][1])) return null;
  return all[0][1];
}

export function verifySha256(buffer, expected) {
  return createHash('sha256').update(buffer).digest('hex') === expected;
}

class CheckError extends Error {}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw new CheckError(`${cmd} 無法執行：${r.error.message}`);
  return r;
}
function git(args, opts = {}) {
  const r = run('git', ['-C', ROOT, ...args], opts);
  if (r.status !== 0) throw new CheckError(`git ${args.join(' ')} 失敗：${(r.stderr || '').trim()}`);
  return r.stdout.trim();
}

function parseArgs(argv) {
  const out = { commit: 'HEAD', range: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if ((a === '--commit' || a === '--range') && v !== undefined && !v.startsWith('--')) {
      out[a.slice(2)] = v;
      i++;
    } else {
      throw new CheckError(`未知或缺值的參數：${a}\n用法：bun scripts/gitleaks-check.mjs [--commit <rev>] [--range <a..b | sha>]`);
    }
  }
  return out;
}

async function fetchGitleaks(dir) {
  const asset = ASSETS[process.platform];
  if (!asset || process.arch !== 'x64') throw new CheckError(`不支援的平台 ${process.platform}/${process.arch}（只支援 linux/x64 與 win32/x64）`);
  const res = await fetch(RELEASE + asset.name);
  if (!res.ok) throw new CheckError(`下載 ${asset.name} 失敗：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!verifySha256(buf, asset.sha256)) throw new CheckError(`${asset.name} 的 SHA-256 與釘選值不符`);
  const archive = join(dir, asset.name);
  writeFileSync(archive, buf);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const x = run('tar', [process.platform === 'win32' ? '-xf' : '-xzf', archive, '-C', bin]);
  if (x.status !== 0 || !existsSync(join(bin, asset.bin))) throw new CheckError(`解壓 ${asset.name} 失敗：${(x.stderr || '').trim()}`);
  const v = run(join(bin, asset.bin), ['version']);
  if (v.status !== 0 || !v.stdout.includes(GITLEAKS_VERSION)) throw new CheckError(`gitleaks version 不是 ${GITLEAKS_VERSION}`);
  return join(bin, asset.bin);
}

function exportSources(dir, sha) {
  const tree = join(dir, 'tree');
  mkdirSync(tree);
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
  git(['read-tree', sha], { env });
  git(['checkout-index', '--all', '--force', `--prefix=${tree}/`], { env });
  for (const f of SCANNER_CONFIG_FILES) rmSync(join(tree, f), { force: true });
  const hist = join(dir, 'history.git');
  const b = run('git', ['init', '-q', '--bare', hist]);
  if (b.status !== 0) throw new CheckError('git init --bare 失敗');
  const ref = `refs/lm-scan/local-${process.pid}`;
  git(['update-ref', ref, sha]);
  try {
    const f = run('git', ['-C', hist, 'fetch', '-q', '--no-tags', ROOT, `+${ref}:refs/heads/scan`]);
    if (f.status !== 0) throw new CheckError(`git fetch 失敗：${(f.stderr || '').trim()}`);
  } finally {
    git(['update-ref', '-d', ref]);
  }
  return { tree, hist };
}

function gitleaksEnv() {
  const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' };
  delete env.GITLEAKS_CONFIG;
  delete env.GITLEAKS_CONFIG_TOML;
  return env;
}

export async function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  let dir = null;
  try {
    const args = parseArgs(argv);
    const sha = git(['rev-parse', '--verify', `${args.commit}^{commit}`]);
    let range = args.range;
    if (range === null) {
      const floor = parseHistoryBase(git(['show', `${sha}:Jenkinsfile`]));
      if (!floor) throw new CheckError('Jenkinsfile 沒有有效的 LM_GITLEAKS_HISTORY_BASE');
      if (run('git', ['-C', ROOT, 'merge-base', '--is-ancestor', floor, sha]).status !== 0) {
        throw new CheckError(`LM_GITLEAKS_HISTORY_BASE ${floor} 不是 ${sha} 的祖先：CI 的歷史掃描會未完成`);
      }
      range = `${floor}..${sha}`;
    }
    if (!/^([0-9a-f]{40}\.\.)?[0-9a-f]{40}$/.test(range)) throw new CheckError(`--range 必須是 <40 hex>..<40 hex> 或 <40 hex>：${range}`);
    dir = mkdtempSync(join(tmpdir(), 'lm-gitleaks-'));
    const bin = await fetchGitleaks(dir);
    const { tree, hist } = exportSources(dir, sha);
    const out = join(dir, 'out');
    mkdirSync(out);
    const common = ['--redact', '--no-banner', '--exit-code', '0', '--report-format', 'json'];
    const d = run(bin, ['dir', ...common, '--report-path', join(out, 'gitleaks-dir.json'), '.'], { cwd: tree, env: gitleaksEnv() });
    if (d.status !== 0) throw new CheckError(`gitleaks dir 結束碼 ${d.status}`);
    const g = run(bin, ['git', ...common, '--report-path', join(out, 'gitleaks-git.json'), `--log-opts=${range}`, hist], { env: gitleaksEnv() });
    if (g.status !== 0) throw new CheckError(`gitleaks git 結束碼 ${g.status}`);
    const reports = [];
    for (const name of ['gitleaks-dir', 'gitleaks-git']) {
      const n = run(process.execPath, [join(ROOT, 'ci/policy/normalize.mjs'), '--tool', 'gitleaks', '--in', join(out, `${name}.json`), '--out', join(dir, `${name}.json`), '--tool-version', GITLEAKS_VERSION], { cwd: ROOT });
      if (n.status !== 0) throw new CheckError(`normalize ${name} 失敗：${(n.stderr || '').trim()}`);
      reports.push(join(dir, `${name}.json`));
    }
    const evalOut = join(dir, 'evaluation.json');
    const e = run(process.execPath, [join(ROOT, 'ci/policy/evaluate.mjs'), '--reports', ...reports, '--exceptions', join(ROOT, 'security/exceptions.json'), '--commit', sha, '--out', evalOut], { cwd: ROOT });
    if (!existsSync(evalOut)) throw new CheckError(`evaluate 沒有輸出（結束碼 ${e.status}）：${(e.stderr || '').trim()}`);
    const ev = JSON.parse(readFileSync(evalOut, 'utf8'));
    log(`Gitleaks ${GITLEAKS_VERSION}（SHA-256 已驗證）commit ${sha}`);
    log(`Gitleaks Git 歷史範圍：${range}`);
    for (const s of ev.scans) log(`  ${s.file.replace(/^.*[\\/]/, '')}: complete=${s.complete} findings=${s.findings}`);
    for (const f of ev.findings) log(`  ${f.kind} ${f.id} ${f.location}:${f.line ?? ''}${f.commit ? ' @' + f.commit : ''} blocking=${f.blocking}`);
    const secrets = ev.findings.filter(f => f.kind === 'secret').length;
    log(`pass=${ev.pass} secret findings=${secrets}`);
    return e.status === 0 || e.status === 1 ? e.status : 2;
  } catch (err) {
    if (!(err instanceof CheckError)) throw err;
    error(err.message);
    return 2;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
