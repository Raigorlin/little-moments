// 通知階段（Requirement 22.1–22.4、22.6–22.8；Design Components §16）。
//
// 使用方式（Jenkinsfile）：
//   def notifier = load 'ci/notify.groovy'
//   notifier.notifyAll('pending', [commit: env.GIT_COMMIT_FULL])                // Init 階段，任何安裝／建置前
//   post { always { script { notifier.notifyAll(finalStatus, [commit: sha, failedStage: firstFailedStage]) } } }
//
// 行為規則與 ci/notify.mjs（Property 44 的參考實作）一致：
//   * 每個管道最多嘗試 4 次（初次 + 3 次重試，Req 22.7）。Jenkins 的 `retry(count)` 中 count 為「總執行次數」
//     （retry(3) 最多只執行 3 次），因此這裡使用 retry(4)，才符合需求的「最多重試 3 次」。
//   * 每個管道以 try/catch 包住；最終失敗只在建置摘要加入「通知失敗：<管道名>」，
//     不改變 currentBuild.result，也不向呼叫端拋出例外。
//   * 內容只含狀態、失敗階段名稱、7 字元短 SHA 與 BUILD_URL；不含秘密、錯誤訊息原文或使用者資料（Req 22.8）。
//   * 新增管道只需在 channels() 加入一筆，不需修改建置、測試、掃描或部署階段（Req 22.6）。
//
// 依賴 plugin（皆列於設計的工具表）：Pipeline GitHub Notify Step（githubNotify）。
// Jenkins 摘要使用核心的 currentBuild.description，不需額外 plugin。
//
// 注意：本檔無法在本機執行，語法與步驟參數未經 Jenkins 實際驗證。
// `notifyAll(String, Map)` 與 java.lang.Object#notifyAll() 的參數簽章不同，屬合法多載；
// 若 Script Security 環境仍有衝突，可改呼叫等價的 notifyChannels(status, context)。

import groovy.transform.Field

@Field final String GITHUB_CONTEXT = 'little-moments/ci'
@Field final int MAX_ATTEMPTS = 4
@Field final int DESCRIPTION_MAX = 140

// 建置狀態 → GitHub 狀態（與 notify.mjs 的 githubState 相同；未知值 fail closed 為 FAILURE）。
String githubState(String status) {
  String key = (status ?: '').trim().toLowerCase()
  if (key == 'pending') { return 'PENDING' }
  if (key == 'success') { return 'SUCCESS' }
  return 'FAILURE'   // failure、aborted、timeout、rejected、error 與未知值（Req 22.3）
}

String safeStage(def stage) {
  if (stage == null) { return '' }
  String s = stage.toString().replaceAll(/[^\p{L}\p{N} _\-.\/()]/, '').replaceAll(/\s+/, ' ').trim()
  return s.length() > 60 ? s.substring(0, 60) : s
}

String shortSha(def commit) {
  String c = commit == null ? '' : commit.toString()
  return (c ==~ /^[0-9a-fA-F]{7,40}$/) ? c.substring(0, 7).toLowerCase() : ''
}

// 與 notify.mjs 的 statusDescription 相同：只含狀態、失敗階段與短 SHA，最長 140 字元。
String statusDescription(String status, Map context) {
  String state = githubState(status)
  List parts = []
  if (state == 'PENDING') { parts << '建置進行中' }
  else if (state == 'SUCCESS') { parts << '建置成功' }
  else { parts << '建置失敗' }
  if (state == 'FAILURE') {
    String stage = safeStage(context?.failedStage)
    if (stage) { parts << "失敗階段：${stage}".toString() }
  }
  String sha = shortSha(context?.commit)
  if (sha) { parts << "commit ${sha}".toString() }
  String d = parts.join(' · ')
  return d.length() > DESCRIPTION_MAX ? d.substring(0, DESCRIPTION_MAX) : d
}

// ---------------------------------------------------------------- 管道

