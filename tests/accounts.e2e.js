import {test,expect} from './local-planner-fixture.js';
import {STORAGE_KEY} from '../src/model.js';
const testBase=process.env.CAMPING_BASE_URL;
const password='Local-Only-Test-Pass-2026';
const adminName='qa-admin';
let serial=0;
const slug=()=>`qa-${Date.now().toString(36)}-${++serial}-${Math.random().toString(36).slice(2,6)}`;
const fields={title:'山間週末測試',destination:'松林營地',startDate:'2026-10-02',endDate:'2026-10-04',description:'好好吃飯，慢慢露營。',note:'帶保暖衣物',coverKind:'camp',status:'completed'};
async function api(page,path,method='GET',body){const res=await page.request.fetch(testBase+path,{method,headers:body?{'Content-Type':'application/json','Origin':testBase}:{},data:body});return {status:res.status(),data:await res.json()};}
async function member(page){const username=slug();const r=await api(page,'/api/register','POST',{username,displayName:'測試露友',password});expect(r.status).toBeLessThan(300);return r.data.user;}
async function administrator(page){const r=await api(page,'/api/login','POST',{username:adminName,password});expect(r.status).toBe(200);return r.data.user;}
async function createTrip(page,extra={}){const r=await api(page,'/api/trips','POST',{...fields,...extra});expect(r.status).toBeLessThan(300);return r.data.trip;}
async function detail(page,id){return (await api(page,`/api/trips/${id}`)).data;}
const nav=(page,tab)=>page.locator(`.section-tabs [data-tab="${tab}"]`).click();
const openTripMenu=page=>page.getByRole('button',{name:'旅行選單',exact:true}).click();
// Cover Choice_Cards wrap a visually hidden radio; pick by clicking the visible card, as a user does.
const pickCover=async(scope,name)=>{await scope.locator('.acct-cover-option').filter({has:scope.page().getByRole('radio',{name,exact:true})}).click();await expect(scope.getByRole('radio',{name,exact:true})).toBeChecked();};
const saved=page=>expect(page.locator('.sync-status')).toContainText('已儲存至本機伺服器');

test.beforeAll(async({browser,baseURL})=>{
 if(!baseURL||new URL(baseURL).port!=='5181')throw new Error('Account browser tests must use the isolated test server on port 5181.');
 const page=await browser.newPage();
 const session=await api(page,'/api/session');
 if(session.data.needsSetup){const r=await api(page,'/api/setup','POST',{username:adminName,displayName:'測試管理員',password});expect([200,201,409]).toContain(r.status);}
 await page.close();
});

test('account home clean URL, multiple cards, edit history and no demo storage writes',async({page})=>{
 const user=await member(page);await page.goto(`/${user.username}/home`);await expect(page.getByRole('heading',{name:/旅行|故事|露營/}).first()).toBeVisible();
 await expect(page.getByText('你的首頁網址：',{exact:false})).toHaveCount(0);await expect(page.locator('.acct-url')).toHaveCount(0);
 await expect(page.getByRole('link',{name:'日子拾光首頁',exact:true})).toHaveAttribute('href',`/${user.username}/home`);
 expect(await page.evaluate(key=>localStorage.getItem(key),STORAGE_KEY)).toBeNull();
 await page.locator('[data-action="acct-new-trip"]').first().click();const form=page.locator('#dialog form');
 await form.locator('[name="trip-title"]').fill('第一次，松林露營');await form.locator('[name="trip-destination"]').fill('松林營地');await form.locator('[name="trip-start"]').fill('2026-10-02');await form.locator('[name="trip-end"]').fill('2026-10-04');await form.locator('[name="trip-status"]').selectOption('completed');await form.locator('button[type="submit"]').click();
 await expect(page.locator('#dialog')).not.toBeVisible();await expect(page.getByRole('heading',{name:'第一次，松林露營',exact:true})).toBeVisible();
 const trips=(await api(page,'/api/trips')).data.trips;expect(trips).toHaveLength(1);const trip=trips[0];
 await page.locator(`[data-action="acct-edit-trip"][data-id="${trip.id}"]:not(.swipe-action)`).click();await page.locator('#dialog [name="trip-title"]').fill('松林裡的回憶');await page.locator('#dialog button[type="submit"]').click();await expect(page.getByRole('heading',{name:'松林裡的回憶',exact:true})).toBeVisible();
 await createTrip(page,{title:'下一趟海邊',status:'planning'});await page.reload();await expect(page.getByRole('heading',{name:'下一趟海邊',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'松林裡的回憶',exact:true})).toBeVisible();
});

