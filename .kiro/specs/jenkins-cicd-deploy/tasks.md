# Implementation Plan: Jenkins CI/CD 與 LAN Docker 部署

## Overview

依設計文件以 JavaScript（Bun 1.3.x）實作，逐步推進：先完成應用程式的設定、Host 檢查與首次管理員保護（暫時保留 SQLite，使既有測試持續通過），再將資料層遷移至 PostgreSQL 並建立 Migration_Runner 與 SQLite_Importer，接著補齊瀏覽器測試與 QA_Inventory、CI 政策工具、Dockerfile、Jenkinsfile、Deploy_Host 與 Registry 設定檔，最後更新 README。每個群組結束時設置檢查點，確保測試全綠後才進入下一步。

實作注意事項：

- PBT 使用 `fast-check@4.3.0`（精確版本 devDependency），每個 property test 以 `numRuns: 100` 起跳，並以 `// Feature: jenkins-cicd-deploy, Property N: <標題>` 標記。
- 為了讓測試任務能平行執行，設計文件「Testing Strategy」中合併的測試檔（例如 `tests/ci-policy.test.js`）在本計畫中拆分為每個屬性一個檔案，屬性內容不變。
- Requirement 16.5 已更新：App_Image 的 `org.opencontainers.image.version` 一律為 `main-<短 SHA>`，Release_Tag 名稱僅透過 Registry 版本標籤與 Build_Record 記錄。Property 39 的測試依更新後的需求實作（不再期待 Tag 建置的 `version` 等於 Tag 名稱）。
- 無法在 repository 內完整自動化的基礎設施（Jenkins、Deploy_Host、Registry），任務產出設定檔、腳本與驗證腳本，不對真實主機執行部署動作。

## Tasks

- [x] 1. 應用程式設定模組
  - [x] 1.1 實作 `server/config.js` 並加入 fast-check
    - 實作 `parseConfig(env)`、`isLoopbackAddress`、`normalizeHost`、`hostAllowed`、`redactedSummary`、`parseCidrList`、`ipInCidrs`（含 IPv4-mapped IPv6 正規化）、`resolveClient(tcpIp, headers, url, trustedProxies)`
    - 依設計的環境變數表驗證 `CAMPING_BIND_ADDRESS`、`PORT`、`CAMPING_ALLOWED_HOSTS`、`CAMPING_SETUP_TOKEN`、`CAMPING_TRUSTED_PROXIES`、`CAMPING_DATABASE_*`、`CAMPING_DATABASE_SSLMODE`；錯誤只回傳變數名與原因，不含值
    - 本階段 `CAMPING_DATABASE_*` 驗證以 `requireDatabase` 選項控制，SQLite 期間預設不強制，任務 5.14 切換為必填
    - 於 `package.json` 新增 `fast-check@4.3.0` devDependency 並更新 `bun.lock`
    - _Requirements: 8.1, 8.2, 8.4, 8.5, 8.7, 9.3, 9.12, 11.8_

  - [x] 1.2 撰寫 Property 12 的 property test（`tests/config.test.js`）
    - **Property 12: 應用程式設定解析**
    - **Validates: Requirements 8.1, 8.2, 8.4, 8.7, 9.3, 11.8**

  - [x] 1.3 撰寫 Property 13 的 property test（`tests/config-secrets.test.js`）
    - **Property 13: 設定錯誤與啟動訊息不洩漏秘密**
    - **Validates: Requirements 8.5, 8.7, 9.3**

  - [x] 1.4 撰寫 Property 46 的 property test（`tests/proxy-resolve.test.js`）
    - **Property 46: 轉送標頭只採信 Trusted_Proxies**
    - 含 /0、/32、/128 邊界與偽造 `127.0.0.1` 的 `X-Forwarded-For`，並以逐位元前綴比對的參考實作比對 `ipInCidrs`
    - **Validates: Requirements 9.8, 9.12, 10.1, 10.5**

- [x] 2. HTTP 處理器的 Host 檢查、健康端點與有效請求網址
  - [x] 2.1 修改 `server/http.js` 與 `server/accounts.js`
    - `createHttpHandler` 新增 `allowedHosts`、`health`、`trustedProxies` 參數；處理順序為 `GET /healthz` → Host 檢查（不通過回應 421 + `SECURITY_HEADERS`，不呼叫 `accounts.handle`、不讀檔）→ `resolveClient` 重建有效請求網址 → 既有 API／靜態路由
    - `/healthz` 以 2 秒逾時呼叫 `health()`，成功 `200 {"status":"ok","database":"ok"}`、失敗 `503`
    - `accounts.handle` 改用重建後的網址進行 Origin 比對與 Cookie `Secure` 判斷，並將 Cookie 組裝抽成可匯出的 `cookieHeader(url, token, maxAge)`
    - 所有錯誤分支（400、403、404、405、421、500）皆附 `SECURITY_HEADERS`
    - _Requirements: 8.3, 9.12, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 11.6_

  - [x] 2.2 撰寫 Property 14 的 property test（`tests/http-host.test.js`）
    - **Property 14: Host 檢查**
    - **Validates: Requirements 8.3**

  - [x] 2.3 撰寫 Property 15 的 property test（`tests/http-headers.test.js`）
    - **Property 15: 所有回應皆帶安全標頭**
    - **Validates: Requirements 10.6**

  - [x] 2.4 撰寫 Property 21 的 property test（`tests/http-origin.test.js`）
    - **Property 21: Origin 檢查**
    - **Validates: Requirements 10.1, 10.2**

  - [x] 2.5 撰寫 Property 22 的 property test（`tests/http-cookie.test.js`）
    - **Property 22: Session Cookie 屬性**
    - **Validates: Requirements 10.3, 10.4, 10.5**

- [x] 3. 首次管理員設定保護
  - [x] 3.1 實作 `server/setup-guard.js`
    - `createSetupGuard({ bindAddress, setupToken, randomBytes, log })` 回傳 `{ required, verify, consume }`
    - 非 loopback Bind_Address 時啟用；未提供 token 時以 `crypto.randomBytes(32)` 產生 base64url 並只 `log` 一次
    - `verify` 先對雙方做 SHA-256 再以 `crypto.timingSafeEqual` 比較；`consume` 設定記憶體旗標
    - _Requirements: 9.2, 9.3, 9.5, 9.7_

  - [x] 3.2 改寫 `POST /api/setup` 流程（`server/accounts.js`）
    - 依設計步驟：先 `limiter.hit('setup:client:<ip>')`（30 次／15 分，達上限回應 429 且不驗證 token）→ 使用者數 ≥ 1 回應 409 → 授權 `(loopbackHost && loopbackIp && !viaProxy) || guard.verify(token)`，不通過寫入只含原因類別與來源 IP 的稽核事件並回應 403 → 輸入驗證失敗回應 400 且 token 保持有效 → 交易內再次檢查使用者數後建立管理員 → `guard.consume()`
    - `GET /api/session` 新增 `setupTokenRequired`
    - _Requirements: 9.1, 9.4, 9.5, 9.6, 9.8, 9.9, 9.10, 9.11, 9.12_

  - [x] 3.3 在 `src/accounts-ui.js` 加入設定碼欄位
    - `setupTokenRequired` 為 true 時於首次設定表單顯示具 `<label>` 的「設定碼」密碼欄位，並隨請求送出 `setupToken`
    - _Requirements: 9.1, 9.2_

  - [x] 3.4 將 `scripts/serve.mjs` 接上設定模組（暫時保留 SQLite）
    - 以 `parseConfig` 取得 bind、port、allowedHosts、trustedProxies；設定錯誤逐項輸出後 `process.exit(2)`
    - 建立 setup guard 並傳入 `createAccountService`；`Bun.serve` 改用 `config.bindAddress`
    - 啟動訊息保留 `Camping accounts ready:` 前綴，內容改為 `redactedSummary(config)`
    - _Requirements: 8.1, 8.4, 8.5, 8.7, 9.2_

  - [x] 3.5 撰寫 Property 16 的 property test（`tests/setup-guard.test.js`）
    - **Property 16: 首次管理員設定授權**
    - **Validates: Requirements 9.1, 9.4, 9.12**

  - [x] 3.6 撰寫 Property 17 的 property test（`tests/setup-single-use.test.js`）
    - **Property 17: Setup_Token 單次有效**
    - **Validates: Requirements 9.5, 9.6**

  - [x] 3.7 撰寫 Property 18 的 property test（`tests/setup-rate-limit.test.js`）
    - **Property 18: 首次設定限速**
    - **Validates: Requirements 9.8, 9.9**

  - [x] 3.8 撰寫 Property 19 的 property test（`tests/setup-validation.test.js`）
    - **Property 19: 輸入驗證失敗不消耗 Setup_Token**
    - **Validates: Requirements 9.10**

  - [x] 3.9 撰寫 Property 20 的 property test（`tests/setup-concurrency.test.js`）
    - **Property 20: 並行首次設定只建立一個管理員**
    - 任務 5.13 移植至 PostgreSQL 後須再次通過
    - **Validates: Requirements 9.11**

  - [x] 3.10 撰寫 Property 23 的 property test（`tests/password.test.js`）
    - **Property 23: 密碼雜湊往返與損壞格式拒絕**
    - **Validates: Requirements 10.7, 10.8**

- [x] 4. Checkpoint - 確認應用程式基礎變更
  - 執行 `bun run build` 與 `bun test tests/*.test.js`，確認既有 SQLite 測試與新增測試皆通過。Ensure all tests pass, ask the user if questions arise.

- [x] 5. PostgreSQL 資料層
  - [x] 5.1 建立測試用 Ephemeral_Database 輔助模組 `tests/support/pg.js`
    - 讀取 `CAMPING_TEST_DATABASE_*`；每個測試檔建立 `t_<random>` schema、設定 `search_path`、執行遷移，`afterAll` 執行 `DROP SCHEMA … CASCADE`
    - 未設定環境變數時明確失敗並指出變數名（不靜默略過）
    - 於 `package.json` 新增 `test:unit` script（`bun test tests/*.test.js`）
    - _Requirements: 4.1, 4.2, 4.3, 4.8_

  - [x] 5.2 撰寫 `migrations/0001_initial.sql`
    - 依設計的 PostgreSQL Schema 轉換 `SCHEMA` 與 `LEDGER_SCHEMA`（時間欄位 `BIGINT`、`audit.id` 為 `GENERATED BY DEFAULT AS IDENTITY`、JSON 欄位維持 `TEXT`）
    - _Requirements: 11.1, 11.7, 13.10_

  - [x] 5.3 實作 Migration_Runner（`server/db/migrations.js`、`scripts/migrate.mjs`）
    - 純函式 `loadMigrations(files)`（檔名 `^(\d{4,})_[a-z0-9_]+\.sql$`、checksum、`-- lm:destructive` 標記，版本重複或非正整數即 throw）與 `planMigrations(repo, applied)`
    - `runMigrations(sql, repo)`：`pg_advisory_lock(726362)`、建立 `schema_migrations`、checksum 不符結束碼 3、保留 `unknownApplied`、每個遷移獨立交易、失敗輸出版本號並以結束碼 4 結束、成功輸出 `applied` 清單與數量
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.7_

  - [x] 5.4 撰寫 Property 27 的 property test（`tests/migrations-plan.test.js`）
    - **Property 27: 遷移規劃**
    - **Validates: Requirements 12.1, 12.2**

  - [x] 5.5 撰寫 Property 30 的 property test（`tests/migrations-validate.test.js`）
    - **Property 30: 遷移集合驗證**
    - **Validates: Requirements 12.7**

  - [x] 5.6 撰寫 Property 28 的 property test（`tests/migrations-idempotent.test.js`）
    - **Property 28: 遷移冪等**
    - 需要 Ephemeral_Database，比對 `information_schema` 快照與版本紀錄
    - **Validates: Requirements 12.3**

  - [x] 5.7 撰寫 Property 29 的 property test（`tests/migrations-failure.test.js`）
    - **Property 29: 遷移失敗隔離**
    - **Validates: Requirements 12.4**

  - [x] 5.8 實作破壞性遷移偵測 `scripts/lint-migrations.mjs`
    - 匯出 `detectDestructive(sql)`：移除註解與字串常值後偵測 `DROP TABLE`、`DROP COLUMN`、`ALTER TABLE … RENAME`、`ALTER TABLE … DROP`
    - 拒絕 `CREATE INDEX CONCURRENTLY` 等無法在交易內執行的語句；偵測到破壞性語句但缺少 `-- lm:destructive` 時以非零結束碼結束並列出檔名
    - _Requirements: 12.6, 12.9_

  - [x] 5.9 撰寫 Property 31 的 property test（`tests/lint-migrations.test.js`）
    - **Property 31: 破壞性遷移偵測**
    - **Validates: Requirements 12.6, 12.9**

  - [x] 5.10 實作連線與交易模組（`server/db/connect.js`、`server/db/tx.js`）
    - `createDatabase(config)` 以 `Bun.SQL` 建立連線池，提供 `sql`、`ping(ms)`、`close()`
    - `retrySchedule()` 純函式（間隔 1–5 秒、累計 ≤ 30 秒）與 `connectWithRetry`；錯誤訊息只含主機與連接埠
    - `withWriteTx(sql, fn)`：`BEGIN` → `pg_advisory_xact_lock(726361)` → `fn(t)` → `COMMIT`，例外時 `ROLLBACK`
    - _Requirements: 11.1, 11.3, 11.5, 11.6, 11.9_

  - [x] 5.11 撰寫 Property 26 的 property test（`tests/db-retry.test.js`）
    - **Property 26: 啟動重連排程**
    - **Validates: Requirements 11.5**

  - [x] 5.12 將帳號與帳本查詢移植至 Bun.SQL（`server/db/queries.js`、`server/accounts.js`、`server/ledger.js`）
    - 將現行 `q.*` prepared statement 一對一轉為接收 executor 的 async 函式，全部使用 tagged template 參數化，禁止 `sql.unsafe`
    - `createAccountService({ db, … })` 改為 async，所有路由與 `tx` 呼叫點改為 `await withWriteTx(...)` 並保留交易內重新檢查
    - `BIGINT` 與 `COUNT(*)` 讀取以 `Number()` 轉換並檢查 `Number.isSafeInteger`
    - _Requirements: 11.1, 11.2, 11.3, 11.7_

  - [x] 5.13 將既有測試移植至 PostgreSQL
    - `tests/*.test.js`（含任務 3.5–3.9 的測試檔）改用 `tests/support/pg.js` 與 `await createAccountService`；直接以 `bun:sqlite` 修改資料列的測試（`ledger.test.js`、`trip-delete-upgrade.test.js` 等）改用 `t\`UPDATE …\``
    - 「拒絕公開資料庫路徑」的測試改為 `tests/config.test.js` 的對應範例案例
    - 回應比對排除 ID、時間戳記與 Session Token，作為 Req 11.7 的回歸基準
    - _Requirements: 4.1, 4.3, 11.7_

  - [x] 5.14 移除執行期 SQLite 並完成 `scripts/serve.mjs` 接線
    - `parseConfig` 將 `CAMPING_DATABASE_*` 改為必填；啟動時 `connectWithRetry`（30 秒後 `exit(3)`），`health` 傳入 `() => db.ping(2000)`
    - 移除 `bun:sqlite` 與 `CAMPING_DB` 讀取（仍設定時輸出「已忽略」警告）；SIGINT/SIGTERM 時 `await sql.close({ timeout: 5 })`
    - _Requirements: 11.1, 11.5, 11.6, 11.8, 11.9_

  - [x] 5.15 撰寫 Property 24 的 property test（`tests/pg-behavior.test.js`）
    - **Property 24: SQL 特殊字元原文往返**
    - **Validates: Requirements 11.2**

  - [x] 5.16 撰寫 Property 25 的 property test（`tests/pg-transactions.test.js`）
    - **Property 25: 寫入交易原子性**
    - **Validates: Requirements 11.3**

  - [x] 5.17 撰寫資料庫斷線恢復整合測試（`tests/pg-reconnect.test.js`）
    - 以 `docker pause/unpause` 模擬斷線，驗證 `/healthz` 於 5 秒內回應 503、恢復後 30 秒內不重啟程序即回到 200
    - _Requirements: 11.6, 11.9_

