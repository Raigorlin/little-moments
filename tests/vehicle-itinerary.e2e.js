// trip-planning-workflow-enhance: requirements 1.6 and 3.10 removed the 新增一站 dialog, the activity timeline (.activity-card)
// and the 按車查看行程 selector, and requirement 7.6 and 7.7 moved an Activity's 參加方式 into the Activity card of 規劃行程
// (Itinerary_Editor, 「活動」 segment). So these checks now add and edit Activities in that card, read the 參加： line of the
// Itinerary_Poster, and delete a Vehicle from 地點與車 (Places_And_Cars) or the Trip_Menu. Only the checks that read the
// per-car filtered schedule (按車查看行程) were removed; every other assertion on the saved Trip_State is unchanged.
import { test, expect } from './local-planner-fixture.js';
import { seed, STORAGE_KEY } from '../src/model.js';
import { fileURLToPath } from 'node:url';
const preview = name => fileURLToPath(new URL('../previews/'+name,import.meta.url));
const base = process.env.CAMPING_BASE_URL;
const planCard = p => p.locator('form[data-plan-card]');
const newActivity = p => p.locator('[data-plan-toggle="activity:new"]');
const activityRow = (p, title) => p.locator('.plan-activity').filter({has:p.locator('.plan-row-name',{hasText:new RegExp(`^${title}$`)})});
const moment = (p, title) => p.locator('.moment-card--activity').filter({has:p.locator('.moment-title',{hasText:new RegExp(`^${title}$`)})});
const saved = p => expect(p.locator('.sync-status')).toContainText('已儲存至本機伺服器');
async function api(p,path,method='GET',data) {
  const r=await p.request.fetch(base+path,{method,data,headers:data?{Origin:base,'Content-Type':'application/json'}:{}});
  expect(r.ok(),await r.text()).toBe(true); return r.json();
}
async function fixture(p,modify=()=>{}) {
  const username='qa-admin';
  await api(p,'/api/login','POST',{username,password:'Local-Only-Test-Pass-2026'});
  const s=seed();s.activities=[];s.vehicles[0].name='TEST-CAR-A';s.vehicles[1].name='TEST-CAR-B';modify(s);
  const {trip}=await api(p,'/api/trips','POST',{legacyState:s});
  const created=await api(p,`/api/trips/${trip.id}`);
  if(created.state.vehicles.length){created.state.vehicles[0].passengers=[...created.state.vehicles[0].passengers,created.permissions.personId];created.state.vehicles[0].seats=9;await api(p,`/api/trips/${trip.id}`,'PUT',{revision:created.trip.revision,state:created.state});}
  const path=`/${username}/trips/${trip.id}`;
  await p.goto(path);await expect(p.locator('.hero')).toBeVisible();
  return {trip,path,detail:()=>api(p,`/api/trips/${trip.id}`)};
}
// 規劃行程's 「活動」 segment of day `index` (0-based), where the Activity cards live.
async function openActivities(p,index=0) {
  await p.locator('.plan-view-switch [data-view="editor"]').click();
  await p.locator('[data-plan-nav="day"]').nth(index).click();
  await p.locator('[data-plan-nav="segment"][data-segment="activities"]').click();
  await expect(p.locator('[data-plan-segment="activities"]')).toBeVisible();
}
const showPoster = async p => {await p.locator('.plan-view-switch [data-view="poster"]').click();await expect(p.locator('.itinerary-poster')).toBeVisible();};
async function saveCard(p) {await planCard(p).locator('[data-action="plan-save"]').click();await expect(planCard(p)).toHaveCount(0);}
// Sets 參加方式 on the open Activity card: no ids is 全體旅伴, otherwise 指定車輛 with exactly those cars checked.
async function participate(p,vehicles=[]) {
  const c=planCard(p);
  await c.locator(`[name="participation"][value="${vehicles.length?'vehicles':'all'}"]`).check();
  if(vehicles.length)for(const id of ['v1','v2'])await c.locator(`[name="vehicleIds"][value="${id}"]`).setChecked(vehicles.includes(id));
}
async function add(p,title,time,vehicles=[],type='travel') {
  await newActivity(p).click();const c=planCard(p);
  await c.locator('[name="title"]').fill(title);await c.locator('[name="time"]').fill(time);await c.locator('[name="type"]').selectOption(type);
  await c.locator('[name="location"]').fill('隔離測試地點');
  await participate(p,vehicles);
  await saveCard(p);await saved(p);
}
test.beforeEach(async({baseURL})=>expect(new URL(baseURL).port).toBe('5181'));

