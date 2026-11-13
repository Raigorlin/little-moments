# Deploy_Host：經同主機 Edge_Proxy 公開 Production（runbook）

本文件說明如何讓 Production_Environment 經同一主機上的 Edge_Proxy（Nginx Proxy Manager，以下稱 NPM）與 Cloudflare 以 `https://www.our-littlemoments.com` 對網際網路公開（Requirement 8.6、8.8–8.10、24.3、25；design.md Components §18）。其他元件的安裝步驟見 [`jenkins/README.md`](jenkins/README.md)、[`registry/README.md`](registry/README.md) 與 [`../ci/jenkins/README.md`](../ci/jenkins/README.md)。

公開範圍：

- Production 只經 NPM 的 `www.our-littlemoments.com` Proxy Host 公開；apex `our-littlemoments.com` 只做 301 轉址。
- Staging、LAN Registry 與 Deploy_Host（SSH、LM_Proxy 連接埠）只允許 LAN。Staging 不建立任何 NPM 主機。
- Jenkins 只公開 `/github-webhook/`（POST），設定見 [`../ci/jenkins/README.md`](../ci/jenkins/README.md) 的「Webhook 驗證與拒絕日誌」。
- 其他對外公開方式（其他連接埠轉發、其他對外的反向代理、通道服務）不在支援範圍內。

本文件中的 `<...>` 是佔位符。Cloudflare 範圍與 Edge_Proxy 的實際來源位址只寫在主機的 `/srv/lm/prod/prod.env`，不寫入 repository。

