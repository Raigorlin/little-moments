#!/usr/bin/env bash
# LAN Registry 存取控制驗證（Requirement 15.9；design.md「重要設計決策摘要 › Registry」）。
#
# 對已啟動的 Registry（./compose.yaml：Caddy TLS + basic auth + 方法 ACL，Distribution 關閉刪除）
# 從用戶端以 HTTPS 驗證：
#   1. 未認證請求與錯誤密碼一律被拒（401）。
#   2. 拉取帳號可 GET／HEAD（/v2/、tags/list，指定 LM_REGISTRY_REF 時另含 manifest）。
#   3. 拉取帳號的 POST／PUT／PATCH／DELETE 一律被拒（401／403；DELETE 亦接受 405）。
#   4. 推送帳號認證有效，但 DELETE manifest／blob 回應 405（Caddy「deletion is disabled」或
#      Distribution `UNSUPPORTED`），即刪除 API 已關閉。
#
# 非破壞性：所有寫入與刪除探測只針對隨機產生、不存在的 digest、標籤與上傳 ID，PUT 的 manifest
# 內容為無效的 `{}`。即使 ACL 或刪除設定有誤，探測也不會覆寫或刪除既有映像：Distribution 在
# 刪除關閉時先回 405 UNSUPPORTED（不查詢內容是否存在），刪除開啟時對不存在的 digest 回 404，
# 本腳本把 404 判為 FAIL。唯一可能留下的是 ACL 失效時 POST 建立的空上傳工作階段，
# 由 config.yml 的 uploadpurging 於 168 小時後清除。
#
# 必要環境變數（值只從環境讀取；腳本不輸出任何密碼）：
#   LM_REGISTRY_URL            Registry 基底 URL，限 https，例如 https://<registry.lan.example>
#   LM_REGISTRY_CA_CERT        內部 CA 憑證檔路徑（PEM），用於驗證 Registry 伺服器憑證
#   LM_REGISTRY_PULL_USER      拉取帳號（例如 lm-pull-prod）
#   LM_REGISTRY_PULL_PASSWORD  拉取帳號密碼
#   LM_REGISTRY_PUSH_USER      推送帳號（lm-push）
#   LM_REGISTRY_PUSH_PASSWORD  推送帳號密碼
# 選用環境變數：
#   LM_REGISTRY_REPO           repository 名稱（預設 little-moments）
#   LM_REGISTRY_REF            已存在的標籤或 sha256 digest；設定時驗證拉取帳號可 HEAD／GET manifest，
#                              未設定時該兩項記為 SKIP
#   CURL_BIN                   curl 執行檔（預設 curl；供測試以 shim 取代）
#
# 密碼處理：帳號密碼寫入 mktemp 建立的 0700 目錄中 0600 的 curl 設定檔，以 `curl -K` 讀取，
# 不出現在 curl 的命令列參數（ps 不可見）；腳本結束（含中斷）時刪除該目錄。curl 以 `-q`
# 執行，不讀取 ~/.curlrc，也不使用 .netrc；不跟隨轉址，不經 HTTP proxy。
#
# 結束碼：0 全部通過；1 至少一項 FAIL；2 設定錯誤（缺少或無效的環境變數）。
set -euo pipefail
umask 077

CURL_BIN="${CURL_BIN:-curl}"

die() {
  echo "verify-registry: $*" >&2
  exit 2
}

require_env() {
  local name
  for name in "$@"; do
    [[ -n "${!name:-}" ]] || die "缺少必要環境變數 ${name}"
  done
}

require_env LM_REGISTRY_URL LM_REGISTRY_CA_CERT \
  LM_REGISTRY_PULL_USER LM_REGISTRY_PULL_PASSWORD \
  LM_REGISTRY_PUSH_USER LM_REGISTRY_PUSH_PASSWORD

registry_url="${LM_REGISTRY_URL%/}"
repo="${LM_REGISTRY_REPO:-little-moments}"
ref="${LM_REGISTRY_REF:-}"

