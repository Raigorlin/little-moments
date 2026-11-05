import { test, expect } from './local-planner-fixture.js';
import { seed, STORAGE_KEY } from '../src/model.js';
import { fileURLToPath } from 'node:url';
const preview = name => fileURLToPath(new URL('../previews/'+name,import.meta.url));
const base = process.env.CAMPING_BASE_URL;
const form = p => p.locator('#edit-form');
const card = (p, title) => p.locator('.activity-card').filter({has:p.getByRole('heading',{name:title,exact:true})});
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
async function submit(p) {await form(p).locator('button[type=submit]').click();await expect(p.locator('#dialog')).not.toBeVisible();await saved(p);}
async function add(p,title,time,vehicles=[],type='travel') {
  await p.getByRole('button',{name:'新增一站',exact:true}).click();
  await p.getByLabel('活動名稱',{exact:true}).fill(title);await p.getByLabel('時間',{exact:true}).fill(time);await p.getByLabel('活動類型',{exact:true}).selectOption(type);
  await p.getByLabel('地點',{exact:true}).fill('隔離測試地點');
  await p.getByLabel('這一站誰參加',{exact:true}).selectOption(vehicles.length?'vehicles':'all');
  if(vehicles.length)for(const id of ['v1','v2'])await form(p).locator(`[name=vehicleIds][value=${id}]`).setChecked(vehicles.includes(id));
  await submit(p);
}
test.beforeEach(async({baseURL})=>expect(new URL(baseURL).port).toBe('5181'));

test('cars split shopping and pickup through separate arrivals; shared stops and next-stop stay accurate',async({page:p})=>{
  const f=await fixture(p);const before=await f.detail();
  await add(p,'買食材','13:30',['v1'],'market');await add(p,'接旅伴','13:00',['v2'],'meet');
  await add(p,'B 車先抵達營區','15:00',['v2'],'camp');await add(p,'A 車帶食材抵達','16:00',['v1'],'camp');
  await add(p,'兩台車一起卸貨','16:30',['v1','v2'],'camp');await add(p,'全體晚餐','18:00',[],'meal');
  await expect(card(p,'買食材').locator('.activity-bottom>span')).toHaveText('TEST-CAR-A');
  await expect(card(p,'接旅伴').locator('.activity-bottom>span')).toHaveText('TEST-CAR-B');
  await expect(card(p,'兩台車一起卸貨').locator('.activity-bottom>span')).toHaveText('TEST-CAR-A、TEST-CAR-B');
  await expect(card(p,'全體晚餐').locator('.activity-bottom>span')).toHaveText('全體旅伴');
  await card(p,'B 車先抵達營區').getByRole('checkbox').check();await saved(p);
  await p.getByLabel('按車查看行程',{exact:true}).selectOption('v1');
  await expect(p.locator('.activity-card h3')).toHaveText(['買食材','A 車帶食材抵達','兩台車一起卸貨','全體晚餐']);
  await expect(p.locator('.departure-vehicle h3')).toHaveText(['TEST-CAR-A']);
  await p.getByLabel('按車查看行程',{exact:true}).selectOption('v2');
  await expect(p.locator('.activity-card h3')).toHaveText(['接旅伴','B 車先抵達營區','兩台車一起卸貨','全體晚餐']);
  await p.locator('.workspace-main').screenshot({path:preview('itinerary-bve-route.png')});
  const after=await f.detail();for(const key of ['vehicles','people','gear','meals','shopping'])expect(after.state[key]).toEqual(before.state[key]);
  await p.goto(f.path+'/go');await expect(p.locator('.next-stop h2')).toHaveText('買食材');await expect(p.locator('.next-stop')).toContainText('TEST-CAR-A');
  await p.goto(f.path);await expect(card(p,'買食材')).toBeVisible();await expect(card(p,'A 車帶食材抵達').getByRole('checkbox')).not.toBeChecked();
  expect(await p.evaluate(k=>localStorage.getItem(k),STORAGE_KEY)).toBeNull();
});

