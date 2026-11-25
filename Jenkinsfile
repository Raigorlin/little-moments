// 日子拾光 · LITTLE MOMENTS — Jenkins Multibranch Pipeline（Requirement 1、3、21、22、23；Design「Pipeline 階段配置」；
// Rust + 自架 Supabase 版：.agents/tasks/jenkins-rust-supabase/plan.md 的 D1–D16）。
//
// 同一份 Jenkinsfile 由兩個 Multibranch Job 載入（Req 1.1）：
//   ci/little-moments       PR 與非 main 分支（例如 rust；Untrusted，無部署憑證）：只有品質階段，不建置映像、不部署
//   release/little-moments  main（Trusted，憑證只存在 release/ 資料夾範圍）：品質 → App_Image → Staging → Production
//                           → 版本標籤 v<Cargo.toml 的 [workspace.package] version>。合併到 main 即發布，沒有人工核准（D1、D2）
// 階段規劃由 ci/stages.mjs 決定；信任只由事件類型與 ref 決定，手動觸發或重跑不提升信任（Req 2.8）。
// Release_Tag（v*）不再觸發建置：release/little-moments 不探索 Tag，ci/stages.mjs 也以固定訊息拒絕 Tag 事件。
//
// 規則：
//   * 不提供任何建置參數（沒有 `parameters` 區塊），也沒有任何 `input` 步驟。沒有任何參數、環境變數或選項可以略過
//     Release_Gate、將未通過的 Release_Gate 改為通過或放寬通過條件（Req 23.4）。
//   * 憑證只在需要的步驟內以 withCredentials 提供（Req 15.1、15.2）；本檔只出現憑證 ID，不含任何秘密值。
//   * 失敗一律以 error()／非零結束碼終止，Declarative Pipeline 會略過所有後續階段（Req 1.7）。
//   * 所有 sh 腳本使用單引號字串，只透過 shell 環境變數（加雙引號）取用 ref、SHA 等外部值，不經 Groovy 插值。
//   * 階段名稱與 ci/stages.mjs 的 STAGE 常數一致，供 Build_Record 的 firstFailedStage 使用。
//   * Rust 的檢查（cargo fmt／clippy／test、trunk build、bats）在本建置以根目錄 Dockerfile 的 toolchain 階段建出的
//     工具鏈映像內執行（D3）；ci/*.mjs 與 bun test 在 digest 固定的 Build_Image 內執行。
//
// 注意：本檔無法在本機執行，語法與 plugin 步驟參數未經 Jenkins 實際驗證。

import groovy.json.JsonOutput
import groovy.json.JsonSlurperClassic

