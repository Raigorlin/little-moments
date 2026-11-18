import {test as base} from '@playwright/test';
import {test,expect,writeLocalPlannerState} from './local-planner-fixture.js';
import {seed,STORAGE_KEY} from '../src/model.js';
import {poolMember} from './support/e2e-pool.js';
// 舊資料的瀏覽器測試（需求 19.1、19.2、19.3、19.7、19.8、23.10）。
// 以 seed() 的舊手冊（沒有 Place_List、Route、Day_Settings）開啟 Trip_View，切到規劃行程、選取每一天、切回行程圖，全程不儲存。
// Local_Planner 版（[TC-ITIN-020] 至 [TC-ITIN-024]、[TC-ITIN-029]）不需要伺服器；Account_Mode 版（[TC-ITIN-025] 至 [TC-ITIN-028]）需要 CAMPING_BASE_URL。
const testBase=process.env.CAMPING_BASE_URL;
const password='Local-Only-Test-Pass-2026';
const adminName='qa-admin';
const accountTest=testBase?base:base.skip;
const DAYS=['2026-11-20','2026-11-21','2026-11-22'];
// seed() 每一天的 Activity（依時間排序）。
const DAY_ACTIVITIES=[['a1','a2','a3','a4','a5'],['a6','a7','a8'],['a9','a10']];
const PARTNERS='小安、小雨、米米';
const LEGACY_PLACE='台北車站東三門';

const poster=p=>p.locator('.itinerary-poster');
const day=(p,index)=>poster(p).locator('[data-poster-day]').nth(index);
const storageValue=p=>p.evaluate(k=>localStorage.getItem(k),STORAGE_KEY);
const titlesByDay=state=>DAY_ACTIVITIES.map(ids=>ids.map(id=>state.activities.find(a=>a.id===id).title));

async function openPoster(p,path='/demo/#/trip'){
 await p.goto(path);await expect(poster(p)).toBeVisible();await expect(p.locator('[data-poster-day]')).toHaveCount(3);
}
// 切到規劃行程、依序選取每一天、再切回行程圖；全程不按任何儲存。
async function walkEditor(p){
 await p.locator('.plan-view-switch [data-view="editor"]').click();
 const tabs=p.locator('[data-plan-nav="day"]');await expect(tabs).toHaveCount(3);
 for(let i=0;i<3;i++){await tabs.nth(i).click();await expect(tabs.nth(i)).toHaveAttribute('aria-pressed','true');}
 await p.locator('.plan-view-switch [data-view="poster"]').click();
 await expect(poster(p)).toBeVisible();await expect(p.locator('[data-poster-day]')).toHaveCount(3);
}
// 需求 19.2：每筆 Activity 恰好一次，出現在自己的日子，並顯示原旅伴名單。
async function expectActivities(p,state=seed()){
 const expected=titlesByDay(state);
 for(let i=0;i<3;i++){
  const cards=day(p,i).locator('[data-line="activity"]');
  expect(await cards.evaluateAll(list=>list.map(el=>el.dataset.id))).toEqual(DAY_ACTIVITIES[i]);
  expect(await cards.locator('.moment-title').allTextContents()).toEqual(expected[i]);
 }
 await expect(poster(p).locator('[data-line="activity"]')).toHaveCount(10);
 const shopping=poster(p).locator('[data-line="activity"][data-id="a2"]');
 await expect(shopping.locator('.moment-title')).toHaveText('把好吃的，一起買齊');
 await expect(shopping.locator('.moment-participants')).toHaveText(`參加：${PARTNERS}`);
 // 全體旅伴的活動不顯示參加行。
 await expect(poster(p).locator('[data-line="activity"][data-id="a1"] .moment-participants')).toHaveCount(0);
}
// 需求 19.3：舊出發資料只在第 1 天。
async function expectLegacyDepartures(p){
 const first=day(p,0).locator('[data-line="legacy"]');
 await expect(first).toHaveCount(2);
 await expect(first.nth(0)).toHaveAttribute('data-id','v1');await expect(first.nth(1)).toHaveAttribute('data-id','v2');
 for(const [index,name] of [[0,'山線小巴'],[1,'海風號']]){
  const line=first.nth(index).locator('.rm-dep');
  await expect(line).toContainText('14:00');await expect(line).toContainText(name);await expect(line).toContainText(LEGACY_PLACE);
  await expect(first.nth(index).locator('time')).toHaveAttribute('datetime','14:00');
 }
 for(const i of [1,2]){
  await expect(day(p,i).locator('[data-line="legacy"]')).toHaveCount(0);
  await expect(day(p,i).locator('.route-map')).toHaveCount(0);
  await expect(day(p,i)).not.toContainText(LEGACY_PLACE);
 }
}
async function openMenu(p){await p.getByRole('button',{name:'旅行選單',exact:true}).click();await expect(p.locator('#trip-menu')).toBeVisible();}
async function importBackup(p,data){
 await openMenu(p);await p.locator('#trip-menu').getByRole('button',{name:'匯入備份',exact:true}).click();
 await p.locator('input[type=file]').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});
 await p.getByRole('button',{name:'匯入並取代',exact:true}).click();await expect(p.locator('#dialog')).not.toBeVisible();
 await p.goto('/demo/#/trip');await expect(poster(p)).toBeVisible();await expect(p.locator('[data-poster-day]')).toHaveCount(3);
}
function withMeetings(meetings){const state=seed();state.vehicles.forEach((v,i)=>{v.meeting=meetings[i];});return state;}

