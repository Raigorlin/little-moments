# Jenkins 設定即程式碼（`ci/jenkins/`）

本目錄定義「日子拾光 · LITTLE MOMENTS」的 Jenkins controller 設定、Job 拓撲、憑證範圍與授權（Requirement 1.1、1.9、2.1–2.8、15.1、15.7、15.8、19.3、21.3–21.5、21.12）。

| 檔案 | 內容 |
|---|---|
| `casc.yaml` | Configuration as Code：Matrix Authorization、agent 標籤與 Job Restrictions、SYSTEM 範圍的 GitHub webhook secret、Lockable Resources `lm-staging`／`lm-prod`、載入 `jobs.groovy` |
| `jobs.groovy` | Job DSL：`ci/`、`release/`、`infra/` 資料夾、資料夾範圍憑證、各 Job 的授權與保留 |
| `pipelines/*.Jenkinsfile` | `release/rollback`、`release/restore-drill`、`release/digest-lookup`、`infra/build-image` 的 Pipeline |

本機沒有 Jenkins：這些檔案只經過 `tests/ci-jenkins-config.test.js` 的靜態檢查（YAML 結構、憑證 ID 對應、權限、保留天數、cron、信任策略、無秘密字面值）。plugin 的 CasC／Job DSL 屬性名稱未經實際 Jenkins 驗證，首次套用前請對照「Configuration as Code → Reference」與 Job DSL API Viewer（`/plugin/job-dsl/api-viewer/index.html`）。

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

## 秘密來源與憑證 ID

本目錄任何檔案都不含秘密值。

`casc.yaml` 以 `${NAME}` 引用 Configuration as Code 的秘密來源（環境變數，或 `SECRETS` 目錄，預設 `/run/secrets`，下的同名檔案）：

| CasC 變數 | 憑證 ID | 範圍 | 類型 |
|---|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | `lm-github-webhook-secret` | SYSTEM（只供 Jenkins 本身驗證 webhook，Job 無法取得） | Secret text |

資料夾範圍憑證由 `jobs.groovy` 於 seed 時自 `${SECRETS:-/run/secrets}/little-moments/<資料夾>/` 讀取。任何檔案缺少或為空時，Job DSL 以「資料夾/檔名」清單失敗，不以預設值或空值建立憑證（Req 15.3）。更換秘密：更新檔案後執行「Reload existing configuration」。

| 資料夾 | 憑證 ID | 類型 | 秘密檔 | 使用者 |
|---|---|---|---|---|
| `ci/` | `lm-github-app` | GitHub App | `.app-id`、`.key`（PKCS#8）、`.owner` | checkout、commit status（建議另一個只有 Contents: read、Commit statuses: write 的 App 安裝） |
| `ci/` | `lm-registry-pull` | Username with password | `.username`、`.password` | Build_Image 與掃描器拉取（`lm-pull-ci`，Registry 只允許 GET/HEAD） |
| `release/` | `lm-github-app` | GitHub App | 同上 | checkout、Tag Verify 的 `git fetch`、commit status |
| `release/` | `lm-registry-pull` | Username with password | `.username`、`.password` | 拉取、簽章與 attestation 驗證 |
| `release/` | `lm-registry-push` | Username with password | `.username`、`.password` | `lm-push`：推送、cosign 簽章、attestation、版本標籤 |
| `release/` | `lm-cosign-key` | Secret file（`cosign.key`） | `lm-cosign-key` | 簽章私鑰 |
| `release/` | `lm-cosign-passphrase` | Secret text | `lm-cosign-passphrase` | 私鑰密碼 |
| `release/` | `lm-cosign-pub` | Secret file（`cosign.pub`） | `lm-cosign-pub` | 部署前驗證簽章（Req 17.7） |
| `release/` | `lm-deploy-known-hosts` | Secret file（`known_hosts`） | `lm-deploy-known-hosts` | Deploy_Host 主機金鑰 |
| `release/` | `lm-ssh-staging` | SSH Username with private key | `.username`（`lm-deploy-staging`）、`.key` | Staging forced command `lm-deploy staging` |
| `release/` | `lm-staging-db` | Username with password | `.username`、`.password` | Staging Database |
| `release/` | `lm-staging-setup-token` | Secret text | `lm-staging-setup-token` | Staging Setup_Token |
| `release/` | `lm-staging-smoke` | Secret file | `lm-staging-smoke` | Staging smoke-bot 密碼 |
| `release/` | `lm-ssh-prod` | SSH Username with private key | `.username`（`lm-deploy-prod`）、`.key` | Production 部署、回滾、還原演練 |
| `release/` | `lm-prod-db` | Username with password | `.username`、`.password` | Production Database |
| `release/` | `lm-prod-setup-token` | Secret text | `lm-prod-setup-token` | Production Setup_Token |
| `release/` | `lm-prod-smoke` | Secret file | `lm-prod-smoke` | Production smoke-bot 密碼 |
| `release/` | `lm-jenkins-api-readonly` | Username with password | `.username`、`.password`（API token） | fingerprint 查詢 main 的 Build_Record、`release/digest-lookup` |
| `release/` | `lm-jenkins-api-retention` | Username with password | `.username`（`lm-retention-bot`）、`.password`（API token） | `ci/keep-log.mjs` 設定 keepLog（Req 21.6） |
| `infra/` | `lm-github-app` | GitHub App | 同上 | checkout |
| `infra/` | `lm-registry-push` | Username with password | `.username`、`.password` | 推送 Build_Image |

