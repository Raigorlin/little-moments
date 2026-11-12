 日子拾光 · LITTLE MOMENTS

**日子拾光** is a Traditional Chinese camping and trip planner. Plan an itinerary, meals, shopping, shared gear, vehicles, and trip expenses; invite an account to collaborate; and switch to a personal departure checklist when it is time to go.

The app has two modes:

| Mode | Open | Data and availability |
| --- | --- | --- |
| Account mode | `/setup`, `/login`, or `/register` | Trips and accounts are stored in the server's PostgreSQL Database. Sign in to collaborate from other devices on the local network. Account mode needs a running server and is not available offline. |
| Local planner | `/demo/` | Starts with a blank trip and stores it in this browser only. It can be used offline after the app has loaded. It is separate from account trips and is not shared with other devices. |

This repository contains source code only. It contains no real accounts, trips, receipt images, database, backups or credentials. It is independent of the original inspiration site and does not connect to it.

## Features

- **Accounts and trips:** Create an administrator on first run, register member accounts, create multiple planning or completed trips, choose an illustrated cover, and keep each trip's history separate.
- **Invitations and permissions:** Invite companions with single-use trip invitation links. A signed-out visitor can preview the trip and create an account from the link, even when public registration is closed. Trip creators and administrators manage membership and delete trip content; collaborators plan within their permissions.
- **Registration policy:** Public registration at `/register` is open by default. The server can close it (`CAMPING_REGISTRATION=closed`); new accounts then come only from trip invitation links.
- **Trip overview:** See the trip dates, destination, companions, and a departure countdown centered on the camping illustration alongside trip progress.
- **Five section tabs and the trip menu:** A trip has five tabs: 行程表 (schedule), 料理菜單 (meals), 採買清單 (shopping), 裝備分工 (gear), and 分帳記帳 (expenses). The former 旅伴與車輛 and 旅行設定 tabs are gone. Their actions are in the **旅行選單** (trip menu) opened from the menu button next to the trip title: edit the trip, add or edit companions, add, edit or delete vehicles, switch identity, export, import, print, scene motion settings, and reset. Old links to a removed tab open the schedule tab; stored companions, vehicles, and trip details are unchanged.
- **Itinerary:** Plan dated and timed stops for everyone, one vehicle or several, add notes and map links, mark stops complete, and filter by vehicle. Each vehicle can have its own departure time and meeting place. The add-stop button sits beside the date tabs.
- **Meals and shopping:** Use meal templates and ingredient shortcuts, assign cooks, and organize meals by date. Ingredients sync into categorized shopping lists without discarding manually managed items. Assign shoppers, update quantities, filter items, and check off purchases. The meal-image selector is hidden; previews and saved image choices are preserved.
- **Gear and departure checklist:** Separate personal and shared equipment, start from common camping presets, assign shared gear to a companion, and track each person's packing progress.
- **Shared expense ledger:** In account mode, record New Taiwan dollar expenses and repayments, review balances, and export ledger records separately from the trip handbook.
- **Receipt AI:** In account mode, a receipt photo can be sent to the configured OpenAI model (default `gpt-6-luna`) to suggest ledger items. Every suggestion must be reviewed before saving. An administrator decides who may use it (everyone, administrators only, or nobody), and per-user, daily, and monthly request limits cap the cost. It is off until a server-side API key is configured. There is no local-OCR fallback.
- **Administrator dashboard:** Manage accounts and trips, review the audit history, set the receipt AI policy, see receipt AI usage against its limits, and review failed logins and login alerts.
- **Mobile and accessibility:** Responsive layouts, finger-tracked swipe between the five tabs with a soft stop at either end, swipe actions on list rows for editing and deleting, horizontally scrollable date selection, light and dark themes, keyboard focus indicators, and reduced-motion support.
- **Illustrations and presentation:** Original SVG trip and meal illustrations, trip cover choices, a daily note, and optional scene animation controls with pause.
- **Trip export and print:** Export or print a trip handbook from the trip menu. Handbook export is separate from expense-ledger export and from a full Database backup.

## Plan a trip

1. **Create or open a handbook.** From your account homepage (`/<account-name>/home`), create a trip, enter its name and dates, select a cover, and add an optional destination, description, and notes. Local planner mode opens directly into its blank handbook.
2. **Add companions and vehicles.** Open the **旅行選單** (trip menu) next to the trip title. Add companions, roles, drivers, passengers, and vehicle capacity, and set each vehicle's departure time and place.
3. **Plan the itinerary.** In **行程表**, select a day and add a stop with a time, location, type, notes, and participants. Locations can open in a map app. Vehicle filters show each car's stops separately.
4. **Plan meals.** In **料理菜單**, add meals by date and mealtime. Apply a template or add ingredient shortcuts, assign a cook, and include notes. Linked ingredients are added to the shopping list automatically; editing meal ingredients updates the linked items.
5. **Organize shopping.** In **採買清單**, assign who buys each item, adjust its quantity or category, filter the list, and mark items as purchased. Hide purchased items to focus on what remains.
6. **Divide the gear.** In **裝備分工**, add personal or shared items. Personal gear is tracked per companion; shared gear can be assigned to an owner. Check the unassigned count before departure.
7. **Record expenses (account mode).** Open **分帳記帳**, add expenses and repayments, then review the balances. Expense ledgers are stored by the server, separately from handbook data.
8. **Get ready to leave.** Open departure mode to see your packing progress, your assigned personal and shared gear, and the next unfinished stop. Mark items packed and confirm when you are ready.
9. **Keep or share the handbook.** From the trip menu, export a JSON handbook backup or print the current handbook. Account trips remain available to trip members after signing in.

On a phone, swipe left or right across a trip to move between the five tabs. Swipe a supported list row left to reveal edit and delete actions; swipe right to close it. The on-screen action control is also available. Deletion still follows the account's permissions and confirmation prompts.

## Invitations and registration

