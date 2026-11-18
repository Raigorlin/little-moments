# Requirements Document

## Introduction

本功能改版「日子拾光 / LITTLE MOMENTS」的行程表分頁（`src/app.js` 的 `schedule()`）。使用者認為目前行程表的規劃方式與顯示方式都不直覺：規劃時要逐站填寫活動表單，各車出發只出現在第 1 天，採買與接人要另外新增一站並指定車輛；顯示則是一條很長的活動卡片時間軸。

改版後，行程表分頁分成兩種檢視：

- **行程圖**（Itinerary_Poster）：以原創手繪插畫與動畫呈現整趟旅行，取代時間軸。每一天顯示幾台車從哪裡出發、途中在哪裡停留做什麼、預計幾點抵達，以及營區裡的活動與餐點。
- **規劃行程**（Itinerary_Editor）：以勾選與選單為主的編輯器，把每一天的路線、途中任務、活動與餐點記成結構化資料。

行程圖與文字版（Itinerary_Text）都由同一份結構化資料產生。文字版使用使用者提供的範例格式，可以複製貼到聊天群組，也是行程圖的文字替代內容。本功能同時適用本機版（`/demo/`）與帳號版。

每位能編輯旅行的成員都能使用「行程圖」與「規劃行程」：本機版的使用者，以及帳號版的旅行建立者、管理員與受邀旅伴。受邀旅伴也可以刪除行程表中的路線、途中任務、活動與地點；其他分頁與旅行選單的刪除規則不變。只有帳號的權限顯示不能編輯時，才只看到行程圖（Viewer）；App 目前不會建立這種帳號（伺服器只讓能編輯的成員開啟旅行），所以受邀旅伴不是 Viewer。

### 使用者已確認的事項

| 編號 | 事項 | 來源 |
| --- | --- | --- |
| U1 | 目前行程表的規劃方式與顯示方式都不直覺。 | 使用者第 2 則訊息 |
| U2 | 行程以勾選、選擇的方式規劃。 | 使用者第 2 則訊息 |
| U3 | 料理菜單的內容自動帶到行程上，顯示料理名稱與食材。 | 使用者第 2 則訊息與範例 |
| U4 | 以動圖取代時間軸，呈現有幾台車、各從哪裡出發、途中經過與停留哪些地點、大約幾點抵達營區、有哪些活動；畫面要更乾淨、簡單、直覺。 | 使用者第 2、3 則訊息 |
| U5 | 編輯器的主要目的是文本格式化，讓行程內容格式一致；動圖呈現整個行程的進程與規劃。 | 使用者第 3 則訊息 |
| U6 | 呈現方式由開發方決定。 | 使用者第 3 則訊息 |
| U7 | 文字版可以複製（例如貼到 LINE）；不提供貼上文字匯入。 | 澄清問題 1 |
| U8 | 建立地點清單，並在規劃行程中提供「地點與車」區塊，集中管理地點與車輛；路線的出發地、停靠點與終點從清單選擇，也能就地新增地點；旅行選單的車輛仍編輯同一份資料。 | 澄清問題 2 |
| U9 | 採買停靠點要買的品項自動帶入：品項的「誰負責買」是哪台車的駕駛或乘客，就列在那台車的採買停靠點，不在停靠點勾選；找不到對應車輛或停靠點的品項列在「未分配採買清單」；行程圖與文字版列出品項名稱，不列數量與分類。 | 澄清問題 3；對六項決定的回覆第 2 點與後續回覆 |
| U10 | 受邀旅伴也要能編輯行程，不是只能看行程圖。 | 對六項決定的回覆 |
| U11 | 行程表開放受邀旅伴刪除：受邀旅伴可以刪除路線、途中任務、活動與地點；其他分頁與旅行選單維持原本的規則，受邀旅伴仍不能刪除旅伴、料理、採買品項、裝備與車輛。 | 後續回覆 |
| U12 | 車輛數由使用者自訂。 | 對六項決定的回覆第 1 點 |
| U13 | 使用者確認下列決定：Example_Trip 加上第四車第 1 天的路線，會合車數依路線計算（D5）；每天的出發時間與地點改由路線記錄，舊資料可以轉成路線（D6）；移除「按車查看行程」（D8）；列印只印行程圖與它自己的列印封面、使用淺色、不印文字版（D24）；動畫遵守系統的減少動態設定，也可以暫停（需求 13.1 至 13.5）。 | 對六項決定的回覆第 1、3、4、5、6 點 |
| U14 | 使用者列出日後要追加的功能 F1 至 F9（見「日後擴充功能（保留）」），要求記錄下來，並在設計中預留擴充點。 | 日後擴充功能的訊息與保留方式的澄清問題 |

### 現況調查摘要

| 項目 | 現況（依原始碼） | 對本功能的影響 |
| --- | --- | --- |
| 行程表 | `schedule()` 依序顯示 Schedule_Bar（日期按鈕與「新增一站」）、只在第 1 天出現的「各車出發」卡片（`vehicleDepartureSection()`）、「按車查看行程」下拉選單（`vehicleScheduleFilter()`），以及當天活動的直式時間軸（`.timeline` 內的 `.activity-card`，手機可左滑編輯或刪除）。 | 這些介面由行程圖與規劃行程取代。 |
| 活動 | `state.activities` 每筆有 `date`、`time`（必填，`HH:MM`）、`title`、`type`（meet、market、camp、meal、night、travel）、`location`、`note`、`people`、`done`，選填 `vehicleIds`。出發模式（`#/go`）用 `done` 決定下一站。 | 活動類別沿用並擴充 `type`，既有六種值保持有效。 |
| 車輛 | `state.vehicles` 每台有 `name`、`driver`、`seats`、`passengers`、`meeting`。`meeting` 是「HH:MM · 地點」或自由文字，只代表第 1 天的出發（`vehicleDepartures()` 只在開始日回傳）。車輛在旅行選單（`src/trip-menu.js`）與行程表第 1 天新增、編輯與刪除；仍被活動指定的車不能刪除。`isValidState()` 允許最多 1,000 台車、每台 1 到 9 個座位，只檢查同一台車的乘客不重複且不含駕駛，駕駛可以是待分配（空字串）；Vehicle_Dialog 的乘客欄位列出全部旅伴，因此同一位旅伴可以同時是多台車的駕駛或乘客。 | 每天每台車的出發改由路線記錄；`meeting` 成為舊出發資料。車輛數由使用者決定；同一位旅伴在多台車時，他負責買的品項依 D29 決定由哪台車買。 |
| 地點 | 沒有地點清單。活動地點（最多 150 字）、車輛出發地點與旅行目的地（最多 100 字）是各自的文字欄位。 | 新增地點清單。 |
| 料理 | `state.meals` 每筆有 `date`、`slot`（早餐、午餐、下午茶、晚餐、消夜，或舊資料的自訂餐次）、`title`、`cookId`、`servings`、`ingredients`、`notes`，選填 `imageKind`；沒有時間欄位。`dishIllustration()` 依料理類型畫插圖，通用餐盤（`custom`）每次畫面更新隨機換一種圖案。 | 餐點要有時間才能排進行程；行程圖的餐點圖案要固定。 |
| 採買 | `state.shopping` 每筆有 `name`、`quantity`、`category`（`SHOPPING_CATEGORIES` 共 11 類）、`assignee`（旅伴）、`done`，選填 `source`、`mealIds`、`recipeRemoved`。`syncMealIngredients()` 會自動新增或移除由料理產生的品項，新增的品項 `assignee` 為空字串（待分配）。 | 採買停靠點要買的品項由 `assignee` 與車輛的駕駛、乘客推導（需求 6.11），不新增欄位；品項新增、移除或換負責人時，行程圖與文字版跟著改變。 |
| 伺服器 | 帳號版 `PUT /api/trips/:id` 先用 `cleanState()` 只保留已知欄位，再用與前端共用的 `isValidState()` 驗證。`guardCollaborator()` 禁止受邀旅伴移除 people、activities、meals、gear、vehicles 的既有項目，`guardShoppingRemoval()` 禁止受邀旅伴移除既有的採買品項（料理食材同步自動移除的品項除外）。`applyCardToState()` 在旅行卡片改日期或匯入舊手冊時平移活動與餐點的日期，放不下時回應 400。旅行內容存在 `trips.state_json`。 | 新欄位若沒有加入 `cleanState()` 會被靜默丟棄；受邀旅伴移除既有活動改為允許，新集合也不加入刪除限制（U11、需求 21.3、21.7）；新集合要納入日期平移。不需要資料庫遷移。 |
| 權限 | 帳號版：旅行建立者與管理員 `canDelete`；受邀旅伴 `canEdit` 但不能刪除；`tripAccess()` 只讓 `canEdit` 為 true 的帳號開啟旅行，因此每位能開啟旅行的成員都能編輯，App 目前不會建立只能檢視的帳號。本機版沒有權限限制。 | 每位能編輯的成員（含受邀旅伴）都能使用規劃行程；行程表中的路線、途中任務、活動與地點開放受邀旅伴刪除（U11），其他分頁與旅行選單沿用原本的刪除規則。 |
| 動畫 | `src/scene-motion.js` 以 `<html data-scene-motion>`（static、reduced、paused、running）與 localStorage `ggc-scene-motion` 控制插畫動畫；旅行選單有「插畫動畫」暫停／播放按鈕；系統設定減少動態時插畫保持靜態；列印時停用動畫。 | 行程圖的動畫沿用同一個設定。 |
| 插畫 | `src/art.js` 以程式產生原創手繪風 SVG，色票為紙色、墨線、珊瑚、暖黃、天空藍與草綠。 | 行程圖沿用相同風格與色票，不使用參考圖原圖。 |
| 安全 | 使用者內容寫入 HTML 前一律經 `escape`；CSP 為 `script-src 'self'`、`img-src 'self' data: blob:`、`connect-src 'self'`；地圖連結只由 `mapLink()` 產生固定的 Google Maps 網址。 | 行程圖與文字版遵守相同規則，不載入外部圖資。 |

### 開發方的設計決定

使用者授權由開發方決定呈現方式。下列決定可由使用者否決；否決時調整「影響需求」欄列出的條款。理由欄標示「使用者已確認」的決定，使用者已經同意（U13）。

| 編號 | 決定 | 理由 | 影響需求 |
| --- | --- | --- | --- |
| D1 | 行程表分頁以「行程圖」「規劃行程」兩個選項切換，預設顯示行程圖；每位能編輯的成員（本機版的使用者、旅行建立者、管理員與受邀旅伴）都看得到兩個選項，只有權限顯示不能編輯的帳號只看到行程圖（App 目前不會建立這種帳號）。 | 看與改分開，畫面較乾淨；使用者要求受邀旅伴也能編輯（U10）。 | 1、21 |
| D2 | 行程圖一次顯示整趟旅行，每天一段。畫面上不重複旅行名稱與介紹（上方的旅行封面已經顯示），列印時才加上完整封面。 | 同一頁不出現兩次相同資訊。 | 11、13 |
| D3 | 動畫只移動車子與裝飾（營火、蒸氣、星星）；文字一律直接顯示，不靠動畫逐步出現。 | 任何時刻都能讀到完整資訊。 | 12 |
| D4 | 每台車每天最多一條路線，每條路線最多 6 個途中任務，出發時間可以留空。 | 參考編輯器的提示：「每台車可安排 6 個停靠點，時間可稍後填。」 | 5、6、18 |
| D5 | 「預計抵達時間」記在每一天，套用到當天開往當天地點的路線；會合車數由路線自動計算，並在規劃行程提醒哪台車還沒有路線。App 不估算行車時間，也不預估返抵時間。 | 範例第 1 天寫「四車會合」卻只有三條路線；自動計算讓文字與資料一致。使用者已確認。 | 4、9、14 |
| D6 | 車輛對話框不再編輯出發時間與地點，改由每天的路線記錄。舊的 `meeting` 資料保留，在第 1 天顯示為舊出發資料，可以一鍵轉成路線。 | 出發資訊只有一個來源。使用者已確認。 | 3、19 |
| D7 | 封面文字沿用「編輯旅行」的旅行名稱與旅行介紹，天數與日期由旅行日期計算；調整日期與天數仍在「編輯旅行」。不另做封面編輯器。 | 不重複既有欄位與日期規則。 | 4、13、14 |
| D8 | 移除「按車查看行程」。每台車的路線有自己的顏色與車名標示，活動列出參加的車。 | 少一個控制項；行程圖已經區分各車。使用者已確認。 | 1、11 |
| D9 | 規劃行程中的卡片以展開／收起和明確的按鈕編輯與刪除，不使用左滑。料理、採買、裝備等其他分頁的左滑不變。 | 參考編輯器使用展開卡片；一張卡片只有一種操作方式。 | 1、23 |
| D10 | 活動以「常用活動」勾選加入，也可以新增自訂活動；第 1 天、中間的日子與最後一天各有不同的建議。 | 符合「以勾選規劃」。 | 7 |
| D11 | 餐點時間依餐次預設（早餐 08:30、午餐 12:00、下午茶 15:00、晚餐 18:00、消夜 21:00），可在規劃行程中修改；料理名稱與食材只在料理菜單修改。 | 範例的餐點時間與這些預設相同。 | 8 |
| D12 | 採買清單分頁的品項顯示由哪一天、哪台車、在哪個地點採買，依需求 6.11 由「誰負責買」與車輛的駕駛、乘客推導。 | 在採買清單也看得到路線上的分工；在改負責人的地方就看得到結果。 | 6 |
| D13 | 出發模式（`#/go`）維持現狀，不顯示路線。 | 控制範圍。 | 範圍外 |
| D14 | 旅行沒有任何路線、舊出發資料、活動與餐點時，行程圖在頂端概要之後顯示「這趟旅行還沒有行程」提示，取代空白的每日段落與結尾文字；文字版仍然顯示。 | 空白的每日段落沒有可看的內容；提示與「開始規劃」按鈕讓下一步更清楚。 | 1.8、11.19 |
| D15 | 規劃行程以「第 N 天」記住正在編輯的日子；旅行日期改變後仍編輯第 N 天，新的天數少於 N 時改為最後一天。 | 路線與每日設定也依第 N 天隨日期移動，停在同一個第 N 天就是停在同一份內容。 | 4.12、20.1 |
| D16 | 地點清單中的地點不能與旅行目的地同名；仍有路線或停靠點使用旅行目的地時，不能把旅行目的地清空。 | 同名時無法在地點選單中分辨兩個選項；目的地清空後，使用它的路線會失去起點、終點或停靠點。 | 2.9、2.10、18.4 至 18.6 |
| D17 | 把旅行目的地選為某一天的地點，表示這一天跟著旅行目的地：每日設定把地點存為未設定，不儲存旅行目的地。 | 修改旅行目的地時，這些日子自動顯示新的目的地，不必逐天修改；同一個意思也只有一種存法。 | 2.4、4.10、18.7 |
| D18 | 在料理菜單改變餐點的餐次時，清除該餐點的自訂時間，改用新餐次的預設時間。 | 自訂時間是為原本的餐次設定的，例如午餐改成晚餐後仍顯示 12:00 會讓人誤會。 | 8.4 |
| D19 | 通用餐盤的餐點在行程圖固定使用一種圖案；料理菜單分頁維持隨機。 | 行程圖每次更新都換圖會讓畫面跳動，螢幕與列印的圖案也會不同。 | 8.10 |
| D20 | 縮短旅行天數時，被移除的日子還有路線或每日設定（標題或地點）就拒絕儲存。 | 不悄悄刪除排好的路線與設定，由使用者先決定要刪除或移到其他天。 | 20.2 |
| D21 | 行程表的刪除開放受邀旅伴（U11）：每位 Editor_User 都可以刪除地點、路線、途中任務與活動，不論是否已儲存；刪除車輛仍需要刪除權限（旅行建立者或管理員；本機版不限制），在「地點與車」與旅行選單都一樣。伺服器不再拒絕受邀旅伴移除既有的活動、地點、路線與途中任務，移除旅伴、料理、採買品項、裝備與車輛仍拒絕。 | 使用者決定行程表開放受邀旅伴刪除；車輛也在旅行選單管理，刪除車輛沿用旅行選單既有的權限，其他分頁不在這次改版範圍。 | 3.11、5.4、6.14、7.11、10.7、10.8、21.2、21.3、21.6、21.7、21.10 |
| D22 | 動畫時間：出發時間不同的各組車相隔 0.4 至 0.8 秒出發（超過 8 組時可以縮短），每個停靠點停 0.6 至 1 秒，每一輪 4 至 12 秒，到達後停 2 至 4 秒再重播。 | 看得出出發的先後與停靠，一輪又不會長到需要久等。 | 12.2 至 12.4 |
| D23 | 版面在 760 CSS 像素切換：760 以下（含）路線圖由上往下排列，超過 760 由左往右排列，與既有手機版面的斷點相同。 | 與網站其他畫面在同一個寬度切換版面。 | 17.2、17.3、17.8 |
| D24 | 在行程表列印時，只列印行程圖與它自己的列印封面，並一律使用淺色主題的顏色；網站頁首、麵包屑、旅行封面與文字版都不列印。 | 印出的行程可以單獨閱讀，封面資訊不重複；淺色也比較省墨。使用者已確認。 | 13.6 至 13.8、15.9、17.9 |
| D25 | 活動卡片保留「日期」欄位，可以把活動移到其他日子。 | 舊的活動對話框有日期欄位；直接改日期可以保留活動的完成狀態與識別碼，不必刪除再重建。 | 7.5、7.6、7.12 |
| D26 | 採買停靠點沒有「備註」欄位，改由自動帶入的採買品項說明要買什麼。 | 行程圖與文字版只顯示採買品項的摘要，不顯示採買停靠點的備註；不會顯示的內容就不讓人填寫。 | 6.4、11.7、14.10 |
| D27 | 以中文數字表示的數值達 100 以上時，改用阿拉伯數字，例如「120台車」。 | 既有驗證允許最多 1,000 台車；限制車輛數會讓既有的旅行無法通過驗證（需求 18.12）。 | 詞彙表的 Chinese_Numeral |
| D28 | 一台車在整趟旅行有多個採買停靠點時，它的品項全部列在第一個（最早的一天；同一天時是路線上最前面的停靠點）；之後的採買停靠點只顯示「{地點}（採買）」，規劃行程在那一天提醒品項列在第一個停靠點。 | 品項只由負責人與車輛決定，資料中沒有哪一站買哪些東西；固定列在第一站，每個品項只出現一次。 | 6.6、6.9、6.11、9.5、14.10 |
| D29 | 同一位旅伴是兩台以上車輛的駕駛或乘客時，他負責買的品項算在 `state.vehicles` 中排在最前面的那台車（Buyer_Car），並在其他車的第一個採買停靠點說明。 | 既有資料允許同一人出現在多台車；依車輛順序決定，結果固定，也不必另外限制乘客。 | 6.6、6.11 |
| D30 | 駕駛或乘客有負責買的品項、但這台車沒有任何採買停靠點時，只在「未分配採買清單」以「{車名}還沒有採買停靠點」說明，不產生每日的規劃提醒。 | 這種情況不屬於任何一天；放在一處說明，選日按鈕的提醒數也不受影響。 | 6.8、9.5 |
| D31 | 採買停靠點的品項預覽依採買清單的順序列出品項名稱並標示「已買」，不分組也不列數量；預覽跟著卡片中尚未儲存的修改更新，規劃提醒與其他畫面仍依已儲存的內容。 | 與行程圖、文字版的順序相同，預覽保持簡短；儲存前就看得到換車或調整停靠點的結果。 | 6.6 |

### 活動類別與常用活動

活動類別（Activity_Category）決定插圖，以及文字版括號中的標籤：

| 類別（文字版標籤） | 用途 | 既有活動類型 |
| --- | --- | --- |
| 集合 | 集合、碰面 | meet（原標籤「集合」） |
| 採買 | 採買補給 | market（原標籤「採買補給」） |
| 營地時光 | 一般的營地活動，也是自訂活動的預設類別 | camp（原標籤「營地時光」） |
| 用餐 | 不在料理菜單中的用餐活動 | meal（原標籤「一起吃飯」） |
| 夜晚 | 夜間活動 | night（原標籤「星空時間」） |
| 移動 | 在路上 | travel（原標籤「在路上」） |
| 起床 | 起床 | 新增 |
| 搭帳 | 搭帳、營地佈置 | 新增 |
| 自由活動 | 自由活動、拍照 | 新增 |
| 下午茶／遊戲 | 下午茶、聊天、玩遊戲 | 新增 |
| 拆帳 | 拆帳、整理裝備 | 新增 |
| 清潔 | 環境清潔、裝車 | 新增 |
| 返程 | 集合、準備返程 | 新增 |

常用活動（Activity_Preset）依日子建議如下。「中間的日子」是 First_Day 與 Last_Day 以外的日子；一天的旅行同時建議 First_Day 與 Last_Day 的項目。

| 建議的日子 | 預設標題 | 預設時間 | 類別 |
| --- | --- | --- | --- |
| First_Day | 搭帳・營地佈置 | 13:00 | 搭帳 |
| First_Day | 星空夜聊・自由活動 | 20:00 | 夜晚 |
| 中間的日子 | 起床 | 08:00 | 起床 |
| 中間的日子 | 自由活動、拍照 | 10:00 | 自由活動 |
| 中間的日子 | 下午茶、聊天、玩遊戲 | 14:00 | 下午茶／遊戲 |
| 中間的日子 | 自由活動 | 20:00 | 夜晚 |
| Last_Day | 起床 | 08:00 | 起床 |
| Last_Day | 拆帳、整理裝備 | 10:00 | 拆帳 |
| Last_Day | 環境清潔、裝車 | 11:30 | 清潔 |
| Last_Day | 集合、返程 | 12:00 | 返程 |

### 範例行程與預期文字版

Example_Trip 是使用者範例加上參考行程圖中第四車的路線，用來驗收文字版：

- 旅行名稱「夕淞度日」，目的地「夕淞度日營區」，日期 2026-10-20 至 2026-10-22。旅行介紹有兩行：「一起，把日子過慢一點。」與「把喜歡的小地方，畫進我們的旅程。」
- 旅伴依序為小安、阿哲、小雨、阿森、米米、大海、阿凱、小芸。
- 車輛依序為第一車（駕駛小安，乘客阿哲）、第二車（駕駛阿森，乘客米米）、第三車・採買組（駕駛小雨，乘客大海）、第四車（駕駛阿凱，乘客小芸），每台 4 個座位。
- 地點清單依序為出發地點 A、出發地點 B、出發地點 C、出發地點 D、超市／賣場、台北。三天都沒有另外設定地點，因此 Day_Location 都是旅行目的地。
- 採買清單依序包含五花肉片（肉類）、鮮蝦（海鮮）、高麗菜（蔬菜）、運動飲料（飲料）、洋芋片（零食）、瓦斯（其他）、衛生紙（其他）、免洗餐具（其他），都還沒買。前三項的「誰負責買」是小雨，後五項是大海，兩人都在第三車・採買組；第三車・採買組只有第 1 天在超市／賣場一個採買停靠點，因此八個品項都列在這個停靠點（需求 6.11）。料理的食材（例如培根、炒蛋）依既有的料理食材同步加入採買清單時，「誰負責買」是待分配，因此列在「未分配採買清單」，不影響 Example_Text。
- 第 1 天：標題「向山裡出發」，預計抵達時間 12:00。路線：第一車 08:00 從出發地點 A 到夕淞度日營區；第二車 08:30 從出發地點 B 到夕淞度日營區；第三車・採買組 09:00 從出發地點 C 出發，途中在超市／賣場採買，再到夕淞度日營區；第四車 09:30 從出發地點 D 到夕淞度日營區。活動：13:00 搭帳・營地佈置（搭帳）、20:00 星空夜聊・自由活動（夜晚）。餐點：晚餐「烤肉派對」，沒有食材。
- 第 2 天：標題「住進慢慢的日子」。活動：08:00 起床（起床）、10:00 自由活動、拍照（自由活動）、14:00 下午茶、聊天、玩遊戲（下午茶／遊戲）、20:00 自由活動（夜晚）。餐點：早餐「早餐」（培根、炒蛋、吐司、咖啡）、午餐「午餐」（台式炒泡麵、香腸、煎蛋）、晚餐「豪華火鍋」，沒有食材。
- 第 3 天：標題「把快樂一起帶回家」。活動：08:00 起床（起床）、10:00 拆帳、整理裝備（拆帳）、11:30 環境清潔、裝車（清潔）、12:00 四車集合、返程（返程）。餐點：早餐「早餐」（蘿蔔糕、荷包蛋、熱狗、咖啡）。路線：四台車都在 12:00 從夕淞度日營區出發前往台北。
- 所有餐點都使用餐次的預設時間；所有活動的參加者都是全體旅伴，沒有地點與備註。

Example_Text（Example_Trip 的預期文字版）：

```text
夕淞度日｜三天兩夜

一起，把日子過慢一點。

把喜歡的小地方，畫進我們的旅程。

車輛：第一車、第二車、第三車・採買組、第四車

第 1 天・10/20（週二）｜向山裡出發
地點：夕淞度日營區

路線
第一車｜08:00 出發：出發地點 A → 夕淞度日營區
第二車｜08:30 出發：出發地點 B → 夕淞度日營區
第三車・採買組｜09:00 出發：出發地點 C → 超市／賣場（採買：五花肉片、鮮蝦、高麗菜、運動飲料、洋芋片、瓦斯、衛生紙、免洗餐具） → 夕淞度日營區
第四車｜09:30 出發：出發地點 D → 夕淞度日營區
預計 12:00 抵達・四車會合

活動
13:00 搭帳・營地佈置（搭帳）
18:00 晚餐：烤肉派對（烤肉）
20:00 星空夜聊・自由活動（夜晚）

第 2 天・10/21（週三）｜住進慢慢的日子
地點：夕淞度日營區

活動
08:00 起床（起床）
08:30 早餐（早餐）
培根、炒蛋、吐司、咖啡

10:00 自由活動、拍照（自由活動）
12:00 午餐（午餐）
台式炒泡麵、香腸、煎蛋

14:00 下午茶、聊天、玩遊戲（下午茶／遊戲）
18:00 晚餐：豪華火鍋（火鍋）
20:00 自由活動（夜晚）

第 3 天・10/22（週四）｜把快樂一起帶回家
地點：夕淞度日營區

活動
08:00 起床（起床）
08:30 早餐（早餐）
蘿蔔糕、荷包蛋、熱狗、咖啡

10:00 拆帳、整理裝備（拆帳）
11:30 環境清潔、裝車（清潔）
12:00 四車集合、返程（返程）

路線
第一車｜12:00 出發：夕淞度日營區 → 台北
第二車｜12:00 出發：夕淞度日營區 → 台北
第三車・採買組｜12:00 出發：夕淞度日營區 → 台北
第四車｜12:00 出發：夕淞度日營區 → 台北
平安返回台北・不預估返抵時間
```

Example_Text 與使用者範例的刻意差異：

1. 第 1 天多了「第四車｜09:30 出發：出發地點 D → 夕淞度日營區」（參考行程圖有「09:30 第四車・D」）。沒有這條路線時，到達行會是「預計 12:00 抵達・三車會合」，規劃行程會提醒「第四車這一天還沒有路線」。使用者已確認（U13）。
2. 採買內容列出第三車・採買組的駕駛與乘客負責買的品項名稱（需求 6.9、6.11），不寫「早餐、午餐食材…等用品」，也不列數量與分類。
3. 每一天之間、每個「路線」「活動」區塊之前都空一行，讓格式一致。

### 範圍外

- 貼上文字匯入行程。
- 把行程圖匯出成 GIF、影片或圖片檔（可以截圖或列印成 PDF）。自動產生 GIF 或 PNG 圖檔見日後擴充功能 F5、F6。
- 導航、即時位置、行車時間估算與返抵時間預估。
- 出發模式（`#/go`）顯示路線與停靠點。
- 天氣與日出日落（little-moments-expansion 的 B）。之後實作時接在行程圖每一天的段落；天氣顯示見日後擴充功能 F9。
- 新增主分頁，或改變主分頁的名稱與順序。

### 日後擴充功能（保留）

