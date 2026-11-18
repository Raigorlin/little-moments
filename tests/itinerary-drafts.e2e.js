import {test as base} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {expect,exampleTrip,writeLocalPlannerState} from './local-planner-fixture.js';
import {STORAGE_KEY} from '../src/model.js';
// Draft 與備份的瀏覽器測試（需求 10.2、10.3、18.13、23.7 本機版的後兩項）。
// 以 Example_Trip 在本機版執行：有 Draft 時逐一執行需求 10.2 列出的每一種操作（取消時保留 Draft 與畫面，確認時丟棄 Draft 且 Trip_State 不變），
// 重新整理頁面時觸發 beforeunload 確認；匯出 JSON 備份再匯入後，Trip_State 與匯出前相同。

const CONFIRM='尚有未儲存的修改。確定放棄？';
const poster=p=>p.locator('.itinerary-poster');
const dialog=p=>p.locator('#dialog');
const stored=p=>p.evaluate(k=>JSON.parse(localStorage.getItem(k)),STORAGE_KEY);
const storedText=p=>p.evaluate(k=>localStorage.getItem(k),STORAGE_KEY);
const card=p=>p.locator('form[data-plan-card]');
const route=(p,text)=>p.locator('.plan-route',{hasText:text});
const dayButton=(p,i)=>p.locator('[data-plan-nav="day"]').nth(i);
const segmentButton=(p,name)=>p.locator(`[data-plan-nav="segment"][data-segment="${name}"]`);
const viewButton=(p,name)=>p.locator(`.plan-view-switch [data-view="${name}"]`);
const tabButton=(p,name)=>p.locator(`.section-tabs [data-tab="${name}"]`);
const togglePlaces=p=>p.locator('[data-plan-toggle="places"]').click();
const SPARE={id:'pl-spare',name:'備用地點'};
const LEGACY_MEETING='14:00 · 台北車站東三門';

async function open(p){
 await p.goto('/demo/#/trip');
 await expect(poster(p)).toBeVisible();await expect(p.locator('[data-poster-day]')).toHaveCount(3);
}
async function openEditor(p){
 await viewButton(p,'editor').click();
 await expect(p.locator('[data-plan-nav="day"]')).toHaveCount(3);
}
async function openWith(p,state){await writeLocalPlannerState(p,state);await open(p);await openEditor(p);}
// 重新載入（沒有 Draft 時不會觸發離開確認）後回到規劃行程。
async function fresh(p){await p.reload();await expect(poster(p)).toBeVisible();await openEditor(p);}
function modified(change){const state=exampleTrip();change(state);return state;}
// 第四車沒有第 1 天的路線，但有舊出發資料：＋新增路線可用，也有「轉成路線」。
const legacyState=()=>modified(s=>{s.routes=s.routes.filter(r=>r.id!=='rt-1-v4');s.vehicles.find(v=>v.id==='v4').meeting=LEGACY_MEETING;});
const spareState=()=>modified(s=>{s.places.push({...SPARE});});

// 所有原生對話框都由這個監聽器處理：預設取消，`accept` 為 true 時確認；`log` 記下每個對話框的文字。
function guard(p){
 const g={log:[],accept:false};
 p.on('dialog',async d=>{g.log.push(d.type()+':'+d.message());await (g.accept?d.accept():d.dismiss());});
 return g;
}
const asked=[`confirm:${CONFIRM}`];
// 需求 10.2：取消時不執行操作、保留 Draft 與畫面；確認時丟棄 Draft 再執行操作；兩種情況 Trip_State 與 localStorage 都不變。
async function probe(p,g,{trigger,kept,done}){
 const before=await storedText(p);
 g.accept=false;g.log.length=0;
 await trigger();
 expect(g.log).toEqual(asked);
 expect(await storedText(p)).toBe(before);
 await kept();
 expect(await storedText(p)).toBe(before);
 g.accept=true;g.log.length=0;
 await trigger();
 expect(g.log).toEqual(asked);
 await done();
 expect(await storedText(p)).toBe(before);
 g.accept=false;g.log.length=0;
}