- **Create a link.** In a trip, use **Invite companions** and share the generated `/invite/<token>` link with the intended person. A link expires after 7 days and can be used once. A trip can have at most 20 active links, and a member who is not a trip manager at most 5.
- **See and revoke links.** Trip managers and administrators see every active link of the trip; members see their own. The link's creator, the trip organizer, or an administrator can revoke a link.
- **Join as a signed-in user.** Opening the link while signed in shows the trip and adds you as a companion after you enter a name.
- **Register through the link.** A signed-out visitor sees a preview (trip name, destination, dates, and who invited them) and can create an account that joins the trip in one step. This works whether public registration is open or closed.
- **Registration policy.** With `CAMPING_REGISTRATION=open` (the default), anyone who can reach the server can register at `/register`. With `closed`, `/register` explains that an invitation link is needed and the registration API answers 403. Login and registration attempts are rate-limited per account name and per client address; a 429 response carries `Retry-After`.

Account names are 3–32 characters, start with a lowercase letter, and use lowercase letters, numbers, or hyphens. Passwords are 12–128 characters. There is **no default account or password**.

## Expense splitting and receipt AI

The **分帳記帳** tab uses the authenticated account-mode ledger. The local planner does not provide the server-backed expense ledger.

### Add and settle expenses

- Record who paid, the amount, category, date, and participating companions.
- Add repayments separately from purchases.
- Review the resulting balances and export the expense records when needed.
- Only users with the appropriate trip permissions can edit or remove ledger entries.

### Scan a receipt

