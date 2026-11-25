# Implementation Plan: Rust 全面改寫與自架 Supabase 即時同步（第一版）

## Overview

依設計文件以 Rust 實作：後端 `lm-server`（axum 0.8、sqlx 0.8、tokio）、前端 `lm-web`（Leptos 0.8 CSR，以 trunk 建置成 `wasm32-unknown-unknown`）、不做 IO 的共用規則 `lm-core`，以及精簡的 Supabase 用戶端 `lm-supabase`；資料庫結構以 SQL 遷移檔描述。工作在已建立並切換好的分支 `rust-supabase-rewrite` 上進行。開發改在 Windows 的 WSL 2（Ubuntu）中進行（design D14，工作慣例見 Notes）：Windows 原生的 Rust 工具鏈（windows-gnu）無法建置使用 `raw-dylib` 的 crate，新建置的 .exe 會被公司的應用程式控制擋下，Windows 上也沒有 Docker；建置工具、Rust 與 Docker Engine 都安裝在 WSL 中。使用者決定先做不需要 Docker 的 Cargo_Workspace 與 LM_Core，Spike 等 WSL 中的 Docker Engine 可以使用後再做，排在 Local_Stack、LM_Supabase 與 LM_Server 之前。依下列順序推進：

1. Cargo_Workspace 與工具鏈（任務 2）。
2. LM_Core（任務 4 至 10）：文字與型別、採買同步、行程推導與文字版、分帳、命令與權限、同步模型、Presence 與編輯者頭像。任務 11 為檢查點。
3. Spike（任務 1）：在本機 Supabase CLI 堆疊上確認兩個風險假設。R2：Broadcast from Database（`realtime.send()`）送到私有頻道 `trip:<id>`，而且 `realtime.messages` 的 RLS 政策對兩個用戶端都有效。R3：Auth_Service 接受 `.invalid` 網域的合成 email。兩者都通過才開始任務 3；任一項失敗時依任務 1.4 的備案停下來，與使用者決定。
4. Local_Stack 的 `supabase/` 設定與三個遷移檔（任務 3）。
5. LM_Supabase（任務 12）與 LM_Server（任務 13 至 16）。任務 17 為檢查點。
6. LM_Web（任務 18 至 24）：外觀資源與登入、首頁與邀請頁、同步引擎與旅行頁外框、五個分頁、旅行選單與出發清單、Presence 與編輯者頭像。任務 25 為檢查點。
7. README（任務 26）與最後的檢查點（任務 27）。
8. 管理後台增補（任務 28 至 33，需求 34 至 41）：先在 Local_Stack 確認重設密碼與登出的假設（任務 28.1），再做 Auth_Service 呼叫與遷移檔、LM_Core 的 `admin` 模組、LM_Server 的 Admin_Endpoint 與操作紀錄、LM_Web 的 Admin_Page，以及首次切換與管理員救援的文件。

實作注意事項：

- 每個頂層任務完成時，`cargo build` 與 `cargo test` 都能通過，可以在分支 `rust-supabase-rewrite` 上提交；不執行 `git push`。
- Bun_App 保持原狀（需求 1.9）：分支起點已存在的檔案中，只有 `.gitignore`（任務 2.3）與 `README.md`（任務 26）可以變更，而且只能新增內容；`rust-rewrite` 分支與 `.worktrees/rust-rewrite` 不動。新增的檔案只在根目錄的 Cargo 設定、`.env.example`、`crates/`、`supabase/` 與 `scripts/export-art.mjs`。
- 自動化測試只涵蓋需求 33：lm-core 的範例測試與 proptest 屬性測試，以及 lm-supabase 不連網路的 Realtime 協定與連線狀態機測試。lm-server 與 lm-web 不寫自動化測試；不建立 e2e、Lighthouse、資安或資料庫整合測試，也不處理 CI/CD 與資安強化。
- 屬性測試使用 proptest 的預設設定（256 個案例，並讀取環境變數 `PROPTEST_CASES`），測試中不覆寫案例數；每個屬性測試上方加註 `// Feature: rust-supabase-rewrite, Property N: <標題>`，標題與 design.md 相同；proptest 寫入的 `proptest-regressions/` 檔案提交進版本庫，修正之後也不刪除（需求 33.5、33.6）。
- 移植 Bun 測試的範例測試使用與原案例相同的輸入（陣列順序改以 Ordinal 表示），預期值直接寫在測試中，並以註解標明來源的測試檔與測試名稱；不移植的案例在對應的 Rust 測試檔以註解列出名稱與原因（需求 33.1）。
- `cargo build` 與 `cargo test` 不需要 Database 或網路：lm-server 只使用執行期檢查的 `sqlx::query`／`query_as`，不使用需要編譯期連線的 `query!` 巨集（需求 1.7、33.8）。
- 檢查點在 Repository 根目錄執行 `cargo test`、`cargo clippy --workspace -- -D warnings`、`cargo fmt --check` 與 `trunk build --release --config crates/web/Trunk.toml`，結束碼都必須是 0（需求 1.2、33.8）。

## Tasks

- [x] 1. Spike：在本機 Supabase CLI 堆疊上確認 R2 與 R3
  - [x] 1.1 準備暫存的 Supabase 專案與只綁 127.0.0.1 的 Docker 網路
    - 在 Repository 之外、WSL 的 Linux 檔案系統中準備暫存的 Supabase 專案（例如 `~/lm-spike`）：先前在 Windows 的 `%TEMP%\lm-spike` 建立的暫存專案可以整個複製過來，沒有時在新目錄執行 `supabase init`；`config.toml` 先套用 design「Repository 配置」的 `[auth]`、`[auth.email]` 設定，並關閉 Storage、Edge Runtime、Analytics 與本機郵件服務。這個任務不新增或修改 Repository 中的任何檔案
    - 在 WSL 中執行（`supabase` 指 Supabase CLI 3.2.0 的 Linux 版）：沒有 `lm-local` 網路時以 `docker network create -o "com.docker.network.bridge.host_binding_ipv4=127.0.0.1" lm-local` 在 WSL 的 Docker Engine 中建立，再以 `supabase start --network-id lm-local` 啟動；確認 `docker ps` 的每個埠都以 `127.0.0.1:` 開頭，並記下 `supabase --version` 與 Realtime、Auth 映像的標籤
    - 暫存的遷移檔只放確認需要的最小結構：`app.profiles`、`app.trips`、`app.people`、`app.trip_changes` 的必要欄位，以及照抄 design「Realtime 授權」的 `app.can_use_trip_topic()` 與兩個政策、「推送」的 `app.publish_trip_change()` 與 trigger；以 `supabase db reset` 套用
    - _Requirements: 2.1, 2.2, 3.13, 11.4, 11.5_

  - [x] 1.2 確認 Auth_Service 接受合成 email（R3）
    - 在 WSL 的暫存目錄以 `cargo new` 建立探測程式（reqwest、tokio、serde_json、tokio-tungstenite），在 WSL 中建置與執行；它不加入 Cargo_Workspace，也不提交
    - 以 service_role key 呼叫 `POST /auth/v1/admin/users` 建立 `spike-a@users.little-moments.invalid`（`email_confirm: true`），再以 `POST /auth/v1/token?grant_type=password` 取得 Session；同樣建立 B、C 兩個帳號供任務 1.3 使用
    - 確認直接呼叫 `POST /auth/v1/signup` 被拒絕而且沒有建立使用者；記下 access token 標頭的 `alg`、`kid`，以及 `/auth/v1/.well-known/jwks.json` 的回應，供任務 12.6 對照
    - _Requirements: 3.1, 3.11, 3.12, 3.13, 5.3_

  - [x] 1.3 以兩個用戶端確認 Broadcast from Database 與私有頻道授權（R2）
    - 以 SQL 建立一趟旅行：A 與 B 是綁定旅伴，C 只有 `app.profiles` 的資料；三個帳號各以 WebSocket 連到 `ws://127.0.0.1:54321/realtime/v1/websocket?apikey=<anon key>&vsn=1.0.0`，以 design 2.1 的 `phx_join` 設定（`private: true`、presence key、access token）加入 `realtime:trip:<旅行 id>`
    - 依序確認：A 與 B 加入成功；C 的加入以 `Unauthorized` 開頭的原因被拒絕；名稱不是 `trip:` 加小寫 UUID 的頻道被拒絕；提交一列 `app.trip_changes` 後 A 與 B 都收到 `changeset` 事件，C 沒有；回滾的交易不推送；payload 超過 65,536 位元組時收到 thin 通知；沒有任何連線者時提交照常成功；A 自己送出的 broadcast 不會送到 B；A 的 presence track 使 B 收到 `presence_state` 或 `presence_diff`
    - 把收到的訊框原文（加入成功與失敗、broadcast、presence、system、heartbeat 的回覆）存成暫存目錄中的文字檔，供任務 12.1 對照
    - _Requirements: 10.1, 10.2, 10.4, 10.7, 11.3, 11.4, 11.5_

  - [x] 1.4 判讀結果、決定是否繼續，並停止暫存堆疊
    - 兩項都通過：在 WSL 的暫存目錄執行 `supabase stop --no-backup`（任務 3 的 Local_Stack 使用相同的埠），再開始任務 3；記下的版本號在任務 26 寫進 README，暫存目錄在任務 12 完成後可以刪除
    - R3 不通過（例如 Auth_Service 以 `email_address_invalid` 拒收）：改以操作者控制的網域作為 `LM_AUTH_EMAIL_DOMAIN` 再試（design R3）；可行時停止，請使用者確認是否修改需求 3.12 的預設網域；任何網域都不行時停止，與使用者討論 design A7 的「email 加密碼」選項（帳號名稱登入是使用者已確認的 U4，不自行改變）
    - R2 不通過：先改用較新的 Supabase CLI 重試並記下版本（design R2）；仍不行時停止，請使用者決定是否改用 design A2 的「lm-server 提交後呼叫 Realtime REST broadcast」：推送不在同一個交易中，遺失的推送由水位線、跳號偵測與 Head 比對補齊（design D6、R9），需要修改需求 10.1 與 10.2
    - 使用者決定之前不開始任務 3 與任務 12 之後的任務
    - _Requirements: 2.10, 3.12, 10.1, 10.2_

- [x] 2. 建立 Cargo_Workspace 與工具鏈
  - [x] 2.1 建立 workspace 與工具鏈設定
    - 根目錄 `Cargo.toml` 依 design「Repository 配置」：`members` 只有 `crates/core`、`crates/supabase`、`crates/server`、`crates/web`，`default-members` 不含 `crates/web`，`exclude = [".worktrees"]`；`[workspace.package]` 與 release profile（`lto = true`、`codegen-units = 1`，lm-web 為 `opt-level = "z"`）
    - `rust-toolchain.toml` 指定 stable、`wasm32-unknown-unknown` 目標、rustfmt 與 clippy；`.cargo/config.toml` 只為 wasm32 目標加上 getrandom 0.3 的 `getrandom_backend="wasm_js"` cfg
    - _Requirements: 1.7, 1.8_

  - [x] 2.2 建立四個 crate 的骨架
    - `crates/core`（lm-core）：只依賴 design「Dependencies」列出的套件（日期原為不啟用 clock 的 chrono，2026-11-25 改為 time；測試另加 proptest），不依賴其他三個 crate；`lib.rs` 先宣告 design 1.1 的每個模組，內容由之後的任務填入
    - `crates/supabase`（lm-supabase）：feature `server`（reqwest、jsonwebtoken、tokio、async-trait）與 feature `web`（wasm-bindgen、web-sys 的 WebSocket、MessageEvent、CloseEvent、gloo-timers）；`lib.rs` 宣告 `realtime::protocol`、`realtime::socket`、只在 `feature = "web"` 而且 `target_arch = "wasm32"` 時編譯的 `realtime::web`，以及 feature `server` 的 `gotrue` 與 `jwt`；可以使用 lm-core 的型別，lm-core 不反向依賴
    - `crates/server`（lm-server，執行檔 `little-moments-server`）：design 列出的相依套件，以 feature `server` 引用 lm-supabase
    - `crates/web`（lm-web）：Leptos 0.8（csr）、leptos_router 0.8 與 design 列出的瀏覽器套件，以 feature `web` 引用 lm-supabase；`main.rs` 先掛載空白的 App；`index.html` 以 `data-trunk rel="rust"` 與 `data-wasm-opt="z"` 建置；`Trunk.toml` 依 design 4.7（輸出到 `dist`、只在 `127.0.0.1:8081` 監聽、`/api/` 代理到 `http://127.0.0.1:8080/api/`、`/realtime/v1/websocket` 以 `ws = true` 代理）
    - `cargo clippy --workspace` 也會以原生目標檢查 lm-web，所以 lm-web 的程式在原生目標也要能編譯，只有瀏覽器 WebSocket 傳輸以 `cfg(target_arch = "wasm32")` 隔開
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6, 1.10, 2.5_

  - [x] 2.3 新增 `.env.example`、更新 `.gitignore` 並鎖定相依版本
    - `.env.example`：除了以 `#` 開頭的註解與空行，只有需求 2.7 的 9 個環境變數各一行 `<名稱>=`，等號後沒有值（註解可以說明值來自 `supabase status -o env` 的哪一項）
    - 在 `.gitignore` 檔尾新增 `/target`、`/crates/web/dist`、`/supabase/.branches`、`/supabase/.temp` 與 `.env` 五行，既有的行不變；既有的 `!.env.example` 使 `.env.example` 不被忽略
    - 產生並提交涵蓋四個成員的 `Cargo.lock`，確認下列指令都成功：`cargo build --locked`（不建置 lm-web）、`cargo build -p lm-core --target wasm32-unknown-unknown`、`cargo build -p lm-web --target wasm32-unknown-unknown --locked`、`cargo test`、`cargo clippy --workspace -- -D warnings`、`cargo fmt --check` 與 `trunk build --release --config crates/web/Trunk.toml`（輸出到 `crates/web/dist`）
    - _Requirements: 1.2, 1.7, 1.8, 1.9, 2.7, 2.8_

