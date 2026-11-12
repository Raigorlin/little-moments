import {test,expect} from './local-planner-fixture.js';
import {seed,STORAGE_KEY,THEMES_KEY} from '../src/model.js';
import {withRegistrationLock} from './support/registration-lock.js';
const base=process.env.CAMPING_BASE_URL;
const slogan='把平凡的日子，留成喜歡的回憶。';
async function api(page,path,method='GET',body){
 const response=await page.request.fetch(base+path,{method,data:body,headers:body?{Origin:base,'Content-Type':'application/json'}:{}});
 expect(response.ok(),await response.text()).toBe(true);return response.json();
}
async function admin(page){await api(page,'/api/login','POST',{username:'qa-admin',password:'Local-Only-Test-Pass-2026'});}
async function brand(page,href){
 const link=page.getByRole('link',{name:'日子拾光首頁',exact:true});
 await expect(link).toBeVisible();await expect(link).toHaveAttribute('href',href);
 await expect(link).toContainText('日子拾光');await expect(link.locator('small')).toHaveText('LITTLE MOMENTS');
 // 帳號頁（登入、首頁、管理後台、邀請）的頁尾已改為 acct-footer 標語與畫面偏好，不再重複品牌名稱
 // （TC-AUTH-001 驗證其標語）；規劃與示範頁的頁尾仍顯示品牌。
 const footer=page.locator('footer');await expect(footer).toHaveCount(1);
 if(await footer.evaluate(el=>el.classList.contains('acct-footer')))await expect(footer.locator('.acct-footer-note')).toContainText('把日常摺進行囊');
 else await expect(footer).toContainText('日子拾光');
 await expect(page.getByRole('banner')).not.toContainText('好好露營');
 await expect(page.locator('footer')).not.toContainText('好好露營');
 await expect(page).toHaveTitle(/日子拾光$/);
}
test.beforeEach(async({baseURL})=>expect(new URL(baseURL).port).toBe('5181'));

test('[TC-BRAND-001] public login and registration use the new brand',async({page},testInfo)=>{
 // /register depends on the public Registration_Policy, which TC-ADMIN-004 closes for a while.
 await withRegistrationLock(testInfo,async()=>{
  for(const [path,title] of [['/login','登入 · 日子拾光'],['/register','註冊旅伴帳號 · 日子拾光']]){
   await page.goto(path);await brand(page,'/login');await expect(page).toHaveTitle(title);
  }
 });
 await page.goto('/login');await expect(page.getByRole('heading',{name:'登入日子拾光',exact:true})).toBeVisible();
 await expect(page.locator('meta[name="description"]')).toHaveAttribute('content',`日子拾光 LITTLE MOMENTS：${slogan}旅行規劃與回憶收藏的本機應用。`);
});

test('home, admin, trip, departure and invitation keep consistent branding without rewriting trip data',async({page})=>{
 await admin(page);const state=seed();state.trip.title='好好露營：原本的回憶';
 const {trip}=await api(page,'/api/trips','POST',{legacyState:state});
 const invite=await api(page,`/api/trips/${trip.id}/invites`,'POST',{});
 const before=await api(page,`/api/trips/${trip.id}`);
 for(const path of ['/qa-admin/home','/admin',`/qa-admin/trips/${trip.id}`,`/qa-admin/trips/${trip.id}/go`,invite.urlPath]){
  await page.goto(path);await brand(page,'/qa-admin/home');
  if(path==='/qa-admin/home'){
   await expect(page.locator('.acct-hero')).toContainText(slogan);
   await expect(page.locator('.acct-url')).toHaveCount(0);
  }
  if(path.endsWith('/go'))await expect(page).toHaveTitle(`${state.trip.title} · 行前清單 · 日子拾光`);
 }
 expect(await api(page,`/api/trips/${trip.id}`)).toEqual(before);
 expect(await page.evaluate(key=>localStorage.getItem(key),STORAGE_KEY)).toBeNull();
});

test('demo routes retain browser data and original-site attribution while changing the visible brand',async({page})=>{
 await page.goto('/demo/#/trip');await brand(page,'#/home');
 const before=await page.evaluate(key=>localStorage.getItem(key),STORAGE_KEY);
 for(const route of ['home','privacy','invite','go','trip']){
  await page.goto(`/demo/#/${route}`);await brand(page,'#/home');
  if(route==='privacy')await expect(page.locator('main')).toContainText('不代表「好好露營」網站或其營運者');
 }
 expect(await page.evaluate(key=>localStorage.getItem(key),STORAGE_KEY)).toBe(before);
});

test('new brand fits home and trip headers from phone to desktop in both themes',async({page})=>{
 await admin(page);const {trip}=await api(page,'/api/trips','POST',{legacyState:seed()});
 await page.goto('/qa-admin/home');
 for(const theme of ['light','dark']){
  await page.evaluate(({key,theme})=>localStorage.setItem(key,theme),{key:THEMES_KEY,theme});
  for(const width of [320,390,768,1440]){
   await page.setViewportSize({width,height:950});
   for(const path of ['/qa-admin/home',`/qa-admin/trips/${trip.id}`]){
    await page.goto(path);await brand(page,'/qa-admin/home');
    await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
   }
  }
 }
});
