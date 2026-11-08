import {test,expect} from './local-planner-fixture.js';
import {seed,STORAGE_KEY} from '../src/model.js';
import {dailyNote} from '../src/daily-notes.js';
const base=process.env.CAMPING_BASE_URL;
const nav=(p,t)=>p.locator(`.section-tabs [data-tab="${t}"]`).click();
const openTripMenu=page=>page.getByRole('button',{name:'旅行選單',exact:true}).click();
const closeTripMenu=page=>page.getByRole('button',{name:'關閉旅行選單',exact:true}).click();
async function api(p,path,method='GET',body){const r=await p.request.fetch(base+path,{method,data:body,headers:body?{Origin:base,'Content-Type':'application/json'}:{}});expect(r.ok(),await r.text()).toBe(true);return r.json();}
async function fixture(p){
 await api(p,'/api/login','POST',{username:'qa-admin',password:'Local-Only-Test-Pass-2026'});
 const {trip}=await api(p,'/api/trips','POST',{legacyState:seed()});await p.goto(`/qa-admin/trips/${trip.id}`);
 return ()=>api(p,`/api/trips/${trip.id}`);
}
test.beforeEach(async({baseURL})=>expect(new URL(baseURL).port).toBe('5181'));
test('daily note stays stable across tabs and reload without changing trip data',async({page:p})=>{
 const time=new Date('2026-11-04T12:00:00+08:00');await p.clock.setFixedTime(time);
 const detail=await fixture(p),before=await detail(),expected=dailyNote(time);
 for(const tab of ['schedule','meals','shopping','gear']){await nav(p,tab);await expect(p.locator('[data-daily-quote]')).toHaveText(expected.text);}
 await p.reload();await expect(p.locator('[data-daily-quote]')).toHaveText(expected.text);await expect(p.locator('[data-daily-date]')).toHaveAttribute('datetime','2026-11-04');
 expect(await detail()).toEqual(before);expect(await p.evaluate(k=>localStorage.getItem(k),STORAGE_KEY)).toBeNull();
});
test('Taipei midnight refreshes only the note and preserves an open meal draft',async({page:p})=>{
 const time=new Date('2026-11-04T23:59:58+08:00');await p.clock.install({time});await p.clock.pauseAt(time);
 const detail=await fixture(p),before=await detail();await nav(p,'meals');await p.getByRole('button',{name:'新增餐次',exact:true}).click();
 await p.getByRole('textbox',{name:'料理名稱',exact:true}).fill('跨日仍要保留的草稿');await p.clock.runFor(2200);
 await expect(p.locator('[data-daily-date]')).toHaveAttribute('datetime','2026-11-05');await expect(p.locator('[data-daily-quote]')).toHaveText(dailyNote(new Date('2026-11-05T00:00:00+08:00')).text);
 await expect(p.locator('#dialog')).toBeVisible();await expect(p.getByRole('textbox',{name:'料理名稱',exact:true})).toHaveValue('跨日仍要保留的草稿');expect(await detail()).toEqual(before);
 p.once('dialog',d=>d.accept());await p.getByRole('button',{name:'取消',exact:true}).click();
});
test('daily note fits mobile and dark mode and remains available offline in the demo',async({page:p,context})=>{
 await p.goto('/demo/#/trip');const quote=await p.locator('[data-daily-quote]').textContent();
 for(const theme of ['light','dark']){await p.evaluate(t=>document.documentElement.dataset.theme=t,theme);for(const width of [320,390,1440]){
  await p.setViewportSize({width,height:950});await p.locator('.daily-note').scrollIntoViewIfNeeded();await expect(p.locator('[data-daily-quote]')).toHaveText(quote);expect(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  if(width===390)await p.locator('.daily-note').screenshot({path:`previews/daily-note-${theme}.png`});
 }}
 await p.evaluate(()=>navigator.serviceWorker.ready);await context.setOffline(true);await p.reload();await expect(p.locator('[data-daily-quote]')).toHaveText(quote);
});

test('existing van moves without changing its artwork; pause, reduced motion and print stop it',async({page:p})=>{
 const detail=await fixture(p),before=await detail();const van=p.locator('.hero .scene-van'),bounce=p.locator('.hero .scene-van-bounce');
 await expect(van).toBeVisible();expect(await van.evaluate(e=>e.getAnimations().map(a=>a.animationName))).toContain('scene-van-drive');
 const samples=await van.evaluate(e=>{const a=e.getAnimations()[0],original=a.currentTime;a.currentTime=0;const start=getComputedStyle(e).transform;a.currentTime=4500;const middle=getComputedStyle(e).transform;a.currentTime=original;return {start,middle};});expect(samples.start).not.toBe(samples.middle);
 expect(await bounce.evaluate(e=>e.getAnimations().map(a=>a.animationName))).toContain('scene-van-bounce');
 await expect(p.locator('.hero [data-scene-motion-toggle], .hero .scene-motion__toggle, .hero .motion-settings')).toHaveCount(0);
 const settings=p.locator('#trip-menu .motion-settings'),toggle=settings.locator('[data-scene-motion-toggle]'),html=p.locator('html');
 await openTripMenu(p);await expect(toggle).toHaveAccessibleName('暫停動畫');await toggle.click();await expect(html).toHaveAttribute('data-scene-motion','paused');
 expect(await van.evaluate(e=>e.getAnimations()[0].playState)).toBe('paused');expect(await bounce.evaluate(e=>e.getAnimations()[0].playState)).toBe('paused');
 await closeTripMenu(p);await nav(p,'schedule');await expect(html).toHaveAttribute('data-scene-motion','paused');expect(await van.evaluate(e=>e.getAnimations()[0].playState)).toBe('paused');
 await p.reload();await expect(html).toHaveAttribute('data-scene-motion','paused');expect(await van.evaluate(e=>e.getAnimations()[0].playState)).toBe('paused');
 await openTripMenu(p);await expect(toggle).toHaveAccessibleName('播放動畫');await toggle.click();await expect(html).toHaveAttribute('data-scene-motion','running');expect(await van.evaluate(e=>e.getAnimations()[0].playState)).toBe('running');
 await p.emulateMedia({reducedMotion:'reduce'});expect(await van.evaluate(e=>e.getAnimations().length)).toBe(0);await expect(toggle).toBeHidden();await expect(settings.locator('[data-motion-reduced-note]')).toBeVisible();
 await p.emulateMedia({reducedMotion:'no-preference',media:'print'});expect(await van.evaluate(e=>e.getAnimations().length)).toBe(0);expect(await van.evaluate(e=>getComputedStyle(e).transform)).toBe('none');
 await p.emulateMedia({media:'screen'});expect(await detail()).toEqual(before);
 await p.goto('/qa-admin/home');expect(await p.locator('.acct-trip-art .scene-van').first().evaluate(e=>e.getAnimations().length)).toBe(0);
 await expect(p.locator('.hero [data-scene-motion-toggle], .hero .scene-motion__toggle, .hero .motion-settings')).toHaveCount(0);await expect(p.locator('details.display-preferences .motion-settings [data-scene-motion-toggle]')).toHaveCount(1);
});
