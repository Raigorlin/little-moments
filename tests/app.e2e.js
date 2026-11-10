import {test,expect} from '@playwright/test';
import {seed,STORAGE_KEY} from '../src/model.js';
const nav=async(page,tab)=>page.locator(`.section-tabs [data-tab="${tab}"]`).click();
const saveDialog=async page=>page.locator('#edit-form button[type="submit"]').click();
test('[TC-DEMO-001] dashboard renders and all planning tabs work',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/demo/');await expect(page.getByRole('heading',{name:'雲海裡，住一晚'})).toBeVisible();
  await expect(page.locator('.activity-card')).toHaveCount(5);
  await page.locator('[data-day="2026-11-21"]').click();await expect(page.locator('.activity-card')).toHaveCount(3);
  for(const [tab,title] of [['meals','一起煮，一起吃'],['shopping','把好吃的買齊'],['gear','小隊裝備分工'],['crew','最好的風景，是一起的人'],['settings','旅行設定與紀錄']]){await nav(page,tab);await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();}
  expect(errors).toEqual([]);
});
test('invite lets a new companion type their name and persists membership',async({page})=>{
  await page.goto('/demo/#/invite');await expect(page.locator('#join-button')).toBeDisabled();await expect(page.locator('#invite-form select')).toHaveCount(0);
  await page.getByLabel('你的名字或暱稱',{exact:true}).fill('小樹');await page.getByLabel('小隊角色（選填）',{exact:true}).fill('早餐擔當');await page.locator('#join-button').click();
  await expect(page).toHaveURL(/#\/trip/);await expect(page.locator('.profile-button')).toContainText('小樹');await nav(page,'crew');await expect(page.getByRole('heading',{name:'小樹 我',exact:true})).toBeVisible();
  await page.reload();await expect(page.locator('.profile-button')).toContainText('小樹');
});
test('create, edit, and remove an itinerary entry',async({page})=>{
  await page.goto('/demo/');await page.getByRole('button',{name:'新增一站',exact:true}).click();
  await page.getByLabel('活動名稱').fill('測試野餐');await page.getByLabel('時間',{exact:true}).fill('13:20');await page.getByLabel('地點',{exact:true}).fill('樹下');await saveDialog(page);
  await expect(page.getByRole('heading',{name:'測試野餐',exact:true})).toBeVisible();
  await page.reload();await page.getByRole('button',{name:'編輯 測試野餐',exact:true}).click();
  await page.getByLabel('活動名稱').fill('午后野餐');await saveDialog(page);
  await expect(page.getByRole('heading',{name:'午后野餐',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'編輯 午后野餐',exact:true}).click();await page.getByRole('button',{name:'移除項目',exact:true}).click();await page.getByRole('button',{name:'確認移除',exact:true}).click();
  await expect(page.getByRole('heading',{name:'午后野餐',exact:true})).toHaveCount(0);
});
test('shopping checkboxes persist, filter, and survive offline reload',async({page,context})=>{
  await page.goto('/demo/');await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));});
  await nav(page,'shopping');await page.getByRole('checkbox',{name:'牛肉片已買齊',exact:true}).check();
  await page.reload();await nav(page,'shopping');await expect(page.getByRole('checkbox',{name:'牛肉片已買齊',exact:true})).toBeChecked();
  await page.getByLabel('隱藏已買').check();await expect(page.getByRole('checkbox',{name:'牛肉片已買齊',exact:true})).toHaveCount(0);
  await context.setOffline(true);await page.reload();await nav(page,'shopping');await expect(page.getByRole('checkbox',{name:'牛肉片已買齊',exact:true})).toBeChecked();
  await page.getByRole('checkbox',{name:'香菇已買齊',exact:true}).check();await context.setOffline(false);
  await page.reload();await nav(page,'shopping');await expect(page.getByRole('checkbox',{name:'香菇已買齊',exact:true})).toBeChecked();
});
test('existing meal ingredients sync on upgrade once without duplicate combined items',async({page})=>{
  await page.goto('/demo/');await nav(page,'meals');
  await expect(page.locator('[data-action="meal-shopping"]')).toHaveCount(0);
  await page.getByRole('button',{name:'查看採買清單',exact:true}).first().click();
  await expect(page.getByRole('checkbox',{name:'壽喜燒醬已買齊',exact:true})).toBeVisible();
  const first=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).shopping,STORAGE_KEY);
  expect(first.length).toBeGreaterThan(12);
  expect(first.filter(s=>['甜椒','玉米','吐司','貝果'].includes(s.name))).toHaveLength(0);
  await page.reload();
  const second=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).shopping,STORAGE_KEY);
  expect(second).toEqual(first);
});
test('departure is blocked by unassigned shared items, then succeeds',async({page})=>{
  await page.goto('/demo/#/go');await expect(page.getByRole('button',{name:/確認準備完成/})).toBeDisabled();
  const checks=page.locator('[data-pack]');for(let i=0;i<await checks.count();i++)await checks.nth(i).check();
  await expect(page.getByRole('button',{name:/確認準備完成/})).toBeDisabled();
  await page.getByRole('button',{name:/回去分配/}).click();
  await page.getByLabel('營燈攜帶人').selectOption('p2');await page.getByLabel('延長線攜帶人').selectOption('p2');
  await page.goto('/demo/#/go');await expect(page.getByRole('button',{name:/確認準備完成/})).toBeEnabled();
  await page.getByRole('button',{name:/確認準備完成/}).click();await expect(page.getByRole('heading',{name:'準備好了，一起出發！'})).toBeVisible();
  await page.getByRole('button',{name:/完成這一站/}).click();await expect(page.locator('.next-stop')).toContainText('把好吃的，一起買齊');
});
test('can add a person and validate vehicle capacity',async({page})=>{
  await page.goto('/demo/');await nav(page,'crew');await page.getByRole('button',{name:'新增旅伴',exact:true}).click();await page.getByLabel('旅伴名字').fill('小樹');await page.getByLabel('小隊角色').fill('點心擔當');await saveDialog(page);await expect(page.getByRole('heading',{name:'小樹',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'新增車輛',exact:true}).click();await page.getByLabel('車輛暱稱').fill('小樹號');await page.getByLabel('出發地點',{exact:true}).fill('台北車站');await page.getByLabel('座位數（含駕駛）').fill('1');await page.getByRole('checkbox',{name:'阿哲',exact:true}).check();await saveDialog(page);await expect(page.locator('.form-error')).toContainText('不能超過座位數');
  await page.getByLabel('座位數（含駕駛）').fill('4');await saveDialog(page);await expect(page.getByRole('heading',{name:'小樹號',exact:true})).toBeVisible();
});
test('invalid dates rejected; changed date range keeps activities visible',async({page})=>{
  await page.goto('/demo/');await nav(page,'settings');await page.getByRole('button',{name:'編輯旅行',exact:true}).click();await page.getByLabel('結束日期').fill('2026-11-01');await saveDialog(page);await expect(page.locator('.form-error')).toContainText('結束日期');
  await page.getByLabel('開始日期').fill('2027-02-01');await page.getByLabel('結束日期').fill('2027-02-03');await saveDialog(page);await nav(page,'schedule');await expect(page.locator('.activity-card')).toHaveCount(5);await expect(page.locator('.date-tabs')).toContainText('2/1');
});
test('export, validated import, and HTML text escaping',async({page})=>{
  await page.goto('/demo/');const downloadPromise=page.waitForEvent('download');await page.locator('.toolbar-actions [data-action="export"]').click();const dl=await downloadPromise;expect(dl.suggestedFilename()).toBe('good-good-camping-backup.json');
  await nav(page,'settings');await page.getByRole('button',{name:'匯入備份',exact:true}).click();await page.locator('input[type=file]').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{"schema":1}')});await page.getByRole('button',{name:'匯入並取代',exact:true}).click();await expect(page.locator('.form-error')).toContainText('不是有效');
  const imported=seed();imported.trip.title='<img src=x onerror=alert(1)>';
  await page.locator('input[type=file]').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(imported))});await page.getByRole('button',{name:'匯入並取代',exact:true}).click();await expect(page.locator('.hero h1')).toHaveText(imported.trip.title);await expect(page.locator('.hero h1 img')).toHaveCount(0);
});
test('dark mode persists and dialogs support Escape and focus',async({page})=>{
  await page.goto('/demo/');await page.getByRole('button',{name:'切換深色模式',exact:true}).click();await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.getByRole('button',{name:'新增一站',exact:true}).click();await expect(page.locator('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.locator('dialog')).not.toBeVisible();await expect(page.getByRole('button',{name:'新增一站',exact:true})).toBeFocused();
});
test('storage failure is visible and does not claim success',async({page})=>{
  await page.addInitScript(()=>{Storage.prototype.setItem=function(){throw new Error('Quota exceeded')};});await page.goto('/demo/');await nav(page,'shopping');await page.getByRole('checkbox',{name:'牛肉片已買齊',exact:true}).check();await expect(page.locator('.save-warning')).toBeVisible();await expect(page.locator('.sync-status')).toContainText('尚未儲存');
});
test('responsive layouts do not overflow on common phone widths',async({page})=>{
  for(const width of [320,390,768,1440]){
    await page.setViewportSize({width,height:900});await page.goto('/demo/');
    if(width<=390){const visibleDays=await page.locator('.date-tabs button').evaluateAll(items=>items.every(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));expect(visibleDays).toBe(true);}
    for(const tab of ['schedule','meals','shopping','gear','crew','settings']){await nav(page,tab);const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);expect(overflow,`${width}px ${tab}`).toBe(false);}
    for(const route of ['invite','go','home','privacy']){await page.goto('/demo/#/'+route);expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),`${width}px ${route}`).toBe(false);}
  }
});
test('no requests go to original site or other external services',async({page})=>{
  const remote=[];page.on('request',r=>{if(new URL(r.url()).origin!==new URL(process.env.CAMPING_BASE_URL||'http://127.0.0.1:5173').origin)remote.push(r.url());});await page.goto('/demo/');await nav(page,'meals');await page.goto('/demo/#/invite');expect(remote).toEqual([]);
});