// GitHub commit status：附 Jenkins 建置連結（Req 22.1–22.3）。sha 使用建置的確切 Commit SHA。
def githubStatus(String status, Map context) {
  Map args = [
    status     : githubState(status),
    context    : GITHUB_CONTEXT,
    description: statusDescription(status, context),
    targetUrl  : env.BUILD_URL ?: '',
  ]
  String commit = context?.commit?.toString() ?: ''
  if (commit ==~ /^[0-9a-fA-F]{40}$/) { args.sha = commit }
  githubNotify(args)
}

// Jenkins 建置摘要：顯示狀態與第一個失敗階段（Req 22.4）。
// Release_Gate 名稱、未通過條件與報告連結由呼叫端以 context.gateSummary 提供（只應含關卡名稱、條件與報告路徑）。
def jenkinsSummary(String status, Map context) {
  List lines = [statusDescription(status, context)]
  if (githubState(status) == 'FAILURE' && context?.gateSummary) {
    lines << context.gateSummary.toString().take(500)
  }
  appendDescription(lines.join('<br>'))
}

// 在不覆寫既有描述（例如 resolve-digest 寫入的原因）的前提下附加一行。
def appendDescription(String line) {
  String current = currentBuild.description ?: ''
  currentBuild.description = current ? "${current}<br>${line}".toString() : line
}

// 已註冊的管道；新增管道只需在此加入一筆（Req 22.6）。
List channels() {
  return [
    [name: 'githubStatus',   send: { String s, Map c -> githubStatus(s, c) }],
    [name: 'jenkinsSummary', send: { String s, Map c -> jenkinsSummary(s, c) }],
  ]
}

// ---------------------------------------------------------------- 進入點

// 依序送出所有管道。永不拋出例外，也不改變 currentBuild.result（Req 22.7）。
// 回傳 [[channel, ok]]，供呼叫端寫入 Build_Record（可忽略）。
def notifyChannels(String status, Map context = [:]) {
  def resultBefore = currentBuild.result
  List deliveries = []
  List failed = []
  for (def ch in channels()) {
    boolean ok = false
    String sendFailure = null
    try {
      retry(MAX_ATTEMPTS) {
        ch.send.call(status, context ?: [:])
      }
      ok = true
    } catch (Throwable e) {
      // 不輸出例外訊息：訊息可能含權杖或回應內容（Req 22.8）；只記錄例外類別（Components 第 23.3 節）。
      // 注意：使用者中止（FlowInterruptedException）也會在此被吸收，以免通知階段改變建置結果。
      sendFailure = e.getClass().getName()
      ok = false
    }
    if (sendFailure != null) {
      echo "notifyChannels/send: ${sendFailure}（${ch.name}）"
    }
    deliveries << [channel: ch.name, ok: ok]
    if (!ok) { failed << ch.name }
  }
  for (String name in failed) {
    String descriptionFailure = null
    try {
      appendDescription("通知失敗：${name}".toString())
    } catch (Throwable e) {
      descriptionFailure = e.getClass().getName()
    }
    if (descriptionFailure != null) {
      echo "notifyChannels/description: ${descriptionFailure}"
      echo "通知失敗：${name}"
    }
  }
  // 防禦：任何管道若意外改動結果，嘗試還原為通知前的值
  // （Jenkins 只允許結果變差，因此這僅在結果被意外調整時才有作用）。
  String resultFailure = null
  try {
    if (resultBefore != null && currentBuild.result != resultBefore) {
      currentBuild.result = resultBefore
    }
  } catch (Throwable e) {
    resultFailure = e.getClass().getName()
  }
  if (resultFailure != null) {
    echo "notifyChannels/result: ${resultFailure}"
  }
  return deliveries
}

// 設計文件指定的名稱；與 notifyChannels 等價。
def notifyAll(String status, Map context) {
  return notifyChannels(status, context)
}

return this
