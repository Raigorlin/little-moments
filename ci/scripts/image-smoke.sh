#!/usr/bin/env bash
# 映像層級 Smoke 測試（Rust 版 App_Image；plan.md D4、D15）。
#
# 以剛建置的 App_Image 與本次建置專用的 Ephemeral_Database（一般的 PostgreSQL）啟動 lm-server，驗證「打包後」的
# 映像：以映像的預設 ENTRYPOINT 與 USER 啟動、30 秒內連上 Database 並開始監聽、提供 trunk 的靜態檔，且 /app/migrations
# 與 repository 的 supabase/migrations/*.sql 相同。lm-server 啟動時只連線 Database，不呼叫 Supabase
# （crates/server/src/main.rs 的步驟 4 只建立 HTTP 用戶端），所以 SUPABASE_URL 指向不存在的 http://127.0.0.1:9；
# 需要 Auth／Realtime 的步驟由 Staging 的 Smoke_Test（ci/smoke.mjs）檢查。遷移不在這裡執行：supabase/migrations
# 需要 Supabase 的 auth schema 與角色，由 lm-deploy migrate 在 Deploy_Host 上套用（plan.md D7）。
#
# 用法（於 repository 根目錄、CI Agent 上執行；通常緊接在 ci/scripts/build-image.sh 之後）：
#   bash ci/scripts/image-smoke.sh --image <ref> --postgres-image <repo>@sha256:<digest> \
#     [--runner-image <ref>] [--reports <目錄>] [--label <建置標籤>]
#
#   --image           受測 App_Image（例如 reports/image-ref.txt 的 `<repo>:<40 字元 SHA>` 或 `<repo>@sha256:...`）
#   --postgres-image  Ephemeral_Database 映像，必須以 @sha256: digest 固定；也可由 LM_POSTGRES_IMAGE 提供
#   --runner-image    執行 HTTP 檢查的映像（需含 bun），預設為 $BUILD_IMAGE（Pipeline 的 Build_Image）；
#                     App_Image 是 distroless，沒有 shell 或 HTTP 用戶端，不能當 runner
#   --reports         報告目錄，預設 reports
#   --label           建置標籤，預設 $BUILD_TAG（Jenkins）或 local；用於容器／網路名稱與 Docker label
#
# 隔離與清理：
#   * 所有容器只連接本次建立的 `docker network create --internal` 網路，不發布任何連接埠（無 -p），
#     因此 App 在容器內綁定 0.0.0.0:8080 也無法從 Agent 主機或 LAN 連線；檢查由同一網路內的 runner 容器執行。
#   * 容器、網路皆帶 `lm.ci.image-smoke=<run id>` 與 `lm.ci.build=<label>` label；PGDATA 使用 tmpfs，
#     不建立任何卷。`trap` 於結束（含失敗、INT、TERM）時依 label 移除容器並刪除網路。
#   * 檢查腳本以 `docker cp` 複製進 runner 容器，/app/migrations 以 `docker cp` 自未啟動的容器取出；不使用
#     bind mount（Agent 以 docker-outside-of-docker 執行時工作目錄路徑不一定存在於 Docker 主機）。
#   * App 以映像的預設使用者（65532）、--read-only、--cap-drop ALL、no-new-privileges 執行。
#
# 憑證：Ephemeral_Database 密碼與 SUPABASE_ANON_KEY／SUPABASE_SERVICE_KEY（不連線使用的隨機值）皆於每次執行時由
# /dev/urandom 產生，只存在於 0700 暫存目錄內的 0600 env 檔（由 docker CLI 以 --env-file 讀取，不出現在命令列參數），
# 結束時刪除；不需要也不讀取任何 Credential_Store 憑證，且不輸出任何秘密值。
#
# 報告（<reports>/）：
#   image-smoke-migrate.log   /app/migrations 與 supabase/migrations/*.sql 的比對（檔名與 sha256）
#   image-smoke.json          HTTP 檢查的 JSON：{ok, steps:[{step,status,ms,result,reason?}]}
#   image-smoke-app.log       App 容器日誌
#   image-smoke-db.log        失敗時的 Ephemeral_Database 日誌
#   image-smoke-summary.json  { image, label, result, stage, exitCode }
#
# 環境變數：DOCKER_BIN（預設 docker）；LM_POSTGRES_IMAGE（--postgres-image 的預設值）；BUILD_IMAGE（--runner-image
# 的預設值）；BUILD_TAG。
# 結束碼：0 通過；1 HTTP 檢查失敗、逾時或 App 停止；2 參數或環境無效；3 Ephemeral_Database 120 秒內未就緒；
#         4 /app/migrations 與 supabase/migrations 不同；5 App 120 秒內未達成連續 3 次 Health_Check 成功；
#         7 Docker 操作失敗。

