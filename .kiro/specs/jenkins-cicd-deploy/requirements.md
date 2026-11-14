# Requirements Document

## Introduction

本功能為「日子拾光 · LITTLE MOMENTS」建立由 GitHub Webhook 觸發、Jenkins Multibranch Pipeline 執行的 CI/CD 流程，將應用程式以 Docker 容器部署到區域網路（LAN）內的 Ubuntu Linux 主機，並供 LAN 內使用者存取；Production_Environment 另可經 Edge_Proxy 供網際網路使用者存取（Requirement 25）。

目前專案為 Bun 後端搭配 SQLite（`bun:sqlite`、`data/accounts.sqlite`、`CAMPING_DB`），伺服器固定綁定 `127.0.0.1`，`server/http.js` 與 `server/accounts.js` 僅接受 loopback 主機名稱，首次管理員設定僅限 loopback 用戶端。Repository 目前沒有 `Dockerfile`、`Jenkinsfile` 或 Docker Compose 設定。瀏覽器測試工具 `scripts/check-accounts.mjs` 預設使用 Windows 的 Chrome 路徑，並需要 `CAMPING_BUN` 環境變數。

本需求涵蓋：
- 以 PR、`main` 合併、版本 Tag 區分的品質與安全關卡，任一關卡失敗即停止發布。
- 將伺服器改為可設定的 LAN 綁定，同時保留首次管理員設定保護、Origin 檢查、HttpOnly Cookie 與安全標頭。
- 將持久化由 SQLite 遷移至資料庫伺服器（預設 PostgreSQL，最終選擇由設計階段確認），包含版本化 Schema 遷移、既有 SQLite 資料的一次性遷移、部署前備份，以及隔離的臨時測試資料庫。
- Staging 與正式環境部署同一個 Image_Digest，正式發布需人工核准，健康檢查失敗時自動回滾。
- 每次執行皆可追蹤至 Commit SHA、Image_Digest、測試與安全報告、部署環境與結果。
- 支援同主機配置（Deploy_Host 同時為 Jenkins 與 Registry 主機），並讓 Production_Environment 經同一主機上的 Edge_Proxy（Nginx Proxy Manager，前端為 Cloudflare）以 `https://www.our-littlemoments.com` 對網際網路公開：LM_Proxy 只採信 Edge_Trusted_Proxies 的轉送標頭，Docker 轉送層只對 Public_Port 接受任何來源（Requirement 8、25）。
- Production_Environment 公開後，Deploy_Host 上的公開註冊預設關閉（帳號只能經旅行邀請連結建立），管理員可在管理頁開啟或再次關閉公開註冊，不需重新部署或重新啟動（Requirement 26）。
- Staging_Environment 與 Production_Environment 的 Smoke_Test 合成帳號與合成行程由 Host_Operator 在 Deploy_Host 上以維運指令一次性建立，Deploy_Host 部署憑證的權限不擴大；並記載第一次部署的操作順序（Requirement 27）。

不在範圍內：Requirement 25 以外的公開網際網路曝露（Staging_Environment、Registry 與 Deploy_Host 不對外公開；Jenkins 只公開 `/github-webhook/`）、Kubernetes、多主機叢集、負載／壓力測試、雲端 AI 收據辨識的啟用。具體工具與架構細節（Jenkinsfile 結構、掃描工具選型、反向代理、藍綠切換方式）於設計文件決定。

## Glossary

- **Pipeline**：定義於 repository 根目錄 `Jenkinsfile`、由 Jenkins Multibranch Pipeline 執行的 CI/CD 流程。
- **Jenkins**：執行 Pipeline 的 CI/CD 伺服器。
- **Build_Agent**：Jenkins 的 Linux 執行節點；Pipeline 各階段在 Build_Image 容器內執行。
- **Build_Image**：以版本與 digest 固定、包含 Bun 1.4.x（精確版本 1.4.4）、Node.js 與 Chromium 的 Docker 映像，供建置與測試使用。
- **Trusted_Ref**：`main` 分支，或符合 `v<major>.<minor>.<patch>` 格式且指向 `main` 歷史中 commit 的 Git Tag。
- **Untrusted_PR**：任何 Pull Request 的建置，包含來自 fork 的 PR。
- **Release_Tag**：符合 `v<major>.<minor>.<patch>` 格式的 Git Tag。
- **App_Server**：由 `scripts/serve.mjs`、`server/http.js` 與 `server/accounts.js` 組成的 Bun 應用程式伺服器。
- **App_Image**：Pipeline 在所有品質與安全關卡通過後建置的正式應用程式 Docker 映像。
- **Image_Digest**：App_Image 於 Registry 中的內容雜湊（`sha256:` 開頭）。
- **Registry**：位於 LAN 的私有 Container Registry；可與 Jenkins、Deploy_Host 位於同一台主機。
- **Deploy_Host**：位於 LAN、以 Docker Compose 執行 App_Server 與 Database 的 Ubuntu Linux 主機；可與 Jenkins controller、Build_Agent 與 Registry 為同一台主機（同主機配置，例如 `192.168.1.121`）。
- **Staging_Environment**：用於驗證 App_Image 的環境，與 Production_Environment 使用不同資料庫與資料；僅供 LAN 存取。
- **Production_Environment**：LAN 使用者實際使用的環境；亦可經 Edge_Proxy 供網際網路使用者存取（Requirement 25）。
- **Database**：App_Server 使用的資料庫伺服器（預設 PostgreSQL）。
- **Migration_Runner**：依序套用版本化 Schema 遷移並記錄已套用版本的元件。
- **SQLite_Importer**：將既有 `accounts.sqlite` 資料一次性匯入 Database 的工具。
- **Ephemeral_Database**：每次測試執行時建立、僅包含合成資料、執行結束即銷毀的隔離 Database 實例。
- **Test_Environment**：由 Pipeline 建立、使用 Ephemeral_Database 與合成資料的隔離 App_Server 實例。
- **Setup_Token**：用於在 LAN 上完成首次管理員設定的一次性隨機憑證。
- **Allowed_Hosts**：App_Server 接受的 Host 名稱設定清單。
- **Bind_Address**：App_Server 監聽的網路位址設定。
- **Trusted_Proxies**：App_Server 的 IP 位址或 CIDR 設定清單；僅來自清單內 TCP 來源的 `X-Forwarded-For` 與 `X-Forwarded-Proto` 標頭會被採用。
- **QA_Inventory**：存放於 repository、受版本控制的有限清單，逐項列出頁面、控制項或功能 ID、角色、情境、預期結果與對應測試案例 ID。
- **Security_Scanner**：Pipeline 中執行秘密掃描、相依套件漏洞掃描與靜態程式碼安全分析（SAST）的階段集合。
- **Secret_History_Baseline**：固定於 `Jenkinsfile`、經 code review 的 commit SHA；該 commit 與其所有祖先的 Git 歷史已以秘密掃描完整審查，每筆結果皆已判定為測試用的假值而不是真實秘密，審查紀錄保存在設計文件。Secret_History_Baseline 只能以經審查的 commit 修改，不是建置參數，也不能由建置覆寫（Requirement 23 第 4 條）；它只決定 Git 歷史秘密掃描的範圍，建置 commit 的所有受版本控制檔案每次建置仍完整掃描（Requirement 6 第 1 條）。
- **DAST_Scanner**：對 Test_Environment 執行主動式動態安全測試的階段。
- **Target_Allowlist**：DAST_Scanner 允許存取的目標位址清單。
- **Credential_Store**：Jenkins 的憑證管理機制。
- **Health_Check**：對 App_Server 健康端點的 HTTP 請求，成功定義為 5 秒內回應 HTTP 200 且確認 Database 連線正常。
- **Smoke_Test**：對已部署環境執行的核心功能自動化驗證（登入頁載入、Session API、合成帳號登入與讀取行程）。
- **Release_Approver**：Jenkins 中設定為可核准正式發布的使用者清單成員。
- **Build_Record**：每次 Pipeline 執行保存的追蹤資料與報告。
- **Release_Gate**：Pipeline 中決定是否繼續發布的通過條件檢查點。
- **Critical_High_Finding**：嚴重度為 Critical 或 High 的安全掃描結果。
- **Approved_Exception**：已記錄理由、核准人與到期日的安全掃描例外或誤報判定。
- **LM_Proxy**：每個環境 Compose 專案中的 Caddy 反向代理（`proxy` 服務），以 `<env>.env` 的 `LM_PUBLIC_PORT` 發布於 Deploy_Host 的 LAN 位址，並將請求轉送至目前作用中的 App_Server 槽位；本文件其他需求中的「reverse proxy」即指 LM_Proxy。
- **Edge_Proxy**：不由本 repository 管理、與 Deploy_Host 位於同一台主機的 TLS 終結反向代理（Nginx Proxy Manager 容器）；占用 Deploy_Host 的 80／443 連接埠，接收經 Cloudflare 與路由器轉送的網際網路流量，並將 Production_Environment 的公開主機名稱轉送至 Production_Environment 的 LM_Proxy。
- **Edge_Trusted_Proxies**：每個環境於 `<env>.env` 設定的非秘密 IP 位址或 CIDR 清單（Edge_Proxy 連線至 LM_Proxy 時的來源位址與 Cloudflare 公布的 IP 範圍）；LM_Proxy 只採信 TCP 來源位於此清單內之請求的 `X-Forwarded-For` 與 `X-Forwarded-Proto`。與 App_Server 的 Trusted_Proxies 為不同設定。
- **Public_Port**：維運者安裝 Deploy_Host 防火牆時明確宣告、接受任何來源連線的 Docker 發布 TCP 連接埠；僅限 Edge_Proxy 的連接埠（例如 80、443）。
- **Host_Installer**：Deploy_Host 主機安全設定安裝腳本 `deploy/host/install.sh`。
- **Deploy_Script**：Deploy_Host 上由部署帳號經 sudo 執行的部署腳本 `/opt/lm/bin/lm-deploy`。
- **Registration_Policy**：公開註冊政策，值為 `open` 或 `closed`。`open` 時任何能連線至 App_Server 的人都能在 `/register` 建立帳號；`closed` 時新帳號只能經 Invite_Registration 建立。
- **Registration_Seed**：環境變數 `CAMPING_REGISTRATION` 提供的 Registration_Policy 啟動初始值；只在 Settings_Store 沒有 Registration_Policy 儲存值時使用，App_Server 不將其寫入 Settings_Store。
- **Settings_Store**：Database 的 `settings` 資料表，存放管理員在 Admin_Page 儲存的應用程式設定（收據 AI 政策與 Registration_Policy）；每列包含設定鍵、值、儲存時間與儲存者帳號。
- **Admin_Page**：只有管理員可使用的 `/admin` 頁面；其「網站設定」表單供管理員檢視與儲存應用程式設定。
- **Account_UI**：由 `src/accounts-ui.js` 在瀏覽器產生的帳號相關頁面，包含 `/login`、`/register`、`/invite/<token>` 與 Admin_Page。
- **Invite_Registration**：未登入訪客經有效旅行邀請連結 `/invite/<token>` 建立帳號並加入該旅行的流程（`POST /api/invites/<token>/register`）。
- **Smoke_Account**：Smoke_Test 登入用的合成帳號，預設帳號名稱 `smoke-bot`、角色 member；每個環境各一個，密碼只存放於 Credential_Store 的 `lm-staging-smoke` 與 `lm-prod-smoke`。
- **Smoke_Fixture**：Smoke_Account 在 `GET /api/trips` 中可見、標題恰為 `smoke-fixture`（或維運者指定名稱）的合成行程；Smoke_Test 以此確認行程讀取正常。
- **Smoke_Provisioner**：建立 Smoke_Account 與 Smoke_Fixture 的維運工具 `scripts/create-smoke-account.mjs`，在 App_Image 內為 `/app/tools/create-smoke-account.js`。
- **Host_Operator**：在 Deploy_Host 上以自己的登入帳號經 sudo（或直接以 root 登入）執行維運指令的維運者；不包含部署帳號（`lm-deploy-staging`、`lm-deploy-prod`），也不包含經 SSH forced command（設定了 `SSH_ORIGINAL_COMMAND`）的呼叫。

## Requirements

### Requirement 1: Pipeline 觸發與分支行為

**User Story:** 身為開發者，我希望 GitHub 事件自動觸發對應的 Pipeline 流程，以便 PR、主線與正式發布各自執行適當的檢查與部署。

#### Acceptance Criteria

1. THE Pipeline SHALL 定義於 repository 根目錄、檔名為 `Jenkinsfile` 的單一檔案，並由 Jenkins Multibranch Pipeline 從受觸發 Commit SHA 的該檔案內容載入流程定義。
2. WHEN Jenkins 收到 GitHub Pull Request 建立、推送新 commit 或重新開啟事件，THE Pipeline SHALL 依序執行安裝、建置、單元測試、瀏覽器測試與 Security_Scanner 階段，且不執行 App_Image 推送、人工核准、Staging_Environment 部署或 Production_Environment 部署中的任何一個階段。
3. WHEN 一個 commit 合併或推送至 `main` 分支，THE Pipeline SHALL 依序評估「QA」與「安全」Release_Gate；僅在兩者皆通過後建置 App_Image、評估「映像」Release_Gate、將 App_Image 推送至 Registry 並簽章，再將該 Image_Digest 部署至 Staging_Environment，最後評估「Staging」Release_Gate。
4. WHEN 一個 Release_Tag 被推送，THE Pipeline SHALL 對該 Tag 指向的 commit 重新評估「QA」與「安全」Release_Gate，且不重新建置 App_Image；接著查出先前由 `main` 建置自同一 commit 產生的 Image_Digest，評估「映像」Release_Gate（簽章驗證通過且 SBOM 已保存於 Build_Record）與「Staging」Release_Gate（該 Image_Digest 已記錄為已通過 Staging 驗證），再等待 Release_Approver 人工核准，並僅在核准後將該 Image_Digest 部署至 Production_Environment。
5. IF 一個 Tag 不完全符合 `v<major>.<minor>.<patch>` 格式（major、minor、patch 皆為 0 至 999999 的十進位整數、除數值 0 外不得有前導零、不得含任何前綴或後綴，例如 `v1.2.3-rc.1` 或 `release-1.2.3` 視為不符合），或該 Tag 指向的 commit 不在 `main` 分支歷史中，THEN THE Pipeline SHALL 在任何 App_Image 推送與部署階段開始前終止正式發布流程、將建置標記為失敗，且 Production_Environment 維持原部署版本不變。
6. THE Pipeline SHALL 對觸發事件指定的確切 Commit SHA 執行所有階段，並將該 Commit SHA 記錄於 Build_Record；IF 建置執行期間同一分支有新的 commit 推送，THEN THE Pipeline SHALL 繼續使用原 Commit SHA 完成本次建置，並為新 commit 觸發另一次獨立建置。
7. IF 任一階段以失敗結束，THEN THE Pipeline SHALL 略過所有後續階段、將建置標記為失敗，且不執行任何 App_Image 推送或部署階段。
8. WHEN 一個 commit 被推送至 `main` 以外且未關聯 Pull Request 的分支，THE Pipeline SHALL 僅執行安裝、建置、單元測試、瀏覽器測試與 Security_Scanner 階段，且不執行 App_Image 推送或任何部署階段。
9. WHEN Jenkins 收到通過驗證的 GitHub Webhook 事件，THE Jenkins SHALL 在 60 秒內將對應的 Pipeline 建置排入執行佇列。
10. IF 一個 Release_Tag 指向的 commit 不存在任何由 `main` 建置產生的 Image_Digest，THEN THE Pipeline SHALL 不進入等待核准狀態、不執行任何 Production_Environment 部署階段、將建置標記為失敗，並在 Jenkins 建置摘要中顯示該 commit 查無 Image_Digest 的原因。

