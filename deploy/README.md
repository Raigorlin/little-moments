# Deploy_Host：Rust 版本與自架 Supabase 的部署（runbook）

本文件是 Deploy_Host 維運者的操作手冊，對象是 v2.0.0 起的 Rust 版本（`lm-server` + Leptos 前端，App_Image 見根目錄 `Dockerfile`）與每個環境各自一套的自架 Supabase（Postgres、Auth、Realtime 與 API gateway）。需求與設計見 `.kiro/specs/jenkins-cicd-deploy/` 的 Requirement 28 與 design.md Components 第 30 節。其他元件的安裝步驟見 [`jenkins/README.md`](jenkins/README.md)、[`registry/README.md`](registry/README.md) 與 [`../ci/jenkins/README.md`](../ci/jenkins/README.md)。

Bun 版本（v1.x，最後一版 v1.1.5）的部署文件保留在 tag `v1.1.5` 的 `deploy/README.md`；本文件只在[首次切換](#首次切換)與[回滾到 v1.1.5](#回滾到-v115)兩節提到它。

公開範圍：

- Production 只經 NPM 的 `www.our-littlemoments.com` Proxy Host 公開（`https://www.our-littlemoments.com`）；apex `https://our-littlemoments.com` 只做 301 轉址到 `www`。兩個網域都只以 HTTPS 服務，TLS 由 Cloudflare 與 NPM 終止。
- Staging、LAN Registry 與 Deploy_Host（SSH、LM_Proxy 連接埠）只允許 LAN。Staging 不建立任何 NPM 主機。
- Supabase 的服務（`db`、`auth`、`realtime`、`gateway`）只接在 Compose 的 internal 網路，不發布任何連接埠。
- Jenkins 只公開 `/github-webhook/`（POST），設定見 [`../ci/jenkins/README.md`](../ci/jenkins/README.md) 的「Webhook 驗證與拒絕日誌」。
- 其他對外公開方式（其他連接埠轉發、其他對外的反向代理、通道服務）不在支援範圍內。

本文件中的 `<...>` 是佔位符。Cloudflare 範圍、Edge_Proxy 的實際來源位址與所有金鑰只存在主機上，不寫入 repository。

發布流程（plan.md D1、D2）：`rust`（或任何非 `main` 分支）的推送只跑 `ci/little-moments` 的品質檢查，不建置映像、不部署。合併或推送到 `main` 就是發布：`release/little-moments » main` 依序執行品質檢查 → App_Image 建置、掃描、SBOM、推送與簽章 → Staging 部署與 Smoke_Test → Production 部署與 10 分鐘觀察 → 把版本標籤 `v<Cargo.toml 的 [workspace.package] version>` 指向上線的 digest。沒有人工核准。要再發布一次就先提高 `Cargo.toml` 的版本；`Image Push` 階段在該版本標籤已存在時失敗。

## 主機配置

Deploy_Host、Jenkins controller、兩個 Build_Agent、LAN Registry 與 NPM 都在 `192.168.1.121`（LAN `192.168.1.0/24`）。

| 元件 | 主機上的連接埠 | 對網際網路公開 |
|---|---|---|
| NPM（容器 `nginx`，bridge 網路） | `0.0.0.0:80`、`0.0.0.0:443`；路由器把網際網路 80／443 轉送至此 | 是（Public_Port 80、443） |
| NPM 管理介面 | `192.168.1.121:81` | 否 |
| Jenkins controller（`lm-jenkins-jenkins-1`） | `192.168.1.121:8080`；NPM 經共用的 `proxy` Docker 網路轉送 webhook | 只公開 `/github-webhook/` |
| Staging LM_Proxy（`lm-staging`） | `192.168.1.121:8081` | 否 |
| Production LM_Proxy（`lm-prod`） | `192.168.1.121:8082` | 只經 NPM |
| LAN Registry | `192.168.1.121:8443` | 否 |
| 暫時預覽 App（`lm-preview`，維運者的暫時措施） | `192.168.1.121:8090` | 否 |
| Deploy_Host SSH | `0.0.0.0:22` | 否 |

每個環境是一個 Compose 專案（`deploy/compose/compose.yaml`）：

| 服務 | 映像 | 網路 | 說明 |
|---|---|---|---|
| `proxy` | `caddy:2.10.2-alpine`（digest 釘選） | `edge`、`app` | LM_Proxy，唯一發布連接埠的服務（`LAN_IP:LM_PUBLIC_PORT`）；只接受 `LM_ALLOWED_HOSTS` 的 Host，其他回應 421 |
| `app-blue`／`app-green` | App_Image（`<LM_IMAGE_REPO>@sha256:<digest>`） | `app`、`data` | `lm-server`，在 8080 監聽；`user 65532:65532`、唯讀根目錄、`cap_drop: ALL`。健康檢查為 `GET /robots.txt` |
| `db` | `ghcr.io/supabase/cli/postgres`（Postgres 17；標籤與 digest 見 `compose.yaml`） | `data` | 資料在具名卷 `lm-<env>_sbdata`；Bun 版本的 `lm-<env>_pgdata` 不再使用，也不會被刪除 |
| `auth` | `ghcr.io/supabase/cli/auth:v2.198.0-r0` | `data` | GoTrue；不開放直接註冊，註冊只經 `lm-server` |
| `realtime` | `ghcr.io/supabase/cli/realtime:v2.167.0-r0` | `data` | tenant `realtime-dev` |
| `gateway` | 與 `proxy` 相同的 Caddy 映像，設定 `deploy/supabase/gateway.Caddyfile` | `data` | `lm-server` 以 `SUPABASE_URL=http://gateway:8000` 呼叫 Auth 與 Realtime |

## 主機前置條件

1. Ubuntu 主機上已有 Jenkins controller、兩個 agent、NPM 與 LAN Registry（見上表）。
2. Docker Engine 與 Docker Compose **v2.24 以上**（`docker compose version`）。`lm-deploy` 以兩個 `--env-file` 替換變數並使用 `up --wait`。
3. `openssl`（`deploy/bin/lm-supabase-keys` 使用 `ecparam`、`ec`、`dgst`）、`sha256sum`、`flock`、`timeout`（coreutils／util-linux）。
4. 磁碟：兩套 Supabase stack（Postgres 資料、映像約 1.5 GB）、`/var/backups/little-moments/<env>/` 各 14 份備份、Registry 中的 App_Image，以及兩個 agent 的 Rust 建置快取（見 [`jenkins/README.md`](jenkins/README.md)）。建議 `/var/lib/docker` 至少留 30 GB 可用空間。
5. 對外連線：Deploy_Host 的 Docker 要能從 `ghcr.io` 拉取 Supabase 映像；Build_Agent 建置 Rust 工具鏈時要能連到 `docker.io`、`gcr.io`、`github.com`（trunk、wasm-bindgen、binaryen、bats 的 release 檔）與 `crates.io`（`cargo fetch --locked`）。
6. Deploy_Host 的 Docker 已登入 LAN Registry，可以拉取 `registry.our-littlemoments.com:8443/little-moments@sha256:<digest>`。
7. 以下步驟都在 `192.168.1.121` 上、以維運者自己的帳號在 repository checkout 內執行（`<repo>`）。

`deploy/host/install.sh` 安裝或更新：部署帳號與 sudoers、`/opt/lm/bin/lm-deploy`、`/opt/lm/bin/lm-supabase-keys`、每個環境的 `/srv/lm/<env>/`（`compose.yaml`、`drill.yaml`、`caddy/`、`supabase/gateway.Caddyfile`、`supabase/db-setup.sql`、`state/`；`<env>.env` 只在不存在時由範本建立）、`/var/backups/little-moments/<env>/` 與 DOCKER-USER 規則。它不建立秘密：`app.env` 由 Pipeline 寫入（第 4 節）。可重複執行。

## 1. 確認 Docker 網段

DOCKER-USER 看到的是 DNAT 之後、MASQUERADE 之前的來源位址。從 Docker bridge 網段經 DNAT 連到主機發布連接埠的連線，來源不在 `192.168.1.0/24`，必須把各自的網段加入 `--lan-cidr`，否則規則安裝後會被 DROP。

1. 列出網路與子網：

   ```sh
   sudo docker network ls
   for n in bridge npm_default proxy lm-jenkins-agent_default; do
     printf '%s ' "$n"; sudo docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' "$n"
   done
   sudo docker inspect -f '{{.Name}} {{range $k, $v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}' nginx lm-jenkins-agent-lm-trusted-1-1
   ```

2. 與下表比對。下表是本主機目前由 Docker 分配的值；重新建立任一網路後子網可能改變，必須以步驟 1 重新確認，並以新值重新執行第 2 節。

   | 網段 | Docker 網路 | 為什麼需要 |
   |---|---|---|
   | `192.168.1.0/24` | （實體 LAN） | LAN 用戶端連到 Staging／Production LM_Proxy、Registry 與 Jenkins |
   | `172.17.0.0/16` | 預設 `bridge` | Trusted Agent 經主機 Docker daemon 啟動的 Build_Image、Rust 工具鏈與工具容器：Smoke_Test 連 8081／8082，crane／cosign 連 Registry 8443 |
   | `172.20.0.0/16` | `proxy` | NPM 連到 Production LM_Proxy `192.168.1.121:8082`（NPM 同時接在 `proxy` 與 `npm_default`，兩個都加入） |
   | `172.21.0.0/16` | `npm_default` | 同上 |
   | `172.22.0.0/16` | `lm-jenkins-agent_default` | Trusted Agent 容器連到 controller `192.168.1.121:8080` 與 Registry `192.168.1.121:8443`；缺少此網段時規則一安裝 agent 就會斷線 |

   不需要加入的網路：`lm-registry_backend`、`lm-registry_edge`、`lm-preview`、`jenkins_default`（未使用），以及 `lm-<env>` 的 `app`、`data`（internal，沒有發布連接埠）。Untrusted Agent 使用 rootless Docker（slirp4netns），流量走 OUTPUT 而不經 FORWARD／DOCKER-USER，由 `deploy/jenkins/agent/untrusted/lm-untrusted-fw` 的 owner 規則限制。

3. 確認 Trusted Agent 連到主機 sshd 的來源位址（authorized_keys 的 `from=`，即 `--agent-from`）：

   ```sh
   sudo docker exec lm-jenkins-agent-lm-trusted-1-1 ssh -F /dev/null -o BatchMode=yes \
     -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 22 lm-probe@192.168.1.121 true
   sudo journalctl -u ssh --since -5min | grep lm-probe
   ```

   第一個指令預期驗證失敗；日誌中 `invalid user lm-probe <address>` 的位址應落在 `172.22.0.0/16`。`--agent-from` 使用整個網段 `172.22.0.0/16`，或改用該 `/32`（容器重建後需重新安裝）。

## 2. 安裝 DOCKER-USER 規則與主機檔案

在 Deploy_Host 的 repository checkout 中執行。`LAN` 為第 1 節的網段清單，後續章節沿用此變數：

```sh
LAN=192.168.1.0/24,172.17.0.0/16,172.20.0.0/16,172.21.0.0/16,172.22.0.0/16
```

1. 渲染並以 iptables 驗證語法（唯讀，不變更規則）：

   ```sh
   sudo deploy/host/install.sh --render-rules --lan-cidr "$LAN" --public-port 80,443 > /tmp/lm-rules
   sudo iptables-restore --test --noflush /tmp/lm-rules && echo syntax-ok
   ```

   預期輸出 `syntax-ok`。`--public-port` 等於任一環境的 `LM_PUBLIC_PORT`（8081、8082）時以結束碼 2 拒絕。

2. 確認 sudo 接受 sudoers 檔（傳統 sudo 與 sudo-rs 皆可）：

   ```sh
   sudo --version | head -n1
   sudo visudo -cf deploy/host/sudoers.d/lm-deploy
   ```

   預期第二個指令輸出 `deploy/host/sudoers.d/lm-deploy: parsed OK`。

3. 安裝。只更新檔案或規則時可省略 `--agent-from`、`--staging-key`、`--prod-key`（未提供公鑰時不變更既有 authorized_keys）：

   ```sh
   sudo deploy/host/install.sh --lan-cidr "$LAN" --public-port 80,443 \
     --agent-from 172.22.0.0/16 --staging-key <staging 公鑰檔> --prod-key <prod 公鑰檔>
   sudo cmp deploy/bin/lm-deploy /opt/lm/bin/lm-deploy && sudo cmp deploy/bin/lm-supabase-keys /opt/lm/bin/lm-supabase-keys && echo bin-ok
   ```

   部署帳號的 sudo 權限必須只有一項：`LC_ALL=C sudo -l -U lm-deploy-staging` 在標題之後只列出 `(root) NOPASSWD: /opt/lm/bin/lm-deploy staging`，prod 帳號為 `(root) NOPASSWD: /opt/lm/bin/lm-deploy prod`。多出其他項目時不要繼續，先回報。

4. 確認套用後的規則與渲染結果逐行相同：

   ```sh
   sudo iptables -S DOCKER-USER | grep '^-A' | diff - <(grep '^-A' /tmp/lm-rules) && echo rules-match
   ```

5. 執行主機檢查：

   ```sh
   sudo deploy/host/verify-host.sh --lan-cidr "$LAN" --public-port 80,443
   ```

   預期沒有 FAIL。第一次部署之前 `app.env` 還不存在，相關項目會提出 WARN；設定第 10 節之前，`proxy` 群組會對 prod 的 `LM_EDGE_TRUSTED_PROXIES` 為空提出 WARN，這兩者都是預期的。

6. 確認既有連線仍正常：Jenkins「Nodes」頁中 `lm-trusted-1` 與 `lm-untrusted-1` 仍上線；LAN 內 `curl -sk https://registry.our-littlemoments.com:8443/v2/` 有回應（401 即正常）。

規則安裝後若造成中斷，可暫時恢復 Docker 預設（到下次開機或重新安裝為止）：`sudo iptables -F DOCKER-USER && sudo iptables -A DOCKER-USER -j RETURN`。修正網段後重新執行步驟 1–5。

## 3. Jenkins 憑證

憑證由 `ci/jenkins/jobs.groovy` 在 seed 時自 controller 的秘密目錄建立（plan.md D13；放置方式見 [`../ci/jenkins/README.md`](../ci/jenkins/README.md#秘密目錄)）。`S` 是 `release/` 的秘密目錄，後續章節沿用（本主機的 `<controller-dir>` 為 `~/docker/jenkins`）：

```sh
S=~/docker/jenkins/secrets/little-moments/release
```

| 資料夾 | 憑證 ID | 類型 | 秘密檔（`secrets/little-moments/<資料夾>/` 之下） | 用途 |
|---|---|---|---|---|
| `release/` | `lm-github-app` | GitHub App | `lm-github-app.app-id`、`lm-github-app.key` | checkout、commit status |
| `release/` | `lm-registry-pull` | Username with password | `lm-registry-pull.username`、`.password` | 拉取、簽章與 attestation 驗證 |
| `release/` | `lm-registry-push` | Username with password | `lm-registry-push.username`、`.password` | 推送、cosign 簽章、版本標籤 |
| `release/` | `lm-cosign-key` | Secret file | `lm-cosign-key` | 簽章私鑰 |
| `release/` | `lm-cosign-passphrase` | Secret text | `lm-cosign-passphrase` | 私鑰密碼 |
| `release/` | `lm-cosign-pub` | Secret file | `lm-cosign-pub` | 部署前驗證簽章 |
| `release/` | `lm-deploy-known-hosts` | Secret file | `lm-deploy-known-hosts` | Deploy_Host 主機金鑰 |
| `release/` | `lm-ssh-staging` | SSH Username with private key | `lm-ssh-staging.username`、`.key` | Staging forced command `lm-deploy staging` |
| `release/` | `lm-staging-supabase-env` | Secret file | `lm-staging-supabase-env` | Staging 的 8 個 Supabase 金鑰（第 4 節），經 SSH stdin 交給 `lm-deploy staging deploy` |
| `release/` | `lm-staging-smoke` | Secret file | `lm-staging-smoke` | Staging `smoke-bot` 的密碼（一行） |
| `release/` | `lm-ssh-prod` | SSH Username with private key | `lm-ssh-prod.username`、`.key` | Production 部署、回滾、還原演練 |
| `release/` | `lm-prod-supabase-env` | Secret file | `lm-prod-supabase-env` | Production 的 8 個 Supabase 金鑰（與 Staging 不同） |
| `release/` | `lm-prod-smoke` | Secret file | `lm-prod-smoke` | Production `smoke-bot` 的密碼（一行，與 Staging 不同） |
| `release/` | `lm-jenkins-api-readonly` | Username with password | `.username`、`.password`（API token） | `release/digest-lookup` |
| `release/` | `lm-jenkins-api-retention` | Username with password | `.username`、`.password`（API token） | 設定 keepLog |
| `ci/` | `lm-github-app` | GitHub App | 同上 | checkout、commit status |
| `ci/` | `lm-registry-pull` | Username with password | `.username`、`.password` | Build_Image 與掃描器拉取 |
| `infra/` | `lm-github-app` | GitHub App | 同上 | checkout |
| `infra/` | `lm-registry-push` | Username with password | `.username`、`.password` | 推送 Build_Image |
| SYSTEM | `lm-github-webhook-secret` | Secret text | `secrets/GITHUB_WEBHOOK_SECRET` | 驗證 GitHub webhook |

`release/` 共 15 個。Bun 版本的下列 5 個憑證已退役：`lm-staging-db`、`lm-staging-setup-token`、`lm-prod-db`、`lm-prod-setup-token`、`lm-prod-openai-api-key`。載入新的 `jobs.groovy` 之後（[首次切換](#首次切換)步驟 5），確認它們不再出現在 `release/` 的 Credentials 頁；若仍在，以管理員帳號在該頁刪除。之後才以 `shred -u` 刪除它們的秘密檔：

```sh
cd "$S" && sudo shred -u lm-staging-db.username lm-staging-db.password lm-staging-setup-token \
  lm-prod-db.username lm-prod-db.password lm-prod-setup-token lm-prod-openai-api-key
```

`lm-<env>-smoke` 沿用 Bun 版本的檔案即可（一行、12–128 個字元，不得含 `"` 或 `\`）。Staging 的 `smoke-bot` 由 Pipeline 的 Smoke_Test（`ci/smoke.mjs --provision`）在第一次部署時自動註冊；Production 的 `smoke-bot` 由維運者在[首次切換](#首次切換)步驟 7 註冊。

## 4. Supabase 金鑰

每個環境一組，由 `deploy/bin/lm-supabase-keys`（bash + openssl，安裝於 `/opt/lm/bin/lm-supabase-keys`）產生。它只輸出到 stdout，不寫入任何檔案；秘密不出現在 stderr 或任何程式的指令列。

| 鍵 | 內容 | 使用者 |
|---|---|---|
| `LM_DB_PASSWORD` | 48 個十六進位字元 | `db`（`POSTGRES_PASSWORD`）；`db-setup.sql` 把 `supabase_admin`、`postgres`、`authenticator`、`supabase_auth_admin` 等角色的密碼設為此值；`lm-server` 的 Database 連線 |
| `LM_JWT_SECRET` | 64 個十六進位字元（HS256 secret） | GoTrue、Realtime、`lm-server`；`app.settings.jwt_secret` |
| `LM_ANON_KEY` | 以 `LM_JWT_SECRET` 簽署的 HS256 JWT（`role` 為 `anon`，10 年） | gateway 的 apikey 檢查、`lm-server` |
| `LM_SERVICE_KEY` | 同上，`role` 為 `service_role` | `lm-server` 呼叫 Auth 的 admin API（註冊）、遷移前呼叫 Realtime 的 tenant health |
| `LM_JWT_KEYS` | ES256（P-256）私鑰 JWK 陣列 | GoTrue 的 `GOTRUE_JWT_KEYS`（簽發使用者的 access token） |
| `LM_JWKS` | 同一把公鑰與 HS256 `oct` 金鑰組成的 JWKS | Realtime 的 `API_JWT_JWKS`；`lm-server` 經 `/auth/v1/.well-known/jwks.json` 驗證 token |
| `LM_REALTIME_SECRET_KEY_BASE` | 128 個十六進位字元 | Realtime（Phoenix 的 `SECRET_KEY_BASE`） |
| `LM_REALTIME_DB_ENC_KEY` | 16 個十六進位字元 | Realtime 以 AES-128 加密 tenant 設定 |

產生並放入 Jenkins 的秘密目錄（以 prod 為例；Staging 把 `prod` 換成 `staging`）。輸出先寫入維運者自己建立的 0600 檔案，再以 `install` 安裝成 controller 讀得到的擁有者與權限，最後刪除暫存檔：

```sh
f=$(mktemp)
( umask 077; deploy/bin/lm-supabase-keys env prod > "$f" )
grep -c '^LM_[A-Z_]*=' "$f"                          # 8
sudo install -o 1000 -g 1000 -m 600 "$f" "$S/lm-prod-supabase-env"
shred -u "$f"
```

不要以 `cat`、`echo` 或編輯器顯示內容。之後在 Jenkins 執行「Manage Jenkins → Configuration as Code → Reload existing configuration」（見 [`../ci/jenkins/README.md`](../ci/jenkins/README.md#設定載入與更新)）。Pipeline 把秘密檔原樣經 SSH stdin 交給 `lm-deploy <env> deploy <digest> --app-env-stdin`，`lm-deploy` 在任何 docker 指令之前逐鍵驗證格式，再以 0600 root 原子寫入 `/srv/lm/<env>/app.env`（Compose 的第二個 `--env-file`）。只接受這 8 個鍵；任何其他鍵（例如 Bun 版本的 `CAMPING_*`）以 `app_env_invalid`（結束碼 2）拒絕。`ci/scrub.mjs` 遮罩每一行的值，主控台與封存報告不會出現金鑰。

輪替（建議先在 Staging 演練）：

1. 以上方的指令產生整組新金鑰並覆寫 `lm-<env>-supabase-env`，再 Reload existing configuration。`LM_ANON_KEY`、`LM_SERVICE_KEY` 由 `LM_JWT_SECRET` 簽署，不要只換其中一個。
2. 下一次 `main` 的部署寫入新的 `app.env`。`lm-deploy` 的 stack 步驟以 `up -d` 重新建立環境變數改變的 `db`、`auth`、`realtime` 與 `gateway`，並重新執行 `db-setup.sql`（角色密碼與 `app.settings.jwt_*`），新的 App 槽位使用新金鑰。
3. 更換 `LM_JWT_SECRET` 或 `LM_JWT_KEYS` 後，所有既有的 session 失效，使用者需要重新登入。
4. Realtime 只在第一次啟動時建立 tenant `realtime-dev`。更換 `LM_JWT_SECRET`／`LM_JWKS` 後 Realtime 是否沿用舊的 tenant 設定尚未在實機確認；部署後以 Smoke_Test 的 `realtime` 步驟確認，失敗時回報（見[只能在實際主機或 Jenkins 執行的檢查](#只能在實際主機或-jenkins-執行的檢查)）。
5. 只懷疑 `LM_DB_PASSWORD` 外洩時也輪替整組，流程相同。

## 5. 每個環境的 `<env>.env`

`/srv/lm/<env>/<env>.env`（0644 root，只在主機上）沒有秘密。`install.sh` 只在檔案不存在時由 `compose/<env>.env.example` 建立；替換所有佔位符：

| 鍵 | Staging | Production | 說明 |
|---|---|---|---|
| `LAN_IP` | `192.168.1.121` | `192.168.1.121` | proxy 只綁定此位址 |
| `LM_PUBLIC_PORT` | `8081` | `8082` | 不得等於任何 Public_Port（80、443） |
| `LM_ALLOWED_HOSTS` | `192.168.1.121` | `www.our-littlemoments.com 192.168.1.121` | 以空白分隔、1–16 項、不得含 `*`；其他 Host 回應 421。`192.168.1.121` 供 Jenkins 的 Smoke_Test 與維運者經 LAN origin 連線 |
| `LM_HEALTH_HOST` | `192.168.1.121` | `www.our-littlemoments.com` | 健康檢查送出的 Host；必須在 `LM_ALLOWED_HOSTS` 內 |
| `LM_SITE_URL` | `http://192.168.1.121:8081` | `https://www.our-littlemoments.com` | GoTrue 的 Site URL（origin，不含路徑） |
| `LM_PUBLIC_SIGNUP` | `true` | `false` | 不經邀請的註冊。Production 只在首次切換時暫時改為 `true` |
| `LM_AUTH_EMAIL_DOMAIN` | 空白 | 空白 | 合成 email 的網域；空白時為 `users.little-moments.invalid` |
| `LM_EDGE_TRUSTED_PROXIES`、`LM_LAN_CIDR` | 空白 | 第 10 節 | 只有 Production 經 NPM |
| `APP_SUBNET`、`PROXY_IP` | 範本值 | 範本值 | 兩個環境必須不同，且不得與 LAN 網段重疊 |
| `APP_CPUS`、`APP_MEMORY`、`DB_CPUS`、`DB_MEMORY`、`AUTH_MEMORY`、`REALTIME_MEMORY`、`GATEWAY_MEMORY` | 範本值 | 範本值 | 資源上限 |
| `LM_IMAGE_REPO` | `registry.our-littlemoments.com:8443/little-moments` | 同左 | `lm-deploy` 只接受這個 repository 的映像 |

`lm-deploy` 在任何 docker 指令之前驗證這些值，無效時以結束碼 2（`config_invalid`）結束並指出欄位。`<env>.env` 的值只在容器建立時讀取：改完之後依第 12 節重新建立 proxy，或在下一次部署建立新的 App 槽位時生效。

## 6. LM_Proxy 設定解析檢查（手動，需要 Docker）

在釘選的 Caddy 映像中確認 `caddy/Caddyfile`（含渲染後的 `upstream.caddy` 與 `tls-off.caddy`）在 `LM_EDGE_TRUSTED_PROXIES` 各種值下的解析結果。在 repository 根目錄執行；範例位址只用文件保留網段：

```sh
d=$(mktemp -d)
cp deploy/caddy/Caddyfile deploy/caddy/tls-*.caddy "$d/"
sed 's/__COLOR__/blue/' deploy/caddy/upstream.caddy.tmpl > "$d/upstream.caddy"
img=caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
v() { docker run --rm --network none -v "$d:/etc/caddy:ro" -e LM_HEALTH_HOST=www.our-littlemoments.com \
  -e 'LM_ALLOWED_HOSTS=www.our-littlemoments.com 192.168.1.121' "$@" \
  "$img" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 && echo valid || echo invalid; }
v                                                                   # 未設定 → valid
v -e LM_EDGE_TRUSTED_PROXIES=                                       # 空字串 → valid
v -e 'LM_EDGE_TRUSTED_PROXIES=192.0.2.10/32 198.51.100.0/24 2001:db8::/32'   # 多個 CIDR → valid
v -e LM_EDGE_TRUSTED_PROXIES=not-a-cidr                             # 無效 → invalid
v -e LM_EDGE_TRUSTED_PROXIES=192.0.2.0/33                           # 前綴 /33 → invalid
rm -rf "$d"
```

任一結果與註解不同時不要部署，先回報。Caddy 無法解析時 proxy 啟動或 `caddy reload` 失敗並保留舊設定。

## 7. NPM：Production Proxy Host

在 NPM 管理介面（`http://192.168.1.121:81`，只能從 LAN 開啟）設定 `www` 的 Proxy Host：

1. Details：Domain Names `www.our-littlemoments.com`；Scheme `http`；Forward Hostname／IP `192.168.1.121`；Forward Port `8082`。
2. Details：**開啟** Websockets Support。Rust 版本的即時同步經 `/realtime/v1/websocket` 使用 WebSocket；沒有開啟時頁面可以載入，但其他人的變更不會即時出現。Block Common Exploits 可視需要開啟。Cache Assets 保持關閉。
3. Access List：Publicly Accessible（首次切換期間暫時改為只允許 LAN 的 Access List，見[首次切換](#首次切換)）。
4. SSL：Let's Encrypt 憑證，開啟 Force SSL、HTTP/2 Support、HSTS Enabled；HSTS Subdomains 保持關閉。
5. Advanced：保持空白。NPM 預設會送出 `X-Forwarded-For` 與 `X-Forwarded-Proto https`，LM_Proxy 只在來源受信任時採信（第 10 節）。

Let's Encrypt 的 HTTP-01 驗證經 Cloudflare 代理時若失敗，改用 NPM 的 DNS Challenge（Cloudflare API token 只存在 NPM 內），或在申請期間把該 DNS 記錄暫時改為 DNS only。

## 8. NPM：apex Redirection Host

維持不變（Bun 版本已建立時不需要修改）：

1. Domain Names `our-littlemoments.com`；Scheme `https`；Forward Domain `www.our-littlemoments.com`；HTTP Code `301`；開啟 Preserve Path。
2. SSL：`our-littlemoments.com` 自己的 Let's Encrypt 憑證，開啟 Force SSL 與 HSTS Enabled。
3. 確認：`curl -sI https://our-littlemoments.com/some/path?q=1` 回應 `301`，`location: https://www.our-littlemoments.com/some/path?q=1`。

## 9. Cloudflare

1. DNS：`www` 與 apex 的記錄指向路由器的對外 IP，Proxy status 為 **Proxied**（橘色雲）。
2. SSL/TLS → Overview：加密模式為 **Full (strict)**。
3. Network：WebSockets 保持開啟（Cloudflare 預設）。
4. 路由器只把 80／443 轉送到主機；不轉送 81、8080、8081、8082、8090、8443 或 22。
5. 不要為 Staging 建立任何 DNS 記錄或 NPM 主機；Staging 只能從 LAN 以 `http://192.168.1.121:8081` 連線。
6. Jenkins：只有 `/github-webhook/` 公開，其他路徑只允許 LAN，NPM 設定見 [`../ci/jenkins/README.md`](../ci/jenkins/README.md) 的「Webhook 驗證與拒絕日誌」。

## 10. 確認 Edge_Proxy 來源位址並設定 `LM_EDGE_TRUSTED_PROXIES`

`LM_EDGE_TRUSTED_PROXIES` 中代表 NPM 的項目必須是 Production LM_Proxy 實際看到的 TCP 來源。視 Docker 的 MASQUERADE 與 `userland-proxy` 設定，Caddy 看到的可能是 NPM 容器在 `npm_default` 或 `proxy` 網路上的位址，也可能是 lm-prod `edge` 網路的閘道位址。不要猜，以存取日誌確認。從 Bun 版本切換時，沿用 `prod.env.bun-v1.1.5` 的值即可（[首次切換](#首次切換)步驟 4），只在 NPM 或 Docker 網路改變後重做本節：

1. 確認 `prod.env` 的 `LM_EDGE_TRUSTED_PROXIES` 為空並重新建立 proxy（第 12 節）。
2. 從瀏覽器開啟 `https://www.our-littlemoments.com/` 一次。
3. 讀取 LM_Proxy 的 JSON 存取日誌：

   ```sh
   sudo docker logs --since 5m lm-prod-proxy-1 2>&1 | grep '"http.log.access' | grep '"host":"www.our-littlemoments.com"' \
     | grep -o '"remote_ip":"[^"]*"\|"client_ip":"[^"]*"' | sort | uniq -c
   ```

   此時 `remote_ip` 與 `client_ip` 相同，即 Caddy 看到的 NPM 來源位址。以 `sudo docker inspect nginx` 與 `sudo docker network inspect lm-prod_edge` 比對。
4. 下載 Cloudflare 範圍（第 11 節步驟 1），在 `prod.env` 設定（以空白分隔，1–64 項；不得含 `/0`，不得涵蓋整個 LAN 或 Docker 預設 `bridge` 網段）：

   ```
   LM_EDGE_TRUSTED_PROXIES=<步驟 3 的位址>/32 <Cloudflare IPv4 範圍…> <Cloudflare IPv6 範圍…>
   LM_LAN_CIDR=192.168.1.0/24
   ```

5. 以第 12 節重新建立 proxy 容器。`lm-deploy` 在任何 Docker 動作前驗證格式，無效時以結束碼 2（`config_invalid`）結束並指出無效項目。
6. 再從瀏覽器開啟一次，重複步驟 3：`remote_ip` 仍為 NPM 來源位址，`client_ip` 應為瀏覽器的公開 IP（可與 `https://www.cloudflare.com/cdn-cgi/trace` 的 `ip=` 比對）。
7. 執行 `sudo deploy/host/verify-host.sh --lan-cidr "$LAN" --public-port 80,443`，`proxy` 群組不再有 WARN。

## 11. 更新 Cloudflare 範圍

來源為 `https://www.cloudflare.com/ips-v4` 與 `https://www.cloudflare.com/ips-v6`。建議每季，或 Cloudflare 公告範圍變更時執行：

1. 下載兩份清單：

   ```sh
   curl -fsS -o /tmp/cf-v4 https://www.cloudflare.com/ips-v4 && curl -fsS -o /tmp/cf-v6 https://www.cloudflare.com/ips-v6 &&
     { cat /tmp/cf-v4; echo; cat /tmp/cf-v6; echo; } | grep . | sort > /tmp/cf-new
   ```

2. 與 `prod.env` 的現值比對：

   ```sh
   sudo awk -F= '$1=="LM_EDGE_TRUSTED_PROXIES"{print $2}' /srv/lm/prod/prod.env | tr ' ' '\n' | grep . | sort > /tmp/cf-current
   comm -13 /tmp/cf-current /tmp/cf-new   # 新增的範圍
   comm -23 /tmp/cf-current /tmp/cf-new   # 已移除的範圍（NPM 來源位址也會列在這裡，保留它）
   ```

3. 有差異時更新 `/srv/lm/prod/prod.env` 的 `LM_EDGE_TRUSTED_PROXIES`：保留 NPM 來源位址，其餘換成 `/tmp/cf-new` 的內容（總數仍須 ≤ 64）。
4. 重新建立 proxy 容器（第 12 節）。
5. 依第 10 節步驟 3 確認存取日誌的 `client_ip` 為真實用戶端 IP。

## 12. 重新建立 proxy 或 App 容器

`<env>.env` 的值只在容器建立時讀取，`caddy reload` 看不到新的環境變數。重新建立 proxy 會讓該環境短暫中斷連線，不要在 Pipeline 部署或回滾期間執行（`sudo /opt/lm/bin/lm-deploy <env> status` 的 `deployInProgress` 為 `false`、`phase` 為 `idle`）。

1. 先驗證設定：`sudo /opt/lm/bin/lm-deploy prod status` 成功（結束碼 2 時依訊息修正 `prod.env`）。
2. 組出與 `lm-deploy` 相同的 Compose 指令。`compose.yaml` 需要 `APP_IMAGE_BLUE`／`APP_IMAGE_GREEN` 與 `app.env` 的值；兩個槽位都填入作用中的映像（`--no-deps` 不會建立或變更其他服務）：

   ```sh
   cd /srv/lm/prod
   img="$(sudo awk -F= '$1=="LM_IMAGE_REPO"{print $2}' prod.env)@<active-digest>"
   dc() { sudo env LM_ENV=prod APP_IMAGE_BLUE="$img" APP_IMAGE_GREEN="$img" \
     docker compose --project-directory /srv/lm/prod -f compose.yaml --env-file prod.env --env-file app.env "$@"; }
   dc up -d --no-deps proxy
   ```

   `<active-digest>` 是 `sudo /opt/lm/bin/lm-deploy prod status` 輸出中 `active` 的 `digest`（`sha256:<hex>`）。
3. 重新建立作用中的 App 槽位（例如改了 `LM_PUBLIC_SIGNUP`）：`dc --profile <color> up -d --no-deps app-<color>`，`<color>` 為 `active` 的 `color`。
4. 確認：`sudo docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' lm-prod-proxy-1 | grep ^LM_EDGE_TRUSTED_PROXIES=` 顯示新值；`curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: www.our-littlemoments.com' http://192.168.1.121:8082/robots.txt` 回應 200。

## 13. 主機冒煙檢查

1. `sudo deploy/host/verify-host.sh --lan-cidr "$LAN" --public-port 80,443` 沒有 FAIL。
2. 從 LAN 外（例如手機行動網路）：`https://www.our-littlemoments.com/` 可開啟；`https://our-littlemoments.com/` 轉址到 `www`；`<public-ip>:8081`、`:8082`、`:8443`、`:8080`、`:81` 都無法連線。
3. 經 `https://www.our-littlemoments.com` 登入成功；在兩個瀏覽器開啟同一個行程，一邊的變更不需重新整理就出現在另一邊（WebSocket 經 NPM 與 Cloudflare）。
4. LM_Proxy 存取日誌的 `client_ip` 記錄真實用戶端 IP（第 10 節步驟 3）。
5. Staging 只能從 LAN 以 `http://192.168.1.121:8081` 開啟。
6. `sudo docker ps --format '{{.Names}} {{.Ports}}' | grep lm-` 只有 `lm-<env>-proxy-1` 有發布的連接埠。

## 首次切換

從 Bun 版本 v1.1.5 換成 Rust 版本 v2.0.0（plan.md D11）。這是**全新開始**：Rust 版本使用新的 Supabase Database，Bun 的資料先備份並保留，但不匯入。順序固定，每一步完成後才進行下一步。預估 Production 只對 LAN 開放 30–60 分鐘。

以下指令都在 `192.168.1.121` 上以維運者的帳號執行，沿用第 2 節的 `LAN` 與第 3 節的 `S`。先執行 `sudo -v` 快取 sudo 認證，避免管線兩端的 sudo 同時詢問密碼。

1. **以 Bun 版本的 `lm-deploy` 備份**。此時 `/opt/lm/bin/lm-deploy` 仍是 v1.1.5 安裝的版本：

   ```sh
   sudo -v
   sudo /opt/lm/bin/lm-deploy prod backup
   sudo /opt/lm/bin/lm-deploy staging backup
   ```

   每個指令最後一行為 `{"ok":true,"command":"backup",…,"id":"<env>-<YYYYMMDD>T<HHMMSS>Z-<sha7>",…}`，記下 Production 的 `<bun-backup-id>`。建立封存目錄並移入 Bun 版本的全部備份（新的 `lm-deploy` 只修剪 `/var/backups/little-moments/<env>/` 內的已驗證備份，所以 Bun 的備份必須移出）：

   ```sh
   B=/var/backups/little-moments/bun-v1.1.5
   sudo install -d -o lm-ops -g lm-ops -m 0700 "$B"
   for E in prod staging; do sudo sh -c 'mv /var/backups/little-moments/"$1"/"$1"-* "$2"/' sh "$E" "$B"; done
   sudo sh -c 'cd "$1" && sha256sum -c <bun-backup-id>.dump.sha256' sh "$B"
   ```

   預期 `<bun-backup-id>.dump: OK`。再把 `"$B"` 的內容（`.dump`、`.dump.sha256`、`.json`）複製到主機以外的儲存位置（例如加密的外接硬碟），並在該處再執行一次 `sha256sum -c`。Bun 的資料卷 `lm-prod_pgdata` 與 `lm-staging_pgdata` 保留，任何時候都**不要**執行 `docker compose down -v` 或 `docker volume rm`：

   ```sh
   sudo docker volume ls --format '{{.Name}}' | grep -E '^lm-(prod|staging)_pgdata$'
   ```

2. **NPM：只允許 LAN，並開啟 Websockets**。在 NPM 管理介面建立只允許 `192.168.1.0/24` 的 Access List，套用到 `www.our-littlemoments.com` 的 Proxy Host，並在同一個 Proxy Host 開啟 **Websockets Support**（第 7 節）。apex 的 Redirection Host 不變。從 LAN 外開啟 `https://www.our-littlemoments.com/` 應回應 403。若步驟 1 之後仍有使用者寫入，此時再執行一次 `sudo /opt/lm/bin/lm-deploy prod backup` 並同樣移入 `"$B"`。

3. **停止 Bun 版本並封存其設定**。`down` 不加 `-v`，資料卷保留：

   ```sh
   for E in prod staging; do
     sudo docker compose -p "lm-$E" down
     sudo cp -a "/srv/lm/$E" "/srv/lm/$E.bun-v1.1.5"
     sudo mv "/srv/lm/$E/state" "/srv/lm/$E/state.bun-v1.1.5"
     for f in "$E.env" app.env db.env secrets; do
       sudo sh -c '[ ! -e "$1/$2" ] || mv "$1/$2" "$1/$2.bun-v1.1.5"' sh "/srv/lm/$E" "$f"
     done
   done
   sudo docker ps --format '{{.Names}}' | grep -E '^lm-(prod|staging)-' || echo stopped
   ```

   預期最後輸出 `stopped`。`/srv/lm/<env>.bun-v1.1.5/` 是 v1.1.5 設定的完整複本，[回滾到 v1.1.5](#回滾到-v115) 會用到它。

4. **更新主機的 checkout 並執行 `install.sh`**。把 Deploy_Host 的 repository checkout 切到要合併到 `main` 的 commit（`<release-commit>`，即 `rust` 分支通過 `ci/little-moments` 的 commit），再以第 2 節的參數安裝：

   ```sh
   git -C <repo> fetch origin && git -C <repo> checkout --detach <release-commit>
   cd <repo>
   sudo deploy/host/install.sh --lan-cidr "$LAN" --public-port 80,443
   sudo cmp deploy/bin/lm-deploy /opt/lm/bin/lm-deploy && echo lm-deploy-ok
   ```

   `install.sh` 由範本建立新的 `/srv/lm/<env>/<env>.env`。依第 5 節填入；`LM_EDGE_TRUSTED_PROXIES`、`LM_LAN_CIDR`、`APP_SUBNET` 與 `PROXY_IP` 沿用 `/srv/lm/prod/prod.env.bun-v1.1.5`（Staging 為 `staging.env.bun-v1.1.5`）的值。Bun 的 `ALLOWED_HOSTS`、`CAMPING_*` 等鍵不再使用，不要複製。確認設定通過驗證（`app.env` 尚不存在，所以 `status` 以外的子命令會回報 `config_missing`）：

   ```sh
   sudo /opt/lm/bin/lm-deploy staging status && sudo /opt/lm/bin/lm-deploy prod status
   ```

   兩個指令都輸出 `"phase":"idle"` 且 `"active":null`。

5. **產生金鑰並載入 Jenkins 設定**。依第 4 節產生 Staging 與 Production 兩組金鑰（`lm-staging-supabase-env`、`lm-prod-supabase-env`）。再依 [`../ci/jenkins/README.md`](../ci/jenkins/README.md#設定載入與更新) 把 `<release-commit>` 的 `casc.yaml`、`local-security.yaml` 與 `jobs.groovy` 複製到 `casc/`，以假秘密測試後執行 Reload existing configuration。確認 `release/` 的 Credentials 為第 3 節的 15 個，`release/little-moments` 只索引 `main`。之後依第 3 節刪除 5 個退役憑證的秘密檔。

6. **合併到 `main`**。以 PR 把 `rust` 合併到 `main`（`main` 需要 PR 與審查）。`release/little-moments » main` 的建置：
   - 品質檢查、App_Image 建置、掃描、SBOM、推送與簽章通過。
   - Staging Deploy：`lm-deploy staging deploy` 依序輸出 `app-env`、`stack`、`backup`（`"emptyDatabase":true`）、`migrate`（`applied` 為 `supabase/migrations` 的全部檔案）、`start`、`health`、`switch`。Smoke_Test 以 `--provision` 在登入回應 401 時註冊 `smoke-bot`；它是全新 Staging Database 的第一個帳號，因此也是 Staging 的管理員（只在 Staging，無害）。「Staging」關卡通過。
   - Production Deploy：`lm-deploy prod status` 沒有作用中的 digest，建置以「Production 尚未完成首次部署，請依 deploy/README.md 的首次切換步驟完成 bootstrap」記錄「上線後」關卡失敗並停止，不會呼叫 `deploy`。Version Tag 不執行。

   自這個建置取得 Image_Digest：建置頁 Build Artifacts 中的 `reports/image-digest.txt`（一行 `sha256:<hex>`），以下以 `<digest>` 表示。它已通過 Staging 驗證。

7. **Production bootstrap（維運者在主機上執行）**：

   1. 暫時開放註冊，並以 Production 的金鑰部署：

      ```sh
      sudo sed -i 's/^LM_PUBLIC_SIGNUP=.*/LM_PUBLIC_SIGNUP=true/' /srv/lm/prod/prod.env
      sudo cat "$S/lm-prod-supabase-env" | sudo /opt/lm/bin/lm-deploy prod deploy <digest> --app-env-stdin
      ```

      預期 stdout 依序為 `app-env`、`stack`、`backup`（`"emptyDatabase":true`）、`migrate`、`start`、`health`、`switch` 七行，每行 `"ok":true`，結束碼 0。失敗時依[一般部署與 `lm-deploy` 的結束碼](#一般部署與-lm-deploy-的結束碼)處理後重新執行同一個指令。
   2. 註冊管理員：在 LAN 內的瀏覽器開啟 `http://192.168.1.121:8082/register`，以自己的帳號名稱、顯示名稱與密碼註冊。全新 Database 的第一個帳號就是管理員。管理員密碼由維運者自行保管，不放進 Credential_Store。
   3. 註冊 `smoke-bot`（顯示名稱 `smoke-bot`，密碼為 `lm-prod-smoke` 的內容）。密碼只在 root shell 的內建 `printf` 與管線中出現，不出現在任何程序的指令列：

      ```sh
      sudo sh -c 'printf "{\"username\":\"smoke-bot\",\"display_name\":\"smoke-bot\",\"password\":\"%s\"}" "$(cat "$1")"' sh "$S/lm-prod-smoke" \
        | curl -sS -o /dev/null -w '%{http_code}\n' -H 'Content-Type: application/json' --data-binary @- \
          http://192.168.1.121:8082/api/auth/signup
      ```

      預期輸出 `200`。`409` 表示帳號名稱已存在（例如重新執行時），可以繼續。
   4. 關閉註冊並重新建立作用中的 App 槽位：

      ```sh
      sudo sed -i 's/^LM_PUBLIC_SIGNUP=.*/LM_PUBLIC_SIGNUP=false/' /srv/lm/prod/prod.env
      sudo /opt/lm/bin/lm-deploy prod status
      ```

      記下 `active` 的 `color` 與 `digest`，依第 12 節步驟 2–3 執行 `dc --profile <color> up -d --no-deps app-<color>`。確認新容器讀到的值，並等待健康檢查：

      ```sh
      sudo docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' lm-prod-app-<color>-1 | grep ^LM_PUBLIC_SIGNUP=
      sudo /opt/lm/bin/lm-deploy prod health <color> --wait
      ```

      預期 `LM_PUBLIC_SIGNUP=false`，健康檢查以 `"ok":true` 結束。之後不經邀請的註冊回應 403 `signup_invite_only`。
   5. 完成部署：`sudo /opt/lm/bin/lm-deploy prod finalize`。`status` 的 `phase` 回到 `idle`，`active` 為 `<digest>`。

8. **重新對外開放**。以管理員帳號從 LAN 經 `https://www.our-littlemoments.com` 登入，確認行程頁可開啟。把 `www` Proxy Host 的 Access List 改回 Publicly Accessible，再依第 13 節檢查（第 10 節的存取日誌確認可在此時執行）。

9. **以一般流程發布 v2.0.0**。以 PR 合併一個只含空 commit 的變更到 `main`（例如 `git commit --allow-empty -m "chore: release v2.0.0"`）。這次 Production Deploy 看得到作用中的 digest，會部署新的 digest、執行 10 分鐘觀察（健康檢查與兩次不含 `--provision` 的 Smoke_Test）並 finalize，「上線後」關卡通過後 Version Tag 把 `v2.0.0` 指向上線的 digest。不要對步驟 6 的同一個 commit 按 Build Now：該 commit 的 `<LM_IMAGE_REPO>:<完整 SHA>` 標籤已存在，「Image Push」會拒絕覆寫。

`smoke-bot` 在 Production 是真實的 member 帳號，知道密碼的人都能以它登入。密碼只保存在 `lm-prod-smoke`。要更換時：以 `smoke-bot` 登入 App 修改密碼，同一時間以 `put` 覆寫 `lm-prod-smoke`（[`../ci/jenkins/README.md`](../ci/jenkins/README.md#秘密目錄)）並 Reload existing configuration；兩者更新完成之前的 Smoke_Test 會失敗。

## 回滾到 v1.1.5

只在 Rust 版本無法使用、且無法以 `release/rollback` 回到先前的 Rust digest 時使用。v2.0.0 之後寫入的資料**不會**帶回 Bun 版本（兩邊的 Database 互相獨立）。

1. NPM：`www` Proxy Host 套用只允許 LAN 的 Access List（暫停對外服務）。
2. 停用 `release/little-moments`（Jenkins 該 Job 頁的「Disable Multibranch Pipeline」），避免下一次 `main` 的推送重新部署 Rust 版本。
3. 停止 Rust 版本並保留其設定與資料（不加 `-v`，`lm-<env>_sbdata` 保留）：

   ```sh
   for E in prod staging; do
     sudo docker compose -p "lm-$E" down
     sudo mv "/srv/lm/$E" "/srv/lm/$E.rust-v2"
     sudo cp -a "/srv/lm/$E.bun-v1.1.5" "/srv/lm/$E"
   done
   ```

4. 以 v1.1.5 的 `deploy/` 重新安裝（Bun 版本的 `lm-deploy`、`compose.yaml` 與 Caddy 檔案）：

   ```sh
   git -C <repo> checkout --detach v1.1.5
   cd <repo> && sudo deploy/host/install.sh --lan-cidr "$LAN" --public-port 80,443
   ```

5. 啟動 Bun 版本。`<color>`、`<bun-digest>` 為 `sudo /opt/lm/bin/lm-deploy prod status` 輸出中 `active` 的值（還原的 `state/` 記錄的 v1.1.5 版本）：

   ```sh
   cd /srv/lm/prod
   img="$(sudo awk -F= '$1=="LM_IMAGE_REPO"{print $2}' prod.env)@<bun-digest>"
   sudo env LM_ENV=prod APP_IMAGE_BLUE="$img" APP_IMAGE_GREEN="$img" APP_IMAGE_NEW="$img" \
     docker compose --project-directory /srv/lm/prod -f compose.yaml --env-file prod.env --profile <color> up -d db proxy app-<color>
   sudo /opt/lm/bin/lm-deploy prod health <color> --wait
   ```

   `lm-prod_pgdata` 仍保有切換前的資料。Staging 以 `staging` 依同樣方式啟動（需要時）。
6. NPM：`www` Proxy Host 關閉 Websockets Support（v1.1.5 不使用），Access List 改回 Publicly Accessible。
7. Jenkins：要讓 v1.1.5 的 Pipeline 重新運作，必須同時還原 v1.1.5 的 `jobs.groovy` 與 5 個退役憑證的秘密檔，這不在本 runbook 範圍內；先回報。

## 一般部署與 `lm-deploy` 的結束碼

Pipeline 經 SSH forced command 呼叫 `lm-deploy <env> deploy <digest> --app-env-stdin`，依序為：驗證並寫入 `app.env` → stack（`up -d --wait db` → `db-setup.sql` → `up -d auth realtime gateway` → 經 gateway 輪詢 Auth、Realtime 與 gateway 的健康檢查）→ 備份 → 遷移 → 在閒置槽位啟動新映像 → 健康檢查（`GET /robots.txt`，連續 3 次成功）→ 切換 proxy。Pipeline 接著執行 Smoke_Test（`bun ci/smoke.mjs`：`index`、`robots`、`login`、`me`、`trips`、`realtime`、`logout`），Production 另有 10 分鐘觀察，通過後 `finalize`；失敗時自動 `rollback`（切回舊槽位，不執行遷移）。

遷移（plan.md D7）：`migrate` 以新映像的 `/app/migrations`（檔名 `^[0-9]{14}_[a-z0-9_]+\.sql$`）套用，先等 Realtime 建立 `realtime.messages`，再以 `lm_ops.schema_migrations(version, sha256, applied_at)` 記錄。每個未套用的檔案在一個交易內以 `postgres` 角色套用；已套用的檔案內容改變時以 `migration_changed` 拒絕，不套用任何檔案。遷移需要 `LM_BACKUP_MAX_AGE`（1 小時）內的已驗證備份。回滾從不執行遷移，所以遷移必須相容前一版映像（expand/contract）。

| 結束碼 | `reason` | 處理方式 |
|---|---|---|
| 0 | — | 完成 |
| 1 | `stack_db_failed`、`stack_setup_failed`、`stack_auth_failed`、`stack_realtime_failed`、`stack_gateway_failed` | Supabase stack 未就緒。以 `sudo docker logs lm-<env>-<db\|auth\|realtime\|gateway>-1 2>&1 \| tail -n 50` 查看原因，修正後重新部署 |
| 1 | `backup_create_failed`、`backup_verify_failed`、`backup_timeout` | 備份失敗，未遷移也未切換 |
| 1 | `migration_changed`、`migrate_failed` | 輸出的 `migration` 欄位指出檔案。`migration_changed`：已套用的遷移被修改，改以新的遷移檔修正。`migrate_failed`：該檔案的交易已回復，`applied` 列出本次已提交的檔案 |
| 1 | `start_failed`、`health_failed`、`switch_failed`、`rollback_failed`、`finalize_failed`、`upstream_render_failed`、`lock_failed`、`internal` | 依 `message` 處理；`sudo /opt/lm/bin/lm-deploy <env> status` 確認目前狀態 |
| 1 | `drill_keys_failed`、`verify_failed`、`drill_cleanup_failed` | 還原演練失敗（`failedStep` 指出步驟）；`drill_cleanup_failed` 時以 `sudo docker ps -a --filter label=com.docker.compose.project` 找出殘留的 `lm-drill-prod-*` 專案並 `docker compose -p <project> down -v`（只限 `lm-drill-` 開頭的拋棄式專案） |
| 2 | `usage`、`config_missing`、`config_invalid`、`app_env_invalid`、`invalid_digest`、`invalid_color`、`rollback_not_allowed` | 參數或設定錯誤；未執行任何 Docker 指令 |
| 3 | `invalid_phase`、`state_invalid`、`backup_required`、`no_active_slot`、`nothing_to_rollback` | 狀態不允許。有未完成的部署時，等 Pipeline 結束或以 `finalize`／`rollback` 處理 |
| 4 | `deploy_in_progress`、`drill_in_progress` | 鎖被持有；稍後再執行 |

手動回滾到先前的 Rust 版本：以 Release_Approver 在 Jenkins 執行 `release/rollback`，從 Deploy_Host 保留的 3 個 digest 中選擇（見根目錄 README 的「手動回滾（Production）」；流程與 Bun 版本相同）。

## 備份、還原演練與手動還原

備份（plan.md D8）：`lm-deploy <env> backup`（每次部署也會先執行）在 `db` 容器內以 `supabase_admin` 執行 `pg_dump -Fc --data-only --schema=app --schema=auth --exclude-table=auth.schema_migrations`。Schema 來自遷移與 GoTrue，所以只備份資料；Supabase 的 `realtime`、`_realtime` 與 `lm_ops` 不在備份內。驗證大小、`pg_restore --list` 與 sha256 後存放於 `/var/backups/little-moments/<env>/<id>.dump`（lm-ops 擁有、0700），`.dump.sha256` 最後寫入，存在即代表已驗證；每個環境保留最近 14 份。建議定期把 Production 的備份另外複製到主機以外。

還原演練：`release/restore-drill`（cron `H 3 1,15 * *`，也可手動執行）經 SSH 執行 `lm-deploy prod drill`：取最新已驗證備份並重算 sha256 → 以 `drill.yaml` 建立獨立的 Compose 專案 `lm-drill-prod-<8 hex>`（只有 internal 網路與匿名卷，拋棄式金鑰）→ `db-setup.sql` → Auth、Realtime、gateway → 以目前作用中映像的遷移建立 schema → `pg_restore --data-only --disable-triggers` → 驗證 `auth.users` 與 `app.profiles` 的筆數（profiles ≤ users）→ `down -v`。步驟為 `backup_select`、`backup_verify`、`setup`、`db_start`、`stack_start`、`migrate`、`restore`、`verify`、`cleanup`；失敗時 `failedStep` 指出步驟，docker 與 `pg_restore` 的輸出在 `/srv/lm/prod/state/drill-last.log`。演練不影響 Production，也不刪除任何備份。

手動還原（把 Production 的資料換成某一份備份；未在實際主機上驗證，先在 Staging 演練）。還原期間 App 停止服務：

1. `sudo /opt/lm/bin/lm-deploy prod status`：`deployInProgress` 為 `false`、`phase` 為 `idle`；記下 `active` 的 `color`。
2. 選擇備份並驗證：`sudo ls -1 /var/backups/little-moments/prod/ | grep '\.dump\.sha256$'`，再 `sudo sh -c 'cd /var/backups/little-moments/prod && sha256sum -c <backup-id>.dump.sha256'`。
3. 複製到 root 私人目錄（下一步的新備份可能修剪最舊的一份）：`sudo install -d -m 0700 /root/lm-restore && sudo cp -p /var/backups/little-moments/prod/<backup-id>.dump /root/lm-restore/`。
4. 備份目前狀態以便復原：`sudo /opt/lm/bin/lm-deploy prod backup`，記下輸出的 `id`。
5. 停止作用中的 App：`sudo docker stop lm-prod-app-<color>-1`。
6. 在一個交易內清空 `app` 與 `auth` 的資料表（`auth.schema_migrations` 除外）並載入備份；任何錯誤都讓整個交易回復：

   ```sh
   sudo tee /root/lm-restore/truncate.sql > /dev/null <<'SQL'
   DO $$ DECLARE t text; BEGIN
     SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') INTO t FROM pg_tables
       WHERE schemaname IN ('app', 'auth') AND NOT (schemaname = 'auth' AND tablename = 'schema_migrations');
     EXECUTE 'TRUNCATE ' || t || ' CASCADE';
   END $$;
   SQL
   sudo docker cp /root/lm-restore/truncate.sql lm-prod-db-1:/tmp/truncate.sql
   sudo docker cp /root/lm-restore/<backup-id>.dump lm-prod-db-1:/tmp/restore.dump
   sudo docker exec lm-prod-db-1 sh -c '{ cat /tmp/truncate.sql; pg_restore --data-only --disable-triggers -f - /tmp/restore.dump; } \
     | psql -U supabase_admin -d postgres --single-transaction -v ON_ERROR_STOP=1 -q'
   sudo docker exec lm-prod-db-1 rm -f /tmp/truncate.sql /tmp/restore.dump
   ```
7. 啟動 App 並等待健康：`sudo docker start lm-prod-app-<color>-1`，再 `sudo /opt/lm/bin/lm-deploy prod health <color> --wait`。
8. 以管理員與 `smoke-bot` 登入確認（`smoke-bot` 必須存在於還原後的資料中）。
9. 刪除暫存複本：`sudo rm -rf /root/lm-restore`。

步驟 6 失敗時 Database 未改變，直接執行步驟 7。步驟 7 或 8 失敗時，以步驟 4 的備份重複步驟 2–8。

## 只能在實際主機或 Jenkins 執行的檢查

Repository 內的測試（`cargo test`、`bats deploy/tests`、`bun test`）以假的 docker 與靜態檢查驗證腳本與設定；以下項目需要 Docker daemon、Jenkins 或 Deploy_Host，第一次在主機上執行時逐項確認並記錄結果：

| 項目 | 確認方式 | 預期 |
|---|---|---|
| Rust 工具鏈映像與 App_Image 建置 | `release/little-moments » main` 的 Toolchain、Build、Image Build 階段 | 成功；第一次建置因為快取是空的需要較久 |
| App_Image 的 image smoke | Image Build 之後的 `ci/scripts/image-smoke.sh` | `reports/image-smoke-summary.json` 為 pass |
| Trivy、Syft、cosign | Image Scan、SBOM、Image Sign 階段 | 「映像」關卡通過 |
| Supabase 服務以研究得到的 entrypoint 啟動（Postgres 的權限設定、GoTrue 的 migrate + serve、Realtime 的 tenant seed） | 第一次 Staging Deploy 的 `stack` 行 | `"ok":true`，四個服務健康 |
| `db-setup.sql` 與遷移在真實 stack 上執行 | Staging Deploy 的 `migrate` 行 | `applied` 為全部遷移檔 |
| data-only 備份、`pg_restore` 與還原演練 | 手動執行 `release/restore-drill` | `result` 為 pass，`verify` 的筆數合理 |
| NPM Websockets 與 Cloudflare | 第 13 節步驟 3 | 變更即時出現在另一個瀏覽器 |
| CasC 與 Job DSL 載入 | [`../ci/jenkins/README.md`](../ci/jenkins/README.md) 的驗證步驟 | 沒有 `SEVERE`；`release/` 15 個憑證 |
| `rust` 分支與 `main` 的 Pipeline | 推送 `rust`、合併到 `main` | `ci/little-moments` 通過；`main` 依首次切換步驟 6 的預期結束 |
| D10 bootstrap guard | 首次切換步驟 6 | Production Deploy 以「首次部署」訊息停止，未呼叫 `deploy` |
| 首次切換與 v2.0.0 標籤 | 首次切換步驟 7–9 | `v2.0.0` 指向上線的 digest |
| 金鑰輪替後的 Realtime | 第 4 節輪替後的 Smoke_Test | `realtime` 步驟通過 |
| Host_Operator 的手動還原 | 本頁「手動還原」，先在 Staging | 還原後可以登入 |
