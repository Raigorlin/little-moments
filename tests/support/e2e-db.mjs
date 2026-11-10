// 瀏覽器測試用拋棄式 Database 的 CLI（Requirement 4.3、5.3；design.md Components §7）。
// scripts/check-accounts.mjs 跑在 Node，而 Bun.SQL 只在 Bun 中可用，因此以 CAMPING_BUN 執行本檔：
//
//   bun tests/support/e2e-db.mjs create        # 建立 lm_e2e_<16 hex>，stdout 只輸出資料庫名稱
//   bun tests/support/e2e-db.mjs drop <name>   # DROP DATABASE … WITH (FORCE)；不存在時視為成功
//
// 管理連線只來自 CAMPING_TEST_DATABASE_*，不會碰到 Staging／Production 的 CAMPING_DATABASE_*。
// 結束碼：0 成功、1 執行錯誤、2 用法或設定錯誤。錯誤訊息只含主機、連接埠與錯誤代碼。
import { E2E_DATABASE_PATTERN, TestDatabaseConfigError, createE2eDatabase, dropE2eDatabase, readTestDatabaseConfig } from './pg.js';

const safeCode = e => (typeof e?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(e.code) ? e.code : e?.name || 'Error');

export async function main(argv, env = process.env, { out = console.log, err = console.error } = {}) {
  const [command, name] = argv;
  if (!(command === 'create' || (command === 'drop' && E2E_DATABASE_PATTERN.test(name ?? '')))) {
    err('用法：bun tests/support/e2e-db.mjs create | drop lm_e2e_<16 hex>');
    return 2;
  }
  let config;
  try {
    config = readTestDatabaseConfig(env);
  } catch (e) {
    err(e instanceof TestDatabaseConfigError ? e.message : '測試 Database 設定無效');
    return 2;
  }
  try {
    if (command === 'create') out(await createE2eDatabase({ env }));
    else await dropE2eDatabase(name, { env });
    return 0;
  } catch (e) {
    err(`E2E 資料庫 ${command} 失敗（${config.host}:${config.port}）：${safeCode(e)}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
