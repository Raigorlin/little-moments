#!/usr/bin/env bash
# Deploy_Host 主機安全設定驗證（Requirement 8.6、8.8–8.10、11.10、14.4、15.9、25.7、25.8；design.md
# Components §12、§18.4、§18.5、Security Boundaries）。唯讀：只讀取設定與狀態，不修改任何檔案、規則、帳號或容器。
#
# 用法：
#   sudo deploy/host/verify-host.sh [--envs staging,prod] [--lan-cidr <CIDR>[,...]] [--public-port <port>[,...]|none]
#   deploy/host/verify-host.sh --check-rules <規則檔> [--envs ...] [--lan-cidr ...] [--public-port ...]
#
#   --envs         要檢查的環境（預設 staging,prod）
#   --lan-cidr     預期的 LAN 網段；指定時另外比對 /etc/lm/docker-user.rules 的網段是否完全相同
#   --public-port  預期的 Public_Port（install.sh --public-port 的值）；指定時另外比對規則檔的 Public_Port
#                  集合是否完全相同；none 表示預期沒有任何 Public_Port
#   --check-rules  唯讀、不需 root：只對指定的規則檔執行 firewall 的靜態檢查與 proxy 檢查，不查詢 iptables、
#                  systemd、Docker 與帳號（測試用）。只有此模式接受環境變數 LM_SRV_ROOT（預設 /srv/lm）
#                  覆寫 <env>.env 的讀取位置。
#
# 檢查項目（每項輸出一行 PASS／FAIL／WARN）：
#   firewall  lm-docker-user.service 已 enable 且 active；/etc/lm/docker-user.rules 依序為「已建立連線 RETURN →
#             LAN 網段 RETURN → Public_Port RETURN → DNAT DROP → RETURN」，網段不是 /0，Public_Port 為 1–65535、
#             不重複、最多 8 個且不等於任一環境 <env>.env 的 LM_PUBLIC_PORT（Req 8.8、8.9）；每條規則都已載入
#             （iptables -C），且 DOCKER-USER 開頭依序正是這些規則（沒有其他規則插在 DROP 之前）；
#             FORWARD 第一條為 -j DOCKER-USER；lm-<env> proxy 的發布連接埠綁定特定位址而非 0.0.0.0／::。
#   proxy     各環境 <env>.env 的 LM_EDGE_TRUSTED_PROXIES 與 LM_LAN_CIDR 符合 lm-deploy 的驗證規則（1–64 個
#             IPv4／IPv6 位址或 CIDR、前綴不為 0、非 IPv4-mapped IPv6、不涵蓋 LM_LAN_CIDR 任一整個網段；
#             非空時 LM_LAN_CIDR 必須為 1–8 個 IPv4 網路位址/8–/32；Req 25.7、25.8）。staging 設有
#             Edge_Trusted_Proxies，或規則檔宣告了 Public_Port 但 prod 的 Edge_Trusted_Proxies 為空時 WARN。
#   db        compose.yaml 解析後 db 服務沒有 ports；執行中的 db 容器沒有任何發布連接埠、不是 host 網路。
#   backup    /var/backups/little-moments 與 <env>/ 為 lm-ops 擁有、0700、不是符號連結；其下所有檔案
#             皆為 lm-ops 擁有且群組／其他人無任何權限；不在 Docker 資料目錄內、不在 git 工作目錄內。
#   account   lm-deploy-<env> 存在、未設定密碼、不在 docker（或 docker.sock 所屬群組）及其他特權群組；
#             `sudo -l -U` 只列出「(root) NOPASSWD: /opt/lm/bin/lm-deploy <env>」一項；authorized_keys
#             為 root 擁有，每把金鑰都有 forced command、from= 與 no-pty（或 restrict）；兩環境金鑰不同。
#   files     /opt/lm/bin/lm-deploy 與上層目錄、/srv/lm/<env> 為 root 擁有且群組／其他人不可寫；
#             /etc/sudoers.d/lm-deploy 為 root 0440 且 visudo -c 通過；app.env／db.env 為 0600 root。
#
# 結束碼：0 沒有 FAIL；1 至少一項 FAIL；2 參數錯誤或未以 root 執行。

set -euo pipefail
umask 077
export LC_ALL=C
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

readonly OPS_USER=lm-ops
readonly LM_BIN=/opt/lm/bin/lm-deploy
readonly BACKUP_ROOT=/var/backups/little-moments
readonly UNIT_NAME=lm-docker-user.service
readonly SUDOERS_FILE=/etc/sudoers.d/lm-deploy
readonly PRIV_GROUPS="docker sudo admin wheel adm lxd libvirt disk"
readonly ZERO_DIGEST="sha256:0000000000000000000000000000000000000000000000000000000000000000"

usage_die() {
  printf 'verify-host: %s\n' "$*" >&2
  printf '%s\n' '用法：verify-host.sh [--check-rules FILE] [--envs staging,prod] [--lan-cidr <CIDR>[,...]] [--public-port <port>[,...]|none]' >&2
  exit 2
}

ENVS="staging,prod"
EXPECT_CIDRS=""
EXPECT_PORTS=""
CHECK_RULES=""
while (($# > 0)); do
  case $1 in
    --envs | --lan-cidr | --public-port | --check-rules)
      (($# >= 2)) || usage_die "$1 需要一個值"
      case $1 in
        --envs) ENVS=$2 ;;
        --lan-cidr) EXPECT_CIDRS=$2 ;;
        --public-port) EXPECT_PORTS=$2 ;;
        --check-rules) CHECK_RULES=$2 ;;
      esac
      shift 2
      ;;
    -h | --help) usage_die "說明見腳本開頭註解" ;;
    *) usage_die "未知的參數：$1" ;;
  esac
