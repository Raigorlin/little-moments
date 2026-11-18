import {test} from '@playwright/test';
import {expect,exampleTrip,writeLocalPlannerState} from './local-planner-fixture.js';
import {STORAGE_KEY} from '../src/model.js';
// 規劃行程與行程圖的無障礙瀏覽器測試（需求 16.1 至 16.14）。
// 以 Example_Trip（或其修改版）在本機版執行。「只用鍵盤」的測試只用 focus() 到達起點，之後的操作都由 Tab、Enter、
// 空白鍵與方向鍵完成。每個測試只寫入一次 Trip_State（writeLocalPlannerState 由第一個寫入的腳本決定）。

const poster=p=>p.locator('.itinerary-poster');
const editor=p=>p.locator('.itinerary-editor');
const card=p=>p.locator('form[data-plan-card]');
const dialog=p=>p.locator('#dialog');
const toasts=p=>p.locator('#toasts');
const stored=p=>p.evaluate(k=>JSON.parse(localStorage.getItem(k)),STORAGE_KEY);
const saveButton=p=>card(p).locator('[data-action="plan-save"]');
const rowButton=(p,text)=>p.locator('.plan-row-button',{hasText:text});

// 放棄 Draft 時的 window.confirm（需求 10.2）一律接受。
test.beforeEach(({page})=>{page.on('dialog',d=>d.accept());});
// 第一次呼叫時寫入 Example_Trip；之後重新載入頁面（頁面載入後檢視一律是行程圖，需求 1.2）。
async function open(p){
 if(!p.__seeded){await writeLocalPlannerState(p,exampleTrip());p.__seeded=true;}
 await p.goto('about:blank');await p.goto('/demo/#/trip');
 await expect(poster(p)).toBeVisible();await expect(p.locator('[data-poster-day]')).toHaveCount(3);
}
async function openEditor(p){
 await p.locator('.plan-view-switch [data-view="editor"]').click();
 await expect(p.locator('[data-plan-nav="day"]')).toHaveCount(3);
}
const day=(p,i)=>p.locator('[data-plan-nav="day"]').nth(i).click();
const segment=(p,name)=>p.locator(`[data-plan-nav="segment"][data-segment="${name}"]`).click();
async function openWith(p,state){await writeLocalPlannerState(p,state);p.__seeded=true;await open(p);}
function modified(change){const state=exampleTrip();change(state);return state;}
// 把焦點放在起點後，以 Enter 啟動。
async function press(p,locator,key='Enter'){await locator.focus();await expect(locator).toBeFocused();await p.keyboard.press(key);}
// 只用 Tab 前進，直到焦點落在 selector；超過 max 次沒有到達就失敗。
async function tabTo(p,selector,max=40){
 for(let i=0;i<max;i++){
  if(await p.evaluate(s=>Boolean(document.activeElement?.matches(s)),selector))return;
  await p.keyboard.press('Tab');
 }
 throw new Error(`Tab 沒有到達 ${selector}`);
}
// 以瀏覽器原生的下拉選單鍵盤操作選擇：空白鍵開啟清單、方向鍵移動 steps 次、Enter 選定。焦點回到下拉選單。
async function chooseByKeyboard(p,selector,steps){
 const select=p.locator(selector);
 await expect(select).toBeFocused();
 await p.keyboard.press('Space');
 for(let i=0;i<steps;i++)await p.keyboard.press('ArrowDown');
 await p.keyboard.press('Enter');
 await expect(p.locator(selector)).toBeFocused();
}
async function setTheme(p,theme){
 for(let i=0;i<2&&await p.locator('html').getAttribute('data-theme')!==theme;i++)await p.locator('[data-action="theme"]').first().click();
 await expect(p.locator('html')).toHaveAttribute('data-theme',theme);
}

// 頁面內的色彩工具：以 canvas 取得實際繪出的 sRGB 像素，避免解析 color-mix() 與 color() 的字串。
const COLOR_TOOLS=`
 const px=document.createElement('canvas');px.width=px.height=1;
 const cx=px.getContext('2d',{willReadFrequently:true});
 const rgba=c=>{cx.clearRect(0,0,1,1);cx.fillStyle='#000';cx.fillStyle=c;cx.fillRect(0,0,1,1);const d=cx.getImageData(0,0,1,1).data;return [d[0],d[1],d[2],d[3]/255];};
 const lum=([r,g,b])=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);};return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b);};
 const ratio=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);};
 const over=(top,under)=>{const a=top[3];return [0,1,2].map(i=>top[i]*a+under[i]*(1-a)).concat([1]);};
 const hidden=el=>{for(let n=el;n&&n!==document.documentElement;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden')return true;}const r=el.getBoundingClientRect();return r.width<2||r.height<2;};
 // 元素正後方的背景：往上疊合半透明底色，遇到漸層或圖片時回傳 complex。
 const backdrop=el=>{const layers=[];let complex=false;for(let n=el;n;n=n.parentElement){const s=getComputedStyle(n);if(s.backgroundImage!=='none')complex=true;const c=rgba(s.backgroundColor);if(c[3]>0){layers.push(c);if(c[3]>=1)break;}}let out=[255,255,255,1];for(let i=layers.length-1;i>=0;i--)out=over(layers[i],out);return {color:out,complex};};
`;

