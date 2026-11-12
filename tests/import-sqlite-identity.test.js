// Feature: jenkins-cicd-deploy, Property 36: 匯入後自動遞增主鍵不衝突
// **Validates: Requirements 13.10**
//
// 對任意（稀疏、無序、可能很大，含空集合）的來源 audit id 集合，以 SQLite_Importer 匯入後：
//   * 直接以 SQL 新增（不指定 id）的每筆 audit 取得的 id 都大於已匯入 id 的最大值（空集合時 ≥ 1），
//     且嚴格遞增、不產生主鍵衝突；
//   * 經 App_Server 寫入稽核事件（被拒絕的首次設定會寫入 setup.denied）同樣取得新的、更大的 id。
// 其他資料表保持空白；每次執行使用獨立暫存目錄並於結束時刪除。
import { test, expect } from 'bun:test';
import fc from 'fast-check';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountService } from '../server/accounts.js';
import { importSqlite, EXIT_OK } from '../scripts/import-sqlite.mjs';
import { useTestDatabase, resetTables, serviceDb } from './support/pg.js';
import { buildSqliteFixture } from './support/sqlite-fixture.js';

const db = useTestDatabase();

const LAN = 'http://192.168.1.10:5173';
const LAN_INFO = { ip: '192.168.1.20', tcpIp: '192.168.1.20', viaProxy: false };
// 上限保留空間讓 identity 後續取號不會溢位 int8；小、中、大範圍混合以產生稀疏集合。
const MAX_ID = 2n ** 62n;
const idArb = fc.oneof(
  fc.bigInt({ min: 1n, max: 50n }),
  fc.bigInt({ min: 1n, max: 1_000_000n }),
  fc.bigInt({ min: 1n, max: MAX_ID }),
);
const idsArb = fc.uniqueArray(idArb, { maxLength: 40, selector: x => x.toString() });
const textArb = fc.string({ maxLength: 12 });

const auditRowsArb = idsArb.chain(ids => fc.tuple(
  ...ids.map(id => fc.record({ id: fc.constant(id), at: fc.integer({ min: 0, max: 2 ** 52 }), actor: textArb, action: textArb, target: textArb })),
).map(rows => rows));

const toBig = v => (typeof v === 'bigint' ? v : BigInt(v));

test('Property 36: audit ids allocated after import never collide with imported ids', async () => {
  await fc.assert(
    fc.asyncProperty(
      auditRowsArb,
      fc.integer({ min: 1, max: 5 }),
      fc.integer({ min: 0, max: 2 }),
      async (rows, directInserts, appEvents) => {
        await resetTables(db.sql);
        const dir = await mkdtemp(join(tmpdir(), 'lm-import-identity-'));
        try {
          const source = join(dir, 'accounts.sqlite');
          buildSqliteFixture(source, { audit: rows });
          const errors = [];
          const result = await importSqlite({ sourcePath: source, sql: db.sql, err: l => errors.push(l) });
          expect(errors).toEqual([]);
          expect(result.exitCode).toBe(EXIT_OK);

          const imported = new Set(rows.map(r => r.id.toString()));
          const maxImported = rows.reduce((m, r) => (r.id > m ? r.id : m), 0n);

          // 直接以 SQL 新增，不指定 id：取得的 id 嚴格遞增且大於已匯入最大值（空集合時從 1 開始）。
          let previous = maxImported;
          for (let i = 0; i < directInserts; i++) {
            const [row] = await db.sql`INSERT INTO audit (at, actor, action, target) VALUES (${i}, 'prop36', 'direct', ${`n:${i}`}) RETURNING id`;
            const id = toBig(row.id);
            expect(id > previous).toBe(true);
            expect(id >= 1n).toBe(true);
            expect(imported.has(id.toString())).toBe(false);
            if (rows.length === 0 && i === 0) expect(id).toBe(1n);
            previous = id;
          }

          // 經 App_Server 寫入稽核事件：LAN 上無設定碼的首次設定被拒絕並寫入 setup.denied。
          if (appEvents > 0) {
            const before = new Set((await db.sql`SELECT id::text AS id FROM audit`).map(r => r.id));
            const svc = await createAccountService({ db: serviceDb(db.sql) });
            try {
              for (let i = 0; i < appEvents; i++) {
                const res = await svc.handle(new Request(`${LAN}/api/setup`, {
                  method: 'POST',
                  headers: { origin: LAN, 'content-type': 'application/json' },
                  body: JSON.stringify({ username: 'prop-admin', displayName: '管理員', password: 'correct horse battery' }),
                }), LAN_INFO);
                expect(res.status).toBe(403);
              }
            } finally {
              await svc.close?.();
            }
            // ORDER BY audit.id（bigint）：只寫 id 會依 text 別名排序，"1000000" 會排在 "999999" 前面。
            const fresh = (await db.sql`SELECT id::text AS id FROM audit ORDER BY audit.id`)
              .map(r => r.id).filter(id => !before.has(id)).map(BigInt);
            expect(fresh.length).toBe(appEvents);
            for (const id of fresh) {
              expect(id > previous).toBe(true);
              previous = id;
            }
          }

          // 主鍵唯一：資料表中的 id 互不相同。
          const [{ n, d }] = await db.sql`SELECT count(*)::int AS n, count(DISTINCT id)::int AS d FROM audit`;
          expect(n).toBe(d);
          expect(n).toBe(rows.length + directInserts + appEvents);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    ),
    { numRuns: 100 },
  );
}, 300_000);
