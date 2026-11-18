// trip-planning-workflow-enhance: requirement 1.6 removed the schedule bar and its 「新增一站」 button from the 「行程表」 tab,
// and the day buttons now live in 「規劃行程」 (Itinerary_Editor, `.plan-days>.date-tabs`). TC-SCHED-001 therefore measures
// those day buttons and keeps mobile-smooth-swipe requirements 7.3 to 7.6 (same top, page width, 15-day scroll, not
// squeezed). Only the 「新增一站」 placement checks (7.1, 7.2) are removed, because that button no longer exists.
import {test,expect} from './local-planner-fixture.js';

// Layout regression for Requirement 7 (mobile-smooth-swipe, task 6.8): the 新增一站 button must never be pushed
// under the date tabs. schedule() in src/app.js renders it with button(icon('plus')+'新增一站','activity','small')
// as the last child of the schedule bar (removed by trip-planning-workflow-enhance), right after .date-tabs.
//
// Until task 3.3 deleted the schedule bar's wrap rules from src/styles.css, the button wrapped under the tabs at
// 761, 768, 820, 900 and 1020px with 8 and with 15 days. This file repeats that task's sweep from design.md,
// "Schedule Bar Placement": the demo trip's 3 days, then the same trip extended to 8 and to 15 days through
// 旅行選單, 編輯旅行 and 結束日期, the way tests/app.e2e.js edits it. On /demo/ those edits stay in this browser
// context's localStorage and never reach the server.
//
// Task 6.10 adds criterion 7.6 to the same sweep: no date button may be narrower than its content. Until task 3.4
// added flex-shrink:0 to the base .date-tabs>button rule, the buttons shrank at every width above 600px with 8 and
// with 15 days, down to 98px up to 760px, 91px up to 1020px and 102px beyond. The weekday then wrapped onto a second
// line, and at 91px a button's scrollWidth exceeded its clientWidth by up to 6px.

// Measure the CSS the server serves now, never a bundle a service worker cached, as mobile-swipe.e2e.js does.
test.use({serviceWorkers:'block'});

// Task 3.3's widths, including both sides of the 600, 760 and 1020px breakpoints.
const WIDTHS=[320,360,375,390,414,430,480,600,601,700,760,761,768,820,900,1020,1021,1280,1440];
const HEIGHT=900;
// The demo trip runs from 2026-11-20 to 2026-11-22. The later steps move only its end date.
const TRIPS=[{days:3,endDate:null},{days:8,endDate:'2026-11-27'},{days:15,endDate:'2026-12-04'}];

const nav=(page,tab)=>page.locator(`.section-tabs [data-tab="${tab}"]`).click();
const saveDialog=page=>page.locator('#edit-form button[type="submit"]').click();

/** Switch the 「行程表」 tab from 「行程圖」 to 「規劃行程」, whose day buttons are the ones measured here. */
async function openEditor(page){
 await page.locator('.plan-view-switch [data-view="editor"]').click();
 await expect(page.locator('.plan-days>.date-tabs')).toBeVisible();
}

/** Move the trip's end date with the trip menu's settings dialog, as tests/app.e2e.js does, then return to 「規劃行程」. */
async function setTripEnd(page,endDate){
 await page.getByRole('button',{name:'旅行選單',exact:true}).click();
 // Any action inside the drawer closes it before the dialog opens.
 await page.locator('#trip-menu').getByRole('button',{name:'編輯旅行',exact:true}).click();
 await page.getByLabel('結束日期').fill(endDate);
 await saveDialog(page);
 await expect(page.locator('#dialog')).not.toBeVisible();
 await nav(page,'schedule');
 await openEditor(page);
}

/**
 * In-page: the day buttons' geometry once the viewport is `width` px wide and the fonts have loaded, including each
 * date button's rendered and max-content widths, line boxes and overflow. It rejects when the page cannot be measured
 * as intended. page.evaluate serializes this function, so it must not reference anything outside its own body.
 */
async function measureScheduleBar(width){
 for(let i=0;i<10&&innerWidth!==width;i+=1)await new Promise(resolve=>requestAnimationFrame(()=>resolve()));
 if(innerWidth!==width)throw new Error(`the viewport is ${innerWidth}px wide, not ${width}px`);
 // The date buttons are sized by their text, so measure with the UI font, not its fallback.
 await document.fonts.ready;
 if(!document.fonts.check('400 16px "jf open 粉圓"'))throw new Error('the jf open 粉圓 font has not loaded');
 const bars=document.querySelectorAll('.plan-days>.date-tabs');
 if(bars.length!==1)throw new Error(`expected one .plan-days>.date-tabs, found ${bars.length}`);
 const tabs=bars[0];
 if(!tabs.getClientRects().length)throw new Error('.plan-days>.date-tabs is not rendered');
 const tabsBox=tabs.getBoundingClientRect(),dates=[...tabs.querySelectorAll(':scope>button')];
 // A date label is a grid item, so its own getClientRects() returns one box however many lines its text takes. A
 // Range over its contents returns a rect per line instead, and rects whose tops are within 1px share a line box.
 const lineBoxes=label=>{
  if(!label)return 0;
  const range=document.createRange();
  range.selectNodeContents(label);
  let count=0,top=-Infinity;
  for(const rect of [...range.getClientRects()].sort((a,b)=>a.top-b.top))if(rect.top-top>1){count+=1;top=rect.top;}
  return count;
 };
 const geometry={
  innerWidth,pageScrollWidth:document.documentElement.scrollWidth,
  tabs:{bottom:tabsBox.bottom,right:tabsBox.right,scrollWidth:tabs.scrollWidth,clientWidth:tabs.clientWidth,overflowX:getComputedStyle(tabs).overflowX},
  dateTops:dates.map(date=>date.offsetTop),
  dates:dates.map(date=>({
   day:date.querySelector(':scope>span')?.textContent??'',width:date.getBoundingClientRect().width,
   lines:Object.fromEntries([1,2,3].map(nth=>[`span:nth-child(${nth})`,lineBoxes(date.querySelector(`:scope>span:nth-child(${nth})`))])),
   scrollWidth:date.scrollWidth,clientWidth:date.clientWidth
  }))
 };
 // Max-content widths come last, once every rendered width above is recorded. As design.md's Amendment D describes,
 // each button is laid out with inline flex:none;width:max-content;min-width:0, marked important here so that no
 // stylesheet rule can resize it meanwhile. The style attribute is written and restored directly, so each button
 // gets back exactly the attribute it had, or none. Chrome's removeAttribute('style') after style.setProperty()
 // leaves style="" behind unless the attribute was read first.
 const styles=dates.map(date=>date.getAttribute('style'));
 try{
  dates.forEach((date,i)=>date.setAttribute('style',`${styles[i]??''};flex:none!important;width:max-content!important;min-width:0!important`));
  dates.forEach((date,i)=>{geometry.dates[i].maxContentWidth=date.getBoundingClientRect().width;});
 }finally{
  dates.forEach((date,i)=>{if(styles[i]===null)date.removeAttribute('style');else date.setAttribute('style',styles[i]);});
 }
 const kept=dates.findIndex((date,i)=>date.getAttribute('style')!==styles[i]);
 if(kept>=0)throw new Error(`${geometry.dates[kept].day} kept style="${dates[kept].getAttribute('style')}" after its max-content width was read`);
 return geometry;
}