// ---------------------------------------------------------------------------------------------

test('[TC-ITIN-060] adding a Route and an Activity with the keyboard only: Tab order, Enter, Space and arrow keys, no drag needed',async({page:p})=>{
 await openWith(p,modified(s=>{s.routes=s.routes.filter(r=>r.date!=='2026-10-21');s.activities=s.activities.filter(a=>a.id!=='a5');}));
 // View_Switch：Tab 到達未選取的選項，以 Enter 啟動。
 await tabTo(p,'.plan-view-switch [data-view="editor"]',60);
 await p.keyboard.press('Enter');
 await expect(p.locator('[data-plan-nav="day"]')).toHaveCount(3);
 await expect(p.locator('.plan-view-switch [data-view="editor"]')).toBeFocused();
 await press(p,p.locator('[data-plan-nav="day"]').nth(1),'Space');
 await expect(p.locator('[data-plan-nav="day"]').nth(1)).toHaveAttribute('aria-pressed','true');
 // 第 2 天沒有路線時先顯示「活動」分段；以 Tab 到「路線」分段後用 Enter。
 await tabTo(p,'[data-plan-nav="segment"][data-segment="routes"]');
 await p.keyboard.press('Enter');
 await expect(p.locator('.plan-segments [data-segment="routes"]')).toHaveAttribute('aria-pressed','true');

 // 路線：Enter 展開，焦點移到「哪一台車」，方向鍵選取，Tab 依閱讀順序前進。
 const before=await stored(p);
 await press(p,p.locator('[data-plan-toggle="route:new"]'));
 await expect(p.locator('form[data-plan-card] [name="vehicle"]')).toBeFocused();
 if(await p.locator('form[data-plan-card] [name="vehicle"]').inputValue()==='')await chooseByKeyboard(p,'form[data-plan-card] [name="vehicle"]',1);
 await expect(p.locator('form[data-plan-card] [name="vehicle"]')).not.toHaveValue('');
 await tabTo(p,'form[data-plan-card] [name="from"]');
 await chooseByKeyboard(p,'form[data-plan-card] [name="from"]',2);
 await expect(p.locator('form[data-plan-card] [name="from"]')).not.toHaveValue('');
 await tabTo(p,'form[data-plan-card] [name="to"]');
 // 終點預設為目的地；只在未選擇時以鍵盤選取。
 if(await p.locator('form[data-plan-card] [name="to"]').inputValue()==='')await chooseByKeyboard(p,'form[data-plan-card] [name="to"]',1);
 await tabTo(p,'form[data-plan-card] [name="time"]');
 await p.keyboard.type('09:15');
 await tabTo(p,'form[data-plan-card] [data-action="plan-save"]');
 await p.keyboard.press('Enter');
 await expect(card(p)).toHaveCount(0);
 const after=await stored(p);
 const added=after.routes.filter(r=>!before.routes.some(b=>b.id===r.id));
 expect(added).toHaveLength(1);
 expect(added[0]).toMatchObject({date:'2026-10-21',time:'09:15',stops:[]});
 expect(added[0].from).not.toBe('');expect(added[0].to).not.toBe('');expect(added[0].from).not.toBe(added[0].to);
 // 儲存後焦點在新路線收起列的展開按鈕（16.7）。
 await expect(p.locator(`.plan-route[data-id="${added[0].id}"] .plan-row-button`)).toBeFocused();

 // 活動：單選按鈕以方向鍵選取，核取方塊以空白鍵切換。
 await press(p,p.locator('[data-plan-nav="segment"][data-segment="activities"]'));
 await expect(p.locator('.plan-segments [data-segment="activities"]')).toHaveAttribute('aria-pressed','true');
 await press(p,p.locator('[data-plan-toggle="activity:new"]'),'Space');
 const title=p.locator('form[data-plan-card] [name="title"]');
 await expect(title).toBeFocused();
 await p.keyboard.type('夜市散步');
 await tabTo(p,'form[data-plan-card] [name="time"]');
 await p.keyboard.press('Control+A');await p.keyboard.type('19:30');
 await tabTo(p,'form[data-plan-card] [name="participation"]');
 await p.keyboard.press('ArrowDown');
 await expect(p.locator('[name="participation"][value="vehicles"]')).toBeChecked();
 await tabTo(p,'form[data-plan-card] [name="vehicleIds"]');
 await p.keyboard.press('Space');
 await expect(p.locator('[name="vehicleIds"]').first()).toBeChecked();
 await p.keyboard.press('Space');
 await expect(p.locator('[name="vehicleIds"]').first()).not.toBeChecked();
 await p.locator('[name="participation"][value="vehicles"]').focus();
 await p.keyboard.press('ArrowUp');
 await expect(p.locator('[name="participation"][value="all"]')).toBeChecked();
 await tabTo(p,'form[data-plan-card] [data-action="plan-save"]');
 await p.keyboard.press('Enter');
 await expect(card(p)).toHaveCount(0);
 const activity=(await stored(p)).activities.find(a=>a.title==='夜市散步');
 expect(activity).toMatchObject({date:'2026-10-21',time:'19:30'});
 await expect(p.locator(`.plan-activity[data-id="${activity.id}"] .plan-row-button`)).toBeFocused();

 // 常用活動：空白鍵勾選，Enter 加入。
 const box=p.locator('[data-plan-preset="tea"]');
 await expect(box).toBeEnabled();
 await box.focus();await p.keyboard.press('Space');
 await expect(box).toBeChecked();
 await tabTo(p,'[data-action="plan-add-presets"]');
 await p.keyboard.press('Enter');
 await expect(box).toBeDisabled();
 expect((await stored(p)).activities.some(a=>a.type==='tea'&&a.date==='2026-10-21')).toBe(true);
});

