// 日子拾光 · LITTLE MOMENTS — infra/build-image：建置並推送 Build_Image（Requirement 3.1、3.2；Design「Jenkins 拓撲」「工具鏈」）。
//
// 流程：
//   Init       Job 名稱必須為 infra/build-image、拒絕 Replay、checkout、完整 40 字元 Commit SHA、
//              LM_BI_REPO 與 LM_CRANE_IMAGE（只以 digest 引用）格式檢查
//   Validate   ci/build-image/Dockerfile 不得殘留 `sha256:<digest>` 或 `ARG ...=<...>` PLACEHOLDER；每個 FROM 都以
//              `@sha256:<64 hex>` 固定；BUN_SHA256／NODE_SHA256 為 64 hex；ARG BUN_VERSION／NODE_VERSION 與
//              ci/toolchain.json 相同，且 Bun 屬於 1.4.x（fail closed，未通過即不建置）
//   Build      以只含 Dockerfile 的空 context（不送出工作區）`docker build --no-cache`，標籤為不可變的
//              `<LM_BI_REPO>:<完整 Commit SHA>`，並加上 commit／版本／工具鏈 OCI 標籤；記錄本機 image ID
//   Verify     在剛建置的映像（以 image ID 指定）內執行 ci/verify-toolchain.mjs 與 ci/verify-env.mjs：
//              --network none、--read-only、--cap-drop ALL、no-new-privileges、非 root、repo 唯讀掛載；
//              任一工具實際版本與 ci/toolchain.json 不一致即失敗，不推送（Req 3.2）
//   Push       推送帳號只在 withCredentials 內；標籤已存在即拒絕覆寫 → docker push → 本機 RepoDigest、Registry 的
//              標籤 digest 與以 digest 查詢的結果三者必須一致 → reports/build-image-digest.txt
//              （內容恰為 `<LM_BI_REPO>@sha256:<digest>\n`）封存並 fingerprint，digest 同時寫入建置描述，
//              供維運者貼入根目錄 Jenkinsfile 與 ci/jenkins/pipelines/*.Jenkinsfile 的 BUILD_IMAGE（Req 3.1）
//   post       封存 reports/；移除本機標籤與暫存目錄；cleanWs
//
// 規則（與根目錄 Jenkinsfile 相同）：
//   * 沒有任何建置參數（沒有 `parameters` 區塊），沒有可略過檢查或允許覆寫標籤的選項。
//   * 憑證只在需要的步驟內以 withCredentials 提供；本檔只出現憑證 ID。`lm-registry-push`（Username with password：
//     Registry 唯一可寫入的帳號）必須定義在 infra/ 資料夾範圍。
//   * 所有 sh 腳本為單引號字串，外部值只經 shell 環境變數（加雙引號）取用，不經 Groovy 插值；不使用雙引號字串。
//     觸及秘密的腳本第一行為 `set +x`；docker 登入資訊只存在本建置暫存目錄（0700），由 trap 刪除。
//   * 所有容器都不發布連接埠、不使用 host 網路、不以 privileged 執行。建置期間 RUN 指令需要網路下載 Node.js／Bun，
//     下載內容由 Dockerfile 以 SHA-256 校驗；工具鏈驗證容器沒有任何網路。
//
// Dockerfile 前端：`# syntax=docker/dockerfile:1.10@sha256:<64 hex>` 以 digest 固定，BuildKit 依 digest 自 Docker Hub
// 拉取（未鏡像至 LAN Registry，與 RUN 下載 Node.js／Bun 相同需要對外網路）；Docker Hub 上的 tag 被改寫也不影響結果。
//
// 需要的 plugin：Pipeline、Credentials Binding、Timestamper、Workspace Cleanup。Agent 需有 docker CLI、git、coreutils。
//
// 注意：本檔無法在本機執行，語法與 plugin 步驟參數未經 Jenkins 實際驗證。

import groovy.json.JsonSlurperClassic