test('cover illustrations show previews and persist a newly selected scene',async({page})=>{
 const user=await member(page);await page.goto(`/${user.username}/home`);await page.locator('[data-action="acct-new-trip"]').first().click();
 const form=page.locator('#dialog form'),covers=form.locator('.acct-cover-option');
 await expect(covers).toHaveCount(7);await expect(covers.locator('svg')).toHaveCount(7);
 await pickCover(form,'海邊假期');await form.locator('[name="trip-title"]').fill('海邊小旅行');await form.locator('[name="trip-start"]').fill('2026-10-02');await form.locator('[name="trip-end"]').fill('2026-10-03');await form.locator('button[type="submit"]').click();await expect(page.locator('#dialog')).not.toBeVisible();
 const trip=(await api(page,'/api/trips')).data.trips.find(item=>item.title==='海邊小旅行');expect(trip.coverKind).toBe('beach');await expect(page.locator(`[data-trip-id="${trip.id}"] .acct-trip-art svg`)).toHaveClass(/illustration--beach/);
 await page.locator(`[data-action="acct-edit-trip"][data-id="${trip.id}"]:not(.swipe-action)`).click();await pickCover(page.locator('#dialog'),'日出山嵐');await page.locator('#dialog button[type="submit"]').click();await expect(page.locator('#dialog')).not.toBeVisible();
 expect((await api(page,`/api/trips/${trip.id}`)).data.trip.coverKind).toBe('sunrise');
});

test('owner recipe template saves isolated server state and shopping with inline assignment selector',async({page})=>{
 const user=await member(page),trip=await createTrip(page);await page.goto(`/${user.username}/trips/${trip.id}`);await nav(page,'meals');await page.getByRole('button',{name:'新增餐次',exact:true}).click();
 await page.getByLabel('常用料理範本',{exact:true}).selectOption('curry');await page.getByRole('button',{name:'套用範本',exact:true}).click();await page.locator('#edit-form button[type="submit"]').click();await saved(page);
 const d=await detail(page,trip.id);expect(d.state.meals).toHaveLength(1);expect(d.state.shopping.some(s=>s.name==='咖哩塊')).toBe(true);
 await nav(page,'shopping');await expect(page.locator('[data-shopping-assignee]').first()).toHaveValue('');await page.reload();await nav(page,'meals');await expect(page.getByRole('heading',{name:'野炊雞肉咖哩飯',exact:true})).toBeVisible();expect(await page.evaluate(key=>localStorage.getItem(key),STORAGE_KEY)).toBeNull();
});

test('two accounts cannot view each others home or trip or call admin APIs',async({page,context})=>{
 const owner=await member(page),trip=await createTrip(page,{title:'私人的山林回憶'});const other=await context.browser().newContext({baseURL:testBase});try{const p=await other.newPage();const stranger=await member(p);await p.goto(`/${owner.username}/home`);await expect(p.getByRole('heading',{name:'私人的山林回憶'})).toHaveCount(0);expect((await api(p,`/api/trips/${trip.id}`)).status).toBeGreaterThanOrEqual(400);expect((await api(p,`/api/trips/${trip.id}`,'PATCH',{revision:0,title:'入侵'})).status).toBeGreaterThanOrEqual(400);expect((await api(p,'/api/admin/users')).status).toBe(403);await p.goto(`/${stranger.username}/home`);await expect(p.getByRole('heading',{name:'私人的山林回憶'})).toHaveCount(0);}finally{await other.close();}
});

