// Migration_Runner CLI（Requirement 12.1–12.4、12.7）。
//   bun scripts/migrate.mjs            # 連線設定由 CAMPING_DATABASE_* 提供
// 遷移目錄：CAMPING_MIGRATIONS_DIR，未設定時為本檔上一層的 migrations/
// （repo：scripts/../migrations；映像：/app/server/../migrations）。
// 結束碼：0 成功、1 連線或執行錯誤、2 設定錯誤、3 遷移集合無效或 checksum 不符、4 遷移失敗。
// 輸出不含密碼或連線字串。
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../server/config.js';
import { createDatabase } from '../server/db/connect.js';
import { loadMigrations, runMigrations, MigrationValidationError, EXIT_ERROR, EXIT_INVALID } from '../server/db/migrations.js';

const EXIT_CONFIG = 2;

/** 讀取遷移目錄中的 .sql 檔（位元組原樣，checksum 以位元組計算）。 */
export async function readMigrationFiles(dir) {
  const names = (await readdir(dir)).filter(name => name.endsWith('.sql')).sort();
  return Promise.all(names.map(async name => ({ name, content: new Uint8Array(await readFile(join(dir, name))) })));
}

/** 將訊息中可能出現的秘密值以遮罩取代。 */
function redactor(secrets) {
  const values = secrets.filter(s => typeof s === 'string' && s.length > 0).sort((a, b) => b.length - a.length);
  return text => values.reduce((out, s) => out.split(s).join('********'), String(text));
}

export async function main(env = process.env, { out = console.log, err = console.error } = {}) {
  const parsed = parseConfig(env);
  if (!parsed.ok) {
    for (const e of parsed.errors) err(`設定錯誤 ${e.name}: ${e.reason}`);
    return EXIT_CONFIG;
  }
  const { database } = parsed.config;
  const redact = redactor([database.password, encodeURIComponent(database.password)]);

  const dir = env.CAMPING_MIGRATIONS_DIR || fileURLToPath(new URL('../migrations/', import.meta.url));
  let repo;
  try {
    repo = loadMigrations(await readMigrationFiles(dir));
  } catch (e) {
    if (e instanceof MigrationValidationError) {
      err(e.message);
      return EXIT_INVALID;
    }
    err(`無法讀取遷移目錄：${e?.code || e?.name || 'Error'}`);
    return EXIT_ERROR;
  }

  // 單一連線：session 級 advisory lock 與遷移在同一 session。
  const db = createDatabase(database, { max: 1, connectionTimeout: 10 });
  const { sql } = db;
  try {
    const result = await runMigrations(sql, repo, {
      log: line => (/失敗|錯誤|不一致/.test(line) ? err : out)(redact(line)),
    });
    return result.exitCode;
  } catch (e) {
    err(redact(`無法連線至 Database ${database.host}:${database.port}：${e?.code || e?.name || 'Error'}`));
    return EXIT_ERROR;
  } finally {
    await db.close();
  }
}

if (import.meta.main) process.exit(await main());