### Requirement 2: Webhook 驗證與 Untrusted_PR 隔離

**User Story:** 身為維運者，我希望只有經驗證的 GitHub 事件能觸發建置，且不可信 PR 無法取得部署權限，以便防止惡意程式碼影響部署環境。

#### Acceptance Criteria

1. WHEN Jenkins 收到 Webhook 請求，THE Jenkins SHALL 以 Credential_Store 中的 Webhook secret 對完整請求內容計算 GitHub Webhook 簽章，以固定時間比較方式與請求所附簽章比對，且僅在兩者完全一致時觸發建置。
2. IF Webhook 請求缺少簽章、簽章與計算結果不一致，或事件中的 repository 不是 Jenkins 設定的 repository，THEN THE Jenkins SHALL 拒絕該請求、不觸發建置，並記錄包含接收時間、來源 IP 與拒絕原因的事件，且記錄中不包含請求內容或 Webhook secret。
3. IF 已通過簽章驗證的 Webhook 事件不屬於 Requirement 1 定義的 Pull Request 建立、更新或重新開啟、推送至 `main` 或其他分支、或 Release_Tag 推送事件，THEN THE Jenkins SHALL 不觸發建置。
4. WHILE 執行 Untrusted_PR 建置，THE Pipeline SHALL 僅提供 Ephemeral_Database 的臨時憑證，且不提供 Registry 推送憑證、Deploy_Host 部署憑證、映像簽章金鑰、Staging_Environment 或 Production_Environment 的 Database 憑證、Setup_Token 或 `CAMPING_OPENAI_*` 值。
5. IF Untrusted_PR 建置向 Credential_Store 請求第 4 條列出的任一憑證，THEN THE Pipeline SHALL 不提供該憑證值並將建置標記為失敗。
6. WHILE 執行 Untrusted_PR 建置，THE Pipeline SHALL 在無法經 LAN 或 Deploy_Host 本機建立網路連線至 Deploy_Host、Staging_Environment、Production_Environment 及其 Database 的 Build_Agent 上執行（同主機配置下，該 Build_Agent 對該主機僅可連線至 Jenkins controller 與 Registry 的連接埠；經網際網路連線至 Requirement 25 的公開網址與任何網際網路主機相同，不在此限），並於建置結束後（不論成功或失敗）刪除該建置的工作目錄與容器。
7. WHEN Untrusted_PR 來自 fork 或 PR 作者不具 repository 寫入權限，THE Jenkins SHALL 使用 `main` 分支的 `Jenkinsfile` 執行建置，而不使用 PR 中修改過的 `Jenkinsfile`。
8. THE Pipeline SHALL 僅在 Trusted_Ref 建置中執行 App_Image 推送與部署階段，且此限制同樣適用於在 Jenkins 手動觸發或重新執行的建置。

### Requirement 3: 可重現的建置環境

**User Story:** 身為開發者，我希望每次建置使用相同、固定版本的工具，以便 CI 結果可重現。

#### Acceptance Criteria

1. THE Pipeline SHALL 在 Build_Image 容器內執行安裝、建置與測試階段，且 `Jenkinsfile` 中對 Build_Image 的引用 SHALL 包含以 `sha256:` 開頭的 digest；僅以可變 tag（例如 `latest` 或 `1.4`）引用 Build_Image 的設定視為不符合。
2. THE Build_Image SHALL 包含單一精確 patch 版本的 Bun（屬於 1.4.x 系列，精確版本為 1.4.4）、單一精確版本的 Node.js 與單一精確版本的 Chromium，且這三項工具的精確版本號 SHALL 記錄於 repository 中受版本控制的檔案。
3. WHEN Pipeline 在 Build_Image 容器內開始安裝階段之前，THE Pipeline SHALL 將 Bun、Node.js 與 Chromium 的實際版本號寫入 Build_Record；IF 任一實際版本號與 repository 中記錄的版本號不一致，THEN THE Pipeline SHALL 在執行安裝之前使該次執行失敗，並在 Build_Record 中標示不一致的工具名稱、預期版本與實際版本。
4. WHEN 安裝相依套件，THE Pipeline SHALL 執行 `bun install --frozen-lockfile`，且 SHALL NOT 執行任何會建立或修改 `bun.lock` 的安裝指令。
5. IF `bun.lock` 不存在，或 `bun.lock` 與 `package.json` 宣告的相依套件不一致，THEN THE Pipeline SHALL 使安裝階段以非零結束碼失敗、將該次執行標示為失敗、不執行後續的建置、測試、App_Image 建置與部署階段，且不修改或提交 `bun.lock`。
6. WHEN 相依套件安裝成功完成，THE Pipeline SHALL 在執行任何測試（包含 `bun test` 與 Playwright 瀏覽器測試）之前執行 `bun run build`。
7. IF `bun run build` 以非零結束碼結束，THEN THE Pipeline SHALL 使建置階段失敗、將該次執行標示為失敗，且不執行任何測試、App_Image 建置與部署階段。
8. THE Pipeline SHALL 在執行測試階段時設定環境變數 `CHROME_PATH` 與 `CAMPING_BUN`，其值分別為 Build_Image 內 Chromium 與 Bun 可執行檔的絕對路徑。
9. IF `CHROME_PATH` 或 `CAMPING_BUN` 未設定、為空字串，或所指路徑在 Build_Image 容器內不存在或不可執行，THEN THE Pipeline SHALL 在啟動 `scripts/check-accounts.mjs` 或任何瀏覽器測試之前使該次執行失敗，在 Build_Record 中標示有問題的環境變數名稱，且 SHALL NOT 改用 `scripts/check-accounts.mjs` 內建的 Windows Chrome 預設路徑。

### Requirement 4: 單元與 API 整合測試

**User Story:** 身為開發者，我希望單元與 API 測試在隔離的資料庫上執行，以便測試不會影響真實資料且結果可重現。

#### Acceptance Criteria

1. WHEN `bun run build` 以結束碼 0 完成且 Ephemeral_Database 已由 Migration_Runner 套用所有遷移，THE Pipeline SHALL 在 Build_Image 容器內執行 `bun test tests/*.test.js`，並僅透過環境變數提供該次執行之 Ephemeral_Database 的連線設定。
2. WHEN 單元與 API 測試階段開始，THE Pipeline SHALL 建立一個不含任何資料列、僅具備 Migration_Runner 套用之 Schema 的新 Ephemeral_Database，並於該階段以成功、失敗、逾時或使用者中止任一方式結束後 120 秒內銷毀該 Ephemeral_Database 及其儲存資料。
3. THE Pipeline SHALL 不向單元與 API 測試階段提供 Staging_Environment 或 Production_Environment 的 Database 連線設定或憑證，使 Ephemeral_Database 僅包含測試執行期間建立的合成資料。
4. IF 任一單元或 API 測試失敗，或 `bun test` 以非零結束碼結束，或執行的測試數量為 0，THEN THE Pipeline SHALL 將建置標記為失敗並不執行後續瀏覽器測試、App_Image 建置與部署階段。
5. WHEN 單元與 API 測試階段結束（不論成功或失敗），THE Pipeline SHALL 將 Jenkins 可解析的 JUnit XML 格式測試結果報告保存至 Build_Record，報告包含每個測試案例的名稱、結果（通過、失敗或略過）與執行時間，以及通過、失敗與略過的總數。
6. IF Ephemeral_Database 無法於 120 秒內建立完成或 Migration_Runner 以非零結束碼結束，THEN THE Pipeline SHALL 不執行 `bun test`、將建置標記為失敗，並於 Build_Record 記錄失敗原因（不含憑證值）。
7. IF `bun test` 執行超過 15 分鐘，THEN THE Pipeline SHALL 中止測試、將建置標記為失敗，並依第 2 條銷毀 Ephemeral_Database。
8. WHILE 同一 Build_Agent 或不同 Build_Agent 上有多個 Pipeline 執行同時進行，THE Pipeline SHALL 為每次執行使用各自獨立的 Ephemeral_Database，且任一執行無法讀取或修改其他執行的 Ephemeral_Database 資料。

### Requirement 5: 瀏覽器 E2E 測試與 QA_Inventory

**User Story:** 身為 QA 負責人，我希望使用一份有限且受維護的功能清單驅動瀏覽器測試，以便可驗證每個列出的控制項與功能都有對應測試且通過。

#### Acceptance Criteria

1. THE QA_Inventory SHALL 以受版本控制的檔案存放於 repository，每個項目包含唯一的項目 ID、頁面、控制項或功能 ID、角色（未登入、member 或 admin 其中之一）、情境、預期結果、至少 1 個對應測試案例 ID，以及是否為重要頁面的標記（是或否），且上述欄位皆不得為空值。
2. THE QA_Inventory SHALL 對未登入、member 與 admin 三種角色各包含至少 1 個項目，並包含至少 1 個未登入者存取需登入功能的越權操作項目與至少 1 個 member 存取僅限 admin 功能的越權操作項目，且每個越權操作項目的預期結果為操作被拒絕且資料未被變更。
3. WHEN 單元測試通過，THE Pipeline SHALL 對使用 Ephemeral_Database 的 Test_Environment 執行 `scripts/check-accounts.mjs` 與 `playwright.config.js` 定義的瀏覽器測試，且失敗的測試案例不得自動重試。
4. WHEN 瀏覽器測試執行完成，THE Pipeline SHALL 比對 QA_Inventory 與已執行的測試案例 ID，將對應測試案例皆已執行且在所有要求的視窗尺寸下皆通過的項目標記為通過、將任一對應測試案例失敗的項目標記為失敗、將任一對應測試案例 ID 不存在或未執行的項目標記為缺少測試，並以機器可讀格式將比對結果保存至 Build_Record。
5. IF 任一 QA_Inventory 項目標記為失敗或缺少測試，THEN THE Pipeline SHALL 將建置標記為失敗、停止後續發布階段，並於 Build_Record 列出每個失敗或缺少測試的項目 ID。
6. IF 一個瀏覽器測試失敗，THEN THE Pipeline SHALL 保存該測試的截圖、Playwright trace 與該次測試執行期間的伺服器日誌至 Build_Record，且每份檔案可對應至該測試案例 ID 與視窗尺寸。
7. THE Pipeline SHALL 對 QA_Inventory 中標記為重要頁面的每個項目，分別在桌面視窗（1440×1000 像素）與手機視窗（390×844 像素）下執行其對應測試案例。
8. IF QA_Inventory 檔案無法解析、任一項目缺少必要欄位、項目 ID 重複或角色值不屬於未登入、member 或 admin，THEN THE Pipeline SHALL 在執行瀏覽器測試前將建置標記為失敗、停止後續發布階段，並於 Build_Record 記錄不合格的項目 ID 與原因。
9. IF `scripts/check-accounts.mjs` 或 Playwright 以非零結束代碼結束，或瀏覽器測試階段執行超過 60 分鐘，THEN THE Pipeline SHALL 終止瀏覽器測試階段、將建置標記為失敗並停止後續發布階段。

### Requirement 6: 靜態安全掃描

**User Story:** 身為安全負責人，我希望每次建置都掃描秘密、相依套件漏洞與不安全程式碼，以便在發布前阻擋已知風險。

#### Acceptance Criteria

1. WHEN Pipeline 執行，THE Security_Scanner SHALL 掃描建置 commit 的 repository 所有受版本控制檔案；Untrusted_PR 建置另須掃描自目標分支 merge base 至 PR head 的所有 commit 差異，Trusted_Ref 建置另須掃描自起點至建置 commit 的所有 commit 差異中的秘密；起點為前一次成功建置 commit，但該 commit 不存在、無效、不是建置 commit 的祖先或不是 Secret_History_Baseline 的後代（含相同）時，起點為 Secret_History_Baseline。
2. WHEN Pipeline 執行，THE Security_Scanner SHALL 依 `bun.lock` 掃描所有直接與間接相依套件的已知漏洞，並於報告中列出每筆結果的套件名稱、版本、漏洞識別碼與嚴重度。
3. WHEN Pipeline 執行，THE Security_Scanner SHALL 對 `src/`、`server/` 與 `scripts/` 下所有 JavaScript 原始檔（`.js`、`.mjs`）執行 SAST，並於報告中列出每筆結果的規則識別碼、檔案路徑、行號與嚴重度。
4. IF Security_Scanner 偵測到秘密，THEN THE Pipeline SHALL 不論嚴重度或是否有 Approved_Exception，將建置標記為失敗並停止後續發布階段，且報告與建置日誌中每個偵測到的秘密值皆完全以遮罩字元取代（不顯示任何原文字元），僅保留規則識別碼、檔案路徑、行號與 commit SHA 以供定位。
5. IF Security_Scanner 回報不屬於 Approved_Exception 的 Critical_High_Finding，THEN THE Pipeline SHALL 將建置標記為失敗並停止後續發布階段；嚴重度為 Medium 或 Low 的結果 SHALL 僅記錄於報告而不使建置失敗。
6. IF 一個 Approved_Exception 已超過到期日（以 Pipeline 執行當下日期判定，到期日當日仍視為有效），THEN THE Pipeline SHALL 將對應的掃描結果視為未處理的 Critical_High_Finding，並於報告中標示該例外已過期。
7. WHEN Security_Scanner 任一掃描階段完成（不論通過或失敗），THE Security_Scanner SHALL 以機器可讀格式保存該階段的掃描報告至 Build_Record，報告包含掃描工具版本、掃描 commit SHA、所有結果及每筆結果是否套用 Approved_Exception。
8. IF Security_Scanner 任一掃描無法完成（工具執行錯誤、逾時超過 15 分鐘或漏洞資料庫無法取得），THEN THE Pipeline SHALL 將建置標記為失敗並停止後續發布階段，且不將該掃描視為通過。
9. IF 一個 Approved_Exception 缺少理由、核准人或到期日任一欄位，或其對應的結果識別碼（漏洞識別碼或規則識別碼）與位置（套件名稱或檔案路徑）未與掃描結果完全相符，THEN THE Pipeline SHALL 不套用該例外，並將對應的掃描結果視為未處理的 Critical_High_Finding。
10. IF Secret_History_Baseline 不是 40 個小寫十六進位字元的 commit SHA、不存在於 repository，或不是 Trusted_Ref 建置 commit 的祖先（含相同），THEN THE Pipeline SHALL 將該建置的 Git 歷史秘密掃描視為未完成，依第 8 條將建置標記為失敗並停止後續發布階段，且不以完整 Git 歷史或略過歷史掃描取代。

