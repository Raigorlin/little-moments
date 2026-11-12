#!/usr/bin/env bats
# deploy/host/install.sh --render-rules 與 verify-host.sh --check-rules 的行為測試（tasks.md 21.2；
# Requirements 8.6、8.8–8.10、25.8；design.md Components §12、§18.4、§18.5）。
#
# 兩個模式都是唯讀、不需要 root：install.sh 只把渲染後的 DOCKER-USER 規則輸出到 stdout，verify-host.sh 只檢查
# 指定的規則檔與 <env>.env。每個測試以 BATS_TEST_TMPDIR 下的 LM_SRV_ROOT 取代 /srv/lm。
#
# 執行：bats deploy/tests/install-host.bats（需要 bash ≥ 4.4 與 GNU coreutils；不需要 iptables、Docker 或 root）。

bats_require_minimum_version 1.5.0

load helpers/test_helper

INSTALL="$REPO_ROOT/deploy/host/install.sh"
VERIFY="$REPO_ROOT/deploy/host/verify-host.sh"
LAN=192.168.1.0/24,172.17.0.0/16

R_EST='-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN'
R_LAN1='-A DOCKER-USER -s 192.168.1.0/24 -m conntrack --ctstate DNAT -j RETURN'
R_LAN2='-A DOCKER-USER -s 172.17.0.0/16 -m conntrack --ctstate DNAT -j RETURN'
R_DROP='-A DOCKER-USER -m conntrack --ctstate DNAT -j DROP'
R_LAST='-A DOCKER-USER -j RETURN'
r_port() { printf -- '-A DOCKER-USER -p tcp -m conntrack --ctstate DNAT --ctorigdstport %s -j RETURN' "$1"; }

setup() {
  export LM_SRV_ROOT="$BATS_TEST_TMPDIR/srv"
  mkdir -p "$LM_SRV_ROOT"
  RULES_FILE="$BATS_TEST_TMPDIR/docker-user.rules"
}

render() { run --separate-stderr bash "$INSTALL" --render-rules --lan-cidr "$LAN" "$@"; }
verify() { run --separate-stderr bash "$VERIFY" --check-rules "$RULES_FILE" "$@"; }

# write_env <env> KEY=VALUE...：建立 $LM_SRV_ROOT/<env>/<env>.env。
write_env() {
  local env=$1
  shift
  mkdir -p "$LM_SRV_ROOT/$env"
  printf '%s\n' "$@" >"$LM_SRV_ROOT/$env/$env.env"
}

# 同主機配置的兩個環境：staging 不經 Edge_Proxy；prod 經 Edge_Proxy（文件用位址，非實際 Cloudflare 範圍）。
write_host_envs() {
  write_env staging LM_PUBLIC_PORT=8081 LM_EDGE_TRUSTED_PROXIES= LM_LAN_CIDR=
  write_env prod LM_PUBLIC_PORT=8082 'LM_EDGE_TRUSTED_PROXIES=172.18.0.0/16 198.51.100.0/24 2001:db8::/32' \
    LM_LAN_CIDR=192.168.1.0/24
}

# rules_file <rule>...：以 iptables-restore 格式寫入固定規則檔。
rules_file() {
  { printf '*filter\n:DOCKER-USER - [0:0]\n'; printf '%s\n' "$@"; printf 'COMMIT\n'; } >"$RULES_FILE"
}

rule_lines() { grep '^-A ' <<<"$output" || true; }

# ---------------------------------------------------------------------------------------------
# install.sh --render-rules（Req 8.8–8.10）
# ---------------------------------------------------------------------------------------------

@test "render: without --public-port the output is identical to the LAN-only rules" {
  render
  assert_status 0
  local expected
  expected=$(printf '%s\n' \
    '# 由 deploy/host/install.sh 產生；請勿手動編輯（樣板：deploy/host/docker-user.rules）。' \
    '# 允許的 LAN 網段：192.168.1.0/24 172.17.0.0/16' \
    '*filter' ':DOCKER-USER - [0:0]' "$R_EST" "$R_LAN1" "$R_LAN2" "$R_DROP" "$R_LAST" 'COMMIT')
  [ "$output" = "$expected" ]
  [[ $output != *ctorigdstport* && $output != *Public_Port* ]]
}

@test "render: --public-port 80,443 adds one rule per port after every LAN RETURN and before DROP, in input order" {
  render --public-port 80,443
  assert_status 0
  local expected
  expected=$(printf '%s\n' "$R_EST" "$R_LAN1" "$R_LAN2" "$(r_port 80)" "$(r_port 443)" "$R_DROP" "$R_LAST")
  [ "$(rule_lines)" = "$expected" ]
  assert_contains "$output" '# Public_Port（接受任何來源的 TCP 連線）：80 443'
  [[ $output != *__PUBLIC_PORT__* && $output != *__LAN_CIDR__* ]]

  render --public-port 443,80
  assert_status 0
  expected=$(printf '%s\n' "$R_EST" "$R_LAN1" "$R_LAN2" "$(r_port 443)" "$(r_port 80)" "$R_DROP" "$R_LAST")
  [ "$(rule_lines)" = "$expected" ]
}

