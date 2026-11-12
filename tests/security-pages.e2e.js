// Feature: security-hardening, task 9.4. Browser checks for sign-in redirects, permission pages,
// 401 handling, the Admin_Page usage and login security sections, and the local import size limit.
// Requirements 1.2, 1.10, 5.5, 5.8, 6.7, 17.10, 18.6, 23.8, 23.9, 23.10.
// Budget: this file registers no account (members come from the harness pool, tests/support/e2e-pool.js, because
// the register limit is shared by the whole run), and makes 5 failed logins in total (loginClient allows 30 per 15
// minutes from 127.0.0.1).
import {test,expect} from './local-planner-fixture.js';
import {STORAGE_KEY} from '../src/model.js';
import {poolLogin} from './support/e2e-pool.js';

const testBase=process.env.CAMPING_BASE_URL;
const password='Local-Only-Test-Pass-2026';
const adminName='qa-admin';
const slug=prefix=>`${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
// Selectors for account data that must never be in the DOM of a signed-out or refused page.
const PRIVATE_CONTENT='#trip-list, .acct-trip-grid, .acct-trip-card, .acct-user-list, .acct-user-row, .acct-audit, #trip-title, #admin-users, #admin-security';

async function api(request,path,method='GET',body){
 const res=await request.fetch(testBase+path,{method,headers:body?{'Content-Type':'application/json',Origin:testBase}:{},data:body});
 let data=null;try{data=await res.json();}catch{}
 return {status:res.status(),data};
}
// A fresh pool Member signed in on `request` (an APIRequestContext; page.request shares the page's cookies).
async function register(request,displayName){return poolLogin(request,testBase,{displayName});}
// Pool accounts have the harness pool password; the admin has the fixed local test password.
async function loginForm(page,username,pass=password){
 await page.getByLabel('帳號名稱',{exact:true}).fill(username);
 await page.getByLabel('密碼',{exact:true}).fill(pass);
 await page.getByRole('button',{name:'登入',exact:true}).click();
}
// Records in sessionStorage whether any private content was ever attached to the DOM in this tab.
async function watchLeaks(page){
 await page.addInitScript(selector=>{
  const check=()=>{if(document.querySelector(selector))sessionStorage.setItem('leak',location.pathname);};
  new MutationObserver(check).observe(document,{childList:true,subtree:true});
 },PRIVATE_CONTENT);
}
const leaked=page=>page.evaluate(()=>sessionStorage.getItem('leak'));
const clearLeak=page=>page.evaluate(()=>sessionStorage.removeItem('leak'));

test.describe.configure({mode:'default'});

test.beforeAll(async({baseURL})=>{
 if(!baseURL||new URL(baseURL).port!=='5181')throw new Error('Security page tests must use the isolated test server on port 5181.');
});

test('[TC-SEC-001] signed-out home, trip and admin pages redirect to login with next and return after sign-in @critical',async({page,browser})=>{
 // Pool account 1 of 2: owns the home and trip pages.
 const seedContext=await browser.newContext({baseURL:testBase});
 let owner,trip;
 try{
  owner=await register(seedContext.request,'安全測試甲');
  const r=await api(seedContext.request,'/api/trips','POST',{title:'私密的山谷旅行',destination:'山谷營地',startDate:'2026-10-02',endDate:'2026-10-04',description:'',note:'',status:'planning',coverKind:'camp'});
  expect(r.status).toBeLessThan(300);trip=r.data.trip;
 }finally{await seedContext.close();}
 await watchLeaks(page);
 const cases=[
  {path:`/${owner.username}/home`,user:owner.username,pass:owner.password,landed:page=>expect(page.getByRole('heading',{name:'私密的山谷旅行',exact:true})).toBeVisible()},
  {path:`/${owner.username}/trips/${trip.id}`,user:owner.username,pass:owner.password,landed:page=>expect(page.locator('#trip-title')).toHaveText('私密的山谷旅行')},
  {path:'/admin',user:adminName,landed:page=>expect(page.locator('#admin-users .acct-user-row').first()).toBeVisible()}
 ];
 for(const c of cases){
  await page.context().clearCookies();
  await page.goto(c.path);
  await page.waitForURL(url=>url.pathname==='/login');
  expect(new URL(page.url()).search).toBe(`?next=${encodeURIComponent(c.path)}`);
  await expect(page.getByLabel('帳號名稱',{exact:true})).toBeVisible();
  await expect(page.locator(PRIVATE_CONTENT)).toHaveCount(0);
  expect(await leaked(page),`private content rendered before the redirect from ${c.path}`).toBeNull();
  await loginForm(page,c.user,c.pass);
  await page.waitForURL(url=>url.pathname===c.path);
  await c.landed(page);
  await clearLeak(page);
 }
});

test('[TC-SEC-002] members are refused on /admin and on another account home without a trip list request @critical',async({page})=>{
 // Pool account 2 of 2: a Member signed in through page.request, which shares the page's cookies.
 const memberUser=await register(page.request,'安全測試乙');
 const tripRequests=[];
 page.on('request',req=>{if(new URL(req.url()).pathname==='/api/trips')tripRequests.push(req.url());});

 await page.goto('/admin');
 await expect(page.getByRole('heading',{name:'沒有權限查看這個頁面',exact:true})).toBeVisible();
 await expect(page.getByText('管理後台只開放給管理員。',{exact:true})).toBeVisible();
 await expect(page.locator('#admin-users .acct-user-row')).toHaveCount(0);
 await expect(page.locator('#admin-trips .acct-trip-card, #admin-trips [data-trip-id]')).toHaveCount(0);
 await expect(page.locator('#admin-audit li')).toHaveCount(0);
 await expect(page.locator('.acct-user-row, .acct-audit li')).toHaveCount(0);

 for(const other of [adminName,'no-such-camper']){
  tripRequests.length=0;
  await page.goto(`/${other}/home`);
  await expect(page.getByRole('heading',{name:'沒有權限查看這個頁面',exact:true})).toBeVisible();
  await expect(page.getByText('這是別人的旅行首頁。',{exact:false})).toBeVisible();
  await expect(page.locator('#trip-list')).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  expect(tripRequests,`trip list requested on /${other}/home`).toEqual([]);
 }

 // A 401 while the home trip list loads clears the page and sends the visitor to sign in (Req 1.10).
 // The session is dropped at the same moment, as for a real expiry, so /login does not bounce back.
 await page.goto(`/${memberUser.username}/home`);
 await expect(page.locator('#trip-list')).toBeVisible();
 await page.route('**/api/trips',async route=>{
  await page.context().clearCookies();
  await route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:'請先登入。'})});
 });
 await watchLeaks(page);
 await page.reload();
 await page.waitForURL(url=>url.pathname==='/login');
 expect(new URL(page.url()).search).toBe(`?next=${encodeURIComponent(`/${memberUser.username}/home`)}`);
 await expect(page.getByLabel('帳號名稱',{exact:true})).toBeVisible();
 await expect(page.locator(PRIVATE_CONTENT)).toHaveCount(0);
 await page.unroute('**/api/trips');
});

test('[TC-SEC-003] admin page shows receipt AI usage and a failed-login alert banner that acknowledgment lowers and hides',async({page,playwright})=>{
 // Five failed logins for one unknown, valid-format username create one per-username alert (Req 23.6).
 const target=slug('qa-ghost');
 const anon=await playwright.request.newContext({baseURL:testBase});
 try{
  for(let i=0;i<5;i++){
   const r=await api(anon,'/api/login','POST',{username:target,password:`Wrong-Password-${i}-xyz`});
   expect(r.status).toBe(401);
  }
 }finally{await anon.dispose();}

 expect((await api(page.request,'/api/login','POST',{username:adminName,password})).status).toBe(200);
 await page.goto('/admin');

 // Receipt AI usage (Req 18.6): day and month rows with 0 requests and the configured limits.
 const usage=page.locator('#admin-ai-usage table.acct-usage');
 await expect(usage).toBeVisible();
 const rows=usage.locator('tbody tr');
 await expect(rows).toHaveCount(2);
 await expect(rows.nth(0).locator('th')).toHaveText('今天');
 await expect(rows.nth(1).locator('th')).toHaveText('本月');
 await expect(rows.nth(0).locator('td').nth(0)).toHaveText('0 / 100');
 await expect(rows.nth(1).locator('td').nth(0)).toHaveText('0 / 1000');
 for(const r of [0,1])for(const c of [1,2])await expect(rows.nth(r).locator('td').nth(c)).toHaveText('0');

 // Login security (Req 23.8, 23.10, 23.11).
 const section=page.locator('#admin-security');
 const banner=section.locator('.acct-alert-banner');
 await expect(banner).toBeVisible();
 const bannerCount=async()=>Number((await banner.textContent()).match(/有 (\d+) 則尚未確認的登入警示/)[1]);
 let open=await bannerCount();
 expect(open).toBeGreaterThanOrEqual(1);
 const ours=section.locator('li[data-alert-id]').filter({hasText:target});
 await expect(ours).toHaveCount(1);
 await expect(ours).toContainText('15 分鐘內 5 次失敗登入');
 await expect(section.locator('.acct-audit li').filter({hasText:target}).filter({hasText:'帳號或密碼錯誤'})).toHaveCount(5);

 let navigations=0;page.on('framenavigated',f=>{if(f===page.mainFrame())navigations++;});
 await ours.getByRole('button',{name:'確認',exact:true}).click();
 await expect(ours).toHaveCount(0);
 open-=1;
 if(open>0)await expect(banner).toHaveText(`有 ${open} 則尚未確認的登入警示`);
 // Acknowledge any other open alert so the banner reaches 0 and disappears.
 while(open>0){
  await section.locator('li[data-alert-id] [data-action="acct-ack-alert"]').first().click();
  open-=1;
  if(open>0)await expect(banner).toHaveText(`有 ${open} 則尚未確認的登入警示`);
 }
 await expect(banner).toHaveCount(0);
 await expect(section.locator('li[data-alert-id]')).toHaveCount(0);
 expect(navigations,'acknowledging alerts reloaded the page').toBe(0);

 // Req 23.9: no banner when no unacknowledged alert exists, also after a fresh load.
 await page.reload();
 await expect(section.locator('h3',{hasText:'登入警示'})).toBeVisible();
 await expect(section.locator('.acct-alert-banner')).toHaveCount(0);
 const audit=await api(page.request,'/api/admin/audit');
 expect(JSON.stringify(audit.data)).toContain('security.alert.ack');
});

test('[TC-SEC-004] local planner import refuses a backup file over 1 MiB without changing the handbook',async({page})=>{
 await page.goto('/demo/#/trip');
 await expect(page.locator('#trip-title')).toBeVisible();
 const before=await page.evaluate(key=>localStorage.getItem(key),STORAGE_KEY);
 expect(before).not.toBeNull();
 await page.getByRole('button',{name:'旅行選單',exact:true}).click();
 await page.locator('#trip-menu [data-action="import"]').click();
 const form=page.locator('#import-form');
 await expect(form).toBeVisible();
 // 1 MiB + 1 byte of spaces: if the file were read, JSON.parse would fail with a different message.
 await form.locator('input[name="backup"]').setInputFiles({name:'too-big.json',mimeType:'application/json',buffer:Buffer.alloc(1_048_577,0x20)});
 await form.getByRole('button',{name:'匯入並取代',exact:true}).click();
 await expect(form.locator('.form-error')).toHaveText('請選擇不超過 1 MiB 的備份檔。');
 await expect(form).toBeVisible();
 expect(await page.evaluate(key=>localStorage.getItem(key),STORAGE_KEY)).toBe(before);
});
