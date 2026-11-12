import {test,expect} from './local-planner-fixture.js';
import {seed,STORAGE_KEY} from '../src/model.js';
import {poolMember} from './support/e2e-pool.js';
const base=process.env.CAMPING_BASE_URL;
const nav=(p,t)=>p.locator(`.section-tabs [data-tab="${t}"]`).click();
const openTripMenu=page=>page.getByRole('button',{name:'旅行選單',exact:true}).click();
const saved=p=>expect(p.locator('.sync-status')).toContainText('已儲存至本機伺服器');
const submit=async p=>{await p.locator('#edit-form button[type=submit]').click();await expect(p.locator('#dialog')).not.toBeVisible();await saved(p);};
const car=(p,id)=>p.locator(`[data-vehicle-departure="${id}"]`);
async function api(p,path,method='GET',body){const r=await p.request.fetch(base+path,{method,data:body,headers:body?{Origin:base,'Content-Type':'application/json'}:{}});expect(r.ok(),await r.text()).toBe(true);return r.json();}
async function fixture(p,modify=s=>s){
 await api(p,'/api/login','POST',{username:'qa-admin',password:'Local-Only-Test-Pass-2026'});
 const state=seed();state.vehicles[0].meeting='09:00 · 台北車站東三門';state.vehicles[1].meeting='08:30 · 台中高鐵站六號出口';modify(state);
 const {trip}=await api(p,'/api/trips','POST',{legacyState:state});await p.goto(`/qa-admin/trips/${trip.id}`);
 await expect(p.locator('.vehicle-departures')).toBeVisible();return {trip,detail:()=>api(p,`/api/trips/${trip.id}`)};
}
test.beforeEach(async({baseURL})=>expect(new URL(baseURL).port).toBe('5181'));

test('separate starts show sorted first-day cars and leave the shared schedule and data unchanged',async({page:p})=>{
 const {detail}=await fixture(p),before=await detail();
 await expect(p.locator('.departure-vehicle h3')).toHaveText(['海風號','山線小巴']);
 await expect(car(p,'v1')).toContainText('09:00');await expect(car(p,'v1')).toContainText('台北車站東三門');await expect(car(p,'v1')).toContainText('阿哲');await expect(car(p,'v1')).toContainText('小安、小雨');
 await expect(car(p,'v2')).toContainText('08:30');await expect(car(p,'v2')).toContainText('台中高鐵站六號出口');
 await expect(p.locator('.activity-card')).toHaveCount(5);await expect(p.locator('.hero [data-scene-motion-toggle]')).toHaveCount(0);
 await p.locator('[data-day="2026-11-21"]').click();await expect(p.locator('.vehicle-departures')).toHaveCount(0);await expect(p.locator('.activity-card')).toHaveCount(3);
 await p.locator('[data-day="2026-11-20"]').click();await expect(p.locator('.departure-vehicle')).toHaveCount(2);await p.reload();expect(await detail()).toEqual(before);
 expect(await p.evaluate(k=>localStorage.getItem(k),STORAGE_KEY)).toBeNull();
});

test('[TC-VEH-002] editing in the schedule syncs to the trip menu and reload; editing in the trip menu syncs back',async({page:p})=>{
 const {detail}=await fixture(p),before=await detail();await car(p,'v1').locator('[data-action=vehicle]').first().click();
 await expect(p.getByLabel('出發時間（選填）',{exact:true})).toHaveValue('09:00');await expect(p.getByLabel('出發地點',{exact:true})).toHaveValue('台北車站東三門');
 await p.getByLabel('出發時間（選填）',{exact:true}).fill('07:45');await p.getByLabel('出發地點',{exact:true}).fill('新竹高鐵站四號出口');await submit(p);
 await expect(p.locator('.departure-vehicle h3')).toHaveText(['山線小巴','海風號']);await openTripMenu(p);const crew=p.locator('#trip-menu .vehicle-card').filter({has:p.getByRole('heading',{name:'山線小巴',exact:true})});await expect(crew).toContainText('07:45 · 新竹高鐵站四號出口');
 await crew.getByRole('button',{name:'編輯 山線小巴',exact:true}).click();await p.getByLabel('出發時間（選填）',{exact:true}).fill('10:10');await submit(p);
 await nav(p,'schedule');await expect(car(p,'v1')).toContainText('10:10');await p.reload();await expect(car(p,'v1')).toContainText('新竹高鐵站四號出口');
 const after=await detail();expect(after.state.vehicles.find(v=>v.id==='v1')).toEqual({...before.state.vehicles.find(v=>v.id==='v1'),meeting:'10:10 · 新竹高鐵站四號出口'});
 for(const key of ['activities','meals','shopping','gear','people'])expect(after.state[key]).toEqual(before.state[key]);expect(after.state.vehicles.find(v=>v.id==='v2')).toEqual(before.state.vehicles.find(v=>v.id==='v2'));
});