test('invited guest edits shared content but cannot delete trip or remove items',async({page,browser})=>{
 const owner=await member(page),trip=await createTrip(page);const invite=(await api(page,`/api/trips/${trip.id}/invites`,'POST',{})).data;
 const other=await browser.newContext({baseURL:testBase});try{
  const p=await other.newPage();const guest=await member(p);await p.goto(invite.urlPath);await p.locator('form [name="join-name"]').fill('米米');await p.locator('form [name="join-role"]').fill('採買擔當');await p.locator('form button[type="submit"]').click();await expect(p).toHaveURL(new RegExp(`/${guest.username}/trips/`));
  let d=await detail(page,trip.id);const person=d.state.people.find(x=>x.name==='米米');d.state.shopping.push({id:'shop-mimi',name:'飲用水',quantity:'2瓶',category:'飲料',assignee:person.id,done:false});expect((await api(page,`/api/trips/${trip.id}`,'PUT',{revision:d.trip.revision,state:d.state})).status).toBe(200);
  await p.reload();await nav(p,'shopping');await expect(p.getByRole('button',{name:'新增品項',exact:true})).toBeVisible();await expect(p.locator('[data-shopping-assignee]')).toBeEnabled();await expect(p.getByRole('button',{name:'邀請旅伴',exact:true})).toBeVisible();
  await p.getByRole('button',{name:'編輯 飲用水',exact:true}).click();await expect(p.getByRole('button',{name:'移除項目',exact:true})).toHaveCount(0);await p.getByLabel('數量與單位',{exact:true}).fill('3瓶');await p.locator('#edit-form button[type=submit]').click();await saved(p);
  expect((await detail(page,trip.id)).state.shopping[0].quantity).toBe('3瓶');await p.getByRole('checkbox',{name:'飲用水已買齊',exact:true}).check();await saved(p);
  d=await detail(p,trip.id);expect(d.permissions.canEdit).toBe(true);expect(d.permissions.canDelete).toBe(false);expect(d.permissions.canInvite).toBe(true);
  for(const path of [`/api/trips/${trip.id}/delete`,`/api/admin/trips/${trip.id}/delete`])expect((await api(p,path,'POST',{expectedUserId:guest.id,revision:d.trip.revision,confirmTitle:d.trip.title,canDelete:true})).status).toBe(403);
  expect((await api(p,`/api/trips/${trip.id}/invites`,'POST',{expectedUserId:guest.id})).status).toBe(201);
  const removed=structuredClone(d.state);removed.shopping=[];expect((await api(p,`/api/trips/${trip.id}`,'PUT',{expectedUserId:guest.id,revision:d.trip.revision,state:removed})).status).toBe(403);
  await p.goto(`/${guest.username}/home`);await expect(p.locator(`[data-action=acct-edit-trip][data-id="${trip.id}"]:not(.swipe-action)`)).toBeVisible();await expect(p.locator('[data-action=acct-delete-trip]')).toHaveCount(0);
  await page.goto(`/${owner.username}/home`);await expect(page.locator(`[data-action=acct-delete-trip][data-id="${trip.id}"]:not(.swipe-action)`)).toBeVisible();
  await page.locator(`[data-action=acct-delete-trip][data-id="${trip.id}"]:not(.swipe-action)`).click();await page.getByLabel('輸入旅行名稱以確認',{exact:true}).fill(trip.title);await page.getByRole('button',{name:'確認刪除旅行',exact:true}).click();await expect(page.locator('#dialog')).not.toBeVisible();
  expect((await api(p,`/api/trips/${trip.id}`)).status).toBe(404);await p.reload();await expect(p.locator(`[data-trip-id="${trip.id}"]`)).toHaveCount(0);
 }finally{await other.close();}
});

test('trip menu for a non-owner member hides vehicle delete, import and reset',async({page,browser})=>{
 await member(page);const trip=await createTrip(page);let d=await detail(page,trip.id);
 d.state.vehicles.push({id:'veh-menu',name:'選單測試車',driver:'',seats:5,passengers:[],meeting:'14:00 · 台北車站'});
 expect((await api(page,`/api/trips/${trip.id}`,'PUT',{revision:d.trip.revision,state:d.state})).status).toBe(200);
 const invite=(await api(page,`/api/trips/${trip.id}/invites`,'POST',{})).data;
 const other=await browser.newContext({baseURL:testBase});try{
  const p=await other.newPage();const guest=await member(p);await p.goto(invite.urlPath);await p.locator('form [name="join-name"]').fill('小樹');await p.locator('form [name="join-role"]').fill('採買擔當');await p.locator('form button[type="submit"]').click();await expect(p).toHaveURL(new RegExp(`/${guest.username}/trips/`));
  expect((await detail(p,trip.id)).permissions.canDelete).toBe(false);
  await openTripMenu(p);const menu=p.locator('#trip-menu');await expect(menu).toBeVisible();
  await expect(menu.locator('.vehicle-card h3')).toHaveText(['選單測試車']);await expect(menu.getByRole('button',{name:'編輯 選單測試車',exact:true})).toBeVisible();
  await expect(menu.locator('[data-action="delete"][data-kind="vehicle"]')).toHaveCount(0);
  await expect(menu.locator('[data-action="import"]')).toHaveCount(0);await expect(menu.locator('.reset-area')).toHaveCount(0);await expect(menu.locator('[data-action="reset"]')).toHaveCount(0);
  await expect(menu.locator('.data-tools [data-action="export"]')).toBeVisible();await expect(menu.locator('.data-tools [data-action="print"]')).toBeVisible();
 }finally{await other.close();}
});

