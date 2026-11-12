# LAN Registry 安裝（`deploy/registry/`）

LAN Registry 存放 Build_Image、App_Image 與 Pipeline 使用的第三方工具鏡像（Requirement 3.1、6、15.9、16.10、17.5）。前置的 Caddy 以內部 CA 簽發的憑證提供 TLS、以 basic auth 區分帳號，並限制 HTTP 方法；後面的 CNCF Distribution 只接在 internal 網路，且關閉刪除。Pipeline 一律以 `registry.our-littlemoments.com:8443` 引用它。Jenkins 的安裝見 [`deploy/jenkins/README.md`](../jenkins/README.md)，憑證 ID 與 Jenkins 秘密目錄見 [`ci/jenkins/README.md`](../../ci/jenkins/README.md)。

本文件中所有 `<...>` 都是佔位符：

| 佔位符 | 意義 |
|---|---|
| `<lan-ip>` | Registry 主機的 LAN IP |
| `<repo>` | 主機上的 repository checkout |
| `<registry-dir>` | 主機上 Registry 的 compose 目錄（例如 `/opt/lm-registry`） |
| `<controller-dir>` | Jenkins controller 目錄（`<repo>/deploy/jenkins/controller`），其中的 `secrets/` 存有 Registry 帳號的密碼 |
| `<trusted-agent-dir>` | Trusted Agent 的目錄（見 `deploy/jenkins/README.md`） |

| 檔案 | 內容 |
|---|---|
| `compose.yaml` | 專案 `lm-registry`：`proxy`（Caddy，只發布 `${LM_REGISTRY_LAN_IP}:8443`）與 `registry`（Distribution，不發布連接埠） |
| `Caddyfile` | TLS、basic auth、只有 `lm-push` 可寫入、DELETE 一律 405 |
| `config.yml` | Distribution 設定：關閉刪除、清除未完成的上傳 |
| `htpasswd.example` | `secrets/htpasswd` 的格式（只有佔位符） |
| `verify-registry.sh` | 從用戶端驗證存取控制（非破壞性） |
| `mirror.list` | Pipeline 使用的第三方工具映像與版本 |
| `mirror.sh` | 以 `lm-push` 與 crane 把 `mirror.list` 的映像與 Trivy 漏洞資料庫複製到 Registry，輸出 digest |
| `lm-mirror-trivy-db`、`lm-mirror-trivy-db.env.example`、`lm-mirror-trivy-db.service`、`lm-mirror-trivy-db.timer` | 每日 04:30 複製 Trivy 漏洞資料庫的腳本、設定範本與 systemd unit |
| `.gitignore` | 排除 `secrets/`、`htpasswd`、`*.key`、`*.crt`、`*.pem`、`ca/`、`.env` |

## 1. DNS

在 `our-littlemoments.com` 的 DNS（Cloudflare）新增 A 記錄 `registry` → `<lan-ip>`，Proxy status 設為「DNS only」（不經 Cloudflare proxy）。這個公開名稱解析為私有 IP，所以 LAN 上的主機與容器都能以一般 DNS 解析它，網際網路上的主機則無法連線。

確認主機與兩個 agent 容器都能解析（agent 啟動後執行；`ru` 與 `$A` 的定義見 `deploy/jenkins/README.md`）：

```sh
getent hosts registry.our-littlemoments.com
( cd <trusted-agent-dir> && docker compose -f trusted.compose.yaml exec lm-trusted-1 getent hosts registry.our-littlemoments.com )
ru sh -c "cd '$A' && docker compose -f untrusted.compose.yaml exec lm-untrusted-1 getent hosts registry.our-littlemoments.com"
```

三者都必須輸出 `<lan-ip>  registry.our-littlemoments.com`。沒有輸出時，可能是路由器的 DNS rebinding 保護丟棄了「公開名稱解析為私有 IP」的回應：在路由器把 `our-littlemoments.com` 加入例外，或讓主機改用不做這種過濾的 DNS。

## 2. 檔案與目錄

以下以 root 執行（`sudo -i`）。`ca/` 與 `secrets/` 都在 `<registry-dir>` 內，不在 repository 中。

```sh
install -d -m 755 <registry-dir>
cd <repo>/deploy/registry
install -m 644 compose.yaml Caddyfile config.yml verify-registry.sh <registry-dir>/
install -d -o 10004 -g 10004 -m 700 /srv/lm-registry/data
cd <registry-dir>
```

建立 `<registry-dir>/.env`（不提交）：

```sh
LM_REGISTRY_LAN_IP=<lan-ip>
LM_REGISTRY_HOST=registry.our-littlemoments.com
LM_REGISTRY_DATA_DIR=/srv/lm-registry/data
```

