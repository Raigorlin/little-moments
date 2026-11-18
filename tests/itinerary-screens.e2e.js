import {test as base} from '@playwright/test';
import {exampleTripTest as test,expect,exampleTrip,writeLocalPlannerState} from './local-planner-fixture.js';
import {seed,STORAGE_KEY} from '../src/model.js';
// 既有畫面的瀏覽器測試（需求 2.4、2.9、3.7、3.8、3.9、4.12、6.10、8.4、20.1、20.2）。
// 以 Example_Trip 在本機版執行，不需要伺服器登入；有些測試以 writeLocalPlannerState() 改用修改過的 Example_Trip。

const VEHICLE_NOTE='每天的出發時間與地點，請在規劃行程的路線填寫。';
const ROUTE_NOTE='這台車在第 1 天、第 3 天還有路線，請先刪除這些路線，或改派給其他車。';
const poster=p=>p.locator('.itinerary-poster');
const menu=p=>p.locator('#trip-menu');
const dialog=p=>p.locator('#dialog');
const form=p=>p.locator('#edit-form');
const stored=p=>p.evaluate(k=>JSON.parse(localStorage.getItem(k)),STORAGE_KEY);
const storedText=p=>p.evaluate(k=>localStorage.getItem(k),STORAGE_KEY);

async function open(p){
 await p.goto('/demo/#/trip');
 await expect(poster(p)).toBeVisible();await expect(p.locator('[data-poster-day]')).toHaveCount(3);
}
async function openMenu(p){
 await p.getByRole('button',{name:'旅行選單',exact:true}).click();await expect(menu(p)).toBeVisible();
}
async function openVehicle(p,name='第一車'){
 await openMenu(p);await menu(p).getByRole('button',{name:`編輯 ${name}`,exact:true}).click();
 await expect(form(p)).toBeVisible();await expect(form(p)).toHaveAttribute('data-kind','vehicle');
}
async function openSettings(p){
 await openMenu(p);await menu(p).getByRole('button',{name:'編輯旅行',exact:true}).click();
 await expect(form(p)).toBeVisible();await expect(form(p)).toHaveAttribute('data-kind','trip-settings');
}
const saveForm=p=>form(p).locator('button[type="submit"]').click();
const nav=(p,tab)=>p.locator(`.section-tabs [data-tab="${tab}"]`).click();
async function openEditor(p){
 await p.locator('.plan-view-switch [data-view="editor"]').click();
 await expect(p.locator('[data-plan-nav="day"]')).toHaveCount(3);
}
// 每個測試要的 Example_Trip 變體。
function modified(change){const state=exampleTrip();change(state);return state;}
async function openWith(p,state){await writeLocalPlannerState(p,state);await open(p);}

test('[TC-ITIN-030] Vehicle_Dialog has only name, driver, seats and passengers, plus the note that departures are filled in the planner route',async({page:p})=>{
 await open(p);await openVehicle(p);
 const names=await form(p).locator('input:not([type=hidden]),select,textarea').evaluateAll(list=>[...new Set(list.map(el=>el.name))]);
 expect(names).toEqual(['name','driver','seats','passengers']);
 await expect(form(p).locator('.passenger-checks input[name="passengers"]')).toHaveCount(8);
 await expect(form(p).locator('.help')).toHaveText(VEHICLE_NOTE);
 for(const text of ['出發時間（選填）','出發地點','各車出發'])await expect(dialog(p)).not.toContainText(text);
 // 新增車輛的對話框也一樣。
 await p.keyboard.press('Escape');await expect(dialog(p)).not.toBeVisible();
 await openMenu(p);await menu(p).getByRole('button',{name:'新增車輛',exact:true}).click();
 await expect(form(p)).toHaveAttribute('data-kind','vehicle');
 expect(await form(p).locator('input:not([type=hidden]),select,textarea').evaluateAll(list=>[...new Set(list.map(el=>el.name))])).toEqual(['name','driver','seats','passengers']);
 await expect(form(p).locator('.help')).toHaveText(VEHICLE_NOTE);
});

