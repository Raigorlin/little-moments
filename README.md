# 日子拾光 · LITTLE MOMENTS

A local camping planner with a Traditional Chinese interface, original SVG illustrations, account-specific trips and shared planning.

This repository contains source code only. It contains no real accounts, trips, receipt images, database, backups or credentials. It is independent of the original inspiration site and does not connect to it.

## Features

- Separate accounts, trip histories, invitations and administrator controls.
- Itinerary stops for everyone, one vehicle or multiple vehicles, with per-car filtering and independent arrivals.
- A countdown centered on the camping illustration; restrained animation with pause and reduced-motion support.
- Meal templates, automatic illustrations and ingredient-to-shopping synchronization. The meal-image selector is hidden; previews and saved image choices are preserved.
- Personal and shared gear with common camping presets.
- New Taiwan dollar expense splitting and repayment records.
- Browser-local receipt OCR with Traditional Chinese and English models. Recognition always requires review before saving.
- Light/dark themes, responsive layouts and a separate fictional browser-only demo.

以下維運章節以繁體中文撰寫，與 `ci/jenkins/README.md` 及 `.kiro/specs/jenkins-cicd-deploy/` 的用語一致。本文件中所有 `<...>`、`*.example`、`*.invalid` 皆為佔位符，不是實際值。

## 本機執行

需要 **Bun 1.3+**（版本以 `ci/toolchain.json` 為準）與一個 PostgreSQL 17 Database。資料改存於 PostgreSQL；`CAMPING_DB`（舊 SQLite 路徑）已不再讀取，設定時只會輸出警告。

1. 安裝與建置前端：

   ```sh
   bun install --frozen-lockfile
   bun run build
   ```

2. 建立本機開發用 Database（只綁定 `127.0.0.1`，不要改成 `0.0.0.0`）：

   ```sh
   docker run -d --name lm-dev-db -e POSTGRES_DB=little_moments -e POSTGRES_PASSWORD='<password>' \
     -p 127.0.0.1:<port>:5432 -v lm-dev-pgdata:/var/lib/postgresql/data postgres:17
   ```

3. 在同一個 shell 設定連線變數、套用遷移並啟動（PowerShell）：

   ```powershell
   $env:CAMPING_DATABASE_HOST = '127.0.0.1'
   $env:CAMPING_DATABASE_PORT = '<port>'
   $env:CAMPING_DATABASE_NAME = 'little_moments'
   $env:CAMPING_DATABASE_USER = 'postgres'
   $env:CAMPING_DATABASE_PASSWORD = '<password>'
   bun scripts/migrate.mjs
   bun run start
   ```

   bash：

   ```sh
   export CAMPING_DATABASE_HOST=127.0.0.1 CAMPING_DATABASE_PORT='<port>' CAMPING_DATABASE_NAME=little_moments \
     CAMPING_DATABASE_USER=postgres CAMPING_DATABASE_PASSWORD='<password>'
   bun scripts/migrate.mjs && bun run start
   ```

4. 開啟 `http://127.0.0.1:5173/setup` 建立自己的管理員帳號。**沒有預設管理員密碼**。之後登入用 `/login`、註冊用 `/register`、管理頁為 `/admin`。預設連接埠為 5173，可用 `PORT` 改變。

## 環境變數

App_Server（`scripts/serve.mjs`，映像中為 `/app/server/serve.js`）啟動時以 `server/config.js` 的 `parseConfig` 驗證下列變數。任何錯誤都只輸出「變數名稱＋原因」，不輸出值，並在連線 Database 或監聽任何連接埠之前以結束碼 2 結束；Database 在 30 秒內（1–5 秒間隔重試）仍無法連線時以結束碼 3 結束，訊息只含主機與連接埠。啟動成功時只輸出一行 `bind=… port=… allowedHosts=…`，不含任何秘密。

