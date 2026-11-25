# 共用的 bats 輔助函式（deploy/tests/lm-deploy.bats、deploy/tests/supabase-keys.bats）。
# 每個測試在 BATS_TEST_TMPDIR 建立獨立的 LM_ROOT／LM_BACKUP_ROOT／LM_LOCK_DIR 與假的 docker、sleep。

REPO_ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
LM_DEPLOY="$REPO_ROOT/deploy/bin/lm-deploy"
KEYS_TOOL="$REPO_ROOT/deploy/bin/lm-supabase-keys"
REPO=registry.lan:5000/little-moments

hex64() { local c=$1 s=""; for _ in {1..64}; do s+=$c; done; printf 'sha256:%s' "$s"; }
D1=$(hex64 1)
D2=$(hex64 2)
D3=$(hex64 3)
D4=$(hex64 4)
D5=$(hex64 5)

setup_fixture() {
  local t=$BATS_TEST_TMPDIR
  unset FAKE_STACK_FAIL FAKE_STACK_UNHEALTHY FAKE_PG_DUMP_FAIL FAKE_PG_DUMP_EMPTY FAKE_PG_RESTORE_LIST_FAIL \
    FAKE_LIST_NO_APP FAKE_LIST_NO_DATA FAKE_CREATE_FAIL FAKE_CP_FAIL FAKE_MIGRATIONS_DIR FAKE_APPLIED \
    FAKE_REALTIME_MESSAGES FAKE_MIGRATION_FAIL FAKE_UP_FAIL FAKE_HEALTH_FAIL FAKE_CADDY_RELOAD_FAIL FAKE_IMAGE_LIST \
    FAKE_RESTORE_FAIL FAKE_DRILL_COUNTS FAKE_DOWN_FAIL FAKE_STDIN_DIR FAKE_ENV_LOG SSH_ORIGINAL_COMMAND SUDO_USER
  export LM_ROOT="$t/srv" LM_BACKUP_ROOT="$t/backups" LM_LOCK_DIR="$t/run" LM_BIN_DIR="$t/bin"
  # 健康等待：每 1 秒一次、視窗 3 秒、連續 3 次（假的 sleep 不等待）；stack 健康檢查最多 2 次。
  export LM_HEALTH_INTERVAL=1 LM_HEALTH_WINDOW=3 LM_HEALTH_NEED=3 LM_STACK_TRIES=2 LM_STACK_INTERVAL=1
  export FAKE_DOCKER_LOG="$t/docker.log"

  ENV_DIR="$LM_ROOT/staging"
  STATE="$ENV_DIR/state/lm.state"
  BACKUPS="$LM_BACKUP_ROOT/staging"
  UPSTREAM="$ENV_DIR/caddy/upstream.caddy"

  mkdir -p "$ENV_DIR/caddy" "$ENV_DIR/state" "$ENV_DIR/supabase" "$LM_LOCK_DIR" "$t/bin"
  mkdir -m 0700 -p "$LM_BACKUP_ROOT"
  mkdir -m 0700 "$BACKUPS"
  cp "$REPO_ROOT/deploy/compose/compose.yaml" "$REPO_ROOT/deploy/compose/drill.yaml" "$ENV_DIR/"
  cp "$REPO_ROOT/deploy/caddy/Caddyfile" "$REPO_ROOT/deploy/caddy/upstream.caddy.tmpl" "$ENV_DIR/caddy/"
  cp "$REPO_ROOT/deploy/supabase/gateway.Caddyfile" "$REPO_ROOT/deploy/supabase/db-setup.sql" "$ENV_DIR/supabase/"
  write_env_file "$ENV_DIR/staging.env" staging
  # app.env：由真正的 lm-supabase-keys 產生（格式即 lm-deploy 接受的格式）。
  APP_ENV_FILE="$t/app.env.in"
  bash "$KEYS_TOOL" env staging >"$APP_ENV_FILE"
  cp "$APP_ENV_FILE" "$ENV_DIR/app.env"
  chmod 0600 "$ENV_DIR/app.env"
  render_upstream green

  cp "$BATS_TEST_DIRNAME/helpers/fake-docker" "$t/bin/docker"
  cp "$KEYS_TOOL" "$t/bin/lm-supabase-keys"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$t/bin/sleep"
  chmod 0755 "$t/bin/docker" "$t/bin/sleep" "$t/bin/lm-supabase-keys"
  export PATH="$t/bin:$PATH"
  : >"$FAKE_DOCKER_LOG"
}