- [x] 6. Checkpoint - 所有單元測試在 PostgreSQL 上通過
  - 對 Ephemeral_Database 執行 `bun run build`、`bun test tests/*.test.js` 與 `bun scripts/lint-migrations.mjs`，並確認 runtime 程式碼已無 `bun:sqlite` 匯入。Ensure all tests pass, ask the user if questions arise.

- [x] 7. SQLite_Importer
  - [x] 7.1 實作匯入規劃純函式 `server/db/import-plan.js`
    - `tableOrder()`（依外鍵順序列出 `users, sessions, trips, trip_members, invites, trip_deletions, audit, trip_ledgers`）、`convertRow(table, row)`（NULL 保留、整數保留 `number`/`bigint`、超出 int4 範圍的欄位報錯）、`compareCounts(source, target)`
    - _Requirements: 13.1, 13.6, 13.7_

  - [x] 7.2 實作 `scripts/import-sqlite.mjs`
    - 依設計步驟：計算來源（含 `-wal`）SHA-256 → 複製到 0700 暫存目錄再讀取 → 驗證 SQLite 標頭與必要資料表（在連線目標前失敗）→ `runMigrations` → 單一交易內檢查目標為空 → 每批 500 列參數化寫入、`password_hash` 原樣 → 提交前比對筆數 → `setval` audit 序列 → 輸出 `table source target`
    - 結束時刪除暫存目錄並再次比對來源雜湊；錯誤輸出表名與原因，不含資料列內容
    - _Requirements: 10.9, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.8, 13.9, 13.10_

  - [x] 7.3 撰寫 Property 33 的 property test（`tests/import-sqlite-roundtrip.test.js`）
    - **Property 33: SQLite 匯入往返**
    - 含以原密碼登入成功的檢查；另以 `numRuns: 20`、每表 ≤ 1,000 列補充大型案例
    - **Validates: Requirements 13.1, 13.7, 13.8, 10.9**

  - [x] 7.4 撰寫 Property 34 的 property test（`tests/import-sqlite-source.test.js`）
    - **Property 34: 匯入不改變來源**
    - **Validates: Requirements 13.2**

  - [x] 7.5 撰寫 Property 35 的 property test（`tests/import-sqlite-failure.test.js`）
    - **Property 35: 匯入失敗時目標不變**
    - **Validates: Requirements 13.3, 13.4, 13.6**

  - [x] 7.6 撰寫 Property 36 的 property test（`tests/import-sqlite-identity.test.js`）
    - **Property 36: 匯入後自動遞增主鍵不衝突**
    - **Validates: Requirements 13.10**

- [x] 8. 瀏覽器測試、QA_Inventory、安全測試套件與 Smoke_Test
  - [x] 8.1 修改 `scripts/check-accounts.mjs` 與 `playwright.config.js`
    - `CHROME_PATH`、`CAMPING_BUN` 皆必填，未設定、空字串、不存在或不可執行時拋出指出變數名的錯誤；移除 Windows Chrome 預設路徑
    - 伺服器改以 `CAMPING_DATABASE_*` 指向 Ephemeral_Database
    - Playwright 新增 `desktop`（1440×1000）與 `mobile`（390×844，`grep: /@critical/`）projects；reporter 加入 `junit`（`reports/e2e-junit.xml`）與 `json`（`reports/e2e.json`）；`retries: 0`；失敗時保留截圖與 trace，伺服器日誌寫入 `reports/server.log`
    - _Requirements: 3.8, 3.9, 5.3, 5.6, 5.7, 5.9_

  - [x] 8.2 為既有 E2E 測試加上測試案例 ID
    - `tests/*.e2e.js` 的測試標題以 `[TC-<area>-<nnn>]` 開頭，重要頁面加 `@critical`；新增 member 與未登入者越權操作的 E2E 案例（含 Setup_Token 欄位顯示）
    - _Requirements: 5.1, 5.2, 5.7_

  - [x] 8.3 建立 `qa/inventory.json`
    - 依設計格式列出頁面、控制項、角色（anonymous、member、admin）、情境、預期結果、對應測試案例 ID 與 `critical` 標記，涵蓋三種角色與兩類越權項目
    - _Requirements: 5.1, 5.2_

  - [x] 8.4 實作 `scripts/qa-inventory.mjs`
    - 純函式 `validateInventory(doc)` 與 `compareInventory(inventory, results)`（讀取 Playwright JSON 報告，critical 項目需 desktop 與 mobile 皆通過）
    - CLI 子命令 `validate` 與 `compare`，輸出機器可讀結果並在不合格、失敗或缺少測試時以非零結束碼結束，列出項目 ID 與原因
    - _Requirements: 5.4, 5.5, 5.8_

  - [x] 8.5 撰寫 Property 6 的 property test（`tests/qa-inventory-validate.test.js`）
    - **Property 6: QA_Inventory 驗證**
    - **Validates: Requirements 5.1, 5.2, 5.8**

  - [x] 8.6 撰寫 Property 7 的 property test（`tests/qa-inventory-compare.test.js`）
    - **Property 7: QA_Inventory 與測試結果比對**
    - **Validates: Requirements 5.4, 5.5, 5.7**

  - [x] 8.7 建立安全測試套件 `tests/security/*.sec.js`
    - 以 `CAMPING_SECURITY_BASE_URL` 指定 Test_Environment，涵蓋 SQL injection、XSS（Playwright 確認 `window.__xss` 未被設定）、未登入存取、跨使用者存取、角色越權、Session 失效、Origin 檢查、登入限速、路徑穿越（`/../`、`%2e%2e%2f`、`..%5c`）九類
    - 另一組案例在 `CAMPING_BIND_ADDRESS=0.0.0.0` 與非 loopback Host 名稱下驗證 Req 10 第 1–9 條；輸出 JUnit 報告
    - _Requirements: 7.6, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10_

  - [x] 8.8 實作 Smoke_Test `scripts/smoke.mjs`
    - 步驟：GET `/login`（200 且含安全標頭）→ GET `/api/session` → POST `/api/login`（合成帳號由環境變數提供）→ GET `/api/trips` 確認 `smoke-fixture` 行程 → POST `/api/logout`
    - 每步逾時 10 秒，輸出 JSON 僅含步驟名稱、狀態碼與耗時；任一步失敗以非零結束碼結束
    - _Requirements: 14.6, 18.3, 20.5, 21.10_

- [x] 9. Checkpoint - 測試基礎設施完成
  - 對 Ephemeral_Database 執行 `bun test tests/*.test.js`、`scripts/check-accounts.mjs`、`bun scripts/qa-inventory.mjs validate` 與 `compare`，確認 QA_Inventory 全部項目為通過。Ensure all tests pass, ask the user if questions arise.

