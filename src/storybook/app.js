// Studio editor, mounted into a ShadowRoot by mountStudio(). Adapted from demos/storybook-trip-studio/app.js
// (editor-ux-1 + storybook-scene-6). Integration rules: the plan always comes from the parent, nothing is written
// to localStorage except the layout width preference, there are no samples, imports or local-storage recovery,
// and saving always goes through the parent onSave callback.
import * as ModelModule from './model.js';
import { StoryArt } from './artwork.js';
import { StudioRenderer } from './renderer.js';
import { StudioExport } from './exporter.js';
import { STUDIO_TEMPLATE } from './template.js';
import { renderJournal } from './journal.js';
// Bundled as text (Bun text loader) so the ShadowRoot can adopt it; the website's own CSS never applies inside.
import STUDIO_CSS from './style.css' with { type: 'text' };

const M = ModelModule.StudioModel || ModelModule.default || ModelModule;
// The editor always opens in the wide layout; a width dragged with the splitter is remembered under a new key.
const WIDTH_KEY = 'storybook-editor-width-v2';
const HIDDEN_KEY = 'storybook-editor-hidden-v2';
const MAX_PREVIEW_SIDE = 16000;
const MAX_PREVIEW_PIXELS = 24e6;
// A poster taller than this is not drawn: the canvas would be rejected or silently truncated by the browser.
const MAX_LAYOUT_HEIGHT = 32000;
const COLORS = ['#83accc', '#dd775f', '#69a9a0', '#e7b84d', '#a58bc4', '#8fae6b'];
const GROUP_LABELS = { home: '住家', shop: '商店', camp: '露營' };
const STOP_HINTS = {
  shopping: '例：先到門口集合', 'gear-pickup': '例：預約編號、取件人', 'gear-return': '例：歸還期限',
  'passenger-pickup': '例：乘客姓名、人數、集合點', 'passenger-dropoff': '例：乘客姓名',
  'car-rental': '例：租車預約編號', 'car-return': '例：還車前加滿油', waypoint: '備註'
};
const clone = x => JSON.parse(JSON.stringify(x));
const label = v => (v && typeof v === 'object') ? (v.label || '') : String(v ?? '');
const lines = v => v.split('\n').map(s => s.trim()).filter(Boolean);
/** Meal events are owned by the website menu: ids are 'm-<n>' or hashed 'm_<hash>'. Must match the adapter. */
const MEAL_ID_RE = /^m[-_]/;
export const isMealEvent = e => typeof e?.id === 'string' && MEAL_ID_RE.test(e.id);