Staging 與 Production 第一次部署的順序（建立第一個管理員與 Smoke_Test 的 smoke-bot 帳號）見[首次部署與 smoke-bot](#首次部署與-smoke-bot)。Production 收據 AI 的啟用、輪替與停用見最後一節 [Production 收據 AI（OpenAI）](#production-收據-aiopenai)。

## 主機配置

Deploy_Host、Jenkins controller、兩個 Build_Agent、LAN Registry 與 NPM 都在 `192.168.1.121`（LAN `192.168.1.0/24`）。

| 元件 | 主機上的連接埠 | 對網際網路公開 |
|---|---|---|
| NPM（容器 `nginx`，bridge 網路） | `0.0.0.0:80`、`0.0.0.0:443`；路由器把網際網路 80／443 轉送至此 | 是（Public_Port 80、443） |
| NPM 管理介面 | `192.168.1.121:81` | 否 |
| Jenkins controller（`lm-jenkins-jenkins-1`） | `192.168.1.121:8080`；NPM 經共用的 `proxy` Docker 網路轉送 webhook | 只公開 `/github-webhook/` |
| Staging LM_Proxy | `192.168.1.121:8081` | 否 |
| Production LM_Proxy | `192.168.1.121:8082` | 只經 NPM |
| LAN Registry | `192.168.1.121:8443` | 否 |
| 暫時預覽 App（`lm-preview`，維運者的暫時措施） | `192.168.1.121:8090` | 否 |
| Deploy_Host SSH | `0.0.0.0:22` | 否 |

這些連接埠也列在 `Jenkinsfile` 的 `LM_DAST_PROBE_TARGETS`（DAST 的 `--internal` 網路必須連不到任何一個）。主機新增發布連接埠時，以 `sudo ss -ltnp` 確認後同步更新該清單。移除預覽 App 後不需要改清單：連不到的連接埠仍通過探測。

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

2. 與下表比對。下表是本主機目前由 Docker 分配的值；重新建立任一網路（例如 `docker compose down` 後再 `up`）後子網可能改變，必須以步驟 1 重新確認，並以新值重新執行第 2 節。

   | 網段 | Docker 網路 | 為什麼需要 |
   |---|---|---|
   | `192.168.1.0/24` | （實體 LAN） | LAN 用戶端連到 Staging／Production LM_Proxy、Registry 與 Jenkins |
   | `172.17.0.0/16` | 預設 `bridge` | Trusted Agent 經主機 Docker daemon 啟動的 Build_Image 與工具容器（`docker.image(...).inside`、`--network bridge` 的 crane／cosign）：Smoke_Test 連 8081／8082，crane／cosign 連 Registry 8443 |
   | `172.20.0.0/16` | `proxy` | NPM 連到 Production LM_Proxy `192.168.1.121:8082`（NPM 同時接在 `proxy` 與 `npm_default`，實際走哪一個取決於 NPM 容器的預設路由，所以兩個都加入） |
   | `172.21.0.0/16` | `npm_default` | 同上 |
   | `172.22.0.0/16` | `lm-jenkins-agent_default` | Trusted Agent 容器連到 controller `192.168.1.121:8080` 與 Registry `192.168.1.121:8443`；缺少此網段時規則一安裝 agent 就會斷線 |

   不需要加入的網路：`lm-registry_backend`、`lm-registry_edge`、`lm-preview`、`jenkins_default`（未使用）。NPM 經 `proxy` 網路直接連到 Jenkins controller 容器，不經 DNAT。Untrusted Agent 使用 rootless Docker（slirp4netns），流量由主機程序送出、走 OUTPUT 而不經 FORWARD／DOCKER-USER，由 `deploy/jenkins/agent/untrusted/lm-untrusted-fw` 的 owner 規則限制。

3. 確認 Trusted Agent 連到主機 sshd 的來源位址（authorized_keys 的 `from=`，即 `--agent-from`）。SSH 連到 `192.168.1.121:22` 不經 DNAT，sshd 看到的是 agent 容器在 `lm-jenkins-agent_default` 上的位址：

   ```sh
   sudo docker exec lm-jenkins-agent-lm-trusted-1-1 ssh -F /dev/null -o BatchMode=yes \
     -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 22 lm-probe@192.168.1.121 true
   sudo journalctl -u ssh --since -5min | grep lm-probe
   ```

   第一個指令預期驗證失敗；日誌中 `invalid user lm-probe <address>` 的位址應落在 `172.22.0.0/16`。`--agent-from` 使用整個網段 `172.22.0.0/16`（agent 容器重建後位址可能改變，但該網路上只有 Trusted Agent），或改用該 `/32`（容器重建後需重新安裝）。`--agent-from` 的 CIDR 必須是網路位址、前綴 /16–/32。

替代方案：NPM 改用 host 網路。此時 NPM 的連線由主機產生、走 OUTPUT，不受 DOCKER-USER 影響，`--lan-cidr` 不需要 NPM 的網段；Edge_Trusted_Proxies 中代表 NPM 的項目仍須依第 8 節確認。建議沿用 NPM 現有的 bridge 網路並加入其網段。

## 2. 安裝 DOCKER-USER 規則（Public_Port 80、443）

在 Deploy_Host 的 repository checkout 中執行。`LAN` 為第 1 節的網段清單，後續章節沿用此變數：

```sh
LAN=192.168.1.0/24,172.17.0.0/16,172.20.0.0/16,172.21.0.0/16,172.22.0.0/16
```

1. 渲染並以 iptables 驗證語法（唯讀，不變更規則）：

   ```sh
   sudo deploy/host/install.sh --render-rules --lan-cidr "$LAN" --public-port 80,443 > /tmp/lm-rules
   sudo iptables-restore --test --noflush /tmp/lm-rules && echo syntax-ok
   ```

   預期輸出 `syntax-ok`，且 `/tmp/lm-rules` 中兩行 `--ctorigdstport 80`、`--ctorigdstport 443` 位於所有 `-s <網段>` 的 RETURN 之後、`-j DROP` 之前。`--public-port` 等於任一環境的 `LM_PUBLIC_PORT`（8081、8082）時以結束碼 2 拒絕。

2. 安裝：

   先確認主機的 sudo 接受 sudoers 檔。主機可能使用傳統 sudo 或 sudo-rs（Ubuntu 25.10 起預設，例如 `sudo-rs 0.2.13-0ubuntu1.2`），此檔只使用兩者都支援的寫法（design.md Components §20）：

   ```sh
   sudo --version | head -n1
   sudo visudo -cf deploy/host/sudoers.d/lm-deploy
   ```

   預期第二個指令輸出 `deploy/host/sudoers.d/lm-deploy: parsed OK`、結束碼 0。`install.sh` 的 sudoers 步驟執行相同的檢查；失敗時不安裝 sudoers 與 `authorized_keys`、以結束碼 1 結束，修正後以相同參數重新執行即可（冪等）。若 `/etc/sudoers-rs` 存在，sudo-rs 讀取它而非 `/etc/sudoers`，`install.sh` 要求它也含 `@includedir /etc/sudoers.d`。

   ```sh
   sudo deploy/host/install.sh --lan-cidr "$LAN" --public-port 80,443 \
     --agent-from 172.22.0.0/16 --staging-key <staging 公鑰檔> --prod-key <prod 公鑰檔>
   ```

   只更新規則時可省略 `--agent-from`、`--staging-key`、`--prod-key`（未提供公鑰時不變更既有 authorized_keys）。

   安裝後確認部署帳號的 sudo 權限：

   ```sh
   LC_ALL=C sudo -l -U lm-deploy-staging
   LC_ALL=C sudo -l -U lm-deploy-prod
   ```

   sudo-rs 只輸出標題與一個項目（`<hostname>` 為主機名稱）：

   ```text
   User lm-deploy-staging may run the following commands on <hostname>:
       (root) NOPASSWD: /opt/lm/bin/lm-deploy staging
   ```

   傳統 sudo 在標題之前另外列出 `Matching Defaults entries for …`（含 `!lecture`）與 `Runas and Command-specific defaults for …`（`Defaults!/opt/lm/bin/lm-deploy env_keep+=SSH_ORIGINAL_COMMAND`）兩個區塊。兩種實作在標題之後都必須只有這一行；prod 帳號為 `(root) NOPASSWD: /opt/lm/bin/lm-deploy prod`。多出其他項目或顯示 `is not allowed to run sudo` 時不要繼續，先回報。

3. 確認套用後的規則與渲染結果逐行相同（`iptables -S` 的正規化形式）：

   ```sh
   sudo iptables -S DOCKER-USER | grep '^-A' | diff - <(grep '^-A' /tmp/lm-rules) && echo rules-match
   ```

   預期只輸出 `rules-match`。有差異時不要改比對邏輯，先回報差異（樣板須與 `iptables -S` 的輸出逐字相同）。

4. 執行主機檢查：

   ```sh
   sudo deploy/host/verify-host.sh --lan-cidr "$LAN" --public-port 80,443
   ```

   預期沒有 FAIL，其中包含 `PASS account  [staging] sudo 只允許「(root) NOPASSWD: /opt/lm/bin/lm-deploy staging」`、prod 的對應行，以及 `PASS files    /etc/sudoers 載入 /etc/sudoers.d`。設定第 8 節之前，`proxy` 群組會對 prod 的 `LM_EDGE_TRUSTED_PROXIES` 為空提出 WARN，這是預期的。

5. 確認既有連線仍正常：Jenkins「Nodes」頁中 `lm-trusted-1` 與 `lm-untrusted-1` 仍上線；LAN 內 `curl -sk https://registry.our-littlemoments.com:8443/v2/` 有回應（401 即正常）。

規則安裝後若造成中斷，可暫時恢復 Docker 預設（不限制來源，到下次開機或重新安裝為止）：`sudo iptables -F DOCKER-USER && sudo iptables -A DOCKER-USER -j RETURN`。修正網段後重新執行步驟 1–4。

## 3. Production 的 `prod.env`

在 `/srv/lm/prod/prod.env`（只在主機上）設定，範本見 `compose/prod.env.example`：

1. `LAN_IP=192.168.1.121`、`LM_PUBLIC_PORT=8082`（80／443 由 NPM 使用，不得等於任何 Public_Port）。
2. `ALLOWED_HOSTS=www.our-littlemoments.com,192.168.1.121`、`LM_HEALTH_HOST=www.our-littlemoments.com`。`192.168.1.121` 供 Jenkins 的 Smoke_Test 經 LAN origin `http://192.168.1.121:8082` 使用。
3. `LM_LAN_CIDR=192.168.1.0/24`（只用於檢查 Edge_Trusted_Proxies 不涵蓋 LAN，與 `--lan-cidr` 不同）。
4. `LM_EDGE_TRUSTED_PROXIES` 先留空，第 8 節確認來源位址後再填入。

Staging 的 `staging.env` 保持 `LM_EDGE_TRUSTED_PROXIES=`、`LM_LAN_CIDR=` 皆為空（Staging 不經 NPM）。

## 4. LM_Proxy 設定解析檢查（手動，需要 Docker）

在釘選的 Caddy 映像中確認 `caddy/Caddyfile`（含渲染後的 `upstream.caddy` 與 `tls-off.caddy`）在 `LM_EDGE_TRUSTED_PROXIES` 各種值下的解析結果。在 repository 根目錄執行；範例位址只用文件保留網段：

```sh
d=$(mktemp -d)
cp deploy/caddy/Caddyfile deploy/caddy/tls-*.caddy "$d/"
sed 's/__COLOR__/blue/' deploy/caddy/upstream.caddy.tmpl > "$d/upstream.caddy"
img=caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
v() { docker run --rm --network none -v "$d:/etc/caddy:ro" -e LM_HEALTH_HOST=www.our-littlemoments.com "$@" \
  "$img" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 && echo valid || echo invalid; }
v                                                                   # 未設定 → valid
v -e LM_EDGE_TRUSTED_PROXIES=                                       # 空字串 → valid
v -e 'LM_EDGE_TRUSTED_PROXIES=192.0.2.10/32 198.51.100.0/24 2001:db8::/32'   # 多個 CIDR → valid
v -e LM_EDGE_TRUSTED_PROXIES=not-a-cidr                             # 無效 → invalid
v -e LM_EDGE_TRUSTED_PROXIES=192.0.2.0/33                           # 前綴 /33 → invalid
rm -rf "$d"
```

任一結果與註解不同時不要部署，先回報。Caddy 無法解析時 proxy 啟動或 `caddy reload` 失敗並保留舊設定（Req 25.9）。

## 5. NPM：Production Proxy Host

在 NPM 管理介面（`http://192.168.1.121:81`，只能從 LAN 開啟）新增 Proxy Host：

1. Details：Domain Names `www.our-littlemoments.com`；Scheme `http`；Forward Hostname／IP `192.168.1.121`；Forward Port `8082`。
2. Details：**不要**開啟 Websockets Support（App 不使用 WebSocket）。Block Common Exploits 可視需要開啟。Cache Assets 保持關閉。
3. Access List：Publicly Accessible。
4. SSL：Request a new SSL Certificate（Let's Encrypt），開啟 Force SSL、HTTP/2 Support、HSTS Enabled；HSTS Subdomains 保持關閉（LAN 的子網域不一定使用 HTTPS）。
5. Advanced：保持空白。NPM 預設會送出 `X-Forwarded-For`（附加 Cloudflare 的位址）與 `X-Forwarded-Proto https`，LM_Proxy 只在來源受信任時採信（第 8 節）。

Let's Encrypt 的 HTTP-01 驗證經 Cloudflare 代理時若失敗，改用 NPM 的 DNS Challenge（Cloudflare API token 只存在 NPM 內），或在申請期間把該 DNS 記錄暫時改為 DNS only。

## 6. NPM：apex Redirection Host

新增 Redirection Host：

1. Domain Names `our-littlemoments.com`；Scheme `https`；Forward Domain `www.our-littlemoments.com`；HTTP Code `301`；開啟 Preserve Path。
2. SSL：為 `our-littlemoments.com` 另外申請 Let's Encrypt 憑證，開啟 Force SSL 與 HSTS Enabled。
3. 確認：`curl -sI https://our-littlemoments.com/some/path?q=1` 回應 `301`，`location: https://www.our-littlemoments.com/some/path?q=1`。

## 7. Cloudflare

1. DNS：`www` 與 apex 的記錄指向路由器的對外 IP，Proxy status 為 **Proxied**（橘色雲）。
2. SSL/TLS → Overview：加密模式為 **Full (strict)**（Cloudflare 驗證 NPM 的 Let's Encrypt 憑證）。
3. 路由器只把 80／443 轉送到主機；不轉送 81、8080、8081、8082、8090、8443 或 22。
4. 不要為 Staging 建立任何 DNS 記錄或 NPM 主機；Staging 只能從 LAN 以 `http://192.168.1.121:8081` 連線。
5. Jenkins：只有 `/github-webhook/` 公開，其他路徑只允許 LAN，NPM 設定見 [`../ci/jenkins/README.md`](../ci/jenkins/README.md) 的「Webhook 驗證與拒絕日誌」。NPM 管理介面 81 不是 Public_Port，DOCKER-USER 只允許 `--lan-cidr` 的來源連線。

## 8. 確認 Edge_Proxy 來源位址並設定 `LM_EDGE_TRUSTED_PROXIES`

`LM_EDGE_TRUSTED_PROXIES` 中代表 NPM 的項目必須是 Production LM_Proxy 實際看到的 TCP 來源。NPM 連到 `192.168.1.121:8082` 時封包經 DNAT 進入 lm-prod 的 `edge` 網路；視 Docker 的 MASQUERADE 與 `userland-proxy` 設定，Caddy 看到的可能是 NPM 容器在 `npm_default` 或 `proxy` 網路上的位址，也可能是 lm-prod `edge` 網路的閘道位址。不要猜，以存取日誌確認：

1. 第一次 Production 部署完成後，確認 `prod.env` 的 `LM_EDGE_TRUSTED_PROXIES` 為空。
2. 從瀏覽器開啟 `https://www.our-littlemoments.com/` 一次。
3. 讀取 LM_Proxy（`lm-prod` 的 proxy 容器）的 JSON 存取日誌：

   ```sh
   sudo docker logs --since 5m lm-prod-proxy-1 2>&1 | grep '"http.log.access' | grep '"host":"www.our-littlemoments.com"' \
     | grep -o '"remote_ip":"[^"]*"\|"client_ip":"[^"]*"' | sort | uniq -c
   ```

   此時 `remote_ip` 與 `client_ip` 相同，即 Caddy 看到的 NPM 來源位址。以 `sudo docker inspect nginx` 與 `sudo docker network inspect lm-prod_edge` 比對它是 NPM 容器位址還是 `edge` 網路的閘道。
4. 下載 Cloudflare 範圍（第 9 節步驟 1），在 `prod.env` 設定（以空白分隔，1–64 項；不得含 `/0`，不得涵蓋整個 LAN 或 Docker 預設 `bridge` 網段）：

   ```
   LM_EDGE_TRUSTED_PROXIES=<步驟 3 的位址>/32 <Cloudflare IPv4 範圍…> <Cloudflare IPv6 範圍…>
   LM_LAN_CIDR=192.168.1.0/24
   ```

   若步驟 3 的位址是 `edge` 網路的閘道，主機上其他經 `192.168.1.121:8082` 連線的容器也會以同一位址出現並被採信；Untrusted Agent 的 owner 防火牆不允許連到 8082。
5. 以第 10 節的指令重新建立 proxy 容器。`lm-deploy` 在任何 Docker 動作前驗證格式，無效時以結束碼 2（`config_invalid`）結束並指出無效項目。
6. 再從瀏覽器開啟一次，重複步驟 3：`remote_ip` 仍為 NPM 來源位址，`client_ip` 應為瀏覽器的公開 IP（可與 `https://www.cloudflare.com/cdn-cgi/trace` 的 `ip=` 比對）。
7. 執行 `sudo deploy/host/verify-host.sh --lan-cidr "$LAN" --public-port 80,443`，`proxy` 群組不再有 WARN。

## 9. 更新 Cloudflare 範圍

`LM_EDGE_TRUSTED_PROXIES` 中的 Cloudflare 範圍是維運者維護的靜態清單，來源為 `https://www.cloudflare.com/ips-v4` 與 `https://www.cloudflare.com/ips-v6`。建議每季，或 Cloudflare 公告範圍變更時執行：

1. 下載兩份清單（檔尾可能沒有換行，因此逐一補上）：

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

3. 沒有差異時結束。有差異時更新 `/srv/lm/prod/prod.env` 的 `LM_EDGE_TRUSTED_PROXIES`：保留 NPM 來源位址，其餘換成 `/tmp/cf-new` 的內容（以空白分隔，總數仍須 ≤ 64）。
4. 重新建立 proxy 容器（第 10 節）。
5. 從瀏覽器開啟 `https://www.our-littlemoments.com/`，依第 8 節步驟 3 確認存取日誌的 `client_ip` 為真實用戶端 IP，而不是 Cloudflare 或 NPM 的位址。

## 10. 重新建立 Production proxy 容器

`LM_EDGE_TRUSTED_PROXIES` 只在容器建立時讀取，`caddy reload` 看不到新的環境變數。重新建立會讓 Production 短暫中斷連線，不要在 Pipeline 部署或回滾期間執行（`sudo /opt/lm/bin/lm-deploy prod status` 的 `deployInProgress` 為 `false`）。

1. 先驗證設定：`sudo /opt/lm/bin/lm-deploy prod status` 成功（結束碼 2 且訊息含 `LM_EDGE_TRUSTED_PROXIES` 時修正 `prod.env`）。
2. 重新建立 proxy。`compose.yaml` 要求 `APP_IMAGE_*`；只建立 proxy 時與 `lm-deploy` 相同，以全 0 digest 填入未使用的值（`--no-deps` 不會建立或變更 App 容器）：

   ```sh
   cd /srv/lm/prod
   z="$(sudo awk -F= '$1=="LM_IMAGE_REPO"{print $2}' prod.env)@sha256:$(printf '%064d' 0)"
   sudo env LM_ENV=prod APP_IMAGE_BLUE="$z" APP_IMAGE_GREEN="$z" APP_IMAGE_NEW="$z" \
     docker compose --project-directory /srv/lm/prod -f compose.yaml --env-file prod.env up -d --no-deps proxy
   ```

3. 確認：`sudo docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' lm-prod-proxy-1 | grep ^LM_EDGE_TRUSTED_PROXIES=` 顯示新值；`curl -s -o /dev/null -w '%{http_code}\n' http://192.168.1.121:8082/` 回應 200。

## 11. 主機冒煙檢查

1. `sudo deploy/host/verify-host.sh --lan-cidr "$LAN" --public-port 80,443` 沒有 FAIL。
2. 從 LAN 外（例如手機行動網路）：`https://www.our-littlemoments.com/` 可開啟；`<public-ip>:8081`、`:8082`、`:8443`、`:8080`、`:81` 都無法連線。
3. 經 `https://www.our-littlemoments.com` 登入成功，瀏覽器的 `ggc_session` Cookie 帶有 `Secure`。
4. LM_Proxy 存取日誌的 `client_ip` 記錄真實用戶端 IP（第 8 節步驟 3）。
5. Staging 只能從 LAN 以 `http://192.168.1.121:8081` 開啟。

## 首次部署與 smoke-bot

Pipeline 的 Smoke_Test（`scripts/smoke.mjs`）以帳號 `smoke-bot` 與 Credential_Store 中 `lm-<env>-smoke` 的密碼登入，並要求該帳號看得到標題為 `smoke-fixture` 的行程。這兩項資料（Smoke_Account 與 Smoke_Fixture）由 Host_Operator 在 Deploy_Host 上以 `lm-deploy <env> smoke-account` 在每個環境建立一次（Requirement 27；design.md Components §21）。

順序固定為「先管理員、後 smoke-bot」。`create-admin` 與 `/setup` 只在 Database 沒有任何帳號時建立管理員，smoke-bot 若先建立，該環境就無法再建立管理員；所以 `smoke-account` 在沒有管理員時拒絕執行，也不寫入任何資料。

`smoke-account` 只限 Host_Operator 以自己的帳號經 sudo 執行。它不在 SSH forced command 的允許清單內，部署帳號無法執行。密碼只經 stdin 傳入，不出現在指令列、環境變數或輸出中。它依序執行：讀入密碼 → `db` 未執行時啟動並等待健康檢查（5 分鐘內）、`proxy` 未執行時啟動 → 備份並驗證 → 以 `<digest>` 的映像執行 Migration_Runner → 在同一 Compose 專案執行 `/app/tools/create-smoke-account.js`。它不啟動或停止 `app-blue`／`app-green`，也不改 `upstream.caddy`。

以下指令都在 `192.168.1.121` 上以維運者的帳號執行。佔位符：

- `<digest>`：`sha256:<hex>`，`main` 建置的 Image_Digest。`lm-deploy` 也接受 `<image>` 形式。
- `<image>`：`registry.our-littlemoments.com:8443/little-moments@<digest>`（`Jenkinsfile` 的 `LM_IMAGE_REPO` 加上 digest）。
- `<admin-name>`、`<display-name>`：第一個管理員的帳號名稱與顯示名稱。

`S` 是 Jenkins 的秘密目錄 `<controller-dir>/secrets/little-moments/release`（本主機的 `<controller-dir>` 為 `~/docker/jenkins`），後續步驟沿用。先執行 `sudo -v` 快取 sudo 認證，避免管線兩端的 sudo 同時詢問密碼：

```sh
S=~/docker/jenkins/secrets/little-moments/release
sudo -v
```

### 前置條件

1. 第 1、2 節的 `install.sh` 已完成，`/srv/lm/<env>/<env>.env` 已填入（Production 見第 3 節）。
2. `/srv/lm/<env>/db.env`（0600 root）已依 `compose/db.env.example` 建立：`POSTGRES_USER` 與 `POSTGRES_PASSWORD` 與 Credential_Store 的 `lm-<env>-db` 相同，`POSTGRES_DB` 為 `Jenkinsfile` 的 `LM_STAGING_DB_NAME`（`little_moments_staging`）或 `LM_PROD_DB_NAME`（`little_moments`）。`db.env` 只在資料卷第一次初始化時生效。
3. `lm-<env>-db`、`lm-<env>-setup-token` 與 `lm-<env>-smoke` 的秘密檔已填入實際值，Staging 與 Production 各不相同。smoke 密碼為一行、12–128 個字元。
4. Deploy_Host 的 Docker 可以從 Registry 拉取 App_Image（`lm-deploy deploy` 與 `smoke-account` 都會拉取）。
5. 使用的 Image_Digest 由包含 Smoke_Provisioner（`scripts/create-smoke-account.mjs`，映像中的 `/app/tools/create-smoke-account.js`）的 commit 建置。較舊的映像沒有此檔案，`smoke-account` 會在最後一步以 `smoke_account_failed` 結束，`tool` 為 `null`。
6. `/srv/lm/<env>/app.env` 存在。`smoke-account` 在它不存在時以結束碼 2（`config_missing`）拒絕。Pipeline 的 `lm-deploy <env> deploy <digest> --app-env-stdin` 依序為：驗證 stdin 的 app.env 內容 → 備份 → 寫入 `app.env` → Migration_Runner → 啟動 → 健康檢查 → 切換；備份失敗時不會寫入 `app.env`。全新主機的第一次部署正是在備份失敗（見下方 Staging 步驟 1），所以由維運者以同一組 Credential_Store 值先寫入。`lm-deploy <env> app-env` 驗證鍵名後以 0600 root 原子寫入，不輸出任何值；值只經 root shell 的內建 `printf` 與管線傳遞，不出現在任何程序的指令列。之後每次 Pipeline 部署都以相同來源覆寫此檔：

   ```sh
   E=staging DB=little_moments_staging        # Production：E=prod DB=little_moments
   sudo sh -c 'printf "%s=%s\n" \
       CAMPING_DATABASE_NAME "$3" \
       CAMPING_DATABASE_USER "$(cat "$1/lm-$2-db.username")" \
       CAMPING_DATABASE_PASSWORD "$(cat "$1/lm-$2-db.password")" \
       CAMPING_SETUP_TOKEN "$(cat "$1/lm-$2-setup-token")"' sh "$S" "$E" "$DB" \
     | sudo /opt/lm/bin/lm-deploy "$E" app-env
   ```

   預期輸出 `{"ok":true,"command":"app-env","env":"staging","keys":["CAMPING_DATABASE_NAME","CAMPING_DATABASE_USER","CAMPING_DATABASE_PASSWORD","CAMPING_SETUP_TOKEN"]}`。任一秘密檔不存在或為空時，對應的值為空，`app-env` 以結束碼 2（`app_env_invalid`）拒絕且不變更既有檔案。

### Staging

1. 包含 Smoke_Provisioner 的變更合併至 `main` 後，Jenkins `release/little-moments » main` 的第一次建置會推送並簽章 App_Image，然後在「Staging Deploy」失敗。失敗的位置取決於 `db` 是否已在執行：
   - 全新主機（一般情況）：沒有任何指令事先啟動 `db`，`lm-deploy staging deploy` 的備份（`compose exec -T db pg_dump`）失敗，`reason` 為 `backup_create_failed`（建置訊息「備份建立失敗」）。沒有套用遷移、沒有啟動 App，也沒有寫入 `app.env`。
   - 維運者事先啟動過 `db` 且 `app.env` 已存在：部署會完成切換，但 Smoke_Test 在登入時失敗（smoke-bot 不存在），Pipeline 停止新版容器（沒有先前已通過 Staging 驗證的版本）。

   兩種情況結束後 `sudo /opt/lm/bin/lm-deploy staging status` 都顯示 `"phase":"idle"`，可以執行 `smoke-account`。自該建置取得 Image_Digest：建置頁 Build Artifacts 中的 `reports/image-digest.txt`（內容為一行 `sha256:<hex>`），或 Console Output 中「App_Image 已推送：」那一行 `@` 之後的部分。以下以 `<digest>` 表示。
2. 若 `/srv/lm/staging/app.env` 不存在（`sudo test -f /srv/lm/staging/app.env || echo missing` 輸出 `missing`），依前置條件 6 以 `E=staging DB=little_moments_staging` 寫入。
3. 第一次執行 `smoke-account`：

   ```sh
   sudo cat "$S/lm-staging-smoke" | sudo /opt/lm/bin/lm-deploy staging smoke-account <digest>
   ```

   預期 stdout 依序為 `services`（`"db":"started","proxy":"started"`）、`backup`（`"emptyDatabase":true`）、`migrate` 三行成功，最後一行為 `{"ok":false,"command":"smoke-account",…,"reason":"smoke_account_failed","message":"Smoke_Provisioner 未完成（no_admin）",…,"tool":{"ok":false,"reason":"no_admin"}}`，結束碼 1。這是預期結果：Database 與 LM_Proxy 已啟動、schema 已建立，但還沒有管理員，所以沒有建立任何帳號或行程。
4. 以 README 的 compose 指令執行 `create-admin`，建立 Staging 的第一個管理員（[帳號維運指令](../README.md#帳號維運指令create-admin-與-reset-password)）。加 `-T` 時沒有終端機，`--username` 與 `--display-name` 必須指定，密碼由 stdin 提供。下列寫法以隱藏輸入讀入密碼，密碼只經 shell 內建的 `printf` 與管線傳遞：

   ```sh
   read -rsp '管理員密碼（12–128 字元）：' P; echo
   printf '%s\n' "$P" | sudo env LM_ENV=staging APP_IMAGE_BLUE=<image> APP_IMAGE_GREEN=<image> APP_IMAGE_NEW=<image> \
     docker compose --project-directory /srv/lm/staging -f /srv/lm/staging/compose.yaml --env-file /srv/lm/staging/staging.env \
     --profile ops run --rm --no-deps -T --entrypoint bun migrate /app/tools/create-admin.js \
     --username <admin-name> --display-name <display-name>
   unset P
   ```

   也可以不加 `-T`、不加管線與兩個選項，改在終端機回答提示（密碼輸入兩次）。管理員密碼由維運者自行保管，不放進 Credential_Store。Database 已有管理員（例如曾經以 `/setup` 建立）時略過此步驟；`create-admin` 在已有任何帳號時拒絕執行。
5. 再次執行同一個 `smoke-account` 指令：

   ```sh
   sudo cat "$S/lm-staging-smoke" | sudo /opt/lm/bin/lm-deploy staging smoke-account <digest>
   ```

   預期 `services` 為 `"db":"running","proxy":"running"`，最後一行為 `{"ok":true,"command":"smoke-account","env":"staging","digest":"<digest>","tool":{"ok":true,"username":"smoke-bot","account":"created","fixture":"smoke-fixture","fixtureStatus":"created"}}`，結束碼 0。之後再執行時兩者皆為 `kept`，不寫入任何資料列。
6. 觸發一次新的 `main` 建置：合併下一個 PR 至 `main`（`main` 需要 PR 與審查；沒有待合併的變更時，可以用只含一個空 commit 的 PR）。**不要**對同一個 commit 在 `release/little-moments » main` 按 Build Now：該 commit 的 `<LM_IMAGE_REPO>:<完整 SHA>` 標籤已由第一次建置推送，「Image Push」階段會拒絕覆寫而失敗，不會進入 Staging。新建置的 Staging 部署應通過（備份 → `app.env` → Migration_Runner → 切換 → Smoke_Test），並記錄 staging-verified attestation（「Staging」關卡通過）。此建置的 `reports/image-digest.txt` 是 Production 要使用的已通過 Staging 驗證的 Image_Digest，以下以 `<verified-digest>` 表示，`<verified-image>` 為 `registry.our-littlemoments.com:8443/little-moments@<verified-digest>`。

### Production

在推送第一個 Release_Tag **之前**，以 `prod`、`lm-prod-smoke` 與 `<verified-digest>` 依相同順序執行：

1. Production 的第一次部署由 Release_Tag 建置執行，在此之前 `/srv/lm/prod/app.env` 不存在。依前置條件 6 以 `E=prod DB=little_moments` 寫入。
2. 第一次 `smoke-account`，預期與 Staging 相同以 `no_admin` 結束（結束碼 1）：

   ```sh
   sudo cat "$S/lm-prod-smoke" | sudo /opt/lm/bin/lm-deploy prod smoke-account <verified-digest>
   ```

3. 建立 Production 的第一個管理員：

   ```sh
   read -rsp '管理員密碼（12–128 字元）：' P; echo
   printf '%s\n' "$P" | sudo env LM_ENV=prod APP_IMAGE_BLUE=<verified-image> APP_IMAGE_GREEN=<verified-image> APP_IMAGE_NEW=<verified-image> \
     docker compose --project-directory /srv/lm/prod -f /srv/lm/prod/compose.yaml --env-file /srv/lm/prod/prod.env \
     --profile ops run --rm --no-deps -T --entrypoint bun migrate /app/tools/create-admin.js \
     --username <admin-name> --display-name <display-name>
   unset P
   ```

4. 再次執行 `smoke-account`，預期 `"account":"created","fixtureStatus":"created"`、結束碼 0：

   ```sh
   sudo cat "$S/lm-prod-smoke" | sudo /opt/lm/bin/lm-deploy prod smoke-account <verified-digest>
   ```

5. 之後才推送 Release_Tag：Release_Approver 在 `<verified-digest>` 所屬的 commit（Staging 步驟 6 的 commit）建立 annotated tag（`git tag -a vX.Y.Z <commit>`）並推送，Release_Tag 建置通過「映像」與「Staging」關卡後核准。Production 部署依序為備份 → 寫入 `app.env` → Migration_Runner → 啟動 → 切換，觀察期的 Smoke_Test 應通過。完成後依第 8 節設定 `LM_EDGE_TRUSTED_PROXIES`。

### `smoke-account` 的結束碼

| 結束碼 | `reason` | 處理方式 |
|---|---|---|
| 0 | — | 完成。最後一行的 `tool` 為 Smoke_Provisioner 輸出的 JSON |
| 1 | `db_start_failed`、`proxy_start_failed`、`backup_create_failed`、`backup_verify_failed`、`backup_timeout`、`migrate_failed`、`smoke_account_failed` | 該步驟失敗，後續步驟未執行。`smoke_account_failed` 的 `message` 括號內是 Smoke_Provisioner 的 `reason`：`no_admin`（先執行 `create-admin`）、`account_is_admin`、`account_disabled`（該帳號名稱已被管理員或已停用的帳號使用，不會修改）、`password_invalid`（密碼不是一行 12–128 個字元）、`database` |
| 2 | `usage`、`operator_only`、`password_stdin_required`、`password_invalid`、`config_missing`、`config_invalid` | 參數、stdin（沒有內容、超過 4096 位元組、含 NUL 或是終端機）或設定錯誤；未執行任何 Docker 指令。`operator_only` 表示經 SSH forced command、不是 root，或由部署帳號執行 |
| 3 | `invalid_phase`、`state_invalid` | 有未完成的部署；等 Pipeline 結束，或以 `finalize`／`rollback` 處理後再執行 |
| 4 | `deploy_in_progress` | 部署鎖被持有（Pipeline 正在部署這個環境）；稍後再執行 |

`--username <name>` 與 `--fixture <title>` 可以覆寫預設的 `smoke-bot` 與 `smoke-fixture`，但 Pipeline 的 Smoke_Test 固定使用預設值，Staging 與 Production 不要指定。

### Setup_Token、smoke-bot 密碼與 smoke-fixture

- Setup_Token：Pipeline 每次部署仍把 `lm-<env>-setup-token` 寫入 `app.env`，但依本節建立管理員後 `needsSetup` 為 `false`，`/setup` 不再使用。它只在 Database 沒有任何帳號時（本節步驟之前，或還原成空 Database 後）作為 `create-admin` 以外的後備。
- Production 的 smoke-bot 是真實的 member 帳號，知道密碼的人都能以它登入 `https://www.our-littlemoments.com`。密碼只保存在 Credential_Store 的 `lm-prod-smoke`（Staging 為 `lm-staging-smoke`），不要另外記錄或分享。`smoke-account` 不會變更既有帳號的密碼。要更換時，不要在 Pipeline 部署期間進行，以 `reset-password` 設定新密碼並同步更新秘密檔（`<image>` 用 `sudo /opt/lm/bin/lm-deploy <env> status` 中 `active` 的 digest）：

  ```sh
  read -rsp '新的 smoke-bot 密碼（12–128 字元）：' P; echo
  printf '%s\n' "$P" | sudo env LM_ENV=<env> APP_IMAGE_BLUE=<image> APP_IMAGE_GREEN=<image> APP_IMAGE_NEW=<image> \
    docker compose --project-directory /srv/lm/<env> -f /srv/lm/<env>/compose.yaml --env-file /srv/lm/<env>/<env>.env \
    --profile ops run --rm --no-deps -T --entrypoint bun migrate /app/tools/reset-password.js smoke-bot
  printf '%s\n' "$P" | sudo install -o 1000 -g 1000 -m 600 /dev/stdin "$S/lm-<env>-smoke"
  unset P
  ```

  之後在 Jenkins 執行「Reload existing configuration」（見 [`../ci/jenkins/README.md`](../ci/jenkins/README.md)）。`reset-password` 會登出 smoke-bot 的所有 session。兩者更新完成之前的 Smoke_Test 會失敗。
- Smoke_Fixture：`smoke-fixture` 行程由 smoke-bot 擁有，只有 smoke-bot 與管理員看得到（管理員的行程清單列出全部行程，所以 Production 的管理員也會看到它）。不要改名、刪除或邀請其他人加入。刪除或改名後下一次 Smoke_Test 會失敗；以同一個 `smoke-account` 指令重建（既有帳號保留，只建立缺少的行程）。

## Production 收據 AI（OpenAI）

Release_Approver `jacklin` 決定只在 Production 啟用雲端 AI 收據辨識（Requirement 15.6–15.8；design.md Components §25）。Staging、Test_Environment、還原演練與 `ci/` 的建置維持停用。

| 環境 | `Jenkinsfile` 的開關 | 金鑰來源 | Deploy_Host 上的金鑰檔 | App 的 `CAMPING_OPENAI_API_KEY_FILE` |
|---|---|---|---|---|
| Staging | `LM_STAGING_RECEIPT_AI = 'disabled'`（只能是 `disabled`） | 無；`lm-deploy staging` 以 `receipt_ai_forbidden` 拒絕任何金鑰 | 不存在；存在時 `lm-deploy staging` 以 `config_invalid` 拒絕 | 空字串（停用） |
| Production | `LM_PROD_RECEIPT_AI = 'enabled'` | `release/` 的 Secret file `lm-prod-openai-api-key` | `/srv/lm/prod/secrets/openai-api-key`（`10001:10001`、`0400`；`secrets/` 為 root `0700`） | 金鑰檔存在時為 `/run/secrets/openai-api-key`，否則為空字串 |

Production Deploy 只在 `lm-deploy prod deploy` 那一次 SSH 呼叫綁定 `lm-prod-openai-api-key`。stdin 第一行為 `LM_RECEIPT_AI=enabled`，最後一行為 `LM_OPENAI_API_KEY=<金鑰>`。`lm-deploy` 在備份與任何 docker 指令之前驗證金鑰格式（`sk-` 後接 20–500 個英文字母、數字、`_` 或 `-`），備份後寫入金鑰檔，再啟動新槽位。`app-blue`／`app-green` 以唯讀 bind mount 把金鑰檔掛載到 `/run/secrets/openai-api-key`，App 啟動時讀取一次。金鑰不出現在主控台、Build_Record、`lm-deploy` 的輸出或任何指令列。

金鑰檔由 `lm-deploy` 管理，不要手動修改、改權限或刪除。擁有者或權限不符時，`lm-deploy prod` 所有使用 Compose 的子命令（`deploy`、`rollback`、`finalize`、`health`、`smoke-account` 等）都以 `config_invalid` 拒絕。

### 第一次啟用

順序重要：第 1 步必須在第 3 步之前，第 2 步必須在第 4 步之前。Jenkins controller 與 Deploy_Host 都是 `192.168.1.121`，以下指令都在這台主機上以維運者的帳號執行。

1. **放入秘密檔（Jenkins controller）**。在 `<controller-dir>`（本主機為 `~/docker/jenkins`）以 [`ci/jenkins/README.md`](../ci/jenkins/README.md#秘密目錄) 的 `put` 函式寫入。金鑰以隱藏輸入讀入，再經 `install -o 1000 -g 1000 -m 600 /dev/stdin` 寫入，不出現在終端機、shell 歷史或程序列表。不要以 `echo`、`cat` 或編輯器處理金鑰：

   ```sh
   cd ~/docker/jenkins
   put() { read -rsp "$1: " S; echo; printf '%s\n' "$S" | sudo install -o 1000 -g 1000 -m 600 /dev/stdin "secrets/$1"; unset S; }
   put little-moments/release/lm-prod-openai-api-key
   ```

   在提示後貼上 OpenAI 後台建立的金鑰並按 Enter。`put` 結束時執行 `unset S`，也會清除[首次部署與 smoke-bot](#首次部署與-smoke-bot) 一節設定的 `S`，之後要用該變數時重新設定。

   金鑰已經以其他檔名放在 `secrets/` 下時，不要顯示內容，以相同的擁有者與權限把它搬到這個路徑，再刪除原檔（`<現有檔名>` 為該檔在 `secrets/` 下的名稱）：

   ```sh
   cd ~/docker/jenkins
   sudo install -o 1000 -g 1000 -m 600 secrets/<現有檔名> secrets/little-moments/release/lm-prod-openai-api-key
   sudo shred -u secrets/<現有檔名>
   ```

   確認擁有者、權限與格式。以下指令只輸出計數，不輸出內容：

   ```sh
   f=secrets/little-moments/release/lm-prod-openai-api-key
   sudo stat -c '%u:%g %a' "$f"                       # 1000:1000 600
   sudo grep -cxE 'sk-[A-Za-z0-9_-]{20,500}' "$f"     # 1
   sudo grep -cvxE 'sk-[A-Za-z0-9_-]{20,500}' "$f"    # 0
   ```

   第二個指令不是 `1`，或第三個不是 `0`（例如含空白、CR 或多行）時，以 `put` 重新寫入。格式不符的金鑰會讓 Production Deploy 在備份前以 `app_env_invalid` 失敗。

2. **在 Deploy_Host 重新執行 `install.sh`**。把 Deploy_Host 的 repository checkout 更新到包含本變更的 commit，以第 2 節的參數重新執行 `deploy/host/install.sh`，安裝新的 `lm-deploy` 與 `compose.yaml`（只更新檔案時可省略 `--agent-from`、`--staging-key`、`--prod-key`）：

   ```sh
   LAN=192.168.1.0/24,172.17.0.0/16,172.20.0.0/16,172.21.0.0/16,172.22.0.0/16
   sudo deploy/host/install.sh --lan-cidr "$LAN" --public-port 80,443
   sudo cmp deploy/bin/lm-deploy /opt/lm/bin/lm-deploy && echo lm-deploy-ok
   sudo cmp deploy/compose/compose.yaml /srv/lm/staging/compose.yaml && sudo cmp deploy/compose/compose.yaml /srv/lm/prod/compose.yaml && echo compose-ok
   sudo /opt/lm/bin/lm-deploy staging status >/dev/null && sudo /opt/lm/bin/lm-deploy prod status >/dev/null && echo status-ok
   ```

   預期輸出 `lm-deploy-ok`、`compose-ok` 與 `status-ok`。這一步必須在第 4 步之前：舊版 `lm-deploy` 會以「不允許的鍵：LM_RECEIPT_AI」拒絕新 Pipeline 的 Staging 部署（在備份前拒絕，Staging 不變）。新版 `lm-deploy` 也接受舊版 Pipeline 的部署（stdin 沒有 `LM_RECEIPT_AI` 時金鑰檔不變），所以可以先安裝。`status` 以結束碼 2（`config_invalid`）結束且訊息指出 `CAMPING_OPENAI_*` 或 `LM_OPENAI_KEY_SOURCE` 時，把 `/srv/lm/<env>/<env>.env` 中該行的值清空：這些值只由 `lm-deploy` 決定。

3. **載入新的 `jobs.groovy`（Jenkins controller）**。依 [`ci/jenkins/README.md`](../ci/jenkins/README.md#設定載入與更新) 的步驟 1 把三個檔案複製到 `casc/`，再依[以假秘密測試設定變更](../ci/jenkins/README.md#以假秘密測試設定變更)測試。假秘密目錄依正式秘密目錄的檔名產生，所以會包含第 1 步的檔案。測試通過後才對正式 controller 執行「Manage Jenkins → Configuration as Code → Reload existing configuration」，並確認 `release/` 資料夾的 Credentials 有 `lm-prod-openai-api-key`（Secret file；`release/` 共 18 個憑證）。秘密檔缺少或為空時 seed 失敗，不建立或更新任何 Job；先完成第 1 步再重新載入。

4. **合併到 `main`**。合併包含本變更的 PR 後，`release/little-moments » main` 的 Staging Deploy 送出 `LM_RECEIPT_AI=disabled`，Staging 維持停用。確認該建置的 Build_Record（Build Artifacts 的 `reports/build-record.json`）中，`deployments[]` 的 Staging 項目（`"env":"staging"`）為 `"receiptAi":"disabled"`。Staging Deploy 以 `app_env_invalid`「不允許的鍵：LM_RECEIPT_AI」被拒絕時，表示第 2 步尚未完成。

5. **管理員先限制使用者**。Production 對網際網路公開。第一次部署前，管理員在 `https://www.our-littlemoments.com/admin` 把收據 AI 政策設為 `admins`（只有管理員可用）。政策存在 Database，部署後仍然有效。

6. **以新的 Release_Tag 部署 Production**。依一般流程在已通過 Staging 驗證的 commit 建立並推送 Release_Tag，再核准部署。Production Deploy 傳送金鑰，`lm-deploy` 在備份後寫入金鑰檔，新槽位啟用收據 AI。部署完成後確認：
   - 建置摘要有一行 `收據 AI（Production）：enabled`。
   - Build_Record 中 `deployments[]` 的 Production 項目（`"env":"production"`）為 `"receiptAi":"enabled"`。
   - Deploy_Host 上依[主機上的確認](#主機上的確認)檢查。
   - 以管理員帳號開啟一個可編輯的行程，「分帳記帳」可以選擇收據照片辨識；或以同一帳號 `GET /api/trips/<trip-id>/receipt-ai`，回應 `"enabled":true`。這只檢查金鑰與模型的格式，不呼叫 OpenAI；Smoke_Test 也不呼叫 OpenAI。

   確認可用後，管理員視需要在 `/admin` 改為 `all`。用量上限沿用預設：每位使用者 15 分鐘 10 次、每 UTC 日 100 次、每 UTC 月 1000 次。另建議在 OpenAI 後台為該專案設定每月預算。

   部署失敗時：

   | 結果 | 原因 | 處理 |
   |---|---|---|
   | 主控台顯示 `lm-prod-openai-api-key 的金鑰檔不存在或為空，未連線 Deploy_Host` | 秘密檔為空 | 依第 1 步重新寫入，再 Reload existing configuration |
   | `lm-deploy` 的 `reason` 為 `app_env_invalid`（`LM_OPENAI_API_KEY 格式無效`） | 秘密檔不是一行 `sk-` 開頭的金鑰 | 同上；在備份前拒絕，Production 不變 |
   | 摘要為 `收據 AI（Production）：未執行` | 部署在寫入 `app.env` 之前就失敗（例如備份失敗） | 依建置訊息處理部署失敗 |

### 輪替

1. 在 OpenAI 後台建立新金鑰。舊金鑰先不要撤銷。
2. 在 controller 主機以第一次啟用第 1 步的 `put little-moments/release/lm-prod-openai-api-key` 覆寫秘密檔，並以同一組 `stat`、`grep -c` 指令確認。秘密目錄的結構沒有改變，不需要以假秘密測試。
3. 執行 Reload existing configuration。不要在 Release_Tag 建置進行中更換：封存報告前的遮罩會重新取得憑證，取得的是新值，遮不到該建置使用的舊值。
4. 以下一個 Release_Tag 部署 Production。`lm-deploy` 寫入新金鑰，新槽位使用新金鑰。作用中的舊槽位在移除前仍使用舊金鑰，因為單檔 bind mount 停留在建立容器時的檔案。
5. 觀察期結束、finalize 移除舊槽位後，在 OpenAI 後台撤銷舊金鑰。

### 金鑰外洩

1. 先在 OpenAI 後台撤銷外洩的金鑰。之後 App 對辨識請求回應 502，其他功能不受影響。
2. 管理員在 `/admin` 把收據 AI 政策設為 `off`。辨識請求改為回應「AI 辨識已由管理員關閉」，不再送到 OpenAI。
3. 依「輪替」第 1–4 步換上新金鑰。舊金鑰已在本節第 1 步撤銷。
4. 新的 Production 部署完成並確認可用後，管理員把政策改回 `admins` 或 `all`。

### 停用

- **立即停用**：管理員在 `/admin` 把收據 AI 政策設為 `off`。下一個請求即生效，不需部署；Pipeline 與主機上的金鑰檔維持原狀。改回 `admins` 或 `all` 即恢復。
- **停止提供金鑰**：以 PR 把 `Jenkinsfile` 的 `LM_PROD_RECEIPT_AI` 改為 `'disabled'`，合併後以下一個 Release_Tag 部署 Production。Production Deploy 不再綁定 `lm-prod-openai-api-key`，改送出 `LM_RECEIPT_AI=disabled`。`lm-deploy` 在備份後刪除 `/srv/lm/prod/secrets/openai-api-key`，新槽位的 `CAMPING_OPENAI_API_KEY_FILE` 為空字串，Build_Record 的 Production 項目為 `"receiptAi":"disabled"`。舊槽位在 finalize 移除前仍讀得到舊金鑰；移除後在 OpenAI 後台撤銷該金鑰。
- 停止提供金鑰後，憑證可以留在 `release/`。要移除時，依 [`ci/jenkins/README.md`](../ci/jenkins/README.md) 的規則同時修改 `jobs.groovy`、Pipeline 與憑證表並重新載入，之後才刪除秘密檔。順序相反時 seed 會失敗。

### 主機上的確認

在 Deploy_Host 執行。以下指令只輸出擁有者、權限、路徑與狀態，不輸出金鑰：

```sh
sudo stat -c '%n %u:%g %a' /srv/lm/prod/secrets /srv/lm/prod/secrets/openai-api-key
sudo test -e /srv/lm/staging/secrets/openai-api-key && echo staging-key-present || echo staging-key-absent
```

啟用時預期 `/srv/lm/prod/secrets 0:0 700`、`/srv/lm/prod/secrets/openai-api-key 10001:10001 400` 與 `staging-key-absent`。以 `LM_PROD_RECEIPT_AI = 'disabled'` 部署之後，第一個指令對金鑰檔回報 `No such file or directory`。

作用中槽位的掛載與環境變數（`<color>` 為 `sudo /opt/lm/bin/lm-deploy prod status` 輸出中 `active` 的 `color`）：

```sh
sudo docker inspect -f '{{range .Mounts}}{{if eq .Destination "/run/secrets/openai-api-key"}}{{.Source}} rw={{.RW}}{{end}}{{end}}' lm-prod-app-<color>-1
sudo docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' lm-prod-app-<color>-1 | grep ^CAMPING_OPENAI_API_KEY_FILE=
```

啟用時預期 `/srv/lm/prod/secrets/openai-api-key rw=false` 與 `CAMPING_OPENAI_API_KEY_FILE=/run/secrets/openai-api-key`；停用時來源為 `/dev/null`，環境變數為 `CAMPING_OPENAI_API_KEY_FILE=`。Staging 的槽位（`lm-staging-app-<color>-1`）一律是停用時的結果。
