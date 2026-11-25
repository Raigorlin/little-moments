#!/usr/bin/env bats
# deploy/bin/lm-deploy 的行為測試（tasks.md 14.4；Requirements 14.3、14.5、18.7、20.4、20.9、20.12；plan.md D6–D8）。
#
# 以 PATH 中假的 docker（helpers/fake-docker：Supabase stack、遷移、pg_dump／pg_restore 經 `docker compose exec -T ...`
# 與 `docker create／cp／rm`）與不等待的 sleep 執行；每個測試在 BATS_TEST_TMPDIR 有獨立的 LM_ROOT、備份目錄與鎖目錄。
# app.env 由真正的 deploy/bin/lm-supabase-keys 產生。
#
# 執行：bats deploy/tests/lm-deploy.bats（需要 bash ≥ 4.4、GNU coreutils、util-linux flock、openssl；不需要 Docker）。

bats_require_minimum_version 1.5.0

load helpers/test_helper

setup() { setup_fixture; }

idle_green() { write_state PHASE=idle ACTIVE_COLOR=green "ACTIVE_DIGEST=$D1" "HISTORY=$D1"; }

# fresh_backup：state 記錄一份剛完成的已驗證備份（migrate 的前提）。
fresh_backup() {
  seed_backups 1
  idle_green
  printf 'LAST_BACKUP_ID=staging-20240101T000010Z-0000001\nLAST_BACKUP_AT=%s\n' "$(date -u +%s)" >>"$STATE"
}

# ---------------------------------------------------------------------------------------------
# deploy 的順序：app.env → stack → backup → migrate → start → health → switch
# ---------------------------------------------------------------------------------------------

@test "deploy: happy path runs app.env -> stack -> backup -> migrate -> start -> health -> switch in order" {
  idle_green
  rm -f "$ENV_DIR/app.env"
  lm staging deploy "$D2" --app-env-stdin <"$APP_ENV_FILE"
  assert_status 0
  local db setup auth rt gw ha hr hg dump create cp mig up hp reload
  db=$(call_line 'up -d --wait --no-deps db ')
  setup=$(call_line 'exec -T db psql .* -U supabase_admin .* -q -f - ')
  auth=$(call_line 'up -d --no-deps auth ')
  rt=$(call_line 'up -d --no-deps realtime ')
  gw=$(call_line 'up -d --no-deps gateway ')
  ha=$(call_line 'exec -T gateway wget .*http://auth:9999/health')
  hr=$(call_line 'exec -T gateway wget .*http://realtime:4000/healthcheck')
  hg=$(call_line 'exec -T gateway sh -c .*/auth/v1/health')
  dump=$(call_line 'exec -T db sh -c .*pg_dump')
  create=$(call_line "^create $REPO@$D2\$")
  cp=$(call_line '^cp [0-9a-f]+:/app/migrations/\. ')
  mig=$(call_line '--single-transaction -f - ')
  up=$(call_line 'up -d --no-deps app-blue ')
  hp=$(call_line 'exec -T proxy wget .*http://app-blue:8080/robots.txt')
  reload=$(call_line 'caddy reload')
  [ "$db" -gt 0 ]
  [ "$setup" -gt "$db" ]
  [ "$auth" -gt "$setup" ]
  [ "$rt" -gt "$auth" ]
  [ "$gw" -gt "$rt" ]
  [ "$ha" -gt "$gw" ]
  [ "$hr" -gt "$ha" ]
  [ "$hg" -gt "$hr" ]
  [ "$dump" -gt "$hg" ]
  [ "$create" -gt "$dump" ]
  [ "$cp" -gt "$create" ]
  [ "$mig" -gt "$cp" ]
  [ "$up" -gt "$mig" ]
  [ "$hp" -gt "$up" ]
  [ "$reload" -gt "$hp" ]
  # 每個步驟一行 JSON。
  [ "${#lines[@]}" -eq 7 ]
  assert_contains "${lines[0]}" '"command":"app-env"'
  assert_contains "${lines[1]}" '{"ok":true,"command":"stack","env":"staging","services":["db","auth","realtime","gateway"]'
  assert_contains "${lines[2]}" '"command":"backup"'
  assert_contains "${lines[3]}" '"command":"migrate"'
  assert_contains "${lines[3]}" '"applied":["20250101000000_app_schema.sql","20250102000000_profiles.sql"],"skipped":[]'
  assert_contains "${lines[4]}" '"command":"start"'
  assert_contains "${lines[5]}" '"command":"health"'
  assert_contains "${lines[6]}" '"command":"switch"'
  # Compose 一律以 <env>.env 與 app.env 兩個 --env-file 執行。
  assert_call_fixed "--env-file $ENV_DIR/staging.env --env-file $ENV_DIR/app.env"
  assert_call_fixed "--profile blue up -d --no-deps app-blue [blue=$REPO@$D2 green=$REPO@$D1]"
  grep -q 'reverse_proxy app-blue:8080' "$UPSTREAM"
  cmp "$APP_ENV_FILE" "$ENV_DIR/app.env"
  [ "$(stat -c %a "$ENV_DIR/app.env")" = 600 ]
  [ "$(state_get PHASE)" = switched ]
  [ "$(state_get ACTIVE_COLOR)" = blue ]
  [ "$(state_get ACTIVE_DIGEST)" = "$D2" ]
  [ "$(state_get PREVIOUS_COLOR)" = green ]
  [ "$(count_files '*.dump.sha256')" -eq 1 ]
  assert_no_app_env_tmp
}