// ---------- Local_Planner ----------
test('[TC-ITIN-020] Local_Planner: walking the planner over seed() every day and back writes nothing, localStorage stays byte-identical @critical',async({page:p})=>{
 await openPoster(p);
 const before=await storageValue(p);expect(before).not.toBeNull();
 const writes=[];await p.exposeFunction('__noteWrite',key=>writes.push(key));
 await p.evaluate(()=>{const set=Storage.prototype.setItem,remove=Storage.prototype.removeItem;
  Storage.prototype.setItem=function(key,value){window.__noteWrite(key);return set.call(this,key,value);};
  Storage.prototype.removeItem=function(key){window.__noteWrite(key);return remove.call(this,key);};});
 await walkEditor(p);
 expect(await storageValue(p)).toBe(before);
 expect(writes.filter(key=>key===STORAGE_KEY)).toEqual([]);
 const stored=JSON.parse(before);
 expect(stored.routes??[]).toEqual([]);
 expect(stored.vehicles.map(v=>v.meeting)).toEqual(seed().vehicles.map(v=>v.meeting));
 expect(stored.activities.map(a=>a.type)).toEqual(seed().activities.map(a=>a.type));
});

test('[TC-ITIN-021] Local_Planner: the poster shows all 10 seed() activities exactly once on their own day, with the original participants @critical',async({page:p})=>{
 await openPoster(p);await walkEditor(p);await expectActivities(p);
});

test('[TC-ITIN-022] Local_Planner: the old departure of both seed() cars (14:00, 台北車站東三門) appears only on the first day',async({page:p})=>{
 await openPoster(p);await walkEditor(p);await expectLegacyDepartures(p);
});

base('[TC-ITIN-023] Local_Planner: a free-text meeting is shown as is as the old departure place and its time is pending',async({page:p})=>{
 const free='早上八點在家門口';
 await writeLocalPlannerState(p,withMeetings([free,'14:00 · '+LEGACY_PLACE]));
 await openPoster(p);await walkEditor(p);
 const lines=day(p,0).locator('[data-line="legacy"]');await expect(lines).toHaveCount(2);
 const first=lines.filter({has:p.locator('.rm-dep',{hasText:'山線小巴'})});
 await expect(first.locator('.rm-dep')).toContainText(free);await expect(first.locator('.rm-dep')).toContainText('出發時間待定');await expect(first.locator('time')).toHaveCount(0);
 const second=lines.filter({has:p.locator('.rm-dep',{hasText:'海風號'})});
 await expect(second.locator('.rm-dep')).toContainText(LEGACY_PLACE);await expect(second.locator('time')).toHaveAttribute('datetime','14:00');
 for(const i of [1,2])await expect(day(p,i)).not.toContainText(free);
 await expectActivities(p);
});

test('[TC-ITIN-024] Local_Planner: importing a seed() JSON backup gives the same activities and old departures @critical',async({page:p})=>{
 await openPoster(p);
 await importBackup(p,seed());
 await walkEditor(p);
 await expectActivities(p);await expectLegacyDepartures(p);
 const stored=JSON.parse(await storageValue(p));
 expect(stored.vehicles.map(v=>v.meeting)).toEqual(seed().vehicles.map(v=>v.meeting));
 expect(stored.activities.map(a=>a.type)).toEqual(seed().activities.map(a=>a.type));
 expect(stored.routes??[]).toEqual([]);
});

