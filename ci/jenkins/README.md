# Jenkins 設定即程式碼（`ci/jenkins/`）

本目錄定義「日子拾光 · LITTLE MOMENTS」的 Jenkins controller 設定、Job 拓撲、憑證範圍與授權（Requirement 1.1、1.9、2.1–2.8、15.1、15.7、15.8、19.3、21.3–21.5、21.12）。controller 與兩個 agent 的容器與安裝步驟見 [`deploy/jenkins/README.md`](../../deploy/jenkins/README.md)，LAN Registry 見 [`deploy/registry/README.md`](../../deploy/registry/README.md)。

| 檔案 | 內容 |
|---|---|
| `casc.yaml` | Configuration as Code：Matrix Authorization、agent 標籤與 Job Restrictions、SYSTEM 範圍的 GitHub webhook secret、Lockable Resources `lm-staging`／`lm-prod`、載入 `jobs.groovy` |
| `local-security.yaml` | 本機使用者資料庫：管理員 `jacklin` 與兩個 API token 帳號（`lm-retention-bot`、`lm-api-readonly`），不開放註冊 |
| `jobs.groovy` | Job DSL：`ci/`、`release/`、`infra/` 資料夾、資料夾範圍憑證、各 Job 的授權與保留 |
| `pipelines/*.Jenkinsfile` | `release/rollback`、`release/restore-drill`、`release/digest-lookup`、`infra/build-image` 的 Pipeline |

`casc.yaml`、`local-security.yaml` 與 `jobs.groovy` 已在實際部署的 Jenkins LTS（jdk21）controller 上載入驗證。repository 內另有 `tests/ci-jenkins-config.test.js` 的靜態檢查（YAML 結構、憑證 ID 對應、權限、保留天數、cron、信任策略、無秘密字面值）。升級 plugin 後請對照「Manage Jenkins → Configuration as Code → Reference」與 Job DSL API Viewer（`/plugin/job-dsl/api-viewer/index.html`）。

## Job 拓撲

| Job | 類型 | 來源 | 憑證 | 保留 |
|---|---|---|---|---|
| `ci/little-moments` | Multibranch | PR（merge 與 head）與未關聯 PR 的非 `main` 分支；fork PR 信任策略「From users with Admin or Write permission」 | `ci/`：`lm-github-app`、`lm-registry-pull` | 14 天；orphaned item 14 天 |
| `release/little-moments` | Multibranch | 只有 `main` 與 `v<major>.<minor>.<patch>` Tag（Tag build strategy，7 天內建立的 Tag） | `release/`（見下表） | `main` 90 天、Tag 365 天 |
| `release/rollback` | Pipeline（`main` 的固定腳本） | `ci/jenkins/pipelines/rollback.Jenkinsfile` | `release/` | 365 天 |
| `release/restore-drill` | Pipeline，cron `H 3 1,15 * *` | `ci/jenkins/pipelines/restore-drill.Jenkinsfile` | `release/` | 365 天 |
| `release/digest-lookup` | Pipeline（參數 `DIGEST`） | `ci/jenkins/pipelines/digest-lookup.Jenkinsfile` | `release/` | 30 天 |
| `infra/build-image` | Pipeline | `ci/jenkins/pipelines/build-image.Jenkinsfile` | `infra/`：`lm-github-app`、`lm-registry-push` | 90 天 |

`ci/` 與 `release/` 的 Multibranch 共用根目錄的 `Jenkinsfile`（Req 1.1）。`release/little-moments` 不探索任何 PR；分支只自動建置 `main`，名稱看起來像 Tag 的分支雖會被索引但不會自動建置（且非管理員沒有該 Job 的 Job/Build）。`ci/little-moments` 會索引 `main` 但不自動建置它；即使手動建置，`ci/` 也沒有任何部署憑證。

## 必要 plugins

`deploy/jenkins/controller/plugins.txt` 與下表相同（`tests/deploy-jenkins.test.js` 檢查兩者一致）。

| Plugin（short name） | 用途 |
|---|---|
| `configuration-as-code` | 載入 `casc.yaml` |
| `job-dsl` | 載入 `jobs.groovy` |
| `cloudbees-folder` | 資料夾與資料夾範圍憑證 |
| `credentials`、`plain-credentials`、`ssh-credentials`、`credentials-binding` | 憑證類型與 `withCredentials`（`usernamePassword`、`string`、`file`、`sshUserPrivateKey`、`gitUsernamePassword`） |
| `github-branch-source` | Multibranch GitHub 來源、GitHub App 憑證、PR 信任策略 |
| `github` | `/github-webhook/` 與 webhook secret（HMAC-SHA256） |
| `basic-branch-build-strategies` | Tag build strategy、分支／PR 建置策略 |
| `skip-notifications-trait` | 停用 branch source 預設的 commit status（由 `githubNotify` 送出） |
| `pipeline-githubnotify-step` | `githubNotify`（`ci/notify.groovy`） |
| `workflow-aggregator`（Pipeline）、`pipeline-input-step`、`pipeline-model-definition` | Declarative Pipeline、核准 `input` |
| `git` | `checkout scm`、`cpsScm` |
| `matrix-auth` | Project-based Matrix Authorization |
| `lockable-resources` | `lock('lm-staging')`、`lock(resource: 'lm-prod', skipIfLocked: true)` |
| `job-restrictions` | 限制 `ci/` 只能用 `lm-untrusted`、`release/`／`infra/` 只能用 `lm-trusted` |
| `docker-workflow` | Docker Pipeline（Design 工具表） |
| `junit` | JUnit 報告 |
| `timestamper` | `timestamps()` |
| `ws-cleanup` | `cleanWs()` |
| `mask-passwords` | 主控台遮罩（Design 工具表） |
| `antisamy-markup-formatter` | 建置摘要的安全 HTML（`<br>`） |

## 設定載入與更新

controller 的 `CASC_JENKINS_CONFIG` 指向容器內的 `/var/jenkins_home/casc`，即主機上 `deploy/jenkins/controller/casc/`（唯讀掛載，不提交）。Configuration as Code 載入該目錄下的 `casc.yaml` 與 `local-security.yaml`；`casc.yaml` 的 `jobs:` 再以 `LM_CASC_DIR` 載入同目錄的 `jobs.groovy`。以下 `<controller-dir>` 是主機上 repository checkout 內的 `deploy/jenkins/controller`。

