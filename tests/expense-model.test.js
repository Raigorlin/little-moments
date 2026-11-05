import { describe, test, expect } from 'bun:test';
import { parseAmount, formatMoney, splitEvenly, summarizeLedger, MAX_AMOUNT_CENTS } from '../src/expense-model.js';

describe('parseAmount', () => {
  test('parses TWD text and numbers into positive integer cents', () => {
    expect(parseAmount('350')).toBe(35000);
    expect(parseAmount('120.5')).toBe(12050);
    expect(parseAmount('0.01')).toBe(1);
    expect(parseAmount(' NT$1,234.56 ')).toBe(123456);
    expect(parseAmount('$99')).toBe(9900);
    expect(parseAmount('１２０元')).toBe(12000);
    expect(parseAmount('12.')).toBe(1200);
    expect(parseAmount(88)).toBe(8800);
    expect(parseAmount(19.99)).toBe(1999);
    expect(parseAmount('1000000')).toBe(MAX_AMOUNT_CENTS);
  });
  test('rejects zero, negative, oversized, imprecise and malformed input', () => {
    for (const value of ['', '  ', '0', '0.00', '-5', -5, '1000000.01', '99999999', '1.234', 0.1 + 0.2, 'abc', '1,23', '1e3', 1e21, NaN, Infinity, null, undefined, {}, '12,345,6', '١٢٣', '0x10'])
      expect(() => parseAmount(value)).toThrow();
  });
  test('error messages are Chinese and user-facing', () => {
    expect(() => parseAmount('-1')).toThrow('金額必須大於 0。');
    expect(() => parseAmount('1.234')).toThrow('小數點後兩位');
    expect(() => parseAmount('2000000')).toThrow('NT$1,000,000');
  });
});

describe('formatMoney', () => {
  test('prints TWD with grouping, cents only when present, negatives allowed', () => {
    expect(formatMoney(0)).toBe('NT$0');
    expect(formatMoney(1)).toBe('NT$0.01');
    expect(formatMoney(35000)).toBe('NT$350');
    expect(formatMoney(123456)).toBe('NT$1,234.56');
    expect(formatMoney(100000000)).toBe('NT$1,000,000');
    expect(formatMoney(-12050)).toBe('-NT$120.50');
    expect(parseAmount(formatMoney(123456))).toBe(123456);
  });
  test('rejects non-integer cents', () => {
    for (const value of [1.5, NaN, '100', null, 2 ** 60]) expect(() => formatMoney(value)).toThrow();
  });
});

describe('splitEvenly', () => {
  test('conserves the total and gives remainders to the first sorted ids', () => {
    expect(splitEvenly(1000, ['c', 'a', 'b'])).toEqual([{ personId: 'a', amountCents: 334 }, { personId: 'b', amountCents: 333 }, { personId: 'c', amountCents: 333 }]);
    expect(splitEvenly(1, ['z', 'y'])).toEqual([{ personId: 'y', amountCents: 1 }, { personId: 'z', amountCents: 0 }]);
    expect(splitEvenly(500, ['solo'])).toEqual([{ personId: 'solo', amountCents: 500 }]);
  });
  test('result is independent of input order', () => {
    expect(splitEvenly(1001, ['p3', 'p1', 'p2'])).toEqual(splitEvenly(1001, ['p2', 'p3', 'p1']));
  });
  test('conservation holds across many amounts and group sizes', () => {
    for (let n = 1; n <= 13; n++) {
      const ids = Array.from({ length: n }, (_, i) => `p${i}`);
      for (const amount of [1, 7, 99, 100, 101, 12345, 99999999, 100000000]) {
        const parts = splitEvenly(amount, ids);
        expect(parts.reduce((s, p) => s + p.amountCents, 0)).toBe(amount);
        expect(Math.max(...parts.map(p => p.amountCents)) - Math.min(...parts.map(p => p.amountCents))).toBeLessThanOrEqual(1);
      }
    }
  });
  test('rejects invalid amounts and participants', () => {
    for (const [amount, ids] of [[0, ['a']], [-1, ['a']], [1.5, ['a']], [100, []], [100, ['a', 'a']], [100, ['']], [100, 'ab'], [100, [1]]])
      expect(() => splitEvenly(amount, ids)).toThrow();
  });
});