### Requirement 7: 動態安全測試與安全邊界

**User Story:** 身為安全負責人，我希望在受控、隔離的環境中執行主動式安全測試，以便發現執行期漏洞而不影響真實服務或資料。

#### Acceptance Criteria

1. WHEN 一個 Trusted_Ref 建置的瀏覽器測試全部通過，THE DAST_Scanner SHALL 對該建置專用、使用 Ephemeral_Database 與合成資料的 Test_Environment 執行主動式掃描；THE Pipeline SHALL 不在 Untrusted_PR 建置或瀏覽器測試未全部通過的建置中執行 DAST 階段。
2. THE DAST_Scanner SHALL 僅對 Target_Allowlist 內的位址發出請求，且 Target_Allowlist SHALL 僅包含該次建置 Test_Environment 的位址，不包含 Staging_Environment、Production_Environment、Deploy_Host 或任何其他 LAN 或網際網路位址。
3. IF DAST_Scanner 的任一設定目標（含掃描起始位址與爬蟲可跟隨的位址）不在 Target_Allowlist 內，或 Target_Allowlist 為空，THEN THE Pipeline SHALL 在發出任何掃描請求前中止 DAST 階段、將建置標記為失敗，並在 Build_Record 中記錄被拒絕的目標位址。
4. THE DAST_Scanner SHALL 將請求速率限制為每秒最多 20 個請求、並行連線數限制為最多 5 個，且 IF DAST 階段執行時間達到 60 分鐘，THEN THE Pipeline SHALL 中止 DAST_Scanner、將建置標記為失敗並停止後續發布階段。
5. WHEN 具有該 Jenkins Job 中止權限的 Jenkins 使用者對執行中的 DAST 階段觸發停止操作，THE Pipeline SHALL 在 60 秒內停止 DAST_Scanner 發出新請求、銷毀 Test_Environment 與 Ephemeral_Database，並將建置標記為已中止且不執行後續發布階段。
6. WHEN DAST 階段執行，THE Pipeline SHALL 以自動化測試對 Test_Environment 驗證下列每一類別，且任一類別未符合預期結果即判定該類別失敗：SQL injection（注入字串不改變查詢結果、不修改他人資料、回應不含資料庫錯誤內容）；XSS（注入的腳本內容於頁面中以文字呈現且不被執行）；未登入存取（未登入請求受保護 API 時被拒絕且回應不含受保護資料）；跨使用者資料存取（一般使用者讀取或修改其他使用者或未受邀行程的資料時被拒絕）；角色越權（一般使用者呼叫管理員功能時被拒絕）；Session 處理（登出後或 Session 失效後原 Session 無法存取受保護資源）；Origin 檢查（Origin 與請求來源不一致的狀態變更請求被拒絕且資料未變更）；登入嘗試限速（同一帳號於 15 分鐘內連續 5 次登入失敗後，第 6 次嘗試即使密碼正確仍被拒絕）；路徑處理（含 `../` 或其編碼形式的路徑請求不回傳應用程式靜態資源目錄以外的檔案內容）。
7. WHILE DAST_Scanner 執行，THE Test_Environment SHALL 僅能連線至該次建置的 Ephemeral_Database，且無法連線至 LAN 其他主機或網際網路。
8. IF DAST_Scanner 回報不屬於未過期 Approved_Exception 的 Critical_High_Finding，或第 6 條任一類別判定失敗，THEN THE Pipeline SHALL 將建置標記為失敗並停止後續發布階段。
9. IF 在 DAST_Scanner 發出第一個掃描請求前，Pipeline 的網路隔離檢查顯示 Test_Environment 可連線至 Ephemeral_Database 以外的任一位址，THEN THE Pipeline SHALL 不啟動 DAST_Scanner、將建置標記為失敗，並在 Build_Record 中記錄可連線的位址。
10. IF DAST_Scanner 或 Test_Environment 在掃描完成前異常結束或無法啟動，THEN THE Pipeline SHALL 將建置標記為失敗並停止後續發布階段，且不將未完成的掃描視為通過。
11. WHEN DAST 階段結束（不論通過、失敗、逾時或被中止），THE Pipeline SHALL 以機器可讀格式保存 DAST 掃描報告與第 6 條各類別的測試結果至 Build_Record，並銷毀 Test_Environment 與 Ephemeral_Database。

### Requirement 8: 可設定的 LAN 網路綁定

**User Story:** 身為 LAN 使用者，我希望能從區域網路內的裝置存取應用程式，以便家人或同伴共同規劃行程。

#### Acceptance Criteria

1. WHEN App_Server 啟動，THE App_Server SHALL 從環境變數讀取 Bind_Address（單一 IPv4 或 IPv6 位址字面值），未設定或為空字串時使用 `127.0.0.1`，並從既有 `PORT` 環境變數讀取 1 至 65535 的整數連接埠，未設定時使用 `5173`。
2. WHEN App_Server 啟動，THE App_Server SHALL 從環境變數讀取 Allowed_Hosts（以逗號分隔、1 至 32 個項目、每個項目為 1 至 253 字元的主機名稱或 IP 位址字面值，IPv6 以方括號表示），未設定時使用 `127.0.0.1`、`localhost` 與 `[::1]` 三個項目。
3. IF 請求缺少 Host 標頭，或 Host 標頭在移除 `:<port>` 後綴並轉為小寫後與 Allowed_Hosts 中任一項目（不分大小寫）皆不完全相符，THEN THE App_Server SHALL 回應 HTTP 421 並附上 `server/http.js` 中 `SECURITY_HEADERS` 定義的安全標頭，且不執行任何 API 處理、靜態檔案讀取或資料寫入。
4. IF Bind_Address 不是 loopback 位址（`127.0.0.0/8` 或 `::1`）且 Allowed_Hosts 環境變數未設定或為空字串，THEN THE App_Server SHALL 在 5 秒內以非零結束碼結束、不監聽任何連接埠，並輸出指出缺少 Allowed_Hosts 設定的錯誤訊息。
5. WHEN App_Server 成功開始監聽，THE App_Server SHALL 輸出一行包含實際 Bind_Address、實際連接埠與完整 Allowed_Hosts 清單的啟動訊息，且啟動輸出中不包含 Setup_Token、Database 憑證、Session 密鑰或任何 `CAMPING_OPENAI_*` 值。
6. THE Deploy_Host SHALL 僅接受來源 IP 位於設定 LAN 網段（以 CIDR 表示）內的主機連線至 App_Server 連接埠，並使來自該網段以外來源的 TCP 連線無法建立；此限制 SHALL 同樣適用於第 8 條 Public_Port 以外的所有 Docker 發布連接埠（包含 Staging_Environment 與 Production_Environment 的 LM_Proxy 連接埠；Docker 發布連接埠的流量會繞過 UFW 等主機防火牆規則，因此限制須在 Docker 轉送層生效），使網段外來源即使直接連線至這些 Docker 發布的連接埠也無法建立連線。
7. IF Bind_Address 不是有效的 IP 位址字面值、`PORT` 不是 1 至 65535 的整數，或 Allowed_Hosts 含有空項目、萬用字元（`*`）、超過 32 個項目或超過 253 字元的項目，THEN THE App_Server SHALL 在 5 秒內以非零結束碼結束、不監聽任何連接埠，並輸出指出無效設定名稱的錯誤訊息（不含秘密值）。
8. WHERE 維運者以 Host_Installer 宣告 1 至 8 個 Public_Port，THE Deploy_Host SHALL 接受任何來源 IP 對這些 Public_Port 的 TCP 連線，同時 Staging_Environment 與 Production_Environment 的 LM_Proxy 連接埠維持第 6 條的 LAN 網段限制。
9. IF 宣告的任一 Public_Port 不是 1 至 65535 的十進位整數、與其他宣告項目重複、宣告項目超過 8 個，或等於 Staging_Environment 或 Production_Environment（已安裝或本次安裝）任一環境 `<env>.env` 的 `LM_PUBLIC_PORT`，THEN THE Host_Installer SHALL 在變更任何 DOCKER-USER 規則前以結束碼 2 結束，並輸出指出無效連接埠的錯誤訊息。
10. WHERE 未宣告任何 Public_Port，THE Host_Installer SHALL 安裝與第 6 條相同、不含任何 Public_Port 例外的 DOCKER-USER 規則。

### Requirement 9: 首次管理員設定保護

**User Story:** 身為系統擁有者，我希望在 LAN 部署時首次管理員設定仍受到保護，以便同網段的其他人無法搶先建立管理員。

#### Acceptance Criteria

1. WHILE Database 中使用者數量為 0，WHEN App_Server 收到首次管理員設定請求，THE App_Server SHALL 僅在符合下列任一條件時建立管理員帳號：(a) 請求的 Host 名稱為 loopback 名稱且 TCP 來源 IP 為 loopback 位址（`127.0.0.0/8`、`::1` 或 `::ffff:127.0.0.0/104`）；(b) 請求附帶與 App_Server 目前 Setup_Token 完全相同的值。
2. WHERE Bind_Address 為非 loopback 位址，THE App_Server SHALL 啟用 Setup_Token，並從 Credential_Store 提供的環境變數讀取 Setup_Token；若該環境變數未設定，THE App_Server SHALL 於啟動時以密碼學安全亂數產生器產生至少 128 位元的 Setup_Token，且僅輸出至 Deploy_Host 上 App_Server 容器的本機標準輸出日誌一次，不寫入 Database、Build_Record 或任何 HTTP 回應。
3. IF 啟用 Setup_Token 時環境變數提供的 Setup_Token 少於 32 個字元，THEN THE App_Server SHALL 拒絕啟動，以非零結束碼結束並輸出指出 Setup_Token 長度不足的錯誤訊息，且不輸出該 Setup_Token 的值。
4. IF Database 中使用者數量為 0，且首次管理員設定請求不符合第 1 條任一條件（缺少 Setup_Token、Setup_Token 不相符，或未啟用 Setup_Token 時來自非 loopback 用戶端），THEN THE App_Server SHALL 回應 HTTP 403、不建立任何使用者，並寫入一筆稽核事件，內容包含時間、來源 IP 與失敗原因類別，且不包含所提交的 Setup_Token 值。
5. WHEN 首次管理員設定成功建立管理員帳號，THE App_Server SHALL 使該 Setup_Token 失效，使後續以同一 Setup_Token 提出的設定請求不會建立任何使用者。
6. IF Database 中使用者數量大於或等於 1，THEN THE App_Server SHALL 對所有首次管理員設定請求回應 HTTP 409 且不建立或修改任何使用者，不論請求是否來自 loopback 用戶端或附帶任何 Setup_Token。
7. THE App_Server SHALL 以執行時間不受兩值內容中第一個不同字元位置影響的固定時間比較方式驗證 Setup_Token。
8. THE App_Server SHALL 對首次管理員設定請求依來源用戶端套用與登入相同的用戶端嘗試次數限速（每個用戶端每 15 分鐘最多 30 次），且通過與未通過驗證的請求皆計入次數。
9. IF 用戶端在 15 分鐘時間窗內的首次管理員設定請求已達 30 次，THEN THE App_Server SHALL 對該用戶端後續請求回應 HTTP 429，直到該時間窗結束為止，且不驗證 Setup_Token、不建立任何使用者。
10. IF 首次管理員設定請求通過第 1 條驗證但帳號名稱、顯示名稱或密碼未通過現有輸入驗證，THEN THE App_Server SHALL 回應 HTTP 400、不建立任何使用者，且保留 Setup_Token 有效。
11. WHEN 2 個以上通過第 1 條驗證的首次管理員設定請求同時抵達，THE App_Server SHALL 僅建立 1 個管理員帳號，並對其餘請求回應 HTTP 409。
12. WHERE App_Server 部署於 reverse proxy 之後，THE App_Server SHALL 僅在 TCP 來源 IP 列於 Trusted_Proxies 時採用 `X-Forwarded-For` 與 `X-Forwarded-Proto` 標頭決定用戶端 IP 與請求協定、對其他來源忽略這兩個標頭，且 SHALL 不將經由 reverse proxy 轉送的請求視為第 1 條 (a) 的 loopback 用戶端，使經由 LAN 進行的首次管理員設定須附帶有效 Setup_Token。

### Requirement 10: 保留既有安全控制

**User Story:** 身為安全負責人，我希望開放 LAN 存取後既有的安全控制維持有效，以便攻擊面不因部署方式改變而擴大。

#### Acceptance Criteria