set -euo pipefail

DOCKER_BIN="${DOCKER_BIN:-docker}"

readonly DB_NAME="lm_smoke"
readonly DB_USER="lm_smoke"
readonly APP_PORT="8080"
readonly DB_READY_TIMEOUT_S=120
readonly CHECK_TIMEOUT_S=300    # 檢查腳本本身限制健康視窗 120 秒、每個請求 10 秒；此值只是外層保護

usage() {
  echo "用法: $0 --image <ref> --postgres-image <repo>@sha256:<digest> [--runner-image <ref>] [--reports <dir>] [--label <tag>]" >&2
}

image=""
postgres_image="${LM_POSTGRES_IMAGE:-}"
runner_image="${BUILD_IMAGE:-}"
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
[[ "$runner_image" =~ $ref_re ]] || { echo "image-smoke: --runner-image（或 BUILD_IMAGE）為必填且格式無效" >&2; exit 2; }
if ! [[ "$postgres_image" =~ $ref_re ]] || ! [[ "$postgres_image" =~ @sha256:[0-9a-f]{64}$ ]]; then
  echo "image-smoke: --postgres-image（或 LM_POSTGRES_IMAGE）必須以 @sha256:<64 hex> 固定" >&2
  exit 2
fi
shopt -s nullglob
repo_migrations=(supabase/migrations/*.sql)
shopt -u nullglob
[ "${#repo_migrations[@]}" -gt 0 ] || { echo "image-smoke: 需於 repository 根目錄執行（找不到 supabase/migrations/*.sql）" >&2; exit 2; }
command -v "$DOCKER_BIN" >/dev/null 2>&1 || { echo "image-smoke: 找不到 docker CLI（DOCKER_BIN）" >&2; exit 2; }
command -v sha256sum >/dev/null 2>&1 || { echo "image-smoke: 找不到 sha256sum" >&2; exit 2; }
[ -r /dev/urandom ] || { echo "image-smoke: 無法讀取 /dev/urandom" >&2; exit 2; }

random_hex() {
  od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
}

# 名稱同時作為 Docker 名稱與網路內的 DNS 名稱：只用小寫英數字與連字號，以字母開頭，最長 63 字元。
safe_label="$(printf '%s' "$label" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | tr -s '-' | cut -c1-32)"
safe_label="${safe_label#-}"
safe_label="${safe_label%-}"
[ -n "$safe_label" ] || safe_label="build"
run_id="lm-ismoke-${safe_label}-$(random_hex 4)"
net="${run_id}-net"
db="${run_id}-db"
app="${run_id}-app"
files="${run_id}-files"
base_url="http://${app}:${APP_PORT}"

# lm.ci.build 使用完整的建置標籤（$BUILD_TAG，不截斷）：Jenkinsfile 收尾以 `label=lm.ci.build=$BUILD_TAG`
# 清除本建置的所有容器與網路；截斷後的名稱可能與其他建置相同，不可作為清除依據。
labels=(--label "lm.ci.image-smoke=${run_id}" --label "lm.ci.build=${label}")
# 與 deploy/compose/compose.yaml 的 App 相同（App 與 runner）；資料庫容器的 entrypoint 需要
# chown／切換使用者，因此只加 no-new-privileges。
hardening=(--cap-drop ALL --security-opt no-new-privileges:true)

mkdir -p "$reports_dir"
summary_file="${reports_dir}/image-smoke-summary.json"
migrate_log="${reports_dir}/image-smoke-migrate.log"
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
    chmod -R u+w -- "$tmp_dir" 2>/dev/null
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
mkdir -m 0755 "$stage_dir"
(
  umask 077
  db_password="$(random_hex 24)"
  printf 'POSTGRES_PASSWORD=%s\n' "$db_password" > "${env_dir}/db.env"
  # lm-server 拒絕 Supabase CLI 的範例金鑰（非 loopback 的 LM_BIND）；隨機值不會連線使用。
  printf 'DATABASE_URL=postgres://%s:%s@%s:5432/%s?sslmode=disable\nSUPABASE_ANON_KEY=%s\nSUPABASE_SERVICE_KEY=%s\n' \
    "$DB_USER" "$db_password" "$db" "$DB_NAME" "$(random_hex 32)" "$(random_hex 32)" > "${env_dir}/app.env"
)

# HTTP 檢查（runner 容器內以 bun 執行；不含秘密）：120 秒內連續 3 次 GET /robots.txt 為 200 才開始檢查，
# 之後 GET /robots.txt → 200、GET / → 200 的 HTML、GET /api/me（沒有 token）→ 401。
cat > "${stage_dir}/check.mjs" <<'EOF'
const base = process.env.LM_IMAGE_SMOKE_BASE_URL;
const timeoutMs = 10000;
const get = (path) => fetch(new URL(path, base), { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let streak = 0;
const deadline = Date.now() + 120000;
while (streak < 3) {
  if (Date.now() > deadline) {
    console.log(JSON.stringify({ ok: false, steps: [{ step: 'healthy', status: null, ms: 120000, result: 'fail', reason: 'timeout' }] }));
    process.exit(5);
  }
  try {
    const res = await get('/robots.txt');
    await res.arrayBuffer();
    streak = res.status === 200 ? streak + 1 : 0;
  } catch {
    streak = 0;
  }
  if (streak < 3) await sleep(2000);
}
const checks = [
  ['robots', '/robots.txt', (res) => (res.status === 200 ? null : 'status')],
  ['index', '/', (res, text) => (res.status !== 200 ? 'status' : /text\/html/i.test(res.headers.get('content-type') ?? '') && /\.(?:wasm|js)["'?#]/.test(text) ? null : 'no-app')],
  ['me-unauthorized', '/api/me', (res) => (res.status === 401 ? null : 'status')],
];
const steps = [];
for (const [step, path, check] of checks) {
  const started = performance.now();
  let status = null;
  let reason;
  try {
    const res = await get(path);
    status = res.status;
    reason = check(res, await res.text());
  } catch (err) {
    reason = err?.name === 'TimeoutError' ? 'timeout' : 'network';
  }
  const entry = { step, status, ms: Math.round(performance.now() - started), result: reason ? 'fail' : 'pass' };
  if (reason) entry.reason = reason;
  steps.push(entry);
}
const ok = steps.every((s) => s.result === 'pass');
console.log(JSON.stringify({ ok, steps }));
process.exit(ok ? 0 : 1);
EOF
chmod 0644 "${stage_dir}/check.mjs"

echo "image-smoke: 受測映像 ${image}（run ${run_id}）"

# --- 1. 隔離網路 --------------------------------------------------------------
stage="network"
"$DOCKER_BIN" network create --internal "${labels[@]}" "$net" >/dev/null \
  || die 7 "無法建立 internal 網路"
net_created=1

# --- 2. /app/migrations 與 supabase/migrations/*.sql 相同 ----------------------
# docker create 不啟動容器（distroless 映像沒有 shell）；只用來以 docker cp 取出 /app/migrations。
stage="migrations"
"$DOCKER_BIN" create --name "$files" --network "$net" "${labels[@]}" "$image" >/dev/null \
  || die 7 "無法建立映像檔案容器"
mkdir -m 0700 "${tmp_dir}/image"
"$DOCKER_BIN" cp "${files}:/app/migrations" - | tar -x -C "${tmp_dir}/image" \
  || die 7 "無法自映像取出 /app/migrations"
# 映像內的目錄是 0555：加上擁有者的寫入權，結束時才能刪除暫存目錄。
chmod -R u+w "${tmp_dir}/image"
"$DOCKER_BIN" rm -fv "$files" >/dev/null 2>&1 || true
migrations_ok=1
: > "$migrate_log"
for f in "${repo_migrations[@]}"; do
  name="${f##*/}"
  want="$(sha256sum < "$f" | cut -d' ' -f1)"
  if [ ! -f "${tmp_dir}/image/migrations/${name}" ]; then
    echo "missing ${name}" >> "$migrate_log"
    migrations_ok=0
    continue
  fi
  got="$(sha256sum < "${tmp_dir}/image/migrations/${name}" | cut -d' ' -f1)"
  if [ "$want" = "$got" ]; then
    echo "ok ${name} ${got}" >> "$migrate_log"
  else
    echo "differs ${name} repository=${want} image=${got}" >> "$migrate_log"
    migrations_ok=0
  fi
