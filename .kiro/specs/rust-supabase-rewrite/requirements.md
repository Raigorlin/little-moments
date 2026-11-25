# Requirements Document

## Introduction

本功能把「日子拾光 / LITTLE MOMENTS」的帳號版全面改寫成 Rust，資料、登入與即時推送改用自架的 Supabase（PostgreSQL、Auth、Realtime）。設計已完成並經使用者確認（`design.md`）；本文件由設計推導，範圍是設計所稱的「第一版」。工作在分支 `rust-supabase-rewrite` 進行。

現在每趟旅行存成一個 `trips.state_json` 文字欄位加一個版本號。任何寫入（包括一個勾選）都要帶最新的版本號，兩個人改不同項目也會互相擋住（409「旅行已有更新，請重新載入後再勾選。」），衝突時要先匯出、再重新載入合併。其他人的變更只能靠行程表分頁每 3 秒一次的輪詢發現，之後整份重抓、整頁重繪。使用者最在意的是料理菜單：修改與勾選要不需重新載入就出現在其他成員的畫面上。

第一版的做法：

- Trip_State 以「一個項目一列」存在 PostgreSQL。每次提交產生一個依序編號的 Change_Set，在同一個資料庫交易中推送到這趟旅行的 Realtime 私有頻道。
- 所有寫入與商業規則都在 Rust：LM_Server 是唯一的寫入者；規則放在不做 IO 的共用程式庫 LM_Core，LM_Web 以同一份程式做表單檢查與樂觀更新。
- LM_Web 以 Leptos 的細粒度反應式、以列 id 為鍵，只重繪有變更的項目。
- 以 Realtime 的 Presence 在被編輯的卡片或列上顯示編輯者的圓形頭像，作為提示性的鎖定。

文中「現行」指 Bun_App 的行為。Bun_App 留在原處作為行為參考；第一版從空資料庫開始，只在開發機的 Local_Stack 上執行。開發機是 Windows：cargo、trunk、Docker Engine 與 Supabase CLI 都在 WSL 2（Ubuntu）中執行，瀏覽器與 git 留在 Windows（需求 2.10）。「Property N」指 design.md「Correctness Properties」中的屬性。

### 使用者已確認的事項

| 編號 | 事項 | 來源 |
| --- | --- | --- |
| U1 | 全部以 Rust 改寫：Rust 伺服器，加上以 Leptos 編譯成 WebAssembly 的前端，使用自架的 Supabase（Auth、Realtime、PostgreSQL）。 | 使用者對本 spec 的範圍指示 |
| U2 | 第一版不含 CI/CD、資安強化工作流與 QA 測試套件（e2e、Lighthouse、資安測試）。保留幾項本來就是核心行為或不需成本的項目：在伺服器與 RLS 強制旅行成員資格、本機 Supabase 的埠只綁 127.0.0.1、在非 loopback 位址拒絕使用範例金鑰。 | 使用者對本 spec 的範圍指示 |
| U3 | 要解決的核心問題：料理菜單的修改與勾選不需重新載入就出現在其他成員的畫面上（區網內目標 2 秒內）；只重繪有變更的項目；編輯不同項目永遠不衝突；不再有「匯出再重新載入合併」；重新連線後不漏掉任何變更。 | 使用者對本 spec 的範圍指示 |
| U4 | 登入沿用「帳號名稱 + 密碼」，以合成 email 對應到 Supabase Auth。 | design.md「已確認的問題」1 |
| U5 | 分帳記帳（支出、還款、餘額與建議轉帳）在第一版；收據 AI 不在第一版。 | design.md「已確認的問題」2 |
| U6 | 「誰正在編輯」採提示性的鎖定，可以選「仍要編輯」。以圓形頭像顯示，頭像內是帳號顯示名稱的第一個字素叢集（例如「陳小明」顯示「陳」）；最多 3 個頭像加「+N」；無障礙名稱例如「陳小明 正在編輯」；開啟表單時另以文字提示誰正在編輯。 | design.md「已確認的問題」3 |
| U7 | 文字版相對於行程繪本文字版的兩處格式改變：活動備註另起一行；抵達行由「預計幾點抵達」產生。 | design.md「已確認的問題」4 |
| U8 | 文字版維持現在的格式：與現行行程繪本「複製文字」複製的文字相同（`src/storybook/app.js` 的 `renderItinerary()` 與 `copyItinerary()`），包括依每日設定的路線位置把路線放在活動之前或之後；與現行的差異只有 U7 的兩處。 | 使用者看過 design.md A10 與現行格式的差異後的決定「維持現在的格式」 |

### 必要行為與需求的對應

design.md 以 B1–B12 描述必要行為，下表列出驗收這些行為的需求。

| 編號 | 行為 | 需求 |
| --- | --- | --- |
| B1 | 一位成員的變更不需重新載入就出現在同一趟旅行其他成員的畫面上；區網內目標 2 秒內。 | 10 |
| B2 | 只重繪有變更的項目。 | 14、16 |
| B3 | 編輯不同項目永遠不衝突；同一欄位依提交順序決定；每位成員最後看到相同結果。 | 7、12 |
| B4 | 勾選是冪等的集合操作：送出想要的狀態，不是切換。 | 7 |
| B5 | 料理食材到採買品項的衍生資料只在伺服器計算，不刪除手動管理或已買的品項。 | 25 |
| B6 | 旅行成員資格與權限在伺服器與 Realtime 頻道強制。 | 6、11 |
| B7 | 斷線、訊息遺失或分頁休眠之後補齊，不漏掉任何變更。 | 11、12 |
| B8 | 樂觀更新：立即反映在畫面上；伺服器拒絕時回復並顯示原因。 | 13 |
| B9 | 在被編輯的卡片或列上顯示編輯者的圓形頭像。 | 15、16 |
| B10 | 文字版由資料決定性產生，可以一鍵複製。 | 31 |
| B11 | 外觀沿用現有的插畫、字型與樣式。 | 32 |
| B12 | 本機 Supabase 的埠只綁 127.0.0.1；可能被其他機器連到時不使用範例金鑰。 | 2 |

### 第一版的範圍

第一版包含：註冊、登入與登出；旅行列表、建立、編輯與刪除；旅伴與車輛；地點清單；邀請連結；行程表的規劃行程與文字版；料理菜單；採買清單；裝備分工；出發清單；分帳記帳（支出、還款、餘額與建議轉帳）；誰正在編輯（Presence 與編輯者頭像）。

### 範圍外

- 收據 AI（OpenAI）。
- 管理後台與稽核紀錄；第一版的 Admin 只有「可以管理任何旅行」的權限。
- 註冊政策的設定畫面（第一版以環境變數 `LM_PUBLIC_SIGNUP` 代替）、重設密碼與寄送 email。
- `/demo/` 離線本機版與 Service Worker；關閉分頁之後保留尚未送出的變更（第一版的 Pending_Command 只存在記憶體中）。
- 匯出、匯入與列印。
- 行程圖（動畫海報）、行程繪本、場景動畫與每日小語。
- 小隊最近的動態。
- 淺色／深色主題的切換按鈕與手機的滑動手勢。
- 旅行列表的即時更新；第一版只有 Trip_Page 與 Departure_Page 即時同步。
- 移除旅行成員（解除 Account 與 Person 的綁定）與帳號管理。
- 從現行 PostgreSQL 搬移資料。
- 自架 Docker Compose 的部署，以及讓其他機器（區網或網際網路）連到 LM_Server；第一版只在開發機上執行，因為 Local_Stack 使用 Sample_Secrets（需求 2.6）。
- CI/CD；資安強化工作流（例如 Auth_Service 內建之外的速率限制、CSP 與安全標頭、HTTPS 與反向代理、最低權限的資料庫角色、縮短 access token 的有效時間）；QA 測試套件（e2e、Lighthouse、資安測試、資料庫整合測試），以及 LM_Server 與 LM_Web 的自動化測試。

### 與現行版的差異

| 項目 | 現行 | 第一版 | 需求 |
| --- | --- | --- | --- |
| 同時編輯 | 整趟旅行一個版本號；兩人改不同項目也會 409，衝突時要先匯出再重新載入合併 | 一個項目一列、依提交順序執行；編輯不同項目不衝突，同一欄位以後提交者為準 | 7、8 |
| 其他成員的變更 | 行程表分頁每 3 秒輪詢，有新版本就整份重抓、整頁重繪 | 每個分頁即時推送，斷線後補齊；只重繪變更的項目 | 10、12、14 |
| 密碼長度 | 12–128 字 | 12–72 個字元，而且 UTF-8 不超過 72 位元組（Auth_Service 以 bcrypt 儲存密碼） | 3 |
| 登入狀態 | HttpOnly cookie `ggc_session` | access token 與 refresh token 存在 localStorage | 4、5 |
| 第一位管理員 | `/setup` 頁面 | 空資料庫上註冊的第一個帳號 | 3 |
| 誰正在編輯 | 只在行程繪本、欄位層級、每 3 秒輪詢；欄位下方顯示「{顯示名稱} 正在編輯」 | 所有分頁的卡片或列層級，最多每 6.5 秒更新一次；圓形頭像，可以選「仍要編輯」 | 15、16 |
| 打包勾選 | 伺服器允許管理者以整份 PUT 修改別人的打包狀態（介面沒有這個操作） | 每個人只能勾自己的 | 6、27 |
| 移除旅伴 | 介面沒有這個操作 | Trip_Manager 可以移除沒有綁定帳號、沒有帳目的旅伴 | 19 |
| 文字版 | 行程繪本的「文字版完整行程」由畫面擷取：活動與料理的備註直接接在同一行的最後，抵達行是繪本的自由文字 | 由 LM_Core 從資料產生，格式不變，只有兩處改變：不是空白的備註在那筆活動或料理的下一行；抵達行由預計抵達時間產生 | 31 |
| 沒有加入旅行的 Admin 看分帳 | 讀不到 | API 仍讀不到；推送中的帳目由 LM_Web 丟棄；Ledger_Tab 顯示「你不是這趟旅行的旅伴，無法查看或記錄分帳。」 | 6、29 |
| 車輛的舊出發欄位 `meeting`，以及行程繪本專用的欄位 | 有 | 沒有 | 無 |
| 網址 | `/<帳號名稱>/home`、`/<帳號名稱>/trips/<id>` | 相同；出發清單為 `/<帳號名稱>/trips/<id>/go` | 32 |

### 權限表

「管理者」是 Trip_Manager，「受邀旅伴」是 Collaborator。不是 Trip_Member 也不是 Admin 的 Account，對下列每一項都得到 404「找不到這趟旅行。」。表中「403（刪除）」的訊息為「受邀旅伴可以編輯，但不能刪除既有項目；請聯絡主辦人或管理員。」。

| 操作 | Trip_Manager | Collaborator | 其他規則 |
| --- | --- | --- | --- |
| 開啟旅行、讀取 Snapshot、增量的 Change_Set 與 Head、加入 Trip_Channel | 可以 | 可以 | |
| 編輯 Trip_Card | 可以 | 可以 | |
| 刪除旅行 | 可以 | 403「受邀旅伴可以編輯旅行，但只有主辦人或管理員可以刪除。」 | |
| 新增旅伴 | 可以 | 可以 | |
| 修改旅伴 | 可以 | 只能修改沒有綁定 Account 的旅伴與自己；修改其他綁定的旅伴時 403「只能修改自己的旅伴資料。」 | |
| 移除旅伴 | 可以 | 403（刪除） | 綁定 Account 的旅伴 409；仍有帳目提到他 409（需求 19） |
| 新增、修改車輛 | 可以 | 可以 | |
| 刪除車輛 | 可以 | 403（刪除） | 仍有路線或被活動指定 409（需求 20） |
| 新增、改名、刪除地點 | 可以 | 可以 | 使用中的地點不能刪除 409（需求 21） |
| 儲存與刪除路線、儲存每日設定 | 可以 | 可以 | |
| 新增、修改與刪除活動，勾選活動完成 | 可以 | 可以 | |
| 新增、修改料理，從料理移除食材 | 可以 | 可以 | |
| 刪除料理 | 可以 | 403（刪除） | |
| 新增、修改採買品項，勾選已買 | 可以 | 可以 | Collaborator 取消已買的 Meal_Item 時，品項改為 Manual_Item |
| 刪除採買品項 | 可以 | 403（刪除） | Shopping_Sync 自動移除的品項不算刪除 |
| 新增、修改裝備 | 可以 | 可以 | |
| 刪除裝備 | 可以 | 403（刪除） | |
| 打包勾選、確認出發 | 只能變更自己的 | 只能變更自己的 | 變更其他旅伴的 403「只能變更自己的行前準備。」 |
| 新增、修改支出與還款 | 有 Bound_Person 時可以 | 可以 | Unbound_Admin 404「找不到這趟旅行。」 |
| 刪除支出與還款 | 有 Bound_Person 時可以 | 403「受邀旅伴可以新增或修改帳目，但不能刪除既有帳目；請聯絡主辦人或管理員。」 | Unbound_Admin 404「找不到這趟旅行。」 |
| 建立邀請連結 | 可以 | 可以 | 每趟旅行最多 20 個 Active_Invite；Collaborator 自己建立的最多 5 個 |
| 列出邀請連結 | 全部 | 只有自己建立的 | |
| 撤銷邀請連結 | 可以 | 只能撤銷自己建立的；撤銷別人建立的 403「只有建立連結的人、主辦人或管理員可以撤銷邀請。」 | |

### 列舉值

| 名稱 | 值 |
| --- | --- |
| 封面 | camp、mountain、lake、night、forest、beach、sunrise |
| 旅行狀態 | planning（規劃中）、completed（已完成） |
| 旅伴顏色 | coral、blue、green、yellow、lavender、peach |
| 帳號角色 | admin、member |
| 活動類別 | meet 集合、market 採買、camp 營地時光、meal 用餐、night 夜晚、travel 移動、wake 起床、pitch 搭帳、free 自由活動、tea 下午茶／遊戲、strike 拆帳、clean 清潔、return 返程 |
| 停靠點種類與任務 | 採買（shop）：採買（shopping，預設）。接送（pickup）：接人（passenger-pickup，預設）、送人下車（passenger-dropoff）。取還裝備（gear）：領取租借裝備（gear-pickup，預設）、歸還裝備（gear-return）。其他（other）：取租車（car-rental）、還車（car-return）、一般停靠（waypoint，預設） |
| 路線位置 | 路線在活動之前（before，預設）、路線在活動之後（after） |
| 餐次與預設用餐時間 | 早餐 08:30、午餐 12:00、下午茶 15:00、晚餐 18:00、消夜 21:00 |
| 料理插圖種類 | hotpot、bbq、toast、curry、pasta、breakfast、salad、custom（通用餐盤，有 7 種變化） |
| 採買分類 | 肉類、海鮮、蔬菜、水果、蛋奶、豆製品、主食、調味料、飲料、零食、其他 |
| 裝備範圍 | personal（個人，每位旅伴各帶一份）、shared（共用，由一位負責人準備） |
| 支出分類 | 食材、交通、住宿、其他、「食材／{採買分類}」（11 種）、露營耗材、露營裝備、日用品 |

### 上限表

字數一律以 Char_Count 計算。

| 項目 | 上限 |
| --- | --- |
| 旅行天數 | 1–31 天 |
| 旅行名稱、目的地、介紹、小叮嚀 | 1–100、0–100、0–1000、0–1000 字 |
| 旅伴 | 100 位；名字 1–30 字、角色 0–60 字 |
| 地點 | 100 個；名稱 1–50 字 |
| 車輛 | 名稱 1–50 字；座位 1–9（含駕駛） |
| 路線 | 每台車每天 1 條；每條 0–6 個停靠點；停靠點備註 0–100 字 |
| 每日設定 | 標題 0–20 字 |
| 活動 | 1000 筆；標題 1–100、地點 0–150、備註 0–1000 字 |
| 料理 | 1000 道；份數 1–100；名稱 0–100、食材 0–2000（切出的每個食材名稱 1–100）、備註 0–1000 字 |
| 採買品項 | 1000 項；名稱 1–100、數量 0–40 字（修改既有品項時數量 1–40 字） |
| 裝備 | 1000 項；名稱 1–100、數量 0–40 字 |
| 支出、還款 | 各 1000 筆；金額 NT$0.01–1,000,000；支出標題 1–100 字；備註 0–500 字；每筆支出分攤 1–100 位 |
| 邀請連結 | 7 天後到期；每趟旅行 20 個 Active_Invite；Collaborator 每人 5 個 Active_Invite |
| 帳號名稱、顯示名稱、密碼 | 3–32、1–30、12–72 個字元（密碼的 UTF-8 編碼不超過 72 位元組） |
| 編輯者頭像 | 每張卡片或每一列最多 3 個，其餘以「+N」表示；色盤 12 色 |

## Glossary

- **Bun_App**：現行的 Bun 版程式（`src/`、`server/`、`migrations/`、`tests/`、`package.json` 等），保留在原處作為行為參考。
- **Repository**：分支 `rust-supabase-rewrite` 上的專案內容。
- **Branch_Point**：分支 `rust-supabase-rewrite` 的起點，也就是 `main` 的 commit 1b925a7。
- **Cargo_Workspace**：Repository 根目錄 `Cargo.toml` 定義的 Rust workspace。
- **README**：Repository 中說明第一版開發與確認方式的 `README.md`。
- **LM_Core**：`crates/core` 的 `lm-core`，伺服器與前端共用、不做 IO 的規則程式庫。
- **LM_Supabase**：`crates/supabase` 的 `lm-supabase`，自寫的精簡 Supabase 用戶端，包含 Realtime 協定、Auth_Service 的 REST 呼叫與 access token 的驗證。
- **LM_Server**：`crates/server` 的 `lm-server`（執行檔 `little-moments-server`），以 axum 撰寫的後端服務。
- **LM_Web**：`crates/web` 的 `lm-web`，以 Leptos 編譯成 WebAssembly、在瀏覽器中執行的前端。
- **Supabase_Stack**：自架的 Supabase 服務：Database、Auth_Service、Realtime_Service 與 API gateway。Studio 與 postgres-meta 只供開發時檢視資料；PostgREST 隨堆疊提供，App 不使用。
- **Local_Stack**：以 Supabase CLI（`supabase start`）在開發機上啟動的 Supabase_Stack；第一版只在 Local_Stack 上執行。
- **Database**：Supabase_Stack 的 PostgreSQL。
- **Auth_Service**：Supabase_Stack 的 Auth（GoTrue），負責帳號、密碼，以及 access token 與 refresh token 的簽發與換發。
- **JWKS**：Auth_Service 在 `{SUPABASE_URL}/auth/v1/.well-known/jwks.json` 公開的 JSON Web Key Set，列出 ES256 的公鑰，每一把以 `kid` 識別。
- **Realtime_Service**：Supabase_Stack 的 Realtime，提供私有頻道、由 Database 發出的 broadcast，以及 presence。
- **Migrations**：`supabase/migrations` 中的 SQL 遷移檔。
- **Loopback_Address**：`127.0.0.0/8` 與 `::1` 的位址。
- **Sample_Secrets**：Supabase CLI 公開的範例 JWT 密鑰、anon key 與 service_role key。
- **Account**：一個帳號，由 Auth_Service 的一位使用者，加上 Database `app.profiles` 的一列（帳號名稱、Display_Name 與角色 admin 或 member）組成。
- **Admin**：角色為 admin 的 Account。第一版的 Admin 只多一項權限：可以管理任何旅行。
- **Display_Name**：Account 的顯示名稱（`app.profiles.display_name`），Char_Count 為 1–30。
- **Synthetic_Email**：Account 在 Auth_Service 的 email，格式為 `<帳號名稱>@<LM_AUTH_EMAIL_DOMAIN>`；App 不寄出任何郵件。
- **Session**：登入狀態：access token、refresh token、到期時間，以及 Account 的 id、帳號名稱、Display_Name 與角色。
- **Valid_Access_Token**：宣告與 Account 符合需求 5.2、簽章符合需求 5.3 與 5.4 的 access token。
- **Public_Endpoint**：不需要 access token 的四個 `/api/*` 端點：`POST /api/auth/signup`（註冊）、`POST /api/auth/login`（登入）、`POST /api/auth/refresh`（換發 Session）與 `GET /api/invites/{token}`（邀請預覽）。
- **Trip_State**：一趟旅行的全部內容：Trip_Card、旅伴、車輛、地點、路線（含停靠點）、每日設定、活動、料理、採買品項、裝備、出發確認、支出（含分攤旅伴）與還款。
- **Trip_Card**：旅行資料：名稱、目的地、起訖日期、介紹、小叮嚀、封面與狀態。
- **Trip_Content_Table**：存放 Trip_State 中 Trip_Card 以外內容的資料表：需求 8.1 的旅伴、車輛、地點、路線、停靠點、每日設定、活動、料理、採買品項、裝備、出發確認、支出與還款的資料表，以及需求 8.2 的子表。
- **Trip_Day**：旅行日期範圍內的一天，從開始日起依序稱為第 1 天、第 2 天，以此類推。
- **Person**：一趟旅行中的一位旅伴。
- **Bound_Person**：綁定某個 Account 的 Person；一個 Account 在一趟旅行中最多綁定一位 Person。
- **Trip_Member**：在這趟旅行有 Bound_Person 的 Account。
- **Trip_Owner**：建立這趟旅行的 Account。
- **Trip_Manager**：這趟旅行的 Trip_Owner 與每一位 Admin，也就是文中的「管理者」。
- **Collaborator**：不是 Trip_Manager 的 Trip_Member，也就是文中的「受邀旅伴」。
- **Unbound_Admin**：在這趟旅行沒有 Bound_Person 的 Admin。
- **Permission_Table**：前言的「權限表」。
- **Limits_Table**：前言的「上限表」。
- **Enum_Table**：前言的「列舉值」表。
- **Command**：用戶端送給 LM_Server 的一次 Trip_State 修改，例如新增料理或勾選已買（design.md 1.3）。
- **Command_Id**：LM_Web 為每個 Command 產生的 UUID，用來辨識重送的 Command。
- **Check_Command**：勾選類的 Command：已買（`SetShoppingPurchased`）、已打包（`SetGearPacked`）、確認出發（`SetDeparted`）與活動完成（`SetActivityDone`）；每個都指定要設定的值。
- **Command_Executor**：LM_Server 執行 Command 的流程：鎖住這趟旅行、以 Command_Id 查重、判斷權限、以 LM_Core 驗證並計算效果、寫入並提交（design.md A1）。
- **Primary_Effect**：Command 本身造成的列變化。
- **Derived_Effect**：Shopping_Sync 因 Command 而造成的採買品項變化，以及因 Shopping_Sync 移除採買品項而依需求 29.13 清除的支出採買連結。
- **Seq**：一趟旅行的提交序號：每次有變化的提交加 1，從 1 開始、連續、不跳號。
- **Row_Version**：一列最後一次被修改（包括刪除）時的 Seq。
- **Ordinal**：一列在這趟旅行中的建立順序，由 LM_Server 指定，取代現行陣列的順序。
- **Change_Set**：一次提交的全部變化：旅行 id、Seq、Command_Id、提交者、提交時間、每一列的新內容或刪除，以及旅行是否已刪除（`trip_deleted`）。
- **Change_Log**：Database 的 `app.trip_changes`，每次提交保存一列 Change_Set。
- **Change_Feed**：一趟旅行依 Seq 排列的全部 Change_Set：保存在 Change_Log，經 Trip_Channel 推送，也可以用 `GET /api/trips/{id}/changes?after=<Seq>` 補抓。
- **Trip_Channel**：Realtime_Service 中這趟旅行的私有頻道 `trip:<旅行 id>`。
- **Thin_Notice**：Change_Set 太大時改送的推送，只含旅行 id 與 Seq。
- **Head**：一趟旅行最新的 Seq。
- **Snapshot**：某個 Seq 當下的完整 Trip_State，加上檢視者的 Account 資料與權限。
- **Replica**：LM_Web 中只含已提交變化的 Trip_State，以及它的 Watermark。
- **Watermark**：使 Seq 1 到 w 的 Change_Set 都已反映在 Replica 的最大 w。
- **Pending_Command**：LM_Web 已在畫面上預測、但還沒得到 LM_Server 回應的 Command。
- **Optimistic_View**：畫面顯示的 Trip_State：Replica 依序疊上每個 Pending_Command 的 Primary_Effect。
- **Remote_Change**：使 Optimistic_View 中至少一列的內容（不計 Row_Version）改變、而且不是由這個瀏覽器分頁的 Pending_Command 造成的變化。它包括兩種：Command_Id 不屬於這個瀏覽器分頁任何 Pending_Command 的 Change_Set（包括同一個 Account 在其他瀏覽器分頁或裝置提交的 Change_Set，以及其中的 Derived_Effect），以及 Snapshot 帶來的變化。
- **Presence**：Realtime_Service 在 Trip_Channel 上回報「誰在線上、正在編輯什麼」的功能。
- **Presence_Meta**：每個分頁在 Presence 回報的內容：Account id、Display_Name、Bound_Person，以及 Edit_Target（沒有正在編輯時為空）。
- **Presence_Key**：一個瀏覽器分頁加入 Trip_Channel 時附上的 presence key，由 LM_Web 以隨機 UUID 產生；不同的瀏覽器分頁不使用相同的 Presence_Key。Realtime_Service 以 Presence_Key 區分每個分頁的 Presence_Meta。
- **Editable_Item**：可以開啟表單編輯的卡片或列：路線卡片、每日設定、活動、料理、採買品項、裝備、支出、還款、旅伴、車輛、地點與 Trip_Card（編輯旅行）。
- **Edit_Target**：正在編輯的那一個 Editable_Item。
- **Presence_Throttle**：LM_Core 中限制 Presence 送出頻率的節流器。
- **Editor_Avatar**：代表一位編輯者的圓形頭像。
- **Avatar_Initial**：Editor_Avatar 上的字。
- **Avatar_Palette**：12 色的頭像色盤（design.md 1.7 的 `AVATAR_PALETTE`），每一色有底色與文字色。
- **Editor_Stack**：一個 Edit_Target 上的頭像堆疊：最多 3 個 Editor_Avatar，加上表示其餘人數的「+N」。
- **Editing_Notice**：開啟表單時，在表單上方說明誰正在編輯這一項的文字。
- **Grapheme_Cluster**：Unicode UAX #29 定義的擴充字素叢集（extended grapheme cluster）。
- **Trim_White**：去除前後的 Unicode White_Space 字元，包括全形空白、換行與 Tab（現行 `trimWhite()`）。
- **Char_Count**：以 Unicode 碼位計算的字數，與現行的 `[...text].length` 及 PostgreSQL 的 `char_length()` 相同；文中的「字」與「字元」都以 Char_Count 計算。
- **Hidden_Control_Char**：Unicode 一般類別為 Cc 或 Cf 的字元，但連接兩個 emoji 的零寬連接符 U+200D 除外，也就是前面是 Unicode 的 Extended_Pictographic 字元（中間最多依序隔著一個變體選擇符與一個膚色修飾符）、後面緊接 Extended_Pictographic 字元的 U+200D（現行 `hasControlChars()`）。
- **JS_Whitespace**：現行 JavaScript 的 `\s` 與 `trim()` 所稱的空白：Unicode 一般類別 Zs 的字元（U+0020、U+00A0、U+1680、U+2000–U+200A、U+202F、U+205F、U+3000），以及 U+0009–U+000D、U+2028、U+2029 與 U+FEFF；不包括 U+0085。
- **Participant_Name**：旅伴名字與角色的正規化：NFKC、去除前後的 JS_Whitespace，並把內部連續的 JS_Whitespace 換成一個半形空格（現行 `normalizeParticipantName()`）。
- **Participant_Key**：比較旅伴名字的鍵：Participant_Name 之後移除 Default_Ignorable_Code_Point，再轉成小寫（現行 `participantKey()`）。
- **Place_Key**：比較地點名稱的鍵：Trim_White、只對 U+3000 與 U+FF01–U+FFEE 做 NFKC、整串做 NFC，再把 A–Z 轉成小寫（現行 `placeKey()`）。
- **Time_Value**：24 小時制的時刻 `HH:MM`（00:00–23:59）；輸入時先 Trim_White，再把全形數字與全形冒號換成半形（現行 `normalizeTimeInput()`）。
- **Car_Palette**：車輛的預設色盤，沿用現行 `CAR_PALETTE` 的 8 個顏色與原本的順序（索引 0–7）。
- **Destination_Place**：代表旅行目的地的地點選項；旅行目的地是空白時不能使用。
- **Day_Place**：一個 Trip_Day 的地點：每日設定的地點；沒有設定時為非空白的旅行目的地；兩者都沒有時，這一天沒有 Day_Place。
- **Place_Usage**：地點在某個 Trip_Day 的一個使用處：那一天的每日設定以這個地點為地點時，用途為「這一天的地點」；某台車那一天的路線以這個地點為起點、終點或任一停靠點時，用途為那台車的名稱，同一天同一台車只算一個。活動的地點是另外輸入的文字，不算 Place_Usage。
- **Shopping_Stop**：種類為採買的停靠點。
- **Activity_Preset**：可以勾選加入的常用活動，由現行 `presetsFor()` 依第一天、中間的日子、最後一天與一日遊提供。
- **Person_Activity**：一位旅伴參加的活動：參加者為全體旅伴、指定旅伴中有他，或指定車輛中至少有一台以他為駕駛或乘客（現行 `activityForPerson()`）。
- **Meal_Item**：由 Shopping_Sync 從料理食材產生的採買品項（來源為 meal）。
- **Manual_Item**：手動管理的採買品項（來源為 manual）。
- **Linked_Item**：至少連動一道料理的採買品項。
- **Shopping_Sync**：由料理的食材同步採買品項的計算（現行 `syncMealIngredients()`；design.md A3）。
- **Ingredient_Parser**：從食材文字切出食材名稱的規則（現行 `parseIngredients()`；design.md A4）。
- **Ingredient_Key**：比較食材名稱的鍵：NFKC、移除所有 JS_Whitespace，再轉成小寫（現行 `parseIngredients()` 使用的 `keyOf()`）。
- **Ingredient_Classifier**：決定食材屬於哪一種採買分類的規則（現行 `classifyIngredient()`）。
- **Shopping_Plan**：由採買品項的負責人與車輛推導的採買安排（現行 `shoppingPlan()`）：品項列在負責人所在車輛（依車輛順序，第一台以他為駕駛或乘客的車）最早的 Shopping_Stop，也就是日期最早、同一天在路線上最前面的那一個。
- **Unassigned_Shopping**：Shopping_Plan 無法分到任何 Shopping_Stop 的採買品項（「未分配採買清單」），包括負責人為待分配、負責人不在任何車上，以及那台車沒有 Shopping_Stop 的品項。
- **My_Gear**：一位旅伴的裝備：所有個人裝備，加上他負責的共用裝備（現行 `myGear()`）。
- **Can_Depart**：一位旅伴可以確認出發的條件：My_Gear 都已打包，而且沒有未分配負責人的共用裝備（現行 `canDepart()`）。
- **Gear_Progress**：全隊的裝備準備進度 done / total（現行 `progress()` 的裝備部分）：total 是個人裝備數乘以旅伴人數，再加上共用裝備數；done 是每個個人裝備已打包的旅伴數的總和，再加上負責人已打包的共用裝備數。待分配的共用裝備計入 total、不計入 done；沒有裝備時為 0 / 0。
- **Packing_Progress**：一位旅伴的打包進度：已打包項數（他的 My_Gear 中打包勾選有他的項數）、My_Gear 的項數，以及百分比（已打包項數除以 My_Gear 項數與 1 中較大者，乘以 100 後四捨五入到整數）；沒有 My_Gear 時為 0 / 0 與 0%（現行 `readyCount()` 與出發清單的進度條）。
- **Ledger_Rows**：支出、支出的分攤旅伴與還款。
- **Retime**：旅行日期改變時搬動路線、每日設定、活動與料理的規則（現行 `retimeByDayIndex()`；design.md A9）。
- **Itinerary_Text**：依需求 31 由 Trip_State 產生、可以複製的純文字行程（文字版），格式與現行行程繪本「複製文字」複製的文字相同，只有 U7 的兩處改變（前言 U8）。
- **Home_Page**：`/<帳號名稱>/home`，旅行列表與建立旅行。
- **Trip_Page**：`/<帳號名稱>/trips/<id>`，旅行頁。
- **Departure_Page**：`/<帳號名稱>/trips/<id>/go`，出發清單。
- **Invite_Page**：`/invite/<token>`，邀請預覽、以連結註冊與加入旅行。
- **In_App_Path**：可以作為 `/login` 的 `next` 的 App 內路徑：Invite_Page、Home_Page、Trip_Page（可以帶 `?tab=<分頁>`）或 Departure_Page 的路徑（需求 32.1），其中的帳號名稱符合需求 3.2 的格式；只以一個 `/` 開頭，不含 scheme、主機、`//` 或 `\`。
- **Schedule_Tab**：Trip_Page 的「行程表」分頁。
- **Menu_Tab**：Trip_Page 的「料理菜單」分頁。
- **Shopping_Tab**：Trip_Page 的「採買清單」分頁。
- **Gear_Tab**：Trip_Page 的「裝備分工」分頁。
- **Ledger_Tab**：Trip_Page 的「分帳記帳」分頁。
- **Trip_Menu**：Trip_Page 旅行標題旁的旅行選單。
- **Toast**：沿用現行樣式與位置的短暫提示：每則訊息顯示 4.5 秒，新的訊息取代仍在顯示的訊息；螢幕閱讀器會讀出訊息，但不打斷正在朗讀的內容。
- **Invite_Link**：只能使用一次的邀請連結 `/invite/<token>`。
- **Active_Invite**：還沒使用、沒有撤銷、也還沒到期的 Invite_Link。

## Requirements

### Requirement 1: 以 Rust 與自架 Supabase 組成的程式

**User Story:** 身為維護這個 App 的開發者，我希望伺服器、前端與共用規則都以 Rust 撰寫，並使用自架的 Supabase，以便權限、驗證與衍生資料只有一份實作，由伺服器與瀏覽器共用。

#### Acceptance Criteria

1. THE LM_Server SHALL 以 Rust（axum 0.8、sqlx 0.8 與 tokio）實作成執行檔 `little-moments-server`，作為唯一寫入 Trip_State 與 Change_Log 的元件，並負責：驗證 access token；代理註冊、登入、換發 Session 與登出；回傳目前的 Account 與旅行列表；建立與刪除旅行；以 Command_Executor 執行 Command；提供 Snapshot、增量的 Change_Set 與 Head；建立、列出與撤銷 Invite_Link，提供邀請預覽與以 Invite_Link 加入旅行；把 `/realtime/v1/websocket` 的 WebSocket 連線轉送到 Realtime_Service；以及從 `LM_STATIC_DIR` 提供 LM_Web 的靜態檔。
2. THE LM_Web SHALL 以 Rust 撰寫（除了 trunk 與 wasm-bindgen 產生的載入程式，不含手寫的 JavaScript），以 Leptos 0.8 的 CSR 模式編譯成 `wasm32-unknown-unknown` 的 WebAssembly，並以 trunk 依 `crates/web/Trunk.toml` 建置（例如在 Repository 根目錄執行 `trunk build --release --config crates/web/Trunk.toml`），輸出到 `crates/web/dist`；建置過程不需要 Node.js、npm 或 Bun。
3. THE LM_Core SHALL 包含資料型別、Limits_Table 的上限與 Command；依 Permission_Table 的權限判斷與輸入驗證，包括 Trim_White、Char_Count、Hidden_Control_Char、Participant_Name、Participant_Key、Place_Key 與 Time_Value 的文字規則；Command 的 Primary_Effect 計算與 Shopping_Sync，包括 Ingredient_Parser、Ingredient_Key 與 Ingredient_Classifier；Activity_Preset、料理範本、常用食材、料理插圖種類的推斷、Shopping_Plan、My_Gear、Can_Depart、Itinerary_Text 與 Retime；分帳計算；Change_Set 與 Snapshot 的型別、Replica 的合併與 Optimistic_View 的計算；Presence_Throttle 與編輯者頭像的計算（Avatar_Initial、Avatar_Palette、Editor_Stack 與 Editing_Notice）；以及 API 的請求與回應型別、Command 被拒絕時的錯誤代碼與訊息，並使 `cargo build -p lm-core` 與 `cargo build -p lm-core --target wasm32-unknown-unknown` 都能完成。
4. THE LM_Core SHALL 只做純計算：不使用網路、檔案、系統時間與執行緒，也不依賴 LM_Supabase、LM_Server 與 LM_Web；需要目前時間的計算（Presence_Throttle）由呼叫端傳入時間，Shopping_Sync 新增的 Meal_Item 的 id 由呼叫端提供，使需求 1.3 列出的每一種計算，對相同的輸入在原生目標與 `wasm32-unknown-unknown` 上都得到相同的結果。
5. THE LM_Server 與 LM_Web SHALL 以同一份 LM_Core（兩者都引用 Cargo_Workspace 中的 `crates/core`，不使用其他版本或複本）判斷 Command 的權限、驗證輸入，並計算 Primary_Effect，不在 LM_Server 或 LM_Web 中另外實作這些規則；LM_Server 也以同一份 LM_Core 計算 Derived_Effect，並以 LM_Core 依 Permission_Table 算出的權限判斷 Invite_Link 的建立、列出與撤銷。
6. THE LM_Supabase SHALL 以自寫的精簡用戶端（範圍見需求 1.10）實作 Realtime 協定 1.0.0、Auth_Service 的 REST 呼叫與 access token 的驗證，不依賴第三方的 Supabase 或 Realtime 用戶端套件，也不包含需求 1.3 列出的規則，並把 Realtime 的傳輸與 Auth_Service 的呼叫分別放在 `RealtimeTransport` 與 `AuthBackend` 兩個可以替換的介面之後：Realtime 訊框的編碼、解碼與連線狀態機只經 `RealtimeTransport` 收送訊框、不依賴瀏覽器，可以在原生目標以不連網路的傳輸執行；LM_Server 的註冊、登入、換發 Session 與登出只經 `AuthBackend` 呼叫 Auth_Service。
7. THE Cargo_Workspace SHALL 只以 `crates/core`、`crates/supabase`、`crates/server` 與 `crates/web` 四個 crate 為成員並排除 `.worktrees`，而且預設成員不含 LM_Web，使在 Repository 根目錄執行的 `cargo build` 與 `cargo test` 只以原生目標建置 LM_Core、LM_Supabase 與 LM_Server，不建置 LM_Web，也不需要 Database 或 Supabase_Stack 正在執行。
8. THE Cargo_Workspace SHALL 以 Repository 根目錄的 `rust-toolchain.toml` 指定 stable 頻道、`wasm32-unknown-unknown` 目標，以及 rustfmt 與 clippy 兩個元件，並把涵蓋四個成員的 `Cargo.lock` 提交到 Repository，使 `cargo build --locked` 與 `cargo build -p lm-web --target wasm32-unknown-unknown --locked` 都不需要修改 `Cargo.lock` 就能完成。
9. THE Repository SHALL 保留 Bun_App 的檔案不變，而且不修改 `rust-rewrite` 分支與 `.worktrees/rust-rewrite`：在 Branch_Point 已存在的檔案中，只有 `.gitignore`（加入需求 2.8 的項目）與根目錄的 `README.md`（加入第一版的章節）可以變更，而且只能新增內容、原有的每一行保持不變；其他已存在的檔案都不修改、不刪除、不改名；`rust-rewrite` 分支指向的 commit 與 `.worktrees/rust-rewrite` 中的檔案都維持這項工作開始時的狀態。
10. THE LM_Supabase SHALL 只實作第一版用到的介面，並以 feature 依執行環境分開：不需要啟用任何 feature 的 Realtime 部分送出加入與離開頻道、heartbeat、更新頻道的 access token 與回報 presence 的訊息，並解讀加入頻道與 heartbeat 的回覆、broadcast、presence 的完整狀態與增減、頻道的錯誤與關閉，以及系統訊息；feature `server` 只由 LM_Server 啟用，提供 Auth_Service 的建立使用者、刪除使用者、密碼登入、換發與登出五種呼叫，以及 HS256 與 ES256（公鑰取自 Auth_Service 的 JWKS）的 access token 驗證；feature `web` 只由 LM_Web 啟用、只在 `wasm32-unknown-unknown` 編譯，以瀏覽器的 WebSocket 實作 `RealtimeTransport`。
11. WHEN LM_Server 重新啟動，THE LM_Server SHALL 照常接受重新啟動之前簽發、尚未過期的 access token，並在這段期間沒有新的提交時，回應與重新啟動之前相同的 Snapshot、Head 與 Change_Feed，使已登入的使用者不必重新登入，已提交的變更也不遺失。
12. THE Repository SHALL 讓 Bun_App 的單元測試（`bun run test`）在第一版的 commit 上，每個測試的通過或失敗都與在 Branch_Point 上相同；比較時兩者在同一台開發機、相同的環境變數下執行，而且工作目錄中沒有需求 2.8 在 `.gitignore` 排除的檔案與目錄。

### Requirement 2: 本機開發環境與網路綁定

**User Story:** 身為開發者，我希望在 amazon linux2 中以 Supabase CLI 的本機堆疊開發，而且這些服務只有這台電腦連得到，以便開發方便，又不會把使用範例金鑰的服務開放給區網。

#### Acceptance Criteria

1. THE Local_Stack SHALL 以 `127.0.0.1:54322` 提供 Database、以 `127.0.0.1:54321` 提供 API gateway，並經 API gateway 提供 Auth_Service 與 Realtime_Service（WSL 2 轉送的埠也綁在 Windows 上，所以 Windows 保留這兩個埠時，依需求 2.10 改用其他埠）；Local_Stack 不啟動 Storage、Edge Runtime、Analytics 與本機郵件服務，`docker ps` 中沒有這些服務的容器；LM_Server 與 LM_Web 不依賴 Studio、postgres-meta 與 PostgREST，停止這三個服務的容器之後，LM_Server 的每個 API 與 LM_Web 的每個畫面仍照常運作。
2. THE Local_Stack SHALL 在以 `com.docker.network.bridge.host_binding_ipv4=127.0.0.1` 建立的 Docker 網路 `lm-local` 中啟動（`supabase start --network-id lm-local`），使 `docker ps` 的 PORTS 欄中，Local_Stack 每個容器發布的埠都以 `127.0.0.1:` 開頭，沒有任何以 `0.0.0.0:`、`[::]:` 或 `:::` 開頭的綁定。
3. WHEN 開發者執行 `supabase db reset`，THE Local_Stack SHALL 清除本機 Database 的全部資料（包括 Auth_Service 的使用者），依檔名順序套用 Migrations 的應用資料表（`20260101000000_app_schema.sql`）、Realtime 授權（`20260101000100_realtime_authorization.sql`）與推送（`20260101000200_publish_changes.sql`）三個檔案，而且不載入任何種子資料，使重設完成後的 Database 沒有任何 Account 與旅行。
4. THE LM_Server SHALL 只在 `LM_BIND` 指定的一個位址與埠監聽：`LM_BIND` 的格式為 `<IPv4 位址>:<埠>` 或 `[<IPv6 位址>]:<埠>`，埠為 1–65535，主機名稱（例如 `localhost:8080`）不符合格式；範例設定為 `127.0.0.1:8080`，`LM_BIND` 未設定時監聽 `127.0.0.1:8080`。
5. THE Cargo_Workspace SHALL 把 LM_Web 的開發伺服器（`trunk serve`）設定為只在 `127.0.0.1:8081` 監聽（不在 `0.0.0.0`、`::` 或其他位址監聽），把 `/api/` 之下的 HTTP 請求以相同的路徑與查詢字串轉送到 `http://127.0.0.1:8080/api/` 之下，並把 `/realtime/v1/websocket` 的 WebSocket 連線轉送到 `ws://127.0.0.1:8080/realtime/v1/websocket` 的 LM_Server。
6. IF `LM_BIND` 的位址不是 Loopback_Address（`0.0.0.0` 與 `::` 也不是），而且 `SUPABASE_JWT_SECRET`、`SUPABASE_ANON_KEY` 或 `SUPABASE_SERVICE_KEY` 的值與 Sample_Secrets 中任何一個值完全相同，THEN THE LM_Server SHALL 在開始監聽之前於終端機印出原因，並以非 0 的結束代碼結束程序；訊息列出 `LM_BIND` 的值與每個等於 Sample_Secrets 的環境變數名稱，不含這些變數的值。
7. WHEN LM_Server 啟動，THE LM_Server SHALL 從環境變數讀取 `LM_BIND`、`DATABASE_URL`、`SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_KEY`、`SUPABASE_JWT_SECRET`、`LM_AUTH_EMAIL_DOMAIN`、`LM_PUBLIC_SIGNUP` 與 `LM_STATIC_DIR`：工作目錄或其上層目錄中最近的 `.env` 存在時，以其中的值補上環境中沒有設定的變數；每個值先經 Trim_White，結果是空字串時視同未設定；`DATABASE_URL`、`SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_KEY` 與 `LM_STATIC_DIR` 必須設定；`LM_BIND`（需求 2.4）、`LM_AUTH_EMAIL_DOMAIN` 與 `LM_PUBLIC_SIGNUP`（需求 3.12），以及 `SUPABASE_JWT_SECRET` 可以不設定，`SUPABASE_JWT_SECRET` 未設定時只以 JWKS 驗證 access token，以 HS256 簽署的 access token 一律無效。
8. THE Repository SHALL 提供 `.env.example`：除了以 `#` 開頭的註解行與空行，檔案只有需求 2.7 的 9 個環境變數各一行，格式為 `<名稱>=`，等號後沒有值；並在 `.gitignore` 加入 `/target`、`/crates/web/dist`、`/supabase/.branches`、`/supabase/.temp` 與 `.env`，使 git 忽略這些路徑，但不忽略 `.env.example`。
9. THE LM_Server SHALL 只在伺服器端使用 `SUPABASE_SERVICE_KEY`、`SUPABASE_ANON_KEY`、`SUPABASE_JWT_SECRET` 與 `DATABASE_URL`：LM_Server 送給瀏覽器的 HTTP 回應（包括 `LM_STATIC_DIR` 的靜態檔）與 WebSocket 訊框都不含這四個變數的值，瀏覽器取得的 Auth_Service 憑證只有使用者自己 Session 中的 access token 與 refresh token。
10. THE README SHALL 說明在 Windows 的 WSL 2（Ubuntu）中開發的步驟：Repository 留在 Windows 的磁碟（例如 `d:\path\to\little-moments`，在 WSL 中為 `/mnt/d/path/to/little-moments`），cargo、trunk、docker 與 Supabase CLI 都在 WSL 中、從這個目錄執行；環境變數 `CARGO_TARGET_DIR` 指向 Linux 檔案系統中、不在 `/mnt/` 之下的目錄（例如 `$HOME/.cache/lm-target`）；git 只在 Windows 的 PowerShell 執行、不在 WSL 中執行（Windows 的 git 使用 `core.autocrlf`）；在 WSL 中安裝 `build-essential`、`pkg-config` 與 `libssl-dev`，以 rustup 安裝 Rust，以 `rustup target add wasm32-unknown-unknown` 與 `cargo install trunk --locked` 安裝 `wasm32-unknown-unknown` 目標與 trunk，在 WSL 的 Ubuntu 中安裝 Docker Engine（不使用 Docker Desktop），並安裝 Supabase CLI 3.2.0 的 Linux 版（例如把 GitHub Releases 上的 Linux 執行檔放在 `~/.local/bin`）；在第一次執行 `supabase start` 之前，以 `docker network create -o "com.docker.network.bridge.host_binding_ipv4=127.0.0.1" lm-local` 建立只綁 127.0.0.1 的 Docker 網路；以 `supabase start --network-id lm-local` 啟動，並以 `docker ps` 確認每個埠都綁在 `127.0.0.1`；任何埠顯示 `0.0.0.0`、`[::]` 或 `:::` 時，先執行 `supabase stop`，以 `docker network inspect lm-local` 確認網路設有 `com.docker.network.bridge.host_binding_ipv4=127.0.0.1`，沒有時刪除並重新建立網路，再重新啟動；說明 WSL 2 的 localhost 轉送讓 Windows 的瀏覽器連到 WSL 中綁在 127.0.0.1 的埠（例如 `http://127.0.0.1:8081`），區網中的其他電腦則連不到這些埠；在 Windows 的 PowerShell 以 `netsh interface ipv4 show excludedportrange protocol=tcp` 檢查 54321、54322 與 54323 是否落在 Windows 保留的埠範圍（WSL 2 轉送的埠也綁在 Windows 上），落在範圍內時在 Local_Stack 的設定改用範圍外的埠，並同步修改 `SUPABASE_URL` 與 `DATABASE_URL`；說明 `supabase db reset` 會清除本機 Database 的全部資料，包括每個 Account；把 `.env.example` 複製為 `.env` 後，以 `supabase status -o env` 的 `API_URL`、`DB_URL`、`ANON_KEY`、`SERVICE_ROLE_KEY` 與 `JWT_SECRET` 分別填入 `SUPABASE_URL`、`DATABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_KEY` 與 `SUPABASE_JWT_SECRET`，並列出 `LM_BIND`（`127.0.0.1:8080`）、`LM_AUTH_EMAIL_DOMAIN`（`users.little-moments.invalid`）、`LM_PUBLIC_SIGNUP`（`true`）與 `LM_STATIC_DIR`（`crates/web/dist`）的範例值；列出在 WSL 中啟動 LM_Server（`cargo run -p lm-server`）與 LM_Web 開發伺服器（`trunk serve`，使用需求 2.5 的設定）的指令；並記錄開發時使用的 `supabase --version` 版本號。
11. IF `DATABASE_URL`、`SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_KEY` 或 `LM_STATIC_DIR` 未設定，或 `LM_BIND` 不符合需求 2.4 的格式、`DATABASE_URL` 不是以 `postgres://` 或 `postgresql://` 開頭、`SUPABASE_URL` 不是以 `http://` 或 `https://` 開頭、有設定的 `LM_PUBLIC_SIGNUP` 不是 `true` 也不是 `false`，THEN THE LM_Server SHALL 在開始監聽之前於終端機列出每個未設定或格式不符的環境變數名稱與原因，並以非 0 的結束代碼結束程序；訊息不含 `DATABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_KEY` 與 `SUPABASE_JWT_SECRET` 的值。
12. IF LM_Server 無法在 `LM_BIND` 的位址監聽（例如埠已被其他程式使用，或位址不屬於 LM_Server 所在的系統，包括在 WSL 2 中使用 Windows 網路介面的位址），或啟動後 30 秒內仍無法連上 `DATABASE_URL` 的 Database（例如 Local_Stack 尚未啟動），THEN THE LM_Server SHALL 於終端機印出無法監聽的位址或 Database 的主機與埠，以及失敗的原因，並以非 0 的結束代碼結束程序；訊息不含 `DATABASE_URL` 中的密碼。

