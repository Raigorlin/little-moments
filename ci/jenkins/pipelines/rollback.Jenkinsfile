// 日子拾光 · LITTLE MOMENTS — 手動回滾 Job `release/rollback`（Requirement 20.8–20.12；Design Components §12、§15）。
//
// 流程：
//   Init     checkout、Build_Image（只以 digest 引用）、觸發者必須是 Release_Approver（ci/approval.mjs，Req 20.10）
//   Status   經 SSH 執行 `lm-deploy prod status`，以 ci/rollback.mjs 取出可回滾目標（保留集合內且不是目前版本）
//   Select   `input`：choice 參數 `digest`（選項即上一步的可回滾目標）與 string 參數 `reason`；
//            submitter 限定 Release_Approver 清單，並要求送出者與觸發者為同一帳號；送出後以 ci/rollback.mjs check
//            驗證理由、digest 與 rollbackAllowed（Req 20.10）
//   Rollback lock(resource: 'lm-prod', skipIfLocked: true)：取不到鎖即以「已有部署進行中」失敗（Req 20.12）。
//            取得鎖後重新讀取狀態並再次檢查，接著 `lm-deploy prod rollback <digest>`（start → health --wait → switch，
//            不執行 Migration_Runner，Req 20.8、20.9）→ 切換後 `health <color> --wait`（120 秒內連續 3 次成功）
//            → `finalize`。切換後未健康時不再做任何自動切換，標記失敗與需人工介入（Req 20.11）。
//   post     ci/rollback.mjs record 寫入 Build_Record：觸發方式（manual）、觸發者帳號、來源與目標 digest、理由與完成時間
//            （Req 20.9），並封存 reports/。
//
// 為何 digest 選項以 `input` 提供，而不是建置參數：建置參數的選項必須在建置開始前決定，若要即時取自
// `lm-deploy prod status` 需要 Active Choices 一類的 plugin（在 controller 上執行任意 Groovy 並持有 SSH 憑證）。
// 這裡改為先在 Trusted Agent 上讀取狀態，再以標準 Pipeline: Input Step 的 choice 參數呈現，選項只可能是 Deploy_Host
// 目前回報的可回滾目標；送出後仍以 ci/rollback.mjs 對 retained／rollbackTargets 嚴格比對，取得鎖後再比對一次。
//
// 規則（與根目錄 Jenkinsfile 相同）：
//   * 憑證只在需要的步驟內以 withCredentials 提供；本檔只出現憑證 ID。
//   * 所有 sh 腳本皆為單引號字串，外部值（digest、帳號）只經 shell 環境變數（加雙引號）取用，不經 Groovy 插值。
//     回滾理由只經環境變數 LM_ROLLBACK_REASON 交給 ci/rollback.mjs，不出現在任何指令列，也不寫入建置描述（避免 HTML 注入）。
//   * SSH 一律 StrictHostKeyChecking=yes，known_hosts 來自 Credential_Store 的 secret file（不信任首次連線）。
//     Deploy_Host 的 authorized_keys 以 forced command 綁定 `sudo /opt/lm/bin/lm-deploy prod`，子命令經 SSH_ORIGINAL_COMMAND 傳入。
//
// 需要的 plugin：Pipeline、Pipeline: Input Step、Lockable Resources、Credentials Binding、SSH Credentials、
// Docker Pipeline、Timestamper。Lockable Resource `lm-prod` 必須與正式部署（根目錄 Jenkinsfile）使用同一名稱。
//
// 注意：本檔無法在本機執行，語法與 plugin 步驟參數未經 Jenkins 實際驗證。

import groovy.json.JsonSlurperClassic