- [x] 3. Local_Stack：`supabase/` 設定與三個遷移檔
  - [x] 3.1 `supabase/config.toml` 與空的種子檔
    - 在 WSL 中、Repository 根目錄（`/mnt/d/path/to/little-moments`）執行 `supabase init`，依 design「Repository 配置」調整 `supabase/config.toml`：API 埠 54321 而且 `api.schemas` 不含 `app`、Database 埠 54322、Studio 與 Realtime 開啟；`[auth]` 的 `site_url`、`enable_signup = false`、`jwt_expiry = 3600`、`enable_refresh_token_rotation = true`、`refresh_token_reuse_interval = 10`，`[auth.email] enable_confirmations = false`；關閉 Storage、Edge Runtime、Analytics 與本機郵件服務（較舊的 CLI 為 `[inbucket]`）；`project_id` 與任務 1 的暫存專案不同
    - `supabase/seed.sql` 是 0 位元組的空檔
    - 以 `supabase start --network-id lm-local` 啟動，確認 `docker ps` 的每個埠都以 `127.0.0.1:` 開頭，而且沒有 Storage、Edge Runtime、Analytics 與郵件服務的容器
    - _Requirements: 2.1, 2.2, 2.3, 3.13, 4.4, 8.9_

  - [x] 3.2 應用資料表遷移 `supabase/migrations/20260101000000_app_schema.sql`
    - 依 design「Data Models」的 SQL 建立 `app` schema 與每張資料表：Trip_Content_Table 的主鍵與彼此之間的外鍵都包含 `trip_id`；外鍵，以及 Participant_Key、Place_Key、每台車每天一條路線、停靠點位置四個唯一鍵，都是 `DEFERRABLE INITIALLY DEFERRED`；`unique (trip_id, user_id)`；刪除父列時只連帶刪除它自己的子表列與停靠點
    - 文字長度以 `char_length()` 檢查，時刻只接受 00:00–23:59 的 `HH:MM`，長度、範圍與列舉值與 Limits_Table、Enum_Table 相同；`app.invites` 只保存 `token_hash`；`app.trip_changes` 以 `(trip_id, seq)` 為主鍵、`(trip_id, command_id)` 唯一
    - 每張表啟用 RLS 且不建立政策，並撤銷 `anon` 與 `authenticated` 的資料表權限；不新增任何資料列
    - _Requirements: 6.14, 8.1, 8.2, 8.3, 8.5, 8.6, 8.7, 8.9_

  - [x] 3.3 Realtime 授權遷移 `supabase/migrations/20260101000100_realtime_authorization.sql`
    - 依 design「Realtime 授權」，並以任務 1.3 確認過的寫法為準：`grant usage on schema app to authenticated`；`app.can_use_trip_topic()`（`security definer`、`search_path = ''`，名稱不是 `trip:` 加小寫 UUID 時不轉型，旅行已刪除時拒絕，只允許 Trip_Member 與 Admin）與它的 execute 權限
    - `realtime.messages` 的兩個政策：select 允許 broadcast 與 presence，insert 只允許 presence；不對 `realtime.messages` 執行 `ENABLE ROW LEVEL SECURITY`
    - _Requirements: 6.14, 11.4, 11.5_

  - [x] 3.4 推送遷移 `supabase/migrations/20260101000200_publish_changes.sql`
    - 依 design「推送」建立 `app.publish_trip_change()` 與 `app.trip_changes` 的 AFTER INSERT trigger：`octet_length(payload::text)` 不超過 65,536 時送出完整的 Change_Set，否則送出 `{ trip, seq, thin: true }`；事件為 `changeset`，topic 為 `trip:<旅行 id>`，私有頻道
    - 以 `supabase db reset` 確認三個遷移依檔名順序套用，重設後 Auth_Service 沒有使用者、`app` 的每張表都沒有資料列；以 SQL 確認 `anon` 與 `authenticated` 對 `app` 的資料表沒有任何權限
    - _Requirements: 2.3, 6.14, 10.1, 10.2, 10.4_

- [x] 4. LM_Core：文字、時間、識別碼與資料型別
  - [x] 4.1 `text` 與 `time`
    - `text`：`trim_white`（Unicode White_Space）、`is_js_whitespace`／`trim_js_whitespace`／`collapse_js_whitespace`（JS_Whitespace：U+FEFF 算空白、U+0085 不算）、`char_count`、`has_control_chars`（Cc 與 Cf，連接兩個 Extended_Pictographic 的 U+200D 除外，與現行 `hasControlChars()` 相同）、`participant_name`、`participant_key`、`place_key`、`clean_text`（需求 31.14）與 `normalize_time_input`（Time_Value；只填一部分、`8:30`、`24:00` 都不是）
    - Unicode 類別與屬性可以用 `regex` 的 `\p{…}` 實作（例如 `\p{Cf}`、`\p{Default_Ignorable_Code_Point}`、`\p{Extended_Pictographic}`），不新增相依套件
    - `time`：`date_range`（1–31 天）、`date_text`（`10/20（週二）`）、不補零的月日與星期（由日期計算，不讀系統時間與時區）、`chinese_numeral`、`duration_text`
    - _Requirements: 1.3, 1.4, 3.4, 9.3, 19.1, 19.2, 19.3, 21.1, 22.5, 31.3, 31.14_

  - [x] 4.2 `ids`、`model` 與 `limits`
    - design 1.2 的 UUID newtype、`Seq`、`Hm`（0..1440 的分鐘數，序列化為 `"HH:MM"`，以 `normalize_time_input()` 解析）、每一種列的型別、`PlaceRef`、`Participation`、`Entity`、`RowKey`、`Slot`、`Row`（`slot`、`version`、`with_version`、`has_ordinal`、`with_ordinal`）與 `TripState`（`get`、`put`、`remove`、`slots`、依 Ordinal 的走訪、`max_ordinal`）；序列化格式依 design「線上格式」
    - 列舉的序列化值與 Enum_Table 及現行字串相同，例如餐次與採買分類是中文，`ExpenseCategory` 包含 11 種「食材／{分類}」
    - `limits` 收錄 Limits_Table 與 design「列舉與上限」的每個數字
    - 不使用網路、檔案、系統時間與執行緒
    - _Requirements: 1.3, 1.4, 8.4, 8.6_

  - [x] 4.3 撰寫文字與時間規則的範例測試（`crates/core/tests/text_time_examples.rs`）
    - 移植 `tests/itinerary-time-input.test.js` 與 `tests/itinerary-numerals.test.js` 的每個固定輸入案例
    - 需求 33.10 的 Participant_Name 案例：「小」加 U+FEFF 加「安」正規化為「小 安」
    - _Requirements: 33.1, 33.10_

- [x] 5. LM_Core：食材切分、採買同步與料理範本
  - [x] 5.1 `ingredients` 的切分、鍵、分類與移除食材
    - `parse_ingredients()` 依 design A4：整串 NFKC 後逐字掃描，「、」「;」「/」「。」與 CR、LF 一律切開，半形「,」「.」只在前後都是 ASCII 數字時保留；每段經 `collapse_js_whitespace()`，捨棄空段，以 Ingredient_Key 去重並保持第一次出現的順序；`ingredient_key()`
    - `classify_ingredient()`：依現行 `classifyIngredient()` 的單字表與規則表順序比對 Ingredient_Key；`地瓜(?!葉)` 改寫成 `地瓜(?:[^葉]|$)`，`\d` 改寫成 `[0-9]`，`\s` 改寫成 JS_Whitespace 的字元類別；`SHOPPING_CATEGORIES` 的順序
    - `remove_ingredient_from_meals()` 的食材文字處理（需求 25.16），以及每個切出的食材最多 100 字的檢查（需求 25.18）
    - _Requirements: 25.3, 25.4, 25.5, 25.16, 25.17, 25.18_

  - [x] 5.2 撰寫 Property 17 的 property test（`crates/core/tests/prop_parse_ingredients.rs`）
    - **Property 17: 食材切分再切一次不變**
    - **Validates: Requirements 25.4, 25.5**

  - [x] 5.3 `sync_meal_ingredients()` 與 `SyncPlan`
    - 逐行移植 design A3：依料理的 Ordinal 與食材順序建立需要的鍵；手動或已買的品項優先負責；刪除未買而且沒有負責任何鍵的 Meal_Item；已買而失去料理的 Meal_Item 改為 Manual_Item；「料理已移除」的三態；新增的 Meal_Item 為「數量待確認」、Ingredient_Classifier 的分類、待分配、未買，並依新增順序記入 `created`
    - 品項總數超過 1000 時回傳 409「採買品項最多 1,000 項，請減少食材或整理採買清單後再儲存。」，不產生部分結果；`unlinked_expenses` 列出連結被刪除品項的支出，`SyncPlan::apply_to()` 一併清除它們的採買連結
    - 新品項的 id 由呼叫端的 `IdSource` 提供
    - _Requirements: 7.19, 9.10, 9.15, 25.6, 25.7, 25.8, 25.9, 25.10, 25.11, 25.12, 25.13, 25.14, 25.15, 25.19, 29.13_

  - [x] 5.4 `recipes`：料理範本、常用食材、插圖推斷與餐次順序
    - 移植 `src/recipes.js`：`RECIPE_TEMPLATES`（8 道）、`COMMON_INGREDIENTS`（9 組 57 個）、`merge_ingredients()`、`apply_recipe_template()` 與 `infer_dish_kind()`（先依名稱、再依食材，都不符合時為 custom）
    - 移植 `src/meal-order.js` 的餐次順序與 `group_meals_by_date()`，以及 `src/gear-presets.js` 的 `PERSONAL_GEAR_GROUPS`
    - _Requirements: 24.1, 24.4, 24.5, 24.11_

  - [x] 5.5 建立屬性測試的共用產生器（`crates/core/tests/support/`）
    - `arb_state()` 依 design「Correctness Properties」的共用產生器範圍（1–5 天、部分綁定帳號的旅伴、車輛、地點、路線與停靠點、活動、料理與採買品項、裝備、支出與還款）產生滿足 I1–I8、I10–I12 的狀態；食材文字由包含各種分隔符號、`1.5`、`1,000`、全形數字、U+3000、U+FEFF、U+0085、大小寫與重複名稱的詞彙組成
    - 依序產生 id 的決定性 `IdSource`；`support/mod.rs` 以 `#[allow(dead_code)]` 讓只用到一部分的測試檔不產生警告；確認 `proptest-regressions/` 沒有被 `.gitignore` 排除
    - _Requirements: 33.5, 33.6_

  - [x] 5.6 撰寫 Property 4 的 property test（`crates/core/tests/prop_sync_idempotent.rs`）
    - **Property 4: 採買同步冪等**
    - **Validates: Requirements 25.14**

  - [x] 5.7 撰寫 Property 5 的 property test（`crates/core/tests/prop_sync_preserves.rs`）
    - **Property 5: 採買同步不刪除手動與已買的品項，也不改使用者管理的欄位**
    - **Validates: Requirements 25.10, 25.11, 25.19, 29.13**

  - [x] 5.8 撰寫 Property 6 的 property test（`crates/core/tests/prop_sync_coverage.rs`）
    - **Property 6: 採買同步涵蓋每一個需要的食材**
    - **Validates: Requirements 9.10, 25.6, 25.7, 25.8**

  - [x] 5.9 撰寫食材與採買同步的範例測試（`crates/core/tests/ingredients_examples.rs`）
    - 移植 `tests/ingredients.test.js` 的每個固定輸入案例（切分、分類、Shopping_Sync、從料理移除食材）
    - 需求 33.10 的案例：U+FEFF 加「雞蛋」切出「雞蛋」；「雞」加 U+FEFF 加「蛋」切出「雞 蛋」，它的 Ingredient_Key 為「雞蛋」；U+0085 加「雞蛋」切出的名稱仍以 U+0085 開頭；「鹽」加 U+0663 分類為「其他」
    - _Requirements: 33.1, 33.10_

  - [x] 5.10 撰寫料理範本與餐次順序的範例測試（`crates/core/tests/recipes_examples.rs`）
    - 移植 `tests/meal-order.test.js`，以及 `tests/recipes-invites.test.js` 中料理範本、插圖種類推斷與合併食材的案例（旅伴名字的案例在任務 8.15）
    - _Requirements: 33.1_

- [x] 6. LM_Core：行程推導、改日期與文字版
  - [x] 6.1 `itinerary`
    - `ACTIVITY_CATEGORIES`（13 類與中文名稱）與 `presets_for()`（第一天、中間的日子、最後一天與一日遊，內容依需求 23.2）
    - `STOP_KINDS`、`STOP_TASK_KINDS`、預設任務與任務名稱（需求 22.8）；`MEAL_DEFAULT_TIMES`、`meal_time()`、`meal_title()` 與文字版的料理類別（需求 31.11）
    - `sorted_routes()`（依出發時間，沒有出發時間的排最後，同時間依車輛的 Ordinal）、`day_routes_by_ordinal()`、`day_events()`（活動與料理依時間，同時間活動在前，再各依 Ordinal）
    - `shopping_plan()`：負責人所在的車（依車輛 Ordinal，第一台以他為駕駛或乘客的車）、那台車最早的 Shopping_Stop、每個停靠點的品項（依採買品項的 Ordinal），以及 Unassigned_Shopping 的三種原因與文字（需求 22.14）
    - `day_place()`、`place_usages()` 與需求 21.4 的訊息、`place_name_error()`（需求 21.1 的順序）、`destination_conflict()`、`CAR_PALETTE`（8 色、原順序）與依位置取色、Person_Activity 與下一個未完成的活動（需求 28.5）
    - _Requirements: 18.3, 18.4, 20.4, 21.1, 21.4, 22.2, 22.8, 22.12, 22.14, 23.2, 24.3, 28.5, 31.5, 31.7, 31.9, 31.11_

  - [x] 6.2 `dates`：Retime
    - 依 design A9 移植 `retime_by_day_index()`：路線與每日設定保持第 N 天，活動與料理到第 min(N, 新天數) 天，不在舊範圍內的到第 1 天，只改日期；被刪掉的日子有路線，或有標題、地點的每日設定時回傳 `BlockedDay` 清單而且不改變狀態；其餘被刪掉日子的每日設定一併刪除
    - `shorten_blocked_message()` 產生需求 18.7 的訊息
    - _Requirements: 18.5, 18.6, 18.7, 18.8, 18.9_

  - [x] 6.3 撰寫 Property 16 的 property test（`crates/core/tests/prop_retime.rs`）
    - **Property 16: 改日期保留「第 N 天」**
    - **Validates: Requirements 18.5, 18.6, 18.7, 18.8**

  - [x] 6.4 `itinerary_text()`
    - 依 design A10 與需求 31.2–31.14：旅行名稱、車輛行、每一天的標題行與「地點」行、路線區塊（依建立順序；停靠點的寫法；只有 Shopping_Stop 有品項，超過 8 項時列前 7 項再加「等另外 N 項」）與抵達行、活動區塊（不是空白的備註另起一行，以兩個半形空格開頭）、路線位置為 after 時活動區塊在前、只列待分配品項的「未分配採買清單」
    - 固定標點使用需求 31.18 的碼位；使用者文字一律經 `clean_text()`；不輸出行程繪本的標語、說明與停靠點自訂品項；第一行之前與最後一行之後都沒有換行字元
    - _Requirements: 22.8, 22.12, 31.1, 31.2, 31.3, 31.4, 31.5, 31.6, 31.7, 31.8, 31.9, 31.10, 31.11, 31.12, 31.13, 31.14, 31.18_

  - [x] 6.5 撰寫 Property 13 的 property test（`crates/core/tests/prop_itinerary_text.rs`）
    - **Property 13: 文字版是決定性的**
    - **Validates: Requirements 31.1, 31.3, 31.5**

  - [x] 6.6 撰寫文字版的 golden 測試（`crates/core/tests/itinerary_text_golden.rs`）
    - 在 `crates/core/tests/support/example_trip.rs` 移植 `tests/fixtures/example-trip.js` 的 `exampleTrip()`（陣列順序改以 Ordinal 表示；第 1 天的每日設定有預計抵達時間 12:00）
    - 預期文字檔 `crates/core/tests/fixtures/example-itinerary.txt` 依需求 31 逐行撰寫，可以對照現行行程繪本「複製文字」對同一份資料的輸出（`src/storybook/app.js` 的 `renderItinerary()` 與 `copyItinerary()`），只多出「預計 12:00 抵達夕淞度日營區」一行；不使用 `EXAMPLE_TEXT`，也不以 `itinerary_text()` 的輸出產生預期檔；最後一行之後沒有換行字元
    - 在 `crates/core/tests/fixtures/` 新增 `.gitattributes`（例如 `*.txt -text`），使 Windows 檢出時不改變行尾；測試逐字比較整段文字
    - _Requirements: 33.2_

  - [x] 6.7 撰寫文字版的其他範例測試（`crates/core/tests/itinerary_text_examples.rs`）
    - 需求 33.11 列出的每一種情況各一個小型旅行，比對完整輸出
    - _Requirements: 33.11_

  - [x] 6.8 撰寫行程推導與改日期的範例測試（`crates/core/tests/itinerary_examples.rs`、`crates/core/tests/dates_examples.rs`）
    - 移植 `tests/itinerary-model.test.js`、`tests/itinerary-place-name.test.js`、`tests/itinerary-shopping.test.js`、`tests/itinerary-derive.test.js`（Shopping_Plan 的部分），以及 `tests/itinerary-dates.test.js` 中 `retimeByDayIndex()` 與 `shortenBlockedMessage()` 的案例；行程圖、規劃提醒、舊的出發欄位 `meeting` 與 `shiftByOffset()` 的案例不移植
    - _Requirements: 33.1_