### Requirement 3: 帳號註冊

**User Story:** 身為新使用者，我希望以帳號名稱、顯示名稱與密碼註冊，以便沿用現在的登入方式，不需要 email。

#### Acceptance Criteria

1. WHEN 訪客在 `/register` 或 Invite_Page 送出帳號名稱、顯示名稱與密碼，THE LM_Server SHALL 依序進行需求 3.2 至 3.5、3.7 與（附邀請時）需求 30.13 的檢查，只回應第一個不通過的檢查；全部通過後，以 Auth_Service 的 admin API、用送出的密碼原樣建立 email 為 Synthetic_Email 而且 email 已確認的使用者，在一個資料庫交易中建立這個 Account 的 `app.profiles` 資料（帳號名稱、以 Participant_Name 正規化後的顯示名稱與角色），附邀請時在同一個交易中加入旅行，提交後回傳這個 Account 已登入的 Session。
2. IF 帳號名稱不符合 `^[a-z][a-z0-9-]{2,31}$`（3–32 個小寫英文字母、數字或連字號，並以英文字母開頭），包括空字串，以及含有大寫字母或前後空白的名稱（LM_Server 不轉換大小寫也不去除空白，所以 `Alice` 與 ` alice` 都不符合），THEN THE LM_Server SHALL 回應 400「帳號名稱需為 3–32 個字元：以小寫英文字母開頭，只能使用小寫英文字母、數字或連字號（-）。」。
3. IF 帳號名稱是 api、admin、setup、login、register、logout、demo、assets 或 invite，THEN THE LM_Server SHALL 回應 400「這個帳號名稱是系統保留字，請換一個。」。
4. IF 顯示名稱以 Participant_Name 正規化後，Char_Count 超過 30、含有 Hidden_Control_Char，或 Participant_Key 經 Trim_White 後是空字串（例如只有空白、全形空白或 U+3164 韓文填充字元的名稱），THEN THE LM_Server SHALL 回應 400「請填寫 1–30 個字的顯示名稱，不能只有空白或包含隱藏控制字元。」。
5. IF 原樣的密碼（不去除前後空白、不做 Unicode 正規化）Char_Count 不在 12–72，或 UTF-8 編碼超過 72 位元組（例如 25 個中文字共 75 位元組），THEN THE LM_Server SHALL 回應 400「密碼需為 12–72 個字元，而且不超過 72 個位元組（一個中文字占 3 個位元組）。」。
6. IF 帳號名稱已被使用，也就是 Auth_Service 已有 email 相同的使用者（包括同時進行、先建立使用者的另一個註冊），或 `app.profiles` 已有相同的帳號名稱，THEN THE LM_Server SHALL 回應 409「這個帳號名稱已被使用。」，不建立新的 Account，也不修改既有 Account 的密碼與資料。
7. IF `LM_PUBLIC_SIGNUP` 為 `false`，而且註冊請求沒有附邀請，THEN THE LM_Server SHALL 回應 403「目前只接受以邀請連結註冊。」，不呼叫 Auth_Service 建立使用者；Database 還沒有任何 Account 時也一樣，所以第一個 Account 要在 `LM_PUBLIC_SIGNUP` 為 `true` 時註冊。
8. WHILE `app.profiles` 沒有任何一列，WHEN 註冊的資料庫交易建立一筆 `app.profiles` 資料，THE LM_Server SHALL 把這個 Account 的角色設為 admin；`app.profiles` 已有資料時建立的 Account，角色都是 member。
9. WHEN 兩個都能通過需求 3.2 至 3.7 的檢查、帳號名稱不同的註冊，在 `app.profiles` 沒有任何一列時同時進行，THE LM_Server SHALL 讓兩個註冊都成功，而且恰好一個 Account 的角色是 admin、另一個是 member。
10. IF Auth_Service 已建立使用者，但同一次註冊建立 `app.profiles` 資料或以邀請加入旅行的資料庫交易失敗，THEN THE LM_Server SHALL 回滾整個交易（不留下這個 Account 的 `app.profiles` 資料、旅伴、Change_Set 與邀請的使用紀錄，也不推送）、刪除剛建立的 Auth_Service 使用者使這個帳號名稱可以再註冊，並回應原本的錯誤：例如「邀請連結無效或已過期。」，帳號名稱重複時依需求 3.6，Database 連線或執行錯誤時為 500「註冊暫時無法使用，請聯絡管理員。」；刪除 Auth_Service 使用者也失敗時，在伺服器記錄中寫下該使用者的 id，回應不變。
11. IF 建立使用者時，Auth_Service 以 email 無效拒收 Synthetic_Email、無法連線，或回報 email 已存在以外的其他錯誤，THEN THE LM_Server SHALL 回應 500「註冊暫時無法使用，請聯絡管理員。」，不建立 Account，並在伺服器記錄中寫下原因（email 被拒收時指出 `LM_AUTH_EMAIL_DOMAIN` 的設定有誤），記錄中不含密碼。
12. THE LM_Server SHALL 在 `LM_AUTH_EMAIL_DOMAIN` 沒有設定時（依需求 2.7，包括空字串）使用 `users.little-moments.invalid`；`LM_PUBLIC_SIGNUP` 沒有設定時（包括空字串）視為 `true`，有設定時只接受 `true` 與 `false`，其他值（例如 `TRUE` 與 `0`）依需求 2.11 在開始監聽之前印出原因並結束程序。
13. THE Local_Stack SHALL 關閉 Auth_Service 的自行註冊（`[auth] enable_signup = false`）與 email 確認（`[auth.email] enable_confirmations = false`），使不經 LM_Server、直接向 Auth_Service 送出的自行註冊請求被拒絕且不建立使用者，Account 只能經 LM_Server 建立。
14. WHEN 訪客在 `/register` 或 Invite_Page 送出註冊表單，THE LM_Web SHALL 先對帳號名稱做 Trim_White 並把 A–Z 轉成小寫（密碼不做任何修改），再以與 LM_Server 相同的 LM_Core 規則依需求 3.2 至 3.5 的順序檢查，最後確認兩次輸入的密碼完全相同；任一項不通過時不送出請求，只在表單顯示第一個不通過項目的訊息，兩次密碼不同時顯示「兩次輸入的密碼不一致。」。
15. WHEN `/register` 收到 LM_Server 對註冊請求的回應，THE LM_Web SHALL 在註冊成功時依需求 4.3 保存 Session，並前往 `next` 指定的 App 內路徑（與需求 4.10 相同），`next` 不存在或不是 App 內路徑時前往這個 Account 的 Home_Page；在註冊被拒絕時於表單顯示回應的 `message`，並保留表單中已輸入的內容。
16. IF 註冊的資料庫交易已提交，但 LM_Server 接著以密碼向 Auth_Service 取得 Session 失敗（例如 Auth_Service 回報速率限制或無法連線），THEN THE LM_Server SHALL 保留已建立的 Account 與附邀請時加入旅行的結果，回應 503「帳號已建立，但暫時無法登入，請稍後到登入頁登入。」。

### Requirement 4: 登入、登入狀態與登出

**User Story:** 身為使用者，我希望以帳號名稱與密碼登入，並在多個分頁中保持登入，以便不必反覆登入，也不會因為登入過期而失去還沒送出的變更。

#### Acceptance Criteria

1. WHEN 使用者在 `/login` 送出帳號名稱與密碼（`POST /api/auth/login`），THE LM_Server SHALL 先把帳號名稱 Trim_White 並把 A–Z 轉成小寫，再以這個帳號名稱組成的 Synthetic_Email 與原樣（不修剪、不正規化）的密碼向 Auth_Service 進行密碼登入，成功時回傳 Session。
2. IF 帳號名稱或密碼缺少，依需求 4.1 正規化後的帳號名稱是空的、不符合需求 3.2 的格式、是需求 3.3 的保留名稱或不存在，密碼是空的、UTF-8 編碼超過 72 位元組或不正確，或 Auth_Service 的使用者沒有對應的 `app.profiles` 資料，THEN THE LM_Server SHALL 一律以 401 回應「帳號或密碼不正確。」，而且每一種情況的狀態碼與訊息都相同。
3. WHEN LM_Web 從登入、註冊（包括在 Invite_Page 以連結註冊）或換發取得 Session，THE LM_Web SHALL 以它覆寫 localStorage 的 `lm.session.v1`，使重新載入頁面或在同一個瀏覽器開啟新分頁時仍是同一個登入狀態；`lm.session.v1` 不存在或無法解析成 Session 時視為未登入（並移除無法解析的內容），這時開啟 Home_Page、Trip_Page 或 Departure_Page 時依需求 32.9 前往 `/login`。
4. THE Local_Stack SHALL 讓 access token 的有效時間為 3600 秒（`[auth] jwt_expiry = 3600`），並啟用 refresh token 輪替（`enable_refresh_token_rotation = true`）與 10 秒的重用間隔（`refresh_token_reuse_interval = 10`），使 10 秒內以同一個 refresh token 重複換發都得到有效的 Session。
5. WHILE 使用者已登入，THE LM_Web SHALL 在 Session 的到期時間前 60 秒以 refresh token 經 `POST /api/auth/refresh` 換發 Session；載入頁面、分頁回到前景，或送出需要 access token 的 API 請求（登出除外）時，若距離到期已不到 60 秒（包括已經過期），先換發再繼續；每次換發成功後，把新的 access token 送給這個分頁每個已加入的 Trip_Channel，並依新的到期時間安排下一次換發。
6. WHEN 另一個分頁寫入或移除 localStorage 的 `lm.session.v1`（換發、登入或登出），THE LM_Web SHALL 在收到 `storage` 事件時讓這個分頁採用同樣的登入狀態：寫入同一個 Account 的 Session 時，之後的 API 請求改用新的 access token、把它送給每個已加入的 Trip_Channel，並依新的到期時間重新安排換發；寫入另一個 Account 的 Session 時依需求 4.14 處理；寫入 Session 時這個分頁正停在 `/login`，就依需求 4.10 前往下一個畫面；`lm.session.v1` 被移除時依需求 4.9 處理。
7. WHEN 同一個瀏覽器的兩個以上分頁同時或先後換發 Session，THE LM_Web SHALL 讓每個分頁都維持登入：每個分頁換發之前先讀取 `lm.session.v1`，其中是同一個 Account、而且距離到期還有 60 秒以上的 Session 時直接改用它而不送出換發，否則以 `lm.session.v1` 中的 refresh token 換發；沒有任何分頁因為其他分頁換發而前往 `/login`。
8. IF 需要 access token 的 API 請求（需求 5.1；`POST /api/auth/logout` 除外）回應 401，THEN THE LM_Web SHALL 換發一次 Session，再以新的 access token 重試同一個請求一次，Command 以相同的 Command_Id 重試；同一個分頁同時有多個請求回應 401 時只換發一次，重試仍回應 401 時依需求 4.9 處理。
9. IF LM_Server 以 401 拒絕換發 Session（refresh token 不存在、已撤銷、在 10 秒的重用間隔之後重複使用，或 Account 已不存在），THEN THE LM_Web SHALL 離開這個分頁每個已加入的 Trip_Channel、停止送出 Pending_Command 但把它們留在記憶體中、在 `lm.session.v1` 仍是被拒絕的那個 Session 時移除它，並在不重新載入頁面的情況下前往 `/login?next=<目前的路徑>`（含 `?tab=<分頁>`，經 URL 編碼），顯示「登入已失效，請重新登入；尚有 N 項變更未送出」，N 為這個分頁 Pending_Command 的數量；沒有 Pending_Command 時只顯示「登入已失效，請重新登入」。
10. WHEN 使用者經 `/login` 登入成功，THE LM_Web SHALL 在 `next` 是 In_App_Path、而且不是另一個帳號名稱的 Home_Page、Trip_Page 或 Departure_Page 時前往 `next`，否則（沒有 `next`、`next` 不是 In_App_Path，或屬於另一個帳號名稱）前往這個 Account 的 Home_Page；這個分頁仍保留同一個 Account 的 Pending_Command 時，以新的 Session 依原本的順序、以原本的 Command_Id 送出它們。
11. WHEN LM_Server 收到帶有效 access token 的 `POST /api/auth/logout`，THE LM_Server SHALL 請 Auth_Service 撤銷這個裝置的 refresh token（這次登入取得的，以及之後換發得到的每一個），使它們之後換發時得到 401，而同一個 Account 在其他瀏覽器或裝置的登入不受影響；Auth_Service 回應錯誤、無法連線或 10 秒內沒有回應時，仍回應 200（已簽發的 access token 仍可使用到到期，design.md R10）。
12. WHEN 使用者登出，THE LM_Web SHALL 以目前的 access token 送出 `POST /api/auth/logout`，並在請求完成（不論狀態碼）、失敗，或按下登出 5 秒後仍未完成時，清除 localStorage 的 `lm.session.v1`、離開每個已加入的 Trip_Channel，並前往 `/login`，不顯示需求 4.9 的訊息；登出之後才完成的換發不再寫入 `lm.session.v1`，也不依需求 4.9 或 4.13 處理；這個分頁的 Pending_Command 留在記憶體中，之後依需求 4.10 或 4.14 處理。
13. IF 換發 Session 的請求因網路錯誤（例如離線）而失敗，或 LM_Server 以 429 或 5xx 回應，THEN THE LM_Web SHALL 保留 Session 與 Pending_Command、留在目前的畫面而不前往 `/login`，並在下一次 `online` 事件、分頁回到前景，或下一個需要 access token 的請求時再換發一次。
14. IF 這個分頁取得的新 Session 屬於另一個 Account（不同於這個分頁之前的 Session，例如在這個分頁登入或註冊另一個 Account，或另一個分頁寫入另一個 Account 的 Session），THEN THE LM_Web SHALL 捨棄原 Account 的 Pending_Command 而不送出、離開每個已加入的 Trip_Channel，並在這個分頁停在原 Account 的 Home_Page、Trip_Page 或 Departure_Page 時前往新 Account 的 Home_Page；捨棄的數量 N 大於 0 時，顯示訊息說明有 N 項變更因為切換帳號而沒有儲存。
15. IF Auth_Service 在 LM_Server 處理登入或換發 Session 時無法連線、10 秒內沒有回應、回應 5xx 或以速率限制拒絕，THEN THE LM_Server SHALL 以 503 回應（速率限制時為 429），訊息說明暫時無法登入、請稍後再試，不回應 401，也不回應「帳號或密碼不正確。」。

### Requirement 5: API 的身分驗證與回應格式

**User Story:** 身為旅伴，我希望伺服器只接受有效的登入，並以看得懂的中文說明錯誤，以便旅行資料不被他人存取，出錯時也知道原因。

#### Acceptance Criteria

1. IF Public_Endpoint 以外的 `/api/*` 端點（包括 `POST /api/auth/logout`）收到的請求沒有 `Authorization: Bearer <access token>` 標頭（缺少這個標頭、值不是 `Bearer` 加一個空格與 token，或 token 是空字串），或其中的 access token 不是 Valid_Access_Token，THEN THE LM_Server SHALL 回應 401（`code` 為 `unauthorized`、`message` 為「請先登入。」、`field` 為 `null`），而且不執行這個請求：Database 保持不變，也不推送 Change_Set。
2. THE LM_Server SHALL 接受同時符合下列條件、而且簽章依需求 5.3 與 5.4 驗證通過的 access token，並拒絕其他 token：宣告（claim）`aud` 與 `role` 都是 `authenticated`；`sub` 是 UUID，而且是既有 Account 的 id（`app.profiles` 中有 id 等於 `sub` 的列）；有 `exp`，而且 LM_Server 的目前時間不晚於 `exp` 之後 30 秒（例如 `exp` 已過 29 秒時接受、已過 31 秒時拒絕）；所以缺少 `aud`、`role`、`sub` 或 `exp` 的 token，以及 `role` 為 `anon` 或 `service_role` 的 token（例如 Supabase 的 anon key 與 service_role key）都會被拒絕。
3. THE LM_Server SHALL 依 access token 的 JWT 標頭中的 `alg` 驗證簽章：`HS256` 以 `SUPABASE_JWT_SECRET` 驗證，`ES256` 以 JWKS 中 `kid` 與 token 相同的公鑰驗證；`SUPABASE_JWT_SECRET` 沒有設定或是空字串時拒絕所有 HS256 的 token；`alg` 為其他值（例如 `none`、`HS512`、`RS256`）或簽章不符的 token 一律拒絕。
4. WHEN LM_Server 驗證 ES256 的 access token，THE LM_Server SHALL 使用讀取後未滿 10 分鐘的 JWKS 快取；沒有快取、快取已滿 10 分鐘，或 token 的 `kid` 不在快取中時，立即讀取一次 JWKS 並以讀到的內容取代快取（每個 token 的驗證最多讀取一次）；token 的 JWT 標頭沒有 `kid`，或讀取後的 JWKS 仍沒有這個 `kid` 時，拒絕這個 token。
5. THE LM_Server SHALL 以 `Content-Type` 為 `application/json` 的 JSON 回應每個 `/api/*` 請求，包括錯誤與沒有資料要回傳的成功回應（例如登出）；錯誤回應的內容只有 `code`、`message` 與 `field` 三個欄位：`code` 是由小寫英文字母、數字與底線組成、以字母開頭的固定識別字，同一種錯誤每次都相同（例如 `username_taken`）；`message` 是可以直接顯示給使用者的繁體中文，不含 Database、Auth_Service 或程式內部的錯誤文字；`field` 是錯誤所指的輸入欄位名稱（例如註冊時帳號名稱不符合規則為 `username`），錯誤不屬於單一欄位時為 `null`。
6. THE LM_Server SHALL 只以 `Authorization` 標頭中 access token 的 `sub` 辨識使用者，帳號名稱、Display_Name 與角色一律以 Database 中這個 Account 的資料為準，不由 token 的其他宣告（例如 `email`、`user_metadata`）決定；不從 cookie 或網址的查詢參數讀取 access token；任何回應都不含 `Set-Cookie` 標頭。
7. WHEN 使用者以 Valid_Access_Token 請求 `GET /api/me`，THE LM_Server SHALL 回應 200，內容為 Database 中這個 Account 目前的 id、帳號名稱、Display_Name 與角色（`admin` 或 `member`），格式與 Session 中的 Account 資料相同。
8. THE LM_Server SHALL 處理 Public_Endpoint 的請求時，不因為 `Authorization` 標頭缺少、格式不對，或其中的 access token 過期或無效而回應 401：註冊、登入與換發 Session 一律忽略這個標頭，依需求 3 與需求 4 處理；邀請預覽在沒有 Valid_Access_Token 時依未登入的訪客處理，回傳預覽但不回傳是否已是 Trip_Member。
9. IF `/api/*` 的請求路徑不存在、方法不是這個路徑支援的方法，或網址參數或請求內容的格式不正確（例如 `after` 不是非負整數，或需要請求內容的端點收到的內容不是 `application/json`、JSON 語法錯誤、缺少欄位或型別不符；路徑中的旅行 id 不是 UUID 時不適用這一條，依需求 6.2 回應 404「找不到這趟旅行。」），THEN THE LM_Server SHALL 分別回應 404（`code` 為 `api_not_found`、`message` 為「找不到這個 API。」）、405（`method_not_allowed`、「不支援這個操作。」）或 400（`invalid_request`、「資料格式不正確。」），`field` 都是 `null`，不回傳 `index.html`，也不執行這個請求；404 與 405 不論請求是否帶有 access token，400 則在需求 5.1 的檢查之後判斷，所以 Public_Endpoint 以外的端點收到沒有 Valid_Access_Token、格式又不正確的請求時回應 401。
10. IF 處理 `/api/*` 請求時 Database 或 Auth_Service 無法使用（包括需要讀取 JWKS，但 Auth_Service 無法連線、回應錯誤狀態，或回應的內容無法解析成 JWKS），或發生程式未預期的錯誤（例如需求 7.16 的提交失敗），THEN THE LM_Server SHALL 回應 500（`code` 為 `internal_error`、`message` 為「伺服器暫時無法處理，請稍後再試。」、`field` 為 `null`），不以 401 回應，並在伺服器記錄中記下這個錯誤，記錄不含 access token、refresh token 與密碼；其他需求另有指定的情況依該需求，例如需求 3.11 的訊息、需求 3.16 與 4.15 的 503 或 429，以及需求 4.11 的登出仍回應 200。

