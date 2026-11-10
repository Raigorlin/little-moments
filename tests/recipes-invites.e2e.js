import {test,expect} from '@playwright/test';
import {STORAGE_KEY} from '../src/model.js';
const nav=(page,tab)=>page.locator(`.section-tabs [data-tab="${tab}"]`).click();
const state=page=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),STORAGE_KEY);
const save=async page=>{await page.locator('#edit-form button[type=submit]').click();await expect(page.locator('#dialog')).not.toBeVisible();};
const openMeal=async page=>{await page.goto('/demo/');await nav(page,'meals');await page.getByRole('button',{name:'新增餐次',exact:true}).click();};

test('recipe presets preview, merge shortcuts and save correct picture plus shopping',async({page})=>{
 await openMeal(page);const before=await state(page);await page.getByRole('combobox',{name:'常用料理範本',exact:true}).selectOption('curry');await expect(page.locator('#template-preview')).toContainText('馬鈴薯');expect(await state(page)).toEqual(before);
 await page.getByRole('button',{name:'套用範本',exact:true}).click();await expect(page.getByLabel('料理名稱',{exact:true})).toHaveValue('野炊雞肉咖哩飯');await expect(page.locator('#meal-image-preview [data-dish-kind]')).toHaveAttribute('data-dish-kind','curry');await expect(page.getByLabel('食材（以頓號、/、逗號或句點分隔）',{exact:true})).toHaveValue(/雞腿肉/);
 await page.locator('.common-ingredients summary').click();await page.getByRole('button',{name:'鮮蝦',exact:true}).click();await expect(page.getByRole('button',{name:'鮮蝦',exact:true})).toBeDisabled();expect(await state(page)).toEqual(before);await save(page);
 const card=page.locator('.meal-card').filter({has:page.getByRole('heading',{name:'野炊雞肉咖哩飯',exact:true})});await expect(card.locator('[data-dish-kind]')).toHaveAttribute('data-dish-kind','curry');
 const saved=await state(page);expect(saved.meals.at(-1).imageKind).toBe('curry');expect(saved.shopping.some(s=>s.name==='咖哩塊')).toBe(true);expect(saved.shopping.filter(s=>s.name==='鮮蝦')).toHaveLength(1);
 await page.reload();await nav(page,'meals');await expect(card.locator('[data-dish-kind]')).toHaveAttribute('data-dish-kind','curry');
});
test('template replacement asks, preserves custom ingredients and can be cancelled entirely',async({page})=>{
 await openMeal(page);const before=await state(page);await page.getByLabel('料理名稱',{exact:true}).fill('我的料理');await page.getByLabel('料理筆記',{exact:true}).fill('我的筆記');await page.getByLabel('食材（以頓號、/、逗號或句點分隔）',{exact:true}).fill('鮮蝦、雞蛋');
 await page.getByRole('combobox',{name:'常用料理範本',exact:true}).selectOption('toast');page.once('dialog',d=>d.dismiss());await page.getByRole('button',{name:'套用範本',exact:true}).click();await expect(page.getByLabel('料理名稱',{exact:true})).toHaveValue('我的料理');
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'套用範本',exact:true}).click();await expect(page.getByLabel('食材（以頓號、/、逗號或句點分隔）',{exact:true})).toHaveValue('鮮蝦、雞蛋、吐司、起司、火腿、奶油');
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.locator('#dialog')).not.toBeVisible();expect(await state(page)).toEqual(before);
});
test('existing meals retain automatic or explicitly saved images while the image selector is hidden',async({page})=>{
 await page.goto('/demo/');await nav(page,'meals');expect(await page.locator('.meal-card [data-dish-kind]').evaluateAll(els=>els.map(e=>e.dataset.dishKind))).toEqual(['hotpot','toast','bbq','breakfast']);
 await page.getByRole('button',{name:'編輯 暖暖壽喜燒',exact:true}).click();await expect(page.getByRole('combobox',{name:'料理圖片',exact:true})).toHaveCount(0);await save(page);expect((await state(page)).meals[0].imageKind).toBeUndefined();
 await page.evaluate(key=>{const s=JSON.parse(localStorage.getItem(key));s.meals[0].imageKind='salad';localStorage.setItem(key,JSON.stringify(s));},STORAGE_KEY);
 await page.reload();await nav(page,'meals');await page.getByRole('button',{name:'編輯 暖暖壽喜燒',exact:true}).click();
 await expect(page.locator('#meal-image-preview [data-dish-kind]')).toHaveAttribute('data-dish-kind','salad');await expect(page.locator('#edit-form select[name="imageKind"]')).toHaveCount(0);
 await page.getByRole('textbox',{name:'料理筆記',exact:true}).fill('保留原有配圖');await save(page);expect((await state(page)).meals[0].imageKind).toBe('salad');
 await page.reload();await nav(page,'meals');await expect(page.locator('.meal-card').first().locator('[data-dish-kind]')).toHaveAttribute('data-dish-kind','salad');
});
test('[TC-INVITE-002] invitation button leads to self-entry and duplicate names cannot take over identities',async({page})=>{
 await page.goto('/demo/');await expect.poll(()=>state(page)).not.toBeNull();const before=await state(page);await page.getByRole('button',{name:'邀請旅伴',exact:true}).click();await expect(page.locator('#dialog')).toContainText('自行填寫名字');await page.getByRole('link',{name:'預覽邀請頁',exact:false}).click();await expect(page.locator('#invite-form select')).toHaveCount(0);
 await page.getByLabel('你的名字或暱稱',{exact:true}).fill('   ');await expect(page.locator('#join-button')).toBeDisabled();await page.getByLabel('你的名字或暱稱',{exact:true}).fill('小安');await page.locator('#join-button').click();await expect(page.locator('#invite-form .form-error')).toContainText('已在小隊');expect(await state(page)).toEqual(before);
 await page.getByLabel('你的名字或暱稱',{exact:true}).fill('旅伴小光');await page.locator('#join-button').click();await expect(page).toHaveURL(/#\/trip/);const after=await state(page);expect(after.people).toHaveLength(before.people.length+1);expect(after.people.find(p=>p.id===after.currentUser).name).toBe('旅伴小光');expect(after.people.find(p=>p.id==='p1').name).toBe('小安');
 await page.goto('/demo/#/invite');await expect(page.getByLabel('你的名字或暱稱',{exact:true})).toHaveValue('');expect((await state(page)).people).toHaveLength(7);
});
test('invitation draft survives theme, offline and cross-tab rerender',async({page,context})=>{
 await page.goto('/demo/#/invite');await page.getByLabel('你的名字或暱稱',{exact:true}).fill('保留草稿');await page.getByLabel('小隊角色（選填）',{exact:true}).fill('料理幫手');await page.getByRole('button',{name:'切換深色模式',exact:true}).click();
 await expect(page.getByLabel('你的名字或暱稱',{exact:true})).toHaveValue('保留草稿');await context.setOffline(true);await expect(page.getByLabel('小隊角色（選填）',{exact:true})).toHaveValue('料理幫手');await context.setOffline(false);
 const other=await context.newPage();await other.goto('/demo/');await nav(other,'shopping');await other.getByRole('checkbox',{name:'牛肉片已買齊',exact:true}).check();await expect(page.locator('.save-warning')).toBeVisible();await expect(page.getByLabel('你的名字或暱稱',{exact:true})).toHaveValue('保留草稿');await other.close();
});
test('signup failure never claims permanent save and untrusted name is text',async({page})=>{
 await page.addInitScript(()=>{Storage.prototype.setItem=function(){throw new Error('quota')};});await page.goto('/demo/#/invite');await page.getByLabel('你的名字或暱稱',{exact:true}).fill('<img src=x onerror=alert(1)>');await page.locator('#join-button').click();await expect(page).toHaveURL(/#\/trip/);await expect(page.locator('.save-warning')).toBeVisible();await expect(page.locator('.profile-button img')).toHaveCount(0);await expect(page.locator('.profile-button')).toContainText('<img src=x onerror=alert(1)>');
});
test('readable typography, template panels and invite fit phone and desktop',async({page})=>{
 for(const width of [320,390,768,1440]){
  await page.setViewportSize({width,height:1000});await openMeal(page);await page.getByRole('combobox',{name:'常用料理範本',exact:true}).selectOption('pasta');await page.getByRole('button',{name:'套用範本',exact:true}).click();await page.locator('.common-ingredients summary').click();
  expect(await page.locator('#dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);expect(await page.getByLabel('食材（以頓號、/、逗號或句點分隔）',{exact:true}).evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'取消',exact:true}).click();await page.goto('/demo/#/invite');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(await page.locator('.invite-intro').evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
 }
 await page.evaluate(()=>document.fonts.ready);expect(await page.evaluate(()=>document.fonts.check('400 32px "jf open 粉圓"'))).toBe(true);
});
test('offline preset editing and locally hosted font continue to work after reload',async({page,context})=>{
 await page.goto('/demo/');await page.evaluate(async()=>{await document.fonts.ready;await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));});await context.setOffline(true);await page.reload();await nav(page,'meals');await page.getByRole('button',{name:'新增餐次',exact:true}).click();await page.getByRole('combobox',{name:'常用料理範本',exact:true}).selectOption('bbq');await page.getByRole('button',{name:'套用範本',exact:true}).click();await save(page);expect((await state(page)).meals.at(-1).imageKind).toBe('bbq');await page.reload();await page.waitForLoadState('domcontentloaded');await page.evaluate(async()=>{const f=new FontFace('jf-Huninn-offline-check','url(/assets/fonts/jf-openhuninn-2.1.ttf)');await f.load();document.fonts.add(f);});expect(await page.evaluate(()=>document.fonts.check('16px jf-Huninn-offline-check'))).toBe(true);
});