- [x] 7. LM_Core：分帳計算
  - [x] 7.1 `ledger`
    - 移植 `src/expense-model.js` 與 `src/expense-categories.js`：`parse_amount()`（需求 29.5 的格式與訊息）、`format_money()`、`split_evenly()`（餘數依旅伴 id 遞增，各 1 分給排在前面的人）、`summarize()`（每位旅伴的已付、分攤、已還出、已收回與淨額）與建議轉帳（需求 29.7 的排序與配對）、`EXPENSE_CATEGORIES`（18 種）與 `suggest_expense_category()`
    - _Requirements: 29.5, 29.6, 29.7, 29.8, 29.11_

  - [x] 7.2 撰寫 Property 15 的 property test（`crates/core/tests/prop_ledger.rs`）
    - **Property 15: 分帳金額守恆**
    - **Validates: Requirements 29.6, 29.7**

  - [x] 7.3 撰寫分帳計算的範例測試（`crates/core/tests/ledger_examples.rs`）
    - 移植 `tests/expense-model.test.js` 與 `tests/ledger.test.js` 中計算部分的案例；收據 AI、帳本的伺服器儲存與 HTTP 的案例不移植
    - _Requirements: 33.1_

- [x] 8. LM_Core：命令、權限、不變式與 `apply()`
  - [x] 8.1 `command` 與 `Rejection`
    - design 1.3 的每一種 `Command`、各 Patch（`None` 為不改、`Some(None)` 為清空；乘客、活動參加者與分攤旅伴以加入與移除表示）與 Draft、`DateSpan`，以及 `Input<T>`：能解析成 `T` 時為 `Ok`，其他 JSON 值保留為 `Bad`，由處理函式依各需求的順序與訊息回應 400；時刻以使用者輸入的文字送出，選填的時刻以 `null` 或空字串表示留空
    - `Rejection`（400、403、404、409，含 `code`、`field` 與可以直接顯示的訊息）與共用文案常數（`TRIP_NOT_FOUND`、`DENY_REMOVAL`、`DENY_PACKING`、`DENY_LEDGER_REMOVAL` 等，沿用現行文字）
    - _Requirements: 1.3, 5.5, 7.1, 7.10, 7.20_

  - [x] 8.2 `rules`
    - design 1.4 的 `Capabilities`、`capabilities()`、`Right`、`required_right()` 與 `authorize()`，結果與 Permission_Table 相同（Collaborator 修改綁定其他 Account 的旅伴時 403「只能修改自己的旅伴資料。」）
    - 移植 `src/model.js` 的 `my_gear()`、`can_depart()` 與 `unassigned_gear()`，以及 Gear_Progress 與 Packing_Progress
    - _Requirements: 6.4, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 27.9, 28.1_

  - [x] 8.3 擴充共用產生器：`arb_command()` 與 `arb_caps()`（`crates/core/tests/support/`）
    - `arb_command(state)` 多數引用既有的列，也產生不存在的 id、超過上限的文字、別人的旅伴與邊界值；`arb_caps(state)` 涵蓋擁有者、Admin、綁定旅伴的 Collaborator、Unbound_Admin 與非成員
    - _Requirements: 33.5_

  - [x] 8.4 撰寫 Property 8 的 property test（`crates/core/tests/prop_permissions.rs`）
    - **Property 8: 權限判斷與規則表一致**
    - 在測試中以查表另外實作 Permission_Table，比對 `authorize()` 是否允許，以及拒絕的種類（404 或 403）
    - **Validates: Requirements 6.1, 6.2, 6.4, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11**

  - [x] 8.5 `validate`
    - `validate::state(state, mode)` 依序檢查 design「不變式」的 I1–I12，`Mode::Predict` 不檢查 I9
    - `Violation::into_rejection()` 依需求 9.16 決定回應：違反的條件有對應的拒絕規則時回應那條規則的狀態與訊息（例如需求 19.6、19.7、21.1、21.2、22.4、23.5、24.7、25.15、26.4、27.3、28.3、29.4），否則回應 409「資料驗證未通過，沒有儲存。」
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10, 9.11, 9.12, 9.13, 9.16_

  - [x] 8.6 `apply()` 與命令共同的規則
    - `Mode`、`Ctx`、`Effect`、`Outcome`（`effects()` 主要效果在前、衍生效果在後，同一個 Slot 只留最後一筆；`is_noop()`）、前端用的 `NoDerivedIds`、`diff()` 與 `TripState::apply_effects()`
    - `apply()` 依 design A2：先 `authorize()`（在找目標、驗證與判斷有沒有變化之前），再在可寫副本上執行處理函式並 `diff()`；沒有變化時回傳空的 `Outcome`，也不執行採買同步；`Mode::Commit` 而且命令會影響食材時執行 `sync_meal_ingredients()`，新增的 Meal_Item 排在主要效果的新列之後；最後以 `validate::state()` 檢查
    - 處理函式的共用規則（design 1.5）：只合併 patch 帶有的欄位，集合欄位以加入與移除套用；新列的暫時 Ordinal 從 `max_ordinal() + 1` 依 `created` 的順序遞增；新列的 id 已被同一種列使用時 409 `duplicate_id`；要修改或勾選的列不存在時回應該種項目的 404，要刪除的列不存在時沒有變化；文字含 U+0000 時依需求 8.12 回應 400
    - 前端預測與伺服器提交使用同一個 `apply()`，所以 Primary_Effect 相同
    - _Requirements: 6.4, 7.5, 7.6, 7.7, 7.11, 7.12, 7.18, 7.19, 7.21, 7.22, 8.12, 9.1, 13.4, 13.5, 25.1, 25.2_

  - [x] 8.7 處理函式：旅行、旅伴、車輛與地點
    - `UpdateTrip`：合併帶有的欄位（起訖日期一起生效）後依需求 17.5 與 18.2 的順序檢查，再依需求 18.3、18.4 回應 409；改日期時以 `retime_by_day_index()` 搬動，縮短被阻擋時以 `shorten_blocked_message()` 回應 409；另提供建立旅行用的 Trip_Card 與建立者名字的檢查（需求 17.5），給 lm-server 與 lm-web 共用
    - `AddPerson`、`UpdatePerson`、`RemovePerson`：Participant_Name 正規化、預設角色與需求 19.2–19.7 的檢查順序、依人數取色、新增時刪除所有出發確認；移除依 design 1.5 清除駕駛、乘客、活動參加者、負責人與打包勾選中的引用，並依需求 19.12 刪除出發確認；已綁定帳號或仍有帳目時 409
    - 以邀請加入用的 `join_trip()`：不經 `authorize()`，名字與角色依需求 19.1–19.7 檢查，新增綁定帳號的旅伴（顏色依需求 19.8），並刪除所有出發確認
    - 車輛：以新增或套用到當下狀態之後的車輛依需求 20.1–20.3 的順序檢查，刪除時依需求 20.6、20.7 回應 409；地點：需求 21.1 的檢查順序（`place_name_error()`）、100 個上限、仍有 Place_Usage 時以需求 21.4 的訊息拒絕刪除、改名不改變位置
    - _Requirements: 17.5, 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.9, 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.8, 19.9, 19.10, 19.11, 19.12, 19.13, 19.14, 19.16, 20.1, 20.2, 20.3, 20.5, 20.6, 20.7, 20.9, 20.10, 21.1, 21.2, 21.3, 21.4, 21.6, 21.7, 30.15_

  - [x] 8.8 處理函式：路線、每日設定與活動
    - `SaveRoute`：依需求 22.4–22.7 的順序檢查；整條取代並保留路線與既有停靠點的 id；路線不存在時新增；不改變採買品項。`RemoveRoute`：刪除路線與停靠點，已不存在時沒有變化
    - `SaveDaySetting`：只合併帶有的欄位，依需求 22.10 檢查；合併後標題、地點與預計抵達時間都未設定時刪除這一天的設定
    - `AddActivities`、`UpdateActivity`、`RemoveActivity`、`SetActivityDone`：Trim_White 之後依需求 23.10 的順序與訊息檢查；一次加入的多筆全部成功或全部拒絕；超過 1000 筆時 409；指定旅伴或指定車輛變成空的時改為全體
    - 命令指定的日期不在當下的旅行範圍內時依各需求回應 400，不依 Retime 改動
    - _Requirements: 7.9, 18.10, 22.3, 22.4, 22.5, 22.6, 22.7, 22.9, 22.10, 22.11, 22.15, 23.1, 23.3, 23.4, 23.5, 23.6, 23.7, 23.9, 23.10, 23.11_

  - [x] 8.9 處理函式：料理、採買品項、裝備、出發確認與帳目
    - 料理：需求 24.2 的檢查順序（修改的料理不存在時先回應 404）、每個食材最多 100 字、1000 道上限；只改用餐時間時其他欄位不變；`RemoveIngredientFromMeals` 依需求 25.16 與 25.20
    - 採買品項：需求 26.2–26.8 的檢查與來源規則；`SetShoppingPurchased` 設定指定的值，Collaborator 取消已買的 Meal_Item 時改為 Manual_Item；Linked_Item 不能改名或直接刪除；刪除品項時清除支出的採買連結
    - 裝備：需求 27.2–27.5 的檢查、清空打包勾選與刪除出發確認；`SetGearPacked` 只能勾 My_Gear 中的項目，取消時刪除自己的出發確認；`RemoveGear` 刪除打包勾選與所有出發確認；`SetDeparted` 確認時必須滿足 Can_Depart，取消時不檢查
    - 支出與還款：需求 29.2–29.4 的檢查（標題與備註先 NFC 再 Trim_White，分攤旅伴以加入與移除套用）；刪除時其他帳目與採買品項不變
    - _Requirements: 22.13, 24.2, 24.7, 24.8, 25.16, 25.18, 25.20, 26.2, 26.3, 26.4, 26.5, 26.6, 26.7, 26.8, 26.9, 26.10, 26.11, 26.12, 26.13, 26.16, 27.2, 27.3, 27.4, 27.5, 27.6, 27.7, 27.8, 27.10, 27.12, 28.2, 28.3, 28.4, 29.2, 29.3, 29.4, 29.9, 29.13_

  - [x] 8.10 撰寫 Property 7 的 property test（`crates/core/tests/prop_check_commands.rs`）
    - **Property 7: 勾選是冪等的集合操作**
    - 也涵蓋要刪除的列已不存在時，通過權限檢查的刪除命令回傳 `is_noop()`
    - **Validates: Requirements 7.11, 7.12, 7.13, 23.6, 26.9, 27.6, 28.2, 28.4**

  - [x] 8.11 撰寫 Property 9 的 property test（`crates/core/tests/prop_invariants.rs`）
    - **Property 9: 成功的命令一定保持不變式**
    - 輸入狀態先以 `sync_meal_ingredients()` 套用一次，並確認它滿足 `validate::state(…, Mode::Commit)`
    - **Validates: Requirements 7.15, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10, 9.11, 9.12, 9.13, 19.10**

  - [x] 8.12 撰寫 Property 10 的 property test（`crates/core/tests/prop_predict_commit.rs`）
    - **Property 10: 前端預測與伺服器的主要效果相同**
    - **Validates: Requirements 13.4, 13.5, 25.2**

  - [x] 8.13 撰寫 Property 12 的 property test（`crates/core/tests/prop_patch_commute.rs`）
    - **Property 12: 不同欄位的 patch 可交換，同一欄位以提交順序決定**
    - **Validates: Requirements 7.5, 7.6, 7.7**

  - [x] 8.14 撰寫規則的範例測試（`crates/core/tests/rules_examples.rs`）
    - 移植 `tests/model.test.js` 中 My_Gear、Can_Depart、打包進度、日期範圍與 Trip_State 驗證的案例；localStorage、主題與舊資料格式的案例不移植
    - _Requirements: 33.1_

  - [x] 8.15 撰寫旅伴名字規則的範例測試（`crates/core/tests/people_examples.rs`）
    - 以 `AddPerson` 與 `UpdatePerson` 移植 `tests/recipes-invites.test.js` 中 Participant_Name 的正規化、同名與 100 位上限的案例
    - 需求 33.10：新增名字為「小」加 U+0085 加「安」的旅伴時，以「名字不能包含隱藏控制字元。」拒絕
    - _Requirements: 33.1, 33.10_

  - [x] 8.16 撰寫權限拒絕的範例測試（`crates/core/tests/permissions_examples.rs`）
    - 需求 33.12 列出的每一種拒絕，以 `apply()` 比對拒絕的種類與訊息
    - _Requirements: 33.12_