使用者列出下列日後要追加的功能（U14）。這些功能不屬於本功能的驗收條件，本功能不實作；design.md 說明讓這些功能日後可以加入的擴充點。「日後會調整的目前規則」欄列出加入該功能時要修改的需求、設計決定或範圍外項目；修改之前，這些條款照常適用。

| 編號 | 功能 | 日後會調整的目前規則 | 需要的條件 |
| --- | --- | --- | --- |
| F1 | 圖庫：可以用關鍵字搜尋圖片，圖片多為 PNG 或 GIF。 | 需求 11.16、12.9：插畫與動畫只用程式產生的內嵌 SVG 與 CSS，不用點陣圖或 GIF；需求 22.2：XSS 檢查要求 `img` 的 `src` 以 `blob:` 開頭；需求 22.4：不改 CSP、不連到其他來源（圖庫在其他來源時）。 | 同源或 CSP 允許來源的圖庫；關鍵字索引；原創或已取得授權的圖片；減少動態與暫停時 GIF 改為靜態（需求 13.1、13.5）。 |
| F2 | 使用者可以自由拖拉，調整行程的安排。 | D9：規劃行程以展開卡片與按鈕操作；需求 16.3：任何操作都不需要拖曳；需求 6.5：途中任務以「上移」「下移」排序。 | 保留不需拖曳的操作方式（WCAG 2.2 SC 2.5.7）；路線與活動依時間排序（需求 5.2、14.13），拖拉後以 F3 修改時間。 |
| F3 | 拖拉之後跳出視窗，可以編輯時間並自訂顏色。 | 需求 11.12、11.16、22.6：顏色只取自固定色票，Car_Color 依車輛順序決定；D9：時間在展開的卡片中編輯。 | 顏色欄位加入 State_Validator 與 `cleanState()`，只接受固定格式的色碼（例如 `#RRGGBB`）；對比符合需求 16.10。 |
| F4 | 背景圖可以自行選擇，也可以使用預設背景。 | 需求 11.16：不含點陣圖或外部圖片；需求 17.5：深色主題的底色只用深色色票；需求 13.8：列印使用白色頁面背景。 | 預設背景與可選的圖片放在同源位置（例如 F1 的圖庫）；文字對比符合需求 16.10。 |
| F5 | 按「完成編輯」後，自動產生 GIF 或 PNG 圖檔。 | 範圍外：不把行程圖匯出成 GIF、影片或圖片檔。 | 隨 App 提供的 GIF／PNG 編碼器（`script-src 'self'`）；「完成編輯」按鈕（目前每張卡片各自儲存，需求 10.4）。 |
| F6 | GIF 呈現行程的進程：編輯結束後，物件自動前進，依序顯示車子到營區、營區到特定地點（例如回家或還裝備）的過程。 | 範圍外：不匯出 GIF；需求 12.9：動畫只用 CSS 與內嵌 SVG；需求 12.4：車子動畫在每個 Route_Block 內各自循環。 | F5 的編碼器；依 Route 與 Stop（含取還裝備）的順序產生影格；在頁面上播放時遵守需求 13 的減少動態與暫停。 |
| F7 | 露營裝備也有圖庫：依使用者選擇的裝備，多提供幾個圖案讓使用者挑選；不挑選時使用預設圖案。 | 需求 11.16：插畫只用程式產生的內嵌 SVG；需求 11.7：取還裝備的途中任務固定畫裝備插圖。 | F1 的圖庫；依裝備名稱找出候選圖案的關鍵字；預設圖案。 |
| F8 | 食物也比照 F7，並自動挑選風格與食物最符合的圖案。 | 需求 11.16：插畫只用程式產生的內嵌 SVG；需求 8.10、D19：依料理插圖類型畫圖，通用餐盤固定一種圖案。 | F1 的圖庫；依料理名稱與食材比對圖案的規則；相同的 Trip_State 選出相同的圖案（需求 8.10）。 |
| F9 | 行程表加上天氣：依抵達營區前一小時的天氣預報，顯示自行設計的天氣圖案。 | 範圍外：天氣與日出日落（little-moments-expansion 的 B）。 | 經伺服器端代理取得預報（`connect-src 'self'`，需求 22.4）；營區座標（地點目前只有名稱，需求 18.4）；Arrival_Time（需求 4.8 已提供）。 |

### 與既有 spec 的關係

| Spec | 關係 |
| --- | --- |
| little-moments-expansion | 本功能取代其「C 行程時間軸視圖」（需求 14、15）：使用者已決定以行程圖取代時間軸，不再比較卡片視圖與時間軸。沿用其需求 1.1（維持 5 個主分頁）與 1.4（畫面上同時最多一個彈出視窗）。 |
| remove-vehicle-travel-tabs | 旅行選單的車輛新增、編輯、刪除保留，並與「地點與車」區塊編輯同一份車輛資料。 |
| mobile-smooth-swipe | 行程表不再有 Schedule_Bar 的「新增一站」與可左滑的活動卡片、車輛卡片。其需求 7 的日期按鈕規則（7.3 至 7.6）改用在規劃行程的選日按鈕，7.1 與 7.2 不再適用。其他分頁的左滑行為不變。 |
| unified-ui-controls | 尚未實作。新控制項沿用現有的按鈕、圖示按鈕、分段選項、展開區塊與日期按鈕樣式及圖示集，之後由該 spec 一併統一。 |
| security-hardening | 新內容遵守其輸出跳脫、CSP、權限、Origin 與 CSRF 規則。本功能刻意放寬 `server/accounts.js` 中 `guardCollaborator()` 的受邀旅伴刪除檢查：受邀旅伴移除既有的活動不再回應 403，新增的地點、路線與途中任務也不納入這項檢查（U11、需求 21.3、21.7）；旅伴、料理、裝備與車輛的檢查，以及 `guardShoppingRemoval()` 的採買品項檢查都不變。security-hardening 沒有規範受邀旅伴可以刪除的範圍，這項變更不改變它的驗收條件。 |

## Glossary

- **Trip_View**：旅行畫面（`src/app.js` 的 `trip()`），包含旅行封面、主分頁與各分頁內容。
- **Schedule_Tab**：Trip_View 的「行程表」分頁。
- **Schedule_Bar**：舊行程表最上方的 `.schedule-bar` 列，包含每天的日期按鈕與「新增一站」按鈕，定義見 mobile-smooth-swipe spec；本功能移除這一列（需求 1.6）。
- **Shopping_Tab**：Trip_View 的「採買清單」分頁。
- **Local_Planner**：本機版（`/demo/`），資料只存在瀏覽器 localStorage。
- **Account_Mode**：帳號版，旅行內容存在伺服器的 `trips.state_json`。
- **Server**：帳號版的伺服器（`server/accounts.js`）。
- **Trip_State**：一趟旅行的內容，包含旅行資料、旅伴、活動、料理、採買、裝備、車輛，以及本功能新增的地點、路線與每日設定。
- **State_Validator**：前後端共用的 `isValidState()`（`src/model.js`）。
- **Trip_Menu**：旅行標題旁選單按鈕開啟的旅行選單。
- **Trip_Settings_Dialog**：「編輯旅行」對話框（`trip-settings`），編輯旅行名稱、目的地、日期、旅行介紹與旅行小叮嚀。
- **Vehicle_Dialog**：新增或編輯車輛的對話框（`vehicle`）。
- **View_Switch**：Schedule_Tab 頂端切換「行程圖」與「規劃行程」的分段選項。
- **Itinerary_Poster**：「行程圖」檢視，以插畫與動畫呈現整趟旅行。
- **Itinerary_Editor**：「規劃行程」檢視，以勾選與選單規劃每一天。
- **Itinerary_Text**：依需求 14 由 Trip_State 產生的純文字行程（文字版）。
- **Text_Panel**：Itinerary_Poster 下方顯示 Itinerary_Text 的可展開區塊。
- **Example_Trip**：前言「範例行程與預期文字版」定義的範例資料。
- **Example_Text**：前言列出的 Example_Trip 預期文字版。
- **Trip_Day**：旅行日期範圍內的一天，從開始日起依序稱為第 1 天、第 2 天，以此類推。
- **First_Day**：旅行開始日。
- **Last_Day**：旅行結束日。一天的旅行中，First_Day 與 Last_Day 是同一天。
- **Day_Settings**：一個 Trip_Day 的 Day_Title、Day_Location 與 Arrival_Time。
- **Day_Title**：一個 Trip_Day 的標題，例如「向山裡出發」。
- **Day_Location**：一個 Trip_Day 的地點。Day_Settings 中的 Day_Location 只會是未設定或一個 Place（選擇 Destination_Place 時存為未設定）；未設定時，該天的 Day_Location 為 Destination_Place，旅行目的地也空白時沒有 Day_Location。
- **Arrival_Time**：一個 Trip_Day 的 Arrival_Routes 預計抵達 Day_Location 的時間（選填）。
- **Place**：Place_List 中的一個地點。
- **Place_List**：一趟旅行的地點清單。
- **Destination_Place**：代表旅行目的地（`trip.destination`）的固定地點選項，名稱永遠等於目前的旅行目的地；旅行目的地空白時不提供。
- **Places_And_Cars**：Itinerary_Editor 中管理 Place_List 與車輛的「地點與車」區塊。
- **Vehicle**：`state.vehicles` 中的一台車。
- **Route**：一台 Vehicle 在一個 Trip_Day 的移動，包含起點、出發時間（選填）、依序經過的 Stop 與終點。
- **Stop**：Route 的一個途中任務，包含一個地點、任務類型（採買、接送、取還裝備、其他）與選填的備註（任務類型為採買時沒有備註，見需求 6.4）。
- **Shopping_Stop**：任務類型為採買的 Stop。Stop 不保存採買品項，要買的品項（Stop_Items）依需求 6.11 推導。
- **Car_Members**：一台 Vehicle 的駕駛（`vehicle.driver`，「駕駛」不是待分配時）與全部乘客（`vehicle.passengers`）。
- **Shopping_Assignee**：採買品項的「誰負責買」（`state.shopping[].assignee`，Shopping_Tab 顯示為「{旅伴}負責」）；空字串表示待分配。
- **Buyer_Car**：一位旅伴的採買車輛，是依 `state.vehicles` 的順序第一台 Car_Members 包含該旅伴的 Vehicle；旅伴不是任何 Vehicle 的駕駛或乘客時沒有 Buyer_Car。同一位旅伴可以是多台 Vehicle 的駕駛或乘客，這時只有排在最前面的那台是 Buyer_Car（D29）。
- **First_Shopping_Stop**：一台 Vehicle 在整趟旅行的第一個 Shopping_Stop：在該車有 Shopping_Stop 的 Route 中，取 Trip_Day 最早的那一條，再取其中 Stop 順序最前面的 Shopping_Stop（D28）；Vehicle 沒有 Shopping_Stop 時沒有 First_Shopping_Stop。
- **Stop_Items**：一個 Shopping_Stop 要買的採買品項，規則見需求 6.11：該 Stop 是所屬 Vehicle 的 First_Shopping_Stop 時，為 Shopping_Assignee 的 Buyer_Car 是該 Vehicle 的全部品項（包含已買齊的品項），依採買清單的順序排列；其他 Shopping_Stop 沒有 Stop_Items。
- **Unassigned_Shopping**：不屬於任何 Shopping_Stop 之 Stop_Items 的採買品項（「未分配採買清單」），也就是 Shopping_Assignee 為待分配、Shopping_Assignee 沒有 Buyer_Car，或 Buyer_Car 沒有 Shopping_Stop 的品項（需求 6.11）。
- **Shopping_Summary**：Shopping_Stop 的採買摘要，由 Stop_Items 的品項名稱組成，規則見需求 6.9。
- **Arrival_Routes**：一個 Trip_Day 中終點是 Day_Location、起點不是 Day_Location 的 Route。
- **Other_Routes**：一個 Trip_Day 中不屬於 Arrival_Routes 的 Route。
- **Meeting_Count**：一個 Trip_Day 的 Arrival_Routes 數量（會合車數）。
- **Route_Block**：Itinerary_Text 與 Itinerary_Poster 中一起呈現的一組 Route，規則見需求 14.8。
- **Activity_Block**：Itinerary_Text 與 Itinerary_Poster 中一起呈現的一組 Activity 與 Meal_Moment，規則見需求 14.8。
- **Day_Sequence**：一個 Trip_Day 中 Route_Block 與 Activity_Block 的排列順序，規則見需求 14.8。
- **Activity**：`state.activities` 中的一筆活動。
- **Activity_Category**：前言「活動類別」表中的活動類別，決定插圖與文字版括號中的標籤。
- **Legacy_Activity_Type**：既有的六種活動類型 meet、market、camp、meal、night、travel。
- **Activity_Preset**：前言「常用活動」表中可以勾選加入的預設活動。
- **Meal**：`state.meals` 中的一筆餐點。
- **Meal_Moment**：一筆 Meal 在行程中的呈現。
- **Meal_Time**：Meal_Moment 的時間，規則見需求 8.2。
- **Meal_Label**：Meal_Moment 在文字版括號中的標籤，規則見需求 8.6。
- **Legacy_Departure**：Vehicle 的 `meeting` 中仍有時間或地點的舊出發資料。
- **Planning_Warning**：Itinerary_Editor 顯示、不阻止儲存的規劃提醒。
- **Draft**：Itinerary_Editor 中尚未儲存的修改。
- **Car_Color**：Itinerary_Poster 中每台 Vehicle 路線線條的顏色。
- **Day_Caption**：Itinerary_Poster 每一天標題旁由資料產生的一句摘要，規則見需求 11.3。
- **Char_Count**：長度上限的字數，以 Unicode 碼位（code point）計算，例如「出發地點 A」為 6 個字；條文寫明「去除前後空白後」時，先去除前後的空白字元（含全形空白、換行與 Tab）再計算。與伺服器既有的旅行欄位與旅伴名字檢查相同。
- **Chinese_Numeral**：數值的中文數字寫法。1 到 99 寫作中文數字（一、二…十、十一…九十九），數值為 2 時寫作「兩」，其他數值中的 2 寫作「二」，例如 12 為「十二」、22 為「二十二」；100 以上寫作不加千分位符號的阿拉伯數字，例如「120台車」。
- **Duration_Text**：旅行天數文字。一天的旅行為「一日遊」，其他為「{天數}天{天數減 1}夜」，數字以 Chinese_Numeral 表示，例如「兩天一夜」「三天兩夜」。
- **Scene_Motion_State**：`<html data-scene-motion>` 的值，為 static、reduced、paused 或 running。
- **Motion_Toggle**：暫停或播放插畫動畫的按鈕（`[data-scene-motion-toggle]`）。
- **Reduced_Motion**：系統設定 `prefers-reduced-motion: reduce` 成立的狀態。
- **Trip_Manager**：帳號版中 `canDelete` 為 true 的帳號（旅行建立者或管理員）。
- **Collaborator**：帳號版中 `canEdit` 為 true、`canDelete` 為 false 的帳號，也就是受邀加入旅行的旅伴。Collaborator 與 Trip_Manager 一樣使用 View_Switch 與 Itinerary_Editor，也可以在 Schedule_Tab 刪除 Route、Stop、Activity 與 Place（需求 21.2）；不能刪除 Vehicle，其他分頁與 Trip_Menu 的刪除限制也不變。
- **Viewer**：帳號版中 `canEdit` 為 false 的帳號。Viewer 的規則只是權限的後備規則：Server 的 `tripAccess()` 只讓 `canEdit` 為 true 的帳號開啟旅行，App 目前不會建立 Viewer；受邀旅伴是 Collaborator，不是 Viewer。
- **Editor_User**：可以編輯行程的使用者，即 Local_Planner 的使用者、Trip_Manager（旅行建立者或管理員）與 Collaborator（受邀旅伴），也就是目前每一位能開啟旅行的人。
- **Escape_Function**：`src/model.js` 的 `escape`，把 `&`、`<`、`>`、`"`、`'` 與反引號換成 HTML 字元參照。
- **XSS_Payload_Set**：security-hardening spec 定義的 XSS 測試字串清單。
- **Test_Suite**：專案的 `bun test` 單元與屬性測試，以及 Playwright 瀏覽器測試。
- **Changed_Test**：因本功能而修改的既有測試。
- **README**：專案根目錄的 `README.md`。

## Requirements

### Requirement 1: 行程表分頁的兩種檢視

**User Story:** 身為旅伴，我希望行程表分成「看行程」和「規劃行程」，以便看的時候畫面乾淨，規劃的時候有完整的工具。

#### Acceptance Criteria

1. WHERE 使用者是 Editor_User（Local_Planner 的使用者、旅行建立者、管理員與受邀旅伴），THE Schedule_Tab SHALL 在分頁內容的最上方顯示 View_Switch，依序提供「行程圖」與「規劃行程」兩個選項，兩個選項遵守需求 16.3（鍵盤操作）、16.12（焦點外框）、16.9（點擊範圍）與 16.10（對比）的規則，且螢幕上任何時刻只顯示 Itinerary_Poster 與 Itinerary_Editor 其中一種（列印依需求 13.6）。
2. WHEN 頁面載入或重新載入後顯示 Trip_View，或使用者在 Local_Planner 從其他頁面（`#/home`、`#/go`、`#/invite`、`#/privacy`）前往 Trip_View，THE Schedule_Tab SHALL 把檢視設為 Itinerary_Poster。
3. THE Schedule_Tab SHALL 只因本需求第 2 條與第 10 條改變檢視；在同一次頁面載入中，Itinerary_Editor 正在編輯的第 N 天（第一次開啟時依需求 4.2 為 First_Day）與「路線」「活動」分段只因使用者選擇或需求 4.12 改變。切換到其他主分頁再回到 Schedule_Tab、開啟或關閉 Trip_Menu 與對話框，以及儲存修改之後，檢視、第 N 天與分段都維持原狀；從其他主分頁回到 Schedule_Tab 時，Itinerary_Editor 的可編輯卡片全部收起。
4. THE View_Switch SHALL 以 `aria-pressed="true"` 標示目前檢視對應的選項，另一個選項為 `aria-pressed="false"`。
5. WHERE 使用者是 Viewer（帳號權限顯示不能編輯時的後備規則；App 目前不會建立這種帳號，受邀旅伴是 Editor_User，依第 1 條使用 View_Switch），THE Schedule_Tab SHALL 只顯示 Itinerary_Poster，不顯示 View_Switch、Itinerary_Editor 與「開始規劃」按鈕。
6. THE Schedule_Tab SHALL 不再顯示舊行程表的介面：Schedule_Bar（日期按鈕與「新增一站」按鈕）、「各車出發」區塊、「按車查看行程」下拉選單、「當日行程 · 慢慢走，好好玩。」與「N 個小片刻」說明列，以及活動時間軸（`.timeline` 與 `.activity-card`）；選擇日子只在 Itinerary_Editor 以選日按鈕（需求 4.1）進行。
7. THE Trip_View SHALL 維持 5 個主分頁的名稱與順序：行程表、料理菜單、採買清單、裝備分工、分帳記帳，本功能不新增主分頁。
8. WHILE Trip_State 沒有任何 Route、Legacy_Departure、Activity 與 Meal，THE Itinerary_Poster SHALL 在頂端概要（需求 11.13）之後顯示插畫與文字「這趟旅行還沒有行程」，取代每一天的段落與需求 11.14、11.15 的結尾文字，Text_Panel 仍依需求 15.1 顯示；Place_List、Day_Settings 與 Vehicle 不影響這個判斷，其他狀態下不顯示這個提示。
9. WHERE 使用者是 Editor_User，WHILE Itinerary_Poster 顯示「這趟旅行還沒有行程」提示，THE Itinerary_Poster SHALL 在提示中顯示「開始規劃」按鈕，按鈕的點擊範圍遵守需求 16.9 的規則。
10. WHEN Editor_User 啟動 View_Switch 中未選取的選項或「開始規劃」按鈕，THE Schedule_Tab SHALL 改為顯示對應的檢視（「開始規劃」對應 Itinerary_Editor；從有 Draft 的 Itinerary_Editor 切換時先依需求 10.2 確認），把焦點放在 View_Switch 中該檢視的選項，且不把 Trip_State 寫入伺服器或 localStorage；啟動已選取的選項時不改變畫面，也不詢問是否放棄 Draft。

### Requirement 2: 地點清單

**User Story:** 身為規劃行程的人，我希望把會去的地點存成清單，以便每天的路線只要從清單選，不用重打。

#### Acceptance Criteria

1. THE Trip_State SHALL 保存 Place_List，且每個 Place 的名稱符合下列規則：(a) 保存時只去除前後的空白字元（含全形空白、換行與 Tab），其他字元依使用者輸入保存，不轉換全形半形或英文大小寫；(b) 去除前後空白後的 Char_Count 為 1 到 50；(c) 不含 Unicode 控制字元（類別 Cc，例如換行與 Tab）與格式字元（類別 Cf，例如零寬空白與文字方向控制字元），連接兩個 emoji 的零寬連接符除外，與旅伴名字的規則相同；(d) 不與 Place_List 中另一個 Place 或 Destination_Place 同名。兩個名稱在去除前後空白、把全形與半形寫法視為相同（例如「Ａ」與「A」、「／」與「/」、全形空白與半形空白），並忽略英文字母大小寫後相等，即為同名。
2. IF 使用者在 Places_And_Cars 新增或改名的 Place 名稱，或以「＋新增地點」輸入的名稱不符合需求 2.1，THEN THE Itinerary_Editor SHALL 不接受該名稱（Places_And_Cars 拒絕儲存；「＋新增地點」不把地點加入 Draft，該下拉選單維持原本的選擇），在名稱欄位標示錯誤並保留使用者輸入的名稱，並依名稱空白、超過 50 個字、含控制字元、同名的順序只顯示第一個不符合的原因：同名時顯示「已有同名地點」，比較對象為其他 Place、Destination_Place，以及同一個 Draft 中已新增的 Place；其他原因的錯誤訊息分別指出名稱空白、超過 50 個字或含控制字元。
3. THE Itinerary_Editor SHALL 在每個選擇地點的下拉選單（Route 的「從哪裡出發」與「最後到哪裡」、Stop 的地點，以及「這一天的設定」的 Day_Location）中，於表示未選擇或未設定的選項（若有）之後，先列出 Destination_Place（旅行目的地空白時不列出），再依 Place_List 的順序列出每個 Place，選項文字為地點名稱；Place_List 依 Place 加入的先後排列，新 Place 一律加在末端，改名不改變位置，刪除一個 Place 不改變其他 Place 的先後，Places_And_Cars 也依相同順序列出地點。
4. WHEN 旅行目的地在 Trip_Settings_Dialog 或帳號版的旅行卡片（需求 20.3）變更並儲存，THE Itinerary_Poster SHALL 在下一次顯示時，於每個使用 Destination_Place 的 Route 起點、終點與 Stop，以及 Day_Location 未設定（因此為 Destination_Place）的每個 Trip_Day 顯示新的旅行目的地，不需要逐一修改這些 Route、Stop 與 Day_Settings；Itinerary_Editor（含地點下拉選單與 Places_And_Cars）、Itinerary_Text、Shopping_Tab 的採買地點（需求 6.10）與 Trip_Menu 的車輛出發（需求 3.8）也顯示相同的新目的地；Activity 的地點與 Legacy_Departure 是另外輸入的文字，不隨目的地變更。
5. WHEN 使用者啟動任一地點下拉選單旁的「＋新增地點」，輸入符合需求 2.1 的名稱並確認，THE Itinerary_Editor SHALL 把新 Place 加入目前卡片的 Draft、在該下拉選單選取新 Place，並在同一張卡片的其他地點下拉選單中依新增的先後把它列在 Place_List 之後；卡片儲存前，Place_List 不改變，Places_And_Cars 也不列出這個新 Place。
6. WHEN 使用者在 Places_And_Cars 改名一個 Place 並儲存，THE Itinerary_Poster SHALL 在下一次顯示時，於每個使用該 Place 的 Route 起點、終點、Stop 與 Day_Location 顯示新名稱，不需要逐一修改這些 Route、Stop 與 Day_Settings；Itinerary_Editor（含地點下拉選單與 Places_And_Cars）、Itinerary_Text、Shopping_Tab 的採買地點與 Trip_Menu 的車輛出發也顯示相同的新名稱；Activity 的地點與 Legacy_Departure 是另外輸入的文字，不隨改名變更。
7. IF 使用者刪除仍被 Route 的起點、終點、Stop 或 Day_Location 使用的 Place，THEN THE Itinerary_Editor SHALL 不刪除該 Place、不顯示移除確認視窗，並在該地點的卡片中依 Trip_Day 的順序列出每個使用處：每項包含第幾天，以及「這一天的地點」（Day_Location 使用時）或使用該 Place 的車名（Route 或 Stop 使用時）；同一天先列「這一天的地點」，再依 `state.vehicles` 的順序列出車名，同一天同一台車只列一次；同時提示先把這些使用處改成其他地點，Place_List 與所有使用處維持不變。
8. IF 新增地點會讓 Place 超過 100 個（Destination_Place 不計入），THEN THE Itinerary_Editor SHALL 不新增並顯示「地點最多 100 個」：Place_List 的 Place 數加上目前 Draft 中新增且仍被選取的 Place 數達到 100 時，停用每個「＋新增地點」與 Places_And_Cars 的新增地點按鈕，並在按鈕旁顯示該訊息；需要在儲存時新增地點的卡片（例如需求 19.11 的「轉成路線」）若會讓 Place 超過 100 個，則拒絕儲存並保留 Draft。
9. IF 使用者在 Trip_Settings_Dialog 把旅行目的地改成與某個 Place 同名（依需求 2.1(d) 判斷），THEN THE Trip_View SHALL 拒絕儲存且不寫入對話框中的任何變更，在對話框顯示「已有同名地點」與該 Place 的名稱，提示先在 Places_And_Cars 把該地點改名，並保留對話框中的輸入。
10. IF 帳號版以旅行卡片修改旅行（`PATCH /api/trips/:id`）或匯入舊手冊（`POST /api/trips`，需求 20.3）時，旅行目的地被改成與某個 Place 同名（依需求 2.1(d) 判斷），或被改成空白而仍有 Route 的起點、終點或 Stop 使用 Destination_Place，THEN THE Server SHALL 比照需求 20.4 回應 400 且不寫入任何資料，錯誤訊息指出已有同名地點，或仍有路線或停靠點使用旅行目的地；Server 先做這兩項檢查，再做需求 18.10 的 State_Validator 驗證，因此這兩種情況回應上述訊息，而不是既有的格式錯誤訊息；旅行卡片對話框依既有方式顯示該訊息並保留輸入。
11. WHEN 使用者儲存一張含有 Draft 中新增之 Place 的卡片（以「＋新增地點」新增，或依需求 19.11 由「轉成路線」新增），THE Trip_State SHALL 依新增的先後，只把仍被該卡片至少一個地點下拉選單選取的新 Place 加到 Place_List 末端，不再被選取的新 Place 不加入；Draft 被放棄或儲存失敗時，其中的新 Place 都不加入 Place_List。

### Requirement 3: 「地點與車」區塊與車輛

**User Story:** 身為規劃行程的人，我希望在同一個地方準備好地點和車，以便排路線時只要勾選。

#### Acceptance Criteria

