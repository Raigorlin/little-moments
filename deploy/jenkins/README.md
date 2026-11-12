# Jenkins controller 與 Build_Agent 安裝（`deploy/jenkins/`）

本目錄是 Jenkins controller、Trusted Agent `lm-trusted-1` 與 Untrusted Agent `lm-untrusted-1` 的容器設定（Requirement 2.1、2.4–2.6）。三者在同一台主機上執行，前面是同一台主機上的 Nginx Proxy Manager（NPM）。Jenkins 本身的設定（Configuration as Code、Job DSL、憑證與授權）見 [`ci/jenkins/README.md`](../../ci/jenkins/README.md)；LAN Registry 見 [`deploy/registry/README.md`](../registry/README.md)。

本文件中所有 `<...>` 都是佔位符：

| 佔位符 | 意義 |
|---|---|
| `<lan-ip>` | 主機的 LAN IP（controller 的 8080、Registry 的 8443） |
| `<repo>` | 主機上的 repository checkout |
| `<controller-dir>` | `<repo>/deploy/jenkins/controller` |
| `<trusted-agent-dir>` | Trusted Agent 的目錄（由 root 管理，例如 `/opt/lm-jenkins-agent`） |
| `<uid>` | `lm-untrusted` 的 uid（`id -u lm-untrusted`） |

| 檔案 | 內容 |
|---|---|
| `controller/Dockerfile` | `jenkins/jenkins:lts-jdk21`、關閉 setup wizard、安裝 `plugins.txt` 並確認 `configuration-as-code` 與 `job-dsl` 已下載 |
| `controller/plugins.txt` | 必要 plugins（與 `ci/jenkins/README.md` 的表相同） |
| `controller/compose.yaml` | 專案 `lm-jenkins`：只綁定 `${LM_JENKINS_LAN_IP}:8080`、唯讀掛載 `./casc` 與 `./secrets`、網路 `default` 與外部 `proxy` |
| `controller/.env.example` | `LM_JENKINS_LAN_IP` |
| `controller/.dockerignore` | build context 只允許 `plugins.txt` |
| `controller/.gitignore` | 排除 `secrets/`、`secrets-dummy/`、`casc/`、`.env` |
| `agent/Dockerfile` | 兩個 agent 共用：`jenkins/inbound-agent:latest-jdk21` 加上 docker CLI 與 cli-plugins |
| `agent/trusted.compose.yaml` | `lm-trusted-1`：主機的 docker.sock、主機 docker 群組、工作目錄 `/var/lib/jenkins-agent` |
| `agent/untrusted.compose.yaml` | `lm-untrusted-1`：只掛載 `lm-untrusted` 的 rootless Docker socket、工作目錄 `/var/lib/jenkins-untrusted` |
| `agent/.env.example` | `LM_JENKINS_URL`、`DOCKER_GID`（trusted）、`SOCK`、`SOCK_GID`（untrusted） |
| `agent/.dockerignore` | build context 不含任何檔案 |
| `agent/.gitignore` | 排除 `*.secret` 與 `.env` |
| `agent/untrusted/lm-untrusted-fw` | `lm-untrusted` 與其 subuid 範圍的對外連線規則（iptables／ip6tables） |
| `agent/untrusted/lm-untrusted-fw.default.example` | `/etc/default/lm-untrusted-fw` 的範本（`LM_JENKINS_HOST_IP`） |
| `agent/untrusted/lm-untrusted-fw.service.in` | 開機時在 `lm-untrusted` 的 user manager 之前套用防火牆的 systemd unit 範本 |
| `agent/untrusted/docker-rootless-override.conf` | rootless Docker 的 override：關閉 detach-netns、使用 slirp4netns |

## Controller

### 前置條件

