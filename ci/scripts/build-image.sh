#!/usr/bin/env bash
# App_Image 建置與映像內容檢查（Requirement 16.1、16.5、16.6、16.8、16.9；design.md Components §11）。
#
# 用法（於 repository 根目錄、Trusted Agent 上執行；只在 `main` 建置的「QA」與「安全」關卡通過後呼叫）：
#   ci/scripts/build-image.sh --commit <40 字元 SHA> --repo <registry>/<name> \
#     [--created <ISO 8601>] [--reports <目錄>] [--context <目錄>] [--dockerfile <路徑>]
#
# 步驟：
#   1. `bun ci/image-labels.mjs` 產生 OCI 標籤（REVISION／VERSION／CREATED build args，Req 16.5）。
#   2. `docker build`，本機標籤為 `<repo>:<完整 40 字元 SHA>`（Req 16.6）；建置日誌一律寫入
#      `<reports>/image-build.log`，失敗時保留（Req 16.8）。
#   3. `docker image inspect` → `<reports>/image-inspect.json`；`docker create` + `docker export | tar -t`
#      → `<reports>/image-files.txt`；交給 `ci/image-content-check.mjs`，結果寫入
#      `<reports>/image-content.json`（Req 16.9）。
#
# 本腳本不推送映像、不登入 Registry、不使用任何憑證：推送、digest 比對與簽章屬於 Pipeline 的
# 推送階段（tasks 13.5），只在該階段的 `withCredentials` 區塊內進行。Registry 的 Image_Digest 只有
# 推送後才存在，因此此處只記錄本機 image ID（`<reports>/image-id.txt`）。
#
# 環境變數：DOCKER_BIN（預設 docker）、BUN_BIN（預設 bun）——供測試以 shim 取代。
# 結束碼：0 通過；1 映像內容檢查違規；2 參數無效；3 映像建置失敗；4 檢查所需資料無法取得。

set -euo pipefail

DOCKER_BIN="${DOCKER_BIN:-docker}"
BUN_BIN="${BUN_BIN:-bun}"

usage() {
  echo "用法: $0 --commit <40 hex> --repo <registry>/<name> [--created <ISO 8601>] [--reports <dir>] [--context <dir>] [--dockerfile <path>]" >&2
}

die() {
  local code="$1"
  shift
  echo "build-image: $*" >&2
  exit "$code"
}

commit=""
repo=""
created=""
reports_dir="reports"
context_dir="."
dockerfile="Dockerfile"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --commit|--repo|--created|--reports|--context|--dockerfile)
      [ "$#" -ge 2 ] || { usage; die 2 "缺少 $1 的值"; }
      case "$1" in
        --commit) commit="$2" ;;
        --repo) repo="$2" ;;
        --created) created="$2" ;;
        --reports) reports_dir="$2" ;;
        --context) context_dir="$2" ;;
        --dockerfile) dockerfile="$2" ;;
      esac
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die 2 "未知參數: $1" ;;
  esac
done

