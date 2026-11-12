# syntax=docker/dockerfile:1.10@sha256:865e5dd094beca432e8c0a1d5e1c465db5f998dca4e439981029b3b81fb39ed5
# Build_Image：建置與測試用工具鏈映像（Req 3.1、3.2）。
# 精確版本必須與 ci/toolchain.json 一致；infra/build-image Job 建置後會執行
# ci/verify-toolchain.mjs 確認，並輸出本映像的 digest 供 Jenkinsfile 以 @sha256: 引用。
#
# digest 與 SHA-256 的來源（更新版本時以相同方式重新取得）：
#   syntax 前端      docker buildx imagetools inspect docker/dockerfile:1.10
#   基底映像         docker buildx imagetools inspect mcr.microsoft.com/playwright:v1.56.1-noble
#   BUN_SHA256       https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/SHASUMS256.txt 的 bun-linux-x64.zip
#   NODE_SHA256      https://nodejs.org/dist/v22.20.0/SHASUMS256.txt 的 node-v22.20.0-linux-x64.tar.gz
# 下載內容與 SHA-256 不符時，下方的校驗步驟會使建置失敗（fail closed）。
# Node.js 使用 .tar.gz 發行檔：基底映像沒有 xz，無法解壓 .tar.xz；改用 gzip 即不必另外安裝套件。
#
# Playwright 1.56.1 隨附 Chromium 141.0.7390.37（chromium-1194）。
FROM mcr.microsoft.com/playwright:v1.56.1-noble@sha256:f1e7e01021efd65dd1a2c56064be399f3e4de00fd021ac561325f2bfbb2b837a

ARG BUN_VERSION=1.3.14
ARG BUN_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
ARG NODE_VERSION=22.20.0
ARG NODE_SHA256=eeaccb0378b79406f2208e8b37a62479c70595e20be6b659125eb77dd1ab2a29

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# 精確版本的 Node.js：覆蓋基底映像以套件管理器安裝、版本不固定的 Node。
RUN case "${NODE_SHA256}" in "<"*) echo "NODE_SHA256 尚未設定" >&2; exit 1;; esac \
 && curl -fsSLo /tmp/node.tar.gz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" \
 && echo "${NODE_SHA256}  /tmp/node.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1 --no-same-owner \
 && rm /tmp/node.tar.gz \
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
