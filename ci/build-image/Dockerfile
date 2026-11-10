# syntax=docker/dockerfile:1.10
# Build_Image：建置與測試用工具鏈映像（Req 3.1、3.2）。
# 精確版本必須與 ci/toolchain.json 一致；infra/build-image Job 建置後會執行
# ci/verify-toolchain.mjs 確認，並輸出本映像的 digest 供 Jenkinsfile 以 @sha256: 引用。
#
# PLACEHOLDER：下列 `sha256:<digest>` 與 *_SHA256 預設值無法離線驗證，必須在第一次
# 建置前由維運者填入實際值：
#   docker buildx imagetools inspect mcr.microsoft.com/playwright:v1.56.1-noble
#   https://github.com/oven-sh/bun/releases/download/bun-v<BUN_VERSION>/SHASUMS256.txt
#   https://nodejs.org/dist/v<NODE_VERSION>/SHASUMS256.txt
# 未填入時 FROM 解析或下方的校驗步驟會使建置失敗（fail closed）。
#
# Playwright 1.56.1 隨附 Chromium 141.0.7390.37（chromium-1194）。
FROM mcr.microsoft.com/playwright:v1.56.1-noble@sha256:<digest>

ARG BUN_VERSION=1.3.0
ARG BUN_SHA256=<bun-linux-x64-zip-sha256>
ARG NODE_VERSION=22.20.0
ARG NODE_SHA256=<node-linux-x64-tar-xz-sha256>

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# 精確版本的 Node.js：覆蓋基底映像以套件管理器安裝、版本不固定的 Node。
RUN case "${NODE_SHA256}" in "<"*) echo "NODE_SHA256 尚未設定" >&2; exit 1;; esac \
 && curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
 && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
 && rm /tmp/node.tar.xz \
 && hash -r && [ "$(/usr/local/bin/node --version)" = "v${NODE_VERSION}" ]

# 精確版本的 Bun。
RUN case "${BUN_SHA256}" in "<"*) echo "BUN_SHA256 尚未設定" >&2; exit 1;; esac \
 && apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/* \
 && curl -fsSLo /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
 && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - \
 && unzip -q /tmp/bun.zip -d /tmp/bun \
 && install -m 0755 /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun \
 && rm -rf /tmp/bun /tmp/bun.zip \
 && [ "$(/usr/local/bin/bun --version)" = "${BUN_VERSION}" ]

# 穩定的 Chromium 路徑，供 Pipeline 設定 CHROME_PATH（Req 3.8）。
RUN chrome="$(ls -d /ms-playwright/chromium-*/chrome-linux*/chrome | head -n 1)" \
 && [ -x "$chrome" ] \
 && ln -s "$chrome" /usr/local/bin/chromium

ENV CHROME_PATH=/usr/local/bin/chromium \
    CAMPING_BUN=/usr/local/bin/bun \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