- [x] 10. CI 工具與政策評估器（`ci/`）
  - [x] 10.1 建立工具鏈定義與驗證腳本
    - `ci/toolchain.json` 記錄 Bun 1.3.x、Node.js、Chromium 精確版本；`ci/build-image/Dockerfile` 以 digest 固定 Playwright 基底並安裝精確 Bun
    - `ci/verify-toolchain.mjs` 匯出 `compareToolchain(expected, actual)` 並寫入 Build_Record 用的 JSON；`ci/verify-env.mjs` 匯出 `verifyEnv(env, fs)`，檢查 `CHROME_PATH`、`CAMPING_BUN`
    - _Requirements: 3.1, 3.2, 3.3, 3.8, 3.9_

  - [x] 10.2 撰寫 Property 3 的 property test（`tests/ci-toolchain.test.js`）
    - **Property 3: 工具鏈版本不一致的回報完整且精確**
    - **Validates: Requirements 3.3**

  - [x] 10.3 撰寫 Property 4 的 property test（`tests/ci-verify-env.test.js`）
    - **Property 4: 測試環境變數驗證只指出有問題的變數**
    - **Validates: Requirements 3.9**

  - [x] 10.4 實作掃描報告正規化 `ci/policy/normalize.mjs`
    - 將 osv-scanner、Semgrep、Gitleaks、Trivy、ZAP、安全測試套件輸出轉為 `Finding[]`；CVSS 換算嚴重度、無分數為 `unknown`；Gitleaks 丟棄 `Match`／`Secret`
    - 解析出的套件數為 0 時回報掃描無法完成
    - _Requirements: 6.2, 6.3, 6.4, 6.8, 17.1_

  - [x] 10.5 實作政策評估 `ci/policy/evaluate.mjs` 與 `security/exceptions.json`
    - `evaluateFindings(findings, exceptions, today)` 依 Property 8 的規則判定，回傳 `{pass, unresolved, expired, invalidExceptions}`；CLI 讀取正規化報告並輸出含工具版本、commit SHA、是否套用例外的 JSON 報告
    - 建立空的 `security/exceptions.json`（含 schema 註記）
    - _Requirements: 6.5, 6.6, 6.7, 6.9, 7.8, 17.2_

  - [x] 10.6 撰寫 Property 9 的 property test（`tests/ci-normalize.test.js`）
    - **Property 9: 掃描報告正規化保留必要欄位**
    - **Validates: Requirements 6.2, 6.3**

  - [x] 10.7 撰寫 Property 8 的 property test（`tests/ci-evaluate.test.js`）
    - **Property 8: 安全政策評估**
    - 例外日期以評估日為中心 ±3 天，涵蓋到期日當日仍有效的邊界
    - **Validates: Requirements 6.4, 6.5, 6.6, 6.9, 7.8, 17.2, 23.2**

  - [x] 10.8 實作 Release_Tag 解析 `ci/policy/tag.mjs`
    - `parseReleaseTag(name)` 與 `formatReleaseTag(parts)`；CLI 另以 `git merge-base --is-ancestor <sha> origin/main` 檢查 Tag commit 位於 `main` 歷史
    - _Requirements: 1.5_

  - [x] 10.9 撰寫 Property 2 的 property test（`tests/ci-tag.test.js`）
    - **Property 2: Release_Tag 格式判定與往返**
    - **Validates: Requirements 1.5**

  - [x] 10.10 實作秘密遮罩 `ci/scrub.mjs`
    - 由 0600 秘密檔讀取集合，產生原文、Base64、Base64URL（含／不含補齊）、URL 編碼（大小寫十六進位）形式；`scrub(text, S)` 由長到短取代為 `********`，`findLeaks(text, S)` 回傳（憑證 ID、形式）
    - CLI 處理暫存目錄中待封存檔案；仍有命中時不輸出該檔案、改寫說明檔並以非零結束碼結束
    - _Requirements: 6.4, 15.4, 21.9, 22.8_

  - [x] 10.11 撰寫 Property 10 的 property test（`tests/ci-scrub.test.js`）
    - **Property 10: 秘密遮罩**
    - **Validates: Requirements 6.4, 15.4, 21.9, 22.8**

  - [x] 10.12 建立 DAST 設定與目標驗證（`ci/dast/`）
    - `ci/dast/zap-automation.yaml` 範本（`threadPerHost=5`、20 rps、`maxDuration` 60 分鐘，目標以變數注入）
    - `ci/dast/targets.mjs` 匯出 `validateDastTargets(config, allowlist)`；`ci/dast/isolation-probe.sh` 在 `--internal` 網路內探測 Ephemeral_Database 以外位址，可連線時以非零結束碼結束並列出位址
    - _Requirements: 7.2, 7.3, 7.4, 7.7, 7.9_

  - [x] 10.13 撰寫 Property 11 的 property test（`tests/ci-dast-targets.test.js`）
    - **Property 11: DAST 目標限定**
    - **Validates: Requirements 7.2, 7.3**

  - [x] 10.14 實作階段規劃、Release_Gate 與 Build_Record 模組
    - `ci/stages.mjs`：`planStages(trigger)`，依 PR、其他分支、`main`、Release_Tag 與手動重跑回傳階段序列
    - `ci/gates.mjs`：`junitGate(summary)`、`runGates(gates)`（依 QA → 安全 → 映像 → Staging → 正式核准 → 上線後，錯誤、逾時、缺報告視為未通過）
    - `ci/record.mjs`：Build_Record 讀寫、`finalizeRecord(record)`（缺少欄位填「不適用」或「未執行」）、`lookupByDigest(records, digest)`
    - _Requirements: 1.2, 1.3, 1.4, 1.8, 2.8, 4.4, 7.1, 21.1, 21.2, 21.7, 21.8, 21.11, 23.1, 23.2, 23.3, 23.5_

  - [x] 10.15 撰寫 Property 1 的 property test（`tests/ci-stages.test.js`）
    - **Property 1: 階段規劃只對 Trusted_Ref 包含推送與部署**
    - **Validates: Requirements 1.2, 1.3, 1.4, 1.8, 2.8, 3.6, 7.1**

  - [x] 10.16 撰寫 Property 5 的 property test（`tests/ci-junit-gate.test.js`）
    - **Property 5: 測試結果關卡**
    - **Validates: Requirements 4.4, 23.2**

  - [x] 10.17 撰寫 Property 45 的 property test（`tests/ci-gates.test.js`）
    - **Property 45: Release_Gate 依序評估並在第一個失敗處停止**
    - **Validates: Requirements 1.3, 1.4, 16.1, 23.1, 23.2, 23.3**

  - [x] 10.18 撰寫 Property 42 的 property test（`tests/ci-record.test.js`）
    - **Property 42: Build_Record 完整性**
    - **Validates: Requirements 21.2, 21.11**

  - [x] 10.19 撰寫 Property 43 的 property test（`tests/ci-digest-lookup.test.js`）
    - **Property 43: Digest 查詢只回傳相符紀錄**
    - **Validates: Requirements 21.7, 21.8**

  - [x] 10.20 實作保留策略與健康判定（`ci/retention.mjs`、`ci/health.mjs`）
    - `pruneBackups(existing, newBackup, verified, keep=14)`、`retainImages(history, keep=3)`、`rollbackAllowed(digest, retained)`
    - `healthyWithin(results, windowSec, n)`、`shouldRollback(observations)`（回傳第一個觸發點）
    - _Requirements: 14.5, 14.7, 18.3, 18.5, 20.3, 20.4, 20.6, 20.7, 20.10, 20.11_

  - [x] 10.21 撰寫 Property 37 的 property test（`tests/ci-backup-retention.test.js`）
    - **Property 37: 備份保留修剪**
    - **Validates: Requirements 14.5, 14.7**

  - [x] 10.22 撰寫 Property 41 的 property test（`tests/ci-image-retention.test.js`）
    - **Property 41: 可回滾映像保留**
    - **Validates: Requirements 20.7, 20.10**

  - [x] 10.23 撰寫 Property 40 的 property test（`tests/ci-health.test.js`）
    - **Property 40: 健康檢查判定器**
    - **Validates: Requirements 18.3, 18.5, 20.3, 20.4, 20.6, 20.11**

  - [x] 10.24 實作 Release_Tag 的 digest 解析 `ci/resolve-digest.mjs`
    - 純函式 `resolveReleaseDigest(...)` 與 `versionTagDecision(existing, digest)`；CLI 包裝 `crane digest`、`cosign verify`、`cosign verify-attestation` 與 `crane tag`
    - 完整 SHA 標籤不存在時回報「查無 Image_Digest」，Registry 錯誤回報「Registry 查詢失敗」；版本標籤指向不同 digest 時拒絕覆寫
    - _Requirements: 1.4, 1.10, 16.6, 16.10, 17.7, 19.5, 20.1_

  - [x] 10.25 撰寫 Property 47 的 property test（`tests/ci-resolve-digest.test.js`）
    - **Property 47: Release_Tag 的 digest 解析與版本標籤**
    - **Validates: Requirements 1.4, 1.10, 16.6, 16.10, 19.5**

  - [x] 10.26 實作映像內容檢查與 OCI 標籤（`ci/image-content-check.mjs`、`ci/image-labels.mjs`）
    - `imageContentCheck(files, user, devDeps)`：禁止 `.env*`、憑證副檔名、`data/`、`tests/`、`src/`、資料庫檔、devDependency 套件目錄，且 UID ≠ 0；CLI 讀取 `docker export | tar -t` 清單與 `docker image inspect`
    - `imageLabels({ commit, createdAt })`：`revision` 為 40 字元 SHA、`version` 為 `main-<短 SHA>`、`created` 為 RFC 3339 UTC
    - _Requirements: 15.5, 16.2, 16.4, 16.5, 16.9_

  - [x] 10.27 撰寫 Property 38 的 property test（`tests/ci-image-content.test.js`）
    - **Property 38: 映像內容檢查**
    - **Validates: Requirements 15.5, 16.2, 16.4, 16.9**

  - [x] 10.28 撰寫 Property 39 的 property test（`tests/ci-image-labels.test.js`）
    - **Property 39: OCI 標籤格式**
    - 依更新後的 Req 16.5：`version` 一律為 `main-` 加 7 字元短 SHA
    - **Validates: Requirements 16.5**

  - [x] 10.29 實作核准人檢查 `ci/approval.mjs` 與 `ci/release-approvers.json`
    - `isReleaseApprover(id, approvers)`、`destructiveApprovalAllowed(approver, approvers, authors)`；對照檔記錄 Jenkins ID 與 git email（僅佔位符）
    - _Requirements: 12.6, 19.3, 20.10_

  - [x] 10.30 撰寫 Property 32 的 property test（`tests/ci-approval.test.js`）
    - **Property 32: 破壞性遷移核准人限制**
    - **Validates: Requirements 12.6**

  - [x] 10.31 實作通知模組（`ci/notify.mjs`、`ci/notify.groovy`）
    - `notifyWithRetry(channels, status, result)` 純函式：每個管道最多嘗試 4 次，最終失敗只加入摘要，不改建置結果
    - `notify.groovy` 提供 `notifyAll(status, context)`，註冊 `githubStatus` 與 `jenkinsSummary` 管道，各以 `retry(3)` 包裝；內容不含秘密或使用者資料
    - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.6, 22.7, 22.8_

  - [x] 10.32 撰寫 Property 44 的 property test（`tests/ci-notify.test.js`）
    - **Property 44: 通知重試不影響建置結果**
    - **Validates: Requirements 22.7**

  - [x] 10.33 建立 Semgrep 規則 `ci/semgrep/`
    - vendored JavaScript 安全規則與自訂規則：禁止 `sql.unsafe`、`eval`、`new Function`、`child_process` 動態參數；嚴重度對照 `ERROR`→High、`WARNING`→Medium、`INFO`→Low
    - 加入每條自訂規則的正反範例檔供 `semgrep --test` 使用
    - _Requirements: 6.3, 11.2_

- [x] 11. Checkpoint - CI 工具完成
  - 執行 `bun test tests/*.test.js`，確認所有 `ci/` 純函式測試通過。Ensure all tests pass, ask the user if questions arise.

- [x] 12. App_Image（Dockerfile）
  - [x] 12.1 建立 `Dockerfile` 與 `.dockerignore`，並讓伺服器可打包
    - `scripts/serve.mjs` 的靜態根目錄改由 `CAMPING_DIST` 解析，移除對原始碼目錄結構與 `import.meta.url` 相對路徑的依賴
    - 依設計撰寫 multi-stage `Dockerfile`（每個 `FROM` 以 `@sha256:` 固定、`bun install --frozen-lockfile`、打包 `serve.js`、`migrate.js`、`import-sqlite.js`、production `node_modules`、檔案 0444 屬 root、`USER 10001:10001`、OCI 標籤由 build args 帶入）
    - `.dockerignore` 依設計列出全部排除項目
    - _Requirements: 3.1, 15.5, 16.2, 16.3, 16.4, 16.5, 16.7_

  - [x] 12.2 建立映像建置腳本 `ci/scripts/build-image.sh`
    - 以 `ci/image-labels.mjs` 產生標籤後 `docker build`，以完整 SHA 標記；執行 `ci/image-content-check.mjs`；任一步失敗以非零結束碼結束並保存建置日誌
    - _Requirements: 16.1, 16.5, 16.6, 16.8, 16.9_

  - [x] 12.3 撰寫映像層級 Smoke 測試 `ci/scripts/image-smoke.sh`
    - 以建置的映像連線 Ephemeral_Database，執行 `migrate.js` 後啟動 App 並執行 `scripts/smoke.mjs`，驗證打包後的伺服器行為
    - _Requirements: 16.2, 18.3_

- [x] 13. Jenkinsfile 與 Jenkins 設定
  - [x] 13.1 建立 `Jenkinsfile` 骨架與 Init、Toolchain、Install、Build 階段
    - `options { skipDefaultCheckout(); timestamps(); disableResume() }`；`checkout scm` 後以 `git rev-parse HEAD` 固定 Commit SHA
    - Init：建立 Build_Record、以 `ci/stages.mjs` 分類觸發、Release_Tag 時先執行 `ci/policy/tag.mjs`、呼叫 `notifyAll('pending')`
    - Build_Image 以 digest 引用；依序執行 `verify-toolchain`、`bun install --frozen-lockfile`、`bun run build`
    - 不提供任何可略過 Release_Gate 的參數
    - _Requirements: 1.1, 1.5, 1.6, 1.7, 3.1, 3.3, 3.4, 3.5, 3.6, 3.7, 21.1, 22.1, 23.4_

  - [x] 13.2 加入單元測試與瀏覽器測試階段
    - 以建置標籤啟動 Ephemeral_Database（120 秒內就緒否則失敗）、執行 Migration_Runner、`verify-env`、`bun test`（15 分鐘逾時）並產生 JUnit；`qa-inventory validate` → `check-accounts.mjs`（60 分鐘逾時）→ `qa-inventory compare`；失敗時封存截圖、trace 與伺服器日誌；`post` 120 秒內銷毀資料庫
    - 以 `ci/gates.mjs` 評估「QA」關卡
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 5.3, 5.4, 5.5, 5.6, 5.8, 5.9, 23.1, 23.5_

  - [x] 13.3 加入靜態安全掃描階段
    - Gitleaks（`dir` + `git --log-opts`，Untrusted_PR 使用 merge base、Trusted_Ref 使用 `GIT_PREVIOUS_SUCCESSFUL_COMMIT`，`--redact`）、osv-scanner v2（`bun.lock`）、Trivy `node_modules` 交叉掃描、Semgrep；每項 15 分鐘逾時，經 `normalize`／`evaluate` 判定「安全」關卡（不含 DAST）
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9_

  - [x] 13.4 加入 Trusted_Ref 專用的遷移相容性與 DAST 階段
    - 遷移相容性：`git describe` 找最近 Release_Tag，在 Ephemeral_Database 上以舊映像套用遷移、再套用新增遷移、以舊映像執行 Smoke_Test；無 Tag 時記錄略過原因；執行 `lint-migrations`
    - DAST：建立 `--internal` 網路、`isolation-probe.sh`、`validateDastTargets`、ZAP 與 `tests/security`（含 Req 10.10 非 loopback 設定），60 分鐘逾時；`post` 銷毀環境；評估含 DAST 的「安全」關卡
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 10.10, 10.11, 12.5, 12.8, 12.9_

  - [x] 13.5 加入映像建置、掃描、SBOM、推送與簽章階段（僅 `main`）
    - `ci/scripts/build-image.sh` → Trivy 映像掃描（15 分鐘逾時）→ Syft SBOM → 評估「映像」關卡推送前部分 → `docker push` → 比對 Registry digest → `cosign sign --tlog-upload=false`；封存 `image-digest.txt` 並 fingerprint
    - 推送與簽章憑證僅在 `withCredentials` 區塊內提供
    - _Requirements: 15.1, 15.2, 15.3, 16.1, 16.8, 16.10, 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 21.2_

  - [x] 13.6 加入 Staging 部署階段（僅 `main`）
    - `lock('lm-staging')` 排隊；`cosign verify` 後以 SSH 受限金鑰呼叫 `lm-deploy staging deploy <digest>`（備份 → 遷移 → 啟動 → 每 10 秒健康檢查 → Smoke_Test 10 分鐘內）；失敗時 5 分鐘內還原至前一個 staging-verified digest，無可還原者停止新容器
    - 成功時 `cosign attest` staging-verified predicate 並寫入 Build_Record；評估「Staging」關卡
    - _Requirements: 14.1, 14.2, 14.3, 14.8, 17.7, 17.8, 18.1, 18.2, 18.3, 18.4, 18.5, 18.7, 18.8, 18.9_

  - [x] 13.7 加入 Release_Tag 的 digest 解析、核准與 Production 部署階段
    - `ci/resolve-digest.mjs`（查無 digest 時於核准前失敗並寫入摘要）→「映像」與「Staging」關卡 → 24 小時 `input` 迴圈（顯示 Tag、SHA、digest、Staging 結果、報告連結；記錄非核准人嘗試）→ 破壞性遷移另一次核准（`destructiveApprovalAllowed`）→ `git ls-remote` 確認 Tag 未變更
    - `lock(resource: 'lm-prod', skipIfLocked: true)`；`lm-deploy prod` 執行備份、遷移、啟動、健康檢查、切換；10 分鐘觀察期（每 10 秒健康檢查、切換後與結束前各一次 Smoke_Test），以 `shouldRollback` 判定回滾或 finalize；評估「上線後」關卡
    - _Requirements: 1.4, 1.10, 12.6, 14.1, 14.2, 14.3, 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.8, 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7, 20.9, 20.11, 20.12, 22.5_

  - [x] 13.8 加入 `post { always }` 收尾處理
    - 經 `ci/scrub.mjs` 遮罩並掃描所有待封存檔案後 `archiveArtifacts`；以 `finalizeRecord` 寫入結果、結束時間與第一個失敗階段；清除該建置的容器、網路與卷；`cleanWs()`；呼叫 `notifyAll` 最終狀態
    - 在 Production 執行中或屬保留集合的建置以 Jenkins API 設定 `keepLog`
    - _Requirements: 2.6, 15.4, 21.2, 21.6, 21.9, 21.11, 22.2, 22.3, 22.4, 22.7, 22.8, 23.1_

  - [x] 13.9 建立 Jenkins 設定即程式碼 `ci/jenkins/`
    - `casc.yaml`：GitHub webhook secret、Matrix Authorization（非管理員無 `Run/Delete`、`Run/Update`、`Job/Configure`、`Run/Replay`）、Release_Approver 群組、Lockable Resources `lm-staging`／`lm-prod`
    - `jobs.groovy`（Job DSL）：`ci/little-moments`（PR 與非 `main` 分支、PR 信任策略「Admin or Write」、14 天保留）、`release/little-moments`（`main` 90 天、Tag 365 天、Tag build strategy）、`release/rollback`、`release/restore-drill`（cron `H 3 1,15 * *`）、`release/digest-lookup`、`infra/build-image`；憑證只定義於 `release/` 資料夾範圍
    - `ci/jenkins/README.md` 列出必要 plugins、憑證 ID 與 Untrusted Agent 網路隔離、webhook 拒絕日誌的驗證步驟
    - _Requirements: 1.1, 1.9, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 15.1, 15.7, 15.8, 19.3, 21.3, 21.4, 21.5, 21.12_

  - [x] 13.10 建立 Build_Image 建置管線 `ci/jenkins/pipelines/build-image.Jenkinsfile`
    - 建置 `ci/build-image/Dockerfile`、推送後輸出 digest，並驗證實際版本與 `ci/toolchain.json` 相符
    - _Requirements: 3.1, 3.2_