// environment 各鍵的說明（自 environment 區塊移出；Components 第 22 節）。
//
// BUILD_IMAGE：
//   Build_Image 只以 digest 引用（Req 3.1）。
//   digest 來源：infra/build-image Job 建置 commit a302149 的輸出（建置描述與 reports/build-image-digest.txt）。
//   更新方式：ci/build-image/Dockerfile 或 ci/toolchain.json 變更後重新執行 infra/build-image，
//   以新輸出的 digest 在同一個 commit 內取代本檔與 ci/jenkins/pipelines/{rollback,restore-drill,digest-lookup}.Jenkinsfile 的 BUILD_IMAGE。
//   格式不是 `<registry>/<repo>@sha256:<64 hex>` 時 Init 階段失敗（fail closed），不會退回任何可變 tag。
//   Rust 版不重建 Build_Image（plan.md D3）：bun 的工具、ci/*.mjs 與 bun test 仍在其中執行。
// LM_RECORD：
//   Build_Record 路徑（封存前由 post 階段經 ci/scrub.mjs 處理）。
// LM_REGISTRY_PULL_CREDENTIALS、LM_GIT_CREDENTIALS：
//   憑證 ID（值只存在 Credential_Store；ci/ 與 release/ 資料夾各自定義）。
// LM_RUST_TOOLCHAIN_IMAGE_REPO：
//   Rust 工具鏈映像的本機名稱（plan.md D3）：Toolchain 階段以 `docker build --target toolchain`（根目錄 Dockerfile、
//   空的建置內容）建出 `<本值>:<完整 Commit SHA>`，只存在執行本建置的 Agent，不推送到任何 Registry，收尾時移除該標籤。
//   toolchain 階段的 FROM 以 digest 固定、下載的工具（trunk、wasm-bindgen、wasm-opt、bats）以 SHA-256 檢查，
//   版本與 ci/rust-toolchain.json 相同（Toolchain 階段以 ci/verify-rust-toolchain.sh 確認）。
// LM_CARGO_CACHE_VOLUME：
//   cargo 的 registry 快取（CARGO_HOME）所在的 Docker 具名卷前綴（plan.md D3）。實際名稱另加 `-ci` 或 `-release`：
//   兩個 Agent 在同一主機上共用 Docker daemon，Untrusted 建置寫入的快取不得被 Trusted 建置讀取。
//   Install 階段（可連網）`cargo fetch --locked` 寫入；Build 與 Unit Tests 以 --network none、CARGO_NET_OFFLINE=true 讀取。
// LM_BUN_TESTS：
//   Unit Tests 階段在 Build_Image 內執行的 bun 測試（plan.md D15；萬用字元由 shell 展開）：CI／部署工具與 Rust 版
//   對照 Bun 版樣式的測試。其他 tests/*.test.js 屬於 Bun 版 App（src/、server/），Rust 版的 Pipeline 不執行。
// LM_POSTGRES_IMAGE：
//   映像層級 Smoke_Test（ci/scripts/image-smoke.sh）的 Ephemeral_Database：一般的 PostgreSQL，只以 digest 引用
//   （postgres:17.6-bookworm 的多平台 index）。Deploy_Host 的 Supabase Database 映像另見 deploy/compose/compose.yaml（plan.md D5）。
// LM_GITLEAKS_IMAGE、LM_OSV_SCANNER_IMAGE、LM_TRIVY_IMAGE、LM_SEMGREP_IMAGE：
//   靜態安全掃描器（Req 6；Design「工具選型」）：鏡像至 LAN Registry（與 Build_Image 同一 Registry）並只以 digest 引用。
//   上游（linux/amd64 單一平台鏡像）：ghcr.io/gitleaks/gitleaks:v8.30.1、ghcr.io/google/osv-scanner:v2.7.1、
//   docker.io/aquasec/trivy:0.76.2、docker.io/semgrep/semgrep:1.185.0。
//   更新版本：修改 deploy/registry/mirror.list 後執行 deploy/registry/mirror.sh，再以其輸出的 digest 取代下列值。
// LM_GITLEAKS_HISTORY_BASE（Secret_History_Baseline；Req 6.1、6.10；design.md Components 第 27.3 節）：
//   非 PR 建置的 Gitleaks Git 歷史掃描起點（範圍為 `<起點或上次成功建置>..<sha>`）。2026-11-13 審查：
//   Gitleaks 8.30.1 以預設規則掃描 c084474 的完整歷史只有 4 筆已確認的測試假值，c084474 與其祖先不含真實秘密。
//   只在以 Gitleaks 掃描新起點的完整歷史、確認每筆結果並記錄於 design.md 之後，以經審查的 commit 修改。
//   不是建置參數，也不從 params.* 或 Job 設定讀取（Req 23.4）；起點無效或不是建置 commit 的祖先時歷史掃描未完成。
// LM_TRIVY_DB_REPOSITORY：
//   Trivy 漏洞資料庫的 LAN 鏡像（OCI artifact，每日更新故以 tag 引用）；以唯讀拉取帳號存取。
//   Registry 主機的 lm-mirror-trivy-db.timer 每日 04:30 自 mirror.gcr.io/aquasec/trivy-db:2 複製（deploy/registry/）。
// LM_SCAN_CA_BUNDLE：
//   Agent 的系統 CA bundle（須含 LAN Registry 的內部 CA），以唯讀方式提供給 Trivy 下載資料庫。
// LM_IMAGE_REPO：
//   App_Image repository（與 deploy/compose/*.env 的 LM_IMAGE_REPO 相同，位於 Build_Image 的 LAN Registry）。
//   標籤：每次 main 建置的 `<完整 SHA>`（Image Push），以及「上線後」關卡通過後的版本標籤 `v<版本>`（Version Tag）；
//   兩者都不覆寫既有標籤（Req 16.10；plan.md D2）。
// LM_SYFT_IMAGE、LM_CRANE_IMAGE、LM_COSIGN_IMAGE：
//   App_Image 掃描、SBOM、Registry 操作與簽章工具（Design「工具選型」：Trivy、Syft、crane、cosign v2）。
//   Build_Image 不含這些工具；與掃描器相同，鏡像至 LAN Registry 並只以 digest 引用。
//   上游（linux/amd64）：docker.io/anchore/syft:v1.57.1、gcr.io/go-containerregistry/crane:v0.22.1、
//   ghcr.io/sigstore/cosign/cosign:v2.6.5（2.x 最新版）。更新方式同上（deploy/registry/mirror.list、mirror.sh）；
//   crane 另須同步 ci/jenkins/pipelines/build-image.Jenkinsfile 的 LM_CRANE_IMAGE。Trivy 沿用 LM_TRIVY_IMAGE。
// LM_REGISTRY_PUSH_CREDENTIALS、LM_COSIGN_KEY_CREDENTIALS、LM_COSIGN_PASSPHRASE_CREDENTIALS：
//   推送與簽章憑證（只定義於 release/ 資料夾範圍，只在 Image Push／Image Sign／Staging 的 attestation／Version Tag 的
//   withCredentials 內提供；Req 15.1、15.2）：
//     lm-registry-push      Username with password：Registry 唯一可寫入的帳號 lm-push（deploy/registry/Caddyfile）
//     lm-cosign-key         Secret file：cosign 加密私鑰 cosign.key
//     lm-cosign-passphrase  Secret text：cosign.key 的密碼
// LM_DEPLOY_HOST、LM_DEPLOY_PORT：
//   Staging／Production 部署（Req 15.1、15.2、15.9、18、20）：Deploy_Host 的 LAN 位址與 SSH 連接埠（非秘密）。
//   known_hosts 憑證（lm-deploy-known-hosts）須含 192.168.1.121 的主機金鑰（連接埠非 22 時為 `[host]:port` 形式）。
// LM_STAGING_URL：
//   Staging 代理的 LAN origin（/srv/lm/staging/staging.env 的 LAN_IP:LM_PUBLIC_PORT）。Smoke_Test 由 Trusted Agent
//   經此 LAN origin 執行，不經 Edge_Proxy：Host 為 192.168.1.121（須在 staging.env 的 LM_ALLOWED_HOSTS 內，plan.md D12），
//   App 看到的協定為 http。HTTPS 時以 LM_SCAN_CA_BUNDLE（內部 CA）驗證憑證。
// LM_STAGING_PREDICATE_TYPE：
//   staging-verified attestation 的 predicate type（與 ci/resolve-digest.mjs STAGING_PREDICATE_TYPE 相同）。
// LM_SSH_STAGING_CREDENTIALS、LM_KNOWN_HOSTS_CREDENTIALS、LM_COSIGN_PUBLIC_KEY_CREDENTIALS、LM_STAGING_STACK_ENV_CREDENTIALS、LM_STAGING_SMOKE_CREDENTIALS：
//   Staging 憑證（只定義於 release/ 資料夾範圍，只在 Staging Deploy 的 withCredentials 內提供；Req 15.1、15.2）：
//     lm-ssh-staging            SSH Username with private key：Staging 專用部署金鑰（authorized_keys forced command
//                               `lm-deploy staging`；與 Production 的 lm-ssh-prod 不同，Req 15.9）
//     lm-deploy-known-hosts     Secret file：Deploy_Host 的 known_hosts（與 release/rollback、restore-drill 共用）
//     lm-cosign-pub             Secret file：cosign 公鑰 cosign.pub（部署前驗證簽章與 attestation，Req 17.7）
//     lm-staging-supabase-env   Secret file：Staging 的 Supabase 金鑰（`lm-supabase-keys env staging` 輸出的 8 行 KEY=VALUE，
//                               plan.md D13、D16）。檔案只以 `<` 重新導向成為 `lm-deploy staging deploy --app-env-stdin` 的
//                               stdin，內容不經 Groovy、命令列或主控台；Deploy_Host 驗證鍵名與格式後以 0600 寫入 app.env
//     lm-staging-smoke          Secret file：Staging 合成帳號 smoke-bot 的密碼（與 Production 不同）。Staging 的
//                               Smoke_Test 以 --provision 執行：smoke-bot 不存在時以此密碼註冊（plan.md D9）
// LM_PROD_URL：
//   Production 代理的 LAN origin（/srv/lm/prod/prod.env 的 LAN_IP:LM_PUBLIC_PORT；80／443 由 Edge_Proxy 使用）。
//   觀察期的 Smoke_Test 由 Trusted Agent 經此 LAN origin 執行，不經 Edge_Proxy 與 Cloudflare：Host 為 192.168.1.121
//   （須在 prod.env 的 LM_ALLOWED_HOSTS 內），App 看到的協定為 http。HTTPS 時以 LM_SCAN_CA_BUNDLE（內部 CA）驗證憑證。
// LM_SSH_PROD_CREDENTIALS、LM_PROD_STACK_ENV_CREDENTIALS、LM_PROD_SMOKE_CREDENTIALS：
//   Production 憑證（只定義於 release/ 資料夾範圍，只在 Production Deploy 的 withCredentials 內提供；Req 15.1、15.2）：
//     lm-ssh-prod               SSH Username with private key：Production 專用部署金鑰（authorized_keys forced command
//                               `lm-deploy prod`；與 release/rollback 共用，與 Staging 的 lm-ssh-staging 不同，Req 15.9）
//     lm-prod-supabase-env      Secret file：Production 的 Supabase 金鑰（`lm-supabase-keys env prod` 的輸出，與 Staging 不同）；
//                               交給 `lm-deploy prod deploy --app-env-stdin` 的方式與 Staging 相同
//     lm-prod-smoke             Secret file：Production 合成帳號 smoke-bot 的密碼（與 Staging 不同；Production 不自動註冊，
//                               smoke-bot 於首次切換時建立，見 deploy/README.md）
//   Version Tag 另使用 lm-registry-push（crane tag 寫入版本標籤）；簽章驗證使用 lm-registry-pull 與 lm-cosign-pub。
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
    LM_RUST_TOOLCHAIN_IMAGE_REPO = 'lm-rust-toolchain'
    LM_CARGO_CACHE_VOLUME = 'lm-cargo-cache'
    LM_BUN_TESTS = 'tests/ci-*.test.js tests/deploy-*.test.js tests/schedule-css-parity.test.js tests/storybook-studio-parity.test.js tests/readme.test.js tests/secret-scan.test.js'
    LM_POSTGRES_IMAGE = 'postgres:17.6-bookworm@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3'
    LM_GITLEAKS_IMAGE = 'registry.our-littlemoments.com:8443/little-moments/mirror/gitleaks@sha256:b109bc5f8f76a38196a3e413704fc5b9e3c32360bce4e4b603bd6f45b3721dbb'
    LM_GITLEAKS_HISTORY_BASE = 'c08447436cb3db000b577a3de28f8be8acbee540'
    LM_OSV_SCANNER_IMAGE = 'registry.our-littlemoments.com:8443/little-moments/mirror/osv-scanner@sha256:bc10cae80da100d32572aea48cfc48e592be9adc4a8b0820fd5d2c2db71f9446'
    LM_TRIVY_IMAGE = 'registry.our-littlemoments.com:8443/little-moments/mirror/trivy@sha256:6fa071ef8daa2e58b90cbf1710bedca91adbb3bf98693533226f442035b836a6'
    LM_SEMGREP_IMAGE = 'registry.our-littlemoments.com:8443/little-moments/mirror/semgrep@sha256:f83a64e8a7d985eaa51ee3978c9c882be946964c68633fba5d2817cf297a3912'
    LM_TRIVY_DB_REPOSITORY = 'registry.our-littlemoments.com:8443/little-moments/mirror/trivy-db:2'
    LM_SCAN_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt'
    LM_IMAGE_REPO = 'registry.our-littlemoments.com:8443/little-moments'
    LM_SYFT_IMAGE = 'registry.our-littlemoments.com:8443/little-moments/mirror/syft@sha256:c31c09c21a75c7c0b1f4082358614115536fa4f1d2e0bdab2d11f5257360338a'
    LM_CRANE_IMAGE = 'registry.our-littlemoments.com:8443/little-moments/mirror/crane@sha256:18efc5092649b2a674d384663044e04edf76705c4faa2875e8a322b4e80f070a'
    LM_COSIGN_IMAGE = 'registry.our-littlemoments.com:8443/little-moments/mirror/cosign@sha256:404b8081d833085d12c21cda889c6f2f3731328768257c760e32fcf070be2cf9'
    LM_REGISTRY_PUSH_CREDENTIALS = 'lm-registry-push'
    LM_COSIGN_KEY_CREDENTIALS = 'lm-cosign-key'
    LM_COSIGN_PASSPHRASE_CREDENTIALS = 'lm-cosign-passphrase'
    LM_DEPLOY_HOST = '192.168.1.121'
    LM_DEPLOY_PORT = '22'
    LM_STAGING_URL = 'http://192.168.1.121:8081'
    LM_STAGING_PREDICATE_TYPE = 'https://little-moments.lan/attestations/staging-verified/v1'
    LM_SSH_STAGING_CREDENTIALS = 'lm-ssh-staging'
    LM_KNOWN_HOSTS_CREDENTIALS = 'lm-deploy-known-hosts'
    LM_COSIGN_PUBLIC_KEY_CREDENTIALS = 'lm-cosign-pub'
    LM_STAGING_STACK_ENV_CREDENTIALS = 'lm-staging-supabase-env'
    LM_STAGING_SMOKE_CREDENTIALS = 'lm-staging-smoke'
    LM_PROD_URL = 'http://192.168.1.121:8082'
    LM_SSH_PROD_CREDENTIALS = 'lm-ssh-prod'
    LM_PROD_STACK_ENV_CREDENTIALS = 'lm-prod-supabase-env'
    LM_PROD_SMOKE_CREDENTIALS = 'lm-prod-smoke'
    LM_JENKINS_RETENTION_CREDENTIALS = 'lm-jenkins-api-retention'
  }

  stages {
    stage('Init') {
      steps {
        script { runInitStage() }
      }
    }

    // 工具鏈版本先寫入 Build_Record 再判定；不一致時於安裝前失敗（Req 3.3）。Bun 的 Build_Image 與 Rust 工具鏈映像。
    stage('Toolchain') {
      steps {
        script { runToolchainStage() }
      }
    }

    // bun install --frozen-lockfile 與 cargo fetch --locked；lockfile 不存在、不一致或被修改皆失敗（Req 3.4、3.5）。
    stage('Install') {
      steps {
        script { runInstallStage() }
      }
    }

    // 任何測試之前先建置（cargo build、trunk build --release）；非零結束碼使建置失敗並略過所有後續階段（Req 3.6、3.7）。
    stage('Build') {
      steps {
        script { runBuildStage() }
      }
    }

    // cargo fmt／clippy／test、bats 與 bun test →「QA」關卡（說明見 runUnitTestsStage）
    stage('Unit Tests') {
      steps {
        script { runUnitTestsStage() }
      }
      post {
        always {
          script { unitTestsPostAlways() }
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

    // ---------------------------------------------------------------- App_Image 與部署（main 專用）

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

    // App_Image 推送與 digest 比對；版本標籤已存在即拒絕（說明見 runImagePushStage）
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

    // Production 部署、觀察期與「上線後」關卡（說明見 runProductionDeployStage）
    stage('Production Deploy') {
      when {
        expression { planned('Production Deploy') && env.LM_TRUSTED == 'true' && env.LM_TRIGGER_KIND == 'main_push' }
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

    // 版本標籤 v<版本>，「上線後」關卡通過後才建立，不覆寫既有標籤（說明見 runVersionTagStage）
    stage('Version Tag') {
      when {
        expression { planned('Version Tag') && env.LM_TRUSTED == 'true' && env.LM_TRIGGER_KIND == 'main_push' }
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
    env.LM_REF = env.BRANCH_NAME ?: (env.TAG_NAME ?: '')

    // 建立本次執行唯一的 Build_Record（Req 21.1）：建置編號、開始時間、完整 SHA、觸發類型、ref、Build_Image digest。
    sh(label: 'Build_Record init', script: '''
      bun ci/record.mjs init --record "$LM_RECORD" \
        --job "$JOB_NAME" --number "$BUILD_NUMBER" --url "$BUILD_URL" \
        --commit "$GIT_COMMIT_FULL" --trigger "$LM_TRIGGER_KIND" --ref "$LM_REF" \
        --build-image-digest "$BUILD_IMAGE_DIGEST"
    ''')

    if (planRc != 0 || plan.reject || !plan.kind) {
      // reject 字串為 ci/stages.mjs 內的固定訊息，不含使用者輸入（Tag 事件：發布由 main 的推送執行）。
      error("觸發被拒絕：${plan.reject ?: '無法規劃階段'}")
    }

    // main 的發布版本 v<Cargo.toml 的 [workspace.package] version>（plan.md D2）：Image Push 拒絕已存在的版本標籤，
    // Version Tag 在「上線後」關卡通過後建立。版本格式與 Release_Tag 相同（isReleaseTag）。
    if (env.LM_TRIGGER_KIND == 'main_push') {
      int versionRc = sh(label: 'ci/release-version.mjs', returnStatus: true, script: 'bun ci/release-version.mjs > reports/release-version.txt')
      String version = versionRc == 0 ? readFile('reports/release-version.txt').trim() : ''
      if (!isReleaseTag(version)) {
        error("無法由 Cargo.toml 的 [workspace.package] version 取得發布版本（ci/release-version.mjs 結束碼 ${versionRc}）")
      }
      env.LM_RELEASE_VERSION = version
    }
  }

  assertJobFolder(env.LM_TRUSTED == 'true')
  echo "觸發類型 ${env.LM_TRIGGER_KIND}（trusted=${env.LM_TRUSTED}），commit ${sha}"
}

// 工具鏈（Req 3.3；plan.md D3）：Build_Image 的 Bun 工具鏈（ci/toolchain.json）→ Rust 工具鏈映像（根目錄 Dockerfile 的
// toolchain 階段）→ 映像內 ci/verify-rust-toolchain.sh 比對 ci/rust-toolchain.json。版本先寫入 Build_Record 再判定。
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

  buildRustToolchain()
  int rustRc = 2
  inRustToolchain(false) {
    rustRc = sh(
      label: 'ci/verify-rust-toolchain.sh',
      returnStatus: true,
      script: 'sh ci/verify-rust-toolchain.sh --expected ci/rust-toolchain.json --out reports/rust-toolchain.json'
    )
  }
  Map reports = existingReports([rustToolchain: 'reports/rust-toolchain.json', rustToolchainBuild: 'reports/rust-toolchain-build.log'])
  if (!reports.isEmpty()) {
    mergeRecordPatch('reports/rust-toolchain-record-patch.json', [reports: reports])
  }
  if (rustRc != 0) {
    error('Rust 工具鏈版本與 ci/rust-toolchain.json 不一致（工具名稱、預期與實際版本見 reports/rust-toolchain.json）')
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
  // cargo 的相依套件（所有平台，含 wasm32）只在這裡下載；之後的 Build 與 Unit Tests 以 --network none 離線執行（plan.md D15）。
  inRustToolchain(true) {
    sh(label: 'cargo fetch --locked', script: '''
      set -eu
      if [ ! -f Cargo.lock ]; then
        echo "找不到 Cargo.lock，安裝中止" >&2
        exit 1
      fi
      before="$(sha256sum Cargo.lock)"
      cargo fetch --locked
      after="$(sha256sum Cargo.lock)"
      if [ "$before" != "$after" ]; then
        echo "Cargo.lock 在 cargo fetch 期間被修改，安裝中止" >&2
        exit 1
      fi
    ''')
  }
}

// 建置（Req 3.6、3.7；plan.md D15）：Rust 工具鏈映像內（--network none、cargo 離線）cargo build --workspace --locked
// → trunk build --release（LM_Web 的 wasm 與 dist；wasm-bindgen 與 wasm-opt 使用映像內的固定版本，不另外下載）。
void runBuildStage() {
  enterStage('Build')
  inRustToolchain(false) {
    sh(label: 'cargo build --workspace --locked', script: 'cargo build --workspace --locked')
    sh(label: 'trunk build --release', script: 'trunk build --release --config crates/web/Trunk.toml')
  }
}

// 單元與整合測試（Req 4.1、4.4、4.5、4.7；plan.md D15）。Rust 工具鏈映像內（--network none）：
//   cargo fmt --all --check → cargo clippy --workspace --locked -- -D warnings → cargo test --workspace --locked（30 分鐘）
//   → bats deploy/tests（JUnit 寫入 reports/bats/report.xml，15 分鐘）
// Build_Image 內：ci/cargo-junit.mjs（cargo test 日誌 → reports/cargo-junit.xml）→ bun test LM_BUN_TESTS（15 分鐘）
//   →「QA」關卡（ci/gates.mjs：三份 JUnit 的失敗數、錯誤數為 0 且測試數量 > 0）寫入 Build_Record 後才判定。
// fmt 或 clippy 未通過即以指名該檢查的固定訊息失敗；任何失敗都由 post 記錄「QA」未通過與原因（Req 4.6、23.3）。
void runUnitTestsStage() {
  enterStage('Unit Tests')
  sh(label: 'reset test reports', script: '''
    set -eu
    rm -rf reports/bats
    rm -f reports/cargo-fmt.log reports/cargo-clippy.log reports/cargo-test.log reports/cargo-junit.xml reports/bats.log reports/unit-junit.xml
    mkdir -p reports/bats
  ''')
  int cargoRc = 2
  int batsRc = 2
  inRustToolchain(false) {
    qaStep('cargo fmt --all --check 未通過（程式碼格式與 rustfmt 不一致）')
    int fmtRc = sh(label: 'cargo fmt --all --check', returnStatus: true, script: 'cargo fmt --all --check > reports/cargo-fmt.log 2>&1')
    if (fmtRc != 0) {
      error('cargo fmt --all --check 未通過（見 reports/cargo-fmt.log）')
    }
    qaStep('cargo clippy --workspace --locked -- -D warnings 未通過')
    int clippyRc = sh(label: 'cargo clippy -D warnings', returnStatus: true, script: 'cargo clippy --workspace --locked -- -D warnings > reports/cargo-clippy.log 2>&1')
    if (clippyRc != 0) {
      error('cargo clippy --workspace --locked -- -D warnings 未通過（見 reports/cargo-clippy.log）')
    }
    qaStep('cargo test 未在 30 分鐘內結束')
    // 外層保護；實際上限由 shell 的 timeout 執行，逾時結束碼 124／137。
    timeout(time: 32, unit: 'MINUTES') {
      cargoRc = sh(label: 'cargo test --workspace --locked', returnStatus: true, script: '''
        set -u
        rc=0
        timeout --kill-after=30 1800 cargo test --workspace --locked > reports/cargo-test.log 2>&1 || rc=$?
        tail -n 30 reports/cargo-test.log || true
        exit "$rc"
      ''')
    }
    if (cargoRc == 124 || cargoRc == 137) {
      error('cargo test 超過 30 分鐘，已中止')
    }
    qaStep('bats deploy/tests 未在 15 分鐘內結束')
    timeout(time: 17, unit: 'MINUTES') {
      batsRc = sh(label: 'bats deploy/tests', returnStatus: true, script: '''
        set -u
        rc=0
        timeout --kill-after=30 900 bats --report-formatter junit --output reports/bats deploy/tests > reports/bats.log 2>&1 || rc=$?
        tail -n 30 reports/bats.log || true
        exit "$rc"
      ''')
    }
    if (batsRc == 124 || batsRc == 137) {
      error('bats deploy/tests 超過 15 分鐘，已中止')
    }
  }
  inBuildImage {
    qaStep('cargo test 的輸出無法轉為 JUnit（ci/cargo-junit.mjs）')
    int convRc = 2
    withEnv(["LM_CARGO_TEST_EXIT=${cargoRc}"]) {
      convRc = sh(label: 'ci/cargo-junit.mjs', returnStatus: true, script: 'bun ci/cargo-junit.mjs --log reports/cargo-test.log --out reports/cargo-junit.xml --exit "$LM_CARGO_TEST_EXIT"')
    }
    if (convRc != 0) {
      error("ci/cargo-junit.mjs 無法產生 reports/cargo-junit.xml（結束碼 ${convRc}）")
    }
    qaStep('bun test 未在 15 分鐘內結束')
    int testRc = 2
    timeout(time: 17, unit: 'MINUTES') {
      testRc = sh(label: 'bun test', returnStatus: true, script: '''
        set -u
        rm -f reports/unit-junit.xml
        # LM_BUN_TESTS 的萬用字元由 shell 展開，因此不加引號。
        timeout --kill-after=30 900 bun test --reporter=junit --reporter-outfile=reports/unit-junit.xml ${LM_BUN_TESTS}
      ''')
    }
    if (testRc == 124 || testRc == 137) {
      error('bun test 超過 15 分鐘，已中止')
    }
    qaStep('cargo test、bats 或 bun test 未通過（見 reports/cargo-junit.xml、reports/bats/report.xml、reports/unit-junit.xml）')
    if (cargoRc != 0 || batsRc != 0 || testRc != 0) {
      error("測試未通過（cargo test 結束碼 ${cargoRc}、bats ${batsRc}、bun test ${testRc}；見 reports/cargo-junit.xml、reports/bats/report.xml、reports/unit-junit.xml）")
    }
    qaStep('')
    if (recordQa(patch: 'reports/unit-record-patch.json', reports: unitReports(), gate: true, junit: qaJunitReports(), inventory: '', stageError: '') != 0) {
      error('Release_Gate「QA」未通過（未符合的條件見 Build_Record 與 reports/gate-qa.json）')
    }
  }
}

void unitTestsPostAlways() {
  junit(testResults: 'reports/cargo-junit.xml, reports/bats/report.xml, reports/unit-junit.xml', allowEmptyResults: true)
  if (env.LM_QA_GATE_RECORDED == 'true') { return }
  // 階段在關卡評估前失敗、逾時或中止：JUnit 與日誌仍寫入 Build_Record（Req 4.5），「QA」關卡記錄為未通過，
  // 含關卡名稱、未符合的條件與失敗原因（不含憑證值；Req 4.6、23.1、23.3、23.5）。
  inBuildImage {
    recordQa(
      patch: 'reports/unit-record-patch.json',
      reports: unitReports(),
      gate: true,
      junit: qaJunitReports(),
      inventory: '',
      stageError: qaStageError('Unit Tests')
    )
  }
}

// 靜態安全掃描（Req 6.1–6.9）：Gitleaks（受版本控制檔案 + Git 歷史範圍，--redact）→ osv-scanner v2（bun.lock）
// → osv-scanner v2（Rust 版本的 Cargo.lock）→ Trivy（安裝後的 node_modules 交叉掃描）→ Semgrep（src/、server/、scripts/）。
// 每項掃描 15 分鐘逾時。結果經 ci/policy/normalize.mjs → ci/policy/evaluate.mjs 判定「安全」關卡（plan.md D14 已移除 DAST）。
// Semgrep 沒有 Rust 規則，Rust 程式碼的 SAST 仍是 README.md「CI/CD 與部署（Rust 版本）」的「安全掃描範圍的例外」。
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

  // Gitleaks：Git 歷史範圍（Untrusted_PR：merge base..HEAD；其他：上次成功建置或 LM_GITLEAKS_HISTORY_BASE..HEAD）。
  // 範圍無法決定時 LM_GITLEAKS_LOG_OPTS 為空，不執行歷史掃描，prepareScanSources 已記錄為掃描未完成（Req 6.8）。
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

  // osv-scanner v2：依 Rust 版本的 Cargo.lock 掃描 workspace 的直接與間接相依（Req 6.2）。另存一份報告，
  // 所以 Cargo.lock 無法解析（套件數為 0）時只有這份報告未完成，不會被 bun.lock 的套件數掩蓋。
  runScan('osv-scanner（Cargo.lock）', 'osv-cargo.json', '''
    set -u
    if [ ! -f "$LM_SCAN_DIR/tree/Cargo.lock" ]; then
      echo "找不到 Cargo.lock" >&2
      exit 3
    fi
    rc=0
    timeout --kill-after=30 900 docker run --rm --name "$LM_SCAN_RUN-osv-scanner-cargo" \
      --label "lm.ci.build=$BUILD_TAG" --label "lm.ci.scan=$LM_SCAN_RUN" \
      --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=512m -e HOME=/tmp \
      --security-opt no-new-privileges:true --cap-drop ALL --network bridge \
      --mount "type=bind,src=$LM_SCAN_DIR/tree,dst=/src,readonly" \
      --mount "type=bind,src=$LM_SCAN_DIR/out,dst=/out" \
      "$LM_OSV_SCANNER_IMAGE" \
      scan source --lockfile=/src/Cargo.lock --all-packages --format json --output-file "/out/$LM_SCAN_REPORT" || rc=$?
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
      for spec in gitleaks:gitleaks-dir gitleaks:gitleaks-git osv-scanner:osv osv-scanner:osv-cargo trivy:trivy-node-modules semgrep:semgrep; do
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
      for name in osv osv-cargo trivy-node-modules semgrep; do
        if [ -f "$LM_SCAN_DIR/out/$name.json" ]; then cp "$LM_SCAN_DIR/out/$name.json" "reports/security/raw/$name.json"; fi
      done
      exit 0
    ''')
    int evalRc = sh(label: 'ci/policy/evaluate.mjs', returnStatus: true, script: '''
      set -u
      rm -f reports/security/evaluation.json
      bun ci/policy/evaluate.mjs \
        --reports reports/security/gitleaks-dir.json reports/security/gitleaks-git.json reports/security/osv.json reports/security/osv-cargo.json reports/security/trivy-node-modules.json reports/security/semgrep.json \
        --exceptions security/exceptions.json --commit "$GIT_COMMIT_FULL" --today "$LM_SCAN_TODAY" \
        --out reports/security/evaluation.json
    ''')
    if (evalRc != 0 && evalRc != 1) {
      lmScanErrors << "安全政策評估無法執行（ci/policy/evaluate.mjs 結束碼 ${evalRc}）".toString()
    }
  }
  secStep('')

  // 「安全」關卡（Req 23.2）：寫入 Build_Record 後才判定（Req 6.7、23.5）。
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

// ci/stages.mjs 只在 main_push 規劃 Image Build → Image Scan → SBOM → Image Push → Image Sign（TRUSTED_ONLY_STAGES；
// Req 1.3、2.8、16.1）。
// 「映像」關卡分兩次評估並寫入 Build_Record（Req 23.2、23.5）：SBOM 之後評估推送前部分（掃描秘密數 0、未處理
// Critical/High 為 0、SBOM 已保存），簽章之後評估完整條件（另含簽章已推送且可驗證、Build_Record 記錄 digest 與 commit）。
// 任一映像階段在關卡評估前失敗、逾時或中止 → post 記錄「映像」未通過（Req 23.1、23.3），不執行後續推送與部署階段。
//
// App_Image 建置（Req 16.1、16.8、16.9；Design §11；plan.md D4）：確認本次「QA」與「安全」關卡皆已通過 →
// 驗證並拉取映像工具 → ci/scripts/build-image.sh（根目錄 Dockerfile 的 runtime 階段：lm-server、trunk dist 與
// supabase/migrations；OCI 標籤、`<repo>:<完整 SHA>`、映像內容檢查）→ ci/scripts/image-smoke.sh（以打包後的映像連線
// Ephemeral_Database、確認 /app/migrations 與 supabase/migrations 相同、啟動並檢查 HTTP 回應）。
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

  // 打包後伺服器的行為（Req 16.2）：推送前以映像本身啟動 lm-server 並檢查 HTTP 回應（ci/scripts/image-smoke.sh）。
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
// Syft 的 /tmp tmpfs 加上 mode=1777（Design Components 第 28.1 節）：--tmpfs 會複製 Syft 映像 /tmp 的權限模式，
// 非 root uid 無法在其中建立 stereoscope 目錄（建置 #14）。不使用 --quiet；stderr 寫入 $LM_IMG_DIR/syft.log
// （不在 reports/ 下、不封存），失敗（含 rc=3：結束碼 0 但沒有 SBOM）時印出最後 20 行，之後一律刪除（第 28.2 節、Req 17.9）。
void runSbomStage() {
  enterStage('SBOM')
  imgStep('Syft 無法產生 SBOM')
  int syftRc
  timeout(time: 17, unit: 'MINUTES') {
    syftRc = sh(label: 'Syft SBOM', returnStatus: true, script: '''
      set -u
      rm -f "$LM_IMG_DIR/out/sbom.cdx.json" reports/sbom.cdx.json reports/sbom-summary.json "$LM_IMG_DIR/syft.log"
      rc=0
      timeout --kill-after=30 900 docker run --rm --name "$LM_IMG_RUN-syft" \
        --label "lm.ci.build=$BUILD_TAG" --label "lm.ci.image=$LM_IMG_RUN" \
        --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=4g,mode=1777 -e HOME=/tmp -e TMPDIR=/tmp \
        --security-opt no-new-privileges:true --cap-drop ALL --network none \
        -e SYFT_CHECK_FOR_APP_UPDATE=false \
        --mount "type=bind,src=$LM_IMG_DIR/scan,dst=/scan,readonly" \
        --mount "type=bind,src=$LM_IMG_DIR/out,dst=/out" \
        "$LM_SYFT_IMAGE" \
        scan docker-archive:/scan/image.tar --output cyclonedx-json=/out/sbom.cdx.json 2> "$LM_IMG_DIR/syft.log" || rc=$?
      if [ "$rc" -eq 0 ] && [ -s "$LM_IMG_DIR/out/sbom.cdx.json" ]; then
        cp "$LM_IMG_DIR/out/sbom.cdx.json" reports/sbom.cdx.json
      elif [ "$rc" -eq 0 ]; then
        rc=3
      fi
      if [ "$rc" -ne 0 ]; then
        echo 'Syft 錯誤輸出（最後 20 行）：'
        tail -n 20 "$LM_IMG_DIR/syft.log" 2>/dev/null || true
      fi
      rm -f "$LM_IMG_DIR/syft.log"
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

// 推送與 digest 比對（Req 16.10、17.5、17.6、21.2；plan.md D2）：推送帳號只在此 withCredentials 內，docker 登入資訊只存在
// 本建置暫存目錄（結束即刪除）。版本標籤 `<repo>:<LM_RELEASE_VERSION>` 已存在即拒絕（該版本已發布，須先提高 Cargo.toml 的
// [workspace.package] version）→ `<repo>:<完整 SHA>` 已存在即拒絕覆寫（每次建置的 OCI created 標籤不同，同一 commit
// 重建的內容必然不同；Req 16.10）→ docker push → 本機 RepoDigest、Registry 的標籤 digest 與以 digest 查詢的結果三者
// 必須一致 → reports/image-digest.txt（內容恰為 `<digest>\n`）封存並 fingerprint，供 release/digest-lookup 查詢。
void runImagePushStage() {
  enterStage('Image Push')
  if (env.LM_SBOM_OK != 'true' || !env.LM_IMAGE_REF) {
    imgStep('SBOM 未保存或 App_Image 未建置，不推送')
    error('SBOM 未保存或 App_Image 未建置，不推送 App_Image（Req 17.4、17.5）')
  }
  if (!isReleaseTag(env.LM_RELEASE_VERSION ?: '')) {
    imgStep('發布版本無效，不推送')
    error('LM_RELEASE_VERSION 不是有效的版本（Init 由 Cargo.toml 取得），不推送 App_Image')
  }
  imgStep('App_Image 推送失敗、版本或標籤已存在（拒絕覆寫）或 Registry 回報的 Image_Digest 與建置結果不一致')
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
        crane digest "$LM_IMAGE_REPO:$LM_RELEASE_VERSION" > "$out/version-digest.txt" 2> "$out/version-digest.err" || rc=$?
        if [ "$rc" -eq 0 ]; then
          echo "Registry 已存在版本標籤 $LM_RELEASE_VERSION（版本已發布）" >&2
          exit 16
        fi
        if ! grep -Eq 'MANIFEST_UNKNOWN|unexpected status code 404' "$out/version-digest.err"; then
          echo "Registry 查詢失敗，無法確認版本標籤是否已存在" >&2
          exit 11
        fi
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
  if (pushRc == 16) {
    appendSummary("版本 ${env.LM_RELEASE_VERSION} 已發布；請先提高 Cargo.toml 的 [workspace.package] version".toString())
    error("版本 ${env.LM_RELEASE_VERSION} 已發布；請先提高 Cargo.toml 的 [workspace.package] version（plan.md D2），未推送 App_Image")
  } else if (pushRc == 10) {
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
  // fingerprint ID 為 MD5(`<digest>\n`)，release/digest-lookup 以此找回本 Build_Record（Req 21.7）。
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
//   → SSH 受限金鑰 `lm-deploy staging deploy <digest> --app-env-stdin`（stdin 為 lm-staging-supabase-env）：app.env
//     → Supabase 服務（db、auth、realtime、gateway；plan.md D6）→ 備份並驗證 → 遷移（plan.md D7）→ 以 repo@digest 在閒置
//     槽位啟動 → 120 秒內每 10 秒 Health_Check、連續 3 次成功 → 切換（Req 14.1–14.3、18.1–18.3、18.7）
//   → Smoke_Test（ci/smoke.mjs --provision，10 分鐘內，Req 18.3；plan.md D9）→ finalize
//   → `cosign attest` staging-verified predicate → `cosign verify-attestation`
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

// Production 部署、觀察期與「上線後」關卡（Req 14.1–14.3、17.7、17.8、20.1–20.7、20.9、20.11、20.12、22.5、23.1；plan.md D1、D10）。
// main 的推送在「Staging」關卡通過後自動執行，沒有人工核准（合併到 main 即是發布的決定）：
//   lock(resource: 'lm-prod', skipIfLocked: true)：取不到即以「已有部署進行中」失敗（Req 20.12）
//   → `lm-deploy prod status`：沒有作用中的版本（尚未完成首次切換）即記錄「上線後」未通過並停止，不呼叫 deploy（D10）
//   → `cosign verify` → SSH 受限金鑰 `lm-deploy prod deploy <digest> --app-env-stdin`（stdin 為 lm-prod-supabase-env）：
//     app.env → Supabase 服務 → 備份並驗證 → 遷移 → 閒置槽位啟動 → 120 秒內每 5 秒 Health_Check、連續 3 次成功
//     → 切換（grace 30 秒）（Req 14.1–14.3、20.2–20.4）
//   → 10 分鐘觀察期：每 10 秒 `health`（共 60 次）、切換後與結束前各一次 Smoke_Test，每筆以 shouldRollback 判定
//   → 通過：finalize（停止舊槽位、記錄目前版本、保留 3 個映像，Req 20.7）；未通過：`lm-deploy prod rollback`
//     （切回舊槽位、停止新槽位、不執行遷移）→ 舊槽位 `health --wait`（Req 20.6、20.9、20.11）
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

  // 「Staging」關卡未通過時不部署也不評估「上線後」（Req 23.2）。
  requireStagingPassed()
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

// 版本標籤（plan.md D2；Req 16.6、16.10）：「上線後」關卡通過（Production 已執行此 Image_Digest）後，
// `<repo>:<LM_RELEASE_VERSION>` 不存在 → `crane tag <repo>@<digest>`（寫入後再次確認）；已指向相同 digest → 不動作；
// 指向不同 digest → 拒絕覆寫並失敗。推送帳號只在 pushVersionTag 的 withCredentials 內。
void runVersionTagStage() {
  enterStage('Version Tag')
  requirePostDeployPassed()
  assertProductionConfig()
  pullImages([env.LM_CRANE_IMAGE])
  prepareReleaseWork()
  applyVersionTag()
}

// 收尾（Req 2.6、15.4、21.2、21.6、21.9、21.11、22.2–22.4、22.7、22.8、23.1；Design §9、§16、Error Handling）。
// 所有階段（含各階段自己的 post）結束後依序執行；每一步以 postStep（catchError）隔離：任一步失敗只會讓建置結果
// 變差（SUCCESS → FAILURE；FAILURE／ABORTED 不會被覆蓋），且不會略過後續步驟。
//   1. Build_Record finalize：最終結果、結束時間、結果非 SUCCESS 時第一個失敗或中止的階段（LM_CURRENT_STAGE）
//   2. 封存前遮罩：重新取得本建置用過的憑證（Supabase 金鑰檔逐行）→ ci/scrub.mjs 處理 reports/
//      全部檔案至暫存目錄（仍有命中者只輸出 .withheld.txt 說明檔並使建置失敗）→ archiveArtifacts 遮罩後的副本
//      （Build_Record fingerprint；image-digest.txt 已於產生時封存並 fingerprint，不重複封存）
//   3. keepLog：main 建置的 Image_Digest 通過觀察期（已在 Production 執行）時，以 Jenkins API 保留本建置
//   4. 依 label lm.ci.build=$BUILD_TAG 移除本建置的容器、網路與卷（只移除本建置的資源）與 Rust 工具鏈映像的本建置標籤
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
 * Rust 工具鏈映像（plan.md D3）：以根目錄 Dockerfile 的 toolchain 階段、空的建置內容（$WORKSPACE_TMP 下的空目錄）建置，
 * 標記為 <LM_RUST_TOOLCHAIN_IMAGE_REPO>:<完整 SHA>，只存在本 Agent、不推送。toolchain 階段不 COPY 任何 repository 檔案，
 * FROM 以 digest 固定、下載的工具以 SHA-256 檢查；Docker 的層快取讓 Dockerfile 未變更時不重新下載。
 * 同時準備 cargo 快取卷（CARGO_HOME）：名稱依信任等級加上 -ci／-release（兩個 Agent 共用同一個 Docker daemon，
 * Untrusted 建置寫入的快取不得被 Trusted 建置讀取），第一次建立時根目錄屬於 root，交給 Agent 的 uid／gid。
 * 建置日誌寫入 reports/rust-toolchain-build.log。需在 Agent 上執行。
 */
void buildRustToolchain() {
  if (!((env.LM_RUST_TOOLCHAIN_IMAGE_REPO ?: '') ==~ /^[a-z0-9][a-z0-9._-]{0,63}$/) ||
      !((env.LM_CARGO_CACHE_VOLUME ?: '') ==~ /^[a-z0-9][a-z0-9._-]{0,55}$/)) {
    error('LM_RUST_TOOLCHAIN_IMAGE_REPO 或 LM_CARGO_CACHE_VOLUME 格式無效')
  }
  env.LM_RUST_TOOLCHAIN_IMAGE = "${env.LM_RUST_TOOLCHAIN_IMAGE_REPO}:${env.GIT_COMMIT_FULL}".toString()
  env.LM_CARGO_VOLUME = "${env.LM_CARGO_CACHE_VOLUME}-${env.LM_TRUSTED == 'true' ? 'release' : 'ci'}".toString()
  int rc
  timeout(time: 45, unit: 'MINUTES') {
    rc = sh(label: 'docker build --target toolchain', returnStatus: true, script: '''
      set -u
      ctx="$WORKSPACE_TMP/lm-rust-toolchain-context"
      rm -rf "$ctx"
      mkdir -m 0700 "$ctx"
      rc=0
      DOCKER_BUILDKIT=1 docker build --target toolchain --file "$WORKSPACE/Dockerfile" \
        --label "lm.ci.build=$BUILD_TAG" --tag "$LM_RUST_TOOLCHAIN_IMAGE" "$ctx" > reports/rust-toolchain-build.log 2>&1 || rc=$?
      rm -rf "$ctx"
      if [ "$rc" -ne 0 ]; then
        echo 'docker build --target toolchain 的輸出（最後 40 行）：'
        tail -n 40 reports/rust-toolchain-build.log || true
        exit "$rc"
      fi
      docker volume create "$LM_CARGO_VOLUME" > /dev/null || exit 30
      docker run --rm --network none --user 0:0 --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges:true \
        --label "lm.ci.build=$BUILD_TAG" \
        --mount "type=volume,src=$LM_CARGO_VOLUME,dst=/cargo-cache" \
        --entrypoint chown "$LM_RUST_TOOLCHAIN_IMAGE" "$(id -u):$(id -g)" /cargo-cache || exit 31
      exit 0
    ''')
  }
  if (rc == 30 || rc == 31) {
    error('無法準備 cargo 快取卷（LM_CARGO_CACHE_VOLUME）')
  } else if (rc != 0) {
    error("Rust 工具鏈映像建置失敗（docker build --target toolchain 結束碼 ${rc}，見 reports/rust-toolchain-build.log）")
  }
}

/**
 * 在 Rust 工具鏈映像內執行（plan.md D3、D15）。CARGO_HOME 為本信任等級的 cargo 快取卷，CARGO_TARGET_DIR 在工作目錄內，
 * HOME 在本建置的暫存目錄。network=false（Toolchain 檢查、Build、Unit Tests）時容器以 --network none 執行，cargo 與
 * trunk 皆為離線模式；只有 Install 的 `cargo fetch --locked` 可連網。需在 Agent 上呼叫。
 */
def inRustToolchain(boolean network, Closure body) {
  if (!((env.LM_RUST_TOOLCHAIN_IMAGE ?: '') ==~ /^[a-z0-9][a-z0-9._-]{0,63}:[0-9a-f]{40}$/) ||
      !((env.LM_CARGO_VOLUME ?: '') ==~ /^[a-z0-9][a-z0-9._-]{0,55}-(ci|release)$/)) {
    error('Rust 工具鏈映像或 cargo 快取卷尚未準備（Toolchain 階段未完成）')
  }
  String args = (network ? '' : '--network none ') + "--mount type=volume,src=${env.LM_CARGO_VOLUME},dst=/cargo-cache"
  String offline = network ? 'false' : 'true'
  docker.image(env.LM_RUST_TOOLCHAIN_IMAGE).inside(args) {
    withEnv([
      "HOME=${env.WORKSPACE_TMP}/home",
      'CARGO_HOME=/cargo-cache',
      "CARGO_TARGET_DIR=${env.WORKSPACE}/target",
      "CARGO_NET_OFFLINE=${offline}",
      "TRUNK_OFFLINE=${offline}",
      'CARGO_TERM_COLOR=never',
      'CI=1',
    ]) {
      body()
    }
  }
}

def buildImageContainer(String args, Closure body) {
  docker.image(env.BUILD_IMAGE).inside(args) {
    withEnv(["HOME=${env.WORKSPACE_TMP}/home", "BUN_INSTALL_CACHE_DIR=${env.WORKSPACE_TMP}/bun-cache", 'CI=1']) {
      body()
    }
  }
}

// ------------------------------------------------------------------ Rust 工具鏈與「QA」關卡

/** 記錄目前步驟失敗時寫入「QA」關卡的原因（固定訊息，不含憑證值）。 */
void qaStep(String reason) {
  env.LM_QA_STAGE_ERROR = reason
}

String qaStageError(String stage) {
  return env.LM_QA_STAGE_ERROR ?: "${stage} 階段執行失敗或已中止"
}

/** 「QA」關卡的 JUnit（plan.md D15）：cargo test、bats 與 bun test。 */
List qaJunitReports() {
  return ['reports/cargo-junit.xml', 'reports/bats/report.xml', 'reports/unit-junit.xml']
}

/** Unit Tests 寫入 Build_Record 的報告（只保留實際存在者）。 */
Map unitReports() {
  return existingReports([
    cargoJunit: 'reports/cargo-junit.xml',
    batsJunit: 'reports/bats/report.xml',
    unitJunit: 'reports/unit-junit.xml',
    cargoFmt: 'reports/cargo-fmt.log',
    cargoClippy: 'reports/cargo-clippy.log',
    cargoTest: 'reports/cargo-test.log',
    batsLog: 'reports/bats.log',
  ])
}

/** 只保留實際存在的報告；不存在者由 finalizeRecord 標示「未執行」（Req 21.2）。 */
Map existingReports(Map candidates) {
  Map out = [:]
  candidates.each { key, path ->
    if (fileExists(path)) { out[key] = path }
  }
  return out
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
 *       其他建置    → 起點 LM_GITLEAKS_HISTORY_BASE（Secret_History_Baseline）須為 40 hex、存在且為建置 commit 的祖先，
 *                     否則不輸出範圍，歷史掃描視為未完成（Req 6.8、6.10）；沒有完整歷史的分支。
 *                     `$GIT_PREVIOUS_SUCCESSFUL_COMMIT..<sha>`：須為 40 hex、存在、為建置 commit 的祖先且為起點的後代（含相同）；
 *                     否則 `<LM_GITLEAKS_HISTORY_BASE>..<sha>`。
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
      # Secret_History_Baseline（Req 6.1、6.10）：無效或不是建置 commit 的祖先時不輸出 → 歷史掃描未完成。
      floor="${LM_GITLEAKS_HISTORY_BASE:-}"
      printf '%s\\n' "$floor" | grep -Eqx '[0-9a-f]{40}' || exit 0
      git cat-file -e "$floor^{commit}" 2>/dev/null || exit 0
      git merge-base --is-ancestor "$floor" "$head" 2>/dev/null || exit 0
      start="$floor"
      prev="${GIT_PREVIOUS_SUCCESSFUL_COMMIT:-}"
      if printf '%s\\n' "$prev" | grep -Eqx '[0-9a-f]{40}' \
        && git cat-file -e "$prev^{commit}" 2>/dev/null \
        && git merge-base --is-ancestor "$prev" "$head" 2>/dev/null \
        && git merge-base --is-ancestor "$floor" "$prev" 2>/dev/null; then
        start="$prev"
      fi
      printf '%s..%s\\n' "$start" "$head"
    ''').trim()
  }
  String sha = env.GIT_COMMIT_FULL
  boolean rangeOk = pr ? (range ==~ /^[0-9a-f]{40}\.\.[0-9a-f]{40}$/) : (range ==~ /^([0-9a-f]{40}\.\.)?[0-9a-f]{40}$/)
  if (rangeOk && range.endsWith(sha)) {
    env.LM_GITLEAKS_LOG_OPTS = range
    echo "Gitleaks Git 歷史範圍：${range}"
  } else {
    env.LM_GITLEAKS_LOG_OPTS = ''
    lmScanErrors << (pr ? 'Gitleaks（Git 歷史）無法取得 PR 與目標分支的 merge base，歷史掃描未完成' : 'Gitleaks（Git 歷史）無法決定掃描範圍（LM_GITLEAKS_HISTORY_BASE 無效或不是建置 commit 的祖先），歷史掃描未完成')
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

/**
 * 各掃描工具版本（Req 6.7），寫入 $LM_SCAN_DIR/out/<tool>.version；取不到時報告的 toolVersion 為 null。
 * Semgrep 以 SEMGREP_ENABLE_VERSION_CHECK=0 關閉版本檢查：沒有網路時 `semgrep --version` 印出版本後會等待
 * 版本檢查逾時（本機實測約 106 秒，超過 60 秒的 timeout；design.md Components 第 27.4 節）。
 */
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
    v semgrep -e SEMGREP_ENABLE_VERSION_CHECK=0 --entrypoint semgrep "$LM_SEMGREP_IMAGE" --version
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
    osvCargo: 'reports/security/osv-cargo.json',
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

// ------------------------------------------------------------------ 發布版本

/** 版本標籤格式 v<major>.<minor>.<patch>（各段 0 至 999999、無前導零；LM_RELEASE_VERSION 使用）。 */
boolean isReleaseTag(String tag) {
  return tag ==~ /^v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/
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
 * Image Build 的前提（Req 16.1、23.2）：本次建置的「QA」與「安全」關卡結果檔都存在、皆為通過且 commit 為本次
 * Commit SHA。任一不符即失敗，且不評估「映像」關卡。
 */
void requireQaAndSecurityPassed() {
  List checks = [
    ['reports/gate-qa.json', 'QA'],
    ['reports/gate-security.json', '安全'],
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
 * Production 部署的前提（Req 23.2；plan.md D1）：本建置的「Staging」關卡（reports/gate-staging.json）已記錄、通過且屬於
 * 本次 commit，Staging 已驗證此 Image_Digest，且 Image Push 取得的 Image_Digest 有效。任一不符即失敗，不評估「上線後」。
 */
void requireStagingPassed() {
  String text = fileExists('reports/gate-staging.json') ? readFile('reports/gate-staging.json') : ''
  if (env.LM_STG_GATE_DONE != 'true' || env.LM_STG_VERIFIED != 'true' || !gatePassed(text, env.GIT_COMMIT_FULL ?: '') ||
      !((env.LM_IMAGE_DIGEST ?: '') ==~ /^sha256:[0-9a-f]{64}$/)) {
    error('Release_Gate「Staging」未通過或結果缺失，不部署至 Production（Req 23.2）')
  }
}

/**
 * Version Tag 的前提（plan.md D2）：本建置的「上線後」關卡（reports/gate-post-deploy.json）已記錄、通過且屬於本次 commit，
 * 觀察期已通過（Production 正在執行此 Image_Digest），且版本有效。任一不符即失敗，不建立版本標籤。
 */
void requirePostDeployPassed() {
  String text = fileExists('reports/gate-post-deploy.json') ? readFile('reports/gate-post-deploy.json') : ''
  if (env.LM_PRD_OBSERVED != 'true' || env.LM_PRD_GATE_DONE != 'true' || !gatePassed(text, env.GIT_COMMIT_FULL ?: '') ||
      !((env.LM_IMAGE_DIGEST ?: '') ==~ /^sha256:[0-9a-f]{64}$/) || !isReleaseTag(env.LM_RELEASE_VERSION ?: '')) {
    error('Release_Gate「上線後」未通過或結果缺失，不建立版本標籤（plan.md D2）')
  }
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

  // 2. 部署：app.env → Supabase 服務 → 備份並驗證 → 遷移 → 以 repo@digest 啟動 → 每 10 秒 Health_Check → 切換。
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

/**
 * 以 SSH 受限金鑰執行 `lm-deploy staging deploy <digest> --app-env-stdin`；回傳 SSH 結束碼（即 lm-deploy 結束碼，連線失敗為 255）。
 * app.env（Supabase 金鑰：Secret file lm-staging-supabase-env，lm-supabase-keys 的輸出）只以 `<` 重新導向成為 stdin，
 * 內容不經 Groovy 變數、readFile、命令列或主控台（Req 15.1、15.2；plan.md D6、D13）；lm-deploy 在任何 docker 呼叫前
 * 檢查鍵名與格式，再以 0600 寫入 /srv/lm/staging/app.env。
 */
int stagingDeployCommand() {
  int rc
  withCredentials([sshUserPrivateKey(credentialsId: env.LM_SSH_STAGING_CREDENTIALS, keyFileVariable: 'LM_SSH_KEY', usernameVariable: 'LM_SSH_USER')]) {
    withCredentials([file(credentialsId: env.LM_KNOWN_HOSTS_CREDENTIALS, variable: 'LM_KNOWN_HOSTS')]) {
      withCredentials([file(credentialsId: env.LM_STAGING_STACK_ENV_CREDENTIALS, variable: 'LM_STACK_ENV_FILE')]) {
        rc = sh(label: 'lm-deploy staging deploy', returnStatus: true, script: stagingSshPrelude() + '''
          rm -f reports/staging/deploy.jsonl
          if [ ! -s "$LM_STACK_ENV_FILE" ]; then
            echo 'lm-staging-supabase-env 的檔案不存在或為空，未連線 Deploy_Host' >&2
            exit 2
          fi
          lm_ssh deploy "$LM_IMAGE_DIGEST" --app-env-stdin < "$LM_STACK_ENV_FILE" > reports/staging/deploy.jsonl
        ''')
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
 * Smoke_Test（Req 18.3；plan.md D9）：Build_Image 容器內經 LAN 對 Staging 代理執行 `ci/smoke.mjs --provision`，10 分鐘上限
 * （每步另有逾時）。登入回應 401 時以同一密碼註冊 smoke-bot（Staging 的 Database 是全新的，第一個帳號成為其管理員；
 * staging.env 的 LM_PUBLIC_SIGNUP=true）。密碼只以 Jenkins file credential 的路徑（LM_SMOKE_PASSWORD_FILE）提供。
 * 逾時或中止回傳 124。
 */
int runStagingSmoke() {
  int rc = 124
  String failure = null
  try {
    timeout(time: 10, unit: 'MINUTES') {
      withCredentials([file(credentialsId: env.LM_STAGING_SMOKE_CREDENTIALS, variable: 'LM_SMOKE_PASSWORD_FILE')]) {
        // LM_SCAN_CA_BUNDLE 已由 assertStagingConfig 驗證為絕對路徑；HTTPS 時 Bun 以 NODE_EXTRA_CA_CERTS 信任內部 CA。
        buildImageContainer("--mount type=bind,src=${env.LM_SCAN_CA_BUNDLE},dst=/etc/lm/lan-ca.crt,readonly") {
          withEnv([
            "LM_SMOKE_BASE_URL=${env.LM_STAGING_URL}",
            'LM_SMOKE_USERNAME=smoke-bot',
            'NODE_EXTRA_CA_CERTS=/etc/lm/lan-ca.crt',
          ]) {
            rc = sh(label: 'Smoke_Test（Staging）', returnStatus: true, script: '''
              set +x
              set -u
              rm -f reports/staging/smoke.json
              bun ci/smoke.mjs --provision > reports/staging/smoke.json
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

// ------------------------------------------------------------------ 版本標籤與共用的 Registry 操作

/** 建置摘要附加一行（不覆寫既有描述）；內容只含固定文字、已驗證的 SHA、digest、Tag 與 Jenkins 帳號。 */
void appendSummary(String line) {
  String current = currentBuild.description ?: ''
  currentBuild.description = current ? "${current}<br>${line}".toString() : line
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
 * 唯讀 Registry 操作（唯讀拉取帳號 + Credential_Store 的 cosign 公鑰）；結束碼與輸出保存於 reports/ 供判讀。action 只有固定的
 * 兩種：tag-get（版本標籤 `<repo>:<LM_RELEASE_VERSION>` 目前指向的 digest，由 ci/resolve-digest.mjs step version-tag 判讀）與
 * verify-prod（Production 部署前的簽章驗證）。digest 與版本只經環境變數傳入。回傳 crane／cosign 的結束碼（登入失敗為 20）。
 */
int releaseRegistry(String action) {
  if (!(action in ['tag-get', 'verify-prod'])) {
    error('內部錯誤：未知的 Registry 操作')
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
              tag-get)
                rm -f reports/release/version-tag.out reports/release/version-tag.err
                tool "$LM_CRANE_IMAGE" digest "$LM_IMAGE_REPO:$LM_RELEASE_VERSION" \
                  > reports/release/version-tag.out 2> reports/release/version-tag.err || rc=$?
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
 * 寫入版本標籤（Req 16.6、16.10；plan.md D2）：推送帳號只在此 withCredentials 內，docker 登入資訊只存在本階段工作目錄。
 * `crane tag <repo>@<digest> <LM_RELEASE_VERSION>` 後立即 `crane digest <repo>:<LM_RELEASE_VERSION>`，結束碼寫入檔案供判讀
 * （檢查與寫入之間的並行寫入由 version-tag-verify 偵測）。回傳 0 已寫入；20 登入失敗；30 crane tag 失敗。
 */
int pushVersionTag() {
  int rc
  withCredentials([usernamePassword(credentialsId: env.LM_REGISTRY_PUSH_CREDENTIALS, usernameVariable: 'LM_PUSH_USER', passwordVariable: 'LM_PUSH_PASSWORD')]) {
    timeout(time: 10, unit: 'MINUTES') {
      rc = sh(label: 'crane tag（版本標籤）', returnStatus: true, script: '''
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
        crane tag "$LM_IMAGE_REPO@$LM_IMAGE_DIGEST" "$LM_RELEASE_VERSION" > reports/release/version-tag-set.log 2>&1 || exit 30
        rc=0
        crane digest "$LM_IMAGE_REPO:$LM_RELEASE_VERSION" > reports/release/version-tag-after.out 2> reports/release/version-tag-after.err || rc=$?
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

/**
 * 版本標籤（plan.md D2；Req 16.10）：create → crane tag → 確認；noop（已指向此 digest）→ 不動作；conflict → 拒絕覆寫並失敗。
 * 版本為 Init 由 Cargo.toml 取得的 LM_RELEASE_VERSION。
 */
void applyVersionTag() {
  String tag = env.LM_RELEASE_VERSION ?: ''
  if (!isReleaseTag(tag)) {
    error('LM_RELEASE_VERSION 不是有效的版本（v<major>.<minor>.<patch>）')
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
    appendSummary("版本標籤 ${tag} 已指向不同的 Image_Digest，拒絕覆寫（Req 16.10）；請提高 Cargo.toml 的 [workspace.package] version".toString())
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
  appendSummary("版本 ${tag}：${env.LM_IMAGE_REPO}@${env.LM_IMAGE_DIGEST}".toString())
  echo "版本標籤 ${tag} → ${env.LM_IMAGE_DIGEST}（${d.decision}）"
}

// ------------------------------------------------------------------ Production 設定

/**
 * Production 與版本標籤的非秘密設定只接受固定格式：發布版本、crane／cosign 映像（digest 固定）、App_Image repository、
 * CA bundle、Deploy_Host 與 Production 的 LAN origin。
 */
void assertProductionConfig() {
  if (!isReleaseTag(env.LM_RELEASE_VERSION ?: '')) {
    error('LM_RELEASE_VERSION 不是有效的版本（v<major>.<minor>.<patch>；Init 由 Cargo.toml 的 [workspace.package] version 取得）')
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
  if (!((env.LM_DEPLOY_HOST ?: '') ==~ /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/)) {
    error('LM_DEPLOY_HOST 格式無效')
  }
  if (!((env.LM_DEPLOY_PORT ?: '') ==~ /^[1-9][0-9]{0,4}$/)) {
    error('LM_DEPLOY_PORT 格式無效')
  }
  if (!((env.LM_PROD_URL ?: '') ==~ /^https?:\/\/[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(:[1-9][0-9]{0,4})?$/)) {
    error('LM_PROD_URL 必須是 http(s)://<host>[:port]（不含路徑）')
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
 * 持有 lm-prod 鎖時執行（Req 20.12）：狀態與首次部署保護 → 簽章驗證 → deploy → 觀察期 → finalize 或回滾 →「上線後」關卡。
 */
void deployProduction() {
  String digest = env.LM_IMAGE_DIGEST ?: ''

  // 0. 首次部署的保護（plan.md D10）：Production 沒有作用中的版本時不自動部署。觀察期的 Smoke_Test 需要 smoke-bot 與
  //    管理員帳號，兩者只能在執行中的 stack 上建立（deploy/README.md 的首次切換），自動的第一次部署必然在觀察期失敗。
  prdStep('無法取得 Production 狀態')
  int stRc = prodHost('status', 'status-locked.json')
  if (stRc != 0) {
    prdStep('')
    recordProductionGate('無法取得 Production 狀態（lm-deploy prod status），未部署')
    error("無法取得 Production 狀態（lm-deploy prod status 結束碼 ${stRc}）；未變更 Production")
  }
  int activeRc = releaseCli('ci/production.mjs active', [], 'bun ci/production.mjs active --status reports/production/status-locked.json > reports/production/active-locked.json')
  Map a = readJsonFile('reports/production/active-locked.json')
  String base = a.digest instanceof String ? a.digest : ''
  if (activeRc != 0 || !(base ==~ /^sha256:[0-9a-f]{64}$/)) {
    prdStep('')
    recordProductionGate('Production 尚未完成首次部署，請依 deploy/README.md 的首次切換步驟完成 bootstrap')
    appendSummary('Production 尚未完成首次部署（見 deploy/README.md 的首次切換）；未呼叫 lm-deploy prod deploy，Production 未變更')
    error('Production 尚未完成首次部署（見 deploy/README.md 的首次切換）；未呼叫 lm-deploy prod deploy')
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

  // 2. 部署：app.env → Supabase 服務 → 備份並驗證 → 遷移 → 閒置槽位以 repo@digest 啟動 → 每 5 秒 Health_Check → 切換。
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
  echo "Production 已部署：${env.LM_IMAGE_REPO}@${digest}（${env.LM_RELEASE_VERSION}）"
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
 * Smoke_Test（Req 20.5）：Build_Image 容器內經 LAN 對 Production 代理執行 `ci/smoke.mjs`（不註冊帳號；每步另有逾時，整體 90 秒）。
 * Production 合成帳號 smoke-bot 的密碼只以 Jenkins file credential 的路徑（LM_SMOKE_PASSWORD_FILE）提供。逾時或中止回傳 124。
 */
int runProductionSmoke(String outName) {
  if (!(outName ==~ /^smoke-[a-z-]+\.json$/)) { error('內部錯誤：Smoke_Test 輸出檔名無效') }
  int rc = 124
  String failure = null
  try {
    timeout(time: 90, unit: 'SECONDS') {
      withCredentials([file(credentialsId: env.LM_PROD_SMOKE_CREDENTIALS, variable: 'LM_SMOKE_PASSWORD_FILE')]) {
        buildImageContainer("--mount type=bind,src=${env.LM_SCAN_CA_BUNDLE},dst=/etc/lm/lan-ca.crt,readonly") {
          withEnv([
            "LM_SMOKE_BASE_URL=${env.LM_PROD_URL}",
            'LM_SMOKE_USERNAME=smoke-bot',
            'NODE_EXTRA_CA_CERTS=/etc/lm/lan-ca.crt',
            "LM_PRD_SMOKE_OUT=reports/production/${outName}",
          ]) {
            rc = sh(label: 'Smoke_Test（Production）', returnStatus: true, script: '''
              set +x
              set -u
              rm -f "$LM_PRD_SMOKE_OUT"
              bun ci/smoke.mjs > "$LM_PRD_SMOKE_OUT"
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

/**
 * 以 SSH 受限金鑰執行 `lm-deploy prod deploy <digest> --app-env-stdin`；回傳 SSH 結束碼（即 lm-deploy 結束碼，連線失敗為 255）。
 * app.env 的來源為 Secret file lm-prod-supabase-env，交給 lm-deploy 的方式與 Staging 相同（只以 `<` 重新導向成為 stdin）。
 */
int productionDeployCommand() {
  int rc
  withCredentials([sshUserPrivateKey(credentialsId: env.LM_SSH_PROD_CREDENTIALS, keyFileVariable: 'LM_SSH_KEY', usernameVariable: 'LM_SSH_USER')]) {
    withCredentials([file(credentialsId: env.LM_KNOWN_HOSTS_CREDENTIALS, variable: 'LM_KNOWN_HOSTS')]) {
      withCredentials([file(credentialsId: env.LM_PROD_STACK_ENV_CREDENTIALS, variable: 'LM_STACK_ENV_FILE')]) {
        rc = sh(label: 'lm-deploy prod deploy', returnStatus: true, script: productionSshPrelude() + '''
          rm -f reports/production/deploy.jsonl
          if [ ! -s "$LM_STACK_ENV_FILE" ]; then
            echo 'lm-prod-supabase-env 的檔案不存在或為空，未連線 Deploy_Host' >&2
            exit 2
          fi
          lm_ssh deploy "$LM_IMAGE_DIGEST" --app-env-stdin < "$LM_STACK_ENV_FILE" > reports/production/deploy.jsonl
        ''')
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
        set -- --dir reports/production --commit "$GIT_COMMIT_FULL" --digest "${LM_IMAGE_DIGEST:-}" --tag "${LM_RELEASE_VERSION:-}" \
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
 * 以唯讀的 Registry 拉取帳號拉取映像（皆位於 Build_Image 所在的 Registry，且以 digest 引用）；
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
            *) echo "映像不在 Build_Image 的 Registry 或未以 digest 固定" >&2; exit 1 ;;
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

/** 觸發被拒絕時（例如 Tag 事件）仍需建立 Build_Record，觸發類型依 Multibranch 環境變數推定（Tag 事件不是 Trusted）。 */
String fallbackTriggerKind() {
  if (env.CHANGE_ID) { return 'pull_request' }
  if (env.BRANCH_NAME == 'main' && !env.TAG_NAME) { return 'main_push' }
  return 'branch_push'
}

/** Trusted_Ref 只能在 release/ 資料夾建置，Untrusted 建置不得在 release/ 執行（Req 2.4、2.8）。 */
void assertJobFolder(boolean trusted) {
  boolean inRelease = (env.JOB_NAME ?: '').startsWith('release/')
  if (trusted && !inRelease) {
    error('Trusted_Ref 建置只能在 release/ 資料夾的 Job 執行')
  }
  if (!trusted && inRelease) {
    error('release/ 資料夾只建置 main')
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
 * kind：password（usernamePassword 的密碼）、secret（string）、file（file 的內容）、ssh（sshUserPrivateKey 的私鑰）、
 * envfile（KEY=VALUE 的 Secret file：lm-*-supabase-env，每行的 VALUE 各為一個秘密；plan.md D13）。
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
    [id: env.LM_STAGING_STACK_ENV_CREDENTIALS, kind: 'envfile', trusted: true, stages: ['Staging Deploy']],
    [id: env.LM_STAGING_SMOKE_CREDENTIALS, kind: 'file', trusted: true, stages: ['Staging Deploy']],
    [id: env.LM_SSH_PROD_CREDENTIALS, kind: 'ssh', trusted: true, stages: ['Production Deploy']],
    [id: env.LM_PROD_STACK_ENV_CREDENTIALS, kind: 'envfile', trusted: true, stages: ['Production Deploy']],
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
 * 值只經 shell 內建 printf 或 cat 寫入（不出現在任何程序的命令列、Groovy 變數或主控台）。envfile 寫成 cred-<ID>.env，
 * ci/scrub.mjs 依副檔名把每行的 VALUE 各列為一個秘密（不是整份檔案）。需在 Agent 上執行。
 */
void stageScrubSecret(Map s) {
  String id = s.id ? s.id.toString() : ''
  if (!(id ==~ /^[a-z0-9][a-z0-9-]{0,63}$/)) { error('遮罩用的憑證 ID 無效') }
  String name = s.kind == 'envfile' ? "cred-${id}.env".toString() : "cred-${id}".toString()
  withEnv(["LM_SCRUB_NAME=${name}"]) {
    if (s.kind == 'secret') {
      withCredentials([string(credentialsId: id, variable: 'LM_SCRUB_VALUE')]) { writeScrubValue() }
    } else if (s.kind == 'password') {
      withCredentials([usernamePassword(credentialsId: id, usernameVariable: 'LM_SCRUB_USER', passwordVariable: 'LM_SCRUB_VALUE')]) { writeScrubValue() }
    } else if (s.kind == 'file' || s.kind == 'envfile') {
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

/** 收尾遮罩後刪除秘密目錄；可重複呼叫。需在 Agent 上執行。 */
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
      // image-digest.txt 已於 Image Push 封存並 fingerprint（內容只有 digest），不重複封存。
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
 * Production 執行中的 Image_Digest 之建置保留（Req 21.6；Design「Jenkins 資料夾與 Job」）：main 建置通過觀察期後，以
 * ci/keep-log.mjs 經 Jenkins API 對本建置設定 keepLog=true（本建置即建置、部署並觀察該 digest 的建置）。API token 寫入
 * 0700 目錄的 0600 檔再交給 Build_Image 容器（不經 docker exec --env），結束時一律刪除。失敗只寫入建置摘要，不改變建置結果
 * （Production 已切換完成；需由 Jenkins 管理員手動保留）。需在 Agent 上呼叫。
 */
void keepProductionBuildLog() {
  if (env.LM_TRUSTED != 'true' || env.LM_TRIGGER_KIND != 'main_push' || env.LM_PRD_OBSERVED != 'true') { return }
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
    appendSummary('已保留（keepLog）本建置：其 Image_Digest 正在 Production 執行（Req 21.6）')
  } else {
    appendSummary("無法設定 keepLog（ci/keep-log.mjs 結束碼 ${rc}）：請 Jenkins 管理員手動保留本建置（Req 21.6）".toString())
  }
}

/**
 * 依 label `lm.ci.build=$BUILD_TAG` 移除本建置建立的所有容器（含匿名卷）、網路與卷（Req 2.6），並移除 Rust 工具鏈映像的
 * 本建置標籤。只依本建置的 label 與標籤篩選，不使用 prune，不影響其他建置；之後確認沒有殘留，否則失敗。需在 Agent 上執行。
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
      # Rust 工具鏈映像的本建置標籤（plan.md D3）：只移除標籤；BuildKit 的快取保留給下一次建置。cargo 快取卷沒有建置 label，不受影響。
      if [ -n "${LM_RUST_TOOLCHAIN_IMAGE:-}" ]; then
        docker image rm "$LM_RUST_TOOLCHAIN_IMAGE" > /dev/null 2>&1 || true
      fi
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
