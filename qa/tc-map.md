# QA_Inventory 測試案例 ID 對照（供任務 8.2 套用）

`qa/inventory.json` 中每個項目對應的測試案例 ID。任務 8.2 需將下列 E2E 測試標題改為以 `[TC-<area>-<nnn>]` 開頭；標記 `@critical` 的案例會同時在 desktop（1440×1000）與 mobile（390×844）執行。

## 既有測試（改標題即可）

| TC ID | @critical | 檔案 | 現有測試標題 |
|---|---|---|---|
| TC-AUTH-001 | 是 | `tests/accounts-auth.e2e.js` | registration and login forms create account-specific URL and reject mismatched passwords |
| TC-BRAND-001 | 否 | `tests/brand.e2e.js` | public login and registration use the new brand |
| TC-DEMO-001 | 否 | `tests/app.e2e.js` | dashboard renders and all planning tabs work |
| TC-HOME-001 | 是 | `tests/accounts.e2e.js` | account home clean URL, multiple cards, edit history and no demo storage writes |
| TC-HOME-002 | 否 | `tests/account-identity.e2e.js` | account home removes stale owner data when a second tab logs out |
| TC-TRIP-001 | 是 | `tests/accounts.e2e.js` | owner recipe template saves isolated server state and shopping with inline assignment selector |
| TC-TRIP-002 | 否 | `tests/accounts.e2e.js` | stale revisions preserve unsaved planner edits instead of overwriting newer data |
| TC-EXP-001 | 否 | `tests/expenses.e2e.js` | manual expense saves cents and chosen participants, shopping link never changes purchased status |
| TC-VEH-001 | 否 | `tests/vehicle-departures.e2e.js` | collaborators can edit departures but cannot delete cars; strangers cannot read the trip |
| TC-INVITE-001 | 否 | `tests/accounts.e2e.js` | invited guest edits shared content but cannot delete trip, remove items or invite others |
| TC-INVITE-002 | 否 | `tests/recipes-invites.e2e.js` | invitation button leads to self-entry and duplicate names cannot take over identities |
| TC-ACCT-001 | 否 | `tests/accounts.e2e.js` | two accounts cannot view each others home or trip or call admin APIs |
| TC-ACCT-002 | 否 | `tests/accounts.e2e.js` | protected API responses are absent from offline caches and logout revokes access |
| TC-ADMIN-001 | 是 | `tests/accounts.e2e.js` | admin edits another owner trip and disables account without deleting travel history |
| TC-ADMIN-002 | 否 | `tests/trip-deletion.e2e.js` | admin deletes another owner trip in backend, revokes link and leaves other trips and account intact |
| TC-ADMIN-003 | 否 | `tests/trip-deletion.e2e.js` | admin can cancel then confirm own trip deletion from home on phone and desktop |
| TC-ADMIN-004 | 否 | `tests/admin-settings.e2e.js` | admin closes and reopens public registration without restart |

## 需新增的測試

| TC ID | @critical | 建議檔案 | 內容（須驗證「操作被拒絕且資料未被變更」） |
|---|---|---|---|
| TC-SETUP-001 | 是 | `tests/accounts-auth.e2e.js` | 共用測試伺服器已有管理員，可用 `page.route('**/api/session')` 回傳 `needsSetup:true, setupTokenRequired:true`，確認 `/setup` 顯示 label 為「設定碼」的密碼欄位、空值送出顯示錯誤、填入後 `/api/setup` 請求 body 含 `setupToken`（攔截請求，不實際建立使用者） |
| TC-UNAUTH-001 | 是 | `tests/accounts.e2e.js` | 未登入 context 開啟 `/<owner>/home` → 導向 `/login` 且不顯示行程標題；`POST /api/trips` 回應 401；擁有者重新讀取行程清單筆數不變 |
| TC-UNAUTH-002 | 是 | `tests/accounts.e2e.js` | 未登入 context 開啟 `/<owner>/trips/<id>` 不顯示行程；`GET`、`PATCH /api/trips/<id>` 回應 401 且不含行程資料；擁有者讀回 title 與 revision 不變 |
| TC-UNAUTH-003 | 是 | `tests/accounts.e2e.js` | member 開啟 `/admin` 不顯示使用者列表；`GET /api/admin/users` 與停用使用者的管理員 API 回應 403；管理員讀回目標使用者仍為啟用 |
| TC-UNAUTH-004 | 否 | `tests/trip-deletion.e2e.js` | member 呼叫管理員刪除他人行程的 API 被拒絕（403／404）；擁有者仍可讀取該行程與邀請 |

