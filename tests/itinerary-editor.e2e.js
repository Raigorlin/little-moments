import {test as base} from '@playwright/test';
import {exampleTripTest as test,expect,exampleTrip,writeLocalPlannerState} from './local-planner-fixture.js';
import {STORAGE_KEY} from '../src/model.js';
// 規劃行程的瀏覽器測試（需求 2.2、2.5、2.6、2.7、5.2、5.11、6.5、6.6、6.7、6.10、6.12、7.2、7.3、7.4、8.3、23.7 本機版的前五項）。
// 以 Example_Trip 在本機版執行；每次儲存後重新載入頁面，再確認規劃行程、行程圖與 Text_Panel 的結果。

const poster=p=>p.locator('.itinerary-poster');
const dialog=p=>p.locator('#dialog');
const stored=p=>p.evaluate(k=>JSON.parse(localStorage.getItem(k)),STORAGE_KEY);
const storedText=p=>p.evaluate(k=>localStorage.getItem(k),STORAGE_KEY);
const card=p=>p.locator('form[data-plan-card]');
const saveCard=p=>card(p).locator('[data-action="plan-save"]').click();
const route=(p,text)=>p.locator('.plan-route',{hasText:text});
const SHOP_ITEMS=['五花肉片','鮮蝦','高麗菜','運動飲料','洋芋片','瓦斯','衛生紙','免洗餐具'];

async function open(p){
 await p.goto('/demo/#/trip');
 await expect(poster(p)).toBeVisible();await expect(p.locator('[data-poster-day]')).toHaveCount(3);
}
async function openEditor(p){
 await p.locator('.plan-view-switch [data-view="editor"]').click();
 await expect(p.locator('[data-plan-nav="day"]')).toHaveCount(3);
}
const reopen=async p=>{await p.reload();await expect(poster(p)).toBeVisible();await openEditor(p);};
const showPoster=async p=>{await p.locator('.plan-view-switch [data-view="poster"]').click();await expect(poster(p)).toBeVisible();};
// 展開 Text_Panel 並回傳文字版。
async function itineraryText(p){
 const toggle=p.locator('[data-text-panel=toggle]');
 if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
 const body=p.locator('#text-panel-body');await expect(body).toBeVisible();
 return body.innerText();
}
const day=(p,i)=>p.locator('[data-plan-nav="day"]').nth(i).click();
const segment=(p,name)=>p.locator(`[data-plan-nav="segment"][data-segment="${name}"]`).click();
const togglePlaces=p=>p.locator('[data-plan-toggle="places"]').click();
async function openWith(p,state){await writeLocalPlannerState(p,state);await open(p);}
function modified(change){const state=exampleTrip();change(state);return state;}
const placeNames=state=>state.places.map(x=>x.name);