### Requirement 6: 旅行成員資格與權限

**User Story:** 身為旅行的主辦人，我希望只有這趟旅行的成員能看到與修改旅行，受邀旅伴也不能刪除既有的重要項目，以便旅行資料不外流，規則也和現在一樣。

#### Acceptance Criteria

1. THE LM_Server SHALL 在處理每個請求時，以當下 Database 中「這趟旅行有一位 Person 綁定該 Account」判斷 Account 是不是這趟旅行的 Trip_Member，並以 Account 當下的角色判斷是不是 Admin；這兩項判斷不依 access token 的內容，也不沿用先前請求的判斷結果，使 Account 以 Invite_Link 加入旅行之後的下一個請求就以 Trip_Member 的身分處理。
2. IF 不是 Trip_Member 也不是 Admin 的 Account 讀取這趟旅行的 Snapshot、增量的 Change_Set 或 Head、送出 Command（包括 Command_Id 與這趟旅行某個已提交 Change_Set 的 Command_Id 相同的 Command）、刪除旅行，或建立、列出、撤銷這趟旅行的 Invite_Link，THEN THE LM_Server SHALL 回應 404「找不到這趟旅行。」且不寫入任何資料；請求的旅行 id 不存在或不是 UUID 格式時，LM_Server 以狀態碼與內容完全相同的回應拒絕，使請求者無法分辨旅行是否存在。
3. IF 請求的旅行已被刪除，THEN THE LM_Server SHALL 不論請求者是 Trip_Manager、Collaborator 或其他 Account，對這趟旅行的 Snapshot、增量的 Change_Set、Head、Command、刪除旅行，以及建立、列出與撤銷 Invite_Link 的請求一律回應 404「找不到這趟旅行。」且不寫入任何資料，任何 Account 的 Home_Page 也不再列出這趟旅行；與刪除旅行同時送達、在刪除提交之後才執行的 Command 也得到這個回應，使 `trip_deleted` 為真的 Change_Set 是這趟旅行的最後一個 Change_Set。
4. THE LM_Core SHALL 依 Permission_Table 判斷每個 Command 是否允許，拒絕時回傳表中的 403 或 404 與訊息；這個判斷在檢查目標項目是否存在、驗證輸入，以及判斷 Command 是否沒有變化之前進行，使被拒絕的 Command 即使指向不存在的項目、含有不符合規則的內容，或想要的狀態已經成立，也得到 Permission_Table 中的 403 或 404。
5. THE LM_Server SHALL 依 Permission_Table 判斷建立、列出與撤銷 Invite_Link 的權限，而且只處理屬於路徑中這趟旅行的 Invite_Link：Trip_Manager（包括 Unbound_Admin）可以建立 Invite_Link、列出這趟旅行全部的 Active_Invite，並撤銷其中任何一個；Collaborator 可以建立 Invite_Link，但只列出與撤銷自己建立的 Active_Invite，撤銷別人建立的 Active_Invite 時得到 403「只有建立連結的人、主辦人或管理員可以撤銷邀請。」，連結保持有效；要撤銷的 Invite_Link 屬於其他旅行時，LM_Server 回應 404「邀請連結無效或已過期。」，不改變那個連結。
6. IF Collaborator 送出移除旅伴，或刪除車輛、料理、採買品項或裝備的 Command，THEN THE LM_Server SHALL 回應 403「受邀旅伴可以編輯，但不能刪除既有項目；請聯絡主辦人或管理員。」；Collaborator 修改料理或從料理移除食材而由 Shopping_Sync 自動移除採買品項時，不適用這一條，依需求 26.13 執行。
7. IF 使用者勾選或取消其他旅伴的打包，或變更其他旅伴的出發確認，THEN THE LM_Server SHALL 回應 403「只能變更自己的行前準備。」；「其他旅伴」是使用者的 Bound_Person 以外的每一位旅伴：Trip_Manager 也不例外，而沒有 Bound_Person 的 Unbound_Admin 對任何旅伴送出這類 Command 都得到這個回應。
8. IF Collaborator 修改綁定其他 Account 的旅伴，THEN THE LM_Server SHALL 回應 403「只能修改自己的旅伴資料。」；Collaborator 修改自己的 Bound_Person 或沒有綁定 Account 的旅伴，以及 Trip_Manager 修改任何旅伴時，依需求 19 的一般規則執行。
9. IF Unbound_Admin 新增、修改或刪除支出或還款，THEN THE LM_Server SHALL 回應 404「找不到這趟旅行。」。
10. IF Collaborator 刪除支出或還款，THEN THE LM_Server SHALL 回應 403「受邀旅伴可以新增或修改帳目，但不能刪除既有帳目；請聯絡主辦人或管理員。」。
11. WHEN Collaborator 刪除路線、途中任務（停靠點）、活動或地點，THE LM_Server SHALL 以與 Trip_Manager 相同的規則執行這個刪除，不因為 Collaborator 的身分回應 403；例如仍被使用的地點依需求 21 回應 409。
12. IF 檢視者是 Unbound_Admin，THEN THE LM_Server SHALL 從 Snapshot、增量的 Change_Set，以及 Command 回應中的 Change_Set（包括 Command_Id 重送時回應的第一次提交的 Change_Set）省略全部 Ledger_Rows，也就是支出（含分攤旅伴）與還款的每一筆變化，包括刪除；同一個 Change_Set 的其他變化、Seq 與 Head 照常回應，只含 Ledger_Rows 的 Change_Set 以沒有任何變化的 Change_Set 回應，使 Seq 不缺號。
13. WHEN Unbound_Admin 的分頁從 Trip_Channel 收到含有 Ledger_Rows 的 Change_Set，THE LM_Web SHALL 丟棄其中的 Ledger_Rows，照常套用同一個 Change_Set 的其他變化並推進 Watermark，使這個分頁的 Replica 與畫面始終不含任何支出與還款。
14. THE Database SHALL 把應用資料表放在不在 PostgREST `api.schemas` 中的 `app` schema；`app` 的每張資料表都啟用 RLS 且不建立政策，`anon` 與 `authenticated` 角色對 `app` 的任何資料表都沒有權限，`authenticated` 在 `app` 中只能執行 Realtime_Service 判斷 Trip_Channel 權限所需的函式，使以 anon key 或任何 Account 的 access token 經 API gateway 讀寫 `app` 的資料時，請求都被拒絕且不回傳任何資料列。
15. THE LM_Web SHALL 只經 LM_Server 的 `/api/*` 與同源的 Realtime 連線（需求 11.1）讀寫旅行資料，不直接連到 Database、PostgREST 或 Auth_Service。
16. IF 以 Invite_Link 預覽、以目前的 Account 加入，或在 Invite_Page 以連結註冊時，連結所屬的旅行已被刪除（包括刪除在請求處理期間才提交），THEN THE LM_Server SHALL 不論請求者是否已是 Trip_Member，都以與需求 30.13 相同的回應「邀請連結無效或已過期。」拒絕，不建立 Account、不新增旅伴，也不寫入或推送 Change_Set。
17. WHILE 檢視者是 Collaborator，THE LM_Web SHALL 不顯示刪除旅行、移除旅伴，以及刪除車輛、料理、採買品項、裝備、支出與還款的操作，並照常提供刪除路線、停靠點、活動與地點的操作。
18. WHILE 檢視者是 Unbound_Admin，THE Ledger_Tab SHALL 只顯示「你不是這趟旅行的旅伴，無法查看或記錄分帳。」：不列出支出與還款、不顯示總金額、餘額與建議轉帳，也不提供新增、修改或刪除帳目的操作。

### Requirement 7: 命令與提交順序

**User Story:** 身為旅伴，我希望和其他人同時修改不同的項目時都能成功儲存，以便不再看到「旅行已有更新，請重新載入」，也不必先匯出再重新載入合併。

#### Acceptance Criteria

1. THE LM_Server SHALL 只以 `POST /api/trips/{id}/commands` 接受 Trip_State 的修改（建立旅行、刪除旅行與以 Invite_Link 加入除外）；每個請求只包含一個 Command_Id 與一個 Command，成功提交時回傳這次的 Seq 與 Change_Set；檢視者是 Unbound_Admin 時，回應中的 Change_Set（包括第 14 條的重送）依需求 6.12 省略 Ledger_Rows。
2. THE LM_Server SHALL 在同一趟旅行中一次只執行一個 Command（前一個提交或回滾之後，下一個才開始），使每次提交後的 Trip_State 等於依 Seq 由小到大逐一執行這些 Command 的結果；每次有變化的提交（包括刪除旅行與以 Invite_Link 加入）取得下一個 Seq：從 1 開始，每次加 1，不跳號；排在刪除旅行之後執行的 Command 依需求 6.3 回應 404「找不到這趟旅行。」。
3. WHILE 一趟旅行有 Command 正在執行（已開始、尚未提交或回滾），THE LM_Server SHALL 讓其他旅行的 Command 照常開始並完成，不等待前者結束。
4. THE LM_Server SHALL 只依 Command 執行當下已提交的 Trip_State 判斷權限與規則，不要求用戶端提供 Seq、Row_Version 或其他版本號，也不因為用戶端的 Watermark 比 Head 舊而拒絕 Command 或回應「旅行已有更新，請重新載入後再勾選。」。
5. WHEN 兩個都成功執行（沒有被拒絕或回滾）的 Command 寫入不同的列，或寫入同一列中不同的欄位，THE LM_Server SHALL 在兩者都執行之後保留兩者寫入的值，與提交順序無關；寫入包括新增、刪除（刪除一列視為寫入這一列的全部欄位）、命令規則的連帶效果（例如換裝備負責人時清空打包勾選）與 Derived_Effect。
6. WHEN 兩個都成功執行的 Command 寫入同一列的同一個欄位（集合欄位見第 7 條），THE LM_Server SHALL 以 Seq 較大者寫入的值作為這個欄位的結果。
7. WHEN 兩個都成功執行的 Command 對同一個集合欄位（車輛的乘客、活動指定的旅伴或車輛）加入或移除元素，THE LM_Server SHALL 保留兩者對不同元素的加入與移除；兩者對同一個元素一個加入、一個移除時，以 Seq 較大者為準；加入已在集合中的元素，或移除不在集合中的元素，不改變這個元素。
8. WHEN 使用者儲存編輯既有列的表單或行內編輯（路線卡片見第 9 條），THE LM_Web SHALL 只把值與開始編輯時記下的值不同的欄位放進 Command：使用者清空的選填欄位（例如車輛的駕駛、料理的用餐時間）以「清空」送出，與沒有改的欄位區分；集合欄位只送出加入的元素（儲存時有、開始編輯時沒有）與移除的元素（開始編輯時有、儲存時沒有）；沒有任何欄位改變時結束編輯，不送出 Command。
9. WHEN 使用者儲存路線卡片，THE LM_Web SHALL 把起點、終點、出發時間與全部停靠點（每個停靠點的地點、種類、任務、時間與備註，以及停靠點的順序）連同路線的日期與車輛當成一份送出；同一條路線的並行儲存由後提交者整條生效，先提交者加入、但不在後提交內容中的停靠點不會留下。
10. THE LM_Web SHALL 以要設定的值送出 Check_Command：勾選時送出「是」，取消勾選時送出「否」，這個值是使用者操作當下 Optimistic_View 中狀態的相反值；不以「切換目前的值」送出。
11. WHEN LM_Server 執行通過權限與規則檢查的 Check_Command，THE LM_Server SHALL 把目標狀態（品項的已買、這位旅伴在這個裝備的已打包、這位旅伴的出發確認、活動的完成）設為 Check_Command 指定的值，與原本的值無關。
12. WHEN 一個通過權限與規則檢查的 Command 不會改變任何列的內容（例如再次勾選已買的品項，或把料理份數改成目前的值），或它要刪除的列在執行時已不存在（例如已被其他成員先刪除），THE LM_Server SHALL 不寫入、不推送、不使用新的 Seq，也不記錄這個 Command_Id，並回傳目前的 Head 與「沒有變化」（不含 Change_Set）；刪除已不存在的列也不產生任何連帶變化。
13. WHEN 兩個 Check_Command 指向不同的（項目、旅伴）組合，THE LM_Server SHALL 使兩者都執行之後的 Trip_State 與提交順序無關；唯一的例外是同一位旅伴的「已打包 = 是」與「確認出發 = 是」：確認出發依執行當下的 Can_Depart 判斷，在打包之前執行時依需求 28.3 回應 400。
14. WHEN Trip_Member 或 Admin 送出的 Command 執行時，它的 Command_Id 已在這趟旅行的 Change_Log 中（例如回應在網路上遺失後重送，或第一次的請求還沒有回應就重送），THE LM_Server SHALL 不論這次的 Command 內容為何，都回傳第一次提交的 Seq 與 Change_Set 並標示為重送，不再執行、寫入或推送；Command_Id 只與同一趟旅行的 Change_Log 比對。
15. IF Command 被拒絕，THEN THE LM_Server SHALL 依需求 6 與各功能需求規定的原因回應 400、403、404 或 409，並附上可以直接顯示的說明（需求 5.5）；Database 保持不變、不推送、不使用新的 Seq，也不記錄這個 Command_Id。
16. IF 提交時 Database 的外鍵、唯一鍵或 CHECK 檢查失敗，THEN THE LM_Server SHALL 回滾整個提交、回應 500，並在伺服器記錄中記下錯誤；Database 保持不變、不推送、不使用新的 Seq，也不記錄這個 Command_Id，使以同一個 Command_Id 重送時重新執行。
17. THE LM_Server SHALL 在同一個資料庫交易中寫入一個 Command 造成的全部變化（Primary_Effect 與 Derived_Effect）、Change_Log 的記錄與新的 Head，全部寫入或全部不寫入；這次的 Change_Set 中每一列最多出現一次，每一列的 Row_Version 都等於這次的 Seq。
18. THE LM_Web SHALL 為每個新增的列與停靠點產生隨機的 UUID 作為 id，使新列在 LM_Server 回應之前就能顯示；在取得 LM_Server 指定的 Ordinal 之前，把預測的新列當成同一種列中最晚建立的一列排序。
19. THE LM_Server SHALL 在提交時為每個新增的列指定 Ordinal，並以 Ordinal 作為同一種列的建立順序（例如車輛的順序與清單中的先後）：Ordinal 在這趟旅行中嚴格遞增、不重複；同一次提交中，Primary_Effect 的新列依 Command 中的順序排在前面（例如一次加入的多個常用活動），Derived_Effect 的新列依 Shopping_Sync 新增品項的順序排在後面（先依料理的 Ordinal，再依食材在料理中第一次出現的順序）；修改既有列不改變它的 Ordinal。Shopping_Sync 新增的 Meal_Item 由 LM_Server 產生 id；Trip_Card、每日設定、出發確認與停靠點不使用 Ordinal。
20. IF 送到 `POST /api/trips/{id}/commands` 的請求內容不是 JSON、缺少 Command_Id 或 Command、Command_Id 不是 UUID、Command 不是已定義的種類，或欄位的值不是規定的型別（例如日期欄位不是有效的日期），THEN THE LM_Server SHALL 回應 400 與說明，不執行這個 Command，Database 保持不變，也不推送。
21. IF 一個 Command 要修改或勾選的既有列在執行時已不存在（例如已被其他成員先刪除），THEN THE LM_Server SHALL 回應 404 與指出找不到哪一種項目的說明（例如「找不到這個採買品項。」、「找不到這個裝備。」），不重新建立這一列，Database 保持不變，也不推送；儲存路線卡片與一天的設定在列不存在時新增，不適用這一條。
22. IF 新增旅伴、車輛、地點、活動、料理、採買品項、裝備、支出或還款的 Command 使用的 id 已被這趟旅行中同一種列使用（包括同一個 Command 中先新增的列），THEN THE LM_Server SHALL 回應 409 與說明，不覆寫既有的列，Database 保持不變，也不推送。

### Requirement 8: 資料儲存

**User Story:** 身為維護這個 App 的開發者，我希望每個項目各存成一列，每一列都屬於一趟旅行，以便多人可以同時修改不同項目，也不可能引用到別趟旅行的資料。

#### Acceptance Criteria

1. THE Database SHALL 把 Trip_State 存成一個項目一列，不存成單一的文字或 JSON 欄位：Trip_Card、旅伴、車輛、地點、路線、停靠點、每日設定、活動、料理、採買品項、裝備、出發確認、支出與還款各有自己的資料表；Trip_Card 存在旅行資料表中這趟旅行的那一列，每日設定每個 Trip_Day 最多一列，出發確認只為已確認出發的旅伴各存一列，確認被取消或撤回時刪除那一列。
2. THE Database SHALL 把車輛乘客、活動的指定旅伴與指定車輛、採買品項與料理的連結、裝備的打包勾選，以及支出的分攤旅伴存在子表：每一列是所屬的車輛、活動、採買品項、裝備或支出與一位旅伴、一台車或一道料理的組合，同一個組合最多一列，也不保存先後順序；活動在指定旅伴與指定車輛兩張子表都沒有列時代表全體旅伴，依需求 9.12 同一個活動最多只在其中一張子表有列；刪除所屬的列時，Database 一併刪除它的子表列，刪除路線時一併刪除它的停靠點。
3. THE Database SHALL 讓每張 Trip_Content_Table 的主鍵都包含旅行 id（每日設定以旅行 id 與日期為主鍵；出發確認以旅行 id 與旅伴 id；子表以旅行 id、所屬的列的 id 與被引用的列的 id；其他以旅行 id 與項目 id），並讓 Trip_Content_Table 之間的每個外鍵都同時比對旅行 id，使任何一列都不能引用別趟旅行的列：引用只存在於另一趟旅行的列的 Command（例如以旅行 A 的旅伴作為旅行 B 的車輛駕駛）由 LM_Core 依需求 9.1 與 9.2 拒絕，繞過 LM_Core 直接寫入時也在提交時被 Database 拒絕；以旅行 A 已使用的項目 id 在旅行 B 新增項目時，只在旅行 B 建立新的列，旅行 A 的列不變。
4. THE LM_Server SHALL 在 Trip_Card、旅伴、車輛、地點、路線、每日設定、活動、料理、採買品項、裝備、出發確認、支出與還款的每一列記錄 Row_Version：取得 Seq n 的提交新增一列或改變一列的內容時（包括 Derived_Effect），把那一列的 Row_Version 設為 n；刪除一列時，在 Change_Set 中以 Row_Version n 記錄這次刪除。停靠點與需求 8.2 的子表列沒有自己的 Row_Version，它們的新增、修改或刪除使所屬的路線、車輛、活動、採買品項、裝備或支出的 Row_Version 設為 n，例如勾選一件裝備已打包，使那件裝備的 Row_Version 變成 n。建立旅行時寫入的 Trip_Card 與建立者的 Person 的 Row_Version 為 0。
5. THE Database SHALL 以外鍵、唯一鍵與 CHECK 作為最後防線：Trip_Content_Table 之間的每個外鍵，以及旅伴的 Participant_Key、地點的 Place_Key、每台車每天一條路線、每條路線的停靠點位置這四個唯一鍵，都在提交時才檢查，使同一次提交中的寫入順序不影響結果（例如交換兩個停靠點的順序，或刪除旅伴並清除車輛與活動對他的引用）；一個 Account 在一趟旅行中最多一位 Bound_Person 也由唯一鍵保證；刪除一列時，除了需求 8.2 所說的它自己的子表列與停靠點，其他列對它的引用（例如路線與活動對車輛的引用、採買品項對料理的連結、支出對採買品項的連結）都不會被 Database 連帶刪除或修改，這些引用沒有在同一次提交中清除時，提交依需求 7.16 失敗。Command 被拒絕時，使用者看到的 400、403、404 與 409 訊息都在寫入之前由 LM_Core 產生，不來自 Database 的約束錯誤。
6. THE Database SHALL 以 Char_Count（PostgreSQL 的 `char_length()`）計算存入的文字（LM_Core 正規化之後的值）的長度，並讓每個文字長度、數值範圍與列舉值的 CHECK 都與 Limits_Table 及 Enum_Table 相同、時刻的 CHECK 只接受 Time_Value 的 00:00–23:59，使 LM_Core 接受的長度、範圍、列舉值與時刻 Database 也接受：例如 100 個「😀」（每個 4 個 UTF-8 位元組）的旅行名稱算 100 字而被接受，「👨‍👩‍👧」算 5 字；數量上限（例如 1000 道料理、每筆支出分攤 1–100 位）與支出分類只由 LM_Core 檢查。
7. THE Database SHALL 在 Change_Log 保存 Change_Feed 中的每一個 Change_Set，每次有變化的提交一列：旅行 id、Seq、Command_Id、提交者的 Account id、提交時間，以及完整的 Change_Set（包括 Ledger_Rows 與 `trip_deleted`；Change_Set 超過 65,536 位元組而改推送 Thin_Notice 時也保存完整內容），使每趟旅行的 Change_Log 恰好有 Seq 1 到 Head 各一列（Head 為 0 時沒有任何一列）、同一個 Command_Id 最多一列，被拒絕或沒有變化的 Command 不留下任何一列；第一版不修改也不刪除 Change_Log 的任何一列，包括旅行被刪除之後，以及要求的 Seq 落後 Head 超過 500 而改讀 Snapshot（需求 12.5）的時候。
8. WHEN Trip_Manager 刪除旅行，THE Database SHALL 在同一個交易中記錄刪除時間，並在 Change_Log 新增 Seq 為刪除前的 Head 加 1、`trip_deleted` 為真的 Change_Set；除了刪除時間、Head 與這個 Change_Set，Trip_State 的每一列與它們的 Row_Version、Change_Log 既有的每一列，以及這趟旅行的 Invite_Link 都保持不變，Database 也不實際刪除這趟旅行的任何一列，使旅行日後可以復原（第一版沒有復原旅行的畫面或 API）。
9. THE Local_Stack SHALL 從空資料庫開始：`supabase/seed.sql` 是 0 位元組的空檔，Migrations 不在任何資料表新增資料列，使開發者執行 `supabase db reset` 之後 Auth_Service 沒有任何使用者、`app` schema 的每張資料表都沒有任何列，第一個完成註冊的 Account 依需求 3.8 成為 Admin；第一版的 LM_Server 與 Migrations 都不讀取、也不匯入 Bun_App 的資料（包括現行 PostgreSQL 的 `trips.state_json`）。
10. WHEN 一次提交取得 Seq n，THE LM_Server SHALL 讓這次沒有新增、改變或刪除的每一列保持原本的內容與 Row_Version，例如勾選一個採買品項已買之後，同一趟旅行其他採買品項、料理與 Trip_Card 的 Row_Version 都不變；Trip_Card 的 Row_Version 只在名稱、目的地、起訖日期、介紹、小叮嚀、封面或狀態改變時設為 n，不隨 Head 前進。
11. WHILE 旅行已被刪除，THE LM_Server SHALL 讓任何 Account 在 Home_Page 的旅行列表都不包含這趟旅行、不再為這趟旅行新增 Change_Set（使 `trip_deleted` 為真的 Change_Set 是它在 Change_Log 中 Seq 最大的一列），並對再次刪除這趟旅行的請求回應 404「找不到這趟旅行。」、保留第一次記錄的刪除時間；兩個刪除請求同時送達時，較晚執行的那一個也得到這個 404。
12. IF 要寫入 Trip_State 的任何文字含有 U+0000，THEN THE LM_Core SHALL 在寫入 Database 之前以 400 拒絕，並說明文字含有無法儲存的字元（旅伴名字與地點名稱沿用需求 19.3 與 21.1 的訊息），使提交不會因為 Database 的文字欄位與 Change_Log 無法保存 U+0000 而失敗。

### Requirement 9: 資料一致性

**User Story:** 身為旅伴，我希望 App 不會存下互相矛盾的資料，以便每個分頁與文字版都能正確顯示。

#### Acceptance Criteria

1. IF 依需求 7.2 輪到一個 Command 執行時，把它的 Primary_Effect 與 Derived_Effect（包括其他需求規定的搬移、連帶清除與 Shopping_Sync）套用到當時最新的已提交 Trip_State，所得到的結果不滿足本需求第 2 至 13 條的任一條件，THEN THE Command_Executor SHALL 拒絕整個 Command：不寫入任何列（包括 Derived_Effect）、Head 不變、不寫入 Change_Log 也不推送，Trip_State 保持不變。
2. THE Trip_State SHALL 讓每個已設定的引用都指向同一趟旅行中存在的列：車輛的駕駛與乘客、活動的指定旅伴、料理的負責人、採買品項的負責人、共用裝備的負責人、裝備的打包勾選、出發確認、支出的付款人與分攤旅伴，以及還款的付款人與收款人指向旅伴；路線的車輛與活動的指定車輛指向車輛；路線的起點、終點與停靠點（使用 Destination_Place 的除外），以及每日設定的地點指向地點；每個停靠點屬於一條存在的路線；採買品項連動的料理指向料理；支出連結的採買品項指向採買品項；沒有設定的引用（例如車輛沒有駕駛、負責人待分配、每日設定沒有地點、支出不連結採買品項）不受本條限制。
3. THE Trip_State SHALL 讓旅伴的 Participant_Key 兩兩不同（例如「Amy」與「 amy 」算是同名）、地點的 Place_Key 兩兩不同（例如「ＡＢＣ營地」與「abc營地」算是同名），而且旅行目的地經 Trim_White 之後不是空的時，任何地點的 Place_Key 都不等於旅行目的地的 Place_Key；旅行目的地經 Trim_White 之後是空的時，不做這項比較。
4. THE Trip_State SHALL 讓同一台車在同一個 Trip_Day 最多有一條路線、每條路線有 0 至 6 個停靠點，而且每個停靠點的 id 在整趟旅行的所有路線中只出現一次。
5. THE Trip_State SHALL 只在旅行目的地經 Trim_White 之後不是空的時，讓路線的起點、終點或停靠點使用 Destination_Place；每日設定的地點只能是地點清單中的地點或未設定（未設定代表跟著旅行目的地），不使用 Destination_Place。
6. THE Trip_State SHALL 讓每筆活動、每道料理、每條路線與每個每日設定的日期 d 都滿足「旅行開始日 ≤ d ≤ 旅行結束日」（包含兩端）；支出與還款的日期不受此限。
7. THE Trip_State SHALL 讓每台車的乘客互不重複、不包含這台車的駕駛，而且不論是否指定駕駛，乘客人數加 1 都不超過座位數（例如 5 人座的車最多 4 位乘客，1 人座的車沒有乘客）。
8. THE Trip_State SHALL 讓每個個人裝備都沒有負責人，每個共用裝備的打包勾選是空的或只有它的負責人一人，因此負責人待分配的共用裝備沒有任何打包勾選。
9. THE Trip_State SHALL 讓每位旅伴最多有一筆出發確認，而且有出發確認的旅伴都滿足 Can_Depart：他的 My_Gear 中每個裝備的打包勾選都包含他，而且這趟旅行沒有負責人待分配的共用裝備（My_Gear 是空的時只需要後者）；新增旅伴、移除旅伴、新增、修改或刪除裝備，以及取消打包的 Command 依需求 19.9、19.12、27.5 與 27.8 刪除出發確認來維持本條，不因本條而被拒絕。
10. WHEN LM_Server 提交任何 Command（包括不執行 Shopping_Sync 的 Command），THE Trip_State SHALL 讓提交後的內容滿足：每道料理需要的每個 Ingredient_Key（食材經 Ingredient_Parser 切出的名稱的鍵）都由某個採買品項涵蓋，也就是那個品項的名稱經 Ingredient_Parser 切出的名稱中，有一個的 Ingredient_Key 與它相同；每個未買的 Meal_Item 都至少連動一道料理；每個採買品項連動的料理都存在；LM_Web 預測時不執行 Shopping_Sync，Optimistic_View 在套用 LM_Server 回應或推送的這個 Command 的 Change_Set 之前不受本條限制。
11. THE Trip_State SHALL 讓每筆支出的付款人與每位分攤旅伴、每筆還款的付款人與收款人都是這趟旅行存在的旅伴，每筆支出的分攤旅伴互不重複，而且每筆還款的付款人與收款人是兩位不同的旅伴。
12. THE Trip_State SHALL 讓每筆活動的參加者是全體旅伴、指定旅伴或指定車輛三者之一：指定車輛的活動沒有指定旅伴，指定旅伴的活動也沒有指定車輛。
13. THE Trip_State SHALL 讓每一種列的數量都不超過 Limits_Table：旅伴最多 100 位、地點最多 100 個、活動最多 1000 筆、料理最多 1000 道、採買品項最多 1000 項（包括 Shopping_Sync 新增的 Meal_Item）、裝備最多 1000 項、支出與還款各最多 1000 筆，而且每筆支出有 1 至 100 位分攤旅伴；數量剛好等於上限時仍然成立。
14. WHEN 兩個 Command 各自套用到同一份 Trip_State 都會被接受，但依需求 7.2 的提交順序執行時，後執行的 Command 會使結果不滿足第 2 至 13 條（例如兩位成員同時新增 Participant_Key 相同的旅伴、同時為同一台車在同一天新增路線、同時把不同的乘客加進只剩一個空位的車，或一人刪除地點時另一人儲存使用這個地點的路線），THE Command_Executor SHALL 提交先執行的 Command，並依第 1 條拒絕後執行的 Command，使 Trip_State 等於只提交先執行的 Command 的結果；這種情況不適用需求 7.5 至 7.7 保留兩者修改的規則。
15. WHEN 一次提交刪除一個仍被支出連結的採買品項（Trip_Manager 刪除品項，或 Shopping_Sync 移除品項），THE LM_Server SHALL 依需求 29.13 在同一次提交中清除這些支出的採買連結，使這個 Command 不因第 2 條而被拒絕。
16. IF 一個 Command 的結果不滿足第 2 至 13 條，THEN THE LM_Server SHALL 依序決定回應：這個 Command 同時符合需求 6.2 至 6.4 的拒絕條件時，回應那裡的 403 或 404（例如 Collaborator 刪除仍有路線的車輛時，回應 403「受邀旅伴可以編輯，但不能刪除既有項目；請聯絡主辦人或管理員。」，不回應 409）；否則，違反的條件在其他需求中有對應的拒絕規則時（例如需求 19.6、19.14、20.6、21.4、22.4、25.15 與 28.3），回應那條規則的狀態與訊息；兩者都沒有時，回應 409「資料驗證未通過，沒有儲存。」。

### Requirement 10: 即時推送

**User Story:** 身為旅伴，我希望其他人修改料理菜單或任何分頁、勾選任何項目時，變更不需重新載入就出現在我的畫面上，以便大家看到的是同一份最新的內容。

#### Acceptance Criteria

