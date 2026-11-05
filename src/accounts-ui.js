import { illustration, logo } from './art.js';
import { animatedIllustration, setupSceneMotion, syncSceneMotion, sceneMotionSettings } from './scene-motion.js';
import { THEMES_KEY, escape as e, readStorage, isValidState, dateRange, normalizeParticipantName } from './model.js';

export const ENDPOINTS = {
  session: '/api/session', setup: '/api/setup', register: '/api/register', login: '/api/login', logout: '/api/logout',
  trips: '/api/trips', invites: '/api/invites', adminUsers: '/api/admin/users', adminTrips: '/api/admin/trips', adminAudit: '/api/admin/audit'
};
export const COVERS = {
  camp: { art: 'camp', label: '營地帳篷', tone: 'green' },
  mountain: { art: 'travel', label: '山間旅途', tone: 'peach' },
  lake: { art: 'camp', label: '湖畔水岸', tone: 'blue' },
  night: { art: 'night', label: '星空夜晚', tone: 'night' }
};
export const STATUSES = { planning: '規劃中', completed: '已完成' };
export const USERNAME_RE = /^[a-z][a-z0-9-]{2,31}$/;
const RESERVED_USERNAMES = new Set(['api', 'admin', 'setup', 'login', 'register', 'logout', 'demo', 'assets']);
const INVITE_PATH_RE = /^\/invite\/[0-9a-f]{64}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const toasts = document.querySelector('#toasts');

export class ApiError extends Error {
  constructor(message, status, data = null) { super(message); this.name = 'ApiError'; this.status = status; this.data = data; }
}

export async function api(path, { method = 'GET', body } = {}) {
  const init = { method, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
  if (method !== 'GET' && method !== 'HEAD') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  let response;
  try { response = await fetch(path, init); }
  catch { throw new ApiError('無法連線到本機伺服器。帳號資料需要連線才能讀取與儲存，請確認伺服器仍在執行。', 0); }
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const message = typeof data?.error === 'string' && data.error.trim() ? data.error : `伺服器回應錯誤（${response.status}）`;
    throw new ApiError(message, response.status, data);
  }
  return data ?? {};
}

export function parseRoute(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/';
  const dec = value => { try { return decodeURIComponent(value); } catch { return ''; } };
  if (path === '/') return { name: 'root' };
  if (['/setup', '/login', '/register', '/admin'].includes(path)) return { name: path.slice(1) };
  let m;
  if ((m = path.match(/^\/([^/]+)\/home$/))) return { name: 'home', slug: dec(m[1]) };
  if ((m = path.match(/^\/([^/]+)\/trips\/([^/]+)(\/go)?$/))) return { name: 'trip', slug: dec(m[1]), tripId: dec(m[2]), go: Boolean(m[3]) };
  if ((m = path.match(/^\/invite\/([^/]+)$/))) return { name: 'invite', token: m[1] };
  return { name: 'notfound' };
}

export const safeNext = value => (typeof value === 'string' && INVITE_PATH_RE.test(value) ? value : null);
export const homePath = user => `/${encodeURIComponent(user.username)}/home`;
export const tripPath = (user, id) => `/${encodeURIComponent(user.username)}/trips/${encodeURIComponent(id)}`;
export const coverOf = kind => COVERS[kind] || COVERS.camp;

export function fullDate(value) {
  if (!DATE_RE.test(String(value ?? ''))) return '日期未設定';
  const date = new Date(`${value}T12:00:00`);
  if (!Number.isFinite(+date)) return '日期未設定';
  return date.toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
}
export const dateSpan = (start, end) => (start === end ? fullDate(start) : `${fullDate(start)} – ${fullDate(end)}`);
function todayIso() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

export function validateAccount({ username, displayName, password, confirm }) {
  if (!USERNAME_RE.test(username)) return '帳號名稱需為 3–32 個字元：以小寫英文字母開頭，只能使用小寫英文字母、數字或連字號（-）。';
  if (RESERVED_USERNAMES.has(username)) return '這個帳號名稱是系統保留字，請換一個。';
  const name = normalizeParticipantName(displayName);
  if (!name || [...name].length > 30) return '請填寫 1–30 個字的顯示名稱。';
  if (password.length < 12 || password.length > 128) return '密碼長度需為 12–128 個字元。';
  if (password !== confirm) return '兩次輸入的密碼不一致。';
  return '';
}

export function validateTripCard(card) {
  if (!card.title || [...card.title].length > 100) return '請填寫旅行名稱（最多 100 個字）。';
  if ([...card.destination].length > 100) return '地點最多 100 個字。';
  if (!DATE_RE.test(card.startDate) || !DATE_RE.test(card.endDate)) return '請選擇開始與結束日期。';
  if (!dateRange(card.startDate, card.endDate).length) return '結束日不能早於開始日，而且一趟旅行最多 31 天。';
  if ([...card.description].length > 1000 || [...card.note].length > 1000) return '介紹與備註各最多 1000 個字。';
  if (!COVERS[card.coverKind]) return '請選擇封面插畫。';
  if (!STATUSES[card.status]) return '請選擇旅行狀態。';
  return '';
}

export function readLegacyHandbook(storage = { getItem: key => globalThis.localStorage.getItem(key) }) {
  let result;
  try { result = readStorage(storage); } catch { return { status: 'unavailable' }; }
  if (result.status !== 'ok') return { status: result.status };
  return { status: 'ok', state: result.state, legacy: Boolean(result.migratedFromLegacy) };
}