test('cars split shopping and pickup through separate arrivals; shared stops and next-stop stay accurate',async({page:p})=>{
  const f=await fixture(p);const before=await f.detail();
  await openActivities(p);
  await add(p,'買食材','13:30',['v1'],'market');await add(p,'接旅伴','13:00',['v2'],'meet');
  await add(p,'B 車先抵達營區','15:00',['v2'],'camp');await add(p,'A 車帶食材抵達','16:00',['v1'],'camp');
  await add(p,'兩台車一起卸貨','16:30',['v1','v2'],'camp');await add(p,'全體晚餐','18:00',[],'meal');
  await activityRow(p,'B 車先抵達營區').locator('[data-activity-check]').check();await saved(p);
  await showPoster(p);
  await expect(p.locator('.moment-card--activity .moment-title')).toHaveText(['接旅伴','買食材','B 車先抵達營區','A 車帶食材抵達','兩台車一起卸貨','全體晚餐']);
  await expect(moment(p,'買食材').locator('.moment-participants')).toHaveText('參加：TEST-CAR-A');
  await expect(moment(p,'接旅伴').locator('.moment-participants')).toHaveText('參加：TEST-CAR-B');
  await expect(moment(p,'兩台車一起卸貨').locator('.moment-participants')).toHaveText('參加：TEST-CAR-A、TEST-CAR-B');
  await expect(moment(p,'全體晚餐').locator('.moment-participants')).toHaveCount(0);
  await p.locator('.itinerary-poster').screenshot({path:preview('itinerary-bve-route.png')});
  const after=await f.detail();for(const key of ['vehicles','people','gear','meals','shopping'])expect(after.state[key]).toEqual(before.state[key]);
  expect(after.state.activities.find(a=>a.title==='買食材')).toMatchObject({vehicleIds:['v1'],people:[]});
  expect(after.state.activities.find(a=>a.title==='全體晚餐')).not.toHaveProperty('vehicleIds');
  await p.goto(f.path+'/go');await expect(p.locator('.next-stop h2')).toHaveText('買食材');await expect(p.locator('.next-stop')).toContainText('TEST-CAR-A');
  await p.goto(f.path);await openActivities(p);await expect(activityRow(p,'買食材')).toBeVisible();await expect(activityRow(p,'A 車帶食材抵達').locator('[data-activity-check]')).not.toBeChecked();
  await expect(activityRow(p,'B 車先抵達營區').locator('[data-activity-check]')).toBeChecked();
  expect(await p.evaluate(k=>localStorage.getItem(k),STORAGE_KEY)).toBeNull();
});

test('legacy people stay exact on unrelated edits and may explicitly switch to one car, multiple cars, then all',async({page:p})=>{
  const f=await fixture(p,s=>s.activities=seed().activities);const before=await f.detail();
  await openActivities(p);
  await activityRow(p,'把好吃的，一起買齊').locator('.plan-row-button').click();await expect(planCard(p).locator('[name="participation"][value="legacy"]')).toBeChecked();
  await planCard(p).locator('[name="note"]').fill('保留原來三位旅伴');await saveCard(p);await saved(p);
  let a=(await f.detail()).state.activities.find(a=>a.id==='a2');expect(a.people).toEqual(before.state.activities.find(a=>a.id==='a2').people);expect(a).not.toHaveProperty('vehicleIds');
  for(const ids of [['v1'],['v1','v2'],[]]){
    await activityRow(p,'把好吃的，一起買齊').locator('.plan-row-button').click();await participate(p,ids);
    await saveCard(p);await saved(p);a=(await f.detail()).state.activities.find(a=>a.id==='a2');expect(a.people).toEqual([]);if(ids.length)expect(a.vehicleIds).toEqual(ids);else expect(a).not.toHaveProperty('vehicleIds');
  }
  expect((await f.detail()).state.activities.filter(a=>a.id!=='a2')).toEqual(before.state.activities.filter(a=>a.id!=='a2'));
});