1. THE Itinerary_Editor SHALL 在選日按鈕上方顯示可展開的 Places_And_Cars，頁面載入後預設收起，之後維持使用者最後設定的展開狀態直到頁面重新載入；Places_And_Cars 的標題列在收起與展開時都顯示「{P} 個地點・{V} 台車」，P 為 Place_List 中已儲存的 Place 數量（不含 Destination_Place 與 Draft 中的新地點），V 為 Vehicle 數量，兩者以阿拉伯數字顯示、為 0 時也顯示，例如 Example_Trip 為「6 個地點・4 台車」；展開或收起 Places_And_Cars 不算需求 10.2 的展開或收起卡片，不詢問也不放棄 Draft。
2. THE Places_And_Cars SHALL 在展開時先列出 Destination_Place（旅行目的地空白時依第 12 條），再依 Place_List 的順序列出每個 Place，每列顯示地點名稱與「{N} 條路線」；N 為整趟旅行中起點、終點或任一 Stop 是該地點的已儲存 Route 數量，同一條 Route 只計一次，Day_Settings 的使用不計入，例如 Example_Trip 的夕淞度日營區為「8 條路線」、台北為「4 條路線」、超市／賣場為「1 條路線」。
3. WHILE 旅行目的地不是空白，THE Places_And_Cars SHALL 在 Destination_Place 列提供文字為「在編輯旅行修改」的按鈕，啟動後開啟 Trip_Settings_Dialog，且該列不提供改名與刪除按鈕。
4. THE Places_And_Cars SHALL 提供「＋新增地點」按鈕與每個 Place 的「改名」按鈕（無障礙名稱為「改名 {地點名稱}」），啟動後展開地點卡片，讓使用者輸入名稱並以「儲存」寫入 Place_List；名稱依需求 2.1 與 2.2 驗證，新增的 Place 加到 Place_List 末端，Place_List 已有 100 個 Place 時依需求 2.8 停用「＋新增地點」。
5. THE Places_And_Cars SHALL 依 `state.vehicles` 的順序為每台 Vehicle 顯示一列，內容為車名、駕駛名稱（沒有駕駛時為「待分配」）、「{乘車人數} / {座位數} 人」（乘車人數為乘客數，有駕駛時再加 1），以及有已儲存 Route 的日子（依天數由小到大以「、」連接「第 N 天」，例如「第 1 天、第 3 天」；沒有任何 Route 時為「還沒有路線」），並提供「新增車輛」按鈕與每台車的編輯按鈕（無障礙名稱為「編輯 {車名}」），兩者都開啟 Vehicle_Dialog。
6. WHEN 使用者在 Places_And_Cars 或 Trip_Menu 新增、編輯或刪除 Vehicle 並完成儲存或確認，THE Trip_View SHALL 把變更寫入同一份 `state.vehicles`（新增的 Vehicle 加在末端），且 Places_And_Cars 與 Trip_Menu 在下一次畫面更新時顯示相同的車輛、順序、車名、駕駛與人數，Itinerary_Poster、Itinerary_Editor 與 Itinerary_Text 也使用變更後的車名；兩處開啟的是同一個 Vehicle_Dialog，欄位與驗證相同。
7. THE Vehicle_Dialog SHALL 只提供車輛暱稱（必填且不能只有空白，最多 50 字）、駕駛、座位數（含駕駛，1 到 9 的整數）與乘客欄位，並沿用既有的驗證（乘客不含駕駛，乘客加上駕駛不超過座位數）；Vehicle_Dialog 不再提供出發時間與出發地點欄位，也不顯示「各車出發」的說明，改為顯示「每天的出發時間與地點，請在規劃行程的路線填寫。」；儲存既有 Vehicle 時 `meeting` 的值維持不變，新增的 Vehicle 沒有 Legacy_Departure（`meeting` 為空白）。
8. THE Trip_Menu SHALL 在每張車輛卡片以一行顯示該車在 First_Day 的出發，取代原本的出發地點行，卡片的其他內容不變：有 First_Day 的 Route 時為「第 1 天・{HH:MM} 出發：{起點}」，沒有出發時間時為「第 1 天・出發時間待定：{起點}」；沒有 First_Day 的 Route 但有 Legacy_Departure 時，以相同格式顯示舊的出發時間與地點，並在最後加上「（舊的出發資料）」，無法分出時間的自由文字整段作為地點，沒有地點時以「出發地點待定」代替；兩者都沒有時為「第 1 天還沒有路線」。起點與舊出發地點以 `mapLink()` 呈現，連結文字只有地點名稱，例如 Example_Trip 的第一車為「第 1 天・08:00 出發：出發地點 A」，`seed()` 的山線小巴為「第 1 天・14:00 出發：台北車站東三門（舊的出發資料）」。
9. IF 使用者以 Trip_Menu 車輛卡片的刪除按鈕或 Vehicle_Dialog 的「移除項目」按鈕刪除仍有 Route 的 Vehicle，THEN THE Trip_View SHALL 不顯示移除確認視窗、不刪除也不寫入 Trip_State，並顯示提示：依天數由小到大以「、」列出該車有 Route 的「第 N 天」，並說明需先刪除這些路線或改派給其他車；Vehicle_Dialog 開啟時，提示顯示在對話框的錯誤訊息區，否則顯示在既有的提示訊息區域。
10. IF 使用者以第 9 條的刪除按鈕刪除被任一 Activity 指定參加的 Vehicle，THEN THE Trip_View SHALL 不顯示移除確認視窗、不刪除也不寫入 Trip_State，並沿用既有的提示文字與顯示位置（說明需先把那些活動改派其他車輛或改為全體旅伴）；該車同時符合第 9 條時，兩則提示都顯示。
11. WHERE 使用者是 Editor_User（包含 Collaborator，需求 21.2），THE Places_And_Cars SHALL 為每個 Place 提供「刪除」按鈕（無障礙名稱為「刪除 {地點名稱}」），確認方式依需求 10.7，地點仍被使用時依需求 2.7 不刪除；刪除 Vehicle 仍只限 Local_Planner 的使用者與 Trip_Manager：從 Places_And_Cars 開啟的 Vehicle_Dialog 只對這些使用者顯示既有的「移除項目」按鈕，Trip_Menu 車輛卡片的刪除按鈕也依既有規則只對這些使用者顯示，Collaborator 在這兩處都看不到刪除 Vehicle 的按鈕。
12. WHILE 旅行目的地空白，THE Places_And_Cars SHALL 不列出 Destination_Place，改在地點清單最前面顯示「還沒有旅行目的地」，以及開啟 Trip_Settings_Dialog 的「在編輯旅行修改」按鈕。
13. THE Trip_View SHALL 讓車輛數由使用者自訂：Editor_User 可以在 Places_And_Cars（第 5 條）或 Trip_Menu 新增 Vehicle，並以 Vehicle_Dialog 修改車輛暱稱（改名），Local_Planner 的使用者與 Trip_Manager 可以依第 9 至 11 條刪除 Vehicle；車輛數只受 State_Validator 既有的上限限制（最多 1,000 台 Vehicle，每台座位數為 1 到 9 的整數），本功能不另設上限、下限或固定的車輛數，沒有 Vehicle 也有效（需求 5.7、11.13）；Itinerary_Poster 與 Itinerary_Text 中的每個車輛數都依目前的 `state.vehicles` 與 Route 計算，包括「{N}台車」（需求 11.13、11.14）、「{N}車出發」（需求 11.3）、「{N}車會合」（需求 14.11）與「其他{N}車直達」（需求 11.8），N 以 Chinese_Numeral 表示，例如 Example_Trip 的四台車產生「四台車」與「四車會合」，刪除第四車第 1 天的 Route 後第 1 天改為「三車會合」。

### Requirement 4: 選日與每一天的設定

**User Story:** 身為規劃行程的人，我希望一次專心規劃一天，並為每一天取標題、設定地點，以便行程圖每一段都有清楚的主題。

#### Acceptance Criteria

1. THE Itinerary_Editor SHALL 顯示一組以「編輯哪一天」為可見標籤與無障礙名稱的選日按鈕，依 Trip_Day 的順序為每個 Trip_Day 提供一個按鈕，按鈕顯示「第 {N} 天」、「{月}/{日}」（月與日不補零）與「週{星期}」，例如「第 1 天」「10/20」「週二」；任何時刻恰好一個按鈕（正在編輯的那一天）為 `aria-pressed="true"`，其他按鈕為 `aria-pressed="false"`。
2. WHEN Schedule_Tab 開始顯示 Itinerary_Editor（在 View_Switch 選擇「規劃行程」、啟動需求 1.9 的「開始規劃」，或回到離開前顯示 Itinerary_Editor 的 Schedule_Tab），THE Itinerary_Editor SHALL 在頁面載入後的第一次顯示時選取 First_Day 及其預設分段（需求 4.7），之後每次顯示時沿用最近一次正在編輯的那一天與分段，直到頁面重新載入。
3. WHILE 視窗寬度至少 320 CSS 像素，THE Itinerary_Editor SHALL 把 1 到 31 天旅行的全部選日按鈕排在同一列，每個按鈕的寬度至少等於其文字全部不換行時的寬度（容許 1 CSS 像素誤差），按鈕中的每段文字（含需求 9.8 的提醒數量）都不換行也不超出按鈕邊框；按鈕與間距的總寬度超過選日按鈕列的可視寬度時，只讓選日按鈕列水平捲動，文件的捲動寬度不超過視窗寬度，且每次畫面更新後，正在編輯的那一天的按鈕完整位於選日按鈕列的可視範圍內（沿用 mobile-smooth-swipe 需求 7.3 至 7.6，改用於選日按鈕）。
4. THE Itinerary_Editor SHALL 在選日按鈕下方顯示正在編輯的那一天的摘要列「{標題}・{R} 條路線 / {A} 個活動」：標題為 Day_Title，未設定時為「第 {N} 天」；R 是該天已儲存的 Route 數，不含 Legacy_Departure；A 是該天已儲存的 Activity 數加上 Meal 數；數量為 0 時顯示 0，Draft 不計入。例如 Example_Trip 第 1 天為「向山裡出發・4 條路線 / 3 個活動」，沒有任何內容與設定的第 2 天為「第 2 天・0 條路線 / 0 個活動」。
5. THE Itinerary_Editor SHALL 提供預設收起的「這一天的設定」卡片，展開後包含標籤為「標題」的文字欄位（Day_Title，選填，去除前後空白後的 Char_Count 為 0 到 20）、標籤為「地點」的地點下拉選單（Day_Location）與「儲存」按鈕；地點下拉選單依需求 2.3 列出選項並提供需求 2.5 的「＋新增地點」，旅行目的地空白時以「不指定地點」作為第一個選項；下拉選單預選該天 Day_Settings 中的 Place，該天的 Day_Location 未設定時預選 Destination_Place，旅行目的地空白時預選「不指定地點」。
6. THE Itinerary_Editor SHALL 在展開的「這一天的設定」顯示「第 {N} 天・{月}/{日}（週{星期}）」，並提供「調整旅行日期與天數」按鈕開啟 Trip_Settings_Dialog，有 Draft 時比照需求 10.2 先詢問是否放棄未儲存的修改；Itinerary_Editor 中沒有任何修改旅行日期或天數的欄位。
7. THE Itinerary_Editor SHALL 提供「路線」與「活動」兩個分段選項，任何時刻恰好選取其中一個，選取的選項為 `aria-pressed="true"`、另一個為 `aria-pressed="false"`，並只顯示所選分段的內容；每一天的預設分段為：First_Day、Last_Day 與已儲存至少一條 Route 的日子為「路線」，其他日子為「活動」。
8. WHILE 正在編輯的那一天有 Arrival_Routes，或該天已儲存 Arrival_Time，THE Itinerary_Editor SHALL 在「路線」分段的路線清單下方顯示標籤為「預計幾點抵達{Day_Location}」（沒有 Day_Location 時為「預計幾點抵達」）的時間欄位與「儲存」按鈕，欄位預先填入已儲存的 Arrival_Time（沒有時為空白），可填入 00:00 到 23:59 的 24 小時制 HH:MM，也可以清空；欄位的修改在啟動「儲存」前是 Draft，適用需求 10.2 至 10.6。
9. IF 使用者儲存「這一天的設定」時 Day_Title 去除前後空白後的 Char_Count 超過 20，或儲存預計抵達時間時欄位既不是空白也不是 00:00 到 23:59 的 HH:MM（只填了部分的時間視為無效，不視為空白），THEN THE Itinerary_Editor SHALL 拒絕儲存、不寫入 Trip_State，保留 Draft 與輸入內容，在該欄位旁顯示說明錯誤原因的訊息，並把焦點移到該欄位。
10. WHEN 一次儲存使一個 Trip_Day 的 Day_Title 為空白、Day_Location 未設定（地點選擇 Destination_Place 或「不指定地點」），且沒有 Arrival_Time，THE Trip_State SHALL 不再保留該天的 Day_Settings，讓該天回到未設定狀態：摘要列與 Itinerary_Poster 的標題為「第 {N} 天」，Itinerary_Text 省略「｜{Day_Title}」，且需求 20.2 不把該天算成仍有 Day_Settings 的日子。
11. WHEN 使用者啟動正在編輯的那一天以外的選日按鈕，且沒有 Draft 或使用者已依需求 10.2 確認放棄 Draft，THE Itinerary_Editor SHALL 選取該天：更新每個選日按鈕的 `aria-pressed`，收起已展開的卡片，把摘要列、Planning_Warning、「這一天的設定」與分段內容換成該天的內容，選取該天的預設分段（需求 4.7），焦點留在該選日按鈕。
12. WHEN 使用者在 Trip_Settings_Dialog 儲存成功（不論是否改變日期），或旅行日期因其他原因改變（例如帳號版的旅行卡片，或載入另一個瀏覽器分頁或伺服器的版本），THE Itinerary_Editor SHALL 繼續選取之前正在編輯的第 N 天與分段，並以新的旅行日期顯示該天；新的天數少於 N 時，改選 Last_Day 及其預設分段（需求 4.7）；本次頁面載入後還沒顯示過 Itinerary_Editor 時，第一次顯示仍依需求 4.2 選取 First_Day。
13. WHEN 使用者儲存通過驗證的「這一天的設定」或預計抵達時間，THE Trip_State SHALL 只更新正在編輯的那一天在該次儲存中的欄位：「這一天的設定」寫入去除前後空白的 Day_Title 與選取的 Day_Location（選取 Place 時存為該 Place，選取 Destination_Place 或「不指定地點」時存為未設定），預計抵達時間寫入欄位的 HH:MM，欄位空白時移除 Arrival_Time；摘要列、Itinerary_Poster 與 Itinerary_Text 在下一次畫面更新時呈現儲存後的 Day_Title、Day_Location 與 Arrival_Time。

### Requirement 5: 路線

**User Story:** 身為規劃行程的人，我希望用選單安排每台車從哪裡出發、幾點出發、最後到哪裡，以便不用逐字輸入，格式也一致。

#### Acceptance Criteria

1. THE Itinerary_Editor SHALL 在「路線」分段為正在編輯的 Trip_Day（以下稱「當天」）的每條 Route 顯示一個收起列，文字取自該 Route 已儲存的值，格式為「{出發時間} {車名} / {起點} → {終點}・{停靠點說明}」：出發時間為 24 小時制 HH:MM，未填時為「時間待定」；停靠點說明在沒有 Stop 時為「直達」，有 Stop 時為「{Stop 數} 個停靠點」（阿拉伯數字），例如「08:00 第一車 / 出發地點 A → 夕淞度日營區・直達」「09:00 第三車・採買組 / 出發地點 C → 夕淞度日營區・1 個停靠點」。
2. THE Itinerary_Editor SHALL 依已儲存的出發時間由早到晚排列收起列；時間相同時依 Vehicle 在 `state.vehicles` 的順序；沒有出發時間的 Route 排在最後並依 Vehicle 順序；Draft 中的修改要等儲存後才改變收起列的位置。
3. WHEN 使用者展開一條 Route，THE Itinerary_Editor SHALL 顯示「哪一台車」「從哪裡出發」「最後到哪裡」三個下拉選單、「幾點出發」時間欄位（以 24 小時制 HH:MM 填寫，可以清除）、途中任務清單（需求 6），以及「新增途中任務」與「儲存」按鈕，每個欄位帶入該 Route 已儲存的值；「從哪裡出發」與「最後到哪裡」依需求 2.3 列出地點，旁邊有需求 2.5 的「＋新增地點」。
4. WHERE 使用者是 Editor_User（包含 Collaborator，需求 21.2），THE Itinerary_Editor SHALL 在展開的已儲存 Route 顯示「刪除這條路線」按鈕，啟動後依需求 10.7 確認；新 Route Draft 不顯示這個按鈕。
5. THE Itinerary_Editor SHALL 在「哪一台車」下拉選單依 `state.vehicles` 的順序，以車名列出當天除了這條 Route 以外沒有 Route 的每台 Vehicle（因此包含這條 Route 已儲存的 Vehicle），不列出當天已有其他 Route 的 Vehicle。
6. WHEN 使用者啟動「＋新增路線」，THE Itinerary_Editor SHALL 在路線清單最後建立一張展開的新 Route Draft（尚未儲存過的 Route），顯示需求 5.3 的欄位與按鈕，預設值為：「哪一台車」是依 `state.vehicles` 順序第一台當天沒有 Route 的 Vehicle，「從哪裡出發」未選擇，「幾點出發」空白，沒有 Stop，「最後到哪裡」是 Day_Location（沒有 Day_Location 時未選擇）；另一張卡片有 Draft 時，先依需求 10.2 詢問是否放棄，使用者取消時不建立新 Route Draft。
7. IF 旅行沒有任何 Vehicle，或當天每台 Vehicle 都已有 Route，THEN THE Itinerary_Editor SHALL 停用「＋新增路線」並在按鈕旁顯示原因：沒有 Vehicle 時顯示「還沒有車輛，新增車輛後就能安排路線」，並提供開啟新增車輛 Vehicle_Dialog 的「新增車輛」按鈕；每台 Vehicle 都已有 Route 時顯示「每台車這一天都已有路線」。
8. THE Itinerary_Editor SHALL 在「路線」分段的路線清單上方顯示「每台車可安排 6 個停靠點，時間可稍後填。」，不論當天有沒有 Route。
9. IF 使用者儲存 Route 時「哪一台車」「從哪裡出發」或「最後到哪裡」沒有選擇，或起點與終點是同一個地點且沒有任何 Stop，THEN THE Itinerary_Editor SHALL 拒絕儲存，不寫入 Trip_State 並保留 Draft，把每個錯誤欄位標示為 `aria-invalid="true"`，在該欄位旁顯示指出問題的錯誤訊息並以 `aria-describedby` 關聯到欄位（起點與終點相同時標示「最後到哪裡」），再把焦點移到第一個錯誤欄位。
10. IF 使用者儲存 Route 時「幾點出發」有輸入，但不是 00:00 至 23:59 的 24 小時制 HH:MM（只填了時或分的不完整輸入也視為無效，不當成空白），THEN THE Itinerary_Editor SHALL 依需求 5.9 的方式拒絕儲存並標示「幾點出發」欄位。
11. WHEN 使用者啟動「儲存」且卡片內容通過需求 5.9、5.10，以及需求 2 與需求 6 的驗證，THE Trip_State SHALL 以一次儲存（需求 10.4）保存該 Route 的日期（當天）、Vehicle、起點、出發時間（留空時保存為沒有出發時間）、依序的 Stop 與終點；修改既有 Route（包含更換 Vehicle）時保留該 Route 與其既有 Stop 的識別碼，不以刪除後重建的方式保存。
12. WHEN 一條 Route 儲存完成（帳號版為伺服器確認儲存之後），THE Schedule_Tab SHALL 收起該 Route 的卡片，依需求 5.1 與 5.2 顯示儲存後的收起列，並在使用者切換到 Itinerary_Poster 時，讓行程圖（需求 11）與 Text_Panel 中的 Itinerary_Text（需求 14）呈現儲存後的 Route。

### Requirement 6: 途中任務與採買品項

**User Story:** 身為規劃行程的人，我希望標出哪台車途中要去哪裡採買、接人或取還裝備，並自動帶入這台車的駕駛與乘客負責買的品項，以便大家知道誰順路買什麼。

#### Acceptance Criteria

1. THE Itinerary_Editor SHALL 讓每條 Route 有 0 到 6 個 Stop。
2. WHILE 展開的 Route 卡片目前有 6 個 Stop（含 Draft 中的新增與移除），THE Itinerary_Editor SHALL 停用「新增途中任務」，並在該按鈕旁顯示「每台車最多 6 個停靠點」。
3. WHILE 展開的 Route 卡片目前沒有 Stop（含 Draft 中的新增與移除），THE Itinerary_Editor SHALL 在途中任務清單的位置顯示「途中任務（無）」與說明「直接前往終點。需要採買、接送或取還裝備時再新增。」
4. THE Itinerary_Editor SHALL 為每個 Stop 提供「停在哪裡」地點下拉選單（未選擇時顯示「選擇地點」，旁邊有需求 2.5 的「＋新增地點」）與「要做什麼」任務類型選單（採買、接送、取還裝備、其他）；任務類型不是採買時，另外提供選填的「備註」（儲存時去除前後空白，Char_Count 為 0 到 100）；任務類型是採買時不顯示「備註」，儲存時也不保存該 Stop 的備註，改由需求 6.6 的品項預覽說明要買什麼；以「新增途中任務」加入的 Stop 排在途中任務清單最後，地點未選擇、任務類型為「採買」、備註空白。
5. THE Itinerary_Editor SHALL 為每個 Stop 提供「上移」與「下移」按鈕，在 Draft 中把該 Stop 與前一個或後一個 Stop 交換位置；第一個 Stop 的「上移」與最後一個 Stop 的「下移」停用；按鈕的無障礙名稱為「上移 {地點}」與「下移 {地點}」，未選擇地點時為「上移第 {N} 個途中任務」與「下移第 {N} 個途中任務」（N 為該 Stop 在清單中的順序）；Route 依儲存時 Draft 中的 Stop 順序經過各 Stop，Itinerary_Poster 與 Itinerary_Text 也依此順序呈現。
6. WHILE 展開的 Route 卡片中一個 Stop 目前的任務類型是採買（含 Draft 中的修改），THE Itinerary_Editor SHALL 在該 Stop 顯示標題為「要買的品項」的唯讀預覽，並在預覽下方提供需求 6.7 的「到採買清單調整負責人」按鈕；預覽內容以套用這張 Route 卡片的 Draft 後的 Trip_State 依需求 6.11 推導（D31），使用者在卡片中做出修改後（例如改選「哪一台車」、新增或移除 Stop，或調整 Stop 的順序、地點或任務類型），預覽在 1 秒內呈現依修改後內容推導的結果，不需要儲存；以下「這台車」指卡片的「哪一台車」目前選取的 Vehicle，{車名} 是它的名稱，規則如下：
   - 有 Stop_Items 時，依採買清單的順序列出每個品項的名稱，已買齊的品項在名稱旁標示「已買」，不分組也不顯示數量；這份清單的無障礙名稱為「{地點}要買的品項」，未選擇地點時為「第 {N} 個途中任務要買的品項」（N 同需求 6.5）。例如 Example_Trip 第 1 天第三車・採買組在超市／賣場的預覽依序列出五花肉片、鮮蝦、高麗菜、運動飲料、洋芋片、瓦斯、衛生紙與免洗餐具。
   - 該 Stop 不是這台車的 First_Shopping_Stop 時，顯示「{車名}的採買品項列在第 {N} 天的{地點}」，N 與地點屬於這台車的 First_Shopping_Stop；First_Shopping_Stop 在 Draft 中還沒有選擇地點時，以「第 {M} 個途中任務」代替地點，M 是它在 Route 中的順序。
   - 該 Stop 是這台車的 First_Shopping_Stop、沒有 Stop_Items，且這台車的 Car_Members 都不是任何品項的 Shopping_Assignee 時，顯示「沒有品項由{車名}的駕駛或乘客負責買」。
   - 該 Stop 是這台車的 First_Shopping_Stop 時，為這台車的 Car_Members 中每一位是至少一個品項的 Shopping_Assignee、但 Buyer_Car 是另一台 Vehicle 的旅伴，先駕駛、再依 `vehicle.passengers` 的順序各顯示一行「{旅伴}也在{另一台車的車名}，負責買的品項算在{另一台車的車名}」（有品項清單時顯示在清單之後），另一台車是該旅伴的 Buyer_Car（D29）。
   - 預覽不提供勾選、選擇或修改品項的控制項，預覽中的品項只依需求 6.11 推導。
7. WHEN 使用者啟動 Shopping_Stop 預覽下方的「到採買清單調整負責人」按鈕（無障礙名稱包含按鈕文字與該 Stop 的地點，未選擇地點時以「第 {N} 個途中任務」代替地點，N 同需求 6.5；需求 16.5），THE Trip_View SHALL 在沒有 Draft，或使用者依需求 10.2 確認放棄 Draft 之後，切換到 Shopping_Tab，並依需求 16.14(c) 把焦點移到 Shopping_Tab 的主分頁按鈕；使用者在 Shopping_Tab 改變品項的「誰負責買」後，Schedule_Tab 依需求 6.12 呈現新的結果。
8. WHILE 採買清單至少有一個品項，THE Itinerary_Editor SHALL 在每一天「路線」分段的最後（該分段其他內容之後）提供「未分配採買清單」，依已儲存的 Trip_State 呈現整趟旅行的 Unassigned_Shopping（含已買齊的品項）：收起列顯示「未分配採買清單・{N} 項」與說明，N 是 Unassigned_Shopping 的品項數（阿拉伯數字），N 大於 0 時說明為「還沒決定哪台車去買」並可展開，N 為 0 時說明為「每個採買品項都已安排停靠點」且維持收起、不能展開；頁面載入後預設收起，展開或收起不算需求 10.2 的展開或收起卡片，不詢問也不放棄 Draft；展開時依 `SHOPPING_CATEGORIES` 的順序分組（只顯示有品項的分類）、組內依採買清單的順序列出品項名稱，每個品項旁以短文字顯示需求 6.11 的原因（「待分配」「{旅伴}不在任何車上」或「{車名}還沒有採買停靠點」），已買齊的品項另外標示「已買」，不提供勾選或編輯。
9. THE Shopping_Summary SHALL 依採買清單的順序，以「、」連接 Shopping_Stop 的 Stop_Items（需求 6.11，包含已買齊的品項）的品項名稱：名稱先依需求 14.16 處理，處理後完全相同的名稱只列第一個，處理後為空字串的名稱不列出，不列數量與分類；沒有 Stop_Items 時（包括不是 First_Shopping_Stop 的 Shopping_Stop）Shopping_Summary 為空字串。例如 Example_Trip 第 1 天第三車・採買組在超市／賣場的 Shopping_Summary 為「五花肉片、鮮蝦、高麗菜、運動飲料、洋芋片、瓦斯、衛生紙、免洗餐具」。
10. THE Shopping_Tab SHALL 依已儲存的 Trip_State，在每個屬於某個 Shopping_Stop 之 Stop_Items 的品項列中顯示「第 {N} 天在{地點}（{車名}）」，例如「第 1 天在超市／賣場（第三車・採買組）」：N 是該 Shopping_Stop 所屬 Route 所在的 Trip_Day 序號（第 1 天為 1），地點與車名使用目前的名稱；屬於 Unassigned_Shopping 的品項不顯示這段文字；這段文字依需求 6.11 推導，與 Itinerary_Poster、Itinerary_Text 及 Itinerary_Editor 的結果相同，只供檢視，Viewer 也看得到；改變品項的「誰負責買」後，這段文字依需求 6.12 在下一次畫面更新時改變。
11. THE Trip_View SHALL 依下列規則，由採買清單、`state.vehicles` 與 Route 推導每個採買品項由哪個 Shopping_Stop 購買，不在 Trip_State 或 Stop 中保存品項與 Stop 的對應：
    - (a) Shopping_Assignee 為待分配時，品項屬於 Unassigned_Shopping，原因為「待分配」。
    - (b) Shopping_Assignee 沒有 Buyer_Car（不是任何 Vehicle 的駕駛或乘客）時，品項屬於 Unassigned_Shopping，原因為「{旅伴}不在任何車上」。
    - (c) Shopping_Assignee 的 Buyer_Car 沒有 First_Shopping_Stop 時，品項屬於 Unassigned_Shopping，原因為「{車名}還沒有採買停靠點」，車名為該 Buyer_Car 的名稱（D30）。
    - (d) 其他情況下，品項屬於 Buyer_Car 的 First_Shopping_Stop 的 Stop_Items；Buyer_Car 的其他 Shopping_Stop 沒有 Stop_Items（D28）。
    - 因此每個品項不論是否已買齊，都恰好屬於一個 Shopping_Stop 的 Stop_Items 或 Unassigned_Shopping，兩者都依採買清單的順序排列。Itinerary_Poster、Itinerary_Text、Itinerary_Editor（需求 6.6 的預覽另外套用 Draft）、Planning_Warning 與 Shopping_Tab 都依已儲存的 Trip_State 以這些規則推導，內容相同（JSON 值相等）的 Trip_State 每次得到相同的結果。例如 Example_Trip 的八個品項都屬於第 1 天第三車・採買組在超市／賣場的 Stop_Items；把其中一項的「誰負責買」改為待分配後，該項改屬 Unassigned_Shopping，原因為「待分配」。
