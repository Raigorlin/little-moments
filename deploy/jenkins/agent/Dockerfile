# Build_Agent 映像（lm-trusted-1 與 lm-untrusted-1 共用；Requirement 2.6；tasks 19.3）。
#
# 基底 inbound-agent:latest-jdk21 與 controller 同樣刻意不以 digest 固定，重建時取得安全更新。
# 只加入 docker CLI 與其 cli-plugins（buildx、compose），不含任何 daemon：
# 建置經由掛載的 socket 使用外部 daemon（trusted 為主機的 Docker，untrusted 為 lm-untrusted 的 rootless Docker）。
FROM jenkins/inbound-agent:latest-jdk21

# docker:cli 官方映像的配置：CLI 位於 /usr/local/bin/docker，plugins 位於 /usr/local/libexec/docker/cli-plugins。
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
