import { activityForPerson, activityParticipantLabel } from './vehicle-itinerary.js';
import { createExpensePanel } from './expenses-ui.js';
import { mapLink } from './maps.js';

import { dailyNote, setupDailyNote } from './daily-notes.js';
import { MEAL_SLOTS, mealSlotOptions, groupMealsByDate } from './meal-order.js';
import { RECIPE_TEMPLATES, COMMON_INGREDIENTS, mergeIngredients, applyRecipeTemplate, inferDishKind } from './recipes.js';
import { dishIllustration } from './dish-art.js';
import { PERSONAL_GEAR_GROUPS, personalGearPreset } from './gear-presets.js';
import { SHOPPING_CATEGORIES, parseIngredients, classifyIngredient, syncMealIngredients, removeIngredientFromMeals } from './ingredients.js';
import { illustration, logo } from './art.js';
import { setupSceneMotion, syncSceneMotion, sceneMotionSettings } from './scene-motion.js';
import { tripMenuEntries } from './trip-menu.js';
import { toStudio, fromStudio } from './storybook-adapter.js';
import { mountStudio } from './storybook-studio.js';
import { firstDayDeparture, shoppingPlan, vehicleRouteDays } from './itinerary-derive.js';
import { EDIT_MESSAGES, saveMeal, saveVehicle } from './itinerary-edits.js';
import { destinationConflict } from './itinerary-model.js';
import { retimeByDayIndex, shortenBlockedMessage } from './itinerary-dates.js';
import { STORAGE_KEY, THEMES_KEY, TABS, COLORS, emptyState, readStorage, save, uid, escape as e, dateRange, dateLabel, weekday, personName, myGear, readyCount, unassigned, togglePacking, assignGear, assignShopping, canDepart, progress, logEvent, isValidState, addParticipant, resolveTab } from './model.js';