12. WHEN 任一變更寫入 Trip_State，例如新增、修改或刪除 Meal 而使料理食材同步新增或移除採買品項（不論同步在 Local_Planner 或 Server 執行）、新增或刪除採買品項、修改品項名稱或已買齊狀態、在 Shopping_Tab 或採買品項對話框改變「誰負責買」、在 Vehicle_Dialog 改變駕駛或乘客、新增或刪除 Vehicle、修改旅伴、Vehicle 或 Place 的名稱，或儲存、刪除 Route 與 Stop，THE Itinerary_Poster SHALL 在下一次畫面更新時呈現依新的 Trip_State 推導的 Shopping_Summary，Itinerary_Text、Itinerary_Editor（品項預覽、「未分配採買清單」與需求 9.5 的 Planning_Warning；品項預覽另外套用 Draft，見需求 6.6）與 Shopping_Tab 的採買位置（需求 6.10）也呈現相同的結果，其中的品項名稱、「已買」標示、車名、旅伴名與地點名稱都使用新的值；使用者不需要在行程中另外修改，推導也不新增、移除或改變任何採買品項。
13. IF 使用者儲存 Route 時，有 Stop 沒有選擇地點，或有任務類型不是採買的 Stop 的備註去除前後空白後 Char_Count 超過 100，THEN THE Itinerary_Editor SHALL 依需求 5.9 的方式拒絕儲存整條 Route 並標示每個有錯誤的欄位（沒有地點的 Stop 標示「停在哪裡」，備註過長的 Stop 標示「備註」），不寫入任何修改，並保留 Draft 的全部內容。
14. THE Itinerary_Editor SHALL 在展開的 Route 為每個 Stop 顯示移除按鈕，每位 Editor_User（包含 Collaborator）都看得到，不論該 Stop 是否已儲存（需求 21.2）。按鈕的無障礙名稱為「移除途中任務 {地點}」（未選擇地點時為「移除第 {N} 個途中任務」，N 同需求 6.5）；啟動後依需求 10.8 只從 Draft 移除該 Stop，同一條 Route 其他 Shopping_Stop 的預覽依需求 6.6 更新。

### Requirement 7: 活動

**User Story:** 身為規劃行程的人，我希望勾選常用的露營活動就能排好一天，需要時再加自訂活動，以便快速規劃，名稱與類別也一致。

#### Acceptance Criteria

1. THE Itinerary_Editor SHALL 在「活動」分段為當天每筆 Activity 與 Meal_Moment 顯示一個收起列，依時間由早到晚排列（時間相同時依需求 14.13 的順序）；Activity 的收起列顯示時間、標題、Activity_Category 與「完成」核取方塊，Meal_Moment 的收起列顯示 Meal_Time、需求 8.5 的文字與 Meal_Label；當天沒有 Activity 也沒有 Meal_Moment 時，顯示「這一天還沒有活動」。
2. THE Itinerary_Editor SHALL 在「活動」分段提供「常用活動」勾選清單，列出前言「常用活動」表中建議給當天的 Activity_Preset（依當天是 First_Day、中間的日子或 Last_Day；一天的旅行同時列出 First_Day 與 Last_Day 的項目，Activity_Category 相同時只保留表中較前面的一筆），依預設時間由早到晚排列，每項顯示預設時間、標題與類別；清單下方提供「加入 N 個活動」按鈕，N 為目前勾選的項目數，N 為 0 或帳號版的儲存請求尚未回應時停用該按鈕。
3. WHILE 當天有任一筆 Activity 的 Activity_Category（含依需求 7.9 由 Legacy_Activity_Type 對應的類別）與某個 Activity_Preset 的類別相同，THE Itinerary_Editor SHALL 把該 Activity_Preset 顯示為已勾選且停用的核取方塊並標示「已加入」，且不計入「加入 N 個活動」的 N。
4. WHEN 使用者啟動「加入 N 個活動」，THE Itinerary_Editor SHALL 以一次儲存在當天為每個勾選的 Activity_Preset 新增一筆 Activity：標題、時間與 Activity_Category 等於該 Activity_Preset，參加方式為全體旅伴，地點與備註空白，狀態為未完成；這次儲存不寫入也不放棄任何 Draft。
5. WHEN 使用者啟動「＋自訂活動」，THE Itinerary_Editor SHALL 展開一張自訂活動卡片，提供需求 7.6 的全部欄位與「儲存」按鈕，初始值為：標題與時間空白、日期為正在編輯的那一天、類別「營地時光」、參加方式「全體旅伴」、地點與備註空白。
6. WHEN 使用者展開一筆 Activity，THE Itinerary_Editor SHALL 以該 Activity 目前的值顯示下列欄位與「儲存」按鈕：標題（必填，去除前後空白後的 Char_Count 為 1 到 100）、日期（下拉選單，依 Trip_Day 的順序以「第 {N} 天・{月}/{日}（週{星期}）」列出每個 Trip_Day，預選正在編輯的那一天）、時間（必填，24 小時制 HH:MM）、類別（選項見需求 7.9）、參加方式（「全體旅伴」，包含之後才加入的旅伴；或「指定車輛」，依 `state.vehicles` 的順序列出每台 Vehicle 的核取方塊，至少勾選一台）、地點（Char_Count 為 0 到 150）與備註（Char_Count 為 0 到 1,000）；旅行沒有 Vehicle 時，「指定車輛」為停用並說明需要先新增車輛。
7. WHEN 使用者展開一筆指定了一位以上旅伴的 Activity（舊的旅伴名單），THE Itinerary_Editor SHALL 在參加方式另外提供「保留原旅伴名單」並預先選取，列出名單中的旅伴名稱，使用者沒有改變參加方式就儲存時保留原名單不變。
8. WHEN 使用者勾選或取消勾選 Activity 收起列的「完成」核取方塊，THE Itinerary_Editor SHALL 立即儲存該 Activity 的完成狀態（即出發模式使用的完成狀態），不寫入也不放棄任何 Draft；帳號版的儲存請求尚未回應時停用該核取方塊，儲存失敗時沿用既有行程儲存的錯誤訊息與處理方式。
9. THE Itinerary_Editor SHALL 在類別選單依前言「活動類別」表的順序列出全部 13 個 Activity_Category，並以該表的類別名稱顯示每筆 Activity 的類別：Legacy_Activity_Type 的 meet、market、camp、meal、night、travel 依序顯示為集合、採買、營地時光、用餐、夜晚、移動；Itinerary_Poster 與 Itinerary_Text 使用相同的類別名稱，類別的儲存方式依需求 18.2。
10. IF 使用者儲存 Activity 卡片或自訂活動卡片時，標題去除前後空白後為空或 Char_Count 超過 100、時間空白或不是 24 小時制 HH:MM、地點的 Char_Count 超過 150、備註的 Char_Count 超過 1,000，或選擇「指定車輛」卻沒有勾選任何 Vehicle；或儲存自訂活動、啟動「加入 N 個活動」會讓這趟旅行的 Activity 超過 1,000 筆，THEN THE Itinerary_Editor SHALL 拒絕儲存並以文字說明原因（欄位錯誤顯示在該欄位旁），保留卡片中的全部輸入與「常用活動」的勾選，不寫入 Trip_State。
11. WHERE 使用者是 Editor_User（包含 Collaborator，需求 21.2），THE Itinerary_Editor SHALL 在展開的 Activity 顯示「刪除這個活動」按鈕，使用者依需求 10.7 確認後從 Trip_State 移除該 Activity，Itinerary_Poster 與 Itinerary_Text 在下一次畫面更新時不再呈現該 Activity。
12. WHEN 使用者儲存通過需求 7.10 檢查的 Activity 卡片或自訂活動卡片，THE Trip_State SHALL 寫入卡片中的全部欄位（自訂活動在「日期」選取的那一天新增一筆未完成的 Activity），Activity 的完成狀態不因儲存卡片而改變，且 Itinerary_Poster 與 Itinerary_Text 在下一次畫面更新時呈現變更。「日期」不是正在編輯的那一天時（既有 Activity 因此移到所選的日子，自訂活動新增在所選的日子），Itinerary_Editor 仍停留在正在編輯的那一天，該 Activity 不列在這一天的活動清單，依需求 16.8 寫入的結果文字包含活動標題與所選的「第 {N} 天」，焦點依需求 16.14(b) 移除 Activity 的規則放置（自訂活動改為移到「＋自訂活動」按鈕）。

### Requirement 8: 料理自動帶入

**User Story:** 身為旅伴，我希望料理菜單排好的餐點自動出現在行程上，並看到每餐吃什麼，以便不用在兩個地方重複輸入。

#### Acceptance Criteria

1. THE Itinerary_Poster SHALL 為每筆 Meal 在其日期的 Trip_Day 段落中恰好呈現一個 Meal_Moment（需求 11.9 的小卡），位置依 Day_Sequence 排在 Activity_Block 中；Itinerary_Editor 在同一天的「活動」分段、Itinerary_Text 在同一天的 Activity_Block 也各恰好呈現一次。Meal_Moment 不出現在其他日子，使用者不需要在行程中另外新增，顯示 Meal_Moment 也不會新增 Activity 或寫入 Trip_State。
2. THE Meal_Moment SHALL 以 Meal_Time 作為時間。Meal 記有自訂時間時，Meal_Time 為該自訂時間。沒有自訂時間時依餐次預設：早餐 08:30、午餐 12:00、下午茶 15:00、晚餐 18:00、消夜 21:00；舊資料的餐次「早」「午」「晚」「宵夜」比照料理菜單的餐次排序，分別視為早餐、午餐、晚餐、消夜；其他舊資料餐次為 12:00。Itinerary_Editor、Itinerary_Poster 與 Itinerary_Text 都以 24 小時制 HH:MM 顯示相同的 Meal_Time，並依需求 14.13 的順序與 Activity 一起排列；Meal_Time 與餐次順序都相同的 Meal_Moment 依料理菜單分頁中的順序排列。
3. WHEN 使用者在 Itinerary_Editor 修改 Meal_Moment 卡片的時間並儲存，THE Trip_State SHALL 把輸入的有效時間記為該 Meal 的自訂時間；時間欄位空白時移除該 Meal 的自訂時間，讓 Meal_Time 回到餐次預設時間。Meal 的日期、餐次、料理名稱、食材與其他欄位，以及採買清單的品項，都維持不變。
4. WHEN 使用者在料理菜單儲存一筆有自訂時間的 Meal，THE Trip_State SHALL 在餐次沒有改變時保留該自訂時間（包含修改日期、料理名稱、食材或其他欄位，以及套用料理範本）；餐次改變時移除該自訂時間，讓 Meal_Time 回到新餐次的預設時間。
5. THE Meal_Moment SHALL 以「{餐次}：{料理名稱}」作為標題；料理名稱與餐次逐字相同時只顯示「{餐次}」，例如「晚餐：烤肉派對」與「早餐」。餐次使用料理菜單顯示的餐次文字，舊資料的餐次照原文字顯示。Itinerary_Poster 的小卡與 Itinerary_Editor 的 Meal_Moment 列使用這個標題，Itinerary_Text 依需求 14.13 使用相同的規則。
6. THE Meal_Label SHALL 在料理插圖類型為壽喜燒／火鍋時為「火鍋」，為烤肉串燒時為「烤肉」，為其他類型（含通用餐盤）時為 Meal 的餐次文字。料理插圖類型是料理菜單為該 Meal 料理卡片決定的類型：套用料理範本時為範本的類型，否則依料理名稱與食材判斷。例如 Example_Trip 的「烤肉派對」為「烤肉」，「豪華火鍋」為「火鍋」，午餐「午餐」為「午餐」。
7. WHILE 一筆 Meal 有食材，THE Meal_Moment SHALL 以「、」連接，完整顯示該 Meal 的全部食材名稱，不截斷，名稱與順序都與料理菜單料理卡片的「食材」相同：Itinerary_Poster 顯示在小卡中，Itinerary_Editor 顯示在展開的 Meal_Moment 卡片中，Itinerary_Text 依需求 14.14 輸出為食材行。
8. THE Itinerary_Editor SHALL 在 Meal_Moment 的收起列顯示 Meal_Time、需求 8.5 的標題、作為類別的 Meal_Label，以及「來自料理菜單」標示，不提供「完成」核取方塊；展開的 Meal_Moment 卡片內的控制項只有時間欄位（預填目前的 Meal_Time）、「到料理菜單編輯」按鈕與「儲存」按鈕，不提供修改料理名稱、餐次、日期、食材或其他料理欄位的操作，也不提供刪除 Meal 的操作。
9. WHEN 使用者在料理菜單新增、修改或刪除 Meal 並儲存後回到 Schedule_Tab，THE Itinerary_Poster SHALL 不需要其他操作就呈現變更後的 Meal：新增的 Meal 出現在其日期，改日期的 Meal 只出現在新日期，刪除的 Meal 不再出現，料理名稱、餐次、食材與料理插圖類型的變更反映在標題、Meal_Time、Meal_Label、食材與插圖；Itinerary_Editor 與 Itinerary_Text 也呈現相同的變更。
10. THE Itinerary_Poster SHALL 以 Meal 的料理插圖類型畫 Meal_Moment 小卡的插圖。料理插圖類型為通用餐盤時，每筆 Meal 從通用餐盤的同一組圖案中固定使用一種（料理菜單分頁維持現有的隨機圖案，不需要與行程圖相同）。同一筆 Meal 在畫面更新、切換分頁或檢視、重新載入與列印後都顯示相同的圖案；相同的 Trip_State 在任何瀏覽器都畫出相同的圖案；只有料理插圖類型改變時才換圖案。
11. IF 使用者在 Meal_Moment 卡片儲存的時間不是空白，也不是 00:00 至 23:59 的 24 小時制 HH:MM，THEN THE Itinerary_Editor SHALL 拒絕儲存，標示時間欄位的錯誤並保留輸入內容，Trip_State 維持不變。
12. WHEN 使用者在 Meal_Moment 卡片啟動「到料理菜單編輯」，THE Trip_View SHALL 在沒有 Draft，或使用者依需求 10.2 確認放棄 Draft 之後，切換到料理菜單分頁，把該 Meal 的料理卡片捲動到可視範圍內，並把焦點移到該卡片的「編輯 {料理名稱}」按鈕。
13. WHILE 一筆 Meal 沒有食材，THE Meal_Moment SHALL 不顯示食材區域，也不顯示「尚未填寫」等替代文字；Itinerary_Text 也不為該 Meal 輸出食材行。

### Requirement 9: 規劃提醒

**User Story:** 身為規劃行程的人，我希望系統提醒還沒安排好的地方，以便出發前把漏掉的車或時間補上。

#### Acceptance Criteria

1. WHILE 一個 Trip_Day 至少有一條 Route，THE Itinerary_Editor SHALL 為當天每台沒有 Route 的 Vehicle（包含只有 Legacy_Departure 的 Vehicle）各產生一則 Planning_Warning「{車名}這一天還沒有路線」；沒有任何 Route 的 Trip_Day 不產生這則提醒。例如刪除 Example_Trip 第 1 天第四車的 Route 後，第 1 天產生「第四車這一天還沒有路線」。
2. WHILE 一個 Trip_Day 有 Arrival_Time，THE Itinerary_Editor SHALL 為 Arrival_Routes 中每條出發時間晚於 Arrival_Time 的 Route 各產生一則 Planning_Warning「{車名} {出發時間} 出發，晚於預計抵達 {Arrival_Time}」，兩個時間都以 HH:MM 表示，例如「第四車 12:30 出發，晚於預計抵達 12:00」；出發時間等於 Arrival_Time 的 Route、沒有出發時間的 Route 與 Other_Routes 都不產生這則提醒。
3. WHILE 一個 Trip_Day 有 Arrival_Routes 但沒有 Arrival_Time，THE Itinerary_Editor SHALL 為該天產生一則 Planning_Warning「還沒填預計抵達時間」，不論 Arrival_Routes 有幾條。
4. WHILE 一條 Route 沒有出發時間，THE Itinerary_Editor SHALL 在該 Route 的 Trip_Day 為它產生一則 Planning_Warning「{車名}的出發時間待定」，Arrival_Routes 與 Other_Routes 都適用；沒有出發時間的 Legacy_Departure 不產生這則提醒。
5. WHILE 一個 Shopping_Stop 是所屬 Vehicle（該 Stop 所屬 Route 的 Vehicle）的 First_Shopping_Stop 但沒有 Stop_Items，或不是所屬 Vehicle 的 First_Shopping_Stop，THE Itinerary_Editor SHALL 在該 Stop 所屬 Route 的 Trip_Day 為它產生一則 Planning_Warning：前者為「{車名}在{地點}的採買沒有品項」，後者為「{車名}在{地點}只標示採買，品項列在第 {N} 天的{第一個地點}」（不論 First_Shopping_Stop 有沒有 Stop_Items 都產生）；{車名} 是所屬 Vehicle 的名稱，{地點} 是該 Stop 的地點名稱，N 是所屬 Vehicle 的 First_Shopping_Stop 所屬 Route 的 Trip_Day 序號（第 1 天為 1，以阿拉伯數字表示），{第一個地點} 是該 First_Shopping_Stop 的地點名稱（D28）。例如把 Example_Trip 八個品項的「誰負責買」都改成第一車的駕駛小安後，第 1 天產生「第三車・採買組在超市／賣場的採買沒有品項」；在 Example_Trip 第 3 天第三車・採買組的 Route 加上超市／賣場的採買 Stop 並儲存後，第 3 天產生「第三車・採買組在超市／賣場只標示採買，品項列在第 1 天的超市／賣場」。有 Stop_Items 的 First_Shopping_Stop（包含 Stop_Items 都已買齊時）不產生這則提醒。除了本條為 Shopping_Stop 產生的提醒，Itinerary_Editor 不產生其他與採買品項有關的 Planning_Warning：屬於 Unassigned_Shopping 的品項（包含 Buyer_Car 沒有任何 Shopping_Stop 的品項）只在「未分配採買清單」（需求 6.8）以需求 6.11 的原因說明，例如上述改由小安負責的八個品項的原因為「第一車還沒有採買停靠點」，任何一天都不產生關於第一車採買的 Planning_Warning（D30）。
6. WHILE 正在編輯的那一天有 Planning_Warning，THE Itinerary_Editor SHALL 在當天摘要列下方以清單列出該天全部 Planning_Warning（每則一個清單項目），不需要展開即可看到，且不論選擇「路線」或「活動」分段都顯示；清單依產生提醒的條文順序（需求 9.1 至 9.5）排列，同一條文產生的多則提醒依 Vehicle 在 `state.vehicles` 的順序排列，同一條 Route 的多個 Shopping_Stop 依 Stop 的順序排列；需求 9.5 的兩種提醒不依種類分開，一起依這個順序排列，例如在 Example_Trip 第 3 天第三車・採買組與第四車的 Route 各加上超市／賣場的採買 Stop 並儲存後，第 3 天的清單依序為「第三車・採買組在超市／賣場只標示採買，品項列在第 1 天的超市／賣場」與「第四車在超市／賣場的採買沒有品項」。當天沒有 Planning_Warning 時不顯示提醒清單。
7. THE Itinerary_Editor SHALL 不因 Planning_Warning 拒絕任何儲存或增加確認步驟，例如儲存沒有出發時間的 Route 時與其他 Route 一樣直接寫入 Trip_State；Planning_Warning 本身不寫入 Trip_State，產生或消失時也不觸發儲存。
8. WHILE 一個 Trip_Day 有 Planning_Warning，THE Itinerary_Editor SHALL 在該天的選日按鈕（包含正在編輯的那一天）以阿拉伯數字顯示該天的 Planning_Warning 則數，並讓按鈕的無障礙名稱包含按鈕上的「第 N 天」、日期與「{提醒數} 則提醒」；數字與按鈕上的其他文字一樣遵守需求 4.3。沒有 Planning_Warning 的選日按鈕不顯示數字，無障礙名稱也不包含「則提醒」。例如 Example_Trip 的選日按鈕都不顯示數字；刪除第 1 天第四車的 Route 後，第 1 天的選日按鈕顯示「1」，無障礙名稱包含「1 則提醒」。
9. WHEN Trip_State 改變（不論在哪個主分頁、對話框或 Trip_Menu 儲存，或載入另一個瀏覽器分頁或伺服器的版本），THE Itinerary_Editor SHALL 在下一次畫面更新時依新的 Trip_State 重新產生每一天的 Planning_Warning、提醒清單與選日按鈕上的數字，車名與地點使用新的名稱；Draft 中尚未儲存的修改不改變 Planning_Warning，例如在 Route 的 Draft 填上出發時間後，「{車名}的出發時間待定」在儲存前仍然列出。
10. THE Itinerary_Poster SHALL 不顯示 Planning_Warning 與提醒數量；Itinerary_Text（包含 Text_Panel 顯示與複製的文字）與列印內容也不包含 Planning_Warning。

### Requirement 10: 草稿、儲存與刪除確認

**User Story:** 身為規劃行程的人，我希望修改要按儲存才生效，誤切換時會被提醒，以便不會意外遺失資料，也不會寫入一半的修改。

#### Acceptance Criteria

1. THE Itinerary_Editor SHALL 同一時間最多展開一張可編輯的卡片（Route、Activity、自訂活動、Meal_Moment、地點、「這一天的設定」，以及路線清單下方的「預計幾點抵達」），展開一張卡片時收起原本展開的卡片；尚未儲存過的新卡片不顯示刪除按鈕，收起後不留在清單中；卡片中的修改在使用者啟動「儲存」並通過需求 10.10 的檢查前都是 Draft，不寫入 Trip_State。
2. WHILE 有 Draft，WHEN 使用者展開另一張卡片（含啟動「＋新增路線」「轉成路線」「自訂活動」與新增地點）、收起目前的卡片或包含它的區塊（例如 Places_And_Cars）、啟動另一個項目的刪除按鈕、切換日子、切換「路線」「活動」分段、切換 View_Switch、切換主分頁（含「到料理菜單編輯」與「到採買清單調整負責人」）、開啟 Trip_Menu、Vehicle_Dialog 或 Trip_Settings_Dialog，或啟動在同一分頁前往其他畫面的連結（例如出發模式與我的旅行；另開分頁的地圖連結除外），THE Itinerary_Editor SHALL 先以與既有對話框相同的確認「尚有未儲存的修改。確定放棄？」詢問：使用者確認時，捨棄整個 Draft（Draft 中新增的 Place 不加入 Place_List）後再執行該操作；使用者取消時不執行該操作，展開的卡片、Draft、選取的日子、分段、檢視與主分頁都維持不變。
3. WHILE 有 Draft，WHEN 使用者重新整理頁面、關閉分頁或視窗，或在同一分頁前往另一個網頁，THE Trip_View SHALL 觸發瀏覽器的離開確認。
4. WHEN 使用者啟動一張卡片的「儲存」且通過需求 10.10 的檢查，THE Itinerary_Editor SHALL 以一次寫入（Local_Planner 寫入一次 localStorage，Account_Mode 送出一次儲存請求）保存該卡片的全部修改與連帶變更：Route 的欄位與 Stop（新增、移除、排序與內容）、Draft 中新增的 Place，以及需求 19.5 清除的 `meeting`；Trip_State 的其他內容（例如同一筆 Activity 的完成狀態）維持儲存當下的值，並在 Local_Planner 寫入成功或 Account_Mode 收到儲存成功的回應後收起該卡片。
5. IF 儲存失敗（Account_Mode 的版本衝突、登入失效、網路錯誤、伺服器拒絕或其他錯誤，或 Local_Planner 無法寫入 localStorage），THEN THE Itinerary_Editor SHALL 讓該卡片維持展開並顯示使用者的輸入，顯示與既有行程儲存相同的儲存警示（錯誤訊息與按鈕），讓警示中的匯出（「匯出未存內容」或「匯出目前內容」）與重新儲存（「重試儲存」或「處理儲存問題」）都包含這張卡片的修改，且 Account_Mode 依既有規則在重新儲存成功或重新載入前不接受其他儲存。
6. WHILE Account_Mode 有尚未回應的儲存請求，THE Itinerary_Editor SHALL 停用送出中卡片的欄位，以及所有「儲存」、刪除、新增、勾選「完成」與展開或收起卡片的控制項，並以既有的同步狀態顯示「正在儲存…」，讓重複啟動「儲存」只送出一次請求。
7. WHEN Editor_User（包含 Collaborator，需求 21.2）啟動清單中已有的 Route、Activity 或 Place 的刪除按鈕，THE Itinerary_Editor SHALL 開啟既有的移除確認視窗（標題「移除這個項目？」、依 Local_Planner 或 Account_Mode 顯示既有說明、按鈕為「取消」與「確認移除」；刪除 Place 時先依需求 2.7 檢查，仍被使用時不開啟）：使用者啟動「確認移除」時，捨棄該卡片的 Draft、不另外詢問，並以一次寫入刪除該項目（刪除 Route 時連同它的 Stop；採買品項不刪除，依需求 6.11 重新推導）；使用者啟動「取消」或關閉視窗時不刪除，卡片與 Draft 維持原狀；刪除的寫入失敗時，畫面維持刪除後的內容並顯示需求 10.5 的儲存警示，警示中的匯出與重新儲存包含這次刪除。
8. WHEN 使用者以需求 6.14 的移除按鈕在 Route 卡片中移除一個 Stop（每位 Editor_User 都可以移除，不論該 Stop 是否已儲存），THE Itinerary_Editor SHALL 不開啟確認視窗，只從 Draft 移除該 Stop，在使用者儲存 Route 時才寫入，採買品項依需求 6.11 重新推導；使用者放棄 Draft 時，已儲存的 Stop 恢復原狀。
9. THE Itinerary_Editor SHALL 在使用者於展開的卡片中做出第一個變更（輸入文字、選擇選項、勾選或取消勾選、新增、移除或排序 Stop，或以「＋新增地點」新增 Place）時開始 Draft，之後改回原值仍視為有 Draft；並在儲存通過需求 10.10 的檢查並開始寫入、使用者確認放棄、使用者確認刪除該項目，或頁面重新載入時結束 Draft；沒有 Draft 時，需求 10.2 列出的操作直接執行，不詢問；「完成」核取方塊（需求 7.8）與尚未加入的「常用活動」勾選不屬於 Draft。
10. IF 使用者啟動「儲存」時，該卡片違反需求 2 至 8 的欄位規則，或套用該卡片的修改後 Trip_State 未通過 State_Validator，THEN THE Itinerary_Editor SHALL 不寫入任何內容（Local_Planner 不寫入 localStorage，Account_Mode 不送出請求），讓卡片維持展開並保留 Draft，標示每個未通過的欄位（無法對應到欄位的錯誤顯示在卡片的錯誤訊息中），並把焦點移到第一個未通過的欄位，沒有對應欄位時移到該錯誤訊息。
11. WHILE 有 Draft，WHEN 畫面因需求 10.2 以外的原因更新（例如勾選「完成」、加入常用活動、啟動「不使用舊資料」、切換深淺色主題，或在 Local_Planner 以瀏覽器的上一頁、下一頁離開 Trip_View 後再回來），THE Itinerary_Editor SHALL 保留該卡片的展開狀態與 Draft，焦點原本在卡片內時維持在同一個欄位；其中 Local_Planner 收到另一個分頁的更新時，比照既有對話框開啟時的規則不套用該更新，並顯示既有的另一分頁更新提示。

### Requirement 11: 行程圖的內容

**User Story:** 身為旅伴，我希望一眼看出每天幾台車從哪裡出發、途中去哪裡、幾點會合、接著做什麼，以便不用讀長長的清單。

#### Acceptance Criteria

