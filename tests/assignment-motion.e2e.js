import {test,expect} from './local-planner-fixture.js';
import {seed,STORAGE_KEY} from '../src/model.js';
import {poolMember} from './support/e2e-pool.js';
const base=process.env.CAMPING_BASE_URL;
const nav=(page,name)=>page.locator(`.section-tabs [data-tab="${name}"]`).click();
const readDemo=page=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),STORAGE_KEY);
async function api(page,path,method='GET',body){const r=await page.request.fetch(base+path,{method,data:body,headers:body?{Origin:base,'Content-Type':'application/json'}:{}});expect(r.status(),await r.text()).toBeLessThan(300);return r.json();}
let workerOwner;
async function fixture(page){
 // One isolated owner per worker (from the harness account pool, see tests/support/e2e-pool.js), a fresh trip per test.
 if(!workerOwner)workerOwner=await poolMember(page,base);
 else await api(page,'/api/login','POST',{username:workerOwner.username,password:workerOwner.password});
 const user=workerOwner;
 const {trip}=await api(page,'/api/trips','POST',{legacyState:seed()});
 await page.goto(`/${user.username}/trips/${trip.id}`);await expect(page.locator('.hero h1')).toBeVisible();
 return {user,trip,detail:()=>api(page,`/api/trips/${trip.id}`)};
}
const openTripMenu=page=>page.getByRole('button',{name:'旅行選單',exact:true}).click();
const closeTripMenu=page=>page.getByRole('button',{name:'關閉旅行選單',exact:true}).click();
const settingsMotion=page=>page.locator('#trip-menu .motion-settings');
const settingsToggle=page=>settingsMotion(page).locator('[data-scene-motion-toggle]');
async function noHeroControls(page){await expect(page.locator('.hero [data-scene-motion-toggle], .hero .scene-motion__toggle, .hero .motion-settings')).toHaveCount(0);}
async function openDisplayPreferences(page){const prefs=page.locator('details.display-preferences');if(!await prefs.evaluate(el=>el.open))await prefs.locator('summary',{hasText:'畫面偏好'}).click();await expect(prefs).toHaveAttribute('open','');return prefs.locator('.motion-settings');}
const saved=page=>expect(page.locator('.sync-status')).toContainText('已儲存至本機伺服器');
const signature=el=>{const s=getComputedStyle(el);return [s.backgroundColor,s.color,s.borderWidth,s.borderRadius,s.fontFamily,s.minHeight,s.backgroundImage];};
test.beforeEach(async({baseURL})=>{expect(new URL(baseURL).port).toBe('5181');});

test('shopping and gear selects persist with the same styling, without changing other item data',async({page})=>{
 const {detail}=await fixture(page);const before=await detail(),item=before.state.shopping.find(s=>s.assignee),person=before.state.people.find(p=>p.id!==item.assignee);
 await nav(page,'shopping');const select=page.locator(`[data-shopping-assignee="${item.id}"]`);
 await select.focus();await select.selectOption(person.id);await saved(page);await expect(select).toBeFocused();
 const after=await detail(),expected={...item,assignee:person.id,source:'manual'};expect(after.state.shopping.find(s=>s.id===item.id)).toEqual(expected);
 expect(after.state.gear).toEqual(before.state.gear);expect(after.state.meals).toEqual(before.state.meals);
 const shopStyle=await select.evaluate(signature);await page.reload();await nav(page,'shopping');await expect(select).toHaveValue(person.id);
 await nav(page,'gear');const gear=before.state.gear.find(g=>g.scope==='shared');const gearSelect=page.locator(`[data-gear-assignee="${gear.id}"]`);
 await gearSelect.selectOption(person.id);await saved(page);expect(await gearSelect.evaluate(signature)).toEqual(shopStyle);
 expect((await detail()).state.gear.find(g=>g.id===gear.id).assignee).toBe(person.id);await page.reload();await nav(page,'gear');await expect(gearSelect).toHaveValue(person.id);
 expect(await page.evaluate(key=>localStorage.getItem(key),STORAGE_KEY)).toBeNull();
});