const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const storage = { getItem: key => localStorage.getItem(key), setItem: (key,value) => localStorage.setItem(key,value) };
const account = globalThis.campingAccountContext || null;
const initial = account ? {state:account.state,status:'ok'} : readStorage(storage);
let accountSaving=false, accountError='', accountInviteUrl='', deferredFocus='';
const INVITE_ACTIONS=['invite','create-invite','revoke-invite'], INVITE_DENIED='只有這趟旅行的成員或管理員可以發出邀請。';
let accountInviteId='', accountInviteExpiresAt='', accountInvites=[], accountInviteError='', accountInviteOpen=false, accountInviteBusy=false;
let state = initial.state;
let storageLocked = ['invalid','unavailable'].includes(initial.status), pendingRemote = null;
let baseRevision = state.revision, originalBackup = initial.raw || '';
let dialogDirty = false;
let inviteDraft={name:'',role:''}, inviteError='';
let expensePanel = null;
let presenceField = null; const presenceClientId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/[^A-Za-z0-9_-]/g, '');
let studioHost = null, studioMount = null, studioFailed = false, studioRetryAllowed = false, studioBaseRevision = null, studioBasePlan = null;
const studioDirty = () => Boolean(studioMount?.isDirty());
function dropStudio() { studioMount?.destroy(); studioMount = null; studioHost = null; studioFailed = false; studioRetryAllowed=false; studioBaseRevision=null; studioBasePlan=null; }
async function saveStoryPlan(plan) {
  if (accountSaving || account && !account.permissions.canEdit) return {ok:false,message:'目前無法儲存這趟旅行。'};
  if (account && (accountSessionChanged || !saved && !studioRetryAllowed)) return {ok:false,message:accountError || '原有修改尚未儲存。請先處理衝突或匯出備份。'};
  if (!account && (storageLocked || !saved)) return {ok:false,message:'本機資料尚未安全儲存，或另一分頁有更新。請先匯出備份並處理衝突。'};
  const before = state;
  // fromStudio performs field-level three-way merge against studioBasePlan; a revision-only change does not discard unrelated updates.
  try {
    const next = fromStudio(before,plan,{canDelete:!account||account.permissions.canDelete===true,basePlan:studioBasePlan});
    if (!isValidState(next)) throw new Error('行程資料未通過網站驗證，未儲存。');
    if (JSON.stringify(next) === JSON.stringify(before)) {
      if(account){await assertAccountSession();const latest=await account.api(`/api/trips/${account.trip.id}`);if(latest.trip.revision!==account.trip.revision)return {ok:false,message:'旅行已有更新，請匯出繪本草稿後重新載入。'};}
      else {const disk=readStorage(storage);if(disk.status!=='ok'||disk.state.revision!==baseRevision)return {ok:false,message:'本機資料已在另一分頁變更，請先備份。'};}
      return {ok:true,plan:toStudio(before)};
    }
    if (!account) {
      const disk = readStorage(storage);
      if (disk.status === 'ok' && disk.state.revision !== baseRevision) {storageLocked=true;pendingRemote=disk.state;saved=false;return {ok:false,message:'另一分頁已修改這趟旅行，請先匯出備份。'};}
      if (disk.status !== 'ok') return {ok:false,message:'無法確認本機儲存狀態，請先備份。'};
    }
    if (account) {
      // Keep the canonical candidate local until the existing revision/session-checked API responds; the studio keeps its own draft.
      accountSaving=true; saved=false; accountError=''; render();
      try {
        await assertAccountSession();
        const result=await account.api(`/api/trips/${account.trip.id}`,{method:'PUT',body:{revision:account.trip.revision,expectedUserId:account.user.id,state:next}});
        acceptAccountResult(result); studioFailed=false; studioRetryAllowed=false; studioBaseRevision=state.revision; studioBasePlan=toStudio(state); return {ok:true,plan:studioBasePlan};
      } catch(error) {
        state=before; saved=!(error.status===0 || error.status===401 || error.status===409 || error.status>=500 || accountSessionChanged); studioFailed=true;studioRetryAllowed=(error.status===0 || error.status>=500) && !accountSessionChanged;
        accountError=error.status===409?'其他人已更新這趟旅行。你的繪本草稿仍保留，請先匯出備份再重新載入合併。':error.status===401?'登入已失效。繪本草稿未儲存，請先匯出備份。':`${error.message}，繪本草稿尚未儲存。`;
        return {ok:false,message:accountError};
      } finally {accountSaving=false;render();}
    }
    state=next;
    const ok=commit('行程繪本已更新',false);
    studioFailed=!ok;
    if (!ok) {state=before;render();return {ok:false,message:'儲存失敗，編輯草稿仍在畫面。請匯出 JSON 備份。'};}
    studioBaseRevision=state.revision;studioBasePlan=toStudio(state);
    return {ok:true,plan:studioBasePlan};
  } catch (error) {state=before;studioFailed=true;return {ok:false,message:error?.message||'儲存失敗，草稿仍在畫面。'};}
}
function mountStoryAfterRender() {
  const marker = app.querySelector('#story-studio-mount');
  if (!marker) return;
  if (!studioHost) {studioHost=document.createElement('div');studioHost.className='story-studio-host';}
  marker.replaceWith(studioHost);
  try {
    if (!studioMount) {const plan=toStudio(state);studioBaseRevision=state.revision;studioBasePlan=plan;studioMount=mountStudio(studioHost,{plan,onSave:saveStoryPlan,canEdit:!account||account.permissions.canEdit===true,canDelete:!account||account.permissions.canDelete===true,getPeople:()=>state.people.map(p=>p.name).filter(Boolean),onFocusField:f=>{presenceField=f;},onDirty:()=>{}});}
    else if (!studioDirty() && studioBaseRevision!==state.revision) {if(typeof studioMount.refresh!=='function') throw new Error('studio refresh missing');const latestPlan=toStudio(state);if(studioMount.refresh(latestPlan)){studioBasePlan=latestPlan;studioBaseRevision=state.revision;}}
  } catch(error) {dropStudio();const warning=document.createElement('p');warning.setAttribute('role','alert');warning.className='save-warning';warning.textContent='行程繪本無法顯示：'+(error?.message||'未知錯誤')+'。原始旅行資料未修改。';app.querySelector('.workspace-main,.story-schedule-page')?.append(warning);}
}
let tripMenuOpen = false;
let tab = 'schedule', day = state.trip.startDate, shoppingFilter = 'all', gearFilter = 'all', hideDone = false;
let syncStartupError = '', migrated = false;
try { migrated = !account && syncMealIngredients(state).changed; if(migrated && initial.status==='ok')logEvent(state,'料理食材已自動連動採買清單'); } catch(err) { syncStartupError=err.message; }
let saved = !!account || !storageLocked && (initial.status === 'ok' && !migrated && !initial.migratedFromLegacy || save(storage,state)), toastTimer, returnFocus;
if(saved)baseRevision=state.revision;
let theme = 'light';
try { theme = localStorage.getItem(THEMES_KEY) === 'dark' ? 'dark' : 'light'; } catch {}
document.documentElement.dataset.theme = theme;
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
  cloud:'<path d="M6 18a5 5 0 0 1-1-10 7 7 0 0 1 13-1 5.5 5.5 0 0 1 0 11H6Z"/>',
  menu:'<path d="M4 7h16M4 12h16M4 17h16"/>',
  wallet:'<path d="M3 7a2 2 0 0 1 2-2h13v4"/><path d="M3 7v11a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2Z"/><circle cx="16.5" cy="14" r="1"/>',
  up:'<path d="M12 19V5m-6 6 6-6 6 6"/>',
  down:'<path d="M12 5v14m-6-6 6 6 6-6"/>',
  copy:'<rect x="8" y="8" width="13" height="13" rx="2.5"/><path d="M16 8V5.5A2.5 2.5 0 0 0 13.5 3h-8A2.5 2.5 0 0 0 3 5.5v8A2.5 2.5 0 0 0 5.5 16H8"/>',
  route:'<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5"/>',
  stop:'<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><path d="m9.5 10 1.8 1.8 3.2-3.6"/>',
  warning:'<path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 10v4m0 3v.01"/>'
};
function icon(name, className='') { return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.tent}</svg>`; }
function avatar(p, small=false) { return `<span class="avatar ${COLORS.includes(p.color)?p.color:'coral'} ${small?'small':''}" aria-label="${e(p.name)}">${e([...String(p.name || '?').trim()][0] || '?')}</span>`; }
function personOptions(selected='', empty=true) { return `${empty?'<option value="" data-person-color="unassigned">待分配</option>':''}${state.people.map(p=>`<option value="${e(p.id)}" data-person-color="${personColor(p.id)}" ${p.id===selected?'selected':''}>${e(p.name)}</option>`).join('')}`; }
function dateOptions(selected=day) { return dateRange(state.trip.startDate,state.trip.endDate).map(d=>`<option value="${d}" ${d===selected?'selected':''}>${dateLabel(d)} ${weekday(d)}</option>`).join(''); }
function button(text, action, className='', extra='') { return `<button class="button ${className}" data-action="${action}" ${extra}>${text}</button>`; }
function route() { if(account)return location.pathname.endsWith('/go')?'go':'trip'; return location.hash.replace(/^#\/?/,'').split('?')[0] || 'trip'; }
function notify(message) { clearTimeout(toastTimer); document.querySelector('#toasts').textContent = message; document.querySelector('#toasts').classList.add('visible'); toastTimer=setTimeout(()=>document.querySelector('#toasts').classList.remove('visible'),4500); }
// Returns `saved` in Local_Planner and the commitAccount() promise (true on success) in Account_Mode; callers may ignore it.
function commit(message, announce=true) { if(account)return commitAccount(message,announce); const disk=readStorage(storage); if(disk.status==='ok' && disk.state.revision!==baseRevision){storageLocked=true;pendingRemote=disk.state;} logEvent(state,message); saved=!storageLocked && save(storage,state);if(saved){baseRevision=state.revision;}render();if(announce||!saved)notify(saved?message+' · 已儲存在本機':'尚未儲存。請匯出備份，再處理儲存或分頁衝突。'); return saved; }
function render() {
  const active=document.activeElement?.dataset.focus||deferredFocus;
  deferredFocus=accountSaving?(active||''):'';
  const page=route();
  const pageTitle=page==='home'?'我的旅行':page==='privacy'?'資料與隱私':page==='invite'?'旅行邀請':page==='go'?`${state.trip.title} · 行前清單`:state.trip.title;
  document.title = `${pageTitle} · 日子拾光`;
  document.body.classList.toggle('departure-page',page==='go');
  if (studioHost?.isConnected) studioHost.remove();
  app.innerHTML = `${header()}${!account&&!saved?'<div class="save-warning" role="alert">資料尚未儲存，或有另一分頁的變更。請先保留備份。<button class="text-button" data-action="export">匯出目前內容</button><button class="text-button" data-action="recover-storage">處理儲存問題</button></div>':''}${page==='invite'?invite():page==='home'?home():page==='privacy'?privacy():page==='go'?departure():trip()}${footer()}`;
  if(page==='trip'&&resolveTab(tab)==='schedule')document.body.dataset.printScope='itinerary';else delete document.body.dataset.printScope;
  if(account)applyAccountChrome();
  if(page==='trip'&&tab==='schedule') {mountStoryAfterRender();studioMount?.resume?.();} else if(studioMount){studioMount.suspend?.();if(!studioDirty())dropStudio();}
  const expenseMount=app.querySelector('#expenses-mount');
  if(expenseMount){expensePanel??=createExpensePanel({getState:()=>state,account,assertSession:()=>assertAccountSession(),onDirty:()=>{}});expenseMount.append(expensePanel.element);if(accountSessionChanged)expensePanel.lock('登入帳號已在其他分頁變更。請匯出分帳草稿，再重新登入原帳號。');}
  syncSceneMotion();
  if(active){const target=active.startsWith(':css:')?document.querySelector(active.slice(5)):[...document.querySelectorAll('[data-focus]')].find(el=>el.dataset.focus===active);target?.focus({preventScroll:true});if(target&&active.startsWith('meal-edit-'))target.scrollIntoView({block:'center'});}
  const activeTab=app.querySelector('.section-tabs [aria-current="page"]');
  if(activeTab&&matchMedia('(max-width:760px)').matches){
    const tabs=activeTab.parentElement,tabRect=activeTab.getBoundingClientRect(),tabsRect=tabs.getBoundingClientRect();
    if(tabRect.left<tabsRect.left||tabRect.right>tabsRect.right)tabs.scrollLeft+=tabRect.left<tabsRect.left?tabRect.left-tabsRect.left:tabRect.right-tabsRect.right;
  }
  const activeDay=app.querySelector('.date-tabs button[aria-pressed="true"]');
  if(activeDay){
    const days=activeDay.parentElement,dayRect=activeDay.getBoundingClientRect(),daysRect=days.getBoundingClientRect();
    if(dayRect.left<daysRect.left||dayRect.right>daysRect.right)days.scrollLeft+=dayRect.left<daysRect.left?dayRect.left-daysRect.left:dayRect.right-daysRect.right;
  }
}
function header() {
  if(account)return accountHeader();
  const user=state.people.find(p=>p.id===state.currentUser);
  return `<header class="topbar"><div class="topbar-inner"><a class="brand" href="#/home" aria-label="日子拾光首頁">${logo()}<span>日子拾光<small>LITTLE MOMENTS</small></span></a><div class="header-actions"><span class="demo-badge"><i></i> 本機模式</span><button class="icon-button theme-button" data-action="theme" aria-label="切換${theme==='light'?'深色':'淺色'}模式">${icon(theme==='light'?'moon':'sun')}</button><button class="profile-button" data-action="profile" aria-label="切換旅伴身分">${avatar(user,true)}<span>${e(user.name)}</span><span class="chevron">⌄</span></button></div></div></header>`;
}
function footer() { if(account)return `<footer class="footer"><span>日子拾光 · 帳號版</span><span>資料儲存在本機伺服器，尚未公開部署。</span></footer>`;return `<footer class="footer"><div class="footer-brand">${icon('tent')} <span>日子拾光<span class="footer-dot">·</span>把平凡的日子，留成喜歡的回憶。</span></div><div><span>本機版 · 資料只儲存在此瀏覽器</span><a href="#/privacy">資料與隱私</a></div></footer>`; }
function hero(compact=false) {
  const trip=state.trip;
  const days=Math.ceil((Date.parse(trip.startDate+'T00:00:00+08:00')-Date.now())/86400000);
  return `<section class="hero ${compact?'hero-home':''}"><div class="hero-copy"><span class="eyebrow">LITTLE MOMENTS</span>${compact?'<h1>下一個故事，<br>我們一起出發。</h1>':`<div class="trip-title-row"><h1 id="trip-title">${e(trip.title)}</h1><button type="button" class="icon-button trip-menu-button" data-action="trip-menu" data-focus="trip-menu-button" aria-label="旅行選單" aria-haspopup="dialog" aria-expanded="${tripMenuOpen}"${tripMenuOpen?' aria-controls="trip-menu"':''}>${icon('menu')}</button></div>`}<p>${compact?'把想去的地方、想煮的料理，和想一起出發的人，收進這本小小旅行手冊。':e(trip.description)}</p>${compact?`<a class="button primary" href="#/trip">翻開我的旅行 ${icon('arrow')}</a>`:`<div class="hero-tags"><span>${icon('calendar')}${dateLabel(trip.startDate)} — ${dateLabel(trip.endDate)}</span><span class="hero-destination">${icon('pin')}${mapLink(trip.destination)}</span><span>${icon('people')}${state.people.length} 位旅伴</span></div><div class="hero-note">${icon('leaf')} 旅行前一起規劃，出發後專心玩。</div>`}</div><div class="hero-art"><span class="postcard-sticker">Let's go camping!</span><div class="scene-motion illustration scene-motion--camp">${illustration('camp')}${!compact?`<div class="countdown"><small>${days>0?'距離出發':days===0?'今天出發':'旅行手冊'}</small><strong>${days>0?days:days===0?'GO':dateRange(trip.startDate,trip.endDate).length}</strong><span>${days>0?'天':days===0?'!':'天的好日子'}</span></div>`:''}</div></div></section>`;
}
function home() { return `<main id="main" class="page">${hero(true)}<div class="section-title home-title"><div><span class="eyebrow">OUR LITTLE ADVENTURES</span><h2>我的旅行手冊 <span class="count-bubble">1</span></h2></div><a href="#/invite" class="text-link">看看邀請頁 ${icon('arrow')}</a></div><a href="#/trip" class="trip-card"><div class="trip-card-art">${illustration('camp')}</div><div><span class="eyebrow">一起出發</span><h3>${e(state.trip.title)}</h3><p>${dateLabel(state.trip.startDate)} — ${dateLabel(state.trip.endDate)} · ${e(state.trip.destination)}</p><span class="text-link">翻開手冊 ${icon('arrow')}</span></div></a></main>`; }
const TAB_ICONS={schedule:'calendar',meals:'cup',shopping:'bag',gear:'tent',expenses:'wallet'};
function trip() {
  tab = resolveTab(tab);
  const count=unassigned(state).length;
  return `<main id="main" class="page ${tab==="schedule"?"story-schedule-page":""}"><nav class="breadcrumb" aria-label="麵包屑"><a href="#/home">我的旅行</a><span>/</span><span>${e(state.trip.title)}</span></nav>${hero()}<div class="trip-toolbar"><nav class="mode-switch" aria-label="旅行模式"><a href="#/trip" aria-current="page">${icon('book')} 規劃手冊</a><a href="#/go">${icon('tent')} 出發模式 ${icon('arrow')}</a></nav><div class="toolbar-actions">${button(icon('download')+'<span>匯出手冊</span>','export','quiet','aria-label="匯出手冊" title="匯出手冊"')}${button(icon('people')+'<span>邀請旅伴</span>','invite','blue','aria-label="邀請旅伴" title="邀請旅伴"')}</div></div><div class="sync-status"><i></i>${saved?'已儲存在這台裝置':'尚未儲存'}<span>·</span> ${navigator.onLine?'本機資料，不會同步至其他裝置':'目前離線，仍可在本機編輯'}</div><nav class="section-tabs" aria-label="旅行內容">${TABS.map(([key,label],i)=>`<button data-tab="${key}" data-focus="tab-${key}" ${tab===key?'aria-current="page"':''}><span class="tab-icon">${icon(TAB_ICONS[key]||'tent')}</span><span class="tab-number">0${i+1}</span><span class="tab-label">${label}</span>${key==='gear'&&count?`<span class="tab-badge" aria-label="${count} 項待分配">${count}</span>`:''}</button>`).join('')}</nav>${tab==='schedule'?scheduleTab():`<div class="workspace"><section class="workspace-main" aria-label="${TABS.find(t=>t[0]===tab)?.[1] || ''}">${tab==='meals'?meals():tab==='shopping'?shopping():tab==='gear'?gear():tab==='expenses'?'<div id="expenses-mount"></div>':scheduleTab()}</section>${sidebar()}</div>`}${tripMenuOpen?tripMenu():''}</main>`;
}
function sidebar() {
  const p=progress(state), u=unassigned(state).length, note=dailyNote();
  return `<aside class="sidebar"><section class="crew-panel"><span class="eyebrow">OUR TRAVEL CREW</span><h2>小隊準備好了嗎？</h2><div class="avatar-stack">${state.people.map(p=>avatar(p)).join('')}</div><p>${state.people.length} 位旅伴，一起收集回憶。</p><div class="progress-line"><span>食材採買</span><b>${p.shoppingDone} <span>/ ${p.shoppingTotal}</span></b></div><progress aria-label="食材採買進度" max="${Math.max(1,p.shoppingTotal)}" value="${p.shoppingDone}"></progress><div class="progress-line"><span>裝備準備</span><b>${p.gearDone} <span>/ ${p.gearTotal}</span></b></div><progress class="yellow-progress" aria-label="裝備準備進度" max="${Math.max(1,p.gearTotal)}" value="${p.gearDone}"></progress>${u?`<button class="unassigned-link" data-tab="gear">${icon('info')} ${u} 項裝備還在等主人 ${icon('arrow')}</button>`:''}<a href="#/go" class="button full">看看我的行前清單 ${icon('arrow')}</a></section><section class="paper-note daily-note" aria-label="每日快樂小語"><span class="tape"></span><span class="doodle-flower" aria-hidden="true">✳</span><span class="daily-note-label">每日一語 <time data-daily-date datetime="${note.date}">${note.date.slice(5).replace('-','/')}</time></span><p data-daily-quote>${e(note.text)}</p><span class="eyebrow">A LITTLE JOY, EVERY DAY</span></section><div class="side-footnote">${icon('leaf')} 把垃圾帶走，把風景留下。</div></aside>`;
}
function scheduleTab() {
  return `<div class="workspace story-schedule-layout"><div id="story-studio-mount" role="region" aria-label="旅行繪本工作室"></div>${sidebar()}</div>`;
}
function sectionTitle(eyebrow,title,action='') { return `<div class="section-title"><div><span class="eyebrow">${eyebrow}</span><h2>${title}</h2></div>${action}</div>`; }
function mealCard(m) {
  const kind=inferDishKind(m), names=parseIngredients(m.ingredients);
  return `<article class="meal-card" data-swipe-row data-meal-id="${e(m.id)}" data-meal-slot="${e(m.slot)}">
    <div class="meal-illustration">${dishIllustration(kind)}</div>
    <div class="meal-content">
      <div class="meal-heading"><div><span class="meal-slot">${e(m.slot)}</span><h4>${e(m.title)}</h4></div><div class="meal-actions"><button class="icon-button" data-action="meal" data-id="${e(m.id)}" data-focus="meal-edit-${e(m.id)}" aria-label="編輯 ${e(m.title)}">${icon('edit')}</button>${!account||account.permissions.canDelete===true?`<button class="icon-button meal-remove-button" data-action="delete" data-kind="meal" data-id="${e(m.id)}" aria-label="移除 ${e(m.title)}">${icon('close')}</button>`:''}</div></div>
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
  const where=shoppingPlan(state).locationOf;
  const whereText=id=>{const w=where.get(id);return w?`<small class="shopping-where">第 ${w.n} 天在${e(w.placeName)}（${e(w.vehicleName)}）</small>`:'';};
  const rows=state.shopping.filter(item=>(shoppingFilter==='all'||item.assignee===state.currentUser)&&(!hideDone||!item.done));
  return `${sectionTitle('GATHER INGREDIENTS, MAKE MEMORIES','把好吃的買齊',button(icon('plus')+'新增品項','shopping','small'))}<p class="section-description">料理食材會自動分類到這裡；點選數量可直接修改，負責人與分類也能手動調整。</p><div class="shopping-expense-link"><span>買好後，拍張收據逐項記帳。</span><button type="button" class="text-button" data-tab="expenses">收據辨識與分帳 ${icon('arrow')}</button></div><div class="filter-toolbar"><div class="segmented"><button data-shop-filter="all" aria-pressed="${shoppingFilter==='all'}">全部 <span>${state.shopping.length}</span></button><button data-shop-filter="mine" aria-pressed="${shoppingFilter==='mine'}">我負責的</button></div><label class="hide-done"><input type="checkbox" id="hide-done" ${hideDone?'checked':''}>隱藏已買</label></div><div class="shopping-summary"><span>${p.shoppingDone} / ${p.shoppingTotal} 項已買齊</span><progress aria-label="採買完成度" max="${Math.max(1,p.shoppingTotal)}" value="${p.shoppingDone}"></progress></div><div class="shopping-list">${categories.filter(cat=>rows.some(s=>s.category===cat)).map(cat=>`<section class="shopping-category"><h3>${cat}<span>${rows.filter(s=>s.category===cat).length} 項</span></h3>${rows.filter(s=>s.category===cat).map(s=>`<div class="shopping-row ${s.done?'done':''}" data-swipe-row><label><input type="checkbox" data-shopping-check="${e(s.id)}" data-focus="shopping-${e(s.id)}" ${s.done?'checked':''} aria-label="${e(s.name)}已買齊"><span><b>${e(s.name)}</b>${s.mealIds?.length?`<small class="recipe-source">料理：${s.mealIds.map(id=>e(state.meals.find(m=>m.id===id)?.title||'')).join('、')}</small>`:s.recipeRemoved?'<small class="recipe-source">料理已不需要，保留採買品項</small>':''}${whereText(s.id)}</span></label>${assigneeSelect(s,'shopping')}${account&&!account.permissions.canEdit?`<span class="quantity">${e(s.quantity)}</span>`:`<button type="button" class="quantity quantity-editable" data-action="edit-shopping-quantity" data-id="${e(s.id)}" data-focus="shopping-quantity-${e(s.id)}" aria-label="編輯 ${e(s.name)}數量" title="點選直接編輯數量">${e(s.quantity)}</button>`}<div class="shopping-row-actions"><button type="button" class="icon-button" data-action="shopping" data-id="${e(s.id)}" aria-label="編輯 ${e(s.name)}">${icon('edit')}</button>${!account||account.permissions.canDelete?`<button type="button" class="icon-button meal-remove-button" data-action="delete" data-kind="shopping" data-id="${e(s.id)}" aria-label="移除 ${e(s.name)}">${icon('close')}</button>`:''}</div></div>`).join('')}</section>`).join('') || `<div class="empty">${icon('check')}<h3>${hideDone?'眼前的清單，全部搞定！':'目前沒有品項'}</h3><p>切換篩選或新增採買品項。</p></div>`}</div>`;
}
function gear() {
  const missing=unassigned(state);
  const rows=state.gear.filter(g=>gearFilter==='all'||(gearFilter==='mine'?myGear(state).includes(g):!g.assignee&&g.scope==='shared'));
  const groups=['personal','shared'].map(scope=>{
    const items=rows.filter(g=>g.scope===scope);
    if(!items.length)return '';
    return `<section class="gear-group"><h3>${scope==='personal'?'每個人，都帶一份':'公用裝備，一起分工'}<span>${items.length} 項</span></h3><div class="gear-table">${items.map(g=>`<div class="gear-row" data-swipe-row><div class="gear-item">${icon(scope==='personal'?'bag':'tent')}<span><strong>${e(g.name)}</strong><small>${e(g.quantity)}</small></span></div>${scope==='personal'?`<span class="tag green">每人一份</span>`:assigneeSelect(g,'gear')}<div class="gear-row-actions"><button class="icon-button" data-action="gear" data-id="${e(g.id)}" aria-label="編輯 ${e(g.name)}">${icon('edit')}</button>${!account||account.permissions.canDelete?`<button class="icon-button danger" data-action="delete" data-kind="gear" data-id="${e(g.id)}" aria-label="移除 ${e(g.name)}">${icon('close')}</button>`:''}</div></div>`).join('')}</div></section>`;
  }).join('');
  return `${sectionTitle('PACK A LITTLE HAPPINESS','小隊裝備分工',button(icon('plus')+'新增裝備','gear','small'))}<p class="section-description">個人的自己帶，公用的一起分工。選擇攜帶人後會立即儲存。</p>${missing.length?`<div class="notice">${icon('info')}<span>還有 <b>${missing.length} 項</b>公用裝備待分配，出發前記得找個主人。</span></div>`:''}<div class="segmented gear-filters">${[['all','全部裝備'],['mine','我負責的'],['unassigned','待分配']].map(([key,label])=>`<button data-gear-filter="${key}" aria-pressed="${gearFilter===key}">${label}</button>`).join('')}</div>${groups||'<div class="empty"><h3>這裡已經都分配好了。</h3></div>'}<a href="#/go" class="button primary gear-go">打開我的行前清單 ${icon('arrow')}</a>`;
}
// Markup moved out of the removed crew and settings tabs, kept for the Trip_Menu drawer.
// Class names (identity-note, member-card, vehicle-card, settings-panel, data-tools, event-section, reset-area) are what account mode and the tests look up.
function identityNote(menu) { return `<div class="identity-note">${icon('info')}你現在是 <b>${e(personName(state,state.currentUser))}</b>${button('切換身分',menu.switchIdentity.action,'text-button')}</div>`; }
// Permission rules come from tripMenuEntries() so they live in one place.
function memberCards(menu) { return menu.people.map(entry=>{const p=state.people.find(x=>x.id===entry.id);return `<article class="member-card">${avatar(p)}<div><h3>${e(p.name)}${entry.isMe?'<span class="tag yellow">我</span>':''}</h3><p>${e(p.role)}</p><small>行前準備 ${readyCount(state,p.id)} / ${myGear(state,p.id).length}</small>${entry.canEdit?button('編輯旅伴',menu.addPerson.action,'text-button',`data-id="${e(p.id)}"`):''}</div></article>`;}).join(''); }
function vehicleDepartureLine(vehicleId) {
  const d=firstDayDeparture(state,vehicleId);
  if(d.kind==='none')return '第 1 天還沒有路線';
  const place=d.place?mapLink(d.place):'出發地點待定';
  const head=d.time?`第 1 天・${e(d.time)} 出發：`:'第 1 天・出發時間待定：';
  return `${head}${place}${d.kind==='legacy'?'（舊的出發資料）':''}`;
}
function vehicleCards(menu) { return menu.vehicles.map(entry=>{const v=state.vehicles.find(x=>x.id===entry.id);return `<article class="vehicle-card"><div class="vehicle-title">${icon('car')}<h3>${e(v.name)}</h3><button class="icon-button" data-action="${entry.edit.action}" data-id="${e(v.id)}" aria-label="編輯 ${e(v.name)}">${icon('edit')}</button>${entry.canDelete?`<button class="icon-button danger" data-action="delete" data-kind="vehicle" data-id="${e(v.id)}" aria-label="移除 ${e(v.name)}">${icon('close')}</button>`:''}</div><p>駕駛 ${e(personName(state,v.driver))} <span>·</span> ${v.passengers.length+(v.driver?1:0)} / ${v.seats} 人</p><p class="help">${icon('pin')}${vehicleDepartureLine(v.id)}</p><div class="passenger-list">${v.passengers.map(id=>`<span>${e(personName(state,id))}</span>`).join('')}</div></article>`;}).join(''); }
function tripDetailsPanel() { return `<section class="settings-panel"><dl><dt>旅行名稱</dt><dd>${e(state.trip.title)}</dd><dt>旅行日期</dt><dd>${e(state.trip.startDate)} — ${e(state.trip.endDate)}</dd><dt>目的地</dt><dd>${mapLink(state.trip.destination)}</dd><dt>旅行小叮嚀</dt><dd>${e(state.trip.note)}</dd><dt>資料儲存</dt><dd>這台裝置的瀏覽器，不會傳送到原網站。</dd></dl></section>`; }
const DATA_TOOL_LABELS={export:icon('download')+'匯出備份',import:'匯入備份',print:'列印目前頁面'};
function dataTools(menu) { return `<section class="data-tools"><h3>把這本手冊帶走</h3><p>匯出 JSON 備份，也可以在另一台裝置匯入。匯入會取代目前資料。</p><div>${menu.data.map(action=>button(DATA_TOOL_LABELS[action],action)).join('')}</div></section>`; }
function eventSection(menu) { return `<section class="event-section"><h3>小隊最近的動態</h3><ul class="event-list">${menu.events.map(ev=>`<li><span><b>${e(ev.actor)}</b> ${e(ev.text)}</span><time>${new Date(ev.at).toLocaleString('zh-TW',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time></li>`).join('')}</ul></section>`; }
function resetArea(menu) { return `<div class="reset-area"><span>清除目前本機手冊內容並重新開始。</span>${button('清除旅行資料',menu.reset.action,'danger')}</div>`; }
// Non-modal drawer holding the content of the removed crew and settings tabs.
// Rows carry no data-swipe-row, so their buttons stay visible inside the drawer.
function tripMenu() {
  const menu=tripMenuEntries(state,account);
  return `<div class="trip-menu-backdrop" data-action="close-trip-menu" aria-hidden="true"></div><aside id="trip-menu" class="trip-menu" role="dialog" aria-modal="false" aria-labelledby="trip-menu-title"><div class="trip-menu-heading"><h2 id="trip-menu-title" tabindex="-1">旅行選單</h2><button type="button" class="icon-button" data-action="close-trip-menu" data-focus="trip-menu-close" aria-label="關閉旅行選單">${icon('close')}</button></div>`
    +`<section class="trip-menu-section" aria-labelledby="trip-menu-trip"><h3 id="trip-menu-trip">旅行設定</h3>${tripDetailsPanel()}<div>${button(icon('edit')+'編輯旅行',menu.trip.action,'small')}</div></section>`
    +`<section class="trip-menu-section" aria-labelledby="trip-menu-people"><h3 id="trip-menu-people">旅伴</h3>${identityNote(menu)}<div class="member-grid">${memberCards(menu)}</div><div>${button(icon('plus')+'新增旅伴',menu.addPerson.action,'small')}</div></section>`
    +`<section class="trip-menu-section" aria-labelledby="trip-menu-vehicles"><h3 id="trip-menu-vehicles">車輛</h3><div class="vehicles">${vehicleCards(menu)}</div><div>${button(icon('plus')+'新增車輛',menu.addVehicle.action,'small')}</div></section>`
    +`${sceneMotionSettings()}${dataTools(menu)}${eventSection(menu)}${resetArea(menu)}</aside>`;
}
function departure() {
  const items=myGear(state), done=readyCount(state), missing=unassigned(state), departed=state.departed.includes(state.currentUser);
  const next=[...state.activities].sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time)).find(a=>!a.done&&activityForPerson(state,a,state.currentUser));
  return `<main id="main" class="page departure"><a class="back-link" href="#/trip">← 回到規劃手冊</a><div class="departure-heading"><span class="eyebrow">LESS PLANNING, MORE LIVING</span><h1>${departed?'準備好了，一起出發！':'出發前，把小幸福帶齊。'}</h1><p>${e(state.trip.title)} · ${e(personName(state,state.currentUser))}的行前清單</p></div><div class="departure-banner">${icon('tent')}<div><strong>${done} / ${items.length} 項準備完成</strong><progress max="${Math.max(1,items.length)}" value="${done}" aria-label="我的準備進度"></progress></div><span>${Math.round(done/Math.max(1,items.length)*100)}%</span></div>${missing.length?`<div class="notice">${icon('info')}<div><b>別落下全隊的裝備</b><p>${missing.map(g=>e(g.name)).join('、')}還沒有人負責。</p><button class="text-button" data-action="resolve-gear">回去分配 ${icon('arrow')}</button></div></div>`:''}<div class="packing-columns">${['personal','shared'].map(scope=>`<section><h2>${scope==='personal'?'自己的小行李':'我負責的公用裝備'}</h2><div class="packing-list">${items.filter(g=>g.scope===scope).map(g=>`<label class="packing-item ${g.ready.includes(state.currentUser)?'done':''}"><input type="checkbox" data-pack="${e(g.id)}" data-focus="pack-${e(g.id)}" ${g.ready.includes(state.currentUser)?'checked':''} aria-label="${e(g.name)}已裝好"><span>${e(g.name)}</span><small>${e(g.quantity)}</small></label>`).join('')||'<p class="help">目前沒有分配給你的公用裝備。</p>'}</div></section>`).join('')}</div><div class="departure-confirm">${button(departed?icon('check')+'已準備完成':`確認準備完成，出發 ${icon('arrow')}`,'depart','primary',(!canDepart(state)||departed)?'disabled':'')}<p>${missing.length?'先分配公用裝備，再完成自己的清單。':done<items.length?'不用急，帶齊了再出發。':'好日子，就從現在開始。'}</p></div><section class="next-stop"><span class="eyebrow">${departed?'YOUR NEXT LITTLE MOMENT':'FIRST STOP'}</span><h2>${next?e(next.title):'你目前沒有待完成的行程。'}</h2>${next?`<p>${dateLabel(next.date)} ${e(next.time)} · ${mapLink(next.location)}</p><p class="help">${e(activityParticipantLabel(state,next))}</p><p class="help">${e(next.note)}</p>${departed?button('完成這一站 '+icon('arrow'),'advance','',`data-id="${e(next.id)}"`):''}`:'<p>可回規劃手冊查看全隊行程，或確認自己搭乘的車輛。</p>'}</section><a class="button full" href="#/trip" data-nav-tab="shopping">${icon('bag')} 打開採買清單</a></main>`;
}
function invite() {
  return `<main id="main" class="page invite-page"><section class="invite-card"><div class="invite-art">${illustration('travel')}</div><div class="invite-content"><span class="eyebrow">SAVE YOU A SPOT</span><h1>空一個位子，等你來。</h1><h2>${e(state.trip.title)}</h2><p class="invite-date">${icon('calendar')}${e(state.trip.startDate)} — ${e(state.trip.endDate)}</p><p class="invite-intro">不用從名單找自己。留下你的名字，就能成為這趟旅行的新旅伴。</p><form id="invite-form">${field('你的名字或暱稱',input('name',inviteDraft.name,'text','id="invite-name" aria-label="你的名字或暱稱" data-focus="invite-name" autocomplete="nickname" required maxlength="30" placeholder="例如：小樹"'))}${field('小隊角色（選填）',input('role',inviteDraft.role,'text','id="invite-role" aria-label="小隊角色（選填）" data-focus="invite-role" maxlength="60" placeholder="例如：早餐擔當、開心跟班"'))}<p class="form-error" role="alert">${e(inviteError)}</p><button class="button primary full" id="join-button" type="submit" ${!inviteDraft.name.trim()?'disabled':''}>填好名字，加入旅行 ${icon('arrow')}</button></form><div class="invite-demo">${icon('info')}<span>本機流程：名字只會加入這個瀏覽器的手冊。此網址不能讓其他裝置加入同一趟旅行，也不會建立真實帳號。</span></div></div></section><a class="back-link" href="#/trip">先看看這本旅行手冊 →</a></main>`;
}
function privacy() { return `<main id="main" class="page privacy-page"><span class="eyebrow">A LITTLE NOTE ABOUT YOUR DATA</span><h1>資料留在這裡，安心去玩。</h1><section><h2>這是什麼？</h2><p>這是獨立製作的本機旅行規劃工具，不代表「好好露營」網站或其營運者。</p><h2>資料存在哪裡？</h2><p>旅行內容保存在這個瀏覽器的 localStorage。不使用 Google 登入、分析追蹤或遠端資料庫；所有資源都從本機載入。沒有跨裝置同步，也沒有真正的邀請授權。</p><h2>離線與備份</h2><p>正式建置版在首次成功載入後可離線使用。你可以從旅行選單匯出備份。清除瀏覽器網站資料會刪除本機手冊，匯入備份會取代目前的手冊。</p><h2>共用裝置</h2><p>這個本機版沒有帳號隔離，在同一瀏覽器使用的人都可以看到這本手冊。請勿輸入真實個資或機密資料。</p><a class="button" href="#/trip">回到旅行手冊 ${icon('arrow')}</a></section></main>`; }
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
function updateMealForm(){
  const draft=mealDraft();if(!draft)return;
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
  dialogDirty=true;form.querySelector('.form-error').textContent='';document.querySelector('#ingredient-preview').innerHTML=ingredientPreview(next.ingredients);updateMealForm();
}
function addQuickIngredient(name){
  const draft=mealDraft();if(!draft||!Object.values(COMMON_INGREDIENTS).some(items=>items.includes(name)))return;
  const value=mergeIngredients(draft.ingredients,name), form=document.querySelector('#edit-form');
  if(value.length>500){form.querySelector('.form-error').textContent='食材最多 500 字，請先整理清單。';return;}
  form.elements.ingredients.value=value;dialogDirty=true;document.querySelector('#ingredient-preview').innerHTML=ingredientPreview(value);updateMealForm();
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
  if(kind==='meal'){
    const templates=`<section class="wide recipe-tools"><div class="recipe-tools-heading"><span class="eyebrow">A LITTLE HELP IN THE KITCHEN</span><h3>今晚想煮什麼？</h3><p>從常用料理開始，或直接往下填。食材會合併，不會清空你的清單。</p></div><div class="template-controls">${field('常用料理範本',`<select id="recipe-template" aria-label="常用料理範本"><option value="">選一道常用料理</option>${RECIPE_TEMPLATES.map(r=>`<option value="${r.id}">${e(r.title)}</option>`).join('')}</select>`)}<button type="button" class="button primary" data-action="apply-recipe" disabled>套用範本</button></div><div id="template-preview" hidden></div></section>`;
    const imageField=input('imageKind',item.imageKind||'auto','hidden');
    const shortcuts=`<details class="wide common-ingredients"><summary>常用食材，點一下加進來</summary><p class="help">已在清單裡的食材不會重複加入；移除請直接編輯食材欄。</p>${Object.entries(COMMON_INGREDIENTS).map(([category,names])=>`<fieldset><legend>${e(category)}</legend><div class="ingredient-shortcuts">${names.map(name=>`<button type="button" data-action="add-ingredient" data-ingredient="${e(name)}">${e(name)}</button>`).join('')}</div></fieldset>`).join('')}</details>`;
    formDialog(id?'編輯餐次':'新增一道好日子','meal',templates+field('料理名稱',input('title',item.title,'text','required maxlength="100" aria-label="料理名稱"'),true)+field('日期',`<select name="date" aria-label="日期">${dateOptions(item.date)}</select>`)+field('餐次',`<select name="slot" aria-label="餐次" required>${mealSlotOptions(item.slot).map(slot=>`<option value="${e(slot)}" ${slot===(item.slot||'晚餐')?'selected':''}>${e(slot)}${MEAL_SLOTS.includes(slot)?'':'（原餐次）'}</option>`).join('')}</select>`)+field('主廚',`<select name="cookId" aria-label="主廚">${personOptions(item.cookId)}</select>`)+field('人數',input('servings',item.servings||state.people.length,'number','required min="1" max="100"'))+imageField+field('食材（以頓號、/、逗號或句點分隔）',`<textarea name="ingredients" aria-label="食材（以頓號、/、逗號或句點分隔）" rows="3" maxlength="500" aria-describedby="ingredient-help" placeholder="牛肉片、高麗菜、雞蛋、壽喜燒醬">${e(item.ingredients||'')}</textarea>`,true)+shortcuts+`<div id="ingredient-preview" class="wide ingredient-preview" aria-live="polite">${ingredientPreview(item.ingredients||'')}</div>`+field('料理筆記',`<textarea name="notes" aria-label="料理筆記" rows="3" maxlength="1000">${e(item.notes||'')}</textarea>`,true),id);
    updateMealForm();
  }
  if(kind==='shopping')formDialog(id?'編輯採買品項':'把好吃的加進清單','shopping',field('品項名稱',input('name',item.name,'text',`required aria-label="品項名稱" maxlength="100" ${item.mealIds?.length?'readonly aria-describedby="linked-name-help"':''}`)+(item.mealIds?.length?'<small id="linked-name-help" class="help">食材名稱與料理連動，請在料理菜單修改；數量、分類與負責人可在這裡調整。</small>':''),true)+field('數量與單位',input('quantity',item.quantity||'1 份','text','required maxlength="40"'))+field('分類',`<select name="category">${categories.map(c=>`<option ${(item.category||'其他')===c?'selected':''}>${c}</option>`).join('')}</select>`)+field('誰負責買',`<select name="assignee" class="assignee-select" data-person-select data-person-color="${personColor(item.assignee)}">${personOptions(item.assignee)}</select>`,true),id);
  if(kind==='gear'){
    const presetField=id?'':field('常用露營裝備（選填）',`<select id="gear-preset" aria-describedby="gear-preset-help">${gearPresetOptions()}</select>`,true)+`<p class="help wide gear-preset-help" id="gear-preset-help">選擇後只填入名稱與建議數量，個人清單請選「每人一份」，共同攜帶則選「公用裝備」；按「儲存」才會加入。</p>`;
    const assigneeField=`<label class="field wide" data-gear-assignee-field><span>公用裝備攜帶人</span><select name="assignee" class="assignee-select" data-person-select data-person-color="${personColor(item.assignee)}">${personOptions(item.assignee)}</select></label>`;
    formDialog(id?'編輯裝備':'帶上新的小幫手','gear',field('類型',`<select name="scope" class="gear-scope-select"><option value="personal" ${item.scope==='personal'?'selected':''}>每人一份</option><option value="shared" ${item.scope==='shared'||!id?'selected':''}>公用裝備</option></select>`,true)+presetField+field('裝備名稱',input('name',item.name,'text','required maxlength="100"'),true)+field('數量與單位',input('quantity',item.quantity||'1 個','text','required maxlength="40"'),true)+assigneeField,id);
    updateGearScope();
  }
  if(kind==='person'){const p=state.people.find(p=>p.id===id);formDialog(p?'編輯旅伴':'多一個人，多一份快樂','person',field('旅伴名字',input('name',p?.name||'','text','required maxlength="30"'),true)+field('小隊角色',input('role',p?.role||'','text','required maxlength="60" placeholder="例如：早餐擔當"'),true)+field('旅伴代表色',`<select name="color" aria-label="旅伴代表色">${COLORS.map(color=>`<option value="${color}" ${color===(p?.color||COLORS[state.people.length%COLORS.length])?'selected':''}>${colorChoices[color]}</option>`).join('')}</select>`,true),id);}
  if(kind==='vehicle'){formDialog(id?'編輯這台車':'新增一台出發的車','vehicle',field('車輛暱稱',input('name',item.name,'text','required maxlength="50"'),true)+field('駕駛',`<select name="driver" aria-label="駕駛">${personOptions(item.driver??state.currentUser,!!account)}</select>`)+field('座位數（含駕駛）',input('seats',item.seats||4,'number','required min="1" max="9"'))+`<p class="help wide">每天的出發時間與地點，請在規劃行程的路線填寫。</p>`+`<fieldset class="wide"><legend>乘客（請勿重複選駕駛）</legend><div class="passenger-checks">${state.people.map(p=>`<label><input type="checkbox" name="passengers" value="${e(p.id)}" ${item.passengers?.includes(p.id)?'checked':''}>${e(p.name)}</label>`).join('')}</div></fieldset>`,id);}
  if(kind==='trip-settings')formDialog('把旅行，寫成你喜歡的樣子','trip-settings',field('旅行名稱',input('title',state.trip.title,'text','required maxlength="100"'),true)+field('目的地',input('destination',state.trip.destination,'text','required maxlength="100"'),true)+field('開始日期',input('startDate',state.trip.startDate,'date','required'))+field('結束日期',input('endDate',state.trip.endDate,'date','required'))+field('旅行介紹',`<textarea name="description" rows="2" maxlength="300">${e(state.trip.description)}</textarea>`,true)+field('旅行小叮嚀',`<textarea name="note" rows="2" maxlength="500">${e(state.trip.note)}</textarea>`,true));
}
function exportData() { if(studioDirty()&&route()==='trip'&&tab==='schedule'){const text=JSON.stringify(studioMount.getPlan(),null,2);const blob=new Blob([text],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='storybook-unsaved-draft.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('已匯出尚未儲存的繪本草稿，這不是完整旅行備份');return;}const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='good-good-camping-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('旅行手冊已匯出'); }
function linkedShoppingDialog(id){
  const item=state.shopping.find(s=>s.id===id);if(!item)return;
  const meals=(item.mealIds||[]).map(mid=>state.meals.find(m=>m.id===mid)).filter(Boolean);
  const many=meals.length>1;
  const list=meals.map((m,i)=>`<label class="check-row"><input type="checkbox" name="linked-meal" value="${e(m.id)}" checked> ${e(m.title)}（${e(m.date)} ${e(m.slot)}）</label>`).join('');
  showDialog('移除這項食材？',`<p><b>${e(item.name)}</b> 是料理食材。${many?'它同時用在下面幾道料理，請勾選要移除的料理：':'移除後，料理菜單上的這項食材也會一併刪除：'}</p><div class="linked-meals">${list}</div><p class="help">提醒：這會同步修改對應料理的食材清單${account?'，其他旅伴也會看到變更':''}。${many?'若只勾選部分料理，採買品項會保留給其餘料理使用。':''}</p><div class="form-actions">${button('取消','close-dialog')}${button('確認移除','confirm-delete-linked','danger',`data-id="${e(id)}"`)}</div>`);
}
const actions={
  'apply-recipe':applySelectedRecipe,
  'add-ingredient'(id,el){addQuickIngredient(el.dataset.ingredient);},
  'edit-shopping-quantity'(id,el){
    const item=state.shopping.find(s=>s.id===id);if(!item||accountSaving||!saved||account&&!account.permissions.canEdit)return;
    const input=document.createElement('input');input.type='text';input.className='quantity quantity-input';input.maxLength=40;input.value=item.quantity==='數量待確認'?'':item.quantity;input.dataset.shoppingQuantityInput=id;input.dataset.originalQuantity=item.quantity;input.dataset.focus=el.dataset.focus;input.setAttribute('aria-label',`${item.name}數量`);input.placeholder='數量待確認';el.replaceWith(input);input.focus();input.select();
  },
  theme(){ theme=theme==='light'?'dark':'light'; document.documentElement.dataset.theme=theme;try{localStorage.setItem(THEMES_KEY,theme);}catch{}render(); },
  profile(){ if(account){showDialog('你的登入帳號',`<p>${e(account.user.displayName)} · @${e(account.user.username)}</p><p>帳號身分由伺服器確認，不能切換成其他旅伴。</p><a class="button" href="/${e(account.user.username)}/home">回到我的首頁</a>`);return;}showDialog('今天，你是哪一位旅伴？',`<p class="dialog-note">只切換本機手冊的旅伴身分，不會登入真實帳號。</p><div class="identity-grid">${state.people.map(p=>`<button class="identity-option ${p.id===state.currentUser?'selected':''}" data-action="choose-person" data-id="${e(p.id)}">${avatar(p)}<span>${e(p.name)}</span>${p.id===state.currentUser?icon('check'):''}</button>`).join('')}</div>`); },
  'choose-person'(id){ state.currentUser=id;closeDialog(true);commit(`現在是${personName(state,id)}的視角`); },
  invite(){ if(account){void openAccountInviteDialog();return;}showDialog('邀請旅伴，名字讓他自己填',`<div class="invite-mini">${illustration('travel')}</div><p>把邀請頁交給旅伴，由對方自行填寫名字，不必預先建立名單。</p><div class="notice">${icon('info')}<span>目前只在本機運作。這個網址不會把你的手冊同步到其他裝置，正式多人邀請需要後端服務。</span></div><div class="form-actions"><button class="button" data-action="copy-invite">${icon('link')}複製本機網址</button><a class="button primary" href="#/invite" data-action="close-dialog">預覽邀請頁 ${icon('arrow')}</a></div>`); },
  async 'copy-invite'(){if(account){try{await navigator.clipboard.writeText(accountInviteUrl);notify('已複製邀請網址');}catch{notify('請選取邀請網址後手動複製');}return;}const url=location.href.split('#')[0]+'#/invite';try{await navigator.clipboard.writeText(url);notify('已複製本機網址');}catch{showDialog('複製本機網址',field('請選取並複製',input('url',url,'text','readonly')));} },
  export:exportData,
  'recover-storage'(){showDialog('先保留資料，再繼續',`<p>為避免覆蓋損毀資料或另一分頁的更新，目前暫停儲存。請先匯出目前內容，再選擇下一步。</p><div class="form-actions">${button('匯出目前內容','export')}${originalBackup?button('下載原始資料','export-original'):''}${pendingRemote?button('載入另一分頁版本','apply-remote'):''}${button('以目前內容取代儲存','unlock-storage','primary')}</div>`);},
  'export-original'(){const url=URL.createObjectURL(new Blob([originalBackup],{type:'text/plain'}));const a=document.createElement('a');a.href=url;a.download='camping-original-recovery.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);},
  'apply-remote'(){if(!pendingRemote)return;if(studioDirty()){notify('繪本草稿尚未儲存，請先匯出繪本 JSON 後重新載入，再套用另一分頁資料。');return;}dropStudio();state=pendingRemote;baseRevision=state.revision;pendingRemote=null;storageLocked=false;saved=true;closeDialog(true);render();},
  'unlock-storage'(){if(studioDirty()){notify('繪本草稿尚未儲存，請先匯出繪本 JSON；此操作只會儲存網站目前資料。');return;}storageLocked=false;pendingRemote=null;state.revision=Math.max(state.revision,readStorage(storage).state.revision)+1;saved=save(storage,state);if(saved){baseRevision=state.revision;originalBackup='';}closeDialog(true);render();notify(saved?'已儲存目前內容':'仍無法儲存，請匯出備份。');},
  import(){showDialog('匯入旅行備份',`<form id="import-form"><p class="dialog-note">匯入會取代這台裝置的旅行手冊。請先匯出目前的資料。</p><label class="field">選擇 JSON 備份<input type="file" name="backup" accept=".json,application/json" required></label><p class="form-error" role="alert"></p><div class="form-actions"><button class="button" type="button" data-action="close-dialog">取消</button><button class="button primary">匯入並取代</button></div></form>`);},
  print(){window.print();},
  reset(){showDialog('清除這本旅行手冊？',`<p>這會移除目前裝置儲存的行程、料理、採買與其他內容，並建立一本空白手冊。此操作無法復原。</p><div class="form-actions">${button('先不要','close-dialog')}${button('清除並重新開始','confirm-reset','danger')}</div>`);},
  'confirm-reset'(){if(studioDirty()){notify('請先儲存繪本草稿，或在繪本內匯出 JSON 後重新載入，再清除旅行手冊。');return;}dropStudio();state=emptyState();day=state.trip.startDate;tab='schedule';storageLocked=false;pendingRemote=null;saved=save(storage,state);baseRevision=state.revision;closeDialog(true);render();notify(saved?'已建立空白旅行手冊':'重設只保留在記憶體，請檢查儲存空間。');},
  'close-dialog'(){closeDialog();},
  'resolve-gear'(){tab='gear';gearFilter='unassigned';if(account)location.href=accountTripPath();else location.hash='/trip';},
  depart(){if(account){void accountCheck('depart','',true);return;}if(!canDepart(state))return;state.departed.push(state.currentUser);commit('準備完成，一起出發');},
  advance(id){const item=state.activities.find(a=>a.id===id);if(item){item.done=true;commit(`完成了「${item.title}」`);}},
  delete(id,el){if(el.dataset.kind==='vehicle'){const messages=[],days=vehicleRouteDays(state,id);if(days.length)messages.push(`這台車在${days.map(n=>`第 ${n} 天`).join('、')}還有路線，請先刪除這些路線，或改派給其他車。`);if(state.activities.some(a=>a.vehicleIds?.includes(id)))messages.push('這台車仍有指定行程。請先把那些行程改派其他車輛或改為全體，再移除車輛。');if(messages.length){const message=messages.join(' '),error=dialog.querySelector('#edit-form[data-kind="vehicle"] .form-error');if(error)error.textContent=message;else notify(message);return;}}if(el.dataset.kind==='shopping' && state.shopping.find(s=>s.id===id)?.mealIds?.length){if(dialogDirty&&!window.confirm('移除項目前，會放棄尚未儲存的修改。確定繼續？'))return;linkedShoppingDialog(id);return;}if(dialogDirty&&!window.confirm('移除項目前，會放棄尚未儲存的修改。確定繼續？'))return;const kind=el.dataset.kind;showDialog('移除這個項目？',`<p>${account?'會從這趟旅行移除項目，其他旅伴也會看到變更。':'只會從這台裝置的本機手冊移除，無法復原。'}</p><div class="form-actions">${button('取消','close-dialog')}${button('確認移除','confirm-delete','danger',`data-id="${e(id)}" data-kind="${kind}"`)}</div>`);},
  'confirm-delete-linked'(id){const ids=[...dialog.querySelectorAll('input[name=linked-meal]:checked')].map(x=>x.value);if(!ids.length){notify('請至少勾選一道料理。');return;}const next=removeIngredientFromMeals(state,id,ids);try{syncMealIngredients(next);}catch(err){notify(err.message);return;}state=next;closeDialog();commit('已移除食材，並同步更新料理菜單');},
  'confirm-delete'(id,el){const collection={activity:'activities',meal:'meals',shopping:'shopping',gear:'gear',vehicle:'vehicles'}[el.dataset.kind];if(collection){if(collection==='vehicles'&&state.activities.some(a=>a.vehicleIds?.includes(id))){notify('這台車仍有指定行程，請先重新安排。');return;}const next={...state,[collection]:state[collection].filter(x=>x.id!==id)};try{if(collection==='meals'||collection==='shopping')syncMealIngredients(next);}catch(err){notify(err.message);return;}state=next;if(collection==='gear')state.departed=[];closeDialog();commit('已移除項目');}}
};
['meal','shopping','gear','person','vehicle','trip-settings'].forEach(kind=>actions[kind]=id=>editForm(kind,id));
function openTripMenu(){tripMenuOpen=true;render();app.querySelector('#trip-menu-title')?.focus({preventScroll:true});}
function closeTripMenu(){
  if(!tripMenuOpen)return;
  tripMenuOpen=false;deferredFocus='trip-menu-button';
  // The focused control lives in the drawer, so render() would otherwise try to restore focus to it.
  if(document.activeElement?.closest?.('#trip-menu'))document.activeElement.blur();
  render();
}
actions['header-menu']=(id,el)=>{const m=document.getElementById('header-menu');if(!m)return;const open=m.classList.toggle('open');el.setAttribute('aria-expanded',String(open));};
document.addEventListener('click',event=>{const m=document.getElementById('header-menu');if(!m?.classList.contains('open'))return;if(event.target.closest('.header-menu-toggle'))return;if(event.target.closest('.header-actions')&&!event.target.closest('#header-menu a, #header-menu button'))return;m.classList.remove('open');document.querySelector('.header-menu-toggle')?.setAttribute('aria-expanded','false');});
actions['trip-menu']=()=>tripMenuOpen?closeTripMenu():openTripMenu();
actions['close-trip-menu']=()=>closeTripMenu();

document.addEventListener('click',event=>{
  const el=event.target.closest('button,a');
  if(!el||!studioDirty()||studioHost?.contains(el))return;
  const leave=el.dataset.tab&&el.dataset.tab!=='schedule'||el.dataset.navTab&&el.dataset.navTab!=='schedule'||el.tagName==='A'&&el.getAttribute('href')&&el.getAttribute('href')!=='#'||['account-reload','account-logout','confirm-reset','apply-remote'].includes(el.dataset.action);
  if(leave&&!window.confirm('繪本還有未儲存的行程。切換網站分頁會保留草稿，但在其他分頁修改旅行後將無法直接儲存繪本。請先儲存或匯出繪本 JSON。確定繼續？')){event.preventDefault();event.stopImmediatePropagation();}
},true);
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
  if(event.target.closest?.('.trip-menu-backdrop')){closeTripMenu();return;}
  const el=event.target.closest('button,a');if(!el)return;
  if(account&&el.dataset.action&&!allowAccountAction(el.dataset.action)){event.preventDefault();return;}
  if(tripMenuOpen&&el.dataset.action&&el.closest('#trip-menu')&&!['trip-menu','close-trip-menu'].includes(el.dataset.action))closeTripMenu();
  if(el.dataset.navTab){tab=el.dataset.navTab;}
  if(el.dataset.action && actions[el.dataset.action]) actions[el.dataset.action](el.dataset.id,el);
  if(el.dataset.tab){tripMenuOpen=false;tab=el.dataset.tab;render();}
  if(el.dataset.shopFilter){shoppingFilter=el.dataset.shopFilter;render();}
  if(el.dataset.gearFilter){gearFilter=el.dataset.gearFilter;render();}
});
document.addEventListener('change',event=>{
  const el=event.target;
  if(el.matches('select[data-person-select]'))el.dataset.personColor=personColor(el.value);
  if(el.dataset.shoppingAssignee||el.dataset.gearAssignee)deferredFocus=el.dataset.focus;
  if(el.name==='imageKind' && el.closest('#edit-form')){dialogDirty=true;updateMealForm();}
  if(el.id==='recipe-template')updateTemplatePreview();
  if(el.id==='gear-preset')applyGearPreset();
  if(el.name==='scope'&&el.closest('#edit-form[data-kind="gear"]')){dialogDirty=true;updateGearScope();}
  if(el.id==='hide-done'){hideDone=el.checked;render();}
  if(el.dataset.shoppingCheck&&account){void accountCheck('shopping',el.dataset.shoppingCheck,el.checked);return;}
  if(el.dataset.pack&&account){void accountCheck('gear',el.dataset.pack,el.checked);return;}
  if(account&&(accountSaving||!saved||!account.permissions.canEdit)&& (el.dataset.gearAssignee||el.dataset.shoppingAssignee)){render();return;}
  if(el.dataset.shoppingCheck){const item=state.shopping.find(s=>s.id===el.dataset.shoppingCheck);if(!item)return;item.done=el.checked;commit(`${item.name}${item.done?'已買齊':'改為待買'}`,false);}
  if(el.dataset.shoppingAssignee){if(assignShopping(state,el.dataset.shoppingAssignee,el.value))commit('採買分工已更新');else render();}
  if(el.dataset.gearAssignee){const item=state.gear.find(g=>g.id===el.dataset.gearAssignee);if(item&&item.assignee!==el.value&&assignGear(state,item.id,el.value))commit('裝備分工已更新');else render();}
  if(el.dataset.pack){togglePacking(state,el.dataset.pack);commit('行前清單已更新',false);}
});
document.addEventListener('keydown',event=>{
  const input=event.target.closest('input[data-shopping-quantity-input]');if(!input)return;
  // IME（注音、拼音）以 Enter 確認選字、以 Escape 取消組字；組字中不儲存也不取消。Safari 的 isComposing 不可靠，另檢查 keyCode 229。
  if(event.isComposing||event.keyCode===229)return;
  if(event.key==='Enter'){event.preventDefault();input.blur();}
  if(event.key==='Escape'){event.preventDefault();input.dataset.cancel='true';input.blur();}
});
document.addEventListener('focusout',event=>{
  const input=event.target.closest('input[data-shopping-quantity-input]');if(!input)return;
  const id=input.dataset.shoppingQuantityInput,item=state.shopping.find(s=>s.id===id);if(!item){render();return;}
  deferredFocus=input.dataset.focus;
  if(input.dataset.cancel==='true'){render();return;}
  const value=input.value.trim(),next=value|| (input.dataset.originalQuantity==='數量待確認'?'數量待確認':'');
  if(next===item.quantity){render();return;}
  if(!value||value.length>40){notify(!value?'請填寫數量與單位。':'數量與單位最多 40 字。');render();return;}
  item.quantity=value;commit('採買數量已更新');
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
  if(form.id==='import-form'){try{if(studioDirty())throw new Error('繪本有未儲存的草稿。請先在繪本內儲存或匯出 JSON，重新載入頁面後再匯入整趟旅行。');const file=data.get('backup');if(!file||file.size>1_048_576)throw new Error('請選擇不超過 1 MiB 的備份檔。');const imported=JSON.parse(await file.text());if(!isValidState(imported))throw new Error('這不是有效的旅行手冊備份。');syncMealIngredients(imported);dropStudio();state=imported;day=state.trip.startDate;storageLocked=false;pendingRemote=null;state.revision=Math.max(state.revision,readStorage(storage).state.revision)+1;saved=save(storage,state);baseRevision=state.revision;closeDialog(true);render();notify(saved?'旅行備份已匯入':'已載入，但無法永久儲存。');}catch(err){form.querySelector('.form-error').textContent=err.message;}return;}
  const kind=form.dataset.kind,id=form.dataset.id;
  const values=Object.fromEntries([...data.entries()].filter(([key])=>!['passengers','vehicleIds','participation'].includes(key)).map(([key,value])=>[key,typeof value==='string'?value.trim():value]));
  if([...form.querySelectorAll('[required]')].some(el=>!String(el.value).trim())){form.querySelector('.form-error').textContent='請填寫必要欄位，不能只有空白。';return;}
  if(kind==='trip-settings'){
    const dates=dateRange(values.startDate,values.endDate);
    if(!dates.length||Date.parse(values.endDate)-Date.parse(values.startDate)>30*86400000){form.querySelector('.form-error').textContent='結束日期需在開始日期之後，旅行最長 31 天。';return;}
    const fail=message=>{form.querySelector('.form-error').textContent=message;};
    if(values.destination!==state.trip.destination){
      const conflict=destinationConflict(state,values.destination);
      if(conflict?.type==='duplicate'){fail(`已有同名地點：${conflict.name}。請先在「地點與車」把這個地點改名。`);return;}
    }
    const retimed=retimeByDayIndex(state,values.startDate,values.endDate);
    if(!retimed.ok){fail(shortenBlockedMessage(retimed.blocked));return;}
    const next=retimed.state;
    next.trip={...next.trip,...values};
    if(!isValidState(next)){fail('旅行設定無法儲存，請檢查輸入的內容。');return;}
    state=next;day=state.trip.startDate;
  }else if(kind==='person'){
    try{if(account&&id){const old=state.people.find(p=>p.id===id);const probe={...state,people:state.people.filter(p=>p.id!==id)};const updated=addParticipant(probe,values.name,values.role).person;state={...state,people:state.people.map(p=>p.id===id?{...old,name:updated.name,role:updated.role,color:COLORS.includes(values.color)?values.color:old.color}:p)};}else {const added=addParticipant(state,values.name,values.role);state=added.state;if(COLORS.includes(values.color))state.people.find(p=>p.id===added.person.id).color=values.color;}}catch(err){form.querySelector('.form-error').textContent=err.message;return;}
  }else if(kind==='meal'){
    const result=saveMeal(state,{...values,id:id||null},{uid});
    if(!result.ok){form.querySelector('.form-error').textContent=result.formError||EDIT_MESSAGES.invalidState;return;}
    state=result.state;
  }else if(kind==='vehicle'){
    const result=saveVehicle(state,{...values,id:id||null,passengers:data.getAll('passengers')},{uid});
    if(!result.ok){form.querySelector('.form-error').textContent=result.formError||EDIT_MESSAGES.invalidState;return;}
    state=result.state;
  }else{
    const collection={activity:'activities',meal:'meals',shopping:'shopping',gear:'gear',vehicle:'vehicles'}[kind];
    const old=state[collection].find(x=>x.id===id);
    const defaults=kind==='shopping'?{done:false}:kind==='gear'?{ready:[]}:{};
    const item={...defaults,...old,...values,id:old?.id||uid()};
    if(kind==='shopping'){
      if(old?.mealIds?.length && values.name!==old.name){form.querySelector('.form-error').textContent='連動食材名稱請在料理菜單修改。';return;}
      const names=parseIngredients(values.name).map(name=>name.replace(/\s+/gu,'').toLocaleLowerCase('zh-TW'));
      if(!old && state.shopping.some(s=>parseIngredients(s.name).some(name=>names.includes(name.replace(/\s+/gu,'').toLocaleLowerCase('zh-TW'))))){form.querySelector('.form-error').textContent='清單已有同名品項，請編輯既有品項的數量與分類。';return;}
      item.source='manual';
    }
    if(kind==='gear'){if(item.scope==='personal')item.assignee='';if(old?.assignee!==item.assignee||old?.scope!==item.scope)item.ready=[];state.departed=[];}
    const next={...state,[collection]:old?state[collection].map(x=>x.id===id?item:x):[...state[collection],item]};
    if(kind==='shopping'){try{syncMealIngredients(next);}catch(err){form.querySelector('.form-error').textContent=err.message;return;}}
    state=next;
  }
  closeDialog(true);commit(kind==='meal'?'料理已儲存，食材已同步採買清單':'旅行手冊已更新');
});
document.addEventListener('input',event=>{
  const el=event.target;
  if(el.closest('#invite-form')){inviteDraft[el.name]=el.value;inviteError='';el.closest('form').querySelector('.form-error').textContent='';document.querySelector('#join-button').disabled=!inviteDraft.name.trim();}
  if(el.closest('#edit-form'))dialogDirty=true;
  if(el.name==='name'&&el.closest('#edit-form[data-kind="gear"]')){const picker=dialog.querySelector('#gear-preset');if(picker&&picker.value!==el.value)picker.value='';}
  if(el.closest('#edit-form')?.dataset.kind==='meal'&&!event.isComposing){if(el.name==='ingredients')document.querySelector('#ingredient-preview').innerHTML=ingredientPreview(el.value);updateMealForm();}
});
document.addEventListener('compositionend',event=>{if(event.target.closest('#edit-form')?.dataset.kind==='meal'){if(event.target.name==='ingredients')document.querySelector('#ingredient-preview').innerHTML=ingredientPreview(event.target.value);updateMealForm();}});
dialog.addEventListener('cancel',event=>{if(dialogDirty){event.preventDefault();closeDialog();}});
// 點擊背景關閉：支援 closedby 的瀏覽器由 index.html 的 closedby="any" 處理（經 cancel 事件，未儲存時同樣先確認）；其他瀏覽器（Safari）使用以下後備。
dialog.addEventListener('click',event=>{if(!('closedBy' in HTMLDialogElement.prototype)&&event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeDialog();}});
document.addEventListener('keydown',event=>{
  if(event.key!=='Escape'||!tripMenuOpen||dialog.open)return;
  event.preventDefault();closeTripMenu();
});
let lastPage=route();
window.addEventListener('hashchange',()=>{const page=route();lastPage=page;if(dialog.open)closeDialog();tripMenuOpen=false;render();window.scrollTo({top:0,behavior:'instant'});});
window.addEventListener('storage',event=>{if(account)return;if(event.key!==STORAGE_KEY||!event.newValue)return;let incoming;try{incoming=JSON.parse(event.newValue);}catch{return;}if(!isValidState(incoming)||incoming.revision===baseRevision)return;if(!saved||studioDirty()||dialog.open||(route()==='invite'&&(inviteDraft.name||inviteDraft.role))){pendingRemote=incoming;storageLocked=true;saved=false;render();notify('另一分頁有更新。已保留你的修改，請先匯出備份。');return;}state=incoming;baseRevision=incoming.revision;render();notify('已載入另一個分頁的本機更新');});
window.addEventListener('beforeunload',event=>{if(expensePanel?.isDirty()||studioDirty()||dialogDirty||!saved||(route()==='invite'&&(inviteDraft.name||inviteDraft.role))){event.preventDefault();event.returnValue='';}});
function accountTripPath(){return `/${account.user.username}/trips/${account.trip.id}`;}
function accountHeader(){const home=`/${e(account.user.username)}/home`;return `<header class="topbar"><div class="topbar-inner"><a class="brand" href="${home}" aria-label="日子拾光首頁">${logo()}<span>日子拾光<small>LITTLE MOMENTS</small></span></a><div class="header-actions"><button class="icon-button header-theme" data-action="theme" aria-label="切換${theme==='light'?'深色':'淺色'}模式">${icon(theme==='light'?'moon':'sun')}</button><button type="button" class="icon-button header-menu-toggle" data-action="header-menu" aria-expanded="false" aria-controls="header-menu" aria-label="帳號選單：${e(account.user.displayName)}" title="${e(account.user.displayName)}"><span class="header-avatar-mark" aria-hidden="true">${e(Array.from(account.user.displayName.trim())[0]||'?')}</span></button><div class="header-collapse" id="header-menu"><a class="text-link header-home" href="${home}">我的首頁</a>${account.user.role==='admin'?'<a class="text-link header-admin" href="/admin">管理後台</a>':''}<button class="profile-button" data-action="profile">${e(account.user.displayName)}</button><button class="text-button header-logout" data-action="account-logout">登出</button></div></div></div></header>`;}
function allowAccountAction(action){
  if(['delete','confirm-delete','confirm-delete-linked'].includes(action)&&account.permissions.canDelete!==true){notify('只有旅行建立者與管理員可以刪除內容。');return false;}
  if(INVITE_ACTIONS.includes(action)&&account.permissions.canInvite!==true){notify(INVITE_DENIED);return false;}
  const blocked=['choose-person','import','reset','confirm-reset','unlock-storage','recover-storage','apply-remote','export-original'];
  if(blocked.includes(action)){notify('帳號版不提供這項本機操作。');return false;}
  const safe=['theme','profile','export','print','close-dialog','resolve-gear','account-reload','account-retry','account-logout','trip-menu','close-trip-menu','header-menu'];
  if(safe.includes(action))return !accountSaving||['export','trip-menu','close-trip-menu','header-menu'].includes(action);
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
  if(sync)sync.innerHTML=`<i></i>${accountSaving?'正在儲存…':saved?'已儲存至本機伺服器':'尚未儲存'}<span>·</span>${account.permissions.canDelete?'建立者／管理員模式':account.permissions.canEdit?'協作編輯模式，不能刪除旅伴、料理、採買品項、裝備與車輛':'僅可檢視模式'}${navigator.onLine?'':' · 離線時無法儲存'}`;
  if(!account.permissions.canEdit)for(const el of app.querySelectorAll('[data-action]'))if(!['theme','profile','export','print','close-dialog','resolve-gear','depart','account-logout','trip-menu','close-trip-menu'].includes(el.dataset.action))el.hidden=true;
  if(account.permissions.canInvite!==true)for(const el of app.querySelectorAll(INVITE_ACTIONS.map(a=>`[data-action="${a}"]`).join(',')))el.hidden=true;
  for(const selector of ['.reset-area','.data-tools [data-action="import"]','.identity-note [data-action="profile"]'])for(const el of app.querySelectorAll(selector))el.remove();
  const note=app.querySelector('.identity-note');if(note)note.innerHTML=`${icon('info')}登入帳號：<b>${e(account.user.displayName)}</b> · ${account.permissions.personId?'已綁定旅伴':'管理員檢視，未加入此旅行'}`;
  const info=app.querySelector('.settings-panel dl');if(info){const dt=[...info.querySelectorAll('dt')].find(el=>el.textContent==='資料儲存');if(dt)dt.nextElementSibling.textContent='伺服器的 PostgreSQL 資料庫，由登入帳號與旅行權限控管。';}
  const dataCopy=app.querySelector('.data-tools>p');if(dataCopy)dataCopy.textContent='匯出這趟旅行的行程 JSON 備份，不包含獨立分帳帳本。帳目請到「分帳記帳」另行匯出；帳號版不會以匯入檔直接覆蓋共用旅行。';
  for(const el of app.querySelectorAll('[data-shopping-check]')){const row=state.shopping.find(s=>s.id===el.dataset.shoppingCheck);el.disabled=accountSaving||!saved||(!account.permissions.canEdit&&row?.assignee!==account.permissions.personId);}
  for(const el of app.querySelectorAll('[data-pack]'))el.disabled=accountSaving||!saved||!account.permissions.personId;
  for(const el of app.querySelectorAll('[data-activity-check],[data-gear-assignee],[data-shopping-assignee]'))el.disabled=accountSaving||!saved||!account.permissions.canEdit;
  
  for(const el of app.querySelectorAll('[data-action]'))if(accountSaving&&!['export','theme','profile','trip-menu','close-trip-menu'].includes(el.dataset.action))el.disabled=true;
  if(route()==='go'&&!account.permissions.personId){app.querySelector('main').innerHTML=`<div class="empty"><h1>你目前以管理員身分檢視</h1><p>尚未加入此旅行，因此沒有個人行前清單。你仍可編輯所有旅行內容。</p><a class="button primary" href="${accountTripPath()}">回到規劃手冊</a></div>`;}
  if(accountError||!saved){const warning=document.createElement('div');warning.className='save-warning';warning.setAttribute('role','alert');warning.innerHTML=`<span>${e(accountError||'內容尚未儲存，請保留備份。')}</span>${studioDirty()?'繪本草稿請在繪本內匯出 JSON；帳號未成功儲存。':!saved?button('匯出未存內容','export')+button('重試儲存','account-retry'):''}${button('重新載入伺服器版本','account-reload')}`;app.querySelector('header').after(warning);}
}
function acceptAccountResult(result){state=result.state;account.state=result.state;account.trip=result.trip;account.permissions=result.permissions;baseRevision=state.revision;saved=true;accountError='';}
async function commitAccount(message,announce=true){
  if(accountSaving)return false;
  if(!account.permissions.canEdit){notify('你目前沒有這趟旅行的編輯權限。');return false;}
  if(!isValidState(state)){saved=false;accountError='內容驗證未通過，尚未寫入伺服器。請匯出備份後重新載入。';render();return false;}
  accountSaving=true;saved=false;accountError='';render();
  let ok=false;
  try{await assertAccountSession();const result=await account.api(`/api/trips/${account.trip.id}`,{method:'PUT',body:{revision:account.trip.revision,expectedUserId:account.user.id,state}});acceptAccountResult(result);ok=true;if(announce)notify(message+' · 已儲存至本機伺服器');}
  catch(err){accountError=err.status===409?'其他人已更新這趟旅行。你的修改仍留在畫面，請先匯出，再重新載入合併。':err.status===401?'登入已失效。你的未儲存修改還在本頁，請先匯出備份，再重新登入。':`${err.message}，你的修改尚未儲存。`;}
  finally{accountSaving=false;render();}
  return ok;
}
async function accountCheck(kind,id,checked){
  if(accountSaving||!saved){render();return;}
  accountSaving=true;accountError='';render();
  try{await assertAccountSession();acceptAccountResult(await account.api(`/api/trips/${account.trip.id}/check`,{method:'POST',body:{revision:account.trip.revision,expectedUserId:account.user.id,kind,id,checked}}));notify('分工狀態已儲存');}
  catch(err){if(accountSessionChanged||err.status===0||err.status===401)saved=false;accountError=err.status===409?'旅行已有更新，請重新載入後再勾選。':err.status===401?'登入已失效，請重新登入；這次勾選未儲存。':`${err.message}，這次勾選未儲存。`;}
  finally{accountSaving=false;render();}
}
// Invitation_Dialog (Req 16.10, 16.11, 18.1, 19.10–19.13): opening only loads the Invite_List; links are created on request.
const invitesPath=()=>`/api/trips/${encodeURIComponent(account.trip.id)}/invites`;
const inviteTime=value=>e(new Date(value).toLocaleString('zh-TW'));
async function loadAccountInvites(){const result=await account.api(invitesPath());accountInvites=Array.isArray(result?.invites)?result.invites:[];}
function clearAccountInviteLink(){accountInviteUrl='';accountInviteId='';accountInviteExpiresAt='';}
function renderAccountInviteDialog(focus=''){
  const keepFocus=dialog.open?returnFocus:null;
  const busy=accountInviteBusy?'disabled':'';
  const link=accountInviteUrl?`${field('邀請網址',input('invite-url',accountInviteUrl,'text','id="invite-url" readonly'))}<div class="form-actions">${button('複製邀請網址','copy-invite')}</div><p>這個連結只能讓一位旅伴加入，建立 7 天後失效（有效期限：${inviteTime(accountInviteExpiresAt)}）。沒有帳號的人可以直接在邀請頁建立帳號。</p><p class="dialog-note"><b>連結只會顯示這一次，請現在複製。</b></p>`:'';
  const list=accountInvites.length?`<ul class="invite-links">${accountInvites.map(inv=>`<li><span><b>${e(inv.creatorName)}</b> · 建立於 ${inviteTime(inv.createdAt)} · 到期 ${inviteTime(inv.expiresAt)}</span>${button('撤銷','revoke-invite','text-button danger',`type="button" data-id="${e(inv.id)}" aria-label="撤銷 ${e(inv.creatorName)} 於 ${inviteTime(inv.createdAt)} 建立的連結" ${busy}`)}</li>`).join('')}</ul>`:'<p class="dialog-note">目前沒有可撤銷的邀請連結。</p>';
  showDialog('邀請旅伴，名字讓他自己填',`<p>對方用邀請連結登入或建立帳號後，再自行填寫這趟旅行使用的名字。</p>${link}<p class="form-error" role="alert">${e(accountInviteError)}</p><div class="form-actions">${button(icon('link')+'建立邀請連結','create-invite','primary',`type="button" ${busy}`)}</div><h3>尚未使用的邀請連結</h3>${list}`);
  if(keepFocus)returnFocus=keepFocus;
  if(focus)dialog.querySelector(focus)?.focus();
}
async function openAccountInviteDialog(){
  if(account.permissions.canInvite!==true){notify(INVITE_DENIED);return;}
  if(accountInviteBusy)return;
  accountInviteBusy=true;let ok=false;
  try{await assertAccountSession();clearAccountInviteLink();accountInviteError='';await loadAccountInvites();ok=true;}
  catch(err){notify(err.message);}
  finally{accountInviteBusy=false;}
  if(ok){accountInviteOpen=true;renderAccountInviteDialog('[data-action="create-invite"]');}
}
async function createAccountInvite(){
  if(account.permissions.canInvite!==true){notify(INVITE_DENIED);return;}
  if(accountInviteBusy||!accountInviteOpen)return;
  accountInviteBusy=true;renderAccountInviteDialog('[data-action="create-invite"]');let focus='[data-action="create-invite"]';
  try{
    await assertAccountSession();
    const result=await account.api(invitesPath(),{method:'POST',body:{expectedUserId:account.user.id}});
    accountInviteUrl=location.origin+result.urlPath;accountInviteId=result.id;accountInviteExpiresAt=result.expiresAt;accountInviteError='';focus='#invite-url';
    try{await loadAccountInvites();}catch(err){notify(err.message);}
  }catch(err){if(err.status===409)accountInviteError=err.message;else notify(err.message);}
  finally{accountInviteBusy=false;if(accountInviteOpen&&dialog.open)renderAccountInviteDialog(focus);}
}
async function revokeAccountInvite(id){
  if(account.permissions.canInvite!==true){notify(INVITE_DENIED);return;}
  if(accountInviteBusy||!accountInviteOpen||!id)return;
  accountInviteBusy=true;renderAccountInviteDialog();
  try{
    await assertAccountSession();
    await account.api(`${invitesPath()}/${encodeURIComponent(id)}/revoke`,{method:'POST',body:{expectedUserId:account.user.id}});
    notify('邀請連結已撤銷');if(id===accountInviteId)clearAccountInviteLink();
  }catch(err){notify(err.message);}
  // Reload after success and after errors (for example a link used meanwhile), but never under a changed account.
  try{if(!accountSessionChanged)await loadAccountInvites();}catch(err){notify(err.message);}
  finally{accountInviteBusy=false;if(accountInviteOpen&&dialog.open)renderAccountInviteDialog('[data-action="create-invite"]');}
}
actions['create-invite']=()=>{void createAccountInvite();};
actions['revoke-invite']=id=>{void revokeAccountInvite(id);};
if(account)dialog.addEventListener('close',()=>{if(!accountInviteOpen)return;accountInviteOpen=false;clearAccountInviteLink();accountInviteError='';accountInvites=[];});
actions['account-retry']=()=>{if(studioDirty()){notify('繪本草稿仍在編輯器，請在繪本內重新按「儲存行程」。');return;}void commitAccount('旅行手冊已更新');};
actions['account-reload']=()=>{if((!saved||studioDirty()||dialogDirty)&&!confirm('重新載入會放棄尚未儲存的修改。請確認已匯出備份，是否繼續？'))return;saved=true;dialogDirty=false;location.reload();};
// Cross-device sync: every 3 s tell the server which field this device is editing, lock fields other devices are editing, and
// pick up a newer revision. A dirty studio keeps its draft; saving then merges it into the newer state (three-way, see saveStoryPlan).
let presenceBusy=false;
async function presenceTick(){
  if(!account||!studioMount||tab!=='schedule'||document.hidden||presenceBusy||accountSessionChanged)return;
  presenceBusy=true;
  try{
    const r=await account.api(`/api/trips/${account.trip.id}/presence`,{method:'PUT',body:{clientId:presenceClientId,field:presenceField}});
    studioMount?.setLocks(r.editors||[]);
    if(r.revision>account.trip.revision&&saved&&!accountSaving){
      const latest=await account.api(`/api/trips/${account.trip.id}`);
      if(latest.trip.revision>account.trip.revision&&saved&&!accountSaving){
        acceptAccountResult(latest);
        if(studioMount&&!studioDirty()){const plan=toStudio(state);if(studioMount.refresh(plan)){studioBasePlan=plan;studioBaseRevision=state.revision;}}
        if(!studioHost?.shadowRoot?.activeElement&&!studioDirty())render();
      }
    }
  }catch{}finally{presenceBusy=false;}
}
if(account)setInterval(presenceTick,3000);
actions['account-logout']=async()=>{if((!saved||studioDirty()||dialogDirty)&&!confirm('登出會放棄尚未儲存的修改，確定繼續？'))return;try{await account.api('/api/logout',{method:'POST',body:{}});saved=true;dialogDirty=false;location.href='/login';}catch(err){notify(err.message);}};
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
 try{const result=await account.api('/api/session');if(result.user?.id!==account.user.id||result.user?.role!==account.user.role){accountSessionChanged=true;if(expensePanel?.isDirty()||studioDirty()||dialogDirty||!saved){expensePanel?.lock('登入帳號已變更，分帳草稿不能由另一個帳號儲存。請匯出草稿，再重新登入。');saved=false;accountError='登入帳號已在其他分頁變更。這份未儲存草稿仍在此頁，請先匯出備份再重新整理。';render();}else location.reload();}}
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
