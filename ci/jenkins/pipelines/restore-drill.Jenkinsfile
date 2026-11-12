// 日子拾光 · LITTLE MOMENTS — 還原演練 Job `release/restore-drill`（Requirement 14.6、14.7、21.10；Design Components §13）。
//
// 排程：cron `H 3 1,15 * *`（每月 1 日與 15 日，兩次演練間隔最多 16 日，滿足「最多 30 日」）；亦可手動觸發。
//
// 流程：
//   Init   checkout、Build_Image（只以 digest 引用，格式不符時失敗）、Deploy_Host 名稱格式檢查
//   Drill  經 SSH 執行 `lm-deploy prod drill`（forced command 綁定 prod，子命令經 SSH_ORIGINAL_COMMAND 傳入）：
//          Deploy_Host 取最新已驗證的 Production 備份並重算 sha256 → 在獨立 Compose 專案 lm-drill-prod-<8 hex>
//          （只有 internal 網路與匿名卷，不連接 Production 的網路或資料卷）pg_restore → Migration_Runner 補齊遷移
//          → 以目前 Production 作用中 digest 啟動 App → 插入臨時合成管理員與 smoke-fixture → Smoke_Test → `down -v`。
//          以 ci/restore-drill.mjs classify 判讀結束碼與輸出；未通過即將建置標記為失敗（Req 14.7）。
//   post   ci/restore-drill.mjs record 寫入 Build_Record：備份識別碼、還原耗時（秒）、Smoke_Test 結果、失敗步驟
//          （Req 14.6、14.7），並封存 reports/。
//
// 備份保留（Req 14.7）：本 Job 只呼叫 `lm-deploy prod drill`，從不呼叫 backup／prune；lm-deploy drill 只讀取備份，
// 任何失敗都不刪除或修剪既有備份。Build_Record 記錄演練後 Deploy_Host 上的已驗證備份數。
//
// 規則（與 rollback.Jenkinsfile 相同）：
//   * 憑證只在需要的步驟內以 withCredentials 提供；本檔只出現憑證 ID。
//   * 所有 sh 腳本皆為單引號字串，外部值只經 shell 環境變數（加雙引號）取用，不經 Groovy 插值。
//   * SSH 一律 StrictHostKeyChecking=yes，known_hosts 來自 Credential_Store 的 secret file（不信任首次連線）。
//   * Smoke_Test 只在 Deploy_Host 的 drill internal 網路內執行；合成管理員的帳號與密碼由 Deploy_Host 每次隨機產生，
//     不經過 Jenkins，也不出現在任何輸出。輸出只含步驟名稱、狀態碼與耗時（Req 21.10）。
//
// 需要的 plugin：Pipeline、Credentials Binding、SSH Credentials、Docker Pipeline、Timestamper。
//
// 注意：本檔無法在本機執行，語法與 plugin 步驟參數未經 Jenkins 實際驗證。

import groovy.json.JsonSlurperClassic