<!-- env-table:start -->
| 名稱 | 用途 | 必填 | 預設值 | 未設定時 |
|---|---|---|---|---|
| `CAMPING_BIND_ADDRESS` | Bind_Address：監聽的 IP 位址字面值（IPv4 或 IPv6） | 否 | `127.0.0.1` | 只監聽 loopback。值不是有效 IP 位址時拒絕啟動 |
| `PORT` | 監聽連接埠（1–65535） | 否 | `5173` | 使用 5173。值無效時拒絕啟動 |
| `CAMPING_ALLOWED_HOSTS` | Allowed_Hosts：逗號分隔的允許 Host（主機名稱、IPv4 或 `[IPv6]`；最多 32 項、每項最多 253 字元、不得含空項或 `*`）。不符的請求回應 HTTP 421 | Bind_Address 不是 loopback 時必填 | `127.0.0.1,localhost,[::1]` | loopback Bind_Address：使用預設值。**非 loopback Bind_Address：拒絕啟動**（結束碼 2，錯誤指出 `CAMPING_ALLOWED_HOSTS`，不監聽任何連接埠） |
| `CAMPING_SETUP_TOKEN` | Setup_Token：非 loopback Bind_Address 時首次建立管理員所需的設定碼（至少 32 字元），建立成功後失效 | 否 | — | loopback Bind_Address：不啟用，首次設定改為只接受 loopback 用戶端。**非 loopback Bind_Address：每次啟動自動產生 256 位元設定碼，只輸出一次至 App 程序的 stdout（Deploy_Host 本機的容器日誌）**，不寫入 Database、Build_Record 或 HTTP 回應。設定值少於 32 字元時拒絕啟動 |
| `CAMPING_TRUSTED_PROXIES` | Trusted_Proxies：逗號分隔的 IP／CIDR；只採信這些來源送來的 `X-Forwarded-*` | 否 | 空 | 不採信任何轉送標頭。含空項、`*` 或無效位址時拒絕啟動 |
| `CAMPING_DATABASE_HOST` | Database 主機 | 是 | — | 拒絕啟動，錯誤逐一列出缺少的 `CAMPING_DATABASE_*` 名稱 |
| `CAMPING_DATABASE_PORT` | Database 連接埠 | 否 | `5432` | 使用 5432。值無效時拒絕啟動 |
| `CAMPING_DATABASE_NAME` | Database 名稱 | 是 | — | 拒絕啟動（同上） |
| `CAMPING_DATABASE_USER` | Database 帳號 | 是 | — | 拒絕啟動（同上） |
| `CAMPING_DATABASE_PASSWORD` | Database 密碼（只由 Credential_Store 提供） | 是 | — | 拒絕啟動（同上） |
| `CAMPING_DATABASE_SSLMODE` | Database TLS 模式：`disable`、`require` 或 `verify-full` | 否 | `disable` | 不使用 TLS（Compose 內部網路）。其他值拒絕啟動 |
| `CAMPING_DIST` | 前端建置成品目錄（相對路徑以工作目錄為基準） | 否 | `dist` | 使用 `dist`。目錄內沒有 `index.html` 時拒絕啟動 |
| `CAMPING_MIGRATIONS_DIR` | 遷移目錄（`scripts/migrate.mjs`、`scripts/import-sqlite.mjs` 使用） | 否 | 腳本上一層的 `migrations/` | repository 中為 `migrations/`；映像中為 `/app/migrations` |
| `CAMPING_BEDROCK_REGION`、`CAMPING_BEDROCK_MODEL_ID`、`CAMPING_BEDROCK_API_KEY` | 雲端 AI 收據辨識（暫停、預設停用） | 否 | 空 | 停用。三者皆有效時才會啟用；所有環境預設維持空字串 |
<!-- env-table:end -->

`CAMPING_DB` 不是設定欄位：設定時只輸出警告，值不會被讀取或輸出。

工具與測試使用的變數（不影響 App_Server）：

| 名稱 | 使用者 | 說明 |
|---|---|---|
| `CAMPING_TEST_DATABASE_HOST`、`_PORT`、`_NAME`、`_USER`、`_PASSWORD`、`_SSLMODE` | `bun test`、`scripts/check-accounts.mjs`、`scripts/security-suite.mjs` | 測試只讀這組變數，從不讀 `CAMPING_DATABASE_*`。HOST／NAME／USER／PASSWORD 必填，PORT 預設 `5432`、SSLMODE 預設 `disable`；未設定時明確失敗並列出變數名稱（不會靜默略過） |
| `CHROME_PATH`、`CAMPING_BUN` | 瀏覽器測試、安全測試 | Chromium／Chrome 與 Bun 可執行檔的絕對路徑，沒有預設值 |
| `CAMPING_SECURITY_LAN_BIND` | `scripts/security-suite.mjs` | `lan` 組的 Bind_Address，預設 `127.0.0.1`。開發機請維持預設；只有在隔離的 `--internal` Docker 網路中才設為 `0.0.0.0` |
| `CAMPING_SMOKE_BASE_URL`、`CAMPING_SMOKE_HOST`、`CAMPING_SMOKE_USERNAME`、`CAMPING_SMOKE_PASSWORD_FILE` | `scripts/smoke.mjs` | Smoke_Test 的目標 origin、Host 覆寫、合成帳號（預設 `smoke-bot`）與密碼檔 |

