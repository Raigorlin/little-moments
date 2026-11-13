#!/usr/bin/env bats
# deploy/bin/lm-deploy 的行為測試（tasks.md 14.4；Requirements 14.3、14.5、18.7、20.4、20.9、20.12）。
#
# 以 PATH 中假的 docker（helpers/fake-docker，pg_dump／pg_restore 經 `docker compose exec -T db ...` 呼叫）
# 與不等待的 sleep 執行；每個測試在 BATS_TEST_TMPDIR 有獨立的 LM_ROOT、備份目錄與鎖目錄。
#
# 執行：bats deploy/tests/lm-deploy.bats（需要 bash ≥ 4.4、GNU coreutils、util-linux flock；不需要 Docker）。

bats_require_minimum_version 1.5.0

load helpers/test_helper

setup() { setup_fixture; }

idle_green() { write_state PHASE=idle ACTIVE_COLOR=green "ACTIVE_DIGEST=$D1" "HISTORY=$D1"; }

# ---------------------------------------------------------------------------------------------
# Req 14.3：備份失敗 → 不執行 Migration_Runner、不動容器
# ---------------------------------------------------------------------------------------------

@test "deploy: pg_dump failure aborts before migrate and leaves no partial" {
  idle_green
  export FAKE_PG_DUMP_FAIL=1
  lm staging deploy "$D2"
  assert_status 1
  assert_contains "$(last_line)" '"reason":"backup_create_failed"'
  assert_call 'exec -T db pg_dump -Fc'
  refute_call 'migrate'
  refute_call 'up -d|pull app-|caddy reload'
  assert_no_partials
  [ "$(count_files '*.dump')" -eq 0 ]
  [ "$(state_get PHASE)" = idle ]
  [ "$(state_get ACTIVE_DIGEST)" = "$D1" ]
}

@test "deploy: pg_restore --list verify failure aborts before migrate and leaves no partial" {
  idle_green
  export FAKE_PG_RESTORE_LIST_FAIL=1
  lm staging deploy "$D2"
  assert_status 1
  assert_contains "$(last_line)" '"reason":"backup_verify_failed"'
  assert_call 'exec -T db pg_restore --list'
  refute_call 'migrate'
  refute_call 'up -d|pull app-|caddy reload'
  assert_no_partials
  [ "$(count_files '*.dump')" -eq 0 ]
  [ "$(count_files '*.tmp')" -eq 0 ]
}

@test "deploy: empty dump fails verification before migrate" {
  idle_green
  export FAKE_PG_DUMP_EMPTY=1
  lm staging deploy "$D2"
  assert_status 1
  assert_contains "$(last_line)" '"reason":"backup_verify_failed"'
  refute_call 'migrate'
  assert_no_partials
}

@test "migrate: refuses without a recent verified backup" {
  idle_green
  lm staging migrate "$D2"
  assert_status 3
  assert_contains "$(last_line)" '"reason":"backup_required"'
  assert_no_docker_calls
}

@test "deploy: migrate failure does not start the new container" {
  idle_green
  export FAKE_MIGRATE_FAIL=1
  lm staging deploy "$D2"
  assert_status 1
  assert_contains "$(last_line)" '"reason":"migrate_failed"'
  refute_call 'up -d|pull app-|caddy reload'
  [ "$(state_get PHASE)" = idle ]
  [ "$(state_get ACTIVE_DIGEST)" = "$D1" ]
}

# ---------------------------------------------------------------------------------------------
# Req 14.5：14 份備份修剪
# ---------------------------------------------------------------------------------------------

@test "backup: with 20 verified backups, success keeps new + 13 newest" {
  seed_backups 20
  lm staging backup
  assert_status 0
  assert_contains "$(last_line)" '"ok":true'
  [ "$(count_files '*.dump')" -eq 14 ]
  [ "$(count_files '*.dump.sha256')" -eq 14 ]
  [ "$(count_files '*.json')" -eq 14 ]
  local new
  new=$(state_get LAST_BACKUP_ID)
  [ -f "$BACKUPS/$new.dump" ]
  [ -f "$BACKUPS/$new.dump.sha256" ]
  # 最舊的 7 份（00:00:10–00:00:16）被刪除，00:00:17–00:00:29 保留。
  local i
  for i in 10 11 12 13 14 15 16; do [ "$(count_files "staging-20240101T0000${i}Z-*")" -eq 0 ]; done
  for i in 17 18 19 20 21 22 23 24 25 26 27 28 29; do [ "$(count_files "staging-20240101T0000${i}Z-*.dump")" -eq 1 ]; done
  assert_contains "$(last_line)" '"pruned":["staging-20240101T000016Z-'
  assert_no_partials
  # .sha256 內容可被 sha256sum -c 驗證。
  (cd "$BACKUPS" && sha256sum -c --status "$new.dump.sha256")
}

@test "backup: failed backup deletes no existing backup" {
  seed_backups 20
  export FAKE_PG_DUMP_FAIL=1
  lm staging backup
  assert_status 1
  [ "$(count_files '*.dump')" -eq 20 ]
  [ "$(count_files '*.dump.sha256')" -eq 20 ]
  assert_no_partials

  export FAKE_PG_DUMP_FAIL=0 FAKE_PG_RESTORE_LIST_FAIL=1
  lm staging backup
  assert_status 1
  [ "$(count_files '*.dump')" -eq 20 ]
  assert_no_partials
}

@test "backup: refuses a group/other-accessible backup directory" {
  chmod 0750 "$BACKUPS"
  lm staging backup
  assert_status 1
  assert_contains "$(last_line)" '"reason":"backup_create_failed"'
  assert_no_docker_calls
}

# ---------------------------------------------------------------------------------------------
# Req 20.12：鎖衝突
# ---------------------------------------------------------------------------------------------

@test "lock: state-changing subcommands exit 4 with deploy_in_progress and no docker calls" {
  idle_green
  local fd cmd
  exec {fd}>>"$LM_LOCK_DIR/lm-staging.lock"
  flock -n "$fd"
  for cmd in "backup" "deploy $D2" "migrate $D2" "start $D2" "switch" "rollback" "rollback $D1" "finalize" "prune"; do
    # shellcheck disable=SC2086
    lm staging $cmd
    assert_status 4
    assert_contains "$(last_line)" '"reason":"deploy_in_progress"'
  done
  lm staging app-env <<<"CAMPING_DATABASE_NAME=x"
  assert_status 4
  # status 不取鎖，並回報部署進行中。
  lm staging status
  assert_status 0
  assert_contains "$output" '"deployInProgress":true'
  exec {fd}>&-
  assert_no_docker_calls
  [ "$(state_get PHASE)" = idle ]
}

@test "lock: status reports deployInProgress false when the lock is free" {
  idle_green
  lm staging status
  assert_contains "$output" '"deployInProgress":false'
}

# ---------------------------------------------------------------------------------------------
# Req 20.4：健康失敗 → 不切換
# ---------------------------------------------------------------------------------------------

@test "deploy: health failure removes new container and does not switch" {
  idle_green
  local before
  before=$(sha256sum <"$UPSTREAM")
  export FAKE_HEALTH_FAIL=blue
  lm staging deploy "$D2"
  assert_status 1
  assert_contains "$(last_line)" '"reason":"health_failed"'
  assert_contains "$(last_line)" '"healthy":false'
  assert_contains "$(last_line)" '"results":[{"t":0,"ok":false'
  assert_call "up -d --no-deps app-blue \\[new=$REPO@$D2\\]"
  assert_call 'exec -T proxy wget .*http://app-blue:5173/healthz'
  assert_call '--profile blue rm -s -f app-blue'
  refute_call 'caddy reload'
  refute_call 'app-green'
  [ "$(sha256sum <"$UPSTREAM")" = "$before" ]
  [ "$(state_get PHASE)" = idle ]
  [ "$(state_get ACTIVE_COLOR)" = green ]
  [ "$(state_get ACTIVE_DIGEST)" = "$D1" ]
  [ -z "$(state_get CANDIDATE_COLOR)" ]
}