- [x] 9. LM_Core：同步模型與 API 型別
  - [x] 9.1 `sync`
    - design 1.6 的 `Change`、`ChangeSet`（`without_ledger()` 與 `for_viewer()` 移除 Ledger_Rows 的每一筆變化，包括刪除，但保留 Seq）、`Broadcast`（完整的 Change_Set 或 Thin_Notice）、`Viewer`（`hides_ledger()`）、`Snapshot` 與 `PendingCmd`
    - `Replica` 與 `ApplyReport` 依 design A5：重複與不大於水位線的整則忽略、每一列只保留 Row_Version 最大的內容、刪除留下墓碑直到不大於水位線、`ahead` 與水位線的推進、回報第一段缺號；`apply_snapshot()` 把 Replica 中有、Snapshot 中沒有、而且版本不大於 Snapshot 的 Seq 的列視為已刪除
    - `overlay()` 依 design A6：在已確認狀態上依序以 `Mode::Predict` 疊上成立的 Pending_Command，不成立的暫時不顯示
    - _Requirements: 6.12, 6.13, 10.3, 10.4, 12.3, 12.10, 12.11, 12.12, 12.14, 13.6, 13.7, 14.1_

  - [x] 9.2 `api`
    - design 1.8 的請求與回應型別：`CommandRequest`、`CommandResponse`（沒有變化時 `changeset` 為 `null`）、`ChangesResponse`（以 `status` 區分 `changes` 與 `snapshot_required`）、`ApiError`（只有 `code`、`message`、`field`）、註冊、登入、換發、`SessionDto`、`SignupResponse`、`JoinResponse`、`ProfileDto`、`TripSummary`、`CreateTripRequest`，以及邀請的建立、列表與預覽
    - _Requirements: 1.3, 5.5, 7.1, 12.5, 12.15, 17.8, 30.5, 30.16_

  - [x] 9.3 建立 `ModelServer`（`crates/core/tests/support/model_server.rs`）
    - 以 `apply(Mode::Commit)` 依序執行一串 `(身分, Command)`，並與 design A1 的 `execute()` 一樣指定 Seq、Row_Version 與 Ordinal（新列依 `Outcome.created` 的順序），記錄每個 Seq 的 Change_Set 與 Snapshot
    - `arb_script()` 與 `arb_delivery_plan()`：排列、重複、在任意位置插入任意 Seq 的 Snapshot，並保證最後一個 Snapshot 之後的每個 Change_Set 至少送達一次
    - _Requirements: 33.5_

  - [x] 9.4 撰寫 Property 1 的 property test（`crates/core/tests/prop_replica_convergence.rs`）
    - **Property 1: 任意送達順序都收斂到伺服器狀態**
    - **Validates: Requirements 12.10, 12.12, 12.14**

  - [x] 9.5 撰寫 Property 2 的 property test（`crates/core/tests/prop_watermark.rs`）
    - **Property 2: 水位線與缺號回報正確**
    - **Validates: Requirements 12.3, 12.11**

  - [x] 9.6 撰寫 Property 3 的 property test（`crates/core/tests/prop_changed_slots.rs`）
    - **Property 3: 只回報內容真的改變的列**
    - **Validates: Requirements 14.1**

  - [x] 9.7 撰寫 Property 11 的 property test（`crates/core/tests/prop_overlay_revert.rs`）
    - **Property 11: 回復不留下殘留**
    - **Validates: Requirements 13.6, 13.8**

- [x] 10. LM_Core：Presence 節流與編輯者頭像
  - [x] 10.1 Presence 節流
    - design 1.7 的 `EditTarget`、`PresenceMeta`（Account id、Display_Name、Bound_Person 與 Edit_Target）、`ThrottleAction` 與 `PresenceThrottle`（design A11：任兩次送出至少相隔 6,500 毫秒，重新加入也不例外；只保留最後一筆；與這次加入之後上次送出的相同時不送並捨棄保留的那一筆；`on_rejoin()` 清除上次送出與保留的內容，但保留上次送出的時間）；目前時間由呼叫端傳入
    - _Requirements: 1.4, 15.1, 15.3, 15.4, 15.5, 15.6_

  - [x] 10.2 撰寫 Property 14 的 property test（`crates/core/tests/prop_presence_throttle.rs`）
    - **Property 14: Presence 節流遵守 Realtime 的限制且不遺失最後狀態**
    - **Validates: Requirements 15.3, 15.4, 15.5, 15.6**

  - [x] 10.3 編輯者頭像與堆疊
    - design A13：`avatar_initial()`（Trim_White 之後的第一個 Grapheme_Cluster，以 `unicode-segmentation` 的 `graphemes(true)` 切分；空的時候為「・」）、`Rgb`、`AvatarColor`、`INK`、`WHITE`、design 1.7 的 12 色 `AVATAR_PALETTE`（依原順序）、以 FNV-1a 64 位元雜湊 16 個位元組的 `avatar_color()`（只用整數運算與查表）、`readable_text_on()`、`relative_luminance()` 與 `contrast_ratio()`
    - `EditorAvatar`（`label()`、`tooltip()`）、`EditorStack`（最多 3 個頭像、`total()`、`overflow_label()`、`overflow_tooltip()`、`notice()`）與 `editor_stacks()`：同一個 Account 只算一位、不含檢視者自己、依 Account id 遞增、顯示用的名稱經 Trim_White 後截到 30 個字元、空的名稱依需求 16.11–16.13 寫成「有人」或「未設定顯示名稱」
    - _Requirements: 16.4, 16.5, 16.6, 16.7, 16.9, 16.10, 16.11, 16.12, 16.13, 16.14, 16.18_

  - [x] 10.4 撰寫 Property 18 的 property test（`crates/core/tests/prop_avatar_initial.rs`）
    - **Property 18: 頭像的字是修剪後顯示名稱的第一個字素叢集**
    - 在 `crates/core/tests/support/` 加入 design 所列的 `arb_display_name()` 與 `arb_user_id()`
    - **Validates: Requirements 16.4, 16.5, 16.18**

  - [x] 10.5 撰寫 Property 19 的 property test（`crates/core/tests/prop_avatar_color.rs`）
    - **Property 19: 頭像顏色由帳號 id 決定，文字對比至少 4.5:1**
    - **Validates: Requirements 16.6, 16.7, 16.18**

  - [x] 10.6 撰寫編輯者頭像與堆疊的範例測試（`crates/core/tests/presence_avatar.rs`）
    - 需求 33.3 的 Avatar_Initial 案例、12 色的對比重算、FNV-1a 的公開測試向量（空輸入與「a」），以及至少 3 個固定 Account id（包括 16 個位元組全為 0 與全為 255）的色盤索引常數
    - 需求 33.4 的 Editor_Stack 案例與各段文字
    - _Requirements: 33.3, 33.4_

- [x] 11. Checkpoint - LM_Core
  - 在 Repository 根目錄執行 `cargo test`、`cargo clippy --workspace -- -D warnings`、`cargo fmt --check` 與 `trunk build --release --config crates/web/Trunk.toml`，結束碼都是 0，`cargo test` 不連網路與 Database；另以 `cargo build -p lm-core --target wasm32-unknown-unknown` 確認 lm-core 仍能編成 wasm32。Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 1.3, 1.4, 33.8_

- [x] 12. LM_Supabase：Realtime 協定、連線狀態機、Auth_Service 與 JWT
  - [x] 12.1 Realtime 協定（`crates/supabase/src/realtime/protocol.rs`）
    - design 2.1 的 `Frame`、`join_frame()`（`private: true`、presence key、access token、`broadcast.self = false`）、離開頻道、heartbeat（topic `phoenix`）、`access_token` 與 presence track 的訊框，以及 `encode()`
    - `decode()` 把加入成功與失敗（保留原因）、broadcast、presence 的完整狀態與增減、`phx_close`、`phx_error`、`system` 與 heartbeat 的回覆解成對應的 `Inbound`，不認得的事件為 `Other`，無法解析的文字回傳錯誤；對照 Supabase Realtime 協定文件與任務 1.3 收到的訊框
    - _Requirements: 1.6, 1.10, 11.3_

  - [x] 12.2 連線狀態機（`crates/supabase/src/realtime/socket.rs`）
    - `RealtimeTransport`、`SocketEvent`、`Conn` 與 `PhoenixSocket`（design 2.1）：不依賴瀏覽器；時間由呼叫端以 `now_ms` 傳入，抖動來源在建立時傳入，測試可以指定
    - 連上後（包括每次重新連線）對每個登記的頻道各送出一次 `phx_join`；從連線開啟起每 20 秒送 heartbeat，下一次該送時仍沒有回覆就關閉連線並開始退避；`phx_join` 送出後 10 秒內沒有回覆時回報 `JoinTimeout`
    - 退避：連續的第 1–4 次分別等 1、2、5、10 秒，之後每次 10 秒，各加 0–20%；同時發生的多個中斷只算一次；重新加入成功後從 1 秒重新開始；`rejoin_now()`、`rejoin_after_backoff()`、`leave()`、`track()`，以及 `set_access_token()` 對每個已加入的頻道送出新 token，之後的 `phx_join` 也帶新 token
    - _Requirements: 1.6, 4.5, 11.6, 11.7, 15.13_

  - [x] 12.3 撰寫 Realtime 的單元測試（`crates/supabase/tests/protocol.rs`、`crates/supabase/tests/socket.rs`）
    - 以記錄送出內容的假 `RealtimeTransport`，以及測試指定的時間與抖動執行，不等待實際時間；逐項驗證需求 33.7 的 (a) 至 (g)，(b) 的輸入是 Supabase Realtime 協定文件的範例訊框
    - _Requirements: 33.7_

  - [x] 12.4 瀏覽器 WebSocket 傳輸（`crates/supabase/src/realtime/web.rs`）
    - 只在 feature `web` 與 `wasm32` 編譯：以 `web_sys::WebSocket` 實作 `RealtimeTransport`，把 `onopen`、`onmessage`、`onclose` 與 `onerror` 轉成 `SocketEvent` 放進佇列，由 lm-web 取出後交給 `PhoenixSocket::on_event()`
    - _Requirements: 1.10, 11.1_

  - [x] 12.5 Auth_Service 用戶端（`crates/supabase/src/gotrue.rs`，feature `server`）
    - `AuthBackend` 與 `GoTrueHttp` 的五種呼叫（design 2.2）：建立使用者（`email_confirm: true`）與刪除使用者使用 service key，密碼登入與換發使用 anon key，登出以使用者的 access token 呼叫 `scope=local`；每個呼叫 10 秒逾時
    - `AuthError` 的對應：密碼或 refresh token 無效為 `InvalidCredentials`、email 已存在為 `AlreadyExists`、拒收 email 為 `InvalidEmail`、429 為 `RateLimited`，無法連線、逾時、5xx 或無法解析的回應為 `Upstream`；錯誤與記錄不含密碼與 token
    - _Requirements: 1.6, 1.10, 3.1, 3.6, 3.11, 4.1, 4.9, 4.11, 4.15_

  - [x] 12.6 access token 驗證（`crates/supabase/src/jwt.rs`，feature `server`）
    - `Claims`、`TokenVerifier`、`Hs256Verifier`（`SUPABASE_JWT_SECRET`）、`JwksVerifier`（讀取 `{SUPABASE_URL}/auth/v1/.well-known/jwks.json` 並快取 10 分鐘；沒有快取、已滿 10 分鐘或 `kid` 不在快取中時立即重讀一次，每個 token 最多一次；沒有 `kid` 或重讀後仍找不到時拒絕）與 `AnyVerifier`（依標頭的 `alg` 只接受 HS256 與 ES256；沒有設定 `SUPABASE_JWT_SECRET` 時拒絕所有 HS256）
    - 宣告檢查：`aud` 與 `role` 都是 `authenticated`、`sub` 是 UUID、有 `exp` 而且允許 30 秒誤差；JWKS 無法讀取或無法解析時回報與「token 無效」不同的錯誤，讓 lm-server 回應 500
    - _Requirements: 1.10, 5.2, 5.3, 5.4, 5.10_

- [x] 13. LM_Server：設定、啟動檢查與 HTTP 骨架
  - [x] 13.1 設定與啟動檢查（`crates/server/src/config.rs`、`crates/server/src/main.rs`）
    - 依 design 3.5 的順序：以 `dotenvy` 讀工作目錄或上層目錄中最近的 `.env`，只補環境中沒有設定的變數；每個值先經 Trim_White，空字串視同未設定；一次列出每個未設定的必要變數，以及格式不符的變數與原因，訊息不含 `DATABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_KEY` 與 `SUPABASE_JWT_SECRET` 的值
    - `LM_BIND` 只接受 `<IPv4>:<埠>` 或 `[<IPv6>]:<埠>`（埠 1–65535，不接受主機名稱），未設定時為 `127.0.0.1:8080`；`LM_AUTH_EMAIL_DOMAIN` 未設定時為 `users.little-moments.invalid`；`LM_PUBLIC_SIGNUP` 只接受 `true` 與 `false`，未設定時為 `true`
    - `LM_BIND` 不是 Loopback_Address（`0.0.0.0` 與 `::` 也不是），而三個 Supabase 金鑰變數中任一個等於 Sample_Secrets 中任一個值時拒絕啟動，列出 `LM_BIND` 的值與這些變數的名稱；範例值從 Supabase CLI 的 `supabase status -o env` 輸出複製成常數
    - 30 秒內每秒重試連線 Database，仍失敗時只印主機、埠與原因；無法在 `LM_BIND` 監聽時印出位址與原因；每一種失敗都在開始監聽之前以非 0 的結束代碼結束；tracing 的記錄不含 token、密碼與上述四個變數的值
    - _Requirements: 2.4, 2.6, 2.7, 2.9, 2.11, 2.12, 3.12, 5.10_

  - [x] 13.2 錯誤回應與請求擷取器（`crates/server/src/error.rs`、`crates/server/src/extract.rs`）
    - `ApiError`：一律 `Content-Type: application/json`，內容只有 `code`、`message`、`field`；`Rejection` 對應 400、403、404、409，保留它的 `code` 與 `field`，沒有 `code` 的種類使用固定的代碼（例如「找不到這趟旅行。」為 `trip_not_found`）；sqlx 與其他未預期的錯誤為 500 `internal_error`，記錄錯誤但不記錄 token 與密碼
    - 依 design 3.1 的判斷順序：`AuthUser`（只接受 `Authorization: Bearer <token>`，以 `AnyVerifier` 驗證，`sub` 必須是 `app.profiles` 中的帳號，帳號名稱、Display_Name 與角色讀 Database；JWKS 讀取失敗為 500；不讀 cookie 與查詢參數）先於路徑中的旅行 id（不是 UUID 時 404「找不到這趟旅行。」），再先於包裝 axum `Json`、`Query`、`Path` 的擷取器（格式錯誤時 400 `invalid_request`）
    - 任何回應都不含 `Set-Cookie`
    - _Requirements: 5.1, 5.2, 5.5, 5.6, 5.9, 5.10, 6.2, 7.20_

  - [x] 13.3 路由、`AppState` 與靜態檔（`crates/server/src/main.rs`、`crates/server/src/state.rs`）
    - `AppState`：連線池、`Arc<dyn AuthBackend>`、`Arc<dyn TokenVerifier>`、設定與時鐘；不在記憶體保存登入狀態或旅行資料，所以重新啟動後未過期的 access token 與已提交的資料照常可用
    - `/api` 路由器有自己的 fallback（404 `api_not_found`）與 method-not-allowed fallback（405 `method_not_allowed`），不落到 `index.html`；各端點由任務 14 至 16 加入
    - `/api/` 與 `/realtime/v1/websocket` 以外的路徑回傳 `LM_STATIC_DIR` 的檔案，找不到時回傳 `index.html`；含 `..` 或 `%2e%2e` 的路徑也不回傳目錄之外的檔案；回應不含任何秘密變數的值
    - _Requirements: 1.1, 1.11, 2.9, 5.5, 5.9, 32.2_

