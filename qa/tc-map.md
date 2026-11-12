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
