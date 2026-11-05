import { activityForVehicle, activityForPerson, activityParticipantLabel, validActivityVehicles } from './vehicle-itinerary.js';
import { createExpensePanel } from './expenses-ui.js';
import { mapLink } from './maps.js';
import { parseVehicleMeeting, formatVehicleMeeting, vehicleDepartures } from './vehicle-departures.js';
import { dailyNote, setupDailyNote } from './daily-notes.js';
import { MEAL_SLOTS, mealSlotOptions, groupMealsByDate } from './meal-order.js';
import { RECIPE_TEMPLATES, COMMON_INGREDIENTS, DISH_TYPES, mergeIngredients, applyRecipeTemplate, inferDishKind } from './recipes.js';
import { dishIllustration } from './dish-art.js';
import { PERSONAL_GEAR_GROUPS, personalGearPreset } from './gear-presets.js';
import { SHOPPING_CATEGORIES, parseIngredients, classifyIngredient, syncMealIngredients } from './ingredients.js';
import { illustration, logo } from './art.js';
import { setupSceneMotion, syncSceneMotion, sceneMotionSettings } from './scene-motion.js';
import { STORAGE_KEY, THEMES_KEY, TABS, COLORS, seed, load, readStorage, save, uid, escape as e, dateRange, dateLabel, weekday, personName, myGear, readyCount, unassigned, togglePacking, assignGear, assignShopping, canDepart, progress, logEvent, isValidState, addParticipant } from './model.js';