@test "switch: failing pre-switch health check leaves proxy unchanged" {
  write_state PHASE=started ACTIVE_COLOR=green "ACTIVE_DIGEST=$D1" CANDIDATE_COLOR=blue "CANDIDATE_DIGEST=$D2" "HISTORY=$D1"
  local before
  before=$(sha256sum <"$UPSTREAM")
  export FAKE_HEALTH_FAIL=blue
  lm staging switch
  assert_status 1
  assert_contains "$(last_line)" '"reason":"health_failed"'
  refute_call 'caddy reload'
  [ "$(sha256sum <"$UPSTREAM")" = "$before" ]
  [ "$(state_get PHASE)" = started ]
}

@test "switch: caddy reload failure restores previous upstream" {
  write_state PHASE=started ACTIVE_COLOR=green "ACTIVE_DIGEST=$D1" CANDIDATE_COLOR=blue "CANDIDATE_DIGEST=$D2" "HISTORY=$D1"
  local before
  before=$(sha256sum <"$UPSTREAM")
  export FAKE_CADDY_RELOAD_FAIL=1
  lm staging switch
  assert_status 1
  assert_contains "$(last_line)" '"reason":"switch_failed"'
  [ "$(sha256sum <"$UPSTREAM")" = "$before" ]
  [ "$(state_get PHASE)" = started ]
}

@test "deploy: healthy candidate runs backup -> migrate -> start -> switch in order" {
  idle_green
  lm staging deploy "$D2"
  assert_status 0
  local b m u r
  b=$(call_line 'pg_dump')
  m=$(call_line 'run --rm --no-deps -T migrate')
  u=$(call_line 'up -d --no-deps app-blue')
  r=$(call_line 'caddy reload')
  [ "$b" -gt 0 ]
  [ "$m" -gt "$b" ]
  [ "$u" -gt "$m" ]
  [ "$r" -gt "$u" ]
  assert_call "run --rm --no-deps -T migrate \\[new=$REPO@$D2\\]"
  grep -q 'reverse_proxy app-blue:5173' "$UPSTREAM"
  [ "$(state_get PHASE)" = switched ]
  [ "$(state_get ACTIVE_COLOR)" = blue ]
  [ "$(state_get ACTIVE_DIGEST)" = "$D2" ]
  [ "$(state_get PREVIOUS_COLOR)" = green ]
  [ "$(count_files '*.dump.sha256')" -eq 1 ]
}

@test "deploy: refuses while a previous deploy is unfinished (phase switched)" {
  write_state PHASE=switched ACTIVE_COLOR=blue "ACTIVE_DIGEST=$D2" PREVIOUS_COLOR=green "PREVIOUS_DIGEST=$D1" "HISTORY=$D1"
  lm staging deploy "$D3"
  assert_status 3
  assert_contains "$(last_line)" '"reason":"invalid_phase"'
  assert_no_docker_calls
}

# ---------------------------------------------------------------------------------------------
# Req 20.9：回滾不執行 Migration_Runner
# ---------------------------------------------------------------------------------------------

@test "rollback (auto, after switch): restores previous upstream without migrate" {
  write_state PHASE=switched ACTIVE_COLOR=blue "ACTIVE_DIGEST=$D2" PREVIOUS_COLOR=green "PREVIOUS_DIGEST=$D1" "HISTORY=$D1"
  render_upstream blue
  lm staging rollback
  assert_status 0
  assert_contains "$(last_line)" '"mode":"auto"'
  assert_contains "$(last_line)" '"migrationsRun":false'
  assert_contains "$(last_line)" '"restored":true'
  assert_call 'caddy reload'
  assert_call '--profile blue rm -s -f app-blue'
  refute_call 'migrate'
  grep -q 'reverse_proxy app-green:5173' "$UPSTREAM"
  [ "$(state_get PHASE)" = idle ]
  [ "$(state_get ACTIVE_COLOR)" = green ]
  [ "$(state_get ACTIVE_DIGEST)" = "$D1" ]
}

@test "rollback (auto, before switch): removes candidate without migrate or proxy change" {
  write_state PHASE=started ACTIVE_COLOR=green "ACTIVE_DIGEST=$D1" CANDIDATE_COLOR=blue "CANDIDATE_DIGEST=$D2" "HISTORY=$D1"
  local before
  before=$(sha256sum <"$UPSTREAM")
  lm staging rollback
  assert_status 0
  assert_contains "$(last_line)" '"migrationsRun":false'
  assert_call '--profile blue rm -s -f app-blue'
  refute_call 'migrate'
  refute_call 'caddy reload'
  [ "$(sha256sum <"$UPSTREAM")" = "$before" ]
  [ "$(state_get PHASE)" = idle ]
}

@test "rollback (auto): nothing to roll back when idle" {
  idle_green
  lm staging rollback
  assert_status 3
  assert_contains "$(last_line)" '"reason":"nothing_to_rollback"'
  refute_call 'migrate'
}

@test "rollback <digest>: switches to a retained digest without migrate" {
  write_state PHASE=idle ACTIVE_COLOR=blue "ACTIVE_DIGEST=$D3" "HISTORY=$D1 $D2 $D3"
  render_upstream blue
  lm staging rollback "$REPO@$D1"
  assert_status 0
  assert_contains "$(last_line)" '"mode":"manual"'
  assert_contains "$(last_line)" '"migrationsRun":false'
  assert_call "up -d --no-deps app-green \\[new=$REPO@$D1\\]"
  assert_call 'exec -T proxy wget .*http://app-green:5173/healthz'
  assert_call 'caddy reload'
  refute_call 'migrate'
  refute_call 'pg_dump'
  grep -q 'reverse_proxy app-green:5173' "$UPSTREAM"
  [ "$(state_get PHASE)" = switched ]
  [ "$(state_get ACTIVE_DIGEST)" = "$D1" ]
  [ "$(state_get PREVIOUS_DIGEST)" = "$D3" ]
}

@test "rollback <digest>: unhealthy target is removed, proxy unchanged, no migrate" {
  write_state PHASE=idle ACTIVE_COLOR=blue "ACTIVE_DIGEST=$D3" "HISTORY=$D1 $D2 $D3"
  render_upstream blue
  local before
  before=$(sha256sum <"$UPSTREAM")
  export FAKE_HEALTH_FAIL=green
  lm staging rollback "$D2"
  assert_status 1
  assert_contains "$(last_line)" '"reason":"health_failed"'
  assert_call '--profile green rm -s -f app-green'
  refute_call 'caddy reload'
  refute_call 'migrate'
  [ "$(sha256sum <"$UPSTREAM")" = "$before" ]
  [ "$(state_get PHASE)" = idle ]
  [ "$(state_get ACTIVE_DIGEST)" = "$D3" ]
}

