# Requirements Document

## Introduction

本文件規劃「日子拾光 / LITTLE MOMENTS」露營旅行網站的下一輪擴充。品牌精神是「把平凡的日子，留成喜歡的回憶」。本文件是**分階段規劃**，不是全部功能的實作授權：使用者確認範圍之前，只有本文件列為 Phase 1（MVP）的需求會被建議進入設計；其餘已確認方向依階段排序，候選功能預設不納入，排除功能不得放入第一版。

撰寫前已閱讀現有程式與文件，未修改任何程式、未重啟服務、未變更 `dist/`。下列「現況調查」是本文件所有需求的依據。

### 現況調查摘要

| 項目 | 現況（依原始碼與 README） | 對新功能的影響 |
| --- | --- | --- |
| 執行版本 | 帳號版：`/setup`、`/login`、`/<帳號>/home`，資料存在伺服器 SQLite（預設 `data/accounts.sqlite`，Docker 為 `/app/data`）。本機版：`/demo/`，資料只存在瀏覽器 localStorage（`ggc-local-demo-v2`），不連伺服器。使用者提供的 `http://127.0.0.1:5173/demo/#/trip` 是本機版。 | 分帳、收據辨識只在帳號版。照片、明信片、AI、email、營位搜尋需要伺服器，預設只做帳號版。每項需求都需註明適用版本。 |
| 主導覽 | 5 個分頁：行程表、料理菜單、採買清單、裝備分工、分帳記帳（`src/model.js` 的 `TABS`）。旅伴、車輛、匯出、列印等已收進行程標題旁的 Trip_Menu（`src/trip-menu.js`，spec `remove-vehicle-travel-tabs`）。 | 新功能優先放進 Trip_Menu 或情境操作，不新增主分頁。 |
| 收據辨識 | 純雲端 AI：伺服器以 OpenAI Chat Completions 加圖片辨識（`server/receipt-ai.js`），預設模型設定值 `gpt-6-luna`。沒有本機 OCR 備援；`.tmp-e2e-dist/assets/ocr` 內的 tesseract 檔案是舊建置殘留，測試（`tests/ocr-assets.e2e.js`）確認正式建置不提供這些檔案。另有手動輸入與貼上收據文字的流程（`src/receipt-parser.js`）。 | A 的「AI 分類」沿用現有雲端流程，不新增本機 OCR。 |
| 收據入帳資料 | 每個品項存成一筆獨立支出，帶 `source: 'receipt'`、`receiptId`（圖片 SHA-256 指紋）、`receiptLine`（品項行號）。收據本身的店名與印刷總額不保存，也沒有「總額」支出列。伺服器拒絕同一收據同一行重複入帳（409）。 | 收據卡片可依 `receiptId` 分組既有資料，不需資料遷移；卡片總額取已入帳品項合計，天然避免總額與明細重複計帳。 |
| 品項分類 | AI 已逐列回傳分類（限 `EXPENSE_CATEGORIES`，未知歸「其他」並標「分類待確認」）。但入帳時 `commitReceipt()` 把整張收據套用同一個 `R.category`，逐列分類被覆蓋。分類清單由前後端共用，伺服器會拒絕清單外分類。 | A.6（混合收據分屬不同類別）需要修改入帳流程。新增分類（例如「雜項」）需前後端同步，舊帳本不得被改寫。 |
| AI 管控 | `settings` 表的 `receiptAiPolicy`（all / admins / off）；環境變數控制每人 15 分鐘、每日、每月上限；`receipt_ai_usage` 表記錄每次呼叫與 token；每人同時 1 個、全站同時 2 個；API 金鑰只在伺服器（`.secrets/openai_api_key`）。 | F 應沿用同一套模式，但明信片需要獨立開關、獨立額度與獨立用量紀錄。 |
| 旅行資料 | 旅行內容存在 `trips.state_json`，格式由 `isValidState()` 嚴格檢查。`trip.destination` 只是文字，沒有座標或時區欄位。活動的 `time` 必填且必須是 `HH:MM`。旅行狀態有 `planning` / `completed`。 | B 需要新增營區座標與時區欄位。C 的「缺少時間的活動」目前不可能出現，除非改為時間可留空。E 的「完成旅行時提供明信片入口」可掛在 `completed` 狀態。 |
| 權限 | 主辦人或管理員：`canManage`、`canDelete`；受邀旅伴：`canEdit`、`canInvite`。非成員一律回 404。 | 照片、明信片、營位通知沿用相同權限模型並在後端驗證。 |
| 檔案儲存 | 目前沒有任何使用者檔案儲存；收據照片不保存；測試確認 `/uploads/...`、`/data/receipts/...` 回 404。 | D 照片牆是第一個需要檔案儲存的功能，需全新設計儲存、備份與存取控制。 |
| 請求與安全限制 | 應用程式請求本文上限 4 MiB，nginx `client_max_body_size 4m`。CSP：`connect-src 'self'`、`img-src 'self' data: blob:`。`Permissions-Policy` 關閉 geolocation、camera、microphone。 | 外部服務一律由後端代理。單次上傳不得超過 4 MiB，照片需在瀏覽器端縮圖或分次上傳。無法使用瀏覽器定位取得營區座標。 |
| 部署 | Docker Compose 以具名 volume 掛載 `/app/data`；公開部署只支援 nginx + TLS（`docs/deploy-nginx.md`）。備份建議使用 SQLite backup API。 | 新增檔案目錄必須在同一 volume 內，備份流程需同時涵蓋資料庫與檔案。 |
| 專案慣例 | `.kiro/steering` 目前沒有檔案。既有 spec：mobile-smooth-swipe、publish-behind-nginx、remove-vehicle-travel-tabs、security-hardening、unified-ui-controls。測試使用 `bun test`、fast-check、Playwright 隔離環境（記憶體資料庫，埠 5181）。 | 新需求沿用這些安全與測試慣例。 |

### 參考圖片狀態

使用者提到的第 2、3、4、5、6 張參考圖與「折角紙張＋手繪橫線」圖示**沒有在本環境提供**。本文件的視覺需求只以文字描述，未看過圖片，也不假設圖片內容。圖片提供前，視覺相關需求維持「待確認」，實作只能使用原創的暫用圖形並標示為暫用。

## 範圍表

### 已確認方向（A–G）

「方向確認」不等於已授權實作。階段欄位是本文件的建議，最終由使用者決定。

| 代號 | 功能 | 建議階段 | 適用版本 | 使用者需決定的事項 |
| --- | --- | --- | --- | --- |
| A | 收據辨識：逐項 AI 分類與單次掃描收據卡片 | **Phase 1（MVP）** | 帳號版 | 是否新增「雜項」分類或把「其他」改名；折角紙張圖示來源；卡片是否另存印刷總額供對照（目前不保存）。 |
| B | 天氣、日出日落、月相 | Phase 2 | 天氣：帳號版。日出日落與月相：兩版皆可（瀏覽器端計算） | 天氣資料供應商；網站是否屬於非商業用途；座標輸入方式；預設時區。 |
| C | 行程時間軸視圖 | Phase 2（先做比較，可能決定不做） | 兩版 | 現有卡片視圖是否已足夠；是否允許活動不填時間（需變更資料格式）。 |
| D | 照片牆／露營相簿（「回憶」入口） | Phase 3 | 帳號版 | 每張與每趟旅行的上傳上限、總容量、保留期間、備份方式。 |
| E | AI 專屬明信片（照片優先） | Phase 4（先做非 AI 固定版型，再做 AI 生成；email 寄送最後） | 帳號版 | 圖像模型、補充照片張數、對外傳送同意文字、email 供應商。 |
| F | Admin AI 明信片控制與成本保護 | Phase 4（必須在 E 的 AI 生成之前完成） | 帳號版 | 每趟旅行生成上限、全站每月額度或費用上限的數值。 |
| G | 營位搜尋與空位通知助手 | Phase 5（先做資料來源研究，找到合法來源才實作） | 帳號版 | 是否接受研究結論；可用的資料來源與其條款。 |

### 候選功能（第四節 1–25，未確認，預設不納入任何階段）

| 編號 | 候選功能 | 群組 | 依賴 | 需決定事項 |
| --- | --- | --- | --- | --- |
| 1 | 日期／營區投票 | 出發前與團體協調 | 無 | 是否需要、投票規則 |
| 2 | 訂位小信封 | 出發前與團體協調 | G 或 3 | 與 G 的訂位資料是否合併 |
| 3 | 訂位確認信／截圖匯入 | 出發前與團體協調 | AI 辨識（另需額度） | 是否另計 AI 額度 |
| 4 | 取消期限匯出行事曆檔 | 出發前與團體協調 | 2 或 3 | 匯出格式 |
| 5 | 旅伴飲食偏好 | 出發前與團體協調 | 無 | 個資範圍 |
| 6 | 料理份量換算 | 出發前與團體協調 | 料理菜單 | 換算規則 |
| 7 | 用既有旅行建立新旅行 | 出發前與團體協調 | 無 | 複製哪些資料 |
| 8 | 私人營地筆記 | 出發前與團體協調 | 無 | 可見範圍 |
| 9 | 營位小地圖 | 到達營區與現場 | 無 | 繪製方式 |
| 10 | 營主交代小紙條 | 到達營區與現場 | 無 | 位置 |
| 11 | 各車手動抵達狀態 | 到達營區與現場 | 車輛資料 | 是否需即時同步 |
| 12 | 抵達打卡與留言板 | 到達營區與現場 | 無 | 是否與 11 合併 |
| 13 | 共同歌單連結 | 到達營區與現場 | 無 | 允許的連結網域 |
| 14 | 離線手冊匯出 | 到達營區與現場 | 既有手冊匯出 | 格式 |
| 15 | 手冊分享 QR code | 到達營區與現場 | 14 或分享連結 | 分享權限 |
| 16 | 安全資訊頁 | 到達營區與現場 | 無 | 資料來源 |
| 17 | A4 分工表 | 到達營區與現場 | 既有列印 | 版面 |
| 18 | 旅行回顧 | 旅行回憶與分享 | D | 內容範圍 |
| 19 | 照片故事 | 旅行回憶與分享 | D | 排版 |
| 20 | 語音轉文字 | 旅行回憶與分享 | 外部服務；目前 microphone 被 Permissions-Policy 關閉 | 是否放寬權限、供應商 |
| 21 | 代表照「小營燈」 | 旅行回憶與分享 | D | 與封面照的差異 |
| 22 | 私人／分享相簿（移除 GPS 中繼資料、可撤銷連結） | 旅行回憶與分享 | D | 公開連結風險接受度 |
| 23 | 明信片背面 | 旅行回憶與分享 | E | 背面內容 |
| 24 | 露營照片賓果 | 旅行回憶與分享 | D | 題目來源 |
| 25 | 「這次學到的一件事」 | 旅行回憶與分享 | 無 | 位置 |