## 資料與安全

- 預設只綁定 `127.0.0.1`，並只接受 loopback Host；loopback 綁定時首次管理員設定只接受 loopback 用戶端。非 loopback 綁定時必須設定 Allowed_Hosts，首次設定另需 Setup_Token。
- Sessions 使用 HttpOnly cookies；密碼以加鹽 scrypt 雜湊。變更資料的請求需要完全相符的 Origin 與對應的帳號／行程權限。
- 帳號 API 回應不會被快取供離線使用。`/demo/#/trip` 的虛構示範使用獨立的瀏覽器本機儲存。
- App 不保存收據影像或 OCR 原始文字。OCR 資源由本機提供、按需載入。
- 雲端 AI 收據辨識**已暫停且預設停用**，所有 `CAMPING_BEDROCK_*` 保持空白。若 Release_Approver 決定為特定環境啟用，值只能來自 `release/` 資料夾的 Credential_Store（見 `ci/jenkins/README.md`）。
- 首頁 JSON 匯入控制項仍隱藏。行程匯出與費用匯出各自獨立，都不能取代完整的 Database 備份。

### 憑證來源

- Database 憑證、Setup_Token、Registry 憑證、Deploy_Host 部署憑證、smoke 帳號密碼與 `CAMPING_BEDROCK_API_KEY` **只由 Credential_Store 提供**（Jenkins 資料夾範圍憑證，ID 與秘密檔位置見 [`ci/jenkins/README.md`](ci/jenkins/README.md)）。
- 這些值**不得寫入 repository 或 App_Image**。Deploy_Host 上的 `/srv/lm/<env>/app.env` 與 `db.env` 為 0600 root，由 Pipeline 經 `lm-deploy <env> app-env`（stdin）或維運者依 `deploy/compose/*.env.example` 建立；範本中的佔位符不得直接使用。
- 本機測試用的 Database 密碼只放在目前 shell 的環境變數中，不要寫入任何檔案。

## LAN 部署

部署架構：Jenkins（`Jenkinsfile`、`ci/jenkins/`）建置並簽章 App_Image，推送至 LAN Registry（`deploy/registry/`），再經 SSH forced command 呼叫 Deploy_Host 上的 `/opt/lm/bin/lm-deploy`，以 Docker Compose（`deploy/compose/compose.yaml`）做 blue/green 切換。Caddy proxy（`deploy/caddy/`）是唯一發布連接埠的服務；App 容器以 `CAMPING_BIND_ADDRESS=0.0.0.0` 在 internal 網路內監聽，`CAMPING_ALLOWED_HOSTS` 取自 `<env>.env` 的 `ALLOWED_HOSTS`，`CAMPING_TRUSTED_PROXIES` 只設為 proxy 的固定 `/32`；Database 不發布任何連接埠。

**存取範圍只限區域網路：**

- proxy 只綁定 `<env>.env` 的 `LAN_IP`。`deploy/host/install.sh --lan-cidr <CIDR>` 安裝的 DOCKER-USER 規則（`deploy/host/docker-user.rules`）只允許來源位於設定 LAN 網段的主機連線至 Docker 發布的連接埠，網段外來源無法建立 TCP 連線（規則位於 Docker 轉送層，UFW／INPUT 規則擋不住 Docker 發布的連接埠）。
- 安裝後以 `sudo deploy/host/verify-host.sh --lan-cidr <CIDR>` 確認防火牆、Database 未發布、備份目錄權限與部署帳號設定。
- **公開網際網路曝露不在支援範圍內**，包含路由器連接埠轉發、對外公開的反向代理、以及任何通道服務（tunnel）。不要為了對外公開而移除 Allowed_Hosts、Setup_Token 或 LAN 網段限制。

首次管理員設定：Pipeline 由 Credential_Store 提供 `CAMPING_SETUP_TOKEN`（`lm-<env>-setup-token`）。若 `app.env` 未設定，App 每次啟動自動產生設定碼並只寫入容器日誌，只能在 Deploy_Host 本機以 `sudo docker logs lm-<env>-app-<color>-1 2>&1 | grep Setup_Token` 讀取；建立管理員後即失效。