- [x] 14. Deploy_Host 設定與部署腳本（`deploy/`）
  - [x] 14.1 建立 Compose 與 Caddy 設定
    - `deploy/compose/compose.yaml`（`name: lm-${ENV}`、proxy、app-blue、app-green、migrate、db，`app` 網路為 `internal` 且固定子網、db 不發布連接埠、`pgdata` 具名卷、`read_only`、`cap_drop`、`CAMPING_BEDROCK_*` 預設空字串）
    - `deploy/compose/staging.env.example`、`prod.env.example`（僅佔位符）；`deploy/caddy/Caddyfile`（`grace_period 30s`、外部 `/healthz` 回應 404）與 `upstream.caddy.tmpl`
    - _Requirements: 11.4, 11.10, 15.6, 18.6, 20.2, 20.3_

  - [x] 14.2 實作 `deploy/bin/lm-deploy`
    - bash 腳本，子命令 `backup|migrate|start|health|switch|rollback|finalize|status|prune`，以 `flock -n /run/lm-<env>.lock` 防止並行
    - `backup`：30 分鐘逾時 `pg_dump -Fc` → 驗證大小、`pg_restore --list`、`sha256sum` → rename → 輸出 JSON → Production 依 `pruneBackups` 規則保留 14 份
    - `start` 以 `repo@digest` 啟動另一個槽位；`health` 5 秒逾時；`switch` 原子寫入 upstream 後 `caddy reload`；`finalize` 停止舊槽位並保留 3 個映像；`rollback` 不執行遷移
    - `app.env` 由 stdin 寫入、權限 0600
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.8, 18.2, 18.7, 20.2, 20.3, 20.4, 20.6, 20.7, 20.9, 20.12_

  - [x] 14.3 建立主機安全設定 `deploy/host/`
    - `docker-user.rules` 與 `lm-docker-user.service`（開機套用 `DOCKER-USER` 規則，僅允許 `LAN_CIDR`）、`sudoers.d/lm-deploy`（每環境只允許對應固定腳本）、`authorized_keys.tmpl`（forced command、`from=`、`no-pty`）、`install.sh`（建立 0700 `lm-ops` 備份目錄）
    - `verify-host.sh`：檢查規則已載入、備份目錄權限、db 無發布連接埠、部署帳號不在 `docker` 群組
    - _Requirements: 8.6, 11.10, 14.4, 15.9_

  - [x] 14.4 撰寫 `lm-deploy` 的 bats 測試（`deploy/tests/lm-deploy.bats`）
    - 以假的 `docker`／`pg_dump` 驗證備份失敗不遷移、14 份修剪、鎖衝突、健康失敗時不切換、回滾不執行遷移
    - _Requirements: 14.3, 14.5, 18.7, 20.4, 20.9, 20.12_

  - [x] 14.5 實作還原演練
    - `deploy/compose/drill.yaml`（獨立 internal 網路與匿名卷）與 `lm-deploy drill` 子命令：還原最新已驗證備份、插入臨時合成管理員、以目前 prod digest 啟動並執行 Smoke_Test、`down -v`
    - `ci/jenkins/pipelines/restore-drill.Jenkinsfile` 記錄備份 ID、還原秒數與結果；失敗時保留所有備份
    - _Requirements: 14.6, 14.7, 21.10_

  - [x] 14.6 實作手動回滾管線 `ci/jenkins/pipelines/rollback.Jenkinsfile`
    - 參數 `digest`（選項來自 `lm-deploy status prod`）與 `reason`；以 `isReleaseApprover` 與 `rollbackAllowed` 檢查；`lock('lm-prod', skipIfLocked)`；依 start／health／switch 流程切換且不執行遷移；回滾後未健康時標記需人工介入；記錄觸發方式、帳號、來源與目標 digest、原因與完成時間
    - _Requirements: 20.8, 20.9, 20.10, 20.11, 20.12_

  - [x] 14.7 實作 digest 查詢管線
    - `ci/digest-lookup.mjs` 以 MD5(`<digest>\n`) 查詢 Jenkins fingerprint API 並套用 `lookupByDigest`；`ci/jenkins/pipelines/digest-lookup.Jenkinsfile` 顯示 Commit SHA、Release_Tag、核准人、核准時間與部署時間，查無時明確回報
    - _Requirements: 21.7, 21.8_

- [x] 15. LAN Registry 設定（`deploy/registry/`）
  - [x] 15.1 建立 Registry 設定檔
    - `compose.yaml`（Distribution `registry:3` 與 Caddy，皆 digest 固定）、`config.yml`（關閉刪除）、`Caddyfile`（內部 CA TLS、每帳號 basic auth、拉取帳號僅允許 GET/HEAD、推送帳號僅供 `release/`）、`htpasswd.example`（佔位符）
    - _Requirements: 15.9, 16.10, 17.5_

  - [x] 15.2 建立 Registry 驗證腳本 `deploy/registry/verify-registry.sh`
    - 驗證拉取帳號無法 PUT/DELETE、未認證請求被拒、刪除 API 已關閉
    - _Requirements: 15.9_

- [x] 16. 設定檢查與文件
  - [x] 16.1 撰寫設定 lint 測試 `tests/ci-lint.test.js`
    - `Dockerfile` 與 `ci/build-image/Dockerfile` 每個 `FROM` 含 `@sha256:`、`Jenkinsfile` 的 Build_Image 引用含 digest、`.dockerignore` 含所有必要項目、`Jenkinsfile` 無略過關卡的參數、`compose.yaml` 的 db 無 `ports`、`CAMPING_BEDROCK_*` 預設空字串
    - _Requirements: 3.1, 11.10, 15.6, 16.3, 16.7, 23.4_

  - [x] 16.2 更新 `README.md`
    - 環境變數表（名稱、用途、必填、預設值、未設定行為，含非 loopback 未設 Allowed_Hosts 拒絕啟動、Setup_Token 自動產生只輸出至本機日誌）
    - LAN 僅限網段存取與不支援公開曝露；SQLite_Importer 編號步驟與失敗處理；手動回滾與備份還原編號步驟；本機 Ephemeral_Database 建立、測試與銷毀指令；憑證僅由 Credential_Store 提供；所有範例值使用佔位符
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.5, 24.6, 24.7, 24.8, 24.9, 24.10_

  - [x] 16.3 撰寫 README 檢查測試（`tests/readme.test.js`）
    - 預設值與 `parseConfig` 一致、不含符合秘密模式的字串
    - _Requirements: 24.2, 24.9_

- [x] 17. Final checkpoint - 確認所有測試通過
  - 執行 `bun run build`、`bun test tests/*.test.js`、`scripts/check-accounts.mjs`、`bun scripts/lint-migrations.mjs` 與 `semgrep --test ci/semgrep`，確認全部通過。Ensure all tests pass, ask the user if questions arise.