test('empty fleet can add cars directly without creating duplicate activities, validates seats and location',async({page:p})=>{
 const {detail}=await fixture(p,s=>s.vehicles=[]),before=await detail();await expect(p.locator('.departure-vehicles-empty')).toBeVisible();
 await p.getByRole('button',{name:'新增車輛',exact:true}).click();await p.getByLabel('車輛暱稱',{exact:true}).fill('晨光號');await p.getByLabel('出發地點',{exact:true}).fill('桃園車站');await p.getByLabel('座位數（含駕駛）',{exact:true}).fill('1');await p.getByRole('checkbox',{name:'阿哲',exact:true}).check();
 await p.locator('#edit-form button[type=submit]').click();await expect(p.locator('.form-error')).toContainText('不能超過座位數');expect(await detail()).toEqual(before);
 await p.getByLabel('座位數（含駕駛）',{exact:true}).fill('4');await p.getByLabel('出發地點',{exact:true}).fill(' ');await p.locator('#edit-form button[type=submit]').click();await expect(p.locator('.form-error')).toContainText('不能只有空白');expect(await detail()).toEqual(before);
 await p.getByLabel('出發地點',{exact:true}).fill('桃園車站');await submit(p);await expect(p.locator('.departure-vehicle')).toContainText('出發時間待確認');
 await p.getByRole('button',{name:'新增車輛',exact:true}).click();await p.getByLabel('車輛暱稱',{exact:true}).fill('南風號');await p.getByLabel('駕駛',{exact:true}).selectOption('p6');await p.getByLabel('出發時間（選填）',{exact:true}).fill('08:15');await p.getByLabel('出發地點',{exact:true}).fill('台南轉運站');await submit(p);
 await expect(p.locator('.departure-vehicle h3')).toHaveText(['南風號','晨光號']);const after=await detail();expect(after.state.vehicles).toHaveLength(2);expect(after.state.activities).toEqual(before.state.activities);await p.reload();await expect(p.locator('.departure-vehicle')).toHaveCount(2);
});

test('free-form legacy meeting text is not guessed or overwritten on unrelated edits',async({page:p})=>{
 const original='早上在市府碰面（司機再通知）';const {detail}=await fixture(p,s=>s.vehicles[0].meeting=original);
 await expect(car(p,'v1')).toContainText(original);await expect(car(p,'v1')).toContainText('出發時間待確認');await car(p,'v1').locator('[data-action=vehicle]').first().click();await expect(p.getByLabel('出發時間（選填）',{exact:true})).toHaveValue('');await p.getByLabel('車輛暱稱',{exact:true}).fill('山線慢慢號');await submit(p);
 expect((await detail()).state.vehicles.find(v=>v.id==='v1').meeting).toBe(original);
});

test('unsaved vehicle drafts and stale saves never overwrite the newer server plan',async({page:p})=>{
 const {trip,detail}=await fixture(p),before=await detail();await car(p,'v1').locator('[data-action=vehicle]').first().click();await p.getByLabel('出發地點',{exact:true}).fill('先不儲存的集合地點');p.once('dialog',d=>d.accept());await p.getByRole('button',{name:'取消',exact:true}).click();expect(await detail()).toEqual(before);
 await car(p,'v1').locator('[data-action=vehicle]').first().click();await p.getByLabel('出發地點',{exact:true}).fill('要保留的草稿');
 const serverState=structuredClone(before.state);serverState.vehicles[0].meeting='06:20 · 別人已更新的出發地點';await api(p,`/api/trips/${trip.id}`,'PUT',{revision:before.trip.revision,state:serverState});
 await p.locator('#edit-form button[type=submit]').click();await expect(p.locator('.save-warning')).toContainText('其他人已更新');await expect(car(p,'v1')).toContainText('要保留的草稿');expect((await detail()).state.vehicles[0].meeting).toBe('06:20 · 別人已更新的出發地點');
});

test('[TC-VEH-001] collaborators can edit departures but cannot delete cars; strangers cannot read the trip',async({page:p,browser})=>{
 const {trip,detail}=await fixture(p);const invite=await api(p,`/api/trips/${trip.id}/invites`,'POST',{});const context=await browser.newContext({baseURL:base});try{
  // 全新 member 帳號取自 harness 帳號池（註冊 API 依用戶端 IP 限速，見 tests/support/e2e-pool.js）。
  const guest=await context.newPage();const {username}=await poolMember(guest,base);
  const denied=await guest.request.get(base+`/api/trips/${trip.id}`);expect(denied.status()).toBe(404);
  await guest.goto(invite.urlPath);await guest.locator('[name=join-name]').fill('分車旅伴');await guest.locator('form button[type=submit]').click();await expect(guest).toHaveURL(new RegExp(`/${username}/trips/`));
  await car(guest,'v2').locator('[data-action=vehicle]').first().click();await expect(guest.getByRole('button',{name:'移除項目',exact:true})).toHaveCount(0);await guest.getByLabel('出發地點',{exact:true}).fill('嘉義高鐵站');await submit(guest);expect((await detail()).state.vehicles.find(v=>v.id==='v2').meeting).toBe('08:30 · 嘉義高鐵站');
  const d=await api(guest,`/api/trips/${trip.id}`);d.state.vehicles=[];const deniedDelete=await guest.request.put(base+`/api/trips/${trip.id}`,{headers:{Origin:base,'Content-Type':'application/json'},data:{revision:d.trip.revision,state:d.state}});expect(deniedDelete.status()).toBe(403);
 }finally{await context.close();}
});