1. WHILE Trip_State 至少有一條 Route、一筆 Legacy_Departure、一筆 Activity 或一筆 Meal，THE Itinerary_Poster SHALL 依日期順序為每個 Trip_Day 顯示恰好一個段落（沒有任何 Route、Legacy_Departure、Activity 與 Meal_Moment 的日子也顯示，只有段落開頭），相鄰兩個段落之間各有一條線寬 1 到 2 CSS 像素的橫向分隔線，第一個段落之前與最後一個段落之後沒有分隔線。
2. THE Itinerary_Poster SHALL 在每一天段落的開頭顯示天數徽章、Day_Title，以及以「・」連接的日期與 Day_Caption：天數徽章為第 N 天補零成兩位數的數字（例如「01」），第 1、4、7…天使用珊瑚底色，第 2、5、8…天使用天空藍底色，第 3、6、9…天使用草綠底色；Day_Title 未設定時為「第 {N} 天」；日期格式為「{月}/{日}（週{星期}）」，月與日不補零，星期為一、二、三、四、五、六、日之一；該天有 Day_Location，但 Day_Caption 不是「今天，留在{Day_Location}」，段落中也沒有標示 Day_Location 的營地插畫（需求 11.6(a)）時，段落開頭另外顯示「地點：{Day_Location}」；例如 Example_Trip 第 1 天顯示「01」「向山裡出發」與「10/20（週二）・四車出發・採買・會合」，第 3 天另外顯示「地點：夕淞度日營區」。
3. THE Itinerary_Poster SHALL 依下列規則產生 Day_Caption：(a) 當天至少有一條 Route，或當天是 First_Day 且至少一台 Vehicle 依需求 19.3 顯示 Legacy_Departure 時，以「・」依序連接「{Chinese_Numeral}車出發」（數字為當天有 Route 的 Vehicle 數加上當天顯示 Legacy_Departure 的 Vehicle 數）、「採買」（當天至少有一個 Shopping_Stop 時）、「會合」（當天 Meeting_Count 大於等於 2 時）與「返程」（當天有需求 14.12 的返程行時），條件不成立的部分省略；(b) 其他日子，有 Day_Location 時為「今天，留在{Day_Location}」，沒有 Day_Location 時為「今天，自由安排」；例如 Example_Trip 三天的 Day_Caption 依序為「四車出發・採買・會合」「今天，留在夕淞度日營區」「四車出發・返程」。
4. THE Itinerary_Poster SHALL 在每一天的段落中依與 Itinerary_Text 相同的 Day_Sequence（需求 14.8）排列 Route_Block 與 Activity_Block，區塊內的 Route 依需求 5.2、Activity 與 Meal_Moment 依需求 14.13 排序，讓段落中各項目的 HTML 文件順序與 Itinerary_Text 中對應各行的順序相同。
5. THE Itinerary_Poster SHALL 把每個 Route_Block 畫成一張路線圖：(a) 依 Itinerary_Text 中該區塊各行的順序，為每條 Route 與該區塊中每筆 Legacy_Departure（需求 14.15）各列一個出發項目，依序顯示出發時間（沒有時為「出發時間待定」）、車名與起點名稱；(b) 為每條 Route 畫恰好一條 Car_Color 的線，從起點依 Stop 的順序經過每個 Stop 到終點；(c) 同一區塊中終點相同的線匯合成一條道路，共用一個終點插畫；(d) Legacy_Departure 依需求 19.3 只有出發項目，沒有線；例如 Example_Trip 第 1 天的出發項目（時間、車名、起點）依序為 08:00 第一車 出發地點 A、08:30 第二車 出發地點 B、09:00 第三車・採買組 出發地點 C、09:30 第四車 出發地點 D，四條線匯合後到達同一個營地插畫。
6. THE Itinerary_Poster SHALL 為每個 Route_Block 中每個不同的終點畫一個終點插畫並以文字標示：(a) 終點是 Day_Location 時為營地插畫，旁邊顯示 Day_Location，該區塊有到達行（需求 14.11）時另外顯示到達行；(b) Last_Day 中不是 Day_Location 的終點為房屋插畫，旁邊顯示「平安回到{終點}」；(c) 其他終點為地標插畫，旁邊顯示終點名稱；例如 Example_Trip 第 1 天的營地旁顯示「夕淞度日營區」與「預計 12:00 抵達・四車會合」，第 3 天的房屋旁顯示「平安回到台北」。
7. THE Itinerary_Poster SHALL 為每個 Stop 在所屬 Route 的線上依 Stop 的順序各畫一個任務類型插圖（採買為商店、接送為人物、取還裝備為裝備、其他為地標），並在插圖旁顯示與 Itinerary_Text（需求 14.10）相同的 Stop 內容：地點名稱，加上採買時的「採買：{Shopping_Summary}」、接送或取還裝備時的「{任務類型}：{備註}」、其他時的備註；Shopping_Summary 為空字串，或接送、取還裝備沒有備註時只加上任務類型，其他沒有備註時只顯示地點名稱；例如 Example_Trip 第 1 天第三車・採買組的商店旁顯示「超市／賣場」與「採買：五花肉片、鮮蝦、高麗菜、運動飲料、洋芋片、瓦斯、衛生紙、免洗餐具」。
8. WHERE 一個 Route_Block 至少有一個 Shopping_Stop，THE Itinerary_Poster SHALL 在該路線圖下方顯示「{車名}先採買」，車名為該區塊中有 Shopping_Stop 的 Route 的車名，依需求 5.2 的順序以「、」連接；該區塊沒有 Legacy_Departure，且沒有 Shopping_Stop 的 Route 至少有一條、這些 Route 都沒有任何 Stop 時，後面接上「，其他{Chinese_Numeral}車直達」，數字為這些 Route 的數量；例如 Example_Trip 第 1 天顯示「第三車・採買組先採買，其他三車直達」。
9. THE Itinerary_Poster SHALL 為每筆 Activity 與每個 Meal_Moment 在所屬日期段落的 Activity_Block 中各顯示恰好一張小卡，內容為插圖、時間（Meal_Moment 為 Meal_Time）、標題（Meal_Moment 為需求 8.5 的文字）與類別標籤（Activity 為 Activity_Category，Meal_Moment 為 Meal_Label），Meal_Moment 有食材時另外依需求 8.7 顯示食材；Activity 的插圖由 Activity_Category 決定，前言「活動類別」表的 13 種類別各有一種互不相同的插圖，Meal_Moment 的插圖依需求 8.10；例如 Example_Trip 第 2 天 08:30 的小卡顯示「08:30」「早餐」、標籤「早餐」與「培根、炒蛋、吐司、咖啡」，第 1 天 18:00 的小卡顯示「晚餐：烤肉派對」與標籤「烤肉」。
10. THE Itinerary_Poster SHALL 在 Activity 小卡中，以與 Itinerary_Text 補充行（需求 14.14）相同的條件、內容與順序顯示補充資訊：地點有內容且不同於 Day_Location 時顯示「地點：{地點}」，參加者不是全體旅伴（指定了 Vehicle，或舊旅伴名單沒有包含每位旅伴）時顯示「參加：{車名或旅伴名}」，備註有內容時顯示備註；條件不成立的項目不顯示。
11. WHERE 一筆 Activity 已標記完成，THE Itinerary_Poster SHALL 在該 Activity 小卡顯示勾號圖示與「已完成」文字；未完成的 Activity 小卡不顯示勾號與「已完成」，完成狀態不只以顏色或透明度區分。
12. THE Itinerary_Poster SHALL 依 Vehicle 在 `state.vehicles` 中的順序指定 Car_Color：第 1 到第 8 台車依序使用 8 種在淺色與深色主題中都互不相同的顏色，第 9 台起依相同順序重複（第 k 台與第 k − 8 台相同）；同一台 Vehicle 在每一天與每個 Route_Block 使用相同的 Car_Color，每條線都由出發項目中的車名標示，不只以顏色區分車輛。
13. THE Itinerary_Poster SHALL 在最上方（每日段落或需求 1.8 的提示之前）顯示一行概要，以「・」依序連接 Duration_Text、「{Chinese_Numeral}台車」（數字為 `state.vehicles` 的數量，沒有 Vehicle 時省略此部分）與日期範圍「{開始日期}至 {結束日期}」（日期格式同需求 11.2，一日遊只顯示開始日期），例如 Example_Trip 為「三天兩夜・四台車・10/20（週二）至 10/22（週四）」，並且不顯示旅行名稱與旅行介紹欄位的內容（列印時的封面依需求 13.7）。
14. WHILE Trip_State 至少有一條 Route、一筆 Legacy_Departure、一筆 Activity 或一筆 Meal，THE Itinerary_Poster SHALL 在最後一天的段落之後顯示結尾行「{Chinese_Numeral}台車，{Duration_Text}，一整頁的小小快樂。」（數字為 `state.vehicles` 的數量），沒有 Vehicle 時為「{Duration_Text}，一整頁的小小快樂。」，例如 Example_Trip 為「四台車，三天兩夜，一整頁的小小快樂。」
15. WHERE 旅行至少有一條 Route 或一筆 Legacy_Departure，THE Itinerary_Poster SHALL 緊接在需求 11.14 的結尾行之後顯示「路線僅為示意，非導航或即時位置；不預估返抵時間。」；旅行沒有 Route 也沒有 Legacy_Departure 時不顯示這一行。
16. THE Itinerary_Poster SHALL 只以程式產生的內嵌 SVG 繪製插畫，輪廓線沿用 `src/art.js` 的圓頭、圓角描邊，淺色主題的填色只使用 `src/art.js` 的色票、`src/dish-art.js` 的料理用色與需求 11.12 的 Car_Color（深色主題依需求 17.5），不使用、也不描摹參考圖，不包含點陣圖或任何外部圖片，文字只使用網站既有的字型。
17. THE Itinerary_Poster SHALL 只以既有的 `mapLink()` 把下列地點名稱呈現為地圖連結：出發項目的起點（含 Legacy_Departure 的舊出發地點）、Stop 的地點、終點插畫旁的 Day_Location 與終點名稱（「平安回到{終點}」中只有終點名稱是連結），以及 Activity 小卡「地點：」之後的地點；天數徽章、Day_Caption、頂端概要、採買說明、到達行與結尾行不產生地圖連結。
18. WHILE Schedule_Tab 顯示 Itinerary_Poster，THE Schedule_Tab SHALL 在 Text_Panel 之後顯示既有的結尾小語「好日子，不用急。」；Schedule_Tab 顯示 Itinerary_Editor 時不顯示結尾小語。
19. WHILE Trip_State 沒有任何 Route、Legacy_Departure、Activity 與 Meal，THE Itinerary_Poster SHALL 在需求 11.13 的頂端概要之後顯示需求 1.8 的「這趟旅行還沒有行程」提示，取代每日段落與需求 11.14、11.15 的結尾文字；頂端概要與 Text_Panel（需求 15.1）仍然顯示。

### Requirement 12: 行程圖的動畫

**User Story:** 身為旅伴，我希望行程圖像動圖一樣讓車子依序出發、停靠、會合，以便直覺看懂整趟旅程的進度。

#### Acceptance Criteria

1. WHILE Scene_Motion_State 為 running，THE Itinerary_Poster SHALL 為每個 Route_Block 中的每條 Route 顯示一個以該車 Car_Color 著色的車子圖示：開始移動前停在起點，開始移動後沿著該 Route 的線條，依該 Route 的 Stop 順序經過每個 Stop，最後停在終點；Legacy_Departure 的出發標記不移動（需求 19.3）。
2. WHILE Scene_Motion_State 為 running，THE Itinerary_Poster SHALL 把同一個 Route_Block 的 Route 依出發時間分組（出發時間相同的 Route 為一組，由早到晚排列，沒有出發時間的 Route 為最後一組），第一組在每一輪動畫開始時同時開始移動，之後每一組比前一組晚相同的間隔開始移動；組數不超過 8 時，間隔為 0.4 到 0.8 秒；超過 8 組時，間隔可以小於 0.4 秒，讓每一輪仍符合第 4 條的 12 秒上限，但間隔大於 0 秒；間隔只依組的先後決定，不隨出發時間的實際差距改變。
3. WHILE Scene_Motion_State 為 running，THE Itinerary_Poster SHALL 讓車子圖示到達每個 Stop 後，在該 Stop 的位置停留 0.6 到 1 秒（沿路線的位置不變），再繼續移動。
4. WHILE Scene_Motion_State 為 running，THE Itinerary_Poster SHALL 讓每個 Route_Block 的每一輪動畫，從第一組開始移動到最後一個車子圖示停在終點，費時 4 到 12 秒（不計暫停的時間）；接著停在到達畫面（該 Route_Block 的每個車子圖示都停在各自的終點）2 到 4 秒，然後全部車子圖示回到起點，並在 1 秒內開始下一輪。
5. WHILE Scene_Motion_State 為 running，THE Itinerary_Poster SHALL 只讓車子圖示，以及活動與餐點小卡、Stop 與終點的插圖中的裝飾元素（例如營火、蒸氣、星星、樹木）產生動畫；每個裝飾動畫一次完整循環（變化後回到原狀）至少 1 秒，動畫中的元素不超出所屬插圖的範圍，也不改變任何小卡或路線圖的位置與大小。
6. THE Itinerary_Poster SHALL 讓全部文字（含時間、地點與車名）在動畫的任何時刻都完整顯示：文字的位置、大小、透明度與可見性不隨時間自動改變，車子圖示與裝飾元素在任何時刻都不覆蓋任何文字；路線線條不參與動畫，不逐段畫出、隱藏或淡入淡出。
7. WHILE Scene_Motion_State 為 running，THE Itinerary_Poster SHALL 只在一天的段落有任何部分位於視窗內時播放該段落的動畫（本需求的每個動畫都依此暫停與繼續）：段落完全離開視窗後 1 秒內暫停該段落的全部動畫並停在當下的畫面，段落再有任何部分進入視窗後 1 秒內從暫停的畫面繼續播放。
8. THE Itinerary_Poster SHALL 讓每個改變透明度、顏色或亮度的動畫一次完整循環（變化後回到原狀）至少 1 秒，且畫面在任何 1 秒內都不超過 3 次閃爍（閃爍依 WCAG 2.3.1 的定義）。
9. THE Itinerary_Poster SHALL 只以 CSS 與內嵌 SVG 產生動畫，腳本只用來開始、暫停、繼續與重新播放動畫，不載入 GIF 等動畫圖檔或影片。
10. WHILE Scene_Motion_State 為 running，THE Itinerary_Poster SHALL 在到達畫面把終點相同的車子圖示並排停在該終點的插畫旁，任兩個車子圖示互不重疊，且同一個終點旁的車子圖示數等於該 Route_Block 中以該地點為終點的 Route 數。

### Requirement 13: 減少動態效果、暫停與列印

**User Story:** 身為對動態敏感或想列印行程的旅伴，我希望可以停止動畫並得到完整的靜態行程，以便舒服地閱讀與分享。

#### Acceptance Criteria

1. WHILE Reduced_Motion 成立，THE Itinerary_Poster SHALL 不播放任何以 CSS 或 SVG 產生的動畫或轉場（包含需求 12.1 的車子移動與需求 12.5 的裝飾小動畫），從顯示開始就呈現靜態畫面：每條 Route 的線條從起點經過每個 Stop 完整畫到終點，所有 Stop、地點、時間與文字都顯示，每台車的車子圖示停在自己路線線條的起點，車子圖示互不重疊，也不覆蓋任何文字；頁面開啟期間系統設定才改為減少動態時，不需重新載入即改為這個靜態畫面。
2. WHILE Reduced_Motion 成立，THE Itinerary_Poster SHALL 不顯示 Motion_Toggle，並在頂端概要列（需求 11.13）原本顯示 Motion_Toggle 的位置，顯示與 Trip_Menu「插畫動畫」相同的說明「依系統減少動態設定，插畫保持靜態。」
3. WHILE Reduced_Motion 不成立，THE Itinerary_Poster SHALL 在畫面上的頂端概要列顯示 Motion_Toggle：Scene_Motion_State 為 running 時顯示「暫停動畫」，為 paused 時顯示「播放動畫」，無障礙名稱與顯示文字相同；Motion_Toggle 與 Trip_Menu 的「插畫動畫」使用同一個設定，Scene_Motion_State 依該設定為 running 或 paused（沒有設定時為 running），該設定只保存在這台裝置的瀏覽器，重新載入後維持；頁面開啟期間 Reduced_Motion 才不再成立時，不需重新載入即顯示 Motion_Toggle，並依該設定播放或維持暫停。
4. WHEN 使用者啟動 Itinerary_Poster 或 Trip_Menu 的 Motion_Toggle，THE Trip_View SHALL 不重新載入頁面即在 running 與 paused 之間切換 Scene_Motion_State 並保存設定：改為 paused 時，頁面上所有插畫（包含 Trip_View 的旅行封面插畫與 Itinerary_Poster）的動畫立即暫停；改為 running 時，這些動畫從停住的畫面繼續播放、不從頭開始，Itinerary_Poster 仍依需求 12.7 只播放可視範圍內的段落；兩處的 Motion_Toggle（包含之後才開啟的 Trip_Menu）都顯示新的狀態，焦點留在剛啟動的 Motion_Toggle。
5. WHILE Scene_Motion_State 為 paused，THE Itinerary_Poster SHALL 讓車子圖示與裝飾動畫停在暫停當下的位置與樣子，不論經過多久或是否捲動頁面都不再改變，所有文字保持完整顯示；暫停期間才顯示的 Itinerary_Poster（重新載入、從 Itinerary_Editor 或其他主分頁回到行程圖，或畫面因資料更新而重新產生時）呈現與本需求第 1 條相同的靜態畫面。
6. WHEN 使用者在 Schedule_Tab 列印（以瀏覽器的列印功能或 Trip_Menu 的「列印目前頁面」；本需求第 7 至 9 條相同），THE Trip_View SHALL 不論畫面上顯示 Itinerary_Poster 或 Itinerary_Editor，都只依序列印以目前 Trip_State（不含 Draft）產生的下列內容：列印封面（本需求第 7 條）、Itinerary_Poster 的每一天段落與需求 11.14、11.15 的結尾文字（Itinerary_Poster 顯示需求 1.8 的提示時，改為列印該提示），以及需求 11.18 的結尾小語；Trip_View 的麵包屑與旅行封面、View_Switch、Itinerary_Editor（含 Planning_Warning）、Motion_Toggle、Text_Panel 與所有按鈕都不列印，列印也不改變畫面上的檢視、正在編輯的那一天、Draft 與 Trip_State。
7. WHEN 使用者在 Schedule_Tab 列印，THE Trip_View SHALL 在列印內容的最上方印出列印封面，依序為旅行名稱、頂端概要列的文字（不含 Motion_Toggle）與旅行介紹（每個非空白行為一段，旅行介紹空白時省略），例如 Example_Trip 依序為「夕淞度日」「三天兩夜・四台車・10/20（週二）至 10/22（週四）」「一起，把日子過慢一點。」「把喜歡的小地方，畫進我們的旅程。」；列印封面只出現在列印中，頂端概要列的文字在列印中只出現在列印封面。
8. WHEN 使用者在 Schedule_Tab 列印，THE Trip_View SHALL 不論 Scene_Motion_State 為何，都以本需求第 1 條的靜態畫面列印 Itinerary_Poster，並且不論目前是淺色或深色主題，都以白色頁面背景與淺色主題的文字、線條與插畫顏色列印。
9. WHEN 使用者在 Schedule_Tab 列印，THE Trip_View SHALL 讓列印封面，以及高度不超過一頁可列印高度（紙張高度扣除列印邊界）的每一天段落，各自完整印在同一頁，放不下時整段從下一頁開始；只有單一天段落超過一頁可列印高度時才在該段落中換頁，這時天數標題列（天數徽章、Day_Title、日期、Day_Caption，以及需求 11.2 的「地點：」行）與該段落的第一個 Route_Block 或 Activity_Block 從同一頁開始，高度不超過一頁的路線圖與小卡不被切開，任何一行文字也不被切開。

### Requirement 14: 文字版格式

**User Story:** 身為規劃行程的人，我希望行程文字永遠用同一種格式產生，以便大家讀起來一致，貼到聊天群組也整齊。

#### Acceptance Criteria

1. THE Itinerary_Text SHALL 只由下列部分依序組成：標題行（需求 14.2）、旅行介紹段落（需求 14.3）、車輛行（需求 14.4），以及依日期順序、每個 Trip_Day 各一個的段落（需求 14.5 至 14.15，當天沒有任何 Route、Legacy_Departure、Activity 與 Meal_Moment 時也輸出）；沒有內容的部分整個省略，不留下空行；相鄰兩個部分之間恰好一個空行；行與行之間以一個 LF（U+000A）分隔；空行不含任何字元；第一行與最後一行都不是空行，最後一行之後沒有換行字元；任何位置都沒有連續兩個空行；Itinerary_Text 不包含本需求未列出的內容，例如旅行小叮嚀、Planning_Warning、Activity 的完成狀態，以及料理的主廚、份數與料理筆記。
2. THE Itinerary_Text SHALL 以標題行「{旅行名稱}｜{Duration_Text}」作為第一行，Duration_Text 依 Trip_Day 的數量（1 到 31）計算；旅行名稱依需求 14.16 處理後為空字串時，標題行只有「{Duration_Text}」。
3. THE Itinerary_Text SHALL 以換行字元（需求 14.16）把旅行介紹分成多行，每行去除前後空白後捨棄空字串，其餘每行依原順序各成一個段落，段落之間恰好一個空行；旅行介紹沒有任何非空白行時，省略旅行介紹段落。
4. WHILE 旅行至少有一台 Vehicle，THE Itinerary_Text SHALL 輸出車輛行「車輛：{車名清單}」，車名清單依 `state.vehicles` 的順序列出每台 Vehicle 的車名（包含沒有 Route 的 Vehicle），以「、」連接。
5. THE Itinerary_Text SHALL 以「第 {N} 天・{月}/{日}（週{星期}）｜{Day_Title}」作為每個 Trip_Day 段落的第一行：N 是從 First_Day 起算的天數（First_Day 為 1）；月與日是不補零的阿拉伯數字；星期依該日期在公曆中的星期決定，星期一至星期日依序為一、二、三、四、五、六、日，與裝置的時區及語系設定無關；Day_Title 未設定，或依需求 14.16 處理後為空字串時，省略「｜{Day_Title}」。
6. WHILE 一個 Trip_Day 有 Day_Location，THE Itinerary_Text SHALL 在該天段落的第二行輸出地點行「地點：{Day_Location 的名稱}」。
7. THE Itinerary_Text SHALL 讓每個 Trip_Day 段落依序包含第一行、地點行（有 Day_Location 時），以及依 Day_Sequence 排列的 Route_Block 與 Activity_Block，每個區塊之前恰好一個空行：Route_Block 依序為「路線」一行、路線行與舊出發行（需求 14.9、14.15），以及適用時的到達行或返程行（需求 14.11、14.12）；Activity_Block 依序為「活動」一行，以及每個項目的項目行與補充行（需求 14.13、14.14）；沒有任何區塊的 Trip_Day 段落只有第一行與地點行。
8. THE Itinerary_Text SHALL 依下列規則決定 Day_Sequence（Activity 使用其時間，Meal_Moment 使用 Meal_Time）：(a) 當天的 Arrival_Routes 組成一個 Route_Block，Other_Routes 組成另一個 Route_Block；First_Day 的 Arrival_Routes Route_Block 另外包含需求 14.15 的舊出發行；沒有任何路線行與舊出發行的 Route_Block 省略；(b) Route_Block 的排序時間是其中最早的出發時間（包含舊出發行的時間），區塊中每一行都沒有出發時間時，該 Route_Block 沒有排序時間；(c) 有排序時間的 Route_Block 排在時間早於或等於其排序時間的所有 Activity 與 Meal_Moment 之後，以及時間晚於其排序時間的所有 Activity 與 Meal_Moment 之前；沒有排序時間的 Arrival_Routes Route_Block 排在當天所有 Activity 與 Meal_Moment 之前，沒有排序時間的 Other_Routes Route_Block 排在當天所有 Activity 與 Meal_Moment 之後；(d) 兩個 Route_Block 之間沒有任何 Activity 或 Meal_Moment 時，依排序時間由早到晚排列；排序時間相同，或其中一個 Route_Block 沒有排序時間時，Arrival_Routes 的 Route_Block 排在前面；(e) Route_Block 之前、之間與之後連續的 Activity 與 Meal_Moment 各組成一個 Activity_Block，區塊內依需求 14.13 排序；沒有項目的 Activity_Block 省略。
9. THE Itinerary_Text SHALL 在 Route_Block 的「路線」之後，依需求 5.2 的順序為每條 Route 輸出一個路線行「{車名}｜{HH:MM} 出發：{地點串}」：地點串依序為起點、Route 依序經過的每個 Stop（需求 14.10）與終點，以「 → 」連接；沒有 Stop 時，地點串為「{起點} → {終點}」；沒有出發時間時，以「出發時間待定」取代「{HH:MM} 出發」，例如「第一車｜出發時間待定：出發地點 A → 夕淞度日營區」。
10. THE Itinerary_Text SHALL 依任務類型輸出每個 Stop：採買為「{地點}（採買：{Shopping_Summary}）」，接送為「{地點}（接送：{備註}）」，取還裝備為「{地點}（取還裝備：{備註}）」，其他為「{地點}（{備註}）」；採買的 Shopping_Summary 為空字串，或接送、取還裝備的備註為空字串時，輸出「{地點}（{任務類型}）」；其他的備註為空字串時，只輸出「{地點}」；採買 Stop 的備註不輸出。例如不是 First_Shopping_Stop 的 Shopping_Stop 沒有 Stop_Items，輸出「超市／賣場（採買）」（需求 6.9）。
11. WHILE 一個 Trip_Day 至少有一條 Arrival_Routes 中的 Route，THE Itinerary_Text SHALL 在當天 Arrival_Routes Route_Block 的最後一行輸出到達行：有 Arrival_Time 時為「預計 {Arrival_Time} 抵達」，沒有 Arrival_Time 時為「預計抵達時間待定」；Meeting_Count 大於等於 2 時，在後面接上「・{Meeting_Count 的 Chinese_Numeral}車會合」，例如「預計抵達時間待定・兩車會合」。
12. WHILE Last_Day 的 Other_Routes 中至少有一條終點不是 Day_Location 的 Route，THE Itinerary_Text SHALL 在 Last_Day Other_Routes Route_Block 的最後一行輸出返程行「平安返回{終點清單}・不預估返抵時間」：終點清單依該區塊路線行的順序，列出每個不是 Day_Location 的終點，同一地點只列一次，以「、」連接，例如「平安返回台北、新竹・不預估返抵時間」；Last_Day 沒有 Day_Location 時，每個終點都視為不是 Day_Location；Last_Day 以外的日子不輸出返程行。
13. THE Itinerary_Text SHALL 在 Activity_Block 的「活動」之後，為區塊中的每筆 Activity 與每個 Meal_Moment 各輸出一個項目行，依時間由早到晚排列；時間相同時 Activity 在前，Activity 之間依 `state.activities` 的順序，Meal_Moment 之間依料理菜單的餐次順序（早餐、午餐、下午茶、晚餐、消夜；舊資料的「早」「午」「晚」「宵夜」依序與早餐、午餐、晚餐、消夜同序，與需求 8.2 及 `src/meal-order.js` 相同；其他舊資料的自訂餐次在最後），餐次同序時再依 `state.meals` 的順序；Activity 的項目行為「{HH:MM} {標題}（{Activity_Category}）」，Legacy_Activity_Type 依前言「活動類別」表對應類別，標題為空字串時以 Activity_Category 代替標題；Meal_Moment 的項目行為「{HH:MM} {餐次}：{料理名稱}（{Meal_Label}）」，料理名稱為空字串或與餐次相同時為「{HH:MM} {餐次}（{Meal_Label}）」。
14. THE Itinerary_Text SHALL 在每個項目行之後、下一個項目行之前，依序輸出該項目的補充行：Meal_Moment 有食材時輸出一行食材行（需求 8.7 的食材名稱，依原順序以「、」連接）；Activity 依序輸出「地點：{地點}」（地點不是空字串，且依需求 2.1(d) 的比較方式與 Day_Location 的名稱不同時）、「參加：{參加清單}」（參加者不是全體旅伴時）與「備註：{備註}」（備註不是空字串時）；Activity 沒有指定車輛，且旅伴名單是空的或包含每一位旅伴時，參加者是全體旅伴；其他情況下，有指定車輛時參加清單依指定的順序列出車名，沒有指定車輛時依旅伴名單的順序列出旅伴名，以「、」連接；有補充行的項目不是所屬 Activity_Block 的最後一個項目時，在其最後一個補充行之後輸出一個空行。
15. WHILE 一個 Vehicle 在 First_Day 沒有 Route 且有 Legacy_Departure，THE Itinerary_Text SHALL 在 First_Day 的 Arrival_Routes Route_Block 中為該車輸出一個舊出發行「{車名}｜{HH:MM} 出發：{舊出發地點}」：時間與地點依 Trip_Menu 車輛卡片目前解析 `meeting` 的規則拆出（開頭的 HH:MM 後接「·」「・」「|」或「｜」時，拆成時間與其後的地點；只有 HH:MM 時只有時間；無法拆出時間時，整段文字是地點）；沒有時間時以「出發時間待定」取代「{HH:MM} 出發」，沒有地點時以「出發地點待定」取代「{舊出發地點}」；舊出發行與路線行一起依需求 5.2 的規則排序，不輸出終點，不計入 Meeting_Count；只有舊出發行的 Route_Block 不輸出到達行。
16. THE Itinerary_Text SHALL 只對使用者文字（旅行名稱、旅行介紹、旅行目的地、地點名稱、車名、車輛的舊出發資料、Day_Title、Stop 的備註、Activity 的標題、地點與備註、餐次、料理名稱、食材名稱、採買品項名稱與旅伴名）做下列處理後輸出：去除前後的空白字元（Unicode White_Space，含全形空白）；旅行介紹以外的文字中，把每一段至少含一個換行字元（CR、LF、U+000B、U+000C、U+0085、U+2028 或 U+2029）的連續空白字元換成一個半形空白；其他字元原樣輸出，不做 HTML 跳脫、不截斷，也不合併不含換行字元的空白。
17. WHEN Itinerary_Text 由 Example_Trip 產生，THE Itinerary_Text SHALL 與 Example_Text 逐字相同，包括每一個空行、標點與半形空白，且最後一行「平安返回台北・不預估返抵時間」之後沒有換行字元。
18. THE Itinerary_Text SHALL 對每一個通過 State_Validator 的 Trip_State 符合下列兩點：(a) 每條 Route、每個依需求 14.15 輸出的 Legacy_Departure、每筆 Activity 與每個 Meal_Moment 各恰好對應一個項目行（路線行、舊出發行或 Activity_Block 的項目行），該行只出現在其日期所屬的 Trip_Day 段落中，且段落中沒有不對應任何項目的路線行、舊出發行或項目行；(b) 內容相同（JSON 值相等）的 Trip_State 每次產生的文字逐字相同，不受產生的時間、裝置的時區與語系，以及畫面上選擇的檢視、日子或分段影響。
19. THE Itinerary_Text SHALL 讓本需求格式中的固定字元與 Example_Text 相同：「｜」為 U+FF5C，「・」為 U+30FB，「：」為 U+FF1A，「（」「）」為 U+FF08 與 U+FF09，「、」為 U+3001，「→」為 U+2192 且前後各一個半形空白，日期中的「/」與時間中的「:」為半形字元；「第 {N} 天」、「{HH:MM} 出發」、「預計 {Arrival_Time} 抵達」與項目行時間之後的空格都是一個半形空白（U+0020）；所有時間都是補零的 24 小時制 HH:MM。

