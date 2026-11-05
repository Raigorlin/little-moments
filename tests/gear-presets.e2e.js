import {test,expect} from '@playwright/test';
import {seed,STORAGE_KEY} from '../src/model.js';

const base=process.env.CAMPING_BASE_URL;
const nav=p=>p.locator('.section-tabs [data-tab="gear"]').click();
const readDemo=p=>p.evaluate(key=>JSON.parse(localStorage.getItem(key)),STORAGE_KEY);
const form=p=>p.locator('#edit-form[data-kind="gear"]');
const open=async p=>{await nav(p);await p.getByRole('button',{name:'新增裝備',exact:true}).click();await expect(form(p)).toBeVisible();};
const save=p=>form(p).locator('button[type="submit"]').click();
async function api(p,path,method='GET',body){const r=await p.request.fetch(base+path,{method,data:body,headers:body?{Origin:base,'Content-Type':'application/json'}:{}});expect(r.ok(),await r.text()).toBe(true);return r.json();}

test.beforeEach(async({baseURL})=>expect(new URL(baseURL).port).toBe('5181'));

test('personal essentials fill a draft; cancellation and editing never auto-add',async({page:p})=>{
 await p.goto('/demo/#/trip');const before=await readDemo(p);await open(p);
 const picker=p.getByRole('combobox',{name:'常用露營裝備（選填）'}),scope=p.getByRole('combobox',{name:'類型'});
 expect(await picker.locator('optgroup').evaluateAll(es=>es.map(e=>e.label))).toEqual(['睡眠與遮蔽','穿著與盥洗','隨身用品']);
 for(const name of ['帳篷','行軍床','折疊床','棉被'])expect(await picker.locator('option').allTextContents()).toContain(name);
 await expect(scope).toHaveValue('shared');await scope.selectOption('personal');await expect(form(p).locator('[data-gear-assignee-field]')).toBeHidden();
 await picker.selectOption('棉被');await expect(p.getByRole('textbox',{name:'裝備名稱'})).toHaveValue('棉被');await expect(p.getByRole('textbox',{name:'數量與單位'})).toHaveValue('1 件');
 expect(await readDemo(p)).toEqual(before);
 p.once('dialog',d=>d.accept());await p.getByRole('button',{name:'取消',exact:true}).click();expect(await readDemo(p)).toEqual(before);
 await open(p);await scope.selectOption('personal');await picker.selectOption('行軍床');await p.getByRole('textbox',{name:'裝備名稱'}).fill('我的床');await expect(picker).toHaveValue('');await p.getByRole('textbox',{name:'數量與單位'}).fill('2 張');await save(p);
 const next=await readDemo(p),added=next.gear.find(g=>g.name==='我的床');expect(added).toMatchObject({quantity:'2 張',scope:'personal',assignee:'',ready:[]});expect(next.gear).toHaveLength(before.gear.length+1);
 await p.reload();await nav(p);await p.getByRole('button',{name:'編輯 我的床',exact:true}).click();await expect(picker).toHaveCount(0);await expect(scope).toHaveValue('personal');await expect(p.getByRole('textbox',{name:'數量與單位'})).toHaveValue('2 張');await p.getByRole('button',{name:'取消',exact:true}).click();
});