export function mountStudio(host, options = {}) {
  if (!host || host.nodeType !== 1) throw new Error('mountStudio 需要一個 DOM 元素作為容器');
  const onSave = typeof options.onSave === 'function' ? options.onSave : null;
  const onDirty = typeof options.onDirty === 'function' ? options.onDirty : null;
  let canEdit = options.canEdit !== false;
  let canDelete = options.canDelete !== false;
  const onFocusField = typeof options.onFocusField === 'function' ? options.onFocusField : null;
  // Fields other people are editing right now: key `${dayIndex}|${controlId}` -> name. Locked controls are disabled.
  let locks = new Map();
  const lockKey = id => `${day}|${id}`;
  function applyLocks() {
    if (destroyed || !studio) return;
    for (const c of studio.querySelectorAll('input[id],select[id],textarea[id],button[id]')) {
      const by = locks.get(lockKey(c.id));
      const box = c.parentElement;
      if (by && root.activeElement !== c) {
        if (!c.dataset.lockedBy) c.dataset.lockedBy = c.disabled ? 'disabled' : 'free';
        c.disabled = true;
        if (box) box.dataset.lockedBy = by;
      } else if (c.dataset.lockedBy) {
        if (c.dataset.lockedBy === 'free') c.disabled = false;
        delete c.dataset.lockedBy;
        if (box) delete box.dataset.lockedBy;
      }
    }
  }
  const getPeople = () => { try { return (typeof options.getPeople === 'function' ? options.getPeople() : []).filter(n => typeof n === 'string' && n); } catch { return []; } };

  const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
  root.replaceChildren();
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(STUDIO_CSS);
  root.adoptedStyleSheets = [sheet];
  root.append(document.createRange().createContextualFragment(STUDIO_TEMPLATE));
  const studio = root.querySelector('[data-studio-root]');
  const $ = id => root.getElementById(id);
  const all = sel => [...root.querySelectorAll(sel)];

  // ---------- lifecycle bookkeeping ----------
  let destroyed = false, suspended = false;
  const cleanups = [];
  function listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  }
  function watchMedia(query, fn) {
    const mq = matchMedia(query);
    if (mq.addEventListener) { mq.addEventListener('change', fn); cleanups.push(() => mq.removeEventListener('change', fn)); }
    else { mq.addListener(fn); cleanups.push(() => mq.removeListener(fn)); }
    return mq;
  }

  // ---------- state ----------
  let plan = null, savedJson = null, layout = null, layoutError = '';
  let day = 0, placeId = null, t = 0, revision = 0;
  let ui = null, selectedRoute = 0, selectedEvent = 0;
  const undoStack = [], redoStack = [];
  let lastHistoryKey = '', lastHistoryAt = 0;
  let playing = false, userPaused = false, resumeOnVisible = false, raf = 0, base = 0;
  let busy = false, saving = false, controller = null, cache = null, currentFp = null;
  let zoomActual = false, editorHidden = false, previewScaled = false;
  // The host page reads this attribute to show its side panel only while the editor is collapsed.
  const syncHostEditor = () => host.toggleAttribute('data-editor-hidden', editorHidden);
  let statusText = '', statusKind = '';
  const openStops = new Set();
  const invalid = new Set();
  const transientUrls = new Set();
  const reduced = watchMedia('(prefers-reduced-motion: reduce)', () => { if (reduced.matches) pause(); else if (!userPaused) play(); });

  // Trash icon drawn like the website's icons (src/app.js icon()): 24px grid, 1.7 round stroke, currentColor.
  // One-line text box that grows with its content instead of showing a big empty area.
  function grow(box) { if (!box || !box.isConnected) return; box.style.height = 'auto'; box.style.height = box.scrollHeight + 2 + 'px'; }
  function trashIcon() {
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '19', height: '19', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(k, v);
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6m4-6v6');
    svg.append(path);
    return svg;
  }
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else if (k === 'value') n.value = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c) n.append(c);
    return n;
  }
  function option(value, text, data) {
    const o = el('option', { value, text });
    if (data) Object.assign(o.dataset, data);
    return o;
  }
  function field(id, text, control) { return el('div', {}, el('label', { for: id, text }), control); }

  function notice(text, kind = '') {
    statusText = text; statusKind = kind;
    const m = $('message');
    m.textContent = text;
    m.className = 'message' + (kind ? ' ' + kind : '');
    const local = $('editorNotice');
    local.textContent = text;
    local.className = 'message editor-notice' + (kind ? ' ' + kind : '');
    local.hidden = !text;
  }
  function setInvalid(node, bad, message = '') {
    if (!node || !node.id) return;
    node.setAttribute('aria-invalid', bad ? 'true' : 'false');
    if (bad) invalid.add(node.id); else invalid.delete(node.id);
    const id = node.id + '-error';
    let hint = $(id);
    if (bad && !hint) { hint = el('p', { id, class: 'field-error' }); node.after(hint); }
    if (hint) { hint.textContent = message || '請檢查這個欄位。'; hint.hidden = !bad; }
    const described = new Set((node.getAttribute('aria-describedby') || '').split(' ').filter(Boolean));
    if (bad) described.add(id); else described.delete(id);
    if (described.size) node.setAttribute('aria-describedby', [...described].join(' ')); else node.removeAttribute('aria-describedby');
    if (plan) updateDirty();
  }
  function resetInvalid() {
    for (const id of [...invalid]) { const n = $(id); if (n) setInvalid(n, false); }
    invalid.clear();
    if (plan) updateDirty();
  }

  const curDay = () => plan.days[day] || null;
  const placeName = id => (plan.places.find(p => p.id === id) || {}).name || (id ? '（已移除的地點）' : '未指定');
  const vehicleName = id => (plan.vehicles.find(v => v.id === id) || {}).name || '（已移除的車輛）';
  const dayLabel = (d, i) => { let s = d.date; try { s = M.dateText(d.date); } catch (_) {} return `第 ${i + 1} 天・${s}`; };
  const eventTitle = e => e.title || '未命名活動';

  // ---------- permission guards ----------
  function requireEdit() {
    if (canEdit) return true;
    notice('你目前只能檢視這份行程，無法修改。', 'error');
    return false;
  }
  // Vehicles and meal-linked events belong to the shared trip: a collaborator without delete rights may not drop them.
  function keptIds(p) {
    return {
      vehicles: new Set(p.vehicles.map(v => v.id)),
      meals: new Set(p.days.flatMap(d => d.events.filter(isMealEvent).map(e => e.id)))
    };
  }
  function removalAllowed(next) {
    if (canDelete) return true;
    const before = keptIds(plan), after = keptIds(next);
    for (const id of before.vehicles) if (!after.vehicles.has(id)) return false;
    for (const id of before.meals) if (!after.meals.has(id)) return false;
    return true;
  }

  function commit(mutate, { rebuild = false, source = null } = {}) {
    if (busy || saving || !plan || !requireEdit()) return false;
    if (rebuild && [...invalid].some(id => id !== source?.id)) { flushDraft(); return false; }
    let next;
    try {
      const draft = clone(plan);
      const replaced = mutate(draft);
      next = M.validate(replaced || draft);
      const order = p => JSON.stringify(p.days.map(d => d.events.map(e => e.time + '\u0001' + eventTitle(e))));
      if (order(replaced || draft) !== order(next)) rebuild = true;
      if (rebuild && [...invalid].some(id => id !== source?.id)) { flushDraft(); return false; }
    } catch (e) {
      setInvalid(source, true, (e.message || '資料不正確').replace(/^[A-Za-z][^：]*：/, ''));
      notice('未套用：' + (e && e.message ? e.message : '資料不正確'), 'error');
      return false;
    }
    if (!removalAllowed(next)) {
      notice('未套用：你沒有刪除車輛或菜單餐點的權限。', 'error');
      return false;
    }
    setInvalid(source, false);
    if (JSON.stringify(plan) !== JSON.stringify(next)) remember(plan, source && source.id);
    plan = next;
    if (rebuild) resetInvalid();
    if (statusKind === 'error' && !invalid.size) notice('');
    changed(rebuild);
    return true;
  }

  function changed(rebuild) {
    revision++;
    invalidateDownloads();
    day = Math.max(0, Math.min(day, plan.days.length - 1));
    if (!plan.places.some(p => p.id === placeId)) placeId = plan.places.length ? plan.places[0].id : null;
    relayout();
    updateDirty();
    scheduleAutoSave();
    renderItinerary();
    if (rebuild) renderEditor(); else syncDerived();
    refreshSummaries();
    if (ui) ui.sync();
    updateExportInfo();
    checkCache();
  }

  function flushDraft() {
    const a = root.activeElement;
    if (a && $('editorPanel').contains(a)) a.blur();
    if (!invalid.size) return true;
    const first = $([...invalid][0]);
    notice(`有 ${invalid.size} 個欄位未通過檢查，海報與輸出仍是上一次有效的內容。請先修正標示的欄位。`, 'error');
    if (first) { if (ui) ui.reveal(first); first.focus(); }
    return false;
  }

  // ---------- poster ----------
  function relayout() {
    layoutError = '';
    const c = $('poster');
    try {
      layout = StudioRenderer.layout(plan);
      if (!(layout.height > 0) || layout.height > MAX_LAYOUT_HEIGHT) {
        throw new Error(`行程內容太長，海報高度會超過 ${MAX_LAYOUT_HEIGHT} 像素。`);
      }
    } catch (e) {
      layout = null;
      layoutError = (e && e.message ? e.message : '海報排版失敗') + ' 文字版行程與 JSON 仍保留完整內容，請縮短說明、拆分天數或減少活動後再試；資料不會被截斷或刪除。';
      showFallback();
      return;
    }
    const scale = Math.min(1, MAX_PREVIEW_SIDE / layout.height, Math.sqrt(MAX_PREVIEW_PIXELS / (layout.width * layout.height)));
    const w = Math.max(1, Math.floor(layout.width * scale)), h = Math.max(1, Math.floor(layout.height * scale));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    previewScaled = scale < 1;
    $('previewNote').hidden = !previewScaled;
    c.style.aspectRatio = `${layout.width} / ${layout.height}`; $('posterWrap').style.setProperty('--ar', String(layout.width / layout.height));
    c.style.width = zoomActual ? layout.width + 'px' : '';
    c.setAttribute('aria-label', `${plan.title} 旅程海報，共 ${plan.days.length} 天；文字版請展開下方「文字版完整行程」`);
    showFallback();
    drawNow();
  }
  function showFallback() {
    const box = $('renderFallback');
    box.textContent = layoutError;
    box.hidden = !layoutError;
    $('posterScroller').hidden = !!layoutError;
    if (layoutError) { pause(); $('itinerary').open = true; }
  }
  function drawNow() {
    if (!layout) return null;
    try { return StudioRenderer.draw($('poster'), plan, layout, t); }
    catch (e) { layoutError = '海報繪製失敗：' + (e && e.message ? e.message : e) + ' 文字版行程仍完整。'; showFallback(); return null; }
  }

  function duration() { return StudioRenderer.duration || 16; }
  function updateSeek() {
    $('seek').value = String(t);
    $('seekTime').textContent = t.toFixed(1) + 's';
  }
  function frame(now) {
    if (!playing) return;
    t = ((now - base) / 1000) % duration();
    drawNow();
    updateSeek();
    raf = requestAnimationFrame(frame);
  }
  // The canvas poster is no longer shown (the journal view replaces it), so its animation never runs.
  const POSTER_ON = false;
  function play() {
    if (!POSTER_ON) return;
    if (playing || destroyed || suspended || document.hidden || !layout) return;
    playing = true;
    base = performance.now() - t * 1000;
    raf = requestAnimationFrame(frame);
    updatePlayButton();
  }
  function pause() {
    playing = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    updatePlayButton();
  }
  function updatePlayButton() {
    const b = $('play');
    b.textContent = playing ? '暫停' : '播放';
    b.setAttribute('aria-pressed', playing ? 'true' : 'false');
    b.setAttribute('aria-label', playing ? '暫停動畫' : '播放動畫');
  }

  // ---------- saving ----------
  // An invalid field holds text that is not in the plan yet: that is unsaved work too, so the host guard must see it.
  const isDirty = () => !!plan && (invalid.size > 0 || JSON.stringify(plan) !== savedJson);
  function updateDirty() {
    const dirty = isDirty();
    const s = $('saveStatus');
    s.classList.toggle('dirty', dirty || saving);
    if (saving) s.textContent = '正在儲存…';
    else if (!canEdit) s.textContent = '檢視模式';
    else if (invalid.size) s.textContent = `有 ${invalid.size} 個欄位未通過檢查`;
    else if (dirty) s.textContent = '自動儲存中…';
    else s.textContent = '已儲存';
    s.title = s.textContent;
    $('printDraft').hidden = !(dirty || saving);
    if (onDirty) { try { onDirty(dirty || saving); } catch (_) { /* a parent handler must not break editing */ } }
    updateButtons();
  }
  // Autosave: every committed change is saved a moment later. It never blurs the field being typed in.
  let autoTimer = 0;
  cleanups.push(() => clearTimeout(autoTimer));
  function scheduleAutoSave(delay = 700) {
    clearTimeout(autoTimer);
    if (destroyed || !canEdit || !onSave) return;
    autoTimer = setTimeout(runAutoSave, delay);
  }
  async function runAutoSave() {
    if (destroyed || !plan || !canEdit || !onSave || invalid.size || !isDirty()) return;
    if (busy || saving) { scheduleAutoSave(500); return; }
    const ok = await save({ auto: true });
    if (ok && !destroyed && !invalid.size && isDirty()) scheduleAutoSave(200);
  }
  async function save({ auto = false } = {}) {
    if (busy || saving || !plan || !requireEdit() || (!auto && !flushDraft())) return false;
    if (!onSave) { notice('這個畫面沒有提供儲存功能。', 'error'); return false; }
    const submitted = clone(plan);
    const submittedJson = JSON.stringify(plan);
    // The host re-renders the page after a save, which drops focus; remember where the caret was.
    const keep = auto ? root.activeElement : null;
    const caret = keep && typeof keep.selectionStart === 'number' ? [keep.selectionStart, keep.selectionEnd] : null;
    saving = true;
    updateDirty();
    if (!auto) notice('正在儲存行程…');
    let result;
    try {
      result = await onSave(submitted);
    } catch (e) {
      saving = false;
      if (destroyed) return false;
      updateDirty();
      notice('儲存失敗，未儲存的內容都還留著：' + (e && e.message ? e.message : e) + '（可用「匯出 JSON」備份草稿）', 'error');
      return false;
    }
    saving = false;
    if (destroyed) return false;
    const ok = result === true || (result && typeof result === 'object' && result.ok === true);
    if (!ok) {
      updateDirty();
      const message = result && typeof result === 'object' && result.message ? result.message : '伺服器沒有接受這次儲存。';
      notice('未儲存：' + message + ' 你的內容仍保留，可再試一次或用「匯出 JSON」備份草稿。', 'error');
      return false;
    }
    if (auto) markSavedAuto(result && typeof result === 'object' ? result.plan : undefined, submittedJson);
    else markSaved(result && typeof result === 'object' ? result.plan : undefined);
    if (!auto) notice('已儲存行程。', 'ok');
    else if (statusKind === 'error' && !invalid.size) notice('');
    if (keep && keep.isConnected && root.activeElement !== keep) {
      try { keep.focus({ preventScroll: true }); if (caret) keep.setSelectionRange(caret[0], caret[1]); } catch (_) { /* element may not support selection */ }
    }
    return true;
  }
  // Autosave result: only rebuild the editor when the server changed the plan and nothing was typed meanwhile.
  function markSavedAuto(next, submittedJson) {
    if (destroyed) return;
    let validated = null;
    if (next !== undefined && next !== null) { try { validated = M.validate(next); } catch (_) { validated = null; } }
    const nextJson = validated ? JSON.stringify(validated) : submittedJson;
    savedJson = nextJson;
    if (validated && nextJson !== submittedJson && JSON.stringify(plan) === submittedJson) {
      plan = validated; resetInvalid(); changed(true); return;
    }
    updateDirty();
  }
  // Accepts the server's own normalized plan when given, so the dirty baseline matches what was actually stored.
  function markSaved(next) {
    if (destroyed) return;
    if (next !== undefined && next !== null) {
      try {
        const validated = M.validate(next);
        plan = validated;
        savedJson = JSON.stringify(validated);
        day = Math.max(0, Math.min(day, plan.days.length - 1));
        resetInvalid();
        changed(true);
        return;
      } catch (e) {
        notice('伺服器回傳的行程無法解析，畫面保留你目前的內容：' + (e && e.message ? e.message : e), 'error');
      }
    }
    savedJson = JSON.stringify(plan);
    updateDirty();
  }

  // ---------- downloads ----------
  function sanitizeName(s) {
    let n = String(s || '').normalize('NFC')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[\\/:*?"<>|｜]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.-]+|[\s.-]+$/g, '');
    n = Array.from(n).slice(0, 60).join('').replace(/[\s.]+$/, '');
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n)) n = '_' + n;
    return n || 'storybook-trip';
  }
  function triggerDownload(url, name) {
    const a = el('a', { href: url, download: name });
    a.style.display = 'none';
    studio.append(a);
    a.click();
    a.remove();
  }
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    transientUrls.add(url);
    triggerDownload(url, name);
    const timer = setTimeout(() => { if (transientUrls.delete(url)) URL.revokeObjectURL(url); }, 30000);
    cleanups.push(() => clearTimeout(timer));
  }
  function invalidateDownloads() {
    if (cache && cache.url) { URL.revokeObjectURL(cache.url); cache.url = null; }
    for (const u of transientUrls) URL.revokeObjectURL(u);
    transientUrls.clear();
    currentFp = null;
    updateButtons();
  }
  const cacheValid = () => !!(cache && currentFp && cache.fp === currentFp);
  async function checkCache() {
    const rev = revision;
    let fp;
    try { fp = await M.fingerprint(plan); } catch (_) { return; }
    if (destroyed || rev !== revision) return;
    currentFp = fp;
    if (cacheValid() && !cache.url) cache.url = URL.createObjectURL(cache.result.blob);
    updateButtons();
  }
  function settingsSafe() {
    if (!plan) return { allowed: false, reason: '' };
    if (!layout) return { allowed: false, reason: layoutError };
    try { return StudioExport.settings(plan, layout); } catch (e) { return { allowed: false, reason: e.message }; }
  }
  function updateButtons() {
    const s = settingsSafe();
    const locked = busy || saving || !plan;
    $('editorFields').disabled = locked || !canEdit;
    $('generate').disabled = locked || !s.allowed;
    $('cancel').disabled = !busy;
    $('downloadGif').disabled = locked || !cacheValid() || !cache.url;
    $('downloadPng').disabled = locked || !layout;
    $('exportJson').disabled = locked;
    $('saveTrip').disabled = locked || !canEdit || !onSave;
    $('saveTrip').hidden = true; // autosave: there is no save button
    studio.querySelector('.stage').setAttribute('aria-busy', busy ? 'true' : 'false');
    $('undoEdit').disabled = locked || !canEdit || !undoStack.length;
    $('redoEdit').disabled = locked || !canEdit || !redoStack.length;
    all('.preview-target').forEach(b => { b.disabled = busy || saving; });
  }
  function updateExportInfo() {
    const s = settingsSafe();
    $('exportInfo').textContent = s.allowed
      ? `GIF ${s.width}×${s.height}・${s.frames || 400} 格・${s.duration || duration()} 秒循環`
      : (s.reason || '目前無法輸出 GIF');
    updateButtons();
  }

  async function generate() {
    if (busy || saving || !plan || !flushDraft()) return null;
    const s = settingsSafe();
    if (!s.allowed) { notice(s.reason || '目前無法輸出 GIF', 'error'); return null; }
    busy = true;
    const snapshot = plan;
    controller = new AbortController();
    const signal = controller.signal;
    const prog = $('progress');
    updateButtons();
    try {
      const fp = await M.fingerprint(snapshot);
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');
      currentFp = fp;
      if (cache && cache.fp === fp) {
        if (!cache.url) cache.url = URL.createObjectURL(cache.result.blob);
        notice('內容沒有變更，沿用剛才產生的 GIF。', 'ok');
        return cache.result;
      }
      prog.value = 0;
      notice('正在產生 GIF…（編輯暫停，可隨時取消）');
      const res = await StudioExport.generate(snapshot, {
        signal,
        onProgress: p => {
          const v = Math.max(0, Math.min(100, Number(p) || 0));
          prog.value = v;
          prog.setAttribute('aria-valuetext', Math.round(v) + '%');
        }
      });
      if (signal.aborted || destroyed) throw new DOMException('已取消', 'AbortError');
      if (cache && cache.url) URL.revokeObjectURL(cache.url);
      cache = { fp, result: res, url: URL.createObjectURL(res.blob) };
      prog.value = 100;
      notice(`GIF 完成：${res.width}×${res.height}，${(res.blob.size / 1048576).toFixed(1)} MB。`, 'ok');
      return res;
    } catch (e) {
      if (destroyed) return null;
      prog.value = 0;
      if ((e && e.name === 'AbortError') || signal.aborted) notice('已取消產生 GIF。');
      else notice('GIF 產生失敗：' + (e && e.message ? e.message : e), 'error');
      return null;
    } finally {
      busy = false;
      controller = null;
      if (!destroyed) updateButtons();
    }
  }

  // ---------- editor rendering ----------
  function setMax(id, n) { if (n) $(id).maxLength = n; }
  function fillSelect(sel, items, value) {
    sel.replaceChildren(...items);
    if (value !== undefined && value !== null) sel.value = value;
  }
  const placeOptions = () => plan.places.map(p => option(p.id, p.name, { placeId: p.id }));
  const vehicleOptions = () => plan.vehicles.map(v => option(v.id, v.name, { vehicleId: v.id }));

  function renderEditor() {
    const focusId = root.activeElement && root.activeElement.id;
    $('title').value = plan.title;
    $('headline').value = plan.headline;
    $('caption').value = plan.caption;
    $('startDate').value = plan.days.length ? plan.days[0].date : '';
    $('shopping').value = plan.shopping.join('\n');
    renderPlaces();
    renderVehicles();
    renderDay();
    refreshSummaries();
    if (ui) ui.sync();
    if (focusId && $(focusId) && root.activeElement !== $(focusId)) $(focusId).focus({ preventScroll: true });
  }

  function renderPlaces() {
    const has = plan.places.length > 0;
    $('noPlaces').hidden = has;
    $('placeFields').hidden = !has;
    $('placeArt').hidden = true;
    fillSelect($('placeSelect'), placeOptions(), placeId ?? undefined);
    const p = plan.places.find(x => x.id === placeId);
    $('placeName').value = p ? p.name : '';
    $('placeTemplate').value = p ? p.templateId : 'home';
    $('addPlace').disabled = plan.places.length >= (M.LIMITS.placesMax || 101);
    $('removePlace').disabled = !has;
  }

  function renderVehicles() {
    $('vehicleList').replaceChildren(...plan.vehicles.map((v, i) => {
      const name = el('input', { id: `vehicle-${i}-name`, value: v.name, maxlength: M.LIMITS.vehicleNameMax, autocomplete: 'off',
        oninput: e => { if (commit(d => { d.vehicles[i].name = e.target.value; }, { source: e.target })) refreshOptionLabels(); } });
      const color = el('input', { id: `vehicle-${i}-color`, type: 'color', value: (v.color || '#83accc').toLowerCase(), 'aria-label': `${v.name} 顏色`,
        oninput: e => commit(d => { d.vehicles[i].color = e.target.value; }, { source: e.target }) });
      const rm = el('button', { type: 'button', id: `removeVehicle-${i}`, class: 'danger icon trash', 'aria-label': `移除 ${v.name}`,
        disabled: !canDelete, title: canDelete ? '移除這台車' : '你沒有刪除車輛的權限', onclick: () => removeVehicle(i) }, trashIcon());
      return el('li', { class: 'vehicle' }, el('label', { for: name.id, class: 'sr', text: `第 ${i + 1} 台車名稱` }), color, name, rm);
    }));
    $('addVehicle').disabled = plan.vehicles.length >= (M.LIMITS.vehiclesMax || 1000);
  }

  function renderDay() {
    const d = curDay();
    fillSelect($('daySelect'), plan.days.map((x, i) => option(String(i), dayLabel(x, i))), String(day));
    $('addDay').disabled = plan.days.length >= (M.LIMITS.daysMax || 31);
    $('removeDay').disabled = plan.days.length <= 1;
    if (!d) return;
    $('dayTitle').value = d.title;
    $('dayDate').value = d.date;
    fillSelect($('dayLocation'), [option('', '未指定'), ...placeOptions()], d.locationId);
    $('dayRoutePosition').value = d.routePosition;
    $('dayArrival').value = d.arrivalLabel;
    renderEvents();
    renderRoutes();
    refreshSummaries();
    if (ui) ui.sync();
  }

  function renderEvents() {
    const d = curDay(), list = $('eventList');
    selectedEvent = Math.min(selectedEvent, d.events.length - 1);
    if (!d.events.length) list.replaceChildren(el('li', { class: 'empty', text: '這天留白也很好。按「新增活動」，安排第一件想做的事。' }));
    else list.replaceChildren(...d.events.map((ev, i) => {
      const p = `event-${i}`;
      const meal = isMealEvent(ev);
      const time = el('input', { id: `${p}-time`, type: 'time', step: '900', value: ev.time,
        onchange: e => { const title = curDay().events[i].title; if (commit(x => { x.days[day].events[i].time = e.target.value; }, { source: e.target })) { selectedEvent = curDay().events.findIndex(v => v.title === title && v.time === time.value); renderEvents(); } } });
      const title = el('input', { id: `${p}-title`, value: ev.title, maxlength: M.LIMITS.eventTitleMax, autocomplete: 'off',
        oninput: e => commit(x => { x.days[day].events[i].title = e.target.value; }, { source: e.target }) });
      const allowed = meal ? (M.MEAL_KINDS || []) : (M.ACTIVITY_KINDS || Object.keys(M.KINDS));
      const kindIds = allowed.includes(ev.kind) ? [...allowed] : [ev.kind, ...allowed];
      const kind = el('select', { id: `${p}-kind`, disabled: meal, title: meal ? '餐點插圖由網站的菜單決定' : '',
        onchange: e => commit(x => { x.days[day].events[i].kind = e.target.value; }, { source: e.target }) },
        kindIds.map(k => option(k, label(M.KINDS[k] || k))));
      kind.value = ev.kind;
      const notes = el('textarea', { id: `${p}-notes`, rows: 1, class: 'grow', maxlength: M.LIMITS.notesMax, placeholder: '餐點、要帶的東西，或想提醒旅伴的事',
        oninput: e => { grow(e.target); commit(x => { x.days[day].events[i].notes = e.target.value; }, { source: e.target }); } });
      queueMicrotask(() => grow(notes));
      notes.value = ev.notes;
      const canRemove = canDelete || !meal;
      return el('li', { class: 'entry' }, entryDetails('event', i,
        el('summary', { class: 'entry-summary' }, el('span', { id: `${p}-summary-time`, class: 'entry-time', text: ev.time }),
          el('span', { class: 'entry-title' }, el('strong', { id: `${p}-summary-title`, text: eventTitle(ev) }),
            meal ? el('span', { class: 'meal-badge', text: '餐點' }) : null,
            el('span', { id: `${p}-summary-meta`, class: 'entry-meta', text: label(M.KINDS[ev.kind]) }))),
        el('div', { class: 'entry-body' },
          el('div', { class: 'grid3' }, field(title.id, '想做什麼？', title), field(time.id, '幾點開始', time), field(kind.id, '搭配的插圖', kind)),
          field(notes.id, '活動備註（選填）', notes),
          meal ? el('p', { class: 'locked-note', text: '這個活動來自網站的菜單安排：插圖由菜單決定（儲存時以菜單為準），時間與備註可以改。複製出來的新活動不會連結到菜單。' }) : null,
          el('div', { class: 'route-actions' },
            el('button', { type: 'button', id: `copyEvent-${i}`, text: '複製活動', disabled: d.events.length >= M.LIMITS.eventsMax,
              onclick: () => {
                const copy = clone(curDay().events[i]);
                delete copy.id;
                if (commit(x => { x.days[day].events.splice(i + 1, 0, copy); }, { rebuild: true })) { selectedEvent = i + 1; renderEvents(); }
              } }),
            el('button', { type: 'button', id: `removeEvent-${i}`, class: 'danger icon trash', 'aria-label': `刪除活動 ${eventTitle(ev)}`,
              disabled: !canRemove, title: canRemove ? '刪除這個活動' : '菜單餐點需要刪除權限',
              onclick: () => commit(x => { x.days[day].events.splice(i, 1); }, { rebuild: true }) }, trashIcon())))));
    }));
    $('addEvent').disabled = d.events.length >= (M.LIMITS.eventsMax || 2000);
  }
  function entryDetails(type, index, summary, body) {
    const details = el('details', { id: `${type}-entry-${index}`, class: 'entry-details', open: (type === 'event' ? selectedEvent : selectedRoute) === index }, summary, body);
    summary.addEventListener('click', e => {
      if (!flushDraft()) { e.preventDefault(); return; }
      if (!details.open) {
        if (type === 'event') selectedEvent = index; else selectedRoute = index;
        details.closest('ol').querySelectorAll(':scope > li > details').forEach(d => { if (d !== details) d.open = false; });
      } else { if (type === 'event') selectedEvent = -1; else selectedRoute = -1; }
    });
    return details;
  }

  function renderRoutes() {
    const d = curDay(), list = $('routeList');
    selectedRoute = Math.min(selectedRoute, d.routes.length - 1);
    if (!d.routes.length) list.replaceChildren(el('li', { class: 'empty', text: plan.vehicles.length ? '這天不開車就不用填。需要移動時，新增一台車的路線。' : '還沒有車輛。先到「地點與車」新增車輛，才能安排路線。' }));
    else list.replaceChildren(...d.routes.map((r, i) => {
      const p = `route-${i}`;
      const veh = el('select', { id: `${p}-vehicle`,
        onchange: e => commit(x => { x.days[day].routes[i].vehicleId = e.target.value; }, { source: e.target, rebuild: true }) }, vehicleOptions());
      veh.value = r.vehicleId;
      for (const o of veh.options) o.disabled = o.value !== r.vehicleId && d.routes.some(other => other.vehicleId === o.value);
      const from = el('select', { id: `${p}-from`, onchange: e => commit(x => { x.days[day].routes[i].from = e.target.value; }, { source: e.target }) }, placeOptions());
      from.value = r.from;
      const to = el('select', { id: `${p}-to`, onchange: e => commit(x => { x.days[day].routes[i].to = e.target.value; }, { source: e.target }) }, placeOptions());
      to.value = r.to;
      const dep = el('input', { id: `${p}-departure`, type: 'time', step: '900', value: r.departure,
        onchange: e => commit(x => { x.days[day].routes[i].departure = e.target.value; }, { source: e.target }) });
      return el('li', { class: 'entry' }, entryDetails('route', i,
        el('summary', { class: 'entry-summary' }, el('span', { id: `${p}-summary-time`, class: 'entry-time', text: r.departure || '時間未填' }),
          el('span', { class: 'entry-title' }, el('strong', { id: `${p}-summary-title`, text: vehicleName(r.vehicleId) }),
            el('span', { id: `${p}-summary-meta`, class: 'entry-meta', text: routeOverview(r) }))),
        el('div', { class: 'entry-body' },
          // Compact route card: the four fields in one row; new places are added in the 地點與車 tab.
          el('div', { class: 'grid4' }, field(veh.id, '哪一台車', veh), field(dep.id, '幾點出發（可留空）', dep), field(from.id, '從哪裡出發', from), field(to.id, '最後到哪裡', to)),
          renderStops(r, i,
            el('button', { type: 'button', id: `removeRoute-${i}`, class: 'danger icon trash', title: '刪除這條路線', 'aria-label': `刪除 ${vehicleName(r.vehicleId)} 的路線`,
              onclick: () => { if (commit(x => { x.days[day].routes.splice(i, 1); }, { rebuild: true })) openStops.clear(); } }, trashIcon())))));
    }));
    $('addRoute').disabled = !plan.vehicles.length || d.routes.length >= Math.min(M.LIMITS.routesMax || 1000, plan.vehicles.length);
  }
  function routeOverview(r) { return `${placeName(r.from)} → ${placeName(r.to)} · ${r.stops.length ? r.stops.length + ' 個停靠點' : '直達'}`; }
  function refreshSummaries() {
    if (!plan || !curDay()) return;
    curDay().events.forEach((ev, i) => {
      for (const [suffix, value] of [['time', ev.time], ['title', eventTitle(ev)], ['meta', label(M.KINDS[ev.kind])]]) { const n = $(`event-${i}-summary-${suffix}`); if (n) n.textContent = value; }
    });
    curDay().routes.forEach((r, i) => {
      for (const [suffix, value] of [['time', r.departure || '時間未填'], ['title', vehicleName(r.vehicleId)], ['meta', routeOverview(r)]]) { const n = $(`route-${i}-summary-${suffix}`); if (n) n.textContent = value; }
      r.stops.forEach((st, j) => { const n = $(`stop-${i}-${j}-summary`); if (n) n.textContent = `${st.time || '時間未填'} · ${label(M.STOP_KINDS[st.kind])} · ${placeName(st.placeId)}`; });
    });
  }
  function placeField(select, title, assign) {
    const area = el('div', { class: 'place-field' }, field(select.id, title, select));
    const name = el('input', { id: select.id + '-new-name', maxlength: M.LIMITS.placeNameMax, autocomplete: 'off', placeholder: '例如：全家台北站前店' });
    const template = el('select', { id: select.id + '-new-template' }, M.TEMPLATES.map(t => option(t.id, t.label)));
    template.value = 'home';
    const inline = el('div', { class: 'inline-place', hidden: true }, field(name.id, '新地點名稱', name), field(template.id, '地點插圖', template));
    const add = el('button', { type: 'button', id: select.id + '-new', text: '＋ 新增地點', disabled: plan.places.length >= M.LIMITS.placesMax,
      onclick: () => { inline.hidden = false; add.hidden = true; name.focus(); } });
    inline.append(el('div', { class: 'row wrap' },
      el('button', { type: 'button', id: select.id + '-create', text: '新增並選用', onclick: () => {
        const id = M.nextId(plan.places, 'place');
        if (commit(x => { x.places.push({ id, name: name.value.trim(), templateId: template.value }); assign(x, id); }, { source: name, rebuild: true })) { const n = $(select.id); if (n) { if (ui) ui.reveal(n); n.focus(); } notice('已新增地點並套用到這條路線。', 'ok'); }
      } }),
      el('button', { type: 'button', text: '取消', onclick: () => { setInvalid(name, false); inline.hidden = true; name.value = ''; add.hidden = false; add.focus(); } })));
    area.append(add, inline);
    return area;
  }

  function renderStops(r, i, removeRoute = null) {
    const key = `${day}-${i}`;
    const stops = r.stops || [];
    const max = M.LIMITS.stopsMax || 6;
    const kinds = M.STOP_KINDS || { waypoint: '一般停靠' };
    const edit = fn => commit(x => { fn(x.days[day].routes[i].stops); }, { rebuild: true });
    const set = (j, k, v, src, rebuild) => commit(x => { x.days[day].routes[i].stops[j][k] = v; }, { source: src, rebuild });
    const items = stops.map((s, j) => {
      const p = `stop-${i}-${j}`;
      const kind = el('select', { id: `${p}-kind`, onchange: e => set(j, 'kind', e.target.value, e.target, true) },
        Object.entries(kinds).map(([k, v]) => option(k, label(v))));
      kind.value = s.kind;
      const place = el('select', { id: `${p}-place`, onchange: e => set(j, 'placeId', e.target.value, e.target) }, placeOptions());
      place.value = s.placeId;
      const time = el('input', { id: `${p}-time`, type: 'time', step: '900', value: s.time, onchange: e => set(j, 'time', e.target.value, e.target) });
      const list = el('textarea', { id: `${p}-items`, rows: 1, class: 'grow', placeholder: s.kind === 'shopping' ? '牛奶\n吐司' : s.kind.startsWith('passenger') ? '旅伴姓名（選填）' : '每行一項',
        oninput: e => { grow(e.target); set(j, 'items', lines(e.target.value), e.target); } });
      list.value = (s.items || []).join('\n');
      const notes = el('textarea', { id: `${p}-notes`, rows: 2, maxlength: M.LIMITS.stopNotesMax || 100, placeholder: STOP_HINTS[s.kind] || '備註',
        oninput: e => { grow(e.target); set(j, 'notes', e.target.value, e.target); } });
      notes.value = s.notes;
      // Compact stop: one row of fields, one-line growing text boxes, and trash icons (website icon style).
      const clear = (box, key, value, what) => el('button', { type: 'button', class: 'danger icon trash', title: `清除${what}`, 'aria-label': `清除第 ${j + 1} 站的${what}`, disabled: !box.value,
        onclick: () => { box.value = ''; grow(box); set(j, key, value, box); } }, trashIcon());
      const textRow = (box, title, key, value, what) => el('div', { class: 'stop-text' }, field(box.id, title, box), clear(box, key, value, what));
      const body = el('div', { class: 'entry-body' },
        el('div', { class: 'item-head' }, el('strong', { class: 'accent', text: `第 ${j + 1} 站` }),
          el('button', { type: 'button', id: `removeStop-${i}-${j}`, class: 'danger icon trash', title: '刪除這一站', 'aria-label': `刪除第 ${j + 1} 站`,
            onclick: () => edit(a => a.splice(j, 1)) }, trashIcon())),
        el('div', { class: 'grid3' }, field(kind.id, '任務', kind), field(time.id, '時間（選填）', time), field(place.id, '在哪裡停靠', place)),
        s.kind === 'shopping'
          ? el('div', { class: 'stop-auto' }, el('span', { class: 'stop-auto-label', text: '要買的品項（依本車乘客的採買分工）' }),
              el('p', { id: `${p}-items`, class: 'stop-auto-items', text: (s.items || []).length ? s.items.join('、') : '本車乘客目前沒有負責的採買品項' }),
              el('p', { class: 'hint', text: '到網站的採買清單調整負責人，品項會自動分配到該旅伴搭乘的車。' }))
          : s.kind.startsWith('passenger-') ? companionPicker(p, j, s, set)
          : textRow(list, stopItemsLabel(s.kind), 'items', [], '待辦清單'),
        textRow(notes, stopNotesLabel(s.kind), 'notes', '', '備註'));
      queueMicrotask(() => { if (s.kind !== 'shopping') grow(list); grow(notes); });
      const stopKey = `stop-${day}-${i}-${j}`;
      const details = el('details', { id: `stop-entry-${i}-${j}`, class: 'entry-details', open: !openStops.has('closed-' + stopKey) && (j === 0 || openStops.has(stopKey)),
        ontoggle: e => { if (!e.target.isConnected) return; if (e.target.open) { openStops.add(stopKey); openStops.delete('closed-' + stopKey); } else { openStops.delete(stopKey); openStops.add('closed-' + stopKey); } } },
        el('summary', { class: 'entry-summary' }, el('span', { class: 'entry-time', text: String(j + 1).padStart(2, '0') }),
          el('span', { class: 'entry-title', id: `stop-${i}-${j}-summary`, text: `${s.time || '時間未填'} · ${label(kinds[s.kind])} · ${placeName(s.placeId)}` })), body);
      details.firstElementChild.addEventListener('click', e => { if (!flushDraft()) e.preventDefault(); });
      return el('li', { class: 'stop-entry' }, details);
    });
    const actions = el('div', { class: 'route-actions' },
      el('button', { type: 'button', id: `addStop-${i}`, text: '新增途中任務', disabled: stops.length >= max || !plan.places.length,
        onclick: () => { openStops.delete('closed-' + key); addStop(i); } }), removeRoute);
    // No stops: only the action row, no empty-state text.
    if (!stops.length) return el('div', { id: `route-${i}-stops`, class: 'stops-compact' }, actions);
    return el('div', { id: `route-${i}-stops`, class: 'stops-compact' },
      el('details', { class: 'stops', open: !openStops.has('closed-' + key),
        ontoggle: e => { if (!e.target.isConnected) return; if (e.target.open) openStops.delete('closed-' + key); else openStops.add('closed-' + key); } },
        el('summary', { text: `途中任務（${stops.length}）` }), el('ol', { class: 'list' }, items)), actions);
  }

  function companionPicker(p, j, s, set) {
    const people = getPeople();
    const chosen = new Set(s.items || []);
    const names = [...people, ...[...chosen].filter(n => !people.includes(n))];
    const box = el('div', { id: `${p}-items`, class: 'companion-picker', role: 'group', 'aria-label': '旅伴名單（可多選）' });
    if (!names.length) box.append(el('p', { class: 'hint', text: '網站的夥伴名單還沒有人，請先在「夥伴」新增。' }));
    names.forEach((n, k) => {
      const cb = el('input', { type: 'checkbox', id: `${p}-who-${k}` });
      cb.checked = chosen.has(n);
      cb.onchange = () => {
        const cur = new Set(plan.days[day].routes[+p.split('-')[1]].stops[j].items || []);
        if (cb.checked) cur.add(n); else cur.delete(n);
        const arr = [...people, ...[...cur].filter(x => !people.includes(x))].filter(x => cur.has(x)).slice(0, 8);
        set(j, 'items', arr, cb);
      };
      box.append(el('label', { class: 'companion-chip', for: cb.id }, cb, el('span', { text: people.includes(n) ? n : n + '（已不在名單）' })));
    });
    return el('div', { class: 'stop-text' }, el('div', { class: 'field' }, el('span', { class: 'field-label', text: '旅伴名單（可多選，選填）' }), box));
  }

  function stopItemsLabel(kind) {
    if (kind === 'shopping') return '要買什麼？（每行一項）';
    if (kind.startsWith('gear-')) return kind === 'gear-return' ? '要歸還的裝備（每行一項）' : '要領取的裝備（每行一項）';
    if (kind.startsWith('passenger-')) return '旅伴名單（選填，每行一位）';
    if (kind.startsWith('car-')) return '取還車檢查清單（選填）';
    return '待辦清單（選填，每行一項）';
  }
  function stopNotesLabel(kind) {
    if (kind.startsWith('passenger-')) return '集合位置／接送提醒（選填）';
    if (kind.startsWith('gear-') || kind.startsWith('car-')) return '預約資訊／取還提醒（選填）';
    return '停靠備註（選填）';
  }
  function addStop(i) {
    const r = curDay().routes[i];
    const candidate = plan.places.find(p => p.id !== r.from && p.id !== r.to) || plan.places[0];
    if (!candidate) { notice('需要至少一個地點才能新增停靠點。', 'error'); return; }
    if (commit(x => { x.days[day].routes[i].stops.push({ placeId: candidate.id, kind: 'waypoint', time: '', items: [], notes: '' }); }, { rebuild: true })) { const n = $(`stop-${i}-${curDay().routes[i].stops.length - 1}-kind`); if (n) { if (ui) ui.reveal(n); n.focus(); } }
  }

  function syncDerived() {
    const active = root.activeElement;
    const ds = $('daySelect');
    plan.days.forEach((d, i) => { if (ds.options[i]) ds.options[i].textContent = dayLabel(d, i); });
    if (active !== $('startDate') && plan.days.length) $('startDate').value = plan.days[0].date;
    if (active !== $('dayDate') && curDay()) $('dayDate').value = curDay().date;
    refreshOptionLabels();
  }
  function refreshOptionLabels() {
    all('option[data-place-id]').forEach(o => { o.textContent = placeName(o.dataset.placeId); });
    all('option[data-vehicle-id]').forEach(o => { o.textContent = vehicleName(o.dataset.vehicleId); });
  }

  function placeRefs(id) {
    const refs = [];
    plan.days.forEach((d, i) => {
      if (d.locationId === id) refs.push(`第 ${i + 1} 天的所在地點`);
      d.routes.forEach(r => {
        if (r.from === id || r.to === id) refs.push(`第 ${i + 1} 天 ${vehicleName(r.vehicleId)} 的路線`);
        else if ((r.stops || []).some(s => s.placeId === id)) refs.push(`第 ${i + 1} 天 ${vehicleName(r.vehicleId)} 的途中任務`);
      });
    });
    return refs;
  }
  function removePlace() {
    const p = plan.places.find(x => x.id === placeId);
    if (!p) return;
    const refs = placeRefs(p.id);
    if (refs.length) { notice(`無法移除「${p.name}」：仍被 ${refs.join('、')} 使用。請先改掉這些設定。`, 'error'); return; }
    if (commit(d => { d.places = d.places.filter(x => x.id !== p.id); }, { rebuild: true })) notice(`已移除地點「${p.name}」。`, 'ok');
  }
  function addPlace() {
    if (!flushDraft()) return;
    const id = M.nextId(plan.places, 'place');
    const tpl = (M.TEMPLATES[0] || {}).id || 'home';
    placeId = id;
    if (commit(d => { d.places.push({ id, name: '新地點', templateId: tpl }); }, { rebuild: true })) { $('placeName').focus(); $('placeName').select(); }
  }
  function removeVehicle(i) {
    const v = plan.vehicles[i];
    if (!canDelete) { notice('你沒有刪除車輛的權限。', 'error'); return; }
    const used = [];
    plan.days.forEach((d, k) => { if (d.routes.some(r => r.vehicleId === v.id)) used.push(k + 1); });
    if (used.length && !confirm(`「${v.name}」在第 ${used.join('、')} 天有路線。移除車輛會一併刪除這 ${used.length} 條路線（含途中任務）。確定移除？`)) {
      notice(`已取消：「${v.name}」與其路線都保留。`);
      return;
    }
    openStops.clear();
    const ok = commit(d => {
      d.vehicles.splice(i, 1);
      d.days.forEach(x => { x.routes = x.routes.filter(r => r.vehicleId !== v.id); });
    }, { rebuild: true });
    if (ok) notice(used.length ? `已移除「${v.name}」，並刪除第 ${used.join('、')} 天共 ${used.length} 條路線。` : `已移除「${v.name}」。`, 'ok');
  }
  function addVehicle() {
    const id = M.nextId(plan.vehicles, 'car');
    const n = plan.vehicles.length;
    const color = COLORS.find(c => !plan.vehicles.some(v => (v.color || '').toLowerCase() === c)) || COLORS[n % COLORS.length];
    if (commit(d => { d.vehicles.push({ id, name: `第 ${n + 1} 台車`, color }); }, { rebuild: true })) { const field = $(`vehicle-${n}-name`); if (field) field.focus(); }
  }
  function addDay() {
    if (!flushDraft()) return;
    const last = plan.days[plan.days.length - 1];
    const date = new Date(Date.parse(last.date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    const n = plan.days.length;
    if (commit(d => { d.days.push({ date, title: `第 ${n + 1} 天`, locationId: last.locationId, routePosition: 'before', arrivalLabel: '', routes: [], events: [] }); })) {
      day = plan.days.length - 1;
      openStops.clear();
      selectedEvent = 0; selectedRoute = 0; renderEditor();
      if (ui) { ui.showTab('plan', false); ui.showSection('events', false); }
      notice(`已新增${dayLabel(curDay(), day)}。`, 'ok');
    }
  }
  function removeDay() {
    if (plan.days.length <= 1) { notice('至少需要保留一天。', 'error'); return; }
    const i = plan.days.length - 1, d = plan.days[i];
    const meals = d.events.filter(isMealEvent).length;
    if (meals && !canDelete) { notice(`無法移除${dayLabel(d, i)}：這天有 ${meals} 個菜單餐點，你沒有刪除權限。`, 'error'); return; }
    if ((d.events.length || d.routes.length) && !confirm(`移除${dayLabel(d, i)}會刪除這天的 ${d.events.length} 個活動與 ${d.routes.length} 條路線。確定？`)) return;
    openStops.clear();
    if (commit(x => { x.days.pop(); }, { rebuild: true })) notice('已移除最後一天。', 'ok');
  }
  function addEvent() {
    const evs = curDay().events;
    let time = '09:00';
    if (evs.length) {
      const m = Math.min(M.minutes(evs[evs.length - 1].time) + 60, 23 * 60 + 59);
      time = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    }
    const kind = (M.ACTIVITY_KINDS && M.ACTIVITY_KINDS[0]) || Object.keys(M.KINDS)[0];
    if (commit(x => { x.days[day].events.push({ time, title: '新活動', kind, notes: '' }); }, { rebuild: true })) {
      const idx = curDay().events.map(e => e.time + eventTitle(e)).lastIndexOf(time + '新活動');
      selectedEvent = idx; renderEvents();
      if (ui) ui.showSection('events');
      const n = $(`event-${idx}-title`);
      if (n) { n.focus(); n.select(); }
    }
  }
  function addRoute() {
    const d = curDay();
    const veh = plan.vehicles.find(v => !d.routes.some(r => r.vehicleId === v.id));
    if (!veh) { notice(plan.vehicles.length ? '每台車每天只能有一條路線；請先新增車輛。' : '還沒有車輛，請先在「地點與車」新增一台車。', 'error'); return; }
    const to = d.locationId || (plan.places[0] && plan.places[0].id);
    const fromPlace = plan.places.find(p => p.id !== to) || plan.places.find(p => p.id === to);
    if (!fromPlace || !to) { notice('需要至少一個地點才能建立路線。', 'error'); return; }
    if (commit(x => { x.days[day].routes.push({ vehicleId: veh.id, from: fromPlace.id, to, departure: '', stops: [], via: [] }); }, { rebuild: true })) { selectedRoute = curDay().routes.length - 1; renderRoutes(); const n = $(`route-${selectedRoute}-departure`); if (n) { if (ui) ui.reveal(n); n.focus(); } }
  }

  async function downloadPng() {
    if (busy || saving || !flushDraft() || !layout) return;
    $('downloadPng').disabled = true;
    const rev = revision;
    try {
      const blob = await StudioExport.png(plan);
      if (destroyed) return;
      if (rev !== revision) { notice('內容已變更，請重新下載 PNG。'); return; }
      downloadBlob(blob, sanitizeName(plan.title) + '.png');
      notice('已下載 PNG。', 'ok');
    } catch (e) {
      if (!destroyed) notice('PNG 產生失敗：' + (e && e.message ? e.message : e), 'error');
    } finally { if (!destroyed) updateButtons(); }
  }
  function exportJson() {
    if (!plan) return;
    const dirty = isDirty();
    downloadBlob(new Blob([JSON.stringify(plan, null, 2) + '\n'], { type: 'application/json' }),
      sanitizeName(plan.title) + (dirty ? '-draft' : '') + '.json');
    notice(dirty ? '已匯出目前的未儲存草稿 JSON。' : '已匯出 JSON。', 'ok');
  }

  // ---------- text itinerary ----------
  function stopText(s) {
    const k = label((M.STOP_KINDS || {})[s.kind] || s.kind);
    const extra = [(s.items || []).join('、'), s.notes].filter(Boolean).join('；');
    return `${placeName(s.placeId)}（${k}${s.time ? ' ' + s.time : '・時間未填'}${extra ? '：' + extra : ''}）`;
  }
  function routeText(r) {
    const parts = [placeName(r.from), ...(r.stops || []).map(stopText), placeName(r.to)];
    return `${vehicleName(r.vehicleId)}｜${r.departure ? r.departure + ' 出發' : '出發時間未填'}：${parts.join(' → ')}`;
  }
  function renderItinerary() {
    const kids = [el('p', { text: plan.title, class: 'accent big' })];
    if (plan.headline) kids.push(el('p', { text: plan.headline }));
    if (plan.caption) kids.push(el('p', { class: 'muted', text: plan.caption }));
    kids.push(el('p', { class: 'muted', text: `車輛：${plan.vehicles.length ? plan.vehicles.map(v => v.name).join('、') : '尚未安排'}` }));
    plan.days.forEach((d, i) => {
      kids.push(el('h3', { text: `${dayLabel(d, i)}｜${d.title || '未命名的一天'}` }), el('p', { text: `地點：${d.locationId ? placeName(d.locationId) : '未指定'}` }));
      const routes = d.routes.length ? [el('h4', { text: '路線' }), el('ul', {}, d.routes.map(r => el('li', { text: routeText(r) })))] : [];
      const arrival = d.arrivalLabel ? el('p', { text: d.arrivalLabel }) : null;
      const events = [el('h4', { text: '活動' }), d.events.length
        ? el('ul', {}, d.events.map(e => el('li', {},
          el('span', { text: `${e.time} ${eventTitle(e)}（${label(M.KINDS[e.kind] || e.kind)}）${isMealEvent(e) ? '・餐點' : ''}` }),
          e.notes ? el('p', { class: 'muted notes', text: e.notes }) : null)))
        : el('p', { class: 'muted', text: '無安排' })];
      if (d.routePosition === 'after') kids.push(...events, ...routes, arrival);
      else kids.push(...routes, arrival, ...events);
    });
    if (plan.shopping.length) kids.push(el('h3', { text: '未分配採買清單' }), el('ul', {}, plan.shopping.map(s => el('li', { text: s }))));
    $('itineraryText').replaceChildren(...kids.filter(Boolean));
    renderJournal($('journal'), plan, { M, placeName, vehicleName, eventTitle, isMealEvent, label, canEdit,
      onEditDay: i => { if (editorHidden) return; if (selectDay(i) && ui) { const n = $('day-tab-' + i); if (n) { ui.reveal(n); n.focus({ preventScroll: true }); } } },
      onCopy: copyItinerary });
  }
  // One-click copy of the text itinerary (plain text, one line per item).
  async function copyItinerary() {
    const box = $('itineraryText'), btn = $('copyItinerary'), labelNode = btn && btn.querySelector('.copy-label');
    const text = [...box.querySelectorAll('h3,h4,p,li')].filter(n => n.tagName !== 'P' || n.parentElement.tagName !== 'LI').map(n => (n.tagName === 'LI' ? '・' : '') + n.textContent.trim()).filter(Boolean).join('\n');
    const done = msg => { if (!labelNode) return; labelNode.textContent = msg; clearTimeout(copyTimer); copyTimer = setTimeout(() => { if (labelNode.isConnected) labelNode.textContent = '複製文字'; }, 1800); };
    try { await navigator.clipboard.writeText(text); done('已複製'); }
    catch (_) { try { const ta = el('textarea', { class: 'sr' }); ta.value = text; studio.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); done('已複製'); } catch (__) { done('複製失敗'); } }
  }
  let copyTimer = 0;

  // ---------- bindings ----------
  function bind() {
    const text = (id, set) => $(id).addEventListener('input', e => commit(d => set(d, e.target.value), { source: e.target }));
    text('title', (d, v) => { d.title = v; });
    text('headline', (d, v) => { d.headline = v; });
    text('caption', (d, v) => { d.caption = v; });
    text('dayTitle', (d, v) => { d.days[day].title = v; });
    text('dayArrival', (d, v) => { d.days[day].arrivalLabel = v; });
    text('placeName', (d, v) => { const p = d.places.find(x => x.id === placeId); if (p) p.name = v; });
    $('placeName').addEventListener('input', refreshOptionLabels);
    $('startDate').addEventListener('change', e => commit(d => M.shiftDates(d, e.target.value), { source: e.target, rebuild: true }));
    $('dayDate').addEventListener('change', e => commit(d => { d.days[day].date = e.target.value; }, { source: e.target }));
    $('dayLocation').addEventListener('change', e => commit(d => { d.days[day].locationId = e.target.value; }, { source: e.target }));
    $('dayRoutePosition').addEventListener('change', e => commit(d => { d.days[day].routePosition = e.target.value; }, { source: e.target }));
    $('placeTemplate').addEventListener('change', e => commit(d => { const p = d.places.find(x => x.id === placeId); if (p) p.templateId = e.target.value; }, { source: e.target }));
    $('placeSelect').addEventListener('change', e => {
      if (invalid.has('placeName') || invalid.has('placeTemplate')) { e.target.value = placeId; flushDraft(); return; }
      placeId = e.target.value; renderPlaces(); if (ui) ui.sync();
    });
    $('daySelect').addEventListener('change', e => {
      if (!flushDraft()) { e.target.value = String(day); return; }
      selectDay(Number(e.target.value));
    });
    $('addPlace').addEventListener('click', addPlace);
    $('removePlace').addEventListener('click', removePlace);
    $('addVehicle').addEventListener('click', addVehicle);
    $('addDay').addEventListener('click', addDay);
    $('removeDay').addEventListener('click', removeDay);
    $('addEvent').addEventListener('click', addEvent);
    $('addRoute').addEventListener('click', addRoute);
    $('editorForm').addEventListener('submit', e => e.preventDefault());

    $('saveTrip').addEventListener('click', () => { save(); });
    $('exportJson').addEventListener('click', exportJson);
    $('generate').addEventListener('click', () => { generate(); });
    // Follow the website's light/dark theme (the journal has its own night palette).
    const syncTheme = () => studio.classList.toggle('dark', document.documentElement.dataset.theme === 'dark');
    syncTheme();
    const themeWatch = new MutationObserver(syncTheme);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    cleanups.push(() => themeWatch.disconnect());

    $('cancel').addEventListener('click', () => { if (controller) controller.abort(); });
    $('downloadGif').addEventListener('click', () => {
      if (!flushDraft()) return;
      if (!cacheValid() || !cache.url) { notice('GIF 已過期，請重新產生。', 'error'); updateButtons(); return; }
      triggerDownload(cache.url, sanitizeName(plan.title) + '.gif');
    });
    $('downloadPng').addEventListener('click', downloadPng);

    $('play').addEventListener('click', () => { if (playing) { userPaused = true; pause(); } else { userPaused = false; play(); } });
    $('seek').addEventListener('input', e => {
      t = Math.max(0, Math.min(duration(), Number(e.target.value) || 0));
      if (playing) base = performance.now() - t * 1000;
      $('seekTime').textContent = t.toFixed(1) + 's';
      drawNow();
    });
    $('zoom').addEventListener('click', () => {
      zoomActual = !zoomActual;
      $('posterScroller').classList.toggle('actual', zoomActual);
      $('poster').style.width = zoomActual && layout ? layout.width + 'px' : '';
      $('posterWrap').style.width = zoomActual && layout ? layout.width + 'px' : '';
      $('zoom').setAttribute('aria-pressed', String(zoomActual));
      $('zoom').textContent = zoomActual ? '符合寬度' : '實際大小';
    });
    $('toggleEditor').addEventListener('click', () => {
      editorHidden = !editorHidden; syncHostEditor();
      try { localStorage.setItem(HIDDEN_KEY, editorHidden ? '1' : '0'); } catch (_) { /* preference only */ }
      $('layout').classList.toggle('editor-hidden', editorHidden);
      $('toggleEditor').setAttribute('aria-expanded', String(!editorHidden));
      $('toggleEditor').textContent = editorHidden ? '展開編輯器' : '收起編輯器';
      if (ui) ui.setMobileView(editorHidden ? 'preview' : 'editor');
      if (ui) { ui.applyWidthClass(); relayout(); }
    });

    listen(document, 'visibilitychange', () => {
      if (document.hidden) { if (playing) { resumeOnVisible = true; pause(); } }
      else if (!destroyed && !suspended) { if (resumeOnVisible && !reduced.matches && !userPaused) play(); resumeOnVisible = false; }
    });
    listen(window, 'pagehide', () => { if (controller) controller.abort(); });
    // The studio is a page section, not a page: its events must not reach the website's own document handlers.
    for (const type of ['click', 'input', 'change', 'submit', 'keydown', 'keyup', 'pointerdown', 'pointerup', 'toggle']) {
      studio.addEventListener(type, e => e.stopPropagation());
    }
    // Tell the host which field this device is editing, and keep other people's locks applied after every re-render.
    if (onFocusField) {
      let blurTimer = 0;
      const isField = t => t && t.id && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName);
      studio.addEventListener('focusin', e => { clearTimeout(blurTimer); if (isField(e.target) && !e.target.disabled) onFocusField(lockKey(e.target.id)); });
      studio.addEventListener('focusout', () => { clearTimeout(blurTimer); blurTimer = setTimeout(() => onFocusField(null), 150); });
      cleanups.push(() => clearTimeout(blurTimer));
    }
    {
      let raf = 0;
      const mo = new MutationObserver(() => { if (!locks.size || raf) return; raf = requestAnimationFrame(() => { raf = 0; applyLocks(); }); });
      mo.observe(studio, { childList: true, subtree: true });
      cleanups.push(() => { mo.disconnect(); cancelAnimationFrame(raf); });
    }
    // An invalid, uncommitted field counts as unsaved work: isDirty() covers it, so the warning fires for it too.
    listen(window, 'beforeunload', e => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });
    listen(window, 'beforeprint', () => { if (playing) { resumeOnVisible = true; pause(); } t = 6; updateSeek(); drawNow(); });
    listen(window, 'afterprint', () => { if (resumeOnVisible && !reduced.matches && !userPaused && !destroyed && !suspended) play(); resumeOnVisible = false; });
  }

  function setupStatic() {
    const L = M.LIMITS || {};
    setMax('title', L.titleMax); setMax('headline', L.headlineMax); setMax('caption', L.captionMax);
    setMax('placeName', L.placeNameMax); setMax('dayTitle', L.dayTitleMax); setMax('dayArrival', L.arrivalLabelMax);
    const groups = new Map();
    for (const tp of M.TEMPLATES) {
      if (!groups.has(tp.group)) groups.set(tp.group, el('optgroup', { label: GROUP_LABELS[tp.group] || tp.group }));
      groups.get(tp.group).append(option(tp.id, tp.label));
    }
    $('placeTemplate').replaceChildren(...groups.values());
    $('seek').max = String(duration());
  }

  // ---------- history ----------
  function remember(previous, key = '') {
    if (!previous) return;
    const now = performance.now();
    if (!key || key !== lastHistoryKey || now - lastHistoryAt > 900) {
      undoStack.push({ plan: clone(previous), day, placeId });
      if (undoStack.length > 60) undoStack.shift();
    }
    lastHistoryKey = key || ''; lastHistoryAt = now; redoStack.length = 0;
  }
  function travelHistory(backwards) {
    if (busy || saving || !requireEdit()) return;
    const from = backwards ? undoStack : redoStack, to = backwards ? redoStack : undoStack;
    if (!from.length) return;
    const previous = from[from.length - 1];
    let next;
    try { next = M.validate(clone(previous.plan)); } catch (e) { notice('無法回到這一步：' + (e && e.message ? e.message : e), 'error'); return; }
    if (!removalAllowed(next)) { notice('無法回到這一步：會刪除車輛或菜單餐點，而你沒有刪除權限。', 'error'); return; }
    to.push({ plan: clone(plan), day, placeId });
    from.pop();
    plan = next; day = Math.max(0, Math.min(previous.day, plan.days.length - 1)); placeId = previous.placeId;
    lastHistoryKey = ''; openStops.clear(); resetInvalid(); changed(true);
    notice(backwards ? '已復原上一步；記得按「儲存行程」。' : '已重做；記得按「儲存行程」。', 'ok');
  }
  function selectDay(index) {
    if (busy || saving || index < 0 || index >= plan.days.length || !flushDraft()) return false;
    day = index; selectedRoute = 0; selectedEvent = 0; openStops.clear(); lastHistoryKey = '';
    renderDay();
    if (ui) { ui.showTab('plan', false); ui.showSection(curDay().routes.length ? 'routes' : 'events', false); }
    return true;
  }

  // ---------- workspace chrome ----------
  function hostWidth() {
    const r = host.getBoundingClientRect();
    return Math.max(320, Math.round(r.width || host.clientWidth || 960));
  }
  function createWorkspace() {
    let tab = 'plan', section = curDay().routes.length ? 'routes' : 'events', mobileView = 'editor';
    let daySignature = '', targetSignature = '';
    let width = 480, narrow = false, userSized = false;
    const container = $('layout'), splitter = $('editorSplitter');
    container.classList.add('editor-wide');
    try { const pref = Number(localStorage.getItem(WIDTH_KEY)); if (pref >= 360 && pref <= 900) { width = pref; userSized = true; } } catch (_) {}
    const wideWidth = () => Math.floor(hostWidth() * .53);

    function setWidth(value, persist = false) {
      const max = narrow ? 900 : Math.max(360, Math.min(900, hostWidth() - 380));
      width = Math.round(Math.min(max, Math.max(360, value)));
      container.style.setProperty('--editor-width', width + 'px');
      splitter.setAttribute('aria-valuemin', '360'); splitter.setAttribute('aria-valuemax', String(max));
      splitter.setAttribute('aria-valuenow', String(width)); splitter.setAttribute('aria-valuetext', `編輯區寬度 ${width} 像素`);
      if (persist) { userSized = true; try { localStorage.setItem(WIDTH_KEY, String(width)); } catch (_) {} }
    }
    function setMobileView(value) {
      mobileView = value;
      container.classList.toggle('mobile-preview', value === 'preview');
      studio.classList.toggle('editing', value === 'editor');
      $('viewEditor').setAttribute('aria-pressed', String(value === 'editor'));
      $('viewPreview').setAttribute('aria-pressed', String(value === 'preview'));
      if (value === 'editor') {
        editorHidden = false; syncHostEditor();
        container.classList.remove('editor-hidden');
        $('toggleEditor').setAttribute('aria-expanded', 'true');
        $('toggleEditor').textContent = '收起編輯器';
      }
    }
    // The host, not the viewport, decides the layout: the studio sits in a page column that can be any width.
    function applyWidthClass() {
      // With the editor collapsed only the poster is shown, so the side-by-side split is not needed: stay in the
      // normal layout unless the host is phone-narrow.
      const next = hostWidth() < (editorHidden ? 560 : 900);
      if (next !== narrow) { narrow = next; studio.classList.toggle('narrow', narrow); }
      studio.classList.toggle('collapsed', editorHidden && !narrow); // phones keep their edit/preview switch
      setWidth(userSized ? width : wideWidth());
    }
    function showTab(value, guarded = true) {
      if (guarded && (busy || saving || !flushDraft())) return false;
      tab = value; lastHistoryKey = '';
      all('[data-editor-panel]').forEach(n => { n.hidden = n.dataset.editorPanel !== tab; });
      all('#editorTabs [data-tab]').forEach(n => { const active = n.dataset.tab === tab; n.setAttribute('aria-selected', String(active)); n.tabIndex = active ? 0 : -1; });
      if (tab === 'assets') drawTemplateChoices();
      return true;
    }
    function showSection(value, guarded = true) {
      if (guarded && (busy || saving || !flushDraft())) return false;
      section = value;
      $('routeSection').hidden = value !== 'routes'; $('eventSection').hidden = value !== 'events';
      for (const key of ['routes', 'events']) $('section-' + key).setAttribute('aria-pressed', String(key === value));
      return true;
    }
    function reveal(node) {
      const panel = node.closest('[data-editor-panel]');
      if (panel) showTab(panel.dataset.editorPanel, false);
      if (node.closest('#routeSection')) showSection('routes', false);
      if (node.closest('#eventSection')) showSection('events', false);
      let parent = node.parentElement;
      while (parent) { if (parent.tagName === 'DETAILS') parent.open = true; parent = parent.parentElement; }
      const routeEntry = node.closest('details[id^=route-entry-]');
      const eventEntry = node.closest('details[id^=event-entry-]');
      if (routeEntry) selectedRoute = Number(routeEntry.id.split('-').at(-1));
      if (eventEntry) selectedEvent = Number(eventEntry.id.split('-').at(-1));
      setMobileView('editor');
      node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    function drawTemplateChoices() {
      const selected = plan.places.find(p => p.id === placeId);
      if (!$('templateGrid').children.length) {
        for (const tp of M.TEMPLATES) {
          const canvas = el('canvas', { width: 184, height: 132, 'aria-hidden': 'true' });
          try { StoryArt.draw(canvas.getContext('2d'), 'route-place', 92, 111, .59, 0, { templateId: tp.id }); } catch (_) {}
          const button = el('button', { type: 'button', class: 'template-choice', 'data-template': tp.id, 'aria-label': tp.label,
            onclick: () => { if (commit(d => { const p = d.places.find(x => x.id === placeId); if (p) p.templateId = tp.id; }, { source: $('placeTemplate') })) $('placeTemplate').value = tp.id; } },
            canvas, el('span', { text: tp.label }));
          $('templateGrid').append(button);
        }
      }
      all('#templateGrid button').forEach(n => n.setAttribute('aria-pressed', String(n.dataset.template === (selected && selected.templateId))));
    }
    function sync() {
      if (!plan || !curDay()) return;
      const signature = JSON.stringify(plan.days.map(d => [d.date, d.title]));
      if (signature !== daySignature) {
        daySignature = signature;
        $('dayTabs').replaceChildren(...plan.days.map((d, i) => el('button', { type: 'button', id: `day-tab-${i}`, class: 'day-button',
          'aria-label': `編輯${dayLabel(d, i)}`, onclick: () => selectDay(i) },
          el('span', { text: `第 ${i + 1} 天` }),
          el('span', { class: 'entry-meta', text: (() => { try { return M.dateText(d.date); } catch (_) { return d.date; } })() }))));
      }
      all('#dayTabs button').forEach((n, i) => { n.setAttribute('aria-pressed', String(i === day)); });
      $('dayContext').textContent = `${curDay().title || '未命名的一天'} · ${curDay().routes.length} 條路線 / ${curDay().events.length} 個活動`;
      if (tab === 'assets') drawTemplateChoices();
      const targetKey = layout ? JSON.stringify([layout.height, layout.days.map(d => [d.start, d.end]), signature]) : '';
      if (layout && targetKey !== targetSignature) {
        targetSignature = targetKey;
        $('previewTargets').replaceChildren(...layout.days.map((d, i) => {
          const b = el('button', { type: 'button', class: 'preview-target', id: `preview-day-${i}`, 'aria-label': `編輯第 ${i + 1} 天：${(plan.days[i] || {}).title || ''}`,
            onclick: () => { if (selectDay(i)) { setMobileView('editor'); if (narrow) $('workspaceSwitch').scrollIntoView({ block: 'start' }); const n = $('day-tab-' + i); if (n) n.focus({ preventScroll: true }); } } },
            el('span', { text: `編輯第 ${i + 1} 天` }));
          b.style.cssText = `left:0;top:${d.start / layout.height * 100}%;width:100%;height:${(d.end - d.start) / layout.height * 100}%;`;
          return b;
        }));
      } else if (!layout) {
        $('previewTargets').replaceChildren();
        targetSignature = '';
      }
      all('#previewTargets button').forEach((b, i) => { b.disabled = busy || saving; b.classList.toggle('selected', i === day); });
      updateButtons();
    }

    all('#editorTabs [data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
    $('editorTabs').addEventListener('keydown', e => {
      const tabs = all('#editorTabs [data-tab]'), index = tabs.indexOf(e.target);
      if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      if (showTab(tabs[next].dataset.tab)) tabs[next].focus();
    });
    for (const value of ['routes', 'events']) $('section-' + value).addEventListener('click', () => showSection(value));
    $('viewEditor').addEventListener('click', () => { setMobileView('editor'); });
    $('viewPreview').addEventListener('click', () => { if (flushDraft()) { setMobileView('preview'); $('workspaceSwitch').scrollIntoView({ block: 'start' }); } });
    $('wideEditor').addEventListener('click', () => {
      const wide = !container.classList.contains('editor-wide');
      container.classList.toggle('editor-wide', wide);
      setWidth(wide ? Math.floor(hostWidth() * .53) : 480, true);
      $('wideEditor').setAttribute('aria-pressed', String(wide));
    });
    splitter.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      setWidth(e.key === 'Home' ? 360 : e.key === 'End' ? hostWidth() - 380 : width + (e.key === 'ArrowLeft' ? 24 : -24), true);
    });
    let pointer = null;
    splitter.addEventListener('pointerdown', e => { if (e.button !== 0 || narrow) return; pointer = e.pointerId; splitter.setPointerCapture(pointer); container.classList.add('resizing'); e.preventDefault(); });
    splitter.addEventListener('pointermove', e => { if (pointer === e.pointerId) { const r = container.getBoundingClientRect(); setWidth(r.right - e.clientX - 20); } });
    const endDrag = () => { if (pointer === null) return; pointer = null; container.classList.remove('resizing'); setWidth(width, true); };
    splitter.addEventListener('pointerup', endDrag);
    splitter.addEventListener('pointercancel', endDrag);
    splitter.addEventListener('lostpointercapture', () => { pointer = null; container.classList.remove('resizing'); });
    $('undoEdit').addEventListener('click', () => travelHistory(true));
    $('redoEdit').addEventListener('click', () => travelHistory(false));
    // Shortcuts stay inside the studio: the website keeps its own Ctrl+S behaviour everywhere else on the page.
    root.addEventListener('keydown', e => {
      const key = (e.key || '').toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === 's') { e.preventDefault(); save(); }
      if ((e.ctrlKey || e.metaKey) && key === 'z' && !(e.target && e.target.matches && e.target.matches('input,textarea,[contenteditable]'))) { e.preventDefault(); travelHistory(!e.shiftKey); }
    });
    const ro = new ResizeObserver(() => { if (!destroyed) applyWidthClass(); });
    ro.observe(host);
    cleanups.push(() => ro.disconnect());
    applyWidthClass();
    showTab('plan', false);
    showSection(section, false);
    setMobileView(mobileView);
    return { sync, showTab, showSection, reveal, setMobileView, applyWidthClass };
  }

  async function fontsReady() {
    if (!document.fonts) return;
    const load = Promise.all([
      document.fonts.load('32px "WenKai"', '旅行繪本'),
      document.fonts.load('32px "Patrick Hand"', 'Trip')
    ]).then(() => document.fonts.ready);
    let timer = 0;
    try { await Promise.race([load, new Promise(res => { timer = setTimeout(res, 8000); })]); } catch (_) {}
    clearTimeout(timer);
    if (destroyed) return;
    if (!document.fonts.check('32px "WenKai"', '旅')) notice('字型尚未載入，海報可能以系統字型顯示。', 'error');
  }

  function applyPermissions() {
    studio.classList.toggle('readonly', !canEdit);
    studio.dataset.canEdit = String(canEdit);
    studio.dataset.canDelete = String(canDelete);
    if (plan) renderEditor();
    updateDirty();
  }

  async function start() {
    for (const [name, mod] of [['model', M], ['renderer', StudioRenderer], ['exporter', StudioExport]]) {
      if (!mod) { notice('缺少必要的程式模組，無法啟動繪本編輯器。', 'error'); throw new Error('storybook studio: missing ' + name); }
    }
    let source = options.plan;
    if (source === undefined || source === null) throw new Error('mountStudio 需要 plan');
    plan = M.validate(clone(source));
    savedJson = JSON.stringify(plan);
    placeId = plan.places.length ? plan.places[0].id : null;
    setupStatic();
    bind();
    updateButtons();
    notice('正在載入字型…');
    await fontsReady();
    if (destroyed) return;
    ui = createWorkspace();
    applyPermissions();
    // The editor starts collapsed; it opens only when the user expanded it last (stored '0').
    try { if (canEdit && localStorage.getItem(HIDDEN_KEY) !== '0' && !editorHidden) $('toggleEditor').click(); } catch (_) { /* preference only */ }
    relayout();
    renderEditor();
    renderItinerary();
    updateDirty();
    updateExportInfo();
    checkCache();
    if (statusText === '正在載入字型…') notice('');
    if (reduced.matches || !canEdit) { t = 6; updateSeek(); drawNow(); } else play();
    updatePlayButton();
    studio.dataset.ready = 'true';
  }

  const ready = start().catch(e => {
    if (!destroyed) notice('繪本編輯器啟動失敗：' + (e && e.message ? e.message : e), 'error');
    throw e;
  });

  return Object.freeze({
    ready,
    isDirty,
    getPlan: () => (plan ? clone(plan) : null),
    getState: () => ({ editorVersion: 'storybook-studio-1', ready: studio.dataset.ready === 'true', busy, saving, playing, suspended, destroyed, day, dirty: isDirty(), invalid: invalid.size, canEdit, canDelete, zoom: zoomActual ? 'actual' : 'fit', editorHidden, previewScaled, layoutError, time: t }),
    setPermissions({ canEdit: edit, canDelete: del } = {}) {
      if (destroyed) return;
      if (edit !== undefined) canEdit = edit !== false;
      if (del !== undefined) canDelete = del !== false;
      applyPermissions();
    },
    // list: [{ field, name }] from the host; replaces all current locks.
    setLocks(list) {
      if (destroyed) return;
      locks = new Map((Array.isArray(list) ? list : []).filter(x => x && typeof x.field === 'string').map(x => [x.field, String(x.name || '其他人')]));
      applyLocks();
    },
    markSaved(next) { markSaved(next); },
    // Refused while there is unsaved or invalid work: the parent must resolve that first, or the edits vanish silently.
    refresh(next) {
      if (destroyed) return false;
      if (saving || busy) { notice('正在處理中，請稍後再重新載入行程。', 'error'); return false; }
      if (isDirty()) { notice('有未儲存的變更，沒有重新載入伺服器版本。請先儲存或匯出 JSON 備份。', 'error'); return false; }
      if (next === undefined || next === null) return false;
      let validated;
      try { validated = M.validate(clone(next)); }
      catch (e) { notice('伺服器回傳的行程無法解析，畫面保留目前內容：' + (e && e.message ? e.message : e), 'error'); return false; }
      plan = validated;
      savedJson = JSON.stringify(validated);
      day = Math.max(0, Math.min(day, plan.days.length - 1));
      if (!plan.places.some(p => p.id === placeId)) placeId = plan.places.length ? plan.places[0].id : null;
      undoStack.length = 0; redoStack.length = 0; lastHistoryKey = '';
      openStops.clear(); resetInvalid();
      changed(true);
      notice('已載入最新的行程內容。', 'ok');
      return true;
    },
    suspend() {
      if (destroyed || suspended) return;
      suspended = true;
      resumeOnVisible = playing;
      pause();
    },
    resume() {
      if (destroyed || !suspended) return;
      suspended = false;
      if (ui) ui.applyWidthClass();
      relayout();
      if (resumeOnVisible && !userPaused && !reduced.matches) play();
      resumeOnVisible = false;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      pause();
      if (controller) { try { controller.abort(); } catch (_) {} }
      if (cache && cache.url) URL.revokeObjectURL(cache.url);
      cache = null;
      for (const u of transientUrls) URL.revokeObjectURL(u);
      transientUrls.clear();
      try { StudioExport.clearCache(); } catch (_) {}
      for (const fn of cleanups.splice(0)) { try { fn(); } catch (_) {} }
      root.replaceChildren();
      root.adoptedStyleSheets = [];
      plan = null; layout = null; ui = null;
    }
  });
}