test('[TC-ITIN-061] every expandable card, section and the Text_Panel reports aria-expanded and points aria-controls at its content; every field has a visible label',async({page:p})=>{
 await open(p);
 const panel=p.locator('[data-text-panel="toggle"]');
 await expect(panel).toHaveAttribute('aria-expanded','false');
 await panel.click();
 await expect(panel).toHaveAttribute('aria-expanded','true');
 expect(await panel.getAttribute('aria-controls')).toBe('text-panel-body');
 await expect(p.locator('#text-panel-body')).toBeVisible();
 await panel.click();
 await expect(panel).toHaveAttribute('aria-expanded','false');

 await openEditor(p);
 const toggles=['places','day','unassigned','route:new','arrival'];
 for(const key of toggles){
  const button=p.locator(`[data-plan-toggle="${key}"]`);
  if(await button.count()===0)continue;
  await expect(button).toHaveAttribute('aria-expanded','false');
  if(await button.isDisabled())continue;
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded','true');
  const id=await button.getAttribute('aria-controls');
  expect(id,`${key} aria-controls`).toBeTruthy();
  await expect(p.locator(`[id="${id}"]`)).toHaveCount(1);
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded','false');
 }
 // 路線列、新增地點與活動列。
 const row=p.locator('.plan-routes-list .plan-row-button').first();
 await row.click();
 await expect(row).toHaveAttribute('aria-expanded','true');
 const routeCard=await row.getAttribute('aria-controls');
 await expect(p.locator(`form[id="${routeCard}"]`)).toHaveCount(1);
 // 表單欄位：可見標籤（placeholder 不算）；成組的核取方塊與單選按鈕有 fieldset／legend。
 await expectLabelled(p);
 await row.click();
 await segment(p,'activities');
 await p.locator('[data-plan-toggle="activity:new"]').click();
 await expectLabelled(p);
 const groups=await card(p).locator('fieldset > legend').allTextContents();
 expect(groups).toEqual(expect.arrayContaining(['參加方式','指定的車輛']));
 await p.locator('[data-plan-toggle="activity:new"]').click();
 await expect(p.locator('fieldset.plan-presets > legend')).toHaveText('常用活動');
 const activityRow=p.locator('.plan-activities-list .plan-row-button').first();
 await activityRow.click();
 await expect(activityRow).toHaveAttribute('aria-expanded','true');
 await expect(p.locator(`form[id="${await activityRow.getAttribute('aria-controls')}"]`)).toHaveCount(1);
 // 重複的可見文字：核取方塊與按鈕的無障礙名稱含對象。
 await activityRow.click();
 const checks=await p.locator('[data-activity-check]').evaluateAll(list=>list.map(el=>el.getAttribute('aria-label')));
 expect(checks.length).toBeGreaterThan(0);
 for(const label of checks)expect(label).toMatch(/已完成$/);
 await expect(p.getByRole('checkbox',{name:'搭帳・營地佈置已完成'})).toHaveCount(1);
 await segment(p,'routes');
 await p.locator('[data-plan-toggle="places"]').click();
 await expect(p.getByRole('button',{name:/^改名 /}).first()).toBeVisible();
 await expect(p.getByRole('button',{name:/^刪除 /}).first()).toBeVisible();
});
async function expectLabelled(p){
 const bad=await card(p).evaluate(form=>[...form.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(el=>{
  const text=[...el.labels].map(l=>l.textContent.trim()).join('');
  return !text||el.getAttribute('aria-label')&&!text.includes(el.getAttribute('aria-label'));
 }).map(el=>el.name||el.outerHTML));
 expect(bad).toEqual([]);
}

const withoutPresets=()=>modified(s=>{s.activities=s.activities.filter(a=>a.id!=='a4'&&a.id!=='a5');});
test('[TC-ITIN-062] focus after expanding, collapsing, saving and discarding a card',async({page:p})=>{
 await openWith(p,withoutPresets());await openEditor(p);
 // 展開 → 第一個表單欄位。
 const row=rowButton(p,'第四車');
 await row.click();
 await expect(p.locator('form[data-plan-card] [name="vehicle"]')).toBeFocused();
 // 收起 → 收起列的展開按鈕。
 await row.click();
 await expect(card(p)).toHaveCount(0);
 await expect(row).toBeFocused();
 // 儲存後路線改變排序 → 焦點跟著移到新位置的收起列。
 await row.click();
 await card(p).locator('[name="time"]').fill('10:45');
 await saveButton(p).click();
 await expect(card(p)).toHaveCount(0);
 await expect(rowButton(p,'10:45 第四車')).toBeFocused();
 // 放棄從未儲存過的 Draft → 建立 Draft 的按鈕。
 const add=p.locator('[data-plan-toggle="route:new"]');
 if(await add.isEnabled()){
  await add.click();await expect(p.locator('form[data-plan-card] [name="vehicle"]')).toBeFocused();
  await add.click();await expect(card(p)).toHaveCount(0);await expect(add).toBeFocused();
 }
 // 活動：展開 → 標題；收起 → 展開按鈕；自訂活動儲存 → 新項目的收起列。
 await segment(p,'activities');
 const custom=p.locator('[data-plan-toggle="activity:new"]');
 await custom.click();
 await expect(card(p).locator('[name="title"]')).toBeFocused();
 await card(p).locator('[name="title"]').fill('晚間散步');
 await card(p).locator('[name="time"]').fill('20:00');
 await saveButton(p).click();
 await expect(card(p)).toHaveCount(0);
 await expect(rowButton(p,'晚間散步')).toBeFocused();
 await rowButton(p,'晚間散步').click();
 await expect(card(p).locator('[name="title"]')).toBeFocused();
 await rowButton(p,'晚間散步').click();
 await expect(rowButton(p,'晚間散步')).toBeFocused();
 // 一次加入多個常用活動 → 其中排在活動清單最前面的一筆（需求 16.7）。
 await day(p,1);
 await expect(p.locator('[data-plan-nav="day"]').nth(1)).toHaveAttribute('aria-pressed','true');
 const free=p.locator('[data-plan-preset="free"]');
 const tea=p.locator('[data-plan-preset="tea"]');
 await expect(free).toBeEnabled();await expect(tea).toBeEnabled();
 await free.check();await tea.check();
 await expect(p.locator('[data-action="plan-add-presets"]')).toHaveText('加入 2 個活動');
 const rows=p.locator('.plan-activities-list .plan-row-button');
 const keys=()=>rows.evaluateAll(els=>els.map(el=>el.getAttribute('data-focus')));
 const before=await keys();
 await p.locator('[data-action="plan-add-presets"]').click();
 await expect(rows).toHaveCount(before.length+2);
 // 新加入的兩筆中，在活動清單排最前面的一筆（10:00 自由活動、拍照）。
 const first=(await keys()).find(key=>!before.includes(key));
 await expect(p.locator(`.plan-activities-list [data-focus="${first}"]`)).toBeFocused();
 await expect(p.locator(`.plan-activities-list [data-focus="${first}"]`)).toContainText('自由活動、拍照');
});

test('[TC-ITIN-063] results of a save, a preset, the 完成 checkbox, a delete and copying are written to #toasts within a second, with the object named, and focus stays put',async({page:p,context})=>{
 await context.grantPermissions(['clipboard-read','clipboard-write']);
 await openWith(p,withoutPresets());
 const text=async expected=>{await expect(toasts(p)).toContainText(expected,{timeout:1000});};
 // 複製行程文字。
 await p.locator('[data-text-panel="copy"]').click();
 await text('行程文字');
 await expect(p.locator('[data-text-panel="copy"]')).toBeFocused();
 await expect(toasts(p)).toHaveAttribute('role','status');
 await openEditor(p);
 // 儲存路線：含車名與第 N 天。
 await rowButton(p,'第四車').click();
 await card(p).locator('[name="time"]').fill('10:45');
 await saveButton(p).click();
 await text('已儲存第四車第 1 天的路線');
 // 勾選「完成」：含活動標題，焦點留在核取方塊。
 await segment(p,'activities');
 const done=p.getByRole('checkbox',{name:'搭帳・營地佈置已完成'});
 const was=await done.isChecked();
 await done.click();
 await text(was?'「搭帳・營地佈置」改為未完成':'「搭帳・營地佈置」已完成');
 await expect(p.getByRole('checkbox',{name:'搭帳・營地佈置已完成'})).toBeFocused();
 // 加入常用活動。
 await day(p,1);
 const box=p.locator('[data-plan-preset="free"]');
 await box.check();
 await p.locator('[data-action="plan-add-presets"]').click();
 await text('已在第 2 天加入 1 個活動');
 // 刪除活動與路線。
 await p.locator('.plan-activities-list .plan-row-button',{hasText:'自由活動、拍照'}).click();
 await card(p).locator('[data-action="plan-delete"]').click();
 await dialog(p).getByRole('button',{name:'確認移除',exact:true}).click();
 await text('已刪除第 2 天的活動「自由活動、拍照」');
 await day(p,0);await segment(p,'routes');
 await rowButton(p,'10:45 第四車').click();
 await card(p).locator('[data-action="plan-delete"]').click();
 await dialog(p).getByRole('button',{name:'確認移除',exact:true}).click();
 await text('已刪除第四車第 1 天的路線');
 // 取消刪除不寫入提示、不放棄焦點。
 await rowButton(p,'第三車').click();
 await card(p).locator('[data-action="plan-delete"]').click();
 await toasts(p).evaluate(el=>{el.textContent='';});
 await dialog(p).getByRole('button',{name:'取消',exact:true}).click();
 await expect(card(p).locator('[data-action="plan-delete"]')).toBeFocused();
 await expect(toasts(p)).toHaveText('');
});

test('[TC-ITIN-064] hit targets are at least 44px, do not overlap, and every text is at least 12px at 320px and 1440px',async({page:p})=>{
 test.setTimeout(150000);
 for(const width of [320,1440]){
  await p.setViewportSize({width,height:900});
  await open(p);
  await checkTargets(p,poster(p));
  await openEditor(p);
  await p.locator('[data-plan-toggle="places"]').click();
  await p.locator('[data-plan-toggle="day"]').click();
  await checkTargets(p,editor(p));
  await p.locator('[data-plan-toggle="day"]').click();
  await p.locator('[data-plan-toggle="places"]').click();
  await rowButton(p,'第三車').click();
  await p.locator('[data-plan-op="add-place"]').first().click();
  await checkTargets(p,editor(p));
  await rowButton(p,'第三車').click();
  await segment(p,'activities');
  await p.locator('[data-plan-toggle="activity:new"]').click();
  await checkTargets(p,editor(p));
  await p.locator('[data-plan-toggle="activity:new"]').click();
  await day(p,1);
  await checkTargets(p,editor(p));
 }
});
async function checkTargets(p,root){
 const result=await root.evaluate(el=>{
  const visible=n=>{for(let x=n;x&&x!==document.documentElement;x=x.parentElement){const s=getComputedStyle(x);if(s.display==='none'||s.visibility==='hidden')return false;}return true;};
  const hiddenText=n=>n.closest('.visually-hidden,[aria-hidden="true"]')!==null||n.closest('style,script')!==null;
  const rectOf=n=>{const r=n.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height};};
  const targets=[...el.querySelectorAll('button,input:not([type=hidden]),select,textarea,summary')].filter(n=>visible(n)&&!n.closest('.visually-hidden'))
   .map(n=>{
    // 核取方塊與單選按鈕的點擊範圍可以包含點擊即可選取它的標籤。
    const label=['checkbox','radio'].includes(n.type)?[...n.labels].find(l=>visible(l)&&!l.closest('.visually-hidden')):null;
    const r=rectOf(n),l=label?rectOf(label):null;
    const w=Math.max(r.w,l?l.w:0),h=Math.max(r.h,l?l.h:0);
    return {name:(n.getAttribute('aria-label')||n.textContent||n.name||n.tagName).trim().slice(0,30),w,h,box:l&&l.w*l.h>r.w*r.h?l:r};
   });
  const small=targets.filter(t=>t.w<43.5||t.h<43.5).map(t=>`${t.name} ${Math.round(t.w)}x${Math.round(t.h)}`);
  const overlap=[];
  for(let i=0;i<targets.length;i++)for(let j=i+1;j<targets.length;j++){
   const a=targets[i].box,b=targets[j].box;
   const x=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x),y=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);
   if(x>1&&y>1)overlap.push(`${targets[i].name} × ${targets[j].name}`);
  }
  const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);
  const tiny=[];
  for(let n=walker.nextNode();n;n=walker.nextNode()){
   if(!n.textContent.trim())continue;
   const parent=n.parentElement;
   if(!visible(parent)||hiddenText(parent))continue;
   const size=parseFloat(getComputedStyle(parent).fontSize);
   if(size<12)tiny.push(`${parent.className||parent.tagName} ${size}px "${n.textContent.trim().slice(0,20)}"`);
  }
  return {small,overlap,tiny};
 });
 expect(result.small,'點擊範圍小於 44px').toEqual([]);
 expect(result.overlap,'點擊範圍重疊').toEqual([]);
 expect(result.tiny,'字級小於 12px').toEqual([]);
}

