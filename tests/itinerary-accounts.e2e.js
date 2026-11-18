import {test,expect} from './local-planner-fixture.js';
import {STORAGE_KEY} from '../src/model.js';
import {poolMember} from './support/e2e-pool.js';
import {exampleTrip} from './fixtures/example-trip.js';
// 帳號版規劃行程的瀏覽器測試（需求 3.11、10.5、10.7、21.2、21.6、21.7、21.10、23.7、23.8）。Viewer 由 [TC-ITIN-004]（任務 11.20）加入。
const testBase=process.env.CAMPING_BASE_URL;
const password='Local-Only-Test-Pass-2026';
const adminName='qa-admin';
const member=page=>poolMember(page,testBase);
async function api(page,path,method='GET',body){const res=await page.request.fetch(testBase+path,{method,headers:body?{'Content-Type':'application/json','Origin':testBase}:{},data:body});return {status:res.status(),data:await res.json()};}
const detail=async(page,id)=>(await api(page,`/api/trips/${id}`)).data;
const saved=page=>expect(page.locator('.sync-status')).toContainText('已儲存至本機伺服器');
const ROUTE_ID='rt-1-v1',ROUTE_TOGGLE=`[data-plan-toggle="route:${ROUTE_ID}"]`;
const card=page=>page.locator('form[data-plan-card]');
const openTripMenu=page=>page.getByRole('button',{name:'旅行選單',exact:true}).click();
async function createTrip(page){
 const r=await api(page,'/api/trips','POST',{legacyState:exampleTrip()});expect(r.status).toBeLessThan(300);
 const d=await detail(page,r.data.trip.id);expect(d.state.routes.some(route=>route.id===ROUTE_ID),'Example_Trip routes are stored with the trip').toBe(true);
 return d.trip;
}
async function openPlanner(page,path){
 await page.goto(path);await expect(page.locator('.hero')).toBeVisible();
 await page.getByRole('button',{name:'規劃行程',exact:true}).click();
 await expect(page.locator('.plan-routes-list')).toBeVisible();
}
async function joinAsCollaborator(browser,owner,trip,name){
 const invite=(await api(owner,`/api/trips/${trip.id}/invites`,'POST',{})).data;
 const context=await browser.newContext({baseURL:testBase});const p=await context.newPage();const guest=await member(p);
 await p.goto(invite.urlPath);await p.locator('form [name="join-name"]').fill(name);await p.locator('form [name="join-role"]').fill('協作旅伴');await p.locator('form button[type="submit"]').click();
 await expect(p).toHaveURL(new RegExp(`/${guest.username}/trips/`));
 return {context,page:p,guest,path:`/${guest.username}/trips/${trip.id}`};
}

test.beforeAll(async({browser,baseURL})=>{
 if(!baseURL||new URL(baseURL).port!=='5181')throw new Error('Account browser tests must use the isolated test server on port 5181.');
 const page=await browser.newPage();
 const session=await api(page,'/api/session');
 if(session.data.needsSetup){const r=await api(page,'/api/setup','POST',{username:adminName,displayName:'測試管理員',password});expect([200,201,409]).toContain(r.status);}
 await page.close();
});

test('[TC-ITIN-001] route save after another request updated the trip keeps the draft and screen, shows the conflict prompt and never overwrites server data @critical',async({page})=>{
 const user=await member(page),trip=await createTrip(page);
 await openPlanner(page,`/${user.username}/trips/${trip.id}`);
 await page.locator(ROUTE_TOGGLE).click();await expect(card(page)).toBeVisible();
 const time=page.getByLabel('幾點出發',{exact:true});await expect(time).toHaveValue('08:00');await time.fill('07:45');
 // 另一個請求先更新同一趟旅行（改第 2 天標題），伺服器的 revision 因此前進。
 const before=await detail(page,trip.id);const remote=structuredClone(before.state);
 remote.daySettings.find(setting=>setting.date==='2026-10-21').title='別人先改的標題';
 expect((await api(page,`/api/trips/${trip.id}`,'PUT',{revision:before.trip.revision,state:remote})).status).toBe(200);
 await card(page).getByRole('button',{name:'儲存',exact:true}).click();
 await expect(page.locator('.save-warning')).toContainText('其他人已更新');
 // Draft 與畫面保留：卡片仍展開，時間欄位仍是送出的值。
 await expect(card(page)).toBeVisible();await expect(page.getByLabel('幾點出發',{exact:true})).toHaveValue('07:45');
 // 伺服器資料沒有被覆寫：路線時間不變、別人的修改還在、revision 沒有因這次儲存前進。
 const after=await detail(page,trip.id);
 expect(after.state.routes.find(route=>route.id===ROUTE_ID).time).toBe('08:00');
 expect(after.state.daySettings.find(setting=>setting.date==='2026-10-21').title).toBe('別人先改的標題');
 expect(after.trip.revision).toBe(before.trip.revision+1);
 expect(await page.evaluate(key=>localStorage.getItem(key),STORAGE_KEY)).toBeNull();
});