規則（Req 2.4、2.5、15.1）：

- 沒有任何 GLOBAL 範圍的系統憑證。PR 建置位於 `ci/`，請求表中任何 `release/` 專屬憑證時 `withCredentials` 直接失敗。
- `CAMPING_OPENAI_*` 預設不定義任何憑證（Req 15.6、15.8）。若 Release_Approver 決定為某一環境啟用（Req 15.7），只能在 `release/` 新增憑證（例如 Secret file `lm-prod-openai-api-key`，部署時以金鑰檔提供並設定 `CAMPING_OPENAI_API_KEY_FILE`），並同時修改 Pipeline 與本表；`ci/` 永遠不得定義。
- `lm-jenkins-api-readonly` 的帳號只有 Overall/Read 與 Job/Read（全域 `authenticated`）。

## 授權（Req 21.12）

全域（`casc.yaml`）只有 `lm-jenkins-admins` 擁有 Overall/Administer；其他群組只有 Overall/Read、Job/Read、View/Read。資料夾與 Job 層級（`jobs.groovy`）只另外授與：

| 範圍 | 主體 | 權限 |
|---|---|---|
| `ci/` | `lm-developers` | Job/Build、Job/Cancel |
| `release/rollback` | `lm-release-approvers` | Job/Build、Job/Cancel |
| `release/restore-drill` | `lm-release-approvers` | Job/Build |
| `release/digest-lookup` | `lm-release-approvers`、`lm-auditors` | Job/Build |
| `release/little-moments` | `lm-retention-bot`（使用者） | Job/Read、Run/Update |

