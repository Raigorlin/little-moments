// trip-planning-workflow-enhance: requirements 22.2 and 23.11 replaced the 行程 tab's old timeline, 活動 cards and 各車出發 cards with the 行程圖
// (Itinerary_Poster), its expandable 文字版 (Text_Panel) and the Itinerary_Editor. So [TC-XSS-003] now reads the schedule tab's payloads from the
// 行程圖 and the expanded Text_Panel instead of the removed screens, and [TC-XSS-005] (new) covers the poster, Text_Panel and editor in detail.
// No check of existing behavior was dropped.
// Feature: security-hardening, task 9.5. Stored XSS checks across every page that renders User_Content.
// Requirements 1.12, 9.1, 9.6, 11.9.
//
// Every XSS_Payload_Set string (and sentinel variants that set window.__xss) is stored through the API in
// trip fields, participant names and roles, activities, meals, shopping, gear, vehicles, events, display
// names, and ledger titles and notes. The pages are then loaded in browser contexts that fail on:
//  - any dialog (alert/confirm/prompt), any pageerror, any securitypolicyviolation;
//  - a write to window.__xss (a non-configurable setter installed before page scripts reports it);
//  - an unexpected element. A MutationObserver installed before page scripts inspects every element ever
//    attached (including ones removed again) plus a final full-DOM scan. The app itself renders inline SVG
//    icons and art, its bundle scripts, and an <img> only for the receipt preview (a blob: URL), and it never
//    uses inline event-handler attributes (the CSP has no 'unsafe-inline' in script-src). So an element is
//    unexpected when it is an iframe/frame/object/embed, a script without src or from another origin, an img
//    whose src is not a blob: URL, or any element carrying an on* attribute or a javascript: URL. Payload
//    markup that reached an HTML_Sink unescaped produces exactly these elements, while the app's own
//    markup never does, so the check needs no per-page element counts.
// Each payload must also appear in the page's rendered text (document.body.innerText) exactly as stored.
// [TC-XSS-005] (trip-planning-workflow-enhance, task 13.7; requirements 22.1, 22.2, 22.4, 23.9) applies the same detectors to
// the Itinerary_Poster, the expanded Text_Panel and the Itinerary_Editor, and also fails on any request to another origin.
//
// Budget: one registered account (the signed-out invite registration); the owner and the signed-in invitee are
// harness pool accounts renamed by the admin (tests/support/e2e-pool.js), and there are no failed logins, so this file
// fits next to tests/security-pages.e2e.js in one check-accounts.mjs run.
import {test,expect} from '@playwright/test';
import {seed} from '../src/model.js';
import {poolLogin} from './support/e2e-pool.js';

