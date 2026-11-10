#!/usr/bin/env bash
# Deploy_Host 主機安全設定驗證（Requirement 8.6、11.10、14.4、15.9；design.md Components §12、
# Security Boundaries）。唯讀：只讀取設定與狀態，不修改任何檔案、規則、帳號或容器。
#
# 用法：
#   sudo deploy/host/verify-host.sh [--envs staging,prod] [--lan-cidr <CIDR>[,...]]
#
#   --envs      要檢查的環境（預設 staging,prod）
#   --lan-cidr  預期的 LAN 網段；指定時另外比對 /etc/lm/docker-user.rules 的網段是否完全相同
#
# 檢查項目（每項輸出一行 PASS／FAIL／WARN）：
#   firewall  lm-docker-user.service 已 enable 且 active；/etc/lm/docker-user.rules 的每條規則都已載入
#             （iptables -C），且 DOCKER-USER 開頭依序正是這些規則（沒有其他規則插在 DROP 之前）；
#             FORWARD 第一條為 -j DOCKER-USER；lm-<env> proxy 的發布連接埠綁定特定位址而非 0.0.0.0／::。
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
readonly LM_ROOT=/srv/lm
readonly BACKUP_ROOT=/var/backups/little-moments
readonly RULES=/etc/lm/docker-user.rules
readonly UNIT_NAME=lm-docker-user.service
readonly SUDOERS_FILE=/etc/sudoers.d/lm-deploy
readonly PRIV_GROUPS="docker sudo admin wheel adm lxd libvirt disk"
readonly ZERO_DIGEST="sha256:0000000000000000000000000000000000000000000000000000000000000000"

usage_die() {
  printf 'verify-host: %s\n' "$*" >&2
  printf '%s\n' '用法：verify-host.sh [--envs staging,prod] [--lan-cidr <CIDR>[,...]]' >&2
  exit 2
}

ENVS="staging,prod"
EXPECT_CIDRS=""
while (($# > 0)); do
  case $1 in
    --envs | --lan-cidr)
      (($# >= 2)) || usage_die "$1 需要一個值"
      if [[ $1 == --envs ]]; then ENVS=$2; else EXPECT_CIDRS=$2; fi
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
[[ ${EUID} -eq 0 ]] || usage_die "必須以 root 執行（需要讀取 iptables、sudoers、shadow 與 Docker）"

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
if have docker && docker info >/dev/null 2>&1; then DOCKER_OK=1; fi

# ---------------------------------------------------------------------------------------------
# firewall（Req 8.6）
# ---------------------------------------------------------------------------------------------

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

  local -a expected=() cidrs=()
  local line
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line == '-A DOCKER-USER '* ]] || continue
    expected+=("$line")
    [[ $line =~ ^-A\ DOCKER-USER\ -s\ ([0-9./]+)\ .*-j\ RETURN$ ]] && cidrs+=("${BASH_REMATCH[1]}")
  done <"$RULES"
  if ! grep -qx -- '-A DOCKER-USER -m conntrack --ctstate DNAT -j DROP' "$RULES" || ((${#cidrs[@]} == 0)); then
    fail firewall "$RULES 缺少 LAN 網段 RETURN 或 DNAT DROP 規則"
    return 0
  fi
  local c
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

check_firewall
check_published_bindings
for e in "${ENV_LIST[@]}"; do check_db "$e"; done
check_backup
for e in "${ENV_LIST[@]}"; do check_account "$e"; done
check_keys_distinct
check_files

printf '\nverify-host：%d PASS，%d FAIL，%d WARN\n' "$N_PASS" "$N_FAIL" "$N_WARN"
((N_FAIL == 0)) || exit 1
exit 0
