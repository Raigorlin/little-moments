import { parseAmount, formatMoney, summarizeLedger } from './expense-model.js';
import { parseReceiptText } from './receipt-parser.js';
import { EXPENSE_CATEGORIES, suggestExpenseCategory } from './expense-categories.js';
import { escape as e } from './model.js';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const IMAGE_EXT_RE = /\.(jpe?g|png|webp)$/i;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 1000;
const MAX_CENTS = 100000000;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const VERIFY_LABEL = '已逐項核對品項與金額';
export const BACKEND_OFF = '分帳後端尚未啟用，請先完成備份與重新啟動';
const NOT_FOUND = '找不到帳本：可能是分帳後端尚未啟用（請先完成備份與重新啟動），或這趟旅行已刪除、你沒有存取權限';
const EXPENSE_KEYS = ['id', 'date', 'title', 'amountCents', 'payerId', 'participantIds', 'category', 'note', 'shoppingId', 'source', 'receiptId', 'receiptLine'];
const SETTLEMENT_KEYS = ['id', 'date', 'fromId', 'toId', 'amountCents', 'note'];
const CATEGORY_TONE = { 食材: 'green', 交通: 'blue', 住宿: 'lavender', 其他: 'peach' };
const ACTION_ICONS = {
  edit: '<path d="m14 5 5 5M4 20l5-1L21 7l-5-5L4 14v6Z"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>'
};
let instances = 0;