@test "render: invalid --public-port values exit 2 without output" {
  local v
  for v in 0 65536 08 abc '80,,443' '80,' ',80' '80,80' '1,2,3,4,5,6,7,8,9' '' '80 443'; do
    render --public-port "$v"
    if [[ $status -ne 2 || -n $output || $stderr != *--public-port* ]]; then
      printf 'value <%s>: status %s\nstdout: %s\nstderr: %s\n' "$v" "$status" "$output" "$stderr"
      return 1
    fi
  done
  # 8 個是上限，仍然接受。
  render --public-port 1,2,3,4,5,6,7,65535
  assert_status 0
}

@test "install: --public-port format errors exit 2 before the root check" {
  run --separate-stderr bash "$INSTALL" --lan-cidr "$LAN" --public-port 08
  assert_status 2
  assert_contains "$stderr" '--public-port 項目無效'
  [[ $stderr != *root* ]]
}

@test "render: a Public_Port equal to an installed <env>.env LM_PUBLIC_PORT exits 2 naming the port and env" {
  write_env staging LM_PUBLIC_PORT=9001
  write_env prod 'LM_PUBLIC_PORT="9002"'
  render --public-port 80,9001
  assert_status 2
  [ -z "$output" ]
  assert_contains "$stderr" '--public-port 9001 等於 staging 的 LM_PUBLIC_PORT'
  render --public-port 9002,443
  assert_status 2
  assert_contains "$stderr" '--public-port 9002 等於 prod 的 LM_PUBLIC_PORT'
  # 已安裝的 <env>.env 優先於範本（範本的 staging 為 8081）。
  render --public-port 8081
  assert_status 0
}

@test "render: without an installed <env>.env the template's LM_PUBLIC_PORT is used for envs in --envs" {
  render --public-port 80,8082
  assert_status 2
  assert_contains "$stderr" '--public-port 8082 等於 prod 的 LM_PUBLIC_PORT'
  assert_contains "$stderr" 'deploy/compose/prod.env.example'
  render --public-port 8081
  assert_status 2
  assert_contains "$stderr" 'staging 的 LM_PUBLIC_PORT'
  # prod 不在本次 --envs、主機上也沒有 prod.env：不檢查 prod。
  render --envs staging --public-port 8082
  assert_status 0
}

@test "render: does not write anything under LM_SRV_ROOT" {
  write_host_envs
  local before after
  before=$(find "$LM_SRV_ROOT" -printf '%p %s %T@\n' | sort)
  render --public-port 80,443
  assert_status 0
  after=$(find "$LM_SRV_ROOT" -printf '%p %s %T@\n' | sort)
  [ "$before" = "$after" ]
}

# ---------------------------------------------------------------------------------------------
# verify-host.sh --check-rules：Public_Port 解析與順序（Req 8.8、8.9）
# ---------------------------------------------------------------------------------------------

@test "verify: rendered rules with Public_Port 80,443 pass and match --public-port and --lan-cidr" {
  write_host_envs
  render --public-port 80,443
  printf '%s\n' "$output" >"$RULES_FILE"
  verify --lan-cidr "$LAN" --public-port 443,80
  assert_status 0
  assert_contains "$output" 'PASS firewall Public_Port 與預期相同（80,443）'
  assert_contains "$output" 'PASS firewall 允許的 LAN 網段與預期相同（172.17.0.0/16,192.168.1.0/24）'
  assert_contains "$output" '依序為已建立連線、LAN 網段、Public_Port、DNAT DROP、RETURN'
  assert_contains "$output" 'PASS firewall Public_Port 未與任一環境的 LM_PUBLIC_PORT 相同'

  verify --public-port none
  assert_status 1
  assert_contains "$output" 'FAIL firewall Public_Port 為 80,443，預期 none'
}

@test "verify: rules without Public_Port match --public-port none" {
  write_host_envs
  render
  printf '%s\n' "$output" >"$RULES_FILE"
  verify --public-port none
  assert_status 0
  assert_contains "$output" 'PASS firewall Public_Port 與預期相同（none）'
  verify --public-port 80
  assert_status 1
}

