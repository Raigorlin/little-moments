# Implementation Plan: 行程表改版（行程圖與規劃行程）

## Overview

依設計文件以 JavaScript（ES modules，不轉譯；Bun 1.4.4 執行建置與 `bun test`）實作。工作依下列順序推進，每一段結束時以檢查點執行測試：

1. 不碰 DOM 的規則模組（任務 1 至 5）：資料規則與驗證、每日模型與採買推導、規劃提醒、Itinerary_Text、旅行日期變更與卡片編輯，以 `bun test` 驗證。
2. 伺服器（任務 7）：`cleanState()` 保留新欄位、`PUT` 補回缺少的欄位、`guardCollaborator()` 不再禁止移除活動、旅行卡片與匯入的目的地檢查與日期平移。
3. 規劃行程（任務 9）：`src/itinerary-editor.js` 與 `src/app.js` 的 `planner`、Draft、卡片、儲存、刪除、離開確認與權限。
4. 行程圖（任務 11）：插圖、`posterHtml()`、路線圖版面、動畫、Motion_Toggle、Text_Panel 與列印。
5. 既有畫面（任務 13）：Vehicle_Dialog、刪除車輛、Trip_Menu 車輛卡片、Trip_Settings_Dialog、料理菜單與採買清單分頁。
6. 無障礙與版面（任務 15）。
7. README（任務 16）。
8. 需求 23.11 列出的 Changed_Test（任務 17）。

實作注意事項：

- 屬性測試使用已在 devDependencies 的 `fast-check@4.10.2`，每個屬性 `numRuns` 至少 100（Property 9 與 Property 11 為 200），並以 `// Feature: trip-planning-workflow-enhance, Property N: <標題>` 標記。
- 為了讓測試任務可以平行執行，設計文件「Testing Strategy」中合併的測試檔在本計畫中拆分：每個屬性一個測試檔，Playwright 測試依主題分檔，屬性與測試內容不變。範例測試仍放在設計文件指定的檔案。
- 指令依 README「測試」一節：先 `bun run build`；單元測試 bash 為 `bun test tests/*.test.js`、PowerShell 為 `bun test ./tests/`，需要 Ephemeral_Database 與 `CAMPING_TEST_DATABASE_*`；只跑特定檔案時明列檔名，例如 `bun test tests/itinerary-valid.test.js`；瀏覽器測試為 `node scripts/check-accounts.mjs [檔案…]`，需要 `CHROME_PATH` 與 `CAMPING_BUN`；安全測試為 `bun scripts/security-suite.mjs`。
- 任務 9.1 先以 `itineraryText()` 的純文字暫時佔用行程圖的位置，任務 11.8 換成 `posterHtml()`，Text_Panel 在任務 11.13 加入。
- 需求 23.11 的 Changed_Test 依賴需求 1.6 與 3.7 移除的介面，在任務 17 修改之前預期失敗。任務 10、12、14 的檢查點只要求其餘測試通過，並確認失敗都屬於這一類。
- 本功能不新增相依套件、不修改 CSP、不需要資料庫遷移。

## Tasks

- [x] 1. 資料規則與驗證（`src/itinerary-model.js`、`src/model.js`）
  - [x] 1.1 建立 `src/itinerary-model.js` 的常數、文字與日期規則
    - 匯出 `DESTINATION_REF`（`'@destination'`）、`CAR_PALETTE`（依序為設計「插圖與顏色」中 `car-0` 至 `car-7` 的 8 個色碼，以 `Object.freeze()` 凍結）、`CAR_COLOR_COUNT`（`CAR_PALETTE.length`，即 8）、`LIMITS`、依前言「活動類別」表順序的 `ACTIVITY_CATEGORIES`（沿用 `meet`、`market`、`camp`、`meal`、`night`、`travel`，新增 `wake`、`pitch`、`free`、`tea`、`strike`、`clean`、`return`）、`ACTIVITY_TYPES`、`categoryLabel()`、`ACTIVITY_PRESETS`、`presetsFor(dayKind)`、`STOP_KINDS`（`shop`、`pickup`、`gear`、`other`）與 `MEAL_DEFAULT_TIMES`
    - `presetsFor('single')` 依序合併 First_Day 與 Last_Day 的建議，類別相同時保留表中較前面的一筆，再依預設時間排序
    - 實作 `trimWhite()`、`charCount()`、`hasControlChars()`（與 `src/model.js` 的 `addParticipant()` 使用相同的 emoji 零寬連接符例外）、`placeKey()`（只對 U+3000 與 U+FF01 至 U+FFEE 逐字套用 NFKC，整串 NFC，A 到 Z 轉小寫）、`placeNameError()`（依 `empty`、`long`、`control`、`duplicate` 的順序回傳第一個原因，比較時排除 `exceptId` 並加入 Draft 的 `pending` 名稱）與四則錯誤訊息、`cleanText()`（需求 14.16）、`normalizeTimeInput()`（全形數字與冒號轉半形後必須是 `HH:MM`，只填一部分視為錯誤）
    - 實作 `chineseNumeral()`、`durationText()`、`monthDay()`、`weekdayChar()`、`dateText()`（星期以 `Date.UTC()` 計算，不使用 `toLocaleDateString()`），以及 `mealTime()`、`mealLabel()`、`mealTitle()`
    - 本模組不匯入 `src/model.js`，避免與 `isValidState()` 循環匯入
    - _Requirements: 2.1, 2.2, 3.13, 4.9, 5.10, 7.2, 7.9, 8.2, 8.5, 8.6, 8.11, 11.13, 14.2, 14.5, 14.16, 14.19, 設計：擴充點_

  - [x] 1.2 撰寫 Property 15 的 property test（`tests/itinerary-place-name.test.js`）
    - **Property 15: 地點名稱的同名比較與錯誤原因**
    - **Validates: Requirements 2.1, 2.2**

  - [x] 1.3 撰寫 Property 16 的 property test（`tests/itinerary-time-input.test.js`）
    - **Property 16: 時間欄位的正規化**
    - **Validates: Requirements 4.9, 5.10, 7.10, 8.11, 18.3**

  - [x] 1.4 撰寫 Property 17 的 property test（`tests/itinerary-numerals.test.js`）
    - **Property 17: 中文數字與天數文字**
    - 以測試中獨立撰寫的解析函式解析 `chineseNumeral()` 的結果
    - **Validates: Requirements 3.13, 11.13, 14.2**

  - [x] 1.5 實作 `validateItinerary()`、`destinationConflict()`，並改寫 `isValidState()`
    - `validateItinerary(state, dates)` 依設計「`validateItinerary(state, dates)`」表檢查 `places`、`routes`（含 `stops`）、`daySettings` 與 `meals[].time`；欄位缺少時視為空清單
    - `destinationConflict(state, destination)` 回傳 `{ type: 'duplicate', name }`、`{ type: 'in-use' }` 或 `null`
    - `src/model.js` 的 `isValidState()`：活動類型改用 `ACTIVITY_TYPES.includes(a.type)`，既有檢查之後以 `dateRange()` 的結果呼叫 `validateItinerary()`；其他既有規則不變，`seed()`、`emptyState()` 與本功能之前的備份不經修改即通過
    - _Requirements: 2.1, 2.9, 2.10, 6.1, 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.12_

  - [x] 1.6 建立 Example_Trip 固定資料
    - 新增 `tests/fixtures/example-trip.js`，匯出 `exampleTrip()` 與 `EXAMPLE_TEXT`，資料依需求文件「範例行程與預期文字版」與設計「Example_Trip 固定資料」（第 3 天最後一筆活動的標題是「四車集合、返程」）；產生時先執行一次 `syncMealIngredients()`，讓本機版載入時的食材同步不再改變資料
    - `EXAMPLE_TEXT` 與需求文件的 Example_Text 逐字相同（LF 分行，最後一行之後沒有換行字元）；`isValidState(exampleTrip())` 為 true
    - `tests/local-planner-fixture.js` 新增把 `exampleTrip()` 寫入本機版 localStorage 的 fixture，既有的 `test` 行為不變
    - _Requirements: 14.17, 23.1, 23.6, 23.15_

  - [x] 1.7 建立屬性測試產生器（`tests/support/itinerary-arb.js`）
    - `itineraryState()` 的值域依需求 23.3 與設計「Testing Strategy」的產生器說明，另有地點達 100 個的變體；車名、活動標題與料理名稱彼此不同；路線的終點隨機選取，所以同一個路線區塊也會有多個終點組
    - `legacyState()`（需求 23.4 第一部分的舊欄位修改）、`faultyState()`（需求 23.4 列出的每一種錯誤各一個變體）與 `markupText()`
    - `blockShape()`：Property 18 用的路線區塊，形狀與 `dayModel()` 的路線區塊相同（`lines` 與 `ends`）：1 到 200 條路線、每條 0 到 6 個 Stop，出發時間形成 1 到 200 組（含沒有出發時間的組），終點形成 1 到 4 個以任意順序交錯的終點組；`ends` 由產生器自行依各終點第一次出現的順序組成，不匯入 `src/itinerary-derive.js`
    - `endMixState()`：Property 22 與 23 用的 Trip_State，至少一天的同一個路線區塊有 1 到 12 條路線、每條 0 到 6 個 Stop（每台車每天最多一條路線，所以車輛數隨路線數增加），終點從 1 到 4 個地點中隨機選取；涵蓋同一組的路線之間夾著其他組的路線（例如台北、新竹、台北）、只有一條路線的組、全部同一組、各組彼此相連，以及 First_Day 的舊出發資料
    - _Requirements: 23.3, 23.4_

  - [x] 1.8 撰寫 Property 1 的 property test（`tests/itinerary-valid.test.js`）
    - **Property 1: 產生的 Trip_State 通過驗證，JSON 往返不變**
    - **Validates: Requirements 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.13, 23.3**

  - [x] 1.9 撰寫 Property 3 的 property test（`tests/itinerary-invalid.test.js`）
    - **Property 3: 單一錯誤一定被驗證拒絕**
    - 需求 23.4 列出的每一種錯誤都至少出現一次
    - **Validates: Requirements 2.1, 6.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 23.4**

  - [x] 1.10 撰寫資料規則的範例測試（`tests/itinerary-model.test.js`、`tests/model.test.js`）
    - 13 個類別與標籤、四種日子的常用活動（含一日遊）、`mealTime()`、`mealLabel()` 與 `mealTitle()` 的前言範例、`hasControlChars()` 與 `addParticipant()` 對同一組字串的判斷相同、`destinationConflict()` 的三種結果
    - `tests/model.test.js`：7 種新活動類型有效，未知類型與空字串無效；`exampleTrip()` 有效
    - _Requirements: 2.9, 2.10, 7.2, 7.9, 8.2, 8.5, 8.6, 18.2_