const chars = value => [...String(value ?? '')].length;
const cleanText = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const newId = () => globalThis.crypto.randomUUID();

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function isIsoDate(value) {
  if (!DATE_RE.test(String(value ?? ''))) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(+d) && d.toISOString().slice(0, 10) === value;
}
function shortDate(value) {
  if (!isIsoDate(value)) return value || '日期未定';
  return new Date(`${value}T12:00:00`).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short' });
}
export function toCents(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  let cents;
  try { cents = parseAmount(text); } catch { return null; }
  return Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_CENTS ? cents : null;
}
export function centsToInput(cents) {
  if (!Number.isSafeInteger(cents) || cents <= 0) return '';
  const rest = cents % 100;
  return `${Math.trunc(cents / 100)}${rest ? `.${String(rest).padStart(2, '0')}` : ''}`;
}
function money(cents) {
  try { return formatMoney(cents); } catch { return `NT$${centsToInput(cents) || '0'}`; }
}
function commonReceiptCategory(rows, fallback = '食材') {
  const counts = new Map();
  for (const row of rows) {
    if (EXPENSE_CATEGORIES.includes(row.category)) counts.set(row.category, (counts.get(row.category) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || fallback;
}
function actionIcon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ACTION_ICONS[name]}</svg>`;
}
export function csvCell(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  let text = String(value ?? '');
  if (/^\s*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
const canonical = (row, keys) => JSON.stringify(keys.map(key => row?.[key] ?? null));
function safeLineId(raw, index, used) {
  const base = String(raw ?? '').replace(/[^A-Za-z0-9-]/g, '-').slice(0, 60) || `line-${index + 1}`;
  let candidate = base, n = 2;
  while (used.has(candidate)) candidate = `${base.slice(0, 58)}-${n++}`;
  used.add(candidate);
  return candidate;
}
async function sha256Hex(file) {
  if (!globalThis.crypto?.subtle) return '';
  const digest = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function validLedger(ledger) {
  return ledger && typeof ledger === 'object' && Number.isSafeInteger(ledger.revision) && Array.isArray(ledger.people) && Array.isArray(ledger.expenses) && Array.isArray(ledger.settlements);
}
const fileSafe = name => String(name || '旅行').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').slice(0, 60);

export function createExpensePanel({ getState, account, assertSession, onDirty } = {}) {
  const pfx = `xp${++instances}`;
  const id = name => `${pfx}-${name}`;
  const element = document.createElement('section');
  element.className = 'xp-panel';
  element.dataset.xpPanel = '';
  element.setAttribute('aria-labelledby', id('title'));
  const live = document.createElement('div');
  live.className = 'xp-sr';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  const body = document.createElement('div');
  body.className = 'xp-body';
  element.append(live, body);

  const S = {
    status: account ? 'loading' : 'demo', loadError: null, reloading: false,
    ledger: null, perms: { canEdit: false, canDelete: false },
    editor: null, form: null, receipt: null, receiptError: '', confirm: null, discardPrompt: null, promptReturnFocusId: '',
    pending: null, busy: false, locked: '', notice: null, destroyed: false,
    lastDirty: false, focusId: '', highlight: new Set()
  };

  const tripId = () => String(account?.trip?.id ?? '');
  const ledgerPath = () => `/api/trips/${encodeURIComponent(tripId())}/ledger`;
  const state = () => { try { return getState?.() || null; } catch { return null; } };
  const announce = text => { live.textContent = ''; live.textContent = text; };
  const setNotice = (tone, text) => { S.notice = { tone, text }; announce(text); };

  function people() {
    const map = new Map();
    for (const p of S.ledger?.people || []) if (p && typeof p.id === 'string') map.set(p.id, { id: p.id, name: String(p.name ?? ''), current: false });
    for (const p of state()?.people || []) {
      if (!p || typeof p.id !== 'string') continue;
      map.set(p.id, { id: p.id, name: String(p.name ?? '') || map.get(p.id)?.name || '', current: true });
    }
    return [...map.values()];
  }
  const nameOf = pid => S.ledger?.people?.find(p => p.id === pid)?.name || state()?.people?.find(p => p.id === pid)?.name || '（未知旅伴）';
  const shopping = () => (state()?.shopping || []).filter(s => s && typeof s.id === 'string');
  const myPersonId = () => account?.permissions?.personId || '';
  const pendingBody = () => { try { return S.pending ? JSON.parse(S.pending.bodyJson) : null; } catch { return null; } };
  const bookedCount = rid => {
    if (!rid) return 0;
    const ids = new Set();
    for (const x of S.ledger?.expenses || []) if (x.receiptId === rid) ids.add(x.id);
    for (const x of pendingBody()?.expenses || []) if (x.receiptId === rid) ids.add(x.id);
    return ids.size;
  };

  function isDirty() {
    return Boolean((S.form && S.form.dirty) || S.pending || S.receipt);
  }
  function notifyDirty() {
    const dirty = isDirty();
    if (dirty === S.lastDirty) return;
    S.lastDirty = dirty;
    try { onDirty?.(dirty); } catch {}
  }
  function blockReason({ remove = false } = {}) {
    if (S.locked) return S.locked;
    if (S.status !== 'ready') return '帳本尚未載入，不能儲存。';
    if (S.busy) return '正在儲存，請稍候。';
    if (S.pending) return '上一筆變更尚未確認儲存。請先重試、匯出未存內容或重新載入。';
    if (!S.perms.canEdit) return '你目前沒有這趟旅行的編輯權限，只能檢視帳本。';
    if (remove && !S.perms.canDelete) return '只有旅行建立者與管理員可以移除帳本紀錄。';
    return '';
  }
  const canMutate = opts => !blockReason(opts);

  function acceptEnvelope(result) {
    if (!validLedger(result?.ledger)) throw Object.assign(new Error('伺服器回傳的帳本格式不正確'), { status: -1 });
    S.ledger = result.ledger;
    S.perms = { canEdit: result.permissions?.canEdit === true, canDelete: result.permissions?.canDelete === true };
    S.status = 'ready';
    S.loadError = null;
  }
  function pendingApplied(p, ledger) {
    const { check } = p;
    const has = (list, row, keys) => list.some(x => x?.id === row.id && canonical(x, keys) === canonical(row, keys));
    return check.upsertExpenses.every(r => has(ledger.expenses, r, EXPENSE_KEYS))
      && check.upsertSettlements.every(r => has(ledger.settlements, r, SETTLEMENT_KEYS))
      && check.removeExpenses.every(rid => !ledger.expenses.some(x => x?.id === rid))
      && check.removeSettlements.every(rid => !ledger.settlements.some(x => x?.id === rid));
  }

  async function load({ ask = false } = {}) {
    if (!account || S.destroyed || S.busy || S.reloading || S.locked) return;
    if (ask && isDirty() && !window.confirm(S.pending
      ? '重新載入會取得伺服器最新帳本，尚未確認的送出內容會移出佇列（表單與收據草稿會保留）。建議先匯出未存內容。確定繼續？'
      : '重新載入只會更新帳本清單，表單與收據草稿會保留。確定繼續？')) return;
    S.reloading = true;
    if (S.status !== 'ready') S.status = 'loading';
    S.notice = null;
    render();
    try {
      if (typeof assertSession === 'function') await assertSession();
      const result = await account.api(ledgerPath());
      if (S.destroyed) return;
      if (typeof assertSession === 'function') await assertSession();
      if (S.destroyed || S.locked) return;
      acceptEnvelope(result);
      if (S.pending && !S.busy) {
        const p = S.pending;
        S.pending = null;
        if (pendingApplied(p, S.ledger)) { p.onSaved?.(); setNotice('ok', `伺服器帳本已包含「${p.label}」，確認已儲存。`); }
        else setNotice('error', `已重新載入伺服器帳本。「${p.label}」沒有出現在帳本中，草稿仍保留，請檢查後重新送出。`);
      } else announce('已載入最新分帳帳本');
      if (S.form?.mode === 'edit' && S.form.type === 'expense' && !S.ledger.expenses.some(x => x.id === S.form.id)) S.form.error = '這筆支出已不在伺服器帳本中，無法儲存修改。請匯出草稿後改為新增。';
      if (S.receipt?.id && S.ledger.expenses.some(x => x.receiptId === S.receipt.id)) S.receipt.error = '伺服器帳本已記錄過這張收據，不能再次記帳。如需修正，請在支出明細逐筆編輯。';
    } catch (err) {
      if (S.destroyed) return;
      if (err?.status === 404 && S.status !== 'ready') { S.status = 'unavailable'; S.loadError = err; }
      else if (S.status !== 'ready') { S.status = 'error'; S.loadError = err; }
      else setNotice('error', `重新載入失敗：${err?.status === 401 ? '登入狀態已失效，請重新登入' : err?.status === 404 ? NOT_FOUND : err?.message || '未知錯誤'}。畫面上的草稿沒有變動。`);
    } finally {
      S.reloading = false;
      if (!S.destroyed) render();
    }
  }

  async function submit({ label, expenses, settlements, check, onSaved }) {
    const removing = (check.removeExpenses?.length || 0) + (check.removeSettlements?.length || 0) > 0;
    const reason = blockReason({ remove: removing });
    if (reason) { setNotice('error', reason); render(); return; }
    if (expenses.length > MAX_ROWS || settlements.length > MAX_ROWS) { setNotice('error', '帳本最多 1000 筆支出與 1000 筆還款紀錄。'); render(); return; }
    const body = { expectedUserId: account.user.id, revision: S.ledger.revision, requestId: newId(), expenses, settlements };
    S.pending = {
      label, bodyJson: JSON.stringify(body), requestId: body.requestId, revision: body.revision,
      check: { upsertExpenses: [], upsertSettlements: [], removeExpenses: [], removeSettlements: [], ...check },
      onSaved, state: 'sending', error: '', retryable: false, conflict: false
    };
    S.notice = null;
    await attempt(S.pending);
  }

  async function attempt(p) {
    if (S.busy || S.destroyed || S.pending !== p || S.locked) return;
    S.busy = true;
    p.state = 'sending';
    p.error = '';
    render();
    announce(`正在儲存「${p.label}」…`);
    let sent = false;
    try {
      if (typeof assertSession === 'function') await assertSession();
      if (S.destroyed || S.pending !== p) return;
      if (S.locked) throw Object.assign(new Error(S.locked), { locked: true });
      sent = true;
      const result = await account.api(ledgerPath(), { method: 'PUT', body: JSON.parse(p.bodyJson) });
      if (S.destroyed) return;
      acceptEnvelope(result);
      if (S.pending === p) { S.pending = null; p.onSaved?.(); setNotice('ok', `「${p.label}」已儲存，結餘已更新。`); }
    } catch (err) {
      if (S.destroyed || S.pending !== p) return;
      p.state = 'failed';
      const status = err?.status;
      if (err?.locked) { p.retryable = false; p.error = `${S.locked} 這次變更沒有送出。`; }
      else if (!sent) { p.retryable = true; p.error = `無法確認登入身分，這次變更沒有送出：${err?.message || '未知錯誤'}`; }
      else if (status === 409) { p.conflict = true; p.retryable = false; p.error = `${err?.message ? `${err.message}。` : ''}帳本已被其他人更新、收據已記錄過，或這個請求編號已用於不同內容。草稿仍保留，不會自動重送。請先匯出未存內容，再重新載入伺服器帳本後重新送出。`; }
      else if (status === 401) { p.retryable = true; p.error = '登入已失效，無法確認這次變更是否儲存。請先匯出未存內容，重新登入原帳號後，再以同一筆內容重試。'; }
      else if (!status || status === -1 || status === 408 || status === 429 || status >= 500) { p.retryable = true; p.error = `網路或伺服器沒有正常回應（${err?.message || '未知錯誤'}），無法確定是否已儲存。可以用同一筆內容重試（伺服器會辨識同一請求，不會重複記帳），或重新載入確認。`; }
      else {
        S.pending = null;
        setNotice('error', `伺服器拒絕「${p.label}」：${status === 404 ? NOT_FOUND : err?.message || `錯誤 ${status}`}。沒有任何變更被儲存，草稿仍保留。`);
      }
      if (S.pending === p) announce(p.error);
    } finally {
      S.busy = false;
      if (!S.destroyed) render();
    }
  }

  function closeReceipt() {
    const R = S.receipt;
    if (!R) return;
    R.token++;
    try { R.controller?.abort(); } catch {}
    if (R.url) URL.revokeObjectURL(R.url);
    R.url = '';
    R.file = null;
    S.receipt = null;
  }
  function closeEditor() {
    closeReceipt();
    S.form = null;
    S.editor = null;
    S.receiptError = '';
  }
  const editorIsDirty = () => Boolean((S.form && S.form.dirty) || S.receipt);
  function openEditor(kind, setup, focus) {
    const reason = blockReason();
    if (reason) { setNotice('error', reason); render(); return; }
    if (S.editor && editorIsDirty() && !window.confirm('目前的草稿尚未儲存。要放棄這份草稿並開啟新的表單嗎？已儲存的紀錄不受影響。')) return;
    closeEditor();
    S.editor = kind;
    S.confirm = null;
    S.notice = null;
    setup?.();
    S.focusId = focus;
    render();
  }
  function openExpense(expense) {
    const ids = people().filter(p => p.current).map(p => p.id);
    openEditor('expense', () => {
      const fromReceipt = expense?.source === 'receipt';
      S.form = expense ? {
        type: 'expense', mode: 'edit', id: expense.id, dirty: false, error: '',
        origin: { source: fromReceipt ? 'receipt' : 'manual', receiptId: fromReceipt ? String(expense.receiptId || '') : '', receiptLine: fromReceipt ? String(expense.receiptLine || '') : '' },
        values: { title: expense.title || '', date: expense.date || '', amount: centsToInput(expense.amountCents), payerId: expense.payerId || '', participantIds: [...(expense.participantIds || [])], category: EXPENSE_CATEGORIES.includes(expense.category) ? expense.category : '其他', note: expense.note || '', shoppingId: expense.shoppingId || '' }
      } : {
        type: 'expense', mode: 'new', id: '', dirty: false, error: '',
        origin: { source: 'manual', receiptId: '', receiptLine: '' },
        values: { title: '', date: todayIso(), amount: '', payerId: ids.includes(myPersonId()) ? myPersonId() : '', participantIds: ids, category: '食材', note: '', shoppingId: '' }
      };
    }, id('f-title'));
  }
  function openSettlement(prefill) {
    openEditor('settlement', () => {
      S.form = { type: 'settlement', mode: 'new', id: '', dirty: Boolean(prefill), error: '', values: { date: todayIso(), fromId: prefill?.fromId || '', toId: prefill?.toId || '', amount: prefill ? centsToInput(prefill.amountCents) : '', note: '' } };
    }, prefill ? id('s-date') : id('s-from'));
  }

  function validateExpense() {
    const f = S.form, v = f.values;
    const pool = people();
    const known = new Set(pool.map(p => p.id));
    const original = f.mode === 'edit' ? S.ledger.expenses.find(x => x.id === f.id) : null;
    if (f.mode === 'edit' && !original) return { error: '這筆支出已不在伺服器帳本中，無法儲存修改。請匯出草稿後改為新增。' };
    const title = cleanText(v.title);
    if (!title || chars(title) > 100) return { error: '請填寫 1–100 字的項目名稱。' };
    if (!isIsoDate(v.date)) return { error: '請選擇有效的日期。' };
    const amountCents = toCents(v.amount);
    if (amountCents === null) return { error: '請輸入大於 0、最多 100 萬元的新台幣金額，例如 1280 或 99.5。' };
    if (!known.has(v.payerId)) return { error: '請選擇付款人。' };
    const participantIds = pool.map(p => p.id).filter(pid => v.participantIds.includes(pid));
    if (participantIds.length < 1 || participantIds.length > 100) return { error: '請至少選擇一位分攤的旅伴。' };
    if (!EXPENSE_CATEGORIES.includes(v.category)) return { error: '請選擇分類。' };
    if (chars(v.note) > 500) return { error: '備註最多 500 字。' };
    const shoppingId = v.shoppingId || '';
    if (shoppingId && !shopping().some(s => s.id === shoppingId) && shoppingId !== (original?.shoppingId || '')) return { error: '連結的採買品項已不存在，請重新選擇。' };
    if (!f.newId) f.newId = newId();
    return { record: { id: f.mode === 'edit' ? f.id : f.newId, date: v.date, title, amountCents, payerId: v.payerId, participantIds, category: v.category, note: String(v.note).trim(), shoppingId, source: f.origin.source, receiptId: f.origin.receiptId, receiptLine: f.origin.receiptLine } };
  }
  function saveExpense() {
    const { error, record } = validateExpense();
    if (error) { S.form.error = error; render(); return; }
    const editing = S.form.mode === 'edit';
    const expenses = editing ? S.ledger.expenses.map(x => (x.id === record.id ? record : x)) : [...S.ledger.expenses, record];
    const form = S.form;
    void submit({ label: `${editing ? '修改' : '新增'}支出「${record.title}」`, expenses, settlements: S.ledger.settlements, check: { upsertExpenses: [record] }, onSaved: () => { if (S.form === form) { S.form = null; S.editor = null; } S.highlight = new Set([record.id]); } });
  }
  function saveSettlement() {
    const v = S.form.values;
    const known = new Set(people().map(p => p.id));
    let error = '';
    if (!known.has(v.fromId) || !known.has(v.toId)) error = '請選擇付款與收款的旅伴。';
    else if (v.fromId === v.toId) error = '付款人與收款人不能是同一位。';
    else if (toCents(v.amount) === null) error = '請輸入實際已付的金額（大於 0）。';
    else if (!isIsoDate(v.date)) error = '請選擇還款日期。';
    else if (chars(v.note) > 500) error = '備註最多 500 字。';
    if (error) { S.form.error = error; render(); return; }
    if (!S.form.newId) S.form.newId = newId();
    const record = { id: S.form.newId, date: v.date, fromId: v.fromId, toId: v.toId, amountCents: toCents(v.amount), note: String(v.note).trim() };
    const form = S.form;
    void submit({ label: `還款紀錄 ${nameOf(record.fromId)} → ${nameOf(record.toId)}`, expenses: S.ledger.expenses, settlements: [...S.ledger.settlements, record], check: { upsertSettlements: [record] }, onSaved: () => { if (S.form === form) { S.form = null; S.editor = null; } } });
  }
  function removeRow(kind, rid) {
    if (kind === 'expense') {
      const row = S.ledger.expenses.find(x => x.id === rid);
      if (!row) return;
      void submit({ label: `移除支出「${row.title}」`, expenses: S.ledger.expenses.filter(x => x.id !== rid), settlements: S.ledger.settlements, check: { removeExpenses: [rid] }, onSaved: () => { S.confirm = null; } });
    } else {
      const row = S.ledger.settlements.find(x => x.id === rid);
      if (!row) return;
      void submit({ label: `移除還款紀錄 ${nameOf(row.fromId)} → ${nameOf(row.toId)}`, expenses: S.ledger.expenses, settlements: S.ledger.settlements.filter(x => x.id !== rid), check: { removeSettlements: [rid] }, onSaved: () => { S.confirm = null; } });
    }
  }

  const bookedMessage = n => `這張收據（相同檔案指紋）已有 ${n} 筆品項記錄在帳本或待確認的送出中，不能再次辨識記帳。如需修正，請在「支出明細」逐筆編輯。`;
  function rejectBooked(R) {
    const n = bookedCount(R.id);
    if (!n) return false;
    closeReceipt();
    S.receiptError = bookedMessage(n);
    announce(S.receiptError);
    render();
    return true;
  }
  function reparse(R) {
    let parsed;
    try { parsed = parseReceiptText(R.text) || {}; }
    catch (err) { R.rows = []; R.parsedTotal = null; R.totalInput = ''; R.parseWarnings = [`解析失敗：${err?.message || '未知錯誤'}`]; R.verified = false; R.discrepancyKey = ''; return; }
    const used = new Set();
    R.rows = (Array.isArray(parsed.items) ? parsed.items : []).map((item, i) => {
      const raw = Number.isSafeInteger(item?.amountCents) ? item.amountCents : item?.amount;
      const amount = Number.isSafeInteger(raw) ? centsToInput(raw) : String(raw ?? '').trim();
      const warning = cleanText(item?.warning);
      const title = cleanText(item?.title).slice(0, 100);
      return { lineId: safeLineId(item?.lineId, i, used), title, amount, category: suggestExpenseCategory(title), warning, selected: !warning && toCents(amount) !== null };
    });
    R.category = commonReceiptCategory(R.rows, R.category);
    R.parsedTotal = Number.isSafeInteger(parsed.totalCents) && parsed.totalCents > 0 ? parsed.totalCents : null;
    R.totalInput = R.parsedTotal === null ? '' : centsToInput(R.parsedTotal);
    R.parseWarnings = (Array.isArray(parsed.warnings) ? parsed.warnings : []).map(cleanText).filter(Boolean);
    R.verified = false;
    R.discrepancyKey = '';
    R.rowsEdited = false;
    R.manualSeq = 0;
  }
  async function pickReceiptFile(file) {
    if (!file || S.locked) return;
    const typeOk = IMAGE_TYPES.has(file.type) || (!file.type && IMAGE_EXT_RE.test(file.name || ''));
    if (!typeOk) { S.receiptError = '只支援 JPEG、PNG 或 WebP 圖片。'; render(); return; }
    if (!file.size || file.size > MAX_IMAGE_BYTES) { S.receiptError = '圖片需小於 10 MB。'; render(); return; }
    if (S.receipt && !window.confirm('換一張收據會放棄目前這張的辨識與核對內容，確定繼續？')) { render(); return; }
    closeReceipt();
    S.receiptError = '';
    const R = {
      token: 0, file, size: file.size, url: URL.createObjectURL(file),
      id: '', phase: 'hashing', progress: 0, progressText: '', controller: null, text: '', confidence: null, note: '', resultMode: 'openai',
      rows: [], parsedTotal: null, totalInput: '', parseWarnings: [], payerId: '', participantIds: [], date: '',
      category: '食材', verified: false, discrepancyKey: '', error: '', rowsEdited: false, manualSeq: 0
    };
    S.receipt = R;
    render();
    const token = R.token;
    try { R.id = await sha256Hex(file); } catch { R.id = ''; }
    if (S.receipt !== R || R.token !== token) return;
    if (rejectBooked(R)) return;
    await runAi(R);
  }
  async function runAi(R) {
    if (!R?.file || frozen() || !account?.user?.id || !account?.trip?.id) return;
    if (R.rows.length && !window.confirm('改用 GPT-6 Luna 重新辨識會取代目前候選品項，並再次上傳這張照片，確定繼續？')) return;
    const token = ++R.token;
    const previousMode = R.recognitionMode;
    R.aiAttemptUploaded = false;
    R.controller = new AbortController();
    const signal = R.controller.signal;
    R.recognitionMode = 'checking-openai';
    R.phase = 'recognizing';
    R.progress = 0;
    R.progressText = '確認 OpenAI 設定…';
    R.note = '';
    R.error = '';
    render();
    try {
      const { AI_PROVIDER, AI_POLICY_DISABLED_MESSAGE, normalizeAiStatus, prepareAiImage, receiptAiPath, sendReceiptToAi } = await import('./receipt-ai-client.js');
      const statusResponse = await fetch(receiptAiPath(account.trip.id), { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal });
      if (!statusResponse.ok) throw new Error('無法確認 OpenAI 辨識服務狀態，請重新整理後再試。');
      const status = normalizeAiStatus(await statusResponse.json());
      if (!status.enabled) throw new Error(status.disabledReason === 'policy' ? AI_POLICY_DISABLED_MESSAGE : 'OpenAI 尚未設定 API key，請先填入本機金鑰檔。');
      if (S.receipt !== R || R.token !== token || signal.aborted) return;
      if (typeof assertSession === 'function') await assertSession();
      R.recognitionMode = 'openai';
      R.progressText = `正在以 ${status.modelId} 傳送至 ${AI_PROVIDER}…`;
      render();
      const image = await prepareAiImage(R.file, { maxBytes: status.maxImageBytes, signal });
      if (S.receipt !== R || R.token !== token || signal.aborted) return;
      R.aiAttemptUploaded = true;
      const result = await sendReceiptToAi({ tripId: account.trip.id, userId: account.user.id, image, signal });
      if (S.receipt !== R || R.token !== token || signal.aborted) return;
      R.aiUploaded = true;
      if (rejectBooked(R)) return;
      const usedLineIds = new Set();
      R.rows = result.items.map((item, index) => ({
        lineId: safeLineId(item.lineId, index, usedLineIds),
        title: cleanText(item.title).slice(0, 100),
        amount: String(item.amount || ''),
        category: EXPENSE_CATEGORIES.includes(item.category) ? item.category : suggestExpenseCategory(item.title),
        warning: cleanText(item.warning),
        selected: !item.warning && toCents(item.amount) !== null
      }));
      R.category = commonReceiptCategory(R.rows, R.category);
      R.parsedTotal = Number.isSafeInteger(result.totalCents) && result.totalCents > 0 ? result.totalCents : null;
      R.totalInput = R.parsedTotal === null ? '' : centsToInput(R.parsedTotal);
      R.date = isIsoDate(result.date) ? result.date : R.date;
      R.text = '';
      R.confidence = null;
      R.parseWarnings = result.warnings;
      R.rowsEdited = false;
      R.discrepancyKey = '';
      R.verified = false;
      R.resultMode = 'openai';
      R.phase = 'review';
      R.note = result.store ? `OpenAI 辨識結果：${result.store}。請逐項核對候選品項與金額。` : 'OpenAI 辨識完成，請逐項核對候選品項與金額。';
      announce(`OpenAI 辨識完成，找到 ${R.rows.length} 個候選品項，請逐項核對。`);
    } catch (err) {
      if (S.receipt !== R || R.token !== token) return;
      R.phase = 'review';
      R.recognitionMode = R.aiUploaded ? 'openai' : previousMode;
      R.note = signal?.aborted || err?.name === 'AbortError'
        ? R.aiAttemptUploaded ? '已停止等待；若照片已送出，無法撤回且仍可能計費。' : '已取消，照片尚未傳送。'
        : `OpenAI 辨識未完成：${err?.message || '請稍後重試或手動輸入。'}`;
      announce(R.note);
    } finally {
      if (S.receipt === R && R.token === token) { R.controller = null; render(); }
    }
  }
  function cancelRecognition(R, note) {
    if (!R || R.phase !== 'recognizing') return;
    R.token++;
    try { R.controller?.abort(); } catch {}
    R.controller = null;
    R.phase = 'review';
    const mode = R.recognitionMode;
    R.recognitionMode = R.resultMode;
    R.note = mode === 'openai'
      ? R.aiAttemptUploaded ? '已停止等待；若照片已送出，無法撤回且仍可能計費。' : '已取消，照片尚未傳送。'
      : mode === 'checking-openai' ? '已取消，照片尚未傳送。' : note;
  }

  function receiptCalc(R) {
    const selected = R.rows.filter(r => r.selected);
    let sum = 0, invalid = 0;
    for (const r of selected) { const c = toCents(r.amount); if (c === null) invalid++; else sum += c; }
    const totalText = R.totalInput.trim();
    const total = totalText ? toCents(totalText) : null;
    const mismatch = total === null || total !== sum;
    const key = `${sum}|${total}|${selected.length}`;
    return { selected, sum, invalid, total, totalInvalid: Boolean(totalText) && total === null, mismatch, key, discrepancyOk: !mismatch || R.discrepancyKey === key };
  }
  function receiptBlockers(R, calc) {
    const out = [];
    const reason = blockReason();
    if (reason) out.push(reason);
    if (R.phase !== 'review') out.push('請等待辨識完成，或先取消辨識。');
    if (!R.id) out.push('無法計算這張圖片的檔案指紋，因此不能儲存收據品項。');
    else if (bookedCount(R.id)) out.push(bookedMessage(bookedCount(R.id)));
    if (!calc.selected.length) out.push('請至少選取一個品項。');
    const seen = new Set();
    R.rows.forEach((r, i) => {
      if (!r.selected) return;
      const t = cleanText(r.title);
      if (!t || chars(t) > 100) out.push(`第 ${i + 1} 列的品名需為 1–100 字。`);
      if (toCents(r.amount) === null) out.push(`第 ${i + 1} 列的金額無效。`);
      if (!EXPENSE_CATEGORIES.includes(r.category)) out.push(`第 ${i + 1} 列的分類無效。`);
      if (seen.has(r.lineId)) out.push(`第 ${i + 1} 列的品項編號重複。`);
      seen.add(r.lineId);
    });
    if (!isIsoDate(R.date)) out.push('請選擇消費日期。');
    const known = new Set(people().map(p => p.id));
    if (!known.has(R.payerId)) out.push('請選擇付款人。');
    if (!R.participantIds.some(pid => known.has(pid))) out.push('請選擇分攤的旅伴。');
    if (!EXPENSE_CATEGORIES.includes(R.category)) out.push('請選擇分類。');
    if (calc.totalInvalid) out.push('收據總額格式不正確。');
    if (!R.verified) out.push(`請勾選「${VERIFY_LABEL}」。`);
    if (!calc.discrepancyOk) out.push('選取品項合計與收據總額不一致：請修正總額，或勾選確認差異。');
    if (S.ledger && S.ledger.expenses.length + calc.selected.length > MAX_ROWS) out.push('帳本最多 1000 筆支出。');
    return [...new Set(out)];
  }
  function commitReceipt() {
    const R = S.receipt;
    if (!R || S.busy || S.pending) return;
    const calc = receiptCalc(R);
    const blockers = receiptBlockers(R, calc);
    if (blockers.length) { R.error = blockers[0]; render(); return; }
    const participantIds = people().map(p => p.id).filter(pid => R.participantIds.includes(pid));
    const records = calc.selected.map(r => ({ id: newId(), date: R.date, title: cleanText(r.title), amountCents: toCents(r.amount), payerId: R.payerId, participantIds: [...participantIds], category: r.category, note: '', shoppingId: '', source: 'receipt', receiptId: R.id, receiptLine: r.lineId }));
    R.error = '';
    void submit({
      label: `收據 ${records.length} 筆品項`, expenses: [...S.ledger.expenses, ...records], settlements: S.ledger.settlements, check: { upsertExpenses: records },
      onSaved: () => {
        if (S.receipt === R) { closeReceipt(); S.editor = null; }
        S.highlight = new Set(records.map(r => r.id));
        S.afterReceipt = records.length;
      }
    });
  }

  function exportDraft() {
    const R = S.receipt;
    const draft = {
      kind: 'little-moments-expense-draft', exportedAt: new Date().toISOString(), tripId: tripId(), ledgerRevision: S.ledger?.revision ?? null,
      pending: S.pending ? { label: S.pending.label, status: S.pending.conflict ? 'conflict' : S.pending.state, request: pendingBody() } : null,
      form: S.form ? { type: S.form.type, mode: S.form.mode, id: S.form.id, origin: S.form.origin || null, values: S.form.values } : null,
      receipt: R ? { receiptId: R.id, date: R.date, payerId: R.payerId, participantIds: R.participantIds, category: R.category, totalInput: R.totalInput, verified: R.verified, rows: R.rows.map(r => ({ lineId: r.lineId, selected: r.selected, title: r.title, amount: r.amount, category: r.category, warning: r.warning })) } : null
    };
    download(`${fileSafe(state()?.trip?.title)}-分帳未存內容.json`, 'application/json', JSON.stringify(draft, null, 2));
  }
  function exportLedgerJson() {
    if (!S.ledger) return;
    download(`${fileSafe(state()?.trip?.title)}-分帳帳本.json`, 'application/json', JSON.stringify({ kind: 'little-moments-ledger', exportedAt: new Date().toISOString(), tripId: tripId(), ledger: S.ledger }, null, 2));
  }
  function exportCsv() {
    if (!S.ledger) return;
    const amount = c => Number(centsToInput(c) || 0);
    const rows = [['類型', '日期', '項目', '金額（TWD）', '付款人', '分攤者／收款人', '分類', '備註', '來源', '收據指紋', '收據品項']];
    for (const x of S.ledger.expenses) rows.push(['支出', x.date, x.title, amount(x.amountCents), nameOf(x.payerId), (x.participantIds || []).map(nameOf).join('、'), x.category, x.note, x.source === 'receipt' ? '收據' : '手動', x.receiptId, x.receiptLine]);
    for (const x of S.ledger.settlements) rows.push(['已還款', x.date, '還款紀錄', amount(x.amountCents), nameOf(x.fromId), nameOf(x.toId), '', x.note, '手動', '', '']);
    download(`${fileSafe(state()?.trip?.title)}-分帳.csv`, 'text/csv;charset=utf-8', `\ufeff${rows.map(r => r.map(csvCell).join(',')).join('\r\n')}\r\n`);
  }
  function download(name, type, text) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.hidden = true;
    element.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    announce(`已匯出 ${name}`);
  }
  function summary() {
    try { return { ok: summarizeLedger(S.ledger) }; } catch (err) { return { error: err?.message || '無法計算結餘' }; }
  }

  const btn = (label, act, { cls = 'small', disabled = false, attrs = '', bid = '' } = {}) => `<button type="button" class="button ${cls}" data-xp="${act}"${bid ? ` id="${id(bid)}"` : ''}${disabled ? ' disabled' : ''} ${attrs}>${label}</button>`;
  const personOptions = (selected, includeIds = []) => {
    const list = people().filter(p => p.current || includeIds.includes(p.id));
    return `<option value="">請選擇</option>${list.map(p => `<option value="${e(p.id)}"${p.id === selected ? ' selected' : ''}>${e(p.name)}${p.current ? '' : '（已不在旅伴名單）'}</option>`).join('')}`;
  };
  const participantChecks = (name, selectedIds, attr) => {
    const list = people().filter(p => p.current || selectedIds.includes(p.id));
    if (!list.length) return '<p class="help">目前沒有旅伴可以選擇。</p>';
    return `<div class="xp-people">${list.map((p, i) => `<label class="xp-check-label" for="${id(`${name}-${i}`)}"><input type="checkbox" id="${id(`${name}-${i}`)}" value="${e(p.id)}" ${attr}${selectedIds.includes(p.id) ? ' checked' : ''}><span>${e(p.name)}${p.current ? '' : '（已不在旅伴名單）'}</span></label>`).join('')}</div>`;
  };
  const frozen = () => Boolean(S.pending || S.busy || S.locked);

  function discardPromptHtml() {
    if (!S.discardPrompt) return '';
    return `<div class="xp-confirm-backdrop"><section class="xp-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="${id('discard-title')}" aria-describedby="${id('discard-message')}"><span class="xp-confirm-mark" aria-hidden="true">!</span><h3 id="${id('discard-title')}">要放棄這份草稿嗎？</h3><p id="${id('discard-message')}">${e(S.discardPrompt.message)}</p><div class="xp-confirm-actions">${btn('繼續編輯', 'keep-discard', { cls: 'small quiet', bid: 'discard-keep' })}${btn('放棄草稿', 'confirm-discard', { cls: 'small danger', bid: 'discard-confirm' })}</div></section></div>`;
  }

  function view() {
    const head = `<header class="xp-head"><span class="eyebrow">SHARE THE COST, KEEP THE MOMENT</span><h2 id="${id('title')}">分帳與收據</h2><p class="help xp-intro">記錄大家先墊付的花費，平均分攤並算出誰該還誰。這裡只做記錄，不會轉帳，也不會連結任何付款服務。</p></header>`;
    if (S.status === 'demo') return `${head}<div class="xp-alert xp-alert-info" data-xp-state="demo"><p><b>分帳需要登入帳號。</b>金額紀錄存放在本機伺服器的帳號資料庫；單機本機模式不會儲存任何分帳資料。請登入帳號並開啟旅行後使用。</p><div class="xp-actions"><a class="button small" href="/login">前往登入</a></div></div>`;
    if (S.status === 'loading') return `${head}<p class="xp-loading" data-xp-state="loading">正在讀取分帳帳本…</p>`;
    if (S.status === 'unavailable') return `${head}<div class="xp-alert" role="alert" data-xp-state="unavailable"><p><b>${BACKEND_OFF}</b></p><p class="help">也可能是這趟旅行已刪除或你沒有存取權限${S.loadError?.message ? `（伺服器訊息：${e(S.loadError.message)}）` : ''}。目前沒有任何金額被儲存或送出。</p><div class="xp-actions">${btn('重新檢查', 'reload', { disabled: S.reloading || Boolean(S.locked), bid: 'reload' })}</div></div>`;
    if (S.status === 'error') {
      const err = S.loadError;
      return `${head}<div class="xp-alert" role="alert" data-xp-state="error"><p>${e(err?.status === 401 ? '登入狀態已失效，請重新登入後再開啟帳本。' : `讀取分帳帳本失敗：${err?.message || '未知錯誤'}`)}</p><div class="xp-actions">${btn('重試讀取', 'reload', { disabled: S.reloading || Boolean(S.locked), bid: 'reload' })}${err?.status === 401 ? '<a class="button small" href="/login">重新登入</a>' : ''}</div></div>`;
    }
    return `${head}${banners()}${toolbar()}${editorHtml()}${balancesHtml()}${expensesHtml()}${settlementsHtml()}${discardPromptHtml()}`;
  }

  function banners() {
    let html = '';
    if (S.locked) html += `<div class="xp-alert" role="alert" data-xp-state="locked"><p><b>帳本已暫停操作：</b>${e(S.locked)}</p><p class="help">尚未儲存的草稿仍在畫面上，可以先匯出保留。</p>${isDirty() ? `<div class="xp-actions">${btn('匯出未存內容', 'export-draft', { bid: 'lock-export' })}</div>` : ''}</div>`;
    const p = S.pending;
    if (p && p.state === 'sending') html += `<p class="xp-saving" data-xp-state="saving">正在儲存「${e(p.label)}」…請勿關閉頁面。</p>`;
    else if (p) html += `<div class="xp-alert" role="alert" data-xp-state="${p.conflict ? 'conflict' : 'pending'}"><p><b>「${e(p.label)}」尚未確認儲存。</b>${e(p.error)}</p><p class="help">請求編號 ${e(p.requestId)} · 帳本版本 ${e(p.revision)}</p><div class="xp-actions">${btn('匯出未存內容', 'export-draft', { bid: 'pending-export' })}${p.retryable ? btn('以同一筆內容重試', 'retry', { cls: 'small primary', disabled: Boolean(S.locked) || S.busy, bid: 'retry' }) : ''}${btn('重新載入伺服器帳本', 'reload', { disabled: Boolean(S.locked) || S.reloading, bid: 'pending-reload' })}</div></div>`;
    if (S.notice) html += `<p class="xp-notice${S.notice.tone === 'error' ? ' is-error' : ''}"${S.notice.tone === 'error' ? ' role="alert"' : ''} data-xp-state="notice">${e(S.notice.text)}${S.afterReceipt && S.notice.tone === 'ok' ? ' 每個品項都是獨立一筆支出，可在下方明細逐筆「編輯」調整分攤的旅伴。' : ''}</p>`;
    if (!S.perms.canEdit) html += '<p class="xp-notice" data-xp-state="readonly">你目前只能檢視這本帳，不能新增或修改。</p>';
    return html;
  }
  function toolbar() {
    const off = !canMutate();
    const total = S.ledger.expenses.reduce((a, x) => a + (Number.isSafeInteger(x.amountCents) ? x.amountCents : 0), 0);
    return `<div class="xp-toolbar"><p class="xp-total">共 <b>${S.ledger.expenses.length}</b> 筆支出，合計 <b>${e(money(total))}</b></p><div class="xp-actions">${btn('＋ 新增支出', 'new-expense', { cls: 'small primary', disabled: off, bid: 'new-expense' })}${btn('掃描收據', 'open-receipt', { disabled: off, bid: 'open-receipt' })}${btn('記錄已還款', 'new-settlement', { disabled: off, bid: 'new-settlement' })}</div><details class="xp-more"><summary>匯出與重新載入</summary><div class="xp-actions">${btn('匯出 CSV', 'export-csv', { bid: 'export-csv' })}${btn('匯出帳本 JSON', 'export-json', { bid: 'export-json' })}${isDirty() ? btn('匯出未存內容', 'export-draft', { bid: 'export-draft' }) : ''}${btn(S.reloading ? '載入中…' : '重新載入帳本', 'reload', { disabled: S.reloading || S.busy || Boolean(S.locked), bid: 'reload' })}</div></details></div>`;
  }
  function editorHtml() {
    if (S.editor === 'expense' && S.form) return expenseFormHtml();
    if (S.editor === 'settlement' && S.form) return settlementFormHtml();
    if (S.editor === 'receipt') return receiptHtml();
    return '';
  }
  function expenseFormHtml() {
    const f = S.form, v = f.values;
    const off = frozen();
    const original = f.mode === 'edit' ? S.ledger.expenses.find(x => x.id === f.id) : null;
    const items = shopping();
    const missingLink = v.shoppingId && !items.some(s => s.id === v.shoppingId);
    return `<form class="xp-editor" id="${id('expense-form')}" data-xp-form="expense" novalidate aria-labelledby="${id('expense-heading')}"><h3 id="${id('expense-heading')}">${f.mode === 'edit' ? '編輯支出' : '新增支出'}</h3>${f.origin.source === 'receipt' ? '<p class="help">這筆來自收據辨識，可以單獨調整品名、金額與分攤的旅伴；收據指紋與品項編號會保留。</p>' : ''}<fieldset class="xp-fieldset"${off ? ' disabled' : ''}><legend class="xp-sr">支出內容</legend><div class="xp-grid">
<label class="field xp-wide" for="${id('f-title')}">項目名稱<input id="${id('f-title')}" data-xp-field="title" value="${e(v.title)}" maxlength="100" required autocomplete="off" placeholder="例如：超市食材"></label>
<label class="field" for="${id('f-date')}">日期<input id="${id('f-date')}" type="date" data-xp-field="date" value="${e(v.date)}" required></label>
<label class="field" for="${id('f-amount')}">金額（新台幣）<input id="${id('f-amount')}" data-xp-field="amount" value="${e(v.amount)}" inputmode="decimal" autocomplete="off" required placeholder="例如 1280"></label>
<label class="field" for="${id('f-payer')}">付款人<select id="${id('f-payer')}" data-xp-field="payerId" required>${personOptions(v.payerId, [original?.payerId, v.payerId].filter(Boolean))}</select></label>
<label class="field" for="${id('f-category')}">分類<select id="${id('f-category')}" data-xp-field="category">${EXPENSE_CATEGORIES.map(c => `<option${c === v.category ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
<fieldset class="xp-wide xp-sub"><legend>分攤的旅伴（平均分攤）</legend>${participantChecks('f-part', v.participantIds, 'data-xp-field="participantIds"')}<div class="xp-actions">${btn('全選', 'form-all', { bid: 'f-all' })}${btn('清除', 'form-none', { bid: 'f-none' })}</div></fieldset>
<label class="field xp-wide" for="${id('f-shop')}">連結採買品項（選填，只作標示，不會改變採買狀態）<select id="${id('f-shop')}" data-xp-field="shoppingId"><option value="">不連結</option>${items.map(s => `<option value="${e(s.id)}"${s.id === v.shoppingId ? ' selected' : ''}>${e(s.name)}</option>`).join('')}${missingLink ? `<option value="${e(v.shoppingId)}" selected>（原連結的採買品項已移除）</option>` : ''}</select></label>
<label class="field xp-wide" for="${id('f-note')}">備註（選填）<textarea id="${id('f-note')}" data-xp-field="note" rows="2" maxlength="500">${e(v.note)}</textarea></label>
</div></fieldset><p class="form-error" id="${id('f-error')}" role="alert">${e(f.error)}</p><div class="xp-actions xp-form-actions">${btn('取消', 'cancel-editor', { bid: 'f-cancel' })}<button type="submit" class="button small primary" id="${id('f-submit')}"${off ? ' disabled' : ''}>${S.busy ? '儲存中…' : '儲存支出'}</button></div></form>`;
  }
  function settlementFormHtml() {
    const v = S.form.values;
    const off = frozen();
    return `<form class="xp-editor" id="${id('settle-form')}" data-xp-form="settlement" novalidate aria-labelledby="${id('settle-heading')}"><h3 id="${id('settle-heading')}">記錄已還款</h3><p class="help">只在錢已經實際交付後才記錄。這裡不會轉帳，也不會通知任何付款服務。</p><fieldset class="xp-fieldset"${off ? ' disabled' : ''}><legend class="xp-sr">還款內容</legend><div class="xp-grid">
<label class="field" for="${id('s-from')}">付款的旅伴<select id="${id('s-from')}" data-xp-field="fromId">${personOptions(v.fromId, [v.fromId].filter(Boolean))}</select></label>
<label class="field" for="${id('s-to')}">收款的旅伴<select id="${id('s-to')}" data-xp-field="toId">${personOptions(v.toId, [v.toId].filter(Boolean))}</select></label>
<label class="field" for="${id('s-amount')}">實際已付金額（新台幣）<input id="${id('s-amount')}" data-xp-field="amount" value="${e(v.amount)}" inputmode="decimal" autocomplete="off"></label>
<label class="field" for="${id('s-date')}">還款日期<input id="${id('s-date')}" type="date" data-xp-field="date" value="${e(v.date)}"></label>
<label class="field xp-wide" for="${id('s-note')}">備註（選填）<textarea id="${id('s-note')}" data-xp-field="note" rows="2" maxlength="500" placeholder="例如：現金當面交付">${e(v.note)}</textarea></label>
</div></fieldset><p class="form-error" id="${id('s-error')}" role="alert">${e(S.form.error)}</p><div class="xp-actions xp-form-actions">${btn('取消', 'cancel-editor', { bid: 's-cancel' })}<button type="submit" class="button small primary" id="${id('s-submit')}"${off ? ' disabled' : ''}>${S.busy ? '儲存中…' : '記錄這筆還款'}</button></div></form>`;
  }

  function receiptHtml() {
    const R = S.receipt;
    const head = `<h3 id="${id('rc-heading')}">收據辨識</h3>`;
    const picker = `<div class="xp-picker"><label class="field" for="${id('rc-file')}">${R ? '換一張收據圖片（選取後會自動上傳辨識）' : '選擇收據圖片（選取後會自動上傳至 OpenAI；預設 GPT-6 Luna，JPEG／PNG／WebP，10 MB 內）'}<input type="file" id="${id('rc-file')}" class="xp-file" data-xp-file data-xp-receipt-file accept="image/jpeg,image/png,image/webp"${frozen() ? ' disabled' : ''}></label>${S.receiptError ? `<p class="form-error" role="alert" data-xp-receipt-error>${e(S.receiptError)}</p>` : ''}</div>`;
    const close = btn(R ? '放棄這張收據' : '關閉', 'close-receipt', { bid: 'rc-close' });
    if (!R) return `<div class="xp-editor xp-receipt" id="${id('receipt')}" role="group" aria-labelledby="${id('rc-heading')}">${head}${picker}<div class="xp-actions xp-form-actions">${close}</div></div>`;
    let main;
    if (R.phase === 'hashing') main = '<p class="xp-loading">正在讀取圖片…</p>';
    else if (R.phase === 'recognizing') main = `<div class="xp-ocr" data-xp-state="recognizing"><span id="${id('ai-status')}">${e(R.progressText || 'GPT-6 Luna 辨識中…')}</span><div class="xp-actions">${btn('取消辨識', 'cancel-recognition', { bid: 'ai-cancel' })}</div></div>`;
    else main = reviewHtml(R);
    return `<div class="xp-editor xp-receipt" id="${id('receipt')}" role="group" aria-labelledby="${id('rc-heading')}">${head}${picker}<div class="xp-receipt-grid"><figure class="xp-receipt-image"><img src="${e(R.url)}" alt="收據圖片預覽"><figcaption>${(R.size / 1024 / 1024).toFixed(1)} MB · ${R.aiUploaded ? '已傳送至 OpenAI' : R.aiAttemptUploaded ? '可能已傳送至 OpenAI' : '只存在這個分頁'}</figcaption></figure><div class="xp-receipt-main">${R.note ? `<p class="xp-notice" data-xp-receipt-note>${e(R.note)}</p>` : ''}${main}</div></div><div class="xp-actions xp-form-actions">${close}${R.phase === 'review' ? `<button type="button" class="button small primary" data-xp="commit-receipt" id="${id('rc-commit')}"${frozen() ? ' disabled' : ''}>${commitLabel(R)}</button>` : ''}</div></div>`;
  }
  const commitLabel = R => (S.busy ? '儲存中…' : `一次儲存 ${R.rows.filter(r => r.selected).length} 筆品項`);
  function reviewHtml(R) {
    const calc = receiptCalc(R);
    const existing = S.ledger.expenses;
    const soft = r => {
      const c = toCents(r.amount), t = cleanText(r.title);
      return c !== null && t && existing.some(x => x.amountCents === c && cleanText(x.title) === t);
    };
    const rows = R.rows.map((r, i) => {
      const warns = [r.warning, soft(r) ? '帳本已有同名同金額的支出，請確認不是重複' : ''].filter(Boolean);
      return `<li class="xp-cand${r.selected ? ' is-selected' : ''}" data-xp-receipt-row="${i}" data-xp-line="${e(r.lineId)}"><label class="xp-cand-check" for="${id(`row-${i}-sel`)}"><input type="checkbox" id="${id(`row-${i}-sel`)}" data-xp-row="${i}" data-xp-row-key="selected" data-xp-receipt-field="selected"${r.selected ? ' checked' : ''}><span class="xp-sr">選取第 ${i + 1} 列</span></label><input class="xp-input" id="${id(`row-${i}-title`)}" data-xp-row="${i}" data-xp-row-key="title" data-xp-receipt-field="title" value="${e(r.title)}" maxlength="100" aria-label="第 ${i + 1} 列品名"><input class="xp-input xp-amount" id="${id(`row-${i}-amount`)}" data-xp-row="${i}" data-xp-row-key="amount" data-xp-receipt-field="amount" value="${e(r.amount)}" inputmode="decimal" autocomplete="off" aria-label="第 ${i + 1} 列金額（新台幣）"${r.amount && toCents(r.amount) === null ? ' aria-invalid="true"' : ''}><select class="xp-input xp-category" data-xp-row="${i}" data-xp-row-key="category" aria-label="第 ${i + 1} 列分類">${EXPENSE_CATEGORIES.map(c => `<option${c === r.category ? ' selected' : ''}>${c}</option>`).join('')}</select>${warns.length ? `<small class="xp-cand-warn">${e(warns.join('；'))}</small>` : ''}</li>`;
    }).join('');
    return `<fieldset class="xp-fieldset"${frozen() ? ' disabled' : ''}><legend class="xp-sr">收據核對</legend>
<details class="xp-raw"${R.rows.length ? '' : ' open'}><summary>AI 辨識結果</summary><p class="help">AI 不提供原始 OCR 文字；請核對下方候選品項與收據照片。也可以手動輸入辨識文字後重新解析。</p><label class="field" for="${id('rc-text')}"><span class="xp-sr">手動輸入收據辨識文字</span><textarea id="${id('rc-text')}" data-xp-receipt="text" data-xp-receipt-text rows="7" spellcheck="false">${e(R.text)}</textarea></label><div class="xp-actions">${btn('解析手動輸入文字', 'reparse', { bid: 'rc-reparse' })}</div></details>
${R.parseWarnings.length ? `<ul class="xp-warn-list">${R.parseWarnings.map(w => `<li>${e(w)}</li>`).join('')}</ul>` : ''}
<h4 class="xp-subhead">候選品項 <small>勾選要記帳的品項，可逐列修改品名與金額</small></h4>
<ol class="xp-cands" id="${id('rc-rows')}">${rows || '<li class="xp-empty">目前沒有候選品項。</li>'}</ol>
<div class="xp-actions">${btn('＋ 手動新增一列', 'add-row', { bid: 'rc-add-row' })}${btn('全不選', 'rows-none', { bid: 'rc-rows-none' })}${account ? btn('重新使用 GPT-6 Luna 辨識', 'rerun-ai', { bid: 'rc-ai' }) : ''}</div>
<div class="xp-grid">
<label class="field" for="${id('rc-date')}">消費日期<input type="date" id="${id('rc-date')}" data-xp-receipt="date" value="${e(R.date)}" required></label>
<label class="field" for="${id('rc-payer')}">付款人<select id="${id('rc-payer')}" data-xp-receipt="payerId">${personOptions(R.payerId)}</select></label>
<label class="field" for="${id('rc-category')}">分類建議（套用至全部品項）<select id="${id('rc-category')}" data-xp-receipt="category">${EXPENSE_CATEGORIES.map(c => `<option${c === R.category ? ' selected' : ''}>${c}</option>`).join('')}</select><small class="help">AI 會逐項分類；變更此項目會套用至全部品項。</small></label>
<label class="field" for="${id('rc-total')}">收據總額（新台幣，可修正）<input id="${id('rc-total')}" data-xp-receipt="totalInput" value="${e(R.totalInput)}" inputmode="decimal" autocomplete="off" placeholder="${R.parsedTotal === null ? '未辨識到總額' : ''}"></label>
<fieldset class="xp-wide xp-sub"><legend>分攤的旅伴（每個品項平均分攤；儲存後可在明細逐筆調整）</legend>${participantChecks('rc-part', R.participantIds, 'data-xp-receipt="participantIds"')}<div class="xp-actions">${btn('全選', 'rc-all', { bid: 'rc-all' })}${btn('清除', 'rc-none', { bid: 'rc-none' })}</div></fieldset>
</div>
<div class="xp-rc-summary" id="${id('rc-summary')}">${summaryHtml(R, calc)}</div>
<div id="${id('rc-discrepancy')}" data-key="${e(calc.key)}">${discrepancyHtml(R, calc)}</div>
<label class="xp-check-label xp-verify" for="${id('rc-verified')}"><input type="checkbox" id="${id('rc-verified')}" data-xp-receipt="verified"${R.verified ? ' checked' : ''}><span>${VERIFY_LABEL}</span></label>
</fieldset><div id="${id('rc-blockers')}">${blockersHtml(R, calc)}</div>`;
  }
  function summaryHtml(R, calc) {
    return `<p>選取 <b>${calc.selected.length}</b> 項，合計 <b>${e(money(calc.sum))}</b>${calc.invalid ? `（${calc.invalid} 項金額無效）` : ''} · 收據總額 <b>${calc.total === null ? (calc.totalInvalid ? '格式不正確' : '未提供') : e(money(calc.total))}</b>${R.parsedTotal !== null && calc.total !== R.parsedTotal ? `（辨識結果 ${e(money(R.parsedTotal))}，已手動修正）` : ''}</p>`;
  }
  function discrepancyHtml(R, calc) {
    if (!calc.mismatch) return '<p class="xp-ok">品項合計與收據總額一致。</p>';
    const diff = calc.total === null ? '找不到收據總額可以比對' : `相差 ${money(Math.abs(calc.total - calc.sum))}`;
    return `<div class="xp-discrepancy" role="alert"><p>選取品項合計與收據總額不一致：${e(diff)}。可能有折扣、未選取的品項或辨識錯誤；總額與折扣不會自動記帳。</p><label class="xp-check-label" for="${id('rc-disc')}"><input type="checkbox" id="${id('rc-disc')}" data-xp-receipt="discrepancy"${R.discrepancyKey === calc.key ? ' checked' : ''}><span>我已確認差異，仍以選取品項的金額記帳</span></label></div>`;
  }
  function blockersHtml(R, calc) {
    const list = receiptBlockers(R, calc);
    const error = R.error ? `<p class="form-error" role="alert" data-xp-receipt-error>${e(R.error)}</p>` : '';
    return list.length ? `${error}<div class="xp-blockers"><p>儲存前還需要：</p><ul>${list.map(x => `<li>${e(x)}</li>`).join('')}</ul></div>` : error;
  }
  function refreshReceiptLive() {
    const R = S.receipt;
    if (!R || R.phase !== 'review') return;
    const calc = receiptCalc(R);
    const sum = body.querySelector(`#${id('rc-summary')}`);
    if (sum) sum.innerHTML = summaryHtml(R, calc);
    const disc = body.querySelector(`#${id('rc-discrepancy')}`);
    if (disc && disc.dataset.key !== calc.key) { disc.dataset.key = calc.key; disc.innerHTML = discrepancyHtml(R, calc); }
    const blk = body.querySelector(`#${id('rc-blockers')}`);
    if (blk) blk.innerHTML = blockersHtml(R, calc);
    const commit = body.querySelector(`#${id('rc-commit')}`);
    if (commit) commit.textContent = commitLabel(R);
  }

  function balancesHtml() {
    const sum = summary();
    if (sum.error) return `<section class="xp-section"><h3>誰該還誰</h3><p class="xp-notice is-error" role="alert">無法計算結餘：${e(sum.error)}</p></section>`;
    const s = sum.ok || {};
    const balances = (s.balances || []).filter(b => b.paidCents || b.shareCents || b.sentCents || b.receivedCents);
    const transfers = s.transfers || [];
    const off = !canMutate();
    return `<section class="xp-section" aria-labelledby="${id('bal-title')}" data-xp-section="balances"><div class="xp-section-head"><h3 id="${id('bal-title')}">誰該還誰</h3><p class="help">支出 ${e(money(s.totalCents || 0))} · 已記錄還款 ${e(money(s.totalSettledCents || 0))}</p></div>
${balances.length ? `<ul class="xp-balances">${balances.map(b => `<li class="xp-balance" data-xp-person="${e(b.personId)}"><span class="xp-balance-name">${e(b.name || nameOf(b.personId))}</span><span class="xp-balance-net${b.netCents > 0 ? ' is-in' : b.netCents < 0 ? ' is-out' : ''}">${b.netCents > 0 ? `應收回 ${e(money(b.netCents))}` : b.netCents < 0 ? `需補 ${e(money(-b.netCents))}` : '已結清'}</span><small class="xp-balance-meta">已付 ${e(money(b.paidCents))} · 分攤 ${e(money(b.shareCents))}${b.sentCents ? ` · 已還出 ${e(money(b.sentCents))}` : ''}${b.receivedCents ? ` · 已收回 ${e(money(b.receivedCents))}` : ''}</small></li>`).join('')}</ul>` : '<p class="xp-empty">還沒有支出，新增第一筆後就能看到每個人的結餘。</p>'}
<h4 class="xp-subhead">建議還款 <small>僅供參考，不會自動轉帳</small></h4>
${transfers.length ? `<ul class="xp-transfers">${transfers.map((t, i) => `<li class="xp-transfer" data-xp-transfer="${i}"><span><b>${e(nameOf(t.fromId))}</b> → <b>${e(nameOf(t.toId))}</b></span><span class="xp-money">${e(money(t.amountCents))}</span>${btn('記錄已還款', 'settle-suggested', { disabled: off, attrs: `data-xp-index="${i}" aria-label="記錄 ${e(nameOf(t.fromId))} 已還給 ${e(nameOf(t.toId))} ${e(money(t.amountCents))}"`, bid: `settle-${i}` })}</li>`).join('')}</ul>` : '<p class="xp-empty">目前沒有需要還款的人。</p>'}</section>`;
  }
  function confirmRow(kind, rid, text) {
    return `<li class="xp-row is-confirm" data-xp-${kind}="${e(rid)}"><p>${e(text)}</p><div class="xp-actions">${btn('取消', 'cancel-confirm', { bid: 'confirm-cancel' })}${btn('確認移除', 'confirm-remove', { cls: 'small danger', disabled: !canMutate({ remove: true }), bid: 'confirm-remove' })}</div></li>`;
  }
  function expensesHtml() {
    const list = [...S.ledger.expenses].sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.title).localeCompare(String(b.title), 'zh-Hant'));
    const off = !canMutate(), offDel = !canMutate({ remove: true });
    const items = shopping();
    const everyone = people().filter(p => p.current).length;
    const groups = [];
    for (const x of list) { const g = groups.at(-1); if (g && g.date === x.date) g.rows.push(x); else groups.push({ date: x.date, rows: [x] }); }
    const row = x => {
      if (S.confirm?.kind === 'expense' && S.confirm.id === x.id) return confirmRow('expense', x.id, `確定從帳本移除「${x.title}」${money(x.amountCents)}？大家的結餘會跟著改變。`);
      const link = x.shoppingId ? items.find(s => s.id === x.shoppingId)?.name || '已移除的採買品項' : '';
      const ids = x.participantIds || [];
      return `<li class="xp-row${S.highlight.has(x.id) ? ' is-new' : ''}" data-swipe-row data-xp-expense="${e(x.id)}"><div class="xp-row-main"><b class="xp-row-title">${e(x.title)}</b><span class="xp-tag ${CATEGORY_TONE[x.category] || 'peach'}">${e(x.category)}</span>${x.source === 'receipt' ? '<span class="xp-tag paper">收據</span>' : ''}</div><span class="xp-money">${e(money(x.amountCents))}</span><small class="xp-row-meta">${e(nameOf(x.payerId))} 付款 · ${ids.length === everyone ? '全員' : `${ids.length} 人`}平分${ids.length <= 4 ? `（${e(ids.map(nameOf).join('、'))}）` : ''}${link ? ` · 採買：${e(link)}` : ''}${x.note ? ` · ${e(x.note)}` : ''}</small><div class="xp-row-actions">${S.perms.canEdit ? `<button type="button" class="icon-button" data-xp="edit-expense" id="${id(`edit-${x.id}`)}" ${off ? 'disabled' : ''} data-xp-id="${e(x.id)}" aria-label="編輯 ${e(x.title)}" title="編輯支出">${actionIcon('edit')}</button>` : ''}${S.perms.canDelete ? `<button type="button" class="icon-button danger" data-xp="ask-remove-expense" id="${id(`del-${x.id}`)}" ${offDel ? 'disabled' : ''} data-xp-id="${e(x.id)}" aria-label="移除 ${e(x.title)}" title="移除 ${e(x.title)}">${actionIcon('close')}</button>` : ''}</div></li>`;
    };
    return `<section class="xp-section" aria-labelledby="${id('exp-title')}" data-xp-section="expenses"><div class="xp-section-head"><h3 id="${id('exp-title')}">支出明細</h3><p class="help">${list.length} 筆</p></div>${groups.length ? groups.map(g => `<div class="xp-day"><h4 class="xp-day-head"><time datetime="${e(g.date)}">${e(shortDate(g.date))}</time><span>${e(money(g.rows.reduce((a, x) => a + x.amountCents, 0)))}</span></h4><ul class="xp-rows">${g.rows.map(row).join('')}</ul></div>`).join('') : '<p class="xp-empty">還沒有任何支出。按「新增支出」或「掃描收據」開始記帳。</p>'}</section>`;
  }
  function settlementsHtml() {
    const list = [...S.ledger.settlements].sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const offDel = !canMutate({ remove: true });
    const row = x => (S.confirm?.kind === 'settlement' && S.confirm.id === x.id
      ? confirmRow('settlement', x.id, '確定移除這筆還款紀錄？只會修改帳本，不會退回或取消任何實際付款。')
      : `<li class="xp-row" data-swipe-row data-xp-settlement="${e(x.id)}"><div class="xp-row-main"><b class="xp-row-title">${e(nameOf(x.fromId))} → ${e(nameOf(x.toId))}</b></div><span class="xp-money">${e(money(x.amountCents))}</span><small class="xp-row-meta"><time datetime="${e(x.date)}">${e(shortDate(x.date))}</time>${x.note ? ` · ${e(x.note)}` : ''}</small><div class="xp-row-actions">${S.perms.canDelete ? btn('移除', 'ask-remove-settlement', { cls: 'small quiet danger', disabled: offDel, attrs: `data-xp-id="${e(x.id)}" aria-label="移除 ${e(nameOf(x.fromId))} 給 ${e(nameOf(x.toId))} 的還款紀錄"`, bid: `sdel-${x.id}` }) : ''}</div></li>`);
    return `<section class="xp-section" aria-labelledby="${id('set-title')}" data-xp-section="settlements"><div class="xp-section-head"><h3 id="${id('set-title')}">已記錄的還款</h3><p class="help">實際已交付的金額紀錄</p></div>${list.length ? `<ul class="xp-rows">${list.map(row).join('')}</ul>` : '<p class="xp-empty">還沒有記錄任何還款。</p>'}</section>`;
  }

  function render() {
    if (S.destroyed) return;
    const active = document.activeElement;
    const inside = Boolean(active && body.contains(active));
    const focusId = S.focusId || (inside ? active.id : '');
    let selection = null;
    if (!S.focusId && inside && typeof active.selectionStart === 'number') { try { selection = [active.selectionStart, active.selectionEnd]; } catch {} }
    S.focusId = '';
    body.innerHTML = view();
    if (focusId && /^[A-Za-z0-9-]+$/.test(focusId)) {
      const target = body.querySelector(`#${focusId}`);
      if (target && !target.disabled) {
        try { target.focus({ preventScroll: inside }); } catch {}
        if (selection) { try { target.setSelectionRange(...selection); } catch {} }
      }
    }
    notifyDirty();
  }

  function askDiscard(message, onDiscard) {
    const active = document.activeElement;
    S.promptReturnFocusId = body.contains(active) ? active.id : '';
    S.discardPrompt = { message, onDiscard };
    S.focusId = id('discard-keep');
    render();
  }
  function cancelDiscard() {
    if (!S.discardPrompt) return;
    S.discardPrompt = null;
    S.focusId = S.promptReturnFocusId;
    S.promptReturnFocusId = '';
    render();
  }
  function confirmDiscard() {
    const prompt = S.discardPrompt;
    if (!prompt) return;
    S.discardPrompt = null;
    S.promptReturnFocusId = '';
    prompt.onDiscard();
  }

  const actions = {
    reload: () => void load({ ask: true }),
    retry: () => { if (S.pending?.retryable) void attempt(S.pending); },
    'export-draft': exportDraft,
    'export-json': exportLedgerJson,
    'export-csv': exportCsv,
    'new-expense': () => { S.afterReceipt = 0; openExpense(null); },
    'edit-expense': t => { const x = S.ledger?.expenses.find(r => r.id === t.dataset.xpId); if (x) openExpense(x); },
    'new-settlement': () => openSettlement(null),
    'settle-suggested': t => { const tr = summary().ok?.transfers?.[Number(t.dataset.xpIndex)]; if (tr) openSettlement(tr); },
    'open-receipt': () => { S.afterReceipt = 0; openEditor('receipt', null, id('rc-file')); },
    'cancel-editor': () => {
      const discard = () => { closeEditor(); S.focusId = id('new-expense'); render(); };
      if (S.form?.dirty) {
        askDiscard('放棄這份尚未儲存的內容嗎？已儲存的紀錄不受影響。', discard);
        return;
      }
      discard();
    },
    'close-receipt': () => {
      if (S.receipt && !window.confirm('放棄這張收據的辨識與核對內容嗎？已儲存的紀錄不受影響。')) return;
      closeEditor(); S.focusId = id('open-receipt'); render();
    },
    'form-all': () => { if (!S.form) return; S.form.values.participantIds = people().filter(p => p.current).map(p => p.id); S.form.dirty = true; render(); },
    'form-none': () => { if (!S.form) return; S.form.values.participantIds = []; S.form.dirty = true; render(); },
    'rc-all': () => { if (!S.receipt) return; S.receipt.participantIds = people().filter(p => p.current).map(p => p.id); render(); },
    'rc-none': () => { if (!S.receipt) return; S.receipt.participantIds = []; render(); },
    'cancel-recognition': () => { cancelRecognition(S.receipt, '已取消 GPT-6 Luna 辨識。若照片已送出，無法撤回且仍可能計費。'); S.focusId = id('rc-text'); render(); },
    'rerun-ai': () => { if (S.receipt) void runAi(S.receipt); },
    reparse: () => {
      const R = S.receipt;
      if (!R || frozen()) return;
      if (R.rowsEdited && !window.confirm('重新解析會取代目前候選品項的修改與勾選，確定繼續？')) return;
      reparse(R); R.error = ''; R.note = R.rows.length ? '' : '沒有找到可用的品項，可以手動新增一列。'; render();
    },
    'add-row': () => {
      const R = S.receipt;
      if (!R || frozen()) return;
      const used = new Set(R.rows.map(r => r.lineId));
      let lineId;
      do { lineId = `manual-${++R.manualSeq}`; } while (used.has(lineId));
      R.rows.push({ lineId, title: '', amount: '', category: R.category, warning: '手動新增', selected: true });
      R.rowsEdited = true;
      S.focusId = id(`row-${R.rows.length - 1}-title`);
      render();
    },
    'rows-none': () => { const R = S.receipt; if (!R) return; R.rows.forEach(r => { r.selected = false; }); R.rowsEdited = true; render(); },
    'commit-receipt': commitReceipt,
    'receipt-cancel': () => actions['cancel-recognition'](),
    'ask-remove-expense': t => { if (canMutate({ remove: true })) { S.confirm = { kind: 'expense', id: t.dataset.xpId }; S.focusId = id('confirm-cancel'); render(); } },
    'ask-remove-settlement': t => { if (canMutate({ remove: true })) { S.confirm = { kind: 'settlement', id: t.dataset.xpId }; S.focusId = id('confirm-cancel'); render(); } },
    'cancel-confirm': () => { S.confirm = null; render(); },
    'keep-discard': cancelDiscard,
    'confirm-discard': confirmDiscard,
    'confirm-remove': () => { const c = S.confirm; if (c && canMutate({ remove: true })) removeRow(c.kind, c.id); }
  };

  function onClick(event) {
    if (event.target.matches?.('.xp-confirm-backdrop')) { cancelDiscard(); return; }
    const target = event.target.closest?.('[data-xp]');
    if (!target || !body.contains(target) || target.disabled) return;
    const handler = actions[target.dataset.xp];
    if (!handler) return;
    event.preventDefault();
    handler(target, event);
  }
  function onKeydown(event) {
    if (!S.discardPrompt) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelDiscard();
      return;
    }
    if (event.key !== 'Tab') return;
    const buttons = [...body.querySelectorAll('.xp-confirm-dialog button:not(:disabled)')];
    if (!buttons.length) return;
    const first = buttons[0], last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  function onField(event) {
    const t = event.target;
    if (!body.contains(t)) return;
    if (t.matches('[data-xp-file]')) {
      if (event.type === 'change') { const file = t.files?.[0]; t.value = ''; void pickReceiptFile(file); }
      return;
    }
    const field = t.dataset.xpField;
    if (field && S.form) {
      if (field === 'participantIds') S.form.values.participantIds = [...t.closest('form').querySelectorAll('[data-xp-field="participantIds"]:checked')].map(x => x.value);
      else S.form.values[field] = t.value;
      S.form.dirty = true;
      if (S.form.error) { S.form.error = ''; const box = t.closest('form')?.querySelector('.form-error'); if (box) box.textContent = ''; }
      notifyDirty();
      return;
    }
    const R = S.receipt;
    if (!R) return;
    if (t.dataset.xpRow !== undefined) {
      const row = R.rows[Number(t.dataset.xpRow)];
      if (!row) return;
      const key = t.dataset.xpRowKey;
      if (key === 'selected') { row.selected = t.checked; t.closest('li')?.classList.toggle('is-selected', row.selected); }
      else if (key === 'title') row.title = t.value;
      else if (key === 'amount') { row.amount = t.value; if (t.value.trim() && toCents(t.value) === null) t.setAttribute('aria-invalid', 'true'); else t.removeAttribute('aria-invalid'); }
      else if (key === 'category' && EXPENSE_CATEGORIES.includes(t.value)) { row.category = t.value; R.category = commonReceiptCategory(R.rows, R.category); }
      R.rowsEdited = true;
      R.error = '';
      refreshReceiptLive();
      return;
    }
    const rk = t.dataset.xpReceipt;
    if (!rk) return;
    if (rk === 'participantIds') R.participantIds = [...body.querySelectorAll('[data-xp-receipt="participantIds"]:checked')].map(x => x.value);
    else if (rk === 'verified') R.verified = t.checked;
    else if (rk === 'discrepancy') R.discrepancyKey = t.checked ? receiptCalc(R).key : '';
    else if (rk === 'text') { R.text = t.value; return; }
    else if (rk === 'category' && EXPENSE_CATEGORIES.includes(t.value)) {
      R.category = t.value;
      R.rows.forEach(row => { row.category = t.value; });
    } else R[rk] = t.value;
    R.error = '';
    refreshReceiptLive();
  }
  function onSubmit(event) {
    const form = event.target;
    if (!body.contains(form)) return;
    event.preventDefault();
    if (!S.form || frozen()) return;
    if (form.dataset.xpForm === 'expense') saveExpense();
    else if (form.dataset.xpForm === 'settlement') saveSettlement();
  }

  element.addEventListener('click', onClick);
  element.addEventListener('input', onField);
  element.addEventListener('change', onField);
  element.addEventListener('submit', onSubmit);
  element.addEventListener('keydown', onKeydown);

  render();
  if (account) void load();

  return {
    element,
    isDirty,
    discard() {
      if (S.destroyed) return;
      closeEditor();
      S.pending = null;
      S.confirm = null;
      S.discardPrompt = null;
      S.promptReturnFocusId = '';
      S.notice = null;
      render();
    },
    lock(message) {
      if (S.destroyed) return;
      S.locked = cleanText(message) || '登入狀態已變更，帳本暫停操作。';
      cancelRecognition(S.receipt, '帳本已暫停操作，辨識已取消。核對中的內容仍保留，可以匯出。');
      S.confirm = null;
      S.discardPrompt = null;
      S.promptReturnFocusId = '';
      render();
    },
    destroy() {
      if (S.destroyed) return;
      closeReceipt();
      S.destroyed = true;
      element.removeEventListener('click', onClick);
      element.removeEventListener('input', onField);
      element.removeEventListener('change', onField);
      element.removeEventListener('submit', onSubmit);
      element.removeEventListener('keydown', onKeydown);
      body.innerHTML = '';
      element.remove();
    }
  };
}