# write_env_file <file> <env>：<env>.env 的最小有效設定（文件用位址與網域）。
write_env_file() {
  local host=lm.lan
  [[ $2 == prod ]] && host=lm.example.test
  cat >"$1" <<EOF
LM_ENV=$2
LM_ALLOWED_HOSTS=$host 192.0.2.10
LM_HEALTH_HOST=$host
LM_SITE_URL=http://$host:8081
LM_PUBLIC_SIGNUP=false
LM_CADDY_DIR=./caddy
LM_IMAGE_REPO=$REPO
LM_EDGE_TRUSTED_PROXIES=
LM_LAN_CIDR=
EOF
}

render_upstream() { sed "s/__COLOR__/$1/g" "$ENV_DIR/caddy/upstream.caddy.tmpl" >"$UPSTREAM"; }

# write_state KEY=VALUE...
write_state() { printf '%s\n' "$@" >"$STATE"; }

state_get() { sed -n "s/^$1=//p" "$STATE"; }

# lm <args...>：stdout 進 $output／$lines，stderr 進 $stderr。
lm() { run --separate-stderr bash "$LM_DEPLOY" "$@"; }

last_line() { printf '%s' "${lines[${#lines[@]} - 1]}"; }

assert_status() {
  if [[ $status -ne $1 ]]; then
    printf 'expected exit %s, got %s\nstdout:\n%s\nstderr:\n%s\n' "$1" "$status" "$output" "$stderr"
    return 1
  fi
}

assert_contains() {
  if [[ $1 != *"$2"* ]]; then printf 'expected to contain: %s\nactual: %s\n' "$2" "$1"; return 1; fi
}

assert_call() {
  if ! grep -qE -- "$1" "$FAKE_DOCKER_LOG"; then
    printf 'expected docker call matching: %s\n--- docker.log ---\n' "$1"; cat "$FAKE_DOCKER_LOG"; return 1
  fi
}

refute_call() {
  if grep -qE -- "$1" "$FAKE_DOCKER_LOG"; then
    printf 'unexpected docker call matching: %s\n--- docker.log ---\n' "$1"; cat "$FAKE_DOCKER_LOG"; return 1
  fi
}

# assert_call_fixed <text>：docker.log 中有一行包含 <text>（固定字串比對）。
assert_call_fixed() {
  if ! grep -qF -- "$1" "$FAKE_DOCKER_LOG"; then
    printf 'expected docker call containing: %s\n--- docker.log ---\n' "$1"; cat "$FAKE_DOCKER_LOG"; return 1
  fi
}

# set_edge <LM_EDGE_TRUSTED_PROXIES> [LM_LAN_CIDR]：在 staging.env 末尾覆寫兩個值（env_get 以最後一筆為準）。
set_edge() { printf 'LM_EDGE_TRUSTED_PROXIES=%s\nLM_LAN_CIDR=%s\n' "$1" "${2:-}" >>"$ENV_DIR/staging.env"; }

# set_env_value <KEY> <VALUE>：在 staging.env 末尾覆寫一個值。
set_env_value() { printf '%s=%s\n' "$1" "$2" >>"$ENV_DIR/staging.env"; }

assert_no_docker_calls() {
  if [[ -s $FAKE_DOCKER_LOG ]]; then printf 'expected no docker calls\n'; cat "$FAKE_DOCKER_LOG"; return 1; fi
}

# 第一個符合 pattern 的 docker.log 行號（找不到為 0）。
call_line() { local n; n=$(grep -nE -- "$1" "$FAKE_DOCKER_LOG" | head -n1 | cut -d: -f1); printf '%s' "${n:-0}"; }

