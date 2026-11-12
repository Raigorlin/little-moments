// 日子拾光 · LITTLE MOMENTS — Jenkins Job DSL（Requirement 1.1、1.9、2.3–2.8、15.1、15.7、15.8、19.3、21.3–21.5、21.12；
// Design「Jenkins Job 配置」「信任邊界」）。由 ci/jenkins/casc.yaml 的 `jobs:` 載入（Configuration as Code + Job DSL）。
//
// 拓撲：
//   ci/little-moments        Multibranch：PR（merge 與 head）與非 main 分支；PR 信任策略「Admin or Write」；保留 14 天
//   release/little-moments   Multibranch：僅 main 分支與 Release_Tag（Tag build strategy）；main 90 天、Tag 365 天
//   release/rollback         Pipeline：手動回滾（ci/jenkins/pipelines/rollback.Jenkinsfile）；365 天
//   release/restore-drill    Pipeline：還原演練，cron `H 3 1,15 * *`（ci/jenkins/pipelines/restore-drill.Jenkinsfile）；365 天
//   release/digest-lookup    Pipeline：以 Image_Digest 查詢 Build_Record（ci/jenkins/pipelines/digest-lookup.Jenkinsfile）；30 天
//   infra/build-image        Pipeline：建置 Build_Image（ci/jenkins/pipelines/build-image.Jenkinsfile）；90 天
//
// 憑證（Req 2.4、2.5、15.1）：全部定義在「資料夾範圍」，沒有任何 GLOBAL 範圍的系統憑證（casc.yaml 只有 SYSTEM 範圍的
// webhook secret，Job 無法讀取）。部署、簽章、Staging／Production Database、Setup_Token、smoke 帳號與 Jenkins API
// 憑證只存在 release/ 資料夾；ci/ 只有 GitHub App 與唯讀 Registry 拉取帳號，因此 PR 建置請求任何部署憑證時
// withCredentials 直接失敗（CredentialNotFoundException）。infra/ 只有建置 Build_Image 所需的 Registry 推送帳號與 GitHub App，
// 且非管理員沒有任何 infra/ 的 Job/Build 權限。
//
// 秘密值不在本檔：每個憑證的值於 seed 時自 controller 的秘密來源讀取
//   ${SECRETS:-/run/secrets}/little-moments/<資料夾>/<憑證 ID>[.<部分>]
// （與 Configuration as Code 預設的檔案秘密來源相同目錄；Docker／Kubernetes secret 掛載）。任何檔案缺少或為空時，
// 整個 Job DSL 以只列出「資料夾/檔名」的錯誤失敗（fail closed，不以預設值或空值建立憑證；Req 15.3）。
//
// 授權（Req 21.12）：非管理員沒有 Run/Delete、Run/Update、Job/Configure、Run/Replay。唯一的例外是
// lm-retention-bot（lm-jenkins-api-retention 憑證所屬的 Jenkins 帳號）在 release/little-moments 的 Run/Update，
// 只用於 ci/keep-log.mjs 設定 keepLog=true（Req 21.6）；它沒有 Run/Delete，因此無法刪除建置或解除保留。
//
// 注意：本檔無法在本機執行；Job DSL 動態 DSL 的方法名稱與參數已在實際的 Jenkins LTS controller 上載入本檔驗證。
// 升級 plugin 後請以「Manage Jenkins → Job DSL → API Viewer」（/plugin/job-dsl/api-viewer/index.html）重新對照。

import groovy.transform.Field

// ---------------------------------------------------------------- 設定（非秘密）

@Field final String GITHUB_OWNER = 'Raigorlin'
@Field final String GITHUB_REPO = 'little-moments'
@Field final String REPO_URL = "https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git".toString()
@Field final String MAIN_BRANCH = 'main'
// Release_Tag 的預篩（Req 1.5 的最終驗證在 Jenkinsfile 的 Tag Verify：ci/policy/tag.mjs）。
// 0 至 999999、無前導零（數值 0 除外）、不含任何前綴或後綴；同時把分支限定為 main。
@Field final String RELEASE_HEAD_REGEX = '^(main|v(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5}))$'