test('[TC-ITIN-065] computed text contrast is at least 4.5:1 and graphic contrast 3:1 in the light and dark themes',async({page:p})=>{
 test.setTimeout(180000);
 for(const theme of ['light','dark']){
  await open(p);await setTheme(p,theme);
  const failures=[];
  const scan=async name=>{
   const result=await p.evaluate(`(()=>{${COLOR_TOOLS}
    const out={text:[],graphic:[],complex:0,checked:0};
    for(const root of document.querySelectorAll('.itinerary-poster,.itinerary-editor')){
     const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
     for(let n=walker.nextNode();n;n=walker.nextNode()){
      if(!n.textContent.trim())continue;const el=n.parentElement;
      if(!el||hidden(el)||el.closest('[aria-hidden="true"],style,script,.visually-hidden'))continue;
      if(el.closest('button,input,select,textarea')?.disabled)continue;
      const bg=backdrop(el);if(bg.complex){out.complex++;continue;}
      const fg=rgba(getComputedStyle(el).color);const color=over(fg,bg.color);
      out.checked++;const r=ratio(color,bg.color);
      if(r<4.5)out.text.push(el.className+' '+r.toFixed(2)+' "'+n.textContent.trim().slice(0,16)+'"');
     }
     for(const el of root.querySelectorAll('input:not([type=hidden]):not(:disabled),select:not(:disabled),textarea:not(:disabled)')){
      if(hidden(el))continue;
      const bg=backdrop(el.parentElement);if(bg.complex)continue;
      if(el.placeholder){const ph=rgba(getComputedStyle(el,'::placeholder').color);const own=rgba(getComputedStyle(el).backgroundColor);const base=own[3]>0?over(own,bg.color):bg.color;const r=ratio(over(ph,base),base);out.checked++;if(r<4.5)out.text.push('placeholder '+r.toFixed(2)+' '+el.name);}
      if(!['checkbox','radio'].includes(el.type)){const s=getComputedStyle(el);const border=rgba(s.borderTopColor);if(parseFloat(s.borderTopWidth)>0&&border[3]>0){const r=ratio(over(border,bg.color),bg.color);if(r<3)out.graphic.push('border '+r.toFixed(2)+' '+(el.name||el.tagName));}}
     }
    }
    return out;})()`);
   if(result.text.length)failures.push(`${theme}/${name} text: ${result.text.slice(0,8).join(' | ')}`);
   if(result.graphic.length)failures.push(`${theme}/${name} graphic: ${result.graphic.slice(0,8).join(' | ')}`);
   expect(result.checked,`${theme}/${name} checked`).toBeGreaterThan(5);
  };
  await scan('poster');
  await p.locator('[data-text-panel="toggle"]').click();
  await scan('poster-text-panel');
  await openEditor(p);
  await p.locator('[data-plan-toggle="places"]').click();
  await scan('editor-places');
  await p.locator('[data-plan-toggle="places"]').click();
  await segment(p,'activities');
  await p.locator('[data-plan-toggle="activity:new"]').click();
  await scan('editor-activity-card');
  await p.locator('[data-plan-toggle="activity:new"]').click();
  await day(p,1);
  await scan('editor-day2'); // 含停用中的「已加入」常用活動與說明文字
  await day(p,0);await segment(p,'routes');
  await rowButton(p,'第三車・採買組').click();
  await expect(card(p)).toBeVisible();
  await scan('editor-route');
  expect(failures).toEqual([]);
  await p.evaluate(()=>localStorage.clear());
 }
});