- [x] 14. LM_Server：帳號端點
  - [x] 14.1 註冊（`crates/server/src/auth.rs`）
    - 依 design A8 與 3.3：帳號名稱原樣比對格式（不轉大小寫、不去空白，`field` 為 `username`）、保留字（另加 `invite`）、顯示名稱經 Participant_Name 後檢查、原樣的密碼為 12–72 個字元而且 UTF-8 不超過 72 位元組，只回應第一個不通過的檢查；`LM_PUBLIC_SIGNUP` 為 `false` 而且沒有邀請時 403，不呼叫 Auth_Service
    - 以 admin API 建立 email 已確認的使用者：email 已存在時 409「這個帳號名稱已被使用。」；拒收 email、無法連線或其他錯誤時 500「註冊暫時無法使用，請聯絡管理員。」並記錄原因（拒收時指出 `LM_AUTH_EMAIL_DOMAIN`）
    - 同一個交易以 advisory lock 讓空資料庫的第一個帳號成為 admin，並建立 `app.profiles`（帳號名稱重複轉成 409）；交易失敗時刪除剛建立的 Auth_Service 使用者（刪除也失敗時記錄使用者 id）並回應原本的錯誤；提交後以密碼取得 Session，失敗時保留帳號並回應 503
    - 回應 `SignupResponse`；附邀請的分支在任務 16.1 接上
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 3.16_

  - [x] 14.2 登入、換發、登出與 `/api/me`
    - 登入：帳號名稱 Trim_White 並把 A–Z 轉成小寫，組成 Synthetic_Email，密碼原樣；需求 4.2 的每一種情況都回應同樣的 401「帳號或密碼不正確。」；Auth_Service 無法使用時 503 `auth_unavailable`，限流時 429 `auth_rate_limited`
    - 換發：refresh token 無效、已撤銷、超過重用間隔或帳號已不存在時 401；Auth_Service 無法使用時與登入相同的 503 與 429
    - 登出（需要 Valid_Access_Token）：以 `scope=local` 撤銷這個裝置的 refresh token；Auth_Service 回應錯誤、無法連線或逾時也回應 200 `{}`
    - `GET /api/me` 回應 Database 中這個 Account 目前的 `ProfileDto`；四個 Public_Endpoint 忽略 `Authorization` 標頭
    - _Requirements: 4.1, 4.2, 4.9, 4.11, 4.15, 5.1, 5.7, 5.8_

- [x] 15. LM_Server：儲存層、旅行、Command_Executor、Snapshot 與增量
  - [x] 15.1 儲存層（`crates/server/src/repo/`）
    - design 3.2 的 `lock_trip()`（`FOR UPDATE`，不含已刪除的旅行）、`person_of()` 與 `load_trip()`（每張表一個 SELECT，子表以 `array_agg` 併入父列；`Person.bound` 由 `user_id` 推得，不送出帳號 id）
    - `write_changes()`：父列以 `ON CONFLICT (trip_id, id) DO UPDATE` 寫入、子表整組替換、依 Slot 刪除；Trip_Card 寫回 `app.trips` 的欄位與 `version`；更新旅伴時不改變 `user_id`；外鍵在 COMMIT 時檢查
    - `finish()` 更新 `seq`、`next_ordinal` 與 `updated_at`，並在 `app.trip_changes` 保存完整的 Change_Set（包括 Ledger_Rows；trigger 負責推送）；`changeset_by_command()` 只比對同一趟旅行
    - `snapshot()`（REPEATABLE READ READ ONLY，Seq 為交易當下的 Head，Unbound_Admin 不含 Ledger_Rows，附 `Viewer`）、`changes_after()`（Head − after > 500 時 `snapshot_required`；否則每個 Seq 恰好一個並依 Seq 遞增，Unbound_Admin 以 `without_ledger()` 回應）與 Head 的讀取
    - _Requirements: 1.11, 6.12, 7.14, 7.17, 8.1, 8.2, 8.3, 8.4, 8.7, 8.10, 12.5, 12.8, 12.9, 12.15_

  - [x] 15.2 旅行的列表、建立與刪除（`crates/server/src/trips.rs`）
    - `GET /api/trips`：只列出請求者是 Trip_Member 而且未刪除的旅行（Admin 也一樣），每趟含 `TripSummary` 的欄位；依建立時間由新到舊回傳，讓 lm-web 以穩定排序處理開始日期相同的旅行
    - `POST /api/trips`：以 LM_Core 檢查旅行資料與建立者的名字；一個交易建立旅行（Seq 0、Trip_Card 的 Row_Version 0）與綁定建立者的旅伴（名字為 Display_Name 經 Participant_Name、角色「這趟的召集人」、顏色 coral、Row_Version 0，以帶 `user_id` 的 INSERT 寫入）；旅行 id 已存在時，請求者是 Trip_Owner 而且旅行未刪除就回傳既有的旅行，否則 409「無法建立這趟旅行，請關閉表單後重新建立。」；兩個同 id 的請求同時送達也只建立一趟
    - `DELETE /api/trips/{id}`：鎖住旅行；Collaborator 403，非成員、不存在或已刪除 404；設定 `deleted_at`，並以 Head + 1 寫入、推送 `trip_deleted` 為真、沒有列變化的 Change_Set；兩個刪除同時送達時，後執行的得到 404
    - _Requirements: 6.2, 6.3, 8.4, 8.8, 8.11, 10.8, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8_

  - [x] 15.3 Command_Executor（`crates/server/src/commands.rs`）
    - 依 design A1 實作 `execute()` 與 `POST /api/trips/{id}/commands`：鎖住旅行；以當下 Database 的資料判斷 Trip_Member 與角色，非成員在查重之前就回應 404；Command_Id 已在這趟旅行的 Change_Log 時回傳第一次的 Change_Set 並標示 `replayed`；以 LM_Core 的 `apply(Mode::Commit)` 計算，Meal_Item 的 id 由 `UuidV4Ids` 產生
    - 沒有變化時回傳目前的 Head，不寫入也不記錄 Command_Id；有變化時 Seq 為 Head + 1，每一列的 Row_Version 為這個 Seq，新列的 Ordinal 依 `Outcome.created` 的順序從 `next_ordinal` 起，寫入、`finish()` 並提交
    - `Rejection` 轉成 400、403、404、409；提交時外鍵、唯一鍵或 CHECK 失敗時回應 500 並記錄，Database 不變；檢視者是 Unbound_Admin 時回應中的 Change_Set（包括重送）不含 Ledger_Rows；不讀取 Presence，也不要求用戶端提供版本號
    - _Requirements: 1.5, 6.1, 6.2, 6.3, 6.12, 7.1, 7.2, 7.3, 7.4, 7.12, 7.14, 7.15, 7.16, 7.17, 7.19, 9.1, 9.14, 10.1, 10.3, 10.7, 10.11, 15.11, 25.1, 25.2_

  - [x] 15.4 Snapshot、增量 Change_Set 與 Head 的端點（`crates/server/src/trips.rs`）
    - `GET /api/trips/{id}/snapshot`、`GET /api/trips/{id}/changes?after=N` 與 `GET /api/trips/{id}/head`：每次請求都以當下的 Database 判斷，只有 Trip_Member 與 Admin 可以讀取；旅行不存在或已刪除時 404；`after` 不是非負整數時 400 `invalid_request`
    - _Requirements: 5.9, 6.1, 6.2, 6.3, 12.5, 12.8, 12.9, 12.15_

- [x] 16. LM_Server：邀請連結與 Realtime 轉送
  - [x] 16.1 邀請連結（`crates/server/src/invites.rs`）
    - 建立：鎖住旅行後以 LM_Core 的 `Capabilities` 判斷，每趟最多 20 個、Collaborator 自己最多 5 個 Active_Invite，同時送達的請求也不超過；隨機 token 只在這個回應中回傳，Database 只保存它的 SHA-256 十六進位；到期時間為建立時間加 7 天；回應 `InviteCreated`（`url_path` 為 `/invite/<token>`）
    - 列出（Trip_Manager 看全部、Collaborator 看自己的，依建立時間由新到舊，附建立者的 Display_Name）與撤銷（Collaborator 撤銷別人的 403；連結屬於其他旅行或不是 Active_Invite 時「邀請連結無效或已過期。」）
    - 預覽（Public_Endpoint，有 Valid_Access_Token 時另回 `already_member`）與加入：鎖住旅行、再次驗證連結；已是成員時直接回傳旅行 id；否則以 LM_Core 的 `join_trip()` 新增綁定的旅伴（帶 `user_id` 寫入）、標記已使用，並以與 `execute()` 相同的方式指定 Seq、Row_Version 與 Ordinal，寫入並推送 Change_Set；連結不存在、已撤銷、已過期、旅行已刪除，或已使用而使用者不是成員時「邀請連結無效或已過期。」
    - 接上任務 14.1 的附邀請註冊：建立 Auth_Service 使用者之前先檢查連結，並在建立 profile 的同一個交易中加入旅行；任何一步失敗時依需求 3.10 回滾並刪除使用者
    - _Requirements: 1.5, 3.1, 3.10, 5.8, 6.5, 6.16, 10.1, 30.1, 30.2, 30.3, 30.4, 30.5, 30.6, 30.7, 30.8, 30.10, 30.11, 30.12, 30.13, 30.14, 30.15, 30.16_

  - [x] 16.2 Realtime 轉送（`crates/server/src/gateway.rs`）
    - `/realtime/v1/websocket`：上游網址由 `SUPABASE_URL` 推得（http 對應 ws、https 對應 wss），查詢參數只保留瀏覽器送來的 `vsn`，再加上 `apikey=<SUPABASE_ANON_KEY>`；不檢查登入、不解析內容，雙向轉送文字、二進位、ping、pong 與關閉訊框，任一端關閉就關閉另一端
    - 無法連到上游時關閉瀏覽器的 WebSocket
    - _Requirements: 2.9, 11.2, 11.12_

- [x] 17. Checkpoint - LM_Supabase 與 LM_Server
  - 在 Repository 根目錄執行 `cargo test`、`cargo clippy --workspace -- -D warnings`、`cargo fmt --check` 與 `trunk build --release --config crates/web/Trunk.toml`，結束碼都是 0；確認 `cargo build` 與 `cargo test` 不需要 Database 或 Local_Stack 正在執行。Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 1.7, 33.8_

- [x] 18. LM_Web：外觀資源、路由與登入狀態
  - [x] 18.1 輸出靜態插畫（`scripts/export-art.mjs`、`crates/web/assets/art/`、`crates/web/src/art.rs`）
    - 新增一次性的 `scripts/export-art.mjs`（以現有的 Bun 執行，不修改 `package.json`）：呼叫 `src/art.js` 的 `illustration()` 與 `logo()`、`src/dish-art.js` 的 `dishIllustration()`，輸出需求 32.5 列出的每個 SVG，通用餐盤的 7 種變化為 `custom-0.svg` 至 `custom-6.svg`；輸出檔提交到 Repository
    - `art.rs` 以 `include_str!` 嵌入這些檔案，提供封面種類到插畫的對應（mountain 使用 travel），以及 custom 料理依料理 id 的固定雜湊選出的變化；建置與執行都不需要 JavaScript
    - _Requirements: 1.2, 24.6, 32.5_

  - [x] 18.2 樣式與字型（`crates/web/styles/`、`crates/web/index.html`）
    - 把 `src/styles.css`、`src/accounts.css`、`src/expenses.css` 複製到 `crates/web/styles/`，只刪除行程繪本、場景動畫與滑動手勢的選擇器，以 `data-trunk rel="css"` 載入
    - 以 `data-trunk rel="copy-dir"` 把 `assets/fonts`（woff2 子集與三個授權檔）複製到輸出的 `assets/fonts/`，`@font-face` 的路徑不用改；不設定 `data-theme`，畫面一律是淺色主題
    - _Requirements: 32.7_

  - [x] 18.3 App 外框、路由、訊息頁與 Toast（`crates/web/src/app.rs`）
    - 以 leptos_router 提供需求 32.1 的畫面（結尾多出的 `/` 視為相同）；`/` 依 Session 前往自己的 Home_Page 或 `/login`；已有 Session 時開啟 `/login` 或 `/register` 依需求 4.10 前往
    - 沒有 Session 時開啟 Home_Page、Trip_Page 或 Departure_Page 前往 `/login?next=<目前的路徑>`；網址中的帳號名稱不是自己時顯示「沒有權限查看這個頁面」；不對應任何畫面的路徑顯示「找不到這個頁面」；訊息頁沿用 `messagePage()` 的結構與文字
    - Toast：每則 4.5 秒、新的取代舊的、`aria-live="polite"`；In_App_Path 的判斷；使用者文字一律以文字節點或屬性輸出，只有隨 App 提供的 SVG 以 HTML 插入
    - _Requirements: 4.10, 32.1, 32.6, 32.9, 32.10, 32.11_

  - [x] 18.4 Session 與 API 用戶端（`crates/web/src/session.rs`、`crates/web/src/api.rs`）
    - localStorage 的 `lm.session.v1`：取得 Session 時覆寫，無法解析時移除並視為未登入；到期前 60 秒換發，載入、回到前景或送出請求時離到期不到 60 秒就先換發；換發前先讀 `lm.session.v1`，是同一個帳號而且還有 60 秒以上時直接採用；同一個分頁同時只有一個換發；`storage` 事件依需求 4.6 處理
    - API 用戶端只連同源的 `/api/*`，帶 `Authorization: Bearer`，解析 `ApiError`；401 時換發一次並重試同一個請求一次（Command 用原本的 Command_Id）；換發被 401 拒絕時依需求 4.9；網路錯誤、429 或 5xx 時保留 Session，依需求 4.13 之後再換發
    - 登出（需求 4.12，5 秒內沒有完成也照樣清除）與切換帳號（需求 4.14）；換發成功後通知已加入的 Trip_Channel 的掛鉤，由任務 20.4 接上
    - _Requirements: 4.3, 4.5, 4.6, 4.7, 4.8, 4.9, 4.12, 4.13, 4.14, 5.6, 6.15_

  - [x] 18.5 登入與註冊頁
    - 沿用 `src/accounts-ui.js` 的表單結構與 class；註冊送出前把帳號名稱 Trim_White 並把 A–Z 轉成小寫，再以 LM_Core 的規則依需求 3.2 至 3.5 的順序檢查，最後確認兩次密碼相同（「兩次輸入的密碼不一致。」），不通過時不送出
    - 成功時保存 Session，依需求 4.10 前往 `next` 或自己的 Home_Page；被拒絕時顯示回應的 `message` 並保留輸入；登入成功後，以新的 Session 依原本的順序送出這個分頁中同一個 Account 保留的 Pending_Command
    - _Requirements: 3.14, 3.15, 4.3, 4.10_