const icons = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"/>',
  pin: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m1-15a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="m14 5 5 5M4 20l5-1L21 7l-5-5L4 14v6Z"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
  book: '<path d="M12 6C8 3 4 4 2 5v15c3-1 7-1 10 1 3-2 7-2 10-1V5c-3-1-7-1-10 1Zm0 0v15"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  tent: '<path d="m3 20 9-16 9 16H3Zm5 0 4-8 4 8"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>'
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${icons[name] || icons.tent}</svg>`;
const initialOf = name => e([...String(name || '?').trim()][0] || '?');
const roleLabel = role => (role === 'admin' ? '管理員' : '一般成員');

let theme = 'light';
let pageClick = null;
const modal = { dirty: false, busy: false, returnFocus: null };
let toastTimer;

function go(url) { location.replace(url); }

function toast(message) {
  if (!toasts) return;
  clearTimeout(toastTimer);
  toasts.textContent = message;
  toasts.classList.add('visible');
  toastTimer = setTimeout(() => toasts.classList.remove('visible'), 4500);
}

function header(user, current = '') {
  const themeButton = `<button type="button" class="icon-button acct-theme" data-act="theme" aria-label="${theme === 'dark' ? '切換為淺色模式' : '切換為深色模式'}">${icon(theme === 'dark' ? 'sun' : 'moon')}</button>`;
  const cur = name => (current === name ? ' aria-current="page"' : '');
  const nav = user
    ? `<a href="${e(homePath(user))}"${cur('home')}>我的旅行</a>${user.role === 'admin' ? `<a href="/admin"${cur('admin')}>管理後台</a>` : ''}<span class="acct-user"><span class="avatar small yellow" aria-hidden="true">${initialOf(user.displayName)}</span><span class="acct-user-name"><b>${e(user.displayName)}</b><small>@${e(user.username)}</small></span></span>${themeButton}<button type="button" class="button small" data-act="logout">登出</button>`
    : themeButton;
  return `<header class="acct-topbar"><div class="acct-topbar-inner"><a class="brand" href="${user ? e(homePath(user)) : '/login'}" aria-label="日子拾光首頁">${logo()}<span>日子拾光<small>LITTLE MOMENTS</small></span></a><nav class="acct-nav" aria-label="帳號選單">${nav}</nav></div></header>`;
}

function footer() {
  return `<footer class="acct-footer"><p class="acct-footer-note">把日常摺進行囊，沿著喜歡的風，慢慢走成自己的故事。</p><details class="display-preferences"><summary>畫面偏好</summary>${sceneMotionSettings()}</details></footer>`;
}

const AUTH_ART_KINDS = ['travel', 'night'];
const AUTH_ART_KEY = 'ggc-auth-art-index';

function nextAuthArtKind() {
  let index = Math.floor(Math.random() * AUTH_ART_KINDS.length);
  try {
    const previous = Number.parseInt(sessionStorage.getItem(AUTH_ART_KEY), 10);
    if (Number.isInteger(previous)) index = (previous + 1 + Math.floor(Math.random() * (AUTH_ART_KINDS.length - 1))) % AUTH_ART_KINDS.length;
    sessionStorage.setItem(AUTH_ART_KEY, String(index));
  } catch {}
  return AUTH_ART_KINDS[index];
}

function shell(user, main, current = '') {
  return `${header(user, current)}<main id="main" class="acct-page" tabindex="-1">${main}</main>${footer()}`;
}

function errorBlock(err, retry = true) {
  const expired = err?.status === 401;
  return `<div class="acct-error" role="alert"><p>${e(expired ? '登入狀態已失效，請重新登入。' : err?.message || '發生未知錯誤。')}</p><div class="acct-actions">${expired ? '<a class="button primary" href="/login">重新登入</a>' : ''}${retry ? '<button type="button" class="button small" data-act="reload">重新整理</button>' : ''}</div></div>`;
}

function messagePage(user, { title, body, actions }) {
  document.title = `${title} · 日子拾光`;
  app.innerHTML = shell(user, `<section class="acct-message"><div class="acct-message-art">${illustration('night')}</div><div class="acct-message-copy"><h1>${e(title)}</h1><p>${e(body)}</p><div class="acct-actions">${actions}</div></div></section>`);
}

function permissionPage(user, body = '每個帳號只能查看自己的頁面。') {
  messagePage(user, { title: '沒有權限查看這個頁面', body, actions: `<a class="button primary" href="${e(homePath(user))}">回到我的旅行首頁</a>` });
}

function setTheme(next) {
  theme = next;
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEMES_KEY, theme); } catch {}
  for (const button of document.querySelectorAll('[data-act="theme"]')) {
    button.setAttribute('aria-label', theme === 'dark' ? '切換為淺色模式' : '切換為深色模式');
    button.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
  }
}

async function logout(button) {
  button.disabled = true;
  try { await api(ENDPOINTS.logout, { method: 'POST', body: {} }); location.href = '/login'; }
  catch (err) { button.disabled = false; toast(`登出失敗：${err.message}`); }
}

function openModal(title, body, bind) {
  modal.returnFocus = document.activeElement;
  modal.dirty = false;
  modal.busy = false;
  dialog.innerHTML = `<div class="dialog-heading"><h2 id="dialog-title">${e(title)}</h2><button type="button" class="icon-button" data-modal-close aria-label="關閉對話框">${icon('close')}</button></div><div class="dialog-content acct-dialog">${body}</div>`;
  dialog.showModal();
  bind?.(dialog);
  dialog.querySelector('.acct-dialog input:not([readonly]),.acct-dialog select:not([disabled]),.acct-dialog textarea')?.focus();
}
function requestClose() {
  if (modal.busy) return;
  if (modal.dirty && !confirm('表單裡還有尚未儲存的內容，確定要關閉並放棄嗎？')) return;
  closeModal();
}
function closeModal() {
  modal.dirty = false;
  modal.busy = false;
  if (dialog.open) dialog.close();
  dialog.innerHTML = '';
  if (modal.returnFocus?.isConnected) modal.returnFocus.focus();
}

function setupChrome() {
  setupSceneMotion();
  try { theme = localStorage.getItem(THEMES_KEY) === 'dark' ? 'dark' : 'light'; } catch { theme = 'light'; }
  document.documentElement.dataset.theme = theme;
  document.addEventListener('click', event => {
    const target = event.target.closest?.('[data-act]');
    if (target?.dataset.act === 'theme') return setTheme(theme === 'dark' ? 'light' : 'dark');
    if (target?.dataset.act === 'logout') return void logout(target);
    if (target?.dataset.act === 'reload') return location.reload();
    if (!dialog.contains(event.target)) pageClick?.(event);
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
  dialog.addEventListener('click', event => {
    if (event.target === dialog || event.target.closest('[data-modal-close]')) requestClose();
  });
  const markDirty = event => { if (!event.target.closest('[data-no-dirty]')) modal.dirty = true; };
  dialog.addEventListener('input', markDirty);
  dialog.addEventListener('change', markDirty);
  window.addEventListener('beforeunload', event => {
    if (dialog.open && (modal.dirty || modal.busy)) { event.preventDefault(); event.returnValue = ''; }
  });
}

function setBusy(form, busy, label = '') {
  modal.busy = busy && form.closest('dialog') !== null;
  form.setAttribute('aria-busy', String(busy));
  const submit = form.querySelector('[type=submit]');
  if (submit) {
    if (!submit.dataset.label) submit.dataset.label = submit.textContent;
    submit.disabled = busy;
    submit.textContent = busy ? label : submit.dataset.label;
  }
  for (const el of form.querySelectorAll('[data-modal-close]')) el.disabled = busy;
}
function showFormError(form, message) {
  const box = form.querySelector('.form-error');
  box.textContent = message;
  if (message) box.focus();
}

function field({ id, label, type = 'text', value = '', help = '', attrs = '', wide = false }) {
  const helpId = help ? `${id}-help` : '';
  const described = helpId ? `aria-describedby="${helpId}"` : '';
  const input = type === 'textarea'
    ? `<textarea id="${id}" name="${id}" rows="3" ${described} ${attrs}>${e(value)}</textarea>`
    : `<input id="${id}" name="${id}" type="${type}" value="${e(value)}" ${described} ${attrs}>`;
  return `<div class="field${wide ? ' acct-wide' : ''}"><label for="${id}">${e(label)}</label>${input}${help ? `<small class="help" id="${helpId}">${e(help)}</small>` : ''}</div>`;
}
function selectField({ id, label, options, value, help = '', attrs = '', wide = false }) {
  const helpId = help ? `${id}-help` : '';
  return `<div class="field${wide ? ' acct-wide' : ''}"><label for="${id}">${e(label)}</label><select id="${id}" name="${id}" ${helpId ? `aria-describedby="${helpId}"` : ''} ${attrs}>${options.map(([v, l]) => `<option value="${e(v)}"${v === value ? ' selected' : ''}>${e(l)}</option>`).join('')}</select>${help ? `<small class="help" id="${helpId}">${e(help)}</small>` : ''}</div>`;
}
const formError = () => '<p class="form-error" role="alert" tabindex="-1"></p>';

function renderAuth(kind) {
  const next = safeNext(new URLSearchParams(location.search).get('next'));
  const nextQuery = next ? `?next=${encodeURIComponent(next)}` : '';
  const copy = {
    setup: { title: '建立第一個管理員帳號', eyebrow: 'FIRST SETUP', intro: '這台本機伺服器還沒有任何帳號。第一個建立的帳號會成為管理員，之後旅伴們再各自註冊自己的帳號。', submit: '建立管理員帳號', endpoint: ENDPOINTS.setup },
    register: { title: '註冊旅伴帳號', eyebrow: 'JOIN THE CREW', intro: '每位旅伴使用自己的帳號，旅行首頁只會顯示你建立或加入的旅行。', submit: '註冊並登入', endpoint: ENDPOINTS.register },
    login: { title: '登入日子拾光', eyebrow: 'WELCOME BACK', intro: '登入後就能打開你的旅行手冊，和旅伴一起規劃。', submit: '登入', endpoint: ENDPOINTS.login }
  }[kind];
  const artKind = nextAuthArtKind();
  document.title = kind === 'login' ? '登入 · 日子拾光' : `${copy.title} · 日子拾光`;
  const accountFields = kind === 'login'
    ? field({ id: 'auth-username', label: '帳號名稱', attrs: 'required autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32"' })
      + field({ id: 'auth-password', label: '密碼', type: 'password', attrs: 'required autocomplete="current-password" maxlength="128"' })
    : field({ id: 'auth-username', label: '帳號名稱（網址用）', help: '3–32 個字元，小寫英文字母開頭，可用小寫英文字母、數字或連字號，例如 xiao-an。會出現在你的首頁網址 /帳號名稱/home。', attrs: 'required autocomplete="username" autocapitalize="none" spellcheck="false" minlength="3" maxlength="32"' })
      + field({ id: 'auth-display', label: '顯示名稱', help: '旅伴看到的名字，最多 30 個字，可以使用中文。', attrs: 'required autocomplete="nickname" maxlength="30"' })
      + field({ id: 'auth-password', label: '密碼', type: 'password', help: '12–128 個字元。', attrs: 'required autocomplete="new-password" minlength="12" maxlength="128"' })
      + field({ id: 'auth-confirm', label: '再次輸入密碼', type: 'password', attrs: 'required autocomplete="new-password" minlength="12" maxlength="128"' });
  const links = kind === 'login'
    ? `<p class="help">還沒有帳號？<a class="text-link" href="/register${e(nextQuery)}">註冊旅伴帳號</a></p>`
    : kind === 'register' ? `<p class="help">已經有帳號了？<a class="text-link" href="/login${e(nextQuery)}">前往登入</a></p>` : '';
  const nextNote = next ? `<p class="notice">${icon('info')}<span>完成後會帶你回到旅行邀請頁。</span></p>` : '';
  app.innerHTML = shell(null, `<section class="acct-auth"><div class="acct-auth-art acct-auth-art--${artKind}">${animatedIllustration(artKind, { preserveAspectRatio: 'xMidYMax meet', transparentBackground: true, fullFrame: true, hideSun: artKind === 'travel' })}</div><div class="acct-auth-copy"><span class="eyebrow">${copy.eyebrow}</span><h1>${e(copy.title)}</h1><p>${e(copy.intro)}</p>${nextNote}<form class="acct-form" novalidate>${accountFields}${formError()}<button class="button primary full" type="submit">${e(copy.submit)}</button></form>${links}</div></section>`);
  const form = app.querySelector('form');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (form.getAttribute('aria-busy') === 'true') return;
    const usernameInput = form.elements['auth-username'];
    const username = usernameInput.value.trim().toLowerCase();
    usernameInput.value = username;
    const password = form.elements['auth-password'].value;
    let body;
    if (kind === 'login') {
      if (!username || !password) return showFormError(form, '請輸入帳號名稱與密碼。');
      if (password.length > 128) return showFormError(form, '密碼最多 128 個字元。');
      body = { username, password };
    } else {
      const displayName = form.elements['auth-display'].value;
      const problem = validateAccount({ username, displayName, password, confirm: form.elements['auth-confirm'].value });
      if (problem) return showFormError(form, problem);
      body = { username, displayName: normalizeParticipantName(displayName), password };
    }
    showFormError(form, '');
    setBusy(form, true, '處理中…');
    try {
      const { user } = await api(copy.endpoint, { method: 'POST', body });
      for (const input of form.querySelectorAll('input[type=password]')) input.value = '';
      location.href = next || (user ? homePath(user) : '/');
    } catch (err) {
      setBusy(form, false);
      showFormError(form, err.message);
    }
  });
}

function tripCard(trip, user) {
  const cover = coverOf(trip.coverKind);
  const status = STATUSES[trip.status] ? trip.status : 'planning';
  const open = tripPath(user, trip.id);
  return `<article class="acct-trip-card" data-trip-id="${e(trip.id)}">
    <div class="acct-trip-art tone-${cover.tone}">${illustration(cover.art)}<span class="tag acct-status status-${status}">${e(STATUSES[status])}</span></div>
    <div class="acct-trip-body">
      <h3><a href="${e(open)}">${e(trip.title || '未命名旅行')}</a></h3>
      <dl class="acct-trip-meta">
        <div><dt>${icon('pin')}<span>地點</span></dt><dd>${e(trip.destination || '尚未填寫地點')}</dd></div>
        <div><dt>${icon('calendar')}<span>日期</span></dt><dd>${e(dateSpan(trip.startDate, trip.endDate))}</dd></div>
        <div><dt>${icon('people')}<span>建立者</span></dt><dd>${e(trip.ownerName || '未知')}${trip.ownerUsername ? ` <small>@${e(trip.ownerUsername)}</small>` : ''} · ${e(Number.isFinite(trip.memberCount) ? trip.memberCount : 0)} 位旅伴</dd></div>
        <div><dt>${icon('book')}<span>狀態</span></dt><dd>${e(STATUSES[status])}${trip.canEdit ? '' : ' · 僅可檢視卡片'}</dd></div>
      </dl>
      <div class="acct-actions"><a class="button primary small" data-action="acct-open-trip" href="${e(open)}">開啟旅行手冊 ${icon('arrow')}</a>${trip.canEdit ? `<button type="button" class="button small" data-action="acct-edit-trip" data-id="${e(trip.id)}">${icon('edit')} 編輯卡片</button>` : ''}${trip.canDelete === true ? `<button type="button" class="button small danger" data-action="acct-delete-trip" data-id="${e(trip.id)}">刪除旅行</button>` : ''}</div>
    </div>
  </article>`;
}

function cardFromForm(form) {
  const v = name => String(form.elements[name]?.value ?? '');
  return {
    title: v('trip-title').trim(), destination: v('trip-destination').trim(), startDate: v('trip-start'), endDate: v('trip-end'),
    description: v('trip-description').trim(), note: v('trip-note').trim(), coverKind: v('trip-cover'), status: v('trip-status')
  };
}

function openTripDialog({ mode, trip = {}, legacyState = null, sourceLabel = '', onDone, user }) {
  const today = todayIso();
  const d = {
    title: trip.title || '', destination: trip.destination || '', startDate: trip.startDate || '', endDate: trip.endDate || '',
    description: trip.description || '', note: trip.note || '', coverKind: COVERS[trip.coverKind] ? trip.coverKind : 'camp',
    status: STATUSES[trip.status] ? trip.status : (trip.endDate && trip.endDate < today ? 'completed' : 'planning')
  };
  const imported = mode === 'import';
  const title = mode === 'edit' ? '編輯旅行卡片' : imported ? '匯入成新的旅行' : '新增旅行';
  const intro = mode === 'edit'
    ? '修改旅行卡片資訊。若更改日期，手冊裡的行程與料理會依「第幾天」對應移到新日期，內容都會保留。'
    : imported
      ? `會把${sourceLabel}複製成一趟新的帳號旅行，原本的資料不會被修改或刪除。日期沿用原手冊，避免行程對不上日子。`
      : '過去的旅行也可以補記：狀態選「已完成」就會收進回憶區。建立後不會自動放入範例內容。';
  const body = `<p class="dialog-note">${e(intro)}</p><form class="acct-form" data-form="acct-trip" novalidate><div class="form-grid">
    ${field({ id: 'trip-title', label: '旅行名稱', value: d.title, attrs: 'required maxlength="100"', wide: true })}
    ${field({ id: 'trip-destination', label: '地點', value: d.destination, attrs: 'maxlength="100"', wide: true })}
    ${field({ id: 'trip-start', label: '開始日期', type: 'date', value: d.startDate, attrs: `required${imported ? ' readonly' : ''}` })}
    ${field({ id: 'trip-end', label: '結束日期', type: 'date', value: d.endDate, attrs: `required${imported ? ' readonly' : ''}`, help: '一趟最多 31 天。' })}
    ${field({ id: 'trip-description', label: '旅行介紹', type: 'textarea', value: d.description, attrs: 'maxlength="1000"', wide: true })}
    ${field({ id: 'trip-note', label: '給旅伴的備註', type: 'textarea', value: d.note, attrs: 'maxlength="1000"', wide: true })}
    ${selectField({ id: 'trip-cover', label: '封面插畫', value: d.coverKind, options: Object.entries(COVERS).map(([k, c]) => [k, c.label]) })}
    ${selectField({ id: 'trip-status', label: '旅行狀態', value: d.status, options: [['planning', '規劃中（還沒出發）'], ['completed', '已完成（收進回憶）']] })}
  </div>${formError()}<div class="form-actions"><button type="button" class="button quiet" data-modal-close>取消</button><button type="submit" class="button primary">${mode === 'edit' ? '儲存卡片' : imported ? '確認匯入' : '建立旅行'}</button></div></form>`;
  openModal(title, body, root => {
    const form = root.querySelector('form');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (form.getAttribute('aria-busy') === 'true') return;
      const card = cardFromForm(form);
      const problem = validateTripCard(card);
      if (problem) return showFormError(form, problem);
      showFormError(form, '');
      setBusy(form, true, '儲存中…');
      try {
        const active = await api(ENDPOINTS.session);
        if (active.user?.id !== user.id) throw new ApiError('登入帳號已變更，請先複製需要的文字，再重新登入原帳號。', 409);
        if (mode === 'edit') await api(`${ENDPOINTS.trips}/${encodeURIComponent(trip.id)}`, { method: 'PATCH', body: { revision: trip.revision, expectedUserId: user.id, ...card } });
        else await api(ENDPOINTS.trips, { method: 'POST', body: imported ? { ...card, expectedUserId: user.id, legacyState: structuredClone(legacyState) } : { ...card, expectedUserId: user.id } });
        setBusy(form, false);
        closeModal();
        toast(mode === 'edit' ? '旅行卡片已更新' : imported ? '已匯入成新的旅行，原本的資料保持不變' : '旅行已建立');
        await onDone?.();
      } catch (err) {
        setBusy(form, false);
        showFormError(form, err.status === 409
          ? `這張卡片剛被其他人修改過（${err.message}）。你填的內容仍保留在表單中，請先複製需要的文字，再關閉並重新整理。`
          : `尚未儲存：${err.message}`);
      }
    });
  });
}

function openDeleteTripDialog({ trip, user, onDone }) {
  if (trip.canDelete !== true) return;
  openModal('刪除旅行', `<div class="acct-delete-explain"><p>確定刪除「<b>${e(trip.title)}</b>」？</p><p>這張卡片與整趟旅行將從所有旅伴的首頁移除，原邀請連結也會失效。旅伴帳號不受影響；旅行內容保留於資料庫。</p></div><form class="acct-form" data-form="acct-delete-trip" novalidate>${field({ id: 'delete-trip-confirm', label: '輸入旅行名稱以確認', help: trip.title, attrs: 'required autocomplete="off" spellcheck="false" maxlength="200"' })}${formError()}<div class="form-actions"><button type="button" class="button quiet" data-modal-close>取消</button><button type="submit" class="button danger" disabled>確認刪除旅行</button></div></form>`, root => {
    const form = root.querySelector('form');
    const input = form.elements['delete-trip-confirm'];
    const submit = form.querySelector('[type=submit]');
    const update = () => { submit.disabled = input.value !== trip.title || form.getAttribute('aria-busy') === 'true'; };
    input.addEventListener('input', update);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (form.getAttribute('aria-busy') === 'true') return;
      if (input.value !== trip.title) return showFormError(form, '旅行名稱不一致，尚未刪除。');
      showFormError(form, '');
      setBusy(form, true, '刪除中…');
      try {
        const active = await api(ENDPOINTS.session);
        if (active.user?.id !== user.id || active.user?.role !== user.role) throw new ApiError('登入帳號或權限已變更，請重新登入。', 403);
        await api(`${ENDPOINTS.trips}/${encodeURIComponent(trip.id)}/delete`, { method: 'POST', body: { expectedUserId: user.id, revision: trip.revision, confirmTitle: input.value } });
        setBusy(form, false);
        closeModal();
        toast('旅行已刪除');
        await onDone?.();
      } catch (err) {
        setBusy(form, false);
        update();
        showFormError(form, `尚未刪除：${err.message}${err.status === 409 ? ' 請關閉視窗並重新整理，再確認最新的旅行內容。' : ''}`);
      }
    });
  });
}

async function renderHome(user, route) {
  if (!user) return go('/login');
  if (route.slug !== user.username) return permissionPage(user, '這是別人的旅行首頁。每個帳號只能看到自己的首頁，請回到你自己的首頁。');
  document.title = `${user.displayName} 的旅行 · 日子拾光`;
  let filter = 'all', trips = null, loadError = null;

  const section = (status, list) => `<section class="acct-trip-section" aria-labelledby="sec-${status}"><h2 id="sec-${status}">${status === 'planning' ? '規劃中的旅行' : '已完成的回憶'}<span class="count-bubble">${list.length}</span></h2>${list.length ? `<div class="acct-trip-grid">${list.map(t => tripCard(t, user)).join('')}</div>` : `<p class="empty">${status === 'planning' ? '目前沒有規劃中的旅行。' : '還沒有已完成的旅行。補記過去的旅行時，狀態選「已完成」就會出現在這裡。'}</p>`}</section>`;
  const listHtml = () => {
    if (loadError) return errorBlock(loadError);
    if (!trips) return '<p class="acct-loading" role="status">正在載入你的旅行…</p>';
    if (!trips.length) return `<div class="empty acct-empty">${icon('tent')}<h3>還沒有任何旅行</h3><p>按「新增旅行」建立第一趟。已經去過的旅行也可以補記，狀態選「已完成」就會收進回憶區。這裡不會自動放入範例旅行。</p></div>`;
    const planning = trips.filter(t => t.status !== 'completed').sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
    const completed = trips.filter(t => t.status === 'completed').sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)));
    const tabs = [['all', '全部', trips.length], ['planning', '規劃中', planning.length], ['completed', '已完成', completed.length]];
    return `<div class="acct-filter"><div class="segmented" role="group" aria-label="依狀態篩選旅行">${tabs.map(([k, l, n]) => `<button type="button" data-action="acct-filter" data-filter="${k}" aria-pressed="${filter === k}">${l}<span>${n}</span></button>`).join('')}</div></div>${filter !== 'completed' ? section('planning', planning) : ''}${filter !== 'planning' ? section('completed', completed) : ''}`;
  };
  const paint = () => { const box = app.querySelector('#trip-list'); if (box) box.innerHTML = listHtml(); };
  const load = async () => {
    loadError = null;
    try {
      const data = await api(ENDPOINTS.trips);
      const list = Array.isArray(data.trips) ? data.trips : [];
      trips = user.role === 'admin' ? list.filter(t => t.ownerId === user.id || t.isMember === true) : list;
    } catch (err) { loadError = err; }
    paint();
  };

  app.innerHTML = shell(user, `<section class="hero hero-home acct-hero"><div class="hero-copy"><span class="eyebrow">MY LITTLE MOMENTS</span><h1>${e(user.displayName)} 的旅行手帳</h1><p>把平凡的日子，留成喜歡的回憶。</p><div class="acct-actions"><button type="button" class="button primary" data-action="acct-new-trip">${icon('plus')} 新增旅行</button><button type="button" class="button" data-action="acct-import-file" hidden>${icon('upload')} 從 JSON 備份檔匯入</button><input type="file" accept="application/json,.json" class="visually-hidden" data-file-input hidden tabindex="-1" aria-label="選擇要匯入的 JSON 備份檔"></div></div><div class="hero-art">${animatedIllustration('camp')}</div></section><div id="trip-list" class="acct-trip-list" aria-live="polite"></div>`, 'home');
  syncSceneMotion();
  paint();

  pageClick = event => {
    const target = event.target.closest('button[data-action]');
    if (!target || target.disabled) return;
    const action = target.dataset.action;
    if (action === 'acct-filter') { filter = target.dataset.filter; paint(); app.querySelector(`[data-filter="${filter}"]`)?.focus(); }
    else if (action === 'acct-new-trip') openTripDialog({ mode: 'create', onDone: load, user });
    else if (action === 'acct-edit-trip') { const trip = trips?.find(t => String(t.id) === target.dataset.id); if (trip?.canEdit) openTripDialog({ mode: 'edit', trip, onDone: load, user }); }
    else if (action === 'acct-delete-trip') { const trip = trips?.find(t => String(t.id) === target.dataset.id); if (trip) openDeleteTripDialog({ trip, user, onDone: load }); }
    else if (action === 'acct-import-file') app.querySelector('[data-file-input]').click();
  };
  const fileInput = app.querySelector('[data-file-input]');
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > 1024 * 1024) return toast('檔案太大，備份檔最多 1 MB，沒有匯入任何資料。');
    let parsed;
    try { parsed = JSON.parse(await file.text()); } catch { return toast('這不是有效的 JSON 檔案，沒有匯入任何資料。'); }
    if (!isValidState(parsed)) return toast('無法辨識這個備份檔的旅行手冊格式，沒有匯入任何資料。');
    openTripDialog({ mode: 'import', trip: parsed.trip, legacyState: parsed, sourceLabel: `備份檔「${file.name}」`, onDone: load, user });
  });
  await load();
}

function renderTripError(user, err) {
  if (err.status === 401) return go('/login');
  const denied = err.status === 403 || err.status === 404;
  const title = err.status === 403 ? '你沒有這趟旅行的權限' : err.status === 404 ? '找不到這趟旅行' : '旅行手冊暫時無法載入';
  messagePage(user, { title, body: denied ? '這趟旅行可能不存在，或你尚未受邀加入。請向召集人索取邀請連結。' : err.message, actions: `<a class="button primary" href="${e(homePath(user))}">回到我的旅行首頁</a>${denied ? '' : '<button type="button" class="button" data-act="reload">重新整理</button>'}` });
}

async function renderInvite(user, route) {
  if (!TOKEN_RE.test(route.token)) return messagePage(user, { title: '邀請連結格式不正確', body: '請確認連結是否完整複製，或向召集人重新索取邀請。', actions: user ? `<a class="button primary" href="${e(homePath(user))}">回到我的旅行首頁</a>` : '<a class="button primary" href="/login">前往登入</a>' });
  const invitePath = `/invite/${route.token}`;
  if (!user) return go(`/login?next=${encodeURIComponent(invitePath)}`);
  document.title = '旅行邀請 · 日子拾光';
  app.innerHTML = shell(user, `<div class="invite-page acct-invite"><div class="invite-card"><div class="invite-art">${illustration('camp')}</div><div class="invite-content"><p class="acct-loading" role="status">正在讀取邀請…</p></div></div></div>`);
  const content = app.querySelector('.invite-content');
  let info;
  try { info = await api(`${ENDPOINTS.invites}/${encodeURIComponent(route.token)}`); }
  catch (err) {
    if (err.status === 401) return go(`/login?next=${encodeURIComponent(invitePath)}`);
    content.innerHTML = `<h1>${err.status === 404 || err.status === 410 ? '邀請連結無效或已過期' : '無法讀取邀請'}</h1>${errorBlock(err, !err.status || err.status >= 500)}<a class="button" href="${e(homePath(user))}">回到我的旅行首頁</a>`;
    return;
  }
  const summary = `<span class="eyebrow">YOU'RE INVITED</span><h1>${e(info.title || '一趟旅行')}</h1><p class="invite-date">${icon('calendar')}${e(dateSpan(info.startDate, info.endDate))}</p><p class="invite-date">${icon('pin')}${e(info.destination || '地點尚未填寫')}</p>`;
  if (info.alreadyMember) {
    content.innerHTML = `${summary}<p class="invite-intro">你已經是這趟旅行的成員了，可以從旅行首頁打開手冊。</p><a class="button primary" href="${e(homePath(user))}">回到我的旅行首頁</a>`;
    return;
  }
  content.innerHTML = `${summary}<p class="invite-intro">你會以自己的帳號 <b>${e(user.displayName)}</b>（@${e(user.username)}）加入。請填寫你在這趟旅行裡的稱呼與角色；無法選擇或冒用其他旅伴的身分。</p><form class="acct-form" data-form="acct-join" novalidate>${field({ id: 'join-name', label: '你在這趟旅行的名字', value: user.displayName, attrs: 'required maxlength="30" autocomplete="nickname"', help: '最多 30 個字，不可和小隊裡其他人同名。' })}${field({ id: 'join-role', label: '小隊角色（選填）', attrs: 'maxlength="60"', help: '例如：咖啡擔當、營火守護者。' })}${formError()}<button type="submit" class="button primary full">加入這趟旅行</button></form>`;
  const form = content.querySelector('form');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (form.getAttribute('aria-busy') === 'true') return;
    const name = form.elements['join-name'].value.trim();
    const role = form.elements['join-role'].value.trim();
    if (!name || [...name].length > 30) return showFormError(form, '請填寫 1–30 個字的名字。');
    if ([...role].length > 60) return showFormError(form, '小隊角色最多 60 個字。');
    showFormError(form, '');
    setBusy(form, true, '加入中…');
    try {
      const { tripId } = await api(`${ENDPOINTS.invites}/${encodeURIComponent(route.token)}/join`, { method: 'POST', body: { name, role } });
      location.href = tripPath(user, tripId);
    } catch (err) {
      setBusy(form, false);
      showFormError(form, err.message);
    }
  });
}