test('[TC-ITIN-066] focus ring: a 2px solid ring with 3:1 against its background, and the focused control is not hidden by the sticky header or tab bar',async({page:p})=>{
 test.setTimeout(240000);
 for(const width of [390,1440]){
  await p.setViewportSize({width,height:700});
  for(const theme of ['light','dark']){
   await open(p);await setTheme(p,theme);
   await openEditor(p);
   await p.locator('[data-plan-toggle="places"]').click();
   await segment(p,'activities');
   const issues=[];
   await p.locator('.plan-view-switch [data-view="editor"]').focus();
   for(let i=0;i<45;i++){
    await p.keyboard.press('Tab');
    const info=await p.evaluate(`(()=>{${COLOR_TOOLS}
     const el=document.activeElement;if(!el||el===document.body)return {body:true};
     const root=el.closest('.itinerary-editor,.itinerary-poster');if(!root)return {skip:true,name:el.tagName};
     const s=getComputedStyle(el);
     const r=el.getBoundingClientRect();
     const bg=backdrop(el.parentElement);
     const ring=rgba(s.outlineColor);
     // 外框相鄰的背景：以元素外側的父層底色計算。
     const ratioValue=ratio(over(ring,bg.color),bg.color);
     // 固定在頂端的元素：頁首與手機版分頁列。
     const fixedTop=[...document.querySelectorAll('.topbar,.section-tabs,#toasts')].filter(n=>['fixed','sticky'].includes(getComputedStyle(n).position)).map(n=>n.getBoundingClientRect());
     let covered=false;const mx=r.left+r.width/2,my=r.top+r.height/2;
     const hit=document.elementFromPoint(mx,my);
     if(hit&&hit!==el&&!el.contains(hit)&&!(el.labels&&[...el.labels].some(l=>l.contains(hit)))&&!hit.contains(el))covered=true;
     const under=fixedTop.some(f=>r.top>=f.top-0.5&&r.bottom<=f.bottom+0.5);
     return {name:(el.getAttribute('aria-label')||el.textContent||el.name||el.tagName).trim().slice(0,24),style:s.outlineStyle,width:parseFloat(s.outlineWidth),ratio:ratioValue,complex:bg.complex,covered,under,offscreen:r.bottom<0||r.top>innerHeight,visibleCheckbox:['checkbox','radio'].includes(el.type)};
    })()`);
    if(info.body||info.skip)continue;
    const tag=`${width}/${theme} ${info.name}`;
    if(info.style==='none'||info.style==='hidden')issues.push(`${tag}: no outline`);
    else{
     if(info.style!=='solid')issues.push(`${tag}: outline ${info.style}`);
     if(info.width<2)issues.push(`${tag}: width ${info.width}`);
     if(!info.complex&&info.ratio<3)issues.push(`${tag}: ring contrast ${info.ratio.toFixed(2)}`);
    }
    if(info.covered)issues.push(`${tag}: covered`);
    if(info.under)issues.push(`${tag}: under sticky header`);
    if(info.offscreen)issues.push(`${tag}: not in view`);
   }
   expect(issues,`${width}/${theme}`).toEqual([]);
   await p.evaluate(()=>localStorage.clear());
  }
 }
});

