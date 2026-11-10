// 伺服器打包（Requirement 16.2；design.md Components §11）。
// 將 scripts/serve.mjs、scripts/migrate.mjs、scripts/import-sqlite.mjs 及其匯入的 server/ 與 src/ 模組
// 各自打包成單一檔案，使 App_Image 的最終階段不需要 src/ 原始檔：
//
//   bun scripts/build-server.mjs [--out <目錄>]     # 預設 build-server/
//
// 產出：
//   <out>/server/serve.js         App_Server 進入點
//   <out>/server/migrate.js       Migration_Runner（以 ../migrations/ 為預設遷移目錄）
//   <out>/tools/import-sqlite.js  SQLite_Importer（維運工具；App_Server 程序不載入 bun:sqlite）
//   <out>/tools/drill.js          還原演練工具（lm-deploy drill 在 drill 專用網路內執行；只接受 lm_drill DB）
//   <out>/migrations/*.sql        遷移檔
//
// 打包後檔案的 import.meta.url 指向輸出檔，所以 `../migrations/` 在映像中解析為 /app/migrations/；
// 靜態根目錄只由 CAMPING_DIST 決定（scripts/serve.mjs）。
// 正式相依套件（dependencies）維持 external，由 production node_modules 提供，不重複打包。
// 結束碼：0 成功；1 打包失敗。
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ENTRIES = [
  { entry: 'scripts/serve.mjs', dir: 'server', name: 'serve.js' },
  { entry: 'scripts/migrate.mjs', dir: 'server', name: 'migrate.js' },
  { entry: 'scripts/import-sqlite.mjs', dir: 'tools', name: 'import-sqlite.js' },
  { entry: 'scripts/drill.mjs', dir: 'tools', name: 'drill.js' },
];

function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

export async function buildServer(outDir) {
  const out = resolve(outDir);
  rmSync(out, { recursive: true, force: true });
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const external = Object.keys(pkg.dependencies ?? {}).flatMap(name => [name, `${name}/*`]);
  for (const { entry, dir, name } of ENTRIES) {
    const result = await Bun.build({
      entrypoints: [entry],
      target: 'bun',
      format: 'esm',
      outdir: resolve(out, dir),
      naming: name,
      external,
      minify: false,
    });
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      throw new Error(`打包失敗：${entry}`);
    }
  }
  mkdirSync(resolve(out, 'migrations'), { recursive: true });
  cpSync('migrations', resolve(out, 'migrations'), { recursive: true, filter: src => !/\.(?:sqlite|db)/i.test(src) });
  return out;
}

if (import.meta.main) {
  try {
    const out = await buildServer(arg(process.argv.slice(2), '--out', 'build-server'));
    console.log(`伺服器打包完成：${out}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