test('admin edits another owner trip and disables account without deleting travel history',async({page,browser})=>{
 const user=await member(page),trip=await createTrip(page,{title:'要保留的露營歷史'});const adminContext=await browser.newContext({baseURL:testBase});try{const p=await adminContext.newPage();await administrator(p);await p.goto('/admin');await expect(p.locator('body')).toContainText(user.username);
 await p.goto(`/${adminName}/trips/${trip.id}`);await openTripMenu(p);await p.getByRole('button',{name:'編輯旅行',exact:true}).click();await p.getByLabel('旅行名稱',{exact:true}).fill('管理員修正的歷史');await p.locator('#edit-form button[type="submit"]').click();await saved(p);
 await p.goto('/admin');await p.locator(`[data-action="acct-delete-user"][data-id="${user.id}"]:not(.swipe-action)`).click();await p.locator('#dialog input[name="delete-confirm"]').fill(user.username);await p.locator('#dialog button[type="submit"]').click();await expect(p.locator('#dialog')).not.toBeVisible();expect((await api(page,'/api/trips')).status).toBe(401);
 const d=await detail(p,trip.id);expect(d.trip.title).toBe('管理員修正的歷史');expect(d.trip.ownerUsername).toBe(adminName);expect(d.state.people.every(x=>x.id!==user.id)).toBe(true);
 await p.goto('/admin');await expect(p.locator('body')).toContainText(user.username);expect((await api(p,`/api/admin/users/${(await api(p,'/api/session')).data.user.id}/delete`,'POST',{confirmUsername:adminName})).status).toBeGreaterThanOrEqual(400);
 }finally{await adminContext.close();}
});

test('stale revisions preserve unsaved planner edits instead of overwriting newer data',async({page})=>{
 const user=await member(page),trip=await createTrip(page);await page.goto(`/${user.username}/trips/${trip.id}`);await openTripMenu(page);await page.getByRole('button',{name:'編輯旅行',exact:true}).click();await page.getByLabel('旅行名稱',{exact:true}).fill('這份草稿要保留');
 expect((await api(page,`/api/trips/${trip.id}`,'PATCH',{revision:trip.revision,title:'其他分頁已存'})).status).toBe(200);await page.locator('#edit-form button[type="submit"]').click();await expect(page.locator('.save-warning')).toContainText('其他人已更新');expect((await detail(page,trip.id)).trip.title).toBe('其他分頁已存');await expect(page.locator('.hero h1')).toHaveText('這份草稿要保留');
 page.once('dialog',d=>d.accept());await page.locator('[data-action="account-reload"]').click();await expect(page.locator('.hero h1')).toHaveText('其他分頁已存');
});

test('protected API responses are absent from offline caches and logout revokes access',async({page,context})=>{
 const user=await member(page),trip=await createTrip(page);await page.goto(`/${user.username}/trips/${trip.id}`);await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
 const cached=await page.evaluate(async()=>{const result=[];for(const key of await caches.keys())for(const request of await(await caches.open(key)).keys())result.push(request.url);return result;});expect(cached.every(x=>!x.includes('/api/'))).toBe(true);
 await context.setOffline(true);await page.reload();await expect(page.locator('.hero h1')).toHaveCount(0);await context.setOffline(false);await page.goto(`/${user.username}/home`);await page.getByRole('button',{name:'登出',exact:true}).click();await expect(page).toHaveURL(/\/login/);expect((await api(page,`/api/trips/${trip.id}`)).status).toBe(401);
});

test('responsive home, admin and assignee selectors fit 320px through desktop',async({page})=>{
 const user=await member(page);await createTrip(page,{title:'山裡的風，回憶慢慢收好'});
 for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:950});await page.goto(`/${user.username}/home`);await expect(page.locator('.acct-url')).toHaveCount(0);await expect(page.locator('main')).not.toContainText('你的首頁網址');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);}
 await page.goto('/demo/#/trip');await nav(page,'shopping');await page.setViewportSize({width:390,height:900});const row=page.locator('.shopping-row').filter({has:page.getByRole('checkbox',{name:'甜椒、玉米已買齊',exact:true})});await expect(row.locator('[data-shopping-assignee] option:checked')).toHaveText('米米負責');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await administrator(page);await page.setViewportSize({width:320,height:950});await page.goto('/admin');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