pipeline {
  agent { label 'lm-trusted' }

  options {
    skipDefaultCheckout()
    timestamps()
    disableResume()
    buildDiscarder(logRotator(daysToKeepStr: '365'))
  }

  environment {
    // Build_Image 只以 digest 引用（Req 3.1）。digest 來源：infra/build-image Job 建置 commit a302149 的輸出。
    // 更新方式：重新執行 infra/build-image，以新 digest 在同一個 commit 內取代根目錄 Jenkinsfile 與
    // ci/jenkins/pipelines/{rollback,restore-drill,digest-lookup}.Jenkinsfile 的 BUILD_IMAGE；格式不符時 Init 失敗（fail closed）。
    BUILD_IMAGE = 'registry.our-littlemoments.com:8443/little-moments/build-image@sha256:7eb66eee2631f762d0804dc57b59f2b42b6fba740cfabed3317624918397c97e'
    // Deploy_Host 的 LAN 位址與 SSH 連接埠（非秘密；與根目錄 Jenkinsfile 相同）。known_hosts 憑證
    // （lm-deploy-known-hosts）須含 192.168.1.121 的主機金鑰（連接埠非 22 時為 `[host]:port` 形式）。
    LM_DEPLOY_HOST = '192.168.1.121'
    LM_DEPLOY_PORT = '22'
    LM_RECORD = 'reports/build-record.json'
    LM_RB_DIR = 'reports/rollback'
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
          env.LM_RB_OUTCOME = 'not_started'
          env.LM_RB_ATTEMPTED = 'false'
          env.LM_RB_MANUAL = 'false'
          env.LM_RB_FROM = ''
          env.LM_RB_APPROVER = ''
          env.LM_RB_APPROVED_AT = ''
          env.LM_ROLLBACK_DIGEST = ''
          env.LM_ROLLBACK_REASON = ''
          env.LM_RB_STARTED_AT = utcNow()
          env.LM_RB_TRIGGERED_BY = triggeringUser()

          if (!(env.JOB_NAME ?: '').startsWith('release/')) {
            env.LM_RB_OUTCOME = 'rejected'
            error('手動回滾只能在 release/ 資料夾的 Job 執行')
          }
          if (isReplay()) {
            env.LM_RB_OUTCOME = 'rejected'
            error('手動回滾不接受 Replay，請重新觸發建置')
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

          inBuildImage {
            sh(label: 'reports', script: 'mkdir -p "$LM_RB_DIR"')
            // 觸發者必須是 Release_Approver（isReleaseApprover，Req 20.10）；非使用者觸發時帳號為空，同樣拒絕。
            int rc = sh(
              label: 'ci/approval.mjs release',
              returnStatus: true,
              script: 'bun ci/approval.mjs release --approver "$LM_RB_TRIGGERED_BY" > "$LM_RB_DIR/trigger.json" 2>&1'
            )
            if (rc != 0) {
              env.LM_RB_OUTCOME = 'rejected'
              error('觸發者不是 Release_Approver，拒絕回滾；Production 目前版本與 reverse proxy 設定未變更')
            }
            int arc = sh(
              label: 'ci/rollback.mjs approvers',
              returnStatus: true,
              script: 'bun ci/rollback.mjs approvers > "$LM_RB_DIR/approvers.json"'
            )
            if (arc != 0) {
              error('Release_Approver 清單無效')
            }
          }
          Map approvers = readJsonFile(env.LM_RB_DIR + '/approvers.json')
          List ids = approvers.approvers instanceof List ? (List) approvers.approvers : []
          if (ids.isEmpty()) {
            error('Release_Approver 清單為空')
          }
          env.LM_RB_SUBMITTERS = ids.join(',')
        }
      }
    }

    stage('Status') {
      steps {
        script {
          enterStage('Status')
          Map t = fetchTargets('status-before.json')
          env.LM_RB_FROM = t.active instanceof Map ? (t.active.digest ?: '').toString() : ''
          // digest 已由 ci/rollback.mjs 驗證為 sha256:<64 hex>，不含逗號。
          env.LM_RB_CHOICES = ((List) t.targets).join(',')
        }
      }
    }

    stage('Select') {
      steps {
        script {
          enterStage('Select')
          def r
          try {
            timeout(time: 30, unit: 'MINUTES') {
              r = input(
                id: 'RollbackTarget',
                message: '選擇 Production 回滾目標。回滾不執行 Migration_Runner，Database Schema 與遷移版本紀錄保持不變。',
                ok: '回滾',
                submitter: env.LM_RB_SUBMITTERS,
                submitterParameter: 'approver',
                parameters: [
                  choice(
                    name: 'digest',
                    choices: env.LM_RB_CHOICES.tokenize(',').join('\n'),
                    description: 'Deploy_Host 保留且不是目前版本的 Image_Digest（目前版本：' + (env.LM_RB_FROM ?: '無') + '）'
                  ),
                  string(
                    name: 'reason',
                    defaultValue: '',
                    trim: true,
                    description: '回滾理由（必填，最多 500 字元，不得包含換行或控制字元）'
                  ),
                ]
              )
            }
          } catch (err) {
            // 逾時或按下中止：Production 未變更。
            env.LM_RB_OUTCOME = 'aborted'
            throw err
          }
          env.LM_RB_APPROVER = (r instanceof Map && r.approver != null) ? r.approver.toString() : ''
          env.LM_ROLLBACK_DIGEST = (r instanceof Map && r.digest != null) ? r.digest.toString() : ''
          env.LM_ROLLBACK_REASON = (r instanceof Map && r.reason != null) ? r.reason.toString() : ''
          env.LM_RB_APPROVED_AT = utcNow()
          checkRollback('status-before.json')
        }
      }
    }

    stage('Rollback') {
      steps {
        script {
          enterStage('Rollback')
          boolean acquired = false
          lock(resource: 'lm-prod', skipIfLocked: true) {
            acquired = true
            performRollback()
          }
          if (!acquired) {
            env.LM_RB_OUTCOME = 'locked'
            error('已有部署進行中（lm-prod 已被鎖定），拒絕回滾；Production 目前版本與 reverse proxy 設定未變更')
          }
        }
      }
    }
  }

  post {
    always {
      script {
        writeRollbackRecord()
        archiveArtifacts(artifacts: 'reports/**', allowEmptyArchive: true)
        setSummary()
      }
    }
  }
}