- [x] 18. 合併 security-harden 分支至 main（以 PostgreSQL 資料層與 main 的部署方式為準）
  - [x] 18.1 移除 mobile-ux-enhance 分支的 Jenkinsfile
    - 以獨立 worktree 操作，不改變目前工作目錄的分支：`git worktree add ../little-moments-mobile-ux -b mobile-ux-enhance origin/mobile-ux-enhance`，`git rm Jenkinsfile`，本機提交 `Remove Jenkinsfile: Jenkins builds use the Jenkinsfile on main`，不推送；完成後 `git worktree remove ../little-moments-mobile-ux`（保留本機分支 `mobile-ux-enhance`）
    - 該檔案要求不存在的 `docker-host` 標籤，使 `ci/little-moments` 對此分支的建置一直排隊；推送後此分支沒有 Jenkinsfile，Multibranch 不再為它建立 Job
    - _Requirements: 1.1_

  - [x] 18.2 建立合併分支並開始三方合併
    - 開始前確認 working tree 只有兩個已知的未提交修改：`ci/jenkins/jobs.groovy`（任務 19.1 使用）與 `.kiro/specs/jenkins-cicd-deploy/tasks.md`；整個任務 18 都不得 stage 或提交這兩個檔案
    - `git switch -c merge/security-harden main`
    - 兩個分支沒有共同歷史（security-harden 以新的 root commit `7b93010` 開始，內容是 main 的 `cd06606` 之後的新版程式碼）。以 `git commit-tree` 建立兩個不屬於任何分支的合成 commit，沿用原 commit 的 author、committer、日期與訊息：`c1` 的 tree 為 `7b93010^{tree}`、parent 為 `cd06606`；`c2` 的 tree 為 `09e2e05^{tree}`、parent 為 `c1`；確認 `git diff 09e2e05 <c2>` 為空
    - `git merge --no-ff --no-commit <c2>`，合併訊息 `Merge branch 'security-harden' (09e2e05) into main`；不提交，合併狀態保留至 18.9
    - 不納入（自 index 與 working tree 移除）：`.tmp-e2e-dist/`、`tmp-menu-check/`、`test-results-*/`（建置輸出與失敗的測試結果）、根目錄的空檔 `requirements.md`、`docker-compose.yml` 與 `docs/deploy-nginx.md`（另一套部署方式）；`.gitignore` 加入 `.tmp-e2e-dist/`、`tmp-menu-check/`、`test-results*/`
    - 部署相關一律保留 main 的版本：`Dockerfile`、`Jenkinsfile`、`ci/`、`deploy/`；`.dockerignore` 以 main 為準，只加入 security-harden 新增且仍適用的排除項目
    - `package.json`：合併兩邊的 scripts 與 dependencies（保留 main 的 PostgreSQL 相依與腳本）；`bun.lock` 以 Bun 1.3.14 重新產生（例如 `bunx bun@1.3.14 install`；本機 Bun 1.4.4 可能寫入 1.3.14 不支援的欄位），並以同版本確認 `bun install --frozen-lockfile` 通過
    - 其餘衝突留給 18.3–18.8；報告列出所有仍有衝突或需要改寫的檔案
    - _Requirements: 3.4, 3.5, 16.3_

  - [x] 18.3 設定與 HTTP：以 main 的 `server/config.js` 為準整合 security-harden 的設定
    - 不採用 security-harden `server/deploy-config.js` 的部署模式（`CAMPING_PUBLISHED`、`CAMPING_PUBLIC_ORIGIN`、`CAMPING_LOCAL_EXTRA_HOSTS`、`CAMPING_ALLOW_NON_LOOPBACK_BIND`、`CAMPING_DOCKER_LOCAL_ONLY`、`HOST`、`CAMPING_DB`／`resolveDbPath`）：Bind_Address、Allowed_Hosts、Trusted_Proxies、Setup_Token 與 `CAMPING_DATABASE_*` 維持 main 的行為（Requirement 8、9、10）
    - 應用層設定移入 `parseConfig`，預設值與 security-harden 相同：`CAMPING_REGISTRATION`（`open`／`closed`）、`CAMPING_RECEIPT_AI_POLICY`（`all`／`admins`／`off`）與 `server/ai-cost.js` 的用量上限變數；無效值拒絕啟動，錯誤只指出變數名稱；`ai-cost.js` 改用 `config.js` 的錯誤型別
    - `server/http.js`、`scripts/serve.mjs`：以 main 的 `/healthz`、Host 檢查（421）與 `resolveClient` 為準，加入 security-harden 的 `server/safe-log.js`（通用 500 訊息、錯誤日誌不含請求內容）與安全標頭變更；security-harden 對 Host、Origin 或轉送標頭的檢查若比 main 嚴格則保留；啟動訊息符合 Requirement 8.5
    - 刪除 `server/deploy-config.js` 與 `tests/deploy-config.test.js`，仍適用的案例移到 main 的 config 與 http 測試；`scripts/create-admin.mjs`、`reset-password.mjs` 對 deploy-config 的引用在 18.6 處理
    - 執行 config、http、security-config 與 security-headers 相關測試檔
    - _Requirements: 8.1, 8.2, 8.3, 8.5, 8.7, 9.12, 10.1, 10.5_

  - [x] 18.4 資料層：把 security-harden 的 SQLite 程式碼改寫為 PostgreSQL
    - 新增 `migrations/0002_*.sql`：`settings`、`receipt_ai_usage`、`security_events`、`security_alerts`（含 security-harden 定義的索引）、`invites` 新欄位 `id`（唯一索引）、`used_at`、`used_by`（參照 `users`），以及 security-harden 對 `trips` 的結構變更（對照其 `server/accounts.js` 的 trips 重建邏輯）；型別與命名沿用 `0001_initial.sql`；可在交易內執行；通過 `bun scripts/lint-migrations.mjs`（若需要破壞性變更須標記 `-- lm:destructive`）
    - `server/accounts.js`：security-harden 新增的功能（邀請連結、註冊政策、收據 AI 政策與用量、安全事件與警示、密碼重設等）改寫為 main 的非同步 `server/db/` 連線與交易（寫入交易取得 `pg_advisory_xact_lock`），保留 main 已有的 PostgreSQL 行為與 Setup_Token 流程
    - `server/security-events.js`、`server/settings.js` 與其他新模組改用 PostgreSQL；保留 security-harden 的上限（安全事件 5000 筆、警示 1000 筆）與清理規則
    - runtime 程式碼（`server/`、`scripts/serve.mjs`）不得匯入 `bun:sqlite`；只有 SQLite_Importer 可以
    - SQLite_Importer（`server/db/import-plan.js`、`scripts/import-sqlite.mjs`）：`tableOrder` 與轉換加入新資料表與欄位；來源可以是舊版（沒有新表或新欄位）或 security-harden 版的 `accounts.sqlite`，兩者都能匯入且筆數比對正確；更新匯入測試
    - 對 Ephemeral_Database 執行 accounts、ledger、import、migrations 與 security-events 相關測試檔
    - _Requirements: 11.1, 11.10, 12.1, 12.6, 12.9, 13.1, 13.10_

  - [x] 18.5 收據 AI：以 security-harden 的 OpenAI 實作取代 Bedrock
    - 採用 security-harden 的 `server/receipt-ai.js`、`src/receipt-ai-client.js` 與 `server/ai-cost.js`（`CAMPING_OPENAI_*`）；移除所有 `CAMPING_BEDROCK_*`
    - 部署端維持「預設停用、只有 release/ 可啟用」：`deploy/compose/compose.yaml`、`drill.yaml`、`*.env.example` 與 `deploy/bin/lm-deploy` 的 `CAMPING_BEDROCK_*` 改為對應的 `CAMPING_OPENAI_*`，預設空字串；`ci/` 不得定義任何 `CAMPING_OPENAI_*` 憑證；`scripts/check-accounts.mjs`、`scripts/security-suite.mjs`、`ci/semgrep` 規則與 `ci/jenkins/README.md` 同步
    - 啟動訊息、日誌與 Build_Record 都不得出現金鑰值；`scripts/scan-secrets.mjs` 保留 OpenAI 金鑰規則
    - 更新 `requirements.md` 的 2.4、8.5、15.6–15.8 與 `design.md` 對應段落：`CAMPING_BEDROCK_*` 改為 `CAMPING_OPENAI_*`，規則本身不變
    - 更新相關測試（receipt-ai、config-secrets、ci-lint、ci-restore-drill、readme 等），執行受影響的測試檔與 `bats deploy/tests`
    - _Requirements: 2.4, 8.5, 15.6, 15.7, 15.8_

  - [x] 18.6 前端與維運腳本
    - `src/`：採用 security-harden 的介面與功能（含移除「車輛設定」「旅行設定」分頁、mobile swipe、行程選單、分帳自動對應類別）；`src/accounts-ui.js` 的衝突保留兩邊：main 的首次管理員 Setup_Token 流程與 security-harden 的帳號介面
    - `scripts/create-admin.mjs`、`scripts/reset-password.mjs` 改用 `CAMPING_DATABASE_*` 連線 PostgreSQL，密碼只由 stdin 或檔案讀取；加入 `scripts/build-server.mjs` 的輸出（`/app/tools/create-admin.js`、`/app/tools/reset-password.js`），可在 Deploy_Host 以 App_Image 執行
    - `scripts/scan-secrets.mjs`、`secret-rules.mjs`、`secret-allowlist.json` 與 `scripts/build.mjs` 保留，確認引用的路徑仍存在
    - 執行 `bun run build` 與相關測試檔
    - _Requirements: 9.1, 10.1, 16.2_

  - [x] 18.7 測試與 QA_Inventory
    - security-harden 新增與修改的測試改用 main 的 PostgreSQL 測試支援（`tests/support/pg.js`），不再建立 SQLite 檔；兩邊都修改的測試檔保留兩邊的案例
    - `qa/inventory.json`：更新指向已移除分頁或改名控制項的項目，對應的測試案例 ID 必須存在；`bun scripts/qa-inventory.mjs validate` 通過
    - `scripts/check-accounts.mjs` 與 `playwright.config.js` 維持 main 的 `CHROME_PATH`／`CAMPING_BUN` 規則
    - 對 Ephemeral_Database 執行 `bun test tests/*.test.js` 與 `scripts/check-accounts.mjs`，修正失敗
    - _Requirements: 3.9, 4.1, 5.1, 5.3, 5.4, 10.10_

  - [x] 18.8 README 與文件
    - 合併 `README.md`：保留 main 的部署、環境變數表與操作步驟；加入 security-harden 的功能說明；環境變數表加入 18.3 與 18.5 的新變數（`tests/readme.test.js` 檢查預設值與 `parseConfig` 一致）；不含長十六進位字串或秘密
    - 保留 `docs/security-report.md` 與 `docs/security-review.md`，在開頭註明其中的 SQLite 與 nginx 部署內容已由 PostgreSQL 與 Jenkins 部署取代
    - 執行 `bun test tests/readme.test.js`
    - _Requirements: 24.1, 24.2, 24.9_

  - [x] 18.9 Checkpoint - 合併完成，提交前確認
    - 沒有衝突標記（`git diff --check` 與搜尋 `<<<<<<<`）；runtime 程式碼沒有 `bun:sqlite`；`ci/jenkins/jobs.groovy` 與 tasks.md 未被 stage
    - 執行 `bun run build`、`bun test tests/*.test.js`（Ephemeral_Database，用完即刪）、`scripts/check-accounts.mjs`、`bun scripts/lint-migrations.mjs`、`bats deploy/tests` 與 `semgrep --test ci/semgrep`，全部通過
    - 請使用者確認後才提交合併 commit；提交前不開始任務 19；不推送任何分支（包含 18.1 的 mobile-ux-enhance）。Ensure all tests pass, ask the user if questions arise.

  - [x] 18.10 移除 0002 的破壞性變更並提交合併 commit（使用者已同意）
    - 尚未有任何 Staging／Production Database（只有可丟棄的 preview Database），因此把 trips.cover_kind 新增的 `forest`、`beach`、`sunrise` 直接併入 `migrations/0001_initial.sql` 的 CHECK 條件；`migrations/0002_security_harden.sql` 刪除 trips 的 DROP／ADD CONSTRAINT 與 `-- lm:destructive` 標記及相關說明
    - 唯一的 Release_Approver 同時是遷移作者，無法核准自己的破壞性遷移（Property 32），因此 0002 必須是非破壞性；`bun scripts/lint-migrations.mjs` 不再回報 destructive
    - 更新受影響的測試（例如 `tests/migrations-0002.test.js`、遷移與匯入相關測試），對 Ephemeral_Database 執行相關測試與完整 `bun test tests/*.test.js`
    - 使用者已確認：以 `Merge branch 'security-harden' (09e2e05) into main` 提交合併 commit 於 `merge/security-harden`；只提交 index，不包含 `ci/jenkins/jobs.groovy`、`tasks.md`、`tasks.meta.json`；不推送任何分支
    - _Requirements: 12.6, 12.9_