Staging 與 Production 是兩個獨立的 Compose 專案（`lm-staging`、`lm-prod`），不共用 Database、資料卷、網路或部署憑證。

## SQLite_Importer：從舊版 SQLite 匯入

`scripts/import-sqlite.mjs`（映像中為 `/app/tools/import-sqlite.js`）把舊版 `accounts.sqlite` 一次性匯入空的 PostgreSQL Database。它只開啟來源的暫存複本，不修改來源檔案；目標由 `CAMPING_DATABASE_*` 指定。目標 Database 必須是新的：已套用遷移，但**尚未**在 `/setup` 建立任何帳號。

1. 停止舊版 SQLite App 的所有寫入者，再完整備份來源：把 `accounts.sqlite` 與同目錄的 `accounts.sqlite-wal`、`accounts.sqlite-shm`（若存在）一起複製到 repository 以外的私人目錄。不要在仍有寫入者時只複製主檔。
2. 備份目標 Database。Deploy_Host 上：`sudo /opt/lm/bin/lm-deploy <env> backup`（記下輸出的 `id`）；本機：`pg_dump -Fc` 至私人目錄。
3. 執行匯入：

   ```sh
   # repository（目標 Database 可直接連線時；CAMPING_DATABASE_* 已設定於目前 shell）
   bun scripts/import-sqlite.mjs --source <path>/accounts.sqlite
   ```

   Database 只在 Deploy_Host 的 internal 網路中，因此在 Deploy_Host 上改以 App_Image 在同一 Compose 專案內執行（`<image>` 為 `<LM_IMAGE_REPO>@sha256:<digest>`，通常是目前作用中的 digest）：

   ```sh
   sudo env LM_ENV=<env> APP_IMAGE_BLUE=<image> APP_IMAGE_GREEN=<image> APP_IMAGE_NEW=<image> \
     docker compose --project-directory /srv/lm/<env> -f /srv/lm/<env>/compose.yaml --env-file /srv/lm/<env>/<env>.env \
     --profile ops run --rm --no-deps -T -v <source-dir>:/import:ro --entrypoint bun migrate \
     /app/tools/import-sqlite.js --source /import/accounts.sqlite
   ```

   容器以 UID 10001 執行，來源檔必須可被該 UID 讀取；暫存複本寫在容器的 `/tmp`（tmpfs 16 MiB），來源（含 `-wal`）較大時請改用 repository 方式。此指令未在實際 Deploy_Host 上驗證，首次使用前先在 Staging 試做。
4. 比對輸出：成功時輸出 `table source target` 標題與每個資料表一行，**每一行的 source 與 target 筆數都必須相同**，結束碼為 0。
5. 以既有使用者帳號在 `/login` 登入，確認行程、成員與費用都看得到。

失敗處理（錯誤訊息只含資料表／欄位名稱與原因類別，不含資料內容或密碼）：

| 結束碼 | 意義 | 目標 Database 狀態 |
|---|---|---|
| 2 | 參數或 `CAMPING_DATABASE_*` 設定錯誤 | 未連線 |
| 3 | 來源不存在、不是 SQLite，或缺少必要資料表／欄位 | 未連線 |
| 4 | 目標任一資料表已有資料（例如已建立使用者），中止匯入 | 未寫入任何資料 |
| 5 | 讀取或寫入失敗，輸出失敗的資料表名稱 | 整筆交易已回復，維持匯入前狀態 |
| 6 | 提交前筆數比對不符，輸出各資料表筆數 | 整筆交易已回復 |
| 7 | 匯入期間來源檔或來源目錄被改變 | 匯入前偵測到時已回復；結束時才偵測到則匯入已提交，需重新確認 |
| 1 | 連線、遷移或其他執行錯誤 | 匯入交易未提交 |

後續處理：

1. 依輸出的資料表名稱與原因修正問題（例如重新從步驟 1 的備份取得完整來源、修正連線設定）。
2. 結束碼 4：確認目標確實是要匯入的新 Database；若只是誤建了帳號，以步驟 2 的備份還原（或重建空的 Database）後再匯入，不要手動刪除資料。
3. 結束碼 5、6：目標已自動回復，修正後直接從步驟 3 重新執行。
4. 結束碼 7：確認舊版 App 已完全停止後重新執行；若匯入已提交，依步驟 4、5 驗證，有疑慮時以步驟 2 的備份還原後重做。
5. 驗證完成前保留來源與目標的備份。

