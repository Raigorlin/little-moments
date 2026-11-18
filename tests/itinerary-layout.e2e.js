import {test} from '@playwright/test';
import {expect,exampleTrip,writeLocalPlannerState,EXAMPLE_TEXT} from './local-planner-fixture.js';
import {DESTINATION_REF} from '../src/itinerary-model.js';
import {STORAGE_KEY} from '../src/model.js';
// 行程圖與規劃行程的版面瀏覽器測試（需求 11.5、11.6、11.13、11.14、11.15、12.10、17.1 至 17.4、17.8、23.6）。
// 本機版載入 Example_Trip 或它的壓力版本（8 台車、每台 6 個 Stop、50 與 100 字的文字；8 條路線與 3 個交錯的終點組）。
// 量測只讀瀏覽器算出的版面（getBoundingClientRect、Range 的文字矩形），並以 reducedMotion 固定動畫，讓車子停在起點。
// 每個測試只寫入一次 Trip_State（writeLocalPlannerState 由第一個寫入的腳本決定）。

const SIZES=[320,390,1440];
const THEMES=['light','dark'];
const poster=p=>p.locator('.itinerary-poster');
const card=p=>p.locator('form[data-plan-card]');
const stored=p=>p.evaluate(k=>JSON.parse(localStorage.getItem(k)),STORAGE_KEY);

test.beforeEach(({page})=>{page.on('dialog',d=>d.accept());});
async function open(p,state,size={width:1440,height:900}){
 await p.emulateMedia({reducedMotion:'reduce'});
 await p.setViewportSize(size);
 if(!p.__seeded){await writeLocalPlannerState(p,state);p.__seeded=true;}
 await p.goto('about:blank');await p.goto('/demo/#/trip');
 await expect(poster(p)).toBeVisible();
 await p.evaluate(()=>document.fonts.ready);
}
async function setTheme(p,theme){
 for(let i=0;i<2&&await p.locator('html').getAttribute('data-theme')!==theme;i++)await p.locator('[data-action="theme"]').first().click();
 await expect(p.locator('html')).toHaveAttribute('data-theme',theme);
}
async function resize(p,width,height=900){
 await p.setViewportSize({width,height});
 await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
}

// ---- 資料 ------------------------------------------------------------------------------------------------------------
const WORDS='小夕松山溪雲林星河營火露日風';
// 固定長度的中文字串；開頭的編號讓每個名稱都不同。
const text=(seed,length)=>{const head=String(seed);return head+Array.from({length:length-head.length},(_,i)=>WORDS[(seed+i*5)%WORDS.length]).join('');};
const car=(id,n,name)=>({id,name,driver:`p${n}`,seats:4,passengers:[],meeting:''});
const route=(id,date,vehicleId,from,to,time,stops=[])=>({id,date,vehicleId,from,to,time,stops});
const DAY_1='2026-10-20';
const at=i=>`${String(8+Math.floor(i/2)).padStart(2,'0')}:${i%2?'30':'00'}`;