- [x] 19. 依 192.168.1.121 的實際部署同步設定（上線時發現的修正與實際值）
  - [x] 19.1 修正 `ci/jenkins/jobs.groovy` 的 Job DSL 憑證名稱與秘密處理
    - 以 working tree 尚未提交的修改為基礎（`secret` 與 `privateKey` 已改用 `hudson.util.Secret.fromString(...)`），修復 `gitHubApp` 分支中遺失方法名稱的 ` {`（第 244 行附近）
    - 憑證 DSL 方法改為 Job DSL 接受的名稱（CasC 的 symbol 會被 Job DSL 拒絕）：`gitHubApp`→`gitHubAppCredentials`、`string`→`stringCredentialsImpl`、`file`→`fileCredentialsImpl`（另加 `file(null)`，為 FileCredentialsImpl 的必要參數）、`directEntry`→`directEntryPrivateKeySource`；`usernamePassword`、`basicSSHUserPrivateKey` 不變
    - 移除 `owner(...)`：github-branch-source 的 GitHubAppCredentials 已改用 `repositoryAccessStrategy`（預設由存取的 repository 推定 owner）；`gitHubApp` 類型不再讀取或要求 `<id>.owner` 秘密檔（`secretParts`、`resolveCredentials` 與檔頭註解一併更新）
    - 每個憑證的建立與整個 `folderCredentialsProperty` 以 try/catch 包裝，改丟出只含「資料夾/憑證 ID（類型）」與例外類別名稱的 `IllegalStateException`，不附原例外訊息或 cause（Job DSL 的 MissingMethodException 會列出參數值，曾把私鑰印到日誌）
    - `GITHUB_OWNER = 'Raigorlin'`，移除 `GITHUB_OWNER`／`GITHUB_REPO` 的 PLACEHOLDER 標記與檔頭說明
    - `buildRetention`（branch-api 的 BuildRetentionBranchProperty）維持不變：已標示 deprecated 但仍套用保留天數；警告說明見 19.5
    - 更新 `tests/ci-jenkins-config.test.js` 中與 jobs.groovy 相關的檢查，執行 `bun test tests/ci-jenkins-config.test.js`
    - _Requirements: 1.1, 2.4, 2.5, 15.1, 15.3, 21.3, 21.4, 21.5_

  - [x] 19.2 更新 `ci/jenkins/casc.yaml`，新增 `ci/jenkins/local-security.yaml`，更新 `ci/release-approvers.json`
    - casc.yaml：刪除 `crumbIssuer`（新版 core 的 DefaultCrumbIssuer 已無 `excludeClientIPFromCrumb`，預設 issuer 仍提供 CSRF 保護）與 `remotingSecurity`（AdminWhitelistRule 已無作用，只產生警告）
    - casc.yaml：`location.url` 為 `https://jenkins.our-littlemoments.com/`，`hookUrl` 為 `https://jenkins.our-littlemoments.com/github-webhook/`
    - casc.yaml：Overall/Administer 改授與使用者 `jacklin`（取代 `lm-jenkins-admins` 群組）；其他群組項目保留供日後改用外部 security realm，在本機使用者資料庫下不生效，以註解說明
    - casc.yaml：`lm-untrusted-1` 的 `remoteFS` 改為 `/var/lib/jenkins-untrusted`（兩個 agent 在同一主機，各自需要容器內外路徑相同的工作目錄）
    - local-security.yaml：`jenkins.securityRealm.local`（`allowsSignup: false`），使用者 `jacklin`、`lm-retention-bot`、`lm-api-readonly`，密碼分別為 `${JENKINS_ADMIN_PASSWORD}`、`${RETENTION_BOT_PASSWORD}`、`${API_READONLY_PASSWORD}`（CasC 秘密來源，不含任何值）
    - release-approvers.json：唯一 Release_Approver `jacklin`（email `thawtunoo@gmail.com`）；`$comment` 說明單一核准人無法核准自己撰寫的破壞性遷移
    - 更新 `tests/ci-jenkins-config.test.js`（管理員為使用者 jacklin、remoteFS、local-security.yaml 每位使用者的密碼皆為 `${VAR}`、沒有 crumbIssuer 與 remotingSecurity），執行 `bun test tests/ci-jenkins-config.test.js tests/ci-approval.test.js`
    - _Requirements: 2.1, 2.6, 12.6, 19.3, 21.12_

  - [x] 19.3 新增 Jenkins controller 與兩個 agent 的容器設定（`deploy/jenkins/`）
    - `controller/`：`Dockerfile`（`FROM jenkins/jenkins:lts-jdk21`、關閉 setup wizard、`COPY --chown=jenkins:jenkins plugins.txt`、`jenkins-plugin-cli` 後確認 `configuration-as-code` 與 `job-dsl` 已下載，否則建置失敗）、`.dockerignore`（只允許 `plugins.txt`）、`plugins.txt`（與 `ci/jenkins/README.md` 的必要 plugins 表一致）、`compose.yaml`（`name: lm-jenkins`；只綁定 `${LM_JENKINS_LAN_IP}:8080`；`CASC_JENKINS_CONFIG`、`LM_CASC_DIR`、`SECRETS`；`./casc` 與 `./secrets` 唯讀；網路 `default` 與外部 `proxy`）
    - `agent/`：共用 `Dockerfile`（`jenkins/inbound-agent:latest-jdk21` 加上 `docker:cli` 的 docker CLI 與 cli-plugins）、`.dockerignore`（`*`）、`.gitignore`（`*.secret`、`.env`）；`trusted.compose.yaml`（`lm-trusted-1`：主機 docker.sock、`group_add: ${DOCKER_GID}`、同路徑 `/var/lib/jenkins-agent`）；`untrusted.compose.yaml`（`lm-untrusted-1`：只掛載 rootless daemon 的 `${SOCK}`、`group_add: ${SOCK_GID}`、同路徑 `/var/lib/jenkins-untrusted`，絕不掛載主機的 docker.sock）
    - `agent/untrusted/`：`lm-untrusted-fw`（OUTPUT 的 owner 規則套用於 lm-untrusted 的 uid 與 subuid 範圍：丟棄 REPLY 方向封包；只允許 DNS、Jenkins `:8080` 與 Registry `:8443`；拒絕本機其他連接埠、10/8、172.16/12、192.168/16、100.64/10、169.254/16 與所有 IPv6）、`lm-untrusted-fw.service.in`（`Before=` 且 `RequiredBy=user@<uid>.service`：防火牆未套用時 rootless daemon 不啟動）、`docker-rootless-override.conf`（`DOCKERD_ROOTLESS_ROOTLESSKIT_DETACH_NETNS=false`：Docker 29.5 起預設讓 `--net=host` 加入真正的主機網路；`DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns`）
    - 新增 `tests/deploy-jenkins.test.js`：untrusted 不掛載主機 docker.sock、兩個 agent 的工作目錄與 casc.yaml 的 `remoteFS` 一致、防火牆規則與 override、controller Dockerfile 的 `--chown` 與 plugin 檢查、plugins.txt 與 README 表一致；執行 `bun test tests/deploy-jenkins.test.js`
    - _Requirements: 2.4, 2.5, 2.6_

  - [x] 19.4 LAN Registry 修正與所有映像的實際 digest
    - Registry 一律為 `registry.our-littlemoments.com:8443`：取代 `Jenkinsfile`、`ci/jenkins/pipelines/*.Jenkinsfile` 與 `deploy/compose/*.env.example`（`LM_IMAGE_REPO`）中的 `registry.lan.example:8443` 與 `<registry-host>:<port>`；`BUILD_IMAGE` 仍保留 `@sha256:<digest>`，待 infra/build-image 首次推送後填入
    - 鏡像映像（linux/amd64，`registry.our-littlemoments.com:8443/little-moments/mirror/<name>@sha256:<digest>`）：gitleaks v8.30.1 `b109bc5f8f76a38196a3e413704fc5b9e3c32360bce4e4b603bd6f45b3721dbb`、osv-scanner v2.7.1 `bc10cae80da100d32572aea48cfc48e592be9adc4a8b0820fd5d2c2db71f9446`、trivy 0.76.2 `6fa071ef8daa2e58b90cbf1710bedca91adbb3bf98693533226f442035b836a6`、semgrep 1.185.0 `f83a64e8a7d985eaa51ee3978c9c882be946964c68633fba5d2817cf297a3912`、syft v1.57.1 `c31c09c21a75c7c0b1f4082358614115536fa4f1d2e0bdab2d11f5257360338a`、crane v0.22.1 `18efc5092649b2a674d384663044e04edf76705c4faa2875e8a322b4e80f070a`（`Jenkinsfile` 與 `build-image.Jenkinsfile`）、cosign v2.6.5 `404b8081d833085d12c21cda889c6f2f3731328768257c760e32fcf070be2cf9`、zap 2.17.0 `c2d63bbb2d907a5c5257914fb20e26e969c92b25f265def7f89f08203f912882`
    - 上游映像：`postgres:17.6-bookworm@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3`（`LM_POSTGRES_IMAGE`、`deploy/compose/compose.yaml` 與 `drill.yaml` 的 db）、`caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d`（`deploy/compose/compose.yaml` 的 proxy）、`caddy:2.10.2@sha256:c3d7ee5d2b11f9dc54f947f68a734c84e9c9666c92c88a7f30b9cba5da182adb` 與 `registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e`（`deploy/registry/compose.yaml` 與 `htpasswd.example`）
    - `deploy/registry/compose.yaml`：proxy 連接埠改為 `${LM_REGISTRY_LAN_IP}:8443:8443`（主機 443 由 Nginx Proxy Manager 使用，Pipeline 引用 `:8443`）；proxy 加上 `cap_add: [NET_BIND_SERVICE]` 與說明註解（官方 Caddy 二進位檔帶 cap_net_bind_service 檔案能力，`cap_drop: [ALL]` 時 execve 以 EPERM 失敗）
    - Bun 改為 1.3.14（Docker Hub 沒有 `oven/bun:1.3.0-distroless`，distroless 自 1.3.4 起提供；`bun.lock` 含 1.3.0 不支援的 `configVersion`）：`ci/toolchain.json`；`ci/build-image/Dockerfile`（`FROM mcr.microsoft.com/playwright:v1.56.1-noble@sha256:f1e7e01021efd65dd1a2c56064be399f3e4de00fd021ac561325f2bfbb2b837a`、`BUN_VERSION=1.3.14`、`BUN_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f`、`NODE_SHA256=00bbd05e306ea68b6e13e17360d0e2f680b493ef95f2fea1c4296ff7437530bc`）；根目錄 `Dockerfile`（`oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4`、`oven/bun:1.3.14-distroless@sha256:c28c51287af70bab8e0b66fc4b6a30cfb92a727ebc88045223adc9f4c9d09307`）；兩個 Dockerfile 的 syntax 行為 `docker/dockerfile:1.10@sha256:865e5dd094beca432e8c0a1d5e1c465db5f998dca4e439981029b3b81fb39ed5`
    - 新增 `deploy/registry/mirror.list`（上游映像與版本）、`mirror.sh`（以 lm-push 與 crane 複製 mirror.list 的映像與 `mirror.gcr.io/aquasec/trivy-db:2`，輸出 digest）、`lm-mirror-trivy-db` 與其 `.service`、`.timer`（每日 04:30 複製 trivy-db）
    - 更新斷言 PLACEHOLDER 或舊主機名稱的測試，執行受影響的測試檔與 `bats deploy/tests`
    - _Requirements: 3.1, 3.2, 4.2, 6.1, 6.2, 6.3, 15.9, 16.3, 17.1, 17.4, 17.5_

  - [x] 19.5 更新文件
    - `ci/jenkins/README.md`：以實際值取代 PLACEHOLDER 一節（保留部署主機相關的待填項目）；設定載入改為把 `casc.yaml`、`local-security.yaml`、`jobs.groovy` 複製到 controller 的 casc 目錄；秘密目錄另含 `JENKINS_ADMIN_PASSWORD`、`RETENTION_BOT_PASSWORD`、`API_READONLY_PASSWORD`、`GITHUB_WEBHOOK_SECRET`，`gitHubApp` 不再需要 `.owner`；GitHub App 權限（Contents、Metadata、Pull requests 唯讀，Commit statuses 讀寫，App 的 webhook 關閉，只安裝在 little-moments）；本機使用者資料庫與管理員 jacklin；`buildRetention` 的 deprecated 警告；單一 Release_Approver 的限制
    - `ci/jenkins/README.md` 的「Webhook 驗證與拒絕日誌」改為 Nginx Proxy Manager（Proxy Host `jenkins.our-littlemoments.com` → `http://jenkins:8080`、存取清單「LAN only」、Advanced 只公開 `location = /github-webhook/` 且僅允許 POST、存取日誌的位置與內容）；「Untrusted Agent 網路隔離」改為 rootless Docker 與 owner 防火牆的驗證步驟；兩個章節標題保留不變
    - 新增 `deploy/jenkins/README.md`（controller 與兩個 agent 的安裝、agent secret 的取得與寫入、rootless Docker 設定、防火牆安裝與隔離驗證）與 `deploy/registry/README.md`（DNS A 記錄（DNS only）、名稱限制的內部 CA 與 2 年伺服器憑證、htpasswd 的 3 個帳號、啟動與 verify-registry.sh、兩個 Docker daemon 信任 CA 的路徑、mirror.sh、trivy-db timer）
    - 根目錄 `README.md`：連結上述文件、工具鏈為 Bun 1.3.14；不加入任何 digest（`tests/readme.test.js` 禁止長十六進位字串）
    - 執行 `bun test tests/readme.test.js tests/ci-jenkins-config.test.js tests/deploy-jenkins.test.js`
    - _Requirements: 2.1, 2.2, 2.6, 24.1, 24.9_

  - [x] 19.6 Checkpoint - 部署設定同步後確認所有測試通過
    - 執行 `bun run build`、`bun test tests/*.test.js`（需要 PostgreSQL 的測試使用臨時 Ephemeral_Database，用完即刪）、`bats deploy/tests` 與 `semgrep --test ci/semgrep`，確認全部通過，且 repository 中沒有任何秘密值。Ensure all tests pass, ask the user if questions arise.

- [x] 20. Build_Image 首次建置修正
  - [x] 20.1 Node.js 改用 `.tar.gz` 發行檔
    - 第一次 `infra/build-image`（commit 0080a1b）在 `ci/build-image/Dockerfile` 的 Node.js 步驟失敗：`mcr.microsoft.com/playwright:v1.56.1-noble` 沒有 `xz`，`tar -xJf` 回報 `xz: Cannot exec: No such file or directory`（校驗已通過）
    - 改下載 `node-v${NODE_VERSION}-linux-x64.tar.gz` 並以 `tar -xzf` 解壓；`NODE_SHA256=eeaccb0378b79406f2208e8b37a62479c70595e20be6b659125eb77dd1ab2a29`（nodejs.org/dist/v22.20.0/SHASUMS256.txt 的 linux-x64.tar.gz）；不另外以 apt 安裝套件；更新檔頭說明與 ARG 預設值的說明
    - 更新斷言 Node.js 下載檔名或格式的測試，執行 `bun test tests/ci-build-image-pipeline.test.js tests/ci-lint.test.js tests/ci-toolchain.test.js`
    - _Requirements: 3.1, 3.2_

  - [x] 20.2 固定 Build_Image digest
    - 第一次成功的 `infra/build-image`（commit 5e809e4）輸出 `registry.our-littlemoments.com:8443/little-moments/build-image@sha256:5d06fdee80abcbf8780a92d7cb33bf1d94d099b3d7917aa15125d6ececc2c72f`
    - 將 `Jenkinsfile`、`ci/jenkins/pipelines/rollback.Jenkinsfile`、`ci/jenkins/pipelines/restore-drill.Jenkinsfile`、`ci/jenkins/pipelines/digest-lookup.Jenkinsfile` 的 `BUILD_IMAGE` 由 `sha256:<digest>` 佔位符改為上述 digest，並把「PLACEHOLDER」註解改為說明 digest 來源（infra/build-image、commit 5e809e4）與更新方式；`build-image.Jenkinsfile` 不變
    - 更新斷言佔位符的測試（`tests/ci-lint.test.js`、`tests/ci-rollback-pipeline.test.js`、`tests/ci-digest-lookup.test.js` 等），改為斷言四個檔案使用同一個固定 digest 且格式為 64 位十六進位；保留「不得使用可變 tag」的檢查；搜尋 docs／README 中說明 BUILD_IMAGE 仍為佔位符的段落並同步更新
    - 執行 `bun test tests/ci-*.test.js`，確認全部通過
    - _Requirements: 3.1, 3.2_

