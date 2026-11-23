# Design Document：Rust 全面改寫與自架 Supabase 即時同步（第一版）

## Overview

本設計把「日子拾光 / LITTLE MOMENTS」的帳號版改寫成 Rust：後端是 axum 服務 `lm-server`，前端是以 Leptos 編譯成 WebAssembly 的 `lm-web`，資料、登入與即時推送改用自架的 Supabase（PostgreSQL、Auth／GoTrue、Realtime）。工作在分支 `rust-supabase-rewrite`（由 `main` 的 1b925a7 建立）進行。舊的 `rust-rewrite` 分支與 `.worktrees/rust-rewrite` 不動；本設計只借用它的 workspace 配置方式（`crates/*`、wasm 前端不參與原生建置、`rust-toolchain.toml` 指定 stable 與 `wasm32-unknown-unknown`）。

改寫的目的是即時協作。現在每趟旅行是一個 `trips.state_json` 文字欄位加一個 `revision`：任何寫入（包括一個勾選）都要帶最新版本號，否則得到 409；兩個人改不同項目也會互相擋住；其他人的畫面只能靠行程表分頁每 3 秒一次的 `PUT /api/trips/:id/presence` 輪詢發現新版本，再整份重抓、整頁重繪。這次要先完成的第一個版本（以下稱「第一版」）改成三件事：資料以「一個項目一列」儲存；每次提交產生一個依序編號的變更集（ChangeSet），透過 Supabase Realtime 的私有頻道推送給同一趟旅行的成員；前端用細粒度反應式（fine-grained reactivity），以列 id 為鍵，只重繪有變更的項目。

所有寫入與商業規則都在 Rust。`lm-core` 是不做 IO 的共用 crate，包含資料型別、命令、權限、驗證、衍生資料（料理食材 → 採買品項）、文字版與分帳計算；伺服器用它決定每個命令的結果，前端用同一份程式做表單檢查與樂觀更新的預測。PostgreSQL 負責儲存、交易、外鍵與發布；Realtime 頻道的授權用 `realtime.messages` 上的 RLS 政策。第一版只做主要功能，CI/CD、資安強化工作流與 QA 測試套件不在範圍內；測試只寫 `lm-core` 的單元測試與 proptest 屬性測試，以及 `lm-supabase` 協定與連線狀態機的少量單元測試。現行的 Bun 版留在原處作為行為參考。

實作語言：**Rust**（後端、前端與共用邏輯）；資料庫結構以 **SQL** 遷移檔描述。

### 現況問題與根本原因

| 現象 | 原因（已讀取的程式碼） | 第一版的對策 |
|---|---|---|
| 兩個人同時勾選或編輯不同項目，後送出的一方收到 409「旅行已有更新，請重新載入後再勾選。」 | `migrations/0001_initial.sql` 的 `trips` 只有一個 `state_json TEXT` 與一個 `revision`；`server/accounts.js` 的 `putTrip`、`patchTrip`、`checkTrip` 都先呼叫 `requireRevision()`，`persist()` 以 `expectedRevision` 條件更新整列 | 一個項目一列（`app.*` 資料表）；命令只改自己指定的列與欄位；同一趟旅行的命令在伺服器依提交順序逐一執行，客戶端不需要帶版本號 |
| 衝突時介面要求「先匯出，再重新載入合併」 | `src/app.js` 的 `commitAccount()`、`accountCheck()` 的 409 文案 | 不再整份覆寫，也就沒有需要人工合併的衝突；同一欄位的並行修改依提交順序決定，後提交者生效 |
| 其他人的變更最多晚 3 秒才出現，而且只有行程表分頁會更新 | `src/app.js` 的 `presenceTick()` 每 3 秒呼叫 `PUT /api/trips/:id/presence`，看到較新的 `revision` 才 `GET` 整份旅行 | 提交時由資料庫 trigger 呼叫 `realtime.send()` 推送變更集；所有分頁都即時收到 |
| 收到更新後整頁重繪，捲動位置與展開狀態容易被打斷 | `render()` 每次以 `app.innerHTML` 重建整個畫面 | Leptos 以列 id 為鍵的 `<For>`，每列一個 signal，只更新變更的列 |
| 「誰正在編輯」存在伺服器記憶體，重啟就消失，只在輪詢時更新 | `server/accounts.js` 的 `presence` Map 與 `PRESENCE_TTL_MS` | Supabase Realtime Presence；斷線時自動移除；在被編輯的卡片或列上以圓形頭像顯示編輯者 |

### 必要行為

下列編號在後面的演算法、屬性與錯誤處理中引用；之後從本設計推導需求時，以它們為起點。

| 編號 | 行為 |
|---|---|
| B1 | 一位成員的變更不需重新載入就出現在同一趟旅行其他成員的畫面上；區網內目標 2 秒內。 |
| B2 | 只重繪有變更的項目（以列 id 為鍵）。 |
| B3 | 編輯不同項目永遠不衝突；同一欄位的並行編輯依伺服器提交順序決定，每位成員最後看到相同結果；不再有「匯出再重新載入合併」。 |
| B4 | 勾選（採買已買、個人裝備已打包、出發確認）是冪等的集合操作：送出「想要的狀態」，不是切換。 |
| B5 | 衍生資料（料理食材 → 採買品項，現行 `syncMealIngredients()`）只在伺服器計算一次，不刪除手動管理或已買的品項。 |
| B6 | 旅行成員資格與現行權限規則在伺服器端強制：`lm-server` 決定每個命令，Realtime 頻道以 RLS 限制只有成員能加入。 |
| B7 | WebSocket 斷線、訊息遺失或分頁休眠之後重新同步，不漏掉任何變更。 |
| B8 | 樂觀更新：操作立即反映在畫面上；伺服器拒絕時回復，並顯示原因。 |
| B9 | 顯示誰正在編輯哪張卡片或哪一列（Presence）：在那張卡片或那一列上顯示圓形頭像，頭像內是編輯者帳號顯示名稱的第一個字（例如「陳小明」顯示「陳」）；多人時最多 3 個頭像加「+N」；頭像不是唯一的訊號，另有無障礙名稱與完整名稱的提示。 |
| B10 | 文字版由資料決定性產生，可一鍵複製。 |
| B11 | 外觀沿用現有插畫、字型與樣式。 |
| B12 | 本機 Supabase 的埠只綁在 127.0.0.1；只要服務可能被 localhost 以外的機器連到，就不得使用 Supabase 的範例 JWT 密鑰與金鑰。 |

### 重要設計決策摘要

| 編號 | 決策 | 選擇 | 理由（比較見「架構選項」） |
|---|---|---|---|
| D1 | 商業規則放在哪裡 | `lm-server` 是唯一的寫入者，規則在 `lm-core`；前端不直接寫資料庫 | 符合「全部用 Rust」；權限與衍生資料只有一份實作；可以在 `cargo test` 以 proptest 驗證 |
| D2 | 推送機制 | 每次提交寫一列 `app.trip_changes`，AFTER INSERT trigger 呼叫 `realtime.send(payload, 'changeset', 'trip:<id>', true)` | 與資料在同一個交易：沒提交就不會推送；一個命令（含衍生的採買變更）是一則訊息；只送到該旅行的私有頻道 |
| D3 | 授權 | Realtime：`realtime.messages` 的 RLS 政策只讓成員（與管理員）接收 broadcast 與 presence，只讓成員送 presence；客戶端不能送 broadcast。資料表放在不公開的 `app` schema，全部啟用 RLS，不給 `anon`、`authenticated` 任何資料表權限 | PostgREST 看不到 `app`；即使看得到也讀不到；推送只能由資料庫發出 |
| D4 | 合併模型 | 每趟旅行一個遞增序號 `seq`；每列帶 `version`（最後修改它的 `seq`）；客戶端以「版本較大者勝」合併，刪除留下墓碑，直到低於水位線 | 任意順序、重複與斷線後補齊都收斂到同一結果（屬性 1） |
| D5 | 命令粒度 | 欄位層級的 patch 與集合操作（例如 `SetGearPacked { packed }`、乘客的加入與移除）；新列的 id 由客戶端產生 | 改不同欄位不會互相覆蓋；新列可以先顯示在畫面上 |
| D6 | 重新同步 | 先加入頻道，再抓 `GET …/changes?after=<水位線>`（第一次則抓快照）；收到的 `seq` 跳號時立刻補齊；分頁可見時每 60 秒比對一次 `head` | broadcast 最多送達一次，沒有連線者時會被丟棄；正確性不依賴推送 |
| D7 | 前端框架 | Leptos 0.8（CSR），以 trunk 建置 | 細粒度 signal 與以鍵追蹤的 `<For>`；社群有 Leptos + Supabase 的 CSR 範例 |
| D8 | Supabase 用戶端 | 自寫精簡用戶端：伺服器端 GoTrue REST（reqwest）、瀏覽器端 Realtime Phoenix 協定（web-sys WebSocket），以 trait 隔離 | 官方沒有 Rust 函式庫；社群 crate 多半依賴 tokio 與 native-tls，無法編成 wasm32 |
| D9 | 登入 | Supabase Auth；`lm-server` 代理註冊、登入與換發（BFF），帳號名稱對應到合成 email `<username>@<LM_AUTH_EMAIL_DOMAIN>` | 保留現行「帳號名稱 + 密碼」（已確認 1）；帳號名稱規則與邀請註冊只在一處 |
| D10 | 對外入口 | 瀏覽器只連 `lm-server`：`/api/*` 與 `/realtime/v1/websocket`（由 `lm-server` 轉送給 Supabase，並補上 `apikey`） | Supabase 永遠只綁 127.0.0.1；同源，不需要 CORS；之後要在區網測試只需開放一個埠 |
| D11 | 本機開發 | Supabase CLI 本機堆疊（`supabase start`），以只綁 127.0.0.1 的 Docker 網路啟動；自架 Docker Compose 留到部署階段 | 在 WSL 2 中只需要 Docker Engine 與 CLI 的 Linux 執行檔（D14）；`supabase db reset` 直接套用 `supabase/migrations` |
| D12 | 舊程式 | Bun 版留在原處，只新增 Rust workspace 與 `supabase/` | 移植時逐條對照規則與既有測試案例；兩者互不干擾 |
| D13 | 「誰正在編輯」的呈現 | 被編輯的卡片或列上顯示圓形頭像：字是帳號顯示名稱修剪前後空白後的第一個擴充字素叢集（`unicode-segmentation`），名稱是空的時候用中性符號；底色由帳號 id 決定（FNV-1a 雜湊後查 12 色的色盤），文字色在設計時選好、對比至少 4.5:1；多人時依帳號 id 排序，最多 3 個頭像加「+N」；每個頭像有無障礙名稱與完整名稱的提示 | 使用者確認的要求（已確認 3）。顯示名稱屬於帳號，所以同一個人在每趟旅行、每台裝置都是同一個字與顏色；以字素叢集切字，emoji 序列、國旗與組合字元不會被切開；查表只用整數運算，瀏覽器與原生環境結果相同 |
| D14 | 開發環境 | 在 Windows 的 WSL 2（Ubuntu）中開發：cargo、trunk、Docker Engine 與 Supabase CLI 都在 WSL 中執行；Repository 留在 Windows 的磁碟，瀏覽器與 git 留在 Windows（見「本機開發」） | 任務執行中發現：Windows 原生的 Rust 工具鏈（windows-gnu）無法建置使用 `raw-dylib` 的 crate（`dlltool` 找不到 GNU 組譯器，也沒有 MSVC、MinGW 或 clang）；新建置的 .exe 會被公司的應用程式控制擋下；Windows 上沒有 Docker。WSL 中可以安裝建置工具、Rust 與 Docker Engine，也避開 Docker Desktop 的授權 |

### 第一版的範圍

| 功能 | 第一版 | 說明 |
|---|---|---|
| 註冊、登入、登出（Supabase Auth） | 範圍內 | 帳號名稱 3–32 個小寫英數字或連字號、以英文字母開頭；空資料庫上的第一個帳號成為管理員（取代 `/setup`） |
| 旅行列表、建立、編輯、刪除 | 範圍內 | 封面插畫、狀態（規劃中／已完成）；改日期沿用 `retimeByDayIndex()` 的規則 |
| 旅伴與車輛 | 範圍內 | 旅伴新增、編輯，管理者可移除未綁定帳號的旅伴；車輛的駕駛、座位數與乘客 |
| 地點清單 | 範圍內 | 「地點與車」的地點新增、改名、刪除（使用中不可刪） |
| 邀請連結 | 範圍內 | 單次使用、7 天有效；每趟最多 20 個有效連結，非管理者每人最多 5 個；登出狀態可以預覽並以連結註冊 |
| 行程表：規劃行程 | 範圍內 | 每天每台車一條路線、最多 6 個途中任務與任務類型；活動（含常用活動）；當天的料理；由規劃者填寫的預計抵達時間、當日標題與地點 |
| 行程表：文字版與複製 | 範圍內 | 由資料決定性產生（`itinerary_text()`）；格式維持現行行程繪本「複製文字」的樣子（已確認 5） |
| 料理菜單 | 範圍內 | 依日期與餐次、負責人、食材、料理範本與常用食材捷徑 |
| 採買清單 | 範圍內 | 分類、誰負責買、數量、已買勾選、由料理自動同步、未分配採買清單 |
| 裝備分工 | 範圍內 | 個人／共用、負責人、每人的打包勾選、未分配數量 |
| 出發清單 | 範圍內 | 自己的打包進度、負責的裝備與採買、下一個未完成的活動、確認出發 |
| 分帳記帳（基本） | 範圍內（已確認 2） | 支出、還款、餘額與建議轉帳，與其他項目一樣即時同步。資料只有兩張表（`app.expenses`、`app.settlements`）加分攤旅伴（`app.expense_participants`），計算是現行 `summarizeLedger()` 的直接移植（`lm-core::ledger`）。收據 AI 不在第一版 |
| 誰正在編輯（Presence） | 範圍內（已確認 3） | 卡片或列層級；提示性的鎖定，可以選擇「仍要編輯」；在被編輯的卡片或列上以圓形頭像呈現編輯者帳號顯示名稱的第一個字，最多 3 個加「+N」 |
| 收據 AI（OpenAI） | 之後 | 需要金鑰、費用控管與用量畫面 |
| 管理後台與稽核紀錄 | 之後 | 第一版的管理員只有「可管理任何旅行」的權限 |
| 註冊政策設定畫面 | 之後 | 第一版以環境變數 `LM_PUBLIC_SIGNUP` 代替 |
| `/demo/` 離線本機版與 Service Worker | 之後 | 第一版必須連線使用 |
| 匯出、匯入、列印 | 之後 | |
| 行程圖（動畫海報）與場景動畫 | 之後 | 第一版的插畫是靜態 SVG |
| 每日小語 | 之後 | |
| 小隊最近的動態 | 之後 | `app.trip_changes` 已保存每次提交，之後可以直接產生 |
| 淺色／深色主題切換、手機滑動手勢 | 之後 | CSS 已支援深色主題，之後加上切換即可 |
| 從現行 PostgreSQL 搬移資料 | 之後 | 第一版從空資料庫開始 |
| CI/CD、資安強化、QA 測試套件 | 之後 | 依使用者指示暫不處理 |

### 與現行行為的差異

