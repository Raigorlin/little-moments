import {test,expect} from '@playwright/test';
import {STORAGE_KEY,seed} from '../src/model.js';
const base=process.env.CAMPING_BASE_URL;
const password='Local-Only-Test-Pass-2026';
const card={title:'待刪除的旅行',destination:'森林營地',startDate:'2026-11-20',endDate:'2026-11-22',description:'',note:'',coverKind:'camp',status:'planning'};
const tile=(page,id)=>page.locator(`.acct-trip-card[data-trip-id="${id}"]`);
async function api(page,path,method='GET',body){return page.request.fetch(base+path,{method,data:body,headers:body?{Origin:base,'Content-Type':'application/json'}:{}});}
async function admin(page){const r=await api(page,'/api/login','POST',{username:'qa-admin',password});expect(r.status()).toBe(200);return (await r.json()).user;}
async function member(page){const username=`del-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;const r=await api(page,'/api/register','POST',{username,displayName:'露營旅伴',password});expect(r.ok()).toBe(true);return (await r.json()).user;}
async function create(page,title=card.title){const r=await api(page,'/api/trips','POST',{...card,title});expect(r.status()).toBe(201);return (await r.json()).trip;}
test.beforeEach(async({baseURL})=>{expect(new URL(baseURL).port).toBe('5181');});

test('home omits legacy and local notices without changing saved demo data',async({page})=>{
 const user=await admin(page);
 await page.goto(`/${user.username}/home`);
 await expect(page.locator('[data-action=acct-new-trip]')).toBeVisible();
 const raw=JSON.stringify(seed());await page.evaluate(({key,raw})=>localStorage.setItem(key,raw),{key:STORAGE_KEY,raw});await page.reload();
 await expect(page.locator('[data-action=acct-new-trip]')).toBeVisible();
 await expect(page.locator('.acct-legacy,.acct-local-note,[data-action=acct-import-legacy]')).toHaveCount(0);
 await expect(page.locator('body')).not.toContainText('在這個瀏覽器找到舊版旅行手冊');
 await expect(page.locator('body')).not.toContainText('這裡只列出你建立或加入的旅行');
 await expect(page.locator('body')).not.toContainText('本機多帳號版');
 await expect(page.locator('body')).not.toContainText('開啟舊版單機示範');
 await expect(page.locator('body')).not.toContainText('本機伺服器資料庫');
 await expect(page.locator('body')).not.toContainText('尚未公開部署');
 expect(await page.evaluate(key=>localStorage.getItem(key),STORAGE_KEY)).toBe(raw);
 await expect(page.locator('[data-action=acct-import-file]')).toBeHidden();
});

test('admin can cancel then confirm own trip deletion from home on phone and desktop',async({page})=>{
 const user=await admin(page),trip=await create(page,'要確認才刪除的旅行');
 await page.goto(`/${user.username}/home`);await expect(tile(page,trip.id)).toBeVisible();
 for(const width of [320,1440]){
  await page.setViewportSize({width,height:1000});await tile(page,trip.id).getByRole('button',{name:'刪除旅行',exact:true}).click();
  await expect(page.locator('#dialog')).toBeVisible();await expect(page.getByRole('button',{name:'確認刪除旅行',exact:true})).toBeDisabled();
  expect(await page.locator('#dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.screenshot({path:`previews/trip-delete-confirm-${width}.png`});
  await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.locator('#dialog')).not.toBeVisible();
 }
 expect((await api(page,`/api/trips/${trip.id}`)).status()).toBe(200);
 await tile(page,trip.id).getByRole('button',{name:'刪除旅行',exact:true}).click();
 await page.getByLabel('輸入旅行名稱以確認',{exact:true}).fill('錯誤名稱');await expect(page.getByRole('button',{name:'確認刪除旅行',exact:true})).toBeDisabled();
 await page.getByLabel('輸入旅行名稱以確認',{exact:true}).fill(trip.title);await page.getByRole('button',{name:'確認刪除旅行',exact:true}).click();
 await expect(page.locator('#dialog')).not.toBeVisible();await expect(tile(page,trip.id)).toHaveCount(0);expect((await api(page,`/api/trips/${trip.id}`)).status()).toBe(404);
 await page.reload();await expect(page.locator('[data-action=acct-new-trip]')).toBeVisible();await expect(tile(page,trip.id)).toHaveCount(0);
});

test('admin deletes another owner trip in backend, revokes link and leaves other trips and account intact',async({page,browser})=>{
 const owner=await member(page),trip=await create(page,'主揪的待刪卡片'),keep=await create(page,'要保留的另一趟');
 const link=await (await api(page,`/api/trips/${trip.id}/invites`,'POST',{})).json();
 await page.goto(`/${owner.username}/home`);await expect(tile(page,trip.id)).toBeVisible();await expect(tile(page,trip.id).locator('[data-action=acct-delete-trip]')).toBeVisible();
 expect((await api(page,`/api/admin/trips/${trip.id}/delete`,'POST',{expectedUserId:owner.id,revision:trip.revision,confirmTitle:trip.title})).status()).toBe(403);
 const ctx=await browser.newContext({baseURL:base});try{
  const p=await ctx.newPage();await admin(p);await p.goto('/admin');await tile(p,trip.id).getByRole('button',{name:'刪除旅行',exact:true}).click();
  await p.getByLabel('輸入旅行名稱以確認',{exact:true}).fill(trip.title);await p.getByRole('button',{name:'確認刪除旅行',exact:true}).click();await expect(p.locator('#dialog')).not.toBeVisible();await expect(tile(p,trip.id)).toHaveCount(0);
  await expect(tile(p,keep.id)).toBeVisible();await expect(p.locator('#admin-audit')).toContainText('trip.delete');
  expect((await api(page,`/api/trips/${trip.id}`)).status()).toBe(404);expect((await api(page,`/api/invites/${link.token}`)).status()).toBe(404);
  expect((await api(page,`/api/trips/${keep.id}`)).status()).toBe(200);
  expect((await (await api(page,'/api/session')).json()).user.id).toBe(owner.id);
  await page.reload();await expect(tile(page,keep.id)).toBeVisible();await expect(tile(page,trip.id)).toHaveCount(0);
 }finally{await ctx.close();}
});

test('stale revision and failed deletion keep card and show error instead of success',async({page})=>{
 const user=await admin(page),trip=await create(page,'刪除前已被修改');await page.goto(`/${user.username}/home`);
 await tile(page,trip.id).getByRole('button',{name:'刪除旅行',exact:true}).click();
 expect((await api(page,`/api/trips/${trip.id}`,'PATCH',{revision:trip.revision,note:'其他分頁剛更新'})).status()).toBe(200);
 await page.getByLabel('輸入旅行名稱以確認',{exact:true}).fill(trip.title);await page.getByRole('button',{name:'確認刪除旅行',exact:true}).click();
 await expect(page.locator('#dialog .form-error')).toContainText('尚未刪除');expect((await api(page,`/api/trips/${trip.id}`)).status()).toBe(200);
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'取消',exact:true}).click();await page.reload();
 await tile(page,trip.id).getByRole('button',{name:'刪除旅行',exact:true}).click();
 await page.route(`**/api/trips/${trip.id}/delete`,route=>route.abort('failed'));
 await page.getByLabel('輸入旅行名稱以確認',{exact:true}).fill(trip.title);await page.getByRole('button',{name:'確認刪除旅行',exact:true}).click();
 await expect(page.locator('#dialog .form-error')).toContainText('尚未刪除');await expect(page.locator('#dialog')).toBeVisible();expect((await api(page,`/api/trips/${trip.id}`)).status()).toBe(200);
});


test('home hides the JSON import entry but retains validated import for future use',async({page})=>{
 const user=await admin(page);await page.goto(`/${user.username}/home`);
 const writes=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/')&&!['GET','HEAD'].includes(r.method()))writes.push(r.method()+' '+new URL(r.url()).pathname);});
 const entry=page.locator('[data-action=acct-import-file]'),file=page.locator('[data-file-input]');
 await expect(entry).toHaveCount(1);await expect(file).toHaveCount(1);
 for(const theme of ['light','dark']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);for(const width of [320,390,1440]){
  await page.setViewportSize({width,height:950});await expect(entry).toBeHidden();await expect(file).toBeHidden();
  await expect(page.locator('[data-action=acct-new-trip]')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 }}
 await file.setInputFiles({name:'retained-import.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(seed()))});
 await expect(page.locator('#dialog')).toBeVisible();await expect(page.getByRole('button',{name:'確認匯入',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.locator('#dialog')).toBeHidden();
 expect(writes).toEqual([]);
 await file.setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{invalid')});
 await expect(page.locator('#toasts')).toContainText('不是有效的 JSON');await expect(page.locator('#dialog')).toBeHidden();
 expect(writes).toEqual([]);
});
