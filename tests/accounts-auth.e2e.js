import {test,expect} from '@playwright/test';
const password='UI-Only-Test-Pass-2026';
test('[TC-AUTH-001] registration and login forms create account-specific URL and reject mismatched passwords @critical',async({page,baseURL})=>{
 test.skip(new URL(baseURL).port!=='5181','Use isolated account test server.');
 const name=`ui-${Date.now().toString(36)}`;
 await page.goto('/register');const registerArt=await page.locator('.acct-auth-art').getAttribute('class');await expect(page.locator('.acct-auth-art .scene-motion svg')).toHaveCount(1);await expect(page.locator('.acct-auth-art svg')).toHaveAttribute('preserveAspectRatio','xMidYMax meet');await expect(page.locator('.acct-auth-art svg>rect')).toHaveCount(0);await expect(page.locator('.acct-local-note')).toHaveCount(0);await expect(page.locator('.acct-nav a[href="/demo/#/trip"]')).toHaveCount(0);await expect(page.locator('.acct-footer-note')).toContainText('把日常摺進行囊');await expect(page.locator('.acct-footer')).not.toContainText('資料儲存在這台電腦');await page.getByLabel('帳號名稱（網址用）',{exact:true}).fill(name);await page.getByLabel('顯示名稱',{exact:true}).fill('露友小禾');await page.getByLabel('密碼',{exact:true}).fill(password);await page.getByLabel('再次輸入密碼',{exact:true}).fill(password+'wrong');await page.getByRole('button',{name:'註冊並登入',exact:true}).click();await expect(page.locator('.form-error')).toContainText('不一致');
 await page.getByLabel('再次輸入密碼',{exact:true}).fill(password);await page.getByRole('button',{name:'註冊並登入',exact:true}).click();await expect(page).toHaveURL(new RegExp(`/${name}/home$`));await expect(page.getByRole('heading',{name:'露友小禾 的旅行手帳',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'登出',exact:true}).click();await expect(page).toHaveURL(/\/login$/);await expect(page.locator('.acct-auth-art')).not.toHaveClass(registerArt);await page.getByLabel('帳號名稱',{exact:true}).fill(name);await page.getByLabel('密碼',{exact:true}).fill(password);await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page).toHaveURL(new RegExp(`/${name}/home$`));
 const cookies=await page.context().cookies();const session=cookies.find(c=>c.name==='ggc_session');expect(session.httpOnly).toBe(true);expect(session.sameSite).toBe('Strict');expect(await page.evaluate(()=>document.cookie)).not.toContain('ggc_session');
});

// 首次設定的 Setup_Token 欄位（Req 9.1、9.2）。共用測試伺服器已有管理員，因此以 page.route 模擬
// 「尚未設定且需要設定碼」的 session，並攔截 /api/setup：不會在真實伺服器建立任何使用者。
test.describe('first admin setup token',()=>{
 // Service worker 處理的請求不經過 page.route，這裡封鎖以確保攔截生效。
 test.use({serviceWorkers:'block'});
 test('[TC-SETUP-001] setup form requires the labelled setup token and sends it without creating a user @critical',async({page,baseURL})=>{
  test.skip(new URL(baseURL).port!=='5181','Use isolated account test server.');
  const token='placeholder-setup-token-value';
  const setupBodies=[];
  await page.route('**/api/session',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({user:null,needsSetup:true,setupTokenRequired:true})}));
  await page.route('**/api/setup',route=>{setupBodies.push(route.request().postDataJSON());return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'設定碼不正確，請確認後再試。'})});});
  await page.goto('/setup');
  const tokenInput=page.getByLabel('設定碼',{exact:true});
  await expect(tokenInput).toBeVisible();await expect(tokenInput).toHaveAttribute('type','password');
  await page.getByLabel('帳號名稱（網址用）',{exact:true}).fill('setup-ui-check');await page.getByLabel('顯示名稱',{exact:true}).fill('設定測試');
  await page.getByLabel('密碼',{exact:true}).fill(password);await page.getByLabel('再次輸入密碼',{exact:true}).fill(password);
  // 空白設定碼：前端拒絕送出。
  await page.getByRole('button',{name:'建立管理員帳號',exact:true}).click();
  await expect(page.locator('.form-error')).toContainText('請輸入設定碼');expect(setupBodies).toHaveLength(0);
  // 填入設定碼：請求帶有 setupToken，伺服器拒絕時表單保留並顯示錯誤。
  await tokenInput.fill(token);await page.getByRole('button',{name:'建立管理員帳號',exact:true}).click();
  await expect(page.locator('.form-error')).toContainText('設定碼不正確');
  expect(setupBodies).toHaveLength(1);expect(setupBodies[0]).toMatchObject({username:'setup-ui-check',setupToken:token});
  await expect(page).toHaveURL(/\/setup$/);
  // 真實伺服器未被變更：仍不需要首次設定（page.request 不經過 page.route）。
  const real=await page.request.get(new URL('/api/session',baseURL).href);expect(real.status()).toBe(200);expect((await real.json()).needsSetup).toBe(false);
 });
});