/** 路線區塊（第 1 天）有 8 台車、每台 6 個 Stop；車名與地點名稱 50 字、旅行目的地 100 字、Stop 備註 100 字、採買清單很長。 */
function stress8x6(){
 const state=exampleTrip();
 state.trip.destination=text(900,100);
 state.vehicles=Array.from({length:8},(_,i)=>car(`v${i+1}`,i+1,text(100+i,50)));
 state.places=[];state.routes=[];state.shopping=[];
 const place=(name)=>{const id=`pl-${state.places.length+1}`;state.places.push({id,name});return id;};
 const kinds=['shop','pickup','gear','other','shop','other'];
 state.vehicles.forEach((vehicle,i)=>{
  const stops=kinds.map((kind,j)=>({id:`st-${i+1}-${j+1}`,place:place(text(200+i*10+j,50)),kind,note:text(300+i*10+j,100)}));
  state.routes.push(route(`rt-${i+1}`,DAY_1,vehicle.id,place(text(500+i,50)),DESTINATION_REF,at(i),stops));
  state.shopping.push({id:`sh-${i+1}`,name:text(700+i,50),quantity:'1 袋',category:'其他',assignee:`p${i+1}`,done:false,source:'manual'});
 });
 return state;
}
/** 路線區塊（「其他」區塊，終點都不是營地）有 8 條路線與 3 個交錯的終點組（終點依序為 X、Y、Z、X、Y、Z、X、Y）；每條路線 0 到 2 個 Stop。 */
function interleaved8(){
 const state=exampleTrip();
 state.vehicles=Array.from({length:8},(_,i)=>car(`v${i+1}`,i+1,`第${i+1}車${text(i,12)}`));
 state.places=[];state.routes=[];state.shopping=[];
 const place=name=>{const id=`pl-${state.places.length+1}`;state.places.push({id,name});return id;};
 const endX=place(text(801,24)),endY=place(text(802,24)),endZ=place(text(803,24));
 const ends=[endX,endY,endZ,endX,endY,endZ,endX,endY];
 state.vehicles.forEach((vehicle,i)=>{
  const stops=Array.from({length:i%3},(_,j)=>({id:`st-${i+1}-${j+1}`,place:place(text(400+i*3+j,14)),kind:['pickup','gear','other'][j%3],note:text(600+i,10)}));
  state.routes.push(route(`rt-${i+1}`,DAY_1,vehicle.id,place(text(300+i,14)),ends[i],at(i),stops));
 });
 return state;
}

// ---- 頁面內的量測 ------------------------------------------------------------------------------------------------------
// 文字範圍（每個文字節點的每一行各一個矩形）、插畫範圍，以及兩兩相交的判斷（容許 1 CSS 像素的誤差）。
const TOOLS=`
 const shown=el=>{for(let n=el;n&&n!==document.documentElement;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||n.classList.contains('visually-hidden'))return false;}return true;};
 const box=q=>({x:q.left,y:q.top,w:q.width,h:q.height});
 const label=el=>el.tagName.toLowerCase()+(el.className&&typeof el.className==='string'?'.'+el.className.trim().split(/\\s+/).join('.'):'');
 const textBoxes=root=>{
  const out=[],walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  for(let n=walker.nextNode();n;n=walker.nextNode()){
   if(!n.nodeValue.trim())continue;
   const el=n.parentElement;
   if(!el||el.closest('svg,style,script')||!shown(el))continue;
   const range=document.createRange();range.selectNodeContents(n);
   const rects=[...range.getClientRects()].filter(q=>q.width>0.5&&q.height>0.5).map(box);
   if(rects.length)out.push({text:n.nodeValue.trim().slice(0,24),owner:label(el),rects});
  }
  return out;
 };
 const hit=(a,b)=>a.x+a.w-1>b.x&&b.x+b.w-1>a.x&&a.y+a.h-1>b.y&&b.y+b.h-1>a.y;
 const overlapsAny=(a,b)=>a.rects.some(r=>b.rects.some(s=>hit(r,s)));
`;
// 回傳違規清單（空陣列為通過）。selectors 是文字不可重疊的插畫；回傳最多 12 項供失敗訊息使用。
const textReport=(p,rootSelector,artSelector)=>p.evaluate(`(()=>{${TOOLS}
 const root=document.querySelector(${JSON.stringify(rootSelector)});
 const problems=[];
 const view=document.documentElement;
 if(view.scrollWidth>innerWidth)problems.push('page scrolls sideways: scrollWidth '+view.scrollWidth+' > '+innerWidth);
 const rb=root.getBoundingClientRect();
 const texts=textBoxes(root);
 if(texts.length===0)problems.push('no text found');
 for(const t of texts)for(const r of t.rects){
  if(r.x<rb.left-1||r.x+r.w>rb.right+1)problems.push('text outside '+${JSON.stringify(rootSelector)}+': '+t.owner+' "'+t.text+'" x '+Math.round(r.x)+'..'+Math.round(r.x+r.w)+' root '+Math.round(rb.left)+'..'+Math.round(rb.right));
  if(r.x<-1||r.x+r.w>innerWidth+1)problems.push('text outside viewport: '+t.owner+' "'+t.text+'"');
 }
 // 沒有被裁切或需要水平捲動的內容：任何元素的內容寬度超過自己的框，而且框不允許捲動。
 for(const el of root.querySelectorAll('*')){
  // 輸入框與下拉選單內的文字依瀏覽器原生方式顯示，選日按鈕列可在列內水平捲動（需求 17.1、4.3）。
  if(el.closest('svg,.date-tabs')||el.matches('input,select,textarea')||!shown(el))continue;
  const s=getComputedStyle(el);
  if(el.scrollWidth>el.clientWidth+1&&el.clientWidth>0&&!['inline'].includes(s.display)){
   if(s.textOverflow==='ellipsis'||['hidden','clip'].includes(s.overflowX)||['auto','scroll'].includes(s.overflowX))problems.push('clipped or scrolling content: '+label(el)+' '+el.scrollWidth+' > '+el.clientWidth);
  }
  if(s.textOverflow==='ellipsis')problems.push('ellipsis: '+label(el));
 }
 for(let i=0;i<texts.length;i++)for(let j=i+1;j<texts.length;j++)if(overlapsAny(texts[i],texts[j]))problems.push('text overlap: '+texts[i].owner+' "'+texts[i].text+'" x '+texts[j].owner+' "'+texts[j].text+'"');
 if(${JSON.stringify(artSelector??'')}){
  const arts=[...root.querySelectorAll(${JSON.stringify(artSelector??'')})].filter(shown).map(el=>({owner:label(el),rects:[box(el.getBoundingClientRect())].filter(q=>q.w>0&&q.h>0)})).filter(a=>a.rects.length);
  for(const t of texts)for(const a of arts)if(overlapsAny(t,a))problems.push('text over art: '+t.owner+' "'+t.text+'" x '+a.owner);
 }
 return problems.slice(0,12);
})()`);
const ART='.rm-stop-art,.rm-end-art,.rm-relay--first .rm-car,.rm-space,.rm-chip,.moment-art';

