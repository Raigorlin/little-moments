#!/usr/bin/env bash
# 將 Pipeline 使用的第三方工具映像鏡像至 LAN Registry（Requirement 6、7、17；design.md「工具選型」）。
#
# 用法（於可連線上游 Registry 與 LAN Registry、具 docker 權限的主機執行）：
#   LM_REGISTRY=registry.our-littlemoments.com:8443 LM_PUSH_PASSWORD_FILE=<file> ./mirror.sh
#
#   LM_REGISTRY            LAN Registry 的 <主機名稱>:<連接埠>（不含 https:// 與路徑）
#   LM_PUSH_PASSWORD_FILE  lm-push 帳號密碼檔（只含密碼；建議 0600）
#
# 對 mirror.list 的每一行「<上游映像:tag> <名稱>」：
#   crane copy --platform linux/amd64 <上游> <LM_REGISTRY>/little-moments/mirror/<名稱>:<上游 tag>
# 完成後於 stdout 輸出 `<LM_REGISTRY>/little-moments/mirror/<名稱>@sha256:<digest>`，供貼入 Jenkinsfile 的
# LM_*_IMAGE；進度訊息一律寫到 stderr。任一映像失敗時於 stdout 輸出 `FAILED <上游映像>`，繼續處理其餘映像，
# 最後以非零結束碼結束。最後另複製 Trivy 漏洞資料庫 mirror.gcr.io/aquasec/trivy-db:2（以 tag 引用，
# Registry 主機的 lm-mirror-trivy-db.timer 每日更新）。
#
# 密碼處理：密碼只經 stdin 交給 `docker login --password-stdin`，不出現在命令列、環境變數或輸出中。
# 登入資訊只寫入本次執行的 mktemp 暫存目錄（umask 077），結束（含中斷）時由 trap 刪除；不使用、
# 也不修改 ~/.docker/config.json。crane 容器以目前使用者執行，唯讀掛載該目錄與系統 CA bundle
# （須含 LAN Registry 的內部 CA）。
#
# crane 本身以上游 tag 執行（gcr.io/go-containerregistry/crane:v0.22.1）：本腳本負責建立鏡像，
# 無法依賴尚未鏡像的 LAN 映像。
set -euo pipefail
umask 077

CRANE_IMAGE=gcr.io/go-containerregistry/crane:v0.22.1
CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

die() {
  printf '%s\n' "$*" >&2
  exit 2
}

LM_REGISTRY="${LM_REGISTRY:-}"
LM_PUSH_PASSWORD_FILE="${LM_PUSH_PASSWORD_FILE:-}"
[[ -n "$LM_REGISTRY" ]] || die "LM_REGISTRY 未設定（例如 registry.our-littlemoments.com:8443）"
[[ "$LM_REGISTRY" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$ ]] \
  || die "LM_REGISTRY 必須為 <主機名稱>[:<連接埠>]，不得含 scheme 或路徑"
[[ -n "$LM_PUSH_PASSWORD_FILE" ]] || die "LM_PUSH_PASSWORD_FILE 未設定"
[[ -f "$LM_PUSH_PASSWORD_FILE" && -r "$LM_PUSH_PASSWORD_FILE" ]] \
  || die "LM_PUSH_PASSWORD_FILE 指向的檔案不存在或無法讀取"
[[ -r "$CA_BUNDLE" ]] || die "找不到系統 CA bundle：$CA_BUNDLE"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
list="$here/mirror.list"
[[ -f "$list" && -r "$list" ]] || die "找不到 $list"

d="$(mktemp -d)"
trap 'rm -rf "$d"' EXIT
export DOCKER_CONFIG="$d"

echo "以 lm-push 登入 $LM_REGISTRY" >&2
docker login -u lm-push --password-stdin "$LM_REGISTRY" < "$LM_PUSH_PASSWORD_FILE" >&2

# 不加 -i：docker 不讀取 stdin。清單另以 fd 3 讀取，迴圈內的命令不會吃掉清單內容。
crane() {
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e DOCKER_CONFIG=/cfg \
    -v "$d:/cfg:ro" -v "$CA_BUNDLE:$CA_BUNDLE:ro" \
    "$CRANE_IMAGE" "$@"
}

rc=0
while read -r src name extra <&3 || [[ -n "${src:-}" ]]; do
  src="${src%$'\r'}"
  name="${name%$'\r'}"
  extra="${extra%$'\r'}"
  [[ -z "$src" || "$src" == \#* ]] && continue
  tag="${src##*:}"
  if [[ -z "$name" || -n "$extra" || "$tag" == "$src" ]] \
    || ! [[ "$name" =~ ^[a-z0-9][a-z0-9._-]*$ ]] \
    || ! [[ "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$ ]]; then
    echo "mirror.list 格式錯誤：$src ${name:-}" >&2
    printf 'FAILED %s\n' "$src"
    rc=1
    continue
  fi
  dst="$LM_REGISTRY/little-moments/mirror/$name:$tag"
  echo "複製 $src → $dst（linux/amd64）" >&2
  digest=""
  if crane copy --platform linux/amd64 "$src" "$dst" >&2 \
    && digest="$(crane digest "$dst")" \
    && [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    printf '%s\n' "$LM_REGISTRY/little-moments/mirror/$name@$digest"
  else
    printf 'FAILED %s\n' "$src"
    rc=1
  fi
done 3< "$list"

trivy_db_src=mirror.gcr.io/aquasec/trivy-db:2
trivy_db_dst="$LM_REGISTRY/little-moments/mirror/trivy-db:2"
echo "複製 $trivy_db_src → $trivy_db_dst" >&2
if ! crane copy "$trivy_db_src" "$trivy_db_dst" >&2; then
  printf 'FAILED %s\n' "$trivy_db_src"
  rc=1
fi

exit "$rc"