### 排除（第五節，第一版不得實作）

| 編號 | 排除功能 |
| --- | --- |
| X1 | 雨備方案 |
| X2 | 個人常備裝備櫃與精簡提醒 |
| X3 | 裝備重量體積與各車載重估算 |
| X4 | 採買冷鏈分組、冰桶估算 |
| X5 | 採買預估金額與預算對照 |
| X6 | 年度回顧與統計 |

## 建議分階段順序與最小可用版本

| 階段 | 內容 | 進入條件 | 完成條件 |
| --- | --- | --- | --- |
| Phase 0 | 確認本文件範圍、回答「待確認事項」、提供參考圖片與折角紙張圖示 | 本文件交付 | 使用者書面確認各階段範圍 |
| **Phase 1（MVP）** | A：收據卡片、逐項分類、展開明細、入帳前核對與異常提醒；跨功能的簡潔、無障礙與測試需求 | Phase 0 對 A 的決定 | 需求 4–9、需求 26–29 中適用 A 的條款全部通過驗證 |
| Phase 2 | B：營區座標與時區欄位、日出日落、月相、天氣摘要。C：先產出現有視圖比較，再決定是否實作 | 天氣供應商與用途類型確認 | B 的需求 10–13 通過；C 有明確的做或不做決定 |
| Phase 3 | D：照片儲存、上傳、相簿、封面照 | 儲存上限、容量與備份方案確認 | 需求 16–19 通過，備份與還原演練完成 |
| Phase 4 | F：AI 明信片開關與額度。E：先做非 AI 固定版型明信片與匯出，再做 AI 生成，最後才做 email 寄送 | F 的數值確認；圖像模型與 email 供應商查證完成 | 需求 20–24 通過 |
| Phase 5 | G：先交付資料來源研究；只有找到合法、穩定來源才實作搜尋與通知 | 研究結論經使用者核可 | 需求 25 通過 |

MVP 只包含 Phase 1。候選功能 1–25 都不在 MVP 內，也不在任何階段內，直到使用者逐項確認。

## 介面配置總表

每個功能預設只顯示必要資訊，細節以點開、彈出視窗或獨立頁面呈現。彈窗不得疊在另一個彈窗或抽屜上。

| 功能 | 位置 | 手機預設顯示 | 桌機預設顯示 | 點開後顯示 |
| --- | --- | --- | --- | --- |
| A 收據卡片 | 分帳記帳分頁的支出列表，一張收據一張卡片 | 簡短名稱、總額、主要類別；右側折角紙張圖示 | 同手機，另加付款人與分攤摘要一行 | 在卡片內展開品項明細（品名、金額、類別、待確認標記），再點收起 |
| B 天氣與日出日落 | 行程表日期列或當日摘要旁 | 小圖示＋溫度或日出時刻，擇一以節省空間 | 天氣圖示、最高最低溫、日出日落 | 彈出視窗：天氣來源、更新時間、預報範圍、日出日落、月相、山勢說明 |
| C 時間軸 | 行程表內的視圖切換（卡片／時間軸擇一） | 單欄時間軸，「未定時間」區在當日最上方 | 同手機，可較寬 | 點活動開啟既有活動編輯 |
| D 照片牆 | Trip_Menu 內「回憶」入口，旅行完成後於旅行卡片顯示同一入口 | 封面照＋旅行名稱與日期，下方兩欄縮圖 | 封面照＋三到四欄縮圖 | 點縮圖看大圖與一句註記 |
| E 明信片 | 「回憶」頁內的「做一張明信片」；旅行完成時於旅行卡片提供入口 | 單步驟頁面：一次只顯示一個步驟 | 同手機，預覽可並排 | 選照片 → 重點與同意 → 生成 → 預覽 → 匯出或寄送 |
| F Admin AI 控制 | 既有 `/admin` 管理頁，與收據 AI 設定分開成獨立區塊 | 開關＋本月用量／上限 | 開關、每趟上限、每月上限、用量 | 用量明細與任務狀態 |
| G 營位搜尋 | 旅行尚未填目的地時，行程表的情境操作「找營位」 | 一個按鈕 | 一個按鈕 | 獨立頁面：條件表單與結果卡片 |

## 外部服務可行性清單

狀態定義：**已查證**＝已讀到供應商官方頁面；**待確認**＝未查證或資訊不足；**不可行**＝已查證與需求衝突。查證日期為撰寫本文件當下，實作前需重新確認。

