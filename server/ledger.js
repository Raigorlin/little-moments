import { createHash } from 'node:crypto';

export const LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS trip_ledgers (
  trip_id TEXT PRIMARY KEY REFERENCES trips(id), revision INTEGER NOT NULL CHECK (revision >= 1),
  ledger_json TEXT NOT NULL, requests_json TEXT NOT NULL, updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at INTEGER NOT NULL
);`;

export const LEDGER_LIMITS = { rows: 1000, participants: 100, title: 100, note: 500, maxCents: 100000000, requests: 200 };
import { EXPENSE_CATEGORIES as CATEGORIES } from '../src/expense-categories.js';
const SOURCES = ['manual', 'receipt'];
const ID = /^[A-Za-z0-9-]{1,64}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BODY_KEYS = ['expectedUserId', 'revision', 'requestId', 'expenses', 'settlements'];
const EXPENSE_KEYS = ['id', 'date', 'title', 'amountCents', 'payerId', 'participantIds', 'category', 'note', 'shoppingId', 'source', 'receiptId', 'receiptLine'];
const SETTLEMENT_KEYS = ['id', 'date', 'fromId', 'toId', 'amountCents', 'note'];
const REMOVED_NAME = '已移除的旅伴';

export class LedgerError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const reject = (message, status = 400) => { throw new LedgerError(status, message); };
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isPlainObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export const emptyLedger = () => ({ people: [], expenses: [], settlements: [] });

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const requestHash = body => createHash('sha256').update(canonical({ revision: body.revision, expenses: body.expenses, settlements: body.settlements })).digest('hex');

const isDate = value => typeof value === 'string' && DATE.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const isCents = value => Number.isSafeInteger(value) && value > 0 && value <= LEDGER_LIMITS.maxCents;

function text(value, max, label, { required = false, multiline = false } = {}) {
  if (typeof value !== 'string') reject(`${label}格式不正確。`);
  const trimmed = value.normalize('NFC').trim();
  if (required && !trimmed) reject(`請填寫${label}。`);
  if ([...trimmed].length > max) reject(`${label}最多 ${max} 個字。`);
  const hidden = multiline ? /[\p{Cc}\p{Cf}]/u.test(trimmed.replace(/\r?\n|\t/g, '')) : /[\p{Cc}\p{Cf}]/u.test(trimmed);
  if (hidden) reject(`${label}不能包含隱藏控制字元。`);
  return trimmed;
}

const CORRUPT = '分帳資料無法讀取，請聯絡管理員協助檢查。';
const isId = value => typeof value === 'string' && ID.test(value);
const uniqueIds = list => new Set(list.map(row => row.id)).size === list.length;
const storedExpense = e => exactKeys(e, EXPENSE_KEYS) && isId(e.id) && isDate(e.date) && typeof e.title === 'string' && isCents(e.amountCents) && isId(e.payerId)
  && Array.isArray(e.participantIds) && e.participantIds.length >= 1 && e.participantIds.length <= LEDGER_LIMITS.participants && e.participantIds.every(isId) && new Set(e.participantIds).size === e.participantIds.length
  && CATEGORIES.includes(e.category) && typeof e.note === 'string' && (e.shoppingId === '' || isId(e.shoppingId))
  && (e.source === 'manual' ? e.receiptId === '' && e.receiptLine === '' : e.source === 'receipt' && FINGERPRINT.test(e.receiptId) && isId(e.receiptLine));
const storedSettlement = r => exactKeys(r, SETTLEMENT_KEYS) && isId(r.id) && isDate(r.date) && isId(r.fromId) && isId(r.toId) && r.fromId !== r.toId && isCents(r.amountCents) && typeof r.note === 'string';

// Stored money is re-checked on every read so a damaged row fails loudly instead of being summarized or carried into the next write.
function parseStored(json) {
  let data;
  try { data = JSON.parse(json); } catch { data = null; }
  if (!exactKeys(data, ['people', 'expenses', 'settlements']) || !['people', 'expenses', 'settlements'].every(key => Array.isArray(data[key]))) reject(CORRUPT, 500);
  if (data.expenses.length > LEDGER_LIMITS.rows || data.settlements.length > LEDGER_LIMITS.rows) reject(CORRUPT, 500);
  if (!data.people.every(p => exactKeys(p, ['id', 'name']) && isId(p.id) && typeof p.name === 'string') || !uniqueIds(data.people)) reject(CORRUPT, 500);
  if (!data.expenses.every(storedExpense) || !uniqueIds(data.expenses)) reject(CORRUPT, 500);
  if (!data.settlements.every(storedSettlement) || !uniqueIds(data.settlements)) reject(CORRUPT, 500);
  return data;
}

export function readLedgerRow(row) {
  if (!row) return { revision: 0, ledger: emptyLedger(), requests: [] };
  if (!Number.isSafeInteger(row.revision) || row.revision < 1) reject(CORRUPT, 500);
  let requests;
  try { requests = JSON.parse(row.requests_json); } catch { requests = null; }
  const validRequest = r => exactKeys(r, ['id', 'userId', 'hash']) && isId(r.id) && isId(r.userId) && FINGERPRINT.test(r.hash);
  if (!Array.isArray(requests) || requests.length > LEDGER_LIMITS.requests || !requests.every(validRequest)) reject(CORRUPT, 500);
  return { revision: row.revision, ledger: parseStored(row.ledger_json), requests };
}

const references = ledger => {
  const ids = new Set();
  for (const e of ledger.expenses) { ids.add(e.payerId); for (const id of e.participantIds || []) ids.add(id); }
  for (const s of ledger.settlements) { ids.add(s.fromId); ids.add(s.toId); }
  return ids;
};

// Current trip names win; people no longer in the trip keep their last snapshot while any money row still references them.
export function mergePeople(snapshot, statePeople, ledger) {
  const current = statePeople.map(p => ({ id: p.id, name: p.name }));
  const currentIds = new Set(current.map(p => p.id));
  const used = references(ledger);
  const known = new Map(snapshot.map(p => [p.id, p.name]));
  const historical = [...used].filter(id => typeof id === 'string' && !currentIds.has(id)).sort()
    .map(id => ({ id, name: known.get(id) || REMOVED_NAME }));
  return [...current, ...historical];
}

export function refreshSnapshotNames(ledger, statePeople, removedIds) {
  const names = new Map(statePeople.filter(p => removedIds.has(p.id)).map(p => [p.id, p.name]));
  const used = references(ledger);
  const people = ledger.people.filter(p => !names.has(p.id));
  for (const [id, name] of names) if (used.has(id)) people.push({ id, name });
  return { ...ledger, people };
}

function partyChecker(currentIds, label) {
  return (id, previous, field) => {
    if (typeof id !== 'string' || !ID.test(id)) reject(`${label}${field}格式不正確。`);
    if (!currentIds.has(id) && !previous.has(id)) reject(`${label}${field}不是這趟旅行目前的旅伴。`);
    return id;
  };
}

function validateExpense(item, index, { stored, currentIds, shoppingIds, fingerprints }) {
  const label = `第 ${index + 1} 筆支出：`;
  if (!exactKeys(item, EXPENSE_KEYS)) reject(`${label}欄位不完整或包含不支援的欄位。`);
  if (typeof item.id !== 'string' || !ID.test(item.id)) reject(`${label}編號格式不正確。`);
  const old = stored.get(item.id);
  const party = partyChecker(currentIds, label);
  if (!isDate(item.date)) reject(`${label}日期需為有效的 YYYY-MM-DD。`);
  if (!isCents(item.amountCents)) reject(`${label}金額需介於 NT$0.01 到 NT$1,000,000，並以整數「分」送出。`);
  const payerId = party(item.payerId, new Set(old ? [old.payerId] : []), '付款人');
  if (!Array.isArray(item.participantIds) || item.participantIds.length < 1 || item.participantIds.length > LEDGER_LIMITS.participants) reject(`${label}分攤旅伴需為 1 到 ${LEDGER_LIMITS.participants} 位。`);
  if (new Set(item.participantIds).size !== item.participantIds.length) reject(`${label}分攤旅伴不能重複。`);
  const oldParticipants = new Set(old?.participantIds || []);
  const participantIds = item.participantIds.map(id => party(id, oldParticipants, '分攤旅伴'));
  if (!CATEGORIES.includes(item.category)) reject(`${label}分類需為 ${CATEGORIES.join(' / ')}。`);
  if (typeof item.shoppingId !== 'string' || (item.shoppingId && !ID.test(item.shoppingId))) reject(`${label}採買連結格式不正確。`);
  if (item.shoppingId && item.shoppingId !== old?.shoppingId && !shoppingIds.has(item.shoppingId)) reject(`${label}找不到連結的採買品項，請重新選擇。`);
  if (!SOURCES.includes(item.source)) reject(`${label}來源需為 manual 或 receipt。`);
  if (item.source === 'manual') {
    if (item.receiptId !== '' || item.receiptLine !== '') reject(`${label}手動輸入的支出不能帶收據資料。`);
  } else {
    if (typeof item.receiptId !== 'string' || !FINGERPRINT.test(item.receiptId)) reject(`${label}收據指紋需為 64 位小寫十六進位 SHA-256。`);
    if (typeof item.receiptLine !== 'string' || !ID.test(item.receiptLine)) reject(`${label}收據行號格式不正確。`);
    const key = `${item.receiptId}:${item.receiptLine}`;
    if (fingerprints.has(key)) reject(`${label}同一張收據的這一行已經記帳，請勿重複加入。`, 409);
    fingerprints.add(key);
  }
  return {
    id: item.id, date: item.date, title: text(item.title, LEDGER_LIMITS.title, `${label}項目名稱`, { required: true }),
    amountCents: item.amountCents, payerId, participantIds, category: item.category,
    note: text(item.note, LEDGER_LIMITS.note, `${label}備註`, { multiline: true }), shoppingId: item.shoppingId,
    source: item.source, receiptId: item.receiptId, receiptLine: item.receiptLine
  };
}

function validateSettlement(item, index, { stored, currentIds, historicalIds }) {
  const label = `第 ${index + 1} 筆還款：`;
  if (!exactKeys(item, SETTLEMENT_KEYS)) reject(`${label}欄位不完整或包含不支援的欄位。`);
  if (typeof item.id !== 'string' || !ID.test(item.id)) reject(`${label}編號格式不正確。`);
  const old = stored.get(item.id);
  const party = partyChecker(currentIds, label);
  if (!isDate(item.date)) reject(`${label}日期需為有效的 YYYY-MM-DD。`);
  if (!isCents(item.amountCents)) reject(`${label}金額需介於 NT$0.01 到 NT$1,000,000，並以整數「分」送出。`);
  const fromId = party(item.fromId, new Set([...historicalIds, ...(old ? [old.fromId] : [])]), '付款人');
  const toId = party(item.toId, new Set([...historicalIds, ...(old ? [old.toId] : [])]), '收款人');
  if (fromId === toId) reject(`${label}付款人與收款人不能是同一位。`);
  return { id: item.id, date: item.date, fromId, toId, amountCents: item.amountCents, note: text(item.note, LEDGER_LIMITS.note, `${label}備註`, { multiline: true }) };
}

const isScalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);
// Rows must be flat before the recursive request hash runs, so hostile nesting cannot exhaust the stack.
function assertFlatRow(row, label, listKey) {
  if (!isPlainObject(row)) reject(`${label}欄位不完整或包含不支援的欄位。`);
  for (const [key, value] of Object.entries(row)) {
    if (isScalar(value)) continue;
    if (key === listKey && Array.isArray(value) && value.every(isScalar)) continue;
    reject(`${label}欄位不完整或包含不支援的欄位。`);
  }
}

export function validateLedgerBody(body) {
  const unknown = Object.keys(body).filter(key => !BODY_KEYS.includes(key));
  if (unknown.length) reject('分帳資料包含不支援的欄位，未儲存。');
  if (typeof body.expectedUserId !== 'string') reject('缺少目前登入帳號 expectedUserId。');
  if (!Number.isSafeInteger(body.revision) || body.revision < 0) reject('缺少分帳版本號 revision。');
  if (typeof body.requestId !== 'string' || !ID.test(body.requestId)) reject('缺少或無效的請求編號 requestId。');
  if (!Array.isArray(body.expenses) || !Array.isArray(body.settlements)) reject('分帳資料格式不正確。');
  if (body.expenses.length > LEDGER_LIMITS.rows) reject(`支出最多 ${LEDGER_LIMITS.rows} 筆。`);
  if (body.settlements.length > LEDGER_LIMITS.rows) reject(`還款紀錄最多 ${LEDGER_LIMITS.rows} 筆。`);
  body.expenses.forEach((row, i) => assertFlatRow(row, `第 ${i + 1} 筆支出：`, 'participantIds'));
  body.settlements.forEach((row, i) => assertFlatRow(row, `第 ${i + 1} 筆還款：`, null));
}

export function buildLedger(body, { stored, state, canDelete }) {
  const currentIds = new Set(state.people.map(p => p.id));
  const shoppingIds = new Set(state.shopping.map(s => s.id));
  const oldExpenses = new Map(stored.expenses.map(e => [e.id, e]));
  const oldSettlements = new Map(stored.settlements.map(s => [s.id, s]));
  const fingerprints = new Set();
  const expenses = body.expenses.map((item, i) => validateExpense(item, i, { stored: oldExpenses, currentIds, shoppingIds, fingerprints }));
  // Repayments may settle old debt with people who already left the trip; new expenses may not add them.
  const historicalIds = new Set([...references(stored)].filter(id => typeof id === 'string' && ID.test(id)));
  const settlements = body.settlements.map((item, i) => validateSettlement(item, i, { stored: oldSettlements, currentIds, historicalIds }));
  if (new Set(expenses.map(e => e.id)).size !== expenses.length) reject('支出編號重複，未儲存。');
  if (new Set(settlements.map(s => s.id)).size !== settlements.length) reject('還款紀錄編號重複，未儲存。');
  if (!canDelete) {
    const keptExpenses = new Set(expenses.map(e => e.id)), keptSettlements = new Set(settlements.map(s => s.id));
    if ([...oldExpenses.keys()].some(id => !keptExpenses.has(id)) || [...oldSettlements.keys()].some(id => !keptSettlements.has(id))) reject('受邀旅伴可以新增或修改帳目，但不能刪除既有帳目；請聯絡主辦人或管理員。', 403);
  }
  const ledger = { people: [], expenses, settlements };
  ledger.people = mergePeople(stored.people, state.people, ledger);
  return ledger;
}

export function ledgerView(revision, ledger, statePeople) {
  return { schema: 1, revision, people: mergePeople(ledger.people, statePeople, ledger), expenses: ledger.expenses, settlements: ledger.settlements };
}
