#!/usr/bin/env bash
# Deploy_Host 主機安全設定安裝（Requirement 8.6、11.10、14.4、15.9；design.md Components §12、
# Security Boundaries）。以 root 在 Deploy_Host 上、自 repository 的 deploy/host/ 執行；可重複執行。
#
# 用法：
#   sudo deploy/host/install.sh --lan-cidr <CIDR>[,<CIDR>...] [--envs staging,prod]
#        [--agent-from <IP|CIDR>[,...]] [--staging-key <公鑰檔>] [--prod-key <公鑰檔>]
#
#   --lan-cidr     允許連線至 Docker 發布連接埠的 LAN 網段（IPv4 網路位址，前綴 /8–/32，最多 8 個）。
#                  網段外來源無法與 proxy／Registry 建立 TCP 連線（Req 8.6）。必要。
#   --envs         要安裝的環境（預設 staging,prod）。
#   --agent-from   Trusted_Build_Agent 的 IPv4 位址或 CIDR（authorized_keys 的 from=）。提供任一公鑰時必要。
#   --staging-key  staging 部署公鑰檔（一行 OpenSSH 公鑰，不含選項）；未提供時不變更既有 authorized_keys。
#   --prod-key     prod 部署公鑰檔；必須與 staging 不同（Req 15.9：兩環境使用不同部署憑證）。
#
# 安裝內容：
#   帳號      lm-ops（維運帳號，system、nologin）；lm-deploy-<env>（部署帳號，無密碼、只能以公鑰登入，
#             移出 docker／sudo／adm／lxd 等特權群組）
#   /opt/lm/bin/lm-deploy                 root 0755（來源 deploy/bin/lm-deploy）
#   /srv/lm/<env>/                        root 0750；compose.yaml、drill.yaml 0644、caddy/ 0755（Caddyfile、tls-*.caddy、
#                                         upstream.caddy.tmpl，首次安裝時產生指向 blue 的 upstream.caddy）、
#                                         state/ 0700；<env>.env 只在不存在時由範本建立（0644，需替換佔位符）
#   /var/backups/little-moments/<env>/    lm-ops:lm-ops 0700（不屬於 Docker 卷、不在 repository，Req 14.4）
#   /etc/lm/docker-user.rules             root 0644；以 iptables-restore --test 驗證後安裝
#   /etc/systemd/system/lm-docker-user.service   enable 並套用（開機時於 docker.service 之前套用）
#   /etc/sudoers.d/lm-deploy              root 0440；以 visudo -cf 驗證後安裝，安裝後再驗證整體設定
#   ~lm-deploy-<env>/.ssh/authorized_keys root 0644（forced command、from=、no-pty）
#
# 不會建立或覆寫秘密：db.env／app.env（0600 root）須由維運者依 deploy/compose/*.env.example 建立；
# app.env 亦可由 Pipeline 經 `lm-deploy <env> app-env`（stdin）寫入。範本中的佔位符密碼不得使用，
# 因此本腳本不複製這兩個範本。
#
# 安裝後執行 deploy/host/verify-host.sh 確認設定已生效。
#
# 結束碼：0 成功；1 安裝失敗；2 參數錯誤。

set -euo pipefail
umask 022
export LC_ALL=C
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
shopt -u patsub_replacement 2>/dev/null || true

readonly OPS_USER=lm-ops
readonly LM_OPT=/opt/lm
readonly LM_BIN=/opt/lm/bin/lm-deploy
readonly LM_ROOT=/srv/lm
readonly LM_ETC=/etc/lm
readonly BACKUP_ROOT=/var/backups/little-moments
readonly RULES_DST=/etc/lm/docker-user.rules
readonly UNIT_NAME=lm-docker-user.service
readonly UNIT_DST=/etc/systemd/system/lm-docker-user.service
readonly SUDOERS_DST=/etc/sudoers.d/lm-deploy
readonly PRIV_GROUPS="docker sudo admin wheel adm lxd libvirt disk"

log() { printf '[install] %s\n' "$*" >&2; }
warn() { printf '[install] WARN: %s\n' "$*" >&2; }
die() { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }
usage_die() {
  printf '[install] %s\n' "$*" >&2
  printf '%s\n' '用法：install.sh --lan-cidr <CIDR>[,...] [--envs staging,prod] [--agent-from <IP|CIDR>[,...]] [--staging-key FILE] [--prod-key FILE]' >&2
  exit 2
}