### Requirement 15: 文字版的顯示與複製

**User Story:** 身為旅伴，我希望可以展開文字版並一鍵複製，以便貼到聊天群組通知大家。

#### Acceptance Criteria

1. THE Itinerary_Poster SHALL 在其他所有內容（包含需求 11.14 與 11.15 的結尾文字）之後、需求 11.18 的結尾小語「好日子，不用急。」之前顯示標題為「文字版」的 Text_Panel；需求 1.8 的「這趟旅行還沒有行程」提示顯示時也一樣。Text_Panel 包含展開／收起控制項、「複製文字」按鈕，以及顯示 Itinerary_Text 的文字區域。「複製文字」按鈕在收起與展開時都顯示，文字區域只在展開時顯示。
2. WHEN 使用者啟動「複製文字」按鈕，THE Trip_View SHALL 以純文字把依目前 Trip_State 產生的完整 Itinerary_Text 寫入剪貼簿，並在寫入成功後以既有的提示訊息區域（`notify()`）顯示「已複製行程文字」。寫入的文字與 Itinerary_Text 逐字相同：保留所有換行與空行；使用者文字中的 `&`、`<` 等字元不轉成 HTML 字元參照；不包含「文字版」標題、按鈕文字或其他畫面文字。Text_Panel 收起或展開時寫入的文字都相同，複製也不改變 Text_Panel 的展開狀態。
3. IF 瀏覽器沒有提供剪貼簿寫入功能，或寫入剪貼簿被拒絕或失敗，THEN THE Trip_View SHALL 展開 Text_Panel（已展開時維持展開），選取文字區域中的完整 Itinerary_Text，並以同一個提示訊息區域顯示「請手動複製已選取的文字」，不顯示「已複製行程文字」。選取的文字與 Itinerary_Text 逐字相同，不包含「文字版」標題與按鈕文字。
4. THE Text_Panel SHALL 讓 Viewer、Collaborator、Trip_Manager 與 Local_Planner 的使用者都能展開、收起與複製，包含離線、帳號版的儲存請求尚未回應，以及儲存失敗而仍有未儲存內容的時候。
5. THE Text_Panel SHALL 在文字區域以純文字顯示 Itinerary_Text，規則如下：
   - 顯示的文字與 Itinerary_Text 逐字相同，保留每一個換行、空行與連續空白。
   - 使用者文字中的 HTML 標記與字元參照（例如 `<b>`、`&`）原樣顯示為文字，不產生任何元素，也不轉成其他字元。
   - 使用者可以選取文字區域中的文字，但不能輸入或修改。
   - 在 320 到 1440 CSS 像素寬的視窗中，超過文字區域寬度的行（包含沒有空白的長字串）在區域內折行，文字區域不產生水平捲動。
6. WHEN Trip_State 改變（例如在 Itinerary_Editor、料理菜單、Trip_Menu 或 Trip_Settings_Dialog 儲存，或載入另一分頁的本機更新），THE Text_Panel SHALL 在下一次畫面更新時顯示依新的 Trip_State 產生的 Itinerary_Text，之後啟動「複製文字」也寫入這份新的文字，不需要重新載入頁面。
7. WHEN 使用者開啟 Trip_View 或重新載入頁面，THE Text_Panel SHALL 以收起狀態顯示。此後展開狀態只在使用者操作展開／收起控制項，或依需求 15.3 展開時改變。畫面更新（例如 Trip_State 改變或切換深淺色主題）、切換 View_Switch，以及切換主分頁後回到 Schedule_Tab 時，都維持使用者最後選擇的狀態。
8. WHEN 使用者展開或收起 Text_Panel，或啟動「複製文字」，THE Trip_View SHALL 不改變 Trip_State（包含「小隊最近的動態」）、不寫入 localStorage，也不送出任何寫入伺服器的請求。
9. WHEN 使用者在 Schedule_Tab 列印，THE Trip_View SHALL 不列印 Text_Panel 的任何部分（標題、展開／收起控制項、「複製文字」按鈕與文字區域），不論 Text_Panel 是否展開。

### Requirement 16: 無障礙

**User Story:** 身為使用鍵盤、螢幕報讀器或手機的旅伴，我希望能看懂行程圖並操作規劃行程，以便每個人都能參與規劃。

#### Acceptance Criteria

1. THE Itinerary_Poster SHALL 把所有插畫、路線線條、車子圖示與裝飾圖示標記為 `aria-hidden="true"`（`aria-hidden` 的元素內不含可取得焦點的元件），插畫中不放文字，並以 HTML 元素的文字呈現 Itinerary_Text 每個 Trip_Day 段落中每一行的每一項資訊（需求 1.8 的提示取代每日段落時除外，這時這些資訊只在 Text_Panel 中）：日期、Day_Title、Day_Location、時間、車名、地點、任務類型、Shopping_Summary、備註、活動標題、Activity_Category、餐次、料理名稱、Meal_Label、食材與參加者（畫面上只以插圖表示的 Activity_Category 與 Meal_Label 可以是只提供給輔助技術的文字）；在無障礙樹中，每一天的 Route、Legacy_Departure 的出發標記、到達行、返程行、Activity 與 Meal_Moment 依 Itinerary_Text 的先後順序出現，且這些資訊不能只放在 `aria-hidden` 的元素或 CSS 產生的內容中（WCAG 2.2 SC 1.1.1、1.3.2）。
2. THE Itinerary_Poster SHALL 以第 2 層標題「行程圖」開始（可以只提供給輔助技術），並以第 3 層標題開始每一天的段落，標題的無障礙名稱依序包含「第 N 天」、日期與星期，以及有設定時的 Day_Title；每個 Route_Block 與 Activity_Block 各是一個清單，無障礙名稱分別為「路線」與「活動」，其中每條 Route、每個 Legacy_Departure 的出發標記、每筆 Activity 與每個 Meal_Moment 各是一個清單項目；畫面上的日期與時間以 `time` 元素標示，`datetime` 分別為 `YYYY-MM-DD` 與 `HH:MM`，「時間待定」「出發時間待定」不使用 `time` 元素（WCAG 2.2 SC 1.3.1）。
3. THE Itinerary_Editor SHALL 讓每項操作都能只用鍵盤完成（WCAG 2.2 SC 2.1.1、2.1.2）：Tab 與 Shift+Tab 依閱讀順序（由上到下，同一列由左到右）經過每個互動元件，收起的內容與沒有顯示的檢視不取得焦點，焦點不會困在任何元件或區塊中；按鈕以 Enter 與空白鍵啟動，核取方塊以空白鍵切換，單選按鈕以方向鍵選取，連結以 Enter 開啟，下拉選單以瀏覽器原生的鍵盤操作選擇，文字與時間欄位以鍵盤輸入；任何操作都不需要拖曳、滑動或長按（WCAG 2.2 SC 2.5.1、2.5.7）。Itinerary_Poster 的互動元件（Motion_Toggle、Text_Panel 的按鈕、「開始規劃」與地圖連結）也遵守相同規則，Tab 順序依需求 16.1 的順序。
4. THE Itinerary_Editor SHALL 以按鈕控制每張可展開的卡片（需求 10.1 列出的卡片）與每個可展開的區塊（Places_And_Cars 與「未分配採買清單」），按鈕以 `aria-expanded="true"` 或 `aria-expanded="false"` 回報展開狀態，並在展開時以 `aria-controls` 指向展開內容的 `id`（WCAG 2.2 SC 4.1.2）；Itinerary_Poster 的 Text_Panel 也遵守相同規則。
5. THE Itinerary_Editor SHALL 讓每個表單欄位（文字、時間、下拉選單、核取方塊與單選按鈕）都有可見標籤（`placeholder` 不算標籤），且無障礙名稱包含該標籤的文字（WCAG 2.2 SC 2.5.3、3.3.2）；成組的核取方塊與單選按鈕以 `fieldset` 與 `legend`（或具名的 `role="group"`）標示組名，包括常用活動與參加的 Vehicle；只有圖示的按鈕，以及可見文字在多個項目中重複的按鈕與核取方塊（例如每筆 Legacy_Departure 的「轉成路線」、每個 Shopping_Stop 的「到採買清單調整負責人」、每筆 Activity 的「完成」），無障礙名稱包含動作（有可見文字時包含該文字）與對象名稱，例如「上移 超市／賣場」「轉成路線 第一車」「到採買清單調整負責人 超市／賣場」「搭帳・營地佈置已完成」。
6. WHEN 使用者展開一張可編輯的卡片（需求 10.1 列出的卡片，包含「＋新增路線」「自訂活動」與「轉成路線」建立的 Draft），THE Itinerary_Editor SHALL 把焦點移到該卡片的第一個表單欄位，例如 Route 的「哪一台車」、Activity 的標題、Meal_Moment 的時間。
7. WHEN 使用者收起一張可編輯的卡片、一張卡片儲存成功，或「加入 N 個活動」完成，THE Itinerary_Editor SHALL 把焦點移到對應項目收起列的展開按鈕：項目因儲存而改變排序時移到其新位置，新建立的項目移到新項目的收起列，一次加入多個 Activity_Preset 時移到其中在活動清單排最前面的一筆；放棄從未儲存過的 Draft 時，改移到建立該 Draft 的按鈕（例如「＋新增路線」或該筆 Legacy_Departure 的「轉成路線」）；儲存使 Activity 改到其他日子時，依需求 7.12 放置焦點。
8. WHEN 下列任一操作完成：卡片儲存成功、加入常用活動、儲存「完成」的勾選或取消勾選、刪除 Route、Activity 或 Place、清除 Legacy_Departure（需求 19.6），或 Text_Panel 的複製結束（需求 15.2、15.3），THE Trip_View SHALL 在 1 秒內把說明結果的文字寫入既有的提示訊息區域（`#toasts`，`role="status"`），文字包含動作與對象（例如車名、活動標題、地點名稱或「行程文字」），且不移動焦點（WCAG 2.2 SC 4.1.3）。
9. THE Itinerary_Editor SHALL 讓每個按鈕與表單欄位（文字、時間、下拉選單、核取方塊與單選按鈕）的點擊範圍寬與高都至少 44 CSS 像素（核取方塊與單選按鈕的點擊範圍可以包含點擊即可選取它的標籤），相鄰元件的點擊範圍互不重疊，且在 320 到 1440 CSS 像素寬的視窗中都成立（高於 WCAG 2.2 SC 2.5.8 的 24 × 24 CSS 像素）；Itinerary_Poster 的按鈕（Motion_Toggle、Text_Panel 的按鈕與「開始規劃」）也遵守相同規則；文字中的地圖連結不受 44 CSS 像素的限制，但須符合 WCAG 2.2 SC 2.5.8。
10. THE Itinerary_Poster SHALL 在淺色與深色主題（`<html data-theme>` 為 `light` 與 `dark`）及任何 Scene_Motion_State 下，讓每段文字與其正後方背景的對比至少 4.5:1（所有字級都適用，不使用 WCAG 2.2 SC 1.4.3 的大字 3:1 例外），並讓路線線條、Motion_Toggle 的邊框與圖示，以及其他辨識內容、控制項或其狀態所需的圖形與相鄰顏色的對比至少 3:1（WCAG 2.2 SC 1.4.11）；背景不是單一顏色（插畫、漸層或半透明底色）時以對比最低處計算，路線線條有墨線外框時以外框計算，不同 Car_Color 之間不要求 3:1；Itinerary_Editor 也遵守相同規則，包括 `placeholder` 文字與沿用既有樣式的控制項（例如未選取的選日按鈕），停用中的控制項本身除外，但說明停用原因的文字與「已加入」標示仍須符合。
11. THE Itinerary_Poster SHALL 讓所有文字計算後的 `font-size` 至少 12 CSS 像素，在 320 到 1440 CSS 像素寬的視窗與兩種主題中都成立；Itinerary_Editor 也遵守相同規則。
12. WHILE Itinerary_Editor 或 Itinerary_Poster 的一個元件取得鍵盤焦點，THE Schedule_Tab SHALL 顯示既有的焦點外框（主題的焦點色、至少 2 CSS 像素的實線，與外框相鄰的背景對比至少 3:1），並讓該元件位於可視範圍內，不被固定在畫面頂端的頁首、提示訊息區域或其他固定位置的元素完全遮住（WCAG 2.2 SC 1.4.11、2.4.7、2.4.11）。
13. IF 使用者啟動「儲存」或確認「＋新增地點」時有輸入未通過需求 2.2、4.9、5.9、5.10、6.13 或 7.10 的驗證，THEN THE Itinerary_Editor SHALL 為每個錯誤欄位設定 `aria-invalid="true"`，以 `aria-describedby` 連到欄位旁說明錯誤原因的可見文字，並把焦點移到第一個錯誤欄位；欄位在下一次驗證通過後移除 `aria-invalid` 與錯誤說明（WCAG 2.2 SC 3.3.1、3.3.3）。
14. WHEN Schedule_Tab 的一個操作完成並更新畫面，THE Schedule_Tab SHALL 依下列第一個適用的規則放置焦點，焦點不落在 `<body>`（需求 16.6、16.7 與 16.13 另有規定時依其規定）：(a) 在 Route 的 Draft 中新增 Stop 後，移到新 Stop 的地點下拉選單；確認「＋新增地點」後移到已選取新地點的下拉選單，取消時移到「＋新增地點」按鈕；(b) 刪除或移除 Route、Stop、Activity、Place 或「舊的出發資料」列後，移到同一清單中原本緊接在後的項目，沒有時移到緊接在前的項目，清單已沒有其他項目時移到該清單的新增按鈕（「＋新增路線」「新增途中任務」「自訂活動」或「新增地點」），卡片以收起列的展開按鈕、Stop 以地點下拉選單接收焦點；(c) 剛操作的元件因切換檢視或主分頁而消失時（例如「開始規劃」「到料理菜單編輯」「到採買清單調整負責人」），移到目前選取的 View_Switch 選項或主分頁按鈕；(d) 其他情況留在剛操作的元件（經由對話框確認或取消時，指開啟對話框的元件），例如選日按鈕、「路線」「活動」分段、View_Switch、Motion_Toggle、「完成」核取方塊、區塊的展開按鈕，以及帳號版儲存失敗（需求 10.5）後重新啟用的「儲存」按鈕；該元件已停用時，移到同一個項目中下一個可以操作的元件，沒有時移到上一個（例如 Stop 移到第一個之後，從「上移」移到「下移」）。

### Requirement 17: 版面與主題

**User Story:** 身為用手機或電腦看行程的旅伴，我希望行程圖在不同螢幕都排得整齊，以便在哪裡都看得清楚。

#### Acceptance Criteria

1. THE Itinerary_Poster SHALL 在 320 到 1440 CSS 像素寬的視窗中完整顯示全部文字、路線線條、車子圖示與 Stop 插圖：不產生頁面層級的水平捲動，Itinerary_Poster（含 Text_Panel）內也沒有要水平捲動才看得到的內容；文字不以省略號或裁切截斷，過長的文字（例如 50 字的地點名稱、100 字的活動標題）與 Text_Panel 的長行自動換行；任兩段文字的顯示範圍不重疊。View_Switch 與 Itinerary_Editor 也遵守相同規則，但選日按鈕列可依需求 4.3 在列內水平捲動，輸入框與下拉選單內的文字依瀏覽器原生方式顯示。
2. WHILE 視窗寬度小於等於 760 CSS 像素，THE Itinerary_Poster SHALL 讓每個 Route_Block 的路線圖由上往下排列：出發列表（需求 11.5）在最上方，每條 Route 的 Stop 插圖（需求 11.7）依經過順序由上往下排列，終點插畫（需求 11.6）在最下方；每個 Activity_Block 中 Activity 與 Meal_Moment 的小卡依需求 14.13 的順序由左到右、由上到下排列，每列最多兩張。
3. WHILE 視窗寬度大於 760 CSS 像素，THE Itinerary_Poster SHALL 讓每個 Route_Block 的路線圖由左往右排列：出發列表在最左側，每條 Route 的 Stop 插圖依經過順序由左往右排列，終點插畫在最右側；每個 Activity_Block 的小卡依需求 14.13 的順序由左到右排成可換行的橫列，除了最後一列，每列至少 3 張。
4. WHILE 一個 Route_Block 有 8 台車的 Route、每條 Route 有 6 個 Stop，且每個車名與地點名稱都是 50 字、旅行目的地是 100 字、每個 Stop 的備註或 Shopping_Summary 是 100 字，THE Itinerary_Poster SHALL 在 320 到 1440 CSS 像素寬的視窗中完整顯示該路線圖的全部文字（需求 11.5 至 11.8 的出發列表、每個 Stop 的地點、任務類型與內容、終點旁的文字，以及「先採買」說明），任兩段文字的顯示範圍不重疊，文字也不與路線線條、車子圖示、Stop 插圖或其他插畫重疊，字級與對比符合需求 16.10 與 16.11。
5. WHILE 深色主題啟用（使用者以既有的主題切換按鈕選擇深色），THE Itinerary_Poster SHALL 在畫面上讓概要列、每一天的段落、路線圖、小卡與 Text_Panel 的底色只使用深色主題色票中的顏色，不出現淺色主題的頁面底色或卡片底色；文字與連結使用與 Trip_View 其他分頁相同的深色主題顏色；路線線條、車子圖示、Stop 插圖、終點插畫與小卡插圖中用來辨識圖形的線條或色塊，與相鄰背景的對比至少 3:1。Itinerary_Editor 也遵守相同的底色與文字顏色規則。
6. THE Schedule_Tab SHALL 讓本功能新增的按鈕、圖示按鈕、分段選項（含 View_Switch 與「路線」「活動」選項）、展開區塊、欄位（輸入框、下拉選單與核取方塊）與選日按鈕，各自使用 Trip_View 既有同類控制項的樣式或其既有變化（例如主要、小型與危險按鈕；分段選項比照採買清單的篩選，展開區塊比照料理表單的「常用食材」，選日按鈕比照現有行程表的日期按鈕），外框、圓角、字級、最小高度、選取狀態與焦點外框都與既有控制項相同，不另外定義新的控制項外觀。
7. THE Schedule_Tab SHALL 只使用 `src/app.js` 圖示集中的介面圖示（插畫與插圖除外）；新增的圖示加入同一個圖示集並沿用既有圖示的線條畫法，每個用到的圖示都在圖示集中有自己的定義，不出現找不到圖示時代替顯示的帳篷圖示；同一個圖示只代表一種動作或資訊，使用同一個圖示的圖示按鈕，其無障礙名稱（需求 16.5）都以相同的動作開頭。
8. WHEN 視窗寬度改變（例如旋轉手機或調整視窗大小），THE Schedule_Tab SHALL 不重新載入頁面，在寬度跨越 760 CSS 像素時讓 Itinerary_Poster 改用需求 17.2 或 17.3 的排列，並保留目前的檢視、Itinerary_Editor 正在編輯的日子、展開的卡片與區塊、Draft 與鍵盤焦點。
9. WHILE 深色主題啟用，WHEN 使用者在 Schedule_Tab 列印，THE Trip_View SHALL 以淺色主題的背景、文字與插畫顏色列印需求 13.7 的封面與 Itinerary_Poster，列印結果的顏色與在淺色主題中列印時相同。

### Requirement 18: 資料格式與驗證

**User Story:** 身為網站管理員，我希望新的行程資料有明確的格式與上限，並在前後端用同一套規則檢查，以便資料不會損壞或被靜默丟棄。

#### Acceptance Criteria

1. THE Trip_State SHALL 以選填欄位保存 Place_List、Route（含 Stop）、Day_Settings 與 Meal 的時間；缺少這些欄位或其清單為空時，視為沒有 Place 與 Route、每個 Trip_Day 都沒有 Day_Settings（Day_Title、Day_Location 與 Arrival_Time 都未設定）；沒有時間的 Meal 依需求 8.2 使用餐次的預設 Meal_Time。Trip_State 不保存採買品項與 Stop 的對應，Stop_Items 與 Unassigned_Shopping 依需求 6.11 推導，因此沒有 Route 時每個採買品項都屬於 Unassigned_Shopping。Server 處理 `PUT /api/trips/:id` 時，缺少欄位的情況依第 11 條處理。
2. THE State_Validator SHALL 只接受活動類型欄位為 13 個 Activity_Category 對應值之一的 Activity：集合、採買、營地時光、用餐、夜晚與移動沿用 Legacy_Activity_Type 的 `meet`、`market`、`camp`、`meal`、`night`、`travel`，前言「活動類別」表標示「新增」的 7 個類別各有一個固定的新值；類型為其他值（包含空字串）時，判定該 Trip_State 無效。
3. THE State_Validator SHALL 以下列定義判斷第 4 至 8 條的條件：(a) 有效的 HH:MM 是 24 小時制、時與分各兩位數的 00:00 到 23:59，與既有活動時間的檢查相同（`8:00`、`24:00` 與 `08:00:00` 都無效）；(b) 未填時間是省略或空字串；(c) 日期必須與某一個 Trip_Day 的 YYYY-MM-DD 文字完全相同，與既有活動與餐點的日期檢查相同；(d) Place 名稱、Day_Title 與 Stop 備註的字數為 Char_Count；(e) 識別碼與既有集合的 `id` 檢查相同，是非空字串，長度上限 5,000。
4. IF Place_List 存在但不是清單、有超過 100 個 Place，或有 Place 的識別碼不符合第 3 條、與另一個 Place 相同或與代表 Destination_Place 的引用值相同、名稱不是字串、名稱去除前後空白後不是 1 到 50 個字、名稱含有控制字元（Unicode 類別 Cc 或 Cf；emoji 組合中連接兩個 emoji 的零寬連接符除外，與既有旅伴名字的檢查相同），或名稱依需求 2.1(d) 的比較方式與另一個 Place 的名稱或旅行目的地相同，THEN THE State_Validator SHALL 判定該 Trip_State 無效。
5. IF 保存 Route 的欄位存在但不是清單，或有 Route 的識別碼不符合第 3 條或與另一條 Route 相同、日期不是 Trip_Day、Vehicle 不是 `state.vehicles` 中的一台車、日期與 Vehicle 都與另一條 Route 相同、起點或終點既不是 Place_List 中的 Place 也不是 Destination_Place、旅行目的地空白時起點或終點使用 Destination_Place、出發時間既不是未填時間也不是有效的 HH:MM，或 Stop（沒有 Stop 時可以省略）不是清單或超過 6 個，THEN THE State_Validator SHALL 判定該 Trip_State 無效。
6. IF Trip_State 有 Stop 的識別碼不符合第 3 條或與任何 Route 中的另一個 Stop 相同、地點既不是 Place_List 中的 Place 也不是 Destination_Place、旅行目的地空白時地點使用 Destination_Place、任務類型不是採買、接送、取還裝備或其他，或備註（可以省略）不是字串或超過 100 個字，THEN THE State_Validator SHALL 判定該 Trip_State 無效。
7. IF 保存 Day_Settings 的欄位存在但不是清單，或有 Day_Settings 的日期不是 Trip_Day 或與另一筆 Day_Settings 相同、Day_Title（可以省略）不是字串或超過 20 個字、Day_Location 既不是未設定（省略或空字串）也不是 Place_List 中的 Place（使用 Destination_Place 也無效，見需求 4.13），或 Arrival_Time 既不是未填時間也不是有效的 HH:MM，THEN THE State_Validator SHALL 判定該 Trip_State 無效。
8. IF Trip_State 有 Meal 的時間存在但不是有效的 HH:MM（空字串也無效），THEN THE State_Validator SHALL 判定該 Trip_State 無效。
9. THE Server SHALL 在 `PUT /api/trips/:id` 與匯入舊手冊的 `POST /api/trips` 保留本需求新增的欄位：請求成功後，`GET /api/trips/:id` 回傳的這些欄位與送出的值相同，只有兩種例外：依第 11 條補回的欄位，以及匯入時依需求 20.3 平移的日期。Place、Route、Stop 與 Day_Settings 中本需求沒有定義的欄位，與既有集合的未知欄位一樣被丟棄。其他會改寫旅行內容的 API（例如勾選採買與裝備、加入旅行、`PATCH /api/trips/:id`）不改動這些欄位，需求 20.3 的日期平移除外。
10. IF Server 收到的 Trip_State（PUT 時為依第 11 條補回欄位後的結果），或任何 API 在料理食材同步、日期平移等處理後即將寫入的 Trip_State 未通過 State_Validator，THEN THE Server SHALL 回應 400 並沿用既有的格式錯誤訊息（需求 2.10 的兩種情況改回應該條的訊息），且伺服器上該旅行的 Trip_State 與 revision 維持不變。
11. IF `PUT /api/trips/:id` 的 Trip_State 沒有保存 Place_List、Route 或 Day_Settings 的欄位（欄位不存在；空清單或 `null` 不算缺少），THEN THE Server SHALL 為每個缺少的欄位補回伺服器上該欄位目前的值（伺服器上也沒有時維持缺少），再以補回後的 Trip_State 進行 State_Validator 驗證、需求 21.3 的受邀旅伴刪除檢查與寫入；尚未更新的頁面因此不會清除這些資料；受邀旅伴可以移除地點與路線（需求 21.7），補回欄位也避免受邀旅伴的舊頁面把它們清空。
12. THE State_Validator SHALL 讓每一個依本功能之前的 State_Validator 有效的 Trip_State（例如 `seed()`、`emptyState()`、本功能之前匯出的 JSON 備份與伺服器上既有的旅行）不經修改即通過驗證。除第 2 條增加的活動類型外，既有欄位的規則不變：Vehicle 的 `meeting` 仍必須是字串，清除 Legacy_Departure（需求 19.5、19.6）時改為空字串，不移除欄位。Local_Planner 與 Account_Mode 都不需要資料庫遷移或資料轉換。
13. THE Local_Planner SHALL 把本需求新增的欄位一併存入 localStorage 與匯出的 JSON 備份；重新載入頁面或匯入該備份後，這些欄位的值與存入或匯出時相同。
14. IF 匯入 Local_Planner 的 JSON 備份未通過 State_Validator，THEN THE Trip_View SHALL 拒絕匯入，在匯入對話框顯示既有的無效備份錯誤訊息，目前的 Trip_State 與 localStorage 內容維持不變。
15. IF Itinerary_Editor 的任何一次寫入（儲存卡片、加入常用活動、勾選完成、刪除項目或清除舊出發資料）產生的 Trip_State 未通過 State_Validator，THEN THE Itinerary_Editor SHALL 不寫入 localStorage 也不送出到 Server，維持寫入前的 Trip_State，保留 Draft 與畫面，並顯示資料驗證未通過的錯誤訊息。

