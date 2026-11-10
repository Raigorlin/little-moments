// 在瀏覽器測試前驗證 CHROME_PATH 與 CAMPING_BUN（Req 3.8、3.9）。
// 不提供任何預設路徑（不回退到 Windows Chrome 路徑），結果只含變數名稱與原因、不含路徑值。
// `fs` 由呼叫端注入（需提供 statSync 與 accessSync，相容 node:fs），便於 property test。
//
// 用法：bun ci/verify-env.mjs [--out reports/verify-env.json]；結束碼 0 通過、1 失敗。

import * as nodeFs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_EXECUTABLES = Object.freeze(['CHROME_PATH', 'CAMPING_BUN']);
const X_OK = 1;

/**
 * @param {Record<string, string|undefined>} env
 * @param {{statSync(p: string): {isFile(): boolean}, accessSync(p: string, mode: number): void}} fs
 * @returns {{ok: boolean, problems: {name: string, reason: 'unset'|'empty'|'not_found'|'not_file'|'not_executable'}[]}}
 */
export function verifyEnv(env, fs) {
  const problems = [];
  for (const name of REQUIRED_EXECUTABLES) {
    const reason = checkExecutable(env?.[name], fs);
    if (reason) problems.push({ name, reason });
  }
  return { ok: problems.length === 0, problems };
}

function checkExecutable(value, fs) {
  if (value === undefined || value === null) return 'unset';
  if (typeof value !== 'string' || value.trim() === '') return 'empty';
  let stat;
  try { stat = fs.statSync(value); } catch { return 'not_found'; }
  if (!stat || !stat.isFile()) return 'not_file';
  try { fs.accessSync(value, X_OK); } catch { return 'not_executable'; }
  return null;
}

function main(argv) {
  const result = verifyEnv(process.env, nodeFs);
  const i = argv.indexOf('--out');
  if (i >= 0 && argv[i + 1]) {
    nodeFs.mkdirSync(dirname(resolve(argv[i + 1])), { recursive: true });
    nodeFs.writeFileSync(argv[i + 1], JSON.stringify(result, null, 2) + '\n');
  }
  console.log(JSON.stringify(result));
  for (const p of result.problems) console.error(`測試環境變數無效 ${p.name}: ${p.reason}`);
  return result.ok ? 0 : 1;
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