TMP_FILES=()
cleanup() {
  local f
  for f in "${TMP_FILES[@]}"; do [[ -n $f ]] && rm -f -- "$f"; done
  return 0
}
trap cleanup EXIT

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
DEPLOY_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd -P)

# ---------------------------------------------------------------------------------------------
# 參數
# ---------------------------------------------------------------------------------------------

LAN_CIDRS=""
ENVS="staging,prod"
AGENT_FROM=""
declare -A KEY_FILE=([staging]="" [prod]="")

while (($# > 0)); do
  case $1 in
    --lan-cidr | --envs | --agent-from | --staging-key | --prod-key)
      (($# >= 2)) || usage_die "$1 需要一個值"
      case $1 in
        --lan-cidr) LAN_CIDRS=$2 ;;
        --envs) ENVS=$2 ;;
        --agent-from) AGENT_FROM=$2 ;;
        --staging-key) KEY_FILE[staging]=$2 ;;
        --prod-key) KEY_FILE[prod]=$2 ;;
      esac
      shift 2
      ;;
    -h | --help) usage_die "說明見腳本開頭註解" ;;
    *) usage_die "未知的參數：$1" ;;
  esac
done

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

# cidr_ok <a.b.c.d/p> <min-prefix>：必須是網路位址（iptables -S 的正規化形式），前綴 min..32。
cidr_ok() {
  local c=$1 min=$2 ip p n mask
  [[ $c == */* ]] || return 1
  ip=${c%/*}
  p=${c#*/}
  [[ $p =~ ^[0-9]{1,2}$ ]] && ((p >= min && p <= 32)) || return 1
  ipv4_to_int "$ip" || return 1
  n=$REPLY
  mask=$(((0xFFFFFFFF << (32 - p)) & 0xFFFFFFFF))
  (((n & mask) == n))
}

declare -a CIDR_LIST=()
[[ -n $LAN_CIDRS ]] || usage_die "缺少 --lan-cidr"
IFS=, read -r -a CIDR_LIST <<<"$LAN_CIDRS"
((${#CIDR_LIST[@]} >= 1 && ${#CIDR_LIST[@]} <= 8)) || usage_die "--lan-cidr 需要 1 至 8 個網段"
for c in "${CIDR_LIST[@]}"; do
  cidr_ok "$c" 8 || usage_die "--lan-cidr 項目無效（需為 IPv4 網路位址/8–/32，例如 <192.168.1.0/24>）：$c"
done

declare -a ENV_LIST=()
IFS=, read -r -a ENV_LIST <<<"$ENVS"
((${#ENV_LIST[@]} >= 1)) || usage_die "--envs 不得為空"
declare -A SEEN_ENV=()
for e in "${ENV_LIST[@]}"; do
  [[ $e =~ ^(staging|prod)$ ]] || usage_die "--envs 只接受 staging、prod：$e"
  [[ -z ${SEEN_ENV[$e]:-} ]] || usage_die "--envs 重複：$e"
  SEEN_ENV[$e]=1
done

for e in staging prod; do
  [[ -z ${KEY_FILE[$e]} || -n ${SEEN_ENV[$e]:-} ]] || usage_die "--$e-key 對應的環境不在 --envs 中"
done
if [[ -n ${KEY_FILE[staging]} || -n ${KEY_FILE[prod]} ]]; then
  [[ -n $AGENT_FROM ]] || usage_die "提供部署公鑰時必須指定 --agent-from"
fi
if [[ -n $AGENT_FROM ]]; then
  declare -a FROM_LIST=()
  IFS=, read -r -a FROM_LIST <<<"$AGENT_FROM"
  ((${#FROM_LIST[@]} >= 1 && ${#FROM_LIST[@]} <= 8)) || usage_die "--agent-from 需要 1 至 8 個項目"
  for a in "${FROM_LIST[@]}"; do
    if [[ $a == */* ]]; then
      cidr_ok "$a" 16 || usage_die "--agent-from 項目無效（CIDR 需為網路位址/16–/32）：$a"
    else
      ipv4_to_int "$a" || usage_die "--agent-from 項目無效：$a"
    fi
  done
fi

# 公鑰：一行「類型 base64 [註解]」，不得帶任何 authorized_keys 選項。
readonly PUBKEY_RE='^(ssh-ed25519|sk-ssh-ed25519@openssh\.com|ecdsa-sha2-nistp(256|384|521)|sk-ecdsa-sha2-nistp256@openssh\.com|ssh-rsa) [A-Za-z0-9+/]{16,8192}={0,3}( [A-Za-z0-9@._:+-]{1,100})?$'
declare -A PUBKEY=([staging]="" [prod]="")
for e in staging prod; do
  f=${KEY_FILE[$e]}
  [[ -n $f ]] || continue
  [[ -f $f && -r $f ]] || usage_die "--$e-key 檔案無法讀取：$f"
  lines=()
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    [[ -z $line || $line == \#* ]] && continue
    lines+=("$line")
  done <"$f"
  ((${#lines[@]} == 1)) || usage_die "--$e-key 必須只含一把公鑰"
  [[ ${lines[0]} =~ $PUBKEY_RE ]] || usage_die "--$e-key 不是可接受的 OpenSSH 公鑰（不得含選項）"
  if command -v ssh-keygen >/dev/null 2>&1; then
    ssh-keygen -l -f "$f" >/dev/null 2>&1 || usage_die "--$e-key 無法由 ssh-keygen 解析"
  fi
  PUBKEY[$e]=${lines[0]}
done
if [[ -n ${PUBKEY[staging]} && -n ${PUBKEY[prod]} ]]; then
  read -r _ s_blob _ <<<"${PUBKEY[staging]}"
  read -r _ p_blob _ <<<"${PUBKEY[prod]}"
  [[ $s_blob != "$p_blob" ]] || usage_die "staging 與 prod 必須使用不同的部署金鑰（Req 15.9）"
fi

# ---------------------------------------------------------------------------------------------
# 前置檢查
# ---------------------------------------------------------------------------------------------

[[ ${EUID} -eq 0 ]] || die "必須以 root 執行"
for cmd in install getent groupadd useradd usermod gpasswd id visudo iptables-restore systemctl mktemp stat; do
  command -v "$cmd" >/dev/null 2>&1 || die "缺少必要指令：$cmd"
done

SRC_LM_DEPLOY="$DEPLOY_DIR/bin/lm-deploy"
SRC_COMPOSE="$DEPLOY_DIR/compose/compose.yaml"
SRC_DRILL="$DEPLOY_DIR/compose/drill.yaml"
SRC_CADDY_DIR="$DEPLOY_DIR/caddy"
CADDY_FILES=(Caddyfile tls-off.caddy tls-internal.caddy tls-file.caddy upstream.caddy.tmpl)
SRC_RULES="$SCRIPT_DIR/docker-user.rules"
SRC_UNIT="$SCRIPT_DIR/$UNIT_NAME"
SRC_SUDOERS="$SCRIPT_DIR/sudoers.d/lm-deploy"
SRC_AUTHKEYS="$SCRIPT_DIR/authorized_keys.tmpl"

srcs=("$SRC_LM_DEPLOY" "$SRC_COMPOSE" "$SRC_DRILL" "$SRC_RULES" "$SRC_UNIT" "$SRC_SUDOERS" "$SRC_AUTHKEYS")
for f in "${CADDY_FILES[@]}"; do srcs+=("$SRC_CADDY_DIR/$f"); done
for e in "${ENV_LIST[@]}"; do srcs+=("$DEPLOY_DIR/compose/$e.env.example"); done
for f in "${srcs[@]}"; do
  [[ -f $f && -r $f ]] || die "找不到來源檔：$f"
  # Windows 檢出（CRLF）的檔案在 sudoers／iptables／bash 中會被拒絕或誤判。
  ! grep -q $'\r' -- "$f" || die "來源檔含 CR（請以 LF 檢出，見 .gitattributes）：$f"
done

# path_safe <path>：路徑本身與所有上層目錄皆為 root 擁有、群組／其他人不可寫，且不是符號連結。
path_safe() {
  local p=$1 owner mode
  while :; do
    if [[ -e $p ]]; then
      [[ ! -L $p ]] || return 1
      owner=$(stat -c %u -- "$p")
      mode=$(stat -c %a -- "$p")
      [[ $owner == 0 ]] || return 1
      (((8#$mode & 8#022) == 0)) || return 1
    fi
    [[ $p == / ]] && return 0
    p=$(dirname -- "$p")
  done
}

# ---------------------------------------------------------------------------------------------
# 帳號
# ---------------------------------------------------------------------------------------------

ensure_ops_user() {
  getent group "$OPS_USER" >/dev/null || groupadd --system "$OPS_USER"
  if ! id -u "$OPS_USER" >/dev/null 2>&1; then
    useradd --system --gid "$OPS_USER" --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin --comment "Little Moments operations (backups)" "$OPS_USER"
    log "已建立維運帳號 $OPS_USER"
  fi
}

# drop_priv_groups <user>：移出可直接或間接取得 root 的群組（含 docker.sock 所屬群組）。
drop_priv_groups() {
  local user=$1 g groups sock_group=""
  [[ -S /var/run/docker.sock ]] && sock_group=$(stat -c %G -- /var/run/docker.sock)
  groups=" $(id -nG "$user") "
  for g in $PRIV_GROUPS ${sock_group:+"$sock_group"}; do
    [[ $g == root || $g == "$user" ]] && continue
    if [[ $groups == *" $g "* ]]; then
      gpasswd -d "$user" "$g" >/dev/null
      log "已將 $user 移出群組 $g"
    fi
  done
}

ensure_deploy_user() {
  local env=$1 user="lm-deploy-$1" home
  if ! id -u "$user" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "/home/$user" --no-create-home \
      --shell /bin/sh --comment "Little Moments $env deploy (forced command)" "$user"
    log "已建立部署帳號 $user"
  fi
  # forced command 經由登入 shell 執行，必須是可執行的 shell；不設密碼（「*」：無法以密碼登入，
  # 但不是鎖定帳號，公鑰登入在 UsePAM no 時亦可用）。
  usermod --shell /bin/sh "$user"
  usermod --password '*' "$user"
  drop_priv_groups "$user"
  home=$(getent passwd "$user" | cut -d: -f6)
  [[ $home == /* && $home != / && $home != *..* ]] || die "$user 的家目錄無效：$home"
  # 家目錄與 .ssh 由 root 擁有：部署帳號無法改寫或替換 authorized_keys。
  install -d -o root -g root -m 0755 -- "$home" "$home/.ssh"
  chown root:root -- "$home" "$home/.ssh"
  chmod 0755 -- "$home" "$home/.ssh"
  DEPLOY_HOME[$env]=$home
}

# ---------------------------------------------------------------------------------------------
# 檔案
# ---------------------------------------------------------------------------------------------

# install_atomic <src> <dst> <mode>：同目錄暫存檔 + rename，避免讀到半寫入的檔案。
install_atomic() {
  local src=$1 dst=$2 mode=$3 tmp
  tmp=$(mktemp "$(dirname -- "$dst")/.lm-install.XXXXXX")
  TMP_FILES+=("$tmp")
  cat -- "$src" >"$tmp"
  chown root:root -- "$tmp"
  chmod "$mode" -- "$tmp"
  mv -f -- "$tmp" "$dst"
}

install_lm_deploy() {
  install -d -o root -g root -m 0755 -- "$LM_OPT" "$LM_OPT/bin"
  install_atomic "$SRC_LM_DEPLOY" "$LM_BIN" 0755
  path_safe "$LM_BIN" || die "$LM_BIN 或其上層目錄不是 root 擁有或群組／其他人可寫"
  log "已安裝 $LM_BIN"
}

install_env() {
  local env=$1 d="$LM_ROOT/$1" f
  install -d -o root -g root -m 0755 -- "$LM_ROOT"
  install -d -o root -g root -m 0750 -- "$d"
  install -d -o root -g root -m 0700 -- "$d/state"
  install -d -o root -g root -m 0755 -- "$d/caddy"
  chown root:root -- "$d" "$d/state" "$d/caddy"
  chmod 0750 -- "$d"
  chmod 0700 -- "$d/state"
  chmod 0755 -- "$d/caddy"
  install_atomic "$SRC_COMPOSE" "$d/compose.yaml" 0644
  # 還原演練專案（lm-deploy <env> drill）；只有 internal 網路與匿名卷，不含任何秘密。
  install_atomic "$SRC_DRILL" "$d/drill.yaml" 0644
  for f in "${CADDY_FILES[@]}"; do install_atomic "$SRC_CADDY_DIR/$f" "$d/caddy/$f" 0644; done
  # proxy 首次啟動需要 upstream.caddy；之後只由 lm-deploy switch／rollback 改寫。
  if [[ ! -e $d/caddy/upstream.caddy ]]; then
    local tmp
    tmp=$(mktemp "$d/caddy/.upstream.caddy.XXXXXX")
    TMP_FILES+=("$tmp")
    sed 's/__COLOR__/blue/g' -- "$d/caddy/upstream.caddy.tmpl" >"$tmp"
    chmod 0644 -- "$tmp"
    mv -f -- "$tmp" "$d/caddy/upstream.caddy"
  fi
  if [[ ! -e $d/$env.env ]]; then
    install_atomic "$DEPLOY_DIR/compose/$env.env.example" "$d/$env.env" 0644
    warn "已由範本建立 $d/$env.env，請替換其中所有 <...> 佔位符"
  elif grep -q '<[a-z-]*>' -- "$d/$env.env"; then
    warn "$d/$env.env 仍含 <...> 佔位符"
  fi
  for f in app.env db.env; do
    if [[ -e $d/$f ]]; then
      chown root:root -- "$d/$f"
      chmod 0600 -- "$d/$f"
    else
      warn "$d/$f 不存在：請依 deploy/compose/$f.example 建立（0600 root，不得使用範本中的佔位值）"
    fi
  done
  log "已安裝 $d"
}

# 備份目錄（Req 14.4）：只有 lm-ops 可讀寫；lm-deploy 以 root 寫入後把檔案 chown 為目錄擁有者。
install_backup_dirs() {
  local env d
  [[ ! -L $BACKUP_ROOT ]] || die "$BACKUP_ROOT 不得為符號連結"
  install -d -o "$OPS_USER" -g "$OPS_USER" -m 0700 -- "$BACKUP_ROOT"
  chown "$OPS_USER:$OPS_USER" -- "$BACKUP_ROOT"
  chmod 0700 -- "$BACKUP_ROOT"
  for env in "${ENV_LIST[@]}"; do
    d="$BACKUP_ROOT/$env"
    [[ ! -L $d ]] || die "$d 不得為符號連結"
    install -d -o "$OPS_USER" -g "$OPS_USER" -m 0700 -- "$d"
    # 既有備份檔一併收斂權限（不跟隨符號連結、不跨檔案系統）。
    chown -R --no-dereference "$OPS_USER:$OPS_USER" -- "$d"
    find "$d" -xdev ! -type l -exec chmod go-rwx -- {} +
    chmod 0700 -- "$d"
  done
  log "已設定備份目錄 $BACKUP_ROOT（$OPS_USER 0700）"
}

install_firewall() {
  local tmp line c
  install -d -o root -g root -m 0755 -- "$LM_ETC"
  tmp=$(mktemp "$LM_ETC/.docker-user.rules.XXXXXX")
  TMP_FILES+=("$tmp")
  {
    printf '# 由 deploy/host/install.sh 產生；請勿手動編輯（樣板：deploy/host/docker-user.rules）。\n'
    printf '# 允許的 LAN 網段：%s\n' "${CIDR_LIST[*]}"
    while IFS= read -r line || [[ -n $line ]]; do
      # 樣板註解不複製（其中提到佔位符名稱）；只保留規則本體。
      [[ -z $line || $line == \#* ]] && continue
      if [[ $line == *__LAN_CIDR__* ]]; then
        for c in "${CIDR_LIST[@]}"; do printf '%s\n' "${line//__LAN_CIDR__/$c}"; done
      else
        printf '%s\n' "$line"
      fi
    done <"$SRC_RULES"
  } >"$tmp"
  ! grep -q '__[A-Z_]*__' -- "$tmp" || die "docker-user.rules 仍含未取代的佔位符"
  grep -qx -- '-A DOCKER-USER -m conntrack --ctstate DNAT -j DROP' "$tmp" || die "docker-user.rules 缺少 DROP 規則"
  iptables-restore --test --noflush "$tmp" || die "docker-user.rules 驗證失敗（iptables-restore --test）"
  chown root:root -- "$tmp"
  chmod 0644 -- "$tmp"
  mv -f -- "$tmp" "$RULES_DST"

  install_atomic "$SRC_UNIT" "$UNIT_DST" 0644
  systemctl daemon-reload
  systemctl enable "$UNIT_NAME" >/dev/null 2>&1 || die "無法 enable $UNIT_NAME"
  if systemctl is-active --quiet "$UNIT_NAME"; then
    systemctl reload "$UNIT_NAME" || die "重新套用 DOCKER-USER 規則失敗"
  else
    systemctl restart "$UNIT_NAME" || die "套用 DOCKER-USER 規則失敗（systemctl status $UNIT_NAME）"
  fi
  log "已套用 DOCKER-USER 規則（允許：${CIDR_LIST[*]}）"
}

install_sudoers() {
  local tmp prev=""
  [[ -d /etc/sudoers.d && ! -L /etc/sudoers.d ]] || die "/etc/sudoers.d 不存在"
  grep -Eq '^[@#]includedir[[:space:]]+/etc/sudoers\.d[[:space:]]*$' /etc/sudoers ||
    die "/etc/sudoers 未載入 /etc/sudoers.d（缺少 @includedir /etc/sudoers.d）"
  # 暫存檔名含「.」，sudo 不會在驗證前讀取它。
  tmp=$(mktemp /etc/sudoers.d/.lm-deploy.XXXXXX)
  TMP_FILES+=("$tmp")
  cat -- "$SRC_SUDOERS" >"$tmp"
  chown root:root -- "$tmp"
  chmod 0440 -- "$tmp"
  visudo -cf "$tmp" >/dev/null || die "sudoers.d/lm-deploy 驗證失敗（visudo -cf）"
  if [[ -e $SUDOERS_DST ]]; then
    prev=$(mktemp /etc/sudoers.d/.lm-deploy.prev.XXXXXX)
    TMP_FILES+=("$prev")
    cp -p -- "$SUDOERS_DST" "$prev"
  fi
  mv -f -- "$tmp" "$SUDOERS_DST"
  if ! visudo -c >/dev/null; then
    if [[ -n $prev ]]; then mv -f -- "$prev" "$SUDOERS_DST"; else rm -f -- "$SUDOERS_DST"; fi
    die "安裝後整體 sudoers 驗證失敗，已還原 $SUDOERS_DST"
  fi
  log "已安裝 $SUDOERS_DST"
}

install_authorized_keys() {
  local env=$1 user="lm-deploy-$1" home=${DEPLOY_HOME[$1]} dst tmp line out
  dst="$home/.ssh/authorized_keys"
  if [[ -z ${PUBKEY[$env]} ]]; then
    [[ -s $dst ]] || warn "$user 尚未設定部署公鑰（以 --$env-key 提供）"
    return 0
  fi
  out=""
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    line=${line//__ENV__/$env}
    line=${line//__AGENT_FROM__/$AGENT_FROM}
    line=${line//__PUBKEY__/${PUBKEY[$env]}}
    out+="$line"$'\n'
  done <"$SRC_AUTHKEYS"
  [[ $out == *"command=\"/usr/bin/sudo -n $LM_BIN $env\""* && $out == *'from="'* && $out == *no-pty* ]] ||
    die "authorized_keys 樣板渲染結果無效"
  ! grep -q '__[A-Z_]*__' <<<"$out" || die "authorized_keys 仍含未取代的佔位符"
  tmp=$(mktemp "$home/.ssh/.authorized_keys.XXXXXX")
  TMP_FILES+=("$tmp")
  {
    printf '# 由 deploy/host/install.sh 產生；請勿手動編輯（樣板：deploy/host/authorized_keys.tmpl）。\n'
    printf '%s' "$out"
  } >"$tmp"
  chown root:root -- "$tmp"
  chmod 0644 -- "$tmp"
  mv -f -- "$tmp" "$dst"
  log "已設定 $user 的 authorized_keys（from=$AGENT_FROM）"
}

# ---------------------------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------------------------

declare -A DEPLOY_HOME=()

ensure_ops_user
for e in "${ENV_LIST[@]}"; do ensure_deploy_user "$e"; done
install_lm_deploy
for e in "${ENV_LIST[@]}"; do install_env "$e"; done
install_backup_dirs
install_firewall
install_sudoers
for e in "${ENV_LIST[@]}"; do install_authorized_keys "$e"; done

log "完成。請執行：sudo $SCRIPT_DIR/verify-host.sh --envs $(IFS=,; printf '%s' "${ENV_LIST[*]}")"