base('[TC-ITIN-031] saving an existing vehicle keeps its meeting, and a new vehicle has a blank meeting',async({page:p})=>{
 const meeting='14:00 · 台北車站東三門',free='早上八點在家門口';
 await openWith(p,modified(s=>{s.vehicles[0].meeting=meeting;s.vehicles[1].meeting=free;}));
 await openVehicle(p,'第一車');
 await form(p).locator('input[name="name"]').fill('第一車改名');
 await saveForm(p);await expect(dialog(p)).not.toBeVisible();
 let state=await stored(p);
 expect(state.vehicles[0].name).toBe('第一車改名');
 expect(state.vehicles.map(v=>v.meeting)).toEqual([meeting,free,'','']);
 // 保存後重新載入，舊的出發資料仍在。
 await p.reload();await expect(poster(p)).toBeVisible();
 expect((await stored(p)).vehicles.map(v=>v.meeting)).toEqual([meeting,free,'','']);
 await openMenu(p);await menu(p).getByRole('button',{name:'新增車輛',exact:true}).click();
 await form(p).locator('input[name="name"]').fill('第五車');
 await saveForm(p);await expect(dialog(p)).not.toBeVisible();
 state=await stored(p);
 expect(state.vehicles).toHaveLength(5);
 expect(state.vehicles[4].name).toBe('第五車');expect(state.vehicles[4].meeting).toBe('');
 expect(state.vehicles.slice(0,4).map(v=>v.meeting)).toEqual([meeting,free,'','']);
});

test('[TC-ITIN-032] deleting a vehicle with routes from the Trip_Menu opens no confirmation and lists its days',async({page:p})=>{
 await open(p);const before=await storedText(p);
 await openMenu(p);
 await menu(p).getByRole('button',{name:'移除 第一車',exact:true}).click();
 await expect(p.locator('#toasts')).toContainText(ROUTE_NOTE);
 await expect(dialog(p)).not.toBeVisible();
 await expect(p.getByRole('button',{name:'確認移除',exact:true})).toHaveCount(0);
 expect(await storedText(p)).toBe(before);
 await openMenu(p);await expect(menu(p).getByRole('heading',{name:'第一車',exact:true})).toBeVisible();
 expect(await storedText(p)).toBe(before);
});

test('[TC-ITIN-033] deleting a vehicle with routes from the Vehicle_Dialog shows the days in the dialog error and keeps the dialog',async({page:p})=>{
 await open(p);const before=await storedText(p);
 await openVehicle(p);
 await dialog(p).getByRole('button',{name:'移除項目',exact:true}).click();
 await expect(form(p)).toBeVisible();await expect(form(p).locator('.form-error')).toHaveText(ROUTE_NOTE);
 await expect(p.getByRole('button',{name:'確認移除',exact:true})).toHaveCount(0);
 expect(await storedText(p)).toBe(before);
});