# seed_backups <count>：建立 count 份已驗證的既有備份，id 時間依序為 2024-01-01 00:00:10 起每秒一份。
seed_backups() {
  local i id
  for ((i = 0; i < $1; i++)); do
    id=$(printf 'staging-20240101T0000%02dZ-%07x' "$((10 + i))" "$((i + 1))")
    printf 'old-%s\n' "$i" >"$BACKUPS/$id.dump"
    printf '%064x  %s.dump\n' "$i" "$id" >"$BACKUPS/$id.dump.sha256"
    printf '{"id":"%s"}\n' "$id" >"$BACKUPS/$id.json"
  done
}

# seed_real_backup：一份內容與校驗碼一致的已驗證備份（還原演練用）；BACKUP_ID 為其 id。
seed_real_backup() {
  local sha f="$BATS_TEST_TMPDIR/real.dump"
  printf 'PGDMP-real-backup\n' >"$f"
  sha=$(sha256sum "$f" | cut -d' ' -f1)
  BACKUP_ID="staging-20250101T000000Z-${sha:0:7}"
  mv "$f" "$BACKUPS/$BACKUP_ID.dump"
  printf '%s  %s.dump\n' "$sha" "$BACKUP_ID" >"$BACKUPS/$BACKUP_ID.dump.sha256"
  printf '{"id":"%s","createdAt":"2025-01-01T00:00:00+00:00"}\n' "$BACKUP_ID" >"$BACKUPS/$BACKUP_ID.json"
}

count_files() { local n=0 f; for f in "$BACKUPS"/$1; do [[ -e $f ]] && n=$((n + 1)); done; printf '%s' "$n"; }

assert_no_partials() {
  local n
  n=$(count_files '*.partial*')
  if [[ $n -ne 0 ]]; then printf 'leftover partial files:\n'; ls -la "$BACKUPS"; return 1; fi
}

# assert_secret_not_leaked <value>：值不出現在 lm-deploy 的 stdout／stderr、fake docker 的參數與環境紀錄或 state/。
assert_secret_not_leaked() {
  local v=$1
  if [[ $output == *"$v"* || $stderr == *"$v"* ]]; then printf 'secret in lm-deploy output\n'; return 1; fi
  if grep -qF -- "$v" "$FAKE_DOCKER_LOG"; then printf 'secret in docker args\n'; return 1; fi
  if [[ -f ${FAKE_ENV_LOG:-/nonexistent} ]] && grep -qF -- "$v" "$FAKE_ENV_LOG"; then printf 'secret in docker env\n'; return 1; fi
  if grep -rqF -- "$v" "$ENV_DIR/state"; then printf 'secret in state/\n'; return 1; fi
}

# assert_no_app_env_tmp：沒有殘留的 app.env 暫存檔。
assert_no_app_env_tmp() {
  local f
  for f in "$ENV_DIR"/.app.env.*; do
    if [[ -e $f ]]; then printf 'leftover temp file: %s\n' "$f"; return 1; fi
  done
}

# mig_dir <name>...：建立一個遷移目錄（FAKE_MIGRATIONS_DIR），每個檔案內容為 "-- <name>"。
mig_dir() {
  local d="$BATS_TEST_TMPDIR/migrations" n
  rm -rf "$d"
  mkdir -p "$d"
  for n in "$@"; do printf -- '-- %s\n' "$n" >"$d/$n"; done
  export FAKE_MIGRATIONS_DIR=$d
}

# applied <name>...：FAKE_APPLIED 列出這些遷移與其目前內容的 sha256（已套用）。
applied() {
  local n
  export FAKE_APPLIED="$BATS_TEST_TMPDIR/applied"
  : >"$FAKE_APPLIED"
  for n in "$@"; do
    printf '%s %s\n' "${n%.sql}" "$(sha256sum "$FAKE_MIGRATIONS_DIR/$n" | cut -d' ' -f1)" >>"$FAKE_APPLIED"
  done
}