test('[TC-ITIN-067] invalid fields: aria-invalid, aria-describedby to visible error text, first error focused, cleared after the next valid save',async({page:p})=>{
 await openWith(p,modified(s=>{s.routes=s.routes.filter(r=>r.date!=='2026-10-21');}));await openEditor(p);
 await day(p,1);await segment(p,'routes');
 await p.locator('[data-plan-toggle="route:new"]').click();
 const form=card(p);
 await form.locator('[name="time"]').fill('25:99');
 await saveButton(p).click();
 const invalid=form.locator('[aria-invalid="true"]');
 await expect(invalid.first()).toBeVisible();
 const names=await invalid.evaluateAll(els=>els.map(el=>el.name));
 expect(names).toEqual(expect.arrayContaining(['from','time']));
 // 第一個錯誤欄位取得焦點。
 await expect(form.locator(`[name="${names[0]}"]`)).toBeFocused();
 const checkDescribed=async()=>{for(const el of await invalid.all()){
  const ids=(await el.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean);
  expect(ids.length,'aria-describedby').toBeGreaterThan(0);
  const error=p.locator(`[id="${ids[0]}"]`);
  await expect(error).toBeVisible();
  expect((await error.textContent()).trim().length).toBeGreaterThan(0);
 }};
 await checkDescribed();
 // 改正起點後再儲存：起點不再標示錯誤，時間仍標示並取得焦點。
 await form.locator('[name="from"]').selectOption({label:'出發地點 A'});
 if(await form.locator('[name="vehicle"]').inputValue()==='')await form.locator('[name="vehicle"]').selectOption({index:1});
 if(await form.locator('[name="to"]').inputValue()==='')await form.locator('[name="to"]').selectOption({label:'超市／賣場'});
 await saveButton(p).click();
 await expect(form.locator('[name="from"]')).not.toHaveAttribute('aria-invalid','true');
 await expect(form.locator('[name="from"]')).not.toHaveAttribute('aria-describedby',/.+/);
 await expect(form.locator('[name="time"]')).toHaveAttribute('aria-invalid','true');
 await expect(form.locator('[name="time"]')).toBeFocused();
 await checkDescribed();
 await form.locator('[name="time"]').fill('07:30');
 await saveButton(p).click();
 await expect(card(p)).toHaveCount(0);
 // 活動：空標題。
 await segment(p,'activities');
 await p.locator('[data-plan-toggle="activity:new"]').click();
 await card(p).locator('[name="time"]').fill('');
 await saveButton(p).click();
 await expect(card(p).locator('[name="title"]')).toBeFocused();
 await expect(card(p).locator('[name="title"]')).toHaveAttribute('aria-invalid','true');
 const describedby=await card(p).locator('[name="title"]').getAttribute('aria-describedby');
 await expect(p.locator(`[id="${describedby}"]`)).toBeVisible();
 await card(p).locator('[name="title"]').fill('補充活動');
 await card(p).locator('[name="time"]').fill('08:00');
 await saveButton(p).click();
 await expect(card(p)).toHaveCount(0);
 // 「指定車輛」卻沒有勾選：核取方塊群組的錯誤文字。
 await p.locator('[data-plan-toggle="activity:new"]').click();
 await card(p).locator('[name="title"]').fill('分車活動');
 await card(p).locator('[name="time"]').fill('09:00');
 await card(p).locator('[name="participation"][value="vehicles"]').check();
 await saveButton(p).click();
 const group=card(p).locator('fieldset fieldset');
 await expect(group).toHaveAttribute('aria-describedby',/.+/);
 await expect(p.locator(`[id="${await group.getAttribute('aria-describedby')}"]`)).toBeVisible();
 // 新增地點：空名稱。
 await p.locator('[data-plan-toggle="activity:new"]').click();
 await segment(p,'routes');
 await p.locator('[data-plan-toggle="route:new"]').click();
 await card(p).locator('[data-plan-op="add-place"]').first().click();
 await card(p).locator('[data-plan-op="confirm-place"]').click();
 const inline=card(p).locator('[name="inlinePlace"]');
 await expect(inline).toHaveAttribute('aria-invalid','true');
 await expect(inline).toBeFocused();
 await expect(p.locator(`[id="${await inline.getAttribute('aria-describedby')}"]`)).toBeVisible();
 await inline.fill('新的集合點');
 await card(p).locator('[data-plan-op="confirm-place"]').click();
 await expect(card(p).locator('[name="inlinePlace"]')).toHaveCount(0);
});