- Docker Engine 與 Compose plugin（`docker compose version`；以假秘密測試設定時需要 2.24 以上）。
- NPM 已在主機上執行，且與 controller 共用名為 `proxy` 的 Docker 網路：`docker network inspect proxy --format '{{.Name}}'` 輸出 `proxy`。尚未建立時執行 `docker network create proxy`，並在 NPM 的 compose 中把它宣告為 external 網路後重新建立 NPM 容器。
- 主機上有 repository checkout（`<repo>`）。

### 安裝

1. 在 `<controller-dir>` 建立 `.env`（不提交），把 `LM_JENKINS_LAN_IP` 設為 `<lan-ip>`：

   ```sh
   cd <controller-dir>
   cp .env.example .env
   ```

2. 把 Configuration as Code 檔案複製到 `casc/`：

   ```sh
   install -d -m 755 casc
   install -m 644 ../../../ci/jenkins/casc.yaml ../../../ci/jenkins/local-security.yaml ../../../ci/jenkins/jobs.groovy casc/
   ```

3. 建立秘密目錄 `secrets/`：最上層的 `JENKINS_ADMIN_PASSWORD`、`RETENTION_BOT_PASSWORD`、`API_READONLY_PASSWORD`、`GITHUB_WEBHOOK_SECRET`，以及 `little-moments/{ci,release,infra}/` 下各憑證的秘密檔。擁有者 `1000:1000`，目錄 `700`、檔案 `600`。檔名、寫入方式與 GitHub App 私鑰的轉換見 `ci/jenkins/README.md` 的「秘密目錄」。
4. 建置並啟動：

   ```sh
   docker compose build --no-cache --pull
   docker compose up -d
   ```

5. 觀察啟動日誌。這個過濾只列出載入 Job DSL、錯誤與啟動完成的行，不會印出任何值：

   ```sh
   docker compose logs -f --since 1m jenkins 2>&1 | grep --line-buffered -E 'Processing provided DSL|SEVERE|fully up and running'
   ```

   預期看到 `Processing provided DSL script` 與 `Jenkins is fully up and running`，沒有 `SEVERE`。
