# syntax=docker/dockerfile:1.10@sha256:<digest>
# App_Image（Requirement 3.1、15.5、16.2、16.3、16.4、16.5、16.7；design.md Components §11）。
#
# PLACEHOLDER：下列 `sha256:<digest>` 無法離線驗證，必須在第一次建置前由維運者填入實際值
# （Bun 版本須與 ci/toolchain.json 相同）：
#   docker buildx imagetools inspect docker/dockerfile:1.10
#   docker buildx imagetools inspect oven/bun:1.3.0
#   docker buildx imagetools inspect oven/bun:1.3.0-distroless
# 未填入時 FROM 解析失敗，建置不會進行（fail closed）。
#
# 階段：deps（完整安裝）→ build（前端建置 + 伺服器打包）→ prod-deps（只裝 dependencies）→ runtime。
# runtime 只含 Bun、打包後的 server/、tools/、migrations/、dist/ 與正式相依套件；
# 不含 src/、tests/、devDependencies、Playwright、Chromium 或建置工具（Req 16.2）。

FROM oven/bun:1.3.0@sha256:<digest> AS deps
WORKDIR /src
COPY package.json bun.lock ./
# bun.lock 與 package.json 不一致時失敗（Req 16.3）。
RUN bun install --frozen-lockfile

FROM deps AS build
COPY . .
# 打包後目錄 0555、檔案 0444：UID 10001 可讀可進入，但無寫入權（Req 16.4）。COPY --from 會保留這些權限位元。
# scripts/build-server.mjs 產出 /out/server/serve.js、/out/server/migrate.js、/out/tools/import-sqlite.js、/out/tools/drill.js、
# /out/tools/create-admin.js、/out/tools/reset-password.js
# 與 /out/migrations/（server/ 與其匯入的 src/ 模組已打包進單一檔案；dependencies 維持 external）。
RUN bun run build \
 && bun scripts/build-server.mjs --out /out \
 && cp -r dist /out/dist \
 && cp package.json /out/package.json \
 && find /out -type d -exec chmod 0555 {} + \
 && find /out -type f -exec chmod 0444 {} +

FROM oven/bun:1.3.0@sha256:<digest> AS prod-deps
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production \
 && find node_modules -type d -exec chmod 0555 {} + \
 && find node_modules -type f -exec chmod a-w,a+r {} +

FROM oven/bun:1.3.0-distroless@sha256:<digest> AS runtime
ARG REVISION
ARG VERSION
ARG CREATED
# 由 ci/image-labels.mjs 產生（Req 16.5）：revision 為 40 字元 SHA、version 為 main-<短 SHA>、created 為 RFC 3339 UTC。
LABEL org.opencontainers.image.revision=$REVISION \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.created=$CREATED
WORKDIR /app
COPY --from=build --chown=0:0 /out/ /app/
COPY --from=prod-deps --chown=0:0 /src/node_modules /app/node_modules
USER 10001:10001
# Bind_Address、PORT、Allowed_Hosts 與 CAMPING_DATABASE_* 由部署環境（deploy/compose）提供，映像內不設預設值。
ENV NODE_ENV=production \
    CAMPING_DIST=/app/dist \
    CAMPING_MIGRATIONS_DIR=/app/migrations
EXPOSE 5173
# 不設 HEALTHCHECK：distroless 映像沒有 shell／wget，健康檢查由 Deploy_Host 的 lm-deploy 經 proxy 容器
# 呼叫 GET /healthz（5 秒逾時，design.md Components §12）。
ENTRYPOINT ["bun", "/app/server/serve.js"]