`proxy` 以 `10003:10003`、`registry` 以 `10004:10004` 執行；資料目錄只屬於 `10004`。

## 3. 內部 CA 與伺服器憑證

CA 是 EC P-256、效期 10 年，帶有名稱限制（name constraint），只能簽發 `registry.our-littlemoments.com` 的憑證。伺服器憑證效期 730 天。在 `<registry-dir>` 以 root 執行：

```sh
H=registry.our-littlemoments.com
umask 077
mkdir -p ca

# CA
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ca/ca.key
openssl req -new -key ca/ca.key -subj '/CN=Little Moments Registry CA' -out ca/ca.csr
printf '%s\n' 'basicConstraints=critical,CA:TRUE,pathlen:0' 'keyUsage=critical,keyCertSign,cRLSign' \
  'subjectKeyIdentifier=hash' "nameConstraints=critical,permitted;DNS:$H" > ca/ca.ext
openssl x509 -req -in ca/ca.csr -signkey ca/ca.key -days 3650 -sha256 -extfile ca/ca.ext -out ca/ca.crt
chmod 644 ca/ca.crt

# 伺服器憑證
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out server.key
openssl req -new -key server.key -subj "/CN=$H" -out server.csr
printf '%s\n' "subjectAltName=DNS:$H" 'basicConstraints=critical,CA:FALSE' 'keyUsage=critical,digitalSignature' \
  'extendedKeyUsage=serverAuth' 'authorityKeyIdentifier=keyid' > server.ext
openssl x509 -req -in server.csr -CA ca/ca.crt -CAkey ca/ca.key -CAcreateserial -days 730 -sha256 -extfile server.ext -out server.crt
openssl verify -CAfile ca/ca.crt server.crt      # server.crt: OK

# 安裝
install -d -o root -g root -m 755 secrets
install -d -o root -g 10003 -m 750 secrets/tls
install -o root -g root -m 444 server.crt secrets/tls/registry.crt
install -o root -g 10003 -m 440 server.key secrets/tls/registry.key
rm -f server.key server.csr server.ext server.crt ca/ca.csr
chmod 600 ca/ca.key
```

- `ca/ca.key` 保持 `600 root`，不要刪除：伺服器憑證在 2 年內到期，續期時以同一個 CA 重複「伺服器憑證」與「安裝」兩段，再執行 `docker compose restart proxy`。到期日：`openssl x509 -in secrets/tls/registry.crt -noout -enddate`。用戶端不需要更新 CA。
- 名稱限制使這個 CA 可以安全地加入主機的系統信任清單：即使 `ca.key` 外洩，它簽出的其他網域憑證也會被 OpenSSL 與 Go 程式（Docker、crane、Trivy、cosign）拒絕。

## 4. 帳號（htpasswd）

Registry 只有 3 個帳號，密碼都來自 Jenkins 的秘密目錄（`<controller-dir>/secrets/little-moments/`）：

| 帳號 | Jenkins 憑證 | 權限 |
|---|---|---|
| `lm-pull-ci` | `ci/lm-registry-pull` | 只有 GET／HEAD |
| `lm-pull-release` | `release/lm-registry-pull` | 只有 GET／HEAD |
| `lm-push` | `release/lm-registry-push` 與 `infra/lm-registry-push`（同一個密碼） | 唯一可寫入的帳號 |

Caddyfile 以「不是 `lm-push` 就是唯讀」判斷，之後新增的帳號預設唯讀。Deploy_Host 的拉取帳號（例如 `lm-pull-staging`、`lm-pull-prod`）在 Deploy_Host 安裝時再以同樣方式加入。

在 `<registry-dir>` 以 root 執行。密碼只經 stdin 交給 `caddy hash-password`，不出現在命令列或終端機；雜湊使用 `compose.yaml` 中同一個 Caddy 映像：

```sh
S=<controller-dir>/secrets/little-moments
cmp "$S/release/lm-registry-push.password" "$S/infra/lm-registry-push.password" && echo 'lm-push: same'
IMG=$(awk '$1=="image:" && $2 ~ /^caddy:/ {print $2}' compose.yaml)
h() { printf '%s %s\n' "$(cat "$S/$1.username")" "$(docker run --rm -i "$IMG" caddy hash-password < "$S/$1.password")"; }
( umask 077; { h release/lm-registry-push; h ci/lm-registry-pull; h release/lm-registry-pull; } > htpasswd.tmp )
cut -d' ' -f1 htpasswd.tmp                       # lm-push、lm-pull-ci、lm-pull-release
install -o root -g 10003 -m 440 htpasswd.tmp secrets/htpasswd
rm -f htpasswd.tmp
```

