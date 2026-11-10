// Release_Tag 解析與驗證（Requirement 1.5、Design Property 2）。
//
// 純函式：
//   parseReleaseTag(name)   → { major, minor, patch } | null
//   formatReleaseTag(parts) → 'v<major>.<minor>.<patch>'
//
// CLI：
//   bun ci/policy/tag.mjs <tag> <commit-sha> [--main-ref <ref>]
//   結束碼：0 通過；1 Tag 格式不符；2 commit 不在 main 歷史中；3 參數錯誤或 git 執行失敗。

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_COMPONENT = 999_999;

// 每段為 0，或 1..6 位且首位非 0 的十進位數字（上限 999999）；不允許任何前綴或後綴。
// JavaScript 的 `$`（未加 m 旗標）只比對字串結尾，`\d` 只比對 ASCII 數字。
const RELEASE_TAG_RE = /^v(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

/**
 * 解析 Release_Tag。
 * @param {unknown} name
 * @returns {{major:number, minor:number, patch:number} | null}
 */
export function parseReleaseTag(name) {
  if (typeof name !== 'string') return null;
  const m = RELEASE_TAG_RE.exec(name);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function isComponent(n) {
  return Number.isSafeInteger(n) && n >= 0 && n <= MAX_COMPONENT;
}

/**
 * 將版本元件格式化為 Release_Tag；元件不合法時拋出 RangeError。
 * @param {{major:number, minor:number, patch:number}} parts
 * @returns {string}
 */
export function formatReleaseTag(parts) {
  const { major, minor, patch } = parts ?? {};
  for (const [key, value] of [['major', major], ['minor', minor], ['patch', patch]]) {
    if (!isComponent(value)) throw new RangeError(`無效的版本元件 ${key}`);
  }
  return `v${major}.${minor}.${patch}`;
}

// commit 只接受 7..40 字元十六進位，避免被 git 當成選項或 revision 運算式。
const COMMIT_RE = /^[0-9a-f]{7,40}$/i;
// 主線 ref：只允許常見 ref 字元，且不得以 '-' 開頭。
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/**
 * 以陣列參數呼叫 git（不經 shell）檢查 commit 是否位於 mainRef 歷史中。
 * @returns {{ok:true} | {ok:false, code:2|3, reason:string}}
 */
export function checkAncestor(commit, mainRef = 'origin/main', { cwd = process.cwd(), spawn = spawnSync } = {}) {
  if (typeof commit !== 'string' || !COMMIT_RE.test(commit)) {
    return { ok: false, code: 3, reason: 'commit SHA 格式無效' };
  }
  if (typeof mainRef !== 'string' || !REF_RE.test(mainRef) || mainRef.includes('..')) {
    return { ok: false, code: 3, reason: 'main ref 格式無效' };
  }
  const result = spawn('git', ['merge-base', '--is-ancestor', commit, mainRef], {
    cwd,
    shell: false,
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
  });
  if (result.error) return { ok: false, code: 3, reason: `無法執行 git：${result.error.code ?? 'unknown'}` };
  if (result.status === 0) return { ok: true };
  if (result.status === 1) return { ok: false, code: 2, reason: `commit ${commit} 不在 ${mainRef} 歷史中` };
  return { ok: false, code: 3, reason: `git merge-base 失敗（結束碼 ${result.status}）` };
}

function parseArgs(argv) {
  const positional = [];
  let mainRef = 'origin/main';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--main-ref') {
      if (i + 1 >= argv.length) return null;
      mainRef = argv[++i];
    } else {
      positional.push(argv[i]);
    }
  }
  if (positional.length !== 2) return null;
  return { tag: positional[0], commit: positional[1], mainRef };
}

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error, ...opts } = {}) {
  const args = parseArgs(argv);
  if (!args) {
    error('用法：bun ci/policy/tag.mjs <tag> <commit-sha> [--main-ref <ref>]');
    return 3;
  }
  const parts = parseReleaseTag(args.tag);
  if (!parts) {
    error(JSON.stringify({ ok: false, reason: 'Release_Tag 格式不符 v<major>.<minor>.<patch>', tag: args.tag }));
    return 1;
  }
  const ancestry = checkAncestor(args.commit, args.mainRef, opts);
  if (!ancestry.ok) {
    error(JSON.stringify({ ok: false, reason: ancestry.reason, tag: args.tag }));
    return ancestry.code;
  }
  log(JSON.stringify({ ok: true, tag: args.tag, ...parts, commit: args.commit, mainRef: args.mainRef }));
  return 0;
}

const isMain = import.meta.main
  ?? (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) process.exit(main());