6. 確認：

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' http://<lan-ip>:8080/     # 403：未登入時沒有任何讀取權限
   docker compose exec jenkins ls /var/jenkins_home/jobs              # ci  infra  release
   ```

7. 在 NPM 建立 `jenkins.our-littlemoments.com` 的 Proxy Host，設定見 `ci/jenkins/README.md` 的「Webhook 驗證與拒絕日誌」。

之後更新設定：重新複製 `casc/` 的三個檔案，再執行「Manage Jenkins → Configuration as Code → Reload existing configuration」。升級 Jenkins 或 plugin：重新執行步驟 4，再重複步驟 5、6。

### 設計理由

- **專案名稱 `lm-jenkins`**：主機上已有另一個名為 `jenkins` 的 compose 專案。專案名稱相同時，compose 會把兩者的容器、網路與卷視為同一個專案，互相覆蓋或當成孤兒移除。
- **`lts-jdk21`**：jdk17 的 tag 停在一個已公布漏洞的 LTS 版本。基底刻意不以 digest 固定，以 `--pull` 重建即取得 LTS 的安全更新；代價是兩次建置的映像不保證相同，升級後須確認 plugin 相容。
- **`COPY --chown` 與 plugin 檢查**：主機上的 `plugins.txt` 可能是 `600`。沒有 `--chown` 時 jenkins 使用者讀不到它，plugin 安裝程式印出「Unable to open …plugins.txt」後仍成功結束，產生沒有任何 plugin 的映像。這樣的 Jenkins 沒有 Configuration as Code，因此沒有套用任何安全設定。Dockerfile 在安裝後確認 `configuration-as-code` 與 `job-dsl` 確實存在，否則建置失敗。
- **只綁定 LAN IP**：8080 只綁定 `${LM_JENKINS_LAN_IP}`，絕不綁定 `0.0.0.0`；不發布 50000（兩個 agent 都以 WebSocket 連線）。網際網路只經 NPM 到達 `/github-webhook/`，路由器只轉送 80／443。

## Trusted Agent（`lm-trusted-1`）

`lm-trusted-1` 只執行 `release/` 與 `infra/` 的建置（`casc.yaml` 的 Job Restriction `^(release|infra)/.*`），也就是已推送到 repository 的程式碼。它掛載主機的 `/var/run/docker.sock`，等同主機 root 權限。

以下以 root 執行（`sudo -i`）：

1. 建立目錄並複製檔案：

   ```sh
   install -d -m 750 <trusted-agent-dir>
   install -m 644 <repo>/deploy/jenkins/agent/Dockerfile <repo>/deploy/jenkins/agent/.dockerignore <repo>/deploy/jenkins/agent/trusted.compose.yaml <trusted-agent-dir>/
   cd <trusted-agent-dir>
   ```

2. 建立 `.env`（格式見 `agent/.env.example`），`DOCKER_GID` 取自 `getent group docker`：

   ```sh
   printf 'LM_JENKINS_URL=http://<lan-ip>:8080/\nDOCKER_GID=%s\n' "$(getent group docker | cut -d: -f3)" > .env
   ```

3. 建立工作目錄（容器內外路徑相同，與 `casc.yaml` 的 `remoteFS` 一致）：

   ```sh
   install -d -o 1000 -g 1000 -m 750 /var/lib/jenkins-agent
   ```

4. 取得 agent secret：「Manage Jenkins → Nodes → lm-trusted-1」頁面列出的啟動指令中，`-secret` 之後的 64 個十六進位字元。以隱藏輸入寫入，不出現在終端機或 shell 歷史：

   ```sh
   read -rsp 'lm-trusted-1 secret: ' S; echo
   ( umask 077; printf '%s\n' "$S" > lm-trusted-1.secret ); unset S
   grep -qxE '[0-9a-f]{64}' lm-trusted-1.secret && echo 'format OK' || echo 'format error'
   chown 1000:1000 lm-trusted-1.secret
   ```

5. 建置並啟動，等待日誌出現 `INFO: Connected`：

   ```sh
   docker compose -f trusted.compose.yaml up -d --build
   docker compose -f trusted.compose.yaml logs -f lm-trusted-1
   ```

agent 只在啟動時讀取 secret；更換 `lm-trusted-1.secret` 後執行 `docker compose -f trusted.compose.yaml up -d --force-recreate`。

**Handshake error**：agent 日誌出現 `Handshake error` 時，在 `<controller-dir>` 檢查 controller 的 `WebSocketAgents` 行：

```sh
docker compose logs --since 10m jenkins 2>&1 | grep WebSocketAgents
```

顯示 `incorrect secret` 時，重新複製 secret（步驟 4）。controller 的 jenkins_home 卷重新建立後，每個 node 的 secret 都會改變。

## Untrusted Agent（`lm-untrusted-1`）

`lm-untrusted-1` 執行 `ci/` 的建置，也就是 PR 的程式碼。它在非特權使用者 `lm-untrusted` 的 rootless Docker 上執行，只掛載該 rootless daemon 的 socket（`/run/user/<uid>/docker.sock`）。`lm-untrusted` 與其 subuid 範圍的對外連線由 `agent/untrusted/lm-untrusted-fw` 限制：只允許 DNS、Jenkins `<lan-ip>:8080` 與 Registry `<lan-ip>:8443`，拒絕本機其他連接埠、私有網段與所有 IPv6。

**為什麼 PR 的程式碼不能使用主機的 docker.sock**：能存取主機 docker.sock 就等同主機 root。PR 中的 `Jenkinsfile` 或測試只要執行 `docker run -v /:/host …`，就能讀取 controller 的秘密目錄（Deploy_Host 的 SSH 金鑰、cosign 私鑰、Registry 推送帳號等 `release/` 憑證），或修改 Trusted Agent 與 controller。rootless daemon 以 `lm-untrusted` 的身分執行，容器內的 root 只對應到 `lm-untrusted` 與其 subuid，讀不到其他使用者 `700`／`750` 的檔案。

以下以 root 執行（`sudo -i`），依序完成：

1. 安裝套件：

   ```sh
   apt-get install -y uidmap dbus-user-session slirp4netns docker-ce-rootless-extras
   ```

2. 建立使用者並啟用 linger（使用者未登入時 user manager 與 rootless Docker 也持續執行），確認 subuid／subgid 範圍為 65536：

   ```sh
   useradd -m -s /bin/bash lm-untrusted
   loginctl enable-linger lm-untrusted
   grep '^lm-untrusted:' /etc/subuid /etc/subgid     # 兩行皆為 lm-untrusted:<start>:65536
   ```

3. 把你自己（管理者帳號）的家目錄改為 `750`，`lm-untrusted` 與其 subuid 就無法讀取其中的 repository checkout 與其他檔案：

   ```sh
   chmod 750 <your-home>
   ```

4. 安裝防火牆、設定檔與 service。`/etc/default/lm-untrusted-fw` 的 `LM_JENKINS_HOST_IP` 設為 `<lan-ip>`：

   ```sh
   cd <repo>/deploy/jenkins/agent/untrusted
   install -m 0755 -o root -g root lm-untrusted-fw /usr/local/sbin/lm-untrusted-fw
   install -m 0644 -o root -g root lm-untrusted-fw.default.example /etc/default/lm-untrusted-fw
   editor /etc/default/lm-untrusted-fw
   sed "s/@LM_UNTRUSTED_UID@/$(id -u lm-untrusted)/g" lm-untrusted-fw.service.in > /etc/systemd/system/lm-untrusted-fw.service
   systemctl daemon-reload
   systemctl enable --now lm-untrusted-fw.service
   iptables -S OUTPUT | grep LM-UNTRUSTED       # 2 行：uid 與 subuid 範圍
   ```

   service 以 `RequiredBy=user@<uid>.service` 讓 `lm-untrusted` 的 user manager 依賴它：防火牆套用失敗時，user manager 與 rootless Docker 都不會啟動。之後只需重新套用規則時直接執行 `/usr/local/sbin/lm-untrusted-fw`（`systemctl restart lm-untrusted-fw` 會連帶重新啟動 user manager）。

5. 設定 rootless Docker（`--force`：主機上已有 rootful Docker），再安裝 override 並重新啟動：

   ```sh
   uid=$(id -u lm-untrusted)
   sudo -u lm-untrusted -H env XDG_RUNTIME_DIR=/run/user/$uid DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus dockerd-rootless-setuptool.sh install --force

   ru() { sudo -u lm-untrusted -H env XDG_RUNTIME_DIR=/run/user/$uid DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus DOCKER_HOST=unix:///run/user/$uid/docker.sock "$@"; }
   UH=$(getent passwd lm-untrusted | cut -d: -f6)
   ru mkdir -p "$UH/.config/systemd/user/docker.service.d"
   install -m 644 -o lm-untrusted -g lm-untrusted docker-rootless-override.conf "$UH/.config/systemd/user/docker.service.d/override.conf"
   ru systemctl --user daemon-reload
   ru systemctl --user restart docker
   ru docker info --format '{{.SecurityOptions}}'    # 含 name=rootless
   ```

   override 關閉 rootlesskit 的 detach-netns（Docker Engine 29.5 起的預設，會讓 `--net=host` 加入真正的主機網路）並固定使用 slirp4netns。容器的所有連線因此都由 `lm-untrusted` 擁有的 slirp4netns 發出，受防火牆規則限制。

6. 建立工作目錄。擁有者是對應到容器內 uid 1000 的 subuid（`/etc/subuid` 的起始值 + 999，群組同理）：

   ```sh
   u=$(( $(awk -F: '$1=="lm-untrusted"{print $2}' /etc/subuid) + 999 ))
   g=$(( $(awk -F: '$1=="lm-untrusted"{print $2}' /etc/subgid) + 999 ))
   install -d -o "$u" -g "$g" -m 750 /var/lib/jenkins-untrusted
   ```

7. 建立 agent 目錄並複製檔案，寫入 agent secret（「Manage Jenkins → Nodes → lm-untrusted-1」頁面 `-secret` 之後的 64 個十六進位字元），擁有者同樣是 subuid + 999：

   ```sh
   A=$UH/agent
   ru mkdir -p "$A"
   install -m 644 -o lm-untrusted -g lm-untrusted <repo>/deploy/jenkins/agent/Dockerfile <repo>/deploy/jenkins/agent/.dockerignore <repo>/deploy/jenkins/agent/untrusted.compose.yaml "$A/"
   read -rsp 'lm-untrusted-1 secret: ' S; echo
   ( umask 077; printf '%s\n' "$S" > "$A/lm-untrusted-1.secret" ); unset S
   grep -qxE '[0-9a-f]{64}' "$A/lm-untrusted-1.secret" && echo 'format OK' || echo 'format error'
   chown "$u:$g" "$A/lm-untrusted-1.secret"
   ```

8. 建立 `$A/.env`（擁有者 `lm-untrusted`，格式見 `agent/.env.example`）。rootless 下容器內看到的 socket 群組通常為 0；建置映像後在步驟 9 確認：

   ```sh
   printf 'LM_JENKINS_URL=http://<lan-ip>:8080/\nSOCK=/run/user/%s/docker.sock\nSOCK_GID=0\n' "$uid" > "$A/.env"
   chown lm-untrusted:lm-untrusted "$A/.env"
   ```

9. 以 rootless Docker 建置映像，確認 `SOCK_GID`（輸出不是 0 時修改 `.env`）：

   ```sh
   ru sh -c "cd '$A' && docker compose -f untrusted.compose.yaml build"
   ru docker run --rm --entrypoint stat -v "/run/user/$uid/docker.sock:/s" lm-untrusted-agent -c %g /s
   ```

10. 執行 `ci/jenkins/README.md`「Untrusted Agent 網路隔離（Req 2.6）」的隔離測試。**全部通過之前不要啟動 agent**：只有 `<lan-ip>:8080` 為 `OPEN`，`:22`、`:80`、`:81` 與 `<router-ip>:80` 為 `blocked`；`https://github.com` 為 200；`--net=host` 的 `hostname -I` 只有 `10.0.2.x`。
11. 啟動並等待日誌出現 `INFO: Connected`：

    ```sh
    ru sh -c "cd '$A' && docker compose -f untrusted.compose.yaml up -d"
    ru sh -c "cd '$A' && docker compose -f untrusted.compose.yaml logs -f lm-untrusted-1"
    ```

Handshake error 的處理與 Trusted Agent 相同；更換 secret 後以 `ru sh -c "cd '$A' && docker compose -f untrusted.compose.yaml up -d --force-recreate"` 重新建立容器。

## 重新開機後的確認

```sh
systemctl is-active lm-untrusted-fw              # active
iptables -S OUTPUT | grep LM-UNTRUSTED           # 2 行
ip6tables -S OUTPUT | grep LM-UNTRUSTED          # 2 行
```

再到「Manage Jenkins → Nodes」確認 `lm-trusted-1` 與 `lm-untrusted-1` 皆已重新連線（或在兩個 agent 的日誌中看到 `INFO: Connected`）。防火牆未套用時 `lm-untrusted` 的 user manager 不會啟動，`lm-untrusted-1` 會維持離線；這時先以 `journalctl -u lm-untrusted-fw` 找出原因，不要繞過防火牆啟動 agent。