1. WHEN App_Server 收到 HTTP 方法不是 GET 的 API 請求，THE App_Server SHALL 僅在 `Origin` 標頭值與該請求網址的來源（協定、Host 名稱與連接埠）逐字元完全相同時處理該請求。
2. IF 一個非 GET 的 API 請求缺少 `Origin` 標頭，或 `Origin` 標頭值與請求網址的來源不同（包含 Host 為 LAN 位址但 `Origin` 為 `http://localhost` 或其他 Allowed_Hosts 項目的情況），THEN THE App_Server SHALL 回應 HTTP 403 及說明請求來源不被允許的錯誤訊息，且不建立、修改或刪除任何資料，也不設定 Session Cookie。
3. WHEN App_Server 建立或更新名為 `ggc_session` 的 Session Cookie，THE App_Server SHALL 為該 Cookie 設定 `HttpOnly`、`SameSite=Strict`、`Path=/` 與 `Max-Age=604800`（7 天）屬性。
4. WHEN 使用者登出，THE App_Server SHALL 以 `Max-Age=0` 及與第 3 條相同的 `HttpOnly`、`SameSite=Strict`、`Path=/` 屬性覆寫 `ggc_session` Cookie，且該 Session 之後的 API 請求 SHALL 被視為未登入。
5. WHERE App_Server 收到的請求網址協定為 `https:`，THE App_Server SHALL 在每個 `ggc_session` Set-Cookie 標頭加上 `Secure` 屬性；WHERE 請求網址協定為 `http:`，THE App_Server SHALL 不加上 `Secure` 屬性。
6. THE App_Server SHALL 在所有回應中（包含 API 回應、靜態檔案、HTML 路由，以及 HTTP 400、403、404、405、421 與 500 錯誤回應，包含因 Host 不在 Allowed_Hosts 內而拒絕的回應）加入 `server/http.js` 中 `SECURITY_HEADERS` 定義的每一個標頭，且除靜態資源回應的 `Cache-Control` 為 `no-cache` 外，各標頭值與 `SECURITY_HEADERS` 定義值完全相同。
7. WHEN App_Server 儲存或更新密碼，THE App_Server SHALL 為每個密碼產生 16 位元組隨機鹽值，以 scrypt（N=16384、r=8、p=1、輸出 64 位元組）計算雜湊，並僅儲存演算法參數、鹽值與雜湊值，不儲存明文密碼。
8. WHEN App_Server 驗證密碼，THE App_Server SHALL 使用儲存的參數與鹽值重新計算 scrypt 雜湊並以固定時間比較方式比對；IF 儲存值格式不符或參數不是安全整數，THEN THE App_Server SHALL 將驗證視為失敗。
9. WHEN SQLite_Importer 將既有 `accounts.sqlite` 匯入 Database，THE SQLite_Importer SHALL 原樣保留每個使用者的密碼雜湊字串，使匯入前可登入的帳號在匯入後以相同密碼登入成功、以錯誤密碼登入失敗。
10. THE Pipeline SHALL 以自動化測試，在 Bind_Address 為非 loopback 位址（例如 `0.0.0.0`）且 Allowed_Hosts 包含至少一個非 loopback Host 名稱的設定下，透過該非 loopback Host 名稱發送請求，驗證本需求第 1 至 9 條的行為。
11. IF 第 10 條的任一自動化測試失敗，THEN THE Pipeline SHALL 將建置標記為失敗並停止後續發布階段。

### Requirement 11: 資料庫伺服器持久化

**User Story:** 身為維運者，我希望應用程式資料存放於獨立的資料庫伺服器，以便容器可替換、可回滾且資料可備份。

#### Acceptance Criteria

1. THE App_Server SHALL 僅透過環境變數提供的連線設定（主機、連接埠、資料庫名稱、使用者名稱與密碼）存取 Database，且執行期不載入 `bun:sqlite`、不讀取 `CAMPING_DB`，也不在容器檔案系統建立或寫入任何 SQLite 檔案。
2. THE App_Server SHALL 對所有包含使用者輸入的資料庫查詢使用參數化查詢，使包含 SQL 語法字元（如 `'`、`;`、`--`）的輸入值以原文儲存與讀回，且不改變查詢語意。
3. IF 現行 SQLite 實作中以交易保護的寫入操作在任一步驟失敗，THEN THE App_Server SHALL 回復該操作的所有變更，使 Database 中不留下任何部分寫入的資料列，並回應錯誤給呼叫端。
4. THE Deploy_Host SHALL 將 Database 資料存放於容器外的具名卷或主機目錄，使執行 `docker compose down`（不含移除卷的選項）後再次 `docker compose up`、或替換 App_Server 與 Database 容器映像後，先前寫入的所有資料仍可透過 App_Server 讀取。
5. IF App_Server 啟動時無法連線至 Database，THEN THE App_Server SHALL 以每次間隔 1 至 5 秒重試連線，總計不超過 30 秒，若仍失敗則以非零結束碼結束，並輸出不含密碼或完整連線字串的錯誤訊息。
6. WHILE Database 連線中斷，THE Health_Check SHALL 在 5 秒內回應非 HTTP 200 的失敗狀態。
7. THE App_Server SHALL 對現有 `tests/*.test.js` 涵蓋的所有帳號、行程、邀請、支出與裝備操作，在 Database 上產生與現行 SQLite 實作相同的 HTTP 狀態碼與回應內容（排除 ID、時間戳記與 Session Token 等每次執行產生的值）。
8. IF App_Server 啟動時缺少任一必要的 Database 連線環境變數，THEN THE App_Server SHALL 不嘗試連線、以非零結束碼結束，並輸出指出所缺變數名稱且不含任何秘密值的錯誤訊息。
9. WHEN Database 連線中斷後恢復，THE App_Server SHALL 在不重新啟動 App_Server 程序的情況下於 30 秒內重新建立連線，且之後的 Health_Check 成功。
10. THE Deploy_Host SHALL 不將 Database 連接埠發布至 Deploy_Host 的網路介面，使 Database 僅能由同一 Docker Compose 網路中的 App_Server（與 Migration_Runner、備份工具）連線。

### Requirement 12: 版本化 Schema 遷移

**User Story:** 身為開發者，我希望 Schema 變更以版本化遷移管理，以便部署與回滾時新舊版本都能正確運作。

#### Acceptance Criteria

1. THE Migration_Runner SHALL 依版本號（正整數，且在 repository 內不重複）由小到大的順序套用存放於 repository 的遷移檔，並在每個遷移成功後於 Database 的版本紀錄中寫入該遷移的版本號、遷移檔內容摘要與套用時間。
2. WHEN Migration_Runner 執行，THE Migration_Runner SHALL 僅套用版本號未出現在版本紀錄中的遷移，輸出本次套用的版本號清單與數量，並在無待套用遷移時以結束碼 0 結束；若版本紀錄含有 repository 中不存在的較新版本號（回滾至前一個 App_Image 的情境），THE Migration_Runner SHALL 保留這些紀錄不變並以結束碼 0 結束。
3. FOR ALL 遷移集合，對同一 Database 連續執行 Migration_Runner 兩次時，第二次執行 SHALL 套用 0 個遷移、以結束碼 0 結束，且 Schema 與版本紀錄與第一次執行後完全相同（冪等性）。
4. IF 一個遷移執行失敗，THEN THE Migration_Runner SHALL 回復該遷移的所有 Schema 與資料變更、不寫入該遷移的版本紀錄、保留先前已成功套用的遷移及其紀錄、不執行後續遷移，並以非零結束碼結束且輸出失敗遷移的版本號。
5. WHEN 一次建置包含相對於最近一個 Release_Tag 新增的遷移，THE Pipeline SHALL 在 Ephemeral_Database 上先套用最近 Release_Tag 的全部遷移、再套用新增的遷移，接著以最近 Release_Tag 對應的 App_Image 執行 Smoke_Test（新增後移除的相容性原則）；若尚無任何 Release_Tag，THE Pipeline SHALL 略過此驗證並在 Build_Record 記錄略過原因。
6. IF 一個遷移會移除或重新命名欄位或資料表，THEN THE Pipeline SHALL 要求該遷移在遷移檔中標記為破壞性，並在套用至 Production_Environment 前取得一位非該遷移 commit 作者的 Release_Approver 針對該遷移版本號的核准，此核准須與正式發布核准分開進行；未取得核准前 THE Pipeline SHALL 不將該遷移套用至 Production_Environment。
7. IF 遷移檔版本號重複或不是正整數，或已記錄為已套用之遷移的內容摘要與 repository 中對應遷移檔不一致，THEN THE Migration_Runner SHALL 在套用任何遷移前以非零結束碼結束、不修改 Database，並輸出有問題的版本號。
8. IF 最近 Release_Tag 對應的 App_Image 在新增遷移套用後的 Smoke_Test 失敗，THEN THE Pipeline SHALL 將建置標記為失敗、停止後續發布階段，並於 Build_Record 記錄失敗的 Smoke_Test 項目與相關遷移版本號。
9. IF 一個遷移會移除或重新命名欄位或資料表但未標記為破壞性，THEN THE Pipeline SHALL 將建置標記為失敗並停止後續發布階段。

### Requirement 13: 既有 SQLite 資料一次性遷移

**User Story:** 身為現有使用者，我希望既有 SQLite 中的帳號與行程能完整搬移至新資料庫，以便升級後不遺失資料。

#### Acceptance Criteria

1. WHEN 操作者提供一個來源 SQLite 檔案路徑與目標 Database 連線設定並執行 SQLite_Importer，THE SQLite_Importer SHALL 將來源檔案中 App_Server 定義的每一個資料表的全部資料列匯入目標 Database 對應的資料表，並在單一交易內完成所有資料表的寫入。
2. THE SQLite_Importer SHALL 以唯讀方式開啟來源 SQLite 檔案，使匯入執行前後來源檔案的位元組內容雜湊值相同，且不在來源檔案所在目錄建立或修改任何檔案。
3. IF 目標 Database 中 App_Server 定義的任一資料表包含 1 筆以上資料列，THEN THE SQLite_Importer SHALL 在寫入任何資料前中止匯入、以非零結束代碼結束、輸出指出目標 Database 非空的錯誤訊息，且目標 Database 所有資料表的筆數維持執行前的數值。
4. IF 匯入過程中任一資料表的讀取或寫入失敗，THEN THE SQLite_Importer SHALL 回復該次交易中所有已寫入的資料列使目標 Database 每個資料表筆數為 0、輸出失敗的資料表名稱與錯誤原因，並以非零結束代碼結束。
5. WHEN 匯入交易成功提交，THE SQLite_Importer SHALL 針對每一個資料表輸出資料表名稱、來源筆數與目標筆數，並以結束代碼 0 結束。
6. IF 任一資料表於提交前比對出來源筆數與目標筆數不相等，THEN THE SQLite_Importer SHALL 回復整筆交易、輸出筆數不符的資料表名稱與雙方筆數，並以非零結束代碼結束。
7. FOR ALL 合成的有效 SQLite 資料集（每個資料表 0 至 1,000 筆資料列，包含 NULL 欄位值、非 ASCII 的 UTF-8 文字與 64 位元整數時間戳記），匯入後再從 Database 匯出 SHALL 產生與來源相同的資料列集合，每一資料列的主鍵與每一欄位值（包含 NULL）皆與來源相等（往返性質）。
8. WHEN 匯入完成且 App_Server 連線至目標 Database，THE App_Server SHALL 允許來源檔案中每一個未被刪除的既有使用者以其原使用者名稱與原密碼登入成功，且不要求重設密碼。
9. IF 來源檔案不存在、不是有效的 SQLite 檔案，或缺少 App_Server 定義的任一資料表，THEN THE SQLite_Importer SHALL 在連線寫入目標 Database 前中止、輸出指出原因（含缺少的資料表名稱）的錯誤訊息，並以非零結束代碼結束。
10. WHEN 匯入完成後 App_Server 於含自動遞增主鍵的資料表新增資料列，THE Database SHALL 指派大於所有已匯入主鍵最大值的新主鍵，且不產生主鍵衝突錯誤。

### Requirement 14: 部署前資料備份

**User Story:** 身為維運者，我希望每次部署前自動備份資料庫，以便發生問題時可以還原資料。

#### Acceptance Criteria

1. WHEN Pipeline 開始部署至 Staging_Environment 或 Production_Environment，THE Pipeline SHALL 先對該環境的 Database 建立一份完整一致性備份，再執行 Migration_Runner 或停止、替換該環境的任何 App_Server 容器。「完整」指備份涵蓋 App_Server 使用的所有 schema、資料表資料與序列值。「一致性」指所有資料取自同一個交易時間點的快照。
2. WHEN 備份檔建立完成，THE Pipeline SHALL 先驗證這份備份，驗證通過後才繼續部署。驗證條件為：檔案大小大於 0 位元組、Database 的還原工具能完整讀取並列出備份內容，以及已計算並保存這份備份檔的校驗碼。
3. IF 備份建立失敗、備份驗證失敗，或備份作業開始後 30 分鐘內未完成，THEN THE Pipeline SHALL 中止部署且不執行 Migration_Runner，保持目標環境的 App_Server 與 Database 不變，將建置標記為失敗，並在 Build_Record 記錄失敗原因（建立失敗、驗證失敗或逾時）。
4. THE Pipeline SHALL 將 Production_Environment 的備份存放在 Deploy_Host 上一個不屬於任何 Docker 卷、也不在 repository 工作目錄內的目錄，且只有維運帳號擁有該目錄與備份檔的讀取與寫入權限。
5. WHEN 一份新的 Production_Environment 備份通過第 2 項的驗證，且已保存的已驗證備份超過 14 份，THE Pipeline SHALL 依建立時間刪除最舊的備份，直到剩下 14 份。IF 新備份未通過驗證，THEN THE Pipeline SHALL 不刪除任何既有備份。
6. WHEN 排程觸發還原演練（兩次演練間隔最多 30 日），THE Pipeline SHALL 將最新一份已驗證的 Production_Environment 備份還原到一個隔離的 Database，並對連接該 Database 的隔離 App_Server 實例執行 Smoke_Test。這個隔離 Database 不與 Production_Environment 的 App_Server 或 Database 共用網路或資料卷，演練結束後即銷毀。THE Pipeline SHALL 在 Build_Record 記錄使用的備份識別碼、還原耗時（秒）與 Smoke_Test 結果。
7. IF 還原演練中的還原作業失敗，或 Smoke_Test 有任何一項未通過，THEN THE Pipeline SHALL 將該次演練的建置標記為失敗，在 Build_Record 記錄失敗的步驟與使用的備份識別碼，並保留所有既有備份。
8. WHEN 一份備份通過驗證，THE Pipeline SHALL 在該次部署的 Build_Record 記錄以下資訊：備份識別碼、目標環境名稱、含時區的 ISO 8601 建立時間、檔案大小（位元組）與校驗碼。

### Requirement 15: 秘密與憑證管理

**User Story:** 身為安全負責人，我希望所有秘密僅由 Jenkins 憑證管理提供，以便秘密不會出現在 repository、映像或日誌中。

#### Acceptance Criteria

