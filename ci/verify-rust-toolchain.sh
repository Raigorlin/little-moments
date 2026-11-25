#!/bin/sh
# 比對 Rust 工具鏈映像（根目錄 Dockerfile 的 toolchain 階段）的實際版本與 ci/rust-toolchain.json（plan.md D3）。
#
# 用法（於 repository 根目錄、工具鏈映像內執行）：
#   sh ci/verify-rust-toolchain.sh [--expected ci/rust-toolchain.json] [--out reports/rust-toolchain.json]
#
# 比對：rustc 與 cargo 對 "rust"，trunk、wasm-bindgen、wasm-opt、bats 對同名的鍵。版本取自各工具的 --version 輸出；
# 找不到工具或無法辨識輸出時 actual 為 null，視為不一致。
# 報告：{"ok":<bool>,"tools":[{"tool":…,"expected":…,"actual":…,"ok":<bool>},…]}，只含版本號。
# 結束碼：0 一致；1 不一致或無法取得版本；2 參數無效或無法讀取 --expected。

set -eu

expected_file="ci/rust-toolchain.json"
out_file="reports/rust-toolchain.json"

usage() {
  echo "用法: $0 [--expected <ci/rust-toolchain.json>] [--out <reports/rust-toolchain.json>]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --expected|--out)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        usage
        exit 2
      fi
      if [ "$1" = "--expected" ]; then expected_file="$2"; else out_file="$2"; fi
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage; echo "verify-rust-toolchain: 未知參數: $1" >&2; exit 2 ;;
  esac
done

[ -r "$expected_file" ] || { echo "verify-rust-toolchain: 無法讀取 ${expected_file}" >&2; exit 2; }

# ci/rust-toolchain.json 一個鍵一行（"鍵": "值"）；值只允許數字與點。
json_value() {
  sed -n -E "s/^[[:space:]]*\"$1\"[[:space:]]*:[[:space:]]*\"([0-9.]+)\"[[:space:]]*,?[[:space:]]*$/\\1/p" "$expected_file" | head -n 1
}

# 工具的 --version 輸出 → 版本號；找不到工具或無法辨識時輸出空字串。
actual_version() {
  tool="$1"
  command -v "$tool" >/dev/null 2>&1 || return 0
  output="$("$tool" --version 2>/dev/null || true)"
  case "$tool" in
    rustc) pattern='^rustc ([0-9]+\.[0-9]+\.[0-9]+)([^0-9.].*)?$' ;;
    cargo) pattern='^cargo ([0-9]+\.[0-9]+\.[0-9]+)([^0-9.].*)?$' ;;
    trunk) pattern='^trunk ([0-9]+\.[0-9]+\.[0-9]+)$' ;;
    wasm-bindgen) pattern='^wasm-bindgen ([0-9]+\.[0-9]+\.[0-9]+)$' ;;
    wasm-opt) pattern='^wasm-opt version ([0-9]+)([^0-9].*)?$' ;;
    bats) pattern='^Bats ([0-9]+\.[0-9]+\.[0-9]+)$' ;;
    *) return 0 ;;
  esac
  printf '%s\n' "$output" | sed -n -E "s/${pattern}/\\1/p" | head -n 1
}

json_string_or_null() {
  if [ -n "$1" ]; then printf '"%s"' "$1"; else printf 'null'; fi
}

all_ok=true
entries=""
for pair in rustc:rust cargo:rust trunk:trunk wasm-bindgen:wasm-bindgen wasm-opt:wasm-opt bats:bats; do
  tool="${pair%%:*}"
  key="${pair#*:}"
  want="$(json_value "$key")"
  got="$(actual_version "$tool")"
  ok=false
  if [ -n "$want" ] && [ "$want" = "$got" ]; then
    ok=true
  else
    all_ok=false
    echo "verify-rust-toolchain: ${tool} 版本不一致（預期 ${want:-未設定}，實際 ${got:-無法取得}）" >&2
  fi
  entry="{\"tool\":\"${tool}\",\"expected\":$(json_string_or_null "$want"),\"actual\":$(json_string_or_null "$got"),\"ok\":${ok}}"
  if [ -z "$entries" ]; then entries="$entry"; else entries="${entries},${entry}"; fi
done

mkdir -p "$(dirname "$out_file")"
printf '{"ok":%s,"tools":[%s]}\n' "$all_ok" "$entries" > "$out_file"
cat "$out_file"

if [ "$all_ok" = true ]; then exit 0; fi
exit 1