// ------------------------------------------------------------------ 回滾步驟

/** 取得 lm-prod 鎖後執行：重新檢查 → rollback（不遷移）→ 切換後健康檢查 → finalize。 */
void performRollback() {
  // input 等待期間狀態可能改變（例如另一次部署已完成），持有鎖後重新讀取並再次檢查。
  if (deployHost('status', 'status-locked.json') != 0) {
    error('無法取得 Production 狀態')
  }
  Map decision = checkRollback('status-locked.json')
  env.LM_RB_FROM = decision.from ? decision.from.toString() : ''

  env.LM_RB_ATTEMPTED = 'true'
  int rc = deployHost('rollback', 'rollback.jsonl')
  Map c = classify('classify', rc, 'rollback.jsonl')
  if (c.outcome != 'switched') {
    env.LM_RB_OUTCOME = (c.outcome ?: 'manual_intervention').toString()
    env.LM_RB_MANUAL = c.manualIntervention == true ? 'true' : 'false'
    error('回滾未完成：' + (c.message ?: '結果不明'))
  }
  if (!((c.color ?: '') ==~ /^(blue|green)$/)) {
    env.LM_RB_OUTCOME = 'manual_intervention'
    env.LM_RB_MANUAL = 'true'
    error('回滾輸出缺少槽位資訊，需人工介入')
  }
  env.LM_RB_COLOR = c.color.toString()

  // Req 20.11：切換完成後 120 秒內須連續 3 次 Health_Check 成功；否則停止任何自動切換並標記需人工介入。
  int hrc = deployHost('health', 'health-after.jsonl')
  Map h = classify('health', hrc, 'health-after.jsonl')
  if (h.healthy != true) {
    env.LM_RB_OUTCOME = 'manual_intervention'
    env.LM_RB_MANUAL = 'true'
    error('回滾切換後 120 秒內未連續 3 次 Health_Check 成功；已停止自動切換、維持目前容器與 reverse proxy 狀態，需人工介入')
  }

  // 停止舊槽位並將目標記錄為目前版本，使下一次部署可從 idle 開始。
  if (deployHost('finalize', 'finalize.jsonl') != 0) {
    env.LM_RB_OUTCOME = 'manual_intervention'
    env.LM_RB_MANUAL = 'true'
    error('流量已切換至目標 digest 且健康，但 finalize 失敗，需人工介入')
  }
  deployHost('status', 'status-after.json')
  env.LM_RB_OUTCOME = 'completed'
}

/** 讀取 `lm-deploy prod status` 並取出可回滾目標；沒有目標時拒絕。 */
Map fetchTargets(String statusFile) {
  if (deployHost('status', statusFile) != 0) {
    error('無法取得 Production 狀態')
  }
  int rc
  withEnv(['LM_RB_STATUS=' + env.LM_RB_DIR + '/' + statusFile]) {
    inBuildImage {
      rc = sh(
        label: 'ci/rollback.mjs targets',
        returnStatus: true,
        script: 'bun ci/rollback.mjs targets --status "$LM_RB_STATUS" > "$LM_RB_STATUS.targets" 2>&1'
      )
    }
  }
  if (rc == 1) {
    env.LM_RB_OUTCOME = 'rejected'
    error('Deploy_Host 沒有可回滾的 Image_Digest')
  }
  if (rc != 0) {
    error('lm-deploy status 輸出無效')
  }
  Map t = readJsonFile(env.LM_RB_DIR + '/' + statusFile + '.targets')
  if (!(t.targets instanceof List) || t.targets.isEmpty()) {
    error('lm-deploy status 輸出無效')
  }
  return t
}