@test "rollback <digest>: rejects a digest outside the 3 retained images" {
  write_state PHASE=idle ACTIVE_COLOR=blue "ACTIVE_DIGEST=$D4" "HISTORY=$D1 $D2 $D3 $D4"
  lm staging rollback "$D1"
  assert_status 2
  assert_contains "$(last_line)" '"reason":"rollback_not_allowed"'
  assert_no_docker_calls
  [ "$(state_get ACTIVE_DIGEST)" = "$D4" ]

  lm staging rollback "$D4"
  assert_status 2
  assert_contains "$(last_line)" '"reason":"rollback_not_allowed"'
  assert_no_docker_calls
}

# ---------------------------------------------------------------------------------------------
# 其他：digest 驗證、status JSON、映像保留
# ---------------------------------------------------------------------------------------------

@test "digest: invalid or foreign digests are rejected before any docker call" {
  idle_green
  local bad
  for bad in "sha256:abc" "latest" "$REPO:latest" "other.lan:5000/little-moments@$D2" "${D2^^}" "$REPO@sha256:xyz"; do
    lm staging deploy "$bad"
    assert_status 2
    assert_contains "$(last_line)" '"reason":"invalid_digest"'
  done
  assert_no_docker_calls
}

@test "args: unknown env, cross-env and unknown subcommand are usage errors" {
  lm qa status
  assert_status 2
  lm staging deploy prod
  assert_status 2
  lm staging frobnicate
  assert_status 2
  assert_no_docker_calls
}

@test "status: emits machine-readable JSON with expected shape" {
  write_state PHASE=switched ACTIVE_COLOR=blue "ACTIVE_DIGEST=$D2" PREVIOUS_COLOR=green "PREVIOUS_DIGEST=$D1" "HISTORY=$D1"
  seed_backups 2
  lm staging status
  assert_status 0
  [ "${#lines[@]}" -eq 1 ]
  assert_no_docker_calls
  if ! command -v python3 >/dev/null; then skip "python3 not available for JSON parsing"; fi
  STATUS_JSON=$output D1=$D1 D2=$D2 python3 - <<'PY'
import json, os
s = json.loads(os.environ["STATUS_JSON"])
assert s["ok"] is True and s["command"] == "status" and s["env"] == "staging", s
assert s["phase"] == "switched"
assert s["active"] == {"color": "blue", "digest": os.environ["D2"]}
assert s["previous"] == {"color": "green", "digest": os.environ["D1"]}
assert s["candidate"] is None
assert s["history"] == [os.environ["D1"]]
assert s["retained"] == [os.environ["D1"]]
assert s["rollbackTargets"] == [os.environ["D1"]]
assert s["deployInProgress"] is False
assert s["lastBackup"] is None
assert s["backups"] == {"count": 2, "latest": "staging-20240101T000011Z-0000002"}
PY
}

@test "status: rejects a tampered state file" {
  printf 'PHASE=idle\nACTIVE_DIGEST=$(id)\n' >"$STATE"
  lm staging status
  assert_status 3
  assert_contains "$(last_line)" '"reason":"state_invalid"'
}

@test "finalize: keeps the 3 most recent images and removes the rest" {
  write_state PHASE=switched ACTIVE_COLOR=blue "ACTIVE_DIGEST=$D4" PREVIOUS_COLOR=green "PREVIOUS_DIGEST=$D3" "HISTORY=$D1 $D2 $D3"
  printf '%s\n' "$D1" "$D2" "$D3" "$D4" "$D5" '<none>' >"$BATS_TEST_TMPDIR/images"
  export FAKE_IMAGE_LIST="$BATS_TEST_TMPDIR/images"
  lm staging finalize
  assert_status 0
  assert_call '--profile green rm -s -f app-green'
  assert_call "image rm $REPO@$D1"
  assert_call "image rm $REPO@$D5"
  refute_call "image rm $REPO@($D2|$D3|$D4)"
  assert_contains "$(last_line)" "\"retained\":[\"$D4\",\"$D3\",\"$D2\"]"
  [ "$(state_get HISTORY)" = "$D2 $D3 $D4" ]
  [ "$(state_get PHASE)" = idle ]
  [ -z "$(state_get PREVIOUS_COLOR)" ]
  [ -f "$ENV_DIR/state/active.json" ]
}

@test "prune: removes leftover partials and trims to 14 backups" {
  seed_backups 16
  : >"$BACKUPS/staging-20250101T000000Z.dump.partial"
  : >"$BACKUPS/staging-20250101T000000Z.dump.partial.list"
  lm staging prune
  assert_status 0
  assert_no_partials
  [ "$(count_files '*.dump')" -eq 14 ]
  [ "$(count_files 'staging-20240101T000010Z-*')" -eq 0 ]
  [ "$(count_files 'staging-20240101T000011Z-*')" -eq 0 ]
}

# ---------------------------------------------------------------------------------------------
# Req 25.7、25.8：Edge_Trusted_Proxies（LM_EDGE_TRUSTED_PROXIES）與 LM_LAN_CIDR 在任何 Docker 動作前驗證
# 範例只使用文件用位址（RFC 5737／3849）與私有網段，不含實際的 Cloudflare 範圍。
# ---------------------------------------------------------------------------------------------

@test "edge: empty or whitespace-only LM_EDGE_TRUSTED_PROXIES skips the check (LM_LAN_CIDR not required)" {
  idle_green
  local v
  for v in '' '   ' $'\t'; do
    : >"$FAKE_DOCKER_LOG"
    set_edge "$v"
    lm staging health green
    assert_status 0
    assert_call 'exec -T proxy wget'
  done
}

@test "edge: a Cloudflare-style IPv4/IPv6 list with an Edge_Proxy subnet is accepted" {
  idle_green
  set_edge $'172.18.0.0/16 192.168.1.121/32 198.51.100.0/24  203.0.113.0/25\t2001:db8::/32 2001:DB8:abcd::/48 64:ff9b::192.0.2.0/120 2001:db8::1 198.51.100.7' \
    192.168.1.0/24
  lm staging health green
  assert_status 0
  assert_call 'exec -T proxy wget'
}

@test "edge: 64 entries are accepted" {
  idle_green
  local i list=""
  for ((i = 0; i < 64; i++)); do list+="10.0.$i.0/24 "; done
  set_edge "$list" 192.168.1.0/24
  lm staging health green
  assert_status 0
}

@test "edge: invalid, prefix-0, IPv4-mapped and LAN-covering entries exit 2 before any docker call" {
  idle_green
  local bad
  for bad in 0.0.0.0/0 ::/0 ::ffff:0:0/96 ::ffff:192.168.1.0/120 ::/8 192.168.0.0/16 192.168.1.0/24 192.0.0.0/2 \
    not-an-ip 10.0.0.256 010.0.0.1 10.0.0.0/33 10.0.0.0/08 2001:db8::/129 2001:db8:::1 1::2::3 fe80::1%eth0 \
    '[2001:db8::1]' 1:2:3:4:5:6:7:8:9 '*' 10.0.0.0/8/9; do
    : >"$FAKE_DOCKER_LOG"
    set_edge "198.51.100.0/24 $bad 2001:db8::/32" 192.168.1.0/24
    lm staging deploy "$D2"
    assert_status 2
    assert_contains "$(last_line)" '"reason":"config_invalid"'
    assert_contains "$(last_line)" '"field":"LM_EDGE_TRUSTED_PROXIES"'
    assert_contains "$(last_line)" "#2 $bad："
    # 只輸出無效項目。
    [[ $(last_line) != *198.51.100.0/24* && $(last_line) != *2001:db8::/32* ]]
    assert_no_docker_calls
  done
}