test('[TC-ITIN-002] Trip_Manager and Collaborator see the planner controls they may use, and Collaborator has no vehicle delete control in Vehicle_Dialog or Trip_Menu',async({page,browser})=>{
 const owner=await member(page),trip=await createTrip(page);
 // Trip_Manager：看得到規劃行程控制項，也看得到刪除車輛。
 await openPlanner(page,`/${owner.username}/trips/${trip.id}`);
 await expect(page.locator('.plan-view-switch')).toBeVisible();
 await page.locator(ROUTE_TOGGLE).click();await expect(card(page).getByRole('button',{name:'刪除這條路線',exact:true})).toBeVisible();await expect(card(page).getByRole('button',{name:'儲存',exact:true})).toBeVisible();
 await page.locator('[data-plan-toggle="places"]').click();
 await expect(page.getByRole('button',{name:'新增車輛',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'編輯 第一車',exact:true}).click();await expect(page.locator('#dialog').getByRole('button',{name:'移除項目',exact:true})).toHaveCount(1);
 await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.locator('#dialog')).not.toBeVisible();
 await openTripMenu(page);await expect(page.locator('#trip-menu [data-action="delete"][data-kind="vehicle"]')).not.toHaveCount(0);
 await expect(page.locator('.sync-status')).toContainText('建立者／管理員模式');
 // Collaborator：同樣的規劃控制項，但沒有任何刪除車輛的控制項。
 const guest=await joinAsCollaborator(browser,page,trip,'小樹');
 try{
  const p=guest.page;await openPlanner(p,guest.path);
  await expect(p.locator('.plan-view-switch')).toBeVisible();
  await p.locator(ROUTE_TOGGLE).click();await expect(card(p).getByRole('button',{name:'刪除這條路線',exact:true})).toBeVisible();await expect(card(p).getByRole('button',{name:'儲存',exact:true})).toBeVisible();
  await p.locator('[data-plan-toggle="places"]').click();
  await expect(p.getByRole('button',{name:'新增車輛',exact:true})).toBeVisible();
  const editVehicle=p.getByRole('button',{name:'編輯 第一車',exact:true});await expect(editVehicle).toBeVisible();await editVehicle.click();
  await expect(p.locator('#dialog')).toBeVisible();await expect(p.locator('#dialog').getByRole('button',{name:'移除項目',exact:true})).toHaveCount(0);await expect(p.locator('#dialog [data-action="delete"][data-kind="vehicle"]')).toHaveCount(0);
  await p.getByRole('button',{name:'取消',exact:true}).click();await expect(p.locator('#dialog')).not.toBeVisible();
  await openTripMenu(p);const menu=p.locator('#trip-menu');await expect(menu).toBeVisible();
  await expect(menu.locator('.vehicle-card h3')).toHaveCount(4);await expect(menu.locator('[data-action="delete"][data-kind="vehicle"]')).toHaveCount(0);
 }finally{await guest.context.close();}
});

test('[TC-ITIN-003] Collaborator deleting a saved Route persists after reload and the sync status names the Collaborator mode',async({page,browser})=>{
 const owner=await member(page),trip=await createTrip(page);
 const guest=await joinAsCollaborator(browser,page,trip,'小橘');
 try{
  const p=guest.page;await openPlanner(p,guest.path);
  await expect(p.locator('.sync-status')).toContainText('協作編輯模式，不能刪除旅伴、料理、採買品項、裝備與車輛');
  await expect(p.locator(`.plan-route[data-id="${ROUTE_ID}"]`)).toBeVisible();
  await p.locator(ROUTE_TOGGLE).click();await card(p).getByRole('button',{name:'刪除這條路線',exact:true}).click();
  await expect(p.locator('#dialog')).toBeVisible();await p.getByRole('button',{name:'確認移除',exact:true}).click();
  await expect(p.locator('#dialog')).not.toBeVisible();await saved(p);
  await expect(p.locator('.sync-status')).toContainText('協作編輯模式');
  await expect(p.locator(`.plan-route[data-id="${ROUTE_ID}"]`)).toHaveCount(0);
  const d=await detail(page,trip.id);expect(d.state.routes.some(route=>route.id===ROUTE_ID)).toBe(false);expect(d.state.routes).toHaveLength(7);
  await openPlanner(p,guest.path);await expect(p.locator('.plan-routes-list')).toBeVisible();
  await expect(p.locator(`.plan-route[data-id="${ROUTE_ID}"]`)).toHaveCount(0);await expect(p.locator('.plan-route[data-id="rt-1-v2"]')).toBeVisible();
 }finally{await guest.context.close();}
});