/** isReleaseApprover + 理由 + rollbackAllowed 檢查（ci/rollback.mjs check）；未通過即拒絕，不變更 Production。 */
Map checkRollback(String statusFile) {
  int rc
  withEnv(['LM_RB_STATUS=' + env.LM_RB_DIR + '/' + statusFile]) {
    inBuildImage {
      rc = sh(
        label: 'ci/rollback.mjs check',
        returnStatus: true,
        script: '''
          bun ci/rollback.mjs check --status "$LM_RB_STATUS" --digest "$LM_ROLLBACK_DIGEST" \
            --triggered-by "$LM_RB_TRIGGERED_BY" --approver "$LM_RB_APPROVER" > "$LM_RB_STATUS.check" 2>&1
        '''
      )
    }
  }
  Map d = readJsonFile(env.LM_RB_DIR + '/' + statusFile + '.check')
  if (rc != 0 || d.allowed != true) {
    env.LM_RB_OUTCOME = d.code == 'deploy_in_progress' ? 'locked' : 'rejected'
    // reason 為 ci/rollback.mjs／ci/approval.mjs 內的固定訊息，不含使用者輸入。
    error('拒絕回滾：' + (d.reason ?: '檢查未通過') + '；Production 目前版本與 reverse proxy 設定未變更')
  }
  return d
}

/** 以 ci/rollback.mjs classify|health 判讀 lm-deploy 的結束碼與輸出。 */
Map classify(String kind, int exitCode, String resultFile) {
  if (!(kind in ['classify', 'health'])) {
    error('內部錯誤：未知的判讀類型')
  }
  withEnv([
    'LM_RB_KIND=' + kind,
    'LM_RB_EXIT=' + exitCode,
    'LM_RB_RESULT=' + env.LM_RB_DIR + '/' + resultFile,
  ]) {
    inBuildImage {
      sh(
        label: 'ci/rollback.mjs ' + kind,
        returnStatus: true,
        script: '''
          if [ "$LM_RB_KIND" = classify ]; then
            bun ci/rollback.mjs classify --exit "$LM_RB_EXIT" --result "$LM_RB_RESULT" --digest "$LM_ROLLBACK_DIGEST" > "$LM_RB_RESULT.verdict" 2>&1
          else
            bun ci/rollback.mjs health --exit "$LM_RB_EXIT" --result "$LM_RB_RESULT" > "$LM_RB_RESULT.verdict" 2>&1
          fi
        '''
      )
    }
  }
  return readJsonFile(env.LM_RB_DIR + '/' + resultFile + '.verdict')
}

/** 寫入 Build_Record（Req 20.9）；失敗時將建置標記為失敗。 */
void writeRollbackRecord() {
  String current = currentBuild.currentResult ?: 'FAILURE'
  String status = current == 'SUCCESS' ? 'SUCCESS' : (current == 'ABORTED' ? 'ABORTED' : 'FAILURE')
  if (status == 'SUCCESS' && env.LM_RB_OUTCOME != 'completed') {
    status = 'FAILURE'
  }
  if (status == 'ABORTED' && (env.LM_RB_OUTCOME ?: 'not_started') == 'not_started') {
    env.LM_RB_OUTCOME = 'aborted'
  }
  env.LM_RB_RESULT_STATUS = status
  env.LM_RB_FAILED_STAGE = status == 'SUCCESS' ? '' : (env.LM_CURRENT_STAGE ?: '')
  String failure = null
  try {
    inBuildImage {
      sh(label: 'Build_Record', script: '''
        bun ci/rollback.mjs record --out "$LM_RECORD" \
          --job "$JOB_NAME" --number "$BUILD_NUMBER" --url "$BUILD_URL" --started-at "$LM_RB_STARTED_AT" \
          --commit "${GIT_COMMIT_FULL:-}" --build-image-digest "${BUILD_IMAGE_DIGEST:-}" \
          --by "$LM_RB_TRIGGERED_BY" --approver "$LM_RB_APPROVER" --approved-at "$LM_RB_APPROVED_AT" \
          --from "$LM_RB_FROM" --to "$LM_ROLLBACK_DIGEST" \
          --outcome "$LM_RB_OUTCOME" --attempted "$LM_RB_ATTEMPTED" --manual-intervention "$LM_RB_MANUAL" \
          --status "$LM_RB_RESULT_STATUS" --first-failed-stage "$LM_RB_FAILED_STAGE"
      ''')
    }
  } catch (err) {
    failure = err.getClass().getName()
    currentBuild.result = 'FAILURE'
  }
  if (failure != null) {
    echo('writeRollbackRecord: ' + failure)
    echo 'Build_Record 寫入失敗'
  }
}