// ---- Draft 的建立與「維持不變」的檢查 ----
async function routeDraft(p,name='第一車',time='07:45'){
 await route(p,name).locator('.plan-row-button').click();
 await expect(card(p)).toBeVisible();
 await card(p).locator('[name="time"]').fill(time);
}
async function activityDraft(p,id='a1',title='搭帳・營地佈置（改）'){
 await segmentButton(p,'activities').click();
 await p.locator(`.plan-activity[data-id="${id}"] .plan-row-button`).click();
 await expect(card(p)).toBeVisible();
 await card(p).locator('[name="title"]').fill(title);
}
async function mealDraft(p,time='19:00'){
 await segmentButton(p,'activities').click();
 await p.locator('.plan-meal[data-id="m1"] .plan-row-button').click();
 await expect(card(p)).toBeVisible();
 await card(p).locator('[name="time"]').fill(time);
}
async function placeDraft(p,name='超市（改）'){
 await togglePlaces(p);
 await p.getByRole('button',{name:'改名 超市／賣場',exact:true}).click();
 await expect(card(p)).toBeVisible();
 await card(p).locator('input[name="name"]').fill(name);
}
async function keptView(p,{day=0,segment='routes',view='editor',tab='schedule'}={}){
 await expect(viewButton(p,view)).toHaveAttribute('aria-pressed','true');
 await expect(tabButton(p,tab)).toHaveAttribute('aria-current','page');
 if(view==='editor'){
  await expect(dayButton(p,day)).toHaveAttribute('aria-pressed','true');
  await expect(segmentButton(p,segment)).toHaveAttribute('aria-pressed','true');
 }
}
async function keptRoute(p,{name='第一車',time='07:45',...rest}={}){
 await expect(card(p)).toHaveCount(1);
 await expect(card(p).locator('[name="time"]')).toHaveValue(time);
 await expect(route(p,name).locator('.plan-row-button')).toHaveAttribute('aria-expanded','true');
 await keptView(p,rest);
}
async function keptActivity(p,{title='搭帳・營地佈置（改）'}={}){
 await expect(card(p)).toHaveCount(1);
 await expect(card(p).locator('[name="title"]')).toHaveValue(title);
 await keptView(p,{segment:'activities'});
}
async function keptMeal(p,time='19:00'){
 await expect(card(p)).toHaveCount(1);
 await expect(card(p).locator('[name="time"]')).toHaveValue(time);
 await keptView(p,{segment:'activities'});
}
async function keptPlace(p,name='超市（改）'){
 await expect(card(p)).toHaveCount(1);
 await expect(card(p).locator('input[name="name"]')).toHaveValue(name);
 await expect(p.locator('[data-plan-toggle="places"]')).toHaveAttribute('aria-expanded','true');
 await keptView(p);
}
const gone=p=>expect(card(p)).toHaveCount(0);
// 捨棄 Draft 後，該張卡片的修改沒有寫入：重新開啟時顯示已儲存的值。
const expand=(p,button)=>expect(button).toHaveAttribute('aria-expanded','true');