// ---- Example_Trip --------------------------------------------------------------------------------------------------------

const SUMMARY='三天兩夜・四台車・10/20（週二）至 10/22（週四）';
// 文字版 Example_Text 的各行在行程圖中依文件順序對應的 data-line 元素（需求 11.4）。
const EXAMPLE_ORDER=[
 'day:2026-10-20','route:rt-1-v1','route:rt-1-v2','route:rt-1-v3','route:rt-1-v4','arrival:2026-10-20',
 'activity:a1','meal:m1','activity:a2',
 'day:2026-10-21','activity:a3','meal:m2','activity:a4','meal:m3','activity:a5','meal:m4','activity:a6',
 'day:2026-10-22','activity:a7','meal:m5','activity:a8','activity:a9','activity:a10',
 'route:rt-3-v1','route:rt-3-v2','route:rt-3-v3','route:rt-3-v4','return:2026-10-22'
];
const POSTER_STRINGS=[
 SUMMARY,'向山裡出發','10/20（週二）・四車出發・採買・會合','住進慢慢的日子','今天，留在夕淞度日營區','把快樂一起帶回家','10/22（週四）・四車出發・返程',
 '08:00','第一車','出發地點 A','第三車・採買組','超市／賣場','採買：五花肉片、鮮蝦、高麗菜、運動飲料、洋芋片、瓦斯、衛生紙、免洗餐具',
 '第三車・採買組先採買，其他三車直達','預計 12:00 抵達・四車會合','平安回到台北','搭帳・營地佈置','晚餐：烤肉派對','培根、炒蛋、吐司、咖啡',
 '四台車，三天兩夜，一整頁的小小快樂。','路線僅為示意，非導航或即時位置；不預估返抵時間。'
];
// 行程圖文字依需求 11 的順序出現在畫面上（innerText 反映實際顯示的文字）。
async function posterFacts(p){
 return p.evaluate(()=>{
  const el=document.querySelector('.itinerary-poster');
  const lines=[...el.querySelectorAll('[data-line]')].map(n=>`${n.dataset.line}:${n.dataset.id}`);
  return {text:el.innerText,lines,days:el.querySelectorAll('[data-poster-day]').length};
 });
}
function expectOrder(facts){
 expect(facts.days).toBe(3);
 expect(facts.lines).toEqual(EXAMPLE_ORDER);
 let at=0;
 // 行程圖由上往下的文字順序：概要、各天標題、路線、活動、結尾與免責聲明。
 for(const piece of [SUMMARY,'向山裡出發','出發地點 A','夕淞度日營區','搭帳・營地佈置','住進慢慢的日子','把快樂一起帶回家','平安回到台北','四台車，三天兩夜，一整頁的小小快樂。','路線僅為示意，非導航或即時位置；不預估返抵時間。']){
  const index=facts.text.indexOf(piece,at);
  expect(index,`"${piece}" after offset ${at}`).toBeGreaterThanOrEqual(0);
  at=index;
 }
 for(const piece of POSTER_STRINGS)expect(facts.text,piece).toContain(piece);
}