done
for f in "${tmp_dir}/image/migrations/"*; do
  [ -e "$f" ] || continue
  name="${f##*/}"
  [ -f "supabase/migrations/${name}" ] && [[ "$name" == *.sql ]] && continue
  echo "extra ${name}" >> "$migrate_log"
  migrations_ok=0
done
[ "$migrations_ok" -eq 1 ] || die 4 "/app/migrations 與 supabase/migrations 不同，詳見 ${migrate_log}"
echo "image-smoke: /app/migrations 與 supabase/migrations 相同（${#repo_migrations[@]} 個檔案）"

# --- 3. Ephemeral_Database ----------------------------------------------------
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

# --- 4. 以映像預設 ENTRYPOINT 與 USER 啟動 lm-server ----------------------------
# 綁定 0.0.0.0 僅在容器的網路命名空間內；網路為 --internal 且未發布連接埠。LM_STATIC_DIR 使用映像的預設值。
stage="app"
"$DOCKER_BIN" run -d --name "$app" --network "$net" "${labels[@]}" \
    "${hardening[@]}" --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
    --env-file "${env_dir}/app.env" \
    -e "LM_BIND=0.0.0.0:${APP_PORT}" -e "SUPABASE_URL=http://127.0.0.1:9" \
    "$image" >/dev/null \
  || die 7 "無法啟動 App 容器"