async function renderAdmin(user) {
  if (!user) return go('/login');
  if (user.role !== 'admin') return permissionPage(user, '管理後台只開放給管理員。');
  document.title = '管理後台 · 日子拾光';
  let users = null, events = null, trips = null, errors = {};
  app.innerHTML = shell(user, `<div class="acct-admin"><header class="acct-admin-head"><span class="eyebrow">ADMIN</span><h1>管理後台</h1><p class="help">管理這台本機伺服器上的帳號、旅行與操作紀錄。</p></header><section id="admin-stats" aria-label="統計"></section><section aria-labelledby="admin-users-title"><h2 id="admin-users-title">帳號列表</h2><div id="admin-users"></div></section><section aria-labelledby="admin-trips-title"><h2 id="admin-trips-title">所有旅行</h2><div id="admin-trips"></div></section><section aria-labelledby="admin-audit-title"><h2 id="admin-audit-title">操作紀錄</h2><div id="admin-audit"></div></section></div>`, 'admin');
  const loading = '<p class="acct-loading" role="status">載入中…</p>';
  const memberRole = () => users?.find(u => u.role !== 'admin')?.role || 'member';
  const count = value => e(Number.isFinite(value) ? value : 0);

  const userRow = u => {
    const self = u.id === user.id;
    return `<li class="acct-user-row${u.deleted ? ' is-deleted' : ''}" data-user-id="${e(u.id)}"><div class="acct-user-info"><span class="avatar small ${u.role === 'admin' ? 'yellow' : 'blue'}" aria-hidden="true">${initialOf(u.displayName)}</span><div><b>${e(u.displayName)}</b>${self ? ' <span class="acct-pill">你</span>' : ''}<small>@${e(u.username)} · ${roleLabel(u.role)} · ${u.deleted ? '已刪除' : '使用中'} · ${count(u.tripCount)} 趟旅行</small></div></div><div class="acct-actions"><button type="button" class="button small" data-action="acct-edit-user" data-id="${e(u.id)}"${u.deleted ? ' disabled' : ''}>${icon('edit')} 編輯帳號</button><button type="button" class="button small danger" data-action="acct-delete-user" data-id="${e(u.id)}"${self || u.deleted ? ' disabled' : ''}>刪除帳號</button></div>${self ? '<small class="help acct-row-note">不能刪除自己的帳號，也不能移除自己的管理員權限。</small>' : ''}</li>`;
  };
  const auditRow = ev => {
    const at = new Date(ev.at);
    return `<li><time datetime="${e(ev.at)}">${e(Number.isFinite(+at) ? at.toLocaleString('zh-TW', { hour12: false }) : ev.at)}</time><span><b>${e(ev.actor || '系統')}</b> · ${e(ev.action)}${ev.target ? ` · <span class="acct-audit-target">${e(ev.target)}</span>` : ''}</span></li>`;
  };
  const paint = () => {
    const stats = users && [['帳號總數', users.length], ['使用中', users.filter(u => !u.deleted).length], ['已刪除', users.filter(u => u.deleted).length], ['管理員', users.filter(u => u.role === 'admin' && !u.deleted).length], ['旅行總數', trips ? trips.length : '—']];
    app.querySelector('#admin-stats').innerHTML = stats ? `<dl class="acct-stats">${stats.map(([l, n]) => `<div><dt>${l}</dt><dd>${e(n)}</dd></div>`).join('')}</dl>` : '';
    app.querySelector('#admin-users').innerHTML = errors.users ? errorBlock(errors.users) : !users ? loading : users.length ? `<ul class="acct-user-list">${users.map(userRow).join('')}</ul>` : '<p class="empty">還沒有任何帳號。</p>';
    app.querySelector('#admin-trips').innerHTML = errors.trips ? errorBlock(errors.trips) : !trips ? loading : trips.length ? `<div class="acct-trip-grid">${trips.map(t => tripCard(t, user)).join('')}</div>` : '<p class="empty">目前沒有任何旅行。</p>';
    app.querySelector('#admin-audit').innerHTML = errors.audit ? errorBlock(errors.audit) : !events ? loading : events.length ? `<ol class="acct-audit">${events.slice(0, 200).map(auditRow).join('')}</ol>` : '<p class="empty">目前還沒有操作紀錄。</p>';
  };
  const load = async () => {
    const [u, a, t] = await Promise.allSettled([api(ENDPOINTS.adminUsers), api(ENDPOINTS.adminAudit), api(ENDPOINTS.trips)]);
    errors = {};
    if (u.status === 'fulfilled') users = Array.isArray(u.value.users) ? u.value.users : []; else errors.users = u.reason;
    if (a.status === 'fulfilled') events = Array.isArray(a.value.events) ? a.value.events : []; else errors.audit = a.reason;
    if (t.status === 'fulfilled') trips = Array.isArray(t.value.trips) ? t.value.trips : []; else errors.trips = t.reason;
    paint();
  };

  const openEditUser = target => {
    const self = target.id === user.id;
    const roles = [[memberRole(), '一般成員'], ['admin', '管理員']];
    openModal('編輯帳號', `<p class="dialog-note">帳號名稱 @${e(target.username)} 無法修改。</p><form class="acct-form" data-form="acct-user" novalidate>${field({ id: 'user-display', label: '顯示名稱', value: target.displayName, attrs: 'required maxlength="30"' })}${selectField({ id: 'user-role', label: '角色', value: target.role === 'admin' ? 'admin' : memberRole(), options: roles, attrs: self ? 'disabled' : '', help: self ? '不能移除自己的管理員權限。' : '管理員可以管理所有帳號與旅行。' })}${formError()}<div class="form-actions"><button type="button" class="button quiet" data-modal-close>取消</button><button type="submit" class="button primary">儲存</button></div></form>`, root => {
      const form = root.querySelector('form');
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (form.getAttribute('aria-busy') === 'true') return;
        const displayName = normalizeParticipantName(form.elements['user-display'].value);
        const role = self ? target.role : form.elements['user-role'].value;
        if (!displayName || [...displayName].length > 30) return showFormError(form, '請填寫 1–30 個字的顯示名稱。');
        showFormError(form, '');
        setBusy(form, true, '儲存中…');
        try {
          await api(`${ENDPOINTS.adminUsers}/${encodeURIComponent(target.id)}`, { method: 'PATCH', body: { displayName, role } });
          setBusy(form, false); closeModal(); toast('帳號資料已更新'); await load();
        } catch (err) { setBusy(form, false); showFormError(form, `尚未儲存：${err.message}`); }
      });
    });
  };

  const openDeleteUser = target => {
    if (target.id === user.id) return;
    openModal('刪除帳號', `<div class="acct-delete-explain"><p>你即將刪除 <b>${e(target.displayName)}</b>（@${e(target.username)}）。刪除後：</p><ul><li>帳號會被標記為「已刪除」（軟刪除），無法再登入，紀錄仍會保留。</li><li>這個帳號所有登入中的工作階段會立即被登出。</li><li>他建立的共享旅行會轉移給管理員；他在旅行裡負責的分工會改成「待分配」。</li></ul></div><form class="acct-form" data-form="acct-delete-user" novalidate>${field({ id: 'delete-confirm', label: `請輸入帳號名稱「${target.username}」以確認`, attrs: 'required autocomplete="off" autocapitalize="none" spellcheck="false"' })}${formError()}<div class="form-actions"><button type="button" class="button quiet" data-modal-close>取消</button><button type="submit" class="button danger" disabled>確認刪除帳號</button></div></form>`, root => {
      const form = root.querySelector('form');
      const input = form.elements['delete-confirm'];
      const submit = form.querySelector('[type=submit]');
      input.addEventListener('input', () => { submit.disabled = input.value !== target.username || form.getAttribute('aria-busy') === 'true'; });
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (form.getAttribute('aria-busy') === 'true') return;
        if (input.value !== target.username) return showFormError(form, '輸入的帳號名稱不一致。');
        showFormError(form, '');
        setBusy(form, true, '刪除中…');
        try {
          await api(`${ENDPOINTS.adminUsers}/${encodeURIComponent(target.id)}/delete`, { method: 'POST', body: { confirmUsername: input.value } });
          setBusy(form, false); closeModal(); toast(`已刪除帳號 @${target.username}`); await load();
        } catch (err) { setBusy(form, false); submit.disabled = input.value !== target.username; showFormError(form, `尚未刪除：${err.message}`); }
      });
    });
  };

  pageClick = event => {
    const target = event.target.closest('button[data-action]');
    if (!target || target.disabled) return;
    const find = list => list?.find(x => String(x.id) === target.dataset.id);
    if (target.dataset.action === 'acct-edit-user') { const u = find(users); if (u && !u.deleted) openEditUser(u); }
    else if (target.dataset.action === 'acct-delete-user') { const u = find(users); if (u && !u.deleted && u.id !== user.id) openDeleteUser(u); }
    else if (target.dataset.action === 'acct-edit-trip') { const t = find(trips); if (t?.canEdit) openTripDialog({ mode: 'edit', trip: t, onDone: load, user }); }
    else if (target.dataset.action === 'acct-delete-trip') { const t = find(trips); if (t) openDeleteTripDialog({ trip: t, user, onDone: load }); }
  };
  paint();
  await load();
}

