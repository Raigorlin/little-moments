#!/usr/bin/env bash
# 映像層級 Smoke 測試（Requirement 16.2、18.3；design.md Components §11、§14；tasks 12.3）。
#
# 以剛建置的 App_Image 連線本次建置專用的 Ephemeral_Database，執行映像內的 Migration_Runner
# （/app/server/migrate.js），再以映像的預設 ENTRYPOINT（/app/server/serve.js）啟動 App_Server，
# 最後執行 scripts/smoke.mjs，驗證「打包後」的伺服器行為，而非 repository 原始碼。
#
# 用法（於 repository 根目錄、CI Agent 上執行；通常緊接在 ci/scripts/build-image.sh 之後）：
#   bash ci/scripts/image-smoke.sh --image <ref> --postgres-image <repo>@sha256:<digest> \
#     [--runner-image <ref>] [--reports <目錄>] [--label <建置標籤>]
#
#   --image           受測 App_Image（例如 reports/image-ref.txt 的 `<repo>:<40 字元 SHA>` 或 `<repo>@sha256:...`）
#   --postgres-image  Ephemeral_Database 映像，必須以 @sha256: digest 固定；也可由 LM_POSTGRES_IMAGE 提供
#   --runner-image    執行 smoke／輔助腳本的映像（需含 bun），預設為受測 App_Image 本身
#   --reports         報告目錄，預設 reports
#   --label           建置標籤，預設 $BUILD_TAG（Jenkins）或 local；用於容器／網路名稱與 Docker label
#
# 隔離與清理：
#   * 所有容器只連接本次建立的 `docker network create --internal` 網路，不發布任何連接埠（無 -p），
#     因此 App 在容器內綁定 0.0.0.0 也無法從 Agent 主機或 LAN 連線；smoke 由同一網路內的 runner 容器執行。
#   * 容器、網路皆帶 `lm.ci.image-smoke=<run id>` 與 `lm.ci.build=<label>` label；PGDATA 使用 tmpfs，
#     不建立任何卷。`trap` 於結束（含失敗、INT、TERM）時依 label 移除容器並刪除網路。
#   * 腳本與輔助檔以 `docker cp` 複製進 runner 容器，不使用 bind mount（Agent 以 docker-outside-of-docker
#     執行時工作目錄路徑不一定存在於 Docker 主機）。
#
# 憑證：Ephemeral_Database 密碼、Setup_Token 與合成帳號密碼皆於每次執行時由 /dev/urandom 產生，
# 只存在於 0700 暫存目錄內的 0600 env 檔（由 docker CLI 以 --env-file 讀取，不出現在命令列參數），
# 結束時刪除；不需要也不讀取任何 Credential_Store 憑證，且不輸出任何秘密值。合成帳號與 smoke-fixture
# 行程由 ci/scripts/image-smoke-seed.mjs 經 App 的 HTTP API（/api/setup、/api/trips）建立，只存在於
# 本次的 Ephemeral_Database。
#
# 報告（<reports>/）：
#   image-smoke-migrate.log   Migration_Runner 輸出（已由 migrate.js 遮蔽密碼）
#   image-smoke-health.json   啟動後 120 秒內連續 3 次 Health_Check 的結果
#   image-smoke-seed.json     合成資料建立步驟（狀態碼與耗時）
#   image-smoke.json          scripts/smoke.mjs 的 JSON 輸出
#   image-smoke-app.log       App 容器日誌
#   image-smoke-db.log        失敗時的 Ephemeral_Database 日誌
#   image-smoke-summary.json  { image, label, result, stage, exitCode }
#
# 環境變數：DOCKER_BIN（預設 docker）；LM_POSTGRES_IMAGE（--postgres-image 的預設值）；BUILD_TAG。
# 結束碼：0 通過；1 Smoke_Test 失敗或逾時；2 參數或環境無效；3 Ephemeral_Database 120 秒內未就緒；
#         4 Migration_Runner 失敗；5 App 120 秒內未達成連續 3 次 Health_Check 成功；6 合成資料建立失敗；
#         7 Docker 操作失敗。