test('failed inline assignment preserves draft, disables further edits and does not falsely report saved',async({page})=>{
 const {trip,detail}=await fixture(page),before=await detail(),item=before.state.shopping[0],person=before.state.people.find(p=>p.id!==item.assignee);
 await nav(page,'shopping');await page.route(`**/api/trips/${trip.id}`,route=>route.request().method()==='PUT'?route.abort('failed'):route.continue());
 const select=page.locator(`[data-shopping-assignee="${item.id}"]`);await select.selectOption(person.id);
 await expect(page.locator('.save-warning')).toContainText('尚未儲存');await expect(select).toHaveValue(person.id);await expect(select).toBeDisabled();
 expect((await detail()).state.shopping).toEqual(before.state.shopping);await expect(page.locator('[data-action="export"]').first()).toBeVisible();
 await page.unroute(`**/api/trips/${trip.id}`);await page.locator('[data-action="account-retry"]').click();await saved(page);await expect(select).toBeEnabled();expect((await detail()).state.shopping.find(s=>s.id===item.id).assignee).toBe(person.id);
});

test('revision conflict keeps assignment as an unsaved draft instead of overwriting server data',async({page})=>{
 const {trip,detail}=await fixture(page),before=await detail(),item=before.state.shopping[0],person=before.state.people.find(p=>p.id!==item.assignee);
 await nav(page,'shopping');await api(page,`/api/trips/${trip.id}`,'PATCH',{revision:before.trip.revision,note:'其他分頁保留'});
 const select=page.locator(`[data-shopping-assignee="${item.id}"]`);await select.selectOption(person.id);await expect(page.locator('.save-warning')).toContainText('其他人已更新');
 expect((await detail()).state.shopping).toEqual(before.state.shopping);await expect(select).toBeDisabled();
});

test('only food and gear responsibility selects use person colors consistently in forms and across pages',async({page})=>{
 await page.goto('/demo/#/trip');await nav(page,'shopping');await page.evaluate(()=>document.fonts.ready);
 for(const theme of ['light','dark']){
  await nav(page,'shopping');await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  const select=page.locator('[data-shopping-assignee="s1"]');await expect(select).toHaveAttribute('data-person-color','green');
  const style=await select.evaluate(signature);expect(style[4]).toContain('jf open 粉圓');
  await page.getByRole('button',{name:'編輯 牛肉片',exact:true}).click();expect(await page.locator('#edit-form [name=assignee]').evaluate(signature)).toEqual(style);
  expect(await page.locator('#edit-form [name=category]').evaluate(el=>getComputedStyle(el).backgroundColor)).not.toBe(style[0]);
  const draft=page.locator('#edit-form [name=assignee]');await draft.selectOption('p1');await expect(draft).toHaveAttribute('data-person-color','coral');page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'取消',exact:true}).click();
  await nav(page,'gear');expect(await page.locator('[data-gear-assignee="g7"]').evaluate(signature)).toEqual(style);await page.getByRole('button',{name:'編輯 卡式爐與瓦斯',exact:true}).click();expect(await page.locator('#edit-form [name=assignee]').evaluate(signature)).toEqual(style);
  expect(await page.locator('#edit-form [name=scope]').evaluate(el=>getComputedStyle(el).backgroundColor)).not.toBe(style[0]);await page.getByRole('button',{name:'取消',exact:true}).click();
  for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:950});for(const tab of ['shopping','gear']){await nav(page,tab);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(await page.locator('select.assignee-select').first().evaluate(el=>el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);}}
 }
 expect(await page.locator('body').evaluate(el=>getComputedStyle(el).fontFamily)).toContain('jf open 粉圓');
 expect(await page.evaluate(()=>[...document.fonts].some(f=>f.family.includes('jf open 粉圓')&&f.status==='loaded'))).toBe(true);
 await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'previews/person-colors-gear-desktop.png',fullPage:true});
});

test('demo assignment is offline-capable, handles untrusted names as text and preserves manual ingredient',async({page,context})=>{
 await page.goto('/demo/#/trip');await nav(page,'shopping');await expect.poll(()=>readDemo(page)).not.toBeNull();
 const before=await readDemo(page),item=before.shopping[0],person=before.people.find(p=>p.id!==item.assignee);
 await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));});
 await context.setOffline(true);await page.locator(`[data-shopping-assignee="${item.id}"]`).selectOption(person.id);await page.reload();await nav(page,'shopping');await expect(page.locator(`[data-shopping-assignee="${item.id}"]`)).toHaveValue(person.id);
 const modified=await readDemo(page);modified.people[0].name='<img src=x onerror=alert(1)>';await page.evaluate(({key,state})=>localStorage.setItem(key,JSON.stringify(state)),{key:STORAGE_KEY,state:modified});await page.reload();await nav(page,'shopping');
 await expect(page.locator('.shopping-list img')).toHaveCount(0);await expect(page.locator('[data-shopping-assignee]').first().locator('option').filter({hasText:'<img src=x onerror=alert(1)>'})).toHaveCount(1);
});