非管理員沒有 Run/Delete、Run/Update、Job/Configure、Run/Replay（也沒有 Credentials/*、Lockable Resources/*）。唯一的例外是 `lm-retention-bot` 在 `release/little-moments` 的 Run/Update：Jenkins 的「Keep this build forever」需要 Run/Update，`ci/keep-log.mjs` 只用它把正在 Production 執行之 Image_Digest 的建置設為 keepLog=true。這個帳號：

- 只能以 API token 使用（不要給互動登入），token 只存在 `release/` 的 `lm-jenkins-api-retention`；
- 沒有 Run/Delete，因此無法刪除建置，也無法解除 keepLog；
- Run/Update 也允許修改建置的顯示名稱與描述。這是 Req 21.12 的已知、受限例外；Build_Record 本體（封存的 JSON 與報告）不受影響。稽核時可在 Jenkins 稽核日誌確認此帳號只呼叫 `toggleLogKeep`。

### 解除 keepLog（管理員程序）

Jenkins 解除 keepLog 需要 Run/Delete，與 Req 21.12「非管理員不可刪除」衝突，因此 Pipeline 不會自動解除。當一個 Image_Digest 離開 Production 且不再屬於 Deploy_Host 保留的最近 3 個可回滾 Image_Digest（`lm-deploy prod status` 的 `history`）時，Jenkins 管理員：

1. 執行 `release/digest-lookup`（`DIGEST=<離開保留集合的 digest>`），記下對應的 main 建置與 Release_Tag 建置。
2. 確認該 digest 不在 `lm-deploy prod status` 的目前版本與 `history` 中。
3. 對兩個建置在 UI 按「Don't keep this build forever」（或 `POST <build>/toggleLogKeep`，管理員 API token）。
4. 之後由 Build Discarder 依 90／365 天規則處理。在 Build_Record 之外另以變更紀錄保存操作人與時間。

## Release_Approver

- 核准清單的權威來源是 `ci/release-approvers.json`（`jenkinsId` 與 git email 對照）。正式核准與破壞性遷移核准的 `input` 以清單中的 `jenkinsId` 限定 submitter，送出後再以 `ci/approval.mjs` 驗證；不在清單的帳號送出時不生效並記錄帳號與時間（Req 19.3）。
- `lm-release-approvers` 群組只決定 `release/rollback`、`release/restore-drill`、`release/digest-lookup` 的 Job/Build。群組成員必須與 `ci/release-approvers.json` 一致；任一邊變更時兩邊一起更新（json 以 PR 審查，群組由 security realm 管理）。
- Jenkins 管理員可以送出任何 `input`；Pipeline 仍以 `ci/approval.mjs` 拒絕不在清單的管理員。
- 等待核准時 `release/little-moments` 的 Tag 建置會佔用一個 Trusted Agent executor 最長 24 小時。`lm-trusted` 的 executor 數至少為 2（一個留給 `main`／回滾），同時進行多個 Release_Tag 時需再增加。

## 部署前必須取代的 PLACEHOLDER

- `ci/jenkins/jobs.groovy`：`GITHUB_OWNER`、`GITHUB_REPO`。
- `ci/jenkins/casc.yaml`：`jenkins.lan.example`（`location.url`、`hookUrl`）、agent 名稱、數量與 `remoteFS`、群組名稱（若 security realm 使用不同名稱，`jobs.groovy` 的 `GROUP_*` 一併修改）。
- `Jenkinsfile` 與 `ci/jenkins/pipelines/*.Jenkinsfile`：所有 `sha256:<digest>` 映像引用（`BUILD_IMAGE`、`LM_POSTGRES_IMAGE`、掃描器、Syft、crane、cosign、ZAP）、`registry.lan.example:8443`、`LM_DEPLOY_HOST`／`LM_DEPLOY_PORT`、`LM_STAGING_URL`、`LM_PROD_URL`、`LM_DAST_PROBE_TARGETS`（IP 位址字面值）、Staging／Production Database 名稱。未取代時 Pipeline 會 fail closed。
- `Dockerfile` 與 `ci/build-image/Dockerfile`：`FROM … @sha256:<digest>`、`BUN_SHA256`、`NODE_SHA256`。
- `deploy/compose/*`、`deploy/registry/*`：映像 digest、`registry.lan.example`、htpasswd bcrypt hash（`deploy/registry/htpasswd.example`）。
- `ci/release-approvers.json`：`jenkins-id-placeholder-*` 與 `@example.invalid` email。

## Script Security（In-process Script Approval）

Pipeline 在 Groovy sandbox 中執行。首次執行時以下呼叫可能出現在「Manage Jenkins → In-process Script Approval」，請逐項比對簽章後由管理員核准（不要使用「Approve all」或關閉 sandbox）：

- `new groovy.json.JsonSlurperClassic` 與 `parseText`（Build_Record、報告 JSON）
- `RunWrapper.getBuildCauses(String)`（判斷手動觸發與 Replay）
- `FlowInterruptedException.getCauses()`、`Rejection.getUser()`（核准被拒絕時的帳號）
- `staticMethod java.lang.System currentTimeMillis`（逾時與觀察期計時）
- `@NonCPS` 輔助函式內的集合與字串操作（依實際提示核准）

`jobs.groovy` 由 Configuration as Code 以系統身分執行。若啟用「Enable script security for Job DSL scripts」，請確認 CasC 載入的 Job DSL 不需要額外核准（`SecretBytes.fromBytes`、`java.io.File` 讀取）。

## GitHub 端設定

1. Repository webhook：Payload URL `https://jenkins.lan.example/github-webhook/`、Content type `application/json`、Secret 與 `GITHUB_WEBHOOK_SECRET` 相同、事件只勾選 Pushes 與 Pull requests（Req 2.3；其他事件不會觸發建置）。
2. Ruleset：禁止非管理員建立名稱符合 `v*` 的分支；`v*` Tag 只允許 Release_Approver 建立且不可移動或刪除（Release_Tag 的最終驗證在 `ci/policy/tag.mjs`）。
3. Release_Tag 使用 annotated tag（`git tag -a vX.Y.Z`）：Tag build strategy 以 Tag 時間判斷「7 天內」，lightweight tag 以 commit 時間計算，指向較舊 commit 時不會自動建置（需管理員手動觸發該 Tag）。
4. Branch protection：`main` 需要 PR 與審查；`ci/little-moments` 的 commit status context 為 `little-moments/ci`。

## 驗證步驟（需在實際環境執行）

以下項目無法在本機驗證，請在 controller 套用設定後執行並保存結果。

### 設定載入

1. 「Manage Jenkins → Configuration as Code」顯示無錯誤；`ci/`、`release/`、`infra/` 與 6 個 Job 皆已建立。
2. `ci/` 資料夾的 Credentials 只顯示 `lm-github-app` 與 `lm-registry-pull`；`release/` 顯示上表 17 個；`infra/` 顯示 2 個；「System」只有 `lm-github-webhook-secret`（SYSTEM 範圍）。
3. 以 `lm-developers` 成員登入：`ci/little-moments` 的建置頁沒有 Replay、Delete build、Edit Build Information、Configure；`release/little-moments` 沒有 Build Now。
4. Lockable Resources 頁面顯示 `lm-staging` 與 `lm-prod`。

### 憑證隔離（Req 2.4、2.5）

在一個測試分支的 PR 中加入 `withCredentials([sshUserPrivateKey(credentialsId: 'lm-ssh-prod', keyFileVariable: 'K')]) { sh 'true' }`。預期：建置失敗並顯示找不到 `lm-ssh-prod`（`CredentialNotFoundException`），主控台不出現任何值。對 fork PR 重複，預期使用 `main` 的 `Jenkinsfile`，PR 中的修改不執行（Req 2.7）。

### Untrusted Agent 網路隔離（Req 2.6）

在 `lm-untrusted-1` 上（或 `ci/` 的測試建置中）執行，全部必須連線失敗或逾時：

```sh
for target in <deploy-host-ip>:22 <deploy-host-ip>:80 <deploy-host-ip>:443 <deploy-host-ip>:8081; do
  timeout 5 bash -c "</dev/tcp/${target%:*}/${target##*:}" && echo "REACHABLE ${target}" || echo "blocked ${target}"
done
```

另確認：Staging／Production Database 連接埠無法連線（Database 不發布連接埠，Req 11.10）；Registry 只能以 `lm-pull-ci` 讀取（`PUT` 回應 403）；建置結束後 `docker ps -a --filter label=lm.ci.build` 與工作目錄為空（`cleanWs()`）。在 `ci/` 的 PR 中把 `agent { label 'lm-trusted' }` 改寫後建置，預期一直排隊或被 Job Restrictions 拒絕，不會在 `lm-trusted-1` 執行。

### Webhook 驗證與拒絕日誌（Req 2.1、2.2）

Jenkins 前置的 Caddy（Design「信任邊界」）以 JSON 存取日誌記錄 webhook 請求，不記錄 body，並刪除簽章與認證標頭：

```caddyfile
jenkins.lan.example {
  log webhook {
    output file /var/log/caddy/jenkins-webhook.log
    format filter {
      wrap json
      fields {
        request>headers>X-Hub-Signature delete
        request>headers>X-Hub-Signature-256 delete
        request>headers>Authorization delete
        request>headers>Cookie delete
      }
    }
  }
  reverse_proxy 127.0.0.1:8080
}
```

在 Jenkins 新增 Log Recorder「github-webhook」：`com.cloudbees.jenkins.GitHubWebHook`、`org.jenkinsci.plugins.github.webhook`、`org.jenkinsci.plugins.github_branch_source`（等級 FINE 以上）。驗證：

1. 無簽章：`curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H 'X-GitHub-Event: push' -H 'Content-Type: application/json' --data '{}' https://jenkins.lan.example/github-webhook/` → 4xx，沒有建置排入佇列。
2. 錯誤簽章：同上加 `-H 'X-Hub-Signature-256: sha256:0000000000000000000000000000000000000000000000000000000000000000'` → 4xx，沒有建置。
3. 其他 repository：以正確 secret 簽一個 `repository.full_name` 為其他 repo 的 push payload → 沒有任何 Job 被觸發（Log Recorder 顯示無相符 Job）。
4. 非支援事件：以正確 secret 送出 `X-GitHub-Event: issues` → 沒有建置（Req 2.3）。
5. 正確簽章的 push 至測試分支 → 60 秒內 `ci/little-moments` 排入建置（Req 1.9）。
6. 確認 `/var/log/caddy/jenkins-webhook.log` 對 1–4 每筆都有 `ts`（接收時間）、`request.remote_ip`（來源 IP）、`status`，Log Recorder 有對應的拒絕原因；兩者皆不含 request body、`X-Hub-Signature-256` 或 webhook secret。以 `grep -c '<secret 值>'` 對兩份日誌確認為 0（在 controller 上執行，不要把 secret 貼到 shell 歷史；可用 `grep -c -f <secret 檔>`）。

Caddy 的存取日誌與 Jenkins 的拒絕原因以時間戳對應；若需要單一事件同時含三項資訊，可在 Caddy 以 `handle_response` 依 `{rp.status_code} >= 400` 另寫一份拒絕日誌。
