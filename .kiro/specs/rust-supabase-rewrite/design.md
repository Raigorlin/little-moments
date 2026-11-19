# Design Document：Rust 全面改寫與自架 Supabase 即時同步（v1）

## Overview

本設計把「日子拾光 / LITTLE MOMENTS」的帳號版改寫成 Rust：後端是 axum 服務 `lm-server`，前端是以 Leptos 編譯成 WebAssembly 的 `lm-web`，資料、登入與即時推送改用自架的 Supabase（PostgreSQL、Auth／GoTrue、Realtime）。工作在分支 `rust-supabase-rewrite`（由 `main` 的 1b925a7 建立）進行。舊的 `rust-rewrite` 分支與 `.worktrees/rust-rewrite` 不動；本設計只借用它的 workspace 配置方式（`crates/*`、wasm 前端不參與原生建置、`rust-toolchain.toml` 指定 stable 與 `wasm32-unknown-unknown`）。

改寫的目的是即時協作。現在每趟旅行是一個 `trips.state_json` 文字欄位加一個 `revision`：任何寫入（包括一個勾選）都要帶最新版本號，否則得到 409；兩個人改不同項目也會互相擋住；其他人的畫面只能靠行程表分頁每 3 秒一次的 `PUT /api/trips/:id/presence` 輪詢發現新版本，再整份重抓、整頁重繪。v1 改成三件事：資料以「一個項目一列」儲存；每次提交產生一個依序編號的變更集（ChangeSet），透過 Supabase Realtime 的私有頻道推送給同一趟旅行的成員；前端用細粒度反應式（fine-grained reactivity），以列 id 為鍵，只重繪有變更的項目。

所有寫入與商業規則都在 Rust。`lm-core` 是不做 IO 的共用 crate，包含資料型別、命令、權限、驗證、衍生資料（料理食材 → 採買品項）、文字版與分帳計算；伺服器用它決定每個命令的結果，前端用同一份程式做表單檢查與樂觀更新的預測。PostgreSQL 負責儲存、交易、外鍵與發布；Realtime 頻道的授權用 `realtime.messages` 上的 RLS 政策。第一版只做主要功能，CI/CD、資安強化工作流與 QA 測試套件不在範圍內；測試只寫 `lm-core` 的單元測試與 proptest 屬性測試。現行的 Bun 版留在原處作為行為參考。

實作語言：**Rust**（後端、前端與共用邏輯）；資料庫結構以 **SQL** 遷移檔描述。

### 現況問題與根本原因

| 現象 | 原因（已讀取的程式碼） | v1 對策 |
|---|---|---|
| 兩個人同時勾選或編輯不同項目，後送出的一方收到 409「旅行已有更新，請重新載入後再勾選。」 | `migrations/0001_initial.sql` 的 `trips` 只有一個 `state_json TEXT` 與一個 `revision`；`server/accounts.js` 的 `putTrip`、`patchTrip`、`checkTrip` 都先呼叫 `requireRevision()`，`persist()` 以 `expectedRevision` 條件更新整列 | 一個項目一列（`app.*` 資料表）；命令只改自己指定的列與欄位；同一趟旅行的命令在伺服器依提交順序逐一執行，客戶端不需要帶版本號 |
| 衝突時介面要求「先匯出，再重新載入合併」 | `src/app.js` 的 `commitAccount()`、`accountCheck()` 的 409 文案 | 不再整份覆寫，也就沒有需要人工合併的衝突；同一欄位的並行修改依提交順序決定，後提交者生效 |
| 其他人的變更最多晚 3 秒才出現，而且只有行程表分頁會更新 | `src/app.js` 的 `presenceTick()` 每 3 秒呼叫 `PUT /api/trips/:id/presence`，看到較新的 `revision` 才 `GET` 整份旅行 | 提交時由資料庫 trigger 呼叫 `realtime.send()` 推送變更集；所有分頁都即時收到 |
| 收到更新後整頁重繪，捲動位置與展開狀態容易被打斷 | `render()` 每次以 `app.innerHTML` 重建整個畫面 | Leptos 以列 id 為鍵的 `<For>`，每列一個 signal，只更新變更的列 |
| 「誰正在編輯」存在伺服器記憶體，重啟就消失，只在輪詢時更新 | `server/accounts.js` 的 `presence` Map 與 `PRESENCE_TTL_MS` | Supabase Realtime Presence；斷線時自動移除 |

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
| B9 | 顯示誰正在編輯哪張卡片或哪一列（Presence）。 |
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
| D9 | 登入 | Supabase Auth；`lm-server` 代理註冊、登入與換發（BFF），帳號名稱對應到合成 email `<username>@<LM_AUTH_EMAIL_DOMAIN>` | 保留現行「帳號名稱 + 密碼」；帳號名稱規則與邀請註冊只在一處 |
| D10 | 對外入口 | 瀏覽器只連 `lm-server`：`/api/*` 與 `/realtime/v1/websocket`（由 `lm-server` 轉送給 Supabase，並補上 `apikey`） | Supabase 永遠只綁 127.0.0.1；同源，不需要 CORS；之後要在區網測試只需開放一個埠 |
| D11 | 本機開發 | Supabase CLI 本機堆疊（`supabase start`），以只綁 127.0.0.1 的 Docker 網路啟動；自架 Docker Compose 留到部署階段 | Windows 上最容易安裝；`supabase db reset` 直接套用 `supabase/migrations` |
| D12 | 舊程式 | Bun 版留在原處，只新增 Rust workspace 與 `supabase/` | 移植時逐條對照規則與既有測試案例；兩者互不干擾 |

### v1 範圍

| 功能 | v1 | 說明 |
|---|---|---|
| 註冊、登入、登出（Supabase Auth） | 範圍內 | 帳號名稱 3–32 個小寫英數字或連字號、以英文字母開頭；空資料庫上的第一個帳號成為管理員（取代 `/setup`） |
| 旅行列表、建立、編輯、刪除 | 範圍內 | 封面插畫、狀態（規劃中／已完成）；改日期沿用 `retimeByDayIndex()` 的規則 |
| 旅伴與車輛 | 範圍內 | 旅伴新增、編輯，管理者可移除未綁定帳號的旅伴；車輛的駕駛、座位數與乘客 |
| 地點清單 | 範圍內 | 「地點與車」的地點新增、改名、刪除（使用中不可刪） |
| 邀請連結 | 範圍內 | 單次使用、7 天有效；每趟最多 20 個有效連結，非管理者每人最多 5 個；登出狀態可以預覽並以連結註冊 |
| 行程表：規劃行程 | 範圍內 | 每天每台車一條路線、最多 6 個途中任務與任務類型；活動（含常用活動）；當天的料理；由規劃者填寫的預計抵達時間、當日標題與地點 |
| 行程表：文字版與複製 | 範圍內 | 由資料決定性產生（`itinerary_text()`） |
| 料理菜單 | 範圍內 | 依日期與餐次、負責人、食材、料理範本與常用食材捷徑 |
| 採買清單 | 範圍內 | 分類、誰負責買、數量、已買勾選、由料理自動同步、未分配採買清單 |
| 裝備分工 | 範圍內 | 個人／共用、負責人、每人的打包勾選、未分配數量 |
| 出發清單 | 範圍內 | 自己的打包進度、負責的裝備與採買、下一個未完成的活動、確認出發 |
| 分帳記帳（基本） | 範圍內 | 支出、還款、餘額與建議轉帳。資料只有兩張表加參與者，計算是現行 `summarizeLedger()` 的直接移植，推送方式與其他項目相同，所以放進 v1 |
| 誰正在編輯（Presence） | 範圍內 | 卡片或列層級；提示性的鎖定，可以選擇「仍要編輯」 |
| 收據 AI（OpenAI） | 之後 | 需要金鑰、費用控管與用量畫面 |
| 管理後台與稽核紀錄 | 之後 | v1 的管理員只有「可管理任何旅行」的權限 |
| 註冊政策設定畫面 | 之後 | v1 以環境變數 `LM_PUBLIC_SIGNUP` 代替 |
| `/demo/` 離線本機版與 Service Worker | 之後 | v1 必須連線使用 |
| 匯出、匯入、列印 | 之後 | |
| 行程圖（動畫海報）與場景動畫 | 之後 | v1 的插畫是靜態 SVG |
| 每日小語 | 之後 | |
| 小隊最近的動態 | 之後 | `app.trip_changes` 已保存每次提交，之後可以直接產生 |
| 淺色／深色主題切換、手機滑動手勢 | 之後 | CSS 已支援深色主題，之後加上切換即可 |
| 從現行 PostgreSQL 搬移資料 | 之後 | v1 從空資料庫開始 |
| CI/CD、資安強化、QA 測試套件 | 之後 | 依使用者指示暫不處理 |

### 與現行行為的差異

