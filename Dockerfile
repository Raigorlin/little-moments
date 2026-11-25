# syntax=docker/dockerfile:1.10@sha256:865e5dd094beca432e8c0a1d5e1c465db5f998dca4e439981029b3b81fb39ed5
# App_Image（Rust 版：lm-server + LM_Web 的 trunk dist + supabase/migrations；plan.md D3、D4）。
#
# 階段：toolchain（Rust 工具鏈與 CI 工具，不含 repository 內容）→ build（cargo + trunk）→ runtime（distroless）。
# Pipeline 另以 `docker build --target toolchain`（空的建置內容）建出工具鏈映像，在其中執行 cargo fmt／clippy／test、
# trunk build 與 bats；工具版本與 ci/rust-toolchain.json 相同（ci/verify-rust-toolchain.sh 檢查，
# tests/ci-rust-toolchain.test.js 比對本檔）。
#
# digest 的來源（固定 multi-arch index 的 digest，不固定單一平台的 manifest；更新版本時以相同方式重新取得）：
#   docker/dockerfile:1.10 與今日相同（docker buildx imagetools inspect docker/dockerfile:1.10）。
#   rust:1.100.0-trixie：以 https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/rust:pull
#     取得匿名 token，HEAD https://registry-1.docker.io/v2/library/rust/manifests/1.100.0-trixie
#     （Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json）
#     回應的 Docker-Content-Digest；token 不寫入檔案。
#   gcr.io/distroless/cc-debian13:nonroot：以 https://gcr.io/v2/token?scope=repository:distroless/cc-debian13:pull&service=gcr.io
#     取得匿名 token，GET https://gcr.io/v2/distroless/cc-debian13/manifests/nonroot 回應的 Docker-Content-Digest
#     （等於回應內容的 sha256）。使用 cc 而非 base：lm-server 動態連結 libgcc_s.so.1（Rust 標準函式庫的 unwind），
#     base-debian13 只有 glibc、libssl3 與 CA 憑證，cc-debian13 另含 libgcc-s1。
#   有 Docker 時也可用 docker buildx imagetools inspect <image>:<tag>。
#
# 下載的工具一律以 sha256sum -c 檢查（值的來源）：
#   trunk：release 資產 trunk-x86_64-unknown-linux-gnu.tar.gz.sha256。
#   wasm-bindgen：release 沒有 checksum 資產，值為下載檔案的 sha256（版本須與 Cargo.lock 的 wasm-bindgen 相同）。
#   binaryen（wasm-opt）：release 資產 binaryen-version_<N>-x86_64-linux.tar.gz.sha256。
#   bats-core：GitHub 的 v<版本> 原始碼 tarball，值為下載檔案的 sha256（兩次下載結果相同）。

FROM rust:1.100.0-trixie@sha256:1f65e0abcce9b449f9533df5994f2a62391059196c481a09b8e1b522dd6d75af AS toolchain
ARG TRUNK_VERSION=0.22.2
ARG TRUNK_SHA256=26fca8a9952e46cd7d8b8b9a2e2c1786c090fc14b8e10b6678ab4d0f9f1a385f
ARG WASM_BINDGEN_VERSION=0.2.130
ARG WASM_BINDGEN_SHA256=9687f3bb551b9f66f37ed32a40d7913a00f7962db653054e56857bc306c3227f
ARG BINARYEN_VERSION=131
ARG BINARYEN_SHA256=b5bf1f0eaf17c63ee588ff7a5954dc8f6ce2c26989051c66f24dfe9ece3e46db
ARG BATS_VERSION=1.14.0
ARG BATS_SHA256=bb537b70b15b732f6d8827dd6578e3d8ce166636ce1f18ea9a074184fcce9177
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# RUSTUP_TOOLCHAIN 優先於 rust-toolchain.toml 的 channel = "stable"：不需要網路即可使用映像內的 1.100.0。
# trunk 不檢查新版本，wasm-bindgen 與 wasm-opt 使用 PATH 中的版本（不另外下載）。
ENV RUSTUP_TOOLCHAIN=1.100.0 \
    TRUNK_SKIP_VERSION_CHECK=true
RUN rustup component add rustfmt clippy \
 && rustup target add wasm32-unknown-unknown
