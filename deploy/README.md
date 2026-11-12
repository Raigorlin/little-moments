# Deploy_Host：經同主機 Edge_Proxy 公開 Production（runbook）

本文件說明如何讓 Production_Environment 經同一主機上的 Edge_Proxy（Nginx Proxy Manager，以下稱 NPM）與 Cloudflare 以 `https://www.our-littlemoments.com` 對網際網路公開（Requirement 8.6、8.8–8.10、24.3、25；design.md Components §18）。其他元件的安裝步驟見 [`jenkins/README.md`](jenkins/README.md)、[`registry/README.md`](registry/README.md) 與 [`../ci/jenkins/README.md`](../ci/jenkins/README.md)。

公開範圍：

- Production 只經 NPM 的 `www.our-littlemoments.com` Proxy Host 公開；apex `our-littlemoments.com` 只做 301 轉址。
- Staging、LAN Registry 與 Deploy_Host（SSH、LM_Proxy 連接埠）只允許 LAN。Staging 不建立任何 NPM 主機。
- Jenkins 只公開 `/github-webhook/`（POST），設定見 [`../ci/jenkins/README.md`](../ci/jenkins/README.md) 的「Webhook 驗證與拒絕日誌」。
- 其他對外公開方式（其他連接埠轉發、其他對外的反向代理、通道服務）不在支援範圍內。

本文件中的 `<...>` 是佔位符。Cloudflare 範圍與 Edge_Proxy 的實際來源位址只寫在主機的 `/srv/lm/prod/prod.env`，不寫入 repository。

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