test('hero moves automatically, pause lives in trip settings, is keyboard accessible and survives tab switches and reload without trip writes',async({page})=>{
 const {detail}=await fixture(page),before=await detail(),html=page.locator('html');
 await expect(html).toHaveAttribute('data-scene-motion','running');
 const moving=()=>page.locator('.hero .scene-motion').evaluate(el=>el.getAnimations({subtree:true}).filter(a=>a.playState==='running').length);
 expect(await moving()).toBeGreaterThan(0);await noHeroControls(page);
 await openTripMenu(page);const toggle=settingsToggle(page);
 await expect(settingsMotion(page).getByRole('heading',{name:'插畫動畫',exact:true})).toBeVisible();await expect(settingsMotion(page)).toContainText('控制車子與背景動態，只影響這台裝置。');
 await expect(toggle).toHaveAccessibleName('暫停動畫');await expect(toggle).not.toHaveAttribute('aria-pressed');
 await toggle.focus();await page.keyboard.press('Enter');
 await expect(html).toHaveAttribute('data-scene-motion','paused');expect(await moving()).toBe(0);await expect(toggle).toHaveAccessibleName('播放動畫');await expect(toggle).toBeFocused();
 await closeTripMenu(page);await nav(page,'shopping');await expect(html).toHaveAttribute('data-scene-motion','paused');expect(await moving()).toBe(0);await noHeroControls(page);
 await page.reload();await expect(html).toHaveAttribute('data-scene-motion','paused');expect(await moving()).toBe(0);await noHeroControls(page);
 expect((await detail()).state).toEqual(before.state);
 await openTripMenu(page);await expect(settingsToggle(page)).toHaveAccessibleName('播放動畫');await settingsToggle(page).click();
 await expect(html).toHaveAttribute('data-scene-motion','running');expect(await moving()).toBeGreaterThan(0);
 expect((await detail()).state).toEqual(before.state);
 await closeTripMenu(page);await page.locator('.hero').screenshot({path:'previews/animated-camp-hero.png'});
});

test('reduced motion and print remain static, and card illustrations never animate',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await page.goto('/demo/#/home');await expect(page.locator('.hero')).toBeVisible();
 await expect(page.locator('html')).toHaveAttribute('data-scene-motion','reduced');await expect(page.locator('[data-scene-motion-toggle]')).toBeHidden();
 expect(await page.locator('.hero').evaluate(el=>el.getAnimations({subtree:true}).length)).toBe(0);
 await page.emulateMedia({reducedMotion:'no-preference'});await expect(page.locator('html')).toHaveAttribute('data-scene-motion','running');
 expect(await page.locator('.hero').evaluate(el=>el.getAnimations({subtree:true}).length)).toBeGreaterThan(0);
 expect(await page.locator('.trip-card-art').evaluate(el=>el.getAnimations({subtree:true}).length)).toBe(0);
 await page.emulateMedia({media:'print'});expect(await page.locator('.hero').evaluate(el=>el.getAnimations({subtree:true}).length)).toBe(0);
 await page.emulateMedia({media:'screen',reducedMotion:'reduce'});await page.goto('/demo/#/trip');await openTripMenu(page);await noHeroControls(page);
 await expect(page.locator('html')).toHaveAttribute('data-scene-motion','reduced');await expect(settingsToggle(page)).toBeHidden();
 await expect(settingsMotion(page).locator('[data-motion-reduced-note]')).toHaveText('依系統減少動態設定，插畫保持靜態。');await expect(settingsMotion(page).locator('[data-motion-reduced-note]')).toBeVisible();
 expect(await page.locator('.hero').evaluate(el=>el.getAnimations({subtree:true}).length)).toBe(0);
});