1. 更新 repository checkout 後，把三個檔案複製到 casc 目錄：

   ```sh
   cd <controller-dir>
   install -m 644 ../../../ci/jenkins/casc.yaml ../../../ci/jenkins/local-security.yaml ../../../ci/jenkins/jobs.groovy casc/
   ```

2. 設定或秘密有變更時，先依下方「以假秘密測試設定變更」測試。
3. 「Manage Jenkins → Configuration as Code → Reload existing configuration」。
4. 確認頁面沒有錯誤，且 controller 日誌沒有 `SEVERE`（只列出符合的行，不印出任何值）：

   ```sh
   docker compose logs --since 5m jenkins 2>&1 | grep -E 'Processing provided DSL|SEVERE'
   ```

Job DSL 的輸出會出現 `buildRetention is deprecated` 警告。這是預期的：`jobs.groovy` 以 branch-api 的 `buildRetention`（BuildRetentionBranchProperty）設定 Multibranch 各分支的保留天數，這個屬性已標示 deprecated，但 branch-api 仍會套用保留天數（PR 14 天、`main` 90 天、Tag 365 天）。branch-api 提供替代屬性之前不要移除它。

## 秘密來源與憑證 ID

本目錄任何檔案都不含秘密值。

### 秘密目錄

controller 的 `SECRETS` 是容器內的 `/run/secrets`，即主機上 `<controller-dir>/secrets/`（唯讀掛載，不提交）。擁有者為 `1000:1000`（容器內的 jenkins 使用者），目錄 `700`、檔案 `600`：

```text
secrets/
  JENKINS_ADMIN_PASSWORD      jacklin 的密碼（local-security.yaml）
  RETENTION_BOT_PASSWORD      lm-retention-bot 的密碼（local-security.yaml）
  API_READONLY_PASSWORD       lm-api-readonly 的密碼（local-security.yaml）
  GITHUB_WEBHOOK_SECRET       GitHub repository webhook 的 secret（casc.yaml）
  little-moments/
    ci/        下表 ci/ 各憑證的秘密檔
    release/   下表 release/ 各憑證的秘密檔
    infra/     下表 infra/ 各憑證的秘密檔
```

- 建立目錄：`sudo install -d -o 1000 -g 1000 -m 700 secrets secrets/little-moments secrets/little-moments/ci secrets/little-moments/release secrets/little-moments/infra`。
- 單行秘密以隱藏輸入寫入，不出現在終端機、shell 歷史或程序列表：

  ```sh
  put() { read -rsp "$1: " S; echo; printf '%s\n' "$S" | sudo install -o 1000 -g 1000 -m 600 /dev/stdin "secrets/$1"; unset S; }
  put JENKINS_ADMIN_PASSWORD
  put little-moments/ci/lm-registry-pull.password
  ```

- 多行秘密（私鑰、`known_hosts`、cosign 檔案）以 `sudo install -o 1000 -g 1000 -m 600 <檔案> secrets/little-moments/<資料夾>/<檔名>` 放入，之後刪除暫存複本。
- GitHub App 的私鑰：GitHub 下載的是 PKCS#1 的 `.pem`，`gitHubApp` 憑證需要 PKCS#8。在 controller 主機上轉換，`<id>` 為憑證 ID（`lm-github-app`）：

  ```sh
  ( umask 077; openssl pkcs8 -topk8 -nocrypt -in <downloaded.pem> -out <id>.key )
  ```

  再以上一項的方式安裝到 `ci/`、`release/`、`infra/` 三個資料夾，最後以 `shred -u <downloaded.pem> <id>.key` 刪除。`.pem` 與 `.key` 絕不放進 repository 目錄或提交（需要時可在 GitHub App 頁面產生新的私鑰）。
- `gitHubApp` 類型只需要 `<id>.app-id`（App ID）與 `<id>.key` 兩個檔案。github-branch-source 由存取的 repository 推定 owner，不需要另外提供 owner 的秘密檔。

`casc.yaml` 與 `local-security.yaml` 以 `${NAME}` 引用 Configuration as Code 的秘密來源（`SECRETS` 目錄下的同名檔案）。任何一個缺少時載入失敗：

| CasC 變數 | 使用者 | 範圍 | 類型 |
|---|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | 憑證 `lm-github-webhook-secret` | SYSTEM（只供 Jenkins 本身驗證 webhook，Job 無法取得） | Secret text |
| `JENKINS_ADMIN_PASSWORD` | 本機使用者 `jacklin` | 本機使用者資料庫 | 密碼 |
| `RETENTION_BOT_PASSWORD` | 本機使用者 `lm-retention-bot` | 本機使用者資料庫 | 密碼（只用於產生 API token） |
| `API_READONLY_PASSWORD` | 本機使用者 `lm-api-readonly` | 本機使用者資料庫 | 密碼（只用於產生 API token） |

資料夾範圍憑證由 `jobs.groovy` 於 seed 時自 `${SECRETS:-/run/secrets}/little-moments/<資料夾>/` 讀取。任何檔案缺少或為空時，Job DSL 以「資料夾/檔名」清單失敗，不以預設值或空值建立憑證（Req 15.3）。建立憑證失敗時，錯誤只含「資料夾/憑證 ID（類型）」與例外類別名稱，不含參數值。更換秘密：更新檔案後執行「Reload existing configuration」。