base('[TC-ITIN-040] 常用活動: the 已加入 presets are disabled, adding the rest writes one Activity each and survives a reload',async({page:p})=>{
 await openWith(p,modified(s=>{s.activities=s.activities.filter(a=>a.id!=='a4'&&a.id!=='a5');}));
 await openEditor(p);await day(p,1);
 await expect(p.locator('[data-plan-nav="day"]').nth(1)).toHaveAttribute('aria-pressed','true');
 await expect(p.locator('.plan-segments [data-segment="activities"]')).toHaveAttribute('aria-pressed','true');
 const presets=p.locator('.plan-presets');
 const box=type=>presets.locator(`[data-plan-preset="${type}"]`);
 for(const type of ['wake','night']){await expect(box(type)).toBeChecked();await expect(box(type)).toBeDisabled();}
 await expect(presets.locator('.plan-added')).toHaveCount(2);
 await expect(box('free')).not.toBeChecked();await expect(box('free')).toBeEnabled();
 await expect(box('tea')).not.toBeChecked();
 const add=p.locator('[data-action="plan-add-presets"]');
 await expect(add).toHaveText('加入 0 個活動');await expect(add).toBeDisabled();
 const before=await stored(p);
 await box('free').check();await box('tea').check();
 await expect(add).toHaveText('加入 2 個活動');await expect(add).toBeEnabled();
 await add.click();
 let state=await stored(p);
 const added=state.activities.filter(a=>!before.activities.some(b=>b.id===a.id));
 expect(added.map(a=>[a.date,a.time,a.title,a.type,a.people,a.location,a.note,a.done,a.vehicleIds]).sort()).toEqual([
  ['2026-10-21','10:00','自由活動、拍照','free',[],'','',false,undefined],
  ['2026-10-21','14:00','下午茶、聊天、玩遊戲','tea',[],'','',false,undefined]
 ].sort());
 expect(state.activities).toHaveLength(before.activities.length+2);
 // 其他欄位沒有被改變。
 const rest=s=>({...s,activities:null,events:null,revision:null});
 expect(rest(state)).toEqual(rest(before));
 expect(state.events).toHaveLength(before.events.length+1);
 await reopen(p);await day(p,1);
 for(const type of ['free','tea'])await expect(box(type)).toBeDisabled();
 await expect(add).toHaveText('加入 0 個活動');
 await expect(p.locator('.plan-activity',{hasText:'下午茶、聊天、玩遊戲'})).toContainText('下午茶／遊戲');
 await showPoster(p);
 const text=await itineraryText(p);
 expect(text).toContain('10:00 自由活動、拍照（自由活動）');expect(text).toContain('14:00 下午茶、聊天、玩遊戲（下午茶／遊戲）');
});

test('[TC-ITIN-041] @critical saving a Route card collapses it, writes the route and shows on the reloaded planner, poster and text',async({page:p})=>{
 await open(p);await openEditor(p);
 const row=route(p,'第四車');
 await expect(row.locator('.plan-row-name')).toHaveText('09:30 第四車 / 出發地點 D → 夕淞度日營區・直達');
 const before=await stored(p);
 await row.locator('.plan-row-button').click();
 await expect(card(p)).toBeVisible();
 await card(p).locator('[name="time"]').fill('10:45');
 await card(p).locator('[name="from"]').selectOption({label:'出發地點 A'});
 await saveCard(p);
 await expect(card(p)).toHaveCount(0);
 const state=await stored(p);
 const saved=state.routes.find(r=>r.id==='rt-1-v4');
 expect(saved).toMatchObject({date:'2026-10-20',vehicleId:'v4',from:'pl-a',to:'@destination',time:'10:45',stops:[]});
 expect(state.routes.filter(r=>r.id!=='rt-1-v4')).toEqual(before.routes.filter(r=>r.id!=='rt-1-v4'));
 await reopen(p);
 // 依已儲存的出發時間排列：10:45 排在最後。
 await expect(p.locator('.plan-routes-list .plan-row-name').first()).toHaveText('08:00 第一車 / 出發地點 A → 夕淞度日營區・直達');
 await expect(p.locator('.plan-routes-list .plan-row-name').nth(3)).toHaveText('10:45 第四車 / 出發地點 A → 夕淞度日營區・直達');
 await showPoster(p);
 const text=await itineraryText(p);
 expect(text).toContain('第四車｜10:45 出發：出發地點 A → 夕淞度日營區');
 expect(text).not.toContain('09:30');
});