1. WHEN 一次有變化的提交完成（一個 Command，或依需求 30.10 與 30.12 以 Invite_Link 加入旅行；刪除旅行見需求 10.8），THE LM_Server SHALL 在寫入列變化的同一個資料庫交易中，以 Head 加 1 作為這次的 Seq、把 Change_Set 寫入 Change_Log 一列並把 Head 設為這個 Seq，並由 Database 在同一個交易中排入一則把 Change_Set 送往這趟旅行 Trip_Channel 的 `changeset` 事件（過大時依需求 10.4 改送 Thin_Notice），交易提交之後才送出，其他旅行的 Trip_Channel 收不到；建立與撤銷 Invite_Link 不改變 Trip_State，不產生 Change_Set。
2. IF 寫入 Change_Set 的交易回滾（例如提交時外鍵、唯一鍵或 CHECK 檢查失敗，需求 7.16），THEN THE Database SHALL 不送出這個 Change_Set，也不送出它的 Thin_Notice，Change_Log 與 Head 都保持不變，使下一次有變化的提交仍使用同一個 Seq。
3. THE LM_Server SHALL 把一次提交造成的全部變化（包括 Shopping_Sync 的 Derived_Effect）放在同一個 Change_Set，使接收者一次套用，不會看到料理已改而採買清單還沒改的中間狀態：修改料理食材時，Change_Set 包含那道料理，以及 Shopping_Sync 新增、更新或刪除的每個採買品項；修改旅行日期時，包含 Trip_Card 與 Retime 搬動或移除的每一列；Change_Set 中每一列最多出現一次，內容是那一列提交後的完整內容（格式與 Snapshot 中的同一列相同，子表的變化以所屬列的完整內容表示）或刪除，Row_Version 等於這個 Change_Set 的 Seq。
4. IF Change_Set 的 JSON 超過 65,536 位元組（以 Change_Log 保存的 Change_Set 轉成 JSON 文字後的 UTF-8 位元組數計算），THEN THE Database SHALL 在同一個 Trip_Channel 以同樣的 `changeset` 事件改送 Thin_Notice，內容是旅行 id 與 Seq、不含任何列的內容，並照常在 Change_Log 保存完整的 Change_Set，使接收者依需求 12.4 以 `GET /api/trips/{id}/changes` 取得完整內容；剛好 65,536 位元組時照常送出完整的 Change_Set。
5. WHILE 瀏覽器分頁已有這趟旅行的 Replica 並顯示 Trip_Page 或 Departure_Page，WHEN 它收到 Seq 大於 Watermark、`trip_deleted` 為假的 Change_Set，THE LM_Web SHALL 不重新載入頁面，在同一次畫面更新中套用其中全部的列變化並顯示套用後的 Optimistic_View（需求 13.6），不顯示只套用一部分列變化的畫面：新增的列出現、刪除的列消失、修改的列顯示新內容，需求 14.5 的整塊結果一併重算，範圍包括旅行封面與倒數、Trip_Page 的五個分頁、Trip_Menu 中的旅伴與車輛，以及 Departure_Page；Seq 等於 Watermark 加 1 時不發出任何 HTTP 請求，之後切換 Trip_Page 的分頁或前往 Departure_Page 時也不重新讀取 Snapshot；Unbound_Admin 依需求 6.13 先丟棄其中的 Ledger_Rows，開啟中的表單依需求 14.4 與 14.6 處理。
6. WHILE 兩個以這趟旅行的 Trip_Member 登入（相同或不同的 Account）的瀏覽器分頁與 LM_Server 在同一台電腦上（例如開發機上的兩個瀏覽器視窗）或同一個區域網路中，兩者都已加入 Trip_Channel 並完成補齊、都在前景可見，而且接收的瀏覽器分頁沒有修改同一列同一個欄位的 Pending_Command，WHEN 其中一個瀏覽器分頁在沒有其他 Pending_Command 時送出 Command，而且提交成功並有變化，THE LM_Web SHALL 在提交者完成操作（例如點下勾選或按下儲存）後 2 秒內，讓另一個瀏覽器分頁目前顯示的 Trip_Page 分頁或 Departure_Page 中受這次 Change_Set 影響的內容都顯示提交後的結果；Change_Set 超過 65,536 位元組而改送 Thin_Notice 時也在 2 秒內。
7. IF 提交時這趟旅行的 Trip_Channel 沒有任何連線者，或 Realtime_Service 沒有執行，THEN THE LM_Server SHALL 照常完成提交並回應成功、不等待推送送達，回應的 Seq 與 Change_Set 與有連線者時相同，並在 Change_Log 保存這個 Change_Set；之後加入 Trip_Channel 的瀏覽器分頁依需求 12 補齊後顯示這次的變更。
8. WHEN Trip_Manager 刪除旅行，THE LM_Server SHALL 在記錄刪除時間的同一個交易中，以 Head 加 1 作為 Seq，寫入並推送 `trip_deleted` 為真、不含任何列變化的 Change_Set；之後這趟旅行不再產生 Change_Set，再次刪除時（包括兩位 Trip_Manager 同時刪除時較晚執行的請求）回應 404「找不到這趟旅行。」，不寫入也不推送。
9. THE LM_Web SHALL 只由 Change_Feed（Trip_Channel 的推送，以及需求 12 所列情形的補齊）取得其他成員，以及同一個 Account 在其他瀏覽器分頁或裝置的變更；在讀取旅行資料（Snapshot、增量的 Change_Set 與 Head）的請求中，只有需求 12.7 在瀏覽器分頁可見期間每 60 秒讀取一次 Head 是以固定間隔發出，Snapshot 與增量的 Change_Set 只在需求 12 所列的情形讀取。
10. WHEN 瀏覽器分頁在記憶體中沒有這趟旅行的 Replica 時開啟 Departure_Page（例如直接開啟或重新整理 `/<帳號名稱>/trips/<id>/go`），THE LM_Web SHALL 依需求 11.3 與 12.1 加入這趟旅行的 Trip_Channel 並讀取 Snapshot，不需要先開啟 Trip_Page。
11. THE LM_Server SHALL 讓 Trip_Member 取得的同一個 Seq 的 Change_Set，在 Trip_Channel 的推送（Thin_Notice 除外）、Command 的回應（包括需求 7.14 的重送）與 `GET /api/trips/{id}/changes` 的回應中，旅行 id、Seq、Command_Id、提交者、提交時間、每一列的變化與 `trip_deleted` 都相同。
12. WHILE 瀏覽器分頁顯示 Departure_Page，WHEN 它收到 `trip_deleted` 為真的 Change_Set，THE LM_Web SHALL 依需求 12.13 離開 Departure_Page 並前往 Home_Page。

### Requirement 11: Trip_Channel 的授權與連線

**User Story:** 身為旅伴，我希望只有同一趟旅行的成員能收到這趟旅行的即時變更，而且連線中斷時會自動恢復，以便資料不外流，也不必手動重新整理。

#### Acceptance Criteria

1. THE LM_Web SHALL 只連到載入 LM_Web 的同一個來源（LM_Server；開發時是依需求 2.5 代理到 LM_Server 的 `trunk serve`），不直接連到 Supabase_Stack 的任何位址：API 使用 `/api/*`，Realtime 以與頁面相同的主機與埠連到 `/realtime/v1/websocket?vsn=1.0.0`（頁面為 http 時用 ws，https 時用 wss）。
2. WHEN 瀏覽器連到 `/realtime/v1/websocket`，THE LM_Server SHALL 連到 Realtime_Service 的 WebSocket（轉送前不檢查使用者登入，頻道的授權由需求 11.4 決定）：上游網址的查詢參數只保留瀏覽器送來的 `vsn`，再加上值為 `SUPABASE_ANON_KEY` 的 `apikey`，瀏覽器送來的 `apikey` 與其他參數都不轉送；連上之後不解析也不修改內容，雙向逐一轉送文字、二進位、ping、pong 與關閉訊框，任一端關閉時也關閉另一端。
3. WHEN LM_Web 開啟 Trip_Page 或 Departure_Page，THE LM_Web SHALL 以私有頻道加入這趟旅行的 Trip_Channel，頻道名稱為 `trip:` 加上旅行 id 的小寫 UUID 文字，並附上 Session 目前的 access token 與這個瀏覽器分頁的 Presence_Key。
4. THE Realtime_Service SHALL 在加入 Trip_Channel 時，以及連線期間收到新的 access token 時判斷下列條件，只讓以私有頻道加入、而且全部符合的連線加入 Trip_Channel 並接收其中的 broadcast 與 presence：附上由 Auth_Service 簽發、尚未過期的 access token；這個 access token 的 Account 是這趟旅行的 Trip_Member，或是任一 Admin；這趟旅行存在而且沒有被刪除；頻道名稱恰好是 `trip:` 加上以連字號分成 8-4-4-4-12 位的小寫十六進位 UUID。
5. THE Realtime_Service SHALL 只接受符合需求 11.4 條件的連線在 Trip_Channel 送出的 presence，並丟棄任何用戶端（包括 Trip_Member 與 Admin）在 Trip_Channel 送出的 broadcast、不轉給任何連線者，使 Trip_Channel 上的 broadcast 只有 Database 發出的 Change_Set 與 Thin_Notice。
6. WHILE Realtime 的 WebSocket 已連線，THE LM_Web SHALL 從連線開啟起每隔 20 秒送出一次 heartbeat。
7. WHILE 使用者開著 Trip_Page 或 Departure_Page，IF WebSocket 斷線或無法建立、送出的 heartbeat 在 20 秒內（下一次該送 heartbeat 之前）沒有收到回覆、送出加入要求後 10 秒內沒有收到回覆、Trip_Channel 回報錯誤、Realtime_Service 在 LM_Web 沒有要求離開時關閉 Trip_Channel（需求 11.9 的情況除外），或 Realtime_Service 以需求 11.8 與 11.10 以外的原因（例如服務暫時無法使用）拒絕加入，THEN THE LM_Web SHALL 重新連線：heartbeat 沒有收到回覆時先關閉這條 WebSocket；連續的第 1 至 4 次重試分別在 1、2、5、10 秒後進行，第 5 次起每次都在 10 秒後進行，間隔從偵測到上述情況時起算，並各加上 0–20% 的隨機延長（例如 5 秒的間隔實際為 5–6 秒）；同時出現的多個上述情況只算一次；每次重試時，WebSocket 已關閉就先重新建立，再重新加入 Trip_Channel；重新加入成功之後，下一次中斷又從 1 秒的間隔開始。
8. IF 加入 Trip_Channel 時 Realtime_Service 回報 access token 已過期，THEN THE LM_Web SHALL 換發 Session，並在換發成功後立即以新的 access token 重新加入；換發後的這次加入仍回報 access token 已過期時，改依需求 11.7 的間隔重試；換發失敗時依需求 4.9 處理。
9. WHEN 連線期間 Realtime_Service 通知 access token 已過期並關閉 Trip_Channel，THE LM_Web SHALL 換發 Session，在換發成功後立即以新的 access token 重新加入 Trip_Channel，並依需求 12 補齊；換發失敗時依需求 4.9 處理。
10. IF Realtime_Service 回報沒有加入這個 Trip_Channel 的權限（需求 11.4 中 Account、旅行或頻道名稱的條件不成立，例如旅行已刪除），THEN THE LM_Web SHALL 不再重試加入這趟旅行的 Trip_Channel，離開目前的 Trip_Page 或 Departure_Page 並前往 Home_Page，顯示「你已無法存取這趟旅行。」。
11. WHILE Trip_Channel 正在重新連線，也就是從需求 11.7 或 11.9 的情況發生起，到重新加入 Trip_Channel 並依需求 12 補齊為止，THE LM_Web SHALL 在 Trip_Page 或 Departure_Page 的頂端顯示「重新連線中，畫面可能不是最新」，並照常經 HTTP 送出 Command；重新加入並補齊之後移除這個提示。
12. IF LM_Server 無法建立到 Realtime_Service 的上游連線（例如 Realtime_Service 沒有啟動或拒絕連線），THEN THE LM_Server SHALL 關閉瀏覽器的這條 WebSocket，使 LM_Web 依需求 11.7 重新連線。
13. WHEN 使用者從 Trip_Page 或 Departure_Page 前往這趟旅行的 Trip_Page 與 Departure_Page 以外的頁面（例如 Home_Page、另一趟旅行或 `/login`），THE LM_Web SHALL 離開這趟旅行的 Trip_Channel，使這個瀏覽器分頁的 Presence_Meta 從其他成員的 Presence 中移除，之後也不再為這趟旅行重新連線或重新加入。
14. WHILE 瀏覽器離線，THE LM_Web SHALL 在畫面頂端以需求 13.11 的離線提示取代需求 11.11 的提示，不同時顯示兩個提示。

### Requirement 12: 補齊與收斂

**User Story:** 身為旅伴，我希望斷線、分頁休眠或漏收訊息之後，畫面會自動補上所有變更，以便我看到的內容和其他人一樣，不漏掉任何修改。

#### Acceptance Criteria

1. WHEN LM_Web 在記憶體中沒有這趟旅行的 Replica 時開啟 Trip_Page 或 Departure_Page，THE LM_Web SHALL 先加入 Trip_Channel，收到 Realtime_Service 加入成功的回覆之後才以 `GET /api/trips/{id}/snapshot` 讀取 Snapshot，並以它建立 Replica，使 Watermark 不小於這個 Snapshot 的 Seq；加入成功之後、Snapshot 回應之前從 Trip_Channel 收到的 Change_Set 不丟棄，依本需求第 10 條與 Snapshot 合併；加入被拒絕時不讀取 Snapshot，依需求 11.8 或 11.10 處理。
2. WHEN LM_Web 在已有 Replica 時重新加入 Trip_Channel，THE LM_Web SHALL 在收到加入成功的回覆之後，以 `GET /api/trips/{id}/changes?after=<Watermark>` 讀取 Watermark 之後的 Change_Set，並依本需求第 10 條合併；Watermark 為 0 時改為讀取 Snapshot。
3. IF LM_Web 合併從 Trip_Channel 收到的，或 `GET /api/trips/{id}/changes` 回應中的 Change_Set 之後，已套用的 Seq 中仍有大於 Watermark 的值（例如收到的 Change_Set 的 Seq 大於 Watermark 加 1），THEN THE LM_Web SHALL 保留已合併的變化，並立即（不等待下一則推送或下一次 Head 比對）以 `GET /api/trips/{id}/changes?after=<Watermark>` 讀取缺少的 Change_Set。
4. WHEN LM_Web 從 Trip_Channel 收到 Seq 大於 Watermark 的 Thin_Notice，或收到內容無法解析成 Change_Set 或 Thin_Notice 的 broadcast，THE LM_Web SHALL 以 `GET /api/trips/{id}/changes?after=<Watermark>` 讀取 Watermark 之後的 Change_Set 並合併；Seq 不大於 Watermark 的 Thin_Notice 不觸發任何讀取。
5. IF Trip_Member 或 Admin 以 `GET /api/trips/{id}/changes?after=N` 讀取未被刪除的旅行時，這趟旅行的 Head 減 N 大於 500，THEN THE LM_Server SHALL 回應 `snapshot_required` 與目前的 Head，不附任何 Change_Set；Head 減 N 等於 500 時照常依本需求第 15 條回應 500 個 Change_Set。
6. WHEN LM_Server 回應 `snapshot_required`，THE LM_Web SHALL 讀取 Snapshot 並依本需求第 10 條合併，合併後 Watermark 不小於這個 Snapshot 的 Seq。
7. WHEN 瀏覽器分頁從隱藏變為可見（`visibilitychange` 事件）、瀏覽器觸發 `online` 事件，或分頁可見期間每隔 60 秒，THE LM_Web SHALL 以 `GET /api/trips/{id}/head` 讀取 Head，在 Head 大於 Watermark 時依本需求第 2 條的方式補齊（讀取 Watermark 之後的 Change_Set；Watermark 為 0 時讀取 Snapshot），Head 不大於 Watermark 時不讀取 Change_Set 與 Snapshot；分頁隱藏期間不做每 60 秒的讀取。
8. WHEN Trip_Member 或 Admin 以 `GET /api/trips/{id}/snapshot` 讀取未被刪除的旅行，THE LM_Server SHALL 在一個 REPEATABLE READ 唯讀交易中讀出這趟旅行在當下 Head 的完整 Trip_State（每一列附上 Row_Version；檢視者是 Unbound_Admin 時依需求 6.12 不含 Ledger_Rows），以這個 Head 作為 Snapshot 的 Seq，並附上檢視者的 Account id、帳號名稱、Display_Name、角色、在這趟旅行的 Bound_Person（沒有時為空），以及是否為 Trip_Manager。
9. WHEN Trip_Member 或 Admin 以 `GET /api/trips/{id}/head` 讀取未被刪除的旅行，THE LM_Server SHALL 回應這趟旅行目前的 Head；還沒有任何有變化的提交時，Head 為 0。
10. THE LM_Web SHALL 依下列規則合併 Change_Set 與 Snapshot，使重複送達、亂序送達與 Snapshot 重疊都不改變結果：每一列只保留 Row_Version 最大的內容，刪除也算一次修改，所以被刪除的列不會因為 Row_Version 較小的變更而重新出現；Seq 不大於 Watermark 或已經套用過的 Change_Set，以及 Seq 不大於 Watermark 的 Snapshot，整則不改變 Replica；合併 Seq 為 s 的 Snapshot 時，Replica 中有、Snapshot 中沒有、而且 Row_Version 不大於 s 的列視為在 s 之前已被刪除。
11. THE LM_Web SHALL 讓 Watermark 等於使 Seq 1 到 w 的 Change_Set 都已反映在 Replica（逐則套用，或包含在已合併的 Snapshot 中）的最大 w（還沒有合併任何 Snapshot 或 Change_Set 時為 0，之後只增不減），並在已套用的 Seq 中有大於 Watermark 的值時，以「Watermark 加 1」到「其中最小的 Seq 減 1」作為第一段缺少的 Seq 範圍。
12. WHEN 一趟旅行 Seq 1 到 n 的 Change_Set 以任意順序與次數送達、其間夾雜任意 Seq（0 到 n）的 Snapshot，而且 Seq 大於已送達 Snapshot 中最大 Seq（沒有 Snapshot 時為 0）的每個 Change_Set 都至少送達一次，THE LM_Web SHALL 得到與 LM_Server 在 Seq n 時相同的 Trip_State（檢視者是 Unbound_Admin 時依需求 6.12 與 6.13 不含 Ledger_Rows），而且 Watermark 為 n。
13. WHEN LM_Web 收到 `trip_deleted` 為真的 Change_Set，THE LM_Web SHALL 離開 Trip_Channel 與目前的 Trip_Page 或 Departure_Page、前往 Home_Page，並顯示「這趟旅行已被刪除。」。
14. WHEN 開著同一趟旅行的每個 Trip_Member 分頁的 Watermark 都等於 LM_Server 目前的 Head，而且都沒有 Pending_Command，THE LM_Web SHALL 讓這些分頁的 Replica 與畫面上的 Optimistic_View 都等於 LM_Server 在這個 Head 的 Trip_State。
15. WHEN Trip_Member 或 Admin 以 `GET /api/trips/{id}/changes?after=N` 讀取未被刪除的旅行，而且 Head 減 N 不大於 500，THE LM_Server SHALL 回應 Head，以及 Seq 大於 N 且不大於這個 Head 的每一個 Change_Set，依 Seq 遞增排列、每個 Seq 恰好一個；N 不小於 Head 時清單是空的；依需求 6.12 省略 Ledger_Rows 之後沒有任何列變化的 Change_Set 仍以它的 Seq 保留在清單中。
16. IF LM_Server 對 LM_Web 讀取 Snapshot、增量 Change_Set 或 Head 的請求回應 404（例如旅行已被刪除，但 `trip_deleted` 的推送沒有送達），THEN THE LM_Web SHALL 停止補齊、離開 Trip_Channel 與目前的 Trip_Page 或 Departure_Page、前往 Home_Page，並顯示 LM_Server 回應的訊息「找不到這趟旅行。」。
17. IF LM_Web 讀取 Snapshot、增量 Change_Set 或 Head 的請求發生網路錯誤、逾時或 5xx 回應，THEN THE LM_Web SHALL 不因這次失敗改變 Replica 與 Watermark，並在下一次發生本需求第 3、4 或 7 條的事件，或重新加入 Trip_Channel 時再次補齊；還沒有 Replica 時，下一次改為直接讀取 Snapshot，不先比對 Head。

### Requirement 13: 樂觀更新、回復與重試

**User Story:** 身為旅伴，我希望操作後畫面立刻更新，被伺服器拒絕時自動還原並說明原因，網路不穩時自動重試，以便操作順手，畫面也不會留下錯誤的內容。

#### Acceptance Criteria

1. WHEN 使用者的操作產生一個 Command（例如勾選、儲存表單、新增或刪除項目），THE LM_Web SHALL 先以 LM_Core 在目前的 Optimistic_View 上檢查 Command 並計算 Primary_Effect；Command 成立時為它產生新的 Command_Id、把它加到送出佇列的最後成為 Pending_Command，並在送出 HTTP 請求之前、不等待 LM_Server 回應，就把 Primary_Effect 顯示在畫面上。
2. IF LM_Core 在送出前判斷 Command 不成立，THEN THE LM_Web SHALL 不建立 Pending_Command、不送出請求、讓畫面維持原本的 Optimistic_View（例如勾選框回到原本的勾選狀態），並在同一次操作中顯示 LM_Core 回報的訊息：操作來自表單時，訊息顯示在表單的錯誤訊息區，表單保持開啟並保留已填寫的內容；其他操作以 Toast 顯示。
3. THE LM_Web SHALL 在每個分頁依使用者操作的先後順序逐一送出 Pending_Command：同一時間最多只有一個 Command 的請求在進行中；排在最前面的 Pending_Command 有了結果（第 14 條的成功回應、第 8 條的拒絕、第 10 條的放棄或第 13 條的確認），而且它沒有進行中的請求之後，才送出下一個；它等待重送的期間，後面的 Pending_Command 也不送出。
4. THE LM_Web SHALL 在預測時只計算 Primary_Effect、不執行 Shopping_Sync；Derived_Effect 只在包含它的 Change_Set（LM_Server 的成功回應、Trip_Channel 的推送或補齊）合併到 Replica 之後才出現在畫面上，例如新增料理之後，衍生的採買品項在這之前不出現在 Shopping_Tab。
5. THE LM_Core SHALL 讓同一個 Command 在相同的 Trip_State、提交者與權限下，於 LM_Web 預測與 LM_Server 提交時得到相同的 Primary_Effect；預測不成立的 Command 提交時也不成立；提交時唯一可能多出的拒絕，是 Shopping_Sync 使採買品項超過 1000 項時，需求 25.15 的 409「採買品項最多 1,000 項，請減少食材或整理採買清單後再儲存。」。檢視者是 Unbound_Admin 時，LM_Web 預測所用的 Trip_State 依需求 6.12 與 6.13 不含 Ledger_Rows，與 LM_Server 提交時的 Trip_State 不同，所以另有一種只在提交時出現的拒絕：移除仍是支出或還款當事人的旅伴時，需求 19.14 的 409。
6. THE LM_Web SHALL 在畫面上顯示 Optimistic_View，並在 Replica 合併 Change_Set 或 Snapshot、Pending_Command 加入或移除時重新計算（讀取 Snapshot 不會移除 Pending_Command）；沒有 Pending_Command 時，畫面等於 Replica；其他分頁（其他成員或自己的其他分頁）送出的 Change_Set 在自己有 Pending_Command 時合併，畫面同時顯示對方的變更與自己 Pending_Command 的 Primary_Effect；兩者改到同一個欄位時，在自己的 Command 有結果之前顯示自己的值。
7. WHILE 一個 Pending_Command 在「Replica 依序疊上排在它前面、而且成立的 Pending_Command 的 Primary_Effect」之後不成立，THE LM_Web SHALL 不在畫面上顯示它的 Primary_Effect，但把它留在送出佇列中依序送出、依 LM_Server 的回應處理，並在每次重新計算 Optimistic_View 時重新判斷（例如自己勾選已買的 Command 送出之前，另一位成員刪除了這個採買品項：品項從畫面消失，勾選照常送出，LM_Server 以 404「找不到這個採買品項。」拒絕後依第 8 條處理）。
8. IF LM_Server 以 400、403、404 或 409 拒絕 Command，THEN THE LM_Web SHALL 移除這個 Pending_Command 且不重送，使畫面等於 Replica 只疊上其餘 Pending_Command 的 Optimistic_View，以 Toast 顯示回應中的訊息（需求 5.5 的 `message`），再依序送出其餘的 Pending_Command。
9. IF 送出 Command 時發生網路錯誤、逾時（送出後 15 秒內沒有收到回應，LM_Web 隨即停止等待）或 5xx 回應，THEN THE LM_Web SHALL 保留這個 Pending_Command 與它在畫面上的 Primary_Effect，在畫面頂端顯示「儲存失敗，正在重試」直到這個 Command 有了結果，並以同一個 Command_Id 與相同的內容重送：第 1 至第 5 次重送分別在前一次失敗後 1、2、4、8、16 秒送出；API 回應 401 時改依需求 4.8 與 4.9 處理，換發 Session 後的重試不計入重送次數；瀏覽器離線時改依第 11 與第 12 條處理。
10. IF 第 5 次重送（同一個 Command 的第 6 次送出）仍發生第 9 條的失敗，THEN THE LM_Web SHALL 移除這個 Pending_Command，使畫面等於 Replica 只疊上其餘 Pending_Command 的 Optimistic_View，以 Toast 顯示「儲存失敗，變更已還原」，再送出下一個 Pending_Command；若這個 Command 其實已經提交，它的 Change_Set 之後經 Trip_Channel 或補齊送達時，照常依需求 12 合併並顯示。
11. WHILE 瀏覽器回報沒有網路連線，THE LM_Web SHALL 暫停送出與重送 Command（離線期間發生的失敗不計入第 10 條的重送次數）、把 Pending_Command 保留在記憶體中（關閉或重新載入分頁後不保留）、照常依第 1 條處理新的操作，並在畫面頂端顯示「離線中，有 N 項變更尚未送出」，代替「儲存失敗，正在重試」與需求 11.11 的「重新連線中，畫面可能不是最新」；N 為目前 Pending_Command 的數量，數量改變時同時更新，N 為 0 時只顯示「離線中」。
12. WHEN 瀏覽器回報恢復上線，THE LM_Web SHALL 不等待剩餘的退避時間，依原本的順序、以原本的 Command_Id 與內容逐一重送 Pending_Command，並重新從 0 計算第 10 條的重送次數。
13. WHEN 某個 Pending_Command 還沒得到 LM_Server 的成功回應時，Command_Id 與它相同的 Change_Set 先經 Trip_Channel 或補齊（需求 12）送達，THE LM_Web SHALL 合併這個 Change_Set、移除這個 Pending_Command，並取消它尚未進行的重送；之後這個 Command 的 HTTP 回應或失敗都不再改變畫面，也不顯示「儲存失敗，正在重試」或「儲存失敗，變更已還原」。
14. WHEN LM_Server 對仍在送出佇列中的 Pending_Command 回應成功，THE LM_Web SHALL 把回應中的 Change_Set 合併到 Replica（同一個 Command_Id 重送後得到的第一次提交也一樣，見需求 7.14）、移除這個 Pending_Command，使畫面等於新的 Replica 疊上其餘 Pending_Command 的 Optimistic_View；回應表示沒有變化（需求 7.12）時不合併任何內容，只移除這個 Pending_Command。

### Requirement 14: 只重繪變更的項目

**User Story:** 身為旅伴，我希望別人修改一個項目時，我的畫面上只有那個項目更新，以便捲動位置、展開狀態與正在填寫的表單都不被打斷。

#### Acceptance Criteria

1. WHEN Change_Set、Snapshot，或 Pending_Command 的加入、確認與回復改變了 Optimistic_View，THE LM_Web SHALL 只更新內容（不計 Row_Version）改變了的列的元素；其他列的元素維持同一個 DOM 節點、也不被修改，唯一的例外是其中顯示這些列的資料、或由這些列推導出的資料的文字與屬性（例如旅伴改名時各處顯示這位旅伴名字的文字、路線改變時採買品項的採買地點）；只有 Row_Version 不同的列（例如自己的 Pending_Command 得到確認，而內容與預測相同）視為沒有改變。
2. WHEN Optimistic_View 中新增或移除了一列（包括 Pending_Command 被拒絕而撤銷的新增或刪除），THE LM_Web SHALL 只建立或移除那一列的元素，新元素依該清單的排序規則插入，其他列的元素只依第 1 條更新；每日設定的區塊依 Trip_Day 顯示，每日設定被移除時保留那一天的區塊，改為顯示未設定的內容。
3. WHEN 一列的排序或分組欄位改變（例如採買品項換分類、裝備換範圍、活動換日期或時間、料理換日期或餐次、路線換日期或出發時間、支出或還款換日期，或自己新增的列得到 LM_Server 指定的 Ordinal），THE LM_Web SHALL 只把那一列的元素移到新的位置：同一組內移動原本的元素；換組時從原來的組移除、在新的組建立；移出或移入目前沒有顯示的範圍（例如 Schedule_Tab 選定日子以外的一天）時只移除或只建立；其他列的元素只依第 1 條更新。
4. WHEN Optimistic_View 或 Presence 的狀態改變，THE LM_Web SHALL 保留捲動位置（依第 10 條）、Trip_Page 目前的分頁（例如料理菜單）、每張卡片與每個可展開區塊的展開或收合狀態（包括依第 3 條移到別處的列）、開啟中的表單與選單（例如 Trip_Menu）、鍵盤焦點（所在的元素沒有被移除時）、輸入中的內容（表單內依第 6 條，表單外依第 11 條），以及 Schedule_Tab 選定的 Trip_Day（旅行日期改變時依需求 22.16）；開啟中的表單不因這些改變而關閉，第 9 條與依需求 11.10、12.13 離開 Trip_Page 的情況除外。
5. WHEN Optimistic_View 改變，THE LM_Web SHALL 由改變後的 Optimistic_View 重新計算 Itinerary_Text、Unassigned_Shopping、分帳餘額與建議轉帳、裝備進度、出發清單，以及由多列算出的數量（例如每組的項目數與待分配的數量），並與第 1 至 3 條的列在同一次更新中顯示，使畫面不會出現列已更新、這些區塊卻仍是舊結果的狀態；這些區塊可以整塊更新，不受第 1 條的限制。
6. WHILE 使用者開著某個 Editable_Item 的編輯表單（不論是否改過欄位，也包括按下「仍要編輯」之前的唯讀狀態），WHEN Remote_Change 改變了這一項的內容，THE LM_Web SHALL 保留表單中每個欄位目前的值、不以新的內容覆蓋（這一項因此移到別的位置或分組時也一樣），並在表單上方以 `role="status"` 顯示「{旅伴名稱}剛更新了這一項」直到表單關閉；旅伴名稱是 Change_Set 提交者的 Presence_Meta 所回報的 Bound_Person 在 Optimistic_View 中的名字，依套用這次變化當下的 Presence 狀態決定；之後再有 Remote_Change 改變這一項時，提示改以最近一次（同時套用多個 Change_Set 時為 Seq 最大者）為準。
7. IF 依第 6 條找不到修改者的旅伴名稱（變化來自 Snapshot；提交者在套用變化當下不在 Presence 中；提交者的 Presence_Meta 沒有 Bound_Person；或回報的 Bound_Person 不在 Optimistic_View 的旅伴中），THEN THE LM_Web SHALL 在同一個位置顯示「有人剛更新了這一項」。
8. WHEN 使用者儲存第 6 條的表單，THE LM_Web SHALL 依需求 7.8 只送出與開啟表單時的內容不同的欄位（集合欄位只送出相對於開啟時加入與移除的元素），使儲存後的那一項同時保留其他成員改過的其他欄位與使用者的修改；兩人改了同一個欄位時，依需求 7.6 以後提交的值為準；路線卡片例外，依需求 7.9 整條送出，由後提交者整條生效。
9. WHILE 使用者開著某個 Editable_Item 的編輯表單，WHEN Remote_Change 刪除了這一項（包括 Shopping_Sync 自動移除的 Meal_Item），或在正在編輯的是每日設定時使那一天不在旅行的日期範圍內，THE LM_Web SHALL 直接關閉表單並捨棄草稿（不先詢問是否放棄未儲存的修改）、依需求 15.2 在 Presence 回報沒有正在編輯的對象，並以 Toast 顯示「這個項目已被刪除。」；每日設定被 Remote_Change 移除、而那一天仍在旅行的日期範圍內時（需求 22.11），不算刪除，改依第 6、7 條處理；旅行被刪除時依需求 12.13 處理。
10. WHEN Optimistic_View 或 Presence 的狀態改變，THE LM_Web SHALL 讓頁面與每個可捲動區塊的捲動位移維持不變，只有兩種例外：可見範圍上方的內容高度改變時，捲動位移的改變量不超過這個高度的變化量；頁面或區塊變短，使原本的捲動位移超過新的最大值時，停在新的最大值。
11. WHILE 編輯表單以外的一個可輸入文字的欄位有焦點（例如在採買清單中直接修改的數量），WHEN Remote_Change 修改了這個欄位顯示的資料，THE LM_Web SHALL 不覆蓋欄位中的文字、游標位置與選取範圍，等使用者離開這個欄位之後才依 Optimistic_View 顯示（第 1 條的例外）。

### Requirement 15: 誰正在編輯

**User Story:** 身為旅伴，我希望知道誰正在編輯哪一張卡片或哪一列，需要時仍能自己編輯，以便減少兩個人同時改同一項，又不會被鎖住。

#### Acceptance Criteria