| 服務 | 用途 | 狀態 | 已知事實與來源 | 尚待確認 |
| --- | --- | --- | --- | --- |
| Open-Meteo Forecast API | B 天氣 | 已查證（條款與預報範圍） | 免費方案限非商業用途、免 API key，每日少於 10,000 次、每小時 5,000 次、每分鐘 600 次，資料採 CC-BY 4.0；伺服器日誌可能含座標並保留 90 天；商業用途需訂閱（[Terms](https://open-meteo.com/en/terms)）。預報預設 7 天、最長 16 天（[Docs](https://open-meteo.com/en/docs)）。 | 本網站是否屬非商業用途；日出日落欄位與回傳時區格式；CC-BY 標示方式。 |
| 中央氣象署開放資料平台 | B 天氣（台灣在地預報） | 待確認 | 第三方範例顯示需申請授權碼（例如 [F-A0010-001 範例](https://gist.github.com/louis70109/d165be10be06d71708804e89410c969e)），未讀到官方條款。 | 授權條款、配額、是否以座標查詢、預報範圍。 |
| 天文計算（日出日落、月相） | B | 待確認 | 不需外部服務，可用公開天文演算法在本機計算。尚未選定實作或驗證精度。 | 演算法或函式庫、精度驗證方式、授權。 |
| OpenAI Images API（edits） | E AI 明信片 | 部分已查證 | 官方 API 參考說明 edits 端點可接受一張或多張來源圖片加提示詞（[API Reference](https://developers.openai.com/api/reference/resources/images/methods/edit)）。 | 實際使用的模型名稱、可接受的來源圖片數上限（影響「1 主 + 最多 3 補充」）、價格、資料保留政策、組織驗證要求、輸出尺寸。 |
| Email 寄送供應商 | E 寄送、G 通知 | 待確認 | 尚未選定或查證任何供應商。 | 供應商、價格、配額、寄件網域驗證、退訂機制、資料保留。 |
| 民營露營訂位平台 | G | 待確認 | 未找到公開 API 或允許自動查詢的官方條款。 | 是否有官方 API 或合作管道；服務條款是否允許自動查詢；頻率限制。未取得允許前，自動擷取視為不可採用。 |
| 國家公園／林業保育署營地與山屋申請系統 | G（可能的官方來源） | 待確認 | 搜尋到第三方工具彙整這些名額（[Chrome 擴充套件頁](https://chromewebstore.google.com/detail/edmnldkkjfjmcnakgbadfhjepeekeolc)），未讀到官方 API 或條款。 | 官方是否提供查詢介面與使用條款；是否涵蓋一般露營區。 |
| 繞過驗證碼或平台規則的自動訂位 | G | 不可行 | 違反使用者明列的工程原則（第三節 G.11）。 | 無 |

## 待確認事項

1. **參考圖片**：請提供第 2、3、4、5、6 張參考圖與折角紙張圖示；未提供前視覺需求只依文字。
2. **A 分類**：「雜項」要新增為分類，還是把現有「其他」顯示為「雜項」？新增分類需前後端同步，舊帳本保留原分類。
3. **A 印刷總額**：目前不保存收據印刷總額。卡片只顯示已入帳品項合計，還是要另存印刷總額供對照（不計入支出）？
4. **A 簡短名稱**：卡片名稱使用店名（目前不保存，需新增欄位）還是第一個品項名稱？
5. **B 用途類型**：網站是否有訂閱或廣告？這決定 Open-Meteo 免費方案能否使用。
6. **B 座標輸入**：瀏覽器定位已被關閉。座標由使用者手動輸入、貼上地圖連結解析，或從地圖選點？
7. **B 時區**：預設 `Asia/Taipei`（需求 10.6 在時區留空時預填此值），是否需要支援海外旅行時區？
8. **C 時間軸**：是否允許活動不填時間？這需要變更 `isValidState()` 與伺服器驗證。
9. **D 上限**：每張照片大小、每趟旅行張數、全站總容量、保留期間的數值。
10. **D 備份**：照片檔案的備份頻率與存放位置；SQLite 備份不包含檔案。
11. **E 模型與張數**：圖像模型與可接受的補充照片張數，需查證後確認。
12. **E 同意文字**：對外傳送照片給 AI 服務的同意說明內容。
13. **F 數值**：每趟旅行生成上限（允許範圍 0–100）與全站每月額度（允許範圍 0–10,000，單位依供應商計費單位）的預設值（需求 23.2）。
14. **E／G email**：email 供應商與寄件網域。每位使用者每 24 小時的明信片寄送次數上限（需求 22.6）由設計階段提出建議值，請一併確認是否接受。
15. **G 資料來源**：研究結論出來後，是否接受只導向訂位來源、不自動訂位。
16. **候選功能**：1–25 中是否有任何一項要加入某階段。

## Glossary

- **Account_Mode**：帳號版。資料存在伺服器 SQLite，需登入，路徑如 `/<帳號>/home`。
- **Local_Planner**：本機版。路徑 `/demo/`，資料只存在瀏覽器 localStorage，不連伺服器。
- **Trip_State**：旅行內容，帳號版存在 `trips.state_json`，本機版存在 localStorage，由 `isValidState()` 驗證格式。
- **Trip_View**：旅行畫面，包含行程標題、主分頁與各分頁內容（`src/app.js` 的 `trip()`）。
- **Schedule_Tab**：Trip_View 中的「行程表」分頁。
- **Server**：帳號版的 Bun 伺服器（`server/` 目錄），負責 API、權限驗證與外部服務呼叫。
- **README**：專案根目錄的 `README.md`。
- **Deployment_Guide**：部署與備份文件（README 的 Docker 章節與 `docs/deploy-nginx.md`）。
- **Expansion_Plan**：本規劃與其後續 design、tasks 文件。
- **Design_Document**：本功能的 `design.md`。
- **Implementation**：依本規劃進行的程式修改工作。
- **Test_Suite**：專案的自動化測試（`bun test` 單元與屬性測試、Playwright 瀏覽器測試）。
- **Verification_Process**：每個階段完成後的測試執行與獨立審查。
- **First_Release**：使用者確認範圍後的第一個上線版本。
- **Trip_Menu**：行程標題旁選單按鈕開啟的選單（`src/trip-menu.js`），收納旅伴、車輛、匯出、列印等操作。
- **Ledger**：帳號版分帳帳本（`trip_ledgers` 表），包含支出與還款。
- **Expense_Category_Dictionary**：前後端共用的支出分類清單（`src/expense-categories.js` 的 `EXPENSE_CATEGORIES`）。
- **Receipt_Recognizer**：伺服器端收據 AI 辨識模組（`server/receipt-ai.js`），呼叫 OpenAI 並正規化結果。
- **Receipt_Review**：辨識完成後、入帳前的核對畫面。
- **Receipt_Group**：Ledger 中 `source` 為 `receipt` 且 `receiptId` 相同的所有支出。
- **Receipt_Card**：分帳記帳分頁中代表一個 Receipt_Group 的卡片。
- **Receipt_Total**：Receipt_Group 內所有支出 `amountCents` 的合計。
- **Detail_Toggle**：Receipt_Card 右側的折角紙張圖示按鈕，用來展開與收起明細。
- **Pending_Category_Mark**：品項旁的「待確認」標記，表示分類未經使用者確認。
- **Camp_Location**：旅行的營區座標（緯度、經度）與 IANA 時區，屬於 Trip_State。
- **Weather_Service**：伺服器端天氣代理模組，負責呼叫外部天氣供應商並快取結果。
- **Astronomy_Calculator**：計算日出、日落與月相的模組。
- **Day_Summary**：行程表中某一天日期旁的小型摘要區。
- **Itinerary_View_Switch**：行程表內切換卡片視圖與時間軸視圖的控制項。
- **Timeline_View**：以時間順序垂直排列活動的行程視圖。
- **Memories_Page**：「回憶」入口開啟的頁面，包含照片牆與明信片入口。
- **Photo_Store**：伺服器端照片儲存模組，負責檔案、縮圖、中繼資料與存取控制。
- **Trip_Photo**：一張上傳到旅行的照片及其縮圖、註記與上傳者紀錄。
- **Cover_Photo**：使用者為旅行選定的封面照。
- **Postcard_Builder**：建立明信片的流程與頁面。
- **Postcard**：一張已完成並可匯出的明信片成品，包含插畫或照片及網站排版文字。
- **Postcard_Generator**：伺服器端呼叫 AI 圖像服務產生插畫的模組。
- **Generation_Job**：一次 AI 明信片生成任務的伺服器紀錄，具有狀態與冪等鍵。
- **Mail_Sender**：伺服器端 email 寄送模組。
- **AI_Control_Panel**：`/admin` 中管理 AI 明信片開關與額度的區塊。
- **Postcard_AI_Policy**：AI 明信片的全站開關設定，獨立於收據辨識的 `receiptAiPolicy`。
- **Campsite_Finder**：營位搜尋與空位通知助手。
- **Availability_Watch**：使用者訂閱的缺位通知條件。
- **Admin**：`role` 為 `admin` 的帳號。
- **Trip_Manager**：旅行主辦人或 Admin（`canManage` 為 true）。
- **Trip_Member**：受邀並加入旅行的帳號（`canEdit` 為 true）。
- **Touch_Target**：可點擊或可觸控的互動區域。

## Requirements

### Requirement 1: 每個畫面保持簡潔（跨功能，全部階段）

**User Story:** 身為旅伴，我希望每個畫面只顯示當下需要的資訊，以便新增功能後網站仍然容易使用。

#### Acceptance Criteria

1. THE Trip_View SHALL 保持恰好 5 個主分頁（行程表、料理菜單、採買清單、裝備分工、分帳記帳），分頁名稱與順序不變，新功能不新增、移除或重新排序主分頁。
2. WHERE 新功能需要入口，THE Trip_View SHALL 將入口放在「介面配置總表」中該功能「位置」欄指定的 Trip_Menu、既有分頁內或情境操作，不在其他位置放置第二個入口。
3. THE Trip_View SHALL 在每個功能的預設狀態（使用者尚未點開任何該功能的控制項時）只顯示「介面配置總表」中該功能在目前視窗寬度（手機或桌機，以設計階段定義的桌機斷點區分）對應欄位列出的資訊，其餘資訊只在使用者點開、開啟彈出視窗或進入獨立頁面後顯示。
4. WHILE 一個彈出視窗或抽屜已開啟，WHEN 使用者在其中開啟下一層資訊，THE Trip_View SHALL 在同一個彈出視窗或抽屜內以取代內容的方式顯示下一層，畫面上同時開啟的彈出視窗與抽屜總數不超過 1 個。
5. WHILE 彈出視窗或抽屜顯示的是第二層以下的內容，THE Trip_View SHALL 提供返回控制項，啟動後回到上一層內容並保留上一層已輸入但未儲存的值。
6. THE Trip_View SHALL 只在 Memories_Page 顯示照片與明信片，行程表、活動卡片與其他主分頁不顯示照片縮圖或明信片。
7. THE Trip_View SHALL 在新功能加入後保留既有的行程、料理、採買、裝備、分帳操作位置與手勢（含手機滑動編輯與刪除），且新功能加入前已通過的既有 Playwright 測試在加入後全部繼續通過。

### Requirement 2: 視覺方向（跨功能，待參考圖片）

**User Story:** 身為使用者，我希望網站有一致的原創復古露營插畫風，以便回憶頁與明信片有溫度，而記帳與清單仍然清楚。

#### Acceptance Criteria

1. THE Trip_View SHALL 在新功能中只使用設計階段色票定義的松綠、芥末黃、磚橘、奶油白四種主色與湖水藍一種輔助色（另加色票中定義的文字色與深色主題對應值），不使用色票以外的顏色。
2. THE Trip_View SHALL 只把湖水藍用於圖示與插畫點綴，不用於按鈕底色、卡片背景或任何寬度超過所在容器 25% 的色塊。
3. THE Trip_View SHALL 只在旅行封面、Memories_Page 與 Postcard 放置寬度超過所在容器 25% 的插畫，金額、表單、清單與操作區的背景只使用單一純色，不含插畫或紙張顆粒。
4. THE Trip_View SHALL 使用原創的平面色塊、略有起伏的深色手繪線條與紙張顆粒，紙張顆粒只出現在插畫區域，所有圖形不含參考圖原圖、浮水印、品牌名稱或商標。
5. THE Trip_View SHALL 以非寫實、非 3D 的方式呈現人物，人物不使用照片描繪、不復刻真人臉孔。
6. WHILE 參考圖片與折角紙張圖示尚未由使用者提供，THE Trip_View SHALL 只使用原創的暫用圖形，且 Design_Document 的待替換清單逐一列出每個暫用圖形的名稱、使用位置與預定替換來源，清單之外不得存在暫用圖形。
7. WHILE 深色主題啟用，THE Trip_View SHALL 為新功能使用的每個色票顏色提供深色主題對應值，且對應值同樣符合需求 3 的對比要求。

### Requirement 3: 無障礙與操作（跨功能，全部階段）

**User Story:** 身為使用鍵盤、螢幕報讀器或手機的使用者，我希望所有新功能都能操作，以便每位旅伴都能使用。

#### Acceptance Criteria

1. THE Trip_View SHALL 讓每個新增 Touch_Target 的可點擊範圍至少 44 × 44 CSS 像素，且相鄰 Touch_Target 的可點擊範圍不重疊。
2. THE Trip_View SHALL 為每個只有圖示的按鈕提供描述動作與對象的無障礙名稱（例如「展開 12 筆品項明細」，而非只寫「展開」）。
3. WHERE 圖示不在 Design_Document 列出的通用圖示清單（關閉、返回、選單、展開收起）中，THE Trip_View SHALL 在圖示旁顯示 2 到 6 個字的可見短標籤。
4. THE Trip_View SHALL 讓每個新增互動元件可用 Tab 鍵依畫面由上到下、由左到右的順序取得焦點，並以 Enter 或空白鍵啟動。
5. WHEN 新增互動元件取得鍵盤焦點，THE Trip_View SHALL 顯示至少 2 CSS 像素寬、與相鄰顏色對比至少 3:1 的焦點外框。
6. WHEN 彈出視窗開啟，THE Trip_View SHALL 把焦點移到視窗內第一個互動元件，並在視窗開啟期間讓 Tab 與 Shift+Tab 只在視窗內的元件之間循環。
7. WHEN 使用者在彈出視窗內按下 Escape，THE Trip_View SHALL 關閉該視窗並把焦點移回開啟它的控制項。
8. THE Trip_View SHALL 在淺色與深色主題中，讓新增一般文字與背景的對比至少 4.5:1，大字（至少 24 CSS 像素，或至少 18.66 CSS 像素且為粗體）與傳達資訊的圖示至少 3:1。
9. WHILE 使用者的系統設定為減少動態效果（`prefers-reduced-motion: reduce`），THE Trip_View SHALL 停用新功能的轉場與動畫，狀態變更直接顯示最終畫面。
10. THE Trip_View SHALL 在 360 CSS 像素寬的視窗中顯示新功能的全部內容與操作，不產生頁面層級的水平捲動，也不截斷按鈕文字。

### Requirement 4: 收據卡片分組與總額（A，Phase 1／MVP）

**User Story:** 身為記帳的旅伴，我希望一次掃描形成一張收據卡片並先看到總額，以便支出列表不被大量品項淹沒。

#### Acceptance Criteria

1. THE Receipt_Card SHALL 為每個 Receipt_Group 在「支出明細」區塊顯示恰好一張卡片；`source` 不是 `receipt` 或 `receiptId` 為空字串的支出 SHALL 維持原本的單列顯示，不併入任何卡片。
2. THE Receipt_Card SHALL 在預設狀態顯示 Receipt_Total，並收起品項明細；Receipt_Total 的金額格式 SHALL 與既有支出列的新台幣金額格式相同。
3. THE Receipt_Card SHALL 以 Ledger 中同一份支出資料計算 Receipt_Total 與明細，不新增代表收據總額的支出列，也不保存另一份總額數值。
4. FOR ALL Ledger，各 Receipt_Total 加上所有不屬於 Receipt_Group 的支出 `amountCents` 總和 SHALL 等於 Ledger 全部支出 `amountCents` 的總和，且每筆支出 SHALL 恰好出現在一張 Receipt_Card 或一個單列中（不重複、不遺漏計帳不變式）。
5. WHEN Receipt_Group 中任一支出被編輯或刪除並經伺服器確認儲存，THE Receipt_Card SHALL 在同一次畫面更新中以更新後的支出重新計算 Receipt_Total、主要類別與明細，不需重新整理頁面。
6. WHEN Receipt_Group 只剩零筆支出，THE Receipt_Card SHALL 在同一次畫面更新中從列表移除該卡片。
7. THE Receipt_Card SHALL 為 Phase 1 之前已存在、帶有 `receiptId` 的支出顯示卡片，不改寫或遷移既有 Ledger 資料。
8. THE Receipt_Card SHALL 適用於 Account_Mode，Local_Planner 維持現狀（不提供 Ledger）。
9. THE Receipt_Card SHALL 放在 Receipt_Group 中最早支出日期的日期分組內；IF Receipt_Group 中的支出日期不完全相同，THEN THE Receipt_Card SHALL 在明細逐列顯示各自日期，且各日期分組的當日合計 SHALL 仍只計入該日期的支出金額。
10. THE Receipt_Card SHALL 在展開的明細中為每個品項保留與既有支出列相同的編輯與移除操作，並沿用相同的 `canEdit`、`canDelete` 權限判斷。

### Requirement 5: 收據卡片摘要內容（A，Phase 1／MVP）

**User Story:** 身為旅伴，我希望卡片只顯示關鍵摘要，以便快速知道這張收據是什麼、誰付的。

#### Acceptance Criteria

1. THE Receipt_Card SHALL 在預設狀態顯示簡短名稱、Receipt_Total 與主要類別，且不顯示個別品項名稱或金額。
2. THE Receipt_Card SHALL 以 Receipt_Group 中 `amountCents` 合計最高的 Expense_Category_Dictionary 類別作為主要類別，並以既有支出列相同的類別標籤樣式顯示。
3. IF 兩個以上類別的 `amountCents` 合計相同且最高，THEN THE Receipt_Card SHALL 以「多種類別」作為主要類別。
4. WHERE 視窗寬度大於等於設計階段定義的桌機斷點，THE Receipt_Card SHALL 在預設狀態另外顯示一行付款人與分攤摘要，格式與既有支出列的「付款人 付款 · 全員或 N 人平分」一致。
5. IF Receipt_Group 中的支出付款人或分攤旅伴不完全相同，THEN THE Receipt_Card SHALL 在摘要顯示「付款或分攤方式不一」，並在明細逐列顯示各自的付款人與分攤旅伴。
6. THE Receipt_Card SHALL 以 Phase 0 決定的來源作為簡短名稱；IF Phase 0 選定店名但該 Receipt_Group 沒有店名，THEN THE Receipt_Card SHALL 改用 `receiptLine` 順序第一個品項的名稱。
7. IF 簡短名稱超過 20 個字，THEN THE Receipt_Card SHALL 顯示前 19 個字加上「…」，並在卡片的無障礙名稱中提供完整名稱。

### Requirement 6: 展開與收起明細（A，Phase 1／MVP）

**User Story:** 身為旅伴，我希望用一個小圖示展開明細，以便需要時才看到每個品項。

#### Acceptance Criteria

1. THE Receipt_Card SHALL 在卡片右側顯示 Detail_Toggle，取代「查看 N 筆明細」長文字，且 Detail_Toggle 的 Touch_Target 至少 44 × 44 CSS 像素。
2. WHEN 使用者以點擊、觸控、Enter 或空白鍵啟動收起狀態的 Detail_Toggle，THE Receipt_Card SHALL 在同一張卡片內展開品項明細，不開啟彈出視窗或抽屜。
3. WHEN 使用者以點擊、觸控、Enter 或空白鍵啟動展開狀態的 Detail_Toggle，THE Receipt_Card SHALL 收起品項明細，並讓焦點留在 Detail_Toggle。
4. THE Detail_Toggle SHALL 以 `aria-expanded` 回報目前展開狀態，並以 `aria-controls` 指向明細區塊。
5. THE Detail_Toggle SHALL 提供包含目前品項數量的無障礙名稱，例如「展開 12 筆品項明細」與「收起 12 筆品項明細」，品項數量在支出新增或刪除後同步更新。
6. THE Receipt_Card SHALL 在展開的明細中依 `receiptLine` 由小到大逐列顯示品名、金額、類別與 Pending_Category_Mark（若有）。
7. WHEN 使用者展開或收起一張卡片，THE Receipt_Card SHALL 保持其他卡片的展開狀態不變。
8. WHEN 分帳記帳分頁初次顯示或重新載入頁面，THE Receipt_Card SHALL 以收起狀態顯示所有卡片；WHILE 使用者停留在分帳記帳分頁，THE Receipt_Card SHALL 在帳本儲存或重新載入後保留每張仍存在卡片的展開狀態。
9. THE Detail_Toggle SHALL 讓展開與收起狀態在圖示外觀上可區分，且不只以顏色區分。

### Requirement 7: 逐項分類與混合收據（A，Phase 1／MVP）

**User Story:** 身為記帳的旅伴，我希望每個品項有自己的類別，以便一張混合收據能正確分到食材與其他類別。

#### Acceptance Criteria

1. WHEN Receipt_Recognizer 回傳辨識結果（最多 150 個品項），THE Receipt_Review SHALL 為每個品項預填 AI 回傳的類別，且預填值一律屬於 Expense_Category_Dictionary。
2. WHEN 使用者在 Receipt_Review 確認入帳，THE Ledger SHALL 把每個已選品項存成一筆支出，該支出的類別等於入帳當下 Receipt_Review 顯示的該品項類別，不以單一類別覆蓋整張收據（例如 2 個品項為「食材／蔬菜」、1 個為「露營耗材」時，入帳後的 3 筆支出分別保有這兩種類別）。
3. THE Receipt_Review SHALL 在每個品項列提供類別選單，選項只包含 Expense_Category_Dictionary 中的分類，修改一列不改變其他列的類別。
4. THE Expense_Category_Dictionary SHALL 作為前端、伺服器驗證與 AI 提示詞的唯一分類來源。
5. WHEN Expense_Category_Dictionary 新增分類，THE Ledger SHALL 保留既有支出的原分類，讀取時不重新分類。
6. IF AI 回傳的類別不在 Expense_Category_Dictionary 中，THEN THE Receipt_Recognizer SHALL 將該品項類別設為「其他」並加上 Pending_Category_Mark。
7. WHEN 使用者選擇一個類別並啟動「套用到已選品項」操作，THE Receipt_Review SHALL 把該類別寫入所有已選品項，未選品項的類別維持不變。
8. WHEN 品項來自貼上收據文字解析或手動新增，THE Receipt_Review SHALL 依品名預填 Expense_Category_Dictionary 中的建議類別，並為該品項加上 Pending_Category_Mark。
9. IF 入帳請求中任一品項的類別不在伺服器的 Expense_Category_Dictionary 中，THEN THE Server SHALL 拒絕整批入帳且不寫入任何支出，THE Receipt_Review SHALL 保留全部草稿內容並顯示指出出錯列號的錯誤訊息。

### Requirement 8: 待確認標記（A，Phase 1／MVP）

**User Story:** 身為旅伴，我希望系統誠實標出不確定的分類，以便我知道哪些需要檢查。

#### Acceptance Criteria

1. IF AI 沒有明確標示品項為確定（包含沒有回傳此標示），或品項的 AI 類別不在 Expense_Category_Dictionary 中，THEN THE Receipt_Review SHALL 在該品項顯示 Pending_Category_Mark。
2. WHEN 使用者變更一個帶有 Pending_Category_Mark 的品項類別，或對該品項啟動「確認分類」操作，THE Receipt_Review SHALL 只移除該品項的 Pending_Category_Mark，其他品項的標記維持不變；只修改品名或金額時不移除標記。
3. THE Receipt_Review SHALL 以可見文字「待確認」顯示 Pending_Category_Mark，該文字也包含在品項列的無障礙名稱中，並且不顯示任何百分比或可信度數字。
4. THE Receipt_Recognizer SHALL 只依 AI 回傳的欄位與 Expense_Category_Dictionary 判定 Pending_Category_Mark，不自行產生可信度分數。
5. WHEN 使用者確認入帳，且有已選品項仍帶 Pending_Category_Mark，THE Ledger SHALL 讓這些支出保留 Pending_Category_Mark，使 Receipt_Card 展開明細時在這些品項旁顯示「待確認」；Pending_Category_Mark 本身不停用入帳按鈕。
6. WHEN 使用者在 Ledger 中編輯一筆帶有 Pending_Category_Mark 的支出並儲存類別，THE Ledger SHALL 移除該支出的 Pending_Category_Mark，同一 Receipt_Group 中其他支出的標記維持不變。

### Requirement 9: 入帳前核對與異常提醒（A，Phase 1／MVP）

**User Story:** 身為記帳的旅伴，我希望入帳前快速核對總額、付款人與分攤方式，並在異常時被提醒，以便帳目正確又不必每次逐筆檢查。

#### Acceptance Criteria

1. THE Receipt_Review SHALL 在入帳按鈕上方顯示已選品項數、已選品項合計（新台幣，精確到 0.01 元）、付款人名稱、分攤旅伴名稱與人數，以及仍帶 Pending_Category_Mark 的已選品項數；品項明細預設收起。
2. IF 收據總額欄位空白，或已選品項合計與收據總額以 0.01 元為單位比較不相等，THEN THE Receipt_Review SHALL 展開顯示差額（或「找不到收據總額可以比對」）的差異提醒，並在使用者把總額修正為相等或勾選確認差異之前停用入帳按鈕。
3. WHEN 使用者勾選確認差異之後，已選品項合計、收據總額或已選品項數任一項改變，THE Receipt_Review SHALL 取消該確認勾選並重新停用入帳按鈕。
4. IF 圖片指紋等於 Ledger 中任一 Receipt_Group 的 `receiptId`，THEN THE Receipt_Review SHALL 顯示疑似重複的提醒（指出既有收據的品項數與日期）並停用入帳按鈕，草稿內容保留不清除。
5. IF Receipt_Recognizer 回傳警告（日期不明、總額不明、可能為折扣或付款列、品項合計與總額不符或沒有辨識到品項），THEN THE Receipt_Review SHALL 在入帳按鈕上方以清單逐則顯示每一則警告（最多 20 則 AI 警告加上系統產生的警告），且相同內容的警告只顯示一次。
6. IF Receipt_Recognizer 辨識失敗、超過 55 秒逾時、被 `receiptAiPolicy` 停用或額度用盡，THEN THE Receipt_Review SHALL 顯示指出上述失敗類型的原因、不自動重新送出辨識，並提供手動輸入支出與貼上收據文字兩種替代流程，已填的日期、付款人與分攤旅伴保留不清除。
7. THE Receipt_Recognizer SHALL 維持現有雲端 AI 架構，不新增本機 OCR 或自動切換到其他辨識方式。
8. WHEN 使用者確認入帳，THE Ledger SHALL 保留每個品項的 `receiptId` 與 `receiptLine`，並繼續以伺服器端驗證拒絕同一收據同一行的重複入帳。
9. IF 伺服器因同一收據同一行已入帳而拒絕請求，THEN THE Ledger SHALL 不寫入該批任何支出，THE Receipt_Review SHALL 保留草稿並顯示指出收據已記錄過的錯誤訊息，不自動重送。
10. IF 沒有選取任何品項、任一已選品項金額空白或不在 0.01 到 9,999,999.99 元之間，或使用者尚未勾選「已逐項核對品項與金額」，THEN THE Receipt_Review SHALL 停用入帳按鈕，並列出每一個阻擋原因（金額問題需指出列號）。
11. WHILE 入帳請求尚未收到伺服器回應，THE Receipt_Review SHALL 停用入帳按鈕，使重複點擊不送出第二個入帳請求。

### Requirement 10: 營區座標與時區（B，Phase 2）

**User Story:** 身為主辦人，我希望為旅行設定營區座標與時區，以便天氣與日出日落使用精確位置。

#### Acceptance Criteria

1. THE Trip_State SHALL 提供選填的 Camp_Location，包含緯度（-90 到 90，含端點，最多 6 位小數）、經度（-180 到 180，含端點，最多 6 位小數）與 IANA 時區名稱（最長 64 字元），三個欄位必須同時存在或同時不存在。
2. IF 使用者輸入的緯度、經度或時區超出範圍、小數位數超過 6 位、時區不是有效的 IANA 時區名稱，或三個欄位只填了一部分，THEN THE Trip_View SHALL 拒絕儲存，逐一標示每個錯誤欄位，保留使用者已輸入的內容，並維持先前已儲存的 Camp_Location 不變。
3. THE Weather_Service SHALL 只以 Camp_Location 的座標與時區查詢，不以營區名稱或 `destination` 文字推測位置。
4. WHEN Camp_Location 新增到 Trip_State，THE Trip_State SHALL 讓未設定 Camp_Location 的既有旅行在 Account_Mode 與 Local_Planner 都繼續通過格式驗證，且讀取與儲存時不為既有旅行自動加入 Camp_Location。
5. WHILE Camp_Location 未設定，THE Day_Summary SHALL 在 Account_Mode 顯示「設定營區位置以顯示天氣」的短提示、在 Local_Planner 顯示「設定營區位置以顯示日出日落」的短提示，行程表其餘功能維持可用。
6. WHEN 使用者填寫座標但時區欄位留空，THE Trip_View SHALL 在時區欄位預填 `Asia/Taipei`，使用者可在儲存前修改（預設值待 Phase 0 確認）。
7. WHEN 使用者清除 Camp_Location 並儲存，THE Trip_State SHALL 同時移除緯度、經度與時區三個欄位，THE Day_Summary SHALL 回到第 5 條的未設定提示狀態。
8. IF Server 收到的 Trip_State 中 Camp_Location 不符合第 1 條的範圍或格式，THEN THE Server SHALL 拒絕整筆寫入、回傳指出 Camp_Location 格式錯誤的錯誤訊息，並保留伺服器上原本的 Trip_State。

### Requirement 11: 日出日落與月相（B，Phase 2）

**User Story:** 身為旅伴，我希望看到每天的日出日落與月相，以便安排看日出與夜間活動。

#### Acceptance Criteria

1. WHEN Camp_Location 已設定，THE Astronomy_Calculator SHALL 以座標、日期與 Camp_Location 時區，為旅行開始日到結束日（含兩端）的每個日期計算日出與日落時刻，時刻以該時區的 24 小時制 `HH:MM` 表示，與設計階段選定的參考資料相比誤差不超過 2 分鐘。
2. WHERE 視窗寬度大於等於設計階段定義的桌機斷點，THE Day_Summary SHALL 以小型圖示加短文字同時顯示日出與日落時刻。
3. WHERE 視窗寬度小於設計階段定義的桌機斷點，THE Day_Summary SHALL 只在該日沒有顯示天氣摘要時，以小型圖示加短文字顯示日出時刻。
4. THE Trip_View SHALL 只在使用者點開 Day_Summary 後的當日詳細資訊彈出視窗中顯示月相，不在 Day_Summary 顯示。
5. THE Trip_View SHALL 在日出日落詳細資訊中以文字說明山勢與地形可能讓實際看見的時刻與計算值不同。
6. THE Trip_View SHALL 以 8 種月相名稱之一（新月、眉月、上弦月、盈凸月、滿月、虧凸月、下弦月、殘月）與 0% 到 100% 的整數照明比例呈現月相，不把月相描述為觀星品質。
7. IF 某日期在 Camp_Location 沒有日出或日落（極晝或極夜），THEN THE Astronomy_Calculator SHALL 回傳「當日無日出」或「當日無日落」，不回傳時刻。
8. THE Astronomy_Calculator SHALL 在 Account_Mode 與 Local_Planner 都於瀏覽器端計算，不呼叫外部服務，也不傳送 Camp_Location 到 Server 以外的任何服務。

### Requirement 12: 天氣摘要與詳細資訊（B，Phase 2）

**User Story:** 身為旅伴，我希望在行程日期旁看到天氣與溫度，以便決定要帶的衣物。

#### Acceptance Criteria

1. WHEN Camp_Location 已設定且日期在供應商預報範圍內，THE Day_Summary SHALL 以小型露營風圖示顯示天氣狀態，並以四捨五入到整數的攝氏度數顯示當日最高溫與最低溫。
2. THE Trip_View SHALL 在使用者點開 Day_Summary 後的天氣詳細資訊彈出視窗中，顯示資料來源名稱、以 Camp_Location 時區表示的更新時間（`YYYY-MM-DD HH:MM`），以及預報涵蓋的起訖日期。
3. IF 日期早於 Camp_Location 時區的今天，或晚於供應商預報範圍的最後一天，THEN THE Day_Summary SHALL 顯示「尚無預報」，不以歷史氣候資料取代預報。
4. WHERE 視窗寬度小於設計階段定義的桌機斷點，THE Day_Summary SHALL 只顯示天氣圖示與當日最高溫一個溫度值。
5. WHERE 供應商條款要求標示來源或授權，THE Trip_View SHALL 在天氣詳細資訊中顯示該標示。
6. THE Day_Summary SHALL 把供應商回傳的天氣狀態對應到設計階段定義、最多 8 種的天氣圖示類別之一，無法對應的狀態顯示為「天氣不明」圖示，並為每個圖示提供描述天氣狀態的無障礙名稱。
7. WHERE 旅行屬於 Local_Planner，THE Day_Summary SHALL 不顯示天氣區塊，也不發出任何天氣請求。

### Requirement 13: 天氣服務降級與金鑰保護（B，Phase 2）

**User Story:** 身為旅伴，我希望天氣服務失敗時行程仍能正常使用，以便外部服務問題不影響規劃。

#### Acceptance Criteria

1. THE Weather_Service SHALL 由伺服器呼叫外部天氣供應商，瀏覽器只呼叫同源 API。
2. WHERE 供應商需要金鑰，THE Weather_Service SHALL 把第三方金鑰存放在伺服器端金鑰檔，不傳送到瀏覽器；IF 金鑰檔不存在或為空，THEN THE Weather_Service SHALL 視同天氣功能停用，不呼叫供應商。
3. IF 外部天氣供應商回應失敗、回應格式無法解析，或 8 秒內未回應，THEN THE Weather_Service SHALL 在有相同座標與日期的快取資料時回傳該快取與其更新時間，沒有快取時 THE Day_Summary SHALL 隱藏天氣區塊並在詳細資訊顯示「天氣暫時無法取得」，行程表其餘內容正常顯示。
4. THE Weather_Service SHALL 依座標與日期快取供應商結果，快取期間介於 30 分鐘到 6 小時之間，實際數值在設計階段依供應商條款訂定；在快取期間內相同座標與日期的請求 SHALL 不呼叫供應商。
5. THE Weather_Service SHALL 只送出座標、日期與時區給供應商，不送出旅行名稱、旅伴、帳號名稱或 email。
6. WHILE 當日（以 `Asia/Taipei` 的 00:00 起算）呼叫供應商次數達到設計階段訂定、且不高於供應商條款上限的每日上限，THE Weather_Service SHALL 停止呼叫供應商，並回傳快取資料或「天氣暫時無法取得」，直到下一個 00:00 重新計數。
7. WHILE 天氣功能的全站開關為關閉（Phase 2 預設關閉），THE Weather_Service SHALL 不呼叫供應商，THE Day_Summary SHALL 不顯示天氣區塊與未設定提示中的天氣字樣，日出日落顯示不受影響。

### Requirement 14: 時間軸視圖比較（C，Phase 2 前置）

**User Story:** 身為產品負責人，我希望先比較現有卡片視圖是否已足夠，以便決定時間軸是否值得做。

#### Acceptance Criteria

1. THE Design_Document SHALL 在實作 Timeline_View 前，以同一份含 1 天 8 個活動的範例 Trip_State，在 360 CSS 像素寬與桌機斷點寬的視窗截圖比較卡片視圖與 Timeline_View 草圖，並逐項記錄以下數值：首屏不捲動可見的活動數、看出當日活動先後順序所需的點擊與捲動次數、開啟一個活動編輯所需的點擊次數。
2. WHEN 使用者決定不實作 Timeline_View，THE Expansion_Plan SHALL 把需求 15 標示為不實作，並從後續 tasks 文件移除所有需求 15 的任務。
3. THE Design_Document SHALL 在比較結果中記錄使用者的「實作」或「不實作」決定、決定日期，以及待確認事項 8（活動是否允許不填時間）的回答。
4. WHILE 需求 14 的決定尚未記錄在 Design_Document，THE Expansion_Plan SHALL 不建立任何需求 15 的實作任務。

### Requirement 15: 時間軸視圖（C，Phase 2，視需求 14 結果）

**User Story:** 身為旅伴，我希望可以切換成時間軸看一天的行程，以便看出活動先後與日落時間。

#### Acceptance Criteria

1. THE Itinerary_View_Switch SHALL 在 Account_Mode 與 Local_Planner 的 Schedule_Tab 內提供「卡片」與「時間軸」兩個選項，任何時刻只顯示其中一種視圖。
2. THE Timeline_View SHALL 讀寫與卡片視圖相同的 Trip_State 活動資料，切換視圖本身不修改 Trip_State。
3. FOR ALL 活動資料，在 Timeline_View 編輯後於卡片視圖讀取 SHALL 得到相同的活動內容（兩視圖一致性）。
4. WHERE Camp_Location 已設定且該日有日落時刻，THE Timeline_View SHALL 在時間早於日落的最後一個活動與時間等於或晚於日落的第一個活動之間顯示日落標記；IF 該日沒有日落（需求 11.7）或 Camp_Location 未設定，THEN THE Timeline_View SHALL 不顯示日落標記。
5. WHERE 活動時間被允許留空，THE Timeline_View SHALL 把無時間的活動放在當日最上方的「未定時間」區塊，不推測時刻、停留時間或交通時間。
6. WHEN 使用者重新開啟行程表，THE Itinerary_View_Switch SHALL 在同一瀏覽器顯示該使用者上次選擇的視圖；IF 沒有上次選擇的紀錄，THEN THE Itinerary_View_Switch SHALL 顯示卡片視圖。
7. THE Timeline_View SHALL 依活動 `time` 由早到晚排列同一天的活動，時間相同的活動維持其在 Trip_State 中的原有順序。
8. WHEN 使用者在 Timeline_View 點擊活動，THE Timeline_View SHALL 開啟既有的活動編輯介面，不提供另一套編輯表單。

### Requirement 16: 照片儲存與上傳（D，Phase 3）

**User Story:** 身為旅伴，我希望在旅行期間和結束後上傳照片，以便大家的照片集中在一個地方。

#### Acceptance Criteria

1. THE Photo_Store SHALL 只接受 JPEG、PNG 與 WebP 格式，並以檔案內容判定格式，不以副檔名判定；IF 檔案內容不是這三種格式，THEN THE Photo_Store SHALL 拒絕該檔案，回傳指出允許格式的錯誤訊息，且不儲存任何檔案或紀錄。
2. IF 一次上傳會超過 Phase 0 決定的單張大小、單趟張數或全站容量上限，THEN THE Photo_Store SHALL 拒絕該張照片，回傳指出被超過的上限種類與數值的錯誤訊息，且已存在的照片維持不變。
3. THE Memories_Page SHALL 在上傳前於瀏覽器端依 EXIF 方向轉正，並把照片長邊縮小到設計階段訂定的像素值，使單次請求本文不超過 4 MiB；IF 縮小後仍超過 4 MiB，THEN THE Memories_Page SHALL 不送出該張照片並顯示檔案過大的提示。
4. THE Photo_Store SHALL 重新編碼每張照片，移除包含 GPS 在內的全部 EXIF 中繼資料後才儲存，儲存後的原圖與縮圖都不含任何 EXIF 欄位。
5. THE Photo_Store SHALL 為每張照片產生縮圖，相簿列表只載入縮圖，原圖只在使用者點開大圖時載入。
6. THE Photo_Store SHALL 把照片檔案存放在資料 volume 內不可由靜態檔案路由直接存取的目錄，以靜態路徑請求照片檔案時回應 404。
7. THE Photo_Store SHALL 除方向轉正、縮小尺寸、重新編碼與移除中繼資料外，不對照片做任何修改，不套用濾鏡或 AI 處理。
8. IF 上傳中斷或失敗，THEN THE Photo_Store SHALL 不留下沒有資料庫紀錄的檔案，也不留下沒有檔案的資料庫紀錄。
9. WHEN 一張照片上傳成功，THE Photo_Store SHALL 記錄上傳者與上傳時間，THE Memories_Page SHALL 在不重新整理頁面的情況下顯示該照片縮圖。
10. IF 使用者一次選擇多張照片且其中一張上傳失敗，THEN THE Memories_Page SHALL 逐張顯示成功或失敗結果，已成功的照片保留，失敗的照片不影響其他照片。

### Requirement 17: 照片存取權限與刪除（D，Phase 3）

**User Story:** 身為旅伴，我希望只有這趟旅行的成員看得到照片，以便保護大家的隱私。

#### Acceptance Criteria

1. THE Photo_Store SHALL 只讓該旅行的 Trip_Member 與 Trip_Manager 上傳、瀏覽與下載照片，並在伺服器端驗證每次請求的登入狀態與旅行成員身分。
2. IF 非成員請求照片、縮圖、註記或照片列表，THEN THE Photo_Store SHALL 回應 404，回應內容不因照片存在與否而不同。
3. THE Photo_Store SHALL 讓上傳者與 Trip_Manager 刪除照片；IF 其他成員送出刪除請求，THEN THE Photo_Store SHALL 拒絕請求並保留照片、縮圖與紀錄不變。
4. WHEN 照片被刪除，THE Photo_Store SHALL 同時刪除原圖、縮圖與資料庫紀錄，並寫入包含刪除者、刪除時間與照片識別碼的稽核紀錄；IF 被刪除的照片是 Cover_Photo，THEN THE Memories_Page SHALL 改為顯示旅行原本的插畫封面。
5. WHEN 旅行被刪除，THE Photo_Store SHALL 刪除該旅行的所有照片檔案、縮圖與紀錄，刪除後一致性檢查（需求 19.4）不列出該旅行的任何檔案或紀錄。
6. THE Photo_Store SHALL 以不可由序號、檔名或上傳時間推算的識別碼命名照片，照片與縮圖的回應標頭禁止共用快取儲存。
7. WHEN 使用者在 Memories_Page 啟動刪除照片，THE Memories_Page SHALL 先在同一檢視視窗內要求確認，使用者確認後才送出刪除請求。
8. WHEN 一位成員被移出旅行，THE Photo_Store SHALL 對該帳號之後的照片請求回應 404，該成員已上傳的照片保留，並仍可由 Trip_Manager 刪除。

### Requirement 18: 照片牆呈現（D，Phase 3）

**User Story:** 身為旅伴，我希望照片整齊排列並有一張封面，以便旅行結束後回味。

#### Acceptance Criteria

1. THE Trip_Menu SHALL 提供「回憶」入口開啟 Memories_Page；WHEN 旅行狀態為 `completed`，THE Trip_View SHALL 在旅行卡片另外顯示同一個「回憶」入口。
2. THE Memories_Page SHALL 在頂部顯示 Cover_Photo、旅行名稱與旅行日期。
3. WHILE 尚未選定 Cover_Photo，THE Memories_Page SHALL 顯示旅行原本的插畫封面。
4. THE Memories_Page SHALL 讓 Trip_Member 與 Trip_Manager 從該旅行已上傳的照片中選定或更換 Cover_Photo，選定結果對該旅行所有成員顯示相同的 Cover_Photo。
5. WHERE 視窗寬度小於設計階段定義的桌機斷點，THE Memories_Page SHALL 以兩欄排列縮圖；WHERE 視窗寬度大於等於桌機斷點，THE Memories_Page SHALL 以 3 欄或 4 欄排列縮圖，欄數切換寬度由設計階段定義。
6. THE Memories_Page SHALL 為每張縮圖使用相同的奶油白邊框，不加膠帶、旋轉或翻書動畫。
7. WHEN 使用者點開縮圖，THE Memories_Page SHALL 在單一檢視視窗顯示大圖與該照片的註記，不再疊加其他彈出視窗。
8. THE Memories_Page SHALL 只讓上傳者為照片新增或修改註記，註記可留空，長度為 0 到 60 字；IF 註記超過 60 字，THEN THE Memories_Page SHALL 拒絕儲存並保留原註記。
9. THE Memories_Page SHALL 只在封面與日期分隔處放置插畫點綴。
10. THE Memories_Page SHALL 依上傳時間由舊到新排列縮圖，並依上傳日期分組，每組前顯示一個日期分隔。
11. IF 旅行沒有任何 Trip_Photo，THEN THE Memories_Page SHALL 在封面下方顯示尚無照片的提示與上傳照片按鈕。

### Requirement 19: 照片備份與遷移（D，Phase 3）

**User Story:** 身為網站管理員，我希望照片有可還原的備份，以便資料不會因故障遺失。

#### Acceptance Criteria

1. THE Photo_Store SHALL 以可重複執行的資料庫遷移建立照片相關資料表，遷移前先以 SQLite backup API 備份資料庫；IF 備份失敗，THEN THE Photo_Store SHALL 不執行遷移並保持資料庫結構不變。
2. THE Deployment_Guide SHALL 說明同時備份 SQLite 資料庫與照片目錄的步驟、讓兩者對應同一時間點的做法，以及兩者的還原順序。
3. WHEN 管理員依 Deployment_Guide 還原備份，THE Photo_Store SHALL 讓每筆照片紀錄都對應到存在的原圖與縮圖檔案。
4. THE Photo_Store SHALL 提供管理員可執行的一致性檢查，列出沒有紀錄的檔案與沒有檔案的紀錄及其數量；一致性檢查只讀取，不刪除或修改任何檔案與紀錄。
5. WHEN 遷移在已完成遷移的資料庫上再次執行，THE Photo_Store SHALL 不改變既有資料表與照片紀錄。
6. WHEN Phase 3 實作完成，THE Verification_Process SHALL 在隔離環境依 Deployment_Guide 執行一次備份與還原演練，並記錄還原後一致性檢查的結果為零筆異常。

### Requirement 20: 非 AI 明信片（E，Phase 4 第一步）

**User Story:** 身為旅伴，我希望 AI 不可用時也能用照片做明信片，以便每趟旅行都能留下一張紀念。

#### Acceptance Criteria

1. THE Postcard_Builder SHALL 讓 Trip_Member 與 Trip_Manager 選擇恰好一張 Trip_Photo 與一種固定版型來製作 Postcard。可選版型數為 1 到 3 種，由設計階段定義。整個流程不呼叫任何 AI 服務。
2. THE Postcard_Builder SHALL 由網站排版旅行名稱、旅行日期與使用者輸入的一句話。這句話可留空，長度 0 到 40 字，超過 40 字時阻止繼續輸入並顯示字數上限。文字一律不由 AI 產生。
3. WHEN 旅行狀態由 `planning` 變為 `completed`，THE Trip_View SHALL 在該旅行卡片顯示明信片入口。旅行狀態為 `planning` 時，旅行卡片不顯示此入口，明信片入口只出現在 Memories_Page 的「做一張明信片」。
4. WHEN 使用者在預覽確認成品，THE Postcard_Builder SHALL 提供單一圖片檔下載。匯出內容與預覽的照片、版型和文字相同，長邊至少 1200 像素。
5. IF 旅行的 Trip_Photo 數量為 0，THEN THE Postcard_Builder SHALL 顯示「需要先上傳照片」的提示與前往 Memories_Page 上傳的按鈕，不產生沒有照片的 Postcard。
6. IF 選定的 Trip_Photo 在匯出前已被刪除或無法讀取，THEN THE Postcard_Builder SHALL 停用匯出，顯示照片已無法使用的錯誤訊息，並保留已輸入的文字與版型，讓使用者重新選擇照片。
7. IF 圖片檔匯出失敗，THEN THE Postcard_Builder SHALL 顯示匯出失敗的錯誤訊息，保留預覽內容，並提供重試匯出的操作。

### Requirement 21: AI 明信片生成流程（E，Phase 4，需 F 完成）

**User Story:** 身為旅伴，我希望用照片生成一張原創復古露營插畫明信片，以便留下有風格的回憶。

#### Acceptance Criteria

1. THE Postcard_Builder SHALL 依序呈現五個步驟，一次只顯示一個步驟：選照片、確認重點與對外傳送同意、按下生成、預覽、確認匯出或寄送。使用者返回上一步時，已選照片、已輸入重點與同意狀態都保留。
2. THE Postcard_Builder SHALL 讓使用者選擇 0 或 1 張主照片，以及 0 到 N 張補充照片。補充照片只能在已選主照片時選擇。N 為查證圖像模型後由使用者確認的整數（初版建議 3）。選擇數超過 N 時，THE Postcard_Builder SHALL 停用其餘照片的選取並顯示上限。
3. THE Postcard_Builder SHALL 讓使用者輸入 0 到 40 字的畫面重點，營區資料只作為輔助描述。IF 主照片為 0 張且畫面重點為空，THEN THE Postcard_Builder SHALL 停用生成按鈕並提示至少選一張照片或輸入重點。
4. WHEN 使用者進入同意步驟，THE Postcard_Builder SHALL 列出將傳送的每張照片縮圖、畫面重點全文與接收服務名稱。同意核取方塊預設不勾選，未勾選前生成按鈕停用。
5. THE Postcard_Generator SHALL 只在使用者按下生成按鈕後送出請求。頁面載入、選照片、勾選同意與返回步驟都不觸發生成。
6. THE Postcard_Generator SHALL 在提示詞中要求只描繪照片與畫面重點中出現的元素，且不加入文字、浮水印或品牌名稱。
7. WHEN Generation_Job 狀態變為 succeeded，THE Postcard_Builder SHALL 顯示預覽並標示「AI 插畫，非精確紀實」。此標示同時出現在預覽與匯出成品上。
8. IF 主照片為 0 張而只輸入畫面重點，THEN THE Postcard_Builder SHALL 在預覽與成品標示「想像插畫」，取代「AI 插畫，非精確紀實」。
9. IF Postcard_Generator 不可用、被 Postcard_AI_Policy 停用、額度用盡，或 Generation_Job 結束於 failed 或 timeout，THEN THE Postcard_Builder SHALL 顯示對應的原因，保留已選照片與畫面重點，並提供進入需求 20 非 AI 流程的按鈕。
10. THE Postcard_Generator SHALL 把 AI 圖像服務金鑰存放在伺服器端金鑰檔，不傳送到瀏覽器。

### Requirement 22: 明信片 email 寄送（E，Phase 4 最後一步，需另行啟用）

**User Story:** 身為旅伴，我希望把完成的明信片寄給朋友，以便分享旅行回憶。

#### Acceptance Criteria

1. WHERE Admin 已啟用 email 寄送（預設關閉），THE Postcard_Builder SHALL 在使用者確認預覽後提供寄送選項。寄送未啟用時，THE Postcard_Builder SHALL 只提供匯出，不顯示寄送選項。
2. THE Postcard_Builder SHALL 讓使用者每次寄送輸入 1 到 5 個收件 email 地址。IF 任一地址格式錯誤或超過 5 個，THEN THE Postcard_Builder SHALL 拒絕送出、指出錯誤的地址，並保留已輸入的內容。
3. THE Mail_Sender SHALL 只寄送使用者已確認的 Postcard 成品，寄送時不重新生成，也不計入 AI 明信片額度。
4. THE Mail_Sender SHALL 以每次寄送請求的冪等鍵防止重複寄送。同一冪等鍵在 24 小時內重送時，回傳原寄送狀態，不再寄出。
5. WHEN 寄送請求在 30 秒內沒有回應，THE Postcard_Builder SHALL 先查詢該寄送的狀態，確認狀態為未寄出或失敗後，才啟用重試按鈕。
6. IF 使用者在 24 小時內的寄送次數已達設計階段訂定的上限，或 email 供應商回應失敗，THEN THE Mail_Sender SHALL 不寄出，並回傳原因；超過次數上限時另回傳可再寄送的時間。Postcard 成品保留可匯出。
7. THE Mail_Sender SHALL 把 email 供應商金鑰存放在伺服器端金鑰檔，不傳送到瀏覽器。

### Requirement 23: AI 明信片開關與額度（F，Phase 4，E 的前置）

**User Story:** 身為 Admin，我希望獨立控制 AI 明信片並設定額度，以便控制成本。

#### Acceptance Criteria

1. THE AI_Control_Panel SHALL 提供 Postcard_AI_Policy 開關，值為 all、admins 或 off，預設為 off。此開關與收據辨識的 `receiptAiPolicy` 分開儲存與顯示，修改其中一個不改變另一個。
2. THE AI_Control_Panel SHALL 讓 Admin 設定每趟旅行生成上限（整數 0 到 100）與全站每月額度（整數 0 到 10,000，單位依供應商實際計費單位定義）。預設數值由使用者確認。IF 輸入值不是整數或超出範圍，THEN THE AI_Control_Panel SHALL 拒絕儲存、指出錯誤欄位，並保留原設定。
3. THE Postcard_Generator SHALL 在伺服器端於每次生成前，依序檢查 Postcard_AI_Policy、使用者權限、每趟上限、每月額度與併發數。併發上限為每位使用者 1 個、全站 2 個進行中的 Generation_Job。
4. IF 任一檢查不通過，THEN THE Postcard_Generator SHALL 拒絕請求，不呼叫 AI 服務，不計入用量，並回傳未通過的檢查項目。項目為每月額度時另回傳下個月額度重置時間；項目為併發數時，另回傳稍後重試的提示。
5. THE Postcard_Generator SHALL 把每次已呼叫 AI 服務的生成（含重新生成，以及結束於 failed 或 timeout 的任務）計入每趟上限與每月額度。未呼叫 AI 服務就被拒絕的請求不計入。
6. THE Postcard_Generator SHALL 以 `Asia/Taipei` 時區的日曆月為每月額度的計算週期，每月 1 日 00:00 重置。
7. THE Postcard_Generator SHALL 把用量記錄在獨立於 `receipt_ai_usage` 的用量紀錄中，旅行刪除後用量紀錄仍保留。
8. THE AI_Control_Panel SHALL 顯示本月 AI 明信片的生成次數、每月額度與剩餘額度。

### Requirement 24: 生成任務狀態與防重複（F，Phase 4）

**User Story:** 身為 Admin，我希望重新整理、連點或逾時重試不會產生重複的付費任務，以便費用可預期。

#### Acceptance Criteria

1. THE Postcard_Generator SHALL 為每次生成建立 Generation_Job。狀態只能是 queued、running、succeeded、failed、timeout 其中之一，且只能依 queued → running → succeeded、failed 或 timeout 的方向轉換。
2. WHEN 同一使用者在 24 小時內以相同冪等鍵重送生成請求，THE Postcard_Generator SHALL 回傳既有 Generation_Job 與其目前狀態，不建立新任務，也不重複計入用量。
3. IF 同一使用者以相同冪等鍵送出不同的照片或畫面重點，THEN THE Postcard_Generator SHALL 拒絕請求，並回傳冪等鍵已被其他內容使用的錯誤。
4. WHILE 使用者已有一個狀態為 queued 或 running 的 Generation_Job，THE Postcard_Generator SHALL 拒絕該使用者的新生成請求，並回傳既有任務的狀態。
5. IF Generation_Job 進入 running 後 180 秒仍未結束，THEN THE Postcard_Generator SHALL 把狀態設為 timeout，且不自動重試。
6. WHEN 瀏覽器等待生成結果逾時，THE Postcard_Builder SHALL 查詢 Generation_Job 狀態，不自動重送生成請求。
7. THE Postcard_Builder SHALL 在送出生成請求後停用生成按鈕，直到 Generation_Job 進入 succeeded、failed 或 timeout。重新整理頁面後，THE Postcard_Builder SHALL 依查詢到的任務狀態決定按鈕是否停用。
8. THE AI_Control_Panel SHALL 為每項 AI 功能列出傳送的資料類型（例如照片、文字）與接收服務名稱。

### Requirement 25: 營位搜尋與空位通知（G，Phase 5，先研究資料來源）

**User Story:** 身為主辦人，我希望依條件搜尋營位並在有空位時收到通知，以便更容易訂到營區。

#### Acceptance Criteria

1. THE Expansion_Plan SHALL 在實作 Campsite_Finder 前交付資料來源研究，逐一列出每個來源的名稱、條款連結、頻率限制與狀態（已查證、待確認、不可行）。
2. IF 研究沒有找到條款允許的穩定資料來源，或使用者未核可研究結論，THEN THE Expansion_Plan SHALL 停止 Campsite_Finder 實作並回報使用者。
3. WHILE 旅行的 `destination` 為空字串，THE Schedule_Tab SHALL 顯示「找營位」情境操作。`destination` 有內容時不顯示此操作。
4. THE Campsite_Finder SHALL 沿用旅行日期，並要求使用者明確填寫營位數或帳數（整數 1 到 20）、地區（必選）、每晚預算上限（新台幣 0 到 100,000 元整數，可留空表示不限）與條件，不以人數推算營位數。IF 必填欄位缺漏或數值超出範圍，THEN THE Campsite_Finder SHALL 不送出查詢並指出錯誤欄位。
5. THE Campsite_Finder SHALL 在每張結果卡片顯示營區名稱、符合的條件、營位、價格與計價單位、資料來源名稱與查詢時間。
6. THE Campsite_Finder SHALL 在結果頁顯示「查到空位不代表已保留」，並只顯示來源實際回傳的空位。IF 查詢結果為 0 筆，或資料來源回應失敗、逾時，THEN THE Campsite_Finder SHALL 分別顯示「沒有符合條件的空位」或「資料來源暫時無法查詢」，並保留已填條件。
7. THE Campsite_Finder SHALL 以連結把使用者導向來源平台，訂位與付款由使用者在來源平台自行完成。
8. WHEN Trip_Manager 輸入訂位確認資訊並儲存，THE Trip_State SHALL 把旅行標記為已訂。地址（最多 200 字）、入住時間與退場時間（`HH:MM`）、訂單編號（最多 50 字）都是選填欄位，格式錯誤時拒絕儲存並指出錯誤欄位。
9. WHERE Availability_Watch 已啟用，THE Campsite_Finder SHALL 依來源允許的頻率查詢，並在查到符合條件的空位時寄送 email 通知。每封通知附取消訂閱連結，使用者點擊後不再寄送該 Availability_Watch 的通知。
10. THE Campsite_Finder SHALL 讓每趟旅行最多同時啟用 3 個 Availability_Watch，並在旅行開始日期當天 00:00（依旅行時區）自動停用該旅行的所有 Availability_Watch。
11. THE Campsite_Finder SHALL 只透過來源允許的方式查詢，不繞過驗證碼、登入限制或頻率限制。
12. THE Campsite_Finder SHALL 不提供自動訂位，自動訂位列為後續候選。

### Requirement 26: 成本與隱私（跨功能）

**User Story:** 身為使用者，我希望知道資料傳給誰、費用怎麼控制，以便安心使用。

#### Acceptance Criteria

1. WHEN 使用者啟動會把資料送到外部服務的操作，THE Trip_View SHALL 在送出任何資料前顯示將傳送的資料類型（例如照片、收據圖片、座標、文字）與接收服務名稱，並在使用者確認後才送出。
2. IF 使用者在確認畫面取消或關閉視窗，THEN THE Server SHALL 不傳送任何資料到外部服務，該操作也不計入任何 AI 額度。
3. THE Server SHALL 只傳送 README 中為該外部服務列出的資料項目，不傳送帳號名稱、email、旅行名稱或旅伴名單（明信片寄送的收件地址除外）。
4. THE Server SHALL 不在日誌中記錄 API 金鑰、照片內容、收據圖片或文字內容、營區座標或 email 地址。
5. THE Server SHALL 為每個付費外部服務提供只有 Admin 能修改的獨立全站開關，各開關的變更不影響其他服務的開關。
6. IF 某付費外部服務的全站開關為關閉，THEN THE Server SHALL 拒絕該服務的請求、不呼叫該服務，並回傳表示功能已停用的錯誤，旅行資料維持不變。
7. THE README SHALL 為每個新增外部服務記錄用途、傳送的資料項目、金鑰設定方式與供應商資料政策連結。

### Requirement 27: 資料變更、遷移與回滾（跨功能）

**User Story:** 身為網站管理員，我希望每次資料格式變更都可備份與回滾，以便升級失敗時能還原。

#### Acceptance Criteria

1. WHEN 新功能的遷移即將變更資料庫結構或 Trip_State 格式，THE Server SHALL 先以 SQLite backup API 建立完整資料庫備份，備份完成後才開始遷移。
2. IF 遷移前的備份建立失敗，THEN THE Server SHALL 中止遷移、不變更資料庫，並回報表示備份失敗的錯誤。
3. IF 遷移在執行中途失敗，THEN THE Server SHALL 撤銷該次遷移的全部變更，讓資料庫維持遷移前的結構與資料，並回報失敗的遷移名稱。
4. THE Server SHALL 讓每個遷移可重複執行：對已遷移的資料庫再次執行時，不新增、不修改、不刪除任何結構或資料，並正常結束。
5. THE Trip_State SHALL 讓新增欄位皆為選填，使新版遷移前建立的每筆 Trip_State 不經修改即通過新版 `isValidState()` 驗證。
6. THE Design_Document SHALL 為每個階段記錄回滾步驟（還原哪份備份、回退哪個程式版本、執行順序），以及回滾後新欄位資料的處理方式（保留不讀取或刪除）。
7. THE Server SHALL 以預設關閉的功能開關隔離 Phase 2 以後的每個功能；WHILE 功能開關為關閉，THE Server SHALL 拒絕該功能的 API 請求，且 Trip_View 不顯示該功能的入口。
8. THE Implementation SHALL 不覆蓋 `dist/`、不重啟執行中的服務、不修改他人工作中的分支，除非使用者明確指示。

### Requirement 28: 權限一致性（跨功能）

**User Story:** 身為主辦人，我希望新功能沿用旅行既有的權限，以便成員能做的事情一致。

#### Acceptance Criteria

1. THE Server SHALL 對照片、明信片、天氣、營位搜尋與帳本的每個 API 請求，在伺服器端驗證登入狀態與旅行成員身分後才讀取或寫入資料。
2. IF 請求者未登入，THEN THE Server SHALL 拒絕請求，不回傳任何旅行資料，也不改變任何資料。
3. IF 請求者已登入但不是該旅行的成員，THEN THE Server SHALL 回應 404，回應內容與旅行不存在時相同，不透露旅行或資源是否存在。
4. IF 新增的寫入請求未通過既有的 Origin 檢查或 CSRF 防護，THEN THE Server SHALL 拒絕請求，且不改變任何資料。
5. IF 非 Admin 帳號嘗試修改 AI_Control_Panel 設定，THEN THE Server SHALL 拒絕請求並保留原設定值。
6. WHEN Admin 修改 AI_Control_Panel 設定，THE Server SHALL 寫入一筆稽核紀錄，包含修改者、修改時間、設定項目、修改前與修改後的值。
7. THE Memories_Page SHALL 只顯示給該旅行的 Trip_Member 與 Trip_Manager，分享用內容（候選 22）在使用者確認前不提供。

### Requirement 29: 測試與驗證（跨功能）

**User Story:** 身為開發者，我希望每個階段有完整的自動化測試，以便新功能不破壞既有功能。

#### Acceptance Criteria

1. THE Test_Suite SHALL 以 fast-check 驗證需求 4.4 的不重複計帳不變式與 Receipt_Group 分組結果，每個屬性至少執行 100 組隨機產生的 Ledger，且包含零筆支出、只有手動支出、只有收據支出與混合四種情況。
2. THE Test_Suite SHALL 以 Playwright 在 360 CSS 像素寬的手機視窗與 1280 CSS 像素寬的桌機視窗，驗證每個新功能的預設顯示與展開顯示。
3. THE Test_Suite SHALL 驗證每個新增互動元件可用 Tab 取得焦點並以 Enter 與空白鍵啟動、具有無障礙名稱、展開型控制項具有正確的 `aria-expanded` 值，且 Touch_Target 至少 44 × 44 CSS 像素。
4. THE Test_Suite SHALL 以模擬服務涵蓋每個外部服務的成功、失敗、逾時與停用四種情境，測試執行期間不呼叫任何真實外部服務。
5. THE Test_Suite SHALL 為每個新增 API 涵蓋非成員、受邀旅伴、主辦人與 Admin 四種身分的權限情境，並驗證需求 28 的回應結果。
6. THE Test_Suite SHALL 只在隔離環境（記憶體資料庫、合成帳號、埠 5181）執行，不連到實際資料庫或執行中的伺服器。
7. WHEN 一個階段的實作完成，THE Verification_Process SHALL 執行既有的 `bun test` 與 Playwright 測試套件，並逐一列出每個未通過或未執行的測試名稱與原因。
8. IF 任一測試未通過或未執行，THEN THE Verification_Process SHALL 將該階段標示為未完成，直到測試通過或使用者書面接受該例外。
9. WHEN 一個階段修改 2 個以上的檔案，THE Verification_Process SHALL 安排非該階段實作者進行審查，並記錄審查結果。

### Requirement 30: 排除範圍（全部階段）

**User Story:** 身為產品負責人，我希望明確列出不做的功能，以便第一版範圍不會擴大。

#### Acceptance Criteria

1. THE First_Release SHALL 不包含排除表 X1–X6 的功能（雨備方案、個人常備裝備櫃與精簡提醒、裝備重量體積與各車載重估算、採買冷鏈分組與冰桶估算、採買預估金額與預算對照、年度回顧與統計），也不提供這些功能的介面入口、API 或資料欄位。
2. THE Expansion_Plan SHALL 把候選功能 1–25 排除在所有階段之外，直到使用者逐項書面確認。
3. WHEN 使用者確認某一候選功能，THE Expansion_Plan SHALL 在實作前為該功能指定階段並新增對應的需求條款。
4. THE Expansion_Plan SHALL 把全自動營位訂位與任何繞過驗證碼、登入限制或頻率限制的自動化排除在所有階段之外。