const testBase=process.env.CAMPING_BASE_URL;
const password='Local-Only-Test-Pass-2026';
const adminName='qa-admin';
const slug=prefix=>`${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;

// XSS_Payload_Set from the requirements glossary, verbatim.
const P=['<script>alert(1)</script>','"><img src=x onerror=alert(1)>',"'><svg onload=alert(1)>",'javascript:alert(1)','`${alert(1)}`','</textarea><script>alert(1)</script>'];
// Sentinel variants: if any of these runs, window.__xss is assigned and the setter reports it.
const S=['<img src=x onerror=__xss=1>','<svg onload=__xss=1>','<script>__xss=1</script>','<iframe srcdoc="<script>parent.__xss=1</script>">','"><img src=x onerror=__xss=1>'];
const ALL=[...P,...S];

// Field assignment. Names and display names allow at most 30 characters, so P[5] (36 characters) goes only
// into longer fields (trip title, role, activity note, shopping, gear, ledger).
const DISPLAY={owner:P[0],invitee:P[1],registrant:P[2]};
const JOIN_NAME={invitee:S[4],registrant:S[1]};
function payloadState(){
 const s=seed();
 Object.assign(s.trip,{title:P[5],destination:P[1],description:S[3],note:P[3]});
 const people={p2:[P[1],P[5]],p3:[P[2],S[2]],p4:[P[3],null],p5:[P[4],null],p6:[S[0],null]};
 for(const p of s.people)if(people[p.id]){p.name=people[p.id][0];if(people[p.id][1])p.role=people[p.id][1];}
 const byId=(list,id)=>list.find(x=>x.id===id);
 Object.assign(byId(s.activities,'a1'),{title:P[0],location:P[2],note:P[4]});
 Object.assign(byId(s.activities,'a2'),{title:S[2],location:S[3],note:P[5]});
 Object.assign(byId(s.meals,'m1'),{title:P[1],ingredients:P[3],notes:S[3]});
 Object.assign(byId(s.meals,'m2'),{title:S[0]});
 Object.assign(byId(s.shopping,'s1'),{name:P[2],quantity:P[4]});
 Object.assign(byId(s.shopping,'s2'),{name:P[5]});
 Object.assign(byId(s.gear,'g1'),{name:P[5]});
 Object.assign(byId(s.gear,'g5'),{name:P[3]});
 Object.assign(byId(s.gear,'g6'),{name:S[0]});
 Object.assign(byId(s.vehicles,'v1'),{name:P[4],meeting:P[0]});
 Object.assign(s.events[0],{text:S[0],actor:P[1]});
 return s;
}
const expenseRows=()=>ALL.map((title,i)=>({id:`xss-${i}`,date:'2026-11-19',title,amountCents:1000+i,payerId:'p2',participantIds:['p2','p3'],category:'食材',note:ALL[(i+1)%ALL.length],shoppingId:'',source:'manual',receiptId:'',receiptLine:''}));

async function api(request,path,method='GET',body){
 const res=await request.fetch(testBase+path,{method,headers:body?{'Content-Type':'application/json',Origin:testBase}:{},data:body});
 let data=null;try{data=await res.json();}catch{}
 expect(res.status(),`${method} ${path}: ${JSON.stringify(data)}`).toBeLessThan(300);
 return data;
}

// Installs the detectors on a context before any page opens; returns the list of problems found.
async function guard(context,label){
 const problems=[];
 await context.exposeBinding('__xssReport',(source,kind,detail)=>{problems.push(`${label} ${source.page?.url()}: ${kind}: ${detail}`);});
 await context.addInitScript(()=>{
  const report=(kind,detail)=>{try{window.__xssReport(kind,String(detail).slice(0,300));}catch{}};
  Object.defineProperty(window,'__xss',{configurable:false,get(){return undefined;},set(){report('sentinel','window.__xss was assigned');}});
  document.addEventListener('securitypolicyviolation',ev=>report('csp',`${ev.violatedDirective} blocked=${ev.blockedURI} sample=${ev.sample}`),true);
  const URL_ATTRS=/^(href|src|action|formaction|xlink:href|data|srcdoc)$/i;
  const verdict=el=>{
   const tag=el.localName;
   if(['iframe','frame','object','embed'].includes(tag))return `<${tag}> element`;
   if(tag==='script'){
    const src=el.getAttribute('src');
    if(!src)return 'inline <script> element';
    if(new URL(src,location.href).origin!==location.origin)return `foreign <script src="${src}">`;
   }
   if(tag==='img'&&!(el.getAttribute('src')||'').startsWith('blob:'))return `<img src="${el.getAttribute('src')}">`;
   for(const a of el.attributes){
    if(/^on/i.test(a.name))return `<${tag} ${a.name}="${a.value}">`;
    if(URL_ATTRS.test(a.name)&&/^\s*javascript:/i.test(a.value))return `<${tag} ${a.name}="${a.value}">`;
   }
   return null;
  };
  const seen=new WeakSet();
  const inspect=root=>{
   if(!(root instanceof Element))return;
   for(const el of [root,...root.querySelectorAll('*')]){
    if(seen.has(el))continue;seen.add(el);
    const bad=verdict(el);if(bad)report('element',`${bad} in ${el.parentElement?.closest('[id],[class]')?.outerHTML.slice(0,120)??el.parentElement?.localName??'(detached)'}`);
   }
  };
  window.__xssScan=()=>{for(const el of document.querySelectorAll('*')){const bad=verdict(el);if(bad)report('element',`${bad} (final scan)`);}};
  new MutationObserver(records=>{for(const r of records){
   if(r.type==='attributes'){const bad=verdict(r.target);if(bad)report('element',`${bad} (attribute change)`);}
   else r.addedNodes.forEach(inspect);
  }}).observe(document,{childList:true,subtree:true,attributes:true});
 });
 context.on('page',page=>{
  page.on('dialog',async d=>{problems.push(`${label} ${page.url()}: dialog ${d.type()}: ${d.message()}`);await d.dismiss().catch(()=>{});});
  page.on('pageerror',err=>problems.push(`${label} ${page.url()}: pageerror: ${err.message}`));
 });
 return problems;
}

// Waits for the page to render every payload (data loads asynchronously), then checks every payload is
// visible text and that no detector fired.
async function check(page,problems,where,values){
 await page.waitForFunction(list=>list.every(v=>document.body?.innerText.includes(v)),values,{timeout:15000}).catch(()=>{});
 await page.waitForLoadState('networkidle',{timeout:5000}).catch(()=>{});
 const text=await page.evaluate(()=>{window.__xssScan();return document.body.innerText;});
 for(const v of values)expect(text.includes(v),`${where}: payload ${JSON.stringify(v)} is not shown as text`).toBe(true);
 expect(await page.evaluate(()=>window.__xss),`${where}: sentinel`).toBeUndefined();
 expect(problems,`${where}: script ran or markup was injected`).toEqual([]);
}

test.describe.configure({mode:'serial'});

const ctx={};
test.beforeAll(async({browser,baseURL})=>{
 if(!baseURL||new URL(baseURL).port!=='5181')throw new Error('Security XSS tests must use the isolated test server on port 5181.');
 // Pool account 1 of 2: the trip owner, whose display name is also the inviter and Invite_List creator name.
 ctx.owner=await browser.newContext({baseURL:testBase});
 ctx.ownerProblems=await guard(ctx.owner,'owner');
 ctx.ownerUser=await poolLogin(ctx.owner.request,testBase,{displayName:DISPLAY.owner});
 expect(ctx.ownerUser.displayName).toBe(DISPLAY.owner);
 const {trip}=await api(ctx.owner.request,'/api/trips','POST',{legacyState:payloadState()});
 ctx.trip=trip;
 const tripPath=`/api/trips/${trip.id}`;
 const stored=await api(ctx.owner.request,tripPath);
 expect(stored.state.trip.title).toBe(P[5]);
 expect(stored.state.people.map(p=>p.name)).toEqual(expect.arrayContaining([P[0],P[1],P[2],P[3],P[4],S[0]]));
 const {ledger}=await api(ctx.owner.request,`${tripPath}/ledger`);
 await api(ctx.owner.request,`${tripPath}/ledger`,'PUT',{expectedUserId:ctx.ownerUser.id,revision:ledger.revision,requestId:crypto.randomUUID(),expenses:expenseRows(),settlements:[{id:'xss-settle',date:'2026-11-22',fromId:'p3',toId:'p2',amountCents:500,note:P[5]}]});
 const saved=await api(ctx.owner.request,`${tripPath}/ledger`);
 expect(saved.ledger.expenses.map(x=>x.title)).toEqual(ALL);
 // One invite each for the signed-in invitee, the signed-out registrant, and the Invitation_Dialog list.
 ctx.invites=[];
 for(let i=0;i<3;i++)ctx.invites.push(await api(ctx.owner.request,`${tripPath}/invites`,'POST',{}));
});
test.afterAll(async()=>{for(const c of [ctx.owner,ctx.invitee,ctx.anon,ctx.admin])await c?.close();});

test('[TC-XSS-001] signed-out invite page shows the Invite_Preview payloads as text',async({browser})=>{
 ctx.anon=await browser.newContext({baseURL:testBase});
 const problems=await guard(ctx.anon,'signed-out');
 const page=await ctx.anon.newPage();
 await page.goto(ctx.invites[1].urlPath);
 await expect(page.locator('form[data-form="acct-invite-register"]')).toBeVisible();
 await check(page,problems,'signed-out invite page',[P[5],P[1],P[0]]);
 // The one registered account: registers through this invite with payload display and participant names.
 const r=await api(ctx.anon.request,`/api/invites/${ctx.invites[1].token}/register`,'POST',{username:slug('qa-xss-c'),displayName:DISPLAY.registrant,password,name:JOIN_NAME.registrant});
 expect(r.user.displayName).toBe(DISPLAY.registrant);
});

test('[TC-XSS-002] signed-in invite page shows the trip payloads as text',async({browser})=>{
 ctx.invitee=await browser.newContext({baseURL:testBase});
 const problems=await guard(ctx.invitee,'invitee');
 // Pool account 2 of 2.
 await poolLogin(ctx.invitee.request,testBase,{displayName:DISPLAY.invitee});
 const page=await ctx.invitee.newPage();
 await page.goto(ctx.invites[0].urlPath);
 await check(page,problems,'signed-in invite page',[P[5],P[1]]);
 await api(ctx.invitee.request,`/api/invites/${ctx.invites[0].token}/join`,'POST',{name:JOIN_NAME.invitee});
});

// BEGIN planner-xss (shared by [TC-XSS-005]; keep this block free of references to the account-mode context)
// Itinerary tab checks (requirements 22.1, 22.2, 22.4, 23.9). Every XSS_Payload_Set string (P) is stored in each field
// that keeps it whole: Place names, car names, Activity titles, locations and notes, Stop notes (non-shopping Stops),
// Day_Titles (20 characters at most, so only P[3] and P[4]), meal titles and ingredients, names of shopping items listed at a
// Shopping_Stop, and names of participants who buy an item but ride in no car (shown in the 「未分配採買清單」 reasons).
const PLAN_DAY_1='2026-10-20',PLAN_DAY_2='2026-10-21';
const PLAN_PLACE_IDS=['pl-a','pl-b','pl-c','pl-d','pl-shop','pl-taipei'];
function planState(exampleTrip,syncMealIngredients){
 const s=exampleTrip();
 const byId=(list,id)=>list.find(x=>x.id===id);
 PLAN_PLACE_IDS.forEach((id,i)=>{byId(s.places,id).name=P[i];});
 ['v1','v2','v3','v4'].forEach((id,i)=>{byId(s.vehicles,id).name=P[i];});
 // Two more cars with ordinary drivers, and five buyers who ride in no car.
 s.people.push({id:'p9',name:'車手九',color:'coral',role:''},{id:'p10',name:'車手十',color:'blue',role:''});
 s.vehicles.push({id:'v5',name:P[4],driver:'p9',seats:4,passengers:[],meeting:''},{id:'v6',name:P[5],driver:'p10',seats:4,passengers:[],meeting:''});
 s.routes.push({id:'rt-1-v5',date:PLAN_DAY_1,vehicleId:'v5',from:'pl-a',to:'@destination',time:'10:00',stops:[]},{id:'rt-1-v6',date:PLAN_DAY_1,vehicleId:'v6',from:'pl-b',to:'@destination',time:'10:30',stops:[]});
 // Six non-shopping Stops, each with a payload note, on the first car's route.
 byId(s.routes,'rt-1-v1').stops=P.map((note,i)=>({id:`st-${i+2}`,place:PLAN_PLACE_IDS[(i+1)%5],kind:['pickup','gear','other'][i%3],note}));
 s.daySettings.find(x=>x.date===PLAN_DAY_1).title=P[3];s.daySettings.find(x=>x.date===PLAN_DAY_2).title=P[4];
 // Six Activities on day 1 so every card can be opened from the same day.
 ['a1','a2','a3','a4','a5','a6'].forEach((id,i)=>Object.assign(byId(s.activities,id),{date:PLAN_DAY_1,title:P[i],location:P[(i+1)%6],note:P[(i+2)%6]}));
 ['m1','m2','m3','m4','m5'].forEach((id,i)=>{byId(s.meals,id).title=P[i];});
 byId(s.meals,'m1').ingredients=`${P[0]}、${P[1]}`;byId(s.meals,'m4').ingredients=`${P[2]}、${P[3]}`;byId(s.meals,'m5').ingredients=`${P[4]}、${P[5]}`;
 s.meals.push({id:'m6',date:PLAN_DAY_2,slot:'消夜',title:P[5],cookId:'',servings:8,ingredients:'',notes:''});
 // s1 to s6 are bought by the drivers and passengers of the car that stops at 超市／賣場 (品項 s7 and s8 keep plain names).
 ['s1','s2','s3','s4','s5','s6'].forEach((id,i)=>{byId(s.shopping,id).name=P[i];});
 for(let i=0;i<5;i++){
  s.people.push({id:`p${11+i}`,name:P[i],color:'green',role:''});
  s.shopping.push({id:`xs${i+1}`,name:P[i],quantity:'',category:'其他',assignee:`p${11+i}`,done:false,source:'manual'});
 }
 syncMealIngredients(s);
 return s;
}
// Requests to another origin (a map link opened by the user is not a request of the page).
function trackForeign(page,origin){
 const found=[];
 page.on('request',request=>{let url;try{url=new URL(request.url());}catch{return;}if(/^https?:$/.test(url.protocol)&&url.origin!==origin)found.push(request.url());});
 return found;
}
async function assertClean(page,problems,foreign,where){
 await page.evaluate(()=>window.__xssScan());
 expect(await page.evaluate(()=>window.__xss),`${where}: sentinel`).toBeUndefined();
 expect(problems,`${where}: script ran or markup was injected`).toEqual([]);
 expect(foreign,`${where}: request to another origin`).toEqual([]);
}
const trimmed=async locator=>(await locator.allInnerTexts()).map(t=>t.trim());
async function checkPlanner(page,problems,foreign){
 const poster=page.locator('.itinerary-poster');
 await expect(poster).toBeVisible();
 // Itinerary_Poster and the expanded Text_Panel: the payloads are text, never markup.
 const toggle=page.locator('[data-text-panel=toggle]');
 if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
 const body=page.locator('#text-panel-body');
 await expect(body).toBeVisible();
 const text=await body.innerText();
 const posterText=await poster.innerText();
 for(const v of P){
  expect(text,`Text_Panel: ${JSON.stringify(v)}`).toContain(v);
  expect(posterText,`Itinerary_Poster: ${JSON.stringify(v)}`).toContain(v);
 }
 await expect(body.locator('*')).toHaveCount(0);
 await assertClean(page,problems,foreign,'Itinerary_Poster and Text_Panel');

 // Itinerary_Editor: Places_And_Cars.
 await page.locator('.plan-view-switch [data-view="editor"]').click();
 await expect(page.locator('.itinerary-editor')).toBeVisible();
 await page.locator('[data-plan-toggle="places"]').click();
 await expect(page.locator('.plan-places-list')).toBeVisible();
 const places=await trimmed(page.locator('.plan-places-list .plan-place .plan-row-name'));
 expect(places).toEqual(expect.arrayContaining(P));
 const cars=await trimmed(page.locator('.plan-cars-list .plan-car .plan-row-name'));
 expect(cars).toEqual(expect.arrayContaining(P));
 await assertClean(page,problems,foreign,'Places_And_Cars');

 // Route cards: the car with six Stop notes, then the car that shops (item preview).
 const card=page.locator('form[data-plan-card]');
 await page.locator('li.plan-route[data-id="rt-1-v1"] .plan-row-button').click();
 await expect(card).toBeVisible();
 await expect(card.locator('[name="from"] option:checked')).toHaveText(P[0]);
 const notes=card.locator('input[name$="-note"]');
 await expect(notes).toHaveCount(P.length);
 for(let i=0;i<P.length;i++)await expect(notes.nth(i)).toHaveValue(P[i]);
 await assertClean(page,problems,foreign,'Route card with Stop notes');
 await page.locator('li.plan-route[data-id="rt-1-v3"] .plan-row-button').click();
 await expect(card.locator('.plan-preview-items li').first()).toBeVisible();
 expect(await trimmed(card.locator('.plan-preview-items li'))).toEqual(expect.arrayContaining(P));
 await assertClean(page,problems,foreign,'Route card with item preview');

 // 「未分配採買清單」: item names and the 「{旅伴名}不在任何車上」 reasons.
 await page.locator('[data-plan-toggle="unassigned"]').click();
 const unassigned=page.locator('.plan-unassigned-list');
 await expect(unassigned).toBeVisible();
 const reasons=await trimmed(unassigned.locator('.help'));
 for(const v of P.slice(0,5))expect(reasons,`未分配採買清單: ${JSON.stringify(v)}`).toContain(`${v}不在任何車上`);
 expect(await trimmed(unassigned.locator('li li'))).toEqual(expect.arrayContaining(P.slice(0,5).map(v=>expect.stringContaining(v))));
 await assertClean(page,problems,foreign,'未分配採買清單');

 // Activity cards, one after another.
 await page.locator('[data-plan-nav="segment"][data-segment="activities"]').click();
 for(let i=0;i<6;i++){
  const row=page.locator(`li.plan-activity[data-id="a${i+1}"]`);
  await expect(row.locator('.plan-row-name')).toHaveText(P[i]);
  await row.locator('.plan-row-button').click();
  await expect(card).toBeVisible();
  await expect(card.locator('[name="title"]')).toHaveValue(P[i]);
  await expect(card.locator('[name="location"]')).toHaveValue(P[(i+1)%6]);
  await expect(card.locator('[name="note"]')).toHaveValue(P[(i+2)%6]);
  await assertClean(page,problems,foreign,`Activity card a${i+1}`);
 }
}
// END planner-xss

// Runs before [TC-XSS-003] on purpose: in serial mode a failure there would otherwise skip this one.

test('[TC-XSS-003] home page, trip page tabs, Invitation_Dialog and expenses view render every payload as text',async()=>{
 test.setTimeout(120000);
 const problems=ctx.ownerProblems;
 const page=await ctx.owner.newPage();
 await page.goto(`/${ctx.ownerUser.username}/home`);
 await check(page,problems,'home page',[P[5],P[1]]);

 await page.goto(`/${ctx.ownerUser.username}/trips/${ctx.trip.id}`);
 await expect(page.locator('#trip-title')).toHaveText(P[5]);
 const seenText=new Set();
 const collect=async()=>{const t=await page.evaluate(()=>document.body.innerText);for(const v of ALL)if(t.includes(v))seenText.add(v);};
 for(const tab of ['schedule','meals','shopping','gear']){
  await page.locator(`.section-tabs [data-tab="${tab}"]`).click();
  await check(page,problems,`trip page ${tab} tab`,[P[5]]);
  if(tab==='schedule'){
   // The 行程圖 is shown at once; the Text_Panel body is written only while it is expanded.
   await expect(page.locator('.itinerary-poster')).toBeVisible();
   const toggle=page.locator('[data-text-panel=toggle]');
   if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
   await expect(page.locator('#text-panel-body')).toBeVisible();
  }
  await collect();
 }
 // Participant names (including both invite joiners), activities, meals, shopping, gear, vehicles and the
 // trip card together cover every payload on the trip page.
 expect([...ALL].filter(v=>!seenText.has(v)),'trip page payloads not shown as text').toEqual([]);

 await page.locator('[data-action="invite"]').first().click();
 await expect(page.locator('.invite-links li').first()).toBeVisible();
 await check(page,problems,'Invitation_Dialog',[P[0]]);
 await page.keyboard.press('Escape');

 await page.locator('.section-tabs [data-tab="expenses"]').click();
 await expect(page.locator('.xp-panel')).toBeVisible();
 await check(page,problems,'expenses view',ALL);
});

test('[TC-XSS-004] Admin_Page renders display names and trip titles as text',async({browser})=>{
 ctx.admin=await browser.newContext({baseURL:testBase});
 const problems=await guard(ctx.admin,'admin');
 await api(ctx.admin.request,'/api/login','POST',{username:adminName,password});
 const page=await ctx.admin.newPage();
 await page.goto('/admin');
 await expect(page.locator('#admin-users .acct-user-row').first()).toBeVisible();
 await expect(page.locator('#admin-security')).toBeVisible();
 await check(page,problems,'Admin_Page',[DISPLAY.owner,DISPLAY.invitee,DISPLAY.registrant,P[5]]);
});