### Requirement 19: 舊資料相容

**User Story:** 身為已經規劃過旅行的旅伴，我希望改版後原本的活動與車輛出發資料都還在，以便不用重新輸入。

#### Acceptance Criteria

1. WHEN 使用者開啟或重新載入本功能之前建立的旅行（Trip_State 沒有 Place_List、Route、Day_Settings 與 Meal 的時間），THE Trip_View SHALL 只在使用者完成儲存操作（例如儲存卡片、勾選完成、加入常用活動、確認刪除、確認「不使用舊資料」，或其他分頁既有的編輯）時寫入 Trip_State，且只改變該操作涉及的項目（以及既有的修訂號與動態紀錄），其他 Activity 的類型與其他 Vehicle 的 `meeting` 維持原值；切換 View_Switch、以選日按鈕換日、切換分段、展開或收起卡片與區塊、建立或放棄 Draft、展開 Text_Panel、複製文字、切換 Motion_Toggle 與列印，都不寫入 localStorage 中的旅行手冊，也不向 Server 送出寫入 Trip_State 的請求；既有的啟動流程（料理食材自動連動採買清單、搬移舊版本機儲存）維持現狀，且不加入本功能新增的欄位。
2. THE Itinerary_Poster SHALL 在每筆既有 Activity 的日期顯示該 Activity 恰好一次（不與 Meal_Moment 合併），Itinerary_Editor 與 Itinerary_Text 也是，並依下列規則呈現原本的內容：(a) 類別：Legacy_Activity_Type 依前言「活動類別」表顯示，meet 為「集合」、market 為「採買」、camp 為「營地時光」、meal 為「用餐」、night 為「夜晚」、travel 為「移動」；(b) 參加者：有指定車輛時為依指定順序以「、」連接的車名；旅伴名單為空，或包含每一位目前的旅伴時，為「全體旅伴」；其他情況為依名單順序以「、」連接的旅伴名。Itinerary_Poster 與 Itinerary_Text 依需求 11.10 與 14.14，在參加者不是全體旅伴時顯示；Itinerary_Editor 展開時預先選取原本的參加方式（需求 7.6、7.7）；(c) 地點與備註：Itinerary_Poster 與 Itinerary_Text 依需求 11.10 與 14.14 的條件顯示地點，並在備註有內容時顯示備註；Itinerary_Editor 在展開的 Activity 中顯示原本的地點與備註；(d) 完成狀態：Itinerary_Poster 依需求 11.11 標示，Itinerary_Editor 以「完成」核取方塊的勾選狀態呈現（需求 7.8），Itinerary_Text 不輸出完成狀態。
3. WHILE 一個 Vehicle 有 Legacy_Departure 且在 First_Day 沒有 Route，THE Itinerary_Poster SHALL 在 First_Day 的路線圖中為該車顯示出發標記，內容為車名、舊出發時間，以及以 `mapLink()` 呈現的舊出發地點（缺少的部分依本需求第 10 條）；出發標記所在的 Route_Block 與排列順序，和 Itinerary_Text 依需求 14.15 輸出該車那一行的位置相同；出發標記不推測終點、不畫路線線條，也不播放移動動畫。Legacy_Departure 一律屬於目前的 First_Day（旅行日期變更後也一樣），其他 Trip_Day 不顯示。
4. WHILE 一個 Vehicle 有 Legacy_Departure 且在 First_Day 沒有 Route，THE Itinerary_Editor SHALL 在 First_Day「路線」分段的 Route 收起列之後，為該車顯示一列「舊的出發資料」，內容為車名、舊出發時間與舊出發地點（缺少的部分依本需求第 10 條），並提供「轉成路線」與「不使用舊資料」按鈕，按鈕的無障礙名稱包含車名（例如「轉成路線 山線小巴」）。有多列時，依舊出發時間由早到晚排列；時間相同時依 `state.vehicles` 的順序；沒有舊出發時間的排在最後，並依 `state.vehicles` 的順序。每位 Editor_User（含 Collaborator，見需求 21.2、21.4）都看得到這兩個按鈕。
5. WHEN 使用者儲存一條 First_Day 的 Route（包含新增、修改，以及由「轉成路線」建立的 Route），THE Trip_State SHALL 在同一次儲存中清除該 Route 所屬 Vehicle 的 `meeting`（設為空字串），該 Vehicle 的其他欄位與其他 Vehicle 的 `meeting` 不變；儲存其他 Trip_Day 的 Route 不改變任何 `meeting`，該次儲存未通過驗證時 `meeting` 也不變（需求 10.4）。
6. WHEN 使用者啟動某台車的「不使用舊資料」，THE Itinerary_Editor SHALL 開啟每位 Editor_User（含 Collaborator）都能使用的確認視窗，標題為「不使用舊的出發資料？」，按鈕為「取消」與「確認」；只在使用者啟動「確認」後清除該車的 `meeting`（設為空字串）並儲存，該車的其他欄位、其他 Vehicle 與 Activity 都不變；使用者啟動「取消」或關閉視窗時不變更任何資料。清除後，Itinerary_Poster、Itinerary_Text 與 Trip_Menu 在下一次畫面更新時不再顯示該車的舊出發資料。
7. THE Itinerary_Poster SHALL 以與現有 `parseVehicleMeeting()` 相同的規則，從 `meeting` 去除前後空白後的文字取得舊出發時間與舊出發地點，Itinerary_Editor（含本需求第 11 條的 Draft）與 Itinerary_Text 使用相同的結果：
   - (a) 文字以 24 小時制的 HH:MM 開頭（小時與分鐘都是兩位數，00:00 至 23:59）。HH:MM 之後直接結束，或接著「·」（U+00B7）、「・」（U+30FB）、「|」（U+007C）、「｜」（U+FF5C）其中一個符號（符號前後可以有空白）時，該 HH:MM 為舊出發時間，符號之後去除前後空白的文字為舊出發地點（可以是空的）。例如「14:00 · 台北車站東三門」為 14:00 與「台北車站東三門」，「08:05 ｜ 台中高鐵站」為 08:05 與「台中高鐵站」，「00:00」只有舊出發時間。
   - (b) 其他文字沒有舊出發時間，整段文字（包含其中的換行）為舊出發地點，例如「早上八點在家門口」「9:00 台北車站」「14:00 台北車站」「24:00 · 車站」「台北車站 · 東三門」。
   - (c) 文字為空時，該 Vehicle 沒有 Legacy_Departure。
8. WHEN 使用者在 Local_Planner 以「匯入備份」匯入本功能之前匯出的 JSON 備份（沒有本功能新增的欄位），THE Trip_View SHALL 依既有的匯入流程以 State_Validator 驗證並接受該備份、取代目前的手冊；匯入時不新增 Place_List、Route、Day_Settings 或 Meal 的時間，每筆 Activity 的類型與每台 Vehicle 的 `meeting` 維持備份中的原值，並依本需求第 2、3、4、7 與 10 條顯示其中的活動與舊出發資料。
9. WHILE First_Day 的一張 Route 卡片處於展開狀態，且卡片的「哪一台車」選取的 Vehicle 有 Legacy_Departure，THE Itinerary_Editor SHALL 在該卡片中顯示「這台車的舊出發資料會改由這條路線記錄」；改選沒有 Legacy_Departure 的 Vehicle 後不再顯示。
10. IF Legacy_Departure 沒有舊出發時間或沒有舊出發地點，THEN THE Itinerary_Poster SHALL 以「出發時間待定」表示缺少的時間、以「出發地點待定」表示缺少的地點，其餘文字不改寫、不截斷；Itinerary_Text 使用相同的文字，並依需求 14.15 的格式與需求 14.16 的換行規則輸出（例如「山線小巴｜出發時間待定：早上八點在家門口」「海風號｜00:00 出發：出發地點待定」）；Itinerary_Editor 的「舊的出發資料」列以「時間待定」（與需求 5.1 相同）與「出發地點待定」表示。
11. WHEN 使用者啟動某台車的「轉成路線」，THE Itinerary_Editor SHALL 建立並展開該車在 First_Day 的 Route Draft，不寫入 Trip_State：
    - 「哪一台車」為該車。
    - 「幾點出發」為舊出發時間，沒有時留空。
    - 「最後到哪裡」為 Day_Location，沒有 Day_Location 時不選取。
    - 沒有途中任務。
    - 「從哪裡出發」選取名稱與舊出發地點相同（依需求 2.1(d) 的比較規則）的 Destination_Place 或 Place；沒有相同名稱時，依需求 2.5 的方式把以舊出發地點為名稱的新 Place 加入 Draft 並選取。
    - 舊出發地點為空、不符合需求 2.1 的名稱規則，或 Place_List 已有 100 個 Place 時，「從哪裡出發」不選取，卡片顯示舊出發地點原文，並說明需要選擇或新增起點。

### Requirement 20: 旅行日期變更

**User Story:** 身為主辦人，我希望改旅行日期時，每一天的路線與設定跟著原本的第幾天移動，以便不用重排，也不會悄悄遺失。

#### Acceptance Criteria

1. WHEN 使用者在 Trip_Settings_Dialog 變更旅行日期並儲存，且這次儲存未被拒絕，THE Trip_View SHALL 在同一次儲存中（Account_Mode 為同一個 `PUT /api/trips/:id` 請求）寫入新的旅行日期，並把原本第 N 天的每條 Route 與每筆 Day_Settings 的日期改為新的開始日期加 N − 1 天，Route 的識別碼、Vehicle、起點、出發時間、Stop 與終點，以及 Day_Settings 的 Day_Title、Day_Location 與 Arrival_Time 都維持不變；被移除的日子（定義見第 2 條）不再保留 Day_Settings。
2. IF 使用者在 Trip_Settings_Dialog 儲存的新天數少於原本的天數，且被移除的日子（原本第 N 天中 N 大於新天數的日子）有任何 Route、Day_Title 或已設定的 Day_Location（Place），THEN THE Trip_View SHALL 拒絕這次儲存（對話框中的其他欄位也不儲存）並保持 Trip_Settings_Dialog 開啟，在對話框顯示錯誤訊息，依天數順序列出每一個這樣的日子（第 N 天與原本的日期），標明當天有路線、每日設定或兩者，並說明要先刪除這些路線、清除這些每日設定才能縮短天數；對話框保留全部輸入，Trip_State 的任何資料都不變更，包含旅行資料，以及 Activity、Meal、Route 與 Day_Settings 的日期。
3. WHEN Server 因 `PATCH /api/trips/:id` 變更旅行日期或因 `POST /api/trips` 匯入舊手冊，依既有規則把每筆 Activity 與 Meal 的日期平移「新的開始日期減原本的開始日期」的天數（匯入時，原本的開始日期是舊手冊的開始日期），THE Server SHALL 以相同天數平移每條 Route 與每筆 Day_Settings 的日期，其他欄位維持不變；平移後不在新日期範圍內、且沒有 Day_Title 也沒有設定 Day_Location 的 Day_Settings 不再保留。
4. IF Server 平移後有任何 Activity、Meal、Route，或有 Day_Title 或已設定 Day_Location 的 Day_Settings 不在新的日期範圍內，THEN THE Server SHALL 回應 400，以錯誤訊息指出新日期範圍放不下的每一類既有內容（活動、餐點、路線或每日設定），且不寫入任何資料：`PATCH /api/trips/:id` 之後旅行維持原本的日期、內容與版本號，`POST /api/trips` 不建立旅行。
5. WHEN 任一次旅行日期變更完成（Trip_Settings_Dialog 的儲存未被拒絕，或 Server 完成 `PATCH /api/trips/:id` 或 `POST /api/trips` 匯入），THE Trip_State SHALL 讓變更前後的 Route 識別碼集合相同、每條 Route 在變更前後位於相同的第 N 天，並讓 1 到新天數的每個 N 在變更前後有相同的 Day_Title 與 Arrival_Time，Day_Location 也相同（同一個 Place，或都未設定；變更前不存在的日子視為未設定狀態）。
6. WHEN 使用者在 Trip_Settings_Dialog 變更旅行日期並儲存，且這次儲存未被拒絕，THE Trip_View SHALL 依既有規則讓每筆 Activity 與 Meal 維持原本的第 N 天，N 大於新天數的 Activity 與 Meal 改到新的 Last_Day，時間與其他欄位維持不變。
7. WHEN 任一次旅行日期變更完成（同第 5 條），THE Trip_State SHALL 保留每台 Vehicle 的 `meeting` 不變，讓每台 Vehicle 的 First_Shopping_Stop 仍是同一個 Stop、每個 Shopping_Stop 的 Stop_Items 不變、Shopping_Tab 顯示的採買日子（需求 6.10）維持原本的第 N 天，並讓 Legacy_Departure 依需求 3.8、14.15 與 19.3 顯示在新的 First_Day。

### Requirement 21: 權限

**User Story:** 身為主辦人，我希望受邀旅伴也能一起規劃行程，包括刪除行程表中的路線、途中任務、活動與地點，其他內容則沿用旅行既有的刪除權限，以便大家一起排行程，又不會誤刪旅伴、料理、採買品項、裝備與車輛。

#### Acceptance Criteria

1. WHERE 使用者是 Viewer（後備規則，見需求 1.5；App 目前不會建立 Viewer，受邀旅伴是 Collaborator），THE Schedule_Tab SHALL 只提供下列互動元件：Text_Panel 的展開按鈕與「複製文字」按鈕、Motion_Toggle（Reduced_Motion 成立時依需求 13.2 隱藏），以及 `mapLink()` 產生的地圖連結；不顯示 View_Switch、Itinerary_Editor 與「開始規劃」按鈕，也不顯示任何新增、修改、刪除或勾選完成的控制項。
2. WHERE 使用者是 Collaborator（受邀旅伴），THE Itinerary_Editor SHALL 提供下列操作（Collaborator 與 Trip_Manager 一樣，依需求 1.1 看得到 View_Switch 與「規劃行程」）：新增、修改與刪除 Place、Route、Stop（不論是否已儲存）與 Activity，新增與修改 Vehicle，修改 Day_Settings，修改 Meal_Moment 的時間，調整 Stop 順序，勾選 Activity 完成，以及「轉成路線」與「不使用舊資料」；刪除的控制項包含 Places_And_Cars 的「刪除」、「刪除這條路線」、Stop 的移除按鈕與「刪除這個活動」，刪除前依需求 10.7 確認（Stop 依需求 10.8 隨 Route 儲存），仍被使用的 Place 依需求 2.7 不能刪除；Collaborator 不能刪除 Vehicle，從 Places_And_Cars 開啟的 Vehicle_Dialog 不顯示「移除項目」，Trip_Menu 也依既有規則不顯示刪除車輛的按鈕（需求 3.11）。
3. IF Collaborator 以伺服器目前的版本號儲存行程（`PUT /api/trips/:id`），送出的 Trip_State 通過 State_Validator，也通過 Server 對已綁定帳號的旅伴與旅行欄位的既有檢查（例如移除已綁定帳號的旅伴時，Server 依既有規則先回應 409，不回應這個 403），且有下列任一情況：(a) 伺服器上既有的任一旅伴、料理、裝備或車輛的識別碼不在送出的對應集合中（`guardCollaborator()` 對 people、meals、gear、vehicles 的既有檢查，以識別碼判定；Collaborator 自己建立並已儲存的項目也算既有項目）；(b) 移除了既有的採買品項（`guardShoppingRemoval()` 現有的規則，料理食材同步會自動移除的品項除外）；(c) 把既有、不是由料理食材產生的採買品項（`source` 不是 `meal`）改標為料理食材產生的品項（`guardCollaborator()` 的既有檢查），THEN THE Server SHALL 回應 403 與錯誤訊息「受邀旅伴可以編輯，但不能刪除既有項目；請聯絡主辦人或管理員。」，伺服器上的 Trip_State 與版本號維持不變，同一請求中的其他修改也不寫入；請求中只有第 4 條的變更與第 7 條的移除時，不回應這個 403。
4. WHEN Collaborator 以伺服器目前的版本號儲存行程，送出的 Trip_State 通過 State_Validator，且相對伺服器上的 Trip_State 只有下列變更（Server 依既有規則改寫的版本號、`currentUser` 與動態紀錄不算變更）：新增或修改 Place、Route、Stop、Activity 與 Vehicle（包含 Place 改名、Route 改派車輛、Stop 調整順序或改變任務類型、勾選 Activity 完成、改變 Vehicle 的駕駛與乘客）、修改 Day_Settings（包含清除 Day_Title、Day_Location 與 Arrival_Time，使該天依需求 4.10 回到未設定狀態）、改變採買品項的「誰負責買」、修改 Meal 的時間，或清除 Vehicle 的 `meeting`，THE Server SHALL 儲存這些變更並回應成功。
5. IF 讀取或寫入 Trip_State 的請求（讀取旅行、儲存行程、勾選採買、裝備或出發、變更旅行卡片與匯入舊手冊）沒有有效登入或未通過 security-hardening 需求 10.1 至 10.3 的 `Origin`、`Sec-Fetch-Site` 與 `Content-Type` 檢查，或是由不是旅行建立者、受邀旅伴或管理員的帳號對該旅行送出，THEN THE Server SHALL 依 security-hardening 需求 1.8、6.1、6.4 與 10.1 至 10.3 的既有規則拒絕請求（非成員的請求回應與不存在的旅行相同的 404），回應中不含任何 Trip_State 內容（包含本功能新增的欄位），且不寫入任何資料。
6. WHERE 使用者是 Local_Planner 的使用者或 Trip_Manager（包含沒有加入這趟旅行的管理員），THE Itinerary_Editor SHALL 提供第 2 條列出的全部操作，另外顯示刪除 Vehicle 的控制項（從 Places_And_Cars 開啟的 Vehicle_Dialog 中的「移除項目」）；刪除仍受需求 2.7、3.9 與 3.10 的限制。
7. WHEN Collaborator 或 Trip_Manager 以伺服器目前的版本號儲存行程，送出的 Trip_State 通過 State_Validator，移除了伺服器上既有的 Activity、Place、Route 或 Stop（以識別碼判定，Stop 以送出的所有 Route 中的 Stop 判定；依需求 18.11 補回的欄位不算移除），且其餘的變更只有第 4 條列出的變更，THE Server SHALL 儲存該 Trip_State 並回應成功，之後 `GET /api/trips/:id` 回傳的 Trip_State 不含被移除的項目（Collaborator 的同一請求也有第 3 條的情況時，依第 3 條拒絕）。這是對 `guardCollaborator()` 的刻意變更：以識別碼比對移除的集合從 people、activities、meals、gear、vehicles 改為 people、meals、gear、vehicles，本功能新增的 Place_List、Route（含其中的 Stop）與 Day_Settings 也不加入比對，`guardCollaborator()` 的其他檢查與 `guardShoppingRemoval()` 不變；本功能之前，受邀旅伴移除既有的活動會回應 403。
8. WHEN Collaborator 在 Itinerary_Editor 完成任一次寫入（需求 18.15 列出的寫入，包含儲存或刪除 Place、Route、Stop 與 Activity，以及改名、改派車輛、調整 Stop 順序與改變任務類型），THE Itinerary_Editor SHALL 讓送出的 Trip_State 相對寫入前只有該次寫入涉及的變更與需求 10.4 的連帶變更：寫入前 Trip_State 中的每一個旅伴、料理、採買品項、裝備與車輛都以相同的識別碼留在對應的集合中，修改既有項目時保留其識別碼（需求 5.11），使 Server 依第 4 條與第 7 條回應成功，不回應第 3 條的 403。
9. IF Server 以 403 拒絕 Itinerary_Editor 的任一次寫入（需求 18.15 列出的寫入），THEN THE Itinerary_Editor SHALL 依需求 10.5 保留 Draft 與畫面（刪除項目時依需求 10.7 維持刪除後的畫面），並在需求 10.5 的儲存警示中顯示 Server 回傳的錯誤訊息，例如第 3 條的訊息。
10. WHERE 使用者是 Collaborator，THE Trip_View SHALL 在既有的同步狀態中以「協作編輯模式，不能刪除旅伴、料理、採買品項、裝備與車輛」作為權限說明，取代原本的「協作編輯模式，不能刪除」；Trip_Manager 的「建立者／管理員模式」與 Viewer 的「僅可檢視模式」維持不變。

### Requirement 22: 安全

**User Story:** 身為旅伴，我希望其他人輸入的地點、車名或活動名稱只會顯示成文字，以便沒有人能在我的瀏覽器執行程式。

#### Acceptance Criteria

1. THE Itinerary_Poster SHALL 把從 Trip_State、Draft 或頁面元素（欄位的值與 `data-` 屬性）讀出的每個值，只寫入 HTML 字串（包含其中的內嵌 SVG）中元素內容的文字（`<style>`、`<script>` 元素內除外）或以引號包住的屬性值，並在寫入前經 Escape_Function 處理恰好一次。這些值包含：使用者文字，指旅行名稱、旅行介紹、旅行目的地、Place 名稱、車名、旅伴名、Day_Title、Activity 的標題、地點與備註、料理名稱、舊資料的自訂餐次、食材、採買品項名稱、Stop 的備註，以及 Legacy_Departure 的文字；識別碼，指 Place、Route、Stop、Vehicle、Activity、Meal、採買品項與旅伴的識別碼；以及日期與時間。SVG 的 `<text>`、`<tspan>`、`<title>`、`<desc>` 與 `<foreignObject>` 的內容也適用。以不解析 HTML 的方式寫入的文字（例如既有的提示訊息區域）使用原始值，不經 Escape_Function。Itinerary_Editor、Text_Panel、Trip_Menu 的車輛卡片（需求 3.8）、Shopping_Tab 的採買位置（需求 6.10），以及本功能新增的提示訊息與確認視窗也遵守相同規則。
2. IF 一個通過 State_Validator 的 Trip_State 中，任一使用者文字或識別碼是 XSS_Payload_Set 中的字串，或是 `]]><img src=x onerror=alert(1)>`、`red;background:url(https://example.com/x.png)` 之一（字串超過該欄位的長度上限時，改用從開頭起符合上限的部分），THEN THE Trip_View SHALL 在顯示 Itinerary_Poster（含需求 13.7 的列印封面）、Itinerary_Editor（含展開的卡片、下拉選單與 Planning_Warning）、展開的 Text_Panel、Trip_Menu 的車輛卡片、Shopping_Tab，以及本功能新增的提示訊息時同時做到：不開啟 `alert` 對話框；頁面沒有未捕捉的例外，瀏覽器也不回報 Content-Security-Policy 違規；頁面中沒有 `iframe`、`frame`、`object`、`embed` 元素，沒有不帶 `src` 屬性的 `script` 元素，沒有 `src` 不以 `blob:` 開頭的 `img` 元素，沒有名稱以 `on` 開頭的屬性，也沒有值以 `javascript:` 開頭的 `href`、`xlink:href`、`src`、`action` 或 `formaction` 屬性；每個顯示使用者文字的位置都呈現與儲存值逐字相同的文字（例如不顯示成 `<script&gt;`）。
3. THE Itinerary_Poster SHALL 只以 `mapLink()` 產生網址含有 Trip_State 值的連結，並只把這些連結放在 HTML 內容中，不放進 `<svg>` 元素；每個這類連結的 `href`、`target` 與 `rel` 都與 `mapLink()` 對同一地點文字產生的連結相同，包含地點名稱為 `javascript:alert(1)` 或 `https://example.com/` 的情況，地點文字只以網址編碼的形式出現在 Google Maps 網址的查詢參數中。Itinerary_Editor、Trip_Menu 的車輛卡片與 Shopping_Tab 也遵守相同規則；Text_Panel 不產生任何連結。
4. WHILE Schedule_Tab 顯示 Itinerary_Poster 或 Itinerary_Editor，包含播放與暫停動畫、切換 View_Switch、展開 Text_Panel、複製文字與套用列印樣式的期間，THE Trip_View SHALL 在本功能實作前的 Content-Security-Policy 回應標頭值下運作（本功能不新增或放寬任何指令），瀏覽器不回報任何 Content-Security-Policy 違規，頁面也不向與頁面不同來源（scheme、主機或連接埠任一不同）的網址發出請求；使用者啟動地圖連結、在新分頁開啟 Google Maps 除外。
5. THE Itinerary_Poster SHALL 在本需求第 1 條允許的位置中，只把使用者文字與識別碼寫入元素內容的文字，以及 `aria-label`、`title`、`placeholder`、`value` 與名稱以 `data-` 開頭的屬性的值，唯一的例外是 `mapLink()` 產生的 `href`。因此使用者文字與識別碼不會出現在元素或屬性的名稱、註解、`id`、`name`、`for`、`class`、`style`、`aria-controls`、`aria-labelledby`、`aria-describedby`、`href`、`xlink:href`、`src`、名稱以 `on` 開頭的屬性，以及 SVG 的 `transform`、`d`、`points`、`x`、`y`、`fill`、`stroke`、`clip-path`、`mask`、`filter` 與名稱以 `marker-` 開頭的屬性中。Itinerary_Editor、Text_Panel、Trip_Menu 的車輛卡片（需求 3.8）與 Shopping_Tab 的採買位置（需求 6.10）也遵守相同規則。
6. THE Itinerary_Poster SHALL 只依 Vehicle 在 `state.vehicles` 中的位置，從原始碼中的固定色票選出 Car_Color（需求 11.12），寫入路線線條、車子圖示與車名標示的 `stroke`、`fill`、`style` 或 CSS 自訂屬性的顏色值都是該色票中的值，且 Car_Color 不受 Vehicle 的名稱、駕駛、識別碼或任何使用者文字影響；Itinerary_Editor 顯示 Car_Color 時也遵守相同規則。
7. WHEN 使用者啟動 Text_Panel 的「複製文字」按鈕，THE Trip_View SHALL 只以純文字格式（`text/plain`）把與 Itinerary_Text 逐字相同的內容寫入剪貼簿，不寫入 HTML 格式（`text/html`）或其他格式，也不把使用者文字換成字元參照；例如地點名稱 `A&B` 與 `<script>alert(1)</script>` 在剪貼簿中仍是 `A&B` 與 `<script>alert(1)</script>`。

### Requirement 23: 測試

**User Story:** 身為開發者，我希望新行程表有完整的自動化測試，以便改版不會破壞既有功能。

#### Acceptance Criteria