test('legacy people stay exact on unrelated edits and may explicitly switch to one car, multiple cars, then all',async({page:p})=>{
  const f=await fixture(p,s=>s.activities=seed().activities);const before=await f.detail();
  await card(p,'把好吃的，一起買齊').getByRole('button').click();await expect(p.getByLabel('這一站誰參加',{exact:true})).toHaveValue('legacy');
  await form(p).locator('[name=note]').fill('保留原來三位旅伴');await submit(p);
  let a=(await f.detail()).state.activities.find(a=>a.id==='a2');expect(a.people).toEqual(before.state.activities.find(a=>a.id==='a2').people);expect(a).not.toHaveProperty('vehicleIds');
  for(const ids of [['v1'],['v1','v2'],[]]){
    await card(p,'把好吃的，一起買齊').getByRole('button').click();await p.getByLabel('這一站誰參加',{exact:true}).selectOption(ids.length?'vehicles':'all');
    if(ids.length)for(const id of ['v1','v2'])await form(p).locator(`[name=vehicleIds][value=${id}]`).setChecked(ids.includes(id));
    await submit(p);a=(await f.detail()).state.activities.find(a=>a.id==='a2');expect(a.people).toEqual([]);if(ids.length)expect(a.vehicleIds).toEqual(ids);else expect(a).not.toHaveProperty('vehicleIds');
  }
  expect((await f.detail()).state.activities.filter(a=>a.id!=='a2')).toEqual(before.state.activities.filter(a=>a.id!=='a2'));
});

test('empty vehicle selection and cancelled draft do not save; referenced car cannot be deleted',async({page:p})=>{
  const f=await fixture(p);const before=await f.detail();await p.getByRole('button',{name:'新增一站',exact:true}).click();
  await p.getByLabel('活動名稱',{exact:true}).fill('還沒選車');await p.getByLabel('這一站誰參加',{exact:true}).selectOption('vehicles');
  await form(p).locator('button[type=submit]').click();await expect(p.locator('.form-error')).toContainText('至少選擇一台');expect(await f.detail()).toEqual(before);
  p.once('dialog',d=>d.accept());await p.getByRole('button',{name:'取消',exact:true}).click();expect(await f.detail()).toEqual(before);
  await add(p,'買食材','13:30',['v1'],'market');const assigned=await f.detail();
  await p.locator('[data-vehicle-departure=v1] button').click();await p.getByRole('button',{name:'移除項目',exact:true}).click();
  await expect(p.locator('.form-error')).toContainText('先把那些行程改派');expect(await f.detail()).toEqual(assigned);
  await p.getByRole('button',{name:'取消',exact:true}).click();await card(p,'買食材').getByRole('button').click();await p.getByLabel('這一站誰參加',{exact:true}).selectOption('all');await submit(p);
  await p.locator('[data-vehicle-departure=v1] button').click();await p.getByRole('button',{name:'移除項目',exact:true}).click();await p.getByRole('button',{name:'確認移除',exact:true}).click();await saved(p);
  expect((await f.detail()).state.vehicles.map(v=>v.id)).toEqual(['v2']);await expect(card(p,'買食材')).toContainText('全體旅伴');
});

test('new stop respects selected car and day, draft survives conflict without overwriting the other assignment',async({page:p})=>{
  const f=await fixture(p);await p.getByLabel('按車查看行程',{exact:true}).selectOption('v2');await p.locator('[data-day="2026-11-21"]').click();
  await p.getByRole('button',{name:'新增一站',exact:true}).click();await expect(p.getByLabel('這一站誰參加',{exact:true})).toHaveValue('vehicles');await expect(form(p).locator('[name=vehicleIds][value=v2]')).toBeChecked();
  await p.getByLabel('活動名稱',{exact:true}).fill('隔天補給');await submit(p);const before=await f.detail();expect(before.state.activities[0]).toMatchObject({date:'2026-11-21',vehicleIds:['v2']});
  await card(p,'隔天補給').getByRole('button').click();await form(p).locator('[name=vehicleIds][value=v1]').check();
  const remote=structuredClone(before.state);remote.activities[0].vehicleIds=['v1'];await api(p,`/api/trips/${f.trip.id}`,'PUT',{revision:before.trip.revision,state:remote});
  await form(p).locator('button[type=submit]').click();await expect(p.locator('.save-warning')).toContainText('其他人已更新');
  await expect(card(p,'隔天補給')).toContainText('TEST-CAR-A、TEST-CAR-B');expect((await f.detail()).state.activities[0].vehicleIds).toEqual(['v1']);
});

