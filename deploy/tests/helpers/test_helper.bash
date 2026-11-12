# 共用的 bats 輔助函式（deploy/tests/lm-deploy.bats）。
# 每個測試在 BATS_TEST_TMPDIR 建立獨立的 LM_ROOT／LM_BACKUP_ROOT／LM_LOCK_DIR 與假的 docker、sleep。

REPO_ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)
LM_DEPLOY="$REPO_ROOT/deploy/bin/lm-deploy"
REPO=registry.lan:5000/little-moments

hex64() { local c=$1 s=""; for _ in {1..64}; do s+=$c; done; printf 'sha256:%s' "$s"; }
D1=$(hex64 1)
D2=$(hex64 2)
D3=$(hex64 3)
D4=$(hex64 4)
D5=$(hex64 5)

setup_fixture() {
  local t=$BATS_TEST_TMPDIR
  unset FAKE_PG_DUMP_FAIL FAKE_PG_DUMP_EMPTY FAKE_PG_RESTORE_LIST_FAIL FAKE_MIGRATE_FAIL FAKE_UP_FAIL \
    FAKE_HEALTH_FAIL FAKE_CADDY_RELOAD_FAIL FAKE_IMAGE_LIST SSH_ORIGINAL_COMMAND \
    FAKE_DB_RUNNING FAKE_PROXY_RUNNING FAKE_PS_FAIL FAKE_PROXY_UP_FAIL FAKE_SMOKE_TOOL_OUT FAKE_SMOKE_TOOL_RC \
    FAKE_STDIN_DIR FAKE_ENV_LOG LM_TEST_OPERATOR SUDO_USER
  export LM_ROOT="$t/srv" LM_BACKUP_ROOT="$t/backups" LM_LOCK_DIR="$t/run"
  # 健康等待：每 1 秒一次、視窗 3 秒、連續 3 次（假的 sleep 不等待）。
  export LM_HEALTH_INTERVAL=1 LM_HEALTH_WINDOW=3 LM_HEALTH_NEED=3
  export FAKE_DOCKER_LOG="$t/docker.log"

  ENV_DIR="$LM_ROOT/staging"
  STATE="$ENV_DIR/state/lm.state"
  BACKUPS="$LM_BACKUP_ROOT/staging"
  UPSTREAM="$ENV_DIR/caddy/upstream.caddy"

  mkdir -p "$ENV_DIR/caddy" "$ENV_DIR/state" "$LM_LOCK_DIR" "$t/bin"
  mkdir -m 0700 -p "$LM_BACKUP_ROOT"
  mkdir -m 0700 "$BACKUPS"
  cp "$REPO_ROOT/deploy/compose/compose.yaml" "$ENV_DIR/compose.yaml"
  cp "$REPO_ROOT/deploy/caddy/Caddyfile" "$REPO_ROOT/deploy/caddy/upstream.caddy.tmpl" "$ENV_DIR/caddy/"
  cat >"$ENV_DIR/staging.env" <<EOF
LM_ENV=staging
ALLOWED_HOSTS=lm.lan,192.0.2.10
LM_HEALTH_HOST=lm.lan
LM_CADDY_DIR=./caddy
LM_IMAGE_REPO=$REPO
LM_EDGE_TRUSTED_PROXIES=
LM_LAN_CIDR=
EOF
  printf 'POSTGRES_DB=little_moments\nPOSTGRES_USER=lm_app\nPOSTGRES_PASSWORD=placeholder\n' >"$ENV_DIR/db.env"
  render_upstream green

  cp "$BATS_TEST_DIRNAME/helpers/fake-docker" "$t/bin/docker"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$t/bin/sleep"
  chmod 0755 "$t/bin/docker" "$t/bin/sleep"
  export PATH="$t/bin:$PATH"
  : >"$FAKE_DOCKER_LOG"
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

# set_edge <LM_EDGE_TRUSTED_PROXIES> [LM_LAN_CIDR]：在 staging.env 末尾覆寫兩個值（env_get 以最後一筆為準）。
set_edge() { printf 'LM_EDGE_TRUSTED_PROXIES=%s\nLM_LAN_CIDR=%s\n' "$1" "${2:-}" >>"$ENV_DIR/staging.env"; }

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

count_files() { local n=0 f; for f in "$BACKUPS"/$1; do [[ -e $f ]] && n=$((n + 1)); done; printf '%s' "$n"; }

assert_no_partials() {
  local n
  n=$(count_files '*.partial*')
  if [[ $n -ne 0 ]]; then printf 'leftover partial files:\n'; ls -la "$BACKUPS"; return 1; fi
}