- [x] 19. LM_Web：首頁與邀請頁
  - [x] 19.1 Home_Page（`crates/web/src/pages/home.rs`）
    - 沿用 `tripCard()` 與 `coverPicker()`：依 `GET /api/trips` 分成「規劃中的旅行」（開始日期由早到晚）與「已完成的回憶」（由晚到早），開始日期相同時建立較晚的在前；每趟顯示名稱連結、目的地或「尚未填寫地點」、`dateSpan()` 格式的日期、封面、狀態與「{N} 位旅伴」；沒有旅行時顯示「還沒有任何旅行」
    - 「新增旅行」表單（名稱、目的地、起訖日期、介紹、小叮嚀與封面，封面預設 camp）：送出前以 LM_Core 檢查；旅行 id 在開啟表單時產生，每次送出都用同一個；成功時關閉並顯示「旅行已建立」，錯誤時保留內容並顯示訊息，網路錯誤或逾時時顯示「尚未儲存，請檢查網路後再試一次。」
    - _Requirements: 17.1, 17.2, 17.9_

  - [x] 19.2 Invite_Page（`crates/web/src/pages/invite.rs`）
    - 沿用 `invite()`：顯示需求 30.9 的預覽，已是成員時顯示說明與前往 Home_Page 的連結；不是成員時顯示加入表單：未登入時有帳號名稱、顯示名稱、兩次密碼、旅伴名字（留空時用顯示名稱）、選填的角色，以及前往 `/login?next=/invite/<token>` 的「已經有帳號？登入後加入」；已登入時有預填 Display_Name 的旅伴名字與選填的角色
    - 以連結註冊時依需求 3.14 檢查並保存 Session；加入或註冊成功後前往 `/<帳號名稱>/trips/<旅行 id>`；連結無效時顯示「邀請連結無效或已過期。」
    - _Requirements: 3.14, 4.3, 6.16, 30.9, 30.13, 30.18_

- [x] 20. LM_Web：同步引擎與旅行頁外框
  - [x] 20.1 `RowStore` 與 `TripStores`（`crates/web/src/sync/store.rs`）
    - 依 design 4.3 與 A12：每列一個 signal，內容相同時不通知；`keys` 只在新增、刪除或排序鍵改變時更新；每種列的排序鍵依 design 4.3；分組以 `Memo` 由鍵與分組欄位算出，鍵不變時 `<For>` 不動 DOM
    - _Requirements: 14.1, 14.2, 14.3_

  - [x] 20.2 `TripSync`（`crates/web/src/sync/engine.rs`）
    - 依 design 4.2 與 A6：`submit()` 先以 `apply(Mode::Predict)` 在目前的畫面上檢查，不成立時把 `Rejection` 交給表單或 Toast；成立時產生 Command_Id、加入 Pending_Command，只更新受影響的列
    - `refresh_view()` 以 `overlay()` 重算，只把內容改變的列交給 `RowStore`，並遞增 `revision`，讓文字版、未分配採買、分帳餘額、裝備進度、出發清單與各種數量在同一次更新中重算
    - 合併命令回應、推送與補齊的 Change_Set：Unbound_Admin 先丟棄 Ledger_Rows；Command_Id 屬於某個 Pending_Command 時視為確認；`trip_deleted` 時離開頁面、前往 Home_Page 並顯示「這趟旅行已被刪除。」；讀取 Snapshot 不移除 Pending_Command
    - `TripSync` 以旅行 id 為鍵保存在 App 層，前往 `/login` 再回來時沿用，切換帳號時捨棄
    - _Requirements: 4.9, 4.10, 4.14, 6.13, 10.5, 12.10, 12.13, 12.14, 13.1, 13.2, 13.4, 13.6, 13.7, 13.8, 13.13, 13.14, 14.1, 14.5_

  - [x] 20.3 送出佇列（`crates/web/src/sync/sender.rs`）
    - 依 design 4.6：一次只送一個、先進先出；排在最前面的有了結果、而且它的請求已結束，才送下一個；送出後 15 秒沒有回應視為逾時；網路錯誤、逾時或 5xx 時以同一個 Command_Id 在前一次失敗後 1、2、4、8、16 秒重送，第 5 次重送也失敗時移除並以 Toast 顯示「儲存失敗，變更已還原」
    - 離線時暫停送出與重送（不計入次數），`online` 時不等退避，依原順序立即重送並重新計數；推送或補齊先確認時取消尚未進行的重送；400、403、404、409 時移除並以 Toast 顯示訊息
    - _Requirements: 13.3, 13.8, 13.9, 13.10, 13.11, 13.12, 13.13_

  - [x] 20.4 Trip_Channel 的生命週期與補齊（`crates/web/src/sync/realtime.rs`）
    - 依 design A7 以 `PhoenixSocket` 與 lm-supabase 的瀏覽器傳輸連到同源的 `/realtime/v1/websocket?vsn=1.0.0`（http 用 ws、https 用 wss），以 `trip:<小寫 UUID>` 與每個分頁的隨機 Presence_Key 加入；以 gloo-timers 定時呼叫 `tick()`
    - 加入成功後才讀取 Snapshot（沒有 Replica 或 Watermark 為 0 時）或 `changes?after=<Watermark>`；跳號、Thin_Notice 或無法解析的 broadcast 立即補齊；`snapshot_required` 改讀 Snapshot；分頁變為可見、`online` 事件與可見時每 60 秒比對 Head
    - 加入被拒：原因以 `Unauthorized` 開頭時離開並顯示「你已無法存取這趟旅行。」；`InvalidJWTExpiration` 時換發後立即重新加入一次；其他原因、10 秒逾時、頻道錯誤或關閉、斷線時依退避重試並顯示「重新連線中，畫面可能不是最新」；連線中 token 過期時換發後立即重新加入並補齊；每次換發成功後以 `set_access_token()` 更新頻道
    - 補齊回應 404 時離開並顯示伺服器的訊息；網路錯誤或 5xx 時 Replica 不變，等下一次事件再補；離開 Trip_Page 與 Departure_Page 時離開頻道而且不再重連；直接開啟 Departure_Page 也走同樣的流程
    - _Requirements: 4.5, 10.6, 10.9, 10.10, 11.1, 11.3, 11.6, 11.7, 11.8, 11.9, 11.10, 11.11, 11.13, 12.1, 12.2, 12.3, 12.4, 12.6, 12.7, 12.16, 12.17, 15.13_

  - [x] 20.5 Trip_Page 外框與編輯表單的共用元件（`crates/web/src/pages/trip.rs`、`crates/web/src/views/forms.rs`）
    - `/<帳號名稱>/trips/<id>`：Snapshot 合併之前顯示載入中；沿用 `hero()` 的頁首（營地的靜態插畫與需求 32.3 的倒數，以台灣時間的今天計算）；五個分頁由 `tab` 決定，切換時以 `replaceState` 只改 `tab`；五個分頁、Trip_Menu 與 Departure_Page 先各有自己的佔位檔，由任務 21 至 23 填入
    - 頂端的提示：「重新連線中，畫面可能不是最新」與「儲存失敗，正在重試」；離線時只顯示「離線中，有 N 項變更尚未送出」（N 為 0 時只顯示「離線中」）
    - `UiState`：以 Slot 為鍵的展開狀態、開啟中的表單與草稿、Trip_Menu 是否開啟、Schedule_Tab 選定的第 N 天；列移到別組時展開狀態不變；捲動位移與焦點中的文字欄位不被覆蓋
    - 編輯表單的共用元件：開啟時記下當時的列，儲存時只送出改過的欄位，集合欄位算出加入與移除，沒有改變時不送出；LM_Core 拒絕時訊息顯示在表單並保留內容；Remote_Change 改了這一項時保留草稿，並以 `role="status"` 顯示「有人剛更新了這一項」（任務 24.3 補上旅伴名稱）；這一項被刪除，或正在編輯的每日設定那一天已不在範圍內時，關閉表單、捨棄草稿並以 Toast 顯示「這個項目已被刪除。」
    - _Requirements: 7.8, 10.5, 11.11, 11.14, 13.2, 13.9, 13.11, 14.4, 14.6, 14.7, 14.8, 14.9, 14.10, 14.11, 32.3_

- [x] 21. LM_Web：行程表分頁
  - [x] 21.1 選日、這一天的設定與路線卡片
    - 選日（「第 {N} 天」「{M}/{D}」「週{X}」，開啟時選第 1 天，改日期後依需求 22.16 保持第 N 天或改選最後一天）；每個 Trip_Day 都有每日設定的區塊，設定被移除時改為顯示未設定的內容
    - 這一天的設定表單：標題、地點（選擇旅行目的地或「不指定地點」時送出清空）、預計幾點抵達與路線位置，只送出改過的欄位
    - 路線卡片依 `sorted_routes()` 排列（沒有出發時間的排最後，同時間依車輛的 Ordinal），「哪一台車」只列出這一天沒有路線的車；停靠點的新增、移除與排序，整張卡片以 `SaveRoute` 送出，新路線與停靠點以隨機 UUID 為 id；「新增路線」停用時顯示需求 22.17 的原因；Collaborator 也有刪除路線與停靠點的操作
    - _Requirements: 6.17, 7.9, 7.18, 14.2, 18.11, 22.1, 22.2, 22.3, 22.15, 22.16, 22.17_

  - [x] 21.2 活動與當天的料理
    - 選定日子的活動依時間與 Ordinal 排列，每列有時間、標題、類別名稱與「完成」勾選（送出想要的值）；常用活動（已加入的停用並標示「已加入」，「加入 N 個活動」在 N 至少為 1 時才能按）；「＋自訂活動」與既有活動的表單（只送出改過的欄位）與刪除
    - 當天的料理以用餐時間或餐次的預設時間顯示，可以修改用餐時間（留空時清除）
    - _Requirements: 7.8, 7.10, 22.13, 23.1, 23.2, 23.8, 23.9, 24.3_

  - [x] 21.3 地點與車、未分配採買清單
    - 「地點與車」依 Ordinal 列出地點（還沒有回應的新地點排最後），每列有「改名 {地點名稱}」與「刪除 {地點名稱}」；「＋新增地點」與改名共用只有「地點名稱」的表單；LM_Core 拒絕時依需求 21.8 顯示訊息
    - 車輛清單與共用的車輛表單（`crates/web/src/views/vehicle_form.rs`，任務 23.1 的 Trip_Menu 也使用）：「駕駛 {名字或待分配} · {人數} / {座位數} 人」與乘客名字；新增時座位預設 4、駕駛預設為檢視者的 Bound_Person；儲存前從乘客去掉駕駛；未設定顏色時依位置取 Car_Palette；只有 Trip_Manager 看得到移除
    - Unassigned_Shopping 區塊：依採買分類分組、同一分類依建立順序，已買的另外標示「已買」，每項顯示原因
    - _Requirements: 6.17, 20.4, 20.8, 20.11, 21.5, 21.8, 22.14_

  - [x] 21.4 文字版與「複製文字」
    - 「文字版」區塊以 `<pre>` 的文字節點顯示由 Optimistic_View 產生的 Itinerary_Text，保留換行與行內的連續空白
    - 「複製文字」把按下當時顯示的文字原樣寫入剪貼簿：成功時按鈕改為「已複製」；失敗時選取整段文字並改為「複製失敗」；1.8 秒後恢復；離線或重新連線中也可以複製
    - _Requirements: 14.5, 31.15, 31.16, 31.17_

- [x] 22. LM_Web：料理菜單、採買清單、裝備分工與分帳記帳分頁
  - [x] 22.1 料理菜單（`crates/web/src/views/meals.rs`）
    - 只為有料理的日子顯示日期區塊（「{M}/{D} 週{X}」與「DAY {兩位數} · {N} 道料理」），區塊內依餐次、再依 Ordinal；沒有料理時顯示需求 24.1 的兩行文字
    - 料理卡片：插圖（custom 依料理 id 固定變化）、餐次、名稱（空的時候為餐次）、份數與主廚、Ingredient_Parser 切出的食材、可展開的料理筆記與編輯按鈕；刪除只對 Trip_Manager 顯示
    - 料理表單：送出前以 LM_Core 檢查；料理範本與常用食材捷徑只改草稿（以 `merge_ingredients()` 合併、已有的捷徑停用並 `aria-pressed="true"`、套用範本前依需求 24.11 詢問、合併後超過 2,000 字時草稿不變並顯示訊息）；改了餐次而原本有用餐時間時，在同一個 Command 中清空用餐時間
    - _Requirements: 6.17, 24.1, 24.2, 24.4, 24.6, 24.9, 24.10, 24.11, 24.12_

  - [x] 22.2 採買清單（`crates/web/src/views/shopping.rs`）
    - 依採買分類順序分組，只顯示有品項的分類與「{N} 項」；每個品項有名稱、數量（可以直接修改，只送出數量）、「誰負責買」選單（立即送出）、無障礙名稱為「{品項名稱}已買齊」的勾選（送出想要的值）、連動料理的「料理：」與「料理已不需要，保留採買品項」；沒有品項時「目前沒有品項」
    - 新增與編輯品項的表單；移除 Linked_Item 時開啟「移除這項食材？」並列出連動的料理（預設全選，沒有勾選時「請至少勾選一道料理。」）；直接刪除只對 Trip_Manager 顯示
    - _Requirements: 6.17, 7.10, 14.11, 26.1, 26.14, 26.15, 26.17_

  - [x] 22.3 裝備分工（`crates/web/src/views/gear.rs`）
    - 「每個人，都帶一份」與「公用裝備，一起分工」兩組，各依 Ordinal；個人裝備列出每位旅伴的打包勾選，有負責人的共用裝備只有負責人的勾選，只有檢視者自己的 My_Gear 可以點選；「裝備準備 done / total」與待分配的提示；沒有裝備時「這裡已經都分配好了。」
    - 共用裝備的負責人選單立即送出；裝備表單（`PERSONAL_GEAR_GROUPS` 的建議只填入表單；有負責人的共用裝備改為個人時一併清空負責人）；刪除只對 Trip_Manager 顯示
    - _Requirements: 6.17, 27.1, 27.9, 27.11, 27.13_

  - [x] 22.4 分帳記帳（`crates/web/src/views/ledger.rs`）
    - Trip_Member：總金額與「{N} 筆支出」、「＋ 新增支出」與「記錄還款」、「誰該還誰」與「建議還款」（「已還款」開啟預填的還款表單）、支出與還款的清單；刪除按鈕只給有 Bound_Person 的 Trip_Manager，按下後在那一列確認；金額以 `format_money()` 顯示，表單以 `parse_amount()` 解析並以 `suggest_expense_category()` 建議分類；沒有帳目時「還沒有支出。」
    - Unbound_Admin 只顯示「你不是這趟旅行的旅伴，無法查看或記錄分帳。」
    - _Requirements: 6.17, 6.18, 29.1, 29.10, 29.11, 29.12_

