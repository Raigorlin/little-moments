// Admin_Page 網站設定：公開註冊政策（jenkins-cicd-deploy Requirement 26.11、26.13–26.15、26.20）。
// The test closes public registration on the shared E2E server, so it holds the registration lock for its
// whole run (tests/support/registration-lock.js) and always stores `open` again before releasing it.
import {test,expect} from './local-planner-fixture.js';
import {withRegistrationLock} from './support/registration-lock.js';
import {E2E_ADMIN} from './support/e2e-pool.js';
const testBase=process.env.CAMPING_BASE_URL;
const {username:adminName,password}=E2E_ADMIN;
const CLOSED_NOTICE='目前不開放公開註冊。請向旅伴索取旅行邀請連結，從邀請頁建立帳號。';
const CLOSED_ERROR='目前不開放公開註冊，請使用旅行邀請連結建立帳號。';
const json=body=>({headers:{'Content-Type':'application/json','Origin':testBase},data:body});

test.beforeEach(async({baseURL})=>expect(new URL(baseURL).port).toBe('5181'));

test('[TC-ADMIN-004] admin closes and reopens public registration without restart',async({page,browser},testInfo)=>{
 await withRegistrationLock(testInfo,async()=>{
  const login=await page.request.post(`${testBase}/api/login`,json({username:adminName,password}));
  expect(login.status()).toBe(200);
  // A signed-out visitor in its own context; the service worker is blocked so every navigation reads /api/session.
  const visitor=await browser.newContext({baseURL:testBase,serviceWorkers:'block'});
  try{
   const select=page.locator('#setting-registration');
   const help=page.locator('#setting-registration-help');
   const form=page.locator('form[data-form="admin-settings"]');
   const save=async value=>{
    await select.selectOption(value);
    const request=page.waitForRequest(r=>r.method()==='PATCH'&&new URL(r.url()).pathname==='/api/admin/settings');
    await form.getByRole('button',{name:'儲存設定',exact:true}).click();
    // Only the changed field is sent (Req 26.15).
    expect((await request).postDataJSON()).toEqual({registrationPolicy:value});
    await expect(page.locator('#toasts')).toContainText('公開註冊設定已更新');
    await expect(select).toHaveValue(value);
    await expect(help).toContainText(`由 ${adminName} 於`);
    await expect(help).toContainText('伺服器環境變數 CAMPING_REGISTRATION 不再生效。');
   };

   await page.goto('/admin');
   await expect(page.getByLabel('公開註冊',{exact:true})).toBeVisible();
   await expect(select).toHaveValue('open');
   await expect(select.locator('option')).toHaveText(['開放：任何人都能在 /register 建立帳號','關閉：只能經旅行邀請連結建立帳號']);
   await expect(help).toHaveText('目前使用預設值（open）。');
   // Saving without a change sends nothing.
   let patches=0;const count=r=>{if(r.method()==='PATCH'&&new URL(r.url()).pathname==='/api/admin/settings')patches++;};
   page.on('request',count);
   await form.getByRole('button',{name:'儲存設定',exact:true}).click();
   await expect(form.locator('.form-error')).toHaveText('沒有變更的設定。');
   page.off('request',count);expect(patches).toBe(0);

   await save('closed');
   const closedPage=await visitor.newPage();
   await closedPage.goto('/register');
   await expect(closedPage.getByText(CLOSED_NOTICE,{exact:true})).toBeVisible();
   await expect(closedPage.getByRole('link',{name:'前往登入',exact:true})).toBeVisible();
   await expect(closedPage.getByRole('button',{name:'註冊並登入',exact:true})).toHaveCount(0);
   await expect(closedPage.getByLabel('帳號名稱（網址用）',{exact:true})).toHaveCount(0);
   const refused=await visitor.request.post(`${testBase}/api/register`,json({username:'closed-visitor',displayName:'關閉時的訪客',password}));
   expect(refused.status()).toBe(403);
   expect(await refused.json()).toEqual({error:CLOSED_ERROR});
   expect((await (await visitor.request.get(`${testBase}/api/session`)).json()).registrationOpen).toBe(false);

   await save('open');
   await closedPage.goto('/register');
   await expect(closedPage.getByRole('button',{name:'註冊並登入',exact:true})).toBeVisible();
   await expect(closedPage.getByLabel('帳號名稱（網址用）',{exact:true})).toBeVisible();
   await expect(closedPage.getByText(CLOSED_NOTICE)).toHaveCount(0);
  }finally{
   await visitor.close();
   // Leave public registration open for the other tests, whatever happened above.
   const restore=await page.request.fetch(`${testBase}/api/admin/settings`,{method:'PATCH',...json({registrationPolicy:'open'})});
   expect(restore.status()).toBe(200);
  }
 });
});