base('[TC-ITIN-050] Draft on a Route card: expanding another Route, ＋新增路線, 轉成路線 and collapsing the card each ask first',async({page:p})=>{
 const g=guard(p);
 await openWith(p,legacyState());
 const other=()=>route(p,'第二車').locator('.plan-row-button');
 await routeDraft(p);
 await probe(p,g,{trigger:()=>other().click(),kept:()=>keptRoute(p),
  done:async()=>{await expand(p,other());await expect(route(p,'第一車').locator('.plan-row-button')).toHaveAttribute('aria-expanded','false');await expect(card(p)).toHaveCount(1);await expect(card(p).locator('[name="time"]')).toHaveValue('08:30');}});
 await fresh(p);await routeDraft(p);
 const add=p.locator('[data-plan-toggle="route:new"]');
 await expect(add).toBeEnabled();
 await probe(p,g,{trigger:()=>add.click(),kept:()=>keptRoute(p),
  done:async()=>{await expand(p,add);await expect(route(p,'第一車').locator('.plan-row-button')).toHaveAttribute('aria-expanded','false');await expect(card(p)).toHaveCount(1);await expect(card(p).locator('[name="time"]')).toHaveValue('');}});
 await fresh(p);await routeDraft(p);
 const convert=p.getByRole('button',{name:'轉成路線 第四車',exact:true});
 await expect(convert).toBeVisible();
 await probe(p,g,{trigger:()=>convert.click(),kept:()=>keptRoute(p),
  done:async()=>{await expand(p,convert);await expect(card(p)).toHaveCount(1);await expect(route(p,'第一車').locator('.plan-row-button')).toHaveAttribute('aria-expanded','false');}});
 await fresh(p);await routeDraft(p);
 const own=route(p,'第一車').locator('.plan-row-button');
 await probe(p,g,{trigger:()=>own.click(),kept:()=>keptRoute(p),
  done:async()=>{await gone(p);await expect(own).toHaveAttribute('aria-expanded','false');}});
 // 取消與確認後，已儲存的路線仍是 08:00。
 await own.click();await expect(card(p).locator('[name="time"]')).toHaveValue('08:00');
});

base('[TC-ITIN-051] Draft on an Activity or Meal card: expanding another card, ＋自訂活動, collapsing and 到料理菜單編輯 each ask first',async({page:p})=>{
 const g=guard(p);
 await openWith(p,exampleTrip());
 const rowButton=id=>p.locator(`.plan-activity[data-id="${id}"] .plan-row-button`);
 await activityDraft(p);
 await probe(p,g,{trigger:()=>rowButton('a2').click(),kept:()=>keptActivity(p),
  done:async()=>{await expect(rowButton('a2')).toHaveAttribute('aria-expanded','true');await expect(card(p)).toHaveCount(1);await expect(card(p).locator('[name="title"]')).toHaveValue('星空夜聊・自由活動');}});
 await fresh(p);await activityDraft(p);
 const meal=p.locator('.plan-meal[data-id="m1"] .plan-row-button');
 await probe(p,g,{trigger:()=>meal.click(),kept:()=>keptActivity(p),
  done:async()=>{await expect(meal).toHaveAttribute('aria-expanded','true');await expect(card(p)).toHaveCount(1);await expect(card(p).locator('[name="time"]')).toHaveValue('');}});
 await fresh(p);await activityDraft(p);
 const custom=p.locator('[data-plan-toggle="activity:new"]');
 await probe(p,g,{trigger:()=>custom.click(),kept:()=>keptActivity(p),
  done:async()=>{await expect(custom).toHaveAttribute('aria-expanded','true');await expect(card(p)).toHaveCount(1);await expect(card(p).locator('[name="title"]')).toHaveValue('');}});
 await fresh(p);await activityDraft(p);
 await probe(p,g,{trigger:()=>rowButton('a1').click(),kept:()=>keptActivity(p),
  done:async()=>{await gone(p);await expect(rowButton('a1')).toHaveAttribute('aria-expanded','false');}});
 await rowButton('a1').click();await expect(card(p).locator('[name="title"]')).toHaveValue('搭帳・營地佈置');
 // Meal_Moment 的 Draft：收起卡片，以及「到料理菜單編輯」。
 await fresh(p);await mealDraft(p);
 const mealOwn=p.locator('.plan-meal[data-id="m1"] .plan-row-button');
 await probe(p,g,{trigger:()=>mealOwn.click(),kept:()=>keptMeal(p),
  done:async()=>{await gone(p);await expect(mealOwn).toHaveAttribute('aria-expanded','false');}});
 await fresh(p);await mealDraft(p);
 await probe(p,g,{trigger:()=>card(p).locator('[data-plan-nav="meal"]').click(),kept:()=>keptMeal(p),
  done:async()=>{await expect(tabButton(p,'meals')).toHaveAttribute('aria-current','page');await expect(p.locator('.plan-view-switch')).toHaveCount(0);}});
});

