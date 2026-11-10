// 安全測試套件執行器（Requirement 7.6、10.10、10.11）：
//   bun tests/security/run.mjs [--junit reports/security-junit.xml]
// 以 bun test 執行 tests/security/*.sec.js（bun 預設只探索 *.test.*，因此明確列出檔案），
// 並輸出 JUnit 報告供 Pipeline 寫入 Build_Record。任一案例失敗即以非零結束碼結束。
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const args = process.argv.slice(2);
const junitAt = args.indexOf('--junit');
const junit = resolve(root, junitAt >= 0 && args[junitAt + 1] ? args[junitAt + 1] : 'reports/security-junit.xml');

if (!process.env.CAMPING_SECURITY_BASE_URL) {
  console.error('安全測試環境變數無效 CAMPING_SECURITY_BASE_URL: unset（必須指向 Test_Environment）');
  process.exit(2);
}
const files = readdirSync(here).filter(f => f.endsWith('.sec.js')).sort().map(f => `./${relative(root, resolve(here, f)).replaceAll('\\', '/')}`);
if (files.length === 0) {
  console.error('找不到任何 tests/security/*.sec.js');
  process.exit(2);
}
mkdirSync(dirname(junit), { recursive: true });
const result = spawnSync(process.execPath, ['test', '--timeout', '30000', '--reporter=junit', `--reporter-outfile=${junit}`, ...files], { cwd: root, stdio: 'inherit' });
if (result.error) {
  console.error(`無法執行 bun test：${result.error.message}`);
  process.exit(2);
}
process.exit(result.status ?? 1);