| 項目 | 現行 | 第一版 | 原因 |
|---|---|---|---|
| 密碼長度 | 12–128 字 | 12–72 個字元，且 UTF-8 編碼不超過 72 位元組 | GoTrue 以 bcrypt 儲存密碼，72 是硬上限（[Supabase 討論 #34207](https://github.com/orgs/supabase/discussions/34207)） |
| 登入狀態 | HttpOnly cookie `ggc_session` | GoTrue 的 access token 與 refresh token，存在瀏覽器 localStorage | 加入 Realtime 私有頻道需要 JWT；這也是 supabase-js 的預設做法 |
| 「誰正在編輯」 | 只在行程繪本：欄位層級鎖定，3 秒輪詢；欄位下方以文字「{顯示名稱} 正在編輯」標示 | 所有分頁的卡片或列層級，最多每 6.5 秒更新一次，可以選「仍要編輯」；以圓形頭像呈現顯示名稱的第一個字，最多 3 個加「+N」 | [Realtime 限制](https://supabase.com/docs/guides/realtime/limits)每個用戶端每 30 秒 5 次 presence 呼叫；鎖定只是提示，同時編輯不會讓資料損壞；頭像是使用者確認的要求（已確認 3） |
| 打包勾選 | 伺服器允許管理者以整份 PUT 改別人的打包狀態（介面沒有這個操作） | 每個人都只能勾自己的 | 與介面一致，命令層級的權限也較單純 |
| 移除旅伴 | 介面沒有這個操作；伺服器規則禁止移除綁定帳號的旅伴 | 管理者可以移除未綁定帳號、沒有帳目的旅伴 | 新增的操作，沿用現有限制 |
| 第一位管理員 | `/setup` 頁面 | 空資料庫上註冊的第一個帳號 | 少一個頁面與一組 API |
| 文字版 | 行程繪本「複製文字」由畫面擷取（`src/storybook/app.js` 的 `copyItinerary()`）：活動與料理的備註接在同一行的最後；抵達行是繪本的自由文字；旅行名稱之後另有繪本的標語與說明，非採買停靠點可以有繪本的自訂品項 | 由 `lm-core` 直接從資料產生，格式維持現在的樣子，只有兩處改變：不是空白的備註在那筆活動或料理的下一行；抵達行由「預計幾點抵達」產生。繪本的標語、說明與停靠點自訂品項不輸出 | 行程繪本不在第一版；同一份資料永遠得到同一段文字；格式與兩處改變已確認（已確認 4、5） |
| 管理員未加入旅行時的分帳 | 讀不到 | API 仍然讀不到；Realtime 推送的變更集可能含分帳列，前端丟棄 | 頻道層級無法依列過濾；管理員本來就能管理整趟旅行 |
| 車輛的舊出發欄位 `meeting`，以及繪本專用欄位（標語、範本、停靠點自訂品項、抵達說明） | 有 | 無 | 第一版從空資料庫開始，行程繪本也不在範圍內 |
| 網址 | `/<帳號名稱>/home`、`/<帳號名稱>/trips/<id>` | 相同；出發清單為 `/<帳號名稱>/trips/<id>/go` | 沿用 |

### 已確認的問題

原本列為待確認的四個問題，使用者都已回覆；之後使用者看過 A10 與現行文字版的差異，另外決定了文字版的格式（第 5 點）。設計依下列決定撰寫，後文以「已確認 N」引用。

1. **登入（已確認）**：沿用「帳號名稱 + 密碼」，以合成 email 對應到 Supabase Auth（D9、架構選項 A7）。風險 R3 與它的緩解方式維持原設計。
2. **分帳記帳（已確認）**：放進第一版，包含支出、還款、餘額與建議轉帳（範圍表、`lm-core::ledger`、分帳命令、`app.expenses` 等資料表、屬性 15）。收據 AI 仍在之後。
3. **Presence（已確認）**：採提示性鎖定，可以選「仍要編輯」。使用者另外要求：以圓形頭像顯示正在編輯的人，頭像內是帳號**顯示名稱**的第一個字，例如「陳小明」顯示「陳」（D13、「誰正在編輯：Presence 與頭像」、元件 4.5、演算法 A13、屬性 18 與 19）。Presence 用顯示名稱是使用者的選擇；旅行中其他畫面照舊顯示旅伴名稱。
4. **文字版（已確認）**：活動與料理的備註另起一行；抵達行由「預計幾點抵達」產生（演算法 A10）。
5. **文字版維持現在的格式（已確認）**：使用者的決定是「維持現在的格式」，也就是現行行程繪本「複製文字」複製的文字：`src/storybook/app.js` 的 `renderItinerary()` 畫出、`copyItinerary()` 逐行擷取的文字，資料由 `src/storybook-adapter.js` 的 `project()` 整理。與現行的差異只有第 4 點的兩處改變；包括依每日設定的路線位置把路線放在活動之前或之後，其他行的格式與順序都不變（演算法 A10）。

## Architecture

### 系統組成

```mermaid
flowchart LR
  subgraph Browser["瀏覽器（每位旅伴、每個分頁）"]
    W["lm-web<br/>Leptos CSR（wasm32）"]
  end
  subgraph Host["開發機的 WSL 2（Ubuntu）或自架主機"]
    S["lm-server（axum）<br/>/api/*、前端靜態檔、/realtime/v1/websocket 轉送"]
    subgraph SB["Supabase（Docker，只綁 127.0.0.1）"]
      G["API gateway :54321"]
      A["Auth（GoTrue）"]
      R["Realtime"]
      DB[("PostgreSQL :54322<br/>schema app、realtime.messages")]
      ST["Studio（開發用）"]
      PR["PostgREST（App 不使用）"]
    end
  end
  W -- "HTTP JSON：/api/*" --> S
  W -- "WebSocket：/realtime/v1/websocket" --> S
  S -- "sqlx 交易" --> DB
  S -- "GoTrue REST：建立帳號、密碼登入、換發、登出" --> G
  S -- "WebSocket 轉送（補上 apikey）" --> G
  G --> A
  G --> R
  G --> PR
  A --> DB
  R -- "讀取 realtime.messages 的 WAL；以 RLS 檢查頻道權限" --> DB
  ST --> DB
```

### 元件職責

| 元件 | 語言／執行環境 | 職責 | 不做的事 |
|---|---|---|---|
| `lm-web` | Rust → wasm32（Leptos CSR） | 畫面、表單檢查、樂觀更新、Realtime 訂閱與重新同步、Presence 與編輯者頭像 | 不直接連資料庫；不計算會被儲存的衍生資料 |
| `lm-server` | Rust（axum、sqlx、tokio） | 驗證 JWT；代理註冊、登入與換發；執行命令（權限、驗證、衍生資料）；快照與增量變更；邀請；轉送 Realtime WebSocket；提供前端靜態檔 | 不保存登入狀態（由 GoTrue 負責） |
| `lm-core` | Rust（native 與 wasm32） | 型別、命令、權限、`apply()`、採買同步、文字版、日期變更、分帳、`Replica` 合併、Presence 節流、編輯者頭像（字、顏色、堆疊） | 不做 IO |
| `lm-supabase` | Rust | Realtime 協定與連線狀態機、GoTrue REST、JWT 驗證 | 不含應用規則 |
| PostgreSQL（Supabase） | | `app` schema 的資料表與外鍵、`trip_changes` 的 trigger、`realtime.messages` 的 RLS 政策 | 不放商業規則；CHECK 與外鍵只是最後防線 |
| Auth（GoTrue） | | 帳號、密碼、JWT 的簽發與換發 | |
| Realtime | | 私有頻道、由資料庫發出的 broadcast、presence | |
| API gateway（CLI 為 Kong；自架新版預設為 Envoy） | | 把 `/auth/v1`、`/realtime/v1` 轉給各服務 | 只綁 127.0.0.1 |
| Studio、postgres-meta | | 開發時檢視資料 | 第一版的程式不依賴 |
| PostgREST | | 堆疊內建，App 不使用 | `app` schema 不在 `api.schemas` |

### 寫入路徑

```mermaid
sequenceDiagram
  autonumber
  participant A as 旅伴 A（lm-web）
  participant S as lm-server
  participant DB as PostgreSQL
  participant RT as Realtime
  participant B as 旅伴 B（lm-web）
  A->>A: apply(Predict) 預測主要效果，放進 pending；只重繪這一列
  A->>S: POST /api/trips/{id}/commands { command_id, command }
  S->>DB: BEGIN；SELECT … FROM app.trips WHERE id = $1 FOR UPDATE
  S->>DB: 讀取成員資格（非成員 404）；依 command_id 查重；讀取整趟旅行的列
  S->>S: lm_core::apply(Commit)：權限、驗證、主要效果、採買同步
  S->>DB: 寫入變更列（version = seq + 1）；UPDATE trips SET seq；INSERT app.trip_changes
  DB-->>DB: AFTER INSERT trigger：realtime.send(changeset, 'changeset', 'trip:{id}', true)
  S->>DB: COMMIT
  S-->>A: 200 { seq, changeset }
  A->>A: Replica 合併 changeset、移除 pending、重算 overlay
  RT->>DB: 讀取 realtime.messages 的 WAL
  RT-->>B: broadcast（event = changeset）
  B->>B: Replica 合併；只更新版本較新的列
```

伺服器以旅行列的鎖把同一趟旅行的命令串成一條線，因此 `seq` 嚴格遞增、沒有空號，也就是「提交順序」。鎖只持有一個命令的時間（讀取、計算、寫入，約數十毫秒），不同旅行之間互不等待。

### 即時推送與重新同步

```mermaid
sequenceDiagram
  autonumber
  participant C as lm-web
  participant S as lm-server
  participant RT as Realtime（經 lm-server 轉送）
  C->>RT: 連線 /realtime/v1/websocket?vsn=1.0.0
  C->>RT: phx_join "realtime:trip:{id}"（private、presence key、access_token）
  RT-->>C: phx_reply ok（RLS 已確認是成員）
  alt 記憶體中已有這趟旅行的 Replica（水位線 W）
    C->>S: GET /api/trips/{id}/changes?after=W
    S-->>C: { head, changesets } 或 { head, snapshot_required }
  else 第一次開啟，或 snapshot_required
    C->>S: GET /api/trips/{id}/snapshot
    S-->>C: { seq, viewer, rows }
  end
  C->>C: 合併（版本較大者勝，重複與亂序都無害）
  RT-->>C: broadcast changeset（seq = n）
  opt n > 水位線 + 1（中間有遺失）
    C->>S: GET /changes?after=水位線
  end
  Note over C,RT: heartbeat 每 20 秒，20 秒內沒有回覆就關閉連線；phx_join 10 秒內沒有回覆也算失敗；依 1、2、5、10 秒（加 0–20% 抖動）退避重連，重新 join 後再補齊
  Note over C,S: 分頁回到前景、恢復上線、或每 60 秒：GET /head，比水位線新就補齊
```

先加入頻道、再讀快照或增量，是為了不留空窗：在加入之後提交的變更會推送過來，在讀取之前提交的變更在回應裡；兩者重疊的部分由版本合併去除。broadcast 最多送達一次，而且資料庫在沒有任何連線者時發出的訊息會被丟棄（[Supabase 的說明](https://supabase.com/kb/troubleshooting/realtime-warn-sending-broadcast-message)：`realtime.send()` 此時只記錄 `WarnSendingBroadcastMessage` 警告，不會讓交易失敗），所以正確性靠水位線、跳號偵測與 `head` 比對，不靠推送本身。

### 前端資料流

```mermaid
flowchart LR
  UI["元件事件<br/>例如勾選已買"] -->|"submit(Command)"| E["TripSync"]
  E -->|"apply(Predict)"| P["pending 佇列"]
  R["Replica<br/>confirmed + 水位線"] --> O["overlay<br/>confirmed ⊕ pending"]
  P --> O
  O -->|"只對變更的鍵"| S["RowStore<br/>每列一個 signal"]
  S --> V["以鍵追蹤的 For 與列元件"]
  E -->|"POST commands（一次一個）"| API[("lm-server")]
  API -->|"ChangeSet 或拒絕"| R
  RT[("Realtime 頻道")] -->|"broadcast changeset"| R
  RT -->|"presence_state / presence_diff"| PR["Presence 狀態"]
  PR -->|"editor_stacks()"| ED["編輯者頭像<br/>依編輯對象分組"]
  ED -->|"只對堆疊改變的對象"| V
```

### 誰正在編輯：Presence 與頭像

使用者確認採用提示性的鎖定（已確認 3），並要求以圓形頭像顯示正在編輯的人：頭像內是帳號**顯示名稱**（`app.profiles.display_name`）的第一個字，例如「陳小明」顯示「陳」。

```mermaid
sequenceDiagram
  autonumber
  participant A as 陳小明的分頁（lm-web）
  participant RT as Realtime（trip:{id}）
  participant B as 林大華的分頁（lm-web）
  A->>A: 開啟「晚餐：暖暖壽喜燒」料理卡片的表單
  A->>RT: track { user, display_name: "陳小明", person, editing: (meal, id) }（經 PresenceThrottle）
  RT-->>B: presence_diff（joins）
  B->>B: editor_stacks()：依編輯對象分組；同一帳號只算一次；不含自己；依帳號 id 排序
  B->>B: 只有這張料理卡片顯示頭像「陳」（底色由陳小明的帳號 id 決定）
  A->>A: 關閉表單
  A->>RT: track { …, editing: None }
  RT-->>B: presence_diff
  B->>B: 頭像消失
```

畫面示意（四個人同時開著同一張料理卡片時，第五個人看到的樣子）：

```
┌────────────────────────────────────────────────────┐
│ 晚餐：暖暖壽喜燒                  (陳)(林)(王)(+1) │  ← 依帳號 id 排序；滑鼠移上去顯示完整名稱
│ 負責人：小雨                                       │  ← 其他資訊照舊顯示旅伴名稱
└────────────────────────────────────────────────────┘

開啟這張卡片的表單時：
┌────────────────────────────────────────────────────┐
│ 陳小明 等 4 人正在編輯這一項            [仍要編輯] │
│ （欄位先是唯讀；按「仍要編輯」後照常編輯）         │
└────────────────────────────────────────────────────┘
```

| 項目 | 設計 |
|---|---|
| Presence 內容 | 每個分頁 track `{ user, display_name, person, editing }`。`display_name` 是帳號的顯示名稱，取自快照的 `viewer`；`person` 只用來把變更者對應到旅伴名稱 |
| 頭像的字 | 在用戶端由顯示名稱算出：去除前後空白後的第一個擴充字素叢集（extended grapheme cluster，以 `unicode-segmentation` 切分），所以 emoji 序列、國旗與組合字元不會被切開；修剪後是空的時候改用中性符號「・」 |
| 頭像顏色 | 由帳號 id 決定：以 FNV-1a 雜湊 id 的 16 個位元組，再查 12 色的色盤，所以同一個帳號在每趟旅行、每個分頁、每台裝置與每次登入都是同一色。每一色的文字色在設計時選好，對比 5.41–7.26:1（至少 4.5:1） |
| 位置與堆疊 | 顯示在正在被編輯的卡片或列上。多人時依帳號 id 排序（每個人看到的順序相同），最多 3 個頭像，其餘以「+N」表示；同一帳號的多個分頁只算一次；不顯示自己 |
| 無障礙 | 頭像不是唯一的訊號：每個頭像有無障礙名稱，例如「陳小明 正在編輯」，滑鼠提示顯示完整的顯示名稱；「+N」的名稱列出其餘的人；開啟表單時以文字顯示誰正在編輯，觸控與鍵盤使用者不必靠滑鼠提示 |
| 名稱的分工 | Presence（頭像、提示、「正在編輯」的文字）用帳號的顯示名稱，這是使用者的選擇；旅行中的其他地方（負責人、參加者、打包、分帳、「剛更新了這一項」）照舊顯示旅伴名稱 |

型別在「Components and Interfaces」1.7，畫面在 4.5，演算法在 A13。

### 本機開發

開發在 Windows 的 WSL 2（Ubuntu）中進行（D14）。Repository 留在 Windows 的磁碟 `d:\path\to\little-moments`，在 WSL 中的路徑是 `/mnt/d/path/to/little-moments`；cargo、trunk、docker 與 Supabase CLI 都在 WSL 中、從這個目錄執行，瀏覽器與 git 留在 Windows。

拓撲（瀏覽器在 Windows，其餘都在 WSL 中）：

```
瀏覽器 ── http://127.0.0.1:8081 ──▶ trunk serve（改畫面時用；/api 與 /realtime 代理到 8080）
瀏覽器 ── http://127.0.0.1:8080 ──▶ lm-server（也直接提供 crates/web/dist）
lm-server ── sqlx ──────────────▶ 127.0.0.1:54322（PostgreSQL）
lm-server ── HTTP 與 WebSocket ─▶ 127.0.0.1:54321（API gateway → Auth、Realtime）
```

瀏覽器的兩條連線經 WSL 的 localhost 轉送，到達 WSL 中的 8081 與 8080；lm-server 與 Supabase 之間的連線都在 WSL 之內。

在 WSL 中的步驟：

```bash
# 一次性
sudo apt update && sudo apt install -y build-essential pkg-config libssl-dev   # C 工具鏈；native-tls 在 Linux 使用 OpenSSL
# 依 https://rustup.rs 安裝 rustup；rust-toolchain.toml 指定 stable、wasm32 目標、rustfmt 與 clippy
rustup target add wasm32-unknown-unknown
cargo install trunk --locked
# 依 Docker 文件在 Ubuntu 安裝 Docker Engine（不使用 Docker Desktop），並完成讓使用者不必 sudo 就能執行 docker 的安裝後步驟
# Supabase CLI 固定使用 3.2.0 的 Linux 版：把 GitHub Releases 上 v3.2.0 的 Linux 執行檔放在 ~/.local/bin
docker network create -o "com.docker.network.bridge.host_binding_ipv4=127.0.0.1" lm-local

# 每次開發
export CARGO_TARGET_DIR="$HOME/.cache/lm-target"   # 建置輸出放在 Linux 檔案系統；也可以寫進 ~/.bashrc
cd /mnt/d/path/to/little-moments
supabase start --network-id lm-local        # 之後以 docker ps 確認埠顯示為 127.0.0.1:543xx
supabase db reset                           # 套用 supabase/migrations（會清空本機資料）
supabase status -o env                      # 取得 API URL、anon／service_role key、JWT secret，填入 .env
cargo run -p lm-server                      # Windows 的瀏覽器開啟 http://127.0.0.1:8080
trunk serve --poll --config crates/web/Trunk.toml  # 需要即時重載畫面時；--poll 的原因見下方
```

在 Windows 的 PowerShell 中：

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp   # 確認 54321、54322 與 54323 不在保留範圍內
# git 的每個指令（status、add、commit 等）也只在這裡執行
```

- `docker network create` 與 `--network-id` 是 [Supabase 本機開發文件](https://supabase.com/docs/guides/resources/supabase-cli/local-development) 建議的做法，讓 CLI 堆疊只綁 127.0.0.1（B12）。Supabase 也說明 CLI 堆疊沒有加固、使用預設憑證，不可對外開放。
- WSL 2 預設的 NAT 網路模式會把 WSL 中監聽的埠轉送到 Windows 的 localhost（[Accessing network applications with WSL](https://learn.microsoft.com/en-us/windows/wsl/networking)），所以 Windows 的瀏覽器可以開啟 `http://127.0.0.1:8081` 與 `http://127.0.0.1:8080`；區網中的其他電腦連不到這些只綁 127.0.0.1 的埠，只綁 127.0.0.1 的規則（B12）照樣成立。
- 轉送的埠也綁在 Windows 上，所以仍要檢查 Windows 的 Hyper-V 保留埠範圍：它可能包含 543xx（[CLI issue #4128](https://github.com/supabase/cli/issues/4128) 是 Windows 上的例子）；遇到時在 PowerShell 以 `netsh interface ipv4 show excludedportrange protocol=tcp` 確認，並在 `supabase/config.toml` 改埠，同時修改 `.env` 的 `SUPABASE_URL` 與 `DATABASE_URL`。
- `/mnt/d` 上的檔案要經過 WSL 與 Windows 之間的檔案系統轉譯，大量小檔案的讀寫很慢（[Working across file systems](https://learn.microsoft.com/en-us/windows/wsl/filesystems)），所以 `CARGO_TARGET_DIR` 指向 Linux 檔案系統中的目錄。它以環境變數設定，不寫進 Repository 的 `.cargo/config.toml`。
- 在 Windows 中修改 `/mnt/d` 的檔案時，WSL 中的程式收不到檔案變更的通知（inotify），`trunk serve` 因此不會自動重建；加上 `--poll`（[trunk 的 watch 選項](https://github.com/trunk-rs/trunk/blob/main/src/cmd/watch.rs)）改以輪詢偵測變更，預設每 5 秒一次。cargo 依檔案的修改時間判斷要不要重建，不受影響。
- git 只在 Windows 的 PowerShell 執行，不在 WSL 中執行：Windows 的 git 使用 `core.autocrlf`，在 WSL 中以 Linux 的 git 操作同一個工作目錄，會因為行尾的設定不同而把檔案看成已修改。
- 區網測試（手機）需要讓 `lm-server` 綁定非 loopback 位址。只要 `lm-server` 偵測到它使用的是 CLI 的範例 JWT 密鑰或範例金鑰，就拒絕在非 loopback 位址啟動（見「設定與啟動檢查」）。區網測試因此要改用自架 Docker Compose，並以 `utils/generate-keys.sh` 產生新的密鑰；這屬於部署階段，第一版只在本機開發。

### Repository 配置

```
little-moments/                      （分支 rust-supabase-rewrite）
├── Cargo.toml                        # [workspace]：members = crates/*；default-members 不含 web；exclude = [".worktrees"]
├── rust-toolchain.toml               # stable、wasm32-unknown-unknown、rustfmt、clippy
├── .cargo/config.toml                # wasm32 目標的 getrandom 後端設定
├── .env.example                      # lm-server 的環境變數名稱（不含真實值）
├── crates/
│   ├── core/       lm-core           # 型別、命令、權限、apply、採買同步、文字版、分帳、Replica、Presence 與頭像（native + wasm32）
│   │   └── tests/                    # golden 測試（由 tests/*.test.js 的案例移植）與 proptest；fixtures/example-itinerary.txt 是文字版的預期輸出
│   ├── supabase/   lm-supabase       # features：server（GoTrue、JWT）、web（瀏覽器 WebSocket 傳輸）
│   ├── server/     lm-server         # bin：little-moments-server
│   └── web/        lm-web            # Trunk.toml、index.html、styles/、assets/art/
├── supabase/
│   ├── config.toml                   # supabase init 產生後調整（見下）
│   ├── migrations/
│   │   ├── 20260101000000_app_schema.sql
│   │   ├── 20260101000100_realtime_authorization.sql
│   │   └── 20260101000200_publish_changes.sql
│   └── seed.sql                      # 空檔；第一版從空資料庫開始
├── scripts/export-art.mjs            # 一次性：把 src/art.js、src/dish-art.js 輸出為靜態 SVG，結果提交到 crates/web/assets/art/
└── src/、server/、migrations/、tests/、package.json …   # 現行 Bun 版，保留作為行為參考
```

```toml
# Cargo.toml（workspace）
[workspace]
resolver = "2"
members = ["crates/core", "crates/supabase", "crates/server", "crates/web"]
# lm-web 只以 trunk 建成 wasm32；cargo build／test 預設不建它
default-members = ["crates/core", "crates/supabase", "crates/server"]
# 不讓 workspace 碰到舊的 worktree
exclude = [".worktrees"]

[workspace.package]
edition = "2021"
version = "0.1.0"
publish = false

[profile.release]
lto = true
codegen-units = 1

# 只讓前端 crate 以體積為優先；trunk 另以 wasm-opt（index.html 的 data-wasm-opt="z"）縮小輸出
[profile.release.package.lm-web]
opt-level = "z"
```

```toml
# supabase/config.toml（只列與預設不同或需要說明的項目）
[api]
port = 54321
schemas = ["public", "graphql_public"]   # 不含 app，PostgREST 看不到應用資料表

[db]
port = 54322

[studio]
enabled = true                           # 開發時檢視資料

[realtime]
enabled = true

[auth]
site_url = "http://127.0.0.1:8080"
enable_signup = false                    # 直接向 Auth 自行註冊一律被拒；帳號只能由 lm-server 以 admin API 建立（需求 3.13）
jwt_expiry = 3600                        # access token 3600 秒（需求 4.4）
enable_refresh_token_rotation = true     # 換發時輪替 refresh token（需求 4.4）
refresh_token_reuse_interval = 10        # 10 秒內以同一個 refresh token 重複換發仍得到有效的 Session，多個分頁同時換發不會互相登出（需求 4.4、4.7）

[auth.email]
enable_confirmations = false             # 合成 email 不寄信；admin API 建立時直接設為已確認（需求 3.1、3.13）

[storage]
enabled = false

[edge_runtime]
enabled = false

[analytics]
enabled = false

[local_smtp]                             # 較舊的 CLI 版本名稱為 [inbucket]
enabled = false
```

`.gitignore` 新增 `/target`、`/crates/web/dist`、`/supabase/.branches`、`/supabase/.temp`、`.env`。

保留 Bun 版的理由：移植規則時要逐條對照 `server/accounts.js`、`src/ingredients.js`、`src/itinerary-*.js` 與 `src/expense-model.js`，既有的 `tests/*.test.js` 也是 golden 測試案例的來源；Cargo 與 Bun 的檔案互不影響。等 Rust 版達到功能對等，再另外決定是否移除。

### 架構選項

#### A1：商業規則放在哪裡

| 選項 | 做法 | 優點 | 缺點 | 結論 |
|---|---|---|---|---|
| (a) 用戶端直連 Supabase | lm-web 以 PostgREST 讀寫、以 Postgres Changes 接收；規則寫成 RLS、SQL 函式、trigger 與 RPC | 少一個服務；是 Supabase 的典型用法 | 規則要以 SQL／PL/pgSQL 撰寫：約 25 條權限、受邀旅伴的限制、`syncMealIngredients()` 的 NFKC 切分與分類、邀請只能用一次。這些不是 Rust，也無法與前端共用；RLS 要對每張表寫「誰能讀、誰能改哪些欄位」，和命令層級的規則重複 | 不採用 |
| (b) Rust 後端是唯一寫入者 | lm-server 驗證 GoTrue 的 JWT 並執行命令；Realtime 只負責推送 | 規則只有一份 Rust 實作，伺服器與前端共用；可用 proptest 驗證；資料表不必公開給 PostgREST | 多一個服務要執行；JWT 驗證與 Supabase 用戶端要自己寫 | **採用** |
| (c) PL/Rust | 規則寫成 Postgres 內的 Rust 函式 | 規則在資料庫內，也是 Rust | 自架要自行建置含 plrust 的 Postgres 映像與工具鏈；除錯與部署成本高 | 不採用 |
| (d) Edge Functions | 規則寫成 Deno 函式（可以載入 Rust 編的 wasm） | 不必自己維護 HTTP 服務 | 執行環境是 Deno；第一版也不需要 Edge Runtime 服務 | 不採用 |

「全部用 Rust」與「服務數量少」之間的取捨：(b) 多一個 Rust 程序，但 Supabase 堆疊本身已有十個左右的容器，多一個服務的成本小；換來的是規則、衍生資料與權限只有一份可測試的實作。

#### A2：推送機制

| 選項 | 授權 | 刪除事件 | 內容 | 與交易一致 | 結論 |
|---|---|---|---|---|---|
| [Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes)（publication `supabase_realtime`） | 每個變更對每位訂閱者各做一次 RLS 檢查，單執行緒處理 | Supabase 文件說明 RLS 不套用到 DELETE；沒有 `replica identity full` 時 DELETE 無法過濾，其他旅行的訂閱者也會收到（只含主鍵） | 原始資料表欄位；一個命令改了幾列就是幾則訊息，客戶端看得到中間狀態；聚合列（例如路線與停靠點）要在客戶端重組 | 是 | 不採用 |
| [Broadcast from Database](https://supabase.com/docs/guides/realtime/broadcast)，`realtime.send()` | 私有頻道；加入時以 `realtime.messages` 的 RLS 檢查，連線期間快取（[Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization)） | 只送到該旅行的頻道 | 由我們決定：一個命令一則 `changeset`，含衍生變更與版本 | 是（`realtime.messages` 的寫入在同一個交易中） | **採用** |
| `realtime.broadcast_changes()` 逐表 trigger | 同上 | 只送到該旅行的頻道 | 每列一則，格式固定為操作與 NEW/OLD | 是 | 不採用：一個命令會拆成多則訊息 |
| lm-server 提交後呼叫 Realtime REST broadcast | 同上 | 同上 | 由我們決定 | 否：提交成功但呼叫失敗時會漏推 | 不採用 |
| Broadcast replay 作為補齊手段 | | | 每次最多 25 則、保存 72 小時，目前只有 supabase-js 2.74 以後支援 | | 不採用；補齊改用自己的 `app.trip_changes` |

#### A3：前端框架

| 框架 | 更新模型 | 對本專案的影響 | 結論 |
|---|---|---|---|
| Leptos 0.8 | 細粒度 signal；`<For>` 以鍵追蹤，沒變的列不會重新執行 | 每列一個 signal，變更只更新那一列的 DOM（B2）；CSR 以 trunk 建置；社群的 [`csr-example-leptos-supabase`](https://github.com/leptos-community/csr-example-leptos-supabase) 示範了以 REST 直接呼叫 GoTrue | **採用** |
| Dioxus | 虛擬 DOM 加 signal；元件重新執行後比對 | 也做得到，但每次更新仍要比對元件樹；強項是桌面與行動裝置，第一版用不到；建置工具是 `dx` | 不採用 |
| Yew | 類似 React 的虛擬 DOM，以元件為單位重繪 | 要靠 `PartialEq` 與 memo 手動避免重繪；近年更新較慢 | 不採用 |

#### A4：Supabase 用戶端

| 選項 | 說明 | 結論 |
|---|---|---|
| 官方函式庫 | [Supabase 官方用戶端](https://supabase.com/docs/guides/api/rest/client-libs)只有 JavaScript/TypeScript、Dart/Flutter、Swift、Python 與 C#；社群列表也沒有 Rust | 不存在 |
| 社群 crate | 例如 `supabase-community/postgrest-rs`，以及數個實作 Phoenix Channels 的 Realtime crate（如 [`supabase-realtime-rs`](https://github.com/scaraude/supabase-realtime-rs)）。成熟度不一；查到的 Realtime crate 以 tokio 與 native-tls 實作、標示 Beta、沒有自動換發 JWT，無法直接編成 wasm32 | 不採用；之後若有支援 wasm32 的成熟 crate，可以在 trait 後面替換 |
| 自寫精簡用戶端 | 用到的介面很小：伺服器端的 GoTrue 5 個 REST 端點與 JWKS；瀏覽器端 Realtime 協定 1.0.0（JSON 文字訊框）的 `phx_join`、`phx_leave`、`heartbeat`、`access_token`、`presence` track，以及接收 `broadcast`、`presence_state`、`presence_diff`、`phx_reply`、`phx_error`、`phx_close`、`system`。寫入改走 lm-server，所以不需要 PostgREST 用戶端 | **採用**，放在 `lm-supabase`，以 `AuthBackend`、`RealtimeTransport` 兩個 trait 隔離 |

這是明確的風險（R1）：協定若改版，要自己跟進。緩解方式是協定細節集中在 `lm-supabase::realtime::protocol`，訊框的編解碼與連線狀態機都是不碰瀏覽器的純 Rust，可以在原生環境做單元測試；[Supabase 的 Realtime 協定文件](https://supabase.com/docs/guides/realtime/protocol)列出了每種事件、錯誤碼與建議的重連間隔。

#### A5：本機 Supabase

| 選項 | 優點 | 缺點 | 結論 |
|---|---|---|---|
| Supabase CLI 本機堆疊 | 在 WSL 2 中只要放一個 Linux 執行檔（固定 3.2.0），使用 WSL 中的 Docker Engine；`supabase db reset` 套用遷移；`config.toml` 可以關閉不需要的服務 | 使用公開已知的範例金鑰；官方說明它沒有加固，不可對外開放 | **開發用**，配合只綁 127.0.0.1 的 Docker 網路 |
| [自架 Docker Compose](https://supabase.com/docs/guides/self-hosting/docker) | 與日後部署相同；`utils/generate-keys.sh` 產生新密鑰；可移除 Storage、imgproxy、Edge Runtime 等服務 | 手動步驟較多；沒有遷移工具 | 部署階段（不在第一版）；遷移檔是純 SQL，兩者都能套用 |

第一版需要的服務：PostgreSQL、Auth、Realtime、API gateway；Studio 與 postgres-meta 只為了開發時檢視資料。PostgREST 是堆疊內建的，App 不使用。Storage、imgproxy、Edge Runtime、Analytics（Logflare、Vector）與本機郵件服務都關閉。

#### A6：並行與合併

| 選項 | 結論與理由 |
|---|---|
| 保留整份文件加版本號 | 不採用：這正是目前的問題 |
| CRDT（例如 Automerge、Yrs） | 不採用：資料多半是短欄位與勾選；權限與衍生資料仍要在伺服器檢查；CRDT 文件很難對應到關聯式資料表與外鍵 |
| OT | 不採用：沒有多人同時編輯的長篇文字 |
| 每趟旅行串行化的命令、列版本、欄位層級 patch | **採用**：伺服器以 `SELECT … FOR UPDATE` 鎖住旅行列，命令依提交順序取得 `seq`；同一欄位後提交者生效；不同欄位、不同列互不影響；客戶端以版本合併 |

#### A7：登入身分

| 選項 | 說明 | 缺點 | 結論 |
|---|---|---|---|
| 帳號名稱加合成 email | `lm-server` 以 GoTrue admin API 建立 `<username>@<LM_AUTH_EMAIL_DOMAIN>` 並設 `email_confirm: true`，登入時把帳號名稱換成同一個 email。網域預設 `users.little-moments.invalid`：`.invalid` 是 RFC 6761 保留的網域，永遠不會解析，日後即使開啟郵件也不會寄到別人手上 | GoTrue 的 email 格式檢查若拒收這個網域，要改設為操作者自己控制的網域（R3）；沒有重設密碼 | **採用**（已確認 1）：保留現行體驗，不需要 SMTP |
| email 加密碼 | Supabase Auth 的原生流程，之後可以加重設密碼 | 要有 SMTP 才有實質好處，而且改變登入體驗 | 不採用（已確認 1）；只有在 R3 發生、而且找不到可用的網域時才回頭討論 |

## Components and Interfaces

本節列出每個 crate 的模組、型別與函式介面；演算法本體在「Algorithmic Pseudocode」，前置與後置條件在「Key Functions with Formal Specifications」。

### 1. `lm-core`（共用規則，不做 IO）

#### 1.1 模組

| 模組 | 內容 | 移植來源 |
|---|---|---|
| `ids` | UUID newtype（`TripId`、`PersonId` …）、`IdSource` | `uid()` |
| `text` | `trim_white`（Unicode White_Space）、`is_js_whitespace`、`trim_js_whitespace`、`collapse_js_whitespace`（JS_Whitespace：與 JavaScript 的 `\s` 相同，U+FEFF 算空白、U+0085 不算）、`char_count`、`has_control_chars`、`participant_name`、`participant_key`、`place_key`、`clean_text`、`normalize_time_input` | `src/itinerary-model.js`、`src/model.js`、`src/ingredients.js` 的 `keyOf()` |
| `time` | `Hm`（HH:MM）、`date_range`、`date_text`（`10/20（週二）`）、`chinese_numeral`、`duration_text` | `src/itinerary-model.js`、`dateRange()` |
| `model` | 列型別、列舉、`Row`、`Entity`、`RowKey`、`TripState` | `isValidState()` 的欄位 |
| `limits` | 所有數量與長度上限 | 各處常數 |
| `rules` | `Capabilities`、`capabilities()`、`authorize()`、`my_gear()`、`can_depart()`、`progress()`、`unassigned_gear()` | `server/accounts.js`、`src/model.js` |
| `command` | `Command` 與各種 Patch、Draft | 新增 |
| `apply` | `apply()`、`diff()`、各命令的處理函式 | `putTrip`、`checkTrip`、`src/itinerary-edits.js`、`src/app.js` 的表單儲存 |
| `ingredients` | `parse_ingredients`、`ingredient_key`、`classify_ingredient`、`sync_meal_ingredients`、`remove_ingredient_from_meals` | `src/ingredients.js` |
| `recipes` | `RECIPE_TEMPLATES`、`COMMON_INGREDIENTS`、`merge_ingredients`、`infer_dish_kind`、`PERSONAL_GEAR_GROUPS` | `src/recipes.js`、`src/gear-presets.js` |
| `itinerary` | `ACTIVITY_CATEGORIES`、`presets_for`、`STOP_KINDS`、`STOP_TASK_KINDS`、`meal_time`、`meal_title`、`sorted_routes`（依出發時間，只給路線卡片，需求 22.2）、`day_routes_by_ordinal`（依建立順序，給文字版，需求 31.5）、`day_events`、`shopping_plan`、`place_usages`、`destination_conflict` | `src/itinerary-model.js`、`src/itinerary-derive.js` |
| `itinerary_text` | `itinerary_text()` | 現行行程繪本「複製文字」：`src/storybook/app.js` 的 `renderItinerary()` 與 `copyItinerary()`，資料來自 `src/storybook-adapter.js` 的 `project()`（已確認 5） |
| `dates` | `retime_by_day_index()`、`shorten_blocked_message()` | `src/itinerary-dates.js` |
| `ledger` | `parse_amount`、`format_money`、`split_evenly`、`summarize`、`EXPENSE_CATEGORIES`、`suggest_expense_category` | `src/expense-model.js`、`src/expense-categories.js` |
| `validate` | `validate::state(state, mode)`：跨列的不變式 I1–I12（`Mode::Predict` 不檢查 I9）；`Violation::into_rejection()`（需求 9.16） | `isValidState()`、`validateItinerary()` |
| `sync` | `Effect`、`Change`、`ChangeSet`、`Broadcast`、`Snapshot`、`Replica`、`overlay()` | 新增 |
| `presence` | `EditTarget`、`PresenceMeta`、`PresenceThrottle`；編輯者頭像：`avatar_initial`、`avatar_color`、`AVATAR_PALETTE`、`editor_stacks`、`EditorStack` | 新增 |
| `api` | HTTP 請求與回應型別、錯誤代碼 | 新增 |

`lm-core` 只依賴 `serde`、`serde_json`、`serde_with`、`uuid`、`chrono`（不啟用 clock）、`unicode-normalization`、`unicode-segmentation`（頭像取第一個字素叢集）、`regex`、`indexmap`、`thiserror`；測試另加 `proptest`。它同時編成原生與 wasm32，所以不能用執行緒、系統時間或檔案。

#### 1.2 資料型別

```rust
// crates/core/src/model.rs（節錄）
use std::collections::{BTreeMap, BTreeSet};
use chrono::NaiveDate as Date;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 每趟旅行的提交序號，也是列的版本（最後修改這一列的 seq）。
pub type Seq = u64;

macro_rules! id_types {
    ($($name:ident),* $(,)?) => {$(
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub Uuid);
    )*};
}
id_types!(UserId, TripId, PersonId, VehicleId, PlaceId, RouteId, StopId, ActivityId,
          MealId, ShoppingId, GearId, ExpenseId, SettlementId, CommandId, ClientId);

/// 24 小時制時刻，以 0..1440 的分鐘數儲存；序列化為 "HH:MM"。
/// 解析時沿用 normalizeTimeInput()：先去除前後空白，再把全形數字與冒號折疊成半形。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Hm(u16);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TripCard {
    pub id: TripId,
    pub title: String,          // 1–100 字，不含 U+0000
    pub destination: String,    // 0–100 字
    pub start: Date,
    pub end: Date,              // start..=end 為 1–31 天
    pub description: String,    // 0–1000 字
    pub note: String,           // 0–1000 字
    pub cover: CoverKind,       // camp、mountain、lake、night、forest、beach、sunrise
    pub status: TripStatus,     // planning、completed
    pub version: Seq,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Person {
    pub id: PersonId,
    pub name: String,           // normalizeParticipantName() 之後 1–30 字；participant_key 不可重複
    pub role: String,           // 0–60 字
    pub color: Color,           // coral、blue、green、yellow、lavender、peach
    pub bound: bool,            // 是否綁定帳號（由 app.people.user_id 推得；不送出帳號 id）
    pub ordinal: u64,           // 建立順序
    pub version: Seq,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Vehicle {
    pub id: VehicleId,
    pub name: String,                     // 1–50 字
    pub driver: Option<PersonId>,
    pub seats: u8,                        // 1–9，含駕駛
    pub color: Option<String>,            // "#rrggbb"；未設定時依車輛順序取 CAR_PALETTE
    pub passengers: BTreeSet<PersonId>,   // 不含駕駛；人數 + 1 ≤ seats
    pub ordinal: u64,
    pub version: Seq,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Place { pub id: PlaceId, pub name: String, pub ordinal: u64, pub version: Seq }

/// 路線端點與停靠點：地點清單中的地點，或旅行目的地（資料庫存 NULL，取代現行的 '@destination'）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum PlaceRef { Destination, Place(PlaceId) }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Route {
    pub id: RouteId,
    pub day: Date,
    pub vehicle: VehicleId,               // 每台車每天最多一條
    pub from: PlaceRef,
    pub to: PlaceRef,
    pub depart: Option<Hm>,               // 出發時間可以留空
    pub stops: Vec<Stop>,                 // 0–6 個，依順序
    pub ordinal: u64,
    pub version: Seq,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stop {
    pub id: StopId,
    pub place: PlaceRef,
    pub kind: StopKind,                   // shop、pickup、gear、other
    pub task: Option<StopTask>,           // 必須屬於 kind（STOP_TASK_KINDS）
    pub note: String,                     // 0–100 字
    pub time: Option<Hm>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DaySetting {
    pub day: Date,
    pub title: Option<String>,            // 0–20 字；只有空白視為未設定
    pub place: Option<PlaceId>,           // 未設定 = 旅行目的地
    pub arrival: Option<Hm>,              // 預計抵達時間：由規劃者填寫，App 不計算
    pub route_position: RoutePosition,    // before、after：文字版中路線在活動之前或之後
    pub version: Seq,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Activity {
    pub id: ActivityId,
    pub day: Date,
    pub time: Hm,
    pub title: String,                    // 1–100 字
    pub kind: ActivityKind,               // 13 種（ACTIVITY_CATEGORIES）
    pub location: String,                 // 0–150 字
    pub note: String,                     // 0–1000 字
    pub done: bool,
    pub who: Participation,
    pub ordinal: u64,
    pub version: Seq,
}

/// 現行規則：people 為空代表全體；指定車輛時 people 必須為空。
/// People 與 Vehicles 都不會是空集合：命令的結果使指定的集合變成空的時，改為 Everyone（需求 23.4、19.11）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", content = "ids", rename_all = "snake_case")]
pub enum Participation { Everyone, People(BTreeSet<PersonId>), Vehicles(BTreeSet<VehicleId>) }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Meal {
    pub id: MealId,
    pub day: Date,
    pub slot: MealSlot,                   // 早餐、午餐、下午茶、晚餐、消夜
    pub time: Option<Hm>,                 // 未設定時 meal_time() 用餐次的預設時間
    pub title: String,                    // 0–100 字
    pub cook: Option<PersonId>,
    pub servings: u8,                     // 1–100
    pub ingredients: String,              // 食材文字，採買同步的來源；0–2000 字
    pub notes: String,                    // 0–1000 字
    pub dish: Option<DishKind>,           // 插圖種類；未設定時 infer_dish_kind()
    pub ordinal: u64,
    pub version: Seq,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShoppingItem {
    pub id: ShoppingId,
    pub name: String,                     // 1–100 字
    pub quantity: String,                 // 0–40 字（現行表單 maxlength）
    pub category: Category,               // 11 類（SHOPPING_CATEGORIES）
    pub assignee: Option<PersonId>,       // 誰負責買；None = 待分配
    pub purchased: bool,
    pub source: ItemSource,               // Meal：由料理產生；Manual：手動管理
    pub meal_ids: BTreeSet<MealId>,       // 只由採買同步維護
    pub recipe_removed: Option<bool>,     // 只由採買同步維護（現行 recipeRemoved 的三態）
    pub ordinal: u64,
    pub version: Seq,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GearItem {
    pub id: GearId,
    pub name: String,                     // 1–100 字
    pub quantity: String,                 // 0–40 字（現行表單 maxlength）
    pub scope: GearScope,                 // Personal：每人各帶一份；Shared：一人負責
    pub assignee: Option<PersonId>,       // 只有 Shared 可以有
    pub packed_by: BTreeSet<PersonId>,    // Shared 時只能是 {assignee}
    pub ordinal: u64,
    pub version: Seq,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Departure { pub person: PersonId, pub version: Seq }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Expense {
    pub id: ExpenseId,
    pub day: Date,
    pub title: String,                    // 1–100 字
    pub amount_cents: i64,                // 1–100,000,000（NT$0.01–1,000,000）
    pub payer: PersonId,
    pub participants: BTreeSet<PersonId>, // 1–100 位，平均分攤（split_evenly）
    pub category: ExpenseCategory,
    pub note: String,                     // 0–500 字
    pub shopping_item: Option<ShoppingId>,
    pub ordinal: u64,
    pub version: Seq,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settlement {
    pub id: SettlementId,
    pub day: Date,
    pub from: PersonId,
    pub to: PersonId,                     // from ≠ to
    pub amount_cents: i64,
    pub note: String,
    pub ordinal: u64,
    pub version: Seq,
}

/// 一趟旅行的全部列。BTreeMap 讓走訪順序固定；畫面順序另依 ordinal 或領域規則排序。
#[derive(Clone, Debug, PartialEq)]
pub struct TripState {
    pub card: TripCard,
    pub people: BTreeMap<PersonId, Person>,
    pub vehicles: BTreeMap<VehicleId, Vehicle>,
    pub places: BTreeMap<PlaceId, Place>,
    pub routes: BTreeMap<RouteId, Route>,
    pub day_settings: BTreeMap<Date, DaySetting>,
    pub activities: BTreeMap<ActivityId, Activity>,
    pub meals: BTreeMap<MealId, Meal>,
    pub shopping: BTreeMap<ShoppingId, ShoppingItem>,
    pub gear: BTreeMap<GearId, GearItem>,
    pub departures: BTreeMap<PersonId, Departure>,
    pub expenses: BTreeMap<ExpenseId, Expense>,
    pub settlements: BTreeMap<SettlementId, Settlement>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Entity { Card, Person, Vehicle, Place, Route, DaySetting, Activity, Meal, Shopping, Gear, Departure, Expense, Settlement }

/// 列的鍵：多數是 UUID；DaySetting 是日期；Departure 是旅伴 id；Card 是旅行 id。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RowKey { Id(Uuid), Day(Date) }

/// 一列在整趟旅行中的位置。
pub type Slot = (Entity, RowKey);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "entity", content = "row", rename_all = "snake_case")]
pub enum Row {
    Card(TripCard), Person(Person), Vehicle(Vehicle), Place(Place), Route(Route), DaySetting(DaySetting),
    Activity(Activity), Meal(Meal), Shopping(ShoppingItem), Gear(GearItem), Departure(Departure),
    Expense(Expense), Settlement(Settlement),
}

impl Row {
    pub fn slot(&self) -> Slot;
    pub fn version(&self) -> Seq;
    pub fn with_version(self, version: Seq) -> Row;
    /// Card、DaySetting、Departure 沒有 ordinal；其他列有。
    pub fn has_ordinal(&self) -> bool;
    pub fn with_ordinal(self, ordinal: u64) -> Row;
}

impl TripState {
    pub fn get(&self, slot: Slot) -> Option<Row>;
    pub fn put(&mut self, row: Row);
    pub fn remove(&mut self, slot: Slot) -> Option<Row>;
    pub fn slots(&self) -> impl Iterator<Item = Slot> + '_;
    pub fn apply_effects(&mut self, effects: &[Effect]);
    /// 依 ordinal 排序的走訪（取代現行陣列的順序）。
    pub fn vehicles_by_ordinal(&self) -> impl Iterator<Item = &Vehicle>;
    pub fn meals_by_ordinal(&self) -> impl Iterator<Item = &Meal>;
    pub fn shopping_by_ordinal(&self) -> impl Iterator<Item = &ShoppingItem>;
    /// 所有列中最大的 ordinal（沒有列時為 0）；新列的暫時 ordinal 從它加 1 開始（見 1.5）。
    pub fn max_ordinal(&self) -> u64;
}
```

其餘列舉（`StopKind`、`StopTask`、`RoutePosition`、`ActivityKind`、`MealSlot`、`DishKind`、`Category`、`ItemSource`、`GearScope`、`ExpenseCategory`、`Role`）的值與現行字串相同，見「Data Models」的「列舉與上限」。

#### 1.3 命令

命令是客戶端唯一能送給伺服器的寫入。欄位層級的 patch 以 `None` 表示「不改」，以 `Some(None)` 表示「清空」；新列的 id 由客戶端產生。

```rust
// crates/core/src/command.rs（節錄）
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    // 旅行
    UpdateTrip { patch: TripPatch },                          // 含改日期（retime_by_day_index）
    // 旅伴
    AddPerson { id: PersonId, name: String, role: String, color: Option<Color> },
    UpdatePerson { id: PersonId, patch: PersonPatch },
    RemovePerson { id: PersonId },
    // 車輛
    AddVehicle { id: VehicleId, draft: VehicleDraft },
    UpdateVehicle { id: VehicleId, patch: VehiclePatch },
    RemoveVehicle { id: VehicleId },
    // 地點
    AddPlace { id: PlaceId, name: String },
    RenamePlace { id: PlaceId, name: String },
    RemovePlace { id: PlaceId },
    // 行程表
    SaveRoute { route: RouteDraft },                          // 整條路線與它的停靠點（路線卡片一次儲存）
    RemoveRoute { id: RouteId },
    SaveDaySetting { day: Date, patch: DaySettingPatch },     // 只帶改過的欄位（需求 22.15）；那一天沒有設定時新增
    AddActivities { day: Date, items: Vec<ActivityDraft> },  // 一筆或多筆（常用活動一次加入）
    UpdateActivity { id: ActivityId, patch: ActivityPatch },
    RemoveActivity { id: ActivityId },
    SetActivityDone { id: ActivityId, done: bool },
    // 料理
    AddMeal { id: MealId, draft: MealDraft },
    UpdateMeal { id: MealId, patch: MealPatch },              // 含在規劃行程調整用餐時間
    RemoveMeal { id: MealId },
    RemoveIngredientFromMeals { item: ShoppingId, meals: BTreeSet<MealId> },
    // 採買
    AddShoppingItem { id: ShoppingId, draft: ShoppingDraft },
    UpdateShoppingItem { id: ShoppingId, patch: ShoppingPatch },
    RemoveShoppingItem { id: ShoppingId },
    SetShoppingPurchased { id: ShoppingId, purchased: bool },
    // 裝備與出發
    AddGear { id: GearId, draft: GearDraft },
    UpdateGear { id: GearId, patch: GearPatch },
    RemoveGear { id: GearId },
    SetGearPacked { id: GearId, person: PersonId, packed: bool },
    SetDeparted { person: PersonId, departed: bool },
    // 分帳
    AddExpense { id: ExpenseId, draft: ExpenseDraft },
    UpdateExpense { id: ExpenseId, patch: ExpensePatch },
    RemoveExpense { id: ExpenseId },
    AddSettlement { id: SettlementId, draft: SettlementDraft },
    UpdateSettlement { id: SettlementId, patch: SettlementPatch },
    RemoveSettlement { id: SettlementId },
}

/// 例：車輛 patch。乘客是集合操作，與別人同時加入或移除其他乘客不會互相覆蓋。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct VehiclePatch {
    pub name: Option<String>,
    #[serde(default, with = "serde_with::rust::double_option")]
    pub driver: Option<Option<PersonId>>,
    pub seats: Option<Input<u8>>,
    #[serde(default, with = "serde_with::rust::double_option")]
    pub color: Option<Option<String>>,
    #[serde(default)]
    pub passengers_add: BTreeSet<PersonId>,
    #[serde(default)]
    pub passengers_remove: BTreeSet<PersonId>,
}

/// 編輯旅行（需求 18.1）：只帶使用者改過的欄位，沒有帶的欄位保留伺服器執行當下的值。
/// 起訖日期是一個欄位：開始日與結束日一起帶有、一起生效，不會只改其中一個。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TripPatch {
    pub title: Option<String>,
    pub destination: Option<String>,
    pub dates: Option<DateSpan>,
    pub description: Option<String>,
    pub note: Option<String>,
    pub cover: Option<Input<CoverKind>>,
    pub status: Option<Input<TripStatus>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DateSpan { pub start: Date, pub end: Date }

/// 一天的設定（需求 22.10、22.15）：只帶改過的欄位；Some(None) 是清空。
/// place 只能是地點清單中的地點；選擇旅行目的地或「不指定地點」時，LM_Web 送出 Some(None)。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DaySettingPatch {
    #[serde(default, with = "serde_with::rust::double_option")]
    pub title: Option<Option<String>>,
    #[serde(default, with = "serde_with::rust::double_option")]
    pub place: Option<Option<PlaceId>>,
    #[serde(default, with = "serde_with::rust::double_option")]
    pub arrival: Option<Option<Input<Hm>>>,
    pub route_position: Option<Input<RoutePosition>>,
}

/// 使用者輸入或選擇的值。能解析成 T 時是 Ok；其他任何 JSON 值是 Bad，保留原值。
/// 反序列化因此不會在這些欄位失敗，LM_Core 才能依各需求的檢查順序回應那個欄位的 400 訊息。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Input<T> { Ok(T), Bad(serde_json::Value) }
```

表單在開啟時記下當時的列，儲存時只把使用者改過的欄位放進 patch（集合欄位則算出加入與移除，需求 7.8）。因此別人同時改了同一列的其他欄位，也不會被這次儲存蓋掉。唯一的例外是 `SaveRoute`：路線卡片把起點、終點、出發時間與停靠點當成一份草稿一起儲存，同一條路線的並行儲存由後提交者整條生效（需求 7.9）；Presence 會先提示誰正在編輯這張卡片。

使用者輸入或選擇的值（時刻、列舉值、座位數與份數）在命令中以 `Input<T>` 表示，例如 `Input<Hm>`、`Input<ActivityKind>`、`Input<u8>`。時刻以使用者輸入的文字送出，由 `normalize_time_input()` 解析（「０８：３０」是 08:30）；選填的時刻以 `null` 或空字串表示留空。`Bad` 的值由 LM_Core 依各需求的順序與訊息回應 400，例如需求 17.5 與 18.2 的封面與狀態、20.1 的座位數、22.5 與 22.10 的時刻、23.10 的時間與類別、24.2 的餐次與份數。其餘欄位的型別不符（例如日期不是有效的日期、id 不是 UUID）時，依需求 7.20 回應 400 `invalid_request`。

料理表單在使用者改了餐次、而這道料理設定了用餐時間時，在同一個 `UpdateMeal` 的 patch 中一併清空用餐時間，使料理改用新餐次的預設時間（需求 24.12，沿用現行 `saveMeal()`）。

#### 1.4 權限

現行規則（`server/accounts.js` 的 `capabilities()`、`denyCollaboratorRemovals()`、`guardCollaborator()`、`guardShoppingRemoval()`、`retainPurchased()`、`checkTrip()` 中的 `myGear()` 與 `canDepart()` 檢查，以及 `server/ledger.js` 的 `buildLedger()`）整理成下表。「管理者」是旅行建立者或管理員；「受邀旅伴」是以邀請加入、綁定了旅伴的帳號。

| 命令 | 管理者 | 受邀旅伴 | 其他規則 |
|---|---|---|---|
| 開啟旅行、讀取快照、訂閱頻道 | ✓ | ✓ | 其他帳號一律 404「找不到這趟旅行。」 |
| `UpdateTrip` | ✓ | ✓ | |
| 刪除旅行（`DELETE /api/trips/{id}`） | ✓ | 403 | |
| `AddPerson` | ✓ | ✓ | |
| `UpdatePerson` | ✓ | 只能改未綁定帳號的旅伴與自己（其他綁定者 403「只能修改自己的旅伴資料。」） | |
| `RemovePerson` | ✓ | 403 | 綁定帳號的旅伴 409；仍有帳目提到他 409 |
| `AddVehicle`、`UpdateVehicle` | ✓ | ✓ | |
| `RemoveVehicle` | ✓ | 403 | 仍有路線或活動指定這台車 409 |
| `AddPlace`、`RenamePlace`、`RemovePlace` | ✓ | ✓ | 使用中的地點不能刪 409 |
| `SaveRoute`、`RemoveRoute`、`SaveDaySetting` | ✓ | ✓ | 受邀旅伴可以刪除路線與途中任務 |
| `AddActivities`、`UpdateActivity`、`RemoveActivity`、`SetActivityDone` | ✓ | ✓ | 受邀旅伴可以刪除活動 |
| `AddMeal`、`UpdateMeal`、`RemoveIngredientFromMeals` | ✓ | ✓ | |
| `RemoveMeal` | ✓ | 403 | |
| `AddShoppingItem`、`UpdateShoppingItem`、`SetShoppingPurchased` | ✓ | ✓ | 受邀旅伴取消已買的料理品項時，品項改為手動 |
| `RemoveShoppingItem` | ✓ | 403 | 採買同步自動移除的品項不算刪除（任何人改料理都可能造成） |
| `AddGear`、`UpdateGear` | ✓ | ✓ | |
| `RemoveGear` | ✓ | 403 | |
| `SetGearPacked`、`SetDeparted` | 只能是自己 | 只能是自己 | 其他人 403「只能變更自己的行前準備。」 |
| `AddExpense`、`UpdateExpense`、`AddSettlement`、`UpdateSettlement` | 需綁定旅伴 | ✓ | 沒有綁定旅伴的管理員 404 |
| `RemoveExpense`、`RemoveSettlement` | 需綁定旅伴 | 403 | 「受邀旅伴可以新增或修改帳目，但不能刪除既有帳目；請聯絡主辦人或管理員。」 |
| 建立邀請連結 | ✓（每趟最多 20 個有效） | ✓（每人最多 5 個有效） | |
| 列出邀請連結 | 全部 | 自己建立的 | |
| 撤銷邀請連結 | ✓ | 自己建立的（其他 403） | |

```rust
// crates/core/src/rules.rs（節錄）
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities { pub can_edit: bool, pub can_manage: bool, pub can_invite: bool, pub me: Option<PersonId> }

/// 現行 capabilities()：建立者或管理員可以管理；綁定旅伴的成員可以編輯與邀請。
pub fn capabilities(owner: UserId, actor: UserId, role: Role, me: Option<PersonId>) -> Capabilities {
    let manage = owner == actor || role == Role::Admin;
    Capabilities { can_edit: manage || me.is_some(), can_manage: manage, can_invite: manage || me.is_some(), me }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Right { Edit, Manage, SelfOnly(PersonId), LedgerEdit, LedgerManage }

pub fn required_right(cmd: &Command) -> Right {
    use Command::*;
    match cmd {
        RemovePerson { .. } | RemoveVehicle { .. } | RemoveMeal { .. } | RemoveShoppingItem { .. } | RemoveGear { .. } => Right::Manage,
        SetGearPacked { person, .. } | SetDeparted { person, .. } => Right::SelfOnly(*person),
        AddExpense { .. } | UpdateExpense { .. } | AddSettlement { .. } | UpdateSettlement { .. } => Right::LedgerEdit,
        RemoveExpense { .. } | RemoveSettlement { .. } => Right::LedgerManage,
        _ => Right::Edit,
    }
}

pub fn authorize(state: &TripState, caps: &Capabilities, cmd: &Command) -> Result<(), Rejection> {
    if !caps.can_edit {
        return Err(Rejection::not_found(TRIP_NOT_FOUND));
    }
    let right = required_right(cmd);
    let allowed = match right {
        Right::Edit => true,
        Right::Manage => caps.can_manage,
        Right::SelfOnly(person) => caps.me == Some(person),
        Right::LedgerEdit => caps.me.is_some(),
        Right::LedgerManage => caps.me.is_some() && caps.can_manage,
    };
    if !allowed {
        return Err(match right {
            Right::Manage => Rejection::forbidden(DENY_REMOVAL),
            Right::SelfOnly(_) => Rejection::forbidden(DENY_PACKING),
            Right::LedgerEdit | Right::LedgerManage if caps.me.is_none() => Rejection::not_found(TRIP_NOT_FOUND),
            _ => Rejection::forbidden(DENY_LEDGER_REMOVAL),
        });
    }
    if let Command::UpdatePerson { id, .. } = cmd {
        let other_bound = state.people.get(id).is_some_and(|p| p.bound) && caps.me != Some(*id);
        if other_bound && !caps.can_manage {
            return Err(Rejection::forbidden("只能修改自己的旅伴資料。"));
        }
    }
    Ok(())
}
```

`TRIP_NOT_FOUND`、`DENY_REMOVAL`、`DENY_PACKING`、`DENY_LEDGER_REMOVAL` 沿用現行文案。邀請相關的三條規則不經過 `Command`，由 `lm-server` 的邀請處理函式以同一份 `Capabilities` 判斷。

#### 1.5 `apply()` 與命令規則

```rust
// crates/core/src/apply/mod.rs（介面）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// 前端預測：只算主要效果，不跑採買同步（衍生資料只在伺服器計算，B5）。
    Predict,
    /// 伺服器提交：主要效果加上衍生效果。
    Commit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ctx { pub actor: UserId, pub caps: Capabilities }

#[derive(Clone, Debug, PartialEq)]
pub enum Effect { Upsert(Row), Delete(Slot) }

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Outcome {
    pub primary: Vec<Effect>,   // 命令本身造成的變化
    pub derived: Vec<Effect>,   // 採買同步造成的變化（只有 Mode::Commit 才有）：品項的新增、更新與刪除，以及清除被刪除品項的支出連結
    /// 新增的列（有 ordinal 的種類）依建立順序：先是主要效果的新列，依命令中的順序（例如一次加入的多個常用活動）；
    /// 再是採買同步新增的 Meal_Item，依料理的 ordinal、再依食材在料理中第一次出現的順序。execute() 依這個順序指定 ordinal（需求 7.19）。
    pub created: Vec<Slot>,
}

impl Outcome {
    /// 主要效果在前、衍生效果在後；同一個 Slot 只留最後一筆。
    pub fn effects(&self) -> Vec<Effect>;
    pub fn is_noop(&self) -> bool;
}

/// 伺服器產生衍生列（由料理新增的採買品項）的 id；前端預測時不會被呼叫。
pub trait IdSource { fn shopping_id(&mut self) -> ShoppingId; }

pub fn apply(state: &TripState, ctx: &Ctx, mode: Mode, ids: &mut dyn IdSource, cmd: &Command)
    -> Result<Outcome, Rejection>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Rejection {
    #[error("{message}")] Invalid { code: String, field: Option<String>, message: String },  // HTTP 400
    #[error("{message}")] Forbidden { message: String },                                     // HTTP 403
    #[error("{message}")] NotFound { message: String },                                      // HTTP 404
    #[error("{message}")] Conflict { code: String, message: String },                        // HTTP 409
}
```

每個命令的處理函式在 `TripState` 的可寫副本上修改列；最後以 `diff()` 與原狀態比較，內容沒有改變的列不產生效果（見 A2）。因此「想要的狀態已經成立」的命令，例如再次勾選已買的品項，得到空的 `Outcome`，伺服器不寫入也不推送（B4、需求 7.12）。

所有命令共同的規則：

- **順序**：先依 1.4 判斷權限，再找目標的列、驗證輸入、判斷有沒有變化（需求 6.4）；所以 Collaborator 刪除已不存在的採買品項仍得到 403（需求 26.16）。同一個命令的欄位依下表與各需求列出的順序檢查，只回報第一個不符合的規則。
- **文字**：先依各需求正規化（Trim_White、Participant_Name，或支出的 NFC 加 Trim_White），再以正規化後的值檢查與儲存。任何文字含 U+0000 時回應 400（需求 8.12）：旅行資料為「旅行資料含有不允許的字元。」，旅伴名字與地點名稱依需求 19.3 與 21.1 的訊息，小隊角色為「小隊角色含有不允許的字元。」，其他欄位為「文字含有無法儲存的字元。」。
- **新列的 id**：新增旅伴、車輛、地點、活動、料理、採買品項、裝備、支出或還款時，id 已被這趟旅行中同一種列使用（包括同一個命令中先新增的列）就回應 409 `duplicate_id`「這個項目已經存在，請重新整理後再試。」，不覆寫既有的列（需求 7.22）。新列先取得暫時的 ordinal：從 `state.max_ordinal() + 1` 起依 `Outcome.created` 的順序遞增，所以預測的新列排在同一種列的最後（需求 7.18），`execute()` 再換成正式的 ordinal。
- **已不存在的列**：要刪除的列已不存在時（例如已被其他成員先刪除）沒有變化，也不產生任何連帶效果，例如不刪除出發確認、不執行採買同步（需求 7.12）；要修改或勾選的列已不存在時回應 404 與該種項目的訊息，不重新建立（需求 7.21），見下表「目標已不存在」欄。`SaveRoute` 與 `SaveDaySetting` 在列不存在時新增。
- **最後的不變式**：處理函式與採買同步之後，`validate::state()` 仍不成立時拒絕整個命令（需求 9.1、9.14），回應依需求 9.16 決定（見「Data Models」的不變式）。

| 命令 | 驗證與拒絕（依檢查順序；文案沿用現行） | 目標已不存在 | 效果 |
|---|---|---|---|
| `UpdateTrip` | 只合併 `TripPatch` 帶有的欄位（需求 18.1），以合併後的旅行資料依名稱、目的地、起訖日期、介紹、小叮嚀、封面、狀態的順序檢查（400，需求 17.5、18.2）：名稱 Trim_White 後 1–100 字（「請填寫旅行名稱（最多 100 個字）。」）、目的地 ≤100、含頭尾 1–31 天（「結束日不能早於開始日，而且一趟旅行最多 31 天。」）、介紹與小叮嚀 ≤1000、四段文字不含 U+0000、封面與狀態是列舉值；接著目的地與地點同名（409「已有同名地點：{地點名稱}。請先在「地點與車」把這個地點改名。」）、清空目的地時仍有路線使用（409「仍有路線或停靠點使用旅行目的地，不能把目的地清空。」，`destination_conflict()`）、縮短天數會刪掉有路線，或有標題、地點的每日設定的日子（409，`shorten_blocked_message()`，需求 18.7） | — | 更新旅行列；改日期時依 `retime_by_day_index()` 搬動活動、料理、路線與每日設定，並刪除被刪掉日子的每日設定（需求 18.5–18.9） |
| `AddPerson` | 名字與角色先經 Participant_Name（空白為 JS_Whitespace），角色是空的時改為「新加入的旅伴」（需求 19.1）；依序：名字的 Participant_Key 去除前後的 JS_Whitespace 後是空的（「請填寫名字或暱稱，不能只有空白。」）、含 Hidden_Control_Char（「名字不能包含隱藏控制字元。」）、超過 30 字（「名字最多 30 個字。」）、角色超過 60 字（「小隊角色最多 60 個字。」）或含 U+0000（「小隊角色含有不允許的字元。」）、Participant_Key 與其他旅伴相同（409「這個名字已在小隊中。請加上姓氏或使用不同暱稱，不會直接切換成同名旅伴。」）、已有 100 位（409「小隊最多 100 位旅伴，目前已額滿。」） | — | 新增旅伴（未指定顏色時以新增前的人數除以 6 的餘數取 `COLORS`，需求 19.8）；刪除所有出發確認（需求 19.9，沿用 `addParticipant()` 清空 `departed`） |
| `UpdatePerson` | 只檢查帶有的欄位，規則與 `AddPerson` 相同；同名比較不含這位旅伴自己，所以只改大小寫的改名可以儲存；不受 100 位的上限限制 | 404「找不到這位旅伴。」 | 更新名字、角色或顏色；不改變出發確認 |
| `RemovePerson` | 綁定帳號的旅伴（409「已綁定帳號的旅伴不能在手冊中移除或更換，請由管理員處理帳號。」）；仍是支出的付款人或分攤旅伴，或還款的付款人或收款人（409「這位旅伴仍有支出或還款紀錄。請先在分帳記帳修改或刪除這些帳目，再移除旅伴。」）。Unbound_Admin 的 Replica 不含帳目，所以後者只在提交時檢查得到（需求 13.5） | 沒有變化 | 移植現行 `detachPerson()`：刪除旅伴；清除駕駛、乘客、活動參加者（清空後即為全體）、料理負責人、採買負責人、裝備負責人與打包勾選中的引用；有共用裝備因此失去負責人時，清空該項的打包並刪除所有出發確認，否則只刪除他自己的出發確認（需求 19.10–19.12） |
| `AddVehicle`、`UpdateVehicle` | 名稱先 Trim_White；以新增或套用到當下最新狀態之後的車輛依序檢查（400，需求 20.1–20.3、20.9）：名稱是空的或座位數沒有填寫（「請填寫必要欄位，不能只有空白。」）、名稱超過 50 字（「車輛暱稱最多 50 個字。」）、座位數不是 1–9 的整數（「座位數（含駕駛）請填 1 到 9 的整數。」）、駕駛也在乘客中（「駕駛不能同時是乘客。」）、乘客人數 + 1 超過座位數（「乘客加上駕駛不能超過座位數。」，沒有駕駛時也保留駕駛座）、駕駛或乘客不是現有的旅伴（「找不到這位旅伴。」）、顏色不是 `#` 加 6 個小寫十六進位數字（「車輛顏色需為 #rrggbb」） | 修改：404「找不到這台車。」 | 新增或更新；乘客以集合加入與移除 |
| `RemoveVehicle` | 仍有路線（409「這台車在第 N 天還有路線，請先刪除這些路線，或改派給其他車。」，多天時依天數以「、」連接）；仍被活動指定（409「這台車仍有指定行程。請先把那些行程改派其他車輛或改為全體，再移除車輛。」；兩者都有時以一個半形空格連接兩段訊息） | 沒有變化 | 刪除這台車與它的乘客名單 |
| `AddPlace`、`RenamePlace` | 名稱先 Trim_White，依序（需求 21.1、21.2）：空白（400「請填寫地點名稱。」）、超過 50 字（400「地點名稱最多 50 個字。」）、含 Hidden_Control_Char（400「地點名稱不能包含換行、Tab 或隱藏的控制字元。」）、Place_Key 與其他地點或非空白旅行目的地相同（409「已有同名地點」）；新增時已有 100 個地點（409「地點最多 100 個」） | 改名：404「找不到這個地點。」 | 新增或改名；改名後與原名稱完全相同時沒有變化 |
| `RemovePlace` | 仍有 Place_Usage（409，以「這個地點還在使用中，請先把下列使用處改成其他地點。」開頭，依天列出用途，需求 21.4） | 沒有變化 | 刪除 |
| `SaveRoute` | 依序（需求 22.4–22.7）：日期不在範圍內（400「資料驗證未通過，沒有儲存。請重新載入後再試。」）、車輛未選擇或不存在（400「請選擇哪一台車。」）、出發時間不是 Time_Value 也不是留空（400「請以 24 小時制填寫完整的時和分，例如 08:30；不填時請清空。」）、起點、終點或停靠點不是地點清單中的地點，也不是目的地不是空白時的旅行目的地（400「請選擇從哪裡出發。」「請選擇最後到哪裡。」「請選擇停在哪裡。」）、超過 6 個停靠點（「每台車最多 6 個停靠點」）、種類或任務類型不符（「請選擇要做什麼。」）、備註 Trim_White 後超過 100 字（「備註最多 100 個字。」）、停靠點時間不符（與出發時間相同的訊息）；這台車同一天已有另一條路線（409「這台車這一天已有路線，請選擇其他車。」） | 新增（例如已被其他成員刪除，需求 22.3） | 新增或整條取代，保留路線與既有停靠點的 id；不改變採買品項 |
| `RemoveRoute` | | 沒有變化 | 刪除路線與它的停靠點；不改變採買品項 |
| `SaveDaySetting` | 只合併 `DaySettingPatch` 帶有的欄位（需求 22.15），依序（需求 22.10）：日期不在範圍內（400「資料驗證未通過，沒有儲存。請重新載入後再試。」）、標題 Trim_White 後超過 20 字（「標題最多 20 個字。」）、地點不在地點清單中（「請重新選擇地點。」）、預計抵達時間不是 Time_Value 也不是留空（「請以 24 小時制填寫完整的時和分，例如 08:30；不填時請清空。」）、路線位置不是 before 或 after | 新增 | 只更新帶有的欄位（標題、地點、預計抵達時間、路線位置），其他欄位保留執行當下的值；合併後標題、地點與預計抵達時間都未設定時刪除這一天的設定，路線位置回到 before（需求 22.11），原本就沒有設定時沒有變化 |
| `AddActivities`、`UpdateActivity` | 標題、地點與備註先 Trim_White；依標題、日期、時間、類別、參加者、地點、備註的順序檢查，多筆時依送出的順序，訊息見需求 23.10（例如「請填寫標題。」「請填寫時間，例如 08:30。」「請重新選擇參加的旅伴。」）；新增之後超過 1000 筆時整個命令拒絕（409「活動最多 1,000 筆，請先刪除不需要的活動。」） | 修改：404「找不到這個活動。」 | 新增（Activity_Preset 的參加者為全體、未完成）或只更新帶有的欄位；參加者是全體、指定旅伴或指定車輛之一，結果的指定集合變成空的時改為全體（需求 23.4） |
| `RemoveActivity` | | 沒有變化 | 刪除活動與它的指定旅伴、指定車輛 |
| `SetActivityDone` | | 404「找不到這個活動。」 | 設定完成狀態（冪等） |
| `AddMeal`、`UpdateMeal` | 依序（需求 24.2）：餐次不是五種之一、插圖種類不是八種之一也不是未設定，或名稱、食材、備註含 U+0000（400）；日期不在範圍內（「請重新選擇日期。」）；用餐時間不是 Time_Value 也不是留空（「請以 24 小時制填寫完整的時和分，例如 08:30；不填時請清空。」）；名稱超過 100 字（「料理名稱最多 100 個字。」）；負責人不是旅伴也不是待分配（「負責人已不在旅伴名單，請重新選擇。」）；份數不是 1–100 的整數（「人數請填 1 到 100 的整數。」）；食材超過 2,000 字（「食材最多 2,000 字，請先整理清單。」）；Ingredient_Parser 切出的任一食材超過 100 字（「每項食材最多 100 字，請用頓號或換行分隔不同的食材。」，需求 25.18）；備註超過 1,000 字（「料理筆記最多 1,000 個字。」）；新增時已有 1000 道料理（409「料理最多 1,000 道，請先刪除不需要的料理。」）；採買同步之後超過 1000 項（409，需求 25.15） | 修改：404「找不到這道料理。」（在上述檢查之前） | 新增或只更新帶有的欄位；改了餐次時，表單在同一個 patch 中清空用餐時間（需求 24.12）；衍生：採買同步 |
| `RemoveMeal` | | 沒有變化 | 刪除；衍生：採買同步 |
| `RemoveIngredientFromMeals` | 依序（需求 25.20）：品項不存在（404「找不到這個採買品項。」）、沒有選定料理（400「請至少勾選一道料理。」）、任一選定的料理不存在（404「找不到這道料理。」） | 見左欄 | 依提交當下的食材文字，從選定料理移除這個品項名稱切出的鍵（`removeIngredientFromMeals()`，需求 25.16）；衍生：採買同步（已沒有料理需要時，品項由同步移除） |
| `AddShoppingItem` | 名稱與數量先 Trim_White，依序（需求 26.2–26.4）：名稱是空的（「請填寫品項名稱。」）、名稱超過 100 字（「品項名稱最多 100 個字。」）、數量超過 40 字（「數量與單位最多 40 字。」）、分類與負責人有效；任一食材鍵與提交當下的既有品項相同（409「清單已有同名品項，請編輯既有品項的數量與分類。」）；已有 1000 項（409「採買品項最多 1,000 項，請減少食材或整理採買清單後再儲存。」） | — | 新增未買的手動品項；衍生：採買同步 |
| `UpdateShoppingItem` | 只檢查帶有的欄位，先 Trim_White（需求 26.5）：名稱是空的或超過 100 字、數量是空的（「請填寫數量與單位。」）或超過 40 字（「數量與單位最多 40 字。」）、分類與負責人有效；提交當下是 Linked_Item 的品項改成另一個名稱（409「連動食材名稱請在料理菜單修改。」，同一次送出的其他欄位也不套用） | 404「找不到這個採買品項。」 | 更新。只改數量時（行內編輯數量）`source` 不變；名稱、分類或負責人改成不同的值時設為手動品項（需求 26.7、26.8；現行表單儲存與 `assignShopping()` 都把 `source` 設為 manual）；衍生：採買同步 |
| `RemoveShoppingItem` | 提交當下是 Linked_Item（409「連動料理的品項不能直接刪除，請改從料理移除這項食材。」） | 沒有變化（Collaborator 仍先得到 403） | 刪除；清除支出對它的採買連結（主要效果，需求 26.11、29.13）；衍生：採買同步 |
| `SetShoppingPurchased` | | 404「找不到這個採買品項。」 | 設定已買（冪等）；Collaborator 把已買的 Meal_Item 改為未買時改為手動品項（`retainPurchased()`，需求 26.10） |
| `AddGear`、`UpdateGear` | 名稱與數量先 Trim_White，以新增或修改之後的裝備依序檢查（400，需求 27.2）：名稱是空的（「請填寫必要欄位，不能只有空白。」）、名稱超過 100 字（「裝備名稱最多 100 個字。」）、數量超過 40 字（「數量與單位最多 40 個字。」）、個人裝備有負責人（「個人裝備每人各帶一份，不能指定負責人。」）、共用裝備的負責人不是現有的旅伴（「找不到這位旅伴。」）；新增時已有 1000 項（409「裝備最多 1000 項，目前已額滿。」） | 修改：404「找不到這個裝備。」 | 新增或更新；範圍改變，或共用裝備的負責人改變時清空這個裝備的打包勾選（需求 27.4）；新增，或名稱、數量、範圍、負責人至少一項的值真的改變時，刪除所有出發確認（需求 27.5） |
| `RemoveGear` | | 沒有變化 | 刪除裝備與它的打包勾選；刪除所有出發確認 |
| `SetGearPacked` | 只能勾 `my_gear()` 中的項目（403「只能勾選自己的個人裝備或負責的共用裝備。」） | 404「找不到這個裝備。」（在 1.4 的權限之後） | 設定這位旅伴的打包狀態（冪等）；取消時一併刪除自己的出發確認（需求 27.8） |
| `SetDeparted` | 確認時 `can_depart()` 必須成立（400「個人裝備尚未準備完成，或仍有共用裝備未分配。」） | — | 新增或刪除自己的出發確認（冪等；取消時不檢查 Can_Depart） |
| `AddExpense`、`UpdateExpense` | 標題與備註先 NFC 再 Trim_White，以新增或套用修改之後的支出依序檢查（需求 29.2）：標題是空的或超過 100 字（「請填寫 1–100 字的項目名稱。」）、標題含 Hidden_Control_Char（「項目名稱不能包含隱藏控制字元。」）、日期的年份不在 0001–9999（「請選擇有效的日期。」）、金額不在 1–100,000,000 分（「金額必須大於 0。」「單筆金額最多 NT$1,000,000。」）、付款人（「請選擇付款人。」「付款人不是這趟旅行目前的旅伴。」）、1–100 位現有的分攤旅伴（「請至少選擇一位分攤的旅伴。」「分攤旅伴不是這趟旅行目前的旅伴。」）、分類是 18 種之一（「請選擇分類。」）、備註超過 500 字（「備註最多 500 字。」）或含 LF、CRLF 與 Tab 以外的 Hidden_Control_Char（「備註不能包含隱藏控制字元。」）、連結的採買品項不存在（「找不到連結的採買品項，請重新選擇。」）；新增時已有 1000 筆（409「支出最多 1000 筆。」） | 修改：404「找不到這筆支出。」 | 新增或只更新帶有的欄位；分攤旅伴以加入與移除套用 |
| `AddSettlement`、`UpdateSettlement` | 以新增或套用修改之後的還款依序檢查（需求 29.3）：付款人或收款人未選擇（「請選擇付款與收款的旅伴。」）、不是現有的旅伴（「付款人不是這趟旅行目前的旅伴。」「收款人不是這趟旅行目前的旅伴。」）、兩者相同（「付款人與收款人不能是同一位。」）、金額與支出相同、日期（「請選擇還款日期。」）、備註與支出相同；新增時已有 1000 筆（409「還款紀錄最多 1000 筆。」） | 修改：404「找不到這筆還款。」 | 新增或只更新帶有的欄位 |
| `RemoveExpense`、`RemoveSettlement` | | 沒有變化 | 刪除（支出連同它的分攤旅伴）；其他帳目與採買品項不變 |

#### 1.6 同步型別

```rust
// crates/core/src/sync.rs（介面）
/// 一列的一次變化。row 為 None 表示刪除。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Change { pub entity: Entity, pub key: RowKey, pub version: Seq, pub row: Option<Row> }

/// 一次提交（一個命令）的全部變化。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeSet {
    pub trip: TripId,
    pub seq: Seq,                     // 這趟旅行的第幾次提交；連續、不跳號
    pub command_id: CommandId,
    pub actor: UserId,
    pub committed_at_ms: i64,
    pub changes: Vec<Change>,         // 每個 Slot 最多一筆；每筆 version == seq
    #[serde(default)]
    pub trip_deleted: bool,
}

impl ChangeSet {
    /// 移除 Ledger_Rows（支出含分攤旅伴、還款，包括刪除）的變化，其餘欄位與 Seq 不變；只含 Ledger_Rows 的
    /// Change_Set 因此變成沒有任何變化，但仍保留它的 Seq（需求 6.12、6.13、12.15）。
    pub fn without_ledger(&self) -> ChangeSet;
    /// 檢視者沒有 Bound_Person（Unbound_Admin）時回傳 without_ledger()，否則原樣回傳。
    pub fn for_viewer(self, hide_ledger: bool) -> ChangeSet;
}

/// Realtime 的 payload：一般是完整的 ChangeSet；超過 64 KB 時只送序號，由客戶端補抓。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Broadcast { Full(ChangeSet), Thin { trip: TripId, seq: Seq, thin: bool } }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Viewer { pub user: UserId, pub username: String, pub display_name: String, pub role: Role, pub caps: Capabilities }

impl Viewer {
    /// 沒有 Bound_Person 的檢視者（Unbound_Admin）看不到 Ledger_Rows（需求 6.12、6.13、6.18）。
    pub fn hides_ledger(&self) -> bool { self.caps.me.is_none() }
}

/// 某個 seq 當下的完整狀態（同一個 REPEATABLE READ 交易內讀出）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Snapshot { pub trip: TripId, pub seq: Seq, pub viewer: Viewer, pub rows: Vec<Row> }

/// 客戶端已確認的狀態。
pub struct Replica {
    pub state: TripState,
    tombstones: BTreeMap<Slot, Seq>,  // 亂序期間被刪除的列；低於水位線即丟棄
    pub watermark: Seq,               // ≤ watermark 的 ChangeSet 都已反映在 state
    ahead: BTreeSet<Seq>,             // 已套用、但前面還有缺號的 seq
}

#[derive(Debug, Default, PartialEq)]
pub struct ApplyReport {
    pub changed: Vec<Slot>,           // 內容真的改變的列（畫面只更新這些）
    pub duplicate: bool,
    pub gap: Option<(Seq, Seq)>,      // 缺少的 seq 範圍，需要補抓
    pub trip_deleted: bool,
}

impl Replica {
    pub fn from_snapshot(s: &Snapshot) -> Replica;
    pub fn apply_changeset(&mut self, cs: &ChangeSet) -> ApplyReport;
    pub fn apply_snapshot(&mut self, s: &Snapshot) -> ApplyReport;
    pub fn version_of(&self, slot: Slot) -> Seq;
}

/// 尚未得到伺服器回應的本地命令。
pub struct PendingCmd { pub id: CommandId, pub command: Command }

/// 畫面看到的狀態 = 已確認狀態，依序疊上仍在等待的命令的主要效果。
pub fn overlay(confirmed: &TripState, pending: &[PendingCmd], ctx: &Ctx) -> TripState;
```

#### 1.7 Presence

```rust
// crates/core/src/presence.rs（介面）
/// 正在編輯的對象：卡片或列，例如 (Route, id)、(DaySetting, 日期)、(Meal, id)、(Shopping, id)。
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct EditTarget { pub entity: Entity, pub key: RowKey }

/// 每個分頁 track 的內容。由用戶端自行回報，只作為提示，不影響權限與資料。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PresenceMeta {
    pub user: UserId,
    /// 帳號的顯示名稱（app.profiles.display_name，取自快照的 viewer），不是旅伴名稱。
    pub display_name: String,
    /// 這個帳號在這趟旅行綁定的旅伴；只用來把「剛更新了這一項」對應到旅伴名稱。
    pub person: Option<PersonId>,
    pub editing: Option<EditTarget>,
}

pub enum ThrottleAction { Send(PresenceMeta), WakeAt(f64), Nothing }

/// 保證任何 30 秒區間最多送出 5 次 track（Realtime 的每用戶端 presence 限制），且最後的狀態一定會送出。
pub struct PresenceThrottle {
    last_sent: Option<f64>,           // 上次送出的時間；重新加入時保留，6.5 秒的間隔跨重新加入仍然成立（需求 15.3、15.6）
    sent: Option<PresenceMeta>,       // 目前這次加入 Trip_Channel 之後最後送出的內容；重新加入時清空（需求 15.5）
    pending: Option<PresenceMeta>,    // 還不能送出的最新一筆（需求 15.4）
}

impl PresenceThrottle {
    pub const MIN_GAP_MS: f64 = 6_500.0;
    pub fn offer(&mut self, meta: PresenceMeta, now_ms: f64) -> ThrottleAction;
    pub fn wake(&mut self, now_ms: f64) -> ThrottleAction;
    /// 每次加入 Trip_Channel 成功後呼叫；呼叫端接著以這個分頁目前的 Presence_Meta 呼叫 offer()（需求 15.6）。
    pub fn on_rejoin(&mut self);
}

// ── 編輯者頭像（實作見演算法 A13）──

/// 頭像上的字。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AvatarInitial {
    /// 修剪後顯示名稱的第一個擴充字素叢集，例如「陳」、「é」（e 加 U+0301）、「👨‍👩‍👧」、「🇹🇼」。
    Grapheme(String),
    /// 顯示名稱修剪後是空的。
    Placeholder,
}

/// 中性符號（U+30FB）；內建字型的介面子集已包含這個字。
pub const AVATAR_PLACEHOLDER: &str = "・";

impl AvatarInitial {
    /// Placeholder 回傳 AVATAR_PLACEHOLDER。
    pub fn as_str(&self) -> &str;
}

pub fn avatar_initial(display_name: &str) -> AvatarInitial;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Rgb(pub u8, pub u8, pub u8);

impl Rgb {
    /// "#rrggbb"
    pub fn hex(self) -> String;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AvatarColor { pub background: Rgb, pub text: Rgb }

/// 與 styles.css 的 --ink 相同。
pub const INK: Rgb = Rgb(0x3e, 0x3a, 0x39);
pub const WHITE: Rgb = Rgb(0xff, 0xff, 0xff);

/// 12 個柔和色，配合現有插畫與旅伴顏色的色調。文字色在設計時從 INK 與 WHITE 中選對比較高者，
/// 結果每一色都是 INK；註解是 WCAG 2.x 公式算出的對比值，測試會重算並確認都不低於 4.5:1。
pub const AVATAR_PALETTE: [AvatarColor; 12] = [
    AvatarColor { background: Rgb(0xf0, 0xa0, 0x8c), text: INK },   // 珊瑚    5.41:1
    AvatarColor { background: Rgb(0xf4, 0xb9, 0x8a), text: INK },   // 蜜桃    6.50:1
    AvatarColor { background: Rgb(0xf2, 0xcc, 0x5e), text: INK },   // 向日葵  7.26:1
    AvatarColor { background: Rgb(0xcb, 0xd6, 0x7a), text: INK },   // 嫩芽    7.19:1
    AvatarColor { background: Rgb(0xa8, 0xd0, 0x8d), text: INK },   // 青草    6.46:1
    AvatarColor { background: Rgb(0x8e, 0xd3, 0xb4), text: INK },   // 薄荷    6.49:1
    AvatarColor { background: Rgb(0x85, 0xcf, 0xd5), text: INK },   // 湖水    6.36:1
    AvatarColor { background: Rgb(0x9e, 0xc4, 0xec), text: INK },   // 天空    6.19:1
    AvatarColor { background: Rgb(0xb4, 0xb7, 0xf0), text: INK },   // 長春花  5.87:1
    AvatarColor { background: Rgb(0xcd, 0xb3, 0xe8), text: INK },   // 薰衣草  6.00:1
    AvatarColor { background: Rgb(0xf2, 0xb0, 0xc9), text: INK },   // 櫻花    6.33:1
    AvatarColor { background: Rgb(0xd9, 0xbf, 0xa1), text: INK },   // 奶茶    6.38:1
];

/// 由帳號 id 決定；只用整數運算與查表。
pub fn avatar_color(user: UserId) -> AvatarColor;

/// 從 INK 與 WHITE 中選對比較高的文字色；只在建立與檢查色盤時使用，執行時不呼叫。
pub fn readable_text_on(background: Rgb) -> Rgb;
/// WCAG 2.x 的相對亮度與對比值。
pub fn relative_luminance(c: Rgb) -> f64;
pub fn contrast_ratio(a: Rgb, b: Rgb) -> f64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditorAvatar {
    pub user: UserId,
    pub display_name: String,       // 已修剪，最多 30 個字元
    pub initial: AvatarInitial,
    pub color: AvatarColor,
}

impl EditorAvatar {
    /// 無障礙名稱：「陳小明 正在編輯」；名稱是空的時候為「有人 正在編輯」。
    pub fn label(&self) -> String;
    /// 滑鼠提示：完整的顯示名稱；名稱是空的時候為「未設定顯示名稱」。
    pub fn tooltip(&self) -> String;
}

/// 一個編輯對象上的頭像堆疊。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EditorStack {
    pub shown: Vec<EditorAvatar>,   // 最多 MAX_SHOWN 位，依帳號 id 排序
    pub hidden: Vec<String>,        // 其餘編輯者的顯示名稱，同樣依帳號 id 排序；「+N」的 N 是它的長度
}

impl EditorStack {
    pub const MAX_SHOWN: usize = 3;
    pub fn total(&self) -> usize;
    /// 「+N」的無障礙名稱：「另外 2 人正在編輯：林大華、王小美」，空的名稱寫成「有人」；沒有其餘的人時為 None。
    pub fn overflow_label(&self) -> Option<String>;
    /// 「+N」的滑鼠提示：「林大華、王小美」，空的名稱寫成「未設定顯示名稱」（需求 16.12）；沒有其餘的人時為 None。
    pub fn overflow_tooltip(&self) -> Option<String>;
    /// 開啟表單時的提示：「陳小明 正在編輯這一項」，多人時「陳小明 等 4 人正在編輯這一項」。
    pub fn notice(&self) -> String;
}

/// 依編輯對象分組：同一帳號的多個分頁只算一次；不含 viewer 自己的帳號；沒有人在編輯的對象不出現在結果中。
pub fn editor_stacks<'a>(metas: impl IntoIterator<Item = &'a PresenceMeta>, viewer: UserId)
    -> BTreeMap<EditTarget, EditorStack>;
```

#### 1.8 API 型別

```rust
// crates/core/src/api.rs（節錄）
pub struct CommandRequest { pub command_id: CommandId, pub command: Command }
pub struct CommandResponse { pub seq: Seq, pub changeset: Option<ChangeSet>, pub replayed: bool }  // None = 沒有變化

#[serde(tag = "status", rename_all = "snake_case")]
pub enum ChangesResponse { Changes { head: Seq, changesets: Vec<ChangeSet> }, SnapshotRequired { head: Seq } }

/// 錯誤回應只有這三個欄位（需求 5.5）；共用的代碼見 3.1。
pub struct ApiError { pub code: String, pub message: String, pub field: Option<String> }

pub struct SignupRequest { pub username: String, pub display_name: String, pub password: String, pub invite: Option<InviteJoin> }
pub struct InviteJoin { pub token: String, pub name: String, pub role: String }
pub struct LoginRequest { pub username: String, pub password: String }
pub struct RefreshRequest { pub refresh_token: String }
pub struct SessionDto { pub access_token: String, pub refresh_token: String, pub expires_at: i64, pub user: ProfileDto }
/// 註冊的回應：Session，附邀請時另帶加入的旅行 id，讓 Invite_Page 直接前往 Trip_Page（需求 30.18）；沒有邀請時為 null。
pub struct SignupResponse { #[serde(flatten)] pub session: SessionDto, pub trip_id: Option<TripId> }
/// 以 Invite_Link 加入的回應（需求 30.10、30.11）。
pub struct JoinResponse { pub trip_id: TripId }
pub struct ProfileDto { pub id: UserId, pub username: String, pub display_name: String, pub role: Role }

pub struct TripSummary { pub id: TripId, pub title: String, pub destination: String, pub start: Date, pub end: Date,
                         pub cover: CoverKind, pub status: TripStatus, pub member_count: u32, pub can_manage: bool }
pub struct CreateTripRequest { pub id: TripId, pub title: String, pub start: Date, pub end: Date,
                               pub destination: String, pub description: String, pub note: String, pub cover: CoverKind }

pub struct InviteCreated { pub id: Uuid, pub token: String, pub url_path: String, pub expires_at: String }
pub struct InviteListItem { pub id: Uuid, pub creator_name: String, pub created_at: String, pub expires_at: String }
pub struct InvitePreview { pub title: String, pub destination: String, pub start: Date, pub end: Date,
                           pub inviter_name: String, pub already_member: Option<bool> }
```

（每個型別都 derive `Serialize`、`Deserialize`，此處省略。）

### 2. `lm-supabase`（精簡用戶端）

#### 2.1 Realtime 協定與連線

```rust
// crates/supabase/src/realtime/protocol.rs
/// 協定 1.0.0：每個訊框是一個 JSON 物件的文字訊框。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Frame {
    pub topic: String,                 // "realtime:trip:<uuid>"；heartbeat 使用 "phoenix"
    pub event: String,                 // phx_join、phx_leave、heartbeat、access_token、presence、broadcast、phx_reply …
    pub payload: serde_json::Value,
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub join_ref: Option<String>,
}

pub fn join_frame(topic: &str, join_ref: &str, access_token: &str, presence_key: &str) -> Frame {
    Frame {
        topic: format!("realtime:{topic}"),
        event: "phx_join".into(),
        payload: serde_json::json!({
            "config": {
                "broadcast": { "ack": false, "self": false },
                "presence": { "enabled": true, "key": presence_key },
                "postgres_changes": [],
                "private": true
            },
            "access_token": access_token
        }),
        reference: Some(join_ref.into()),
        join_ref: Some(join_ref.into()),
    }
}

pub enum Inbound {
    JoinOk { topic: String },
    JoinError { topic: String, reason: String },   // 例如 "InvalidJWTExpiration: Token has expired …"
    Broadcast { topic: String, event: String, payload: serde_json::Value },
    PresenceState { topic: String, state: serde_json::Value },
    PresenceDiff { topic: String, joins: serde_json::Value, leaves: serde_json::Value },
    ChannelClosed { topic: String },               // phx_close
    ChannelError { topic: String },                // phx_error
    System { topic: String, status: String, message: String },   // 例如 "Token has expired …"、"Client presence rate limit exceeded"；之後會收到 phx_close
    HeartbeatOk,
    Other,
    // 以下兩種不是收到的訊框，而是 PhoenixSocket 自己產生的事件
    JoinTimeout { topic: String },                 // 送出 phx_join 後 10 秒內沒有 phx_reply（需求 11.7）
    Disconnected,                                  // WebSocket 關閉、無法建立，或 heartbeat 20 秒內沒有回覆而主動關閉
}

pub fn decode(text: &str) -> Result<Inbound, ProtocolError>;
pub fn encode(frame: &Frame) -> String;
```

```rust
// crates/supabase/src/realtime/socket.rs（不依賴瀏覽器，可在原生環境測試）
pub trait RealtimeTransport {
    fn connect(&mut self, url: &str);
    fn send(&mut self, text: &str);
    fn close(&mut self);
}

pub enum SocketEvent { Opened, Text(String), Closed { code: u16 } }

pub enum Conn { Idle, Connecting, Open, Backoff { attempt: u32, until_ms: f64 } }

pub struct PhoenixSocket<T: RealtimeTransport> {
    transport: T,
    url: String,                                    // 同源的 /realtime/v1/websocket?vsn=1.0.0
    conn: Conn,
    channels: BTreeMap<String, ChannelState>,       // topic → { join_ref, joined, presence_key }
    next_ref: u64,
    pending_heartbeat: Option<String>,
    access_token: String,
}

impl<T: RealtimeTransport> PhoenixSocket<T> {
    pub const HEARTBEAT_MS: f64 = 20_000.0;         // 文件要求至少每 25 秒一次；從連線開啟起算
    pub const HEARTBEAT_TIMEOUT_MS: f64 = 20_000.0; // 下一次該送 heartbeat 時仍沒有回覆：關閉連線並開始退避（需求 11.7）
    pub const JOIN_TIMEOUT_MS: f64 = 10_000.0;      // phx_join 送出後 10 秒內沒有 phx_reply：回報 JoinTimeout
    /// 連續的第 1–4 次重試分別等 1、2、5、10 秒，第 5 次起都等 10 秒；各加上 0–20% 的抖動（由建立時傳入的抖動來源決定，
    /// 測試可以指定）。間隔從偵測到中斷時起算，同時發生的多個中斷只算一次；重新加入成功後從 1 秒重新開始。
    pub const BACKOFF_MS: [f64; 4] = [1_000.0, 2_000.0, 5_000.0, 10_000.0];
    /// 登記要加入的頻道：WebSocket 連上時（包括每次重新連線之後）對每個登記的頻道各送出一次 phx_join，帶目前的 access token。
    pub fn join(&mut self, topic: &str, presence_key: &str);
    pub fn leave(&mut self, topic: &str);
    /// 立即重送 phx_join（換發 Session 之後，需求 11.8、11.9）。
    pub fn rejoin_now(&mut self, topic: &str);
    /// 依退避間隔重送 phx_join；WebSocket 已關閉時先重新建立（需求 11.7、15.13）。
    pub fn rejoin_after_backoff(&mut self, topic: &str, now_ms: f64);
    pub fn track(&mut self, topic: &str, meta: &PresenceMeta);    // event "presence"，payload { type, event: "track", payload }
    pub fn set_access_token(&mut self, token: &str);              // 對每個已加入的頻道送 access_token；之後的 phx_join 也帶新 token
    pub fn on_event(&mut self, ev: SocketEvent, now_ms: f64) -> Vec<Inbound>;
    pub fn tick(&mut self, now_ms: f64) -> Vec<Inbound>;          // heartbeat、heartbeat 與 phx_join 逾時、退避後重連
}
```

`crates/supabase/src/realtime/web.rs`（`#[cfg(target_arch = "wasm32")]`，feature `web`）以 `web_sys::WebSocket` 實作 `RealtimeTransport`，把 `onopen`、`onmessage`、`onclose` 轉成 `SocketEvent` 放進佇列，由 `lm-web` 的同步引擎取出並呼叫 `on_event`；計時用 `gloo-timers`。

#### 2.2 GoTrue

```rust
// crates/supabase/src/gotrue.rs（feature server）
#[async_trait::async_trait]
pub trait AuthBackend: Send + Sync {
    /// POST /auth/v1/admin/users（service key），email_confirm = true
    async fn create_user(&self, email: &str, password: &str, meta: &serde_json::Value) -> Result<UserId, AuthError>;
    /// DELETE /auth/v1/admin/users/{id}：註冊流程後半失敗時的補償
    async fn delete_user(&self, id: UserId) -> Result<(), AuthError>;
    /// POST /auth/v1/token?grant_type=password
    async fn password_grant(&self, email: &str, password: &str) -> Result<GoTrueSession, AuthError>;
    /// POST /auth/v1/token?grant_type=refresh_token
    async fn refresh(&self, refresh_token: &str) -> Result<GoTrueSession, AuthError>;
    /// POST /auth/v1/logout?scope=local（使用者的 access token）
    async fn logout(&self, access_token: &str) -> Result<(), AuthError>;
}

/// 每個呼叫 10 秒逾時（需求 4.11、4.15）。
pub struct GoTrueHttp { base: reqwest::Url, anon_key: String, service_key: String, http: reqwest::Client }

/// InvalidCredentials：密碼不正確，或 refresh token 不存在、已撤銷、超過 10 秒的重用間隔（需求 4.2、4.9）；
/// AlreadyExists：email 已存在（需求 3.6）；InvalidEmail：拒收合成 email（需求 3.11）；RateLimited：Auth_Service 回應 429；
/// Upstream：無法連線、10 秒內沒有回應、5xx，或無法解析的回應。
pub enum AuthError { InvalidCredentials, AlreadyExists, InvalidEmail, WeakPassword(String), RateLimited, Upstream(String) }
```

#### 2.3 JWT 驗證

```rust
// crates/supabase/src/jwt.rs（feature server）
#[derive(Clone, Debug, Deserialize)]
pub struct Claims { pub sub: Uuid, pub exp: i64, pub aud: String, pub role: String, pub session_id: Option<Uuid> }

#[async_trait::async_trait]
pub trait TokenVerifier: Send + Sync {
    async fn verify(&self, token: &str) -> Result<Claims, JwtError>;
}

/// 舊式對稱金鑰（JWT_SECRET，HS256）。
pub struct Hs256Verifier { key: jsonwebtoken::DecodingKey }
/// 非對稱金鑰（ES256）：讀取 {SUPABASE_URL}/auth/v1/.well-known/jwks.json，快取 10 分鐘；遇到未知的 kid 立即重抓一次。
pub struct JwksVerifier { url: reqwest::Url, cache: tokio::sync::RwLock<JwkCache> }
/// 依 JWT header 的 alg 選擇；只接受 HS256 與 ES256。
pub struct AnyVerifier { hs256: Option<Hs256Verifier>, jwks: Option<JwksVerifier> }
```

驗證規則：`aud == "authenticated"`、`role == "authenticated"`、`exp` 允許 30 秒時鐘誤差、`sub` 必須對應到 `app.profiles` 中的帳號。支援兩種簽章，是因為自架 Supabase 預設仍以 `JWT_SECRET` 簽 HS256，但可以用 `add-new-auth-keys.sh` 改成 ES256 並由 JWKS 公開公鑰（[New API Keys and Asymmetric Authentication](https://supabase.com/docs/guides/self-hosting/self-hosted-auth-keys)）；CLI 也可以以 `signing_keys_path` 設定非對稱金鑰。

### 3. `lm-server`

#### 3.1 HTTP API

所有 `/api/*` 回應都是 `Content-Type: application/json`，包括錯誤與沒有資料的成功回應（例如登出回 `{}`）；錯誤為 `ApiError { code, message, field }`，`message` 是可直接顯示的繁體中文，不含 Database、Auth_Service 或程式內部的錯誤文字（需求 5.5）。除了註冊、登入、換發與邀請預覽，其他端點都要 `Authorization: Bearer <access token>`；身分只取 token 的 `sub`，帳號名稱、Display_Name 與角色一律讀 `app.profiles`（需求 5.6）。因為不使用 cookie，不需要 CSRF token，回應也不含 `Set-Cookie`。

`/api` 的路由器有自己的 fallback 與 method-not-allowed fallback，所以 `/api/*` 下不存在的路徑一律回 JSON 404，不會落到前端的 `index.html`（需求 5.9）。一個請求依下列順序判斷，回應第一個不通過的：

1. 路徑不存在 → 404 `api_not_found`；方法不支援 → 405 `method_not_allowed`（不論是否帶 access token）。
2. Public_Endpoint 以外的端點：沒有 `Authorization: Bearer <token>`、token 是空字串，或不是 Valid_Access_Token → 401 `unauthorized`（需求 5.1）。Public_Endpoint 忽略這個標頭；邀請預覽在沒有有效 token 時當作未登入（需求 5.8）。
3. 路徑中的旅行 id 不是 UUID → 404「找不到這趟旅行。」，與非成員的回應完全相同（需求 6.2）。
4. 查詢參數或請求內容的格式不正確（不是 `application/json`、JSON 語法錯誤、缺少欄位或型別不符、`after` 不是非負整數）→ 400 `invalid_request`（需求 5.9、7.20）。axum 的 `Json`、`Query` 與 `Path` 包在自訂的擷取器中，把各自的拒絕轉成上面的 `ApiError`；`AuthUser` 擷取器排在它們之前。
5. 交給處理函式。

共用的錯誤（`field` 都是 `null`）：

| 狀態 | `code` | `message` | 情況 |
|---|---|---|---|
| 401 | `unauthorized` | 請先登入。 | 需求 5.1 |
| 404 | `api_not_found` | 找不到這個 API。 | `/api/*` 下不存在的路徑 |
| 405 | `method_not_allowed` | 不支援這個操作。 | 路徑存在但方法不支援 |
| 400 | `invalid_request` | 資料格式不正確。 | 需求 5.9 |
| 404 | `trip_not_found` | 找不到這趟旅行。 | 非成員、旅行不存在或已刪除、旅行 id 不是 UUID（需求 6.2、6.3） |
| 500 | `internal_error` | 伺服器暫時無法處理，請稍後再試。 | Database 或 Auth_Service 無法使用、JWKS 讀取失敗、提交失敗等未預期的錯誤；記錄錯誤但不記錄 token 與密碼（需求 5.10、7.16） |

註冊、登入與換發另有自己的訊息（3.3）：例如註冊失敗的 500「註冊暫時無法使用，請聯絡管理員。」、註冊後取得 Session 失敗的 503，以及登入與換發時 Auth_Service 無法使用的 503 與 429；這些不以 401 回應。

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/api/auth/signup` | 註冊 → `SignupResponse`；可附邀請（一次完成註冊與加入旅行，回應帶加入的旅行 id，需求 30.18）；`LM_PUBLIC_SIGNUP=false` 時沒有邀請一律 403 |
| POST | `/api/auth/login` | 帳號名稱與密碼 → `SessionDto` |
| POST | `/api/auth/refresh` | refresh token → 新的 `SessionDto` |
| POST | `/api/auth/logout` | 撤銷這個裝置的 refresh token；一律回 200 `{}` |
| GET | `/api/me` | 目前帳號 |
| GET | `/api/trips` | 我參加的旅行（`TripSummary[]`） |
| POST | `/api/trips` | 建立旅行 → `TripSummary`；建立者自動成為綁定的旅伴（名字為 Display_Name 經 Participant_Name，角色「這趟的召集人」，顏色 coral；需求 17.3、17.5）。旅行 id 已被使用時（包括同一個 id 的兩個請求同時送達）不建立第二趟：請求者是那趟旅行的 Trip_Owner、旅行也沒有被刪除時，回傳既有的旅行，不依這次的內容修改；其他情況 409「無法建立這趟旅行，請關閉表單後重新建立。」，不回傳那趟旅行的任何內容（需求 17.4） |
| DELETE | `/api/trips/{id}` | 刪除旅行（管理者）；設定 `deleted_at`，並推送 `trip_deleted` |
| GET | `/api/trips/{id}/snapshot` | `Snapshot` |
| GET | `/api/trips/{id}/changes?after=N` | `ChangesResponse`；落後超過 500 個 seq 時回 `snapshot_required` |
| GET | `/api/trips/{id}/head` | `{ seq }` |
| POST | `/api/trips/{id}/commands` | `CommandRequest` → `CommandResponse` |
| GET | `/api/trips/{id}/invites` | 有效的邀請連結（管理者看全部，其他人看自己的） |
| POST | `/api/trips/{id}/invites` | 建立邀請連結 → `InviteCreated`（`url_path` 為 `/invite/<token>`） |
| POST | `/api/trips/{id}/invites/{invite_id}/revoke` | 撤銷 |
| GET | `/api/invites/{token}` | 預覽（不需登入；有登入時另回 `already_member`） |
| POST | `/api/invites/{token}/join` | 以目前帳號加入（`{ name, role }`）→ `JoinResponse`；已是成員時直接回傳旅行 id |
| GET（WebSocket） | `/realtime/v1/websocket` | 轉送到 Supabase Realtime |
| GET | 其他路徑（不在 `/api/` 之下，也不是 `/realtime/v1/websocket`） | `LM_STATIC_DIR` 的靜態檔；找不到時回 `index.html`（前端路由）；不回傳 `LM_STATIC_DIR` 之外的檔案（需求 32.2） |

#### 3.2 命令執行器與儲存層

```rust
// crates/server/src/commands.rs
pub async fn execute(st: &AppState, user: &AuthUser, trip: TripId, req: CommandRequest)
    -> Result<CommandResponse, ApiError>;

// crates/server/src/repo/mod.rs
pub struct TripHead { pub owner: UserId, pub seq: Seq, pub next_ordinal: u64 }

/// SELECT owner_id, seq, next_ordinal FROM app.trips WHERE id = $1 AND deleted_at IS NULL FOR UPDATE
pub async fn lock_trip(tx: &mut PgTx, trip: TripId) -> sqlx::Result<Option<TripHead>>;
pub async fn person_of(tx: &mut PgTx, trip: TripId, user: UserId) -> sqlx::Result<Option<PersonId>>;
/// 每張表一個 SELECT；子表（乘客、停靠點、參加者、餐點連結、打包、分攤）以 array_agg 併進父列。
pub async fn load_trip(tx: &mut PgTx, trip: TripId) -> sqlx::Result<TripState>;
/// 只與同一趟旅行的 Change_Log 比對（需求 7.14）；呼叫前已確認請求者是 Trip_Member 或 Admin（需求 6.2）。
pub async fn changeset_by_command(tx: &mut PgTx, trip: TripId, id: CommandId) -> sqlx::Result<Option<ChangeSet>>;
/// 父列 upsert（ON CONFLICT (trip_id, id) DO UPDATE），子表整組替換；刪除依 Slot。
/// 外鍵都是 DEFERRABLE INITIALLY DEFERRED，寫入順序不影響結果，提交時統一檢查。
pub async fn write_changes(tx: &mut PgTx, trip: TripId, changes: &[Change]) -> sqlx::Result<()>;
/// UPDATE app.trips SET seq, next_ordinal, updated_at；INSERT INTO app.trip_changes（觸發推送）
pub async fn finish(tx: &mut PgTx, trip: TripId, seq: Seq, next_ordinal: u64, cs: &ChangeSet) -> sqlx::Result<()>;
/// BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY；以交易當下的 Head 作為 Snapshot 的 seq；
/// 沒有綁定旅伴的檢視者（Unbound_Admin）不含 Ledger_Rows（需求 6.12、12.8）
pub async fn snapshot(pool: &PgPool, trip: TripId, viewer: &Viewer) -> sqlx::Result<Snapshot>;
/// Head − after > 500 時回 SnapshotRequired { head }（需求 12.5）；否則回 head，以及 seq 在 (after, head] 的每一個
/// Change_Set，依 seq 遞增、每個 seq 恰好一個，after ≥ head 時是空的清單（需求 12.15）。Unbound_Admin 的每個
/// Change_Set 以 without_ledger() 回應：省略 Ledger_Rows 之後沒有任何變化的 Change_Set 仍以它的 seq 保留在清單中，
/// 所以 LM_Web 不會以為缺號（需求 6.12、12.15）。
pub async fn changes_after(pool: &PgPool, trip: TripId, after: Seq, viewer: &Viewer) -> sqlx::Result<ChangesResponse>;
```

第一版每個命令都重新讀取整趟旅行（約 14 個 SELECT）。本機資料庫上每個查詢不到 1 毫秒，一個命令約 10–20 毫秒；若之後需要，可以加上以 `(trip, seq)` 為鍵的記憶體快取，因為 `lm-server` 是唯一的寫入者，`seq` 相同就代表內容相同。

#### 3.3 登入代理（BFF）

| 端點 | 處理 |
|---|---|
| `signup` | 依序檢查，只回應第一個不通過的（需求 3.1）：帳號名稱原樣比對 `^[a-z][a-z0-9-]{2,31}$`，不轉換大小寫也不去除空白（400「帳號名稱需為 3–32 個字元：以小寫英文字母開頭，只能使用小寫英文字母、數字或連字號（-）。」，`field` 為 `username`）；保留字沿用現行的 api、admin、setup、login、register、logout、demo、assets，另加 invite，因為 `/invite/:token` 與 `/:user/home` 共用第一段路徑（400「這個帳號名稱是系統保留字，請換一個。」）；顯示名稱經 Participant_Name 後超過 30 字、含 Hidden_Control_Char，或 Participant_Key 經 Trim_White 後是空的（400「請填寫 1–30 個字的顯示名稱，不能只有空白或包含隱藏控制字元。」）；原樣的密碼 12–72 個字元而且 UTF-8 不超過 72 位元組（400「密碼需為 12–72 個字元，而且不超過 72 個位元組（一個中文字占 3 個位元組）。」）；沒有邀請而 `LM_PUBLIC_SIGNUP` 為 false（403「目前只接受以邀請連結註冊。」）；附邀請時連結可以使用（需求 30.13）→ GoTrue 以 admin API 建立 email 已確認的使用者（email 已存在：409「這個帳號名稱已被使用。」；拒收 email、無法連線或其他錯誤：500「註冊暫時無法使用，請聯絡管理員。」並記錄原因，需求 3.11）→ 同一個資料庫交易建立 `app.profiles`（空資料庫的第一個帳號為 admin）與（有邀請時）加入旅行 → 交易失敗時刪除剛建立的 GoTrue 使用者、回應原本的錯誤（需求 3.10）→ 以密碼登入取得 Session；這一步失敗時保留 Account，回應 503「帳號已建立，但暫時無法登入，請稍後到登入頁登入。」（需求 3.16） |
| `login` | 帳號名稱先 Trim_White 並把 A–Z 轉成小寫（需求 4.1），轉成合成 email → `password_grant`（密碼原樣）→ 讀取 profile → `SessionDto`。帳號名稱或密碼缺少、正規化後是空的、格式不符、是保留字或不存在、密碼是空的或超過 72 位元組或不正確、使用者沒有 profile：一律 401「帳號或密碼不正確。」（需求 4.2）。Auth_Service 無法連線、10 秒內沒有回應或 5xx：503 `auth_unavailable`「暫時無法登入，請稍後再試。」；速率限制：429 `auth_rate_limited`「嘗試次數過多，暫時無法登入，請稍後再試。」（需求 4.15） |
| `refresh` | `refresh` → `SessionDto`；refresh token 不存在、已撤銷、在重用間隔之後重複使用，或 Account 已不存在：401（需求 4.9）；Auth_Service 無法使用時與 `login` 相同的 503 與 429 |
| `logout` | `logout`（`scope=local`，只撤銷這個裝置的 refresh token，需求 4.11）；Auth_Service 回應錯誤、無法連線或 10 秒內沒有回應時也回 200（前端仍會清除本機 token） |

GoTrue 本身有登入與註冊的速率限制；第一版不另外加。

#### 3.4 Realtime 轉送

```rust
// crates/server/src/gateway.rs
/// 瀏覽器連 /realtime/v1/websocket?vsn=1.0.0；lm-server 連上游並補上 apikey，之後雙向逐訊框轉送。
/// 不解析內容：頻道授權由 Realtime 以使用者 JWT 與 RLS 決定。
pub async fn realtime_proxy(ws: WebSocketUpgrade, State(st): State<AppState>, RawQuery(query): RawQuery) -> Response {
    let upstream = st.config.realtime_upstream_url(query.as_deref()); // 只保留 vsn，加上 apikey=<anon key>
    ws.on_upgrade(move |client| async move {
        match tokio_tungstenite::connect_async(upstream.as_str()).await {
            Ok((server, _)) => pump(client, server).await,      // Text、Binary、Ping、Pong、Close 雙向轉送；任一端關閉就關閉另一端
            Err(error) => tracing::warn!(%error, "realtime upstream connect failed"),
        }
    })
}
```

#### 3.5 設定與啟動檢查

| 環境變數 | 必要 | 未設定時 | 格式 | 範例（CLI 堆疊） | 用途 |
|---|---|---|---|---|---|
| `LM_BIND` | 否 | `127.0.0.1:8080` | `<IPv4>:<埠>` 或 `[<IPv6>]:<埠>`，埠 1–65535；不接受主機名稱（例如 `localhost:8080`） | `127.0.0.1:8080` | 監聽位址 |
| `DATABASE_URL` | 是 | | 以 `postgres://` 或 `postgresql://` 開頭 | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` | sqlx 連線 |
| `SUPABASE_URL` | 是 | | 以 `http://` 或 `https://` 開頭 | `http://127.0.0.1:54321` | API gateway（Auth、Realtime、JWKS） |
| `SUPABASE_ANON_KEY` | 是 | | | `supabase status -o env` 的 anon key | Realtime 連線的 `apikey`、GoTrue 公開端點 |
| `SUPABASE_SERVICE_KEY` | 是 | | | `supabase status -o env` 的 service_role key | GoTrue admin API；只存在伺服器 |
| `SUPABASE_JWT_SECRET` | 否 | 只以 JWKS 驗證，HS256 的 token 一律無效 | | `supabase status -o env` 的 JWT secret | HS256 驗證 |
| `LM_AUTH_EMAIL_DOMAIN` | 否 | `users.little-moments.invalid` | | `users.little-moments.invalid` | 合成 email 的網域 |
| `LM_PUBLIC_SIGNUP` | 否 | `true` | 只接受 `true` 與 `false`（`TRUE`、`0` 等都不接受） | `true` | 是否開放不經邀請的註冊 |
| `LM_STATIC_DIR` | 是 | | | `crates/web/dist` | 前端檔案 |

啟動時依序進行，任何一步失敗都在開始監聽之前於終端機印出原因，並以非 0 的結束代碼結束：

1. **讀取設定**（需求 2.7）：工作目錄或其上層目錄中最近的 `.env` 只補上環境中沒有設定的變數（`dotenvy`）；每個值先經 Trim_White，結果是空字串時視同未設定。
2. **檢查格式**（需求 2.11、3.12）：一次列出每個未設定的必要變數，以及格式不符的變數名稱與原因；訊息不含 `DATABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_KEY` 與 `SUPABASE_JWT_SECRET` 的值。
3. **範例金鑰**（需求 2.6，B12）：`LM_BIND` 不是 Loopback_Address（`0.0.0.0` 與 `::` 也不是），而 `SUPABASE_JWT_SECRET`、`SUPABASE_ANON_KEY` 或 `SUPABASE_SERVICE_KEY` 與 Supabase CLI 公開的範例值完全相同時，印出 `LM_BIND` 的值與這些變數的名稱（不含值）。範例值在實作時從 CLI 的 `supabase status` 輸出複製成常數。
4. **連上 Database**（需求 2.12）：30 秒內每秒重試一次；仍連不上時（例如 Local_Stack 還沒啟動），印出 Database 的主機、埠與原因，不含 `DATABASE_URL` 中的密碼。
5. **監聽**（需求 2.12）：無法在 `LM_BIND` 監聽時（埠已被使用，或位址不屬於 lm-server 所在的系統，包括在 WSL 2 中使用 Windows 網路介面的位址），印出位址與原因。

### 4. `lm-web`

#### 4.1 路由與畫面

| 路徑 | 畫面 | 沿用的現行模板（DOM 結構與 class 名稱照抄，以重用 CSS） |
|---|---|---|
| `/login`、`/register` | 登入、註冊 | `src/accounts-ui.js` 的登入與註冊表單 |
| `/invite/:token` | 邀請預覽；以連結註冊，或以目前帳號加入 | `invite()` |
| `/:user/home` | 旅行列表、建立旅行（封面選擇） | `tripCard()`、`coverPicker()` |
| `/:user/trips/:id?tab=…` | 旅行頁：封面與倒數、五個分頁（行程表、料理菜單、採買清單、裝備分工、分帳記帳）、旅行選單（編輯旅行、旅伴、車輛、邀請、刪除） | `hero()`、`trip()`、`tripMenu()`、各分頁函式 |
| `/:user/trips/:id/go` | 出發清單 | `departure()` |

**旅行頁的頁首**：沿用 `hero()`，插畫一律是營地 camp 的靜態插畫，不隨旅行的封面改變（封面只用在 Home_Page 的旅行卡片）；倒數以開始日減去台灣時間（UTC+8）今天的日期計算（需求 32.3）。旅行標題列的右側放 Trip_Card 的 Editor_Stack（需求 16.2）。

**行程表**：第一版只有「規劃行程」與「文字版」兩個區塊：選日、這一天的設定（標題、地點、預計幾點抵達與路線位置；儲存時只送出改過的欄位，需求 22.1、22.15）、每台車的路線卡片（依出發時間排列，需求 22.2）、活動（含常用活動）、當天料理（可改用餐時間）、地點與車、未分配採買清單，以及文字版與「複製文字」。

**裝備分工**（需求 27.1、27.9）：個人裝備與共用裝備兩組，各依 Ordinal 排列。每個個人裝備以旅伴名字列出依 Ordinal 排列的每位旅伴是否已打包；有負責人的共用裝備只顯示負責人是否已打包；待分配的共用裝備不顯示打包勾選。只有檢視者自己的 Bound_Person 在 My_Gear 中的勾選可以點選，其他旅伴的勾選只顯示，沒有 Bound_Person 的檢視者不能點選任何勾選。另顯示「裝備準備 done / total」（Gear_Progress），以及有待分配的共用裝備時的「還有 N 項公用裝備待分配，出發前記得找個主人。」。

**出發清單**（需求 28）：
- Trip_Member 看到自己的 Bound_Person 的行前清單：Packing_Progress（「{已打包項數} / {My_Gear 項數} 項準備完成」與百分比）、有待分配的共用裝備時的「別落下全隊的裝備」與「回去分配」、「自己的小行李」與「我負責的公用裝備」兩組 My_Gear 與打包勾選、「我負責的食材」與已買勾選（附 Shopping_Plan 分到的「第 N 天在{地點名稱}」）、「確認準備完成，出發」，以及下一個未完成的活動。
- 下一個未完成的活動取檢視者的 Bound_Person 的 Person_Activity（參加者為全體、指定旅伴中有他，或指定車輛中有他駕駛或搭乘的車）中未完成的活動，依日期、時間與 Ordinal 遞增的第一筆（需求 28.5）。
- 已確認出發時，標題改為「準備好了，一起出發！」、按鈕改為停用的「已準備完成」，並在下一個未完成的活動下方提供「完成這一站」，送出 `SetActivityDone { done: true }`（需求 28.7）。
- Unbound_Admin 只看到「你目前以管理員身分檢視」、說明「尚未加入此旅行，因此沒有個人行前清單。你仍可編輯所有旅行內容。」與「回到規劃手冊」，沒有任何勾選、下一個活動與「確認出發」（需求 28.8）。

#### 4.2 同步引擎 `TripSync`

```rust
// crates/web/src/sync/engine.rs（介面）
/// 畫面頂端的提示：Offline 時只顯示離線提示，取代重新連線與儲存失敗的提示（需求 11.14、13.11）。
pub enum ConnState { Connecting, Live, Reconnecting, Offline }

pub struct TripSync {
    trip: TripId,
    viewer: Viewer,
    replica: Replica,
    pending: VecDeque<PendingCmd>,
    view: TripState,                       // replica.state ⊕ pending
    pub stores: TripStores,                // 每種列一個 RowStore
    pub revision: RwSignal<u64>,           // view 每變一次加一；文字版、餘額等整體計算的 Memo 依它重算
    pub conn: RwSignal<ConnState>,
    pub pending_count: RwSignal<usize>,
    pub presence: RwSignal<BTreeMap<String, (String, PresenceMeta)>>,  // presence key → (phx_ref, meta)（不含這個分頁，見 4.5）
    current_meta: Option<PresenceMeta>,    // 這個分頁目前的狀態：最後一次開啟或關閉表單；重新加入後重送（需求 15.6）
    throttle: PresenceThrottle,
    pub editors: Memo<BTreeMap<EditTarget, EditorStack>>,     // editor_stacks(presence, viewer.user)：不含自己的帳號
}

impl TripSync {
    /// 本地操作：apply(Predict) 檢查並預測，放進 pending，更新受影響的列，排入送出佇列。
    pub fn submit(&mut self, command: Command) -> Result<CommandId, Rejection>;
    pub fn on_command_result(&mut self, id: CommandId, result: Result<CommandResponse, ApiError>);
    /// 推送與補齊的 Change_Set：Unbound_Admin 先丟棄 Ledger_Rows（需求 6.13）；Command_Id 屬於某個 Pending_Command 時，
    /// 合併後移除那個 Pending_Command，視為確認（需求 13.13）。
    pub fn on_broadcast(&mut self, payload: Broadcast) -> Option<Resync>;
    /// 讀取 Snapshot 不會移除 Pending_Command（需求 13.6）。
    pub fn on_snapshot(&mut self, snapshot: Snapshot);
    pub fn on_changes(&mut self, response: ChangesResponse) -> Option<Resync>;
}

pub enum Resync { ChangesAfter(Seq), Snapshot }
```

`TripSync` 存放在 `StoredValue` 中，以 Leptos context 提供給旅行頁的元件；網路工作以 `leptos::task::spawn_local` 執行。命令一次只送一個（FIFO），以保留使用者操作的先後順序，例如「新增料理，接著改它的份數」（需求 13.3）。送出佇列（`sender`）另外記住進行中的請求：排在最前面的 Pending_Command 有了結果，而且它的請求已經結束（成功、失敗或 15 秒逾時）之後，才送出下一個；推送或補齊先確認了它時，取消它尚未進行的重送，但仍等進行中的請求結束（需求 13.3、13.13）。

#### 4.3 `RowStore`：每列一個 signal

```rust
// crates/web/src/sync/store.rs（介面）
pub struct RowStore<K, T, S> {
    rows: StoredValue<HashMap<K, ArcRwSignal<T>>>,
    keys: RwSignal<Vec<K>>,          // 顯示順序；只有成員或排序鍵改變時才更新
    sort_key: fn(&T) -> S,           // 例：活動為 (day, time, ordinal)；採買為 (category 順序, ordinal)
}

impl<K: Copy + Eq + Hash, T: Clone + PartialEq, S: Ord> RowStore<K, T, S> {
    pub fn get(&self, key: K) -> Option<ArcRwSignal<T>>;
    pub fn keys(&self) -> RwSignal<Vec<K>>;
    /// next 為 None 表示刪除。內容相同時不通知任何訂閱者。
    pub fn sync(&self, key: K, next: Option<T>);
}

pub struct TripStores {
    pub card: RwSignal<TripCard>,
    pub people: RowStore<PersonId, Person, u64>,
    pub vehicles: RowStore<VehicleId, Vehicle, u64>,
    pub places: RowStore<PlaceId, Place, u64>,
    pub routes: RowStore<RouteId, Route, (Date, Option<Hm>, u64)>,
    pub day_settings: RowStore<Date, DaySetting, Date>,
    pub activities: RowStore<ActivityId, Activity, (Date, Hm, u64)>,
    pub meals: RowStore<MealId, Meal, (Date, u8, u64)>,
    pub shopping: RowStore<ShoppingId, ShoppingItem, (u8, u64)>,
    pub gear: RowStore<GearId, GearItem, (u8, u64)>,
    pub departures: RowStore<PersonId, Departure, PersonId>,
    pub expenses: RowStore<ExpenseId, Expense, (std::cmp::Reverse<Date>, u64)>,
    pub settlements: RowStore<SettlementId, Settlement, (std::cmp::Reverse<Date>, u64)>,
}
```

列表元件以 `<For each=move || store.keys().get() key=|k| *k …>` 走訪鍵，列元件只讀自己那一列的 signal。新增或刪除一列只改變 `keys`，`<For>` 依鍵只建立或移除那一個元素；改一列只通知那一列。分組顯示（採買依分類、料理依日期、活動依日期）用 `Memo` 從 `keys` 與列的分組欄位算出每組的鍵，鍵不變時 `<For>` 不動 DOM。

整體性的推導（文字版、未分配採買清單、分帳餘額、裝備進度、出發清單）以 `Memo` 依 `revision` 從 `view` 重算，這些是單一區塊的輸出，本來就整塊更新。

畫面狀態不放在 DOM 或列元件裡，而是放在旅行頁的 `UiState`：每張卡片與每個可展開區塊的展開狀態（以 Slot 為鍵的 signal）、開啟中的表單與它的草稿、Trip_Menu 是否開啟，以及 Schedule_Tab 選定的第 N 天。一列換了分組時（例如採買品項換分類、活動換日期），需求 14.3 要求在原來的組移除、在新的組重新建立元素；新元素從 `UiState` 取回展開狀態，所以展開或收合不會因為搬移而改變（需求 14.4）。

#### 4.4 登入狀態

- `SessionDto` 存在 localStorage 的 `lm.session.v1`；access token 到期前 60 秒自動換發，換發後以 `set_access_token()` 更新每個 Realtime 頻道。
- 其他分頁換發或登出時，以 `storage` 事件同步；`supabase/config.toml` 啟用 refresh token 輪替與 10 秒的重用間隔（需求 4.4），每個分頁換發之前也先讀 `lm.session.v1`，所以兩個分頁同時換發不會互相登出（需求 4.7）。
- API 回 401 時先換發一次再重試；換發失敗就前往 `/login?next=…`，並提示仍未送出的變更數量。

#### 4.5 Presence 與編輯者頭像

整體設計見 Architecture 的「誰正在編輯：Presence 與頭像」；這裡是前端的做法。

**送出自己的狀態**

- 開啟編輯卡片或列的表單時（包括依下方「開啟表單時」為唯讀的表單），把這個分頁目前的 Presence_Meta 設為 `editing = Some(target)`；關閉表單時（儲存後關閉、取消、關閉視窗、因項目被刪除而關閉，或離開旅行頁）設為 `editing = None`。每次改變都以 `offer()` 交給 `PresenceThrottle`，由它決定立即送出 `track` 或在 `WakeAt` 的時間送出（需求 15.1–15.5）。每個分頁同時最多回報一個 Edit_Target。`meta.display_name` 取自快照的 `viewer.display_name`，`meta.person` 取自 `viewer.caps.me`（Unbound_Admin 為空）。新增項目的表單、勾選，以及列上直接變更的選單不回報 Edit_Target（需求 15.12）。
- 還沒加入 Trip_Channel 時只記下目前的 Presence_Meta。每次加入成功（包括需求 11.7–11.9 與 15.13 的重新加入）先呼叫 `on_rejoin()`，再以目前的 Presence_Meta 呼叫 `offer()`，所以重新加入後一定重送最後一次開啟或關閉表單的狀態，即使與重新加入之前送出的相同；6.5 秒的最小間隔仍從重新加入之前最後一次送出起算。這個分頁從來沒有開啟或關閉過表單時不送出（需求 15.6）。
- 兩位成員的分頁都在前景並已連線時，開啟表單後 7 秒內對方看到頭像、關閉表單後 7 秒內頭像消失：最多 6.5 秒是節流的等待，其餘是傳送時間（需求 15.16、16.19、16.20）。

**接收別人的狀態**

- Presence 狀態存在 `TripSync.presence`（presence key → `(phx_ref, meta)`，每個分頁一筆，不含這個分頁自己）。`presence_state` 的完整狀態取代先前保存的全部內容，包括重新加入之前留下的（需求 15.7、16.21）；`presence_diff` 的 `leaves` 只移除 `phx_ref` 相同的那一筆，`joins` 寫入新的一筆，所以另一個分頁換了 Edit_Target 時（同一個 key 同時出現在 `leaves` 與 `joins`），保存的那一筆換成新的內容，不會遺失，也不會留下新舊兩筆。斷線或關閉的分頁由 Realtime 移除，它的頭像隨之消失。
- 無法解析成 `PresenceMeta` 的項目（例如缺少 Account id、Account id 格式不正確，或欄位型別不符）直接忽略，同一則訊息中的其他分頁照常處理，也不顯示錯誤（需求 15.8）。`display_name` 前後有空白或超過 30 個字元不算無法解析：先以 `trim_white` 修剪，再截到 30 個字元（需求 16.14）。
- `TripSync.editors` 是一個 `Memo`：以 `lm_core::presence::editor_stacks(presence.values().map(|(_, meta)| meta), viewer.user)` 把 meta 依編輯對象分組（演算法 A13）。每張卡片或每一列的 `<EditorAvatars target=…/>` 再以自己的 `Memo` 取出自己那一組；只有那一組改變時，才更新那張卡片或那一列的 DOM（B2）。

**頭像的位置與樣式**（新檔 `crates/web/styles/presence.css`）

- 位置（需求 16.2）：卡片（有自己的外框與標題列，例如料理、路線、旅伴與車輛卡片）放在標題列的右側；清單中的列（例如採買品項、裝備、支出與還款）放在名稱之後、這一列的第一個操作按鈕之前；Trip_Card（編輯旅行）放在旅行頁頁首的旅行標題列（`.trip-title-row`）右側。適用需求 15.12 的每一種 Editable_Item：路線卡片、每日設定（每個 Trip_Day 一個，不論是否已有設定）、活動、料理、採買品項、裝備、支出、還款、旅伴、車輛、地點與 Trip_Card；Trip_Menu 中的旅伴與車輛也顯示。卡片或列因切換分頁或篩選才出現時，出現時就帶著頭像；畫面上沒有那張卡片或那一列時，編輯者不顯示在其他地方（需求 16.1）。
- 尺寸：卡片上（包括旅行標題列）直徑 28px、字 14px；列中直徑 24px、字 12px。頭像之間重疊 6px，外圈 2px 用卡片底色（`box-shadow: 0 0 0 2px var(--card)`）。
- 顏色：底色與文字色以 inline style 套用 `AvatarColor`，同一個人看起來永遠一樣。「+N」用 `--soft` 底與 `--ink` 字（對比 9.97:1）。畫面一律是淺色主題（需求 32.7，見 4.7），所以不需要深色主題的對比。
- 頭像出現、消失或改變時沒有動畫與轉場，直接顯示最後的狀態（需求 16.16）。

**無障礙**（頭像不是唯一的訊號）

- 每個頭像輸出為不接受鍵盤焦點的 `<span class="editor-avatar" role="img" aria-label="陳小明 正在編輯" title="陳小明">陳</span>`：無障礙名稱來自 `EditorAvatar::label()`，滑鼠提示來自 `tooltip()`（完整的顯示名稱）。顯示名稱是空的時候，無障礙名稱為「有人 正在編輯」，滑鼠提示為「未設定顯示名稱」（需求 16.11）。
- 「+N」輸出為 `<span class="editor-avatar editor-avatar-more" role="img" aria-label="另外 2 人正在編輯：林大華、王小美" title="林大華、王小美">+2</span>`：無障礙名稱來自 `overflow_label()`，空的名稱寫成「有人」；滑鼠提示來自 `overflow_tooltip()`，空的名稱寫成「未設定顯示名稱」，例如其餘兩位是林大華與一位沒有顯示名稱的人時，為「另外 2 人正在編輯：林大華、有人」與「林大華、未設定顯示名稱」（需求 16.12）。
- 顏色只是輔助：辨識靠頭像上的字與無障礙名稱。
- `title` 的提示在觸控與鍵盤操作時看不到，所以它只放可以錯過的資訊；需要的資訊以 Editing_Notice 的文字出現在表單上（見下方「開啟表單時」）。
- 只有 Editing_Notice 的 `role="status"` 向螢幕閱讀器報告誰正在編輯；頭像、「+N」與其他 Presence 的變化不放進任何 live region，也不以 Toast 通知（需求 15.14）。
- 名稱一律以文字節點或屬性輸出（Leptos 會跳脫），不使用 `inner_html`。

**開啟表單時**（需求 15.9、15.10、15.15）

- 開啟表單時這個對象的 Editor_Stack 不是空的（至少一個其他 Account 正在編輯；自己在其他分頁或裝置上的編輯不算）：表單上方以 `role="status"` 顯示 `EditorStack::notice()`，例如「陳小明 正在編輯這一項」或「陳小明 等 4 人正在編輯這一項」，旁邊是「仍要編輯」按鈕；所有欄位唯讀，「儲存」與「移除項目」等會改變表單內容或資料的按鈕停用，只有「仍要編輯」、「取消」與關閉視窗可以使用。
- 按下「仍要編輯」：表單恢復成沒有其他人正在編輯時的樣子（欄位與按鈕依權限照常可以使用），移除「仍要編輯」，鍵盤焦點移到第一個欄位；表單關閉之前不再改回唯讀。儲存時依需求 7.8 只送出改過的欄位，LM_Core 的檢查與平常相同；LM_Server 不讀 Presence，命令的結果與沒有人正在編輯時相同（需求 15.11）。
- 表單開著時，Editing_Notice 跟著 Editor_Stack 變化：由空變成不是空的時出現，總人數或排在第一位的編輯者改變時更新文字，變成空的時移除。這些變化不改變欄位是否唯讀，也不加入或移除「仍要編輯」：開啟時可以編輯的表單之後有人開始編輯仍可以編輯；唯讀的表單在 Editor_Stack 變成空的之後仍是唯讀，直到按下「仍要編輯」或關閉表單。

**名稱的分工**

頭像、提示與「正在編輯」的文字用帳號的顯示名稱，這是使用者的選擇；旅行中其他地方照舊顯示旅伴名稱，包括負責人、參加者、打包、分帳，以及「剛更新了這一項」的提示（以 presence 的 `person` 對應到旅伴；對方已不在線上時顯示「有人剛更新了這一項」）。

#### 4.6 連線狀態與重試

| 情況 | 畫面 | 行為 |
|---|---|---|
| Realtime 已連線 | 不顯示 | |
| Realtime 重連中（需求 11.7、11.9 與 15.13 的情況，到重新加入並補齊為止） | 頂端提示「重新連線中，畫面可能不是最新」 | 命令仍經 HTTP 送出；自己的變更照常生效；重新加入並補齊後提示消失（需求 11.11） |
| 沒有網路 | 「離線中，有 N 項變更尚未送出」（N 是 Pending_Command 的數量，隨數量更新；N 為 0 時只顯示「離線中」） | 這個提示取代「儲存失敗，正在重試」與「重新連線中，畫面可能不是最新」，不同時顯示（需求 11.14、13.11）。暫停送出與重送，離線期間的失敗不計入重送次數；新的操作照常預測並排入佇列；pending 保留在記憶體，關閉或重新載入分頁會失去未送出的變更（第一版不持久化）。`online` 事件後不等剩餘的退避時間，依原本的順序、以原本的 `command_id` 逐一重送，重送次數從 0 重新計算（需求 13.12） |
| 伺服器拒絕命令（400、403、404、409） | toast 顯示 `ApiError.message` | 移除該 pending、不重送；畫面等於 Replica 只疊上其餘的 pending（不是只剩已確認的狀態），再依序送出其餘的 pending（需求 13.8、屬性 11） |
| 網路錯誤、逾時或 5xx | 「儲存失敗，正在重試」，直到這個命令有了結果 | 送出後 15 秒沒有回應就停止等待，視為逾時（需求 13.9）；保留預測，以同一個 `command_id` 與相同的內容在前一次失敗後 1、2、4、8、16 秒重送；第 5 次重送（第 6 次送出）也失敗時移除這個 pending，畫面等於 Replica 只疊上其餘的 pending，toast「儲存失敗，變更已還原」，再送出下一個（需求 13.10）。回應 401 時先依需求 4.8 換發並重試一次，不計入重送次數 |
| 自己的命令經推送或補齊先確認 | 不顯示 | 合併 Change_Set、移除 pending、取消尚未進行的重送；之後這個命令的 HTTP 回應或失敗都不再改變畫面，也不顯示儲存失敗的提示（需求 13.13） |

#### 4.7 外觀沿用（B11）

- **插畫**：`scripts/export-art.mjs`（一次性，以現有的 Bun 執行）呼叫 `src/art.js` 的 `illustration()` 與 `logo()`、`src/dish-art.js` 的 `dishIllustration()`，把每一種插畫輸出成 `crates/web/assets/art/<kind>.svg`，通用餐盤的 7 種變化輸出成 `custom-0.svg`…`custom-6.svg`。輸出檔提交進版本庫，Rust 端以 `include_str!` 嵌入、以 `inner_html` 放進固定的容器；內容是靜態的、不含使用者文字。通用餐盤的變化改由料理 id 決定（`hash(meal_id) % 7`），同一道料理不會每次重繪就換圖。執行期與建置流程都不需要 JavaScript。
- **字型**：`index.html` 以 `<link data-trunk rel="copy-dir" href="../../assets/fonts" data-target-path="assets/fonts">` 複製 `assets/fonts/*.woff2` 與授權檔；`src/styles.css` 的 `@font-face` 路徑（`./assets/fonts/…`）不用改。
- **樣式**：把 `src/styles.css`、`src/accounts.css`、`src/expenses.css` 複製到 `crates/web/styles/`，以 `<link data-trunk rel="css">` 載入；Leptos 元件輸出與現行模板相同的元素結構與 class（例如 `.shopping-row>label`、`.gear-row>select` 依賴直接子元素的位置）。只在行程繪本、場景動畫與滑動手勢的選擇器上做刪減。唯一新增的樣式是編輯者頭像的 `presence.css`（4.5），只使用既有的 `--card`、`--soft`、`--ink` 變數，不定義新的變數；Editing_Notice、「仍要編輯」與連線、儲存狀態的提示只用現行樣式檔中已有的 class（需求 32.8）。
- **主題**：現行樣式以 `:root[data-theme=dark]` 選擇深色主題，沒有 `prefers-color-scheme` 的規則；LM_Web 不設定 `data-theme`，所以畫面一律是淺色主題，不隨作業系統的深色模式改變（需求 32.7）。

```toml
# crates/web/Trunk.toml
[build]
target = "index.html"
dist = "dist"

[serve]
addresses = ["127.0.0.1"]
port = 8081

[[proxy]]
backend = "http://127.0.0.1:8080/api/"

[[proxy]]
backend = "ws://127.0.0.1:8080/realtime/v1/websocket"
ws = true
```

## Data Models

### 資料表（`supabase/migrations/20260101000000_app_schema.sql`）

設計原則：

- 一個項目一列。多對多的集合（車輛乘客、停靠點、活動參加者、採買品項與料理的連結、打包勾選、支出的分攤旅伴）放在子表；線上格式把子表併進父列，所以子表的變化會讓父列的 `version` 前進。
- 每張旅行內容表的主鍵都是 `(trip_id, id)`，外鍵也都包含 `trip_id`，所以任何一列都不可能引用別趟旅行的列。
- 外鍵一律 `DEFERRABLE INITIALLY DEFERRED`，在提交時檢查；`write_changes()` 因此不需要排序寫入。
- `version` 是最後修改這一列的 `seq`；`ordinal` 是在這趟旅行中的建立順序（取代現行陣列的順序，例如決定哪台車是 Buyer_Car）。
- 時刻以 `text` 加 CHECK 存成 `HH:MM`；日期用 `date`；長度用 `char_length()`（以字元計，與現行 `[...text].length` 相同）。
- CHECK 與外鍵只是最後防線，錯誤訊息由 `lm-core` 產生；資料庫擋下的提交代表程式有錯，回 500 並整個回滾。

```sql
-- 應用資料表放在 app schema：不在 PostgREST 的 api.schemas 中，anon 與 authenticated 沒有任何資料表權限。
-- lm-server 以資料表擁有者連線；所有資料表都啟用 RLS 且不建立政策，作為防線。
create schema app;
revoke all on schema app from public;

create table app.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  username     text not null unique check (username ~ '^[a-z][a-z0-9-]{2,31}$'),
  display_name text not null check (char_length(display_name) between 1 and 30),
  role         text not null default 'member' check (role in ('admin', 'member')),
  created_at   timestamptz not null default now()
);

create table app.trips (
  id           uuid primary key,
  owner_id     uuid not null references app.profiles(user_id),
  title        text not null check (char_length(title) between 1 and 100),
  destination  text not null default '' check (char_length(destination) <= 100),
  start_date   date not null,
  end_date     date not null,
  description  text not null default '' check (char_length(description) <= 1000),
  note         text not null default '' check (char_length(note) <= 1000),
  cover_kind   text not null default 'camp'
               check (cover_kind in ('camp', 'mountain', 'lake', 'night', 'forest', 'beach', 'sunrise')),
  status       text not null default 'planning' check (status in ('planning', 'completed')),
  seq          bigint not null default 0,      -- 最後一次提交的序號
  next_ordinal bigint not null default 0,      -- 下一個新列的建立順序
  version      bigint not null default 0,      -- 旅行卡片本身最後被修改的 seq
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,                     -- 刪除旅行只設定這個欄位，可以復原
  check (end_date >= start_date and end_date - start_date <= 30)
);

-- 旅伴。user_id 不為空表示綁定了帳號；旅行成員資格 = 這趟旅行有一位旅伴綁定了該帳號。
create table app.people (
  trip_id  uuid not null references app.trips(id) on delete cascade,
  id       uuid not null,
  user_id  uuid references app.profiles(user_id),
  name     text not null check (char_length(name) between 1 and 30),
  name_key text not null,                       -- participant_key(name)
  role     text not null default '' check (char_length(role) <= 60),
  color    text not null check (color in ('coral', 'blue', 'green', 'yellow', 'lavender', 'peach')),
  ordinal  bigint not null,
  version  bigint not null,
  primary key (trip_id, id),
  unique (trip_id, user_id),
  unique (trip_id, name_key) deferrable initially deferred
);
create index people_user on app.people (user_id) where user_id is not null;

create table app.places (
  trip_id  uuid not null references app.trips(id) on delete cascade,
  id       uuid not null,
  name     text not null check (char_length(name) between 1 and 50),
  name_key text not null,                       -- place_key(name)；與旅行目的地的比對由 lm-core 檢查
  ordinal  bigint not null,
  version  bigint not null,
  primary key (trip_id, id),
  unique (trip_id, name_key) deferrable initially deferred
);

create table app.vehicles (
  trip_id   uuid not null references app.trips(id) on delete cascade,
  id        uuid not null,
  name      text not null check (char_length(name) between 1 and 50),
  driver_id uuid,
  seats     smallint not null check (seats between 1 and 9),
  color     text check (color ~ '^#[0-9a-f]{6}$'),
  ordinal   bigint not null,
  version   bigint not null,
  primary key (trip_id, id),
  foreign key (trip_id, driver_id) references app.people (trip_id, id) deferrable initially deferred
);

create table app.vehicle_passengers (
  trip_id    uuid not null,
  vehicle_id uuid not null,
  person_id  uuid not null,
  primary key (trip_id, vehicle_id, person_id),
  foreign key (trip_id, vehicle_id) references app.vehicles (trip_id, id) on delete cascade deferrable initially deferred,
  foreign key (trip_id, person_id) references app.people (trip_id, id) deferrable initially deferred
);

-- 路線端點與停靠點的 place_id 為 NULL 時代表旅行目的地。
create table app.routes (
  trip_id       uuid not null references app.trips(id) on delete cascade,
  id            uuid not null,
  day           date not null,
  vehicle_id    uuid not null,
  from_place_id uuid,
  to_place_id   uuid,
  depart_time   text check (depart_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ordinal       bigint not null,
  version       bigint not null,
  primary key (trip_id, id),
  unique (trip_id, day, vehicle_id) deferrable initially deferred,
  foreign key (trip_id, vehicle_id) references app.vehicles (trip_id, id) deferrable initially deferred,
  foreign key (trip_id, from_place_id) references app.places (trip_id, id) deferrable initially deferred,
  foreign key (trip_id, to_place_id) references app.places (trip_id, id) deferrable initially deferred
);

create table app.stops (
  trip_id   uuid not null,
  id        uuid not null,
  route_id  uuid not null,
  position  smallint not null check (position between 0 and 5),
  place_id  uuid,
  kind      text not null check (kind in ('shop', 'pickup', 'gear', 'other')),
  task_kind text check (task_kind in ('shopping', 'gear-pickup', 'gear-return', 'passenger-pickup',
                                      'passenger-dropoff', 'car-rental', 'car-return', 'waypoint')),
  note      text not null default '' check (char_length(note) <= 100),
  stop_time text check (stop_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  primary key (trip_id, id),
  unique (trip_id, route_id, position) deferrable initially deferred,
  foreign key (trip_id, route_id) references app.routes (trip_id, id) on delete cascade deferrable initially deferred,
  foreign key (trip_id, place_id) references app.places (trip_id, id) deferrable initially deferred
);

create table app.day_settings (
  trip_id        uuid not null references app.trips(id) on delete cascade,
  day            date not null,
  title          text check (char_length(title) <= 20),
  place_id       uuid,
  arrival        text check (arrival ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  route_position text not null default 'before' check (route_position in ('before', 'after')),
  version        bigint not null,
  primary key (trip_id, day),
  foreign key (trip_id, place_id) references app.places (trip_id, id) deferrable initially deferred
);

create table app.activities (
  trip_id    uuid not null references app.trips(id) on delete cascade,
  id         uuid not null,
  day        date not null,
  start_time text not null check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  title      text not null check (char_length(title) between 1 and 100),
  kind       text not null check (kind in ('meet', 'market', 'camp', 'meal', 'night', 'travel', 'wake',
                                           'pitch', 'free', 'tea', 'strike', 'clean', 'return')),
  location   text not null default '' check (char_length(location) <= 150),
  note       text not null default '' check (char_length(note) <= 1000),
  done       boolean not null default false,
  ordinal    bigint not null,
  version    bigint not null,
  primary key (trip_id, id)
);

-- 兩張子表最多只有一張有資料：都沒有 = 全體旅伴；activity_vehicles 有資料 = 指定車輛。
create table app.activity_people (
  trip_id     uuid not null,
  activity_id uuid not null,
  person_id   uuid not null,
  primary key (trip_id, activity_id, person_id),
  foreign key (trip_id, activity_id) references app.activities (trip_id, id) on delete cascade deferrable initially deferred,
  foreign key (trip_id, person_id) references app.people (trip_id, id) deferrable initially deferred
);

create table app.activity_vehicles (
  trip_id     uuid not null,
  activity_id uuid not null,
  vehicle_id  uuid not null,
  primary key (trip_id, activity_id, vehicle_id),
  foreign key (trip_id, activity_id) references app.activities (trip_id, id) on delete cascade deferrable initially deferred,
  foreign key (trip_id, vehicle_id) references app.vehicles (trip_id, id) deferrable initially deferred
);

create table app.meals (
  trip_id     uuid not null references app.trips(id) on delete cascade,
  id          uuid not null,
  day         date not null,
  slot        text not null check (slot in ('早餐', '午餐', '下午茶', '晚餐', '消夜')),
  meal_time   text check (meal_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  title       text not null default '' check (char_length(title) <= 100),
  cook_id     uuid,
  servings    smallint not null check (servings between 1 and 100),
  ingredients text not null default '' check (char_length(ingredients) <= 2000),
  notes       text not null default '' check (char_length(notes) <= 1000),
  dish_kind   text check (dish_kind in ('hotpot', 'bbq', 'toast', 'curry', 'pasta', 'breakfast', 'salad', 'custom')),
  ordinal     bigint not null,
  version     bigint not null,
  primary key (trip_id, id),
  foreign key (trip_id, cook_id) references app.people (trip_id, id) deferrable initially deferred
);

create table app.shopping_items (
  trip_id        uuid not null references app.trips(id) on delete cascade,
  id             uuid not null,
  name           text not null check (char_length(name) between 1 and 100),
  quantity       text not null default '' check (char_length(quantity) <= 40),
  category       text not null check (category in ('肉類', '海鮮', '蔬菜', '水果', '蛋奶', '豆製品',
                                                   '主食', '調味料', '飲料', '零食', '其他')),
  assignee_id    uuid,
  purchased      boolean not null default false,
  source         text not null check (source in ('meal', 'manual')),
  recipe_removed boolean,
  ordinal        bigint not null,
  version        bigint not null,
  primary key (trip_id, id),
  foreign key (trip_id, assignee_id) references app.people (trip_id, id) deferrable initially deferred
);

create table app.shopping_item_meals (
  trip_id uuid not null,
  item_id uuid not null,
  meal_id uuid not null,
  primary key (trip_id, item_id, meal_id),
  foreign key (trip_id, item_id) references app.shopping_items (trip_id, id) on delete cascade deferrable initially deferred,
  foreign key (trip_id, meal_id) references app.meals (trip_id, id) deferrable initially deferred
);

create table app.gear_items (
  trip_id     uuid not null references app.trips(id) on delete cascade,
  id          uuid not null,
  name        text not null check (char_length(name) between 1 and 100),
  quantity    text not null default '' check (char_length(quantity) <= 40),
  scope       text not null check (scope in ('personal', 'shared')),
  assignee_id uuid,
  ordinal     bigint not null,
  version     bigint not null,
  primary key (trip_id, id),
  check (scope = 'shared' or assignee_id is null),
  foreign key (trip_id, assignee_id) references app.people (trip_id, id) deferrable initially deferred
);

create table app.gear_packed (
  trip_id   uuid not null,
  gear_id   uuid not null,
  person_id uuid not null,
  primary key (trip_id, gear_id, person_id),
  foreign key (trip_id, gear_id) references app.gear_items (trip_id, id) on delete cascade deferrable initially deferred,
  foreign key (trip_id, person_id) references app.people (trip_id, id) deferrable initially deferred
);

create table app.departures (
  trip_id     uuid not null,
  person_id   uuid not null,
  departed_at timestamptz not null default now(),
  version     bigint not null,
  primary key (trip_id, person_id),
  foreign key (trip_id, person_id) references app.people (trip_id, id) deferrable initially deferred
);

create table app.expenses (
  trip_id          uuid not null references app.trips(id) on delete cascade,
  id               uuid not null,
  spent_on         date not null,
  title            text not null check (char_length(title) between 1 and 100),
  amount_cents     bigint not null check (amount_cents between 1 and 100000000),
  payer_id         uuid not null,
  category         text not null,               -- EXPENSE_CATEGORIES（含「食材／{分類}」）由 lm-core 檢查
  note             text not null default '' check (char_length(note) <= 500),
  shopping_item_id uuid,
  ordinal          bigint not null,
  version          bigint not null,
  primary key (trip_id, id),
  foreign key (trip_id, payer_id) references app.people (trip_id, id) deferrable initially deferred,
  foreign key (trip_id, shopping_item_id) references app.shopping_items (trip_id, id) deferrable initially deferred
);

create table app.expense_participants (
  trip_id    uuid not null,
  expense_id uuid not null,
  person_id  uuid not null,
  primary key (trip_id, expense_id, person_id),
  foreign key (trip_id, expense_id) references app.expenses (trip_id, id) on delete cascade deferrable initially deferred,
  foreign key (trip_id, person_id) references app.people (trip_id, id) deferrable initially deferred
);

create table app.settlements (
  trip_id      uuid not null references app.trips(id) on delete cascade,
  id           uuid not null,
  paid_on      date not null,
  from_id      uuid not null,
  to_id        uuid not null,
  amount_cents bigint not null check (amount_cents between 1 and 100000000),
  note         text not null default '' check (char_length(note) <= 500),
  ordinal      bigint not null,
  version      bigint not null,
  primary key (trip_id, id),
  check (from_id <> to_id),
  foreign key (trip_id, from_id) references app.people (trip_id, id) deferrable initially deferred,
  foreign key (trip_id, to_id) references app.people (trip_id, id) deferrable initially deferred
);

create table app.invites (
  id         uuid primary key,
  trip_id    uuid not null references app.trips(id) on delete cascade,
  token_hash text not null unique,              -- SHA-256(token) 的十六進位；token 本身不保存
  created_by uuid not null references app.profiles(user_id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,              -- created_at + 7 天
  revoked_at timestamptz,
  used_at    timestamptz,
  used_by    uuid references app.profiles(user_id)
);
create index invites_trip on app.invites (trip_id);

-- 每次提交一列：補齊、冪等與推送的來源。第一版不清除舊資料。
create table app.trip_changes (
  trip_id      uuid not null references app.trips(id) on delete cascade,
  seq          bigint not null,
  command_id   uuid not null,
  actor_id     uuid not null references app.profiles(user_id),
  payload      jsonb not null,                  -- ChangeSet 的 JSON
  committed_at timestamptz not null default now(),
  primary key (trip_id, seq),
  unique (trip_id, command_id)
);

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'app' loop
    execute format('alter table app.%I enable row level security', t);
  end loop;
end $$;
revoke all on all tables in schema app from anon, authenticated;
```

### Realtime 授權（`20260101000100_realtime_authorization.sql`）

```sql
-- realtime.messages 已啟用 RLS，而且 postgres 不是它的擁有者：不要寫 ALTER TABLE … ENABLE ROW LEVEL SECURITY，
-- Supabase 文件說明這個語句會以 42501 中止整個遷移。只建立政策。

grant usage on schema app to authenticated;   -- 只為了呼叫下面的函式；沒有任何資料表權限

-- 頻道 trip:<uuid> 只開放給這趟旅行綁定旅伴的帳號與管理員；旅行刪除後一律拒絕。
-- CASE 保證格式不對的 topic 不會被轉型成 uuid（轉型失敗會讓加入以錯誤結束）。
create function app.can_use_trip_topic(topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when topic !~ '^trip:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then false
    else exists (
      select 1
      from app.trips t
      where t.id = substring(topic from 6)::uuid
        and t.deleted_at is null
        and (
          exists (select 1 from app.people p where p.trip_id = t.id and p.user_id = (select auth.uid()))
          or exists (select 1 from app.profiles a where a.user_id = (select auth.uid()) and a.role = 'admin')
        )
    )
  end;
$$;
revoke all on function app.can_use_trip_topic(text) from public;
grant execute on function app.can_use_trip_topic(text) to authenticated;

create policy "trip members receive broadcasts and presence"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and app.can_use_trip_topic((select realtime.topic()))
  );

-- 只允許 presence。沒有 broadcast 的 INSERT 政策，所以客戶端不能自己送 broadcast
-- （Realtime 對私有頻道的 RLS 拒絕一律靜默丟棄）；變更集只能由資料庫發出。
create policy "trip members track presence"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and app.can_use_trip_topic((select realtime.topic()))
  );
```

Realtime 在加入頻道與收到新的 `access_token` 時計算權限並快取到連線結束。因此帳號在連線期間失去存取權（例如旅行被刪除）時，仍可能收到訊息直到 JWT 過期或重新加入；第一版沒有移除成員的功能，旅行刪除則另外推送 `trip_deleted`，前端收到後離開頁面。

### 推送（`20260101000200_publish_changes.sql`）

```sql
-- 每次提交寫入 app.trip_changes；trigger 在同一個交易中把變更集送到這趟旅行的私有頻道。
-- 交易回滾時 realtime.messages 的寫入一起回滾，所以不會推送沒有提交的變更。
-- 沒有任何連線者時 realtime.send() 只記錄 WarnSendingBroadcastMessage 警告，不會讓提交失敗。
create function app.publish_trip_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(
    case
      when octet_length(new.payload::text) <= 65536 then new.payload
      else jsonb_build_object('trip', new.trip_id, 'seq', new.seq, 'thin', true)   -- 太大：只通知序號
    end,
    'changeset',
    'trip:' || new.trip_id::text,
    true                                                                            -- 私有頻道
  );
  return null;
end;
$$;

create trigger trip_changes_publish
  after insert on app.trip_changes
  for each row execute function app.publish_trip_change();
```

刪除旅行也走同一條路：`DELETE /api/trips/{id}` 在設定 `deleted_at` 的交易中寫入一列 `trip_deleted: true` 的變更集。

### 線上格式

快照、增量與推送使用同一種列格式。以「勾選已買」為例，`seq` 42 的變更集：

```json
{
  "trip": "6f1c2a9e-…",
  "seq": 42,
  "command_id": "a7e2d0c4-…",
  "actor": "0b9d77f1-…",
  "committed_at_ms": 1795000000000,
  "changes": [
    {
      "entity": "shopping",
      "key": "3c51b8aa-…",
      "version": 42,
      "row": {
        "entity": "shopping",
        "row": {
          "id": "3c51b8aa-…", "name": "牛肉片", "quantity": "2 盒", "category": "肉類",
          "assignee": "5e0a4c12-…", "purchased": true, "source": "meal",
          "meal_ids": ["91d3e6b0-…"], "recipe_removed": null, "ordinal": 17, "version": 42
        }
      }
    }
  ],
  "trip_deleted": false
}
```

改一道料理的食材時，同一個變更集會包含那道料理，以及採買同步新增、更新或刪除的品項；接收端一次套用，不會看到料理已改而採買清單未改的中間狀態。

### 版本、序號與順序

| 名稱 | 意義 | 由誰決定 |
|---|---|---|
| `seq` | 一趟旅行的第幾次提交，從 1 開始、連續 | lm-server，在鎖住旅行列之後加一 |
| `version` | 一列最後被修改時的 `seq`；刪除也有版本 | 同上；同一個變更集中的每筆變更 `version == seq` |
| 水位線 | 客戶端「所有 ≤ 水位線的變更集都已反映」的最大值 | 客戶端（`Replica`） |
| `ordinal` | 列在這趟旅行中的建立順序 | lm-server，以 `trips.next_ordinal` 遞增，依 `Outcome.created` 的順序指定：命令中的順序，再接採買同步新增品項的順序（需求 7.19）；前端預測的新列以暫時的 ordinal 排在同一種列的最後（需求 7.18）；修改既有列不改變它的 ordinal |

### 列舉與上限

| 名稱 | 值 |
|---|---|
| `CoverKind` | camp、mountain、lake、night、forest、beach、sunrise（插畫：mountain 使用 travel，其餘同名） |
| `TripStatus` | planning（規劃中）、completed（已完成） |
| `Color` | coral、blue、green、yellow、lavender、peach |
| `Role` | admin、member |
| `ActivityKind` | meet 集合、market 採買、camp 營地時光、meal 用餐、night 夜晚、travel 移動、wake 起床、pitch 搭帳、free 自由活動、tea 下午茶／遊戲、strike 拆帳、clean 清潔、return 返程 |
| `StopKind` 與 `StopTask` | shop 採買（shopping 採買）；pickup 接送（passenger-pickup 接人、passenger-dropoff 送人下車）；gear 取還裝備（gear-pickup 領取租借裝備、gear-return 歸還裝備）；other 其他（car-rental 取租車、car-return 還車、waypoint 一般停靠）；沒有指定任務時用 `DEFAULT_STOP_TASK` |
| `MealSlot` 與預設用餐時間 | 早餐 08:30、午餐 12:00、下午茶 15:00、晚餐 18:00、消夜 21:00 |
| `DishKind` | hotpot、bbq、toast、curry、pasta、breakfast、salad、custom |
| `Category` | 肉類、海鮮、蔬菜、水果、蛋奶、豆製品、主食、調味料、飲料、零食、其他 |
| `GearScope` | personal、shared |
| `ExpenseCategory` | 食材、交通、住宿、其他、食材／{上面 11 類}、露營耗材、露營裝備、日用品 |

| 項目 | 上限 | 來源 |
|---|---|---|
| 旅行天數 | 1–31 天 | `dateRange()` |
| 旅行名稱、目的地、介紹、小叮嚀 | 100、100、1000、1000 字 | `CARD_LIMITS` |
| 旅伴 | 100 位；名字 30 字、角色 60 字 | `addParticipant()` |
| 地點 | 100 個；名稱 50 字 | `LIMITS.places`、`LIMITS.placeName` |
| 車輛 | 名稱 50 字；座位 1–9 | 車輛表單、`isValidState()` |
| 路線 | 每台車每天 1 條；停靠點 6 個；停靠點備註 100 字 | `LIMITS.stops`、`LIMITS.stopNote` |
| 每日設定 | 標題 20 字 | `LIMITS.dayTitle` |
| 活動 | 1000 筆；標題 100、地點 150、備註 1000 字 | `LIMITS` |
| 料理 | 1000 筆；份數 1–100；名稱 100、食材 2000、備註 1000 字 | 第一版新定（現行只有 5000 字的通用上限） |
| 採買品項 | 1000 項；名稱 100、數量 40 字 | `syncMealIngredients()` 的上限；數量沿用表單的 40 字；名稱長度為第一版新定 |
| 裝備 | 1000 項；名稱 100、數量 40 字 | 裝備表單的 maxlength |
| 支出、還款 | 各 1000 筆；金額 NT$0.01–1,000,000；標題 100、備註 500 字；分攤 1–100 位 | `LEDGER_LIMITS` |
| 邀請連結 | 7 天；每趟 20 個有效；非管理者每人 5 個有效 | `INVITE_TTL`、`MAX_ACTIVE_INVITES`、`MAX_MEMBER_INVITES` |
| 帳號名稱、顯示名稱、密碼 | 3–32、1–30、12–72 字元（≤ 72 位元組） | `USERNAME`、GoTrue |
| 編輯者頭像 | 每張卡片或每一列最多 3 個頭像，其餘以「+N」表示；色盤 12 色 | 第一版新定（已確認 3） |

### 不變式（`validate::state()`）

`apply()` 的每個成功結果都必須滿足下列條件（屬性 9）；I1–I3 與 I10 也由資料庫的外鍵與唯一鍵保證。

| 編號 | 不變式 |
|---|---|
| I1 | 所有引用（旅伴、車輛、地點、路線、料理、採買品項）都指向同一趟旅行中存在的列。 |
| I2 | 旅伴的 `participant_key` 不重複；地點的 `place_key` 不重複，也不等於非空白旅行目的地的 `place_key`。 |
| I3 | 每台車每天最多一條路線；每條路線最多 6 個停靠點；停靠點 id 在整趟旅行中唯一。 |
| I4 | 路線端點或停靠點使用旅行目的地時，目的地不是空白。 |
| I5 | 活動、料理、路線與每日設定的日期都在旅行範圍內。 |
| I6 | 車輛的駕駛不在乘客中，乘客人數 + 1 ≤ 座位數。 |
| I7 | 個人裝備沒有負責人；共用裝備的 `packed_by` ⊆ {負責人}。 |
| I8 | 每一筆出發確認的旅伴都滿足 `can_depart()`：自己的裝備都已打包，而且沒有未分配的共用裝備。 |
| I9 | 採買同步之後：每個料理需要的食材鍵都被某個品項涵蓋；`source == Meal` 而未買的品項 `meal_ids` 不為空；`meal_ids` 只引用存在的料理。 |
| I10 | 支出的付款人與分攤旅伴、還款的付款人與收款人都存在；還款的付款人與收款人不同。 |
| I11 | 活動指定車輛時，參加者清單為空。 |
| I12 | 各集合的數量不超過「列舉與上限」。 |

I1–I12 依序對應需求 9.2–9.13。處理函式在寫入之前就以各需求的訊息拒絕違反的命令；`validate::state()` 是最後一道檢查，失敗時以 `Violation::into_rejection()` 依需求 9.16 決定回應：違反的條件有對應的拒絕規則時，回應那條規則的狀態與訊息，例如旅伴同名（I2）為需求 19.6 的 409、地點同名（I2）為需求 21.1 的 409、同一台車同一天的第二條路線（I3）為需求 22.4 的 409、出發確認不滿足 Can_Depart（I8）為需求 28.3 的 400、數量超過上限（I12）為該種列的上限訊息（例如需求 19.7、25.15）；沒有對應規則時回應 409「資料驗證未通過，沒有儲存。」。權限的拒絕在這之前（需求 6.4），所以 Collaborator 刪除仍有路線的車輛得到 403，不是 409。

## Algorithmic Pseudocode

以 Rust 寫出主要演算法；為了閱讀，省略部分錯誤轉換與型別標註。

### A1. 伺服器執行命令 `execute()`

```rust
// crates/server/src/commands.rs
pub async fn execute(st: &AppState, user: &AuthUser, trip: TripId, req: CommandRequest)
    -> Result<CommandResponse, ApiError>
{
    let mut tx = st.db.begin().await?;

    // 1. 串行化：同一趟旅行的命令在這裡依序取得列鎖，持有到 COMMIT；旅行不存在或已刪除時 404（需求 6.3）
    let head = repo::lock_trip(&mut tx, trip).await?.ok_or_else(ApiError::trip_not_found)?;

    // 2. 身分與權限：在查重之前判斷，所以非成員以這趟旅行已提交的 command_id 重送也只得到 404（需求 6.2）
    let me = repo::person_of(&mut tx, trip, user.id).await?;
    let caps = rules::capabilities(head.owner, user.id, user.role, me);
    if !caps.can_edit {
        return Err(ApiError::trip_not_found());
    }
    let hide_ledger = caps.me.is_none();          // Unbound_Admin：每個回應中的 Change_Set 都不含 Ledger_Rows（需求 6.12、7.1）

    // 3. 冪等：同一個 command_id 已經提交過（例如回應在網路上遺失後重送）。不論這次的內容為何，
    //    都回傳第一次提交的 Change_Set，不再執行、寫入或推送（需求 7.14）；重送的回應也省略 Ledger_Rows
    if let Some(cs) = repo::changeset_by_command(&mut tx, trip, req.command_id).await? {
        tx.commit().await?;
        return Ok(CommandResponse { seq: cs.seq, changeset: Some(cs.for_viewer(hide_ledger)), replayed: true });
    }

    // 4. 讀取整趟旅行並套用：權限細節、驗證、主要效果與採買同步都在 lm-core
    let state = repo::load_trip(&mut tx, trip).await?;
    let ctx = Ctx { actor: user.id, caps };
    let outcome = apply(&state, &ctx, Mode::Commit, &mut UuidV4Ids, &req.command)?;
    if outcome.is_noop() {
        tx.commit().await?;                       // 想要的狀態已經成立，或要刪除的列已不存在：不寫入、不推送、不記錄 command_id（B4、需求 7.12）
        return Ok(CommandResponse { seq: head.seq, changeset: None, replayed: false });
    }

    // 5. 指定版本與建立順序：新列依 outcome.created 的順序取得 ordinal，也就是命令中的順序（例如一次加入的
    //    多個常用活動），再接採買同步新增的 Meal_Item（料理的 ordinal，再依食材在料理中第一次出現的順序）；
    //    不依 diff() 走訪 Slot 的順序（那是 UUID 的順序；需求 7.19）
    let seq = head.seq + 1;
    let ordinals: HashMap<Slot, u64> = outcome.created.iter().enumerate()
        .map(|(k, slot)| (*slot, head.next_ordinal + k as u64))
        .collect();
    let next_ordinal = head.next_ordinal + outcome.created.len() as u64;
    let changes: Vec<Change> = outcome.effects().into_iter()
        .map(|effect| match effect {
            Effect::Upsert(row) => {
                let slot = row.slot();
                let row = match ordinals.get(&slot) {
                    Some(&ordinal) => row.with_ordinal(ordinal),   // 取代 apply() 指定的暫時 ordinal
                    None => row,                                  // 既有的列：ordinal 不變
                };
                Change { entity: slot.0, key: slot.1, version: seq, row: Some(row.with_version(seq)) }
            }
            Effect::Delete((entity, key)) => Change { entity, key, version: seq, row: None },
        })
        .collect();

    // 6. 寫入、記錄（trigger 推送）、提交；外鍵在 COMMIT 時檢查，失敗就整個回滾，也不會推送（需求 7.16）
    repo::write_changes(&mut tx, trip, &changes).await?;
    let cs = ChangeSet {
        trip, seq, command_id: req.command_id, actor: user.id,
        committed_at_ms: st.clock.now_ms(), changes, trip_deleted: false,
    };
    repo::finish(&mut tx, trip, seq, next_ordinal, &cs).await?;   // Change_Log 保存完整的 Change_Set，包括 Ledger_Rows
    tx.commit().await?;
    Ok(CommandResponse { seq, changeset: Some(cs.for_viewer(hide_ledger)), replayed: false })
}
```

`?` 把 `Rejection` 轉成對應的 HTTP 狀態（400、403、404、409）；`sqlx` 的錯誤（包括 COMMIT 時的外鍵、唯一鍵與 CHECK 失敗）轉成 500 `internal_error`。交易物件在提早回傳時自動回滾。

### A2. `apply()` 與命令處理函式

```rust
// crates/core/src/apply/mod.rs
pub fn apply(state: &TripState, ctx: &Ctx, mode: Mode, ids: &mut dyn IdSource, cmd: &Command)
    -> Result<Outcome, Rejection>
{
    rules::authorize(state, &ctx.caps, cmd)?;          // 權限在找目標、驗證與判斷有沒有變化之前（需求 6.4）
    let mut draft = state.clone();                     // 處理函式只改 draft；失敗時整份丟棄
    // 依命令分派（見下方三例）。回傳新增的列，依命令中的順序；新列先取得暫時的 ordinal
    // （從 state.max_ordinal() + 1 起依這個順序遞增），所以預測時排在最後（需求 7.18），
    // 採買同步依 meals_by_ordinal() 走訪時，這次新增的料理也排在既有料理之後。
    let mut created = handlers::run(&mut draft, ctx, cmd)?;
    let primary = diff(state, &draft);                 // 只含內容改變的列，每個 Slot 一筆
    if primary.is_empty() {
        // 想要的狀態已經成立，或要刪除的列已不存在：沒有變化，也不執行採買同步或任何連帶效果（需求 7.12）
        return Ok(Outcome::default());
    }
    let mut derived = Vec::new();
    if mode == Mode::Commit && touches_ingredients(cmd) {
        let plan = ingredients::sync_meal_ingredients(&draft, ids)?;   // 衍生資料只在伺服器計算（B5）
        let mut synced = draft.clone();
        plan.apply_to(&mut synced);                    // 也清除被移除品項的支出連結，不檢查帳目的權限（需求 29.13）
        derived = diff(&draft, &synced);
        created.extend(plan.created.iter().map(|id| (Entity::Shopping, RowKey::Id(id.0))));   // 排在主要效果的新列之後（需求 7.19）
        draft = synced;
    }
    // 防線：處理函式的疏漏在這裡變成拒絕，不會寫入。Predict 不跑採買同步，所以不檢查 I9。
    // 有對應規則的違反以那條規則的訊息回應，否則 409「資料驗證未通過，沒有儲存。」（需求 9.16）
    validate::state(&draft, mode).map_err(Violation::into_rejection)?;
    Ok(Outcome { primary, derived, created })
}

fn touches_ingredients(cmd: &Command) -> bool {
    use Command::*;
    matches!(cmd, AddMeal { .. } | UpdateMeal { .. } | RemoveMeal { .. } | RemoveIngredientFromMeals { .. }
        | AddShoppingItem { .. } | UpdateShoppingItem { .. } | RemoveShoppingItem { .. })
}

// 勾選已買：送出的是想要的狀態（B4）
fn set_purchased(d: &mut TripState, ctx: &Ctx, id: ShoppingId, purchased: bool) -> Result<(), Rejection> {
    let item = d.shopping.get_mut(&id).ok_or_else(|| Rejection::not_found("找不到這個採買品項。"))?;
    if item.purchased == purchased {
        return Ok(());                                 // 已是目標狀態：沒有效果
    }
    item.purchased = purchased;
    // retainPurchased()：受邀旅伴取消已買的料理品項時，品項改為手動，之後改食譜也不會刪掉它
    if !purchased && !ctx.caps.can_manage && item.source == ItemSource::Meal {
        item.source = ItemSource::Manual;
    }
    Ok(())
}

// 打包勾選：authorize() 已確認 person 是自己
fn set_packed(d: &mut TripState, id: GearId, person: PersonId, packed: bool) -> Result<(), Rejection> {
    if !d.gear.contains_key(&id) {
        return Err(Rejection::not_found("找不到這個裝備。"));
    }
    if !rules::my_gear(d, person).any(|g| g.id == id) {
        return Err(Rejection::forbidden("只能勾選自己的個人裝備或負責的共用裝備。"));
    }
    let gear = d.gear.get_mut(&id).expect("checked above");
    if packed { gear.packed_by.insert(person); } else { gear.packed_by.remove(&person); }
    if !packed {
        d.departures.remove(&person);                  // 取消打包就撤回自己的出發確認（現行 togglePacking）
    }
    Ok(())
}

// 刪除地點：已不存在時沒有變化；仍被使用時 409（需求 21.3、21.4、21.7）。權限已由 authorize() 判斷。
fn remove_place(d: &mut TripState, id: PlaceId) -> Result<(), Rejection> {
    if !d.places.contains_key(&id) {
        return Ok(());                                 // 已被其他成員先刪除：沒有變化，也沒有連帶效果（需求 7.12）
    }
    let usages = itinerary::place_usages(d, id);       // 依 Trip_Day，同一天先「這一天的地點」，再依車輛的 ordinal
    if !usages.is_empty() {
        return Err(Rejection::conflict("place_in_use", place_in_use_message(&usages)));
    }
    d.places.remove(&id);
    Ok(())
}
```

修改與勾選的處理函式在目標不存在時回傳該種項目的 404（例如 `set_purchased` 的「找不到這個採買品項。」），不重新建立；刪除的處理函式在目標不存在時直接回傳、不改 draft，`apply()` 因此得到空的主要效果並回傳沒有變化（需求 7.12、7.21）。

`diff(before, after)` 逐一比較兩份狀態的每個 Slot：只在 `after` 有、或內容不同的產生 `Upsert`，只在 `before` 有的產生 `Delete`。以日期為鍵的每日設定在改日期時會整張重建，靠 `diff()` 產生正確的刪除與新增。

### A3. 料理食材 → 採買同步 `sync_meal_ingredients()`

逐行移植 `src/ingredients.js` 的 `syncMealIngredients()`；差別只在順序以 `ordinal` 取代陣列順序，以及 `meal_ids` 改成集合。

```rust
// crates/core/src/ingredients.rs
#[derive(Debug, Default, PartialEq)]
pub struct SyncPlan {
    pub upserts: Vec<ShoppingItem>,   // 內容改變的既有品項，以及新增的料理品項
    pub deletes: Vec<ShoppingId>,     // 只會是：料理產生、未買、已沒有料理需要的品項
    pub created: Vec<ShoppingId>,     // 新增的 Meal_Item，依新增的順序：料理的 ordinal，再依食材在料理中第一次出現的順序（需求 7.19）
    /// 連結到 deletes 中品項的支出：清除它們的採買連結，其他欄位不變（需求 9.15、25.19、29.13）。
    /// 這是衍生效果，不套用帳目的權限，提交者是 Collaborator 或 Unbound_Admin 時也照樣清除（需求 26.13）。
    pub unlinked_expenses: Vec<ExpenseId>,
}

impl SyncPlan {
    /// 寫入 upserts、刪除 deletes，並把 unlinked_expenses 的 shopping_item 設為 None。
    pub fn apply_to(&self, state: &mut TripState);
}

pub fn sync_meal_ingredients(state: &TripState, ids: &mut dyn IdSource) -> Result<SyncPlan, Rejection> {
    // 1. 料理需要的食材：鍵 → (第一次出現的寫法, 需要它的料理)；依料理建立順序與食材出現順序
    let mut needs: IndexMap<String, (String, BTreeSet<MealId>)> = IndexMap::new();
    for meal in state.meals_by_ordinal() {
        for name in parse_ingredients(&meal.ingredients) {
            needs.entry(ingredient_key(&name))
                .or_insert_with(|| (name.clone(), BTreeSet::new()))
                .1.insert(meal.id);
        }
    }

    // 2. 每個鍵由哪個品項負責：手動或已買的品項優先於未買的料理品項；同優先順序依清單順序（穩定排序）
    let items: Vec<&ShoppingItem> = state.shopping_by_ordinal().collect();
    let mut by_priority = items.clone();
    by_priority.sort_by_key(|it| (it.source == ItemSource::Meal && !it.purchased) as u8);
    let mut owner: HashMap<String, ShoppingId> = HashMap::new();
    for it in &by_priority {
        for name in parse_ingredients(&it.name) {
            owner.entry(ingredient_key(&name)).or_insert(it.id);
        }
    }

    // 3. 逐一決定保留或刪除；不改數量、負責人、分類與已買狀態
    let mut plan = SyncPlan::default();
    let mut covered: HashSet<String> = HashSet::new();
    let mut kept = 0usize;
    for it in &items {
        let keys: Vec<String> = parse_ingredients(&it.name).iter().map(|n| ingredient_key(n)).collect();
        let meal_ids: BTreeSet<MealId> = keys.iter()
            .filter(|k| owner.get(*k) == Some(&it.id))
            .filter_map(|k| needs.get(k))
            .flat_map(|(_, meals)| meals.iter().copied())
            .collect();
        if it.source == ItemSource::Meal && !it.purchased && meal_ids.is_empty() {
            plan.deletes.push(it.id);
            continue;
        }
        let mut next = (*it).clone();
        let removed = !keys.iter().any(|k| needs.contains_key(k))
            && (it.recipe_removed == Some(true) || !it.meal_ids.is_empty());
        if removed || it.recipe_removed.is_some() {
            next.recipe_removed = Some(removed);
        }
        if it.source == ItemSource::Meal && it.purchased && meal_ids.is_empty() {
            next.source = ItemSource::Manual;             // 因為已買而留下的品項，之後就是手動品項
        }
        next.meal_ids = meal_ids;
        if next != **it {
            plan.upserts.push(next);
        }
        covered.extend(keys);
        kept += 1;
    }

    // 4. 仍未被任何品項涵蓋的食材：新增料理品項。needs 依料理的 ordinal、再依食材第一次出現的順序建立，
    //    所以新增的品項也依這個順序（需求 7.19）；這次新增的料理已有暫時的 ordinal，排在既有料理之後
    for (key, (name, meals)) in &needs {
        if covered.contains(key) {
            continue;
        }
        let id = ids.shopping_id();
        plan.upserts.push(ShoppingItem {
            id, name: name.clone(), quantity: "數量待確認".into(),
            category: classify_ingredient(name), assignee: None, purchased: false,
            source: ItemSource::Meal, meal_ids: meals.clone(), recipe_removed: None,
            ordinal: 0, version: 0,                         // 由 execute() 依 plan.created 的順序指定
        });
        plan.created.push(id);
    }
    if kept + plan.created.len() > LIMITS.shopping {
        return Err(Rejection::conflict("shopping_limit", "採買品項最多 1,000 項，請減少食材或整理採買清單後再儲存。"));
    }

    // 5. 被刪除的品項仍被支出連結時，清除這些支出的採買連結，使命令不因引用不存在的品項而被拒絕（需求 9.15、29.13）
    plan.unlinked_expenses = state.expenses.values()
        .filter(|e| e.shopping_item.is_some_and(|item| plan.deletes.contains(&item)))
        .map(|e| e.id)
        .collect();
    Ok(plan)
}
```

**迴圈不變式（步驟 3）**：處理完前 i 個品項後，(a) `covered` 等於這 i 個品項中被保留者的食材鍵聯集；(b) `plan.deletes` 只含 `source == Meal`、未買、且沒有負責任何被需要之鍵的品項；(c) 沒有任何手動或已買的品項在 `plan.deletes` 中。

### A4. 食材切分 `parse_ingredients()`

```rust
// crates/core/src/ingredients.rs
use unicode_normalization::UnicodeNormalization;

/// 與現行 parseIngredients() 相同：先整串 NFKC；「、 ; / 。 換行」一律切開（全形逗號與分號在 NFKC 後已是半形）；
/// 半形「, .」只有前後都是數字時保留（例如 1.5、1,000）。Rust 的 regex 不支援 lookaround，所以逐字掃描。
pub fn parse_ingredients(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.nfkc().collect();
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    for (i, &c) in chars.iter().enumerate() {
        let hard = matches!(c, '、' | ';' | '/' | '。' | '\r' | '\n');
        let between_digits = i > 0
            && chars[i - 1].is_ascii_digit()
            && chars.get(i + 1).is_some_and(|n| n.is_ascii_digit());
        let soft = matches!(c, ',' | '.') && !between_digits;
        if hard || soft {
            parts.push(std::mem::take(&mut current));
        } else {
            current.push(c);
        }
    }
    parts.push(current);
    let mut seen = HashSet::new();
    parts.into_iter()
        // 現行 part.normalize('NFKC').trim().replace(/\s+/gu, ' ')：去除前後的 JS_Whitespace，內部連續的換成一個半形空格（需求 25.4）
        .map(|part| text::collapse_js_whitespace(&part.nfkc().collect::<String>()))
        .filter(|name| !name.is_empty() && seen.insert(ingredient_key(name)))
        .collect()
}

/// keyOf()：NFKC、移除所有 JS_Whitespace、轉小寫。
pub fn ingredient_key(name: &str) -> String {
    name.nfkc().filter(|&c| !text::is_js_whitespace(c)).collect::<String>().to_lowercase()
}

/// JS_Whitespace：JavaScript 的 `\s` 與 `trim()` 所稱的空白。與 Rust 的 char::is_whitespace（Unicode White_Space）不同：
/// U+FEFF 算空白，U+0085 不算。Ingredient_Parser、Ingredient_Key 與 Participant_Name 都用它（需求 19.1、25.4、33.10）。
pub fn is_js_whitespace(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | '\u{2028}' | '\u{2029}' | '\u{feff}')
        || matches!(c, ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}')   // 一般類別 Zs
}
```

`classify_ingredient()` 的規則表照現行順序移植成 `regex`，比對的對象與現行相同，是名稱的 Ingredient_Key；唯一用到 lookahead 的 `地瓜(?!葉)` 改寫成等價的 `地瓜(?:[^葉]|$)`。Rust 的 `regex` 預設 `\d` 是 Unicode 的十進位數字、`\s` 是 Unicode White_Space，與 JavaScript 不同，所以規則中的 `\d` 一律改寫成 `[0-9]`（只比對 ASCII 0–9），`\s` 改寫成 JS_Whitespace 的字元類別；例如「鹽」加 U+0663 不符合 `^鹽(?:[0-9]|$)`，分類為「其他」，與現行相同（需求 25.17、33.10）。Trim_White（`trim_white`）仍是 Unicode White_Space，用於需求另外指定 Trim_White 的欄位。

### A5. 合併 `Replica`

```rust
// crates/core/src/sync.rs
impl Replica {
    pub fn version_of(&self, slot: Slot) -> Seq {
        self.state.get(slot).map(|row| row.version())
            .or_else(|| self.tombstones.get(&slot).copied())
            .unwrap_or(0)
    }

    pub fn apply_changeset(&mut self, cs: &ChangeSet) -> ApplyReport {
        let mut report = ApplyReport::default();
        // 已反映過的變更集（重複，或早於快照）：整則忽略
        if cs.seq <= self.watermark || self.ahead.contains(&cs.seq) {
            report.duplicate = true;
            return report;
        }
        for change in &cs.changes {                        // 前置條件：同一則中每個 Slot 最多一筆
            let slot = (change.entity, change.key);
            if change.version <= self.version_of(slot) {
                continue;                                  // 已有較新的版本（亂序抵達）
            }
            let before = self.state.get(slot);
            match &change.row {
                Some(row) => { self.state.put(row.clone()); self.tombstones.remove(&slot); }
                None => { self.state.remove(slot); self.tombstones.insert(slot, change.version); }
            }
            if self.state.get(slot) != before {
                report.changed.push(slot);
            }
        }
        report.trip_deleted = cs.trip_deleted;
        self.ahead.insert(cs.seq);
        self.advance();
        report.gap = self.ahead.first().map(|&first| (self.watermark + 1, first - 1));
        report
    }

    pub fn apply_snapshot(&mut self, snap: &Snapshot) -> ApplyReport {
        let mut report = ApplyReport::default();
        if snap.seq <= self.watermark {
            report.duplicate = true;
            return report;
        }
        let in_snapshot: BTreeSet<Slot> = snap.rows.iter().map(Row::slot).collect();
        // 1. 本地有、快照沒有、版本 ≤ 快照 seq 的列：在快照之前已被刪除
        let stale: Vec<Slot> = self.state.slots()
            .filter(|slot| !in_snapshot.contains(slot) && self.version_of(*slot) <= snap.seq)
            .collect();
        for slot in stale {
            self.state.remove(slot);
            report.changed.push(slot);
        }
        // 2. 快照中的列：比本地新才採用（本地可能已有快照之後的變更）
        for row in &snap.rows {
            let slot = row.slot();
            if row.version() > self.version_of(slot) {
                let before = self.state.get(slot);
                self.state.put(row.clone());
                self.tombstones.remove(&slot);
                if self.state.get(slot) != before {
                    report.changed.push(slot);
                }
            }
        }
        // 3. 快照代表 ≤ snap.seq 的全部提交
        self.watermark = snap.seq;
        self.ahead.retain(|&s| s > snap.seq);
        self.advance();
        report.gap = self.ahead.first().map(|&first| (self.watermark + 1, first - 1));
        report
    }

    fn advance(&mut self) {
        while self.ahead.remove(&(self.watermark + 1)) {
            self.watermark += 1;
        }
        // 版本 ≤ 水位線的墓碑可以丟掉：之後會套用的變更，版本都大於水位線；
        // 版本較舊的變更來自 seq ≤ 水位線的變更集，會在入口整則被忽略。
        let watermark = self.watermark;
        self.tombstones.retain(|_, version| *version > watermark);
    }
}
```

**為什麼收斂**：伺服器保證每則變更集的 seq 唯一、連續，同一則中每個 Slot 最多一筆，且每筆的 version 等於 seq。於是同一個 Slot 的所有變更版本互不相同，最終結果是「版本最大的那一筆」；取最大值與順序、重複無關。水位線入口的整則忽略讓重送無害，墓碑讓亂序抵達的舊 upsert 不會讓已刪除的列復活。屬性 1 以 proptest 驗證這個論證。

### A6. 樂觀更新 `overlay()` 與 `TripSync`

```rust
// crates/core/src/sync.rs
pub fn overlay(confirmed: &TripState, pending: &[PendingCmd], ctx: &Ctx) -> TripState {
    let mut view = confirmed.clone();
    for op in pending {
        // 在最新的已確認狀態上重新套用；不成立的命令暫時不顯示，但仍留在佇列中依序送出，以伺服器回應為準（需求 13.7）。
        // 預測的新列帶著暫時的 ordinal（view.max_ordinal() + 1 起），排在同一種列的最後（需求 7.18）
        if let Ok(outcome) = apply(&view, ctx, Mode::Predict, &mut NoDerivedIds, &op.command) {
            view.apply_effects(&outcome.primary);
        }
    }
    view
}
```

```rust
// crates/web/src/sync/engine.rs
impl TripSync {
    pub fn submit(&mut self, command: Command) -> Result<CommandId, Rejection> {
        // 先在目前畫面上檢查：表單錯誤立即顯示，也不送出
        apply(&self.view, &self.ctx(), Mode::Predict, &mut NoDerivedIds, &command)?;
        let id = CommandId(Uuid::new_v4());
        self.pending.push_back(PendingCmd { id, command });
        self.refresh_view();
        self.sender.kick();                                 // 一次送一個，先進先出
        Ok(id)
    }

    /// 401 已在 API 層依需求 4.8 換發並重試一次，這裡收到的是重試之後的結果。
    pub fn on_command_result(&mut self, id: CommandId, result: Result<CommandResponse, ApiError>) {
        self.sender.finished(id);                           // 這個請求已結束；佇列可以送出下一個（需求 13.3）
        if !self.pending.iter().any(|op| op.id == id) {
            return;                                         // 已由推送或補齊確認：回應或失敗都不再改變畫面（需求 13.13）
        }
        match result {
            Ok(response) => {
                if let Some(cs) = &response.changeset {
                    self.merge_changeset(cs);               // 重送得到的第一次提交也一樣（需求 7.14、13.14）
                }
                self.pending.retain(|op| op.id != id);      // 「沒有變化」時不合併任何內容，只移除
            }
            Err(error) if error.is_retryable() => {        // 網路錯誤、15 秒逾時、5xx：保留預測，以同一個 command_id 重送
                if self.sender.retry_later(id) {            // 前一次失敗後 1、2、4、8、16 秒；離線時暫停（需求 13.9、13.11）
                    return;
                }
                self.pending.retain(|op| op.id != id);      // 第 5 次重送也失敗：放棄並還原（需求 13.10）
                toast("儲存失敗，變更已還原");
            }
            Err(error) => {                                 // 400／403／404／409：回復（B8）
                self.pending.retain(|op| op.id != id);
                toast(&error.message);
            }
        }
        self.refresh_view();                                // 畫面 = Replica 疊上其餘的 Pending_Command（需求 13.8、屬性 11）
    }

    pub fn on_broadcast(&mut self, payload: Broadcast) -> Option<Resync> {
        match payload {
            Broadcast::Thin { seq, .. } if seq > self.replica.watermark => Some(Resync::ChangesAfter(self.replica.watermark)),
            Broadcast::Thin { .. } => None,
            Broadcast::Full(cs) => self.on_changesets(std::slice::from_ref(&cs)),
        }
    }

    pub fn on_changes(&mut self, response: ChangesResponse) -> Option<Resync> {
        match response {
            ChangesResponse::SnapshotRequired { .. } => Some(Resync::Snapshot),     // 需求 12.6
            ChangesResponse::Changes { changesets, .. } => self.on_changesets(&changesets),
        }
    }

    /// 推送與補齊共用：逐一合併，在同一次畫面更新中顯示（需求 10.5）；仍有缺號就繼續補（需求 12.3）。
    fn on_changesets(&mut self, changesets: &[ChangeSet]) -> Option<Resync> {
        let mut gap = None;
        for cs in changesets {
            let report = self.merge_changeset(cs);
            if report.trip_deleted {
                self.leave_trip("這趟旅行已被刪除。");     // 需求 12.13
                return None;
            }
            gap = report.gap;
        }
        self.refresh_view();
        gap.map(|_| Resync::ChangesAfter(self.replica.watermark))
    }

    /// 合併一個已提交的 Change_Set（命令的回應、推送或補齊）。
    fn merge_changeset(&mut self, cs: &ChangeSet) -> ApplyReport {
        let cs = cs.clone().for_viewer(self.viewer.hides_ledger());   // Unbound_Admin 丟棄 Ledger_Rows（需求 6.13）
        let report = self.replica.apply_changeset(&cs);
        if self.pending.iter().any(|op| op.id == cs.command_id) {
            // 自己的命令經推送或補齊比 HTTP 回應先到：視為確認，取消尚未進行的重送（需求 13.13）
            self.pending.retain(|op| op.id != cs.command_id);
            self.sender.cancel_retry(cs.command_id);
        }
        report
    }

    /// 重算畫面狀態，只把內容改變的列交給 RowStore（B2）。
    fn refresh_view(&mut self) {
        let ctx = self.ctx();                               // Ctx 是小的值型別，先複製出來
        let next = overlay(&self.replica.state, self.pending.make_contiguous(), &ctx);
        for slot in changed_slots(&self.view, &next) {
            self.stores.sync(slot, next.get(slot));
        }
        self.view = next;
        self.revision.update(|r| *r += 1);
        self.pending_count.set(self.pending.len());
    }
}
```

`refresh_view()` 每次都比較整份狀態（數千列以內的比較在 WebAssembly 中是毫秒以下）。之後若需要，可以只比較 `ApplyReport.changed` 與 pending 命令影響的 Slot。無論比較多少列，`RowStore::sync()` 只在內容不同時通知，所以畫面只重繪變更的列。

### A7. 頻道生命週期與重新同步

```rust
// crates/web/src/sync/realtime.rs
/// PhoenixSocket 負責 WebSocket 的建立、每 20 秒的 heartbeat（20 秒內沒有回覆就關閉連線）、phx_join 的 10 秒逾時、
/// 退避（1、2、5、10、10… 秒，各加 0–20% 抖動；同時發生的多個中斷只算一次），以及每次連上後重送 phx_join。
/// 這裡依加入的結果與頻道事件決定下一步：只有權限不足時離開旅行頁，其他錯誤都依退避重試（需求 11.7–11.10）。
async fn run_trip_channel(sync: Handle, api: Api, socket: SocketHandle, session: Session) {
    let topic = sync.topic();                                // "trip:" 加旅行 id 的小寫 UUID 文字
    socket.join(&topic, &sync.presence_key());               // 帶 Session 目前的 access token
    let mut refreshed_for_join = false;                      // 換發後的加入仍回報過期時，改依退避重試（需求 11.8）
    let mut token_expired = false;
    while let Some(event) = socket.next_event(&topic).await {
        match event {
            Inbound::JoinOk { .. } => {
                refreshed_for_join = false;
                sync.presence_rejoined();                    // on_rejoin()，再 offer 目前的 Presence_Meta（需求 15.6）
                match resync(&sync, &api).await {            // 加入之後才補齊，不留空窗（D6、需求 12.1、12.2）
                    Ok(()) => sync.set_conn(ConnState::Live),// 重新加入並補齊之後移除「重新連線中」（需求 11.11）
                    Err(error) => if on_resync_error(&sync, &error) { return },
                }
            }
            Inbound::JoinError { reason, .. } if reason.starts_with("Unauthorized") => {
                // 權限不足：不是 Trip_Member 也不是 Admin、旅行已刪除，或頻道名稱不對。只有這種拒絕會離開（需求 11.10）
                return sync.leave_trip("你已無法存取這趟旅行。");
            }
            Inbound::JoinError { reason, .. } if reason.starts_with("InvalidJWTExpiration") && !refreshed_for_join => {
                refreshed_for_join = true;
                if !refresh_then_rejoin(&sync, &socket, &session, &topic).await { return }   // 需求 11.8
            }
            Inbound::JoinError { .. } | Inbound::JoinTimeout { .. } => {
                // 暫時性的拒絕（例如 RealtimeRestarting、資料庫連線錯誤、速率限制、換發後仍回報過期）
                // 或 10 秒內沒有回覆：顯示重新連線的提示，依退避重試，不離開旅行頁（需求 11.7）
                sync.set_conn(ConnState::Reconnecting);
                socket.rejoin_after_backoff(&topic, now_ms());
            }
            Inbound::Broadcast { payload, .. } => {
                let need = match serde_json::from_value::<Broadcast>(payload) {
                    Ok(message) => sync.on_broadcast(message),
                    Err(_) => Some(Resync::ChangesAfter(sync.watermark())),   // 看不懂的訊息：直接補齊（需求 12.4）
                };
                if let Some(need) = need {
                    if let Err(error) = resync_from(&sync, &api, need).await {
                        if on_resync_error(&sync, &error) { return }
                    }
                }
            }
            Inbound::PresenceState { state, .. } => sync.presence_reset(state),   // 取代全部，包括重新加入之前的（需求 15.7）
            Inbound::PresenceDiff { joins, leaves, .. } => sync.presence_apply(joins, leaves),
            // channel 層級的 system 錯誤之後一定是 phx_close。「Token has expired」要先換發再立即重新加入（需求 11.9）；
            // 「Client presence rate limit exceeded」照一般的關閉處理，依退避重新加入，只顯示重新連線的提示（需求 15.13）
            Inbound::System { message, .. } => token_expired = message.contains("Token has expired"),
            Inbound::ChannelClosed { .. } | Inbound::ChannelError { .. } => {
                sync.set_conn(ConnState::Reconnecting);
                if std::mem::take(&mut token_expired) {
                    if !refresh_then_rejoin(&sync, &socket, &session, &topic).await { return }
                } else {
                    socket.rejoin_after_backoff(&topic, now_ms());
                }
            }
            // WebSocket 斷線、無法建立，或 heartbeat 逾時：PhoenixSocket 依退避重新連線，連上後自動重送 phx_join（需求 11.7）
            Inbound::Disconnected => sync.set_conn(ConnState::Reconnecting),
            _ => {}
        }
    }
}

/// 換發 Session；成功時立即以新的 access token 重新加入。換發被拒絕（401）時依需求 4.9 離開，回傳 false；
/// 網路錯誤、429 或 5xx 時保留 Session，依退避重試（需求 4.13）。
async fn refresh_then_rejoin(sync: &Handle, socket: &SocketHandle, session: &Session, topic: &str) -> bool {
    match session.refresh().await {                          // 成功時 set_access_token() 也更新每個已加入的頻道（需求 4.5）
        Refresh::Ok => { socket.rejoin_now(topic); true }
        Refresh::Rejected => { sync.on_session_rejected(); false }
        Refresh::Unavailable => { socket.rejoin_after_backoff(topic, now_ms()); true }
    }
}

/// 補齊失敗的處理；回傳 true 表示已離開旅行頁。
/// 404（例如旅行已被刪除，但 trip_deleted 的推送沒有送達）：停止補齊、離開 Trip_Channel 與目前的頁面，前往 Home_Page，
/// 顯示伺服器回應的訊息「找不到這趟旅行。」（需求 12.16）。
/// 網路錯誤、逾時或 5xx：Replica 與 Watermark 不變，等下一次跳號、Thin_Notice、可見／online／60 秒的 Head 比對，
/// 或重新加入時再補齊；還沒有 Replica 時，下一次直接讀取 Snapshot（需求 12.17）。401 已在 API 層處理（需求 4.8）。
fn on_resync_error(sync: &Handle, error: &ApiError) -> bool {
    if error.status == 404 {
        sync.leave_trip(&error.message);
        return true;
    }
    false
}

/// 分頁回到前景、`online` 事件、或可見時每 60 秒呼叫一次：比對 head，有落後才補齊（需求 12.7）。
async fn check_head(sync: &Handle, api: &Api) -> Result<(), ApiError> {
    if !sync.has_replica() {
        // 第一次的 Snapshot 失敗過：直接重讀，不先比對 Head（需求 12.17）
        return resync_from(sync, api, Resync::Snapshot).await;
    }
    if api.head(sync.trip()).await? > sync.watermark() {
        resync(sync, api).await?;
    }
    Ok(())
}

/// 還沒有 Replica，或 Watermark 為 0 時讀取 Snapshot；否則讀取 Watermark 之後的 Change_Set（需求 12.1、12.2）。
/// 第一次的 Snapshot 合併之前，推送的 Change_Set 照常合併，Snapshot 到達後依需求 12.10 一起收斂；畫面在這之前顯示載入中。
async fn resync(sync: &Handle, api: &Api) -> Result<(), ApiError> {
    let need = if !sync.has_replica() || sync.watermark() == 0 { Resync::Snapshot } else { Resync::ChangesAfter(sync.watermark()) };
    resync_from(sync, api, need).await
}

async fn resync_from(sync: &Handle, api: &Api, mut need: Resync) -> Result<(), ApiError> {
    loop {
        need = match need {
            Resync::Snapshot => {
                sync.on_snapshot(api.snapshot(sync.trip()).await?);
                return Ok(());
            }
            Resync::ChangesAfter(watermark) => match api.changes(sync.trip(), watermark).await? {
                ChangesResponse::SnapshotRequired { .. } => Resync::Snapshot,
                changes => match sync.on_changes(changes) {
                    Some(more) => more,                      // 補齊期間又有新提交
                    None => return Ok(()),
                },
            },
        };
    }
}
```

### A8. 註冊（BFF）

```rust
// crates/server/src/auth.rs
pub async fn signup(st: &AppState, req: SignupRequest) -> Result<SignupResponse, ApiError> {
    // 依需求 3.1 的順序，只回應第一個不通過的檢查；訊息見 3.3
    let username = validate_username(&req.username)?;      // 格式（3.2）與保留字（3.3）；不轉換大小寫、不去除空白
    let display_name = validate_display_name(&req.display_name)?;   // Participant_Name 之後檢查（3.4）
    validate_password(&req.password)?;                     // 原樣：12–72 字元，且 UTF-8 不超過 72 位元組（3.5）
    if req.invite.is_none() && !st.config.public_signup {
        return Err(ApiError::forbidden("signup_invite_only", "目前只接受以邀請連結註冊。"));   // 3.7
    }
    if let Some(invite) = &req.invite {
        invites::check_usable(&st.db, &invite.token).await?;   // 先做便宜的檢查（30.13）；交易中會再驗證一次
    }
    let email = format!("{username}@{}", st.config.auth_email_domain);
    let user = st.auth.create_user(&email, &req.password, &json!({ "username": username }))
        .await
        .map_err(|e| match e {
            AuthError::AlreadyExists => ApiError::conflict("username_taken", "這個帳號名稱已被使用。"),   // 3.6
            other => {                                     // 拒收 email、無法連線或其他錯誤（3.11）；記錄不含密碼
                tracing::error!(error = %other, "auth create_user failed; check LM_AUTH_EMAIL_DOMAIN if the email was rejected");
                ApiError::internal("signup_unavailable", "註冊暫時無法使用，請聯絡管理員。")
            }
        })?;

    let joined = async {
        let mut tx = st.db.begin().await?;
        // 第一個帳號成為管理員；advisory lock 讓兩個同時註冊的人只有一個成為管理員
        sqlx::query("select pg_advisory_xact_lock(hashtext('app.first_admin'))").execute(&mut *tx).await?;
        let role = if repo::profile_count(&mut tx).await? == 0 { Role::Admin } else { Role::Member };
        repo::insert_profile(&mut tx, user, &username, &display_name, role).await?;   // 帳號名稱重複時轉成 3.6 的 409
        let trip_id = match &req.invite {
            // 鎖住旅行、再驗證邀請、檢查旅伴名字與角色（30.15）、新增綁定旅伴、標記已使用、寫入變更集（其他成員即時看到新旅伴）
            Some(invite) => Some(invites::join_in_tx(&mut tx, user, invite).await?),
            None => None,
        };
        tx.commit().await?;
        Ok::<Option<TripId>, ApiError>(trip_id)
    }.await;

    let trip_id = match joined {
        Ok(trip_id) => trip_id,
        Err(error) => {
            // 補償（3.10）：交易已回滾；刪除剛建立的 Auth 使用者，使這個帳號名稱可以再註冊。
            // 刪除也失敗時只記錄使用者 id。回應原本的錯誤，例如「邀請連結無效或已過期。」；
            // Database 的連線或執行錯誤回應 500「註冊暫時無法使用，請聯絡管理員。」
            if st.auth.delete_user(user).await.is_err() {
                tracing::error!(%user, "failed to delete auth user after signup rollback");
            }
            return Err(error.or_signup_unavailable());
        }
    };
    // 交易已提交：Account 與加入旅行的結果都保留。取得 Session 失敗（例如 Auth 限流或無法連線）時回 503（3.16）
    let session = login_with_email(st, &email, &req.password).await.map_err(|_| {
        ApiError::unavailable("signup_login_unavailable", "帳號已建立，但暫時無法登入，請稍後到登入頁登入。")
    })?;
    Ok(SignupResponse { session, trip_id })                // trip_id 讓 Invite_Page 直接前往 Trip_Page（30.18）
}
```

### A9. 改日期 `retime_by_day_index()`

```rust
// crates/core/src/dates.rs
pub struct BlockedDay { pub n: usize, pub date: Date, pub routes: bool, pub settings: bool }

/// 移植 retimeByDayIndex()：第 N 天的路線與每日設定仍在第 N 天；活動與料理的第 N 天保持第 N 天，
/// 超過新天數的併到新的最後一天，不在舊範圍內的放到第 1 天。
/// 被刪掉的日子上有路線，或有標題、地點的每日設定時，不允許縮短。
pub fn retime_by_day_index(draft: &mut TripState, start: Date, end: Date) -> Result<(), Vec<BlockedDay>> {
    let new_days = date_range(start, end);                 // 呼叫前已確認為 1–31 天
    let old_days = date_range(draft.card.start, draft.card.end);
    let blocked: Vec<BlockedDay> = old_days.iter().enumerate().skip(new_days.len())
        .filter_map(|(i, &date)| {
            let routes = draft.routes.values().any(|r| r.day == date);
            let settings = draft.day_settings.get(&date).is_some_and(DaySetting::has_title_or_place);
            (routes || settings).then_some(BlockedDay { n: i + 1, date, routes, settings })
        })
        .collect();
    if !blocked.is_empty() {
        return Err(blocked);
    }
    let index: HashMap<Date, usize> = old_days.iter().enumerate().map(|(i, &d)| (d, i)).collect();
    let last = new_days.len() - 1;
    let clamp = |d: Date| new_days[index.get(&d).copied().unwrap_or(0).min(last)];
    for a in draft.activities.values_mut() { a.day = clamp(a.day); }
    for m in draft.meals.values_mut() { m.day = clamp(m.day); }
    for r in draft.routes.values_mut() { r.day = new_days[index[&r.day]]; }   // 被刪的日子上已確認沒有路線
    // 每日設定以日期為鍵：整張表重建，再由 diff() 產生刪除與新增，新舊日期重疊也不會互相覆蓋
    draft.day_settings = std::mem::take(&mut draft.day_settings)
        .into_values()
        .filter_map(|s| index.get(&s.day).copied().filter(|&i| i <= last).map(|i| DaySetting { day: new_days[i], ..s }))
        .map(|s| (s.day, s))
        .collect();
    draft.card.start = start;
    draft.card.end = end;
    Ok(())
}
```

### A10. 文字版 `itinerary_text()`

文字版維持現在的格式（已確認 5）：與現行行程繪本「複製文字」對同一份資料複製的文字相同。來源是 `src/storybook/app.js` 的 `renderItinerary()`（決定各行的內容與先後）與 `copyItinerary()`（把 `h3`、`h4`、`p`、`li` 逐一取出，`li` 前面加「・」，以 `\n` 連接），資料由 `src/storybook-adapter.js` 的 `project()` 整理（每一天的路線、活動與料理、停靠點的採買品項、未分配採買清單）。與現行的差異只有已確認 4 的兩處改變：

- 活動與料理不是空白的備註另起一行，以兩個半形空格開頭（需求 31.10）；現行 `copyItinerary()` 以 `li.textContent` 擷取，備註接在同一行的最後。
- 抵達行由每日設定的預計抵達時間產生：「預計 {HH:MM} 抵達{Day_Place 的名稱}」（需求 31.8）；現行是繪本的自由文字 `arrivalLabel`。

現行版中只屬於行程繪本的內容不輸出，因為行程繪本不在第一版、這些欄位也不存在：旅行名稱之後的標語與說明（`plan.headline`、`plan.caption`，需求 31.2），以及非採買停靠點的自訂品項（`project()` 的 `st.items`，需求 31.6）。其餘與現行相同，包括：每一天的路線依建立順序（Ordinal）列出，與 `project()` 依 `state.routes` 陣列順序相同（需求 31.5）——`sorted_routes()` 依出發時間排序，只用於規劃行程的路線卡片（需求 22.2）；每日設定的路線位置（before／after）決定路線區塊（含抵達行）與活動區塊的先後（需求 31.12）；採買停靠點的品項由 `shopping_plan()` 推導，超過 8 項時列前 7 項再加「等另外 N 項」（現行 `project()` 的 `derivedItems`，需求 31.7）。

輸出格式（每行以 `\n` 分隔，清單項目以「・」開頭；所有使用者文字先經 `clean_text()`，把含換行的空白壓成一個空格）：

```
{旅行名稱}
車輛：{車名、車名…｜尚未安排}
第 {n} 天・{M/D}（週{X}）｜{當日標題｜未命名的一天}
地點：{當日地點｜旅行目的地｜未指定}
路線                                          （當天有路線時）
・{車名}｜{HH:MM 出發｜出發時間未填}：{起點} → {停靠點} → … → {終點}   （依路線的建立順序）
預計 {HH:MM} 抵達{地點}                         （有預計抵達時間時；路線區塊的最後一行）
活動
・{HH:MM} {標題}（{類別}）[・餐點]               （沒有任何活動與料理時為「無安排」）
  {備註}                                       （有備註時）
…（每一天重複；當日設定為「路線在後」時，活動區塊在路線區塊之前）
未分配採買清單                                  （有「待分配」品項時）
・{品項名稱}
```

停靠點寫成 `{地點}（{任務}{ HH:MM｜・時間未填}{：品項、…；備註}）`。只有採買停靠點有品項：由 `shopping_plan()` 推導（品項負責人所在的車、那台車最早的採買停靠點），依採買品項的建立順序，超過 8 項時列前 7 項再加「等另外 N 項」，與現行 `derivedItems` 相同；其他種類的停靠點只有備註。

```rust
// crates/core/src/itinerary_text.rs
pub fn itinerary_text(s: &TripState) -> String {
    let plan = shopping_plan(s);
    let mut out: Vec<String> = Vec::new();
    out.push(clean_text(&s.card.title));                   // 現行接在這裡的繪本標語與說明不輸出（需求 31.2）
    let cars: Vec<String> = s.vehicles_by_ordinal().map(|v| clean_text(&v.name)).collect();
    out.push(format!("車輛：{}", if cars.is_empty() { "尚未安排".to_string() } else { cars.join("、") }));

    for (i, day) in date_range(s.card.start, s.card.end).into_iter().enumerate() {
        let setting = s.day_settings.get(&day);
        let title = setting.and_then(|d| d.title.as_deref()).map(clean_text).filter(|t| !t.is_empty());
        out.push(format!("第 {} 天・{}｜{}", i + 1, date_text(day), title.as_deref().unwrap_or("未命名的一天")));
        let place = day_place_name(s, setting);            // 當日地點，否則非空白的旅行目的地
        out.push(format!("地點：{}", place.as_deref().unwrap_or("未指定")));

        let mut route_block = Vec::new();
        // 依建立順序，與現行 project() 相同；路線卡片的 sorted_routes()（依出發時間）不用在這裡（需求 31.5）
        let routes: Vec<String> = day_routes_by_ordinal(s, day).map(|r| format!("・{}", route_line(s, &plan, r))).collect();
        if !routes.is_empty() {
            route_block.push("路線".to_string());
            route_block.extend(routes);
        }
        if let Some(t) = setting.and_then(|d| d.arrival) {
            route_block.push(match &place { Some(name) => format!("預計 {t} 抵達{name}"), None => format!("預計 {t} 抵達") });
        }
        let events = event_lines(s, day);                  // 活動與料理依時間；同時間活動在前，再依建立順序
        let mut event_block = vec!["活動".to_string()];
        if events.is_empty() { event_block.push("無安排".to_string()); } else { event_block.extend(events); }

        if setting.is_some_and(|d| d.route_position == RoutePosition::After) {
            out.extend(event_block);
            out.extend(route_block);
        } else {
            out.extend(route_block);
            out.extend(event_block);
        }
    }

    let unassigned: Vec<String> = plan.unassigned.iter()
        .filter(|u| u.code == UnassignedCode::Unassigned)  // 只列「待分配」的品項，與現行相同
        .map(|u| clean_text(&u.item.name))
        .filter(|n| !n.is_empty())
        .collect();
    if !unassigned.is_empty() {
        out.push("未分配採買清單".to_string());
        out.extend(unassigned.into_iter().map(|n| format!("・{n}")));
    }
    out.join("\n")
}

/// 「{車名}｜{HH:MM 出發｜出發時間未填}：{起點} → {停靠點} → … → {終點}」
fn route_line(s: &TripState, plan: &ShoppingPlan, r: &Route) -> String {
    let depart = r.depart.map_or("出發時間未填".to_string(), |t| format!("{t} 出發"));
    let mut parts = vec![place_ref_name(s, r.from)];
    parts.extend(r.stops.iter().map(|stop| stop_text(s, plan, stop)));
    parts.push(place_ref_name(s, r.to));
    format!("{}｜{}：{}", vehicle_name(s, r.vehicle), depart, parts.join(" → "))
}

fn stop_text(s: &TripState, plan: &ShoppingPlan, stop: &Stop) -> String {
    let task = stop.task.unwrap_or_else(|| default_task(stop.kind)).label();
    let time = stop.time.map_or("・時間未填".to_string(), |t| format!(" {t}"));
    // 只有採買停靠點有品項；現行繪本給其他停靠點的自訂品項不在第一版（需求 31.6）
    let items = if stop.kind == StopKind::Shop { stop_item_names(plan.stop_items(stop.id)) } else { Vec::new() };
    let extra: Vec<String> = [items.join("、"), clean_text(&stop.note)].into_iter().filter(|x| !x.is_empty()).collect();
    let extra = if extra.is_empty() { String::new() } else { format!("：{}", extra.join("；")) };
    format!("{}（{}{}{}）", place_ref_name(s, stop.place), task, time, extra)
}
```

活動的類別文字是 `ACTIVITY_CATEGORIES` 的標籤；料理的標題是 `meal_title()`（「{餐次}：{名稱}」），類別依 `infer_dish_kind()` 與餐次得到火鍋、烤肉、早餐、午餐或用餐（現行 `mealKind()`）。「文字版」區塊以 `<pre>` 的文字節點顯示這段字串（保留換行與行內的連續空白，需求 31.17）；「複製文字」把按下當時顯示的字串原樣寫入剪貼簿（`navigator.clipboard.writeText`），成功時按鈕改為「已複製」，1.8 秒後恢復；失敗時選取 `<pre>` 中的整段文字讓使用者手動複製，按鈕改為「複製失敗」，1.8 秒後恢復（需求 31.15、31.16）。

### A11. Presence 節流

```rust
// crates/core/src/presence.rs
impl PresenceThrottle {
    pub fn offer(&mut self, meta: PresenceMeta, now_ms: f64) -> ThrottleAction {
        if self.sent.as_ref() == Some(&meta) {
            self.pending = None;                           // 這次加入之後對方看到的已是這個狀態（需求 15.5）
            return ThrottleAction::Nothing;
        }
        match self.last_sent {
            Some(t) if now_ms - t < Self::MIN_GAP_MS => {
                self.pending = Some(meta);                 // 只留最新的一筆
                ThrottleAction::WakeAt(t + Self::MIN_GAP_MS)
            }
            _ => {
                self.last_sent = Some(now_ms);
                self.sent = Some(meta.clone());
                self.pending = None;
                ThrottleAction::Send(meta)
            }
        }
    }

    pub fn wake(&mut self, now_ms: f64) -> ThrottleAction {
        match self.pending.take() {
            Some(meta) => self.offer(meta, now_ms),
            None => ThrottleAction::Nothing,
        }
    }

    /// 加入 Trip_Channel 成功後呼叫：Realtime 已沒有這個分頁的 presence，所以「與上次送出的相同」改為只和這次加入之後
    /// 送出的比較（需求 15.5），保留中的那一筆也一併捨棄。last_sent 保留，6.5 秒的間隔跨重新加入仍然成立（需求 15.3、15.6）。
    /// 呼叫端接著以這個分頁目前的 Presence_Meta 呼叫 offer()，因此最後一次開啟或關閉表單的狀態一定會重送；
    /// 這個分頁從未回報過 Presence_Meta 時，呼叫端不呼叫 offer()。
    pub fn on_rejoin(&mut self) {
        self.sent = None;
        self.pending = None;
    }
}
```

兩次送出至少相隔 6.5 秒，重新加入也不例外，所以任何 30 秒的區間最多 ⌊30 ÷ 6.5⌋ + 1 = 5 次。

### A12. `RowStore::sync()`

```rust
// crates/web/src/sync/store.rs
impl<K, T, S> RowStore<K, T, S>
where
    K: Copy + Eq + Hash + Send + Sync + 'static,
    T: Clone + PartialEq + Send + Sync + 'static,
    S: Ord,
{
    pub fn sync(&self, key: K, next: Option<T>) {
        match (self.get(key), next) {
            (Some(signal), Some(row)) => {
                let moved = signal.with_untracked(|old| (self.sort_key)(old) != (self.sort_key)(&row));
                if signal.with_untracked(|old| old != &row) {
                    signal.set(row);                       // 只通知讀這一列的元件
                }
                if moved {
                    self.resort();
                }
            }
            (None, Some(row)) => {
                self.rows.update_value(|map| { map.insert(key, ArcRwSignal::new(row)); });
                self.resort();
            }
            (Some(_), None) => {
                self.rows.update_value(|map| { map.remove(&key); });
                self.keys.update(|keys| keys.retain(|k| *k != key));
            }
            (None, None) => {}
        }
    }

    fn resort(&self) {
        let sorted: Vec<K> = self.rows.with_value(|map| {
            let mut entries: Vec<(S, K)> = map.iter()
                .map(|(k, signal)| signal.with_untracked(|row| ((self.sort_key)(row), *k)))
                .collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));         // 排序鍵都含 ordinal，不會相等
            entries.into_iter().map(|(_, k)| k).collect()
        });
        if self.keys.with_untracked(|current| current != &sorted) {
            self.keys.set(sorted);
        }
    }
}
```

### A13. 編輯者頭像

```rust
// crates/core/src/presence.rs
use std::collections::BTreeMap;
use unicode_segmentation::UnicodeSegmentation;

/// 修剪後顯示名稱的第一個擴充字素叢集。graphemes(true) 依 UAX #29 的擴充規則切分，
/// 所以 ZWJ 連接的 emoji、國旗（兩個區域指示符號）、膚色修飾與組合字元都留在同一個叢集。
pub fn avatar_initial(display_name: &str) -> AvatarInitial {
    match text::trim_white(display_name).graphemes(true).next() {
        Some(first) => AvatarInitial::Grapheme(first.to_owned()),
        None => AvatarInitial::Placeholder,
    }
}

/// 帳號 id 的 16 個位元組 → FNV-1a（64 位元）→ 色盤索引。
/// 不用 std 的 Hasher：它的演算法不保證跨 Rust 版本穩定，HashMap 預設的 RandomState 每次執行還會換金鑰。
pub fn avatar_color(user: UserId) -> AvatarColor {
    let index = fnv1a_64(user.0.as_bytes()) % AVATAR_PALETTE.len() as u64;
    AVATAR_PALETTE[index as usize]
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    bytes.iter().fold(OFFSET_BASIS, |hash, &byte| (hash ^ u64::from(byte)).wrapping_mul(PRIME))
}

pub fn readable_text_on(background: Rgb) -> Rgb {
    if contrast_ratio(INK, background) >= contrast_ratio(WHITE, background) { INK } else { WHITE }
}

/// WCAG 2.x：每個 sRGB 分量轉成線性值後加權。
pub fn relative_luminance(Rgb(r, g, b): Rgb) -> f64 {
    let linear = |v: u8| {
        let c = f64::from(v) / 255.0;
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

pub fn contrast_ratio(a: Rgb, b: Rgb) -> f64 {
    let (la, lb) = (relative_luminance(a), relative_luminance(b));
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

pub fn editor_stacks<'a>(metas: impl IntoIterator<Item = &'a PresenceMeta>, viewer: UserId)
    -> BTreeMap<EditTarget, EditorStack>
{
    // 1. 每個對象：帳號 id → 該帳號的第一筆 meta。內層 BTreeMap 讓同一帳號的多個分頁只留一筆，
    //    也讓順序固定為帳號 id 遞增，所以每個人看到的頭像順序相同。
    let mut by_target: BTreeMap<EditTarget, BTreeMap<UserId, &'a PresenceMeta>> = BTreeMap::new();
    for meta in metas {
        let Some(target) = &meta.editing else { continue };
        if meta.user == viewer {
            continue;                                      // 自己的分頁（包括其他裝置）不顯示
        }
        by_target.entry(target.clone()).or_default().entry(meta.user).or_insert(meta);
    }
    // 2. 前 MAX_SHOWN 位成為頭像，其餘進「+N」。頭像的字由完整的顯示名稱算出；顯示用的名稱修剪並截到 30 字元。
    by_target.into_iter()
        .map(|(target, users)| {
            let mut stack = EditorStack::default();
            for (user, meta) in users {
                let display_name: String = text::trim_white(&meta.display_name)
                    .chars().take(LIMITS.display_name).collect();
                if stack.shown.len() < EditorStack::MAX_SHOWN {
                    let initial = avatar_initial(&meta.display_name);
                    stack.shown.push(EditorAvatar { user, display_name, initial, color: avatar_color(user) });
                } else {
                    stack.hidden.push(display_name);
                }
            }
            (target, stack)
        })
        .collect()
}

/// 名稱是空的時候用「有人」，避免出現「 正在編輯」這種沒有主詞的文字。
fn who(display_name: &str) -> &str {
    if display_name.is_empty() { "有人" } else { display_name }
}

impl EditorAvatar {
    pub fn label(&self) -> String {
        format!("{} 正在編輯", who(&self.display_name))
    }

    pub fn tooltip(&self) -> String {
        if self.display_name.is_empty() { "未設定顯示名稱".to_owned() } else { self.display_name.clone() }
    }
}

impl EditorStack {
    pub fn total(&self) -> usize {
        self.shown.len() + self.hidden.len()
    }

    pub fn overflow_label(&self) -> Option<String> {
        (!self.hidden.is_empty()).then(|| {
            let names: Vec<&str> = self.hidden.iter().map(|n| who(n)).collect();
            format!("另外 {} 人正在編輯：{}", self.hidden.len(), names.join("、"))
        })
    }

    /// 與 EditorAvatar::tooltip() 一樣，空的名稱寫成「未設定顯示名稱」（需求 16.12）。
    pub fn overflow_tooltip(&self) -> Option<String> {
        (!self.hidden.is_empty()).then(|| {
            let names: Vec<&str> = self.hidden.iter()
                .map(|n| if n.is_empty() { "未設定顯示名稱" } else { n.as_str() })
                .collect();
            names.join("、")
        })
    }

    /// 前置條件：shown 不為空（editor_stacks() 不會產生空的堆疊）。
    pub fn notice(&self) -> String {
        let first = who(&self.shown[0].display_name);
        match self.total() {
            1 => format!("{first} 正在編輯這一項"),
            n => format!("{first} 等 {n} 人正在編輯這一項"),
        }
    }
}
```

每個用戶端執行同一份 wasm（`unicode-segmentation` 的版本鎖在 `Cargo.lock`），色盤與雜湊也相同，而且堆疊依帳號 id 排序。因此對同一份 presence 狀態，每個人看到的字、顏色與順序都一樣。`relative_luminance()` 與 `contrast_ratio()` 用到浮點數，但只在測試與建立色盤時使用；執行時的 `avatar_color()` 只做整數運算與查表。

## Key Functions with Formal Specifications

### `apply(state, ctx, mode, ids, cmd)`

**Preconditions:**
- `validate::state(state, Mode::Commit)` 成立（伺服器讀出的狀態，或客戶端的已確認狀態）。
- `ctx.caps` 是以這趟旅行的擁有者、行為者的角色與他綁定的旅伴，經 `capabilities()` 算出的。

**Postconditions:**
- 回傳 `Ok(o)` 時：`authorize(state, ctx.caps, cmd)` 成立；`validate::state(state ⊕ o.effects(), mode)` 成立；每個 Slot 在 `o.primary`、`o.derived` 中各最多一筆；沒有內容未變的列；`mode == Predict` 時 `o.derived` 為空。
- `o.created` 恰好是 `o.effects()` 中新增、而且有 ordinal 的列，每個 Slot 一次：先依命令中的順序列出主要效果的新列，再依 `SyncPlan.created` 的順序列出採買同步新增的 Meal_Item（需求 7.19）。
- `o.primary` 是空的時 `o.derived` 也是空的：想要的狀態已成立，或要刪除的列已不存在時，不執行採買同步，也沒有任何連帶效果（需求 7.12）。
- 回傳 `Err(r)` 時沒有任何副作用；`state` 本來就以唯讀參照傳入。權限的拒絕先於「目標不存在」、驗證與「沒有變化」的判斷（需求 6.4）。
- 決定性：相同的 `state`、`ctx`、`mode`、`cmd` 與相同的 `ids` 序列，得到相同的結果。
- 集合命令（`SetShoppingPurchased`、`SetGearPacked`、`SetDeparted`、`SetActivityDone`）在目標狀態已成立時回傳 `o.is_noop()`。

**Loop Invariants:** 見 A3 的步驟 3。

### `authorize(state, caps, cmd)`

**Preconditions:** `caps` 由 `capabilities()` 算出。

**Postconditions:**
- `caps.can_edit == false` ⇒ `Err(NotFound)`。
- 否則結果等於「權限」表格中該命令所在列的判斷（屬性 8）；不讀寫任何狀態以外的資料。

**Loop Invariants:** N/A

### `sync_meal_ingredients(state, ids)`

**Preconditions:** `state` 的料理與採買品項滿足 I1；`ids` 每次回傳新的、不與既有品項重複的 id。

**Postconditions:**
- `plan.deletes` 中的每個品項都是 `source == Meal`、未買，且沒有任何被料理需要的鍵由它負責。
- 手動品項與已買品項一定留下；留下的品項的數量、分類、負責人與已買狀態不變。
- 套用 `plan` 後，每個被料理需要的食材鍵都被某個品項涵蓋（I9）。
- 冪等：對套用後的狀態再算一次，得到空的 `plan`（屬性 4）。
- `plan.created` 依料理的 ordinal、再依食材在料理中第一次出現的順序列出新增的 Meal_Item（需求 7.19）。
- `plan.unlinked_expenses` 恰好是連結到 `plan.deletes` 中品項的支出；套用後沒有任何支出連結到不存在的品項，這些支出的其他欄位不變（需求 29.13）。
- 品項總數超過 1000 時回傳 `Err(Conflict)`，不產生部分結果。

**Loop Invariants:** 見 A3。

### `parse_ingredients(text)`

**Preconditions:** 無（任何字串）。

**Postconditions:**
- 每個結果都不是空字串、沒有前後的 JS_Whitespace，內部連續的 JS_Whitespace 已壓成一個半形空格（U+0085 不是 JS_Whitespace，會留在名稱中）。
- 結果的 `ingredient_key` 兩兩不同，並保持第一次出現的順序。
- `parse_ingredients(結果以「、」串接) == 結果`（再切一次不變）。

**Loop Invariants:** 掃描到第 i 個字元時，`parts` 加上 `current` 依序串接，等於前 i 個字元刪去分隔字元後的結果。

### `Replica::apply_changeset(cs)`

**Preconditions:** `cs` 由伺服器產生：`cs.changes` 中每個 Slot 最多一筆，且每筆 `version == cs.seq`。

**Postconditions:**
- `cs.seq ≤ watermark` 或已在 `ahead` 中時，狀態完全不變，`duplicate == true`。
- 否則每個 Slot 的版本為 `max(原版本, 變更版本)`，內容為版本較大者；`watermark` 是最大的 w，使得 1..=w 的變更集全部已套用；`gap` 回報第一段缺少的序號。
- `changed` 恰好是內容改變的 Slot（屬性 3）。

**Loop Invariants:** 處理過的每個 Slot 都滿足「目前內容來自目前為止看過的最大版本」。

### `Replica::apply_snapshot(snap)`

**Preconditions:** `snap` 是伺服器在某個 seq 的一致狀態（同一個 REPEATABLE READ 交易）。

**Postconditions:**
- 結果等於「以 seq ≤ snap.seq 的全部變更集，加上原本已套用、seq > snap.seq 的變更集」重建的狀態。
- `watermark ≥ snap.seq`；版本 ≤ watermark 的墓碑全部清除。

**Loop Invariants:** N/A

### `overlay(confirmed, pending, ctx)`

**Preconditions:** `confirmed` 是 `Replica.state`。

**Postconditions:**
- `pending` 為空 ⇒ 結果等於 `confirmed`。
- 結果等於依序把每個在當下成立的 pending 命令的主要效果疊到 `confirmed` 上；移除任何一個 pending 命令後，結果等於其餘命令的 overlay（回復沒有殘留，屬性 11）。

**Loop Invariants:** 處理完前 k 個命令後，`view == overlay(confirmed, pending[..k])`。

### `execute(st, user, trip, req)`

**Preconditions:** `user` 已通過 JWT 驗證並有 profile。

**Postconditions:**
- 請求者不是 Trip_Member 也不是 Admin 時回應 404「找不到這趟旅行。」，即使 `command_id` 與這趟旅行已提交的 Change_Set 相同（需求 6.2）。
- 成功提交時：`trips.seq` 剛好加一；寫入的列與 `app.trip_changes` 中的變更集一致；變更集在同一個交易中交給 `realtime.send()`；第 k 個新列（`outcome.created` 的順序）的 ordinal 是 `head.next_ordinal + k`。
- 同一個 `command_id` 第二次送達時，回傳第一次的變更集並標示 `replayed`，不再寫入。
- 請求者是 Unbound_Admin 時，回應中的變更集（包括重送）不含 Ledger_Rows；`app.trip_changes` 仍保存完整的內容（需求 6.12、8.7）。
- 拒絕、無效果或任何錯誤時，資料庫不變，也不推送。
- 同一趟旅行的兩個命令不會交錯執行；不同旅行的命令互不等待。

**Loop Invariants:** 依 `outcome.created` 指定 ordinal 時，處理完前 k 個新列後，它們依序得到 `head.next_ordinal` 到 `head.next_ordinal + k − 1`。

### `retime_by_day_index(draft, start, end)`

**Preconditions:** `date_range(start, end)` 為 1–31 天；`draft` 滿足 I5。

**Postconditions:**
- 回傳 `Err(blocked)` 時 `draft` 不變，`blocked` 依天數順序列出每個阻擋的日子。
- 回傳 `Ok` 時：舊第 N 天的路線與每日設定在新第 N 天；活動與料理的天數為 `min(N, 新天數)`；旅行日期為新的起訖；`draft` 滿足 I5（屬性 16）。

**Loop Invariants:** N/A

### `itinerary_text(state)`

**Preconditions:** `validate::state(state, Mode::Commit)` 成立。

**Postconditions:**
- 只依列的內容與順序鍵（日期、時間、`ordinal`）決定；與 `BTreeMap` 的建立過程、列的插入順序無關（屬性 13）。
- 每一天剛好出現一次「第 n 天」行，依日期遞增；每一天的路線依 ordinal 排列（不依出發時間）。
- 各行的內容、標點與先後與現行 `copyItinerary()` 對同一份資料複製的文字相同，只差已確認 4 的兩處：不是空白的活動與料理備註在下一行、以兩個半形空格開頭；有預計抵達時間的日子在路線區塊最後多一行「預計 {HH:MM} 抵達{地點}」。現行繪本的標語、說明與停靠點自訂品項不出現；使用者文字中的換行依需求 31.14 換成一個空格（已確認 5）。
- 換行字元只有分隔各行的 `\n`；第一行之前與最後一行之後都沒有換行字元（需求 31.2、31.14）。

**Loop Invariants:** 處理完前 i 天後，輸出包含第 1 到 i 天的區塊，且順序正確。

### `PresenceThrottle::offer(meta, now)`、`wake(now)` 與 `on_rejoin()`

**Preconditions:** `now` 單調不減。

**Postconditions:**
- 任何長度 30 秒的區間內，`Send` 最多 5 次，中間穿插 `on_rejoin()` 也一樣（需求 15.3）。
- 每次 `Send` 的 meta 都不等於最近一次 `on_rejoin()` 之後上一次送出的 meta（需求 15.5）。
- 只要在最後一次 `offer` 之後於 `WakeAt` 指定的時間呼叫 `wake`，最後一個 `meta` 一定已經送出，或與最近一次 `on_rejoin()` 之後上一次送出的相同；`on_rejoin()` 之後再 `offer` 同一個 meta 會再送出一次（需求 15.4、15.6，屬性 14）。

**Loop Invariants:** N/A

### `avatar_initial(display_name)`

**Preconditions:** 無（任何字串，包括空字串、只有空白，或以組合字元開頭的字串）。

**Postconditions:**
- 令 t = `trim_white(display_name)`。t 為空時回傳 `Placeholder`。
- 否則回傳 `Grapheme(g)`：g 是 t 的非空前綴，`g.graphemes(true).count() == 1`，而且 `t.graphemes(true).next() == Some(g)`。也就是說，g 不會把 ZWJ 連接的 emoji、國旗、膚色修飾或組合字元從中切開（屬性 18）。
- 結果只依 `display_name` 決定。

**Loop Invariants:** N/A

### `avatar_color(user)`

**Preconditions:** 無。

**Postconditions:**
- 回傳 `AVATAR_PALETTE` 中的一色，只依 `user` 的 16 個位元組決定：同一個帳號每次呼叫、在 wasm32 與原生環境都得到相同結果，因為只用整數運算與查表。
- 回傳值的文字色與底色對比 ≥ 4.5:1，而且文字色是 INK 與 WHITE 中對比較高的那一個（屬性 19）。

**Loop Invariants:** `fnv1a_64` 處理完前 i 個位元組後，累積值等於 FNV-1a 對這 i 個位元組的雜湊值。

### `editor_stacks(metas, viewer)`

**Preconditions:** 無。`metas` 可能包含同一帳號的多個分頁、`editing == None` 的項目，以及 viewer 自己的其他分頁。

**Postconditions:**
- 結果的鍵恰好是「至少有一個不是 viewer 的帳號正在編輯」的對象；沒有空的堆疊。
- 每個堆疊中的帳號兩兩不同、不含 viewer、依帳號 id 遞增；令 m 為正在編輯該對象、而且不是 viewer 的不同帳號數，則 `shown.len() == min(m, 3)`、`hidden.len() == m − shown.len()`。
- 只要同一帳號各分頁回報的顯示名稱相同，結果就與 `metas` 的走訪順序無關。

**Loop Invariants:** 處理完前 k 筆 meta 後，`by_target` 中每個對象恰好含有前 k 筆中正在編輯它、而且不是 viewer 的帳號。

### `ledger::split_evenly(amount_cents, participants)` 與 `ledger::summarize(state)`

**Preconditions:** `amount_cents ≥ 1`；`participants` 非空。

**Postconditions:**
- `split_evenly` 的金額總和等於 `amount_cents`，任兩人相差最多 1 分；多出的 1 分依旅伴 id 排序給前面的人（與現行相同；`Uuid` 的位元組順序與小寫十六進位字串的字典序一致）。
- `summarize` 的所有人淨額總和為 0；依建議轉帳執行後，所有人的淨額為 0（屬性 15）。

**Loop Invariants:** `settle_up` 的迴圈中，已產生的轉帳金額總和等於債務人已清償金額的總和。

### `RowStore::sync(key, next)`

**Preconditions:** 在 Leptos 的反應式執行環境中呼叫。

**Postconditions:**
- 內容相同時不通知任何 signal。
- 內容不同時只通知 `key` 的 signal；`keys` 只在新增、刪除或排序鍵改變時更新。

**Loop Invariants:** N/A

## Example Usage

### 前端：勾選已買（只重繪這一列）

```rust
// crates/web/src/views/shopping.rs
#[component]
pub fn ShoppingList() -> impl IntoView {
    let trip = use_trip();                                   // context 中的 TripSync handle
    let keys = trip.stores().shopping.keys();
    view! {
        <div class="shopping-list">
            <For each=move || keys.get() key=|id| *id children=move |id| view! { <ShoppingRow id=id/> }/>
        </div>
    }
}

#[component]
fn ShoppingRow(id: ShoppingId) -> impl IntoView {
    let trip = use_trip();
    let row = trip.stores().shopping.get(id).expect("keyed rows exist while rendered");
    let name = { let row = row.clone(); move || row.with(|r| r.name.clone()) };
    let checked = { let row = row.clone(); move || row.with(|r| r.purchased) };
    let on_change = move |ev: leptos::ev::Event| {
        let purchased = event_target_checked(&ev);           // 送出想要的狀態，不是切換（B4）
        if let Err(rejection) = trip.submit(Command::SetShoppingPurchased { id, purchased }) {
            toast(&rejection.to_string());
        }
    };
    view! {
        <div class="shopping-row">
            <label>
                <input type="checkbox" prop:checked=checked on:change=on_change/>
                <span>{name}</span>
            </label>
            // 別人正在編輯這個品項時顯示頭像；只有這個品項的堆疊改變才更新
            <EditorAvatars target=EditTarget { entity: Entity::Shopping, key: RowKey::Id(id.0) } compact=true/>
            // 負責人選單、數量與操作按鈕同樣只讀這一列的 signal
        </div>
    }
}
```

### 前端：卡片或列上的編輯者頭像

```rust
// crates/web/src/views/editors.rs
/// 顯示正在編輯這個對象的人（不含自己）：最多 3 個頭像，其餘以「+N」表示。
#[component]
pub fn EditorAvatars(target: EditTarget, #[prop(optional)] compact: bool) -> impl IntoView {
    let editors = use_trip().editors();                     // Memo<BTreeMap<EditTarget, EditorStack>>
    // 只取這個對象的堆疊；Memo 會比較前後的值，沒有改變就不通知，DOM 也不動
    let stack = Memo::new(move |_| editors.with(|all| all.get(&target).cloned()));
    let class = if compact { "editor-stack is-row" } else { "editor-stack is-card" };
    move || stack.get().map(|stack| view! {
        <span class=class>
            {stack.shown.iter().map(|a| view! {
                <span class="editor-avatar" role="img" aria-label=a.label() title=a.tooltip()
                      style:background-color=a.color.background.hex() style:color=a.color.text.hex()>
                    {a.initial.as_str().to_owned()}
                </span>
            }).collect_view()}
            {stack.overflow_label().map(|label| view! {
                <span class="editor-avatar editor-avatar-more" role="img" aria-label=label title=stack.overflow_tooltip()>
                    {format!("+{}", stack.hidden.len())}
                </span>
            })}
        </span>
    })
}
```

```rust
// crates/core/tests/presence_avatar.rs（範例）
#[test]
fn initial_is_first_grapheme_of_trimmed_display_name() {
    assert_eq!(avatar_initial("陳小明"), AvatarInitial::Grapheme("陳".into()));
    assert_eq!(avatar_initial("  amy chen "), AvatarInitial::Grapheme("a".into()));
    assert_eq!(avatar_initial("👨\u{200d}👩\u{200d}👧 一家"), AvatarInitial::Grapheme("👨\u{200d}👩\u{200d}👧".into()));
    assert_eq!(avatar_initial("🇹🇼台灣"), AvatarInitial::Grapheme("🇹🇼".into()));
    assert_eq!(avatar_initial("e\u{301}va"), AvatarInitial::Grapheme("e\u{301}".into()));
    assert_eq!(avatar_initial("\u{3000}\t\n"), AvatarInitial::Placeholder);
}
```

### 伺服器：路由

```rust
// crates/server/src/main.rs（節錄）
// 啟動檢查依 3.5 的順序；每一步失敗都印出原因並以非 0 的結束代碼結束，不印出金鑰與密碼
let config = Config::from_env().unwrap_or_else(|errors| exit_with(&errors));   // 讀 .env、Trim_White、格式（需求 2.7、2.11）
config.refuse_sample_secrets_off_loopback().unwrap_or_else(|e| exit_with(&e)); // B12（需求 2.6）
let db = connect_within(&config.database_url, Duration::from_secs(30)).await    // 需求 2.12
    .unwrap_or_else(|e| exit_with(&e.redacted()));                               // 只印出主機、埠與原因
let state = AppState::new(&config, db);

let api = Router::new()
    .route("/auth/signup", post(auth::signup_handler))
    .route("/auth/login", post(auth::login_handler))
    .route("/auth/refresh", post(auth::refresh_handler))
    .route("/auth/logout", post(auth::logout_handler))
    .route("/me", get(auth::me))
    .route("/trips", get(trips::list).post(trips::create))
    .route("/trips/{id}", delete(trips::delete))
    .route("/trips/{id}/snapshot", get(trips::snapshot))
    .route("/trips/{id}/changes", get(trips::changes))
    .route("/trips/{id}/head", get(trips::head))
    .route("/trips/{id}/commands", post(commands::handler))
    .route("/trips/{id}/invites", get(invites::list).post(invites::create))
    .route("/trips/{id}/invites/{invite_id}/revoke", post(invites::revoke))
    .route("/invites/{token}", get(invites::preview))
    .route("/invites/{token}/join", post(invites::join))
    // /api 自己的 fallback：不存在的 /api/* 路徑回 JSON 404，不會落到外層的 index.html（需求 5.9）
    .fallback(|| async { ApiError::new(StatusCode::NOT_FOUND, "api_not_found", "找不到這個 API。") })
    .method_not_allowed_fallback(|| async {
        ApiError::new(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed", "不支援這個操作。")
    });

let index = config.static_dir.join("index.html");
let app = Router::new()
    .nest("/api", api)
    .route("/realtime/v1/websocket", get(gateway::realtime_proxy))
    .fallback_service(ServeDir::new(&config.static_dir).fallback(ServeFile::new(index)))   // 只用於 /api 以外的路徑
    .with_state(state);

let listener = tokio::net::TcpListener::bind(config.bind).await                 // 需求 2.12
    .unwrap_or_else(|e| exit_with(&format!("無法在 {} 監聽：{e}", config.bind)));
axum::serve(listener, app).await?;
```

### `lm-core`：以模型伺服器測試規則

測試輔助 `ModelServer`（`crates/core/tests/support/`）以 `apply(Mode::Commit)` 執行命令，並和 `execute()` 一樣指定 `seq`、`version` 與 `ordinal`，因此規則與合併都能在不連資料庫的情況下測試。

```rust
// crates/core/tests/ingredients_sync.rs
#[test]
fn removing_a_meal_keeps_purchased_and_manual_items() {
    let mut t = ModelServer::two_day_trip();
    let cabbage = t.commit(&t.add_manual_item("高麗菜", "1 顆"));          // 手動品項涵蓋高麗菜
    let meal = t.commit_meal("暖暖壽喜燒", "牛肉片、板豆腐、高麗菜");       // 同步：新增牛肉片、板豆腐
    t.commit(&Command::SetShoppingPurchased { id: t.item_named("牛肉片"), purchased: true });
    t.commit(&Command::RemoveMeal { id: meal });

    assert!(t.item("牛肉片").is_some_and(|i| i.source == ItemSource::Manual));  // 已買：留下並改為手動
    assert!(t.state().shopping.contains_key(&cabbage));                         // 手動：留下
    assert!(t.item("板豆腐").is_none());                                         // 未買的料理品項：移除
}
```

```rust
// crates/core/tests/prop_replica.rs
// Feature: rust-supabase-rewrite, Property 1: 任意送達順序都收斂到伺服器狀態
proptest! {
    #[test]
    fn replica_converges_under_any_delivery(script in arb_script(), plan in arb_delivery_plan()) {
        let server = ModelServer::run(&script);               // 依序執行，得到 1..=n 的變更集與最後狀態
        let mut replica = Replica::from_snapshot(&server.snapshot_at(0));
        for event in plan.schedule(&server) {                 // 任意排列、重複、在任意位置插入某個 seq 的快照
            match event {
                Delivery::Change(cs) => { replica.apply_changeset(&cs); }
                Delivery::Snapshot(snapshot) => { replica.apply_snapshot(&snapshot); }
            }
        }
        prop_assert_eq!(&replica.state, server.state());
        prop_assert_eq!(replica.watermark, server.head());
    }
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

屬性只涵蓋 `lm-core` 的純函式（規則、合併、衍生資料、文字版、日期、分帳、Presence 節流與編輯者頭像），以 proptest 驗證。畫面、網路、資料庫與 Realtime 服務的行為不在屬性測試中（見「Testing Strategy」）。

共用產生器：

- `arb_state()`：1–5 天、0–6 位旅伴（部分綁定帳號）、0–3 台車、0–6 個地點、每台車每天 0–1 條路線（0–6 個停靠點）、0–10 個活動、0–8 道料理、0–15 個採買品項（料理與手動、已買與未買混合）、0–10 個裝備、0–5 筆支出（部分連結採買品項，包括未買的 Meal_Item）與還款。食材文字從一組詞彙組成，包含 `、，;；/。`、換行、`1.5`、`1,000`、全形數字、前後與中間的空白（包括 U+3000、U+FEFF 與 U+0085）、大小寫英文與重複名稱。
- `arb_command(state)`：大多數引用既有的列，也有不存在的 id、超過上限的文字、別人的旅伴與邊界值。
- `arb_caps(state)`：擁有者、管理員、綁定旅伴的受邀成員、沒有綁定旅伴的管理員、非成員。
- `ModelServer::run(script)`：依序以 `Mode::Commit` 執行一串 `(actor, command)`，產生連續 seq 的變更集與每個 seq 的快照。
- `arb_display_name()`：一半是任意 Unicode 字串（含空字串與只有空白的字串）；另一半從一組已知的字素叢集（「陳」、`e` 加 U+0301、`👨‍👩‍👧`、`🇹🇼`、`👋🏽`、`한`、`a`、`1`）任選 0–5 個串接，前後加上半形空白、全形空白 U+3000、tab 與換行。這組叢集兩兩串接都不會跨界合併，所以後一半有獨立的預期值：第一個被選的叢集，一個都沒選時為 `Placeholder`。
- `arb_user_id()`：任意 16 個位元組組成的 `UserId`。
- `arb_delivery_plan()`：把變更集排列、重複，隨機插入某個 seq 的快照；保證最後一個快照之後的每個變更集至少送達一次。

### Property 1: 任意送達順序都收斂到伺服器狀態

*For any* 由 `ModelServer::run()` 產生的變更集 1..=n，以及任何 `arb_delivery_plan()` 產生的送達方式（任意順序、重複、在任意位置插入任意 seq 的快照），`Replica` 處理完全部事件後，`state` 等於伺服器在 n 的狀態，`watermark == n`。

**Validates: Requirements 12.10, 12.12, 12.14**

### Property 2: 水位線與缺號回報正確

*For any* 1..=n 的任意子集合依任意順序送達，`watermark` 等於最大的 w 使得 1..=w 全部已送達；`ahead` 不為空時 `gap == Some((watermark + 1, min(ahead) − 1))`，否則為 `None`。

**Validates: Requirements 12.3, 12.11**

### Property 3: 只回報內容真的改變的列

*For any* `Replica` 與任何變更集或快照，`ApplyReport.changed` 作為集合，恰好等於「套用前後 `state.get(slot)` 不同」的 Slot 集合。

**Validates: Requirements 14.1**

### Property 4: 採買同步冪等

*For any* `arb_state()` 產生的狀態 s，令 s′ 為 s 套用 `sync_meal_ingredients(s)` 的結果，則 `sync_meal_ingredients(s′)` 的 `upserts` 與 `deletes` 都是空的。

**Validates: Requirements 25.14**

### Property 5: 採買同步不刪除手動與已買的品項，也不改使用者管理的欄位

*For any* 狀態 s，`sync_meal_ingredients(s).deletes` 中沒有 `source == Manual` 或 `purchased == true` 的品項；每個留下的品項的名稱、數量、分類、負責人與已買狀態都與 s 相同。同步對帳目唯一的改變，是把連結到被刪除品項的支出改為不連結採買品項：套用之後沒有任何支出連結到不存在的品項，這些支出的其他欄位、其他支出與還款都與 s 相同。

**Validates: Requirements 25.10, 25.11, 25.19, 29.13**

### Property 6: 採買同步涵蓋每一個需要的食材

*For any* 狀態 s，套用同步之後，每道料理的 `parse_ingredients(ingredients)` 中每個名稱的 `ingredient_key`，都等於某個品項名稱切分後的某個鍵；新增的品項數不超過同步前未被涵蓋的鍵數。

**Validates: Requirements 9.10, 25.6, 25.7, 25.8**

### Property 7: 勾選是冪等的集合操作

*For any* 狀態 s 與任何勾選命令 c（`SetShoppingPurchased`、`SetGearPacked`、`SetDeparted`、`SetActivityDone`），若 `apply(s, c)` 成功得到 s₁，則 `apply(s₁, c)` 成功且 `is_noop()`；目標欄位的最後值等於 c 指定的值，與 s 中原本的值無關。*For any* 兩個指向不同（項目、旅伴）組合的勾選命令 c₁、c₂，依 c₁c₂ 或 c₂c₁ 的順序套用得到相同的狀態。刪除命令也是冪等的：要刪除的列已不存在時，通過權限檢查的刪除命令回傳 `is_noop()`，主要效果與衍生效果都是空的。

**Validates: Requirements 7.11, 7.12, 7.13, 23.6, 26.9, 27.6, 28.2, 28.4**

### Property 8: 權限判斷與規則表一致

*For any* 身分（擁有者、管理員、受邀成員、沒有綁定旅伴的管理員、非成員）、任何命令種類、任何目標（自己或別人的旅伴、綁定或未綁定），`authorize()` 成功若且唯若測試中另外以查表實作的「權限」表格允許；被拒絕時的種類（404 或 403）也與表格相同。

**Validates: Requirements 6.1, 6.2, 6.4, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11**

### Property 9: 成功的命令一定保持不變式

*For any* 合法狀態 s、任何 `arb_caps()` 與任何 `arb_command(s)`（包含不合法的命令），`apply(s, Commit)` 回傳 `Ok(o)` 時 `validate::state(s ⊕ o.effects(), Commit)` 成立（I1–I12）；回傳 `Err` 時 s 不變。

**Validates: Requirements 7.15, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10, 9.11, 9.12, 9.13, 19.10**

### Property 10: 前端預測與伺服器的主要效果相同

*For any* s、caps 與命令 c，`apply(s, Predict)` 與 `apply(s, Commit)` 都成功時兩者的 `primary` 相同，且 Predict 的 `derived` 為空；Predict 失敗則 Commit 也失敗；Commit 只會在採買同步超過 1000 項時比 Predict 多一種失敗。（兩者使用同一份 s。Unbound_Admin 的 Replica 不含 Ledger_Rows，他的預測與提交不是同一份狀態，所以需求 13.5 另外列出移除仍有帳目的旅伴時，只在提交時出現的需求 19.14 的拒絕；這不在本屬性的範圍內。）

**Validates: Requirements 13.4, 13.5, 25.2**

### Property 11: 回復不留下殘留

*For any* 已確認狀態、pending 命令序列與其中任一個被拒絕的命令 k，移除 k 之後的 `overlay()` 等於只以其餘命令計算的 `overlay()`；pending 為空時 `overlay()` 等於已確認狀態。

**Validates: Requirements 13.6, 13.8**

### Property 12: 不同欄位的 patch 可交換，同一欄位以提交順序決定

*For any* 一列與兩個 patch p₁、p₂：若兩者修改的欄位不相交，依 p₁p₂ 與 p₂p₁ 的順序套用得到相同的列；若修改同一欄位，結果等於後套用者的值。對集合欄位（乘客、參加者），不同元素的加入與移除也可交換。

**Validates: Requirements 7.5, 7.6, 7.7**

### Property 13: 文字版是決定性的

*For any* 狀態 s，以不同的插入順序把同樣的列重新放進新的 `TripState`，`itinerary_text()` 的結果完全相同；同一個 s 呼叫兩次結果相同；輸出中「第 n 天」行剛好出現旅行天數次，依日期遞增；每一天的路線行依路線的 ordinal 排列，與出發時間無關。

**Validates: Requirements 31.1, 31.3, 31.5**

### Property 14: Presence 節流遵守 Realtime 的限制且不遺失最後狀態

*For any* 時間不遞減、任意穿插 `on_rejoin()` 的 `offer` 序列（每次 `on_rejoin()` 之後都以當時最後一次 offer 的 meta 再 offer 一次，與 LM_Web 的用法相同），並在每個 `WakeAt` 指定的時間呼叫 `wake`：任何 30 秒區間內的 `Send` 不超過 5 次；每次 `Send` 的 meta 都不等於最近一次 `on_rejoin()` 之後上一次送出的 meta；全部處理完之後，最後一次送出的 meta 等於最後一次 offer 的 meta；最後一次 `on_rejoin()` 之前若有過 offer，它之後至少送出一次，即使內容與重新加入之前送出的相同。

**Validates: Requirements 15.3, 15.4, 15.5, 15.6**

### Property 15: 分帳金額守恆

*For any* 支出與還款，`summarize()` 的淨額總和為 0；每筆 `split_evenly()` 的總和等於金額，任兩人相差最多 1 分；依建議轉帳全部執行後，每個人的淨額都是 0。

**Validates: Requirements 29.6, 29.7**

### Property 16: 改日期保留「第 N 天」

*For any* 合法狀態與新的 1–31 天範圍，`retime_by_day_index()` 成功時，舊第 N 天的路線與每日設定都在新的第 N 天，活動與料理在新的第 min(N, 新天數) 天，結果滿足 I5；失敗時 `draft` 不變，`blocked` 恰好是被刪掉、且有路線或有標題、地點的日子。

**Validates: Requirements 18.5, 18.6, 18.7, 18.8**

### Property 17: 食材切分再切一次不變

*For any* 字串 t，`parse_ingredients(parse_ingredients(t).join("、")) == parse_ingredients(t)`，而且結果中沒有兩個名稱的 `ingredient_key` 相同。

**Validates: Requirements 25.4, 25.5**

### Property 18: 頭像的字是修剪後顯示名稱的第一個字素叢集

*For any* `arb_display_name()` 產生的顯示名稱 n，令 t = `trim_white(n)`：t 為空時，`avatar_initial(n)` 是 `Placeholder`；否則 `avatar_initial(n)` 是 `Grapheme(g)`，g 恰好是 t 的第一個擴充字素叢集。也就是說：g 是 t 的非空前綴；g 本身只有一個字素叢集；t 去掉 g 之後剩下的部分不會再與 g 合成同一個叢集（emoji 序列、國旗、膚色修飾與組合字元不會被切開）。由已知叢集組成的名稱，結果等於第一個被選的叢集。

**Validates: Requirements 16.4, 16.5, 16.18**

### Property 19: 頭像顏色由帳號 id 決定，文字對比至少 4.5:1

*For any* `arb_user_id()` 產生的帳號 id u：`avatar_color(u)` 是 `AVATAR_PALETTE` 中的一色；重複呼叫，或以 `u` 的 16 個位元組重建 `UserId` 後再呼叫，結果都相同；文字色與底色的對比 `contrast_ratio(text, background) ≥ 4.5`，而且 `text == readable_text_on(background)`。不同的 u 可能得到相同的顏色（色盤只有 12 色），所以辨識靠頭像上的字與無障礙名稱，顏色只是輔助。

另以 golden 測試鎖定幾個固定 id 的色盤索引：日後若改動雜湊或色盤順序，每個人的顏色都會改變，這個測試會擋下這種改動。

**Validates: Requirements 16.6, 16.7, 16.18**

## Error Handling

| 情境 | 偵測 | 處理 | 使用者看到 |
|---|---|---|---|
| 命令被拒絕（400、403、404、409） | `apply()` 回傳 `Rejection` | 伺服器不寫入；前端移除該 pending、不重送，畫面等於 Replica 疊上其餘的 pending（B8、需求 13.8） | toast 顯示原因，例如「只能變更自己的行前準備。」 |
| 命令要刪除的列已不存在 | 處理函式找不到目標 | 沒有變化：不寫入、不推送、不使用新的 seq，也沒有連帶效果；前端只移除 pending（需求 7.12） | 無 |
| 命令要修改或勾選的列已不存在 | 處理函式找不到目標 | 404 與該種項目的訊息，不重新建立（需求 7.21） | toast，例如「找不到這個採買品項。」 |
| 最後的不變式檢查失敗 | `validate::state()` | 拒絕整個命令；有對應規則時回應那條規則，否則 409（需求 9.16） | 例如「資料驗證未通過，沒有儲存。」 |
| 網路錯誤、15 秒逾時、5xx | `fetch` 失敗、逾時或狀態碼 | 保留預測；在前一次失敗後 1、2、4、8、16 秒重送同一個 `command_id`；伺服器以 `trip_changes.command_id` 去重；第 5 次重送也失敗時移除 pending；離線時暫停，恢復上線立即重送並重新計數（需求 13.9–13.12） | 「儲存失敗，正在重試」；放棄時「儲存失敗，變更已還原」；離線時改為「離線中，有 N 項變更尚未送出」 |
| 回應遺失但伺服器已提交 | 重送時 `changeset_by_command()` 找到（先確認是成員） | 回傳原本的變更集（`replayed`；Unbound_Admin 不含 Ledger_Rows）；如果推送或補齊先帶來這個 Change_Set，前端已先確認並取消重送（需求 13.13） | 無 |
| API 回 401（access token 過期或被撤銷） | 狀態碼 | 換發一次後重試；換發失敗則前往 `/login?next=…` | 「登入已失效，請重新登入；尚有 N 項變更未送出」 |
| 請求的路徑或方法不存在、格式不正確 | `/api` 的 fallback、擷取器的拒絕 | 404 `api_not_found`、405 `method_not_allowed`、400 `invalid_request`；不回傳 `index.html`（需求 5.9） | 錯誤訊息 |
| Database 或 Auth_Service 無法使用、未預期的錯誤 | `sqlx` 或 HTTP 錯誤 | 500 `internal_error`，記錄錯誤（不含 token 與密碼）；不回應 401（需求 5.10） | 「伺服器暫時無法處理，請稍後再試。」 |
| 登入或換發時 Auth_Service 無法連線、10 秒逾時、5xx 或限流 | `AuthError::Upstream`、`RateLimited` | 503（限流為 429），不回應 401；換發失敗時前端保留 Session 與 pending，之後再試（需求 4.13、4.15） | 「暫時無法登入，請稍後再試。」 |
| 加入頻道時 `InvalidJWTExpiration` | `phx_reply` 的 reason | 換發 token 後立即重新加入；換發後仍回報過期時依退避重試（需求 11.8） | 無 |
| 連線中 token 過期（`system`：Token has expired） | `system` 事件後 `phx_close` | 換發、立即重新加入、補齊（需求 11.9） | 短暫顯示「重新連線中」 |
| 頻道授權失敗（`Unauthorized`） | `phx_reply` 的 reason | 不重試，離開旅行頁，前往 Home_Page（需求 11.10） | 「你已無法存取這趟旅行。」 |
| 加入頻道的其他錯誤，或 10 秒內沒有回覆 | `phx_reply` 的 reason、`JoinTimeout` | 依 1、2、5、10 秒（含抖動）重試，不離開旅行頁（需求 11.7） | 「重新連線中，畫面可能不是最新」 |
| WebSocket 斷線、`phx_error`、`phx_close`、heartbeat 20 秒內沒有回覆 | 傳輸事件或計時 | 依 1、2、5、10 秒（含抖動）重連；重新加入後以 `changes?after=` 補齊（B7） | 「重新連線中，畫面可能不是最新」 |
| 補齊的請求回應 404 | 讀取 Snapshot、Change_Set 或 Head 的回應 | 停止補齊，離開 Trip_Channel 與目前的頁面，前往 Home_Page（需求 12.16） | 「找不到這趟旅行。」 |
| 補齊的請求網路錯誤、逾時或 5xx | 讀取失敗 | Replica 與 Watermark 不變；下一次跳號、Thin_Notice、Head 比對或重新加入時再補齊；還沒有 Replica 時直接重讀 Snapshot（需求 12.17） | 無（重新連線中時仍顯示那個提示） |
| 推送遺失（seq 跳號） | `ApplyReport.gap` | 立即 `changes?after=水位線` | 無 |
| 推送遺失而且之後沒有新提交 | 前景、`online`、每 60 秒比對 `head` | 落後就補齊 | 無 |
| 變更集太大（thin 通知） | `Broadcast::Thin` | `changes?after=水位線` | 無 |
| 落後超過 500 個 seq | `snapshot_required` | 改抓快照 | 無 |
| 旅行被刪除 | 變更集 `trip_deleted` | 離開頁面，回到旅行列表 | 「這趟旅行已被刪除。」 |
| 沒有任何連線者時提交（`realtime.messages` 沒有當天的 partition） | Postgres 記錄 `WarnSendingBroadcastMessage` | 提交照常成功；之後連線的人以補齊取得 | 無 |
| 提交時外鍵或 CHECK 失敗 | `COMMIT` 錯誤 | 回 500、整個回滾、記錄 `tracing::error!`；這代表 `lm-core` 的驗證有漏洞 | 「儲存失敗，變更已還原」 |
| 註冊時 GoTrue 已建立帳號、但 profile 或加入旅行失敗 | 交易錯誤 | 交易回滾；以 admin API 刪除剛建立的 GoTrue 帳號（失敗時記錄使用者 id），回傳原本的錯誤（需求 3.10） | 錯誤原因，例如「邀請連結無效或已過期。」；Database 錯誤時「註冊暫時無法使用，請聯絡管理員。」 |
| 註冊已提交，但以密碼取得 Session 失敗 | `password_grant` 失敗 | 保留 Account 與加入旅行的結果，回 503（需求 3.16） | 「帳號已建立，但暫時無法登入，請稍後到登入頁登入。」 |
| 帳號名稱已被使用 | GoTrue 回傳 email 已存在 | 409 | 「這個帳號名稱已被使用。」 |
| GoTrue 拒收合成 email 的網域 | GoTrue 的 `email_address_invalid` | 回 500，並記錄設定錯誤（`LM_AUTH_EMAIL_DOMAIN`） | 「註冊暫時無法使用，請聯絡管理員。」 |
| Presence 超過速率限制 | `system`：Client presence rate limit exceeded，接著 `phx_close` | 依退避重新加入，不停止重試、不離開旅行頁；重新加入後補齊並重送 Presence_Meta（需求 15.13）；節流器的最小間隔保證不會反覆發生 | 只有「重新連線中，畫面可能不是最新」 |
| 收到格式不對的 presence 內容 | 無法解析成 `PresenceMeta` | 忽略這一筆；顯示名稱超過 30 個字元時截斷，修剪後是空的就顯示中性符號「・」 | 無 |
| 正在編輯的列被別人改了 | 列的 signal 改變，但表單有草稿 | 草稿不被覆蓋；表單上方以 `role="status"` 顯示「小雨剛更新了這一項」（旅伴名稱，見 4.5 的名稱分工；找不到時「有人剛更新了這一項」）；儲存時只送出自己改過的欄位（需求 14.6–14.8） | 提示 |
| 正在編輯的每日設定被別人清除，而那一天仍在旅行範圍內 | 每日設定的列從 `RowStore` 移除 | 不算刪除：表單保持開啟、草稿不變，依上一列顯示「…剛更新了這一項」（需求 14.9、22.11） | 提示 |
| 正在編輯的列被別人刪了，或正在編輯的每日設定那一天已不在旅行範圍內 | 列從 `RowStore` 移除，或旅行日期改變 | 直接關閉表單並捨棄草稿（不詢問），Presence 回報沒有正在編輯的對象（需求 14.9） | toast「這個項目已被刪除。」 |
| 啟動時環境變數未設定或格式不符 | `Config::from_env()` | 列出每個變數名稱與原因（不含金鑰與密碼的值），程序以非 0 結束（需求 2.11） | 終端機訊息 |
| 啟動時綁定非 loopback 位址又使用範例金鑰 | `refuse_sample_secrets_off_loopback()` | 程序結束（B12、需求 2.6） | 終端機訊息說明原因 |
| 啟動時 30 秒內連不上 Database，或無法在 `LM_BIND` 監聽 | 連線重試逾時、`bind()` 錯誤 | 印出主機與埠（不含密碼）或監聽位址與原因，程序以非 0 結束（需求 2.12） | 終端機訊息 |

## Testing Strategy

依使用者指示，第一版只為核心規則寫測試；不建立 Playwright、Lighthouse、資安測試套件或資料庫整合測試。

### `lm-core` 的單元測試（golden）

把現行 `tests/*.test.js` 中與移植規則相關的案例改寫成 Rust 的範例測試，確保行為與 Bun 版一致：

| 現行測試 | 主要涵蓋的規則 | 移植到 |
|---|---|---|
| `tests/ingredients.test.js` | 食材切分與分類、Shopping_Sync、從料理移除食材 | `parse_ingredients`、`classify_ingredient`、`sync_meal_ingredients`、`remove_ingredient_from_meals` |
| `tests/meal-order.test.js`、`tests/recipes-invites.test.js` | 餐次排序、料理範本、插圖種類推斷、合併食材，以及 Participant_Name 的正規化、同名與上限 | 餐次排序、`RECIPE_TEMPLATES`、`infer_dish_kind`、`merge_ingredients`、`participant_name`、`participant_key`、旅伴的同名與 100 位上限 |
| `tests/itinerary-model.test.js`、`tests/itinerary-place-name.test.js`、`tests/itinerary-time-input.test.js`、`tests/itinerary-numerals.test.js` | 活動類別與 Activity_Preset、料理的用餐時間與標題、Hidden_Control_Char、地點名稱規則、Place_Key 與旅行目的地的衝突、Time_Value 的輸入、中文數字與日期文字 | `ACTIVITY_CATEGORIES`、`presets_for`、`meal_time`、`meal_title`、`has_control_chars`、`place_key`、地點名稱規則、`destination_conflict`、`normalize_time_input`、`chinese_numeral`、`date_text` |
| `tests/itinerary-shopping.test.js`、`tests/itinerary-derive.test.js` | Shopping_Plan | `shopping_plan` |
| `tests/itinerary-dates.test.js` 中 `retimeByDayIndex()` 與 `shortenBlockedMessage()` 的案例 | Retime | `retime_by_day_index`、`shorten_blocked_message` |
| `tests/expense-model.test.js`、`tests/ledger.test.js` 的計算部分 | 分帳計算 | `parse_amount`、`format_money`、`split_evenly`、`summarize`、`suggest_expense_category` |
| `tests/model.test.js` | My_Gear、Can_Depart、打包進度、日期範圍與 Trip_State 的驗證 | `my_gear`、`can_depart`、`progress`、`date_range`、`validate::state` |

移植的規則（需求 33.1）：表格式案例的每一組輸入各算一個案例；隨機產生輸入的屬性測試不在此列。每個測試使用與原案例相同的輸入（現行的陣列順序改以 ordinal 表示），預期值與原案例相同、直接寫在測試中，並以註解標明來源的測試檔與測試名稱。斷言第一版沒有的功能（例如 localStorage 的保存、HTML 跳脫、SVG 與行程繪本的插圖、規劃提醒、舊的餐次名稱、車輛的舊出發欄位 `meeting`），或斷言「與現行行為的差異」表中已改變之行為的案例不移植，並在對應的 Rust 測試檔以註解列出這些案例的名稱與原因。

**文字版的 golden 測試**（需求 33.2）：以移植自 `tests/fixtures/example-trip.js` 的 `exampleTrip()` 資料（陣列順序改以 ordinal 表示）產生 Itinerary_Text，要求它與提交在 Repository 的 `crates/core/tests/fixtures/example-itinerary.txt` 逐字相同（每個字元與換行都相同，最後一行之後沒有換行字元）。這個預期文字檔依需求 31 撰寫，不使用同一個 fixture 檔中的 `EXAMPLE_TEXT`：`EXAMPLE_TEXT` 是 trip-planning-workflow-enhance 舊文字產生器的格式，現行 App 已不顯示。預期文字等於現行行程繪本「複製文字」對同一份資料複製的文字，只多了一行：第 1 天由規劃者填寫的預計抵達時間 12:00 產生的「預計 12:00 抵達夕淞度日營區」，是那一天路線區塊的最後一行；範例的活動與料理都沒有備註，所以沒有備註行。

**文字版的其他範例測試**（需求 33.11）：範例旅行沒有用到的規則另以小型旅行測試，每個案例都比對完整輸出，預期文字依需求 31.2–31.14 與 31.18 撰寫：

- 沒有車輛（「車輛：尚未安排」）。
- 沒有當日標題（「未命名的一天」）、沒有 Day_Place（「地點：未指定」），以及以地點清單中的地點為 Day_Place 的一天。
- 沒有路線、活動與料理的一天（「活動」之後只有「無安排」）。
- 同一天有多條路線，而建立順序與出發時間的順序不同；出發時間留空的路線（「出發時間未填」）。
- 四種種類的停靠點：指定任務與沒有指定任務（預設任務）、時間留空（「・時間未填」），以及備註有填與留空。
- 同時有採買品項與備註的 Shopping_Stop（以「；」連接）、同一台車的第二個 Shopping_Stop（沒有採買品項），以及恰好 8 項與 9 項採買品項（9 項時為前 7 項加「、等另外 2 項」）。
- 有預計抵達時間但沒有路線的一天（路線區塊只有抵達行），以及沒有 Day_Place 時的抵達行（「預計 {HH:MM} 抵達」）。
- 同一時間的活動與料理（活動在前，再各依建立順序）、已完成的活動，以及料理名稱是空的或與餐次相同。
- 料理類別的每一種情況：插圖種類為 hotpot、bbq、breakfast 與 toast，以及其他插圖種類時餐次為早餐、午餐與其他餐次。
- 有備註的活動與料理（備註行），以及只有空白的備註（沒有備註行）。
- 路線位置為「路線在活動之後」的一天（活動區塊在前，路線區塊與抵達行在後）。
- 未分配採買清單：列出已買與未買的待分配品項，不列出負責人不在任何車上或負責人的車沒有 Shopping_Stop 的品項；沒有待分配品項時沒有這個區塊。
- 含換行與前後空白的使用者文字，以及不含換行的連續空白保留原樣。

**JavaScript 與 Rust 字元規則不同之處**（需求 33.10）：預期值是 Bun_App 對同一輸入的結果。Ingredient_Parser 從 U+FEFF 加「雞蛋」切出「雞蛋」；從「雞」加 U+FEFF 加「蛋」切出「雞 蛋」，它的 Ingredient_Key 是「雞蛋」；從 U+0085 加「雞蛋」切出的名稱仍以 U+0085 開頭。Participant_Name 把「小」加 U+FEFF 加「安」正規化為「小 安」；新增名字為「小」加 U+0085 加「安」的旅伴時，以「名字不能包含隱藏控制字元。」拒絕。Ingredient_Classifier 把「鹽」加 U+0663 分類為「其他」。

**權限拒絕**（需求 33.12）：拒絕的種類與訊息與 Permission_Table 相同：不是 Trip_Member 也不是 Admin 的 Account 送出任一種命令時為 404「找不到這趟旅行。」；Collaborator 移除旅伴，或刪除車輛、料理、採買品項或裝備時為 403「受邀旅伴可以編輯，但不能刪除既有項目；請聯絡主辦人或管理員。」；Trip_Manager 或 Collaborator 變更其他旅伴的打包或出發確認時為 403「只能變更自己的行前準備。」；Collaborator 修改綁定其他 Account 的旅伴時為 403「只能修改自己的旅伴資料。」；Collaborator 刪除支出或還款時為 403「受邀旅伴可以新增或修改帳目，但不能刪除既有帳目；請聯絡主辦人或管理員。」；Unbound_Admin 新增、修改或刪除支出或還款時為 404「找不到這趟旅行。」。

編輯者頭像是新功能，沒有可移植的現行測試，另寫下列範例測試（`crates/core/tests/presence_avatar.rs`，需求 33.3、33.4）：

- `avatar_initial`：「陳小明」→「陳」、「  amy chen 」→「a」、「🐻小熊」→「🐻」、「👨‍👩‍👧 一家」→「👨‍👩‍👧」、「🇹🇼台灣」→「🇹🇼」、`"e\u{301}va"` → `"e\u{301}"`；空字串、只有全形空白 U+3000、只有 tab 與換行 → `Placeholder`（「・」）。
- 色盤：12 色逐一以 WCAG 2.x 的公式重算對比，全部 ≥ 4.5:1，而且 `text == readable_text_on(background)`。FNV-1a 64 位元以公開的測試向量驗證（空輸入為 `0xcbf29ce484222325`，ASCII「a」為 `0xaf63dc4c8601ec8c`）。golden：至少 3 個固定帳號 id 的色盤索引，包括 16 個位元組全為 0 與全為 255 的 id，預期索引以常數寫在測試中。
- `editor_stacks`：0 位編輯者時結果中沒有這個對象；1 位與 3 位時全部顯示、沒有「+N」；4 位時顯示帳號 id 最小的 3 位與「+1」；10 位時顯示最小的 3 位與「+7」；同一帳號兩個分頁編輯同一個對象只算一位；自己（包括自己的其他分頁與裝置）不算；以帳號 id 遞減的順序提供 Presence_Meta 時，結果仍依帳號 id 遞增。
- 文字：`label()` 為「陳小明 正在編輯」、`tooltip()` 為「陳小明」，顯示名稱是空的時為「有人 正在編輯」與「未設定顯示名稱」；其餘兩位依序為林大華、王小美時，`overflow_label()` 為「另外 2 人正在編輯：林大華、王小美」；`notice()` 只有陳小明時為「陳小明 正在編輯這一項」，陳小明排第一位、共 4 人時為「陳小明 等 4 人正在編輯這一項」；空的顯示名稱在「+N」的名稱與 `notice()` 中以「有人」代替，在 `overflow_tooltip()` 中以「未設定顯示名稱」代替；顯示名稱前後有空白或超過 30 個字元時，這些文字使用 Trim_White 之後的前 30 個字元。

### `lm-core` 的屬性測試

- 以 `proptest` 為 Property 1–19 各實作至少一個測試；每個屬性預設 256 個案例，設定環境變數 `PROPTEST_CASES=N` 時改為 N 個案例（需求 33.5）。
- 每個屬性測試上方加註 `// Feature: rust-supabase-rewrite, Property N: <標題>`。
- proptest 失敗時產生的 `proptest-regressions/` 檔案提交進版本庫，之後每次都會重跑。
- 產生器與 `ModelServer` 放在 `crates/core/tests/support/`，只在測試中編譯。

### `lm-supabase` 的少量單元測試

不連網路：以記錄送出內容的假 `RealtimeTransport`、測試指定的時間與抖動執行，不等待實際時間（需求 33.7）：

- (a) 加入 Trip_Channel 的訊息指定私有頻道 `trip:<旅行 id>`，帶這個分頁的 presence key 與目前的 access token。
- (b) 以 Supabase Realtime 協定文件的範例訊框為輸入，把加入成功、加入失敗（保留失敗原因）、broadcast、presence 的完整狀態、presence 的增減、頻道關閉、頻道錯誤、系統通知與 heartbeat 的回覆各解碼成對應的 `Inbound`；不認得的事件解碼為 `Other`，無法解析的文字回傳錯誤。
- (c) WebSocket 連上後（包括重新連線之後），對每個要加入的頻道各送出一次 `phx_join`。
- (d) 連上後未滿 20 秒不送出 heartbeat，滿 20 秒時送出，之後每 20 秒一次。
- (e) 送出 heartbeat 後滿 20 秒仍沒有收到它的回覆時，關閉連線並開始退避。
- (f) 斷線後第 1 至第 4 次重新連線前的等待分別不少於 1、2、5、10 秒，也不超過這些秒數的 1.2 倍；第 5 次起都在 10 至 12 秒之間；連上之後再斷線時從 1 秒重新開始。
- (g) 換發 Session 時，對每個已加入的頻道各送出一則帶新 access token 的訊息，之後的 `phx_join` 也帶新的 access token。

### 其他

- `cargo test`、`cargo clippy --workspace -- -D warnings`、`cargo fmt --check` 與 `trunk build --release` 作為本機的建置檢查，結束碼都要是 0；`cargo test` 不連網路、Database 或 Realtime，也不執行 Bun 版（需求 33.8）。
- `lm-server` 與 `lm-web` 在第一版不寫自動化測試。README 列出下列手動確認步驟與預期結果（需求 33.9）：
  1. 兩個瀏覽器視窗開啟同一趟旅行，一邊把一個採買品項勾選為已買，另一邊在 2 秒內顯示這個品項已買。
  2. 一邊在開發者工具切換為離線；離線期間兩邊各把一個不同的採買品項勾選為已買；恢復上線後 15 秒內，兩邊都顯示這兩個品項已買。
  3. 以兩個不同的 Account 開啟同一趟旅行，一邊開啟某張卡片的表單，另一邊在 7 秒內於那張卡片上看到對方的 Editor_Avatar（節流的最小間隔是 6.5 秒）；關閉表單後 7 秒內頭像消失。

## Performance Considerations

| 項目 | 預估 | 說明 |
|---|---|---|
| 一個命令在伺服器的時間 | 約 10–30 毫秒 | 讀取約 14 個查詢（本機每個不到 1 毫秒）、`apply()` 與同步（微秒到毫秒）、寫入與提交 |
| 從提交到其他成員看到 | 一般在 1 秒內 | Realtime 讀 WAL 並推送；區網內往返數毫秒；前端合併與重繪數毫秒。目標 2 秒（B1） |
| 旅行列鎖的等待 | 只在同一趟旅行內 | 每個命令持有數十毫秒；一趟旅行同時操作的人數很少 |
| 快照大小 | 一般 30–100 KB | 例：6 位旅伴、3 台車、30 個活動、10 道料理、80 個採買品項、40 個裝備、20 筆支出；上限資料量時約 1–2 MB（很少見） |
| 推送大小 | 一般數 KB | 超過 64 KB 改送 thin 通知；Supabase 平台的 broadcast 上限為 256 KB 起，自架版依設定 |
| 前端重繪 | 只有變更的列 | `RowStore` 的列 signal 與 `<For>` 的鍵；文字版與餘額整塊重算 |
| `overlay()` 與 `refresh_view()` | 毫秒以下 | 複製與比較數千列；pending 通常是 0–3 個 |
| WebAssembly 大小 | 數百 KB（壓縮後） | `opt-level = "z"`、LTO、trunk 的 wasm-opt；字型（約 2.3 MB 的 woff2 子集）仍是首次載入的大宗，沿用現有的 `unicode-range` 分割 |
| Presence | 每個用戶端最多每 6.5 秒一次 | 在 Realtime 每 30 秒 5 次的限制內；`editor_stacks()` 只走訪在線的 meta（每趟旅行通常不到 10 筆），頭像只在該對象的堆疊改變時更新那張卡片或那一列 |

## Security Considerations

資安強化是另一個工作流，第一版不處理。下列幾點不需要額外成本，或是功能本身就需要，因此放在第一版：

- 本機 Supabase 只綁 127.0.0.1（Docker 網路的 `host_binding_ipv4`）；`lm-server` 與 `trunk serve` 預設也只綁 127.0.0.1（B12）。這些埠在 WSL 2 中只經 localhost 轉送給同一台電腦的 Windows，區網連不到（「本機開發」）。
- `lm-server` 在非 loopback 位址上偵測到 CLI 的範例 JWT 密鑰或金鑰時拒絕啟動；要讓其他機器連入，必須改用以 `generate-keys.sh` 產生新密鑰的自架堆疊（B12）。
- service key 只存在 `lm-server` 的環境變數；瀏覽器只拿到使用者自己的 JWT；Realtime 的 `apikey` 由 `lm-server` 轉送時補上。
- 旅行資料只透過 `lm-server` 的命令與快照存取；`app` schema 不在 PostgREST 的 `api.schemas` 中，全部啟用 RLS 且不授權給 `anon`、`authenticated`（B6）。
- Realtime 頻道以 RLS 限制成員；客戶端沒有送 broadcast 的權限，變更集只能由資料庫發出（B6）。
- 邀請 token 只保存 SHA-256；API 使用 Bearer token、不使用 cookie，所以沒有 CSRF 問題。
- Presence 的內容（顯示名稱、編輯對象）由用戶端自行回報，Realtime 只檢查是不是成員，不檢查內容；成員可以假冒別人的顯示名稱。頭像與「正在編輯」因此只是提示，不影響權限與資料。顯示名稱一律以文字節點或屬性輸出（Leptos 會跳脫），超過 30 個字元就截斷。

明確延後到資安工作流的項目：速率限制（GoTrue 內建的之外）、登入異常警示與安全事件、CSP 與安全標頭、token 存在 localStorage 時的 XSS 風險、HTTPS 與反向代理、Allowed_Hosts、信任的代理、`lm-server` 改用最低權限的資料庫角色（開發時以 `postgres` 連線）、縮短 JWT 有效時間、Realtime 只允許私有頻道的租戶設定、移除 PostgREST、秘密掃描與 DAST。

## Dependencies

| 類別 | 項目 | 用途 |
|---|---|---|
| 工具 | Rust stable、`wasm32-unknown-unknown`、rustfmt、clippy（`rust-toolchain.toml`） | 編譯 |
| 工具 | trunk | 建置與開發伺服器（`lm-web`） |
| 工具 | WSL 2 的 Ubuntu 套件：`build-essential`、`pkg-config`、`libssl-dev` | 編譯原生相依套件的 C 工具鏈；native-tls 在 Linux 使用 OpenSSL，openssl-sys 以 pkg-config 找到 `libssl-dev` |
| 工具 | Supabase CLI 3.2.0 的 Linux 版、Docker Engine（都安裝在 WSL 2 的 Ubuntu 中，不使用 Docker Desktop） | 本機 Supabase 堆疊與遷移 |
| 工具 | Bun（Windows 上已有） | 只用於一次性的 `scripts/export-art.mjs` |
| `lm-core` | serde、serde_json、serde_with、uuid（v4、serde，wasm 加 `js`）、chrono（不含 clock）、unicode-normalization、unicode-segmentation（頭像的字）、regex、indexmap、thiserror；dev：proptest | 型別與規則 |
| `lm-supabase` | serde_json；feature `server`：reqwest、jsonwebtoken、tokio、async-trait；feature `web`：wasm-bindgen、web-sys（WebSocket、MessageEvent、CloseEvent）、gloo-timers | 用戶端 |
| `lm-server` | axum 0.8（ws）、tokio、tower-http（fs、trace）、sqlx 0.8（postgres、runtime-tokio、uuid、chrono、json）、tokio-tungstenite、futures-util、sha2、rand、hex、tracing、tracing-subscriber、dotenvy | 服務 |
| `lm-web` | leptos 0.8（csr）、leptos_router 0.8、wasm-bindgen、web-sys、js-sys、gloo-net、gloo-timers、gloo-storage、uuid（js） | 前端 |
| 服務 | Supabase：PostgreSQL、Auth、Realtime、API gateway；Studio 與 postgres-meta（開發用） | 平台 |
| 設定 | `.cargo/config.toml` 為 wasm32 加上 `--cfg getrandom_backend="wasm_js"`（getrandom 0.3 的瀏覽器後端） | 產生 UUID |
| 設定 | 伺服器端的 TLS 使用 native-tls（reqwest、sqlx 與 tokio-tungstenite 的 native-tls feature）；native-tls 在 Linux 使用 OpenSSL，所以在 WSL 中建置之前要安裝 `pkg-config` 與 `libssl-dev` | 連到 `https://` 與 `wss://` 的 Supabase_Stack，以及依 `DATABASE_URL` 的 `sslmode` 以 TLS 連到 Database |

版本在建立 workspace 時鎖在 `Cargo.lock`；Supabase 各服務的映像版本由使用的 CLI 版本（固定為 3.2.0）決定，README 記錄 `supabase --version`。

## 風險與緩解

| 編號 | 風險 | 影響 | 緩解 |
|---|---|---|---|
| R1 | 沒有官方 Rust 用戶端；自寫的 Realtime 協定實作可能跟不上改版 | 連線或授權失敗 | 協定集中在 `lm-supabase::realtime::protocol`，以文件範例做單元測試；`RealtimeTransport`、`AuthBackend` 兩個 trait 讓之後可以換成成熟的 crate |
| R2 | 自架或 CLI 的 Realtime 版本不支援 Broadcast from Database、私有頻道授權或 presence 的某些行為 | 推送或 presence 無法使用 | 第一個實作任務先以兩個瀏覽器確認 `realtime.send()` 與 RLS 政策可運作；鎖定 CLI 版本 |
| R3 | GoTrue 拒收合成 email 的網域（GoTrue 有網域格式檢查，例如 [supabase/auth #2252](https://github.com/supabase/auth/issues/2252) 回報 `a@a.com` 被拒） | 無法註冊 | `LM_AUTH_EMAIL_DOMAIN` 可設定；第一個實作任務先實測；最後的備選是 email 登入，但使用者已確認沿用帳號名稱登入（已確認 1），所以只有在找不到可用的網域時才回頭討論 |
| R4 | Presence 每 30 秒 5 次的限制 | 「誰正在編輯」與頭像延遲數秒；超過時頻道被關閉 | 卡片或列層級的目標、6.5 秒最小間隔（屬性 14） |
| R5 | Leptos 0.8 的 API 仍在演進 | 升級時要改程式 | 鎖定版本；畫面元件與同步引擎分開，引擎不依賴 Leptos 以外的反應式細節 |
| R6 | 重用現有 CSS 要求 DOM 結構相同 | 版面跑掉 | 元件照抄現行模板的結構與 class；逐頁以眼睛比對 Bun 版 |
| R7 | NFKC、空白與小寫的細節和 JavaScript 不完全相同 | 採買同步結果與舊版不同 | golden 測試移植自現行測試；Property 17 |
| R8 | WSL 2 中 Docker Engine 的埠綁定，以及 Windows 的保留埠（WSL 轉送的埠也綁在 Windows 上） | 無法啟動、Windows 的瀏覽器連不到，或意外開放到區網 | 文件化 `docker network create` 與 `netsh` 檢查；以 `docker ps` 確認 127.0.0.1；綁在 127.0.0.1 的埠只經 WSL 的 localhost 轉送給 Windows，區網連不到 |
| R9 | broadcast 最多送達一次，且沒有連線者時會被丟棄 | 畫面暫時不是最新 | 水位線、跳號偵測、`head` 比對與重連後補齊（B7）；正確性不依賴推送 |
| R10 | JWT 在登出或失去權限後仍有效到過期（預設 1 小時） | 撤銷延遲 | 第一版接受；資安工作流再縮短有效時間 |
| R11 | 每個命令重讀整趟旅行 | 大旅行時延遲增加 | 預估仍在數十毫秒；必要時加入以 `(trip, seq)` 為鍵的快取 |
| R12 | 一次性的插畫輸出依賴現有 JavaScript | 之後改插畫要重新輸出 | 輸出結果提交進版本庫；之後若要改插畫，再決定是否把產生器移植成 Rust |
| R13 | 頭像的字是 emoji，或是內建字型沒有的罕用字 | 同一個人的頭像在不同裝置上字形略有不同（改用系統字型） | 字（同一個字素叢集）與顏色在每台裝置都相同，只有字形依系統字型而異；第一版接受 |
| R14 | Repository 在 Windows 的磁碟（WSL 中的 `/mnt/d`），工具在 WSL 中執行 | 建置變慢；在 Windows 修改的檔案不會觸發 WSL 中的檔案監看，`trunk serve` 不自動重建；在 WSL 中執行 git 會因為行尾的設定不同而把檔案看成已修改 | `CARGO_TARGET_DIR` 指向 Linux 檔案系統；`trunk serve --poll`；git 只在 Windows 的 PowerShell 執行（「本機開發」） |

## 擴充點（之後的功能）

- **行程圖（動畫海報）**：讀同一份 `TripState`，以 `lm-core::itinerary` 的推導產生畫面；即時更新不需額外工作。
- **匯出與匯入**：快照的 JSON 就是完整的匯出格式；匯入以一連串命令（或一個專用命令）寫回，衍生資料仍由伺服器計算。
- **小隊最近的動態**：由 `app.trip_changes` 的 `actor` 與變更內容產生。
- **從現行資料庫搬資料**：以 Rust 的一次性工具讀取 `trips.state_json` 與 `trip_ledgers.ledger_json`，轉成命令或直接寫入列。
- **離線本機版**：`Replica` 與 pending 佇列存進 IndexedDB 即可離線使用，連線後補送命令。
- **旅行列表即時更新**：新增每位使用者一個 `user:<uuid>` 私有頻道，推送旅行卡片與成員變化。
- **收據 AI、管理後台、註冊政策畫面**：都是 `lm-server` 的新端點，不影響同步模型。

## 參考資料

設計中關於 Supabase 與工具的事實，查證自下列來源（引用內容皆已改寫摘要；Content was rephrased for compliance with licensing restrictions）：

| 主題 | 來源 |
|---|---|
| 官方用戶端只有 JS/TS、Dart、Swift、Python、C# | [Supabase：Client Libraries](https://supabase.com/docs/guides/api/rest/client-libs) |
| Realtime 的 Postgres Changes、Broadcast、Presence | [supabase/realtime（Docker Hub）](https://hub.docker.com/r/supabase/realtime) |
| `realtime.send()`、`realtime.broadcast_changes()`、私有與公開頻道必須一致、訊息保存 3 天、Broadcast replay 的限制 | [Supabase：Broadcast](https://supabase.com/docs/guides/realtime/broadcast) |
| `realtime.messages` 的 RLS 政策、`realtime.topic()`、`extension` 欄位、權限在加入與換發 token 時計算並快取、不要對 `realtime.messages` 下 `ENABLE ROW LEVEL SECURITY` | [Supabase：Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization) |
| 協定 1.0.0 的訊框、`phx_join` 設定、heartbeat 至少每 25 秒、`access_token`、presence track、錯誤碼與重連間隔 | [Supabase：Realtime Protocol](https://supabase.com/docs/guides/realtime/protocol) |
| Postgres Changes 對每位訂閱者授權、單執行緒、RLS 不套用到 DELETE | [Supabase：Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes) |
| 沒有連線者或沒有 partition 時 `realtime.send()` 只記錄警告 | [Supabase KB：WarnSendingBroadcastMessage](https://supabase.com/kb/troubleshooting/realtime-warn-sending-broadcast-message) |
| 每用戶端每 30 秒 5 次 presence、broadcast payload 上限 | [Supabase：Realtime Limits](https://supabase.com/docs/guides/realtime/limits) |
| 自架的服務組成、可移除的服務、`generate-keys.sh`、預設以 Envoy 為 API gateway | [Supabase：Self-Hosting with Docker](https://supabase.com/docs/guides/self-hosting/docker) |
| 自架的 HS256 與 ES256、JWKS 端點 | [Supabase：New API Keys and Asymmetric Authentication](https://supabase.com/docs/guides/self-hosting/self-hosted-auth-keys) |
| CLI 只綁 127.0.0.1 的 Docker 網路、CLI 堆疊不可對外 | [Supabase：Local Development & CLI](https://supabase.com/docs/guides/resources/supabase-cli/local-development) |
| CLI `config.toml` 的服務開關與埠 | [Supabase：CLI configuration](https://supabase.com/docs/guides/local-development/cli/config) |
| Windows 保留埠造成 CLI 無法綁定 | [supabase/cli #4128](https://github.com/supabase/cli/issues/4128) |
| WSL 2 預設的 NAT 模式：Windows 以 localhost 連到 WSL 中的服務，區網要另外設定 port proxy 才能連入 | [Microsoft：Accessing network applications with WSL](https://learn.microsoft.com/en-us/windows/wsl/networking) |
| 專案檔放在 `/mnt/` 之下時 WSL 中的讀寫較慢 | [Microsoft：Working across file systems](https://learn.microsoft.com/en-us/windows/wsl/filesystems) |
| `trunk serve` 與 `trunk watch` 的 `--poll`（預設每 5 秒） | [trunk-rs/trunk：src/cmd/watch.rs](https://github.com/trunk-rs/trunk/blob/main/src/cmd/watch.rs) |
| GoTrue 的密碼 72 字元上限 | [Supabase Discussion #34207](https://github.com/orgs/supabase/discussions/34207) |
| GoTrue 的 email 網域格式檢查 | [supabase/auth #2252](https://github.com/supabase/auth/issues/2252) |
| Leptos + Supabase 的 CSR 範例（以 REST 呼叫 GoTrue） | [leptos-community/csr-example-leptos-supabase](https://github.com/leptos-community/csr-example-leptos-supabase) |
| 社群 Realtime crate 的實作方式與成熟度 | [scaraude/supabase-realtime-rs](https://github.com/scaraude/supabase-realtime-rs) |
| trunk 的 `[[proxy]]` 與 `ws = true`、`serve.addresses` 預設 127.0.0.1 | [trunk 的 Trunk.toml 範例](https://github.com/trunk-rs/trunk/blob/main/Trunk.toml) |
| Leptos 0.8 的 `<For>` 與 stores | [leptos-rs/leptos v0.8.14](https://github.com/leptos-rs/leptos/tree/v0.8.14) |
| `graphemes(true)` 回傳擴充字素叢集；組合字元與國旗留在同一個叢集 | [unicode-segmentation：UnicodeSegmentation](https://docs.rs/unicode-segmentation/latest/unicode_segmentation/trait.UnicodeSegmentation.html) |
| 擴充字素叢集的切分規則 | [Unicode：UAX #29 Text Segmentation](https://www.unicode.org/reports/tr29/) |
| 文字對比至少 4.5:1（不四捨五入）、相對亮度與對比值公式 | [W3C：Understanding SC 1.4.3 Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) |
| 滑鼠提示只放可以錯過的資訊；使用者需要的資訊放在畫面上 | [GoogleChrome/modern-web-guidance](https://github.com/GoogleChrome/modern-web-guidance) 的 interest-triggered-tooltips 指引 |