- [x] 2. 每日模型、採買推導與規劃提醒（`src/itinerary-derive.js`）
  - [x] 2.1 實作地點、路線、舊出發資料與採買推導
    - `tripDays()`（`kind` 為 `first`、`middle`、`last` 或 `single`）、`placeLabel()`、`dayLocation()`（D17）、`sortedRoutes()`（需求 5.2）、`legacyDepartures()`（First_Day 沒有路線且 `meeting` 有內容的車，以 `parseVehicleMeeting()` 拆解，依需求 19.4 排序）
    - `shoppingPlan(state)` 回傳 `buyerCar`、`firstStop`、`stopItems`、`unassigned`（含 `code` 與 `reason`）與 `locationOf`，依需求 6.11 的 (a) 至 (d) 與 D28、D29、D30；`shoppingSummary(items)` 依需求 6.9
    - `firstDayDeparture()`、`placeUsages()`、`placeRouteCounts()`、`vehicleRouteDays()` 與 `carColorIndex()`
    - 所有函式只讀取輸入，不修改 Trip_State，也不新增、移除或改變採買品項
    - _Requirements: 2.4, 2.6, 2.7, 3.2, 3.5, 3.8, 3.9, 5.2, 6.9, 6.10, 6.11, 6.12, 11.12, 18.1, 19.3, 19.4, 19.7, 19.10, 22.6_

  - [x] 2.2 實作 `dayModel()` 與 `endGroups()`
    - 依設計「`dayModel()` 的回傳值」與規則對照表產生 `heading`、`location`、`arrival`、`arrivalRoutes`、`otherRoutes`、`legacy`、`meetingCount`、`blocks`（Day_Sequence）、`caption`（Day_Caption）與 `showLocationLine`
    - `endGroups(lines)` 依設計「`endGroups(lines)`」：由前往後走一次路線區塊的 `lines`（已依需求 5.2 排序），遇到還沒有組的 `to` 就在最後新增一組，再把索引加入該組，回傳 `[{ ref, lines: [i] }]`（`ref` 為 Route 的 `to`，索引由小到大）；`type: 'legacy'` 的行沒有終點，不屬於任何組；結果只由 `lines` 決定，不讀取其他資料，也不修改輸入
    - 路線區塊的 `ends` 由 `endGroups(lines)` 組成，每個終點組一項 `{ ref, name, endKind, count, lines }`，順序相同：`endKind` 為 `camp`（終點是 Day_Location）、`house`（Last_Day 中不是 Day_Location 的終點）或 `landmark`（其他終點），`count` 是組內的路線數，`lines` 是組內路線在區塊 `lines` 中的索引；返程行的終點清單因此等於 `ends` 中 `house` 項目的名稱，順序相同；行程圖（任務 11.4）只依 `ends` 畫道路、終點插畫與停車位，不必自己判斷終點種類，也不另外分組
    - 路線行的 Stop 帶入 `shoppingPlan()` 的品項與 Shopping_Summary；活動項目帶入 `extras` 與完成狀態；餐點項目帶入 `mealTime()`、`mealTitle()`、`mealLabel()`、`parseIngredients()` 的食材與 `inferDishKind()`
    - 到達行與返程行依需求 14.11、14.12；`plan` 參數預設為 `shoppingPlan(state)`，讓呼叫端每次繪製只計算一次
    - _Requirements: 3.13, 7.1, 8.1, 8.2, 8.5, 8.6, 8.7, 8.13, 11.2, 11.3, 11.4, 11.5, 11.6, 11.10, 12.10, 14.8, 14.11, 14.12, 14.13, 14.14, 19.2, 19.3, 設計：擴充點_

  - [x] 2.3 撰寫 Property 6 的 property test（`tests/itinerary-day-sequence.test.js`）
    - **Property 6: Day_Sequence 的排列規則**
    - **Validates: Requirements 5.2, 7.1, 8.2, 11.4, 14.8, 14.13**

  - [x] 2.4 實作 `planningWarnings()`
    - 依需求 9.1 至 9.5 的條文順序與 9.6 的排序規則回傳 `Map<date, string[]>`；只讀取已儲存的 Trip_State，不寫入任何資料
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.9_

  - [x] 2.5 撰寫 Property 12 的 property test（`tests/itinerary-warnings.test.js`）
    - **Property 12: 規劃提醒依規則產生**
    - 在測試中依需求 9.1 至 9.5 直接撰寫參考實作，比對文字與順序
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6**

  - [x] 2.6 撰寫推導模組的範例測試（`tests/itinerary-derive.test.js`）
    - Example_Trip：三天的 Day_Caption、第 3 天的「地點：」行、`placeRouteCounts()` 為夕淞度日營區 8、台北 4、超市／賣場 1、八個品項都在第三車・採買組的 First_Shopping_Stop、每天都沒有 Planning_Warning
    - `placeUsages()` 的列出格式；`firstDayDeparture()` 的三種結果（含 `seed()` 的山線小巴）；需求 9.1、9.2、9.5 的範例提醒；需求 6.11 的「待分配」範例
    - 終點組：Example_Trip 每個路線區塊都只有一個終點組（第 1 天為夕淞度日營區的 4 條路線，第 3 天為台北的 4 條路線）；第一車往台北、第二車往新竹、第三車往台北的 Last_Day 區塊依序得到台北（第 1、3 條，`lines` 為 `[0, 2]`）與新竹（第 2 條，`[1]`）兩組，`endKind` 都是 `house`，返程行為「平安返回台北、新竹・不預估返抵時間」
    - _Requirements: 2.7, 3.2, 3.8, 6.11, 9.1, 9.2, 9.5, 11.2, 11.3, 11.5, 11.6, 12.10, 14.12_

  - [x] 2.7 撰寫 Property 22 的 property test（`tests/itinerary-end-groups.test.js`）
    - **Property 22: 終點組的推導**
    - 以 `endMixState()` 產生，檢查每一天 `dayModel()` 的每個路線區塊，並對同一個 `lines` 與它的深拷貝各執行兩次 `endGroups()`
    - **Validates: Requirements 11.5, 11.6, 12.10, 14.12**

- [x] 3. 文字版（`src/itinerary-text.js`）
  - [x] 3.1 實作 `itineraryText()` 與共用的文字片段
    - 依設計「`src/itinerary-text.js`」以 `'\n\n'` 連接標題行、旅行介紹段落、車輛行與每一天的段落，沒有內容的部分不放入；每個區塊前一個空行；有補充行且不是區塊最後一個項目時接一個空行
    - 匯出 `routeLineText()`、`stopText()` 與 `momentLines()`，讓行程圖使用相同的文字片段
    - 固定字元寫成原始碼常數（U+FF5C、U+30FB、U+FF1A、U+FF08 與 U+FF09、U+3001、前後各一個半形空白的「 → 」）；使用者文字一律經 `cleanText()`，不做 HTML 跳脫；不輸出旅行小叮嚀、Planning_Warning、完成狀態、主廚、份數與料理筆記
    - _Requirements: 6.9, 8.1, 8.7, 8.13, 9.10, 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 14.10, 14.11, 14.12, 14.13, 14.14, 14.15, 14.16, 14.17, 14.18, 14.19, 19.2, 19.10_

  - [x] 3.2 撰寫 Property 4 的 property test（`tests/itinerary-text-lines.test.js`）
    - **Property 4: 文字版的項目行與資料一一對應**
    - **Validates: Requirements 8.1, 8.2, 8.7, 14.9, 14.13, 14.15, 14.18, 19.2, 19.3, 19.7, 19.10, 23.3**

  - [x] 3.3 撰寫 Property 5 的 property test（`tests/itinerary-text-format.test.js`）
    - **Property 5: 文字版的格式固定，且只由資料決定**
    - 先確認切換 `process.env.TZ` 確實改變 `new Date(0).getTimezoneOffset()`；執行環境不支援時，改以 `Bun.spawn` 在三個時區的子行程執行同一段檢查
    - **Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.11, 14.12, 14.14, 14.16, 14.18, 23.1, 23.3**

  - [x] 3.4 撰寫文字版的範例測試（`tests/itinerary-text.test.js`）
    - Example_Trip 的 `itineraryText()` 在 `Etc/UTC`、`Asia/Taipei` 與 `America/Los_Angeles` 下都與 `EXAMPLE_TEXT` 逐字相同（比較整個字串，不修剪空白）
    - 需求 23.2 的兩種修改：刪除第 1 天第四車的路線；把八個品項的「誰負責買」改為小安。各自比對文字差異、Planning_Warning 與 Unassigned_Shopping 的原因
    - 需求 14.10 的 Stop 文字組合、需求 14.19 的固定字元碼位、需求 19.10 的舊出發行
    - _Requirements: 6.8, 6.11, 9.1, 9.5, 14.10, 14.17, 14.19, 19.10, 23.1, 23.2_

- [x] 4. 旅行日期變更（`src/itinerary-dates.js`）
  - [x] 4.1 實作 `retimeByDayIndex()` 與 `shiftByOffset()`
    - `retimeByDayIndex(state, startDate, endDate)`：Route 與 Day_Settings 維持第 N 天，Activity 與 Meal 依既有規則改到第 `min(N, 新天數)` 天，並更新 `trip.startDate` 與 `trip.endDate`；被移除的日子有 Route、Day_Title 或已設定的 Day_Location 時回傳 `{ ok: false, blocked }`，只有 Arrival_Time 的直接捨棄
    - `shiftByOffset(state, startDate, endDate)`：依「新開始日減舊開始日」平移 Activity、Meal、Route 與 Day_Settings；放不下時回傳依「活動、餐點、路線、每日設定」排列的 `categories`；平移後超出範圍且只有 Arrival_Time 的 Day_Settings 捨棄
    - 兩者都不改變識別碼、車輛、起點、出發時間、Stop、終點、Day_Title、Day_Location、Arrival_Time、`meeting` 與採買品項，也不修改輸入
    - 匯出兩種錯誤訊息的組成函式：Trip_Settings_Dialog 的「縮短天數前，請先處理：第 4 天（10/23）的路線、…。刪除這些路線、清除這些每日設定後，才能縮短天數。」與伺服器的「新日期範圍放不下既有的{類別}，請先調整行程或延長日期。」
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7_

  - [x] 4.2 撰寫 Property 13 的 property test（`tests/itinerary-retime.test.js`）
    - **Property 13: Trip_Settings_Dialog 的日期變更維持第 N 天**
    - **Validates: Requirements 20.1, 20.2, 20.5, 20.6, 20.7, 23.5**

  - [x] 4.3 撰寫 Property 14 的 property test（`tests/itinerary-shift.test.js`）
    - **Property 14: 伺服器的日期平移一致**
    - **Validates: Requirements 20.3, 20.4, 20.5, 20.7, 23.5**

  - [x] 4.4 撰寫日期變更的範例測試（`tests/itinerary-dates.test.js`）
    - 需求 20.2 的訊息依天數列出第 N 天與原日期，並標明「路線」「每日設定」或「路線與每日設定」；需求 20.4 的類別訊息
    - _Requirements: 20.2, 20.4_

- [x] 5. 卡片編輯（`src/itinerary-edits.js`）
  - [x] 5.1 實作地點、每日設定、路線與舊出發資料的編輯
    - `savePlace()`、`deletePlace()`、`saveDaySettings()`、`saveArrival()`、`saveRoute()`、`deleteRoute()` 與 `clearLegacy()`：成功時回傳 `{ ok: true, state, message, focus }`，失敗時回傳 `{ ok: false, errors: [{ field, message }], formError, usages }`，規則依設計「各操作的規則」表；`ctx.uid` 讓測試使用可重現的識別碼
    - Route Draft 的形狀，以及 `routeDraft()`、`newRouteDraft()`（需求 5.6 的預設值）、`legacyRouteDraft()`（需求 19.11）與 `previewState()`（套用 Draft、不驗證，允許未選地點的 Stop，只供品項預覽）
    - `saveRoute()`：保留 Route 與既有 Stop 的識別碼；Stop 依 Draft 的順序；採買 Stop 不寫 `note`；只把仍被選取的 Draft 新地點依加入順序加入 Place_List，並把 `new:{k}` 換成新的識別碼；First_Day 的路線把該車的 `meeting` 設為 `''`
    - 每個成功的操作先以 `isValidState()` 驗證，未通過時回傳 `formError`「資料驗證未通過，沒有儲存。請重新載入後再試。」；只改變目標項目與上述連帶變更，其他集合的每個項目以相同的識別碼留在原位；`message` 包含動作與對象，例如「已儲存第三車・採買組第 1 天的路線」
    - _Requirements: 2.2, 2.5, 2.7, 2.8, 2.11, 3.4, 4.9, 4.10, 4.13, 5.6, 5.9, 5.10, 5.11, 6.1, 6.4, 6.13, 10.4, 10.7, 10.8, 10.10, 16.8, 18.15, 19.5, 19.6, 19.11, 21.8_

  - [x] 5.2 撰寫 Property 10 的 property test（`tests/itinerary-preview.test.js`）
    - **Property 10: 品項預覽與儲存後的結果相同**
    - **Validates: Requirements 6.6**

  - [x] 5.3 實作活動、餐點時間、車輛與料理的編輯
    - `saveActivity()`（「全體旅伴」寫入 `people: []` 並移除 `vehicleIds`；「指定車輛」依車輛順序寫入 `vehicleIds`；「保留原旅伴名單」不改 `people`；`done` 不變；日期可以改到其他天）、`addPresets()`、`deleteActivity()`、`setActivityDone()` 與 `saveMealTime()`（空白時移除 `time`）；新增會讓活動超過 1,000 筆時回傳 `formError`
    - 匯出 `activityDraft(state, activityId)`：回傳與 Activity 卡片相同的 Draft（標題、日期、時間、類別、參加方式與指定的車輛、地點、備註），任務 9.6 展開 Activity 卡片時以它建立 Draft
    - 把 `src/app.js` 表單送出時對 Vehicle 與 Meal 的修改抽成 `saveVehicle(state, values, ctx)`（既有的座位與乘客檢查，既有車輛的 `meeting` 不變，新車輛為 `''`）與 `saveMeal(state, values, ctx)`（既有的欄位檢查、餐次改變時刪除 `time`、套用範本時保留、`syncMealIngredients()`）；`src/app.js` 在任務 13 改用這兩個函式
    - _Requirements: 3.7, 7.4, 7.5, 7.6, 7.7, 7.8, 7.10, 7.11, 7.12, 8.3, 8.4, 8.11, 18.15, 21.8, 設計：擴充點_

  - [x] 5.4 撰寫 Property 11 的 property test（`tests/itinerary-edit-ops.test.js`）
    - **Property 11: 編輯操作只改變目標並維持有效**
    - 在測試檔中定義 `editOp()`，`numRuns` 為 200
    - **Validates: Requirements 2.7, 2.11, 4.10, 4.13, 5.9, 5.10, 5.11, 6.4, 6.13, 7.4, 7.7, 7.10, 7.12, 8.3, 10.10, 18.15, 19.5, 21.8**

  - [x] 5.5 撰寫 Property 9 的 property test（`tests/itinerary-shopping.test.js`）
    - **Property 9: 採買推導的分割與摘要**
    - 在測試檔中定義 `shoppingOp()`，以 `saveRoute()`、`deleteRoute()`、`saveVehicle()`、`saveMeal()`、`assignShopping()` 與 `syncMealIngredients()` 套用 1 到 10 個操作，`numRuns` 為 200
    - **Validates: Requirements 6.9, 6.10, 6.11, 6.12, 23.14**

  - [x] 5.6 撰寫編輯模組的範例測試（`tests/itinerary-edits.test.js`）
    - 每一種錯誤的 `field` 與訊息；`legacyRouteDraft()` 的四種情況（同名地點、新增地點、名稱不合規、已有 100 個地點）；`saveMeal()` 改餐次時清除時間、套用範本時保留；`saveVehicle()` 保留 `meeting`
    - _Requirements: 2.2, 2.8, 3.7, 5.9, 6.13, 7.10, 8.4, 19.11_