/** 建置摘要：只含結果、帳號與 digest（皆經格式檢查），不含回滾理由。 */
void setSummary() {
  Map labels = [
    not_started: '未執行', rejected: '已拒絕', locked: '已有部署進行中', aborted: '已中止',
    failed: '未切換（Production 未變更）', manual_intervention: '失敗，需人工介入', completed: '完成',
  ]
  String outcome = env.LM_RB_OUTCOME ?: 'not_started'
  List parts = ['手動回滾：' + (labels[outcome] ?: '未知')]
  String by = env.LM_RB_TRIGGERED_BY ?: ''
  if (by ==~ /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/) {
    parts << '觸發者 ' + by
  }
  parts << '來源 ' + shortDigest(env.LM_RB_FROM) + ' → 目標 ' + shortDigest(env.LM_ROLLBACK_DIGEST)
  if (env.LM_RB_MANUAL == 'true') {
    parts << '需人工介入'
  }
  currentBuild.description = parts.join(' · ')
}

// ------------------------------------------------------------------ 輔助函式

void enterStage(String name) {
  env.LM_CURRENT_STAGE = name
}

String shortDigest(String d) {
  return (d ?: '') ==~ /^sha256:[0-9a-f]{64}$/ ? d.substring(0, 19) : '無'
}

String utcNow() {
  return sh(label: 'date', returnStdout: true, script: 'date -u +%Y-%m-%dT%H:%M:%S+00:00').trim()
}

/** 建置觸發者的 Jenkins 帳號（UserIdCause）；非使用者觸發時為空字串。 */
String triggeringUser() {
  def causes = currentBuild.getBuildCauses('hudson.model.Cause$UserIdCause')
  if (causes == null || causes.isEmpty()) {
    return ''
  }
  def id = causes[0]?.userId
  return id ? id.toString() : ''
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

/** 讀取 JSON 檔（最後一行）；讀取或解析失敗回傳空 Map。失敗時只輸出例外類別（Components 第 23.3 節）。 */
Map readJsonFile(String path) {
  String failure = null
  Object parsed = null
  try {
    String text = readFile(path)
    String line = lastNonEmptyLine(text)
    if (line == null) {
      return [:]
    }
    parsed = parseJsonText(line)
  } catch (Exception e) {
    failure = e.getClass().getName()
  }
  if (failure != null) {
    echo('readJsonFile: ' + failure)
    return [:]
  }
  if (!(parsed instanceof Map)) {
    echo('readJsonFile: 不是 JSON 物件（' + (parsed == null ? 'null' : parsed.getClass().getName()) + '）')
    return [:]
  }
  return (Map) parsed
}

/** 最後一個非空行；沒有時回傳 null。 */
@NonCPS
String lastNonEmptyLine(String text) {
  List lines = text.tokenize('\n').findAll { it.trim() }
  return lines.isEmpty() ? null : lines[-1]
}

/** 唯一建立 JsonSlurperClassic 的地方（Components 第 23 節）。回傳 Map／List／String／Number／Boolean／null（皆可序列化）；
 *  null、空字串或無效 JSON 時丟出例外，由呼叫端處理。 */
@NonCPS
Object parseJsonText(String text) {
  return new JsonSlurperClassic().parseText(text)
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
 * 在 Deploy_Host 執行 `lm-deploy prod <子命令>`（forced command 綁定 prod）；stdout（每行一個 JSON）寫入 reports/rollback/<outName>。
 * 子命令只有固定的四種；digest 與槽位只經環境變數傳入。回傳 SSH 結束碼（即 lm-deploy 結束碼，連線失敗為 255）。
 */
int deployHost(String action, String outName) {
  Map commands = [
    status  : 'lm_ssh status > "$LM_RB_OUT"\n',
    rollback: 'lm_ssh rollback "$LM_ROLLBACK_DIGEST" > "$LM_RB_OUT"\n',
    health  : 'lm_ssh health "$LM_RB_COLOR" --wait > "$LM_RB_OUT"\n',
    finalize: 'lm_ssh finalize > "$LM_RB_OUT"\n',
  ]
  String command = commands[action]
  if (!command) {
    error('內部錯誤：未知的 lm-deploy 子命令')
  }
  int rc
  withEnv(['LM_RB_OUT=' + env.LM_RB_DIR + '/' + outName]) {
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