[[ "$registry_url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] \
  || die "LM_REGISTRY_URL 必須為 https://<主機>[:<連接埠>]，不得含路徑或帳密"
[[ -f "$LM_REGISTRY_CA_CERT" && -r "$LM_REGISTRY_CA_CERT" ]] \
  || die "LM_REGISTRY_CA_CERT 指向的檔案不存在或無法讀取"
[[ "$repo" =~ ^[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)*$ ]] \
  || die "LM_REGISTRY_REPO 不是合法的 repository 名稱"
if [[ -n "$ref" ]]; then
  [[ "$ref" =~ ^sha256:[0-9a-f]{64}$ || "$ref" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$ ]] \
    || die "LM_REGISTRY_REF 必須為標籤或 sha256:<64 hex> digest"
fi

for name in LM_REGISTRY_PULL_USER LM_REGISTRY_PUSH_USER; do
  [[ "${!name}" =~ ^[A-Za-z0-9._-]+$ ]] || die "${name} 只能包含英數字與 . _ -"
done
for name in LM_REGISTRY_PULL_PASSWORD LM_REGISTRY_PUSH_PASSWORD; do
  [[ "${!name}" != *$'\n'* && "${!name}" != *$'\r'* ]] || die "${name} 不得包含換行字元"
done
[[ "$LM_REGISTRY_PULL_USER" != "$LM_REGISTRY_PUSH_USER" ]] \
  || die "LM_REGISTRY_PULL_USER 與 LM_REGISTRY_PUSH_USER 不得為同一帳號"
command -v "$CURL_BIN" >/dev/null 2>&1 || die "找不到 curl（CURL_BIN=${CURL_BIN}）"

work="$(mktemp -d "${TMPDIR:-/tmp}/lm-verify-registry.XXXXXXXX")"
chmod 0700 "$work"
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

random_hex() {
  # $1 = 位元組數；輸出 2*$1 個小寫十六進位字元（非秘密，只用於產生不存在的探測目標）。
  od -An -N "$1" -tx1 /dev/urandom | tr -d ' \n'
}

# curl 設定檔的雙引號字串中，反斜線與雙引號需跳脫；printf 為 bash 內建，不產生子行程參數。
curl_quote() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

write_credentials() {
  # $1 = 設定檔名稱，$2 = 帳號，$3 = 密碼
  local file="$work/$1.cfg"
  : >"$file"
  chmod 0600 "$file"
  printf 'user = "%s:%s"\n' "$(curl_quote "$2")" "$(curl_quote "$3")" >"$file"
}

write_credentials pull "$LM_REGISTRY_PULL_USER" "$LM_REGISTRY_PULL_PASSWORD"
write_credentials push "$LM_REGISTRY_PUSH_USER" "$LM_REGISTRY_PUSH_PASSWORD"
write_credentials badpass "$LM_REGISTRY_PULL_USER" "lm-verify-wrong-$(random_hex 24)"

probe_digest="sha256:$(random_hex 32)"
probe_tag="lm-verify-probe-$(random_hex 8)"
probe_upload="lm-verify-upload-$(random_hex 16)"
printf '{}' >"$work/probe-manifest.json"

curl_base=(
  -q --silent --show-error
  --cacert "$LM_REGISTRY_CA_CERT"
  --proto '=https' --tlsv1.2
  --noproxy '*'
  --connect-timeout 10 --max-time 30
)

pass_count=0
fail_count=0
skip_count=0
HTTP_STATUS=""
CURL_RC=0

pass() { pass_count=$((pass_count + 1)); printf 'PASS  %s（%s）\n' "$1" "$2"; }
fail() { fail_count=$((fail_count + 1)); printf 'FAIL  %s（%s）\n' "$1" "$2"; }
skip() { skip_count=$((skip_count + 1)); printf 'SKIP  %s（%s）\n' "$1" "$2"; }

# request <none|pull|push|badpass> <METHOD> <path> [額外 curl 參數…]
# 結果：HTTP_STATUS、CURL_RC，回應標頭與內容分別在 $work/headers、$work/body。
request() {
  local cred="$1" method="$2" path="$3"
  shift 3
  local args=("${curl_base[@]}" -o "$work/body" -D "$work/headers" -w '%{http_code}')
  if [[ "$cred" != none ]]; then
    args+=(-K "$work/$cred.cfg")
  fi
  if [[ "$method" == HEAD ]]; then
    args+=(--head)
  else
    args+=(-X "$method")
  fi
  args+=("$@" "${registry_url}${path}")
  : >"$work/body"
  : >"$work/headers"
  : >"$work/stderr"
  CURL_RC=0
  HTTP_STATUS="$("$CURL_BIN" "${args[@]}" 2>"$work/stderr")" || CURL_RC=$?
}

# check <檢查名稱> "<允許的狀態碼，以空白分隔>"；回傳 0 表示 PASS。
check() {
  local name="$1" allowed="$2" code
  if ((CURL_RC != 0)); then
    fail "$name" "curl 結束碼 ${CURL_RC}：$(head -c 300 "$work/stderr" | tr -d '\r' | tr '\n' ' ')"
    return 1
  fi
  for code in $allowed; do
    if [[ "$HTTP_STATUS" == "$code" ]]; then
      pass "$name" "HTTP ${HTTP_STATUS}"
      return 0
    fi
  done
  fail "$name" "HTTP ${HTTP_STATUS:-無}，預期 ${allowed// //}"
  return 1
}

header_value() {
  # 輸出指定回應標頭的值（不分大小寫，取最後一個），找不到時為空字串。
  awk -v want="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" '
    {
      line = $0
      sub(/\r$/, "", line)
      i = index(line, ":")
      if (i > 0 && tolower(substr(line, 1, i - 1)) == want) {
        v = substr(line, i + 1)
        sub(/^[ \t]+/, "", v)
        found = v
      }
    }
    END { if (found != "") print found }
  ' "$work/headers"
}

manifest_accept=(
  -H 'Accept: application/vnd.oci.image.index.v1+json'
  -H 'Accept: application/vnd.oci.image.manifest.v1+json'
  -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json'
  -H 'Accept: application/vnd.docker.distribution.manifest.v2+json'
)

echo "Registry 存取控制驗證：${registry_url}（repository ${repo}）"

# --- 1. 未認證與錯誤密碼 ---------------------------------------------------------
request none GET /v2/
if check "未認證 GET /v2/ 被拒" "401"; then
  if [[ "$(header_value WWW-Authenticate)" =~ ^[Bb]asic ]]; then
    pass "未認證回應要求 Basic 認證" "WWW-Authenticate: Basic"
  else
    fail "未認證回應要求 Basic 認證" "缺少 WWW-Authenticate: Basic 標頭"
  fi
fi

request none GET "/v2/${repo}/tags/list"
check "未認證 GET tags/list 被拒" "401" || true

request none PUT "/v2/${repo}/manifests/${probe_tag}" \
  -H 'Content-Type: application/vnd.oci.image.manifest.v1+json' \
  --data-binary "@$work/probe-manifest.json"
check "未認證 PUT manifest 被拒" "401 403" || true

request none DELETE "/v2/${repo}/manifests/${probe_digest}"
check "未認證 DELETE manifest 被拒" "401 403 405" || true

request badpass GET /v2/
check "拉取帳號以錯誤密碼 GET /v2/ 被拒" "401" || true

# --- 2. 拉取帳號可讀取 -----------------------------------------------------------
request pull GET /v2/
if check "拉取帳號 GET /v2/ 成功" "200"; then
  if [[ "$(header_value Docker-Distribution-API-Version)" == "registry/2.0" ]]; then
    pass "回應來自 Distribution registry" "Docker-Distribution-API-Version: registry/2.0"
  else
    fail "回應來自 Distribution registry" "缺少 Docker-Distribution-API-Version: registry/2.0 標頭"
  fi
fi

# 404 NAME_UNKNOWN 表示 repository 尚無映像，但讀取已被允許（非 401／403）。
request pull GET "/v2/${repo}/tags/list"
check "拉取帳號 GET tags/list 允許" "200 404" || true

if [[ -n "$ref" ]]; then
  request pull HEAD "/v2/${repo}/manifests/${ref}" "${manifest_accept[@]}"
  check "拉取帳號 HEAD manifest ${ref} 成功" "200" || true
  request pull GET "/v2/${repo}/manifests/${ref}" "${manifest_accept[@]}"
  check "拉取帳號 GET manifest ${ref} 成功" "200" || true
else
  skip "拉取帳號 HEAD manifest" "未設定 LM_REGISTRY_REF"
  skip "拉取帳號 GET manifest" "未設定 LM_REGISTRY_REF"
fi

# --- 3. 拉取帳號不可寫入或刪除 ---------------------------------------------------
request pull POST "/v2/${repo}/blobs/uploads/" --data-binary ''
check "拉取帳號 POST blobs/uploads 被拒" "401 403" || true

request pull PATCH "/v2/${repo}/blobs/uploads/${probe_upload}" \
  -H 'Content-Type: application/octet-stream' --data-binary ''
check "拉取帳號 PATCH blobs/uploads 被拒" "401 403" || true

request pull PUT "/v2/${repo}/blobs/uploads/${probe_upload}?digest=${probe_digest}" \
  -H 'Content-Type: application/octet-stream' --data-binary ''
check "拉取帳號 PUT blobs/uploads 被拒" "401 403" || true

request pull PUT "/v2/${repo}/manifests/${probe_tag}" \
  -H 'Content-Type: application/vnd.oci.image.manifest.v1+json' \
  --data-binary "@$work/probe-manifest.json"
check "拉取帳號 PUT manifest 被拒" "401 403" || true

request pull DELETE "/v2/${repo}/manifests/${probe_digest}"
check "拉取帳號 DELETE manifest 被拒" "401 403 405" || true

request pull DELETE "/v2/${repo}/blobs/${probe_digest}"
check "拉取帳號 DELETE blob 被拒" "401 403 405" || true

# --- 4. 刪除 API 已關閉（以有效的推送帳號驗證） ----------------------------------
request push GET /v2/
push_ok=0
check "推送帳號 GET /v2/ 成功（認證有效）" "200" && push_ok=1

expect_delete_disabled() {
  local name="$1"
  if ! check "$name" "405"; then
    if ((CURL_RC == 0)) && [[ "$HTTP_STATUS" == "404" ]]; then
      echo "      404 表示 Registry 嘗試查詢刪除目標，刪除 API 可能已開啟（config.yml storage.delete.enabled）"
    fi
    return 0
  fi
  if grep -q -e 'deletion is disabled' -e 'UNSUPPORTED' "$work/body"; then
    pass "${name}：回應內容" "deletion is disabled／UNSUPPORTED"
  else
    fail "${name}：回應內容" "405 回應不含 deletion is disabled 或 UNSUPPORTED"
  fi
}

if ((push_ok == 1)); then
  request push DELETE "/v2/${repo}/manifests/${probe_digest}"
  expect_delete_disabled "推送帳號 DELETE manifest（digest）回應 405"
  request push DELETE "/v2/${repo}/manifests/${probe_tag}"
  expect_delete_disabled "推送帳號 DELETE manifest（標籤）回應 405"
  request push DELETE "/v2/${repo}/blobs/${probe_digest}"
  expect_delete_disabled "推送帳號 DELETE blob 回應 405"
else
  fail "推送帳號 DELETE 刪除 API 已關閉" "推送帳號認證失敗，無法以有效憑證驗證"
fi

# --- 結果 -----------------------------------------------------------------------
echo "結果：PASS ${pass_count}、FAIL ${fail_count}、SKIP ${skip_count}"
if ((fail_count > 0)); then
  exit 1
fi
exit 0
