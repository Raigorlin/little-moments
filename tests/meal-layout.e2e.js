import {test,expect} from '@playwright/test';
import {seed,STORAGE_KEY} from '../src/model.js';
const base=process.env.CAMPING_BASE_URL;
const nav=(p,tab)=>p.locator(`.section-tabs [data-tab="${tab}"]`).click();
const save=async p=>{await p.locator('#edit-form button[type=submit]').click();await expect(p.locator('#dialog')).not.toBeVisible();};
async function api(p,path,method='GET',body){const r=await p.request.fetch(base+path,{method,data:body,headers:body?{Origin:base,'Content-Type':'application/json'}:{}});expect(r.ok(),await r.text()).toBe(true);return r.json();}
async function accountFixture(p){
 await api(p,'/api/login','POST',{username:'qa-admin',password:'Local-Only-Test-Pass-2026'});
 const state=seed(),m=state.meals[0];
 state.meals=[['n','2026-11-21','消夜','營火烤棉花糖'],['prev','2026-11-20','晚餐','第一晚壽喜燒'],['d','2026-11-21','晚餐','山間咖哩飯'],['l','2026-11-21','午餐','午間義大利麵'],['b','2026-11-21','早餐','早安熱壓吐司'],['t','2026-11-21','下午茶','水果與咖啡'],['l2','2026-11-21','午餐','午餐加一道沙拉']].map(([id,date,slot,title])=>({...m,id,date,slot,title,ingredients:'雞蛋、吐司、番茄',notes:'記得一起準備，食材可依當天狀況調整。'}));
 const {trip}=await api(p,'/api/trips','POST',{legacyState:state});await p.goto(`/qa-admin/trips/${trip.id}`);await nav(p,'meals');
 return {trip,detail:()=>api(p,`/api/trips/${trip.id}`)};
}
test.beforeEach(async({baseURL})=>expect(new URL(baseURL).port).toBe('5181'));

test('account menu groups by date then meal time without writing or reordering stored data',async({page})=>{
 const {detail}=await accountFixture(page),before=await detail();
 await expect(page.locator('.meal-date-group')).toHaveCount(2);
 expect(await page.locator('.meal-date-group').evaluateAll(es=>es.map(e=>e.dataset.mealDate))).toEqual(['2026-11-20','2026-11-21']);
 expect(await page.locator('.meal-card').evaluateAll(es=>es.map(e=>e.dataset.mealId))).toEqual(['prev','b','l','l2','t','d','n']);
 await expect(page.locator('.meal-card').first().locator('h4')).toHaveText('第一晚壽喜燒');
 await page.locator('.meal-card').first().getByText('料理筆記',{exact:true}).click();await expect(page.locator('.meal-card').first().locator('.meal-notes p')).toBeVisible();
 await page.reload();await nav(page,'meals');expect(await detail()).toEqual(before);
});

test('five-slot dropdown saves and moves a card immediately, preserving other meal fields and shopping',async({page})=>{
 const {detail}=await accountFixture(page),before=await detail();await page.getByRole('button',{name:'編輯 營火烤棉花糖',exact:true}).click();const slot=page.getByRole('combobox',{name:'餐次',exact:true});
 expect(await slot.locator('option').allTextContents()).toEqual(['早餐','午餐','下午茶','晚餐','消夜']);await expect(slot).toHaveValue('消夜');
 await slot.focus();await page.keyboard.press('Home');await page.keyboard.press('Enter');await expect(slot).toHaveValue('早餐');await save(page);await expect(page.locator('.sync-status')).toContainText('已儲存至本機伺服器');
 const after=await detail();expect(after.state.meals.find(m=>m.id==='n')).toEqual({...before.state.meals.find(m=>m.id==='n'),slot:'早餐'});expect(after.state.shopping).toEqual(before.state.shopping);
 expect(await page.locator('.meal-card').evaluateAll(es=>es.map(e=>e.dataset.mealId))).toEqual(['prev','n','b','l','l2','t','d']);
 await page.reload();await nav(page,'meals');await page.getByRole('button',{name:'編輯 營火烤棉花糖',exact:true}).click();await expect(slot).toHaveValue('早餐');await page.getByRole('combobox',{name:'日期',exact:true}).selectOption('2026-11-22');await slot.selectOption('消夜');await save(page);await expect(page.locator('.sync-status')).toContainText('已儲存至本機伺服器');
 await expect(page.locator('.meal-date-group').last()).toHaveAttribute('data-meal-date','2026-11-22');await expect(page.locator('.meal-card').last()).toHaveAttribute('data-meal-id','n');
});

