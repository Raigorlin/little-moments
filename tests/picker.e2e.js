import {test,expect} from './local-planner-fixture.js';
import {seed,STORAGE_KEY} from '../src/model.js';
const base=process.env.CAMPING_BASE_URL;
const nav=(p,t)=>p.locator(`.section-tabs [data-tab="${t}"]`).click();
async function api(p,path,method='GET',body){const r=await p.request.fetch(base+path,{method,data:body,headers:body?{Origin:base,'Content-Type':'application/json'}:{}});expect(r.ok(),await r.text()).toBe(true);return r.json();}
async function fixture(p){
 await api(p,'/api/login','POST',{username:'qa-admin',password:'Local-Only-Test-Pass-2026'});
 const state=seed();state.people[2].name='Ena';state.people[2].color='green';state.people[4].name='Mike';state.people[4].color='coral';
 const {trip}=await api(p,'/api/trips','POST',{legacyState:state});await p.goto(`/qa-admin/trips/${trip.id}`);
 return ()=>api(p,`/api/trips/${trip.id}`);
}
const saved=p=>expect(p.locator('.sync-status')).toContainText('已儲存至本機伺服器');
const opened=s=>expect(s.locator('option').first()).toBeVisible();
const closed=s=>expect(s.locator('option').first()).not.toBeVisible();
test.beforeEach(async({baseURL})=>expect(new URL(baseURL).port).toBe('5181'));
test('meal and shopping headings match the slogan without data writes',async({page:p})=>{
 const detail=await fixture(p),before=await detail();
 for(const [tab,text] of [['meals','LITTLE MEALS, LASTING MEMORIES'],['shopping','GATHER INGREDIENTS, MAKE MEMORIES']]){
  await nav(p,tab);await expect(p.locator('.workspace-main .section-title .eyebrow').first()).toHaveText(text);
 }expect(await detail()).toEqual(before);
});
test('pointer selection saves; Escape and outside dismissal leave data untouched',async({page:p})=>{
 const detail=await fixture(p);await nav(p,'shopping');const before=await detail(),s=p.locator('[data-shopping-assignee="s1"]');
 expect(await s.evaluate(e=>getComputedStyle(e).appearance)).toBe('base-select');
 await s.click();await opened(s);await s.locator('option[value="p5"]').click();await saved(p);
 await expect(s).toHaveValue('p5');await expect(s).toHaveAttribute('data-person-color','coral');await expect(s).toBeFocused();
 const after=await detail();expect(after.state.shopping.find(x=>x.id==='s1')).toEqual({...before.state.shopping.find(x=>x.id==='s1'),assignee:'p5',source:'manual'});
 await s.click();await opened(s);await p.keyboard.press('Escape');await closed(s);
 await s.click();await opened(s);await p.locator('.workspace-main h2').first().click();await closed(s);expect(await detail()).toEqual(after);
 await p.reload();await nav(p,'shopping');await expect(s).toHaveValue('p5');
});

test('keyboard selection saves; Escape only closes the picker inside an edit dialog',async({page:p})=>{
 const detail=await fixture(p);await nav(p,'gear');const s=p.locator('[data-gear-assignee="g7"]');
 await s.focus();await p.keyboard.press('Space');await opened(s);
 await p.keyboard.press('Home');await p.keyboard.press('ArrowDown');await p.keyboard.press('Enter');await saved(p);await expect(s).toHaveValue('p1');
 const before=await detail();await p.getByRole('button',{name:'編輯 卡式爐與瓦斯',exact:true}).click();const draft=p.locator('#edit-form [name=assignee]');
 await draft.click();await opened(draft);await p.keyboard.press('Escape');await closed(draft);await expect(p.locator('#dialog')).toBeVisible();
 await draft.click();await opened(draft);await draft.locator('option[value="p3"]').click();await expect(draft).toHaveAttribute('data-person-color','green');
 p.once('dialog',d=>d.accept());await p.getByRole('button',{name:'取消',exact:true}).click();expect(await detail()).toEqual(before);
});
test('high contrast keeps the native select usable',async({page:p})=>{
 await p.emulateMedia({forcedColors:'active'});await p.goto('/demo/#/trip');await nav(p,'shopping');
 const s=p.locator('[data-shopping-assignee="s1"]');expect(await s.evaluate(e=>getComputedStyle(e).appearance)).toBe('auto');
 await s.selectOption('p5');await expect(s).toHaveValue('p5');
 expect(await p.evaluate(k=>JSON.parse(localStorage.getItem(k)).shopping.find(x=>x.id==='s1').assignee,STORAGE_KEY)).toBe('p5');
});

test('opened pickers fit phone and desktop in both themes with matching person dots',async({page:p})=>{
 await fixture(p);await nav(p,'shopping');await p.evaluate(()=>document.fonts.ready);
 for(const theme of ['light','dark']){
  await p.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  for(const width of [320,390,1440]){
   await p.setViewportSize({width,height:900});const s=p.locator('[data-shopping-assignee="s1"]');await s.scrollIntoViewIfNeeded();await s.click();await opened(s);
   const opt=s.locator('option:checked');await expect(opt).toBeVisible();
   const r=await opt.boundingBox();expect(r.x).toBeGreaterThanOrEqual(0);expect(r.x+r.width).toBeLessThanOrEqual(width);expect(r.y).toBeGreaterThanOrEqual(0);expect(r.y+r.height).toBeLessThanOrEqual(900);
   const c=await opt.evaluate(e=>({dot:getComputedStyle(e,'::before').backgroundColor,height:e.getBoundingClientRect().height,font:getComputedStyle(e).fontFamily}));
   expect(c.dot).toBe(theme==='light'?'rgb(196, 217, 175)':'rgb(128, 156, 104)');expect(c.height).toBeGreaterThanOrEqual(44);expect(c.font).toContain('jf open 粉圓');
   const style=await s.evaluate(e=>({radius:getComputedStyle(e,'::picker(select)').borderRadius,padding:getComputedStyle(e,'::picker(select)').padding}));expect(style).toEqual({radius:'12px',padding:'6px'});
   if(width!==320)await p.screenshot({path:`previews/picker-${theme}-${width}.png`});
   await p.keyboard.press('Escape');await closed(s);expect(await s.evaluate(e=>e.getBoundingClientRect().width)).toBe(156);expect(await s.evaluate(e=>e.getBoundingClientRect().height)).toBe(44);
   expect(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  }
 }
});
test('all form dropdowns share the same picker appearance',async({page:p})=>{
 await p.goto('/demo/#/trip');await nav(p,'gear');await p.getByRole('button',{name:'新增裝備',exact:true}).click();
 const selects=[p.locator('#edit-form .gear-scope-select'),p.locator('#edit-form #gear-preset')];
 for(const select of selects){
  expect(await select.evaluate(e=>getComputedStyle(e).appearance)).toBe('base-select');
  await select.click();await opened(select);
  expect(await select.evaluate(e=>getComputedStyle(e,'::picker(select)').borderRadius)).toBe('12px');
  expect(await select.evaluate(e=>getComputedStyle(e,'::picker(select)').padding)).toBe('6px');
  await p.keyboard.press('Escape');await closed(select);
 }
});