- [x] 6. Checkpoint - 規則模組
  - 執行 `bun run build`，再依 README「測試」一節執行完整單元測試（bash `bun test tests/*.test.js`，PowerShell `bun test ./tests/`），全部通過。這一段沒有修改畫面與伺服器，既有測試不應有任何失敗。Ensure all tests pass, ask the user if questions arise.

- [x] 7. 伺服器（`server/accounts.js`）
  - [x] 7.1 `cleanState()` 保留新欄位，`PUT /api/trips/:id` 補回缺少的欄位
    - `cleanState()`：只在輸入有 `places`、`routes` 或 `daySettings` 鍵時輸出對應的鍵；`places` 保留 `id`、`name`；`routes` 保留 `id`、`date`、`vehicleId`、`from`、`to`，選填 `time`、`stops`，Stop 保留 `id`、`place`、`kind`，選填 `note`；`daySettings` 保留 `date`，選填 `title`、`place`、`arrival`；`meals` 的選填欄位加上 `time`；其他未定義的欄位丟棄
    - `putTrip()`：在 `cleanState()` 之後、`isValidState()` 之前，`body.state` 沒有 `places`、`routes` 或 `daySettings` 鍵時以 `structuredClone(stored[key])` 補回（伺服器上也沒有時維持缺少，`null` 與空陣列不算缺少）；之後的驗證、綁定帳號旅伴的檢查、`guardCollaborator()` 與 `persist()` 都使用補回後的 Trip_State
    - 確認勾選、加入旅行等其他寫入 API 讀回 `state_json` 後只改動自己的欄位，新欄位原樣保留
    - _Requirements: 18.9, 18.10, 18.11_

  - [x] 7.2 受邀旅伴可以移除活動、地點、路線與途中任務
    - `guardCollaborator()` 以識別碼比對移除的集合改為 `['people', 'meals', 'gear', 'vehicles']`，不把 `places`、`routes`、`daySettings` 加入比對；改標料理食材、綁定帳號旅伴與行前準備的檢查、`guardShoppingRemoval()` 與 `DENY_REMOVAL` 訊息不變；更新函式上方的註解
    - `tripAccess()`、Origin、`Sec-Fetch-Site` 與 Content-Type 的既有檢查不變
    - _Requirements: 21.3, 21.4, 21.5, 21.7_

  - [x] 7.3 旅行卡片與匯入時的目的地檢查與日期平移
    - `applyCardToState()`（`PATCH /api/trips/:id` 與 `POST /api/trips` 的匯入都經過）依序：`destinationConflict(state, card.destination)` 為 `duplicate` 時回應 400「旅行目的地與地點清單中的地點同名，請先把該地點改名。」，為 `in-use` 時回應 400「仍有路線或停靠點使用旅行目的地，不能把目的地清空。」；再以 `shiftByOffset()` 平移，失敗時回應 400 與任務 4.1 的類別訊息；最後才設定 `state.trip`
    - 這三種錯誤都在 `isValidState()` 之前回應；`PATCH` 失敗時旅行維持原本的日期、內容與版本號，`POST` 不建立旅行
    - _Requirements: 2.10, 18.10, 20.3, 20.4, 20.5, 20.7_

  - [x] 7.4 撰寫伺服器的 API 測試（`tests/itinerary-accounts.test.js`）
    - 比照 `tests/vehicle-itinerary.test.js`，以 `createAccountService()` 與 `tests/support/pg.js` 的 `useTestDatabase`、`resetTables`、`serviceDb` 執行
    - 需求 23.13：保存新欄位；需求 23.4 的每一種無效資料以 `PUT` 送出時回應 400，且 `trip.revision` 與 `state` 不變；缺少欄位時保留伺服器的值，空的 Day_Settings 清單存為空清單；`PATCH` 與日期不同於 `legacyState` 的 `POST` 平移的天數與 Activity、Meal 相同，放不下時回應 400 且不寫入；需求 2.10 的兩種訊息
    - 需求 23.8 的 `bun test` 部分：受邀旅伴移除 Activity、Place、Route、Stop 回應 200，之後 `GET` 不再包含；移除沒有綁定帳號的旅伴、料理、裝備、車輛或採買品項回應 403，且 `trip.revision` 與 `state` 不變；改標料理食材回應 403；修改 Day_Settings、「誰負責買」、駕駛與乘客，以及清除 `meeting` 回應 200；非成員的 `GET` 與 `PUT` 回應 404
    - _Requirements: 2.10, 18.9, 18.10, 18.11, 20.3, 20.4, 21.3, 21.4, 21.5, 21.7, 23.8, 23.13_

- [x] 8. Checkpoint - 伺服器
  - 執行 `bun run build` 與完整單元測試，全部通過。`tests/accounts.test.js` 的「members cannot remove existing items through whole-state PUT; owners can」由任務 17.8 修改（受邀旅伴移除 Activity 改為允許，需求 21.7）；17.8 尚未完成時，只有這個測試可以失敗。Ensure all tests pass, ask the user if questions arise.