// App 不會建立 canEdit=false 的帳號，所以由攔截 GET /api/trips/:id 把 permissions 改成 Viewer 的樣子（需求 1.5、21.1、23.8）。
test('[TC-ITIN-004] Viewer (permissions.canEdit and canDelete forced to false) sees only the poster: no View_Switch or edit controls, but can open the Text_Panel, copy text and use the Motion_Toggle @critical',async({page,context})=>{
 await context.grantPermissions(['clipboard-read','clipboard-write']);
 await page.addInitScript(()=>{const clip=navigator.clipboard,write=clip.writeText.bind(clip);window.__written=[];clip.writeText=text=>{window.__written.push(text);return write(text);};});
 const user=await member(page),trip=await createTrip(page);
 let intercepted=0;
 // glob 只比對 /api/trips/<id> 本身，不影響子路徑；只改 GET 回應，其餘請求照常送出。
 await page.route(`**/api/trips/${trip.id}`,async route=>{
  if(route.request().method()!=='GET')return route.continue();
  const res=await route.fetch();const body=await res.json();
  body.permissions={...body.permissions,canEdit:false,canDelete:false};intercepted++;
  await route.fulfill({response:res,json:body});
 });
 await page.goto(`/${user.username}/trips/${trip.id}`);await expect(page.locator('.hero')).toBeVisible();
 await expect(page.locator('.itinerary-poster')).toBeVisible();expect(intercepted).toBeGreaterThan(0);
 // 沒有 View_Switch、規劃行程、開始規劃，也沒有 Itinerary_Editor 的任何元件。
 await expect(page.locator('.plan-view-switch')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'規劃行程',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'開始規劃',exact:true})).toHaveCount(0);
 await expect(page.locator('[data-plan-nav],[data-plan-toggle],.plan-routes-list,form[data-plan-card]')).toHaveCount(0);
 // 行程圖內沒有新增、修改、刪除或勾選完成的控制項：按鈕只剩文字版的展開、複製與動畫開關，也沒有核取方塊。
 const poster=page.locator('.itinerary-poster');
 await expect(poster.locator('input,select,textarea,[role="checkbox"]')).toHaveCount(0);
 await expect(poster.locator('button:not([data-text-panel],[data-scene-motion-toggle])')).toHaveCount(0);
 await expect(poster.locator('[data-action="delete"],[data-action="edit"],[data-action="add"]')).toHaveCount(0);
 // 允許的互動：展開 Text_Panel、複製文字、操作 Motion_Toggle。
 const toggle=page.locator('[data-text-panel=toggle]'),copy=page.locator('[data-text-panel=copy]');
 await expect(toggle).toHaveAttribute('aria-expanded','false');await toggle.click();
 await expect(toggle).toHaveAttribute('aria-expanded','true');await expect(page.locator('#text-panel-body')).toBeVisible();
 const shown=(await page.locator('#text-panel-body').innerText()).replace(/\r\n/g,'\n');
 await copy.click();await expect(page.locator('#toasts')).toHaveText('已複製行程文字');
 const written=await page.evaluate(()=>window.__written);expect(written).toHaveLength(1);expect(written[0].trim()).toBe(shown.trim());
 const motionToggle=poster.locator('[data-scene-motion-toggle]');
 if(await motionToggle.isVisible()){
  const motion=()=>page.locator('html').getAttribute('data-scene-motion');
  const before=await motion();await motionToggle.click();expect(await motion()).not.toBe(before);
  await motionToggle.click();expect(await motion()).toBe(before);
 }else await expect(page.locator('[data-motion-reduced-note]')).toBeVisible(); // Reduced_Motion：依需求 13.2 隱藏開關
 // 操作之後仍然沒有編輯控制項，伺服器資料沒有改變。
 await expect(page.locator('.plan-view-switch')).toHaveCount(0);
 const after=await detail(page,trip.id);expect(after.state.routes).toHaveLength(8);
});
