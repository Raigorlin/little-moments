#!/usr/bin/env bash
# DAST 網路隔離探測（Req 7.7、7.9）。
#
# 在 DAST_Scanner 發出第一個請求前，於 Test_Environment 的網路命名空間內執行，例如：
#
#   docker run --rm --network "container:lm-dast-app-${BUILD_TAG}" "$BUILD_IMAGE" \
#     bash ci/dast/isolation-probe.sh --allow "lm-dast-db-${BUILD_TAG}:5432" \
#       --probe "${DEPLOY_HOST}:22" --probe "${DEPLOY_HOST}:80" --probe "${LAN_PROBE_HOST}:443"
#
# 參數：
#   --allow host:port   允許連線的位址（Ephemeral_Database），可重複；至少一個
#   --probe host:port   必須無法連線的位址，可重複（Deploy_Host、Staging/Production 連接埠、LAN 主機）
#   --dns name          必須無法解析的外部名稱，可重複
#   --timeout seconds   每次探測逾時，預設 3
#   --no-defaults       不加入預設探測目標
# IPv6 以 [addr]:port 表示。
#
# 預設探測目標（除非 --no-defaults）：1.1.1.1:443、8.8.8.8:53、9.9.9.9:443、DNS example.com，
# 以及預設閘道（若路由表有預設路由）的 22、80、443、8081 連接埠。
#
# 輸出：每個可連線的非允許位址輸出一行 `REACHABLE <address>`，最後輸出一行 JSON 摘要。
# 結束碼：
#   0 只有允許位址可連線
#   1 有任一非允許位址可連線或可解析（列出位址）
#   2 用法錯誤或缺少必要工具
#   3 允許位址無法連線（環境未就緒，探測結果不可信）

set -euo pipefail

timeout_s=3
use_defaults=1
declare -a allow=()
declare -a probes=()
declare -a dns_names=()

usage() {
  echo "用法：isolation-probe.sh --allow host:port [--allow ...] [--probe host:port ...] [--dns name ...] [--timeout s] [--no-defaults]" >&2
  exit 2
}

need_value() {
  if [[ $# -lt 2 || -z "$2" ]]; then
    echo "參數 $1 缺少值" >&2
    usage
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow) need_value "$@"; allow+=("$2"); shift 2 ;;
    --probe) need_value "$@"; probes+=("$2"); shift 2 ;;
    --dns) need_value "$@"; dns_names+=("$2"); shift 2 ;;
    --timeout) need_value "$@"; timeout_s="$2"; shift 2 ;;
    --no-defaults) use_defaults=0; shift ;;
    -h|--help) usage ;;
    *) echo "未知參數：$1" >&2; usage ;;
  esac
done

if [[ ${#allow[@]} -eq 0 ]]; then
  echo "至少需要一個 --allow（Ephemeral_Database 位址）" >&2
  usage
fi
if ! [[ "$timeout_s" =~ ^[1-9][0-9]*$ ]]; then
  echo "--timeout 必須為正整數秒" >&2
  usage
fi
for tool in timeout getent; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "缺少必要工具：$tool" >&2
    exit 2
  fi
done

# 將 host:port 或 [v6]:port 拆成 host 與 port；格式錯誤回傳非零。
split_address() {
  local addr="$1"
  if [[ "$addr" =~ ^\[([0-9A-Fa-f:.]+)\]:([0-9]{1,5})$ ]]; then
    split_host="${BASH_REMATCH[1]}"
    split_port="${BASH_REMATCH[2]}"
  elif [[ "$addr" =~ ^([A-Za-z0-9._-]+):([0-9]{1,5})$ ]]; then
    split_host="${BASH_REMATCH[1]}"
    split_port="${BASH_REMATCH[2]}"
  else
    return 1
  fi
  if (( 10#$split_port < 1 || 10#$split_port > 65535 )); then
    return 1
  fi
}

# TCP 連線測試：在逾時內建立連線即視為可連線。主機與連接埠以位置參數傳入，不經字串拼接。
tcp_reachable() {
  timeout "$timeout_s" bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$1" "$2" >/dev/null 2>&1
}

for a in "${allow[@]}" "${probes[@]}"; do
  if ! split_address "$a"; then
    echo "位址格式無效：$a（應為 host:port 或 [IPv6]:port）" >&2
    exit 2
  fi
done

if [[ "$use_defaults" -eq 1 ]]; then
  probes+=("1.1.1.1:443" "8.8.8.8:53" "9.9.9.9:443")
  dns_names+=("example.com")
  # 預設閘道：/proc/net/route 中 Destination 為 00000000 的列，Gateway 為小端序十六進位。
  if [[ -r /proc/net/route ]]; then
    while read -r _iface dest gw _rest; do
      if [[ "$dest" == "00000000" && "$gw" =~ ^[0-9A-Fa-f]{8}$ && "$gw" != "00000000" ]]; then
        gw_ip="$(printf '%d.%d.%d.%d' "0x${gw:6:2}" "0x${gw:4:2}" "0x${gw:2:2}" "0x${gw:0:2}")"
        for p in 22 80 443 8081; do
          probes+=("${gw_ip}:${p}")
        done
      fi
    done < <(tail -n +2 /proc/net/route)
  fi
fi

is_allowed() {
  local candidate="$1" a
  for a in "${allow[@]}"; do
    if [[ "${candidate,,}" == "${a,,}" ]]; then
      return 0
    fi
  done
  return 1
}

declare -a reachable=()
declare -a allowed_down=()

for a in "${allow[@]}"; do
  split_address "$a"
  if ! tcp_reachable "$split_host" "$split_port"; then
    allowed_down+=("$a")
  fi
done

for p in "${probes[@]}"; do
  if is_allowed "$p"; then
    continue
  fi
  split_address "$p"
  if tcp_reachable "$split_host" "$split_port"; then
    reachable+=("$p")
    echo "REACHABLE ${p}"
  fi
done

for name in "${dns_names[@]}"; do
  if timeout "$timeout_s" getent hosts "$name" >/dev/null 2>&1; then
    reachable+=("dns:${name}")
    echo "REACHABLE dns:${name}"
  fi
done

json_list() {
  local first=1 item out="["
  for item in "$@"; do
    item="${item//\\/\\\\}"
    item="${item//\"/\\\"}"
    if [[ $first -eq 1 ]]; then first=0; else out+=","; fi
    out+="\"${item}\""
  done
  printf '%s]' "$out"
}

printf '{"isolated":%s,"reachable":%s,"allowedUnreachable":%s,"probed":%d}\n' \
  "$([[ ${#reachable[@]} -eq 0 ]] && echo true || echo false)" \
  "$(json_list "${reachable[@]+"${reachable[@]}"}")" \
  "$(json_list "${allowed_down[@]+"${allowed_down[@]}"}")" \
  "$(( ${#probes[@]} + ${#dns_names[@]} ))"

if [[ ${#reachable[@]} -gt 0 ]]; then
  echo "網路隔離檢查失敗：Test_Environment 可連線至 Ephemeral_Database 以外的位址" >&2
  exit 1
fi
if [[ ${#allowed_down[@]} -gt 0 ]]; then
  echo "允許位址無法連線，環境未就緒：${allowed_down[*]}" >&2
  exit 3
fi
exit 0