const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const storage = { getItem: key => localStorage.getItem(key), setItem: (key,value) => localStorage.setItem(key,value) };
const account = globalThis.campingAccountContext || null;
const initial = account ? {state:account.state,status:'ok'} : readStorage(storage);
let accountSaving=false, accountError='', accountInviteUrl='', deferredFocus='';
let state = initial.state;
let storageLocked = ['invalid','unavailable'].includes(initial.status), pendingRemote = null;
let baseRevision = state.revision, originalBackup = initial.raw || '';
let dialogDirty = false;
let inviteDraft={name:'',role:''}, inviteError='';
let expensePanel = null;
let scheduleVehicle = '';
let tab = 'schedule', day = state.trip.startDate, shoppingFilter = 'all', gearFilter = 'all', hideDone = false;
let syncStartupError = '', migrated = false;
try { migrated = !account && syncMealIngredients(state).changed; if(migrated && initial.status==='ok')logEvent(state,'料理食材已自動連動採買清單'); } catch(err) { syncStartupError=err.message; }
let saved = !!account || !storageLocked && (initial.status === 'ok' && !migrated && !initial.migratedFromLegacy || save(storage,state)), toastTimer, returnFocus;
if(saved)baseRevision=state.revision;
let theme = 'light';
try { theme = localStorage.getItem(THEMES_KEY) === 'dark' ? 'dark' : 'light'; } catch {}
document.documentElement.dataset.theme = theme;
const types = {meet:'集合',market:'採買補給',camp:'營地時光',meal:'一起吃飯',night:'星空時間',travel:'在路上'};
const categories = SHOPPING_CATEGORIES;
const icons = {
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon:'<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"/>',
  pin:'<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
  people:'<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m1-15a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 5h2m4 0h2"/>',
  arrow:'<path d="M4 12h15m-6-6 6 6-6 6"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  book:'<path d="M12 6C8 3 4 4 2 5v15c3-1 7-1 10 1 3-2 7-2 10-1V5c-3-1-7-1-10 1Zm0 0v15"/>',
  tent:'<path d="m3 20 9-16 9 16H3Zm5 0 4-8 4 8M10 2l4 4m0-4-4 4"/>',
  bag:'<path d="M4 8h16l-1 13H5L4 8Zm4 0V6a4 4 0 0 1 8 0v2"/>',
  cup:'<path d="M4 8h12v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8Zm12 1h2a3 3 0 0 1 0 6h-2M7 3v2m5-2v2M2 22h18"/>',
  car:'<path d="m4 10 2-6h12l2 6M3 10h18v8H3v-8Zm2 8v3m14-3v3M6 14h2m8 0h2"/>',
  edit:'<path d="m14 5 5 5M4 20l5-1L21 7l-5-5L4 14v6Z"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  link:'<path d="m10 14 4-4m-6 6-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 10a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-2 2" transform="translate(1 0) scale(.9)"/>',
  leaf:'<path d="M20 3C8 1 1 8 5 16c8 6 17-2 15-13ZM3 21 15 9"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
  cloud:'<path d="M6 18a5 5 0 0 1-1-10 7 7 0 0 1 13-1 5.5 5.5 0 0 1 0 11H6Z"/>'
};
function icon(name, className='') { return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.tent}</svg>`; }
function avatar(p, small=false) { return `<span class="avatar ${COLORS.includes(p.color)?p.color:'coral'} ${small?'small':''}" aria-label="${e(p.name)}">${e([...String(p.name || '?').trim()][0] || '?')}</span>`; }
function personOptions(selected='', empty=true) { return `${empty?'<option value="" data-person-color="unassigned">待分配</option>':''}${state.people.map(p=>`<option value="${e(p.id)}" data-person-color="${personColor(p.id)}" ${p.id===selected?'selected':''}>${e(p.name)}</option>`).join('')}`; }
function dateOptions(selected=day) { return dateRange(state.trip.startDate,state.trip.endDate).map(d=>`<option value="${d}" ${d===selected?'selected':''}>${dateLabel(d)} ${weekday(d)}</option>`).join(''); }
function button(text, action, className='', extra='') { return `<button class="button ${className}" data-action="${action}" ${extra}>${text}</button>`; }
function route() { if(account)return location.pathname.endsWith('/go')?'go':'trip'; return location.hash.replace(/^#\/?/,'').split('?')[0] || 'trip'; }
function notify(message) { clearTimeout(toastTimer); document.querySelector('#toasts').textContent = message; document.querySelector('#toasts').classList.add('visible'); toastTimer=setTimeout(()=>document.querySelector('#toasts').classList.remove('visible'),4500); }
function commit(message, announce=true) { if(account){void commitAccount(message,announce);return;} const disk=readStorage(storage); if(disk.status==='ok' && disk.state.revision!==baseRevision){storageLocked=true;pendingRemote=disk.state;} logEvent(state,message); saved=!storageLocked && save(storage,state);if(saved)baseRevision=state.revision;render();if(announce||!saved)notify(saved?message+' · 已儲存在本機':'尚未儲存。請匯出備份，再處理儲存或分頁衝突。'); }
function render() {
  const active=document.activeElement?.dataset.focus || deferredFocus;
  deferredFocus=accountSaving?(active||''):'';
  const page=route();
  const pageTitle=page==='home'?'我的旅行':page==='privacy'?'資料與隱私':page==='invite'?'旅行邀請':page==='go'?`${state.trip.title} · 行前清單`:state.trip.title;
  document.title = `${pageTitle} · 日子拾光`;
  document.body.classList.toggle('departure-page',page==='go');
  app.innerHTML = `${header()}${!account&&!saved?'<div class="save-warning" role="alert">資料尚未儲存，或有另一分頁的變更。請先保留備份。<button class="text-button" data-action="export">匯出目前內容</button><button class="text-button" data-action="recover-storage">處理儲存問題</button></div>':''}${page==='invite'?invite():page==='home'?home():page==='privacy'?privacy():page==='go'?departure():trip()}${footer()}`;
  if(account)applyAccountChrome();
  const expenseMount=app.querySelector('#expenses-mount');
  if(expenseMount){expensePanel??=createExpensePanel({getState:()=>state,account,assertSession:()=>assertAccountSession(),onDirty:()=>{}});expenseMount.append(expensePanel.element);if(accountSessionChanged)expensePanel.lock('登入帳號已在其他分頁變更。請匯出分帳草稿，再重新登入原帳號。');}
  syncSceneMotion();
  if(active) [...document.querySelectorAll('[data-focus]')].find(el=>el.dataset.focus===active)?.focus({preventScroll:true});
}
function header() {
  if(account)return accountHeader();
  const user=state.people.find(p=>p.id===state.currentUser);
  return `<header class="topbar"><div class="topbar-inner"><a class="brand" href="#/home" aria-label="日子拾光首頁">${logo()}<span>日子拾光<small>LITTLE MOMENTS</small></span></a><div class="header-actions"><span class="demo-badge"><i></i> 本機示範</span><button class="icon-button theme-button" data-action="theme" aria-label="切換${theme==='light'?'深色':'淺色'}模式">${icon(theme==='light'?'moon':'sun')}</button><button class="profile-button" data-action="profile" aria-label="切換旅伴身分">${avatar(user,true)}<span>${e(user.name)}</span><span class="chevron">⌄</span></button></div></div></header>`;
}
function footer() { if(account)return `<footer class="footer"><span>日子拾光 · 帳號版</span><span>資料儲存在本機伺服器，尚未公開部署。</span></footer>`;return `<footer class="footer"><div class="footer-brand">${icon('tent')} <span>日子拾光<span class="footer-dot">·</span>把平凡的日子，留成喜歡的回憶。</span></div><div><span>獨立重製示範 · 虛構資料</span><a href="#/privacy">資料與隱私</a></div></footer>`; }
function hero(compact=false) {
  const trip=state.trip;
  const days=Math.ceil((Date.parse(trip.startDate+'T00:00:00+08:00')-Date.now())/86400000);
  return `<section class="hero ${compact?'hero-home':''}"><div class="hero-copy"><span class="eyebrow">LITTLE MOMENTS</span><h1>${compact?'下一個故事，<br>我們一起出發。':e(trip.title)}</h1><p>${compact?'把想去的地方、想煮的料理，和想一起出發的人，收進這本小小旅行手冊。':e(trip.description)}</p>${compact?`<a class="button primary" href="#/trip">翻開我的旅行 ${icon('arrow')}</a>`:`<div class="hero-tags"><span>${icon('calendar')}${dateLabel(trip.startDate)} — ${dateLabel(trip.endDate)}</span><span class="hero-destination">${icon('pin')}${mapLink(trip.destination)}</span><span>${icon('people')}${state.people.length} 位旅伴</span></div><div class="hero-note">${icon('leaf')} 旅行前一起規劃，出發後專心玩。</div>`}</div><div class="hero-art"><span class="postcard-sticker">Let's go camping!</span><div class="scene-motion illustration scene-motion--camp">${illustration('camp')}${!compact?`<div class="countdown"><small>${days>0?'距離出發':days===0?'今天出發':'旅行手冊'}</small><strong>${days>0?days:days===0?'GO':dateRange(trip.startDate,trip.endDate).length}</strong><span>${days>0?'天':days===0?'!':'天的好日子'}</span></div>`:''}</div></div></section>`;
}
function home() { return `<main id="main" class="page">${hero(true)}<div class="section-title home-title"><div><span class="eyebrow">OUR LITTLE ADVENTURES</span><h2>我的旅行手冊 <span class="count-bubble">1</span></h2></div><a href="#/invite" class="text-link">看看邀請頁 ${icon('arrow')}</a></div><a href="#/trip" class="trip-card"><div class="trip-card-art">${illustration('camp')}</div><div><span class="eyebrow">一起出發</span><h3>${e(state.trip.title)}</h3><p>${dateLabel(state.trip.startDate)} — ${dateLabel(state.trip.endDate)} · ${e(state.trip.destination)}</p><span class="text-link">翻開手冊 ${icon('arrow')}</span></div></a></main>`; }
function trip() {
  const count=unassigned(state).length;
  return `<main id="main" class="page"><nav class="breadcrumb" aria-label="麵包屑"><a href="#/home">我的旅行</a><span>/</span><span>${e(state.trip.title)}</span></nav>${hero()}<div class="trip-toolbar"><nav class="mode-switch" aria-label="旅行模式"><a href="#/trip" aria-current="page">${icon('book')} 規劃手冊</a><a href="#/go">${icon('tent')} 出發模式 ${icon('arrow')}</a></nav><div class="toolbar-actions">${button(icon('download')+'<span>匯出手冊</span>','export','quiet')}${button(icon('people')+'邀請旅伴','invite','blue')}</div></div><div class="sync-status"><i></i>${saved?'已儲存在這台裝置':'尚未儲存'}<span>·</span> ${navigator.onLine?'示範資料，不會同步至原網站':'目前離線，仍可在本機編輯'}</div><nav class="section-tabs" aria-label="旅行內容">${TABS.map(([key,label],i)=>`<button data-tab="${key}" data-focus="tab-${key}" ${tab===key?'aria-current="page"':''}><span class="tab-number">0${i+1}</span>${label}${key==='gear'&&count?`<span class="tab-badge" aria-label="${count} 項待分配">${count}</span>`:''}</button>`).join('')}</nav><div class="workspace"><section class="workspace-main" aria-label="${TABS.find(t=>t[0]===tab)?.[1] || ''}">${tab==='schedule'?schedule():tab==='meals'?meals():tab==='shopping'?shopping():tab==='gear'?gear():tab==='crew'?crew():tab==='expenses'?'<div id="expenses-mount"></div>':settings()}</section>${sidebar()}</div></main>`;
}
function sidebar() {
  const p=progress(state), u=unassigned(state).length, note=dailyNote();
  return `<aside class="sidebar"><section class="crew-panel"><span class="eyebrow">OUR TRAVEL CREW</span><h2>小隊準備好了嗎？</h2><div class="avatar-stack">${state.people.map(p=>avatar(p)).join('')}</div><p>${state.people.length} 位旅伴，一起收集回憶。</p><div class="progress-line"><span>食材採買</span><b>${p.shoppingDone} <span>/ ${p.shoppingTotal}</span></b></div><progress aria-label="食材採買進度" max="${Math.max(1,p.shoppingTotal)}" value="${p.shoppingDone}"></progress><div class="progress-line"><span>裝備準備</span><b>${p.gearDone} <span>/ ${p.gearTotal}</span></b></div><progress class="yellow-progress" aria-label="裝備準備進度" max="${Math.max(1,p.gearTotal)}" value="${p.gearDone}"></progress>${u?`<button class="unassigned-link" data-tab="gear">${icon('info')} ${u} 項裝備還在等主人 ${icon('arrow')}</button>`:''}<a href="#/go" class="button full">看看我的行前清單 ${icon('arrow')}</a></section><section class="paper-note daily-note" aria-label="每日快樂小語"><span class="tape"></span><span class="doodle-flower" aria-hidden="true">✳</span><span class="daily-note-label">每日一語 <time data-daily-date datetime="${note.date}">${note.date.slice(5).replace('-','/')}</time></span><p data-daily-quote>${e(note.text)}</p><span class="eyebrow">A LITTLE JOY, EVERY DAY</span></section><div class="side-footnote">${icon('leaf')} 把垃圾帶走，把風景留下。</div></aside>`;
}
function schedule() {
  const dates=dateRange(state.trip.startDate,state.trip.endDate);
  if(!dates.includes(day))day=dates[0];
  if(scheduleVehicle&&!state.vehicles.some(v=>v.id===scheduleVehicle))scheduleVehicle='';
  const activities=state.activities.filter(a=>a.date===day&&(!scheduleVehicle||activityForVehicle(state,a,scheduleVehicle))).sort((a,b)=>a.time.localeCompare(b.time));
  return `<div class="schedule-bar"><div class="date-tabs" aria-label="選擇行程日期">${dates.map((date,i)=>`<button class="${day===date?'selected':''} ${COLORS[i%3]}" data-day="${date}" data-focus="day-${date}" aria-pressed="${day===date}"><small>DAY ${String(i+1).padStart(2,'0')}</small><b>${dateLabel(date)}</b><span>${weekday(date)}</span></button>`).join('')}</div>${button(icon('plus')+'新增一站','activity','small')}</div>${vehicleDepartureSection()}${vehicleScheduleFilter()}<div class="schedule-intro"><span>${scheduleVehicle?e(state.vehicles.find(v=>v.id===scheduleVehicle).name)+' 的當日行程':'當日行程 · 慢慢走，好好玩。'}</span><span>${activities.length} 個小片刻</span></div><div class="timeline">${activities.length?activities.map((a,i)=>`<article class="activity-card ${a.done?'done':''}" data-activity-id="${e(a.id)}"><span class="timeline-stamp ${COLORS[i%3]}">${icon(a.type==='meet'?'people':a.type==='market'?'bag':a.type==='meal'?'cup':a.type==='night'?'moon':a.type==='travel'?'car':'tent')}</span><div class="activity-top"><time>${e(a.time)}</time><span class="tag ${COLORS[i%3]}">${types[a.type] || '活動'}</span><button class="icon-button activity-edit" data-action="activity" data-id="${e(a.id)}" aria-label="編輯 ${e(a.title)}">${icon('edit')}</button></div><h3>${e(a.title)}</h3><div class="activity-location">${icon('pin')}${mapLink(a.location)}</div><p>${e(a.note)}</p><div class="activity-bottom"><span>${icon(a.vehicleIds?'car':'people')}<span>${e(activityParticipantLabel(state,a))}</span></span><label class="mini-check"><input type="checkbox" data-activity-check="${e(a.id)}" data-focus="activity-${e(a.id)}" ${a.done?'checked':''} aria-label="${e(a.title)}已完成"><span>${a.done?'已完成':'完成'}</span></label></div></article>`).join(''):`<div class="empty">${icon('cloud')}<h3>這一天，留給新的故事。</h3><p>${scheduleVehicle?'這台車今天還沒有安排，新增一站即可指定參與車輛。':'新增第一站，一起開始規劃。'}</p></div>`}</div><div class="endnote"><span></span>${icon('leaf')} 好日子，不用急。<span></span></div>`;
}
function vehicleScheduleFilter() {
  if(!state.vehicles.length)return '';
  return `<div class="vehicle-schedule-filter"><label class="field"><span>按車查看行程</span><select id="schedule-vehicle" data-focus="schedule-vehicle" aria-label="按車查看行程"><option value="">全部行程</option>${state.vehicles.map(v=>`<option value="${e(v.id)}" ${v.id===scheduleVehicle?'selected':''}>${e(v.name)}</option>`).join('')}</select></label><p class="help">單車檢視會包含全體行程，以及原旅伴名單中有這台車成員的行程。不同車輛可各自安排抵達時間，不會自動合併。</p></div>`;
}
function activityParticipationFields(item) {
  const mode=item.vehicleIds?'vehicles':item.people?.length?'legacy':!item.id&&scheduleVehicle?'vehicles':'all';
  const selected=item.vehicleIds||(!item.id&&scheduleVehicle?[scheduleVehicle]:[]);
  return field('這一站誰參加',`<select name="participation" aria-label="這一站誰參加" aria-describedby="activity-participation-help"><option value="all" ${mode==='all'?'selected':''}>全體旅伴</option><option value="vehicles" ${mode==='vehicles'?'selected':''} ${!state.vehicles.length?'disabled':''}>指定車輛（可複選）</option>${item.people?.length?`<option value="legacy" ${mode==='legacy'?'selected':''}>保留原旅伴名單</option>`:''}</select>`,true)+`<p id="activity-participation-help" class="help wide">${item.people?.length?`原旅伴名單：${e(item.people.map(id=>personName(state,id)).join('、'))}。不更改此選項就會保留。`:''}${state.vehicles.length?'指定車輛只代表這些車參加；即使抵達營區，也不會自動改成全體。':'請先到「旅伴與車輛」新增車輛，才能分車安排。'}</p><fieldset class="wide activity-vehicle-choices" data-activity-vehicles ${mode==='vehicles'?'':'hidden disabled'}><legend>參與車輛（至少選一台）</legend>${state.vehicles.map(v=>`<label><input type="checkbox" name="vehicleIds" value="${e(v.id)}" ${selected.includes(v.id)?'checked':''}><span><strong>${e(v.name)}</strong><small>駕駛：${e(personName(state,v.driver))} · 乘客：${v.passengers.length?v.passengers.map(id=>e(personName(state,id))).join('、'):'尚未分配'}</small></span></label>`).join('')}</fieldset>`;
}
function updateActivityParticipation() {
  const form=dialog.querySelector('#edit-form[data-kind="activity"]');
  if(!form)return;
  const group=form.querySelector('[data-activity-vehicles]');
  group.hidden=group.disabled=form.elements.participation.value!=='vehicles';
}
function vehicleDepartureSection() {
  if(day!==state.trip.startDate)return '';
  const departures=vehicleDepartures(state,day).filter(({vehicle})=>!scheduleVehicle||vehicle.id===scheduleVehicle);
  return `<section class="vehicle-departures" aria-labelledby="vehicle-departures-title"><div class="vehicle-departures-heading"><div><span class="eyebrow">DIFFERENT STARTS, SHARED MEMORIES</span><h2 id="vehicle-departures-title">各車出發 <span>${departures.length} 台車</span></h2></div>${button(icon('plus')+'新增車輛','vehicle','small')}</div><p class="help">出發時間與地點會同步到「旅伴與車輛」。沿途採買、接人與抵達營區，請在下方新增一站，指定參與車輛。</p>${departures.length?`<div class="departure-vehicles">${departures.map(({vehicle:v,time,location})=>`<article class="departure-vehicle" data-vehicle-departure="${e(v.id)}"><div class="departure-vehicle-top"><div class="departure-vehicle-name" data-person-color="${personColor(v.driver)}">${icon('car')}<h3>${e(v.name)}</h3></div><button class="icon-button" data-action="vehicle" data-id="${e(v.id)}" aria-label="編輯 ${e(v.name)}出發安排">${icon('edit')}</button></div><div class="departure-vehicle-time">${time?`<time datetime="${e(day)}T${e(time)}">${e(time)}</time><span>出發</span>`:'<span class="help">出發時間待確認</span>'}</div><p class="departure-vehicle-place">${icon('pin')}<span>${mapLink(location,{fallback:'出發地點待確認'})}</span></p><dl><div><dt>駕駛</dt><dd>${e(personName(state,v.driver))}</dd></div><div><dt>乘客</dt><dd>${v.passengers.length?v.passengers.map(id=>e(personName(state,id))).join('、'):'尚未分配乘客'}</dd></div></dl><small class="departure-vehicle-count">${v.passengers.length+(v.driver?1:0)} / ${v.seats} 人</small></article>`).join('')}</div>`:'<div class="departure-vehicles-empty">新增車輛，各自填寫出發時間與地點，就能分開查看。</div>'}</section>`;
}
function sectionTitle(eyebrow,title,action='') { return `<div class="section-title"><div><span class="eyebrow">${eyebrow}</span><h2>${title}</h2></div>${action}</div>`; }
function mealCard(m) {
  const kind=inferDishKind(m), names=parseIngredients(m.ingredients);
  return `<article class="meal-card" data-meal-id="${e(m.id)}" data-meal-slot="${e(m.slot)}">
    <div class="meal-illustration">${dishIllustration(kind)}</div>
    <div class="meal-content">
      <div class="meal-heading"><div><span class="meal-slot">${e(m.slot)}</span><h4>${e(m.title)}</h4></div><button class="icon-button" data-action="meal" data-id="${e(m.id)}" aria-label="編輯 ${e(m.title)}">${icon('edit')}</button></div>
      <p class="meal-meta">${m.servings} 人份 <span aria-hidden="true">·</span> 主廚 ${e(personName(state,m.cookId))}</p>
      <p class="meal-ingredients"><span>食材</span> ${names.length?e(names.join('、')):'尚未填寫'}</p>
      <div class="meal-card-footer">${m.notes?`<details class="meal-notes"><summary>料理筆記</summary><p>${e(m.notes)}</p></details>`:''}<button class="text-button" data-tab="shopping">${icon('bag')}查看採買清單</button></div>
    </div>
  </article>`;
}
function meals() {
  const dates=dateRange(state.trip.startDate,state.trip.endDate), groups=groupMealsByDate(state.meals);
  return `${sectionTitle('LITTLE MEALS, LASTING MEMORIES','一起煮，一起吃',button(icon('plus')+'新增餐次','meal','small'))}<p class="section-description">依日期與餐次安排好每一餐，食材儲存後自動連動採買清單。</p>
    <div class="meal-days">${groups.map(({date,meals})=>`<section class="meal-date-group" data-meal-date="${e(date)}" aria-labelledby="meal-date-${e(date)}"><div class="meal-date-heading"><h3 id="meal-date-${e(date)}"><time datetime="${e(date)}">${dateLabel(date)} <span>${weekday(date)}</span></time></h3><span class="meal-day-count">DAY ${String(dates.indexOf(date)+1).padStart(2,'0')} <span aria-hidden="true">·</span> ${meals.length} 道料理</span></div><div class="meal-grid">${meals.map(mealCard).join('')}</div></section>`).join('') || '<div class="empty"><h3>這趟旅行，想吃點什麼？</h3><p>新增餐次，安排第一道料理。</p></div>'}</div>`;
}
const personColor = id => { const color=state.people.find(p=>p.id===id)?.color; return COLORS.includes(color)?color:'unassigned'; };
const colorChoices={coral:'珊瑚粉',blue:'天空藍',green:'草地綠',yellow:'暖陽黃',lavender:'薰衣草紫',peach:'蜜桃色'};
function assigneeSelect(item, kind) {
  const attribute = kind === 'shopping' ? 'shopping-assignee' : 'gear-assignee';
  const label = kind === 'shopping' ? '採買負責人' : '攜帶人';
  const options = `<option value="" data-person-color="unassigned" ${!item.assignee?'selected':''}>待分配</option>${state.people.map(p=>`<option value="${e(p.id)}" data-person-color="${personColor(p.id)}" ${p.id===item.assignee?'selected':''}>${e(p.name)}負責</option>`).join('')}`;
  return `<select class="assignee-select" data-person-select data-person-color="${personColor(item.assignee)}" data-${attribute}="${e(item.id)}" data-focus="${attribute}-${e(item.id)}" aria-label="${e(item.name)}${label}" title="${account&&!account.permissions.canEdit?'需要旅行編輯權限才能變更負責人':'選擇負責人後立即儲存'}" ${account&&!account.permissions.canEdit?'disabled':''}>${options}</select>`;
}
function shopping() {
  const p=progress(state);
  const rows=state.shopping.filter(item=>(shoppingFilter==='all'||item.assignee===state.currentUser)&&(!hideDone||!item.done));
  return `${sectionTitle('GATHER INGREDIENTS, MAKE MEMORIES','把好吃的買齊',button(icon('plus')+'新增品項','shopping','small'))}<p class="section-description">料理食材會自動分類到這裡；數量與負責人請再確認，分類也可以手動調整。</p><div class="shopping-expense-link"><span>買好後，拍張收據逐項記帳。</span><button type="button" class="text-button" data-tab="expenses">收據辨識與分帳 ${icon('arrow')}</button></div><div class="filter-toolbar"><div class="segmented"><button data-shop-filter="all" aria-pressed="${shoppingFilter==='all'}">全部 <span>${state.shopping.length}</span></button><button data-shop-filter="mine" aria-pressed="${shoppingFilter==='mine'}">我負責的</button></div><label class="hide-done"><input type="checkbox" id="hide-done" ${hideDone?'checked':''}>隱藏已買</label></div><div class="shopping-summary"><span>${p.shoppingDone} / ${p.shoppingTotal} 項已買齊</span><progress aria-label="採買完成度" max="${Math.max(1,p.shoppingTotal)}" value="${p.shoppingDone}"></progress></div><div class="shopping-list">${categories.filter(cat=>rows.some(s=>s.category===cat)).map(cat=>`<section class="shopping-category"><h3>${cat}<span>${rows.filter(s=>s.category===cat).length} 項</span></h3>${rows.filter(s=>s.category===cat).map(s=>`<div class="shopping-row ${s.done?'done':''}"><label><input type="checkbox" data-shopping-check="${e(s.id)}" data-focus="shopping-${e(s.id)}" ${s.done?'checked':''} aria-label="${e(s.name)}已買齊"><span><b>${e(s.name)}</b>${s.mealIds?.length?`<small class="recipe-source">料理：${s.mealIds.map(id=>e(state.meals.find(m=>m.id===id)?.title||'')).join('、')}</small>`:s.recipeRemoved?'<small class="recipe-source">料理已不需要，保留採買品項</small>':''}</span></label>${assigneeSelect(s,'shopping')}<span class="quantity">${e(s.quantity)}</span><button class="icon-button" data-action="shopping" data-id="${e(s.id)}" aria-label="編輯 ${e(s.name)}">${icon('edit')}</button></div>`).join('')}</section>`).join('') || `<div class="empty">${icon('check')}<h3>${hideDone?'眼前的清單，全部搞定！':'目前沒有品項'}</h3><p>切換篩選或新增採買品項。</p></div>`}</div>`;
}
function gear() {
  const missing=unassigned(state);
  const rows=state.gear.filter(g=>gearFilter==='all'||(gearFilter==='mine'?myGear(state).includes(g):!g.assignee&&g.scope==='shared'));
  return `${sectionTitle('PACK A LITTLE HAPPINESS','小隊裝備分工',button(icon('plus')+'新增裝備','gear','small'))}<p class="section-description">個人的自己帶，公用的一起分工。選擇攜帶人後會立即儲存。</p>${missing.length?`<div class="notice">${icon('info')}<span>還有 <b>${missing.length} 項</b>公用裝備待分配，出發前記得找個主人。</span></div>`:''}<div class="segmented gear-filters">${[['all','全部裝備'],['mine','我負責的'],['unassigned','待分配']].map(([key,label])=>`<button data-gear-filter="${key}" aria-pressed="${gearFilter===key}">${label}</button>`).join('')}</div>${['personal','shared'].map(scope=>{const items=rows.filter(g=>g.scope===scope);return items.length?`<section class="gear-group"><h3>${scope==='personal'?'每個人，都帶一份':'公用裝備，一起分工'}<span>${items.length} 項</span></h3><div class="gear-table">${items.map(g=>`<div class="gear-row"><div class="gear-item">${icon(scope==='personal'?'bag':'tent')}<span><strong>${e(g.name)}</strong><small>${e(g.quantity)}</small></span></div>${scope==='personal'?`<span class="tag green">每人一份</span>`:assigneeSelect(g,'gear')}<button class="icon-button" data-action="gear" data-id="${e(g.id)}" aria-label="編輯 ${e(g.name)}">${icon('edit')}</button></div>`).join('')}</div></section>`:''}).join('')||'<div class="empty"><h3>這裡已經都分配好了。</h3></div>'}<a href="#/go" class="button primary gear-go">打開我的行前清單 ${icon('arrow')}</a>`;
}
function crew() { return `${sectionTitle('BETTER TOGETHER','最好的風景，是一起的人',button(icon('plus')+'新增旅伴','person','small'))}<div class="identity-note">${icon('info')}你現在是 <b>${e(personName(state,state.currentUser))}</b>${button('切換身分','profile','text-button')}</div><div class="member-grid">${state.people.map(p=>`<article class="member-card">${avatar(p)}<div><h3>${e(p.name)}${p.id===state.currentUser?'<span class="tag yellow">我</span>':''}</h3><p>${e(p.role)}</p><small>行前準備 ${readyCount(state,p.id)} / ${myGear(state,p.id).length}</small>${account?.permissions.canEdit&&(account.permissions.canManage||p.id===account.permissions.personId)?button('編輯旅伴','person','text-button',`data-id="${e(p.id)}"`):''}</div></article>`).join('')}</div><div class="section-title spaced"><div><span class="eyebrow">ON THE ROAD</span><h2>我們怎麼去？</h2></div>${button(icon('plus')+'新增車輛','vehicle','small')}</div><div class="vehicles">${state.vehicles.map(v=>`<article class="vehicle-card"><div class="vehicle-title">${icon('car')}<h3>${e(v.name)}</h3><button class="icon-button" data-action="vehicle" data-id="${e(v.id)}" aria-label="編輯 ${e(v.name)}">${icon('edit')}</button></div><p>駕駛 ${e(personName(state,v.driver))} <span>·</span> ${v.passengers.length+(v.driver?1:0)} / ${v.seats} 人</p><p class="help">${icon('pin')}${mapLink(parseVehicleMeeting(v.meeting).location,{label:v.meeting,fallback:'出發地點待確認'})}</p><div class="passenger-list">${v.passengers.map(id=>`<span>${e(personName(state,id))}</span>`).join('')}</div></article>`).join('')}</div>`; }
function settings() { return `${sectionTitle('KEEP OUR STORY TOGETHER','旅行設定與紀錄',button(icon('edit')+'編輯旅行','trip-settings','small'))}<section class="settings-panel"><dl><dt>旅行名稱</dt><dd>${e(state.trip.title)}</dd><dt>旅行日期</dt><dd>${e(state.trip.startDate)} — ${e(state.trip.endDate)}</dd><dt>目的地</dt><dd>${mapLink(state.trip.destination)}</dd><dt>旅行小叮嚀</dt><dd>${e(state.trip.note)}</dd><dt>資料儲存</dt><dd>這台裝置的瀏覽器，不會傳送到原網站。</dd></dl></section>${sceneMotionSettings()}<section class="data-tools"><h3>把這本手冊帶走</h3><p>匯出 JSON 備份，也可以在另一台裝置匯入。匯入會取代目前資料。</p><div>${button(icon('download')+'匯出備份','export')}${button('匯入備份','import')}${button('列印目前頁面','print')}</div></section><section class="event-section"><h3>小隊最近的動態</h3><ul class="event-list">${state.events.slice(0,8).map(ev=>`<li><span><b>${e(ev.actor)}</b> ${e(ev.text)}</span><time>${new Date(ev.at).toLocaleString('zh-TW',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time></li>`).join('')}</ul></section><div class="reset-area"><span>想重新試玩？恢復最初的虛構旅行資料。</span>${button('重設示範資料','reset','danger')}</div>`; }
function departure() {
  const items=myGear(state), done=readyCount(state), missing=unassigned(state), departed=state.departed.includes(state.currentUser);
  const next=[...state.activities].sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time)).find(a=>!a.done&&activityForPerson(state,a,state.currentUser));
  return `<main id="main" class="page departure"><a class="back-link" href="#/trip">← 回到規劃手冊</a><div class="departure-heading"><span class="eyebrow">LESS PLANNING, MORE LIVING</span><h1>${departed?'準備好了，一起出發！':'出發前，把小幸福帶齊。'}</h1><p>${e(state.trip.title)} · ${e(personName(state,state.currentUser))}的行前清單</p></div><div class="departure-banner">${icon('tent')}<div><strong>${done} / ${items.length} 項準備完成</strong><progress max="${Math.max(1,items.length)}" value="${done}" aria-label="我的準備進度"></progress></div><span>${Math.round(done/Math.max(1,items.length)*100)}%</span></div>${missing.length?`<div class="notice">${icon('info')}<div><b>別落下全隊的裝備</b><p>${missing.map(g=>e(g.name)).join('、')}還沒有人負責。</p><button class="text-button" data-action="resolve-gear">回去分配 ${icon('arrow')}</button></div></div>`:''}<div class="packing-columns">${['personal','shared'].map(scope=>`<section><h2>${scope==='personal'?'自己的小行李':'我負責的公用裝備'}</h2><div class="packing-list">${items.filter(g=>g.scope===scope).map(g=>`<label class="packing-item ${g.ready.includes(state.currentUser)?'done':''}"><input type="checkbox" data-pack="${e(g.id)}" data-focus="pack-${e(g.id)}" ${g.ready.includes(state.currentUser)?'checked':''} aria-label="${e(g.name)}已裝好"><span>${e(g.name)}</span><small>${e(g.quantity)}</small></label>`).join('')||'<p class="help">目前沒有分配給你的公用裝備。</p>'}</div></section>`).join('')}</div><div class="departure-confirm">${button(departed?icon('check')+'已準備完成':`確認準備完成，出發 ${icon('arrow')}`,'depart','primary',(!canDepart(state)||departed)?'disabled':'')}<p>${missing.length?'先分配公用裝備，再完成自己的清單。':done<items.length?'不用急，帶齊了再出發。':'好日子，就從現在開始。'}</p></div><section class="next-stop"><span class="eyebrow">${departed?'YOUR NEXT LITTLE MOMENT':'FIRST STOP'}</span><h2>${next?e(next.title):'你目前沒有待完成的行程。'}</h2>${next?`<p>${dateLabel(next.date)} ${e(next.time)} · ${mapLink(next.location)}</p><p class="help">${e(activityParticipantLabel(state,next))}</p><p class="help">${e(next.note)}</p>${departed?button('完成這一站 '+icon('arrow'),'advance','',`data-id="${e(next.id)}"`):''}`:'<p>可回規劃手冊查看全隊行程，或確認自己搭乘的車輛。</p>'}</section><a class="button full" href="#/trip" data-nav-tab="shopping">${icon('bag')} 打開採買清單</a></main>`;
}
function invite() {
  return `<main id="main" class="page invite-page"><section class="invite-card"><div class="invite-art">${illustration('travel')}</div><div class="invite-content"><span class="eyebrow">SAVE YOU A SPOT</span><h1>空一個位子，等你來。</h1><h2>${e(state.trip.title)}</h2><p class="invite-date">${icon('calendar')}${e(state.trip.startDate)} — ${e(state.trip.endDate)}</p><p class="invite-intro">不用從名單找自己。留下你的名字，就能成為這趟旅行的新旅伴。</p><form id="invite-form">${field('你的名字或暱稱',input('name',inviteDraft.name,'text','id="invite-name" aria-label="你的名字或暱稱" data-focus="invite-name" autocomplete="nickname" required maxlength="30" placeholder="例如：小樹"'))}${field('小隊角色（選填）',input('role',inviteDraft.role,'text','id="invite-role" aria-label="小隊角色（選填）" data-focus="invite-role" maxlength="60" placeholder="例如：早餐擔當、開心跟班"'))}<p class="form-error" role="alert">${e(inviteError)}</p><button class="button primary full" id="join-button" type="submit" ${!inviteDraft.name.trim()?'disabled':''}>填好名字，加入旅行 ${icon('arrow')}</button></form><div class="invite-demo">${icon('info')}<span>本機流程示範：名字只會加入這個瀏覽器的手冊。此網址不能讓其他裝置加入同一趟旅行，也不會建立真實帳號。</span></div></div></section><a class="back-link" href="#/trip">先看看這本旅行手冊 →</a></main>`;
}
function privacy() { return `<main id="main" class="page privacy-page"><span class="eyebrow">A LITTLE NOTE ABOUT YOUR DATA</span><h1>資料留在這裡，安心去玩。</h1><section><h2>這是什麼？</h2><p>這是依「好好露營」視覺與工作流程獨立製作的本機示範。插畫重新繪製，所有旅伴、營地與旅行資料均為虛構，不代表原網站或其營運者。</p><h2>資料存在哪裡？</h2><p>旅行內容保存在這個瀏覽器的 localStorage。不使用 Google 登入、分析追蹤或遠端資料庫；所有資源都從本機載入。沒有跨裝置同步，也沒有真正的邀請授權。</p><h2>離線與備份</h2><p>正式建置版在首次成功載入後可離線使用。你可以從旅行設定匯出備份。清除瀏覽器網站資料會刪除本機手冊，匯入備份會取代目前的手冊。</p><h2>共用裝置</h2><p>這個示範沒有帳號隔離，在同一瀏覽器使用的人都可以看到這本手冊。請勿輸入真實個資或機密資料。</p><a class="button" href="#/trip">回到旅行手冊 ${icon('arrow')}</a></section></main>`; }
function field(label, input, wide=false) { return `<label class="field ${wide?'wide':''}"><span>${label}</span>${input}</label>`; }
function input(name,value='',type='text',extra='') { return `<input name="${name}" type="${type}" value="${e(value)}" ${extra}>`; }
function showDialog(title, content) { dialogDirty=false;returnFocus=document.activeElement; dialog.innerHTML=`<div class="dialog-heading"><h2 id="dialog-title">${title}</h2><button class="icon-button" data-action="close-dialog" aria-label="關閉視窗">${icon('close')}</button></div><div class="dialog-content">${content}</div>`; if(!dialog.open)dialog.showModal(); }
function closeDialog(force=false) { if(dialogDirty && force!==true && !window.confirm('尚有未儲存的修改。確定放棄？'))return;dialogDirty=false;dialog.close();returnFocus?.focus({preventScroll:true}); }
function formDialog(title,kind,fields,id='') { showDialog(title,`<form id="edit-form" data-kind="${kind}" data-id="${e(id)}"><div class="form-grid">${fields}</div><p class="form-error" role="alert"></p><div class="form-actions">${id&&(!account||account.permissions.canDelete===true)&&['activity','meal','shopping','gear','vehicle'].includes(kind)?button('移除項目','delete','text-button danger',`type="button" data-kind="${kind}" data-id="${e(id)}"`):''}<button type="button" class="button" data-action="close-dialog">取消</button><button class="button primary" type="submit">儲存${icon('check')}</button></div></form>`); }
function ingredientPreview(text) {
  const names=parseIngredients(text);
  return `<p class="help">${names.length} 項食材 · 分類預覽，儲存後才會更新採買清單。</p><div class="ingredient-tags">${names.map(name=>`<span>${e(name)}<b>${e(classifyIngredient(name))}</b></span>`).join('')}</div><p id="ingredient-help" class="help">可用頓號、/、逗號、句點或換行分隔；數字中的小數點會保留。數量請到採買清單填寫，無法辨識的歸「其他」；既有品項保留原分類。</p>`;
}
function mealDraft(){const form=document.querySelector('#edit-form');return form?.dataset.kind==='meal'?Object.fromEntries(new FormData(form)):null;}
function updateMealPreview(){
  const draft=mealDraft();if(!draft)return;
  const kind=inferDishKind(draft), preview=document.querySelector('#meal-image-preview');
  if(preview)preview.innerHTML=dishIllustration(kind);
  const chosen=new Set(parseIngredients(draft.ingredients));
  for(const button of dialog.querySelectorAll('[data-ingredient]')){const included=chosen.has(button.dataset.ingredient);button.disabled=included;button.setAttribute('aria-pressed',String(included));}
}
function updateTemplatePreview(){
  const recipe=RECIPE_TEMPLATES.find(r=>r.id===document.querySelector('#recipe-template')?.value), preview=document.querySelector('#template-preview');
  const apply=dialog.querySelector('[data-action="apply-recipe"]');if(apply)apply.disabled=!recipe;
  if(preview){preview.hidden=!recipe;preview.innerHTML=recipe?`<strong>${e(recipe.title)}</strong><p>${e(recipe.ingredients)}</p>`:'';}
}
function applySelectedRecipe(){
  const draft=mealDraft();if(!draft)return;
  const recipe=RECIPE_TEMPLATES.find(r=>r.id===document.querySelector('#recipe-template')?.value);if(!recipe)return;
  if((draft.title.trim()||draft.notes.trim()||(draft.imageKind!=='auto'&&draft.imageKind!==recipe.imageKind))&&!window.confirm('套用範本會更新料理名稱、筆記與圖片；原有食材會保留並合併。確定套用？'))return;
  const next=applyRecipeTemplate(draft,recipe.id), form=document.querySelector('#edit-form');
  if(next.ingredients.length>500){form.querySelector('.form-error').textContent='合併後食材超過 500 字，請先整理食材。';return;}
  for(const name of ['title','notes','ingredients','imageKind'])form.elements[name].value=next[name];
  dialogDirty=true;form.querySelector('.form-error').textContent='';document.querySelector('#ingredient-preview').innerHTML=ingredientPreview(next.ingredients);updateMealPreview();
}
function addQuickIngredient(name){
  const draft=mealDraft();if(!draft||!Object.values(COMMON_INGREDIENTS).some(items=>items.includes(name)))return;
  const value=mergeIngredients(draft.ingredients,name), form=document.querySelector('#edit-form');
  if(value.length>500){form.querySelector('.form-error').textContent='食材最多 500 字，請先整理清單。';return;}
  form.elements.ingredients.value=value;dialogDirty=true;document.querySelector('#ingredient-preview').innerHTML=ingredientPreview(value);updateMealPreview();
}
function gearPresetOptions() {
  return `<option value="">自行輸入裝備名稱</option>${PERSONAL_GEAR_GROUPS.map(group=>`<optgroup label="${e(group.label)}">${group.items.map(item=>`<option value="${e(item.name)}">${e(item.name)}</option>`).join('')}</optgroup>`).join('')}`;
}
function updateGearScope() {
  const form=dialog.querySelector('#edit-form[data-kind="gear"]');if(!form)return;
  const shared=form.elements.scope.value==='shared';
  form.querySelector('[data-gear-assignee-field]').hidden=!shared;
  form.elements.assignee.disabled=!shared;
}
function applyGearPreset() {
  const form=dialog.querySelector('#edit-form[data-kind="gear"]');
  const preset=personalGearPreset(form?.querySelector('#gear-preset')?.value);
  if(!form||!preset)return;
  form.elements.name.value=preset.name;
  form.elements.quantity.value=preset.quantity;
  form.querySelector('.form-error').textContent='';
  dialogDirty=true;

}
function editForm(kind,id) {
  const collection={activity:'activities',meal:'meals',shopping:'shopping',gear:'gear',vehicle:'vehicles'}[kind];
  const item=(collection?state[collection].find(i=>i.id===id):null)||{};
  if(kind==='activity')formDialog(id?'編輯這個小片刻':'新增一站','activity',field('活動名稱',input('title',item.title,'text','required maxlength="100"'),true)+field('日期',`<select name="date">${dateOptions(item.date)}</select>`)+field('時間',input('time',item.time||'12:00','time','required'))+field('活動類型',`<select name="type" aria-label="活動類型">${Object.entries(types).map(([k,v])=>`<option value="${k}" ${item.type===k?'selected':''}>${v}</option>`).join('')}</select>`)+field('地點',input('location',item.location,'text','maxlength="150"'))+field('備註',`<textarea name="note" rows="3" maxlength="1000">${e(item.note||'')}</textarea>`,true)+activityParticipationFields(item),id);
  if(kind==='meal'){
    const templates=`<section class="wide recipe-tools"><div class="recipe-tools-heading"><span class="eyebrow">A LITTLE HELP IN THE KITCHEN</span><h3>今晚想煮什麼？</h3><p>從常用料理開始，或直接往下填。食材會合併，不會清空你的清單。</p></div><div class="template-controls">${field('常用料理範本',`<select id="recipe-template" aria-label="常用料理範本"><option value="">選一道常用料理</option>${RECIPE_TEMPLATES.map(r=>`<option value="${r.id}">${e(r.title)}</option>`).join('')}</select>`)}<button type="button" class="button primary" data-action="apply-recipe" disabled>套用範本</button></div><div id="template-preview" hidden></div></section>`;
    const imageField=input('imageKind',item.imageKind||'auto','hidden');
    const shortcuts=`<details class="wide common-ingredients"><summary>常用食材，點一下加進來</summary><p class="help">已在清單裡的食材不會重複加入；移除請直接編輯食材欄。</p>${Object.entries(COMMON_INGREDIENTS).map(([category,names])=>`<fieldset><legend>${e(category)}</legend><div class="ingredient-shortcuts">${names.map(name=>`<button type="button" data-action="add-ingredient" data-ingredient="${e(name)}">${e(name)}</button>`).join('')}</div></fieldset>`).join('')}</details>`;
    formDialog(id?'編輯餐次':'新增一道好日子','meal',templates+field('料理名稱',input('title',item.title,'text','required maxlength="100" aria-label="料理名稱"'),true)+field('日期',`<select name="date" aria-label="日期">${dateOptions(item.date)}</select>`)+field('餐次',`<select name="slot" aria-label="餐次" required>${mealSlotOptions(item.slot).map(slot=>`<option value="${e(slot)}" ${slot===(item.slot||'晚餐')?'selected':''}>${e(slot)}${MEAL_SLOTS.includes(slot)?'':'（原餐次）'}</option>`).join('')}</select>`)+field('主廚',`<select name="cookId" aria-label="主廚">${personOptions(item.cookId)}</select>`)+field('人數',input('servings',item.servings||state.people.length,'number','required min="1" max="100"'))+imageField+`<div class="wide meal-image-preview" id="meal-image-preview"></div>`+field('食材（以頓號、/、逗號或句點分隔）',`<textarea name="ingredients" aria-label="食材（以頓號、/、逗號或句點分隔）" rows="3" maxlength="500" aria-describedby="ingredient-help" placeholder="牛肉片、高麗菜、雞蛋、壽喜燒醬">${e(item.ingredients||'')}</textarea>`,true)+shortcuts+`<div id="ingredient-preview" class="wide ingredient-preview" aria-live="polite">${ingredientPreview(item.ingredients||'')}</div>`+field('料理筆記',`<textarea name="notes" aria-label="料理筆記" rows="3" maxlength="1000">${e(item.notes||'')}</textarea>`,true),id);
    updateMealPreview();
  }
  if(kind==='shopping')formDialog(id?'編輯採買品項':'把好吃的加進清單','shopping',field('品項名稱',input('name',item.name,'text',`required aria-label="品項名稱" maxlength="100" ${item.mealIds?.length?'readonly aria-describedby="linked-name-help"':''}`)+(item.mealIds?.length?'<small id="linked-name-help" class="help">食材名稱與料理連動，請在料理菜單修改；數量、分類與負責人可在這裡調整。</small>':''),true)+field('數量與單位',input('quantity',item.quantity||'1 份','text','required maxlength="40"'))+field('分類',`<select name="category">${categories.map(c=>`<option ${(item.category||'其他')===c?'selected':''}>${c}</option>`).join('')}</select>`)+field('誰負責買',`<select name="assignee" class="assignee-select" data-person-select data-person-color="${personColor(item.assignee)}">${personOptions(item.assignee)}</select>`,true),id);
  if(kind==='gear'){
    const presetField=id?'':field('常用露營裝備（選填）',`<select id="gear-preset" aria-describedby="gear-preset-help">${gearPresetOptions()}</select>`,true)+`<p class="help wide gear-preset-help" id="gear-preset-help">選擇後只填入名稱與建議數量，個人清單請選「每人一份」，共同攜帶則選「公用裝備」；按「儲存」才會加入。</p>`;
    const assigneeField=`<label class="field wide" data-gear-assignee-field><span>公用裝備攜帶人</span><select name="assignee" class="assignee-select" data-person-select data-person-color="${personColor(item.assignee)}">${personOptions(item.assignee)}</select></label>`;
    formDialog(id?'編輯裝備':'帶上新的小幫手','gear',field('類型',`<select name="scope" class="gear-scope-select"><option value="personal" ${item.scope==='personal'?'selected':''}>每人一份</option><option value="shared" ${item.scope==='shared'||!id?'selected':''}>公用裝備</option></select>`,true)+presetField+field('裝備名稱',input('name',item.name,'text','required maxlength="100"'),true)+field('數量與單位',input('quantity',item.quantity||'1 個','text','required maxlength="40"'),true)+assigneeField,id);
    updateGearScope();
  }
  if(kind==='person'){const p=state.people.find(p=>p.id===id);formDialog(p?'編輯旅伴':'多一個人，多一份快樂','person',field('旅伴名字',input('name',p?.name||'','text','required maxlength="30"'),true)+field('小隊角色',input('role',p?.role||'','text','required maxlength="60" placeholder="例如：早餐擔當"'),true)+field('旅伴代表色',`<select name="color" aria-label="旅伴代表色">${COLORS.map(color=>`<option value="${color}" ${color===(p?.color||COLORS[state.people.length%COLORS.length])?'selected':''}>${colorChoices[color]}</option>`).join('')}</select>`,true),id);}
  if(kind==='vehicle'){const departure=parseVehicleMeeting(item.meeting);formDialog(id?'編輯這台車':'新增一台出發的車','vehicle',field('車輛暱稱',input('name',item.name,'text','required maxlength="50"'),true)+field('駕駛',`<select name="driver" aria-label="駕駛">${personOptions(item.driver??state.currentUser,!!account)}</select>`)+field('座位數（含駕駛）',input('seats',item.seats||4,'number','required min="1" max="9"'))+field('出發時間（選填）',input('departTime',departure.time,'time'))+field('出發地點',input('departLocation',departure.location,'text',`${id&&!departure.location?'':'required '}maxlength="150" placeholder="例如：台北車站東三門"`),true)+`<p class="help wide">顯示在 ${dateLabel(state.trip.startDate)} 首日行程的「各車出發」，也同步到旅伴與車輛。</p>`+`<fieldset class="wide"><legend>乘客（請勿重複選駕駛）</legend><div class="passenger-checks">${state.people.map(p=>`<label><input type="checkbox" name="passengers" value="${e(p.id)}" ${item.passengers?.includes(p.id)?'checked':''}>${e(p.name)}</label>`).join('')}</div></fieldset>`,id);}
  if(kind==='trip-settings')formDialog('把旅行，寫成你喜歡的樣子','trip-settings',field('旅行名稱',input('title',state.trip.title,'text','required maxlength="100"'),true)+field('目的地',input('destination',state.trip.destination,'text','required maxlength="100"'),true)+field('開始日期',input('startDate',state.trip.startDate,'date','required'))+field('結束日期',input('endDate',state.trip.endDate,'date','required'))+field('旅行介紹',`<textarea name="description" rows="2" maxlength="300">${e(state.trip.description)}</textarea>`,true)+field('旅行小叮嚀',`<textarea name="note" rows="2" maxlength="500">${e(state.trip.note)}</textarea>`,true));
}
function exportData() { const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='good-good-camping-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('旅行手冊已匯出'); }
function formLinkedError(){dialog.querySelector('.form-error').textContent='這項食材仍被料理使用。請先到料理菜單移除食材，再刪除採買品項。';}
const actions={
  'apply-recipe':applySelectedRecipe,
  'add-ingredient'(id,el){addQuickIngredient(el.dataset.ingredient);},
  theme(){ theme=theme==='light'?'dark':'light'; document.documentElement.dataset.theme=theme;try{localStorage.setItem(THEMES_KEY,theme);}catch{}render(); },
  profile(){ if(account){showDialog('你的登入帳號',`<p>${e(account.user.displayName)} · @${e(account.user.username)}</p><p>帳號身分由伺服器確認，不能切換成其他旅伴。</p><a class="button" href="/${e(account.user.username)}/home">回到我的首頁</a>`);return;}showDialog('今天，你是哪一位旅伴？',`<p class="dialog-note">只切換本機示範身分，不會登入真實帳號。</p><div class="identity-grid">${state.people.map(p=>`<button class="identity-option ${p.id===state.currentUser?'selected':''}" data-action="choose-person" data-id="${e(p.id)}">${avatar(p)}<span>${e(p.name)}</span>${p.id===state.currentUser?icon('check'):''}</button>`).join('')}</div>`); },
  'choose-person'(id){ state.currentUser=id;closeDialog(true);commit(`現在是${personName(state,id)}的視角`); },
  invite(){ if(account){void createAccountInvite();return;}showDialog('邀請旅伴，名字讓他自己填',`<div class="invite-mini">${illustration('travel')}</div><p>把邀請頁交給旅伴，由對方自行填寫名字，不必預先建立名單。</p><div class="notice">${icon('info')}<span>目前只在本機運作。這個網址不會把你的手冊同步到其他裝置，正式多人邀請需要後端服務。</span></div><div class="form-actions"><button class="button" data-action="copy-invite">${icon('link')}複製示範網址</button><a class="button primary" href="#/invite" data-action="close-dialog">預覽邀請頁 ${icon('arrow')}</a></div>`); },
  async 'copy-invite'(){if(account){try{await navigator.clipboard.writeText(accountInviteUrl);notify('已複製邀請網址');}catch{notify('請選取邀請網址後手動複製');}return;}const url=location.href.split('#')[0]+'#/invite';try{await navigator.clipboard.writeText(url);notify('已複製本機示範網址');}catch{showDialog('複製本機示範網址',field('請選取並複製',input('url',url,'text','readonly')));} },
  export:exportData,
  'recover-storage'(){showDialog('先保留資料，再繼續',`<p>為避免覆蓋損毀資料或另一分頁的更新，目前暫停儲存。請先匯出目前內容，再選擇下一步。</p><div class="form-actions">${button('匯出目前內容','export')}${originalBackup?button('下載原始資料','export-original'):''}${pendingRemote?button('載入另一分頁版本','apply-remote'):''}${button('以目前內容取代儲存','unlock-storage','primary')}</div>`);},
  'export-original'(){const url=URL.createObjectURL(new Blob([originalBackup],{type:'text/plain'}));const a=document.createElement('a');a.href=url;a.download='camping-original-recovery.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);},
  'apply-remote'(){if(!pendingRemote)return;state=pendingRemote;baseRevision=state.revision;pendingRemote=null;storageLocked=false;saved=true;closeDialog(true);render();},
  'unlock-storage'(){storageLocked=false;pendingRemote=null;state.revision=Math.max(state.revision,readStorage(storage).state.revision)+1;saved=save(storage,state);if(saved){baseRevision=state.revision;originalBackup='';}closeDialog(true);render();notify(saved?'已儲存目前內容':'仍無法儲存，請匯出備份。');},
  import(){showDialog('匯入旅行備份',`<form id="import-form"><p class="dialog-note">匯入會取代這台裝置的旅行手冊。請先匯出目前的資料。</p><label class="field">選擇 JSON 備份<input type="file" name="backup" accept=".json,application/json" required></label><p class="form-error" role="alert"></p><div class="form-actions"><button class="button" type="button" data-action="close-dialog">取消</button><button class="button primary">匯入並取代</button></div></form>`);},
  print(){window.print();},
  reset(){showDialog('重新開始這趟小旅行？',`<p>這會刪除目前的本機修改，恢復最初的示範資料。此操作無法復原。</p><div class="form-actions">${button('先不要','close-dialog')}${button('確定重設','confirm-reset','danger')}</div>`);},
  'confirm-reset'(){state=seed();syncMealIngredients(state);day=state.trip.startDate;tab='schedule';storageLocked=false;pendingRemote=null;saved=save(storage,state);baseRevision=state.revision;closeDialog(true);render();notify(saved?'已恢復示範資料':'重設只保留在記憶體，請檢查儲存空間。');},
  'close-dialog'(){closeDialog();},
  'resolve-gear'(){tab='gear';gearFilter='unassigned';if(account)location.href=accountTripPath();else location.hash='/trip';},
  depart(){if(account){void accountCheck('depart','',true);return;}if(!canDepart(state))return;state.departed.push(state.currentUser);commit('準備完成，一起出發');},
  advance(id){const item=state.activities.find(a=>a.id===id);if(item){item.done=true;commit(`完成了「${item.title}」`);}},
  delete(id,el){if(el.dataset.kind==='vehicle'&&state.activities.some(a=>a.vehicleIds?.includes(id))){dialog.querySelector('.form-error').textContent='這台車仍有指定行程。請先把那些行程改派其他車輛或改為全體，再移除車輛。';return;}if(el.dataset.kind==='shopping' && state.shopping.find(s=>s.id===id)?.mealIds?.length){formLinkedError();return;}if(dialogDirty&&!window.confirm('移除項目前，會放棄尚未儲存的修改。確定繼續？'))return;const kind=el.dataset.kind;showDialog('移除這個項目？',`<p>${account?'會從這趟旅行移除項目，其他旅伴也會看到變更。':'只會移除本機示範資料，無法復原。'}</p><div class="form-actions">${button('取消','close-dialog')}${button('確認移除','confirm-delete','danger',`data-id="${e(id)}" data-kind="${kind}"`)}</div>`);},
  'confirm-delete'(id,el){const collection={activity:'activities',meal:'meals',shopping:'shopping',gear:'gear',vehicle:'vehicles'}[el.dataset.kind];if(collection){if(collection==='vehicles'&&state.activities.some(a=>a.vehicleIds?.includes(id))){notify('這台車仍有指定行程，請先重新安排。');return;}const next={...state,[collection]:state[collection].filter(x=>x.id!==id)};try{if(collection==='meals'||collection==='shopping')syncMealIngredients(next);}catch(err){notify(err.message);return;}state=next;if(collection==='gear')state.departed=[];closeDialog();commit('已移除項目');}}
};
['activity','meal','shopping','gear','person','vehicle','trip-settings'].forEach(kind=>actions[kind]=id=>editForm(kind,id));

document.addEventListener('click',event=>{
  const el=event.target.closest('button,a');if(!el||expensePanel?.element.contains(el))return;
  const leavesTab=el.dataset.tab&&el.dataset.tab!=='expenses';
  const leavesPage=el.tagName==='A'&&el.getAttribute('href')&&!el.target&&el.getAttribute('href')!=='#';
  const resetsPage=['account-reload','account-logout'].includes(el.dataset.action);
  if((leavesTab||leavesPage||resetsPage)&&expensePanel?.isDirty()){
    if(!confirm('分帳還有未儲存的內容。建議先匯出草稿；若正在儲存，伺服器仍可能完成入帳。確定離開並放棄此頁草稿？')){event.preventDefault();event.stopImmediatePropagation();return;}
    expensePanel.discard();
  }
  if(leavesTab&&expensePanel){expensePanel.destroy();expensePanel=null;}
},true);

document.addEventListener('click',event=>{
  const el=event.target.closest('button,a');if(!el)return;
  if(account&&el.dataset.action&&!allowAccountAction(el.dataset.action)){event.preventDefault();return;}
  if(el.dataset.navTab)tab=el.dataset.navTab;
  if(el.dataset.action && actions[el.dataset.action]) actions[el.dataset.action](el.dataset.id,el);
  if(el.dataset.tab){tab=el.dataset.tab;render();}
  if(el.dataset.day){day=el.dataset.day;render();}
  if(el.dataset.shopFilter){shoppingFilter=el.dataset.shopFilter;render();}
  if(el.dataset.gearFilter){gearFilter=el.dataset.gearFilter;render();}
});
document.addEventListener('change',event=>{
  const el=event.target;
  if(el.matches('select[data-person-select]'))el.dataset.personColor=personColor(el.value);
  if(el.dataset.shoppingAssignee||el.dataset.gearAssignee)deferredFocus=el.dataset.focus;
  if(el.name==='imageKind' && el.closest('#edit-form')){dialogDirty=true;updateMealPreview();}
  if(el.id==='recipe-template')updateTemplatePreview();
  if(el.id==='gear-preset')applyGearPreset();
  if(el.id==='schedule-vehicle'){scheduleVehicle=el.value;render();}
  if(el.name==='participation'&&el.closest('#edit-form[data-kind="activity"]')){dialogDirty=true;updateActivityParticipation();}
  if(el.name==='scope'&&el.closest('#edit-form[data-kind="gear"]')){dialogDirty=true;updateGearScope();}
  if(el.id==='hide-done'){hideDone=el.checked;render();}
  if(el.dataset.shoppingCheck&&account){void accountCheck('shopping',el.dataset.shoppingCheck,el.checked);return;}
  if(el.dataset.pack&&account){void accountCheck('gear',el.dataset.pack,el.checked);return;}
  if(account&&(accountSaving||!saved||!account.permissions.canEdit)&& (el.dataset.activityCheck||el.dataset.gearAssignee||el.dataset.shoppingAssignee)){render();return;}
  if(el.dataset.shoppingCheck){const item=state.shopping.find(s=>s.id===el.dataset.shoppingCheck);if(!item)return;item.done=el.checked;commit(`${item.name}${item.done?'已買齊':'改為待買'}`,false);}
  if(el.dataset.activityCheck){const item=state.activities.find(a=>a.id===el.dataset.activityCheck);if(!item)return;item.done=el.checked;commit(`更新了「${item.title}」的進度`,false);}
  if(el.dataset.shoppingAssignee){if(assignShopping(state,el.dataset.shoppingAssignee,el.value))commit('採買分工已更新');else render();}
  if(el.dataset.gearAssignee){const item=state.gear.find(g=>g.id===el.dataset.gearAssignee);if(item&&item.assignee!==el.value&&assignGear(state,item.id,el.value))commit('裝備分工已更新');else render();}
  if(el.dataset.pack){togglePacking(state,el.dataset.pack);commit('行前清單已更新',false);}
});
document.addEventListener('submit',async event=>{
  const form=event.target;
  if(!['edit-form','invite-form','import-form'].includes(form.id))return;
  event.preventDefault();if(account&&(accountSaving||!saved||!account.permissions.canEdit||form.id!=='edit-form'))return;const data=new FormData(form);
  if(form.id==='invite-form'){
    if(route()!=='invite')return;
    try{const result=addParticipant(state,data.get('name'),data.get('role'));state={...result.state,currentUser:result.person.id,joined:true};inviteDraft={name:'',role:''};inviteError='';commit(`${result.person.name}加入了旅行`);location.hash='/trip';}
    catch(err){inviteError=err.message;form.querySelector('.form-error').textContent=inviteError;}
    return;
  }
  if(form.id==='import-form'){try{const file=data.get('backup');if(!file||file.size>2_000_000)throw new Error('請選擇小於 2 MB 的備份檔。');const imported=JSON.parse(await file.text());if(!isValidState(imported))throw new Error('這不是有效的旅行手冊備份。');syncMealIngredients(imported);state=imported;day=state.trip.startDate;storageLocked=false;pendingRemote=null;state.revision=Math.max(state.revision,readStorage(storage).state.revision)+1;saved=save(storage,state);baseRevision=state.revision;closeDialog(true);render();notify(saved?'旅行備份已匯入':'已載入，但無法永久儲存。');}catch(err){form.querySelector('.form-error').textContent=err.message;}return;}
  const kind=form.dataset.kind,id=form.dataset.id;
  const values=Object.fromEntries([...data.entries()].filter(([key])=>!['passengers','vehicleIds','participation'].includes(key)).map(([key,value])=>[key,typeof value==='string'?value.trim():value]));
  if([...form.querySelectorAll('[required]')].some(el=>!String(el.value).trim())){form.querySelector('.form-error').textContent='請填寫必要欄位，不能只有空白。';return;}
  if(kind==='trip-settings'){
    const dates=dateRange(values.startDate,values.endDate);
    if(!dates.length||Date.parse(values.endDate)-Date.parse(values.startDate)>30*86400000){form.querySelector('.form-error').textContent='結束日期需在開始日期之後，旅行最長 31 天。';return;}
    const oldDates=dateRange(state.trip.startDate,state.trip.endDate);
    for(const item of [...state.activities,...state.meals]){const offset=oldDates.indexOf(item.date);item.date=dates[Math.min(Math.max(offset,0),dates.length-1)];}
    state.trip={...state.trip,...values};day=state.trip.startDate;
  }else if(kind==='person'){
    try{if(account&&id){const old=state.people.find(p=>p.id===id);const probe={...state,people:state.people.filter(p=>p.id!==id)};const updated=addParticipant(probe,values.name,values.role).person;state={...state,people:state.people.map(p=>p.id===id?{...old,name:updated.name,role:updated.role,color:COLORS.includes(values.color)?values.color:old.color}:p)};}else {const added=addParticipant(state,values.name,values.role);state=added.state;if(COLORS.includes(values.color))state.people.find(p=>p.id===added.person.id).color=values.color;}}catch(err){form.querySelector('.form-error').textContent=err.message;return;}
  }else{
    const collection={activity:'activities',meal:'meals',shopping:'shopping',gear:'gear',vehicle:'vehicles'}[kind];
    const old=state[collection].find(x=>x.id===id);
    const defaults=kind==='activity'?{people:[],done:false}:kind==='shopping'?{done:false}:kind==='gear'?{ready:[]}:{};
    const item={...defaults,...old,...values,id:old?.id||uid()};
    if(kind==='activity'){
      const mode=data.get('participation');
      if(mode==='vehicles'){item.people=[];item.vehicleIds=data.getAll('vehicleIds');if(!validActivityVehicles(item,state.vehicles)){form.querySelector('.form-error').textContent='請至少選擇一台有效的參與車輛。';return;}}
      else if(mode==='all'){item.people=[];delete item.vehicleIds;}
      else if(mode!=='legacy'||!old?.people?.length){form.querySelector('.form-error').textContent='請選擇這一站的參與方式。';return;}
    }
    if(kind==='meal'){if(!mealSlotOptions(old?.slot).includes(values.slot)){form.querySelector('.form-error').textContent='請選擇有效的餐次。';return;}item.servings=Number(values.servings);item.ingredients=parseIngredients(values.ingredients).join('、');if(item.imageKind==='auto')delete item.imageKind;if(item.imageKind!==undefined&&!DISH_TYPES.some(([key])=>key===item.imageKind)){form.querySelector('.form-error').textContent='請選擇有效的料理圖片。';return;}}
    if(kind==='shopping'){
      if(old?.mealIds?.length && values.name!==old.name){form.querySelector('.form-error').textContent='連動食材名稱請在料理菜單修改。';return;}
      const names=parseIngredients(values.name).map(name=>name.replace(/\s+/gu,'').toLocaleLowerCase('zh-TW'));
      if(!old && state.shopping.some(s=>parseIngredients(s.name).some(name=>names.includes(name.replace(/\s+/gu,'').toLocaleLowerCase('zh-TW'))))){form.querySelector('.form-error').textContent='清單已有同名品項，請編輯既有品項的數量與分類。';return;}
      item.source='manual';
    }
    if(kind==='vehicle'){try{item.meeting=formatVehicleMeeting(values.departTime,values.departLocation,old?.meeting);}catch(err){form.querySelector('.form-error').textContent=err.message;return;}delete item.departTime;delete item.departLocation;item.seats=Number(values.seats);item.passengers=data.getAll('passengers').filter(p=>p!==item.driver);if(item.passengers.length+1>item.seats){form.querySelector('.form-error').textContent='乘客加上駕駛不能超過座位數。';return;}}
    if(kind==='gear'){if(item.scope==='personal')item.assignee='';if(old?.assignee!==item.assignee||old?.scope!==item.scope)item.ready=[];state.departed=[];}
    const next={...state,[collection]:old?state[collection].map(x=>x.id===id?item:x):[...state[collection],item]};
    if(kind==='meal'||kind==='shopping'){try{syncMealIngredients(next);}catch(err){form.querySelector('.form-error').textContent=err.message;return;}}
    state=next;
  }
  closeDialog(true);commit(kind==='meal'?'料理已儲存，食材已同步採買清單':'旅行手冊已更新');
});
document.addEventListener('input',event=>{
  const el=event.target;
  if(el.closest('#invite-form')){inviteDraft[el.name]=el.value;inviteError='';el.closest('form').querySelector('.form-error').textContent='';document.querySelector('#join-button').disabled=!inviteDraft.name.trim();}
  if(el.closest('#edit-form'))dialogDirty=true;
  if(el.name==='name'&&el.closest('#edit-form[data-kind="gear"]')){const picker=dialog.querySelector('#gear-preset');if(picker&&picker.value!==el.value)picker.value='';}
  if(el.closest('#edit-form')?.dataset.kind==='meal'&&!event.isComposing){if(el.name==='ingredients')document.querySelector('#ingredient-preview').innerHTML=ingredientPreview(el.value);updateMealPreview();}
});
document.addEventListener('compositionend',event=>{if(event.target.closest('#edit-form')?.dataset.kind==='meal'){if(event.target.name==='ingredients')document.querySelector('#ingredient-preview').innerHTML=ingredientPreview(event.target.value);updateMealPreview();}});
dialog.addEventListener('cancel',event=>{if(dialogDirty){event.preventDefault();closeDialog();}});
dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeDialog();}});
window.addEventListener('hashchange',()=>{if(dialog.open)closeDialog();render();window.scrollTo({top:0,behavior:'instant'});});
window.addEventListener('storage',event=>{if(account)return;if(event.key!==STORAGE_KEY||!event.newValue)return;let incoming;try{incoming=JSON.parse(event.newValue);}catch{return;}if(!isValidState(incoming)||incoming.revision===baseRevision)return;if(!saved||dialog.open||(route()==='invite'&&(inviteDraft.name||inviteDraft.role))){pendingRemote=incoming;storageLocked=true;saved=false;render();notify('另一分頁有更新。已保留你的修改，請先匯出備份。');return;}state=incoming;baseRevision=incoming.revision;render();notify('已載入另一個分頁的本機更新');});
window.addEventListener('beforeunload',event=>{if(expensePanel?.isDirty()||dialogDirty||!saved||(route()==='invite'&&(inviteDraft.name||inviteDraft.role))){event.preventDefault();event.returnValue='';}});
function accountTripPath(){return `/${account.user.username}/trips/${account.trip.id}`;}
function accountHeader(){return `<header class="topbar"><div class="topbar-inner"><a class="brand" href="/${e(account.user.username)}/home" aria-label="日子拾光首頁">${logo()}<span>日子拾光<small>LITTLE MOMENTS</small></span></a><div class="header-actions"><a class="text-link" href="/${e(account.user.username)}/home">我的首頁</a>${account.user.role==='admin'?'<a class="text-link" href="/admin">管理後台</a>':''}<button class="icon-button" data-action="theme" aria-label="切換${theme==='light'?'深色':'淺色'}模式">${icon(theme==='light'?'moon':'sun')}</button><button class="profile-button" data-action="profile">${e(account.user.displayName)}</button><button class="text-button" data-action="account-logout">登出</button></div></div></header>`;}
function allowAccountAction(action){
  if(['delete','confirm-delete'].includes(action)&&account.permissions.canDelete!==true){notify('只有旅行建立者與管理員可以刪除內容。');return false;}
  if(action==='invite'&&account.permissions.canInvite!==true){notify('只有旅行建立者與管理員可以發出邀請。');return false;}
  const blocked=['choose-person','import','reset','confirm-reset','unlock-storage','recover-storage','apply-remote','export-original'];
  if(blocked.includes(action)){notify('帳號版不提供這個示範操作。');return false;}
  const safe=['theme','profile','export','print','close-dialog','resolve-gear','account-reload','account-retry','account-logout'];
  if(safe.includes(action))return !accountSaving||action==='export';
  if(action==='depart')return !!account.permissions.personId&&saved&&!accountSaving;
  if(accountSaving||!saved){notify('請先完成儲存或處理尚未儲存的內容。');return false;}
  if(!account.permissions.canEdit){notify('你目前沒有這趟旅行的編輯權限。');return false;}
  return true;
}
function applyAccountChrome(){
  for(const link of app.querySelectorAll('a[href^="#/"]')){
    const dest=link.getAttribute('href').slice(2);
    link.href=dest==='home'?`/${account.user.username}/home`:dest==='go'?accountTripPath()+'/go':accountTripPath();
  }
  const sync=app.querySelector('.sync-status');
  if(sync)sync.innerHTML=`<i></i>${accountSaving?'正在儲存…':saved?'已儲存至本機伺服器':'尚未儲存'}<span>·</span>${account.permissions.canDelete?'建立者／管理員模式':account.permissions.canEdit?'協作編輯模式，不能刪除':'僅可檢視模式'}${navigator.onLine?'':' · 離線時無法儲存'}`;
  if(!account.permissions.canEdit)for(const el of app.querySelectorAll('[data-action]'))if(!['theme','profile','export','print','close-dialog','resolve-gear','depart','account-logout'].includes(el.dataset.action))el.hidden=true;
  if(account.permissions.canInvite!==true)for(const el of app.querySelectorAll('[data-action=invite]'))el.hidden=true;
  for(const selector of ['.reset-area','.data-tools [data-action="import"]','.identity-note [data-action="profile"]'])for(const el of app.querySelectorAll(selector))el.remove();
  const note=app.querySelector('.identity-note');if(note)note.innerHTML=`${icon('info')}登入帳號：<b>${e(account.user.displayName)}</b> · ${account.permissions.personId?'已綁定旅伴':'管理員檢視，未加入此旅行'}`;
  const info=app.querySelector('.settings-panel dl');if(info){const dt=[...info.querySelectorAll('dt')].find(el=>el.textContent==='資料儲存');if(dt)dt.nextElementSibling.textContent='本機伺服器 SQLite 資料庫，由登入帳號與旅行權限控管。';}
  const dataCopy=app.querySelector('.data-tools>p');if(dataCopy)dataCopy.textContent='匯出這趟旅行的行程 JSON 備份，不包含獨立分帳帳本。帳目請到「分帳記帳」另行匯出；帳號版不會以匯入檔直接覆蓋共用旅行。';
  for(const el of app.querySelectorAll('[data-shopping-check]')){const row=state.shopping.find(s=>s.id===el.dataset.shoppingCheck);el.disabled=accountSaving||!saved||(!account.permissions.canEdit&&row?.assignee!==account.permissions.personId);}
  for(const el of app.querySelectorAll('[data-pack]'))el.disabled=accountSaving||!saved||!account.permissions.personId;
  for(const el of app.querySelectorAll('[data-activity-check],[data-gear-assignee],[data-shopping-assignee]'))el.disabled=accountSaving||!saved||!account.permissions.canEdit;
  for(const el of app.querySelectorAll('[data-action]'))if(accountSaving&&!['export','theme','profile'].includes(el.dataset.action))el.disabled=true;
  if(route()==='go'&&!account.permissions.personId){app.querySelector('main').innerHTML=`<div class="empty"><h1>你目前以管理員身分檢視</h1><p>尚未加入此旅行，因此沒有個人行前清單。你仍可編輯所有旅行內容。</p><a class="button primary" href="${accountTripPath()}">回到規劃手冊</a></div>`;}
  if(accountError||!saved){const warning=document.createElement('div');warning.className='save-warning';warning.setAttribute('role','alert');warning.innerHTML=`<span>${e(accountError||'內容尚未儲存，請保留備份。')}</span>${!saved?button('匯出未存內容','export')+button('重試儲存','account-retry'):''}${button('重新載入伺服器版本','account-reload')}`;app.querySelector('header').after(warning);}
}
function acceptAccountResult(result){state=result.state;account.state=result.state;account.trip=result.trip;account.permissions=result.permissions;baseRevision=state.revision;saved=true;accountError='';}
async function commitAccount(message,announce=true){
  if(accountSaving)return;
  if(!account.permissions.canEdit){notify('你目前沒有這趟旅行的編輯權限。');return;}
  if(!isValidState(state)){saved=false;accountError='內容驗證未通過，尚未寫入伺服器。請匯出備份後重新載入。';render();return;}
  accountSaving=true;saved=false;accountError='';render();
  try{await assertAccountSession();const result=await account.api(`/api/trips/${account.trip.id}`,{method:'PUT',body:{revision:account.trip.revision,expectedUserId:account.user.id,state}});acceptAccountResult(result);if(announce)notify(message+' · 已儲存至本機伺服器');}
  catch(err){accountError=err.status===409?'其他人已更新這趟旅行。你的修改仍留在畫面，請先匯出，再重新載入合併。':err.status===401?'登入已失效。你的未儲存修改還在本頁，請先匯出備份，再重新登入。':`${err.message}，你的修改尚未儲存。`;}
  finally{accountSaving=false;render();}
}
async function accountCheck(kind,id,checked){
  if(accountSaving||!saved){render();return;}
  accountSaving=true;accountError='';render();
  try{await assertAccountSession();acceptAccountResult(await account.api(`/api/trips/${account.trip.id}/check`,{method:'POST',body:{revision:account.trip.revision,expectedUserId:account.user.id,kind,id,checked}}));notify('分工狀態已儲存');}
  catch(err){if(accountSessionChanged||err.status===0||err.status===401)saved=false;accountError=err.status===409?'旅行已有更新，請重新載入後再勾選。':err.status===401?'登入已失效，請重新登入；這次勾選未儲存。':`${err.message}，這次勾選未儲存。`;}
  finally{accountSaving=false;render();}
}
async function createAccountInvite(){
  if(account.permissions.canInvite!==true){notify('只有旅行建立者與管理員可以發出邀請。');return;}
  try{await assertAccountSession();const result=await account.api(`/api/trips/${account.trip.id}/invites`,{method:'POST',body:{expectedUserId:account.user.id}});accountInviteUrl=location.origin+result.urlPath;showDialog('邀請旅伴，名字讓他自己填',`<p>對方先註冊或登入帳號，再自行填寫這趟旅行使用的名字。邀請有效期限：${e(new Date(result.expiresAt).toLocaleString('zh-TW'))}。</p><p class="notice">目前伺服器只開在這台電腦。要讓朋友從其他裝置使用，還需要公開部署與 HTTPS。</p>${field('邀請網址',input('invite-url',accountInviteUrl,'text','readonly'))}<div class="form-actions">${button('複製邀請網址','copy-invite')}<a class="button primary" href="${e(result.urlPath)}">開啟邀請頁</a></div>`);}
  catch(err){notify(err.message);}
}
actions['account-retry']=()=>{void commitAccount('旅行手冊已更新');};
actions['account-reload']=()=>{if((!saved||dialogDirty)&&!confirm('重新載入會放棄尚未儲存的修改。請確認已匯出備份，是否繼續？'))return;saved=true;dialogDirty=false;location.reload();};
actions['account-logout']=async()=>{if((!saved||dialogDirty)&&!confirm('登出會放棄尚未儲存的修改，確定繼續？'))return;try{await account.api('/api/logout',{method:'POST',body:{}});saved=true;dialogDirty=false;location.href='/login';}catch(err){notify(err.message);}};
window.addEventListener('pageshow',event=>{if(account&&event.persisted)location.reload();});
let sessionChecking=false,sessionLastChecked=0,accountSessionChanged=false;
async function assertAccountSession(){
 if(accountSessionChanged){saved=false;throw new Error('登入帳號已在其他分頁變更。這份草稿不能由另一個帳號儲存，請先匯出備份，再重新登入原帳號。');}
 const current=await account.api('/api/session');
 if(current.user?.id!==account.user.id||current.user?.role!==account.user.role){accountSessionChanged=true;saved=false;throw new Error('登入帳號已在其他分頁變更。這份草稿不能由另一個帳號儲存，請先匯出備份，再重新登入原帳號。');}
}
async function recheckAccountSession(){
 if(!account||sessionChecking||Date.now()-sessionLastChecked<1000)return;
 sessionChecking=true;sessionLastChecked=Date.now();
 try{const result=await account.api('/api/session');if(result.user?.id!==account.user.id||result.user?.role!==account.user.role){accountSessionChanged=true;if(expensePanel?.isDirty()||dialogDirty||!saved){expensePanel?.lock('登入帳號已變更，分帳草稿不能由另一個帳號儲存。請匯出草稿，再重新登入。');saved=false;accountError='登入帳號已在其他分頁變更。這份未儲存草稿仍在此頁，請先匯出備份再重新整理。';render();}else location.reload();}}
 catch(err){if(err.status===0||err.status===401){accountError='無法確認帳號是否仍登入。為保護資料，請確認本機伺服器，必要時匯出備份再重新整理。';saved=false;render();}}
 finally{sessionChecking=false;}
}
window.addEventListener('focus',()=>{void recheckAccountSession();});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void recheckAccountSession();});

window.addEventListener('online',render);window.addEventListener('offline',render);
setupSceneMotion();
render();
setupDailyNote();
if(syncStartupError)notify(syncStartupError);
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