test('empty vehicle selection and cancelled draft do not save; referenced car cannot be deleted',async({page:p})=>{
  const f=await fixture(p);const before=await f.detail();await openActivities(p);await newActivity(p).click();
  await planCard(p).locator('[name="title"]').fill('還沒選車');await planCard(p).locator('[name="time"]').fill('08:30');await planCard(p).locator('[name="participation"][value="vehicles"]').check();
  await planCard(p).locator('[data-action="plan-save"]').click();await expect(planCard(p).locator('.field-error')).toContainText('至少勾選一台');expect(await f.detail()).toEqual(before);
  p.once('dialog',d=>d.accept());await newActivity(p).click();await expect(planCard(p)).toHaveCount(0);expect(await f.detail()).toEqual(before);
  await add(p,'買食材','13:30',['v1'],'market');const assigned=await f.detail();
  // Places_And_Cars: 編輯 the car, then 移除項目 is refused while an Activity still names it.
  await p.locator('[data-plan-toggle="places"]').click();
  await p.getByRole('button',{name:'編輯 TEST-CAR-A',exact:true}).click();await p.getByRole('button',{name:'移除項目',exact:true}).click();
  await expect(p.locator('.form-error')).toContainText('先把那些行程改派');expect(await f.detail()).toEqual(assigned);
  await p.getByRole('button',{name:'取消',exact:true}).click();await expect(p.locator('#dialog')).not.toBeVisible();
  // Trip_Menu: the same refusal, without opening the dialog.
  await p.getByRole('button',{name:'旅行選單',exact:true}).click();await p.locator('#trip-menu [data-action="delete"][data-kind="vehicle"][data-id="v1"]').click();
  await expect(p.locator('body')).toContainText('這台車仍有指定行程');expect(await f.detail()).toEqual(assigned);
  await p.keyboard.press('Escape');await expect(p.locator('#trip-menu')).not.toBeVisible();
  await activityRow(p,'買食材').locator('.plan-row-button').click();await participate(p,[]);await saveCard(p);await saved(p);
  await p.getByRole('button',{name:'編輯 TEST-CAR-A',exact:true}).click();await p.getByRole('button',{name:'移除項目',exact:true}).click();await p.getByRole('button',{name:'確認移除',exact:true}).click();await saved(p);
  expect((await f.detail()).state.vehicles.map(v=>v.id)).toEqual(['v2']);
  const kept=(await f.detail()).state.activities.find(a=>a.title==='買食材');expect(kept).not.toHaveProperty('vehicleIds');
  await showPoster(p);await expect(moment(p,'買食材').locator('.moment-participants')).toHaveCount(0);
});

test('new activity respects the selected day, draft survives conflict without overwriting the other assignment',async({page:p})=>{
  const f=await fixture(p);await openActivities(p,1);
  await newActivity(p).click();await expect(planCard(p).locator('[name="date"]')).toHaveValue('2026-11-21');await expect(planCard(p).locator('[name="participation"][value="all"]')).toBeChecked();
  await planCard(p).locator('[name="title"]').fill('隔天補給');await planCard(p).locator('[name="time"]').fill('08:30');await participate(p,['v2']);await saveCard(p);await saved(p);
  const before=await f.detail();expect(before.state.activities[0]).toMatchObject({date:'2026-11-21',vehicleIds:['v2']});
  await activityRow(p,'隔天補給').locator('.plan-row-button').click();await planCard(p).locator('[name="vehicleIds"][value="v1"]').check();
  const remote=structuredClone(before.state);remote.activities[0].vehicleIds=['v1'];await api(p,`/api/trips/${f.trip.id}`,'PUT',{revision:before.trip.revision,state:remote});
  await planCard(p).locator('[data-action="plan-save"]').click();await expect(p.locator('.save-warning')).toContainText('其他人已更新');
  await expect(planCard(p)).toBeVisible();await expect(planCard(p).locator('[name="vehicleIds"][value="v1"]')).toBeChecked();await expect(planCard(p).locator('[name="vehicleIds"][value="v2"]')).toBeChecked();
  expect((await f.detail()).state.activities[0].vehicleIds).toEqual(['v1']);
});

test('no vehicles disables car choice',async({page:p})=>{
  const f=await fixture(p,s=>s.vehicles=[]);await expect(p.locator('#schedule-vehicle')).toHaveCount(0);await openActivities(p);await newActivity(p).click();
  await expect(planCard(p).locator('[name="participation"][value="vehicles"]')).toBeDisabled();await expect(planCard(p)).toContainText('還沒有車輛，新增車輛後才能指定車輛');
  await expect(planCard(p).locator('[name="vehicleIds"]')).toHaveCount(0);await newActivity(p).click();await expect(planCard(p)).toHaveCount(0);
  expect((await f.detail()).state.activities).toEqual([]);
});