- [x] 9. 規劃行程（Itinerary_Editor）
  - [x] 9.1 行程表分頁的骨架與檢視切換（`src/app.js`）
    - 以 `scheduleTab()` 取代 `schedule()`：Editor_User（本機版與 `canEdit` 的帳號）在分頁最上方有 View_Switch（「行程圖」「規劃行程」，`data-plan-nav="view"`，以 `aria-pressed` 標示目前檢視；啟動未選取的選項時切換並把焦點留在該選項，啟動已選取的選項時不改變畫面）；Viewer 只有行程圖，`planner.view` 不會是 `editor`
    - 行程圖的位置暫時以 `<pre>` 顯示 `escape(itineraryText(state))`，之後接結尾小語「好日子，不用急。」，任務 11.8 換成 `posterHtml()`；規劃行程的位置暫時是空白區塊，任務 9.6 接上 `editorHtml()`
    - 新增模組層的 `planner` 物件（設計「`planner` 狀態」），頁面載入時 `view` 為 `poster`
    - 移除 Schedule_Bar、`vehicleDepartureSection()`、`vehicleScheduleFilter()`、`.schedule-intro`、`.timeline`、`scheduleVehicle`、`types`、`activityParticipationFields()`、`updateActivityParticipation()`、活動對話框（`editForm('activity')` 與 `actions.activity`）、`data-day` 的點擊處理、`#schedule-vehicle` 的 change 處理，以及因此不再使用的匯入；`day` 只保留給料理對話框的預設日期；出發模式（`#/go`）與 5 個主分頁不變
    - `render()` 的焦點還原順序改為 `planner.focus`（用完清空）、目前焦點元素的 `data-focus`、`deferredFocus`；把 `.date-tabs` 中選取的按鈕捲進可視範圍時，不再限制在 760 CSS 像素以下
    - `icons` 新增 `up`、`down`、`copy`、`route`、`stop` 與 `warning`，沿用 24×24 viewBox、1.7 線寬的畫法
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 1.6, 1.7, 1.10, 4.3, 17.7, 21.1_

  - [x] 9.2 `editorHtml()` 的外框、Places_And_Cars 與每日區塊（`src/itinerary-editor.js`）
    - 新增 `src/itinerary-editor.js`，匯出只產生 HTML 字串的 `editorHtml(state, planner, ctx)`；`ctx` 傳入 `icon`、`mapLink`、`plan`、每一天的 `dayModel()`、`planningWarnings()` 的結果、`canDeleteVehicle` 與 `accountSaving`
    - `id`、`for`、`aria-controls` 與 `aria-describedby` 由內部計數器產生（`plan-1`、`plan-2`…），只有 `data-focus` 與 `data-id` 放識別碼；所有使用者值只經 `escape()` 恰好一次寫入文字或允許的屬性；只使用原生的按鈕、連結與表單控制項，不使用 `data-swipe-row`（D9）
    - 依設計「畫面順序」第 1 至 6 列輸出：Places_And_Cars（收起時「地點與車」與「{P} 個地點・{V} 台車」；展開時旅行目的地列或「還沒有旅行目的地」、每個 Place 的「{N} 條路線」「改名 {地點}」「刪除 {地點}」、「＋新增地點」與「地點最多 100 個」、每台車的車名、駕駛或「待分配」、「{人數} / {座位} 人」、有路線的日子或「還沒有路線」、「編輯 {車名}」與「新增車輛」）、可見標籤「編輯哪一天」的選日按鈕群組（`.date-tabs` 按鈕，提醒數與只給輔助技術的「{N} 則提醒」）、摘要列、`<ul aria-label="規劃提醒">`、「路線」「活動」分段與「這一天的設定」卡片（旅行目的地空白時以「不指定地點」作為第一個選項）
    - 控制項依設計「控制項與屬性」表使用 `data-action="plan-*"`、`data-plan-nav`、`data-plan-toggle`（`aria-expanded`，展開時 `aria-controls`）與 `data-plan-op`；每個欄位有可見的 `<label>`；錯誤欄位設定 `aria-invalid="true"`，並以 `aria-describedby` 連到欄位旁的錯誤文字
    - _Requirements: 2.3, 2.8, 3.1, 3.2, 3.3, 3.4, 3.5, 3.11, 3.12, 4.1, 4.4, 4.5, 4.6, 4.7, 9.6, 9.8, 16.3, 16.4, 16.5, 16.13, 22.1, 22.5_

  - [x] 9.3 「路線」分段（`src/itinerary-editor.js`）
    - 說明「每台車可安排 6 個停靠點，時間可稍後填。」、路線收起列（需求 5.1 的文字，依 `sortedRoutes()` 排序）、First_Day 的「舊的出發資料」列（缺少的部分依需求 19.10，按鈕為「轉成路線 {車名}」與「不使用舊資料」）
    - 展開的 Route 卡片：「哪一台車」（需求 5.5）、「從哪裡出發」「最後到哪裡」與「＋新增地點」、「幾點出發」（`type="text"`、`autocomplete="off"`、`placeholder`「例如 08:30」）、需求 19.9 的說明、途中任務清單或「途中任務（無）」與說明、每個 Stop 的「停在哪裡」「要做什麼」與不是採買時的「備註」、上移與下移（無障礙名稱依需求 6.5）、移除按鈕（需求 6.14）、採買時的「要買的品項」預覽（以 `shoppingPlan(previewState(state, draft))` 推導需求 6.6 的清單與說明）與「到採買清單調整負責人」、「新增途中任務」與「每台車最多 6 個停靠點」、已儲存時的「刪除這條路線」與「儲存」
    - 「＋新增路線」與需求 5.7 的停用原因（沒有車時附「新增車輛」）、「預計幾點抵達」卡片（收起時為「預計幾點抵達{地點}：{HH:MM 或未填}」，需求 4.8 與設計「需求解讀」第 1 點）、「未分配採買清單」（需求 6.8，N 為 0 時不能展開）
    - _Requirements: 4.8, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.14, 16.5, 19.4, 19.9, 19.10_

  - [x] 9.4 「活動」分段（`src/itinerary-editor.js`）
    - 活動與餐點的收起列依需求 14.13 排序：Activity 有時間、標題、類別與「完成」核取方塊（無障礙名稱「{標題}已完成」）；Meal_Moment 有 Meal_Time、`mealTitle()`、Meal_Label 與「來自料理菜單」；當天沒有項目時顯示「這一天還沒有活動」
    - 「常用活動」`<fieldset>`（`presetsFor()`；已有相同類別時為已勾選、停用並標示「已加入」，不計入 N）、「加入 N 個活動」（N 為 0 或儲存中時停用）、「＋自訂活動」與自訂活動卡片
    - Activity 卡片：「標題」「日期」（每個 Trip_Day 以「第 {N} 天・{月}/{日}（週{星期}）」列出）「時間」「類別」（13 個類別）、參加方式的 `<fieldset>`（「全體旅伴」、「指定車輛」與車輛核取方塊，沒有車時停用並說明；舊名單時另有預選的「保留原旅伴名單」並列出旅伴）、「地點」「備註」、「刪除這個活動」與「儲存」
    - Meal_Moment 卡片只有「時間」、有食材時的食材文字、「到料理菜單編輯」與「儲存」
    - _Requirements: 7.1, 7.2, 7.3, 7.5, 7.6, 7.7, 7.9, 7.11, 8.2, 8.5, 8.7, 8.8, 8.13, 16.5_

  - [x] 9.5 規劃行程的樣式（`src/itinerary.css`、`scripts/build.mjs`）
    - 新增 `src/itinerary.css`；`scripts/build.mjs` 的 CSS 串接清單改為 `styles.css`、`accounts.css`、`scene-motion.css`、`itinerary.css`、`expenses.css`
    - 沿用 Trip_View 既有控制項的樣式：`.button` 的主要、小型與危險變化、`.icon-button`、比照採買清單篩選的 `.segmented`（View_Switch 與「路線」「活動」）、比照料理表單「常用食材」的展開區塊、`.date-tabs`（選日按鈕的文字與提醒數不換行）與 `.field`，不另外定義控制項外觀
    - 按鈕與欄位的點擊範圍至少 44×44 CSS 像素且互不重疊，字級至少 12 CSS 像素，長文字換行；320 到 1440 CSS 像素沒有頁面層級的水平捲動（選日按鈕列除外）；深色主題的底色與文字使用既有的深色色票
    - _Requirements: 4.3, 16.9, 16.11, 17.1, 17.5, 17.6_

  - [x] 9.6 Draft、日子與分段的切換（`src/app.js`）
    - `scheduleTab()` 顯示規劃行程時輸出 `editorHtml()`；每次繪製只計算一次 `shoppingPlan()`、每一天的 `dayModel()` 與 `planningWarnings()`
    - `data-plan-toggle` 展開或收起卡片與區塊：同一時間最多一張卡片；展開時以 `routeDraft()`、`newRouteDraft()`、`activityDraft()`（Activity 卡片，任務 5.3）或已儲存的值建立 Draft，焦點移到第一個欄位；收起時焦點回到收起列的展開按鈕；Places_And_Cars 與「未分配採買清單」的展開狀態存在 `planner`，不算卡片
    - `form[data-plan-card]` 的 `input` 與 `change` 把欄位值寫入 Draft 並設定 `dirty`；只有「哪一台車」、Stop 的地點與任務類型、新增地點會重新繪製，讓品項預覽在同一個事件中更新
    - `data-plan-op`：新增、移除、上移與下移 Stop，以及卡片中「＋新增地點」的展開、確認（以 `placeNameError()` 比對 Place_List、旅行目的地與 `draft.newPlaces`）與取消；焦點依需求 16.14(a)(b)(d)
    - `data-plan-nav="day"` 與 `"segment"` 依需求 4.2、4.7、4.11；切換主分頁時清除 `planner.card`，`view`、`dayIndex`、`segment` 與區塊的展開狀態不變；旅行日期改變或套用其他版本後，把 `dayIndex` 限制在新的天數內並改用 Last_Day 的預設分段，展開中卡片的目標已不存在時收起；這些操作都不寫入 Trip_State
    - _Requirements: 1.3, 2.2, 2.5, 2.8, 3.1, 4.2, 4.7, 4.11, 4.12, 6.5, 6.6, 6.8, 6.14, 10.1, 10.8, 10.9, 16.6, 16.7, 16.14, 19.1, 設計：擴充點_

  - [x] 9.7 儲存、刪除與立即寫入的操作（`src/app.js`）
    - `commitAccount()` 回傳 `Promise<boolean>`（成功為 true），`commit()` 在本機版回傳 `saved`、在帳號版回傳該 Promise；既有的呼叫端忽略回傳值
    - `plan-save` 與 `form[data-plan-card]` 的 `submit`（先 `preventDefault()`）呼叫對應的 `itinerary-edits.js` 函式：失敗時寫入 `card.errors` 或 `card.formError`，焦點移到第一個錯誤欄位或錯誤訊息；成功時結束 Draft、設定 `card.sending` 並 `commit(message)`，寫入成功後收起卡片，焦點移到該項目收起列的展開按鈕（排序改變後的新位置、新項目、加入多個常用活動時排最前面的一筆、活動改到其他日子時依需求 7.12）
    - 寫入失敗時卡片維持展開並顯示送出的值，既有的儲存警示（「匯出未存內容」「重試儲存」，本機版為「匯出目前內容」「處理儲存問題」）使用已含這次修改的 `state`；之後任何一次儲存成功、且這張卡片沒有新的 Draft 時收起它
    - `plan-delete` 先以 `deletePlace()` 檢查使用處（仍被使用時把使用處寫入 `planner.notice`，不開啟視窗），再以 `showDialog('移除這個項目？', …)` 顯示既有說明與「取消」「確認移除」；`plan-confirm-delete` 捨棄 Draft 並寫入一次，焦點依需求 16.14(b)
    - 「不使用舊資料」以「不使用舊的出發資料？」視窗（「取消」「確認」）確認後呼叫 `clearLegacy()`；「轉成路線」以 `legacyRouteDraft()` 建立 `route:legacy:{vehicleId}` 的 Draft；常用活動的勾選存在 `planner.presets`，「加入 N 個活動」呼叫 `addPresets()`；`[data-activity-check]` 改呼叫 `setActivityDone()`；這三項都不讀取也不清除 `planner.card`
    - 確認本機版的 `save()`、`exportData()` 與匯入流程原樣保存新欄位，匯入沿用 `isValidState()` 拒絕無效備份
    - _Requirements: 2.7, 5.12, 7.3, 7.4, 7.8, 7.12, 10.4, 10.5, 10.7, 10.9, 10.10, 16.7, 16.8, 16.13, 16.14, 18.13, 18.14, 18.15, 19.6, 19.8, 19.11, 21.9_

  - [x] 9.8 離開確認與跨分頁的導覽（`src/app.js`）
    - 在既有分帳草稿的捕獲階段點擊處理中，依設計「離開確認」表在 `planner.card?.dirty` 時以 `window.confirm('尚有未儲存的修改。確定放棄？')` 詢問：取消時 `preventDefault()` 與 `stopImmediatePropagation()`，畫面完全不變；確認時先清除 `planner.card`（Draft 中新增的地點因此不加入 Place_List），再執行原本的操作
    - `beforeunload` 的條件加上 `planner.card?.dirty`；本機版的 `storage` 事件把有 Draft 視為對話框開啟中；`hashchange` 只重新繪製並保留 `planner.card`；從其他頁面進入 Trip_View 時 `planner.view` 設為 `poster`
    - `data-plan-nav="meal"`：切換到料理菜單分頁；`mealCard()` 的編輯按鈕加上 `data-focus="meal-edit-{id}"`，`render()` 聚焦該按鈕並以 `scrollIntoView({ block: 'center' })` 捲動到可視範圍。`data-plan-nav="shopping"`：切換到採買清單分頁並聚焦其主分頁按鈕
    - _Requirements: 1.2, 1.10, 6.7, 8.12, 10.2, 10.3, 10.11, 16.14_

  - [x] 9.9 權限（`src/app.js`）
    - `allowAccountAction()`：`plan-*` 動作不經 `canDelete` 檢查，但仍受儲存中與 `!saved` 的限制；`delete` 與 `confirm-delete` 的既有檢查不變，所以其他分頁與車輛的刪除規則不變
    - `applyAccountChrome()`：受邀旅伴的權限說明改為「協作編輯模式，不能刪除旅伴、料理、採買品項、裝備與車輛」，Trip_Manager 與 Viewer 的說明不變；儲存中停用 `plan-*` 控制項，`editorHtml()` 依 `accountSaving` 停用 `data-plan-nav`、`data-plan-toggle` 與送出中卡片的欄位，同步狀態顯示「正在儲存…」
    - `ctx.canDeleteVehicle` 與 `formDialog()` 既有的「移除項目」規則相同（Local_Planner 與 Trip_Manager）；受邀旅伴在規劃行程仍看得到刪除地點、路線、Stop 與活動的按鈕
    - _Requirements: 1.1, 1.5, 3.11, 10.6, 21.1, 21.2, 21.6, 21.10_

  - [x] 9.10 撰寫帳號版規劃行程的瀏覽器測試（`tests/itinerary-accounts.e2e.js`）
    - 測試標題為 `[TC-ITIN-001]` 至 `[TC-ITIN-003]`；以 `POST /api/trips` 的 `legacyState` 建立 `exampleTrip()` 的旅行
    - 需求 23.7 的 Account_Mode 部分：另一個請求先更新同一趟旅行後再儲存 Route 卡片，Draft 與畫面保留、顯示既有的「其他人已更新」提示、伺服器上的資料沒有被覆寫
    - 需求 23.8 的 Trip_Manager 與 Collaborator 部分：看得到的控制項；Collaborator 從 Places_And_Cars 開啟的 Vehicle_Dialog 與 Trip_Menu 中刪除 Vehicle 的控制項數量為 0；Collaborator 確認刪除已儲存的 Route 後，重新載入頁面時該 Route 不再出現；同步狀態文字。Viewer 由任務 11.20 加入
    - _Requirements: 3.11, 10.5, 10.7, 21.2, 21.6, 21.7, 21.10, 23.7, 23.8_

- [x] 10. Checkpoint - 規劃行程
  - 執行 `bun run build`、完整單元測試，以及以 `node scripts/check-accounts.mjs <檔案…>` 執行本計畫到目前為止新增的瀏覽器測試檔，全部通過。執行完整瀏覽器測試時，需求 23.11 列出的 Changed_Test 依賴需求 1.6 移除的介面，在任務 17 修改前預期失敗；確認失敗都屬於這一類。Ensure all tests pass, ask the user if questions arise.