1. WHEN 使用者開啟 Editable_Item 的編輯表單（包括欄位依需求 15.9 為唯讀的情況），THE LM_Web SHALL 經 Presence_Throttle（需求 15.3 至 15.5），在允許的最早時間於 Trip_Channel 的 Presence 回報 Presence_Meta；Presence_Meta 只包含自己的 Account id、Snapshot 中自己的 Display_Name、自己在這趟旅行的 Bound_Person（沒有時為空，例如 Unbound_Admin）與這個 Edit_Target，每個分頁同時最多回報一個 Edit_Target。
2. WHEN 編輯表單關閉（儲存後關閉、按「取消」或關閉視窗、依需求 14.9 因項目被刪除而關閉，或因離開 Trip_Page 而關閉），THE LM_Web SHALL 經 Presence_Throttle（需求 15.3 至 15.5），在允許的最早時間回報 Edit_Target 為空的 Presence_Meta；如果分頁在送出之前就離開 Trip_Channel，改由 Realtime_Service 移除這個分頁的 Presence。
3. THE Presence_Throttle SHALL 讓同一個分頁任兩次送出 Presence 至少相隔 6.5 秒（6,500 毫秒），重新加入 Trip_Channel 之後的重新送出也一樣，使任何 30 秒的區間內最多送出 5 次。
4. WHILE 距離這個分頁上次送出 Presence 還不到 6.5 秒，THE Presence_Throttle SHALL 不立即送出新收到的 Presence_Meta，只保留最後收到的一筆（取代先前保留的），並在距離上次送出滿 6.5 秒時送出它，使最後一次開啟或關閉表單的狀態一定會送出。
5. WHEN Presence_Throttle 收到的 Presence_Meta 與這個分頁在目前這次加入 Trip_Channel 之後上次送出的完全相同（Account id、Display_Name、Bound_Person 與 Edit_Target 都相同），THE Presence_Throttle SHALL 不送出它，並捨棄保留中尚未送出的那一筆；例如上次送出的是沒有正在編輯的對象，而使用者在那之後 6.5 秒內開啟又關閉表單時，不送出任何 Presence。
6. WHEN LM_Web 重新加入 Trip_Channel 成功（包括需求 11.7 至 11.9 與需求 15.13 的重新加入），THE LM_Web SHALL 經 Presence_Throttle 重新送出這個分頁目前的 Presence_Meta，也就是最後一次開啟或關閉表單所對應的那一筆，即使它與重新加入之前送出的相同；6.5 秒的最小間隔仍從重新加入之前最後一次送出起算。這個分頁從未經 Presence_Throttle 回報任何 Presence_Meta 時，不送出。
7. WHEN LM_Web 收到 Trip_Channel 的 Presence 完整狀態或增減，THE LM_Web SHALL 更新保存的其他分頁的 Presence_Meta（每個分頁一筆，以 presence key 區分，不含這個分頁自己）：完整狀態取代先前保存的全部內容，包括重新加入之前留下的；增減依其中的加入與移除更新。其他分頁改變 Edit_Target 時，保存的那一筆換成新的內容，不會遺失，也不會同時留下新舊兩筆。Realtime_Service 移除已關閉或斷線的分頁之後，它的 Presence_Meta 與 Editor_Avatar 隨之消失。
8. IF Presence 的完整狀態或增減中某個分頁的內容無法解析成 Presence_Meta（例如缺少 Account id、Account id 格式不正確，或欄位的型別不符），THEN THE LM_Web SHALL 忽略這一筆，照常處理同一則訊息中的其他分頁，也不顯示錯誤訊息；Display_Name 超過 30 個字元或前後有空白不算無法解析，依需求 16.14 修剪並截斷後使用。
9. WHEN 使用者開啟編輯表單時，這個 Edit_Target 的 Editor_Stack 不是空的（至少一個其他 Account 正在編輯；自己的 Account 在其他分頁或裝置上的編輯不算），THE LM_Web SHALL 在表單上方以 `role="status"` 顯示 Editing_Notice（文字依需求 16.13），在旁邊提供「仍要編輯」按鈕，讓表單的所有欄位唯讀，並停用其他會改變表單內容或資料的按鈕（包括「儲存」與「移除項目」）。這段期間只有「仍要編輯」、「取消」與關閉視窗可以使用，直到使用者按下「仍要編輯」或關閉表單。
10. WHEN 使用者按下「仍要編輯」，THE LM_Web SHALL 讓表單恢復成沒有其他人正在編輯時的樣子（欄位與按鈕依權限照常可以使用）、移除「仍要編輯」按鈕、把鍵盤焦點移到表單的第一個欄位，並在表單關閉之前不再改回唯讀；儲存時依需求 7.8 只送出改過的欄位，並套用與沒有其他人正在編輯時相同的 LM_Core 檢查。
11. THE LM_Server SHALL 不讀取 Presence，並以與沒有人正在編輯時相同的 Permission_Table、驗證與提交順序執行 Command；不因 Edit_Target 有其他人正在編輯，或使用者是否按過「仍要編輯」，而拒絕、延後或改變 Command。兩個人儲存同一列時，依需求 7.5、7.6 與 7.9 決定結果。
12. THE LM_Web SHALL 為下列每一種 Editable_Item 的編輯表單回報 Presence，並在 Trip_Page（包括 Trip_Menu）上它的卡片或列顯示 Editor_Stack：路線卡片、每日設定、活動、料理、採買品項、裝備、支出、還款、旅伴、車輛、地點與 Trip_Card。每一張卡片或每一列各是一個 Edit_Target；每日設定是每個 Trip_Day 一個（不論這一天是否已有設定）；Trip_Card 是每趟旅行一個。新增項目的表單、勾選，以及在列上直接變更的選單（例如採買品項與裝備列上的負責人選單）不回報 Edit_Target。
13. IF Realtime_Service 通知這個分頁的 Presence 超過速率限制並關閉 Trip_Channel，THEN THE LM_Web SHALL 依需求 11.7 重新加入 Trip_Channel，不停止重試，也不離開 Trip_Page（不適用需求 11.10），除了需求 11.11 的提示之外不顯示其他訊息，並在重新加入後依需求 12.2 補齊、依需求 15.6 重新送出 Presence_Meta。
14. THE LM_Web SHALL 只以 Editing_Notice 的 `role="status"` 向螢幕閱讀器報告誰正在編輯；Editor_Avatar、「+N」與其他 Presence 的變化（例如有人開始或停止編輯別的項目）不放進任何 live region，也不以 Toast 通知。
15. WHILE 編輯表單開著，THE LM_Web SHALL 讓 Editing_Notice 跟著這個 Edit_Target 目前的 Editor_Stack 變化：Editor_Stack 由空變成不是空的時顯示，總人數或排在第一位的編輯者改變時更新文字，變成空的時移除。Editor_Stack 的變化不改變欄位是否唯讀，也不加入或移除「仍要編輯」按鈕：開啟時可以編輯的表單，之後有其他 Account 開始編輯時仍可以編輯；唯讀的表單在 Editor_Stack 變成空的之後仍保持唯讀，直到使用者按下「仍要編輯」或關閉表單。
16. WHILE 兩位 Trip_Member 的瀏覽器與 LM_Server 在同一台電腦或同一個區域網路中，而且兩人的分頁都在前景、Trip_Channel 都已連線，WHEN 其中一位開啟或關閉編輯表單，或在開著編輯表單時離開 Trip_Page 或關閉分頁，THE LM_Web SHALL 在 7 秒內（其中最多 6.5 秒是 Presence_Throttle 的等待）讓另一位成員畫面上那張卡片或那一列的 Editor_Stack 加入或移除他；開啟與關閉表單時的條件依需求 16.19 與 16.20。

### Requirement 16: 編輯者頭像

**User Story:** 身為旅伴，我希望在別人正在編輯的卡片或列上看到他們的圓形頭像，頭像上是他們顯示名稱的第一個字，以便一眼看出誰在改什麼。

#### Acceptance Criteria

1. WHILE LM_Web 目前的 Presence 狀態中至少有一個不是檢視者自己的 Account 回報正在編輯某個 Edit_Target，THE LM_Web SHALL 在檢視者畫面上代表那個 Edit_Target 的每一張卡片或每一列顯示它的 Editor_Stack，包括這段期間才因切換分頁或篩選而出現的卡片或列（出現時就帶著 Editor_Stack）；沒有這樣的 Account 時，那張卡片或那一列不顯示任何 Editor_Avatar 或「+N」；畫面上沒有代表那個 Edit_Target 的卡片或列時（例如它已被刪除或被篩選隱藏），這些編輯者不顯示在其他地方。
2. THE LM_Web SHALL 依 Editable_Item 的呈現方式放置 Editor_Stack：卡片（有自己的外框與標題列，例如料理卡片、路線卡片、旅伴卡片與車輛卡片）放在標題列的右側；清單中的列（例如採買品項、裝備、支出與還款）放在名稱之後、這一列的第一個操作按鈕之前；Trip_Card 放在 Trip_Page 旅行標題列的右側。Editor_Stack 內由左到右依需求 16.9 的順序排列 Editor_Avatar，「+N」在最右邊。
3. THE LM_Web SHALL 以固定大小的圓形顯示 Editor_Avatar 與「+N」：在卡片上（包括 Trip_Page 的旅行標題列）直徑 28px、字 14px，在列中直徑 24px、字 12px；同一個 Editor_Stack 中相鄰的兩個圓形重疊 6px，每個圓形的外圈是 2px 的卡片底色（`--card`）。
4. THE LM_Core SHALL 以 Presence_Meta 回報的 Display_Name 經 Trim_White 之後的第一個 Grapheme_Cluster 作為 Avatar_Initial，不轉換大小寫，使 emoji 序列、國旗、膚色修飾與組合字元不被切開；例如「陳小明」為「陳」、「  amy chen 」為「a」、「👨‍👩‍👧 一家」（三個 emoji 以 U+200D 連接）為「👨‍👩‍👧」、「🇹🇼台灣」為「🇹🇼」、「👋🏽阿明」為「👋🏽」，以「e」加組合字元 U+0301 開頭的名稱為這兩個碼位組成的「é」。
5. IF Display_Name 經 Trim_White 之後是空的（例如空字串，或只含半形空白、全形空白 U+3000、換行或 Tab 的名稱），THEN THE LM_Core SHALL 以「・」（U+30FB）作為 Avatar_Initial。
6. THE LM_Core SHALL 只依 Account id 決定 Editor_Avatar 的顏色：以 64 位元的 FNV-1a 依序雜湊 Account id 的 16 個位元組（UUID 文字形式由左到右，每兩個十六進位數字為一個位元組），再以雜湊值（無號 64 位元整數）除以 12 的餘數 i 取 Avatar_Palette 的第 i 色（從 0 起算），使同一個 Account 在每趟旅行、每個分頁、每台裝置、每種瀏覽器與每次登入都是同一色，而且顏色不受 Display_Name 影響。
7. THE Avatar_Palette SHALL 有 12 個兩兩不同的底色；每一色的文字色與底色的對比（WCAG 2.x 的相對亮度與對比公式）至少 4.5:1，而且文字色是 `--ink`（#3e3a39）與白色中與該底色對比較高的那一個。
8. THE LM_Web SHALL 以 Avatar_Palette 的固定底色與文字色顯示 Editor_Avatar，在淺色與深色主題相同；只有外圈的 `--card` 與「+N」的 `--soft`、`--ink` 隨主題改變。
9. THE LM_Core SHALL 依 Account id 遞增（以 16 個位元組依序比較，與小寫十六進位字串的字典序相同）排列 Editor_Stack 的編輯者：編輯者為 1–3 位時全部成為 Editor_Avatar，沒有「+N」；超過 3 位時排在前 3 位的成為 Editor_Avatar，其餘依同樣順序計入「+N」，N 為編輯者總數減 3（例如 4 位編輯者時為 3 個 Editor_Avatar 加「+1」）。
10. THE LM_Core SHALL 以 Presence_Meta 回報的 Account id 辨識編輯者：同一個 Account 在多個分頁或裝置上編輯同一個 Edit_Target 時算成一位編輯者，不論他有沒有 Bound_Person；同一個 Account 同時在不同分頁編輯不同的 Edit_Target 時，他出現在每一個 Edit_Target 的 Editor_Stack；檢視者自己的 Account 不出現在任何 Editor_Stack，包括自己在其他分頁與裝置上的編輯。
11. THE LM_Web SHALL 以 `role="img"`、不接受鍵盤焦點的元素輸出每個 Editor_Avatar，無障礙名稱為「{顯示名稱} 正在編輯」（例如「陳小明 正在編輯」），滑鼠提示為完整的顯示名稱（例如「陳小明」）；顯示名稱是空的時候，無障礙名稱為「有人 正在編輯」，滑鼠提示為「未設定顯示名稱」。
12. THE LM_Web SHALL 以 `role="img"`、不接受鍵盤焦點的元素輸出「+N」：文字為「+」加上阿拉伯數字 N（例如「+2」）；無障礙名稱為「另外 N 人正在編輯：{其餘編輯者的顯示名稱}」，冒號為全形「：」，名稱依需求 16.9 的順序以頓號「、」分隔，空的顯示名稱寫成「有人」（例如「另外 2 人正在編輯：林大華、王小美」）；滑鼠提示依同樣順序以頓號列出其餘編輯者的顯示名稱，空的寫成「未設定顯示名稱」；底色與文字色為 `--soft` 與 `--ink`，兩者的對比在淺色與深色主題都至少 4.5:1。
13. THE LM_Core SHALL 產生 Editing_Notice：Editor_Stack 只有一位編輯者時為「{顯示名稱} 正在編輯這一項」；有 2 位以上時為「{排在第一位（Account id 最小）的編輯者的顯示名稱} 等 {總人數} 人正在編輯這一項」，總人數是 Editor_Avatar 與「+N」代表的人數總和，不含檢視者（例如「陳小明 等 4 人正在編輯這一項」）；用到的顯示名稱是空的時候以「有人」代替（例如「有人 正在編輯這一項」）。
14. THE LM_Web SHALL 在 Editor_Avatar 與「+N」的無障礙名稱和滑鼠提示，以及 Editing_Notice 中，使用 Presence_Meta 回報的 Display_Name 經 Trim_White、再截到最多 30 個字元的結果；顯示名稱本身之外，這些文字中的空格都是一個半形空格（U+0020）；旅行中的其他地方（負責人、參加者、打包、分帳與「剛更新了這一項」）照舊顯示旅伴名稱。
15. THE LM_Web SHALL 以文字節點或屬性輸出 Display_Name 與 Avatar_Initial，不以 HTML 插入，使含有 `<`、`>`、`&` 或引號的顯示名稱（例如 `<b>小明</b>`）原樣顯示為文字，不產生任何元素。
16. THE LM_Web SHALL 讓 Editor_Avatar 與「+N」在出現、消失或改變時沒有動畫或轉場效果（例如淡入、淡出、縮放或滑動），直接顯示最後的狀態。
17. WHEN LM_Web 依 Presence 的完整狀態或增減更新 Presence 狀態，THE LM_Web SHALL 只更新 Editor_Stack 有改變的 Edit_Target 的頭像（Editor_Avatar 的人選、順序或內容改變，或「+N」的人數或名單改變），那張卡片或那一列的其他內容，以及其他卡片和列的元素都保持不變；沒有任何 Editor_Stack 改變時（例如有人加入 Trip_Channel 但沒有在編輯，或同一位編輯者多開一個分頁編輯同一項），不更新任何頭像。
18. WHEN 不同的檢視者看到同一份 Presence 狀態，THE LM_Web SHALL 讓同一位編輯者在每位檢視者的畫面上有相同的 Avatar_Initial（同一個 Grapheme_Cluster；字形可以因裝置的字型而不同）、顏色與無障礙名稱，不論檢視者使用哪一台裝置或哪一種瀏覽器；兩位編輯者同時出現在兩位檢視者的 Editor_Stack 時，兩人在兩個畫面上的先後順序相同。
19. WHILE 檢視者與另一個 Account（編輯者）的分頁都已加入 Trip_Channel，而且編輯者的分頁在前景，WHEN 編輯者開啟某個 Edit_Target 的表單並保持開啟至少 7 秒，THE LM_Web SHALL 在表單開啟後 7 秒內，於檢視者畫面上代表那個 Edit_Target 的卡片或列顯示這位編輯者（成為 Editor_Avatar 或計入「+N」）。
20. WHILE 檢視者與另一個 Account（編輯者）的分頁都已加入 Trip_Channel，而且編輯者的分頁在前景，WHEN 編輯者關閉表單，而且之後 7 秒內沒有再開啟同一個 Edit_Target 的表單，THE LM_Web SHALL 在關閉後 7 秒內，從檢視者畫面上那個 Edit_Target 的 Editor_Stack 移除這位編輯者；同一個 Account 仍有其他分頁在編輯同一個 Edit_Target 時不移除。
21. WHEN LM_Web 加入或重新加入 Trip_Channel 後收到 Presence 的完整狀態，THE LM_Web SHALL 以這份完整狀態取代先前的 Presence 狀態（之後再依增減更新），並據以重建每個 Editor_Stack，使斷線期間已停止編輯或已離線的 Account 不再顯示，斷線期間開始編輯的 Account 出現在對應的 Editor_Stack。

### Requirement 17: 旅行列表、建立與刪除

**User Story:** 身為使用者，我希望在首頁看到我參加的旅行並建立新的旅行，主辦人也能刪除旅行，以便管理所有的旅程。

#### Acceptance Criteria

1. WHEN 已登入的使用者開啟自己的 Home_Page（`/<自己的帳號名稱>/home`），或在 Home_Page 建立旅行成功，THE LM_Web SHALL 依 `GET /api/trips` 的結果列出使用者是 Trip_Member 的旅行：每趟顯示連到這趟旅行 Trip_Page 的名稱、目的地（空白時顯示「尚未填寫地點」）、起訖日期（格式與現行 `dateSpan()` 相同，開始日等於結束日時只顯示一個日期）、封面插畫、狀態（「規劃中」或「已完成」）與「{N} 位旅伴」（N 為旅伴人數，包括沒有綁定 Account 的旅伴）；規劃中的旅行在「規劃中的旅行」區依開始日期由早到晚排列，已完成的旅行在其後的「已完成的回憶」區依開始日期由晚到早排列，開始日期相同時建立時間較晚的在前；沒有任何旅行時顯示「還沒有任何旅行」。
2. THE Home_Page SHALL 以「新增旅行」按鈕開啟建立旅行的表單，表單包含名稱、目的地、起訖日期、介紹、小叮嚀與封面選擇，不含狀態；名稱與起訖日期為必填，封面預設為 camp，送出按鈕為「建立旅行」。
3. WHEN 使用者以還沒有被任何旅行使用的旅行 id 建立旅行，THE LM_Server SHALL 在一個資料庫交易中建立這趟旅行（id 為用戶端產生的旅行 id、Trip_Owner 為建立者、狀態為規劃中），並把建立者加為這趟旅行的 Bound_Person（名字為建立者的 Display_Name 經 Participant_Name 的結果，角色為「這趟的召集人」，顏色為 coral），提交後以需求 17.8 的欄位回傳這趟旅行。
4. WHEN 建立請求的旅行 id 已被一趟旅行使用（包括同一個 id 的兩個建立請求同時送達），THE LM_Server SHALL 不建立第二趟旅行：請求者是那趟旅行的 Trip_Owner、而且那趟旅行沒有被刪除時，以需求 17.8 的欄位回傳既有的旅行，不依這次請求的內容修改它；其他情況回應 409「無法建立這趟旅行，請關閉表單後重新建立。」，不回傳那趟旅行的任何內容。
5. THE LM_Core SHALL 以 Trim_White 去除旅行名稱、目的地、介紹與小叮嚀的前後空白，以去除後的文字檢查並作為儲存的值，只接受 1–100 字的名稱、0–100 字的目的地、各 0–1000 字的介紹與小叮嚀、四段文字都不含 U+0000、開始日與結束日都是有效日期而且含頭尾共 1–31 天，以及列舉值中的七種封面之一；不符合時以 400 拒絕，訊息與檢查順序沿用現行 `validateTripCard()`（例如名稱是空的或超過 100 字時為「請填寫旅行名稱（最多 100 個字）。」，結束日早於開始日或含頭尾超過 31 天時為「結束日不能早於開始日，而且一趟旅行最多 31 天。」），含 U+0000 時為「旅行資料含有不允許的字元。」；建立旅行時另外只接受 Display_Name 經 Participant_Name 之後符合需求 19.2 至 19.4 的建立者，不符合時以 400 與該條的訊息拒絕。
6. WHEN Trip_Manager（包括 Unbound_Admin）以 `DELETE /api/trips/{id}` 刪除一趟沒有被刪除的旅行，THE LM_Server SHALL 在一個資料庫交易中鎖住這趟旅行、依需求 8.8 記錄刪除時間（Invite_Link 的資料不變，但之後這趟旅行的每個 Invite_Link 都依需求 6.16 與 30.13 回應「邀請連結無效或已過期。」），並依需求 10.8 寫入及推送一個 Seq 為 Head 加 1、不含任何列變化、`trip_deleted` 為真的 Change_Set，作為這趟旅行的最後一個 Change_Set，提交後回應 200。
7. IF 要刪除的旅行不存在或已被刪除，或請求者不是這趟旅行的 Trip_Manager，THEN THE LM_Server SHALL 不記錄刪除時間，也不寫入或推送 Change_Set，並在旅行沒有被刪除而且請求者是 Collaborator 時回應 403「受邀旅伴可以編輯旅行，但只有主辦人或管理員可以刪除。」，其他情況回應 404「找不到這趟旅行。」（包括 Collaborator 刪除已被刪除的旅行，以及兩個刪除請求同時送達時後執行的那一個）。
8. WHEN 已登入的使用者請求 `GET /api/trips`，THE LM_Server SHALL 只回傳使用者是 Trip_Member、而且沒有被刪除的旅行（Admin 也只包括自己是 Trip_Member 的旅行），每趟包含旅行 id、名稱、目的地、起訖日期、封面、狀態、旅伴人數（包括沒有綁定 Account 的旅伴），以及使用者是不是這趟旅行的 Trip_Manager。
9. WHEN 使用者送出建立旅行的表單，THE LM_Web SHALL 先以 LM_Core 依需求 17.5 檢查，不成立時不送出並在表單中顯示訊息；成立時以開啟表單時產生的 UUID 作為旅行 id 送出 `POST /api/trips`，同一個表單的每次送出（包括失敗後再次送出）都使用這個 id；LM_Server 回應成功時關閉表單並顯示「旅行已建立」，回應錯誤時保留已填寫的內容並顯示 LM_Server 回應的訊息，網路錯誤或逾時時保留已填寫的內容並顯示「尚未儲存，請檢查網路後再試一次。」。
10. WHEN Trip_Manager 在 Trip_Menu 選擇「刪除旅行」（Collaborator 的 Trip_Menu 不顯示這個選項），THE LM_Web SHALL 開啟確認對話框，顯示這趟旅行的名稱、「輸入旅行名稱以確認」欄位與「確認刪除旅行」按鈕，並在輸入的文字與旅行名稱逐字相同之前停用這個按鈕；刪除成功時依需求 12.13 離開 Trip_Page、前往 Home_Page 並顯示「這趟旅行已被刪除。」，不論 HTTP 回應與 `trip_deleted` 的 Change_Set 哪一個先到都只顯示一次；刪除失敗時保留對話框並顯示 LM_Server 回應的訊息，網路錯誤或逾時時顯示「尚未刪除，請檢查網路後再試一次。」。

### Requirement 18: 編輯旅行與改日期

**User Story:** 身為旅伴，我希望修改旅行的名稱、目的地與日期時，已排好的路線、活動與料理跟著日子移動，以便改日期之後不必重新安排行程。

#### Acceptance Criteria

1. WHEN Trip_Manager 或 Collaborator 在 Trip_Menu 的「編輯旅行」表單儲存，THE LM_Server SHALL 只更新 Command 帶有的 Trip_Card 欄位：名稱、目的地、起訖日期、介紹、小叮嚀、封面與狀態；起訖日期算一個欄位，開始與結束日期一起帶有、一起生效；Command 沒有帶的欄位保留 LM_Server 執行當下的值。
2. IF 依第 1 條合併後的 Trip_Card 不符合需求 17.5 的規則，或狀態不是 planning 或 completed，THEN THE LM_Server SHALL 回應 400，訊息依名稱、目的地、起訖日期、介紹、小叮嚀、封面、狀態的順序說明第一個不符合的欄位（名稱到封面的訊息與建立旅行時相同），Trip_State 保持不變。
3. IF 依第 1 條合併後的 Trip_Card 通過第 2 條的檢查，而新的目的地經 Trim_White 之後不是空的，且它的 Place_Key 與地點清單中某個地點相同，THEN THE LM_Server SHALL 回應 409「已有同名地點：{地點名稱}。請先在「地點與車」把這個地點改名。」（{地點名稱} 是那個地點目前的名稱），Trip_State 保持不變。
4. IF 依第 1 條合併後的 Trip_Card 通過第 2 條的檢查，而新的目的地經 Trim_White 之後是空的，且仍有路線的起點、終點或停靠點使用 Destination_Place，THEN THE LM_Server SHALL 回應 409「仍有路線或停靠點使用旅行目的地，不能把目的地清空。」，Trip_State 保持不變。
5. WHEN 旅行的起訖日期改變，THE LM_Core SHALL 以套用 Command 前的起訖日期為舊範圍（在 LM_Server 是執行當下的日期，不是使用者開啟表單時看到的日期），把舊範圍第 N 天的每一條路線與每一個每日設定移到新範圍的第 N 天，只改變它們的日期；新舊範圍重疊時也依搬動前的日子對應，不互相覆蓋。
6. WHEN 旅行的起訖日期改變，THE LM_Core SHALL 把舊範圍第 N 天的每一筆活動與每一道料理移到新範圍的第 min(N, 新天數) 天，並把日期不在舊範圍內的活動與料理移到新範圍的第 1 天，只改變它們的日期，其他欄位（例如時間、完成狀態與 Ordinal）不變。
7. IF 依第 1 條合併後的 Trip_Card 通過第 2 至 4 條的檢查，而新天數少於舊天數，且被刪掉的舊範圍第 N 天（N 大於新天數）有路線，或有標題經 Trim_White 之後不是空的、或已設定地點的每日設定（活動與料理不阻擋縮短），THEN THE LM_Server SHALL 回應 409「縮短天數前，請先處理：{日子清單}。刪除這些路線、清除這些每日設定後，才能縮短天數。」，Trip_State 保持不變；{日子清單} 依 N 遞增，以「、」連接每個這樣的日子，每一項為「第 {N} 天（{M/D}）的{內容}」，{M/D} 是那一天原本的月與日（不補零），{內容} 只有路線時為「路線」、只有每日設定時為「每日設定」、兩者都有時為「路線與每日設定」，例如「縮短天數前，請先處理：第 4 天（10/23）的路線、第 5 天（10/24）的路線與每日設定。刪除這些路線、清除這些每日設定後，才能縮短天數。」
8. WHEN 縮短天數時被刪掉的舊範圍日子都沒有路線，而且它們的每日設定都沒有標題（未設定，或經 Trim_White 之後是空的）也沒有設定地點，THE LM_Core SHALL 完成改日期，並刪除這些日子的每日設定，包括其中的預計抵達時間與路線位置。
9. WHEN 旅行的起訖日期改變，THE LM_Core SHALL 只改變 Trip_Card，以及第 5、6 條搬動與第 8 條刪除的列：支出與還款保留原本的日期，旅伴、車輛、地點、採買品項、裝備與出發確認都不變。
10. IF LM_Server 執行路線、每日設定、活動或料理的 Command 時，Command 指定的日期不在當下的旅行範圍內（例如其他成員已先提交了改日期），THEN THE LM_Server SHALL 依需求 22.5、22.10、23.10 或 24.2 回應 400，不依 Retime 改動這個 Command 指定的日期。
11. WHEN Optimistic_View 中旅行的起訖日期改變，THE Schedule_Tab SHALL 依需求 22.16 決定選定的 Trip_Day。

### Requirement 19: 旅伴

**User Story:** 身為旅行的成員，我希望新增與修改旅伴，主辦人也能移除沒有綁定帳號的旅伴，以便旅伴名單保持正確。

#### Acceptance Criteria

1. WHEN 新增或修改旅伴，THE LM_Core SHALL 在需求 6 的權限檢查通過之後，以 Participant_Name 正規化 Command 中提供的名字與角色，並以結果作為旅伴的名字與角色（Participant_Name 所稱的空白是 JS_Whitespace），例如「 Ａｌｉｃｅ　 Lin 」成為「Alice Lin」；正規化後的角色是空的時改為「新加入的旅伴」；之後依 19.2、19.3、19.4、19.5、19.6、19.7 的順序檢查，只回報第一個違反的規則，Command 沒有提供的欄位不檢查。
2. IF 名字的 Participant_Key 去除前後的 JS_Whitespace 之後是空的，例如空字串、只有半形或全形空白，或只有 U+200B、U+FE0F、U+3164 這類 Unicode 的 Default_Ignorable_Code_Point，THEN THE LM_Core SHALL 拒絕並說明「請填寫名字或暱稱，不能只有空白。」。
3. IF 正規化後的名字含有 Hidden_Control_Char，THEN THE LM_Core SHALL 拒絕並說明「名字不能包含隱藏控制字元。」：例如「👨‍👩‍👧」「🏳️‍🌈」「👩🏽‍💻」中的 U+200D 不算 Hidden_Control_Char，可以使用，而「小」與「安」之間夾著 U+200B、U+00AD、U+202E、U+0085 或 U+200D 的名字、以 U+200D 結尾的名字，以及由標籤字元組成的英格蘭旗都會被拒絕；JS_Whitespace（例如 Tab、換行與 U+FEFF）已依 19.1 換成空格，不會因此被拒絕。
4. IF 正規化後的名字超過 30 字，THEN THE LM_Core SHALL 拒絕並說明「名字最多 30 個字。」。
5. IF 正規化後的角色超過 60 字或含有 U+0000，THEN THE LM_Core SHALL 拒絕並說明：超過 60 字時為「小隊角色最多 60 個字。」，沒有超過 60 字但含有 U+0000 時為「小隊角色含有不允許的字元。」。
6. IF 名字的 Participant_Key 與這趟旅行中另一位旅伴的 Participant_Key 相同，THEN THE LM_Server SHALL 回應 409「這個名字已在小隊中。請加上姓氏或使用不同暱稱，不會直接切換成同名旅伴。」：修改時不與這位旅伴自己比較，所以只改大小寫的改名（例如「alice」改為「Alice」）可以儲存；已有「Alice」時新增「 ＡＬＩＣＥ 」或「alice」、已有「小安」時新增「小安」加 U+FE0F 都會被拒絕；兩個同名的新增或改名同時送出時，依提交順序後執行的那一個得到這個回應。
7. IF 新增旅伴時這趟旅行已有 100 位旅伴（綁定與沒有綁定 Account 的都算，以 Command 依提交順序執行當下的人數為準），THEN THE LM_Server SHALL 回應 409「小隊最多 100 位旅伴，目前已額滿。」；修改旅伴不受這個上限限制。
8. WHEN 新增旅伴（包括以 Invite_Link 加入）而沒有指定顏色，THE LM_Core SHALL 以新增前的旅伴人數除以 6 的餘數為索引，依序從 coral、blue、green、yellow、lavender、peach 取色，例如已有 0 位或 6 位旅伴時為 coral、已有 7 位時為 blue。
9. WHEN 新增旅伴（包括以 Invite_Link 加入），THE LM_Core SHALL 刪除這趟旅行所有的出發確認；修改旅伴不改變任何出發確認。
10. WHEN Trip_Manager 移除沒有綁定 Account、也不是任何支出的付款人或分攤旅伴、任何還款的付款人或收款人的旅伴，THE LM_Core SHALL 刪除這位旅伴，並清除對他的引用：以他為駕駛的車輛改為沒有駕駛；以他為負責人的料理、採買品項與共用裝備改為待分配；把他從車輛乘客、活動的指定旅伴與每個裝備的打包勾選中移除；這些列的其他欄位不變，例如採買品項維持原本的 Meal_Item 或 Manual_Item 與已買狀態。
11. WHEN 移除旅伴使一筆活動的指定旅伴變成空的，THE LM_Core SHALL 把那筆活動的參加者改為全體旅伴。
12. WHEN 移除旅伴使共用裝備失去負責人，THE LM_Core SHALL 清空那些裝備的打包勾選並刪除所有出發確認；沒有這種裝備時，只刪除被移除旅伴自己的出發確認。
13. IF Trip_Manager 要移除的旅伴綁定了 Account（包括 Trip_Owner 與 Trip_Manager 自己的旅伴），THEN THE LM_Server SHALL 回應 409「已綁定帳號的旅伴不能在手冊中移除或更換，請由管理員處理帳號。」。
14. IF Trip_Manager 要移除的旅伴沒有綁定 Account，但仍是任何支出的付款人或分攤旅伴，或任何還款的付款人或收款人，THEN THE LM_Server SHALL 回應 409「這位旅伴仍有支出或還款紀錄。請先在分帳記帳修改或刪除這些帳目，再移除旅伴。」。
15. THE Trip_Menu SHALL 在「旅伴」區塊依 Ordinal 列出每位旅伴的名字、角色與旅伴代表色，以「我」標示檢視者的 Bound_Person，並只提供檢視者可以執行的操作：「新增旅伴」給每位能開啟這趟旅行的使用者；「編輯旅伴」只在 Permission_Table 允許檢視者修改的旅伴上；「移除旅伴」只給 Trip_Manager，而且只在沒有綁定 Account 的旅伴上；新增與編輯的表單包含旅伴名字、小隊角色與 6 種旅伴代表色的選擇，新增時代表色預設為 19.8 算出的顏色。
16. IF 修改或移除旅伴的 Command 通過需求 6 的權限檢查，但指定的旅伴已不在這趟旅行中（例如已被另一位 Trip_Manager 移除），THEN THE LM_Server SHALL 對修改回應 404「找不到這位旅伴。」，對移除依需求 7.12 回應目前的 Seq 與「沒有變化」，兩者都不寫入也不推送。
17. WHEN Trip_Manager 在 Trip_Menu 按下一位旅伴的「移除旅伴」，THE LM_Web SHALL 先以 LM_Core 檢查 19.14：不能移除時以 Toast 顯示 19.14 的訊息、不開啟對話框；可以移除時開啟確認對話框「移除這位旅伴？」，內文為「會從這趟旅行移除{旅伴名稱}，並清除車輛、活動、料理、採買與裝備中對這位旅伴的安排；其他旅伴也會看到變更。」，只在按下「確認移除」後送出移除旅伴的 Command，按下「取消」或關閉對話框時不送出。
18. WHEN 一位使用者新增、修改或移除旅伴，THE LM_Web SHALL 依需求 10，不需重新載入就在其他已開啟這趟旅行的瀏覽器分頁更新 Trip_Menu 的旅伴清單；移除旅伴時，旅伴的刪除與被清除的駕駛、乘客、活動參加者、負責人與打包勾選在同一次畫面更新中出現，包括 Trip_Page 的五個分頁與 Departure_Page。

### Requirement 20: 車輛

**User Story:** 身為規劃行程的人，我希望記錄每台車的駕駛、座位與乘客，以便安排每台車的路線與採買。

#### Acceptance Criteria

