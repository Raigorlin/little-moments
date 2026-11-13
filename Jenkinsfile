// 日子拾光 · LITTLE MOMENTS — Jenkins Multibranch Pipeline（Requirement 1、3、21、22、23；Design「Pipeline 階段配置」）。
//
// 同一份 Jenkinsfile 由兩個 Multibranch Job 載入（Req 1.1）：
//   ci/little-moments       PR 與非 main 分支（Untrusted，無部署憑證）
//   release/little-moments  main 與 Release_Tag（Trusted，憑證只存在 release/ 資料夾範圍）
// 階段規劃由 ci/stages.mjs 決定；信任只由事件類型與 ref 決定，手動觸發或重跑不提升信任（Req 2.8）。
//
// 規則：
//   * 不提供任何建置參數（沒有 `parameters` 區塊）。沒有任何參數、環境變數或選項可以略過 Release_Gate、
//     將未通過的 Release_Gate 改為通過或放寬通過條件（Req 23.4）。唯一的 `input` 是 Release_Tag 的正式核准與
//     破壞性遷移核准（releaseApprovalLoop／destructiveApprovalLoop）：只有 submitterParameter、沒有任何參數，
//     submitter 限定 Release_Approver，送出者另以 ci/approval.mjs 再驗證。
//   * 憑證只在需要的步驟內以 withCredentials 提供（Req 15.1、15.2）；本檔只出現憑證 ID，不含任何秘密值。
//   * 失敗一律以 error()／非零結束碼終止，Declarative Pipeline 會略過所有後續階段（Req 1.7）。
//   * 所有 sh 腳本使用單引號字串，只透過 shell 環境變數（加雙引號）取用 ref、SHA 等外部值，不經 Groovy 插值。
//   * 階段名稱與 ci/stages.mjs 的 STAGE 常數一致，供 Build_Record 的 firstFailedStage 使用。
//
// 注意：本檔無法在本機執行，語法與 plugin 步驟參數未經 Jenkins 實際驗證。

import groovy.json.JsonOutput
import groovy.json.JsonSlurperClassic

// environment 各鍵的說明（自 environment 區塊移出，內容不變；鍵、值與順序不變；Components 第 22 節）。
//
// BUILD_IMAGE：
//   Build_Image 只以 digest 引用（Req 3.1）。
//   digest 來源：infra/build-image Job 建置 commit a302149 的輸出（建置描述與 reports/build-image-digest.txt）。
//   更新方式：ci/build-image/Dockerfile 或 ci/toolchain.json 變更後重新執行 infra/build-image，
//   以新輸出的 digest 在同一個 commit 內取代本檔與 ci/jenkins/pipelines/{rollback,restore-drill,digest-lookup}.Jenkinsfile 的 BUILD_IMAGE。
//   格式不是 `<registry>/<repo>@sha256:<64 hex>` 時 Init 階段失敗（fail closed），不會退回任何可變 tag。
// LM_RECORD：
//   Build_Record 路徑（封存前由 post 階段經 ci/scrub.mjs 處理）。
// LM_REGISTRY_PULL_CREDENTIALS、LM_GIT_CREDENTIALS：
//   憑證 ID（值只存在 Credential_Store；ci/ 與 release/ 資料夾各自定義）。
// LM_POSTGRES_IMAGE：
//   Ephemeral_Database 映像只以 digest 引用，與 deploy/compose/compose.yaml 的 db 相同版本（Req 4.2）。
//   digest 為 postgres:17.6-bookworm 的多平台 index（`docker buildx imagetools inspect postgres:17.6-bookworm`）；
//   更新版本時須同時修改 deploy/compose/compose.yaml 與 drill.yaml 的 db。
// LM_EDB_NAME、LM_EDB_USER：
//   Ephemeral_Database 的資料庫與管理帳號名稱（非秘密；密碼每階段隨機產生）。
// LM_GITLEAKS_IMAGE、LM_OSV_SCANNER_IMAGE、LM_TRIVY_IMAGE、LM_SEMGREP_IMAGE：
//   靜態安全掃描器（Req 6；Design「工具選型」）：鏡像至 LAN Registry（與 Build_Image 同一 Registry）並只以 digest 引用。
//   上游（linux/amd64 單一平台鏡像）：ghcr.io/gitleaks/gitleaks:v8.30.1、ghcr.io/google/osv-scanner:v2.7.1、
//   docker.io/aquasec/trivy:0.76.2、docker.io/semgrep/semgrep:1.185.0。
//   更新版本：修改 deploy/registry/mirror.list 後執行 deploy/registry/mirror.sh，再以其輸出的 digest 取代下列值。
// LM_TRIVY_DB_REPOSITORY：
//   Trivy 漏洞資料庫的 LAN 鏡像（OCI artifact，每日更新故以 tag 引用）；以唯讀拉取帳號存取。
//   Registry 主機的 lm-mirror-trivy-db.timer 每日 04:30 自 mirror.gcr.io/aquasec/trivy-db:2 複製（deploy/registry/）。
// LM_SCAN_CA_BUNDLE：
//   Agent 的系統 CA bundle（須含 LAN Registry 的內部 CA），以唯讀方式提供給 Trivy 下載資料庫。
// LM_IMAGE_REPO：
//   App_Image repository（與 deploy/compose/*.env 的 LM_IMAGE_REPO 相同，位於 Build_Image 的 LAN Registry）。
//   Migration Compatibility 以 `<repo>:<Release_Tag>`（版本標籤不覆寫，Req 16.10）拉取最近 Release_Tag 的映像後
//   立即解析為 `<repo>@sha256:<digest>`，之後只以 digest 執行。
// LM_ZAP_IMAGE：
//   DAST_Scanner（Design「工具選型」：OWASP ZAP stable，automation framework）：鏡像至 LAN Registry 並只以 digest 引用。
//   上游 ghcr.io/zaproxy/zaproxy:2.17.0（linux/amd64）；更新方式同上（deploy/registry/mirror.list、mirror.sh）。
// LM_DAST_PROBE_TARGETS：
//   隔離探測（ci/dast/isolation-probe.sh，Req 7.7、7.9）必須「無法連線」的位址：Deploy_Host 的 SSH 與 App／代理連接埠、
//   Staging／Production 連接埠、Registry、Jenkins 與其他 LAN 主機（另含探測腳本預設的網際網路位址與預設閘道）。
//   同主機配置（design.md 第 18.6 節）：全部在 Deploy_Host 192.168.1.121 上——SSH 22、Edge_Proxy（NPM）80／443 與
//   管理介面 81、Jenkins controller 8080、Staging／Production LM_Proxy 8081／8082、維運者的暫時預覽 App 8090、
//   LAN Registry 8443。只接受 IP 位址字面值（`a.b.c.d:port` 或 `[IPv6]:port`，以空白分隔；--internal 網路內
//   無法解析主機名稱會使探測失去意義），格式不符時 DAST 階段在建立 Test_Environment 前失敗。
//   主機新增發布連接埠時一併加入（以 `sudo ss -ltnp` 確認）。
// LM_SYFT_IMAGE、LM_CRANE_IMAGE、LM_COSIGN_IMAGE：
//   App_Image 掃描、SBOM、Registry 操作與簽章工具（Design「工具選型」：Trivy、Syft、crane、cosign v2）。
//   Build_Image 不含這些工具；與掃描器相同，鏡像至 LAN Registry 並只以 digest 引用。
//   上游（linux/amd64）：docker.io/anchore/syft:v1.57.1、gcr.io/go-containerregistry/crane:v0.22.1、
//   ghcr.io/sigstore/cosign/cosign:v2.6.5（2.x 最新版）。更新方式同上（deploy/registry/mirror.list、mirror.sh）；
//   crane 另須同步 ci/jenkins/pipelines/build-image.Jenkinsfile 的 LM_CRANE_IMAGE。Trivy 沿用 LM_TRIVY_IMAGE。
// LM_REGISTRY_PUSH_CREDENTIALS、LM_COSIGN_KEY_CREDENTIALS、LM_COSIGN_PASSPHRASE_CREDENTIALS：
//   推送與簽章憑證（只定義於 release/ 資料夾範圍，只在 Image Push／Image Sign 的 withCredentials 內提供；Req 15.1、15.2）：
//     lm-registry-push      Username with password：Registry 唯一可寫入的帳號 lm-push（deploy/registry/Caddyfile）
//     lm-cosign-key         Secret file：cosign 加密私鑰 cosign.key
//     lm-cosign-passphrase  Secret text：cosign.key 的密碼
// LM_DEPLOY_HOST、LM_DEPLOY_PORT：
//   Staging 部署（Req 15.1、15.2、15.9、18）：Deploy_Host 的 LAN 位址與 SSH 連接埠（非秘密）。
//   known_hosts 憑證（lm-deploy-known-hosts）須含 192.168.1.121 的主機金鑰（連接埠非 22 時為 `[host]:port` 形式）。
// LM_STAGING_URL：
//   Staging 代理的 LAN origin（/srv/lm/staging/staging.env 的 LAN_IP:LM_PUBLIC_PORT）。Smoke_Test 由 Trusted Agent
//   經此 LAN origin 執行，不經 Edge_Proxy：Host 為 192.168.1.121（須在 staging.env 的 ALLOWED_HOSTS 內），
//   App 看到的協定為 http。HTTPS 時以 LM_SCAN_CA_BUNDLE（內部 CA）驗證憑證。
// LM_STAGING_DB_NAME：
//   Staging Database 名稱（非秘密；須與 Deploy_Host 上 /srv/lm/staging/db.env 的 POSTGRES_DB 相同）。
// LM_STAGING_PREDICATE_TYPE：
//   staging-verified attestation 的 predicate type（與 ci/resolve-digest.mjs STAGING_PREDICATE_TYPE 相同）。
// LM_SSH_STAGING_CREDENTIALS、LM_KNOWN_HOSTS_CREDENTIALS、LM_COSIGN_PUBLIC_KEY_CREDENTIALS、LM_STAGING_DB_CREDENTIALS、LM_STAGING_SETUP_TOKEN_CREDENTIALS、LM_STAGING_SMOKE_CREDENTIALS：
//   Staging 憑證（只定義於 release/ 資料夾範圍，只在 Staging Deploy 的 withCredentials 內提供；Req 15.1、15.2）：
//     lm-ssh-staging            SSH Username with private key：Staging 專用部署金鑰（authorized_keys forced command
//                               `lm-deploy staging`；與 Production 的 lm-ssh-prod 不同，Req 15.9）
//     lm-deploy-known-hosts     Secret file：Deploy_Host 的 known_hosts（與 release/rollback、restore-drill 共用）
//     lm-cosign-pub             Secret file：cosign 公鑰 cosign.pub（部署前驗證簽章與 attestation，Req 17.7）
//     lm-staging-db             Username with password：Staging Database 帳號（與 Production 不同，Req 18.6）
//     lm-staging-setup-token    Secret text：Staging 的 Setup_Token（至少 32 字元）
//     lm-staging-smoke          Secret file：Staging 合成帳號 smoke-bot 的密碼（與 Production 不同）
// LM_PROD_URL：
//   Production 代理的 LAN origin（/srv/lm/prod/prod.env 的 LAN_IP:LM_PUBLIC_PORT；80／443 由 Edge_Proxy 使用）。
//   觀察期的 Smoke_Test 由 Trusted Agent 經此 LAN origin 執行，不經 Edge_Proxy 與 Cloudflare：Host 為 192.168.1.121
//   （須在 prod.env 的 ALLOWED_HOSTS 內），App 看到的協定為 http。HTTPS 時以 LM_SCAN_CA_BUNDLE（內部 CA）驗證憑證。
// LM_PROD_DB_NAME：
//   Production Database 名稱（非秘密；須與 Deploy_Host 上 /srv/lm/prod/db.env 的 POSTGRES_DB 相同）。
// LM_JENKINS_API_CREDENTIALS、LM_SSH_PROD_CREDENTIALS、LM_PROD_DB_CREDENTIALS、LM_PROD_SETUP_TOKEN_CREDENTIALS、LM_PROD_SMOKE_CREDENTIALS：
//   Release_Tag 與 Production 憑證（只定義於 release/ 資料夾範圍，只在對應步驟的 withCredentials 內提供；Req 15.1、15.2）：
//     lm-jenkins-api-readonly  Username with password：Jenkins 帳號 + API token（僅 Overall/Read、Job/Read、Run/Artifacts）；
//                              以 fingerprint 找回產生該 Image_Digest 的 main Build_Record（與 release/digest-lookup 共用）
//     lm-ssh-prod              SSH Username with private key：Production 專用部署金鑰（authorized_keys forced command
//                              `lm-deploy prod`；與 release/rollback 共用，與 Staging 的 lm-ssh-staging 不同，Req 15.9）
//     lm-prod-db               Username with password：Production Database 帳號（與 Staging 不同）
//     lm-prod-setup-token      Secret text：Production 的 Setup_Token（至少 32 字元）
//     lm-prod-smoke            Secret file：Production 合成帳號 smoke-bot 的密碼（與 Staging 不同）
//   Version Tag 另使用 lm-registry-push（crane tag 寫入版本標籤）；簽章驗證與 attestation 驗證使用 lm-registry-pull 與 lm-cosign-pub。
// LM_JENKINS_RETENTION_CREDENTIALS：
//   收尾的建置保留（Req 21.6；只定義於 release/ 資料夾範圍，只在 keepProductionBuildLog 的 withCredentials 內提供）：
//     lm-jenkins-api-retention  Username with password：Jenkins 帳號 + API token，僅 release/little-moments 的
//                               Job/Read 與 Run/Update（設定 keepLog=true；沒有 Run/Delete，因此無法解除保留或刪除建置）

pipeline {
  // 標籤由 ci/jenkins/（13.9）設定。真正的隔離邊界是 Jenkins 資料夾範圍的憑證與 agent 限制，
  // 標籤選擇只是讓 release/ 的建置落在 Trusted Agent、ci/ 的建置落在隔離 VLAN 的 Untrusted Agent（Req 2.6）。
  agent { label "${env.JOB_NAME?.startsWith('release/') ? 'lm-trusted' : 'lm-untrusted'}" }

  options {
    skipDefaultCheckout()
    timestamps()
    disableResume()
  }

  environment {
    // 各鍵的說明見 pipeline 之前的註解區塊。
    BUILD_IMAGE = 'registry.our-littlemoments.com:8443/little-moments/build-image@sha256:7eb66eee2631f762d0804dc57b59f2b42b6fba740cfabed3317624918397c97e'
    LM_RECORD = 'reports/build-record.json'
    LM_REGISTRY_PULL_CREDENTIALS = 'lm-registry-pull'
    LM_GIT_CREDENTIALS = 'lm-github-app'
    LM_POSTGRES_IMAGE = 'postgres:17.6-bookworm@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3'
    LM_EDB_NAME = 'lm_test'
    LM_EDB_USER = 'lm_test'
    LM_GITLEAKS_IMAGE = 'registry.our-littlemoments.com:8443/little-moments/mirror/gitleaks@sha256:b109bc5f8f76a38196a3e413704fc5b9e3c32360bce4e4b603bd6f45b3721dbb'
    LM_OSV_SCANNER_IMAGE = 'registry.our-littlemoments.com:8443/little-moments/mirror/osv-scanner@sha256:bc10cae80da100d32572aea48cfc48e592be9adc4a8b0820fd5d2c2db71f9446'
    LM_TRIVY_IMAGE = 'registry.our-littlemoments.com:8443/little-moments/mirror/trivy@sha256:6fa071ef8daa2e58b90cbf1710bedca91adbb3bf98693533226f442035b836a6'
    LM_SEMGREP_IMAGE = 'registry.our-littlemoments.com:8443/little-moments/mirror/semgrep@sha256:f83a64e8a7d985eaa51ee3978c9c882be946964c68633fba5d2817cf297a3912'
    LM_TRIVY_DB_REPOSITORY = 'registry.our-littlemoments.com:8443/little-moments/mirror/trivy-db:2'
    LM_SCAN_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt'
    LM_IMAGE_REPO = 'registry.our-littlemoments.com:8443/little-moments'
    LM_ZAP_IMAGE = 'registry.our-littlemoments.com:8443/little-moments/mirror/zap@sha256:c2d63bbb2d907a5c5257914fb20e26e969c92b25f265def7f89f08203f912882'
    LM_DAST_PROBE_TARGETS = '192.168.1.121:22 192.168.1.121:80 192.168.1.121:443 192.168.1.121:81 192.168.1.121:8080 192.168.1.121:8081 192.168.1.121:8082 192.168.1.121:8090 192.168.1.121:8443'
    LM_SYFT_IMAGE = 'registry.our-littlemoments.com:8443/little-moments/mirror/syft@sha256:c31c09c21a75c7c0b1f4082358614115536fa4f1d2e0bdab2d11f5257360338a'
    LM_CRANE_IMAGE = 'registry.our-littlemoments.com:8443/little-moments/mirror/crane@sha256:18efc5092649b2a674d384663044e04edf76705c4faa2875e8a322b4e80f070a'
    LM_COSIGN_IMAGE = 'registry.our-littlemoments.com:8443/little-moments/mirror/cosign@sha256:404b8081d833085d12c21cda889c6f2f3731328768257c760e32fcf070be2cf9'
    LM_REGISTRY_PUSH_CREDENTIALS = 'lm-registry-push'
    LM_COSIGN_KEY_CREDENTIALS = 'lm-cosign-key'
    LM_COSIGN_PASSPHRASE_CREDENTIALS = 'lm-cosign-passphrase'
    LM_DEPLOY_HOST = '192.168.1.121'
    LM_DEPLOY_PORT = '22'
    LM_STAGING_URL = 'http://192.168.1.121:8081'
    LM_STAGING_DB_NAME = 'little_moments_staging'
    LM_STAGING_PREDICATE_TYPE = 'https://little-moments.lan/attestations/staging-verified/v1'
    LM_SSH_STAGING_CREDENTIALS = 'lm-ssh-staging'
    LM_KNOWN_HOSTS_CREDENTIALS = 'lm-deploy-known-hosts'
    LM_COSIGN_PUBLIC_KEY_CREDENTIALS = 'lm-cosign-pub'
    LM_STAGING_DB_CREDENTIALS = 'lm-staging-db'
    LM_STAGING_SETUP_TOKEN_CREDENTIALS = 'lm-staging-setup-token'
    LM_STAGING_SMOKE_CREDENTIALS = 'lm-staging-smoke'
    LM_PROD_URL = 'http://192.168.1.121:8082'
    LM_PROD_DB_NAME = 'little_moments'
    LM_JENKINS_API_CREDENTIALS = 'lm-jenkins-api-readonly'
    LM_SSH_PROD_CREDENTIALS = 'lm-ssh-prod'
    LM_PROD_DB_CREDENTIALS = 'lm-prod-db'
    LM_PROD_SETUP_TOKEN_CREDENTIALS = 'lm-prod-setup-token'
    LM_PROD_SMOKE_CREDENTIALS = 'lm-prod-smoke'
    LM_JENKINS_RETENTION_CREDENTIALS = 'lm-jenkins-api-retention'
  }

  stages {
    stage('Init') {
      steps {
        script { runInitStage() }
      }
    }

    // Release_Tag 格式與 main ancestry 驗證（說明見 runTagVerifyStage）
    stage('Tag Verify') {
      when {
        expression { env.LM_TRIGGER_KIND == 'release_tag' || planned('Tag Verify') }
      }
      steps {
        script { runTagVerifyStage() }
      }
    }

    // 工具鏈版本先寫入 Build_Record 再判定；不一致時於安裝前失敗（Req 3.3）。
    stage('Toolchain') {
      steps {
        script { runToolchainStage() }
      }
    }

    // 只允許 --frozen-lockfile；bun.lock 不存在、與 package.json 不一致或被修改皆失敗（Req 3.4、3.5）。
    stage('Install') {
      steps {
        script { runInstallStage() }
      }
    }

    // 任何測試之前先建置；非零結束碼使建置失敗並略過所有後續階段（Req 3.6、3.7）。
    stage('Build') {
      steps {
        script { runBuildStage() }
      }
    }

    // 單元與 API 整合測試：Ephemeral_Database → Migration_Runner → bun test → JUnit（說明見 runUnitTestsStage）
    stage('Unit Tests') {
      steps {
        script { runUnitTestsStage() }
      }
      post {
        always {
          script { unitTestsPostAlways() }
        }
        cleanup {
          script { removeEphemeralDbSecrets() }
        }
      }
    }

    // 瀏覽器 E2E 與 QA_Inventory →「QA」關卡（說明見 runBrowserTestsStage）
    stage('Browser Tests') {
      steps {
        script { runBrowserTestsStage() }
      }
      post {
        always {
          script { browserTestsPostAlways() }
        }
        unsuccessful {
          // 失敗證據（Req 5.6）：Playwright 截圖與 trace（test-results/<測試標題含 TC ID>-<desktop|mobile>/）
          // 與 reports/server.log，經 ci/scrub.mjs 遮罩 Ephemeral_Database 密碼後封存。
          script { archiveBrowserEvidence() }
        }
        cleanup {
          script { removeEphemeralDbSecrets() }
        }
      }
    }

    // 靜態安全掃描：Gitleaks → osv-scanner → Trivy → Semgrep →「安全」關卡（說明見 runSecurityScanStage）
    stage('Security Scan') {
      steps {
        script { runSecurityScanStage() }
      }
      post {
        always {
          script { securityScanPostAlways() }
        }
        cleanup {
          script { cleanupSecurityScan() }
        }
      }
    }

    // 遷移相容性（Trusted_Ref 專用；說明見 runMigrationCompatibilityStage）
    stage('Migration Compatibility') {
      when {
        expression { planned('Migration Compatibility') && env.LM_TRUSTED == 'true' }
      }
      steps {
        script { runMigrationCompatibilityStage() }
      }
      post {
        always {
          script { migrationCompatibilityPostAlways() }
        }
        cleanup {
          script { removeEphemeralDbSecrets() }
        }
      }
    }

    // DAST 與含 DAST 的「安全」關卡（Trusted_Ref 專用；說明見 runDastStage）
    stage('DAST') {
      when {
        expression { planned('DAST') && env.LM_TRUSTED == 'true' }
      }
      steps {
        script { runDastStage() }
      }
      post {
        always {
          script { dastPostAlways() }
        }
        cleanup {
          script { removeEphemeralDbSecrets() }
        }
      }
    }

    // ---------------------------------------------------------------- App_Image（main 專用）

    // App_Image 建置與映像層級 Smoke_Test，不推送（說明見 runImageBuildStage）
    stage('Image Build') {
      when {
        expression { planned('Image Build') && env.LM_TRUSTED == 'true' && env.LM_TRIGGER_KIND == 'main_push' }
      }
      steps {
        script { runImageBuildStage() }
      }
      post {
        always {
          script {
            recordImageReports('reports/image-build-record-patch.json', [
              imageBuildLog: 'reports/image-build.log',
              imageInspect: 'reports/image-inspect.json',
              imageFiles: 'reports/image-files.txt',
              imageContent: 'reports/image-content.json',
              imageSmoke: 'reports/image-smoke.json',
              imageSmokeSummary: 'reports/image-smoke-summary.json',
              imageSmokeMigrate: 'reports/image-smoke-migrate.log',
              imageSmokeApp: 'reports/image-smoke-app.log',
            ])
          }
        }
        unsuccessful {
          script { imageStageFailed('Image Build') }
        }
      }
    }

    // App_Image 掃描：Trivy → normalize → evaluate（說明見 runImageScanStage）
    stage('Image Scan') {
      when {
        expression { planned('Image Scan') && env.LM_TRUSTED == 'true' && env.LM_TRIGGER_KIND == 'main_push' }
      }
      steps {
        script { runImageScanStage() }
      }
      post {
        always {
          script {
            recordImageReports('reports/image-scan-record-patch.json', [
              trivy: 'reports/security/trivy-image.json',
              imageScanEvaluation: 'reports/security/evaluation-image.json',
            ])
          }
        }
        unsuccessful {
          script { imageStageFailed('Image Scan') }
        }
      }
    }

    // SBOM 與「映像」關卡推送前評估（說明見 runSbomStage）
    stage('SBOM') {
      when {
        expression { planned('SBOM') && env.LM_TRUSTED == 'true' && env.LM_TRIGGER_KIND == 'main_push' }
      }
      steps {
        script { runSbomStage() }
      }
      post {
        unsuccessful {
          script { imageStageFailed('SBOM') }
        }
      }
    }

    // App_Image 推送與 digest 比對（說明見 runImagePushStage）
    stage('Image Push') {
      when {
        expression { planned('Image Push') && env.LM_TRUSTED == 'true' && env.LM_TRIGGER_KIND == 'main_push' }
      }
      steps {
        script { runImagePushStage() }
      }
      post {
        unsuccessful {
          script { imageStageFailed('Image Push') }
        }
      }
    }

    // App_Image 簽章、驗證與完整「映像」關卡（說明見 runImageSignStage）
    stage('Image Sign') {
      when {
        expression { planned('Image Sign') && env.LM_TRUSTED == 'true' && env.LM_TRIGGER_KIND == 'main_push' }
      }
      steps {
        script { runImageSignStage() }
      }
      post {
        unsuccessful {
          script { imageStageFailed('Image Sign') }
        }
        cleanup {
          script { cleanupImageWork() }
        }
      }
    }

    // Staging 部署、驗證與「Staging」關卡（說明見 runStagingDeployStage）
    stage('Staging Deploy') {
      when {
        expression { planned('Staging Deploy') && env.LM_TRUSTED == 'true' && env.LM_TRIGGER_KIND == 'main_push' }
      }
      steps {
        script { runStagingDeployStage() }
      }
      post {
        unsuccessful {
          script { stagingStageFailed() }
        }
        cleanup {
          script { cleanupStagingWork() }
        }
      }
    }

    // Release_Tag 的 Image_Digest 解析與「映像」「Staging」關卡（說明見 runResolveDigestStage）
    stage('Resolve Digest') {
      when {
        expression { planned('Resolve Digest') && env.LM_TRUSTED == 'true' && env.LM_TRIGGER_KIND == 'release_tag' }
      }
      steps {
        script { runResolveDigestStage() }
      }
      post {
        unsuccessful {
          script { releaseStageFailed() }
        }
        cleanup {
          script { cleanupReleaseWork() }
        }
      }
    }

    // 版本標籤，不覆寫既有標籤（說明見 runVersionTagStage）
    stage('Version Tag') {
      when {
        expression { planned('Version Tag') && env.LM_TRUSTED == 'true' && env.LM_TRIGGER_KIND == 'release_tag' }
      }
      steps {
        script { runVersionTagStage() }
      }
      post {
        cleanup {
          script { cleanupReleaseWork() }
        }
      }
    }

    // 正式核准（說明見 runApprovalStage）
    stage('Approval') {
      when {
        expression { planned('Approval') && env.LM_TRUSTED == 'true' && env.LM_TRIGGER_KIND == 'release_tag' }
      }
      steps {
        script { runApprovalStage() }
      }
      post {
        unsuccessful {
          script { approvalStageFailed() }
        }
        cleanup {
          script { cleanupReleaseWork() }
        }
      }
    }

    // Production 部署、觀察期與「上線後」關卡（說明見 runProductionDeployStage）
    stage('Production Deploy') {
      when {
        expression { planned('Production Deploy') && env.LM_TRUSTED == 'true' && env.LM_TRIGGER_KIND == 'release_tag' }
      }
      steps {
        script { runProductionDeployStage() }
      }
      post {
        unsuccessful {
          script { productionStageFailed() }
        }
        cleanup {
          script { cleanupReleaseWork() }
        }
      }
    }
  }

  // 收尾（說明見 pipelinePostAlways）
  post {
    always {
      script { pipelinePostAlways() }
    }
    cleanup {
      script { pipelinePostCleanup() }
    }
  }
}

// ------------------------------------------------------------------ 階段函式
// Declarative Pipeline 把 pipeline {} 編譯成單一 JVM 方法（上限 64 KB，JENKINS-37984）；各 stage 的 steps 與
// 多於一個敘述的 post 內容依 stage 順序放在以下頂層函式，每個函式各自編譯（Components 第 22 節）。

void runInitStage() {
  enterStage('Init')
  checkout scm
  // 固定本次建置的確切 Commit SHA；後續階段皆在同一工作目錄使用此 SHA（Req 1.6）。
  String sha = sh(label: 'git rev-parse HEAD', returnStdout: true, script: 'git rev-parse HEAD').trim()
  if (!(sha ==~ /^[0-9a-f]{40}$/)) {
    error('無法取得 40 字元 Commit SHA')
  }
  env.GIT_COMMIT_FULL = sha

  // 任何安裝、建置或測試前先設定 pending（Req 22.1）。notifyAll 永不拋出例外、不改變建置結果。
  lmNotifier = load 'ci/notify.groovy'
  lmNotifier.notifyAll('pending', [commit: sha])

  env.BUILD_IMAGE_DIGEST = buildImageDigest()
  pullBuildImage()

  inBuildImage {
    sh(label: 'reports', script: 'mkdir -p reports')
    int planRc = sh(
      label: 'ci/stages.mjs',
      returnStatus: true,
      script: isManualBuild() ? 'bun ci/stages.mjs --manual > reports/plan.json' : 'bun ci/stages.mjs > reports/plan.json'
    )
    Map plan = readPlan('reports/plan.json')

    env.LM_TRIGGER_KIND = plan.kind ? plan.kind.toString() : fallbackTriggerKind()
    env.LM_TRUSTED = (plan.trusted == true) ? 'true' : 'false'
    env.LM_STAGES = plan.stages instanceof List ? plan.stages.join('|') : ''
    env.LM_REF = env.TAG_NAME ?: (env.BRANCH_NAME ?: '')

    // 建立本次執行唯一的 Build_Record（Req 21.1）：建置編號、開始時間、完整 SHA、觸發類型、ref、Build_Image digest。
    sh(label: 'Build_Record init', script: '''
      bun ci/record.mjs init --record "$LM_RECORD" \
        --job "$JOB_NAME" --number "$BUILD_NUMBER" --url "$BUILD_URL" \
        --commit "$GIT_COMMIT_FULL" --trigger "$LM_TRIGGER_KIND" --ref "$LM_REF" \
        --build-image-digest "$BUILD_IMAGE_DIGEST"
    ''')

    if (planRc != 0 || plan.reject || !plan.kind) {
      // reject 字串為 ci/stages.mjs 內的固定訊息，不含使用者輸入。
      error("觸發被拒絕：${plan.reject ?: '無法規劃階段'}")
    }
  }

  assertJobFolder(env.LM_TRUSTED == 'true')
  echo "觸發類型 ${env.LM_TRIGGER_KIND}（trusted=${env.LM_TRUSTED}），commit ${sha}"
}

// Release_Tag：格式與 main ancestry 驗證，位於所有品質、推送與部署階段之前（Req 1.5）。
// 格式不符已在 Init 由 ci/stages.mjs 拒絕；此處以 ci/policy/tag.mjs 再驗證格式並檢查 main 歷史。
void runTagVerifyStage() {
  enterStage('Tag Verify')
  withCredentials([gitUsernamePassword(credentialsId: env.LM_GIT_CREDENTIALS)]) {
    sh(label: 'fetch origin/main', script: 'git fetch --no-tags --quiet origin +refs/heads/main:refs/remotes/origin/main')
  }
  inBuildImage {
    int rc = sh(
      label: 'ci/policy/tag.mjs',
      returnStatus: true,
      script: 'bun ci/policy/tag.mjs "$TAG_NAME" "$GIT_COMMIT_FULL" --main-ref origin/main'
    )
    if (rc == 1) {
      error('Release_Tag 格式不符 v<major>.<minor>.<patch>')
    } else if (rc == 2) {
      error('Release_Tag 指向的 commit 不在 main 分支歷史中')
    } else if (rc != 0) {
      error('Release_Tag 驗證無法完成')
    }
  }
}

void runToolchainStage() {
  enterStage('Toolchain')
  inBuildImage {
    int rc = sh(
      label: 'ci/verify-toolchain.mjs',
      returnStatus: true,
      script: 'bun ci/verify-toolchain.mjs --out reports/toolchain.json --record-patch reports/toolchain-patch.json'
    )
    sh(label: 'Build_Record toolchain', script: 'bun ci/record.mjs merge --record "$LM_RECORD" --patch reports/toolchain-patch.json')
    if (rc != 0) {
      error('工具鏈版本與 ci/toolchain.json 不一致（工具名稱、預期與實際版本見 reports/toolchain.json）')
    }
  }
}

void runInstallStage() {
  enterStage('Install')
  inBuildImage {
    sh(label: 'bun install --frozen-lockfile', script: '''
      set -eu
      if [ ! -f bun.lock ]; then
        echo "找不到 bun.lock，安裝中止" >&2
        exit 1
      fi
      before="$(sha256sum bun.lock)"
      bun install --frozen-lockfile
      after="$(sha256sum bun.lock)"
      if [ "$before" != "$after" ]; then
        echo "bun.lock 在安裝期間被修改，安裝中止" >&2
        exit 1
      fi
    ''')
  }
}

void runBuildStage() {
  enterStage('Build')
  inBuildImage {
    sh(label: 'bun run build', script: 'bun run build')
  }
}

// 單元與 API 整合測試（Req 4.1–4.8）：本階段專用的 Ephemeral_Database（每次建立、tmpfs、不發布連接埠）
// → Migration_Runner → verify-env → bun test（15 分鐘逾時）→ JUnit；post 於 120 秒內銷毀資料庫。
void runUnitTestsStage() {
  enterStage('Unit Tests')
  env.LM_UNIT_DONE = 'false'
  startEphemeralDb('unit')
  inBuildImageOn(env.LM_EDB_NET) {
    withEnv(testEnv()) {
      qaStep('Migration_Runner 無法套用遷移至 Ephemeral_Database')
      int migrateRc = sh(label: 'Migration_Runner', returnStatus: true, script: '''
        set +x
        set -eu
        set -a
        . "$LM_EDB_DIR/client.env"
        set +a
        CAMPING_DATABASE_HOST="$CAMPING_TEST_DATABASE_HOST" \
        CAMPING_DATABASE_PORT="$CAMPING_TEST_DATABASE_PORT" \
        CAMPING_DATABASE_NAME="$CAMPING_TEST_DATABASE_NAME" \
        CAMPING_DATABASE_USER="$CAMPING_TEST_DATABASE_USER" \
        CAMPING_DATABASE_PASSWORD="$CAMPING_TEST_DATABASE_PASSWORD" \
        CAMPING_DATABASE_SSLMODE="$CAMPING_TEST_DATABASE_SSLMODE" \
        CAMPING_BIND_ADDRESS=127.0.0.1 \
          bun scripts/migrate.mjs > reports/unit-migrate.log 2>&1
      ''')
      if (migrateRc != 0) {
        error("Migration_Runner 以結束碼 ${migrateRc} 結束（見 reports/unit-migrate.log），不執行 bun test")
      }

      verifyTestEnv()

      qaStep('bun test 失敗、逾時（15 分鐘）或執行的測試數量為 0')
      int testRc
      // 外層保護；實際 15 分鐘上限由 shell 的 timeout 執行，逾時結束碼 124／137。
      timeout(time: 17, unit: 'MINUTES') {
        testRc = sh(label: 'bun test', returnStatus: true, script: '''
          set +x
          set -eu
          set -a
          . "$LM_EDB_DIR/client.env"
          set +a
          rm -f reports/unit-junit.xml
          timeout --kill-after=30 900 bun test --reporter=junit --reporter-outfile=reports/unit-junit.xml tests/*.test.js
        ''')
      }
      if (testRc == 124 || testRc == 137) {
        error('bun test 超過 15 分鐘，已中止')
      }
      // 失敗數、錯誤數為 0 且測試數量 > 0（Req 4.4）。
      int junitRc = sh(
        label: 'ci/gates.mjs unit JUnit',
        returnStatus: true,
        script: 'bun ci/gates.mjs junit --gate QA --commit "$GIT_COMMIT_FULL" --out reports/unit-gate.json reports/unit-junit.xml'
      )
      if (testRc != 0 || junitRc != 0) {
        error("單元與 API 測試未通過（bun test 結束碼 ${testRc}，見 reports/unit-junit.xml）")
      }
      qaStep('')
    }
  }
  env.LM_UNIT_DONE = 'true'
}

void unitTestsPostAlways() {
  destroyEphemeralDb()
  junit(testResults: 'reports/unit-junit.xml', allowEmptyResults: true)
  Map reports = existingReports([unitJunit: 'reports/unit-junit.xml', unitMigrate: 'reports/unit-migrate.log', verifyEnv: 'reports/verify-env.json'])
  // JUnit 不論成功或失敗都寫入 Build_Record（Req 4.5）；失敗時「QA」關卡未通過，
  // 記錄關卡名稱、未符合的條件與失敗原因（不含憑證值；Req 4.6、23.1、23.3、23.5）。
  boolean failed = env.LM_UNIT_DONE != 'true'
  inBuildImage {
    recordQa(
      patch: 'reports/unit-record-patch.json',
      reports: reports,
      gate: failed,
      junit: ['reports/unit-junit.xml'],
      inventory: '',
      stageError: failed ? qaStageError('Unit Tests') : ''
    )
  }
}

// 瀏覽器 E2E 與 QA_Inventory（Req 5.3–5.9）：qa-inventory validate → check-accounts.mjs（60 分鐘逾時，
// 不重試、不傳 --reporter；報告由 playwright.config.js 寫入 reports/e2e.json 與 reports/e2e-junit.xml）
// → qa-inventory compare → 以 ci/gates.mjs 評估「QA」關卡（單元 + 瀏覽器 JUnit + QA_Inventory）。
void runBrowserTestsStage() {
  enterStage('Browser Tests')
  env.LM_BROWSER_DONE = 'false'
  env.LM_QA_GATE_RECORDED = 'false'

  // QA_Inventory 不合格時在瀏覽器測試前失敗，並記錄不合格的項目 ID 與原因（Req 5.8）。
  inBuildImage {
    qaStep('QA_Inventory 驗證未通過（見 reports/qa-inventory-validate.json）')
    int validateRc = sh(
      label: 'qa-inventory validate',
      returnStatus: true,
      script: 'bun scripts/qa-inventory.mjs validate qa/inventory.json > reports/qa-inventory-validate.json'
    )
    if (validateRc != 0) {
      error('QA_Inventory 驗證未通過（不合格的項目 ID 與原因見 reports/qa-inventory-validate.json）')
    }
  }

  startEphemeralDb('e2e')
  inBuildImageOn(env.LM_EDB_NET) {
    withEnv(testEnv()) {
      verifyTestEnv()

      qaStep('瀏覽器測試失敗或超過 60 分鐘')
      int e2eRc
      timeout(time: 62, unit: 'MINUTES') {
        e2eRc = sh(label: 'scripts/check-accounts.mjs', returnStatus: true, script: '''
          set +x
          set -eu
          set -a
          . "$LM_EDB_DIR/client.env"
          set +a
          rm -rf test-results reports/e2e.json reports/e2e-junit.xml reports/server.log
          timeout --kill-after=60 3600 node scripts/check-accounts.mjs
        ''')
      }

      // 不論瀏覽器測試結果，只要有 Playwright 報告就比對 QA_Inventory（Req 5.4）。
      int compareRc = -1
      if (fileExists('reports/e2e.json')) {
        compareRc = sh(
          label: 'qa-inventory compare',
          returnStatus: true,
          script: 'bun scripts/qa-inventory.mjs compare qa/inventory.json reports/e2e.json --out reports/qa-inventory.json > /dev/null'
        )
      }

      if (e2eRc == 124 || e2eRc == 137) {
        error('瀏覽器測試超過 60 分鐘，已終止')
      }
      if (e2eRc != 0) {
        error("scripts/check-accounts.mjs 以結束碼 ${e2eRc} 結束")
      }
      // compare 未通過（失敗或缺少測試的項目）由下方「QA」關卡判定並記錄項目 ID（Req 5.5）。
      echo "qa-inventory compare 結束碼 ${compareRc}"

      // 「QA」關卡（Req 23.2）：所有單元、API 與瀏覽器測試失敗數與錯誤數為 0，且 QA_Inventory 全數通過。
      qaStep('')
      int gateRc = recordQa(
        patch: 'reports/browser-record-patch.json',
        reports: browserReports(),
        gate: true,
        junit: qaJunitReports(),
        inventory: 'reports/qa-inventory.json',
        stageError: ''
      )
      if (gateRc != 0) {
        error('Release_Gate「QA」未通過（未符合的條件見 Build_Record 與 reports/gate-qa.json）')
      }
    }
  }
  env.LM_BROWSER_DONE = 'true'
}

void browserTestsPostAlways() {
  destroyEphemeralDb()
  junit(testResults: 'reports/e2e-junit.xml', allowEmptyResults: true)
  if (env.LM_QA_GATE_RECORDED != 'true') {
    // 階段在關卡評估前失敗、逾時或中止 →「QA」關卡未通過（Req 5.8、5.9、23.1、23.3）。
    String inventory = fileExists('reports/qa-inventory.json') ? 'reports/qa-inventory.json' : ''
    inBuildImage {
      recordQa(
        patch: 'reports/browser-record-patch.json',
        reports: browserReports(),
        gate: true,
        junit: qaJunitReports(),
        inventory: inventory,
        stageError: qaStageError('Browser Tests')
      )
    }
  }
}

// 靜態安全掃描（Req 6.1–6.9）：Gitleaks（受版本控制檔案 + Git 歷史範圍，--redact）→ osv-scanner v2（bun.lock）
// → Trivy（安裝後的 node_modules 交叉掃描）→ Semgrep（src/、server/、scripts/）。每項掃描 15 分鐘逾時。
// 結果經 ci/policy/normalize.mjs → ci/policy/evaluate.mjs 判定「安全」關卡（不含 DAST；Trusted_Ref 的 DAST 階段另以含 DAST 的報告重新評估並追加一筆）。
// 任一掃描執行錯誤、逾時、報告缺失或漏洞資料庫無法取得 → 該掃描未完成 → 關卡未通過（fail closed，Req 6.8）。
// 掃描器容器：digest 固定、非 root、唯讀根檔案系統、--cap-drop ALL、只以唯讀方式掛載掃描輸入，
// 寫入只限本次掃描的暫存目錄；Gitleaks 與 Semgrep 無網路，osv-scanner／Trivy 只為取得漏洞資料庫而連線。
void runSecurityScanStage() {
  enterStage('Security Scan')
  lmScanErrors = []
  env.LM_SECURITY_GATE_RECORDED = 'false'

  secStep('掃描器映像未以 digest 固定或無法拉取')
  pullImages(scannerImages())

  prepareScanSources()

  secStep('無法取得掃描工具版本')
  scannerVersions()
  secStep('')

  // Gitleaks：建置 commit 的所有受版本控制檔案（Req 6.1）。--redact 使報告不含任何秘密原文字元（Req 6.4）；
  // 不使用 -v，主控台只有摘要。--exit-code 0：有結果仍為 0，非零結束碼代表執行錯誤。
  runScan('Gitleaks（受版本控制檔案）', 'gitleaks-dir.json', '''
    set -u
    rc=0
    timeout --kill-after=30 900 docker run --rm --name "$LM_SCAN_RUN-gitleaks-dir" \
      --label "lm.ci.build=$BUILD_TAG" --label "lm.ci.scan=$LM_SCAN_RUN" \
      --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m -e HOME=/tmp \
      --security-opt no-new-privileges:true --cap-drop ALL --network none \
      --mount "type=bind,src=$LM_SCAN_DIR/tree,dst=/src,readonly" \
      --mount "type=bind,src=$LM_SCAN_DIR/out,dst=/out" \
      -w /src "$LM_GITLEAKS_IMAGE" \
      dir --redact --no-banner --exit-code 0 --report-format json --report-path "/out/$LM_SCAN_REPORT" . || rc=$?
    exit "$rc"
  ''')

  // Gitleaks：Git 歷史範圍（Untrusted_PR：merge base..HEAD；Trusted_Ref：上次成功建置..HEAD，無則完整歷史）。
  if (env.LM_GITLEAKS_LOG_OPTS) {
    runScan('Gitleaks（Git 歷史）', 'gitleaks-git.json', '''
      set -u
      rc=0
      timeout --kill-after=30 900 docker run --rm --name "$LM_SCAN_RUN-gitleaks-git" \
        --label "lm.ci.build=$BUILD_TAG" --label "lm.ci.scan=$LM_SCAN_RUN" \
        --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m -e HOME=/tmp \
        --security-opt no-new-privileges:true --cap-drop ALL --network none \
        -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0=/repo \
        --mount "type=bind,src=$LM_SCAN_DIR/history.git,dst=/repo,readonly" \
        --mount "type=bind,src=$LM_SCAN_DIR/out,dst=/out" \
        "$LM_GITLEAKS_IMAGE" \
        git --redact --no-banner --exit-code 0 --report-format json --report-path "/out/$LM_SCAN_REPORT" \
        --log-opts="$LM_GITLEAKS_LOG_OPTS" /repo || rc=$?
      exit "$rc"
    ''')
  }

  // osv-scanner v2：依 bun.lock 掃描直接與間接相依（Req 6.2）。--all-packages 供 normalize 計算套件數
  // （0 個套件視為掃描無法完成）。結束碼 1 代表有漏洞（由 evaluate 判定）；127／128 等為掃描未完成。
  runScan('osv-scanner（bun.lock）', 'osv.json', '''
    set -u
    if [ ! -f "$LM_SCAN_DIR/tree/bun.lock" ]; then
      echo "找不到 bun.lock" >&2
      exit 3
    fi
    rc=0
    timeout --kill-after=30 900 docker run --rm --name "$LM_SCAN_RUN-osv-scanner" \
      --label "lm.ci.build=$BUILD_TAG" --label "lm.ci.scan=$LM_SCAN_RUN" \
      --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m -e HOME=/tmp \
      --security-opt no-new-privileges:true --cap-drop ALL --network bridge \
      --mount "type=bind,src=$LM_SCAN_DIR/tree,dst=/src,readonly" \
      --mount "type=bind,src=$LM_SCAN_DIR/out,dst=/out" \
      "$LM_OSV_SCANNER_IMAGE" \
      scan source --lockfile=/src/bun.lock --all-packages --format json --output-file "/out/$LM_SCAN_REPORT" || rc=$?
    if [ "$rc" -eq 1 ]; then rc=0; fi
    exit "$rc"
  ''')

  // Trivy：以 rootfs 模式讀取安裝後 node_modules 內各套件的 package.json，與 osv-scanner 交叉驗證（Design 工具選型）。
  // 資料庫自 LAN 鏡像下載；拉取帳號只經 docker 的 -e NAME 繼承環境變數，不出現在命令列。
  withCredentials([usernamePassword(
    credentialsId: env.LM_REGISTRY_PULL_CREDENTIALS,
    usernameVariable: 'LM_REG_USER',
    passwordVariable: 'LM_REG_PASSWORD'
  )]) {
    runScan('Trivy（node_modules）', 'trivy-node-modules.json', '''
      set +x
      set -u
      if [ ! -d "$WORKSPACE/node_modules" ]; then
        echo "找不到 node_modules（Install 階段未完成）" >&2
        exit 3
      fi
      if [ ! -f "$LM_SCAN_CA_BUNDLE" ]; then
        echo "找不到 LM_SCAN_CA_BUNDLE 指定的 CA bundle" >&2
        exit 3
      fi
      mkdir -p "$LM_SCAN_DIR/trivy-cache"
      TRIVY_USERNAME="$LM_REG_USER"
      TRIVY_PASSWORD="$LM_REG_PASSWORD"
      export TRIVY_USERNAME TRIVY_PASSWORD
      rc=0
      timeout --kill-after=30 900 docker run --rm --name "$LM_SCAN_RUN-trivy" \
        --label "lm.ci.build=$BUILD_TAG" --label "lm.ci.scan=$LM_SCAN_RUN" \
        --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m -e HOME=/tmp \
        --security-opt no-new-privileges:true --cap-drop ALL --network bridge \
        -e TRIVY_USERNAME -e TRIVY_PASSWORD \
        --mount "type=bind,src=$WORKSPACE/node_modules,dst=/scan/node_modules,readonly" \
        --mount "type=bind,src=$LM_SCAN_CA_BUNDLE,dst=/etc/ssl/certs/ca-certificates.crt,readonly" \
        --mount "type=bind,src=$LM_SCAN_DIR/trivy-cache,dst=/cache" \
        --mount "type=bind,src=$LM_SCAN_DIR/out,dst=/out" \
        "$LM_TRIVY_IMAGE" \
        rootfs --scanners vuln --list-all-pkgs --format json --output "/out/$LM_SCAN_REPORT" \
        --cache-dir /cache --db-repository "$LM_TRIVY_DB_REPOSITORY" --timeout 14m --quiet /scan || rc=$?
      unset TRIVY_USERNAME TRIVY_PASSWORD
      exit "$rc"
    ''')
  }

  // Semgrep：ci/semgrep/run.sh（離線規則；src/、server/、scripts/ 的 .js／.mjs；Req 6.3）。
  runScan('Semgrep（SAST）', 'semgrep.json', '''
    set -u
    rc=0
    timeout --kill-after=30 900 docker run --rm --name "$LM_SCAN_RUN-semgrep" \
      --label "lm.ci.build=$BUILD_TAG" --label "lm.ci.scan=$LM_SCAN_RUN" \
      --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=1g -e HOME=/tmp \
      --security-opt no-new-privileges:true --cap-drop ALL --network none \
      --mount "type=bind,src=$LM_SCAN_DIR/tree,dst=/src,readonly" \
      --mount "type=bind,src=$LM_SCAN_DIR/out,dst=/out" \
      --entrypoint sh -w /src "$LM_SEMGREP_IMAGE" \
      ci/semgrep/run.sh scan "/out/$LM_SCAN_REPORT" || rc=$?
    if [ "$rc" -eq 1 ]; then rc=0; fi
    exit "$rc"
  ''')

  // 正規化 → 政策評估（Req 6.4–6.9）。normalize 只保留 ID、套件與版本、路徑、行號與 commit；
  // Gitleaks 原始報告即使已 --redact 仍不保留。evaluate 結束碼 0 通過、1 未通過、2 無法評估。
  secStep('掃描報告正規化或安全政策評估失敗')
  inBuildImage {
    sh(label: 'ci/policy/normalize.mjs', script: '''
      set -u
      mkdir -p reports/security/raw
      for spec in gitleaks:gitleaks-dir gitleaks:gitleaks-git osv-scanner:osv trivy:trivy-node-modules semgrep:semgrep; do
        tool="${spec%%:*}"
        name="${spec#*:}"
        ver=""
        if [ -f "$LM_SCAN_DIR/out/$tool.version" ]; then ver="$(head -n 1 "$LM_SCAN_DIR/out/$tool.version")"; fi
        if [ -n "$ver" ]; then
          bun ci/policy/normalize.mjs --tool "$tool" --in "$LM_SCAN_DIR/out/$name.json" --out "reports/security/$name.json" --tool-version "$ver" || true
        else
          bun ci/policy/normalize.mjs --tool "$tool" --in "$LM_SCAN_DIR/out/$name.json" --out "reports/security/$name.json" || true
        fi
      done
      rm -f "$LM_SCAN_DIR/out/gitleaks-dir.json" "$LM_SCAN_DIR/out/gitleaks-git.json"
      for name in osv trivy-node-modules semgrep; do
        if [ -f "$LM_SCAN_DIR/out/$name.json" ]; then cp "$LM_SCAN_DIR/out/$name.json" "reports/security/raw/$name.json"; fi
      done
      exit 0
    ''')
    int evalRc = sh(label: 'ci/policy/evaluate.mjs', returnStatus: true, script: '''
      set -u
      rm -f reports/security/evaluation.json
      bun ci/policy/evaluate.mjs \
        --reports reports/security/gitleaks-dir.json reports/security/gitleaks-git.json reports/security/osv.json reports/security/trivy-node-modules.json reports/security/semgrep.json \
        --exceptions security/exceptions.json --commit "$GIT_COMMIT_FULL" --today "$LM_SCAN_TODAY" \
        --out reports/security/evaluation.json
    ''')
    if (evalRc != 0 && evalRc != 1) {
      lmScanErrors << "安全政策評估無法執行（ci/policy/evaluate.mjs 結束碼 ${evalRc}）".toString()
    }
  }
  secStep('')

  // 「安全」關卡（Req 23.2，不含 DAST）：寫入 Build_Record 後才判定（Req 6.7、23.5）。
  if (recordSecurityGate('') != 0) {
    error('Release_Gate「安全」未通過（未符合的條件見 Build_Record 與 reports/security/evaluation.json）')
  }
}

void securityScanPostAlways() {
  if (env.LM_SECURITY_GATE_RECORDED != 'true') {
    // 階段在關卡評估前失敗、逾時或中止 →「安全」關卡未通過（Req 6.8、23.3）。
    recordSecurityGate(secStageError())
  }
}

// 遷移相容性（Trusted_Ref 專用，ci/stages.mjs TRUSTED_ONLY_STAGES；Req 12.5、12.8、12.9；Design §5「相容性驗證」）：
//   lint-migrations（未標記的破壞性遷移即失敗）→ `git describe` 找 <sha>^ 之前最近的 Release_Tag（無則記錄略過原因）
//   → 相對於該 Tag 無遷移變更時記錄略過原因 → 在本階段的 Ephemeral_Database 上以該 Tag 的 App_Image 套用其全部遷移
//   → 以本次 commit 的 Migration_Runner 套用新增遷移 → 以舊 App_Image 啟動（--internal 網路、不發布連接埠）
//   → 建立合成資料 → Smoke_Test。結果（含失敗的 Smoke_Test 項目與相關遷移檔）寫入 Build_Record 的 reports.migrationCompat。
void runMigrationCompatibilityStage() {
  enterStage('Migration Compatibility')
  env.LM_COMPAT_RECORDED = 'false'
  env.LM_COMPAT_TAG = ''
  env.LM_COMPAT_IMAGE = ''
  env.LM_COMPAT_MIGRATIONS = ''
  env.LM_COMPAT_APP = ''

  // Req 12.9：會移除或重新命名欄位／資料表但未標記 `-- lm:destructive` 的遷移 → 建置失敗。
  compatStep('lint-migrations 未通過（未標記的破壞性遷移或無法在交易內執行的語句，見 reports/lint-migrations.log）')
  inBuildImage {
    int lintRc = sh(label: 'lint-migrations', returnStatus: true, script: 'bun scripts/lint-migrations.mjs > reports/lint-migrations.log 2>&1')
    if (lintRc != 0) {
      error("lint-migrations 以結束碼 ${lintRc} 結束（未通過的遷移檔見 reports/lint-migrations.log）")
    }
  }

  compatStep('無法取得 Release_Tag 或遷移差異')
  withCredentials([gitUsernamePassword(credentialsId: env.LM_GIT_CREDENTIALS)]) {
    sh(label: 'fetch Release_Tags', script: '''
      set -eu
      if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
        git fetch --unshallow --no-tags --quiet origin
      fi
      git fetch --no-tags --quiet --force origin '+refs/tags/v*:refs/tags/v*'
    ''')
  }
  // 只看本次 commit 的祖先（<sha>^1），Release_Tag 建置因此不會選到自己的 Tag。
  // 含 `-`／`+` 的預發布形式先排除；其餘結果仍須通過 Release_Tag 格式驗證，否則失敗（fail closed）。
  String tag = sh(label: 'nearest Release_Tag', returnStdout: true, script: '''
    set -eu
    base="$GIT_COMMIT_FULL^1"
    if ! git rev-parse -q --verify "$base^{commit}" > /dev/null; then
      echo none
      exit 0
    fi
    if [ -z "$(git tag --list --merged "$base" 'v[0-9]*.[0-9]*.[0-9]*')" ]; then
      echo none
      exit 0
    fi
    git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' --exclude '*-*' --exclude '*+*' "$base"
  ''').trim()
  if (tag == 'none') {
    recordMigrationCompat('skipped', '本次 commit 之前尚無任何 Release_Tag，略過遷移相容性驗證（Req 12.5）')
    echo '尚無 Release_Tag，略過遷移相容性驗證（原因已寫入 Build_Record）'
    return
  }
  if (!isReleaseTag(tag)) {
    error('git describe 找到的最近 Tag 不符合 Release_Tag 格式 v<major>.<minor>.<patch>')
  }
  env.LM_COMPAT_TAG = tag

  String changed = sh(label: 'migrations since Release_Tag', returnStdout: true, script: '''
    set -eu
    git diff --name-only --no-renames "refs/tags/$LM_COMPAT_TAG" "$GIT_COMMIT_FULL" -- migrations/
  ''')
  List files = migrationFiles(changed)
  if (files == null) {
    error('遷移差異含無效的檔名')
  }
  env.LM_COMPAT_MIGRATIONS = files.join(' ')
  if (files.isEmpty()) {
    recordMigrationCompat('skipped', "相對於 ${tag} 沒有新增或變更的遷移檔，略過遷移相容性驗證（Req 12.5）".toString())
    echo "相對於 ${tag} 沒有遷移變更，略過遷移相容性驗證"
    return
  }
  echo "最近 Release_Tag ${tag}；變更的遷移檔：${env.LM_COMPAT_MIGRATIONS}"

  compatStep("無法拉取 ${tag} 的 App_Image 或解析其 digest".toString())
  env.LM_COMPAT_IMAGE = pullReleaseImage(tag)

  compatStep('Ephemeral_Database 未於 120 秒內就緒或無法建立')
  startEphemeralDb('compat')
  writeAppSecrets()
  env.LM_COMPAT_APP = "${env.LM_EDB_RUN}-app"

  // 1. 最近 Release_Tag 的全部遷移：以該 App_Image 內的 Migration_Runner 套用。
  compatStep("${tag} 的 App_Image 無法套用其遷移至 Ephemeral_Database（見 reports/migration-compat-old-migrate.log）".toString())
  int oldRc = sh(label: 'Release_Tag Migration_Runner', returnStatus: true, script: '''
    set +x
    set -u
    rc=0
    timeout --kill-after=10 300 docker run --rm --name "$LM_EDB_RUN-old-migrate" --network "$LM_EDB_NET" \
      --label "lm.ci.edb=$LM_EDB_RUN" --label "lm.ci.build=$BUILD_TAG" \
      --cap-drop ALL --security-opt no-new-privileges:true --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
      --env-file "$LM_EDB_DIR/app.env" \
      -e "CAMPING_DATABASE_HOST=$LM_EDB_HOST" -e CAMPING_DATABASE_PORT=5432 -e "CAMPING_DATABASE_NAME=$LM_EDB_NAME" \
      -e "CAMPING_DATABASE_USER=$LM_EDB_USER" -e CAMPING_DATABASE_SSLMODE=disable \
      --entrypoint bun "$LM_COMPAT_IMAGE" /app/server/migrate.js \
      > reports/migration-compat-old-migrate.log 2>&1 || rc=$?
    exit "$rc"
  ''')
  if (oldRc != 0) {
    error("${tag} 的 Migration_Runner 以結束碼 ${oldRc} 結束（見 reports/migration-compat-old-migrate.log）")
  }

  // 2. 新增遷移：本次 commit 的 Migration_Runner（同一個 Database）。
  compatStep("本次 commit 的 Migration_Runner 無法套用新增遷移（${env.LM_COMPAT_MIGRATIONS}；見 reports/migration-compat-new-migrate.log）".toString())
  inBuildImageOn(env.LM_EDB_NET) {
    withEnv(testEnv()) {
      int newRc = migrateEphemeralDb('reports/migration-compat-new-migrate.log')
      if (newRc != 0) {
        error("本次 commit 的 Migration_Runner 以結束碼 ${newRc} 結束（見 reports/migration-compat-new-migrate.log）")
      }
    }
  }

  // 3. 以舊 App_Image 啟動：綁定 0.0.0.0 只在容器的網路命名空間內；網路為 --internal 且不發布連接埠。
  compatStep("${tag} 的 App_Image 無法在新增遷移後啟動".toString())
  sh(label: 'start Release_Tag App_Image', script: '''
    set +x
    set -eu
    docker run -d --name "$LM_COMPAT_APP" --network "$LM_EDB_NET" \
      --label "lm.ci.edb=$LM_EDB_RUN" --label "lm.ci.build=$BUILD_TAG" \
      --cap-drop ALL --security-opt no-new-privileges:true --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
      --env-file "$LM_EDB_DIR/app.env" --env-file "$LM_EDB_DIR/setup.env" \
      -e "CAMPING_DATABASE_HOST=$LM_EDB_HOST" -e CAMPING_DATABASE_PORT=5432 -e "CAMPING_DATABASE_NAME=$LM_EDB_NAME" \
      -e "CAMPING_DATABASE_USER=$LM_EDB_USER" -e CAMPING_DATABASE_SSLMODE=disable \
      -e CAMPING_BIND_ADDRESS=0.0.0.0 -e PORT=5173 -e "CAMPING_ALLOWED_HOSTS=$LM_COMPAT_APP" \
      "$LM_COMPAT_IMAGE" > /dev/null
  ''')

  // 4. 合成資料 + Smoke_Test（Req 12.5、12.8）：於同一 --internal 網路內的 Build_Image 容器執行。
  inBuildImageOn(env.LM_EDB_NET) {
    withEnv(testEnv() + ["CAMPING_SMOKE_BASE_URL=http://${env.LM_COMPAT_APP}:5173".toString()]) {
      compatStep("${tag} 的 App_Image 未於 120 秒內就緒或無法建立合成資料".toString())
      int seedRc = seedTestApp('reports/migration-compat')
      if (seedRc != 0) {
        error("${tag} 的 App_Image 未就緒或無法建立合成資料（結束碼 ${seedRc}，見 reports/migration-compat-health.json、reports/migration-compat-seed.json）")
      }
      compatStep("${tag} 的 App_Image 在新增遷移（${env.LM_COMPAT_MIGRATIONS}）後 Smoke_Test 失敗（失敗項目見 Build_Record）".toString())
      int smokeRc = sh(label: 'Smoke_Test（Release_Tag App_Image）', returnStatus: true, script: '''
        set +x
        set -u
        set -a
        . "$LM_EDB_DIR/smoke.env"
        set +a
        rc=0
        timeout --kill-after=10 600 bun scripts/smoke.mjs > reports/migration-compat-smoke.json || rc=$?
        exit "$rc"
      ''')
      if (smokeRc != 0) {
        error("${tag} 的 App_Image 在新增遷移後 Smoke_Test 失敗（結束碼 ${smokeRc}，見 reports/migration-compat-smoke.json）")
      }
    }
  }
  if (!containerRunning(env.LM_COMPAT_APP)) {
    error("${tag} 的 App_Image 於 Smoke_Test 期間停止")
  }

  recordMigrationCompat('pass', '')
  compatStep('')
}

void migrationCompatibilityPostAlways() {
  saveContainerLog(env.LM_COMPAT_APP, 'reports/migration-compat-app.log')
  destroyEphemeralDb()
  if (env.LM_COMPAT_RECORDED != 'true') {
    recordMigrationCompat('fail', compatStageError())
  }
}

// DAST（Trusted_Ref 專用，且瀏覽器測試全部通過後才執行；Req 7.1–7.11、10.10、10.11）：
//   Ephemeral_Database（--internal 網路）→ ci/dast/targets.mjs 驗證並產生 ZAP 計畫（任何掃描請求前，Req 7.2、7.3）
//   → 本次 commit 的 Migration_Runner → Test_Environment（Build_Image 執行 checkout，綁定 0.0.0.0 只在 internal 網路內）
//   → 合成資料 → ci/dast/isolation-probe.sh（Test_Environment 網路命名空間；只允許 Ephemeral_Database，Req 7.7、7.9）
//   → tests/security（scripts/security-suite.mjs：loopback 與 Req 10.10 的非 loopback bind + 非 loopback Host）
//   → OWASP ZAP（速率 20 rps、5 執行緒）→ normalize → evaluate（靜態掃描 + ZAP + 安全測試套件）→ 含 DAST 的「安全」關卡。
// 整個階段 60 分鐘上限（Req 7.4）；逾時視為失敗，使用者中止則為已中止（Req 7.5）。post 先停止 ZAP、銷毀環境，再記錄關卡（Req 7.11）。
void runDastStage() {
  enterStage('DAST')
  lmDastErrors = []
  env.LM_DAST_GATE_RECORDED = 'false'
  env.LM_DAST_APP = ''
  dastStep('')
  if (env.LM_BROWSER_DONE != 'true') {
    dastStep('瀏覽器測試未全部通過')
    error('瀏覽器測試未全部通過，不執行 DAST（Req 7.1）')
  }
  long started = System.currentTimeMillis()
  try {
    timeout(time: 60, unit: 'MINUTES') {
      runDast()
    }
  } catch (org.jenkinsci.plugins.workflow.steps.FlowInterruptedException e) {
    // timeout 步驟逾時與使用者中止都以 FlowInterruptedException 結束；以經過時間區分。
    if (System.currentTimeMillis() - started >= 60L * 60L * 1000L - 5000L) {
      dastStep('DAST 階段達到 60 分鐘上限，已中止 DAST_Scanner')
      lmDastErrors << 'DAST 階段達到 60 分鐘上限，掃描未完成'
      error('DAST 階段達到 60 分鐘上限，已中止 DAST_Scanner 並停止後續發布階段（Req 7.4）')
    }
    dastStep('DAST 階段已被中止')
    throw e
  }

  // 含 DAST 的「安全」關卡（Req 7.8、10.11、23.2）：寫入 Build_Record 後才判定。
  dastStep('')
  if (recordDastSecurityGate('') != 0) {
    error('Release_Gate「安全」（含 DAST）未通過（未符合的條件見 Build_Record 與 reports/security/evaluation-dast.json）')
  }
}

void dastPostAlways() {
  // 先停止 DAST_Scanner 並銷毀 Test_Environment 與 Ephemeral_Database（Req 7.5、7.11），再記錄關卡。
  stopDastScanner()
  saveContainerLog(env.LM_DAST_APP, 'reports/dast/app.log')
  destroyEphemeralDb()
  if (env.LM_DAST_GATE_RECORDED != 'true') {
    catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
      evaluateDastReports()
    }
    recordDastSecurityGate(dastStageError())
  }
}

// ci/stages.mjs 只在 main_push 規劃 Image Build → Image Scan → SBOM → Image Push → Image Sign（TRUSTED_ONLY_STAGES；
// Req 1.3、2.8、16.1）。Release_Tag 建置不重新建置 App_Image（Req 1.4），由 Resolve Digest 沿用 main 的 Image_Digest。
// 「映像」關卡分兩次評估並寫入 Build_Record（Req 23.2、23.5）：SBOM 之後評估推送前部分（掃描秘密數 0、未處理
// Critical/High 為 0、SBOM 已保存），簽章之後評估完整條件（另含簽章已推送且可驗證、Build_Record 記錄 digest 與 commit）。
// 任一映像階段在關卡評估前失敗、逾時或中止 → post 記錄「映像」未通過（Req 23.1、23.3），不執行後續推送與部署階段。
//
// App_Image 建置（Req 16.1、16.8、16.9；Design §11）：確認本次「QA」與「安全」（含 DAST）關卡皆已通過 →
// 驗證並拉取映像工具 → ci/scripts/build-image.sh（OCI 標籤、`<repo>:<完整 SHA>`、映像內容檢查）→
// ci/scripts/image-smoke.sh（以打包後的映像連線 Ephemeral_Database、遷移、啟動並執行 Smoke_Test）。
// 本階段沒有推送憑證，不推送任何映像或標籤；建置日誌不論成敗都寫入 Build_Record（Req 16.8）。
void runImageBuildStage() {
  enterStage('Image Build')
  lmImageErrors = []
  env.LM_IMAGE_GATE_ELIGIBLE = 'false'
  env.LM_IMAGE_GATE_DONE = 'false'
  env.LM_IMAGE_REF = ''
  env.LM_IMAGE_ID = ''
  env.LM_IMAGE_DIGEST = ''
  env.LM_SBOM_OK = 'false'
  imgStep('')

  // 前一個關卡未通過時不評估「映像」（Req 23.2），也不建置 App_Image（Req 16.1）。
  requireQaAndSecurityPassed()
  env.LM_IMAGE_GATE_ELIGIBLE = 'true'

  imgStep('映像工具（Trivy、Syft、crane、cosign）未以 digest 固定或無法拉取')
  pullImages(imageToolImages())
  prepareImageWork()

  // build-image.sh 在 Agent 上執行 docker；bun 由 $LM_IMG_DIR/bin/bun 包裝為無網路的 Build_Image 容器。
  imgStep('App_Image 建置或映像內容檢查失敗（見 reports/image-build.log、reports/image-content.json）')
  int buildRc
  timeout(time: 60, unit: 'MINUTES') {
    buildRc = sh(label: 'ci/scripts/build-image.sh', returnStatus: true, script: '''
      set -u
      rc=0
      BUN_BIN="$LM_IMG_DIR/bin/bun" TMPDIR="$LM_IMG_DIR/tmp" \
        bash ci/scripts/build-image.sh --commit "$GIT_COMMIT_FULL" --repo "$LM_IMAGE_REPO" --reports reports || rc=$?
      exit "$rc"
    ''')
  }
  if (buildRc == 1) {
    error('App_Image 內容檢查違規（見 reports/image-content.json），不推送 App_Image（Req 16.9）')
  } else if (buildRc == 3) {
    error('App_Image 建置失敗（日誌見 reports/image-build.log），不推送任何映像或標籤（Req 16.8）')
  } else if (buildRc != 0) {
    error("App_Image 建置或內容檢查無法完成（ci/scripts/build-image.sh 結束碼 ${buildRc}）")
  }
  String ref = readFile('reports/image-ref.txt').trim()
  String id = readFile('reports/image-id.txt').trim()
  if (ref != "${env.LM_IMAGE_REPO}:${env.GIT_COMMIT_FULL}".toString() || !(id ==~ /^sha256:[0-9a-f]{64}$/)) {
    error('ci/scripts/build-image.sh 輸出的映像參照或 image ID 無效')
  }
  env.LM_IMAGE_REF = ref
  env.LM_IMAGE_ID = id

  // 打包後伺服器的行為（Req 16.2）：推送前以映像本身執行 Migration_Runner、啟動與 Smoke_Test。
  imgStep('映像層級 Smoke_Test 未通過（見 reports/image-smoke-summary.json）')
  int smokeRc
  timeout(time: 30, unit: 'MINUTES') {
    smokeRc = sh(label: 'ci/scripts/image-smoke.sh', returnStatus: true, script: '''
      set -u
      rc=0
      bash ci/scripts/image-smoke.sh --image "$LM_IMAGE_REF" --postgres-image "$LM_POSTGRES_IMAGE" \
        --reports reports --label "$BUILD_TAG" || rc=$?
      exit "$rc"
    ''')
  }
  if (smokeRc != 0) {
    error("映像層級 Smoke_Test 未通過（ci/scripts/image-smoke.sh 結束碼 ${smokeRc}，見 reports/image-smoke-summary.json），不推送 App_Image")
  }
  imgStep('')
}

// App_Image 掃描（Req 17.1–17.3）：`docker save` → Trivy `image --scanners vuln,secret`（作業系統套件、應用程式相依套件
// 與秘密；15 分鐘逾時）→ normalize → evaluate。掃描無法完成（結束碼非零、逾時、漏洞資料庫無法載入）或有未處理的
// Critical/High、任何秘密 →「映像」關卡未通過，不產生 SBOM、不推送。Trivy 原始報告（可能含遮罩後的秘密所在行）不保存，
// Build_Record 只保存 normalize 後只含 ID、套件、版本與路徑的報告（Req 17.2）。
void runImageScanStage() {
  enterStage('Image Scan')
  imgStep('無法匯出 App_Image 供掃描')
  sh(label: 'docker save App_Image', script: '''
    set -eu
    rm -rf "$LM_IMG_DIR/scan"
    rm -f "$LM_IMG_DIR/out/trivy-image.json" reports/security/trivy-image.json reports/security/evaluation-image.json
    mkdir -m 0700 "$LM_IMG_DIR/scan"
    docker save -o "$LM_IMG_DIR/scan/image.tar" "$LM_IMAGE_REF"
  ''')

  // 資料庫自 LAN 鏡像下載；拉取帳號只經 docker 的 -e NAME 繼承環境變數，不出現在命令列。
  imgStep('App_Image 掃描無法完成（Trivy 執行錯誤、超過 15 分鐘或漏洞資料庫無法載入）')
  int trivyRc
  withCredentials([usernamePassword(
    credentialsId: env.LM_REGISTRY_PULL_CREDENTIALS,
    usernameVariable: 'LM_REG_USER',
    passwordVariable: 'LM_REG_PASSWORD'
  )]) {
    timeout(time: 17, unit: 'MINUTES') {
      trivyRc = sh(label: 'Trivy（App_Image）', returnStatus: true, script: '''
        set +x
        set -u
        if [ ! -f "$LM_SCAN_CA_BUNDLE" ]; then
          echo "找不到 LM_SCAN_CA_BUNDLE 指定的 CA bundle" >&2
          exit 3
        fi
        mkdir -p "$LM_IMG_DIR/trivy-cache"
        TRIVY_USERNAME="$LM_REG_USER"
        TRIVY_PASSWORD="$LM_REG_PASSWORD"
        export TRIVY_USERNAME TRIVY_PASSWORD
        rc=0
        timeout --kill-after=30 900 docker run --rm --name "$LM_IMG_RUN-trivy" \
          --label "lm.ci.build=$BUILD_TAG" --label "lm.ci.image=$LM_IMG_RUN" \
          --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=4g -e HOME=/tmp -e TMPDIR=/tmp \
          --security-opt no-new-privileges:true --cap-drop ALL --network bridge \
          -e TRIVY_USERNAME -e TRIVY_PASSWORD \
          --mount "type=bind,src=$LM_IMG_DIR/scan,dst=/scan,readonly" \
          --mount "type=bind,src=$LM_SCAN_CA_BUNDLE,dst=/etc/ssl/certs/ca-certificates.crt,readonly" \
          --mount "type=bind,src=$LM_IMG_DIR/trivy-cache,dst=/cache" \
          --mount "type=bind,src=$LM_IMG_DIR/out,dst=/out" \
          "$LM_TRIVY_IMAGE" \
          image --input /scan/image.tar --scanners vuln,secret --list-all-pkgs --format json --output /out/trivy-image.json \
          --cache-dir /cache --db-repository "$LM_TRIVY_DB_REPOSITORY" --timeout 14m --quiet || rc=$?
        unset TRIVY_USERNAME TRIVY_PASSWORD
        if [ "$rc" -ne 0 ]; then
          rm -f "$LM_IMG_DIR/out/trivy-image.json"
        fi
        exit "$rc"
      ''')
    }
  }
  if (trivyRc == 124 || trivyRc == 137) {
    lmImageErrors << 'Trivy 映像掃描超過 15 分鐘或被終止，掃描未完成'
  } else if (trivyRc == 3) {
    lmImageErrors << 'Trivy 映像掃描缺少輸入（CA bundle），掃描未完成'
  } else if (trivyRc != 0) {
    lmImageErrors << "Trivy 映像掃描執行錯誤或漏洞資料庫無法載入（結束碼 ${trivyRc}），掃描未完成".toString()
  }

  // 報告缺失時 normalize 產生 complete:false，evaluate 視為掃描未完成（fail closed）。
  imgStep('App_Image 掃描報告正規化或安全政策評估失敗')
  int evalRc
  inBuildImage {
    evalRc = sh(label: 'App_Image normalize + evaluate', returnStatus: true, script: '''
      set -u
      mkdir -p reports/security
      bun ci/policy/normalize.mjs --tool trivy --in "$LM_IMG_DIR/out/trivy-image.json" --out reports/security/trivy-image.json || true
      rm -f "$LM_IMG_DIR/out/trivy-image.json"
      bun ci/policy/evaluate.mjs --reports reports/security/trivy-image.json \
        --exceptions security/exceptions.json --commit "$GIT_COMMIT_FULL" --today "$LM_IMG_TODAY" \
        --out reports/security/evaluation-image.json
    ''')
  }
  if (evalRc != 0 && evalRc != 1) {
    lmImageErrors << "App_Image 安全政策評估無法執行（ci/policy/evaluate.mjs 結束碼 ${evalRc}）".toString()
  }
  imgStep('')
  // 掃描未通過時立即記錄「映像」未通過並停止；通過時由 SBOM 之後的推送前評估一併記錄。
  if (recordImageGate('scan', '', false) != 0) {
    error('Release_Gate「映像」未通過：App_Image 掃描未完成、偵測到秘密或有未處理的 Critical/High 結果（見 Build_Record 與 reports/security/evaluation-image.json），不推送 App_Image')
  }
}

// SBOM（Req 17.4、21.2）：掃描通過後以 Syft 產生 CycloneDX JSON（無網路），ci/sbom-check.mjs 確認含套件與 npm 相依，
// 寫入 Build_Record 的 reports.sbom（Image_Digest 於推送後寫入同一份 Build_Record）。接著評估「映像」關卡推送前部分。
void runSbomStage() {
  enterStage('SBOM')
  imgStep('Syft 無法產生 SBOM')
  int syftRc
  timeout(time: 17, unit: 'MINUTES') {
    syftRc = sh(label: 'Syft SBOM', returnStatus: true, script: '''
      set -u
      rm -f "$LM_IMG_DIR/out/sbom.cdx.json" reports/sbom.cdx.json reports/sbom-summary.json
      rc=0
      timeout --kill-after=30 900 docker run --rm --name "$LM_IMG_RUN-syft" \
        --label "lm.ci.build=$BUILD_TAG" --label "lm.ci.image=$LM_IMG_RUN" \
        --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=4g -e HOME=/tmp -e TMPDIR=/tmp \
        --security-opt no-new-privileges:true --cap-drop ALL --network none \
        -e SYFT_CHECK_FOR_APP_UPDATE=false \
        --mount "type=bind,src=$LM_IMG_DIR/scan,dst=/scan,readonly" \
        --mount "type=bind,src=$LM_IMG_DIR/out,dst=/out" \
        "$LM_SYFT_IMAGE" \
        scan docker-archive:/scan/image.tar --output cyclonedx-json=/out/sbom.cdx.json --quiet || rc=$?
      if [ "$rc" -eq 0 ] && [ -s "$LM_IMG_DIR/out/sbom.cdx.json" ]; then
        cp "$LM_IMG_DIR/out/sbom.cdx.json" reports/sbom.cdx.json
      elif [ "$rc" -eq 0 ]; then
        rc=3
      fi
      exit "$rc"
    ''')
  }
  if (syftRc != 0) {
    lmImageErrors << "Syft 無法產生 SBOM（結束碼 ${syftRc}）".toString()
    error("Syft 無法產生 SBOM（結束碼 ${syftRc}），不推送 App_Image")
  }
  imgStep('SBOM 格式無效或未列出任何套件（見 reports/sbom-summary.json）')
  int sbomRc
  inBuildImage {
    sbomRc = sh(label: 'ci/sbom-check.mjs', returnStatus: true, script: '''
      bun ci/sbom-check.mjs --in reports/sbom.cdx.json --image-id "$LM_IMAGE_ID" --out reports/sbom-summary.json
    ''')
  }
  if (sbomRc != 0) {
    error('SBOM 格式無效或未列出作業系統與應用程式相依套件（見 reports/sbom-summary.json），不推送 App_Image')
  }
  mergeRecordPatch('reports/sbom-record-patch.json', [reports: [sbom: 'reports/sbom.cdx.json', sbomSummary: 'reports/sbom-summary.json']])
  env.LM_SBOM_OK = 'true'
  sh(label: 'remove image archive', script: 'rm -rf "$LM_IMG_DIR/scan"')
  imgStep('')

  // 「映像」關卡推送前部分（Design「Pipeline 階段配置」Gate 映像（推送前部分））。
  if (recordImageGate('prepush', '', true) != 0) {
    error('Release_Gate「映像」（推送前）未通過（未符合的條件見 Build_Record 與 reports/gate-image-prepush.json），不推送 App_Image')
  }
}

// 推送與 digest 比對（Req 16.10、17.5、17.6、21.2）：推送帳號只在此 withCredentials 內，docker 登入資訊只存在
// 本建置暫存目錄（結束即刪除）。`<repo>:<完整 SHA>` 已存在即拒絕覆寫（每次建置的 OCI created 標籤不同，同一 commit
// 重建的內容必然不同；Req 16.10）→ docker push → 本機 RepoDigest、Registry 的標籤 digest 與以 digest 查詢的結果三者
// 必須一致 → reports/image-digest.txt（內容恰為 `<digest>\n`）封存並 fingerprint，供 release/digest-lookup 查詢。
void runImagePushStage() {
  enterStage('Image Push')
  if (env.LM_SBOM_OK != 'true' || !env.LM_IMAGE_REF) {
    imgStep('SBOM 未保存或 App_Image 未建置，不推送')
    error('SBOM 未保存或 App_Image 未建置，不推送 App_Image（Req 17.4、17.5）')
  }
  imgStep('App_Image 推送失敗、標籤已存在（拒絕覆寫）或 Registry 回報的 Image_Digest 與建置結果不一致')
  int pushRc
  withCredentials([usernamePassword(
    credentialsId: env.LM_REGISTRY_PUSH_CREDENTIALS,
    usernameVariable: 'LM_PUSH_USER',
    passwordVariable: 'LM_PUSH_PASSWORD'
  )]) {
    timeout(time: 30, unit: 'MINUTES') {
      pushRc = sh(label: 'docker push + Registry digest', returnStatus: true, script: '''
        set +x
        set -u
        rm -f reports/image-digest.txt
        registry="${LM_IMAGE_REPO%%/*}"
        DOCKER_CONFIG="$LM_IMG_DIR/docker-push"
        export DOCKER_CONFIG
        rm -rf "$DOCKER_CONFIG"
        mkdir -m 0700 "$DOCKER_CONFIG"
        trap 'docker logout "$registry" > /dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"' EXIT
        printf '%s' "$LM_PUSH_PASSWORD" | docker login --username "$LM_PUSH_USER" --password-stdin "$registry" > /dev/null 2>&1 || exit 20
        crane() {
          timeout --kill-after=10 120 docker run --rm \
            --label "lm.ci.build=$BUILD_TAG" --label "lm.ci.image=$LM_IMG_RUN" \
            --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m -e HOME=/tmp \
            --security-opt no-new-privileges:true --cap-drop ALL --network bridge \
            -e DOCKER_CONFIG=/docker-config -e SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
            --mount "type=bind,src=$DOCKER_CONFIG,dst=/docker-config,readonly" \
            --mount "type=bind,src=$LM_SCAN_CA_BUNDLE,dst=/etc/ssl/certs/ca-certificates.crt,readonly" \
            "$LM_CRANE_IMAGE" "$@"
        }
        out="$LM_IMG_DIR/out"
        rc=0
        crane digest "$LM_IMAGE_REF" > "$out/existing-digest.txt" 2> "$out/existing-digest.err" || rc=$?
        if [ "$rc" -eq 0 ]; then
          echo "Registry 已存在標籤 ${LM_IMAGE_REF##*:}，拒絕覆寫" >&2
          exit 10
        fi
        if ! grep -Eq 'MANIFEST_UNKNOWN|unexpected status code 404' "$out/existing-digest.err"; then
          echo "Registry 查詢失敗，無法確認標籤是否已存在" >&2
          exit 11
        fi
        docker push --quiet "$LM_IMAGE_REF" > "$out/push.log" 2>&1 || exit 12
        local_ref="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$LM_IMAGE_REF" \
          | awk -v p="$LM_IMAGE_REPO@sha256:" 'index($0, p) == 1 { print; exit }')"
        digest="${local_ref#"$LM_IMAGE_REPO@"}"
        if ! printf '%s\\n' "$digest" | grep -Eqx 'sha256:[0-9a-f]{64}'; then
          echo "推送後無法取得本機 RepoDigest" >&2
          exit 13
        fi
        remote="$(crane digest "$LM_IMAGE_REF" 2> /dev/null)" || exit 14
        by_digest="$(crane digest "$LM_IMAGE_REPO@$digest" 2> /dev/null)" || exit 14
        if [ "$remote" != "$digest" ] || [ "$by_digest" != "$digest" ]; then
          echo "Registry 回報的 Image_Digest 與建置結果不一致" >&2
          exit 15
        fi
        printf '%s\\n' "$digest" > reports/image-digest.txt
        exit 0
      ''')
    }
  }
  if (pushRc == 10) {
    error("Registry 已存在標籤 ${env.GIT_COMMIT_FULL}，拒絕覆寫並停止 Pipeline（Req 16.10）")
  } else if (pushRc == 11 || pushRc == 14) {
    error('Registry 查詢失敗，無法確認或比對 Image_Digest（Req 17.6）')
  } else if (pushRc == 12) {
    error('App_Image 推送失敗（Req 17.6）')
  } else if (pushRc == 13 || pushRc == 15) {
    error('Registry 回報的 Image_Digest 與 Pipeline 建置的 Image_Digest 不一致（Req 17.6）')
  } else if (pushRc == 20) {
    error("無法以 ${env.LM_REGISTRY_PUSH_CREDENTIALS} 登入 Registry")
  } else if (pushRc != 0) {
    error("App_Image 推送或 digest 比對無法完成（結束碼 ${pushRc}）")
  }
  String digestFile = readFile('reports/image-digest.txt')
  String digest = digestFile.trim()
  if (!(digest ==~ /^sha256:[0-9a-f]{64}$/) || digestFile != "${digest}\n".toString()) {
    error('reports/image-digest.txt 格式無效（必須恰為 `<digest>\\n`）')
  }
  env.LM_IMAGE_DIGEST = digest
  mergeRecordPatch('reports/image-push-record-patch.json', [
    image: [digest: digest, tags: [env.GIT_COMMIT_FULL]],
    reports: [imageDigest: 'reports/image-digest.txt'],
  ])
  // fingerprint ID 為 MD5(`<digest>\n`)，release/digest-lookup 與 Release_Tag 建置以此找回本 Build_Record（Req 21.7）。
  archiveArtifacts(artifacts: 'reports/image-digest.txt', fingerprint: true)
  echo "App_Image 已推送：${env.LM_IMAGE_REPO}@${digest}"
  imgStep('')
}

// 簽章（Req 17.5、17.6）：推送帳號、cosign 私鑰（檔案）與密碼只在此巢狀 withCredentials 內；容器只以唯讀掛載取得金鑰，
// 密碼只經 docker 的 -e NAME 繼承。以 digest（不是標籤）`cosign sign --tlog-upload=false`，再以同一私鑰導出的公鑰
// `cosign verify --insecure-ignore-tlog=true` 確認簽章已推送至 Registry 且對象為該 Image_Digest，最後評估完整的「映像」關卡。
void runImageSignStage() {
  enterStage('Image Sign')
  String digest = env.LM_IMAGE_DIGEST ?: ''
  if (!(digest ==~ /^sha256:[0-9a-f]{64}$/)) {
    imgStep('沒有已推送的 Image_Digest，無法簽章')
    error('沒有已推送且已比對的 Image_Digest，無法簽章（Req 17.6）')
  }
  imgStep('App_Image 簽章失敗或簽章無法驗證（見 reports/image-sign.log、reports/image-verify.log）')
  int signRc
  withCredentials([usernamePassword(
    credentialsId: env.LM_REGISTRY_PUSH_CREDENTIALS,
    usernameVariable: 'LM_PUSH_USER',
    passwordVariable: 'LM_PUSH_PASSWORD'
  )]) {
    withCredentials([file(credentialsId: env.LM_COSIGN_KEY_CREDENTIALS, variable: 'LM_COSIGN_KEY_FILE')]) {
      withCredentials([string(credentialsId: env.LM_COSIGN_PASSPHRASE_CREDENTIALS, variable: 'LM_COSIGN_PASSWORD')]) {
        timeout(time: 15, unit: 'MINUTES') {
          signRc = sh(label: 'cosign sign + verify', returnStatus: true, script: '''
            set +x
            set -u
            rm -f reports/image-sign.log reports/image-signature.json reports/image-verify.log "$LM_IMG_DIR/out/cosign.pub"
            registry="${LM_IMAGE_REPO%%/*}"
            DOCKER_CONFIG="$LM_IMG_DIR/docker-sign"
            export DOCKER_CONFIG
            rm -rf "$DOCKER_CONFIG"
            mkdir -m 0700 "$DOCKER_CONFIG"
            trap 'docker logout "$registry" > /dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"; rm -f "$LM_IMG_DIR/out/cosign.pub"' EXIT
            printf '%s' "$LM_PUSH_PASSWORD" | docker login --username "$LM_PUSH_USER" --password-stdin "$registry" > /dev/null 2>&1 || exit 20
            COSIGN_PASSWORD="$LM_COSIGN_PASSWORD"
            export COSIGN_PASSWORD
            cosign() {
              timeout --kill-after=10 300 docker run --rm \
                --label "lm.ci.build=$BUILD_TAG" --label "lm.ci.image=$LM_IMG_RUN" \
                --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m -e HOME=/tmp -e TUF_ROOT=/tmp/tuf \
                --security-opt no-new-privileges:true --cap-drop ALL --network bridge \
                -e COSIGN_PASSWORD -e DOCKER_CONFIG=/docker-config -e SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
                --mount "type=bind,src=$LM_COSIGN_KEY_FILE,dst=/keys/cosign.key,readonly" \
                --mount "type=bind,src=$DOCKER_CONFIG,dst=/docker-config,readonly" \
                --mount "type=bind,src=$LM_SCAN_CA_BUNDLE,dst=/etc/ssl/certs/ca-certificates.crt,readonly" \
                --mount "type=bind,src=$LM_IMG_DIR/out,dst=/out" \
                "$LM_COSIGN_IMAGE" "$@"
            }
            ref="$LM_IMAGE_REPO@$LM_IMAGE_DIGEST"
            cosign sign --yes --key /keys/cosign.key --tlog-upload=false "$ref" > reports/image-sign.log 2>&1 || exit 30
            cosign public-key --key /keys/cosign.key --outfile /out/cosign.pub > /dev/null 2>&1 || exit 31
            unset COSIGN_PASSWORD
            cosign verify --key /out/cosign.pub --insecure-ignore-tlog=true --output json "$ref" \
              > reports/image-signature.json 2> reports/image-verify.log || exit 32
            exit 0
          ''')
        }
      }
    }
  }
  if (signRc == 20) {
    error("無法以 ${env.LM_REGISTRY_PUSH_CREDENTIALS} 登入 Registry，未簽章")
  } else if (signRc == 30) {
    error('cosign 簽章失敗（見 reports/image-sign.log），不執行任何部署階段（Req 17.6）')
  } else if (signRc == 31) {
    error('無法由簽章金鑰導出公鑰，簽章無法驗證')
  } else if (signRc == 32) {
    error('簽章無法以簽章金鑰的公鑰驗證（見 reports/image-verify.log），不執行任何部署階段（Req 17.6）')
  } else if (signRc != 0) {
    error("App_Image 簽章無法完成（結束碼 ${signRc}）")
  }
  String signatureText = readFile('reports/image-signature.json')
  if (!signatureCovers(signatureText, digest)) {
    error('cosign verify 的結果不含此 Image_Digest 的簽章（Req 17.6）')
  }
  mergeRecordPatch('reports/image-sign-record-patch.json', [
    image: [signature: 'verified'],
    reports: [imageSignature: 'reports/image-signature.json', imageSignLog: 'reports/image-sign.log'],
  ])
  imgStep('')

  // 完整的「映像」關卡（Req 23.2）：掃描、SBOM、簽章已推送、Build_Record 記錄 Image_Digest 與 Commit SHA。
  if (recordImageGate('final', '', true) != 0) {
    error('Release_Gate「映像」未通過（未符合的條件見 Build_Record 與 reports/gate-image-final.json），不執行任何部署階段')
  }
}

// Staging 部署與驗證（Req 14.1–14.3、14.8、17.7、17.8、18.1–18.5、18.7–18.9、23.2、23.5）。只在完整的「映像」關卡
// 通過後執行（Req 1.3、23.2）：
//   lock('lm-staging')（排隊等待，同一時間最多 1 個建置部署至 Staging，Req 18.9）
//   → 以 Credential_Store 的公鑰 `cosign verify` 該 Image_Digest；未通過即不連線 Deploy_Host（Req 17.7、17.8）
//   → SSH 受限金鑰 `lm-deploy staging deploy <digest> --app-env-stdin`：備份並驗證 → app.env → Migration_Runner
//     → 以 repo@digest 在閒置槽位啟動 → 120 秒內每 10 秒 Health_Check、連續 3 次成功 → 切換（Req 14.1–14.3、18.1–18.3、18.7）
//   → Smoke_Test（10 分鐘內，Req 18.3）→ finalize → `cosign attest` staging-verified predicate → `cosign verify-attestation`
//   → Build_Record 與「Staging」關卡（Req 14.8、18.4、23.5）。
// 驗證失敗（健康、Smoke_Test、逾時或結果不明）時，於 5 分鐘內 `lm-deploy staging rollback` 切回前一個已通過 Staging
// 驗證的 Image_Digest 並以 `health --wait` 確認；不存在時新版容器已停止並記錄無可還原者（Req 18.5、18.8）。
// 判讀邏輯在 ci/staging.mjs；finalize 只在驗證通過後執行，因此 Staging 的目前版本一律是已通過驗證的 digest。
void runStagingDeployStage() {
  enterStage('Staging Deploy')
  env.LM_STG_ELIGIBLE = 'false'
  env.LM_STG_GATE_DONE = 'false'
  env.LM_STG_SIGNATURE = 'not_run'
  env.LM_STG_FINALIZE = 'not_run'
  env.LM_STG_ATTESTATION = 'not_run'
  env.LM_STG_DEPLOY_CALLED = 'false'
  env.LM_STG_VERIFIED = 'false'
  env.LM_STG_RESTORE_DONE = 'false'
  stgStep('')

  // 前一個關卡未通過時不部署也不評估「Staging」（Req 23.2）。
  requireImageGatePassed()
  env.LM_STG_ELIGIBLE = 'true'

  stgStep('Staging 部署設定無效或 cosign 映像無法拉取')
  assertStagingConfig()
  pullImages([env.LM_COSIGN_IMAGE])
  prepareStagingWork()

  // 一般 lock（不使用 skipIfLocked）：其他 main 建置在此排隊，等待前一次部署與驗證完成（Req 18.9）。
  stgStep('等待 lm-staging 鎖時中止或逾時')
  lock(resource: 'lm-staging') {
    try {
      deployStaging()
    } catch (err) {
      // 未預期的錯誤或中止：仍持有鎖時先還原，再讓階段失敗（Req 18.5、18.8）。
      if (env.LM_STG_DEPLOY_CALLED == 'true' && env.LM_STG_VERIFIED != 'true' && env.LM_STG_RESTORE_DONE != 'true') {
        restoreStaging()
      }
      throw err
    }
  }
  stgStep('')
}

// Release_Tag 的 Image_Digest 解析與「映像」「Staging」關卡（Req 1.4、1.10、17.7、19.5、23.2、23.5；Design §17）。
// 不重新建置 App_Image（Req 16.1）：以 main 建置推送的 `<repo>:<完整 SHA>` 標籤查得 Image_Digest
//   → 查無即失敗並於建置摘要顯示原因，不進入核准、不執行任何 Production 階段（Req 1.10）；Registry 錯誤不視為查無
//   →「映像」關卡：Credential_Store 公鑰 `cosign verify` 通過，且以 fingerprint 找回的 main Build_Record 記錄相同 commit、
//     digest 與 SBOM
//   →「Staging」關卡：該 digest 有 commit 相符、Smoke_Test 通過的 staging-verified attestation（Req 19.5）
// crane／cosign 以 digest 固定的工具容器在 Agent 上執行，判讀在 ci/resolve-digest.mjs step（Agent 上沒有 Bun）。
// 「Staging」關卡在版本標籤之前評估：不為未通過 Staging 驗證的 digest 建立版本標籤。
void runResolveDigestStage() {
  enterStage('Resolve Digest')
  env.LM_REL_ELIGIBLE = 'false'
  env.LM_REL_PENDING_GATE = ''
  env.LM_REL_GATES_OK = 'false'
  relStep('')

  // 前一個關卡未通過時不評估「映像」（Req 23.2）。
  requireReleaseQualityGates()
  env.LM_REL_ELIGIBLE = 'true'

  relStep('Release_Tag 設定無效或 crane／cosign 映像無法拉取')
  assertReleaseConfig()
  pullImages([env.LM_CRANE_IMAGE, env.LM_COSIGN_IMAGE])
  prepareReleaseWork()
  resolveReleaseImage()
  relStep('')
}

// 版本標籤（Req 16.6、16.10）：`<repo>:<Release_Tag>` 不存在 → `crane tag <repo>@<digest>`（寫入後再次確認）；
// 已指向相同 digest → 不動作；指向不同 digest → 拒絕覆寫並失敗。推送帳號只在此 withCredentials 內。
void runVersionTagStage() {
  enterStage('Version Tag')
  env.LM_REL_VERSION_TAG = 'false'
  requireReleaseGatesPassed()
  prepareReleaseWork()
  applyVersionTag()
  env.LM_REL_VERSION_TAG = 'true'
}

// 正式核准（Req 12.6、19.1–19.8、23.2、23.5；Design §15）：
//   核准畫面（Tag、完整 SHA、完整 digest、Staging 的 Health_Check／Smoke_Test 結果與完成時間、安全報告連結）
//   → 24 小時 `input` 迴圈：submitter 限定 Release_Approver，送出者另以 ci/approval.mjs 再驗證（Jenkins 管理員可送出
//     任何 input）；非 Release_Approver 的核准或拒絕不生效、維持等待並記錄帳號與時間（Req 19.3）
//   → 破壞性遷移逐一另行核准（ci/approval.mjs destructive：Release_Approver 且非該遷移作者，Req 12.6）
//   → `git ls-remote` 確認 Release_Tag 仍指向核准畫面的 Commit SHA（Req 19.8）
// input 只有 submitterParameter，沒有任何參數或選項可以略過或放寬 Release_Gate（Req 23.4）；
// 逾時與拒絕使建置成為 ABORTED，等待期間不對 Production 做任何變更（只讀取 `lm-deploy prod status`）。
void runApprovalStage() {
  enterStage('Approval')
  env.LM_APR_ELIGIBLE = 'false'
  env.LM_APR_GATE_DONE = 'false'
  env.LM_APPROVED = 'false'
  env.LM_TAG_REMOTE_COMMIT = ''
  // Pipeline script binding 變數（與 lmScanErrors 相同方式）：不生效的嘗試、已核准與待核准的破壞性遷移。
  lmApprovalAttempts = []
  lmDestructiveApprovals = []
  lmDestructivePending = []
  aprStep('')

  requireReleaseGatesPassed()
  if (env.LM_REL_VERSION_TAG != 'true') {
    error('Release_Tag 版本標籤未完成，不進入核准')
  }
  env.LM_APR_ELIGIBLE = 'true'

  aprStep('核准前置作業失敗（Release_Approver 清單、Production 狀態或破壞性遷移判定）')
  assertProductionConfig()
  prepareReleaseWork()
  prepareApproval()
  aprStep('')
  waitForApproval()
}

// Production 部署、觀察期與「上線後」關卡（Req 14.1–14.3、17.7、17.8、20.1–20.7、20.9、20.11、20.12、22.5、23.1）：
//   lock(resource: 'lm-prod', skipIfLocked: true)：取不到即以「已有部署進行中」失敗（Req 20.12）
//   → 再次確認 Tag 未變更、Production 目前版本與核准時相同（破壞性遷移判定的基準）→ `cosign verify`
//   → SSH 受限金鑰 `lm-deploy prod deploy <digest> --app-env-stdin`：備份並驗證 → app.env → Migration_Runner
//     → 閒置槽位啟動 → 120 秒內每 5 秒 Health_Check、連續 3 次成功 → 切換（grace 30 秒）（Req 14.1–14.3、20.2–20.4）
//   → 10 分鐘觀察期：每 10 秒 `health`（共 60 次）、切換後與結束前各一次 Smoke_Test，每筆以 shouldRollback 判定
//   → 通過：finalize（停止舊槽位、記錄目前版本、保留 3 個映像，Req 20.7）；未通過：`lm-deploy prod rollback`
//     （切回舊槽位、停止新槽位、不執行 Migration_Runner）→ 舊槽位 `health --wait`（Req 20.6、20.9、20.11）
// 判讀邏輯在 ci/production.mjs；回滾原因與前後 digest 顯示於建置摘要（Req 22.5）。
void runProductionDeployStage() {
  enterStage('Production Deploy')
  env.LM_PRD_ELIGIBLE = 'false'
  env.LM_PRD_GATE_DONE = 'false'
  env.LM_PRD_SIGNATURE = 'not_run'
  env.LM_PRD_FINALIZE = 'not_run'
  env.LM_PRD_DEPLOY_CALLED = 'false'
  env.LM_PRD_OBSERVED = 'false'
  env.LM_PRD_RESTORE_DONE = 'false'
  prdStep('')

  // 「正式核准」未通過時不部署也不評估「上線後」（Req 19.1、23.2）。
  requireApprovalPassed()
  env.LM_PRD_ELIGIBLE = 'true'

  prdStep('Production 部署設定無效或 cosign 映像無法拉取')
  assertProductionConfig()
  pullImages([env.LM_COSIGN_IMAGE])
  prepareReleaseWork()
  sh(label: 'reports/production', script: 'mkdir -p reports/production')

  prdStep('')
  boolean acquired = false
  lock(resource: 'lm-prod', skipIfLocked: true) {
    acquired = true
    try {
      deployProduction()
    } catch (err) {
      // 未預期的錯誤或中止：切換後、觀察期未通過前仍持有鎖時先回滾，再讓階段失敗（Req 20.6）。
      if (env.LM_PRD_DEPLOY_CALLED == 'true' && env.LM_PRD_OBSERVED != 'true' && env.LM_PRD_RESTORE_DONE != 'true') {
        restoreProduction()
      }
      throw err
    }
  }
  if (!acquired) {
    recordProductionGate('已有部署進行中（lm-prod 已被鎖定），未變更 Production')
    error('已有部署進行中（lm-prod 已被鎖定），拒絕部署；Production 目前版本與 reverse proxy 設定未變更（Req 20.12）')
  }
}

// 收尾（Req 2.6、15.4、21.2、21.6、21.9、21.11、22.2–22.4、22.7、22.8、23.1；Design §9、§16、Error Handling）。
// 所有階段（含各階段自己的 post）結束後依序執行；每一步以 postStep（catchError）隔離：任一步失敗只會讓建置結果
// 變差（SUCCESS → FAILURE；FAILURE／ABORTED 不會被覆蓋），且不會略過後續步驟。
//   1. Build_Record finalize：最終結果、結束時間、結果非 SUCCESS 時第一個失敗或中止的階段（LM_CURRENT_STAGE）
//   2. 封存前遮罩：重新取得本建置用過的憑證 + 各階段 Ephemeral_Database 的秘密 → ci/scrub.mjs 處理 reports/
//      全部檔案至暫存目錄（仍有命中者只輸出 .withheld.txt 說明檔並使建置失敗）→ archiveArtifacts 遮罩後的副本
//      （Build_Record fingerprint；image-digest.txt 已於產生時封存並 fingerprint，不重複封存）
//   3. keepLog：Release_Tag 建置的 Image_Digest 已在 Production 執行時，以 Jenkins API 保留本建置與產生該 digest 的 main 建置
//   4. 依 label lm.ci.build=$BUILD_TAG 移除本建置的容器、網路與卷（只移除本建置的資源）
//   5. notifyAll 最終狀態（GitHub commit status 與建置摘要；永不拋出例外、不改變結果）
// cleanup（最後執行）：刪除收尾暫存目錄、cleanWs() 與 $WORKSPACE_TMP。
void pipelinePostAlways() {
  env.LM_POST_RESULT_BEFORE = currentBuild.currentResult
  Map outcome = finalOutcome(currentBuild.currentResult, env.LM_CURRENT_STAGE ?: '', '')
  postStep('Post Finalize') { finalizeBuildRecord(outcome) }
  postStep('Post Archive') { archiveScrubbedReports(outcome) }
  postStep('Post Keep Log') { keepProductionBuildLog() }
  postStep('Post Cleanup') { cleanupBuildResources() }
  notifyFinal()
}

void pipelinePostCleanup() {
  postStep('Post Cleanup') { removePostWork() }
  catchError(buildResult: 'FAILURE', message: '無法刪除工作目錄') {
    cleanWs(deleteDirs: true, disableDeferredWipeout: true)
  }
  catchError(buildResult: 'FAILURE', message: '無法刪除 WORKSPACE_TMP') {
    if (env.WORKSPACE_TMP) {
      dir(env.WORKSPACE_TMP) { deleteDir() }
    }
  }
}

// ------------------------------------------------------------------ 輔助函式

/** 唯一建立 JsonSlurperClassic 的地方（Components 第 23 節）。回傳 Map／List／String／Number／Boolean／null（皆可序列化）；
 *  null、空字串或無效 JSON 時丟出例外，由呼叫端處理。 */
@NonCPS
Object parseJsonText(String text) {
  return new JsonSlurperClassic().parseText(text)
}

/**
 * 記錄目前執行中的階段名稱（與 ci/stages.mjs 的 STAGE 一致），供收尾計算第一個失敗階段；
 * 已進入的階段另累積於 LM_STAGES_ENTERED，收尾只重新取得這些階段用過的憑證以遮罩封存檔（scrubCredentialSpecs）。
 */
void enterStage(String name) {
  env.LM_CURRENT_STAGE = name
  env.LM_STAGES_ENTERED = env.LM_STAGES_ENTERED ? "${env.LM_STAGES_ENTERED}|${name}".toString() : name
}

/** 本次規劃（ci/stages.mjs）是否包含指定階段。 */
boolean planned(String stage) {
  return ('|' + (env.LM_STAGES ?: '') + '|').contains('|' + stage + '|')
}

/** 在 Build_Image 容器內執行；HOME 與 Bun 快取放在本建置的暫存目錄，建置結束隨工作目錄清除。 */
def inBuildImage(Closure body) {
  buildImageContainer('', body)
}

/**
 * 在 Build_Image 容器內執行，且容器只連接本階段 Ephemeral_Database 的 `--internal` 網路（Req 4.8）：
 * 測試容器以容器名稱連線資料庫，資料庫不發布任何連接埠，也無法由 Agent 主機、LAN 或其他建置連線。
 */
def inBuildImageOn(String network, Closure body) {
  if (!(network ==~ /^lm-edb-(unit|e2e|compat|dast)-[0-9a-f]{16}-net$/)) {
    error('Ephemeral_Database 網路名稱無效')
  }
  buildImageContainer("--network ${network}", body)
}

def buildImageContainer(String args, Closure body) {
  docker.image(env.BUILD_IMAGE).inside(args) {
    withEnv(["HOME=${env.WORKSPACE_TMP}/home", "BUN_INSTALL_CACHE_DIR=${env.WORKSPACE_TMP}/bun-cache", 'CI=1']) {
      body()
    }
  }
}

// ------------------------------------------------------------------ Ephemeral_Database 與「QA」關卡

/**
 * 測試環境變數（Req 3.8、4.1、4.3）：只有本階段 Ephemeral_Database 的連線設定，不含任何 Staging／Production
 * 的 CAMPING_DATABASE_*。密碼不經 Groovy 或環境變數傳遞，由各 sh 腳本在 `set +x` 後自 0600 檔載入。
 */
List testEnv() {
  return [
    "CAMPING_TEST_DATABASE_HOST=${env.LM_EDB_HOST}",
    'CAMPING_TEST_DATABASE_PORT=5432',
    "CAMPING_TEST_DATABASE_NAME=${env.LM_EDB_NAME}",
    "CAMPING_TEST_DATABASE_USER=${env.LM_EDB_USER}",
    'CAMPING_TEST_DATABASE_SSLMODE=disable',
    'CHROME_PATH=/usr/local/bin/chromium',
    'CAMPING_BUN=/usr/local/bin/bun',
  ]
}

/** 記錄目前步驟失敗時寫入「QA」關卡的原因（固定訊息，不含憑證值）。 */
void qaStep(String reason) {
  env.LM_QA_STAGE_ERROR = reason
}

String qaStageError(String stage) {
  return env.LM_QA_STAGE_ERROR ?: "${stage} 階段執行失敗或已中止"
}

List qaJunitReports() {
  return ['reports/unit-junit.xml', 'reports/e2e-junit.xml']
}

/** 只保留實際存在的報告；不存在者由 finalizeRecord 標示「未執行」（Req 21.2）。 */
Map existingReports(Map candidates) {
  Map out = [:]
  candidates.each { key, path ->
    if (fileExists(path)) { out[key] = path }
  }
  return out
}

Map browserReports() {
  return existingReports([
    e2eJunit: 'reports/e2e-junit.xml',
    e2eJson: 'reports/e2e.json',
    qaInventory: 'reports/qa-inventory.json',
    qaInventoryValidation: 'reports/qa-inventory-validate.json',
    serverLog: 'reports/server.log',
    verifyEnv: 'reports/verify-env.json',
  ])
}

/** CHROME_PATH／CAMPING_BUN 必須存在且可執行（Req 3.9）；結果只含變數名稱與原因，寫入 reports/verify-env.json。 */
void verifyTestEnv() {
  qaStep('CHROME_PATH 或 CAMPING_BUN 無效（有問題的變數名稱見 reports/verify-env.json）')
  int rc = sh(label: 'ci/verify-env.mjs', returnStatus: true, script: 'bun ci/verify-env.mjs --out reports/verify-env.json')
  if (rc != 0) {
    error('CHROME_PATH 或 CAMPING_BUN 未設定、不存在或不可執行（見 reports/verify-env.json），不執行測試')
  }
}

/**
 * 以建置標籤啟動本階段專用的 Ephemeral_Database（Req 4.2、4.6、4.8）：
 *   * `docker network create --internal` 網路；PostgreSQL 容器不發布任何連接埠，PGDATA 為 tmpfs（不建立卷）。
 *   * 容器與網路帶 `lm.ci.edb=<run>` 與 `lm.ci.build=$BUILD_TAG` label，供 post 與 13.8 的收尾清除。
 *   * 密碼每次由 /dev/urandom 產生，只寫入 $WORKSPACE_TMP 下 0700 目錄的 0600 檔（docker 以 --env-file 讀取，
 *     不出現在命令列、Groovy 變數或主控台），階段 cleanup 時刪除。
 *   * 自開始起 120 秒內（含拉取映像）未就緒即失敗，不執行任何測試。
 * 需在 Agent 上執行（不在 Build_Image 容器內）。
 */
void startEphemeralDb(String purpose) {
  if (!(purpose ==~ /^(unit|e2e|compat|dast)$/)) { error('Ephemeral_Database 用途無效') }
  qaStep('Ephemeral_Database 未於 120 秒內就緒或無法建立')
  String suffix = sh(label: 'Ephemeral_Database id', returnStdout: true, script: 'od -An -N8 -tx1 /dev/urandom | tr -d " \\n"').trim()
  if (!(suffix ==~ /^[0-9a-f]{16}$/)) { error('無法產生 Ephemeral_Database 識別碼') }
  // 先設定名稱，讓 post 即使在建立途中失敗也能依 label 清除。
  String run = "lm-edb-${purpose}-${suffix}"
  env.LM_EDB_RUN = run
  env.LM_EDB_NET = "${run}-net"
  env.LM_EDB_HOST = "${run}-db"
  env.LM_EDB_DIR = "${env.WORKSPACE_TMP}/${run}"
  int rc
  // 外層保護：docker CLI 卡住時仍於時限內失敗；腳本本身自開始起 120 秒未就緒即以結束碼 3 結束。
  timeout(time: 150, unit: 'SECONDS') {
    rc = sh(label: 'start Ephemeral_Database', returnStatus: true, script: '''
      set +x
      set -eu
      deadline=$(( $(date +%s) + 120 ))
      digest="${LM_POSTGRES_IMAGE##*@sha256:}"
      if [ "$digest" = "$LM_POSTGRES_IMAGE" ] || ! printf '%s' "$digest" | grep -Eq '^[0-9a-f]{64}$'; then
        echo "LM_POSTGRES_IMAGE 必須以 @sha256:<64 hex> 固定；請以實際 digest 取代 Jenkinsfile 中的 PLACEHOLDER" >&2
        exit 2
      fi
      umask 077
      rm -rf "$LM_EDB_DIR"
      mkdir -m 0700 "$LM_EDB_DIR"
      pw="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \\n')"
      [ "${#pw}" -eq 48 ] || { echo "無法產生 Ephemeral_Database 密碼" >&2; exit 4; }
      printf 'POSTGRES_PASSWORD=%s\\n' "$pw" > "$LM_EDB_DIR/db.env"
      printf 'CAMPING_TEST_DATABASE_PASSWORD=%s\\n' "$pw" > "$LM_EDB_DIR/client.env"
      printf '{"lm-ephemeral-db":"%s"}\\n' "$pw" > "$LM_EDB_DIR/scrub-secrets.json"
      unset pw
      docker network create --internal \
        --label "lm.ci.edb=$LM_EDB_RUN" --label "lm.ci.build=$BUILD_TAG" \
        "$LM_EDB_NET" > /dev/null || exit 4
      docker run -d --name "$LM_EDB_HOST" --network "$LM_EDB_NET" \
        --label "lm.ci.edb=$LM_EDB_RUN" --label "lm.ci.build=$BUILD_TAG" \
        --security-opt no-new-privileges:true \
        --env-file "$LM_EDB_DIR/db.env" \
        -e "POSTGRES_USER=$LM_EDB_USER" -e "POSTGRES_DB=$LM_EDB_NAME" \
        -e POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 \
        -e PGDATA=/var/lib/postgresql/data/pgdata \
        --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=1g \
        --shm-size 256m \
        "$LM_POSTGRES_IMAGE" > /dev/null || exit 4
      # 以 TCP 檢查：entrypoint 初始化期間的暫時伺服器不監聽 TCP，成功即代表正式啟動完成。
      until docker exec "$LM_EDB_HOST" pg_isready -q -h 127.0.0.1 -p 5432 -U "$LM_EDB_USER" -d "$LM_EDB_NAME" > /dev/null 2>&1; do
        running="$(docker inspect -f '{{.State.Running}}' "$LM_EDB_HOST" 2>/dev/null || echo false)"
        if [ "$running" != "true" ]; then
          echo "Ephemeral_Database 容器已停止" >&2
          exit 3
        fi
        if [ "$(date +%s)" -ge "$deadline" ]; then
          echo "Ephemeral_Database 未於 120 秒內就緒" >&2
          exit 3
        fi
        sleep 2
      done
      echo "Ephemeral_Database $LM_EDB_RUN 就緒"
    ''')
  }
  if (rc == 2) {
    error('LM_POSTGRES_IMAGE 未以 @sha256: digest 固定，不建立 Ephemeral_Database')
  } else if (rc == 3) {
    error('Ephemeral_Database 未於 120 秒內就緒，不執行測試')
  } else if (rc != 0) {
    error('無法建立 Ephemeral_Database，不執行測試')
  }
  qaStep('')
}

/**
 * 依 label 移除本階段的 Ephemeral_Database 容器（含 tmpfs 資料）與網路，120 秒內完成（Req 4.2、4.7）。
 * 失敗時將建置標記為失敗但不中斷其餘 post 處理。可重複呼叫。需在 Agent 上執行。
 */
void destroyEphemeralDb() {
  if (!env.LM_EDB_RUN) { return }
  catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
    timeout(time: 120, unit: 'SECONDS') {
      sh(label: 'destroy Ephemeral_Database', script: '''
        set +x
        set -u
        for id in $(docker ps -aq --filter "label=lm.ci.edb=$LM_EDB_RUN" 2>/dev/null); do
          docker rm -fv "$id" > /dev/null 2>&1 || true
        done
        if docker network inspect "$LM_EDB_NET" > /dev/null 2>&1; then
          for c in $(docker network inspect -f '{{range $k, $v := .Containers}}{{$k}} {{end}}' "$LM_EDB_NET" 2>/dev/null); do
            docker network disconnect -f "$LM_EDB_NET" "$c" > /dev/null 2>&1 || true
          done
          docker network rm "$LM_EDB_NET" > /dev/null 2>&1 || true
        fi
        left="$(docker ps -aq --filter "label=lm.ci.edb=$LM_EDB_RUN" 2>/dev/null)"
        if [ -n "$left" ] || docker network inspect "$LM_EDB_NET" > /dev/null 2>&1; then
          echo "無法銷毀 Ephemeral_Database $LM_EDB_RUN" >&2
          exit 1
        fi
        echo "Ephemeral_Database $LM_EDB_RUN 已銷毀"
      ''')
    }
    env.LM_EDB_RUN = ''
  }
}

/**
 * 刪除 Ephemeral_Database 密碼檔（失敗證據遮罩完成後才執行）。刪除前將本階段的 scrub-secrets.json 以 0600 複製到
 * 建置層級的 $WORKSPACE_TMP/lm-scrub-secrets（0700），供收尾 post { always } 遮罩所有待封存檔案（Req 15.4、21.9）；
 * 該目錄於收尾遮罩完成後與 post { cleanup } 刪除。
 */
void removeEphemeralDbSecrets() {
  if (!env.LM_EDB_DIR) { return }
  int rc = sh(label: 'remove Ephemeral_Database secrets', returnStatus: true, script: '''
    set +x
    set -u
    umask 077
    rc=0
    case "$LM_EDB_DIR" in
      "$WORKSPACE_TMP"/lm-edb-*)
        if [ -f "$LM_EDB_DIR/scrub-secrets.json" ]; then
          # 複製失敗時收尾無法遮罩本階段的秘密：仍刪除密碼檔，但使建置失敗（fail closed）。
          { mkdir -p -m 0700 "$WORKSPACE_TMP/lm-scrub-secrets" \
            && cp "$LM_EDB_DIR/scrub-secrets.json" "$WORKSPACE_TMP/lm-scrub-secrets/${LM_EDB_DIR##*/}.json"; } || rc=1
        fi
        rm -rf -- "$LM_EDB_DIR"
        ;;
    esac
    [ "$rc" -eq 0 ] || echo "無法保存 Ephemeral_Database 的遮罩用秘密，收尾將無法完整遮罩封存檔" >&2
    exit "$rc"
  ''')
  env.LM_EDB_DIR = ''
  if (rc != 0) {
    // 收尾 archiveScrubbedReports 見到此旗標即不封存任何報告（秘密集合不完整，fail closed）。
    env.LM_SCRUB_INCOMPLETE = 'true'
    error('無法保存 Ephemeral_Database 的遮罩用秘密；收尾不會封存任何報告')
  }
}

/**
 * 將報告路徑合併至 Build_Record（Req 4.5、5.4、21.2），並視需要以 ci/gates.mjs 評估「QA」關卡後記錄
 * 名稱、結果、評估時間與 Commit SHA（Req 23.1、23.5）。需在 Build_Image 容器內呼叫。
 * 參數皆為 Jenkinsfile 內的固定路徑與訊息，經環境變數傳給 sh。回傳關卡結束碼（未評估時為 0）。
 *   patch: patch 檔路徑；reports: [報告鍵: 路徑]；gate: 是否評估關卡；junit: JUnit 路徑清單；
 *   inventory: QA_Inventory 比對結果路徑或 ''；stageError: 檢查階段失敗原因或 ''（非空即未通過，Req 23.3）
 */
int recordQa(Map args) {
  Map reports = args.reports ?: [:]
  if (!reports.isEmpty()) {
    writeFile(file: args.patch, text: JsonOutput.toJson([reports: reports]))
    withEnv(["LM_RECORD_PATCH=${args.patch}"]) {
      sh(label: 'Build_Record reports', script: 'bun ci/record.mjs merge --record "$LM_RECORD" --patch "$LM_RECORD_PATCH"')
    }
  }
  if (!args.gate) { return 0 }
  int rc
  withEnv([
    "LM_GATE_JUNIT=${(args.junit ?: []).join(' ')}",
    "LM_GATE_INVENTORY=${args.inventory ?: ''}",
    "LM_GATE_STAGE_ERROR=${args.stageError ?: ''}",
  ]) {
    rc = sh(label: 'Release_Gate QA', returnStatus: true, script: '''
      set -eu
      set --
      if [ -n "${LM_GATE_INVENTORY:-}" ]; then set -- "$@" --inventory "${LM_GATE_INVENTORY:-}"; fi
      if [ -n "${LM_GATE_STAGE_ERROR:-}" ]; then set -- "$@" --stage-error "${LM_GATE_STAGE_ERROR:-}"; fi
      rm -f reports/gate-qa.json
      rc=0
      bun ci/gates.mjs junit --gate QA --commit "$GIT_COMMIT_FULL" --out reports/gate-qa.json "$@" ${LM_GATE_JUNIT:-} > /dev/null || rc=$?
      bun ci/record.mjs gate --record "$LM_RECORD" --result reports/gate-qa.json
      exit "$rc"
    ''')
  }
  if (rc == 0 || rc == 1) {
    env.LM_QA_GATE_RECORDED = 'true'
  }
  return rc
}

/**
 * 瀏覽器測試失敗證據（Req 5.6）：test-results/ 下的截圖與 trace（目錄名含測試標題中的 TC ID 與 project
 * desktop／mobile）、reports/server.log 與 reports/e2e.json，經 ci/scrub.mjs 遮罩 Ephemeral_Database 密碼
 * 後寫入 reports/evidence/browser/ 並封存。遮罩後仍偵測到秘密的檔案只封存說明檔。不改變原本的失敗原因。
 */
void archiveBrowserEvidence() {
  catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
    inBuildImage {
      sh(label: 'scrub browser evidence', script: '''
        set +x
        set -u
        src="$WORKSPACE_TMP/lm-browser-evidence"
        rm -rf "$src" reports/evidence/browser
        mkdir -p "$src" reports/evidence/browser
        [ -d test-results ] && cp -R test-results "$src/test-results"
        [ -f reports/server.log ] && cp reports/server.log "$src/server.log"
        [ -f reports/e2e.json ] && cp reports/e2e.json "$src/e2e.json"
        rc=0
        if [ -n "${LM_EDB_DIR:-}" ] && [ -f "$LM_EDB_DIR/scrub-secrets.json" ]; then
          bun ci/scrub.mjs --secrets "$LM_EDB_DIR/scrub-secrets.json" --in "$src" --out reports/evidence/browser \
            --report reports/evidence/browser-scrub.json || rc=$?
        else
          # 資料庫未建立即失敗：沒有本階段的秘密，證據原樣保存。
          cp -R "$src/." reports/evidence/browser/
        fi
        rm -rf "$src"
        exit "$rc"
      ''')
    }
  }
  archiveArtifacts(artifacts: 'reports/evidence/browser/**, reports/evidence/browser-scrub.json', allowEmptyArchive: true)
}

// ------------------------------------------------------------------ 靜態安全掃描與「安全」關卡

/** 記錄目前步驟失敗時寫入「安全」關卡的原因（固定訊息，不含秘密值）。 */
void secStep(String reason) {
  env.LM_SECURITY_STAGE_ERROR = reason
}

String secStageError() {
  return env.LM_SECURITY_STAGE_ERROR ?: 'Security Scan 階段執行失敗或已中止'
}

/**
 * 掃描器映像必須與 Build_Image 位於同一 LAN Registry 並以 @sha256: digest 固定；Trivy 資料庫鏡像同樣須在該 Registry。
 * 回傳待拉取的映像引用。
 */
List scannerImages() {
  String registry = env.BUILD_IMAGE.substring(0, env.BUILD_IMAGE.indexOf('/'))
  List refs = [env.LM_GITLEAKS_IMAGE, env.LM_OSV_SCANNER_IMAGE, env.LM_TRIVY_IMAGE, env.LM_SEMGREP_IMAGE]
  for (Object ref in refs) {
    String s = ref ? ref.toString() : ''
    if (!isPinnedImage(s) || !s.startsWith(registry + '/')) {
      error('掃描器映像必須以 <LAN Registry>/<repo>@sha256:<64 hex> 引用；請以實際 digest 取代 Jenkinsfile 中的 PLACEHOLDER')
    }
  }
  String db = env.LM_TRIVY_DB_REPOSITORY ?: ''
  if (!(db ==~ /^[a-z0-9][a-z0-9.\-]*(:[0-9]+)?\/[a-z0-9][a-z0-9._\/\-]*:[A-Za-z0-9._\-]+$/) || !db.startsWith(registry + '/')) {
    error('LM_TRIVY_DB_REPOSITORY 必須是 LAN Registry 內的 <repo>:<tag>')
  }
  return refs
}

/**
 * 準備掃描輸入（在 Agent 上執行，Req 6.1）：
 *   * tree/：以暫存 index 取出建置 commit 的所有受版本控制檔案（不套用 export-ignore、不含 node_modules 等未追蹤檔案）。
 *     repo 內的掃描器設定與忽略檔（.gitleaks.toml、.gitleaksignore、osv-scanner.toml、.semgrepignore、.trivyignore 等）
 *     自掃描輸入移除，PR 無法以此略過結果；例外只能經 security/exceptions.json（Req 6.5、6.9）。
 *   * history.git：只含建置 commit 可達物件的 bare repository（沒有工作樹，repo 內的 Gitleaks 設定不生效）。
 *   * Git 歷史範圍（LM_GITLEAKS_LOG_OPTS）：
 *       Untrusted_PR → `<merge-base origin/$CHANGE_TARGET HEAD>..<sha>`；無法取得 merge base 時歷史掃描視為未完成。
 *       其他建置    → `$GIT_PREVIOUS_SUCCESSFUL_COMMIT..<sha>`（須為 40 hex、存在且為建置 commit 的祖先），否則完整歷史 `<sha>`。
 *     所有 SHA 與 ref 名稱先以正規表示式驗證，只經環境變數傳給 sh。
 */
void prepareScanSources() {
  secStep('無法準備掃描來源（受版本控制檔案或 Git 歷史）')
  String suffix = sh(label: 'security scan id', returnStdout: true, script: 'od -An -N8 -tx1 /dev/urandom | tr -d " \\n"').trim()
  if (!(suffix ==~ /^[0-9a-f]{16}$/)) { error('無法產生安全掃描識別碼') }
  env.LM_SCAN_RUN = "lm-scan-${suffix}"
  env.LM_SCAN_DIR = "${env.WORKSPACE_TMP}/${env.LM_SCAN_RUN}"

  // 例外到期日以 Build_Agent 當下的本地日期判定（Req 6.6）。
  String today = sh(label: 'scan date', returnStdout: true, script: 'date +%F').trim()
  if (!(today ==~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)) { error('無法取得掃描日期') }
  env.LM_SCAN_TODAY = today

  boolean pr = env.LM_TRIGGER_KIND == 'pull_request'
  String target = pr ? (env.CHANGE_TARGET ?: '') : ''
  if (pr && !validBranchName(target)) {
    error('CHANGE_TARGET 無效，無法決定 PR 的 merge base')
  }

  withCredentials([gitUsernamePassword(credentialsId: env.LM_GIT_CREDENTIALS)]) {
    withEnv(["LM_SCAN_FETCH_TARGET=${target}"]) {
      sh(label: 'fetch history for Gitleaks', script: '''
        set -eu
        if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
          git fetch --unshallow --no-tags --quiet origin
        fi
        if [ -n "${LM_SCAN_FETCH_TARGET:-}" ]; then
          git fetch --no-tags --quiet origin "+refs/heads/${LM_SCAN_FETCH_TARGET:-}:refs/remotes/origin/${LM_SCAN_FETCH_TARGET:-}"
        fi
      ''')
    }
  }

  String range
  withEnv(["LM_SCAN_BASE_REF=${pr ? 'refs/remotes/origin/' + target : ''}"]) {
    range = sh(label: 'Gitleaks history range', returnStdout: true, script: '''
      set -u
      head="$GIT_COMMIT_FULL"
      if [ -n "${LM_SCAN_BASE_REF:-}" ]; then
        base="$(git merge-base "${LM_SCAN_BASE_REF:-}" "$head" 2>/dev/null)" || exit 0
        printf '%s..%s\\n' "$base" "$head"
        exit 0
      fi
      prev="${GIT_PREVIOUS_SUCCESSFUL_COMMIT:-}"
      if printf '%s\\n' "$prev" | grep -Eqx '[0-9a-f]{40}' \
        && git cat-file -e "$prev^{commit}" 2>/dev/null \
        && git merge-base --is-ancestor "$prev" "$head" 2>/dev/null; then
        printf '%s..%s\\n' "$prev" "$head"
      else
        printf '%s\\n' "$head"
      fi
    ''').trim()
  }
  String sha = env.GIT_COMMIT_FULL
  boolean rangeOk = pr ? (range ==~ /^[0-9a-f]{40}\.\.[0-9a-f]{40}$/) : (range ==~ /^([0-9a-f]{40}\.\.)?[0-9a-f]{40}$/)
  if (rangeOk && range.endsWith(sha)) {
    env.LM_GITLEAKS_LOG_OPTS = range
    echo "Gitleaks Git 歷史範圍：${range}"
  } else {
    env.LM_GITLEAKS_LOG_OPTS = ''
    lmScanErrors << (pr ? 'Gitleaks（Git 歷史）無法取得 PR 與目標分支的 merge base，歷史掃描未完成' : 'Gitleaks（Git 歷史）無法決定掃描範圍，歷史掃描未完成')
  }

  sh(label: 'export scan sources', script: '''
    set -eu
    rm -rf "$LM_SCAN_DIR" reports/security
    mkdir -p "$LM_SCAN_DIR/tree" "$LM_SCAN_DIR/out" reports/security
    GIT_INDEX_FILE="$LM_SCAN_DIR/index" git read-tree "$GIT_COMMIT_FULL"
    GIT_INDEX_FILE="$LM_SCAN_DIR/index" git checkout-index --all --force --prefix="$LM_SCAN_DIR/tree/"
    rm -f "$LM_SCAN_DIR/index"
    for f in .gitleaks.toml .gitleaksignore osv-scanner.toml .semgrepignore .trivyignore .trivyignore.yaml trivy.yaml; do
      rm -f "$LM_SCAN_DIR/tree/$f"
    done
    git init -q --bare "$LM_SCAN_DIR/history.git"
    git update-ref refs/lm-scan/head "$GIT_COMMIT_FULL"
    git -C "$LM_SCAN_DIR/history.git" fetch -q --no-tags "$WORKSPACE" +refs/lm-scan/head:refs/heads/scan
    git update-ref -d refs/lm-scan/head
  ''')
}

/** Git 分支名稱（CHANGE_TARGET）：與 ci/stages.mjs 相同的字元限制，且不含 `..`、不以 `/` 或 `.lock` 結尾。 */
boolean validBranchName(String name) {
  return (name ==~ /^[A-Za-z0-9][A-Za-z0-9._\/\-]{0,254}$/) && !name.contains('..') && !name.endsWith('/') && !name.endsWith('.lock')
}

/** 各掃描工具版本（Req 6.7），寫入 $LM_SCAN_DIR/out/<tool>.version；取不到時報告的 toolVersion 為 null。 */
void scannerVersions() {
  sh(label: 'scanner versions', script: '''
    set -u
    v() {
      tool="$1"
      shift
      timeout --kill-after=10 60 docker run --rm --name "$LM_SCAN_RUN-version-$tool" --label "lm.ci.build=$BUILD_TAG" --label "lm.ci.scan=$LM_SCAN_RUN" --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m -e HOME=/tmp --security-opt no-new-privileges:true --cap-drop ALL --network none "$@" 2>/dev/null \
        | grep -Eo '[0-9]+[.][0-9]+[.][0-9]+[0-9A-Za-z.+-]*' | head -n 1 > "$LM_SCAN_DIR/out/$tool.version" || true
    }
    v gitleaks "$LM_GITLEAKS_IMAGE" version
    v osv-scanner "$LM_OSV_SCANNER_IMAGE" --version
    v trivy "$LM_TRIVY_IMAGE" --version
    v semgrep --entrypoint semgrep "$LM_SEMGREP_IMAGE" --version
    exit 0
  ''')
}

/**
 * 執行一項掃描（Req 6.8）：腳本內以 `timeout 900` 限制 15 分鐘（逾時結束碼 124／137），外層 timeout 為保護。
 * 結束碼非 0 時刪除可能不完整的報告並移除本次掃描容器，normalize 因此產生 complete:false，該掃描不會被視為通過。
 * 外層逾時或中止時記錄原因後重新拋出，由 post 記錄「安全」關卡未通過。
 *   what：掃描名稱（固定訊息）；report：$LM_SCAN_DIR/out 下的報告檔名（固定）；script：單引號 sh 腳本
 */
void runScan(String what, String report, String script) {
  int rc = 0
  withEnv(["LM_SCAN_REPORT=${report}"]) {
    sh(label: 'reset scan report', script: 'rm -f "$LM_SCAN_DIR/out/$LM_SCAN_REPORT"')
    try {
      timeout(time: 17, unit: 'MINUTES') {
        rc = sh(label: what, returnStatus: true, script: script)
      }
    } catch (Exception e) {
      lmScanErrors << "${what}未在時限內結束或已中止".toString()
      discardScan()
      throw e
    }
    if (rc != 0) {
      discardScan()
      if (rc == 124 || rc == 137) {
        lmScanErrors << "${what}超過 15 分鐘或被終止，掃描未完成".toString()
      } else if (rc == 3) {
        lmScanErrors << "${what}缺少掃描輸入，掃描未完成".toString()
      } else {
        lmScanErrors << "${what}執行錯誤（結束碼 ${rc}），掃描未完成".toString()
      }
    }
  }
}

/** 刪除目前掃描的報告並移除本次掃描的所有容器。 */
void discardScan() {
  sh(label: 'discard incomplete scan', script: '''
    set -u
    rm -f "$LM_SCAN_DIR/out/$LM_SCAN_REPORT"
    for id in $(docker ps -aq --filter "label=lm.ci.scan=$LM_SCAN_RUN" 2>/dev/null); do
      docker rm -f "$id" > /dev/null 2>&1 || true
    done
  ''')
}

/**
 * 將掃描報告路徑寫入 Build_Record（Req 6.7、21.2），並記錄「安全」關卡（名稱、結果、評估時間、Commit SHA、
 * 未符合的條件；Req 23.1、23.3、23.5）。stageError 非空、任一掃描未完成或評估結果缺失時關卡未通過。
 * 回傳 0 通過、1 未通過。可在 Agent 上呼叫。
 */
int recordSecurityGate(String stageError) {
  Map reports = existingReports([
    gitleaks: 'reports/security/gitleaks-dir.json',
    gitleaksHistory: 'reports/security/gitleaks-git.json',
    osv: 'reports/security/osv.json',
    trivyNodeModules: 'reports/security/trivy-node-modules.json',
    semgrep: 'reports/security/semgrep.json',
    securityEvaluation: 'reports/security/evaluation.json',
  ])
  // lmScanErrors 於 Security Scan 階段一開始即設定（Pipeline script binding 變數，與 lmNotifier 相同方式）。
  List errors = lmScanErrors instanceof List ? (List) lmScanErrors : []
  int rc = writeSecurityGate(reports, 'reports/security/evaluation.json', errors, stageError,
    'reports/gate-security.json', 'reports/security-record-patch.json')
  env.LM_SECURITY_GATE_RECORDED = 'true'
  return rc
}

/**
 * 含 DAST 的「安全」關卡（Req 7.8、7.11、10.11、23.2）：靜態掃描、ZAP 與安全測試套件的正規化報告一起由
 * ci/policy/evaluate.mjs 評估（reports/security/evaluation-dast.json）。DAST 報告、各類別測試結果、目標驗證與
 * 隔離探測結果的路徑寫入 Build_Record；被拒絕的目標與可連線的位址列於關卡的未符合條件（Req 7.3、7.9）。
 * 與 Security Scan 的關卡分開追加一筆（Build_Record 保留兩次評估）。回傳 0 通過、1 未通過。可在 Agent 上呼叫。
 */
int recordDastSecurityGate(String stageError) {
  Map reports = existingReports([
    zap: 'reports/dast/zap-report.json',
    zapNormalized: 'reports/security/zap.json',
    securitySuite: 'reports/security/security-suite.json',
    securitySuiteJunit: 'reports/security-junit.xml',
    dastTargets: 'reports/dast/targets.json',
    dastPlan: 'reports/dast/zap-plan.yaml',
    dastIsolation: 'reports/dast/isolation.json',
    securityEvaluationDast: 'reports/security/evaluation-dast.json',
  ])
  // lmDastErrors 於 DAST 階段一開始即設定（與 lmScanErrors 相同方式）。
  List errors = lmDastErrors instanceof List ? (List) lmDastErrors : []
  int rc = writeSecurityGate(reports, 'reports/security/evaluation-dast.json', errors, stageError,
    'reports/gate-security-dast.json', 'reports/security-dast-record-patch.json')
  env.LM_DAST_GATE_RECORDED = 'true'
  return rc
}

/**
 * 組成「安全」關卡結果並與報告路徑一起寫入 Build_Record（Req 23.1、23.3、23.5）。
 * 參數皆為 Jenkinsfile 內的固定路徑，經環境變數傳給 sh。寫入失敗即 error()。回傳 0 通過、1 未通過。
 */
int writeSecurityGate(Map reports, String evaluationPath, List errors, String stageError, String gateFile, String patchFile) {
  String evaluation = fileExists(evaluationPath) ? readFile(evaluationPath) : ''
  Map gate = securityGate(evaluation, errors, stageError ?: '', env.GIT_COMMIT_FULL ?: '', new ArrayList(reports.values()))
  writeFile(file: gateFile, text: JsonOutput.toJson(gate))
  writeFile(file: patchFile, text: JsonOutput.toJson([reports: reports]))
  int rc
  withEnv(["LM_SECURITY_GATE_FILE=${gateFile}", "LM_SECURITY_GATE_PATCH=${patchFile}"]) {
    inBuildImage {
      rc = sh(label: 'Release_Gate 安全', returnStatus: true, script: '''
        set -eu
        bun ci/record.mjs merge --record "$LM_RECORD" --patch "$LM_SECURITY_GATE_PATCH"
        bun ci/record.mjs gate --record "$LM_RECORD" --result "$LM_SECURITY_GATE_FILE"
      ''')
    }
  }
  if (rc != 0) {
    error('無法將「安全」關卡寫入 Build_Record')
  }
  return gate.pass == true ? 0 : 1
}

/**
 * 由 ci/policy/evaluate.mjs 的結果組成「安全」關卡結果（ci/record.mjs gate 的輸入）。
 * 只複製規則／漏洞 ID、掃描器、嚴重度、套件或路徑、行號與 commit SHA，不含任何掃描內容（Req 6.4）。
 */
@NonCPS
Map securityGate(String evaluationText, List scanErrors, String stageError, String commit, List reports) {
  List unmet = []
  boolean failedRun = false
  if (stageError) {
    unmet << gateText("檢查階段執行錯誤：${stageError}")
    failedRun = true
  }
  for (Object e : scanErrors) {
    unmet << gateText(e)
    failedRun = true
  }
  Map ev = null
  try {
    Object parsed = evaluationText ? parseJsonText(evaluationText) : null
    if (parsed instanceof Map && String.valueOf(parsed.commit) == commit && parsed.pass instanceof Boolean) {
      ev = (Map) parsed
    }
  } catch (Exception ignored) {
    ev = null
  }
  String status
  if (ev == null) {
    unmet << '安全政策評估結果（ci/policy/evaluate.mjs 的輸出）缺失或無法解析'
    status = failedRun ? 'error' : 'missing_report'
  } else {
    List incomplete = ev.incomplete instanceof List ? (List) ev.incomplete : []
    for (Object i : incomplete) {
      Map m = i instanceof Map ? (Map) i : [:]
      unmet << gateText("${m.scanner ?: m.file ?: '掃描'} 未完成：${m.reason ?: '掃描無法完成'}")
    }
    List unresolved = ev.unresolved instanceof List ? (List) ev.unresolved : []
    int shown = 0
    for (Object u : unresolved) {
      if (shown >= 50) { break }
      unmet << gateText(findingText(u instanceof Map ? (Map) u : [:]))
      shown++
    }
    if (unresolved.size() > 50) {
      unmet << "另有 ${unresolved.size() - 50} 筆未處理結果（見 reports/security/evaluation.json）".toString()
    }
    if (ev.pass != true && unmet.isEmpty()) {
      unmet << '安全政策評估未通過'
    }
    if (failedRun || !incomplete.isEmpty()) {
      status = 'error'
    } else {
      status = (ev.pass == true && unmet.isEmpty()) ? 'pass' : 'fail'
    }
  }
  Map out = [gate: '安全', pass: status == 'pass', status: status, commit: commit, unmet: unmet, reports: reports]
  if (ev != null && ev.evaluatedAt instanceof String) {
    out.evaluatedAt = ev.evaluatedAt
  }
  return out
}

@NonCPS
String findingText(Map f) {
  String reason = '未處理的 Critical/High 結果'
  if (f.reason == 'secret') {
    reason = '偵測到秘密'
  } else if (f.reason == 'exception-expired') {
    reason = 'Approved_Exception 已過期'
  }
  String where = String.valueOf(f.location ?: '?')
  if (f.version) { where += "@${f.version}" }
  if (f.line) { where += ":${f.line}" }
  String commitPart = ''
  if (f.commit instanceof String) {
    String c = (String) f.commit
    commitPart = "（commit ${c.length() > 12 ? c.substring(0, 12) : c}）"
  }
  return "${reason}：${f.scanner} ${f.id}（${f.effectiveSeverity ?: f.severity}）於 ${where}${commitPart}".toString()
}

/** 關卡訊息：移除控制字元並限制長度（ci/record.mjs 的字串限制）。 */
@NonCPS
String gateText(Object value) {
  String s = String.valueOf(value).replaceAll('[\\u0000-\\u001f\\u007f]', ' ')
  return s.length() > 300 ? s.substring(0, 300) : s
}

/** 移除本次掃描的容器、暫存目錄（含 Gitleaks 原始報告）與暫存 ref；可重複呼叫。需在 Agent 上執行。 */
void cleanupSecurityScan() {
  if (!env.LM_SCAN_RUN) { return }
  sh(label: 'cleanup security scan', script: '''
    set +x
    set -u
    for id in $(docker ps -aq --filter "label=lm.ci.scan=$LM_SCAN_RUN" 2>/dev/null); do
      docker rm -f "$id" > /dev/null 2>&1 || true
    done
    git update-ref -d refs/lm-scan/head > /dev/null 2>&1 || true
    case "$LM_SCAN_DIR" in
      "$WORKSPACE_TMP"/lm-scan-*) rm -rf -- "$LM_SCAN_DIR" ;;
    esac
  ''')
  env.LM_SCAN_RUN = ''
}

// ------------------------------------------------------------------ 遷移相容性與 DAST 共用

/** Release_Tag 格式（與 ci/policy/tag.mjs 的 RELEASE_TAG_RE 相同）。 */
boolean isReleaseTag(String tag) {
  return tag ==~ /^v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/
}

/** `git diff --name-only -- migrations/` 的輸出 → 遷移檔清單（只取 .sql）；含無效檔名時回傳 null。 */
@NonCPS
List migrationFiles(String text) {
  List out = []
  for (String line : (text ?: '').split('\n')) {
    String f = line.trim()
    if (!f || !f.endsWith('.sql')) { continue }
    if (!(f ==~ /^migrations\/[A-Za-z0-9][A-Za-z0-9._\-]{0,127}\.sql$/)) { return null }
    out << f
  }
  return out
}

void compatStep(String reason) {
  env.LM_COMPAT_STAGE_ERROR = reason
}

String compatStageError() {
  return env.LM_COMPAT_STAGE_ERROR ?: 'Migration Compatibility 階段執行失敗或已中止'
}

/**
 * 拉取最近 Release_Tag 的 App_Image（`<LM_IMAGE_REPO>:<tag>`，唯讀拉取帳號），並回傳其 `<LM_IMAGE_REPO>@sha256:<digest>`；
 * 之後只以 digest 執行。repository 必須位於 Build_Image 的 LAN Registry。需在 Agent 上執行。
 */
String pullReleaseImage(String tag) {
  String registry = env.BUILD_IMAGE.substring(0, env.BUILD_IMAGE.indexOf('/'))
  String repo = env.LM_IMAGE_REPO ?: ''
  if (!(repo ==~ /^[a-z0-9][a-z0-9.\-]*(:[0-9]+)?\/[a-z0-9][a-z0-9._\/\-]*$/) || !repo.startsWith(registry + '/')) {
    error('LM_IMAGE_REPO 必須是 Build_Image 所在 LAN Registry 內的 repository（不含 tag 或 digest）')
  }
  if (!isReleaseTag(tag)) { error('Release_Tag 格式無效') }
  String tagged = "${repo}:${tag}".toString()
  pullImages([tagged])
  String ref
  withEnv(["LM_PULLED_REF=${tagged}"]) {
    ref = sh(label: 'Release_Tag App_Image digest', returnStdout: true, script: '''
      set -eu
      docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$LM_PULLED_REF" \
        | awk -v p="$LM_IMAGE_REPO@sha256:" 'index($0, p) == 1 { print; exit }'
    ''').trim()
  }
  if (!isPinnedImage(ref) || !ref.startsWith(repo + '@sha256:')) {
    error('無法取得最近 Release_Tag App_Image 的 digest')
  }
  echo "最近 Release_Tag 的 App_Image：${ref}"
  return ref
}

/**
 * 在 startEphemeralDb 的 0700 目錄內產生 App 容器與測試輔助腳本所需的秘密檔（0600，docker 以 --env-file 讀取、
 * 測試腳本在 `set +x` 後載入）：app.env（Ephemeral_Database 密碼）、setup.env（Setup_Token，48 字元）、
 * seed.env／smoke.env（合成帳號密碼）。scrub-secrets.json 同步加入新秘密，供失敗證據遮罩。需在 Agent 上執行。
 */
void writeAppSecrets() {
  sh(label: 'Test_Environment secrets', script: '''
    set +x
    set -eu
    umask 077
    set -a
    . "$LM_EDB_DIR/client.env"
    set +a
    token="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \\n')"
    smoke="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \\n')"
    if [ "${#token}" -ne 48 ] || [ "${#smoke}" -ne 48 ]; then
      echo "無法產生 Test_Environment 秘密" >&2
      exit 4
    fi
    printf 'CAMPING_DATABASE_PASSWORD=%s\\n' "$CAMPING_TEST_DATABASE_PASSWORD" > "$LM_EDB_DIR/app.env"
    printf 'CAMPING_SETUP_TOKEN=%s\\n' "$token" > "$LM_EDB_DIR/setup.env"
    printf 'CAMPING_SMOKE_PASSWORD=%s\\nCAMPING_SETUP_TOKEN=%s\\n' "$smoke" "$token" > "$LM_EDB_DIR/seed.env"
    printf 'CAMPING_SMOKE_PASSWORD=%s\\n' "$smoke" > "$LM_EDB_DIR/smoke.env"
    printf '{"lm-ephemeral-db":"%s","lm-setup-token":"%s","lm-smoke-password":"%s"}\\n' \
      "$CAMPING_TEST_DATABASE_PASSWORD" "$token" "$smoke" > "$LM_EDB_DIR/scrub-secrets.json"
    unset token smoke CAMPING_TEST_DATABASE_PASSWORD
  ''')
}

/**
 * 以本次 commit 的 Migration_Runner（scripts/migrate.mjs）套用遷移至本階段的 Ephemeral_Database。
 * 需在 inBuildImageOn(env.LM_EDB_NET) + withEnv(testEnv()) 內呼叫。回傳結束碼。
 */
int migrateEphemeralDb(String logFile) {
  int rc
  withEnv(["LM_MIGRATE_LOG=${logFile}"]) {
    rc = sh(label: 'Migration_Runner', returnStatus: true, script: '''
      set +x
      set -eu
      set -a
      . "$LM_EDB_DIR/client.env"
      set +a
      CAMPING_DATABASE_HOST="$CAMPING_TEST_DATABASE_HOST" \
      CAMPING_DATABASE_PORT="$CAMPING_TEST_DATABASE_PORT" \
      CAMPING_DATABASE_NAME="$CAMPING_TEST_DATABASE_NAME" \
      CAMPING_DATABASE_USER="$CAMPING_TEST_DATABASE_USER" \
      CAMPING_DATABASE_PASSWORD="$CAMPING_TEST_DATABASE_PASSWORD" \
      CAMPING_DATABASE_SSLMODE="$CAMPING_TEST_DATABASE_SSLMODE" \
      CAMPING_BIND_ADDRESS=127.0.0.1 \
        timeout --kill-after=10 300 bun scripts/migrate.mjs > "$LM_MIGRATE_LOG" 2>&1
    ''')
  }
  return rc
}

/**
 * 等待 App 於 120 秒內連續 3 次 Health_Check 成功，再以 Setup_Token 建立合成管理員與 smoke-fixture 行程
 * （ci/scripts/image-smoke-seed.mjs；只存在於本階段的 Ephemeral_Database）。需在 inBuildImageOn 內、
 * 且已設定 CAMPING_SMOKE_BASE_URL 時呼叫。回傳 0 成功、5 未就緒、6 合成資料建立失敗。
 */
int seedTestApp(String prefix) {
  int rc
  withEnv(["LM_APP_PREFIX=${prefix}"]) {
    rc = sh(label: 'Test_Environment health + seed', returnStatus: true, script: '''
      set +x
      set -u
      rc=0
      timeout --kill-after=10 180 bun ci/scripts/image-smoke-seed.mjs wait-healthy > "$LM_APP_PREFIX-health.json" || rc=$?
      [ "$rc" -eq 0 ] || exit 5
      set -a
      . "$LM_EDB_DIR/seed.env"
      set +a
      timeout --kill-after=10 120 bun ci/scripts/image-smoke-seed.mjs seed > "$LM_APP_PREFIX-seed.json" || rc=$?
      [ "$rc" -eq 0 ] || exit 6
      exit 0
    ''')
  }
  return rc
}

/** 容器是否仍在執行。需在 Agent 上執行。 */
boolean containerRunning(String name) {
  if (!name) { return false }
  String state
  withEnv(["LM_CHECK_CONTAINER=${name}"]) {
    state = sh(label: 'container state', returnStdout: true, script: '''
      docker inspect -f '{{.State.Running}}' "$LM_CHECK_CONTAINER" 2>/dev/null || echo false
    ''').trim()
  }
  return state == 'true'
}

/** 保存 Test_Environment 容器日誌（不含秘密：Setup_Token 由環境變數提供，App 不輸出）。不改變建置結果。 */
void saveContainerLog(String name, String file) {
  if (!name) { return }
  catchError(buildResult: null, stageResult: null) {
    withEnv(["LM_LOG_CONTAINER=${name}", "LM_LOG_FILE=${file}"]) {
      sh(label: 'save container log', script: '''
        set +x
        set -u
        mkdir -p "$(dirname "$LM_LOG_FILE")"
        if docker inspect "$LM_LOG_CONTAINER" > /dev/null 2>&1; then
          docker logs "$LM_LOG_CONTAINER" > "$LM_LOG_FILE" 2>&1 || true
        fi
      ''')
    }
  }
}

/**
 * 遷移相容性結果寫入 Build_Record（Req 12.5、12.8、21.2）：reports.migrationCompat 含狀態（pass／fail／skipped）、
 * 最近 Release_Tag、其 App_Image digest、相關遷移檔、失敗或略過原因與失敗的 Smoke_Test 項目；另記錄各日誌路徑。
 */
void recordMigrationCompat(String status, String reason) {
  String smokeText = fileExists('reports/migration-compat-smoke.json') ? readFile('reports/migration-compat-smoke.json') : null
  Map compat = [
    status: status,
    releaseTag: env.LM_COMPAT_TAG ?: '',
    image: env.LM_COMPAT_IMAGE ?: '',
    migrations: (env.LM_COMPAT_MIGRATIONS ?: '').tokenize(' '),
    reason: gateText(reason ?: ''),
    failedSmokeSteps: smokeText != null ? smokeFailures(smokeText) : [],
  ]
  writeFile(file: 'reports/migration-compat.json', text: JsonOutput.toJson(compat))
  Map reports = existingReports([
    lintMigrations: 'reports/lint-migrations.log',
    migrationCompatOldMigrate: 'reports/migration-compat-old-migrate.log',
    migrationCompatNewMigrate: 'reports/migration-compat-new-migrate.log',
    migrationCompatSmoke: 'reports/migration-compat-smoke.json',
    migrationCompatReport: 'reports/migration-compat.json',
  ])
  reports.migrationCompat = compat
  writeFile(file: 'reports/migration-compat-record-patch.json', text: JsonOutput.toJson([reports: reports]))
  inBuildImage {
    sh(label: 'Build_Record migration compatibility', script: 'bun ci/record.mjs merge --record "$LM_RECORD" --patch reports/migration-compat-record-patch.json')
  }
  env.LM_COMPAT_RECORDED = 'true'
}

/** scripts/smoke.mjs 的 JSON 輸出 → 失敗的步驟（步驟名稱、狀態碼、失敗類別；不含回應內容）。 */
@NonCPS
List smokeFailures(String text) {
  List out = []
  try {
    Object doc = parseJsonText(text ?: '')
    List steps = doc instanceof Map && doc.steps instanceof List ? (List) doc.steps : []
    for (Object s : steps) {
      Map m = s instanceof Map ? (Map) s : [:]
      if (m.result == 'fail') {
        out << gateText("${m.step}（狀態碼 ${m.status == null ? '無' : m.status}，${m.reason ?: 'fail'}）")
      }
    }
  } catch (Exception ignored) {
    out << 'Smoke_Test 輸出無法解析'
  }
  return out
}

void dastStep(String reason) {
  env.LM_DAST_STAGE_ERROR = reason
}

String dastStageError() {
  return env.LM_DAST_STAGE_ERROR ?: 'DAST 階段執行失敗或已中止'
}

/** ZAP 映像必須位於 Build_Image 的 LAN Registry 並以 @sha256: digest 固定。 */
List dastImages() {
  String registry = env.BUILD_IMAGE.substring(0, env.BUILD_IMAGE.indexOf('/'))
  String ref = env.LM_ZAP_IMAGE ?: ''
  if (!isPinnedImage(ref) || !ref.startsWith(registry + '/')) {
    error('LM_ZAP_IMAGE 必須以 <LAN Registry>/<repo>@sha256:<64 hex> 引用；請以實際 digest 取代 Jenkinsfile 中的 PLACEHOLDER')
  }
  return [ref]
}

/** 隔離探測目標：IP 位址字面值 + 連接埠，至少一個（PLACEHOLDER 未取代即失敗）。 */
List dastProbeTargets() {
  List out = []
  for (String t : (env.LM_DAST_PROBE_TARGETS ?: '').tokenize(' ')) {
    if (!(t ==~ /^([0-9]{1,3}(\.[0-9]{1,3}){3}|\[[0-9A-Fa-f:.]+\]):[0-9]{1,5}$/)) {
      error('LM_DAST_PROBE_TARGETS 必須是以空白分隔的 <IP>:<port>；請以實際位址取代 Jenkinsfile 中的 PLACEHOLDER')
    }
    out << t
  }
  if (out.isEmpty()) { error('LM_DAST_PROBE_TARGETS 未設定') }
  return out
}

/** DAST 階段本體（於 60 分鐘 timeout 內執行）。失敗原因寫入 lmDastErrors 與 dastStep，供含 DAST 的「安全」關卡記錄。 */
void runDast() {
  dastStep('DAST 設定無效：ZAP 映像或隔離探測目標未設定（見主控台）')
  List images = dastImages()
  env.LM_DAST_PROBE_ARGS = dastProbeTargets().join(' ')
  dastStep('ZAP 映像無法拉取')
  pullImages(images)

  dastStep('Ephemeral_Database 未於 120 秒內就緒或無法建立')
  startEphemeralDb('dast')
  env.LM_DAST_APP = "${env.LM_EDB_RUN}-app"
  env.LM_DAST_ORIGIN = "http://${env.LM_DAST_APP}:5173"

  // 1. Target_Allowlist 只含本次 Test_Environment 的 origin；計畫的每個目標（起始 URL、context、爬蟲範圍）都必須在內，
  //    且速率／執行緒／時間上限符合，才產生 ZAP 實際執行的計畫（Req 7.2、7.3、7.4）。此時尚未發出任何掃描請求。
  dastStep('DAST 目標驗證未通過，未發出任何掃描請求（被拒絕的目標見 Build_Record）')
  int targetsRc
  inBuildImage {
    targetsRc = sh(label: 'ci/dast/targets.mjs', returnStatus: true, script: '''
      set -u
      rm -rf reports/dast
      mkdir -p reports/dast
      DAST_TARGET_ORIGIN="$LM_DAST_ORIGIN" DAST_REPORT_DIR=/zap/wrk \
        bun ci/dast/targets.mjs --plan ci/dast/zap-automation.yaml --allowlist "$LM_DAST_ORIGIN" \
        --render reports/dast/zap-plan.yaml --out reports/dast/targets.json
    ''')
  }
  if (targetsRc != 0) {
    String result = fileExists('reports/dast/targets.json') ? readFile('reports/dast/targets.json') : ''
    lmDastErrors.addAll(dastTargetProblems(result))
    error('DAST 目標不在 Target_Allowlist 內、Target_Allowlist 為空或掃描限制不符，已中止 DAST（Req 7.3）')
  }

  // 2. Test_Environment：本次 commit 的 Migration_Runner → App（Build_Image 執行 checkout，唯讀掛載工作目錄）。
  writeAppSecrets()
  dastStep('本次 commit 的 Migration_Runner 無法套用遷移至 Ephemeral_Database')
  inBuildImageOn(env.LM_EDB_NET) {
    withEnv(testEnv()) {
      int migrateRc = migrateEphemeralDb('reports/dast/migrate.log')
      if (migrateRc != 0) {
        error("Migration_Runner 以結束碼 ${migrateRc} 結束（見 reports/dast/migrate.log），不啟動 Test_Environment")
      }
    }
  }
  dastStep('Test_Environment 無法啟動')
  sh(label: 'start Test_Environment', script: '''
    set +x
    set -eu
    docker run -d --name "$LM_DAST_APP" --network "$LM_EDB_NET" \
      --label "lm.ci.edb=$LM_EDB_RUN" --label "lm.ci.build=$BUILD_TAG" \
      --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m -e HOME=/tmp \
      --cap-drop ALL --security-opt no-new-privileges:true \
      --env-file "$LM_EDB_DIR/app.env" --env-file "$LM_EDB_DIR/setup.env" \
      -e "CAMPING_DATABASE_HOST=$LM_EDB_HOST" -e CAMPING_DATABASE_PORT=5432 -e "CAMPING_DATABASE_NAME=$LM_EDB_NAME" \
      -e "CAMPING_DATABASE_USER=$LM_EDB_USER" -e CAMPING_DATABASE_SSLMODE=disable \
      -e CAMPING_BIND_ADDRESS=0.0.0.0 -e PORT=5173 -e "CAMPING_ALLOWED_HOSTS=$LM_DAST_APP" \
      --mount "type=bind,src=$WORKSPACE,dst=/app,readonly" -w /app \
      --entrypoint bun "$BUILD_IMAGE" scripts/serve.mjs > /dev/null
  ''')
  inBuildImageOn(env.LM_EDB_NET) {
    withEnv(testEnv() + ["CAMPING_SMOKE_BASE_URL=${env.LM_DAST_ORIGIN}".toString()]) {
      dastStep('Test_Environment 未於 120 秒內就緒或無法建立合成資料')
      int seedRc = seedTestApp('reports/dast/app')
      if (seedRc != 0) {
        error("Test_Environment 未就緒或無法建立合成資料（結束碼 ${seedRc}，見 reports/dast/app-health.json、reports/dast/app-seed.json）")
      }
    }
  }

  // 3. 網路隔離（Req 7.7、7.9）：在 Test_Environment 的網路命名空間內，只有 Ephemeral_Database 可連線。
  dastStep('網路隔離檢查未通過，未啟動 DAST_Scanner（可連線的位址見 Build_Record）')
  int probeRc = sh(label: 'ci/dast/isolation-probe.sh', returnStatus: true, script: '''
    set -u
    set -f
    set --
    for t in ${LM_DAST_PROBE_ARGS:-}; do
      set -- "$@" --probe "$t"
    done
    rc=0
    timeout --kill-after=10 300 docker run --rm --name "$LM_EDB_RUN-probe" --network "container:$LM_DAST_APP" \
      --label "lm.ci.edb=$LM_EDB_RUN" --label "lm.ci.build=$BUILD_TAG" \
      --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=16m -e HOME=/tmp \
      --cap-drop ALL --security-opt no-new-privileges:true \
      --mount "type=bind,src=$WORKSPACE/ci/dast/isolation-probe.sh,dst=/probe/isolation-probe.sh,readonly" \
      --entrypoint bash "$BUILD_IMAGE" /probe/isolation-probe.sh --allow "$LM_EDB_HOST:5432" "$@" \
      > reports/dast/isolation.log || rc=$?
    tail -n 1 reports/dast/isolation.log > reports/dast/isolation.json 2>/dev/null || true
    exit "$rc"
  ''')
  if (probeRc == 1) {
    lmDastErrors.addAll(isolationReachable(fileExists('reports/dast/isolation.json') ? readFile('reports/dast/isolation.json') : ''))
    error('Test_Environment 可連線至 Ephemeral_Database 以外的位址，不啟動 DAST_Scanner（Req 7.9）')
  } else if (probeRc == 3) {
    lmDastErrors << 'Test_Environment 無法連線至 Ephemeral_Database，隔離探測結果不可信'
    error('隔離探測無法連線至 Ephemeral_Database，不啟動 DAST_Scanner')
  } else if (probeRc != 0) {
    lmDastErrors << "隔離探測無法執行（結束碼 ${probeRc}）".toString()
    error("隔離探測無法執行（結束碼 ${probeRc}），不啟動 DAST_Scanner")
  }

  // 4. 安全測試套件（Req 7.6、10.10、10.11）：loopback 組與 lan 組（Bind_Address 0.0.0.0、Allowed_Hosts 含非 loopback Host
  //    名稱、所有請求經該 Host 名稱送出）。綁定 0.0.0.0 只在本階段的 --internal 網路內（CAMPING_SECURITY_LAN_BIND）。
  dastStep('安全測試套件（tests/security）未通過或無法完成（失敗類別見 reports/security/security-suite.json）')
  int suiteRc
  inBuildImageOn(env.LM_EDB_NET) {
    withEnv(testEnv() + ['CAMPING_SECURITY_GROUPS=loopback,lan', 'CAMPING_SECURITY_LAN_BIND=0.0.0.0', 'CAMPING_SECURITY_LAN_HOST=lm-test.lan']) {
      suiteRc = sh(label: 'tests/security', returnStatus: true, script: '''
        set +x
        set -u
        set -a
        . "$LM_EDB_DIR/client.env"
        set +a
        rm -f reports/security-junit.xml reports/security-junit-loopback.xml reports/security-junit-lan.xml
        rc=0
        timeout --kill-after=30 900 bun scripts/security-suite.mjs > reports/dast/security-suite.log 2>&1 || rc=$?
        exit "$rc"
      ''')
    }
  }
  if (suiteRc != 0) {
    lmDastErrors << "安全測試套件（tests/security，含 Req 10.10 非 loopback 設定）未通過（結束碼 ${suiteRc}）".toString()
    error("安全測試套件未通過（結束碼 ${suiteRc}，見 reports/security-junit.xml）")
  }
  if (!containerRunning(env.LM_DAST_APP)) {
    lmDastErrors << 'Test_Environment 在掃描開始前異常結束'
    error('Test_Environment 在掃描開始前異常結束')
  }

  // 5. OWASP ZAP：只執行已驗證的計畫；速率上限 20 rps（Rate Limit 規則）+ 5 執行緒、250 ms 間隔（計畫內）。
  //    異常結束或逾時 → 刪除不完整的報告，不視為通過（Req 7.10）。
  dastStep('DAST_Scanner（ZAP）異常結束、逾時或未產生報告，掃描未完成')
  int zapRc = sh(label: 'OWASP ZAP', returnStatus: true, script: '''
    set -u
    zapdir="$LM_EDB_DIR/zap"
    rm -rf "$zapdir" reports/dast/zap-report.json
    mkdir -m 0700 "$zapdir"
    cp reports/dast/zap-plan.yaml "$zapdir/zap-plan.yaml"
    rc=0
    timeout --kill-after=30 3300 docker run --rm --name "$LM_EDB_RUN-zap" --network "$LM_EDB_NET" \
      --label "lm.ci.edb=$LM_EDB_RUN" --label "lm.ci.build=$BUILD_TAG" --label "lm.ci.dast=$LM_EDB_RUN" \
      --user "$(id -u):$(id -g)" --tmpfs /tmp:rw,nosuid,nodev,size=2g -e HOME=/tmp \
      --cap-drop ALL --security-opt no-new-privileges:true \
      --mount "type=bind,src=$zapdir,dst=/zap/wrk" \
      "$LM_ZAP_IMAGE" zap.sh -cmd -silent -dir /tmp/zap-home -autorun /zap/wrk/zap-plan.yaml \
      -config 'network.ratelimit.rules.rule(0).description=lm-dast' \
      -config 'network.ratelimit.rules.rule(0).enabled=true' \
      -config 'network.ratelimit.rules.rule(0).matchStr=.*' \
      -config 'network.ratelimit.rules.rule(0).regex=true' \
      -config 'network.ratelimit.rules.rule(0).reqsPerSec=20' \
      -config 'network.ratelimit.rules.rule(0).groupBy=RULE' \
      > reports/dast/zap.log 2>&1 || rc=$?
    if [ "$rc" -eq 0 ] && [ -s "$zapdir/zap-report.json" ]; then
      cp "$zapdir/zap-report.json" reports/dast/zap-report.json
    elif [ "$rc" -eq 0 ]; then
      rc=3
    fi
    rm -rf "$zapdir"
    exit "$rc"
  ''')
  if (zapRc == 124 || zapRc == 137) {
    lmDastErrors << 'DAST_Scanner（ZAP）超過時間上限被終止，掃描未完成'
    error('DAST_Scanner 超過時間上限被終止，掃描未完成')
  } else if (zapRc == 3) {
    lmDastErrors << 'DAST_Scanner（ZAP）未產生報告，掃描未完成'
    error('DAST_Scanner 未產生報告，掃描未完成')
  } else if (zapRc != 0) {
    lmDastErrors << "DAST_Scanner（ZAP）異常結束（結束碼 ${zapRc}），掃描未完成".toString()
    error("DAST_Scanner 異常結束（結束碼 ${zapRc}，見 reports/dast/zap.log），掃描未完成")
  }
  if (!containerRunning(env.LM_DAST_APP)) {
    lmDastErrors << 'Test_Environment 在掃描完成前異常結束'
    error('Test_Environment 在掃描完成前異常結束，不將掃描視為通過（Req 7.10）')
  }

  // 6. 正規化 → 政策評估（靜態掃描 + ZAP + 安全測試套件）。
  dastStep('DAST 報告正規化或安全政策評估失敗')
  evaluateDastReports()
  dastStep('')
}

/**
 * ZAP 與安全測試套件報告正規化，連同 Security Scan 的正規化報告由 ci/policy/evaluate.mjs 評估
 * （reports/security/evaluation-dast.json）。報告缺失時 normalize／evaluate 視為掃描未完成（fail closed）。
 * 評估無法執行（結束碼 2）時記錄於 lmDastErrors。需在 Agent 上呼叫。
 */
void evaluateDastReports() {
  int rc
  inBuildImage {
    rc = sh(label: 'DAST normalize + evaluate', returnStatus: true, script: '''
      set -u
      mkdir -p reports/security
      bun ci/policy/normalize.mjs --tool zap --in reports/dast/zap-report.json --out reports/security/zap.json || true
      bun ci/policy/normalize.mjs --tool security-suite --in reports/security-junit.xml --out reports/security/security-suite.json || true
      rm -f reports/security/evaluation-dast.json
      bun ci/policy/evaluate.mjs \
        --reports reports/security/gitleaks-dir.json reports/security/gitleaks-git.json reports/security/osv.json reports/security/trivy-node-modules.json reports/security/semgrep.json reports/security/zap.json reports/security/security-suite.json \
        --exceptions security/exceptions.json --commit "$GIT_COMMIT_FULL" --today "$(date +%F)" \
        --out reports/security/evaluation-dast.json
    ''')
  }
  if (rc != 0 && rc != 1) {
    lmDastErrors << "含 DAST 的安全政策評估無法執行（ci/policy/evaluate.mjs 結束碼 ${rc}）".toString()
  }
}

/** 60 秒內停止 DAST_Scanner（依 label 強制移除 ZAP 容器），使其不再發出新請求（Req 7.5）。需在 Agent 上執行。 */
void stopDastScanner() {
  if (!env.LM_EDB_RUN) { return }
  catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
    timeout(time: 60, unit: 'SECONDS') {
      sh(label: 'stop DAST_Scanner', script: '''
        set +x
        set -u
        for id in $(docker ps -aq --filter "label=lm.ci.dast=$LM_EDB_RUN" 2>/dev/null); do
          docker rm -f "$id" > /dev/null 2>&1 || true
        done
      ''')
    }
  }
}

/** ci/dast/targets.mjs --out 的結果 → 關卡未符合條件（被拒絕的目標位址、無效的 allowlist 項目、限制不符；Req 7.3）。 */
@NonCPS
List dastTargetProblems(String text) {
  List out = []
  try {
    Object doc = parseJsonText(text ?: '')
    Map t = doc instanceof Map && doc.targets instanceof Map ? (Map) doc.targets : [:]
    Map l = doc instanceof Map && doc.limits instanceof Map ? (Map) doc.limits : [:]
    for (Object e : (t.errors instanceof List ? (List) t.errors : [])) {
      out << gateText(e == 'empty_allowlist' ? 'Target_Allowlist 為空' : "DAST 目標驗證失敗：${e}")
    }
    for (Object a : (t.invalidAllowlist instanceof List ? (List) t.invalidAllowlist : [])) {
      out << gateText("Target_Allowlist 項目無效：${a}")
    }
    for (Object r : (t.rejected instanceof List ? (List) t.rejected : [])) {
      out << gateText("DAST 目標被拒絕（不在 Target_Allowlist 內）：${r}")
    }
    for (Object p : (l.problems instanceof List ? (List) l.problems : [])) {
      Map m = p instanceof Map ? (Map) p : [:]
      out << gateText("DAST 掃描限制不符：${m.job} ${m.field} ${m.reason}")
    }
  } catch (Exception ignored) {
    out << 'DAST 計畫無法解析或目標驗證結果（reports/dast/targets.json）缺失'
  }
  if (out.isEmpty()) { out << 'DAST 目標驗證未通過' }
  return out.size() > 50 ? out.subList(0, 50) : out
}

/** ci/dast/isolation-probe.sh 的 JSON 摘要 → 可連線的位址（Req 7.9）。 */
@NonCPS
List isolationReachable(String text) {
  List out = []
  try {
    Object doc = parseJsonText(text ?: '')
    for (Object r : (doc instanceof Map && doc.reachable instanceof List ? (List) doc.reachable : [])) {
      out << gateText("Test_Environment 可連線至 Ephemeral_Database 以外的位址：${r}")
    }
  } catch (Exception ignored) {
    out << '隔離探測結果（reports/dast/isolation.json）無法解析'
  }
  if (out.isEmpty()) { out << 'Test_Environment 可連線至 Ephemeral_Database 以外的位址' }
  return out
}

// ------------------------------------------------------------------ App_Image 建置、掃描、SBOM、推送、簽章與「映像」關卡

/** 記錄目前步驟失敗時寫入「映像」關卡的原因（固定訊息，不含秘密值）。 */
void imgStep(String reason) {
  env.LM_IMAGE_STAGE_ERROR = reason
}

String imgStageError(String stage) {
  return env.LM_IMAGE_STAGE_ERROR ?: "${stage} 階段執行失敗或已中止".toString()
}

/**
 * Image Build 的前提（Req 16.1、23.2）：本次建置的「QA」、「安全」與含 DAST 的「安全」關卡結果檔都存在、
 * 皆為通過且 commit 為本次 Commit SHA。任一不符即失敗，且不評估「映像」關卡。
 */
void requireQaAndSecurityPassed() {
  List checks = [
    ['reports/gate-qa.json', 'QA'],
    ['reports/gate-security.json', '安全'],
    ['reports/gate-security-dast.json', '安全（含 DAST）'],
  ]
  List failed = []
  for (List c : checks) {
    String text = fileExists(c[0]) ? readFile(c[0]) : ''
    if (!gatePassed(text, env.GIT_COMMIT_FULL ?: '')) { failed << c[1] }
  }
  if (!failed.isEmpty()) {
    error("Release_Gate ${failed.join('、')} 未通過或結果缺失，不建置 App_Image（Req 16.1、23.2）")
  }
}

/** 關卡結果檔（ci/gates.mjs 或 securityGate 的輸出）為通過且屬於本次 commit。 */
@NonCPS
boolean gatePassed(String text, String commit) {
  try {
    Object g = text ? parseJsonText(text) : null
    return g instanceof Map && g.pass == true && String.valueOf(g.commit) == commit && commit ==~ /^[0-9a-f]{40}$/
  } catch (Exception ignored) {
    return false
  }
}

/**
 * 映像工具必須位於 Build_Image 的 LAN Registry 並以 @sha256: digest 固定；Trivy 資料庫鏡像與 App_Image repository
 * 同樣須在該 Registry。回傳待拉取的映像引用。
 */
List imageToolImages() {
  String registry = env.BUILD_IMAGE.substring(0, env.BUILD_IMAGE.indexOf('/'))
  List refs = [env.LM_TRIVY_IMAGE, env.LM_SYFT_IMAGE, env.LM_CRANE_IMAGE, env.LM_COSIGN_IMAGE]
  for (Object ref in refs) {
    String s = ref ? ref.toString() : ''
    if (!isPinnedImage(s) || !s.startsWith(registry + '/')) {
      error('映像工具（Trivy、Syft、crane、cosign）必須以 <LAN Registry>/<repo>@sha256:<64 hex> 引用；請以實際 digest 取代 Jenkinsfile 中的 PLACEHOLDER')
    }
  }
  String db = env.LM_TRIVY_DB_REPOSITORY ?: ''
  if (!(db ==~ /^[a-z0-9][a-z0-9.\-]*(:[0-9]+)?\/[a-z0-9][a-z0-9._\/\-]*:[A-Za-z0-9._\-]+$/) || !db.startsWith(registry + '/')) {
    error('LM_TRIVY_DB_REPOSITORY 必須是 LAN Registry 內的 <repo>:<tag>')
  }
  String repo = env.LM_IMAGE_REPO ?: ''
  if (!(repo ==~ /^[a-z0-9][a-z0-9.\-]*(:[0-9]+)?\/[a-z0-9][a-z0-9._\/\-]*$/) || !repo.startsWith(registry + '/')) {
    error('LM_IMAGE_REPO 必須是 Build_Image 所在 LAN Registry 內的 repository（不含 tag 或 digest）')
  }
  return refs
}

/**
 * 建立本建置的映像工作目錄（$WORKSPACE_TMP/lm-image-<id>，0700）：bin/bun 是 ci/scripts/build-image.sh 的 BUN_BIN，
 * 在無網路的 Build_Image 容器內執行 bun（Agent 上沒有 bun；工作目錄以相同路徑掛載，相對路徑不變）。
 * tmp/ 為 build-image.sh 的 TMPDIR（容器可讀取其 /etc/passwd 暫存檔）；out/ 為工具輸出。需在 Agent 上執行。
 */
void prepareImageWork() {
  String suffix = sh(label: 'image work id', returnStdout: true, script: 'od -An -N8 -tx1 /dev/urandom | tr -d " \\n"').trim()
  if (!(suffix ==~ /^[0-9a-f]{16}$/)) { error('無法產生映像工作識別碼') }
  env.LM_IMG_RUN = "lm-image-${suffix}"
  env.LM_IMG_DIR = "${env.WORKSPACE_TMP}/${env.LM_IMG_RUN}"
  // 例外到期日以 Build_Agent 當下的本地日期判定（Req 6.6、17.2）。
  String today = sh(label: 'image scan date', returnStdout: true, script: 'date +%F').trim()
  if (!(today ==~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)) { error('無法取得掃描日期') }
  env.LM_IMG_TODAY = today
  sh(label: 'prepare image work', script: '''
    set -eu
    rm -rf "$LM_IMG_DIR"
    mkdir -p "$LM_IMG_DIR"
    chmod 0700 "$LM_IMG_DIR"
    mkdir -m 0700 "$LM_IMG_DIR/bin" "$LM_IMG_DIR/tmp" "$LM_IMG_DIR/out"
    cat > "$LM_IMG_DIR/bin/bun" <<'EOF'
#!/bin/sh
exec docker run --rm --label "lm.ci.build=$BUILD_TAG" --label "lm.ci.image=$LM_IMG_RUN" \
  --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m -e HOME=/tmp \
  --security-opt no-new-privileges:true --cap-drop ALL --network none \
  --mount "type=bind,src=$WORKSPACE,dst=$WORKSPACE" \
  --mount "type=bind,src=$LM_IMG_DIR,dst=$LM_IMG_DIR" \
  -w "$PWD" --entrypoint bun "$BUILD_IMAGE" "$@"
EOF
    chmod 0700 "$LM_IMG_DIR/bin/bun"
  ''')
}

/** 移除本建置的映像工具容器與工作目錄（含匯出的映像 tar、Trivy 原始報告與 docker 登入資訊）；可重複呼叫。需在 Agent 上執行。 */
void cleanupImageWork() {
  if (!env.LM_IMG_RUN) { return }
  sh(label: 'cleanup image work', script: '''
    set +x
    set -u
    for id in $(docker ps -aq --filter "label=lm.ci.image=$LM_IMG_RUN" 2>/dev/null); do
      docker rm -f "$id" > /dev/null 2>&1 || true
    done
    case "$LM_IMG_DIR" in
      "$WORKSPACE_TMP"/lm-image-*) rm -rf -- "$LM_IMG_DIR" ;;
    esac
  ''')
  env.LM_IMG_RUN = ''
}

/** 寫入 patch 並合併至 Build_Record；失敗即 error()。參數為 Jenkinsfile 內的固定路徑與已驗證的值。需在 Agent 上呼叫。 */
void mergeRecordPatch(String file, Map patch) {
  writeFile(file: file, text: JsonOutput.toJson(patch))
  int rc
  withEnv(["LM_RECORD_PATCH=${file}"]) {
    inBuildImage {
      rc = sh(label: 'Build_Record merge', returnStatus: true, script: 'bun ci/record.mjs merge --record "$LM_RECORD" --patch "$LM_RECORD_PATCH"')
    }
  }
  if (rc != 0) {
    error('無法將映像資訊寫入 Build_Record')
  }
}

/** 只把實際存在的報告路徑寫入 Build_Record（Req 16.8、21.2）；不改變原本的失敗原因。 */
void recordImageReports(String patchFile, Map candidates) {
  Map reports = existingReports(candidates)
  if (reports.isEmpty()) { return }
  catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
    mergeRecordPatch(patchFile, [reports: reports])
  }
}

/** 映像階段失敗、逾時或中止：尚未記錄最終結果時記錄「映像」關卡未通過（Req 23.1、23.3），再清除工作目錄。 */
void imageStageFailed(String stage) {
  catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
    if (env.LM_IMAGE_GATE_ELIGIBLE == 'true' && env.LM_IMAGE_GATE_DONE != 'true') {
      String phase = (stage == 'Image Push' || stage == 'Image Sign') ? 'final' : 'prepush'
      recordImageGate(phase, imgStageError(stage), true)
    }
  }
  cleanupImageWork()
}

/**
 * 評估「映像」關卡並寫入 Build_Record（Req 17.2、23.2、23.5）。phase：
 *   scan     只看 App_Image 掃描（秘密數 0、未處理 Critical/High 為 0、掃描完成）；recordPass=false 時通過不記錄
 *   prepush  另需 SBOM 已保存至 Build_Record（推送前部分）
 *   final    另需簽章已推送且可驗證、Build_Record 的 image.digest 與 source.commit 為本次值、reports.sbom 已記錄
 * 未通過或 final 記錄後設定 LM_IMAGE_GATE_DONE，post 不再重複記錄。回傳 0 通過、1 未通過。需在 Agent 上呼叫。
 */
int recordImageGate(String phase, String stageError, boolean recordPass) {
  Map reports = existingReports([
    trivy: 'reports/security/trivy-image.json',
    imageScanEvaluation: 'reports/security/evaluation-image.json',
    sbom: 'reports/sbom.cdx.json',
    sbomSummary: 'reports/sbom-summary.json',
    imageDigest: 'reports/image-digest.txt',
    imageSignature: 'reports/image-signature.json',
  ])
  boolean finalPhase = phase == 'final'
  String evaluation = fileExists('reports/security/evaluation-image.json') ? readFile('reports/security/evaluation-image.json') : ''
  Map facts = [
    sbom: env.LM_SBOM_OK == 'true' && fileExists('reports/sbom.cdx.json'),
    digest: env.LM_IMAGE_DIGEST ?: '',
    signature: finalPhase && fileExists('reports/image-signature.json') ? readFile('reports/image-signature.json') : '',
    record: finalPhase && fileExists(env.LM_RECORD) ? readFile(env.LM_RECORD) : '',
  ]
  // lmImageErrors 於 Image Build 階段一開始即設定（與 lmScanErrors 相同方式）。
  List errors = lmImageErrors instanceof List ? (List) lmImageErrors : []
  Map gate = imageGate(phase, evaluation, errors, stageError ?: '', env.GIT_COMMIT_FULL ?: '', new ArrayList(reports.values()), facts)
  if (gate.pass == true && !recordPass) { return 0 }
  String gateFile = "reports/gate-image-${phase}.json".toString()
  writeFile(file: gateFile, text: JsonOutput.toJson(gate))
  mergeRecordPatch("reports/image-gate-${phase}-record-patch.json".toString(), [reports: reports])
  int rc
  withEnv(["LM_IMAGE_GATE_FILE=${gateFile}"]) {
    inBuildImage {
      rc = sh(label: 'Release_Gate 映像', returnStatus: true, script: 'bun ci/record.mjs gate --record "$LM_RECORD" --result "$LM_IMAGE_GATE_FILE"')
    }
  }
  if (rc != 0) {
    error('無法將「映像」關卡寫入 Build_Record')
  }
  if (gate.pass != true || finalPhase) {
    env.LM_IMAGE_GATE_DONE = 'true'
  }
  return gate.pass == true ? 0 : 1
}

/**
 * 組成「映像」關卡結果（ci/record.mjs gate 的輸入）：掃描部分沿用 securityGate（只複製 ID、套件、版本、路徑，
 * 不含秘密值），再依 phase 加上 SBOM、簽章與 Build_Record 條件。評估時間由 ci/record.mjs 以當下時間填入。
 */
@NonCPS
Map imageGate(String phase, String evaluationText, List errors, String stageError, String commit, List reports, Map facts) {
  Map g = securityGate(evaluationText, errors, stageError, commit, reports)
  g.gate = '映像'
  g.remove('evaluatedAt')
  List extra = []
  if (phase != 'scan' && facts.sbom != true) {
    extra << 'SBOM 未產生或未保存至 Build_Record'
  }
  if (phase == 'final') {
    String digest = String.valueOf(facts.digest ?: '')
    if (!(digest ==~ /^sha256:[0-9a-f]{64}$/)) {
      extra << 'Registry 未回報有效的 Image_Digest（App_Image 未推送或 digest 比對失敗）'
    } else {
      if (!signatureCovers(String.valueOf(facts.signature ?: ''), digest)) {
        extra << 'App_Image 簽章未推送至 Registry，或無法以簽章金鑰的公鑰驗證'
      }
      Map rec = recordImageFacts(String.valueOf(facts.record ?: ''))
      if (rec.digest != digest || rec.commit != commit) {
        extra << 'Build_Record 未記錄該 Image_Digest 對應的 Commit SHA'
      }
      if (rec.sbom != 'reports/sbom.cdx.json') {
        extra << 'Build_Record 未記錄 SBOM'
      }
    }
  }
  if (!extra.isEmpty()) {
    ((List) g.unmet).addAll(extra)
    if (g.status == 'pass') { g.status = 'fail' }
  }
  g.pass = g.status == 'pass'
  return g
}

/** `cosign verify --output json` 的結果中至少一筆簽章對象為該 digest（與 ci/resolve-digest.mjs checkSignatureOutput 相同）。 */
@NonCPS
boolean signatureCovers(String text, String digest) {
  if (!(digest ==~ /^sha256:[0-9a-f]{64}$/)) { return false }
  try {
    Object doc = parseJsonText((text ?: '').trim())
    if (!(doc instanceof List) || ((List) doc).isEmpty()) { return false }
    for (Object e : (List) doc) {
      if (e instanceof Map && e.critical instanceof Map && e.critical.image instanceof Map &&
          e.critical.image['docker-manifest-digest'] == digest) {
        return true
      }
    }
  } catch (Exception ignored) {
    return false
  }
  return false
}

/** Build_Record 的 image.digest、source.commit 與 reports.sbom（解析失敗時皆為空字串）。 */
@NonCPS
Map recordImageFacts(String text) {
  Map out = [digest: '', commit: '', sbom: '']
  try {
    Object r = text ? parseJsonText(text) : null
    if (r instanceof Map) {
      if (r.image instanceof Map && r.image.digest instanceof String) { out.digest = r.image.digest }
      if (r.source instanceof Map && r.source.commit instanceof String) { out.commit = r.source.commit }
      if (r.reports instanceof Map && r.reports.sbom instanceof String) { out.sbom = r.reports.sbom }
    }
  } catch (Exception ignored) {
    return [digest: '', commit: '', sbom: '']
  }
  return out
}

// ------------------------------------------------------------------ Staging 部署與「Staging」關卡

void stgStep(String reason) {
  env.LM_STAGING_STAGE_ERROR = reason
}

String stgStageError() {
  return env.LM_STAGING_STAGE_ERROR ?: 'Staging Deploy 階段執行失敗或已中止'
}

/**
 * Staging 部署的前提（Req 1.3、23.2）：完整的「映像」關卡（reports/gate-image-final.json）已記錄、通過且屬於本次 commit，
 * 且 Image Push 取得的 Image_Digest 有效。任一不符即失敗，且不評估「Staging」關卡。
 */
void requireImageGatePassed() {
  String text = fileExists('reports/gate-image-final.json') ? readFile('reports/gate-image-final.json') : ''
  if (env.LM_IMAGE_GATE_DONE != 'true' || !gatePassed(text, env.GIT_COMMIT_FULL ?: '') ||
      !((env.LM_IMAGE_DIGEST ?: '') ==~ /^sha256:[0-9a-f]{64}$/)) {
    error('Release_Gate「映像」未通過或結果缺失，不部署至 Staging（Req 1.3、23.2）')
  }
}

/** Staging 的非秘密設定只接受固定格式；cosign 映像必須以 digest 固定且位於 Build_Image 的 LAN Registry。 */
void assertStagingConfig() {
  if (!((env.LM_DEPLOY_HOST ?: '') ==~ /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/)) {
    error('LM_DEPLOY_HOST 格式無效')
  }
  if (!((env.LM_DEPLOY_PORT ?: '') ==~ /^[1-9][0-9]{0,4}$/)) {
    error('LM_DEPLOY_PORT 格式無效')
  }
  if (!((env.LM_STAGING_URL ?: '') ==~ /^https?:\/\/[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(:[1-9][0-9]{0,4})?$/)) {
    error('LM_STAGING_URL 必須是 http(s)://<host>[:port]（不含路徑）')
  }
  if (!((env.LM_STAGING_DB_NAME ?: '') ==~ /^[A-Za-z_][A-Za-z0-9_]{0,62}$/)) {
    error('LM_STAGING_DB_NAME 格式無效')
  }
  if (env.LM_STAGING_PREDICATE_TYPE != 'https://little-moments.lan/attestations/staging-verified/v1') {
    error('LM_STAGING_PREDICATE_TYPE 必須與 ci/resolve-digest.mjs 的 STAGING_PREDICATE_TYPE 相同')
  }
  String ca = env.LM_SCAN_CA_BUNDLE ?: ''
  if (!(ca ==~ /^\/[A-Za-z0-9._\/-]+$/) || ca.contains('..')) {
    error('LM_SCAN_CA_BUNDLE 必須是絕對路徑')
  }
  String registry = env.BUILD_IMAGE.substring(0, env.BUILD_IMAGE.indexOf('/'))
  String cosign = env.LM_COSIGN_IMAGE ?: ''
  if (!isPinnedImage(cosign) || !cosign.startsWith(registry + '/')) {
    error('LM_COSIGN_IMAGE 必須以 <LAN Registry>/<repo>@sha256:<64 hex> 引用；請以實際 digest 取代 Jenkinsfile 中的 PLACEHOLDER')
  }
  String repo = env.LM_IMAGE_REPO ?: ''
  if (!(repo ==~ /^[a-z0-9][a-z0-9.\-]*(:[0-9]+)?\/[a-z0-9][a-z0-9._\/\-]*$/) || !repo.startsWith(registry + '/')) {
    error('LM_IMAGE_REPO 必須是 Build_Image 所在 LAN Registry 內的 repository（不含 tag 或 digest）')
  }
}

/** 本建置的 Staging 工作目錄（$WORKSPACE_TMP/lm-staging-<id>，0700：docker 登入資訊與 predicate 副本）與 reports/staging/。 */
void prepareStagingWork() {
  String suffix = sh(label: 'staging work id', returnStdout: true, script: 'od -An -N8 -tx1 /dev/urandom | tr -d " \\n"').trim()
  if (!(suffix ==~ /^[0-9a-f]{16}$/)) { error('無法產生 Staging 工作識別碼') }
  env.LM_STG_RUN = "lm-staging-${suffix}"
  env.LM_STG_DIR = "${env.WORKSPACE_TMP}/${env.LM_STG_RUN}"
  sh(label: 'prepare staging work', script: '''
    set -eu
    rm -rf "$LM_STG_DIR" reports/staging
    mkdir -p "$LM_STG_DIR" reports/staging
    chmod 0700 "$LM_STG_DIR"
    mkdir -m 0700 "$LM_STG_DIR/in"
  ''')
}

/** 移除本建置的 cosign 容器與 Staging 工作目錄（含 docker 登入資訊）；可重複呼叫。需在 Agent 上執行。 */
void cleanupStagingWork() {
  if (!env.LM_STG_RUN) { return }
  sh(label: 'cleanup staging work', script: '''
    set +x
    set -u
    for id in $(docker ps -aq --filter "label=lm.ci.staging=$LM_STG_RUN" 2>/dev/null); do
      docker rm -f "$id" > /dev/null 2>&1 || true
    done
    case "$LM_STG_DIR" in
      "$WORKSPACE_TMP"/lm-staging-*) rm -rf -- "$LM_STG_DIR" ;;
    esac
  ''')
  env.LM_STG_RUN = ''
}

/**
 * 持有 lm-staging 鎖時執行（Req 18.9）：簽章驗證 → deploy → Smoke_Test → 判定。
 * 通過 → finalize → staging-verified attestation → Build_Record 與「Staging」關卡；未通過 → 還原 → 記錄未通過並失敗。
 */
void deployStaging() {
  String digest = env.LM_IMAGE_DIGEST ?: ''

  // 1. 部署前以公鑰驗證簽章（Req 17.7、17.8）：未通過即不連線 Deploy_Host，目前執行中的 App_Image 維持不變。
  stgStep('Image_Digest 的簽章無法以設定的公鑰驗證（見 reports/staging/verify.log），未部署')
  int sigRc = verifyStagingSignature()
  if (sigRc == 20) {
    stgStep('')
    recordStagingGate("無法以 ${env.LM_REGISTRY_PULL_CREDENTIALS} 登入 Registry 驗證簽章".toString())
    error("無法以 ${env.LM_REGISTRY_PULL_CREDENTIALS} 登入 Registry，未驗證簽章，未部署至 Staging")
  }
  String sigText = fileExists('reports/staging/signature.json') ? readFile('reports/staging/signature.json') : ''
  boolean sigOk = sigRc == 0 && signatureCovers(sigText, digest)
  env.LM_STG_SIGNATURE = sigOk ? 'ok' : 'fail'
  if (!sigOk) {
    stgStep('')
    recordStagingGate('')
    error('Image_Digest 沒有簽章、簽章無法以設定的公鑰驗證或簽章對象不符，中止 Staging 部署；Deploy_Host 上的 App_Image 維持不變（Req 17.8）')
  }

  // 2. 部署：備份並驗證 → app.env → Migration_Runner → 以 repo@digest 啟動 → 每 10 秒 Health_Check → 切換。
  //    逾時或中止時結果不明，仍查詢狀態並還原。
  stgStep('Staging 部署失敗（見 reports/staging/deploy.jsonl）')
  env.LM_STG_DEPLOY_CALLED = 'true'
  int deployRc = 124
  def interrupted = null
  try {
    timeout(time: 75, unit: 'MINUTES') {
      deployRc = stagingDeployCommand()
    }
  } catch (err) {
    interrupted = err
    deployRc = 124
  }
  stagingCli('ci/staging.mjs classify', ["LM_STG_EXIT=${deployRc}"], '''
    set -u
    rm -f reports/staging/deploy-verdict.json
    bun ci/staging.mjs classify --exit "$LM_STG_EXIT" --result reports/staging/deploy.jsonl \
      --digest "$LM_IMAGE_DIGEST" --out reports/staging/deploy-verdict.json
  ''')
  Map c = readJsonFile('reports/staging/deploy-verdict.json')
  if (interrupted == null && c.outcome == 'refused') {
    // lm-deploy 在變更任何東西前拒絕（設定、鎖、非本次建置的未完成部署）：不回滾，Staging 維持不變。
    stgStep('')
    recordStagingGate('')
    error("Staging 部署被拒絕：${gateText(c.message ?: 'lm-deploy 拒絕部署')}")
  }

  // 3. Smoke_Test（10 分鐘內）與 Staging 驗證（Req 18.3、18.4）。
  boolean verified = false
  if (interrupted == null && c.outcome == 'switched') {
    stgStep('Staging 的 Smoke_Test 未通過或未於 10 分鐘內完成（見 reports/staging/smoke.json）')
    int smokeRc = runStagingSmoke()
    int vRc = stagingCli('ci/staging.mjs verdict', ["LM_STG_SMOKE_EXIT=${smokeRc}"], '''
      set -u
      rm -f reports/staging/verdict.json reports/staging/predicate.json
      bun ci/staging.mjs verdict --deploy reports/staging/deploy-verdict.json \
        --smoke reports/staging/smoke.json --smoke-exit "$LM_STG_SMOKE_EXIT" \
        --commit "$GIT_COMMIT_FULL" --digest "$LM_IMAGE_DIGEST" --build "$JOB_NAME#$BUILD_NUMBER" \
        --out reports/staging/verdict.json --out-predicate reports/staging/predicate.json
    ''')
    verified = vRc == 0 && fileExists('reports/staging/predicate.json')
  }

  if (!verified) {
    // Req 18.5、18.8：5 分鐘內還原至前一個已通過 Staging 驗證的 Image_Digest；不將失敗的 digest 記錄為已通過。
    stgStep('Staging 驗證未通過；已嘗試還原至前一個已通過 Staging 驗證的 Image_Digest（見 reports/staging/restore.json）')
    restoreStaging()
    stgStep('')
    recordStagingGate(interrupted != null ? 'Staging 部署逾時或被中止' : '')
    if (interrupted != null) {
      throw interrupted
    }
    Map r = readJsonFile('reports/staging/restore.json')
    String why = c.outcome == 'switched' ? 'Smoke_Test 未通過或未於 10 分鐘內完成' : gateText(c.message ?: '部署未完成')
    String after
    if (r.noRestoreTarget == true) {
      after = '不存在先前已通過 Staging 驗證的 Image_Digest，已停止新版容器（Req 18.8）'
    } else if (r.restored == true) {
      after = 'Staging 已還原至前一個已通過 Staging 驗證的 Image_Digest 且 Health_Check 成功（Req 18.5）'
    } else {
      after = '還原未確認，需人工檢查 Staging（見 reports/staging/restore.json）'
    }
    error("Staging 驗證失敗：${why}；${after}；此 Image_Digest 未記錄為已通過 Staging 驗證")
  }
  env.LM_STG_VERIFIED = 'true'

  // 4. finalize：停止舊槽位並記錄目前版本（成為下一次驗證失敗時的還原目標）。
  stgStep('lm-deploy staging finalize 失敗（見 reports/staging/finalize.jsonl）')
  int fRc = stagingHost('finalize', 'finalize.jsonl')
  env.LM_STG_FINALIZE = fRc == 0 ? 'ok' : 'fail'
  if (fRc != 0) {
    stgStep('')
    recordStagingGate('')
    error("lm-deploy staging finalize 失敗（結束碼 ${fRc}）；新版容器已通過 Staging 驗證並持續執行，需人工執行 finalize")
  }

  // 5. staging-verified attestation（Data Models「Staging 驗證 attestation」）→ verify-attestation → 「Staging」關卡。
  stgStep('staging-verified attestation 推送或驗證失敗（見 reports/staging/attest.log、reports/staging/verify-attestation.log）')
  int attRc = attestStaging()
  int checkRc = 1
  if (attRc == 0) {
    checkRc = stagingCli('ci/staging.mjs check-attestation', [], '''
      bun ci/staging.mjs check-attestation --result reports/staging/attestation.jsonl \
        --commit "$GIT_COMMIT_FULL" --digest "$LM_IMAGE_DIGEST"
    ''')
  }
  env.LM_STG_ATTESTATION = checkRc == 0 ? 'ok' : 'fail'
  stgStep('')
  if (recordStagingGate('') != 0) {
    String detail = attRc == 20 ? "無法以 ${env.LM_REGISTRY_PUSH_CREDENTIALS} 登入 Registry" : 'staging-verified attestation 未推送或無法驗證'
    error("Release_Gate「Staging」未通過：${detail}（見 Build_Record 與 reports/gate-staging.json）")
  }
  echo "Staging 驗證通過：${env.LM_IMAGE_REPO}@${digest}"
}

/**
 * 還原（Req 18.5、18.8），整體 5 分鐘上限：status → 視需要 `rollback`（自動：未切換即移除新槽位；已切換即切回前一個
 * 已通過 Staging 驗證的槽位並停止新槽位；沒有前一個時只停止新槽位）→ status → 作用中槽位 `health --wait`
 * → ci/staging.mjs restore。只執行一次；逾時或中止時記錄「還原未確認」。
 */
void restoreStaging() {
  if (env.LM_STG_RESTORE_DONE == 'true') { return }
  env.LM_STG_RESTORE_DONE = 'true'
  String failure = null
  try {
    timeout(time: 5, unit: 'MINUTES') {
      stagingHost('status', 'status-before-restore.json')
      int need = stagingCli('ci/staging.mjs rollback-needed', [], '''
        bun ci/staging.mjs rollback-needed --deploy reports/staging/deploy-verdict.json \
          --status reports/staging/status-before-restore.json --digest "$LM_IMAGE_DIGEST"
      ''')
      int rbRc = -1
      if (need == 0) {
        rbRc = stagingHost('rollback', 'rollback.jsonl')
      }
      stagingHost('status', 'status-after-restore.json')
      int activeRc = stagingCli('ci/staging.mjs active', [], '''
        bun ci/staging.mjs active --status reports/staging/status-after-restore.json > reports/staging/active.json
      ''')
      Map a = readJsonFile('reports/staging/active.json')
      int hRc = -1
      String color = a.color instanceof String ? a.color : ''
      if (activeRc == 0 && color ==~ /^(blue|green)$/) {
        env.LM_STG_COLOR = color
        hRc = stagingHost('health', 'restore-health.jsonl')
      }
      stagingCli('ci/staging.mjs restore', ["LM_STG_RB_EXIT=${rbRc}", "LM_STG_HEALTH_EXIT=${hRc}"], '''
        set -u
        rm -f reports/staging/restore.json
        bun ci/staging.mjs restore --status reports/staging/status-after-restore.json --digest "$LM_IMAGE_DIGEST" \
          --rollback reports/staging/rollback.jsonl --rollback-exit "$LM_STG_RB_EXIT" \
          --health reports/staging/restore-health.jsonl --health-exit "$LM_STG_HEALTH_EXIT" \
          --out reports/staging/restore.json
      ''')
    }
  } catch (err) {
    failure = err.getClass().getName()
  }
  if (failure != null) {
    echo "restoreStaging: ${failure}"
    echo 'Staging 還原未於 5 分鐘內完成或被中止，需人工確認 Staging 狀態'
  }
  if (!fileExists('reports/staging/restore.json')) {
    writeFile(file: 'reports/staging/restore.json', text: JsonOutput.toJson([
      restored: false, noRestoreTarget: false, newStopped: false, target: null, code: 'restore_unconfirmed',
      message: '還原未於 5 分鐘內完成或結果無法判讀，需人工確認 Staging 狀態', rollback: [code: 'unknown'],
    ]))
  }
}

/** 以 SSH 受限金鑰執行 `lm-deploy staging deploy <digest> --app-env-stdin`；回傳 SSH 結束碼（即 lm-deploy 結束碼，連線失敗為 255）。 */
int stagingDeployCommand() {
  int rc
  withCredentials([sshUserPrivateKey(credentialsId: env.LM_SSH_STAGING_CREDENTIALS, keyFileVariable: 'LM_SSH_KEY', usernameVariable: 'LM_SSH_USER')]) {
    withCredentials([file(credentialsId: env.LM_KNOWN_HOSTS_CREDENTIALS, variable: 'LM_KNOWN_HOSTS')]) {
      withCredentials([usernamePassword(credentialsId: env.LM_STAGING_DB_CREDENTIALS, usernameVariable: 'LM_STG_DB_USER', passwordVariable: 'LM_STG_DB_PASSWORD')]) {
        withCredentials([string(credentialsId: env.LM_STAGING_SETUP_TOKEN_CREDENTIALS, variable: 'LM_STG_SETUP_TOKEN')]) {
          // app.env 只經 stdin 交給 lm-deploy（Deploy_Host 驗證鍵名後以 0600 寫入）；printf 為 shell 內建指令，
          // 值不出現在任何程序的命令列、主控台或檔案（Req 15.1、15.2）。
          rc = sh(label: 'lm-deploy staging deploy', returnStatus: true, script: stagingSshPrelude() + '''
            rm -f reports/staging/deploy.jsonl
            {
              printf 'CAMPING_DATABASE_NAME=%s\\n' "$LM_STAGING_DB_NAME"
              printf 'CAMPING_DATABASE_USER=%s\\n' "$LM_STG_DB_USER"
              printf 'CAMPING_DATABASE_PASSWORD=%s\\n' "$LM_STG_DB_PASSWORD"
              printf 'CAMPING_SETUP_TOKEN=%s\\n' "$LM_STG_SETUP_TOKEN"
            } | lm_ssh deploy "$LM_IMAGE_DIGEST" --app-env-stdin > reports/staging/deploy.jsonl
          ''')
        }
      }
    }
  }
  return rc
}

/**
 * 在 Deploy_Host 執行 `lm-deploy staging <子命令>`（forced command 綁定 staging，子命令經 SSH_ORIGINAL_COMMAND）；
 * stdout（每行一個 JSON）寫入 reports/staging/<outName>。子命令只有固定的四種；槽位只經環境變數傳入。
 */
int stagingHost(String action, String outName) {
  Map commands = [
    status  : 'lm_ssh status > "$LM_STG_OUT"\n',
    rollback: 'lm_ssh rollback > "$LM_STG_OUT"\n',
    health  : 'lm_ssh health "$LM_STG_COLOR" --wait > "$LM_STG_OUT"\n',
    finalize: 'lm_ssh finalize > "$LM_STG_OUT"\n',
  ]
  String command = commands[action]
  if (!command || !(outName ==~ /^[a-z-]+\.jsonl?$/)) {
    error('內部錯誤：未知的 lm-deploy 子命令或輸出檔名')
  }
  int rc
  withEnv(["LM_STG_OUT=reports/staging/${outName}"]) {
    withCredentials([sshUserPrivateKey(credentialsId: env.LM_SSH_STAGING_CREDENTIALS, keyFileVariable: 'LM_SSH_KEY', usernameVariable: 'LM_SSH_USER')]) {
      withCredentials([file(credentialsId: env.LM_KNOWN_HOSTS_CREDENTIALS, variable: 'LM_KNOWN_HOSTS')]) {
        rc = sh(label: 'lm-deploy staging ' + action, returnStatus: true, script: stagingSshPrelude() + command)
      }
    }
  }
  return rc
}

/** SSH 用戶端函式：只使用 Credential_Store 的 Staging 金鑰與 known_hosts，不讀取任何 ssh_config 或 agent。 */
String stagingSshPrelude() {
  return '''
    set +x
    set -eu
    lm_ssh() {
      ssh -F /dev/null -T \
        -i "$LM_SSH_KEY" -l "$LM_SSH_USER" -p "$LM_DEPLOY_PORT" \
        -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none \
        -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$LM_KNOWN_HOSTS" -o GlobalKnownHostsFile=/dev/null \
        -o UpdateHostKeys=no -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
        -o LogLevel=ERROR \
        "$LM_DEPLOY_HOST" "$@"
    }
  '''
}

/** 部署前簽章驗證（Req 17.7、17.8）：唯讀拉取帳號 + Credential_Store 的公鑰；結果寫入 reports/staging/signature.json。 */
int verifyStagingSignature() {
  int rc
  withCredentials([usernamePassword(credentialsId: env.LM_REGISTRY_PULL_CREDENTIALS, usernameVariable: 'LM_REG_USER', passwordVariable: 'LM_REG_PASSWORD')]) {
    withCredentials([file(credentialsId: env.LM_COSIGN_PUBLIC_KEY_CREDENTIALS, variable: 'LM_COSIGN_PUB_FILE')]) {
      timeout(time: 10, unit: 'MINUTES') {
        rc = sh(label: 'cosign verify（Staging 部署前）', returnStatus: true, script: '''
          set +x
          set -u
          rm -f reports/staging/signature.json reports/staging/verify.log
          registry="${LM_IMAGE_REPO%%/*}"
          DOCKER_CONFIG="$LM_STG_DIR/docker-verify"
          export DOCKER_CONFIG
          rm -rf "$DOCKER_CONFIG"
          mkdir -m 0700 "$DOCKER_CONFIG"
          trap 'docker logout "$registry" > /dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"' EXIT
          printf '%s' "$LM_REG_PASSWORD" | docker login --username "$LM_REG_USER" --password-stdin "$registry" > /dev/null 2>&1 || exit 20
          rc=0
          timeout --kill-after=10 300 docker run --rm \
            --label "lm.ci.build=$BUILD_TAG" --label "lm.ci.staging=$LM_STG_RUN" \
            --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m -e HOME=/tmp -e TUF_ROOT=/tmp/tuf \
            --security-opt no-new-privileges:true --cap-drop ALL --network bridge \
            -e DOCKER_CONFIG=/docker-config -e SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
            --mount "type=bind,src=$LM_COSIGN_PUB_FILE,dst=/keys/cosign.pub,readonly" \
            --mount "type=bind,src=$DOCKER_CONFIG,dst=/docker-config,readonly" \
            --mount "type=bind,src=$LM_SCAN_CA_BUNDLE,dst=/etc/ssl/certs/ca-certificates.crt,readonly" \
            "$LM_COSIGN_IMAGE" verify --key /keys/cosign.pub --insecure-ignore-tlog=true --output json \
            "$LM_IMAGE_REPO@$LM_IMAGE_DIGEST" > reports/staging/signature.json 2> reports/staging/verify.log || rc=$?
          if [ "$rc" -ne 0 ]; then
            exit 32
          fi
          exit 0
        ''')
      }
    }
  }
  return rc
}

/**
 * staging-verified attestation：推送帳號、cosign 私鑰（檔案）、密碼與公鑰只在此巢狀 withCredentials 內；
 * `cosign attest --tlog-upload=false` 以 digest（不是標籤）附上 predicate，再以公鑰 `cosign verify-attestation` 取回。
 */
int attestStaging() {
  int rc
  withCredentials([usernamePassword(credentialsId: env.LM_REGISTRY_PUSH_CREDENTIALS, usernameVariable: 'LM_PUSH_USER', passwordVariable: 'LM_PUSH_PASSWORD')]) {
    withCredentials([file(credentialsId: env.LM_COSIGN_KEY_CREDENTIALS, variable: 'LM_COSIGN_KEY_FILE')]) {
      withCredentials([string(credentialsId: env.LM_COSIGN_PASSPHRASE_CREDENTIALS, variable: 'LM_COSIGN_PASSWORD')]) {
        withCredentials([file(credentialsId: env.LM_COSIGN_PUBLIC_KEY_CREDENTIALS, variable: 'LM_COSIGN_PUB_FILE')]) {
          timeout(time: 15, unit: 'MINUTES') {
            rc = sh(label: 'cosign attest + verify-attestation（staging-verified）', returnStatus: true, script: '''
              set +x
              set -u
              rm -f reports/staging/attest.log reports/staging/attestation.jsonl reports/staging/verify-attestation.log
              rm -f "$LM_STG_DIR/in/predicate.json"
              cp reports/staging/predicate.json "$LM_STG_DIR/in/predicate.json" || exit 39
              registry="${LM_IMAGE_REPO%%/*}"
              DOCKER_CONFIG="$LM_STG_DIR/docker-attest"
              export DOCKER_CONFIG
              rm -rf "$DOCKER_CONFIG"
              mkdir -m 0700 "$DOCKER_CONFIG"
              trap 'docker logout "$registry" > /dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"' EXIT
              printf '%s' "$LM_PUSH_PASSWORD" | docker login --username "$LM_PUSH_USER" --password-stdin "$registry" > /dev/null 2>&1 || exit 20
              COSIGN_PASSWORD="$LM_COSIGN_PASSWORD"
              export COSIGN_PASSWORD
              cosign() {
                timeout --kill-after=10 300 docker run --rm \
                  --label "lm.ci.build=$BUILD_TAG" --label "lm.ci.staging=$LM_STG_RUN" \
                  --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m -e HOME=/tmp -e TUF_ROOT=/tmp/tuf \
                  --security-opt no-new-privileges:true --cap-drop ALL --network bridge \
                  -e COSIGN_PASSWORD -e DOCKER_CONFIG=/docker-config -e SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
                  --mount "type=bind,src=$LM_COSIGN_KEY_FILE,dst=/keys/cosign.key,readonly" \
                  --mount "type=bind,src=$LM_COSIGN_PUB_FILE,dst=/keys/cosign.pub,readonly" \
                  --mount "type=bind,src=$DOCKER_CONFIG,dst=/docker-config,readonly" \
                  --mount "type=bind,src=$LM_SCAN_CA_BUNDLE,dst=/etc/ssl/certs/ca-certificates.crt,readonly" \
                  --mount "type=bind,src=$LM_STG_DIR/in,dst=/in,readonly" \
                  "$LM_COSIGN_IMAGE" "$@"
              }
              ref="$LM_IMAGE_REPO@$LM_IMAGE_DIGEST"
              cosign attest --yes --key /keys/cosign.key --tlog-upload=false --type "$LM_STAGING_PREDICATE_TYPE" \
                --predicate /in/predicate.json "$ref" > reports/staging/attest.log 2>&1 || exit 40
              unset COSIGN_PASSWORD
              cosign verify-attestation --key /keys/cosign.pub --insecure-ignore-tlog=true --type "$LM_STAGING_PREDICATE_TYPE" \
                "$ref" > reports/staging/attestation.jsonl 2> reports/staging/verify-attestation.log || exit 41
              exit 0
            ''')
          }
        }
      }
    }
  }
  return rc
}

/**
 * Smoke_Test（Req 18.3）：Build_Image 容器內經 LAN 對 Staging 代理執行 scripts/smoke.mjs，10 分鐘上限（每步另有 10 秒逾時）。
 * 合成帳號 smoke-bot 的密碼只以 Jenkins file credential 的路徑（CAMPING_SMOKE_PASSWORD_FILE）提供。逾時或中止回傳 124。
 */
int runStagingSmoke() {
  int rc = 124
  String failure = null
  try {
    timeout(time: 10, unit: 'MINUTES') {
      withCredentials([file(credentialsId: env.LM_STAGING_SMOKE_CREDENTIALS, variable: 'CAMPING_SMOKE_PASSWORD_FILE')]) {
        // LM_SCAN_CA_BUNDLE 已由 assertStagingConfig 驗證為絕對路徑；HTTPS 時 Bun 以 NODE_EXTRA_CA_CERTS 信任內部 CA。
        buildImageContainer("--mount type=bind,src=${env.LM_SCAN_CA_BUNDLE},dst=/etc/lm/lan-ca.crt,readonly") {
          withEnv([
            "CAMPING_SMOKE_BASE_URL=${env.LM_STAGING_URL}",
            'CAMPING_SMOKE_USERNAME=smoke-bot',
            'NODE_EXTRA_CA_CERTS=/etc/lm/lan-ca.crt',
          ]) {
            rc = sh(label: 'Smoke_Test（Staging）', returnStatus: true, script: '''
              set +x
              set -u
              rm -f reports/staging/smoke.json
              bun scripts/smoke.mjs > reports/staging/smoke.json
            ''')
          }
        }
      }
    }
  } catch (err) {
    failure = err.getClass().getName()
    rc = 124
  }
  if (failure != null) {
    echo "runStagingSmoke: ${failure}"
    echo 'Staging 的 Smoke_Test 未於 10 分鐘內完成或被中止'
  }
  return rc
}

/** 在 Build_Image 容器內執行 ci/staging.mjs；extraEnv 只含 Jenkinsfile 內的整數結束碼。回傳結束碼。 */
int stagingCli(String label, List extraEnv, String script) {
  int rc
  withEnv(extraEnv) {
    inBuildImage {
      rc = sh(label: label, returnStatus: true, script: script)
    }
  }
  return rc
}

/**
 * 以 ci/staging.mjs record 產生 Build_Record patch（deployments、backup、rollback、reports）與「Staging」關卡結果，
 * 合併並記錄（Req 14.8、18.4、23.5）。回傳 0 通過、1 未通過；寫入失敗即 error()。需在 Agent 上呼叫。
 */
int recordStagingGate(String stageError) {
  int rc
  withEnv(["LM_STG_STAGE_ERROR=${stageError ?: ''}"]) {
    inBuildImage {
      rc = sh(label: 'Release_Gate Staging', returnStatus: true, script: '''
        set -u
        rm -f reports/gate-staging.json reports/staging-record-patch.json
        mkdir -p reports/staging
        set -- --dir reports/staging --commit "$GIT_COMMIT_FULL" --digest "${LM_IMAGE_DIGEST:-}" \
          --signature "$LM_STG_SIGNATURE" --finalize "$LM_STG_FINALIZE" --attestation "$LM_STG_ATTESTATION" \
          --out-patch reports/staging-record-patch.json --out-gate reports/gate-staging.json
        if [ -n "${LM_STG_STAGE_ERROR:-}" ]; then
          set -- "$@" --stage-error "${LM_STG_STAGE_ERROR:-}"
        fi
        rc=0
        bun ci/staging.mjs record "$@" || rc=$?
        if [ "$rc" -gt 1 ]; then
          exit "$rc"
        fi
        bun ci/record.mjs merge --record "$LM_RECORD" --patch reports/staging-record-patch.json || exit 3
        bun ci/record.mjs gate --record "$LM_RECORD" --result reports/gate-staging.json || exit 3
        exit "$rc"
      ''')
    }
  }
  if (rc != 0 && rc != 1) {
    error('無法將 Staging 結果與「Staging」關卡寫入 Build_Record')
  }
  env.LM_STG_GATE_DONE = 'true'
  return rc
}

/** 讀取 ci/staging.mjs 輸出的 JSON 檔；不存在、讀取或解析失敗回傳空 Map（呼叫端視為未通過）。 */
Map readJsonFile(String path) {
  if (!fileExists(path)) { return [:] }
  String text = readFile(path)
  return parseJsonObject(text)
}

/** 整份文字為一個 JSON 物件，否則取最後一個非空行；皆失敗回傳空 Map。 */
@NonCPS
Map parseJsonObject(String text) {
  List candidates = [(text ?: '').trim()]
  List lines = (text ?: '').tokenize('\n').findAll { it.trim() }
  if (!lines.isEmpty()) { candidates << lines[-1].trim() }
  for (Object c : candidates) {
    try {
      Object parsed = parseJsonText(c.toString())
      if (parsed instanceof Map) { return (Map) parsed }
    } catch (Exception ignored) {
      // 嘗試下一個候選
    }
  }
  return [:]
}

/** Staging Deploy 失敗、逾時或中止：尚未記錄時記錄「Staging」關卡未通過（Req 23.1、23.3）。不改變原本的失敗原因。 */
void stagingStageFailed() {
  catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
    if (env.LM_STG_ELIGIBLE == 'true' && env.LM_STG_GATE_DONE != 'true') {
      recordStagingGate(stgStageError())
    }
  }
}

// ------------------------------------------------------------------ Release_Tag：Image_Digest 解析、「映像」「Staging」關卡與版本標籤

void relStep(String reason) {
  env.LM_REL_STAGE_ERROR = reason
}

String relStageError() {
  return env.LM_REL_STAGE_ERROR ?: 'Resolve Digest 階段執行失敗或已中止'
}

/** 建置摘要附加一行（不覆寫既有描述）；內容只含固定文字、已驗證的 SHA、digest、Tag 與 Jenkins 帳號。 */
void appendSummary(String line) {
  String current = currentBuild.description ?: ''
  currentBuild.description = current ? "${current}<br>${line}".toString() : line
}

/** Build_Agent 本地時間（含時區的 ISO 8601，例如 2026-01-01T08:00:00+08:00）。 */
String isoNow() {
  String now = sh(label: 'date', returnStdout: true, script: 'date +%Y-%m-%dT%H:%M:%S%:z').trim()
  if (!(now ==~ /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}$/)) {
    error('無法取得含時區的時間')
  }
  return now
}

/** Release_Tag 的前提（Req 1.4、23.2）：本次建置的「QA」、「安全」與含 DAST 的「安全」關卡皆已記錄、通過且屬於本次 commit。 */
void requireReleaseQualityGates() {
  List checks = [
    ['reports/gate-qa.json', 'QA'],
    ['reports/gate-security.json', '安全'],
    ['reports/gate-security-dast.json', '安全（含 DAST）'],
  ]
  List failed = []
  for (List c : checks) {
    String text = fileExists(c[0]) ? readFile(c[0]) : ''
    if (!gatePassed(text, env.GIT_COMMIT_FULL ?: '')) { failed << c[1] }
  }
  if (!failed.isEmpty()) {
    error("Release_Gate ${failed.join('、')} 未通過或結果缺失，不評估「映像」關卡、不進入核准（Req 1.4、23.2）")
  }
}

/** Release_Tag 階段的非秘密設定：Tag 格式、App_Image repository、crane／cosign 映像（digest 固定）、CA 與 predicate type。 */
void assertReleaseConfig() {
  if (!isReleaseTag(env.TAG_NAME ?: '')) {
    error('TAG_NAME 不是有效的 Release_Tag')
  }
  String registry = env.BUILD_IMAGE.substring(0, env.BUILD_IMAGE.indexOf('/'))
  for (Object ref in [env.LM_CRANE_IMAGE, env.LM_COSIGN_IMAGE]) {
    String s = ref ? ref.toString() : ''
    if (!isPinnedImage(s) || !s.startsWith(registry + '/')) {
      error('LM_CRANE_IMAGE／LM_COSIGN_IMAGE 必須以 <LAN Registry>/<repo>@sha256:<64 hex> 引用；請以實際 digest 取代 Jenkinsfile 中的 PLACEHOLDER')
    }
  }
  String repo = env.LM_IMAGE_REPO ?: ''
  if (!(repo ==~ /^[a-z0-9][a-z0-9.\-]*(:[0-9]+)?\/[a-z0-9][a-z0-9._\/\-]*$/) || !repo.startsWith(registry + '/')) {
    error('LM_IMAGE_REPO 必須是 Build_Image 所在 LAN Registry 內的 repository（不含 tag 或 digest）')
  }
  String ca = env.LM_SCAN_CA_BUNDLE ?: ''
  if (!(ca ==~ /^\/[A-Za-z0-9._\/-]+$/) || ca.contains('..')) {
    error('LM_SCAN_CA_BUNDLE 必須是絕對路徑')
  }
  if (env.LM_STAGING_PREDICATE_TYPE != 'https://little-moments.lan/attestations/staging-verified/v1') {
    error('LM_STAGING_PREDICATE_TYPE 必須與 ci/resolve-digest.mjs 的 STAGING_PREDICATE_TYPE 相同')
  }
}

/** 本階段的工作目錄（$WORKSPACE_TMP/lm-release-<id>，0700：docker 登入資訊與 Jenkins API token 暫存檔）。需在 Agent 上執行。 */
void prepareReleaseWork() {
  String suffix = sh(label: 'release work id', returnStdout: true, script: 'od -An -N8 -tx1 /dev/urandom | tr -d " \\n"').trim()
  if (!(suffix ==~ /^[0-9a-f]{16}$/)) { error('無法產生 Release 工作識別碼') }
  env.LM_REL_RUN = "lm-release-${suffix}"
  env.LM_REL_DIR = "${env.WORKSPACE_TMP}/${env.LM_REL_RUN}"
  sh(label: 'prepare release work', script: '''
    set -eu
    rm -rf "$LM_REL_DIR"
    mkdir -p "$LM_REL_DIR" reports/release reports/production
    chmod 0700 "$LM_REL_DIR"
  ''')
}

/** 移除本階段的 crane／cosign 容器與工作目錄（含 docker 登入資訊與 API token）；可重複呼叫。需在 Agent 上執行。 */
void cleanupReleaseWork() {
  if (!env.LM_REL_RUN) { return }
  sh(label: 'cleanup release work', script: '''
    set +x
    set -u
    for id in $(docker ps -aq --filter "label=lm.ci.release=$LM_REL_RUN" 2>/dev/null); do
      docker rm -f "$id" > /dev/null 2>&1 || true
    done
    case "$LM_REL_DIR" in
      "$WORKSPACE_TMP"/lm-release-*) rm -rf -- "$LM_REL_DIR" ;;
    esac
  ''')
  env.LM_REL_RUN = ''
}

/**
 * 唯讀 Registry 操作（唯讀拉取帳號 + Credential_Store 的 cosign 公鑰）；結束碼與輸出保存於 reports/，由 ci/resolve-digest.mjs
 * 或 ci/production.mjs 判讀。action 只有固定的六種；digest 只經環境變數傳入。回傳 crane／cosign 的結束碼（登入失敗為 20）。
 */
int releaseRegistry(String action) {
  if (!(action in ['lookup', 'verify', 'attestation', 'tag-get', 'config', 'verify-prod'])) {
    error('內部錯誤：未知的 Registry 操作')
  }
  // config 的 digest 由呼叫端以 withEnv 提供（LM_REL_CONFIG_DIGEST），其餘操作不使用。
  if (action == 'config' && !((env.LM_REL_CONFIG_DIGEST ?: '') ==~ /^sha256:[0-9a-f]{64}$/)) {
    error('內部錯誤：crane config 需要有效的 digest')
  }
  int rc
  withEnv(["LM_REL_ACTION=${action}"]) {
    withCredentials([usernamePassword(credentialsId: env.LM_REGISTRY_PULL_CREDENTIALS, usernameVariable: 'LM_REG_USER', passwordVariable: 'LM_REG_PASSWORD')]) {
      withCredentials([file(credentialsId: env.LM_COSIGN_PUBLIC_KEY_CREDENTIALS, variable: 'LM_COSIGN_PUB_FILE')]) {
        timeout(time: 10, unit: 'MINUTES') {
          rc = sh(label: 'Registry（' + action + '）', returnStatus: true, script: '''
            set +x
            set -u
            mkdir -p reports/release reports/production
            registry="${LM_IMAGE_REPO%%/*}"
            DOCKER_CONFIG="$LM_REL_DIR/docker-pull"
            export DOCKER_CONFIG
            rm -rf "$DOCKER_CONFIG"
            mkdir -m 0700 "$DOCKER_CONFIG"
            trap 'docker logout "$registry" > /dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"' EXIT
            printf '%s' "$LM_REG_PASSWORD" | docker login --username "$LM_REG_USER" --password-stdin "$registry" > /dev/null 2>&1 || exit 20
            tool() {
              timeout --kill-after=10 300 docker run --rm \
                --label "lm.ci.build=$BUILD_TAG" --label "lm.ci.release=$LM_REL_RUN" \
                --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m -e HOME=/tmp -e TUF_ROOT=/tmp/tuf \
                --security-opt no-new-privileges:true --cap-drop ALL --network bridge \
                -e DOCKER_CONFIG=/docker-config -e SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
                --mount "type=bind,src=$LM_COSIGN_PUB_FILE,dst=/keys/cosign.pub,readonly" \
                --mount "type=bind,src=$DOCKER_CONFIG,dst=/docker-config,readonly" \
                --mount "type=bind,src=$LM_SCAN_CA_BUNDLE,dst=/etc/ssl/certs/ca-certificates.crt,readonly" \
                "$@"
            }
            ref="$LM_IMAGE_REPO@${LM_IMAGE_DIGEST:-}"
            rc=0
            case "$LM_REL_ACTION" in
              lookup)
                rm -f reports/release/sha-tag.out reports/release/sha-tag.err
                tool "$LM_CRANE_IMAGE" digest "$LM_IMAGE_REPO:$GIT_COMMIT_FULL" \
                  > reports/release/sha-tag.out 2> reports/release/sha-tag.err || rc=$?
                ;;
              verify)
                rm -f reports/release/signature.json reports/release/verify.log
                tool "$LM_COSIGN_IMAGE" verify --key /keys/cosign.pub --insecure-ignore-tlog=true --output json "$ref" \
                  > reports/release/signature.json 2> reports/release/verify.log || rc=$?
                ;;
              attestation)
                rm -f reports/release/staging-attestation.jsonl reports/release/verify-attestation.log
                tool "$LM_COSIGN_IMAGE" verify-attestation --key /keys/cosign.pub --insecure-ignore-tlog=true \
                  --type "$LM_STAGING_PREDICATE_TYPE" "$ref" \
                  > reports/release/staging-attestation.jsonl 2> reports/release/verify-attestation.log || rc=$?
                ;;
              tag-get)
                rm -f reports/release/version-tag.out reports/release/version-tag.err
                tool "$LM_CRANE_IMAGE" digest "$LM_IMAGE_REPO:$TAG_NAME" \
                  > reports/release/version-tag.out 2> reports/release/version-tag.err || rc=$?
                ;;
              config)
                rm -f reports/production/active-config.json
                tool "$LM_CRANE_IMAGE" config "$LM_IMAGE_REPO@$LM_REL_CONFIG_DIGEST" \
                  > reports/production/active-config.json 2> /dev/null || rc=$?
                ;;
              verify-prod)
                rm -f reports/production/signature.json reports/production/verify.log
                tool "$LM_COSIGN_IMAGE" verify --key /keys/cosign.pub --insecure-ignore-tlog=true --output json "$ref" \
                  > reports/production/signature.json 2> reports/production/verify.log || rc=$?
                ;;
              *)
                exit 2
                ;;
            esac
            exit "$rc"
          ''')
        }
      }
    }
  }
  return rc
}

/**
 * 寫入版本標籤（Req 16.6、16.10）：推送帳號只在此 withCredentials 內，docker 登入資訊只存在本階段工作目錄。
 * `crane tag <repo>@<digest> <Release_Tag>` 後立即 `crane digest <repo>:<Release_Tag>`，結束碼寫入檔案供判讀
 * （檢查與寫入之間的並行寫入由 version-tag-verify 偵測）。回傳 0 已寫入；20 登入失敗；30 crane tag 失敗。
 */
int pushVersionTag() {
  int rc
  withCredentials([usernamePassword(credentialsId: env.LM_REGISTRY_PUSH_CREDENTIALS, usernameVariable: 'LM_PUSH_USER', passwordVariable: 'LM_PUSH_PASSWORD')]) {
    timeout(time: 10, unit: 'MINUTES') {
      rc = sh(label: 'crane tag（Release_Tag 版本標籤）', returnStatus: true, script: '''
        set +x
        set -u
        rm -f reports/release/version-tag-set.log reports/release/version-tag-after.out reports/release/version-tag-after.err reports/release/version-tag-after.exit
        registry="${LM_IMAGE_REPO%%/*}"
        DOCKER_CONFIG="$LM_REL_DIR/docker-push"
        export DOCKER_CONFIG
        rm -rf "$DOCKER_CONFIG"
        mkdir -m 0700 "$DOCKER_CONFIG"
        trap 'docker logout "$registry" > /dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"' EXIT
        printf '%s' "$LM_PUSH_PASSWORD" | docker login --username "$LM_PUSH_USER" --password-stdin "$registry" > /dev/null 2>&1 || exit 20
        crane() {
          timeout --kill-after=10 120 docker run --rm \
            --label "lm.ci.build=$BUILD_TAG" --label "lm.ci.release=$LM_REL_RUN" \
            --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m -e HOME=/tmp \
            --security-opt no-new-privileges:true --cap-drop ALL --network bridge \
            -e DOCKER_CONFIG=/docker-config -e SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
            --mount "type=bind,src=$DOCKER_CONFIG,dst=/docker-config,readonly" \
            --mount "type=bind,src=$LM_SCAN_CA_BUNDLE,dst=/etc/ssl/certs/ca-certificates.crt,readonly" \
            "$LM_CRANE_IMAGE" "$@"
        }
        crane tag "$LM_IMAGE_REPO@$LM_IMAGE_DIGEST" "$TAG_NAME" > reports/release/version-tag-set.log 2>&1 || exit 30
        rc=0
        crane digest "$LM_IMAGE_REPO:$TAG_NAME" > reports/release/version-tag-after.out 2> reports/release/version-tag-after.err || rc=$?
        printf '%s\\n' "$rc" > reports/release/version-tag-after.exit
        exit 0
      ''')
    }
  }
  return rc
}

/** 在 Build_Image 容器內執行 ci/ 判讀工具；extraEnv 只含 Jenkinsfile 內的整數、固定路徑或已驗證的值。回傳結束碼。 */
int releaseCli(String label, List extraEnv, String script) {
  int rc
  withEnv(extraEnv) {
    inBuildImage {
      rc = sh(label: label, returnStatus: true, script: script)
    }
  }
  return rc
}

/** 將 ci/resolve-digest.mjs step 產生的關卡結果寫入 Build_Record（Req 23.5）；寫入失敗即 error()。 */
void recordReleaseGate(String file) {
  int rc
  withEnv(["LM_REL_GATE_FILE=${file}"]) {
    inBuildImage {
      rc = sh(label: 'Release_Gate（Release_Tag）', returnStatus: true, script: 'bun ci/record.mjs gate --record "$LM_RECORD" --result "$LM_REL_GATE_FILE"')
    }
  }
  if (rc != 0) {
    error('無法將關卡結果寫入 Build_Record')
  }
  env.LM_REL_PENDING_GATE = ''
}

/**
 * 以 fingerprint（MD5(`<digest>\n`)）找回產生該 Image_Digest 的 main Build_Record（Design §17）：唯讀 Jenkins API token
 * 寫入本階段 0700 目錄的 0600 檔再交給 Build_Image 容器讀取（不經 docker exec --env），結束時一律刪除。
 * 回傳 ci/digest-lookup.mjs 的結束碼（0 查得；1 查無；2 參數錯誤；3 Jenkins 查詢失敗）。
 */
int fetchMainRecord() {
  int rc = 3
  withEnv(["LM_REL_TOKEN_DIR=${env.LM_REL_DIR}/jenkins-api"]) {
    try {
      withCredentials([usernamePassword(credentialsId: env.LM_JENKINS_API_CREDENTIALS, usernameVariable: 'LM_JENKINS_API_USER_SRC', passwordVariable: 'LM_JENKINS_API_TOKEN_SRC')]) {
        sh(label: 'stage Jenkins API token', script: '''
          set +x
          set -eu
          umask 077
          rm -rf "$LM_REL_TOKEN_DIR"
          mkdir -m 0700 "$LM_REL_TOKEN_DIR"
          printf '%s' "$LM_JENKINS_API_TOKEN_SRC" > "$LM_REL_TOKEN_DIR/token"
          printf '%s' "$LM_JENKINS_API_USER_SRC" > "$LM_REL_TOKEN_DIR/user"
        ''')
      }
      inBuildImage {
        rc = sh(label: 'ci/digest-lookup.mjs（main Build_Record）', returnStatus: true, script: '''
          set +x
          set -u
          rm -f reports/release/main-build-record.json reports/release/digest-lookup.json
          LM_JENKINS_API_USER="$(cat "$LM_REL_TOKEN_DIR/user")"
          LM_JENKINS_API_TOKEN_FILE="$LM_REL_TOKEN_DIR/token"
          export LM_JENKINS_API_USER LM_JENKINS_API_TOKEN_FILE
          bun ci/digest-lookup.mjs --digest "$LM_IMAGE_DIGEST" --commit "$GIT_COMMIT_FULL" \
            --out reports/release/digest-lookup.json --main-record-out reports/release/main-build-record.json > /dev/null
        ''')
      }
    } finally {
      sh(label: 'remove Jenkins API token', script: '''
        set +x
        case "$LM_REL_TOKEN_DIR" in
          "$WORKSPACE_TMP"/lm-release-*/jenkins-api) rm -rf -- "$LM_REL_TOKEN_DIR" ;;
        esac
      ''')
    }
  }
  return rc
}

/**
 * 持有 Release_Tag 的工作目錄時執行：完整 SHA 標籤 → digest（Req 1.10）→「映像」關卡 →「Staging」關卡（Req 19.5）。
 * 任一步未通過即記錄關卡、於建置摘要顯示原因並失敗；不進入核准。
 */
void resolveReleaseImage() {
  String sha = env.GIT_COMMIT_FULL ?: ''
  // 查得 digest 為評估「映像」關卡的第一步：此後任何失敗由 post 記錄「映像」未通過（Req 23.3）。
  env.LM_REL_PENDING_GATE = 'image'

  // 1. `<repo>:<完整 SHA>` → Image_Digest（Req 1.4、1.10）
  relStep('Registry 查詢失敗，無法確認該 commit 的 Image_Digest（不視為查無）')
  int craneRc = releaseRegistry('lookup')
  if (craneRc == 20) {
    appendSummary("Release_Tag ${env.TAG_NAME}：無法以 ${env.LM_REGISTRY_PULL_CREDENTIALS} 登入 Registry，未能查詢 Image_Digest".toString())
    error("無法以 ${env.LM_REGISTRY_PULL_CREDENTIALS} 登入 Registry，無法查詢 Image_Digest；不進入核准")
  }
  int rc = releaseCli('ci/resolve-digest.mjs step lookup', ["LM_REL_EXIT=${craneRc}"], '''
    set -u
    rm -f reports/release/lookup.json
    bun ci/resolve-digest.mjs step lookup --commit "$GIT_COMMIT_FULL" --exit "$LM_REL_EXIT" \
      --stdout reports/release/sha-tag.out --stderr reports/release/sha-tag.err --out reports/release/lookup.json
  ''')
  if (rc == 1) {
    String why = "commit ${sha} 查無由 main 建置產生的 Image_Digest".toString()
    relStep(why)
    appendSummary("${why}；未進入核准，Production 未變更（Req 1.10）".toString())
    mergeRecordPatch('reports/release-lookup-record-patch.json', [
      image: [digest: '不適用'],
      reports: [releaseLookup: 'reports/release/lookup.json'],
    ])
    error("${why}，不進入核准、不執行任何 Production 階段（Req 1.10）")
  }
  if (rc != 0) {
    appendSummary("commit ${sha}：Registry 查詢失敗，無法確認 Image_Digest（不視為查無）".toString())
    error('Registry 查詢失敗，無法確認該 commit 的 Image_Digest（見 reports/release/lookup.json）；不進入核准')
  }
  Map lookup = readJsonFile('reports/release/lookup.json')
  String digest = lookup.digest instanceof String ? lookup.digest : ''
  if (!(digest ==~ /^sha256:[0-9a-f]{64}$/) || lookup.commit != sha) {
    error('Image_Digest 查詢結果無效（見 reports/release/lookup.json）')
  }
  env.LM_IMAGE_DIGEST = digest
  writeFile(file: 'reports/image-digest.txt', text: "${digest}\n".toString())
  mergeRecordPatch('reports/release-digest-record-patch.json', [
    image: [digest: digest, tags: [sha]],
    reports: [imageDigest: 'reports/image-digest.txt', releaseLookup: 'reports/release/lookup.json'],
  ])
  // 與 main 建置相同的 fingerprint（MD5(`<digest>\n`)），release/digest-lookup 可由 digest 找回本 Build_Record（Req 21.7）。
  archiveArtifacts(artifacts: 'reports/image-digest.txt', fingerprint: true)

  // 2. 「映像」關卡：Credential_Store 公鑰驗證簽章 + main Build_Record 的 commit、digest 與 SBOM（Req 1.4、23.2）
  relStep('Image_Digest 的簽章驗證或 main Build_Record 查詢無法完成')
  int sigRc = releaseRegistry('verify')
  if (sigRc == 20) {
    error("無法以 ${env.LM_REGISTRY_PULL_CREDENTIALS} 登入 Registry，未驗證簽章；不進入核准")
  }
  int recRc = fetchMainRecord()
  rc = releaseCli('ci/resolve-digest.mjs step image', ["LM_REL_SIG_EXIT=${sigRc}"], '''
    set -u
    rm -f reports/gate-image-release.json
    bun ci/resolve-digest.mjs step image --commit "$GIT_COMMIT_FULL" --lookup reports/release/lookup.json \
      --signature-exit "$LM_REL_SIG_EXIT" --signature reports/release/signature.json \
      --main-record reports/release/main-build-record.json --out-gate reports/gate-image-release.json
  ''')
  if (!fileExists('reports/gate-image-release.json')) {
    error('「映像」關卡結果缺失，不進入核准')
  }
  recordReleaseGate('reports/gate-image-release.json')
  if (rc != 0) {
    String note = recRc == 0 ? '' : '；無法以 fingerprint 取得產生該 digest 的 main Build_Record'
    appendSummary("Release_Gate「映像」未通過：Image_Digest ${digest} 的簽章或 SBOM 條件未符合${note}（見 reports/gate-image-release.json）".toString())
    error('Release_Gate「映像」未通過（未符合的條件見 Build_Record 與 reports/gate-image-release.json），不進入核准')
  }
  mergeRecordPatch('reports/release-image-record-patch.json', [
    image: [signature: 'verified'],
    reports: [imageSignature: 'reports/release/signature.json', mainBuildRecord: 'reports/release/main-build-record.json'],
  ])

  // 3. 「Staging」關卡：staging-verified attestation（Req 19.5）
  env.LM_REL_PENDING_GATE = 'staging'
  relStep('staging-verified attestation 驗證無法完成')
  int attRc = releaseRegistry('attestation')
  if (attRc == 20) {
    error("無法以 ${env.LM_REGISTRY_PULL_CREDENTIALS} 登入 Registry，未驗證 Staging 紀錄；不進入核准")
  }
  rc = releaseCli('ci/resolve-digest.mjs step staging', ["LM_REL_ATT_EXIT=${attRc}"], '''
    set -u
    rm -f reports/gate-staging-release.json
    bun ci/resolve-digest.mjs step staging --commit "$GIT_COMMIT_FULL" --lookup reports/release/lookup.json \
      --image-gate reports/gate-image-release.json --attestation-exit "$LM_REL_ATT_EXIT" \
      --attestation reports/release/staging-attestation.jsonl --out-gate reports/gate-staging-release.json
  ''')
  if (!fileExists('reports/gate-staging-release.json')) {
    error('「Staging」關卡結果缺失，不進入核准')
  }
  recordReleaseGate('reports/gate-staging-release.json')
  if (rc != 0) {
    appendSummary("Release_Gate「Staging」未通過：Image_Digest ${digest} 缺少 Staging 驗證（Req 19.5）；未進入核准，Production 未變更".toString())
    error('Image_Digest 未記錄為已通過 Staging 驗證，拒絕正式部署且不進入核准（Req 19.5）')
  }
  mergeRecordPatch('reports/release-staging-record-patch.json', [
    reports: [stagingAttestation: 'reports/release/staging-attestation.jsonl'],
  ])
  env.LM_REL_GATES_OK = 'true'
  echo "Release_Tag ${env.TAG_NAME}：${env.LM_IMAGE_REPO}@${digest}（「映像」與「Staging」關卡通過）"
}

/** Resolve Digest 失敗、逾時或中止：尚未記錄時記錄進行中的關卡未通過（Req 23.1、23.3）。不改變原本的失敗原因。 */
void releaseStageFailed() {
  catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
    String pending = env.LM_REL_PENDING_GATE ?: ''
    if (env.LM_REL_ELIGIBLE == 'true' && (pending == 'image' || pending == 'staging')) {
      String file = pending == 'image' ? 'reports/gate-image-release.json' : 'reports/gate-staging-release.json'
      writeFile(file: file, text: JsonOutput.toJson([
        gate: pending == 'image' ? '映像' : 'Staging', pass: false, status: 'error',
        commit: env.GIT_COMMIT_FULL ?: '未執行', unmet: [gateText(relStageError())], reports: [],
      ]))
      recordReleaseGate(file)
    }
  }
}

/** Version Tag／Approval 的前提：「映像」與「Staging」關卡（Release_Tag）皆已記錄、通過且屬於本次 commit，digest 有效。 */
void requireReleaseGatesPassed() {
  List failed = []
  for (List c : [['reports/gate-image-release.json', '映像'], ['reports/gate-staging-release.json', 'Staging']]) {
    String text = fileExists(c[0]) ? readFile(c[0]) : ''
    if (!gatePassed(text, env.GIT_COMMIT_FULL ?: '')) { failed << c[1] }
  }
  if (env.LM_REL_GATES_OK != 'true' || !((env.LM_IMAGE_DIGEST ?: '') ==~ /^sha256:[0-9a-f]{64}$/)) {
    failed << 'Resolve Digest'
  }
  if (!failed.isEmpty()) {
    error("Release_Gate ${failed.join('、')} 未通過或結果缺失，不進入核准或 Production 部署（Req 19.5、23.2）")
  }
}

/** 版本標籤：create → crane tag → 確認；noop → 不動作；conflict → 拒絕覆寫並失敗（Req 16.10）。 */
void applyVersionTag() {
  String tag = env.TAG_NAME ?: ''
  if (!isReleaseTag(tag)) {
    error('TAG_NAME 不是有效的 Release_Tag')
  }
  int getRc = releaseRegistry('tag-get')
  if (getRc == 20) {
    error("無法以 ${env.LM_REGISTRY_PULL_CREDENTIALS} 登入 Registry，無法確認版本標籤")
  }
  int rc = releaseCli('ci/resolve-digest.mjs step version-tag', ["LM_REL_EXIT=${getRc}"], '''
    set -u
    rm -f reports/release/version-tag.json
    bun ci/resolve-digest.mjs step version-tag --digest "$LM_IMAGE_DIGEST" --exit "$LM_REL_EXIT" \
      --stdout reports/release/version-tag.out --stderr reports/release/version-tag.err --out reports/release/version-tag.json
  ''')
  if (rc == 4) {
    appendSummary("版本標籤 ${tag} 已指向不同的 Image_Digest，拒絕覆寫（Req 16.10）".toString())
    error("Registry 中的版本標籤 ${tag} 已指向不同的 Image_Digest，拒絕覆寫並停止 Pipeline（Req 16.10）")
  }
  if (rc != 0) {
    error('Registry 查詢失敗，無法確認版本標籤（見 reports/release/version-tag.json）')
  }
  Map d = readJsonFile('reports/release/version-tag.json')
  if (d.decision == 'create') {
    int setRc = pushVersionTag()
    if (setRc == 20) {
      error("無法以 ${env.LM_REGISTRY_PUSH_CREDENTIALS} 登入 Registry，未建立版本標籤")
    } else if (setRc != 0) {
      error("crane tag 失敗，未建立版本標籤 ${tag}（見 reports/release/version-tag-set.log）")
    }
    int vRc = releaseCli('ci/resolve-digest.mjs step version-tag-verify', [], '''
      set -u
      bun ci/resolve-digest.mjs step version-tag-verify --digest "$LM_IMAGE_DIGEST" \
        --exit "$(cat reports/release/version-tag-after.exit)" \
        --stdout reports/release/version-tag-after.out --stderr reports/release/version-tag-after.err
    ''')
    if (vRc != 0) {
      appendSummary("版本標籤 ${tag} 寫入後未指向此 Image_Digest（可能有並行寫入），拒絕繼續（Req 16.10）".toString())
      error("版本標籤 ${tag} 寫入後未指向此 Image_Digest，拒絕繼續（Req 16.10）")
    }
  } else if (d.decision != 'noop') {
    error('版本標籤判定結果無效（見 reports/release/version-tag.json）')
  }
  mergeRecordPatch('reports/release-tag-record-patch.json', [
    image: [tags: [env.GIT_COMMIT_FULL, tag]],
    reports: [versionTag: 'reports/release/version-tag.json'],
  ])
  echo "版本標籤 ${tag} → ${env.LM_IMAGE_DIGEST}（${d.decision}）"
}

// ------------------------------------------------------------------ 正式核准與「正式核准」關卡

void aprStep(String reason) {
  env.LM_APR_STAGE_ERROR = reason
}

/** Production 的非秘密設定只接受固定格式；共用的 Release_Tag 設定同樣檢查。 */
void assertProductionConfig() {
  assertReleaseConfig()
  if (!((env.LM_DEPLOY_HOST ?: '') ==~ /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/)) {
    error('LM_DEPLOY_HOST 格式無效')
  }
  if (!((env.LM_DEPLOY_PORT ?: '') ==~ /^[1-9][0-9]{0,4}$/)) {
    error('LM_DEPLOY_PORT 格式無效')
  }
  if (!((env.LM_PROD_URL ?: '') ==~ /^https?:\/\/[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(:[1-9][0-9]{0,4})?$/)) {
    error('LM_PROD_URL 必須是 http(s)://<host>[:port]（不含路徑）')
  }
  if (!((env.LM_PROD_DB_NAME ?: '') ==~ /^[A-Za-z_][A-Za-z0-9_]{0,62}$/)) {
    error('LM_PROD_DB_NAME 格式無效')
  }
}

/**
 * 核准前置作業（只讀取，不變更 Production）：Release_Approver 清單 → `lm-deploy prod status` 的目前版本與其 OCI revision
 * → 需另行核准的破壞性遷移（本次 commit 有、目前版本沒有；無法判定目前版本時為所有破壞性遷移，fail closed）
 * → 封存安全報告供核准畫面連結 → 核准畫面文字。
 */
void prepareApproval() {
  int arc
  inBuildImage {
    arc = sh(label: 'ci/rollback.mjs approvers', returnStatus: true, script: 'bun ci/rollback.mjs approvers > reports/production/approvers.json')
  }
  Map approvers = readJsonFile('reports/production/approvers.json')
  List ids = approvers.approvers instanceof List ? (List) approvers.approvers : []
  boolean idsOk = arc == 0 && !ids.isEmpty()
  for (Object id : ids) {
    if (!(id instanceof String) || !(id ==~ /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/)) { idsOk = false }
  }
  if (!idsOk) {
    error('Release_Approver 清單無效或為空（ci/release-approvers.json），不進入核准')
  }
  env.LM_APR_SUBMITTERS = ids.join(',')

  env.LM_PRD_BASE_DIGEST = ''
  env.LM_PRD_BASE_COMMIT = ''
  int stRc = prodHost('status', 'status-approval.json')
  if (stRc == 0) {
    releaseCli('ci/production.mjs active', [], 'bun ci/production.mjs active --status reports/production/status-approval.json > reports/production/active-approval.json')
    Map a = readJsonFile('reports/production/active-approval.json')
    String base = a.digest instanceof String ? a.digest : ''
    if (base ==~ /^sha256:[0-9a-f]{64}$/) {
      env.LM_PRD_BASE_DIGEST = base
      int cfgRc
      withEnv(["LM_REL_CONFIG_DIGEST=${base}"]) {
        cfgRc = releaseRegistry('config')
      }
      if (cfgRc == 0) {
        releaseCli('ci/production.mjs deployed-commit', [], '''
          bun ci/production.mjs deployed-commit --status reports/production/status-approval.json \
            --config reports/production/active-config.json > reports/production/deployed-commit.json
        ''')
        Map dc = readJsonFile('reports/production/deployed-commit.json')
        if (dc.digest == base && dc.commit instanceof String && dc.commit ==~ /^[0-9a-f]{40}$/) {
          env.LM_PRD_BASE_COMMIT = dc.commit
        }
      }
    }
  } else {
    echo '無法讀取 Production 狀態；所有破壞性遷移皆需另行核准'
  }

  sh(label: 'Production 目前版本的遷移檔', script: '''
    set -u
    rm -f reports/production/deployed-migrations.txt
    if [ -n "${LM_PRD_BASE_COMMIT:-}" ] && git cat-file -e "${LM_PRD_BASE_COMMIT:-}^{commit}" 2>/dev/null; then
      git ls-tree --name-only "${LM_PRD_BASE_COMMIT:-}" -- migrations/ > reports/production/deployed-migrations.txt \
        || rm -f reports/production/deployed-migrations.txt
    fi
  ''')
  int drc = releaseCli('ci/production.mjs destructive', [], '''
    set -u
    rm -f reports/production/destructive.json
    deployed=unknown
    if [ -f reports/production/deployed-migrations.txt ]; then
      deployed=reports/production/deployed-migrations.txt
    fi
    bun ci/production.mjs destructive --migrations migrations --deployed "$deployed" --out reports/production/destructive.json
  ''')
  Map dd = readJsonFile('reports/production/destructive.json')
  if (drc != 0 || !(dd.pending instanceof List)) {
    error('無法判定需另行核准的破壞性遷移，不進入核准（Req 12.6）')
  }
  List pending = []
  for (Object p : (List) dd.pending) {
    if (!(p instanceof Map) || !(p.version instanceof Integer) || !(p.migration instanceof String) ||
        !(p.migration ==~ /^migrations\/[0-9]{4,}_[a-z0-9_]+\.sql$/)) {
      error('破壞性遷移判定結果無效（見 reports/production/destructive.json）')
    }
    pending << [version: p.version, migration: p.migration]
  }
  lmDestructivePending = pending
  env.LM_PRD_DESTRUCTIVE_KNOWN = dd.known == true ? 'true' : 'false'

  // 核准畫面的安全報告連結（Req 19.2）：只封存評估結果與關卡結果（不含掃描原始輸出或秘密值）。
  archiveArtifacts(
    artifacts: 'reports/security/evaluation.json, reports/security/evaluation-dast.json, reports/gate-security.json, reports/gate-security-dast.json',
    allowEmptyArchive: true
  )
  int mrc = releaseCli('ci/production.mjs approval-message', [], '''
    set -u
    rm -f reports/production/approval-message.txt
    bun ci/production.mjs approval-message --tag "$TAG_NAME" --commit "$GIT_COMMIT_FULL" --digest "$LM_IMAGE_DIGEST" \
      --main-record reports/release/main-build-record.json --attestation reports/release/staging-attestation.jsonl \
      --destructive reports/production/destructive.json --build-url "$BUILD_URL" --out reports/production/approval-message.txt
  ''')
  if (mrc != 0 || !fileExists('reports/production/approval-message.txt')) {
    error('無法產生核准畫面內容，不進入核准')
  }
}

/** input 被中止時的操作者（Rejection 的帳號；匿名為空字串）；不是 Rejection（逾時、停止建置）時回傳 null。 */
String inputRejecter(Object err) {
  if (!(err instanceof org.jenkinsci.plugins.workflow.steps.FlowInterruptedException)) { return null }
  for (Object c : err.getCauses()) {
    if (c instanceof org.jenkinsci.plugins.workflow.support.steps.input.Rejection) {
      def u = c.getUser()
      return u == null ? '' : u.getId().toString()
    }
  }
  return null
}

/** input 的送出者（submitterParameter）。 */
String inputSubmitter(Object r) {
  if (r instanceof Map) { return r.approver == null ? '' : r.approver.toString() }
  return r == null ? '' : r.toString()
}

/** 以 ci/approval.mjs isReleaseApprover 再次驗證帳號（Jenkins 管理員可送出任何 input，Req 19.3）。 */
boolean isApprover(String who) {
  if (!(who ==~ /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/)) { return false }
  int rc = releaseCli('ci/approval.mjs release', ["LM_APR_WHO=${who}"], '''
    set -u
    bun ci/approval.mjs release --approver "$LM_APR_WHO" >> reports/production/approval-checks.jsonl 2>&1
  ''')
  return rc == 0
}

/** 破壞性遷移核准人：Release_Approver 且非該遷移的 commit 作者（ci/approval.mjs destructiveApprovalAllowed，Req 12.6）。 */
boolean destructiveAllowed(String who, String migration) {
  if (!(who ==~ /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/) || !(migration ==~ /^migrations\/[0-9]{4,}_[a-z0-9_]+\.sql$/)) { return false }
  int rc = releaseCli('ci/approval.mjs destructive', ["LM_APR_WHO=${who}", "LM_APR_MIGRATION=${migration}"], '''
    set -u
    bun ci/approval.mjs destructive --approver "$LM_APR_WHO" --migration "$LM_APR_MIGRATION" >> reports/production/approval-checks.jsonl 2>&1
  ''')
  return rc == 0
}

/** 不生效的核准／拒絕嘗試（Req 19.3）：只記錄帳號（格式驗證後）、時間、動作與遷移路徑。 */
void recordAttempt(String who, String action, String migration) {
  String at = isoNow()
  String id = who ==~ /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/ ? who : ''
  lmApprovalAttempts << [id: id, at: at, action: action, migration: migration]
  echo "${id ?: '（帳號格式無效）'} 不是${migration ? '可核准此破壞性遷移的' : ''} Release_Approver，操作不生效，維持等待（${action}）"
}

/** 正式核准 input 迴圈：只有 Release_Approver 的核准或拒絕才結束等待。 */
Map releaseApprovalLoop(String message) {
  while (true) {
    def r
    try {
      r = input(id: 'ReleaseApproval', message: message, ok: '核准正式部署', submitter: env.LM_APR_SUBMITTERS, submitterParameter: 'approver')
    } catch (err) {
      String who = inputRejecter(err)
      if (who == null) { throw err }
      if (isApprover(who)) {
        return [decision: 'rejected', rejectedBy: who, rejectedAt: isoNow(), error: err]
      }
      recordAttempt(who, 'reject', '')
      continue
    }
    String who = inputSubmitter(r)
    if (isApprover(who)) {
      return [decision: 'approved', approver: who, at: isoNow()]
    }
    recordAttempt(who, 'approve', '')
  }
}

/** 單一破壞性遷移的核准（與正式發布核准分開，Req 12.6）：Release_Approver 且非該遷移作者才生效。 */
Map destructiveApprovalLoop(Map m) {
  String migration = m.migration.toString()
  String version = m.version.toString()
  if (!(version ==~ /^[0-9]{1,10}$/)) { error('破壞性遷移版本號無效') }
  String message = "破壞性遷移 ${migration}（版本 ${version}）將在部署時套用至 Production 並移除或重新命名欄位或資料表。" +
    "此核准須由非該遷移 commit 作者的 Release_Approver 進行，且與正式發布核准分開。" +
    "Release_Tag：${env.TAG_NAME}；Commit SHA：${env.GIT_COMMIT_FULL}；Image_Digest：${env.LM_IMAGE_DIGEST}"
  while (true) {
    def r
    try {
      r = input(id: "DestructiveMigration${version}", message: message, ok: '核准此破壞性遷移', submitter: env.LM_APR_SUBMITTERS, submitterParameter: 'approver')
    } catch (err) {
      String who = inputRejecter(err)
      if (who == null) { throw err }
      if (isApprover(who)) {
        return [decision: 'rejected', rejectedBy: who, rejectedAt: isoNow(), error: err]
      }
      recordAttempt(who, 'destructive_reject', migration)
      continue
    }
    String who = inputSubmitter(r)
    if (destructiveAllowed(who, migration)) {
      return [decision: 'approved', approver: who, at: isoNow()]
    }
    recordAttempt(who, 'destructive_approve', migration)
  }
}

/**
 * 24 小時核准（Req 19.1–19.4、19.6–19.8、12.6）：正式核准 → 破壞性遷移逐一核准 → `git ls-remote` 確認 Tag 未變更
 * → ci/production.mjs approval-record 寫入 Build_Record 與「正式核准」關卡。逾時、拒絕或中止：記錄後以 ABORTED 結束；
 * Tag 已變更：記錄後失敗。等待期間不對 Production 做任何變更。
 */
void waitForApproval() {
  String message = readFile('reports/production/approval-message.txt').trim()
  if (message.length() > 4000) { message = message.substring(0, 4000) }
  Map decision = [decision: 'aborted']
  def interrupted = null
  long started = System.currentTimeMillis()
  try {
    timeout(time: 24, unit: 'HOURS') {
      Map r = releaseApprovalLoop(message)
      decision = r
      if (r.decision == 'approved') {
        for (Object p : lmDestructivePending) {
          Map m = (Map) p
          Map d = destructiveApprovalLoop(m)
          if (d.decision != 'approved') {
            decision = [decision: 'destructive_rejected', approver: r.approver, at: r.at, error: d.error]
            break
          }
          lmDestructiveApprovals << [version: m.version, migration: m.migration, approver: d.approver, at: d.at]
        }
      }
    }
  } catch (err) {
    interrupted = err
    boolean timedOut = System.currentTimeMillis() - started >= 24L * 60L * 60L * 1000L - 60000L
    decision = [decision: timedOut ? 'timeout' : 'aborted', approver: decision.approver, at: decision.at]
  }
  def rethrow = interrupted ?: decision.error
  if (decision.decision == 'approved' && !verifyTagUnchanged('tag-remote-approval.txt')) {
    decision.decision = 'tag_changed'
  }
  int rc = recordApproval(decision)
  String tag = env.TAG_NAME
  if (decision.decision == 'approved' && rc == 0) {
    env.LM_APPROVED = 'true'
    env.LM_APPROVER = decision.approver.toString()
    echo "正式核准：${env.LM_APPROVER}（${decision.at}），Image_Digest ${env.LM_IMAGE_DIGEST}"
    return
  }
  if (decision.decision == 'rejected' || decision.decision == 'destructive_rejected') {
    String who = decision.rejectedBy ?: (rethrow == null ? '' : inputRejecter(rethrow))
    appendSummary("正式核准：${who ?: 'Release_Approver'} 拒絕${decision.decision == 'rejected' ? '正式部署' : '破壞性遷移'}，已中止；Production 未變更（Req 19.7）".toString())
  } else if (decision.decision == 'timeout') {
    appendSummary("正式核准：${tag} 於 24 小時內未收到 Release_Approver 的核准或拒絕，已中止；Production 未變更（Req 19.4）".toString())
  } else if (decision.decision == 'tag_changed') {
    appendSummary("Release_Tag ${tag} 已變更或無法確認：目前指向的 Commit SHA 與核准畫面的 ${env.GIT_COMMIT_FULL} 不一致，拒絕正式部署（Req 19.8）".toString())
    error("Release_Tag ${tag} 指向的 Commit SHA 與核准畫面顯示的不一致或無法確認，拒絕正式部署（Req 19.8）")
  } else if (decision.decision == 'approved') {
    error('Release_Gate「正式核准」未通過（見 Build_Record 與 reports/gate-approval.json）')
  } else {
    appendSummary("正式核准：${tag} 的核准等待被中止；Production 未變更".toString())
  }
  if (rethrow != null) {
    throw rethrow
  }
  currentBuild.result = 'ABORTED'
  error('正式核准未完成，已中止正式發布；Production 未變更')
}

/**
 * `git ls-remote` 確認 Release_Tag 仍指向本次 Commit SHA（Req 19.8）；annotated tag 取 peeled 值（ci/production.mjs tag-remote）。
 * 無法查詢時視為無法確認（回傳 false，fail closed）。
 */
boolean verifyTagUnchanged(String outName) {
  if (!(outName ==~ /^[a-z-]+\.txt$/)) { error('內部錯誤：輸出檔名無效') }
  int lsRc
  int matchRc = 1
  withEnv(["LM_TAG_OUT=reports/production/${outName}"]) {
    withCredentials([gitUsernamePassword(credentialsId: env.LM_GIT_CREDENTIALS)]) {
      lsRc = sh(label: 'git ls-remote（Release_Tag）', returnStatus: true, script: '''
        set -u
        mkdir -p reports/production
        rm -f "$LM_TAG_OUT" "$LM_TAG_OUT.json"
        git ls-remote origin "refs/tags/$TAG_NAME" "refs/tags/$TAG_NAME^{}" > "$LM_TAG_OUT"
      ''')
    }
    if (lsRc == 0) {
      matchRc = releaseCli('ci/production.mjs tag-remote', [], '''
        set -u
        bun ci/production.mjs tag-remote --result "$LM_TAG_OUT" --tag "$TAG_NAME" --commit "$GIT_COMMIT_FULL" > "$LM_TAG_OUT.json"
      ''')
    }
  }
  Map t = readJsonFile("reports/production/${outName}.json")
  env.LM_TAG_REMOTE_COMMIT = (t.remote instanceof String && t.remote ==~ /^[0-9a-f]{40}$/) ? t.remote : ''
  return lsRc == 0 && matchRc == 0
}

/** 「正式核准」關卡與 Build_Record（ci/production.mjs approval-record → record.mjs merge → gate）。回傳 0 通過、1 未通過。 */
int recordApproval(Map d) {
  Map input = [
    decision: (d.decision ?: 'aborted').toString(),
    approver: d.approver == null ? '' : d.approver.toString(),
    at: d.at == null ? '' : d.at.toString(),
    rejectedBy: d.rejectedBy == null ? '' : d.rejectedBy.toString(),
    rejectedAt: d.rejectedAt == null ? '' : d.rejectedAt.toString(),
    digest: env.LM_IMAGE_DIGEST ?: '',
    tag: env.TAG_NAME ?: '',
    commit: env.GIT_COMMIT_FULL ?: '',
    remoteCommit: env.LM_TAG_REMOTE_COMMIT ?: '',
    attempts: lmApprovalAttempts,
    destructive: lmDestructiveApprovals,
    pendingDestructive: lmDestructivePending,
  ]
  sh(label: 'reports/production', script: 'mkdir -p reports/production')
  writeFile(file: 'reports/production/approval-input.json', text: JsonOutput.toJson(input))
  int rc
  inBuildImage {
    rc = sh(label: 'Release_Gate 正式核准', returnStatus: true, script: '''
      set -u
      rm -f reports/gate-approval.json reports/production/approval-record-patch.json
      rc=0
      bun ci/production.mjs approval-record --in reports/production/approval-input.json \
        --out-patch reports/production/approval-record-patch.json --out-gate reports/gate-approval.json \
        --out-evidence reports/production/approval.json || rc=$?
      if [ "$rc" -gt 1 ]; then
        exit "$rc"
      fi
      bun ci/record.mjs merge --record "$LM_RECORD" --patch reports/production/approval-record-patch.json || exit 3
      bun ci/record.mjs gate --record "$LM_RECORD" --result reports/gate-approval.json || exit 3
      exit "$rc"
    ''')
  }
  if (rc != 0 && rc != 1) {
    error('無法將核准結果與「正式核准」關卡寫入 Build_Record')
  }
  env.LM_APR_GATE_DONE = 'true'
  return rc
}

/** Approval 失敗、逾時或中止：尚未記錄時記錄「正式核准」未通過（Req 23.1、23.3）。不改變原本的結果。 */
void approvalStageFailed() {
  catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
    if (env.LM_APR_ELIGIBLE == 'true' && env.LM_APR_GATE_DONE != 'true') {
      recordApproval([decision: 'aborted'])
    }
  }
}

/** Production 部署的前提（Req 19.1、23.2）：「正式核准」關卡已記錄、通過且屬於本次 commit，digest 有效。 */
void requireApprovalPassed() {
  String text = fileExists('reports/gate-approval.json') ? readFile('reports/gate-approval.json') : ''
  if (env.LM_APPROVED != 'true' || env.LM_APR_GATE_DONE != 'true' || !gatePassed(text, env.GIT_COMMIT_FULL ?: '') ||
      !((env.LM_IMAGE_DIGEST ?: '') ==~ /^sha256:[0-9a-f]{64}$/)) {
    error('Release_Gate「正式核准」未通過或結果缺失，不部署至 Production（Req 19.1、23.2）')
  }
}

// ------------------------------------------------------------------ Production 部署、觀察期與「上線後」關卡

void prdStep(String reason) {
  env.LM_PRD_STAGE_ERROR = reason
}

String prdStageError() {
  return env.LM_PRD_STAGE_ERROR ?: 'Production Deploy 階段執行失敗或已中止'
}

/**
 * 持有 lm-prod 鎖時執行（Req 20.12）：Tag 與目前版本再確認 → 簽章驗證 → deploy → 觀察期 → finalize 或回滾 →「上線後」關卡。
 */
void deployProduction() {
  String digest = env.LM_IMAGE_DIGEST ?: ''

  // 0. 核准後到取得鎖之間可能經過一段時間：再次確認 Tag 未變更（Req 19.8），且 Production 目前版本與核准時相同
  //    （破壞性遷移判定的基準；核准時無法判定目前版本者已要求所有破壞性遷移另行核准，不受影響）。
  prdStep('無法確認 Release_Tag 仍指向核准的 Commit SHA')
  if (!verifyTagUnchanged('tag-remote-deploy.txt')) {
    prdStep('')
    recordProductionGate('Release_Tag 已變更或無法確認，未部署')
    appendSummary("Release_Tag ${env.TAG_NAME}：部署前無法確認 Tag 仍指向 ${env.GIT_COMMIT_FULL}，拒絕正式部署（Req 19.8）".toString())
    error('Release_Tag 已變更或無法確認，拒絕正式部署；Production 未變更（Req 19.8）')
  }
  prdStep('無法取得 Production 狀態')
  int stRc = prodHost('status', 'status-locked.json')
  releaseCli('ci/production.mjs active', [], 'bun ci/production.mjs active --status reports/production/status-locked.json > reports/production/active-locked.json')
  Map a = readJsonFile('reports/production/active-locked.json')
  String base = a.digest instanceof String ? a.digest : ''
  if (stRc != 0 || (env.LM_PRD_DESTRUCTIVE_KNOWN == 'true' && base != (env.LM_PRD_BASE_DIGEST ?: ''))) {
    prdStep('')
    recordProductionGate('Production 目前版本在核准期間已變更或無法取得，破壞性遷移判定已失效，未部署')
    error('Production 目前版本在核准期間已變更或無法取得；未變更 Production，請重新執行 Release_Tag 建置')
  }

  // 1. 部署前以公鑰驗證簽章（Req 17.7、17.8）：未通過即不呼叫 deploy，Production 維持不變。
  prdStep('Image_Digest 的簽章無法以設定的公鑰驗證（見 reports/production/verify.log），未部署')
  int sigRc = releaseRegistry('verify-prod')
  String sigText = fileExists('reports/production/signature.json') ? readFile('reports/production/signature.json') : ''
  boolean sigOk = sigRc == 0 && signatureCovers(sigText, digest)
  env.LM_PRD_SIGNATURE = sigOk ? 'ok' : 'fail'
  if (!sigOk) {
    prdStep('')
    recordProductionGate(sigRc == 20 ? "無法以 ${env.LM_REGISTRY_PULL_CREDENTIALS} 登入 Registry 驗證簽章".toString() : '')
    error('Image_Digest 沒有簽章、簽章無法以設定的公鑰驗證或簽章對象不符，中止 Production 部署；Production 維持不變（Req 17.8）')
  }

  // 2. 部署：備份並驗證 → app.env → Migration_Runner → 閒置槽位以 repo@digest 啟動 → 每 5 秒 Health_Check → 切換。
  prdStep('Production 部署失敗（見 reports/production/deploy.jsonl）')
  env.LM_PRD_DEPLOY_CALLED = 'true'
  int deployRc = 124
  def interrupted = null
  try {
    timeout(time: 75, unit: 'MINUTES') {
      deployRc = productionDeployCommand()
    }
  } catch (err) {
    interrupted = err
    deployRc = 124
  }
  releaseCli('ci/production.mjs classify', ["LM_PRD_EXIT=${deployRc}"], '''
    set -u
    rm -f reports/production/deploy-verdict.json
    bun ci/production.mjs classify --exit "$LM_PRD_EXIT" --result reports/production/deploy.jsonl \
      --digest "$LM_IMAGE_DIGEST" --out reports/production/deploy-verdict.json
  ''')
  Map c = readJsonFile('reports/production/deploy-verdict.json')
  if (interrupted == null && c.outcome == 'refused') {
    prdStep('')
    recordProductionGate('')
    error("Production 部署被拒絕：${gateText(c.message ?: 'lm-deploy 拒絕部署')}")
  }
  String color = c.color instanceof String ? c.color : ''
  if (interrupted != null || c.outcome != 'switched' || !(color ==~ /^(blue|green)$/)) {
    prdStep('Production 部署未完成；已確認或還原前一個 Image_Digest（見 reports/production/restore.json）')
    restoreProduction()
    prdStep('')
    recordProductionGate(interrupted != null ? 'Production 部署逾時或被中止' : '')
    if (interrupted != null) {
      throw interrupted
    }
    error("Production 部署失敗：${gateText(c.message ?: '部署未完成')}；${restoreText()}")
  }

  // 3. 10 分鐘觀察期（Req 20.5、20.6）。逾時、中止或判定需回滾 → 回滾至仍在執行的舊槽位。
  prdStep('觀察期執行失敗或被中止（見 reports/production/observations.json）')
  boolean passed = false
  interrupted = null
  try {
    timeout(time: 15, unit: 'MINUTES') {
      passed = observeProduction(color)
    }
  } catch (err) {
    interrupted = err
    passed = false
  }
  if (!passed) {
    prdStep('「上線後」關卡未通過；已自動回滾（見 reports/production/restore.json）')
    restoreProduction()
    prdStep('')
    recordProductionGate(interrupted != null ? '觀察期逾時或被中止' : '')
    if (interrupted != null) {
      throw interrupted
    }
    error("Release_Gate「上線後」未通過，已自動回滾：${restoreText()}（見 Build_Record 與 reports/gate-post-deploy.json）")
  }
  env.LM_PRD_OBSERVED = 'true'

  // 4. finalize：停止舊槽位、記錄目前版本、保留最近 3 個映像（Req 20.7）→「上線後」關卡。
  prdStep('lm-deploy prod finalize 失敗（見 reports/production/finalize.jsonl）')
  int fRc = prodHost('finalize', 'finalize.jsonl')
  env.LM_PRD_FINALIZE = fRc == 0 ? 'ok' : 'fail'
  prdStep('')
  if (recordProductionGate('') != 0) {
    if (fRc != 0) {
      error("lm-deploy prod finalize 失敗（結束碼 ${fRc}）；新版容器已通過觀察期並持續處理流量，需人工執行 finalize")
    }
    error('Release_Gate「上線後」未通過（見 Build_Record 與 reports/gate-post-deploy.json）')
  }
  echo "Production 已部署：${env.LM_IMAGE_REPO}@${digest}（${env.TAG_NAME}）"
}

/** 回滾或還原結果的摘要文字（固定訊息；不含 lm-deploy 輸出內容）。 */
String restoreText() {
  Map r = readJsonFile('reports/production/restore.json')
  return gateText(r.message ?: '回滾結果未確認，需人工確認 Production 狀態')
}

/**
 * 觀察期：切換後每 10 秒一次 `lm-deploy prod health <color>`（共 60 次），第 1 次後與第 55 次（切換後 540 秒）後各一次
 * Smoke_Test；每筆結果以 ci/production.mjs observe（shouldRollback）判定，需回滾時立即回傳 false（Req 20.6 的 60 秒內）。
 * 結束時以 summary 確認觀察期完整。回傳 true 表示通過。
 */
boolean observeProduction(String color) {
  env.LM_PRD_COLOR = color
  sh(label: 'observation reset', script: 'rm -f reports/production/observations.json reports/production/decision.json')
  long t0 = System.currentTimeMillis()
  for (int i = 0; i < 60; i++) {
    long wait = t0 + i * 10000L - System.currentTimeMillis()
    if (wait > 0) {
      sleep(time: wait, unit: 'MILLISECONDS')
    }
    long healthAt = System.currentTimeMillis() - t0
    int hRc = prodHost('health-once', 'health-last.jsonl')
    if (observeStep('health', hRc, 'reports/production/health-last.jsonl', healthAt, '') != 0) {
      return false
    }
    if (i == 0 || i == 54) {
      String phase = i == 0 ? 'after-switch' : 'before-end'
      long smokeAt = System.currentTimeMillis() - t0
      int sRc = runProductionSmoke("smoke-${phase}.json".toString())
      if (observeStep('smoke', sRc, "reports/production/smoke-${phase}.json".toString(), smokeAt, phase) != 0) {
        return false
      }
    }
  }
  long rest = t0 + 600000L - System.currentTimeMillis()
  if (rest > 0) {
    sleep(time: rest, unit: 'MILLISECONDS')
  }
  int sum = releaseCli('ci/production.mjs summary', [], '''
    bun ci/production.mjs summary --obs reports/production/observations.json --out reports/production/observation-summary.json
  ''')
  return sum == 0
}

/** 追加一筆觀察結果並判定（0 繼續；1 需回滾；2 輸入錯誤，同樣視為需回滾）。t 以毫秒傳入、於 shell 換算為秒。 */
int observeStep(String type, int exitCode, String result, long ms, String phase) {
  return releaseCli('ci/production.mjs observe（' + type + '）', [
    "LM_PRD_OBS_TYPE=${type}", "LM_PRD_OBS_EXIT=${exitCode}", "LM_PRD_OBS_RESULT=${result}",
    "LM_PRD_OBS_MS=${ms}", "LM_PRD_OBS_PHASE=${phase}",
  ], '''
    set -u
    set -- --obs reports/production/observations.json --type "$LM_PRD_OBS_TYPE" --t "$(( LM_PRD_OBS_MS / 1000 ))" \
      --exit "$LM_PRD_OBS_EXIT" --result "$LM_PRD_OBS_RESULT" --out reports/production/decision.json
    if [ "$LM_PRD_OBS_TYPE" = health ]; then
      set -- "$@" --color "$LM_PRD_COLOR"
    else
      set -- "$@" --phase "$LM_PRD_OBS_PHASE"
    fi
    bun ci/production.mjs observe "$@"
  ''')
}

/**
 * Smoke_Test（Req 20.5）：Build_Image 容器內經 LAN 對 Production 代理執行 scripts/smoke.mjs（每步 10 秒逾時，整體 90 秒）。
 * Production 合成帳號 smoke-bot 的密碼只以 Jenkins file credential 的路徑提供。逾時或中止回傳 124。
 */
int runProductionSmoke(String outName) {
  if (!(outName ==~ /^smoke-[a-z-]+\.json$/)) { error('內部錯誤：Smoke_Test 輸出檔名無效') }
  int rc = 124
  String failure = null
  try {
    timeout(time: 90, unit: 'SECONDS') {
      withCredentials([file(credentialsId: env.LM_PROD_SMOKE_CREDENTIALS, variable: 'CAMPING_SMOKE_PASSWORD_FILE')]) {
        buildImageContainer("--mount type=bind,src=${env.LM_SCAN_CA_BUNDLE},dst=/etc/lm/lan-ca.crt,readonly") {
          withEnv([
            "CAMPING_SMOKE_BASE_URL=${env.LM_PROD_URL}",
            'CAMPING_SMOKE_USERNAME=smoke-bot',
            'NODE_EXTRA_CA_CERTS=/etc/lm/lan-ca.crt',
            "LM_PRD_SMOKE_OUT=reports/production/${outName}",
          ]) {
            rc = sh(label: 'Smoke_Test（Production）', returnStatus: true, script: '''
              set +x
              set -u
              rm -f "$LM_PRD_SMOKE_OUT"
              bun scripts/smoke.mjs > "$LM_PRD_SMOKE_OUT"
            ''')
          }
        }
      }
    }
  } catch (err) {
    failure = err.getClass().getName()
    rc = 124
  }
  if (failure != null) {
    echo "runProductionSmoke: ${failure}"
    echo 'Production 的 Smoke_Test 未於 90 秒內完成或被中止'
  }
  return rc
}

/**
 * 回滾或還原（Req 20.4、20.6、20.9、20.11），整體 5 分鐘上限：status → 視需要 `rollback`（自動：未切換即移除新槽位；
 * 已切換即切回前一個槽位並停止新槽位；不執行 Migration_Runner）→ status → 作用中槽位 `health --wait`（120 秒內連續
 * 3 次成功）→ ci/production.mjs restore。只執行一次；未健康或結果不明時不再做任何自動切換，記錄需人工介入。
 */
void restoreProduction() {
  if (env.LM_PRD_RESTORE_DONE == 'true') { return }
  env.LM_PRD_RESTORE_DONE = 'true'
  String failure = null
  try {
    timeout(time: 5, unit: 'MINUTES') {
      prodHost('status', 'status-before-restore.json')
      int need = releaseCli('ci/production.mjs rollback-needed', [], '''
        bun ci/production.mjs rollback-needed --deploy reports/production/deploy-verdict.json \
          --status reports/production/status-before-restore.json --digest "$LM_IMAGE_DIGEST"
      ''')
      int rbRc = -1
      if (need == 0) {
        rbRc = prodHost('rollback', 'rollback.jsonl')
      }
      prodHost('status', 'status-after-restore.json')
      int activeRc = releaseCli('ci/production.mjs active', [], '''
        bun ci/production.mjs active --status reports/production/status-after-restore.json > reports/production/active-after-restore.json
      ''')
      Map a = readJsonFile('reports/production/active-after-restore.json')
      int hRc = -1
      String color = a.color instanceof String ? a.color : ''
      if (activeRc == 0 && color ==~ /^(blue|green)$/) {
        env.LM_PRD_COLOR = color
        hRc = prodHost('health-wait', 'restore-health.jsonl')
      }
      releaseCli('ci/production.mjs restore', ["LM_PRD_RB_EXIT=${rbRc}", "LM_PRD_HEALTH_EXIT=${hRc}"], '''
        set -u
        rm -f reports/production/restore.json
        bun ci/production.mjs restore --status reports/production/status-after-restore.json --digest "$LM_IMAGE_DIGEST" \
          --rollback reports/production/rollback.jsonl --rollback-exit "$LM_PRD_RB_EXIT" \
          --health reports/production/restore-health.jsonl --health-exit "$LM_PRD_HEALTH_EXIT" \
          --out reports/production/restore.json
      ''')
    }
  } catch (err) {
    failure = err.getClass().getName()
  }
  if (failure != null) {
    echo "restoreProduction: ${failure}"
    echo 'Production 回滾未於 5 分鐘內完成或被中止，需人工確認 Production 狀態'
  }
  if (!fileExists('reports/production/restore.json')) {
    writeFile(file: 'reports/production/restore.json', text: JsonOutput.toJson([
      restored: false, newStopped: false, noRestoreTarget: false, target: null, manualIntervention: true,
      code: 'restore_unconfirmed', message: '回滾未於 5 分鐘內完成或結果無法判讀，需人工確認 Production 狀態',
      rollback: [attempted: true, ok: false, code: 'unknown'],
    ]))
  }
}

/** 以 SSH 受限金鑰執行 `lm-deploy prod deploy <digest> --app-env-stdin`；回傳 SSH 結束碼（即 lm-deploy 結束碼，連線失敗為 255）。 */
int productionDeployCommand() {
  int rc
  withCredentials([sshUserPrivateKey(credentialsId: env.LM_SSH_PROD_CREDENTIALS, keyFileVariable: 'LM_SSH_KEY', usernameVariable: 'LM_SSH_USER')]) {
    withCredentials([file(credentialsId: env.LM_KNOWN_HOSTS_CREDENTIALS, variable: 'LM_KNOWN_HOSTS')]) {
      withCredentials([usernamePassword(credentialsId: env.LM_PROD_DB_CREDENTIALS, usernameVariable: 'LM_PRD_DB_USER', passwordVariable: 'LM_PRD_DB_PASSWORD')]) {
        withCredentials([string(credentialsId: env.LM_PROD_SETUP_TOKEN_CREDENTIALS, variable: 'LM_PRD_SETUP_TOKEN')]) {
          // app.env 只經 stdin 交給 lm-deploy（Deploy_Host 驗證鍵名後以 0600 寫入）；printf 為 shell 內建指令，
          // 值不出現在任何程序的命令列、主控台或檔案（Req 15.1、15.2）。
          rc = sh(label: 'lm-deploy prod deploy', returnStatus: true, script: productionSshPrelude() + '''
            rm -f reports/production/deploy.jsonl
            {
              printf 'CAMPING_DATABASE_NAME=%s\\n' "$LM_PROD_DB_NAME"
              printf 'CAMPING_DATABASE_USER=%s\\n' "$LM_PRD_DB_USER"
              printf 'CAMPING_DATABASE_PASSWORD=%s\\n' "$LM_PRD_DB_PASSWORD"
              printf 'CAMPING_SETUP_TOKEN=%s\\n' "$LM_PRD_SETUP_TOKEN"
            } | lm_ssh deploy "$LM_IMAGE_DIGEST" --app-env-stdin > reports/production/deploy.jsonl
          ''')
        }
      }
    }
  }
  return rc
}

/**
 * 在 Deploy_Host 執行 `lm-deploy prod <子命令>`（forced command 綁定 prod，子命令經 SSH_ORIGINAL_COMMAND）；
 * stdout（每行一個 JSON）寫入 reports/production/<outName>。子命令只有固定的五種；槽位只經環境變數傳入。
 * `health` 單次檢查不取鎖（觀察期由 Pipeline 每 10 秒呼叫）。
 */
int prodHost(String action, String outName) {
  Map commands = [
    status       : 'lm_ssh status > "$LM_PRD_OUT"\n',
    'health-once': 'lm_ssh health "$LM_PRD_COLOR" > "$LM_PRD_OUT"\n',
    'health-wait': 'lm_ssh health "$LM_PRD_COLOR" --wait > "$LM_PRD_OUT"\n',
    rollback     : 'lm_ssh rollback > "$LM_PRD_OUT"\n',
    finalize     : 'lm_ssh finalize > "$LM_PRD_OUT"\n',
  ]
  String command = commands[action]
  if (!command || !(outName ==~ /^[a-z-]+\.jsonl?$/)) {
    error('內部錯誤：未知的 lm-deploy 子命令或輸出檔名')
  }
  int rc
  withEnv(["LM_PRD_OUT=reports/production/${outName}"]) {
    withCredentials([sshUserPrivateKey(credentialsId: env.LM_SSH_PROD_CREDENTIALS, keyFileVariable: 'LM_SSH_KEY', usernameVariable: 'LM_SSH_USER')]) {
      withCredentials([file(credentialsId: env.LM_KNOWN_HOSTS_CREDENTIALS, variable: 'LM_KNOWN_HOSTS')]) {
        rc = sh(label: 'lm-deploy prod ' + action, returnStatus: true, script: productionSshPrelude() + command)
      }
    }
  }
  return rc
}

/** SSH 用戶端函式（與 Staging 相同的選項；環境由 Credential_Store 的 Production 金鑰與 forced command 決定）。 */
String productionSshPrelude() {
  return stagingSshPrelude()
}

/**
 * 以 ci/production.mjs record 產生 Build_Record patch（deployments、backup、rollback、reports）與「上線後」關卡結果，
 * 合併並記錄（Req 14.8、20.9、23.5）；發生自動回滾時於建置摘要顯示原因與前後 digest（Req 22.5）。
 * 回傳 0 通過、1 未通過；寫入失敗即 error()。需在 Agent 上呼叫。
 */
int recordProductionGate(String stageError) {
  int rc
  withEnv(["LM_PRD_STAGE_ERROR=${stageError ?: ''}"]) {
    inBuildImage {
      rc = sh(label: 'Release_Gate 上線後', returnStatus: true, script: '''
        set -u
        rm -f reports/gate-post-deploy.json reports/production-record-patch.json reports/production/rollback-summary.txt
        mkdir -p reports/production
        set -- --dir reports/production --commit "$GIT_COMMIT_FULL" --digest "${LM_IMAGE_DIGEST:-}" --tag "$TAG_NAME" \
          --signature "$LM_PRD_SIGNATURE" --finalize "$LM_PRD_FINALIZE" \
          --out-patch reports/production-record-patch.json --out-gate reports/gate-post-deploy.json
        if [ -n "${LM_PRD_STAGE_ERROR:-}" ]; then
          set -- "$@" --stage-error "${LM_PRD_STAGE_ERROR:-}"
        fi
        rc=0
        bun ci/production.mjs record "$@" || rc=$?
        if [ "$rc" -gt 1 ]; then
          exit "$rc"
        fi
        bun ci/record.mjs merge --record "$LM_RECORD" --patch reports/production-record-patch.json || exit 3
        bun ci/record.mjs gate --record "$LM_RECORD" --result reports/gate-post-deploy.json || exit 3
        exit "$rc"
      ''')
    }
  }
  if (rc != 0 && rc != 1) {
    error('無法將 Production 結果與「上線後」關卡寫入 Build_Record')
  }
  env.LM_PRD_GATE_DONE = 'true'
  if (fileExists('reports/production/rollback-summary.txt')) {
    String rollbackSummary = readFile('reports/production/rollback-summary.txt').trim()
    appendSummary(gateText(rollbackSummary))
  }
  return rc
}

/** Production Deploy 失敗、逾時或中止：尚未記錄時記錄「上線後」關卡未通過（Req 23.1、23.3）。不改變原本的失敗原因。 */
void productionStageFailed() {
  catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
    if (env.LM_PRD_ELIGIBLE == 'true' && env.LM_PRD_GATE_DONE != 'true') {
      recordProductionGate(prdStageError())
    }
  }
}

/** <registry>/<repo>@sha256:<64 hex>（不接受可變 tag）。 */
boolean isPinnedImage(String ref) {
  return ref ==~ /^[a-z0-9][a-z0-9.\-]*(:[0-9]+)?\/[a-z0-9][a-z0-9._\/\-]*@sha256:[0-9a-f]{64}$/
}

/** 驗證 Build_Image 引用為 <registry>/<repo>@sha256:<64 hex>，回傳 digest（Req 3.1）。 */
String buildImageDigest() {
  String ref = env.BUILD_IMAGE ?: ''
  if (!isPinnedImage(ref)) {
    error('Build_Image 必須以 <registry>/<repo>@sha256:<64 hex> 引用；請以 infra/build-image 輸出的 digest 更新 Jenkinsfile 的 BUILD_IMAGE')
  }
  return ref.substring(ref.indexOf('@') + 1)
}

/** 以唯讀的 Registry 拉取帳號取得 Build_Image。 */
void pullBuildImage() {
  pullImages([env.BUILD_IMAGE])
}

/**
 * 以唯讀的 Registry 拉取帳號拉取映像（皆位於 Build_Image 所在的 Registry，已驗證為 digest 引用；
 * 唯一例外是 pullReleaseImage 的 `<LM_IMAGE_REPO>:<Release_Tag>`，拉取後立即解析為 digest）；
 * docker 登入資訊只存在本建置的暫存目錄並於結束時刪除。
 */
void pullImages(List refs) {
  withCredentials([usernamePassword(
    credentialsId: env.LM_REGISTRY_PULL_CREDENTIALS,
    usernameVariable: 'LM_REG_USER',
    passwordVariable: 'LM_REG_PASSWORD'
  )]) {
    withEnv(["LM_PULL_IMAGES=${refs.join(' ')}"]) {
      sh(label: 'pull images', script: '''
        set +x
        set -eu
        DOCKER_CONFIG="$WORKSPACE_TMP/docker-pull"
        export DOCKER_CONFIG
        rm -rf "$DOCKER_CONFIG"
        mkdir -p -m 700 "$DOCKER_CONFIG"
        trap 'rm -rf "$DOCKER_CONFIG"' EXIT
        registry="${BUILD_IMAGE%%/*}"
        printf '%s' "$LM_REG_PASSWORD" | docker login --username "$LM_REG_USER" --password-stdin "$registry" >/dev/null
        for ref in ${LM_PULL_IMAGES:-}; do
          case "$ref" in
            "$registry"/*@sha256:*) ;;
            # 只允許 App_Image repository 的 Release_Tag 版本標籤（不覆寫；拉取後由呼叫端解析為 digest）。
            "$LM_IMAGE_REPO":v[0-9]*.[0-9]*.[0-9]*)
              case "$LM_IMAGE_REPO" in
                "$registry"/*) ;;
                *) echo "LM_IMAGE_REPO 不在 Build_Image 的 Registry" >&2; exit 1 ;;
              esac
              ;;
            *) echo "映像不在 Build_Image 的 Registry、未以 digest 固定且不是 Release_Tag 版本標籤" >&2; exit 1 ;;
          esac
          docker pull --quiet "$ref" >/dev/null
        done
        docker logout "$registry" >/dev/null 2>&1 || true
      ''')
    }
  }
}

/** 由使用者手動觸發或 Replay 的建置；只傳給 ci/stages.mjs 記錄，不會提升信任等級（Req 2.8）。 */
boolean isManualBuild() {
  return !currentBuild.getBuildCauses('hudson.model.Cause$UserIdCause').isEmpty() ||
    !currentBuild.getBuildCauses('org.jenkinsci.plugins.workflow.cps.replay.ReplayCause').isEmpty()
}

/** 讀取 ci/stages.mjs 的規劃 JSON；讀取或解析失敗視為觸發被拒絕。失敗時只輸出例外類別（Components 第 23.3 節）。 */
Map readPlan(String path) {
  String failure = null
  Object parsed = null
  try {
    String text = readFile(path)
    parsed = parseJsonText(text)
  } catch (Exception e) {
    failure = e.getClass().getName()
  }
  if (failure != null) {
    echo "readPlan: ${failure}"
    return [reject: '階段規劃輸出無效']
  }
  if (!(parsed instanceof Map)) {
    echo "readPlan: 不是 JSON 物件（${parsed == null ? 'null' : parsed.getClass().getName()}）"
    return [reject: '階段規劃輸出無效']
  }
  return (Map) parsed
}

/** 觸發被拒絕時（例如 Tag 格式不符）仍需建立 Build_Record，觸發類型依 Multibranch 環境變數推定。 */
String fallbackTriggerKind() {
  if (env.CHANGE_ID) { return 'pull_request' }
  if (env.TAG_NAME) { return 'release_tag' }
  if (env.BRANCH_NAME == 'main') { return 'main_push' }
  return 'branch_push'
}

/** Trusted_Ref 只能在 release/ 資料夾建置，Untrusted 建置不得在 release/ 執行（Req 2.4、2.8）。 */
void assertJobFolder(boolean trusted) {
  boolean inRelease = (env.JOB_NAME ?: '').startsWith('release/')
  if (trusted && !inRelease) {
    error('Trusted_Ref 建置只能在 release/ 資料夾的 Job 執行')
  }
  if (!trusted && inRelease) {
    error('release/ 資料夾只建置 main 與 Release_Tag')
  }
}

// ------------------------------------------------------------------ 收尾（post { always } 與 post { cleanup }）

/**
 * 執行一個收尾步驟：失敗只讓建置結果變差（catchError 的 buildResult 只會由 SUCCESS 變為 FAILURE，不覆蓋既有的
 * FAILURE／ABORTED），並記錄第一個失敗的收尾步驟名稱，後續步驟照常執行。收尾期間的中止同樣被吸收（catchInterruptions）。
 */
void postStep(String step, Closure body) {
  catchError(buildResult: 'FAILURE', message: "收尾步驟失敗：${step}".toString()) {
    try {
      body()
    } catch (err) {
      if (!env.LM_POST_FAILED_STEP) { env.LM_POST_FAILED_STEP = step }
      throw err
    }
  }
}

/**
 * Jenkins 結果 → Build_Record 狀態（SUCCESS／FAILURE／ABORTED）、notifyAll 狀態與第一個失敗階段（Req 21.11、22.2–22.4）。
 * 結果非 SUCCESS 時，第一個失敗階段為最後進入的階段（Declarative Pipeline 在第一個失敗後略過其餘階段）；
 * 階段皆成功但收尾步驟失敗時為該收尾步驟名稱（postFailure）。UNSTABLE 記錄為 FAILURE；NOT_BUILT 記錄為 ABORTED。
 */
@NonCPS
Map finalOutcome(String result, String currentStage, String postFailure) {
  String r = (result ?: 'SUCCESS').toUpperCase()
  String record = r == 'SUCCESS' ? 'SUCCESS' : ((r == 'ABORTED' || r == 'NOT_BUILT') ? 'ABORTED' : 'FAILURE')
  String notify = r == 'SUCCESS' ? 'success' : (r == 'UNSTABLE' ? 'unstable' : (record == 'ABORTED' ? 'aborted' : 'failure'))
  String stage = ''
  if (record != 'SUCCESS') {
    stage = postFailure ?: (currentStage ?: 'Init')
  }
  return [record: record, notify: notify, failedStage: stage]
}

/**
 * Build_Record finalize（Req 21.2、21.11）：最終結果、結束時間（ci/record.mjs 寫入含時區的 ISO 8601）與第一個失敗階段；
 * 未產生的欄位填入「不適用」或「未執行」。Init 未建立 Build_Record 時略過（沒有可封存的紀錄）。
 */
void finalizeBuildRecord(Map outcome) {
  if (!env.LM_RECORD || !fileExists(env.LM_RECORD)) {
    echo 'Build_Record 尚未建立（Init 未完成），略過 finalize'
    return
  }
  if (!env.BUILD_IMAGE_DIGEST) {
    error('Build_Image 未通過驗證，無法執行 ci/record.mjs finalize')
  }
  withEnv(["LM_POST_STATUS=${outcome.record}", "LM_POST_FAILED_STAGE=${outcome.failedStage ?: ''}"]) {
    timeout(time: 5, unit: 'MINUTES') {
      inBuildImage {
        sh(label: 'Build_Record finalize', script: '''
          set -eu
          set -- --record "$LM_RECORD" --status "$LM_POST_STATUS"
          if [ -n "${LM_POST_FAILED_STAGE:-}" ]; then set -- "$@" --first-failed-stage "${LM_POST_FAILED_STAGE:-}"; fi
          bun ci/record.mjs finalize "$@"
        ''')
      }
    }
  }
}

/**
 * 封存前遮罩所需的 Credential_Store 憑證（Req 15.4、21.9）：只列本建置已進入的階段用過的秘密，Untrusted 建置只有
 * Registry 拉取帳號與 Git 憑證（Req 2.4）。known_hosts 與 cosign 公鑰不是秘密，不列入。
 * kind：password（usernamePassword 的密碼）、secret（string）、file（file 的內容）、ssh（sshUserPrivateKey 的私鑰）。
 */
List scrubCredentialSpecs() {
  List entered = (env.LM_STAGES_ENTERED ?: '').tokenize('|')
  boolean trusted = env.LM_TRUSTED == 'true' && (env.JOB_NAME ?: '').startsWith('release/')
  List all = [
    [id: env.LM_REGISTRY_PULL_CREDENTIALS, kind: 'password', trusted: false, stages: []],
    [id: env.LM_GIT_CREDENTIALS, kind: 'password', trusted: false, stages: []],
    [id: env.LM_REGISTRY_PUSH_CREDENTIALS, kind: 'password', trusted: true, stages: ['Image Push', 'Image Sign', 'Staging Deploy', 'Version Tag']],
    [id: env.LM_COSIGN_KEY_CREDENTIALS, kind: 'file', trusted: true, stages: ['Image Sign', 'Staging Deploy']],
    [id: env.LM_COSIGN_PASSPHRASE_CREDENTIALS, kind: 'secret', trusted: true, stages: ['Image Sign', 'Staging Deploy']],
    [id: env.LM_SSH_STAGING_CREDENTIALS, kind: 'ssh', trusted: true, stages: ['Staging Deploy']],
    [id: env.LM_STAGING_DB_CREDENTIALS, kind: 'password', trusted: true, stages: ['Staging Deploy']],
    [id: env.LM_STAGING_SETUP_TOKEN_CREDENTIALS, kind: 'secret', trusted: true, stages: ['Staging Deploy']],
    [id: env.LM_STAGING_SMOKE_CREDENTIALS, kind: 'file', trusted: true, stages: ['Staging Deploy']],
    [id: env.LM_JENKINS_API_CREDENTIALS, kind: 'password', trusted: true, stages: ['Resolve Digest']],
    [id: env.LM_SSH_PROD_CREDENTIALS, kind: 'ssh', trusted: true, stages: ['Approval', 'Production Deploy']],
    [id: env.LM_PROD_DB_CREDENTIALS, kind: 'password', trusted: true, stages: ['Production Deploy']],
    [id: env.LM_PROD_SETUP_TOKEN_CREDENTIALS, kind: 'secret', trusted: true, stages: ['Production Deploy']],
    [id: env.LM_PROD_SMOKE_CREDENTIALS, kind: 'file', trusted: true, stages: ['Production Deploy']],
  ]
  List out = []
  for (Map s : all) {
    if (s.trusted && !trusted) { continue }
    boolean used = s.stages.isEmpty()
    for (Object st : s.stages) {
      if (entered.contains(st)) { used = true }
    }
    if (used) { out << s }
  }
  return out
}

/**
 * 在 withCredentials 內把一個憑證的值寫入 $WORKSPACE_TMP/lm-scrub-secrets/cred-<ID>（目錄 0700、檔案 0600）。
 * 值只經 shell 內建 printf 或 cat 寫入（不出現在任何程序的命令列、Groovy 變數或主控台）。需在 Agent 上執行。
 */
void stageScrubSecret(Map s) {
  String id = s.id ? s.id.toString() : ''
  if (!(id ==~ /^[a-z0-9][a-z0-9-]{0,63}$/)) { error('遮罩用的憑證 ID 無效') }
  withEnv(["LM_SCRUB_NAME=cred-${id}"]) {
    if (s.kind == 'secret') {
      withCredentials([string(credentialsId: id, variable: 'LM_SCRUB_VALUE')]) { writeScrubValue() }
    } else if (s.kind == 'password') {
      withCredentials([usernamePassword(credentialsId: id, usernameVariable: 'LM_SCRUB_USER', passwordVariable: 'LM_SCRUB_VALUE')]) { writeScrubValue() }
    } else if (s.kind == 'file') {
      withCredentials([file(credentialsId: id, variable: 'LM_SCRUB_FILE')]) { writeScrubFile() }
    } else if (s.kind == 'ssh') {
      withCredentials([sshUserPrivateKey(credentialsId: id, keyFileVariable: 'LM_SCRUB_FILE', usernameVariable: 'LM_SCRUB_USER')]) { writeScrubFile() }
    } else {
      error('遮罩用的憑證類型無效')
    }
  }
}

void writeScrubValue() {
  sh(label: 'stage scrub secret', script: '''
    set +x
    set -eu
    umask 077
    case "$LM_SCRUB_NAME" in
      cred-*/* | */*) exit 2 ;;
      cred-?*) ;;
      *) exit 2 ;;
    esac
    d="$WORKSPACE_TMP/lm-scrub-secrets"
    mkdir -p -m 0700 "$d"
    chmod 0700 "$d"
    printf '%s' "${LM_SCRUB_VALUE:-}" > "$d/$LM_SCRUB_NAME"
  ''')
}

void writeScrubFile() {
  sh(label: 'stage scrub secret file', script: '''
    set +x
    set -eu
    umask 077
    case "$LM_SCRUB_NAME" in
      cred-*/* | */*) exit 2 ;;
      cred-?*) ;;
      *) exit 2 ;;
    esac
    if [ ! -f "${LM_SCRUB_FILE:-}" ]; then
      echo "憑證檔不存在" >&2
      exit 1
    fi
    d="$WORKSPACE_TMP/lm-scrub-secrets"
    mkdir -p -m 0700 "$d"
    chmod 0700 "$d"
    cat -- "$LM_SCRUB_FILE" > "$d/$LM_SCRUB_NAME"
  ''')
}

/** 重新取得 scrubCredentialSpecs 的憑證；回傳無法取得的憑證 ID（空清單代表秘密集合完整）。需在 Agent 上執行。 */
List stageScrubSecrets() {
  List missing = []
  for (Map s : scrubCredentialSpecs()) {
    String failure = null
    try {
      stageScrubSecret(s)
    } catch (Exception e) {
      // 例外訊息可能含憑證內容以外的細節，只記錄憑證 ID 與例外類別（Req 15.3；Components 第 23.3 節）。
      failure = e.getClass().getName()
      missing << (s.id ? s.id.toString() : '?')
    }
    if (failure != null) {
      echo "stageScrubSecrets: ${failure}（${s.id ? s.id.toString() : '?'}）"
    }
  }
  return missing
}

/** 收尾遮罩後刪除秘密目錄（含各階段 Ephemeral_Database 的秘密副本）；可重複呼叫。需在 Agent 上執行。 */
void removeScrubSecrets() {
  sh(label: 'remove scrub secrets', script: '''
    set +x
    if [ -n "${WORKSPACE_TMP:-}" ]; then
      rm -rf -- "$WORKSPACE_TMP/lm-scrub-secrets"
    fi
  ''')
}

/**
 * ci/scrub.mjs 處理 reports/ 全部檔案，輸出至 $WORKSPACE_TMP/lm-post/archive/reports/（處理報告為其中的 archive-scrub.json，
 * 只含檔名、憑證 ID 與形式名稱）。回傳結束碼：0 全部通過；1 有檔案被扣留（只輸出 .withheld.txt）；其他為無法完成
 * （輸出目錄已刪除）。需在 Agent 上呼叫（於 Build_Image 容器內執行）。
 */
int scrubReports() {
  int rc = 3
  timeout(time: 10, unit: 'MINUTES') {
    inBuildImage {
      rc = sh(label: 'ci/scrub.mjs（封存前遮罩與掃描）', returnStatus: true, script: '''
        set +x
        set -u
        out="$WORKSPACE_TMP/lm-post/archive"
        rm -rf "$out"
        mkdir -p "$out/reports"
        rc=0
        bun ci/scrub.mjs --secrets-dir "$WORKSPACE_TMP/lm-scrub-secrets" --in reports --out "$out/reports" \
          --report "$out/reports/archive-scrub.json" > /dev/null || rc=$?
        if [ "$rc" -ne 0 ] && [ "$rc" -ne 1 ]; then
          rm -rf "$out"
        fi
        exit "$rc"
      ''')
    }
  }
  return rc
}

/** 遮罩後仍有檔案被扣留且原結果為 SUCCESS：Build_Record 改記錄為失敗（收尾步驟 Post Archive），再重新遮罩封存。 */
void markRecordArchiveFailure() {
  writeFile(file: 'reports/post-archive-record-patch.json', text: JsonOutput.toJson([result: [status: 'FAILURE', firstFailedStage: 'Post Archive']]))
  inBuildImage {
    sh(label: 'Build_Record（封存前遮罩未通過）', script: 'bun ci/record.mjs merge --record "$LM_RECORD" --patch reports/post-archive-record-patch.json')
  }
}

/**
 * 封存（Req 15.4、21.9、23.1）：所有待封存檔案（reports/：測試、掃描、部署報告、失敗證據與 Build_Record）先經
 * ci/scrub.mjs 遮罩與掃描，只封存遮罩後的副本。秘密集合不完整、Build_Image 無法使用或 scrub 無法完成時不封存任何
 * 報告（fail closed）；遮罩後仍偵測到秘密的檔案只封存說明檔，建置標記為失敗。需在 Agent 上呼叫。
 */
void archiveScrubbedReports(Map outcome) {
  env.LM_POST_ARCHIVED = 'false'
  if (!fileExists('reports')) {
    echo '沒有 reports/，不封存任何檔案'
    return
  }
  try {
    if (env.LM_SCRUB_INCOMPLETE == 'true') {
      appendSummary('封存前秘密遮罩：Ephemeral_Database 的遮罩用秘密未能保存，未封存任何報告（Req 15.4）')
      error('秘密集合不完整，未封存任何報告')
    }
    if (!env.BUILD_IMAGE_DIGEST) {
      appendSummary('封存前秘密遮罩：Build_Image 無法使用，未封存任何報告（Req 15.4）')
      error('Build_Image 無法使用，無法遮罩待封存檔案')
    }
    List missing = stageScrubSecrets()
    if (!missing.isEmpty()) {
      appendSummary("封存前秘密遮罩：無法取得憑證 ${missing.join('、')}，未封存任何報告（Req 15.3、15.4）".toString())
      error("無法取得遮罩用的憑證 ${missing.join(', ')}，未封存任何報告")
    }
    int rc = scrubReports()
    if (rc == 1 && outcome.record == 'SUCCESS' && fileExists(env.LM_RECORD)) {
      markRecordArchiveFailure()
      rc = scrubReports()
    }
    if (rc != 0 && rc != 1) {
      appendSummary("封存前秘密遮罩無法完成（ci/scrub.mjs 結束碼 ${rc}），未封存任何報告（Req 15.4）".toString())
      error("封存前秘密遮罩無法完成（ci/scrub.mjs 結束碼 ${rc}）")
    }
    dir("${env.WORKSPACE_TMP}/lm-post/archive") {
      // image-digest.txt 已於 Image Push／Resolve Digest 封存並 fingerprint（內容只有 digest），不重複封存。
      archiveArtifacts(artifacts: 'reports/**', excludes: 'reports/image-digest.txt, reports/build-record.json', allowEmptyArchive: true)
      if (fileExists('reports/build-record.json')) {
        archiveArtifacts(artifacts: 'reports/build-record.json', fingerprint: true)
      }
    }
    env.LM_POST_ARCHIVED = 'true'
    if (rc == 1) {
      appendSummary('封存前秘密掃描：遮罩後仍偵測到秘密的檔案未封存（只封存 .withheld.txt 說明檔，見 reports/archive-scrub.json），建置標記為失敗（Req 15.4）')
      error('遮罩後仍偵測到秘密的檔案已扣留，建置標記為失敗')
    }
  } finally {
    removeScrubSecrets()
  }
}

/**
 * Production 執行中的 Image_Digest 之建置保留（Req 21.6；Design「Jenkins 資料夾與 Job」）：Release_Tag 建置通過觀察期後，
 * 以 ci/keep-log.mjs 經 Jenkins API 對本建置與產生該 digest 的 main 建置設定 keepLog=true。API token 寫入 0700 目錄的
 * 0600 檔再交給 Build_Image 容器（不經 docker exec --env），結束時一律刪除。失敗只寫入建置摘要，不改變建置結果
 * （Production 已切換完成；需由 Jenkins 管理員手動保留）。需在 Agent 上呼叫。
 */
void keepProductionBuildLog() {
  if (env.LM_TRUSTED != 'true' || env.LM_TRIGGER_KIND != 'release_tag' || env.LM_PRD_OBSERVED != 'true') { return }
  if (!(env.JOB_NAME ?: '').startsWith('release/') || !env.BUILD_IMAGE_DIGEST) { return }
  int rc = 2
  String failure = null
  withEnv(["LM_KEEP_DIR=${env.WORKSPACE_TMP}/lm-keep-log"]) {
    try {
      withCredentials([usernamePassword(credentialsId: env.LM_JENKINS_RETENTION_CREDENTIALS, usernameVariable: 'LM_KEEP_USER_SRC', passwordVariable: 'LM_KEEP_TOKEN_SRC')]) {
        sh(label: 'stage Jenkins API token（keepLog）', script: '''
          set +x
          set -eu
          umask 077
          rm -rf "$LM_KEEP_DIR"
          mkdir -m 0700 "$LM_KEEP_DIR"
          printf '%s' "$LM_KEEP_TOKEN_SRC" > "$LM_KEEP_DIR/token"
          printf '%s' "$LM_KEEP_USER_SRC" > "$LM_KEEP_DIR/user"
        ''')
      }
      timeout(time: 3, unit: 'MINUTES') {
        inBuildImage {
          rc = sh(label: 'ci/keep-log.mjs', returnStatus: true, script: '''
            set +x
            set -u
            LM_JENKINS_API_USER="$(cat "$LM_KEEP_DIR/user")"
            LM_JENKINS_API_TOKEN_FILE="$LM_KEEP_DIR/token"
            export LM_JENKINS_API_USER LM_JENKINS_API_TOKEN_FILE
            set -- --job "$JOB_NAME" --number "$BUILD_NUMBER" --trigger "$LM_TRIGGER_KIND" --observed "$LM_PRD_OBSERVED"
            if [ -n "${LM_IMAGE_DIGEST:-}" ] && [ -f reports/release/main-build-record.json ]; then
              set -- "$@" --digest "$LM_IMAGE_DIGEST" --main-record reports/release/main-build-record.json
            fi
            bun ci/keep-log.mjs "$@"
          ''')
        }
      }
    } catch (Exception e) {
      failure = e.getClass().getName()
      rc = 2
    } finally {
      sh(label: 'remove Jenkins API token（keepLog）', script: '''
        set +x
        case "$LM_KEEP_DIR" in
          "$WORKSPACE_TMP"/lm-keep-log) rm -rf -- "$LM_KEEP_DIR" ;;
        esac
      ''')
    }
  }
  if (failure != null) {
    echo "keepProductionBuildLog: ${failure}"
  }
  if (rc == 0) {
    appendSummary('已保留（keepLog）本建置與產生該 Image_Digest 的 main 建置（Req 21.6）')
  } else {
    appendSummary("無法設定 keepLog（ci/keep-log.mjs 結束碼 ${rc}）：請 Jenkins 管理員手動保留本建置與產生該 Image_Digest 的 main 建置（Req 21.6）".toString())
  }
}

/**
 * 依 label `lm.ci.build=$BUILD_TAG` 移除本建置建立的所有容器（含匿名卷）、網路與卷（Req 2.6）。只依本建置的 label
 * 篩選，不使用 prune，不影響其他建置；之後確認沒有殘留，否則失敗。需在 Agent 上執行。
 */
void cleanupBuildResources() {
  timeout(time: 5, unit: 'MINUTES') {
    sh(label: 'remove build containers, networks and volumes', script: '''
      set +x
      set -u
      if [ -z "${BUILD_TAG:-}" ]; then
        echo "BUILD_TAG 未設定，無法依建置標籤清除" >&2
        exit 1
      fi
      label="lm.ci.build=$BUILD_TAG"
      for id in $(docker ps -aq --filter "label=$label" 2>/dev/null); do
        docker rm -fv "$id" > /dev/null 2>&1 || true
      done
      for net in $(docker network ls -q --filter "label=$label" 2>/dev/null); do
        for c in $(docker network inspect -f '{{range $k, $v := .Containers}}{{$k}} {{end}}' "$net" 2>/dev/null); do
          docker network disconnect -f "$net" "$c" > /dev/null 2>&1 || true
        done
        docker network rm "$net" > /dev/null 2>&1 || true
      done
      for vol in $(docker volume ls -q --filter "label=$label" 2>/dev/null); do
        docker volume rm -f "$vol" > /dev/null 2>&1 || true
      done
      left="$(docker ps -aq --filter "label=$label" 2>/dev/null)$(docker network ls -q --filter "label=$label" 2>/dev/null)$(docker volume ls -q --filter "label=$label" 2>/dev/null)"
      if [ -n "$left" ]; then
        echo "無法移除本建置的部分容器、網路或卷" >&2
        exit 1
      fi
      echo "已移除本建置的容器、網路與卷"
    ''')
  }
}

/**
 * 建置摘要的 Release_Gate 說明（Req 22.4）：取 Build_Record（遮罩後的封存副本）中第一個未通過的關卡，顯示名稱、
 * 最多 3 個未符合的條件與最多 3 個報告連結（`<BUILD_URL>artifact/reports/...`）。內容只來自關卡結果的固定訊息、
 * 規則 ID 與報告路徑，並以 HTML 實體跳脫。沒有未通過的關卡時回傳空字串。
 */
@NonCPS
String gateSummaryText(Map record, String buildUrl) {
  List gates = record?.gates instanceof List ? (List) record.gates : []
  Map failed = null
  for (Object g : gates) {
    if (g instanceof Map && ((Map) g).pass == false) {
      failed = (Map) g
      break
    }
  }
  if (failed == null) { return '' }
  List parts = []
  for (Object u : (failed.unmet instanceof List ? (List) failed.unmet : [])) {
    if (parts.size() >= 3) { break }
    String t = gateText(u)
    parts << (t.length() > 80 ? t.substring(0, 80) + '…' : t)
  }
  String url = buildUrl ?: ''
  String base = ((url ==~ /^https?:\/\/[^\s<>]+\/$/) && url.indexOf('"') < 0 && url.indexOf("'") < 0) ? url : ''
  List links = []
  for (Object r : (failed.reports instanceof List ? (List) failed.reports : [])) {
    if (links.size() >= 3 || !base) { break }
    String p = String.valueOf(r)
    if ((p ==~ /^reports\/[A-Za-z0-9._\/\-]{1,200}$/) && !p.contains('..')) {
      links << "${base}artifact/${p}".toString()
    }
  }
  String s = "Release_Gate「${gateText(failed.gate ?: '?')}」未通過".toString()
  if (!parts.isEmpty()) { s += '：' + parts.join('；') }
  if (!links.isEmpty()) { s += '；報告：' + links.join(' ') }
  return htmlText(s)
}

@NonCPS
String htmlText(String s) {
  return (s ?: '').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;').replace("'", '&#39;')
}

/** Init 載入的 ci/notify.groovy；Init 未完成載入時於收尾重新載入（工作目錄尚未清除）。皆失敗回傳 null。 */
def postNotifier() {
  try {
    if (lmNotifier != null) { return lmNotifier }
  } catch (MissingPropertyException ignored) {
    // Init 未執行到 load
  }
  if (fileExists('ci/notify.groovy')) {
    return load('ci/notify.groovy')
  }
  return null
}

/**
 * 最終狀態通知（Req 22.2–22.4、22.7、22.8）：所有收尾步驟之後依當下結果送出 success／failure／aborted／unstable，
 * 附第一個失敗階段與（失敗由 Release_Gate 造成時）關卡說明。notifyAll 永不拋出例外、不改變建置結果；本函式另以
 * try/catch 保護，載入失敗也不影響其他收尾。
 */
void notifyFinal() {
  String failure = null
  try {
    String postFailure = env.LM_POST_RESULT_BEFORE == 'SUCCESS' ? (env.LM_POST_FAILED_STEP ?: '') : ''
    Map o = finalOutcome(currentBuild.currentResult, env.LM_CURRENT_STAGE ?: '', postFailure)
    String gate = ''
    if (o.record != 'SUCCESS' && env.LM_POST_ARCHIVED == 'true') {
      String gateFailure = null
      try {
        dir("${env.WORKSPACE_TMP}/lm-post/archive") {
          gate = gateSummaryText(readJsonFile('reports/build-record.json'), env.BUILD_URL ?: '')
        }
      } catch (Exception e) {
        gateFailure = e.getClass().getName()
        gate = ''
      }
      if (gateFailure != null) {
        echo "notifyFinal/gate: ${gateFailure}"
      }
    }
    def notifier = postNotifier()
    if (notifier == null) {
      echo '無法載入 ci/notify.groovy，未送出最終狀態通知'
      return
    }
    notifier.notifyAll(o.notify, [commit: env.GIT_COMMIT_FULL ?: '', failedStage: o.failedStage, gateSummary: gate])
  } catch (Exception e) {
    failure = e.getClass().getName()
  }
  if (failure != null) {
    echo "notifyFinal/notify: ${failure}"
    echo '最終狀態通知失敗（不改變建置結果）'
  }
}

/** 收尾暫存目錄（遮罩後的封存副本、秘密目錄與 keepLog token）；post { cleanup } 呼叫。需在 Agent 上執行。 */
void removePostWork() {
  sh(label: 'remove post work', script: '''
    set +x
    if [ -n "${WORKSPACE_TMP:-}" ]; then
      rm -rf -- "$WORKSPACE_TMP/lm-post" "$WORKSPACE_TMP/lm-scrub-secrets" "$WORKSPACE_TMP/lm-keep-log"
    fi
  ''')
}