set -euo pipefail

DOCKER_BIN="${DOCKER_BIN:-docker}"

readonly DB_NAME="lm_smoke"
readonly DB_USER="lm_smoke"
readonly APP_PORT="5173"
readonly DB_READY_TIMEOUT_S=120
readonly MIGRATE_TIMEOUT_S=300
readonly HEALTH_TIMEOUT_S=180   # 輔助腳本本身限制 120 秒視窗；此值只是外層保護
readonly SEED_TIMEOUT_S=120
readonly SMOKE_TIMEOUT_S=600    # Req 18.3：Smoke_Test 於 10 分鐘內完成

usage() {
  echo "用法: $0 --image <ref> --postgres-image <repo>@sha256:<digest> [--runner-image <ref>] [--reports <dir>] [--label <tag>]" >&2
}

image=""
postgres_image="${LM_POSTGRES_IMAGE:-}"
runner_image=""
reports_dir="reports"
label="${BUILD_TAG:-local}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --image|--postgres-image|--runner-image|--reports|--label)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        usage
        echo "image-smoke: 缺少 $1 的值" >&2
        exit 2
      fi
      case "$1" in
        --image) image="$2" ;;
        --postgres-image) postgres_image="$2" ;;
        --runner-image) runner_image="$2" ;;
        --reports) reports_dir="$2" ;;
        --label) label="$2" ;;
      esac
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage; echo "image-smoke: 未知參數: $1" >&2; exit 2 ;;
  esac
done

# --- 參數驗證（在建立任何 Docker 資源前；失敗不需清理） --------------------------
# 映像參照：不得以 - 開頭（避免被當成 docker 選項），不得含空白、引號或 shell 特殊字元。
ref_re='^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$'
[[ "$image" =~ $ref_re ]] || { usage; echo "image-smoke: --image 為必填且格式無效" >&2; exit 2; }
[ -n "$runner_image" ] || runner_image="$image"
[[ "$runner_image" =~ $ref_re ]] || { echo "image-smoke: --runner-image 格式無效" >&2; exit 2; }
if ! [[ "$postgres_image" =~ $ref_re ]] || ! [[ "$postgres_image" =~ @sha256:[0-9a-f]{64}$ ]]; then
  echo "image-smoke: --postgres-image（或 LM_POSTGRES_IMAGE）必須以 @sha256:<64 hex> 固定" >&2
  exit 2
fi
for f in scripts/smoke.mjs ci/health.mjs ci/scripts/image-smoke-seed.mjs server/http.js server/config.js; do
  [ -f "$f" ] || { echo "image-smoke: 需於 repository 根目錄執行（找不到 $f）" >&2; exit 2; }
done
command -v "$DOCKER_BIN" >/dev/null 2>&1 || { echo "image-smoke: 找不到 docker CLI（DOCKER_BIN）" >&2; exit 2; }
[ -r /dev/urandom ] || { echo "image-smoke: 無法讀取 /dev/urandom" >&2; exit 2; }

random_hex() {
  od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
}

# 名稱同時作為 Docker 名稱與網路內的 DNS 名稱（App 的 Allowed_Hosts）：只用小寫英數字與連字號，
# 以字母開頭，最長 63 字元（server/config.js 的主機名稱規則）。
safe_label="$(printf '%s' "$label" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9-' '-' | tr -s '-' | cut -c1-32)"
safe_label="${safe_label#-}"
safe_label="${safe_label%-}"
[ -n "$safe_label" ] || safe_label="build"
run_id="lm-ismoke-${safe_label}-$(random_hex 4)"
net="${run_id}-net"
db="${run_id}-db"
app="${run_id}-app"
base_url="http://${app}:${APP_PORT}"