done
declare -a ENV_LIST=()
IFS=, read -r -a ENV_LIST <<<"$ENVS"
((${#ENV_LIST[@]} >= 1)) || usage_die "--envs 不得為空"
for e in "${ENV_LIST[@]}"; do [[ $e =~ ^(staging|prod)$ ]] || usage_die "--envs 只接受 staging、prod：$e"; done
if [[ -n $EXPECT_CIDRS ]]; then
  [[ $EXPECT_CIDRS =~ ^[0-9./,]+$ ]] || usage_die "--lan-cidr 格式無效"
fi
if [[ -n $EXPECT_PORTS && $EXPECT_PORTS != none ]]; then
  [[ $EXPECT_PORTS =~ ^[1-9][0-9]{0,4}(,[1-9][0-9]{0,4}){0,7}$ ]] || usage_die "--public-port 格式無效（1–8 個以逗號分隔的連接埠，或 none）"
fi

LM_ROOT=/srv/lm
RULES=/etc/lm/docker-user.rules
if [[ -n $CHECK_RULES ]]; then
  # 測試模式：只檢查指定的規則檔與 <env>.env，不需 root。
  LM_ROOT=${LM_SRV_ROOT:-/srv/lm}
  [[ $LM_ROOT == /* ]] || usage_die "LM_SRV_ROOT 必須為絕對路徑：$LM_ROOT"
  RULES=$CHECK_RULES
  [[ -f $RULES && -r $RULES ]] || usage_die "--check-rules 檔案無法讀取：$RULES"
else
  [[ ${EUID} -eq 0 ]] || usage_die "必須以 root 執行（需要讀取 iptables、sudoers、shadow 與 Docker）"
fi
readonly LM_ROOT RULES

N_PASS=0 N_FAIL=0 N_WARN=0
pass() { N_PASS=$((N_PASS + 1)); printf 'PASS %-8s %s\n' "$1" "$2"; }
fail() { N_FAIL=$((N_FAIL + 1)); printf 'FAIL %-8s %s\n' "$1" "$2"; }
warn() { N_WARN=$((N_WARN + 1)); printf 'WARN %-8s %s\n' "$1" "$2"; }
have() { command -v "$1" >/dev/null 2>&1; }

# path_safe <path>：路徑與所有上層目錄皆為 root 擁有、群組／其他人不可寫、不是符號連結。
path_safe() {
  local p=$1 uid mode
  while :; do
    [[ -e $p && ! -L $p ]] || return 1
    read -r uid _ mode <<<"$(stat -c '%u %G %a' -- "$p")"
    [[ $uid == 0 ]] || return 1
    (((8#$mode & 8#022) == 0)) || return 1
    [[ $p == / ]] && return 0
    p=$(dirname -- "$p")
  done
}

DOCKER_OK=0
if [[ -z $CHECK_RULES ]] && have docker && docker info >/dev/null 2>&1; then DOCKER_OK=1; fi

# env_get <file> <key>：與 lm-deploy 相同（最後一筆為準、去除 CR 與成對引號），結果在 REPLY；從不 source。
env_get() {
  local file=$1 key=$2 line val=""
  REPLY=""
  [[ -f $file && -r $file ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    [[ $line == "$key="* ]] && val=${line#"$key="}
  done <"$file"
  if [[ $val =~ ^\"(.*)\"$ || $val =~ ^\'(.*)\'$ ]]; then val=${BASH_REMATCH[1]}; fi
  REPLY=$val
}

# ---------------------------------------------------------------------------------------------
# firewall（Req 8.6、8.8–8.10）
# ---------------------------------------------------------------------------------------------

# 規則檔（iptables -S 正規化形式）只能依序由下列規則組成（design.md Components §12、§18.5）。
readonly RULE_ESTABLISHED='-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN'
readonly RULE_DROP='-A DOCKER-USER -m conntrack --ctstate DNAT -j DROP'
readonly RULE_LAST='-A DOCKER-USER -j RETURN'
readonly LAN_RULE_RE='^-A DOCKER-USER -s ([0-9./]+) -m conntrack --ctstate DNAT -j RETURN$'
readonly PORT_RULE_RE='^-A DOCKER-USER -p tcp -m conntrack --ctstate DNAT --ctorigdstport ([0-9]+) -j RETURN$'
readonly PUBLIC_PORT_MAX=8

declare -a RULE_LINES=() PUBLIC_PORTS=()

# check_rules_static：只讀規則檔與 <env>.env；結果（規則行、Public_Port）放在 RULE_LINES、PUBLIC_PORTS。
check_rules_static() {
  local line c p env f lp stage=0 order_msg="" conflict=0 port_bad=0
  local -a cidrs=()
  local -A seen=()
  RULE_LINES=() PUBLIC_PORTS=()
  # stage：0 期待已建立連線 RETURN；1 期待 LAN 網段；2 LAN 之後；3 Public_Port 之後；4 DROP 之後；5 結尾 RETURN 之後。
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line == '-A DOCKER-USER '* ]] || continue
    RULE_LINES+=("$line")
    # 第一個順序錯誤之後仍繼續收集網段與 Public_Port，只是不再更新 stage。
    if [[ $line =~ $LAN_RULE_RE ]]; then
      cidrs+=("${BASH_REMATCH[1]}")
      [[ -n $order_msg ]] || if ((stage == 1 || stage == 2)); then stage=2; else order_msg="LAN 網段規則位置錯誤：$line"; fi
    elif [[ $line =~ $PORT_RULE_RE ]]; then
      PUBLIC_PORTS+=("${BASH_REMATCH[1]}")
      [[ -n $order_msg ]] || if ((stage == 2 || stage == 3)); then stage=3; else order_msg="Public_Port 規則必須位於所有 LAN 網段規則之後、DROP 之前：$line"; fi
    elif [[ -n $order_msg ]]; then
      continue
    elif [[ $line == "$RULE_ESTABLISHED" ]]; then
      if ((stage == 0)); then stage=1; else order_msg="已建立連線 RETURN 必須是第一條規則"; fi
    elif [[ $line == "$RULE_DROP" ]]; then
      if ((stage == 2 || stage == 3)); then stage=4; else order_msg="DNAT DROP 之前缺少 LAN 網段規則或位置錯誤"; fi
    elif [[ $line == "$RULE_LAST" ]]; then
      if ((stage == 4)); then stage=5; else order_msg="結尾 RETURN 位置錯誤"; fi
    else
      order_msg="無法辨識的規則：$line"
    fi
  done <"$RULES"
  if ! grep -qxF -- "$RULE_DROP" "$RULES" || ((${#cidrs[@]} == 0)); then
    fail firewall "$RULES 缺少 LAN 網段 RETURN 或 DNAT DROP 規則"
    return 1
  fi
  [[ -n $order_msg ]] || ((stage == 5)) || order_msg="缺少結尾的 $RULE_LAST"
  if [[ -z $order_msg ]]; then
    pass firewall "$RULES 依序為已建立連線、LAN 網段、Public_Port、DNAT DROP、RETURN"
  else
    fail firewall "$RULES 的規則順序不符（$order_msg）"
  fi

  for c in "${cidrs[@]}"; do
    [[ $c != 0.0.0.0/0 && $c != */0 ]] || fail firewall "$RULES 允許所有來源（$c）"
  done
  if [[ -n $EXPECT_CIDRS ]]; then
    local want got
    want=$(tr ',' '\n' <<<"$EXPECT_CIDRS" | sort -u | paste -sd, -)
    got=$(printf '%s\n' "${cidrs[@]}" | sort -u | paste -sd, -)
    [[ $want == "$got" ]] && pass firewall "允許的 LAN 網段與預期相同（$got）" || fail firewall "允許的 LAN 網段為 $got，預期 $want"
  else
    pass firewall "允許的 LAN 網段：${cidrs[*]}"
  fi

  # Public_Port（Req 8.8、8.9）：格式、重複、數量，以及不得等於任一環境的 LM_PUBLIC_PORT。
  for p in "${PUBLIC_PORTS[@]}"; do
    if [[ ! $p =~ ^[1-9][0-9]{0,4}$ ]] || ((10#$p > 65535)); then
      fail firewall "$RULES 的 Public_Port 無效：$p"
      port_bad=1
    elif [[ -n ${seen[$p]:-} ]]; then
      fail firewall "$RULES 的 Public_Port 重複：$p"
      port_bad=1
    fi
    seen[$p]=1
  done
  if ((${#PUBLIC_PORTS[@]} > PUBLIC_PORT_MAX)); then
    fail firewall "$RULES 有 ${#PUBLIC_PORTS[@]} 個 Public_Port，最多 $PUBLIC_PORT_MAX 個"
    port_bad=1
  fi
  for env in staging prod; do
    f="$LM_ROOT/$env/$env.env"
    [[ -f $f ]] || continue
    env_get "$f" LM_PUBLIC_PORT
    lp=$REPLY
    [[ $lp =~ ^[0-9]{1,5}$ ]] || continue
    for p in "${PUBLIC_PORTS[@]}"; do
      [[ $p =~ ^[0-9]{1,5}$ ]] || continue
      if ((10#$p == 10#$lp)); then
        fail firewall "Public_Port $p 等於 $env 的 LM_PUBLIC_PORT（$f）：LM_Proxy 連接埠不受 LAN 網段限制"
        conflict=1
      fi
    done
  done
  if ((${#PUBLIC_PORTS[@]} > 0 && conflict == 0 && port_bad == 0)); then
    pass firewall "Public_Port 未與任一環境的 LM_PUBLIC_PORT 相同"
  fi
  if [[ -n $EXPECT_PORTS ]]; then
    local wantp gotp=""
    if [[ $EXPECT_PORTS == none ]]; then wantp=""; else wantp=$(tr ',' '\n' <<<"$EXPECT_PORTS" | sort -n -u | paste -sd, -); fi
    ((${#PUBLIC_PORTS[@]} == 0)) || gotp=$(printf '%s\n' "${PUBLIC_PORTS[@]}" | sort -n -u | paste -sd, -)
    if [[ $wantp == "$gotp" ]]; then
      pass firewall "Public_Port 與預期相同（${gotp:-none}）"
    else
      fail firewall "Public_Port 為 ${gotp:-none}，預期 ${wantp:-none}"
    fi
  elif ((${#PUBLIC_PORTS[@]} > 0)); then
    pass firewall "Public_Port（接受任何來源）：${PUBLIC_PORTS[*]}"
  else
    pass firewall "未宣告 Public_Port（所有發布連接埠只接受 LAN 網段）"
  fi
}

check_firewall() {
  local state
  state=$(systemctl is-enabled "$UNIT_NAME" 2>/dev/null || true)
  [[ $state == enabled ]] && pass firewall "$UNIT_NAME 已 enable（開機套用）" || fail firewall "$UNIT_NAME 未 enable（目前：${state:-not-found}）"
  state=$(systemctl is-active "$UNIT_NAME" 2>/dev/null || true)
  [[ $state == active ]] && pass firewall "$UNIT_NAME 為 active" || fail firewall "$UNIT_NAME 不是 active（目前：${state:-unknown}）"

  if [[ ! -f $RULES || -L $RULES ]]; then
    fail firewall "找不到 $RULES"
    return 0
  fi
  local uid mode
  read -r uid _ mode <<<"$(stat -c '%u %G %a' -- "$RULES")"
  if [[ $uid == 0 ]] && (((8#$mode & 8#022) == 0)); then pass firewall "$RULES 為 root 擁有且不可由他人寫入"; else fail firewall "$RULES 擁有者或權限不安全（uid $uid，$mode）"; fi

  # 規則檔本身缺少 LAN／DROP 規則時不再比對已載入的規則。
  check_rules_static || return 0
  local -a expected=("${RULE_LINES[@]}")
  local line

  if ! have iptables; then
    fail firewall "找不到 iptables，無法確認規則已載入"
    return 0
  fi
  local -a spec
  local missing=0
  for line in "${expected[@]}"; do
    read -r -a spec <<<"${line#-A DOCKER-USER }"
    if ! iptables -w 5 -C DOCKER-USER "${spec[@]}" 2>/dev/null; then
      fail firewall "規則未載入：$line"
      missing=1
    fi
  done
  ((missing == 1)) || pass firewall "$RULES 的 ${#expected[@]} 條規則皆已載入 DOCKER-USER"

  local -a live=()
  mapfile -t live < <(iptables -w 5 -S DOCKER-USER 2>/dev/null | grep '^-A ' || true)
  local i order_ok=1
  ((${#live[@]} >= ${#expected[@]})) || order_ok=0
  for ((i = 0; order_ok == 1 && i < ${#expected[@]}; i++)); do
    [[ ${live[i]} == "${expected[i]}" ]] || order_ok=0
  done
  if ((order_ok == 1)); then
    pass firewall "DOCKER-USER 開頭依序為規則檔內容（DROP 之前沒有其他規則）"
  else
    fail firewall "DOCKER-USER 內容或順序與 $RULES 不一致（systemctl reload $UNIT_NAME 重新套用）"
    printf '       live: %s\n' "${live[@]:-<empty>}"
  fi

  local first
  first=$(iptables -w 5 -S FORWARD 2>/dev/null | grep -m1 '^-A FORWARD' || true)
  if [[ $first == '-A FORWARD -j DOCKER-USER' ]]; then
    pass firewall "FORWARD 第一條規則為 -j DOCKER-USER"
  else
    fail firewall "FORWARD 第一條規則不是 -j DOCKER-USER（目前：${first:-<none>}；Docker 的 iptables 整合是否停用？）"
  fi

  if [[ -f /etc/docker/daemon.json ]] && grep -Eq '"iptables"[[:space:]]*:[[:space:]]*false' /etc/docker/daemon.json; then
    fail firewall "/etc/docker/daemon.json 設定 \"iptables\": false，DOCKER-USER 不會生效"
  fi
}

# 發布連接埠不得綁定萬用位址：只綁 LAN_IP，避免經其他介面或 IPv6（不受 iptables 規則限制）暴露。
check_published_bindings() {
  ((DOCKER_OK == 1)) || return 0
  local env ids id name binds b bad
  local -a arr
  for env in "${ENV_LIST[@]}"; do
    ids=$(docker ps --filter "label=com.docker.compose.project=lm-$env" --format '{{.ID}}' 2>/dev/null || true)
    [[ -n $ids ]] || continue
    for id in $ids; do
      name=$(docker inspect --format '{{.Name}}' "$id" 2>/dev/null || echo "$id")
      binds=$(docker inspect --format '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{if .HostIp}}{{.HostIp}}{{else}}ANY{{end}} {{end}}{{end}}' "$id" 2>/dev/null || true)
      [[ -n $binds ]] || continue
      bad=0
      read -r -a arr <<<"$binds"
      for b in "${arr[@]}"; do
        case $b in ANY | 0.0.0.0 | ::) bad=1 ;; esac
      done
      if ((bad == 1)); then
        fail firewall "$name 的發布連接埠綁定萬用位址 $binds（應只綁定 LAN_IP）"
      else
        pass firewall "$name 的發布連接埠只綁定特定位址 $binds"
      fi
    done
  done
}

# ---------------------------------------------------------------------------------------------
# proxy（Req 25.7、25.8；design.md Components §18.4）
# ---------------------------------------------------------------------------------------------
# 與 deploy/bin/lm-deploy 的 check_edge_proxies 相同規則（同一寫法；verify-host 回報 FAIL 而不結束）。

readonly EDGE_MAX=64 LAN_CIDR_MAX=8

# ipv4_to_int <a.b.c.d>：格式有效時把整數放在 REPLY 並回傳 0。
ipv4_to_int() {
  local ip=$1 o n=0 IFS=.
  [[ $ip =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  for o in $ip; do
    [[ $o =~ ^(0|[1-9][0-9]{0,2})$ ]] && ((o <= 255)) || return 1
    n=$((n * 256 + o))
  done
  REPLY=$n
}

v4_mask() { REPLY=$(((0xFFFFFFFF << (32 - $1)) & 0xFFFFFFFF)); }

# v6_side <text> <ipv4-at-end-allowed>：以 ':' 分隔的群組轉為 16 位元整數，放在 V6_SIDE。
v6_side() {
  local s=$1 v4=$2 g i last
  local -a arr=()
  V6_SIDE=()
  [[ -n $s ]] || return 0
  [[ $s != :* && $s != *: ]] || return 1
  IFS=: read -r -a arr <<<"$s"
  last=$((${#arr[@]} - 1))
  for ((i = 0; i <= last; i++)); do
    g=${arr[i]}
    if [[ $g == *.* ]]; then
      [[ $v4 == 1 && $i -eq $last ]] || return 1
      ipv4_to_int "$g" || return 1
      V6_SIDE+=("$((REPLY >> 16))" "$((REPLY & 0xFFFF))")
    else
      [[ $g =~ ^[0-9A-Fa-f]{1,4}$ ]] || return 1
      V6_SIDE+=("$((16#$g))")
    fi
  done
}

# ipv6_groups <addr>：語法有效時把 8 個 16 位元整數放在 V6 並回傳 0（最多一個 '::'；結尾可為內嵌 IPv4）。
ipv6_groups() {
  local a=$1 head tail fill i
  local -a h=() t=()
  V6=()
  [[ $a =~ ^[0-9A-Fa-f:.]+$ && $a == *:* && $a != *:::* && $a != *::*::* ]] || return 1
  if [[ $a == *::* ]]; then
    head=${a%%::*}
    tail=${a#*::}
    v6_side "$head" 0 || return 1
    h=("${V6_SIDE[@]}")
    v6_side "$tail" 1 || return 1
    t=("${V6_SIDE[@]}")
    fill=$((8 - ${#h[@]} - ${#t[@]}))
    ((fill >= 1)) || return 1
    V6=("${h[@]}")
    for ((i = 0; i < fill; i++)); do V6+=(0); done
    V6+=("${t[@]}")
  else
    v6_side "$a" 1 || return 1
    ((${#V6_SIDE[@]} == 8)) || return 1
    V6=("${V6_SIDE[@]}")
  fi
}

# edge_entry <entry>：有效時回傳 0，E_FAMILY（4｜6）、E_INT（IPv4 整數）、E_P（前綴）為結果；
# 無效時把原因放在 REPLY 並回傳 1。
edge_entry() {
  local e=$1 addr p="" bits i b mask same=1
  local -a mapped=(0 0 0 0 0 65535)
  E_FAMILY="" E_INT=0 E_P=0
  addr=$e
  if [[ $e == */* ]]; then
    addr=${e%/*}
    p=${e#*/}
    [[ $p =~ ^(0|[1-9][0-9]{0,2})$ ]] || { REPLY="前綴長度無效"; return 1; }
  fi
  if [[ $addr == *:* ]]; then
    ipv6_groups "$addr" || { REPLY="不是有效的 IPv6 位址或 CIDR"; return 1; }
    p=${p:-128}
    ((p <= 128)) || { REPLY="IPv6 前綴長度必須為 1–128"; return 1; }
    ((p >= 1)) || { REPLY="前綴長度不得為 0"; return 1; }
    bits=$((p < 96 ? p : 96))
    for ((i = 0; i < 6; i++)); do
      b=$((bits - 16 * i))
      ((b > 0)) || break
      ((b <= 16)) || b=16
      mask=$(((0xFFFF << (16 - b)) & 0xFFFF))
      if (((V6[i] & mask) != (mapped[i] & mask))); then same=0; break; fi
    done
    ((same == 0)) || { REPLY="不允許 IPv4-mapped IPv6（::ffff:0:0/96）範圍"; return 1; }
    E_FAMILY=6
  else
    ipv4_to_int "$addr" || { REPLY="不是有效的 IPv4 位址或 CIDR"; return 1; }
    E_INT=$REPLY
    p=${p:-32}
    ((p <= 32)) || { REPLY="IPv4 前綴長度必須為 1–32"; return 1; }
    ((p >= 1)) || { REPLY="前綴長度不得為 0"; return 1; }
    E_FAMILY=4
  fi
  E_P=$p
}

# edge_problems <envfile>：LM_EDGE_TRUSTED_PROXIES 的項目數放在 EDGE_COUNT；違規時把原因（只列出無效項目）
# 放在 REPLY 並回傳 1。
edge_problems() {
  local envfile=$1 lanraw e c p v n i j m msg=""
  local -a entries=() lans=() lan_int=() lan_p=() bad=()
  env_get "$envfile" LM_EDGE_TRUSTED_PROXIES
  read -r -a entries <<<"$REPLY" || true
  n=${#entries[@]}
  EDGE_COUNT=$n
  REPLY=""
  ((n > 0)) || return 0
  ((n <= EDGE_MAX)) || { REPLY="LM_EDGE_TRUSTED_PROXIES 有 $n 個項目，最多 $EDGE_MAX 個"; return 1; }

  env_get "$envfile" LM_LAN_CIDR
  lanraw=$REPLY
  [[ -n $lanraw ]] || { REPLY="LM_EDGE_TRUSTED_PROXIES 已設定，但 LM_LAN_CIDR 未設定"; return 1; }
  IFS=, read -r -a lans <<<"$lanraw" || true
  if [[ $lanraw == ,* || $lanraw == *, || $lanraw == *,,* ]] || ((${#lans[@]} < 1 || ${#lans[@]} > LAN_CIDR_MAX)); then
    REPLY="LM_LAN_CIDR 必須為 1 至 $LAN_CIDR_MAX 個以逗號分隔的網段"
    return 1
  fi
  for c in "${lans[@]}"; do
    p=${c#*/}
    if [[ $c == */* && $p =~ ^[1-9][0-9]?$ ]] && ((p >= 8 && p <= 32)) && ipv4_to_int "${c%/*}"; then
      v=$REPLY
      v4_mask "$p"
      if (((v & REPLY) == v)); then
        lan_int+=("$v")
        lan_p+=("$p")
        continue
      fi
    fi
    bad+=("$c")
  done
  if ((${#bad[@]} > 0)); then
    REPLY="LM_LAN_CIDR 含無效網段（需為 IPv4 網路位址/8–/32）：${bad[*]}"
    return 1
  fi

  for ((i = 0; i < n; i++)); do
    e=${entries[i]}
    if edge_entry "$e"; then
      [[ $E_FAMILY == 4 ]] || continue
      for ((j = 0; j < ${#lan_int[@]}; j++)); do
        ((E_P <= lan_p[j])) || continue
        v4_mask "$E_P"
        m=$REPLY
        if (((lan_int[j] & m) == (E_INT & m))); then
          msg+="${msg:+；}#$((i + 1)) $e：涵蓋 LM_LAN_CIDR 網段 ${lans[j]}"
          continue 2
        fi
      done
    else
      msg+="${msg:+；}#$((i + 1)) $e：$REPLY"
    fi
  done
  REPLY=""
  [[ -z $msg ]] || { REPLY="LM_EDGE_TRUSTED_PROXIES 含無效項目：$msg"; return 1; }
}

check_proxy() {
  local env f
  for env in "${ENV_LIST[@]}"; do
    f="$LM_ROOT/$env/$env.env"
    if [[ ! -f $f || ! -r $f ]]; then
      fail proxy "[$env] 找不到 $f"
      continue
    fi
    EDGE_COUNT=0
    if edge_problems "$f"; then
      if ((EDGE_COUNT == 0)); then
        pass proxy "[$env] LM_EDGE_TRUSTED_PROXIES 為空（LM_Proxy 不採信任何來源的 X-Forwarded-For／X-Forwarded-Proto）"
      else
        pass proxy "[$env] LM_EDGE_TRUSTED_PROXIES 的 $EDGE_COUNT 個項目與 LM_LAN_CIDR 皆有效"
      fi
    else
      fail proxy "[$env] $REPLY（lm-deploy 會以 config_invalid 拒絕部署）"
    fi
    if [[ $env == staging ]] && ((EDGE_COUNT > 0)); then
      warn proxy "[staging] 設有 LM_EDGE_TRUSTED_PROXIES；Staging 不經 Edge_Proxy 公開，應保持空白"
    fi
    if [[ $env == prod ]] && ((EDGE_COUNT == 0 && ${#PUBLIC_PORTS[@]} > 0)); then
      warn proxy "[prod] 已宣告 Public_Port（${PUBLIC_PORTS[*]}）但 LM_EDGE_TRUSTED_PROXIES 為空：經 Edge_Proxy 的請求會被視為 http，Origin 檢查失敗"
    fi
  done
}

# ---------------------------------------------------------------------------------------------
# db（Req 11.10）
# ---------------------------------------------------------------------------------------------

check_db() {
  local env=$1 d="$LM_ROOT/$1" out ids id ports mode publish_all
  if ((DOCKER_OK == 0)); then
    fail db "[$env] 無法連線 Docker daemon，無法確認 db 未發布連接埠"
    return 0
  fi
  if [[ -f $d/compose.yaml && -f $d/$env.env ]]; then
    if out=$(env "LM_ENV=$env" "APP_IMAGE_BLUE=example.invalid/lm@$ZERO_DIGEST" \
      "APP_IMAGE_GREEN=example.invalid/lm@$ZERO_DIGEST" "APP_IMAGE_NEW=example.invalid/lm@$ZERO_DIGEST" \
      docker compose --project-directory "$d" -f "$d/compose.yaml" --env-file "$d/$env.env" config db 2>/dev/null); then
      if grep -Eq '^[[:space:]]+(ports|network_mode):' <<<"$out"; then
        fail db "[$env] compose.yaml 的 db 服務宣告了 ports 或 network_mode"
      else
        pass db "[$env] compose.yaml 的 db 服務沒有 ports"
      fi
    else
      warn db "[$env] docker compose config 失敗（$env.env 是否仍含佔位符？），略過靜態檢查"
    fi
  else
    fail db "[$env] 找不到 $d/compose.yaml 或 $d/$env.env"
  fi

  ids=$(docker ps -a --filter "label=com.docker.compose.project=lm-$env" \
    --filter "label=com.docker.compose.service=db" --format '{{.ID}}' 2>/dev/null || true)
  if [[ -z $ids ]]; then
    warn db "[$env] 沒有 db 容器，只完成靜態檢查"
    return 0
  fi
  for id in $ids; do
    ports=$(docker inspect --format '{{range $p, $b := .HostConfig.PortBindings}}{{$p}} {{end}}{{range $p, $b := .NetworkSettings.Ports}}{{if $b}}{{$p}} {{end}}{{end}}' "$id")
    mode=$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$id")
    publish_all=$(docker inspect --format '{{.HostConfig.PublishAllPorts}}' "$id")
    if [[ -n ${ports// /} || $mode == host || $publish_all == true ]]; then
      fail db "[$env] db 容器 $id 發布了連接埠或使用 host 網路（ports：${ports:-none}，network：$mode）"
    else
      pass db "[$env] db 容器 $id 沒有發布任何連接埠"
    fi
  done
}

# ---------------------------------------------------------------------------------------------
# backup（Req 14.4）
# ---------------------------------------------------------------------------------------------

check_backup_dir_one() {
  local d=$1 uid grp mode
  if [[ ! -d $d || -L $d ]]; then
    fail backup "$d 不存在或為符號連結"
    return 1
  fi
  read -r uid grp mode <<<"$(stat -c '%U %G %a' -- "$d")"
  if [[ $uid == "$OPS_USER" && $mode == 700 ]]; then
    pass backup "$d 為 $OPS_USER 擁有、權限 0700"
  else
    fail backup "$d 擁有者／權限為 $uid:$grp $mode，預期 $OPS_USER 0700"
  fi
}

check_backup() {
  local env real root_dir bad
  id -u "$OPS_USER" >/dev/null 2>&1 || fail backup "維運帳號 $OPS_USER 不存在"
  check_backup_dir_one "$BACKUP_ROOT" || return 0
  for env in "${ENV_LIST[@]}"; do check_backup_dir_one "$BACKUP_ROOT/$env" || true; done

  bad=$(find "$BACKUP_ROOT" -xdev \( ! -user "$OPS_USER" -o -perm /077 \) ! -type l -print -quit 2>/dev/null || true)
  if [[ -z $bad ]]; then
    pass backup "$BACKUP_ROOT 下所有項目皆為 $OPS_USER 擁有且群組／其他人無權限"
  else
    fail backup "$BACKUP_ROOT 下有非 $OPS_USER 擁有或群組／其他人可存取的項目（例如 $bad）"
  fi
  bad=$(find "$BACKUP_ROOT" -xdev -type l -print -quit 2>/dev/null || true)
  [[ -z $bad ]] || fail backup "$BACKUP_ROOT 下有符號連結：$bad"

  real=$(realpath -e -- "$BACKUP_ROOT")
  if ((DOCKER_OK == 1)); then
    root_dir=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
    root_dir=${root_dir:-/var/lib/docker}
  else
    root_dir=/var/lib/docker
    warn backup "無法連線 Docker daemon，以預設 $root_dir 判斷 Docker 資料目錄"
  fi
  root_dir=$(realpath -m -- "$root_dir")
  if [[ $real == "$root_dir" || $real == "$root_dir"/* ]]; then
    fail backup "$BACKUP_ROOT 位於 Docker 資料目錄 $root_dir 內"
  else
    pass backup "$BACKUP_ROOT 不在 Docker 資料目錄（$root_dir）內"
  fi
  if have git && git -C "$real" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    fail backup "$BACKUP_ROOT 位於 git 工作目錄內"
  else
    pass backup "$BACKUP_ROOT 不在 git 工作目錄內"
  fi
}

# ---------------------------------------------------------------------------------------------
# account（Req 15.9）
# ---------------------------------------------------------------------------------------------

declare -A KEY_BLOBS=()

check_account() {
  local env=$1 user="lm-deploy-$1" groups g sock_group="" pw home ak line found=0 bad=0
  if ! id -u "$user" >/dev/null 2>&1; then
    fail account "[$env] 部署帳號 $user 不存在"
    return 0
  fi
  [[ -S /var/run/docker.sock ]] && sock_group=$(stat -c %G -- /var/run/docker.sock)
  groups=" $(id -nG "$user") "
  if [[ $groups == *" docker "* || (-n $sock_group && $sock_group != root && $groups == *" $sock_group "*) ]]; then
    fail account "[$env] $user 在 docker 群組（或 docker.sock 所屬群組 $sock_group）"
  else
    pass account "[$env] $user 不在 docker 群組${sock_group:+（docker.sock 群組：$sock_group）}"
  fi
  for g in $PRIV_GROUPS; do
    [[ $g == docker ]] && continue
    [[ $groups != *" $g "* ]] || fail account "[$env] $user 在特權群組 $g"
  done

  pw=$(getent shadow "$user" | cut -d: -f2 || true)
  if [[ $pw == \$* ]]; then
    fail account "[$env] $user 設有密碼（應只能以公鑰登入）"
  else
    pass account "[$env] $user 未設定密碼"
  fi

  # sudo 權限：只能執行 lm-deploy <env> 這一個固定指令列。
  local listing in_cmds=0
  local -a cmds=()
  listing=$(sudo -n -l -U "$user" 2>&1 || true)
  while IFS= read -r line; do
    if [[ $line == *"may run the following commands"* ]]; then in_cmds=1; continue; fi
    ((in_cmds == 1)) || continue
    [[ $line =~ ^[[:space:]]+([^[:space:]].*)$ ]] || { [[ -z $line ]] && continue; in_cmds=0; continue; }
    cmds+=("${BASH_REMATCH[1]}")
  done <<<"$listing"
  local want="(root) NOPASSWD: $LM_BIN $env"
  if ((${#cmds[@]} == 1)) && [[ ${cmds[0]} == "$want" ]]; then
    pass account "[$env] sudo 只允許「$want」"
  else
    fail account "[$env] sudo 權限與預期不同（預期只有「$want」）：$(printf '%s; ' "${cmds[@]:-<none>}")"
  fi

  home=$(getent passwd "$user" | cut -d: -f6)
  ak="$home/.ssh/authorized_keys"
  if [[ -n $home && -d $home ]] && path_safe "$home/.ssh"; then
    pass account "[$env] $home 與 .ssh 為 root 擁有，部署帳號無法改寫"
  else
    fail account "[$env] $home 或 $home/.ssh 不是 root 擁有或可由他人寫入"
  fi
  if [[ ! -f $ak || -L $ak ]]; then
    fail account "[$env] 找不到 $ak（尚未設定部署公鑰）"
    return 0
  fi
  path_safe "$ak" || fail account "[$env] $ak 不是 root 擁有或可由他人寫入"
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    found=$((found + 1))
    if [[ $line != *"command=\"/usr/bin/sudo -n $LM_BIN $env\""* || $line != *'from="'* ]] ||
      [[ $line != *no-pty* && $line != restrict* && $line != *,restrict* ]]; then
      bad=1
    fi
    [[ $line =~ [[:space:]](ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+)[[:space:]]+([A-Za-z0-9+/=]+) ]] &&
      KEY_BLOBS[$env]+=" ${BASH_REMATCH[2]}"
  done <"$ak"
  if ((found == 0)); then
    fail account "[$env] $ak 沒有任何金鑰"
  elif ((bad == 1)); then
    fail account "[$env] $ak 有金鑰缺少 forced command（lm-deploy $env）、from= 或 no-pty"
  else
    pass account "[$env] $ak 的 $found 把金鑰皆有 forced command、from= 與 no-pty"
  fi
}

check_keys_distinct() {
  [[ -n ${KEY_BLOBS[staging]:-} && -n ${KEY_BLOBS[prod]:-} ]] || return 0
  local k
  for k in ${KEY_BLOBS[staging]}; do
    if [[ " ${KEY_BLOBS[prod]} " == *" $k "* ]]; then
      fail account "staging 與 prod 使用相同的部署金鑰"
      return 0
    fi
  done
  pass account "staging 與 prod 使用不同的部署金鑰"
}

# ---------------------------------------------------------------------------------------------
# files
# ---------------------------------------------------------------------------------------------

check_files() {
  local mode uid env d f
  if path_safe "$LM_BIN" && [[ -x $LM_BIN ]]; then
    pass files "$LM_BIN 與上層目錄皆為 root 擁有且不可由他人寫入"
  else
    fail files "$LM_BIN 不存在、不可執行，或其本身／上層目錄可由非 root 寫入"
  fi
  if [[ -f $SUDOERS_FILE && ! -L $SUDOERS_FILE ]]; then
    read -r uid _ mode <<<"$(stat -c '%u %G %a' -- "$SUDOERS_FILE")"
    [[ $uid == 0 && $mode == 440 ]] && pass files "$SUDOERS_FILE 為 root 0440" || fail files "$SUDOERS_FILE 擁有者／權限為 uid $uid $mode，預期 root 0440"
  else
    fail files "找不到 $SUDOERS_FILE"
  fi
  if visudo -c >/dev/null 2>&1; then pass files "visudo -c 通過"; else fail files "visudo -c 失敗"; fi

  for env in "${ENV_LIST[@]}"; do
    d="$LM_ROOT/$env"
    if path_safe "$d"; then pass files "[$env] $d 為 root 擁有且不可由他人寫入"; else fail files "[$env] $d 不存在或可由非 root 寫入"; fi
    for f in app.env db.env; do
      if [[ ! -e $d/$f ]]; then
        warn files "[$env] $d/$f 不存在"
        continue
      fi
      read -r uid _ mode <<<"$(stat -c '%u %G %a' -- "$d/$f")"
      [[ $uid == 0 && $mode == 600 && ! -L $d/$f ]] && pass files "[$env] $f 為 root 0600" || fail files "[$env] $d/$f 擁有者／權限為 uid $uid $mode，預期 root 0600"
    done
  done
}

if [[ -n $CHECK_RULES ]]; then
  check_rules_static || true
  check_proxy
  printf '\nverify-host（--check-rules）：%d PASS，%d FAIL，%d WARN\n' "$N_PASS" "$N_FAIL" "$N_WARN"
  ((N_FAIL == 0)) || exit 1
  exit 0
fi

check_firewall
check_published_bindings
check_proxy
for e in "${ENV_LIST[@]}"; do check_db "$e"; done
check_backup
for e in "${ENV_LIST[@]}"; do check_account "$e"; done
check_keys_distinct
check_files

printf '\nverify-host：%d PASS，%d FAIL，%d WARN\n' "$N_PASS" "$N_FAIL" "$N_WARN"
((N_FAIL == 0)) || exit 1
exit 0