base('[TC-ITIN-034] each Trip_Menu vehicle card shows the first-day departure line: route, pending time, legacy departure and no route',async({browser})=>{
 const lineIn=(p,name)=>menu(p).locator('.vehicle-card',{has:p.getByRole('heading',{name,exact:true})}).locator('p.help');
 const visit=async state=>{const p=await (await browser.newContext()).newPage();await openWith(p,state);await openMenu(p);return p;};
 // Example_Trip: the place name is the only link text.
 let p=await visit(exampleTrip());
 for(const [name,text] of [['第一車','第 1 天・08:00 出發：出發地點 A'],['第二車','第 1 天・08:30 出發：出發地點 B'],['第三車・採買組','第 1 天・09:00 出發：出發地點 C'],['第四車','第 1 天・09:30 出發：出發地點 D']])await expect(lineIn(p,name)).toHaveText(text);
 await expect(lineIn(p,'第一車').locator('a')).toHaveCount(1);await expect(lineIn(p,'第一車').locator('a')).toHaveText('出發地點 A');
 await p.context().close();
 // Legacy departure of seed().
 p=await visit(seed());
 for(const name of ['山線小巴','海風號']){
  await expect(lineIn(p,name)).toHaveText('第 1 天・14:00 出發：台北車站東三門（舊的出發資料）');
  await expect(lineIn(p,name).locator('a')).toHaveText('台北車站東三門');
 }
 await p.context().close();
 // A route without a time, and a car without any route.
 p=await visit(modified(s=>{s.routes.find(r=>r.id==='rt-1-v1').time='';s.routes=s.routes.filter(r=>r.id!=='rt-1-v4'&&r.id!=='rt-3-v4');}));
 await expect(lineIn(p,'第一車')).toHaveText('第 1 天・出發時間待定：出發地點 A');
 await expect(lineIn(p,'第二車')).toHaveText('第 1 天・08:30 出發：出發地點 B');
 await expect(lineIn(p,'第四車')).toHaveText('第 1 天還沒有路線');
});
test('[TC-ITIN-035] a destination equal to a place name is rejected, the dialog keeps its input and nothing is saved',async({page:p})=>{
 await open(p);const before=await storedText(p);
 await openSettings(p);
 await form(p).locator('input[name="destination"]').fill('出發地點 A');
 await form(p).locator('input[name="title"]').fill('改過的名稱');
 await saveForm(p);
 await expect(form(p).locator('.form-error')).toHaveText('已有同名地點：出發地點 A。請先在「地點與車」把這個地點改名。');
 await expect(form(p).locator('input[name="destination"]')).toHaveValue('出發地點 A');
 await expect(form(p).locator('input[name="title"]')).toHaveValue('改過的名稱');
 expect(await storedText(p)).toBe(before);
});

test('[TC-ITIN-036] shortening the trip over a day with routes is rejected with the blocked days, and nothing is saved',async({page:p})=>{
 await open(p);const before=await storedText(p);
 await openSettings(p);
 await form(p).locator('input[name="endDate"]').fill('2026-10-21');
 await form(p).locator('input[name="title"]').fill('改過的名稱');
 await saveForm(p);
 await expect(form(p)).toBeVisible();
 await expect(form(p).locator('.form-error')).toHaveText('縮短天數前，請先處理：第 3 天（10/22）的路線與每日設定。刪除這些路線、清除這些每日設定後，才能縮短天數。');
 await expect(form(p).locator('input[name="endDate"]')).toHaveValue('2026-10-21');
 await expect(form(p).locator('input[name="title"]')).toHaveValue('改過的名稱');
 expect(await storedText(p)).toBe(before);
});

test('[TC-ITIN-037] postponing the dates moves routes and day settings with their day and keeps the day being edited',async({page:p})=>{
 await open(p);
 await openEditor(p);
 const tabs=p.locator('[data-plan-nav="day"]');
 await tabs.nth(2).click();await expect(tabs.nth(2)).toHaveAttribute('aria-pressed','true');
 const summary=p.locator('.plan-summary');await expect(summary).toContainText('把快樂一起帶回家');
 const before=await stored(p);
 await openSettings(p);
 await form(p).locator('input[name="startDate"]').fill('2026-10-27');
 await form(p).locator('input[name="endDate"]').fill('2026-10-29');
 await saveForm(p);await expect(dialog(p)).not.toBeVisible();
 const after=await stored(p);
 expect(after.trip.startDate).toBe('2026-10-27');expect(after.trip.endDate).toBe('2026-10-29');
 const shift={'2026-10-20':'2026-10-27','2026-10-21':'2026-10-28','2026-10-22':'2026-10-29'};
 expect(after.routes.map(r=>[r.id,r.date,r.vehicleId,r.from,r.to,r.time,r.stops])).toEqual(before.routes.map(r=>[r.id,shift[r.date],r.vehicleId,r.from,r.to,r.time,r.stops]));
 expect(after.daySettings).toEqual(before.daySettings.map(d=>({...d,date:shift[d.date]})));
 expect(after.activities.map(a=>a.date)).toEqual(before.activities.map(a=>shift[a.date]));
 expect(after.vehicles).toEqual(before.vehicles);
 // 規劃行程仍選取第 3 天，並以新日期顯示。
 await p.keyboard.press('Escape');
 await expect(tabs.nth(2)).toHaveAttribute('aria-pressed','true');
 await expect(tabs.nth(2)).toContainText('10/29');await expect(tabs.nth(0)).toContainText('10/27');
 await expect(summary).toContainText('把快樂一起帶回家・4 條路線');
});