- [x] 11. 行程圖（Itinerary_Poster）
  - [x] 11.1 插圖模組（`src/itinerary-art.js`）
    - 依設計「插圖與顏色」表畫 13 種活動插圖（以 `ACTIVITY_CATEGORIES` 查表，互不相同）、4 種途中任務插圖、營地、房屋與地標 3 種終點插畫、車子圖示與空白提示插畫，全部原創、不描摹參考圖
    - 模組只匯出 `artFor(kind, key, { seed, className })` 與 `fixedRandom()`，各插圖函式不匯出；`kind` 與 `key` 取自固定表：`activity`（`ACTIVITY_TYPES`）、`dish`（`DISH_KINDS`，轉交 `dishIllustration()`，`seed` 為 `fixedRandom(meal.id)`）、`stop`（`STOP_KINDS`）、`end`（`camp`、`house`、`landmark`）、`car`（顏色來自外層的 `car-{index}`）與 `empty`；不在表中的鍵改用該種類的預設圖案，`key` 只用來查表，不寫進標記
    - 每個 `<svg>` 帶 `xmlns`、`aria-hidden="true"` 與 `focusable="false"`，可以單獨成為 SVG 文件，不含文字、`<foreignObject>`、連結、點陣圖或外部資源；外框沿用 `src/art.js` 的 3 CSS 像素圓頭圓角墨線，顏色只以類別與 `var(--ip-*)` 取得
    - 營火、蒸氣、星星、樹木與彩旗加上 `ip-flame`、`ip-steam`、`ip-star`、`ip-tree`、`ip-flag` 與 `ip-anim` 類別；它們屬於各自的插圖，不另設 `artFor()` 的鍵
    - 匯出 `fixedRandom(id)`：以 FNV-1a 32 位元雜湊回傳固定的 `[0, 1)` 數值
    - _Requirements: 8.10, 11.6, 11.7, 11.9, 11.16, 12.5, 16.1, 22.1, 22.5, 設計：擴充點_

  - [x] 11.2 `posterHtml()` 的結構、每日段落與活動小卡（`src/itinerary-poster.js`、`src/scene-motion.js`）
    - `src/scene-motion.js` 匯出 `sceneMotionToggle()`（`[data-scene-motion-toggle]` 按鈕與 `[data-motion-reduced-note]` 說明），`sceneMotionSettings()` 改用它且輸出不變
    - 新增 `src/itinerary-poster.js` 的 `posterHtml(state, { icon, mapLink, print, textOpen, canEdit, models, plan })`，依設計「文件結構」輸出：只給輔助技術的第 2 層標題「行程圖」、頂端概要列（需求 11.13，日期以 `<time datetime>` 標示，並含 `sceneMotionToggle()`）、每一天的 `<section data-poster-day>`（天數徽章與 `day-tone-{(n − 1) % 3}`、第 3 層標題與只給輔助技術的日期、日期與 Day_Caption、需求 11.2 的「地點：」行）、結尾行與「路線僅為示意，非導航或即時位置；不預估返抵時間。」
    - 行程圖的插圖只經 `artFor()` 取得，不直接呼叫各插圖函式或 `dishIllustration()`
    - 沒有任何 Route、Legacy_Departure、Activity 與 Meal 時，改輸出空白提示插畫（`artFor('empty')`）、「這趟旅行還沒有行程」與 `canEdit` 時的「開始規劃」（`data-plan-nav="view"`）
    - 活動區塊是無障礙名稱「活動」的 `<ul>`，每筆 Activity 與 Meal_Moment 一張小卡（需求 11.9 至 11.11）；Activity 的插圖為 `artFor('activity', type)`，Meal_Moment 的插圖為 `artFor('dish', dishKind, { className: 'moment-dish', seed: fixedRandom(meal.id) })`，`dishKind` 取自 `dayModel()`；「地點：」之後的地點以 `mapLink()` 呈現
    - 每日標題、Activity 與 Meal_Moment 的元素帶 `data-line` 與 `data-id`；所有使用者值只經 `escape()` 恰好一次寫入文字或允許的屬性
    - _Requirements: 1.8, 1.9, 8.1, 8.5, 8.6, 8.7, 8.10, 8.13, 9.10, 11.1, 11.2, 11.3, 11.9, 11.10, 11.11, 11.13, 11.14, 11.15, 11.16, 11.17, 11.19, 13.2, 13.3, 16.1, 16.2, 22.1, 22.3, 22.5, 設計：擴充點_

  - [x] 11.3 撰寫 Property 21 的 property test（`tests/itinerary-dish-variation.test.js`）
    - **Property 21: 通用餐盤的圖案固定**
    - **Validates: Requirements 8.10**

  - [x] 11.4 `routeMapLayout()` 與 `posterHtml()` 的路線圖（`src/itinerary-poster.js`）
    - 匯出不碰 DOM 的 `routeMapLayout(block)`：以 `dayModel()` 路線區塊的 `lines` 與 `ends` 為輸入，依設計「`routeMapLayout(block)`」回傳 `k`（Stop 欄數，至少 1）、`cw`（匯流欄寬）、`lw`（支線欄寬）、`ends`（每組橫式的列段，以及直式的終點列與道路開始的列）、`lines`（每行所屬的終點組 `g`，舊出發資料為 `null`；橫式的列、是否繞回、匯流支線序號與匯入點；直式的列、Stop 列、支線序號與最後一列）、`minHeight` 與 `vRows`；結果只由輸入決定，`posterHtml()` 把它寫進行內 `style`，`motionPlan()`（任務 11.9）也依它決定每台車經過的格子
    - 橫式依設計「路線圖的格線」：第 g 組的列段從該組第一條路線所在的列開始，到下一組第一條路線所在列的前一列為止，各組依 `ends` 的順序相連並涵蓋每一列；路線所在的列不在自己那一組的列段時是繞回的線條，經匯流欄中自己的匯流支線往上，在自己那一組列段的最後一列「列頂往下 26 + 10 × k CSS 像素」處匯入道路（k 為它在同一組繞回線條中的順序），`minHeight` 讓該列至少 `26 + 10 × m + 12` CSS 像素高（m 為繞回這一組的線條數）；`cw` 為 `12 + 10 × L` CSS 像素並以 92 為上限（L 為繞回的線條數，沒有時為 0）
    - 直式依設計「路線圖的格線」：列依序為出發列表、每條有 Stop 的路線的 Stop 列、每個終點組一列，最後是「先採買」說明；最後一組使用左側道路，只有一組時從路線圖頂端開始，否則從自己第一條路線的出發列開始；其他組的每條路線各有一條支線，往下延伸到自己那一組的終點列；支線由右往左依組的順序排列，同一組內依文字版的順序，最後是最後一組有 Stop 的路線；`lw` 為 `12 + 10 × N` CSS 像素並以 92 為上限（N 為支線數）
    - 每個路線區塊依設計「路線圖的內容」輸出無障礙名稱「路線」的 `ul.rm-list`：每條路線與每筆舊出發資料一個 `li.rm-track.car-{carColorIndex}`，路線的 `li` 以 `--g` 標示所屬的終點組，舊出發資料沒有 `--g`；依區塊各行的順序列出出發時間（或「出發時間待定」）、車名與以 `mapLink()` 呈現的起點；Stop 插圖（`artFor('stop', kind)`）與依 `stopText()` 的文字；只給輔助技術的「，到 {終點}」；`aria-hidden` 的線條只匯入自己那一組的道路（舊出發資料沒有線條）
    - 每個終點組（`ends` 的一項）依 `ends` 的順序輸出一條 `.rm-road` 與 `.rm-ends` 中的一個 `.rm-end`，兩者以相同的 `--g` 對應；不同組的道路互不相接，只有一條路線的組也有自己的道路與終點插畫；終點種類只取自 `endKind`，不在行程圖另外判斷，插畫為 `artFor('end', endKind)`：`camp`（Day_Location）為營地插畫與到達行，`house`（Last_Day 的其他終點）為房屋插畫與「平安回到{終點}」（只有終點名稱是地圖連結），`landmark` 為地標插畫與終點名稱
    - 每個 `.rm-end` 的 `.rm-park` 有該組 `count` 個停車位，第 i 個屬於該組第 i 條路線（依該組 `lines` 的順序），並帶該路線的 `car-{carColorIndex}` 類別；Last_Day 的 Other 區塊另有只給輔助技術的返程行；需求 11.8 的「{車名}先採買，其他{N}車直達」
    - 行內 `style` 只放 `routeMapLayout()` 算出的整數（`--k`、`--t`、`--e`、`--g`、`--cw`、`--lw`、`--dr`、`--hr`、`--hspan`、`--vr`、`--vspan` 等），顏色只用 `car-0` 至 `car-7` 類別
    - 路線、舊出發標記、到達行與返程行的元素帶 `data-line` 與 `data-id`，文件順序與 Itinerary_Text 相同
    - _Requirements: 3.13, 11.4, 11.5, 11.6, 11.7, 11.8, 11.12, 11.17, 12.10, 16.1, 16.2, 17.2, 17.3, 19.3, 19.10, 22.3, 22.5, 22.6, 設計：擴充點_

  - [x] 11.5 撰寫 Property 7 的 property test（`tests/itinerary-poster-order.test.js`）
    - **Property 7: 行程圖與文字版的內容與順序一致**
    - **Validates: Requirements 8.1, 11.4, 11.5, 11.7, 11.9, 11.10, 16.1**

  - [x] 11.6 撰寫 Property 19 的 property test（`tests/itinerary-car-color.test.js`）
    - **Property 19: Car_Color 只由車輛位置決定**
    - **Validates: Requirements 11.12, 22.6**

  - [x] 11.7 行程圖的版面與主題（`src/itinerary.css`）
    - 依設計「路線圖的格線」：`ul.rm-list` 與 `li` 為 subgrid；寬度大於 760 CSS 像素時由左往右（出發 9 至 13rem、K 個 Stop 欄、寬 `--cw` 的匯流欄、28 CSS 像素的道路、終點 9 至 13rem），小於等於 760 CSS 像素時由上往下（16 CSS 像素的道路、寬 `--lw` 的支線欄、內容）；航點固定在格子頂端往下 26（橫式）或 22（直式）CSS 像素；`.rm-seg` 線段；`li` 為 `pointer-events: none`，子元素恢復；`@supports not (grid-template-rows: subgrid)` 改為上下排列並隱藏線條、道路與車子
    - 橫式的終點組：每組的 `.rm-road` 與 `.rm-end` 依 `--hr`、`--hspan` 跨越自己的列段；相鄰兩組的道路在列的交界各內縮 6 CSS 像素，中間留 12 CSS 像素的空隙，第 1 組的上端與最後一組的下端不內縮；道路在該組第一列的航點高度分出一小段接到終點插畫；組內的線條在航點高度橫越匯流欄匯入自己那一組的道路，繞回的線條在匯流欄中走自己的匯流支線；`routeMapLayout()` 的 `minHeight` 只在橫式撐高對應列的出發項目；終點內容比列段高時由格線撐高那幾列
    - 直式的終點組：最後一組的 `.rm-road` 是道路欄中的左側道路，延伸到自己的終點列，在航點高度轉向接到終點插畫；其他組的 `.rm-road` 是自己終點列航點高度、高 16 CSS 像素的橫向道路，從組內最左側支線的中線向右延伸到終點插畫；支線在支線欄左右各留 6 CSS 像素之後等距排列（支線數 N 不超過 8 時間距 10 CSS 像素，9 到 13 時為 `80 ÷ N` CSS 像素）；每個 `.rm-end` 在自己終點列的內容欄，終點插畫在左，終點文字、到達行與停車位在右，放不下時換行
    - 停車位在終點插畫旁並排，放不下時換行，彼此不重疊
    - 小卡在 760 CSS 像素以下每列兩張、以上每列三張、1280 CSS 像素以上每列四張；文字 `overflow-wrap: anywhere`；相鄰段落之間 1.5 CSS 像素的虛線；三種天數徽章色調
    - `.poster-day-head` 不依固定列數排版（天數徽章跨越全部列，或以換行排列），在「地點：」行之後再多一行時不必調整其他元素
    - `--ip-*` 的淺色與深色值、`car-0` 至 `car-7` 依設計「插圖與顏色」；字級至少 12 CSS 像素；跨越 760 CSS 像素時只換 CSS 排列，DOM 不變
    - `--ip-paper` 只畫在 `.itinerary-poster`，概要列、每日段落與結尾行不另外畫底色，路線圖、小卡與 Text_Panel 使用 `--ip-card`；深色主題與列印只覆寫這一條背景規則，畫面與原本的設計相同
    - _Requirements: 11.1, 11.2, 11.5, 11.6, 11.12, 11.16, 12.10, 16.10, 16.11, 17.1, 17.2, 17.3, 17.4, 17.5, 17.8, 設計：擴充點_

  - [x] 11.8 行程表分頁接上行程圖（`src/app.js`）
    - `scheduleTab()` 顯示行程圖時以 `posterHtml(state, { print: false, textOpen: planner.textOpen, canEdit, models, plan, icon, mapLink })` 取代任務 9.1 的暫時文字，之後接結尾小語；`models` 與 `plan` 與規劃行程共用同一次計算，因此料理菜單等其他分頁儲存後回到行程表時直接呈現新的資料
    - 「開始規劃」切換到規劃行程，焦點移到 View_Switch 的「規劃行程」
    - _Requirements: 1.8, 1.9, 1.10, 8.9, 11.18, 16.14_

  - [x] 11.9 車子與裝飾動畫（`src/itinerary-poster.js`、`src/itinerary.css`）
    - `motionPlan(block, layout)` 以 `routeMapLayout(block)`（任務 11.4）取得每台車在該排列中經過的格子，依設計「`motionPlan(block, layout)`」步驟 1 至 4：依出發時間分組（沒有時間的為最後一組）；`gap` 在組數不超過 8 時為 0.6 秒，超過時為 `min(0.6, 7.4 ÷ (G − 1))` 秒；每個 Stop 停留 0.8 秒；橫式每經過一個 Stop 欄 0.9 秒，兩種排列中每個橫向接力 0.4 秒、經過一列 0.3 秒（橫式的匯流支線與直式的支線相同），直式 Stop 列進 0.35 秒、出 0.45 秒，道路淡出 0.3 秒、到停車位 0.4 秒；縮放移動時間使 L 落在 4 到 12 秒；到達畫面 3 秒；`period = L + 3`
    - `motionPlan()` 先算出每台車依序經過起點、每個 Stop、自己那一組的道路與停車位的時間 `waypoints`（秒），再由 `waypoints` 換算每個接力元素的開始、停留與結束時間；`waypoints` 與接力元素的時間都回傳，另含 `period` 與 `gap`
    - `motionCss(models, plans)` 只把接力元素的時間換成影格：為每種接力時間表產生名稱為 `ipm-{h|v}-{FNV-1a 雜湊}` 的 `@keyframes` 與同名類別，只在 `@media (prefers-reduced-motion: no-preference)` 且 `:root[data-scene-motion=running]` 或 `paused` 時接上動畫，橫式與直式各在 `(min-width: 761px)` 與 `(max-width: 760px)` 中；`posterHtml()` 把結果放進行程圖內的 `<style>`，內容只有程式產生的名稱與數字
    - 路線圖加上 `aria-hidden` 且帶 `ip-anim` 的接力元素，依設計「車子的接力元素」表。橫式（`.rm-h`）：跨越所有 Stop 欄的 `.rm-run`；匯流欄寬度大於 0 時，組內的線條再一個在航點高度橫越匯流欄到道路的橫向接力；繞回的線條依序為航點到自己匯流支線的橫向接力、所在列（航點到列頂）、往上經過的每一列（列底到列頂）與目標列（列底到匯入點）的縱向接力，以及從匯流支線匯入道路的橫向接力
    - 直式（`.rm-v`，每列一段）：最後一組直達的路線在出發列以一個橫向接力匯入左側道路；最後一組有 Stop 的路線依序為出發列到支線的橫向接力、經過的每一列一個縱向接力、轉到途中任務線的橫向接力、每個 Stop 列兩個縱向接力（列頂到航點、航點到列底），最後以一個橫向接力匯入左側道路；其他組的路線在出發列橫向走到自己的支線（有 Stop 時同樣經過途中任務線與每個 Stop，再以一個橫向接力回到支線），經過的每一列一個縱向接力，在自己那一組的終點列以一個縱向接力接到該組道路的上緣
    - 停車位依終點組：每條路線在自己那一組 `.rm-park` 的第 i 個停車位有一台同色的車子（帶 `ip-anim`）；車子到達自己那一組的道路後淡出，該停車位的車子淡入並停到這一輪結束，所以終點相同的車子並排停在該組的終點插畫旁，不同組的車子停在各自的終點插畫旁
    - 另一種排列的接力元素為 `display: none`；靜態畫面只有第一個接力元素不透明並停在起點，其他接力元素與停車位的車子透明；每條線條完整顯示，從起點經過每個 Stop（橫式的繞回線條另外經過匯流支線）畫到自己那一組的道路
    - `src/itinerary.css`：裝飾動畫（每個循環至少 2.4 秒、位移不超過 3 CSS 像素、旋轉不超過 4 度、只有星星改變透明度），以及 `:root[data-scene-motion=paused] .itinerary-poster .ip-anim` 與 `.poster-day[data-offscreen] .ip-anim` 的 `animation-play-state: paused`；文字、線條、天數徽章與小卡沒有動畫
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.8, 12.9, 12.10, 13.1, 13.5, 22.1, 22.4, 設計：擴充點_

  - [x] 11.10 撰寫 Property 8 的 property test（`tests/itinerary-poster-structure.test.js`）
    - **Property 8: 行程圖的結構與資料相符**
    - 道路、終點插畫與停車位依終點組的規則由 Property 23（任務 11.21）檢查
    - **Validates: Requirements 1.8, 11.1, 11.2, 11.3, 11.5, 11.15, 11.19, 16.2**

  - [x] 11.11 撰寫 Property 18 的 property test（`tests/itinerary-motion-plan.test.js`）
    - **Property 18: 動畫時間表符合範圍**
    - 以 `blockShape()` 產生 1 到 200 條路線（每條 0 到 6 個 Stop）、1 到 200 組出發時間（含沒有出發時間的組），終點形成 1 到 4 個以任意順序交錯的終點組的區塊，兩種排列都檢查
    - **Validates: Requirements 12.2, 12.3, 12.4**

  - [x] 11.12 畫面外的日子暫停（`src/itinerary-motion.js`、`src/app.js`）
    - 新增 `src/itinerary-motion.js` 的 `watchPosterDays(root)`：以 IntersectionObserver 為完全離開視窗的 `[data-poster-day]` 加上 `data-offscreen`，有任何部分進入時移除；每次呼叫先中止前一個 observer；沒有 IntersectionObserver 時不做任何事
    - `render()` 在 `syncSceneMotion()` 之後呼叫 `watchPosterDays()`；切換 Motion_Toggle 沿用 `setupSceneMotion()` 的文件層點擊處理，不重新繪製畫面，行程圖與 Trip_Menu 的按鈕同步，焦點留在剛啟動的按鈕
    - _Requirements: 12.7, 13.2, 13.3, 13.4, 13.5_

  - [x] 11.13 Text_Panel 與複製文字（`src/itinerary-poster.js`、`src/app.js`、`src/itinerary.css`）
    - `posterHtml()` 在結尾文字之後（顯示空白提示時也一樣）輸出 Text_Panel：「文字版」標題、`data-text-panel="toggle"` 的「展開文字版」或「收起文字版」（`aria-expanded`，展開時 `aria-controls`）、`data-text-panel="copy"` 的「複製文字」，以及只在展開時輸出的 `<pre id="text-panel-body">`（內容為 `escape(itineraryText(state))`）
    - `src/app.js`：`data-text-panel` 的點擊處理不經 `data-action`，Viewer、儲存中與儲存失敗時都能使用；`planner.textOpen` 在頁面載入時為 false，只由展開控制項或複製失敗改變；`copyItinerary()` 依設計只以 `navigator.clipboard.writeText()` 寫入 `itineraryText(state)`，成功時 `notify('已複製行程文字')`，不存在或失敗時展開 Text_Panel、以 `selectAllChildren()` 選取 `<pre>` 並 `notify('請手動複製已選取的文字')`；兩個操作都不呼叫 `commit()`，焦點留在按鈕
    - `src/itinerary.css`：`<pre>` 為 `white-space: pre-wrap; overflow-wrap: anywhere`
    - _Requirements: 1.8, 11.19, 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 16.4, 16.8, 16.14, 22.7_

  - [x] 11.14 列印（`src/app.js`、`src/itinerary-poster.js`、`src/itinerary.css`）
    - `posterHtml()` 輸出只在列印時顯示的 `.poster-print-cover`（旅行名稱、頂端概要列的文字、旅行介紹每個非空白行各一段）；`print: true` 時不輸出 Motion_Toggle、`<style>` 與 Text_Panel，並為 `id` 加上 `print-` 前綴
    - `src/app.js`：`render()` 在 Trip_View 顯示行程表分頁時設定 `document.body.dataset.printScope = 'itinerary'`，其他情況移除；顯示規劃行程時在其後輸出 `<div class="itinerary-print-copy">`（`posterHtml(state, { print: true })` 與結尾小語），只以已儲存的 Trip_State 產生
    - `src/itinerary.css` 的 `body[data-print-scope="itinerary"]` 列印規則依設計「列印」：隱藏頁首、儲存警示、麵包屑、旅行封面、主分頁、側欄、頁尾、Trip_Menu、`#dialog`、`#toasts`、View_Switch、Itinerary_Editor、Text_Panel、Motion_Toggle 與所有按鈕；畫面上隱藏 `.itinerary-print-copy` 與 `.poster-print-cover`；列印時顯示封面並隱藏 `.poster-summary`；`animation: none !important`；`--ip-*` 改回淺色並使用白色頁面背景；`break-inside`、`break-after`、`orphans` 與 `widows`
    - _Requirements: 13.6, 13.7, 13.8, 13.9, 15.9, 17.9_

  - [x] 11.15 撰寫 Property 2 的 property test（`tests/itinerary-legacy-state.test.js`）
    - **Property 2: 本功能之前的 Trip_State 仍然有效**
    - 以 `legacyState()` 產生，並確認 `itineraryText()`、`posterHtml()` 與 `editorHtml()` 都不擲出例外
    - **Validates: Requirements 18.1, 18.12, 19.8, 23.4**

  - [x] 11.16 撰寫 Property 20 的 property test（`tests/itinerary-html-safety.test.js`）
    - **Property 20: 產生的 HTML 只在允許的位置放使用者值**
    - 以 `markupText()` 填入使用者文字，用 Bun 的 `HTMLRewriter` 解析 `posterHtml()`、`posterHtml({ print: true })` 與展開各種卡片的 `editorHtml()`
    - **Validates: Requirements 11.17, 15.5, 16.1, 16.4, 22.1, 22.2, 22.3, 22.5**

  - [x] 11.17 撰寫行程圖的範例測試（`tests/itinerary-poster.test.js`、`tests/itinerary-motion.test.js`、`tests/scene-motion.test.js`）
    - Example_Trip 行程圖的文字（需求 11.2 至 11.15 的範例）、空白提示與只在 `canEdit` 時出現的「開始規劃」、列印副本沒有 Motion_Toggle、`<style>` 與 Text_Panel
    - 路線圖：Example_Trip 第 1 天與第 3 天的路線圖各只有一個 `.rm-road`，`routeMapLayout()` 的 `cw` 為 0，直式的支線只有第三車・採買組一條（第 1 天）或沒有（第 3 天）；設計「路線圖的格線」中第一車往台北、第二車往新竹、第三車往台北的 Last_Day 區塊在橫式有兩條道路與一條繞回的線條（第三車），在直式中新竹使用左側道路、台北的兩條線各有支線
    - `motionCss()` 的輸出只含程式產生的名稱與數字，且只在 `prefers-reduced-motion: no-preference` 與 `data-scene-motion` 為 running 或 paused 時接上動畫
    - `sceneMotionToggle()` 的標記；`sceneMotionSettings()` 的輸出與修改前相同
    - _Requirements: 1.8, 1.9, 11.2, 11.3, 11.5, 11.6, 11.7, 11.8, 11.13, 11.14, 11.15, 12.9, 13.1, 13.3, 13.6, 17.2, 17.3_

  - [x] 11.18 撰寫行程圖的瀏覽器測試（`tests/itinerary-poster.e2e.js`）
    - 測試標題為 `[TC-ITIN-010]` 至 `[TC-ITIN-019]`；以任務 1.6 的 fixture 在本機版載入 Example_Trip
    - 需求 23.15：複製文字（`context.grantPermissions(['clipboard-read', 'clipboard-write'])` 後讀回的內容與 `EXAMPLE_TEXT` 逐字相同並顯示「已複製行程文字」；以 `page.addInitScript()` 讓 `navigator.clipboard.writeText` 失敗時，Text_Panel 的全部文字被選取並顯示「請手動複製已選取的文字」）、減少動態、Motion_Toggle 同步（含從 Trip_Menu 切換）與兩種檢視下的列印
    - 複製文字與減少動態的測試標記 `@critical`
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.6, 13.7, 13.8, 13.9, 15.2, 15.3, 23.15_

  - [x] 11.19 撰寫舊資料的瀏覽器測試（`tests/itinerary-legacy.e2e.js`）
    - 測試標題為 `[TC-ITIN-020]` 至 `[TC-ITIN-029]`
    - 需求 23.10：在 Account_Mode（`POST /api/trips` 的 `legacyState` 為 `seed()`）與 Local_Planner（`tests/local-planner-fixture.js` 的 `seed()`）開啟、切到規劃行程並選取每一天、切回行程圖，全程不儲存；確認沒有寫入、10 筆活動與「把好吃的，一起買齊」的「小安、小雨、米米」、舊出發資料只在第 1 天、自由文字的 `meeting`，以及匯入 `seed()` 備份後結果相同
    - _Requirements: 19.1, 19.2, 19.3, 19.7, 19.8, 23.10_

  - [x] 11.20 撰寫 Viewer 的瀏覽器測試（`tests/itinerary-accounts.e2e.js`）
    - 在任務 9.10 的檔案（不存在時建立）加入 `[TC-ITIN-004]`：攔截 `GET /api/trips/:id`，把 `permissions.canEdit` 與 `permissions.canDelete` 改為 false；畫面沒有 View_Switch、規劃行程與任何新增、修改、刪除或勾選完成的控制項，但可以展開 Text_Panel、複製文字與操作 Motion_Toggle
    - _Requirements: 1.5, 15.4, 21.1, 23.8_

  - [x] 11.21 撰寫 Property 23 的 property test（`tests/itinerary-route-roads.test.js`）
    - **Property 23: 終點不同的路線不共用道路**
    - 以 `endMixState()` 產生，以 `dayModel()` 取得有 1 到 12 條路線、1 到 4 個交錯終點的路線區塊；以 Bun 的 `HTMLRewriter` 解析 `posterHtml()` 中該區塊的 `.rm-road`、`.rm-end`、`--g` 與停車位，並檢查同一個區塊 `routeMapLayout()` 的橫式與直式結果
    - **Validates: Requirements 11.5, 11.6, 12.10, 13.1, 17.2, 17.3**