pipeline {
  agent { label 'lm-trusted' }

  triggers {
    cron('H 3 1,15 * *')
  }

  options {
    skipDefaultCheckout()
    timestamps()
    disableResume()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(daysToKeepStr: '365'))
  }

  environment {
    // Build_Image 只以 digest 引用（Req 3.1）。digest 來源：infra/build-image Job 建置 commit 5e809e4 的輸出。
    // 更新方式：重新執行 infra/build-image，以新 digest 在同一個 commit 內取代根目錄 Jenkinsfile 與
    // ci/jenkins/pipelines/{rollback,restore-drill,digest-lookup}.Jenkinsfile 的 BUILD_IMAGE；格式不符時 Init 失敗（fail closed）。
    BUILD_IMAGE = 'registry.our-littlemoments.com:8443/little-moments/build-image@sha256:5d06fdee80abcbf8780a92d7cb33bf1d94d099b3d7917aa15125d6ececc2c72f'
    // PLACEHOLDER：Deploy_Host 的 LAN 主機名稱與 SSH 連接埠（非秘密）；known_hosts 憑證須含對應的主機金鑰。
    LM_DEPLOY_HOST = 'deploy-host.lan.example'
    LM_DEPLOY_PORT = '22'
    LM_RECORD = 'reports/build-record.json'
    LM_DRILL_DIR = 'reports/drill'
    // 憑證 ID（值只存在 release/ 資料夾範圍的 Credential_Store）。
    LM_REGISTRY_PULL_CREDENTIALS = 'lm-registry-pull'
    LM_SSH_PROD_CREDENTIALS = 'lm-ssh-prod'
    LM_KNOWN_HOSTS_CREDENTIALS = 'lm-deploy-known-hosts'
  }

  stages {
    stage('Init') {
      steps {
        script {
          enterStage('Init')
          env.LM_DRILL_RESULT_FILE = ''
          env.LM_DRILL_EXIT = ''
          env.LM_DRILL_PASSED = 'false'
          env.LM_DRILL_BACKUP_ID = ''
          env.LM_DRILL_FAILED_STEP = ''
          env.LM_DRILL_RESTORE_SECONDS = ''
          env.LM_DRILL_SMOKE = 'not_run'
          env.LM_DRILL_STARTED_AT = utcNow()
          String user = triggeringUser()
          env.LM_DRILL_BY = user ?: 'timer'

          if (!(env.JOB_NAME ?: '').startsWith('release/')) {
            error('還原演練只能在 release/ 資料夾的 Job 執行')
          }
          if (isReplay()) {
            error('還原演練不接受 Replay，請重新觸發建置')
          }
          assertDeployTarget()

          checkout scm
          String sha = sh(label: 'git rev-parse HEAD', returnStdout: true, script: 'git rev-parse HEAD').trim()
          if (!(sha ==~ /^[0-9a-f]{40}$/)) {
            error('無法取得 40 字元 Commit SHA')
          }
          env.GIT_COMMIT_FULL = sha

          env.BUILD_IMAGE_DIGEST = buildImageDigest()
          pullBuildImage()
          sh(label: 'reports', script: 'mkdir -p "$LM_DRILL_DIR"')
        }
      }
    }

    stage('Drill') {
      steps {
        script {
          enterStage('Drill')
          int rc
          // 還原（60 分鐘）+ 啟動 + Smoke_Test（15 分鐘）+ 清理的上限由 Deploy_Host 控制；此為外層保護。
          timeout(time: 120, unit: 'MINUTES') {
            rc = deployHost('drill', 'drill.jsonl')
          }
          env.LM_DRILL_RESULT_FILE = env.LM_DRILL_DIR + '/drill.jsonl'
          env.LM_DRILL_EXIT = rc.toString()
          Map v = classifyDrill()
          env.LM_DRILL_PASSED = v.passed == true ? 'true' : 'false'
          env.LM_DRILL_BACKUP_ID = (v.backupId ?: '').toString()
          env.LM_DRILL_FAILED_STEP = (v.failedStep ?: '').toString()
          env.LM_DRILL_RESTORE_SECONDS = v.restoreSeconds != null ? v.restoreSeconds.toString() : ''
          env.LM_DRILL_SMOKE = (v.smokeResult ?: 'not_run').toString()
          if (v.passed != true) {
            // 步驟名稱與代碼皆已由 ci/restore-drill.mjs 驗證為固定格式。
            error('還原演練未通過（步驟 ' + (env.LM_DRILL_FAILED_STEP ?: '不明') + '，代碼 ' + safeCode(v.code) + '）；所有既有備份均已保留')
          }
        }
      }
    }
  }

  post {
    always {
      script {
        writeDrillRecord()
        archiveArtifacts(artifacts: 'reports/**', allowEmptyArchive: true)
        setSummary()
      }
    }
  }
}

// ------------------------------------------------------------------ 演練步驟