- [x] 21. 同主機 Edge_Proxy（NPM + Cloudflare）部署
  - [x] 21.1 Caddy 只信任 Edge_Trusted_Proxies 的轉送標頭
    - 開始前以 Caddy 2.10 文件確認指令與預設行為：[全域選項](https://caddyserver.com/docs/caddyfile/options) 的 `trusted_proxies`、`trusted_proxies_strict`、`client_ip_headers`，[reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) 的 Defaults 與 headers；設計文件已依 v2.10.2 原始碼（`strictUntrustedClientIp`、`addForwardedHeaders`）整理行為表（design.md Components 第 18.2 節），與實測不符時以實測為準並回報
    - `deploy/caddy/Caddyfile`：全域 `servers` 加入 `trusted_proxies static {$LM_EDGE_TRUSTED_PROXIES:127.0.0.1/32}`、`trusted_proxies_strict`、`client_ip_headers X-Forwarded-For`（保留現有 `timeouts`）；站台在 `handle` 之前以 `@xfp_invalid`（有 `X-Forwarded-Proto` 但不是恰為 `http`／`https`）搭配 `request_header @xfp_invalid -X-Forwarded-Proto`；更新檔頭的環境變數說明
    - `deploy/caddy/upstream.caddy.tmpl`：`header_up X-Forwarded-For {client_ip}`，移除 `header_up X-Forwarded-Proto {scheme}` 改用 Caddy 預設（或等效的明確設定），更新註解（App 仍只採信 `PROXY_IP/32`）
    - `deploy/compose/compose.yaml`：proxy 的 `environment` 加入 `LM_EDGE_TRUSTED_PROXIES: ${LM_EDGE_TRUSTED_PROXIES:-127.0.0.1/32}`；app 的 `CAMPING_TRUSTED_PROXIES` 維持 `${PROXY_IP}/32`；更新檔頭網路說明
    - `deploy/compose/staging.env.example`：`LM_EDGE_TRUSTED_PROXIES=` 與 `LM_LAN_CIDR=` 皆為空並註明 Staging 不經 Edge_Proxy；`deploy/compose/prod.env.example`：`LM_PUBLIC_PORT=8082`（80／443 由 Edge_Proxy 使用；同步修正 HTTPS 範例註解中的 443）、`ALLOWED_HOSTS=<public-hostname>,<deploy-host-lan-ip>`、`LM_HEALTH_HOST=<public-hostname>`、`LM_EDGE_TRUSTED_PROXIES=<npm-docker-subnet> <cloudflare-ipv4-ranges> <cloudflare-ipv6-ranges>`、`LM_LAN_CIDR=<lan-cidr>`，只放佔位符並註明來源與更新方式
    - `deploy/bin/lm-deploy`：在 `load_config`（早於任何 `docker compose` 呼叫）依 design.md 第 18.4 節驗證 `LM_EDGE_TRUSTED_PROXIES` 與 `LM_LAN_CIDR`，失敗以結束碼 2（`config_invalid`）結束且只輸出無效項目；更新檔頭的檔案說明
    - 在釘選的 `caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d` 中以 `caddy adapt`／`caddy validate` 檢查 Caddyfile（含渲染後的 `upstream.caddy` 與 `tls-off.caddy`）在 `LM_EDGE_TRUSTED_PROXIES` 未設定、為空字串、為多個 IPv4／IPv6 CIDR 時皆可解析，含無效 CIDR 時失敗；沒有 Docker 時把指令與預期結果寫入任務回報與 runbook，列為手動檢查
    - 選用（需要 Docker）：以 Caddyfile 與回傳收到標頭的測試 upstream 啟動 Caddy，驗證受信任／不受信任來源、偽造最左側與多個 `X-Forwarded-For`、`X-Forwarded-Proto` 為 `https`／`ftp`／多值時，轉送的 `X-Forwarded-For` 恰為一個預期位址、`X-Forwarded-Proto` 符合 Req 25.2–25.5
    - 以 grep 找出 `tests/` 與 `deploy/tests/` 中斷言這些檔案內容的測試（例如 `tests/security-config.test.js` 的 `{remote_host}`／`{scheme}` 斷言、`deploy/tests/helpers/test_helper.bash` 產生的 `staging.env`）並更新；新增斷言：新指令存在、預設為 `127.0.0.1/32`、`upstream.caddy.tmpl` 不含 `{remote_host}`、App 的 Trusted_Proxies 仍為 `/32`、兩個 env 範本的 Edge 值（staging 空、prod 只含佔位符）與 `LM_PUBLIC_PORT=8082`
    - `deploy/tests/lm-deploy.bats` 新增 Edge_Trusted_Proxies 案例：空值、Cloudflare 形式清單、`0.0.0.0/0`、`::/0`、`::ffff:0:0/96`、`192.168.0.0/16` 與 `192.168.1.0/24`（`LM_LAN_CIDR=192.168.1.0/24`）、65 個項目、無效語法、非空但缺少 `LM_LAN_CIDR`；拒絕時確認 fake docker 未被呼叫
    - 執行受影響的 `bun test` 測試檔（例如 `bun test tests/security-config.test.js tests/ci-lint.test.js`），並比照先前在 WSL 下執行 `bats deploy/tests/lm-deploy.bats`
    - _Requirements: 9.12, 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7, 25.8, 25.9, 25.10, 25.11_

  - [x] 21.2 DOCKER-USER Public_Port 例外
    - `deploy/host/docker-user.rules`：在 `__LAN_CIDR__` 規則之後、DNAT DROP 之前新增 `-A DOCKER-USER -p tcp -m conntrack --ctstate DNAT --ctorigdstport __PUBLIC_PORT__ -j RETURN`，並更新檔頭的規則語意說明（Public_Port 放行任何來源、未宣告時為 0 行）
    - `deploy/host/install.sh`：新增選用 `--public-port <port>[,...]`（0..8 個、1..65535 的十進位整數、無前導零、不重複，格式錯誤在 root 檢查前以結束碼 2 結束）；在變更任何檔案前比對 `/srv/lm/<env>/<env>.env`（不存在且在 `--envs` 中時改用 `deploy/compose/<env>.env.example`）的 `LM_PUBLIC_PORT`，相同即以結束碼 2 結束並指出連接埠與環境；渲染時每個 Public_Port 一行、未指定時 0 行，檔頭註解列出 Public_Port；更新用法說明與 `usage_die`
    - `install.sh` 新增唯讀 `--render-rules` 模式（design.md 第 18.5 節）：執行相同的驗證與渲染後輸出到 stdout，不檢查 root、不寫檔、不呼叫 `iptables`／`systemctl`；僅此模式接受 `LM_SRV_ROOT` 覆寫
    - `deploy/host/verify-host.sh`：解析規則檔中的 Public_Port 規則並在其等於任一環境的 `LM_PUBLIC_PORT` 時 FAIL；新增選用 `--public-port <port>[,...]|none` 預期值比對（與 `--lan-cidr` 相同方式）；新增 `proxy` 檢查群組（依第 18.4 節規則檢查各環境的 `LM_EDGE_TRUSTED_PROXIES`／`LM_LAN_CIDR`，staging 設有 Edge 值或宣告了 Public_Port 但 prod Edge 值為空時 WARN）；更新檔頭說明
    - 以 `iptables-restore --test` 與套用後的 `iptables -S DOCKER-USER`（WSL 或測試容器）確認 Public_Port 規則的正規化輸出與樣板逐字相同；不同時修改樣板，並在任務回報中記錄實際輸出
    - 新增 `deploy/tests/install-host.bats`：以 `--render-rules` 與 `LM_SRV_ROOT` 測試無 `--public-port` 時輸出與現有規則相同、`--public-port 80,443` 的規則位於所有 LAN RETURN 之後與 DROP 之前且順序與輸入相同、無效連接埠（`0`、`65536`、`08`、`abc`、空項目、重複、9 個）與等於 staging／prod `LM_PUBLIC_PORT` 的連接埠皆以結束碼 2 拒絕；verify-host 的 Public_Port 解析與順序檢查以固定規則檔案例測試
    - 更新 `tests/deploy-host-config.test.js` 中逐行斷言 `docker-user.rules` 的測試，執行 `bun test tests/deploy-host-config.test.js`，並在 WSL 下執行 `bats deploy/tests`
    - _Requirements: 8.6, 8.8, 8.9, 8.10, 25.8_

  - [x] 21.3 註冊政策預設關閉並可由管理員切換
    - 依 design.md Components 第 19 節實作；開始前重新讀取 `server/settings.js`、`server/accounts.js`（`receiptAiPolicy()`、`settingsBody`、`getSession`、`register`、`inviteRegister`、`adminPatchSettings`）、`server/config.js`（`parseConfig`、`policySummary`）、`scripts/serve.mjs` 與 `src/accounts-ui.js` 的管理頁設定表單
    - `server/settings.js`：新增並匯出 `REGISTRATION_POLICIES`、`REGISTRATION_KEY = 'registrationPolicy'` 與 `resolveRegistrationPolicy(stored, seed)`（儲存值優先、無效儲存值為 `closed`、其次 seed、最後 `open`）；`server/config.js` 與 `server/accounts.js` 改從這裡匯入 `REGISTRATION_POLICIES`，`config.js` 保留 re-export
    - `server/config.js`：`CAMPING_REGISTRATION` 仍驗證為 `open`／`closed`（無效值只指出變數名稱），結果改為 `config.registrationPolicySeed`（未設定或空字串為 `null`）；`policySummary(config, receiptAiPolicy, registrationPolicy)` 輸出 `registration=<value> (<source>) receiptAiPolicy=<value> (<source>)`，來源為 `admin setting`、`CAMPING_REGISTRATION` 或 `default`，無效值顯示 `closed`
    - `server/accounts.js`：選項 `registrationPolicy` 改為 `registrationPolicySeed = null`（建構時驗證）；移除固定的 `registrationOpen`，新增每次讀取 Settings_Store 的 `registrationPolicy()`；`GET /api/session` 的 `registrationOpen` 與 `POST /api/register` 的 403（仍在限速器與讀取本文之前）改用實際生效值；`inviteRegister` 不變；`settingsBody` 回傳兩個政策（含 `options`）；`PATCH /api/admin/settings` 先驗證（兩個鍵都沒有或任一值無效為 400，不寫入），再於交易內只寫入出現的鍵，`registrationPolicy` 寫入稽核 `settings.registration`（`registrationPolicy:<value>`）；服務物件匯出 `registrationPolicy`
    - `scripts/serve.mjs`：以 `registrationPolicySeed: config.registrationPolicySeed` 建立帳號服務，啟動摘要傳入 `await accounts.registrationPolicy?.()`；更新選項註解
    - `src/accounts-ui.js`：「網站設定」表單加入 `setting-registration` 選單（開放／關閉）與依來源（儲存者與時間、`CAMPING_REGISTRATION`、預設 `open`）的說明文字；送出時只放入值有變更的欄位，沒有變更時顯示「沒有變更的設定。」且不送出；成功提示依變更的欄位為「公開註冊設定已更新」「收據 AI 設定已更新」或「網站設定已更新」並重新載入；`/register` 關閉頁維持讀取 `session.registrationOpen`
    - `deploy/compose/compose.yaml`：`x-app.environment` 加入 `CAMPING_REGISTRATION: ${CAMPING_REGISTRATION:-closed}` 並註明只是啟動初始值；`deploy/compose/staging.env.example` 與 `deploy/compose/prod.env.example` 加入 `CAMPING_REGISTRATION=closed` 與相同說明；`deploy/bin/lm-deploy` 的 `unset` 清單加入 `CAMPING_REGISTRATION`（`APP_ENV_KEYS` 不變）
    - 更新斷言舊介面的測試：`config.registrationPolicy`（`tests/config.test.js`、`tests/readme.test.js`）、以 `registrationPolicy:` 建立服務的測試（`tests/accounts.test.js`、`tests/publish.test.js`、`tests/security-headers.test.js`）、`policySummary` 的輸出格式，以及斷言 compose app 環境變數或 env 範本鍵的測試（`tests/security-config.test.js`、`tests/ci-lint.test.js`；`lm-deploy` 的 `unset` 清單若有斷言一併更新）；新增斷言：`CAMPING_REGISTRATION` 為 `${CAMPING_REGISTRATION:-closed}`、兩個 env 範本含 `CAMPING_REGISTRATION=closed`
    - 撰寫 Property 48 的 property test（`tests/settings.test.js`，`numRuns: 100`，標記註解 `// Feature: jenkins-cicd-deploy, Property 48: Registration_Policy 決定順序`）
      - **Property 48: Registration_Policy 決定順序**
      - **Validates: Requirements 26.1, 26.2**
    - API 測試（`tests/publish.test.js` 的 `registration policy` 區塊，使用 Ephemeral_Database）：同一個服務實例內管理員依序儲存 `closed`、`open`，每次儲存後的下一個 `POST /api/register` 與 `GET /api/session` 反映新值且不重新建立服務；Settings_Store 列與 `settings.registration` 稽核內容；seed `closed` 無儲存值時為 `closed`／`seed`，儲存 `open` 後 seed 不再生效；以 SQL 改為無效值時為 `closed`／`stored`；member 403；無效值與空本文 400 且兩個設定列與稽核不變；只含其中一個鍵時另一個設定不變；兩種政策下邀請註冊皆成功；關閉時被拒的 `/api/register` 不消耗限速
    - `tests/support/registration-lock.js`：以 Playwright `outputDir` 下的 `registration.lock`（`openSync(..., 'wx')`，60 秒逾時、100 ms 重試、`finally` 刪除）提供跨 worker 互斥；`tests/accounts-auth.e2e.js` 的 TC-AUTH-001 與 `tests/brand.e2e.js` 的 TC-BRAND-001 在使用 `/register` 的區段持有該鎖
    - 新增 `tests/admin-settings.e2e.js`：`[TC-ADMIN-004] admin closes and reopens public registration without restart`，持有註冊鎖，依 design.md「公開註冊政策（Req 26）」的 E2E 步驟驗證選單、說明文字、只送出 `registrationPolicy` 的本文、提示、未登入 context 的 `/register` 關閉頁與 `POST /api/register` 403，再改回開放並確認 `/register` 顯示表單；`finally` 以 API 存回 `open`
    - `qa/inventory.json` 新增 `QA-ADMIN-004`（page `/admin`、control `setting-registration`、role `admin`、`critical: false`、`unauthorized: false`、`testCases: ["TC-ADMIN-004"]`）；`qa/tc-map.md` 加入 TC-ADMIN-004
    - `README.md`：環境變數表的 `CAMPING_REGISTRATION` 列（Registration_Seed、App_Server 預設 `open`、Deploy_Host 經 `compose.yaml` 為 `closed`、管理員儲存後不再生效）；改寫「`CAMPING_REGISTRATION`……目前不由 `deploy/compose/compose.yaml` 傳入……因此 Deploy_Host 使用預設值」一句（`CAMPING_REGISTRATION` 改由 compose 傳入，其餘維持）；更新兩處 Registration policy 功能說明與啟動摘要範例；以編號步驟說明移除 Settings_Store 的 `registrationPolicy` 列以恢復 `CAMPING_REGISTRATION` 控制（只用佔位符）；同步更新 `tests/readme.test.js`
    - 執行受影響的 `bun test` 測試檔（例如 `bun test tests/settings.test.js tests/config.test.js tests/config-secrets.test.js tests/accounts.test.js tests/publish.test.js tests/security-access.test.js tests/security-auth.test.js tests/security-csrf.test.js tests/security-headers.test.js tests/security-config.test.js tests/ci-lint.test.js tests/readme.test.js`，需要 PostgreSQL 的測試使用臨時 Ephemeral_Database，用完即刪）；以 `scripts/check-accounts.mjs`（設定 `CAMPING_BUN` 與 `CHROME_PATH`）執行 E2E，確認 TC-ADMIN-004、TC-AUTH-001 與 TC-BRAND-001 通過；執行 `scripts/qa-inventory.mjs` 的 validate 與 compare，確認 `QA-ADMIN-004` 為 pass
    - _Requirements: 26.1, 26.2, 26.3, 26.4, 26.5, 26.6, 26.7, 26.8, 26.9, 26.10, 26.11, 26.12, 26.13, 26.14, 26.15, 26.16, 26.17, 26.18, 26.19, 26.20, 5.1, 5.4_

  - [x] 21.4 填入同主機部署值與文件
    - 開始編輯前，向使用者索取並確認下列只能由主機輸出得知的值，未確認前不得填入猜測值：Jenkins controller 的 LAN 連接埠（`ss -ltnp` 或 `docker ps` 的發布連接埠，用於 `LM_DAST_PROBE_TARGETS`）、Edge_Proxy 所在 Docker 網路的子網與 Docker 預設 `bridge` 的子網（`docker network inspect`，用於 runbook 的 `--lan-cidr` 範例）；Edge_Proxy 實際的來源位址只寫入 runbook 的確認步驟，不寫入 repository
    - `Jenkinsfile`：`LM_DEPLOY_HOST='192.168.1.121'`、`LM_DEPLOY_PORT='22'`、`LM_STAGING_URL='http://192.168.1.121:8081'`、`LM_PROD_URL='http://192.168.1.121:8082'`、`LM_STAGING_DB_NAME='little_moments_staging'`、`LM_PROD_DB_NAME='little_moments'`、`LM_DAST_PROBE_TARGETS='192.168.1.121:22 192.168.1.121:80 192.168.1.121:443 192.168.1.121:8081 192.168.1.121:8082 192.168.1.121:8443 192.168.1.121:<已確認的 Jenkins 連接埠>'`；移除這些變數的 PLACEHOLDER 註解並說明 Smoke_Test 經 LAN origin 執行（Host `192.168.1.121` 在 `ALLOWED_HOSTS` 內）
    - `ci/jenkins/pipelines/rollback.Jenkinsfile`、`ci/jenkins/pipelines/restore-drill.Jenkinsfile`：`LM_DEPLOY_HOST='192.168.1.121'`、`LM_DEPLOY_PORT='22'`，更新註解（known_hosts 須含 `192.168.1.121` 的主機金鑰）
    - 以 grep 找出斷言舊佔位符（`deploy-host.lan.example`、`<deploy-host-ip>`、`<registry-ip>`、`<jenkins-ip>`）的測試並改為斷言上述值，執行 `bun test tests/ci-*.test.js`
    - `ci/jenkins/README.md`：「仍待填入」移除已填入的部署主機值，保留需維運者確認的項目；新增 Edge_Proxy runbook 章節（或新增 `deploy/README.md` 並由 README 連結），以編號步驟涵蓋 design.md 第 18.6 節列出的內容：NPM Proxy Host（`www.our-littlemoments.com` → `http://192.168.1.121:8082`、Let's Encrypt、Force SSL、HSTS、不啟用 WebSocket）、Redirection Host（apex → `https://www.our-littlemoments.com`、301、保留路徑）、Cloudflare Proxied 與 SSL/TLS Full (strict)、Staging 不經 NPM 公開、Jenkins 只公開 `/github-webhook/`、`install.sh --lan-cidr 192.168.1.0/24,<npm-subnet>,<docker-bridge-subnet> --public-port 80,443`（或 NPM 改用 host 網路）、以 LM_Proxy 存取日誌確認 Edge_Proxy 來源位址後填入 `LM_EDGE_TRUSTED_PROXIES`、Cloudflare 範圍的更新（`https://www.cloudflare.com/ips-v4`、`https://www.cloudflare.com/ips-v6` → 比對 → 更新 `prod.env` → `docker compose … up -d --no-deps proxy` → 確認存取日誌記錄真實用戶端 IP）、`verify-host.sh --public-port 80,443`
    - 根目錄 `README.md` 的「LAN 部署」：改寫「公開網際網路曝露不在支援範圍內」與「唯一的例外」兩段，說明 Production 只經 Edge_Proxy 公開、Staging／Registry／Deploy_Host 僅限 LAN、Jenkins 只公開 `/github-webhook/`，並連結 runbook；不加入任何 digest 或秘密值；同步更新 `tests/readme.test.js` 中相關斷言
    - 執行 `bun test tests/readme.test.js tests/ci-jenkins-config.test.js tests/ci-*.test.js`
    - _Requirements: 2.6, 8.6, 8.8, 24.3, 25.11, 25.12, 25.13_

  - [x] 21.5 Checkpoint - 同主機 Edge_Proxy 變更後確認所有測試通過
    - 執行 `bun run build`、`bun test tests/*.test.js`（需要 PostgreSQL 的測試使用臨時 Ephemeral_Database，用完即刪）、`bats deploy/tests`（WSL）、`semgrep --test ci/semgrep` 與秘密掃描（`bun scripts/scan-secrets.mjs`），確認全部通過，且 repository 中沒有任何秘密值或主機上才有的實際 Edge 設定（Cloudflare 範圍、Edge_Proxy 來源位址）。Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 8.6, 8.8, 8.9, 8.10, 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7, 25.8, 25.9, 25.10, 25.11, 25.12, 25.13, 26.1, 26.2, 26.3, 26.4, 26.5, 26.6, 26.7, 26.8, 26.9, 26.10, 26.11, 26.12, 26.13, 26.14, 26.15, 26.16, 26.17, 26.18, 26.19, 26.20_

- [x] 22. Deploy_Host 相容 sudo-rs
  - [x] 22.1 sudoers 與 verify-host 支援 sudo-rs
    - 背景與設計見 design.md Components 第 20 節：192.168.1.121 使用 `sudo-rs 0.2.13-0ubuntu1.2`，`install.sh` 在 `visudo -cf` 回報 `unknown setting: 'requiretty'` 後停止；帳號、`/opt/lm/bin/lm-deploy`、`/srv/lm/<env>`、備份目錄與 DOCKER-USER 規則已安裝，sudoers 與 `authorized_keys` 未安裝
    - 開始前以 sudo-rs v0.2.13（github.com/trifectatechfoundation/sudo-rs，tag `v0.2.13`：`docs/man/sudoers.5.md`、`docs/man/sudo.8.md`、`docs/man/visudo.8.md`、`src/defaults/mod.rs`、`src/sudoers/` parser、`src/sudo/cli/`、`src/visudo/`）逐項確認第 20.1 節表格中的設定與寫法是否支援：`!lecture`、`Defaults!<cmd>` 的 per-command `env_keep`（含執行時是否實際套用）、完整比對參數的 `Cmnd_Alias`、`User_Alias`、`(root) NOPASSWD:`、`sudo -n`、`sudo -l -U`、`visudo -c`／`-cf`，以及 `/etc/sudoers-rs` 與 `/etc/sudoers` 的讀取順序；把結果（含檔案與行號）記錄在任務回報
    - `deploy/host/sudoers.d/lm-deploy`：移除 `!requiretty`；其他寫法依確認結果保留或改為等效的支援寫法（例如 per-command Defaults 不支援時改為 `Defaults:LM_DEPLOY_STAGING_USERS,LM_DEPLOY_PROD_USERS env_keep += "SSH_ORIGINAL_COMMAND"`），使檔案在傳統 sudo 與 sudo-rs 0.2.13 上都通過 `visudo -cf` 且語意相同（每個部署帳號只能以 root、免密碼執行 `lm-deploy <自己的環境>`，只額外保留 `SSH_ORIGINAL_COMMAND`）；更新檔頭註解
    - `deploy/host/verify-host.sh`：以 `LC_ALL=C` 執行 `sudo -n -l -U`，同一個解析器接受傳統 sudo 與 sudo-rs 0.2.13 的輸出格式（sudo-rs 格式依原始碼推導，例如 `src/sudo/pipeline/list.rs` 與 `src/sudoers/entry.rs` 的列印邏輯），仍要求恰好一個以 root、NOPASSWD 執行 `/opt/lm/bin/lm-deploy <env>` 的指令且沒有其他項目；保留 `visudo -c`；若確認 sudo-rs 在 `/etc/sudoers-rs` 存在時改讀該檔，檢查它也載入 `/etc/sudoers.d`；更新檔頭說明
    - `deploy/host/install.sh`：預期不需改變行為；若用到 sudo-rs 不支援的 sudo／visudo 選項則調整；若確認 `/etc/sudoers-rs` 優先，`@includedir /etc/sudoers.d` 檢查改為針對實際生效的檔案
    - 測試：以 grep 找出 `tests/` 與 `deploy/tests/` 中斷言 sudoers 內容的測試（例如 `tests/deploy-host-config.test.js`）並更新；新增靜態斷言 sudoers 檔不含 `requiretty`；新增 bats 案例，以傳統 sudo 與 sudo-rs 兩種格式的固定 `sudo -l -U` 樣本測試 verify-host 的解析（PASS 與 FAIL 案例見 design.md Testing Strategy「冒煙與設定檢查」）；verify-host 若已有可測試的模式（例如 `--check-rules`）則擴充，只有必要時才新增等效的唯讀解析掛勾
    - 若 WSL 有傳統 `visudo`，對檔案執行 `visudo -cf`；若能在 WSL 或測試容器取得 sudo-rs（例如 apt 套件 `sudo-rs`），也以它的 `visudo -cf` 驗證；都無法取得時在任務回報與 runbook 寫明維運者手動檢查：`sudo visudo -cf deploy/host/sudoers.d/lm-deploy`，接著重新執行 `install.sh`，再執行 `sudo -l -U lm-deploy-staging`
    - 執行 `bun test tests/deploy-host-config.test.js` 與 WSL 下的 `bats deploy/tests`
    - _Requirements: 15.9_

  - [x] 22.2 Checkpoint - sudo-rs 相容變更後確認所有測試通過
    - 執行受影響的 `bun test` 測試檔、WSL 下的 `bats deploy/tests` 與秘密掃描（`bun scripts/scan-secrets.mjs`），確認全部通過且沒有任何秘密值。Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 15.9_

## Notes

- 標記 `*` 的子任務為選用（property test、整合測試與額外檢查），可為加快 MVP 而略過。
- 每個任務都標註對應的需求編號以便追蹤；Property 編號對應設計文件「Correctness Properties」。
- 任務 1–3 期間仍使用 SQLite，使既有測試保持綠燈；任務 5 完成後 runtime 不再載入 `bun:sqlite`（SQLite_Importer 為獨立維運工具）。
- 需要 PostgreSQL 的測試透過 `CAMPING_TEST_DATABASE_*` 連線至 Ephemeral_Database，本機建立方式見 README。
- Jenkins、Deploy_Host 與 Registry 任務只產出設定檔、腳本與驗證腳本，實際套用到主機由維運者執行。
- 任務 19 的值來自 192.168.1.121 上已驗證的部署（Jenkins controller、lm-trusted-1、lm-untrusted-1 與 LAN Registry）；design.md 中 Untrusted Agent 的「隔離 VLAN」在此部署以 rootless Docker 加主機 owner 防火牆實作。
- 任務 21 依同主機配置（Deploy_Host = Jenkins = Registry = `192.168.1.121`）讓 Production 經 Nginx Proxy Manager 與 Cloudflare 公開；Edge_Proxy 與 Cloudflare 的設定是維運操作，repository 只提供設定檔、驗證與 runbook。Requirement 8.8–8.10 與 25 沒有新的 Correctness Property（行為由 Caddy 與主機上的 bash 腳本實作），以設定檢查、bats 與 Caddy 實測驗證。任務 21.3 依 Requirement 26 讓 Deploy_Host 的公開註冊預設關閉並可由管理員在 `/admin` 切換，新增 Property 48。
- 任務 22 來自 192.168.1.121 上 `install.sh` 的 sudoers 步驟失敗（sudo-rs 0.2.13 不支援 `requiretty`）；Requirement 15.9 的行為不變，沒有新的 Correctness Property，以靜態檢查、bats 固定樣本與 `visudo -cf` 驗證。
- 任務 18 合併 security-harden：兩分支沒有共同歷史，以 main 的 `cd06606` 作為合成共同基底進行三方合併；應用程式功能採用 security-harden，部署、設定模型、Setup_Token 與 PostgreSQL 資料層採用 main；收據 AI 改為 OpenAI（`CAMPING_OPENAI_*`）。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "3.1", "5.2", "10.1", "10.8", "10.10"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "2.1", "3.10", "5.3", "10.2", "10.3", "10.4", "10.9", "10.11"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5", "3.2", "3.3", "5.4", "5.5", "5.8", "10.5", "10.6"] },
    { "id": 3, "tasks": ["3.4", "3.5", "3.6", "3.7", "3.8", "3.9", "5.9", "10.7", "10.12"] },
    { "id": 4, "tasks": ["5.1", "5.10", "10.13", "10.14"] },
    { "id": 5, "tasks": ["5.6", "5.7", "5.11", "5.12", "7.1", "10.15", "10.16", "10.17", "10.18", "10.19", "10.20"] },
    { "id": 6, "tasks": ["5.13", "5.14", "10.21", "10.22", "10.23", "10.24", "10.26", "10.29", "10.31", "10.33"] },
    { "id": 7, "tasks": ["5.15", "5.16", "5.17", "7.2", "10.25", "10.27", "10.28", "10.30", "10.32"] },
    { "id": 8, "tasks": ["7.3", "7.4", "7.5", "7.6", "8.1", "8.3", "8.4"] },
    { "id": 9, "tasks": ["8.2", "8.5", "8.6", "8.7", "8.8", "12.1"] },
    { "id": 10, "tasks": ["12.2", "14.1", "15.1"] },
    { "id": 11, "tasks": ["12.3", "13.1", "14.2", "15.2"] },
    { "id": 12, "tasks": ["13.2", "14.3", "14.6", "14.7"] },
    { "id": 13, "tasks": ["13.3", "14.5"] },
    { "id": 14, "tasks": ["13.4", "14.4"] },
    { "id": 15, "tasks": ["13.5"] },
    { "id": 16, "tasks": ["13.6"] },
    { "id": 17, "tasks": ["13.7"] },
    { "id": 18, "tasks": ["13.8"] },
    { "id": 19, "tasks": ["13.9", "13.10"] },
    { "id": 20, "tasks": ["16.1", "16.2"] },
    { "id": 21, "tasks": ["16.3"] },
    { "id": 22, "tasks": ["18.1", "18.2"] },
    { "id": 23, "tasks": ["18.3"] },
    { "id": 24, "tasks": ["18.4"] },
    { "id": 25, "tasks": ["18.5"] },
    { "id": 26, "tasks": ["18.6"] },
    { "id": 27, "tasks": ["18.7"] },
    { "id": 28, "tasks": ["18.8"] },
    { "id": 29, "tasks": ["18.9", "18.10"] },
    { "id": 30, "tasks": ["19.1", "19.4"] },
    { "id": 31, "tasks": ["19.2"] },
    { "id": 32, "tasks": ["19.3"] },
    { "id": 33, "tasks": ["19.5"] },
    { "id": 34, "tasks": ["19.6"] },
    { "id": 35, "tasks": ["20.1"] },
    { "id": 36, "tasks": ["20.2"] },
    { "id": 37, "tasks": ["21.1"] },
    { "id": 38, "tasks": ["21.2"] },
    { "id": 39, "tasks": ["21.3"] },
    { "id": 40, "tasks": ["21.4"] },
    { "id": 41, "tasks": ["21.5"] },
    { "id": 42, "tasks": ["22.1"] },
    { "id": 43, "tasks": ["22.2"] }
  ]
}
```