// Jenkins 群組與帳號（由 security realm 提供；名稱須與 casc.yaml 的 authorizationStrategy 相同）。
@Field final String GROUP_DEVELOPERS = 'lm-developers'
@Field final String GROUP_RELEASE_APPROVERS = 'lm-release-approvers'
@Field final String GROUP_AUDITORS = 'lm-auditors'
@Field final String USER_RETENTION_BOT = 'lm-retention-bot'

// 保留天數（Req 21.3–21.5；Design「Jenkins Job 配置」）。
@Field final String KEEP_PR_DAYS = '14'
@Field final String KEEP_MAIN_DAYS = '90'
@Field final String KEEP_TAG_DAYS = '365'
@Field final int KEEP_RELEASE_JOB_DAYS = 365
@Field final int KEEP_LOOKUP_DAYS = 30
@Field final int KEEP_INFRA_DAYS = 90

// ---------------------------------------------------------------- 資料夾範圍的憑證
//
// type：
//   usernamePassword  <id>.username、<id>.password
//   string            <id>
//   file              <id>（原始位元組；fileName 為綁定時的檔名）
//   sshKey            <id>.username、<id>.key（OpenSSH 私鑰）
//   gitHubApp         <id>.app-id、<id>.key（PKCS#8 私鑰）
// （type 是本檔的分類名稱，不是 DSL 方法名稱；對應的 Job DSL 方法見 folderCredentials。）
// 每個資料夾各自讀取自己的秘密目錄，因此 ci/ 的 lm-registry-pull 與 release/ 的同名憑證可以是不同的唯讀帳號，
// ci/ 的 lm-github-app 也可以是權限較小的另一個 GitHub App 安裝（只需 Contents: read、Commit statuses: write）。

@Field final Map<String, List<Map>> FOLDER_CREDENTIALS = [
  // BEGIN credentials ci
  'ci': [
    [id: 'lm-github-app', type: 'gitHubApp', description: 'GitHub App：checkout 與 commit status（ci/，唯讀內容）'],
    [id: 'lm-registry-pull', type: 'usernamePassword', description: 'Registry 唯讀拉取帳號（lm-pull-ci；只允許 GET/HEAD）'],
  ],
  // END credentials ci
  // BEGIN credentials release
  'release': [
    [id: 'lm-github-app', type: 'gitHubApp', description: 'GitHub App：checkout、Tag 驗證與 commit status（release/）'],
    [id: 'lm-registry-pull', type: 'usernamePassword', description: 'Registry 唯讀拉取帳號（只允許 GET/HEAD）'],
    [id: 'lm-registry-push', type: 'usernamePassword', description: 'Registry 唯一可寫入帳號 lm-push（推送、簽章、版本標籤）'],
    [id: 'lm-cosign-key', type: 'file', fileName: 'cosign.key', description: 'cosign 加密私鑰'],
    [id: 'lm-cosign-passphrase', type: 'string', description: 'cosign.key 的密碼'],
    [id: 'lm-cosign-pub', type: 'file', fileName: 'cosign.pub', description: 'cosign 公鑰（部署前驗證簽章與 attestation）'],
    [id: 'lm-deploy-known-hosts', type: 'file', fileName: 'known_hosts', description: 'Deploy_Host 的 known_hosts'],
    [id: 'lm-ssh-staging', type: 'sshKey', description: 'Staging 專用部署金鑰（lm-deploy-staging，forced command）'],
    [id: 'lm-staging-db', type: 'usernamePassword', description: 'Staging Database 帳號（與 Production 不同）'],
    [id: 'lm-staging-setup-token', type: 'string', description: 'Staging 的 Setup_Token'],
    [id: 'lm-staging-smoke', type: 'file', fileName: 'smoke-password', description: 'Staging 合成帳號 smoke-bot 的密碼'],
    [id: 'lm-ssh-prod', type: 'sshKey', description: 'Production 專用部署金鑰（lm-deploy-prod，forced command）'],
    [id: 'lm-prod-db', type: 'usernamePassword', description: 'Production Database 帳號（與 Staging 不同）'],
    [id: 'lm-prod-setup-token', type: 'string', description: 'Production 的 Setup_Token'],
    [id: 'lm-prod-smoke', type: 'file', fileName: 'smoke-password', description: 'Production 合成帳號 smoke-bot 的密碼'],
    [id: 'lm-jenkins-api-readonly', type: 'usernamePassword', description: 'Jenkins API 唯讀帳號（Overall/Read、Job/Read）'],
    [id: 'lm-jenkins-api-retention', type: 'usernamePassword', description: 'Jenkins API 帳號 lm-retention-bot（release/little-moments 的 Run/Update，僅設定 keepLog）'],
  ],
  // END credentials release
  // BEGIN credentials infra
  'infra': [
    [id: 'lm-github-app', type: 'gitHubApp', description: 'GitHub App：checkout（infra/）'],
    [id: 'lm-registry-push', type: 'usernamePassword', description: 'Registry 推送帳號 lm-push（只用於推送 Build_Image）'],
  ],
  // END credentials infra
]