test('account forms stay neutral with jf open font, and footer motion preference fits 320px',async({page})=>{
 const {user}=await fixture(page);await page.goto(`/${user.username}/home`);await page.setViewportSize({width:320,height:900});await noHeroControls(page);
 const prefs=await openDisplayPreferences(page),toggle=prefs.locator('[data-scene-motion-toggle]');
 await expect(toggle).toHaveAccessibleName('暫停動畫');await toggle.click();await expect(page.locator('html')).toHaveAttribute('data-scene-motion','paused');await expect(toggle).toHaveAccessibleName('播放動畫');await expect(toggle).toBeVisible();
 expect(await toggle.evaluate(el=>el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
 await page.reload();await expect(page.locator('html')).toHaveAttribute('data-scene-motion','paused');await noHeroControls(page);
 const reopened=(await openDisplayPreferences(page)).locator('[data-scene-motion-toggle]');await expect(reopened).toHaveAccessibleName('播放動畫');await reopened.click();await expect(page.locator('html')).toHaveAttribute('data-scene-motion','running');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.getByRole('button',{name:'新增旅行',exact:true}).click();
 const selects=await page.locator('#dialog select').all();expect(selects.length).toBeGreaterThan(0);const style=await selects[0].evaluate(signature);
 for(const select of selects){expect(await select.evaluate(signature)).toEqual(style);expect(await select.evaluate(el=>getComputedStyle(el).fontFamily)).toContain('jf open 粉圓');}
 await page.getByRole('button',{name:'取消',exact:true}).click();await page.goto('/demo/#/trip');await nav(page,'shopping');expect((await page.locator('[data-shopping-assignee]').first().evaluate(signature))[0]).not.toEqual(style[0]);
 await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'previews/unified-selects-mobile.png',fullPage:true});
});


test('person representative colors persist and follow every food and gear selector after editing',async({page})=>{
 const {detail}=await fixture(page);const before=await detail();const people=[before.state.people.find(p=>p.id==='p3'),before.state.people.find(p=>p.id==='p5')];
 for(const [person,name,color] of [[people[0],'Ena','green'],[people[1],'Mike','coral']]){
  await openTripMenu(page);await page.locator('#trip-menu .member-card').filter({has:page.getByRole('heading',{name:person.name,exact:true})}).getByRole('button',{name:'編輯旅伴',exact:true}).click();
  await page.getByLabel('旅伴名字',{exact:true}).fill(name);await page.getByLabel('旅伴代表色',{exact:true}).selectOption(color);await page.locator('#edit-form button[type=submit]').click();await saved(page);
  await nav(page,'shopping');const shop=page.locator('[data-shopping-assignee="s1"]');await shop.selectOption(person.id);await saved(page);await expect(shop).toHaveAttribute('data-person-color',color);await expect(shop.locator('option:checked')).toContainText(name);const style=await shop.evaluate(signature);
  await nav(page,'gear');const gear=page.locator('[data-gear-assignee="g7"]');await gear.selectOption(person.id);await saved(page);await expect(gear).toHaveAttribute('data-person-color',color);expect(await gear.evaluate(signature)).toEqual(style);
  await page.reload();await nav(page,'shopping');await expect(shop).toHaveAttribute('data-person-color',color);expect(await shop.evaluate(signature)).toEqual(style);await nav(page,'gear');expect(await gear.evaluate(signature)).toEqual(style);
  await page.getByRole('button',{name:'編輯 卡式爐與瓦斯',exact:true}).click();expect(await page.locator('#edit-form [name=assignee]').evaluate(signature)).toEqual(style);await page.getByRole('button',{name:'取消',exact:true}).click();
 }
 const after=await detail();expect(after.state.people.find(p=>p.id===people[0].id)).toMatchObject({name:'Ena',color:'green'});expect(after.state.people.find(p=>p.id===people[1].id)).toMatchObject({name:'Mike',color:'coral'});
});

test('account recipe supports mixed ingredient separators and syncs after reload',async({page})=>{
 const {detail}=await fixture(page);await nav(page,'meals');await page.getByRole('button',{name:'新增餐次',exact:true}).click();await page.getByLabel('料理名稱',{exact:true}).fill('分隔符號測試料理');
 await page.getByLabel('食材（以頓號、/、逗號或句點分隔）',{exact:true}).fill('鮭魚/菠菜,蘋果.鮮蝦。豆皮、白米／紅茶．優格，鮭魚');await expect(page.locator('#ingredient-preview')).toContainText('8 項食材');
 await page.locator('#edit-form button[type=submit]').click();await saved(page);const d=await detail();expect(d.state.meals.find(m=>m.title==='分隔符號測試料理').ingredients).toBe('鮭魚、菠菜、蘋果、鮮蝦、豆皮、白米、紅茶、優格');
 for(const name of ['鮭魚','菠菜','蘋果','鮮蝦','豆皮','白米','紅茶','優格'])expect(d.state.shopping.filter(s=>s.name===name)).toHaveLength(1);
 await page.reload();await nav(page,'shopping');await expect(page.getByRole('checkbox',{name:'鮭魚已買齊',exact:true})).toBeVisible();expect((await detail()).state.shopping).toEqual(d.state.shopping);
});