`cmp` 沒有印出 `same` 時，先讓 `release/` 與 `infra/` 的 `lm-registry-push.password` 一致，再重做。之後修改帳號時執行 `docker compose up -d --force-recreate proxy`。

## 5. 啟動與驗證

```sh
docker compose up -d
docker compose ps                                # proxy 與 registry 皆為 running
```

以 `verify-registry.sh` 從用戶端驗證存取控制。密碼由 root 的 shell 從秘密檔讀入環境變數（`export` 是 shell 內建指令，不產生帶有密碼的程序參數），只存在這個子 shell 中：

```sh
(
  export LM_REGISTRY_URL=https://registry.our-littlemoments.com:8443
  export LM_REGISTRY_CA_CERT=ca/ca.crt
  export LM_REGISTRY_PULL_USER="$(cat "$S/ci/lm-registry-pull.username")"
  export LM_REGISTRY_PULL_PASSWORD="$(cat "$S/ci/lm-registry-pull.password")"
  export LM_REGISTRY_PUSH_USER="$(cat "$S/release/lm-registry-push.username")"
  export LM_REGISTRY_PUSH_PASSWORD="$(cat "$S/release/lm-registry-push.password")"
  bash verify-registry.sh
)
```

預期最後一行為 `結果：PASS 22、FAIL 0、SKIP 2`。兩項 SKIP 是 manifest 的 HEAD／GET，只在設定 `LM_REGISTRY_REF`（已存在的標籤或 digest）時檢查。

## 6. 信任內部 CA

主機上有兩個 Docker daemon，另有直接連線 Registry 的工具，共三個位置（`H=registry.our-littlemoments.com`，以 root 在 `<registry-dir>` 執行）：

```sh
# 主機的 Docker daemon（Trusted Agent 與主機上的 docker 指令）
install -d -m 755 "/etc/docker/certs.d/$H:8443"
install -m 644 ca/ca.crt "/etc/docker/certs.d/$H:8443/ca.crt"

# 主機的系統 CA bundle（/etc/ssl/certs/ca-certificates.crt）
install -m 644 ca/ca.crt /usr/local/share/ca-certificates/lm-registry-ca.crt
update-ca-certificates

# lm-untrusted 的 rootless Docker daemon（Untrusted Agent）
UH=$(getent passwd lm-untrusted | cut -d: -f6)
sudo -u lm-untrusted mkdir -p "$UH/.config/docker/certs.d/$H:8443"
install -m 644 -o lm-untrusted -g lm-untrusted ca/ca.crt "$UH/.config/docker/certs.d/$H:8443/ca.crt"
```

- `certs.d` 的目錄名稱必須含連接埠（`:8443`）。
- crane、Trivy 與 cosign 不經 Docker daemon，直接以 HTTPS 連線 Registry。Pipeline 執行它們的步驟把主機的 `/etc/ssl/certs/ca-certificates.crt` 唯讀 bind mount 到容器內（`LM_SCAN_CA_BUNDLE`），`mirror.sh` 與 `lm-mirror-trivy-db` 也一樣，所以主機的 bundle 必須含內部 CA。

以兩個 daemon 各登入一次測試。登入資訊寫入暫時的 `DOCKER_CONFIG` 並立即刪除，密碼只經 stdin：

```sh
# 主機的 daemon
d=$(mktemp -d)
DOCKER_CONFIG=$d docker login -u lm-pull-ci --password-stdin "$H:8443" < "$S/ci/lm-registry-pull.password"
rm -rf "$d"

# rootless daemon
uid=$(id -u lm-untrusted)
sudo -u lm-untrusted -H env DOCKER_HOST=unix:///run/user/$uid/docker.sock \
  sh -c 'd=$(mktemp -d); DOCKER_CONFIG=$d docker login -u lm-pull-ci --password-stdin "$1"; rc=$?; rm -rf "$d"; exit $rc' \
  sh "$H:8443" < "$S/ci/lm-registry-pull.password"
```

兩者都必須輸出 `Login Succeeded`。rootless daemon 的測試必須明確設定 `DOCKER_HOST`：`dockerd-rootless-setuptool.sh` 把 rootless context 記錄在 `~/.docker/config.json`，暫時的 `DOCKER_CONFIG` 沒有這個 context，docker CLI 會改連主機的 `/var/run/docker.sock`。

## 7. 第三方工具鏡像（`mirror.sh`）

Pipeline 的掃描器、Syft、crane、cosign 與 ZAP 只從 LAN Registry 以 digest 拉取。`mirror.sh` 以 `lm-push` 把 `mirror.list` 的每個映像（linux/amd64）複製到 `little-moments/mirror/<名稱>:<上游 tag>`，最後另複製 `mirror.gcr.io/aquasec/trivy-db:2`。以 root 執行：