test('cards fit mobile and desktop, long or untrusted text stays safe, print retains departure plans',async({page:p})=>{
 const {detail}=await fixture(p,s=>{s.vehicles[0].name='<img src=x onerror=alert(1)>';s.vehicles[0].meeting='09:00 · 台北車站東三門靠近地下街入口與便利商店前的集合處';s.vehicles.push({id:'v3',name:'午後小車',driver:'',passengers:[],seats:4,meeting:''});});const before=await detail();
 await expect(p.locator('.departure-vehicle img')).toHaveCount(0);await expect(car(p,'v3')).toContainText('出發地點待確認');
 for(const theme of ['light','dark']){await p.evaluate(t=>document.documentElement.dataset.theme=t,theme);for(const width of [320,390,768,1440]){
  await p.setViewportSize({width,height:950});await p.locator('.vehicle-departures').scrollIntoViewIfNeeded();expect(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  const boxes=await p.locator('.departure-vehicle').evaluateAll(els=>els.map(e=>({w:e.getBoundingClientRect().width,overflow:e.scrollWidth-e.clientWidth})));expect(boxes.every(b=>b.w>0&&b.overflow<=1)).toBe(true);
  if(width===390||width===1440)await p.locator('.vehicle-departures').screenshot({path:`previews/vehicle-departures-${theme}-${width}.png`,style:'.topbar{position:static!important}'});
 }}
 await p.emulateMedia({media:'print'});await expect(car(p,'v1')).toBeVisible();await expect(car(p,'v1').getByRole('button')).toBeHidden();await expect(p.getByRole('button',{name:'新增車輛',exact:true})).toBeHidden();expect(await detail()).toEqual(before);
});

test('demo can save departure changes and reload them offline',async({page:p,context})=>{
 await p.goto('/demo/#/trip');await car(p,'v1').locator('[data-action=vehicle]').first().click();
 await p.getByLabel('出發時間（選填）',{exact:true}).fill('06:50');await p.getByLabel('出發地點',{exact:true}).fill('家門口');await p.locator('#edit-form button[type=submit]').click();await expect(p.locator('#dialog')).not.toBeVisible();await expect(car(p,'v1')).toContainText('06:50');
 await p.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));});await context.setOffline(true);await p.reload();await expect(car(p,'v1')).toContainText('家門口');
 expect(await p.evaluate(k=>JSON.parse(localStorage.getItem(k)).vehicles[0].meeting,STORAGE_KEY)).toBe('06:50 · 家門口');
});


test('empty and time-only legacy locations can keep their data on an unrelated vehicle edit',async({page:p})=>{
 const {detail}=await fixture(p,s=>{s.vehicles[0].meeting='';s.vehicles[1].meeting='07:00';});
 for(const [id,name,meeting] of [['v1','還在討論的車',''],['v2','清晨小車','07:00']]){
  await car(p,id).locator('[data-action=vehicle]').first().click();await p.getByLabel('車輛暱稱',{exact:true}).fill(name);await submit(p);
  expect((await detail()).state.vehicles.find(v=>v.id===id).meeting).toBe(meeting);
 }
});


test('[TC-VEH-003] owner removal from the schedule also removes the same car from the trip menu without touching activities',async({page:p})=>{
 const {detail}=await fixture(p),before=await detail();await car(p,'v2').locator('[data-action=vehicle]').first().click();await p.getByRole('button',{name:'移除項目',exact:true}).click();await p.getByRole('button',{name:'確認移除',exact:true}).click();await expect(p.locator('#dialog')).not.toBeVisible();await saved(p);
 await expect(p.locator('.departure-vehicle')).toHaveCount(1);await openTripMenu(p);await expect(p.locator('#trip-menu .vehicle-card')).toHaveCount(1);await expect(p.locator('#trip-menu .vehicle-card')).toContainText('山線小巴');
 const after=await detail();expect(after.state.vehicles).toEqual(before.state.vehicles.filter(v=>v.id!=='v2'));expect(after.state.activities).toEqual(before.state.activities);
});