# lm.ci.build 使用完整的建置標籤（$BUILD_TAG，不截斷）：Jenkinsfile 收尾以 `label=lm.ci.build=$BUILD_TAG`
# 清除本建置的所有容器與網路；截斷後的名稱可能與其他建置相同，不可作為清除依據。
labels=(--label "lm.ci.image-smoke=${run_id}" --label "lm.ci.build=${label}")
# 與 deploy/compose/compose.yaml 的 x-hardening 相同（App 與 runner）；資料庫容器的 entrypoint 需要
# chown／切換使用者，因此只加 no-new-privileges。
hardening=(--cap-drop ALL --security-opt no-new-privileges:true)
db_env=(-e "CAMPING_DATABASE_HOST=${db}" -e "CAMPING_DATABASE_PORT=5432" -e "CAMPING_DATABASE_NAME=${DB_NAME}"
        -e "CAMPING_DATABASE_USER=${DB_USER}" -e "CAMPING_DATABASE_SSLMODE=disable")

mkdir -p "$reports_dir"
summary_file="${reports_dir}/image-smoke-summary.json"
stage="init"
net_created=0
db_started=0
app_started=0
passed=0
tmp_dir=""

die() {
  local code="$1"
  shift
  echo "image-smoke: $*" >&2
  exit "$code"
}

run_timeout() {
  local limit="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout --kill-after=10 "$limit" "$@"
  else
    "$@"
  fi
}