```sh
cd <repo>/deploy/registry
LM_REGISTRY=registry.our-littlemoments.com:8443 LM_PUSH_PASSWORD_FILE=<controller-dir>/secrets/little-moments/release/lm-registry-push.password \
  bash mirror.sh > mirror.out
cat mirror.out
```

`mirror.out` 每行是一個 `registry.our-littlemoments.com:8443/little-moments/mirror/<名稱>@sha256:<digest>`；失敗的映像為 `FAILED <上游映像>`，腳本以非零結束。進度訊息只寫到 stderr。把每一行貼入對應的變數：

| 名稱 | 變數 |
|---|---|
| `gitleaks` | `Jenkinsfile` 的 `LM_GITLEAKS_IMAGE` |
| `osv-scanner` | `Jenkinsfile` 的 `LM_OSV_SCANNER_IMAGE` |
| `trivy` | `Jenkinsfile` 的 `LM_TRIVY_IMAGE` |
| `semgrep` | `Jenkinsfile` 的 `LM_SEMGREP_IMAGE` |
| `syft` | `Jenkinsfile` 的 `LM_SYFT_IMAGE` |
| `crane` | `Jenkinsfile` 與 `ci/jenkins/pipelines/build-image.Jenkinsfile` 的 `LM_CRANE_IMAGE`，以及 `/etc/lm-mirror-trivy-db.env` 的 `CRANE` |
| `cosign` | `Jenkinsfile` 的 `LM_COSIGN_IMAGE` |
| `zap` | `Jenkinsfile` 的 `LM_ZAP_IMAGE` |

更新工具版本：

1. 修改 `mirror.list` 該行的上游 tag（名稱不變）。
2. 執行 `mirror.sh`，把輸出的新 digest 貼入上表的變數。
3. 執行 `bun test tests/deploy-registry.test.js tests/ci-lint.test.js`，以 PR 合併。

cosign 維持 2.x：Pipeline 使用 cosign 2 的選項（例如 `--insecure-ignore-tlog=true`）。升級主版本之前，必須先修改並驗證 Pipeline 的簽章與驗證步驟。

## 8. Trivy 漏洞資料庫的每日更新

`lm-mirror-trivy-db.timer` 每日 04:30（最多延後 30 分鐘）把 `mirror.gcr.io/aquasec/trivy-db:2` 複製到 `little-moments/mirror/trivy-db:2`（`Jenkinsfile` 的 `LM_TRIVY_DB_REPOSITORY`）。以 root 安裝：

```sh
cd <repo>/deploy/registry
install -m 0755 -o root -g root lm-mirror-trivy-db /usr/local/sbin/lm-mirror-trivy-db
install -m 0600 -o root -g root lm-mirror-trivy-db.env.example /etc/lm-mirror-trivy-db.env
editor /etc/lm-mirror-trivy-db.env
install -m 0644 lm-mirror-trivy-db.service lm-mirror-trivy-db.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now lm-mirror-trivy-db.timer
```

`/etc/lm-mirror-trivy-db.env`（`600 root`，只含路徑，不含密碼）：

```sh
REG='registry.our-littlemoments.com:8443'
PASS='<controller-dir>/secrets/little-moments/release/lm-registry-push.password'
CRANE='<mirror.out 中 crane 的那一行>'
```

確認：

```sh
systemctl list-timers lm-mirror-trivy-db.timer   # 下次執行時間
systemctl start lm-mirror-trivy-db.service       # 立即執行一次
journalctl -u lm-mirror-trivy-db                 # 結果
```

## 9. 疑難排解

- `Could not resolve host: registry.our-littlemoments.com`：DNS 記錄不存在、尚未生效，或被路由器的 DNS rebinding 保護丟棄（見第 1 節）。
- `Failed to connect to registry.our-littlemoments.com port 8443`，且 `docker compose ps` 顯示 `proxy` 為 `restarting`：以 `docker compose logs proxy` 查看。`exec /usr/bin/caddy: operation not permitted` 表示容器缺少 `cap_add: [NET_BIND_SERVICE]`：官方 Caddy 二進位檔帶有 `cap_net_bind_service` 檔案能力，`cap_drop: [ALL]` 時無法執行。repository 的 `compose.yaml` 已修正，若主機上是舊的複本，重新複製後執行 `docker compose up -d`。
- `docker login` 或 `docker pull` 出現 `x509: certificate signed by unknown authority`：該 daemon 的 `certs.d` 目錄缺少 `ca.crt`，或目錄名稱少了 `:8443`（第 6 節）。

## 網路曝露

Registry 不對網際網路公開：`proxy` 只綁定 `<lan-ip>:8443`，`registry` 不發布任何連接埠，路由器也不轉送 8443。DNS 記錄雖然是公開的，但指向私有 IP。
