// trip-planning-workflow-enhance: requirements 3.7, 3.8 and 19.3 to 19.7 replaced the 行程 tab's 各車出發 cards
// (.vehicle-departures, [data-vehicle-departure]) and the Vehicle_Dialog's 出發時間／出發地點 fields. A car's first-day start is now
// a Route written in 規劃行程, and the old `meeting` text is a Legacy_Departure shown in the 行程圖, in the 規劃行程 route list
// (「舊的出發資料」 row with 轉成路線 and 不使用舊資料) and on the Trip_Menu vehicle card. So these tests check how a Legacy_Departure is
// shown, 轉成路線 and 不使用舊資料, and keep TC-VEH-001 to TC-VEH-003 on the new screens: a vehicle is edited or removed in
// 地點與車 (Places_And_Cars) and the Trip_Menu follows. Only the checks of removed behavior were dropped: the sorted 各車出發 cards and
// their first-day-only visibility, editing 出發時間／出發地點 in a dialog, and the 新增車輛 empty-state card with its 出發地點 validation.
import {test,expect} from './local-planner-fixture.js';
import {seed,STORAGE_KEY} from '../src/model.js';
import {poolMember} from './support/e2e-pool.js';
const base=process.env.CAMPING_BASE_URL;
const poster=p=>p.locator('.itinerary-poster');
const legacyLine=(p,id)=>p.locator(`.rm-track--legacy[data-id="${id}"]`);
const legacyRow=(p,id)=>p.locator(`.plan-legacy[data-id="${id}"]`);
const menu=p=>p.locator('#trip-menu');
const menuCard=(p,name)=>menu(p).locator('.vehicle-card').filter({has:p.getByRole('heading',{name,exact:true})});
const menuLine=(p,name)=>menuCard(p,name).locator('p.help');
const openTripMenu=async p=>{await p.getByRole('button',{name:'旅行選單',exact:true}).click();await expect(menu(p)).toBeVisible();};
const saved=p=>expect(p.locator('.sync-status')).toContainText('已儲存至本機伺服器');
const noBrowserCopy=p=>expect(p.evaluate(k=>localStorage.getItem(k),STORAGE_KEY)).resolves.toBeNull();
const planCard=p=>p.locator('form[data-plan-card]');
const submit=async p=>{await p.locator('#edit-form button[type=submit]').click();await expect(p.locator('#dialog')).not.toBeVisible();await saved(p);};
const NOTE='這台車的舊出發資料會改由這條路線記錄';
async function api(p,path,method='GET',body){const r=await p.request.fetch(base+path,{method,data:body,headers:body?{Origin:base,'Content-Type':'application/json'}:{}});expect(r.ok(),await r.text()).toBe(true);return r.json();}
async function fixture(p,modify=s=>s){
 await api(p,'/api/login','POST',{username:'qa-admin',password:'Local-Only-Test-Pass-2026'});
 const state=seed();state.vehicles[0].meeting='09:00 · 台北車站東三門';state.vehicles[1].meeting='08:30 · 台中高鐵站六號出口';modify(state);
 const {trip}=await api(p,'/api/trips','POST',{legacyState:state});await p.goto(`/qa-admin/trips/${trip.id}`);
 await expect(poster(p)).toBeVisible();return {trip,detail:()=>api(p,`/api/trips/${trip.id}`)};
}
test.beforeEach(async({baseURL})=>expect(new URL(baseURL).port).toBe('5181'));
// 規劃行程 on the First_Day, 「路線」 segment.
async function openRoutes(p,index=0){
 await p.locator('.plan-view-switch [data-view="editor"]').click();
 await p.locator('[data-plan-nav="day"]').nth(index).click();
 await p.locator('[data-plan-nav="segment"][data-segment="routes"]').click();
 await expect(p.locator('[data-plan-segment="routes"]')).toBeVisible();
}
const showPoster=async p=>{await p.locator('.plan-view-switch [data-view="poster"]').click();await expect(poster(p)).toBeVisible();};
const openPlaces=async p=>{await p.locator('[data-plan-toggle="places"]').click();await expect(p.locator('.plan-cars-list')).toBeVisible();};
const car=(p,id)=>p.locator(`.plan-car[data-id="${id}"]`);
const editCar=async(p,id,name)=>{await car(p,id).getByRole('button',{name:`編輯 ${name}`,exact:true}).click();await expect(p.locator('#edit-form')).toBeVisible();};
const meetings=state=>state.vehicles.map(v=>v.meeting);

