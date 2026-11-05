export const MAX_AMOUNT_CENTS = 100000000;
export { EXPENSE_CATEGORIES } from './expense-categories.js';

const isCents = value => Number.isSafeInteger(value);
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function parseAmount(value) {
  let text;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('請輸入有效的金額。');
    text = String(value);
    if (/e/i.test(text)) throw new Error('請輸入有效的金額。');
  } else if (typeof value === 'string') {
    text = value.normalize('NFKC').trim().replace(/^(?:NT\$|NTD|TWD|\$)\s*/i, '').replace(/\s*元$/, '');
    if (/^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/.test(text)) text = text.replace(/,/g, '');
  } else throw new Error('請輸入金額。');
  if (!text) throw new Error('請輸入金額。');
  if (text.startsWith('-')) throw new Error('金額必須大於 0。');
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(text);
  if (!match) throw new Error(/^\d*\.\d{3,}$/.test(text) ? '金額最多到小數點後兩位（角、分）。' : '請輸入有效的金額，例如 350 或 120.5。');
  const whole = match[1].replace(/^0+(?=\d)/, '');
  if (whole.length > 7) throw new Error('單筆金額最多 NT$1,000,000。');
  const cents = Number(whole) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (cents <= 0) throw new Error('金額必須大於 0。');
  if (cents > MAX_AMOUNT_CENTS) throw new Error('單筆金額最多 NT$1,000,000。');
  return cents;
}

export function formatMoney(cents) {
  if (!isCents(cents)) throw new TypeError('金額必須是整數（分）。');
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = abs % 100;
  return `${sign}NT$${whole}${fraction ? `.${String(fraction).padStart(2, '0')}` : ''}`;
}

export function splitEvenly(amountCents, participantIds) {
  if (!isCents(amountCents) || amountCents <= 0) throw new Error('分攤金額必須是大於 0 的整數（分）。');
  if (!Array.isArray(participantIds) || !participantIds.length) throw new Error('請至少選擇一位分攤旅伴。');
  if (!participantIds.every(id => typeof id === 'string' && id)) throw new Error('分攤旅伴資料不正確。');
  if (new Set(participantIds).size !== participantIds.length) throw new Error('分攤旅伴不能重複。');
  const ids = [...participantIds].sort(byId);
  const base = Math.floor(amountCents / ids.length), remainder = amountCents - base * ids.length;
  return ids.map((personId, index) => ({ personId, amountCents: base + (index < remainder ? 1 : 0) }));
}

function settleUp(balances) {
  const take = sign => balances.filter(b => Math.sign(b.netCents) === sign).map(b => ({ id: b.personId, left: Math.abs(b.netCents) }))
    .sort((a, b) => b.left - a.left || byId(a.id, b.id));
  const debtors = take(-1), creditors = take(1), transfers = [];
  let d = 0, c = 0;
  while (d < debtors.length && c < creditors.length) {
    const amountCents = Math.min(debtors[d].left, creditors[c].left);
    transfers.push({ fromId: debtors[d].id, toId: creditors[c].id, amountCents });
    debtors[d].left -= amountCents;
    creditors[c].left -= amountCents;
    if (!debtors[d].left) d++;
    if (!creditors[c].left) c++;
  }
  return transfers;
}

export function summarizeLedger(ledger) {
  const people = Array.isArray(ledger?.people) ? ledger.people : [];
  const expenses = Array.isArray(ledger?.expenses) ? ledger.expenses : [];
  const settlements = Array.isArray(ledger?.settlements) ? ledger.settlements : [];
  const rows = new Map();
  const row = (personId, name = '已移除的旅伴') => {
    if (!rows.has(personId)) rows.set(personId, { personId, name, paidCents: 0, shareCents: 0, sentCents: 0, receivedCents: 0, netCents: 0 });
    return rows.get(personId);
  };
  for (const person of people) if (person && typeof person.id === 'string') row(person.id, String(person.name ?? ''));
  const known = rows.size;
  let totalCents = 0, totalSettledCents = 0;
  for (const expense of expenses) {
    if (!isCents(expense?.amountCents) || expense.amountCents <= 0) throw new TypeError('支出金額必須是大於 0 的整數（分）。');
    totalCents += expense.amountCents;
    row(expense.payerId).paidCents += expense.amountCents;
    for (const share of splitEvenly(expense.amountCents, expense.participantIds)) row(share.personId).shareCents += share.amountCents;
  }
  for (const settlement of settlements) {
    if (!isCents(settlement?.amountCents) || settlement.amountCents <= 0) throw new TypeError('還款金額必須是大於 0 的整數（分）。');
    totalSettledCents += settlement.amountCents;
    row(settlement.fromId).sentCents += settlement.amountCents;
    row(settlement.toId).receivedCents += settlement.amountCents;
  }
  const all = [...rows.values()];
  const balances = [...all.slice(0, known), ...all.slice(known).sort((a, b) => byId(a.personId, b.personId))];
  for (const b of balances) b.netCents = b.paidCents - b.shareCents + b.sentCents - b.receivedCents;
  return { totalCents, totalSettledCents, balances, transfers: settleUp(balances) };
}
