// 發行版本（plan.md D2）：根目錄 Cargo.toml 的 `[workspace.package] version` → `v<version>`。
// 純函式供測試使用；CLI 只在直接執行時啟動。
//
// 用法：bun ci/release-version.mjs [--cargo-toml Cargo.toml]
//   stdout 只輸出一行 `v<major>.<minor>.<patch>`。
// 結束碼：0 成功；1 找不到 `[workspace.package] version`、格式不是 X.Y.Z 或檔案無法讀取。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * 從 Cargo.toml 內容取出 `[workspace.package]` 表格的 version（只接受 `version = "X.Y.Z"` 的寫法）。
 * @param {string} text
 * @returns {string} `v<version>`
 */
export function releaseVersion(text) {
  let inTable = false;
  let found = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header || line.startsWith('[[')) {
      inTable = header?.[1] === 'workspace.package';
      continue;
    }
    if (!inTable) continue;
    const m = /^version\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    if (found !== null) throw new Error('[workspace.package] 有兩個 version');
    const value = /^"([^"]*)"$/.exec(m[1]);
    if (!value) throw new Error('[workspace.package] 的 version 必須是字串');
    found = value[1];
  }
  if (found === null) throw new Error('Cargo.toml 沒有 [workspace.package] version');
  if (!VERSION_RE.test(found)) throw new Error('[workspace.package] 的 version 必須是 X.Y.Z');
  return `v${found}`;
}

export function main(argv = process.argv.slice(2), { log = console.log, error = console.error, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  let path = 'Cargo.toml';
  if (argv.length === 2 && argv[0] === '--cargo-toml' && argv[1]) path = argv[1];
  else if (argv.length !== 0) {
    error('用法：bun ci/release-version.mjs [--cargo-toml Cargo.toml]');
    return 1;
  }
  try {
    log(releaseVersion(readFile(path)));
    return 0;
  } catch (e) {
    error(`無法取得發行版本：${e?.code === 'ENOENT' ? `找不到 ${path}` : e.message}`);
    return 1;
  }
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