test('[TC-ITIN-070] Example_Trip poster text and order are the same at 320, 390 and 1440 CSS px in light and dark @critical',async({page:p})=>{
 test.setTimeout(120000);
 await open(p,exampleTrip(),{width:1440,height:900});
 const order=(await posterFacts(p)).lines;
 for(const theme of THEMES){
  await setTheme(p,theme);
  for(const width of SIZES){
   await resize(p,width);
   const facts=await posterFacts(p);
   expectOrder(facts);
   expect(facts.lines,`${theme} ${width}`).toEqual(order); // 寬度與主題改變不影響內容與順序
   expect(await textReport(p,'.itinerary-poster',ART),`${theme} ${width}`).toEqual([]);
  }
 }
 // 文字版（Text_Panel）完整顯示 Example_Text，長行自動換行（需求 17.1）。
 await p.locator('[data-text-panel="toggle"]').click();
 await expect(p.locator('#text-panel-body')).toHaveText(EXAMPLE_TEXT,{useInnerText:false});
});

test('[TC-ITIN-071] Example_Trip: the route map runs top to bottom at 760 CSS px and below and left to right above it, cards take 2 per row at most then 3 or more',async({page:p})=>{
 test.setTimeout(90000);
 await open(p,exampleTrip());
 const measure=()=>p.evaluate(()=>{
  const r=el=>{const b=el.getBoundingClientRect();return {x:b.left,y:b.top,w:b.width,h:b.height};};
  const maps=[...document.querySelectorAll('.route-map')].map(map=>{
   const deps=[...map.querySelectorAll('.rm-dep')].map(r);
   const stopArt=[...map.querySelectorAll('.rm-stop-art')].map(r);
   const ends=[...map.querySelectorAll('.rm-end')].map(r);
   return {deps,stopArt,ends,end:ends.at(-1)};
  });
  const lists=[...document.querySelectorAll('.moment-list')].map(list=>{
   const rows=new Map();
   for(const card of list.children){const b=card.getBoundingClientRect();const key=Math.round(b.top/4);rows.set(key,(rows.get(key)??0)+1);}
   return [...rows.entries()].sort((a,b)=>a[0]-b[0]).map(e=>e[1]);
  });
  return {maps,lists};
 });
 for(const width of [320,390,760,761,1440]){
  await resize(p,width);
  const {maps,lists}=await measure();
  expect(maps.length).toBe(2);
  for(const map of maps){
   const lastDep=map.deps.at(-1);
   if(width<=760){
    // 出發列表在最上方，Stop 插圖在其下，終點插畫在最下方（11.5、11.7、17.2）。
    for(const art of map.stopArt)expect(art.y,`${width} stop below departures`).toBeGreaterThanOrEqual(map.deps[0].y);
    expect(map.end.y+1,`${width} end below last departure`).toBeGreaterThanOrEqual(lastDep.y);
    for(const art of map.stopArt)expect(map.end.y+map.end.h+1,`${width} end below stops`).toBeGreaterThanOrEqual(art.y+art.h);
    for(let i=1;i<map.deps.length;i++)expect(map.deps[i].y).toBeGreaterThan(map.deps[i-1].y);
   }else{
    // 出發列表在最左側，終點插畫在最右側（17.3）。
    for(const dep of map.deps)expect(map.end.x,`${width} end right of departures`).toBeGreaterThanOrEqual(dep.x+dep.w-1);
    for(const art of map.stopArt)expect(art.x,`${width} stop right of departures`).toBeGreaterThanOrEqual(map.deps[0].x+map.deps[0].w-1);
    for(const art of map.stopArt)expect(map.end.x,`${width} end right of stops`).toBeGreaterThanOrEqual(art.x+art.w-1);
   }
  }
  for(const counts of lists){
   if(width<=760)expect(Math.max(...counts),`${width} cards per row`).toBeLessThanOrEqual(2);
   else for(const count of counts.slice(0,-1))expect(count,`${width} cards per full row`).toBeGreaterThanOrEqual(3);
  }
 }
});