test('[TC-ITIN-068] the poster has a level-2 heading, level-3 day headings with date and weekday, named lists, time elements, and aria-hidden art without focusable content',async({page:p})=>{
 await open(p);
 const h2=poster(p).getByRole('heading',{level:2});
 await expect(h2).toHaveText('行程圖');
 const days=poster(p).locator('[data-poster-day]');
 await expect(days).toHaveCount(3);
 const heads=poster(p).locator('[data-poster-day] h3');
 await expect(heads).toHaveCount(3);
 for(let i=0;i<3;i++){
  const name=(await heads.nth(i).textContent()).replace(/\s+/g,'');
  expect(name).toContain(`第${i+1}天`);
  expect(name).toMatch(/\d+月\d+日|\d{1,2}\/\d{1,2}|\d{4}/);
  expect(name).toMatch(/週[一二三四五六日]|星期[一二三四五六日]/);
 }
 // 每一天的段落以第 3 層標題開始，並以 aria-labelledby 指向它。
 for(const section of await days.all()){
  const id=await section.getAttribute('aria-labelledby');
  await expect(section.locator(`h3[id="${id}"]`)).toHaveCount(1);
  expect(await section.evaluate(el=>el.firstElementChild.querySelector('h3')!==null)).toBe(true);
 }
 // 路線與活動各是一個清單，項目是 li。
 const lists=await poster(p).locator('ul[aria-label="路線"],ul[aria-label="活動"]').evaluateAll(els=>els.map(ul=>({label:ul.getAttribute('aria-label'),items:[...ul.querySelectorAll('li')].length,bad:[...ul.children].filter(c=>c.tagName!=='LI').length})));
 expect(lists.length).toBeGreaterThanOrEqual(3);
 expect(lists.some(l=>l.label==='路線')).toBe(true);
 expect(lists.some(l=>l.label==='活動')).toBe(true);
 for(const l of lists){expect(l.items).toBeGreaterThan(0);expect(l.bad).toBe(0);}
 // time 元素：datetime 為 YYYY-MM-DD 或 HH:MM；「時間待定」「出發時間待定」不用 time。
 const times=await poster(p).locator('time').evaluateAll(els=>els.map(t=>({dt:t.getAttribute('datetime'),text:t.textContent.trim()})));
 expect(times.length).toBeGreaterThan(5);
 for(const t of times)expect(t.dt).toMatch(/^(\d{4}-\d{2}-\d{2}|([01]\d|2[0-3]):[0-5]\d)$/);
 expect(times.some(t=>/^\d{4}-\d{2}-\d{2}$/.test(t.dt))).toBe(true);
 expect(times.some(t=>/^\d{2}:\d{2}$/.test(t.dt))).toBe(true);
 expect(times.some(t=>/待定/.test(t.text))).toBe(false);
 // 插畫是 aria-hidden，裡面沒有可取得焦點的元件，也沒有文字。
 const art=await poster(p).locator('[aria-hidden="true"]').evaluateAll(els=>els.map(el=>({focusable:el.querySelectorAll('a[href],button,input,select,textarea,[tabindex]').length,text:el.tagName==='svg'||el.querySelector('svg')?(el.querySelector('text')?1:0):0})));
 expect(art.length).toBeGreaterThan(5);
 expect(art.filter(a=>a.focusable>0)).toEqual([]);
 expect(art.filter(a=>a.text>0)).toEqual([]);
 // 沒有行程的旅行：這時只有提示與「開始規劃」，沒有每日標題。
});