@test "verify: a Public_Port rule after DROP or before a LAN rule fails the order check" {
  write_host_envs
  rules_file "$R_EST" "$R_LAN1" "$R_DROP" "$(r_port 443)" "$R_LAST"
  verify
  assert_status 1
  assert_contains "$output" 'FAIL firewall'
  assert_contains "$output" 'Public_Port 規則必須位於所有 LAN 網段規則之後、DROP 之前'

  rules_file "$R_EST" "$(r_port 443)" "$R_LAN1" "$R_DROP" "$R_LAST"
  verify
  assert_status 1
  assert_contains "$output" 'Public_Port 規則必須位於所有 LAN 網段規則之後、DROP 之前'

  rules_file "$R_EST" "$R_LAN1" "$(r_port 443)" "$R_LAN2" "$R_DROP" "$R_LAST"
  verify
  assert_status 1
  assert_contains "$output" 'LAN 網段規則位置錯誤'
}

@test "verify: a Public_Port equal to an env LM_PUBLIC_PORT, duplicated or out of range fails" {
  write_host_envs
  rules_file "$R_EST" "$R_LAN1" "$(r_port 443)" "$(r_port 8082)" "$R_DROP" "$R_LAST"
  verify
  assert_status 1
  assert_contains "$output" 'FAIL firewall Public_Port 8082 等於 prod 的 LM_PUBLIC_PORT'

  rules_file "$R_EST" "$R_LAN1" "$(r_port 443)" "$(r_port 443)" "$R_DROP" "$R_LAST"
  verify
  assert_status 1
  assert_contains "$output" 'Public_Port 重複：443'

  rules_file "$R_EST" "$R_LAN1" "$(r_port 70000)" "$R_DROP" "$R_LAST"
  verify
  assert_status 1
  assert_contains "$output" 'Public_Port 無效：70000'
}

# ---------------------------------------------------------------------------------------------
# verify-host.sh proxy 檢查（Req 25.7、25.8；design.md §18.4）
# ---------------------------------------------------------------------------------------------

@test "proxy: valid prod Edge_Trusted_Proxies pass; staging with Edge values warns" {
  write_host_envs
  render --public-port 80,443
  printf '%s\n' "$output" >"$RULES_FILE"
  verify
  assert_status 0
  assert_contains "$output" '[prod] LM_EDGE_TRUSTED_PROXIES 的 3 個項目與 LM_LAN_CIDR 皆有效'
  assert_contains "$output" '[staging] LM_EDGE_TRUSTED_PROXIES 為空'
  [[ $output != *"WARN proxy"* ]]

  write_env staging LM_PUBLIC_PORT=8081 LM_EDGE_TRUSTED_PROXIES=172.18.0.0/16 LM_LAN_CIDR=192.168.1.0/24
  verify
  assert_status 0
  assert_contains "$output" 'WARN proxy    [staging] 設有 LM_EDGE_TRUSTED_PROXIES'
}

@test "proxy: Public_Port declared while prod Edge_Trusted_Proxies is empty warns" {
  write_env staging LM_PUBLIC_PORT=8081
  write_env prod LM_PUBLIC_PORT=8082 LM_EDGE_TRUSTED_PROXIES= LM_LAN_CIDR=
  render --public-port 80,443
  printf '%s\n' "$output" >"$RULES_FILE"
  verify
  assert_status 0
  assert_contains "$output" 'WARN proxy    [prod] 已宣告 Public_Port（80 443）但 LM_EDGE_TRUSTED_PROXIES 為空'

  render
  printf '%s\n' "$output" >"$RULES_FILE"
  verify
  assert_status 0
  [[ $output != *"WARN proxy"* ]]
}

@test "proxy: invalid, prefix-0, LAN-covering entries and a missing LM_LAN_CIDR fail" {
  write_env staging LM_PUBLIC_PORT=8081
  render
  printf '%s\n' "$output" >"$RULES_FILE"
  local tc edge lan want
  for tc in '0.0.0.0/0|192.168.1.0/24|前綴長度不得為 0' \
    '192.168.0.0/16|192.168.1.0/24|涵蓋 LM_LAN_CIDR 網段 192.168.1.0/24' \
    '<npm-docker-subnet>|192.168.1.0/24|不是有效的 IPv4 位址或 CIDR' \
    '::ffff:0:0/96|192.168.1.0/24|IPv4-mapped' \
    '172.18.0.0/16||LM_LAN_CIDR 未設定'; do
    IFS='|' read -r edge lan want <<<"$tc"
    write_env prod LM_PUBLIC_PORT=8082 "LM_EDGE_TRUSTED_PROXIES=$edge" "LM_LAN_CIDR=$lan"
    verify
    if [[ $status -ne 1 || $output != *"FAIL proxy    [prod]"*"$want"* ]]; then
      printf 'case <%s>: status %s\n%s\n' "$tc" "$status" "$output"
      return 1
    fi
  done
}