test('[TC-ITIN-042] a Route with a 採買 Stop: preview of the items, 上移／下移 keep the Stop ids, and a new departure time is saved',async({page:p})=>{
 await open(p);await openEditor(p);
 const row=route(p,'第三車・採買組');
 await expect(row.locator('.plan-row-name')).toHaveText('09:00 第三車・採買組 / 出發地點 C → 夕淞度日營區・1 個停靠點');
 await row.locator('.plan-row-button').click();
 const items=card(p).locator('.plan-preview-items[aria-label="超市／賣場要買的品項"] li');
 await expect(items).toHaveText(SHOP_ITEMS);
 await expect(card(p).locator('.plan-preview-title')).toHaveText('要買的品項');
 // 預覽不提供任何控制項。
 await expect(card(p).locator('.plan-preview input,.plan-preview select')).toHaveCount(0);
 // 修改 Draft（改任務類型）後預覽立即改變，不需要儲存。
 const before=await storedText(p);
 await card(p).locator('[name="stop-1-kind"]').selectOption('other');
 await expect(card(p).locator('.plan-preview')).toHaveCount(0);
 await expect(card(p).locator('[name="stop-1-note"]')).toBeVisible();
 await card(p).locator('[name="stop-1-kind"]').selectOption('shop');
 await expect(items).toHaveText(SHOP_ITEMS);
 expect(await storedText(p)).toBe(before);
 // 新增第二個停靠點（接送），再上移。
 await card(p).locator('[data-plan-op="add-stop"]').click();
 await card(p).locator('[name="stop-2-place"]').selectOption({label:'出發地點 D'});
 await card(p).locator('[name="stop-2-kind"]').selectOption('pickup');
 const up=card(p).getByRole('button',{name:'上移 出發地點 D',exact:true});
 const down=card(p).getByRole('button',{name:'下移 出發地點 D',exact:true});
 await expect(down).toBeDisabled();await expect(up).toBeEnabled();
 await expect(card(p).getByRole('button',{name:'上移 超市／賣場',exact:true})).toBeDisabled();
 await up.click();
 await expect(up).toBeDisabled();await expect(down).toBeEnabled();
 await expect(card(p).getByRole('button',{name:'下移 超市／賣場',exact:true})).toBeDisabled();
 await expect(items).toHaveText(SHOP_ITEMS);
 await saveCard(p);await expect(card(p)).toHaveCount(0);
 let saved=(await stored(p)).routes.find(r=>r.id==='rt-1-v3');
 expect(saved.stops.map(s=>[s.place,s.kind])).toEqual([['pl-d','pickup'],['pl-shop','shop']]);
 expect(saved.stops[1].id).toBe('st-1');
 // 重新載入後改回原順序並改出發時間。
 await reopen(p);
 await route(p,'第三車・採買組').locator('.plan-row-button').click();
 await card(p).getByRole('button',{name:'下移 出發地點 D',exact:true}).click();
 await card(p).locator('[name="time"]').fill('09:20');
 await saveCard(p);await expect(card(p)).toHaveCount(0);
 saved=(await stored(p)).routes.find(r=>r.id==='rt-1-v3');
 expect(saved.time).toBe('09:20');
 expect(saved.stops.map(s=>[s.place,s.kind])).toEqual([['pl-shop','shop'],['pl-d','pickup']]);
 expect(saved.stops[0].id).toBe('st-1');
 await reopen(p);
 await expect(route(p,'第三車・採買組').locator('.plan-row-name')).toHaveText('09:20 第三車・採買組 / 出發地點 C → 夕淞度日營區・2 個停靠點');
 await showPoster(p);
 expect(await itineraryText(p)).toContain('第三車・採買組｜09:20 出發：出發地點 C → 超市／賣場（採買：'+SHOP_ITEMS.join('、')+'）');
});