test('[TC-ITIN-072] dark theme: the summary, day sections, route maps, cards and Text_Panel use only dark palette colors, light theme uses the light palette',async({page:p})=>{
 test.setTimeout(90000);
 await open(p,exampleTrip());
 await p.locator('[data-text-panel="toggle"]').click();
 const read=()=>p.evaluate(()=>{
  const css=n=>getComputedStyle(n);
  const root=getComputedStyle(document.documentElement);
  const pick=sel=>[...document.querySelectorAll(sel)].filter(n=>n.getBoundingClientRect().width>0).map(n=>({sel,bg:css(n).backgroundColor,color:css(n).color}));
  return {
   paper:root.getPropertyValue('--ip-paper').trim(),card:root.getPropertyValue('--ip-card').trim(),
   poster:pick('.itinerary-poster'),cards:pick('.route-map,.moment-card,.itinerary-text-panel'),
   plain:pick('.poster-summary,.poster-day')
  };
 });
 const rgb=hex=>{const n=parseInt(hex.slice(1),16);return `rgb(${n>>16}, ${(n>>8)&255}, ${n&255})`;};
 const light=await read();
 expect(light.poster[0].bg).toBe(rgb(light.paper));
 for(const c of light.cards)expect(c.bg,c.sel).toBe(rgb(light.card));
 await setTheme(p,'dark');
 const dark=await read();
 expect(dark.paper).not.toBe(light.paper);
 expect(dark.poster[0].bg).toBe(rgb(dark.paper));
 expect(dark.cards.length).toBeGreaterThan(3);
 for(const c of dark.cards){expect(c.bg,c.sel).toBe(rgb(dark.card));expect(c.bg,c.sel).not.toBe(rgb(light.card));}
 // 概要列與每天的段落沒有自己的底色（透出行程圖的深色底色）。
 for(const c of dark.plain)expect(c.bg,c.sel).toBe('rgba(0, 0, 0, 0)');
 // 深色底色上的文字是亮色，不是淺色主題的深色文字。
 const lum=c=>{const m=c.match(/\d+/g).map(Number);return 0.2126*m[0]+0.7152*m[1]+0.0722*m[2];};
 for(const c of [...dark.poster,...dark.cards])expect(lum(c.color),c.sel).toBeGreaterThan(150);
});

// ---- 壓力資料 ---------------------------------------------------------------------------------------------------------

test('[TC-ITIN-073] 8 cars with 6 Stops each and 50 and 100 character names: all text is shown, no two texts overlap, and no text covers a line, car or illustration in 320 to 1440 CSS px',async({page:p})=>{
 test.setTimeout(240000);
 await open(p,stress8x6());
 for(const theme of THEMES){
  await setTheme(p,theme);
  for(const width of [320,390,600,760,761,1024,1440]){
   await resize(p,width);
   const facts=await p.evaluate(()=>({
    maps:document.querySelectorAll('.route-map').length,
    deps:document.querySelectorAll('.route-map .rm-dep').length,
    stops:document.querySelectorAll('.route-map .rm-stop').length,
    caption:document.querySelector('.rm-caption')?.textContent??''
   }));
   expect(facts,`${theme} ${width}`).toMatchObject({maps:1,deps:8,stops:48});
   expect(facts.caption).toContain('先採買');
   expect(await textReport(p,'.itinerary-poster',ART),`${theme} ${width}`).toEqual([]);
  }
 }
});

