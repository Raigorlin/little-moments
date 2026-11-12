import {test,expect} from './local-planner-fixture.js';
import {seed,STORAGE_KEY} from '../src/model.js';
const nav=async(page,tab)=>page.locator(`.section-tabs [data-tab="${tab}"]`).click();
const openTripMenu=page=>page.getByRole('button',{name:'旅行選單',exact:true}).click();
const tripMenu=page=>page.locator('#trip-menu');
const saveDialog=async page=>page.locator('#edit-form button[type="submit"]').click();
test('[TC-DEMO-002] new local planner starts blank and reset stays blank',async({page})=>{
  await page.goto('/demo/?blank=1');await expect(page.getByRole('heading',{name:'我的露營旅行',exact:true})).toBeVisible();await expect(page.locator('.activity-card')).toHaveCount(0);
  const fresh=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),STORAGE_KEY);expect(fresh.activities).toEqual([]);expect(fresh.meals).toEqual([]);expect(fresh.shopping).toEqual([]);expect(fresh.gear).toEqual([]);
  await page.evaluate(key=>localStorage.removeItem(key),STORAGE_KEY);await page.goto('/demo/');await openTripMenu(page);await page.getByRole('button',{name:'清除旅行資料',exact:true}).click();await page.getByRole('button',{name:'清除並重新開始',exact:true}).click();
  await expect(page.getByRole('heading',{name:'我的露營旅行',exact:true})).toBeVisible();await expect(page.locator('.activity-card')).toHaveCount(0);await page.reload();await expect(page.getByRole('heading',{name:'我的露營旅行',exact:true})).toBeVisible();
});
test('[TC-DEMO-001] dashboard renders and all planning tabs work',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/demo/');await expect(page.getByRole('heading',{name:'雲海裡，住一晚'})).toBeVisible();
  const hero=page.locator('.hero');await expect(hero).toHaveCSS('background-image',/linear-gradient/);
  await expect(page.locator('.hero-art>.illustration>svg>rect').first()).toHaveCSS('fill','rgba(0, 0, 0, 0)');
  await page.setViewportSize({width:390,height:900});await expect(hero).toHaveCSS('background-image',/linear-gradient/);
  await page.setViewportSize({width:1440,height:1000});
  await expect(page.locator('.activity-card')).toHaveCount(5);
  await page.locator('[data-day="2026-11-21"]').click();await expect(page.locator('.activity-card')).toHaveCount(3);
  for(const [tab,title] of [['meals','一起煮，一起吃'],['shopping','把好吃的買齊'],['gear','小隊裝備分工'],['expenses','分帳與收據']]){await nav(page,tab);await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();}
  await openTripMenu(page);for(const title of ['旅行選單','旅行設定','旅伴','車輛'])await expect(tripMenu(page).getByRole('heading',{name:title,exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});
test('invite lets a new companion type their name and persists membership',async({page})=>{
  await page.goto('/demo/#/invite');await expect(page.locator('#join-button')).toBeDisabled();await expect(page.locator('#invite-form select')).toHaveCount(0);
  await page.getByLabel('你的名字或暱稱',{exact:true}).fill('小樹');await page.getByLabel('小隊角色（選填）',{exact:true}).fill('早餐擔當');await page.locator('#join-button').click();
  await expect(page).toHaveURL(/#\/trip/);await expect(page.locator('.profile-button')).toContainText('小樹');await openTripMenu(page);await expect(tripMenu(page).getByRole('heading',{name:'小樹 我',exact:true})).toBeVisible();await page.keyboard.press('Escape');
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
test('[TC-SWIPE-001] mobile list rows reveal edit and delete actions by swiping left @critical',async({page})=>{
  await page.goto('/demo/');await page.setViewportSize({width:390,height:900});
  const card=page.locator('.activity-card').first();
  await expect(card.locator('.swipe-actions')).toHaveCount(1);
  const heading=card.locator('h3'),box=await heading.boundingBox();
  await heading.dispatchEvent('pointerdown',{pointerType:'touch',clientX:box.x+box.width-10,clientY:box.y+10});
  await heading.dispatchEvent('pointerup',{pointerType:'touch',clientX:box.x+box.width-95,clientY:box.y+10});
  await expect(card).toHaveClass(/swipe-open/);
  await expect(card.locator('.swipe-actions [data-action="activity"]')).toBeVisible();
  await expect(card.locator('.swipe-actions [data-action="delete"]')).toBeVisible();
  await card.locator('.swipe-actions [data-action="delete"]').click();
  await expect(page.getByRole('heading',{name:'移除這個項目？'})).toBeVisible();
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await expect(card).toBeVisible();
  await page.setViewportSize({width:1440,height:1000});
  await expect(card.locator('.activity-top [data-action="activity"]')).toBeVisible();
});
test('[TC-DEMO-003] mobile planner keeps its first section close and selected navigation visible',async({page})=>{
  await page.goto('/demo/');
  for(const width of [320,390]){
    await page.setViewportSize({width,height:844});await page.evaluate(()=>window.scrollTo(0,0));
    const metrics=await page.evaluate(()=>({hero:document.querySelector('.hero:not(.hero-home)').getBoundingClientRect().height,workspace:document.querySelector('.workspace').getBoundingClientRect().top,scheduleBar:document.querySelector('.schedule-bar').getBoundingClientRect().height,documentWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth}));
    expect(metrics.hero,`${width}px hero`).toBeLessThan(250);expect(metrics.workspace,`${width}px workspace`).toBeLessThan(720);expect(metrics.scheduleBar,`${width}px schedule controls`).toBeLessThan(130);expect(metrics.documentWidth,`${width}px overflow`).toBeLessThanOrEqual(metrics.clientWidth);
  }
  const lastDay=page.locator('.date-tabs button').last();
  await lastDay.click();await expect(lastDay).toHaveAttribute('aria-pressed','true');
  const dayVisible=await page.evaluate(()=>{const days=document.querySelector('.date-tabs'),active=days.querySelector('button[aria-pressed="true"]'),list=days.getBoundingClientRect(),item=active.getBoundingClientRect();return item.left>=list.left&&item.right<=list.right;});
  expect(dayVisible).toBe(true);
  const tabs=page.locator('.section-tabs'),expensesTab=tabs.locator('[data-tab="expenses"]');
  await expensesTab.click();await expect(expensesTab).toHaveAttribute('aria-current','page');await expect(expensesTab).toBeInViewport();
  await page.evaluate(()=>window.scrollTo(0,650));
  const stickyTop=await tabs.evaluate(el=>el.getBoundingClientRect().top);
  expect(stickyTop).toBeGreaterThanOrEqual(78);expect(stickyTop).toBeLessThanOrEqual(85);
});
test('[TC-DEMO-004] meal card removes directly with an X after confirmation',async({page})=>{
  await page.goto('/demo/');await nav(page,'meals');
  const card=page.locator('.meal-card').filter({has:page.getByRole('heading',{name:'暖暖壽喜燒',exact:true})});
  await card.getByRole('button',{name:'移除 暖暖壽喜燒',exact:true}).click();
  await expect(page.getByRole('heading',{name:'移除這個項目？',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'取消',exact:true}).click();await expect(card).toBeVisible();
  await card.getByRole('button',{name:'移除 暖暖壽喜燒',exact:true}).click();
  await page.getByRole('button',{name:'確認移除',exact:true}).click();
  await expect(card).toHaveCount(0);
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
  await page.goto('/demo/');await openTripMenu(page);await tripMenu(page).getByRole('button',{name:'新增旅伴',exact:true}).click();await page.getByLabel('旅伴名字').fill('小樹');await page.getByLabel('小隊角色').fill('點心擔當');await saveDialog(page);await openTripMenu(page);await expect(tripMenu(page).getByRole('heading',{name:'小樹',exact:true})).toBeVisible();
  await tripMenu(page).getByRole('button',{name:'新增車輛',exact:true}).click();await page.getByLabel('車輛暱稱').fill('小樹號');await page.getByLabel('出發地點',{exact:true}).fill('台北車站');await page.getByLabel('座位數（含駕駛）').fill('1');await page.getByRole('checkbox',{name:'阿哲',exact:true}).check();await saveDialog(page);await expect(page.locator('.form-error')).toContainText('不能超過座位數');
  await page.getByLabel('座位數（含駕駛）').fill('4');await saveDialog(page);await openTripMenu(page);await expect(tripMenu(page).getByRole('heading',{name:'小樹號',exact:true})).toBeVisible();
});
test('invalid dates rejected; changed date range keeps activities visible',async({page})=>{
  await page.goto('/demo/');await openTripMenu(page);await page.getByRole('button',{name:'編輯旅行',exact:true}).click();await page.getByLabel('結束日期').fill('2026-11-01');await saveDialog(page);await expect(page.locator('.form-error')).toContainText('結束日期');
  await page.getByLabel('開始日期').fill('2027-02-01');await page.getByLabel('結束日期').fill('2027-02-03');await saveDialog(page);await nav(page,'schedule');await expect(page.locator('.activity-card')).toHaveCount(5);await expect(page.locator('.date-tabs')).toContainText('2/1');
});
test('export, validated import, and HTML text escaping',async({page})=>{
  await page.goto('/demo/');const downloadPromise=page.waitForEvent('download');await page.locator('.toolbar-actions [data-action="export"]').click();const dl=await downloadPromise;expect(dl.suggestedFilename()).toBe('good-good-camping-backup.json');
  await openTripMenu(page);await page.getByRole('button',{name:'匯入備份',exact:true}).click();await page.locator('input[type=file]').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{"schema":1}')});await page.getByRole('button',{name:'匯入並取代',exact:true}).click();await expect(page.locator('.form-error')).toContainText('不是有效');
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
    // Date tabs sit beside 新增一站 and scroll sideways when the days do not fit (mobile-smooth-swipe Requirement 7), so check the strip, not every button.
    if(width<=390){const days=await page.locator('.date-tabs').evaluate(el=>{const r=el.getBoundingClientRect(),items=[...el.children],fits=items.every(b=>{const x=b.getBoundingClientRect();return x.left>=r.left&&x.right<=r.right;});return {inViewport:r.left>=0&&r.right<=innerWidth,oneRow:new Set(items.map(b=>b.offsetTop)).size===1,reachable:fits||(getComputedStyle(el).overflowX==='auto'&&el.scrollWidth>el.clientWidth)};});expect(days).toEqual({inViewport:true,oneRow:true,reachable:true});}
    for(const tab of ['schedule','meals','shopping','gear','expenses']){await nav(page,tab);const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);expect(overflow,`${width}px ${tab}`).toBe(false);}
    await openTripMenu(page);await expect(tripMenu(page)).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),`${width}px trip menu`).toBe(false);
    expect(await tripMenu(page).evaluate(el=>el.scrollWidth>el.clientWidth+1),`${width}px trip menu content`).toBe(false);
    await page.keyboard.press('Escape');await expect(tripMenu(page)).toHaveCount(0);
    for(const route of ['invite','go','home','privacy']){await page.goto('/demo/#/'+route);expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),`${width}px ${route}`).toBe(false);}
  }
});
test('no requests go to original site or other external services',async({page})=>{
  const remote=[];page.on('request',r=>{if(new URL(r.url()).origin!==new URL(process.env.CAMPING_BASE_URL||'http://127.0.0.1:5173').origin)remote.push(r.url());});await page.goto('/demo/');await nav(page,'meals');await page.goto('/demo/#/invite');expect(remote).toEqual([]);
});