test('[TC-ITIN-043] 到採買清單調整負責人: changing the buyer in the Shopping_Tab moves the items to the new car everywhere',async({page:p})=>{
 await open(p);await openEditor(p);
 // 第一車新增採買停靠點；第一車的駕駛與乘客沒有負責任何品項。
 await route(p,'第一車').locator('.plan-row-button').click();
 await card(p).locator('[data-plan-op="add-stop"]').click();
 await card(p).locator('[name="stop-1-place"]').selectOption({label:'超市／賣場'});
 await expect(card(p).locator('.plan-preview .help')).toHaveText('沒有品項由第一車的駕駛或乘客負責買');
 await saveCard(p);await expect(card(p)).toHaveCount(0);
 await reopen(p);
 await route(p,'第一車').locator('.plan-row-button').click();
 const button=card(p).getByRole('button',{name:'到採買清單調整負責人 超市／賣場',exact:true});
 await expect(button).toBeVisible();
 await button.click();
 await expect(p.locator('.section-tabs [data-tab="shopping"]')).toHaveAttribute('aria-current','page');
 const where=name=>p.locator('.shopping-row',{hasText:name}).locator('.shopping-where');
 await expect(where('五花肉片')).toHaveText('第 1 天在超市／賣場（第三車・採買組）');
 await p.locator('[data-shopping-assignee="s1"]').selectOption({label:'小安負責'});
 await expect(where('五花肉片')).toHaveText('第 1 天在超市／賣場（第一車）');
 await expect(where('鮮蝦')).toHaveText('第 1 天在超市／賣場（第三車・採買組）');
 expect((await stored(p)).shopping.find(i=>i.id==='s1').assignee).toBe('p1');
 // 重新載入後：規劃行程的預覽、行程圖與文字版都呈現新的車。
 await reopen(p);
 await route(p,'第一車').locator('.plan-row-button').click();
 await expect(card(p).locator('.plan-preview-items[aria-label="超市／賣場要買的品項"] li')).toHaveText(['五花肉片']);
 await route(p,'第三車・採買組').locator('.plan-row-button').click();
 await expect(card(p).locator('.plan-preview-items[aria-label="超市／賣場要買的品項"] li')).toHaveText(SHOP_ITEMS.slice(1));
 await showPoster(p);
 const text=await itineraryText(p);
 expect(text).toContain('第一車｜08:00 出發：出發地點 A → 超市／賣場（採買：五花肉片） → 夕淞度日營區');
 expect(text).toContain('第三車・採買組｜09:00 出發：出發地點 C → 超市／賣場（採買：'+SHOP_ITEMS.slice(1).join('、')+'） → 夕淞度日營區');
 await expect(poster(p)).toContainText('五花肉片');
});

base('[TC-ITIN-044] ＋新增地點 on a Route card: the new Place joins the Draft first and Place_List only on save',async({page:p})=>{
 await openWith(p,exampleTrip());await openEditor(p);
 await togglePlaces(p);
 const list=p.locator('.plan-places-list .plan-place');
 await expect(list).toHaveCount(7);
 await route(p,'第四車').locator('.plan-row-button').click();
 const add=card(p).locator('[data-plan-op="add-place"][data-target="to"]');
 await add.click();
 const input=card(p).locator('input[name="inlinePlace"]');
 // 空白、同名（含全形與大小寫差異）都被拒絕，保留輸入，下拉選單維持原本的選擇。
 await card(p).locator('[data-plan-op="confirm-place"]').click();
 await expect(card(p).locator('.field-error')).toHaveText('請填寫地點名稱。');
 await expect(input).toHaveAttribute('aria-invalid','true');
 await input.fill('出發地點 a');
 await card(p).locator('[data-plan-op="confirm-place"]').click();
 await expect(card(p).locator('.field-error')).toHaveText('已有同名地點');
 await expect(input).toHaveValue('出發地點 a');
 await input.fill('夕淞度日營區');
 await card(p).locator('[data-plan-op="confirm-place"]').click();
 await expect(card(p).locator('.field-error')).toHaveText('已有同名地點');
 await expect(card(p).locator('[name="to"]')).toHaveValue('@destination');
 // 有效的名稱：加入 Draft 並在該下拉選單選取。
 await input.fill('　新營地 B　');
 await card(p).locator('[data-plan-op="confirm-place"]').click();
 await expect(input).toHaveCount(0);
 await expect(card(p).locator('[name="to"] option:checked')).toHaveText('新營地 B');
 const options=await card(p).locator('[name="from"] option').allTextContents();
 expect(options.slice(-2)).toEqual(['台北','新營地 B']);
 // 儲存前 Place_List 與 Places_And_Cars 都不變。
 expect(placeNames(await stored(p))).toEqual(['出發地點 A','出發地點 B','出發地點 C','出發地點 D','超市／賣場','台北']);
 await expect(list).toHaveCount(7);await expect(p.locator('.plan-places')).not.toContainText('新營地 B');
 await saveCard(p);await expect(card(p)).toHaveCount(0);
 const state=await stored(p);
 expect(placeNames(state)).toEqual(['出發地點 A','出發地點 B','出發地點 C','出發地點 D','超市／賣場','台北','新營地 B']);
 expect(state.routes.find(r=>r.id==='rt-1-v4').to).toBe(state.places[6].id);
 await reopen(p);
 await togglePlaces(p);
 await expect(list).toHaveCount(8);await expect(list.last().locator('.plan-row-name')).toHaveText('新營地 B');
 await expect(list.last().locator('.plan-row-meta')).toHaveText('1 條路線');
 await showPoster(p);
 expect(await itineraryText(p)).toContain('第四車｜09:30 出發：出發地點 D → 新營地 B');
});