## 手動回滾（Production）

回滾只會切換至 Deploy_Host 保留的最近 3 個 Image_Digest 之一，**不執行 Migration_Runner，Database Schema 保持不變**（遷移遵循 expand/contract，舊映像必須能在目前 Schema 上執行）。

1. 以 Release_Approver 帳號（`lm-release-approvers` 群組且列於 `ci/release-approvers.json`）在 Jenkins 開啟 `release/rollback`，按 Build。其他帳號觸發會被拒絕。
2. Pipeline 經 SSH 執行 `lm-deploy prod status`，列出可回滾目標：保留集合中、但不是目前作用中版本的 digest。
3. 在 `input` 中選擇目標 `digest` 並填寫回滾理由後送出；送出者必須是觸發建置的同一個 Release_Approver。需要對照 digest 與版本時，可用 `release/digest-lookup` 查詢 Build_Record。
4. Pipeline 取得 `lm-prod` 鎖；若已有部署進行中，建置會以「已有部署進行中」失敗，待部署結束後重新執行。
5. Deploy_Host 執行 `lm-deploy prod rollback <digest>`：在閒置槽位啟動目標映像 → 健康檢查 → 切換 proxy → 切換後 120 秒內連續 3 次健康檢查成功 → `finalize`。
6. 確認建置成功，並在 Build_Record 檢查觸發者、來源與目標 digest、理由與完成時間。若切換後健康檢查失敗，Pipeline 標記失敗且不再自動切換，需人工檢查（`sudo /opt/lm/bin/lm-deploy prod status`）。

## 備份與還原

`lm-deploy <env> backup` 以 `pg_dump -Fc` 建立備份，驗證大小、`pg_restore --list` 與 sha256 後存放於 `/var/backups/little-moments/<env>/`（lm-ops 擁有、0700，不在 Docker 卷或 repository 內）。備份識別碼格式為 `<env>-<YYYYMMDD>T<HHMMSS>Z-<sha7>`；同名 `.dump.sha256` 存在即代表已驗證。Production 保留最近 14 份。`release/restore-drill` 每月 1 日與 15 日把最新備份還原至隔離的 drill 專案並執行 Smoke_Test，不影響 Production。

`lm-deploy` 沒有 restore 子命令；下列為在 Deploy_Host 上以 root 執行的手動程序（未在實際 Deploy_Host 上驗證，建議先在 Staging 演練）。還原期間 App 會停止服務。`<env>` 為 `prod` 或 `staging`，`<POSTGRES_USER>`、`<POSTGRES_DB>` 為 `/srv/lm/<env>/db.env` 中的名稱（不要輸出密碼）。

1. 確認沒有進行中的部署：`sudo /opt/lm/bin/lm-deploy <env> status`，`deployInProgress` 必須為 `false`、`phase` 為 `idle`；記下 `active.color` 與 `active.digest`。
2. 從保留的備份中選擇 `<backup-id>`（最多 14 份）：`sudo ls -1 /var/backups/little-moments/<env>/ | grep '\.dump\.sha256$'`。
3. 驗證校驗碼：`sudo sh -c 'cd /var/backups/little-moments/<env> && sha256sum -c <backup-id>.dump.sha256'`。
4. 把選定備份複製到 root 私人目錄（下一步的新備份會修剪最舊的一份）：`sudo install -d -m 0700 /root/lm-restore && sudo cp -p /var/backups/little-moments/<env>/<backup-id>.dump /root/lm-restore/`。
5. 備份目前狀態以便復原：`sudo /opt/lm/bin/lm-deploy <env> backup`，記下輸出的 `id`。
6. 停止 App 容器：`sudo docker ps --filter label=com.docker.compose.project=lm-<env>` 找出 `lm-<env>-app-blue-1`／`lm-<env>-app-green-1`，再 `sudo docker stop <container>`。
7. 執行還原（單一交易；失敗時 Database 維持原狀）：

   ```sh
   sudo sh -c 'docker exec -i lm-<env>-db-1 pg_restore --clean --if-exists --no-owner --no-privileges \
     --exit-on-error --single-transaction -U <POSTGRES_USER> -d <POSTGRES_DB> < /root/lm-restore/<backup-id>.dump'
   ```