// ---------------------------------------------------------------- 秘密來源

@Field final String SECRETS_ROOT = "${System.getenv('SECRETS') ?: '/run/secrets'}/little-moments".toString()

/** 憑證類型需要的秘密檔名（不含目錄）。 */
List<String> secretParts(Map c) {
  switch (c.type) {
    case 'usernamePassword': return ["${c.id}.username", "${c.id}.password"]*.toString()
    case 'string': return [c.id.toString()]
    case 'file': return [c.id.toString()]
    case 'sshKey': return ["${c.id}.username", "${c.id}.key"]*.toString()
    case 'gitHubApp': return ["${c.id}.app-id", "${c.id}.key"]*.toString()
    default: throw new IllegalArgumentException("未知的憑證類型：${c.type}（${c.id}）")
  }
}

File secretFile(String folder, String name) {
  return new File("${SECRETS_ROOT}/${folder}/${name}".toString())
}

/** 單行秘密：去除結尾換行；錯誤訊息只含資料夾與檔名，不含任何值。 */
String secretLine(String folder, String name) {
  String v = secretFile(folder, name).getText('UTF-8').replaceAll(/[\r\n]+$/, '')
  if (!v || v.contains('\n')) {
    throw new IllegalStateException("憑證來源格式錯誤：${folder}/${name}".toString())
  }
  return v
}

/** 多行秘密（私鑰）：保留原始內容。 */
String secretBlock(String folder, String name) {
  return secretFile(folder, name).getText('UTF-8')
}

/** 檔案憑證：原始位元組。 */
def secretBytes(String folder, String name) {
  return com.cloudbees.plugins.credentials.SecretBytes.fromBytes(secretFile(folder, name).bytes)
}

// 任何秘密檔缺少、不可讀或為空 → 列出全部缺少的「資料夾/檔名」後失敗，不建立或更新任何 Job（fail closed）。
List<String> missingSecrets = []
FOLDER_CREDENTIALS.each { String folder, List<Map> specs ->
  specs.each { Map c ->
    secretParts(c).each { String name ->
      File f = secretFile(folder, name)
      if (!f.isFile() || !f.canRead() || f.length() == 0) {
        missingSecrets << "${folder}/${name}".toString()
      }
    }
  }
}
if (!missingSecrets.isEmpty()) {
  throw new IllegalStateException("缺少資料夾憑證的秘密來源（${SECRETS_ROOT}）：${missingSecrets.join(', ')}".toString())
}