- [x] 12. Checkpoint - 行程圖
  - 執行 `bun run build`、完整單元測試，以及以 `node scripts/check-accounts.mjs <檔案…>` 執行本計畫到目前為止新增的瀏覽器測試檔，全部通過。執行完整瀏覽器測試時，需求 23.11 列出的 Changed_Test 在任務 17 修改前預期失敗；確認失敗都來自需求 1.6 移除的介面。Ensure all tests pass, ask the user if questions arise.

- [x] 13. 既有畫面的調整
  - [x] 13.1 車輛：Vehicle_Dialog、刪除檢查與 Trip_Menu 車輛卡片（`src/app.js`）
    - `editForm('vehicle')` 只保留「車輛暱稱」「駕駛」「座位數（含駕駛）」與乘客的 `<fieldset>`，移除「出發時間（選填）」「出發地點」與「各車出發」的說明，改為「每天的出發時間與地點，請在規劃行程的路線填寫。」；表單送出改用 `saveVehicle()`；不再匯入 `formatVehicleMeeting`（`src/vehicle-departures.js` 與其測試不變）
    - `delete`（`data-kind="vehicle"`）在開啟確認視窗前檢查：`vehicleRouteDays()` 不為空時顯示「這台車在第 1 天、第 3 天還有路線，請先刪除這些路線，或改派給其他車。」（Vehicle_Dialog 開啟時寫入 `.form-error`，否則以 `notify()` 顯示）；仍被活動指定時沿用既有提示；兩者都成立時兩則都顯示；`confirm-delete` 既有的活動檢查保留
    - `vehicleCards()` 以 `firstDayDeparture()` 取代原本的出發地點行（需求 3.8 的三種格式，地點以 `mapLink()` 呈現，連結文字只有地點名稱）
    - _Requirements: 2.4, 2.6, 3.6, 3.7, 3.8, 3.9, 3.10, 3.13, 22.1, 22.3, 22.5_

  - [x] 13.2 Trip_Settings_Dialog（`src/app.js`）
    - 儲存時依序：既有的必填與日期檢查；`destinationConflict()` 為 `duplicate` 時在對話框顯示「已有同名地點：{名稱}。請先在「地點與車」把這個地點改名。」；`retimeByDayIndex()` 被拒絕時顯示任務 4.1 的訊息；套用其他欄位後以 `isValidState()` 驗證
    - 改為在副本上計算：任何一步失敗都不改變 `state`，對話框保留輸入；成功時以一次 `commit()` 寫入，Itinerary_Editor 依任務 9.6 繼續選取第 N 天
    - _Requirements: 2.4, 2.9, 4.12, 20.1, 20.2, 20.6_

  - [x] 13.3 料理菜單與採買清單分頁（`src/app.js`）
    - 料理表單的送出改用 `saveMeal()`：餐次改變時刪除 `time`，其他修改（含套用料理範本）保留
    - 採買清單分頁中每個屬於某個 Shopping_Stop 的品項列加上 `<small class="shopping-where">第 {N} 天在{地點}（{車名}）</small>`，取自 `shoppingPlan(state).locationOf`；Viewer 也看得到，不產生連結
    - _Requirements: 6.10, 6.12, 8.4, 20.7, 22.1, 22.5_

  - [x] 13.4 撰寫既有畫面的瀏覽器測試（`tests/itinerary-screens.e2e.js`）
    - 測試標題為 `[TC-ITIN-030]` 至 `[TC-ITIN-039]`；以 Example_Trip 在本機版執行
    - Vehicle_Dialog 只有四類欄位與新說明，儲存既有車輛後 `meeting` 不變；刪除仍有路線的車時不開啟確認視窗並列出第 N 天；Trip_Menu 車輛卡片的出發行
    - Trip_Settings_Dialog：目的地改成與地點同名時拒絕並保留輸入；縮短天數會移除有路線的日子時拒絕；延後日期後，路線、每日設定與正在編輯的第 N 天不變；修改目的地後，行程圖與規劃行程顯示新的名稱
    - 料理菜單改餐次後，Meal_Time 回到新餐次的預設；採買清單分頁顯示「第 1 天在超市／賣場（第三車・採買組）」
    - _Requirements: 2.4, 2.9, 3.7, 3.8, 3.9, 4.12, 6.10, 8.4, 20.1, 20.2_

  - [x] 13.5 撰寫規劃行程的瀏覽器測試（`tests/itinerary-editor.e2e.js`）
    - 測試標題為 `[TC-ITIN-040]` 至 `[TC-ITIN-049]`；以 Example_Trip 在本機版執行，每次儲存後重新載入頁面，確認規劃行程、行程圖與 Text_Panel 的結果
    - 需求 23.7 本機版的前五項：常用活動；含採買 Stop 的路線（品項預覽、上移下移、修改出發時間，以及「到採買清單調整負責人」改負責人後各處都改為新的車）；「＋新增地點」、在 Places_And_Cars 改名與同名拒絕；刪除使用中的地點；修改餐點時間後 Trip_State 只有該 Meal 的時間改變
    - 路線卡片儲存的測試標記 `@critical`
    - _Requirements: 2.2, 2.5, 2.6, 2.7, 5.2, 5.11, 6.5, 6.6, 6.7, 6.10, 6.12, 7.2, 7.3, 7.4, 8.3, 23.7_

  - [x] 13.6 撰寫 Draft 與備份的瀏覽器測試（`tests/itinerary-drafts.e2e.js`）
    - 測試標題為 `[TC-ITIN-050]` 至 `[TC-ITIN-059]`
    - 需求 23.7 本機版的後兩項：有 Draft 時逐一執行需求 10.2 列出的每一種操作（取消時保留 Draft 與畫面，確認時丟棄 Draft 且 Trip_State 不變），重新整理頁面時觸發 `beforeunload` 確認；匯出 JSON 備份再匯入後，Trip_State 與匯出前相同
    - _Requirements: 10.2, 10.3, 18.13, 23.7_

  - [x] 13.7 撰寫 XSS 的瀏覽器測試（`tests/security-xss.e2e.js`）
    - 新增 `[TC-XSS-005]`：依需求 23.9 以 API 把 XSS_Payload_Set 存入列出的欄位，檢查展開 Text_Panel 的行程圖，以及依序展開 Places_And_Cars、含品項預覽的 Route 卡片、「未分配採買清單」與 Activity 卡片的規劃行程；沿用檔案中的偵測方式，並確認沒有向其他 origin 發出請求
    - _Requirements: 22.1, 22.2, 22.4, 23.9_