@test "edge: every invalid entry is reported with its position" {
  idle_green
  set_edge '0.0.0.0/0 198.51.100.0/24 bogus' 192.168.1.0/24
  lm staging deploy "$D2"
  assert_status 2
  assert_contains "$(last_line)" '"invalid":["0.0.0.0/0","bogus"]'
  assert_contains "$(last_line)" '#1 0.0.0.0/0：前綴長度不得為 0'
  assert_contains "$(last_line)" '#3 bogus'
  assert_no_docker_calls
}

@test "edge: more than 64 entries exit 2 before any docker call" {
  idle_green
  local i list=""
  for ((i = 0; i < 65; i++)); do list+="10.0.$i.0/24 "; done
  set_edge "$list" 192.168.1.0/24
  lm staging deploy "$D2"
  assert_status 2
  assert_contains "$(last_line)" '"reason":"config_invalid"'
  assert_contains "$(last_line)" '65 個項目'
  assert_no_docker_calls
}

@test "edge: non-empty LM_EDGE_TRUSTED_PROXIES requires a valid LM_LAN_CIDR" {
  idle_green
  local lan
  for lan in '' 192.168.1.1/24 192.168.1.0/7 192.168.1.0/24, 'a,b' 2001:db8::/32 \
    1.0.0.0/8,2.0.0.0/8,3.0.0.0/8,4.0.0.0/8,5.0.0.0/8,6.0.0.0/8,7.0.0.0/8,8.0.0.0/8,9.0.0.0/8; do
    : >"$FAKE_DOCKER_LOG"
    set_edge 198.51.100.0/24 "$lan"
    lm staging deploy "$D2"
    assert_status 2
    assert_contains "$(last_line)" '"reason":"config_invalid"'
    assert_contains "$(last_line)" '"field":"LM_LAN_CIDR"'
    assert_no_docker_calls
  done
}

# ---------------------------------------------------------------------------------------------
# Req 27.17–27.24：smoke-account（Host_Operator 限定；design.md Components §21.4）
# 測試密碼是固定的非秘密字串，含空白、引號、$、反斜線與 shell 特殊字元。
# ---------------------------------------------------------------------------------------------

SMOKE_PW='not-a-secret Sm0ke "pw" $HOME \ ;|&*'

smoke_setup() {
  idle_green
  export LM_TEST_OPERATOR=1
  printf 'CAMPING_DATABASE_NAME=little_moments\nCAMPING_DATABASE_USER=lm_app\nCAMPING_DATABASE_PASSWORD=placeholder\n' >"$ENV_DIR/app.env"
  PWFILE="$BATS_TEST_TMPDIR/smoke-pw"
  printf '%s\n' "$SMOKE_PW" >"$PWFILE"
  export FAKE_STDIN_DIR="$BATS_TEST_TMPDIR/stdin" FAKE_ENV_LOG="$BATS_TEST_TMPDIR/env.log"
  mkdir -p "$FAKE_STDIN_DIR"
}

# smoke [args...]：以 $PWFILE 為 stdin 執行 lm-deploy staging smoke-account。
smoke() { lm staging smoke-account "$@" <"$PWFILE"; }

assert_no_lock_taken() {
  if [[ -e $LM_LOCK_DIR/lm-staging.lock ]]; then printf 'lock file was created\n'; return 1; fi
}

assert_no_pw_files() {
  local f
  for f in "$ENV_DIR"/state/.smoke-pw.* "$ENV_DIR"/state/.smoke-out.*; do
    if [[ -e $f ]]; then printf 'leftover temp file: %s\n' "$f"; return 1; fi
  done
}

# 密碼不得出現在 lm-deploy 的 stdout／stderr、fake docker 的參數與環境紀錄，或 state/ 下的任何檔案。
assert_pw_not_leaked() {
  if [[ $output == *"$SMOKE_PW"* || $stderr == *"$SMOKE_PW"* ]]; then printf 'password in lm-deploy output\n'; return 1; fi
  if grep -qF -- "$SMOKE_PW" "$FAKE_DOCKER_LOG"; then printf 'password in docker args\n'; return 1; fi
  if [[ -f ${FAKE_ENV_LOG:-/nonexistent} ]] && grep -qF -- "$SMOKE_PW" "$FAKE_ENV_LOG"; then printf 'password in docker env\n'; return 1; fi
  if grep -rqF -- "$SMOKE_PW" "$ENV_DIR/state"; then printf 'password in state/\n'; return 1; fi
}

@test "smoke-account: SSH forced command cannot reach smoke-account (usage, no lock, no docker)" {
  smoke_setup
  local cmd
  for cmd in "smoke-account $D2" "staging smoke-account $D2" "smoke-account staging $D2" \
    "lm-deploy staging smoke-account $REPO@$D2" "/opt/lm/bin/lm-deploy smoke-account $D2 --username smoke-bot" \
    "frobnicate" "--wait"; do
    export SSH_ORIGINAL_COMMAND=$cmd
    lm staging <"$PWFILE"
    assert_status 2
    assert_contains "$(last_line)" '"reason":"usage"'
    assert_contains "$stderr" 'SSH forced command 不允許此子命令'
  done
  unset SSH_ORIGINAL_COMMAND
  assert_no_docker_calls
  assert_no_lock_taken
  assert_no_pw_files
}

@test "SSH forced command: every allowlisted subcommand still passes the allowlist" {
  idle_green
  local cmd
  export SSH_ORIGINAL_COMMAND=status
  lm staging </dev/null
  assert_status 0
  assert_contains "$(last_line)" '"command":"status"'
  export SSH_ORIGINAL_COMMAND='lm-deploy staging health green'
  lm staging </dev/null
  assert_status 0
  assert_contains "$(last_line)" '"healthy":true'
  export SSH_ORIGINAL_COMMAND='health green --wait'
  lm staging </dev/null
  assert_status 0
  for cmd in rollback finalize switch backup prune app-env drill "migrate $D2" start deploy; do
    export SSH_ORIGINAL_COMMAND=$cmd
    lm staging </dev/null
    [[ $stderr != *'不允許此子命令'* ]] || { printf 'allowlisted %s was rejected\n%s\n' "$cmd" "$stderr"; return 1; }
  done
  unset SSH_ORIGINAL_COMMAND
}

@test "smoke-account: SSH_ORIGINAL_COMMAND set (any value) -> operator_only before lock or docker" {
  smoke_setup
  local v
  for v in '' status "smoke-account $D2"; do
    export SSH_ORIGINAL_COMMAND=$v
    smoke "$D2"
    assert_status 2
    assert_contains "$(last_line)" '"reason":"operator_only"'
    run --separate-stderr bash "$LM_DEPLOY" smoke-account staging "$D2" <"$PWFILE"
    assert_status 2
    assert_contains "$(last_line)" '"reason":"operator_only"'
  done
  unset SSH_ORIGINAL_COMMAND
  assert_no_docker_calls
  assert_no_lock_taken
  assert_no_pw_files
}

@test "smoke-account: non-root without LM_TEST_OPERATOR, or SUDO_USER is a deploy account -> operator_only" {
  if [[ $EUID -eq 0 ]]; then skip "must run as non-root"; fi
  smoke_setup
  unset LM_TEST_OPERATOR
  smoke "$D2"
  assert_status 2
  assert_contains "$(last_line)" '"reason":"operator_only"'
  export LM_TEST_OPERATOR=0
  smoke "$D2"
  assert_status 2
  assert_contains "$(last_line)" '"reason":"operator_only"'
  export LM_TEST_OPERATOR=1
  local u
  for u in lm-deploy-staging lm-deploy-prod; do
    export SUDO_USER=$u
    smoke "$D2"
    assert_status 2
    assert_contains "$(last_line)" '"reason":"operator_only"'
  done
  unset SUDO_USER
  assert_no_docker_calls
  assert_no_lock_taken
}