test('a Legacy_Departure shows in the route map, the route list and the Trip_Menu without writing any data',async({page:p})=>{
 const {detail}=await fixture(p),before=await detail();
 await expect(p.locator('.rm-track--legacy')).toHaveCount(2);
 await expect(legacyLine(p,'v1')).toContainText('09:00');await expect(legacyLine(p,'v1')).toContainText('山線小巴');await expect(legacyLine(p,'v1')).toContainText('台北車站東三門');
 await expect(legacyLine(p,'v2')).toContainText('08:30');await expect(legacyLine(p,'v2')).toContainText('海風號');await expect(legacyLine(p,'v2')).toContainText('台中高鐵站六號出口');
 await openRoutes(p);
 await expect(p.locator('.plan-legacy')).toHaveCount(2);
 await expect(p.locator('.plan-legacy').evaluateAll(rows=>rows.map(r=>r.dataset.id))).resolves.toEqual(['v2','v1']);
 await expect(legacyRow(p,'v1')).toContainText('舊的出發資料');await expect(legacyRow(p,'v1')).toContainText('山線小巴・09:00 / 台北車站東三門');
 await expect(legacyRow(p,'v2')).toContainText('海風號・08:30 / 台中高鐵站六號出口');
 await expect(p.getByRole('button',{name:'轉成路線 山線小巴',exact:true})).toBeVisible();await expect(p.getByRole('button',{name:'不使用舊資料 海風號',exact:true})).toBeVisible();
 await p.locator('[data-plan-nav="day"]').nth(1).click();await expect(p.locator('.plan-legacy')).toHaveCount(0);
 await openTripMenu(p);
 await expect(menuLine(p,'山線小巴')).toHaveText('第 1 天・09:00 出發：台北車站東三門（舊的出發資料）');await expect(menuLine(p,'山線小巴').locator('a')).toHaveText('台北車站東三門');
 await expect(menuLine(p,'海風號')).toHaveText('第 1 天・08:30 出發：台中高鐵站六號出口（舊的出發資料）');
 await p.reload();expect(await detail()).toEqual(before);await noBrowserCopy(p);
});

test('[TC-VEH-002] editing a vehicle in 地點與車 syncs to the trip menu and reload; editing in the trip menu syncs back',async({page:p})=>{
 const {detail}=await fixture(p),before=await detail();await showPoster(p);await openRoutes(p);await openPlaces(p);
 await expect(car(p,'v1')).toContainText('山線小巴');await expect(car(p,'v1')).toContainText('還沒有路線');
 await editCar(p,'v1','山線小巴');
 await expect(p.locator('#edit-form')).toHaveAttribute('data-kind','vehicle');await expect(p.getByLabel('出發時間（選填）',{exact:true})).toHaveCount(0);await expect(p.getByLabel('出發地點',{exact:true})).toHaveCount(0);
 await p.locator('#edit-form input[name="name"]').fill('山線小巴二號');await p.locator('#edit-form input[name="seats"]').fill('5');await submit(p);
 await expect(car(p,'v1')).toContainText('山線小巴二號');await expect(car(p,'v1')).toContainText('/ 5 人');
 await expect(legacyRow(p,'v1')).toContainText('山線小巴二號・09:00 / 台北車站東三門');
 await openTripMenu(p);await expect(menuCard(p,'山線小巴二號')).toContainText('山線小巴二號');await expect(menuLine(p,'山線小巴二號')).toHaveText('第 1 天・09:00 出發：台北車站東三門（舊的出發資料）');
 await menuCard(p,'山線小巴二號').getByRole('button',{name:'編輯 山線小巴二號',exact:true}).click();await p.locator('#edit-form input[name="name"]').fill('山線三號');await submit(p);
 await openTripMenu(p);await expect(menuCard(p,'山線三號')).toHaveCount(1);await p.keyboard.press('Escape');await expect(menu(p)).not.toBeVisible();
 await expect(car(p,'v1')).toContainText('山線三號');await p.reload();await showPoster(p);await expect(legacyLine(p,'v1')).toContainText('山線三號');await expect(legacyLine(p,'v1')).toContainText('09:00');
 const after=await detail(),beforeCar=before.state.vehicles.find(v=>v.id==='v1');expect(after.state.vehicles.find(v=>v.id==='v1')).toEqual({...beforeCar,name:'山線三號',seats:5});
 for(const key of ['activities','meals','shopping','gear','people'])expect(after.state[key]).toEqual(before.state[key]);expect(after.state.vehicles.find(v=>v.id==='v2')).toEqual(before.state.vehicles.find(v=>v.id==='v2'));
});

