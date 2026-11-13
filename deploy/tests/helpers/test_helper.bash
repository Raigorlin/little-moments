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
    FAKE_STDIN_DIR FAKE_ENV_LOG LM_TEST_OPERATOR SUDO_USER FAKE_CHOWN_LOG LM_OPENAI_KEY_SOURCE \
    CAMPING_OPENAI_API_KEY_FILE
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

# ---------------------------------------------------------------------------------------------
# 收據 AI（design.md Components §25.8）
# ---------------------------------------------------------------------------------------------

# fake_key：執行時產生的假金鑰（sk-test- 加 48 個十六進位字元）。repository 中不留下符合金鑰格式的字串。
fake_key() { printf 'sk-test-%s' "$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"; }

# rep <char> <count>：重複字元（用來在執行時組出長度邊界的值）。
rep() { local s="" i; for ((i = 0; i < $2; i++)); do s+=$1; done; printf '%s' "$s"; }

# use_prod：改用 prod 環境（ENV_DIR、STATE、BACKUPS、UPSTREAM 指向 <LM_ROOT>/prod），KEYFILE 為金鑰檔路徑。
use_prod() {
  ENV_DIR="$LM_ROOT/prod"
  STATE="$ENV_DIR/state/lm.state"
  BACKUPS="$LM_BACKUP_ROOT/prod"
  UPSTREAM="$ENV_DIR/caddy/upstream.caddy"
  KEYFILE="$ENV_DIR/secrets/openai-api-key"
  mkdir -p "$ENV_DIR/caddy" "$ENV_DIR/state"
  mkdir -m 0700 "$BACKUPS"
  cp "$REPO_ROOT/deploy/compose/compose.yaml" "$ENV_DIR/compose.yaml"
  cp "$REPO_ROOT/deploy/caddy/Caddyfile" "$REPO_ROOT/deploy/caddy/upstream.caddy.tmpl" "$ENV_DIR/caddy/"
  cat >"$ENV_DIR/prod.env" <<EOF
LM_ENV=prod
ALLOWED_HOSTS=lm.example.test,192.0.2.10
LM_HEALTH_HOST=lm.example.test
LM_CADDY_DIR=./caddy
LM_IMAGE_REPO=$REPO
LM_EDGE_TRUSTED_PROXIES=
LM_LAN_CIDR=
CAMPING_OPENAI_API_KEY_FILE=
CAMPING_OPENAI_MODEL_ID=
CAMPING_OPENAI_IMAGE_DETAIL=
CAMPING_OPENAI_MAX_COMPLETION_TOKENS=
EOF
  printf 'POSTGRES_DB=little_moments\nPOSTGRES_USER=lm_app\nPOSTGRES_PASSWORD=placeholder\n' >"$ENV_DIR/db.env"
  render_upstream green
}

# put_key_file <key>：在目前環境建立金鑰檔（secrets/ 0700、檔案 0400），內容為 <key> 加一個換行。
put_key_file() {
  mkdir -m 0700 -p "$ENV_DIR/secrets"
  rm -f "$ENV_DIR/secrets/openai-api-key"
  printf '%s\n' "$1" >"$ENV_DIR/secrets/openai-api-key"
  chmod 0400 "$ENV_DIR/secrets/openai-api-key"
}

# install_fake_chown：PATH 中的假 chown 把參數記錄在 $FAKE_CHOWN_LOG 並成功結束（不改變擁有者）。
install_fake_chown() {
  export FAKE_CHOWN_LOG="$BATS_TEST_TMPDIR/chown.log"
  : >"$FAKE_CHOWN_LOG"
  cat >"$BATS_TEST_TMPDIR/bin/chown" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${FAKE_CHOWN_LOG:?}"
exit 0
EOF
  chmod 0755 "$BATS_TEST_TMPDIR/bin/chown"
}

# app_env_stdin <file> <line>...：寫入 deploy --app-env-stdin 的 stdin（<line> 依序在 app.env 三個必要鍵之前，
# 以 LM_OPENAI_API_KEY= 開頭者放在最後，與 Pipeline 的順序相同）。
app_env_stdin() {
  local f=$1 l
  shift
  : >"$f"
  for l in "$@"; do [[ $l == LM_OPENAI_API_KEY=* ]] || printf '%s\n' "$l" >>"$f"; done
  printf 'CAMPING_DATABASE_NAME=little_moments\nCAMPING_DATABASE_USER=lm_app\nCAMPING_DATABASE_PASSWORD=placeholder\n' >>"$f"
  for l in "$@"; do [[ $l != LM_OPENAI_API_KEY=* ]] || printf '%s\n' "$l" >>"$f"; done
}

# assert_secret_not_leaked <value>：值不出現在 lm-deploy 的 stdout／stderr、fake docker 的參數與環境紀錄、state/ 與 app.env。
assert_secret_not_leaked() {
  local v=$1
  if [[ $output == *"$v"* || $stderr == *"$v"* ]]; then printf 'secret in lm-deploy output\n'; return 1; fi
  if grep -qF -- "$v" "$FAKE_DOCKER_LOG"; then printf 'secret in docker args\n'; return 1; fi
  if [[ -f ${FAKE_ENV_LOG:-/nonexistent} ]] && grep -qF -- "$v" "$FAKE_ENV_LOG"; then printf 'secret in docker env\n'; return 1; fi
  if grep -rqF -- "$v" "$ENV_DIR/state"; then printf 'secret in state/\n'; return 1; fi
  if [[ -f $ENV_DIR/app.env ]] && grep -qF -- "$v" "$ENV_DIR/app.env"; then printf 'secret in app.env\n'; return 1; fi
}

# assert_no_receipt_tmp：沒有殘留的 app.env／stdin／金鑰暫存檔。
assert_no_receipt_tmp() {
  local f
  for f in "$ENV_DIR"/.app.env.* "$ENV_DIR"/.app-env-in.* "$ENV_DIR"/secrets/.openai-api-key.*; do
    if [[ -e $f ]]; then printf 'leftover temp file: %s\n' "$f"; return 1; fi
  done
}

# assert_call_fixed <text>：docker.log 中有一行包含 <text>（固定字串比對）。
assert_call_fixed() {
  if ! grep -qF -- "$1" "$FAKE_DOCKER_LOG"; then
    printf 'expected docker call containing: %s\n--- docker.log ---\n' "$1"; cat "$FAKE_DOCKER_LOG"; return 1
  fi
}