// ---------- Account_Mode ----------
async function api(page,path,method='GET',body){const res=await page.request.fetch(testBase+path,{method,headers:body?{'Content-Type':'application/json','Origin':testBase}:{},data:body});return {status:res.status(),data:await res.json()};}
const detail=async(page,id)=>(await api(page,`/api/trips/${id}`)).data;
async function accountTrip(page,legacyState=seed()){
 const {username}=await poolMember(page,testBase);
 const r=await api(page,'/api/trips','POST',{legacyState});expect(r.status).toBeLessThan(300);
 return {path:`/${username}/trips/${r.data.trip.id}`,id:r.data.trip.id};
}
const watchWrites=page=>{const writes=[];page.on('request',req=>{if(/\/api\/trips\/[^/?]+(?:\?|$)/.test(req.url())&&['PUT','PATCH','DELETE'].includes(req.method()))writes.push(`${req.method()} ${new URL(req.url()).pathname}`);});return writes;};

base.beforeAll(async({browser})=>{
 if(!testBase)return; // 沒有帳號版伺服器時，只執行 Local_Planner 的測試。
 if(new URL(testBase).port!=='5181')throw new Error('Account browser tests must use the isolated test server on port 5181.');
 const page=await browser.newPage();
 const session=await api(page,'/api/session');
 if(session.data.needsSetup){const r=await api(page,'/api/setup','POST',{username:adminName,displayName:'測試管理員',password});expect([200,201,409]).toContain(r.status);}
 await page.close();
});

accountTest('[TC-ITIN-025] Account_Mode: walking the planner over a seed() trip sends no PUT or PATCH and leaves revision, state and localStorage untouched @critical',async({page})=>{
 const trip=await accountTrip(page);
 const before=await detail(page,trip.id);
 const writes=watchWrites(page);
 await openPoster(page,trip.path);await walkEditor(page);
 expect(writes).toEqual([]);
 const after=await detail(page,trip.id);
 expect(after.trip.revision).toBe(before.trip.revision);expect(after.state).toEqual(before.state);
 expect(await storageValue(page)).toBeNull();
});

accountTest('[TC-ITIN-026] Account_Mode: the poster shows all 10 seed() activities once on their own day, with the original participants @critical',async({page})=>{
 const trip=await accountTrip(page);
 await openPoster(page,trip.path);await walkEditor(page);await expectActivities(page);
});

accountTest('[TC-ITIN-027] Account_Mode: the old departure of both seed() cars appears only on the first day',async({page})=>{
 const trip=await accountTrip(page);
 await openPoster(page,trip.path);await walkEditor(page);await expectLegacyDepartures(page);
});

accountTest('[TC-ITIN-028] Account_Mode: a free-text meeting is shown as is as the old departure place and its time is pending',async({page})=>{
 const free='早上八點在家門口';
 const trip=await accountTrip(page,withMeetings([free,'14:00 · '+LEGACY_PLACE]));
 const writes=watchWrites(page);
 await openPoster(page,trip.path);await walkEditor(page);
 const lines=day(page,0).locator('[data-line="legacy"]');await expect(lines).toHaveCount(2);
 const first=lines.filter({has:page.locator('.rm-dep',{hasText:'山線小巴'})});
 await expect(first.locator('.rm-dep')).toContainText(free);await expect(first.locator('.rm-dep')).toContainText('出發時間待定');
 for(const i of [1,2])await expect(day(page,i)).not.toContainText(free);
 expect(writes).toEqual([]);
 expect((await detail(page,trip.id)).state.vehicles[0].meeting).toBe(free);
});

// ---------- 其他舊出發格式 ----------
base('[TC-ITIN-029] Local_Planner: an old departure with only a time or an unsplittable text shows 出發地點待定 or 出發時間待定 and the rest unchanged',async({page:p})=>{
 await writeLocalPlannerState(p,withMeetings(['14:00 台北車站','00:00']));
 await openPoster(p);
 const lines=day(p,0).locator('[data-line="legacy"]');await expect(lines).toHaveCount(2);
 // 「14:00 台北車站」沒有分隔符號，整段是地點，時間待定。
 const text=lines.filter({has:p.locator('.rm-dep',{hasText:'山線小巴'})}).locator('.rm-dep');
 await expect(text).toContainText('出發時間待定');await expect(text).toContainText('14:00 台北車站');
 // 「00:00」只有時間，地點待定。
 const only=lines.filter({has:p.locator('.rm-dep',{hasText:'海風號'})});
 await expect(only.locator('time')).toHaveAttribute('datetime','00:00');await expect(only.locator('.rm-dep')).toContainText('出發地點待定');
});