test('empty fleet can add cars from 地點與車 and the route list, validates seats, and a new car has no Legacy_Departure',async({page:p})=>{
 const {detail}=await fixture(p,s=>s.vehicles=[]),before=await detail();await showPoster(p);await expect(p.locator('.rm-track--legacy')).toHaveCount(0);
 await openRoutes(p);await expect(p.locator('.plan-legacy')).toHaveCount(0);await expect(p.getByText('還沒有車輛，新增車輛後就能安排路線')).toBeVisible();
 await p.locator('[data-plan-segment="routes"]').getByRole('button',{name:'新增車輛',exact:true}).click();
 await expect(p.getByLabel('出發地點',{exact:true})).toHaveCount(0);await expect(p.getByLabel('出發時間（選填）',{exact:true})).toHaveCount(0);
 await p.getByLabel('車輛暱稱',{exact:true}).fill('晨光號');await p.getByLabel('座位數（含駕駛）',{exact:true}).fill('1');await p.getByRole('checkbox',{name:'阿哲',exact:true}).check();
 await p.locator('#edit-form button[type=submit]').click();await expect(p.locator('.form-error')).toContainText('不能超過座位數');expect(await detail()).toEqual(before);
 await p.getByLabel('座位數（含駕駛）',{exact:true}).fill('4');await submit(p);
 await openPlaces(p);await expect(car(p,'v3')).toHaveCount(0);await expect(p.locator('.plan-car')).toHaveCount(1);await expect(p.locator('.plan-car')).toContainText('晨光號');await expect(p.locator('.plan-car')).toContainText('還沒有路線');
 await p.getByRole('button',{name:'新增車輛',exact:true}).last().click();await p.getByLabel('車輛暱稱',{exact:true}).fill('南風號');await p.getByLabel('駕駛',{exact:true}).selectOption('p6');await submit(p);
 await expect(p.locator('.plan-car')).toHaveCount(2);await expect(p.locator('.plan-legacy')).toHaveCount(0);
 const after=await detail();expect(after.state.vehicles).toHaveLength(2);expect(meetings(after.state)).toEqual(['','']);expect(after.state.activities).toEqual(before.state.activities);expect(after.state.routes??[]).toEqual(before.state.routes??[]);
 await p.reload();await openRoutes(p);await expect(p.locator('.plan-legacy')).toHaveCount(0);await openTripMenu(p);await expect(menuLine(p,'晨光號')).toHaveText('第 1 天還沒有路線');await expect(menuLine(p,'南風號')).toHaveText('第 1 天還沒有路線');
});

test('free-form legacy meeting text is shown as the place, not guessed, and not overwritten on unrelated edits',async({page:p})=>{
 const original='早上在市府碰面（司機再通知）';const {detail}=await fixture(p,s=>s.vehicles[0].meeting=original);
 await expect(legacyLine(p,'v1')).toContainText('出發時間待定');await expect(legacyLine(p,'v1')).toContainText(original);
 await openRoutes(p);await expect(legacyRow(p,'v1')).toContainText(`山線小巴・時間待定 / ${original}`);
 await openTripMenu(p);await expect(menuLine(p,'山線小巴')).toHaveText(`第 1 天・出發時間待定：${original}（舊的出發資料）`);await p.keyboard.press('Escape');await expect(menu(p)).not.toBeVisible();
 await openPlaces(p);await editCar(p,'v1','山線小巴');await p.getByLabel('車輛暱稱',{exact:true}).fill('山線慢慢號');await submit(p);
 expect((await detail()).state.vehicles.find(v=>v.id==='v1').meeting).toBe(original);await expect(legacyRow(p,'v1')).toContainText(original);
});