| 資料夾 | 憑證 ID | 類型 | 秘密檔 | 使用者 |
|---|---|---|---|---|
| `ci/` | `lm-github-app` | GitHub App | `.app-id`、`.key`（PKCS#8） | checkout、commit status |
| `ci/` | `lm-registry-pull` | Username with password | `.username`、`.password` | Build_Image 與掃描器拉取（`lm-pull-ci`，Registry 只允許 GET/HEAD） |
| `release/` | `lm-github-app` | GitHub App | 同上 | checkout、Tag Verify 的 `git fetch`、commit status |
| `release/` | `lm-registry-pull` | Username with password | `.username`、`.password` | `lm-pull-release`：拉取、簽章與 attestation 驗證 |
| `release/` | `lm-registry-push` | Username with password | `.username`、`.password` | `lm-push`：推送、cosign 簽章、attestation、版本標籤 |
| `release/` | `lm-cosign-key` | Secret file（`cosign.key`） | `lm-cosign-key` | 簽章私鑰 |
| `release/` | `lm-cosign-passphrase` | Secret text | `lm-cosign-passphrase` | 私鑰密碼 |
| `release/` | `lm-cosign-pub` | Secret file（`cosign.pub`） | `lm-cosign-pub` | 部署前驗證簽章（Req 17.7） |
| `release/` | `lm-deploy-known-hosts` | Secret file（`known_hosts`） | `lm-deploy-known-hosts` | Deploy_Host 主機金鑰 |
| `release/` | `lm-ssh-staging` | SSH Username with private key | `.username`（`lm-deploy-staging`）、`.key` | Staging forced command `lm-deploy staging` |
| `release/` | `lm-staging-db` | Username with password | `.username`、`.password` | Staging Database |
| `release/` | `lm-staging-setup-token` | Secret text | `lm-staging-setup-token` | Staging Setup_Token |
| `release/` | `lm-staging-smoke` | Secret file | `lm-staging-smoke` | Staging smoke-bot 密碼；帳號由 `lm-deploy staging smoke-account` 建立，見 [`deploy/README.md`](../../deploy/README.md#首次部署與-smoke-bot) |
| `release/` | `lm-ssh-prod` | SSH Username with private key | `.username`（`lm-deploy-prod`）、`.key` | Production 部署、回滾、還原演練 |
| `release/` | `lm-prod-db` | Username with password | `.username`、`.password` | Production Database |
| `release/` | `lm-prod-setup-token` | Secret text | `lm-prod-setup-token` | Production Setup_Token |
| `release/` | `lm-prod-smoke` | Secret file | `lm-prod-smoke` | Production smoke-bot 密碼；帳號由 `lm-deploy prod smoke-account` 建立，見 [`deploy/README.md`](../../deploy/README.md#首次部署與-smoke-bot) |
| `release/` | `lm-prod-openai-api-key` | Secret file（`openai-api-key`） | `lm-prod-openai-api-key` | Production 收據 AI 的 OpenAI 金鑰，只在 Production Deploy 綁定 |
| `release/` | `lm-jenkins-api-readonly` | Username with password | `.username`（`lm-api-readonly`）、`.password`（API token） | fingerprint 查詢 main 的 Build_Record、`release/digest-lookup` |
| `release/` | `lm-jenkins-api-retention` | Username with password | `.username`（`lm-retention-bot`）、`.password`（API token） | `ci/keep-log.mjs` 設定 keepLog（Req 21.6） |
| `infra/` | `lm-github-app` | GitHub App | 同上 | checkout |
| `infra/` | `lm-registry-push` | Username with password | `.username`、`.password` | 推送 Build_Image（與 `release/` 同一個 `lm-push` 帳號與密碼） |

`lm-prod-openai-api-key` 的秘密檔是 `secrets/little-moments/release/lm-prod-openai-api-key`，內容為一行 OpenAI API 金鑰（`sk-` 開頭，不得含空白或 CR）：

- 放置：在 `<controller-dir>` 以上方的 `put little-moments/release/lm-prod-openai-api-key` 隱藏輸入寫入，不要以 `echo`、`cat` 或編輯器處理金鑰。第一次放入必須在複製新的 `jobs.groovy` 並重新載入之前完成，缺少時 seed 失敗。
- 輪替：在 OpenAI 後台建立新金鑰，以同一個 `put` 覆寫後執行「Reload existing configuration」（不要在 Release_Tag 建置進行中更換）。新金鑰在下一次 Production 部署建立的新槽位生效；finalize 移除舊槽位後，才在 OpenAI 撤銷舊金鑰。
- 第一次啟用的完整順序（含 Deploy_Host 的 `install.sh` 與 `/admin` 政策）、金鑰外洩時的處理與停用方式見 [`deploy/README.md` 的「Production 收據 AI（OpenAI）」](../../deploy/README.md#production-收據-aiopenai)。

規則（Req 2.4、2.5、15.1）：

- 沒有任何 GLOBAL 範圍的系統憑證。PR 建置位於 `ci/`，請求表中任何 `release/` 專屬憑證時 `withCredentials` 直接失敗。
- 收據 AI（`CAMPING_OPENAI_*`，Req 15.6–15.8）：Release_Approver 決定只在 Production 啟用，唯一的 OpenAI 憑證是 `release/` 的 Secret file `lm-prod-openai-api-key`，只在 Production Deploy 的 `lm-deploy prod deploy` 綁定，金鑰經 SSH stdin 交給 `lm-deploy`，由它寫成 Deploy_Host 上的金鑰檔並設定 `CAMPING_OPENAI_API_KEY_FILE`。Staging、Test_Environment、還原演練與 `ci/` 的建置不使用任何 OpenAI 憑證；`ci/` 永遠不得定義。新增或移除此憑證時，同時修改 `jobs.groovy`、Pipeline 與本表。
- `lm-jenkins-api-readonly` 的帳號只有 Overall/Read 與 Job/Read（全域 `authenticated`）。
- `release/` 與 `infra/` 的 `lm-registry-push.password` 必須相同（Registry 只有一個 `lm-push`）：`sudo cmp secrets/little-moments/release/lm-registry-push.password secrets/little-moments/infra/lm-registry-push.password` 沒有輸出即相同。

### 以假秘密測試設定變更

設定錯誤時，Configuration as Code 或 Job DSL 的錯誤訊息可能帶出值。修改 `casc.yaml`、`local-security.yaml`、`jobs.groovy` 或秘密目錄的結構後，先以假秘密在另一個暫時的 controller 載入，確認沒有錯誤後才對正式 controller 執行 Reload，錯誤輸出中就只會出現假值。

1. 依上方「設定載入與更新」步驟 1 把新檔案複製到 `casc/`，測試通過前不要按 Reload，也不要重新啟動正式 controller。
2. 以 root 在 `<controller-dir>` 依正式秘密目錄的檔名建立假秘密目錄（只讀檔名，不讀內容；`.key` 改為新產生、未用於任何系統的私鑰）：

   ```sh
   rm -rf secrets-dummy
   (
     umask 077
     cd secrets
     find . -type d -exec mkdir -p ../secrets-dummy/{} \;
     find . -type f ! -name '*.key' -exec sh -c 'printf "dummy-value\n" > "../secrets-dummy/$1"' sh {} \;
     find . -type f -name '*.key' -exec sh -c 'openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "../secrets-dummy/$1" 2>/dev/null' sh {} \;
   )
   chown -R 1000:1000 secrets-dummy
   ```

3. 以另一個專案名稱啟動暫時的 controller：只綁定 `127.0.0.1:18080`、不接上 `proxy` 網路、使用自己的 jenkins_home 卷（Compose 2.24 以上支援 `!override`）：

   ```sh
   docker compose -p lm-jenkins-dummy -f compose.yaml -f - up -d --build <<'EOF'
   services:
     jenkins:
       ports: !override
         - "127.0.0.1:18080:8080"
       networks: !override
         - default
       volumes: !override
         - jenkins_home:/var/jenkins_home
         - ./casc:/var/jenkins_home/casc:ro
         - ./secrets-dummy:/run/secrets:ro
   EOF
   docker compose -p lm-jenkins-dummy logs -f jenkins 2>&1 | grep --line-buffered -E 'Processing provided DSL|SEVERE|fully up and running'
   ```

   看到 `Jenkins is fully up and running` 且沒有 `SEVERE` 即通過。
4. 移除暫時的 controller 與它的卷，再刪除假秘密目錄。不要對正式專案執行 `docker compose down -v`，那會刪除正式的 jenkins_home：

   ```sh
   docker compose -p lm-jenkins-dummy down
   docker volume rm lm-jenkins-dummy_jenkins_home
   rm -rf secrets-dummy
   ```

5. 對正式 controller 執行「Reload existing configuration」。

## 授權（Req 21.12）

security realm 是本機使用者資料庫（`local-security.yaml`，`allowsSignup: false`），只有三個帳號：

| 帳號 | 用途 |
|---|---|
| `jacklin` | 唯一的管理員（`casc.yaml` 授與 Overall/Administer），也是唯一的 Release_Approver |
| `lm-retention-bot` | 只以 API token 使用（`lm-jenkins-api-retention`），不用於互動式登入 |
| `lm-api-readonly` | 只以 API token 使用（`lm-jenkins-api-readonly`），不用於互動式登入 |

全域（`casc.yaml`）只有使用者 `jacklin` 擁有 Overall/Administer；`authenticated` 只有 Overall/Read、Job/Read、View/Read。`casc.yaml` 與 `jobs.groovy` 另有 `lm-developers`、`lm-release-approvers`、`lm-auditors` 群組項目，保留供日後改用外部 security realm（LDAP、OIDC 等）時使用。本機使用者資料庫沒有群組，這些項目目前不生效；目前只有 `jacklin`（管理員）能建置 `ci/` 與 `release/` 下的 Job。資料夾與 Job 層級（`jobs.groovy`）只另外授與：

| 範圍 | 主體 | 權限 |
|---|---|---|
| `ci/` | `lm-developers`（群組，目前不生效） | Job/Build、Job/Cancel |
| `release/rollback` | `lm-release-approvers`（群組，目前不生效） | Job/Build、Job/Cancel |
| `release/restore-drill` | `lm-release-approvers`（群組，目前不生效） | Job/Build |
| `release/digest-lookup` | `lm-release-approvers`、`lm-auditors`（群組，目前不生效） | Job/Build |
| `release/little-moments` | `lm-retention-bot`（使用者） | Job/Read、Run/Update |

非管理員沒有 Run/Delete、Run/Update、Job/Configure、Run/Replay（也沒有 Credentials/*、Lockable Resources/*）。唯一的例外是 `lm-retention-bot` 在 `release/little-moments` 的 Run/Update：Jenkins 的「Keep this build forever」需要 Run/Update，`ci/keep-log.mjs` 只用它把正在 Production 執行之 Image_Digest 的建置設為 keepLog=true。這個帳號：

- 只能以 API token 使用（不要給互動登入），token 只存在 `release/` 的 `lm-jenkins-api-retention`；
- 沒有 Run/Delete，因此無法刪除建置，也無法解除 keepLog；
- Run/Update 也允許修改建置的顯示名稱與描述。這是 Req 21.12 的已知、受限例外；Build_Record 本體（封存的 JSON 與報告）不受影響。稽核時可在 Jenkins 稽核日誌確認此帳號只呼叫 `toggleLogKeep`。

兩個 API token 帳號的密碼（`RETENTION_BOT_PASSWORD`、`API_READONLY_PASSWORD`）只用於登入一次以產生 API token（見「仍待填入」）。

### 解除 keepLog（管理員程序）

Jenkins 解除 keepLog 需要 Run/Delete，與 Req 21.12「非管理員不可刪除」衝突，因此 Pipeline 不會自動解除。當一個 Image_Digest 離開 Production 且不再屬於 Deploy_Host 保留的最近 3 個可回滾 Image_Digest（`lm-deploy prod status` 的 `history`）時，Jenkins 管理員：

1. 執行 `release/digest-lookup`（`DIGEST=<離開保留集合的 digest>`），記下對應的 main 建置與 Release_Tag 建置。
2. 確認該 digest 不在 `lm-deploy prod status` 的目前版本與 `history` 中。
3. 對兩個建置在 UI 按「Don't keep this build forever」（或 `POST <build>/toggleLogKeep`，管理員 API token）。
4. 之後由 Build Discarder 依 90／365 天規則處理。在 Build_Record 之外另以變更紀錄保存操作人與時間。

## Release_Approver

- 核准清單的權威來源是 `ci/release-approvers.json`（`jenkinsId` 與 git email 對照）。正式核准與破壞性遷移核准的 `input` 以清單中的 `jenkinsId` 限定 submitter，送出後再以 `ci/approval.mjs` 驗證；不在清單的帳號送出時不生效並記錄帳號與時間（Req 19.3）。清單中的每個 `jenkinsId` 都必須是本機使用者資料庫的帳號。
- 目前只有一位 Release_Approver：`jacklin`。他同時是主要作者，而破壞性遷移的核准人不得是該遷移的作者（Req 12.6、Property 32），所以 `jacklin` 撰寫的破壞性遷移無法被核准，Release_Tag 建置會停在該關卡。需要發布這類遷移之前，先在 `local-security.yaml` 新增第二位使用者，並把他加入 `ci/release-approvers.json`（以 PR 審查）。
- `lm-release-approvers` 群組只決定 `release/rollback`、`release/restore-drill`、`release/digest-lookup` 的 Job/Build，在本機使用者資料庫下不生效；`jacklin` 以管理員身分執行這些 Job。日後改用外部 security realm 時，群組成員必須與 `ci/release-approvers.json` 一致；任一邊變更時兩邊一起更新（json 以 PR 審查，群組由 security realm 管理）。
- Jenkins 管理員可以送出任何 `input`；Pipeline 仍以 `ci/approval.mjs` 拒絕不在清單的管理員。
- 等待核准時 `release/little-moments` 的 Tag 建置會佔用一個 Trusted Agent executor 最長 24 小時。`lm-trusted` 的 executor 數至少為 2（一個留給 `main`／回滾），同時進行多個 Release_Tag 時需再增加。

## 已填入的實際值

以下值來自已驗證的部署，已寫入 repository（都不是秘密）：

- `ci/jenkins/jobs.groovy`：`GITHUB_OWNER` 為 `Raigorlin`、`GITHUB_REPO` 為 `little-moments`。
- `ci/jenkins/casc.yaml`：`location.url` 為 `https://jenkins.our-littlemoments.com/`、`hookUrl` 為 `https://jenkins.our-littlemoments.com/github-webhook/`；agent `lm-trusted-1`（`remoteFS` `/var/lib/jenkins-agent`）與 `lm-untrusted-1`（`remoteFS` `/var/lib/jenkins-untrusted`），各 2 個 executor，皆以 WebSocket 連線；管理員為使用者 `jacklin`。
- `ci/jenkins/local-security.yaml`：`jacklin`、`lm-retention-bot`、`lm-api-readonly`（密碼只引用 `${VAR}`）。
- `ci/release-approvers.json`：唯一的 Release_Approver `jacklin` 與其 git email。
- LAN Registry 一律為 `registry.our-littlemoments.com:8443`：`Jenkinsfile`、`ci/jenkins/pipelines/*.Jenkinsfile` 與 `deploy/compose/*.env.example` 的 `LM_IMAGE_REPO`。
- 映像 digest：`Jenkinsfile` 與 `build-image.Jenkinsfile` 的鏡像工具映像（gitleaks、osv-scanner、Trivy、Semgrep、Syft、crane、cosign、ZAP）、`LM_POSTGRES_IMAGE`、`deploy/compose/` 的 db 與 proxy、`deploy/registry/compose.yaml` 的 Caddy 與 registry、`Dockerfile` 與 `ci/build-image/Dockerfile` 的 `FROM`、`BUN_SHA256`、`NODE_SHA256`（Bun 1.4.4，見 `ci/toolchain.json`）。
- `BUILD_IMAGE`（`Jenkinsfile`、`rollback.Jenkinsfile`、`restore-drill.Jenkinsfile`、`digest-lookup.Jenkinsfile`）：四個檔案使用同一個 `registry.our-littlemoments.com:8443/little-moments/build-image@sha256:` digest，為 `infra/build-image` 建置 commit `a302149` 的輸出。`ci/build-image/Dockerfile` 或 `ci/toolchain.json` 變更後，重新執行 `infra/build-image`，以建置描述與 `reports/build-image-digest.txt` 的新 digest 在同一個 commit 內取代這四個檔案的 `BUILD_IMAGE`，並同步更新斷言此值的測試（`tests/ci-lint.test.js` 的 `BUILD_IMAGE_REF`、`ci-rollback-pipeline`、`ci-restore-drill`、`ci-digest-lookup`）。
- `deploy/registry/htpasswd.example` 刻意只含佔位符；實際的 `secrets/htpasswd` 只存在 Registry 主機上（見 [`deploy/registry/README.md`](../../deploy/registry/README.md)）。
- 同主機部署值（Deploy_Host、Jenkins controller、兩個 agent 與 LAN Registry 都在 `192.168.1.121`；design.md 第 18.6 節）：
  - `Jenkinsfile`、`ci/jenkins/pipelines/rollback.Jenkinsfile`、`restore-drill.Jenkinsfile`：`LM_DEPLOY_HOST` 為 `192.168.1.121`、`LM_DEPLOY_PORT` 為 `22`。
  - `Jenkinsfile`：`LM_STAGING_URL` 為 `http://192.168.1.121:8081`、`LM_PROD_URL` 為 `http://192.168.1.121:8082`。Smoke_Test 由 Trusted Agent 經這兩個 LAN origin 執行，不經 Edge_Proxy；`192.168.1.121` 必須在兩個環境 `<env>.env` 的 `ALLOWED_HOSTS` 內。
  - `Jenkinsfile`：`LM_STAGING_DB_NAME` 為 `little_moments_staging`、`LM_PROD_DB_NAME` 為 `little_moments`（須與 Deploy_Host 上同環境 `db.env` 的 `POSTGRES_DB` 相同）。
  - `Jenkinsfile`：`LM_DAST_PROBE_TARGETS` 為主機上所有已發布的連接埠：`22`（sshd）、`80`／`443`（NPM）、`81`（NPM 管理介面）、`8080`（Jenkins controller）、`8081`／`8082`（Staging／Production LM_Proxy）、`8090`（維運者的暫時預覽 App）、`8443`（LAN Registry），全部以 `192.168.1.121:<port>` 表示。主機新增或移除發布連接埠時（`sudo ss -ltnp`）同步更新此清單與 `tests/ci-jenkinsfile.test.js`。
- Production 經同主機 Edge_Proxy 對外公開的設定步驟見 [`deploy/README.md`](../../deploy/README.md)。

### Gitleaks 歷史起點（Secret_History_Baseline）

`Jenkinsfile` 的 `LM_GITLEAKS_HISTORY_BASE` 是非 PR 建置（`main`、Release_Tag）Gitleaks Git 歷史掃描的固定起點，目前為 commit `c084474`（完整的 40 字元 SHA 見 `Jenkinsfile`；2026-11-13 審查，design.md Components 第 27.3 節）。這個 commit 與它所有祖先已以 Gitleaks 8.30.1 的預設規則掃描，結果只有已確認的測試假值，沒有真實秘密。

- 掃描範圍：上次成功建置的 commit（`GIT_PREVIOUS_SUCCESSFUL_COMMIT`）有效、是建置 commit 的祖先且不比起點舊時為 `<上次成功建置>..<sha>`，否則為 `<起點>..<sha>`。不再掃描完整歷史。PR 仍使用 `<merge base>..<sha>`，不受起點影響。
- 起點無效、不存在或不是建置 commit 的祖先時（例如 Release_Tag 指向 `c084474` 之前的 commit），歷史掃描未完成，「安全」關卡不通過（fail closed）。以包含起點的 commit 重新建置。
- 建置 commit 的所有受版本控制檔案仍每次以 `gitleaks dir` 完整掃描；起點只限制 Git 歷史的範圍。
- 它是 `environment` 的常數，不是建置參數，Build Now 時不能覆寫（Req 23.4）。
- 移動起點：先以 Gitleaks 掃描新起點的完整歷史，確認每筆結果都不是真實秘密並記錄於 design.md，之後才以經審查的 commit 修改 `LM_GITLEAKS_HISTORY_BASE` 與 `tests/ci-jenkinsfile.test.js` 的對應斷言。

## 仍待填入

以下項目與 Deploy_Host 或首次建置有關，尚未填入或需要維運者在主機上確認。未填入時對應的 Pipeline 階段會 fail closed。

- `lm-deploy-known-hosts`：必須含 `192.168.1.121` 的主機金鑰（見下表）。
- Edge_Proxy 的實際來源位址與 Cloudflare 範圍只寫在 Deploy_Host 的 `/srv/lm/prod/prod.env`（`LM_EDGE_TRUSTED_PROXIES`），不寫入 repository；確認方式見 [`deploy/README.md`](../../deploy/README.md)。
- `install.sh --lan-cidr` 使用的 Docker 網段是主機目前由 Docker 分配的值；重新建立 NPM、Jenkins agent 或 Docker 預設 `bridge` 網路後，以 `docker network inspect` 重新確認（見 [`deploy/README.md`](../../deploy/README.md)）。
- Registry 的 Deploy_Host 拉取帳號（例如 `lm-pull-staging`、`lm-pull-prod`）：Deploy_Host 安裝時再加入 `secrets/htpasswd`。
- 以下秘密檔目前的內容是字面值 `placeholder`（非空，所以 Job DSL 會建立憑證，但用到它的步驟會失敗）。填入後執行「Reload existing configuration」：

| 秘密檔（`secrets/little-moments/` 之下） | 填入方式 |
|---|---|
| `release/lm-deploy-known-hosts` | Deploy_Host 安裝後，在 controller 主機執行 `ssh-keyscan -p 22 192.168.1.121`，並與 Deploy_Host 主控台上 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 顯示的指紋比對後寫入（連接埠非 22 時為 `[host]:port` 形式） |
| `release/lm-cosign-key`、`release/lm-cosign-pub` | 以 cosign 2.x 的 `generate-key-pair` 產生，密碼使用 `release/lm-cosign-passphrase` 的值（見下方指令）；離線另存一份 `cosign.key` |
| `release/lm-jenkins-api-readonly.password` | 以 `lm-api-readonly` 登入一次（密碼為 `API_READONLY_PASSWORD`），在「使用者 → Security → API Token」產生 token、以 `put` 寫入後登出 |
| `release/lm-jenkins-api-retention.password` | 同上，帳號 `lm-retention-bot`（密碼為 `RETENTION_BOT_PASSWORD`） |

cosign 金鑰（以 root 在 `<controller-dir>` 執行；密碼只經環境變數名稱傳入容器，不出現在命令列）：

```sh
d=$(mktemp -d)
export COSIGN_PASSWORD="$(cat secrets/little-moments/release/lm-cosign-passphrase)"
docker run --rm -e COSIGN_PASSWORD -v "$d:/out" -w /out ghcr.io/sigstore/cosign/cosign:v2.6.5 generate-key-pair
unset COSIGN_PASSWORD
install -o 1000 -g 1000 -m 600 "$d/cosign.key" secrets/little-moments/release/lm-cosign-key
install -o 1000 -g 1000 -m 600 "$d/cosign.pub" secrets/little-moments/release/lm-cosign-pub
rm -rf "$d"
```

## Script Security（In-process Script Approval）

Pipeline 在 Groovy sandbox 中執行。首次執行時以下呼叫可能出現在「Manage Jenkins → In-process Script Approval」，請逐項比對簽章後由管理員核准（不要使用「Approve all」或關閉 sandbox）：

- `new groovy.json.JsonSlurperClassic` 與 `parseText`（Build_Record、報告 JSON）
- `RunWrapper.getBuildCauses(String)`（判斷手動觸發與 Replay）
- `FlowInterruptedException.getCauses()`、`Rejection.getUser()`（核准被拒絕時的帳號）
- `staticMethod java.lang.System currentTimeMillis`（逾時與觀察期計時）
- `@NonCPS` 輔助函式內的集合與字串操作（依實際提示核准）

### 例外類別的判讀

吸收例外並改為固定結果的 `catch` 會在主控台輸出一行 `<函式名稱>[/<標籤>]: <例外類別>`，例如 `readPlan: java.io.NotSerializableException`、`notifyChannels/send: …（githubStatus）`。只輸出完整類別名稱，不輸出例外訊息、cause 或堆疊（訊息可能含權杖、回應內容或指令輸出，Req 15.4、22.8）。這行出現在原本的固定訊息（例如 `觸發被拒絕：階段規劃輸出無效`）之前，判讀如下：

| echo 的類別 | 可能原因 | 處理 |
|---|---|---|
| `java.io.NotSerializableException` | step 執行期間 CPS 函式持有不可序列化的物件 | 依 design.md Components 第 23.1、23.2 節修正該函式：不可序列化的物件只在 `@NonCPS` 函式內使用，step 的結果先存入 `String` 變數 |
| `org.jenkinsci.plugins.scriptsecurity.sandbox.RejectedAccessException` | sandbox 拒絕某個簽章（它是 `SecurityException`，會被 `catch (Exception …)` 吸收） | 到「Manage Jenkins → In-process Script Approval」查看待核准的簽章，比對後核准 |
| `groovy.json.JsonException`、`java.lang.IllegalArgumentException` | 檔案內容不是 JSON 或為空 | 檢查封存的報告檔 |
| `org.jenkinsci.plugins.workflow.steps.FlowInterruptedException` | 逾時或使用者中止 | 依該階段的時間上限判斷 |
| 其他 `java.io.IOException` 的子類別 | `readFile` 讀不到檔案或 Agent 連線中斷 | 檢查產生該檔案的前一個步驟 |

輸出類別名稱用到的 `method java.lang.Object getClass` 與 `method java.lang.Class getName` 都在 script-security 的 generic-whitelist，不需要核准。若較舊的 script-security 版本仍把它們列為待核准項目，兩者都不在 blacklist，比對簽章後核准即可。

`jobs.groovy` 由 Configuration as Code 以系統身分執行。若啟用「Enable script security for Job DSL scripts」，請確認 CasC 載入的 Job DSL 不需要額外核准（`SecretBytes.fromBytes`、`hudson.util.Secret.fromString`、`java.io.File` 讀取）。

## GitHub 端設定

### GitHub App

憑證 `lm-github-app`（三個資料夾共用同一個 App）：

1. 權限（Repository permissions）：Contents、Metadata、Pull requests 為 Read-only，Commit statuses 為 Read and write；其他全部 No access。
2. App 本身的 Webhook 關閉（取消勾選 Active）。建置由下方的 repository webhook 觸發。
3. 只安裝在 `Raigorlin/little-moments`（Only select repositories）。
4. 記下 App ID 寫入 `<id>.app-id`，產生私鑰後依「秘密目錄」轉換為 PKCS#8 的 `<id>.key`。

Multibranch 掃描或 checkout 出現 `Couldn't authenticate with GitHub app ID …` 時，表示 App 尚未安裝在 repository 上（或安裝時沒有選取 little-moments），不是私鑰格式問題。

### Repository 設定

1. Repository webhook：Payload URL `https://jenkins.our-littlemoments.com/github-webhook/`、Content type `application/json`、Secret 與 `GITHUB_WEBHOOK_SECRET` 相同、事件只勾選 Pushes 與 Pull requests（Req 2.3；其他事件不會觸發建置）。
2. Ruleset：禁止非管理員建立名稱符合 `v*` 的分支；`v*` Tag 只允許 Release_Approver 建立且不可移動或刪除（Release_Tag 的最終驗證在 `ci/policy/tag.mjs`）。
3. Release_Tag 使用 annotated tag（`git tag -a vX.Y.Z`）：Tag build strategy 以 Tag 時間判斷「7 天內」，lightweight tag 以 commit 時間計算，指向較舊 commit 時不會自動建置（需管理員手動觸發該 Tag）。
4. Branch protection：`main` 需要 PR 與審查；`ci/little-moments` 的 commit status context 為 `little-moments/ci`。

## 驗證步驟（需在實際環境執行）

以下項目無法在本機驗證，請在 controller 套用設定後執行並保存結果。

### 設定載入

1. 「Manage Jenkins → Configuration as Code」顯示無錯誤；`ci/`、`release/`、`infra/` 與 6 個 Job 皆已建立（Job DSL 的 `buildRetention is deprecated` 警告是預期的）。
2. `ci/` 資料夾的 Credentials 只顯示 `lm-github-app` 與 `lm-registry-pull`；`release/` 顯示上表 18 個；`infra/` 顯示 2 個；「System」只有 `lm-github-webhook-secret`（SYSTEM 範圍）。
3. 非管理員沒有建置權限：以 `lm-api-readonly` 的 API token（放在 0600 的 curl 設定檔，內容 `user = "lm-api-readonly:<api-token>"`）執行 `curl -s -o /dev/null -w '%{http_code}\n' -K <curl-config> -X POST https://jenkins.our-littlemoments.com/job/release/job/rollback/build` → 403。日後改用外部 security realm 時，再以 `lm-developers` 成員登入確認：`ci/little-moments` 的建置頁沒有 Replay、Delete build、Edit Build Information、Configure；`release/little-moments` 沒有 Build Now。
4. Lockable Resources 頁面顯示 `lm-staging` 與 `lm-prod`。
5. 「Manage Jenkins → Nodes」中 `lm-trusted-1` 與 `lm-untrusted-1` 皆為上線狀態。

### 憑證隔離（Req 2.4、2.5）

在一個測試分支的 PR 中加入 `withCredentials([sshUserPrivateKey(credentialsId: 'lm-ssh-prod', keyFileVariable: 'K')]) { sh 'true' }`。預期：建置失敗並顯示找不到 `lm-ssh-prod`（`CredentialNotFoundException`），主控台不出現任何值。對 fork PR 重複，預期使用 `main` 的 `Jenkinsfile`，PR 中的修改不執行（Req 2.7）。

### Untrusted Agent 網路隔離（Req 2.6）

`lm-untrusted-1` 執行 PR 的程式碼。它在非特權使用者 `lm-untrusted` 的 rootless Docker 上執行，只掛載該 rootless daemon 的 socket，絕不使用主機的 `/var/run/docker.sock`（安裝步驟見 [`deploy/jenkins/README.md`](../../deploy/jenkins/README.md)）。`lm-untrusted` 與其 subuid 範圍（所有容器內的 uid）的對外連線由 `deploy/jenkins/agent/untrusted/lm-untrusted-fw` 以主機 OUTPUT 的 owner 規則限制：只允許 DNS、Jenkins `<lan-ip>:8080` 與 Registry `<lan-ip>:8443`，拒絕本機其他連接埠、私有網段（10/8、172.16/12、192.168/16、100.64/10、169.254/16）與所有 IPv6，其餘（公開網際網路）放行。rootless daemon 關閉 detach-netns 並使用 slirp4netns，`--net=host` 也只會進入 slirp4netns 的網路命名空間。

以 root 在主機上執行（`<lan-ip>` 為 controller 主機的 LAN IP，`<router-ip>` 為路由器的 LAN IP）：

```sh
uid=$(id -u lm-untrusted)
ru() { sudo -u lm-untrusted -H env XDG_RUNTIME_DIR=/run/user/$uid DOCKER_HOST=unix:///run/user/$uid/docker.sock "$@"; }

# 1. 只有 Jenkins :8080 可連線；SSH、NPM（80／81）與路由器都必須 blocked
ru docker run --rm --entrypoint bash lm-untrusted-agent -c '
for t in <lan-ip>:8080 <lan-ip>:22 <lan-ip>:80 <lan-ip>:81 <router-ip>:80; do
  if timeout 5 bash -c "</dev/tcp/${t%:*}/${t##*:}" 2>/dev/null; then echo "OPEN    $t"; else echo "blocked $t"; fi
done'

# 2. 公開網際網路可連線 → 200
ru docker run --rm --entrypoint curl lm-untrusted-agent -s -o /dev/null -w '%{http_code}\n' https://github.com

# 3. --net=host 仍在 slirp4netns 內 → 10.0.2.x（不得出現 <lan-ip>）
ru docker run --rm --net=host --entrypoint hostname lm-untrusted-agent -I
```

預期第 1 項只有 `OPEN    <lan-ip>:8080`，其餘皆為 `blocked`；第 2 項為 `200`；第 3 項只有 `10.0.2.x` 位址。任一項不符時停止 `lm-untrusted-1`，先檢查 `iptables -S LM-UNTRUSTED` 與 rootless Docker 的 override。

另確認：Staging／Production Database 連接埠無法連線（Database 不發布連接埠，Req 11.10）；Registry 只能以 `lm-pull-ci` 讀取（`PUT` 回應 403）；建置結束後 `docker ps -a --filter label=lm.ci.build`（經 rootless daemon）與工作目錄為空（`cleanWs()`）。在 `ci/` 的 PR 中把 `agent { label 'lm-trusted' }` 改寫後建置，預期一直排隊或被 Job Restrictions 拒絕，不會在 `lm-trusted-1` 執行。

### Webhook 驗證與拒絕日誌（Req 2.1、2.2）

Jenkins 前面是主機上的 Nginx Proxy Manager（NPM）。對外只公開 `/github-webhook/`，其餘路徑只允許 LAN。NPM 的 Proxy Host 設定：

- Details：Domain Names `jenkins.our-littlemoments.com`，Scheme `http`、Forward Hostname `jenkins`、Forward Port `8080`（controller 與 NPM 都接在 `proxy` Docker 網路上，以服務名稱連線），開啟 Websockets Support。
- Access List：「LAN only」，Access 規則為 `allow <lan-cidr>`（其餘由 NPM 拒絕），不設帳密。
- SSL：Let's Encrypt 憑證，開啟 Force SSL、HTTP/2 Support、HSTS Enabled。
- Advanced：只有 webhook 路徑例外，且只接受 POST：

  ```nginx
  location = /github-webhook/ {
    allow all;
    limit_except POST { deny all; }
    include conf.d/include/proxy.conf;
  }
  ```

網路曝露：

- 路由器只把 80／443 轉送到 NPM，絕不轉送 81、8080 或 SSH。
- NPM 的管理介面（81）只綁定 LAN IP（例如 `<lan-ip>:81:81`）。
- controller 的 8080 只綁定 LAN IP；兩個 agent 直接連到 `http://<lan-ip>:8080/`，不經 NPM。
- LAN 的 DNS（路由器或本機 DNS）把 `jenkins.our-littlemoments.com` 解析為 `<lan-ip>`。LAN 內的請求因此直接到達 NPM，來源 IP 位於 `<lan-cidr>`，Access List 才會放行；公開 DNS 指向路由器的對外 IP，供 GitHub 與 Let's Encrypt 使用。

日誌：NPM 每個 Proxy Host 有自己的存取日誌（NPM 資料目錄下的 `logs/proxy-host-<n>_access.log`，`<n>` 為 Proxy Host 的編號），每筆記錄時間、方法、路徑、狀態碼與來源 IP（`[Client <ip>]`）。NPM 的預設格式不記錄 request body，標頭只記錄 User-Agent 與 Referer，不含 `X-Hub-Signature-256`、`Authorization` 或 Cookie，因此不需要另外刪除標頭。簽章檢查的結果記錄在 Jenkins：新增 Log Recorder「github-webhook」：`com.cloudbees.jenkins.GitHubWebHook`、`org.jenkinsci.plugins.github.webhook`、`org.jenkinsci.plugins.github_branch_source`（等級 FINE 以上）。驗證：

1. 無簽章：`curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H 'X-GitHub-Event: push' -H 'Content-Type: application/json' --data '{}' https://jenkins.our-littlemoments.com/github-webhook/` → 4xx，沒有建置排入佇列。
2. 錯誤簽章：同上加 `-H 'X-Hub-Signature-256: sha256:0000000000000000000000000000000000000000000000000000000000000000'` → 4xx，沒有建置。
3. 其他 repository：以正確 secret 簽一個 `repository.full_name` 為其他 repo 的 push payload → 沒有任何 Job 被觸發（Log Recorder 顯示無相符 Job）。
4. 非支援事件：以正確 secret 送出 `X-GitHub-Event: issues` → 沒有建置（Req 2.3）。
5. 正確簽章的 push 至測試分支 → 60 秒內 `ci/little-moments` 排入建置（Req 1.9）。
6. 確認 NPM 的 `proxy-host-<n>_access.log` 對 1–4 每筆都有接收時間、來源 IP（`[Client <ip>]`）與狀態碼，Log Recorder 有對應的拒絕原因；兩者皆不含 request body、`X-Hub-Signature-256` 或 webhook secret。在 controller 主機上以 `grep -c -F -f <controller-dir>/secrets/GITHUB_WEBHOOK_SECRET <log>` 對兩份日誌確認為 0（不要把 secret 貼到 shell 歷史）。

另從 LAN 以外的網路（例如手機行動網路）確認：`https://jenkins.our-littlemoments.com/` 與 `GET /github-webhook/` 皆為 403；`http://` 轉址到 `https://`；`<public-ip>:81` 與 `<public-ip>:8080` 無法連線。

NPM 的存取日誌與 Jenkins 的拒絕原因以時間戳對應。