/** 先在 DSL 之外讀出一個資料夾全部的秘密值（DSL closure 只引用這些區域變數，不呼叫本檔的方法）。 */
List<Map> resolveCredentials(String folderName) {
  return FOLDER_CREDENTIALS[folderName].collect { Map c ->
    String cid = c.id.toString()
    Map r = [type: c.type, id: cid, description: c.description.toString()]
    switch (c.type) {
      case 'usernamePassword':
        r.username = secretLine(folderName, "${cid}.username".toString())
        r.password = secretLine(folderName, "${cid}.password".toString())
        break
      case 'string':
        r.secret = secretLine(folderName, cid)
        break
      case 'file':
        r.fileName = c.fileName.toString()
        r.bytes = secretBytes(folderName, cid)
        break
      case 'sshKey':
        r.username = secretLine(folderName, "${cid}.username".toString())
        r.key = secretBlock(folderName, "${cid}.key".toString())
        break
      case 'gitHubApp':
        r.appId = secretLine(folderName, "${cid}.app-id".toString())
        r.key = secretBlock(folderName, "${cid}.key".toString())
        break
      default:
        throw new IllegalArgumentException("未知的憑證類型：${c.type}（${cid}）".toString())
    }
    return r
  }
}

/**
 * 資料夾的 folderCredentialsProperty（作為 folder { properties(…) } 的內容）。
 *
 * Job DSL 以 plugin 的 @Symbol 解析 Describable，沒有 @Symbol 時用類別名稱首字小寫；CasC 的別名（gitHubApp、string、
 * file、directEntry）在 Job DSL 中不存在。因此憑證使用 stringCredentialsImpl、fileCredentialsImpl、
 * directEntryPrivateKeySource 與 gitHubAppCredentials；usernamePassword 與 basicSSHUserPrivateKey 兩種名稱相同。
 *
 * Job DSL 的例外訊息（例如 MissingMethodException）會列出參數值，曾把 GitHub App 私鑰印到 Jenkins 日誌。
 * 因此建立憑證時的任何例外都改丟出只含「資料夾/憑證 ID（類型）」與例外類別名稱的 IllegalStateException，
 * 不附原例外訊息與 cause。外層的 catch 遇到已改寫的例外（sanitized）時原樣拋出，其他例外只列出資料夾。
 */
Closure folderCredentials(String folderName) {
  List<Map> resolved = resolveCredentials(folderName)
  IllegalStateException sanitized = null
  return {
    try {
      folderCredentialsProperty {
        domainCredentials {
          domainCredentials {
            domain {
              name('')
              description('')
            }
            credentials {
              for (Map r in resolved) {
                try {
                  if (r.type == 'usernamePassword') {
                    usernamePassword {
                      scope('GLOBAL')
                      id(r.id)
                      description(r.description)
                      username(r.username)
                      password(r.password)
                    }
                  } else if (r.type == 'string') {
                    stringCredentialsImpl {
                      scope('GLOBAL')
                      id(r.id)
                      description(r.description)
                      secret(hudson.util.Secret.fromString(r.secret))
                    }
                  } else if (r.type == 'file') {
                    // FileCredentialsImpl(scope, id, description, FileItem file, String fileName, SecretBytes secretBytes)：
                    // file 為必要參數；以 secretBytes 提供內容時傳入 null。
                    fileCredentialsImpl {
                      scope('GLOBAL')
                      id(r.id)
                      description(r.description)
                      file(null)
                      fileName(r.fileName)
                      secretBytes(r.bytes)
                    }
                  } else if (r.type == 'sshKey') {
                    basicSSHUserPrivateKey {
                      scope('GLOBAL')
                      id(r.id)
                      description(r.description)
                      username(r.username)
                      passphrase('')
                      privateKeySource {
                        directEntryPrivateKeySource {
                          privateKey(hudson.util.Secret.fromString(r.key))
                        }
                      }
                    }
                  } else if (r.type == 'gitHubApp') {
                    // Job DSL 的方法名稱為類別名稱首字小寫（GitHubAppCredentials）；CasC 的 gitHubApp 在此不存在。
                    // 不設定 owner：github-branch-source 以 repositoryAccessStrategy（預設）由存取的 repository 推定 owner。
                    gitHubAppCredentials {
                      scope('GLOBAL')
                      id(r.id)
                      description(r.description)
                      appID(r.appId)
                      privateKey(hudson.util.Secret.fromString(r.key))
                    }
                  }
                } catch (Throwable e) {
                  sanitized = new IllegalStateException("無法建立資料夾憑證：${folderName}/${r.id}（${r.type}，${e.getClass().getName()}）".toString())
                  throw sanitized
                }
              }
            }
          }
        }
      }
    } catch (Throwable e) {
      if (sanitized != null && e.is(sanitized)) {
        throw e
      }
      throw new IllegalStateException("無法建立資料夾憑證：${folderName}（folderCredentialsProperty，${e.getClass().getName()}）".toString())
    }
  }
}