RUN tmp="$(mktemp -d)" \
 && curl -fsSL -o "$tmp/trunk.tar.gz" \
      "https://github.com/trunk-rs/trunk/releases/download/v${TRUNK_VERSION}/trunk-x86_64-unknown-linux-gnu.tar.gz" \
 && echo "${TRUNK_SHA256}  $tmp/trunk.tar.gz" | sha256sum -c - \
 && tar -xzf "$tmp/trunk.tar.gz" -C "$tmp" trunk \
 && install -m 0755 "$tmp/trunk" /usr/local/bin/trunk \
 && curl -fsSL -o "$tmp/wasm-bindgen.tar.gz" \
      "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${WASM_BINDGEN_VERSION}/wasm-bindgen-${WASM_BINDGEN_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
 && echo "${WASM_BINDGEN_SHA256}  $tmp/wasm-bindgen.tar.gz" | sha256sum -c - \
 && tar -xzf "$tmp/wasm-bindgen.tar.gz" -C "$tmp" \
 && install -m 0755 "$tmp/wasm-bindgen-${WASM_BINDGEN_VERSION}-x86_64-unknown-linux-musl/wasm-bindgen" /usr/local/bin/wasm-bindgen \
 && curl -fsSL -o "$tmp/binaryen.tar.gz" \
      "https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-x86_64-linux.tar.gz" \
 && echo "${BINARYEN_SHA256}  $tmp/binaryen.tar.gz" | sha256sum -c - \
 && tar -xzf "$tmp/binaryen.tar.gz" -C "$tmp" \
 && install -m 0755 "$tmp/binaryen-version_${BINARYEN_VERSION}/bin/wasm-opt" /usr/local/bin/wasm-opt \
 && curl -fsSL -o "$tmp/bats.tar.gz" \
      "https://github.com/bats-core/bats-core/archive/refs/tags/v${BATS_VERSION}.tar.gz" \
 && echo "${BATS_SHA256}  $tmp/bats.tar.gz" | sha256sum -c - \
 && tar -xzf "$tmp/bats.tar.gz" -C "$tmp" \
 && "$tmp/bats-core-${BATS_VERSION}/install.sh" /usr/local \
 && rm -rf -- "$tmp" \
 && trunk --version && wasm-bindgen --version && wasm-opt --version && bats --version

FROM toolchain AS build
WORKDIR /src
# 建置內容只有 .dockerignore 允許的路徑（Cargo 檔案、.cargo/config.toml、crates/、assets/、supabase/migrations/）。
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY .cargo/ .cargo/
COPY crates/ crates/
COPY assets/ assets/
COPY supabase/migrations/ supabase/migrations/
# cargo fetch 先取得所有平台（含 wasm32）的相依套件；之後的建置不再更新 Cargo.lock（--locked）。
# 輸出目錄 0555、檔案 0444、執行檔 0555：UID 65532 可讀可執行，但無寫入權（COPY --from 保留權限位元）。
RUN --mount=type=cache,id=lm-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=lm-cargo-target,target=/src/target \
    cargo fetch --locked \
 && cargo build --release --locked -p lm-server \
 && trunk build --release --config crates/web/Trunk.toml \
 && install -d /out/bin /out/migrations \
 && install -m 0555 target/release/little-moments-server /out/bin/little-moments-server \
 && cp -R crates/web/dist /out/dist \
 && cp supabase/migrations/*.sql /out/migrations/ \
 && find /out -type d -exec chmod 0555 {} + \
 && find /out -type f ! -path /out/bin/little-moments-server -exec chmod 0444 {} +

FROM gcr.io/distroless/cc-debian13:nonroot@sha256:532c7a94f9e96ba9db75eb9388f4227751131c7cb0a411d1a8521af4096135de AS runtime
ARG REVISION
ARG VERSION
ARG CREATED
# 由 ci/image-labels.mjs 產生：revision 為 40 字元 SHA、version 為 main-<短 SHA>、created 為 RFC 3339 UTC。
LABEL org.opencontainers.image.revision=$REVISION \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.created=$CREATED
# 基底映像的 USER 是 65532；以 root 建立 /app，使目錄屬於 root（UID 65532 不能寫入）。
USER 0:0
WORKDIR /app
COPY --from=build --chown=0:0 /out/ /app/
USER 65532:65532
# DATABASE_URL、SUPABASE_*、LM_AUTH_EMAIL_DOMAIN 與 LM_PUBLIC_SIGNUP 由部署環境（deploy/compose）提供。
ENV LM_BIND=0.0.0.0:8080 \
    LM_STATIC_DIR=/app/dist
EXPOSE 8080
# 不設 HEALTHCHECK：distroless 映像沒有 shell／wget；lm-server 沒有 /healthz，健康檢查由 LM_Proxy 與 lm-deploy
# 以 GET /robots.txt（200）進行。
ENTRYPOINT ["/app/bin/little-moments-server"]