base('[TC-ITIN-045] renaming a Place in Places_And_Cars shows the new name everywhere; a duplicate name is rejected and keeps the input',async({page:p})=>{
 await openWith(p,exampleTrip());await openEditor(p);
 await togglePlaces(p);
 const rename=name=>p.getByRole('button',{name:`改名 ${name}`,exact:true});
 await rename('超市／賣場').click();
 const input=card(p).locator('input[name="name"]');
 await expect(input).toHaveValue('超市／賣場');
 const before=await storedText(p);
 await input.fill('出發地點 Ａ');
 await saveCard(p);
 await expect(card(p).locator('.field-error')).toHaveText('已有同名地點');
 await expect(input).toHaveAttribute('aria-invalid','true');await expect(input).toHaveValue('出發地點 Ａ');
 expect(await storedText(p)).toBe(before);
 await input.fill('夕淞度日營區');
 await saveCard(p);await expect(card(p).locator('.field-error')).toHaveText('已有同名地點');
 await input.fill('x'.repeat(51));
 await saveCard(p);await expect(card(p).locator('.field-error')).toHaveText('地點名稱最多 50 個字。');
 expect(await storedText(p)).toBe(before);
 await input.fill('  大賣場 ');
 await saveCard(p);await expect(card(p)).toHaveCount(0);
 const state=await stored(p);
 expect(state.places.find(x=>x.id==='pl-shop').name).toBe('大賣場');
 expect(state.places.map(x=>x.id)).toEqual(['pl-a','pl-b','pl-c','pl-d','pl-shop','pl-taipei']);
 expect(state.routes.find(r=>r.id==='rt-1-v3').stops[0].place).toBe('pl-shop');
 await reopen(p);
 await togglePlaces(p);
 await expect(p.locator('.plan-places-list .plan-place').nth(5).locator('.plan-row-name')).toHaveText('大賣場');
 await expect(p.locator('.plan-places-list .plan-place').nth(5).locator('.plan-row-meta')).toHaveText('1 條路線');
 await route(p,'第三車・採買組').locator('.plan-row-button').click();
 await expect(card(p).locator('[name="stop-1-place"] option:checked')).toHaveText('大賣場');
 await expect(card(p).locator('.plan-preview-items')).toHaveAttribute('aria-label','大賣場要買的品項');
 await showPoster(p);
 expect(await itineraryText(p)).toContain('第三車・採買組｜09:00 出發：出發地點 C → 大賣場（採買：');
 await expect(poster(p)).toContainText('大賣場');await expect(poster(p)).not.toContainText('超市／賣場');
 await p.locator('.section-tabs [data-tab="shopping"]').click();
 await expect(p.locator('.shopping-row',{hasText:'五花肉片'}).locator('.shopping-where')).toHaveText('第 1 天在大賣場（第三車・採買組）');
});