async function main() {
  if (/^\/demo(?:\/|$)/.test(location.pathname)) { await import('./app.js'); return; }
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  const route = parseRoute(location.pathname);
  app.innerHTML = '<main id="main" class="acct-page"><p class="acct-loading" role="status">正在確認登入狀態…</p></main>';

  let session;
  try { session = await api(ENDPOINTS.session); }
  catch (err) {
    setupChrome();
    return messagePage(null, { title: '暫時無法確認登入狀態', body: `${err.message} 為了安全，目前不會顯示任何帳號資料。`, actions: '<button type="button" class="button primary" data-act="reload">重新整理</button><a class="button" href="/login">前往登入頁</a>' });
  }
  const user = session.user || null;
  if(user&&route.name!=='trip'){let checking=false,last=0;const check=async()=>{if(checking||Date.now()-last<1000)return;checking=true;last=Date.now();try{const now=await api(ENDPOINTS.session);if(now.user?.id!==user.id||now.user?.role!==user.role)go('/login');}catch{app.innerHTML='<main id="main" class="acct-page"><h1>無法確認目前帳號</h1><p>為保護旅行內容，請重新連線並整理頁面。</p><a class="button primary" href="/login">前往登入</a></main>';}finally{checking=false;}};window.addEventListener('focus',()=>void check());document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void check();});}
  if (session.needsSetup && route.name !== 'setup') return go('/setup');

  if (route.name === 'trip') {
    if (!user) return go('/login');
    if (route.slug !== user.username) { setupChrome(); return permissionPage(user, '旅行網址必須使用你自己的帳號名稱。請從你的首頁打開旅行。'); }
    let detail;
    try { detail = await api(`${ENDPOINTS.trips}/${encodeURIComponent(route.tripId)}`); }
    catch (err) { setupChrome(); return renderTripError(user, err); }
    globalThis.campingAccountContext = { user, ...detail, api };
    await import('./app.js');
    return;
  }

  setupChrome();
  if (route.name === 'root') return go(user ? homePath(user) : '/login');
  if (route.name === 'setup') return session.needsSetup ? renderAuth('setup') : go(user ? homePath(user) : '/login');
  if (route.name === 'login' || route.name === 'register') {
    if (user) return go(safeNext(new URLSearchParams(location.search).get('next')) || homePath(user));
    return renderAuth(route.name);
  }
  if (route.name === 'home') return renderHome(user, route);
  if (route.name === 'invite') return renderInvite(user, route);
  if (route.name === 'admin') return renderAdmin(user);
  return messagePage(user, { title: '找不到這個頁面', body: '網址可能打錯了，或這個頁面已經不存在。', actions: `<a class="button primary" href="${user ? e(homePath(user)) : '/login'}">${user ? '回到我的旅行首頁' : '前往登入'}</a>` });
}

await main();