base('[TC-ITIN-052] Draft and 地點與車: opening it is free; another item\'s 刪除, ＋新增地點 and 改名 ask; collapsing it over a Place Draft asks',async({page:p})=>{
 const g=guard(p);
 await openWith(p,spareState());
 await routeDraft(p);
 // 展開不包含 Draft 的 Places_And_Cars 不詢問。
 await togglePlaces(p);
 await expect(p.locator('.plan-places-list .plan-place')).toHaveCount(8);
 expect(g.log).toEqual([]);await keptRoute(p);
 await probe(p,g,{trigger:()=>p.getByRole('button',{name:'刪除 備用地點',exact:true}).click(),kept:()=>keptRoute(p),
  done:async()=>{await gone(p);await expect(dialog(p)).toBeVisible();await expect(dialog(p)).toContainText('移除這個項目？');}});
 await dialog(p).getByRole('button',{name:'取消',exact:true}).click();await expect(dialog(p)).not.toBeVisible();
 await expect(p.getByRole('button',{name:'刪除 備用地點',exact:true})).toBeVisible();
 await fresh(p);await routeDraft(p);await togglePlaces(p);
 const add=p.locator('[data-plan-toggle="place:new"]');
 await probe(p,g,{trigger:()=>add.click(),kept:()=>keptRoute(p),
  done:async()=>{await expect(add).toHaveAttribute('aria-expanded','true');await expect(card(p)).toHaveCount(1);await expect(card(p).locator('input[name="name"]')).toHaveValue('');}});
 await fresh(p);await routeDraft(p);await togglePlaces(p);
 const rename=p.getByRole('button',{name:'改名 超市／賣場',exact:true});
 await probe(p,g,{trigger:()=>rename.click(),kept:()=>keptRoute(p),
  done:async()=>{await expect(rename).toHaveAttribute('aria-expanded','true');await expect(card(p).locator('input[name="name"]')).toHaveValue('超市／賣場');}});
 // Draft 在地點卡片時，收起包含它的 Places_And_Cars 會詢問。
 await fresh(p);await placeDraft(p);
 const section=p.locator('[data-plan-toggle="places"]');
 await probe(p,g,{trigger:()=>section.click(),kept:()=>keptPlace(p),
  done:async()=>{await gone(p);await expect(section).toHaveAttribute('aria-expanded','false');await expect(p.locator('.plan-places-list')).toHaveCount(0);}});
 await section.click();
 await expect(p.locator('.plan-places-list .plan-place').nth(5).locator('.plan-row-name')).toHaveText('超市／賣場');
});

base('[TC-ITIN-053] Draft: switching the day, the 路線／活動 segment or the View_Switch asks; the already selected option does not',async({page:p})=>{
 const g=guard(p);
 await openWith(p,exampleTrip());
 await routeDraft(p);
 await probe(p,g,{trigger:()=>dayButton(p,1).click(),kept:()=>keptRoute(p),
  done:async()=>{await gone(p);await keptView(p,{day:1,segment:'activities'});}});
 await fresh(p);await routeDraft(p);
 await probe(p,g,{trigger:()=>segmentButton(p,'activities').click(),kept:()=>keptRoute(p),
  done:async()=>{await gone(p);await keptView(p,{segment:'activities'});}});
 await fresh(p);await activityDraft(p);
 await probe(p,g,{trigger:()=>segmentButton(p,'routes').click(),kept:()=>keptActivity(p),
  done:async()=>{await gone(p);await keptView(p);}});
 await fresh(p);await routeDraft(p);
 await probe(p,g,{trigger:()=>viewButton(p,'poster').click(),kept:()=>keptRoute(p),
  done:async()=>{await gone(p);await expect(poster(p)).toBeVisible();await expect(viewButton(p,'poster')).toHaveAttribute('aria-pressed','true');}});
 // 啟動已選取的選項：不改變畫面也不詢問（需求 1.10、4.11）。
 await fresh(p);await routeDraft(p);
 g.log.length=0;
 await viewButton(p,'editor').click();await dayButton(p,0).click();await segmentButton(p,'routes').click();
 expect(g.log).toEqual([]);await keptRoute(p);
});