1. THE Pipeline SHALL 僅從 Credential_Store 取得 Database 憑證、Registry 憑證、Deploy_Host 部署憑證、映像簽章金鑰與 Setup_Token，且不從 repository 檔案、Jenkinsfile 明文、建置參數預設值或 Build_Agent 本機檔案讀取上述任何值。
2. THE Pipeline SHALL 僅在需要某一憑證的階段範圍內將該憑證提供給該階段，並在該階段結束後不再於後續階段的環境變數中保留該憑證。
3. IF 某一階段所需的憑證在 Credential_Store 中不存在或無法讀取，THEN THE Pipeline SHALL 在該階段執行任何指令前將建置標記為失敗、輸出僅包含憑證識別名稱（不含值）的錯誤訊息，且不以預設值或空值繼續執行。
4. THE Pipeline SHALL 在 Jenkins 主控台日誌、測試報告、掃描報告與 Build_Record 中，將每一個來自 Credential_Store 的值以遮罩字元取代，使該值的完整原文、其 Base64 編碼形式與其 URL 編碼形式皆不出現；THE Pipeline SHALL 在將日誌與報告存入 Build_Record 前，掃描這些檔案中是否出現上述三種形式，IF 偵測到任一形式，THEN THE Pipeline SHALL 不存入該檔案的未遮罩版本並將建置標記為失敗。
5. THE App_Image SHALL 不包含符合下列任一條件的檔案：`.env*`、副檔名為 `.pem`、`.key`、`.p12`、`.pfx`、`.crt` 的檔案、`data/` 目錄內容、副檔名為 `.db`、`.sqlite`、`.sqlite3` 的資料庫檔案，以及 `tests/` 目錄內容；且 Requirement 17 的 App_Image 秘密掃描結果中偵測到的秘密數量 SHALL 為 0。
6. WHERE 雲端 AI 收據辨識未經明確啟用（預設狀態），THE Pipeline SHALL 在 Test_Environment、Staging_Environment 與 Production_Environment 中將 `CAMPING_OPENAI_API_KEY`、`CAMPING_OPENAI_API_KEY_FILE`、`CAMPING_OPENAI_MODEL_ID`、`CAMPING_OPENAI_IMAGE_DETAIL` 與 `CAMPING_OPENAI_MAX_COMPLETION_TOKENS` 設為空字串。
7. WHERE 雲端 AI 收據辨識經 Release_Approver 於 Pipeline 設定中針對特定環境明確啟用，THE Pipeline SHALL 僅從 Credential_Store 取得 `CAMPING_OPENAI_*` 值，且僅提供給部署至該已啟用環境的 Trusted_Ref 建置。
8. WHILE 執行 Untrusted_PR 建置，THE Pipeline SHALL 將所有 `CAMPING_OPENAI_*` 變數設為空字串，不論雲端 AI 收據辨識是否已啟用。
9. THE Deploy_Host 部署憑證 SHALL 僅具備以下權限：自 Registry 拉取 App_Image（不含推送或刪除）、於 Deploy_Host 執行 Docker Compose 部署指令、執行 Migration_Runner，以及寫入 Database 備份；且 Staging_Environment 與 Production_Environment SHALL 使用不同的部署憑證，任一環境的部署憑證皆無法存取另一環境。

### Requirement 16: App_Image 建置

**User Story:** 身為維運者，我希望正式映像精簡、安全且可追蹤，以便降低攻擊面並確認上線內容。

#### Acceptance Criteria

1. WHEN 一次 `main` 建置的「QA」與「安全」Release_Gate 皆回報通過，THE Pipeline SHALL 以 repository 根目錄的 `Dockerfile` 建置 App_Image，且建置來源為該次事件指定的確切 Commit SHA；Release_Tag 建置 SHALL 不重新建置 App_Image，而沿用 Requirement 1 第 4 條查得的 Image_Digest。
2. THE `Dockerfile` SHALL 使用至少兩個階段的 multi-stage build，且最終階段僅包含 Bun 1.4.x 執行環境（精確版本 1.4.4，與 Build_Image 的 Bun 為相同的精確版本）、伺服器打包成品（建置時將 `scripts/serve.mjs`、`server/` 及其自 `src/` 匯入的模組打包成的單一檔案）、Migration_Runner 與遷移檔、`dist/` 前端建置成品，以及 `package.json` 中 `dependencies` 所列的正式相依套件；最終階段 SHALL 不包含 `src/` 下的任何原始檔、`devDependencies`、`tests/`、Playwright、Chromium 或建置工具。
3. THE `Dockerfile` SHALL 在每一個 `FROM` 指令中以 `@sha256:` digest 固定基底映像，並以 `bun install --frozen-lockfile` 安裝相依套件；IF `bun.lock` 與 `package.json` 不一致，THEN 映像建置 SHALL 失敗。
4. THE App_Image SHALL 以 UID 與 GID 皆不為 0 的非 root 使用者執行 App_Server，且該使用者對伺服器打包成品、`dist/` 與遷移檔不具寫入權限。
5. THE App_Image SHALL 以 OCI 標籤 `org.opencontainers.image.revision` 記錄 40 字元完整 Commit SHA、以 `org.opencontainers.image.version` 記錄 `main-` 加上 7 字元短 Commit SHA，並以 `org.opencontainers.image.created` 記錄 RFC 3339 UTC 格式的建置時間；Release_Tag 名稱 SHALL 透過 Requirement 16 第 6 條的 Registry 版本標籤與該 Release_Tag 建置的 Build_Record 記錄，而不改變 Image_Digest。
6. WHEN App_Image 建置完成，THE Pipeline SHALL 以 40 字元完整 Commit SHA 作為 App_Image 的標籤；WHERE 建置來源為 Release_Tag，THE Pipeline SHALL 另外加上與 Release_Tag 名稱相同的版本標籤，且兩個標籤指向同一個 Image_Digest。
7. THE `.dockerignore` SHALL 排除 `data/`、`.env*`、`tests/`、`node_modules/`、`.git/`、`*.log`、`*.sqlite*`、`test-results/` 與 `playwright-report/`。
8. IF App_Image 建置步驟以非零結束碼結束，THEN THE Pipeline SHALL 停止 Pipeline、不推送任何 App_Image 或標籤至 Registry，並將建置標記為失敗且於 Build_Record 保存建置日誌。
9. WHEN App_Image 建置完成，THE Pipeline SHALL 檢查 App_Image 檔案系統不包含 `.env*` 檔、`*.sqlite*` 檔、`tests/` 目錄與 `devDependencies` 套件，且執行使用者 UID 不為 0；IF 任一檢查失敗，THEN THE Pipeline SHALL 停止 Pipeline 且不推送 App_Image。
10. IF Registry 中已存在相同名稱的版本標籤且指向不同的 Image_Digest，THEN THE Pipeline SHALL 拒絕覆寫該標籤、停止 Pipeline 並將建置標記為失敗。

### Requirement 17: 映像掃描、SBOM、簽章與推送

**User Story:** 身為安全負責人，我希望只有經掃描、簽章的映像能推送與部署，以便確保部署內容未被竄改且無已知高風險漏洞。

#### Acceptance Criteria

1. WHEN App_Image 建置完成且尚未推送至 Registry，THE Pipeline SHALL 掃描 App_Image 的作業系統套件漏洞、應用程式相依套件漏洞及秘密，並以機器可讀格式保存掃描報告至 Build_Record。
2. IF App_Image 掃描回報一個或多個不屬於未過期 Approved_Exception 的 Critical_High_Finding，或偵測到一個或多個秘密，THEN THE Pipeline SHALL 將建置標記為失敗、停止所有後續階段、不推送 App_Image 至 Registry，且掃描報告中以遮罩形式呈現秘密值。
3. IF App_Image 掃描無法完成（掃描工具以非零結束碼結束、執行超過 15 分鐘或漏洞資料庫無法載入），THEN THE Pipeline SHALL 將建置標記為失敗且不推送 App_Image 至 Registry。
4. WHEN App_Image 掃描通過，THE Pipeline SHALL 產生列出 App_Image 所有作業系統套件與應用程式相依套件名稱及版本的機器可讀 SBOM，並將 SBOM 與對應的 Image_Digest 一併保存至 Build_Record。
5. WHEN SBOM 產生完成，THE Pipeline SHALL 推送 App_Image 至 Registry，以 Credential_Store 中的映像簽章金鑰對該 App_Image 的 Image_Digest 簽章，將簽章推送至 Registry，並於 Build_Record 記錄 Image_Digest 與簽章結果。
6. IF App_Image 推送失敗、簽章失敗，或 Registry 回報的 Image_Digest 與 Pipeline 建置的 Image_Digest 不一致，THEN THE Pipeline SHALL 將建置標記為失敗並不執行任何部署階段。
7. WHEN Pipeline 準備將 App_Image 部署至 Deploy_Host，THE Pipeline SHALL 在 Deploy_Host 拉取或啟動 App_Image 之前，以對應映像簽章金鑰的公鑰驗證待部署 Image_Digest 的簽章，並以 Image_Digest 而非標籤指定要部署的 App_Image。
8. IF 待部署 Image_Digest 在 Registry 中沒有簽章、簽章無法以設定的公鑰驗證，或簽章對象與待部署 Image_Digest 不符，THEN THE Pipeline SHALL 中止部署、讓 Deploy_Host 上目前執行中的 App_Image 維持不變，並將建置標記為失敗。

### Requirement 18: Staging 部署與驗證

**User Story:** 身為 QA 負責人，我希望每次合併至 `main` 都在 Staging 驗證正式映像，以便正式發布前確認實際部署成品可用。

#### Acceptance Criteria

1. WHEN 建置來源為 `main` 的 App_Image 成功推送至 Registry，THE Pipeline SHALL 以該次推送取得的 Image_Digest（而非可變動的 Tag）將 App_Image 部署至 Staging_Environment，且 Staging_Environment 執行中容器的 Image_Digest SHALL 與推送取得的 Image_Digest 完全相同。
2. WHEN Staging_Environment 部署階段開始且 Staging_Environment 的 Database 備份已完成，THE Pipeline SHALL 於啟動新版 App_Server 容器前，以新版 App_Image 所含的遷移檔對 Staging_Environment 的 Database 執行 Migration_Runner。
3. WHEN 新版 App_Server 容器於 Staging_Environment 啟動，THE Pipeline SHALL 於 120 秒內每 10 秒執行一次 Health_Check，並於連續 3 次 Health_Check 成功後執行 Smoke_Test，Smoke_Test SHALL 於 10 分鐘內完成。
4. WHEN Staging_Environment 的 Health_Check 達成連續 3 次成功且 Smoke_Test 全部項目通過，THE Pipeline SHALL 於 Build_Record 將該 Image_Digest 記錄為已通過 Staging 驗證，並記錄對應的 Commit SHA 與驗證完成時間。
5. IF Staging_Environment 的新版 App_Server 容器於啟動後 120 秒內未達成連續 3 次 Health_Check 成功，或 Smoke_Test 任一項目失敗或於 10 分鐘內未完成，THEN THE Pipeline SHALL 於 5 分鐘內將 Staging_Environment 還原為前一個已通過 Staging 驗證的 Image_Digest 並確認還原後 Health_Check 成功、不將失敗的 Image_Digest 記錄為已通過 Staging 驗證，並將建置標記為失敗。
6. THE Staging_Environment SHALL 使用與 Production_Environment 不同的 Database 實例與不同的 Database 憑證，Staging_Environment 的憑證 SHALL 無法連線至 Production_Environment 的 Database，且 Staging_Environment 的 Database SHALL 僅包含合成資料。
7. IF Staging_Environment 的 Migration_Runner 以非零結束碼結束，THEN THE Pipeline SHALL 中止 Staging 部署、不啟動新版 App_Server 容器、維持現有 Staging_Environment 容器持續執行，並將建置標記為失敗。
8. IF Staging_Environment 驗證失敗且不存在任何先前已通過 Staging 驗證的 Image_Digest，THEN THE Pipeline SHALL 停止新版 App_Server 容器、於 Build_Record 記錄無可還原的 Image_Digest，並將建置標記為失敗。
9. WHILE 一次 Staging_Environment 部署與驗證正在進行，THE Pipeline SHALL 使其他來源為 `main` 的建置於 Staging 部署階段前等待，確保同一時間最多僅有 1 個建置部署至 Staging_Environment。

### Requirement 19: 正式發布人工核准

**User Story:** 身為發布負責人，我希望正式發布需經授權人員核准，以便只有經確認的版本上線。

#### Acceptance Criteria

1. WHEN 一個 Release_Tag 建置通過 QA、安全、映像與 Staging 四個 Release_Gate，THE Pipeline SHALL 在任何 Production_Environment 部署階段開始前暫停，等待 Release_Approver 核准或拒絕，且暫停期間不對 Production_Environment 做任何變更。
2. WHEN Pipeline 暫停等待核准，THE Pipeline SHALL 在 Jenkins 核准畫面顯示 Release_Tag 名稱、完整 Commit SHA、完整 Image_Digest、Staging_Environment 的 Health_Check 與 Smoke_Test 結果及完成時間，以及 Build_Record 中安全掃描報告的連結。
3. IF 一個不在 Release_Approver 清單中的帳號嘗試核准或拒絕，THEN THE Pipeline SHALL 拒絕該操作、維持等待狀態，並於 Build_Record 記錄該帳號與嘗試時間。
4. IF 自 Pipeline 開始暫停起算 24 小時內未收到 Release_Approver 的核准或拒絕，THEN THE Pipeline SHALL 中止正式發布、不執行任何 Production_Environment 部署階段，並將建置標記為已中止。
5. IF Release_Tag 指向的 commit 對應之 Image_Digest 未記錄為已通過 Staging 驗證，THEN THE Pipeline SHALL 不進入等待核准狀態、拒絕正式部署、將建置標記為失敗，並在 Jenkins 建置摘要中顯示缺少 Staging 驗證的原因。
6. WHEN Release_Approver 核准正式部署，THE Pipeline SHALL 於 Build_Record 記錄核准人帳號、含時區的核准時間，以及核准畫面所顯示的 Image_Digest。
7. IF Release_Approver 拒絕正式部署，THEN THE Pipeline SHALL 中止正式發布、不對 Production_Environment 做任何變更、將建置標記為已中止，並於 Build_Record 記錄拒絕人帳號與拒絕時間。
8. IF 收到核准時 Release_Tag 指向的 Commit SHA 與核准畫面顯示的 Commit SHA 不一致，THEN THE Pipeline SHALL 拒絕正式部署、將建置標記為失敗，並在 Jenkins 建置摘要中顯示 Tag 已變更的原因。

### Requirement 20: 正式部署、健康檢查與自動回滾

**User Story:** 身為 LAN 使用者，我希望正式部署不中斷服務且出錯時自動恢復，以便持續使用應用程式。

#### Acceptance Criteria