cleanup() {
  local status=$?
  set +e
  trap - EXIT INT TERM
  if [ "$app_started" -eq 1 ]; then
    "$DOCKER_BIN" logs "$app" > "${reports_dir}/image-smoke-app.log" 2>&1
  fi
  if [ "$status" -ne 0 ] && [ "$db_started" -eq 1 ]; then
    "$DOCKER_BIN" logs "$db" > "${reports_dir}/image-smoke-db.log" 2>&1
  fi
  local ids id
  ids="$("$DOCKER_BIN" ps -aq --filter "label=lm.ci.image-smoke=${run_id}" 2>/dev/null)"
  for id in $ids; do
    "$DOCKER_BIN" rm -fv "$id" >/dev/null 2>&1
  done
  if [ "$net_created" -eq 1 ]; then
    "$DOCKER_BIN" network rm "$net" >/dev/null 2>&1 \
      || echo "image-smoke: 警告：無法刪除網路 ${net}" >&2
  fi
  if [ -n "$tmp_dir" ] && [ -d "$tmp_dir" ]; then
    rm -rf -- "$tmp_dir"
  fi
  local result="fail"
  [ "$status" -eq 0 ] && [ "$passed" -eq 1 ] && result="pass"
  printf '{"image":"%s","label":"%s","result":"%s","stage":"%s","exitCode":%d}\n' \
    "$image" "$safe_label" "$result" "$stage" "$status" > "$summary_file"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- 秘密與 runner 檔案（暫存目錄 0700、env 檔 0600） ------------------------------
tmp_dir="$(mktemp -d)"
chmod 0700 "$tmp_dir"
env_dir="${tmp_dir}/env"
stage_dir="${tmp_dir}/stage"
mkdir -m 0700 "$env_dir"
(
  umask 077
  db_password="$(random_hex 24)"
  setup_token="$(random_hex 24)"      # 48 字元，滿足 Setup_Token 至少 32 字元
  smoke_password="$(random_hex 24)"   # 48 字元，滿足密碼 12–128 字元
  printf 'POSTGRES_PASSWORD=%s\n' "$db_password" > "${env_dir}/db.env"
  printf 'CAMPING_DATABASE_PASSWORD=%s\n' "$db_password" > "${env_dir}/db-client.env"
  printf 'CAMPING_SETUP_TOKEN=%s\n' "$setup_token" > "${env_dir}/setup.env"
  printf 'CAMPING_SMOKE_PASSWORD=%s\nCAMPING_SETUP_TOKEN=%s\n' "$smoke_password" "$setup_token" > "${env_dir}/seed.env"
  printf 'CAMPING_SMOKE_PASSWORD=%s\n' "$smoke_password" > "${env_dir}/smoke.env"
)

# runner 只需要 smoke.mjs、其匯入的 server/ 模組、ci/health.mjs 與輔助腳本；不含任何秘密。
mkdir -p "${stage_dir}/scripts" "${stage_dir}/ci/scripts"
cp scripts/smoke.mjs "${stage_dir}/scripts/"
cp -R server "${stage_dir}/server"
cp ci/health.mjs "${stage_dir}/ci/"
cp ci/scripts/image-smoke-seed.mjs "${stage_dir}/ci/scripts/"
find "$stage_dir" -type d -exec chmod 0755 {} +
find "$stage_dir" -type f -exec chmod 0644 {} +

# 在 runner 容器內以 bun 執行一個工具；stdout 原樣輸出（由呼叫端導向報告檔），回傳容器結束碼。
# 參數：<名稱> <逾時秒數> <env 檔或空字串> <bun 參數...>
run_tool() {
  local name="$1" limit="$2" env_file="$3"
  shift 3
  local cname="${run_id}-${name}"
  local env_args=()
  if [ -n "$env_file" ]; then
    env_args=(--env-file "$env_file")
  fi
  "$DOCKER_BIN" create --name "$cname" --network "$net" "${labels[@]}" "${hardening[@]}" \
      --tmpfs /tmp:rw,nosuid,nodev,size=64m -e HOME=/tmp \
      -e "CAMPING_SMOKE_BASE_URL=${base_url}" ${env_args[@]+"${env_args[@]}"} \
      --workdir /smoke --entrypoint bun "$runner_image" "$@" >/dev/null || return 125
  "$DOCKER_BIN" cp "${stage_dir}/." "${cname}:/smoke" >/dev/null || return 125
  local rc=0
  run_timeout "$limit" "$DOCKER_BIN" start -a "$cname" || rc=$?
  "$DOCKER_BIN" rm -fv "$cname" >/dev/null 2>&1 || true
  return "$rc"
}

echo "image-smoke: 受測映像 ${image}（run ${run_id}）"

# --- 1. 隔離網路 --------------------------------------------------------------
stage="network"
"$DOCKER_BIN" network create --internal "${labels[@]}" "$net" >/dev/null \
  || die 7 "無法建立 internal 網路"
net_created=1

# --- 2. Ephemeral_Database ----------------------------------------------------
stage="database"
"$DOCKER_BIN" run -d --name "$db" --network "$net" "${labels[@]}" \
    --security-opt no-new-privileges:true \
    --env-file "${env_dir}/db.env" \
    -e "POSTGRES_USER=${DB_USER}" -e "POSTGRES_DB=${DB_NAME}" \
    -e "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256" \
    -e "PGDATA=/var/lib/postgresql/data/pgdata" \
    --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=512m \
    --shm-size 128m \
    "$postgres_image" >/dev/null \
  || die 7 "無法啟動 Ephemeral_Database 容器"
db_started=1

# 以 TCP 檢查：docker-entrypoint 初始化期間的暫時伺服器不監聽 TCP，因此成功即代表正式啟動完成。
deadline=$((SECONDS + DB_READY_TIMEOUT_S))
until "$DOCKER_BIN" exec "$db" pg_isready -q -h 127.0.0.1 -p 5432 -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; do
  running="$("$DOCKER_BIN" inspect -f '{{.State.Running}}' "$db" 2>/dev/null || echo false)"
  [ "$running" = "true" ] || die 3 "Ephemeral_Database 容器已停止"
  [ "$SECONDS" -lt "$deadline" ] || die 3 "Ephemeral_Database 未於 ${DB_READY_TIMEOUT_S} 秒內就緒"
  sleep 2
done
echo "image-smoke: Ephemeral_Database 就緒"

# --- 3. 映像內的 Migration_Runner --------------------------------------------
stage="migrate"
migrate_rc=0
run_timeout "$MIGRATE_TIMEOUT_S" "$DOCKER_BIN" run --rm --name "${run_id}-migrate" --network "$net" "${labels[@]}" \
    "${hardening[@]}" --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
    --env-file "${env_dir}/db-client.env" "${db_env[@]}" \
    --entrypoint bun "$image" /app/server/migrate.js \
    > "${reports_dir}/image-smoke-migrate.log" 2>&1 || migrate_rc=$?
[ "$migrate_rc" -eq 0 ] || die 4 "Migration_Runner 失敗（結束碼 ${migrate_rc}），詳見 ${reports_dir}/image-smoke-migrate.log"
echo "image-smoke: 遷移完成"

# --- 4. 以映像預設 ENTRYPOINT 啟動 App_Server ----------------------------------
# 綁定 0.0.0.0 僅在容器的網路命名空間內；網路為 --internal 且未發布連接埠。
stage="app"
"$DOCKER_BIN" run -d --name "$app" --network "$net" "${labels[@]}" \
    "${hardening[@]}" --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
    --env-file "${env_dir}/db-client.env" --env-file "${env_dir}/setup.env" "${db_env[@]}" \
    -e "CAMPING_BIND_ADDRESS=0.0.0.0" -e "PORT=${APP_PORT}" -e "CAMPING_ALLOWED_HOSTS=${app}" \
    "$image" >/dev/null \
  || die 7 "無法啟動 App 容器"
app_started=1

stage="health"
health_rc=0
run_tool health "$HEALTH_TIMEOUT_S" "" ci/scripts/image-smoke-seed.mjs wait-healthy \
  > "${reports_dir}/image-smoke-health.json" || health_rc=$?
case "$health_rc" in
  0) echo "image-smoke: Health_Check 連續 3 次成功" ;;
  125) die 7 "無法建立 runner 容器" ;;
  *) die 5 "App 未於 120 秒內達成連續 3 次 Health_Check 成功（結束碼 ${health_rc}）" ;;