/** Multibranch 的分支保留屬性（BuildRetentionBranchProperty）。 */
Closure retention(String days) {
  return {
    buildRetention {
      buildDiscarder {
        logRotator {
          daysToKeepStr(days)
          numToKeepStr('')
          artifactDaysToKeepStr(days)
          artifactNumToKeepStr('')
        }
      }
    }
  }
}

/** 單一 Pipeline Job 由 main 分支的固定腳本載入（不從 PR 或其他分支載入）。 */
Closure mainScript(String path) {
  String repoUrl = REPO_URL
  String ref = "refs/heads/${MAIN_BRANCH}".toString()
  return {
    cpsScm {
      scm {
        git {
          remote {
            url(repoUrl)
            credentials('lm-github-app')
          }
          branch(ref)
        }
      }
      scriptPath(path)
      lightweight(true)
    }
  }
}

// DSL 內容（區域變數；在下方的 Job 定義中以 lexical 方式引用）。
Closure ciCredentials = folderCredentials('ci')
Closure releaseCredentials = folderCredentials('release')
Closure infraCredentials = folderCredentials('infra')
Closure prRetention = retention(KEEP_PR_DAYS)
Closure mainRetention = retention(KEEP_MAIN_DAYS)
Closure tagRetention = retention(KEEP_TAG_DAYS)
Closure rollbackScript = mainScript('ci/jenkins/pipelines/rollback.Jenkinsfile')
Closure restoreDrillScript = mainScript('ci/jenkins/pipelines/restore-drill.Jenkinsfile')
Closure digestLookupScript = mainScript('ci/jenkins/pipelines/digest-lookup.Jenkinsfile')
Closure buildImageScript = mainScript('ci/jenkins/pipelines/build-image.Jenkinsfile')

// ---------------------------------------------------------------- ci/：PR 與非 main 分支（Untrusted）

folder('ci') {
  displayName('ci（PR 與非 main 分支，無部署憑證）')
  description('Untrusted_PR 與其他分支的建置。只有 GitHub App 與唯讀 Registry 拉取憑證；建置只在 lm-untrusted agent 執行（Req 2.4–2.6）。')
  properties {
    authorizationMatrix {
      inheritanceStrategy { inheritingGlobal() }
      entries {
        group {
          name(GROUP_DEVELOPERS)
          permissions(['Job/Build', 'Job/Cancel'])
        }
      }
    }
  }
  properties(ciCredentials)
}