1. THE Test_Suite SHALL 以 `bun test` 驗證由 Example_Trip 產生的 Itinerary_Text 與 Example_Text 逐字相同（比較整個字串，包含每個換行與空行，不修剪空白），且在 `Etc/UTC`、`Asia/Taipei` 與 `America/Los_Angeles` 三個時區下都成立。
2. THE Test_Suite SHALL 驗證 Example_Trip 的每一天都沒有 Planning_Warning，並分別驗證下列兩種修改的結果，兩種情況下其他天都仍沒有 Planning_Warning：
   - 刪除第 1 天第四車的 Route 後，Itinerary_Text 與 Example_Text 只差兩處（少了「第四車｜09:30 出發：出發地點 D → 夕淞度日營區」一行，到達行變為「預計 12:00 抵達・三車會合」），第 1 天的 Planning_Warning 只有「第四車這一天還沒有路線」一則。
   - 把八個採買品項的「誰負責買」都改成第一車的駕駛小安後，Itinerary_Text 與 Example_Text 只差一處（第三車・採買組的路線行變為「第三車・採買組｜09:00 出發：出發地點 C → 超市／賣場（採買） → 夕淞度日營區」），第 1 天的 Planning_Warning 只有「第三車・採買組在超市／賣場的採買沒有品項」一則，且 Unassigned_Shopping 包含這八個品項，原因都是「第一車還沒有採買停靠點」（需求 6.8、6.11、9.5）。
3. THE Test_Suite SHALL 以 `bun test` 與 fast-check 產生至少 100 組 Trip_State（`numRuns` 不少於 100）。產生器的值域包含 1 到 31 天的旅行、0 到 8 台 Vehicle、有 0 到 6 個 Stop 的 Route（含 Shopping_Stop）、沒有出發時間的 Route、Legacy_Departure、有與沒有 Day_Settings 及 Arrival_Time 的日子、每一種 Activity_Category 與餐次、時間相同的 Activity 與 Meal_Moment，以及「誰負責買」為待分配、是某台 Vehicle 的駕駛或乘客，或不在任何 Vehicle 上的採買品項，且所有車名、Activity 標題與料理名稱彼此不同。測試先驗證 State_Validator 接受每一組，再驗證需求 14.18：每條 Route、每筆 Activity 與每個 Meal_Moment 在其 Trip_Day 的段落中恰好有一個依需求 14.9 或 14.13 格式產生的項目行，在其他段落中沒有；同一個 Trip_State 與它的深拷貝各產生兩次 Itinerary_Text，四次結果逐字相同。
4. THE Test_Suite SHALL 以 fast-check（`numRuns` 不少於 100）驗證兩件事。第一，State_Validator 接受由 `seed()` 或 `emptyState()` 隨機修改而成、只含本功能之前已有欄位且符合本功能之前驗證規則的 Trip_State。這個產生器的值域包含六種 Legacy_Activity_Type，全體旅伴、指定車輛與舊旅伴名單三種參加方式，以及「HH:MM · 地點」、只有時間、無法分出時間的自由文字與空字串四種 `meeting`（需求 18.1、18.12）。第二，在需求 23.3 產生的 Trip_State 中每次只加入下列一種錯誤時，State_Validator 都判定無效：
   - Place：名稱去除前後空白後為空、超過 50 字或含控制字元，兩個 Place 名稱相同，Place 名稱與旅行目的地相同，或有 101 個 Place（需求 2.1、18.3、18.4）。
   - Route：日期不在旅行日期範圍內、Vehicle 不存在、與同一天同一台車的另一條 Route 重複、起點或終點不是存在的 Place 或 Destination_Place、旅行目的地空白時起點或終點使用 Destination_Place、出發時間不是空白也不是 HH:MM，或有 7 個 Stop（需求 18.5）。
   - Stop：地點不存在、旅行目的地空白時地點使用 Destination_Place、任務類型不是採買、接送、取還裝備或其他，或備註有 101 字（需求 18.6）。
   - Day_Settings：日期不在旅行日期範圍內或與另一筆重複、Day_Title 有 21 字、Day_Location 不是存在的 Place（包括使用 Destination_Place），或 Arrival_Time 不是空白也不是 HH:MM（需求 18.7）。
   - Meal：Meal 的時間不是 HH:MM（需求 18.8）。
5. THE Test_Suite SHALL 以 fast-check（`numRuns` 不少於 100）分別測試前端 Trip_Settings_Dialog 與 Server 的旅行日期變更：產生需求 23.3 的 Trip_State 與新的開始及結束日期（新旅行為 1 到 31 天），驗證需求 20.5。接受變更時，變更前後每個第 N 天的 Route 識別碼集合相同，每筆 Day_Settings 也維持原本的第 N 天（需求 20.1、20.3）。新的天數放不下任何 Route 或 Day_Settings 時拒絕變更，前端的 Trip_State 與 Server 儲存的資料都不變（需求 20.2、20.4）。
6. THE Test_Suite SHALL 以 Playwright 在 Trip_State 為 Example_Trip 的 Local_Planner 中，於 320、390 與 1440 CSS 像素寬（以 `page.setViewportSize` 設定，不依賴 Playwright project 的視窗）與 `<html data-theme>` 為 `light`、`dark` 的每一種組合下驗證下列各項：
   - 版面：Itinerary_Poster，以及在 First_Day 分別展開 Places_And_Cars 與第三車・採買組 Route 卡片的 Itinerary_Editor，`document.documentElement.scrollWidth` 都不超過 `window.innerWidth` 加 1 像素（需求 17.1）。
   - 行程圖文字：移除 `aria-hidden="true"` 子樹後的 Itinerary_Poster 文字包含：
     - 「三天兩夜・四台車・10/20（週二）至 10/22（週四）」「四台車，三天兩夜，一整頁的小小快樂。」「路線僅為示意，非導航或即時位置；不預估返抵時間。」（需求 11.13 至 11.15）；
     - 每一天的 Day_Title、日期（月/日）、星期與 Day_Caption，Day_Caption 依序為「四車出發・採買・會合」「今天，留在夕淞度日營區」「四車出發・返程」；
     - 每條 Route 的車名、出發時間、起點與終點，以及 Stop 的地點、任務類型與 Shopping_Summary；
     - 「第三車・採買組先採買，其他三車直達」「預計 12:00 抵達・四車會合」「平安回到台北」；
     - 每筆 Activity 與 Meal_Moment 的時間、標題（Meal_Moment 使用需求 8.5 的文字）與食材。
   - 順序：三天的 Day_Title 依序出現，每一天的文字依 Day_Sequence 排列。例如第 1 天的「預計 12:00 抵達・四車會合」在「搭帳・營地佈置」之前，第 3 天的「四車集合、返程」在「平安回到台北」之前。
   - 壓力資料：使用一個 Route_Block 有 8 台車、每台車 6 個 Stop 的 Trip_State（車名 3 到 7 字、地點名稱 2 到 6 字，與 Example_Trip 相同），在相同的寬度與主題下驗證沒有頁面層級的水平捲動，且路線圖中任兩個直接包含文字的元素的邊界框不相交（需求 17.4）。
7. THE Test_Suite SHALL 以 Playwright 驗證下列操作。每次儲存後重新載入頁面，確認 Itinerary_Editor、Itinerary_Poster 與 Text_Panel 仍呈現符合括號中需求的結果。

   在 Local_Planner 中：
   - 在沒有 Activity 的 First_Day 勾選全部 Activity_Preset，並啟動「加入 N 個活動」（需求 7.2 至 7.4）。
   - 新增一條含採買 Stop 的 Route，確認該 Stop 的預覽依序列出這台車駕駛與乘客負責買的品項，以「上移」「下移」調整 Stop 順序後儲存，再修改出發時間並儲存；接著以「到採買清單調整負責人」切換到 Shopping_Tab，把一個品項的「誰負責買」改成另一台有採買停靠點的車上的旅伴，確認 Shopping_Tab 的「第 {N} 天在{地點}（{車名}）」、Itinerary_Editor 的預覽、Itinerary_Poster 與 Text_Panel 都改為新的車（需求 5.2、5.11、6.5、6.6、6.7、6.10、6.12）。
   - 以地點下拉選單旁的「＋新增地點」新增地點，在 Places_And_Cars 改名地點；新增或改名為同名地點時被拒絕（需求 2.2、2.5、2.6）。
   - 刪除仍被 Route 使用的地點時被拒絕，並列出使用它的日子與車輛（需求 2.7）。
   - 修改 Meal_Moment 的時間後，Trip_State 中只有該 Meal 的時間改變（需求 8.3）。
   - 有 Draft 時執行需求 10.2 列出的每一種操作：使用者取消時保留 Draft 與畫面，使用者確認時丟棄 Draft 且 Trip_State 不變；重新整理頁面時觸發 `beforeunload` 確認（需求 10.2、10.3）。
   - 匯出 JSON 備份再匯入後，Trip_State 與匯出前相同（需求 18.13）。

   在 Account_Mode 中：
   - 另一個請求先更新同一趟旅行後再儲存 Route 卡片時，Draft 與畫面保留，顯示既有的「其他人已更新」提示，且伺服器上的資料沒有被覆寫（需求 10.5）。
8. THE Test_Suite SHALL 驗證各角色的權限：
   - 以 Playwright 在 Account_Mode 開啟同一趟含 Route、Stop、Activity、Place 與 Vehicle 的旅行：
     - Trip_Manager 看得到 View_Switch、Itinerary_Editor，以及新增、修改與刪除 Route、Stop、Activity、Place 與 Vehicle 的控制項（需求 21.6）。
     - Collaborator 看得到 View_Switch、Itinerary_Editor、新增與修改的控制項（例如「＋新增路線」「＋新增地點」與卡片的「儲存」），以及刪除 Route、Stop、Activity 與 Place 的控制項（「刪除這條路線」、已儲存 Stop 的移除按鈕、「刪除這個活動」與 Places_And_Cars 的「刪除」）；從 Places_And_Cars 開啟的 Vehicle_Dialog 與 Trip_Menu 中刪除 Vehicle 的控制項數量為 0（需求 3.11、21.2）。Collaborator 確認刪除一條已儲存的 Route 後，重新載入頁面時該 Route 不再出現（需求 10.7、21.7）。Collaborator 的同步狀態顯示「協作編輯模式，不能刪除旅伴、料理、採買品項、裝備與車輛」（需求 21.10）。
     - Viewer 看不到 View_Switch、Itinerary_Editor 與任何新增、修改、刪除或勾選完成的控制項，但可以展開 Text_Panel、複製文字與操作 Motion_Toggle（需求 1.5、21.1）。Server 的 `tripAccess()` 不讓 `canEdit` 為 false 的帳號讀取旅行，因此以攔截 `GET /api/trips/:id` 回應、把 `permissions.canEdit` 與 `permissions.canDelete` 改為 false 的方式模擬 Viewer。
   - 以 `bun test` 透過 `createAccountService()`：
     - Collaborator 以 `PUT /api/trips/:id` 移除既有的 Activity、Place、Route 或 Stop 時各回應 200，之後 `GET` 回傳的 Trip_State 不再包含被移除的項目（需求 21.7）。
     - Collaborator 移除既有的旅伴、料理、裝備、車輛或採買品項（料理食材同步自動移除的品項除外）時，各回應 403 與需求 21.3 的訊息，且 `trip.revision` 與 `state` 不變。移除旅伴的情況使用沒有綁定任何帳號的旅伴；移除已綁定帳號的旅伴時，Server 依需求 21.3 先回應 409，不回應這個 403。
     - Collaborator 把既有、不是由料理食材產生的採買品項（`source` 不是 `meal`）改標為料理食材產生的品項時，回應 403 與需求 21.3 的訊息，且 `trip.revision` 與 `state` 不變（需求 21.3(c)）。
     - Collaborator 修改 Day_Settings、改變採買品項的「誰負責買」、改變 Vehicle 的駕駛與乘客，以及清除 Vehicle 的 `meeting` 時回應 200（需求 21.4）。
     - 非成員的 `GET` 與 `PUT /api/trips/:id` 回應 404（需求 21.5）。
9. THE Test_Suite SHALL 以 Playwright 透過 API 在 Account_Mode 把 XSS_Payload_Set 的每個字串，存入下列欄位中能原樣保存它的每一個：被 Route 或 Stop 使用的 Place 名稱、車名、Activity 標題、地點與備註、任務類型不是採買的 Stop 的備註、Day_Title、料理名稱、食材、列在 Shopping_Stop 的採買品項名稱（「誰負責買」是該車的駕駛或乘客），以及負責買某個品項、但不在任何車上的旅伴名（顯示在「未分配採買清單」的原因中）。接著在兩個畫面中檢查：展開 Text_Panel 的 Itinerary_Poster，以及依序展開 Places_And_Cars、含採買品項預覽的 Route 卡片、「未分配採買清單」與 Activity 卡片的 Itinerary_Editor。
   - 以 `tests/security-xss.e2e.js` 的偵測方式驗證：沒有任何 dialog、`pageerror`、`securitypolicyviolation` 或對 `window.__xss` 的寫入；也沒有非預期元素，包括 iframe、frame、object、embed、沒有 `src` 或來自其他 origin 的 script、`src` 不是 `blob:` 的 img，以及帶 `on*` 屬性或 `javascript:` 網址的元素。
   - Text_Panel 的文字包含旅伴名以外的每個字串；Itinerary_Poster 的文字包含 Activity 備註與旅伴名以外的每個字串；Itinerary_Editor 展開的卡片與「未分配採買清單」中顯示這些內容的欄位值或文字等於原字串。
   - 頁面沒有向其他 origin 發出請求（需求 22.1、22.2、22.4）。
10. THE Test_Suite SHALL 以 Playwright 分別在 Account_Mode（以 `POST /api/trips` 的 `legacyState` 建立 `seed()` 的旅行）與 Local_Planner（`tests/local-planner-fixture.js` 寫入的 `seed()`）開啟 Trip_View，切換到 Itinerary_Editor 並選取每一天，再切回 Itinerary_Poster，全程不儲存，然後驗證：
    - 不寫入（需求 19.1）：Account_Mode 沒有送出 `PUT` 或 `PATCH /api/trips/:id`，`GET /api/trips/:id` 回傳的 `trip.revision` 與 `state` 與開啟前相同，且 localStorage 沒有 `STORAGE_KEY`；Local_Planner 的 localStorage 內容與頁面載入完成時逐字相同。
    - 既有活動（需求 19.2）：Itinerary_Poster 在各自的日子顯示 `seed()` 全部 10 筆 Activity 的標題；參加者不是全體旅伴的 Activity 顯示原旅伴名單，例如「把好吃的，一起買齊」顯示「小安、小雨、米米」。
    - 舊出發資料（需求 19.3）：First_Day 顯示山線小巴與海風號的舊出發時間「14:00」與地點「台北車站東三門」，第 2 天與第 3 天的段落不出現「台北車站東三門」。
    - 自由文字（需求 19.7）：把一台車的 `meeting` 改為無法分出時間的自由文字時，Itinerary_Poster 原樣顯示該文字，並把出發時間顯示為待定。
    - 舊備份（需求 19.8）：在 Local_Planner 匯入 `seed()` 的 JSON 備份後，上述顯示結果同樣成立。
11. THE Test_Suite SHALL 修改下列依賴已移除介面（需求 1.6、3.7）的 Changed_Test，改為測試取代它們的介面。只有在行為已不存在時才移除該檢查（「新增一站」的位置規則、「按車查看行程」）。每個修改的檔案開頭以註解寫明「trip-planning-workflow-enhance」與改動原因。
    - `tests/schedule-bar.e2e.js`：TC-SCHED-001 改量 Itinerary_Editor 的選日按鈕，在原有寬度與 3、8、15 天保留 mobile-smooth-swipe 需求 7.3 至 7.6 的檢查。
    - `tests/app.e2e.js`：
      - TC-DEMO-002 改為確認 Itinerary_Poster 顯示「這趟旅行還沒有行程」。
      - TC-DEMO-001 與日期變更測試改計 Itinerary_Poster 每一天的 Activity 數。
      - TC-SWIPE-001 改用料理卡片。
      - TC-DEMO-003 與響應式版面測試改量 Itinerary_Editor 的選日按鈕。
      - 以「新增一站」開啟對話框的測試中，新增、編輯與移除活動改用 Itinerary_Editor 的自訂活動；深色模式與 Escape、損毀資料、放棄草稿、點背景關閉與另一分頁草稿改用仍存在的對話框。
      - 新增車輛測試移除「出發地點」欄位的步驟。
    - `tests/mobile-swipe.e2e.js`：左滑範例列與重新繪製的步驟改用料理卡片與料理菜單分頁，並確認 Itinerary_Editor 中沒有 `[data-swipe-row]`；TC-SWIPE-024 原本點擊需求 1.6 移除的 `.schedule-intro` 說明列，改點料理菜單分頁中同樣位於每個左滑面板之外、點擊沒有其他作用的元素。
    - `tests/vehicle-itinerary.e2e.js`：Activity 的參加方式改在 Itinerary_Editor 的 Activity 卡片驗證（需求 7.6、7.7）；刪除仍被指定的 Vehicle 改從 Places_And_Cars 或 Trip_Menu 驗證（需求 3.10）。
    - `tests/vehicle-departures.e2e.js`：改測 Legacy_Departure 的顯示、「轉成路線」與「不使用舊資料」（需求 3.8、19.3 至 19.7）。
    - `tests/maps.e2e.js`：改從 Itinerary_Poster 的 Activity 地點與舊出發地點檢查地圖連結，Activity 地點需不同於旅行目的地（需求 11.10、11.17）。
    - `tests/security-xss.e2e.js`：TC-XSS-003 在行程表分頁檢查 Itinerary_Poster 與展開的 Text_Panel。
    - `tests/accounts.test.js`：「members cannot remove existing items through whole-state PUT; owners can」中受邀旅伴移除全部 Activity（`s.activities = []`）的情況，改為預期回應成功並保存移除（需求 21.7）；其他移除情況仍預期 403（需求 21.3）。

    完成後，`tests/` 中除了確認元素不存在的斷言外，不再使用 `.timeline`、`.activity-card`、`.schedule-bar`、`.schedule-intro`、`.vehicle-departures`、`.departure-vehicle`、`[data-vehicle-departure]`、`#schedule-vehicle`、「新增一站」按鈕，以及以「出發時間（選填）」或「出發地點」標籤取得的 Vehicle_Dialog 欄位。其他因本功能而失敗的既有測試也視為 Changed_Test，並遵守相同規則。
12. WHEN 實作完成，THE Test_Suite SHALL 依 README「測試」一節的步驟，讓 `bun run build` 之後的三個指令都以結束碼 0 完成：`bun test tests/*.test.js`（PowerShell 為 `bun test ./tests/`）、`node scripts/check-accounts.mjs`（執行 `playwright.config.js` 的 desktop 與 mobile project），以及 `bun scripts/security-suite.mjs`。執行範圍包含既有測試、Changed_Test 與本需求新增的測試。除了 Changed_Test 依需求 23.11 修改或移除的檢查外，不刪除既有測試，也不新增 `skip`、`only`、`todo` 或 `fixme`。
13. THE Test_Suite SHALL 以 `bun test` 透過 `createAccountService()`（與 `tests/vehicle-itinerary.test.js` 的帳號 API 測試相同方式）驗證 Server：
    - 保存新欄位（需求 18.9）：以 `POST /api/trips` 的 `legacyState` 與 `PUT /api/trips/:id` 儲存 Example_Trip 後，`GET /api/trips/:id` 回傳的 Place_List、Route（含 Stop）、Day_Settings 與 Meal 時間與送出的相同。
    - 拒絕無效資料（需求 18.10）：需求 23.4 的每一種無效情況各以 `PUT` 送出一次，都回應 400，且 `trip.revision` 與 `state` 不變。
    - 缺少欄位時保留舊值（需求 18.11）：`PUT` 的 Trip_State 完全沒有 Place_List、Route 或 Day_Settings 欄位時，`GET` 仍回傳伺服器原本的值；送出空的 Day_Settings 清單時則存為空清單。
    - 日期平移（需求 20.3、20.4）：以 `PATCH /api/trips/:id` 變更旅行日期，或以不同於 `legacyState` 的日期 `POST /api/trips` 時，Route 與 Day_Settings 平移的天數與 Activity、Meal 相同；平移後落在新日期範圍外時回應 400，且不寫入任何資料。
14. THE Test_Suite SHALL 以 fast-check（`numRuns` 不少於 100）驗證需求 6.11 的推導。產生器在需求 23.3 的值域之外，另外包含同一位旅伴是兩台以上 Vehicle 的駕駛或乘客、駕駛為待分配的 Vehicle、沒有 Shopping_Stop 的 Vehicle，以及在同一天或不同天有多個 Shopping_Stop 的 Vehicle。測試使用 Itinerary_Editor、Shopping_Tab、Vehicle_Dialog 與料理菜單儲存時所用的同一組函式，從產生的 Trip_State 開始隨機依序套用 1 到 10 個操作：改變品項的「誰負責買」、改變 Vehicle 的駕駛或乘客、新增或刪除 Shopping_Stop、把 Shopping_Stop 的任務類型改為採買以外、調整 Stop 順序、刪除 Route、刪除採買品項，以及新增、刪除或修改 Meal 而使 `syncMealIngredients()` 新增或移除食材品項。產生的 Trip_State 與每個操作之後的 Trip_State 都驗證（需求 6.9、6.11、6.12）：
    - State_Validator 接受該 Trip_State。
    - 每個採買品項最多出現在一個 Shopping_Stop 的 Stop_Items 中，且恰好屬於 Stop_Items 與 Unassigned_Shopping 其中之一。
    - Shopping_Assignee 有 Buyer_Car 且 Buyer_Car 有 Shopping_Stop 的品項，出現在 Buyer_Car 的 First_Shopping_Stop；其他品項都在 Unassigned_Shopping，原因與需求 6.11 的 (a)、(b)、(c) 相符；不是 First_Shopping_Stop 的 Shopping_Stop 沒有 Stop_Items。
    - 每個 Shopping_Stop 的 Shopping_Summary 等於依需求 6.9 由其 Stop_Items 產生的文字。
    - 同一個 Trip_State 與它的深拷貝各推導兩次，四次的 Stop_Items、Unassigned_Shopping 與原因都相同。
15. THE Test_Suite SHALL 以 Playwright 在 Trip_State 為 Example_Trip 的 Local_Planner 中驗證：
    - 複製文字（需求 15.2、15.3）：啟動 Text_Panel 的「複製文字」後，剪貼簿內容與 Example_Text 逐字相同，並顯示「已複製行程文字」。讓 `navigator.clipboard.writeText` 失敗時，Text_Panel 的全部文字被選取，並顯示「請手動複製已選取的文字」。
    - 減少動態（需求 13.1、13.2）：Reduced_Motion 下 `<html data-scene-motion>` 為 `reduced`，Itinerary_Poster 的 `getAnimations({ subtree: true })` 沒有任何動畫，Motion_Toggle 隱藏，且顯示「依系統減少動態設定，插畫保持靜態」。
    - 動畫開關同步（需求 13.3、13.4）：啟動 Itinerary_Poster 的 Motion_Toggle 時，`data-scene-motion` 在 `running` 與 `paused` 之間切換；Itinerary_Poster 與 Trip_Menu 的 Motion_Toggle 無障礙名稱同步為「播放動畫」（paused 時）或「暫停動畫」（running 時）；可視範圍內段落動畫的 `playState` 同步為 `paused` 或 `running`。從 Trip_Menu 切換時，Itinerary_Poster 也同步改變。
    - 列印（需求 13.6 至 13.9）：在 `emulateMedia({ media: 'print' })` 下，不論目前顯示哪一種檢視，Itinerary_Poster 都可見，第一天的段落之前顯示旅行名稱、Duration_Text、日期範圍與旅行介紹；Itinerary_Editor、View_Switch 與 Motion_Toggle 都不可見；Itinerary_Poster 沒有任何動畫；每一天段落的 `break-inside` 計算值為 `avoid`。

### Requirement 24: 文件

**User Story:** 身為新使用者，我希望 README 說明新的行程表怎麼用，以便知道如何規劃與分享行程。

#### Acceptance Criteria

1. THE README SHALL 改寫 `## Features` 章節中以 `**Itinerary:**` 開頭的項目（保留這個開頭），並說明下列每一點：(a) 「行程表」預設顯示 Itinerary_Poster「行程圖」，每位能編輯旅行的人（包含受邀旅伴）都可以切換到 Itinerary_Editor「規劃行程」；(b) 「行程圖」以動態插畫一次呈現整趟旅行，每天一段，顯示每台車從哪裡、幾點出發，途中在哪裡停留，預計幾點抵達，以及當天的活動與餐點；(c) 「規劃行程」以勾選與選單一次規劃一天；(d) Places_And_Cars「地點與車」集中管理這趟旅行的地點清單與車輛；(e) 每台車每天最多一條 Route，每條 Route 最多 6 個 Stop，任務類型為採買、接送、取還裝備或其他；(f) 「常用活動」為 First_Day、中間的日子與 Last_Day 提供不同的建議活動，也可以新增自訂活動；(g) 「料理菜單」的餐點自動出現在當天的行程，並顯示料理名稱與食材；(h) Text_Panel「文字版」顯示由規劃內容自動產生、格式一致的 Itinerary_Text，可以一鍵複製。
2. THE README SHALL 在同一個 `**Itinerary:**` 項目中說明路線只是示意，並逐一寫明 App 不提供導航、即時位置、行車時間估算與返抵時間預估這四項，也說明每一天的 Arrival_Time 由規劃的人填寫、App 不會計算。
3. THE README SHALL 讓 `## Plan a trip` 維持現有 9 個步驟的主題與順序；在第 2 步（目前為 `**Add companions and vehicles.**`）說明旅伴在「旅行選單」新增，車輛的駕駛、乘客與座位數可以在「旅行選單」或「地點與車」新增與編輯且兩處是同一份資料，地點清單在「地點與車」管理，出發時間與出發地點不在車輛中設定，而是在第 3 步為每一天的 Route 設定；並在第 3 步（目前為 `**Plan the itinerary.**`）說明下列每一點，其中 (a) 在其他各點之前、(g) 在其他各點之後：(a) 在「行程表」切換到「規劃行程」並選擇一天；(b) 為每台車新增 Route，從地點清單選擇出發地、每個 Stop 的地點與終點，清單沒有的地點可以就地新增，出發時間可以先留空；(c) Shopping_Stop 自動列出這台車的駕駛與乘客在「採買清單」負責買（「誰負責買」）的品項，一台車有多個 Shopping_Stop 時列在第一個；要換車買，就在「採買清單」改「誰負責買」或改車輛的駕駛與乘客；找不到對應車輛或 Shopping_Stop 的品項列在「未分配採買清單」；(d) 填寫當天的預計抵達時間；(e) 勾選「常用活動」或新增自訂活動；(f) 「料理菜單」的餐點已列在當天，時間預設依餐次並可以在「規劃行程」修改，料理名稱與食材在「料理菜單」修改；(g) 回到「行程圖」，展開下方的「文字版」，以「複製文字」複製後貼到聊天群組。
4. THE README SHALL 不包含下列英文片語：「Plan dated and timed stops」「mark stops complete」「filter by vehicle」「Each vehicle can have its own departure time and meeting place」「The add-stop button sits beside the date tabs」「set each vehicle's departure time and place」「add a stop with a time, location, type, notes, and participants」「Vehicle filters show each car's stops separately」「the next unfinished stop」；也不以其他文字描述需求 1.6 移除的介面，或描述在 Vehicle_Dialog 設定出發時間與出發地點；並在 `## Plan a trip` 第 8 步以活動（activity）稱呼出發模式顯示的下一個未完成項目，不描述出發模式顯示 Route 或 Stop。
5. THE README SHALL 讓第 1 至 4 條與第 6 條改寫的文字除介面名稱外都以英文撰寫，與 `## Features`、`## Plan a trip` 的其他內容相同，並把第 1 至 3 條與第 6 條以「」標示的介面名稱以粗體繁體中文原樣寫出；其中「行程圖」「規劃行程」「地點與車」「常用活動」「未分配採買清單」「文字版」與「複製文字」在 README 第一次出現時，於後方括號附英文說明，與現有的「**旅行選單** (trip menu)」寫法相同。
6. THE README SHALL 在 `## Features` 以 `**Invitations and permissions:**` 開頭的項目中說明：受邀旅伴（collaborators）可以在「行程表」刪除路線、途中任務、活動與地點，旅伴、料理、採買品項、裝備與車輛仍只有旅行建立者與管理員可以刪除；該項目不再寫成只有旅行建立者與管理員可以刪除旅行內容。