app_started=1

# --- 5. HTTP 檢查 -------------------------------------------------------------
stage="smoke"
runner="${run_id}-runner"
"$DOCKER_BIN" create --name "$runner" --network "$net" "${labels[@]}" "${hardening[@]}" \
    --user 65532:65532 --tmpfs /tmp:rw,nosuid,nodev,size=64m -e HOME=/tmp \
    -e "LM_IMAGE_SMOKE_BASE_URL=${base_url}" \
    --workdir /smoke --entrypoint bun "$runner_image" /smoke/check.mjs >/dev/null \
  || die 7 "無法建立 runner 容器"
"$DOCKER_BIN" cp "${stage_dir}/." "${runner}:/smoke" >/dev/null || die 7 "無法複製檢查腳本"
check_rc=0
run_timeout "$CHECK_TIMEOUT_S" "$DOCKER_BIN" start -a "$runner" > "${reports_dir}/image-smoke.json" || check_rc=$?
case "$check_rc" in
  0) ;;
  1) die 1 "HTTP 檢查失敗，詳見 ${reports_dir}/image-smoke.json" ;;
  5) die 5 "App 未於 120 秒內達成連續 3 次 Health_Check（GET /robots.txt）成功，詳見 ${reports_dir}/image-smoke-app.log" ;;
  124|137) die 1 "HTTP 檢查未於 ${CHECK_TIMEOUT_S} 秒內完成" ;;
  *) die 7 "runner 容器執行錯誤（結束碼 ${check_rc}）" ;;
esac

# App 在整個檢查期間須持續運作（未崩潰）。
running="$("$DOCKER_BIN" inspect -f '{{.State.Running}}' "$app" 2>/dev/null || echo false)"
[ "$running" = "true" ] || die 1 "App 容器於檢查期間停止"

stage="done"
passed=1
echo "image-smoke: 通過 ${image}"