test('轉成路線 opens a first-day Route draft that writes nothing until saved, then a saved Route replaces only that car\'s meeting',async({page:p})=>{
 const {detail}=await fixture(p),before=await detail();await openRoutes(p);
 await p.getByRole('button',{name:'轉成路線 山線小巴',exact:true}).click();
 const c=planCard(p);await expect(c).toBeVisible();await expect(c.locator('[name="vehicle"]')).toHaveValue('v1');await expect(c.locator('[name="time"]')).toHaveValue('09:00');
 await expect(c.locator('[name="from"] option:checked')).toHaveText('台北車站東三門');await expect(c).toContainText(NOTE);
 expect(await detail()).toEqual(before);
 await c.locator('[name="vehicle"]').selectOption('v2');await expect(c).toContainText(NOTE);await c.locator('[name="vehicle"]').selectOption('v1');
 if(await c.locator('[name="to"]').inputValue()==='')await c.locator('[name="to"]').selectOption({index:1});
 await c.locator('[data-action="plan-save"]').click();await expect(planCard(p)).toHaveCount(0);await saved(p);
 const after=await detail();expect(after.state.routes).toHaveLength(1);expect(after.state.routes[0]).toMatchObject({vehicleId:'v1',time:'09:00',stops:[]});
 expect(meetings(after.state)).toEqual(['','08:30 · 台中高鐵站六號出口']);expect(after.state.places.map(x=>x.name)).toContain('台北車站東三門');
 expect(after.state.vehicles[0]).toEqual({...before.state.vehicles[0],meeting:''});expect(after.state.activities).toEqual(before.state.activities);
 await expect(legacyRow(p,'v1')).toHaveCount(0);await expect(legacyRow(p,'v2')).toHaveCount(1);
 await showPoster(p);await expect(legacyLine(p,'v1')).toHaveCount(0);await expect(legacyLine(p,'v2')).toBeVisible();await expect(p.locator('.rm-track[data-line="route"]')).toHaveCount(1);
 await openTripMenu(p);await expect(menuLine(p,'山線小巴')).toHaveText('第 1 天・09:00 出發：台北車站東三門');await expect(menuLine(p,'海風號')).toContainText('（舊的出發資料）');
});

test('不使用舊資料 asks first, a cancel changes nothing, and a confirm clears only that car\'s meeting everywhere',async({page:p})=>{
 const {detail}=await fixture(p),before=await detail();await openRoutes(p);
 const button=p.getByRole('button',{name:'不使用舊資料 海風號',exact:true});
 await button.click();await expect(p.locator('#dialog')).toContainText('不使用舊的出發資料？');await p.locator('#dialog').getByRole('button',{name:'取消',exact:true}).click();await expect(p.locator('#dialog')).not.toBeVisible();
 expect(await detail()).toEqual(before);await expect(legacyRow(p,'v2')).toHaveCount(1);
 await button.click();await expect(p.locator('#dialog')).toContainText('不使用舊的出發資料？');await p.locator('#dialog').getByRole('button',{name:'確認',exact:true}).click();await expect(p.locator('#dialog')).not.toBeVisible();await saved(p);
 const after=await detail();expect(meetings(after.state)).toEqual(['09:00 · 台北車站東三門','']);expect(after.state.vehicles[1]).toEqual({...before.state.vehicles[1],meeting:''});
 expect(after.state.vehicles[0]).toEqual(before.state.vehicles[0]);for(const key of ['activities','meals','shopping','gear','people'])expect(after.state[key]).toEqual(before.state[key]);
 await expect(legacyRow(p,'v2')).toHaveCount(0);await expect(legacyRow(p,'v1')).toHaveCount(1);
 await showPoster(p);await expect(legacyLine(p,'v2')).toHaveCount(0);await expect(legacyLine(p,'v1')).toBeVisible();
 await openTripMenu(p);await expect(menuLine(p,'海風號')).toHaveText('第 1 天還沒有路線');await expect(menuLine(p,'山線小巴')).toContainText('（舊的出發資料）');
 await p.reload();await showPoster(p);await expect(legacyLine(p,'v2')).toHaveCount(0);expect(meetings((await detail()).state)).toEqual(['09:00 · 台北車站東三門','']);
});

test('unsaved route drafts and stale saves never overwrite the newer server plan',async({page:p})=>{
 const {trip,detail}=await fixture(p),before=await detail();await openRoutes(p);
 const convert=p.getByRole('button',{name:'轉成路線 山線小巴',exact:true});
 await convert.click();await planCard(p).locator('[name="time"]').fill('05:55');p.once('dialog',d=>d.accept());await convert.click();await expect(planCard(p)).toHaveCount(0);expect(await detail()).toEqual(before);
 await convert.click();await planCard(p).locator('[name="time"]').fill('07:30');
 const serverState=structuredClone(before.state);serverState.vehicles[0].meeting='06:20 · 別人已更新的出發地點';await api(p,`/api/trips/${trip.id}`,'PUT',{revision:before.trip.revision,state:serverState});
 if(await planCard(p).locator('[name="to"]').inputValue()==='')await planCard(p).locator('[name="to"]').selectOption({index:1});
 await planCard(p).locator('[data-action="plan-save"]').click();await expect(p.locator('.save-warning')).toContainText('其他人已更新');await expect(planCard(p)).toBeVisible();await expect(planCard(p).locator('[name="time"]')).toHaveValue('07:30');
 const latest=await detail();expect(latest.state.vehicles[0].meeting).toBe('06:20 · 別人已更新的出發地點');expect(latest.state.routes??[]).toEqual(before.state.routes??[]);
});

