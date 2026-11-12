// 日子拾光 · LITTLE MOMENTS — release/digest-lookup（Requirements 21.7、21.8；Design「Jenkins 拓撲」「Build_Record」）。
//
// 稽核者輸入一個 Image_Digest，本 Job 以 MD5(`<digest>\n`) 查詢 Jenkins fingerprint API（main 建置封存並
// fingerprint 的 `image-digest.txt`），下載 release/little-moments/ 底下對應建置的 Build_Record，
// 只顯示 image.digest 完全相符者的 Commit SHA、Release_Tag、核准人、核准時間與 Production 部署時間。
// 查無時明確回報「查無對應紀錄」，且不顯示任何其他 Image_Digest 的紀錄（Req 21.8）。
//
// 規則（與根目錄 Jenkinsfile 相同）：
//   * 唯一參數為 DIGEST；本 Job 只讀取 Jenkins API，不推送、不部署，也沒有任何略過 Release_Gate 的參數。
//   * 憑證只在需要的步驟內以 withCredentials 提供；本檔只出現憑證 ID。
//     `lm-jenkins-api-readonly`：Jenkins 帳號 + API token，僅具 Overall/Read、Job/Read、Run/Artifacts 讀取權限。
//   * 所有 sh 腳本使用單引號字串，只透過 shell 環境變數（加雙引號）取用 DIGEST 等外部值，不經 Groovy 插值。
//   * DIGEST 格式（^sha256:[0-9a-f]{64}$）先在 Groovy 檢查，ci/digest-lookup.mjs 再嚴格驗證一次。
//
// 注意：本檔無法在本機執行，語法與 plugin 步驟參數未經 Jenkins 實際驗證。

pipeline {
  agent { label 'lm-trusted' }

  options {
    timestamps()
    disableResume()
    disableConcurrentBuilds()
    timeout(time: 10, unit: 'MINUTES')
    buildDiscarder(logRotator(daysToKeepStr: '30'))
  }

  parameters {
    string(name: 'DIGEST', defaultValue: '', trim: true, description: 'Image_Digest，格式 sha256:<64 個小寫十六進位字元>')
  }

  environment {
    // Build_Image 只以 digest 引用（Req 3.1）。
    // digest 來源：infra/build-image Job 建置 commit 5e809e4 的輸出（建置描述與 reports/build-image-digest.txt）。
    // 更新方式：重新執行 infra/build-image，以新 digest 在同一個 commit 內取代根目錄 Jenkinsfile 與
    // ci/jenkins/pipelines/{rollback,restore-drill,digest-lookup}.Jenkinsfile 的 BUILD_IMAGE。
    // 格式不符時格式檢查會使建置失敗（fail closed），不會退回任何可變 tag。
    BUILD_IMAGE = 'registry.our-littlemoments.com:8443/little-moments/build-image@sha256:5d06fdee80abcbf8780a92d7cb33bf1d94d099b3d7917aa15125d6ececc2c72f'
    LM_REGISTRY_PULL_CREDENTIALS = 'lm-registry-pull'
    LM_JENKINS_API_CREDENTIALS = 'lm-jenkins-api-readonly'
    LM_LOOKUP_OUT = 'reports/digest-lookup.json'
  }

  stages {
    stage('Validate') {
      steps {
        script {
          String digest = params.DIGEST ?: ''
          if (!(digest ==~ /^sha256:[0-9a-f]{64}$/)) {
            // 不回顯輸入值，避免把任意字串寫入建置摘要。
            currentBuild.description = 'Image_Digest 格式無效'
            error('DIGEST 必須為 sha256:<64 個小寫十六進位字元>')
          }
          env.LM_DIGEST = digest
          buildImageDigest()
        }
      }
    }

    stage('Lookup') {
      steps {
        script {
          checkout scm
          pullBuildImage()
          int rc
          // API token 寫入本建置暫存目錄的 0600 檔案再交給容器讀取，不以環境變數傳入容器
          // （docker exec --env 可能讓值出現在 Agent 的程序參數中）；結束時一律刪除。
          String tokenDir = "${env.WORKSPACE_TMP}/jenkins-api"
          try {
            withCredentials([usernamePassword(
              credentialsId: env.LM_JENKINS_API_CREDENTIALS,
              usernameVariable: 'LM_JENKINS_API_USER_SRC',
              passwordVariable: 'LM_JENKINS_API_TOKEN_SRC'
            )]) {
              withEnv(["LM_TOKEN_DIR=${tokenDir}"]) {
                sh(label: 'stage API token', script: '''
                  set -eu
                  umask 077
                  rm -rf "$LM_TOKEN_DIR"
                  mkdir -m 700 "$LM_TOKEN_DIR"
                  printf '%s' "$LM_JENKINS_API_TOKEN_SRC" > "$LM_TOKEN_DIR/token"
                  printf '%s' "$LM_JENKINS_API_USER_SRC" > "$LM_TOKEN_DIR/user"
                ''')
              }
            }
            String apiUser = readFile("${tokenDir}/user").trim()
            docker.image(env.BUILD_IMAGE).inside {
              withEnv([
                "HOME=${env.WORKSPACE_TMP}/home",
                "LM_JENKINS_API_USER=${apiUser}",
                "LM_JENKINS_API_TOKEN_FILE=${tokenDir}/token",
              ]) {
                rc = sh(label: 'ci/digest-lookup.mjs', returnStatus: true, script: '''
                  set -eu
                  mkdir -p reports
                  rm -f "$LM_LOOKUP_OUT"
                  bun ci/digest-lookup.mjs --digest "$LM_DIGEST" --out "$LM_LOOKUP_OUT"
                ''')
              }
            }
          } finally {
            withEnv(["LM_TOKEN_DIR=${tokenDir}"]) {
              sh(label: 'remove API token', script: 'rm -rf "$LM_TOKEN_DIR"')
            }
          }

          if (rc == 0) {
            currentBuild.description = "${env.LM_DIGEST}：找到 Build_Record"
          } else if (rc == 1) {
            // 查無對應紀錄是有效的查詢結果（Req 21.8）：建置成功，摘要明確標示查無。
            currentBuild.description = "${env.LM_DIGEST}：查無對應紀錄"
          } else if (rc == 2) {
            currentBuild.description = '參數或設定錯誤'
            error('digest 查詢參數或設定錯誤（見主控台輸出）')
          } else {
            // 查詢失敗不等於查無：標記失敗，避免稽核者誤判（fail closed）。
            currentBuild.description = 'Jenkins 查詢失敗'
            error('Jenkins fingerprint／Build_Record 查詢失敗，結果未知（不視為查無）')
          }
        }
      }
    }
  }

  post {
    always {
      // 查詢結果只含 Build_Record 已驗證欄位，ci/digest-lookup.mjs 輸出前已確認不含 API token。
      archiveArtifacts(artifacts: 'reports/digest-lookup.json', allowEmptyArchive: true, fingerprint: false)
    }
    cleanup {
      cleanWs(deleteDirs: true, notFailBuild: true)
    }
  }
}