- [x] 14. Checkpoint - 既有畫面
  - 執行 `bun run build`、完整單元測試，以及以 `node scripts/check-accounts.mjs <檔案…>` 執行本計畫到目前為止新增的瀏覽器測試檔，全部通過。執行完整瀏覽器測試時，需求 23.11 列出的 Changed_Test 在任務 17 修改前預期失敗；確認失敗都來自需求 1.6 與 3.7 移除的介面。Ensure all tests pass, ask the user if questions arise.

- [x] 15. 無障礙與版面
  - [x] 15.1 無障礙與版面的樣式補強（`src/styles.css`、`src/itinerary.css`）
    - `src/styles.css`：未選取的 `.date-tabs` 按鈕改以文字顏色表示，移除 `opacity:.75`，兩種主題的文字對比都至少 4.5:1
    - `src/itinerary.css`：讓規劃行程與行程圖中取得焦點的元件不被黏在頂端的 `.topbar` 與手機版 `.section-tabs` 遮住（例如 `scroll-margin-top` 或 `scroll-padding-top`），並沿用既有的焦點外框；檢查並補齊 44 CSS 像素的點擊範圍、12 CSS 像素的字級，以及 `placeholder`、說明停用原因的文字與「已加入」標示的對比
    - _Requirements: 16.9, 16.10, 16.11, 16.12, 17.6_

  - [x] 15.2 撰寫 CSS 的靜態測試（`tests/itinerary-css.test.js`）
    - `src/itinerary.css` 的動畫只在 `@media (prefers-reduced-motion: no-preference)` 與 `:root[data-scene-motion=running|paused]` 下；列印規則；subgrid 的替代排列
    - 以 WCAG 相對亮度重新計算設計「插圖與顏色」的對比並斷言門檻；`src/itinerary.css` 中 `car-0` 至 `car-7` 的色碼依序與 `src/itinerary-model.js` 匯出的 `CAR_PALETTE` 相同；`scripts/build.mjs` 的串接清單包含 `itinerary.css`；`src/itinerary-editor.js` 與 `src/itinerary-poster.js` 用到的圖示名稱都在 `src/app.js` 的 `icons` 中
    - _Requirements: 12.9, 13.1, 13.8, 16.10, 17.5, 17.7, 設計：擴充點_

  - [x] 15.3 撰寫無障礙的瀏覽器測試（`tests/itinerary-a11y.e2e.js`）
    - 測試標題為 `[TC-ITIN-060]` 至 `[TC-ITIN-069]`
    - 只用鍵盤新增路線與活動；`aria-expanded` 與 `aria-controls`；展開、儲存、刪除與取消後的焦點位置；`#toasts` 的結果文字；320 與 1440 CSS 像素的點擊範圍與字級；兩種主題計算後的顏色對比；焦點外框與不被頂端元素遮住；錯誤欄位的 `aria-invalid` 與 `aria-describedby`；行程圖的標題層級、清單與 `time` 元素
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8, 16.9, 16.10, 16.11, 16.12, 16.13, 16.14_

  - [x] 15.4 撰寫版面的瀏覽器測試（`tests/itinerary-layout.e2e.js`）
    - 測試標題為 `[TC-ITIN-070]` 至 `[TC-ITIN-079]`；行程圖文字的測試標記 `@critical`
    - 需求 23.6：Example_Trip 在 320、390 與 1440 CSS 像素（以 `page.setViewportSize` 設定）與 `light`、`dark` 的每一種組合下的版面、行程圖文字與順序，以及一個路線區塊有 8 台車、每台 6 個 Stop 的壓力資料
    - 另以一個路線區塊有 8 條路線、3 個交錯終點組的 Trip_State，在相同的寬度與主題下確認沒有頁面層級的水平捲動、路線圖中直接包含文字的元素邊界框兩兩不相交、不同組的 `.rm-road` 邊界框互不相交，且每組的停車位都在該組的 `.rm-end` 內、彼此不相交
    - 視窗寬度跨越 760 CSS 像素時，保留檢視、正在編輯的日子、展開的卡片、Draft 與鍵盤焦點
    - _Requirements: 11.5, 11.6, 11.13, 11.14, 11.15, 12.10, 17.1, 17.2, 17.3, 17.4, 17.8, 23.6_

  - [x] 15.5 把新的瀏覽器測試加入 QA_Inventory（`qa/inventory.json`、`qa/tc-map.md`）
    - 依既有格式為已完成的任務 9.10、11.18 至 11.20、13.4 至 13.7、15.3 與 15.4 的 TC ID 加入項目與對照列，`critical` 與測試標題的 `@critical` 一致；`bun scripts/qa-inventory.mjs validate` 通過
    - _Requirements: 23.12_