@test "deploy: app.env is written before the stack; its secrets never reach docker args, env or output" {
  idle_green
  rm -f "$ENV_DIR/app.env"
  export FAKE_ENV_LOG="$BATS_TEST_TMPDIR/env.log"
  lm staging deploy "$D2" --app-env-stdin <"$APP_ENV_FILE"
  assert_status 0
  assert_contains "${lines[0]}" '{"ok":true,"command":"app-env","env":"staging","keys":["LM_DB_PASSWORD","LM_JWT_SECRET","LM_ANON_KEY","LM_SERVICE_KEY","LM_JWT_KEYS","LM_JWKS","LM_REALTIME_SECRET_KEY_BASE","LM_REALTIME_DB_ENC_KEY"]}'
  local k v
  while IFS='=' read -r k v; do
    assert_secret_not_leaked "$v"
  done <"$APP_ENV_FILE"
  # db-setup.sql 經 stdin 交給 psql（容器內以 \getenv 讀取密碼）。
  export FAKE_STDIN_DIR="$BATS_TEST_TMPDIR/stdin"
  mkdir -p "$FAKE_STDIN_DIR"
  idle_green
  lm staging deploy "$D3"
  assert_status 0
  cmp "$ENV_DIR/supabase/db-setup.sql" "$FAKE_STDIN_DIR/setup.stdin"
}

@test "deploy: without app.env and without --app-env-stdin -> config_missing before any docker call" {
  idle_green
  rm -f "$ENV_DIR/app.env"
  lm staging deploy "$D2"
  assert_status 2
  assert_contains "$(last_line)" '"reason":"config_missing"'
  assert_contains "$(last_line)" 'app.env'
  assert_no_docker_calls
  lm staging health green
  assert_status 2
  assert_contains "$(last_line)" '"reason":"config_missing"'
  assert_no_docker_calls
}

@test "deploy: missing supabase/db-setup.sql or gateway.Caddyfile -> config_missing before any docker call" {
  idle_green
  local f
  for f in db-setup.sql gateway.Caddyfile; do
    mv "$ENV_DIR/supabase/$f" "$BATS_TEST_TMPDIR/$f"
    lm staging deploy "$D2"
    assert_status 2
    assert_contains "$(last_line)" '"reason":"config_missing"'
    assert_contains "$(last_line)" "supabase/$f"
    mv "$BATS_TEST_TMPDIR/$f" "$ENV_DIR/supabase/$f"
  done
  assert_no_docker_calls
}

# ---------------------------------------------------------------------------------------------
# app.env 驗證（plan.md D6、D16）：在任何 docker 指令前
# ---------------------------------------------------------------------------------------------

