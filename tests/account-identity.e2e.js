import {test,expect} from './local-planner-fixture.js';
const base=process.env.CAMPING_BASE_URL,password='Session-Test-Pass-2026';
let serial=0;
const username=()=>`focus-${Date.now().toString(36)}-${++serial}`;
async function request(page,path,method='GET',body){const r=await page.request.fetch(base+path,{method,data:body,headers:body?{'Content-Type':'application/json',Origin:base}:{}});expect(r.status()).toBeLessThan(300);return r.json();}
async function register(page){const name=username();await request(page,'/api/register','POST',{username:name,displayName:name,password});return name;}
test('account home removes stale owner data when a second tab logs out',async({browser,baseURL})=>{
 test.skip(new URL(baseURL).port!=='5181');
 const context=await browser.newContext({baseURL});const tab=await context.newPage(), other=await context.newPage();try{const name=await register(tab);await request(tab,'/api/trips','POST',{title:'私人的露營',startDate:'2026-11-18',endDate:'2026-11-19',destination:'秘密山谷',description:'',note:'',status:'planning',coverKind:'camp'});await tab.goto(`/${name}/home`);await expect(tab.getByText('私人的露營',{exact:true})).toBeVisible();await other.goto(`/${name}/home`);await other.getByRole('button',{name:'登出',exact:true}).click();await expect(other).toHaveURL(/\/login/);await tab.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(tab.getByText('私人的露營',{exact:true})).toHaveCount(0);await expect(tab).toHaveURL(/\/login/);}finally{await context.close();}
});
test('planner hides stale trip when another tab switches accounts without an open draft',async({browser,baseURL})=>{
 test.skip(new URL(baseURL).port!=='5181');const context=await browser.newContext({baseURL}),tab=await context.newPage(),other=await context.newPage();try{const name=await register(tab),trip=(await request(tab,'/api/trips','POST',{title:'只給原帳號看',startDate:'2026-11-18',endDate:'2026-11-19',destination:'秘密山谷',description:'',note:'',status:'planning',coverKind:'camp'})).trip;await tab.goto(`/${name}/trips/${trip.id}`);await expect(tab.getByRole('heading',{name:'只給原帳號看',exact:true})).toBeVisible();await other.goto(`/${name}/home`);await other.getByRole('button',{name:'登出',exact:true}).click();await register(other);await tab.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(tab.getByRole('heading',{name:'只給原帳號看',exact:true})).toHaveCount(0);}finally{await context.close();}
});

test('dirty owner draft cannot be retried after switching to an admin account',async({browser,baseURL})=>{
 test.skip(new URL(baseURL).port!=='5181');const context=await browser.newContext({baseURL}),tab=await context.newPage(),other=await context.newPage();try{
 const name=await register(tab),trip=(await request(tab,'/api/trips','POST',{title:'原帳號的旅行',startDate:'2026-11-18',endDate:'2026-11-19',destination:'山谷',description:'',note:'',status:'planning',coverKind:'camp'})).trip;
 await tab.goto(`/${name}/trips/${trip.id}`);await tab.locator('.section-tabs [data-tab=\"settings\"]').click();await tab.getByRole('button',{name:'編輯旅行',exact:true}).click();await tab.getByLabel('旅行名稱',{exact:true}).fill('原帳號尚未儲存的草稿');
 await other.goto(`/${name}/home`);await other.getByRole('button',{name:'登出',exact:true}).click();await expect(other).toHaveURL(/\/login/);const login=await other.request.post(`${base}/api/login`,{data:{username:'qa-admin',password:'Local-Only-Test-Pass-2026'},headers:{Origin:base,'Content-Type':'application/json'}});expect(login.status()).toBe(200);
 await tab.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(tab.locator('.save-warning')).toContainText('登入帳號已在其他分頁變更');tab.once('dialog',d=>d.accept());await tab.locator('#edit-form [data-action=close-dialog]').click();await tab.locator('[data-action=account-retry]').click();await expect(tab.locator('.save-warning')).toContainText('不能由另一個帳號儲存');
 const response=await other.request.get(`${base}/api/trips/${trip.id}`);expect(response.status()).toBe(200);expect((await response.json()).trip.title).toBe('原帳號的旅行');
 }finally{await context.close();}
});