test('no vehicles disables car choice',async({page:p})=>{
  const f=await fixture(p,s=>s.vehicles=[]);await expect(p.locator('#schedule-vehicle')).toHaveCount(0);await p.getByRole('button',{name:'新增一站',exact:true}).click();
  await expect(form(p).locator('[name=participation] option[value=vehicles]')).toHaveJSProperty('disabled',true);await expect(form(p)).toContainText('請先到「旅伴與車輛」新增車輛');await p.getByRole('button',{name:'取消',exact:true}).click();
  expect((await f.detail()).state.activities).toEqual([]);
});

test('one car can have a specific stop without changing it to everyone',async({page:p})=>{
  const f=await fixture(p,s=>s.vehicles=s.vehicles.slice(0,1));
  await p.getByLabel('按車查看行程',{exact:true}).selectOption('v1');await p.getByRole('button',{name:'新增一站',exact:true}).click();
  await p.getByLabel('活動名稱',{exact:true}).fill('單車接人');await expect(form(p).locator('[name=vehicleIds]')).toHaveCount(1);await expect(form(p).locator('[name=vehicleIds]')).toBeChecked();
  await p.locator('#dialog').screenshot({path:preview('itinerary-vehicle-choice.png')});await submit(p);await expect(card(p,'單車接人').locator('.activity-bottom>span')).toHaveText('TEST-CAR-A');
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
  await p.setViewportSize({width:320,height:900});await p.getByRole('button',{name:'新增一站',exact:true}).click();await p.getByLabel('活動名稱',{exact:true}).fill('小車的路線');
  await p.getByLabel('這一站誰參加',{exact:true}).selectOption('vehicles');const choice=form(p).locator('[name=vehicleIds][value=v1]');await choice.focus();await p.keyboard.press('Space');await expect(choice).toBeChecked();
  await expect(form(p).locator('.activity-vehicle-choices img')).toHaveCount(0);expect(await form(p).evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);await submit(p);
  await expect(card(p,'小車的路線')).toContainText('<img src=x onerror=alert(1)>');await expect(card(p,'小車的路線').locator('img')).toHaveCount(0);
  await p.emulateMedia({media:'print'});await expect(card(p,'小車的路線').locator('.activity-bottom>span')).toBeVisible();
});

test('demo assignment survives reload offline and legacy backups remain usable',async({page:p,context})=>{
  await p.goto('/demo/#/trip');const before=await p.evaluate(k=>JSON.parse(localStorage.getItem(k)),STORAGE_KEY);
  await card(p,'把好吃的，一起買齊').getByRole('button').click();await p.getByLabel('這一站誰參加',{exact:true}).selectOption('vehicles');await form(p).locator('[name=vehicleIds][value=v1]').check();await form(p).locator('button[type=submit]').click();await expect(p.locator('#dialog')).not.toBeVisible();
  await p.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));});await context.setOffline(true);await p.reload();
  await expect(card(p,'把好吃的，一起買齊')).toContainText('山線小巴');const after=await p.evaluate(k=>JSON.parse(localStorage.getItem(k)),STORAGE_KEY);expect(after.activities.find(a=>a.id==='a2')).toMatchObject({vehicleIds:['v1'],people:[]});expect(after.vehicles).toEqual(before.vehicles);
});
