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