test('[TC-ITIN-069] focus placement after deleting, and when the control disappears with the view or tab',async({page:p})=>{
 await open(p);await openEditor(p);
 // (b) 刪除活動：移到同一清單中緊接在後的項目。
 await segment(p,'activities');
 const rows=p.locator('.plan-activities-list > li');
 const count=await rows.count();
 const kinds=await rows.evaluateAll(els=>els.map(el=>el.classList.contains('plan-activity')));
 // 有下一項的 Activity。
 const at=kinds.findIndex((isActivity,i)=>isActivity&&i<kinds.length-1);
 expect(at).toBeGreaterThanOrEqual(0);
 const nextTitle=await rows.nth(at+1).locator('.plan-row-name').textContent();
 await rows.nth(at).locator('.plan-row-button').click();
 await card(p).locator('[data-action="plan-delete"]').click();
 await dialog(p).getByRole('button',{name:'確認移除',exact:true}).click();
 await expect(rows).toHaveCount(count-1);
 await expect(rows.nth(at).locator('.plan-row-name')).toHaveText(nextTitle);
 await expect(rows.nth(at).locator('.plan-row-button')).toBeFocused();
 // 清單最後一筆 Activity（後面沒有項目）：移到緊接在前的項目。
 const kinds2=await rows.evaluateAll(els=>els.map(el=>el.classList.contains('plan-activity')));
 if(kinds2.at(-1)&&kinds2.length>1){
  await rows.last().locator('.plan-row-button').click();
  await card(p).locator('[data-action="plan-delete"]').click();
  await dialog(p).getByRole('button',{name:'確認移除',exact:true}).click();
  await expect(rows).toHaveCount(count-2);
  await expect(rows.last().locator('.plan-row-button')).toBeFocused();
 }
 // (c) 「到採買清單調整負責人」：Shopping_Tab 的主分頁按鈕。
 await segment(p,'routes');
 await rowButton(p,'第三車・採買組').click();
 await card(p).getByRole('button',{name:'到採買清單調整負責人 超市／賣場',exact:true}).click();
 await expect(p.locator('[data-tab="shopping"]').first()).toBeFocused();
 // 回到行程表分頁，切換到行程圖：焦點留在 View_Switch 的選項。
 await p.locator('[data-tab="schedule"]').first().click();
 await openEditor(p);
 await p.locator('.plan-view-switch [data-view="poster"]').click();
 await expect(poster(p)).toBeVisible();
 await expect(p.locator('.plan-view-switch [data-view="poster"]')).toBeFocused();
});