pipeline {
  agent { label 'lm-trusted' }

  options {
    skipDefaultCheckout()
    timestamps()
    disableResume()
    disableConcurrentBuilds()
    timeout(time: 120, unit: 'MINUTES')
    buildDiscarder(logRotator(daysToKeepStr: '90'))
  }

  environment {
    // Build_Image repository（與 BUILD_IMAGE 引用的 repository 相同，位於 LAN Registry）。
    LM_BI_REPO = 'registry.our-littlemoments.com:8443/little-moments/build-image'
    LM_BI_DOCKERFILE = 'ci/build-image/Dockerfile'
    LM_TOOLCHAIN = 'ci/toolchain.json'
    // Registry 操作工具（與根目錄 Jenkinsfile 的 LM_CRANE_IMAGE 相同）：鏡像至 LAN Registry 並只以 digest 引用。
    // 上游 gcr.io/go-containerregistry/crane:v0.22.1（linux/amd64）；更新方式見 deploy/registry/mirror.list 與 mirror.sh。
    LM_CRANE_IMAGE = 'registry.our-littlemoments.com:8443/little-moments/mirror/crane@sha256:18efc5092649b2a674d384663044e04edf76705c4faa2875e8a322b4e80f070a'
    // Agent 的系統 CA bundle（須含 LAN Registry 的內部 CA），以唯讀方式提供給 crane。
    LM_SCAN_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt'
    // 憑證 ID（值只存在 infra/ 資料夾範圍的 Credential_Store）。
    LM_REGISTRY_PUSH_CREDENTIALS = 'lm-registry-push'
  }

  stages {
    stage('Init') {
      steps {
        script {
          env.LM_BI_VERIFIED = 'false'
          env.LM_BI_REF = ''
          if (env.JOB_NAME != 'infra/build-image') {
            error('Build_Image 只能由 infra/build-image Job 建置')
          }
          if (isReplay()) {
            error('infra/build-image 不接受 Replay，請重新觸發建置')
          }
          if (!((env.LM_BI_REPO ?: '') ==~ /^[a-z0-9][a-z0-9.\-]*(:[0-9]+)?\/[a-z0-9][a-z0-9._\/\-]*$/)) {
            error('LM_BI_REPO 格式無效')
          }
          assertDigestRef('LM_CRANE_IMAGE', env.LM_CRANE_IMAGE)

          checkout scm
          String sha = sh(label: 'git rev-parse HEAD', returnStdout: true, script: 'git rev-parse HEAD').trim()
          if (!(sha ==~ /^[0-9a-f]{40}$/)) {
            error('無法取得 40 字元 Commit SHA')
          }
          env.GIT_COMMIT_FULL = sha
          env.LM_BI_TAG = sha
          env.LM_BI_DIR = env.WORKSPACE_TMP + '/build-image'
          sh(label: 'work dirs', script: '''
            set -eu
            rm -rf "$LM_BI_DIR" reports
            mkdir -p -m 0700 "$LM_BI_DIR"
            mkdir -p reports
          ''')
        }
      }
    }

    // PLACEHOLDER 與版本一致性檢查：Dockerfile 只解析非註解行；任何問題都寫入 reports/build-image-validate.txt。
    stage('Validate') {
      steps {
        script {
          int rc = sh(label: 'validate Dockerfile', returnStatus: true, script: '''
            set +x
            set -u
            f="$LM_BI_DOCKERFILE"
            tc="$LM_TOOLCHAIN"
            problems="reports/build-image-validate.txt"
            : > "$problems"
            fail() {
              printf '%s\\n' "$1" >> "$problems"
              printf '%s\\n' "$1" >&2
            }
            if [ ! -f "$f" ] || [ ! -f "$tc" ]; then
              fail "找不到 $f 或 $tc"
              exit 1
            fi
            code="$LM_BI_DIR/dockerfile.code"
            grep -v '^[[:space:]]*#' "$f" > "$code" || true

            if grep -n 'sha256:<' "$code" >&2; then
              fail "Dockerfile 仍有 sha256:<digest> PLACEHOLDER，請填入基底映像的實際 digest"
            fi
            if grep -nE '^[[:space:]]*ARG[[:space:]]+[A-Za-z0-9_]+=<' "$code" >&2; then
              fail "Dockerfile 仍有 ARG <...> PLACEHOLDER，請填入實際的 SHA-256"
            fi
            froms="$(grep -ciE '^[[:space:]]*FROM[[:space:]]' "$code" || true)"
            pinned="$(grep -cE '^[[:space:]]*FROM[[:space:]]+[^[:space:]@]+@sha256:[0-9a-f]{64}([[:space:]]+AS[[:space:]]+[A-Za-z0-9_.-]+)?[[:space:]]*$' "$code" || true)"
            if [ "${froms:-0}" -lt 1 ] || [ "$froms" != "$pinned" ]; then
              fail "每個 FROM 都必須以 @sha256:<64 個小寫十六進位字元> 固定基底映像"
            fi
            for name in BUN_SHA256 NODE_SHA256; do
              if ! grep -Eq '^[[:space:]]*ARG[[:space:]]+'"$name"'=[0-9a-f]{64}[[:space:]]*$' "$code"; then
                fail "ARG $name 必須為 64 個小寫十六進位字元"
              fi
            done

            json_value() {
              grep -Eo '"'"$1"'"[[:space:]]*:[[:space:]]*"[^"]*"' "$tc" | head -n 1 | cut -d '"' -f 4
            }
            arg_value() {
              grep -E '^[[:space:]]*ARG[[:space:]]+'"$1"'=' "$code" | head -n 1 | cut -d = -f 2- | tr -d '[:space:]'
            }
            bun_v="$(json_value bun)"
            node_v="$(json_value node)"
            chromium_v="$(json_value chromium)"
            for pair in "bun=$bun_v" "node=$node_v" "chromium=$chromium_v"; do
              if ! printf '%s\\n' "${pair#*=}" | grep -Eqx '[0-9]+[.][0-9]+[.][0-9]+([.][0-9]+)?'; then
                fail "ci/toolchain.json 的 ${pair%%=*} 版本無效或未設定"
              fi
            done
            case "$bun_v" in
              1.4.*) ;;
              *) fail "ci/toolchain.json 的 bun 必須屬於 1.4.x" ;;
            esac
            if [ "$(arg_value BUN_VERSION)" != "$bun_v" ]; then
              fail "ARG BUN_VERSION 與 ci/toolchain.json 的 bun（$bun_v）不一致"
            fi
            if [ "$(arg_value NODE_VERSION)" != "$node_v" ]; then
              fail "ARG NODE_VERSION 與 ci/toolchain.json 的 node（$node_v）不一致"
            fi

            if [ -s "$problems" ]; then
              exit 1
            fi
            printf 'bun=%s\\nnode=%s\\nchromium=%s\\n' "$bun_v" "$node_v" "$chromium_v" > "$LM_BI_DIR/toolchain.txt"
            exit 0
          ''')
          if (rc != 0) {
            currentBuild.description = 'Dockerfile 或 ci/toolchain.json 檢查未通過（見 reports/build-image-validate.txt）'
            error('ci/build-image/Dockerfile 仍有 PLACEHOLDER、基底映像未以 digest 固定，或版本與 ci/toolchain.json 不一致（fail closed）')
          }
          Map tc = [:]
          for (String line : readFile(env.LM_BI_DIR + '/toolchain.txt').tokenize('\n')) {
            int i = line.indexOf('=')
            if (i > 0) {
              tc[line.substring(0, i)] = line.substring(i + 1)
            }
          }
          for (String tool : ['bun', 'node', 'chromium']) {
            if (!((tc[tool] ?: '') ==~ /^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$/)) {
              error('ci/toolchain.json 的 ' + tool + ' 版本無效')
            }
          }
          env.LM_TC_BUN = tc.bun
          env.LM_TC_NODE = tc.node
          env.LM_TC_CHROMIUM = tc.chromium
        }
      }
    }

    stage('Build') {
      steps {
        script {
          env.LM_BI_REF = env.LM_BI_REPO + ':' + env.LM_BI_TAG
          int rc
          timeout(time: 60, unit: 'MINUTES') {
            rc = sh(label: 'docker build Build_Image', returnStatus: true, script: '''
              set +x
              set -eu
              ctx="$LM_BI_DIR/context"
              rm -rf "$ctx"
              mkdir -p "$ctx"
              cp "$LM_BI_DOCKERFILE" "$ctx/Dockerfile"
              created="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
              rm -f "$LM_BI_DIR/image-id.txt"
              rc=0
              docker build --no-cache --file "$ctx/Dockerfile" --tag "$LM_BI_REF" \
                --label "org.opencontainers.image.title=little-moments-build-image" \
                --label "org.opencontainers.image.revision=$GIT_COMMIT_FULL" \
                --label "org.opencontainers.image.version=$LM_BI_TAG" \
                --label "org.opencontainers.image.created=$created" \
                --label "lm.toolchain.bun=$LM_TC_BUN" \
                --label "lm.toolchain.node=$LM_TC_NODE" \
                --label "lm.toolchain.chromium=$LM_TC_CHROMIUM" \
                --label "lm.ci.build=$BUILD_TAG" \
                "$ctx" > reports/build-image-build.log 2>&1 || rc=$?
              if [ "$rc" -ne 0 ]; then
                tail -n 50 reports/build-image-build.log >&2
                exit "$rc"
              fi
              docker image inspect --format '{{.Id}}' "$LM_BI_REF" > "$LM_BI_DIR/image-id.txt"
            ''')
          }
          if (rc != 0) {
            error('Build_Image 建置失敗（見 reports/build-image-build.log）')
          }
          String id = readFile(env.LM_BI_DIR + '/image-id.txt').trim()
          if (!(id ==~ /^sha256:[0-9a-f]{64}$/)) {
            error('無法取得 Build_Image 的本機 image ID')
          }
          env.LM_BI_ID = id
        }
      }
    }

    // 在推送之前於剛建置的映像內驗證工具鏈；容器沒有網路、根檔案系統唯讀、移除所有 capability，repo 以唯讀掛載。
    stage('Verify Toolchain') {
      steps {
        script {
          int rc
          timeout(time: 10, unit: 'MINUTES') {
            rc = sh(label: 'verify toolchain in Build_Image', returnStatus: true, script: '''
              set +x
              set -u
              out="$LM_BI_DIR/verify"
              rm -rf "$out"
              mkdir -p -m 0700 "$out"
              rm -f reports/build-image-toolchain.json reports/build-image-env.json
              in_image() {
                timeout --kill-after=10 300 docker run --rm \
                  --label "lm.ci.build=$BUILD_TAG" \
                  --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
                  --user "$(id -u):$(id -g)" --pids-limit 512 --memory 2g \
                  --tmpfs /tmp:rw,nosuid,nodev,size=256m -e HOME=/tmp \
                  --mount "type=bind,src=$WORKSPACE,dst=/src,readonly" \
                  --mount "type=bind,src=$out,dst=/out" \
                  --workdir /src --entrypoint /usr/local/bin/bun \
                  "$LM_BI_ID" "$@"
              }
              trc=0
              in_image ci/verify-toolchain.mjs --expected "$LM_TOOLCHAIN" --out /out/toolchain.json || trc=$?
              erc=0
              in_image ci/verify-env.mjs --out /out/env.json || erc=$?
              [ -f "$out/toolchain.json" ] && cp "$out/toolchain.json" reports/build-image-toolchain.json
              [ -f "$out/env.json" ] && cp "$out/env.json" reports/build-image-env.json
              if [ "$trc" -ne 0 ]; then
                exit 1
              fi
              if [ "$erc" -ne 0 ]; then
                exit 2
              fi
              exit 0
            ''')
          }
          if (rc == 1) {
            error('Build_Image 的 Bun／Node.js／Chromium 實際版本與 ci/toolchain.json 不一致（見 reports/build-image-toolchain.json），不推送')
          } else if (rc == 2) {
            error('Build_Image 的 CHROME_PATH／CAMPING_BUN 無效（見 reports/build-image-env.json），不推送')
          } else if (rc != 0) {
            error('無法在 Build_Image 內執行工具鏈驗證（結束碼 ' + rc + '），不推送')
          }
          Map record = readJsonFile('reports/build-image-toolchain.json')
          if (record.ok != true || !(record.mismatches instanceof List) || !record.mismatches.isEmpty()) {
            error('工具鏈驗證報告無效或不一致，不推送')
          }
          Map expected = [bun: env.LM_TC_BUN, node: env.LM_TC_NODE, chromium: env.LM_TC_CHROMIUM]
          for (String tool : ['bun', 'node', 'chromium']) {
            if (!(record.actual instanceof Map) || record.actual[tool] != expected[tool]) {
              error('Build_Image 的 ' + tool + ' 實際版本與 ci/toolchain.json 不一致，不推送')
            }
          }
          env.LM_BI_VERIFIED = 'true'
        }
      }
    }

    // 推送與 digest 比對：與根目錄 Jenkinsfile 的 Image Push 相同的作法。
    stage('Push') {
      steps {
        script {
          if (env.LM_BI_VERIFIED != 'true' || !(env.LM_BI_ID ==~ /^sha256:[0-9a-f]{64}$/)) {
            error('工具鏈驗證未通過，不推送 Build_Image')
          }
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
                rm -f reports/build-image-digest.txt
                registry="${LM_BI_REPO%%/*}"
                DOCKER_CONFIG="$LM_BI_DIR/docker-push"
                export DOCKER_CONFIG
                rm -rf "$DOCKER_CONFIG"
                mkdir -m 0700 "$DOCKER_CONFIG"
                trap 'docker logout "$registry" > /dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"' EXIT
                printf '%s' "$LM_PUSH_PASSWORD" | docker login --username "$LM_PUSH_USER" --password-stdin "$registry" > /dev/null 2>&1 || exit 20
                crane() {
                  timeout --kill-after=10 120 docker run --rm \
                    --label "lm.ci.build=$BUILD_TAG" \
                    --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m -e HOME=/tmp \
                    --security-opt no-new-privileges:true --cap-drop ALL --network bridge \
                    -e DOCKER_CONFIG=/docker-config -e SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
                    --mount "type=bind,src=$DOCKER_CONFIG,dst=/docker-config,readonly" \
                    --mount "type=bind,src=$LM_SCAN_CA_BUNDLE,dst=/etc/ssl/certs/ca-certificates.crt,readonly" \
                    "$LM_CRANE_IMAGE" "$@"
                }
                out="$LM_BI_DIR"
                if [ "$(docker image inspect --format '{{.Id}}' "$LM_BI_REF" 2> /dev/null)" != "$LM_BI_ID" ]; then
                  echo "本機標籤 $LM_BI_REF 已不是通過驗證的映像" >&2
                  exit 16
                fi
                rc=0
                crane digest "$LM_BI_REF" > "$out/existing-digest.txt" 2> "$out/existing-digest.err" || rc=$?
                if [ "$rc" -eq 0 ]; then
                  echo "Registry 已存在標籤 $LM_BI_TAG，拒絕覆寫" >&2
                  exit 10
                fi
                if ! grep -Eq 'MANIFEST_UNKNOWN|unexpected status code 404' "$out/existing-digest.err"; then
                  echo "Registry 查詢失敗，無法確認標籤是否已存在" >&2
                  exit 11
                fi
                docker push --quiet "$LM_BI_REF" > "$out/push.log" 2>&1 || exit 12
                local_ref="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$LM_BI_ID" \
                  | awk -v p="$LM_BI_REPO@sha256:" 'index($0, p) == 1 { print; exit }')"
                digest="${local_ref#"$LM_BI_REPO@"}"
                if ! printf '%s\\n' "$digest" | grep -Eqx 'sha256:[0-9a-f]{64}'; then
                  echo "推送後無法取得本機 RepoDigest" >&2
                  exit 13
                fi
                remote="$(crane digest "$LM_BI_REF" 2> /dev/null)" || exit 14
                by_digest="$(crane digest "$LM_BI_REPO@$digest" 2> /dev/null)" || exit 14
                if [ "$remote" != "$digest" ] || [ "$by_digest" != "$digest" ]; then
                  echo "Registry 回報的 digest 與本機 RepoDigest 不一致" >&2
                  exit 15
                fi
                printf '%s@%s\\n' "$LM_BI_REPO" "$digest" > reports/build-image-digest.txt
                exit 0
              ''')
            }
          }
          if (pushRc == 10) {
            error('Registry 已存在標籤 ' + env.LM_BI_TAG + '，拒絕覆寫（Build_Image 標籤不可變）')
          } else if (pushRc == 11 || pushRc == 14) {
            error('Registry 查詢失敗，無法確認標籤或比對 digest')
          } else if (pushRc == 12) {
            error('Build_Image 推送失敗')
          } else if (pushRc == 13 || pushRc == 15) {
            error('Registry 回報的 digest 與本機 RepoDigest 不一致')
          } else if (pushRc == 16) {
            error('本機標籤已不是通過工具鏈驗證的映像，拒絕推送')
          } else if (pushRc == 20) {
            error('無法以 ' + env.LM_REGISTRY_PUSH_CREDENTIALS + ' 登入 Registry')
          } else if (pushRc != 0) {
            error('Build_Image 推送或 digest 比對無法完成（結束碼 ' + pushRc + '）')
          }
          String content = readFile('reports/build-image-digest.txt')
          String ref = content.trim()
          String prefix = env.LM_BI_REPO + '@'
          if (!ref.startsWith(prefix) || !(ref.substring(prefix.length()) ==~ /^sha256:[0-9a-f]{64}$/) || content != ref + '\n') {
            error('reports/build-image-digest.txt 格式無效（必須恰為 `<repo>@sha256:<digest>\\n`）')
          }
          env.LM_BI_DIGEST_REF = ref
          archiveArtifacts(artifacts: 'reports/build-image-digest.txt', fingerprint: true)
          currentBuild.description = 'BUILD_IMAGE = ' + ref
          echo('Build_Image 已推送並驗證：' + ref + '（請以此值取代 Jenkinsfile 與 ci/jenkins/pipelines/*.Jenkinsfile 的 BUILD_IMAGE）')
        }
      }
    }
  }

  post {
    always {
      archiveArtifacts(artifacts: 'reports/**', allowEmptyArchive: true)
    }
    cleanup {
      sh(label: 'remove local temp', script: '''
        set +x
        if [ -n "${LM_BI_REF:-}" ]; then
          docker image rm "$LM_BI_REF" > /dev/null 2>&1 || true
        fi
        if [ -n "${LM_BI_DIR:-}" ]; then
          rm -rf "$LM_BI_DIR"
        fi
      ''')
      cleanWs(deleteDirs: true, notFailBuild: true)
    }
  }
}

// ------------------------------------------------------------------ 輔助函式

boolean isReplay() {
  return !currentBuild.getBuildCauses('org.jenkinsci.plugins.workflow.cps.replay.ReplayCause').isEmpty()
}

/** 驗證映像引用為 <registry>/<repo>@sha256:<64 hex>；PLACEHOLDER 未取代時失敗（fail closed）。 */
void assertDigestRef(String name, String value) {
  String ref = value ?: ''
  if (!(ref ==~ /^[a-z0-9][a-z0-9.\-]*(:[0-9]+)?\/[a-z0-9][a-z0-9._\/\-]*@sha256:[0-9a-f]{64}$/)) {
    error(name + ' 必須以 <registry>/<repo>@sha256:<64 hex> 引用；請以鏡像後的實際 digest 取代 PLACEHOLDER')
  }
}

/** 讀取 JSON 檔；讀取或解析失敗回傳空 Map。失敗時只輸出例外類別（Components 第 23.3 節）。 */
Map readJsonFile(String path) {
  String failure = null
  Object parsed = null
  try {
    String text = readFile(path)
    parsed = parseJsonText(text)
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

/** 唯一建立 JsonSlurperClassic 的地方（Components 第 23 節）。回傳 Map／List／String／Number／Boolean／null（皆可序列化）；
 *  null、空字串或無效 JSON 時丟出例外，由呼叫端處理。 */
@NonCPS
Object parseJsonText(String text) {
  return new JsonSlurperClassic().parseText(text)
}