test('[TC-VEH-001] collaborators can edit vehicles and clear legacy departures but cannot delete cars; strangers cannot read the trip',async({page:p,browser})=>{
 const {trip,detail}=await fixture(p);const invite=await api(p,`/api/trips/${trip.id}/invites`,'POST',{});const context=await browser.newContext({baseURL:base});try{
  // 全新 member 帳號取自 harness 帳號池（註冊 API 依用戶端 IP 限速，見 tests/support/e2e-pool.js）。
  const guest=await context.newPage();const {username}=await poolMember(guest,base);
  const denied=await guest.request.get(base+`/api/trips/${trip.id}`);expect(denied.status()).toBe(404);
  await guest.goto(invite.urlPath);await guest.locator('[name=join-name]').fill('分車旅伴');await guest.locator('form button[type=submit]').click();await expect(guest).toHaveURL(new RegExp(`/${username}/trips/`));
  await openRoutes(guest);await expect(legacyRow(guest,'v1')).toBeVisible();await expect(guest.getByRole('button',{name:'轉成路線 山線小巴',exact:true})).toBeVisible();await expect(guest.getByRole('button',{name:'不使用舊資料 山線小巴',exact:true})).toBeVisible();
  await openPlaces(guest);await editCar(guest,'v2','海風號');await expect(guest.getByRole('button',{name:'移除項目',exact:true})).toHaveCount(0);await guest.locator('#edit-form input[name="name"]').fill('海風二號');await submit(guest);
  const renamed=(await detail()).state.vehicles.find(v=>v.id==='v2');expect(renamed.name).toBe('海風二號');expect(renamed.meeting).toBe('08:30 · 台中高鐵站六號出口');
  await openTripMenu(guest);await expect(menuCard(guest,'海風二號')).toHaveCount(1);await expect(menu(guest).locator('[data-action="delete"][data-kind="vehicle"]')).toHaveCount(0);await guest.keyboard.press('Escape');
  await guest.getByRole('button',{name:'不使用舊資料 山線小巴',exact:true}).click();await guest.locator('#dialog').getByRole('button',{name:'確認',exact:true}).click();await expect(guest.locator('#dialog')).not.toBeVisible();await saved(guest);
  expect(meetings((await detail()).state)).toEqual(['','08:30 · 台中高鐵站六號出口']);
  const d=await api(guest,`/api/trips/${trip.id}`);d.state.vehicles=[];const deniedDelete=await guest.request.put(base+`/api/trips/${trip.id}`,{headers:{Origin:base,'Content-Type':'application/json'},data:{revision:d.trip.revision,state:d.state}});expect(deniedDelete.status()).toBe(403);
 }finally{await context.close();}
});

