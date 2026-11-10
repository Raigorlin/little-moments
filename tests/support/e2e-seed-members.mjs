// 瀏覽器測試用 member 帳號池（由 scripts/check-accounts.mjs 以 CAMPING_BUN 執行）。
//
//   bun tests/support/e2e-seed-members.mjs <prefix> <count>
//
// App_Server 對 POST /api/register 依用戶端 IP 限速（每小時 20 次）；所有 E2E 請求都來自 127.0.0.1，
// 完整套件需要的 member 帳號遠多於此上限。因此 harness 在首次管理員設定完成後，直接於該次執行的
// 拋棄式 E2E DATABASE 寫入 `<prefix>-<nnn>` 合成帳號，測試以 tests/support/e2e-pool.js 認領並登入，
// 不需要放寬任何限速設定。
//
// 連線設定只來自 CAMPING_DATABASE_*（harness 指向 lm_e2e_<random>），密碼來自 CAMPING_E2E_POOL_PASSWORD。
// 結束碼：0 成功、1 執行錯誤、2 用法或設定錯誤。輸出不含密碼或連線字串。
import { randomUUID } from 'node:crypto';
import { parseConfig } from '../../server/config.js';
import { createDatabase } from '../../server/db/connect.js';
import { insertUser } from '../../server/db/queries.js';
import { hashPassword } from '../../server/accounts.js';

export const POOL_PREFIX_PATTERN = /^[a-z][a-z0-9-]{2,20}$/;

export async function main(argv, env = process.env, { out = console.log, err = console.error } = {}) {
  const [prefix, rawCount] = argv;
  const count = Number(rawCount);
  if (!POOL_PREFIX_PATTERN.test(prefix ?? '') || !Number.isInteger(count) || count < 1 || count > 999) {
    err('用法：bun tests/support/e2e-seed-members.mjs <prefix> <1-999>');
    return 2;
  }
  const password = env.CAMPING_E2E_POOL_PASSWORD;
  if (typeof password !== 'string' || password.length < 12) {
    err('測試環境變數無效 CAMPING_E2E_POOL_PASSWORD: unset or too short');
    return 2;
  }
  const parsed = parseConfig(env);
  if (!parsed.ok) {
    for (const e of parsed.errors) err(`設定錯誤 ${e.name}: ${e.reason}`);
    return 2;
  }
  const db = createDatabase(parsed.config.database, { max: 1, connectionTimeout: 10 });
  try {
    // 合成帳號共用同一份雜湊（每個帳號仍經正常 scrypt 驗證登入）。
    const hash = await hashPassword(password);
    const now = Date.now();
    await db.sql.begin(async t => {
      for (let i = 0; i < count; i++) {
        const username = `${prefix}-${String(i).padStart(3, '0')}`;
        await insertUser(t, randomUUID(), username, `測試旅伴${i}`, 'member', hash, now);
      }
    });
    out(`seeded ${count} e2e member accounts`);
    return 0;
  } catch (e) {
    err(`無法建立 E2E member 帳號（${db.target}）：${e?.code || e?.name || 'Error'}`);
    return 1;
  } finally {
    await db.close();
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