- [x] 23. LM_Web：旅行選單與出發清單
  - [x] 23.1 Trip_Menu（`crates/web/src/views/trip_menu.rs`）
    - 沿用 `tripMenu()`：「編輯旅行」（只送出改過的欄位，起訖日期一起送出）；「旅伴」（依 Ordinal、以「我」標示自己、依權限顯示新增、編輯與移除；移除前以 LM_Core 檢查帳目，再開啟需求 19.17 的確認對話框）；「車輛」（任務 21.3 的共用表單）；「邀請」（列出、建立後顯示完整網址、到期時間、「複製邀請網址」與「連結只會顯示這一次，請現在複製。」、撤銷）
    - 「刪除旅行」只給 Trip_Manager：沿用 `openDeleteTripDialog()` 的文字，輸入與目前的旅行名稱逐字相同之前停用「確認刪除旅行」；成功時只顯示一次「這趟旅行已被刪除。」；失敗時對話框保持開啟並顯示以「尚未刪除：」開頭的原因
    - _Requirements: 6.17, 17.10, 18.1, 19.15, 19.17, 19.18, 20.8, 30.17, 32.4_

  - [x] 23.2 Departure_Page（`crates/web/src/pages/departure.rs`）
    - 沿用 `departure()`：依 Optimistic_View 顯示 Packing_Progress、未分配共用裝備的提示與「回去分配」、「自己的小行李」與「我負責的公用裝備」的打包勾選、「我負責的食材」與已買勾選（附 Shopping_Plan 的「第 N 天在{地點名稱}」）、「確認準備完成，出發」，以及下一個未完成的活動
    - 已確認出發時改為「準備好了，一起出發！」與停用的「已準備完成」，並提供「完成這一站」；Unbound_Admin 只看到管理員的說明與「回到規劃手冊」
    - 從 Trip_Page 前往時沿用記憶體中的 Replica 與 Pending_Command；收到 `trip_deleted` 時前往 Home_Page
    - _Requirements: 10.10, 10.12, 28.1, 28.5, 28.6, 28.7, 28.8_

- [x] 24. LM_Web：誰正在編輯（Presence 與編輯者頭像）
  - [x] 24.1 Presence 狀態與這個分頁的回報（`crates/web/src/sync/presence.rs`）
    - `presence_state` 取代先前保存的全部內容（包括重新加入之前的）；`presence_diff` 的 `leaves` 只移除 `phx_ref` 相同的那一筆，`joins` 寫入新的一筆；無法解析成 Presence_Meta 的項目忽略；不保存這個分頁自己
    - 開啟與關閉表單時更新這個分頁的 Presence_Meta（`display_name` 取自 Snapshot 的 `viewer`，`person` 取自 `viewer.caps.me`），交給 `PresenceThrottle`，並依 `WakeAt` 以計時器喚醒；每次加入成功先呼叫 `on_rejoin()`，再以目前的 Presence_Meta 呼叫 `offer()`，從未回報過時不送
    - `TripSync.editors` 以 `editor_stacks()` 計算，不含自己的帳號
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.13, 16.10, 16.14, 16.21_

  - [x] 24.2 `<EditorAvatars>` 與 `presence.css`（`crates/web/src/views/editors.rs`、`crates/web/styles/presence.css`）
    - `<EditorAvatars>` 以自己的 `Memo` 取出這個 Edit_Target 的 Editor_Stack，只在它改變時更新；頭像與「+N」以不接受焦點的 `role="img"` 元素輸出，無障礙名稱與滑鼠提示來自 LM_Core，名稱以文字節點或屬性輸出；出現、消失或改變時沒有動畫或轉場
    - `presence.css` 只有 Editor_Stack 與 Editor_Avatar 的規則（卡片上直徑 28px、字 14px，列中 24px、12px，相鄰重疊 6px，外圈 2px 的 `--card`；「+N」為 `--soft` 底與 `--ink` 字），不定義新的 CSS 變數；頭像的底色與文字色以 inline style 套用 Avatar_Palette；在 `index.html` 載入
    - 放在需求 15.12 的每一種 Editable_Item 上：卡片在標題列右側、清單的列在名稱之後與第一個操作按鈕之前、Trip_Card 在旅行標題列右側，Trip_Menu 中的旅伴與車輛也顯示
    - _Requirements: 15.12, 15.14, 16.1, 16.2, 16.3, 16.8, 16.11, 16.12, 16.15, 16.16, 16.17, 16.18, 32.8_

  - [x] 24.3 表單上的 Editing_Notice 與「仍要編輯」（`crates/web/src/views/forms.rs`）
    - 開啟 Editable_Item 的編輯表單時回報 Edit_Target，關閉時回報沒有正在編輯的對象；新增項目的表單、勾選與列上直接變更的選單不回報
    - 開啟時這個對象的 Editor_Stack 不是空的：以 `role="status"` 顯示 `notice()` 與「仍要編輯」，欄位唯讀，會改變內容或資料的按鈕停用；按下「仍要編輯」後恢復、移除按鈕、焦點移到第一個欄位，關閉之前不再改回唯讀；表單開著時 Editing_Notice 依 Editor_Stack 出現、更新或移除，但不改變唯讀狀態
    - 「{旅伴名稱}剛更新了這一項」以提交者 Presence_Meta 的 Bound_Person 在 Optimistic_View 中的名字顯示，找不到時沿用「有人剛更新了這一項」；lm-server 不讀 Presence，不需要改動
    - _Requirements: 14.6, 14.7, 15.1, 15.2, 15.9, 15.10, 15.11, 15.12, 15.14, 15.15, 15.16, 16.13, 16.19, 16.20_

- [x] 25. Checkpoint - LM_Web
  - 在 Repository 根目錄執行 `cargo test`、`cargo clippy --workspace -- -D warnings`、`cargo fmt --check` 與 `trunk build --release --config crates/web/Trunk.toml`，結束碼都是 0；確認 `crates/web/dist` 包含 `assets/fonts/` 的字型與授權檔，而且建置過程沒有用到 Node.js、npm 或 Bun。Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 1.2, 32.7, 33.8_

- [x] 26. README：第一版的開發步驟與手動確認
  - 在 `README.md` 檔尾新增第一版的章節，既有的每一行都不變；寫出需求 2.10 在 Windows 的 WSL 2（Ubuntu）中開發的步驟：Repository 在 WSL 中的路徑（例如 `/mnt/d/path/to/little-moments`）、cargo、trunk、docker 與 Supabase CLI 都在 WSL 中執行、`CARGO_TARGET_DIR` 指向 Linux 檔案系統，以及 git 只在 Windows 的 PowerShell 執行；在 WSL 中安裝 `build-essential`、`pkg-config`、`libssl-dev`、rustup 與 `wasm32-unknown-unknown` 目標、trunk、Docker Engine（不使用 Docker Desktop，並讓使用者不必 sudo 就能執行 `docker`）與 Supabase CLI 3.2.0 的 Linux 版；建立 `lm-local` 網路，以 `supabase start --network-id lm-local` 啟動並以 `docker ps` 確認，以及出現 `0.0.0.0`、`[::]` 或 `:::` 時的處理；WSL 的 localhost 轉送讓 Windows 的瀏覽器開啟這些埠，區網連不到；在 Windows 的 PowerShell 以 `netsh interface ipv4 show excludedportrange protocol=tcp` 檢查 54321、54322 與 54323；`supabase db reset` 會清除全部資料（包括每個 Account）；`.env` 的填法與四個範例值；在 WSL 中啟動 `cargo run -p lm-server` 與 `trunk serve --poll --config crates/web/Trunk.toml` 的指令（在 Windows 修改的檔案要靠 `--poll` 才會觸發重建）；任務 1 記下的 `supabase --version`
  - 寫出需求 33.9 的三個手動確認步驟與預期結果
  - 新增的內容要讓 `tests/readme.test.js` 照常通過（需求 1.12）：不寫入 Supabase 的範例金鑰或其他長的十六進位、Base64 字串；連線字串的帳號與密碼只用 `<user>`、`<password>` 這類佔位符；名稱以 `PASSWORD`、`SECRET`、`TOKEN` 或 `API_KEY` 結尾的變數後面不接 `=` 或 `:` 與實際的值（行尾的 `=` 接著下一行也算）；不使用該測試禁止的舊英文片語與 `Vehicle_Dialog`
  - _Requirements: 1.9, 1.12, 2.10, 33.9_

- [x] 27. Final checkpoint - 全部建置檢查
  - 在 Repository 根目錄執行 `cargo test`、`cargo clippy --workspace -- -D warnings`、`cargo fmt --check` 與 `trunk build --release --config crates/web/Trunk.toml`，結束碼都是 0
  - 需求 1.9：以 `git diff --numstat 1b925a7` 確認分支起點已存在的檔案中只有 `.gitignore` 與 `README.md` 出現，而且刪除行數為 0；`rust-rewrite` 分支與 `.worktrees/rust-rewrite` 沒有改變
  - 需求 1.12：在同一台開發機、相同的環境變數下（依 README「測試」一節準備 Ephemeral_Database），分別在分支起點的檢出（例如以 `git worktree add` 建立在 Repository 之外，用完以 `git worktree remove` 移除）與目前的 commit 執行 `bun run test`，確認每個測試的結果相同
  - 請使用者依 README 執行需求 33.9 的三個手動確認。Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 1.9, 1.12, 33.8, 33.9_

- [ ] 28. 管理後台：Auth_Service 呼叫與遷移檔
  - [ ] 28.1 在 Local_Stack 確認重設密碼與登出的假設
    - 在 WSL 中以 Local_Stack 實測，不提交任何檔案：以 service key 呼叫 `PUT /auth/v1/admin/users/{id}`、內容只有 `{"password": …}`，確認新密碼可以密碼登入、舊密碼不行，並記下 GoTrue 對過短密碼的狀態碼；以 `DATABASE_URL` 的角色（`postgres`）執行 `delete from auth.sessions where user_id = $1`，確認有權限，而且之後以原本的 refresh token 換發得到 401
    - 任一項不成立時停下來回報使用者，不改用其他做法（design 5.1）
    - _Requirements: 36.3, 36.4, 40.3_
  - [ ] 28.2 `AuthBackend::update_user_password`（`crates/supabase/src/gotrue.rs`，feature `server`）
    - 依 design 2.2 與 5.4：`PUT /auth/v1/admin/users/{id}`，10 秒逾時；422 為 `WeakPassword`，其他錯誤、5xx、無法連線與逾時為 `Upstream`；`AuthError` 的 `Display` 與任何記錄都不含密碼
    - LM_Server 中實作 `AuthBackend` 的測試替身（如果有）一併加上這個方法
    - _Requirements: 1.10, 36.3, 36.5, 36.7_
  - [ ] 28.3 遷移檔 `supabase/migrations/20260301000000_admin.sql`
    - 依 design 5.5：`app.profiles.disabled_at`、`app.settings`、`app.audit`（操作代碼的 check 清單與需求 41.2 相同）與索引；兩張新表啟用 RLS、不建立政策、撤銷 `anon` 與 `authenticated` 的權限；以 `create or replace` 重新定義 `app.can_use_trip_topic()`，兩個條件各加 `disabled_at is null`，其他內容與 `20260101000100_realtime_authorization.sql` 相同
    - 以 `supabase db reset` 套用，確認依檔名順序套用全部遷移檔
    - _Requirements: 2.3, 6.14, 37.1, 40.1, 40.4, 41.1_
- [ ] 29. LM_Core：`admin` 模組
  - [ ] 29.1 型別與規則（`crates/core/src/admin.rs`）
    - 依 design 5.3：API 型別（`AdminUserDto`、`AdminUsersResponse`、`UpdateUserRequest`、`ResetPasswordRequest`、`Policy`、`SettingSource`、`PublicSignupSetting`、`ActorDto`、`AdminSettingsResponse`、`AuditEntryDto`、`AuditPage`）、`AUDIT_PAGE_SIZE` 與 `AUDIT_MAX_PAGES`；`resolve_public_signup()`、`account_matches()`、`admin_stats()`、`check_role_change()`、`check_disable()`（`AdminRejection` 與其代碼、訊息）、`audit_action_label()`、`audit_page_count()`
    - _Requirements: 35.1, 35.4, 35.6, 37.2, 37.3, 39.3, 40.3, 41.2, 41.3, 41.5_
  - [ ] 29.2 範例測試
    - 依 design 5.8 列出的 `lm-core::admin` 案例
    - _Requirements: 35.4, 35.6, 37.2, 39.3, 40.3, 41.3, 41.5_
- [ ] 30. LM_Server：Admin_Endpoint
  - [ ] 30.1 `AdminUser`、停用的帳號與帳號列表（`crates/server/src/extract.rs`、`crates/server/src/auth.rs`、`crates/server/src/admin.rs`、`crates/server/src/main.rs`）
    - 依 design 5.2：`AdminUser` 內含 `AuthUser`，角色不是 admin 時 403 `admin_required`；`load_profile()` 只讀 `disabled_at is null` 的列，使 `AuthUser`、登入與換發都把 Disabled_Account 當成沒有 `app.profiles`（登入與換發 401 並撤銷這次的工作階段）；`profile_count()` 仍計算全部的列
    - `GET /api/admin/users` 依 design 5.3 的查詢與 `trip_total`；在 `api_routes()` 加入 design 5.3 的全部路由
    - _Requirements: 1.1, 4.2, 4.9, 5.2, 34.1, 34.2, 35.1, 40.4_
  - [ ] 30.2 Audit_Log（`crates/server/src/audit.rs`、`auth.rs`、`trips.rs`、`invites.rs`）
    - `audit::write()` 與 `audit::page()`（design 5.5）；在 design 5.5 表中的每個位置、既有的交易中寫入，失敗時整個交易回滾；`trip.create` 只在實際建立時寫入，`invite.join` 在已是成員而直接回傳時不寫
    - `GET /api/admin/audit?page=N`：`page` 不是 1–10 的整數或大於總頁數時 400 `invalid_page`
    - _Requirements: 41.1, 41.2, 41.3, 41.4_
  - [ ] 30.3 修改帳號（`crates/server/src/admin.rs`）
    - 依 design 5.4：advisory lock、`for update`、`check_display_name()`、計算有效的 Admin 數量、`check_role_change()`；降級時撤銷 design 5.4 條件的 Active_Invite；寫入 Audit_Log；不寫 Change_Log、不改旅伴名字
    - _Requirements: 34.10, 39.3, 39.4, 39.5, 41.2_
  - [ ] 30.4 重設密碼、停用與啟用（`crates/server/src/admin.rs`、`crates/server/src/repo/profiles.rs`）
    - 重設密碼依 design 5.4 的程式與失敗表；`repo::delete_auth_sessions()`
    - 停用：advisory lock、`check_disable()`、已停用時不變也不寫紀錄；提交後刪除 `auth.sessions`，失敗時 500 `account_disable_signout_failed`；啟用：設為空值、寫紀錄，已啟用時不寫
    - 每個成功的寫入寫一行 info 記錄（操作、Admin 的 id、目標 id）；任何記錄、錯誤與 Audit_Log 都不含密碼
    - _Requirements: 34.10, 36.3, 36.4, 36.5, 36.6, 36.7, 40.3, 40.5, 40.6_
  - [ ] 30.5 公開註冊的設定（`crates/server/src/settings.rs`、`config.rs`、`auth.rs`、`admin.rs`）
    - `Config` 把 `LM_PUBLIC_SIGNUP` 存成 `Option<bool>`；`settings::public_signup()` 每次讀 Database；`signup` 沒有邀請時以它判斷 403 `signup_invite_only`，讀取失敗時 500「註冊暫時無法使用，請聯絡管理員。」且不呼叫 Auth_Service；以邀請註冊不讀這個設定
    - `GET`／`PATCH /api/admin/settings`：`public_signup` 必須是字串 `open` 或 `closed`，缺少、其他值或多出欄位都是 400 `invalid_setting`；寫入與 Audit_Log 在同一個交易
    - 更新 `auth.rs` 開頭的說明與錯誤表中的 `LM_PUBLIC_SIGNUP` 字樣
    - _Requirements: 3.7, 3.12, 30.12, 34.10, 37.2, 37.3, 37.4, 37.5, 37.8_
  - [ ] 30.6 單元測試
    - `PATCH /api/admin/settings` 內容的解析（`"open"`、`"closed"` 通過；`"OPEN"`、`true`、缺少與多出欄位為 `invalid_setting`）與 `page` 參數的解析（`1`、`10` 通過；`0`、`11`、`abc`、`1.5` 為 `invalid_page`）；不連 Database
    - _Requirements: 37.5, 41.4_