test('[TC-ITIN-074] 8 routes in 3 interleaved end groups: no sideways scroll, no text overlap, roads of different groups apart, each group parks inside its own end',async({page:p})=>{
 test.setTimeout(240000);
 await open(p,interleaved8());
 for(const theme of THEMES){
  await setTheme(p,theme);
  for(const width of [320,390,761,1024,1440]){
   await resize(p,width);
   expect(await textReport(p,'.itinerary-poster',ART),`${theme} ${width}`).toEqual([]);
   const groups=await p.evaluate(()=>{
    const box=el=>{const b=el.getBoundingClientRect();return {x:b.left,y:b.top,w:b.width,h:b.height};};
    const map=document.querySelector('.route-map');
    const roads=[...map.querySelectorAll('.rm-road')].map(el=>({g:el.style.getPropertyValue('--g'),box:box(el)}));
    const ends=[...map.querySelectorAll('.rm-end')].map(el=>({g:el.style.getPropertyValue('--g'),box:box(el),spaces:[...el.querySelectorAll('.rm-space')].map(box)}));
    const outside=[...map.querySelectorAll('.rm-space')].filter(s=>!s.closest('.rm-end')).length;
    // 路線圖中直接包含文字的元素（不含彼此有祖孫關係的）邊界框兩兩不相交。
    const owners=[...new Set([...map.querySelectorAll('*')].filter(el=>!el.closest('svg')&&[...el.childNodes].some(n=>n.nodeType===3&&n.nodeValue.trim())).filter(el=>{
     // 換行的行內元素（連結、備註）的外框是各行的聯集，會與同一段落的其他行內元素相交；它們的文字由 Range 矩形檢查。
     if(getComputedStyle(el).display==='inline')return false;
     for(let n=el;n&&n!==map;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||n.classList.contains('visually-hidden'))return false;}
     return true;
    }))];
    const hit=(a,b)=>a.left+a.width-1>b.left&&b.left+b.width-1>a.left&&a.top+a.height-1>b.top&&b.top+b.height-1>a.top;
    const crossings=[];
    for(let i=0;i<owners.length;i++)for(let j=i+1;j<owners.length;j++){
     if(owners[i].contains(owners[j])||owners[j].contains(owners[i]))continue;
     if(hit(owners[i].getBoundingClientRect(),owners[j].getBoundingClientRect()))crossings.push(owners[i].className+' x '+owners[j].className);
    }
    return {roads,ends,outside,crossings:crossings.slice(0,8),maps:document.querySelectorAll('.route-map').length,tracks:map.querySelectorAll('.rm-track').length};
   });
   const at=`${theme} ${width}`;
   expect(groups.maps,at).toBe(1);
   expect(groups.tracks,at).toBe(8);
   expect(groups.roads.length,at).toBe(3);
   expect(groups.ends.length,at).toBe(3);
   expect(groups.outside,at).toBe(0);
   expect(groups.crossings,`${at} boxes of elements holding text`).toEqual([]);
   expect(groups.ends.map(e=>e.spaces.length),at).toEqual([3,3,2]);
   const hit=(a,b)=>a.x+a.w-1>b.x&&b.x+b.w-1>a.x&&a.y+a.h-1>b.y&&b.y+b.h-1>a.y;
   for(let i=0;i<groups.roads.length;i++)for(let j=i+1;j<groups.roads.length;j++)expect(hit(groups.roads[i].box,groups.roads[j].box),`${at} roads ${i} ${j}`).toBe(false);
   for(const end of groups.ends){
    for(const space of end.spaces){
     expect(space.x,`${at} space inside end`).toBeGreaterThanOrEqual(end.box.x-1);
     expect(space.y,`${at} space inside end`).toBeGreaterThanOrEqual(end.box.y-1);
     expect(space.x+space.w,`${at} space inside end`).toBeLessThanOrEqual(end.box.x+end.box.w+1);
     expect(space.y+space.h,`${at} space inside end`).toBeLessThanOrEqual(end.box.y+end.box.h+1);
    }
    for(let i=0;i<end.spaces.length;i++)for(let j=i+1;j<end.spaces.length;j++)expect(hit(end.spaces[i],end.spaces[j]),`${at} spaces ${i} ${j}`).toBe(false);
   }
  }
 }
});

// ---- 視窗寬度改變 -------------------------------------------------------------------------------------------------------