1. WHEN Release_Approver 核准正式部署，THE Pipeline SHALL 自 Registry 拉取與 Staging_Environment 驗證記錄完全相同的 Image_Digest 部署至 Production_Environment，不重新建置 App_Image，且部署後 Production_Environment 新版 App_Server 容器的 Image_Digest SHALL 與該驗證記錄相符。
2. WHEN 正式部署開始，THE Deploy_Host SHALL 以 Docker Compose 啟動新版 App_Server 容器且 reverse proxy 不將任何使用者請求導向該容器，並於流量切換完成前由舊版 App_Server 容器處理 100% 的使用者請求。
3. WHEN 新版 App_Server 容器啟動後 120 秒內，以每 5 秒一次執行的 Health_Check 連續 3 次成功，THE Deploy_Host SHALL 透過 reverse proxy 將流量切換至新版 App_Server 容器，切換前已進入舊版容器的請求 SHALL 由舊版容器處理完成（最長 30 秒），且切換期間使用者請求 SHALL 不因切換產生連線失敗或閘道錯誤回應。
4. IF 新版 App_Server 容器於啟動後 120 秒內未連續 3 次 Health_Check 成功，THEN THE Pipeline SHALL 停止並移除新版容器、不變更 reverse proxy 設定、維持舊版容器處理 100% 流量、將建置標記為失敗，並將各次 Health_Check 結果保存至 Build_Record。
5. WHEN 流量切換至新版 App_Server 容器，THE Pipeline SHALL 進入 10 分鐘觀察期並保持舊版容器運行，於觀察期內每 10 秒執行一次 Health_Check（共 60 次），並於切換後 60 秒內及觀察期結束前 60 秒內各執行一次 Smoke_Test。
6. IF 觀察期間連續 3 次 Health_Check 失敗或任一次 Smoke_Test 失敗，THEN THE Pipeline SHALL 於偵測到失敗後 60 秒內將 reverse proxy 流量切回仍在運行的前一個 Image_Digest 之舊版容器、停止新版容器，並將建置標記為失敗。
7. WHEN 觀察期結束且未觸發回滾，THE Pipeline SHALL 停止舊版容器、將本次 Image_Digest 記錄為 Production_Environment 目前版本，並於 Deploy_Host 保留最近 3 個成功完成觀察期之 Image_Digest 的映像；超過 3 個時 THE Pipeline SHALL 移除其中最舊者的映像。
8. WHEN Release_Approver 手動觸發回滾並指定一個 Deploy_Host 已保留的 Image_Digest，THE Pipeline SHALL 依準則 2 至 4 相同的容器啟動、Health_Check（120 秒內每 5 秒一次、連續 3 次成功）與流量切換規則，將 Production_Environment 切換至該 Image_Digest。
9. WHEN 自動或手動回滾執行，THE Pipeline SHALL 不執行 Migration_Runner、保持 Database Schema 與已套用遷移版本紀錄不變，並於 Build_Record 記錄觸發方式（自動或手動）、手動觸發者帳號、來源與目標 Image_Digest、回滾原因（失敗的 Health_Check 或 Smoke_Test 結果，或手動輸入的理由）與完成時間。
10. IF 手動回滾指定的 Image_Digest 不在 Deploy_Host 保留的最近 3 個 Image_Digest 中，或觸發者不是 Release_Approver，THEN THE Pipeline SHALL 拒絕該回滾、維持 Production_Environment 目前版本與 reverse proxy 設定不變，並回報指出拒絕原因的錯誤。
11. IF 回滾切換完成後 120 秒內 Production_Environment 未連續 3 次 Health_Check 成功，THEN THE Pipeline SHALL 停止任何進一步的自動切換、維持目前容器與 reverse proxy 狀態、將建置標記為失敗，並於 Build_Record 記錄回滾失敗且需人工介入。
12. WHILE 一個對 Production_Environment 的部署或回滾正在執行，THE Pipeline SHALL 拒絕其他對 Production_Environment 的部署與回滾請求，並回報指出已有部署進行中的錯誤。

### Requirement 21: 追蹤與報告保存

**User Story:** 身為稽核者，我希望每次執行與部署都可追蹤至來源與證據，以便事後調查問題。

#### Acceptance Criteria

1. WHEN 一次 Pipeline 執行開始，THE Pipeline SHALL 為該執行建立唯一的 Build_Record，並記錄 Jenkins 建置編號、開始時間、完整 40 字元 Commit SHA、觸發事件類型（Pull Request、`main` 推送、其他分支推送或 Release_Tag 推送）、分支名稱或 Tag 名稱與 Build_Image digest。
2. WHEN 一個 Pipeline 階段完成，THE Pipeline SHALL 將該階段產生的證據寫入 Build_Record，包含測試報告、安全報告、Image_Digest、SBOM、部署環境（Staging_Environment 或 Production_Environment）、Release_Approver 帳號與核准時間；對於該次執行未產生的項目，THE Pipeline SHALL 將其標記為「不適用」或「未執行」，而不是留空。
3. THE Pipeline SHALL 保留 Release_Tag 建置的 Build_Record 及其所有報告、SBOM 與失敗證據，自該執行結束時間起至少 365 天。
4. THE Pipeline SHALL 保留 `main` 建置的 Build_Record 及其所有報告、SBOM 與失敗證據，自該執行結束時間起至少 90 天。
5. THE Pipeline SHALL 保留 Untrusted_PR 建置的 Build_Record 及其所有報告與失敗證據，自該執行結束時間起至少 14 天。
6. WHILE 一個 Image_Digest 正在 Production_Environment 執行，或屬於 Deploy_Host 保留的最近 3 個可回滾 Image_Digest 之一，THE Pipeline SHALL 保留產生並部署該 Image_Digest 的 Build_Record，即使已超過第 3 至 5 條的保留期限。
7. WHEN 稽核者在 Jenkins 以一個 Production_Environment 目前執行或保留可回滾的 Image_Digest 查詢，THE Jenkins SHALL 回傳對應的 Build_Record，並顯示 Commit SHA、Release_Tag、Release_Approver 帳號、核准時間與 Production_Environment 部署時間。
8. IF 稽核者查詢的 Image_Digest 沒有對應的 Build_Record，THEN THE Jenkins SHALL 回傳表示查無對應紀錄的結果，且不回傳任何其他 Image_Digest 的 Build_Record。
9. THE Build_Record SHALL 不包含 Credential_Store 中任何秘密的明文值（包含 Webhook secret、Registry 憑證、部署憑證、Database 密碼與簽章金鑰），且 THE Pipeline SHALL 在將主控台日誌存入 Build_Record 前遮蔽上述值。
10. THE Build_Record SHALL 不包含 Production_Environment Database 中的使用者資料列內容（包含帳號、行程與支出紀錄），Smoke_Test 的證據僅可包含合成帳號的資料。
11. WHEN 一次 Pipeline 執行以成功、失敗或已中止結束，THE Pipeline SHALL 在 Build_Record 記錄最終結果、結束時間，以及結果為失敗或已中止時第一個失敗或中止的階段名稱。
12. IF 非 Jenkins 管理員的使用者嘗試在保留期限內修改或刪除 Build_Record，THEN THE Jenkins SHALL 拒絕該操作並保留 Build_Record 原內容不變。

### Requirement 22: 通知

**User Story:** 身為開發者，我希望在 GitHub 與 Jenkins 看到建置結果，以便快速得知失敗並處理。

#### Acceptance Criteria

1. WHEN Pipeline 開始執行，THE Pipeline SHALL 在執行任何安裝、建置或測試階段之前，將該次建置所使用之確切 Commit SHA 的 GitHub commit status 設為 pending，且該狀態附上 Jenkins 建置連結。
2. WHEN Pipeline 執行結束且所有階段與 Release_Gate 皆通過，THE Pipeline SHALL 於結束後 60 秒內將同一 Commit SHA 的 GitHub commit status 設為 success，並附上 Jenkins 建置連結。
3. WHEN Pipeline 執行結束且結果為失敗、中止、逾時或因人工核准被拒絕而停止，THE Pipeline SHALL 於結束後 60 秒內將同一 Commit SHA 的 GitHub commit status 設為 failure，並附上 Jenkins 建置連結與失敗階段名稱。
4. IF Pipeline 失敗，THEN THE Pipeline SHALL 在 Jenkins 建置摘要中顯示第一個失敗的階段名稱；若失敗由 Release_Gate 造成，另顯示該 Release_Gate 名稱、未通過的條件，以及對應報告的連結。
5. WHEN Production_Environment 依 Requirement 20 發生自動回滾，THE Pipeline SHALL 將建置結果標記為失敗，並在 Jenkins 建置摘要中顯示回滾原因（Health_Check 連續失敗或 Smoke_Test 失敗）、回滾前的 Image_Digest 與回滾後的 Image_Digest。
6. THE Pipeline SHALL 以獨立的通知階段實作所有通知，使新增一個通知管道時只需修改該通知階段，不需修改任何建置、測試、安全掃描或部署階段。
7. IF 設定 GitHub commit status 或傳送任一通知管道失敗，THEN THE Pipeline SHALL 最多重試 3 次；若仍失敗，則在 Jenkins 建置摘要中顯示通知失敗的管道名稱，且不改變原本的建置結果。
8. THE Pipeline SHALL 不在 GitHub commit status 描述、Jenkins 建置摘要或任何通知內容中包含秘密值或 Production_Environment 的使用者資料。

### Requirement 23: 發布門檻

**User Story:** 身為發布負責人，我希望發布門檻明確且一致執行，以便任何未通過的關卡都會阻止上線。

#### Acceptance Criteria

1. IF 任一 Release_Gate 未通過，THEN THE Pipeline SHALL 不執行該 Release_Gate 之後的任何階段、將截至失敗時已產生的所有報告保存至 Build_Record、於 Build_Record 記錄未通過的 Release_Gate 名稱與未符合的通過條件，並將建置標記為失敗；其中「正式核准」關卡因等待逾時或被拒絕未通過時依 Requirement 19 將建置標記為已中止，「上線後」關卡未通過時先依 Requirement 20 執行回滾再將建置標記為失敗。
2. THE Pipeline SHALL 依下表由上而下的順序（QA → 安全 → 映像 → Staging → 正式核准 → 上線後）評估 Release_Gate，且於前一個 Release_Gate 通過前不評估下一個 Release_Gate；「映像」Release_Gate 於 App_Image 建置、掃描、推送與簽章完成後評估（Release_Tag 建置則於查得 Requirement 1 第 4 條的 Image_Digest 後評估），「Staging」Release_Gate 於該 Image_Digest 部署至 Staging_Environment 並完成驗證後評估（Release_Tag 建置則檢查該 Image_Digest 的 Staging 驗證紀錄）：

| Release_Gate | 通過條件 |
|---|---|
| QA | 所有單元、API 與瀏覽器測試的失敗數與錯誤數皆為 0；所有 QA_Inventory 項目標記為通過，標記為失敗或缺少測試的項目數為 0 |
| 安全 | Security_Scanner 的秘密掃描發現數為 0；Security_Scanner 與 DAST_Scanner 回報中不屬於未過期 Approved_Exception 的 Critical_High_Finding 數為 0 |
| 映像 | App_Image 掃描偵測到的秘密數為 0 且不屬於未過期 Approved_Exception 的 Critical_High_Finding 數為 0；SBOM 已保存至 Build_Record；App_Image 簽章已推送至 Registry；Build_Record 已記錄該 Image_Digest 對應的 Commit SHA |
| Staging | 與「映像」關卡相同的 Image_Digest 部署至 Staging_Environment 後 Health_Check 成功，且 Smoke_Test 所有項目通過 |
| 正式核准 | Release_Approver 清單成員於 Pipeline 開始等待核准起 24 小時內完成核准 |
| 上線後 | 流量切換至新版起 10 分鐘觀察期內未發生連續 3 次 Health_Check 失敗，且 Smoke_Test 未失敗（Requirement 20 準則 6 的回滾條件） |

3. IF 任一 Release_Gate 的檢查階段執行錯誤、逾時，或未產生判定該關卡所需的報告，THEN THE Pipeline SHALL 將該 Release_Gate 視為未通過。
4. THE Pipeline SHALL 不提供任何可略過 Release_Gate、將未通過的 Release_Gate 改為通過，或放寬上表通過條件的建置參數、環境變數或操作選項。
5. WHEN 一個 Release_Gate 評估完成，THE Pipeline SHALL 於 Build_Record 記錄該 Release_Gate 名稱、結果（通過或未通過）、評估時間與對應的 Commit SHA。

### Requirement 24: 文件更新

**User Story:** 身為新加入的維運者，我希望 README 說明新的部署方式與安全設定，以便正確操作與維護。

#### Acceptance Criteria

1. THE README SHALL 針對 Bind_Address、Allowed_Hosts、Setup_Token 與 Database 連線設定，逐項列出環境變數名稱、用途、是否必填、預設值，以及未設定時的 App_Server 行為（包含 Requirement 8 第 4 條的非 loopback Bind_Address 未設定 Allowed_Hosts 時拒絕啟動，以及 Requirement 9 第 2 條的 Setup_Token 自動產生並僅輸出至 Deploy_Host 本機日誌）。
2. THE README 所列的 Bind_Address 與 Allowed_Hosts 預設值 SHALL 與 App_Server 實作一致，分別為 `127.0.0.1`，以及 `127.0.0.1`、`localhost` 與 `[::1]`。
3. THE README SHALL 明確說明 Staging_Environment、Registry 與 Deploy_Host 僅允許區域網路存取、Deploy_Host 僅將 Public_Port 以外的 Docker 發布連接埠開放給設定的 LAN 網段、Production_Environment 僅能經 Requirement 25 的 Edge_Proxy 對網際網路公開、Jenkins 僅公開 `/github-webhook/`，且其他公開網際網路曝露方式（包含其他連接埠轉發、其他對外公開的反向代理與通道服務）不在支援範圍內。
4. THE README SHALL 依執行順序以編號步驟說明 SQLite_Importer 的使用方式，至少包含：匯入前建立來源 `accounts.sqlite` 檔案與目標 Database 的備份、執行匯入的指令、比對輸出的每個資料表來源與目標筆數，以及以既有使用者帳號登入驗證。
5. THE README SHALL 說明 SQLite_Importer 在目標 Database 已包含使用者資料時中止匯入，以及匯入失敗時回復已匯入資料並輸出失敗資料表名稱的行為與維運者後續處理步驟。
6. THE README SHALL 以編號步驟說明由 Release_Approver 手動觸發、將 Production_Environment 切換至 Deploy_Host 保留的最近 3 個 Image_Digest 之一的回滾操作，並註明回滾時 Database Schema 保持不變。
7. THE README SHALL 以編號步驟說明將指定備份識別碼的 Database 備份還原至 Database 的操作，包含選擇最近 14 份已保留備份之一、執行還原的指令，以及還原後執行 Smoke_Test 驗證。
8. THE README SHALL 說明在本機執行 `bun test tests/*.test.js` 與 `playwright.config.js` 定義的瀏覽器測試時，建立 Ephemeral_Database、指定測試使用該 Ephemeral_Database 的環境變數，以及測試結束後銷毀 Ephemeral_Database 的指令。
9. THE README SHALL 不包含任何實際秘密值，包含 Database 密碼、Setup_Token、Registry 憑證、Deploy_Host 部署憑證與 `CAMPING_OPENAI_API_KEY`，且所有範例值皆以佔位符表示。
10. THE README SHALL 註明 Database 憑證與 Setup_Token 僅由 Credential_Store 提供，且不得寫入 repository 或 App_Image。