test('legacy rows fit mobile and desktop, long or untrusted text stays safe, print retains the route-map marker',async({page:p})=>{
 const longText='台北車站東三門靠近地下街入口與便利商店前的集合處';
 const {detail}=await fixture(p,s=>{s.vehicles[0].name='<img src=x onerror=alert(1)>';s.vehicles[0].meeting=`09:00 · ${longText}`;s.vehicles.push({id:'v3',name:'午後小車',driver:'',passengers:[],seats:4,meeting:''});});const before=await detail();
 await expect(p.locator('.itinerary-poster img')).toHaveCount(0);await expect(legacyLine(p,'v1')).toContainText('<img src=x onerror=alert(1)>');await expect(legacyLine(p,'v1')).toContainText(longText);await expect(legacyLine(p,'v3')).toHaveCount(0);
 for(const theme of ['light','dark']){await p.evaluate(t=>document.documentElement.dataset.theme=t,theme);for(const width of [320,390,768,1440]){
  await p.setViewportSize({width,height:950});await showPoster(p);await legacyLine(p,'v1').scrollIntoViewIfNeeded();expect(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await openRoutes(p);await expect(legacyRow(p,'v1')).toBeVisible();await expect(legacyRow(p,'v1').locator('img')).toHaveCount(0);
  const boxes=await p.locator('.plan-legacy').evaluateAll(els=>els.map(e=>({w:e.getBoundingClientRect().width,overflow:e.scrollWidth-e.clientWidth})));expect(boxes.length).toBe(2);expect(boxes.every(b=>b.w>0&&b.overflow<=1)).toBe(true);
  expect(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  if(width===390||width===1440)await p.locator('.plan-legacy').first().screenshot({path:`previews/vehicle-departures-legacy-${theme}-${width}.png`});
 }}
 await showPoster(p);await p.emulateMedia({media:'print'});await expect(legacyLine(p,'v1')).toBeVisible();await expect(legacyLine(p,'v1').getByRole('button')).toHaveCount(0);expect(await detail()).toEqual(before);
});

test('demo can clear a legacy departure and reload it offline',async({page:p,context})=>{
 await p.goto('/demo/#/trip');await expect(legacyLine(p,'v1')).toBeVisible();await openRoutes(p);
 await p.getByRole('button',{name:'不使用舊資料 山線小巴',exact:true}).click();await p.locator('#dialog').getByRole('button',{name:'確認',exact:true}).click();await expect(p.locator('#dialog')).not.toBeVisible();await expect(legacyRow(p,'v1')).toHaveCount(0);
 await p.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));});await context.setOffline(true);await p.reload();
 await expect(poster(p)).toBeVisible();await expect(legacyLine(p,'v1')).toHaveCount(0);await expect(legacyLine(p,'v2')).toBeVisible();await openTripMenu(p);await expect(menuLine(p,'山線小巴')).toHaveText('第 1 天還沒有路線');
 expect(await p.evaluate(k=>JSON.parse(localStorage.getItem(k)).vehicles.map(v=>v.meeting),STORAGE_KEY)).toEqual(['',seed().vehicles[1].meeting]);
});


test('empty and time-only legacy locations show as pending and keep their data on an unrelated vehicle edit',async({page:p})=>{
 const {detail}=await fixture(p,s=>{s.vehicles[0].meeting='';s.vehicles[1].meeting='07:00';});
 await expect(legacyLine(p,'v1')).toHaveCount(0);await expect(legacyLine(p,'v2')).toContainText('07:00');await expect(legacyLine(p,'v2')).toContainText('出發地點待定');
 await openRoutes(p);await expect(legacyRow(p,'v1')).toHaveCount(0);await expect(legacyRow(p,'v2')).toContainText('海風號・07:00 / 出發地點待定');
 await openTripMenu(p);await expect(menuLine(p,'山線小巴')).toHaveText('第 1 天還沒有路線');await expect(menuLine(p,'海風號')).toHaveText('第 1 天・07:00 出發：出發地點待定（舊的出發資料）');await p.keyboard.press('Escape');await expect(menu(p)).not.toBeVisible();
 await openPlaces(p);
 for(const [id,old,name,meeting] of [['v1','山線小巴','還在討論的車',''],['v2','海風號','清晨小車','07:00']]){
  await editCar(p,id,old);await p.getByLabel('車輛暱稱',{exact:true}).fill(name);await submit(p);
  expect((await detail()).state.vehicles.find(v=>v.id===id).meeting).toBe(meeting);
 }
});


test('[TC-VEH-003] owner removal from 地點與車 also removes the same car from the trip menu and its legacy row without touching activities',async({page:p})=>{
 const {detail}=await fixture(p),before=await detail();await openRoutes(p);await openPlaces(p);await editCar(p,'v2','海風號');await p.getByRole('button',{name:'移除項目',exact:true}).click();await p.getByRole('button',{name:'確認移除',exact:true}).click();await expect(p.locator('#dialog')).not.toBeVisible();await saved(p);
 await expect(p.locator('.plan-car')).toHaveCount(1);await expect(legacyRow(p,'v2')).toHaveCount(0);await expect(legacyRow(p,'v1')).toHaveCount(1);
 await openTripMenu(p);await expect(menu(p).locator('.vehicle-card')).toHaveCount(1);await expect(menu(p).locator('.vehicle-card')).toContainText('山線小巴');
 const after=await detail();expect(after.state.vehicles).toEqual(before.state.vehicles.filter(v=>v.id!=='v2'));expect(after.state.activities).toEqual(before.state.activities);
 await p.keyboard.press('Escape');await showPoster(p);await expect(legacyLine(p,'v2')).toHaveCount(0);await expect(legacyLine(p,'v1')).toBeVisible();
});