/** 以 ci/restore-drill.mjs classify 判讀 lm-deploy drill 的結束碼與輸出。 */
Map classifyDrill() {
  inBuildImage {
    sh(
      label: 'ci/restore-drill.mjs classify',
      returnStatus: true,
      script: 'bun ci/restore-drill.mjs classify --exit "$LM_DRILL_EXIT" --result "$LM_DRILL_RESULT_FILE" > "$LM_DRILL_RESULT_FILE.verdict" 2>&1'
    )
  }
  return readJsonFile(env.LM_DRILL_DIR + '/drill.jsonl.verdict')
}

/** 寫入 Build_Record（Req 14.6、14.7）；寫入失敗時將建置標記為失敗。 */
void writeDrillRecord() {
  String current = currentBuild.currentResult ?: 'FAILURE'
  String status = current == 'SUCCESS' ? 'SUCCESS' : (current == 'ABORTED' ? 'ABORTED' : 'FAILURE')
  if (status == 'SUCCESS' && env.LM_DRILL_PASSED != 'true') {
    status = 'FAILURE'
  }
  env.LM_DRILL_RESULT_STATUS = status
  env.LM_DRILL_FAILED_STAGE = status == 'SUCCESS' ? '' : (env.LM_CURRENT_STAGE ?: '')
  try {
    inBuildImage {
      sh(label: 'Build_Record', script: '''
        bun ci/restore-drill.mjs record --out "$LM_RECORD" \
          --job "$JOB_NAME" --number "$BUILD_NUMBER" --url "$BUILD_URL" --started-at "$LM_DRILL_STARTED_AT" \
          --commit "${GIT_COMMIT_FULL:-}" --build-image-digest "${BUILD_IMAGE_DIGEST:-}" --by "$LM_DRILL_BY" \
          --result "$LM_DRILL_RESULT_FILE" --exit "$LM_DRILL_EXIT" \
          --status "$LM_DRILL_RESULT_STATUS" --first-failed-stage "$LM_DRILL_FAILED_STAGE"
      ''')
    }
  } catch (err) {
    echo 'Build_Record 寫入失敗'
    currentBuild.result = 'FAILURE'
  }
  if (status != 'SUCCESS' && current == 'SUCCESS') {
    currentBuild.result = 'FAILURE'
  }
}

/** 建置摘要：只含結果、備份識別碼、還原秒數與 Smoke_Test 結果（皆經格式檢查）。 */
void setSummary() {
  List parts = ['還原演練：' + (env.LM_DRILL_PASSED == 'true' ? '通過' : '未通過')]
  String id = env.LM_DRILL_BACKUP_ID ?: ''
  parts << '備份 ' + ((id ==~ /^prod-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/) ? id : '無')
  String secs = env.LM_DRILL_RESTORE_SECONDS ?: ''
  if (secs ==~ /^[0-9]{1,7}(\.[0-9]{1,3})?$/) {
    parts << '還原 ' + secs + ' 秒'
  }
  parts << 'Smoke_Test ' + ([pass: '通過', fail: '未通過', not_run: '未執行'][env.LM_DRILL_SMOKE] ?: '未執行')
  String step = env.LM_DRILL_FAILED_STEP ?: ''
  if (env.LM_DRILL_PASSED != 'true' && step ==~ /^[a-z][a-z_-]{0,31}$/) {
    parts << '失敗步驟 ' + step
  }
  currentBuild.description = parts.join(' · ')
}

// ------------------------------------------------------------------ 輔助函式

void enterStage(String name) {
  env.LM_CURRENT_STAGE = name
}

String safeCode(def code) {
  String c = code != null ? code.toString() : ''
  return c ==~ /^[a-z][a-z0-9_]{0,63}$/ ? c : 'unknown'
}

String utcNow() {
  return sh(label: 'date', returnStdout: true, script: 'date -u +%Y-%m-%dT%H:%M:%S+00:00').trim()
}

