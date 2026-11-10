#!/usr/bin/env sh
# Semgrep SAST 執行包裝（Requirement 6.3；Design §10 SAST 列；供 Jenkinsfile 安全掃描階段使用）。
#
# 掃描範圍決策：只掃描 Req 6.3 指定的 src/、server/、scripts/ 下的 .js 與 .mjs。
#   ci/ 是 Pipeline 工具（只在 Build_Image 內執行、不進入 App_Image），不列入 SAST 目標，以免
#   ci/semgrep/rules/*.js 的刻意違規範例與 ci/ 腳本產生與發布無關的結果；規則本身不限定路徑，
#   日後若擴大範圍可直接加入目標目錄。tests/ 同樣不在範圍內。
# 規則：ci/semgrep/rules/*.yaml（自行撰寫，離線執行，不使用 Semgrep registry）。
#
# 用法：
#   ci/semgrep/run.sh scan <out.json>   產生 JSON 報告，交給 ci/policy/normalize.mjs --tool semgrep
#   ci/semgrep/run.sh test              以 semgrep --test 驗證每條規則的正反範例
# 結束碼沿用 semgrep：scan 時有結果仍為 0（是否失敗由 ci/policy/evaluate.mjs 判定），錯誤為非零。
set -eu

cd "$(dirname "$0")/../.."

case "${1:-}" in
  scan)
    out="${2:?用法：ci/semgrep/run.sh scan <out.json>}"
    exec semgrep scan \
      --config ci/semgrep/rules \
      --metrics=off \
      --disable-version-check \
      --include '*.js' --include '*.mjs' \
      --json --output "$out" \
      src server scripts
    ;;
  test)
    exec semgrep --test --metrics=off --disable-version-check ci/semgrep/rules
    ;;
  *)
    echo '用法：ci/semgrep/run.sh scan <out.json> | test' >&2
    exit 2
    ;;
esac