// ------------------------------------------------------------------ 輔助函式

/** 驗證 Build_Image 引用為 <registry>/<repo>@sha256:<64 hex>（Req 3.1）。 */
String buildImageDigest() {
  String ref = env.BUILD_IMAGE ?: ''
  if (!(ref ==~ /^[a-z0-9][a-z0-9.\-]*(:[0-9]+)?\/[a-z0-9][a-z0-9._\/\-]*@sha256:[0-9a-f]{64}$/)) {
    error('Build_Image 必須以 <registry>/<repo>@sha256:<64 hex> 引用；請以 infra/build-image 輸出的 digest 更新本檔的 BUILD_IMAGE')
  }
  return ref.substring(ref.indexOf('@') + 1)
}

/** 以唯讀的 Registry 拉取帳號取得 Build_Image；docker 登入資訊只存在本建置的暫存目錄並於結束時刪除。 */
void pullBuildImage() {
  withCredentials([usernamePassword(
    credentialsId: env.LM_REGISTRY_PULL_CREDENTIALS,
    usernameVariable: 'LM_REG_USER',
    passwordVariable: 'LM_REG_PASSWORD'
  )]) {
    sh(label: 'pull Build_Image', script: '''
      set -eu
      DOCKER_CONFIG="$WORKSPACE_TMP/docker-pull"
      export DOCKER_CONFIG
      rm -rf "$DOCKER_CONFIG"
      mkdir -p -m 700 "$DOCKER_CONFIG"
      trap 'rm -rf "$DOCKER_CONFIG"' EXIT
      registry="${BUILD_IMAGE%%/*}"
      printf '%s' "$LM_REG_PASSWORD" | docker login --username "$LM_REG_USER" --password-stdin "$registry" >/dev/null
      docker pull --quiet "$BUILD_IMAGE" >/dev/null
      docker logout "$registry" >/dev/null 2>&1 || true
    ''')
  }
}