test('corrupted stored data is preserved until explicitly replaced',async({page})=>{
  await page.addInitScript(key=>localStorage.setItem(key,'{broken original data'),STORAGE_KEY);
  await page.goto('/demo/');await expect(page.locator('.save-warning')).toBeVisible();
  await nav(page,'shopping');await page.getByRole('checkbox',{name:'牛肉片已買齊',exact:true}).check();
  expect(await page.evaluate(key=>localStorage.getItem(key),STORAGE_KEY)).toBe('{broken original data');
  await page.getByRole('button',{name:'處理儲存問題',exact:true}).click();await expect(page.getByRole('button',{name:'下載原始資料',exact:true})).toBeVisible();
});
test('discard prompt preserves an unsaved dialog when declined',async({page})=>{
  await page.goto('/demo/');await page.getByRole('button',{name:'新增一站',exact:true}).click();await page.getByLabel('活動名稱').fill('不要弄丟我的草稿');
  page.once('dialog',d=>d.dismiss());await page.keyboard.press('Escape');await expect(page.getByLabel('活動名稱')).toHaveValue('不要弄丟我的草稿');
  page.once('dialog',d=>d.accept());await page.keyboard.press('Escape');await expect(page.locator('#dialog')).not.toBeVisible();
});
test('another tab cannot silently overwrite an open edit draft',async({page,context})=>{
  await page.goto('/demo/');const other=await context.newPage();await other.goto('/demo/');
  await page.getByRole('button',{name:'新增一站',exact:true}).click();await page.getByLabel('活動名稱').fill('這個分頁的草稿');
  await nav(other,'shopping');await other.getByRole('checkbox',{name:'牛肉片已買齊',exact:true}).check();
  await expect(page.locator('.save-warning')).toBeVisible();await expect(page.getByLabel('活動名稱')).toHaveValue('這個分頁的草稿');
  await saveDialog(page);await expect(page.getByRole('heading',{name:'這個分頁的草稿',exact:true})).toBeVisible();await expect(page.locator('.save-warning')).toBeVisible();
  await other.close();
});