# --- 參數驗證 ---------------------------------------------------------------
if ! [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  die 2 "--commit 必須為 40 字元小寫十六進位 SHA"
fi

# Repository 名稱：選用的 registry 主機（含連接埠）+ 一或多段小寫路徑；不得含標籤、digest 或認證資訊。
repo_host='[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:[0-9]{1,5})?'
if [ -z "$repo" ] || [ "${#repo}" -gt 255 ]; then
  die 2 "--repo 為必填且長度不得超過 255 字元"
fi
case "$repo" in
  *@*|*://*|*' '*|*/|/*|*//*) die 2 "--repo 格式無效（不得含 @、協定、空白或空路徑段）" ;;
esac
repo_path="$repo"
first="${repo%%/*}"
if [ "$first" != "$repo" ] && { [[ "$first" == *.* ]] || [[ "$first" == *:* ]] || [ "$first" = "localhost" ]; }; then
  [[ "$first" =~ ^${repo_host}$ ]] || die 2 "--repo 的 registry 主機格式無效"
  repo_path="${repo#*/}"
fi
IFS='/' read -r -a repo_segments <<< "$repo_path"
for segment in "${repo_segments[@]}"; do
  # 每段須符合 Docker reference 的路徑元件規則（小寫英數字，以 . _ __ - 分隔）。
  if ! [[ "$segment" =~ ^[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*$ ]]; then
    die 2 "--repo 的路徑段無效（僅允許小寫英數字與 . _ -，且不得含標籤）"
  fi
done

[ -d "$context_dir" ] || die 2 "--context 目錄不存在"
[ -f "$dockerfile" ] || die 2 "--dockerfile 檔案不存在"
[ -f "package.json" ] || die 2 "需於 repository 根目錄執行（找不到 package.json）"

image_ref="${repo}:${commit}"
mkdir -p "$reports_dir"
build_log="${reports_dir}/image-build.log"
inspect_json="${reports_dir}/image-inspect.json"
files_list="${reports_dir}/image-files.txt"
content_json="${reports_dir}/image-content.json"
id_file="${reports_dir}/image-id.txt"
ref_file="${reports_dir}/image-ref.txt"

container_name="lm-content-check-${commit:0:12}-$$"
container_created=0
tmp_dir=""

cleanup() {
  if [ "$container_created" -eq 1 ]; then
    "$DOCKER_BIN" rm -f "$container_name" >/dev/null 2>&1 || true
  fi
  if [ -n "$tmp_dir" ] && [ -d "$tmp_dir" ]; then
    rm -rf -- "$tmp_dir"
  fi
}
trap cleanup EXIT

# --- 1. OCI 標籤 -------------------------------------------------------------
label_cmd=("$BUN_BIN" ci/image-labels.mjs --commit "$commit" --format env)
if [ -n "$created" ]; then
  label_cmd+=(--created "$created")
fi
label_output="$("${label_cmd[@]}")" || die 2 "OCI 標籤產生失敗"

build_args=()
seen_keys=""
while IFS= read -r line; do
  [ -n "$line" ] || continue
  key="${line%%=*}"
  case "$key" in
    REVISION|VERSION|CREATED) ;;
    *) die 2 "image-labels.mjs 輸出未預期的鍵" ;;
  esac
  build_args+=(--build-arg "$line")
  seen_keys="${seen_keys}${key} "
done <<< "$label_output"
for key in REVISION VERSION CREATED; do
  case " $seen_keys" in
    *" $key "*) ;;
    *) die 2 "image-labels.mjs 未輸出 ${key}" ;;
  esac
done

# --- 2. docker build ---------------------------------------------------------
echo "build-image: 建置 ${image_ref}"
: > "$build_log"
if ! DOCKER_BUILDKIT=1 "$DOCKER_BIN" build \
    --progress=plain \
    --file "$dockerfile" \
    --target runtime \
    "${build_args[@]}" \
    --tag "$image_ref" \
    "$context_dir" 2>&1 | tee "$build_log"; then
  die 3 "映像建置失敗，日誌保存於 ${build_log}；不推送任何映像或標籤"
fi

# --- 3. 映像內容檢查 ---------------------------------------------------------
"$DOCKER_BIN" image inspect "$image_ref" > "$inspect_json" \
  || die 4 "docker image inspect 失敗"
image_id="$("$DOCKER_BIN" image inspect --format '{{.Id}}' "$image_ref")" \
  || die 4 "無法取得 image ID"
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || die 4 "image ID 格式無效"
printf '%s\n' "$image_id" > "$id_file"
printf '%s\n' "$image_ref" > "$ref_file"

# docker create 不會啟動容器；只用來匯出檔案系統清單。
"$DOCKER_BIN" create --name "$container_name" "$image_ref" >/dev/null \
  || die 4 "docker create 失敗"
container_created=1

if ! "$DOCKER_BIN" export "$container_name" | tar -t > "$files_list"; then
  die 4 "無法匯出映像檔案清單"
fi
[ -s "$files_list" ] || die 4 "映像檔案清單為空"

# /etc/passwd 只用於解析非數字的 USER；取得失敗時不提供（檢查器會保守判定）。
tmp_dir="$(mktemp -d)"
chmod 0700 "$tmp_dir"
passwd_args=()
if "$DOCKER_BIN" cp "${container_name}:/etc/passwd" - 2>/dev/null | tar -xO > "${tmp_dir}/passwd" 2>/dev/null \
    && [ -s "${tmp_dir}/passwd" ]; then
  passwd_args=(--passwd "${tmp_dir}/passwd")
fi

check_status=0
"$BUN_BIN" ci/image-content-check.mjs \
  --files "$files_list" \
  --inspect "$inspect_json" \
  --package package.json \
  --app-root app \
  --out "$content_json" \
  ${passwd_args[@]+"${passwd_args[@]}"} || check_status=$?

case "$check_status" in
  0) echo "build-image: 映像內容檢查通過 ${image_ref} (${image_id})" ;;
  1) die 1 "映像內容檢查違規，詳見 ${content_json}；不推送映像" ;;
  *) die 4 "映像內容檢查無法執行（結束碼 ${check_status}）" ;;
esac