test('small cards are readable at phone/tablet/desktop sizes in light and dark mode',async({page})=>{
 await accountFixture(page);await page.evaluate(()=>document.fonts.ready);
 for(const theme of ['light','dark']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:1050});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
   const card=page.locator('.meal-card').first(),art=card.locator('.meal-illustration');expect(await art.evaluate(e=>e.getBoundingClientRect().height)).toBeLessThanOrEqual(84);expect(await card.evaluate(e=>e.getBoundingClientRect().height)).toBeLessThan(320);
   expect(await card.locator('h4').evaluate(e=>parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(19);await expect(card.locator('.meal-ingredients')).toContainText('雞蛋、吐司、番茄');
   if([390,1440].includes(width))await page.locator('.workspace-main').screenshot({path:`previews/meal-menu-${theme}-${width}.png`,style:".topbar{visibility:hidden!important}"});
  }
 }
});

test('legacy custom slot remains selected and survives unrelated edits; new meal uses five choices',async({page})=>{
 await page.goto('/demo/#/trip');const state=await page.evaluate(k=>JSON.parse(localStorage.getItem(k)),STORAGE_KEY);state.meals[0].slot='早午餐';await page.evaluate(({k,s})=>localStorage.setItem(k,JSON.stringify(s)),{k:STORAGE_KEY,s:state});await page.reload();await nav(page,'meals');
 await page.getByRole('button',{name:'編輯 暖暖壽喜燒',exact:true}).click();await expect(page.getByRole('combobox',{name:'餐次',exact:true})).toHaveValue('早午餐');await expect(page.locator('[name=slot] option:checked')).toHaveText('早午餐（原餐次）');await page.getByLabel('料理筆記',{exact:true}).fill('原餐次要保留');await save(page);
 expect(await page.evaluate(k=>JSON.parse(localStorage.getItem(k)).meals[0].slot,STORAGE_KEY)).toBe('早午餐');await page.getByRole('button',{name:'新增餐次',exact:true}).click();await expect(page.locator('[name=slot] option')).toHaveCount(5);await expect(page.locator('[name=slot]')).toHaveValue('晚餐');
});

test('refined selectors keep compact matching person colors, focus, and neutral meal fields',async({page})=>{
 await page.goto('/demo/#/trip');await nav(page,'shopping');const select=page.locator('[data-shopping-assignee="s1"]');await select.focus();
 const signature=e=>{const c=getComputedStyle(e),r=e.getBoundingClientRect();return {height:r.height,width:r.width,color:c.backgroundColor,border:c.borderTopWidth,radius:c.borderRadius,shadow:c.boxShadow};};
 await expect(select).toBeFocused();await select.evaluate(e=>e.blur());await select.evaluate(e=>Promise.all(e.getAnimations().map(a=>a.finished.catch(()=>{}))));const shop=await select.evaluate(signature);expect(shop.height).toBe(44);expect(shop.width).toBe(156);expect(shop.border).toBe('1px');
 await nav(page,'gear');expect(await page.locator('[data-gear-assignee="g7"]').evaluate(signature)).toEqual(shop);
 await page.setViewportSize({width:390,height:1000});await page.locator('.gear-table').last().screenshot({path:'previews/refined-assignees-mobile.png',style:'.topbar{visibility:hidden!important}'});
 await nav(page,'meals');await page.getByRole('button',{name:'新增餐次',exact:true}).click();const slot=page.getByRole('combobox',{name:'餐次',exact:true});expect(await slot.evaluate(e=>e.getBoundingClientRect().height)).toBe(44);expect(await slot.evaluate(e=>getComputedStyle(e).backgroundColor)).not.toBe(shop.color);
 await page.locator('#edit-form').screenshot({path:'previews/refined-meal-form-mobile.png'});
});