| 項目 | 現行 | v1 | 原因 |
|---|---|---|---|
| 密碼長度 | 12–128 字 | 12–72 個字元，且 UTF-8 編碼不超過 72 位元組 | GoTrue 以 bcrypt 儲存密碼，72 是硬上限（[Supabase 討論 #34207](https://github.com/orgs/supabase/discussions/34207)） |
| 登入狀態 | HttpOnly cookie `ggc_session` | GoTrue 的 access token 與 refresh token，存在瀏覽器 localStorage | 加入 Realtime 私有頻道需要 JWT；這也是 supabase-js 的預設做法 |
| 「誰正在編輯」 | 欄位層級鎖定，3 秒輪詢 | 卡片或列層級，最多每 6.5 秒更新一次，可以選「仍要編輯」 | [Realtime 限制](https://supabase.com/docs/guides/realtime/limits)每個用戶端每 30 秒 5 次 presence 呼叫；鎖定只是提示，同時編輯不會讓資料損壞 |
| 打包勾選 | 伺服器允許管理者以整份 PUT 改別人的打包狀態（介面沒有這個操作） | 每個人都只能勾自己的 | 與介面一致，命令層級的權限也較單純 |
| 移除旅伴 | 介面沒有這個操作；伺服器規則禁止移除綁定帳號的旅伴 | 管理者可以移除未綁定帳號、沒有帳目的旅伴 | 新增的操作，沿用現有限制 |
| 第一位管理員 | `/setup` 頁面 | 空資料庫上註冊的第一個帳號 | 少一個頁面與一組 API |
| 文字版 | 由行程繪本的 DOM 擷取；活動備註複製時接在同一行；抵達行是繪本的自由文字 | 由 `lm-core` 直接從資料產生；備註另起一行；抵達行由「預計幾點抵達」產生 | 行程繪本不在 v1；同一份資料永遠得到同一段文字 |
| 管理員未加入旅行時的分帳 | 讀不到 | API 仍然讀不到；Realtime 推送的變更集可能含分帳列，前端丟棄 | 頻道層級無法依列過濾；管理員本來就能管理整趟旅行 |
| 車輛的舊出發欄位 `meeting`，以及繪本專用欄位（標語、範本、停靠點自訂品項、抵達說明） | 有 | 無 | v1 從空資料庫開始，行程繪本也不在範圍內 |
| 網址 | `/<帳號名稱>/home`、`/<帳號名稱>/trips/<id>` | 相同；出發清單為 `/<帳號名稱>/trips/<id>/go` | 沿用 |

### 待使用者確認

1. 登入沿用「帳號名稱 + 密碼」（以合成 email 對應到 Supabase Auth），還是改成 email 登入？本設計採前者。
2. 分帳記帳放進 v1（本設計的選擇），或延後？
3. Presence 採提示性鎖定（可以選「仍要編輯」），而不是硬鎖定，可以嗎？
4. 文字版的兩處格式調整（備註另起一行、抵達行改用預計抵達時間）可以嗎？

## Architecture

### 系統組成

```mermaid
flowchart LR
  subgraph Browser["瀏覽器（每位旅伴、每個分頁）"]
    W["lm-web<br/>Leptos CSR（wasm32）"]
  end
  subgraph Host["開發機或自架主機"]
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
| `lm-web` | Rust → wasm32（Leptos CSR） | 畫面、表單檢查、樂觀更新、Realtime 訂閱與重新同步、Presence | 不直接連資料庫；不計算會被儲存的衍生資料 |
| `lm-server` | Rust（axum、sqlx、tokio） | 驗證 JWT；代理註冊、登入與換發；執行命令（權限、驗證、衍生資料）；快照與增量變更；邀請；轉送 Realtime WebSocket；提供前端靜態檔 | 不保存登入狀態（由 GoTrue 負責） |
| `lm-core` | Rust（native 與 wasm32） | 型別、命令、權限、`apply()`、採買同步、文字版、日期變更、分帳、`Replica` 合併、Presence 節流 | 不做 IO |
| `lm-supabase` | Rust | Realtime 協定與連線狀態機、GoTrue REST、JWT 驗證 | 不含應用規則 |
| PostgreSQL（Supabase） | | `app` schema 的資料表與外鍵、`trip_changes` 的 trigger、`realtime.messages` 的 RLS 政策 | 不放商業規則；CHECK 與外鍵只是最後防線 |
| Auth（GoTrue） | | 帳號、密碼、JWT 的簽發與換發 | |
| Realtime | | 私有頻道、由資料庫發出的 broadcast、presence | |
| API gateway（CLI 為 Kong；自架新版預設為 Envoy） | | 把 `/auth/v1`、`/realtime/v1` 轉給各服務 | 只綁 127.0.0.1 |
| Studio、postgres-meta | | 開發時檢視資料 | v1 程式不依賴 |
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
  S->>DB: 依 command_id 查重；讀取成員資格與整趟旅行的列
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
  Note over C,RT: heartbeat 每 20 秒；斷線時依 1、2、5、10 秒退避重連，重新 join 後再補齊
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
  PR --> V
```

### 本機開發

拓撲：

```
瀏覽器 ── http://127.0.0.1:8081 ──▶ trunk serve（改畫面時用；/api 與 /realtime 代理到 8080）
瀏覽器 ── http://127.0.0.1:8080 ──▶ lm-server（也直接提供 crates/web/dist）
lm-server ── sqlx ──────────────▶ 127.0.0.1:54322（PostgreSQL）
lm-server ── HTTP 與 WebSocket ─▶ 127.0.0.1:54321（API gateway → Auth、Realtime）
```

Windows（PowerShell、Docker Desktop）上的步驟：

```powershell
# 一次性
rustup target add wasm32-unknown-unknown
cargo install trunk --locked
scoop install supabase                      # 或使用 npx supabase
docker network create -o "com.docker.network.bridge.host_binding_ipv4=127.0.0.1" lm-local

# 每次開發
supabase start --network-id lm-local        # 之後以 docker ps 確認埠顯示為 127.0.0.1:543xx
supabase db reset                           # 套用 supabase/migrations（會清空本機資料）
supabase status -o env                      # 取得 API URL、anon／service_role key、JWT secret，填入 .env
cargo run -p lm-server                      # http://127.0.0.1:8080
trunk serve --config crates/web/Trunk.toml  # 需要即時重載畫面時
```

- `docker network create` 與 `--network-id` 是 [Supabase 本機開發文件](https://supabase.com/docs/guides/resources/supabase-cli/local-development) 建議的做法，讓 CLI 堆疊只綁 127.0.0.1（B12）。Supabase 也說明 CLI 堆疊沒有加固、使用預設憑證，不可對外開放。
- Windows 的 Hyper-V 保留埠範圍可能包含 543xx（[CLI issue #4128](https://github.com/supabase/cli/issues/4128) 的錯誤即為此情形）；遇到時以 `netsh interface ipv4 show excludedportrange protocol=tcp` 確認，並在 `supabase/config.toml` 改埠。
- 區網測試（手機）需要讓 `lm-server` 綁定非 loopback 位址。只要 `lm-server` 偵測到它使用的是 CLI 的範例 JWT 密鑰或範例金鑰，就拒絕在非 loopback 位址啟動（見「設定與啟動檢查」）。區網測試因此要改用自架 Docker Compose，並以 `utils/generate-keys.sh` 產生新的密鑰；這屬於部署階段，v1 只在本機開發。

### Repository 配置

```
little-moments/                      （分支 rust-supabase-rewrite）
├── Cargo.toml                        # [workspace]：members = crates/*；default-members 不含 web；exclude = [".worktrees"]
├── rust-toolchain.toml               # stable、wasm32-unknown-unknown、rustfmt、clippy
├── .cargo/config.toml                # wasm32 目標的 getrandom 後端設定
├── .env.example                      # lm-server 的環境變數名稱（不含真實值）
├── crates/
│   ├── core/       lm-core           # 型別、命令、權限、apply、採買同步、文字版、分帳、Replica（native + wasm32）
│   │   └── tests/                    # golden 測試（由 tests/*.test.js 的案例移植）與 proptest
│   ├── supabase/   lm-supabase       # features：server（GoTrue、JWT）、web（瀏覽器 WebSocket 傳輸）
│   ├── server/     lm-server         # bin：little-moments-server
│   └── web/        lm-web            # Trunk.toml、index.html、styles/、assets/art/
├── supabase/
│   ├── config.toml                   # supabase init 產生後調整（見下）
│   ├── migrations/
│   │   ├── 20260101000000_app_schema.sql
│   │   ├── 20260101000100_realtime_authorization.sql
│   │   └── 20260101000200_publish_changes.sql
│   └── seed.sql                      # 空檔；v1 從空資料庫開始
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
enable_signup = false                    # 帳號只能由 lm-server 以 admin API 建立
jwt_expiry = 3600

[auth.email]
enable_confirmations = false

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
| (d) Edge Functions | 規則寫成 Deno 函式（可以載入 Rust 編的 wasm） | 不必自己維護 HTTP 服務 | 執行環境是 Deno；v1 也不需要 Edge Runtime 服務 | 不採用 |

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
| Dioxus | 虛擬 DOM 加 signal；元件重新執行後比對 | 也做得到，但每次更新仍要比對元件樹；強項是桌面與行動裝置，v1 用不到；建置工具是 `dx` | 不採用 |
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
| Supabase CLI 本機堆疊 | Windows 可以用 scoop 或 npx 安裝；`supabase db reset` 套用遷移；`config.toml` 可以關閉不需要的服務 | 使用公開已知的範例金鑰；官方說明它沒有加固，不可對外開放 | **開發用**，配合只綁 127.0.0.1 的 Docker 網路 |
| [自架 Docker Compose](https://supabase.com/docs/guides/self-hosting/docker) | 與日後部署相同；`utils/generate-keys.sh` 產生新密鑰；可移除 Storage、imgproxy、Edge Runtime 等服務 | 要用 bash 執行腳本，手動步驟較多；沒有遷移工具 | 部署階段（不在 v1）；遷移檔是純 SQL，兩者都能套用 |

v1 需要的服務：PostgreSQL、Auth、Realtime、API gateway；Studio 與 postgres-meta 只為了開發時檢視資料。PostgREST 是堆疊內建的，App 不使用。Storage、imgproxy、Edge Runtime、Analytics（Logflare、Vector）與本機郵件服務都關閉。

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
| 帳號名稱加合成 email | `lm-server` 以 GoTrue admin API 建立 `<username>@<LM_AUTH_EMAIL_DOMAIN>` 並設 `email_confirm: true`，登入時把帳號名稱換成同一個 email。網域預設 `users.little-moments.invalid`：`.invalid` 是 RFC 6761 保留的網域，永遠不會解析，日後即使開啟郵件也不會寄到別人手上 | GoTrue 的 email 格式檢查若拒收這個網域，要改設為操作者自己控制的網域（R3）；沒有重設密碼 | **採用**：保留現行體驗，不需要 SMTP |
| email 加密碼 | Supabase Auth 的原生流程，之後可以加重設密碼 | 要有 SMTP 才有實質好處，而且改變登入體驗 | 備選（待確認 1） |

## Components and Interfaces

本節列出每個 crate 的模組、型別與函式介面；演算法本體在「Algorithmic Pseudocode」，前置與後置條件在「Key Functions with Formal Specifications」。

### 1. `lm-core`（共用規則，不做 IO）

#### 1.1 模組

| 模組 | 內容 | 移植來源 |
|---|---|---|
| `ids` | UUID newtype（`TripId`、`PersonId` …）、`IdSource` | `uid()` |
| `text` | `trim_white`、`char_count`、`has_control_chars`、`participant_key`、`place_key`、`clean_text`、`normalize_time_input` | `src/itinerary-model.js`、`src/model.js` |
| `time` | `Hm`（HH:MM）、`date_range`、`date_text`（`10/20（週二）`）、`chinese_numeral`、`duration_text` | `src/itinerary-model.js`、`dateRange()` |
| `model` | 列型別、列舉、`Row`、`Entity`、`RowKey`、`TripState` | `isValidState()` 的欄位 |
| `limits` | 所有數量與長度上限 | 各處常數 |
| `rules` | `Capabilities`、`capabilities()`、`authorize()`、`my_gear()`、`can_depart()`、`progress()`、`unassigned_gear()` | `server/accounts.js`、`src/model.js` |
| `command` | `Command` 與各種 Patch、Draft | 新增 |
| `apply` | `apply()`、`diff()`、各命令的處理函式 | `putTrip`、`checkTrip`、`src/itinerary-edits.js`、`src/app.js` 的表單儲存 |
| `ingredients` | `parse_ingredients`、`ingredient_key`、`classify_ingredient`、`sync_meal_ingredients`、`remove_ingredient_from_meals` | `src/ingredients.js` |
| `recipes` | `RECIPE_TEMPLATES`、`COMMON_INGREDIENTS`、`merge_ingredients`、`infer_dish_kind`、`PERSONAL_GEAR_GROUPS` | `src/recipes.js`、`src/gear-presets.js` |
| `itinerary` | `ACTIVITY_CATEGORIES`、`presets_for`、`STOP_KINDS`、`STOP_TASK_KINDS`、`meal_time`、`meal_title`、`sorted_routes`、`day_events`、`shopping_plan`、`destination_conflict` | `src/itinerary-model.js`、`src/itinerary-derive.js` |
| `itinerary_text` | `itinerary_text()` | `src/storybook/app.js` 的 `renderItinerary()` |
| `dates` | `retime_by_day_index()`、`shorten_blocked_message()` | `src/itinerary-dates.js` |
| `ledger` | `parse_amount`、`format_money`、`split_evenly`、`summarize`、`EXPENSE_CATEGORIES`、`suggest_expense_category` | `src/expense-model.js`、`src/expense-categories.js` |
| `validate` | `validate::state(state, mode)`：跨列的不變式 I1–I12（`Mode::Predict` 不檢查 I9） | `isValidState()`、`validateItinerary()` |
| `sync` | `Effect`、`Change`、`ChangeSet`、`Broadcast`、`Snapshot`、`Replica`、`overlay()` | 新增 |
| `presence` | `EditTarget`、`PresenceMeta`、`PresenceThrottle` | 新增 |
| `api` | HTTP 請求與回應型別、錯誤代碼 | 新增 |

`lm-core` 只依賴 `serde`、`serde_json`、`serde_with`、`uuid`、`chrono`（不啟用 clock）、`unicode-normalization`、`regex`、`indexmap`、`thiserror`；測試另加 `proptest`。它同時編成原生與 wasm32，所以不能用執行緒、系統時間或檔案。

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
    SaveDaySetting { day: Date, title: Option<String>, place: Option<PlaceId>, arrival: Option<Hm>, route_position: RoutePosition },
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
    pub seats: Option<u8>,
    #[serde(default, with = "serde_with::rust::double_option")]
    pub color: Option<Option<String>>,
    #[serde(default)]
    pub passengers_add: BTreeSet<PersonId>,
    #[serde(default)]
    pub passengers_remove: BTreeSet<PersonId>,
}
```

表單在開啟時記下當時的列，儲存時只把使用者改過的欄位放進 patch（集合欄位則算出加入與移除）。因此別人同時改了同一列的其他欄位，也不會被這次儲存蓋掉。唯一的例外是 `SaveRoute`：路線卡片把起點、終點、出發時間與停靠點當成一份草稿一起儲存，同一條路線的並行儲存由後提交者整條生效；Presence 會先提示誰正在編輯這張卡片。

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
    pub derived: Vec<Effect>,   // 採買同步造成的變化（只有 Mode::Commit 才有）
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

每個命令的處理函式在 `TripState` 的可寫副本上修改列；最後以 `diff()` 與原狀態比較，內容沒有改變的列不產生效果（見 A2）。因此「想要的狀態已經成立」的命令，例如再次勾選已買的品項，得到空的 `Outcome`，伺服器不寫入也不推送（B4）。

| 命令 | 驗證與拒絕（文案沿用現行） | 效果 |
|---|---|---|
| `UpdateTrip` | 標題 1–100 字、目的地 ≤100、介紹與小叮嚀 ≤1000、不含 U+0000（400）；日期為 1–31 天（400）；目的地與地點同名，或清空目的地時仍有路線使用（409，`destination_conflict()`）；縮短天數會刪掉有路線、標題或地點的日子（409，`shorten_blocked_message()`） | 更新旅行列；改日期時依 `retime_by_day_index()` 搬動活動、料理、路線與每日設定 |
| `AddPerson` | 名字正規化後 1–30 字、不含隱藏控制字元、與既有旅伴不同名（409）；角色 ≤60；最多 100 位（409） | 新增旅伴（未指定顏色時依人數輪替 `COLORS`）；刪除所有出發確認（沿用 `addParticipant()` 清空 `departed`） |
| `UpdatePerson` | 同上 | 更新 |
| `RemovePerson` | 綁定帳號的旅伴（409「已綁定帳號的旅伴不能在手冊中移除或更換，請由管理員處理帳號。」）；仍有支出或還款提到他（409） | 移植現行 `detachPerson()`：刪除旅伴；清除駕駛、乘客、活動參加者（清空後即為全體）、料理負責人、採買負責人、裝備負責人與打包勾選中的引用；有共用裝備因此失去負責人時，清空該項的打包並刪除所有出發確認，否則只刪除他自己的出發確認 |
| `AddVehicle`、`UpdateVehicle` | 名稱 1–50；座位 1–9；駕駛不在乘客中；乘客人數 + 1 ≤ 座位；引用的旅伴存在（400） | 新增或更新；乘客以集合加入與移除 |
| `RemoveVehicle` | 仍有路線（409「這台車在第 N 天還有路線，請先刪除這些路線，或改派給其他車。」）；仍被活動指定（409） | 刪除 |
| `AddPlace`、`RenamePlace` | `placeNameError()` 的四條規則（空白、超過 50 字、控制字元、同名，含與目的地同名）與 100 個上限 | 新增或改名 |
| `RemovePlace` | 仍被路線端點、停靠點或每日設定使用（409，列出用途） | 刪除 |
| `SaveRoute` | 日期在旅行範圍內；車輛存在；同一天同一台車不能有第二條路線（409）；端點與停靠點是地點，或在目的地不是空白時為旅行目的地；停靠點 ≤6；任務類型屬於停靠點種類；備註 ≤100 | 新增或整條取代（含停靠點） |
| `RemoveRoute` | | 刪除路線與它的停靠點 |
| `SaveDaySetting` | 日期在範圍內；標題 ≤20；地點存在 | 標題、地點與抵達時間都未設定時刪除該日設定；否則新增或更新 |
| `AddActivities`、`UpdateActivity` | 日期在範圍內；時間為 HH:MM；標題 1–100、地點 ≤150、備註 ≤1000；參加者或車輛存在；最多 1000 筆 | 新增或更新 |
| `RemoveActivity`、`SetActivityDone` | | 刪除；或設定完成狀態（冪等） |
| `AddMeal`、`UpdateMeal` | 日期在範圍內；份數 1–100；負責人存在；用餐時間為 HH:MM 或未設定 | 新增或更新；衍生：採買同步 |
| `RemoveMeal` | | 刪除；衍生：採買同步 |
| `RemoveIngredientFromMeals` | 品項與料理存在 | 從選定料理的食材文字移除這個品項的名稱（`removeIngredientFromMeals()`）；衍生：採買同步（已沒有料理需要時，品項由同步移除） |
| `AddShoppingItem` | 名稱 1–100；任一食材鍵與既有品項重複（409「清單已有同名品項，請編輯既有品項的數量與分類。」）；最多 1000 項 | 新增手動品項；衍生：採買同步 |
| `UpdateShoppingItem` | 連動料理的品項改名（409「連動食材名稱請在料理菜單修改。」）；數量 1–40 字 | 更新。只改數量時（行內編輯數量）`source` 不變；改了名稱、分類或負責人時設為手動品項（現行表單儲存與 `assignShopping()` 都把 `source` 設為 manual）；衍生：採買同步 |
| `RemoveShoppingItem` | 連動料理的品項（409，請改用從料理移除食材） | 刪除；清除支出中的採買連結；衍生：採買同步 |
| `SetShoppingPurchased` | | 設定已買（冪等）；受邀旅伴取消已買的料理品項時改為手動品項（`retainPurchased()`） |
| `AddGear`、`UpdateGear` | 名稱 1–100；個人裝備沒有負責人；負責人存在 | 新增或更新；負責人或範圍改變時清空該項的打包勾選；刪除所有出發確認（沿用現行表單） |
| `RemoveGear` | | 刪除；刪除所有出發確認 |
| `SetGearPacked` | 只能勾 `my_gear()` 中的項目（403「只能勾選自己的個人裝備或負責的共用裝備。」） | 加入或移除自己（冪等）；取消時一併刪除自己的出發確認 |
| `SetDeparted` | 確認時 `can_depart()` 必須成立（400「個人裝備尚未準備完成，或仍有共用裝備未分配。」） | 新增或刪除自己的出發確認（冪等） |
| `AddExpense`、`UpdateExpense` | 金額 NT$0.01–1,000,000；付款人與分攤旅伴存在（1–100 位、不重複）；分類有效；標題 1–100、備註 ≤500；採買連結存在 | 新增或更新 |
| `AddSettlement`、`UpdateSettlement` | 付款人與收款人不同且存在；金額同上 | 新增或更新 |
| `RemoveExpense`、`RemoveSettlement` | | 刪除 |

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

/// Realtime 的 payload：一般是完整的 ChangeSet；超過 64 KB 時只送序號，由客戶端補抓。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Broadcast { Full(ChangeSet), Thin { trip: TripId, seq: Seq, thin: bool } }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Viewer { pub user: UserId, pub username: String, pub display_name: String, pub role: Role, pub caps: Capabilities }

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
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct EditTarget { pub entity: Entity, pub key: RowKey }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PresenceMeta { pub user: UserId, pub person: Option<PersonId>, pub name: String, pub editing: Option<EditTarget> }

pub enum ThrottleAction { Send(PresenceMeta), WakeAt(f64), Nothing }

/// 保證任何 30 秒區間最多送出 5 次 track（Realtime 的每用戶端 presence 限制），且最後的狀態一定會送出。
pub struct PresenceThrottle { last_sent: Option<f64>, sent: Option<PresenceMeta>, pending: Option<PresenceMeta> }

impl PresenceThrottle {
    pub const MIN_GAP_MS: f64 = 6_500.0;
    pub fn offer(&mut self, meta: PresenceMeta, now_ms: f64) -> ThrottleAction;
    pub fn wake(&mut self, now_ms: f64) -> ThrottleAction;
}
```

#### 1.8 API 型別

```rust
// crates/core/src/api.rs（節錄）
pub struct CommandRequest { pub command_id: CommandId, pub command: Command }
pub struct CommandResponse { pub seq: Seq, pub changeset: Option<ChangeSet>, pub replayed: bool }  // None = 沒有變化

#[serde(tag = "status", rename_all = "snake_case")]
pub enum ChangesResponse { Changes { head: Seq, changesets: Vec<ChangeSet> }, SnapshotRequired { head: Seq } }

pub struct ApiError { pub code: String, pub message: String, pub field: Option<String> }

pub struct SignupRequest { pub username: String, pub display_name: String, pub password: String, pub invite: Option<InviteJoin> }
pub struct InviteJoin { pub token: String, pub name: String, pub role: String }
pub struct LoginRequest { pub username: String, pub password: String }
pub struct RefreshRequest { pub refresh_token: String }
pub struct SessionDto { pub access_token: String, pub refresh_token: String, pub expires_at: i64, pub user: ProfileDto }
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
    System { topic: String, status: String, message: String },
    HeartbeatOk,
    Other,
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
    pub const HEARTBEAT_MS: f64 = 20_000.0;         // 文件要求至少每 25 秒一次
    pub const BACKOFF_MS: [f64; 4] = [1_000.0, 2_000.0, 5_000.0, 10_000.0];  // 與 supabase-js 相同，另加 0–20% 抖動
    pub fn join(&mut self, topic: &str, presence_key: &str);
    pub fn leave(&mut self, topic: &str);
    pub fn track(&mut self, topic: &str, meta: &PresenceMeta);    // event "presence"，payload { type, event: "track", payload }
    pub fn set_access_token(&mut self, token: &str);              // 對每個已加入的頻道送 access_token
    pub fn on_event(&mut self, ev: SocketEvent, now_ms: f64) -> Vec<Inbound>;
    pub fn tick(&mut self, now_ms: f64);                          // heartbeat、heartbeat 逾時、退避後重連
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

pub struct GoTrueHttp { base: reqwest::Url, anon_key: String, service_key: String, http: reqwest::Client }

pub enum AuthError { InvalidCredentials, AlreadyExists, WeakPassword(String), RateLimited, Upstream(String) }
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

所有 `/api/*` 回應都是 JSON；錯誤為 `ApiError { code, message, field }`，`message` 是可直接顯示的繁體中文。除了註冊、登入、換發與邀請預覽，其他端點都要 `Authorization: Bearer <access token>`。因為不使用 cookie，不需要 CSRF token。

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/api/auth/signup` | 註冊；可附邀請（一次完成註冊與加入旅行）；`LM_PUBLIC_SIGNUP=false` 時沒有邀請一律 403 |
| POST | `/api/auth/login` | 帳號名稱與密碼 → `SessionDto` |
| POST | `/api/auth/refresh` | refresh token → 新的 `SessionDto` |
| POST | `/api/auth/logout` | 撤銷這個裝置的 refresh token |
| GET | `/api/me` | 目前帳號 |
| GET | `/api/trips` | 我參加的旅行（`TripSummary[]`） |
| POST | `/api/trips` | 建立旅行；建立者自動成為綁定的旅伴（角色「這趟的召集人」）；同一個 id 重送時回傳既有旅行 |
| DELETE | `/api/trips/{id}` | 刪除旅行（管理者）；設定 `deleted_at`，並推送 `trip_deleted` |
| GET | `/api/trips/{id}/snapshot` | `Snapshot` |
| GET | `/api/trips/{id}/changes?after=N` | `ChangesResponse`；落後超過 500 個 seq 時回 `snapshot_required` |
| GET | `/api/trips/{id}/head` | `{ seq }` |
| POST | `/api/trips/{id}/commands` | `CommandRequest` → `CommandResponse` |
| GET | `/api/trips/{id}/invites` | 有效的邀請連結（管理者看全部，其他人看自己的） |
| POST | `/api/trips/{id}/invites` | 建立邀請連結 → `InviteCreated`（`url_path` 為 `/invite/<token>`） |
| POST | `/api/trips/{id}/invites/{invite_id}/revoke` | 撤銷 |
| GET | `/api/invites/{token}` | 預覽（不需登入；有登入時另回 `already_member`） |
| POST | `/api/invites/{token}/join` | 以目前帳號加入（`{ name, role }`）；已是成員時直接回傳旅行 id |
| GET（WebSocket） | `/realtime/v1/websocket` | 轉送到 Supabase Realtime |
| GET | 其他路徑 | `LM_STATIC_DIR` 的靜態檔；找不到時回 `index.html`（前端路由） |

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
pub async fn changeset_by_command(tx: &mut PgTx, trip: TripId, id: CommandId) -> sqlx::Result<Option<ChangeSet>>;
/// 父列 upsert（ON CONFLICT (trip_id, id) DO UPDATE），子表整組替換；刪除依 Slot。
/// 外鍵都是 DEFERRABLE INITIALLY DEFERRED，寫入順序不影響結果，提交時統一檢查。
pub async fn write_changes(tx: &mut PgTx, trip: TripId, changes: &[Change]) -> sqlx::Result<()>;
/// UPDATE app.trips SET seq, next_ordinal, updated_at；INSERT INTO app.trip_changes（觸發推送）
pub async fn finish(tx: &mut PgTx, trip: TripId, seq: Seq, next_ordinal: u64, cs: &ChangeSet) -> sqlx::Result<()>;
/// BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY；沒有綁定旅伴的檢視者不含分帳列
pub async fn snapshot(pool: &PgPool, trip: TripId, viewer: &Viewer) -> sqlx::Result<Snapshot>;
pub async fn changes_after(pool: &PgPool, trip: TripId, after: Seq, viewer: &Viewer) -> sqlx::Result<ChangesResponse>;
```

v1 每個命令都重新讀取整趟旅行（約 14 個 SELECT）。本機資料庫上每個查詢不到 1 毫秒，一個命令約 10–20 毫秒；若之後需要，可以加上以 `(trip, seq)` 為鍵的記憶體快取，因為 `lm-server` 是唯一的寫入者，`seq` 相同就代表內容相同。

#### 3.3 登入代理（BFF）

| 端點 | 處理 |
|---|---|
| `signup` | 驗證帳號名稱（`^[a-z][a-z0-9-]{2,31}$`；保留字沿用現行的 api、admin、setup、login、register、logout、demo、assets，另加 invite，因為 `/invite/:token` 與 `/:user/home` 共用第一段路徑）、顯示名稱（1–30 字）、密碼（12–72 字元且不超過 72 位元組）→ GoTrue 建立使用者 → 同一個資料庫交易建立 `app.profiles`（空資料庫的第一個帳號為 admin）與（有邀請時）加入旅行 → 交易失敗時刪除剛建立的 GoTrue 使用者 → 以密碼登入取得 session |
| `login` | 帳號名稱轉成合成 email → `password_grant` → 讀取 profile → `SessionDto`；帳號或密碼錯誤一律回「帳號或密碼不正確。」 |
| `refresh` | `refresh` → `SessionDto` |
| `logout` | `logout`；失敗也回 200（前端仍會清除本機 token） |

GoTrue 本身有登入與註冊的速率限制；v1 不另外加。

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

| 環境變數 | 範例（CLI 堆疊） | 用途 |
|---|---|---|
| `LM_BIND` | `127.0.0.1:8080` | 監聽位址 |
| `DATABASE_URL` | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` | sqlx 連線 |
| `SUPABASE_URL` | `http://127.0.0.1:54321` | API gateway（Auth、Realtime、JWKS） |
| `SUPABASE_ANON_KEY` | `supabase status -o env` 的 anon key | Realtime 連線的 `apikey`、GoTrue 公開端點 |
| `SUPABASE_SERVICE_KEY` | `supabase status -o env` 的 service_role key | GoTrue admin API；只存在伺服器 |
| `SUPABASE_JWT_SECRET` | `supabase status -o env` 的 JWT secret | HS256 驗證；未設定時只用 JWKS |
| `LM_AUTH_EMAIL_DOMAIN` | `users.little-moments.invalid` | 合成 email 的網域 |
| `LM_PUBLIC_SIGNUP` | `true` | 是否開放不經邀請的註冊 |
| `LM_STATIC_DIR` | `crates/web/dist` | 前端檔案 |

啟動檢查（B12，成本只有幾行程式）：`LM_BIND` 不是 loopback 位址，而 `SUPABASE_JWT_SECRET`、`SUPABASE_ANON_KEY` 或 `SUPABASE_SERVICE_KEY` 等於 Supabase CLI 公開的範例值時，`lm-server` 印出原因並結束。範例值在實作時從 CLI 的 `supabase status` 輸出複製成常數。

### 4. `lm-web`

#### 4.1 路由與畫面

| 路徑 | 畫面 | 沿用的現行模板（DOM 結構與 class 名稱照抄，以重用 CSS） |
|---|---|---|
| `/login`、`/register` | 登入、註冊 | `src/accounts-ui.js` 的登入與註冊表單 |
| `/invite/:token` | 邀請預覽；以連結註冊，或以目前帳號加入 | `invite()` |
| `/:user/home` | 旅行列表、建立旅行（封面選擇） | `tripCard()`、`coverPicker()` |
| `/:user/trips/:id?tab=…` | 旅行頁：封面與倒數、五個分頁（行程表、料理菜單、採買清單、裝備分工、分帳記帳）、旅行選單（編輯旅行、旅伴、車輛、邀請、刪除） | `hero()`、`trip()`、`tripMenu()`、各分頁函式 |
| `/:user/trips/:id/go` | 出發清單 | `departure()` |

行程表分頁在 v1 只有「規劃行程」與「文字版」兩個區塊：選日、這一天的設定（標題、地點、預計幾點抵達）、每台車的路線卡片、活動（含常用活動）、當天料理（可改用餐時間）、地點與車、未分配採買清單，以及文字版與「複製文字」。

#### 4.2 同步引擎 `TripSync`

```rust
// crates/web/src/sync/engine.rs（介面）
pub enum ConnState { Connecting, Live, Reconnecting { attempt: u32 }, Offline }

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
    pub presence: RwSignal<BTreeMap<String, PresenceMeta>>,  // presence key → meta（不含自己）
}

impl TripSync {
    /// 本地操作：apply(Predict) 檢查並預測，放進 pending，更新受影響的列，排入送出佇列。
    pub fn submit(&mut self, command: Command) -> Result<CommandId, Rejection>;
    pub fn on_command_result(&mut self, id: CommandId, result: Result<CommandResponse, ApiError>);
    pub fn on_broadcast(&mut self, payload: Broadcast) -> Option<Resync>;
    pub fn on_snapshot(&mut self, snapshot: Snapshot);
    pub fn on_changes(&mut self, response: ChangesResponse) -> Option<Resync>;
}

pub enum Resync { ChangesAfter(Seq), Snapshot }
```

`TripSync` 存放在 `StoredValue` 中，以 Leptos context 提供給旅行頁的元件；網路工作以 `leptos::task::spawn_local` 執行。命令一次只送一個（FIFO），以保留使用者操作的先後順序，例如「新增料理，接著改它的份數」。

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

#### 4.4 登入狀態

- `SessionDto` 存在 localStorage 的 `lm.session.v1`；access token 到期前 60 秒自動換發，換發後以 `set_access_token()` 更新每個 Realtime 頻道。
- 其他分頁換發或登出時，以 `storage` 事件同步；GoTrue 預設啟用 refresh token 輪替，並有 10 秒的重用間隔，兩個分頁同時換發不會互相登出。
- API 回 401 時先換發一次再重試；換發失敗就前往 `/login?next=…`，並提示仍未送出的變更數量。

#### 4.5 Presence 的呈現

- 開啟編輯卡片或列的表單時 `offer(meta.editing = Some(target))`，關閉時 `offer(editing = None)`，經 `PresenceThrottle` 送出 `track`。
- 別人正在編輯同一個對象時，卡片顯示「小雨正在編輯」，欄位預設唯讀，旁邊有「仍要編輯」按鈕；按下後照常編輯，儲存時的規則與平常相同。
- Presence 狀態由 `presence_state` 建立、`presence_diff` 增減；斷線的用戶端由 Realtime 自動移除。

#### 4.6 連線狀態與重試

| 情況 | 畫面 | 行為 |
|---|---|---|
| Realtime 已連線 | 不顯示 | |
| Realtime 重連中 | 頂端提示「重新連線中，畫面可能不是最新」 | 命令仍經 HTTP 送出；自己的變更照常生效；重連並補齊後提示消失 |
| 沒有網路 | 「離線中，有 N 項變更尚未送出」 | pending 保留在記憶體；`online` 事件後依序重送（同一個 `command_id`）；關閉分頁會失去未送出的變更（v1 不持久化） |
| 伺服器拒絕命令 | toast 顯示 `ApiError.message` | 移除該 pending，畫面回到已確認狀態 |
| 5xx 或逾時 | 「儲存失敗，正在重試」 | 以 1、2、4、8、16 秒重試同一個 `command_id`，5 次後放棄並移除 |

#### 4.7 外觀沿用（B11）

- **插畫**：`scripts/export-art.mjs`（一次性，以現有的 Bun 執行）呼叫 `src/art.js` 的 `illustration()` 與 `logo()`、`src/dish-art.js` 的 `dishIllustration()`，把每一種插畫輸出成 `crates/web/assets/art/<kind>.svg`，通用餐盤的 7 種變化輸出成 `custom-0.svg`…`custom-6.svg`。輸出檔提交進版本庫，Rust 端以 `include_str!` 嵌入、以 `inner_html` 放進固定的容器；內容是靜態的、不含使用者文字。通用餐盤的變化改由料理 id 決定（`hash(meal_id) % 7`），同一道料理不會每次重繪就換圖。執行期與建置流程都不需要 JavaScript。
- **字型**：`index.html` 以 `<link data-trunk rel="copy-dir" href="../../assets/fonts" data-target-path="assets/fonts">` 複製 `assets/fonts/*.woff2` 與授權檔；`src/styles.css` 的 `@font-face` 路徑（`./assets/fonts/…`）不用改。
- **樣式**：把 `src/styles.css`、`src/accounts.css`、`src/expenses.css` 複製到 `crates/web/styles/`，以 `<link data-trunk rel="css">` 載入；Leptos 元件輸出與現行模板相同的元素結構與 class（例如 `.shopping-row>label`、`.gear-row>select` 依賴直接子元素的位置）。只在行程繪本、場景動畫與滑動手勢的選擇器上做刪減。

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

-- 每次提交一列：補齊、冪等與推送的來源。v1 不清除舊資料。
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

Realtime 在加入頻道與收到新的 `access_token` 時計算權限並快取到連線結束。因此帳號在連線期間失去存取權（例如旅行被刪除）時，仍可能收到訊息直到 JWT 過期或重新加入；v1 沒有移除成員的功能，旅行刪除則另外推送 `trip_deleted`，前端收到後離開頁面。

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
| `ordinal` | 列在這趟旅行中的建立順序 | lm-server，以 `trips.next_ordinal` 遞增；前端預測的新列先排在最後 |

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
| 料理 | 1000 筆；份數 1–100；名稱 100、食材 2000、備註 1000 字 | v1 新定（現行只有 5000 字的通用上限） |
| 採買品項 | 1000 項；名稱 100、數量 40 字 | `syncMealIngredients()` 的上限；數量沿用表單的 40 字；名稱長度為 v1 新定 |
| 裝備 | 1000 項；名稱 100、數量 40 字 | 裝備表單的 maxlength |
| 支出、還款 | 各 1000 筆；金額 NT$0.01–1,000,000；標題 100、備註 500 字；分攤 1–100 位 | `LEDGER_LIMITS` |
| 邀請連結 | 7 天；每趟 20 個有效；非管理者每人 5 個有效 | `INVITE_TTL`、`MAX_ACTIVE_INVITES`、`MAX_MEMBER_INVITES` |
| 帳號名稱、顯示名稱、密碼 | 3–32、1–30、12–72 字元（≤ 72 位元組） | `USERNAME`、GoTrue |

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

## Algorithmic Pseudocode

以 Rust 寫出主要演算法；為了閱讀，省略部分錯誤轉換與型別標註。

### A1. 伺服器執行命令 `execute()`

```rust
// crates/server/src/commands.rs
pub async fn execute(st: &AppState, user: &AuthUser, trip: TripId, req: CommandRequest)
    -> Result<CommandResponse, ApiError>
{
    let mut tx = st.db.begin().await?;

    // 1. 串行化：同一趟旅行的命令在這裡依序取得列鎖，持有到 COMMIT
    let head = repo::lock_trip(&mut tx, trip).await?.ok_or_else(ApiError::trip_not_found)?;

    // 2. 冪等：同一個 command_id 已經提交過（例如回應在網路上遺失後重送）
    if let Some(cs) = repo::changeset_by_command(&mut tx, trip, req.command_id).await? {
        tx.commit().await?;
        return Ok(CommandResponse { seq: cs.seq, changeset: Some(cs), replayed: true });
    }

    // 3. 身分與權限
    let me = repo::person_of(&mut tx, trip, user.id).await?;
    let caps = rules::capabilities(head.owner, user.id, user.role, me);
    if !caps.can_edit {
        return Err(ApiError::trip_not_found());
    }

    // 4. 讀取整趟旅行並套用：權限細節、驗證、主要效果與採買同步都在 lm-core
    let state = repo::load_trip(&mut tx, trip).await?;
    let ctx = Ctx { actor: user.id, caps };
    let outcome = apply(&state, &ctx, Mode::Commit, &mut UuidV4Ids, &req.command)?;
    if outcome.is_noop() {
        tx.commit().await?;                       // 想要的狀態已經成立：不寫入、不推送（B4）
        return Ok(CommandResponse { seq: head.seq, changeset: None, replayed: false });
    }

    // 5. 指定版本與建立順序
    let seq = head.seq + 1;
    let mut next_ordinal = head.next_ordinal;
    let mut changes = Vec::new();
    for effect in outcome.effects() {
        match effect {
            Effect::Upsert(row) => {
                let slot = row.slot();
                let row = if state.get(slot).is_none() && row.has_ordinal() {
                    next_ordinal += 1;
                    row.with_ordinal(next_ordinal - 1)
                } else {
                    row
                };
                changes.push(Change { entity: slot.0, key: slot.1, version: seq, row: Some(row.with_version(seq)) });
            }
            Effect::Delete((entity, key)) => changes.push(Change { entity, key, version: seq, row: None }),
        }
    }

    // 6. 寫入、記錄（trigger 推送）、提交；外鍵在 COMMIT 時檢查，失敗就整個回滾，也不會推送
    repo::write_changes(&mut tx, trip, &changes).await?;
    let cs = ChangeSet {
        trip, seq, command_id: req.command_id, actor: user.id,
        committed_at_ms: st.clock.now_ms(), changes, trip_deleted: false,
    };
    repo::finish(&mut tx, trip, seq, next_ordinal, &cs).await?;
    tx.commit().await?;
    Ok(CommandResponse { seq, changeset: Some(cs), replayed: false })
}
```

`?` 把 `Rejection` 轉成對應的 HTTP 狀態（400、403、404、409）；交易物件在提早回傳時自動回滾。

### A2. `apply()` 與命令處理函式

```rust
// crates/core/src/apply/mod.rs
pub fn apply(state: &TripState, ctx: &Ctx, mode: Mode, ids: &mut dyn IdSource, cmd: &Command)
    -> Result<Outcome, Rejection>
{
    rules::authorize(state, &ctx.caps, cmd)?;
    let mut draft = state.clone();                     // 處理函式只改 draft；失敗時整份丟棄
    handlers::run(&mut draft, ctx, cmd)?;              // 依命令分派，見下方兩例
    let primary = diff(state, &draft);                 // 只含內容改變的列，每個 Slot 一筆
    let mut derived = Vec::new();
    if mode == Mode::Commit && touches_ingredients(cmd) {
        let plan = ingredients::sync_meal_ingredients(&draft, ids)?;   // 衍生資料只在伺服器計算（B5）
        let mut synced = draft.clone();
        plan.apply_to(&mut synced);
        derived = diff(&draft, &synced);
        draft = synced;
    }
    // 防線：處理函式的疏漏在這裡變成拒絕，不會寫入。Predict 不跑採買同步，所以不檢查 I9。
    validate::state(&draft, mode).map_err(Rejection::invariant)?;
    Ok(Outcome { primary, derived })
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
```

`diff(before, after)` 逐一比較兩份狀態的每個 Slot：只在 `after` 有、或內容不同的產生 `Upsert`，只在 `before` 有的產生 `Delete`。以日期為鍵的每日設定在改日期時會整張重建，靠 `diff()` 產生正確的刪除與新增。

### A3. 料理食材 → 採買同步 `sync_meal_ingredients()`

逐行移植 `src/ingredients.js` 的 `syncMealIngredients()`；差別只在順序以 `ordinal` 取代陣列順序，以及 `meal_ids` 改成集合。

```rust
// crates/core/src/ingredients.rs
#[derive(Debug, Default, PartialEq)]
pub struct SyncPlan {
    pub upserts: Vec<ShoppingItem>,   // 內容改變的既有品項，以及新增的料理品項
    pub deletes: Vec<ShoppingId>,     // 只會是：料理產生、未買、已沒有料理需要的品項
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

    // 4. 仍未被任何品項涵蓋的食材：新增料理品項
    let mut created = 0usize;
    for (key, (name, meals)) in &needs {
        if covered.contains(key) {
            continue;
        }
        plan.upserts.push(ShoppingItem {
            id: ids.shopping_id(), name: name.clone(), quantity: "數量待確認".into(),
            category: classify_ingredient(name), assignee: None, purchased: false,
            source: ItemSource::Meal, meal_ids: meals.clone(), recipe_removed: None,
            ordinal: 0, version: 0,                         // 由 execute() 指定
        });
        created += 1;
    }
    if kept + created > LIMITS.shopping {
        return Err(Rejection::conflict("shopping_limit", "採買品項最多 1,000 項，請減少食材或整理採買清單後再儲存。"));
    }
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
        .map(|part| collapse_whitespace(part.nfkc().collect::<String>().trim()))
        .filter(|name| !name.is_empty() && seen.insert(ingredient_key(name)))
        .collect()
}

/// keyOf()：NFKC、移除所有空白、轉小寫。
pub fn ingredient_key(name: &str) -> String {
    name.nfkc().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase()
}
```

`classify_ingredient()` 的規則表照現行順序移植成 `regex`；唯一用到 lookahead 的 `地瓜(?!葉)` 改寫成等價的 `地瓜(?:[^葉]|$)`。JavaScript 的 `\s` 與 `trim()` 比 Rust 的 `char::is_whitespace` 多包含 U+FEFF；golden 測試會涵蓋這類邊界，若有差異以現行行為為準調整。

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
        // 在最新的已確認狀態上重新套用；不成立的命令暫時不顯示，最終以伺服器回應為準
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

    pub fn on_command_result(&mut self, id: CommandId, result: Result<CommandResponse, ApiError>) {
        match result {
            Ok(response) => {
                if let Some(cs) = &response.changeset {
                    self.replica.apply_changeset(cs);
                }
                self.pending.retain(|op| op.id != id);
            }
            Err(error) if error.is_retryable() => {        // 網路錯誤、逾時、5xx：以同一個 command_id 重送
                self.sender.retry_later(id);
                return;
            }
            Err(error) => {                                 // 400／403／404／409：回復（B8）
                self.pending.retain(|op| op.id != id);
                toast(&error.message);
            }
        }
        self.refresh_view();
    }

    pub fn on_broadcast(&mut self, payload: Broadcast) -> Option<Resync> {
        match payload {
            Broadcast::Thin { seq, .. } if seq > self.replica.watermark => Some(Resync::ChangesAfter(self.replica.watermark)),
            Broadcast::Thin { .. } => None,
            Broadcast::Full(cs) => {
                let report = self.replica.apply_changeset(&cs);
                self.pending.retain(|op| op.id != cs.command_id);    // 自己的命令經推送比 HTTP 回應先到
                if report.trip_deleted {
                    self.leave_trip("這趟旅行已被刪除。");
                    return None;
                }
                self.refresh_view();
                report.gap.map(|_| Resync::ChangesAfter(self.replica.watermark))
            }
        }
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
async fn run_trip_channel(sync: Handle, api: Api, socket: SocketHandle, session: Session) {
    loop {
        socket.join(&format!("trip:{}", sync.trip()), &sync.client_id());   // 等待連線與 phx_reply
        match socket.wait_join().await {
            Join::Ok => {}
            Join::Error(reason) if reason.starts_with("InvalidJWTExpiration") => {
                session.refresh().await;                     // 換發後重新加入
                continue;
            }
            Join::Error(_) => {                              // RLS 拒絕：已不是成員，或旅行已刪除
                sync.leave_trip("你已無法存取這趟旅行。");
                return;
            }
        }
        sync.set_conn(ConnState::Live);
        sync.presence_resend();                              // 重新加入後 presence 要重新 track
        let _ = resync(&sync, &api).await;                   // 加入之後才補齊，不留空窗（D6）
        while let Some(event) = socket.next_event().await {
            match event {
                Inbound::Broadcast { payload, .. } => {
                    let need = match serde_json::from_value::<Broadcast>(payload) {
                        Ok(message) => sync.on_broadcast(message),
                        Err(_) => Some(Resync::ChangesAfter(sync.watermark())),   // 看不懂的訊息：直接補齊
                    };
                    if let Some(need) = need {
                        let _ = resync_from(&sync, &api, need).await;
                    }
                }
                Inbound::PresenceState { state, .. } => sync.presence_reset(state),
                Inbound::PresenceDiff { joins, leaves, .. } => sync.presence_apply(joins, leaves),
                Inbound::ChannelClosed { .. } | Inbound::ChannelError { .. } => break,   // 由 socket 退避後重連
                _ => {}
            }
        }
        sync.set_conn(ConnState::Reconnecting { attempt: socket.attempt() });
    }
}

/// 分頁回到前景、`online` 事件、或可見時每 60 秒呼叫一次：比對 head，有落後才補齊。
async fn check_head(sync: &Handle, api: &Api) -> Result<(), ApiError> {
    if api.head(sync.trip()).await? > sync.watermark() {
        resync(sync, api).await?;
    }
    Ok(())
}

async fn resync(sync: &Handle, api: &Api) -> Result<(), ApiError> {
    let need = if sync.watermark() == 0 { Resync::Snapshot } else { Resync::ChangesAfter(sync.watermark()) };
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
pub async fn signup(st: &AppState, req: SignupRequest) -> Result<SessionDto, ApiError> {
    let username = validate_username(&req.username)?;
    let display_name = validate_display_name(&req.display_name)?;
    validate_password(&req.password)?;                     // 12–72 字元，且 UTF-8 不超過 72 位元組
    if req.invite.is_none() && !st.config.public_signup {
        return Err(ApiError::forbidden("目前只接受以邀請連結註冊。"));
    }
    if let Some(invite) = &req.invite {
        invites::check_usable(&st.db, &invite.token).await?;   // 先做便宜的檢查
    }
    let email = format!("{username}@{}", st.config.auth_email_domain);
    let user = st.auth.create_user(&email, &req.password, &json!({ "username": username }))
        .await
        .map_err(|e| match e {
            AuthError::AlreadyExists => ApiError::conflict("username_taken", "這個帳號名稱已被使用。"),
            other => other.into(),
        })?;

    let joined = async {
        let mut tx = st.db.begin().await?;
        // 第一個帳號成為管理員；advisory lock 讓兩個同時註冊的人只有一個成為管理員
        sqlx::query("select pg_advisory_xact_lock(hashtext('app.first_admin'))").execute(&mut *tx).await?;
        let role = if repo::profile_count(&mut tx).await? == 0 { Role::Admin } else { Role::Member };
        repo::insert_profile(&mut tx, user, &username, &display_name, role).await?;
        if let Some(invite) = &req.invite {
            // 鎖住旅行、再驗證邀請、新增綁定旅伴、標記已使用、寫入變更集（其他成員即時看到新旅伴）
            invites::join_in_tx(&mut tx, user, invite).await?;
        }
        tx.commit().await?;
        Ok::<(), ApiError>(())
    }.await;

    if let Err(error) = joined {
        let _ = st.auth.delete_user(user).await;           // 補償：不留下沒有 profile 的 Auth 帳號
        return Err(error);
    }
    login_with_email(st, &email, &req.password).await
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

輸出格式（每行以 `\n` 分隔，清單項目以「・」開頭；所有使用者文字先經 `clean_text()`，把含換行的空白壓成一個空格）：

```
{旅行名稱}
車輛：{車名、車名…｜尚未安排}
第 {n} 天・{M/D}（週{X}）｜{當日標題｜未命名的一天}
地點：{當日地點｜旅行目的地｜未指定}
路線                                          （當天有路線時）
・{車名}｜{HH:MM 出發｜出發時間未填}：{起點} → {停靠點} → … → {終點}
預計 {HH:MM} 抵達{地點}                         （有預計抵達時間時）
活動
・{HH:MM} {標題}（{類別}）[・餐點]               （沒有任何活動與料理時為「無安排」）
  {備註}                                       （有備註時）
…（每一天重複；當日設定為「路線在後」時，活動區塊在路線區塊之前）
未分配採買清單                                  （有「待分配」品項時）
・{品項名稱}
```

停靠點寫成 `{地點}（{任務}{ HH:MM｜・時間未填}{：品項、…；備註}）`。採買停靠點的品項由 `shopping_plan()` 推導（品項負責人所在的車、那台車最早的採買停靠點），超過 8 項時列前 7 項再加「等另外 N 項」，與現行 `derivedItems` 相同。

```rust
// crates/core/src/itinerary_text.rs
pub fn itinerary_text(s: &TripState) -> String {
    let plan = shopping_plan(s);
    let mut out: Vec<String> = Vec::new();
    out.push(clean_text(&s.card.title));
    let cars: Vec<String> = s.vehicles_by_ordinal().map(|v| clean_text(&v.name)).collect();
    out.push(format!("車輛：{}", if cars.is_empty() { "尚未安排".to_string() } else { cars.join("、") }));

    for (i, day) in date_range(s.card.start, s.card.end).into_iter().enumerate() {
        let setting = s.day_settings.get(&day);
        let title = setting.and_then(|d| d.title.as_deref()).map(clean_text).filter(|t| !t.is_empty());
        out.push(format!("第 {} 天・{}｜{}", i + 1, date_text(day), title.as_deref().unwrap_or("未命名的一天")));
        let place = day_place_name(s, setting);            // 當日地點，否則非空白的旅行目的地
        out.push(format!("地點：{}", place.as_deref().unwrap_or("未指定")));

        let mut route_block = Vec::new();
        let routes: Vec<String> = sorted_routes(s, day).map(|r| format!("・{}", route_line(s, &plan, r))).collect();
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
    let items = if stop.kind == StopKind::Shop { stop_item_names(plan.stop_items(stop.id)) } else { Vec::new() };
    let extra: Vec<String> = [items.join("、"), clean_text(&stop.note)].into_iter().filter(|x| !x.is_empty()).collect();
    let extra = if extra.is_empty() { String::new() } else { format!("：{}", extra.join("；")) };
    format!("{}（{}{}{}）", place_ref_name(s, stop.place), task, time, extra)
}
```

活動的類別文字是 `ACTIVITY_CATEGORIES` 的標籤；料理的標題是 `meal_title()`（「{餐次}：{名稱}」），類別依 `infer_dish_kind()` 與餐次得到火鍋、烤肉、早餐、午餐或用餐（現行 `mealKind()`）。「複製文字」把這段字串原樣寫入剪貼簿（`navigator.clipboard.writeText`，失敗時改為選取 `<pre>` 讓使用者手動複製）。

### A11. Presence 節流

```rust
// crates/core/src/presence.rs
impl PresenceThrottle {
    pub fn offer(&mut self, meta: PresenceMeta, now_ms: f64) -> ThrottleAction {
        if self.sent.as_ref() == Some(&meta) {
            self.pending = None;                           // 對方看到的已是這個狀態
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

    /// 重新加入頻道後 presence 狀態已清空，要重新 track。
    /// 呼叫後再呼叫 wake()：較新的 pending 優先，否則重送最後送出的狀態；仍受 MIN_GAP_MS 限制。
    pub fn force_resend(&mut self) { self.pending = self.pending.take().or(self.sent.take()); }
}
```

兩次送出至少相隔 6.5 秒，所以任何 30 秒的區間最多 ⌊30 ÷ 6.5⌋ + 1 = 5 次。

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

## Key Functions with Formal Specifications

### `apply(state, ctx, mode, ids, cmd)`

**Preconditions:**
- `validate::state(state, Mode::Commit)` 成立（伺服器讀出的狀態，或客戶端的已確認狀態）。
- `ctx.caps` 是以這趟旅行的擁有者、行為者的角色與他綁定的旅伴，經 `capabilities()` 算出的。

**Postconditions:**
- 回傳 `Ok(o)` 時：`authorize(state, ctx.caps, cmd)` 成立；`validate::state(state ⊕ o.effects(), mode)` 成立；每個 Slot 在 `o.primary`、`o.derived` 中各最多一筆；沒有內容未變的列；`mode == Predict` 時 `o.derived` 為空。
- 回傳 `Err(r)` 時沒有任何副作用；`state` 本來就以唯讀參照傳入。
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
- 品項總數超過 1000 時回傳 `Err(Conflict)`，不產生部分結果。

**Loop Invariants:** 見 A3。

### `parse_ingredients(text)`

**Preconditions:** 無（任何字串）。

**Postconditions:**
- 每個結果都不是空字串、沒有前後空白、內部的空白已壓成一個空格。
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
- 成功提交時：`trips.seq` 剛好加一；寫入的列與 `app.trip_changes` 中的變更集一致；變更集在同一個交易中交給 `realtime.send()`。
- 同一個 `command_id` 第二次送達時，回傳第一次的變更集，不再寫入。
- 拒絕、無效果或任何錯誤時，資料庫不變，也不推送。
- 同一趟旅行的兩個命令不會交錯執行；不同旅行的命令互不等待。

**Loop Invariants:** 指定版本的迴圈中，`next_ordinal` 等於「已處理的新列數 + 開始時的 next_ordinal」。

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
- 每一天剛好出現一次「第 n 天」行，依日期遞增。

**Loop Invariants:** 處理完前 i 天後，輸出包含第 1 到 i 天的區塊，且順序正確。

### `PresenceThrottle::offer(meta, now)` 與 `wake(now)`

**Preconditions:** `now` 單調不減。

**Postconditions:**
- 任何長度 30 秒的區間內，`Send` 最多 5 次。
- 只要在最後一次 `offer` 之後於 `WakeAt` 指定的時間呼叫 `wake`，最後一個 `meta` 一定會被送出（屬性 14）。

**Loop Invariants:** N/A

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
            // 負責人選單、數量與操作按鈕同樣只讀這一列的 signal
        </div>
    }
}
```

### 伺服器：路由

```rust
// crates/server/src/main.rs（節錄）
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
    .route("/invites/{token}/join", post(invites::join));

let index = config.static_dir.join("index.html");
let app = Router::new()
    .nest("/api", api)
    .route("/realtime/v1/websocket", get(gateway::realtime_proxy))
    .fallback_service(ServeDir::new(&config.static_dir).fallback(ServeFile::new(index)))
    .with_state(state);

config.refuse_sample_secrets_off_loopback()?;               // B12 的啟動檢查
let listener = tokio::net::TcpListener::bind(config.bind).await?;
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

屬性只涵蓋 `lm-core` 的純函式（規則、合併、衍生資料、文字版、日期、分帳與 Presence 節流），以 proptest 驗證。畫面、網路、資料庫與 Realtime 服務的行為不在屬性測試中（見「Testing Strategy」）。

共用產生器：

- `arb_state()`：1–5 天、0–6 位旅伴（部分綁定帳號）、0–3 台車、0–6 個地點、每台車每天 0–1 條路線（0–6 個停靠點）、0–10 個活動、0–8 道料理、0–15 個採買品項（料理與手動、已買與未買混合）、0–10 個裝備、0–5 筆支出與還款。食材文字從一組詞彙組成，包含 `、，;；/。`、換行、`1.5`、`1,000`、全形數字、前後與中間的空白、大小寫英文與重複名稱。
- `arb_command(state)`：大多數引用既有的列，也有不存在的 id、超過上限的文字、別人的旅伴與邊界值。
- `arb_caps(state)`：擁有者、管理員、綁定旅伴的受邀成員、沒有綁定旅伴的管理員、非成員。
- `ModelServer::run(script)`：依序以 `Mode::Commit` 執行一串 `(actor, command)`，產生連續 seq 的變更集與每個 seq 的快照。
- `arb_delivery_plan()`：把變更集排列、重複，隨機插入某個 seq 的快照；保證最後一個快照之後的每個變更集至少送達一次。

### Property 1: 任意送達順序都收斂到伺服器狀態

*For any* 由 `ModelServer::run()` 產生的變更集 1..=n，以及任何 `arb_delivery_plan()` 產生的送達方式（任意順序、重複、在任意位置插入任意 seq 的快照），`Replica` 處理完全部事件後，`state` 等於伺服器在 n 的狀態，`watermark == n`。

**Validates:** B3、B7

### Property 2: 水位線與缺號回報正確

*For any* 1..=n 的任意子集合依任意順序送達，`watermark` 等於最大的 w 使得 1..=w 全部已送達；`ahead` 不為空時 `gap == Some((watermark + 1, min(ahead) − 1))`，否則為 `None`。

**Validates:** B7

### Property 3: 只回報內容真的改變的列

*For any* `Replica` 與任何變更集或快照，`ApplyReport.changed` 作為集合，恰好等於「套用前後 `state.get(slot)` 不同」的 Slot 集合。

**Validates:** B2

### Property 4: 採買同步冪等

*For any* `arb_state()` 產生的狀態 s，令 s′ 為 s 套用 `sync_meal_ingredients(s)` 的結果，則 `sync_meal_ingredients(s′)` 的 `upserts` 與 `deletes` 都是空的。

**Validates:** B5

### Property 5: 採買同步不刪除手動與已買的品項，也不改使用者管理的欄位

*For any* 狀態 s，`sync_meal_ingredients(s).deletes` 中沒有 `source == Manual` 或 `purchased == true` 的品項；每個留下的品項的名稱、數量、分類、負責人與已買狀態都與 s 相同。

**Validates:** B5

### Property 6: 採買同步涵蓋每一個需要的食材

*For any* 狀態 s，套用同步之後，每道料理的 `parse_ingredients(ingredients)` 中每個名稱的 `ingredient_key`，都等於某個品項名稱切分後的某個鍵；新增的品項數不超過同步前未被涵蓋的鍵數。

**Validates:** B5

### Property 7: 勾選是冪等的集合操作

*For any* 狀態 s 與任何勾選命令 c（`SetShoppingPurchased`、`SetGearPacked`、`SetDeparted`、`SetActivityDone`），若 `apply(s, c)` 成功得到 s₁，則 `apply(s₁, c)` 成功且 `is_noop()`；目標欄位的最後值等於 c 指定的值，與 s 中原本的值無關。*For any* 兩個指向不同（項目、旅伴）組合的勾選命令 c₁、c₂，依 c₁c₂ 或 c₂c₁ 的順序套用得到相同的狀態。

**Validates:** B4

### Property 8: 權限判斷與規則表一致

*For any* 身分（擁有者、管理員、受邀成員、沒有綁定旅伴的管理員、非成員）、任何命令種類、任何目標（自己或別人的旅伴、綁定或未綁定），`authorize()` 成功若且唯若測試中另外以查表實作的「權限」表格允許；被拒絕時的種類（404 或 403）也與表格相同。

**Validates:** B6

### Property 9: 成功的命令一定保持不變式

*For any* 合法狀態 s、任何 `arb_caps()` 與任何 `arb_command(s)`（包含不合法的命令），`apply(s, Commit)` 回傳 `Ok(o)` 時 `validate::state(s ⊕ o.effects(), Commit)` 成立（I1–I12）；回傳 `Err` 時 s 不變。

**Validates:** B3、B5、B6

### Property 10: 前端預測與伺服器的主要效果相同

*For any* s、caps 與命令 c，`apply(s, Predict)` 與 `apply(s, Commit)` 都成功時兩者的 `primary` 相同，且 Predict 的 `derived` 為空；Predict 失敗則 Commit 也失敗；Commit 只會在採買同步超過 1000 項時比 Predict 多一種失敗。

**Validates:** B5、B8

### Property 11: 回復不留下殘留

*For any* 已確認狀態、pending 命令序列與其中任一個被拒絕的命令 k，移除 k 之後的 `overlay()` 等於只以其餘命令計算的 `overlay()`；pending 為空時 `overlay()` 等於已確認狀態。

**Validates:** B8

### Property 12: 不同欄位的 patch 可交換，同一欄位以提交順序決定

*For any* 一列與兩個 patch p₁、p₂：若兩者修改的欄位不相交，依 p₁p₂ 與 p₂p₁ 的順序套用得到相同的列；若修改同一欄位，結果等於後套用者的值。對集合欄位（乘客、參加者），不同元素的加入與移除也可交換。

**Validates:** B3

### Property 13: 文字版是決定性的

*For any* 狀態 s，以不同的插入順序把同樣的列重新放進新的 `TripState`，`itinerary_text()` 的結果完全相同；同一個 s 呼叫兩次結果相同；輸出中「第 n 天」行剛好出現旅行天數次，依日期遞增。

**Validates:** B10

### Property 14: Presence 節流遵守 Realtime 的限制且不遺失最後狀態

*For any* 時間不遞減的 `offer` 序列，並在每個 `WakeAt` 指定的時間呼叫 `wake`：任何 30 秒區間內的 `Send` 不超過 5 次；全部處理完之後，最後一次送出的 meta 等於最後一次 offer 的 meta。

**Validates:** B9

### Property 15: 分帳金額守恆

*For any* 支出與還款，`summarize()` 的淨額總和為 0；每筆 `split_evenly()` 的總和等於金額，任兩人相差最多 1 分；依建議轉帳全部執行後，每個人的淨額都是 0。

**Validates:** 範圍表「分帳記帳（基本）」

### Property 16: 改日期保留「第 N 天」

*For any* 合法狀態與新的 1–31 天範圍，`retime_by_day_index()` 成功時，舊第 N 天的路線與每日設定都在新的第 N 天，活動與料理在新的第 min(N, 新天數) 天，結果滿足 I5；失敗時 `draft` 不變，`blocked` 恰好是被刪掉、且有路線或有標題、地點的日子。

**Validates:** 範圍表「旅行列表、建立、編輯、刪除」

### Property 17: 食材切分再切一次不變

*For any* 字串 t，`parse_ingredients(parse_ingredients(t).join("、")) == parse_ingredients(t)`，而且結果中沒有兩個名稱的 `ingredient_key` 相同。

**Validates:** B5

## Error Handling

| 情境 | 偵測 | 處理 | 使用者看到 |
|---|---|---|---|
| 命令被拒絕（400、403、404、409） | `apply()` 回傳 `Rejection` | 伺服器不寫入；前端移除該 pending 並重算畫面（B8） | toast 顯示原因，例如「只能變更自己的行前準備。」 |
| 網路錯誤、逾時、5xx | `fetch` 失敗或狀態碼 | 以 1、2、4、8、16 秒重送同一個 `command_id`；伺服器以 `trip_changes.command_id` 去重；5 次後放棄 | 「儲存失敗，正在重試」；放棄時「儲存失敗，變更已還原」 |
| 回應遺失但伺服器已提交 | 重送時 `changeset_by_command()` 找到 | 回傳原本的變更集（`replayed`） | 無 |
| API 回 401（access token 過期或被撤銷） | 狀態碼 | 換發一次後重試；換發失敗則前往 `/login?next=…` | 「登入已失效，請重新登入；尚有 N 項變更未送出」 |
| 加入頻道時 `InvalidJWTExpiration` | `phx_reply` 的 reason | 換發 token 後重新加入 | 無 |
| 連線中 token 過期（`system`：Token has expired） | `system` 事件後 `phx_close` | 換發、重新加入、補齊 | 短暫顯示「重新連線中」 |
| 頻道授權失敗（`Unauthorized` 等） | `phx_reply` 的 reason | 不重試，離開旅行頁 | 「你已無法存取這趟旅行。」 |
| WebSocket 斷線、`phx_error`、heartbeat 沒有回覆 | 傳輸事件或計時 | 依 1、2、5、10 秒（含抖動）重連；重新加入後以 `changes?after=` 補齊（B7） | 「重新連線中，畫面可能不是最新」 |
| 推送遺失（seq 跳號） | `ApplyReport.gap` | 立即 `changes?after=水位線` | 無 |
| 推送遺失而且之後沒有新提交 | 前景、`online`、每 60 秒比對 `head` | 落後就補齊 | 無 |
| 變更集太大（thin 通知） | `Broadcast::Thin` | `changes?after=水位線` | 無 |
| 落後超過 500 個 seq | `snapshot_required` | 改抓快照 | 無 |
| 旅行被刪除 | 變更集 `trip_deleted` | 離開頁面，回到旅行列表 | 「這趟旅行已被刪除。」 |
| 沒有任何連線者時提交（`realtime.messages` 沒有當天的 partition） | Postgres 記錄 `WarnSendingBroadcastMessage` | 提交照常成功；之後連線的人以補齊取得 | 無 |
| 提交時外鍵或 CHECK 失敗 | `COMMIT` 錯誤 | 回 500、整個回滾、記錄 `tracing::error!`；這代表 `lm-core` 的驗證有漏洞 | 「儲存失敗，變更已還原」 |
| 註冊時 GoTrue 已建立帳號、但 profile 或加入旅行失敗 | 交易錯誤 | 以 admin API 刪除剛建立的 GoTrue 帳號，回傳原本的錯誤 | 錯誤原因，例如「邀請連結無效或已過期。」 |
| 帳號名稱已被使用 | GoTrue 回傳 email 已存在 | 409 | 「這個帳號名稱已被使用。」 |
| GoTrue 拒收合成 email 的網域 | GoTrue 的 `email_address_invalid` | 回 500，並記錄設定錯誤（`LM_AUTH_EMAIL_DOMAIN`） | 「註冊暫時無法使用，請聯絡管理員。」 |
| Presence 超過速率限制 | `system`：Client presence rate limit exceeded，接著 `phx_close` | 重新加入；節流器的最小間隔保證不會反覆發生 | 無 |
| 正在編輯的列被別人改了 | 列的 signal 改變，但表單有草稿 | 草稿不被覆蓋；顯示「小雨剛更新了這一項」；儲存時只送出自己改過的欄位 | 提示 |
| 正在編輯的列被別人刪了 | 列從 `RowStore` 移除 | 關閉表單 | 「這個項目已被刪除。」 |
| 啟動時綁定非 loopback 位址又使用範例金鑰 | `refuse_sample_secrets_off_loopback()` | 程序結束（B12） | 終端機訊息說明原因 |

## Testing Strategy

依使用者指示，v1 只為核心規則寫測試；不建立 Playwright、Lighthouse、資安測試套件或資料庫整合測試。

### `lm-core` 的單元測試（golden）

把現行 `tests/*.test.js` 中與移植規則相關的案例改寫成 Rust 的範例測試，確保行為與 Bun 版一致：

| 現行測試 | 移植到 |
|---|---|
| `tests/ingredients.test.js` | `parse_ingredients`、`classify_ingredient`、`sync_meal_ingredients`、`remove_ingredient_from_meals` |
| `tests/meal-order.test.js`、`tests/recipes-invites.test.js` 的料理部分 | 餐次排序、`infer_dish_kind`、`merge_ingredients` |
| `tests/itinerary-model.test.js`、`tests/itinerary-place-name.test.js`、`tests/itinerary-time-input.test.js`、`tests/itinerary-numerals.test.js` | `place_key`、地點名稱規則、`normalize_time_input`、`chinese_numeral`、`date_text` |
| `tests/itinerary-shopping.test.js`、`tests/itinerary-derive.test.js` 的採買部分 | `shopping_plan` |
| `tests/itinerary-dates.test.js` 的 `retimeByDayIndex` 部分 | `retime_by_day_index`、`shorten_blocked_message` |
| `tests/expense-model.test.js`、`tests/ledger.test.js` 的計算部分 | `parse_amount`、`format_money`、`split_evenly`、`summarize` |
| `tests/model.test.js` | `my_gear`、`can_depart`、`progress`、名稱規則 |

文字版以一份固定的範例旅行（移植 `tests/fixtures/example-trip.js` 的資料）做一個完整輸出的比對測試。

### `lm-core` 的屬性測試

- 以 `proptest` 實作 Property 1–17；每個屬性預設 256 個案例，可用環境變數 `PROPTEST_CASES` 增加。
- 每個屬性測試上方加註 `// Feature: rust-supabase-rewrite, Property N: <標題>`。
- proptest 失敗時產生的 `proptest-regressions/` 檔案提交進版本庫，之後每次都會重跑。
- 產生器與 `ModelServer` 放在 `crates/core/tests/support/`，只在測試中編譯。

### `lm-supabase` 的少量單元測試

協定訊框的編解碼（以 Supabase 協定文件中的範例訊框為輸入），以及 `PhoenixSocket` 以假的傳輸層驗證：連線後送出 `phx_join`、每 20 秒 heartbeat、heartbeat 沒有回覆就重連、退避間隔、換發 token 時對每個頻道送 `access_token`。不連網路。

### 其他

- `cargo clippy --workspace -- -D warnings`、`cargo fmt --check`、`trunk build --release` 作為本機的建置檢查。
- `lm-server` 與 `lm-web` 在 v1 不寫自動化測試。README 列一份手動確認步驟：兩個瀏覽器視窗開同一趟旅行，在一邊勾選已買，另一邊在 2 秒內更新；在開發者工具切換離線後再恢復，兩邊的畫面一致。

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
| Presence | 每個用戶端最多每 6.5 秒一次 | 在 Realtime 每 30 秒 5 次的限制內 |

## Security Considerations

資安強化是另一個工作流，v1 不處理。下列幾點不需要額外成本，或是功能本身就需要，因此放在 v1：

- 本機 Supabase 只綁 127.0.0.1（Docker 網路的 `host_binding_ipv4`）；`lm-server` 與 `trunk serve` 預設也只綁 127.0.0.1（B12）。
- `lm-server` 在非 loopback 位址上偵測到 CLI 的範例 JWT 密鑰或金鑰時拒絕啟動；要讓其他機器連入，必須改用以 `generate-keys.sh` 產生新密鑰的自架堆疊（B12）。
- service key 只存在 `lm-server` 的環境變數；瀏覽器只拿到使用者自己的 JWT；Realtime 的 `apikey` 由 `lm-server` 轉送時補上。
- 旅行資料只透過 `lm-server` 的命令與快照存取；`app` schema 不在 PostgREST 的 `api.schemas` 中，全部啟用 RLS 且不授權給 `anon`、`authenticated`（B6）。
- Realtime 頻道以 RLS 限制成員；客戶端沒有送 broadcast 的權限，變更集只能由資料庫發出（B6）。
- 邀請 token 只保存 SHA-256；API 使用 Bearer token、不使用 cookie，所以沒有 CSRF 問題。

明確延後到資安工作流的項目：速率限制（GoTrue 內建的之外）、登入異常警示與安全事件、CSP 與安全標頭、token 存在 localStorage 時的 XSS 風險、HTTPS 與反向代理、Allowed_Hosts、信任的代理、`lm-server` 改用最低權限的資料庫角色（開發時以 `postgres` 連線）、縮短 JWT 有效時間、Realtime 只允許私有頻道的租戶設定、移除 PostgREST、秘密掃描與 DAST。

## Dependencies

| 類別 | 項目 | 用途 |
|---|---|---|
| 工具 | Rust stable、`wasm32-unknown-unknown`、rustfmt、clippy（`rust-toolchain.toml`） | 編譯 |
| 工具 | trunk | 建置與開發伺服器（`lm-web`） |
| 工具 | Supabase CLI、Docker Desktop（WSL2） | 本機 Supabase 堆疊與遷移 |
| 工具 | Bun（已有） | 只用於一次性的 `scripts/export-art.mjs` |
| `lm-core` | serde、serde_json、serde_with、uuid（v4、serde，wasm 加 `js`）、chrono（不含 clock）、unicode-normalization、regex、indexmap、thiserror；dev：proptest | 型別與規則 |
| `lm-supabase` | serde_json；feature `server`：reqwest、jsonwebtoken、tokio、async-trait；feature `web`：wasm-bindgen、web-sys（WebSocket、MessageEvent、CloseEvent）、gloo-timers | 用戶端 |
| `lm-server` | axum 0.8（ws）、tokio、tower-http（fs、trace）、sqlx 0.8（postgres、runtime-tokio、uuid、chrono、json）、tokio-tungstenite、futures-util、sha2、rand、hex、tracing、tracing-subscriber、dotenvy | 服務 |
| `lm-web` | leptos 0.8（csr）、leptos_router 0.8、wasm-bindgen、web-sys、js-sys、gloo-net、gloo-timers、gloo-storage、uuid（js） | 前端 |
| 服務 | Supabase：PostgreSQL、Auth、Realtime、API gateway；Studio 與 postgres-meta（開發用） | 平台 |
| 設定 | `.cargo/config.toml` 為 wasm32 加上 `--cfg getrandom_backend="wasm_js"`（getrandom 0.3 的瀏覽器後端） | 產生 UUID |

版本在建立 workspace 時鎖在 `Cargo.lock`；Supabase 各服務的映像版本由使用的 CLI 版本決定，README 記錄 `supabase --version`。

## 風險與緩解

| 編號 | 風險 | 影響 | 緩解 |
|---|---|---|---|
| R1 | 沒有官方 Rust 用戶端；自寫的 Realtime 協定實作可能跟不上改版 | 連線或授權失敗 | 協定集中在 `lm-supabase::realtime::protocol`，以文件範例做單元測試；`RealtimeTransport`、`AuthBackend` 兩個 trait 讓之後可以換成成熟的 crate |
| R2 | 自架或 CLI 的 Realtime 版本不支援 Broadcast from Database、私有頻道授權或 presence 的某些行為 | 推送或 presence 無法使用 | 第一個實作任務先以兩個瀏覽器確認 `realtime.send()` 與 RLS 政策可運作；鎖定 CLI 版本 |
| R3 | GoTrue 拒收合成 email 的網域（GoTrue 有網域格式檢查，例如 [supabase/auth #2252](https://github.com/supabase/auth/issues/2252) 回報 `a@a.com` 被拒） | 無法註冊 | `LM_AUTH_EMAIL_DOMAIN` 可設定；第一個實作任務先實測；備選為 email 登入（待確認 1） |
| R4 | Presence 每 30 秒 5 次的限制 | 「誰正在編輯」延遲數秒；超過時頻道被關閉 | 卡片或列層級的目標、6.5 秒最小間隔（屬性 14） |
| R5 | Leptos 0.8 的 API 仍在演進 | 升級時要改程式 | 鎖定版本；畫面元件與同步引擎分開，引擎不依賴 Leptos 以外的反應式細節 |
| R6 | 重用現有 CSS 要求 DOM 結構相同 | 版面跑掉 | 元件照抄現行模板的結構與 class；逐頁以眼睛比對 Bun 版 |
| R7 | NFKC、空白與小寫的細節和 JavaScript 不完全相同 | 採買同步結果與舊版不同 | golden 測試移植自現行測試；Property 17 |
| R8 | Windows 的 Docker 綁定與保留埠 | 無法啟動，或意外開放到區網 | 文件化 `docker network create` 與 `netsh` 檢查；以 `docker ps` 確認 127.0.0.1 |
| R9 | broadcast 最多送達一次，且沒有連線者時會被丟棄 | 畫面暫時不是最新 | 水位線、跳號偵測、`head` 比對與重連後補齊（B7）；正確性不依賴推送 |
| R10 | JWT 在登出或失去權限後仍有效到過期（預設 1 小時） | 撤銷延遲 | v1 接受；資安工作流再縮短有效時間 |
| R11 | 每個命令重讀整趟旅行 | 大旅行時延遲增加 | 預估仍在數十毫秒；必要時加入以 `(trip, seq)` 為鍵的快取 |
| R12 | 一次性的插畫輸出依賴現有 JavaScript | 之後改插畫要重新輸出 | 輸出結果提交進版本庫；之後若要改插畫，再決定是否把產生器移植成 Rust |

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
| GoTrue 的密碼 72 字元上限 | [Supabase Discussion #34207](https://github.com/orgs/supabase/discussions/34207) |
| GoTrue 的 email 網域格式檢查 | [supabase/auth #2252](https://github.com/supabase/auth/issues/2252) |
| Leptos + Supabase 的 CSR 範例（以 REST 呼叫 GoTrue） | [leptos-community/csr-example-leptos-supabase](https://github.com/leptos-community/csr-example-leptos-supabase) |
| 社群 Realtime crate 的實作方式與成熟度 | [scaraude/supabase-realtime-rs](https://github.com/scaraude/supabase-realtime-rs) |
| trunk 的 `[[proxy]]` 與 `ws = true`、`serve.addresses` 預設 127.0.0.1 | [trunk 的 Trunk.toml 範例](https://github.com/trunk-rs/trunk/blob/main/Trunk.toml) |
| Leptos 0.8 的 `<For>` 與 stores | [leptos-rs/leptos v0.8.14](https://github.com/leptos-rs/leptos/tree/v0.8.14) |