test('one car can have a specific stop without changing it to everyone',async({page:p})=>{
  const f=await fixture(p,s=>s.vehicles=s.vehicles.slice(0,1));
  await openActivities(p);await newActivity(p).click();
  await planCard(p).locator('[name="title"]').fill('單車接人');await planCard(p).locator('[name="time"]').fill('08:30');await planCard(p).locator('[name="participation"][value="vehicles"]').check();
  await expect(planCard(p).locator('[name="vehicleIds"]')).toHaveCount(1);await planCard(p).locator('[name="vehicleIds"]').check();await expect(planCard(p).locator('[name="vehicleIds"]')).toBeChecked();
  await planCard(p).screenshot({path:preview('itinerary-vehicle-choice.png')});await saveCard(p);await saved(p);
  await showPoster(p);await expect(moment(p,'單車接人').locator('.moment-participants')).toHaveText('參加：TEST-CAR-A');
  expect((await f.detail()).state.activities[0].vehicleIds).toEqual(['v1']);
});

test('countdown remains SVG-centered across breakpoints and themes, illustration animation remains outside badge',async({page:p})=>{
  await p.clock.install({time:new Date('2026-11-04T10:00:00+08:00')});await fixture(p);
  await expect(p.locator('.countdown')).toContainText('16');await expect(p.locator('.hero [data-scene-motion-toggle]')).toHaveCount(0);
  for(const theme of ['light','dark']){await p.evaluate(t=>document.documentElement.dataset.theme=t,theme);for(const width of [320,390,600,768,1024,1440,2560]){
    await p.setViewportSize({width,height:1000});
    const r=await p.evaluate(()=>{const a=document.querySelector('.hero-art').getBoundingClientRect(),s=document.querySelector('.hero-art .scene-motion>svg').getBoundingClientRect(),b=document.querySelector('.countdown').getBoundingClientRect();return {dx:(b.x+b.width/2)-(s.x+s.width/2),dy:(b.y+b.height/2)-(s.y+s.height/2),visible:b.left>=a.left&&b.right<=a.right&&b.top>=a.top&&b.bottom<=a.bottom,overflow:document.documentElement.scrollWidth>innerWidth+1};});
    expect(Math.abs(r.dx)).toBeLessThan(1);expect(Math.abs(r.dy)).toBeLessThan(1);expect(r.visible,JSON.stringify({width,r})).toBe(true);expect(r.overflow).toBe(false);
    if(theme==='light'&&[390,1440].includes(width))await p.locator('.hero').screenshot({path:preview(`itinerary-countdown-${width}.png`)});
  }}
  await p.emulateMedia({reducedMotion:'reduce'});expect(await p.locator('.scene-van').first().evaluate(e=>e.getAnimations().length)).toBe(0);
});

test('mobile vehicle choices wrap untrusted names and remain keyboard accessible with print labels',async({page:p})=>{
  await fixture(p,s=>{s.vehicles[0].name='<img src=x onerror=alert(1)>很長的車名測試';});
  await p.setViewportSize({width:320,height:900});await openActivities(p);await newActivity(p).click();await planCard(p).locator('[name="title"]').fill('小車的路線');await planCard(p).locator('[name="time"]').fill('08:30');
  await planCard(p).locator('[name="participation"][value="vehicles"]').check();const choice=planCard(p).locator('[name="vehicleIds"][value="v1"]');await choice.focus();await p.keyboard.press('Space');await expect(choice).toBeChecked();
  await expect(planCard(p).locator('img')).toHaveCount(0);expect(await planCard(p).evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);await saveCard(p);await saved(p);
  await showPoster(p);
  await expect(moment(p,'小車的路線').locator('.moment-participants')).toContainText('<img src=x onerror=alert(1)>');await expect(moment(p,'小車的路線').locator('img')).toHaveCount(0);
  await p.emulateMedia({media:'print'});await expect(moment(p,'小車的路線').locator('.moment-participants')).toBeVisible();
});

test('demo assignment survives reload offline and legacy backups remain usable',async({page:p,context})=>{
  await p.goto('/demo/#/trip');const before=await p.evaluate(k=>JSON.parse(localStorage.getItem(k)),STORAGE_KEY);
  await openActivities(p);await activityRow(p,'把好吃的，一起買齊').locator('.plan-row-button').click();await participate(p,['v1']);await saveCard(p);
  await p.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));});await context.setOffline(true);await p.reload();
  await expect(p.locator('.itinerary-poster')).toBeVisible();await expect(moment(p,'把好吃的，一起買齊')).toContainText('山線小巴');const after=await p.evaluate(k=>JSON.parse(localStorage.getItem(k)),STORAGE_KEY);expect(after.activities.find(a=>a.id==='a2')).toMatchObject({vehicleIds:['v1'],people:[]});expect(after.vehicles).toEqual(before.vehicles);
});
