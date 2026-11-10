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