- [ ] 31. LM_Web：Admin_Page
  - [ ] 31.1 路由與帳號選單（`crates/web/src/app.rs`）
    - `Screen::parse()` 加 `/admin`；In_App_Path 加 `/admin`；沒有 Session 時前往 `/login?next=%2Fadmin`；`AccountMenu` 對 admin 在「我的旅行」之後輸出 `<a class="acct-admin-link" href="/admin">管理後台</a>`，在 Admin_Page 上加 `aria-current="page"`；刪除 `app.rs` 中「第一版沒有管理後台」的註解
    - _Requirements: 32.1, 32.11, 34.3, 34.4_
  - [ ] 31.2 頁面外框、統計列、公開註冊與帳號列表（`crates/web/src/pages/admin.rs`、`crates/web/src/api.rs`）
    - 依 design 5.6 的結構與 class；文件標題「管理後台 · 日子拾光」；Session 的角色不是 admin 或回應 403 `admin_required` 時顯示需求 34.5 的訊息頁
    - 三個區塊各自讀取，載入中、失敗與「重新載入」互不影響；統計列以 `admin_stats()` 計算；開關依需求 37.6 與 37.7
    - 帳號列表依需求 35.2（Disabled_Account 加 `is-deleted`、自己的列停用「停用帳號」並顯示說明）；搜尋欄以 `account_matches()` 即時篩選；重新讀取時保留搜尋文字
    - 伺服器回傳的文字一律以文字節點輸出
    - _Requirements: 32.6, 34.5, 34.6, 34.7, 34.8, 35.2, 35.3, 35.5, 35.6, 37.6, 37.7_
  - [ ] 31.3 對話框：編輯帳號、重設密碼、停用與啟用（`crates/web/src/pages/admin.rs`）
    - 沿用刪除旅行確認對話框的結構；焦點與 Esc 依需求 34.9；送出期間停用按鈕
    - 編輯帳號依需求 39.1、39.2、39.6、39.7；重設密碼依需求 36.1、36.2、36.7、36.8（關閉時清空密碼，不寫入 localStorage 或 sessionStorage）；停用依需求 40.2、40.7，啟用不經對話框
    - 每次成功之後重新讀取帳號列表與操作紀錄第 1 頁
    - _Requirements: 34.8, 34.9, 36.1, 36.2, 36.7, 36.8, 39.1, 39.2, 39.6, 39.7, 40.2, 40.7_
  - [ ] 31.4 操作紀錄區塊（`crates/web/src/pages/admin.rs`）
    - 依需求 41.5 與 41.6：`acct-audit` 列表、台灣時間、`audit_action_label()`、執行者已不存在時「已刪除的帳號」；換頁列與「只顯示最新的 200 筆。」；換頁只重新讀取這個區塊
    - _Requirements: 41.5, 41.6_
  - [ ] 31.5 `admin.css`（`crates/web/styles/admin.css`、`crates/web/index.html`）
    - 只有 design 5.6 列出的五組規則，顏色只用既有的 CSS 變數；在 `index.html` 的 `presence.css` 之後連結；在淺色與深色主題下確認文字對比至少 4.5:1、開關與欄位邊框至少 3:1、焦點可見；`styles/styles.css` 與其他既有樣式檔不修改（以 `git diff --stat` 確認）
    - _Requirements: 32.7, 32.8, 34.9_
- [ ] 32. 文件：首次切換、管理員的救援與 `LM_PUBLIC_SIGNUP`
  - 依 design 5.9 更新 `deploy/README.md`（第 5 節的表格、「首次切換」步驟 7，以及新增「管理員的救援」）、`deploy/compose/prod.env.example` 與 `staging.env.example` 的註解、根目錄 `README.md` Rust 章節中 `LM_PUBLIC_SIGNUP` 與首次管理員的說明，以及 `.env.example` 的註解；根目錄 `README.md` 在 Branch_Point 已存在的行不修改（需求 1.9）
  - 在 Local_Stack 實際執行一次「管理員的救援」的每段 SQL，確認可用（例如直接設定的密碼可以登入）
  - 在 `README.md` 的手動確認加入 design 5.8 的管理後台步驟
  - 不寫入任何秘密的值；新增的內容讓 `tests/readme.test.js` 照常通過（同任務 26）
  - _Requirements: 1.9, 1.12, 38.2, 38.3, 38.4_
- [ ] 33. Checkpoint - 管理後台
  - 在 Repository 根目錄執行 `cargo test`、`cargo clippy --workspace -- -D warnings`、`cargo fmt --check` 與 `trunk build --release --config crates/web/Trunk.toml`，結束碼都是 0；確認 Bun_App 的檔案（`server/`、`src/` 等）沒有變更，`crates/web/styles/styles.css` 與 Bun_App 的 `src/styles.css` 逐字相同，行程表分頁的輸出沒有改變
  - 請使用者依 README 執行管理後台的手動確認。Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 1.9, 32.7, 32.8, 33.8_
## Notes

- 所有任務都必須完成，包括範例測試、屬性測試與它們的共用產生器。屬性測試都依賴任務 5.5 的產生器；Property 7、8、9、10 與 12 另依賴任務 8.3，Property 1、2、3 與 11 依賴任務 9.3，Property 19 依賴任務 10.4 加入的 `arb_user_id()`。
- 任務 1 的暫存 Supabase 專案與探測程式都在 Repository 之外，不提交；記下的 CLI 版本寫進任務 26 的 README，收到的訊框原文供任務 12.1 對照。任務 2 與任務 4 至 11 不依賴 Spike 的結果，依使用者的決定先做；任務 3 與任務 12 至 27 等 Spike 通過才開始，任務 1.4 判定任一項失敗時則等使用者決定備案。
- Supabase CLI 固定使用 3.2.0 的 Linux 版（例如把 GitHub Releases 上的 Linux 執行檔放在 WSL 的 `~/.local/bin`），在 WSL 中以 `supabase` 執行；在 Windows 上時是以 `bunx supabase@3.2.0` 執行。Spike 改在 WSL 中執行：先前建立在 Windows `%TEMP%\lm-spike` 的暫存專案可以複製到 WSL 的家目錄（例如 `~/lm-spike`）。Docker 使用安裝在 WSL 2 的 Ubuntu 中的 Docker Engine，不使用 Docker Desktop，也就不受它的授權限制。
- WSL 2 的工作慣例：Repository 留在 Windows 的 `d:\path\to\little-moments`，在 WSL 中是 `/mnt/d/path/to/little-moments`；cargo、trunk、docker 與 Supabase CLI 都在 WSL 中、從這個目錄執行。在 `/mnt/d` 上建置很慢，所以環境變數 `CARGO_TARGET_DIR` 指向 Linux 檔案系統中的目錄（例如 `$HOME/.cache/lm-target`），不寫進 Repository 的 `.cargo/config.toml`。git 只在 Windows 的 PowerShell 執行、不在 WSL 中執行，因為 Windows 的 git 使用 `core.autocrlf`；每個頂層任務的提交，以及任務 27 的 `git diff` 與 `git worktree`，都在 PowerShell 進行。WSL 中綁在 127.0.0.1 的埠經 WSL 的 localhost 轉送，Windows 的瀏覽器可以開啟、區網連不到，需求 2 的 127.0.0.1 規則照樣成立；轉送的埠也綁在 Windows 上，所以仍在 PowerShell 以 `netsh interface ipv4 show excludedportrange protocol=tcp` 檢查保留的埠。WSL 的必要工具不含 Bun：任務 18.1 的 `scripts/export-art.mjs` 與任務 27 的 `bun run test` 沿用 Windows 上已安裝的 Bun，在 PowerShell 執行。在 Windows 修改 `/mnt/d` 中的檔案時，WSL 收不到檔案變更的通知，`trunk serve` 要加 `--poll` 才會自動重建。
- 每個任務都標註需求編號；Property 的編號與標題對應 design.md「Correctness Properties」。
- Local_Stack 使用 Sample_Secrets，第一版只在開發機上執行；lm-server 在非 loopback 位址偵測到範例金鑰時拒絕啟動（任務 13.1）。
- 波次的安排：同一個檔案的任務放在不同的波次；每個頂層任務的測試子任務排在它全部的實作子任務之後，以免測試在模組修改途中編譯；共用產生器（任務 5.5、8.3、9.3、10.4）排在使用它們的測試之前。lm-web 的五個分頁、Trip_Menu 與 Departure_Page 在任務 20.5 先有各自的佔位檔，所以任務 22 的四個子任務與任務 23 的兩個子任務可以平行；它們需要的新元件放在各自的檔案中。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["2.1"] },
    { "id": 1, "tasks": ["2.2"] },
    { "id": 2, "tasks": ["2.3"] },
    { "id": 3, "tasks": ["4.1"] },
    { "id": 4, "tasks": ["4.2"] },
    { "id": 5, "tasks": ["4.3"] },
    { "id": 6, "tasks": ["5.1"] },
    { "id": 7, "tasks": ["5.3"] },
    { "id": 8, "tasks": ["5.4"] },
    { "id": 9, "tasks": ["5.5"] },
    { "id": 10, "tasks": ["5.2", "5.6", "5.7", "5.8", "5.9", "5.10"] },
    { "id": 11, "tasks": ["6.1"] },
    { "id": 12, "tasks": ["6.2"] },
    { "id": 13, "tasks": ["6.4"] },
    { "id": 14, "tasks": ["6.6"] },
    { "id": 15, "tasks": ["6.3", "6.5", "6.7", "6.8"] },
    { "id": 16, "tasks": ["7.1"] },
    { "id": 17, "tasks": ["7.2", "7.3"] },
    { "id": 18, "tasks": ["8.1"] },
    { "id": 19, "tasks": ["8.2"] },
    { "id": 20, "tasks": ["8.5"] },
    { "id": 21, "tasks": ["8.6"] },
    { "id": 22, "tasks": ["8.7"] },
    { "id": 23, "tasks": ["8.8"] },
    { "id": 24, "tasks": ["8.9"] },
    { "id": 25, "tasks": ["8.3"] },
    { "id": 26, "tasks": ["8.4", "8.10", "8.11", "8.12", "8.13", "8.14", "8.15", "8.16"] },
    { "id": 27, "tasks": ["9.1"] },
    { "id": 28, "tasks": ["9.2"] },
    { "id": 29, "tasks": ["9.3"] },
    { "id": 30, "tasks": ["9.4", "9.5", "9.6", "9.7"] },
    { "id": 31, "tasks": ["10.1"] },
    { "id": 32, "tasks": ["10.3"] },
    { "id": 33, "tasks": ["10.4"] },
    { "id": 34, "tasks": ["10.2", "10.5", "10.6"] },
    { "id": 35, "tasks": ["11"] },
    { "id": 36, "tasks": ["1.1"] },
    { "id": 37, "tasks": ["1.2"] },
    { "id": 38, "tasks": ["1.3"] },
    { "id": 39, "tasks": ["1.4"] },
    { "id": 40, "tasks": ["3.1"] },
    { "id": 41, "tasks": ["3.2"] },
    { "id": 42, "tasks": ["3.3"] },
    { "id": 43, "tasks": ["3.4"] },
    { "id": 44, "tasks": ["12.1"] },
    { "id": 45, "tasks": ["12.2"] },
    { "id": 46, "tasks": ["12.4"] },
    { "id": 47, "tasks": ["12.5"] },
    { "id": 48, "tasks": ["12.6"] },
    { "id": 49, "tasks": ["12.3"] },
    { "id": 50, "tasks": ["13.1"] },
    { "id": 51, "tasks": ["13.2"] },
    { "id": 52, "tasks": ["13.3"] },
    { "id": 53, "tasks": ["14.1"] },
    { "id": 54, "tasks": ["14.2"] },
    { "id": 55, "tasks": ["15.1"] },
    { "id": 56, "tasks": ["15.2"] },
    { "id": 57, "tasks": ["15.3"] },
    { "id": 58, "tasks": ["15.4"] },
    { "id": 59, "tasks": ["16.1"] },
    { "id": 60, "tasks": ["16.2"] },
    { "id": 61, "tasks": ["17"] },
    { "id": 62, "tasks": ["18.1", "18.2"] },
    { "id": 63, "tasks": ["18.3"] },
    { "id": 64, "tasks": ["18.4"] },
    { "id": 65, "tasks": ["18.5"] },
    { "id": 66, "tasks": ["19.1"] },
    { "id": 67, "tasks": ["19.2"] },
    { "id": 68, "tasks": ["20.1"] },
    { "id": 69, "tasks": ["20.2"] },
    { "id": 70, "tasks": ["20.3"] },
    { "id": 71, "tasks": ["20.4"] },
    { "id": 72, "tasks": ["20.5"] },
    { "id": 73, "tasks": ["21.1"] },
    { "id": 74, "tasks": ["21.2"] },
    { "id": 75, "tasks": ["21.3"] },
    { "id": 76, "tasks": ["21.4"] },
    { "id": 77, "tasks": ["22.1", "22.2", "22.3", "22.4"] },
    { "id": 78, "tasks": ["23.1", "23.2"] },
    { "id": 79, "tasks": ["24.1"] },
    { "id": 80, "tasks": ["24.2"] },
    { "id": 81, "tasks": ["24.3"] },
    { "id": 82, "tasks": ["25"] },
    { "id": 83, "tasks": ["26"] },
    { "id": 84, "tasks": ["27"] },
    { "id": 85, "tasks": ["28.1"] },
    { "id": 86, "tasks": ["28.2", "28.3"] },
    { "id": 87, "tasks": ["29.1"] },
    { "id": 88, "tasks": ["29.2"] },
    { "id": 89, "tasks": ["30.1"] },
    { "id": 90, "tasks": ["30.2"] },
    { "id": 91, "tasks": ["30.3"] },
    { "id": 92, "tasks": ["30.4"] },
    { "id": 93, "tasks": ["30.5"] },
    { "id": 94, "tasks": ["30.6"] },
    { "id": 95, "tasks": ["31.1", "31.5"] },
    { "id": 96, "tasks": ["31.2"] },
    { "id": 97, "tasks": ["31.3"] },
    { "id": 98, "tasks": ["31.4"] },
    { "id": 99, "tasks": ["32"] },
    { "id": 100, "tasks": ["33"] }
  ]
}
```