test('[TC-ITIN-075] crossing 760 CSS px keeps the view, the day being edited, the expanded card, its Draft and the keyboard focus, and does not reload',async({page:p})=>{
 test.setTimeout(90000);
 await open(p,exampleTrip(),{width:1440,height:900});
 await p.evaluate(()=>{window.__marker='kept';});
 // 行程圖：寬度跨越 760 時不重新載入，Text_Panel 的展開狀態不變。
 await p.locator('[data-text-panel="toggle"]').click();
 await resize(p,700);await resize(p,800);
 await expect(p.locator('[data-text-panel="toggle"]')).toHaveAttribute('aria-expanded','true');
 expect(await p.evaluate(()=>window.__marker)).toBe('kept');
 // 規劃行程：第 2 天、展開的活動卡片、輸入到一半的 Draft 與焦點。
 await p.locator('.plan-view-switch [data-view="editor"]').click();
 await p.locator('[data-plan-nav="day"]').nth(1).click();
 await p.locator('[data-plan-nav="segment"][data-segment="activities"]').click();
 await p.locator('[data-plan-toggle="activity:new"]').click();
 const title=card(p).locator('[name="title"]');
 await expect(title).toBeFocused();
 await title.fill('跨過 760 的草稿');
 await card(p).locator('[name="location"]').focus();
 const before=await stored(p);
 const state=()=>p.evaluate(()=>({
  view:document.querySelector('.plan-view-switch [aria-pressed="true"]')?.dataset.view,
  day:[...document.querySelectorAll('[data-plan-nav="day"]')].findIndex(b=>b.getAttribute('aria-pressed')==='true'),
  segment:document.querySelector('.plan-segments [aria-pressed="true"]')?.dataset.segment,
  expanded:document.querySelector('[data-plan-toggle="activity:new"]')?.getAttribute('aria-expanded'),
  cards:document.querySelectorAll('form[data-plan-card]').length,
  title:document.querySelector('form[data-plan-card] [name="title"]')?.value,
  focus:document.activeElement?.getAttribute('name')??document.activeElement?.tagName,
  marker:window.__marker
 }));
 const first=await state();
 expect(first).toMatchObject({view:'editor',day:1,segment:'activities',expanded:'true',cards:1,title:'跨過 760 的草稿',focus:'location',marker:'kept'});
 for(const width of [761,760,320,1440,759,1024]){
  await resize(p,width);
  expect(await state(),`width ${width}`).toEqual(first);
  expect(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`width ${width} no sideways scroll`).toBe(true);
 }
 expect(await stored(p)).toEqual(before); // Draft 沒有被寫入或丟棄
 // 回到行程圖後再跨過 760：行程圖仍是同一個頁面。
 await p.locator('.plan-view-switch [data-view="poster"]').click();
 await expect(poster(p)).toBeVisible();
 await resize(p,700);await resize(p,900);
 expect(await p.evaluate(()=>window.__marker)).toBe('kept');
});

test('[TC-ITIN-076] the planner and the Text_Panel have no sideways scroll at 320, 390 and 1440 CSS px with long names, and the Text_Panel wraps long lines',async({page:p})=>{
 test.setTimeout(150000);
 await open(p,stress8x6());
 await p.locator('[data-text-panel="toggle"]').click();
 await expect(p.locator('#text-panel-body')).toBeVisible();
 for(const width of SIZES){
  await resize(p,width);
  expect(await textReport(p,'.itinerary-text-panel',''),`text panel ${width}`).toEqual([]);
  const wrapped=await p.evaluate(()=>{const pre=document.querySelector('#text-panel-body');return pre.scrollWidth<=pre.clientWidth+1&&getComputedStyle(pre).whiteSpace==='pre-wrap';});
  expect(wrapped,`text panel wrap ${width}`).toBe(true);
 }
 await p.locator('.plan-view-switch [data-view="editor"]').click();
 await expect(p.locator('.itinerary-editor')).toBeVisible();
 await p.locator('.plan-routes-list .plan-row-button').first().click();
 await expect(card(p)).toHaveCount(1);
 for(const theme of THEMES){
  await setTheme(p,theme);
  for(const width of SIZES){
   await resize(p,width);
   const problems=await textReport(p,'.itinerary-editor','');
   expect(problems,`editor ${theme} ${width}`).toEqual([]);
  }
 }
});