### Requirement 25: 在同主機 Edge_Proxy 之後公開 Production_Environment

**User Story:** 身為系統擁有者，我希望 Production_Environment 經同一主機上的 Edge_Proxy 與 Cloudflare 以 `https://www.our-littlemoments.com` 對網際網路公開，且 App_Server 仍取得真實用戶端 IP 與協定，以便公開存取時登入、Origin 檢查、Secure Cookie 與限速都正確運作，而 LAN 用戶端無法偽造轉送標頭。

#### Acceptance Criteria

1. WHEN LM_Proxy 收到 TCP 來源 IP 位於該環境 Edge_Trusted_Proxies 內的請求，THE LM_Proxy SHALL 依本需求第 3、4 與 5 條，以該請求的 `X-Forwarded-For` 與 `X-Forwarded-Proto` 決定轉送給 App_Server 的這兩個標頭值。
2. WHEN LM_Proxy 收到 TCP 來源 IP 不在 Edge_Trusted_Proxies 內的請求，THE LM_Proxy SHALL 以該 TCP 來源 IP 作為唯一的 `X-Forwarded-For` 值、以 LM_Proxy 接收該請求所用的協定作為 `X-Forwarded-Proto` 值轉送給 App_Server，不論請求原本是否附帶這兩個標頭。
3. WHEN LM_Proxy 依第 1 條決定用戶端 IP，THE LM_Proxy SHALL 取 `X-Forwarded-For` 由右往左第一個可解析為 IP 位址且不在 Edge_Trusted_Proxies 內的項目作為用戶端 IP（不存在此項目時為 TCP 來源 IP），並以只含該用戶端 IP 的單一 `X-Forwarded-For` 值轉送給 App_Server，使用戶端於最左側自行加入的位址不會成為用戶端 IP。
4. WHEN LM_Proxy 收到 TCP 來源 IP 位於 Edge_Trusted_Proxies 內、且 `X-Forwarded-Proto` 值恰為 `http` 或 `https` 的請求，THE LM_Proxy SHALL 將該值原樣作為轉送給 App_Server 的 `X-Forwarded-Proto`。
5. IF TCP 來源 IP 位於 Edge_Trusted_Proxies 內的請求缺少 `X-Forwarded-Proto`，或其值不是恰為 `http` 或 `https`，THEN THE LM_Proxy SHALL 以 LM_Proxy 接收該請求所用的協定作為轉送給 App_Server 的 `X-Forwarded-Proto`。
6. WHERE 一個環境的 Edge_Trusted_Proxies 未設定或為空字串，THE LM_Proxy SHALL 對該環境的所有請求套用第 2 條，使轉送給 App_Server 的 `X-Forwarded-For` 與 `X-Forwarded-Proto` 與未支援 Edge_Trusted_Proxies 時相同。
7. THE LM_Proxy SHALL 自該環境 `<env>.env` 的非秘密設定 `LM_EDGE_TRUSTED_PROXIES` 讀取 Edge_Trusted_Proxies，格式為以空白分隔、1 至 64 個 IPv4 或 IPv6 位址或 CIDR 項目。
8. IF Edge_Trusted_Proxies 含有無法解析為 IP 位址或 CIDR 的項目、超過 64 個項目、前綴長度為 0 的項目（例如 `0.0.0.0/0`、`::/0`），或範圍涵蓋該環境 `<env>.env` 的 `LM_LAN_CIDR`（Deploy_Host 所在實體 LAN 網段）任一整個網段的項目，或 Edge_Trusted_Proxies 非空但 `LM_LAN_CIDR` 未設定或無效，THEN THE Deploy_Script SHALL 在執行任何 Docker Compose 動作前以結束碼 2 結束、輸出指出無效項目的錯誤訊息，且不變更 LM_Proxy 的執行中設定。
9. IF LM_Proxy 啟動或重新載入設定時無法解析 Edge_Trusted_Proxies，THEN THE LM_Proxy SHALL 拒絕套用該設定（啟動失敗，或重新載入失敗並保留重新載入前的設定），且不以採信更多來源的設定處理任何請求。
10. THE Deploy_Host SHALL 將 App_Server 的 Trusted_Proxies 設定為僅含 LM_Proxy 固定 IP 的 /32 項目，不論 Edge_Trusted_Proxies 的內容（Requirement 9 第 12 條維持不變）。
11. WHEN 用戶端經 Cloudflare 與 Edge_Proxy 以 `https://www.our-littlemoments.com` 送出請求，THE App_Server SHALL 以協定 `https:` 與 Host `www.our-littlemoments.com` 重建請求網址，使 Requirement 10 第 1 條的 Origin 比對以 `https://www.our-littlemoments.com` 進行、第 5 條的 `Secure` 屬性被加上，且 Requirement 9 第 8 條與 Requirement 7 第 6 條所述的限速以該用戶端的真實 IP 計算。
12. THE README（或其連結的部署文件）SHALL 記載 Edge_Trusted_Proxies 中 Cloudflare 範圍為維運者維護的靜態清單、其來源（`https://www.cloudflare.com/ips-v4` 與 `https://www.cloudflare.com/ips-v6`），以及以編號步驟說明的更新流程：下載兩份清單、與 `prod.env` 現值比對、更新 `LM_EDGE_TRUSTED_PROXIES`、重新建立 LM_Proxy 容器，並確認經公開網址的請求在 LM_Proxy 存取日誌中記錄真實用戶端 IP。
13. THE README（或其連結的部署文件）SHALL 以編號步驟說明 Edge_Proxy 與 Cloudflare 的設定：(a) Proxy Host `www.our-littlemoments.com` 轉送至 `http://<deploy-host-lan-ip>:<prod LM_PUBLIC_PORT>`，使用 Let's Encrypt 憑證並啟用 Force SSL 與 HSTS、不啟用 WebSocket 支援；(b) Redirection Host `our-littlemoments.com` 以 HTTP 301 轉址至 `https://www.our-littlemoments.com` 並保留路徑；(c) Cloudflare DNS 記錄為 Proxied，且 SSL/TLS 加密模式為 Full (strict)；(d) Staging_Environment 不經 Edge_Proxy 公開；(e) Jenkins 只公開 `/github-webhook/`；(f) Host_Installer 的 LAN 網段包含 Edge_Proxy 連線至 LM_Proxy 時的 Docker 來源網段（或 Edge_Proxy 改用 host 網路），並以 Public_Port 宣告 80 與 443。

### Requirement 26: 公開註冊預設關閉並可由管理員切換

**User Story:** 身為系統擁有者，我希望 Production_Environment 對網際網路公開時，公開註冊一開始就是關閉的、帳號只能經旅行邀請連結建立，並能在 Admin_Page 開啟或再次關閉公開註冊而不需重新部署或重新啟動，以便控制誰能建立帳號。

本需求延伸 security-hardening spec 引用的 Registration_Policy（`publish-behind-nginx` PBN 10）：保留 `CAMPING_REGISTRATION` 的驗證與 `open` 預設值，改為以 Settings_Store 儲存值為優先，並讓 Deploy_Host 的預設值為 `closed`。

#### Acceptance Criteria

1. WHEN App_Server 處理需要 Registration_Policy 的請求，THE App_Server SHALL 於該請求當下依下列順序決定實際生效的 Registration_Policy 與其來源：Settings_Store 有 Registration_Policy 儲存值時使用該值（來源 `stored`）；否則 Registration_Seed 為 `open` 或 `closed` 時使用該值（來源 `seed`）；否則使用 `open`（來源 `default`）。
2. IF Settings_Store 中的 Registration_Policy 儲存值不是恰為 `open` 或 `closed`，THEN THE App_Server SHALL 將實際生效的 Registration_Policy 視為 `closed`、來源為 `stored`，並保留該儲存值不變。
3. IF `CAMPING_REGISTRATION` 設定為非空字串且不是恰為 `open` 或 `closed`，THEN THE App_Server SHALL 在連線 Database 或監聽任何連接埠前以非零結束碼結束，並輸出只指出變數名稱與允許值、不含該值的錯誤訊息。
4. WHEN 管理員以 `PATCH /api/admin/settings` 送出 `registrationPolicy` 欄位值恰為 `open` 或 `closed` 的請求，THE App_Server SHALL 在同一個 Database 交易內將該值、儲存時間與該管理員帳號寫入 Settings_Store，並寫入一筆動作為 `settings.registration`、內容包含該管理員帳號與新值的稽核事件，再回應 HTTP 200 與第 9 條的設定內容。
5. WHEN Settings_Store 的 Registration_Policy 儲存值被寫入，THE App_Server SHALL 對寫入完成後收到的下一個請求套用新值，不需重新啟動 App_Server 或重新部署。
6. IF 已登入但不是管理員的使用者送出 `GET /api/admin/settings` 或 `PATCH /api/admin/settings`，THEN THE App_Server SHALL 回應 HTTP 403、保留 Settings_Store 內容不變，且不寫入任何設定稽核事件。
7. IF `PATCH /api/admin/settings` 的請求本文含有 `registrationPolicy` 但其值不是恰為字串 `open` 或 `closed`、含有 `receiptAiPolicy` 但其值不是恰為字串 `all`、`admins` 或 `off`，或兩個欄位都不存在，THEN THE App_Server SHALL 回應 HTTP 400、保留 Settings_Store 中所有設定不變，且不寫入任何設定稽核事件。
8. WHEN 管理員以 `PATCH /api/admin/settings` 送出只含 `registrationPolicy` 與 `receiptAiPolicy` 其中一個有效欄位的請求，THE App_Server SHALL 只儲存該欄位對應的設定，並保持另一個設定的 Settings_Store 狀態（含沒有儲存值的狀態）不變；兩個欄位皆存在且有效時，THE App_Server SHALL 儲存兩者並各寫入一筆稽核事件。
9. WHEN 管理員以 `GET /api/admin/settings` 讀取設定，THE App_Server SHALL 回傳 `registrationPolicy` 的實際生效值、來源（`stored`、`seed` 或 `default`）、可選值 `open` 與 `closed`，以及來源為 `stored` 時的儲存時間與儲存者帳號，且 `receiptAiPolicy` 的回傳欄位與內容維持不變。
10. WHILE 實際生效的 Registration_Policy 為 `closed`，THE App_Server SHALL 對 `POST /api/register` 回應 HTTP 403 與表示需使用旅行邀請連結建立帳號的錯誤訊息，且不讀取請求本文、不計入註冊限速次數、不建立帳號。
11. WHILE 實際生效的 Registration_Policy 為 `closed`，THE Account_UI SHALL 在 `/register` 顯示目前不開放公開註冊、需向旅伴索取旅行邀請連結的說明與前往登入的連結，並以該說明取代註冊表單。
12. THE App_Server SHALL 在實際生效的 Registration_Policy 為 `open` 與 `closed` 時皆依既有規則處理 Invite_Registration，使持有有效旅行邀請連結的未登入訪客可建立帳號並加入該旅行。
13. WHEN App_Server 回應 `GET /api/session`，THE App_Server SHALL 依該請求當下實際生效的 Registration_Policy 設定 `registrationOpen` 欄位：`open` 時為 `true`，`closed` 時為 `false`。
14. WHEN 管理員開啟 Admin_Page，THE Account_UI SHALL 在「網站設定」表單中，於收據 AI 設定之外顯示 id 為 `setting-registration`、選項為開放（`open`）與關閉（`closed`）的公開註冊選單並選取實際生效值，且在選單說明文字顯示來源：來源為 `stored` 時顯示儲存者帳號與儲存時間，來源為 `seed` 時指出環境變數 `CAMPING_REGISTRATION`，來源為 `default` 時指出預設值 `open`。
15. WHEN 管理員在 Admin_Page 變更公開註冊選單並儲存「網站設定」表單，THE Account_UI SHALL 只在請求本文送出值與載入時不同的設定欄位；請求成功時顯示公開註冊設定已更新的提示並重新載入設定，請求失敗時在表單顯示錯誤訊息並保留選取值。
16. THE `deploy/compose/compose.yaml` SHALL 將 `<env>.env` 的 `CAMPING_REGISTRATION` 傳入 `app-blue`、`app-green` 與 `migrate` 服務的環境變數，並於該值未設定或為空字串時傳入 `closed`；`deploy/compose/staging.env.example` 與 `deploy/compose/prod.env.example` SHALL 包含 `CAMPING_REGISTRATION=closed`。
17. WHEN App_Server 啟動完成，THE App_Server SHALL 在啟動摘要中輸出實際生效的 Registration_Policy 與其來源（`admin setting`、`CAMPING_REGISTRATION` 或 `default`），且該摘要不包含任何秘密值。
18. THE README SHALL 在環境變數表列出 `CAMPING_REGISTRATION` 為 Registration_Seed、App_Server 未設定時的預設值 `open` 與 Deploy_Host 經 `compose.yaml` 未設定時傳入的 `closed`，並說明管理員在 Admin_Page 儲存 Registration_Policy 後 `CAMPING_REGISTRATION` 不再影響實際生效值，直到維運者移除 Settings_Store 中的該筆儲存值，以及移除的方式。
19. THE `tests/*.test.js` 單元與 API 測試 SHALL 涵蓋第 1、2 條的決定順序（儲存值、Registration_Seed、預設值與無效儲存值）、管理員在同一個 App_Server 執行期間依序將 Registration_Policy 設為 `closed` 再設為 `open` 且每次儲存後的下一個 `POST /api/register` 與 `GET /api/session` 皆反映新值、第 6 條的 403、第 7 條的 400 且 Settings_Store 不變，以及兩種 Registration_Policy 下 Invite_Registration 皆成功。
20. THE QA_Inventory SHALL 包含一個角色為 admin、頁面為 `/admin`、控制項為 `setting-registration` 的項目，情境為管理員將公開註冊由開放改為關閉再改回開放並確認 `/register` 的顯示隨之改變，且該項目對應至少 1 個在瀏覽器測試中執行的測試案例 ID（Requirement 5 第 1 與 4 條）。

### Requirement 27: Smoke_Test 合成帳號與合成行程的佈建