1. An operator configures an OpenAI API key on the server (see [收據 AI（OpenAI）](#收據-aiopenai)), and an administrator allows receipt AI for the account.
2. Open **分帳記帳** for a trip and choose the receipt-photo option.
3. **Selecting a photo sends a prepared copy to OpenAI** using the configured model. Do not select a photo if you do not want it uploaded. API use may incur charges and is subject to OpenAI's API data policies.
4. Review the suggested store, date, items, categories, and amounts against the receipt. Correct anything uncertain and confirm the items before saving them to the ledger.
5. If recognition is unavailable, refused, or incorrect, enter the expenses manually. The app does not switch to local OCR.

JPEG, PNG, and WebP receipt photos are supported. Images over 10 MB or 20 megapixels are rejected; the prepared image is re-encoded and resized for the request, which removes EXIF/GPS metadata. The app does not save receipt photos or raw recognition text. It stores only the expense entries you confirm and a file fingerprint used to help prevent duplicate receipt entry.

### Who may use it, and how much

- **Policy.** In `/admin`, an administrator sets receipt AI to `all` (every trip member who can edit), `admins` (administrators only), or `off`. The saved setting wins over the server's start value `CAMPING_RECEIPT_AI_POLICY`; with neither, the policy is `all`. A refused request is answered before any limit is checked and is not counted.
- **Limits.** Each user may send 10 requests in a rolling 15 minutes, the whole server 100 per UTC day and 1000 per UTC month (configurable, see the environment table). The counts are stored in the Database and survive restarts. A request over a limit gets 429 with `Retry-After`, and nothing is sent to OpenAI. Each user can have one recognition in progress, and the server runs at most two at a time. If the counts cannot be read or written, the request gets 503 and nothing is sent.
- **Usage.** The administrator dashboard shows the current UTC day's and month's request and token totals next to the configured limits.

## Administrator dashboard

`/admin` is available to administrators only.

- **Accounts and trips:** list, promote or demote, and delete accounts; delete trips.
- **Audit history:** recent account, trip, invitation, and setting changes.
- **Receipt AI:** the policy control and the usage totals described above.
- **Login security (登入安全):** the 200 most recent failed logins (time, account name, client address, and reason), and login alerts. An alert is created when one account name has 5 failed logins within 15 minutes, or all account names together have 20, with at most one alert of the same kind per account name (or for all) every 15 minutes. While unacknowledged alerts exist, a banner shows their number; acknowledging an alert records an audit entry. The server keeps at most 5000 failed-login events and 1000 alerts. No password or session token is stored in these records.

以下維運章節以繁體中文撰寫，與 [`ci/jenkins/README.md`](ci/jenkins/README.md) 及 `.kiro/specs/jenkins-cicd-deploy/` 的用語一致。本文件中所有 `<...>`、`*.example`、`*.invalid` 皆為佔位符，不是實際值。

## 本機執行

需要 **Bun 1.3+**（版本以 `ci/toolchain.json` 為準）與一個 PostgreSQL 17 Database。資料改存於 PostgreSQL；`CAMPING_DB`（舊 SQLite 路徑）已不再讀取，設定時只會輸出警告。

1. 安裝與建置前端：

   ```sh
   bun install --frozen-lockfile
   bun run build
   ```

2. 建立本機開發用 Database（只綁定 `127.0.0.1`，不要改成 `0.0.0.0`）：

   ```sh
   docker run -d --name lm-dev-db -e POSTGRES_DB=little_moments -e POSTGRES_PASSWORD='<password>' \
     -p 127.0.0.1:<port>:5432 -v lm-dev-pgdata:/var/lib/postgresql/data postgres:17
   ```

3. 在同一個 shell 設定連線變數、套用遷移並啟動（PowerShell）：

   ```powershell
   $env:CAMPING_DATABASE_HOST = '127.0.0.1'
   $env:CAMPING_DATABASE_PORT = '<port>'
   $env:CAMPING_DATABASE_NAME = 'little_moments'
   $env:CAMPING_DATABASE_USER = 'postgres'
   $env:CAMPING_DATABASE_PASSWORD = '<password>'
   bun scripts/migrate.mjs
   bun run start
   ```

   bash：

   ```sh
   export CAMPING_DATABASE_HOST=127.0.0.1 CAMPING_DATABASE_PORT='<port>' CAMPING_DATABASE_NAME=little_moments \
     CAMPING_DATABASE_USER=postgres CAMPING_DATABASE_PASSWORD='<password>'
   bun scripts/migrate.mjs && bun run start
   ```

4. 開啟 `http://127.0.0.1:5173/setup` 建立自己的管理員帳號。**沒有預設管理員密碼**。loopback 綁定時首次設定只接受來自本機（loopback）的連線；也可以改用 `bun run create-admin`（見[帳號維運指令](#帳號維運指令create-admin-與-reset-password)）。之後登入用 `/login`、註冊用 `/register`、管理頁為 `/admin`、本機規劃為 `/demo/`。預設連接埠為 5173，可用 `PORT` 改變。

本機要試用收據 AI 時，把 OpenAI API 金鑰放在專案根目錄的 `.secrets/openai_api_key`（`CAMPING_OPENAI_API_KEY_FILE` 的預設路徑；`.secrets/` 已列於 `.gitignore` 與 `.dockerignore`），重新啟動 App 後生效。金鑰檔是明文，不要提交、同步或分享。

## 環境變數

App_Server（`scripts/serve.mjs`，映像中為 `/app/server/serve.js`）啟動時以 `server/config.js` 的 `parseConfig` 驗證下列變數（OpenAI 金鑰兩列由 `server/receipt-ai.js` 讀取，不經 `parseConfig`）。任何錯誤都只輸出「變數名稱＋原因」，不輸出值，並在連線 Database 或監聽任何連接埠之前以結束碼 2 結束；Database 在 30 秒內（1–5 秒間隔重試）仍無法連線時以結束碼 3 結束，訊息只含主機與連接埠。啟動成功時輸出 `Camping accounts ready: bind=… port=… allowedHosts=…` 與 `Camping accounts settings: registration=… receiptAiPolicy=… (<來源>)` 兩行，不含任何秘密。

<!-- env-table:start -->
| 名稱 | 用途 | 必填 | 預設值 | 未設定時 |
|---|---|---|---|---|
| `CAMPING_BIND_ADDRESS` | Bind_Address：監聽的 IP 位址字面值（IPv4 或 IPv6） | 否 | `127.0.0.1` | 只監聽 loopback。值不是有效 IP 位址時拒絕啟動 |
| `PORT` | 監聽連接埠（1–65535） | 否 | `5173` | 使用 5173。值無效時拒絕啟動 |
| `CAMPING_ALLOWED_HOSTS` | Allowed_Hosts：逗號分隔的允許 Host（主機名稱、IPv4 或 `[IPv6]`；最多 32 項、每項最多 253 字元、不得含空項或 `*`）。不符的請求回應 HTTP 421 | Bind_Address 不是 loopback 時必填 | `127.0.0.1,localhost,[::1]` | loopback Bind_Address：使用預設值。**非 loopback Bind_Address：拒絕啟動**（結束碼 2，錯誤指出 `CAMPING_ALLOWED_HOSTS`，不監聽任何連接埠） |
| `CAMPING_SETUP_TOKEN` | Setup_Token：非 loopback Bind_Address 時首次建立管理員所需的設定碼（至少 32 字元），建立成功後失效 | 否 | — | loopback Bind_Address：不啟用，首次設定改為只接受 loopback 用戶端。**非 loopback Bind_Address：每次啟動自動產生 256 位元設定碼，只輸出一次至 App 程序的 stdout（Deploy_Host 本機的容器日誌）**，不寫入 Database、Build_Record 或 HTTP 回應。設定值少於 32 字元時拒絕啟動 |
| `CAMPING_TRUSTED_PROXIES` | Trusted_Proxies：逗號分隔的 IP／CIDR；只採信這些來源送來的 `X-Forwarded-*` | 否 | 空 | 不採信任何轉送標頭。含空項、`*` 或無效位址時拒絕啟動 |
| `CAMPING_DATABASE_HOST` | Database 主機 | 是 | — | 拒絕啟動，錯誤逐一列出缺少的 `CAMPING_DATABASE_*` 名稱 |
| `CAMPING_DATABASE_PORT` | Database 連接埠 | 否 | `5432` | 使用 5432。值無效時拒絕啟動 |
| `CAMPING_DATABASE_NAME` | Database 名稱 | 是 | — | 拒絕啟動（同上） |
| `CAMPING_DATABASE_USER` | Database 帳號 | 是 | — | 拒絕啟動（同上） |
| `CAMPING_DATABASE_PASSWORD` | Database 密碼（只由 Credential_Store 提供） | 是 | — | 拒絕啟動（同上） |
| `CAMPING_DATABASE_SSLMODE` | Database TLS 模式：`disable`、`require` 或 `verify-full` | 否 | `disable` | 不使用 TLS（Compose 內部網路）。其他值拒絕啟動 |
| `CAMPING_DIST` | 前端建置成品目錄（相對路徑以工作目錄為基準） | 否 | `dist` | 使用 `dist`。目錄內沒有 `index.html` 時拒絕啟動 |
| `CAMPING_MIGRATIONS_DIR` | 遷移目錄（`scripts/migrate.mjs`、`scripts/import-sqlite.mjs` 使用） | 否 | 腳本上一層的 `migrations/` | repository 中為 `migrations/`；映像中為 `/app/migrations` |
| `CAMPING_REGISTRATION` | 公開註冊政策：`open` 或 `closed`。`closed` 時 `/register` 不開放、註冊 API 回應 403，帳號只能由旅行邀請連結建立 | 否 | `open` | 開放公開註冊（空字串視同未設定）。其他值拒絕啟動，錯誤只指出變數名稱 |
| `CAMPING_RECEIPT_AI_POLICY` | 收據 AI 政策的啟動初始值：`all`、`admins` 或 `off`。管理員在 `/admin` 儲存的設定優先，此值從不寫入 Database | 否 | — | 沒有初始值：管理頁未儲存設定時使用 `all`（仍需有效金鑰才會啟用）。其他值拒絕啟動，錯誤只指出變數名稱 |
| `CAMPING_OPENAI_MODEL_ID` | 收據 AI 使用的 OpenAI 模型 ID：`gpt-` 後接 1–80 個英文字母、數字、`.`、`_` 或 `-` | 否 | `gpt-6-luna` | 使用 `gpt-6-luna`（空字串視同未設定）。格式不符時拒絕啟動 |
| `CAMPING_OPENAI_IMAGE_DETAIL` | 送給 OpenAI 的圖片細節：`low`、`high` 或 `auto` | 否 | `high` | 使用 `high`（空字串視同未設定）。其他值拒絕啟動 |
| `CAMPING_OPENAI_MAX_COMPLETION_TOKENS` | 每次 OpenAI 請求的回覆 token 上限，1–16000 的整數 | 否 | `6000` | 使用 6000（空字串視同未設定）。超出範圍或不是整數時拒絕啟動 |
| `CAMPING_RECEIPT_AI_USER_LIMIT` | 每位使用者在滾動 15 分鐘內的收據 AI 請求上限，1–100 的整數 | 否 | `10` | 使用 10（空字串視同未設定）。超出範圍或不是整數時拒絕啟動 |
| `CAMPING_RECEIPT_AI_DAILY_LIMIT` | 全伺服器每個 UTC 日的收據 AI 請求上限，1–10000 的整數，且不得小於 `CAMPING_RECEIPT_AI_USER_LIMIT` | 否 | `100` | 使用 100（空字串視同未設定）。超出範圍、不是整數或小於每位使用者上限時拒絕啟動 |
| `CAMPING_RECEIPT_AI_MONTHLY_LIMIT` | 全伺服器每個 UTC 月的收據 AI 請求上限，1–100000 的整數，且不得小於 `CAMPING_RECEIPT_AI_DAILY_LIMIT` | 否 | `1000` | 使用 1000（空字串視同未設定）。超出範圍、不是整數或小於每日上限時拒絕啟動 |
| `CAMPING_OPENAI_API_KEY_FILE` | OpenAI API 金鑰檔路徑（檔案內容為一行金鑰）。只由 `server/receipt-ai.js` 讀取；金鑰不出現在啟動訊息、日誌或瀏覽器 | 否 | 專案根目錄的 `.secrets/openai_api_key` | 讀取預設路徑；檔案不存在或沒有有效金鑰時收據 AI 停用，App 照常啟動。Deploy_Host 預設為空字串（停用），只有 `release/` 可啟用 |
| `CAMPING_OPENAI_API_KEY` | 以環境變數直接提供 OpenAI API 金鑰（設定時優先於金鑰檔；`docker inspect` 與程序列表看得到，不建議使用） | 否 | 空 | 改讀 `CAMPING_OPENAI_API_KEY_FILE`。**Compose 中固定為空字串**，Deploy_Host 上的金鑰只能以金鑰檔提供 |
<!-- env-table:end -->

`CAMPING_DB` 不是設定欄位：設定時只輸出警告，值不會被讀取或輸出。`CAMPING_REGISTRATION`、`CAMPING_RECEIPT_AI_POLICY` 與 `CAMPING_RECEIPT_AI_*` 目前不由 `deploy/compose/compose.yaml` 傳入（`lm-deploy <env> app-env` 也只接受 Database 與 Setup_Token 的鍵），因此 Deploy_Host 使用預設值；收據 AI 政策可由管理員在 `/admin` 調整。

工具與測試使用的變數（不影響 App_Server）：

| 名稱 | 使用者 | 說明 |
|---|---|---|
| `CAMPING_TEST_DATABASE_HOST`、`_PORT`、`_NAME`、`_USER`、`_PASSWORD`、`_SSLMODE` | `bun test`、`scripts/check-accounts.mjs`、`scripts/security-suite.mjs` | 測試只讀這組變數，從不讀 `CAMPING_DATABASE_*`。HOST／NAME／USER／PASSWORD 必填，PORT 預設 `5432`、SSLMODE 預設 `disable`；未設定時明確失敗並列出變數名稱（不會靜默略過） |
| `CHROME_PATH`、`CAMPING_BUN` | 瀏覽器測試、安全測試 | Chromium／Chrome 與 Bun 可執行檔的絕對路徑，沒有預設值 |
| `CAMPING_SECURITY_LAN_BIND` | `scripts/security-suite.mjs` | `lan` 組的 Bind_Address，預設 `127.0.0.1`。開發機請維持預設；只有在隔離的 `--internal` Docker 網路中才設為 `0.0.0.0` |
| `CAMPING_SMOKE_BASE_URL`、`CAMPING_SMOKE_HOST`、`CAMPING_SMOKE_USERNAME`、`CAMPING_SMOKE_PASSWORD_FILE` | `scripts/smoke.mjs` | Smoke_Test 的目標 origin、Host 覆寫、合成帳號（預設 `smoke-bot`）與密碼檔 |

## 帳號維運指令：create-admin 與 reset-password

兩個指令都連線 `CAMPING_DATABASE_*` 指定的 PostgreSQL Database（只讀這組變數，驗證規則與 App_Server 相同），需要遷移已套用。錯誤訊息只含變數名稱、主機與連接埠或錯誤代碼，不含密碼或設定值。結束碼：0 成功、1 失敗、2 參數或設定錯誤。

```sh
bun run create-admin [--username <name>] [--display-name <name>] [--password-file <path>]
bun run reset-password <username> [--password-file <path>]
```

- `create-admin` 建立第一個管理員帳號（與 `/setup` 相同，稽核紀錄為 `setup.cli`）；Database 已有任何帳號時拒絕執行。未指定 `--username`、`--display-name` 時在終端機詢問；沒有終端機時兩者都必須指定。
- `reset-password` 為既有帳號設定新密碼，並登出該帳號的所有 session。App 沒有網頁版的密碼重設功能。
- **密碼來源只有三種**，依序為：`--password-file <path>`（檔案內只有一行密碼，最多 4096 bytes）、終端機隱藏輸入（不回顯，輸入兩次確認）、沒有終端機時從 stdin 管線讀取一行。密碼**從不**由指令列參數或環境變數讀取（`--password` 之類的參數會被拒絕），也從不輸出。不要用 `echo` 等方式把密碼寫進指令列，否則會留在 shell 歷史與程序列表中。

在 Deploy_Host 上，Database 只在 Compose 的 internal 網路中，因此改以 App_Image 內的 `/app/tools/create-admin.js`、`/app/tools/reset-password.js` 在同一 Compose 專案內執行。**主機上的指令沿用上方 [SQLite_Importer](#sqlite_importer從舊版-sqlite-匯入) 的 `--profile ops run … migrate` 模式**：`migrate` 服務已帶有 `app.env` 的 Database 憑證與 `CAMPING_DATABASE_HOST=db`，只把 entrypoint 換成 `bun` 與指令檔（`<image>` 為 `<LM_IMAGE_REPO>@sha256:<digest>`，通常是目前作用中的 digest）：

```sh
# 互動執行（不加 -T，配置終端機，密碼以隱藏輸入詢問）
sudo env LM_ENV=<env> APP_IMAGE_BLUE=<image> APP_IMAGE_GREEN=<image> APP_IMAGE_NEW=<image> \
  docker compose --project-directory /srv/lm/<env> -f /srv/lm/<env>/compose.yaml --env-file /srv/lm/<env>/<env>.env \
  --profile ops run --rm --no-deps --entrypoint bun migrate /app/tools/create-admin.js

# 非互動執行（加 -T；密碼由 stdin 管線提供，<password-file> 由執行 sudo 的維運者讀取）
sudo env LM_ENV=<env> APP_IMAGE_BLUE=<image> APP_IMAGE_GREEN=<image> APP_IMAGE_NEW=<image> \
  docker compose --project-directory /srv/lm/<env> -f /srv/lm/<env>/compose.yaml --env-file /srv/lm/<env>/<env>.env \
  --profile ops run --rm --no-deps -T --entrypoint bun migrate /app/tools/reset-password.js <username> < <password-file>
```

要改用 `--password-file` 時，比照 import-sqlite 以 `-v <password-dir>:/run/lm-cli:ro` 唯讀掛載目錄，並傳入 `--password-file /run/lm-cli/<file>`；容器以 UID 10001 執行，檔案必須可被該 UID 讀取，用完即刪除主機上的密碼檔。此指令與 import-sqlite 相同，未在實際 Deploy_Host 上驗證，首次使用前先在 Staging 試做。

## 資料與安全

- 預設只綁定 `127.0.0.1`，並只接受 loopback Host；loopback 綁定時首次管理員設定只接受 loopback 用戶端。非 loopback 綁定時必須設定 Allowed_Hosts，首次設定另需 Setup_Token。
- Sessions 使用 HttpOnly、`SameSite=Strict` cookies，會過期；密碼以加鹽 scrypt 雜湊。變更資料的請求需要完全相符的 Origin、不接受 `Sec-Fetch-Site: cross-site`，並需要對應的帳號／行程權限；刪除只限行程建立者或管理員。
- 每個回應都帶有安全標頭（Content-Security-Policy、禁止被嵌入框架等）。未預期的錯誤只回應固定的通用訊息，日誌只記錄時間、方法、不含查詢字串的路徑與錯誤名稱，不含請求內容、cookie、密碼、邀請碼或金鑰。
- 帳號 API 回應不會被快取供離線使用。`/demo/` 的本機規劃使用獨立的瀏覽器本機儲存，不上傳也不同步。
- App 不保存收據影像或辨識原始文字。選擇收據照片並使用收據 AI 時，照片會送到 OpenAI；使用前請先確認 OpenAI 的 API 資料政策。瀏覽器端 OCR 已移除。
- 雲端 AI 收據辨識（OpenAI）在 Deploy_Host **預設停用，只有 `release/` 可啟用**：Compose 把 `CAMPING_OPENAI_API_KEY` 固定為空字串，`CAMPING_OPENAI_API_KEY_FILE` 等 `CAMPING_OPENAI_*` 預設空白，`ci/` 不定義任何 OpenAI 憑證。若 Release_Approver 決定為特定環境啟用，金鑰檔只能來自 `release/` 資料夾的 Credential_Store（見 [`ci/jenkins/README.md`](ci/jenkins/README.md)）。
- 首頁 JSON 匯入控制項仍隱藏；本機規劃的匯入只接受 1 MiB 以下的檔案。行程匯出與費用匯出各自獨立，都不能取代完整的 Database 備份。

### 憑證來源

- Database 憑證、Setup_Token、Registry 憑證、Deploy_Host 部署憑證、smoke 帳號密碼與 OpenAI API 金鑰（`CAMPING_OPENAI_API_KEY_FILE` 指向的金鑰檔；`CAMPING_OPENAI_API_KEY` 在 Compose 中永遠為空）**只由 Credential_Store 提供**（Jenkins 資料夾範圍憑證，ID 與秘密檔位置見 [`ci/jenkins/README.md`](ci/jenkins/README.md)）。
- 這些值**不得寫入 repository 或 App_Image**。Deploy_Host 上的 `/srv/lm/<env>/app.env` 與 `db.env` 為 0600 root，由 Pipeline 經 `lm-deploy <env> app-env`（stdin）或維運者依 `deploy/compose/*.env.example` 建立；範本中的佔位符不得直接使用。OpenAI 金鑰也不得以 Docker build `ARG` 傳入（會留在映像歷史中）。
- 本機測試用的 Database 密碼只放在目前 shell 的環境變數中，不要寫入任何檔案。

## 收據 AI（OpenAI）

- **金鑰。** `server/receipt-ai.js` 先讀 `CAMPING_OPENAI_API_KEY`，沒有值時讀 `CAMPING_OPENAI_API_KEY_FILE`（預設專案根目錄的 `.secrets/openai_api_key`），並去除前後空白。金鑰格式必須是 `sk-` 開頭；沒有有效金鑰時收據 AI 停用，App 照常啟動。更換金鑰檔內容後重新啟動 App 即生效。金鑰只在伺服器端使用，從不送到瀏覽器。
- **成本設定。** 模型、圖片細節、回覆 token 上限與三個用量上限見[環境變數](#環境變數)表；用量上限須符合「每位使用者上限 ≤ 每日上限 ≤ 每月上限」。建議另在 OpenAI 後台為專案設定每月預算與用量上限。
- **Deploy_Host。** 預設停用、只有 `release/` 可啟用。目前的 `deploy/compose/compose.yaml` 沒有掛載金鑰檔；啟用需要 Release_Approver 決定，並同時修改 Pipeline、Compose 設定與 `ci/jenkins/README.md` 的憑證表。

## 秘密掃描

`scripts/scan-secrets.mjs`（Secret_Scanner）掃描 repository 中是否有外洩的金鑰：

```sh
bun scripts/scan-secrets.mjs [--root <dir>] [--allowlist <file>]
```

- 掃描 `node_modules/` 以外的每個檔案（包含被忽略的 `.secrets/`、`data/` 與建置輸出，以及二進位檔；單檔上限 50 MB，超過的檔案會列出）。`--root` 是 git repository 時，另掃描所有本機分支、遠端追蹤分支與 tag 可到達的每個 commit，包含之後已刪除的內容。
- 偵測 OpenAI 金鑰、AWS access key ID、PEM 私鑰、Bearer token、URL 內嵌的帳密，以及名稱含 key／secret／token／password 的高熵值。每筆結果只顯示位置、規則名稱與遮蔽後的值，從不輸出完整秘密。
- 結束碼：0 沒有發現（輸出掃描的檔案數、commit 數與 allowlist 命中數）、1 有不在 allowlist 的發現、2 掃描未完成或 allowlist 項目缺少理由。allowlist 預設為 `scripts/secret-allowlist.json`，每個項目都必須附理由。
- 掃描完整 git 歷史：`git clone --mirror <your-repository-url> repo.git`，再從專案目錄執行 `bun scripts/scan-secrets.mjs --root repo.git`；或在一般 clone 內直接執行 `bun scripts/scan-secrets.mjs`。發現真正的金鑰時，先到提供者撤銷並更換金鑰；改寫歷史不能取代撤銷。

## LAN 部署

部署架構：Jenkins（`Jenkinsfile`、[`ci/jenkins/`](ci/jenkins/README.md)）建置並簽章 App_Image，推送至 LAN Registry（[`deploy/registry/`](deploy/registry/)：`compose.yaml`、`config.yml`、`Caddyfile` 與 `verify-registry.sh`），再經 SSH forced command 呼叫 Deploy_Host 上的 `/opt/lm/bin/lm-deploy`，以 Docker Compose（`deploy/compose/compose.yaml`）做 blue/green 切換。Jenkins 的設定、資料夾憑證與驗證步驟見 [`ci/jenkins/README.md`](ci/jenkins/README.md)。Caddy proxy（`deploy/caddy/`）是唯一發布連接埠的服務；App 容器以 `CAMPING_BIND_ADDRESS=0.0.0.0` 在 internal 網路內監聽，`CAMPING_ALLOWED_HOSTS` 取自 `<env>.env` 的 `ALLOWED_HOSTS`，`CAMPING_TRUSTED_PROXIES` 只設為 proxy 的固定 `/32`；Database 不發布任何連接埠。

**存取範圍只限區域網路：**

- proxy 只綁定 `<env>.env` 的 `LAN_IP`。`deploy/host/install.sh --lan-cidr <CIDR>` 安裝的 DOCKER-USER 規則（`deploy/host/docker-user.rules`）只允許來源位於設定 LAN 網段的主機連線至 Docker 發布的連接埠，網段外來源無法建立 TCP 連線（規則位於 Docker 轉送層，UFW／INPUT 規則擋不住 Docker 發布的連接埠）。
- 安裝後以 `sudo deploy/host/verify-host.sh --lan-cidr <CIDR>` 確認防火牆、Database 未發布、備份目錄權限與部署帳號設定。
- **公開網際網路曝露不在支援範圍內**，包含路由器連接埠轉發、對外公開的反向代理、以及任何通道服務（tunnel）。不要為了對外公開而移除 Allowed_Hosts、Setup_Token 或 LAN 網段限制。

首次管理員設定：Pipeline 由 Credential_Store 提供 `CAMPING_SETUP_TOKEN`（`lm-<env>-setup-token`）。若 `app.env` 未設定，App 每次啟動自動產生設定碼並只寫入容器日誌，只能在 Deploy_Host 本機以 `sudo docker logs lm-<env>-app-<color>-1 2>&1 | grep Setup_Token` 讀取；建立管理員後即失效。也可以在 Deploy_Host 上以 `create-admin` 建立（見[帳號維運指令](#帳號維運指令create-admin-與-reset-password)）。

Staging 與 Production 是兩個獨立的 Compose 專案（`lm-staging`、`lm-prod`），不共用 Database、資料卷、網路或部署憑證。

## SQLite_Importer：從舊版 SQLite 匯入

`scripts/import-sqlite.mjs`（映像中為 `/app/tools/import-sqlite.js`）把舊版 `accounts.sqlite` 一次性匯入空的 PostgreSQL Database。來源可以是 main 的舊版，或 security-harden 版（含設定、收據 AI 用量、安全事件與警示，以及新的邀請欄位）。它只開啟來源的暫存複本，不修改來源檔案；目標由 `CAMPING_DATABASE_*` 指定。目標 Database 必須是新的：已套用遷移，但**尚未**在 `/setup` 建立任何帳號。

1. 停止舊版 SQLite App 的所有寫入者，再完整備份來源：把 `accounts.sqlite` 與同目錄的 `accounts.sqlite-wal`、`accounts.sqlite-shm`（若存在）一起複製到 repository 以外的私人目錄。不要在仍有寫入者時只複製主檔。
2. 備份目標 Database。Deploy_Host 上：`sudo /opt/lm/bin/lm-deploy <env> backup`（記下輸出的 `id`）；本機：`pg_dump -Fc` 至私人目錄。
3. 執行匯入：

   ```sh
   # repository（目標 Database 可直接連線時；CAMPING_DATABASE_* 已設定於目前 shell）
   bun scripts/import-sqlite.mjs --source <path>/accounts.sqlite
   ```

   Database 只在 Deploy_Host 的 internal 網路中，因此在 Deploy_Host 上改以 App_Image 在同一 Compose 專案內執行（`<image>` 為 `<LM_IMAGE_REPO>@sha256:<digest>`，通常是目前作用中的 digest）：

   ```sh
   sudo env LM_ENV=<env> APP_IMAGE_BLUE=<image> APP_IMAGE_GREEN=<image> APP_IMAGE_NEW=<image> \
     docker compose --project-directory /srv/lm/<env> -f /srv/lm/<env>/compose.yaml --env-file /srv/lm/<env>/<env>.env \
     --profile ops run --rm --no-deps -T -v <source-dir>:/import:ro --entrypoint bun migrate \
     /app/tools/import-sqlite.js --source /import/accounts.sqlite
   ```

   容器以 UID 10001 執行，來源檔必須可被該 UID 讀取；暫存複本寫在容器的 `/tmp`（tmpfs 16 MiB），來源（含 `-wal`）較大時請改用 repository 方式。此指令未在實際 Deploy_Host 上驗證，首次使用前先在 Staging 試做。
4. 比對輸出：成功時輸出 `table source target` 標題與每個資料表一行，**每一行的 source 與 target 筆數都必須相同**，結束碼為 0。
5. 以既有使用者帳號在 `/login` 登入，確認行程、成員與費用都看得到。

失敗處理（錯誤訊息只含資料表／欄位名稱與原因類別，不含資料內容或密碼）：

| 結束碼 | 意義 | 目標 Database 狀態 |
|---|---|---|
| 2 | 參數或 `CAMPING_DATABASE_*` 設定錯誤 | 未連線 |
| 3 | 來源不存在、不是 SQLite，或缺少必要資料表／欄位 | 未連線 |
| 4 | 目標任一資料表已有資料（例如已建立使用者），中止匯入 | 未寫入任何資料 |
| 5 | 讀取或寫入失敗，輸出失敗的資料表名稱 | 整筆交易已回復，維持匯入前狀態 |
| 6 | 提交前筆數比對不符，輸出各資料表筆數 | 整筆交易已回復 |
| 7 | 匯入期間來源檔或來源目錄被改變 | 匯入前偵測到時已回復；結束時才偵測到則匯入已提交，需重新確認 |
| 1 | 連線、遷移或其他執行錯誤 | 匯入交易未提交 |

後續處理：

1. 依輸出的資料表名稱與原因修正問題（例如重新從步驟 1 的備份取得完整來源、修正連線設定）。
2. 結束碼 4：確認目標確實是要匯入的新 Database；若只是誤建了帳號，以步驟 2 的備份還原（或重建空的 Database）後再匯入，不要手動刪除資料。
3. 結束碼 5、6：目標已自動回復，修正後直接從步驟 3 重新執行。
4. 結束碼 7：確認舊版 App 已完全停止後重新執行；若匯入已提交，依步驟 4、5 驗證，有疑慮時以步驟 2 的備份還原後重做。
5. 驗證完成前保留來源與目標的備份。

## 手動回滾（Production）

回滾只會切換至 Deploy_Host 保留的最近 3 個 Image_Digest 之一，**不執行 Migration_Runner，Database Schema 保持不變**（遷移遵循 expand/contract，舊映像必須能在目前 Schema 上執行）。

1. 以 Release_Approver 帳號（`lm-release-approvers` 群組且列於 `ci/release-approvers.json`）在 Jenkins 開啟 `release/rollback`，按 Build。其他帳號觸發會被拒絕。
2. Pipeline 經 SSH 執行 `lm-deploy prod status`，列出可回滾目標：保留集合中、但不是目前作用中版本的 digest。
3. 在 `input` 中選擇目標 `digest` 並填寫回滾理由後送出；送出者必須是觸發建置的同一個 Release_Approver。需要對照 digest 與版本時，可用 `release/digest-lookup` 查詢 Build_Record。
4. Pipeline 取得 `lm-prod` 鎖；若已有部署進行中，建置會以「已有部署進行中」失敗，待部署結束後重新執行。
5. Deploy_Host 執行 `lm-deploy prod rollback <digest>`：在閒置槽位啟動目標映像 → 健康檢查 → 切換 proxy → 切換後 120 秒內連續 3 次健康檢查成功 → `finalize`。
6. 確認建置成功，並在 Build_Record 檢查觸發者、來源與目標 digest、理由與完成時間。若切換後健康檢查失敗，Pipeline 標記失敗且不再自動切換，需人工檢查（`sudo /opt/lm/bin/lm-deploy prod status`）。

## 備份與還原

`lm-deploy <env> backup` 以 `pg_dump -Fc` 建立備份，驗證大小、`pg_restore --list` 與 sha256 後存放於 `/var/backups/little-moments/<env>/`（lm-ops 擁有、0700，不在 Docker 卷或 repository 內）。備份識別碼格式為 `<env>-<YYYYMMDD>T<HHMMSS>Z-<sha7>`；同名 `.dump.sha256` 存在即代表已驗證。Production 保留最近 14 份。`release/restore-drill` 每月 1 日與 15 日把最新備份還原至隔離的 drill 專案並執行 Smoke_Test，不影響 Production。

`lm-deploy` 沒有 restore 子命令；下列為在 Deploy_Host 上以 root 執行的手動程序（未在實際 Deploy_Host 上驗證，建議先在 Staging 演練）。還原期間 App 會停止服務。`<env>` 為 `prod` 或 `staging`，`<POSTGRES_USER>`、`<POSTGRES_DB>` 為 `/srv/lm/<env>/db.env` 中的名稱（不要輸出密碼）。

1. 確認沒有進行中的部署：`sudo /opt/lm/bin/lm-deploy <env> status`，`deployInProgress` 必須為 `false`、`phase` 為 `idle`；記下 `active.color` 與 `active.digest`。
2. 從保留的備份中選擇 `<backup-id>`（最多 14 份）：`sudo ls -1 /var/backups/little-moments/<env>/ | grep '\.dump\.sha256$'`。
3. 驗證校驗碼：`sudo sh -c 'cd /var/backups/little-moments/<env> && sha256sum -c <backup-id>.dump.sha256'`。
4. 把選定備份複製到 root 私人目錄（下一步的新備份會修剪最舊的一份）：`sudo install -d -m 0700 /root/lm-restore && sudo cp -p /var/backups/little-moments/<env>/<backup-id>.dump /root/lm-restore/`。
5. 備份目前狀態以便復原：`sudo /opt/lm/bin/lm-deploy <env> backup`，記下輸出的 `id`。
6. 停止 App 容器：`sudo docker ps --filter label=com.docker.compose.project=lm-<env>` 找出 `lm-<env>-app-blue-1`／`lm-<env>-app-green-1`，再 `sudo docker stop <container>`。
7. 執行還原（單一交易；失敗時 Database 維持原狀）：

   ```sh
   sudo sh -c 'docker exec -i lm-<env>-db-1 pg_restore --clean --if-exists --no-owner --no-privileges \
     --exit-on-error --single-transaction -U <POSTGRES_USER> -d <POSTGRES_DB> < /root/lm-restore/<backup-id>.dump'
   ```

8. 補齊備份之後才加入的遷移：`sudo /opt/lm/bin/lm-deploy <env> migrate <active-digest>`（需要步驟 5 的一小時內備份）。
9. 啟動 App 並等待健康：`sudo docker start lm-<env>-app-<active-color>-1`，再 `sudo /opt/lm/bin/lm-deploy <env> health <active-color> --wait`。
10. 在 LAN 內的 repository checkout 執行 Smoke_Test，結束碼必須為 0（`CAMPING_SMOKE_BASE_URL` 為 proxy 的 origin，依 `LM_TLS_MODE` 為 `https://` 或 `http://`；smoke-bot 帳號與 smoke-fixture 行程須存在於還原後的資料中）：

    ```sh
    CAMPING_SMOKE_BASE_URL='https://<lan-hostname>' CAMPING_SMOKE_PASSWORD_FILE='<path-to-smoke-password-file>' bun scripts/smoke.mjs
    ```

11. 刪除暫存複本：`sudo rm -rf /root/lm-restore`。

若步驟 7 失敗，Database 未改變，直接執行步驟 9。若步驟 9 或 10 失敗，以步驟 5 的備份識別碼重複步驟 2–10 回到還原前狀態。

## 測試

單元與 API 測試、瀏覽器測試和安全測試都需要一個 PostgreSQL Ephemeral_Database，且只透過 `CAMPING_TEST_DATABASE_*` 連線。`bun test` 的每個測試檔建立自己的 `t_<random>` schema 並在結束時刪除；瀏覽器與安全測試建立 `lm_e2e_<random>` Database（帳號需要 `CREATEDB`），結束時（含失敗或 Ctrl+C）刪除。不要把測試指向實際伺服器或私人 Database。

1. 建立 Ephemeral_Database（資料只在 tmpfs，連接埠只綁定 `127.0.0.1`）：

   ```sh
   docker run -d --name lm-test-db -e POSTGRES_PASSWORD='<password>' -p 127.0.0.1:<port>:5432 \
     --tmpfs /var/lib/postgresql/data postgres:17
   docker exec lm-test-db pg_isready -U postgres
   ```

2. 在目前 shell 指定測試 Database（PowerShell；bash 用 `export` 設定同名變數）：

   ```powershell
   $env:CAMPING_TEST_DATABASE_HOST = '127.0.0.1'
   $env:CAMPING_TEST_DATABASE_PORT = '<port>'
   $env:CAMPING_TEST_DATABASE_NAME = 'postgres'
   $env:CAMPING_TEST_DATABASE_USER = 'postgres'
   $env:CAMPING_TEST_DATABASE_PASSWORD = '<password>'
   ```

3. 先 `bun run build`，再執行單元與 API 測試：bash 用 `bun test tests/*.test.js`；PowerShell 不展開萬用字元，改用 `bun test ./tests/`。
4. 瀏覽器測試（`playwright.config.js`）以原生 Node 執行 harness，需要 `CHROME_PATH` 與 `CAMPING_BUN`：

   ```powershell
   $env:CHROME_PATH = '<path to chrome.exe or chromium>'
   $env:CAMPING_BUN = (Get-Command bun).Source
   node scripts/check-accounts.mjs
   ```

   harness 套用遷移後在 **5181** 啟動獨立伺服器並建立合成測試帳號。伺服器輸出在 `reports/server.log`，JUnit／JSON 結果在 `reports/e2e-junit.xml`、`reports/e2e.json`，失敗截圖與 trace 在 `test-results/`。測試帳號密碼為合成值，只用於隔離的測試 Database，不是 App 預設值。
5. 安全測試（同樣需要 `CHROME_PATH`）：`bun scripts/security-suite.mjs`。
6. 銷毀 Ephemeral_Database 並清除變數：

   ```sh
   docker rm -f -v lm-test-db
   ```

   ```powershell
   Remove-Item Env:CAMPING_TEST_DATABASE_*
   ```

## 安全審查文件

[`docs/security-review.md`](docs/security-review.md) 記錄 security-harden 分支的威脅模型與每個 Finding；[`docs/security-report.md`](docs/security-report.md) 彙整修正項目、測試結果與維運者待辦。兩份文件描述的是合併前的 security-harden 分支：其中的 SQLite、nginx／published mode 與 docker-compose 部署內容已由本文件的 PostgreSQL 資料層與 Jenkins／Deploy_Host 部署取代，收據 AI 以本文件的 OpenAI 設定為準。

## GitHub 範圍

本 repository 只存放**原始碼**與部署設定（`Dockerfile`、`deploy/`、`ci/`、`Jenkinsfile`），不是託管網站，也不含個人資料。**GitHub Pages 無法執行 Bun／PostgreSQL 後端。** 建置成品、相依套件、截圖、日誌、備份與 Database 檔案都不納入版本控制。

## Third-party assets

Self-hosted Huninn fonts retain their SIL Open Font License files in `assets/fonts/`. Font provenance is in `assets/fonts/SOURCE.txt`.

No project-wide open-source license has been selected. Existing third-party license notices remain applicable.