8. 補齊備份之後才加入的遷移：`sudo /opt/lm/bin/lm-deploy <env> migrate <active-digest>`（需要步驟 5 的一小時內備份）。
9. 啟動 App 並等待健康：`sudo docker start lm-<env>-app-<active-color>-1`，再 `sudo /opt/lm/bin/lm-deploy <env> health <active-color> --wait`。
10. 在 LAN 內的 repository checkout 執行 Smoke_Test，結束碼必須為 0（`CAMPING_SMOKE_BASE_URL` 為 proxy 的 origin，依 `LM_TLS_MODE` 為 `https://` 或 `http://`；smoke-bot 帳號與 smoke-fixture 行程須存在於還原後的資料中）：

    ```sh
    CAMPING_SMOKE_BASE_URL='https://<lan-hostname>' CAMPING_SMOKE_PASSWORD_FILE='<path-to-smoke-password-file>' bun scripts/smoke.mjs
    ```

11. 刪除暫存複本：`sudo rm -rf /root/lm-restore`。

若步驟 7 失敗，Database 未改變，直接執行步驟 9。若步驟 9 或 10 失敗，以步驟 5 的備份識別碼重複步驟 2–10 回到還原前狀態。

## 測試

單元與 API 測試、瀏覽器測試和安全測試都需要一個 PostgreSQL Ephemeral_Database，且只透過 `CAMPING_TEST_DATABASE_*` 連線。`bun test` 的每個測試檔建立自己的 `t_<random>` schema 並在結束時刪除；瀏覽器與安全測試建立 `lm_e2e_<random>` Database（帳號需要 `CREATEDB`），結束時（含失敗或 Ctrl+C）刪除。不要把測試指向實際伺服器或私人 Database。

1. 建立 Ephemeral_Database（資料只在 tmpfs，連接埠只綁定 `127.0.0.1`）：

   ```sh
   docker run -d --name lm-test-db -e POSTGRES_PASSWORD='<password>' -p 127.0.0.1:<port>:5432 \
     --tmpfs /var/lib/postgresql/data postgres:17
   docker exec lm-test-db pg_isready -U postgres
   ```

2. 在目前 shell 指定測試 Database（PowerShell；bash 用 `export` 設定同名變數）：

   ```powershell
   $env:CAMPING_TEST_DATABASE_HOST = '127.0.0.1'
   $env:CAMPING_TEST_DATABASE_PORT = '<port>'
   $env:CAMPING_TEST_DATABASE_NAME = 'postgres'
   $env:CAMPING_TEST_DATABASE_USER = 'postgres'
   $env:CAMPING_TEST_DATABASE_PASSWORD = '<password>'
   ```

3. 先 `bun run build`，再執行單元與 API 測試：bash 用 `bun test tests/*.test.js`；PowerShell 不展開萬用字元，改用 `bun test ./tests/`。
4. 瀏覽器測試（`playwright.config.js`）以原生 Node 執行 harness，需要 `CHROME_PATH` 與 `CAMPING_BUN`：

   ```powershell
   $env:CHROME_PATH = '<path to chrome.exe or chromium>'
   $env:CAMPING_BUN = (Get-Command bun).Source
   node scripts/check-accounts.mjs
   ```

   harness 套用遷移後在 **5181** 啟動獨立伺服器並建立合成測試帳號。伺服器輸出在 `reports/server.log`，JUnit／JSON 結果在 `reports/e2e-junit.xml`、`reports/e2e.json`，失敗截圖與 trace 在 `test-results/`。測試帳號密碼為合成值，只用於隔離的測試 Database，不是 App 預設值。
5. 安全測試（同樣需要 `CHROME_PATH`）：`bun scripts/security-suite.mjs`。
6. 銷毀 Ephemeral_Database 並清除變數：

   ```sh
   docker rm -f -v lm-test-db
   ```

   ```powershell
   Remove-Item Env:CAMPING_TEST_DATABASE_*
   ```

## GitHub 範圍

本 repository 只存放**原始碼**與部署設定（`Dockerfile`、`deploy/`、`ci/`、`Jenkinsfile`），不是託管網站，也不含個人資料。**GitHub Pages 無法執行 Bun／PostgreSQL 後端。** 建置成品、相依套件、截圖、日誌、備份與 Database 檔案都不納入版本控制。

## Third-party assets

Self-hosted Huninn fonts retain their SIL Open Font License files in `assets/fonts/`. Font provenance is in `assets/fonts/SOURCE.txt`. The build copies Tesseract and bundled component license notices with the OCR runtime files.

No project-wide open-source license has been selected. Existing third-party license notices remain applicable.
