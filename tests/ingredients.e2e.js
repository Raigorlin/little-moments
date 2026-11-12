import {test,expect} from './local-planner-fixture.js';
import {STORAGE_KEY,LEGACY_STORAGE_KEY,seed} from '../src/model.js';
const nav=async(page,tab)=>page.locator(`.section-tabs [data-tab="${tab}"]`).click();
const saveDialog=async page=>page.locator('#edit-form button[type="submit"]').click();
const read=async page=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),STORAGE_KEY);
const row=(page,name)=>page.locator('.shopping-row').filter({has:page.getByRole('checkbox',{name:`${name}已買齊`,exact:true})});
async function addMeal(page,title,ingredients){
  await nav(page,'meals');await page.getByRole('button',{name:'新增餐次',exact:true}).click();
  await page.getByLabel('料理名稱',{exact:true}).fill(title);await page.getByLabel('食材（以頓號、/、逗號或句點分隔）',{exact:true}).fill(ingredients);await saveDialog(page);
}
async function removeMeal(page,title){
  await nav(page,'meals');await page.getByRole('button',{name:`編輯 ${title}`,exact:true}).click();
  await page.getByRole('button',{name:'移除項目',exact:true}).click();await page.getByRole('button',{name:'確認移除',exact:true}).click();
}
test('live preview has no storage effects; save syncs all categories and reload persists',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/demo/');await expect.poll(()=>read(page)).not.toBeNull();const before=await read(page);await nav(page,'meals');
  await page.getByRole('button',{name:'新增餐次',exact:true}).click();await page.getByLabel('料理名稱',{exact:true}).fill('分類測試鍋');
  await page.getByLabel('食材（以頓號、/、逗號或句點分隔）',{exact:true}).fill('豬五花、青江菜、鮮蝦、雞蛋、蘋果、豆皮、白米、醬油、豆漿、餅乾、神秘食材、豬五花、');
  await expect(page.locator('#ingredient-preview')).toContainText('11 項食材');expect(await read(page)).toEqual(before);await saveDialog(page);await nav(page,'shopping');
  for(const [name,category] of [['豬五花','肉類'],['青江菜','蔬菜'],['鮮蝦','海鮮'],['雞蛋','蛋奶'],['蘋果','水果'],['豆皮','豆製品'],['白米','主食'],['醬油','調味料'],['豆漿','飲料'],['餅乾','零食'],['神秘食材','其他']]){
    const section=page.locator('.shopping-category').filter({has:page.locator('h3').filter({hasText:category})});
    await expect(section.getByRole('checkbox',{name:`${name}已買齊`,exact:true})).toBeVisible();await expect(row(page,name)).toContainText('分類測試鍋');
  }
  await expect(row(page,'豬五花')).toContainText('數量待確認');await expect(page.getByRole('checkbox',{name:'雞蛋已買齊',exact:true})).toBeChecked();
  expect((await read(page)).shopping.filter(s=>s.name==='豬五花')).toHaveLength(1);await page.reload();await nav(page,'shopping');await expect(row(page,'鮮蝦')).toContainText('分類測試鍋');expect(errors).toEqual([]);
});
test('[TC-SHOP-001] shopping quantities can be edited in place and save on Enter or blur',async({page})=>{
  await page.goto('/demo/');await nav(page,'shopping');
  const beef=row(page,'牛肉片'),quantity=beef.locator('.quantity-editable');
  await quantity.click();let input=beef.locator('input[data-shopping-quantity-input]');
  await expect(input).toBeFocused();await expect(page.locator('#dialog')).toBeHidden();
  await input.fill('3 盒');await input.press('Enter');await expect(beef.locator('.quantity-editable')).toHaveText('3 盒');
  expect((await read(page)).shopping.find(item=>item.name==='牛肉片').quantity).toBe('3 盒');
  await beef.locator('.quantity-editable').click();input=beef.locator('input[data-shopping-quantity-input]');
  await input.fill('4 盒');await input.press('Escape');await expect(beef.locator('.quantity-editable')).toHaveText('3 盒');
  await beef.locator('.quantity-editable').click();input=beef.locator('input[data-shopping-quantity-input]');
  await input.fill('5 盒');await input.evaluate(el=>el.blur());
  await expect(beef.locator('.quantity-editable')).toHaveText('5 盒');await page.reload();await nav(page,'shopping');
  await expect(row(page,'牛肉片').locator('.quantity-editable')).toHaveText('5 盒');
});
test('[TC-MEAL-002] new meal quantities can be filled from their placeholder without opening a dialog',async({page})=>{
  await page.goto('/demo/');await addMeal(page,'快速填數量','豬五花');await nav(page,'shopping');
  const pork=row(page,'豬五花');await expect(pork.locator('.quantity-editable')).toHaveText('數量待確認');
  await pork.locator('.quantity-editable').click();const input=pork.locator('input[data-shopping-quantity-input]');
  await expect(input).toHaveValue('');await expect(page.locator('#dialog')).toBeHidden();
  await input.fill('2 包');await input.press('Enter');await expect(pork.locator('.quantity-editable')).toHaveText('2 包');
  expect((await read(page)).shopping.find(item=>item.name==='豬五花').quantity).toBe('2 包');
});
test('cancelled and invalid meal drafts never alter shopping data',async({page})=>{
  await page.goto('/demo/');await expect.poll(()=>read(page)).not.toBeNull();const before=await read(page);await nav(page,'meals');await page.getByRole('button',{name:'新增餐次',exact:true}).click();
  await page.getByLabel('食材（以頓號、/、逗號或句點分隔）',{exact:true}).fill('鮭魚、菠菜');await saveDialog(page);await expect(page.locator('#dialog')).toBeVisible();expect(await read(page)).toEqual(before);
  await page.getByLabel('料理名稱',{exact:true}).fill('取消的料理');page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.locator('#dialog')).not.toBeVisible();expect(await read(page)).toEqual(before);
});
test('editing shared recipes and clearing ingredients removes only unused generated rows',async({page})=>{
  await page.goto('/demo/');await addMeal(page,'共享料理甲','鮭魚、菠菜');await addMeal(page,'共享料理乙','菠菜');expect((await read(page)).shopping.filter(s=>s.name==='菠菜')).toHaveLength(1);
  await page.getByRole('button',{name:'編輯 共享料理甲',exact:true}).click();await page.getByLabel('食材（以頓號、/、逗號或句點分隔）',{exact:true}).fill('白蝦、菠菜');await saveDialog(page);expect((await read(page)).shopping.some(s=>s.name==='鮭魚')).toBe(false);
  await removeMeal(page,'共享料理甲');let state=await read(page);expect(state.shopping.some(s=>s.name==='白蝦')).toBe(false);expect(state.shopping.find(s=>s.name==='菠菜').mealIds).toHaveLength(1);
  await page.getByRole('button',{name:'編輯 共享料理乙',exact:true}).click();await page.getByLabel('食材（以頓號、/、逗號或句點分隔）',{exact:true}).fill('');await saveDialog(page);expect((await read(page)).shopping.some(s=>s.name==='菠菜')).toBe(false);await page.reload();await expect(page.locator('.save-warning')).toHaveCount(0);
});
test('manual details and purchased items survive deleting their recipe and later unchecking',async({page})=>{
  await page.goto('/demo/');await addMeal(page,'保留採買設定','豬五花、菠菜、鮭魚');await nav(page,'shopping');await page.getByRole('button',{name:'編輯 豬五花',exact:true}).click();
  await expect(page.getByLabel('品項名稱',{exact:true})).toHaveAttribute('readonly','');await page.getByLabel('數量與單位',{exact:true}).fill('2 盒');await page.getByRole('combobox',{name:'分類',exact:true}).selectOption('其他');await page.getByRole('combobox',{name:'誰負責買',exact:true}).selectOption('p2');await saveDialog(page);
  await page.getByRole('checkbox',{name:'菠菜已買齊',exact:true}).check();await page.getByRole('button',{name:'新增品項',exact:true}).click();await page.getByLabel('品項名稱',{exact:true}).fill('手動保留品項');await saveDialog(page);
  await removeMeal(page,'保留採買設定');const state=await read(page);expect(state.shopping.find(s=>s.name==='豬五花')).toMatchObject({quantity:'2 盒',category:'其他',assignee:'p2',mealIds:[]});expect(state.shopping.find(s=>s.name==='菠菜').done).toBe(true);expect(state.shopping.some(s=>s.name==='手動保留品項')).toBe(true);expect(state.shopping.some(s=>s.name==='鮭魚')).toBe(false);
  await nav(page,'shopping');await expect(row(page,'菠菜')).toContainText('保留採買品項');await page.getByRole('checkbox',{name:'菠菜已買齊',exact:true}).uncheck();await page.reload();await nav(page,'shopping');await expect(row(page,'菠菜')).toBeVisible();
});
test('duplicate manual items and linked deletions explain how to edit the existing ingredient',async({page})=>{
  await page.goto('/demo/');await nav(page,'shopping');await page.getByRole('button',{name:'移除 牛肉片',exact:true}).click();await expect(page.locator('#toasts')).toContainText('請先到料理菜單移除食材');await expect(page.locator('#dialog')).toBeHidden();await page.getByRole('button',{name:'編輯 牛肉片',exact:true}).click();await page.getByRole('button',{name:'移除項目',exact:true}).click();await expect(page.locator('.form-error')).toContainText('請先到料理菜單移除食材');await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('button',{name:'新增品項',exact:true}).click();await page.getByLabel('品項名稱',{exact:true}).fill('牛肉片');await saveDialog(page);await expect(page.locator('.form-error')).toContainText('已有同名品項');expect((await read(page)).shopping.filter(s=>s.name==='牛肉片')).toHaveLength(1);
});
test('[TC-SHOP-002] shopping rows can be removed with the matching close icon and confirmation',async({page})=>{
  await page.goto('/demo/');await nav(page,'shopping');await page.getByRole('button',{name:'新增品項',exact:true}).click();await page.getByLabel('品項名稱',{exact:true}).fill('單獨採買品');await saveDialog(page);
  const item=row(page,'單獨採買品');const remove=item.getByRole('button',{name:'移除 單獨採買品',exact:true});
  await expect(remove.locator('svg')).toHaveCount(1);await remove.click();await expect(page.locator('#dialog')).toContainText('只會從這台裝置的本機手冊移除');await page.getByRole('button',{name:'確認移除',exact:true}).click();
  await expect(item).toHaveCount(0);expect((await read(page)).shopping.some(s=>s.name==='單獨採買品')).toBe(false);
});
test('legacy storage migrates once to an isolated key, old-tab writes cannot overwrite it',async({page})=>{
  const legacy=seed();legacy.trip.title='保留舊手冊';await page.goto('/demo/');await expect.poll(()=>read(page)).not.toBeNull();
  await page.evaluate(({oldKey,newKey,state})=>{localStorage.removeItem(newKey);localStorage.setItem(oldKey,JSON.stringify(state));},{oldKey:LEGACY_STORAGE_KEY,newKey:STORAGE_KEY,state:legacy});await page.reload();
  await expect.poll(()=>read(page)).not.toBeNull();const migrated=await read(page);expect(migrated.trip.title).toBe(legacy.trip.title);expect(migrated.shopping.find(s=>s.name==='壽喜燒醬').category).toBe('調味料');
  expect(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),LEGACY_STORAGE_KEY)).toEqual(legacy);
  legacy.trip.title='舊分頁之後的修改';await page.evaluate(({key,state})=>localStorage.setItem(key,JSON.stringify(state)),{key:LEGACY_STORAGE_KEY,state:legacy});await page.reload();await expect.poll(()=>read(page)).not.toBeNull();expect(await read(page)).toEqual(migrated);
});
test('old and new backups import with categorized ingredient metadata',async({page})=>{
  const legacy=seed();legacy.meals[0].ingredients+='、鮮蝦、豆皮';await page.goto('/demo/');
  for(let data=legacy,round=0;round<2;round++){
    // 匯入備份 lives in the trip menu, which closes itself before the import dialog opens.
    await page.getByRole('button',{name:'旅行選單',exact:true}).click();await page.locator('#trip-menu').getByRole('button',{name:'匯入備份',exact:true}).click();await page.locator('input[type=file]').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});await page.getByRole('button',{name:'匯入並取代',exact:true}).click();await expect(page.locator('#dialog')).not.toBeVisible();
    const state=await read(page);expect(state.shopping.find(s=>s.name==='鮮蝦').category).toBe('海鮮');expect(state.shopping.find(s=>s.name==='豆皮').category).toBe('豆製品');if(round)expect(state.shopping).toEqual(data.shopping);data=state;
  }
  await page.reload();await expect(page.locator('.save-warning')).toHaveCount(0);
});
test('offline sync persists and the mobile ingredient preview fits',async({page,context})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/demo/');await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));});
  await context.setOffline(true);await nav(page,'meals');await page.getByRole('button',{name:'新增餐次',exact:true}).click();await page.getByLabel('料理名稱',{exact:true}).fill('離線晚餐');await page.getByLabel('食材（以頓號、/、逗號或句點分隔）',{exact:true}).fill('牛排、菠菜、蝦仁、蘋果、豆漿');expect(await page.locator('#dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await saveDialog(page);await page.reload();await nav(page,'shopping');await expect(row(page,'蝦仁')).toContainText('離線晚餐');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
test('untrusted ingredient names remain escaped in preview and shopping',async({page})=>{
  const name='<img src=x onerror=alert(1)>';await page.goto('/demo/');await nav(page,'meals');await page.getByRole('button',{name:'新增餐次',exact:true}).click();await page.getByLabel('料理名稱',{exact:true}).fill('純文字測試');await page.getByLabel('食材（以頓號、/、逗號或句點分隔）',{exact:true}).fill(name);await expect(page.locator('#ingredient-preview')).toContainText(name);await expect(page.locator('#ingredient-preview img')).toHaveCount(0);
  await saveDialog(page);await nav(page,'shopping');await expect(row(page,name)).toBeVisible();await expect(row(page,name).locator('img')).toHaveCount(0);
});