esac

# --- 5. 合成資料（只存在於 Ephemeral_Database） --------------------------------
stage="seed"
seed_rc=0
run_tool seed "$SEED_TIMEOUT_S" "${env_dir}/seed.env" ci/scripts/image-smoke-seed.mjs seed \
  > "${reports_dir}/image-smoke-seed.json" || seed_rc=$?
case "$seed_rc" in
  0) echo "image-smoke: 合成帳號與 smoke-fixture 行程已建立" ;;
  125) die 7 "無法建立 runner 容器" ;;
  *) die 6 "合成資料建立失敗（結束碼 ${seed_rc}），詳見 ${reports_dir}/image-smoke-seed.json" ;;
esac

# --- 6. Smoke_Test -------------------------------------------------------------
stage="smoke"
smoke_rc=0
run_tool smoke "$SMOKE_TIMEOUT_S" "${env_dir}/smoke.env" scripts/smoke.mjs \
  > "${reports_dir}/image-smoke.json" || smoke_rc=$?
case "$smoke_rc" in
  0) ;;
  1) die 1 "Smoke_Test 失敗，詳見 ${reports_dir}/image-smoke.json" ;;
  124|137) die 1 "Smoke_Test 未於 ${SMOKE_TIMEOUT_S} 秒內完成" ;;
  125) die 7 "無法建立 runner 容器" ;;
  *) die 2 "Smoke_Test 設定或執行錯誤（結束碼 ${smoke_rc}）" ;;
esac

# App 在整個 smoke 期間須持續運作（未崩潰重啟）。
running="$("$DOCKER_BIN" inspect -f '{{.State.Running}}' "$app" 2>/dev/null || echo false)"
[ "$running" = "true" ] || die 1 "App 容器於 Smoke_Test 期間停止"

stage="done"
passed=1
echo "image-smoke: 通過 ${image}"
