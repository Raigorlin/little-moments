import {test,expect} from '@playwright/test';
import {seed,STORAGE_KEY} from '../src/model.js';
import {poolMember} from './support/e2e-pool.js';

const base=process.env.CAMPING_BASE_URL;
const nav=page=>page.locator('.section-tabs [data-tab="meals"]').click();
const preview=page=>page.locator('#meal-image-preview [data-dish-kind]');
const save=async page=>{await page.locator('#edit-form button[type="submit"]').click();await expect(page.locator('#dialog')).not.toBeVisible();};
async function api(page,path,method='GET',body){
 const response=await page.request.fetch(base+path,{method,data:body,headers:body?{Origin:base,'Content-Type':'application/json'}:{}});
 expect(response.ok(),await response.text()).toBe(true);return response.json();
}
async function accountTrip(page){
 // 全新 member 帳號取自 harness 帳號池（註冊 API 依用戶端 IP 限速，見 tests/support/e2e-pool.js）。
 const {username}=await poolMember(page,base);
 const initial=seed();initial.meals[0].imageKind='salad';
 const {trip}=await api(page,'/api/trips','POST',{legacyState:initial});
 await page.goto(`/${username}/trips/${trip.id}`);await nav(page);
 return trip;
}
async function hiddenImageField(page){
 await expect(page.locator('#edit-form select[name="imageKind"]')).toHaveCount(0);
 await expect(page.getByRole('combobox',{name:'料理圖片',exact:true})).toHaveCount(0);
 await expect(page.locator('#edit-form input[name="imageKind"]')).toHaveAttribute('type','hidden');
 await expect(page.getByText('料理圖片',{exact:true})).toHaveCount(0);
}

test.beforeEach(async({baseURL})=>expect(new URL(baseURL).port).toBe('5181'));

test('new meal keeps automatic name and ingredient artwork after save and reload',async({page})=>{
 await page.goto('/demo/');await nav(page);await page.getByRole('button',{name:'新增餐次',exact:true}).click();
 await hiddenImageField(page);await expect(preview(page)).toHaveAttribute('data-dish-kind','custom');
 await page.getByRole('textbox',{name:'料理名稱',exact:true}).fill('香煎雞肉');
 await page.getByLabel('食材（以頓號、/、逗號或句點分隔）',{exact:true}).fill('雞肉、咖哩塊');
 await expect(preview(page)).toHaveAttribute('data-dish-kind','curry');
 await page.getByRole('textbox',{name:'料理名稱',exact:true}).fill('番茄義大利麵');
 await expect(preview(page)).toHaveAttribute('data-dish-kind','pasta');
 for(const width of [320,390,1440]){
  await page.setViewportSize({width,height:1000});await hiddenImageField(page);
  expect(await page.locator('#dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 }
 await page.locator('#dialog').screenshot({path:'previews/meal-image-hidden-desktop.png'});
 await save(page);
 const saved=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),STORAGE_KEY);
 expect(saved.meals.at(-1).title).toBe('番茄義大利麵');expect(saved.meals.at(-1).imageKind).toBeUndefined();
 await page.reload();await nav(page);
 await expect(page.locator('.meal-card').filter({has:page.getByRole('heading',{name:'番茄義大利麵',exact:true})}).locator('[data-dish-kind]')).toHaveAttribute('data-dish-kind','pasta');
});

test('account edits preserve an explicitly saved image while legacy automatic meals stay automatic',async({page})=>{
 const trip=await accountTrip(page);
 await page.getByRole('button',{name:'編輯 暖暖壽喜燒',exact:true}).click();await hiddenImageField(page);
 await expect(preview(page)).toHaveAttribute('data-dish-kind','salad');
 await page.getByRole('textbox',{name:'料理名稱',exact:true}).fill('咖哩名稱但保留沙拉圖');
 await expect(preview(page)).toHaveAttribute('data-dish-kind','salad');await save(page);
 await expect.poll(async()=>(await api(page,`/api/trips/${trip.id}`)).state.meals[0].title).toBe('咖哩名稱但保留沙拉圖');
 expect((await api(page,`/api/trips/${trip.id}`)).state.meals[0].imageKind).toBe('salad');
 await page.reload();await nav(page);await page.getByRole('button',{name:'編輯 咖哩名稱但保留沙拉圖',exact:true}).click();
 await expect(preview(page)).toHaveAttribute('data-dish-kind','salad');await page.getByRole('button',{name:'取消',exact:true}).click();
 await page.getByRole('button',{name:'編輯 熱壓吐司與手沖咖啡',exact:true}).click();await hiddenImageField(page);
 await page.getByRole('textbox',{name:'料理名稱',exact:true}).fill('新鮮野餐沙拉');await expect(preview(page)).toHaveAttribute('data-dish-kind','salad');await save(page);
 await expect.poll(async()=>(await api(page,`/api/trips/${trip.id}`)).state.meals[1].title).toBe('新鮮野餐沙拉');
 expect((await api(page,`/api/trips/${trip.id}`)).state.meals[1].imageKind).toBeUndefined();
});

test('account template still updates hidden artwork but cancelling never changes saved data',async({page})=>{
 const trip=await accountTrip(page),before=await api(page,`/api/trips/${trip.id}`);
 await page.getByRole('button',{name:'編輯 暖暖壽喜燒',exact:true}).click();
 await page.getByRole('combobox',{name:'常用料理範本',exact:true}).selectOption('curry');
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'套用範本',exact:true}).click();
 await hiddenImageField(page);await expect(preview(page)).toHaveAttribute('data-dish-kind','curry');
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'取消',exact:true}).click();
 expect(await api(page,`/api/trips/${trip.id}`)).toEqual(before);
 await page.getByRole('button',{name:'編輯 暖暖壽喜燒',exact:true}).click();await expect(preview(page)).toHaveAttribute('data-dish-kind','salad');
 await page.getByRole('combobox',{name:'常用料理範本',exact:true}).selectOption('curry');
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'套用範本',exact:true}).click();await save(page);
 await expect.poll(async()=>(await api(page,`/api/trips/${trip.id}`)).state.meals[0].imageKind).toBe('curry');
 await page.reload();await nav(page);await page.getByRole('button',{name:'編輯 野炊雞肉咖哩飯',exact:true}).click();
 await hiddenImageField(page);await expect(preview(page)).toHaveAttribute('data-dish-kind','curry');
});