1. WHEN Trip_Manager 或 Collaborator 新增或修改車輛，THE LM_Core SHALL 先以 Trim_White 處理名稱，再依序檢查，並以第一個不符合的條件拒絕：名稱是空的，或表單中的座位數沒有填寫時，說明「請填寫必要欄位，不能只有空白。」；名稱超過 50 字時說明「車輛暱稱最多 50 個字。」；座位數不是 1–9 的整數（例如 0、10 或 2.5）時說明「座位數（含駕駛）請填 1 到 9 的整數。」；接著依序檢查第 2 條與第 3 條。通過時以 Trim_White 之後的名稱作為車名；座位數包含駕駛，車名可以與其他車輛相同。
2. THE LM_Core SHALL 只接受這趟旅行現有的旅伴或「待分配」（沒有駕駛）作為駕駛、只接受這趟旅行現有的旅伴作為乘客（可以沒有乘客），並依序檢查：駕駛也在乘客中時，拒絕並說明駕駛不能同時是乘客；乘客人數加 1 超過座位數時，拒絕並說明「乘客加上駕駛不能超過座位數。」，沒有駕駛時同樣保留駕駛座（例如 4 個座位最多 3 位乘客）；駕駛或乘客不是這趟旅行現有的旅伴時，拒絕並說明找不到這位旅伴。
3. IF 新增或修改車輛時設定的顏色不是 `#` 加上 6 個小寫的十六進位數字（0–9、a–f），THEN THE LM_Core SHALL 拒絕這次的新增或修改，並說明「車輛顏色需為 #rrggbb」；含大寫 A–F、3 位數的簡寫、少了 `#`、多了透明度，或前後有空白的值都不接受。清除顏色（改回沒有設定顏色）不受這條限制。
4. WHEN 車輛沒有設定顏色，THE LM_Web SHALL 以 Car_Palette 中索引為 k 除以 8 的餘數的顏色（索引從 0 起算）顯示這台車，而且不把這個顏色存進車輛；k 為這台車在目前所有車輛中依 Ordinal 遞增排列的位置（第一台為 0，有設定顏色的車也計入），所以每位成員看到相同的顏色，前面的車被刪除之後 k 依新的位置重新計算。
5. WHEN Trip_Manager 刪除沒有路線、也沒有被任何活動指定的車輛，THE LM_Server SHALL 刪除這台車與它的乘客名單，旅伴本身與其他列保持不變。
6. IF Trip_Manager 要刪除的車輛還有路線，THEN THE LM_Server SHALL 回應 409「這台車在第 N 天還有路線，請先刪除這些路線，或改派給其他車。」，Trip_State 保持不變；N 是這台車有路線的 Trip_Day 編號，有多天時依天數遞增列出，每一天寫成「第 N 天」並以「、」連接，例如「這台車在第 1 天、第 3 天還有路線，請先刪除這些路線，或改派給其他車。」。
7. IF Trip_Manager 要刪除的車輛仍被活動指定（有活動的參加者是指定車輛，而且包含這台車），THEN THE LM_Server SHALL 回應 409「這台車仍有指定行程。請先把那些行程改派其他車輛或改為全體，再移除車輛。」，Trip_State 保持不變；這台車同時還有路線時，訊息為第 6 條的訊息加上一個半形空格，再接這段訊息。
8. THE LM_Web SHALL 讓 Trip_Menu 的「車輛」與 Schedule_Tab 的「地點與車」編輯同一份車輛資料：兩處都依 Ordinal 列出每台車的名稱、「駕駛 {駕駛的名字，沒有駕駛時為待分配} · {乘客人數，有駕駛時再加 1} / {座位數} 人」（例如「駕駛 小安 · 3 / 4 人」），以及依旅伴的 Ordinal 排列的乘客名字，並開啟同一個車輛表單；新增車輛的表單預設座位數為 4、駕駛為檢視者的 Bound_Person（沒有 Bound_Person 時為待分配）、沒有乘客；只有 Trip_Manager 看得到車輛的移除按鈕。
9. WHEN 新增或修改車輛的 Command 在 LM_Server 執行，THE Command_Executor SHALL 把這次的新增或修改套用到提交當下最新的 Trip_State，再以結果檢查第 1 至 3 條，使其他成員先提交的修改也納入檢查；例如兩位成員同時為一台 4 個座位、已有 2 位乘客的車各加入 1 位不同的乘客時，先提交者成功，後提交者被拒絕並看到「乘客加上駕駛不能超過座位數。」，這台車維持 3 位乘客。
10. IF 要修改的車輛已不在這趟旅行中（例如已被其他成員刪除），THEN THE LM_Server SHALL 回應 404 並說明找不到這台車，不重新建立這台車，Trip_State 保持不變；要刪除的車輛已不存在時，依需求 7.12 視為沒有變化。
11. WHEN 使用者儲存車輛表單，THE LM_Web SHALL 先從勾選的乘客中去掉選定的駕駛，再依需求 7.8 把乘客的變更以加入與移除送出；因此把原本的乘客改選為駕駛時，這位旅伴同時從乘客中移除。

### Requirement 21: 地點清單

**User Story:** 身為規劃行程的人，我希望把會去的地點存成清單，以便每天的路線從清單選擇，不用重打。

#### Acceptance Criteria

1. WHEN Trip_Manager 或 Collaborator 新增地點或替地點改名，THE LM_Core SHALL 以經 Trim_White 的名稱依下列順序檢查，只以第一個不符合的規則拒絕：是空的時回應 400「請填寫地點名稱。」；Char_Count 超過 50 時回應 400「地點名稱最多 50 個字。」；含有 Hidden_Control_Char 時回應 400「地點名稱不能包含換行、Tab 或隱藏的控制字元。」；Place_Key 等於這趟旅行其他地點的 Place_Key（改名時不含這個地點自己，所以只改英文大小寫或全形半形的改名可以儲存），或等於非空白旅行目的地的 Place_Key 時，回應 409「已有同名地點」。LM_Server 提交時以當下的 Trip_State 再檢查一次，因此兩位成員同時新增同名的地點，或把地點改成同一個名稱時，後提交的 Command 得到這個 409。
2. IF 新增地點的名稱符合第 1 條，但旅行在提交當下已有 100 個地點，THEN THE LM_Server SHALL 回應 409「地點最多 100 個」，不新增地點；Destination_Place 不計入這 100 個，改名不受這個上限限制。
3. WHEN Trip_Manager 或 Collaborator 刪除沒有任何 Place_Usage 的地點，THE LM_Server SHALL 刪除這個地點，其餘地點在地點清單中的先後不變；Collaborator 刪除地點時不會得到 403（需求 6.11）。
4. IF 要刪除的地點在提交當下仍有 Place_Usage（包括其他成員剛提交、刪除者的畫面還沒顯示的路線或每日設定），THEN THE LM_Server SHALL 回應 409，不刪除地點，也不修改任何路線、停靠點與每日設定；訊息以「這個地點還在使用中，請先把下列使用處改成其他地點。」開頭，接著依 Trip_Day 的順序，為每個有 Place_Usage 的日子加上「第 N 天：{用途}」，同一天先列「這一天的地點」、再依車輛的 Ordinal 列出車輛名稱並以「、」連接，日子之間以「；」連接，最後加「。」，例如「這個地點還在使用中，請先把下列使用處改成其他地點。第 1 天：第二車；第 3 天：這一天的地點、第一車。」。
5. THE Schedule_Tab SHALL 在「地點與車」區塊依 Ordinal 列出每個地點的名稱（還沒得到 LM_Server 回應的新地點排在最後），每一列有「改名」與「刪除」按鈕，無障礙名稱分別為「改名 {地點名稱}」與「刪除 {地點名稱}」；區塊另有「＋新增地點」按鈕；「＋新增地點」與「改名」開啟只有「地點名稱」一個欄位的表單（改名時預填目前的名稱），按「儲存」送出；區塊也提供需求 20 的車輛管理（與 Trip_Menu 的「車輛」編輯同一份資料，需求 20.8）。
6. WHEN 新增地點或改名成功，THE LM_Core SHALL 儲存經 Trim_White 的名稱，其餘字元（包括全形半形與英文大小寫）依輸入保留；改名只修改這個地點的名稱，不改變它在地點清單中的位置，也不修改使用它的路線、停靠點與每日設定，因此畫面與 Itinerary_Text 中引用它的起點、終點、停靠點與 Day_Place 都改顯示新名稱，活動的地點文字不變；經 Trim_White 後與原名稱完全相同的改名，依需求 7.12 不寫入也不推送。
7. IF 要改名的地點在提交當下已不存在（例如已被其他成員刪除），THEN THE LM_Server SHALL 回應 404「找不到這個地點。」，Trip_State 保持不變；要刪除的地點已不存在時，依需求 7.12 視為沒有變化；不是 Trip_Member 也不是 Admin 的 Account 則依需求 6.2 一律得到 404「找不到這趟旅行。」。
8. IF LM_Core 在送出前拒絕新增、改名或刪除地點（需求 13.2），THEN THE LM_Web SHALL 不送出 Command：新增或改名時保持表單開啟並保留使用者輸入的名稱，把第 1 條的原因顯示在「地點名稱」欄位、第 2 條的訊息顯示在表單中；刪除時在那一列下方顯示第 4 條的訊息。

### Requirement 22: 行程表：規劃行程、路線與每日設定

**User Story:** 身為規劃行程的人，我希望在行程表為每一天安排每台車的路線與途中任務，並填寫當天的標題、地點與預計抵達時間，以便大家知道每台車怎麼走、幾點到。

#### Acceptance Criteria

1. THE Schedule_Tab SHALL 顯示「規劃行程」與「文字版」兩個區塊；規劃行程包含：選日（依日期順序為每個 Trip_Day 提供一個選項，顯示「第 {N} 天」、月與日不補零的「{M}/{D}」與「週{X}」，例如「第 1 天」「10/20」「週二」；開啟 Trip_Page 時選取第 1 天）、這一天的設定（標題、地點、預計幾點抵達與路線位置）、這一天每條路線的路線卡片與「新增路線」按鈕（路線卡片的「哪一台車」依車輛的 Ordinal，只列出這一天沒有其他路線的車輛）、活動（含常用活動）、當天的料理、「地點與車」，以及 Unassigned_Shopping。
2. WHEN 使用者在選日中選擇一個 Trip_Day，THE Schedule_Tab SHALL 顯示那一天的設定、路線卡片、活動與料理，並把路線卡片依出發時間由早到晚排列：出發時間相同時依車輛的 Ordinal，沒有出發時間的路線排在最後，彼此也依車輛的 Ordinal。
3. WHEN Trip_Member 儲存路線卡片，THE LM_Server SHALL 以卡片的內容（卡片所屬的 Trip_Day、車輛、起點、終點、出發時間，以及依卡片順序排列的停靠點）新增這條路線，或整條取代既有的路線與它的停靠點：取代時保留路線的 id 與卡片中既有停靠點的 id；卡片的路線已被其他成員刪除時，以卡片的內容重新新增；同一條路線的並行儲存依需求 7.9 由後提交者整條生效；儲存路線不新增、修改或刪除任何採買品項。
4. IF 儲存的路線卡片所選的車輛在同一天已有另一條路線（包括其他成員剛提交、畫面上還沒出現的路線），THEN THE LM_Server SHALL 回應 409「這台車這一天已有路線，請選擇其他車。」，Trip_State 保持不變。
5. THE LM_Core SHALL 只接受日期在旅行範圍內、車輛存在，而且出發時間為 Time_Value 或留空的路線（「０８：３０」視為 08:30；「08:」這類只填了一部分的輸入，以及「8:30」「24:00」，都不是 Time_Value，也不算留空），並以 400 拒絕其他路線：日期不在旅行範圍內時說明「資料驗證未通過，沒有儲存。請重新載入後再試。」，車輛未選擇或不存在（例如已被其他成員刪除）時說明「請選擇哪一台車。」，出發時間不符合時說明「請以 24 小時制填寫完整的時和分，例如 08:30；不填時請清空。」。
6. THE LM_Core SHALL 只接受地點清單中的地點，或在旅行目的地不是空白時的 Destination_Place，作為路線的起點、終點與停靠點（起點與終點可以是同一個地點），並以 400 拒絕未選擇或不在地點清單中（例如已被其他成員刪除）的地點，以及旅行目的地是空白時的 Destination_Place：起點說明「請選擇從哪裡出發。」，終點說明「請選擇最後到哪裡。」，停靠點說明「請選擇停在哪裡。」。
7. THE LM_Core SHALL 只接受有 0 到 6 個停靠點的路線，每個停靠點的種類是採買、接送、取還裝備或其他之一，任務類型留空或屬於它的種類（列舉值的「停靠點種類與任務」），備註經 Trim_White 之後不超過 100 字（保存 Trim_White 之後的內容），時間為 Time_Value 或留空；並以 400 拒絕其他路線：超過 6 個停靠點時說明「每台車最多 6 個停靠點」，種類或任務類型不符合時說明「請選擇要做什麼。」，備註過長時說明「備註最多 100 個字。」，時間不符合時說明「請以 24 小時制填寫完整的時和分，例如 08:30；不填時請清空。」。
8. WHEN LM_Core 為沒有指定任務類型的停靠點產生路線卡片上的任務名稱，THE LM_Core SHALL 使用該種類的預設任務：採買為「採買」、接送為「接人」、取還裝備為「領取租借裝備」、其他為「一般停靠」，而且不把預設任務寫入停靠點，使停靠點之後改變種類時改用新種類的預設任務；Itinerary_Text 依需求 31.6 也以這個預設任務的名稱寫出這個停靠點。
9. WHEN Trip_Member（包括 Collaborator）刪除路線，THE LM_Server SHALL 刪除這條路線與它的停靠點，不新增、修改或刪除任何採買品項，原本分到這些停靠點的品項由 Shopping_Plan 重新推導；要刪除的路線已不存在（例如其他成員已先刪除）時，依需求 7.12 不寫入也不推送。
10. WHEN Trip_Member 儲存一天的設定，THE LM_Core SHALL 只接受旅行範圍內的日期、Trim_White 之後不超過 20 字的標題（保存 Trim_White 之後的內容；是空的時視為未設定）、地點清單中的地點或未設定的地點（選擇 Destination_Place 或「不指定地點」時存為未設定，代表跟著旅行目的地）、Time_Value 或留空的預計抵達時間，以及「路線在活動之前」或「路線在活動之後」，並以 400 拒絕其他內容：日期不在旅行範圍內時說明「資料驗證未通過，沒有儲存。請重新載入後再試。」，標題過長時說明「標題最多 20 個字。」，地點不在地點清單中（例如已被其他成員刪除）時說明「請重新選擇地點。」，預計抵達時間不符合時說明「請以 24 小時制填寫完整的時和分，例如 08:30；不填時請清空。」。
11. WHEN Trip_Member 儲存一天的設定，而儲存後這一天的標題、地點與預計抵達時間都未設定，THE LM_Core SHALL 刪除這一天的設定，路線位置因此回到預設的「路線在活動之前」；這一天原本就沒有設定時，這次儲存依需求 7.12 不產生變化。
12. THE LM_Core SHALL 只以規劃者在這一天的設定中填寫的預計抵達時間作為當天的抵達時間，不從路線的出發時間、停靠點的時間或行車時間推算；Itinerary_Text 的抵達行依需求 31.8 只使用這個時間，沒有填寫的日子不輸出抵達行。
13. WHEN Trip_Member 在規劃行程修改當天料理的用餐時間，THE LM_Server SHALL 只更新那道料理的用餐時間，料理的其他欄位與採買品項都不變：填寫 Time_Value 時存為該時間；留空時清除用餐時間，使料理改用需求 24.3 的餐次預設用餐時間；不是 Time_Value 也不是留空時以 400 拒絕並說明「請以 24 小時制填寫完整的時和分，例如 08:30；不填時請清空。」。
14. THE Schedule_Tab SHALL 在 Unassigned_Shopping 區塊唯讀列出 Shopping_Plan 無法分到任何 Shopping_Stop 的每個採買品項，包括已買的品項（另外標示「已買」）；品項依列舉值的採買分類順序分組、同一分類內依建立順序排列，每個品項旁顯示原因：負責人為待分配時為「待分配」，負責人不是任何車輛的駕駛或乘客時為「{旅伴名字}不在任何車上」，負責人所在的車輛（依車輛的 Ordinal，第一台以他為駕駛或乘客的車）沒有 Shopping_Stop 時為「{車名}還沒有採買停靠點」。
15. WHEN Trip_Member 儲存一天的設定，THE LM_Server SHALL 只更新這次儲存中改過的欄位（標題、地點、預計抵達時間、路線位置），其他欄位保留目前的值；兩位 Trip_Member 同時修改同一天的不同欄位時，結果保留兩者的修改，修改同一欄位時以後提交者的值為準。
16. WHEN Optimistic_View 中旅行的起訖日期改變（包括自己的修改，以及經 Change_Feed 收到其他成員的修改），THE Schedule_Tab SHALL 繼續選取原本選定的第 N 天，並以新的日期顯示第 N 天的設定、路線卡片、活動與料理；新的天數少於 N 時，改選最後一天。
17. WHILE 旅行沒有車輛，或選定的 Trip_Day 每台車都已有路線，THE Schedule_Tab SHALL 停用「新增路線」按鈕，並在按鈕旁顯示原因：沒有車輛時為「還沒有車輛，新增車輛後就能安排路線」，每台車都已有路線時為「每台車這一天都已有路線」。

### Requirement 23: 行程表：活動

**User Story:** 身為規劃行程的人，我希望以常用活動快速加入每天的活動，也能新增自訂活動並指定參加的人或車，以便每天的安排一目了然。

#### Acceptance Criteria

1. WHEN Trip_Manager 或 Collaborator 按下「加入 N 個活動」或儲存「＋自訂活動」的表單，THE LM_Server SHALL 在同一次提交中新增全部的活動，全部新增或全部不新增：每個已勾選而且不是「已加入」的 Activity_Preset 在選定的 Trip_Day 新增一筆，標題、時間與類別等於該 Activity_Preset，參加者為全體旅伴，地點與備註空白；自訂活動在表單選擇的 Trip_Day（預設為選定的 Trip_Day）新增一筆；新增的活動都是未完成；LM_Server 不因同一天已有同類別或同標題的活動而拒絕或合併（例如兩位成員同時加入同一個 Activity_Preset，會得到兩筆活動）。
2. THE Schedule_Tab SHALL 依時間由早到晚列出選定日子的 Activity_Preset，每項顯示時間、標題與活動類別：第一天（2 天以上旅行的第 1 天）為 13:00「搭帳・營地佈置」（搭帳）、20:00「星空夜聊・自由活動」（夜晚）；中間的日子（第一天與最後一天以外的日子）為 08:00「起床」（起床）、10:00「自由活動、拍照」（自由活動）、14:00「下午茶、聊天、玩遊戲」（下午茶／遊戲）、20:00「自由活動」（夜晚）；最後一天（2 天以上旅行的最後一天）為 08:00「起床」（起床）、10:00「拆帳、整理裝備」（拆帳）、11:30「環境清潔、裝車」（清潔）、12:00「集合、返程」（返程）；一日遊（只有 1 個 Trip_Day 的旅行）為第一天與最後一天的全部 6 項。類別與選定日子任一筆活動相同的 Activity_Preset（依 Optimistic_View 判斷）顯示為已勾選、停用並標示「已加入」；「加入 N 個活動」的 N 是其餘已勾選的項目數，按鈕只在 N 至少為 1 時可以使用。
3. WHEN 一個 Command 新增或修改活動，THE LM_Core SHALL 先以 Trim_White 去除標題、地點與備註的前後空白，再只接受旅行範圍內（Trip_Day 之一）的日期、Time_Value 的時間（必填）、1–100 字的標題、0–150 字的地點（自由文字，不引用地點清單）、0–1000 字的備註，以及列舉值中的 13 種活動類別之一，並儲存去除空白之後的文字。
4. THE LM_Core SHALL 把活動的參加者記為三者之一：全體旅伴（不列出旅伴，之後新增的旅伴也包括在內）、指定旅伴（1 位以上、這趟旅行中存在的旅伴），或指定車輛（1 台以上、這趟旅行中存在的車輛，而且不指定旅伴）；一個 Command 的結果使指定旅伴或指定車輛沒有任何元素時（例如指定甲、乙兩位的活動，兩位成員同時各取消其中不同的一位），改記為全體旅伴。
5. IF 新增之後這趟旅行的活動會超過 1000 筆（例如已有 998 筆時一次加入 3 個 Activity_Preset；已有 999 筆時仍可新增 1 筆），THEN THE LM_Server SHALL 拒絕整個 Command、不新增任何一筆，並回應 409「活動最多 1,000 筆，請先刪除不需要的活動。」。
6. WHEN Trip_Manager 或 Collaborator 勾選或取消活動列的「完成」，THE LM_Server SHALL 把這筆活動的完成狀態設為 Check_Command 指定的值，不改變這筆活動的其他欄位；完成狀態已經等於指定的值時，依需求 7.12 不寫入也不推送。
7. WHEN Trip_Manager 或 Collaborator 刪除活動，THE LM_Server SHALL 刪除這筆活動與它的指定旅伴、指定車輛，不改變其他列（被指定的旅伴與車輛仍然存在）。
8. THE Schedule_Tab SHALL 把選定日子的活動依時間由早到晚排列，時間相同時依 Ordinal 由小到大排列；每一列顯示時間、標題、活動類別的中文名稱（例如 pitch 顯示「搭帳」）與「完成」勾選框，勾選框的狀態等於這筆活動的完成狀態。
9. WHEN Trip_Manager 或 Collaborator 儲存既有活動的表單，THE LM_Server SHALL 只以 Command 送出的欄位（標題、日期、時間、類別、參加者、地點與備註中使用者改過的欄位，需求 7.8）更新這筆活動，其他欄位、id、Ordinal 與完成狀態保持不變；送出的日期是另一個 Trip_Day 時，這筆活動移到那一天。
10. IF 新增或修改活動的 Command 不符合本需求第 3 條或第 4 條，THEN THE LM_Core SHALL 拒絕整個 Command、Trip_State 保持不變，並以 400 回應第一個不符合的欄位（依標題、日期、時間、類別、參加者、地點、備註的順序；多筆時依送出的順序）與下列訊息（LM_Web 依需求 13.2 在送出前顯示同一訊息）：標題去除空白後是空的「請填寫標題。」、標題超過 100 字「標題最多 100 個字。」、日期不在旅行範圍內「請重新選擇日期。」、時間空白「請填寫時間，例如 08:30。」、時間不是 Time_Value「請以 24 小時制填寫完整的時和分，例如 08:30。」、類別不是 13 種活動類別之一「請選擇類別。」、指定的旅伴不存在「請重新選擇參加的旅伴。」、指定的車輛不存在「請重新選擇參加的車。」、地點超過 150 字「地點最多 150 個字。」、備註超過 1000 字「備註最多 1,000 個字。」。
11. IF 要修改或勾選完成的活動已不存在（例如已被其他成員刪除），THEN THE LM_Server SHALL 回應 404「找不到這個活動。」，Trip_State 保持不變，也不推送；要刪除的活動已不存在時，依需求 7.12 視為沒有變化。

### Requirement 24: 料理菜單

**User Story:** 身為負責料理的旅伴，我希望依日期與餐次安排料理與食材，而且我的修改即時出現在其他人的畫面上，以便大家一起準備，不用一再重新整理。

#### Acceptance Criteria

1. THE Menu_Tab SHALL 只為有料理的 Trip_Day 各顯示一個日期區塊，依日期遞增排列，區塊標題為「{月}/{日} 週{X}」（月、日不補零）與「DAY {第幾天，以兩位數表示} · {這一天的料理數} 道料理」（例如「10/20 週二」與「DAY 01 · 2 道料理」）；區塊內的料理先依餐次（早餐、午餐、下午茶、晚餐、消夜）、再依 Ordinal 排列，不依用餐時間排序；旅行沒有任何料理時，改為顯示「這趟旅行，想吃點什麼？」與「新增餐次，安排第一道料理。」。
2. WHEN Trip_Member 或 Admin 新增或修改料理，THE LM_Core SHALL 依下列順序檢查新增或修改後的料理，以第一個不符合的條件拒絕，Trip_State 保持不變（找不到料理為 404，其餘為 400）：修改的料理已不存在時，說明找不到這道料理；餐次不是列舉值的五種之一、插圖種類不是列舉值的八種之一也不是未設定，或名稱、食材、備註含有 U+0000；日期不在旅行範圍內時，說明「請重新選擇日期。」；用餐時間不是 Time_Value 也不是留空時，說明「請以 24 小時制填寫完整的時和分，例如 08:30；不填時請清空。」；名稱超過 100 字時，說明「料理名稱最多 100 個字。」（名稱可以留空）；負責人不是這趟旅行的旅伴也不是待分配時，說明負責人已不在旅伴名單；份數不是 1–100 的整數時，說明「人數請填 1 到 100 的整數。」；食材超過 2,000 字時，說明「食材最多 2,000 字，請先整理清單。」；備註超過 1,000 字時，說明「料理筆記最多 1,000 個字。」（LM_Web 依需求 13.2 在送出前做同樣的檢查，並在表單中顯示同一則訊息；Shopping_Sync 的採買品項上限只在提交時依需求 25.15 檢查）。
3. WHILE 料理的用餐時間留空，THE LM_Core SHALL 以餐次的預設用餐時間（早餐 08:30、午餐 12:00、下午茶 15:00、晚餐 18:00、消夜 21:00）作為這道料理在 Schedule_Tab 與 Itinerary_Text 中的時間，而且不把預設時間寫入料理。
4. THE Menu_Tab SHALL 在料理表單提供現行 `RECIPE_TEMPLATES` 的 8 道料理範本，以及 `COMMON_INGREDIENTS` 分成 9 組、共 57 個的常用食材捷徑，內容（範本的名稱、食材、備註與插圖種類，捷徑的分組與名稱）都與現行相同；食材欄已有相同 Ingredient_Key 的食材時，對應的捷徑按鈕停用並標示為已選取（`aria-pressed="true"`）。
5. WHILE 料理沒有設定插圖種類，THE LM_Core SHALL 依現行 `inferDishKind()` 推斷插圖種類：先依料理名稱，名稱沒有符合的規則時再依 Ingredient_Parser 切出的食材，兩者都沒有符合時為 custom（通用餐盤）；名稱或食材改變後依新的內容重新推斷，推斷的結果不寫入料理。
6. WHEN LM_Web 顯示插圖種類（設定的，或依需求 24.5 推斷的）為 custom 的料理，THE LM_Web SHALL 只依料理 id 從 7 種通用餐盤中選一種，使同一道料理在每位成員的每個分頁、每台裝置與每次重新繪製都顯示同一種；只要插圖種類仍是 custom，修改名稱、食材或其他欄位都不換圖。
7. IF 旅行已有 1000 道料理時新增料理，THEN THE LM_Server SHALL 以 409 拒絕新增，訊息說明料理最多 1,000 道，Trip_State 保持不變。
8. WHEN Trip_Manager 刪除料理，THE LM_Server SHALL 在同一次提交中刪除這道料理，並依需求 25 執行 Shopping_Sync；料理已不存在（例如另一位 Trip_Manager 剛刪除）時，依需求 7.12 視為沒有變化，不寫入也不推送。
9. WHEN 一次提交新增、修改或刪除料理（包括在 Schedule_Tab 修改用餐時間、從料理移除食材，以及改日期搬動料理），THE LM_Web SHALL 不需重新載入，就在其他已開啟這趟旅行的分頁（包括同一個 Account 的其他分頁）中，於 Menu_Tab 只新增、更新、移動或移除受影響的料理卡片（需求 14.1–14.3），並在同一次更新中顯示同一個 Change_Set 對 Shopping_Tab 採買品項與 Schedule_Tab 當天料理的變化（需求 10.3）：在需求 10.6 的條件下，這些變化在提交後 2 秒內出現；斷線或分頁休眠期間的提交，在重新加入 Trip_Channel 並依需求 12 補齊後出現；兩位成員同時修改同一道料理的不同欄位時，每個分頁最後都顯示兩者的修改，修改同一個欄位時都顯示後提交者的值（需求 7.5、7.6、12.14）。
10. THE Menu_Tab SHALL 在每張料理卡片顯示插圖、餐次、料理名稱、「{份數} 人份 · 主廚 {負責人的旅伴名稱}」（沒有負責人時為「主廚 待分配」）、「食材」後接 Ingredient_Parser 切出的名稱（以「、」串接，沒有食材時為「尚未填寫」）、備註經 Trim_White 之後不是空的時可展開的「料理筆記」，以及編輯按鈕；料理名稱經 Trim_White 之後是空的時，卡片標題改顯示餐次，編輯與刪除按鈕的無障礙名稱也以餐次代替名稱（例如「編輯 晚餐」）；卡片與料理表單中的刪除按鈕只對 Trip_Manager 顯示（Collaborator 的刪除依需求 6.6 以 403 拒絕）；其他 Account 正在編輯這道料理時，依需求 16 在卡片標題列的右側顯示 Editor_Stack。
11. WHEN 使用者在料理表單套用料理範本或按下常用食材捷徑，THE LM_Web SHALL 只修改表單的草稿，在使用者儲存表單之前不送出 Command：以 Ingredient_Parser 切分「原有食材」接上「範本或捷徑的食材」的文字，再以「、」串接（現行 `mergeIngredients()`），使原有食材保留原本的順序，Ingredient_Key 已出現的食材不再加入；套用範本時另把名稱、備註與插圖種類換成範本的內容，表單的名稱或備註經 Trim_White 之後不是空的，或已設定與範本不同的插圖種類時，先詢問「套用範本會更新料理名稱、筆記與圖片；原有食材會保留並合併。確定套用？」，使用者取消時草稿不變；合併後的食材超過 2,000 字時草稿不變，並顯示「合併後食材超過 2,000 字，請先整理食材。」（套用範本）或「食材最多 2,000 字，請先整理清單。」（按下捷徑）。
12. WHEN 使用者在料理表單改變一道已設定用餐時間的料理的餐次並儲存，THE LM_Web SHALL 在同一個 Command 中把用餐時間改為留空，使這道料理改用新餐次的預設用餐時間（沿用現行 `saveMeal()`）。

### Requirement 25: 料理食材與採買同步

**User Story:** 身為負責採買的旅伴，我希望料理的食材自動出現在採買清單，而且自動同步不會刪掉我手動加入或已經買好的品項，以便採買清單永遠跟得上菜單。

#### Acceptance Criteria