multibranchPipelineJob('ci/little-moments') {
  displayName('little-moments（PR 與非 main 分支）')
  description('PR（merge 與 head）與未關聯 PR 的非 main 分支：安裝、建置、單元測試、瀏覽器測試與 Security_Scanner（Req 1.2、1.8）。')
  branchSources {
    branchSource {
      source {
        github {
          id('lm-ci-little-moments')
          credentialsId('lm-github-app')
          repoOwner(GITHUB_OWNER)
          repository(GITHUB_REPO)
          repositoryUrl("https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}".toString())
          configuredByUrl(false)
          traits {
            // 1 = 排除已建立 PR 的分支（這些分支以 PR 建置），只留未關聯 PR 的分支（Req 1.8）。
            gitHubBranchDiscovery { strategyId(1) }
            // 3 = merge 與 head 兩種 PR 建置（Design「Jenkins Job 配置」）。
            gitHubPullRequestDiscovery { strategyId(3) }
            // fork PR：只信任具 Admin 或 Write 權限的作者；其他人的 PR 使用 main 的 Jenkinsfile（Req 2.7）。
            gitHubForkDiscovery {
              strategyId(3)
              trust { gitHubTrustPermissions() }
            }
            // commit status 由 ci/notify.groovy 的 githubNotify 以 little-moments/ci context 送出。
            githubSkipNotifications()
          }
        }
      }
      strategy {
        allBranchesSame {
          props(prRetention)
        }
      }
      buildStrategies {
        // PR 建立、推送新 commit 或重新開啟（Req 1.2）；不信任的 PR 仍建置（使用 main 的 Jenkinsfile）。
        buildChangeRequests {
          ignoreTargetOnlyChanges(false)
          ignoreUntrustedChanges(false)
        }
        // 一般分支，但不含 main：main 只在 release/little-moments 建置（Req 1.3）。
        buildAllBranches {
          strategies {
            buildRegularBranches()
            buildNoneBranches {
              strategies {
                buildNamedBranches {
                  filters {
                    exact {
                      name(MAIN_BRANCH)
                      caseSensitive(true)
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  factory {
    workflowBranchProjectFactory { scriptPath('Jenkinsfile') }
  }
  orphanedItemStrategy {
    discardOldItems {
      daysToKeep(KEEP_PR_DAYS.toInteger())
      numToKeep(-1)
    }
  }
  triggers {
    // webhook 為主要觸發（Req 1.9）；每日重新索引只作為遺漏事件的補救。
    periodicFolderTrigger { interval('1d') }
  }
}

// ---------------------------------------------------------------- release/：main 與 Release_Tag（Trusted）

folder('release') {
  displayName('release（main 與 Release_Tag，含部署憑證）')
  description('Trusted_Ref 建置與正式發布相關 Job。部署、簽章與資料庫憑證只存在此資料夾範圍；建置只在 lm-trusted agent 執行（Req 2.4、2.8、15.1）。')
  properties {
    authorizationMatrix {
      inheritanceStrategy { inheritingGlobal() }
      entries {
        // 核准 input 以使用者 ID（ci/release-approvers.json）限定 submitter，不需要 Job/Build；此處只給讀取。
        group {
          name(GROUP_RELEASE_APPROVERS)
          permissions(['Job/Read'])
        }
      }
    }
  }
  properties(releaseCredentials)
}

multibranchPipelineJob('release/little-moments') {
  displayName('little-moments（main 與 Release_Tag）')
  description('main：QA／安全／映像／Staging 關卡與 Staging 部署；Release_Tag：重新評估關卡、沿用 main 的 Image_Digest、人工核准後部署 Production（Req 1.3、1.4）。')
  properties {
    authorizationMatrix {
      inheritanceStrategy { inheritingGlobal() }
      entries {
        // Req 21.12 的唯一例外：只能設定 keepLog=true（ci/keep-log.mjs，Req 21.6）。沒有 Run/Delete、Job/Configure、Run/Replay。
        user {
          name(USER_RETENTION_BOT)
          permissions(['Job/Read', 'Run/Update'])
        }
      }
    }
  }
  branchSources {
    branchSource {
      source {
        github {
          id('lm-release-little-moments')
          credentialsId('lm-github-app')
          repoOwner(GITHUB_OWNER)
          repository(GITHUB_REPO)
          repositoryUrl("https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}".toString())
          configuredByUrl(false)
          traits {
            // 不探索任何 PR：PR 只在 ci/ 建置，無法取得本資料夾的憑證（Req 2.4）。
            gitHubBranchDiscovery { strategyId(3) }
            gitHubTagDiscovery()
            // 只保留 main 與 v<major>.<minor>.<patch>（預篩；名稱像 Tag 的分支由下方建置策略排除自動建置）。
            headRegexFilter { regex(RELEASE_HEAD_REGEX) }
            githubSkipNotifications()
          }
        }
      }
      strategy {
        // 預設（Release_Tag）365 天；main 90 天（Req 21.3、21.4）。
        namedExceptionsBranchPropertyStrategy {
          defaultProperties(tagRetention)
          namedExceptions {
            named {
              name(MAIN_BRANCH)
              props(mainRetention)
            }
          }
        }
      }
      buildStrategies {
        // 分支只自動建置 main（名稱符合 Tag 格式的分支不建置）。
        buildNamedBranches {
          filters {
            exact {
              name(MAIN_BRANCH)
              caseSensitive(true)
            }
          }
        }
        // Tag build strategy（basic-branch-build-strategies）：只建置 7 天內建立的 Tag，
        // 避免首次索引時建置所有歷史 Tag。Release_Tag 應使用 annotated tag（`git tag -a`），時間戳為建立時間。
        buildTags {
          atLeastDays('')
          atMostDays('7')
        }
      }
    }
  }
  factory {
    workflowBranchProjectFactory { scriptPath('Jenkinsfile') }
  }
  orphanedItemStrategy {
    discardOldItems {
      daysToKeep(KEEP_RELEASE_JOB_DAYS)
      numToKeep(-1)
    }
  }
  triggers {
    periodicFolderTrigger { interval('1d') }
  }
}

pipelineJob('release/rollback') {
  displayName('Production 手動回滾')
  description('Release_Approver 選擇 Deploy_Host 保留的 Image_Digest 進行回滾；不執行 Migration_Runner（Req 20.8–20.12）。')
  properties {
    authorizationMatrix {
      inheritanceStrategy { inheritingGlobal() }
      entries {
        group {
          name(GROUP_RELEASE_APPROVERS)
          permissions(['Job/Build', 'Job/Cancel'])
        }
      }
    }
  }
  logRotator {
    daysToKeep(KEEP_RELEASE_JOB_DAYS)
    artifactDaysToKeep(KEEP_RELEASE_JOB_DAYS)
  }
  definition(rollbackScript)
}

pipelineJob('release/restore-drill') {
  displayName('Production 備份還原演練')
  description('每月 1 日與 15 日還原最新已驗證備份至隔離環境並執行 Smoke_Test（Req 14.6、14.7）。')
  properties {
    authorizationMatrix {
      inheritanceStrategy { inheritingGlobal() }
      entries {
        group {
          name(GROUP_RELEASE_APPROVERS)
          permissions(['Job/Build'])
        }
      }
    }
    pipelineTriggers {
      triggers {
        // 與 restore-drill.Jenkinsfile 的 triggers 相同；兩次演練間隔不超過 16 天。
        cron { spec('H 3 1,15 * *') }
      }
    }
  }
  logRotator {
    daysToKeep(KEEP_RELEASE_JOB_DAYS)
    artifactDaysToKeep(KEEP_RELEASE_JOB_DAYS)
  }
  definition(restoreDrillScript)
}

pipelineJob('release/digest-lookup') {
  displayName('Image_Digest 稽核查詢')
  description('以 Image_Digest 查詢對應的 Build_Record：Commit SHA、Release_Tag、核准人、核准時間與 Production 部署時間（Req 21.7、21.8）。')
  properties {
    authorizationMatrix {
      inheritanceStrategy { inheritingGlobal() }
      entries {
        group {
          name(GROUP_RELEASE_APPROVERS)
          permissions(['Job/Build'])
        }
        group {
          name(GROUP_AUDITORS)
          permissions(['Job/Build'])
        }
      }
    }
  }
  parameters {
    stringParam('DIGEST', '', 'Image_Digest，格式 sha256:<64 個小寫十六進位字元>')
  }
  logRotator {
    daysToKeep(KEEP_LOOKUP_DAYS)
    artifactDaysToKeep(KEEP_LOOKUP_DAYS)
  }
  definition(digestLookupScript)
}

// ---------------------------------------------------------------- infra/：Build_Image（僅管理員）

folder('infra') {
  displayName('infra（Build_Image，僅管理員）')
  description('建置並推送 Build_Image。非管理員沒有任何建置權限；沒有部署、簽章或資料庫憑證（Req 3.1、3.2）。')
  properties(infraCredentials)
}

pipelineJob('infra/build-image') {
  displayName('Build_Image 建置')
  description('建置 ci/build-image/Dockerfile、推送並輸出 digest，驗證工具版本與 ci/toolchain.json 相符（Req 3.1、3.2）。')
  logRotator {
    daysToKeep(KEEP_INFRA_DAYS)
    artifactDaysToKeep(KEEP_INFRA_DAYS)
  }
  definition(buildImageScript)
}