/** 建置觸發者的 Jenkins 帳號（UserIdCause）；排程觸發時為空字串。 */
String triggeringUser() {
  def causes = currentBuild.getBuildCauses('hudson.model.Cause$UserIdCause')
  if (causes == null || causes.isEmpty()) {
    return ''
  }
  def id = causes[0]?.userId
  String s = id ? id.toString() : ''
  return s ==~ /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/ ? s : ''
}

boolean isReplay() {
  return !currentBuild.getBuildCauses('org.jenkinsci.plugins.workflow.cps.replay.ReplayCause').isEmpty()
}

/** Deploy_Host 名稱與連接埠只接受固定格式（非秘密設定）。 */
void assertDeployTarget() {
  if (!((env.LM_DEPLOY_HOST ?: '') ==~ /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/)) {
    error('LM_DEPLOY_HOST 格式無效')
  }
  if (!((env.LM_DEPLOY_PORT ?: '') ==~ /^[1-9][0-9]{0,4}$/)) {
    error('LM_DEPLOY_PORT 格式無效')
  }
}

/** 讀取 JSON 檔（最後一行）；讀取或解析失敗回傳空 Map。 */
Map readJsonFile(String path) {
  try {
    List lines = readFile(path).tokenize('\n').findAll { it.trim() }
    if (lines.isEmpty()) {
      return [:]
    }
    def parsed = new JsonSlurperClassic().parseText(lines[-1])
    return parsed instanceof Map ? (Map) parsed : [:]
  } catch (Exception ignored) {
    return [:]
  }
}

/** SSH 用戶端函式：只使用 Credential_Store 的金鑰與 known_hosts，不讀取任何 ssh_config 或 agent。 */
String sshPrelude() {
  return '''
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

/**
 * 在 Deploy_Host 執行 `lm-deploy prod <子命令>`；stdout（每行一個 JSON）寫入 reports/drill/<outName>。
 * 本 Job 只允許 drill 一個子命令（不得呼叫 backup、prune 或任何會變更 Production 的子命令）。
 * 回傳 SSH 結束碼（即 lm-deploy 結束碼，連線失敗為 255）。
 */
int deployHost(String action, String outName) {
  Map commands = [
    drill: 'lm_ssh drill > "$LM_DRILL_OUT"\n',
  ]
  String command = commands[action]
  if (!command) {
    error('內部錯誤：未知的 lm-deploy 子命令')
  }
  int rc
  withEnv(['LM_DRILL_OUT=' + env.LM_DRILL_DIR + '/' + outName]) {
    withCredentials([
      sshUserPrivateKey(credentialsId: env.LM_SSH_PROD_CREDENTIALS, keyFileVariable: 'LM_SSH_KEY', usernameVariable: 'LM_SSH_USER'),
      file(credentialsId: env.LM_KNOWN_HOSTS_CREDENTIALS, variable: 'LM_KNOWN_HOSTS'),
    ]) {
      rc = sh(label: 'lm-deploy prod ' + action, returnStatus: true, script: sshPrelude() + command)
    }
  }
  return rc
}

/** 在 Build_Image 容器內執行；HOME 與 Bun 快取放在本建置的暫存目錄。 */
def inBuildImage(Closure body) {
  docker.image(env.BUILD_IMAGE).inside {
    withEnv(['HOME=' + env.WORKSPACE_TMP + '/home', 'BUN_INSTALL_CACHE_DIR=' + env.WORKSPACE_TMP + '/bun-cache', 'CI=1']) {
      body()
    }
  }
}

/** 驗證 Build_Image 引用為 <registry>/<repo>@sha256:<64 hex>，回傳 digest（Req 3.1）。 */
String buildImageDigest() {
  String ref = env.BUILD_IMAGE ?: ''
  if (!(ref ==~ /^[a-z0-9][a-z0-9.\-]*(:[0-9]+)?\/[a-z0-9][a-z0-9._\/\-]*@sha256:[0-9a-f]{64}$/)) {
    error('Build_Image 必須以 <registry>/<repo>@sha256:<64 hex> 引用；請以 infra/build-image 輸出的 digest 更新 BUILD_IMAGE')
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