test('corrupted stored data is preserved until explicitly replaced',async({page})=>{
  await page.addInitScript(key=>localStorage.setItem(key,'{broken original data'),STORAGE_KEY);
  await page.goto('/demo/');await expect(page.locator('.save-warning')).toBeVisible();
  // Malformed storage loads the blank planner (see model.test.js), so make an edit that a blank trip allows.
  await page.getByRole('button',{name:'新增一站',exact:true}).click();await page.getByLabel('活動名稱').fill('不會覆蓋原始資料');await page.getByLabel('時間',{exact:true}).fill('09:00');await page.getByLabel('地點',{exact:true}).fill('營地');await saveDialog(page);
  await expect(page.getByRole('heading',{name:'不會覆蓋原始資料',exact:true})).toBeVisible();
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
test('[TC-TABS-001] section tabs are exactly the five remaining tabs numbered 01 to 05 @critical',async({page})=>{
  await page.goto('/demo/');const tabs=page.locator('.section-tabs [data-tab]');
  await expect(tabs).toHaveCount(5);
  expect(await tabs.evaluateAll(els=>els.map(el=>el.dataset.tab))).toEqual(['schedule','meals','shopping','gear','expenses']);
  await expect(page.locator('.section-tabs .tab-number')).toHaveText(['01','02','03','04','05']);
  await expect(page.locator('.section-tabs [data-tab="crew"], .section-tabs [data-tab="settings"]')).toHaveCount(0);
  await expect(page.locator('.section-tabs [data-tab="schedule"]')).toHaveAttribute('aria-current','page');
});
test('[TC-MENU-001] trip menu button sits by the title, toggles expanded state and returns focus on close @critical',async({page})=>{
  await page.goto('/demo/');
  const button=page.getByRole('button',{name:'旅行選單',exact:true});
  await expect(page.locator('.trip-title-row').getByRole('button',{name:'旅行選單',exact:true})).toBeVisible();
  await expect(page.locator('.trip-title-row h1')).toHaveText('雲海裡，住一晚');
  await expect(button).toHaveAttribute('aria-expanded','false');await expect(tripMenu(page)).toHaveCount(0);
  await button.click();await expect(tripMenu(page)).toBeVisible();await expect(button).toHaveAttribute('aria-expanded','true');await expect(button).toHaveAttribute('aria-controls','trip-menu');
  await tripMenu(page).getByRole('button',{name:'關閉旅行選單',exact:true}).click();
  await expect(tripMenu(page)).toHaveCount(0);await expect(button).toHaveAttribute('aria-expanded','false');await expect(button).toBeFocused();
  await button.click();await expect(tripMenu(page)).toBeVisible();await expect(button).toHaveAttribute('aria-expanded','true');
  await page.keyboard.press('Escape');
  await expect(tripMenu(page)).toHaveCount(0);await expect(button).toHaveAttribute('aria-expanded','false');await expect(button).toBeFocused();
});
test('[TC-DEMO-005] state saved before the change shows the same data in the trip menu and is not rewritten',async({page})=>{
  const stored=seed();
  stored.events=Array.from({length:10},(_,i)=>({id:`ev-${i}`,text:`動態第 ${i+1} 則`,at:`2026-11-0${Math.min(9,i+1)}T08:30:00.000Z`,actor:stored.people[i%stored.people.length].name}));
  await page.goto('/demo/');await page.evaluate(([key,value])=>localStorage.setItem(key,value),[STORAGE_KEY,JSON.stringify(stored)]);await page.reload();
  // Loading may prepend app-generated events (ingredient sync), so the drawer is compared to the loaded state.
  const before=await page.evaluate(key=>localStorage.getItem(key),STORAGE_KEY),loaded=JSON.parse(before);
  for(const ev of stored.events)expect(loaded.events).toContainEqual(ev);
  await openTripMenu(page);const menu=tripMenu(page);
  for(const p of stored.people)await expect(menu.locator('.member-card h3').filter({hasText:p.name})).toHaveCount(1);
  await expect(menu.locator('.member-card')).toHaveCount(stored.people.length);
  await expect(menu.locator('.vehicle-card h3')).toHaveText(stored.vehicles.map(v=>v.name));
  const details=menu.locator('.settings-panel dd');
  await expect(details.nth(0)).toHaveText(stored.trip.title);await expect(details.nth(1)).toHaveText(`${stored.trip.startDate} — ${stored.trip.endDate}`);
  await expect(details.nth(2)).toHaveText(stored.trip.destination);await expect(details.nth(3)).toHaveText(stored.trip.note);
  const events=menu.locator('.event-list li');await expect(events).toHaveCount(8);
  for(const [i,ev] of loaded.events.slice(0,8).entries())await expect(events.nth(i).locator('span')).toHaveText(`${ev.actor} ${ev.text}`);
  await menu.getByRole('button',{name:'關閉旅行選單',exact:true}).click();await expect(menu).toHaveCount(0);
  const after=await page.evaluate(key=>localStorage.getItem(key),STORAGE_KEY);
  expect(after).toBe(before);
  const parsed=JSON.parse(after);expect(parsed.people).toEqual(stored.people);expect(parsed.vehicles).toEqual(stored.vehicles);expect(parsed.trip).toEqual(stored.trip);expect(parsed.events).toEqual(loaded.events);
});