base('[TC-ITIN-054] Draft: switching the main tab, 到採買清單調整負責人 and opening the Trip_Menu each ask first',async({page:p})=>{
 const g=guard(p);
 await openWith(p,exampleTrip());
 await routeDraft(p);
 await probe(p,g,{trigger:()=>tabButton(p,'meals').click(),kept:()=>keptRoute(p),
  done:async()=>{await expect(tabButton(p,'meals')).toHaveAttribute('aria-current','page');await expect(p.locator('.plan-view-switch')).toHaveCount(0);}});
 await fresh(p);
 await route(p,'第三車・採買組').locator('.plan-row-button').click();
 await card(p).locator('[name="time"]').fill('09:10');
 const shopping=card(p).getByRole('button',{name:'到採買清單調整負責人 超市／賣場',exact:true});
 await probe(p,g,{trigger:()=>shopping.click(),kept:()=>keptRoute(p,{name:'第三車・採買組',time:'09:10'}),
  done:async()=>{await expect(tabButton(p,'shopping')).toHaveAttribute('aria-current','page');await expect(p.locator('.shopping-where').first()).toBeVisible();}});
 await fresh(p);await routeDraft(p);
 const menu=p.getByRole('button',{name:'旅行選單',exact:true});
 await probe(p,g,{trigger:()=>menu.click(),kept:async()=>{await expect(p.locator('#trip-menu')).not.toBeVisible();await keptRoute(p);},
  done:()=>expect(p.locator('#trip-menu')).toBeVisible()});
});

base('[TC-ITIN-055] Draft: opening the Vehicle_Dialog or Trip_Settings_Dialog from any entry asks first',async({page:p})=>{
 const g=guard(p);
 await openWith(p,exampleTrip());
 const form=p.locator('#edit-form');
 const closeForm=async()=>{await p.keyboard.press('Escape');await expect(dialog(p)).not.toBeVisible();};
 await routeDraft(p);await togglePlaces(p);
 await probe(p,g,{trigger:()=>p.getByRole('button',{name:'編輯 第一車',exact:true}).click(),kept:async()=>{await expect(dialog(p)).not.toBeVisible();await keptRoute(p);},
  done:()=>expect(form).toHaveAttribute('data-kind','vehicle')});
 await closeForm();await fresh(p);await routeDraft(p);await togglePlaces(p);
 await probe(p,g,{trigger:()=>p.getByRole('button',{name:'新增車輛',exact:true}).click(),kept:async()=>{await expect(dialog(p)).not.toBeVisible();await keptRoute(p);},
  done:()=>expect(form).toHaveAttribute('data-kind','vehicle')});
 await closeForm();await fresh(p);await routeDraft(p);await togglePlaces(p);
 await probe(p,g,{trigger:()=>p.getByRole('button',{name:'在編輯旅行修改',exact:true}).click(),kept:async()=>{await expect(dialog(p)).not.toBeVisible();await keptRoute(p);},
  done:()=>expect(form).toHaveAttribute('data-kind','trip-settings')});
 await closeForm();await fresh(p);
 // 「這一天的設定」卡片內的「調整旅行日期與天數」：Draft 在該卡片本身。
 await p.locator('[data-plan-toggle="day"]').click();
 await card(p).locator('[name="title"]').fill('向山裡出發（改）');
 await probe(p,g,{trigger:()=>card(p).getByRole('button',{name:'調整旅行日期與天數',exact:true}).click(),
  kept:async()=>{await expect(dialog(p)).not.toBeVisible();await expect(card(p).locator('[name="title"]')).toHaveValue('向山裡出發（改）');},
  done:()=>expect(form).toHaveAttribute('data-kind','trip-settings')});
});