**User Story:** 身為維運者，我希望以 Host_Operator 執行、可重複執行的維運指令，在 Staging_Environment 與 Production_Environment 各建立一次 Smoke_Account 與 Smoke_Fixture，以便第一次部署後 Requirement 18.3 與 20.5 的 Smoke_Test 能通過，且 Deploy_Host 部署憑證的權限維持 Requirement 15.9 的範圍。

背景：`scripts/smoke.mjs` 以 Smoke_Account 登入並要求 `GET /api/trips` 含 Smoke_Fixture，但 repository 中沒有任何流程在 Staging_Environment 或 Production_Environment 建立這兩項資料（只有還原演練在 drill Database 內建立自己的臨時資料）。Deploy_Host 的公開註冊預設關閉（Requirement 26），`create-admin` 在已有任何帳號時拒絕執行；而 `GET /api/session` 的 `needsSetup` 只在使用者數量為 0 時為 `true`，所以 Smoke_Account 一旦先於第一個管理員建立，該環境就無法再經首次管理員設定或 `create-admin` 建立管理員（Requirement 9.1、9.6）。本需求因此要求先建立管理員、再建立 Smoke_Account。

#### Acceptance Criteria

1. THE Smoke_Provisioner SHALL 只透過 `CAMPING_DATABASE_*` 環境變數（與 App_Server 相同的 `parseConfig` 驗證規則，Requirement 11.1、11.8）連線至 Database，且 THE App_Image SHALL 包含打包後的 `/app/tools/create-smoke-account.js`，並仍符合 Requirement 15.5 與 16.9 的映像內容規則。
2. IF 任一 `CAMPING_DATABASE_*` 變數缺少或無效、指令列含未定義的選項（包含 `--password` 及 `--name=value` 形式）或多餘的位置參數，THEN THE Smoke_Provisioner SHALL 在連線 Database 前以結束碼 2 結束，且錯誤訊息只指出變數名稱或用法，不含任何設定值。
3. THE Smoke_Provisioner SHALL 只從下列三種來源之一讀取 Smoke_Account 密碼：`--password-file <path>` 指定的單行檔案、終端機隱藏輸入（輸入兩次確認），或沒有終端機時 stdin 的一行；THE Smoke_Provisioner SHALL 不從指令列參數或環境變數讀取密碼，且不在任何輸出或稽核事件中包含密碼。
4. IF 密碼長度不在 12 至 128 個字元之間、密碼輸入超過 4096 位元組，或密碼輸入含有一個以上的換行，THEN THE Smoke_Provisioner SHALL 以結束碼 1 結束且不寫入 Database。
5. THE Smoke_Provisioner SHALL 預設 Smoke_Account 帳號名稱為 `smoke-bot`、顯示名稱為 `Smoke Bot`、Smoke_Fixture 標題為 `smoke-fixture`，並接受 `--username <name>` 與 `--fixture <title>` 覆寫；IF `--username` 不符合 App_Server 帳號名稱規則（`validateUsername`），或 `--fixture` 不是有效的行程標題（1 至 100 個字元、不含 U+0000）或含前後空白，THEN THE Smoke_Provisioner SHALL 在連線 Database 前以結束碼 2 結束。
6. IF Database 無法連線，或缺少 App_Server 的資料表（遷移尚未套用），THEN THE Smoke_Provisioner SHALL 以結束碼 1 結束、不寫入任何資料，且錯誤訊息只含 Database 主機、連接埠與錯誤代碼。
7. IF Database 中沒有任何未刪除的管理員帳號，THEN THE Smoke_Provisioner SHALL 以結束碼 1 結束、不建立任何帳號或行程，並輸出指出須先以 `create-admin` 建立第一個管理員的訊息（Requirement 9.1、9.6）。
8. WHEN 帳號名稱為 Smoke_Account 名稱的使用者不存在，THE Smoke_Provisioner SHALL 建立角色為 member 的 Smoke_Account，以 Requirement 10.7 的 scrypt 參數雜湊密碼，並寫入一筆動作為 `smoke.account.create`、目標為該帳號、不含密碼或雜湊的稽核事件。
9. WHEN 帳號名稱為 Smoke_Account 名稱的使用者已存在、角色為 member 且未被刪除，THE Smoke_Provisioner SHALL 保留該帳號的角色、顯示名稱、密碼雜湊與 Session 不變，並在輸出中標示該帳號為既有帳號（變更密碼由維運者以 `reset-password` 進行）。
10. IF 帳號名稱為 Smoke_Account 名稱的使用者已存在且角色為 admin 或已被刪除，THEN THE Smoke_Provisioner SHALL 以結束碼 1 結束、不建立或修改任何帳號或行程，並輸出指出該帳號為管理員或已停用的訊息。
11. WHEN Smoke_Account 可見的行程（與 `GET /api/trips` 對該帳號回傳的集合相同）中沒有標題恰為 Smoke_Fixture 標題者，THE Smoke_Provisioner SHALL 建立一個由 Smoke_Account 擁有且 Smoke_Account 為成員的行程，其行程狀態以 `POST /api/trips` 相同的程式路徑產生並通過 `isValidState`，開始與結束日期為固定的有效日期，並寫入一筆動作為 `smoke.fixture.create`、目標為該行程的稽核事件。
12. WHEN Smoke_Account 可見的行程中已有標題恰為 Smoke_Fixture 標題者，THE Smoke_Provisioner SHALL 保留該行程不變，並在輸出中標示 Smoke_Fixture 為既有行程。
13. THE Smoke_Provisioner SHALL 在單一個取得 App_Server 寫入鎖的寫入交易（`withWriteTx`）內完成第 7 至 12 條的檢查與寫入；IF 交易內任一步驟失敗，THEN THE Smoke_Provisioner SHALL 回復該交易的所有變更並以結束碼 1 結束。
14. FOR ALL 初始 Database 狀態，以相同參數與密碼連續執行 Smoke_Provisioner 兩次時，第二次執行 SHALL 不寫入任何資料列（包含稽核事件），並回報 Smoke_Account 與 Smoke_Fixture 皆為既有（冪等性）。
15. WHEN Smoke_Provisioner 成功完成，THE Smoke_Provisioner SHALL 在 stdout 輸出恰好一行 JSON，內容只含帳號名稱、Smoke_Account 為新建或既有、Smoke_Fixture 標題與其為新建或既有，並以結束碼 0 結束；輸出不含密碼、密碼雜湊、Session Token 或其他使用者的資料（Requirement 21.10）。
16. WHEN Smoke_Provisioner 建立 Smoke_Account 與 Smoke_Fixture 後，以同一 Database 的 App_Server 及相同的帳號名稱、密碼與 Smoke_Fixture 標題執行 `scripts/smoke.mjs` 的 Smoke_Test，THE Smoke_Test SHALL 所有步驟皆通過。
17. THE Deploy_Script SHALL 提供 `lm-deploy <env> smoke-account <digest> [--username <name>] [--fixture <title>]` 子命令，並只允許 Host_Operator 執行：IF 呼叫時已設定 `SSH_ORIGINAL_COMMAND`、有效使用者不是 root，或 `SUDO_USER` 為部署帳號（`lm-deploy-staging`、`lm-deploy-prod`），THEN THE Deploy_Script SHALL 在取得鎖或執行任何 Docker 指令前以結束碼 2 結束，並輸出指出此子命令只限 Host_Operator 的錯誤（Requirement 15.9）。
18. THE Deploy_Script SHALL 只接受明列子命令清單內的 SSH forced command 子命令，且該清單不含 `smoke-account`；IF `SSH_ORIGINAL_COMMAND` 的子命令不在清單內，THEN THE Deploy_Script SHALL 在取得鎖或執行任何 Docker 指令前以結束碼 2 結束，使部署憑證無法建立帳號（Requirement 15.9）。
19. IF `smoke-account` 的 `<digest>` 不是 `sha256:<64 hex>` 或 `<LM_IMAGE_REPO>@sha256:<64 hex>`、`--username` 或 `--fixture` 的值不符合第 5 條的格式、stdin 為終端機、stdin 沒有內容、超過 4096 位元組或含 NUL 字元，或該環境的 `app.env` 或 `db.env` 不存在，THEN THE Deploy_Script SHALL 在執行任何 Docker 指令前以結束碼 2 結束。
20. IF 執行 `smoke-account` 時該環境的部署鎖已被持有，THEN THE Deploy_Script SHALL 以結束碼 4 結束；IF 該環境有未完成的部署（狀態不是 idle），THEN THE Deploy_Script SHALL 以結束碼 3 結束；兩種情況皆不執行任何 Docker 指令。
21. WHEN Host_Operator 以有效參數執行 `smoke-account`，THE Deploy_Script SHALL 在持有該環境部署鎖期間依序：將 stdin 的密碼讀入只有 root 可讀寫的暫存檔；Database 服務未執行時啟動並在 5 分鐘內等到其健康檢查通過、LM_Proxy 服務未執行時啟動；依 Requirement 14.1 與 14.2 建立並驗證 Database 備份（Database 尚無資料表時亦同）；以 `<digest>` 的 App_Image 執行 Migration_Runner（Requirement 12.2、14.3）；最後以同一 App_Image 經 Compose 的 ops profile 執行 Smoke_Provisioner；任一步驟失敗即不執行後續步驟。
22. THE Deploy_Script SHALL 只經 Smoke_Provisioner 容器的 stdin 傳遞 Smoke_Account 密碼，使密碼不出現在任何程序的指令列參數、環境變數、Deploy_Script 的 stdout 與 stderr、狀態檔或日誌，並在任何結束路徑刪除密碼暫存檔；THE Deploy_Script SHALL 不改變任何 App_Server 容器或 LM_Proxy 的上游設定。
23. IF Database 未在 5 分鐘內通過健康檢查、LM_Proxy 無法啟動、備份失敗、Migration_Runner 失敗，或 Smoke_Provisioner 以非零結束碼結束，THEN THE Deploy_Script SHALL 以結束碼 1 結束，並輸出失敗步驟與原因（Smoke_Provisioner 輸出的單行 JSON 只在只含安全字元時原樣附上），且不輸出密碼。
24. WHEN `smoke-account` 成功完成，THE Deploy_Script SHALL 在 stdout 以每個步驟一行 JSON 輸出 Database 與 LM_Proxy 的啟動結果、備份資訊（Requirement 14.8 的欄位）、Migration_Runner 結果與 Smoke_Provisioner 的輸出，並以結束碼 0 結束。
25. THE `deploy/README.md` SHALL 包含「首次部署與 smoke-bot」一節，以編號步驟依序說明：(a) 前置條件：`install.sh` 已完成、`app.env` 與 `db.env` 已建立且與 Credential_Store 的 `lm-<env>-db` 一致、使用的 Image_Digest 由包含 Smoke_Provisioner 的 commit 建置；(b) Staging_Environment：第一次 `main` 建置的 Staging 部署預期失敗（全新主機在備份步驟以 `backup_create_failed` 失敗且不寫入 `app.env`；Database 已在執行且 `app.env` 已存在時在 Smoke_Test 失敗），兩種情況結束後部署狀態皆為 `idle`；自該建置封存的 `reports/image-digest.txt` 或 Console Output 中「App_Image 已推送：」那一行取得 Image_Digest；若 `/srv/lm/staging/app.env` 不存在，Host_Operator 以 Credential_Store 的值經 stdin 執行 `lm-deploy staging app-env` 寫入；Host_Operator 以 `sudo cat <controller-dir>/secrets/little-moments/release/lm-staging-smoke | sudo /opt/lm/bin/lm-deploy staging smoke-account <digest>` 執行（第一次執行啟動 Database 與 LM_Proxy、套用遷移後因沒有管理員而以結束碼 1 結束）；以 `create-admin` 建立 Staging_Environment 的第一個管理員；再次執行同一個 `smoke-account` 指令；以新的 commit 觸發一次新的 `main` 建置（合併 Pull Request 至 `main`，沒有待合併的變更時可為只含一個空 commit 的 Pull Request），且不對同一個 commit 在 `release/little-moments » main` 執行「Build Now」（Pipeline 拒絕覆寫既有的 `<LM_IMAGE_REPO>:<完整 Commit SHA>` 標籤，該建置在推送 App_Image 時失敗、不會部署至 Staging_Environment）；新建置的 Staging 部署應通過並取得 staging-verified 紀錄，且該建置的 Image_Digest 即為 Production_Environment 使用的已通過 Staging 驗證的 Image_Digest；(c) Production_Environment：在推送第一個 Release_Tag 前，以 `prod`、`lm-prod-smoke` 與已通過 Staging 驗證的 Image_Digest 依相同順序執行 `smoke-account`、`create-admin` 與再次 `smoke-account`，之後推送 Release_Tag 並核准；(d) Setup_Token 只在 Database 沒有任何帳號時用於 `/setup`，依本流程建立管理員後不再使用；(e) Smoke_Account 在 Production_Environment 是真實的 member 帳號，密碼只保存在 Credential_Store，變更時以 `reset-password` 設定新密碼並同步更新 Credential_Store；Smoke_Fixture 只有 Smoke_Account 與管理員可見。
26. THE README 的帳號維運指令章節 SHALL 說明 `create-smoke-account` 的用途、選項與預設值、三種密碼來源、冪等行為（既有帳號與行程保留不變）、沒有管理員或帳號為管理員或已停用時拒絕執行、結束碼，以及在 Deploy_Host 上只由 Host_Operator 經 `lm-deploy <env> smoke-account` 執行，並連結第 25 條的章節；README 與 `deploy/README.md` SHALL 不含實際密碼或 Setup_Token（Requirement 24.9）。
27. THE `tests/*.test.js` SHALL 在 Ephemeral_Database 上涵蓋第 2 至 16 條（新建、以相同參數再次執行無寫入、既有 member 帳號保留、管理員或已刪除帳號拒絕、沒有管理員時拒絕、三種密碼來源與拒絕 `--password`、交易失敗回復、Smoke_Fixture 可被 `runSmoke` 找到），並以靜態測試確認 `scripts/build-server.mjs` 打包 `/app/tools/create-smoke-account.js` 且映像內容檢查規則仍通過；THE `deploy/tests/*.bats` SHALL 以 fake docker 涵蓋第 17 至 24 條（digest 與參數驗證、`SSH_ORIGINAL_COMMAND` 已設定或非 root 時拒絕、SSH forced command 無法執行 `smoke-account`、鎖與狀態、密碼不出現在 fake docker 的參數紀錄而只經 Smoke_Provisioner 的 stdin 傳遞、Database 未執行時先啟動、備份與 Migration_Runner 皆在 Smoke_Provisioner 之前執行）。