@test "smoke-account: invalid digest and arguments exit 2 before any docker call" {
  smoke_setup
  local bad
  for bad in "sha256:abc" "latest" "$REPO:latest" "other.lan:5000/little-moments@$D2" "${D2^^}" "$REPO@sha256:xyz"; do
    smoke "$bad"
    assert_status 2
    assert_contains "$(last_line)" '"reason":"invalid_digest"'
  done
  local long33 long101
  long33=$(printf 'a%.0s' {1..33})
  long101=$(printf 'f%.0s' {1..101})
  local -a cases=(
    ""
    "$D2 $D3"
    "$D2 --password x"
    "$D2 --username=smoke-bot"
    "$D2 --verbose"
    "$D2 --username"
    "$D2 --fixture"
    "$D2 --username Smoke"
    "$D2 --username ab"
    "$D2 --username a_b"
    "$D2 --username 1abc"
    "$D2 --username $long33"
    "$D2 --username smoke-bot --username smoke-two"
    "$D2 --fixture .hidden"
    "$D2 --fixture -x"
    "$D2 --fixture $long101"
    "$D2 --fixture a --fixture b"
  )
  local c
  for c in "${cases[@]}"; do
    # shellcheck disable=SC2086
    smoke $c
    assert_status 2
    assert_contains "$(last_line)" '"reason":"usage"'
  done
  # 含空白、前後空白或空字串的 fixture（單一參數）。
  for bad in "smoke fixture" " smoke-fixture" "smoke-fixture " ""; do
    smoke "$D2" --fixture "$bad"
    assert_status 2
    assert_contains "$(last_line)" '"reason":"usage"'
  done
  smoke "$D2" --username ""
  assert_status 2
  assert_no_docker_calls
  assert_no_pw_files
}

@test "smoke-account: empty, oversized or NUL-containing stdin exits 2 (password_invalid) without docker" {
  smoke_setup
  lm staging smoke-account "$D2" </dev/null
  assert_status 2
  assert_contains "$(last_line)" '"reason":"password_invalid"'
  head -c 4097 /dev/zero | tr '\0' a >"$PWFILE"
  smoke "$D2"
  assert_status 2
  assert_contains "$(last_line)" '"reason":"password_invalid"'
  printf 'abcdefgh\0ijklmnop\n' >"$PWFILE"
  smoke "$D2"
  assert_status 2
  assert_contains "$(last_line)" '"reason":"password_invalid"'
  assert_no_docker_calls
  assert_no_pw_files
  [ "$(count_files '*.dump')" -eq 0 ]
}

@test "smoke-account: stdin of exactly 4096 bytes is accepted and passed through unchanged" {
  smoke_setup
  head -c 4096 /dev/zero | tr '\0' b >"$PWFILE"
  smoke "$D2"
  assert_status 0
  cmp "$PWFILE" "$FAKE_STDIN_DIR/tool.stdin"
  assert_no_pw_files
}

@test "smoke-account: stdin that is a terminal exits 2 (password_stdin_required)" {
  if ! command -v script >/dev/null; then skip "script(1) not available"; fi
  smoke_setup
  run script -qec "bash '$LM_DEPLOY' staging smoke-account $D2" /dev/null </dev/null
  assert_status 2
  assert_contains "$output" '"reason":"password_stdin_required"'
  assert_no_docker_calls
  assert_no_lock_taken
}

@test "smoke-account: missing app.env or db.env exits 2 (config_missing) without docker" {
  smoke_setup
  local f
  for f in app.env db.env; do
    mv "$ENV_DIR/$f" "$ENV_DIR/$f.bak"
    smoke "$D2"
    assert_status 2
    assert_contains "$(last_line)" '"reason":"config_missing"'
    assert_contains "$(last_line)" "$f"
    mv "$ENV_DIR/$f.bak" "$ENV_DIR/$f"
  done
  assert_no_docker_calls
  assert_no_pw_files
}

@test "smoke-account: held lock exits 4, unfinished deploy exits 3, both without docker" {
  smoke_setup
  local fd
  exec {fd}>>"$LM_LOCK_DIR/lm-staging.lock"
  flock -n "$fd"
  smoke "$D2"
  assert_status 4
  assert_contains "$(last_line)" '"reason":"deploy_in_progress"'
  exec {fd}>&-
  write_state PHASE=started ACTIVE_COLOR=green "ACTIVE_DIGEST=$D1" CANDIDATE_COLOR=blue "CANDIDATE_DIGEST=$D2" "HISTORY=$D1"
  smoke "$D3"
  assert_status 3
  assert_contains "$(last_line)" '"reason":"invalid_phase"'
  assert_no_docker_calls
  assert_no_pw_files
  [ "$(state_get PHASE)" = started ]
}

@test "smoke-account: db/proxy stopped -> up db (wait), up proxy, backup, migrate, tool in order" {
  smoke_setup
  export FAKE_DB_RUNNING=0 FAKE_PROXY_RUNNING=0
  local before
  before=$(sha256sum <"$UPSTREAM")
  smoke "$REPO@$D2"
  assert_status 0
  local pd ud pp up b m t
  pd=$(call_line 'ps --status running -q db')
  ud=$(call_line 'up -d --wait --no-deps db')
  pp=$(call_line 'ps --status running -q proxy')
  up=$(call_line 'up -d --no-deps proxy')
  b=$(call_line 'exec -T db pg_dump')
  m=$(call_line 'run --rm --no-deps -T migrate ')
  t=$(call_line 'run --rm --no-deps -T --entrypoint bun migrate /app/tools/create-smoke-account.js')
  [ "$pd" -gt 0 ]
  [ "$ud" -gt "$pd" ]
  [ "$pp" -gt "$ud" ]
  [ "$up" -gt "$pp" ]
  [ "$b" -gt "$up" ]
  [ "$m" -gt "$b" ]
  [ "$t" -gt "$m" ]
  assert_call "--profile ops run --rm --no-deps -T migrate \\[new=$REPO@$D2\\]"
  assert_call "--profile ops run --rm --no-deps -T --entrypoint bun migrate /app/tools/create-smoke-account.js \\[new=$REPO@$D2\\]"
  refute_call 'up -d --no-deps app-|pull app-|caddy reload|rm -s -f app-'
  [ "$(sha256sum <"$UPSTREAM")" = "$before" ]
  # 只更新最後備份；槽位欄位不變。
  [ "$(state_get PHASE)" = idle ]
  [ "$(state_get ACTIVE_COLOR)" = green ]
  [ "$(state_get ACTIVE_DIGEST)" = "$D1" ]
  [ "$(state_get HISTORY)" = "$D1" ]
  [ -z "$(state_get CANDIDATE_COLOR)" ]
  [ -n "$(state_get LAST_BACKUP_ID)" ]
  [ "$(count_files '*.dump.sha256')" -eq 1 ]
  # 每個步驟一行 JSON。
  [ "${#lines[@]}" -eq 4 ]
  assert_contains "${lines[0]}" '{"ok":true,"command":"services","env":"staging","db":"started","proxy":"started"}'
  assert_contains "${lines[1]}" '"command":"backup"'
  assert_contains "${lines[1]}" '"sha256":'
  assert_contains "${lines[2]}" '"command":"migrate"'
  assert_contains "$(last_line)" "{\"ok\":true,\"command\":\"smoke-account\",\"env\":\"staging\",\"digest\":\"$D2\",\"tool\":{\"ok\":true,\"username\":\"smoke-bot\",\"account\":\"created\""
  assert_no_pw_files
}