test('[TC-ITIN-038] changing the destination shows the new name on the poster and in the planner',async({page:p})=>{
 await open(p);
 await openSettings(p);
 await form(p).locator('input[name="destination"]').fill('新的山中營區');
 await saveForm(p);await expect(dialog(p)).not.toBeVisible();
 expect((await stored(p)).trip.destination).toBe('新的山中營區');
 await p.keyboard.press('Escape');
 await expect(poster(p)).toContainText('新的山中營區');await expect(poster(p)).not.toContainText('夕淞度日營區');
 await expect(poster(p).locator('[data-poster-day]').first().locator('.route-map')).toContainText('新的山中營區');
 await openEditor(p);
 await p.locator('[data-plan-toggle="places"]').click();
 await expect(p.locator('.plan-destination .plan-row-name')).toHaveText('新的山中營區');
 await p.locator('[data-plan-nav="day"]').first().click();
 await expect(p.locator('.itinerary-editor, #main').first()).toContainText('新的山中營區');
 await expect(p.locator('#main')).not.toContainText('夕淞度日營區');
});

base('[TC-ITIN-039] changing a meal slot resets its Meal_Time, other edits keep it, and the shopping list says where each item is bought',async({page:p})=>{
 await openWith(p,modified(s=>{s.meals.find(m=>m.id==='m1').time='19:30';}));
 await nav(p,'meals');
 const edit=()=>p.getByRole('button',{name:/^編輯 烤肉派對/}).click();
 await edit();
 await form(p).locator('input[name="title"]').fill('烤肉派對二號');
 await saveForm(p);await expect(dialog(p)).not.toBeVisible();
 let meal=(await stored(p)).meals.find(m=>m.id==='m1');
 expect(meal.title).toBe('烤肉派對二號');expect(meal.time).toBe('19:30');
 await edit();
 await form(p).locator('select[name="slot"]').selectOption('午餐');
 await saveForm(p);await expect(dialog(p)).not.toBeVisible();
 meal=(await stored(p)).meals.find(m=>m.id==='m1');
 expect(meal.slot).toBe('午餐');expect(meal).not.toHaveProperty('time');
 await nav(p,'schedule').catch(()=>{});
 await p.goto('/demo/#/trip');await expect(poster(p)).toBeVisible();
 await p.locator('[data-text-panel=toggle]').click();
 await expect(p.locator('#text-panel-body')).toContainText('12:00 午餐：烤肉派對二號');
 await expect(p.locator('#text-panel-body')).not.toContainText('19:30');
 // 採買清單
 await nav(p,'shopping');
 const where=p.locator('.shopping-where');
 await expect(where.first()).toBeVisible();
 const texts=await where.allTextContents();
 expect(texts.length).toBeGreaterThan(0);
 expect(new Set(texts)).toEqual(new Set(['第 1 天在超市／賣場（第三車・採買組）']));
 await expect(p.locator('.shopping-row',{hasText:'五花肉片'}).locator('.shopping-where')).toHaveText('第 1 天在超市／賣場（第三車・採買組）');
});