## 規劃行程與行程圖（trip-planning-workflow-enhance，任務 15.5）

標題已含 `[TC-…]`；`@critical` 與 `qa/inventory.json` 的 `critical` 一致。TC-ITIN-077 至 079 尚無測試，不列入。

| TC ID | @critical | 檔案 | 內容 |
|---|---|---|---|
| TC-ITIN-001 | 是 | `tests/itinerary-accounts.e2e.js` | 版本衝突時路線卡片的草稿與畫面保留，不覆寫伺服器資料 |
| TC-ITIN-002 | 否 | `tests/itinerary-accounts.e2e.js` | 擁有者與旅伴看到的規劃行程控制項；旅伴沒有刪除車輛控制項 |
| TC-ITIN-003 | 否 | `tests/itinerary-accounts.e2e.js` | 旅伴刪除已儲存路線後重新載入不再出現；同步狀態文字 |
| TC-ITIN-004 | 是 | `tests/itinerary-accounts.e2e.js` | Viewer 只看到行程圖，可展開文字面板、複製文字與操作動態開關 |
| TC-ITIN-010 | 是 | `tests/itinerary-poster.e2e.js` | 複製文字與 Example_Text 逐字相同並顯示已複製提示 |
| TC-ITIN-011 | 是 | `tests/itinerary-poster.e2e.js` | 剪貼簿寫入失敗時全選文字並提示手動複製 |
| TC-ITIN-012 | 是 | `tests/itinerary-poster.e2e.js` | 減少動態時為靜態行程圖並隱藏動態開關 |
| TC-ITIN-013 至 TC-ITIN-019 | 否 | `tests/itinerary-poster.e2e.js` | 動態開關同步與保留、旅行選單切換、兩種檢視列印、文字面板行為 |
| TC-ITIN-020 | 是 | `tests/itinerary-legacy.e2e.js` | 本機版走訪 seed() 不寫入儲存資料 |
| TC-ITIN-021 | 是 | `tests/itinerary-legacy.e2e.js` | 本機版 seed() 的 10 筆活動各出現一次 |
| TC-ITIN-022、TC-ITIN-023、TC-ITIN-029 | 否 | `tests/itinerary-legacy.e2e.js` | 本機版舊出發資料只在第 1 天、自由文字與不完整格式 |
| TC-ITIN-024 | 是 | `tests/itinerary-legacy.e2e.js` | 本機版匯入 seed() 備份結果相同 |
| TC-ITIN-025 | 是 | `tests/itinerary-legacy.e2e.js` | 帳號版走訪 seed() 旅行不送出 PUT 或 PATCH |
| TC-ITIN-026 | 是 | `tests/itinerary-legacy.e2e.js` | 帳號版 seed() 的 10 筆活動各出現一次 |
| TC-ITIN-027、TC-ITIN-028 | 否 | `tests/itinerary-legacy.e2e.js` | 帳號版舊出發資料只在第 1 天、自由文字 |
| TC-ITIN-030 至 TC-ITIN-039 | 否 | `tests/itinerary-screens.e2e.js` | 車輛視窗、旅行選單、旅行設定視窗 |
| TC-ITIN-041 | 是 | `tests/itinerary-editor.e2e.js` | 儲存路線卡片後重新載入仍顯示 |
| TC-ITIN-040、TC-ITIN-042 至 TC-ITIN-047 | 否 | `tests/itinerary-editor.e2e.js` | 常用活動、採買路線、地點新增改名刪除、餐點時間 |
| TC-ITIN-050 至 TC-ITIN-059 | 否 | `tests/itinerary-drafts.e2e.js` | 草稿詢問規則、beforeunload、備份匯出匯入 |
| TC-ITIN-060 至 TC-ITIN-069 | 否 | `tests/itinerary-a11y.e2e.js` | 無障礙：鍵盤、aria、焦點、提示、點擊範圍、對比 |
| TC-ITIN-070 | 是 | `tests/itinerary-layout.e2e.js` | 行程圖文字與順序在各寬度與主題下相同 |
| TC-ITIN-071 至 TC-ITIN-076 | 否 | `tests/itinerary-layout.e2e.js` | 版面方向、配色、壓力資料、跨越 760 像素 |
| TC-XSS-005 | 否 | `tests/security-xss.e2e.js` | 行程圖、文字面板與規劃行程以文字顯示 XSS 測試字串 |