base('[TC-ITIN-056] Draft: a link that leaves Trip_View in the same tab asks first',async({page:p})=>{
 const g=guard(p);
 await openWith(p,exampleTrip());
 await routeDraft(p);
 await probe(p,g,{trigger:()=>p.locator('.mode-switch a[href="#/go"]').click(),
  kept:async()=>{expect(p.url()).toContain('#/trip');await keptRoute(p);},
  done:async()=>{await expect(p).toHaveURL(/#\/go$/);await expect(p.locator('main.departure')).toBeVisible();}});
 await p.goto('/demo/#/trip');await expect(poster(p)).toBeVisible();await openEditor(p);await routeDraft(p);
 await probe(p,g,{trigger:()=>p.locator('.breadcrumb a[href="#/home"]').click(),
  kept:async()=>{expect(p.url()).toContain('#/trip');await keptRoute(p);},
  done:async()=>{await expect(p).toHaveURL(/#\/home$/);}});
});

base('[TC-ITIN-057] without a Draft none of the operations asks, including an opened card that was not changed and the 完成 checkbox',async({page:p})=>{
 const g=guard(p);
 await openWith(p,exampleTrip());
 const before=await storedText(p);
 // 展開後沒有修改：不是 Draft。
 await route(p,'第一車').locator('.plan-row-button').click();await expect(card(p)).toBeVisible();
 await route(p,'第二車').locator('.plan-row-button').click();
 await expect(route(p,'第二車').locator('.plan-row-button')).toHaveAttribute('aria-expanded','true');
 await dayButton(p,1).click();await expect(dayButton(p,1)).toHaveAttribute('aria-pressed','true');
 await segmentButton(p,'routes').click();await segmentButton(p,'activities').click();
 await dayButton(p,0).click();
 // 勾選「完成」不屬於 Draft（需求 10.9）。
 await segmentButton(p,'activities').click();
 await p.locator('.plan-activity[data-id="a1"] .plan-row-button').click();
 await p.locator('.plan-activity[data-id="a2"] input[type="checkbox"]').check();
 await expect(p.locator('.plan-activity[data-id="a2"] input[type="checkbox"]')).toBeChecked();
 await dayButton(p,2).click();await expect(dayButton(p,2)).toHaveAttribute('aria-pressed','true');
 await viewButton(p,'poster').click();await expect(poster(p)).toBeVisible();
 await viewButton(p,'editor').click();
 await tabButton(p,'meals').click();await expect(tabButton(p,'meals')).toHaveAttribute('aria-current','page');
 await p.getByRole('button',{name:'旅行選單',exact:true}).click();await expect(p.locator('#trip-menu')).toBeVisible();
 expect(g.log).toEqual([]);
 // 只有勾選「完成」改變了 Trip_State。
 const after=JSON.parse(await storedText(p));
 expect(after.activities.find(a=>a.id==='a2').done).toBe(true);
 expect(after.activities.filter(a=>a.id!=='a2')).toEqual(JSON.parse(before).activities.filter(a=>a.id!=='a2'));
 expect(after.routes).toEqual(JSON.parse(before).routes);
});

// beforeunload 事件是否被取消（瀏覽器據此顯示離開確認）。
const leaveGuard=p=>p.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;});

base('[TC-ITIN-058] beforeunload asks only while a Draft exists, and reloading the page with a Draft triggers the browser confirmation',async({page:p})=>{
 const g=guard(p);
 await openWith(p,exampleTrip());
 expect(await leaveGuard(p)).toBe(false);
 // 展開卡片但沒有修改：沒有 Draft。
 await route(p,'第一車').locator('.plan-row-button').click();
 expect(await leaveGuard(p)).toBe(false);
 await card(p).locator('[name="time"]').fill('07:45');
 expect(await leaveGuard(p)).toBe(true);
 // 改回原值仍視為有 Draft（需求 10.9）。
 await card(p).locator('[name="time"]').fill('08:00');
 expect(await leaveGuard(p)).toBe(true);
 await card(p).locator('[name="time"]').fill('07:45');
 // 儲存開始寫入後 Draft 結束。
 await card(p).locator('[data-action="plan-save"]').click();await gone(p);
 expect(await leaveGuard(p)).toBe(false);
 expect((await stored(p)).routes.find(r=>r.id==='rt-1-v1').time).toBe('07:45');
 // 確認放棄後 Draft 結束。
 await route(p,'第二車').locator('.plan-row-button').click();
 await card(p).locator('[name="time"]').fill('08:45');
 expect(await leaveGuard(p)).toBe(true);
 g.accept=true;g.log.length=0;
 await dayButton(p,1).click();
 expect(g.log).toEqual(asked);await gone(p);
 expect(await leaveGuard(p)).toBe(false);
 // 在已經有 Draft 的頁面重新整理：瀏覽器的離開確認出現，接受後頁面重新載入，Draft 消失。
 await dayButton(p,0).click();
 await route(p,'第二車').locator('.plan-row-button').click();
 await card(p).locator('[name="time"]').fill('08:45');
 expect(await leaveGuard(p)).toBe(true);
 const before=await storedText(p);
 g.log.length=0;g.accept=true;
 await p.reload();
 expect(g.log).toEqual(['beforeunload:']);
 await expect(poster(p)).toBeVisible();
 expect(await leaveGuard(p)).toBe(false);
 expect(await storedText(p)).toBe(before);
 await openEditor(p);
 await route(p,'第二車').locator('.plan-row-button').click();
 await expect(card(p).locator('[name="time"]')).toHaveValue('08:30');
});

base('[TC-ITIN-059] exporting the JSON backup and importing it again restores the same Trip_State, including places, routes and day settings',async({page:p})=>{
 await openWith(p,exampleTrip());
 const original=await stored(p);
 expect(original.routes.length).toBeGreaterThan(0);expect(original.places.length).toBeGreaterThan(0);expect(original.daySettings.length).toBeGreaterThan(0);
 // 匯出（Trip_Menu 的「匯出備份」）。
 await p.getByRole('button',{name:'旅行選單',exact:true}).click();
 const [download]=await Promise.all([p.waitForEvent('download'),p.locator('#trip-menu').getByRole('button',{name:'匯出備份',exact:true}).click()]);
 expect(download.suggestedFilename()).toBe('good-good-camping-backup.json');
 const backupText=readFileSync(await download.path(),'utf8');
 const backup=JSON.parse(backupText);
 expect(backup).toEqual(original);
 await p.keyboard.press('Escape');
 // 改變 Trip_State：儲存一條路線的新出發時間。
 await openEditorIfNeeded(p);
 await route(p,'第一車').locator('.plan-row-button').click();
 await card(p).locator('[name="time"]').fill('07:45');
 await card(p).locator('[data-action="plan-save"]').click();await gone(p);
 const changed=await stored(p);
 expect(changed.routes.find(r=>r.id==='rt-1-v1').time).toBe('07:45');
 expect(changed).not.toEqual(original);
 // 匯入備份：Trip_State 與匯出前相同（匯入只會提高 revision）。
 await p.getByRole('button',{name:'旅行選單',exact:true}).click();
 await p.locator('#trip-menu').getByRole('button',{name:'匯入備份',exact:true}).click();
 await p.locator('input[type=file]').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(backupText)});
 await p.getByRole('button',{name:'匯入並取代',exact:true}).click();await expect(dialog(p)).not.toBeVisible();
 const sameButRevision=s=>({...s,revision:0});
 expect(sameButRevision(await stored(p))).toEqual(sameButRevision(original));
 expect((await stored(p)).revision).toBeGreaterThan(changed.revision);
 // 重新載入後仍相同，規劃行程、行程圖也顯示匯出前的內容。
 await p.reload();await expect(poster(p)).toBeVisible();
 expect(sameButRevision(await stored(p))).toEqual(sameButRevision(original));
 await openEditor(p);
 await expect(route(p,'第一車').locator('.plan-row-name')).toHaveText('08:00 第一車 / 出發地點 A → 夕淞度日營區・直達');
});
async function openEditorIfNeeded(p){if(await viewButton(p,'editor').getAttribute('aria-pressed')!=='true')await openEditor(p);}