@test "smoke-account: running db/proxy are not recreated" {
  smoke_setup
  export FAKE_DB_RUNNING=1 FAKE_PROXY_RUNNING=1
  smoke "$D2"
  assert_status 0
  refute_call 'up -d'
  assert_call 'ps --status running -q db'
  assert_call 'ps --status running -q proxy'
  assert_contains "${lines[0]}" '"db":"running","proxy":"running"'
  assert_call 'create-smoke-account.js'
}

@test "smoke-account: password only reaches the tool's stdin; no leaks, no temp files left" {
  smoke_setup
  export FAKE_DB_RUNNING=0 FAKE_PROXY_RUNNING=0
  smoke "$D2" --username smoke-two --fixture smoke-other
  assert_status 0
  assert_call 'create-smoke-account.js --username smoke-two --fixture smoke-other \['
  cmp "$PWFILE" "$FAKE_STDIN_DIR/tool.stdin"
  [ -f "$FAKE_STDIN_DIR/pg_dump.stdin" ] && [ ! -s "$FAKE_STDIN_DIR/pg_dump.stdin" ]
  [ -f "$FAKE_STDIN_DIR/migrate.stdin" ] && [ ! -s "$FAKE_STDIN_DIR/migrate.stdin" ]
  [ -s "$FAKE_ENV_LOG" ]
  assert_pw_not_leaked
  assert_no_pw_files

  # 失敗路徑（工具失敗）也不留下暫存檔、不洩漏密碼。
  : >"$FAKE_DOCKER_LOG"
  export FAKE_SMOKE_TOOL_OUT='{"ok":false,"reason":"no_admin"}' FAKE_SMOKE_TOOL_RC=1
  smoke "$D2"
  assert_status 1
  assert_pw_not_leaked
  assert_no_pw_files
}