- [x] 16. README
  - [x] 16.1 改寫 README（`README.md`）
    - `## Features` 中以 `**Itinerary:**` 開頭的項目（保留開頭）依需求 24.1 的 (a) 至 (h) 與 24.2 改寫；`**Invitations and permissions:**` 依需求 24.6 改寫
    - `## Plan a trip` 維持 9 個步驟的主題與順序：第 2 步依需求 24.3 說明旅伴、車輛與地點清單；第 3 步依序說明 (a) 至 (g)；第 8 步以 activity 稱呼出發模式顯示的下一個未完成項目
    - 移除需求 24.4 列出的英文片語，以及對已移除介面與 Vehicle_Dialog 出發欄位的描述；其餘文字以英文撰寫，介面名稱以粗體繁體中文寫出，「行程圖」「規劃行程」「地點與車」「常用活動」「未分配採買清單」「文字版」「複製文字」第一次出現時在後方括號附英文說明
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.5, 24.6_

  - [x] 16.2 撰寫 README 的測試（`tests/readme.test.js`）
    - 新增 describe：`**Itinerary:**` 與 `**Invitations and permissions:**` 項目包含必要的介面名稱與說明；`## Plan a trip` 仍為 9 步，第 3 步的 (a) 在其他各點之前、(g) 在之後；不含需求 24.4 的片語；七個介面名稱第一次出現時附英文說明
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.5, 24.6_

- [x] 17. 修改需求 23.11 列出的 Changed_Test
  - [x] 17.1 `tests/schedule-bar.e2e.js`
    - 檔案開頭加上註解，寫明「trip-planning-workflow-enhance」與改動原因
    - TC-SCHED-001 改量規劃行程的選日按鈕，在原有寬度與 3、8、15 天保留 mobile-smooth-swipe 需求 7.3 至 7.6 的檢查；移除「新增一站」位置規則的檢查
    - _Requirements: 4.3, 23.11_

  - [x] 17.2 `tests/app.e2e.js`
    - 檔案開頭加上同樣的註解
    - TC-DEMO-002 改為確認行程圖顯示「這趟旅行還沒有行程」；TC-DEMO-001 與日期變更的測試改計行程圖每一天的 Activity 數；TC-SWIPE-001 改用料理卡片；TC-DEMO-003 與響應式版面的測試改量規劃行程的選日按鈕
    - 以「新增一站」開啟對話框的測試：新增、編輯與移除活動改用規劃行程的自訂活動；深色模式與 Escape、損毀資料、放棄草稿、點背景關閉與另一分頁草稿改用仍存在的對話框
    - 新增車輛的測試移除「出發地點」欄位的步驟
    - _Requirements: 1.6, 1.8, 3.7, 7.5, 23.11_

  - [x] 17.3 `tests/mobile-swipe.e2e.js`
    - 檔案開頭加上同樣的註解
    - 左滑範例列與重新繪製的步驟改用料理卡片與料理菜單分頁，並確認規劃行程中沒有 `[data-swipe-row]`；TC-SWIPE-024 改點料理菜單分頁中位於每個左滑面板之外、點擊沒有其他作用的元素
    - _Requirements: 1.6, 23.11_

  - [x] 17.4 `tests/vehicle-itinerary.e2e.js`
    - 檔案開頭加上同樣的註解
    - Activity 的參加方式改在規劃行程的 Activity 卡片驗證；刪除仍被指定的 Vehicle 改從 Places_And_Cars 或 Trip_Menu 驗證；只移除依賴「按車查看行程」的檢查
    - _Requirements: 3.10, 7.6, 7.7, 23.11_

  - [x] 17.5 `tests/vehicle-departures.e2e.js`
    - 檔案開頭加上同樣的註解
    - 改測 Legacy_Departure 在行程圖、規劃行程與 Trip_Menu 的顯示、「轉成路線」與「不使用舊資料」；TC-VEH-001 至 TC-VEH-003 保留 TC ID，改測對應的新介面（例如從 Places_And_Cars 編輯或刪除車輛後 Trip_Menu 同步）
    - _Requirements: 3.8, 19.3, 19.4, 19.5, 19.6, 19.7, 23.11_

  - [x] 17.6 `tests/maps.e2e.js`
    - 檔案開頭加上同樣的註解
    - 改從行程圖的 Activity 地點（與旅行目的地不同）與舊出發地點檢查地圖連結
    - _Requirements: 11.10, 11.17, 23.11_

  - [x] 17.7 `tests/security-xss.e2e.js`
    - 檔案開頭加上同樣的註解
    - TC-XSS-003 在行程表分頁檢查行程圖與展開的 Text_Panel
    - _Requirements: 22.2, 23.11_

  - [x] 17.8 `tests/accounts.test.js`
    - 檔案開頭加上同樣的註解
    - 「members cannot remove existing items through whole-state PUT; owners can」：把 `s => { s.activities = []; }` 移出預期 403 的清單；在 403 檢查與 `revision` 比對之後，另以受邀旅伴送出移除全部 Activity 的 `PUT`，預期回應成功並保存移除；其他移除仍預期 403
    - _Requirements: 21.3, 21.7, 23.11_

  - [x] 17.9 清查其他 Changed_Test
    - 確認 `tests/` 中除了確認元素不存在的斷言外，不再使用 `.timeline`、`.activity-card`、`.schedule-bar`、`.schedule-intro`、`.vehicle-departures`、`.departure-vehicle`、`[data-vehicle-departure]`、`#schedule-vehicle`、「新增一站」按鈕，以及以「出發時間（選填）」或「出發地點」標籤取得的 Vehicle_Dialog 欄位
    - 執行完整的單元與瀏覽器測試；其他因本功能而失敗的既有測試依需求 23.11 的規則修改（檔案開頭的註解、只在行為已不存在時移除檢查），不新增 `skip`、`only`、`todo` 或 `fixme`
    - _Requirements: 23.11, 23.12_

- [~] 18. Final checkpoint - 全部測試
  - 依 README「測試」一節，在 `bun run build` 之後執行以下三個指令，都以結束碼 0 完成：`bun test tests/*.test.js`（PowerShell 為 `bun test ./tests/`）、`node scripts/check-accounts.mjs`（desktop 與 mobile project）、`bun scripts/security-suite.mjs`。確認除了 Changed_Test 依需求 23.11 修改或移除的檢查外，沒有刪除既有測試，也沒有新增 `skip`、`only`、`todo` 或 `fixme`。Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 23.12_

## Notes

- 標記 `*` 的子任務為選用（property test、範例測試與瀏覽器測試），可為加快 MVP 而略過。需求 23 的條款只由這些選用任務驗證，略過時對應的 23.x 條款不會被驗證。
- 任務 17 的 Changed_Test 不是選用：這些既有測試依賴已移除的介面，不修改就無法讓需求 23.12 的三個指令通過。任務 17.8 只依賴任務 7.2，排在第 10 波，讓之後檢查點的單元測試全部通過；其他 Changed_Test 依賴最後的畫面，排在最後幾波。
- 每個任務都標註需求編號；Property 編號對應設計文件「Correctness Properties」。Property 2（任務 11.15）放在行程圖之後，因為它也檢查 `posterHtml()` 與 `editorHtml()` 不擲出例外；Property 9（任務 5.5）放在編輯模組之後，因為它以 `itinerary-edits.js` 的函式套用操作；Property 19（任務 11.6）檢查 `posterHtml()` 輸出的顏色類別，所以放在路線圖之後。Property 22（任務 2.7）與 Property 23（任務 11.21）為了不改動既有編號，附加在父任務的最後，在波次中則緊接在它們測試的程式之後：2.7 測試任務 2.2 的 `endGroups()` 與 `ends`，因任務 2.4 在第 4 波修改同一個模組而排在第 5 波；11.21 測試任務 11.4 的 `routeMapLayout()` 與路線圖，排在第 23 波。
- 任務 13 完成之前，Trip_Settings_Dialog 仍以舊規則搬移日期（不移動路線與每日設定），Vehicle_Dialog 仍有出發欄位，刪除車輛也不檢查路線。開發期間在有路線的旅行上改日期或刪車，可能產生 State_Validator 不接受的資料。
- 波次的安排：同一個檔案的任務放在不同的波次；測試任務不與它所測試的模組的修改放在同一波；瀏覽器測試共用 `dist/` 與連接埠 5181，因此每一波最多一個瀏覽器測試任務，而且不與修改 `src/` 的任務同一波。
- 新的瀏覽器測試需要 Node、`CHROME_PATH` 與 `CAMPING_BUN`；單元測試與瀏覽器測試都需要 README「測試」一節的 Ephemeral_Database。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.5"] },
    { "id": 2, "tasks": ["1.2", "1.3", "1.4", "1.6", "1.7", "2.1", "4.1"] },
    { "id": 3, "tasks": ["1.8", "1.9", "1.10", "2.2", "4.3", "4.4"] },
    { "id": 4, "tasks": ["2.4", "3.1", "5.1"] },
    { "id": 5, "tasks": ["2.3", "2.5", "2.6", "2.7", "3.2", "3.3", "3.4", "4.2", "5.3"] },
    { "id": 6, "tasks": ["5.2", "5.4", "5.5", "5.6"] },
    { "id": 7, "tasks": ["7.1"] },
    { "id": 8, "tasks": ["7.2"] },
    { "id": 9, "tasks": ["7.3"] },
    { "id": 10, "tasks": ["7.4", "17.8"] },
    { "id": 11, "tasks": ["9.1", "9.2"] },
    { "id": 12, "tasks": ["9.3"] },
    { "id": 13, "tasks": ["9.4"] },
    { "id": 14, "tasks": ["9.5"] },
    { "id": 15, "tasks": ["9.6"] },
    { "id": 16, "tasks": ["9.7"] },
    { "id": 17, "tasks": ["9.8"] },
    { "id": 18, "tasks": ["9.9"] },
    { "id": 19, "tasks": ["9.10"] },
    { "id": 20, "tasks": ["11.1"] },
    { "id": 21, "tasks": ["11.2"] },
    { "id": 22, "tasks": ["11.4"] },
    { "id": 23, "tasks": ["11.3", "11.5", "11.6", "11.7", "11.21"] },
    { "id": 24, "tasks": ["11.8"] },
    { "id": 25, "tasks": ["11.9"] },
    { "id": 26, "tasks": ["11.10", "11.11", "11.12"] },
    { "id": 27, "tasks": ["11.13"] },
    { "id": 28, "tasks": ["11.14"] },
    { "id": 29, "tasks": ["11.15", "11.16", "11.17", "11.18"] },
    { "id": 30, "tasks": ["11.19"] },
    { "id": 31, "tasks": ["11.20"] },
    { "id": 32, "tasks": ["13.1"] },
    { "id": 33, "tasks": ["13.2"] },
    { "id": 34, "tasks": ["13.3"] },
    { "id": 35, "tasks": ["13.4"] },
    { "id": 36, "tasks": ["13.5"] },
    { "id": 37, "tasks": ["13.6"] },
    { "id": 38, "tasks": ["13.7"] },
    { "id": 39, "tasks": ["15.1", "16.1"] },
    { "id": 40, "tasks": ["15.2", "15.3", "16.2"] },
    { "id": 41, "tasks": ["15.4"] },
    { "id": 42, "tasks": ["15.5", "17.1"] },
    { "id": 43, "tasks": ["17.2"] },
    { "id": 44, "tasks": ["17.3"] },
    { "id": 45, "tasks": ["17.4"] },
    { "id": 46, "tasks": ["17.5"] },
    { "id": 47, "tasks": ["17.6"] },
    { "id": 48, "tasks": ["17.7"] },
    { "id": 49, "tasks": ["17.9"] }
  ]
}
```