describe('summarizeLedger', () => {
  const people = [{ id: 'p1', name: '小安' }, { id: 'p2', name: '阿哲' }, { id: 'p3', name: '小雨' }, { id: 'p4', name: '米米' }];
  const expense = (id, amountCents, payerId, participantIds) => ({ id, date: '2026-11-20', title: id, amountCents, payerId, participantIds, category: '食材', note: '', shoppingId: '', source: 'manual', receiptId: '', receiptLine: '' });
  const settle = (id, fromId, toId, amountCents) => ({ id, date: '2026-11-22', fromId, toId, amountCents, note: '' });

  test('positive net means should receive; includes everyone in ledger.people', () => {
    const s = summarizeLedger({ schema: 1, revision: 1, people, expenses: [expense('e1', 900, 'p1', ['p1', 'p2', 'p3'])], settlements: [] });
    expect(s.totalCents).toBe(900);
    expect(s.totalSettledCents).toBe(0);
    expect(s.balances).toEqual([
      { personId: 'p1', name: '小安', paidCents: 900, shareCents: 300, sentCents: 0, receivedCents: 0, netCents: 600 },
      { personId: 'p2', name: '阿哲', paidCents: 0, shareCents: 300, sentCents: 0, receivedCents: 0, netCents: -300 },
      { personId: 'p3', name: '小雨', paidCents: 0, shareCents: 300, sentCents: 0, receivedCents: 0, netCents: -300 },
      { personId: 'p4', name: '米米', paidCents: 0, shareCents: 0, sentCents: 0, receivedCents: 0, netCents: 0 }
    ]);
    expect(s.transfers).toEqual([{ fromId: 'p2', toId: 'p1', amountCents: 300 }, { fromId: 'p3', toId: 'p1', amountCents: 300 }]);
  });
  test('repayments add to sender and subtract from receiver', () => {
    const s = summarizeLedger({ people, expenses: [expense('e1', 900, 'p1', ['p1', 'p2', 'p3'])], settlements: [settle('s1', 'p2', 'p1', 300)] });
    const by = Object.fromEntries(s.balances.map(b => [b.personId, b]));
    expect(by.p2).toMatchObject({ sentCents: 300, netCents: 0 });
    expect(by.p1).toMatchObject({ receivedCents: 300, netCents: 300 });
    expect(s.totalSettledCents).toBe(300);
    expect(s.transfers).toEqual([{ fromId: 'p3', toId: 'p1', amountCents: 300 }]);
  });
  test('overpaying a repayment flips direction instead of losing money', () => {
    const s = summarizeLedger({ people, expenses: [expense('e1', 200, 'p1', ['p1', 'p2'])], settlements: [settle('s1', 'p2', 'p1', 150)] });
    expect(s.transfers).toEqual([{ fromId: 'p1', toId: 'p2', amountCents: 50 }]);
  });
  test('nets always sum to zero and transfers clear every balance, remainders included', () => {
    const expenses = [expense('e1', 1001, 'p1', ['p1', 'p2', 'p3']), expense('e2', 777, 'p2', ['p2', 'p4']), expense('e3', 12345, 'p4', ['p1', 'p2', 'p3', 'p4']), expense('e4', 1, 'p3', ['p1', 'p4'])];
    const s = summarizeLedger({ people, expenses, settlements: [settle('s1', 'p3', 'p4', 1000)] });
    expect(s.balances.reduce((n, b) => n + b.netCents, 0)).toBe(0);
    expect(s.balances.reduce((n, b) => n + b.shareCents, 0)).toBe(s.totalCents);
    const left = Object.fromEntries(s.balances.map(b => [b.personId, b.netCents]));
    for (const t of s.transfers) { expect(t.amountCents).toBeGreaterThan(0); left[t.fromId] += t.amountCents; left[t.toId] -= t.amountCents; }
    expect(Object.values(left).every(v => v === 0)).toBe(true);
    expect(s.transfers.length).toBeLessThanOrEqual(3);
  });
  test('deterministic for equal balances and keeps historical ids not in people', () => {
    const a = summarizeLedger({ people: [{ id: 'p1', name: '小安' }], expenses: [expense('e1', 300, 'p1', ['p1', 'gone-b', 'gone-a'])], settlements: [] });
    expect(a.balances.map(b => b.personId)).toEqual(['p1', 'gone-a', 'gone-b']);
    expect(a.balances[1].name).toBe('已移除的旅伴');
    expect(a.transfers).toEqual([{ fromId: 'gone-a', toId: 'p1', amountCents: 100 }, { fromId: 'gone-b', toId: 'p1', amountCents: 100 }]);
  });
  test('empty ledger summarizes to zeros', () => {
    expect(summarizeLedger({ schema: 1, revision: 0, people: [], expenses: [], settlements: [] })).toEqual({ totalCents: 0, totalSettledCents: 0, balances: [], transfers: [] });
  });
  test('rejects non-integer money rows', () => {
    expect(() => summarizeLedger({ people, expenses: [expense('e1', 1.5, 'p1', ['p1'])], settlements: [] })).toThrow();
    expect(() => summarizeLedger({ people, expenses: [], settlements: [settle('s1', 'p1', 'p2', 0)] })).toThrow();
  });
});