@test "smoke-account: db, proxy, backup and migrate failures stop before the tool" {
  smoke_setup
  local -a cases=(
    "FAKE_DB_RUNNING=0 FAKE_UP_FAIL=1|db_start_failed"
    "FAKE_PS_FAIL=1|db_start_failed"
    "FAKE_PROXY_RUNNING=0 FAKE_PROXY_UP_FAIL=1|proxy_start_failed"
    "FAKE_PG_DUMP_FAIL=1|backup_create_failed"
    "FAKE_PG_RESTORE_LIST_FAIL=1|backup_verify_failed"
    "FAKE_MIGRATE_FAIL=1|migrate_failed"
  )
  local c vars reason v
  for c in "${cases[@]}"; do
    vars=${c%|*}
    reason=${c#*|}
    : >"$FAKE_DOCKER_LOG"
    for v in $vars; do export "$v"; done
    smoke "$D2"
    assert_status 1
    assert_contains "$(last_line)" "\"reason\":\"$reason\""
    refute_call 'create-smoke-account'
    assert_pw_not_leaked
    assert_no_pw_files
    for v in $vars; do unset "${v%%=*}"; done
  done
  # db 啟動失敗時不備份、不遷移；備份失敗時不遷移。
  export FAKE_DB_RUNNING=0 FAKE_UP_FAIL=1
  : >"$FAKE_DOCKER_LOG"
  smoke "$D2"
  refute_call 'pg_dump|-T migrate |up -d --no-deps proxy'
  unset FAKE_DB_RUNNING FAKE_UP_FAIL
  export FAKE_PG_DUMP_FAIL=1
  : >"$FAKE_DOCKER_LOG"
  smoke "$D2"
  refute_call '-T migrate '
  [ "$(state_get ACTIVE_DIGEST)" = "$D1" ]
}

@test "smoke-account: tool failure -> exit 1, smoke_account_failed with embedded reason and JSON" {
  smoke_setup
  export FAKE_SMOKE_TOOL_OUT='{"ok":false,"reason":"no_admin"}' FAKE_SMOKE_TOOL_RC=1
  smoke "$D2"
  assert_status 1
  assert_contains "$(last_line)" '"command":"smoke-account"'
  assert_contains "$(last_line)" '"reason":"smoke_account_failed"'
  assert_contains "$(last_line)" 'Smoke_Provisioner 未完成（no_admin）'
  assert_contains "$(last_line)" '"tool":{"ok":false,"reason":"no_admin"}'

  # 工具輸出含空白或反斜線 → tool 為 null。
  local out
  for out in '{"ok":false, "reason":"no_admin"}' '{"ok":false,"reason":"no\\admin"}' 'not json' ''; do
    export FAKE_SMOKE_TOOL_OUT=$out
    smoke "$D2"
    assert_status 1
    assert_contains "$(last_line)" '"reason":"smoke_account_failed"'
    assert_contains "$(last_line)" '"tool":null'
  done
  assert_no_pw_files
}

# ---------------------------------------------------------------------------------------------
# Req 15.6、15.7、15.9：Production 收據 AI 的金鑰檔（design.md Components §25.4、§25.8）
# 假金鑰在執行時產生（fake_key：sk-test- 加隨機十六進位）；檔案中不含符合金鑰格式的字串。
# ---------------------------------------------------------------------------------------------

KEY_TARGET=/run/secrets/openai-api-key

receipt_setup() {
  use_prod
  idle_green
  install_fake_chown
  export FAKE_ENV_LOG="$BATS_TEST_TMPDIR/env.log"
  IN="$BATS_TEST_TMPDIR/stdin"
}

@test "receipt-ai: prod enabled writes the key file (0400, chown 10001:10001) and compose gets only paths" {
  receipt_setup
  local key
  key=$(fake_key)
  app_env_stdin "$IN" LM_RECEIPT_AI=enabled "LM_OPENAI_API_KEY=$key"
  [ "$(head -n1 "$IN")" = LM_RECEIPT_AI=enabled ]
  lm prod deploy "$D2" --app-env-stdin <"$IN"
  assert_status 0
  # 金鑰檔：內容為輸入加一個換行、0400；secrets/ 為 0700；假 chown 記錄 10001:10001。
  printf '%s\n' "$key" | cmp - "$KEYFILE"
  [ "$(stat -c %a "$KEYFILE")" = 400 ]
  [ "$(stat -c %a "$ENV_DIR/secrets")" = 700 ]
  grep -qE '^10001:10001 -- .*/secrets/\.openai-api-key\.[A-Za-z0-9]+$' "$FAKE_CHOWN_LOG"
  # app.env 只有三個 app.env 鍵，沒有 LM_ 控制鍵或金鑰。
  [ "$(grep -c '' "$ENV_DIR/app.env")" -eq 3 ]
  [ "$(grep -c '^LM_' "$ENV_DIR/app.env")" -eq 0 ]
  # 備份前金鑰檔不存在 → /dev/null；寫入後的 migrate／start／health 皆為金鑰檔路徑與容器內路徑。
  assert_call_fixed "pg_dump -Fc --no-password -U lm_app -d little_moments [new=$REPO@$D1] [openai=/dev/null|]"
  assert_call_fixed "--profile ops run --rm --no-deps -T migrate [new=$REPO@$D2] [openai=$KEYFILE|$KEY_TARGET]"
  assert_call_fixed "--profile blue up -d --no-deps app-blue [new=$REPO@$D2] [openai=$KEYFILE|$KEY_TARGET]"
  assert_call_fixed "[openai=$KEYFILE|$KEY_TARGET]"
  local app_env
  app_env=$(grep '"command":"app-env"' <<<"$output")
  assert_contains "$app_env" '"keys":["CAMPING_DATABASE_NAME","CAMPING_DATABASE_USER","CAMPING_DATABASE_PASSWORD"],"receiptAi":"enabled"}'
  [[ $app_env != *LM_RECEIPT_AI* && $app_env != *LM_OPENAI_API_KEY* ]]
  [ "$(state_get PHASE)" = switched ]
  [ -s "$FAKE_ENV_LOG" ]
  assert_secret_not_leaked "$key"
  assert_no_receipt_tmp
}

@test "receipt-ai: prod disabled deletes the key file; prod without the switch leaves it unchanged" {
  receipt_setup
  local old
  old=$(fake_key)
  put_key_file "$old"
  app_env_stdin "$IN" LM_RECEIPT_AI=disabled
  lm prod deploy "$D2" --app-env-stdin <"$IN"
  assert_status 0
  [ ! -e "$KEYFILE" ]
  assert_contains "$(grep '"command":"app-env"' <<<"$output")" '"receiptAi":"disabled"}'
  assert_call_fixed "--profile blue up -d --no-deps app-blue [new=$REPO@$D2] [openai=/dev/null|]"
  # 刪除後（migrate 之後）的呼叫都不再掛載金鑰檔。
  refute_call '(-T migrate|up -d --no-deps app-blue|proxy wget|caddy reload) .*openai=[^]]*secrets'
  assert_secret_not_leaked "$old"
  assert_no_receipt_tmp

  # 未提供開關（尚未更新的 Jenkinsfile）：金鑰檔不變，receiptAi 依金鑰檔是否存在。
  idle_green
  put_key_file "$old"
  : >"$FAKE_DOCKER_LOG"
  app_env_stdin "$IN"
  lm prod deploy "$D2" --app-env-stdin <"$IN"
  assert_status 0
  printf '%s\n' "$old" | cmp - "$KEYFILE"
  assert_contains "$(grep '"command":"app-env"' <<<"$output")" '"receiptAi":"enabled"}'
  assert_call_fixed "--profile blue up -d --no-deps app-blue [new=$REPO@$D2] [openai=$KEYFILE|$KEY_TARGET]"

  idle_green
  rm -f "$KEYFILE"
  : >"$FAKE_DOCKER_LOG"
  lm prod deploy "$D2" --app-env-stdin <"$IN"
  assert_status 0
  [ ! -e "$KEYFILE" ]
  assert_contains "$(grep '"command":"app-env"' <<<"$output")" '"receiptAi":"disabled"}'
  assert_secret_not_leaked "$old"
  assert_no_receipt_tmp
}

@test "receipt-ai: invalid switch/key combinations exit 2 before backup or docker; key file unchanged" {
  receipt_setup
  local old key hex
  old=$(fake_key)
  put_key_file "$old"
  key=$(fake_key)
  hex=${key#sk-test-}
  local -a cases=(
    "LM_RECEIPT_AI=enabled"
    "LM_RECEIPT_AI=enabled|LM_OPENAI_API_KEY=$key|LM_OPENAI_API_KEY=$key"
    "LM_RECEIPT_AI=enabled|LM_OPENAI_API_KEY=$key x"
    "LM_RECEIPT_AI=enabled|LM_OPENAI_API_KEY=pk-test-$hex"
    "LM_RECEIPT_AI=enabled|LM_OPENAI_API_KEY=sk-$(rep a 19)"
    "LM_RECEIPT_AI=enabled|LM_OPENAI_API_KEY=sk-$(rep a 501)"
    "LM_RECEIPT_AI=disabled|LM_OPENAI_API_KEY=$key"
    "LM_OPENAI_API_KEY=$key"
    "LM_RECEIPT_AI=on|LM_OPENAI_API_KEY=$key"
    "LM_RECEIPT_AI=on"
    "LM_RECEIPT_AI=enabled|LM_RECEIPT_AI=enabled|LM_OPENAI_API_KEY=$key"
    "LM_RECEIPT_AI=disabled|LM_RECEIPT_AI=disabled"
  )
  local c
  local -a parts
  for c in "${cases[@]}"; do
    IFS='|' read -r -a parts <<<"$c"
    app_env_stdin "$IN" "${parts[@]}"
    lm prod deploy "$D2" --app-env-stdin <"$IN"
    assert_status 2
    assert_contains "$(last_line)" '"reason":"app_env_invalid"'
    assert_no_docker_calls
    [ "$(count_files '*.dump')" -eq 0 ]
    printf '%s\n' "$old" | cmp - "$KEYFILE"
    [ "$(stat -c %a "$KEYFILE")" = 400 ]
    [ ! -s "$FAKE_CHOWN_LOG" ]
    [ ! -e "$ENV_DIR/app.env" ]
    assert_secret_not_leaked "$hex"
    assert_secret_not_leaked "$old"
    assert_no_receipt_tmp
  done
  [ "$(state_get PHASE)" = idle ]
}

@test "receipt-ai: staging rejects enabled or any key (receipt_ai_forbidden); disabled is accepted" {
  idle_green
  export FAKE_ENV_LOG="$BATS_TEST_TMPDIR/env.log"
  IN="$BATS_TEST_TMPDIR/stdin"
  local key hex c
  key=$(fake_key)
  hex=${key#sk-test-}
  local -a parts cases=(
    "LM_RECEIPT_AI=enabled|LM_OPENAI_API_KEY=$key"
    "LM_RECEIPT_AI=enabled"
    "LM_OPENAI_API_KEY=$key"
    "LM_RECEIPT_AI=disabled|LM_OPENAI_API_KEY=$key"
  )
  for c in "${cases[@]}"; do
    IFS='|' read -r -a parts <<<"$c"
    app_env_stdin "$IN" "${parts[@]}"
    lm staging deploy "$D2" --app-env-stdin <"$IN"
    assert_status 2
    assert_contains "$(last_line)" '"reason":"receipt_ai_forbidden"'
    assert_no_docker_calls
    [ "$(count_files '*.dump')" -eq 0 ]
    [ ! -e "$ENV_DIR/secrets" ]
    assert_secret_not_leaked "$hex"
    assert_no_receipt_tmp
  done

  app_env_stdin "$IN" LM_RECEIPT_AI=disabled
  lm staging deploy "$D2" --app-env-stdin <"$IN"
  assert_status 0
  assert_contains "$(grep '"command":"app-env"' <<<"$output")" '"receiptAi":"disabled"}'
  assert_call_fixed "--profile blue up -d --no-deps app-blue [new=$REPO@$D2] [openai=/dev/null|]"
  refute_call 'openai=[^]]*secrets'
  [ ! -e "$ENV_DIR/secrets" ]
  [ "$(grep -c '^LM_' "$ENV_DIR/app.env")" -eq 0 ]
  assert_no_receipt_tmp
}

@test "receipt-ai: app-env subcommand rejects LM_RECEIPT_AI and LM_OPENAI_API_KEY (app_env_invalid)" {
  receipt_setup
  local key hex l
  key=$(fake_key)
  hex=${key#sk-test-}
  for l in LM_RECEIPT_AI=enabled LM_RECEIPT_AI=disabled "LM_OPENAI_API_KEY=$key"; do
    app_env_stdin "$IN" "$l"
    lm prod app-env <"$IN"
    assert_status 2
    assert_contains "$(last_line)" '"reason":"app_env_invalid"'
    assert_contains "$(last_line)" "不允許的鍵：${l%%=*}"
    [ ! -e "$ENV_DIR/app.env" ]
    [ ! -e "$KEYFILE" ]
    assert_secret_not_leaked "$hex"
    assert_no_receipt_tmp
  done
  # 只有 app.env 鍵時照常寫入，結果行沒有 receiptAi。
  app_env_stdin "$IN"
  lm prod app-env <"$IN"
  assert_status 0
  [[ $(last_line) != *receiptAi* ]]
  assert_no_docker_calls
}

@test "receipt-ai: build_compose rejects a bad prod key path and any staging key file (config_invalid, no docker)" {
  receipt_setup
  local key
  key=$(fake_key)
  mkdir -m 0700 "$ENV_DIR/secrets"
  # 符號連結、目錄、空檔、超過 512 位元組。
  printf '%s\n' "$key" >"$BATS_TEST_TMPDIR/elsewhere"
  ln -s "$BATS_TEST_TMPDIR/elsewhere" "$KEYFILE"
  lm prod health green
  assert_status 2
  assert_contains "$(last_line)" '"reason":"config_invalid"'
  rm -f "$KEYFILE"
  mkdir "$KEYFILE"
  lm prod health green
  assert_status 2
  assert_contains "$(last_line)" '"reason":"config_invalid"'
  rmdir "$KEYFILE"
  : >"$KEYFILE"
  lm prod rollback
  assert_status 2
  assert_contains "$(last_line)" '"reason":"config_invalid"'
  rm -f "$KEYFILE"
  head -c 513 /dev/zero | tr '\0' a >"$KEYFILE"
  lm prod health green
  assert_status 2
  assert_contains "$(last_line)" '"reason":"config_invalid"'
  rm -f "$KEYFILE"
  # secrets/ 本身是符號連結。
  rmdir "$ENV_DIR/secrets"
  mkdir -m 0700 "$BATS_TEST_TMPDIR/secrets-elsewhere"
  ln -s "$BATS_TEST_TMPDIR/secrets-elsewhere" "$ENV_DIR/secrets"
  lm prod health green
  assert_status 2
  assert_contains "$(last_line)" '"reason":"config_invalid"'
  rm -f "$ENV_DIR/secrets"
  assert_no_docker_calls
  # 1–512 位元組的一般檔案可以使用。
  put_key_file "$key"
  lm prod health green
  assert_status 0
  assert_call_fixed "[openai=$KEYFILE|$KEY_TARGET]"

  # Staging 有金鑰檔即 config_invalid。
  : >"$FAKE_DOCKER_LOG"
  mkdir -m 0700 "$LM_ROOT/staging/secrets"
  printf '%s\n' "$key" >"$LM_ROOT/staging/secrets/openai-api-key"
  lm staging health green
  assert_status 2
  assert_contains "$(last_line)" '"reason":"config_invalid"'
  assert_contains "$(last_line)" 'Staging 不得有 OpenAI 金鑰檔'
  assert_no_docker_calls
  assert_secret_not_leaked "$key"
}

@test "receipt-ai: non-empty CAMPING_OPENAI_* or LM_OPENAI_KEY_SOURCE in <env>.env is config_invalid; caller env is ignored" {
  idle_green
  cp "$ENV_DIR/staging.env" "$BATS_TEST_TMPDIR/staging.env.orig"
  local l
  for l in CAMPING_OPENAI_MODEL_ID=gpt-x LM_OPENAI_KEY_SOURCE=/x CAMPING_OPENAI_API_KEY_FILE=/run/secrets/openai-api-key \
    'export CAMPING_OPENAI_IMAGE_DETAIL=low' 'CAMPING_OPENAI_MAX_COMPLETION_TOKENS = "100"'; do
    cp "$BATS_TEST_TMPDIR/staging.env.orig" "$ENV_DIR/staging.env"
    printf '%s\n' "$l" >>"$ENV_DIR/staging.env"
    lm staging deploy "$D2"
    assert_status 2
    assert_contains "$(last_line)" '"reason":"config_invalid"'
    assert_contains "$(last_line)" '必須保持空白'
    assert_no_docker_calls
  done
  # 空白值（含空引號）可以使用。
  cp "$BATS_TEST_TMPDIR/staging.env.orig" "$ENV_DIR/staging.env"
  printf 'CAMPING_OPENAI_MODEL_ID=\nCAMPING_OPENAI_IMAGE_DETAIL=""\nLM_OPENAI_KEY_SOURCE=\n' >>"$ENV_DIR/staging.env"
  lm staging health green
  assert_status 0
  # 呼叫端環境中的 LM_OPENAI_KEY_SOURCE／CAMPING_OPENAI_API_KEY_FILE 被忽略。
  : >"$FAKE_DOCKER_LOG"
  export LM_OPENAI_KEY_SOURCE=/etc/hostname CAMPING_OPENAI_API_KEY_FILE=/etc/hostname
  lm staging health green
  assert_status 0
  unset LM_OPENAI_KEY_SOURCE CAMPING_OPENAI_API_KEY_FILE
  assert_call_fixed "[openai=/dev/null|]"
  refute_call '/etc/hostname'
}

@test "receipt-ai: rollback without stdin keeps the key file; backup failure leaves the key file unchanged" {
  receipt_setup
  local old key hex c
  old=$(fake_key)
  put_key_file "$old"
  write_state PHASE=switched ACTIVE_COLOR=blue "ACTIVE_DIGEST=$D2" PREVIOUS_COLOR=green "PREVIOUS_DIGEST=$D1" "HISTORY=$D1"
  render_upstream blue
  lm prod rollback </dev/null
  assert_status 0
  printf '%s\n' "$old" | cmp - "$KEYFILE"
  assert_call_fixed "--profile blue rm -s -f app-blue [new=$REPO@$D2] [openai=$KEYFILE|$KEY_TARGET]"
  refute_call 'openai=/dev/null'

  # 手動回滾重新建立的槽位依金鑰檔掛載。
  write_state PHASE=idle ACTIVE_COLOR=blue "ACTIVE_DIGEST=$D3" "HISTORY=$D1 $D2 $D3"
  : >"$FAKE_DOCKER_LOG"
  lm prod rollback "$D2" </dev/null
  assert_status 0
  assert_call_fixed "--profile green up -d --no-deps app-green [new=$REPO@$D2] [openai=$KEYFILE|$KEY_TARGET]"
  printf '%s\n' "$old" | cmp - "$KEYFILE"

  # 備份失敗：enabled 的新金鑰與 disabled 都不改變金鑰檔。
  idle_green
  key=$(fake_key)
  hex=${key#sk-test-}
  export FAKE_PG_DUMP_FAIL=1
  local -a parts
  for c in "LM_RECEIPT_AI=enabled|LM_OPENAI_API_KEY=$key" "LM_RECEIPT_AI=disabled"; do
    : >"$FAKE_DOCKER_LOG"
    IFS='|' read -r -a parts <<<"$c"
    app_env_stdin "$IN" "${parts[@]}"
    lm prod deploy "$D2" --app-env-stdin <"$IN"
    assert_status 1
    assert_contains "$(last_line)" '"reason":"backup_create_failed"'
    refute_call 'migrate'
    printf '%s\n' "$old" | cmp - "$KEYFILE"
    [ ! -e "$ENV_DIR/app.env" ]
    assert_secret_not_leaked "$hex"
    assert_no_receipt_tmp
  done
}