1. WHEN LM_Server 執行通過權限與驗證的新增料理（`AddMeal`）、修改料理（`UpdateMeal`，不論改了哪些欄位）、刪除料理（`RemoveMeal`）、從料理移除食材（`RemoveIngredientFromMeals`），或新增、修改、刪除採買品項（`AddShoppingItem`、`UpdateShoppingItem`、`RemoveShoppingItem`）的 Command，THE LM_Server SHALL 在同一次提交中執行 Shopping_Sync，並把 Primary_Effect 與 Shopping_Sync 造成的全部變化放在同一個 Change_Set；其他 Command，包括勾選已買（`SetShoppingPurchased`），都不執行 Shopping_Sync。
2. THE LM_Server SHALL 是唯一執行 Shopping_Sync 的地方：每次提交在 Command_Executor 鎖住這趟旅行之後，以套用 Primary_Effect 之後的 Trip_State（已包含這趟旅行之前的所有提交）為輸入，只執行一次 Shopping_Sync；LM_Web 在預測 Command、合併 Change_Set 與讀取 Snapshot 時都不執行 Shopping_Sync。
3. THE Ingredient_Parser SHALL 先對整段食材文字做 NFKC 正規化，再以「、」「;」「/」「。」、CR（U+000D）與 LF（U+000A）切開，這些符號在兩個數字之間也切開（例如「1/2 顆洋蔥」切出「1」「2 顆洋蔥」）；半形「,」與「.」只在前一個與後一個字元都是 ASCII 數字 0–9 時保留（例如 1.5、1,000），其他情況（包括位在開頭或結尾）一律切開。全形「，」「；」「／」「．」經 NFKC 後是半形的「,」「;」「/」「.」，U+FF64「､」與 U+FF61「｡」經 NFKC 後是「、」「。」，都依上述規則處理；例如「牛奶 1.5L/白米 1,000g.雞蛋」切出「牛奶 1.5L」「白米 1,000g」「雞蛋」，「牛肉､豬肉」切出「牛肉」「豬肉」，「１，０００g 麵粉」切出「1,000g 麵粉」。
4. THE Ingredient_Parser SHALL 對切開的每一段去除前後的 JS_Whitespace、把內部連續的 JS_Whitespace 換成一個半形空格、捨棄變成空字串的段落，再以 Ingredient_Key 去除重複：每個鍵只保留第一次出現的名稱，並保持第一次出現的順序；例如「雞 蛋、雞蛋、 ＡＢＣ , abc」切出「雞 蛋」「ABC」，空字串，以及只由分隔符號和空白組成的文字（例如「、 , ，；」），都切出空的清單。
5. THE Ingredient_Parser SHALL 對任何食材文字，讓切出的名稱依序以「、」串接後再切一次，得到與第一次相同的名稱與順序。
6. THE Shopping_Sync SHALL 讓每道料理需要的每個 Ingredient_Key（Ingredient_Parser 從這道料理的食材文字切出的每個名稱的 Ingredient_Key）都至少由一個採買品項涵蓋，也就是品項名稱經 Ingredient_Parser 切分後含有這個鍵；例如手動品項「甜椒、玉米」同時涵蓋「甜椒」與「玉米」，品項「雞 蛋」涵蓋「雞蛋」。
7. WHEN 料理需要的某個 Ingredient_Key 在同步前沒有被任何採買品項涵蓋，THE Shopping_Sync SHALL 為這個鍵新增一個 Meal_Item：名稱為依料理的建立順序、同一道料理內依食材文字的順序，這個鍵第一次出現的名稱（Ingredient_Parser 處理後的寫法）；數量為「數量待確認」；分類由 Ingredient_Classifier 依名稱決定；負責人待分配；未買；沒有「料理已移除」標記；連動需要這個鍵的每一道料理。同一次同步新增的多個 Meal_Item 依同一個順序取得 Ordinal。
8. THE Shopping_Sync SHALL 只為同步前沒有被任何採買品項涵蓋的 Ingredient_Key 新增品項，每個鍵最多新增一個 Meal_Item；例如料理「牛肉片、牛肉片、高麗菜」與「高麗菜、牛肉片」只產生「牛肉片」與「高麗菜」兩個品項。兩位 Trip_Member 同時新增都需要「牛肉」、而清單還沒有「牛肉」的料理時，後提交者的 Shopping_Sync 以先提交者新增的「牛肉」品項涵蓋這個鍵，清單只有一個「牛肉」品項，並連動兩道料理。
9. THE Shopping_Sync SHALL 為每個料理需要的 Ingredient_Key，從同步前涵蓋它的品項中指定一個負責的品項：Manual_Item 與已買的品項優先，其中 Ordinal 最小者負責；沒有這樣的品項時，由未買的 Meal_Item 中 Ordinal 最小者負責。每個留下的品項恰好連動需要它所負責之鍵的料理；沒有負責任何料理需要的鍵的品項不連動任何料理。
10. THE Shopping_Sync SHALL 刪除每一個未買、而且沒有負責任何料理需要的鍵的 Meal_Item，並且不刪除其他品項。
11. THE Shopping_Sync SHALL 保留每個 Manual_Item 與每個已買的品項；對留下的品項只改變連動的料理、「料理已移除」標記，以及依本需求第 12 條把來源改為 Manual_Item，名稱、數量、分類、負責人、已買狀態與 Ordinal 都不變。
12. WHEN 已買的 Meal_Item 已沒有負責任何料理需要的鍵，THE Shopping_Sync SHALL 留下它並改為 Manual_Item；之後即使取消已買或又有料理需要它，它仍是 Manual_Item。
13. THE Shopping_Sync SHALL 只在下列兩個條件都成立時讓留下的品項標記為「料理已移除」，否則讓它沒有這個標記：（1）它名稱切出的每個 Ingredient_Key 都不是任何料理需要的鍵；（2）它在同步前連動至少一道料理，或已標記為「料理已移除」。例如刪除唯一需要「冰塊」的料理後，原本連動它的手動品項「冰塊」被標記；之後新增需要「冰塊」的料理時取消標記；從未連動料理的手動品項不會被標記。
14. WHEN Shopping_Sync 以自己的結果為輸入再執行一次，THE Shopping_Sync SHALL 不產生任何變化：不新增、不刪除，也不改變任何一列。
15. IF Shopping_Sync 之後的採買品項（留下的品項加上新增的 Meal_Item）會超過 1000 項，THEN THE LM_Server SHALL 拒絕整個 Command 並回應 409「採買品項最多 1,000 項，請減少食材或整理採買清單後再儲存。」，Trip_State 保持不變、Seq 不增加，也不推送；恰好 1000 項時照常提交。
16. WHEN Trip_Member 或 Admin 從選定的一道或多道料理移除一個採買品項（`RemoveIngredientFromMeals`），THE LM_Core SHALL 依 LM_Server 提交當下的食材文字，把每道選定料理的食材文字改為：Ingredient_Parser 切出的名稱中，去掉 Ingredient_Key 屬於這個品項名稱切出之鍵的名稱，其餘依原順序以「、」串接（例如「牛肉片, 板豆腐/高麗菜」移除「高麗菜」後為「牛肉片、板豆腐」）；沒有選定的料理不變，品項是否保留由同一次提交的 Shopping_Sync 決定。
17. THE Ingredient_Classifier SHALL 依現行 `classifyIngredient()` 的規則與順序，以名稱的 Ingredient_Key 決定 11 種採買分類之一：先比對完全相同的單字表（肉、雞、豬、牛為肉類；魚為海鮮；蛋、奶為蛋奶；米、麵為主食；水、茶為飲料；鹽、糖、油為調味料；蔬菜為蔬菜），再依序比對規則表並採用第一條符合的規則，都不符合時為「其他」；例如「雞粉」為調味料、「茶葉蛋」為蛋奶、「地瓜」為主食、「地瓜葉」為蔬菜、「冰塊」為其他。
18. IF 新增料理或修改料理的食材文字時，食材文字不超過 2000 字，但 Ingredient_Parser 切出的任一名稱超過 100 字，THEN THE LM_Server SHALL 拒絕這個 Command 並回應 400「每項食材最多 100 字，請用頓號或換行分隔不同的食材。」，Trip_State 保持不變；名稱恰好 100 字時接受。
19. WHEN Shopping_Sync 刪除一個仍被支出連結的採買品項，THE LM_Server SHALL 依需求 29.13 在同一次提交中清除這些支出的採買連結。
20. IF 從料理移除食材的 Command 指定的品項不存在、沒有選定任何料理，或任一選定的料理不存在（例如已被其他成員刪除），THEN THE LM_Server SHALL 拒絕整個 Command，Trip_State 保持不變，並依下列順序以第一個成立的原因回應：品項不存在時 404「找不到這個採買品項。」；沒有選定料理時 400「請至少勾選一道料理。」；料理不存在時 404「找不到這道料理。」。

### Requirement 26: 採買清單

**User Story:** 身為負責採買的旅伴，我希望看到分類好的採買清單、誰負責買與是否已買，並能即時勾選，以便分工採買時不重複、不漏買。

#### Acceptance Criteria

1. THE Shopping_Tab SHALL 依列舉值的採買分類順序（肉類、海鮮、蔬菜、水果、蛋奶、豆製品、主食、調味料、飲料、零食、其他）分組列出採買品項，只顯示至少有一個品項的分類，並在分類標題旁顯示「{N} 項」；同一分類內依 Ordinal 排列，換了分類的品項依原本的 Ordinal 排進新的分類；每個品項顯示名稱、數量、「誰負責買」選單（選項依序為「待分配」與依 Ordinal 排列的每位旅伴「{旅伴名稱}負責」），以及無障礙名稱為「{品項名稱}已買齊」的已買勾選；Linked_Item 另外顯示「料理：」與它連動的料理標題（需求 31.11 的「{餐次}：{料理名稱}」，依需求 24.1 的順序以「、」連接）；沒有任何採買品項時顯示「目前沒有品項」。
2. WHEN Trip_Member 新增手動品項，THE LM_Core SHALL 先以 Trim_White 去除名稱與數量的前後空白，再依序拒絕不符合的輸入：名稱是空的時說明「請填寫品項名稱。」；名稱超過 100 字時說明「品項名稱最多 100 個字。」；數量超過 40 字時說明「數量與單位最多 40 字。」，數量可以是空的；分類必須是 11 種採買分類之一，負責人必須是這趟旅行的旅伴或待分配；通過檢查的品項是未買的 Manual_Item。
3. IF 符合第 2 條的新品項名稱經 Ingredient_Parser 切分後的任一 Ingredient_Key，等於提交當下任一既有品項名稱切分後的 Ingredient_Key（例如已有「牛肉片」時新增「牛肉 片」，或已有「薑」時新增「蔥、薑」；既有品項包括 Meal_Item、已買的品項，以及其他 Trip_Member 先提交的品項），THEN THE LM_Server SHALL 回應 409「清單已有同名品項，請編輯既有品項的數量與分類。」，不新增任何品項。
4. IF 新增的品項通過第 2 條與第 3 條的檢查，而旅行已有 1000 個採買品項（包括 Meal_Item 與已買的品項），THEN THE LM_Server SHALL 回應 409「採買品項最多 1,000 項，請減少食材或整理採買清單後再儲存。」，不新增品項。
5. WHEN Trip_Member 修改採買品項，THE LM_Core SHALL 只檢查這次送出的欄位，先以 Trim_White 去除名稱與數量的前後空白，再依序拒絕不符合的輸入：名稱是空的時說明「請填寫品項名稱。」；名稱超過 100 字時說明「品項名稱最多 100 個字。」；數量是空的時說明「請填寫數量與單位。」；數量超過 40 字時說明「數量與單位最多 40 字。」；分類必須是 11 種採買分類之一，負責人必須是這趟旅行的旅伴或待分配。
6. IF Trip_Member 把提交當下是 Linked_Item 的品項改成另一個符合第 5 條的名稱（經 Trim_White 之後與目前的名稱不同），THEN THE LM_Server SHALL 回應 409「連動食材名稱請在料理菜單修改。」並拒絕整個 Command，同一次送出的數量、分類與負責人也不套用。
7. WHEN Trip_Member 只修改品項的數量（包括在清單中直接修改數量），THE LM_Core SHALL 保留品項原本是 Meal_Item 或 Manual_Item，名稱、分類、負責人與已買狀態也保持不變。
8. WHEN Trip_Member 把品項的名稱、分類或負責人改成與目前不同的值（包括在清單中直接選擇負責人），THE LM_Core SHALL 把品項改為 Manual_Item，使之後的 Shopping_Sync 不再刪除它，已買狀態保持不變。
9. WHEN Trip_Member 勾選或取消已買，THE LM_Server SHALL 把品項的已買狀態設為送出的值，與品項原本的狀態及其他 Trip_Member 先提交的勾選或修改無關，也不回應衝突（例如兩位成員同時對同一個品項送出勾選與取消，兩個 Command 都成功，品項為後提交者送出的值）；名稱、數量、分類與負責人保持不變，來源只在第 10 條的情況改變。
10. WHEN Collaborator 把已買的 Meal_Item 改為未買，THE LM_Core SHALL 同時把品項改為 Manual_Item，使之後修改或刪除料理都不會刪除它；Trip_Manager 把已買的 Meal_Item 改為未買時，品項仍是 Meal_Item，之後沒有料理需要它時由 Shopping_Sync 依需求 25.10 移除。
11. WHEN Trip_Manager 刪除不是 Linked_Item 的品項，THE LM_Server SHALL 在同一次提交中刪除品項，並依需求 29.13 清除支出對它的採買連結。
12. IF Trip_Manager 要刪除的品項在提交當下是 Linked_Item（包括其他成員剛提交的料理修改使它開始連動），THEN THE LM_Server SHALL 回應 409「連動料理的品項不能直接刪除，請改從料理移除這項食材。」，品項、料理與支出都保持不變。
13. WHEN 一個 Permission_Table 允許的 Command 使 Shopping_Sync 依需求 25.10 移除 Meal_Item（例如 Collaborator 從料理刪掉這項食材），THE LM_Server SHALL 在同一次提交中執行這個移除而不回應 403，並依需求 29.13 清除支出對被移除品項的採買連結。
14. WHILE 品項帶有 Shopping_Sync 的「料理已移除」標記（需求 25.13），THE Shopping_Tab SHALL 在品項名稱之後顯示「料理已不需要，保留採買品項」。
15. WHEN Trip_Member 勾選或取消已買，THE LM_Web SHALL 不等 LM_Server 回應就在這個分頁顯示品項的新狀態，並在 Command 提交後，於需求 10.6 的條件下 2 秒內，在其他分頁開啟中的 Shopping_Tab 與品項負責人開啟中的 Departure_Page 顯示相同的狀態，Shopping_Tab 只重繪這一個品項；當時沒有連線的分頁在重新加入 Trip_Channel 並依需求 12.2 補齊之後顯示。
16. IF Trip_Member 勾選、修改或從料理移除的採買品項在提交當下已不存在（例如其他 Trip_Member 剛刪除它，或 Shopping_Sync 剛移除它），THEN THE LM_Server SHALL 回應 404「找不到這個採買品項。」，不寫入也不推送；Trip_Manager 要刪除的品項已不存在時，依需求 7.12 視為沒有變化，Collaborator 刪除品項時仍依需求 6.6 先回應 403。
17. WHEN 任何 Trip_Member（包括 Collaborator）在 Shopping_Tab 選擇移除 Linked_Item，THE Shopping_Tab SHALL 開啟「移除這項食材？」對話框，依需求 24.1 的順序列出它連動的每一道料理並預設全部勾選；按下「確認移除」時依需求 25.16 從勾選的料理移除這項食材，沒有勾選任何料理時顯示「請至少勾選一道料理。」而且不送出 Command。

### Requirement 27: 裝備分工

**User Story:** 身為旅伴，我希望知道哪些裝備每個人都要帶、哪些共用裝備由誰負責，並勾選自己打包好的裝備，以便出發前確認大家都準備好了。

#### Acceptance Criteria

1. THE Gear_Tab SHALL 依序列出兩組裝備：個人裝備（每位旅伴各帶一份）以「每個人，都帶一份」為標題，共用裝備（由一位負責人準備）以「公用裝備，一起分工」為標題，標題後顯示該組的項數「N 項」；組內依 Ordinal 排列，每列顯示名稱與數量；個人裝備列標示「每人一份」，共用裝備列以負責人選單顯示目前的負責人，選項為「待分配」與依 Ordinal 排列的每位旅伴（「{旅伴名字}負責」）；沒有裝備的組不顯示，這趟旅行沒有任何裝備時顯示「這裡已經都分配好了。」。
2. WHEN Trip_Manager 或 Collaborator 新增或修改裝備，THE LM_Core SHALL 先以 Trim_White 處理名稱與數量，再以這次新增或修改之後的裝備內容依序檢查，並拒絕第一個不符合的項目（LM_Server 回應 400）：名稱是空的時說明「請填寫必要欄位，不能只有空白。」；名稱超過 100 字時說明「裝備名稱最多 100 個字。」；數量超過 40 字時說明「數量與單位最多 40 個字。」（數量可以是空的）；個人裝備有負責人時說明「個人裝備每人各帶一份，不能指定負責人。」；共用裝備的負責人不是這趟旅行現有的旅伴時說明「找不到這位旅伴。」（沒有負責人的共用裝備為待分配，可以接受）。通過檢查時儲存處理後的名稱與數量。
3. IF 旅行已有 1000 個裝備時新增裝備，THEN THE LM_Server SHALL 回應 409「裝備最多 1000 項，目前已額滿。」。
4. WHEN Trip_Manager 或 Collaborator 修改裝備，THE LM_Core SHALL 只在範圍於個人與共用之間改變，或共用裝備的負責人改變（包括改為待分配，以及由待分配改為一位旅伴）時，在同一次提交中清空這個裝備所有旅伴的打包勾選。
5. WHEN Trip_Manager 或 Collaborator 新增裝備、修改裝備的名稱、數量、範圍或負責人（至少一項的值改變），或 Trip_Manager 刪除裝備，THE LM_Core SHALL 在同一次提交中刪除這趟旅行所有旅伴的出發確認。
6. WHEN Trip_Member 為自己的 Bound_Person 勾選或取消 My_Gear 中一個裝備的打包勾選，THE LM_Server SHALL 把這位旅伴在這個裝備的打包狀態設為 Command 指定的值，與原本的值無關，也不改變其他旅伴在這個裝備的打包狀態；打包狀態已是指定的值時，依需求 7.12 不寫入也不推送。
7. IF Trip_Member 為自己的 Bound_Person 勾選或取消一個存在、但不在他 My_Gear 中的裝備（其他旅伴負責的共用裝備，或待分配的共用裝備），THEN THE LM_Server SHALL 回應 403「只能勾選自己的個人裝備或負責的共用裝備。」。
8. WHEN Trip_Member 為自己的 Bound_Person 取消一個裝備的打包勾選，THE LM_Core SHALL 在同一次提交中刪除這位旅伴的出發確認，其他旅伴的出發確認保持不變。
9. THE Gear_Tab SHALL 顯示打包勾選、Gear_Progress 與待分配的數量：每個個人裝備以旅伴名字列出依 Ordinal 排列的每位旅伴是否已打包；每個有負責人的共用裝備顯示負責人是否已打包，待分配的共用裝備不顯示打包勾選；Gear_Progress 顯示為「裝備準備 done / total」；有 N 個（N ≥ 1）未分配負責人的共用裝備時顯示「還有 N 項公用裝備待分配，出發前記得找個主人。」，N 為 0 時不顯示這段提示；只有檢視者自己的 Bound_Person 在 My_Gear 中的打包勾選可以點選，其他旅伴的打包勾選只顯示、不能點選，沒有 Bound_Person 的檢視者不能點選任何打包勾選。
10. WHEN Trip_Manager 刪除裝備，THE LM_Server SHALL 在同一次提交中刪除這個裝備，以及所有旅伴在這個裝備的打包勾選。
11. WHEN 使用者在裝備表單把有負責人的共用裝備改為個人裝備並儲存，THE LM_Web SHALL 在同一個 Command 中把範圍改為個人裝備並清空負責人。
12. IF 要修改或變更打包勾選的裝備已不在這趟旅行中（例如已被其他成員刪除），THEN THE LM_Server SHALL 在依需求 6 判斷權限之後回應 404「找不到這個裝備。」；要刪除的裝備已不存在時，依需求 7.12 視為沒有變化。
13. WHEN 使用者在共用裝備列的負責人選單改選另一位旅伴或「待分配」，THE LM_Web SHALL 立即送出只修改這個裝備負責人的 Command，不需開啟表單。

### Requirement 28: 出發清單

**User Story:** 身為旅伴，我希望出發前在一個畫面看到自己要準備的東西與下一個活動，並確認出發，以便大家知道誰已經準備好了。

#### Acceptance Criteria

1. WHEN Trip_Member 開啟 Departure_Page，THE Departure_Page SHALL 依 Optimistic_View 顯示他的 Bound_Person 的行前清單：Packing_Progress，顯示為「{已打包項數} / {My_Gear 項數} 項準備完成」與百分比；這趟旅行有未分配負責人的共用裝備時，另有「別落下全隊的裝備」、「{名稱}還沒有人負責。」（{名稱} 是這些裝備依 Ordinal 以頓號「、」連接的名稱）與前往 Trip_Page 的 Gear_Tab 的「回去分配」；分成「自己的小行李」（個人裝備）與「我負責的公用裝備」兩組、各依 Ordinal 排列的 My_Gear，每項有名稱、數量與他的打包勾選（需求 27.6）；「我負責的食材 {已買項數} / {品項數}」，其下依 Ordinal 列出負責人是他的採買品項，每項有名稱、數量（數量為「數量待確認」時不顯示）、已買勾選（需求 26.9），以及 Shopping_Plan 分到的 Shopping_Stop「第 N 天在{地點名稱}」（屬於 Unassigned_Shopping 時不顯示），沒有這種品項時顯示「目前沒有分配給你的食材。」；「確認出發」按鈕，文字為「確認準備完成，出發」，只在他沒有出發確認、而且在 Optimistic_View 中滿足 Can_Depart 時可以按下；以及本需求第 5 條的下一個未完成的活動。
2. WHEN Trip_Member 為自己的 Bound_Person 確認出發（`SetDeparted`，出發 = 是），THE LM_Server SHALL 為這位旅伴新增出發確認；不滿足 Can_Depart 時依本需求第 3 條拒絕，他已有出發確認時依需求 7.12 不寫入也不推送。
3. IF LM_Server 執行 `SetDeparted`（出發 = 是）時，這位旅伴在執行當下已提交的 Trip_State 中不滿足 Can_Depart（例如另一位成員先提交了新的個人裝備，或把共用裝備改為待分配），THEN THE LM_Server SHALL 回應 400「個人裝備尚未準備完成，或仍有共用裝備未分配。」，依需求 7.15 不寫入也不推送。
4. WHEN Trip_Member 為自己的 Bound_Person 取消出發確認（`SetDeparted`，出發 = 否），THE LM_Server SHALL 刪除這位旅伴的出發確認，不檢查 Can_Depart；他沒有出發確認時，依需求 7.12 不寫入也不推送。
5. THE Departure_Page SHALL 以檢視者的 Bound_Person 的 Person_Activity 中，未完成的活動依日期、時間與 Ordinal 遞增排序後的第一筆，作為下一個未完成的活動，並顯示它的標題、日期（M/D）、時間、地點（空白時為「地點待確認」）、參加者與備註；沒有這樣的活動時，顯示「你目前沒有待完成的行程。」與「可回規劃手冊查看全隊行程，或確認自己搭乘的車輛。」。
6. WHEN LM_Web 開啟 Departure_Page，THE LM_Web SHALL 依需求 11 與需求 12 加入這趟旅行的 Trip_Channel、讀取 Snapshot 或補齊（與開啟 Trip_Page 時相同），並依需求 10.5 與 10.6 不需重新載入就顯示其他成員的變更，包括刪除檢視者的出發確認（需求 19.9、19.12、27.5）或改變他的 My_Gear 的變更；同一個分頁經 App 內的連結從 Trip_Page 前往 Departure_Page 時，沿用記憶體中的 Replica 與 Pending_Command，不重新讀取 Snapshot（需求 10.5）。
7. WHILE 檢視者的 Bound_Person 已有出發確認，THE Departure_Page SHALL 以「準備好了，一起出發！」取代標題「出發前，把小幸福帶齊。」、以停用的「已準備完成」取代「確認準備完成，出發」按鈕，並只在這段期間於下一個未完成的活動下方提供「完成這一站」按鈕，以 `SetActivityDone`（完成 = 是）把那筆活動設為完成。
8. WHEN Unbound_Admin 開啟 Departure_Page，THE Departure_Page SHALL 以標題「你目前以管理員身分檢視」、說明「尚未加入此旅行，因此沒有個人行前清單。你仍可編輯所有旅行內容。」與前往 Trip_Page 的「回到規劃手冊」按鈕取代行前清單，不顯示打包勾選、已買勾選、下一個未完成的活動與「確認出發」。

### Requirement 29: 分帳記帳

**User Story:** 身為旅伴，我希望記下誰付了什麼、怎麼分攤與誰還了誰，並看到每個人的餘額與建議轉帳，以便旅行結束時快速結清。

#### Acceptance Criteria

1. WHILE 檢視者是 Trip_Member，THE Ledger_Tab SHALL 顯示支出的總金額與「{N} 筆支出」、「＋ 新增支出」與「記錄還款」按鈕、第 11 條的「誰該還誰」，以及支出與還款的清單：兩者各自依日期由新到舊排列，同一天依 Ordinal 由小到大；支出依日期分組並顯示每天的支出合計，每筆顯示標題、支出分類、金額、「{付款人} 付款」與分攤方式（分攤旅伴是全部旅伴時為「全員平分」，否則為「{人數} 人平分」），有連結時加上「採買：{品項名稱}」，有備註時加上備註；每筆還款顯示「{付款人} → {收款人}」、金額與日期；每筆支出與還款都有編輯按鈕，只有有 Bound_Person 的 Trip_Manager 看得到刪除按鈕，按下後在那一列顯示確認提示（支出為『確定從帳本移除「{標題}」{金額}？大家的結餘會跟著改變。』，還款為『確定移除這筆還款紀錄？只會修改帳本，不會退回或取消任何實際付款。』），選擇「確認移除」才送出刪除，選擇「取消」則不送出；金額依第 5 條的格式顯示；沒有任何支出與還款時，以「還沒有支出。」取代「誰該還誰」與清單。
2. WHEN Trip_Member 新增或修改支出，THE LM_Core SHALL 以執行當下的 Trip_State 依序檢查新增的支出，或套用這次修改之後的支出（分攤旅伴以加入與移除的旅伴套用，使其他成員同時加入或移除的不同旅伴都保留；標題與備註以 NFC 正規化並經 Trim_White 之後的值檢查與儲存），並拒絕不符合的支出：標題是空的或超過 100 字時說明「請填寫 1–100 字的項目名稱。」，含有 Hidden_Control_Char 時說明「項目名稱不能包含隱藏控制字元。」；日期不是年份 0001–9999 的有效日期時說明「請選擇有效的日期。」（日期不限於旅行的日期範圍，旅行改日期時也不搬動）；金額不在 1–100,000,000 分（NT$0.01–1,000,000）時依第 5 條說明；付款人未選擇時說明「請選擇付款人。」，不是這趟旅行的旅伴時說明「付款人不是這趟旅行目前的旅伴。」；沒有分攤旅伴時說明「請至少選擇一位分攤的旅伴。」，有分攤旅伴不是這趟旅行的旅伴時說明「分攤旅伴不是這趟旅行目前的旅伴。」（分攤旅伴是 1–100 位不同的旅伴，可以不包含付款人）；分類不是列舉值的 18 種支出分類之一時說明「請選擇分類。」；備註超過 500 字時說明「備註最多 500 字。」，含有換行（LF 或 CRLF）與 Tab 以外的 Hidden_Control_Char 時說明「備註不能包含隱藏控制字元。」；連結的採買品項不在這趟旅行時說明「找不到連結的採買品項，請重新選擇。」（也可以不連結；連結只作標示，不改變採買品項）。
3. WHEN Trip_Member 新增或修改還款，THE LM_Core SHALL 以執行當下的 Trip_State 依序檢查新增的還款，或套用這次修改之後的還款，並拒絕不符合的還款：付款人或收款人未選擇時說明「請選擇付款與收款的旅伴。」，不是這趟旅行的旅伴時說明「付款人不是這趟旅行目前的旅伴。」或「收款人不是這趟旅行目前的旅伴。」；付款人與收款人相同時說明「付款人與收款人不能是同一位。」；金額不在 1–100,000,000 分時依第 5 條說明（金額可以與建議轉帳或目前的欠款不同，多還的部分依第 7 條成為反方向的建議轉帳）；日期不符合第 2 條的日期規則時說明「請選擇還款日期。」；備註不符合第 2 條的備註規則時以第 2 條的訊息說明。
4. IF 旅行已有 1000 筆支出時新增支出，或已有 1000 筆還款時新增還款，THEN THE LM_Server SHALL 回應 409「支出最多 1000 筆。」或「還款紀錄最多 1000 筆。」，Trip_State 保持不變；修改或刪除既有的帳目不受這個上限限制。
5. THE LM_Core SHALL 依現行 `parseAmount()` 把輸入的金額解析成整數的分：先做 NFKC 並經 Trim_White，再去除開頭的「NT$」「NTD」「TWD」或「$」（不分大小寫）與結尾的「元」，只接受半形數字 0–9、每三位一個半形逗號的千分位與最多兩位小數（例如「350」為 35000、「 NT$1,234.56 」為 123456、「１２０元」為 12000、「12.」為 1200）；去除後是空的時說明「請輸入金額。」，以「-」開頭或換算後為 0 時說明「金額必須大於 0。」，小數超過兩位時說明「金額最多到小數點後兩位（角、分）。」，超過 NT$1,000,000 時說明「單筆金額最多 NT$1,000,000。」，其他格式（例如「1,23」「1e3」「0x10」「١٢٣」）說明「請輸入有效的金額，例如 350 或 120.5。」；Command 中的金額小於 1 分時以「金額必須大於 0。」、大於 100,000,000 分時以「單筆金額最多 NT$1,000,000。」拒絕；並依現行 `formatMoney()` 把分顯示為「NT$」加上每三位一個逗號的整數元，分不為 0 時再加上兩位小數，負數在最前面加「-」（例如 0 為「NT$0」、1 為「NT$0.01」、123456 為「NT$1,234.56」、-12050 為「-NT$120.50」）。
6. THE LM_Core SHALL 依現行 `splitEvenly()` 平均分攤每筆支出：每位分攤旅伴先得到 ⌊金額 ÷ 人數⌋ 分，餘下的 r 分依旅伴 id（UUID 的小寫十六進位字串）遞增排序，各 1 分分給排在前面的 r 位，使分攤金額的總和等於支出金額、任兩位分攤旅伴相差最多 NT$0.01（例如 NT$10 由 3 人分攤為 NT$3.34、NT$3.33、NT$3.33，NT$3.34 給 id 最小的旅伴；NT$0.01 由 2 人分攤時，id 較大的旅伴分攤 NT$0）。
7. THE LM_Core SHALL 依現行 `summarizeLedger()` 計算每位旅伴的淨額 = 已付（他付款的支出金額總和）− 分攤（第 6 條分給他的金額總和）+ 已還出（他作為付款人的還款總和）− 已收回（他作為收款人的還款總和），使所有旅伴淨額的總和為 0；並產生建議轉帳：淨額小於 0 與大於 0 的旅伴各自依淨額的絕對值由大到小排列（相同時依旅伴 id 遞增），從兩邊的第一位開始，每次由目前的欠款者轉給目前的應收者兩人剩餘金額中較小的金額，剩餘為 0 的一方換成下一位，使建議轉帳全部記錄為還款之後每位旅伴的淨額都是 0（例如 A 付款 NT$2 由 A、B 分攤，B 還給 A NT$1.50 之後，建議轉帳為 A → B NT$0.50）。
8. THE LM_Core SHALL 依現行 `suggestExpenseCategory()` 由支出標題建議支出分類：標題經 NFKC 之後依序檢查，含有「木炭、瓦斯、火種、燃料、點火」任一詞時為「露營耗材」；含有「帳篷、天幕、睡袋、睡墊、營燈、營柱、營釘、營繩、行軍床、折疊椅、卡式爐」任一詞時為「露營裝備」；含有「衛生紙、濕紙巾、垃圾袋、洗碗精、海綿、牙刷、牙膏、毛巾、防蚊」任一詞時為「日用品」；含有「停車、過路、高速公路、油錢、汽油、柴油、車票、計程車」任一詞時為「交通」；含有「營位費、住宿、房費、營地費」任一詞時為「住宿」；都不含時，Ingredient_Classifier 把標題分到「其他」則為「其他」，分到其他採買分類 c 則為「食材／c」。
9. WHEN 有 Bound_Person 的 Trip_Manager 刪除支出或還款，THE LM_Server SHALL 刪除這筆帳目（支出連同它的分攤旅伴），其他帳目與採買品項保持不變。
10. WHEN 一位 Trip_Member 新增、修改或刪除帳目，THE LM_Web SHALL 依需求 10（同一台電腦或區域網路中 2 秒內）在其他 Trip_Member 開啟中的 Ledger_Tab 只新增、更新或移除那一筆，並依 Optimistic_View 重新計算總金額、餘額與建議轉帳，不需重新載入；斷線期間發生的帳目變更，在重新加入 Trip_Channel 之後依需求 12 補齊。
11. WHILE 檢視者是 Trip_Member，THE Ledger_Tab SHALL 在「誰該還誰」依旅伴的 Ordinal 列出已付、分攤、已還出或已收回至少一項不為 0 的旅伴，每位顯示名字、淨額（大於 0 為「應收回 {淨額}」，小於 0 為「需補 {淨額的絕對值}」，等於 0 為「已結清」）與「已付 {金額} · 分攤 {金額}」，已還出或已收回不為 0 時再分別加上「 · 已還出 {金額}」與「 · 已收回 {金額}」；有建議轉帳時，在「建議還款」之下依第 7 條產生的順序，每筆顯示「{付款人} → {收款人}」、金額，以及「已還款」按鈕，按鈕開啟還款表單，並預填這筆的付款人、收款人、金額與今天（瀏覽器所在時區）的日期。
12. WHILE 檢視者是 Unbound_Admin，THE Ledger_Tab SHALL 依需求 6.18 只顯示「你不是這趟旅行的旅伴，無法查看或記錄分帳。」，不顯示本需求第 1 條與第 11 條的任何內容。
13. WHEN 一次提交刪除了被支出連結的採買品項（Trip_Manager 依需求 26.11 刪除品項，或 Shopping_Sync 依需求 25.10 移除已沒有料理需要的 Meal_Item），THE LM_Server SHALL 在同一次提交中把連結這些品項的每一筆支出改為不連結採買品項，並把這些支出放進同一個 Change_Set：支出的其他欄位不變；這個清除不套用帳目的權限限制，提交者是 Collaborator 或 Unbound_Admin 時也照樣清除；Command 也不因為這些連結而被拒絕。Trip_Manager 刪除品項時的清除屬於這個 Command 的 Primary_Effect；Shopping_Sync 移除品項時的清除屬於 Derived_Effect，LM_Web 依需求 13.4 不預測。

### Requirement 30: 邀請連結

**User Story:** 身為旅行的成員，我希望以只能使用一次的連結邀請旅伴加入，新旅伴也能用連結直接註冊，以便不必請管理員建立帳號。

#### Acceptance Criteria