base('[TC-ITIN-046] deleting a Place that a Route uses is refused with its usages; an unused Place is deleted after confirming',async({page:p})=>{
 await openWith(p,modified(s=>{s.daySettings[1].place='pl-b';s.places.push({id:'pl-spare',name:'備用地點'});}));
 await openEditor(p);await togglePlaces(p);
 const before=await storedText(p);
 await p.getByRole('button',{name:'刪除 出發地點 B',exact:true}).click();
 await expect(dialog(p)).not.toBeVisible();
 const notice=p.locator('.plan-notice');
 await expect(notice).toContainText('這個地點還在使用中，請先把下列使用處改成其他地點。');
 await expect(notice).toContainText('第 1 天：第二車；第 2 天：這一天的地點');
 expect(await storedText(p)).toBe(before);
 await expect(p.locator('.plan-places-list .plan-place')).toHaveCount(8);
 // 沒有使用處的地點：確認後才刪除。
 await p.getByRole('button',{name:'刪除 備用地點',exact:true}).click();
 await expect(dialog(p)).toBeVisible();
 await dialog(p).getByRole('button',{name:'取消',exact:true}).click();
 await expect(dialog(p)).not.toBeVisible();
 expect(await storedText(p)).toBe(before);
 await p.getByRole('button',{name:'刪除 備用地點',exact:true}).click();
 await dialog(p).getByRole('button',{name:'確認移除',exact:true}).click();
 await expect(p.getByRole('button',{name:'刪除 備用地點',exact:true})).toHaveCount(0);
 const state=await stored(p);
 expect(placeNames(state)).toEqual(['出發地點 A','出發地點 B','出發地點 C','出發地點 D','超市／賣場','台北']);
 expect(state.routes.map(r=>[r.id,r.from,r.to])).toEqual(JSON.parse(before).routes.map(r=>[r.id,r.from,r.to]));
 await reopen(p);await togglePlaces(p);
 await expect(p.locator('.plan-places-list .plan-place')).toHaveCount(7);
 await expect(p.getByRole('button',{name:'刪除 出發地點 B',exact:true})).toBeVisible();
});

base('[TC-ITIN-047] changing a Meal_Time in the planner changes only that Meal in Trip_State and shows on the poster and text',async({page:p})=>{
 await openWith(p,exampleTrip());await openEditor(p);
 await segment(p,'activities');
 const row=p.locator('.plan-meal',{hasText:'晚餐：烤肉派對'});
 await expect(row.locator('.plan-row-button')).toContainText('18:00');
 await expect(row.locator('.plan-row-button')).toContainText('來自料理菜單');
 await expect(row.locator('input[type="checkbox"]')).toHaveCount(0);
 const before=await stored(p);
 await row.locator('.plan-row-button').click();
 await expect(card(p).locator('[name="time"]')).toHaveValue('');
 // 無效的時間：拒絕並保留輸入。
 await card(p).locator('[name="time"]').fill('19:6');
 await saveCard(p);
 await expect(card(p).locator('[name="time"]')).toHaveAttribute('aria-invalid','true');
 await expect(card(p).locator('[name="time"]')).toHaveValue('19:6');
 expect(await stored(p)).toEqual(before);
 await card(p).locator('[name="time"]').fill('19:30');
 await saveCard(p);await expect(card(p)).toHaveCount(0);
 const state=await stored(p);
 const expected=structuredClone(before);expected.meals.find(m=>m.id==='m1').time='19:30';
 expect(state.meals.filter(m=>m.id!=='m1')).toEqual(before.meals.filter(m=>m.id!=='m1'));
 const rest=s=>({...s,events:null,revision:null});
 expect(rest(state)).toEqual(rest(expected));
 expect(state.events).toHaveLength(before.events.length+1);
 await reopen(p);await segment(p,'activities');
 await expect(p.locator('.plan-meal',{hasText:'晚餐：烤肉派對'}).locator('.plan-row-button')).toContainText('19:30');
 await showPoster(p);
 const text=await itineraryText(p);
 expect(text).toContain('19:30 晚餐：烤肉派對（烤肉）');expect(text).not.toContain('18:00 晚餐：烤肉派對');
 expect(text).toContain('18:00 晚餐：豪華火鍋（火鍋）');
});
