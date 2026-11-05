import {test,expect} from './local-planner-fixture.js';
import {seed} from '../src/model.js';
const base=process.env.CAMPING_BASE_URL;
const address='台北車站';
async function api(p,path,method='GET',body){const r=await p.request.fetch(base+path,{method,data:body,headers:body?{Origin:base,'Content-Type':'application/json'}:{}});expect(r.ok(),await r.text()).toBe(true);return r.json();}
test.beforeEach(async({baseURL})=>expect(new URL(baseURL).port).toBe('5181'));
test('destination, activity and car links open encoded Google Maps without writing trip data or prefetching Google',async({page:p})=>{
 await api(p,'/api/login','POST',{username:'qa-admin',password:'Local-Only-Test-Pass-2026'});
 const state=seed();state.trip.destination=address;state.activities[0].location=address;state.vehicles[0].meeting='07:30 · 台北車站東三門';
 const {trip}=await api(p,'/api/trips','POST',{legacyState:state});const before=await api(p,`/api/trips/${trip.id}`),external=[];
 p.on('request',r=>{if(new URL(r.url()).origin!==base)external.push(r.url());});
 await p.goto(`/qa-admin/trips/${trip.id}`);await expect(p.locator('.hero-destination .map-link')).toBeVisible();
 const check=async(link,query)=>{await expect(link).toHaveAttribute('target','_blank');await expect(link).toHaveAttribute('rel','noopener noreferrer');const u=new URL(await link.getAttribute('href'));expect(u.origin).toBe('https://www.google.com');expect(u.searchParams.get('api')).toBe('1');expect(u.searchParams.get('query')).toBe(query);};
 await check(p.locator('.hero-destination .map-link'),address);await check(p.locator('.activity-card .map-link').first(),address);await check(p.locator('[data-vehicle-departure="v1"] .map-link'),'台北車站東三門');
 await p.locator('.section-tabs [data-tab="crew"]').click();await check(p.locator('.vehicle-card .map-link').first(),'台北車站東三門');
 for(const width of [320,390,1440]){await p.setViewportSize({width,height:950});expect(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);}
 expect(external).toEqual([]);expect(await api(p,`/api/trips/${trip.id}`)).toEqual(before);
});
test('untrusted location text is rendered only as escaped text on a fixed Google origin',async({page:p})=>{
 await api(p,'/api/login','POST',{username:'qa-admin',password:'Local-Only-Test-Pass-2026'});const state=seed();const text='<img src=x onerror=alert(1)> & "地點"';state.trip.destination=text;state.activities[0].location='javascript:alert(1)';
 const {trip}=await api(p,'/api/trips','POST',{legacyState:state});await p.goto(`/qa-admin/trips/${trip.id}`);await expect(p.locator('.hero-destination .map-link')).toContainText(text);await expect(p.locator('.hero-destination img')).toHaveCount(0);
 const href=await p.locator('.hero-destination .map-link').getAttribute('href');expect(new URL(href).searchParams.get('query')).toBe(text);expect(new URL(href).origin).toBe('https://www.google.com');
});