test('tent can be shared and assigned; scope picker and grouped suggestions fit phone and dark mode',async({page:p})=>{
 await p.goto('/demo/#/trip');const before=await readDemo(p);await open(p);
 const picker=p.locator('#gear-preset'),scope=p.locator('#edit-form [name=scope]');
 expect(await scope.evaluate(el=>getComputedStyle(el).appearance)).toBe('base-select');
 await scope.click();await expect(scope.locator('option').first()).toBeVisible();await scope.locator('option[value=shared]').click();await expect(scope).toHaveValue('shared');
 await expect(form(p).locator('[data-gear-assignee-field]')).toBeVisible();await form(p).locator('[name=assignee]').selectOption(before.people[0].id);
 await picker.selectOption('帳篷');expect(await readDemo(p)).toEqual(before);await save(p);
 const after=await readDemo(p);expect(after.gear.at(-1)).toMatchObject({name:'帳篷',quantity:'1 頂',scope:'shared',assignee:before.people[0].id,ready:[]});
 await p.reload();await nav(p);await p.getByRole('button',{name:'編輯 帳篷',exact:true}).click();await expect(scope).toHaveValue('shared');await expect(form(p).locator('[name=assignee]')).toHaveValue(before.people[0].id);await p.getByRole('button',{name:'取消',exact:true}).click();
 for(const theme of ['light','dark']){await p.evaluate(t=>document.documentElement.dataset.theme=t,theme);for(const width of [320,390,1440]){
  await p.setViewportSize({width,height:900});await p.getByRole('button',{name:'新增裝備',exact:true}).click();
  await picker.click();await picker.locator('option[value="棉被"]').scrollIntoViewIfNeeded();await expect(picker.locator('option[value="棉被"]')).toBeVisible();
  const r=await picker.locator('option[value="棉被"]').boundingBox();expect(r.x).toBeGreaterThanOrEqual(0);expect(r.x+r.width).toBeLessThanOrEqual(width+1);
  expect(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await p.keyboard.press('Escape');await expect(form(p)).toBeVisible();await p.getByRole('button',{name:'取消',exact:true}).click();
 }}
 await p.emulateMedia({forcedColors:'active'});await p.getByRole('button',{name:'新增裝備',exact:true}).click();expect(await picker.evaluate(el=>getComputedStyle(el).appearance)).toBe('auto');await picker.selectOption('睡袋');await expect(p.getByRole('textbox',{name:'裝備名稱'})).toHaveValue('睡袋');p.once('dialog',d=>d.accept());await p.getByRole('button',{name:'取消',exact:true}).click();
});

test('account trip suggestions never touch server until saved and preserve existing gear',async({page:p})=>{
 const username=`gear-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
 await api(p,'/api/register','POST',{username,displayName:'裝備測試',password:'Isolated-Gear-Test-2026'});
 const {trip}=await api(p,'/api/trips','POST',{legacyState:seed()});await p.goto(`/${username}/trips/${trip.id}`);
 const before=await api(p,`/api/trips/${trip.id}`);await open(p);await form(p).locator('[name=scope]').selectOption('personal');
 await p.locator('#gear-preset').selectOption('充氣床墊');await expect(p.getByRole('textbox',{name:'裝備名稱'})).toHaveValue('充氣床墊');
 expect(await api(p,`/api/trips/${trip.id}`)).toEqual(before);await save(p);await expect(p.locator('.sync-status')).toContainText('已儲存至本機伺服器');
 const after=await api(p,`/api/trips/${trip.id}`);expect(after.state.gear.slice(0,-1)).toEqual(before.state.gear);expect(after.state.gear.at(-1)).toMatchObject({name:'充氣床墊',quantity:'1 張',scope:'personal',assignee:'',ready:[]});
 await p.reload();await nav(p);await expect(p.getByRole('button',{name:'編輯 充氣床墊',exact:true})).toBeVisible();expect(await p.evaluate(k=>localStorage.getItem(k),STORAGE_KEY)).toBeNull();
});


test('native high contrast preset keeps keyboard focus while navigating',async({page:p})=>{
 await p.emulateMedia({forcedColors:'active'});await p.goto('/demo/#/trip');await open(p);const picker=p.locator('#gear-preset');
 await picker.focus();await p.keyboard.press('ArrowDown');await expect(picker).toBeFocused();await p.keyboard.press('ArrowDown');await expect(picker).toBeFocused();
 await expect(picker).toHaveValue('行軍床');await expect(p.getByRole('textbox',{name:'裝備名稱'})).toHaveValue('行軍床');
 p.once('dialog',d=>d.accept());await p.getByRole('button',{name:'取消',exact:true}).click();
});

test('existing shared gear becomes personal only on save, clearing assignee and ready',async({page:p})=>{
 await p.goto('/demo/#/trip');let state=await readDemo(p);const item=state.gear.find(g=>g.scope==='shared');item.ready=[item.assignee];state.departed=[item.assignee];
 await p.evaluate(({key,s})=>localStorage.setItem(key,JSON.stringify(s)),{key:STORAGE_KEY,s:state});await p.reload();await nav(p);
 await p.getByRole('button',{name:`編輯 ${item.name}`,exact:true}).click();await form(p).locator('[name=scope]').selectOption('personal');await expect(form(p).locator('[data-gear-assignee-field]')).toBeHidden();
 expect((await readDemo(p)).gear.find(g=>g.id===item.id)).toEqual(item);await save(p);const after=await readDemo(p);
 expect(after.gear.find(g=>g.id===item.id)).toEqual({...item,scope:'personal',assignee:'',ready:[]});expect(after.departed).toEqual([]);
});