@test "app.env: unknown keys, bad formats, duplicates and missing keys are rejected before any docker call" {
  idle_green
  local in="$BATS_TEST_TMPDIR/in" good
  good=$(cat "$APP_ENV_FILE")
  local -a cases=(
    "CAMPING_DATABASE_PASSWORD=x|不允許的鍵：CAMPING_DATABASE_PASSWORD"
    "LM_DB_PASSWORD=short|LM_DB_PASSWORD"
    "LM_DB_PASSWORD=$(printf 'G%.0s' {1..48})|LM_DB_PASSWORD"
    "LM_JWT_SECRET=$(printf 'a%.0s' {1..31})|LM_JWT_SECRET"
    "LM_REALTIME_DB_ENC_KEY=0123456789abcdef0|LM_REALTIME_DB_ENC_KEY"
    "LM_REALTIME_SECRET_KEY_BASE=abc|LM_REALTIME_SECRET_KEY_BASE"
    "LM_ANON_KEY=not-a-jwt|LM_ANON_KEY"
    "LM_SERVICE_KEY=a.b.c d|LM_SERVICE_KEY"
    'LM_JWT_KEYS={"kty":"EC"}|LM_JWT_KEYS'
    'LM_JWKS=[{"kty":"oct"}]|LM_JWKS'
    'LM_JWKS={"keys": []}|LM_JWKS'
    'LM_JWT_KEYS=[{"k":"$(id)"}]|LM_JWT_KEYS'
    "LM_DB_PASSWORD=|LM_DB_PASSWORD"
    "lowercase=x|KEY=VALUE"
  )
  local c line want key
  for c in "${cases[@]}"; do
    line=${c%|*}
    want=${c##*|}
    key=${line%%=*}
    # 以無效的一行取代同名鍵（或加在最後）。
    { grep -v "^$key=" <<<"$good" || true; printf '%s\n' "$line"; } >"$in"
    lm staging deploy "$D2" --app-env-stdin <"$in"
    assert_status 2
    assert_contains "$(last_line)" '"reason":"app_env_invalid"'
    assert_contains "$(last_line)" "$want"
    assert_no_docker_calls
    [ "$(count_files '*.dump')" -eq 0 ]
    assert_no_app_env_tmp
  done
  # 重複的鍵、缺少的鍵、CR、空 stdin。
  { printf '%s\n' "$good"; grep '^LM_JWKS=' <<<"$good"; } >"$in"
  lm staging app-env <"$in"
  assert_status 2
  assert_contains "$(last_line)" '重複的鍵：LM_JWKS'
  grep -v '^LM_REALTIME_DB_ENC_KEY=' <<<"$good" >"$in"
  lm staging app-env <"$in"
  assert_status 2
  assert_contains "$(last_line)" '缺少必要的鍵：LM_REALTIME_DB_ENC_KEY'
  sed 's/$/\r/' <<<"$good" >"$in"
  lm staging app-env <"$in"
  assert_status 2
  assert_contains "$(last_line)" 'CR'
  lm staging app-env </dev/null
  assert_status 2
  assert_contains "$(last_line)" 'stdin 沒有內容'
  # 原本的 app.env 不變；錯誤訊息不含任何值。
  cmp "$APP_ENV_FILE" "$ENV_DIR/app.env"
  assert_no_docker_calls
  assert_no_app_env_tmp
}

@test "app-env: valid input is written 0600 atomically and only key names are printed" {
  local in="$BATS_TEST_TMPDIR/in"
  bash "$KEYS_TOOL" env staging >"$in"
  printf '# comment\n\n' >>"$in"
  lm staging app-env <"$in"
  assert_status 0
  [ "${#lines[@]}" -eq 1 ]
  assert_contains "$output" '"keys":["LM_DB_PASSWORD","LM_JWT_SECRET","LM_ANON_KEY","LM_SERVICE_KEY","LM_JWT_KEYS","LM_JWKS","LM_REALTIME_SECRET_KEY_BASE","LM_REALTIME_DB_ENC_KEY"]'
  cmp "$in" "$ENV_DIR/app.env"
  [ "$(stat -c %a "$ENV_DIR/app.env")" = 600 ]
  local v
  v=$(sed -n 's/^LM_JWT_SECRET=//p' "$in")
  [[ $output != *"$v"* && $stderr != *"$v"* ]]
  assert_no_docker_calls
  assert_no_app_env_tmp
}

# ---------------------------------------------------------------------------------------------
# <env>.env 驗證：LM_ALLOWED_HOSTS、LM_HEALTH_HOST、LM_SITE_URL、LM_PUBLIC_SIGNUP（plan.md D9、D12）
# ---------------------------------------------------------------------------------------------

@test "config: invalid LM_ALLOWED_HOSTS, LM_SITE_URL or LM_PUBLIC_SIGNUP exit 2 before any docker call" {
  idle_green
  cp "$ENV_DIR/staging.env" "$BATS_TEST_TMPDIR/staging.env.orig"
  local -a cases=(
    "LM_ALLOWED_HOSTS=|LM_ALLOWED_HOSTS"
    "LM_ALLOWED_HOSTS=lm.lan *|LM_ALLOWED_HOSTS"
    "LM_ALLOWED_HOSTS=lm.lan *.example.test|LM_ALLOWED_HOSTS"
    "LM_ALLOWED_HOSTS=lm.lan bad_host|LM_ALLOWED_HOSTS"
    "LM_ALLOWED_HOSTS=lm.lan 192.0.2.300|LM_ALLOWED_HOSTS"
    "LM_ALLOWED_HOSTS=other.lan 192.0.2.10|必須包含 LM_HEALTH_HOST"
    "LM_ALLOWED_HOSTS=lm.lan,192.0.2.10|LM_ALLOWED_HOSTS"
    "LM_ALLOWED_HOSTS=lm.lan $(printf 'h%d.lan ' {1..16})|LM_ALLOWED_HOSTS"
    "LM_HEALTH_HOST=|LM_HEALTH_HOST"
    "LM_SITE_URL=|LM_SITE_URL"
    "LM_SITE_URL=www.our-littlemoments.com|LM_SITE_URL"
    "LM_SITE_URL=https://www.our-littlemoments.com/app|LM_SITE_URL"
    "LM_SITE_URL=ftp://lm.lan|LM_SITE_URL"
    "LM_PUBLIC_SIGNUP=|LM_PUBLIC_SIGNUP"
    "LM_PUBLIC_SIGNUP=yes|LM_PUBLIC_SIGNUP"
  )
  local c
  for c in "${cases[@]}"; do
    cp "$BATS_TEST_TMPDIR/staging.env.orig" "$ENV_DIR/staging.env"
    printf '%s\n' "${c%|*}" >>"$ENV_DIR/staging.env"
    lm staging deploy "$D2"
    assert_status 2
    assert_contains "$(last_line)" '"reason":"config_invalid"'
    assert_contains "$(last_line)" "${c##*|}"
    assert_no_docker_calls
  done
  # 16 個項目、https origin 帶連接埠與 true 皆可。
  cp "$BATS_TEST_TMPDIR/staging.env.orig" "$ENV_DIR/staging.env"
  printf 'LM_ALLOWED_HOSTS=lm.lan %s\nLM_SITE_URL=https://www.our-littlemoments.com:8443\nLM_PUBLIC_SIGNUP=true\n' \
    "$(printf 'h%d.lan ' {1..15})" >>"$ENV_DIR/staging.env"
  lm staging health green
  assert_status 0
}

# ---------------------------------------------------------------------------------------------
# stack（plan.md D6）：失敗即停止，不備份
# ---------------------------------------------------------------------------------------------

@test "stack: each failing step stops the deploy before backup with its own reason" {
  idle_green
  local -a cases=(
    "FAKE_STACK_FAIL=db|stack_db_failed"
    "FAKE_STACK_FAIL=setup|stack_setup_failed"
    "FAKE_STACK_FAIL=auth|stack_auth_failed"
    "FAKE_STACK_FAIL=realtime|stack_realtime_failed"
    "FAKE_STACK_FAIL=gateway|stack_gateway_failed"
    "FAKE_STACK_UNHEALTHY=auth|stack_auth_failed"
    "FAKE_STACK_UNHEALTHY=realtime|stack_realtime_failed"
    "FAKE_STACK_UNHEALTHY=gateway|stack_gateway_failed"
  )
  local c
  for c in "${cases[@]}"; do
    : >"$FAKE_DOCKER_LOG"
    export "${c%|*}"
    lm staging deploy "$D2"
    assert_status 1
    assert_contains "$(last_line)" '"command":"stack"'
    assert_contains "$(last_line)" "\"reason\":\"${c##*|}\""
    refute_call 'pg_dump|^create |up -d --no-deps app-|caddy reload'
    unset FAKE_STACK_FAIL FAKE_STACK_UNHEALTHY
  done
  # setup 失敗時不啟動 auth；db 失敗時不執行 db-setup.sql。
  export FAKE_STACK_FAIL=db
  : >"$FAKE_DOCKER_LOG"
  lm staging deploy "$D2"
  refute_call 'psql|up -d --no-deps auth'
  export FAKE_STACK_FAIL=setup
  : >"$FAKE_DOCKER_LOG"
  lm staging deploy "$D2"
  refute_call 'up -d --no-deps auth'
  # 健康檢查重試 LM_STACK_TRIES 次。
  unset FAKE_STACK_FAIL
  export FAKE_STACK_UNHEALTHY=auth
  : >"$FAKE_DOCKER_LOG"
  lm staging deploy "$D2"
  [ "$(grep -c 'http://auth:9999/health' "$FAKE_DOCKER_LOG")" -eq 2 ]
  [ "$(count_files '*.dump')" -eq 0 ]
  [ "$(state_get PHASE)" = idle ]
  [ "$(state_get ACTIVE_DIGEST)" = "$D1" ]
}

# ---------------------------------------------------------------------------------------------
# Req 14.3：備份（plan.md D8）失敗 → 不遷移、不動容器
# ---------------------------------------------------------------------------------------------

@test "deploy: pg_dump failure aborts before migrate and leaves no partial" {
  idle_green
  export FAKE_PG_DUMP_FAIL=1
  lm staging deploy "$D2"
  assert_status 1
  assert_contains "$(last_line)" '"reason":"backup_create_failed"'
  assert_call 'exec -T db sh -c PGPASSWORD=\$POSTGRES_PASSWORD exec pg_dump -Fc --no-password -h /run/postgresql -U supabase_admin -d postgres --data-only --schema=app --schema=auth --exclude-table=auth.schema_migrations'
  refute_call '^create |--single-transaction'
  refute_call 'up -d --no-deps app-|pull app-|caddy reload'
  assert_no_partials
  [ "$(count_files '*.dump')" -eq 0 ]
  [ "$(state_get PHASE)" = idle ]
  [ "$(state_get ACTIVE_DIGEST)" = "$D1" ]
}

@test "deploy: pg_restore --list failure, an empty dump or no TABLE DATA fail verification before migrate" {
  idle_green
  local v
  for v in FAKE_PG_RESTORE_LIST_FAIL=1 FAKE_PG_DUMP_EMPTY=1 FAKE_LIST_NO_DATA=1; do
    : >"$FAKE_DOCKER_LOG"
    export "$v"
    lm staging deploy "$D2"
    assert_status 1
    assert_contains "$(last_line)" '"reason":"backup_verify_failed"'
    refute_call '^create |--single-transaction|up -d --no-deps app-'
    assert_no_partials
    [ "$(count_files '*.dump')" -eq 0 ]
    [ "$(count_files '*.tmp')" -eq 0 ]
    unset "${v%%=*}"
  done
}

@test "backup: data-only dump of app and auth; emptyDatabase means no app.* TABLE DATA" {
  lm staging backup
  assert_status 0
  assert_contains "$(last_line)" '"tables":3,"appTables":2,"emptyDatabase":false'
  export FAKE_LIST_NO_APP=1
  lm staging backup
  assert_status 0
  assert_contains "$(last_line)" '"tables":1,"appTables":0,"emptyDatabase":true'
  local id
  id=$(state_get LAST_BACKUP_ID)
  (cd "$BACKUPS" && sha256sum -c --status "$id.dump.sha256")
  grep -q '"emptyDatabase":true' "$BACKUPS/$id.json"
  # pg_dump 的指令列不含密碼（只有容器內的 $POSTGRES_PASSWORD）。
  local pw
  pw=$(sed -n 's/^LM_DB_PASSWORD=//p' "$ENV_DIR/app.env")
  [ "$(grep -cF -- "$pw" "$FAKE_DOCKER_LOG")" -eq 0 ]
}

# ---------------------------------------------------------------------------------------------
# 遷移（plan.md D7）
# ---------------------------------------------------------------------------------------------

@test "migrate: refuses without a recent verified backup" {
  idle_green
  lm staging migrate "$D2"
  assert_status 3
  assert_contains "$(last_line)" '"reason":"backup_required"'
  assert_no_docker_calls
  # 備份過舊也一樣。
  seed_backups 1
  printf 'LAST_BACKUP_ID=staging-20240101T000010Z-0000001\nLAST_BACKUP_AT=%s\n' "$(($(date -u +%s) - 7200))" >>"$STATE"
  lm staging migrate "$D2"
  assert_status 3
  assert_contains "$(last_line)" '"reason":"backup_required"'
  assert_no_docker_calls
}

@test "migrate: extracts /app/migrations from the new image, waits for realtime.messages, applies each file with its record" {
  fresh_backup
  mig_dir 20250101000000_a.sql 20250102000000_b.sql 20250103000000_c.sql
  export FAKE_STDIN_DIR="$BATS_TEST_TMPDIR/stdin"
  mkdir -p "$FAKE_STDIN_DIR"
  lm staging migrate "$REPO@$D2"
  assert_status 0
  assert_contains "$(last_line)" "\"digest\":\"$D2\""
  assert_contains "$(last_line)" '"applied":["20250101000000_a.sql","20250102000000_b.sql","20250103000000_c.sql"],"skipped":[]'
  assert_call "^create $REPO@$D2\$"
  assert_call '^rm -f 0123456789abcdef'
  assert_call "to_regclass\\('realtime.messages'\\)"
  assert_call 'create schema if not exists lm_ops'
  [ "$(grep -c -- '-U postgres -d postgres -v ON_ERROR_STOP=1 --no-psqlrc -q --single-transaction -f - ' "$FAKE_DOCKER_LOG")" -eq 3 ]
  # 每個檔案的內容之後是同一個交易內的 INSERT（版本與 sha256）。
  local sha
  sha=$(sha256sum "$FAKE_MIGRATIONS_DIR/20250102000000_b.sql" | cut -d' ' -f1)
  grep -qF -- '-- 20250102000000_b.sql' "$FAKE_STDIN_DIR/migrations.stdin"
  grep -qF -- "INSERT INTO lm_ops.schema_migrations (version, sha256) VALUES ('20250102000000_b', '$sha');" "$FAKE_STDIN_DIR/migrations.stdin"
  # 暫存目錄已移除；不啟動任何容器。
  [ -z "$(compgen -G "$ENV_DIR/state/.migrations.*" || true)" ]
  refute_call 'up -d|caddy reload'
}

@test "migrate: realtime.messages missing -> tenant health via the gateway, then migrate_failed after the retries" {
  fresh_backup
  export FAKE_REALTIME_MESSAGES=f
  lm staging migrate "$D2"
  assert_status 1
  assert_contains "$(last_line)" '"reason":"migrate_failed"'
  assert_contains "$(last_line)" 'realtime.messages'
  assert_call 'exec -T gateway sh -c .*/realtime/v1/api/tenants/realtime-dev/health'
  [ "$(grep -c "to_regclass" "$FAKE_DOCKER_LOG")" -eq 3 ]
  refute_call '--single-transaction'
}

@test "migrate: already-applied files are skipped; only the new file is applied" {
  fresh_backup
  mig_dir 20250101000000_a.sql 20250102000000_b.sql 20250103000000_c.sql
  applied 20250101000000_a.sql 20250102000000_b.sql
  export FAKE_STDIN_DIR="$BATS_TEST_TMPDIR/stdin"
  mkdir -p "$FAKE_STDIN_DIR"
  lm staging migrate "$D2"
  assert_status 0
  assert_contains "$(last_line)" '"applied":["20250103000000_c.sql"],"skipped":["20250101000000_a.sql","20250102000000_b.sql"]'
  [ "$(grep -c -- '--single-transaction' "$FAKE_DOCKER_LOG")" -eq 1 ]
  [ "$(grep -cF -- '-- 20250101000000_a.sql' "$FAKE_STDIN_DIR/migrations.stdin")" -eq 0 ]
}

@test "migrate: a changed sha256 of an applied file fails with migration_changed and applies nothing" {
  fresh_backup
  mig_dir 20250101000000_a.sql 20250102000000_b.sql 20250103000000_c.sql
  applied 20250101000000_a.sql 20250102000000_b.sql
  printf -- '-- edited\n' >>"$FAKE_MIGRATIONS_DIR/20250102000000_b.sql"
  lm staging migrate "$D2"
  assert_status 1
  assert_contains "$(last_line)" '"reason":"migration_changed"'
  assert_contains "$(last_line)" '"migration":"20250102000000_b.sql"'
  assert_contains "$(last_line)" '"applied":[]'
  refute_call '--single-transaction'
}

@test "migrate: a failing file stops before later files; the deploy does not start a container" {
  idle_green
  mig_dir 20250101000000_a.sql 20250102000000_b.sql 20250103000000_c.sql
  export FAKE_MIGRATION_FAIL=20250102000000_b
  lm staging deploy "$D2"
  assert_status 1
  assert_contains "$(last_line)" '"reason":"migrate_failed"'
  assert_contains "$(last_line)" '"migration":"20250102000000_b.sql"'
  assert_contains "$(last_line)" '"applied":["20250101000000_a.sql"]'
  [ "$(grep -c -- '--single-transaction' "$FAKE_DOCKER_LOG")" -eq 2 ]
  refute_call 'up -d --no-deps app-|pull app-|caddy reload'
  [ "$(state_get PHASE)" = idle ]
  [ "$(state_get ACTIVE_DIGEST)" = "$D1" ]
}

@test "migrate: invalid file names, an empty /app/migrations or a failing docker create/cp are migrate_failed" {
  fresh_backup
  local -a names=("20250101000000_a.sql bad.sql" "2025010100000_short.sql" "20250101000000_Upper.sql" "20250101000000_a.txt")
  local n
  for n in "${names[@]}"; do
    : >"$FAKE_DOCKER_LOG"
    # shellcheck disable=SC2086
    mig_dir $n
    lm staging migrate "$D2"
    assert_status 1
    assert_contains "$(last_line)" '"reason":"migrate_failed"'
    refute_call '--single-transaction'
  done
  mig_dir
  lm staging migrate "$D2"
  assert_status 1
  assert_contains "$(last_line)" '沒有任何遷移檔'
  unset FAKE_MIGRATIONS_DIR
  local v
  for v in FAKE_CREATE_FAIL=1 FAKE_CP_FAIL=1; do
    : >"$FAKE_DOCKER_LOG"
    export "$v"
    lm staging migrate "$D2"
    assert_status 1
    assert_contains "$(last_line)" '"reason":"migrate_failed"'
    refute_call '--single-transaction'
    unset "${v%%=*}"
  done
  # docker cp 失敗時仍移除暫存容器（cleanup）。
  assert_call '^rm -f 0123456789abcdef'
  [ -z "$(compgen -G "$ENV_DIR/state/.migrations.*" || true)" ]
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
  lm staging app-env <"$APP_ENV_FILE"
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
# Req 20.4：健康失敗 → 不切換（GET /robots.txt on 8080）
# ---------------------------------------------------------------------------------------------

@test "health: GET http://app-<color>:8080/robots.txt through the proxy with the health Host" {
  idle_green
  lm staging health green
  assert_status 0
  assert_contains "$(last_line)" '"healthy":true'
  assert_call 'exec -T proxy wget -q -O - --header Host: lm.lan -T 5 http://app-green:8080/robots.txt'
  refute_call 'healthz|5173'
}

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
  assert_call "up -d --no-deps app-blue \\[blue=$REPO@$D2 "
  assert_call 'exec -T proxy wget .*http://app-blue:8080/robots.txt'
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

@test "deploy: refuses while a previous deploy is unfinished (phase switched)" {
  write_state PHASE=switched ACTIVE_COLOR=blue "ACTIVE_DIGEST=$D2" PREVIOUS_COLOR=green "PREVIOUS_DIGEST=$D1" "HISTORY=$D1"
  lm staging deploy "$D3" --app-env-stdin <"$APP_ENV_FILE"
  assert_status 3
  assert_contains "$(last_line)" '"reason":"invalid_phase"'
  assert_no_docker_calls
}

# ---------------------------------------------------------------------------------------------
# Req 20.9：回滾不執行遷移
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
  refute_call 'migrations|--single-transaction|^create '
  grep -q 'reverse_proxy app-green:8080' "$UPSTREAM"
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
  refute_call 'migrations|--single-transaction|^create '
  refute_call 'caddy reload'
  [ "$(sha256sum <"$UPSTREAM")" = "$before" ]
  [ "$(state_get PHASE)" = idle ]
}

@test "rollback (auto): nothing to roll back when idle" {
  idle_green
  lm staging rollback
  assert_status 3
  assert_contains "$(last_line)" '"reason":"nothing_to_rollback"'
  refute_call 'migrations|--single-transaction'
}

@test "rollback <digest>: switches to a retained digest without migrate" {
  write_state PHASE=idle ACTIVE_COLOR=blue "ACTIVE_DIGEST=$D3" "HISTORY=$D1 $D2 $D3"
  render_upstream blue
  lm staging rollback "$REPO@$D1"
  assert_status 0
  assert_contains "$(last_line)" '"mode":"manual"'
  assert_contains "$(last_line)" '"migrationsRun":false'
  assert_call "up -d --no-deps app-green \\[blue=$REPO@$D3 green=$REPO@$D1\\]"
  assert_call 'exec -T proxy wget .*http://app-green:8080/robots.txt'
  assert_call 'caddy reload'
  refute_call 'migrations|--single-transaction|^create '
  refute_call 'pg_dump'
  grep -q 'reverse_proxy app-green:8080' "$UPSTREAM"
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
  refute_call 'migrations|--single-transaction'
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

@test "args: unknown env, cross-env, unknown and removed subcommands are usage errors" {
  lm qa status
  assert_status 2
  lm staging deploy prod
  assert_status 2
  lm staging frobnicate
  assert_status 2
  lm staging smoke-account "$D2"
  assert_status 2
  assert_contains "$(last_line)" '"reason":"usage"'
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
# 還原演練（Req 14.6、14.7；plan.md D8）
# ---------------------------------------------------------------------------------------------

drill_setup() {
  idle_green
  seed_backups 3
  seed_real_backup
  export FAKE_STDIN_DIR="$BATS_TEST_TMPDIR/stdin"
  mkdir -p "$FAKE_STDIN_DIR"
}

@test "drill: restores data-only into a fresh stack migrated from the active image, verifies counts and never prunes" {
  drill_setup
  local before
  before=$(ls "$BACKUPS" | sort)
  lm staging drill
  assert_status 0
  [ "${#lines[@]}" -eq 1 ]
  assert_contains "$output" '"ok":true,"command":"drill","env":"staging","project":"lm-drill-staging-'
  assert_contains "$output" "\"backupId\":\"$BACKUP_ID\""
  assert_contains "$output" "\"digest\":\"$D1\""
  assert_contains "$output" '"result":"pass","failedStep":null'
  assert_contains "$output" '"migrations":{"applied":["20250101000000_app_schema.sql","20250102000000_profiles.sql"],"skipped":[]}'
  assert_contains "$output" '"verify":{"authUsers":3,"profiles":2}'
  assert_contains "$output" '"cleanedUp":true,"backupCount":4'
  # 順序：db（+ db-setup.sql）→ auth、realtime、gateway → 遷移（目前作用中的映像）→ pg_restore --data-only → 驗證 → down -v。
  local db setup gw create mig restore verify down
  db=$(call_line '-p lm-drill-staging-[0-9a-f]{8} .* up -d --wait --no-deps db ')
  setup=$(call_line '-p lm-drill-staging-.* exec -T db psql .* -q -f - ')
  gw=$(call_line '-p lm-drill-staging-.* up -d --no-deps gateway ')
  create=$(call_line "^create $REPO@$D1\$")
  mig=$(call_line '-p lm-drill-staging-.* --single-transaction -f - ')
  restore=$(call_line '-p lm-drill-staging-.* exec -T db pg_restore --data-only --disable-triggers ')
  verify=$(call_line 'count\(\*\) from auth.users')
  down=$(call_line '-p lm-drill-staging-.* down -v --remove-orphans')
  [ "$db" -gt 0 ]
  [ "$setup" -gt "$db" ]
  [ "$gw" -gt "$setup" ]
  [ "$create" -gt "$gw" ]
  [ "$mig" -gt "$create" ]
  [ "$restore" -gt "$mig" ]
  [ "$verify" -gt "$restore" ]
  [ "$down" -gt "$verify" ]
  # 備份內容原樣交給 pg_restore；只使用 drill.yaml 與拋棄式 drill.env，不碰正式專案或 app.env。
  cmp "$BACKUPS/$BACKUP_ID.dump" "$FAKE_STDIN_DIR/restore.stdin"
  assert_call_fixed "-f $ENV_DIR/drill.yaml --env-file $ENV_DIR/state/.drill."
  refute_call "compose --project-directory $ENV_DIR -f $ENV_DIR/compose.yaml"
  refute_call "app.env"
  # 備份一份都沒有被刪除；秘密暫存目錄已刪除；正式狀態不變。
  [ "$(ls "$BACKUPS" | sort)" = "$before" ]
  [ -z "$(compgen -G "$ENV_DIR/state/.drill.*" || true)" ]
  [ "$(stat -c %a "$ENV_DIR/state/drill-last.log")" = 600 ]
  [ "$(state_get ACTIVE_DIGEST)" = "$D1" ]
  [ "$(state_get PHASE)" = idle ]
}

@test "drill: failing steps report failedStep, tear the project down and keep every backup" {
  drill_setup
  local before
  before=$(ls "$BACKUPS" | sort)
  local -a cases=(
    "FAKE_STACK_FAIL=db|stack_db_failed|db_start"
    "FAKE_STACK_FAIL=setup|stack_setup_failed|db_start"
    "FAKE_STACK_UNHEALTHY=realtime|stack_realtime_failed|stack_start"
    "FAKE_CREATE_FAIL=1|migrate_failed|migrate"
    "FAKE_RESTORE_FAIL=1|restore_failed|restore"
    "FAKE_DRILL_COUNTS=2 5|verify_failed|verify"
    "FAKE_DRILL_COUNTS=garbage|verify_failed|verify"
  )
  local c v reason step
  for c in "${cases[@]}"; do
    v=${c%%|*}
    reason=${c#*|}
    reason=${reason%|*}
    step=${c##*|}
    : >"$FAKE_DOCKER_LOG"
    export "$v"
    lm staging drill
    assert_status 1
    assert_contains "$(last_line)" "\"reason\":\"$reason\""
    assert_contains "$(last_line)" "\"result\":\"fail\",\"failedStep\":\"$step\""
    assert_contains "$(last_line)" '"cleanedUp":true'
    assert_call 'down -v --remove-orphans'
    [ "$(ls "$BACKUPS" | sort)" = "$before" ]
    [ -z "$(compgen -G "$ENV_DIR/state/.drill.*" || true)" ]
    unset "${v%%=*}"
  done
}

@test "drill: a checksum mismatch fails at backup_verify before any compose call" {
  drill_setup
  printf 'tampered\n' >>"$BACKUPS/$BACKUP_ID.dump"
  lm staging drill
  assert_status 1
  assert_contains "$(last_line)" '"reason":"backup_checksum_mismatch"'
  assert_contains "$(last_line)" '"failedStep":"backup_verify"'
  refute_call '^compose'
  [ -f "$BACKUPS/$BACKUP_ID.dump" ]
}

@test "drill: needs an active digest, drill.yaml, supabase/ files and lm-supabase-keys" {
  drill_setup
  write_state PHASE=idle
  lm staging drill
  assert_status 3
  assert_contains "$(last_line)" '"reason":"no_active_slot"'
  idle_green
  rm "$LM_BIN_DIR/lm-supabase-keys"
  lm staging drill
  assert_status 2
  assert_contains "$(last_line)" 'lm-supabase-keys'
  cp "$KEYS_TOOL" "$LM_BIN_DIR/lm-supabase-keys"
  rm "$ENV_DIR/supabase/gateway.Caddyfile"
  lm staging drill
  assert_status 2
  assert_contains "$(last_line)" 'supabase/gateway.Caddyfile'
  assert_no_docker_calls
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
# Req 27.18：SSH forced command 只接受 SSH_SUBCOMMANDS
# ---------------------------------------------------------------------------------------------

@test "SSH forced command: subcommands outside the allowlist are usage errors before lock or docker" {
  idle_green
  local cmd
  for cmd in "smoke-account $D2" "staging smoke-account $D2" "frobnicate" "--wait" "lm-deploy staging frobnicate"; do
    export SSH_ORIGINAL_COMMAND=$cmd
    lm staging </dev/null
    assert_status 2
    assert_contains "$(last_line)" '"reason":"usage"'
    assert_contains "$stderr" 'SSH forced command 不允許此子命令'
  done
  unset SSH_ORIGINAL_COMMAND
  assert_no_docker_calls
  [[ ! -e $LM_LOCK_DIR/lm-staging.lock ]]
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