1. WHEN Trip_Manager 或 Collaborator 建立邀請連結，THE LM_Server SHALL 產生只能使用一次的 Invite_Link `/invite/<token>`，以建立時間加 7 天（604,800 秒）作為到期時間，並在回應中回傳連結的路徑與到期時間；到了到期時間，這個連結就不再是 Active_Invite。
2. THE LM_Server SHALL 在 Database 中只保存邀請 token 的 SHA-256 雜湊值、不保存 token 本身，只在建立連結的回應中回傳 token，而且任何回應都不包含 token 的雜湊值。
3. IF 建立後這趟旅行的 Active_Invite 會超過 20 個，THEN THE LM_Server SHALL 拒絕建立並回應「每趟旅行最多 20 個有效邀請連結。」；多個建立請求同時送達時，成功建立的連結也不會使這趟旅行的 Active_Invite 超過 20 個。
4. IF Collaborator 建立後他在這趟旅行自己建立的 Active_Invite 會超過 5 個，而且這趟旅行的 Active_Invite 不會超過 20 個，THEN THE LM_Server SHALL 拒絕建立並回應「每位旅伴在每趟旅行最多 5 個有效邀請連結。」；他的多個建立請求同時送達時，成功建立的連結也不會使他的 Active_Invite 超過 5 個。
5. WHEN Trip_Manager 列出邀請連結，THE LM_Server SHALL 回傳這趟旅行全部的 Active_Invite，依建立時間由新到舊排列，每個包含建立者（建立這個連結的 Account）的 Display_Name、建立時間與到期時間。
6. WHEN Collaborator 列出邀請連結，THE LM_Server SHALL 只回傳這趟旅行中他自己建立的 Active_Invite，排列方式與每個連結的內容和需求 30.5 相同。
7. WHEN Trip_Manager 撤銷這趟旅行的任一 Active_Invite，或 Collaborator 撤銷他自己建立的 Active_Invite，THE LM_Server SHALL 讓這個連結在撤銷成功的回應之後不再是 Active_Invite：列出邀請連結時不再包含它，以它預覽、加入或以連結註冊時都依需求 30.13 回應。
8. IF Collaborator 撤銷別人建立的 Active_Invite，THEN THE LM_Server SHALL 回應 403「只有建立連結的人、主辦人或管理員可以撤銷邀請。」，這個連結仍是 Active_Invite。
9. WHEN 任何人開啟 Active_Invite 的 Invite_Page，或已登入的 Trip_Member 開啟這趟旅行已使用、但沒有撤銷也還沒到期的 Invite_Link，THE Invite_Page SHALL 顯示旅行名稱、目的地（空白時顯示「地點尚未填寫」）、起訖日期與「{建立者的 Display_Name} 邀請你加入」，未登入也能看到；使用者已是這趟旅行的 Trip_Member 時，另外顯示「你已經是這趟旅行的成員了，可以從旅行首頁打開手冊。」與前往 Home_Page 的連結，不顯示加入表單。
10. WHEN 不是這趟旅行 Trip_Member 的已登入使用者以 Active_Invite 加入並填寫旅伴名字與角色，THE LM_Server SHALL 鎖住這趟旅行後再次驗證連結，並在同一個資料庫交易中新增一位綁定這個 Account 的旅伴（一律新增，不綁定既有的旅伴；顏色依需求 19.8，並依需求 19.9 刪除所有出發確認）、把連結標記為已使用、以需求 10.1 的方式寫入並推送 Change_Set，再回應旅行 id，使其他 Trip_Member 依需求 10.5 與 10.6 不需重新載入就看到新旅伴；任何一步失敗時這個交易全部不生效，連結仍未使用。
11. WHEN 已是這趟旅行 Trip_Member 的使用者以沒有撤銷、還沒到期、旅行也沒有被刪除的 Invite_Link 加入（不論連結是否已使用），THE LM_Server SHALL 直接回傳旅行 id，不檢查填寫的旅伴名字與角色、不新增旅伴，也不把連結標記為已使用。
12. WHEN 未登入的訪客在 Invite_Page 以 Active_Invite 送出帳號名稱、顯示名稱、密碼、旅伴名字與角色，THE LM_Server SHALL 在同一次請求中依需求 3.1 至 3.6 的規則建立 Account、以這個 Account 依需求 30.10 加入旅行，並回傳已登入的 Session；這個註冊不受 `LM_PUBLIC_SIGNUP` 影響，任何一步失敗時都依需求 3.10 不留下 Account，也不新增旅伴、不把連結標記為已使用。
13. IF 預覽、加入或以連結註冊時 Invite_Link 不存在、已撤銷、已過期、它的旅行已被刪除，或已使用而且使用者不是這趟旅行的 Trip_Member，或撤銷時連結不是這趟旅行的 Active_Invite，THEN THE LM_Server SHALL 回應「邀請連結無效或已過期。」，不建立 Account、不新增旅伴，也不改變任何 Invite_Link；撤銷者沒有這趟旅行的權限或旅行已被刪除時，改依需求 6.2 或 6.3 回應。
14. WHEN 兩個以上加入或以連結註冊的請求同時使用同一個 Active_Invite，THE LM_Server SHALL 只讓其中一個請求新增旅伴並把連結標記為已使用；其餘請求的使用者已是 Trip_Member 時（例如同一個 Account 在另一個分頁先加入）依需求 30.11 回傳旅行 id，否則回應「邀請連結無效或已過期。」，以連結註冊的請求也依需求 3.10 不留下 Account。
15. THE LM_Core SHALL 以需求 19.1 至 19.7 的規則與訊息，檢查以邀請加入與以連結註冊時填寫的旅伴名字與角色。
16. THE LM_Server SHALL 讓邀請預覽只回傳旅行名稱、目的地、起訖日期與建立者的 Display_Name，已登入時另外回傳使用者是否已是這趟旅行的 Trip_Member；預覽不回傳其他 Trip_State，也不改變連結的狀態。
17. WHEN 有邀請權限的使用者按下旅行頁的「邀請旅伴」，THE LM_Web SHALL 開啟「邀請旅伴，名字讓他自己填」對話框，只顯示說明「對方用邀請連結登入或建立帳號後，再自行填寫這趟旅行使用的名字。」、完整的邀請網址（目前網頁的 origin 加上 `/invite/<token>`）、「這個連結 7 天內有效（到期：…）。」與「複製邀請網址」按鈕，不需要按「建立邀請連結」：開啟時自動建立連結；這個旅行頁先前產生的連結仍在需求 30.5 或 30.6 回傳的 Active_Invite 中時沿用它而不另外建立；建立中顯示「正在產生邀請連結…」；建立被拒絕或失敗時在對話框中顯示訊息與「再試一次」。WHEN 使用者開啟 Trip_Menu 的「邀請」，THE LM_Web SHALL 列出 Active_Invite，每個顯示建立者、建立時間、到期時間與「撤銷」按鈕，撤銷之後重新列出 Active_Invite。
18. WHEN Invite_Page 為不是這趟旅行 Trip_Member 的使用者顯示 Active_Invite，THE Invite_Page SHALL 顯示加入表單：未登入時包含帳號名稱、顯示名稱、密碼、旅伴名字（留空時以表單中的顯示名稱代替）與選填的角色，以及前往 `/login?next=/invite/<token>` 的「已經有帳號？登入後加入」連結；已登入時包含預先填入 Account 的 Display_Name 的旅伴名字與選填的角色；加入或註冊成功後，前往這趟旅行的 Trip_Page `/<帳號名稱>/trips/<旅行 id>`。

### Requirement 31: 文字版與複製

**User Story:** 身為旅伴，我希望把行程表變成一段固定格式的文字並一鍵複製，以便貼到聊天群組，而且同一份行程每次都得到同一段文字。

#### Acceptance Criteria

1. THE LM_Core SHALL 只由 Trip_State 的內容與順序鍵（日期、時間與 Ordinal）產生 Itinerary_Text，使相同的 Trip_State 永遠得到逐字相同的文字：結果與列的插入順序、檢視的 Account、裝置的時區與語系，以及產生的時間都無關。
2. THE Itinerary_Text SHALL 只由下列各行依序組成：旅行名稱一行；「車輛：{車名}、{車名}…」一行（車名依車輛的建立順序以「、」連接，沒有車輛時為「車輛：尚未安排」）；每個 Trip_Day 的區塊，依序為第 3 條的標題行、第 4 條的「地點」行、路線區塊（第 5 條與第 8 條的各行，可能沒有任何行）與活動區塊（第 9 至第 11 條的各行），路線區塊與活動區塊的先後依第 12 條調整；以及第 13 條的「未分配採買清單」區塊（可能沒有）。各行之間以一個換行字元（`\n`，U+000A）分隔，區塊之間不加空行，第一行之前與最後一行之後都沒有換行字元。現行文字版在旅行名稱之後另有行程繪本的標語與說明各一行（有設定時才有）；這兩項是行程繪本的海報設定，不在第一版的範圍內，所以 Itinerary_Text 不含這兩行。
3. THE Itinerary_Text SHALL 為旅行日期範圍內的每個 Trip_Day（包括沒有每日設定、路線、活動與料理的日子）依日期遞增輸出剛好一行「第 {n} 天・{M/D}（週{X}）｜{當日標題}」：n 是從 1 起算的半形數字，最大為旅行天數（1–31）；M/D 是不補零的月與日；X 是這個日期的星期（日、一、二、三、四、五、六之一）；當日標題沒有設定，或經第 14 條處理後是空字串時，寫「未命名的一天」（例如「第 1 天・10/20（週二）｜向山裡出發」、「第 2 天・10/21（週三）｜未命名的一天」）。
4. THE Itinerary_Text SHALL 緊接在每一天的標題行之後輸出「地點：{Day_Place 的名稱}」：Day_Place 是地點清單中的地點時寫它目前的名稱，是旅行目的地時寫目的地；沒有 Day_Place 時為「地點：未指定」。
5. WHEN 一天有至少一條路線，THE Itinerary_Text SHALL 在這一天的路線區塊輸出「路線」一行，接著每條路線一行「・{車名}｜{HH:MM} 出發：{起點} → {停靠點} → … → {終點}」：起點、依停靠點在路線中順序的每個停靠點（寫法見第 6 條）與終點以「 → 」連接，沒有停靠點時為「{起點} → {終點}」；起點或終點是 Destination_Place 時寫旅行目的地；出發時間留空時以「出發時間未填」取代「{HH:MM} 出發」；路線依路線的建立順序排列，與現行相同，因此可能與需求 22.2 依出發時間排列的路線卡片順序不同（例如「・小黃｜08:00 出發：台北車站 → 全聯（採買 09:30：豬肉片、高麗菜） → 福壽山農場」）。
6. THE Itinerary_Text SHALL 把每個停靠點寫成「{地點}（{任務}{時間}{：內容}）」：地點是停靠點的地點目前的名稱，Destination_Place 時寫旅行目的地；任務是列舉值「停靠點種類與任務」中這個停靠點任務的名稱，沒有指定任務時用需求 22.8 的預設任務；時間有填時為一個半形空格加 HH:MM，留空時為「・時間未填」；內容依序是採買品項（只有 Shopping_Stop 有，見第 7 條；現行行程繪本可以為其他種類的停靠點自訂品項，那是繪本專用的欄位，不在第一版）與經第 14 條處理後的停靠點備註，兩者都有時以「；」連接，只有一者時只寫那一者，兩者都沒有時省略「：」與內容（例如「全聯（採買 09:30：豬肉片、高麗菜；記得帶保冷袋）」、「租車站（取租車 08:00：記得帶駕照）」、「台中高鐵站（接人・時間未填）」）。
7. WHEN Itinerary_Text 輸出 Shopping_Stop，THE Itinerary_Text SHALL 以 Shopping_Plan 分到這個停靠點的採買品項（已買與未買都算）的名稱，依採買品項的建立順序以「、」連接，作為這個停靠點的採買品項：8 項以內全部列出；超過 8 項時只列前 7 項，再以「、」接上「等另外 N 項」，N 是品項總數減 7（例如 10 項時為前 7 個名稱加「、等另外 3 項」）；Shopping_Plan 沒有分到任何品項的 Shopping_Stop（例如同一台車日期較晚，或同一天在路線上較後面的採買停靠點）沒有採買品項。
8. WHEN 一天的每日設定有預計抵達時間，THE Itinerary_Text SHALL 以「預計 {HH:MM} 抵達{Day_Place 的名稱}」作為這一天路線區塊的最後一行（例如「預計 15:30 抵達福壽山農場」），沒有 Day_Place 時為「預計 {HH:MM} 抵達」；這一天沒有路線時不輸出「路線」一行，路線區塊只有這一行；抵達時間只取規劃者填寫的預計抵達時間，不由出發或停靠點的時間推算（需求 22.12），沒有填寫的日子不輸出抵達行。
9. THE Itinerary_Text SHALL 在每一天的活動區塊輸出「活動」一行，接著把日期為這一天的活動與料理依時間遞增排列，每筆一行「・{HH:MM} {標題}（{類別}）」，料理在行尾再加上「・餐點」：活動的時間是活動時間，料理的時間是用餐時間，沒有設定時用需求 24.3 的餐次預設時間；同一時間時活動排在料理之前，活動之間與料理之間各依建立順序；活動的標題經第 14 條處理，類別是列舉值「活動類別」中的中文名稱；已完成的活動照常列出，不輸出活動的地點、參加者與完成狀態，也不輸出料理的負責人、份數與食材；當天沒有任何活動與料理時，「活動」之後只有一行「無安排」（例如「・09:00 集合出發（集合）」）。
10. WHEN 一筆活動或料理的備註經第 14 條處理後不是空字串，THE Itinerary_Text SHALL 緊接在那筆活動或料理的行之後輸出一行：兩個半形空格加上處理後的備註（例如「  記得帶頭燈」）；備註是空的或只有空白時不輸出這一行。
11. THE Itinerary_Text SHALL 以「{餐次}：{料理名稱}」作為料理的標題，料理名稱經第 14 條處理後是空字串或與餐次相同時只寫餐次；料理的類別依序取第一個符合的條件：插圖種類（沒有設定時依需求 24.5 推斷）為 hotpot 時為「火鍋」、為 bbq 時為「烤肉」、為 breakfast 或 toast 時為「早餐」，餐次為早餐時為「早餐」、為午餐時為「午餐」，其他為「用餐」（例如「・12:00 午餐：咖哩飯（午餐）・餐點」、「・08:30 早餐（早餐）・餐點」、「・18:00 晚餐：什錦火鍋（火鍋）・餐點」）。
12. WHEN 一天的每日設定的路線位置為「路線在活動之後」，THE Itinerary_Text SHALL 在這一天的「地點」行之後先輸出整個活動區塊，再輸出整個路線區塊（包括第 8 條的抵達行）。
13. WHEN Unassigned_Shopping 中有負責人為待分配的採買品項（已買與未買都算），THE Itinerary_Text SHALL 在最後一天的區塊之後輸出「未分配採買清單」一行，接著依採買品項的建立順序，每個這類品項一行「・{品項名稱}」；負責人不在任何車上，或負責人所在的車沒有 Shopping_Stop 的品項不列在這個區塊；沒有負責人為待分配的品項時，不輸出這個區塊。
14. THE Itinerary_Text SHALL 對每段放進文字的使用者文字（旅行名稱、車名、地點名稱與旅行目的地、當日標題、停靠點備註、活動標題與備註、料理名稱與備註、採買品項名稱）先做 Trim_White，再把其中每一段含有換行字元（U+000A、U+000B、U+000C、U+000D、U+0085、U+2028 或 U+2029）的連續 Unicode White_Space 換成一個半形空格；不含換行字元的連續空白（例如兩個空格或一個 Tab）保留原樣，文字也不跳脫、不截斷，使 Itinerary_Text 中的換行字元只有分隔各行的 `\n`。
15. WHEN 使用者在 Schedule_Tab 按「複製文字」，THE Schedule_Tab SHALL 把按下當時「文字版」區塊顯示的 Itinerary_Text（依需求 14.5 由 Optimistic_View 產生，包括 Pending_Command 的效果）以純文字原樣寫入剪貼簿，不增刪任何字元，使貼到瀏覽器的多行文字欄位時得到逐字相同的文字；成功後把按鈕文字改為「已複製」，1.8 秒後恢復為「複製文字」；Trip_Manager 與 Collaborator 都可以複製，瀏覽器離線或 Trip_Channel 重新連線時也可以。
16. IF 寫入剪貼簿失敗（包括瀏覽器不提供剪貼簿功能，或拒絕寫入），THEN THE Schedule_Tab SHALL 選取「文字版」區塊中的整段 Itinerary_Text（選取範圍恰好是整段文字），讓使用者手動複製，並把按鈕文字改為「複製失敗」，1.8 秒後恢復為「複製文字」；剪貼簿原有的內容不變。
17. THE Schedule_Tab SHALL 在「文字版」區塊以純文字顯示依需求 14.5 產生的完整 Itinerary_Text：每個 `\n` 顯示為換行，保留行內的連續空白（例如備註行開頭的兩個空格），不加入其他文字，使區塊顯示的文字與 Itinerary_Text 逐字相同；使用者文字依需求 32.6 以文字輸出，不被當成 HTML 解讀。
18. THE Itinerary_Text SHALL 以下列字元寫固定的標點：「・」U+30FB、「｜」U+FF5C、「：」U+FF1A、「（」U+FF08、「）」U+FF09、「、」U+3001、「；」U+FF1B，以及前後各一個半形空格的「→」U+2192；數字、HH:MM 的冒號、M/D 的斜線，以及固定文字中的空格（例如「第 1 天」「預計 15:30 抵達」「等另外 3 項」）都是半形字元。

### Requirement 32: 畫面、路由與外觀沿用

**User Story:** 身為旅伴，我希望改寫後的 App 網址與外觀都和現在一樣，以便不必重新熟悉介面。

#### Acceptance Criteria

1. THE LM_Web SHALL 提供下列畫面：`/login`（登入）、`/register`（註冊）、`/invite/<token>`（Invite_Page）、`/<帳號名稱>/home`（Home_Page）、`/<帳號名稱>/trips/<id>?tab=<分頁>`（Trip_Page）與 `/<帳號名稱>/trips/<id>/go`（Departure_Page），其中 `<id>` 是旅行的 UUID，`<分頁>` 的值見需求 32.3，路徑結尾多出的 `/` 不影響對應（例如 `/login/` 等同 `/login`）；`/` 在有 Session 時前往自己的 Home_Page，沒有 Session 時前往 `/login`；已有 Session 時開啟 `/login` 或 `/register`，依需求 4.10 選擇目的地的規則前往 `next` 或自己的 Home_Page。
2. WHEN 請求的路徑不在 `/api/` 之下，也不是 `/realtime/v1/websocket`，THE LM_Server SHALL 回傳 `LM_STATIC_DIR` 中對應的檔案，找不到時回傳 `index.html`，使直接開啟或重新整理需求 32.1 的任何網址都會載入 LM_Web；不論路徑的內容為何（包括含有 `..` 區段或其百分比編碼 `%2e%2e` 的路徑），都不回傳 `LM_STATIC_DIR` 之外的檔案。
3. THE Trip_Page SHALL 顯示旅行封面（`src/app.js` 現行 `hero()` 的頁首區塊，插畫與現行相同，是營地 `camp` 的靜態插畫）與倒數，並在封面之下依序提供行程表（`schedule`）、料理菜單（`meals`）、採買清單（`shopping`）、裝備分工（`gear`）與分帳記帳（`expenses`）五個分頁；顯示的分頁由網址的 `tab` 決定，`tab` 缺少或不是這五個值時為行程表；切換分頁時不重新載入頁面、不新增瀏覽紀錄，只把 `tab` 改成新分頁的值；倒數以開始日減去台灣時間（UTC+8）今天的日期得到天數 D：D 大於 0 時依序顯示「距離出發」「{D}」「天」，D 等於 0 時為「今天出發」「GO」「!」，D 小於 0 時為「旅行手冊」「{Trip_Day 的天數}」「天的好日子」。
4. THE Trip_Menu SHALL 提供編輯旅行、旅伴、車輛與邀請，並只對 Trip_Manager 提供「刪除旅行」（Collaborator 的 Trip_Menu 沒有這一項）；「刪除旅行」先開啟沿用 `src/accounts-ui.js` 現行 `openDeleteTripDialog()` 文字的確認對話框，在輸入的文字與目前的旅行名稱完全相同之前（其他成員在對話框開啟期間改名時，以新的名稱為準），「確認刪除旅行」按鈕保持停用；刪除失敗時對話框保持開啟、旅行不變，並在對話框中顯示以「尚未刪除：」開頭的失敗原因。
5. THE LM_Web SHALL 只使用由現行插畫程式（`src/art.js`、`src/dish-art.js`）一次性輸出、提交在 `crates/web/assets/art/` 的靜態 SVG：`illustration()` 的 camp、travel、lake、forest、beach、sunrise、meal、market、night，`logo()`，以及 `dishIllustration()` 的 hotpot、bbq、toast、curry、pasta、breakfast、salad 各一個檔案，通用餐盤（custom）的 7 種變化為 `custom-0.svg` 至 `custom-6.svg`，使執行期與建置流程（`trunk build`）都不需要執行 JavaScript 來產生插畫；插圖種類為 custom 的料理依料理 id 決定使用哪一種變化，使同一道料理在每次重繪、重新載入，以及在每個分頁與每台裝置上都顯示同一張插圖。
6. THE LM_Web SHALL 只以 HTML 插入隨 App 提供的靜態 SVG（需求 32.5 的插畫，以及介面圖示）；使用者輸入的文字，以及從 LM_Server 與 Trip_Channel 收到的文字（包括其他成員在 Presence 回報的 Display_Name），一律以文字節點或屬性輸出，使含有 `<`、`>`、`&` 或引號的文字（例如名稱為 `<img src=x onerror=alert(1)>` 的料理）原樣顯示為文字，不產生任何元素，也不執行任何程式。
7. THE LM_Web SHALL 沿用現行的字型與樣式：把 `assets/fonts` 的全部 woff2 子集與 `jf-openhuninn-LICENSE.txt`、`OFL.txt`、`SOURCE.txt` 原樣複製到建置輸出的 `assets/fonts/`，使 `src/styles.css` 的每個 `@font-face` 都能載入；`src/styles.css`、`src/accounts.css`、`src/expenses.css` 除了刪除行程繪本、場景動畫與滑動手勢的選擇器之外不修改任何內容；對現行版有對應模板的畫面與區塊（design.md 4.1），除了省略範圍外功能的元素與加入需求 32.8 的新增元素之外，輸出與該模板相同的元素結構與 class 名稱；畫面一律以淺色主題顯示，不隨作業系統的深色模式改變。
8. THE LM_Web SHALL 只新增一個樣式檔 `presence.css`，其中只有 Editor_Stack 與 Editor_Avatar 的規則，顏色只引用既有的 `--card`、`--soft`、`--ink` 變數，也不定義新的 CSS 變數；Editor_Avatar 的底色與文字色以 inline style 套用 Avatar_Palette；第一版其他新增的元素（例如 Editing_Notice、「仍要編輯」按鈕，以及連線與儲存狀態的提示）只使用現行樣式檔中已有的 class。
9. IF 沒有 Session 的使用者開啟 Home_Page、Trip_Page 或 Departure_Page，THEN THE LM_Web SHALL 不讀取任何旅行資料、不加入 Trip_Channel，並前往 `/login?next=<目前的路徑>`（含 `?tab=<分頁>`，經 URL 編碼）。
10. IF Home_Page、Trip_Page 或 Departure_Page 網址中的 `<帳號名稱>` 不是 Session 的帳號名稱（Admin 也適用），THEN THE LM_Web SHALL 不讀取任何旅行資料、不加入 Trip_Channel，改為顯示沿用 `src/accounts-ui.js` 現行 `messagePage()` 的訊息頁：標題為「沒有權限查看這個頁面」，說明在 Home_Page 為「這是別人的旅行首頁。每個帳號只能看到自己的首頁，請回到你自己的首頁。」、在 Trip_Page 與 Departure_Page 為「旅行網址必須使用你自己的帳號名稱。請從你的首頁打開旅行。」，並提供前往自己 Home_Page 的「回到我的旅行首頁」按鈕。
11. IF 路徑不是 `/`，也不對應需求 32.1 的任何畫面（例如 `/setup`、`/admin`、`/demo/`，或 `<id>` 不是 UUID 的旅行網址），THEN THE LM_Web SHALL 顯示沿用現行 `messagePage()` 的訊息頁：標題為「找不到這個頁面」，說明為「網址可能打錯了，或這個頁面已經不存在。」，有 Session 時提供前往自己 Home_Page 的「回到我的旅行首頁」按鈕，沒有 Session 時提供前往 `/login` 的「前往登入」按鈕。

### Requirement 33: 核心規則的自動化測試

**User Story:** 身為維護這個 App 的開發者，我希望核心規則有自動化測試，並與現行版的結果比對，以便移植後的行為和現在一樣，之後修改也不會悄悄改變規則。

#### Acceptance Criteria

1. THE LM_Core SHALL 把 Bun_App 下列測試檔中每個以固定輸入斷言第一版規則的案例移植成範例測試（表格式案例的每一組輸入各算一個案例；以隨機產生輸入的屬性測試不在此列；括號內是各檔案主要涵蓋的規則）：`tests/ingredients.test.js`（食材切分與分類、Shopping_Sync、從料理移除食材）；`tests/meal-order.test.js` 與 `tests/recipes-invites.test.js`（餐次排序、料理範本、插圖種類推斷、合併食材，以及 Participant_Name 的正規化、同名與上限）；`tests/itinerary-model.test.js`、`tests/itinerary-place-name.test.js`、`tests/itinerary-time-input.test.js` 與 `tests/itinerary-numerals.test.js`（活動類別與 Activity_Preset、料理的用餐時間與標題、Hidden_Control_Char、地點名稱規則、Place_Key 與旅行目的地的衝突、Time_Value 的輸入、中文數字與日期文字）；`tests/itinerary-shopping.test.js` 與 `tests/itinerary-derive.test.js`（Shopping_Plan）；`tests/itinerary-dates.test.js` 中 `retimeByDayIndex()` 與 `shortenBlockedMessage()` 的案例（Retime）；`tests/expense-model.test.js` 與 `tests/ledger.test.js` 的計算部分（分帳計算）；`tests/model.test.js`（My_Gear、Can_Depart、打包進度、日期範圍與 Trip_State 的驗證）。每個移植的測試使用與原案例相同的輸入（現行的陣列順序改以 Ordinal 表示），預期值與原案例相同並直接寫在測試中，並以註解標明來源的測試檔與測試名稱；斷言第一版沒有的功能（例如 localStorage 的保存、HTML 跳脫、SVG 與行程繪本的插圖、規劃提醒、舊的餐次名稱、車輛的舊出發欄位 `meeting`），或斷言「與現行版的差異」表中已改變之行為的案例不移植，並以註解在對應的 Rust 測試檔列出這些案例的名稱與原因。
2. THE LM_Core SHALL 以一份固定的範例旅行（移植自 `tests/fixtures/example-trip.js` 的 `exampleTrip()` 資料，現行的陣列順序改以 Ordinal 表示）產生 Itinerary_Text，並要求它與提交在 Repository 中的一個預期文字檔完全相同（每個字元與換行都相同，最後一行之後沒有換行字元）；預期文字檔依需求 31 撰寫，不使用同一個檔案的 `EXAMPLE_TEXT`，因為 `EXAMPLE_TEXT` 是 trip-planning-workflow-enhance 舊文字產生器的格式，現行 App 已不顯示這個格式。這份預期文字等於現行行程繪本「複製文字」對同一份資料複製的文字，只多了一行：第 1 天由規劃者填寫的預計抵達時間 12:00 產生的「預計 12:00 抵達夕淞度日營區」，是那一天路線區塊的最後一行（需求 31.8）；範例的活動與料理都沒有備註，所以沒有需求 31.10 的備註行。
3. THE LM_Core SHALL 包含編輯者頭像的範例測試：Avatar_Initial 對「陳小明」為「陳」、對「  amy chen 」為「a」、對「🐻小熊」為「🐻」、對「👨‍👩‍👧 一家」為「👨‍👩‍👧」、對「🇹🇼台灣」為「🇹🇼」、對 `e` 加 U+0301 再加「va」為 `e` 加 U+0301，對空字串、只有全形空白（U+3000），以及只有 tab 與換行的名稱為「・」（U+30FB）；Avatar_Palette 的 12 色逐一以 WCAG 2.x 的公式重算對比，每一色都不低於 4.5:1，而且文字色是 `--ink` 與白色中對比較高的那一個；以 FNV-1a 64 位元的公開測試向量（空輸入與 ASCII 字元「a」）驗證雜湊；以及至少 3 個固定 Account id（包括 16 個位元組全為 0 與全為 255 的 id）的色盤索引，預期索引以常數寫在測試中。
4. THE LM_Core SHALL 包含 Editor_Stack 的範例測試：0 位編輯者時結果中沒有這個 Edit_Target；1 位與 3 位時全部顯示、沒有「+N」；4 位時顯示 Account id 最小的 3 位與「+1」；10 位時顯示 Account id 最小的 3 位與「+7」；同一個 Account 的兩個分頁編輯同一個 Edit_Target 時只算一位；檢視者自己的 Account（包括在檢視者其他分頁與裝置上的編輯）不列入；以 Account id 遞減的順序提供 Presence_Meta 時，結果仍依 Account id 遞增排列；並以下列文字為預期值：Editor_Avatar 的無障礙名稱為「陳小明 正在編輯」、滑鼠提示為「陳小明」，顯示名稱是空的時分別為「有人 正在編輯」與「未設定顯示名稱」；其餘兩位依序為林大華、王小美時，「+N」的無障礙名稱為「另外 2 人正在編輯：林大華、王小美」；Editing_Notice 只有陳小明時為「陳小明 正在編輯這一項」，陳小明排第一位、共 4 人時為「陳小明 等 4 人正在編輯這一項」；顯示名稱是空的編輯者在「+N」的名稱與 Editing_Notice 中以「有人」代替；顯示名稱前後有空白或超過 30 個字元時，這些文字使用 Trim_White 之後的前 30 個字元。
5. THE LM_Core SHALL 以 proptest 為 design.md「Correctness Properties」的 Property 1 至 19 各實作至少一個測試，屬性引用的共用產生器依該節所列的範圍產生輸入；每個屬性預設執行 256 個案例，設定環境變數 `PROPTEST_CASES=N` 時改為執行 N 個案例；每個測試上方註明 `// Feature: rust-supabase-rewrite, Property N: <標題>`，N 與標題和 design.md 中該屬性的標題相同。
6. WHEN proptest 找到失敗的案例並把它寫入 `proptest-regressions/` 的檔案，THE Repository SHALL 收錄這個檔案（不列入 `.gitignore`），修正之後也不刪除，使之後每次執行 `cargo test` 都先重跑記錄的案例。
7. THE LM_Supabase SHALL 以不連網路的單元測試驗證 Realtime 訊框的編碼與解碼及連線狀態機；測試以記錄送出內容的假 `RealtimeTransport` 與測試指定的時間執行，不等待實際時間，並驗證：(a) 加入 Trip_Channel 的訊息指定私有頻道 `trip:<旅行 id>`，並帶有這個分頁的 presence key 與目前的 access token；(b) 以 Supabase Realtime 協定文件的範例訊框為輸入，把加入成功、加入失敗（保留失敗原因）、broadcast、presence 的完整狀態、presence 的增減、頻道關閉、頻道錯誤、系統通知與 heartbeat 的回覆各解碼成對應的種類，不認得的事件解碼為「其他」，無法解析的文字回傳錯誤；(c) WebSocket 連上後（包括重新連線之後），對每個要加入的頻道各送出一次加入頻道的訊息；(d) 連上後未滿 20 秒不送出 heartbeat，滿 20 秒時送出，之後每 20 秒一次；(e) 送出 heartbeat 後滿 20 秒仍沒有收到它的回覆時，關閉連線並開始退避；(f) 斷線後第 1 至第 4 次重新連線前的等待時間分別不少於 1、2、5、10 秒，也不超過這些秒數的 1.2 倍，第 5 次起都在 10 至 12 秒之間，連上之後再斷線時從 1 秒重新開始；(g) 換發 Session 時，對每個已加入的頻道各送出一則帶有新 access token 的訊息，之後加入頻道的訊息也帶新的 access token。
8. THE Cargo_Workspace SHALL 通過 `cargo test`、`cargo clippy --workspace -- -D warnings`、`cargo fmt --check` 與 `trunk build --release`，每個指令的結束碼都是 0；`cargo test` 執行的測試不連到網路、Database 或 Realtime_Service，也不執行 Bun_App。
9. THE README SHALL 列出下列手動確認步驟與預期結果：兩個瀏覽器視窗開啟同一趟旅行，一邊把一個採買品項勾選為已買，另一邊在 2 秒內顯示這個品項已買；一邊在開發者工具切換為離線，離線期間兩邊各把一個不同的採買品項勾選為已買，恢復上線後 15 秒內兩邊都顯示這兩個品項已買；以兩個不同的 Account 開啟同一趟旅行，一邊開啟某張卡片的表單，另一邊在 7 秒內於那張卡片上看到對方的 Editor_Avatar，關閉表單後 7 秒內頭像消失。
10. THE LM_Core SHALL 包含 JavaScript 與 Rust 字元規則不同之處的範例測試，預期值是 Bun_App 對同一輸入的結果（現行的 Ingredient_Parser、Ingredient_Key 與 Participant_Name 使用 JS_Whitespace：U+FEFF 算空白、U+0085 不算；Ingredient_Classifier 規則中的數字只比對 0–9）：Ingredient_Parser 從 U+FEFF 加「雞蛋」切出「雞蛋」，從「雞」加 U+FEFF 加「蛋」切出「雞 蛋」且其 Ingredient_Key 為「雞蛋」，從 U+0085 加「雞蛋」切出仍以 U+0085 開頭的名稱；Participant_Name 把「小」加 U+FEFF 加「安」正規化為「小 安」；新增名字為「小」加 U+0085 加「安」的旅伴時，以「名字不能包含隱藏控制字元。」拒絕；Ingredient_Classifier 把「鹽」加 U+0663 分類為「其他」。
11. THE LM_Core SHALL 另以範例測試涵蓋範例旅行沒有用到的 Itinerary_Text 規則，每個案例都比對完整輸出，預期文字依需求 31.2 至 31.14 與 31.18 撰寫：沒有車輛（「車輛：尚未安排」）；沒有當日標題（「未命名的一天」）、沒有 Day_Place（「地點：未指定」），以及以地點清單中的地點為 Day_Place 的一天；沒有路線、活動與料理的一天（「活動」之後只有「無安排」）；同一天有多條路線、建立順序與出發時間的順序不同，以及出發時間留空的路線（「出發時間未填」）；四種種類的停靠點，包括指定任務與沒有指定任務（預設任務）、時間留空（「・時間未填」），以及備註有填與留空；同時有採買品項與備註的 Shopping_Stop（以「；」連接）、同一台車的第二個 Shopping_Stop（沒有採買品項），以及恰好 8 項與 9 項採買品項（9 項時為前 7 項加「、等另外 2 項」）；有預計抵達時間但沒有路線的一天（路線區塊只有抵達行），以及沒有 Day_Place 時的抵達行（「預計 {HH:MM} 抵達」）；同一時間的活動與料理（活動在前，再各依建立順序）、已完成的活動，以及料理名稱是空的或與餐次相同；料理類別的每一種情況（插圖種類為 hotpot、bbq、breakfast 與 toast，以及其他插圖種類時餐次為早餐、午餐與其他餐次）；有備註的活動與料理（備註行），以及只有空白的備註（沒有備註行）；路線位置為「路線在活動之後」的一天（活動區塊在前，路線區塊與抵達行在後）；未分配採買清單列出已買與未買的待分配品項、不列出負責人不在任何車上或負責人的車沒有 Shopping_Stop 的品項，以及沒有待分配品項時沒有這個區塊；含換行與前後空白的使用者文字，以及不含換行的連續空白保留原樣。
12. THE LM_Core SHALL 包含權限拒絕的範例測試，確認拒絕的種類與訊息與 Permission_Table 相同：不是 Trip_Member 也不是 Admin 的 Account 送出任一種 Command 時為 404「找不到這趟旅行。」；Collaborator 移除旅伴，或刪除車輛、料理、採買品項或裝備時為 403「受邀旅伴可以編輯，但不能刪除既有項目；請聯絡主辦人或管理員。」；Trip_Manager 或 Collaborator 變更其他旅伴的打包或出發確認時為 403「只能變更自己的行前準備。」；Collaborator 修改綁定其他 Account 的旅伴時為 403「只能修改自己的旅伴資料。」；Collaborator 刪除支出或還款時為 403「受邀旅伴可以新增或修改帳目，但不能刪除既有帳目；請聯絡主辦人或管理員。」；Unbound_Admin 新增、修改或刪除支出或還款時為 404「找不到這趟旅行。」。
